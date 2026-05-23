import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { registerMarketTools } from '../../src/tools/market.js';
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

describe('zillow_get_market_report tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerMarketTools(server, mockClient)
    );
  });

  it('fetches the home-values path and normalizes fields', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({
        marketInfo: {
          regionId: 6181,
          regionName: 'Brooklyn, NY',
          medianSalePrice: 950_000,
          medianListPrice: 1_050_000,
          medianDaysOnMarket: 65,
          zhvi: 880_000,
          zhviYoYPercent: 2.4,
          asOfDate: '2026-03',
        },
      })
    );

    const result = await harness.callTool('zillow_get_market_report', {
      region_path: '/home-values/6181/brooklyn-ny/',
    });
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/home-values/6181/brooklyn-ny/');
    const parsed = parseToolResult<{
      region_id: number;
      region_name: string;
      median_sale_price: number;
      zhvi_yoy_percent: number;
    }>(result);
    expect(parsed.region_id).toBe(6181);
    expect(parsed.median_sale_price).toBe(950_000);
    expect(parsed.zhvi_yoy_percent).toBe(2.4);
  });

  it('reduces a full URL to a path', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({ marketInfo: { regionName: 'X' } })
    );
    await harness.callTool('zillow_get_market_report', {
      url: 'https://www.zillow.com/home-values/123/sf-ca/',
    });
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/home-values/123/sf-ca/');
  });

  it('prepends /home-values/ when only a slug is given', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({ marketInfo: { regionName: 'X' } })
    );
    await harness.callTool('zillow_get_market_report', {
      region_path: '12/x/',
    });
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/home-values/12/x/');
  });

  it('errors when marketInfo is missing', async () => {
    mockFetchHtml.mockResolvedValue(htmlWith({}));
    const result = await harness.callTool('zillow_get_market_report', {
      region_path: '/home-values/1/x/',
    });
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/Could not locate marketInfo/i);
  });

  it('errors when neither region_path nor url is provided', async () => {
    const result = await harness.callTool('zillow_get_market_report', {});
    expect(result.isError).toBeTruthy();
  });
});
