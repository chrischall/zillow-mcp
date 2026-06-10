// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// zillow-mcp's ZillowTransport interface.
//
// 0.10.0: this is now a thin delegate over mcp-utils'
// `createFetchproxyTransport` — the shared Pattern-A factory that owns the
// `FetchproxyServer` construction, the `start`/`close`/`status` lifecycle,
// the `logListening` startup banner, and the `fetch`/`requestJson`/`runProbe`
// verb passthroughs (with the per-site `defaultSubdomain: 'www'` applied).
// zillow previously hand-rolled all of that here specifically because the
// transport spec needed to capture the FetchproxyServer constructor opts —
// the factory now exposes a `createServer` seam exactly for that, so the
// test injects a capturing mock through it instead of subclassing the ctor.
//
// As of @fetchproxy/server 0.8.0+, lazy-revive on Chrome MV3 service-worker
// eviction (default 2000ms) and per-request timeouts (default 30000ms) are
// server defaults — forwarded only when the caller overrides. 0.10.0 adds
// the server-initiated keep-alive ping to that set of zero-config defaults
// (keepAliveIntervalMs: 25_000, fetchproxy#72), so this adapter no longer
// opts into it explicitly. `status()` additively carries `serverVersion`
// (the factory pins it to the `version` opt), and `requestJson`/`runProbe`
// delegate to the server's own implementations.

import {
  createFetchproxyTransport,
  type FetchproxyServer,
  type FetchproxyServerOpts,
  type FetchproxyTransport as SharedFetchproxyTransport,
} from '@chrischall/mcp-utils/fetchproxy';
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
} from '@chrischall/mcp-utils/fetchproxy';

const DEFAULT_PORT = 37_149;

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
  /**
   * Test seam forwarded to `createFetchproxyTransport`: a factory that
   * builds the underlying `FetchproxyServer`. Defaults to
   * `(o) => new FetchproxyServer(o)`. The transport spec passes a factory
   * returning a capturing mock so it can record the constructor opts and
   * stub verbs without reaching into the factory's prebuilt dist.
   */
  createServer?: (opts: FetchproxyServerOpts) => FetchproxyServer;
}

/**
 * ZillowTransport implementation backed by the shared fetchproxy factory.
 *
 * The verb surface is the factory's, with one signature adaptation:
 * `ZillowTransport.requestJson(path, init?)` (method carried in `init`)
 * fronts the factory's `requestJson(method, path, init?)`, so the client's
 * call site and the public interface stay exactly as they were.
 */
export class FetchproxyTransport implements ZillowTransport {
  private readonly inner: SharedFetchproxyTransport;

  constructor(opts: FetchproxyTransportOptions) {
    const port = opts.port ?? DEFAULT_PORT;
    this.inner = createFetchproxyTransport<SharedFetchproxyTransport>({
      port,
      serverName: opts.server ?? 'zillow-mcp',
      version: opts.version,
      // Subdomains of zillow.com (www, photos, etc.) match automatically.
      domains: ['zillow.com'],
      // Every zillow.com request targets www; the verb adapters apply this
      // unless a caller overrides it per-call. Absolute URLs self-describe.
      defaultSubdomain: 'www',
      // Opt into the canonical fleet startup banner (stderr-only, since
      // stdio MCP transports reserve stdout for JSON-RPC).
      logListening: true,
      // Env-gated per-request debug logging, replacing the hand-rolled
      // ZILLOW_DEBUG=1 logger this module used to carry.
      debugEnvVar: 'ZILLOW_DEBUG',
      // keepAliveIntervalMs is no longer passed — 0.10.0 defaults it to
      // 25_000ms server-side (fetchproxy#72). Behavior-preserving vs the
      // 0.9.x opt-in.
      ...(opts.fetchTimeoutMs !== undefined
        ? { fetchTimeoutMs: opts.fetchTimeoutMs }
        : {}),
      ...(opts.bridgeReviveDelayMs !== undefined
        ? { bridgeReviveDelayMs: opts.bridgeReviveDelayMs }
        : {}),
      ...(opts.createServer ? { createServer: opts.createServer } : {}),
    });
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  /**
   * 0.10.0: delegate straight to the factory transport's `status()`, which
   * projects `inner.bridgeHealth()` and additively pins `serverVersion` to
   * the `version` opt (the field the hand-rolled adapter used to wrap by
   * hand). `BridgeStatus` is an alias for the server's `BridgeHealth`.
   */
  status(): BridgeStatus {
    return this.inner.status();
  }

  fetch(init: FetchInit): Promise<FetchResult> {
    // The factory's verb applies `defaultSubdomain: 'www'`; absolute paths
    // self-describe their host and ignore it.
    return this.inner.fetch(init);
  }

  /**
   * 0.10.0: delegate JSON round-trips to the factory's `requestJson`. The
   * ZillowTransport contract carries the HTTP method inside `init` (default
   * POST); the factory takes it positionally, so we unpack it here. The
   * `{ data, result }` pair is handed back unchanged so the client runs its
   * own px-bot-wall / sign-in / non-2xx guards over `result`.
   */
  requestJson<T>(
    path: string,
    init: RequestJsonInit = {}
  ): Promise<{ data: T | null; result: ServerFetchResult }> {
    const method = init.method ?? 'POST';
    return this.inner.requestJson<T>(method, path, {
      headers: init.headers,
      body: init.body,
    });
  }

  /**
   * 0.10.0: delegate the healthcheck probe loop to the factory's
   * `runProbe`. The zillow_healthcheck tool keeps its own site-specific
   * hint text and error-detail enrichment on top.
   */
  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult> {
    return this.inner.runProbe(fetchFn, probePath);
  }
}
