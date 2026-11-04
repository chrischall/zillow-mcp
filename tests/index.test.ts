// Smoke test for the full tool surface. Verifies every zillow_* tool is
// registered and visible over the MCP wire — catches "forgot to wire it
// up in index.ts" mistakes that the per-tool tests miss.
import { describe, it, expect, afterAll, vi } from 'vitest';
import type { ZillowClient } from '../src/client.js';
import { buildTools } from '../src/registrars.js';
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
      for (const register of buildTools(sessions)) register(server, mockClient);
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
