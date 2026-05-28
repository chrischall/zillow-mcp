// ZillowClient unit tests — exercise the client's error mapping
// (non-2xx, sign-in interstitial, empty 204) against a stub transport.
// The WebSocket layer itself lives in @fetchproxy/server; its protocol
// is tested upstream in the fetchproxy repo.
import { describe, it, expect, vi } from 'vitest';
import {
  CaptchaBlockedError,
  detectPxCaptcha,
  SessionNotAuthenticatedError,
  ZillowClient,
} from '../src/client.js';
import type { FetchInit, FetchResult, ZillowTransport } from '../src/transport.js';

function stubTransport(
  handler: (init: FetchInit) => Promise<FetchResult>
): ZillowTransport {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockImplementation(handler),
  };
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

  // Issue #90: PerimeterX px-captcha 403 — the bot-wall. Must NOT surface
  // as a generic "Zillow API error: 403" (indistinguishable from a real
  // not-found) — it's a distinct, retryable CaptchaBlockedError.
  describe('px-captcha detection (issue #90)', () => {
    const PX_BODY =
      '<html><head><meta name="px-captcha" content="..."></head>' +
      '<body><h1>Access to this page has been denied</h1>' +
      '<script>window._pxAppId = "PXabc123";</script></body></html>';

    it('detectPxCaptcha matches the window._pxAppId marker', () => {
      expect(detectPxCaptcha('<script>window._pxAppId="PX1"</script>')).toBe(
        true
      );
    });

    it('detectPxCaptcha matches the "Access to this page has been denied" marker', () => {
      expect(
        detectPxCaptcha('<h1>Access to this page has been denied</h1>')
      ).toBe(true);
    });

    it('detectPxCaptcha matches the meta name="px-captcha" marker', () => {
      expect(detectPxCaptcha('<meta name="px-captcha" content="x">')).toBe(true);
    });

    it('detectPxCaptcha does not false-positive on ordinary HTML', () => {
      expect(detectPxCaptcha('<html><body>real property</body></html>')).toBe(
        false
      );
    });

    it('fetchHtml throws CaptchaBlockedError (not a generic 403) on a px-captcha 403', async () => {
      const client = new ZillowClient({
        transport: stubTransport(async () => ({
          status: 403,
          body: PX_BODY,
          url: 'https://www.zillow.com/homedetails/x/12345_zpid/',
        })),
      });
      await expect(
        client.fetchHtml('/homedetails/x/12345_zpid/')
      ).rejects.toBeInstanceOf(CaptchaBlockedError);
    });

    it('a px-captcha body served with a 200 status is still flagged as a captcha', async () => {
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
      ).rejects.toBeInstanceOf(CaptchaBlockedError);
    });

    it('CaptchaBlockedError carries a retry-after hint', async () => {
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
      expect(err).toBeInstanceOf(CaptchaBlockedError);
      expect((err as CaptchaBlockedError).retryAfterSeconds).toBeGreaterThan(0);
    });

    it('a genuine 403 WITHOUT captcha markers stays a generic error (not a captcha)', async () => {
      const client = new ZillowClient({
        transport: stubTransport(async () => ({
          status: 403,
          body: '<html><body>Forbidden</body></html>',
          url: 'https://www.zillow.com/x',
        })),
      });
      const err = await client.fetchHtml('/x').catch((e) => e);
      expect(err).not.toBeInstanceOf(CaptchaBlockedError);
      expect((err as Error).message).toMatch(/403/);
    });
  });
});
