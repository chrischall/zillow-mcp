// ZillowClient unit tests — exercise the client's error mapping
// (non-2xx, sign-in interstitial, empty 204) against a stub transport.
// The WebSocket layer itself lives in @fetchproxy/server; its protocol
// is tested upstream in the fetchproxy repo.
import { describe, it, expect, vi } from 'vitest';
import { classifyBotWall } from '@fetchproxy/server';
import {
  BotWallError,
  SessionNotAuthenticatedError,
  ZillowClient,
} from '../src/client.js';
import type { FetchInit, FetchResult, ZillowTransport } from '../src/transport.js';

// The stub transport mirrors the real FetchproxyTransport: `fetch` runs
// the handler directly; `requestJson` reproduces the server's
// serialization (Accept/Content-Type defaults, JSON.stringify body,
// 204/empty → null, JSON.parse) on top of the same handler, so the
// client's per-site guards run over the returned `result` exactly as in
// production. (0.10.0 moved that serialization into the server.)
function stubTransport(
  handler: (init: FetchInit) => Promise<FetchResult>
): ZillowTransport {
  const requestJson = async <T,>(
    path: string,
    init: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      headers?: Record<string, string>;
      body?: unknown;
    } = {}
  ): Promise<{ data: T | null; result: FetchResult }> => {
    const method = init.method ?? 'POST';
    const sendBody = method !== 'GET' && init.body !== undefined;
    const synthesized: FetchInit = {
      path,
      method,
      headers: {
        Accept: 'application/json',
        ...(sendBody ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      body: sendBody ? JSON.stringify(init.body) : undefined,
    };
    const result = await handler(synthesized);
    if (result.status === 204 || result.body === '') {
      return { data: null, result };
    }
    let data: T;
    try {
      data = JSON.parse(result.body) as T;
    } catch (e) {
      throw new Error(
        `fetchproxy ${method} ${path} — response was not JSON: ${
          (e as Error).message
        }`
      );
    }
    return { data, result };
  };
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockImplementation(handler),
    requestJson: vi.fn().mockImplementation(requestJson),
  } as unknown as ZillowTransport;
}

describe('ZillowClient', () => {
  it('fetchHtml returns the body when transport replies 200', async () => {
    const client = new ZillowClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: '<html>property</html>',
        url: 'https://www.zillow.com/homedetails/x/12345_zpid/',
      })),
    });
    const html = await client.fetchHtml('/homedetails/x/12345_zpid/');
    expect(html).toBe('<html>property</html>');
  });

  it('fetchHtml throws SessionNotAuthenticatedError for /user/login redirects', async () => {
    const client = new ZillowClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: '<html><body>sign in</body></html>',
        url: 'https://www.zillow.com/user/login',
      })),
    });
    await expect(client.fetchHtml('/user/savedSearches/')).rejects.toBeInstanceOf(
      SessionNotAuthenticatedError
    );
  });

  it('fetchHtml throws SessionNotAuthenticatedError for captcha interstitial', async () => {
    const client = new ZillowClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: '<html>captcha-delivery</html>',
        url: 'https://www.zillow.com/captcha/whatever',
      })),
    });
    await expect(client.fetchHtml('/whatever')).rejects.toBeInstanceOf(
      SessionNotAuthenticatedError
    );
  });

  it('fetchHtml does NOT false-positive on a normal page containing /user/login in nav HTML', async () => {
    // Every signed-in Zillow page renders a "Sign in" link → the body
    // would historically match /user/login. Verify we don't flag those.
    const client = new ZillowClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: '<html><nav><a href="/user/login">Sign in</a></nav><main>real content</main></html>',
        url: 'https://www.zillow.com/homedetails/1_zpid/',
      })),
    });
    await expect(
      client.fetchHtml('/homedetails/1_zpid/')
    ).resolves.toBeDefined();
  });

  it('fetchHtml does NOT flag captcha-delivery mentioned in a large page body', async () => {
    // CSP / privacy-policy pages mention 'captcha-delivery' in passing;
    // the < 80KB guard should keep us out of trouble on those.
    const bigBody = 'x'.repeat(100_000) + ' captcha-delivery in tos ';
    const client = new ZillowClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: bigBody,
        url: 'https://www.zillow.com/privacy/',
      })),
    });
    await expect(client.fetchHtml('/privacy/')).resolves.toBeDefined();
  });

  it('fetchHtml throws for non-2xx status', async () => {
    const client = new ZillowClient({
      transport: stubTransport(async () => ({
        status: 500,
        body: 'oops',
        url: 'https://www.zillow.com/x',
      })),
    });
    await expect(client.fetchHtml('/x')).rejects.toThrow(/500/);
  });

  it('fetchJson POSTs JSON and parses the reply', async () => {
    const client = new ZillowClient({
      transport: stubTransport(async (init) => {
        expect(init.method).toBe('POST');
        expect(init.headers?.['Content-Type']).toBe('application/json');
        const body = JSON.parse(String(init.body));
        return {
          status: 200,
          body: JSON.stringify({ echoed: body }),
          url: 'https://www.zillow.com/thing',
        };
      }),
    });
    const result = await client.fetchJson<{ echoed: { n: number } }>(
      '/thing',
      { method: 'POST', body: { n: 42 } }
    );
    expect(result.echoed.n).toBe(42);
  });

  it('fetchJson defaults to POST when method is omitted', async () => {
    const seen: { method?: string } = {};
    const client = new ZillowClient({
      transport: stubTransport(async (init) => {
        seen.method = init.method;
        return { status: 200, body: '{}', url: 'https://www.zillow.com/x' };
      }),
    });
    await client.fetchJson('/x', { body: {} });
    expect(seen.method).toBe('POST');
  });

  it('fetchJson supports GET (no body, no Content-Type)', async () => {
    const seen: { headers?: Record<string, string>; body?: string } = {};
    const client = new ZillowClient({
      transport: stubTransport(async (init) => {
        seen.headers = init.headers;
        seen.body = init.body;
        return {
          status: 200,
          body: JSON.stringify({ ok: true }),
          url: 'https://www.zillow.com/api',
        };
      }),
    });
    const result = await client.fetchJson<{ ok: boolean }>('/api', { method: 'GET' });
    expect(result.ok).toBe(true);
    expect(seen.body).toBeUndefined();
    expect(seen.headers?.['Content-Type']).toBeUndefined();
  });

  it('fetchJson throws if the reply is not valid JSON', async () => {
    const client = new ZillowClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: 'not-json',
        url: 'https://www.zillow.com/thing',
      })),
    });
    await expect(
      client.fetchJson('/thing', { method: 'POST', body: {} })
    ).rejects.toThrow(/json/i);
  });

  it('fetchJson returns null for 204 No Content', async () => {
    const client = new ZillowClient({
      transport: stubTransport(async () => ({
        status: 204,
        body: '',
        url: 'https://www.zillow.com/thing',
      })),
    });
    const result = await client.fetchJson('/thing', { method: 'POST', body: {} });
    expect(result).toBeNull();
  });

  // Issue #90 / #91: PerimeterX px-captcha 403 — the bot-wall. Must NOT
  // surface as a generic "Zillow API error: 403" (indistinguishable from
  // a real not-found) — it's a distinct, retryable BotWallError. 0.10.0:
  // detection is the shared classifyBotWall (the kit absorbed this MCP's
  // #91 px-detection), gated to the `perimeterx` vendor.
  describe('px bot-wall detection (issue #90 / #91)', () => {
    const PX_BODY =
      '<html><head><meta name="px-captcha" content="..."></head>' +
      '<body><h1>Access to this page has been denied</h1>' +
      '<script>window._pxAppId = "PXabc123";</script></body></html>';

    // Guard that the kit's classifyBotWall still covers each of zillow's
    // three px markers (the parity bar for dropping the local detector).
    it('classifyBotWall flags the window._pxAppId marker as perimeterx', () => {
      const v = classifyBotWall('<script>window._pxAppId="PX1"</script>', 200);
      expect(v.blocked).toBe(true);
      if (v.blocked) expect(v.vendor).toBe('perimeterx');
    });

    it('classifyBotWall flags the "Access to this page has been denied" marker', () => {
      const v = classifyBotWall(
        '<h1>Access to this page has been denied</h1>',
        403
      );
      expect(v.blocked).toBe(true);
      if (v.blocked) expect(v.vendor).toBe('perimeterx');
    });

    it('classifyBotWall flags the meta name="px-captcha" marker', () => {
      const v = classifyBotWall('<meta name="px-captcha" content="x">', 403);
      expect(v.blocked).toBe(true);
      if (v.blocked) expect(v.vendor).toBe('perimeterx');
    });

    it('classifyBotWall does not false-positive on ordinary HTML', () => {
      expect(
        classifyBotWall('<html><body>real property</body></html>', 200).blocked
      ).toBe(false);
    });

    it('fetchHtml throws BotWallError (not a generic 403) on a px-captcha 403', async () => {
      const client = new ZillowClient({
        transport: stubTransport(async () => ({
          status: 403,
          body: PX_BODY,
          url: 'https://www.zillow.com/homedetails/x/12345_zpid/',
        })),
      });
      await expect(
        client.fetchHtml('/homedetails/x/12345_zpid/')
      ).rejects.toBeInstanceOf(BotWallError);
    });

    it('a px-captcha body served with a 200 status is still flagged as a bot-wall', async () => {
      // PerimeterX sometimes serves the interstitial with a 200. The
      // detection must key on the body markers, not the status code.
      const client = new ZillowClient({
        transport: stubTransport(async () => ({
          status: 200,
          body: PX_BODY,
          url: 'https://www.zillow.com/homedetails/x/12345_zpid/',
        })),
      });
      await expect(
        client.fetchHtml('/homedetails/x/12345_zpid/')
      ).rejects.toBeInstanceOf(BotWallError);
    });

    it('BotWallError carries the bot_challenge kind + a retry-after hint', async () => {
      const client = new ZillowClient({
        transport: stubTransport(async () => ({
          status: 403,
          body: PX_BODY,
          url: 'https://www.zillow.com/homedetails/x/12345_zpid/',
        })),
      });
      const err = await client
        .fetchHtml('/homedetails/x/12345_zpid/')
        .catch((e) => e);
      expect(err).toBeInstanceOf(BotWallError);
      expect((err as BotWallError).kind).toBe('bot_challenge');
      expect((err as BotWallError).retryAfterSeconds).toBeGreaterThan(0);
    });

    it('a genuine 403 WITHOUT bot-wall markers stays a generic error (not a bot-wall)', async () => {
      const client = new ZillowClient({
        transport: stubTransport(async () => ({
          status: 403,
          body: '<html><body>Forbidden</body></html>',
          url: 'https://www.zillow.com/x',
        })),
      });
      const err = await client.fetchHtml('/x').catch((e) => e);
      expect(err).not.toBeInstanceOf(BotWallError);
      expect((err as Error).message).toMatch(/403/);
    });
  });
});
