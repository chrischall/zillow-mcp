import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import {
  buildSearchBody,
  formatListing,
  registerSearchTools,
  type RawListing,
} from '../../src/tools/search.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchJson = vi.fn();
const mockClient = { fetchJson: mockFetchJson } as unknown as ZillowClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('buildSearchBody', () => {
  it('puts the location into searchQueryState.usersSearchTerm', () => {
    const body = buildSearchBody({ location: 'Brooklyn, NY' });
    expect(
      (body.searchQueryState as { usersSearchTerm: string }).usersSearchTerm
    ).toBe('Brooklyn, NY');
  });

  it('encodes price filters', () => {
    const body = buildSearchBody({
      location: 'x',
      price_min: 500_000,
      price_max: 1_000_000,
    });
    const filterState = (
      body.searchQueryState as { filterState: Record<string, unknown> }
    ).filterState;
    expect(filterState.price).toEqual({ min: 500_000, max: 1_000_000 });
  });

  it('encodes beds/baths minimums', () => {
    const body = buildSearchBody({ location: 'x', beds_min: 3, baths_min: 2 });
    const filterState = (
      body.searchQueryState as { filterState: Record<string, unknown> }
    ).filterState;
    expect(filterState.beds).toEqual({ min: 3 });
    expect(filterState.baths).toEqual({ min: 2 });
  });

  it('translates home_types into the right boolean filter keys', () => {
    const body = buildSearchBody({
      location: 'x',
      home_types: ['condo', 'townhouse'],
    });
    const filterState = (
      body.searchQueryState as { filterState: Record<string, unknown> }
    ).filterState;
    expect(filterState.isCondo).toEqual({ value: true });
    expect(filterState.isTownhouse).toEqual({ value: true });
    expect(filterState.isSingleFamily).toBeUndefined();
  });

  it('flips the right filters for status=for_rent', () => {
    const body = buildSearchBody({ location: 'x', status: 'for_rent' });
    const filterState = (
      body.searchQueryState as { filterState: Record<string, unknown> }
    ).filterState;
    expect(filterState.isForRent).toEqual({ value: true });
    expect(filterState.isForSaleByAgent).toEqual({ value: false });
  });

  it('flips the right filters for status=sold', () => {
    const body = buildSearchBody({ location: 'x', status: 'sold' });
    const filterState = (
      body.searchQueryState as { filterState: Record<string, unknown> }
    ).filterState;
    expect(filterState.isRecentlySold).toEqual({ value: true });
  });
});

describe('formatListing', () => {
  it('extracts the canonical fields from hdpData.homeInfo', () => {
    const raw: RawListing = {
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
    };
    const formatted = formatListing(raw);
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

  it('falls back to top-level fields when hdpData is absent', () => {
    const raw: RawListing = {
      zpid: 42,
      address: '1 First Ave',
      beds: 1,
      baths: 1,
      unformattedPrice: 500_000,
    };
    const formatted = formatListing(raw);
    expect(formatted?.zpid).toBe('42');
    expect(formatted?.price).toBe(500_000);
    expect(formatted?.url).toBe('https://www.zillow.com/homedetails/42_zpid/');
  });

  it('returns null when zpid is missing entirely', () => {
    expect(formatListing({} as RawListing)).toBeNull();
  });

  it('preserves absolute detailUrl', () => {
    const formatted = formatListing({
      zpid: 7,
      detailUrl: 'https://www.zillow.com/homedetails/x/7_zpid/',
    });
    expect(formatted?.url).toBe('https://www.zillow.com/homedetails/x/7_zpid/');
  });
});

describe('zillow_search_properties tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerSearchTools(server, mockClient)
    );
  });

  it('POSTs /async-create-search-page-state/ and returns formatted listings', async () => {
    mockFetchJson.mockResolvedValue({
      cat1: {
        searchResults: {
          listResults: [
            {
              hdpData: {
                homeInfo: {
                  zpid: 1,
                  streetAddress: '1 Main',
                  city: 'X',
                  state: 'NY',
                  zipcode: '11111',
                  price: 100,
                  bedrooms: 2,
                  bathrooms: 1,
                },
              },
            },
            {
              hdpData: {
                homeInfo: {
                  zpid: 2,
                  streetAddress: '2 Main',
                  city: 'X',
                  state: 'NY',
                  zipcode: '11111',
                  price: 200,
                },
              },
            },
          ],
        },
      },
    });

    const result = await harness.callTool('zillow_search_properties', {
      location: 'Brooklyn, NY',
      price_min: 100_000,
    });
    expect(result.isError).toBeFalsy();

    const [path, init] = mockFetchJson.mock.calls[0] as [
      string,
      { method: string; body: { searchQueryState: { usersSearchTerm: string } } },
    ];
    expect(path).toBe('/async-create-search-page-state/');
    expect(init.method).toBe('POST');
    expect(init.body.searchQueryState.usersSearchTerm).toBe('Brooklyn, NY');

    const parsed = parseToolResult<Array<{ zpid: string }>>(result);
    expect(parsed.map((p) => p.zpid)).toEqual(['1', '2']);
  });

  it('respects limit', async () => {
    mockFetchJson.mockResolvedValue({
      cat1: {
        searchResults: {
          listResults: Array.from({ length: 10 }, (_, i) => ({
            hdpData: { homeInfo: { zpid: i + 1 } },
          })),
        },
      },
    });
    const result = await harness.callTool('zillow_search_properties', {
      location: 'x',
      limit: 3,
    });
    const parsed = parseToolResult<unknown[]>(result);
    expect(parsed).toHaveLength(3);
  });
});
