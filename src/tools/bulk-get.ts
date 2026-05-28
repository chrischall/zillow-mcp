import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  mapWithConcurrency,
  retryOnceOnTimeout,
} from '@fetchproxy/server';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  fetchPropertyRecord,
  format,
  type FormattedProperty,
} from './properties.js';

/**
 * `zillow_bulk_get`: structured fetch of N properties in one call.
 *
 * Sibling to `zillow_compare_properties` but with a higher cap and no
 * pivoted summary table — this is the "give me everything for these 50
 * saved homes" endpoint, not the analysis endpoint. A 53-listing
 * session can fetch in 1 round trip instead of 7 sequential 8-at-a-time
 * compare calls. (Issue #46.)
 *
 * Errors for individual zpids are captured per-row so a single bad zpid
 * doesn't fail the whole batch.
 */

/**
 * Upper bound on `zpids[]` / `urls[]`. 200 covers the realistic
 * "give me everything" case while keeping a single bulk_get call
 * cheap enough to fan out concurrently without slamming Zillow.
 */
export const BULK_GET_MAX = 200;

interface BulkGetRow {
  zpid: string;
  property?: FormattedProperty;
  error?: string;
}

export function registerBulkGetTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_bulk_get',
    {
      title: 'Bulk-fetch Zillow properties by zpid',
      description:
        `Fetch up to ${BULK_GET_MAX} Zillow property records in a single call — the "give me everything for these N saved homes" endpoint. Returns one structured row per input id ` +
        '(no pivoted side-by-side summary table — for 2-25 listings with a comparison summary use `zillow_compare_properties`). Each row is either ' +
        '`{ zpid, property }` on success or `{ zpid, error }` on failure — one bad zpid never fails the ' +
        'whole call. Calls fan out concurrently against `/homedetails/<zpid>_zpid/` (capped at 6 in flight, per issue #78, with retry-once-on-timeout per sub-request to absorb transient SW evictions).',
      annotations: {
        title: 'Bulk-fetch Zillow properties by zpid',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        zpids: z
          .array(z.union([z.number().int().positive(), z.string()]))
          .min(1)
          .max(BULK_GET_MAX)
          .optional()
          .describe(
            `Zpids to fetch. 1..${BULK_GET_MAX}. Provide either zpids or urls.`
          ),
        urls: z
          .array(z.string())
          .min(1)
          .max(BULK_GET_MAX)
          .optional()
          .describe(
            `Zillow homedetails URLs/paths to fetch. 1..${BULK_GET_MAX}.`
          ),
      },
    },
    async ({ zpids, urls }) => {
      const targets =
        zpids && zpids.length > 0
          ? zpids.map((zpid) => ({ zpid }))
          : urls && urls.length > 0
            ? urls.map((url) => ({ url }))
            : null;
      if (!targets || targets.length === 0) {
        throw new Error(
          'zillow_bulk_get: provide either zpids[] or urls[] (1..' +
            BULK_GET_MAX +
            ').'
        );
      }
      // Issue #78: pace fan-out at BRIDGE_CONCURRENCY + retry-once-on-
      // timeout per sub-request so a single transient SW eviction
      // doesn't surface as a hard fetch failure for that row.
      type Target = { zpid?: number | string; url?: string };
      const rows = await mapWithConcurrency<Target, BulkGetRow>(
        targets as Target[],
        BRIDGE_CONCURRENCY,
        async (t): Promise<BulkGetRow> => {
          const fallbackZpid = 'zpid' in t ? String(t.zpid) : '';
          try {
            const { raw } = await retryOnceOnTimeout(() =>
              fetchPropertyRecord(client, t)
            );
            return {
              zpid: String(raw.zpid ?? fallbackZpid),
              property: format(raw),
            };
          } catch (e) {
            return { zpid: fallbackZpid, error: classifyRowError(e).message };
          }
        }
      );
      return textResult({ count: rows.length, rows });
    }
  );
}
