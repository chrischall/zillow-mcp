import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { ParseError } from '../next-data.js';
import {
  buildSearchPath,
  extractSearchPageState,
  formatListing,
  listingsMatchLocation,
  locationTokens,
  type RawListing,
} from './search.js';

/**
 * `zillow_get_by_address`: resolve a free-text address (and optional
 * city/state/zip) to its Zillow canonical homedetails URL + zpid.
 *
 * Implementation: hit `/homes/<address-slug>_rb/` (the bare search
 * resolve path) once. When the address corresponds to a real listing,
 * Zillow's SSR populates `searchPageState.cat1.searchResults.listResults`
 * with that listing as the first row, carrying the zpid and a
 * `detailUrl` pointing at the canonical homedetails page. We surface
 * the zpid and an absolute URL; if no listing comes back, degrade
 * gracefully to `{ resolved: false, error: "no listing found" }` so
 * the unified caller (e.g. a tracker that fans out across MCPs) can
 * pick the next provider without re-trying.
 *
 * This subsumes the E4 "address_to_zpid" workflow — one round-trip,
 * no separate `search` + `get_property` chain.
 */

export interface GetByAddressInput {
  address: string;
  city?: string;
  state?: string;
  zip?: string;
}

/**
 * Join the address parts into a single space-separated phrase suitable
 * for Zillow's `/homes/<slug>_rb/` resolver. Missing parts are skipped.
 */
export function buildAddressSlug(input: GetByAddressInput): string {
  return [input.address, input.city, input.state, input.zip]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0)
    .join(' ');
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
        "Resolve a free-text address (with optional city/state/zip) to its Zillow canonical homedetails URL and zpid. Hits Zillow's search resolver once and returns the first matching listing's zpid + URL. Degrades to `resolved: false` when no listing is found — does not throw. Use this when you have a property address and need its zpid for follow-on calls (e.g. `zillow_get_property`, `zillow_get_zestimate_history`). Read-only, no auth required.",
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
      },
    },
    async (input) => {
      const slug = buildAddressSlug(input);
      const path = buildSearchPath(slug);
      const html = await client.fetchHtml(path);
      // The resolver page can come back with no __NEXT_DATA__ at all
      // (e.g. Zillow redirected to a marketing page); treat that as
      // "no listing found" instead of a hard error so the unified
      // caller can degrade gracefully.
      let sps: ReturnType<typeof extractSearchPageState>;
      try {
        sps = extractSearchPageState(html);
      } catch (e) {
        if (e instanceof ParseError) {
          sps = null;
        } else {
          throw e;
        }
      }
      const firstRaw: RawListing | undefined =
        sps?.cat1?.searchResults?.listResults?.[0];
      if (!firstRaw) {
        const result: GetByAddressResult = {
          resolved: false,
          error: 'no listing found',
          query: slug,
        };
        return textResult(result);
      }
      const formatted = formatListing(firstRaw);
      if (!formatted) {
        const result: GetByAddressResult = {
          resolved: false,
          error: 'first listing had no zpid',
          query: slug,
        };
        return textResult(result);
      }
      // Catch Zillow's silent fallback to the user's default region (same
      // guard as resolveLocation in search.ts).
      if (!listingsMatchLocation([firstRaw], locationTokens(slug))) {
        const result: GetByAddressResult = {
          resolved: false,
          error: 'no listing found',
          query: slug,
        };
        return textResult(result);
      }
      const result: GetByAddressResult = {
        resolved: true,
        zpid: formatted.zpid,
        url: formatted.url,
        street_address: formatted.address.split(',')[0] || formatted.address,
        city: formatted.city,
        state: formatted.state,
        zip: formatted.zipcode,
        query: slug,
      };
      return textResult(result);
    }
  );
}
