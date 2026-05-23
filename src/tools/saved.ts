import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractNextData, getPageProps } from '../next-data.js';
import { findArrayByShape } from '../page-props.js';

/**
 * Signed-in-user surfaces. These are the unique value zillow-mcp delivers
 * vs. Bridge-API-based competitors: a Zillow Bridge API key can't see
 * what the *signed-in user* has saved, because Bridge is MLS-partnership-
 * scoped, not user-scoped.
 *
 * Both pages are SSR Next.js with full state embedded in __NEXT_DATA__:
 *   - Saved searches: GET `/myzillow/SavedSearches` (capital S, no
 *     trailing slash). pageProps.savedSearches is the array.
 *   - Saved homes:    GET `/myzillow/favorites`. pageProps.collectionsResponse
 *     is an array of collections; we flatten homes out of each.
 *
 * URL paths and field names verified via live page inspection
 * (2026-05-23). The page-shape may still drift between deploys, so
 * `findArrayByShape` is used to try well-known keys first and fall
 * back to a shape walk.
 */

interface RawSavedSearch {
  id?: string | number;
  name?: string;
  url?: string;
  filterState?: Record<string, unknown>;
  searchQueryState?: Record<string, unknown>;
  resultsPerPage?: number;
  newCount?: number;
  totalCount?: number;
  notificationFrequency?: string;
  updatedAt?: string;
  createdAt?: string;
}

interface RawSavedHome {
  zpid?: number | string;
  hdpUrl?: string;
  address?: {
    streetAddress?: string;
    city?: string;
    state?: string;
    zipcode?: string;
  };
  price?: number;
  zestimate?: number;
  bedrooms?: number;
  bathrooms?: number;
  livingArea?: number;
  homeStatus?: string;
  imgSrc?: string;
  savedAt?: string;
}

interface RawCollection {
  id?: string | number;
  name?: string;
  homes?: RawSavedHome[];
  properties?: RawSavedHome[];
  items?: RawSavedHome[];
}

/** Direct field names Zillow has used for saved-search arrays. */
const SAVED_SEARCH_KEYS = ['savedSearches', 'userSavedSearches'] as const;

/**
 * Direct field names Zillow has used for saved-homes arrays at
 * the top level of pageProps. The 2026-05 favorites page wraps them
 * inside `collectionsResponse` instead (handled separately below).
 */
const SAVED_HOME_KEYS = ['savedHomes', 'userSavedHomes', 'favoriteHomes'] as const;

/**
 * Pluck the saved-searches array out of a parsed pageProps blob.
 */
export function findSavedSearches(
  pageProps: Record<string, unknown>
): RawSavedSearch[] {
  return findArrayByShape<RawSavedSearch>(
    pageProps,
    SAVED_SEARCH_KEYS,
    (el) => 'searchQueryState' in el || 'filterState' in el
  );
}

/**
 * Pluck the saved-homes array out of a parsed pageProps blob. The
 * current Zillow favorites page nests homes inside collections
 * (`pageProps.collectionsResponse: Collection[]`), each of which may
 * carry a `homes` / `properties` / `items` array of home records. We
 * flatten across collections. Falls back to the older top-level
 * `savedHomes` / `userSavedHomes` / `favoriteHomes` shapes for
 * backward-compat.
 */
export function findSavedHomes(
  pageProps: Record<string, unknown>
): RawSavedHome[] {
  // 1. New shape (2026-05): collectionsResponse[].homes
  const collections = pageProps.collectionsResponse;
  if (Array.isArray(collections)) {
    const flat: RawSavedHome[] = [];
    for (const c of collections as RawCollection[]) {
      if (Array.isArray(c.homes)) flat.push(...c.homes);
      else if (Array.isArray(c.properties)) flat.push(...c.properties);
      else if (Array.isArray(c.items)) flat.push(...c.items);
    }
    if (flat.length > 0) return flat;
    // Collections present but empty (user has no saves) — return [].
    if (collections.length > 0) return [];
  }
  // 2. Older shapes (top-level array of homes)
  return findArrayByShape<RawSavedHome>(
    pageProps,
    SAVED_HOME_KEYS,
    (el) => 'zpid' in el && ('hdpUrl' in el || 'savedAt' in el)
  );
}

function formatSearch(raw: RawSavedSearch) {
  return {
    id: raw.id !== undefined ? String(raw.id) : undefined,
    name: raw.name,
    url: raw.url,
    new_count: raw.newCount,
    total_count: raw.totalCount,
    notification_frequency: raw.notificationFrequency,
    filters: raw.filterState ?? raw.searchQueryState,
    updated_at: raw.updatedAt,
    created_at: raw.createdAt,
  };
}

function formatHome(raw: RawSavedHome) {
  const zpid = String(raw.zpid ?? '');
  return {
    zpid,
    address: raw.address,
    price: raw.price,
    zestimate: raw.zestimate,
    beds: raw.bedrooms,
    baths: raw.bathrooms,
    living_area: raw.livingArea,
    status: raw.homeStatus,
    image_url: raw.imgSrc,
    saved_at: raw.savedAt,
    url: raw.hdpUrl
      ? raw.hdpUrl.startsWith('http')
        ? raw.hdpUrl
        : `https://www.zillow.com${raw.hdpUrl}`
      : `https://www.zillow.com/homedetails/${zpid}_zpid/`,
  };
}

export function registerSavedTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_get_saved_searches',
    {
      title: 'Get my saved Zillow searches',
      description:
        "The signed-in user's saved searches on zillow.com (name, filters, new-listing count, notification frequency). Requires the user to be signed in at zillow.com in the bridged browser tab — throws SessionNotAuthenticatedError otherwise. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get my saved Zillow searches',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      // Note: path is case-sensitive (Zillow's web app uses capital S)
      const html = await client.fetchHtml('/myzillow/SavedSearches');
      const nextData = extractNextData(html);
      const pageProps = getPageProps(nextData);
      const searches = findSavedSearches(pageProps);
      return textResult(searches.map(formatSearch));
    }
  );

  server.registerTool(
    'zillow_get_saved_homes',
    {
      title: 'Get my saved (favorited) Zillow homes',
      description:
        "The signed-in user's saved (favorited) homes on zillow.com, flattened across all of the user's collections. Returns address, price, Zestimate, status, and when each home was saved. Requires the user to be signed in. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get my saved (favorited) Zillow homes',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      const html = await client.fetchHtml('/myzillow/favorites');
      const nextData = extractNextData(html);
      const pageProps = getPageProps(nextData);
      const homes = findSavedHomes(pageProps);
      return textResult(homes.map(formatHome));
    }
  );
}
