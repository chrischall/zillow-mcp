// ZillowClient is the thin, tool-facing API over a ZillowTransport.
// Every tool goes through fetchHtml() (SSR pages with __NEXT_DATA__) or
// fetchJson() (Zillow's internal JSON endpoints). The transport handles
// the actual round-trip to the user's Chrome.
//
// Error mapping (non-2xx, sign-in interstitial, empty 204 body) lives
// here so tool authors never have to think about it.
import type { FetchInit, FetchResult, ZillowTransport } from './transport.js';

export class SessionNotAuthenticatedError extends Error {
  constructor() {
    super(
      'Not signed in to Zillow. Open zillow.com in your browser and sign in, then try again. ' +
        'Saved searches, saved homes, and recent activity require a signed-in session.'
    );
    this.name = 'SessionNotAuthenticatedError';
  }
}

export interface ZillowClientOptions {
  /** Transport used to relay fetches to the user's browser. */
  transport: ZillowTransport;
}

export class ZillowClient {
  private readonly transport: ZillowTransport;

  constructor(opts: ZillowClientOptions) {
    this.transport = opts.transport;
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /**
   * GET a zillow.com path, return the HTML body. Throws on non-2xx or
   * sign-in interstitial.
   */
  async fetchHtml(path: string): Promise<string> {
    const result = await this.transport.fetch({ path, method: 'GET' });
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignInPage(result);
    return result.body;
  }

  /**
   * POST/PUT/DELETE a JSON body, return the parsed JSON. Throws on
   * non-2xx, invalid JSON, or sign-in page.
   */
  async fetchJson<T>(
    path: string,
    init: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      headers?: Record<string, string>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const method = init.method ?? 'POST';
    const serialised: FetchInit = {
      path,
      method,
      headers: {
        Accept: 'application/json',
        ...(method !== 'GET' && init.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(init.headers ?? {}),
      },
      body:
        method === 'GET' || init.body === undefined
          ? undefined
          : JSON.stringify(init.body),
    };
    const result = await this.transport.fetch(serialised);
    this.throwIfNotOk(result, method, path);
    this.throwIfSignInPage(result);
    if (result.status === 204 || result.body === '') {
      return null as T;
    }
    try {
      return JSON.parse(result.body) as T;
    } catch (e) {
      throw new Error(
        `Zillow ${method} ${path} — response was not JSON: ${String(
          (e as Error).message
        )}`
      );
    }
  }

  private throwIfNotOk(result: FetchResult, method: string, path: string): void {
    if (result.status >= 200 && result.status < 300) return;
    const bodyPreview = result.body
      ? ` — ${result.body.slice(0, 500).replace(/\s+/g, ' ').trim()}${
          result.body.length > 500 ? '…' : ''
        }`
      : '';
    throw new Error(
      `Zillow API error: ${result.status} for ${method} ${path}${bodyPreview}`
    );
  }

  private throwIfSignInPage(result: FetchResult): void {
    // Zillow signals a missing session in two ways:
    //   1. URL — a redirect to `/user/login` or `?login=true` on any path.
    //   2. Body — the DataDome captcha interstitial includes the literal
    //      string `captcha-delivery` (the script host name). The < 80KB
    //      guard avoids matching that substring inside the gargantuan
    //      legitimate SSR pages (300-800KB) that might mention it in
    //      passing.
    //
    // We deliberately do NOT treat `/user/login` *in the body* as a
    // sign-in marker — every signed-in Zillow page has a "Sign in"
    // link in its nav pointing there, so a body-match would
    // false-positive on legitimate small pages.
    const looksLikeSignIn =
      /\/user\/login/.test(result.url) ||
      /[?&]login=true/.test(result.url) ||
      (result.body.includes('captcha-delivery') && result.body.length < 80_000);
    if (looksLikeSignIn) throw new SessionNotAuthenticatedError();
  }
}
