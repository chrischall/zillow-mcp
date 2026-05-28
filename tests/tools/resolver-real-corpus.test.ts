import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { registerGetByAddressTools } from '../../src/tools/get-by-address.js';
import { registerResolveAddressesTools } from '../../src/tools/resolve-addresses.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

// Issue #81: real fail-then-succeed test corpus pinned from the
// session that originally surfaced #73/#75/#76/#74. Each row exercises
// one specific rung of the resolver ladder so a future regression on
// any single rung breaks exactly the relevant case.

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

let single: Awaited<ReturnType<typeof createTestHarness>>;
let bulk: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (single) await single.close();
  if (bulk) await bulk.close();
});

const EMPTY_HTML =
  '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>';

function htmlListing(args: {
  zpid: number;
  streetAddress: string;
  city: string;
  state: string;
  zip: string;
}): string {
  const nextData = {
    props: {
      pageProps: {
        searchPageState: {
          queryState: { regionSelection: [], mapBounds: null },
          cat1: {
            searchResults: {
              listResults: [
                {
                  zpid: args.zpid,
                  detailUrl: `/homedetails/${args.zpid}_zpid/`,
                  hdpData: {
                    homeInfo: {
                      zpid: args.zpid,
                      streetAddress: args.streetAddress,
                      city: args.city,
                      state: args.state,
                      zipcode: args.zip,
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData
  )}</script>`;
}

// Realistic backend modelled after the actual Zillow behavior we saw
// in the session that produced #81. Each address is matched by the
// slug-substring that would naturally appear in the resolver's URL.
function realisticBackend(): (path: string) => Promise<string> {
  return async (path: string) => {
    const decoded = decodeURIComponent(path).toLowerCase();

    // 212 Ridgeway Rd, Lake Lure NC 28746 — only resolves when the
    // "Lake Lure" city is dropped (city-drop rung) OR replaced with
    // the Rutherfordton alias.
    if (decoded.includes('212 ridgeway')) {
      if (decoded.includes('lake lure')) return EMPTY_HTML;
      // city-drop slug (no city word) OR alias slug (rutherfordton word)
      return htmlListing({
        zpid: 7212,
        streetAddress: '212 Ridgeway Rd',
        city: 'Rutherfordton',
        state: 'NC',
        zip: '28746',
      });
    }

    // 231 Bluebird Rd, Lake Lure NC 28746 — only resolves under the
    // space-split variant "Blue Bird".
    if (decoded.includes('231 blue bird') || decoded.includes('231 blue%20bird')) {
      return htmlListing({
        zpid: 7231,
        streetAddress: '231 Blue Bird Rd',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
    }
    if (decoded.includes('231 bluebird')) return EMPTY_HTML;

    // 181 Highland Heights, Lake Lure NC 28746 — caller input is
    // "Highland Heights" but Zillow keys it as "Highland Hts" (only
    // the abbreviated form hits).
    if (decoded.includes('181 highland hts')) {
      return htmlListing({
        zpid: 7181,
        streetAddress: '181 Highland Hts',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
    }
    if (decoded.includes('181 highland heights')) return EMPTY_HTML;

    // 255 Gateway Dr #5 — genuinely absent. NEVER returns a listing.
    if (decoded.includes('255 gateway')) return EMPTY_HTML;

    // 193 Downing Pl #36 — resolves directly.
    if (decoded.includes('193 downing')) {
      return htmlListing({
        zpid: 7193,
        streetAddress: '193 Downing Pl #36',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
    }

    return EMPTY_HTML;
  };
}

describe('real corpus (issue #81) — per-address fail-then-succeed', () => {
  it('setup', async () => {
    single = await createTestHarness((s) => registerGetByAddressTools(s, mockClient));
    bulk = await createTestHarness((s) => registerResolveAddressesTools(s, mockClient));
  });

  beforeEach(() => mockFetchHtml.mockImplementation(realisticBackend()));

  it('212 Ridgeway Rd: resolves via city-drop rung; resolved_city differs from queried', async () => {
    const r = await single.callTool('zillow_get_by_address', {
      address: '212 Ridgeway Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<{
      resolved: boolean;
      zpid?: string;
      city?: string;
      queried_city?: string;
      resolved_city?: string;
    }>(r);
    expect(parsed.resolved).toBe(true);
    expect(parsed.zpid).toBe('7212');
    expect(parsed.city).toBe('Rutherfordton');
    expect(parsed.queried_city).toBe('Lake Lure');
    expect(parsed.resolved_city).toBe('Rutherfordton');
  });

  it('231 Bluebird Rd: resolves via Blue Bird token-split (issue #76)', async () => {
    const r = await single.callTool('zillow_get_by_address', {
      address: '231 Bluebird Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<{
      resolved: boolean;
      zpid?: string;
      via?: string;
    }>(r);
    expect(parsed.resolved).toBe(true);
    expect(parsed.zpid).toBe('7231');
    expect(parsed.via).toBe('suffix_expansion');
  });

  it('181 Highland Heights: resolves via full→abbrev (Heights→Hts)', async () => {
    const r = await single.callTool('zillow_get_by_address', {
      address: '181 Highland Heights',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<{ resolved: boolean; zpid?: string }>(r);
    expect(parsed.resolved).toBe(true);
    expect(parsed.zpid).toBe('7181');
  });

  it('255 Gateway Dr #5: stays unresolved with a clean false (no wrong neighbor)', async () => {
    const r = await single.callTool('zillow_get_by_address', {
      address: '255 Gateway Dr #5',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<{ resolved: boolean; zpid?: string; error?: string }>(r);
    expect(parsed.resolved).toBe(false);
    expect(parsed.zpid).toBeUndefined();
    expect(parsed.error).toMatch(/no listing found/i);
  });

  it('193 Downing Pl: resolves on the direct rung', async () => {
    const r = await single.callTool('zillow_get_by_address', {
      address: '193 Downing Pl #36',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<{ resolved: boolean; zpid?: string; via?: string }>(r);
    expect(parsed.resolved).toBe(true);
    expect(parsed.zpid).toBe('7193');
    expect(parsed.via).toBe('direct');
  });

  it('bulk: 4/5 resolved, 1 cleanly unresolved (the Gateway absentee)', async () => {
    const r = await bulk.callTool('zillow_resolve_addresses', {
      addresses: [
        { address: '212 Ridgeway Rd', city: 'Lake Lure', state: 'NC', zip: '28746' },
        { address: '231 Bluebird Rd', city: 'Lake Lure', state: 'NC', zip: '28746' },
        { address: '181 Highland Heights', city: 'Lake Lure', state: 'NC', zip: '28746' },
        { address: '255 Gateway Dr #5', city: 'Lake Lure', state: 'NC', zip: '28746' },
        { address: '193 Downing Pl #36', city: 'Lake Lure', state: 'NC', zip: '28746' },
      ],
    });
    const parsed = parseToolResult<{
      count: number;
      results: Array<{ resolved: boolean; zpid?: string }>;
    }>(r);
    expect(parsed.count).toBe(5);
    const resolvedFlags = parsed.results.map((row) => row.resolved);
    expect(resolvedFlags).toEqual([true, true, true, false, true]);
  });
});
