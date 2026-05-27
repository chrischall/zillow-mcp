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
 * `zillow_resolve_addresses`: batch address → zpid resolver. Mirrors the
 * single-address `zillow_get_by_address` pipeline but accepts an array
 * of free-text addresses and fans them out concurrently — a 60-address
 * triage that used to take ~6 search calls + ~15 individual resolves
 * collapses to one round trip. (Issue #53.)
 */

/**
 * Upper bound on `addresses[]`. 100 keeps the concurrent fan-out
 * cheap enough to avoid throttling while still serving the realistic
 * "I have 60 addresses across two sessions" use case from the
 * real-world report.
 */
export const RESOLVE_ADDRESSES_MAX = 100;

export interface ResolveAddressesRow {
  address: string;
  resolved: boolean;
  zpid?: string;
  url?: string;
  street_address?: string;
  city?: string;
  state?: string;
  zip?: string;
  /**
   * How the match was made:
   * - `exact`         — direct resolver hit, first listing matched.
   * - `search_match`  — resolver returned the listing among others (future).
   * - `none`          — no listing came back / silent fallback rejected.
   */
  confidence: 'exact' | 'search_match' | 'none';
  /** Set when `resolved` is false. */
  error?: string;
  /** The slug we passed through the resolver — useful for debugging. */
  query?: string;
}

/**
 * Single-address resolver — extracted so the batch tool can fan out
 * over `addresses[]` and the single `zillow_get_by_address` keeps its
 * existing semantics. Always returns a row; errors are captured.
 */
export async function resolveOneAddress(
  client: ZillowClient,
  address: string
): Promise<ResolveAddressesRow> {
  const slug = address.trim();
  if (slug.length === 0) {
    return { address, resolved: false, confidence: 'none', error: 'empty address' };
  }
  const path = buildSearchPath(slug);
  try {
    const html = await client.fetchHtml(path);
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
      return {
        address,
        resolved: false,
        confidence: 'none',
        error: 'no listing found',
        query: slug,
      };
    }
    const formatted = formatListing(firstRaw);
    if (!formatted) {
      return {
        address,
        resolved: false,
        confidence: 'none',
        error: 'first listing had no zpid',
        query: slug,
      };
    }
    if (!listingsMatchLocation([firstRaw], locationTokens(slug))) {
      return {
        address,
        resolved: false,
        confidence: 'none',
        error: 'no listing found',
        query: slug,
      };
    }
    return {
      address,
      resolved: true,
      confidence: 'exact',
      zpid: formatted.zpid,
      url: formatted.url,
      street_address: formatted.address.split(',')[0] || formatted.address,
      city: formatted.city,
      state: formatted.state,
      zip: formatted.zipcode,
      query: slug,
    };
  } catch (err) {
    return {
      address,
      resolved: false,
      confidence: 'none',
      error: err instanceof Error ? err.message : String(err),
      query: slug,
    };
  }
}

export function registerResolveAddressesTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_resolve_addresses',
    {
      title: 'Bulk-resolve addresses → Zillow zpids',
      description:
        `Resolve up to ${RESOLVE_ADDRESSES_MAX} free-text addresses to Zillow zpids + canonical URLs in one call. ` +
        'Each row carries `{ address, resolved, zpid, url, confidence, ... }`. ' +
        'Concurrent fan-out — a 60-address batch returns in roughly one round trip instead of 60. ' +
        'Per-row error capture so one bad address never fails the batch. ' +
        '`confidence: "exact"` for direct matches, `"none"` when no listing comes back or Zillow silently fell back. ' +
        'Read-only, no auth required.',
      annotations: {
        title: 'Bulk-resolve addresses → Zillow zpids',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        addresses: z
          .array(z.string().min(1))
          .min(1)
          .max(RESOLVE_ADDRESSES_MAX)
          .describe(
            `Free-text addresses (e.g. "126 Sleeping Bear Ln, Lake Lure, NC"). 1..${RESOLVE_ADDRESSES_MAX}.`
          ),
      },
    },
    async ({ addresses }) => {
      const results = await Promise.all(
        addresses.map((a) => resolveOneAddress(client, a))
      );
      return textResult({ count: results.length, results });
    }
  );
}
