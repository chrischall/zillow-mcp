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
import { createTestHarness } from './helpers.js';

const mockClient = {
  fetchHtml: vi.fn(),
  fetchJson: vi.fn(),
} as unknown as ZillowClient;

const EXPECTED_TOOLS = [
  'zillow_search_properties',
  'zillow_get_property',
  'zillow_get_zestimate_history',
  'zillow_get_saved_searches',
  'zillow_get_saved_homes',
  'zillow_get_market_report',
  'zillow_calculate_mortgage',
];

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('tool registration', () => {
  it('registers every advertised zillow_* tool', async () => {
    harness = await createTestHarness((server) => {
      registerSearchTools(server, mockClient);
      registerPropertyTools(server, mockClient);
      registerZestimateTools(server, mockClient);
      registerSavedTools(server, mockClient);
      registerMarketTools(server, mockClient);
      registerMortgageTools(server);
    });
    const tools = await harness.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });
});
