// ZillowClient is the thin, tool-facing API over a ZillowTransport.
// Every tool goes through fetchHtml() (SSR pages with __NEXT_DATA__) or
// fetchJson() (Zillow's internal JSON endpoints). The transport handles
// the actual round-trip to the user's Chrome.
//
// Error mapping (non-2xx, sign-in interstitial, empty 204 body) lives
// here so tool authors never have to think about it.
import { classifyBotWall, type FetchErrorKind } from '@fetchproxy/server';
import type {
  BridgeStatus,
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
 * Default retry-after hint (seconds) surfaced on a `BotWallError` when
 * the bot-wall interstitial doesn't give us an explicit one. Tuned for
 * the bulk-get back-off path (issue #90) — long enough that the wall
 * usually clears on the next pass, short enough not to stall a batch.
 */
export const DEFAULT_BOT_WALL_RETRY_AFTER_S = 30;

/**
 * Issue #90 / #91: PerimeterX (px) bot-wall. A `bulk_get` that fans out
 * too many requests in a short window trips this — Zillow returns an
 * HTTP 403 (sometimes a 200) whose body is the PerimeterX CAPTCHA
 * interstitial, NOT the listing.
 *
 * 0.10.0: detection is now the shared `classifyBotWall` from
 * `@fetchproxy/server` (promoted from this MCP's #91 px-detection); this
 * error is the retryable signal it raises, carrying the server's
 * canonical `bot_challenge` {@link FetchErrorKind} so bulk-get classifies
 * rows with one vocabulary instead of a local string.
 *
 * It stays a distinct class — separate from `SessionNotAuthenticatedError`
 * (DataDome / sign-in) and from a generic non-2xx — because the caller's
 * response differs: a bot-wall is *transient and retryable* (back off and
 * retry the blocked ids), whereas a generic 403 / not-found means the
 * listing is genuinely unavailable. Misclassifying the bot-wall as
 * not-found silently corrupts downstream trackers (issue #90).
 */
export class BotWallError extends Error {
  /** The server's canonical bot-wall error kind. */
  readonly kind: FetchErrorKind = 'bot_challenge';
  /** Suggested seconds to wait before retrying the blocked request(s). */
  readonly retryAfterSeconds: number;
  constructor(path: string, retryAfterSeconds = DEFAULT_BOT_WALL_RETRY_AFTER_S) {
    super(
      `Zillow served a PerimeterX CAPTCHA bot-wall for ${path} — the request was ` +
        `rate-limited, not a missing listing. Back off and retry (suggested wait: ` +
        `${retryAfterSeconds}s). If it persists, open zillow.com in your browser and ` +
        `clear the CAPTCHA, then retry with a smaller batch.`
    );
    this.name = 'BotWallError';
    this.retryAfterSeconds = retryAfterSeconds;
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

  /** Diagnostic snapshot of the bridge — surfaced by `zillow_healthcheck`. */
  bridgeStatus(): BridgeStatus {
    return this.transport.status();
  }

  /**
   * 0.10.0: run one healthcheck probe through the transport's `runProbe`
   * (probe execution + timing + `classifyBridgeError` + bridge
   * projection). The `zillow_healthcheck` tool keeps its own probe call
   * (`(p) => this.fetchHtml(p)`), probe path, and site-specific hints.
   */
  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): ReturnType<ZillowTransport['runProbe']> {
    return this.transport.runProbe(fetchFn, probePath);
  }

  /**
   * GET a zillow.com path, return the HTML body. Throws on non-2xx or
   * sign-in interstitial.
   */
  async fetchHtml(path: string): Promise<string> {
    const result = await this.transport.fetch({ path, method: 'GET' });
    // Issue #90: the bot-wall check runs FIRST — before throwIfNotOk —
    // because the wall arrives as a 403 (sometimes a 200) whose body is
    // the CAPTCHA interstitial, and it must surface as a distinct
    // retryable BotWallError rather than a generic "403" string.
    this.throwIfBotWall(result, path);
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
    // 0.10.0: serialization (Accept/Content-Type defaults, JSON.stringify,
    // 204/empty → null, JSON.parse) is the server's `requestJson`. It
    // hands back BOTH the parsed `data` and the raw `result` so the
    // per-site guards below stay here — the server deliberately doesn't
    // assert on status or look for Zillow's sign-in interstitial.
    const { data, result } = await this.transport.requestJson<T>(path, {
      method,
      headers: init.headers,
      body: init.body,
    });
    this.throwIfBotWall(result, path);
    this.throwIfNotOk(result, method, path);
    this.throwIfSignInPage(result);
    return data as T;
  }

  /**
   * Issue #90 / #91: detect the PerimeterX bot-wall before any other
   * error mapping. 0.10.0: detection is the shared `classifyBotWall`
   * (body-first, so a 200-status px wall is still caught). We act ONLY on
   * the `perimeterx` vendor — that's the retryable bot-wall this MCP
   * backs off on. The classifier also recognises DataDome's
   * `captcha-delivery` marker, but on Zillow that interstitial means
   * "sign in", not "rate-limited", so it stays the job of
   * `throwIfSignInPage` below; folding it in here would change behavior.
   *
   * Issue #92: the px false-positive (`window._pxAppId` — the sensor
   * bootstrap Zillow inlines into every SSR page — was a px marker) is
   * fixed in the shared classifier itself as of `@fetchproxy/server`
   * 0.11.1, so detection lives entirely in `classifyBotWall` with no
   * local guard.
   */
  private throwIfBotWall(result: FetchResult, path: string): void {
    // The bridge's FetchResult doesn't surface response headers, so we
    // pass body + status only (matching the body-only px detection) and
    // fall back to the tuned default retry-after.
    const verdict = classifyBotWall(result.body, result.status);
    if (verdict.blocked && verdict.vendor === 'perimeterx') {
      throw new BotWallError(path);
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
