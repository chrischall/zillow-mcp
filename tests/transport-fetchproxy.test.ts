// Adapter-level tests for FetchproxyTransport. We don't bring up a real
// WebSocket here — the protocol-level tests (lazy-revive retry, request
// timeout, content_script_unreachable mapping) live in @fetchproxy/server
// 0.8.0+. What we verify is the verb delegation (fetch / requestJson /
// runProbe), the status() projection, the typed-error re-exports, and the
// constructor options the adapter hands the server.
//
// 0.10.0: the adapter is now a thin delegate over mcp-utils'
// `createFetchproxyTransport`, which exposes a `createServer` test seam —
// a factory that builds the underlying FetchproxyServer. We inject a
// capturing mock through that seam to record the constructor opts and stub
// the verbs, instead of `vi.mock`-ing the constructor (which couldn't
// reach the `new FetchproxyServer` buried inside the factory's prebuilt
// dist). See the `createServer` plumbing on FetchproxyTransport.
import { describe, it, expect, vi } from 'vitest';

import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  FetchproxyTransport,
} from '../src/transport-fetchproxy.js';
import {
  FetchproxyBridgeDownError as PkgBridgeDown,
  FetchproxyTimeoutError as PkgTimeout,
  type FetchproxyServer,
} from '@chrischall/mcp-utils/fetchproxy';

type MockServer = {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  requestJson: ReturnType<typeof vi.fn>;
  runProbe: ReturnType<typeof vi.fn>;
  bridgeHealth: ReturnType<typeof vi.fn>;
  role: 'host' | 'peer' | null;
};

function makeMockServer(role: 'host' | 'peer' | null = 'host'): MockServer {
  return {
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(),
    requestJson: vi.fn(),
    runProbe: vi.fn(),
    bridgeHealth: vi.fn().mockReturnValue({
      role,
      port: 37149,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      consecutiveFailures: 0,
      lastExtensionMessageAt: null,
    }),
    role,
  };
}

/**
 * Build a FetchproxyTransport whose underlying FetchproxyServer is the
 * supplied mock, captured through the `createServer` seam. Returns the
 * transport plus the constructor opts the factory forwarded to the seam.
 */
function makeTransport(
  mock: MockServer,
  opts: { version?: string; port?: number } = {}
): { transport: FetchproxyTransport; ctorOpts: Record<string, unknown> } {
  let ctorOpts: Record<string, unknown> = {};
  const transport = new FetchproxyTransport({
    version: opts.version ?? '0.0.0',
    port: opts.port,
    createServer: (o) => {
      ctorOpts = { ...(o as Record<string, unknown>) };
      return mock as unknown as FetchproxyServer;
    },
  });
  return { transport, ctorOpts };
}

describe('FetchproxyTransport', () => {
  it('re-exports the package typed errors so callers keep working', () => {
    // The adapter re-exports the 0.8.0 package errors so existing callers
    // (e.g. zillow_healthcheck imports from this module historically) stay
    // wired up. Identity check confirms there's no shadowing class.
    expect(FetchproxyBridgeDownError).toBe(PkgBridgeDown);
    expect(FetchproxyTimeoutError).toBe(PkgTimeout);
  });

  it('delegates fetch() to inner.request() with subdomain=www', async () => {
    const mock = makeMockServer();
    mock.request.mockResolvedValue({
      status: 200,
      body: 'x',
      url: 'https://www.zillow.com/homedetails/1_zpid/',
    });
    const { transport } = makeTransport(mock);

    await transport.fetch({ path: '/homedetails/1_zpid/', method: 'GET' });
    expect(mock.request).toHaveBeenCalledTimes(1);
    const [method, path, callOpts] = mock.request.mock.calls[0];
    expect(method).toBe('GET');
    expect(path).toBe('/homedetails/1_zpid/');
    expect(callOpts.subdomain).toBe('www');
  });

  it('passes through absolute URLs to inner.request()', async () => {
    const mock = makeMockServer();
    mock.request.mockResolvedValue({
      status: 200,
      body: '',
      url: 'https://photos.zillow.com/x',
    });
    const { transport } = makeTransport(mock);

    await transport.fetch({
      path: 'https://photos.zillow.com/x',
      method: 'GET',
    });
    // The server's request() handles absolute URLs as-is; we still pass
    // the path positionally so 0.8.0's path-resolution rules apply.
    expect(mock.request.mock.calls[0][1]).toBe('https://photos.zillow.com/x');
  });

  it('returns the {status, body, url} triple from inner.request()', async () => {
    const mock = makeMockServer();
    mock.request.mockResolvedValue({
      status: 200,
      body: 'hello',
      url: 'https://www.zillow.com/x',
    });
    const { transport } = makeTransport(mock);

    const result = await transport.fetch({ path: '/x', method: 'GET' });
    expect(result).toEqual({
      status: 200,
      body: 'hello',
      url: 'https://www.zillow.com/x',
    });
  });

  it('propagates typed errors thrown by inner.request()', async () => {
    const mock = makeMockServer();
    const err = new PkgBridgeDown({
      originalError: 'Could not establish connection.',
      retryAttempted: true,
    });
    mock.request.mockRejectedValue(err);
    const { transport } = makeTransport(mock);

    await expect(transport.fetch({ path: '/x', method: 'GET' })).rejects.toBe(
      err
    );
  });

  it('start/close delegate to the inner FetchproxyServer', async () => {
    const mock = makeMockServer();
    const { transport } = makeTransport(mock);

    await transport.start();
    expect(mock.listen).toHaveBeenCalledTimes(1);

    await transport.close();
    expect(mock.close).toHaveBeenCalledTimes(1);
  });

  it('forwards headers and body through inner.request()', async () => {
    const mock = makeMockServer();
    mock.request.mockResolvedValue({
      status: 200,
      body: '{}',
      url: 'https://www.zillow.com/api',
    });
    const { transport } = makeTransport(mock);
    await transport.fetch({
      path: '/api',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"q":"x"}',
    });
    const [, , callOpts] = mock.request.mock.calls[0];
    expect(callOpts.headers).toEqual({ 'content-type': 'application/json' });
    expect(callOpts.body).toBe('{"q":"x"}');
  });

  it('requestJson() delegates to inner.requestJson() with subdomain=www (0.10.0)', async () => {
    const mock = makeMockServer();
    mock.requestJson.mockResolvedValue({
      data: { ok: true },
      result: { ok: true, status: 200, url: 'https://www.zillow.com/x', body: '{}' },
    });
    const { transport } = makeTransport(mock);

    const out = await transport.requestJson<{ ok: boolean }>('/x', {
      method: 'POST',
      headers: { 'X-Test': '1' },
      body: { q: 'x' },
    });
    // The factory narrows the server's discriminated result down to the
    // {status, body, url} triple — the only fields the client reads.
    expect(out).toEqual({
      data: { ok: true },
      result: { status: 200, url: 'https://www.zillow.com/x', body: '{}' },
    });
    const [method, path, callOpts] = mock.requestJson.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/x');
    expect(callOpts.subdomain).toBe('www');
    expect(callOpts.headers).toEqual({ 'X-Test': '1' });
    expect(callOpts.body).toEqual({ q: 'x' });
  });

  it('requestJson() defaults the method to POST when omitted (0.10.0)', async () => {
    const mock = makeMockServer();
    mock.requestJson.mockResolvedValue({
      data: null,
      result: { ok: true, status: 204, url: 'https://www.zillow.com/x', body: '' },
    });
    const { transport } = makeTransport(mock);
    await transport.requestJson('/x', { body: {} });
    expect(mock.requestJson.mock.calls[0][0]).toBe('POST');
  });

  it('runProbe() delegates to inner.runProbe() with the same fetchFn + path (0.10.0)', async () => {
    const mock = makeMockServer();
    const probeResult = {
      ok: true,
      elapsed_ms: 12,
      bridge: {
        role: 'host' as const,
        port: 37149,
        server_version: '0.0.0',
        fetch_timeout_ms: 30_000,
        last_success_at: null,
        last_failure_at: null,
        last_failure_reason: null,
        consecutive_failures: 0,
      },
    };
    mock.runProbe.mockResolvedValue(probeResult);
    const { transport } = makeTransport(mock);

    const fetchFn = vi.fn().mockResolvedValue('User-agent: *');
    const out = await transport.runProbe(fetchFn, '/robots.txt');
    expect(out).toBe(probeResult);
    expect(mock.runProbe).toHaveBeenCalledTimes(1);
    expect(mock.runProbe.mock.calls[0][0]).toBe(fetchFn);
    expect(mock.runProbe.mock.calls[0][1]).toBe('/robots.txt');
  });

  it('status() projects inner.bridgeHealth() and pins serverVersion (0.10.0)', () => {
    const mock = makeMockServer(null);
    mock.bridgeHealth.mockReturnValue({
      role: null,
      port: 37200,
      fetchTimeoutMs: 30_000,
      bridgeReviveDelayMs: 2_000,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      consecutiveFailures: 0,
      lastExtensionMessageAt: null,
    });
    const { transport } = makeTransport(mock, { version: '0.0.0', port: 37200 });
    const s = transport.status();
    expect(s.role).toBeNull();
    // 0.10.0: the factory additively pins serverVersion to the version opt.
    expect(s.serverVersion).toBe('0.0.0');
    expect(s.fetchTimeoutMs).toBe(30_000);
    expect(s.bridgeReviveDelayMs).toBe(2_000);
    expect(s.lastSuccessAt).toBeNull();
    expect(s.lastFailureAt).toBeNull();
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastExtensionMessageAt).toBeNull();
  });

  it('no longer passes keepAliveIntervalMs to the FetchproxyServer constructor (0.10.0 defaults it, fetchproxy#72)', () => {
    // Pre-0.10.0 zillow-mcp opted into keepAliveIntervalMs: 25_000
    // explicitly. 0.10.0 promoted that exact value to the server default
    // (every consumer was opting in, fetchproxy#72), so the adapter now
    // passes NOTHING for it and inherits the default. We inspect the opts
    // the factory forwarded to the `createServer` seam — the consumer-passed
    // object is where the opt-in's absence is observable.
    const mock = makeMockServer();
    const { ctorOpts } = makeTransport(mock);
    expect('keepAliveIntervalMs' in ctorOpts).toBe(false);
  });

  it('declares zillow.com with the www default subdomain via the seam opts', () => {
    // The factory forwards the FetchproxyServerOpts verbatim to createServer;
    // assert the per-site declaration the adapter pins.
    const mock = makeMockServer();
    const { ctorOpts } = makeTransport(mock);
    expect(ctorOpts.serverName).toBe('zillow-mcp');
    expect(ctorOpts.domains).toEqual(['zillow.com']);
  });

  it('status() reflects freshness counters tracked by the server', () => {
    const mock = makeMockServer();
    mock.bridgeHealth.mockReturnValue({
      role: 'host',
      port: 37149,
      lastSuccessAt: 1_700_000_000_000,
      lastFailureAt: 1_700_000_000_500,
      lastFailureReason: 'timeout: https://www.zillow.com/x',
      consecutiveFailures: 2,
      lastExtensionMessageAt: 1_700_000_001_000,
    });
    const { transport } = makeTransport(mock);
    const s = transport.status();
    expect(s.lastSuccessAt).toBe(1_700_000_000_000);
    expect(s.lastFailureAt).toBe(1_700_000_000_500);
    expect(s.lastFailureReason).toMatch(/timeout/);
    expect(s.consecutiveFailures).toBe(2);
    expect(s.lastExtensionMessageAt).toBe(1_700_000_001_000);
  });
});
