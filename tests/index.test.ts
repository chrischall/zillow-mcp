// Smoke test for the full tool surface. Verifies every zillow_* tool is
// registered and visible over the MCP wire — catches "forgot to wire it
// up in index.ts" mistakes that the per-tool tests miss.
import { describe, it, expect, afterAll, vi } from 'vitest';
import type { ZillowClient } from '../src/client.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerPropertyTools } from '../src/tools/properties.js';
import { registerZestimateTools } from '../src/tools/zestimate.js';
import { registerSavedTools } from '../src/tools/saved.js';
import { registerMarketTools } from '../src/tools/market.js';
import { registerMortgageTools } from '../src/tools/mortgage.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerHistoryTools } from '../src/tools/history.js';
import { registerCompareTools } from '../src/tools/compare.js';
import { registerAffordabilityTools } from '../src/tools/affordability.js';
import { registerPhotosTools } from '../src/tools/photos.js';
import { registerGetByAddressTools } from '../src/tools/get-by-address.js';
import { registerBulkGetTools } from '../src/tools/bulk-get.js';
import { registerResolveAddressesTools } from '../src/tools/resolve-addresses.js';
import { registerSessionTools } from '../src/tools/sessions.js';
import { SessionRegistry } from '../src/sessions.js';
import { readFileSync } from 'node:fs';
import { createTestHarness } from './helpers.js';

const mockClient = {
  fetchHtml: vi.fn(),
  fetchJson: vi.fn(),
} as unknown as ZillowClient;

const EXPECTED_TOOLS = [
  'zillow_search_properties',
  'zillow_sweep_area',
  'zillow_get_property',
  'zillow_get_zestimate_history',
  'zillow_get_saved_searches',
  'zillow_get_saved_homes',
  'zillow_get_market_report',
  'zillow_calculate_mortgage',
  'zillow_healthcheck',
  'zillow_get_price_history',
  'zillow_get_tax_history',
  'zillow_compare_properties',
  'zillow_calculate_affordability',
  'zillow_estimate_rent_vs_buy',
  'zillow_get_property_photos',
  'zillow_get_by_address',
  'zillow_bulk_get',
  'zillow_resolve_addresses',
  'zillow_register_session',
  'zillow_set_active_session',
  'zillow_get_session_context',
];

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('tool registration', () => {
  it('registers every advertised zillow_* tool', async () => {
    const sessions = new SessionRegistry();
    harness = await createTestHarness((server) => {
      registerSearchTools(server, mockClient);
      registerPropertyTools(server, mockClient);
      registerZestimateTools(server, mockClient);
      registerSavedTools(server, mockClient, sessions);
      registerMarketTools(server, mockClient);
      registerMortgageTools(server);
      registerHistoryTools(server, mockClient);
      registerCompareTools(server, mockClient);
      registerAffordabilityTools(server);
      registerPhotosTools(server, mockClient);
      registerHealthcheckTools(server, mockClient);
      registerGetByAddressTools(server, mockClient);
      registerBulkGetTools(server, mockClient);
      registerResolveAddressesTools(server, mockClient);
      registerSessionTools(server, sessions);
    });
    const tools = await harness.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });

  // fleet-audit#813: the .mcpb manifest's tool list is what Claude Desktop
  // shows for the extension, so it must name exactly the registered tools.
  it('manifest.json advertises exactly the registered tools', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')
    ) as { tools: { name: string }[] };
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(
      [...EXPECTED_TOOLS].sort()
    );
  });
});
