import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractNextData, getPageProps } from '../next-data.js';
import { urlToPath } from '../url.js';

/**
 * Zillow's market data lives on the Local Info / "home values" page,
 * e.g. https://www.zillow.com/home-values/<region-id>/<slug>/. The
 * SSR page embeds a `marketInfo` (or `regionInfo` / `marketReport`)
 * blob inside __NEXT_DATA__.
 *
 * Rather than hard-coding the exact field name (Zillow moves these
 * between releases), we hand back a normalized subset and a generic
 * `details` passthrough for anything we don't recognize.
 */

interface RawMarketInfo {
  regionId?: number;
  regionName?: string;
  regionType?: string;
  medianSalePrice?: number;
  medianListPrice?: number;
  medianRentPrice?: number;
  medianDaysOnMarket?: number;
  inventoryCount?: number;
  newListings?: number;
  pendingSales?: number;
  zhvi?: number; // Zillow Home Value Index
  zhviYoYPercent?: number;
  forSaleByCategory?: Record<string, number>;
  buyerSellerIndex?: { value?: number; label?: string };
  asOfDate?: string;
}

function pickMarketInfo(pageProps: Record<string, unknown>): RawMarketInfo | null {
  const candidates: unknown[] = [
    pageProps.marketInfo,
    pageProps.marketReport,
    pageProps.regionInfo,
    (pageProps.componentProps as Record<string, unknown> | undefined)?.marketInfo,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object') return c as RawMarketInfo;
  }
  return null;
}

function format(raw: RawMarketInfo) {
  return {
    region_id: raw.regionId,
    region_name: raw.regionName,
    region_type: raw.regionType,
    median_sale_price: raw.medianSalePrice,
    median_list_price: raw.medianListPrice,
    median_rent_price: raw.medianRentPrice,
    median_days_on_market: raw.medianDaysOnMarket,
    inventory_count: raw.inventoryCount,
    new_listings: raw.newListings,
    pending_sales: raw.pendingSales,
    zhvi: raw.zhvi,
    zhvi_yoy_percent: raw.zhviYoYPercent,
    for_sale_by_category: raw.forSaleByCategory,
    buyer_seller_index: raw.buyerSellerIndex,
    as_of_date: raw.asOfDate,
  };
}

/**
 * Resolve a market-report path. Accepts a full URL or a slug under
 * `/home-values/`. Plain slugs (`6181/brooklyn-ny/`) are normalized
 * by prepending `/home-values/`.
 */
function pathFromInput(args: { region_path?: string; url?: string }): string {
  if (args.url) return urlToPath(args.url);
  if (args.region_path) {
    const p = urlToPath(args.region_path);
    return p.includes('/home-values/') ? p : `/home-values${p}`;
  }
  throw new Error(
    'zillow_get_market_report: provide either region_path (e.g. "/home-values/6181/brooklyn-ny/") or url.'
  );
}

export function registerMarketTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_get_market_report',
    {
      title: 'Get Zillow market report for a region',
      description:
        'Market report for a Zillow region: median sale/list/rent prices, days on market, inventory, Zillow Home Value Index (ZHVI), year-over-year ZHVI change, and buyer/seller balance. Provide either a `region_path` (e.g. "/home-values/6181/brooklyn-ny/") or a full Zillow home-values URL. Read-only; safe to call repeatedly.',
      annotations: {
        title: 'Get Zillow market report for a region',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        region_path: z
          .string()
          .optional()
          .describe(
            'Path under /home-values/, e.g. "/home-values/6181/brooklyn-ny/" or "6181/brooklyn-ny/"'
          ),
        url: z
          .string()
          .optional()
          .describe('Full Zillow URL to a home-values page'),
      },
    },
    async (args) => {
      const path = pathFromInput(args);
      const html = await client.fetchHtml(path);
      const nextData = extractNextData(html);
      const pageProps = getPageProps(nextData);
      const market = pickMarketInfo(pageProps);
      if (!market) {
        throw new Error(
          `Could not locate marketInfo in __NEXT_DATA__ at ${path}.`
        );
      }
      return textResult(format(market));
    }
  );
}
