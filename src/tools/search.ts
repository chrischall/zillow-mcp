import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';

/**
 * Zillow's React app calls `POST /async-create-search-page-state` with a
 * JSON body containing a `searchQueryState` object that mirrors the URL
 * query state. The response is JSON with cat1.searchResults.listResults
 * (and mapResults). We construct a minimal valid searchQueryState here
 * — Zillow tolerates missing fields and fills sensible defaults.
 */

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

export function buildSearchBody(input: SearchInput): Record<string, unknown> {
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
      // for_sale: leave the defaults Zillow's web app uses.
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
  return {
    searchQueryState: {
      usersSearchTerm: input.location,
      filterState,
      isMapVisible: false,
      isListVisible: true,
    },
    wants: { cat1: ['listResults'] },
    requestId: 1,
    isDebugRequest: false,
  };
}

export function registerSearchTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_search_properties',
    {
      description:
        'Search Zillow listings by location (city, ZIP, neighborhood, or address) and optional filters. Returns matching properties with price, beds/baths, sqft, Zestimate, and the homedetails URL. Does NOT return Zestimate history — use zillow_get_zestimate_history for that.',
      annotations: { readOnlyHint: true },
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
      const body = buildSearchBody(input);
      const data = await client.fetchJson<{
        cat1?: { searchResults?: { listResults?: RawListing[] } };
      }>('/async-create-search-page-state/', { method: 'POST', body });
      const raw = data.cat1?.searchResults?.listResults ?? [];
      const limit = input.limit ?? 40;
      const formatted = raw
        .map(formatListing)
        .filter((x): x is FormattedListing => x !== null)
        .slice(0, limit);
      return textResult(formatted);
    }
  );
}
