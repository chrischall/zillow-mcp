import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import {
  buildAddressSlug,
  expandStreetSuffix,
  registerGetByAddressTools,
} from '../../src/tools/get-by-address.js';
import { createTestHarness, parseToolResult } from '../helpers.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

beforeEach(() => vi.clearAllMocks());

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

function htmlWithFirstListing(args: {
  zpid: number;
  detailUrl: string;
  streetAddress: string;
  city?: string;
  state?: string;
  zipcode?: string;
}): string {
  const nextData = {
    props: {
      pageProps: {
        searchPageState: {
          cat1: {
            searchResults: {
              listResults: [
                {
                  zpid: args.zpid,
                  detailUrl: args.detailUrl,
                  hdpData: {
                    homeInfo: {
                      zpid: args.zpid,
                      streetAddress: args.streetAddress,
                      city: args.city,
                      state: args.state,
                      zipcode: args.zipcode,
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

describe('expandStreetSuffix', () => {
  it('returns null when the address has no recognized suffix', () => {
    expect(expandStreetSuffix('1 Main')).toBeNull();
  });

  it('expands an abbreviated suffix into its long form (Rd -> Road)', () => {
    expect(expandStreetSuffix('268 Mallard Rd')).toBe('268 Mallard Road');
  });

  it('contracts a long suffix into its abbreviated form (Lane -> Ln)', () => {
    expect(expandStreetSuffix('12 Eagle Lane')).toBe('12 Eagle Ln');
  });

  it('handles a trailing period on an abbreviated suffix (Rd.)', () => {
    // CONSOLIDATION (realty-mcp#1): now delegates to realty-core's
    // canonical `expandSuffix`, which preserves the trailing period
    // (`Road.`) rather than stripping it as the old local impl did.
    expect(expandStreetSuffix('268 Mallard Rd.')).toBe('268 Mallard Road.');
  });

  it('preserves casing of the rest of the address', () => {
    expect(expandStreetSuffix('268 MALLARD Rd')).toBe('268 MALLARD Road');
  });

  it('only swaps the suffix when it appears at the end of the street', () => {
    // "Rd" in the middle of a name (e.g. "Roderick") shouldn't be touched.
    expect(expandStreetSuffix('100 Roderick Dr')).toBe('100 Roderick Drive');
  });
});

describe('buildAddressSlug', () => {
  it('joins the supplied fields into a single space-separated phrase', () => {
    expect(
      buildAddressSlug({
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      })
    ).toBe('126 Sleeping Bear Ln Lake Lure NC 28746');
  });

  it('skips missing optional parts', () => {
    expect(buildAddressSlug({ address: '155 Quail Cove Blvd 1601' })).toBe(
      '155 Quail Cove Blvd 1601'
    );
  });
});

describe('zillow_get_by_address tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerGetByAddressTools(server, mockClient)
    );
  });

  it('resolves an address to zpid + canonical URL via the search slug', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWithFirstListing({
        zpid: 102228838,
        detailUrl:
          '/homedetails/126-Sleeping-Bear-Ln-Lake-Lure-NC-28746/102228838_zpid/',
        streetAddress: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zipcode: '28746',
      })
    );
    const result = await harness.callTool('zillow_get_by_address', {
      address: '126 Sleeping Bear Ln',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(result.isError).toBeFalsy();
    // It must hit the /homes/<slug>_rb/ path (the bare resolve form).
    expect(mockFetchHtml.mock.calls[0][0]).toBe(
      '/homes/126%20Sleeping%20Bear%20Ln%20Lake%20Lure%20NC%2028746_rb/'
    );

    const parsed = parseToolResult<{
      resolved: boolean;
      zpid: string;
      url: string;
      street_address: string;
      city?: string;
      state?: string;
      zip?: string;
    }>(result);
    expect(parsed.resolved).toBe(true);
    expect(parsed.zpid).toBe('102228838');
    expect(parsed.url).toBe(
      'https://www.zillow.com/homedetails/126-Sleeping-Bear-Ln-Lake-Lure-NC-28746/102228838_zpid/'
    );
    expect(parsed.street_address).toBe('126 Sleeping Bear Ln');
    expect(parsed.city).toBe('Lake Lure');
    expect(parsed.state).toBe('NC');
    expect(parsed.zip).toBe('28746');
  });

  it('returns resolved=false when no listing comes back', async () => {
    mockFetchHtml.mockResolvedValue(
      '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>'
    );
    const result = await harness.callTool('zillow_get_by_address', {
      address: '999 Nowhere Ln',
      city: 'Atlantis',
      state: 'XX',
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult<{ resolved: boolean; error?: string }>(
      result
    );
    expect(parsed.resolved).toBe(false);
    expect(parsed.error).toMatch(/no listing found/i);
  });

  it('returns resolved=false when the page has no searchPageState at all', async () => {
    mockFetchHtml.mockResolvedValue('<html>nothing</html>');
    const result = await harness.callTool('zillow_get_by_address', {
      address: '999 Nowhere Ln',
    });
    const parsed = parseToolResult<{ resolved: boolean }>(result);
    expect(parsed.resolved).toBe(false);
  });

  it('errors when address is missing', async () => {
    const result = await harness.callTool('zillow_get_by_address', {});
    expect(result.isError).toBeTruthy();
  });

  it('returns resolved=false when the first listing has no zpid', async () => {
    // formatListing() returns null when neither hdpData.homeInfo.zpid nor the
    // top-level zpid is present. With the issue #51/#52 fallback ladder,
    // a no-zpid result is treated the same as "no listing" (we go on to
    // try the next rung) — when no rungs are applicable, the final
    // error string is the generic one.
    const nextData = {
      props: {
        pageProps: {
          searchPageState: {
            cat1: {
              searchResults: {
                listResults: [
                  { detailUrl: '/homedetails/foo/', hdpData: { homeInfo: {} } },
                ],
              },
            },
          },
        },
      },
    };
    mockFetchHtml.mockResolvedValue(
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
        nextData
      )}</script>`
    );
    const result = await harness.callTool('zillow_get_by_address', {
      address: '1 Main St',
    });
    const parsed = parseToolResult<{ resolved: boolean; error?: string }>(
      result
    );
    expect(parsed.resolved).toBe(false);
    expect(parsed.error).toMatch(/no listing found/i);
  });

  it('returns resolved=false when Zillow silently falls back to a different region', async () => {
    // Vague input like "Main St" can trigger Zillow's silent fallback to the
    // user's default region. Guard against returning a wrong-location zpid.
    mockFetchHtml.mockResolvedValue(
      htmlWithFirstListing({
        zpid: 99999,
        detailUrl: '/homedetails/1-Brooklyn-Way/99999_zpid/',
        streetAddress: '1 Brooklyn Way',
        city: 'Brooklyn',
        state: 'NY',
        zipcode: '11215',
      })
    );
    const result = await harness.callTool('zillow_get_by_address', {
      address: 'Sleeping Bear Ln Lake Lure',
    });
    const parsed = parseToolResult<{ resolved: boolean; error?: string }>(
      result
    );
    expect(parsed.resolved).toBe(false);
    expect(parsed.error).toMatch(/no listing found/i);
  });

  it('retries with the expanded suffix when the abbreviated form misses (issue #51)', async () => {
    // First call (abbreviated "Rd") returns no listing; second call
    // (expanded "Road") finds the property.
    let call = 0;
    mockFetchHtml.mockImplementation(async () => {
      call++;
      if (call === 1) {
        // Empty list results — Zillow couldn't resolve the abbreviated form.
        return '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>';
      }
      return htmlWithFirstListing({
        zpid: 50_000,
        detailUrl: '/homedetails/268-Mallard-Road-Lake-Lure-NC-28746/50000_zpid/',
        streetAddress: '268 Mallard Road',
        city: 'Lake Lure',
        state: 'NC',
        zipcode: '28746',
      });
    });
    const result = await harness.callTool('zillow_get_by_address', {
      address: '268 Mallard Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<{ resolved: boolean; zpid?: string }>(result);
    expect(parsed.resolved).toBe(true);
    expect(parsed.zpid).toBe('50000');
    // Confirm we actually retried with the expansion.
    expect(call).toBe(2);
  });

  it('retries with the abbreviated form when the expanded one misses', async () => {
    let call = 0;
    mockFetchHtml.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>';
      }
      return htmlWithFirstListing({
        zpid: 60_000,
        detailUrl: '/homedetails/foo/60000_zpid/',
        streetAddress: '12 Eagle Ln',
        city: 'Lake Lure',
        state: 'NC',
      });
    });
    const result = await harness.callTool('zillow_get_by_address', {
      address: '12 Eagle Lane',
      city: 'Lake Lure',
      state: 'NC',
    });
    const parsed = parseToolResult<{ resolved: boolean; zpid?: string }>(result);
    expect(parsed.resolved).toBe(true);
    expect(parsed.zpid).toBe('60000');
  });

  it('suffix/variant rung: city-matching listing hits at the 3rd direct call', async () => {
    // First two calls (direct + first street variant) return nothing; the
    // third call returns the listing.
    //
    // CONSOLIDATION (realty-mcp#1): rung 3 now uses realty-core's
    // canonical `buildVariants`, whose variant set is intentionally
    // BROADER than the old local one (e.g. `142 Hidden Cove Ln` also
    // yields greedy compound splits like `142 Hid Den Cove Ln`). The
    // listing therefore resolves via the `suffix_expansion` rung at the
    // 3rd call — BEFORE the ladder reaches locality-remap — where the old
    // narrower variant set fell through to `locality_remap`. The result
    // is unchanged (resolved zpid 70000 in the matching city); only the
    // winning rung (`via`) moved earlier.
    let call = 0;
    mockFetchHtml.mockImplementation(async () => {
      call++;
      if (call <= 2) {
        return '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>';
      }
      // The rung-3 direct fetch returns a listing in the matching city + a token from the address.
      return htmlWithFirstListing({
        zpid: 70_000,
        detailUrl: '/homedetails/foo/70000_zpid/',
        streetAddress: '142 Hidden Cove Ln',
        city: 'Lake Lure',
        state: 'NC',
        zipcode: '28746',
      });
    });
    const result = await harness.callTool('zillow_get_by_address', {
      address: '142 Hidden Cove Ln',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<{
      resolved: boolean;
      zpid?: string;
      via?: string;
    }>(result);
    expect(parsed.resolved).toBe(true);
    expect(parsed.zpid).toBe('70000');
    expect(parsed.via).toBe('suffix_expansion');
    // direct + first variant (empty) + second variant (hit) = 3 calls
    expect(call).toBe(3);
  });

  it('search fallback: takes the region branch + filtered call when scope resolve returns a pinned region', async () => {
    // Triggers the `kind === 'region'` path of searchFallback: rung 4's
    // resolveLocationOrListings gets a page with `regionSelection` +
    // `mapBounds` and no listResults, forcing a follow-up request — the
    // filtered search pinned to that region — which finally yields the
    // listing. The mock uses path-based matching so the rung-3 locality
    // remap (city-drop + alias) misses cleanly and we actually reach the
    // rung-4 search fallback.
    const EMPTY =
      '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>';
    const regionHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
      {
        props: {
          pageProps: {
            searchPageState: {
              queryState: {
                regionSelection: [{ regionId: 41568, regionType: 6 }],
                mapBounds: {
                  north: 35.55,
                  south: 35.4,
                  east: -82.05,
                  west: -82.25,
                },
              },
              cat1: { searchResults: { listResults: [] } },
            },
          },
        },
      }
    )}</script>`;
    let call = 0;
    mockFetchHtml.mockImplementation(async (path: string) => {
      call++;
      const decoded = decodeURIComponent(path).toLowerCase();
      // The rung-4 scope resolve is the bare city/state slug (no
      // street component) — that's our region-pinning call.
      if (
        !decoded.includes('99 hidden cove') &&
        decoded.includes('lake lure') &&
        !decoded.includes('searchqueryst')
      ) {
        return regionHtml;
      }
      // The filtered search carries a searchQueryState query string.
      if (decoded.includes('searchqueryst')) {
        return htmlWithFirstListing({
          zpid: 75_000,
          detailUrl: '/homedetails/foo/75000_zpid/',
          streetAddress: '99 Hidden Cove Ln',
          city: 'Lake Lure',
          state: 'NC',
          zipcode: '28746',
        });
      }
      // All direct + suffix-expansion + locality-remap (city-drop +
      // alias) attempts miss.
      return EMPTY;
    });
    const result = await harness.callTool('zillow_get_by_address', {
      address: '99 Hidden Cove Ln',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
      price_min: 400_000,
      price_max: 900_000,
    });
    const parsed = parseToolResult<{
      resolved: boolean;
      zpid?: string;
      via?: string;
    }>(result);
    expect(parsed.resolved).toBe(true);
    expect(parsed.zpid).toBe('75000');
    expect(parsed.via).toBe('search_fallback');
    // direct + expansion + (city-drop + alias for locality_remap) +
    // scope-resolve + filtered-search — at least the scope-resolve and
    // filtered-search calls must have fired.
    expect(call).toBeGreaterThanOrEqual(4);
  });

  it('still returns resolved=false when ALL retries fail', async () => {
    mockFetchHtml.mockResolvedValue(
      '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>'
    );
    const result = await harness.callTool('zillow_get_by_address', {
      address: '1 Nowhere Ln',
      city: 'Atlantis',
      state: 'XX',
    });
    const parsed = parseToolResult<{ resolved: boolean }>(result);
    expect(parsed.resolved).toBe(false);
  });

  it('search fallback: refuses to match when the address has zero discriminating tokens (round-3 nit)', async () => {
    // Pathological input: `"1 St"` tokenizes to a single numeric token
    // (`["1"]` after realty-core's `tokenize` keeps the leading number and
    // drops the sub-3-char `st`), so after the >=3-char discriminating
    // filter `inputTokens.length === 0`. Without an early guard,
    // searchFallback returns `listings[0]` unchecked — silently
    // mis-resolving free-text like `"1 St, Lake Lure, NC"` to whatever
    // Zillow returns first. The strict `every`-token guard must be the
    // single source of truth, so searchFallback must NOT accept the first
    // listing here.
    //
    // CONSOLIDATION (realty-mcp#1): the canonical `buildVariants` is
    // broader, so the street-variant direct rungs make several
    // street-bearing calls before the ladder reaches the city-scoped
    // search fallback. The mock is path-aware: it returns NOTHING for any
    // street-bearing slug (begins with the house number `1`) and surfaces
    // the unrelated listing ONLY on the city-scoped fallback search — so
    // this test still exercises searchFallback's zero-token guard, which
    // remains the contract.
    mockFetchHtml.mockImplementation(async (path: string) => {
      const empty =
        '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>';
      // Street-bearing slug (direct + variant rungs) → no hit.
      if (/\/homes\/1(%20|\+|\s)/.test(path)) return empty;
      // City-scoped fallback search → an unrelated listing the
      // zero-token guard must refuse.
      return htmlWithFirstListing({
        zpid: 99999,
        detailUrl: '/homedetails/totally-unrelated/99999_zpid/',
        streetAddress: '4242 Totally Unrelated Way',
        city: 'Lake Lure',
        state: 'NC',
        zipcode: '28746',
      });
    });
    const result = await harness.callTool('zillow_get_by_address', {
      address: '1 St',
      city: 'Lake Lure',
      state: 'NC',
    });
    const parsed = parseToolResult<{ resolved: boolean; zpid?: string }>(
      result
    );
    expect(parsed.resolved).toBe(false);
    expect(parsed.zpid).toBeUndefined();
  });

  it('builds an absolute URL when detailUrl is missing — falls back to zpid path', async () => {
    // Some responses include zpid but no detailUrl. We still want a
    // canonical URL on the way out.
    const nextData = {
      props: {
        pageProps: {
          searchPageState: {
            cat1: {
              searchResults: {
                listResults: [
                  {
                    zpid: 12345,
                    hdpData: {
                      homeInfo: {
                        zpid: 12345,
                        streetAddress: '1 Main St',
                        city: 'Brooklyn',
                        state: 'NY',
                        zipcode: '11215',
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
    mockFetchHtml.mockResolvedValue(
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
        nextData
      )}</script>`
    );
    const result = await harness.callTool('zillow_get_by_address', {
      address: '1 Main St',
      city: 'Brooklyn',
      state: 'NY',
      zip: '11215',
    });
    const parsed = parseToolResult<{ zpid: string; url: string }>(result);
    expect(parsed.zpid).toBe('12345');
    expect(parsed.url).toBe(
      'https://www.zillow.com/homedetails/12345_zpid/'
    );
  });

  describe('tool description honesty (issue #80)', () => {
    // Description must surface the load-bearing-ness of the price band
    // for rural / locality-mismatched addresses (search-fallback rung is
    // often the ONLY rung that hits), and the resolved_city / queried_city
    // remap signal from issue #75 — including the real-world mountain-MLS
    // cohort cases the field exists for.
    async function getDescription(): Promise<string> {
      const server = new McpServer({ name: 't', version: '0.0.0' });
      registerGetByAddressTools(server, mockClient);
      const client = new Client({ name: 'tc', version: '0.0.0' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      const { tools } = await client.listTools();
      await client.close();
      await server.close();
      const t = tools.find((t) => t.name === 'zillow_get_by_address');
      if (!t) throw new Error('tool missing');
      return t.description ?? '';
    }

    it('flags the price band as load-bearing for rural / locality-mismatched addresses', async () => {
      const d = await getDescription();
      expect(d).toMatch(/load-bearing/i);
      expect(d).toMatch(/rural|mountain-MLS/i);
      expect(d).toMatch(/price_min/);
      expect(d).toMatch(/price_max/);
    });

    it('documents the locality-remap rung and queried_city / resolved_city fields', async () => {
      const d = await getDescription();
      expect(d).toMatch(/locality[ _-]remap/i);
      expect(d).toMatch(/queried_city/);
      expect(d).toMatch(/resolved_city/);
    });

    it("cites the cohort's mountain-MLS remap cases (Lake Lure / Beech / Sugar Mountain / Banner Elk)", async () => {
      const d = await getDescription();
      expect(d).toMatch(/Lake Lure/);
      expect(d).toMatch(/Banner Elk/);
    });
  });
});
