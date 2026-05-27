import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractNextData, getPageProps } from '../next-data.js';

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
 * Tokenize a freetext location into lowercase alphanumeric words of
 * length 2+, used to fuzzy-validate that returned listings match the
 * caller's query.
 */
export function locationTokens(location: string): string[] {
  return location
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * Reject 2-letter US state abbreviations from the discriminating-token
 * set — they appear inside thousands of unrelated addresses and turn
 * "NY"-anywhere into a false-positive match for any Brooklyn fallback.
 * We still keep them in the input tokens (so the caller's "NY" isn't
 * lost from the error message), but mismatch detection uses the
 * non-state subset.
 */
const US_STATE_CODES = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id',
  'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms',
  'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok',
  'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv',
  'wi', 'wy', 'dc', 'pr',
]);

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
    for (const ht of input.home_types) {
      filterState[HOME_TYPE_FILTERS[ht]] = { value: true };
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
  cat1?: { searchResults?: { listResults?: RawListing[] } };
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
  const sps = extractSearchPageState(html);
  if (!sps) {
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

export function registerSearchTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_search_properties',
    {
      title: 'Search Zillow listings',
      description:
        "Search Zillow listings by location (city, ZIP, neighborhood, or address) and optional filters (status, price band, beds/baths minimums, home types). Returns matching properties with price, beds/baths, sqft, Zestimate, status, image, and homedetails URL. Works with city/ZIP-level queries (filtered against your criteria) AND with full-address or street-only queries (returns the listings Zillow resolves to directly — filters are not applied in this single-round-trip path; use zillow_get_by_address for the cleanest one-shot address → zpid lookup). Throws LocationNotResolved if Zillow can't pin either a region or matching listings for the input (instead of silently falling back to your default search region). Heads up: Zillow renders ~40 listings per page server-side; this tool returns at most one page (so the effective ceiling is ~40 even when `limit` is set higher). For dense markets, price-band the search to enumerate fully. Does NOT return Zestimate history — use zillow_get_zestimate_history for that. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Search Zillow listings',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
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
          .optional()
          .describe('Max listings to return (default 40).'),
      },
    },
    async (input) => {
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
        return textResult(formatted);
      }
      // Step 2: filtered search with the region pinned in.
      const sqs = buildSearchQueryState(input, resolved.region);
      const html = await client.fetchHtml(buildSearchPath(input.location, sqs));
      const sps = extractSearchPageState(html);
      const raw = sps?.cat1?.searchResults?.listResults ?? [];
      const formatted = raw
        .map(formatListing)
        .filter((x): x is FormattedListing => x !== null)
        .slice(0, limit);
      return textResult(formatted);
    }
  );
}
