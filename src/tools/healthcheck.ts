import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  classifyBridgeError,
  type BridgeError,
} from '@fetchproxy/server';

/**
 * Round-trip a no-op request through the full bridge so the user can
 * tell — with ONE tool call, without needing a real search — whether:
 *
 *   - zillow-mcp's WebSocket bridge is up (`bridge.role` non-null)
 *   - the fetchproxy browser extension is connected (request reaches
 *     a tab and a response comes back)
 *   - the active zillow.com tab is responsive (the fetch resolved
 *     within the timeout)
 *
 * Probe target: `/robots.txt` on zillow.com. It's small, public (no
 * auth needed), and served from Zillow's edge — so a failure here
 * cleanly isolates the bridge from zillow.com's own auth/SSR pipeline.
 * If `/robots.txt` round-trips OK but a real tool still hangs, the
 * problem is downstream of fetchproxy (Zillow redirecting on login,
 * DataDome captcha challenge, etc.); if `/robots.txt` fails, the
 * bridge or extension is the issue.
 */

interface HealthcheckResult {
  ok: boolean;
  bridge: {
    role: 'host' | 'peer' | null;
    port: number;
    server_version: string;
    fetch_timeout_ms: number;
    /** Unix-ms timestamp of the last successful round-trip. `null` until the first success. */
    last_success_at: number | null;
    /** Unix-ms timestamp of the last failed round-trip. `null` until the first failure. */
    last_failure_at: number | null;
    /** Most recent failure reason. `null` until the first failure. */
    last_failure_reason: string | null;
    /** Count of failures since the last success (or process start, if none). */
    consecutive_failures: number;
    /** 0.8.0+: timestamp of last inner frame from the extension — liveness regardless of success/failure. */
    last_extension_message_at: number | null;
  };
  probe: {
    url: string;
    elapsed_ms: number;
    status?: number;
    body_length?: number;
  };
  error?: {
    /**
     * 0.8.0+: discriminator from `classifyBridgeError`. Vocabulary:
     *   - `'timeout'`     → `FetchproxyTimeoutError`
     *   - `'bridge_down'` → `FetchproxyBridgeDownError` (Chrome MV3 SW eviction)
     *   - `'http'`        → `FetchproxyHttpError` (unexpected upstream status)
     *   - `'protocol'`    → base `FetchproxyProtocolError` not in the above buckets
     *   - `'other'`       → anything that's not a `FetchproxyProtocolError` subclass
     *
     * Replaces the legacy `'transport'` label (which mapped to `'protocol'`).
     */
    kind: BridgeError;
    message: string;
    /** When the timeout fired, the role at the moment of failure. */
    role_at_failure?: 'host' | 'peer' | null;
    /**
     * 0.8.0+: kind-specific structured detail surfaced from the typed
     * error. Populated only for the arms that carry useful fields:
     *   - `timeout`     → `{ elapsed_ms, timeout_ms }` from
     *                     `FetchproxyTimeoutError.elapsedMs / .timeoutMs`
     *   - `bridge_down` → `{ hint, retry_attempted }` from
     *                     `FetchproxyBridgeDownError.hint / .retryAttempted`
     */
    detail?: {
      elapsed_ms?: number;
      timeout_ms?: number;
      hint?: string;
      retry_attempted?: boolean;
    };
  };
  /** Plain-English next-step suggestion derived from the result. */
  hint: string;
}

const PROBE_PATH = '/robots.txt';
const DEFAULT_PORT = 37149;

function hintFor(args: {
  ok: boolean;
  role: 'host' | 'peer' | null;
  errorKind?: BridgeError;
  /**
   * 0.8.0+: when set, prepended to the bridge_down hint so the LLM
   * shows the user the package's own actionable copy
   * ("click the extension icon …") instead of paraphrasing it.
   */
  bridgeDownErrorHint?: string;
}): string {
  if (args.ok) {
    return `Bridge round-tripped /robots.txt successfully. If real tools still hang, the problem is downstream of fetchproxy (Zillow redirecting on login, DataDome captcha, etc.) — not the bridge.`;
  }
  // Order: specific error kinds first, then the generic role-based hint.
  // A FetchproxyBridgeDownError can fire with role=null (the bridge can
  // hand back the SW-eviction error before listen() has resolved); the
  // more-specific bridge_down hint must win over the generic
  // "never bound a role" message in that case.
  if (args.errorKind === 'bridge_down') {
    const base = `The fetchproxy browser extension's service worker is not responding. Chrome evicts extension service workers after ~30s idle by default — this looks like that case. Wake it by clicking the fetchproxy extension icon (or opening any zillow.com tab and reloading), then retry. If it keeps happening, reload the extension from chrome://extensions.`;
    // Prefix the package-supplied .hint (when present) so its specific
    // recovery copy leads. The package's hint is the authoritative
    // recovery guidance; our paragraph contextualises it for healthcheck.
    return args.bridgeDownErrorHint
      ? `${args.bridgeDownErrorHint} ${base}`
      : base;
  }
  if (args.role === null) {
    return `The bridge never bound a role. listen() may have failed silently on startup. Check stderr from zillow-mcp for an error during start, and confirm port ${DEFAULT_PORT} isn't blocked.`;
  }
  if (args.errorKind === 'timeout') {
    return `Bridge is alive (role=${args.role}), but the request didn't get a response in time. Either (a) the fetchproxy browser extension isn't connected to this MCP yet — open the extension popup and check for a green dot next to "zillow-mcp", or (b) the signed-in zillow.com tab is sleeping / closed. Open zillow.com in your browser, then retry.`;
  }
  // 0.8.0 classifyBridgeError vocabulary: 'protocol' (was 'transport' pre-0.8.0).
  if (args.errorKind === 'protocol') {
    return `The bridge returned a protocol error before any HTTP response. Most commonly: no zillow.com tab is open, or the extension declined the request. Open zillow.com, sign in, and retry.`;
  }
  if (args.errorKind === 'http') {
    return `Bridge round-tripped to Zillow, but the response status was outside the expected set. See error.message for the status / URL.`;
  }
  return `Unexpected error — see the error.message field for details.`;
}

export function registerHealthcheckTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_healthcheck',
    {
      title: 'Verify the fetchproxy bridge end-to-end',
      description:
        "Round-trips a small public Zillow URL (/robots.txt) through the fetchproxy bridge and returns diagnostics: the bridge's role (host/peer/null), port, version, the elapsed round-trip time, and a plain-English hint that distinguishes 'bridge never came up' from 'extension not connected' from 'real Zillow-side problem'. Call this when a real Zillow tool times out and you want to know which hop failed. Read-only, no auth required.",
      annotations: {
        title: 'Verify the fetchproxy bridge end-to-end',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      // We read bridgeStatus() once at the bottom (after the probe) so
      // the freshness counters in the response include this very call.
      // Don't read it up front — that snapshot would be stale.
      const start = Date.now();
      let probe: HealthcheckResult['probe'] = {
        url: `https://www.zillow.com${PROBE_PATH}`,
        elapsed_ms: 0,
      };
      let error: HealthcheckResult['error'];
      let ok = false;
      try {
        const html = await client.fetchHtml(PROBE_PATH);
        probe = {
          url: `https://www.zillow.com${PROBE_PATH}`,
          elapsed_ms: Date.now() - start,
          status: 200, // fetchHtml throws on non-2xx; reaching here means 2xx
          body_length: html.length,
        };
        ok = true;
      } catch (e) {
        const elapsedMs = Date.now() - start;
        // 0.8.0+: classifyBridgeError enforces the correct instanceof
        // ordering once (subclass before parent) — see its docs. Branching
        // on the returned string keeps this catch block flat and immune
        // to ladder-ordering bugs.
        const kind = classifyBridgeError(e);
        const message = e instanceof Error ? e.message : String(e);
        // role_at_failure is meaningful only for the typed-error arms.
        // For 'other' (non-bridge errors), it's noise — skip it.
        const roleAtFailure =
          kind === 'other' ? undefined : client.bridgeStatus().role;
        if (kind === 'timeout' && e instanceof FetchproxyTimeoutError) {
          error = {
            kind,
            message,
            role_at_failure: roleAtFailure,
            // Surface elapsedMs / timeoutMs so callers can distinguish
            // "barely missed" from "hung for the full window".
            detail: { elapsed_ms: e.elapsedMs, timeout_ms: e.timeoutMs },
          };
        } else if (
          kind === 'bridge_down' &&
          e instanceof FetchproxyBridgeDownError
        ) {
          error = {
            kind,
            message,
            role_at_failure: roleAtFailure,
            // Surface the package's actionable .hint + retryAttempted so
            // the LLM can show the user concrete recovery guidance.
            detail: { hint: e.hint, retry_attempted: e.retryAttempted },
          };
        } else {
          // Covers 'http', 'protocol', and 'other'.
          error =
            kind === 'other'
              ? { kind, message }
              : { kind, message, role_at_failure: roleAtFailure };
        }
        probe = { ...probe, elapsed_ms: elapsedMs };
      }
      // Re-read after the probe — recordSuccess/recordFailure on the
      // transport just updated the counters, so this snapshot reflects
      // the freshest state including this very call.
      const postProbeBridge = client.bridgeStatus();
      const result: HealthcheckResult = {
        ok,
        bridge: {
          role: postProbeBridge.role,
          port: postProbeBridge.port,
          server_version: postProbeBridge.serverVersion,
          fetch_timeout_ms: postProbeBridge.fetchTimeoutMs,
          last_success_at: postProbeBridge.lastSuccessAt,
          last_failure_at: postProbeBridge.lastFailureAt,
          last_failure_reason: postProbeBridge.lastFailureReason,
          consecutive_failures: postProbeBridge.consecutiveFailures,
          last_extension_message_at: postProbeBridge.lastExtensionMessageAt,
        },
        probe,
        ...(error ? { error } : {}),
        hint: hintFor({
          ok,
          role: postProbeBridge.role,
          errorKind: error?.kind,
          // Prepend the bridge-down error's `.hint` so the LLM sees the
          // package's specific recovery copy at the top.
          bridgeDownErrorHint:
            error?.kind === 'bridge_down' ? error.detail?.hint : undefined,
        }),
      };
      return textResult(result);
    }
  );
}
