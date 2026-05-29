import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import {
  LocationNotResolved,
  buildSearchPath,
  buildSearchQueryState,
  formatListing,
  listingsMatchLocation,
  locationTokens,
  registerSearchTools,
  resolveLocation,
  type RawListing,
} from '../../src/tools/search.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

/** Build a full SSR page response — used by both resolve + filter steps. */
function htmlWithState(args: {
  regionSelection?: Array<{ regionId: number; regionType: number }>;
  mapBounds?: { north: number; south: number; east: number; west: number };
  listResults?: RawListing[];
  noSearchPageState?: boolean;
}): string {
  const sps: Record<string, unknown> = {};
  if (!args.noSearchPageState) {
    sps.queryState = {
      regionSelection: args.regionSelection,
      mapBounds: args.mapBounds,
    };
    sps.cat1 = { searchResults: { listResults: args.listResults ?? [] } };
  }
  const nextData = {
    props: {
      pageProps: args.noSearchPageState ? {} : { searchPageState: sps },
    },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData
  )}</script>`;
}

/**
 * Build a Lake Lure listing — used wherever we want a result that
 * matches the "Lake Lure, NC 28746" input.
 */
function lakeLureListing(zpid: number): RawListing {
  return {
    hdpData: {
      homeInfo: {
        zpid,
        streetAddress: `${zpid} Wambli Pass`,
        city: 'Lake Lure',
        state: 'NC',
        zipcode: '28746',
      },
    },
  };
}

/** A Brooklyn listing — the canonical "wrong region" fallback. */
function brooklynListing(zpid: number): RawListing {
  return {
    hdpData: {
      homeInfo: {
        zpid,
        streetAddress: `${zpid} 86th St`,
        city: 'Brooklyn',
        state: 'NY',
        zipcode: '11214',
      },
    },
  };
}

describe('locationTokens', () => {
  it('splits on non-alphanumerics, drops short tokens, lowercases', () => {
    // CONSOLIDATION (realty-mcp#1): now delegates to realty-core's
    // canonical `tokenize`, which drops sub-3-char tokens (here the
    // 2-letter state code `nc`) EXCEPT a leading numeric. This is
    // intentionally broader/cleaner than the old `length >= 2` filter —
    // and behavior-preserving for `listingsMatchLocation`, which already
    // excluded state codes from its match set.
    expect(locationTokens('Lake Lure, NC 28746')).toEqual([
      'lake',
      'lure',
      '28746',
    ]);
  });
});

describe('listingsMatchLocation', () => {
  it('returns true when any listing address contains a non-state input token', () => {
    expect(
      listingsMatchLocation(
        [lakeLureListing(1)],
        locationTokens('Lake Lure, NC 28746')
      )
    ).toBe(true);
  });

  it('returns false on Brooklyn fallback for a Lake Lure query', () => {
    // Brooklyn results share only the state-code "ny" with the input's
    // discriminating tokens — and state codes are excluded from the
    // match set on purpose.
    expect(
      listingsMatchLocation(
        [brooklynListing(1), brooklynListing(2), brooklynListing(3)],
        locationTokens('Lake Lure, NC 28746')
      )
    ).toBe(false);
  });

  it('returns true when the only token is a state and the listing is in that state', () => {
    // No discriminating tokens after dropping the state — return true
    // (we don't have evidence of a mismatch).
    expect(listingsMatchLocation([brooklynListing(1)], ['ny'])).toBe(true);
  });
});

describe('buildSearchQueryState', () => {
  it('puts the location into usersSearchTerm', () => {
    const sqs = buildSearchQueryState({ location: 'Brooklyn, NY' });
    expect(sqs.usersSearchTerm).toBe('Brooklyn, NY');
  });

  it('pins regionSelection + mapBounds when a region is provided', () => {
    const sqs = buildSearchQueryState(
      { location: 'Lake Lure, NC' },
      {
        regionSelection: [{ regionId: 70190, regionType: 7 }],
        mapBounds: { north: 36, south: 35, east: -82, west: -82.5 },
      }
    );
    expect(sqs.regionSelection).toEqual([{ regionId: 70190, regionType: 7 }]);
    expect(sqs.mapBounds).toBeDefined();
  });

  it('omits regionSelection/mapBounds when no region is provided', () => {
    const sqs = buildSearchQueryState({ location: 'x' });
    expect(sqs.regionSelection).toBeUndefined();
    expect(sqs.mapBounds).toBeUndefined();
  });

  it('encodes price filters', () => {
    const sqs = buildSearchQueryState({
      location: 'x',
      price_min: 500_000,
      price_max: 1_000_000,
    });
    expect((sqs.filterState as Record<string, unknown>).price).toEqual({
      min: 500_000,
      max: 1_000_000,
    });
  });

  it('encodes beds/baths minimums', () => {
    const sqs = buildSearchQueryState({
      location: 'x',
      beds_min: 3,
      baths_min: 2,
    });
    const fs = sqs.filterState as Record<string, unknown>;
    expect(fs.beds).toEqual({ min: 3 });
    expect(fs.baths).toEqual({ min: 2 });
  });

  it('translates home_types into the right boolean filter keys', () => {
    const sqs = buildSearchQueryState({
      location: 'x',
      home_types: ['condo', 'townhouse'],
    });
    const fs = sqs.filterState as Record<string, unknown>;
    expect(fs.isCondo).toEqual({ value: true });
    expect(fs.isTownhouse).toEqual({ value: true });
    expect(fs.isSingleFamily).toBeUndefined();
  });

  it('flips the right filters for status=for_rent', () => {
    const sqs = buildSearchQueryState({ location: 'x', status: 'for_rent' });
    const fs = sqs.filterState as Record<string, unknown>;
    expect(fs.isForRent).toEqual({ value: true });
    expect(fs.isForSaleByAgent).toEqual({ value: false });
  });

  it('flips the right filters for status=sold', () => {
    const sqs = buildSearchQueryState({ location: 'x', status: 'sold' });
    const fs = sqs.filterState as Record<string, unknown>;
    expect(fs.isRecentlySold).toEqual({ value: true });
  });
});

describe('buildSearchPath', () => {
  it('builds the bare /homes/<slug>_rb/ path when no sqs is given', () => {
    expect(buildSearchPath('Brooklyn, NY')).toBe('/homes/Brooklyn%2C%20NY_rb/');
  });

  it('appends searchQueryState when sqs is provided', () => {
    const path = buildSearchPath('Brooklyn, NY', { foo: 1 });
    expect(path).toMatch(/^\/homes\/Brooklyn%2C%20NY_rb\/\?searchQueryState=/);
    const sqsRaw = path.split('searchQueryState=')[1]!;
    expect(JSON.parse(decodeURIComponent(sqsRaw))).toEqual({ foo: 1 });
  });

  it('trims whitespace from the location slug', () => {
    expect(buildSearchPath('  Brooklyn  ')).toBe('/homes/Brooklyn_rb/');
  });
});

describe('formatListing', () => {
  it('extracts the canonical fields from hdpData.homeInfo', () => {
    const formatted = formatListing({
      hdpData: {
        homeInfo: {
          zpid: 99999,
          streetAddress: '123 Main St',
          city: 'Brooklyn',
          state: 'NY',
          zipcode: '11215',
          price: 1_250_000,
          bedrooms: 3,
          bathrooms: 2,
          livingArea: 1450,
          homeType: 'SINGLE_FAMILY',
          homeStatus: 'FOR_SALE',
          latitude: 40.6,
          longitude: -74.0,
          zestimate: 1_300_000,
          rentZestimate: 5_500,
        },
      },
      detailUrl: '/homedetails/123-main-st/99999_zpid/',
      imgSrc: 'https://photos.zillowstatic.com/x.jpg',
    });
    expect(formatted).toMatchObject({
      zpid: '99999',
      price: 1_250_000,
      beds: 3,
      baths: 2,
      living_area: 1450,
      home_type: 'SINGLE_FAMILY',
      status: 'FOR_SALE',
      zestimate: 1_300_000,
      rent_zestimate: 5_500,
      url: 'https://www.zillow.com/homedetails/123-main-st/99999_zpid/',
    });
  });

  it('returns null when zpid is missing entirely', () => {
    expect(formatListing({} as RawListing)).toBeNull();
  });

  it('preserves absolute detailUrl', () => {
    const f = formatListing({
      zpid: 7,
      detailUrl: 'https://www.zillow.com/homedetails/x/7_zpid/',
    });
    expect(f?.url).toBe('https://www.zillow.com/homedetails/x/7_zpid/');
  });
});

describe('resolveLocation', () => {
  const VALID_REGION = {
    regionSelection: [{ regionId: 70190, regionType: 7 }],
    mapBounds: { north: 36, south: 35, east: -82, west: -82.5 },
  };

  it('returns regionSelection + mapBounds when the geocoder pins a region', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({
        regionSelection: VALID_REGION.regionSelection,
        mapBounds: VALID_REGION.mapBounds,
        listResults: [lakeLureListing(1), lakeLureListing(2)],
      })
    );
    const region = await resolveLocation(mockClient, 'Lake Lure, NC 28746');
    expect(region.regionSelection).toEqual(VALID_REGION.regionSelection);
    expect(region.mapBounds).toEqual(VALID_REGION.mapBounds);
  });

  it('throws LocationNotResolved when regionSelection is empty', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({ regionSelection: [], listResults: [] })
    );
    await expect(
      resolveLocation(mockClient, 'asdfghjkl')
    ).rejects.toBeInstanceOf(LocationNotResolved);
  });

  it('throws LocationNotResolved when Zillow silently falls back to a different region', async () => {
    // The classic Brooklyn-fallback case: Zillow pinned a region, but the
    // returned listings are nowhere near the query.
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({
        regionSelection: [{ regionId: 37607, regionType: 17 }], // Brooklyn
        mapBounds: { north: 40.8, south: 40.5, east: -73.8, west: -74.0 },
        listResults: [brooklynListing(1), brooklynListing(2), brooklynListing(3)],
      })
    );
    await expect(
      resolveLocation(mockClient, 'Lake Lure, NC 28746')
    ).rejects.toThrow(/silently fell back to Brooklyn/);
  });

  it('accepts a valid resolution that returns zero listings (rural ZIP with no inventory)', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({
        regionSelection: VALID_REGION.regionSelection,
        mapBounds: VALID_REGION.mapBounds,
        listResults: [],
      })
    );
    await expect(
      resolveLocation(mockClient, 'Lake Lure, NC 28746')
    ).resolves.toBeDefined();
  });

  it('throws when the page has no searchPageState at all', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({ noSearchPageState: true })
    );
    await expect(
      resolveLocation(mockClient, 'x')
    ).rejects.toBeInstanceOf(LocationNotResolved);
  });
});

describe('zillow_search_properties tool (two-step resolve + filter)', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerSearchTools(server, mockClient)
    );
  });

  const VALID_REGION = {
    regionSelection: [{ regionId: 70190, regionType: 7 }],
    mapBounds: { north: 36, south: 35, east: -82, west: -82.5 },
  };

  it('resolves location first (bare URL), then refetches with region pinned + filters', async () => {
    // Step 1: resolve — no qs in URL
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({
        regionSelection: VALID_REGION.regionSelection,
        mapBounds: VALID_REGION.mapBounds,
        listResults: [lakeLureListing(1)],
      })
    );
    // Step 2: filtered — qs with regionSelection + filters
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({
        regionSelection: VALID_REGION.regionSelection,
        mapBounds: VALID_REGION.mapBounds,
        listResults: [lakeLureListing(1), lakeLureListing(2)],
      })
    );
    const result = await harness.callTool('zillow_search_properties', {
      location: 'Lake Lure, NC 28746',
      beds_min: 3,
      price_min: 500_000,
      price_max: 1_100_000,
    });
    expect(result.isError).toBeFalsy();
    expect(mockFetchHtml).toHaveBeenCalledTimes(2);
    // Step 1 path: bare
    expect(mockFetchHtml.mock.calls[0][0]).toBe(
      '/homes/Lake%20Lure%2C%20NC%2028746_rb/'
    );
    // Step 2 path: with sqs that pins regionSelection
    const step2Path = mockFetchHtml.mock.calls[1][0] as string;
    expect(step2Path).toMatch(/searchQueryState=/);
    const sqs = JSON.parse(decodeURIComponent(step2Path.split('searchQueryState=')[1]!));
    expect(sqs.regionSelection).toEqual(VALID_REGION.regionSelection);
    expect(sqs.mapBounds).toEqual(VALID_REGION.mapBounds);
    expect(sqs.filterState.price).toEqual({ min: 500_000, max: 1_100_000 });
    expect(sqs.filterState.beds).toEqual({ min: 3 });

    const parsed = parseToolResult<Array<{ zpid: string }>>(result);
    expect(parsed.map((p) => p.zpid)).toEqual(['1', '2']);
  });

  it('throws LocationNotResolved when the resolve step detects a silent fallback', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({
        regionSelection: [{ regionId: 37607, regionType: 17 }],
        mapBounds: { north: 40.8, south: 40.5, east: -73.8, west: -74.0 },
        listResults: [brooklynListing(1), brooklynListing(2), brooklynListing(3)],
      })
    );
    const result = await harness.callTool('zillow_search_properties', {
      location: 'Lake Lure, NC 28746',
    });
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/could not resolve location.*Lake Lure/i);
    expect(text).toMatch(/silently fell back/i);
    // Only the resolve fetch fired — we bailed before step 2.
    expect(mockFetchHtml).toHaveBeenCalledTimes(1);
  });

  it('respects limit on step 2 results', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({
        regionSelection: VALID_REGION.regionSelection,
        mapBounds: VALID_REGION.mapBounds,
        listResults: [lakeLureListing(1)],
      })
    );
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({
        regionSelection: VALID_REGION.regionSelection,
        mapBounds: VALID_REGION.mapBounds,
        listResults: Array.from({ length: 10 }, (_, i) => lakeLureListing(i + 1)),
      })
    );
    const result = await harness.callTool('zillow_search_properties', {
      location: 'Lake Lure, NC',
      limit: 3,
    });
    const parsed = parseToolResult<unknown[]>(result);
    expect(parsed).toHaveLength(3);
  });

  it('returns [] when the filter step legitimately has no matches in a resolved region', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({
        regionSelection: VALID_REGION.regionSelection,
        mapBounds: VALID_REGION.mapBounds,
        listResults: [lakeLureListing(1)],
      })
    );
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({
        regionSelection: VALID_REGION.regionSelection,
        mapBounds: VALID_REGION.mapBounds,
        listResults: [],
      })
    );
    const result = await harness.callTool('zillow_search_properties', {
      location: 'Lake Lure, NC',
      price_max: 1,
    });
    const parsed = parseToolResult<unknown[]>(result);
    expect(parsed).toEqual([]);
  });

  it('returns matched listings when Zillow returns no region but does return matching listings (full address) — issue #31', async () => {
    // Address-style query: Zillow's resolver doesn't pin a region (no
    // city- or ZIP-level handle for a single property), but it DOES
    // populate the matching listing in listResults. Surface it without
    // a second filter round-trip. The user passed "155 Quail Cove Blvd
    // 1601 Lake Lure NC".
    const matchingListing: RawListing = {
      hdpData: {
        homeInfo: {
          zpid: 200,
          streetAddress: '155 Quail Cove Blvd #1601',
          city: 'Lake Lure',
          state: 'NC',
          zipcode: '28746',
        },
      },
    };
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({
        regionSelection: [],
        mapBounds: undefined,
        listResults: [matchingListing],
      })
    );
    const result = await harness.callTool('zillow_search_properties', {
      location: '155 Quail Cove Blvd 1601 Lake Lure NC',
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult<Array<{ zpid: string; city?: string }>>(result);
    expect(parsed.map((p) => p.zpid)).toEqual(['200']);
    expect(parsed[0].city).toBe('Lake Lure');
    // Single round-trip — no filter step is possible without a region.
    expect(mockFetchHtml).toHaveBeenCalledTimes(1);
  });

  it('returns matched listings for a street-only neighborhood query (issue #31)', async () => {
    // "Quail Cove Blvd Lake Lure NC" — no region pin, but the street
    // does match listings Zillow returns under it.
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({
        regionSelection: [],
        listResults: [
          {
            hdpData: {
              homeInfo: {
                zpid: 300,
                streetAddress: '101 Quail Cove Blvd',
                city: 'Lake Lure',
                state: 'NC',
                zipcode: '28746',
              },
            },
          },
          {
            hdpData: {
              homeInfo: {
                zpid: 301,
                streetAddress: '102 Quail Cove Blvd',
                city: 'Lake Lure',
                state: 'NC',
                zipcode: '28746',
              },
            },
          },
        ],
      })
    );
    const result = await harness.callTool('zillow_search_properties', {
      location: 'Quail Cove Blvd Lake Lure NC',
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult<Array<{ zpid: string }>>(result);
    expect(parsed.map((p) => p.zpid)).toEqual(['300', '301']);
  });

  it('still throws LocationNotResolved when no region AND no listings come back', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({
        regionSelection: [],
        listResults: [],
      })
    );
    const result = await harness.callTool('zillow_search_properties', {
      location: 'asdfghjkl no such place',
    });
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/could not resolve location/i);
  });

  it('still throws when no region AND listings do NOT match (silent fallback w/ no region)', async () => {
    // Defensive: even though no region was pinned, Zillow returned
    // unrelated listings. Don't surface them as the user's match.
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({
        regionSelection: [],
        listResults: [brooklynListing(1), brooklynListing(2)],
      })
    );
    const result = await harness.callTool('zillow_search_properties', {
      location: '155 Quail Cove Blvd Lake Lure NC',
    });
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/could not resolve location/i);
  });

  it('auto-paginates server-side when the requested limit exceeds one Zillow page (issue #54)', async () => {
    // Resolve the region, then receive 3 listings on page 1, 3 on page 2,
    // 0 on page 3 (the terminator). The tool should aggregate them and
    // return all 6 — not silently cap at the per-page count.
    const region = {
      regionSelection: [{ regionId: 70190, regionType: 7 }],
      mapBounds: { north: 36, south: 35, east: -82, west: -82.5 },
    };
    const pages: RawListing[][] = [
      [lakeLureListing(1), lakeLureListing(2), lakeLureListing(3)],
      [lakeLureListing(4), lakeLureListing(5), lakeLureListing(6)],
      [],
    ];
    let filterCall = 0;
    mockFetchHtml.mockImplementation(async (path: string) => {
      if (!path.includes('searchQueryState=')) {
        // Resolve step
        return htmlWithState({
          ...region,
          listResults: [lakeLureListing(1)],
        });
      }
      // Filter step — paginated. Read pagination.currentPage from the sqs.
      const sqsRaw = path.split('searchQueryState=')[1]!;
      const sqs = JSON.parse(decodeURIComponent(sqsRaw)) as Record<
        string,
        unknown
      >;
      const page =
        (sqs.pagination as { currentPage?: number } | undefined)?.currentPage ?? 1;
      filterCall++;
      return htmlWithState({
        ...region,
        listResults: pages[page - 1] ?? [],
      });
    });
    const r = await harness.callTool('zillow_search_properties', {
      location: 'Lake Lure, NC 28746',
      limit: 200,
    });
    const parsed = parseToolResult<unknown[]>(r);
    expect(parsed).toHaveLength(6);
    // Three filter calls: page 1 (3), page 2 (3), page 3 (0 → stop).
    expect(filterCall).toBe(3);
  });

  it('stops paginating once the cumulative count hits the limit (issue #54)', async () => {
    const region = {
      regionSelection: [{ regionId: 70190, regionType: 7 }],
      mapBounds: { north: 36, south: 35, east: -82, west: -82.5 },
    };
    let filterCall = 0;
    mockFetchHtml.mockImplementation(async (path: string) => {
      if (!path.includes('searchQueryState=')) {
        return htmlWithState({
          ...region,
          listResults: [lakeLureListing(1)],
        });
      }
      filterCall++;
      // 40 per page; caller asked for 50 — should stop after 2 pages
      // (page 1 + part of page 2 = 50 total).
      const listings = Array.from({ length: 40 }, (_, i) =>
        lakeLureListing(filterCall * 1000 + i)
      );
      return htmlWithState({ ...region, listResults: listings });
    });
    const r = await harness.callTool('zillow_search_properties', {
      location: 'Lake Lure, NC 28746',
      limit: 50,
    });
    const parsed = parseToolResult<unknown[]>(r);
    expect(parsed).toHaveLength(50);
    expect(filterCall).toBe(2);
  });

  it('opts out of pagination when auto_paginate: false (issue #54)', async () => {
    const region = {
      regionSelection: [{ regionId: 70190, regionType: 7 }],
      mapBounds: { north: 36, south: 35, east: -82, west: -82.5 },
    };
    let filterCall = 0;
    mockFetchHtml.mockImplementation(async (path: string) => {
      if (!path.includes('searchQueryState=')) {
        return htmlWithState({
          ...region,
          listResults: [lakeLureListing(1)],
        });
      }
      filterCall++;
      return htmlWithState({
        ...region,
        listResults: [lakeLureListing(1), lakeLureListing(2)],
      });
    });
    const r = await harness.callTool('zillow_search_properties', {
      location: 'Lake Lure, NC 28746',
      limit: 200,
      auto_paginate: false,
    });
    const parsed = parseToolResult<unknown[]>(r);
    expect(parsed).toHaveLength(2);
    expect(filterCall).toBe(1); // exactly one filter call
  });

  it('respects the limit param on the address-path result', async () => {
    const lots = Array.from({ length: 10 }, (_, i) =>
      ({
        hdpData: {
          homeInfo: {
            zpid: 500 + i,
            streetAddress: `${i} Quail Cove Blvd`,
            city: 'Lake Lure',
            state: 'NC',
            zipcode: '28746',
          },
        },
      } as RawListing)
    );
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithState({ regionSelection: [], listResults: lots })
    );
    const result = await harness.callTool('zillow_search_properties', {
      location: 'Quail Cove Blvd Lake Lure NC',
      limit: 3,
    });
    const parsed = parseToolResult<unknown[]>(result);
    expect(parsed).toHaveLength(3);
  });
});
