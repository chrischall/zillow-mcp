import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { fetchPropertyRecord } from './properties.js';
import { seriesAvailabilityNote } from './series-note.js';
import {
  formatPriceEvent,
  formatTaxEvent,
  normalizePriceEvent,
} from './history-format.js';

// Re-export the shared types + helpers so existing import paths keep working.
export {
  formatPriceEvent,
  formatTaxEvent,
  normalizePriceEvent,
  normalizeEventType,
} from './history-format.js';
export type {
  FormattedPriceEvent,
  FormattedTaxEvent,
  NormalizedPriceEvent,
  NormalizedEventType,
  RawPriceHistoryEntry,
  RawTaxHistoryEntry,
} from './history-format.js';

export function registerHistoryTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_get_price_history',
    {
      title: 'Get Zillow price history for a property',
      description:
        "Listing-price events for a property — listings, price changes, pending, sold, etc. — by zpid or homedetails URL. Returns two parallel arrays: `events` (raw Zillow shape with `event` strings and MLS attribution) and `events_normalized` (cross-MCP shared shape with a fixed `type` enum: Listed/PriceChange/Pending/Contingent/Sold/Withdrawn/Relisted/Delisted). The normalized form lets callers merge histories across real-estate MCPs without re-implementing taxonomy. Sourced from the same homedetails page as zillow_get_property. For some listings (commonly non-Showcase) Zillow omits the history from the server-rendered page; then `events` is empty and an explanatory `note` is returned — distinct from a genuine no-history.",
      annotations: {
        title: 'Get Zillow price history for a property',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        zpid: z
          .union([z.number().int().positive(), z.string()])
          .optional()
          .describe('Zillow Property ID'),
        url: z
          .string()
          .optional()
          .describe('Zillow homedetails URL or path'),
      },
    },
    async ({ zpid, url }) => {
      const { raw } = await fetchPropertyRecord(client, { zpid, url });
      const events = (raw.priceHistory ?? []).map(formatPriceEvent);
      const events_normalized = events.map(normalizePriceEvent);
      const note = seriesAvailabilityNote({
        empty: events.length === 0,
        sourcePresent: raw.priceHistory !== undefined,
        kind: 'price history',
      });
      return textResult({
        zpid: String(raw.zpid ?? zpid ?? ''),
        events,
        events_normalized,
        ...(note ? { note } : {}),
      });
    }
  );

  server.registerTool(
    'zillow_get_tax_history',
    {
      title: 'Get Zillow tax history for a property',
      description:
        "Year-by-year property-tax record for a property: tax paid, assessed value, and the year-over-year change rates. Sourced from the homedetails page. Useful for spotting reassessment jumps or comparing tax burdens across properties. For some listings (commonly non-Showcase) Zillow omits the history from the server-rendered page; then `events` is empty and an explanatory `note` is returned — distinct from a genuine no-history.",
      annotations: {
        title: 'Get Zillow tax history for a property',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        zpid: z
          .union([z.number().int().positive(), z.string()])
          .optional()
          .describe('Zillow Property ID'),
        url: z
          .string()
          .optional()
          .describe('Zillow homedetails URL or path'),
      },
    },
    async ({ zpid, url }) => {
      const { raw } = await fetchPropertyRecord(client, { zpid, url });
      const events = (raw.taxHistory ?? []).map(formatTaxEvent);
      const note = seriesAvailabilityNote({
        empty: events.length === 0,
        sourcePresent: raw.taxHistory !== undefined,
        kind: 'tax history',
      });
      return textResult({
        zpid: String(raw.zpid ?? zpid ?? ''),
        events,
        ...(note ? { note } : {}),
      });
    }
  );
}
