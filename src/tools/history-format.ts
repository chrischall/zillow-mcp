// Shared types + format/normalize helpers for price + tax history; breaks the properties <-> history cycle.

import { mapEventType } from '@chrischall/realty-core';

export interface RawPriceHistoryEntry {
  date?: string;
  time?: number;
  event?: string;
  price?: number;
  priceChangeRate?: number;
  pricePerSquareFoot?: number;
  source?: string;
  attributeSource?: {
    infoString1?: string;
    infoString2?: string;
    infoString3?: string;
  };
}

export interface RawTaxHistoryEntry {
  time?: number;
  taxPaid?: number;
  taxIncreaseRate?: number;
  value?: number;
  valueIncreaseRate?: number;
}

export interface FormattedPriceEvent {
  date?: string;
  event?: string;
  price?: number;
  price_change_percent?: number;
  price_per_sqft?: number;
  source?: string;
  mls_number?: string;
}

// Cross-MCP shared taxonomy: every real-estate MCP maps its raw events to
// this enum. zillow's variant deliberately has NO `Unknown` member — an
// unrecognized event defaults to `Listed` (below) so the price point still
// surfaces. The canonical realty-core taxonomy adds an `Unknown` sentinel;
// the adapter in `normalizeEventType` collapses it back to `Listed` to keep
// this output contract (and the `Unknown`-free union) intact.
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
 * Map Zillow's free-text `event` string to the shared taxonomy.
 *
 * Thin adapter over realty-core's canonical `mapEventType` (cohort
 * migration realty-mcp#1), which reconciles all five MCPs' synonym sets
 * and word-boundary-anchors `\bactive\b` / `\bclosed\b` (so "Inactive"
 * no longer maps to Listed and "Foreclosed" no longer maps to Sold).
 *
 * It produces identical results to zillow's old inline mapper for every
 * event string zillow has ever surfaced — the one difference is the
 * `Unknown` sentinel: realty-core returns `Unknown` for input it can't
 * classify, where zillow's contract defaults to `Listed` (so the price
 * point still surfaces) and its `NormalizedEventType` union has no
 * `Unknown` member. We collapse `Unknown → Listed` here to preserve that
 * behavior + the union. Behavior-preserving — no test changes.
 */
export function normalizeEventType(event: string | undefined): NormalizedEventType {
  const mapped = mapEventType(event);
  return mapped === 'Unknown' ? 'Listed' : mapped;
}

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

// Convert Zillow's `priceChangeRate` (decimal like 0.0125) to a percent.
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
