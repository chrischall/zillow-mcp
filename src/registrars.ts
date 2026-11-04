// The registrar list index.ts serves — one place, so the hints test
// (tests/hints.test.ts) enumerates exactly the tools a host lists.
import type { ToolRegistrar } from '@chrischall/mcp-utils';
import type { ZillowClient } from './client.js';
import type { SessionRegistry } from './sessions.js';
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
import { registerSessionTools } from './tools/sessions.js';

/**
 * Most registrars take (server, client); `saved` also needs the session
 * registry and the session tools take (server, registry) alone. The two
 * special cases are wrapped in closures so every entry conforms to
 * ToolRegistrar<ZillowClient>; the local-only calculators (mortgage,
 * affordability) simply ignore the client dep runMcp threads through.
 */
export function buildTools(sessions: SessionRegistry): ToolRegistrar<ZillowClient>[] {
  return [
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
}
