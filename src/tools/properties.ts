import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractNextData, getPageProps } from '../next-data.js';
import { urlToPath } from '../url.js';

/**
 * Zillow's homedetails pages are SSR Next.js. The full property object
 * is embedded in `__NEXT_DATA__.props.pageProps.componentProps.gdpClientCache`
 * (or `props.pageProps.gdpClientCache` on newer builds) as a JSON-encoded
 * blob keyed by an Apollo cache id. Picking the first entry whose value
 * has a `property` field gives us the property record.
 */

export interface RawPriceHistoryEntry {
  date?: string;
  time?: number;
  event?: string;
  price?: number;
  priceChangeRate?: number;
  pricePerSquareFoot?: number;
  source?: string;
  attributeSource?: {
    infoString1?: string;
    infoString2?: string;
    infoString3?: string;
  };
}

export interface RawTaxHistoryEntry {
  time?: number;
  taxPaid?: number;
  taxIncreaseRate?: number;
  value?: number;
  valueIncreaseRate?: number;
}

export interface RawResoFacts {
  yearBuilt?: number;
  // resoFacts carries many more fields (lotSize, livingArea, parkingFeatures,
  // etc). We only type the ones we use as fallbacks; widen as needed.
}

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
  priceHistory?: RawPriceHistoryEntry[];
  taxHistory?: RawTaxHistoryEntry[];
  schools?: Array<{
    name?: string;
    rating?: number;
    grades?: string;
    distance?: number;
    type?: string;
    studentsPerTeacher?: number;
  }>;
  // MLS RESO facts; fallback source when top-level fields are missing (issue #29).
  resoFacts?: RawResoFacts;
}

export interface FormattedProperty {
  zpid: string;
  url: string;
  address?: RawProperty['address'];
  neighborhood?: string;
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
  // Prefer entries whose Apollo key looks like a property record
  // (`Property:<zpid>`) — guards against a non-property entry that
  // happens to carry a `property` field sorting first in iteration.
  for (const [key, v] of Object.entries(cache)) {
    if (
      key.startsWith('Property:') &&
      v &&
      typeof v === 'object' &&
      v.property
    ) {
      return v.property;
    }
  }
  // Fallback: any entry with a `property` field (covers older cache
  // shapes where the Apollo typename prefix may differ).
  for (const v of Object.values(cache)) {
    if (v && typeof v === 'object' && v.property) return v.property;
  }
  return null;
}

export class InvalidPropertyUrlError extends Error {
  constructor(url: string) {
    super(
      `Zillow property URL "${url}" doesn't contain a zpid. ` +
        `Zillow homedetails URLs end with "<zpid>_zpid/" (e.g. ` +
        `"https://www.zillow.com/homedetails/268-Mallard-Rd-Lake-Lure-NC-28746/12345_zpid/"). ` +
        `Slug-only URLs (no _zpid suffix) redirect to Zillow's generic search page and ` +
        `won't resolve to a property. Pass the zpid directly via the \`zpid\` param, or ` +
        `find the zpid first via \`zillow_search_properties\`.`
    );
    this.name = 'InvalidPropertyUrlError';
  }
}

/**
 * Extract a zpid token from a Zillow homedetails URL or path. Zillow's
 * canonical homedetails URL ends with `<zpid>_zpid/`; slug-only URLs
 * (e.g. /homedetails/268-Mallard-Rd-Lake-Lure-NC-28746) silently
 * redirect to the generic search page and don't resolve. Returns the
 * zpid as a string when one is present, null otherwise.
 */
export function extractZpidFromUrl(url: string): string | null {
  // Matches both /homedetails/<slug>/<zpid>_zpid/ and bare /<zpid>_zpid/.
  const m = /\/(\d+)_zpid(?:\/|$)/.exec(url);
  return m ? m[1] : null;
}

/**
 * Resolve the homedetails path. Accepts either a numeric zpid (we build
 * the bare canonical path `/homedetails/<zpid>_zpid/`, which Zillow 302s
 * to the slugged version) or a full URL/path containing `<zpid>_zpid`
 * (reduced via `urlToPath`).
 *
 * Throws `InvalidPropertyUrlError` for URLs missing the `_zpid` token
 * — Zillow redirects those to its generic search page, so the page has
 * no `gdpClientCache` and the downstream parser can't recover.
 */
export function buildPath(args: {
  zpid?: number | string;
  url?: string;
}): string {
  if (args.zpid !== undefined) return `/homedetails/${args.zpid}_zpid/`;
  if (args.url) {
    if (extractZpidFromUrl(args.url) === null) {
      throw new InvalidPropertyUrlError(args.url);
    }
    return urlToPath(args.url);
  }
  throw new Error('zillow property tool: must provide either zpid or url');
}

/**
 * Fetch + parse a Zillow property record. Shared by `zillow_get_property`,
 * `zillow_compare_properties`, `zillow_get_price_history`,
 * `zillow_get_tax_history`, and any other tool that needs the full
 * homedetails JSON. Throws on fetch error or unparseable page state.
 */
export async function fetchPropertyRecord(
  client: ZillowClient,
  args: { zpid?: number | string; url?: string }
): Promise<{ raw: RawProperty; path: string }> {
  const path = buildPath(args);
  const html = await client.fetchHtml(path);
  const nextData = extractNextData(html);
  const pageProps = getPageProps(nextData);
  const property = findPropertyInPageProps(pageProps);
  if (!property) {
    // Diagnose what we actually got back so the error is actionable.
    const cacheRaw =
      (pageProps.gdpClientCache as string | undefined) ??
      ((pageProps.componentProps as Record<string, unknown> | undefined)
        ?.gdpClientCache as string | undefined);
    const diagnosis = !cacheRaw
      ? "pageProps.gdpClientCache (and pageProps.componentProps.gdpClientCache) were both absent — Zillow probably redirected this URL to its generic /homes/ search page, which means the URL didn't resolve to a property"
      : `pageProps.gdpClientCache was present but no entry had a 'property' field — Zillow may have changed the cache key shape (we look for "Property:<zpid>" first, then any entry with a property field)`;
    throw new Error(
      `Could not locate property data in __NEXT_DATA__ at ${path}. ${diagnosis}. ` +
        `If you passed a slug-only URL, retry with the zpid (\`zpid: 12345\`) ` +
        `or a full URL containing \`<zpid>_zpid\`.`
    );
  }
  return { raw: property, path };
}

export function format(raw: RawProperty): FormattedProperty {
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
    neighborhood: raw.address?.neighborhood,
    price: raw.price,
    zestimate: raw.zestimate,
    rent_zestimate: raw.rentZestimate,
    beds: raw.bedrooms,
    baths: raw.bathrooms,
    living_area: raw.livingArea,
    lot_size: raw.lotSize,
    // Fall back to MLS RESO yearBuilt when the top-level is missing (issue #29).
    year_built: raw.yearBuilt ?? raw.resoFacts?.yearBuilt,
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
      title: 'Get Zillow property details',
      description:
        "Fetch a property's full Zillow record by zpid (numeric Zillow Property ID, e.g. 12345) or by homedetails URL. Returns address, neighborhood, price, Zestimate, rent Zestimate, beds/baths, square footage, year built, schools, and price history. Provide exactly one of zpid or url. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get Zillow property details',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
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
      const { raw } = await fetchPropertyRecord(client, { zpid, url });
      return textResult(format(raw));
    }
  );
}
