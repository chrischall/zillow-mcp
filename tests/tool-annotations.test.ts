// Fleet annotation meta-test, read off the MCP wire (tools/list) rather than
// a hand-kept list, so a shared registrar (the mcp-utils session trio) is
// checked exactly as a client sees it. The registrar list mirrors
// src/index.ts's `tools: [...]`.
//
// `destructiveHint` DEFAULTS TO TRUE whenever readOnlyHint is false, so a
// write that forgets to declare it is published as destructive and nothing
// else fails — a considered `false` and a forgotten one look identical
// unless something asserts the key is present.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { ZillowClient } from '../src/client.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerPropertyTools } from '../src/tools/properties.js';
import { registerZestimateTools } from '../src/tools/zestimate.js';
import { registerSavedTools } from '../src/tools/saved.js';
import { registerMarketTools } from '../src/tools/market.js';
import { registerMortgageTools } from '../src/tools/mortgage.js';
import { registerHistoryTools } from '../src/tools/history.js';
import { registerCompareTools } from '../src/tools/compare.js';
import { registerAffordabilityTools } from '../src/tools/affordability.js';
import { registerPhotosTools } from '../src/tools/photos.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerGetByAddressTools } from '../src/tools/get-by-address.js';
import { registerBulkGetTools } from '../src/tools/bulk-get.js';
import { registerResolveAddressesTools } from '../src/tools/resolve-addresses.js';
import { registerSessionTools } from '../src/tools/sessions.js';
import { SessionRegistry } from '../src/sessions.js';
import { createTestHarness } from './helpers.js';

const client = {
  fetchHtml: vi.fn(),
  fetchJson: vi.fn(),
} as unknown as ZillowClient;

interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

let harness: Awaited<ReturnType<typeof createTestHarness>>;
let annotations: Record<string, Ann | undefined>;

beforeAll(async () => {
  const sessions = new SessionRegistry();
  harness = await createTestHarness((server) => {
    registerSearchTools(server, client);
    registerPropertyTools(server, client);
    registerZestimateTools(server, client);
    registerSavedTools(server, client, sessions);
    registerMarketTools(server, client);
    registerMortgageTools(server);
    registerHistoryTools(server, client);
    registerCompareTools(server, client);
    registerAffordabilityTools(server);
    registerPhotosTools(server, client);
    registerHealthcheckTools(server, client);
    registerGetByAddressTools(server, client);
    registerBulkGetTools(server, client);
    registerResolveAddressesTools(server, client);
    registerSessionTools(server, sessions);
  });
  const { tools } = await harness.client.listTools();
  annotations = Object.fromEntries(tools.map((t) => [t.name, t.annotations as Ann | undefined]));
});

afterAll(async () => {
  if (harness) await harness.close();
});

// Process-local tools: the calculators and the in-memory session registry.
// Everything else reaches zillow.com through the browser bridge.
const LOCAL = new Set([
  'zillow_calculate_mortgage',
  'zillow_calculate_affordability',
  'zillow_estimate_rent_vs_buy',
  'zillow_get_session_context',
  'zillow_register_session',
  'zillow_set_active_session',
]);

// Every write, pinned to its truthful destructive classification.
// - zillow_sweep_area: read-only against Zillow; its only write is the
//   optional local `output_path`, which must be a NEW absolute .json file
//   (an existing one is refused, and the write uses the 'wx' flag), so no
//   prior state is ever lost — purely additive.
// - the two session writes touch only the process-local, label-only
//   registry, reach no one, and the one piece of prior state they replace
//   (which session is active) is restored by zillow_set_active_session.
const WRITES: Record<string, boolean> = {
  zillow_sweep_area: false,
  zillow_register_session: false,
  zillow_set_active_session: false,
};

describe('tool annotations', () => {
  it('covers the full surface (guards against a registrar being dropped here)', () => {
    expect(Object.keys(annotations)).toHaveLength(21);
  });

  it('every tool sets an explicit boolean readOnlyHint', () => {
    const missing = Object.entries(annotations)
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean')
      .map(([n]) => n);
    expect(missing).toEqual([]);
  });

  it('every write sets an explicit boolean destructiveHint', () => {
    const missing = Object.entries(annotations)
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([n]) => n);
    expect(missing).toEqual([]);
  });

  it('no read claims to be destructive', () => {
    const bad = Object.entries(annotations)
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([n]) => n);
    expect(bad).toEqual([]);
  });

  it('the writes are exactly the pinned set, with their pinned classification', () => {
    const writes = Object.fromEntries(
      Object.entries(annotations)
        .filter(([, a]) => a?.readOnlyHint === false)
        .map(([n, a]) => [n, a?.destructiveHint]),
    );
    expect(writes).toEqual(WRITES);
  });

  it('openWorldHint is explicit: false only for process-local tools', () => {
    const wrong = Object.entries(annotations)
      .filter(([n, a]) => a?.openWorldHint !== !LOCAL.has(n))
      .map(([n]) => n);
    expect(wrong).toEqual([]);
  });
});
