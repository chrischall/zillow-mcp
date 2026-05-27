import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { fetchPropertyRecord } from './properties.js';
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
        "Listing-price events for a property — listings, price changes, pending, sold, etc. — by zpid or homedetails URL. Returns two parallel arrays: `events` (raw Zillow shape with `event` strings and MLS attribution) and `events_normalized` (cross-MCP shared shape with a fixed `type` enum: Listed/PriceChange/Pending/Contingent/Sold/Withdrawn/Relisted/Delisted). The normalized form lets callers merge histories across real-estate MCPs without re-implementing taxonomy. Sourced from the same homedetails page as zillow_get_property.",
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
      return textResult({
        zpid: String(raw.zpid ?? zpid ?? ''),
        events,
        events_normalized,
      });
    }
  );

  server.registerTool(
    'zillow_get_tax_history',
    {
      title: 'Get Zillow tax history for a property',
      description:
        "Year-by-year property-tax record for a property: tax paid, assessed value, and the year-over-year change rates. Sourced from the homedetails page. Useful for spotting reassessment jumps or comparing tax burdens across properties.",
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
      return textResult({ zpid: String(raw.zpid ?? zpid ?? ''), events });
    }
  );
}
