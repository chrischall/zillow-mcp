import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import {
  formatPriceEvent,
  formatTaxEvent,
  registerHistoryTools,
} from '../../src/tools/history.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
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
