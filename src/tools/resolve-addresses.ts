import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runBoundedBatch } from '@chrischall/mcp-utils';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  retryOnceOnTimeout,
} from '@chrischall/mcp-utils/fetchproxy';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { parseAddress } from '@chrischall/realty-core';
import {
  resolveAddressFull,
  type ResolverInput,
  type ResolverVia,
} from './resolver.js';
import { OVERALL_DEADLINE_MS } from './bulk-get.js';

/**
 * `zillow_resolve_addresses`: batch address → zpid resolver.
 *
 * Issue #73: now runs the shared 4-rung ladder (direct → suffix
 * expansion → locality remap → search fallback) so the bulk and
 * single tools resolve the same partition for the same inputs.
 * Inputs may be either bare free-text strings or structured rows
 * that include `city`, `state`, `zip`, and a `price_hint` (issue
 * #74) for the search-fallback rung.
 */

export const RESOLVE_ADDRESSES_MAX = 100;

/**
 * Tuning knobs. Tests inject a tiny `overallDeadlineMs` so the suite
 * doesn't wait on real wall-clock.
 */
export interface ResolveAddressesTuning {
  /**
   * Overall hard deadline (ms) for the whole call (issue #98). When it
   * fires, any row that hasn't settled is returned with
   * `error_kind: 'pending'` and the call resolves with partial results
   * rather than hanging. Defaults to the shared
   * {@link OVERALL_DEADLINE_MS}.
   */
  overallDeadlineMs?: number;
}

/** Per-row input shape — accepts either a bare string or a struct. */
export type ResolveAddressesInputRow =
  | string
  | {
      address: string;
      city?: string;
      state?: string;
      zip?: string;
      /**
       * Optional price hint (issue #74). When supplied, the
       * search-fallback rung uses a ±0.5% band around the hint to
       * narrow the city/state-scoped search.
       */
      price_hint?: number;
    };

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
   * The city used to resolve the listing. Differs from `queried_city`
   * when issue #75's city-drop or locality-alias remap fires.
   */
  resolved_city?: string;
  /** The city the caller supplied (when different from `resolved_city`). */
  queried_city?: string;
  /**
   * How the match was made.
   * - `exact`            — rung 1 direct hit.
   * - `autocomplete`     — rung 2 (issue #101) — canonical typeahead.
   * - `suffix_expansion` — rung 3 (issue #51 + #76).
   * - `locality_remap`   — rung 4 (issue #75) — city-drop / alias.
   * - `search_fallback`  — rung 5 (issue #52 + #74).
   * - `none`             — all rungs missed.
   */
  confidence:
    | 'exact'
    | 'autocomplete'
    | 'suffix_expansion'
    | 'locality_remap'
    | 'search_fallback'
    | 'none';
  /** Set when `resolved` is false. */
  error?: string;
  /**
   * Machine-readable marker for an overall-deadline cut (issue #98).
   * Present only on a `pending` row — the overall deadline fired before
   * this row settled (likely a slow/hung sub-request). Distinct from a
   * genuine `confidence: 'none'` miss so the caller re-runs just the
   * pending rows rather than recording a real property as absent.
   */
  error_kind?: 'pending';
  /** The slug we passed through the resolver — useful for debugging. */
  query?: string;
}

/**
 * Normalize a single row to the resolver-input struct. Free-text rows
 * are split into `{address, city, state, zip}` via realty-core's shared
 * `parseAddress` (hoisted from this repo's former `address-parse.ts`) so
 * the bulk tool's existing string-only callers keep working and every
 * cohort MCP splits free-text addresses identically. `parseAddress`
 * returns an OPTIONAL `address` (empty `{}` for blank input); we fall
 * back to the raw row so `ResolverInput.address` is always a string.
 */
function normalizeRow(row: ResolveAddressesInputRow): ResolverInput & {
  raw: string;
  price_hint?: number;
} {
  if (typeof row === 'string') {
    const parsed = parseAddress(row);
    return { raw: row, ...parsed, address: parsed.address ?? row };
  }
  const raw = [row.address, row.city, row.state, row.zip]
    .filter((p) => p && p.trim().length > 0)
    .join(', ');
  return {
    raw,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    price_hint: row.price_hint,
  };
}

/** Map a ResolverVia onto the bulk-row confidence string. */
function viaToConfidence(
  via: ResolverVia
):
  | 'exact'
  | 'autocomplete'
  | 'suffix_expansion'
  | 'locality_remap'
  | 'search_fallback' {
  return via === 'direct' ? 'exact' : via;
}

/**
 * Single-address resolver — runs the same 4-rung ladder
 * `zillow_get_by_address` uses. Captures errors and always returns a
 * row (per-row error capture means one bad address never fails the
 * batch).
 */
export async function resolveOneAddress(
  client: ZillowClient,
  row: ResolveAddressesInputRow
): Promise<ResolveAddressesRow> {
  const norm = normalizeRow(row);
  if (!norm.address || norm.address.trim().length === 0) {
    return {
      address: norm.raw,
      resolved: false,
      confidence: 'none',
      error: 'empty address',
    };
  }
  // Derive a ±0.5% price band from the hint (issue #74).
  const priceBand = norm.price_hint !== undefined ? priceBandFromHint(norm.price_hint) : null;
  const resolverInput: ResolverInput = {
    address: norm.address,
    city: norm.city,
    state: norm.state,
    zip: norm.zip,
    ...(priceBand ? { price_min: priceBand.min, price_max: priceBand.max } : {}),
  };
  try {
    // Per-row retry-once-on-timeout (issue #78): a single
    // FetchproxyTimeoutError inside the resolver ladder retries the
    // whole ladder once before bubbling up. Any other error class
    // (HTTP, parse, etc.) bubbles immediately — only a transient bridge
    // hiccup gets a second chance.
    //
    // Cost trade-off (PR #84 round-3 follow-up item 3): retryOnceOnTimeout
    // wraps the *entire* 4-rung ladder. If the transient timeout fires on
    // rung 3 or 4 after rungs 1-2 already missed, the retry re-runs rungs
    // 1-2 from scratch — worst case ~2× total fetch cost on a row that
    // ultimately resolves. Functionally correct (per-rung retry would need
    // a real refactor of `resolveAddressFull`); intentionally left here as
    // a single-call wrap to keep the change minimal.
    const outcome = await retryOnceOnTimeout(() =>
      resolveAddressFull(client, resolverInput)
    );
    if ('hit' in outcome) {
      const f = outcome.hit.formatted;
      const out: ResolveAddressesRow = {
        address: norm.raw,
        resolved: true,
        confidence: viaToConfidence(outcome.hit.via),
        zpid: f.zpid,
        url: f.url,
        street_address: f.address.split(',')[0] || f.address,
        city: f.city,
        state: f.state,
        zip: f.zipcode,
        query: outcome.finalSlug,
      };
      // City-remap signal (issue #75): only set when there was a
      // queried city AND it differs from the resolved city.
      if (norm.city && f.city && norm.city.toLowerCase() !== f.city.toLowerCase()) {
        out.queried_city = norm.city;
        out.resolved_city = f.city;
      }
      return out;
    }
    return {
      address: norm.raw,
      resolved: false,
      confidence: 'none',
      error: 'no listing found',
      query: outcome.miss.slug,
    };
  } catch (err) {
    // Issue #78: a bridge timeout that survives the retry MUST surface
    // distinctly — the reporter saw rows marked `resolved: false` with
    // a generic miss message and nearly recorded real properties as
    // absent. classifyRowError gives us the right discriminator + the
    // canonical wrapper string.
    return {
      address: norm.raw,
      resolved: false,
      confidence: 'none',
      error: classifyRowError(err).message,
      query: norm.address,
    };
  }
}

/** Derive a symmetric ±0.5% price band from a hint (issue #74). */
export function priceBandFromHint(hint: number): { min: number; max: number } {
  const delta = Math.max(1, Math.round(hint * 0.005));
  return { min: Math.max(0, hint - delta), max: hint + delta };
}

// Per-row schema: accepts either a bare string or a struct.
const RowSchema = z.union([
  z.string().min(1),
  z.object({
    address: z.string().min(1),
    city: z.string().optional(),
    state: z.string().optional(),
    zip: z.string().optional(),
    price_hint: z.number().int().nonnegative().optional(),
  }),
]);

export function registerResolveAddressesTools(
  server: McpServer,
  client: ZillowClient,
  tuning: ResolveAddressesTuning = {}
): void {
  const overallDeadlineMs = tuning.overallDeadlineMs ?? OVERALL_DEADLINE_MS;
  server.registerTool(
    'zillow_resolve_addresses',
    {
      title: 'Bulk-resolve addresses → Zillow zpids',
      description:
        `Resolve up to ${RESOLVE_ADDRESSES_MAX} free-text or structured addresses to Zillow zpids + canonical URLs in one call. ` +
        'Each row may be a bare string or `{address, city?, state?, zip?, price_hint?}`. ' +
        'IMPORTANT: `price_hint` (USD) is frequently load-bearing — for rural / mountain-MLS / locality-mismatched rows the search-fallback rung is often the ONLY rung that hits, and without a price band it cannot disambiguate. The resolver derives a ±0.5% band from the hint. Always pass `price_hint` for any row where you have a sense of the price. ' +
        'Runs the same 5-rung resolver as `zillow_get_by_address` (direct → autocomplete-typeahead → suffix-expansion → locality-remap → search-fallback) — bulk and single walk the same ladder via the shared resolver, so they match the same partition for the same inputs. ' +
        'Locality-remap rung handles real-world mountain-MLS cases (Lake Lure <-> Rutherfordton, Beech/Sugar Mountain <-> Banner Elk) where Zillow indexes the parent locality; when it fires, `queried_city` (what you sent) and `resolved_city` (what Zillow returned) are both set so the caller can see the substitution. ' +
        'Concurrent fan-out — a 60-address batch returns in roughly one round trip instead of 60. Per-row error capture so one bad address never fails the batch. ' +
        '`confidence` is `"exact"` for direct hits, `"autocomplete"` / `"suffix_expansion"` / `"locality_remap"` / `"search_fallback"` for retries, `"none"` when all rungs missed. ' +
        'The whole call is bounded by an overall hard deadline (issue #98), like `zillow_bulk_get`: a single slow/hung row never wedges the server — when the deadline is reached any unsettled row is returned with `error_kind: "pending"` (distinct from a real miss) and the response carries a `pending` count so you can re-run just those addresses. ' +
        'Read-only, no auth required.',
      annotations: {
        title: 'Bulk-resolve addresses → Zillow zpids',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        addresses: z
          .array(RowSchema)
          .min(1)
          .max(RESOLVE_ADDRESSES_MAX)
          .describe(
            `Free-text addresses (e.g. "126 Sleeping Bear Ln, Lake Lure, NC") or structured rows. 1..${RESOLVE_ADDRESSES_MAX}.`
          ),
      },
    },
    async ({ addresses }) => {
      // Issue #78: pace the fan-out to BRIDGE_CONCURRENCY (Redfin parity).
      // Unlimited concurrency timed out 7 of 20 sub-requests in a real
      // session; 6-in-flight + retry-once-on-timeout lands the same
      // batch clean.
      //
      // Issue #98: the same overall hard deadline + pending-backfill that
      // `zillow_bulk_get` uses, via the shared `runBoundedBatch` primitive
      // (hoisted from this MCP's local `runWithDeadline`). It owns the
      // index-addressable slots, the BRIDGE_CONCURRENCY-bounded fan-out, and
      // the deadline race; any slot still unsettled when the deadline fires
      // is backfilled by `onTimeout` with a `pending` row so a single hung
      // sub-request can't wedge the whole call. A `pending` row is NEVER a
      // generic `confidence: 'none'` miss.
      const results = await runBoundedBatch<
        ResolveAddressesInputRow,
        ResolveAddressesRow
      >(addresses, (address) => resolveOneAddress(client, address), {
        deadlineMs: overallDeadlineMs,
        concurrency: BRIDGE_CONCURRENCY,
        onTimeout: (address) => {
          const raw = typeof address === 'string' ? address : address.address;
          return {
            address: raw,
            resolved: false,
            confidence: 'none',
            error_kind: 'pending',
            error:
              'resolve_addresses overall deadline reached before this row ' +
              'settled — the request is still pending (likely a slow/hung ' +
              'sub-request). Re-run just the pending addresses; a single slow ' +
              'row no longer wedges the batch.',
          };
        },
      });

      const pending = results.filter((r) => r.error_kind === 'pending').length;
      const envelope: {
        count: number;
        results: ResolveAddressesRow[];
        pending?: number;
      } = { count: results.length, results };
      if (pending > 0) envelope.pending = pending;
      return textResult(envelope);
    }
  );
}
