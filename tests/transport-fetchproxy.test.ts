// Adapter-level tests for FetchproxyTransport. We don't bring up a real
// WebSocket here — the protocol-level tests (lazy-revive retry, request
// timeout, content_script_unreachable mapping) live in @fetchproxy/server
// 0.8.0+. What we verify is the path → URL prepending, the request()
// delegation, the bridgeHealth() → status() projection, the typed-error
// re-exports, and the constructor options the adapter hands the server.
import { describe, it, expect, vi } from 'vitest';

// Capture the exact options object the adapter passes to the
// FetchproxyServer constructor, so we can prove the explicit
// keepAliveIntervalMs opt-in was dropped (0.10.0 defaults it server-side,
// fetchproxy#72). The real class is preserved for behavior; only the
// constructor is wrapped to record its first argument.
const constructorOpts: Array<Record<string, unknown>> = [];
vi.mock('@fetchproxy/server', async (importActual) => {
  const actual = await importActual<typeof import('@fetchproxy/server')>();
  class CapturingServer extends actual.FetchproxyServer {
    constructor(opts: ConstructorParameters<typeof actual.FetchproxyServer>[0]) {
      constructorOpts.push({ ...(opts as Record<string, unknown>) });
      super(opts);
    }
  }
  return { ...actual, FetchproxyServer: CapturingServer };
});

import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  FetchproxyTransport,
} from '../src/transport-fetchproxy.js';
import {
  FetchproxyBridgeDownError as PkgBridgeDown,
  FetchproxyTimeoutError as PkgTimeout,
} from '@fetchproxy/server';

type Inner = {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  requestJson: ReturnType<typeof vi.fn>;
  runProbe: ReturnType<typeof vi.fn>;
  bridgeHealth: ReturnType<typeof vi.fn>;
  role: 'host' | 'peer' | null;
};

function stubInner(role: 'host' | 'peer' | null = 'host'): Inner {
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

function installInner(t: FetchproxyTransport, inner: Inner): void {
  // @ts-expect-error reach into the private field for unit testing
  t.inner = inner;
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
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
      status: 200,
      body: 'x',
      url: 'https://www.zillow.com/homedetails/1_zpid/',
    });
    installInner(t, inner);

    await t.fetch({ path: '/homedetails/1_zpid/', method: 'GET' });
    expect(inner.request).toHaveBeenCalledTimes(1);
    const [method, path, opts] = inner.request.mock.calls[0];
    expect(method).toBe('GET');
    expect(path).toBe('/homedetails/1_zpid/');
    expect(opts.subdomain).toBe('www');
  });

  it('passes through absolute URLs to inner.request()', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
      status: 200,
      body: '',
      url: 'https://photos.zillow.com/x',
    });
    installInner(t, inner);

    await t.fetch({
      path: 'https://photos.zillow.com/x',
      method: 'GET',
    });
    // The server's request() handles absolute URLs as-is; we still pass
    // the path positionally so 0.8.0's path-resolution rules apply.
    expect(inner.request.mock.calls[0][1]).toBe('https://photos.zillow.com/x');
  });

  it('returns the {status, body, url} triple from inner.request()', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
      status: 200,
      body: 'hello',
      url: 'https://www.zillow.com/x',
    });
    installInner(t, inner);

    const result = await t.fetch({ path: '/x', method: 'GET' });
    expect(result).toEqual({
      status: 200,
      body: 'hello',
      url: 'https://www.zillow.com/x',
    });
  });

  it('propagates typed errors thrown by inner.request()', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    const err = new PkgBridgeDown({
      originalError: 'Could not establish connection.',
      retryAttempted: true,
    });
    inner.request.mockRejectedValue(err);
    installInner(t, inner);

    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toBe(err);
  });

  it('start/close delegate to the inner FetchproxyServer', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    installInner(t, inner);

    await t.start();
    expect(inner.listen).toHaveBeenCalledTimes(1);

    await t.close();
    expect(inner.close).toHaveBeenCalledTimes(1);
  });

  it('forwards headers and body through inner.request()', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
      status: 200,
      body: '{}',
      url: 'https://www.zillow.com/api',
    });
    installInner(t, inner);
    await t.fetch({
      path: '/api',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"q":"x"}',
    });
    const [, , opts] = inner.request.mock.calls[0];
    expect(opts.headers).toEqual({ 'content-type': 'application/json' });
    expect(opts.body).toBe('{"q":"x"}');
  });

  it('requestJson() delegates to inner.requestJson() with subdomain=www (0.10.0)', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    const result = { ok: true, status: 200, url: 'https://www.zillow.com/x', body: '{}' };
    inner.requestJson.mockResolvedValue({ data: { ok: true }, result });
    installInner(t, inner);

    const out = await t.requestJson<{ ok: boolean }>('/x', {
      method: 'POST',
      headers: { 'X-Test': '1' },
      body: { q: 'x' },
    });
    expect(out).toEqual({ data: { ok: true }, result });
    const [method, path, opts] = inner.requestJson.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/x');
    expect(opts.subdomain).toBe('www');
    expect(opts.headers).toEqual({ 'X-Test': '1' });
    expect(opts.body).toEqual({ q: 'x' });
  });

  it('requestJson() defaults the method to POST when omitted (0.10.0)', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.requestJson.mockResolvedValue({
      data: null,
      result: { ok: true, status: 204, url: 'https://www.zillow.com/x', body: '' },
    });
    installInner(t, inner);
    await t.requestJson('/x', { body: {} });
    expect(inner.requestJson.mock.calls[0][0]).toBe('POST');
  });

  it('runProbe() delegates to inner.runProbe() with the same fetchFn + path (0.10.0)', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
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
    inner.runProbe.mockResolvedValue(probeResult);
    installInner(t, inner);

    const fetchFn = vi.fn().mockResolvedValue('User-agent: *');
    const out = await t.runProbe(fetchFn, '/robots.txt');
    expect(out).toBe(probeResult);
    expect(inner.runProbe).toHaveBeenCalledTimes(1);
    expect(inner.runProbe.mock.calls[0][0]).toBe(fetchFn);
    expect(inner.runProbe.mock.calls[0][1]).toBe('/robots.txt');
  });

  it('status() delegates directly to inner.bridgeHealth() (0.8.0+ collapsed the shim)', () => {
    const t = new FetchproxyTransport({ version: '0.0.0', port: 37200 });
    const inner = stubInner(null);
    inner.bridgeHealth.mockReturnValue({
      role: null,
      port: 37200,
      serverVersion: '0.0.0',
      fetchTimeoutMs: 30_000,
      bridgeReviveDelayMs: 2_000,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      consecutiveFailures: 0,
      lastExtensionMessageAt: null,
    });
    installInner(t, inner);
    const s = t.status();
    expect(s.role).toBeNull();
    expect(s.port).toBe(37200);
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
    // passes NOTHING for it and inherits the default. We inspect the
    // options the adapter actually hands the constructor (captured by the
    // module mock above) — `inner.opts` can't prove this because the
    // server backfills the key, so the consumer-passed object is the only
    // place the opt-in's absence is observable.
    constructorOpts.length = 0;
    new FetchproxyTransport({ version: '0.0.0' });
    expect(constructorOpts).toHaveLength(1);
    expect('keepAliveIntervalMs' in constructorOpts[0]).toBe(false);
  });

  it('status() reflects freshness counters tracked by the server', () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.bridgeHealth.mockReturnValue({
      role: 'host',
      port: 37149,
      lastSuccessAt: 1_700_000_000_000,
      lastFailureAt: 1_700_000_000_500,
      lastFailureReason: 'timeout: https://www.zillow.com/x',
      consecutiveFailures: 2,
      lastExtensionMessageAt: 1_700_000_001_000,
    });
    installInner(t, inner);
    const s = t.status();
    expect(s.lastSuccessAt).toBe(1_700_000_000_000);
    expect(s.lastFailureAt).toBe(1_700_000_000_500);
    expect(s.lastFailureReason).toMatch(/timeout/);
    expect(s.consecutiveFailures).toBe(2);
    expect(s.lastExtensionMessageAt).toBe(1_700_000_001_000);
  });
});
