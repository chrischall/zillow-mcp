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
  type RawPriceHistoryEntry,
  type RawTaxHistoryEntry,
} from './history-format.js';
// Re-export raw history-entry types so existing `from './properties'` imports keep working.
export type {
  RawPriceHistoryEntry,
  RawTaxHistoryEntry,
} from './history-format.js';

/**
 * Zillow's homedetails pages are SSR Next.js. The full property object
 * is embedded in `__NEXT_DATA__.props.pageProps.componentProps.gdpClientCache`
 * (or `props.pageProps.gdpClientCache` on newer builds) as a JSON-encoded
 * blob keyed by an Apollo cache id. Picking the first entry whose value
 * has a `property` field gives us the property record.
 */

export interface RawResoFacts {
  yearBuilt?: number;
  /**
   * MLS-reported HOA dues. Pair with `associationFeeFrequency` (e.g.
   * "Annually" / "Monthly") to derive a monthly USD figure. (Issue #42.)
   */
  associationFee?: number;
  associationFeeFrequency?: string;
  /** Fallback path for annual tax — Zillow may stash it here. (Issue #44.) */
  taxAnnualAmount?: number;
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
  /**
   * Zillow surfaces a pre-computed monthly HOA on some listings. When
   * present, prefer this over deriving from associationFee + frequency.
   * (Issue #42.)
   */
  monthlyHoaFee?: number;
  /** Annual tax (top-level). May be the not-yet-assessed `1` sentinel. (Issue #44.) */
  taxAnnualAmount?: number;
  /**
   * Previous list price — populated when Zillow has seen a price change
   * on the current listing cycle. Used to derive `price_drop_*`.
   * (Issue #43.)
   */
  previousPrice?: number;
  /**
   * Time the listing was first posted on Zillow, in ms-since-epoch.
   * Used as a fallback when `daysOnZillow` is absent. (Issue #43.)
   */
  timeOnZillow?: number;
  /**
   * Alternate address strings supplied by upstream MLS feeds. Surfaced
   * as `address_alternates[]` in the formatted output. (Issue #50.)
   */
  altAddresses?: string[];
}

export interface FormattedProperty {
  zpid: string;
  url: string;
  /**
   * Sheets-paste-ready hyperlink formula pointing at the same listing.
   * Always present (mirrors `url`). Pasting it into Google Sheets renders
   * as a clickable "Zillow" link. (Issue #49.)
   */
  portal_url_hyperlink: string;
  address?: RawProperty['address'];
  /**
   * Canonical MLS street address. Present whenever the raw property
   * payload includes `mlsStreetAddress` (typically true on listings
   * that ever flowed through an MLS feed). May disagree with
   * `address.streetAddress` — when both are returned, callers should
   * prefer this value as the canonical address. See issue #30.
   */
  mls_street_address?: string;
  /**
   * Alternate address strings (from MLS feeds, parcel variants, etc.)
   * that disagree with `address.streetAddress`. Omitted when empty.
   * (Issue #50.)
   */
  address_alternates?: string[];
  neighborhood?: string;
  price?: number;
  zestimate?: number;
  rent_zestimate?: number;
  beds?: number;
  baths?: number;
  living_area?: number;
  /** Lot size in square feet, from the raw `lotSize`. `null` (never `0`)
   * for condos / listings with no lot. */
  lot_size?: number | null;
  /** `round(lot_size / 43560, 2)` — lot size in acres, the unit that
   * matters for rural/mountain/land listings. `null` when `lot_size` is
   * null/absent (not `0`). See issue #82. */
  lot_size_acres?: number | null;
  year_built?: number;
  home_type?: string;
  status?: string;
  description?: string;
  latitude?: number;
  longitude?: number;
  days_on_zillow?: number;
  /**
   * Alias for `days_on_zillow` (aligned with the other real-estate MCPs).
   * Null when neither `daysOnZillow` nor `timeOnZillow` is available.
   * (Issue #43.)
   */
  days_on_market?: number | null;
  /** `previousPrice - price`. Null when either is missing. (Issue #43.) */
  price_drop_amount?: number | null;
  /** `(previous - current) / previous * 100`, rounded to 0.1. (Issue #43.) */
  price_drop_percent?: number | null;
  page_views?: number;
  favorites?: number;
  /**
   * Monthly-normalized HOA cost. Prefers `monthlyHoaFee` from the raw
   * payload; otherwise derived from `resoFacts.associationFee` +
   * `associationFeeFrequency`. Null when no fee or unknown frequency.
   * (Issue #42.)
   */
  hoa_monthly_usd?: number | null;
  /** Null when the raw value was the not-yet-assessed 0/1 sentinel. (Issue #44.) */
  tax_annual?: number | null;
  /**
   * Disambiguates "Zillow has no tax data for this home" from
   * "lookup failed" (issue #77). Always present.
   * - `available`        — a real annual tax figure surfaced.
   * - `new_construction` — Zillow returned the 0/1 not-yet-assessed sentinel.
   * - `unavailable`      — no tax field on the page at all.
   */
  tax_status: 'available' | 'new_construction' | 'unavailable';
  /**
   * Disambiguates "no Zestimate for this home" from "lookup failed"
   * (issue #77). Always present.
   * - `available`   — `zestimate` is a positive number.
   * - `rent_only`   — only `rent_zestimate` is set (no sale Zestimate).
   * - `unavailable` — neither Zestimate surfaced.
   */
  zestimate_status: 'available' | 'rent_only' | 'unavailable';
  /**
   * Disambiguates "Zillow has no record of a sale" from "lookup
   * failed" (issue #77). Always present.
   * - `available`   — a Sold event was found in the price history.
   * - `never_sold`  — price history was non-empty but had no Sold event.
   * - `unavailable` — no price history at all (Zillow may simply not have it).
   */
  last_sold_status: 'available' | 'never_sold' | 'unavailable';
  tax_assessed_value?: number;
  tax_assessed_year?: number;
  schools?: RawProperty['schools'];
  /** Most recent `Sold` event date (YYYY-MM-DD) from the price history. (Issue #57.) */
  last_sold_date?: string | null;
  /** Price from the most recent `Sold` event in the price history. (Issue #57.) */
  last_sold_price?: number | null;
  /**
   * `(price - zestimate) / zestimate * 100`, rounded to 1 decimal.
   * Negative when listed below the Zestimate. Null when either input
   * is missing. (Issue #57.)
   */
  zest_vs_list_pct?: number | null;
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
   *
   * Typed as required (not optional) so TypeScript consumers don't
   * need `!` assertions; matches the wire contract documented in #41
   * and the always-populated behavior of `format()` (PR #61 nit).
   */
  extracted_features: ExtractedFeatures;
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

/**
 * Build the Sheets-paste-ready hyperlink formula for a listing URL.
 * Pasting the returned string into a Google Sheets cell renders as a
 * clickable "Zillow" link. (Issue #49.)
 */
export function buildPortalUrlHyperlink(url: string): string {
  return `=HYPERLINK("${url}","Zillow")`;
}

/**
 * Convert an HOA `{amount, frequency}` pair (in Zillow's
 * `resoFacts.associationFee*` shape) to monthly USD, rounded to the
 * nearest dollar. Returns `null` for unknown frequency strings (with a
 * stderr warning) or when the inputs are absent. (Issue #42.)
 */
export function hoaToMonthlyUsd(
  amount: number | undefined,
  frequency: string | undefined
): number | null {
  if (typeof amount !== 'number' || !frequency) return null;
  let monthly: number;
  switch (frequency) {
    case 'Monthly':
      monthly = amount;
      break;
    case 'Annually':
      monthly = amount / 12;
      break;
    case 'Quarterly':
      monthly = amount / 3;
      break;
    case 'SemiAnnually':
      monthly = amount / 6;
      break;
    case 'Weekly':
      monthly = (amount * 52) / 12;
      break;
    default:
      console.error(
        `[zillow-mcp] hoa_monthly_usd: unknown associationFeeFrequency "${frequency}" — returning null`
      );
      return null;
  }
  return Math.round(monthly);
}

/** Square feet in one acre. */
const SQFT_PER_ACRE = 43_560;

/**
 * Derive lot size in acres from a square-foot lot size, rounded to 2 dp
 * (#82). Pairs with the raw `lot_size` — acreage is the unit that matters
 * for rural/mountain/land listings.
 *
 * Null-safe: returns `null` (never `0`) when the input is missing,
 * non-numeric, or `0` — a `0` lot is treated as absent (condos / missing
 * data), matching how `lot_size` itself nulls out rather than reporting a
 * real "0 acre" lot.
 */
export function lotSizeAcres(
  lotSqFt: number | undefined | null
): number | null {
  if (typeof lotSqFt !== 'number' || !Number.isFinite(lotSqFt) || lotSqFt <= 0) {
    return null;
  }
  return Math.round((lotSqFt / SQFT_PER_ACRE) * 100) / 100;
}

/**
 * Normalize an address for equality checks — collapse whitespace, drop
 * punctuation, and lowercase. Used to dedupe `address_alternates`
 * against the primary `address.streetAddress`.
 */
function normalizeAddressForCompare(s: string | undefined): string {
  if (!s) return '';
  return s.toLowerCase().replace(/[,#.]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Collect alternate address strings from the raw payload, excluding
 * the primary. Sources currently include `mlsStreetAddress` (when it
 * disagrees with `address.streetAddress`) and any `altAddresses[]`
 * that may be present. Returns an empty array when nothing differs.
 * (Issue #50.)
 */
export function collectAddressAlternates(
  primary: string | undefined,
  raw: RawProperty
): string[] {
  const primaryNorm = normalizeAddressForCompare(primary);
  const candidates: string[] = [];
  if (raw.mlsStreetAddress) candidates.push(raw.mlsStreetAddress);
  if (raw.altAddresses) candidates.push(...raw.altAddresses);
  const seen = new Set<string>();
  const alternates: string[] = [];
  for (const candidate of candidates) {
    const norm = normalizeAddressForCompare(candidate);
    if (!norm) continue;
    if (norm === primaryNorm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    alternates.push(candidate);
  }
  return alternates;
}

/**
 * Find the most recent `Sold` event in a price history series.
 * Picks by date (or epoch `time`), preferring the latest. (Issue #57.)
 */
export function findLastSold(
  history: RawPriceHistoryEntry[] | undefined
): { date: string; price: number } | null {
  if (!history || history.length === 0) return null;
  let best: { ts: number; date: string; price: number } | null = null;
  for (const ev of history) {
    if (!ev.event || !/sold/i.test(ev.event)) continue;
    if (typeof ev.price !== 'number') continue;
    let ts: number | null = null;
    let date: string | null = null;
    if (ev.date) {
      const parsed = Date.parse(ev.date);
      if (!Number.isNaN(parsed)) {
        ts = parsed;
        date = ev.date.slice(0, 10);
      }
    }
    if (ts === null && typeof ev.time === 'number') {
      ts = ev.time;
      date = new Date(ev.time).toISOString().slice(0, 10);
    }
    if (ts === null || !date) continue;
    if (best === null || ts > best.ts) {
      best = { ts, date, price: ev.price };
    }
  }
  return best ? { date: best.date, price: best.price } : null;
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
  // lot_size + derived lot_size_acres (#82). Null-safe: a 0 or absent
  // lotSize (condos / missing data) yields null for both, never 0.
  const lotSize =
    typeof raw.lotSize === 'number' && raw.lotSize > 0 ? raw.lotSize : null;
  const out: FormattedProperty = {
    zpid,
    url,
    portal_url_hyperlink: buildPortalUrlHyperlink(url),
    address: raw.address,
    mls_street_address: raw.mlsStreetAddress,
    neighborhood: raw.address?.neighborhood,
    price: raw.price,
    zestimate: raw.zestimate,
    rent_zestimate: raw.rentZestimate,
    beds: raw.bedrooms,
    baths: raw.bathrooms,
    living_area: raw.livingArea,
    lot_size: lotSize,
    lot_size_acres: lotSizeAcres(lotSize),
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
    // Tri-state status fields (issue #77) — overwritten below. Defaults
    // to 'unavailable' so a missing branch never lies about presence.
    tax_status: 'unavailable',
    zestimate_status: 'unavailable',
    last_sold_status: 'unavailable',
  };

  // address_alternates: alternate flat-string addresses that disagree
  // with the primary streetAddress. (Issue #50.)
  const alternates = collectAddressAlternates(raw.address?.streetAddress, raw);
  if (alternates.length > 0) out.address_alternates = alternates;

  // days_on_market: alias of daysOnZillow with a null when missing.
  // (Issue #43.) When daysOnZillow is absent but timeOnZillow is set,
  // derive from the timestamp. Otherwise null.
  if (typeof raw.daysOnZillow === 'number') {
    out.days_on_market = raw.daysOnZillow;
  } else if (typeof raw.timeOnZillow === 'number') {
    const delta = Date.now() - raw.timeOnZillow;
    out.days_on_market = Math.max(0, Math.floor(delta / 86_400_000));
  } else {
    out.days_on_market = null;
  }

  // price_drop_*: null when either side is missing or previous is zero.
  // (Issue #43.)
  if (
    typeof raw.price === 'number' &&
    typeof raw.previousPrice === 'number' &&
    raw.previousPrice > 0
  ) {
    const drop = raw.previousPrice - raw.price;
    out.price_drop_amount = drop;
    out.price_drop_percent = Math.round((drop / raw.previousPrice) * 1000) / 10;
  } else {
    out.price_drop_amount = null;
    out.price_drop_percent = null;
  }

  // hoa_monthly_usd: prefer pre-computed monthlyHoaFee, fall back to
  // resoFacts.associationFee + frequency. (Issue #42.)
  if (typeof raw.monthlyHoaFee === 'number') {
    out.hoa_monthly_usd = raw.monthlyHoaFee;
  } else {
    out.hoa_monthly_usd = hoaToMonthlyUsd(
      raw.resoFacts?.associationFee,
      raw.resoFacts?.associationFeeFrequency
    );
  }

  // tax_annual + tax_status (issues #44, #77): null out the 0/1
  // not-yet-assessed sentinels and disambiguate "no tax data" from
  // "lookup failed". Fall back to resoFacts when top-level is missing.
  const rawTax = raw.taxAnnualAmount ?? raw.resoFacts?.taxAnnualAmount;
  if (typeof rawTax === 'number') {
    if (rawTax <= 1) {
      out.tax_annual = null;
      out.tax_status = 'new_construction';
    } else {
      out.tax_annual = rawTax;
      out.tax_status = 'available';
    }
  } else {
    out.tax_annual = null;
    out.tax_status = 'unavailable';
  }

  // zestimate_status (issue #77): the bare `zestimate`/`rent_zestimate`
  // numbers can be missing for legitimate reasons (Zillow simply
  // doesn't have a sale Zestimate yet). Surface a tri-state so callers
  // distinguish "genuinely absent" from "lookup failed".
  if (typeof raw.zestimate === 'number' && raw.zestimate > 0) {
    out.zestimate_status = 'available';
  } else if (typeof raw.rentZestimate === 'number' && raw.rentZestimate > 0) {
    out.zestimate_status = 'rent_only';
  } else {
    out.zestimate_status = 'unavailable';
  }

  // last_sold_*: scan price history for the most recent Sold event.
  // (Issue #57.) No separate call — Zillow embeds priceHistory inline.
  // last_sold_status (issue #77): distinguish "Zillow has no sale on
  // record" from "Zillow has no price history for this property at all".
  const lastSold = findLastSold(raw.priceHistory);
  if (lastSold) {
    out.last_sold_date = lastSold.date;
    out.last_sold_price = lastSold.price;
    out.last_sold_status = 'available';
  } else {
    out.last_sold_date = null;
    out.last_sold_price = null;
    // Non-empty history without a Sold event = never_sold; empty/absent = unavailable.
    out.last_sold_status =
      Array.isArray(raw.priceHistory) && raw.priceHistory.length > 0
        ? 'never_sold'
        : 'unavailable';
  }

  // zest_vs_list_pct: (list - zest) / zest * 100, one decimal.
  // (Issue #57.) Null when either input is missing/zero.
  if (
    typeof raw.price === 'number' &&
    typeof raw.zestimate === 'number' &&
    raw.zestimate > 0
  ) {
    out.zest_vs_list_pct =
      Math.round(((raw.price - raw.zestimate) / raw.zestimate) * 1000) / 10;
  } else {
    out.zest_vs_list_pct = null;
  }

  // description opt-in. Defaults to omitted (issue #40); pass
  // `includeDescription: true` to keep it.
  if (opts.includeDescription === true && raw.description) {
    out.description = raw.description;
  }
  // Bundled history opt-in; saves a round trip when the caller wants both.
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
        "Fetch a property's full Zillow record by zpid (numeric Zillow Property ID, e.g. 12345) or by homedetails URL. Returns address (Zillow's slugged form), mls_street_address (canonical MLS form — prefer this when it disagrees), neighborhood, price, Zestimate, rent Zestimate, beds/baths, square footage, lot_size (sq ft) plus the derived lot_size_acres (round(lot_size / 43560, 2); both null — never 0 — for condos and listings with no lot), year built, schools, and an `extracted_features` block (lake_front, hot_tub, basement, furnished, dock, community) keyword-parsed from the description. The raw `description` is omitted by default — pass `include_description: true` to keep it; in most cases the extracted features cover what callers need. Price-history and tax-history are also opt-in (`include_price_history: true` / `include_tax_history: true`) — bundle them in to skip a separate call. Provide exactly one of zpid or url. Read-only; safe to call repeatedly.",
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
