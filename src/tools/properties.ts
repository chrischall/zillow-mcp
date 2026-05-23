import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractNextData, getPageProps } from '../next-data.js';

/**
 * Zillow's homedetails pages are SSR Next.js. The full property object
 * is embedded in `__NEXT_DATA__.props.pageProps.componentProps.gdpClientCache`
 * (or `props.pageProps.gdpClientCache` on newer builds) as a JSON-encoded
 * blob keyed by an Apollo cache id. Picking the first entry whose value
 * has a `property` field gives us the property record.
 */

export interface RawProperty {
  zpid?: number | string;
  hdpUrl?: string;
  address?: {
    streetAddress?: string;
    city?: string;
    state?: string;
    zipcode?: string;
    neighborhood?: string;
  };
  price?: number;
  zestimate?: number;
  rentZestimate?: number;
  bedrooms?: number;
  bathrooms?: number;
  livingArea?: number;
  lotSize?: number;
  yearBuilt?: number;
  homeType?: string;
  homeStatus?: string;
  description?: string;
  latitude?: number;
  longitude?: number;
  daysOnZillow?: number;
  pageViewCount?: number;
  favoriteCount?: number;
  taxAssessedValue?: number;
  taxAssessedYear?: number;
  priceHistory?: Array<{
    date?: string;
    price?: number;
    event?: string;
    source?: string;
  }>;
  schools?: Array<{
    name?: string;
    rating?: number;
    grades?: string;
    distance?: number;
    type?: string;
    studentsPerTeacher?: number;
  }>;
}

export interface FormattedProperty {
  zpid: string;
  url: string;
  address?: RawProperty['address'];
  price?: number;
  zestimate?: number;
  rent_zestimate?: number;
  beds?: number;
  baths?: number;
  living_area?: number;
  lot_size?: number;
  year_built?: number;
  home_type?: string;
  status?: string;
  description?: string;
  latitude?: number;
  longitude?: number;
  days_on_zillow?: number;
  page_views?: number;
  favorites?: number;
  tax_assessed_value?: number;
  tax_assessed_year?: number;
  price_history?: RawProperty['priceHistory'];
  schools?: RawProperty['schools'];
}

/**
 * Locate the first `property`-bearing value inside Zillow's gdpClientCache.
 * The cache is JSON-encoded as a string inside the page-props blob — we
 * parse it lazily here so the rest of the tooling can stay in-memory.
 */
export function findPropertyInPageProps(pageProps: Record<string, unknown>): RawProperty | null {
  const cacheRaw =
    (pageProps.gdpClientCache as string | undefined) ??
    ((pageProps.componentProps as Record<string, unknown> | undefined)
      ?.gdpClientCache as string | undefined);
  if (!cacheRaw) return null;
  let cache: Record<string, { property?: RawProperty }>;
  try {
    cache = JSON.parse(cacheRaw) as Record<string, { property?: RawProperty }>;
  } catch {
    return null;
  }
  for (const v of Object.values(cache)) {
    if (v && typeof v === 'object' && v.property) return v.property;
  }
  return null;
}

function buildPath(args: { zpid?: number | string; url?: string }): string {
  if (args.url) {
    try {
      const u = new URL(args.url);
      return `${u.pathname}${u.search}`;
    } catch {
      // Assume it was already a path
      return args.url.startsWith('/') ? args.url : `/${args.url}`;
    }
  }
  if (args.zpid !== undefined) {
    return `/homedetails/${args.zpid}_zpid/`;
  }
  throw new Error('zillow_get_property: must provide either zpid or url');
}

function format(raw: RawProperty): FormattedProperty {
  const zpid = String(raw.zpid ?? '');
  const url = raw.hdpUrl
    ? raw.hdpUrl.startsWith('http')
      ? raw.hdpUrl
      : `https://www.zillow.com${raw.hdpUrl}`
    : `https://www.zillow.com/homedetails/${zpid}_zpid/`;
  return {
    zpid,
    url,
    address: raw.address,
    price: raw.price,
    zestimate: raw.zestimate,
    rent_zestimate: raw.rentZestimate,
    beds: raw.bedrooms,
    baths: raw.bathrooms,
    living_area: raw.livingArea,
    lot_size: raw.lotSize,
    year_built: raw.yearBuilt,
    home_type: raw.homeType,
    status: raw.homeStatus,
    description: raw.description,
    latitude: raw.latitude,
    longitude: raw.longitude,
    days_on_zillow: raw.daysOnZillow,
    page_views: raw.pageViewCount,
    favorites: raw.favoriteCount,
    tax_assessed_value: raw.taxAssessedValue,
    tax_assessed_year: raw.taxAssessedYear,
    price_history: raw.priceHistory,
    schools: raw.schools,
  };
}

export function registerPropertyTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_get_property',
    {
      description:
        "Fetch a property's full Zillow record by zpid (e.g. 12345) or by homedetails URL. Returns address, price, Zestimate, beds/baths, square footage, year built, schools, and price history. Provide exactly one of zpid or url.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        zpid: z
          .union([z.number().int().positive(), z.string()])
          .optional()
          .describe('Zillow Property ID (numeric)'),
        url: z
          .string()
          .optional()
          .describe('A Zillow homedetails URL (or path beginning with /homedetails/)'),
      },
    },
    async ({ zpid, url }) => {
      const path = buildPath({ zpid, url });
      const html = await client.fetchHtml(path);
      const nextData = extractNextData(html);
      const pageProps = getPageProps(nextData);
      const property = findPropertyInPageProps(pageProps);
      if (!property) {
        throw new Error(
          `Could not locate property data in __NEXT_DATA__ at ${path}. ` +
            `Zillow may have changed their page structure.`
        );
      }
      return textResult(format(property));
    }
  );
}
