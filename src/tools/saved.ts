import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractNextData, getPageProps } from '../next-data.js';

/**
 * Signed-in-user surfaces. These are the unique value zillow-mcp delivers
 * vs. Bridge-API-based competitors: a Zillow Bridge API key can't see
 * what the *signed-in user* has saved, because Bridge is MLS-partnership-
 * scoped, not user-scoped.
 *
 * Both pages return Next.js SSR with __NEXT_DATA__ — same parsing pattern
 * as the homedetails page.
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

/**
 * Walk a parsed pageProps blob looking for a field that is an array of
 * objects that look like saved searches (have `searchQueryState` or
 * `filterState`). We do this defensively because Zillow has moved this
 * field between releases — sometimes it's `savedSearches`, sometimes
 * `userSavedSearches`, etc.
 */
export function findSavedSearches(
  pageProps: Record<string, unknown>
): RawSavedSearch[] {
  const direct = (pageProps.savedSearches ?? pageProps.userSavedSearches) as
    | RawSavedSearch[]
    | undefined;
  if (Array.isArray(direct)) return direct;
  for (const v of Object.values(pageProps)) {
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      typeof v[0] === 'object' &&
      v[0] !== null &&
      ('searchQueryState' in (v[0] as object) || 'filterState' in (v[0] as object))
    ) {
      return v as RawSavedSearch[];
    }
  }
  return [];
}

export function findSavedHomes(
  pageProps: Record<string, unknown>
): RawSavedHome[] {
  const direct = (pageProps.savedHomes ??
    pageProps.userSavedHomes ??
    pageProps.favoriteHomes) as RawSavedHome[] | undefined;
  if (Array.isArray(direct)) return direct;
  for (const v of Object.values(pageProps)) {
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      typeof v[0] === 'object' &&
      v[0] !== null &&
      'zpid' in (v[0] as object) &&
      ('hdpUrl' in (v[0] as object) || 'savedAt' in (v[0] as object))
    ) {
      return v as RawSavedHome[];
    }
  }
  return [];
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
      description:
        "The signed-in user's saved searches (name, filters, new-listing count, notification frequency). Requires being signed in to zillow.com in the bridged browser tab.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      const html = await client.fetchHtml('/user/savedSearches/');
      const nextData = extractNextData(html);
      const pageProps = getPageProps(nextData);
      const searches = findSavedSearches(pageProps);
      return textResult(searches.map(formatSearch));
    }
  );

  server.registerTool(
    'zillow_get_saved_homes',
    {
      description:
        "The signed-in user's saved (favorited) homes. Returns address, price, Zestimate, status, and when the home was saved. Requires being signed in.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      const html = await client.fetchHtml('/myzillow/favorites/');
      const nextData = extractNextData(html);
      const pageProps = getPageProps(nextData);
      const homes = findSavedHomes(pageProps);
      return textResult(homes.map(formatHome));
    }
  );
}
