// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// zillow-mcp's ZillowTransport interface.
//
// What this layer DOES instrument (boundary visibility):
//   - The `role` (host vs peer) the FetchproxyServer landed in after
//     `listen()`. Logged once to stderr on startup.
//   - Per-request timing around `this.inner.fetch(...)` when
//     ZILLOW_DEBUG=1 is set in the env.
//   - The timeout error carries the role, port, elapsed ms, and the
//     failed URL so the user can tell "bridge never came up" apart
//     from "single request stalled in flight."
//
// What this layer CAN'T instrument (lives upstream in
// https://github.com/chrischall/fetchproxy):
//   - Service worker wake-up + message-listener binding
//   - Content-script injection on the active tab
//   - Tab selection (which zillow.com tab the SW picked)
//   - The window.fetch() that actually runs in the page
// If you need that level of detail, file an issue / PR upstream — the
// hooks would need to land in the @fetchproxy/server protocol.

import {
  FetchproxyServer,
  type FetchproxyServerOpts,
} from '@fetchproxy/server';
import type {
  BridgeStatus,
  FetchInit,
  FetchResult,
  ZillowTransport,
} from './transport.js';

const ZILLOW_ORIGIN = 'https://www.zillow.com';
const ZILLOW_TAB_URL = 'https://www.zillow.com/';

// Generous deadline for a Zillow SSR response; the bridge has no
// native timeout, so a frozen tab / dropped extension would otherwise
// hang the MCP call indefinitely.
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

const DEFAULT_PORT = 37_149;

const DEBUG = process.env.ZILLOW_DEBUG === '1';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[zillow-mcp:bridge]', ...args);
}

/**
 * Thrown when the upstream extension's service worker is unreachable.
 * Distinct from `FetchproxyTimeoutError` (no response within timeout)
 * and from a generic transport `Error` (any other ok:false reason).
 * Carries the same role/port/elapsed diagnostic surface so callers
 * can show users one consistent failure shape.
 */
export class FetchproxyBridgeDownError extends Error {
  readonly url: string;
  readonly elapsedMs: number;
  readonly role: 'host' | 'peer' | null;
  readonly port: number;
  readonly originalError: string;
  readonly hint: string;

  constructor(args: {
    url: string;
    elapsedMs: number;
    role: 'host' | 'peer' | null;
    port: number;
    originalError: string;
    /** Whether zillow-mcp's one-shot lazy-revive retry already fired before this error surfaced. */
    retryAttempted?: boolean;
  }) {
    const retryClause = args.retryAttempted
      ? `zillow-mcp already tried a one-shot lazy-revive retry before surfacing this error, so the worker is still down. `
      : `zillow-mcp's one-shot lazy-revive retry was disabled (bridgeReviveDelayMs=0) so this error fired on the first attempt. `;
    const hint =
      `the fetchproxy browser extension's service worker is not ` +
      `responding ("${args.originalError}"). Chrome evicts extension ` +
      `service workers after ~30s idle by default. ` +
      retryClause +
      `To recover: click the fetchproxy ` +
      `extension icon in Chrome's toolbar to wake it (or open any ` +
      `zillow.com tab and reload). If it keeps happening, reload the ` +
      `extension from chrome://extensions/ — the extension may have ` +
      `crashed or been disabled.`;
    super(
      `fetchproxy bridge down: ${args.url} after ${args.elapsedMs}ms ` +
        `(role=${args.role ?? 'null'} port=${args.port}). ${hint}`
    );
    this.name = 'FetchproxyBridgeDownError';
    this.url = args.url;
    this.elapsedMs = args.elapsedMs;
    this.role = args.role;
    this.port = args.port;
    this.originalError = args.originalError;
    this.hint = hint;
  }
}

/**
 * Thrown when a request didn't get a response within `fetchTimeoutMs`.
 * Carries enough diagnostic context to distinguish:
 *   - bridge never came up (`role` = null, time elapsed ≈ timeout)
 *   - bridge came up but no extension connected yet
 *   - bridge + extension connected, single request stalled
 */
export class FetchproxyTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly role: 'host' | 'peer' | null;
  readonly port: number;
  readonly hint: string;

  constructor(args: {
    url: string;
    timeoutMs: number;
    elapsedMs: number;
    role: 'host' | 'peer' | null;
    port: number;
  }) {
    const hint =
      args.role === null
        ? `the bridge never bound role on startup — listen() may have failed before this request fired. Check stderr from zillow-mcp's startup banner.`
        : `bridge is role=${args.role} on port ${args.port}, so the WebSocket side is up; the request reached the bridge but no upstream response arrived within ${args.timeoutMs}ms. Most common causes: (a) the fetchproxy browser extension isn't connected to this MCP yet (check the extension popup for a green dot next to "zillow-mcp"), (b) the signed-in zillow.com tab is sleeping or was navigated away from before the request resolved, (c) the upstream zillow.com fetch itself is hanging on a login redirect or behavioral challenge.`;
    super(
      `fetchproxy: ${args.url} did not respond within ${args.timeoutMs}ms ` +
        `(elapsed ${args.elapsedMs}ms; bridge role=${args.role ?? 'null'} port=${args.port}). ` +
        hint
    );
    this.name = 'FetchproxyTimeoutError';
    this.url = args.url;
    this.timeoutMs = args.timeoutMs;
    this.elapsedMs = args.elapsedMs;
    this.role = args.role;
    this.port = args.port;
    this.hint = hint;
  }
}

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. Defaults to 'zillow-mcp'. */
  server?: string;
  /** MCP server version. Should match package.json + the banner in index.ts. */
  version: string;
  /** Per-request timeout in ms. Default 30s. */
  fetchTimeoutMs?: number;
  /**
   * Lazy-revive delay (ms) before retrying once on a
   * `content_script_unreachable` failure. Chrome MV3 evicts extension
   * service workers after ~30s idle; this gives the worker time to
   * wake. Default 2_000 ms. Set to 0 to disable lazy-revive.
   * (Issue #58.)
   */
  bridgeReviveDelayMs?: number;
}

export class FetchproxyTransport implements ZillowTransport {
  private readonly inner: FetchproxyServer;
  private readonly fetchTimeoutMs: number;
  private readonly bridgeReviveDelayMs: number;
  private readonly port: number;
  private readonly serverVersion: string;
  // Freshness counters surfaced through `status()` so `zillow_healthcheck`
  // can answer "is this bridge healthy or limping along?". Reset by a
  // success, not by close()/start() — we want a process-wide history.
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastFailureReason: string | null = null;
  private consecutiveFailures = 0;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.serverVersion = opts.version;
    const options: FetchproxyServerOpts = {
      port: this.port,
      serverName: opts.server ?? 'zillow-mcp',
      version: opts.version,
      // Subdomains of zillow.com (www, photos, etc.) match automatically.
      domains: ['zillow.com'],
    };
    this.inner = new FetchproxyServer(options);
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.bridgeReviveDelayMs = opts.bridgeReviveDelayMs ?? 2_000;
  }

  async start(): Promise<void> {
    log('listen start', { port: this.port, version: this.serverVersion });
    await this.inner.listen();
    // Stderr-only — stdio MCP transports reserve stdout for JSON-RPC.
    console.error(
      `[zillow-mcp:bridge] listening on 127.0.0.1:${this.port} ` +
        `(role=${this.inner.role ?? 'unknown'}, version=${this.serverVersion})`
    );
  }

  async close(): Promise<void> {
    log('close');
    return this.inner.close();
  }

  /**
   * Diagnostic snapshot of the bridge. Safe to call before `start()` —
   * `role` will be null until `listen()` resolves; freshness counters
   * are null/0 until the first request fires.
   */
  status(): BridgeStatus {
    return {
      role: this.inner.role,
      port: this.port,
      serverVersion: this.serverVersion,
      fetchTimeoutMs: this.fetchTimeoutMs,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastFailureReason: this.lastFailureReason,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private recordSuccess(): void {
    this.lastSuccessAt = Date.now();
    this.consecutiveFailures = 0;
  }

  private recordFailure(reason: string): void {
    this.lastFailureAt = Date.now();
    this.lastFailureReason = reason;
    this.consecutiveFailures += 1;
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    // Lazy-revive (issue #58): when the first attempt fails with
    // `content_script_unreachable` — Chrome's signal that the
    // extension service worker has been evicted — wait a couple of
    // seconds for the SW to wake and retry exactly once. Turns a
    // hard failure into a ~2s slowdown for the common eviction case.
    try {
      return await this.fetchOnce(init);
    } catch (err) {
      if (
        err instanceof FetchproxyBridgeDownError &&
        this.bridgeReviveDelayMs > 0
      ) {
        log('fetch:lazy-revive', { delayMs: this.bridgeReviveDelayMs });
        await new Promise((resolve) =>
          setTimeout(resolve, this.bridgeReviveDelayMs)
        );
        // Mark the retry's error (if any) so the hint accurately reports a retry happened.
        return this.fetchOnce(init, { retryAttempted: true });
      }
      throw err;
    }
  }

  private async fetchOnce(
    init: FetchInit,
    flags: { retryAttempted?: boolean } = {}
  ): Promise<FetchResult> {
    const url = init.path.startsWith('http')
      ? init.path
      : `${ZILLOW_ORIGIN}${init.path}`;
    const start = Date.now();
    log('fetch:start', {
      method: init.method,
      url,
      role: this.inner.role,
      port: this.port,
    });
    const inner = this.inner.fetch({
      url,
      method: init.method,
      tabUrl: ZILLOW_TAB_URL,
      headers: init.headers,
      body: init.body,
    });
    // Attach a no-op rejection handler up front so a WS drop or other
    // late failure on `inner` — arriving AFTER the race already settled
    // on the timeout side — doesn't become an unhandled rejection that
    // crashes the MCP server in Node ≥15.
    inner.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result;
    try {
      result = await Promise.race([
        inner,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const elapsed = Date.now() - start;
            log('fetch:timeout', { url, elapsed, role: this.inner.role });
            const err = new FetchproxyTimeoutError({
              url,
              timeoutMs: this.fetchTimeoutMs,
              elapsedMs: elapsed,
              role: this.inner.role,
              port: this.port,
            });
            this.recordFailure(`timeout: ${url}`);
            reject(err);
          }, this.fetchTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const elapsed = Date.now() - start;
    if (!result.ok) {
      log('fetch:bridge-error', { url, elapsed, error: result.error });
      this.recordFailure(result.error);
      // @fetchproxy/server 0.5.0+ classifies the extension-side error
      // into a discriminated `kind` (`'content_script_unreachable'`,
      // `'no_tab'`, `'tab_fetch_failed'`, …). We surface the SW-
      // unreachable case as a typed FetchproxyBridgeDownError so
      // callers + zillow_healthcheck can give actionable hints.
      if (result.kind === 'content_script_unreachable') {
        // `retryAttempted` is true only when this is the second pass
        // (after a lazy-revive sleep); on the first pass — or when
        // `bridgeReviveDelayMs === 0` disables the retry entirely —
        // it's effectively false (no retry has happened yet).
        const retryAttempted = flags.retryAttempted === true;
        throw new FetchproxyBridgeDownError({
          url,
          elapsedMs: elapsed,
          role: this.inner.role,
          port: this.port,
          originalError: result.error,
          retryAttempted,
        });
      }
      throw new Error(
        `fetchproxy transport error after ${elapsed}ms (role=${this.inner.role ?? 'null'}): ${result.error}`
      );
    }
    log('fetch:done', {
      url,
      elapsed,
      status: result.status,
      bodyLen: result.body.length,
    });
    this.recordSuccess();
    return { status: result.status, body: result.body, url: result.url };
  }
}
