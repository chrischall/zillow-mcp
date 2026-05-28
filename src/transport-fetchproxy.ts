// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// zillow-mcp's ZillowTransport interface.
//
// As of @fetchproxy/server 0.8.0, lazy-revive on Chrome MV3
// service-worker eviction (default 2000ms) and per-request timeouts
// (default 30000ms) are server defaults — we get them with zero
// configuration. The convenience `request()` method throws typed
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

// Re-export typed errors so callers importing from this module keep working.
export {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '@fetchproxy/server';

const ZILLOW_ORIGIN = 'https://www.zillow.com';
const ZILLOW_TAB_URL = 'https://www.zillow.com/';

// 0.8.0 server default — mirrored here for `status()` reporting.
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

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
  /** Per-request timeout in ms. Default 30s (server-side, 0.8.0+). */
  fetchTimeoutMs?: number;
  /**
   * Lazy-revive delay (ms) before the server retries once on a
   * `content_script_unreachable` failure. Default 2_000 ms (server-
   * side, 0.8.0+). Pass 0 to disable.
   */
  bridgeReviveDelayMs?: number;
}

export class FetchproxyTransport implements ZillowTransport {
  private readonly inner: FetchproxyServer;
  private readonly fetchTimeoutMs: number;
  private readonly port: number;
  private readonly serverVersion: string;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.serverVersion = opts.version;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const options: FetchproxyServerOpts = {
      port: this.port,
      serverName: opts.server ?? 'zillow-mcp',
      version: opts.version,
      // Subdomains of zillow.com (www, photos, etc.) match automatically.
      domains: ['zillow.com'],
      fetchTimeoutMs: this.fetchTimeoutMs,
      // fetchproxy#71 — keep SW resident across human-paced session gaps
      keepAliveIntervalMs: 25_000,
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
   * `fetchTimeoutMs` are populated by the server from its own opts.
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
}
