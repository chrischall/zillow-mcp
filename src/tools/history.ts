import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  fetchPropertyRecord,
  type RawPriceHistoryEntry,
  type RawTaxHistoryEntry,
} from './properties.js';

/**
 * Two history-focused tools, both sourcing from the same homedetails
 * `__NEXT_DATA__` payload that `zillow_get_property` reads. Exposed as
 * standalone tools so callers can ask for "just the price history" or
 * "just the tax record" without paying for/parsing the full property
 * blob in the response.
 */

export interface FormattedPriceEvent {
  date?: string;
  event?: string;
  price?: number;
  price_change_percent?: number;
  price_per_sqft?: number;
  source?: string;
  mls_number?: string;
}

export interface FormattedTaxEvent {
  year?: number;
  tax_paid?: number;
  tax_increase_percent?: number;
  assessed_value?: number;
  assessed_value_increase_percent?: number;
}

/** Convert Zillow's `priceChangeRate` (decimal like 0.0125) to a percent. */
function toPercent(rate?: number): number | undefined {
  if (typeof rate !== 'number') return undefined;
  return Math.round(rate * 1000) / 10;
}

export function formatPriceEvent(raw: RawPriceHistoryEntry): FormattedPriceEvent {
  const date =
    raw.date ??
    (typeof raw.time === 'number'
      ? new Date(raw.time).toISOString().slice(0, 10)
      : undefined);
  return {
    date,
    event: raw.event,
    price: raw.price,
    price_change_percent: toPercent(raw.priceChangeRate),
    price_per_sqft: raw.pricePerSquareFoot,
    source: raw.source,
    mls_number: raw.attributeSource?.infoString1,
  };
}

export function formatTaxEvent(raw: RawTaxHistoryEntry): FormattedTaxEvent {
  const year =
    typeof raw.time === 'number'
      ? new Date(raw.time).getUTCFullYear()
      : undefined;
  return {
    year,
    tax_paid: raw.taxPaid,
    tax_increase_percent: toPercent(raw.taxIncreaseRate),
    assessed_value: raw.value,
    assessed_value_increase_percent: toPercent(raw.valueIncreaseRate),
  };
}

export function registerHistoryTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_get_price_history',
    {
      title: 'Get Zillow price history for a property',
      description:
        "Listing-price events for a property — listings, price changes, pending, sold, etc. — by zpid or homedetails URL. Each entry has a date, event type, price, percent price-change, price/sqft, and MLS attribution. Sourced from the same homedetails page as zillow_get_property, but returns just the price-history series for easier downstream reasoning.",
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
      return textResult({ zpid: String(raw.zpid ?? zpid ?? ''), events });
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
