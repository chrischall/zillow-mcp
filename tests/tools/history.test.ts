import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import {
  type FormattedPriceEvent,
  formatPriceEvent,
  formatTaxEvent,
  normalizePriceEvent,
  type NormalizedPriceEvent,
  registerHistoryTools,
} from '../../src/tools/history.js';
import { registerPropertyTools } from '../../src/tools/properties.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
// `fetchPropertyRecord` is SSR-only; these tests cover the SSR scrape
// (`fetchHtml`). `mockFetchJson` is vestigial shape parity on the stub.
const mockFetchJson = vi.fn();
const mockClient = {
  fetchHtml: mockFetchHtml,
  fetchJson: mockFetchJson,
} as unknown as ZillowClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => {
  vi.clearAllMocks();
});
afterAll(async () => {
  if (harness) await harness.close();
});

function htmlWith(property: Record<string, unknown>): string {
  const cache = { [`Property:${property.zpid}`]: { property } };
  const nextData = {
    props: { pageProps: { gdpClientCache: JSON.stringify(cache) } },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData
  )}</script>`;
}

describe('formatPriceEvent', () => {
  it('extracts and percent-formats a price-history entry', () => {
    expect(
      formatPriceEvent({
        date: '2026-05-20',
        event: 'Listed for sale',
        price: 2449999,
        priceChangeRate: 1.5128,
        pricePerSquareFoot: 778,
        source: 'SIBOR',
        attributeSource: { infoString1: '2602810' },
      })
    ).toEqual({
      date: '2026-05-20',
      event: 'Listed for sale',
      price: 2449999,
      price_change_percent: 151.3,
      price_per_sqft: 778,
      source: 'SIBOR',
      mls_number: '2602810',
    });
  });

  it('derives date from unix-ms `time` when string date is absent', () => {
    const out = formatPriceEvent({ time: Date.parse('2024-01-15') });
    expect(out.date).toBe('2024-01-15');
  });

  it('leaves price_change_percent undefined when rate is absent', () => {
    expect(formatPriceEvent({ price: 100 }).price_change_percent).toBeUndefined();
  });
});

describe('formatTaxEvent', () => {
  it('extracts a tax-history entry with year + rates', () => {
    expect(
      formatTaxEvent({
        time: Date.parse('2024-06-01'),
        taxPaid: 12000,
        taxIncreaseRate: 0.045,
        value: 850000,
        valueIncreaseRate: 0.03,
      })
    ).toEqual({
      year: 2024,
      tax_paid: 12000,
      tax_increase_percent: 4.5,
      assessed_value: 850000,
      assessed_value_increase_percent: 3,
    });
  });

  it('handles missing rates gracefully', () => {
    expect(formatTaxEvent({ time: Date.parse('2020-01-01'), taxPaid: 8000 })).toEqual({
      year: 2020,
      tax_paid: 8000,
      tax_increase_percent: undefined,
      assessed_value: undefined,
      assessed_value_increase_percent: undefined,
    });
  });
});

describe('history tools — MCP integration', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerHistoryTools(server, mockClient)
    );
  });

  it('zillow_get_price_history returns the formatted series', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith({
        zpid: 42,
        priceHistory: [
          { date: '2024-01-01', event: 'Listed for sale', price: 500_000 },
          { date: '2024-03-01', event: 'Price change', price: 480_000, priceChangeRate: -0.04 },
        ],
      })
    );
    const r = await harness.callTool('zillow_get_price_history', { zpid: 42 });
    const parsed = parseToolResult<{ zpid: string; events: Array<{ price: number }> }>(r);
    expect(parsed.zpid).toBe('42');
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[1].price).toBe(480_000);
  });

  it('zillow_get_tax_history returns the formatted series', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith({
        zpid: 7,
        taxHistory: [
          { time: Date.parse('2024-06-01'), taxPaid: 12_000, value: 850_000 },
          { time: Date.parse('2023-06-01'), taxPaid: 11_400, value: 820_000 },
        ],
      })
    );
    const r = await harness.callTool('zillow_get_tax_history', { zpid: 7 });
    const parsed = parseToolResult<{ zpid: string; events: Array<{ year: number }> }>(r);
    expect(parsed.events.map((e) => e.year)).toEqual([2024, 2023]);
  });

  it('returns empty events when the property has no history', async () => {
    mockFetchHtml.mockResolvedValueOnce(htmlWith({ zpid: 1 }));
    const r = await harness.callTool('zillow_get_price_history', { zpid: 1 });
    const parsed = parseToolResult<{ events: unknown[] }>(r);
    expect(parsed.events).toEqual([]);
  });
});

describe('normalizePriceEvent', () => {
  const make = (event: string): FormattedPriceEvent => ({
    date: '2025-01-15',
    event,
    price: 500_000,
  });
  function typeOf(event: string): NormalizedPriceEvent['type'] {
    return normalizePriceEvent(make(event)).type;
  }

  it('maps "Listed for sale" -> Listed', () => {
    expect(typeOf('Listed for sale')).toBe('Listed');
  });
  it('maps "Price change" -> PriceChange', () => {
    expect(typeOf('Price change')).toBe('PriceChange');
  });
  it('maps "Price reduced" -> PriceChange', () => {
    expect(typeOf('Price reduced')).toBe('PriceChange');
  });
  it('maps "Sold" -> Sold', () => {
    expect(typeOf('Sold')).toBe('Sold');
  });
  it('maps "Pending sale" -> Pending', () => {
    expect(typeOf('Pending sale')).toBe('Pending');
  });
  it('maps "Listing removed" -> Withdrawn', () => {
    expect(typeOf('Listing removed')).toBe('Withdrawn');
  });
  it('maps "Contingent" -> Contingent', () => {
    expect(typeOf('Contingent')).toBe('Contingent');
  });
  it('maps "Relisted" -> Relisted', () => {
    expect(typeOf('Relisted')).toBe('Relisted');
  });
  it('maps "Listing delisted" -> Delisted', () => {
    expect(typeOf('Listing delisted')).toBe('Delisted');
  });
  it('falls back to Listed for an unrecognized event (best-effort)', () => {
    // Unknown labels default to Listed; raw event is still on the parallel `events` array.
    expect(typeOf('Some weird future event')).toBe('Listed');
  });

  // CANONICAL DELTA (realty-mcp#1): `normalizeEventType` now delegates to
  // realty-core's `mapEventType` (collapsing its `Unknown` sentinel back
  // to zillow's `Listed` default). It produces identical results to the
  // old inline mapper for every event zillow has surfaced, AND adds the
  // wider cohort synonym set — so a few labels that the old mapper let
  // fall through to the `Listed` default now classify more specifically.
  it('DELTA: wider cohort synonyms now classify (were Listed by default)', () => {
    expect(typeOf('Off Market')).toBe('Delisted');
    expect(typeOf('Price Drop')).toBe('PriceChange');
    expect(typeOf('Closed')).toBe('Sold');
  });

  // CANONICAL DELTA (realty-mcp#1, realty-core 0.4.0): `mapEventType` now
  // recognizes "completed" as a close-of-sale synonym, so "Sale Completed" /
  // "Completed" classify as Sold (were Listed by default under the old mapper).
  it('DELTA: "completed" sale synonyms now classify as Sold', () => {
    expect(typeOf('Sale Completed')).toBe('Sold');
    expect(typeOf('Completed')).toBe('Sold');
  });

  it('carries date/price/source_mls/price_change_pct through', () => {
    const normalized = normalizePriceEvent({
      date: '2025-01-15',
      event: 'Listed for sale',
      price: 500_000,
      price_change_percent: 4.0,
      source: 'SIBOR',
      mls_number: '12345',
    });
    expect(normalized).toEqual({
      date: '2025-01-15',
      type: 'Listed',
      price: 500_000,
      price_change_pct: 4.0,
      source_mls: 'SIBOR',
    });
  });
});

describe('zillow_get_price_history — events_normalized', () => {
  it('attaches events_normalized alongside the raw events series', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith({
        zpid: 42,
        priceHistory: [
          { date: '2024-01-01', event: 'Listed for sale', price: 500_000 },
          { date: '2024-03-01', event: 'Price change', price: 480_000, priceChangeRate: -0.04 },
          { date: '2024-05-01', event: 'Sold', price: 475_000 },
        ],
      })
    );
    const r = await harness.callTool('zillow_get_price_history', { zpid: 42 });
    const parsed = parseToolResult<{
      events: unknown[];
      events_normalized: Array<{ date: string; type: string; price?: number; price_change_pct?: number }>;
    }>(r);
    expect(parsed.events).toHaveLength(3);
    expect(parsed.events_normalized).toHaveLength(3);
    expect(parsed.events_normalized.map((e) => e.type)).toEqual([
      'Listed',
      'PriceChange',
      'Sold',
    ]);
    expect(parsed.events_normalized[1].price_change_pct).toBe(-4);
  });
});

describe('zillow_get_property — bundled history flags', () => {
  it('omits price_history and tax_history by default', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith({
        zpid: 1,
        priceHistory: [{ date: '2024-01-01', event: 'Listed for sale', price: 100 }],
        taxHistory: [{ time: Date.parse('2024-06-01'), taxPaid: 100 }],
      })
    );
    // Use the property tool, not history.
    const propHarness = await createTestHarness((server) =>
      registerPropertyTools(server, mockClient)
    );
    try {
      const r = await propHarness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{
        price_history?: unknown;
        tax_history?: unknown;
      }>(r);
      expect(parsed.price_history).toBeUndefined();
      expect(parsed.tax_history).toBeUndefined();
    } finally {
      await propHarness.close();
    }
  });

  it('includes price_history when include_price_history: true', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith({
        zpid: 1,
        priceHistory: [
          { date: '2024-01-01', event: 'Listed for sale', price: 500_000 },
          { date: '2024-03-01', event: 'Price change', price: 480_000, priceChangeRate: -0.04 },
        ],
      })
    );
    const propHarness = await createTestHarness((server) =>
      registerPropertyTools(server, mockClient)
    );
    try {
      const r = await propHarness.callTool('zillow_get_property', {
        zpid: 1,
        include_price_history: true,
      });
      const parsed = parseToolResult<{
        price_history?: {
          events: Array<{ price: number }>;
          events_normalized: Array<{ type: string }>;
        };
      }>(r);
      expect(parsed.price_history).toBeDefined();
      expect(parsed.price_history!.events).toHaveLength(2);
      expect(parsed.price_history!.events_normalized).toHaveLength(2);
    } finally {
      await propHarness.close();
    }
  });

  it('includes tax_history when include_tax_history: true', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith({
        zpid: 1,
        taxHistory: [
          { time: Date.parse('2024-06-01'), taxPaid: 12_000, value: 850_000 },
        ],
      })
    );
    const propHarness = await createTestHarness((server) =>
      registerPropertyTools(server, mockClient)
    );
    try {
      const r = await propHarness.callTool('zillow_get_property', {
        zpid: 1,
        include_tax_history: true,
      });
      const parsed = parseToolResult<{ tax_history?: Array<{ year: number }> }>(r);
      expect(parsed.tax_history).toBeDefined();
      expect(parsed.tax_history).toHaveLength(1);
      expect(parsed.tax_history![0].year).toBe(2024);
    } finally {
      await propHarness.close();
    }
  });
});
