import { z } from 'zod';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute } from 'node:path';
import { FIRST_DIGIT_TO_STATES, tokenize } from '@chrischall/realty-core';
import { minifiedResult } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ZillowClient } from '../client.js';
import { viewArg, viewResponse } from '../view.js';
import { extractNextData, getPageProps } from '../next-data.js';
import { findPropertyInPageProps, type RawProperty } from './properties.js';

/**
 * Zillow's search page is SSR Next.js. We hit it twice:
 *
 *   1. Resolve: GET `/homes/<slug>_rb/` with NO `searchQueryState` query
 *      param. Zillow's URL-slug geocoder resolves the freetext into a
 *      `queryState.regionSelection` ({regionId, regionType}) plus
 *      `queryState.mapBounds`. If the geocoder can't pin a region —
 *      OR the returned results don't match the user's input — we
 *      raise `LocationNotResolved` rather than silently fall back.
 *
 *   2. Filter: GET `/homes/<slug>_rb/?searchQueryState=…` with the
 *      resolved `regionSelection` + `mapBounds` **pinned** plus the
 *      caller's filters (price/beds/etc). Without those two fields,
 *      Zillow's SSR ignores both the URL slug and `usersSearchTerm`
 *      and falls back to the user's last-known region — that's the
 *      "everything returns Brooklyn" bug we used to ship.
 *
 * Results live at `pageProps.searchPageState.cat1.searchResults.listResults`.
 *
 * Verified live 2026-05-24 against Lake Lure, NC 28746 (regionId 70190,
 * regionType 7 = ZIP) and Brooklyn, NY (regionId 37607, regionType 17).
 */

export class LocationNotResolved extends Error {
  constructor(location: string, detail: string) {
    super(
      `Zillow could not resolve location "${location}" — ${detail}. ` +
        `Try a more specific input (e.g. "1234 Main St, City, ST 12345"), a ZIP code, ` +
        `or a city + state pair (e.g. "Lake Lure, NC").`
    );
    this.name = 'LocationNotResolved';
  }
}

type HomeType =
  | 'house'
  | 'condo'
  | 'townhouse'
  | 'multi_family'
  | 'manufactured'
  | 'land'
  | 'apartment';

/** Zillow's `homeType` value for each filter type, to drop stragglers the filter lets through. */
const ZILLOW_HOME_TYPE: Record<HomeType, string> = {
  house: 'SINGLE_FAMILY',
  condo: 'CONDO',
  townhouse: 'TOWNHOUSE',
  multi_family: 'MULTI_FAMILY',
  manufactured: 'MANUFACTURED',
  land: 'LOT',
  apartment: 'APARTMENT',
};

/** True when `home_type` is unknown or one of the requested types. */
export function matchesHomeTypes(home_type: string | undefined, types?: HomeType[]): boolean {
  if (!types || types.length === 0 || !home_type) return true;
  return types.some((t) => ZILLOW_HOME_TYPE[t] === home_type);
}

const HOME_TYPE_FILTERS: Record<HomeType, string> = {
  house: 'isSingleFamily',
  condo: 'isCondo',
  townhouse: 'isTownhouse',
  multi_family: 'isMultiFamily',
  manufactured: 'isManufactured',
  land: 'isLotLand',
  apartment: 'isApartment',
};

export interface RawListing {
  zpid?: string | number;
  address?: string;
  addressStreet?: string;
  addressCity?: string;
  addressState?: string;
  addressZipcode?: string;
  beds?: number;
  baths?: number;
  area?: number;
  price?: number;
  unformattedPrice?: number;
  hdpData?: {
    homeInfo?: {
      zpid?: number;
      price?: number;
      bedrooms?: number;
      bathrooms?: number;
      livingArea?: number;
      homeType?: string;
      homeStatus?: string;
      streetAddress?: string;
      city?: string;
      state?: string;
      zipcode?: string;
      latitude?: number;
      longitude?: number;
      zestimate?: number;
      rentZestimate?: number;
      /** Epoch ms; present on recently-sold results. */
      dateSold?: number;
      daysOnZillow?: number;
    };
  };
  detailUrl?: string;
  imgSrc?: string;
  statusType?: string;
}

export interface FormattedListing {
  zpid: string;
  address: string;
  city?: string;
  state?: string;
  zipcode?: string;
  price?: number;
  beds?: number;
  baths?: number;
  living_area?: number;
  home_type?: string;
  status?: string;
  latitude?: number;
  longitude?: number;
  zestimate?: number;
  rent_zestimate?: number;
  /** YYYY-MM-DD; only on sold results. */
  sold_date?: string;
  days_on_zillow?: number;
  image_url?: string;
  url?: string;
}

export function formatListing(raw: RawListing): FormattedListing | null {
  const info = raw.hdpData?.homeInfo ?? {};
  const zpid = String(info.zpid ?? raw.zpid ?? '');
  if (!zpid) return null;
  const url = raw.detailUrl
    ? raw.detailUrl.startsWith('http')
      ? raw.detailUrl
      : `https://www.zillow.com${raw.detailUrl}`
    : `https://www.zillow.com/homedetails/${zpid}_zpid/`;
  return {
    zpid,
    address:
      raw.address ??
      [info.streetAddress, info.city, info.state, info.zipcode]
        .filter(Boolean)
        .join(', '),
    city: info.city ?? raw.addressCity,
    state: info.state ?? raw.addressState,
    zipcode: info.zipcode ?? raw.addressZipcode,
    price: info.price ?? raw.unformattedPrice ?? raw.price,
    beds: info.bedrooms ?? raw.beds,
    baths: info.bathrooms ?? raw.baths,
    living_area: info.livingArea ?? raw.area,
    home_type: info.homeType,
    status: info.homeStatus ?? raw.statusType,
    latitude: info.latitude,
    longitude: info.longitude,
    zestimate: info.zestimate,
    rent_zestimate: info.rentZestimate,
    ...(typeof info.dateSold === 'number' && info.dateSold > 0
      ? { sold_date: new Date(info.dateSold).toISOString().slice(0, 10) }
      : {}),
    ...(typeof info.daysOnZillow === 'number' && info.daysOnZillow >= 0
      ? { days_on_zillow: info.daysOnZillow }
      : {}),
    image_url: raw.imgSrc,
    url,
  };
}

export interface SearchInput {
  location: string;
  status?: 'for_sale' | 'for_rent' | 'sold';
  price_min?: number;
  price_max?: number;
  beds_min?: number;
  baths_min?: number;
  home_types?: HomeType[];
  limit?: number;
  /**
   * Internal: when paginating server-side (issue #54), the second and
   * subsequent filter calls pin `pagination.currentPage` in the sqs.
   * Not surfaced on the tool input — see the registerSearchTools
   * handler for the public `auto_paginate` flag.
   */
  page?: number;
  /** Optional map viewport; intersects the resolved region (tiling / sweeps). */
  map_bounds?: MapBounds;
}

export interface RegionSelection {
  regionId: number;
  regionType: number;
}

export interface MapBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface ResolvedRegion {
  regionSelection: RegionSelection[];
  mapBounds: MapBounds;
}

/**
 * Tokenize a freetext location into lowercase alphanumeric words, used
 * to fuzzy-validate that returned listings match the caller's query.
 *
 * CONSOLIDATION (cohort migration realty-mcp#1): delegates to
 * realty-core's canonical `tokenize`. Canonical behavior is intentionally
 * BROADER/cleaner than the old local `length >= 2` filter — it drops
 * sub-3-char tokens (EXCEPT a leading numeric street number), which
 * absorbs USPS-abbreviation and state-code noise (`Ln`, `St`, `NC`) so
 * the fuzzy-match signal is more discriminating. The downstream
 * `listingsMatchLocation` already excluded 2-letter state codes from the
 * match set, so dropping `nc` at tokenise time is behavior-preserving for
 * the mismatch guard while removing a class of false positives.
 */
export function locationTokens(location: string): string[] {
  return tokenize(location);
}

/**
 * Reject 2-letter US state abbreviations from the discriminating-token
 * set — they appear inside thousands of unrelated addresses and turn
 * "NY"-anywhere into a false-positive match for any Brooklyn fallback.
 * We still keep them in the input tokens (so the caller's "NY" isn't
 * lost from the error message), but mismatch detection uses the
 * non-state subset.
 */
const US_STATE_CODES: ReadonlySet<string> = new Set(
  // realty-core's ZIP-prefix table already enumerates every USPS state /
  // territory / military code (fleet-audit#1144) — derive the set from it,
  // as compass does, instead of hand-maintaining a 52-entry copy.
  Object.values(FIRST_DIGIT_TO_STATES).flatMap((states) =>
    [...states].map((code) => code.toLowerCase())
  )
);

/**
 * Return true when at least one of the `listings`' addresses contains
 * one of the `inputTokens`. Used to detect Zillow's silent fallback to
 * the user's default region — Brooklyn listings for a Lake Lure query
 * share no non-state tokens.
 */
export function listingsMatchLocation(
  listings: RawListing[],
  inputTokens: string[]
): boolean {
  // Drop noise tokens (state codes); we need a discriminating signal.
  const discriminating = inputTokens.filter((t) => !US_STATE_CODES.has(t));
  if (discriminating.length === 0) return true; // nothing to check
  for (const l of listings) {
    const info = l.hdpData?.homeInfo ?? {};
    const haystack = [
      info.streetAddress,
      info.city,
      info.state,
      info.zipcode,
      l.address,
      l.addressStreet,
      l.addressCity,
      l.addressState,
      l.addressZipcode,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    for (const tok of discriminating) {
      if (haystack.includes(tok)) return true;
    }
  }
  return false;
}

/**
 * Construct the `searchQueryState` object that Zillow's SSR page reads
 * from the `?searchQueryState=` query param. When `region` is provided
 * the result pins `regionSelection` + `mapBounds`, which is required
 * for Zillow to honor the URL slug instead of falling back to the
 * user's last region.
 */
export function buildSearchQueryState(
  input: SearchInput,
  region?: ResolvedRegion
): Record<string, unknown> {
  const filterState: Record<string, unknown> = {};
  switch (input.status ?? 'for_sale') {
    case 'for_rent':
      filterState.isForRent = { value: true };
      filterState.isForSaleByAgent = { value: false };
      filterState.isForSaleByOwner = { value: false };
      filterState.isNewConstruction = { value: false };
      filterState.isComingSoon = { value: false };
      filterState.isAuction = { value: false };
      filterState.isForSaleForeclosure = { value: false };
      break;
    case 'sold':
      filterState.isRecentlySold = { value: true };
      filterState.isForSaleByAgent = { value: false };
      filterState.isForSaleByOwner = { value: false };
      filterState.isNewConstruction = { value: false };
      filterState.isComingSoon = { value: false };
      filterState.isAuction = { value: false };
      filterState.isForSaleForeclosure = { value: false };
      break;
    default:
      break;
  }
  if (input.price_min !== undefined || input.price_max !== undefined) {
    filterState.price = {
      ...(input.price_min !== undefined ? { min: input.price_min } : {}),
      ...(input.price_max !== undefined ? { max: input.price_max } : {}),
    };
  }
  if (input.beds_min !== undefined) {
    filterState.beds = { min: input.beds_min };
  }
  if (input.baths_min !== undefined) {
    filterState.baths = { min: input.baths_min };
  }
  if (input.home_types && input.home_types.length > 0) {
    // Zillow includes every type it is not told to exclude, so a filter
    // that only switches the wanted types on narrows nothing.
    for (const ht of Object.keys(HOME_TYPE_FILTERS) as HomeType[]) {
      filterState[HOME_TYPE_FILTERS[ht]] = { value: input.home_types.includes(ht) };
    }
  }
  const sqs: Record<string, unknown> = {
    usersSearchTerm: input.location,
    filterState,
    isListVisible: true,
    isMapVisible: false,
  };
  if (region) {
    sqs.regionSelection = region.regionSelection;
    sqs.mapBounds = region.mapBounds;
  }
  if (input.map_bounds) {
    // A caller-supplied viewport narrows the search to that box (Zillow's
    // list results are the region ∩ the visible map), which is how a dense
    // market is enumerated tile by tile under the per-query page cap.
    sqs.mapBounds = input.map_bounds;
    sqs.isMapVisible = true;
  }
  if (input.page !== undefined && input.page > 1) {
    sqs.pagination = { currentPage: input.page };
  }
  return sqs;
}

/**
 * Build the search URL. When `sqs` is null, returns the bare
 * `/homes/<slug>_rb/` path used for the resolve step.
 */
export function buildSearchPath(
  location: string,
  sqs?: Record<string, unknown>
): string {
  const slug = encodeURIComponent(location.trim());
  if (!sqs) return `/homes/${slug}_rb/`;
  const qs = encodeURIComponent(JSON.stringify(sqs));
  return `/homes/${slug}_rb/?searchQueryState=${qs}`;
}

interface ZillowPageState {
  queryState?: {
    regionSelection?: RegionSelection[];
    mapBounds?: MapBounds;
  };
  cat1?: {
    searchResults?: { listResults?: RawListing[] };
    searchList?: { totalResultCount?: number; totalPages?: number; resultsPerPage?: number };
  };
  categoryTotals?: { cat1?: { totalResultCount?: number } };
}

/**
 * Zillow's own count of matching listings for a search page, or null when
 * the page doesn't carry one (shape drift). Read from `cat1.searchList`
 * first, then `categoryTotals.cat1`.
 */
export function totalResultCount(sps: ZillowPageState | null): number | null {
  const a = sps?.cat1?.searchList?.totalResultCount;
  if (typeof a === 'number' && a >= 0) return a;
  const b = sps?.categoryTotals?.cat1?.totalResultCount;
  if (typeof b === 'number' && b >= 0) return b;
  return null;
}

/**
 * Re-apply the numeric filters to a formatted listing. Zillow has been seen
 * relaxing filters on later pages; a listing whose field is missing is kept.
 */
export function passesNumericFilters(f: FormattedListing, input: SearchInput): boolean {
  if (input.price_min !== undefined && f.price !== undefined && f.price < input.price_min) return false;
  if (input.price_max !== undefined && f.price !== undefined && f.price > input.price_max) return false;
  if (input.beds_min !== undefined && f.beds !== undefined && f.beds < input.beds_min) return false;
  if (input.baths_min !== undefined && f.baths !== undefined && f.baths < input.baths_min) return false;
  return true;
}

/** True when a listing with coordinates sits outside the bounds (with a small tolerance). */
export function outsideBounds(f: FormattedListing, b: MapBounds, tol = 0.002): boolean {
  if (f.latitude === undefined || f.longitude === undefined) return false;
  return (
    f.latitude > b.north + tol ||
    f.latitude < b.south - tol ||
    f.longitude > b.east + tol ||
    f.longitude < b.west - tol
  );
}

export interface SearchMeta {
  /** Zillow's own total for the query, or null when the page carried none. */
  total_result_count: number | null;
  pages_fetched: number;
  /** Unique listings seen on the fetched pages (before the filter guard). */
  fetched: number;
  /** Listings dropped because Zillow returned them outside the numeric filters. */
  dropped_filter_guard: number;
  /** Listings that passed the home-type and numeric guards (what the total should count). */
  matched: number;
  /** Zillow's total minus `matched` when positive: matches Zillow counted that this search did not return. */
  shortfall: number;
  /** Up to 200 listings dropped by the guards, with the reason (for auditing filter drift). */
  dropped: Array<{ zpid: string; address: string; price?: number; beds?: number; baths?: number; home_type?: string; reason: string }>;
  /** Listings dropped by the home-type guard. */
  dropped_home_type: number;
  /** Listings outside `map_bounds` (Zillow ignoring the viewport). */
  outside_bounds: number;
  /** True when Zillow reports more matches than were fetched. */
  truncated: boolean;
  /** Why the page walk stopped. */
  stop_reason: 'limit' | 'empty_page' | 'repeat_page' | 'single_page' | 'max_pages' | 'budget' | 'page_error' | 'over_split_threshold';
  /** Set when stop_reason is 'page_error': the error from the page that failed. */
  page_error?: string;
}

/**
 * One filtered search over a resolved region, walking pages until the
 * limit / an empty page / a repeated page. Returns the listings plus a
 * completeness report so callers can tell a full answer from a capped one.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runRegionSearch(
  client: ZillowClient,
  input: SearchInput & { auto_paginate?: boolean },
  region: ResolvedRegion,
  limit: number,
  opts: {
    splitAbove?: number;
    /** Hard cap on pages fetched (a caller's remaining request budget); hitting it stops with `budget`. */
    maxPages?: number;
    /** Pause before every page after the first. */
    delayMs?: number;
  } = {}
): Promise<{ results: FormattedListing[]; meta: SearchMeta }> {
  const autoPaginate = input.auto_paginate !== false;
  const wantsMore = autoPaginate && limit > ZILLOW_PAGE_SIZE;
  const aggregated: FormattedListing[] = [];
  const seen = new Set<string>();
  let total: number | null = null;
  let pages = 0;
  let droppedFilter = 0;
  let droppedType = 0;
  let outside = 0;
  const dropped: SearchMeta['dropped'] = [];
  const drop = (f: FormattedListing, reason: string) => {
    if (dropped.length < 200) dropped.push({ zpid: f.zpid, address: f.address, price: f.price, beds: f.beds, baths: f.baths, home_type: f.home_type, reason });
  };
  const pageCap = Math.min(MAX_PAGES, opts.maxPages ?? MAX_PAGES);
  let stop: SearchMeta['stop_reason'] = pageCap < MAX_PAGES ? 'budget' : 'max_pages';
  let pageError: string | undefined;
  for (let page = 1; page <= pageCap; page++) {
    if (page > 1 && opts.delayMs) await sleep(opts.delayMs);
    const sqs = buildSearchQueryState({ ...input, page }, region);
    let html: string;
    try {
      html = await client.fetchHtml(buildSearchPath(input.location, sqs));
    } catch (e) {
      // Zillow answers deep pages (e.g. page 25 of a large sold search) with
      // a 400. Keep what earlier pages returned and report the truncation;
      // only a failing first page is a real error.
      if (page === 1) throw e;
      stop = 'page_error';
      pageError = e instanceof Error ? e.message.slice(0, 200) : String(e);
      break;
    }
    const sps = extractSearchPageState(html);
    pages++;
    if (total === null) total = totalResultCount(sps);
    if (page === 1 && opts.splitAbove !== undefined && total !== null && total > opts.splitAbove) {
      // The caller will split this area anyway; don't page through it.
      stop = 'over_split_threshold';
      break;
    }
    const raw = sps?.cat1?.searchResults?.listResults ?? [];
    if (raw.length === 0) { stop = 'empty_page'; break; }
    let added = 0;
    for (const r of raw) {
      const f = formatListing(r);
      if (!f || seen.has(f.zpid)) continue;
      seen.add(f.zpid);
      added++;
      if (input.map_bounds && outsideBounds(f, input.map_bounds)) outside++;
      if (!matchesHomeTypes(f.home_type, input.home_types)) { droppedType++; drop(f, 'home_type'); continue; }
      if (!passesNumericFilters(f, input)) { droppedFilter++; drop(f, filterFailure(f, input)); continue; }
      aggregated.push(f);
      if (aggregated.length >= limit) break;
    }
    if (added === 0) { stop = 'repeat_page'; break; }
    if (aggregated.length >= limit) { stop = 'limit'; break; }
    if (!wantsMore) { stop = 'single_page'; break; }
  }
  const fetched = seen.size;
  const matched = fetched - droppedFilter - droppedType;
  const shortfall = total !== null ? Math.max(0, total - matched) : 0;
  // Truncated when Zillow served fewer listings than it counted (it stopped
  // paging early), or when filter-passing matches fall short of the total and
  // we stopped paging ourselves. Zillow pads pages with off-filter listings,
  // so `fetched` alone can exceed the total while matches are still missing;
  // a shortfall after Zillow ran out of pages is a guard disagreement, which
  // the caller sees as `shortfall` + `dropped`.
  const stoppedEarly = stop === 'max_pages' || stop === 'budget' || stop === 'limit' || stop === 'single_page' || stop === 'page_error' || stop === 'over_split_threshold';
  const truncated = total !== null ? total > fetched || (shortfall > 0 && stoppedEarly) : stoppedEarly;
  return {
    results: aggregated.slice(0, limit),
    meta: {
      total_result_count: total,
      pages_fetched: pages,
      fetched,
      dropped_filter_guard: droppedFilter,
      dropped_home_type: droppedType,
      matched,
      shortfall,
      dropped,
      outside_bounds: outside,
      truncated,
      stop_reason: stop,
      ...(pageError ? { page_error: pageError } : {}),
    },
  };
}

/**
 * Parse the `searchPageState` blob out of a Zillow SSR page response.
 */
export function extractSearchPageState(html: string): ZillowPageState | null {
  const nextData = extractNextData(html);
  const pageProps = getPageProps(nextData);
  return (pageProps.searchPageState as ZillowPageState | undefined) ?? null;
}

/**
 * First photo URL off a homedetails property, across the field variants
 * Zillow uses (`photos` on rich/Showcase pages, `responsivePhotos` on the
 * lean shape, `originalPhotos` legacy). Gives the adapted listing an
 * `image_url` like a real search hit. RawProperty doesn't type the photo
 * arrays (they live on the photos-tool shape), so we read them defensively.
 */
function firstPhotoUrl(p: RawProperty): string | undefined {
  const pp = p as {
    photos?: Array<{ url?: string }>;
    responsivePhotos?: Array<{ url?: string }>;
    originalPhotos?: Array<{ url?: string }>;
    hiResImageLink?: string;
  };
  return (
    pp.photos?.[0]?.url ??
    pp.responsivePhotos?.[0]?.url ??
    pp.originalPhotos?.[0]?.url ??
    pp.hiResImageLink
  );
}

/**
 * Adapt a homedetails `property` (gdpClientCache shape) into the
 * search-result `RawListing` shape so {@link formatListing} can render it
 * identically to a real search hit. Used when a full-address query
 * resolves directly to ONE listing — Zillow serves the homedetails page
 * (no `searchPageState`), so there's a `property` but no `listResults`.
 */
export function listingFromProperty(p: RawProperty): RawListing {
  const zpidNum =
    typeof p.zpid === 'number'
      ? p.zpid
      : typeof p.zpid === 'string' && /^\d+$/.test(p.zpid)
        ? Number(p.zpid)
        : undefined;
  return {
    zpid: p.zpid,
    hdpData: {
      homeInfo: {
        zpid: zpidNum,
        price: p.price,
        bedrooms: p.bedrooms,
        bathrooms: p.bathrooms,
        livingArea: p.livingArea,
        homeType: p.homeType,
        homeStatus: p.homeStatus,
        streetAddress: p.address?.streetAddress,
        city: p.address?.city,
        state: p.address?.state,
        zipcode: p.address?.zipcode,
        latitude: p.latitude,
        longitude: p.longitude,
        zestimate: p.zestimate,
        rentZestimate: p.rentZestimate,
      },
    },
    detailUrl: p.hdpUrl,
    imgSrc: firstPhotoUrl(p),
  };
}

/**
 * When a search response carries no `searchPageState`, it may be a
 * homedetails page Zillow served because the query resolved to a single
 * listing. Return that one property adapted to a `RawListing`, or null.
 * Takes already-parsed `pageProps` (the caller has it) to avoid re-parsing
 * the SSR `__NEXT_DATA__` blob.
 */
export function singleListingFromPageProps(
  pageProps: Record<string, unknown>
): RawListing | null {
  const property = findPropertyInPageProps(pageProps);
  if (!property?.zpid) return null;
  return listingFromProperty(property);
}

/**
 * Result of `resolveLocation`. Either we got a region (city/ZIP-level
 * handle that we can pin into a second filter-step request), OR we got
 * matching listings directly (address- or street-specific queries
 * where Zillow's resolver returns the property without first synthesizing
 * a region). The second branch is the `zillow_search_properties` fix
 * for issue #31 — full-address and neighborhood-street queries used to
 * throw `LocationNotResolved` even though Zillow had returned the
 * matching listings, because the resolver couldn't pin a region.
 */
export type ResolvedLocation =
  | { kind: 'region'; region: ResolvedRegion }
  | { kind: 'listings'; listings: RawListing[] };

/**
 * Step 1 of search: fetch the bare `/homes/<slug>_rb/` page and pull
 * out either a region OR a set of listings that match the caller's
 * input. Throws `LocationNotResolved` on geocoder miss, silent
 * fallback, or if nothing usable comes back at all.
 *
 * The two-branch return is deliberate: regions feed the filtered step
 * 2 request; listings short-circuit to a single-round-trip reply for
 * address- and street-level queries (see issue #31).
 */
export async function resolveLocation(
  client: ZillowClient,
  location: string
): Promise<ResolvedRegion> {
  // Back-compat shim: callers that only care about the region branch
  // keep getting a `ResolvedRegion` (throws if Zillow returned an
  // address-style result with no region pinned). The richer
  // `resolveLocationOrListings` exposes both branches.
  const resolved = await resolveLocationOrListings(client, location);
  if (resolved.kind === 'region') return resolved.region;
  // The address-listings branch has no region — we can't pin a filter.
  // Give the same error as the old code so prior callers still get a
  // clean `LocationNotResolved`.
  throw new LocationNotResolved(
    location,
    'Zillow returned no resolved region for that input'
  );
}

/**
 * The full step-1 resolver. Returns a `ResolvedLocation` discriminated
 * by the kind of handle Zillow gave us. See `ResolvedLocation`.
 */
export async function resolveLocationOrListings(
  client: ZillowClient,
  location: string
): Promise<ResolvedLocation> {
  const html = await client.fetchHtml(buildSearchPath(location));
  // Parse `__NEXT_DATA__` → pageProps once; both the searchPageState and the
  // homedetails-redirect property come from the same blob.
  const pageProps = getPageProps(extractNextData(html));
  const sps = (pageProps.searchPageState as ZillowPageState | undefined) ?? null;
  if (!sps) {
    // Bug #2: a full-address query can resolve DIRECTLY to one listing —
    // Zillow then serves the homedetails page (gdpClientCache property, no
    // searchPageState) instead of a search-results page. Surface that
    // single property as the resolved listing rather than erroring.
    const single = singleListingFromPageProps(pageProps);
    if (single) {
      return { kind: 'listings', listings: [single] };
    }
    throw new LocationNotResolved(
      location,
      'Zillow returned a page with no searchPageState'
    );
  }
  const regionSelection = sps.queryState?.regionSelection ?? [];
  const mapBounds = sps.queryState?.mapBounds;
  const listResults = sps.cat1?.searchResults?.listResults ?? [];
  const tokens = locationTokens(location);

  if (regionSelection.length === 0 || !mapBounds) {
    // No region was pinned. Issue #31: address- and street-level
    // queries land here. Surface the listings directly when they
    // actually match the user's input — otherwise we have nothing
    // useful to return.
    if (listResults.length === 0) {
      throw new LocationNotResolved(
        location,
        'Zillow returned no resolved region for that input'
      );
    }
    if (!listingsMatchLocation(listResults, tokens)) {
      const first = listResults[0]?.hdpData?.homeInfo;
      const fallbackTo = first
        ? `${first.city ?? '?'}, ${first.state ?? '?'} ${first.zipcode ?? ''}`.trim()
        : 'an unknown region';
      throw new LocationNotResolved(
        location,
        `Zillow returned listings from ${fallbackTo} but no region match for the input`
      );
    }
    return { kind: 'listings', listings: listResults };
  }
  // Region pinned. Check it didn't silently fall back to an unrelated
  // place (the classic Brooklyn-for-Lake-Lure case).
  if (
    listResults.length > 0 &&
    !listingsMatchLocation(listResults, tokens)
  ) {
    const first = listResults[0]?.hdpData?.homeInfo;
    const fallbackTo = first
      ? `${first.city ?? '?'}, ${first.state ?? '?'} ${first.zipcode ?? ''}`.trim()
      : 'an unknown region';
    throw new LocationNotResolved(
      location,
      `Zillow silently fell back to ${fallbackTo} (regionId ${regionSelection[0].regionId})`
    );
  }
  return { kind: 'region', region: { regionSelection, mapBounds } };
}

// Zillow renders ~40 listings per SSR search page (issue #54).
const ZILLOW_PAGE_SIZE = 40;
// Safety net so a misbehaving Zillow that never returns an empty page
// can't run away with our request budget.
const MAX_PAGES = 25;
// The most auto-pagination can ever return (fleet-audit#291) — a larger
// `limit` would only force a walk of every page.
const SEARCH_LIMIT_MAX = MAX_PAGES * ZILLOW_PAGE_SIZE;

export function registerSearchTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_search_properties',
    {
      title: 'Search Zillow listings',
      description:
        "Search Zillow listings by location (city, ZIP, neighborhood, or address) and optional filters (status, price band, beds/baths minimums, home types). Returns matching properties with price, beds/baths, sqft, Zestimate, status, image, and homedetails URL. Works with city/ZIP-level queries (filtered against your criteria) AND with full-address or street-only queries (returns the listings Zillow resolves to directly — filters are not applied in this single-round-trip path; use zillow_get_by_address for the cleanest one-shot address → zpid lookup). Throws LocationNotResolved if Zillow can't pin either a region or matching listings for the input (instead of silently falling back to your default search region). Heads up: Zillow renders ~40 listings per page server-side; this tool auto-paginates by default when `limit` exceeds that, walking subsequent pages and concatenating results (set `auto_paginate: false` to opt out and get the single-page response). For dense markets, price-band the search to enumerate fully. Does NOT return Zestimate history — use zillow_get_zestimate_history for that. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Search Zillow listings',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),
        location: z
          .string()
          .describe(
            'Free-text location: city, ZIP, neighborhood, or address (e.g. "Brooklyn, NY", "94110", "Park Slope")'
          ),
        status: z
          .enum(['for_sale', 'for_rent', 'sold'])
          .optional()
          .describe('Listing status. Default for_sale.'),
        price_min: z.number().int().nonnegative().optional(),
        price_max: z.number().int().nonnegative().optional(),
        beds_min: z.number().int().nonnegative().optional(),
        baths_min: z.number().int().nonnegative().optional(),
        home_types: z
          .array(
            z.enum([
              'house',
              'condo',
              'townhouse',
              'multi_family',
              'manufactured',
              'land',
              'apartment',
            ])
          )
          .optional()
          .describe('Restrict to one or more home types.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(SEARCH_LIMIT_MAX)
          .optional()
          .describe(
            'Max listings to return (default 40, max 1000). When > 40 and `auto_paginate` is true (the default), the tool walks Zillow\'s pagination server-side and aggregates pages until `limit` is reached, an empty page is returned, or a page adds no new listings. Zillow caps each search response at ~40 listings (issue #54).'
          ),
        map_bounds: z
          .object({ north: z.number(), south: z.number(), east: z.number(), west: z.number() })
          .optional()
          .describe('Optional map viewport (lat/lng box) to intersect with the location — use to tile dense markets.'),
        include_meta: z
          .boolean()
          .optional()
          .describe('When true, return {meta, results}: meta carries Zillow\'s own total_result_count, pages fetched, listings dropped by the filter/home-type guards, and `truncated` (more matches exist than were returned).'),
        auto_paginate: z
          .boolean()
          .optional()
          .describe(
            'When true (default), aggregate across Zillow\'s paginated search responses until `limit` is reached. Pass `false` to disable pagination — only one Zillow page is fetched (~40 listings).'
          ),
      }),
    },
    // `view` is destructured off the input rather than read through an
    // `(input as { view?: string })` cast, matching `zillow_resolve_addresses`.
    // The cast was not merely untidy: it asserted a shape instead of reading
    // the inferred one, so dropping `view` from the schema would have left it
    // compiling and silently always-undefined. The rest keeps its own name so
    // `{ ...input, page }` below carries only Zillow query fields — inert
    // either way (`buildSearchQueryState` reads named fields, never a spread),
    // but the type now says so.
    async ({ view, include_meta, ...input }) => {
      const limit = input.limit ?? 40;
      // Step 1: resolve. Either we got a region we can pin into a
      // filtered second request, or we got an address-shaped match
      // where Zillow's resolver returned the listing directly.
      const resolved = await resolveLocationOrListings(client, input.location);
      if (resolved.kind === 'listings') {
        // Single-round-trip path (issue #31): no region to pin, so a
        // second filtered request would just produce a different
        // arbitrary set. Skip step 2 and surface what the resolver
        // gave us. Filters from `input` are not applied here — when
        // the resolver returns a specific listing, filters narrowing
        // it further don't add value.
        const formatted = resolved.listings
          .map(formatListing)
          .filter((x): x is FormattedListing => x !== null)
          .slice(0, limit);
        return viewResponse(view, formatted);
      }
      // Step 2: filtered search with the region pinned in, paginated, with a
      // completeness report (Zillow's own total vs what was fetched) so a
      // capped answer is never mistaken for a complete one.
      const { results, meta } = await runRegionSearch(client, input, resolved.region, limit);
      if (include_meta) {
        return viewResponse(view, { meta, results });
      }
      if (meta.stop_reason === 'page_error') {
        // A deep page failed and earlier pages were kept: never let that pass
        // as a complete answer just because the caller didn't ask for meta.
        return viewResponse(view, {
          warning: `Results truncated: Zillow failed on page ${meta.pages_fetched + 1} (${meta.page_error}); returning the ${results.length} listings from earlier pages.`,
          meta,
          results,
        });
      }
      return viewResponse(view, results);
    }
  );

  server.registerTool(
    'zillow_sweep_area',
    {
      title: 'Exhaustively sweep a Zillow search area',
      description:
        "Enumerate EVERY Zillow listing matching the filters inside a location (resolved like zillow_search_properties) or an explicit bounding box, without silent truncation. Splits the area into map tiles and recursively quarters any tile whose Zillow-reported total exceeds what one query can return, dedupes by zpid and re-applies the numeric filters (drift guard). Returns a completeness summary (requests, tiles, unique listings, tiles still truncated at max depth, drift warnings such as Zillow ignoring the price filter or the viewport) plus the listings, or writes the listings to `output_path` as JSON for large areas. Sequential requests with a delay. Read-only against Zillow; the only write is the optional local output file.",
      annotations: { title: 'Sweep Zillow area', readOnlyHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        location: z.string().describe('City / ZIP / county used to resolve the region (e.g. "King County, WA").'),
        bounds: z
          .object({ north: z.number(), south: z.number(), east: z.number(), west: z.number() })
          .optional()
          .describe('Optional box to sweep; defaults to the resolved region\'s map bounds.'),
        status: z.enum(['for_sale', 'for_rent', 'sold']).optional(),
        price_min: z.number().int().nonnegative().optional(),
        price_max: z.number().int().nonnegative().optional(),
        beds_min: z.number().int().nonnegative().optional(),
        baths_min: z.number().int().nonnegative().optional(),
        home_types: z.array(z.enum(['house', 'condo', 'townhouse', 'multi_family', 'manufactured', 'land', 'apartment'])).optional(),
        max_depth: z.number().int().min(0).max(8).optional().describe('Max quarterings per tile (default 6).'),
        tile_cap: z.number().int().positive().max(1000).optional().describe('Treat a tile as complete only if its total is at most this (default 400).'),
        delay_ms: z.number().int().min(0).max(10000).optional().describe('Pause before every Zillow request, including each page within a tile (default 1200).'),
        max_requests: z.number().int().positive().max(400).optional().describe('Hard request budget (default 150), counting the resolve call and every page; the sweep stops mid-tile rather than exceed it.'),
        output_path: z.string().optional().describe('Optional absolute path of a NEW .json file to write the full results (and per-tile counts) to; an existing file is never overwritten. Omit to get the results inline; use a file for large areas so the listings stay out of the conversation.'),
      }),
    },
    async (input) => {
      return minifiedResult(await sweepArea(client, input));
    }
  );
}

export interface SweepInput {
  location: string;
  bounds?: MapBounds;
  status?: 'for_sale' | 'for_rent' | 'sold';
  price_min?: number;
  price_max?: number;
  beds_min?: number;
  baths_min?: number;
  home_types?: HomeType[];
  max_depth?: number;
  tile_cap?: number;
  delay_ms?: number;
  max_requests?: number;
  output_path?: string;
}

/** Which numeric filter a listing fails (first match). */
export function filterFailure(f: FormattedListing, input: SearchInput): string {
  if (input.price_min !== undefined && f.price !== undefined && f.price < input.price_min) return 'price_below_min';
  if (input.price_max !== undefined && f.price !== undefined && f.price > input.price_max) return 'price_above_max';
  if (input.beds_min !== undefined && f.beds !== undefined && f.beds < input.beds_min) return 'beds_below_min';
  if (input.baths_min !== undefined && f.baths !== undefined && f.baths < input.baths_min) return 'baths_below_min';
  return 'other';
}

/**
 * `output_path` comes from the model, so guard it before any request: an
 * absolute path (a relative one would land wherever the server's cwd is), a
 * `.json` file (not a dotfile or script), and never an existing file.
 */
export function assertWritableOutputPath(p: string): void {
  if (!isAbsolute(p)) throw new Error(`output_path must be an absolute path; got "${p}".`);
  if (extname(p).toLowerCase() !== '.json') throw new Error(`output_path must end in .json; got "${p}".`);
  if (existsSync(p)) throw new Error(`output_path ${p} already exists; refusing to overwrite it. Pass a new file path.`);
}

/** Split a box into four quadrants. */
export function quarter(b: MapBounds): MapBounds[] {
  const mLat = (b.north + b.south) / 2;
  const mLng = (b.east + b.west) / 2;
  return [
    { north: b.north, south: mLat, west: b.west, east: mLng },
    { north: b.north, south: mLat, west: mLng, east: b.east },
    { north: mLat, south: b.south, west: b.west, east: mLng },
    { north: mLat, south: b.south, west: mLng, east: b.east },
  ];
}

export async function sweepArea(client: ZillowClient, input: SweepInput) {
  const maxDepth = input.max_depth ?? 6;
  const tileCap = input.tile_cap ?? 400;
  const delay = input.delay_ms ?? 1200;
  const budget = input.max_requests ?? 150;
  if (input.output_path !== undefined) assertWritableOutputPath(input.output_path);
  const resolved = await resolveLocationOrListings(client, input.location);
  if (resolved.kind !== 'region') {
    throw new LocationNotResolved(input.location, 'sweeps need a region (city, ZIP, county), not an address');
  }
  const root = input.bounds ?? resolved.region.mapBounds;
  const byZpid = new Map<string, FormattedListing & { tile: string }>();
  const tiles: Array<{ id: string; bounds: MapBounds; depth: number; total: number | null; fetched: number; kept: number; truncated: boolean; split: boolean; outside_bounds: number; dropped_filter_guard: number; matched?: number; shortfall?: number }> = [];
  const droppedAll = new Map<string, SearchMeta['dropped'][number] & { tile: string }>();
  const tileErrors: Array<{ id: string; bounds: MapBounds; error: string }> = [];
  const warnings = new Set<string>();
  let requests = 1; // the resolve call
  let budgetHit = false;
  const queue: Array<{ id: string; b: MapBounds; depth: number }> = [{ id: 't', b: root, depth: 0 }];
  while (queue.length) {
    const t = queue.shift()!;
    if (requests >= budget) { budgetHit = true; tiles.push({ id: t.id, bounds: t.b, depth: t.depth, total: null, fetched: 0, kept: 0, truncated: true, split: false, outside_bounds: 0, dropped_filter_guard: 0 }); continue; }
    if (delay) await sleep(delay);
    let res: Awaited<ReturnType<typeof runRegionSearch>>;
    try {
      res = await runRegionSearch(
      client,
      { location: input.location, status: input.status, price_min: input.price_min, price_max: input.price_max, beds_min: input.beds_min, baths_min: input.baths_min, home_types: input.home_types, map_bounds: t.b, auto_paginate: true },
      resolved.region,
      SEARCH_LIMIT_MAX,
      { splitAbove: t.depth < maxDepth ? tileCap : undefined, maxPages: budget - requests, delayMs: delay }
    );
    } catch (e) {
      // One failing tile must not discard the rest of the sweep.
      requests += 1;
      tileErrors.push({ id: t.id, bounds: t.b, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      tiles.push({ id: t.id, bounds: t.b, depth: t.depth, total: null, fetched: 0, kept: 0, truncated: true, split: false, outside_bounds: 0, dropped_filter_guard: 0 });
      continue;
    }
    const { results, meta } = res;
    requests += meta.pages_fetched;
    if (meta.stop_reason === 'budget' && meta.truncated) budgetHit = true;
    if (meta.stop_reason === 'page_error') warnings.add('Zillow refused a deep result page (HTTP error) on some tiles; those tiles kept what earlier pages returned and count as truncated.');
    if (meta.total_result_count === null) warnings.add('Zillow returned no total count on some tiles (shape drift?) — completeness for those tiles inferred from paging only.');
    if (meta.dropped_filter_guard > 0) warnings.add('Zillow returned listings outside the numeric filters; they were dropped by the guard (filter drift).');
    if (meta.outside_bounds > 0) warnings.add('Zillow returned listings outside the requested tile (viewport ignored?) — they are kept but deduped.');
    const needsSplit = (meta.truncated || (meta.total_result_count ?? 0) > tileCap) && t.depth < maxDepth;
    tiles.push({ id: t.id, bounds: t.b, depth: t.depth, total: meta.total_result_count, fetched: meta.fetched, kept: results.length, truncated: meta.truncated && !needsSplit, split: needsSplit, outside_bounds: meta.outside_bounds, dropped_filter_guard: meta.dropped_filter_guard, matched: meta.matched, shortfall: meta.shortfall });
    if (!needsSplit) {
      for (const d of meta.dropped) if (!droppedAll.has(d.zpid)) droppedAll.set(d.zpid, { ...d, tile: t.id });
      if (meta.shortfall > 0 && !meta.truncated) warnings.add('Zillow counted more matches than passed the local filter guard on some tiles (Zillow and the guard disagree about a few listings, e.g. half-baths) — see `dropped` in the output file.');
    }
    if (needsSplit) {
      quarter(t.b).forEach((q, k) => queue.push({ id: `${t.id}${k}`, b: q, depth: t.depth + 1 }));
      continue; // children re-fetch this area; don't double count
    }
    for (const r of results) if (!byZpid.has(r.zpid)) byZpid.set(r.zpid, { ...r, tile: t.id });
  }
  const leaves = tiles.filter((t) => !t.split);
  const stillTruncated = leaves.filter((t) => t.truncated);
  const out = {
    source: 'zillow',
    swept_at: new Date().toISOString(),
    query: { ...input, output_path: undefined },
    root_bounds: root,
    requests,
    budget_hit: budgetHit,
    tiles,
    unique_listings: byZpid.size,
    complete: !budgetHit && tileErrors.length === 0 && stillTruncated.length === 0,
    tile_errors: tileErrors,
    warnings: [...warnings],
    results: [...byZpid.values()],
    dropped: [...droppedAll.values()],
  };
  if (input.output_path) {
    mkdirSync(dirname(input.output_path), { recursive: true });
    try {
      // 'wx': never clobber a file that appeared while the sweep ran.
      writeFileSync(input.output_path, JSON.stringify(out, null, 1), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`output_path ${input.output_path} already exists; refusing to overwrite it. Pass a new file path.`);
      }
      throw e;
    }
  }
  return {
    ...(input.output_path ? { output_path: input.output_path } : {}),
    complete: out.complete,
    unique_listings: out.unique_listings,
    requests,
    leaf_tiles: leaves.length,
    split_tiles: tiles.length - leaves.length,
    truncated_leaf_tiles: stillTruncated.map((t) => ({ id: t.id, total: t.total, fetched: t.fetched, bounds: t.bounds })),
    budget_hit: budgetHit,
    ...(tileErrors.length ? { tile_errors: tileErrors } : {}),
    sum_of_leaf_totals: leaves.reduce((a, t) => a + (t.total ?? 0), 0),
    sum_of_leaf_shortfall: leaves.reduce((a, t) => a + (t.shortfall ?? 0), 0),
    dropped_by_reason: [...droppedAll.values()].reduce<Record<string, number>>((a, d) => ((a[d.reason] = (a[d.reason] ?? 0) + 1), a), {}),
    warnings: out.warnings,
    ...(input.output_path ? {} : { results: out.results }),
  };
}
