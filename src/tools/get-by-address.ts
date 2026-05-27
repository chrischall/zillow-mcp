import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { ParseError } from '../next-data.js';
import {
  buildSearchPath,
  buildSearchQueryState,
  extractSearchPageState,
  formatListing,
  listingsMatchLocation,
  locationTokens,
  resolveLocationOrListings,
  type RawListing,
} from './search.js';

/**
 * `zillow_get_by_address`: resolve a free-text address (and optional
 * city/state/zip) to its Zillow canonical homedetails URL + zpid.
 *
 * Implementation ladder (each rung is tried only if the prior one
 * misses — typically 1-3 round trips, worst case 4 when rung 3's
 * scope resolve returns a region rather than listings directly):
 *
 *   1. Direct resolve — hit `/homes/<address-slug>_rb/` (the bare
 *      search-resolver path). When the address corresponds to a real
 *      listing, Zillow's SSR populates
 *      `searchPageState.cat1.searchResults.listResults` with that
 *      listing as the first row.
 *
 *   2. Street-suffix expansion (issue #51) — when the direct resolve
 *      misses, retry with the suffix swapped between its abbreviated
 *      and expanded forms ("Rd" <-> "Road", "Ln" <-> "Lane", etc.).
 *      Resolves the common case where Zillow's geocoder is fussier
 *      than the MLS-provided address.
 *
 *   3. Search fallback (issue #52) — when both direct + expansion
 *      miss, fall through to a city/state-scoped one-shot search
 *      (optionally bounded by a price band the caller supplied) and
 *      pick the first listing whose street matches a token from the
 *      input.
 *
 * Degrades to `{ resolved: false, error: "no listing found" }` only
 * after all three rungs miss, so the unified caller can pick the next
 * provider without re-trying.
 */

export interface GetByAddressInput {
  address: string;
  city?: string;
  state?: string;
  zip?: string;
  /** Optional price band for the issue #52 search-fallback rung. */
  price_min?: number;
  /** Optional price band for the issue #52 search-fallback rung. */
  price_max?: number;
}

/**
 * Join the address parts into a single space-separated phrase suitable
 * for Zillow's `/homes/<slug>_rb/` resolver. Missing parts are skipped.
 */
export function buildAddressSlug(
  input: Pick<GetByAddressInput, 'address' | 'city' | 'state' | 'zip'>
): string {
  return [input.address, input.city, input.state, input.zip]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0)
    .join(' ');
}

/**
 * Map between abbreviated and expanded US street suffixes. The keys
 * are the abbreviated forms (with normalized casing). USPS publication
 * 28 lists ~250 of these; the table below covers the common ones we've
 * seen miss-and-retry in real sessions. Add as needed.
 */
const SUFFIX_EXPANSIONS: Record<string, string> = {
  ave: 'Avenue',
  blvd: 'Boulevard',
  cir: 'Circle',
  ct: 'Court',
  dr: 'Drive',
  hwy: 'Highway',
  ln: 'Lane',
  pl: 'Place',
  pkwy: 'Parkway',
  rd: 'Road',
  sq: 'Square',
  st: 'Street',
  ter: 'Terrace',
  trl: 'Trail',
};
// Reverse map (long form -> abbreviated) for the contract direction.
const SUFFIX_CONTRACTIONS: Record<string, string> = Object.fromEntries(
  Object.entries(SUFFIX_EXPANSIONS).map(([abbr, full]) => [full.toLowerCase(), abbreviate(abbr)])
);

function abbreviate(abbr: string): string {
  return abbr.charAt(0).toUpperCase() + abbr.slice(1);
}

/**
 * Try the alternate form (abbreviated <-> expanded) of an address's
 * trailing street suffix. Returns `null` if the address has no
 * recognized suffix.
 *
 * Anchored to the LAST whitespace-separated token of the street part —
 * we don't want to swap "Rd" if it appears mid-name (e.g.
 * "Roderick Dr" should swap "Dr", not "Rd").
 */
export function expandStreetSuffix(address: string): string | null {
  // Match optional trailing period: "Rd" or "Rd."
  const trimmed = address.trim();
  const m = /(\s+)([A-Za-z]+)(\.?)\s*$/.exec(trimmed);
  if (!m) return null;
  const [_full, lead, token] = m;
  const key = token.toLowerCase();
  const head = trimmed.slice(0, m.index);
  if (SUFFIX_EXPANSIONS[key]) {
    return `${head}${lead}${SUFFIX_EXPANSIONS[key]}`;
  }
  if (SUFFIX_CONTRACTIONS[key]) {
    return `${head}${lead}${SUFFIX_CONTRACTIONS[key]}`;
  }
  return null;
}

export interface GetByAddressResult {
  resolved: boolean;
  zpid?: string;
  url?: string;
  street_address?: string;
  city?: string;
  state?: string;
  zip?: string;
  /** Set when `resolved` is false. */
  error?: string;
  /** The slug we passed through the resolver — useful for debugging an unexpected miss. */
  query?: string;
  /**
   * Which rung of the resolution ladder produced the result.
   *
   * - `direct`           — first resolve hit.
   * - `suffix_expansion` — abbreviated/expanded suffix swap was needed.
   * - `search_fallback`  — city/state search picked the listing.
   * - omitted on `resolved: false`.
   */
  via?: 'direct' | 'suffix_expansion' | 'search_fallback';
}

/**
 * One resolver pass: fetch `/homes/<slug>_rb/`, pull the first
 * matching listing if any. Returns null when no listing matches.
 */
async function resolveOnce(
  client: ZillowClient,
  slug: string
): Promise<{ raw: RawListing; formatted: ReturnType<typeof formatListing> } | null> {
  const path = buildSearchPath(slug);
  const html = await client.fetchHtml(path);
  let sps: ReturnType<typeof extractSearchPageState>;
  try {
    sps = extractSearchPageState(html);
  } catch (e) {
    if (e instanceof ParseError) return null;
    throw e;
  }
  const firstRaw: RawListing | undefined =
    sps?.cat1?.searchResults?.listResults?.[0];
  if (!firstRaw) return null;
  const formatted = formatListing(firstRaw);
  if (!formatted) return null;
  if (!listingsMatchLocation([firstRaw], locationTokens(slug))) return null;
  return { raw: firstRaw, formatted };
}

/**
 * Search-fallback rung (#52). Builds a city/state-scoped search with
 * the caller's optional price band and picks the first listing whose
 * address tokens overlap with the caller's street address.
 */
async function searchFallback(
  client: ZillowClient,
  input: GetByAddressInput
): Promise<RawListing | null> {
  // Need at least a city OR a ZIP to scope the search — otherwise the
  // resolver will just send us back to where the direct path already
  // failed.
  const scope = input.city ?? input.zip;
  if (!scope) return null;
  const scopeParts = [input.city, input.state, input.zip]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0)
    .join(' ');
  // Resolve the scope (city/state) — Zillow gives us either a
  // region we can pin into a filtered second request, or a direct
  // listing payload (single-round-trip case).
  let resolved;
  try {
    resolved = await resolveLocationOrListings(client, scopeParts);
  } catch {
    return null;
  }
  let listings: RawListing[];
  if (resolved.kind === 'listings') {
    // Already got a listing payload from the resolve step. Use those —
    // no second filter call needed (and the price band would silently
    // be dropped in this branch, which matches the resolveLocation
    // contract in search.ts).
    listings = resolved.listings;
  } else {
    const sqs = buildSearchQueryState(
      {
        location: scopeParts,
        ...(input.price_min !== undefined ? { price_min: input.price_min } : {}),
        ...(input.price_max !== undefined ? { price_max: input.price_max } : {}),
      },
      resolved.region
    );
    const html = await client.fetchHtml(buildSearchPath(scopeParts, sqs));
    let sps: ReturnType<typeof extractSearchPageState>;
    try {
      sps = extractSearchPageState(html);
    } catch (e) {
      if (e instanceof ParseError) return null;
      throw e;
    }
    listings = sps?.cat1?.searchResults?.listResults ?? [];
  }
  if (listings.length === 0) return null;
  // Find the listing whose street-name tokens overlap with the input.
  const inputTokens = locationTokens(input.address).filter((t) => t.length >= 3);
  if (inputTokens.length === 0) return listings[0];
  for (const l of listings) {
    const info = l.hdpData?.homeInfo ?? {};
    const haystack = [info.streetAddress, l.address, l.addressStreet]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (inputTokens.every((t) => haystack.includes(t))) return l;
  }
  return null;
}

function formatResolvedResult(
  formatted: NonNullable<ReturnType<typeof formatListing>>,
  slug: string,
  via: NonNullable<GetByAddressResult['via']>
): GetByAddressResult {
  return {
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
        "Resolve a free-text address (with optional city/state/zip) to its Zillow canonical homedetails URL and zpid. Tries up to 3 strategies: (1) direct resolver hit, (2) abbreviated-suffix expansion (\"Rd\" <-> \"Road\", \"Ln\" <-> \"Lane\", etc.), (3) city/state search fallback bounded by an optional price band. Returns `via: \"direct\" | \"suffix_expansion\" | \"search_fallback\"` so the caller knows how the match was made. Degrades to `{ resolved: false }` when ALL strategies miss — does not throw. When the resolved address comes back, callers should sanity-check it against the input — Zillow's address can also occasionally disagree with the MLS address (see `mls_street_address` on get_property). Read-only, no auth required.",
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
      const slug = buildAddressSlug(input);

      // Rung 1: direct.
      const direct = await resolveOnce(client, slug);
      if (direct) {
        return textResult(formatResolvedResult(direct.formatted!, slug, 'direct'));
      }

      // Rung 2: suffix expansion (issue #51).
      const swapped = expandStreetSuffix(input.address);
      if (swapped !== null) {
        const swappedSlug = buildAddressSlug({ ...input, address: swapped });
        const expanded = await resolveOnce(client, swappedSlug);
        if (expanded) {
          return textResult(
            formatResolvedResult(expanded.formatted!, swappedSlug, 'suffix_expansion')
          );
        }
      }

      // Rung 3: search fallback (issue #52).
      const fallbackHit = await searchFallback(client, input);
      if (fallbackHit) {
        const formatted = formatListing(fallbackHit);
        if (formatted) {
          return textResult(formatResolvedResult(formatted, slug, 'search_fallback'));
        }
      }

      const result: GetByAddressResult = {
        resolved: false,
        error: 'no listing found',
        query: slug,
      };
      return textResult(result);
    }
  );
}
