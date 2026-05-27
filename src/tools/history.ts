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

/**
 * Cross-MCP shared taxonomy for price-history events. Issue #55 calls
 * for the same `type` enum on every real-estate MCP so the caller can
 * merge histories from Compass/Zillow/Redfin/homes-com without
 * re-implementing per-source taxonomy.
 */
export type NormalizedEventType =
  | 'Listed'
  | 'PriceChange'
  | 'Pending'
  | 'Contingent'
  | 'Sold'
  | 'Withdrawn'
  | 'Relisted'
  | 'Delisted';

export interface NormalizedPriceEvent {
  date?: string;
  type: NormalizedEventType;
  price?: number;
  /** Percent change from the previous price (when Zillow provides it). */
  price_change_pct?: number;
  /** MLS attribution string when available. */
  source_mls?: string;
}

/**
 * Map Zillow's raw `event` strings to the cross-MCP normalized
 * `type` enum (issue #55). Specificity-ordered: tighter matches checked
 * first so e.g. "Pending sale" doesn't accidentally hit "Sold".
 * Falls back to `Listed` for novel/unknown labels — the caller still
 * has the raw event in the parallel `events` array if disambiguation
 * matters.
 */
export function normalizeEventType(event: string | undefined): NormalizedEventType {
  const s = (event ?? '').toLowerCase();
  if (s.includes('delist')) return 'Delisted';
  if (s.includes('relist')) return 'Relisted';
  if (s.includes('withdrawn') || s.includes('listing removed')) return 'Withdrawn';
  if (s.includes('pending')) return 'Pending';
  if (s.includes('contingent')) return 'Contingent';
  if (s.includes('sold')) return 'Sold';
  if (s.includes('price change') || s.includes('price decrease') || s.includes('price increase'))
    return 'PriceChange';
  // Default: treat unknown as Listed so the price point still surfaces.
  return 'Listed';
}

/**
 * Project a `FormattedPriceEvent` onto the normalized shape.
 */
export function normalizePriceEvent(ev: FormattedPriceEvent): NormalizedPriceEvent {
  const out: NormalizedPriceEvent = {
    type: normalizeEventType(ev.event),
  };
  if (ev.date !== undefined) out.date = ev.date;
  if (ev.price !== undefined) out.price = ev.price;
  if (ev.price_change_percent !== undefined) out.price_change_pct = ev.price_change_percent;
  if (ev.source !== undefined) out.source_mls = ev.source;
  return out;
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
      // events_normalized: parallel array with the cross-MCP shared
      // taxonomy. Purely additive — the raw shape is preserved in
      // `events`. (Issue #55.)
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
