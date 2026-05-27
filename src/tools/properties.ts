import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractNextData, getPageProps } from '../next-data.js';
import { urlToPath } from '../url.js';
import {
  extractFeatures,
  loadCommunities,
  type ExtractedFeatures,
} from '../features.js';
import {
  formatPriceEvent,
  formatTaxEvent,
  normalizePriceEvent,
  type FormattedPriceEvent,
  type FormattedTaxEvent,
  type NormalizedPriceEvent,
  type RawPriceHistoryEntry as _SharedRawPriceHistoryEntry,
  type RawTaxHistoryEntry as _SharedRawTaxHistoryEntry,
} from './history-format.js';

/**
 * Zillow's homedetails pages are SSR Next.js. The full property object
 * is embedded in `__NEXT_DATA__.props.pageProps.componentProps.gdpClientCache`
 * (or `props.pageProps.gdpClientCache` on newer builds) as a JSON-encoded
 * blob keyed by an Apollo cache id. Picking the first entry whose value
 * has a `property` field gives us the property record.
 */

// Raw history entry types now live in `history-format.ts`; re-exported here
// so existing import paths (e.g. `from './properties'`) keep working.
export type RawPriceHistoryEntry = _SharedRawPriceHistoryEntry;
export type RawTaxHistoryEntry = _SharedRawTaxHistoryEntry;

export interface RawResoFacts {
  yearBuilt?: number;
  // Only fallback-used fields are typed; widen as needed.
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
  /**
   * Canonical MLS-feed street address. On some listings this disagrees
   * with `address.streetAddress` (e.g. zpid 248872078: "109 Overlook
   * Point Ln" vs MLS "169 Overlook Point Ln"). Surfaced separately so
   * the caller can disambiguate without re-scraping. See issue #30.
   */
  mlsStreetAddress?: string;
  // MLS RESO facts; fallback source when top-level fields are missing (issue #29).
  resoFacts?: RawResoFacts;
}

export interface FormattedProperty {
  zpid: string;
  url: string;
  address?: RawProperty['address'];
  /**
   * Canonical MLS street address. Present whenever the raw property
   * payload includes `mlsStreetAddress` (typically true on listings
   * that ever flowed through an MLS feed). May disagree with
   * `address.streetAddress` — when both are returned, callers should
   * prefer this value as the canonical address. See issue #30.
   */
  mls_street_address?: string;
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
  schools?: RawProperty['schools'];
  // Present only when `include_price_history: true`; mirrors `zillow_get_price_history`.
  price_history?: {
    events: FormattedPriceEvent[];
    events_normalized: NormalizedPriceEvent[];
  };
  // Present only when `include_tax_history: true`; mirrors `zillow_get_tax_history`.
  tax_history?: FormattedTaxEvent[];
  /**
   * Server-side keyword extraction from the description (issue #41).
   * Always populated — the five binary/categorical fields are present
   * regardless of whether the listing has a description (they default
   * to false/null). Callers can rely on the field being there.
   */
  extracted_features?: ExtractedFeatures;
}

export interface FormatOptions {
  // Include the raw `description`; defaults false (callers usually rely on `extracted_features`).
  includeDescription?: boolean;
  // Bundle the same payload `zillow_get_price_history` would return under `price_history`.
  includePriceHistory?: boolean;
  // Bundle the same payload `zillow_get_tax_history` would return under `tax_history`.
  includeTaxHistory?: boolean;
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

export function format(
  raw: RawProperty,
  opts: FormatOptions = {}
): FormattedProperty {
  const zpid = String(raw.zpid ?? '');
  const url = raw.hdpUrl
    ? raw.hdpUrl.startsWith('http')
      ? raw.hdpUrl
      : `https://www.zillow.com${raw.hdpUrl}`
    : `https://www.zillow.com/homedetails/${zpid}_zpid/`;
  const out: FormattedProperty = {
    zpid,
    url,
    address: raw.address,
    mls_street_address: raw.mlsStreetAddress,
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
    latitude: raw.latitude,
    longitude: raw.longitude,
    days_on_zillow: raw.daysOnZillow,
    page_views: raw.pageViewCount,
    favorites: raw.favoriteCount,
    tax_assessed_value: raw.taxAssessedValue,
    tax_assessed_year: raw.taxAssessedYear,
    schools: raw.schools,
    // Always populate extracted_features — even when the listing has no
    // description, the five binary/categorical fields are present with
    // default values so callers can rely on the schema (issue #41).
    extracted_features: extractFeatures(raw.description, loadCommunities()),
  };
  if (opts.includeDescription === true && raw.description) {
    out.description = raw.description;
  }
  // Bundled history — opt-in (issue #56). Saves a round trip per
  // property when the caller already knows they want the full picture.
  if (opts.includePriceHistory === true) {
    const events = (raw.priceHistory ?? []).map(formatPriceEvent);
    out.price_history = {
      events,
      events_normalized: events.map(normalizePriceEvent),
    };
  }
  if (opts.includeTaxHistory === true) {
    out.tax_history = (raw.taxHistory ?? []).map(formatTaxEvent);
  }
  return out;
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
        "Fetch a property's full Zillow record by zpid (numeric Zillow Property ID, e.g. 12345) or by homedetails URL. Returns address (Zillow's slugged form), mls_street_address (canonical MLS form — prefer this when it disagrees), neighborhood, price, Zestimate, rent Zestimate, beds/baths, square footage, year built, schools, and an `extracted_features` block (lake_front, hot_tub, basement, furnished, dock, community) keyword-parsed from the description. The raw `description` is omitted by default — pass `include_description: true` to keep it; in most cases the extracted features cover what callers need. Price-history and tax-history are also opt-in (`include_price_history: true` / `include_tax_history: true`) — bundle them in to skip a separate call. Provide exactly one of zpid or url. Read-only; safe to call repeatedly.",
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
        include_description: z
          .boolean()
          .optional()
          .describe(
            'Include the raw `description` in the response. Defaults to `false` — `extracted_features` is always populated and usually sufficient.'
          ),
        include_price_history: z
          .boolean()
          .optional()
          .describe(
            'Include the price-history series (mirrors `zillow_get_price_history`) on the response under `price_history`. Defaults to `false`. Saves a round trip when you already know you want the full picture.'
          ),
        include_tax_history: z
          .boolean()
          .optional()
          .describe(
            'Include the tax-history series (mirrors `zillow_get_tax_history`) on the response under `tax_history`. Defaults to `false`.'
          ),
      },
    },
    async ({ zpid, url, include_description, include_price_history, include_tax_history }) => {
      const { raw } = await fetchPropertyRecord(client, { zpid, url });
      return textResult(
        format(raw, {
          includeDescription: include_description,
          includePriceHistory: include_price_history,
          includeTaxHistory: include_tax_history,
        })
      );
    }
  );
}
