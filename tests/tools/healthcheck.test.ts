import { describe, it, expect, vi, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { registerHealthcheckTools } from '../../src/tools/healthcheck.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyProtocolError,
  FetchproxyTimeoutError,
  classifyBridgeError,
} from '@fetchproxy/server';
import type { BridgeProbeResult, BridgeStatus } from '../../src/transport.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const DEFAULT_STATUS: BridgeStatus = {
  role: 'host',
  port: 37149,
  serverVersion: '0.0.0',
  fetchTimeoutMs: 30_000,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
  consecutiveFailures: 0,
  lastExtensionMessageAt: null,
};

// 0.10.0: the tool now drives the probe through `client.runProbe`, which
// the real transport delegates to the server's `runProbe`. The stub
// reproduces that contract faithfully — run the probe fetch, time it,
// classify any thrown error with the real `classifyBridgeError`, and
// project the (stubbed) bridge health — so the tool's hint + error.detail
// enrichment stays fully under test. The probe path is `/robots.txt`.
function stubClient(args: {
  status?: Partial<BridgeStatus>;
  fetchHtml?: ReturnType<typeof vi.fn>;
}): ZillowClient {
  const status = { ...DEFAULT_STATUS, ...(args.status ?? {}) };
  const fetchHtml =
    args.fetchHtml ?? vi.fn().mockResolvedValue('User-agent: *');
  const bridgeStatus = vi.fn().mockReturnValue(status);
  const runProbe = vi
    .fn()
    .mockImplementation(
      async (
        fetchFn: (path: string) => Promise<unknown>,
        probePath: string
      ): Promise<BridgeProbeResult> => {
        const start = Date.now();
        let ok = false;
        let error: BridgeProbeResult['error'];
        try {
          await fetchFn(probePath);
          ok = true;
        } catch (e) {
          error = {
            kind: classifyBridgeError(e),
            message: e instanceof Error ? e.message : String(e),
          };
        }
        return {
          ok,
          elapsed_ms: Date.now() - start,
          bridge: {
            role: status.role,
            port: status.port,
            server_version: status.serverVersion,
            fetch_timeout_ms: status.fetchTimeoutMs,
            last_success_at: status.lastSuccessAt,
            last_failure_at: status.lastFailureAt,
            last_failure_reason: status.lastFailureReason,
            consecutive_failures: status.consecutiveFailures,
          },
          ...(error ? { error } : {}),
        };
      }
    );
  return {
    bridgeStatus,
    fetchHtml,
    runProbe,
  } as unknown as ZillowClient;
}

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('zillow_healthcheck tool', () => {
  it('returns ok=true when /robots.txt round-trips through the bridge', async () => {
    const client = stubClient({
      fetchHtml: vi.fn().mockResolvedValue('User-agent: *\nDisallow:\n'),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('zillow_healthcheck', {});
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      ok: boolean;
      bridge: { role: string; port: number };
      probe: { url: string; status: number; body_length: number };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(true);
    expect(parsed.bridge.role).toBe('host');
    expect(parsed.probe.url).toBe('https://www.zillow.com/robots.txt');
    expect(parsed.probe.status).toBe(200);
    expect(parsed.probe.body_length).toBeGreaterThan(0);
    expect(parsed.hint).toMatch(/successfully/i);
  });

  it('classifies a FetchproxyTimeoutError as kind=timeout with role-specific hint', async () => {
    const client = stubClient({
      status: {
        role: 'peer',
        port: 37200,
        serverVersion: '1.0.0',
        fetchTimeoutMs: 25,
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.zillow.com/robots.txt',
          timeoutMs: 25,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('zillow_healthcheck', {});
    expect(r.isError).toBeFalsy(); // healthcheck reports failure in payload, not as tool error
    const parsed = parseToolResult<{
      ok: boolean;
      bridge: { role: string };
      error: { kind: string; role_at_failure: string };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('timeout');
    // 0.8.0+: role_at_failure comes from bridgeStatus() captured in catch.
    expect(parsed.error.role_at_failure).toBe('peer');
    expect(parsed.hint).toMatch(/extension popup/i);
  });

  it('bridge_down hint wins over the generic role=null hint when both apply', async () => {
    const client = stubClient({
      status: {
        role: null,
        port: 37149,
        serverVersion: '1.0.0',
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          originalError: 'Could not establish connection.',
          retryAttempted: true,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('zillow_healthcheck', {});
    const parsed = parseToolResult<{ error: { kind: string }; hint: string }>(r);
    expect(parsed.error.kind).toBe('bridge_down');
    expect(parsed.hint).toMatch(/service worker/i);
    expect(parsed.hint).not.toMatch(/never bound a role/);
  });

  it('hint when role is null points at startup failure, not extension issue', async () => {
    const client = stubClient({
      status: {
        role: null,
        port: 37149,
        serverVersion: '1.0.0',
        fetchTimeoutMs: 25,
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.zillow.com/robots.txt',
          timeoutMs: 25,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('zillow_healthcheck', {});
    const parsed = parseToolResult<{
      ok: boolean;
      error: { role_at_failure: string | null };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.role_at_failure).toBeNull();
    expect(parsed.hint).toMatch(/never bound a role/);
  });

  it('classifies a generic FetchproxyProtocolError as kind=protocol (0.8.0 classifyBridgeError vocabulary)', async () => {
    const client = stubClient({
      fetchHtml: vi
        .fn()
        .mockRejectedValue(
          new FetchproxyProtocolError(
            'fetchproxy transport error after 12ms (role=host): extension offline'
          )
        ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('zillow_healthcheck', {});
    const parsed = parseToolResult<{ ok: boolean; error: { kind: string }; hint: string }>(r);
    expect(parsed.ok).toBe(false);
    // 0.8.0 vocabulary: 'protocol' (from classifyBridgeError) replaces the
    // legacy 'transport' label.
    expect(parsed.error.kind).toBe('protocol');
    expect(parsed.hint).toMatch(/no zillow\.com tab is open/i);
  });

  it('classifies a FetchproxyBridgeDownError as kind=bridge_down with SW-eviction hint', async () => {
    const client = stubClient({
      status: { role: 'peer', port: 37149, serverVersion: '0.5.0' },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          originalError:
            'tab fetch failed: Error: Could not establish connection. Receiving end does not exist.',
          retryAttempted: true,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('zillow_healthcheck', {});
    const parsed = parseToolResult<{
      ok: boolean;
      error: { kind: string; message: string };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('bridge_down');
    expect(parsed.hint).toMatch(/service worker/i);
  });

  it('surfaces freshness counters (last_success_at, last_failure_at, consecutive_failures, last_extension_message_at)', async () => {
    const SUCCESS_AT = Date.parse('2026-05-25T03:39:46Z');
    const FAILURE_AT = Date.parse('2026-05-25T03:40:00Z');
    const EXT_MSG_AT = Date.parse('2026-05-25T03:40:01Z');
    const client = stubClient({
      status: {
        lastSuccessAt: SUCCESS_AT,
        lastFailureAt: FAILURE_AT,
        lastFailureReason: 'Could not establish connection.',
        consecutiveFailures: 3,
        lastExtensionMessageAt: EXT_MSG_AT,
      },
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('zillow_healthcheck', {});
    const parsed = parseToolResult<{
      bridge: {
        last_success_at: number | null;
        last_failure_at: number | null;
        last_failure_reason: string | null;
        consecutive_failures: number;
        last_extension_message_at: number | null;
      };
    }>(r);
    expect(parsed.bridge.last_success_at).toBe(SUCCESS_AT);
    expect(parsed.bridge.last_failure_at).toBe(FAILURE_AT);
    expect(parsed.bridge.last_failure_reason).toMatch(/Could not establish/);
    expect(parsed.bridge.consecutive_failures).toBe(3);
    expect(parsed.bridge.last_extension_message_at).toBe(EXT_MSG_AT);
  });

  it('classifies an unrelated error as kind=other', async () => {
    const client = stubClient({
      fetchHtml: vi.fn().mockRejectedValue(new Error('something else')),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('zillow_healthcheck', {});
    const parsed = parseToolResult<{ ok: boolean; error: { kind: string } }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('other');
  });

  // 0.8.0+: FetchproxyBridgeDownError carries an actionable `.hint` string
  // ("click the extension icon …"). Surface it in the response so the LLM
  // can show the user concrete recovery guidance instead of paraphrasing
  // the bare error message.
  it("surfaces the bridge-down error's .hint in the response's top-level hint", async () => {
    const BRIDGE_HINT =
      'Click the fetchproxy extension icon to wake its service worker, then retry.';
    const err = new FetchproxyBridgeDownError({
      originalError: 'Could not establish connection.',
      retryAttempted: true,
    });
    // Override `.hint` so the test pins behavior to the surfaced value
    // rather than the package's current default copy.
    Object.defineProperty(err, 'hint', { value: BRIDGE_HINT, writable: false });
    const client = stubClient({
      status: { role: 'peer', port: 37149, serverVersion: '0.5.0' },
      fetchHtml: vi.fn().mockRejectedValue(err),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('zillow_healthcheck', {});
    const parsed = parseToolResult<{
      error: { kind: string; detail?: { hint?: string; retry_attempted?: boolean } };
      hint: string;
    }>(r);
    expect(parsed.error.kind).toBe('bridge_down');
    // Top-level hint includes the error's hint verbatim.
    expect(parsed.hint).toContain(BRIDGE_HINT);
    // The error's hint + retry_attempted are also exposed under error.detail
    // for structured consumers.
    expect(parsed.error.detail?.hint).toBe(BRIDGE_HINT);
    expect(parsed.error.detail?.retry_attempted).toBe(true);
  });

  // 0.8.0+: FetchproxyTimeoutError carries the actual `.elapsedMs` (the
  // moment the timer won the race). Surface it under error.detail so the
  // LLM can tell "barely missed" from "hung for the full window".
  it("surfaces the timeout error's .elapsedMs in error.detail", async () => {
    const client = stubClient({
      status: {
        role: 'host',
        port: 37149,
        serverVersion: '0.5.0',
        fetchTimeoutMs: 30_000,
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.zillow.com/robots.txt',
          timeoutMs: 30_000,
          elapsedMs: 30_004,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('zillow_healthcheck', {});
    const parsed = parseToolResult<{
      error: { kind: string; detail?: { elapsed_ms?: number; timeout_ms?: number } };
    }>(r);
    expect(parsed.error.kind).toBe('timeout');
    expect(parsed.error.detail?.elapsed_ms).toBe(30_004);
    expect(parsed.error.detail?.timeout_ms).toBe(30_000);
  });
});
