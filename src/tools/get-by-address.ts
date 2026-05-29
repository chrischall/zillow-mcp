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
 * Thin wrapper around the shared 4-rung resolver in `resolver.ts` —
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
  via?:
    | 'direct'
    | 'autocomplete'
    | 'suffix_expansion'
    | 'locality_remap'
    | 'search_fallback';
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
        "Resolve a free-text address (with optional city/state/zip) to its Zillow canonical homedetails URL and zpid. IMPORTANT: for rural / mountain-MLS / locality-mismatched addresses (the search-fallback rung is often the ONLY rung that hits), ALWAYS pass `price_min` and `price_max` if you have any sense of the property's price band — without them the city/state search can't disambiguate and the call returns `{ resolved: false }`. The price params are not optional niceties; they are frequently load-bearing. Tries up to 5 rungs: (1) direct resolver hit, (2) autocomplete typeahead — Zillow's own canonical address suggestions, whole-token street-matched then resolved to a zpid (high recall), (3) bidirectional street-token swap (\"Rd\" <-> \"Road\", \"Hts\" <-> \"Heights\", \"Bluebird\" <-> \"Blue Bird\"), (4) locality remap — city-drop + locality-alias substitution when the caller-supplied city fails (real-world cases: Lake Lure <-> Rutherfordton, Beech/Sugar Mountain <-> Banner Elk), (5) city/state search fallback bounded by the price band. Returns `via: \"direct\" | \"autocomplete\" | \"suffix_expansion\" | \"locality_remap\" | \"search_fallback\"` so the caller knows how the match was made; when the locality remap fires, `queried_city` (what you sent) and `resolved_city` (what Zillow returned) are both set so the caller can see the substitution. Degrades to `{ resolved: false }` when ALL rungs miss — does not throw. Read-only, no auth required.",
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
            'Lower bound for the search-fallback rung. Frequently load-bearing: for rural / locality-mismatched addresses this is often the only rung that hits, and without a price band it cannot disambiguate. Pass it if you have ANY sense of the price band.'
          ),
        price_max: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Upper bound for the search-fallback rung. Pair with `price_min` — same load-bearing role for rural/remapped-locality addresses.'
          ),
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
