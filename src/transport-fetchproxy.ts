// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// zillow-mcp's ZillowTransport interface.
//
// As of @fetchproxy/server 0.8.0+, lazy-revive on Chrome MV3
// service-worker eviction (default 2000ms) and per-request timeouts
// (default 30000ms) are server defaults — we get them with zero
// configuration, so this adapter only forwards them when the caller
// overrides. 0.10.0 adds the server-initiated keep-alive ping to that
// set of zero-config defaults (keepAliveIntervalMs: 25_000,
// fetchproxy#72), so this adapter no longer opts into it explicitly.
// The convenience `request()` method throws typed
// `FetchproxyBridgeDownError` / `FetchproxyTimeoutError` on failure
// (both subclasses of `FetchproxyProtocolError`). Bridge freshness
// counters live on `inner.bridgeHealth()` — `status()` re-exposes them
// through the ZillowTransport contract.
//
// What this layer DOES instrument (boundary visibility):
//   - The `role` (host vs peer) the FetchproxyServer landed in after
//     `listen()`. Logged once to stderr on startup.
//   - Per-request timing around `this.inner.request(...)` when
//     ZILLOW_DEBUG=1 is set in the env.
//
// What this layer CAN'T instrument (lives upstream in
// https://github.com/chrischall/fetchproxy):
//   - Service worker wake-up + message-listener binding
//   - Content-script injection on the active tab
//   - Tab selection (which zillow.com tab the SW picked)
//   - The window.fetch() that actually runs in the page

// This adapter is the ONE place that constructs the FetchproxyServer, and the
// transport spec mocks `@fetchproxy/server`'s constructor to capture opts —
// so the server class (and the typed-error re-exports below) stay direct
// imports rather than routing through `@chrischall/mcp-utils/fetchproxy`,
// which would bypass that mock. The bridge *primitives* (classifyBotWall,
// mapWithConcurrency, TokenBucket, …) DO route through the shared subpath in
// client.ts and the batch tools.
import {
  FetchproxyServer,
  type FetchproxyServerOpts,
} from '@fetchproxy/server';
import type {
  BridgeProbeResult,
  BridgeStatus,
  FetchInit,
  FetchResult,
  RequestJsonInit,
  ServerFetchResult,
  ZillowTransport,
} from './transport.js';

// Re-export typed errors so callers importing from this module keep working.
export {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '@fetchproxy/server';

const ZILLOW_ORIGIN = 'https://www.zillow.com';

const DEFAULT_PORT = 37_149;

const DEBUG = process.env.ZILLOW_DEBUG === '1';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[zillow-mcp:bridge]', ...args);
}

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. Defaults to 'zillow-mcp'. */
  server?: string;
  /** MCP server version. Should match package.json + the banner in index.ts. */
  version: string;
  /**
   * Per-request timeout in ms. Defaults to the server-side default
   * (30_000 ms in 0.8.0+); only forwarded when overridden.
   */
  fetchTimeoutMs?: number;
  /**
   * Lazy-revive delay (ms) before the server retries once on a
   * `content_script_unreachable` failure. Defaults to the server-side
   * default (2_000 ms in 0.8.0+); only forwarded when overridden. Pass
   * 0 to disable.
   */
  bridgeReviveDelayMs?: number;
}

export class FetchproxyTransport implements ZillowTransport {
  private readonly inner: FetchproxyServer;
  private readonly port: number;
  private readonly serverVersion: string;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.serverVersion = opts.version;
    const options: FetchproxyServerOpts = {
      port: this.port,
      serverName: opts.server ?? 'zillow-mcp',
      version: opts.version,
      // Subdomains of zillow.com (www, photos, etc.) match automatically.
      domains: ['zillow.com'],
      // keepAliveIntervalMs is no longer passed — 0.10.0 defaults it to
      // 25_000ms server-side (fetchproxy#72), so we get the SW-resident
      // keep-alive ping for free. Behavior-preserving vs the 0.9.x opt-in.
      ...(opts.fetchTimeoutMs !== undefined
        ? { fetchTimeoutMs: opts.fetchTimeoutMs }
        : {}),
      ...(opts.bridgeReviveDelayMs !== undefined
        ? { bridgeReviveDelayMs: opts.bridgeReviveDelayMs }
        : {}),
    };
    this.inner = new FetchproxyServer(options);
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
   * 0.8.0+: BridgeStatus is now an alias for the server's BridgeHealth,
   * so the shim collapses to a direct delegation. `serverVersion` and
   * `fetchTimeoutMs` are populated by the server from its own opts (or
   * its defaults when we don't override).
   */
  status(): BridgeStatus {
    return this.inner.bridgeHealth();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    // 0.8.0+: `request()` throws FetchproxyBridgeDownError on persistent
    // SW eviction (after the server's one-shot lazy-revive retry) and
    // FetchproxyTimeoutError on fetchTimeoutMs — both subclasses of
    // FetchproxyProtocolError so callers catching the parent still match.
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
    const response = await this.inner.request(init.method, init.path, {
      subdomain: 'www',
      headers: init.headers,
      body: init.body,
    });
    log('fetch:done', {
      url,
      elapsed: Date.now() - start,
      status: response.status,
      bodyLen: response.body.length,
    });
    return { status: response.status, body: response.body, url: response.url };
  }

  /**
   * 0.10.0: delegate JSON round-trips to the server's `requestJson`,
   * which does header defaults + body serialization + 204/empty → null.
   * We force `subdomain: 'www'` (every zillow.com request targets www,
   * same as `fetch()`), and hand back the `{ data, result }` pair so the
   * client runs its own px-bot-wall / sign-in / non-2xx guards over
   * `result`.
   */
  async requestJson<T>(
    path: string,
    init: RequestJsonInit = {}
  ): Promise<{ data: T | null; result: ServerFetchResult }> {
    const method = init.method ?? 'POST';
    return this.inner.requestJson<T>(method, path, {
      subdomain: 'www',
      headers: init.headers,
      body: init.body,
    });
  }

  /**
   * 0.10.0: delegate the healthcheck probe loop to the server's
   * `runProbe` — it runs `fetchFn(probePath)`, times it, classifies any
   * thrown error via `classifyBridgeError`, and projects the post-probe
   * `bridgeHealth()`. The zillow_healthcheck tool keeps its own
   * site-specific hint text and error-detail enrichment on top.
   */
  async runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult> {
    return this.inner.runProbe(fetchFn, probePath);
  }
}
