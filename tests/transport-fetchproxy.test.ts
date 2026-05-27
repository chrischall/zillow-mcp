// Adapter-level tests for FetchproxyTransport. We don't bring up a real
// WebSocket here — the protocol-level tests live in @fetchproxy/server.
// What we verify is the path → URL prepending and the discriminated-
// union mapping (ok:true → triple, ok:false → throw).
import { describe, it, expect, vi } from 'vitest';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  FetchproxyTransport,
} from '../src/transport-fetchproxy.js';

type Inner = {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  role: 'host' | 'peer' | null;
};

function stubInner(role: 'host' | 'peer' | null = 'host'): Inner {
  return {
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    role,
  };
}

function installInner(t: FetchproxyTransport, inner: Inner): void {
  // @ts-expect-error reach into the private field for unit testing
  t.inner = inner;
}

describe('FetchproxyTransport', () => {
  it('prepends https://www.zillow.com to relative paths', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: 'x',
      url: 'https://www.zillow.com/x',
    });
    installInner(t, inner);

    await t.fetch({ path: '/homedetails/1_zpid/', method: 'GET' });
    expect(inner.fetch.mock.calls[0][0].url).toBe(
      'https://www.zillow.com/homedetails/1_zpid/'
    );
    expect(inner.fetch.mock.calls[0][0].tabUrl).toBe('https://www.zillow.com/');
  });

  it('passes through absolute URLs', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: '',
      url: 'https://photos.zillow.com/x',
    });
    installInner(t, inner);

    await t.fetch({
      path: 'https://photos.zillow.com/x',
      method: 'GET',
    });
    expect(inner.fetch.mock.calls[0][0].url).toBe('https://photos.zillow.com/x');
  });

  it('returns the {status, body, url} triple on ok:true', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: true,
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

  it('throws when fetchproxy returns ok:false', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: false,
      error: 'extension offline',
    });
    installInner(t, inner);

    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toThrow(
      /extension offline/
    );
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

  it('status() returns role, port, and freshness counters before any request', () => {
    const t = new FetchproxyTransport({ version: '0.0.0', port: 37200 });
    const inner = stubInner(null);
    installInner(t, inner);
    const s = t.status();
    expect(s.role).toBeNull();
    expect(s.port).toBe(37200);
    expect(s.serverVersion).toBe('0.0.0');
    expect(s.fetchTimeoutMs).toBe(30_000);
    expect(s.lastSuccessAt).toBeNull();
    expect(s.lastFailureAt).toBeNull();
    expect(s.consecutiveFailures).toBe(0);
  });

  it('status() records lastSuccessAt and resets consecutiveFailures on success', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: 'x',
      url: 'https://www.zillow.com/x',
    });
    installInner(t, inner);
    await t.fetch({ path: '/x', method: 'GET' });
    const s = t.status();
    expect(s.lastSuccessAt).toBeGreaterThan(0);
    expect(s.consecutiveFailures).toBe(0);
  });

  it('throws FetchproxyBridgeDownError when kind=content_script_unreachable', async () => {
    // bridgeReviveDelayMs: 0 disables the lazy-revive retry so this test
    // exercises the original single-shot failure path. See the
    // lazy-revive-recovery tests for the retry behavior.
    const t = new FetchproxyTransport({
      version: '0.0.0',
      bridgeReviveDelayMs: 0,
    });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: false,
      error: 'Could not establish connection. Receiving end does not exist.',
      kind: 'content_script_unreachable',
    });
    installInner(t, inner);
    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toBeInstanceOf(
      FetchproxyBridgeDownError
    );
    const s = t.status();
    expect(s.lastFailureAt).toBeGreaterThan(0);
    expect(s.consecutiveFailures).toBe(1);
  });

  it('FetchproxyTimeoutError fires when the inner fetch never resolves', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0', fetchTimeoutMs: 25 });
    const inner = stubInner();
    inner.fetch.mockReturnValue(new Promise(() => {})); // never resolves
    installInner(t, inner);
    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toBeInstanceOf(
      FetchproxyTimeoutError
    );
    const s = t.status();
    expect(s.lastFailureReason).toMatch(/timeout/);
    expect(s.consecutiveFailures).toBe(1);
  });

  it('lazy-revive: a single content_script_unreachable retries once and recovers (issue #58)', async () => {
    // Simulates Chrome MV3 evicting the service worker — first call
    // fails with content_script_unreachable; the second call (after
    // a short delay to let the SW wake up) succeeds.
    const t = new FetchproxyTransport({
      version: '0.0.0',
      bridgeReviveDelayMs: 1, // keep the test fast
    });
    const inner = stubInner();
    let calls = 0;
    inner.fetch.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          error: 'Could not establish connection. Receiving end does not exist.',
          kind: 'content_script_unreachable',
        };
      }
      return {
        ok: true,
        status: 200,
        body: 'x',
        url: 'https://www.zillow.com/x',
      };
    });
    installInner(t, inner);
    const result = await t.fetch({ path: '/x', method: 'GET' });
    expect(result.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('lazy-revive: only retries ONCE; second eviction surfaces FetchproxyBridgeDownError', async () => {
    const t = new FetchproxyTransport({
      version: '0.0.0',
      bridgeReviveDelayMs: 1,
    });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: false,
      error: 'Could not establish connection. Receiving end does not exist.',
      kind: 'content_script_unreachable',
    });
    installInner(t, inner);
    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toBeInstanceOf(
      FetchproxyBridgeDownError
    );
    expect(inner.fetch).toHaveBeenCalledTimes(2);
  });
});
