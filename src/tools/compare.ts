import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { pivotSummary } from '@chrischall/realty-core';
import type { ZillowClient } from '../client.js';
import {
  runPropertyBatch,
  type BulkGetTuning,
} from './bulk-get.js';
import { minifiedResult } from '@chrischall/mcp-utils';
import { type FormattedProperty, zpidSchema } from './properties.js';

/**
 * Side-by-side comparison of N Zillow properties. Calls
 * `fetchPropertyRecord` once per zpid concurrently, then surfaces a
 * small set of headline metrics + the full per-property record. Errors
 * for any single zpid are captured in the response so a partial
 * comparison still works.
 */

export interface CompareSummaryRow {
  field: string;
  values: Array<number | string | null>;
}

interface ComparePerProperty {
  zpid: string;
  property?: FormattedProperty;
  error?: string;
}

/**
 * Build a compact summary table where each row is one field
 * (price, beds, etc.) and `values[i]` lines up with `results[i]`.
 */
export function buildSummary(
  rows: ReadonlyArray<ComparePerProperty>
): CompareSummaryRow[] {
  // realty-core `pivotSummary` (fleet-audit#1091): each cell is the row's
  // value verbatim, `undefined` / failed row → null. `{ field, pick }`
  // where zillow's summary label differs from the property key.
  return pivotSummary<FormattedProperty>(rows, [
    'price',
    'zestimate',
    'rent_zestimate',
    'beds',
    'baths',
    { field: 'living_area_sqft', pick: (p) => p.living_area },
    { field: 'lot_size_sqft', pick: (p) => p.lot_size },
    'lot_size_acres',
    'year_built',
    'home_type',
    'status',
    'days_on_zillow',
    'tax_assessed_value',
    'neighborhood',
  ]) as CompareSummaryRow[];
}

export function registerCompareTools(
  server: McpServer,
  client: ZillowClient,
  tuning: BulkGetTuning = {}
): void {
  server.registerTool(
    'zillow_compare_properties',
    {
      title: 'Compare multiple Zillow properties side-by-side',
      description:
        'Side-by-side analysis of 2-25 Zillow properties. **If you just want N property records, use `zillow_bulk_get` instead** — compare is for genuine side-by-side (its pivoted summary table is the value-add); bulk_get is the fetch-many endpoint and accepts up to 200 ids. (Issue #79 raised this cap from 8 to 25 — a 19-listing analysis now fits in one call instead of three.) ' +
        'Provide an array of zpids (or homedetails URLs). Returns the full per-property record per row (with `extracted_features` populated). Pass `include_summary: true` for an extra pivoted summary table (one row per field) — defaults off because `results[].property.*` already carries everything. The raw `description` is omitted from each row by default — pass `include_description: true` to keep it. Errors for individual properties are captured per-row — one bad zpid won\'t fail the whole call. Calls fan out concurrently (capped at 6 in flight, per issue #78, with retry-once-on-timeout per sub-request to absorb transient SW evictions), paced by the same throttle as `zillow_bulk_get`; a bot-wall block is retried with backoff and, if it persists, reported as `error_kind: "bot_challenge"` (distinct from a missing listing) with `{ blocked, retry_after_s }` on the envelope. The call is bounded by an overall deadline — unsettled rows come back as `error_kind: "pending"`.',
      annotations: {
        title: 'Compare multiple Zillow properties side-by-side',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        zpids: z
          .array(zpidSchema)
          .min(2)
          .max(25)
          .optional()
          .describe(
            'Array of 2-25 zpids to compare. Provide either zpids or urls. For larger batches, use `zillow_bulk_get`.'
          ),
        urls: z
          .array(z.string())
          .min(2)
          .max(25)
          .optional()
          .describe(
            'Array of 2-25 Zillow homedetails URLs/paths to compare. Provide either zpids or urls.'
          ),
        include_summary: z
          .boolean()
          .optional()
          .describe(
            'Include the pivoted `summary` table (one row per compared field, one column per listing). Defaults to `false` because `results[].property.*` already carries everything — the summary roughly doubles response weight and is mainly useful for human-readable rendering.'
          ),
        include_description: z
          .boolean()
          .optional()
          .describe(
            'Include the raw `description` on each row. Defaults to `false`.'
          ),
      }),
    },
    async ({ zpids, urls, include_summary, include_description }) => {
      const targets =
        zpids && zpids.length > 0
          ? zpids.map((zpid) => ({ zpid }))
          : urls && urls.length > 0
            ? urls.map((url) => ({ url }))
            : null;
      if (!targets || targets.length < 2) {
        throw new Error(
          'zillow_compare_properties: provide an array of at least 2 zpids or urls.'
        );
      }
      // Same fan-out as zillow_bulk_get (fleet-audit#811): bounded
      // concurrency + retry-once-on-timeout (#78), a token-bucket throttle
      // and bot-wall backoff with a `bot_challenge` row kind (#90), and
      // the overall deadline with `pending` backfill (#98).
      const envelope = await runPropertyBatch(client, targets, tuning, {
        toolLabel: 'zillow_compare_properties',
        formatOptions: { includeDescription: include_description },
      });
      const body: typeof envelope & { summary?: CompareSummaryRow[] } = envelope;
      if (include_summary === true) body.summary = buildSummary(envelope.results);
      return minifiedResult(body);
    }
  );
}
