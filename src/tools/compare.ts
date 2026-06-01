import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  mapWithConcurrency,
  retryOnceOnTimeout,
} from '@chrischall/mcp-utils/fetchproxy';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  fetchPropertyRecord,
  format,
  type FormattedProperty,
} from './properties.js';

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
export function buildSummary(rows: ComparePerProperty[]): CompareSummaryRow[] {
  const pick = (
    label: string,
    fn: (p: FormattedProperty) => number | string | null | undefined
  ): CompareSummaryRow => ({
    field: label,
    values: rows.map((r) => (r.property ? fn(r.property) ?? null : null)),
  });
  return [
    pick('price', (p) => p.price),
    pick('zestimate', (p) => p.zestimate),
    pick('rent_zestimate', (p) => p.rent_zestimate),
    pick('beds', (p) => p.beds),
    pick('baths', (p) => p.baths),
    pick('living_area_sqft', (p) => p.living_area),
    pick('lot_size_sqft', (p) => p.lot_size),
    pick('lot_size_acres', (p) => p.lot_size_acres),
    pick('year_built', (p) => p.year_built),
    pick('home_type', (p) => p.home_type),
    pick('status', (p) => p.status),
    pick('days_on_zillow', (p) => p.days_on_zillow),
    pick('tax_assessed_value', (p) => p.tax_assessed_value),
    pick('neighborhood', (p) => p.neighborhood),
  ];
}

export function registerCompareTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_compare_properties',
    {
      title: 'Compare multiple Zillow properties side-by-side',
      description:
        'Side-by-side analysis of 2-25 Zillow properties. **If you just want N property records, use `zillow_bulk_get` instead** — compare is for genuine side-by-side (its pivoted summary table is the value-add); bulk_get is the fetch-many endpoint and accepts up to 200 ids. (Issue #79 raised this cap from 8 to 25 — a 19-listing analysis now fits in one call instead of three.) ' +
        'Provide an array of zpids (or homedetails URLs). Returns the full per-property record per row (with `extracted_features` populated). Pass `include_summary: true` for an extra pivoted summary table (one row per field) — defaults off because `results[].property.*` already carries everything. The raw `description` is omitted from each row by default — pass `include_description: true` to keep it. Errors for individual properties are captured per-row — one bad zpid won\'t fail the whole call. Calls fan out concurrently (capped at 6 in flight, per issue #78, with retry-once-on-timeout per sub-request to absorb transient SW evictions).',
      annotations: {
        title: 'Compare multiple Zillow properties side-by-side',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        zpids: z
          .array(z.union([z.number().int().positive(), z.string()]))
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
      },
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
      // Issue #78 follow-up: compare used to do unbounded `Promise.all`
      // for up to 25 zpids. The round-3 session that motivated #78 saw
      // 7-of-20 timeouts at unlimited concurrency — 25 sits in the same
      // risk window. Mirror bulk-get's pacing (BRIDGE_CONCURRENCY +
      // retry-once-on-timeout per row) so compare absorbs the same
      // transient SW evictions instead of failing rows.
      type Target = { zpid?: number | string; url?: string };
      const results = await mapWithConcurrency<Target, ComparePerProperty>(
        targets as Target[],
        BRIDGE_CONCURRENCY,
        async (t): Promise<ComparePerProperty> => {
          const fallbackZpid = 'zpid' in t ? String(t.zpid) : '';
          try {
            const { raw } = await retryOnceOnTimeout(() =>
              fetchPropertyRecord(client, t)
            );
            return {
              zpid: String(raw.zpid ?? fallbackZpid),
              property: format(raw, { includeDescription: include_description }),
            };
          } catch (e) {
            return { zpid: fallbackZpid, error: classifyRowError(e).message };
          }
        }
      );
      const body: {
        count: number;
        summary?: CompareSummaryRow[];
        results: ComparePerProperty[];
      } = {
        count: results.length,
        results,
      };
      if (include_summary === true) body.summary = buildSummary(results);
      return textResult(body);
    }
  );
}
