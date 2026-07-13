#!/usr/bin/env node
// zillow-mcp entrypoint.
//
// Boot sequence:
//   1. Construct a FetchproxyTransport listening on 127.0.0.1:37149.
//      The shared fetchproxy Chrome/Safari extension — installed
//      separately, not in this repo — connects here.
//      See https://github.com/chrischall/fetchproxy.
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
import { runMcp, type ToolRegistrar } from '@chrischall/mcp-utils';
import { ZillowClient } from './client.js';
import { FetchproxyTransport } from './transport-fetchproxy.js';
import { registerSearchTools } from './tools/search.js';
import { registerPropertyTools } from './tools/properties.js';
import { registerZestimateTools } from './tools/zestimate.js';
import { registerSavedTools } from './tools/saved.js';
import { registerMarketTools } from './tools/market.js';
import { registerMortgageTools } from './tools/mortgage.js';
import { registerHistoryTools } from './tools/history.js';
import { registerCompareTools } from './tools/compare.js';
import { registerAffordabilityTools } from './tools/affordability.js';
import { registerPhotosTools } from './tools/photos.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerGetByAddressTools } from './tools/get-by-address.js';
import { registerBulkGetTools } from './tools/bulk-get.js';
import { registerResolveAddressesTools } from './tools/resolve-addresses.js';
import { SessionRegistry } from './sessions.js';
import { registerSessionTools } from './tools/sessions.js';

const VERSION = '0.11.0'; // x-release-please-version

const port = process.env.ZILLOW_WS_PORT
  ? Number(process.env.ZILLOW_WS_PORT)
  : undefined;

const transport = new FetchproxyTransport({ port, version: VERSION });

const client = new ZillowClient({ transport });
await client.start();

// The session registry is process-local bookkeeping shared across the
// saved-data + session tools. Constructed here (not in a registrar) so the
// same instance is closure-captured by both registrars below.
const sessions = new SessionRegistry();

// Most registrars take (server, client); `saved` also needs the session
// registry and the session tools take (server, registry) alone. The two
// special cases are wrapped in closures so every entry conforms to
// ToolRegistrar<ZillowClient>; the local-only calculators (mortgage,
// affordability) simply ignore the client dep runMcp threads through.
const tools: ToolRegistrar<ZillowClient>[] = [
  registerSearchTools,
  registerPropertyTools,
  registerZestimateTools,
  (server, c) => registerSavedTools(server, c, sessions),
  registerMarketTools,
  registerMortgageTools,
  registerHistoryTools,
  registerCompareTools,
  registerAffordabilityTools,
  registerPhotosTools,
  registerHealthcheckTools,
  registerGetByAddressTools,
  registerBulkGetTools,
  registerResolveAddressesTools,
  (server) => registerSessionTools(server, sessions),
];

await runMcp({
  name: 'zillow-mcp',
  version: VERSION,
  tools,
  deps: client,
  banner:
    `[zillow-mcp] v${VERSION} — WebSocket bridge via @fetchproxy/server on 127.0.0.1:${port ?? 37149}. ` +
    'Install the fetchproxy extension (see https://github.com/chrischall/fetchproxy) ' +
    'and sign into zillow.com. This project was developed and is maintained by AI (Claude). ' +
    'Use at your own discretion.',
  shutdown: { onSignal: () => client.close() },
});
