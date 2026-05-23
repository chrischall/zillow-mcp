import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractNextData, getPageProps } from '../next-data.js';
import { urlToPath } from '../url.js';

/**
 * Zillow's market data lives on the "home values" page,
 * e.g. https://www.zillow.com/home-values/<region-id>/<slug>/. Live
 * inspection (2026-05-23) shows the SSR `__NEXT_DATA__` carries two
 * relevant objects under `pageProps`:
 *
 *   - `zhviRegion` → identifies the region (name, type, parent county/state).
 *   - `odpMarketAnalytics` → the metric bag, with three sub-objects:
 *       - `mrktListingLatest` → newListings, forSaleInventory, medianListPrice
 *       - `mrktSaleLatest`    → medianSalePrice
 *       - `zhviLatest`        → zhviYoY (and historically zhvi)
 *
 * Zillow's GraphQL serializer leaves Apollo's `__typename` tags in
 * place; we strip them when flattening.
 */

interface RawZhviRegion {
  name?: string;
  regionTypeName?: string;
  parentCounty?: { name?: string };
  parentState?: { name?: string };
}

interface RawMrktListingLatest {
  newListings?: number;
  forSaleInventory?: number;
  medianListPrice?: number;
  medianDaysOnMarket?: number;
}

interface RawMrktSaleLatest {
  medianSalePrice?: number;
  daysToPending?: number;
}

interface RawZhviLatest {
  zhvi?: number;
  zhviYoY?: number;
  asOfDate?: string;
}

interface RawOdpMarketAnalytics {
  mrktListingLatest?: RawMrktListingLatest;
  mrktSaleLatest?: RawMrktSaleLatest;
  zhviLatest?: RawZhviLatest;
}

export interface FormattedMarketReport {
  region_name?: string;
  region_type?: string;
  parent_county?: string;
  parent_state?: string;
  median_sale_price?: number;
  median_list_price?: number;
  median_days_on_market?: number;
  days_to_pending?: number;
  new_listings?: number;
  for_sale_inventory?: number;
  zhvi?: number;
  zhvi_yoy_percent?: number;
  as_of_date?: string;
}

export function pickRegion(pageProps: Record<string, unknown>): RawZhviRegion | null {
  const candidates: unknown[] = [pageProps.zhviRegion, pageProps.requestedRegion];
  for (const c of candidates) {
    if (c && typeof c === 'object') return c as RawZhviRegion;
  }
  return null;
}

export function pickAnalytics(
  pageProps: Record<string, unknown>
): RawOdpMarketAnalytics | null {
  const a = pageProps.odpMarketAnalytics;
  if (a && typeof a === 'object') return a as RawOdpMarketAnalytics;
  return null;
}

/**
 * Flatten the region + analytics into a single snake_case object. Each
 * field is optional — Zillow doesn't expose every metric for every
 * region (e.g. rural ZIPs may lack medianSalePrice).
 */
export function format(
  region: RawZhviRegion | null,
  analytics: RawOdpMarketAnalytics | null
): FormattedMarketReport {
  const yoy =
    typeof analytics?.zhviLatest?.zhviYoY === 'number'
      ? Math.round(analytics.zhviLatest.zhviYoY * 1000) / 10 // 0.04442 → 4.4
      : undefined;
  return {
    region_name: region?.name,
    region_type: region?.regionTypeName,
    parent_county: region?.parentCounty?.name,
    parent_state: region?.parentState?.name,
    median_sale_price: analytics?.mrktSaleLatest?.medianSalePrice,
    median_list_price: analytics?.mrktListingLatest?.medianListPrice,
    median_days_on_market: analytics?.mrktListingLatest?.medianDaysOnMarket,
    days_to_pending: analytics?.mrktSaleLatest?.daysToPending,
    new_listings: analytics?.mrktListingLatest?.newListings,
    for_sale_inventory: analytics?.mrktListingLatest?.forSaleInventory,
    zhvi: analytics?.zhviLatest?.zhvi,
    zhvi_yoy_percent: yoy,
    as_of_date: analytics?.zhviLatest?.asOfDate,
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
        'Market report for a Zillow region: median sale/list prices, days on market, for-sale inventory, new listings, Zillow Home Value Index (ZHVI), and year-over-year ZHVI change. Provide either a `region_path` (e.g. "/home-values/6181/brooklyn-ny/") or a full Zillow home-values URL. Read-only; safe to call repeatedly.',
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
      const region = pickRegion(pageProps);
      const analytics = pickAnalytics(pageProps);
      if (!region && !analytics) {
        throw new Error(
          `Could not locate market data (zhviRegion + odpMarketAnalytics) in __NEXT_DATA__ at ${path}.`
        );
      }
      return textResult(format(region, analytics));
    }
  );
}
