// Adapter-level tests for FetchproxyTransport. We don't bring up a real
// WebSocket here — the protocol-level tests live in @fetchproxy/server.
// What we verify is the path → URL prepending and the discriminated-
// union mapping (ok:true → triple, ok:false → throw).
import { describe, it, expect, vi } from 'vitest';
import { FetchproxyTransport } from '../src/transport-fetchproxy.js';

type Inner = {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
};

function stubInner(): Inner {
  return {
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
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
});
