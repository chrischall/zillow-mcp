import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import {
  registerBridgeHealthcheckTool,
  FetchproxyProtocolError,
} from '@chrischall/mcp-utils/fetchproxy';

/**
 * `zillow_healthcheck` — round-trip a no-op public request (`/robots.txt`)
 * through the full fetchproxy bridge so the user can tell, with ONE tool call
 * and no real search, whether:
 *
 *   - zillow-mcp's WebSocket bridge is up (`bridge.role` non-null)
 *   - the fetchproxy browser extension is connected (request reaches a tab
 *     and a response comes back)
 *   - the active zillow.com tab is responsive (the fetch resolved in time)
 *
 * The tool body — probe loop, timing, `classifyBridgeError`, the post-probe
 * bridge projection, the result shape, and the actionable hint ladder — is the
 * shared `registerBridgeHealthcheckTool` from `@chrischall/mcp-utils/fetchproxy`
 * (the ~230-LOC hand-rolled copy this file used to carry is gone, along with
 * its hardcoded-port bug). Only the per-site bits stay here:
 *
 *   - `classifyThrown` preserves this MCP's `other` kind for a non-bridge
 *     error (the shared tool maps fetchproxy's raw `other` → `unknown`);
 *     fetchproxy-typed errors keep the shared classification.
 *   - `hints` carries the Zillow-flavored copy for the `ok` / `protocol` arms.
 *     The rest of the ladder (`timeout` / `bridge_down` / `no_role`) uses the
 *     shared default, which already interpolates the live role, the REAL bridge
 *     port, and the bridge-down error's own `.hint`.
 */

const PROBE_PATH = '/robots.txt';
const HOST_LABEL = 'www.zillow.com';

export function registerHealthcheckTools(
  server: McpServer,
  client: ZillowClient
): void {
  registerBridgeHealthcheckTool({
    server,
    prefix: 'zillow',
    probePath: PROBE_PATH,
    hostLabel: HOST_LABEL,
    // The shared tool needs `runProbe` (probe loop + classification + bridge
    // projection) and `status()` (for `last_extension_message_at`, which the
    // projection omits). ZillowClient already delegates both to the transport.
    transport: {
      runProbe: (fetchFn, probePath) => client.runProbe(fetchFn, probePath),
      status: () => client.bridgeStatus(),
    },
    // Exercise the same client path real tools use (sign-in + bot-wall guards).
    probeFn: (path) => client.fetchHtml(path),
    classifyThrown: (err) =>
      err instanceof FetchproxyProtocolError ? undefined : { kind: 'other' },
    hints: {
      ok: `Bridge round-tripped ${PROBE_PATH} successfully. If real tools still hang, the problem is downstream of fetchproxy (Zillow redirecting on login, DataDome captcha, etc.) — not the bridge.`,
      protocol: `The bridge returned a protocol error before any HTTP response. Most commonly: no zillow.com tab is open, or the extension declined the request. Open zillow.com, sign in, and retry.`,
    },
  });
}
