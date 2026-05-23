import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import {
  buildSearchPath,
  buildSearchQueryState,
  formatListing,
  registerSearchTools,
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

describe('buildSearchQueryState', () => {
  it('puts the location into usersSearchTerm', () => {
    const sqs = buildSearchQueryState({ location: 'Brooklyn, NY' });
    expect(sqs.usersSearchTerm).toBe('Brooklyn, NY');
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
  it('builds /homes/<slug>_rb/?searchQueryState=<encoded>', () => {
    const path = buildSearchPath({ location: 'Brooklyn, NY' });
    expect(path).toMatch(/^\/homes\/Brooklyn%2C%20NY_rb\/\?searchQueryState=/);
    // Decode and verify the payload
    const sqsRaw = path.split('searchQueryState=')[1]!;
    const sqs = JSON.parse(decodeURIComponent(sqsRaw));
    expect(sqs.usersSearchTerm).toBe('Brooklyn, NY');
    expect(sqs.isListVisible).toBe(true);
  });

  it('trims whitespace from the location slug', () => {
    const path = buildSearchPath({ location: '  Brooklyn  ' });
    expect(path).toMatch(/^\/homes\/Brooklyn_rb\//);
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

function htmlWithResults(listResults: RawListing[]): string {
  const nextData = {
    props: {
      pageProps: {
        searchPageState: { cat1: { searchResults: { listResults } } },
      },
    },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData
  )}</script>`;
}

describe('zillow_search_properties tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerSearchTools(server, mockClient)
    );
  });

  it('fetches /homes/<slug>_rb/ and parses searchPageState.cat1.searchResults', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWithResults([
        {
          hdpData: {
            homeInfo: {
              zpid: 1,
              streetAddress: '1 Main',
              city: 'Brooklyn',
              state: 'NY',
              zipcode: '11215',
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
              city: 'Brooklyn',
              state: 'NY',
              zipcode: '11215',
              price: 200,
            },
          },
        },
      ])
    );

    const result = await harness.callTool('zillow_search_properties', {
      location: 'Brooklyn, NY',
      price_min: 100_000,
    });
    expect(result.isError).toBeFalsy();

    const calledPath = mockFetchHtml.mock.calls[0][0] as string;
    expect(calledPath).toMatch(/^\/homes\/Brooklyn%2C%20NY_rb\/\?searchQueryState=/);
    // Verify the filter rode along in the query state
    const sqsRaw = calledPath.split('searchQueryState=')[1]!;
    const sqs = JSON.parse(decodeURIComponent(sqsRaw));
    expect(sqs.filterState.price).toEqual({ min: 100_000 });

    const parsed = parseToolResult<Array<{ zpid: string }>>(result);
    expect(parsed.map((p) => p.zpid)).toEqual(['1', '2']);
  });

  it('respects limit', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWithResults(
        Array.from({ length: 10 }, (_, i) => ({
          hdpData: { homeInfo: { zpid: i + 1 } },
        }))
      )
    );
    const result = await harness.callTool('zillow_search_properties', {
      location: 'x',
      limit: 3,
    });
    const parsed = parseToolResult<unknown[]>(result);
    expect(parsed).toHaveLength(3);
  });

  it('returns [] when the SSR page has no results array', async () => {
    mockFetchHtml.mockResolvedValue(
      '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>'
    );
    const result = await harness.callTool('zillow_search_properties', {
      location: 'nowhere',
    });
    const parsed = parseToolResult<unknown[]>(result);
    expect(parsed).toEqual([]);
  });
});
