// ZillowClient is the thin, tool-facing API over a ZillowTransport.
// Every tool goes through fetchHtml() (SSR pages with __NEXT_DATA__) or
// fetchJson() (Zillow's internal JSON endpoints). The transport handles
// the actual round-trip to the user's Chrome.
//
// Error mapping (non-2xx, sign-in interstitial, empty 204 body) lives
// here so tool authors never have to think about it.
import type {
  BridgeStatus,
  FetchInit,
  FetchResult,
  ZillowTransport,
} from './transport.js';

export class SessionNotAuthenticatedError extends Error {
  constructor() {
    super(
      'Not signed in to Zillow. Open zillow.com in your browser and sign in, then try again. ' +
        'Saved searches, saved homes, and recent activity require a signed-in session.'
    );
    this.name = 'SessionNotAuthenticatedError';
  }
}

/**
 * Default retry-after hint (seconds) surfaced on a `CaptchaBlockedError`
 * when PerimeterX doesn't give us an explicit one. Tuned for the
 * bulk-get back-off path (issue #90) — long enough that the bot-wall
 * usually clears on the next pass, short enough not to stall a batch.
 */
export const DEFAULT_CAPTCHA_RETRY_AFTER_S = 30;

/**
 * Issue #90: PerimeterX (px) bot-wall. A `bulk_get` that fans out too
 * many requests in a short window trips this — Zillow returns an HTTP
 * 403 (sometimes a 200) whose body is the PerimeterX CAPTCHA
 * interstitial, NOT the listing.
 *
 * This is its own error class — distinct from `SessionNotAuthenticatedError`
 * (DataDome / sign-in) and from a generic non-2xx — because the caller's
 * response differs: a captcha block is *transient and retryable* (back off
 * and retry the blocked ids), whereas a generic 403 / not-found means the
 * listing is genuinely unavailable. Misclassifying the bot-wall as
 * not-found silently corrupts downstream trackers (issue #90).
 */
export class CaptchaBlockedError extends Error {
  /** Suggested seconds to wait before retrying the blocked request(s). */
  readonly retryAfterSeconds: number;
  constructor(path: string, retryAfterSeconds = DEFAULT_CAPTCHA_RETRY_AFTER_S) {
    super(
      `Zillow served a PerimeterX CAPTCHA bot-wall for ${path} — the request was ` +
        `rate-limited, not a missing listing. Back off and retry (suggested wait: ` +
        `${retryAfterSeconds}s). If it persists, open zillow.com in your browser and ` +
        `clear the CAPTCHA, then retry with a smaller batch.`
    );
    this.name = 'CaptchaBlockedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The three PerimeterX px-captcha body markers from issue #90. Any one
 * of them in a response body means we hit the bot-wall rather than the
 * listing. Kept small and substring-based — the interstitial body shape
 * drifts, but these tokens are stable across px versions.
 */
const PX_CAPTCHA_MARKERS = [
  'window._pxAppId',
  'Access to this page has been denied',
  'meta name="px-captcha"',
] as const;

/**
 * True when a response body is a PerimeterX px-captcha interstitial.
 * Pure; matches any of the {@link PX_CAPTCHA_MARKERS}. Exported so the
 * detection logic has a direct unit-test surface (issue #90).
 */
export function detectPxCaptcha(body: string): boolean {
  return PX_CAPTCHA_MARKERS.some((marker) => body.includes(marker));
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

  /** Diagnostic snapshot of the bridge — surfaced by `zillow_healthcheck`. */
  bridgeStatus(): BridgeStatus {
    return this.transport.status();
  }

  /**
   * GET a zillow.com path, return the HTML body. Throws on non-2xx or
   * sign-in interstitial.
   */
  async fetchHtml(path: string): Promise<string> {
    const result = await this.transport.fetch({ path, method: 'GET' });
    // Issue #90: the px-captcha check runs FIRST — before throwIfNotOk —
    // because the bot-wall arrives as a 403 (sometimes a 200) whose body
    // is the CAPTCHA interstitial, and it must surface as a distinct
    // retryable CaptchaBlockedError rather than a generic "403" string.
    this.throwIfPxCaptcha(result, path);
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
    this.throwIfPxCaptcha(result, path);
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

  /**
   * Issue #90: detect the PerimeterX bot-wall before any other error
   * mapping. PerimeterX serves the CAPTCHA interstitial as the response
   * body (commonly HTTP 403, occasionally 200), so we key on the body
   * markers rather than the status code. Throws `CaptchaBlockedError` —
   * the bulk-get back-off path branches on it.
   */
  private throwIfPxCaptcha(result: FetchResult, path: string): void {
    if (detectPxCaptcha(result.body)) {
      // The bridge's FetchResult doesn't surface response headers, so we
      // can't read a server `Retry-After`; fall back to the tuned default.
      throw new CaptchaBlockedError(path);
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
