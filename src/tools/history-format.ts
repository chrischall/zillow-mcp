// Shared types + format/normalize helpers for price + tax history; breaks the properties <-> history cycle.

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

// Cross-MCP shared taxonomy: every real-estate MCP maps its raw events to this enum.
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

// Specificity-ordered: tighter matches checked first (e.g. "Pending sale" must not hit "Sold").
export function normalizeEventType(event: string | undefined): NormalizedEventType {
  const s = (event ?? '').toLowerCase();
  if (s.includes('delist')) return 'Delisted';
  if (s.includes('relist')) return 'Relisted';
  if (s.includes('withdrawn') || s.includes('listing removed')) return 'Withdrawn';
  if (s.includes('pending')) return 'Pending';
  if (s.includes('contingent')) return 'Contingent';
  if (s.includes('sold')) return 'Sold';
  if (
    s.includes('price change') ||
    s.includes('price decrease') ||
    s.includes('price increase') ||
    s.includes('price reduced')
  )
    return 'PriceChange';
  // Default: treat unknown as Listed so the price point still surfaces.
  return 'Listed';
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
