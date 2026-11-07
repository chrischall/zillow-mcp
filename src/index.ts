#!/usr/bin/env node
// zillow-mcp entrypoint.
//
// Boot sequence:
//   1. Construct a FetchproxyTransport listening on 127.0.0.1:37149.
//      The shared ContextMint Bridge Chrome/Safari extension — installed
//      separately, not in this repo — connects here.
//      See https://github.com/nullnet-app/contextmint-bridge/releases.
//   2. ZillowClient.start() — brings the transport up.
//   3. runMcp() — builds the MCP server, applies every tool registrar,
//      prints the stderr banner, wires SIGINT/SIGTERM to close the
//      client, and connects stdio for the host client.
//
// The transport outlives the MCP session. On SIGINT/SIGTERM the shared
// graceful-shutdown handler closes the client so ports/connections don't
// leak between client restarts.
//
// Deferred-config-error pattern: the client/transport AND the session
// registry are constructed HERE (the caller), not inside runMcp — so the
// host's initial `tools/list` always succeeds and any bridge/auth error
// surfaces at the first tool call rather than at boot.
import { runMcp } from '@chrischall/mcp-utils';
import { ZillowClient } from './client.js';
import { FetchproxyTransport } from './transport-fetchproxy.js';
import { buildTools } from './registrars.js';
import { SessionRegistry } from './sessions.js';
import { resolveWsPort } from './ws-port.js';

const VERSION = '1.3.2'; // x-release-please-version

// Validated ZILLOW_WS_PORT (fleet-audit#916): junk / out-of-range values
// warn on stderr and fall back to the default instead of becoming NaN.
const { port, effectivePort } = resolveWsPort();

const transport = new FetchproxyTransport({ port, version: VERSION });

const client = new ZillowClient({ transport });
await client.start();

// The session registry is process-local bookkeeping shared across the
// saved-data + session tools. Constructed here (not in a registrar) so the
// same instance is closure-captured by both registrars below.
const sessions = new SessionRegistry();

// The registrar list lives in registrars.ts (shared with the hints test).
const tools = buildTools(sessions);

await runMcp({
  name: 'zillow-mcp',
  version: VERSION,
  tools,
  deps: client,
  banner:
    `[zillow-mcp] v${VERSION} — WebSocket bridge via @fetchproxy/server on 127.0.0.1:${effectivePort}. ` +
    'Install the ContextMint Bridge extension (see https://github.com/nullnet-app/contextmint-bridge/releases) ' +
    'and sign into zillow.com. This project was developed and is maintained by AI (Claude). ' +
    'Use at your own discretion.',
  shutdown: { onSignal: () => client.close() },
});
