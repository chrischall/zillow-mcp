import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import {
  format,
  pickAnalytics,
  pickRegion,
  registerMarketTools,
} from '../../src/tools/market.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

function htmlWith(pageProps: Record<string, unknown>): string {
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps },
  })}</script>`;
}

/**
 * Shape sampled from a real Zillow home-values page (Brooklyn / region 6181,
 * 2026-05-23). Used as the canonical fixture so we don't drift if Zillow
 * adds new fields — the parser should pluck just the documented subset.
 */
const FIXTURE_PAGE_PROPS = {
  zhviRegion: {
    name: 'New York',
    regionTypeName: 'city',
    parentCounty: { name: 'Kings County' },
    parentState: { name: 'NY' },
    __typename: 'Region',
  },
  odpMarketAnalytics: {
    zhviLatest: {
      zhvi: 880_000,
      zhviYoY: 0.04442152242852693,
      asOfDate: '2026-04-30',
      __typename: 'Zhvi',
    },
    mrktListingLatest: {
      newListings: 3761,
      forSaleInventory: 16707,
      medianListPrice: 858_000,
      medianDaysOnMarket: 65,
      __typename: 'MrktListing',
    },
    mrktSaleLatest: {
      medianSalePrice: 773_000,
      __typename: 'MrktSale',
    },
    __typename: 'OdpMarketAnalytics',
  },
};

describe('pickRegion / pickAnalytics', () => {
  it('picks zhviRegion when present', () => {
    expect(pickRegion(FIXTURE_PAGE_PROPS)).toEqual(
      FIXTURE_PAGE_PROPS.zhviRegion
    );
  });

  it('falls back to requestedRegion when zhviRegion is absent', () => {
    const requestedRegion = { name: 'X', regionTypeName: 'zip' };
    expect(pickRegion({ requestedRegion })).toBe(requestedRegion);
  });

  it('returns null when neither region field is present', () => {
    expect(pickRegion({})).toBeNull();
  });

  it('picks odpMarketAnalytics', () => {
    expect(pickAnalytics(FIXTURE_PAGE_PROPS)).toEqual(
      FIXTURE_PAGE_PROPS.odpMarketAnalytics
    );
  });

  it('returns null when analytics is absent', () => {
    expect(pickAnalytics({})).toBeNull();
  });
});

describe('format', () => {
  it('flattens region + analytics into snake_case', () => {
    const out = format(
      FIXTURE_PAGE_PROPS.zhviRegion,
      FIXTURE_PAGE_PROPS.odpMarketAnalytics
    );
    expect(out).toMatchObject({
      region_name: 'New York',
      region_type: 'city',
      parent_county: 'Kings County',
      parent_state: 'NY',
      median_sale_price: 773_000,
      median_list_price: 858_000,
      median_days_on_market: 65,
      new_listings: 3761,
      for_sale_inventory: 16707,
      zhvi: 880_000,
      zhvi_yoy_percent: 4.4, // 0.04442... → 4.4%
      as_of_date: '2026-04-30',
    });
  });

  it('rounds zhviYoY to one decimal place as a percent', () => {
    const out = format(null, { zhviLatest: { zhviYoY: 0.0567 } });
    expect(out.zhvi_yoy_percent).toBe(5.7);
  });

  it('handles missing analytics gracefully (region only)', () => {
    const out = format({ name: 'X', regionTypeName: 'city' }, null);
    expect(out.region_name).toBe('X');
    expect(out.median_sale_price).toBeUndefined();
    expect(out.zhvi).toBeUndefined();
  });

  it('handles missing region gracefully (analytics only)', () => {
    const out = format(null, {
      mrktSaleLatest: { medianSalePrice: 500_000 },
    });
    expect(out.region_name).toBeUndefined();
    expect(out.median_sale_price).toBe(500_000);
  });
});

describe('zillow_get_market_report tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerMarketTools(server, mockClient)
    );
  });

  it('fetches the home-values path and returns the flattened report', async () => {
    mockFetchHtml.mockResolvedValue(htmlWith(FIXTURE_PAGE_PROPS));

    const result = await harness.callTool('zillow_get_market_report', {
      region_path: '/home-values/6181/brooklyn-ny/',
    });
    expect(result.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/home-values/6181/brooklyn-ny/');
    const parsed = parseToolResult<{
      region_name: string;
      median_sale_price: number;
      zhvi_yoy_percent: number;
      new_listings: number;
    }>(result);
    expect(parsed.region_name).toBe('New York');
    expect(parsed.median_sale_price).toBe(773_000);
    expect(parsed.zhvi_yoy_percent).toBe(4.4);
    expect(parsed.new_listings).toBe(3761);
  });

  it('reduces a full URL to a path', async () => {
    mockFetchHtml.mockResolvedValue(htmlWith(FIXTURE_PAGE_PROPS));
    await harness.callTool('zillow_get_market_report', {
      url: 'https://www.zillow.com/home-values/123/sf-ca/',
    });
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/home-values/123/sf-ca/');
  });

  it('prepends /home-values/ when only a slug is given', async () => {
    mockFetchHtml.mockResolvedValue(htmlWith(FIXTURE_PAGE_PROPS));
    await harness.callTool('zillow_get_market_report', {
      region_path: '12/x/',
    });
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/home-values/12/x/');
  });

  it('errors when both region and analytics are missing', async () => {
    mockFetchHtml.mockResolvedValue(htmlWith({}));
    const result = await harness.callTool('zillow_get_market_report', {
      region_path: '/home-values/1/x/',
    });
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/Could not locate market data/i);
  });

  it('errors when neither region_path nor url is provided', async () => {
    const result = await harness.callTool('zillow_get_market_report', {});
    expect(result.isError).toBeTruthy();
  });
});
