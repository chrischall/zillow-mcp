import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { formatListing } from './search.js';
import {
  buildAddressSlug,
  resolveAddressFull,
  swapStreetSuffix,
} from './resolver.js';

/**
 * `zillow_get_by_address`: resolve a free-text address (and optional
 * city/state/zip) to its Zillow canonical homedetails URL + zpid.
 *
 * Thin wrapper around the shared 3-rung resolver in `resolver.ts` —
 * the same ladder is used by `zillow_resolve_addresses` (issue #73
 * parity). See `resolver.ts` for ladder semantics.
 */

export interface GetByAddressInput {
  address: string;
  city?: string;
  state?: string;
  zip?: string;
  /** Optional price band for the search-fallback rung. */
  price_min?: number;
  /** Optional price band for the search-fallback rung. */
  price_max?: number;
}

// Re-exports kept for backward-compatibility with existing tests.
export { buildAddressSlug };
/**
 * @deprecated Use `swapStreetSuffix` from `./resolver.js` — both names
 * call the same function. Kept exported so existing tests / callers
 * continue to compile.
 */
export const expandStreetSuffix = swapStreetSuffix;

export interface GetByAddressResult {
  resolved: boolean;
  zpid?: string;
  url?: string;
  street_address?: string;
  city?: string;
  state?: string;
  zip?: string;
  /** The city the caller supplied (only set when remapped — issue #75). */
  queried_city?: string;
  /** The city Zillow actually returned (only set when remapped — issue #75). */
  resolved_city?: string;
  /** Set when `resolved` is false. */
  error?: string;
  /** The slug we passed through the resolver — useful for debugging an unexpected miss. */
  query?: string;
  /** Which rung of the resolution ladder produced the result. */
  via?: 'direct' | 'suffix_expansion' | 'search_fallback';
}

function formatResolvedResult(
  formatted: NonNullable<ReturnType<typeof formatListing>>,
  slug: string,
  via: NonNullable<GetByAddressResult['via']>,
  queriedCity?: string
): GetByAddressResult {
  const result: GetByAddressResult = {
    resolved: true,
    zpid: formatted.zpid,
    url: formatted.url,
    street_address: formatted.address.split(',')[0] || formatted.address,
    city: formatted.city,
    state: formatted.state,
    zip: formatted.zipcode,
    query: slug,
    via,
  };
  if (
    queriedCity &&
    formatted.city &&
    queriedCity.toLowerCase() !== formatted.city.toLowerCase()
  ) {
    result.queried_city = queriedCity;
    result.resolved_city = formatted.city;
  }
  return result;
}

export function registerGetByAddressTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_get_by_address',
    {
      title: 'Resolve an address to its Zillow canonical URL + zpid',
      description:
        "Resolve a free-text address (with optional city/state/zip) to its Zillow canonical homedetails URL and zpid. Tries up to 3 strategies: (1) direct resolver hit, (2) bidirectional street-token swap (\"Rd\" <-> \"Road\", \"Hts\" <-> \"Heights\", \"Bluebird\" <-> \"Blue Bird\"), (3) city/state search fallback bounded by an optional price band, with city-drop + locality-alias remap when the caller-supplied city fails. Returns `via: \"direct\" | \"suffix_expansion\" | \"search_fallback\"` so the caller knows how the match was made; `resolved_city` is set when the city was remapped. Degrades to `{ resolved: false }` when ALL strategies miss — does not throw. Read-only, no auth required.",
      annotations: {
        title: 'Resolve an address to its Zillow canonical URL + zpid',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        address: z
          .string()
          .min(1)
          .describe('Street address (e.g. "126 Sleeping Bear Ln").'),
        city: z.string().optional().describe('City name (e.g. "Lake Lure").'),
        state: z
          .string()
          .optional()
          .describe('Two-letter state code (e.g. "NC").'),
        zip: z.string().optional().describe('ZIP code (e.g. "28746").'),
        price_min: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Optional lower bound for the search-fallback rung — bounds the city/state search when both direct + suffix-expansion miss.'
          ),
        price_max: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Optional upper bound for the search-fallback rung.'),
      },
    },
    async (input) => {
      const outcome = await resolveAddressFull(client, input);
      if ('hit' in outcome) {
        const result = formatResolvedResult(
          outcome.hit.formatted,
          outcome.finalSlug,
          outcome.hit.via,
          input.city
        );
        return textResult(result);
      }
      const result: GetByAddressResult = {
        resolved: false,
        error: 'no listing found',
        query: outcome.miss.slug,
      };
      return textResult(result);
    }
  );
}
