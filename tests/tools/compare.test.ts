import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { buildSummary, registerCompareTools } from '../../src/tools/compare.js';
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

describe('buildSummary', () => {
  it('aligns each field across N properties + null-fills error rows', () => {
    const rows = buildSummary([
      {
        zpid: '1',
        property: {
          zpid: '1',
          url: 'u',
          price: 100,
          beds: 2,
          baths: 1,
        } as never,
      },
      { zpid: '2', error: 'fetch failed' },
      {
        zpid: '3',
        property: {
          zpid: '3',
          url: 'u',
          price: 300,
          beds: 4,
          baths: 3,
        } as never,
      },
    ]);
    const priceRow = rows.find((r) => r.field === 'price')!;
    expect(priceRow.values).toEqual([100, null, 300]);
    const bedsRow = rows.find((r) => r.field === 'beds')!;
    expect(bedsRow.values).toEqual([2, null, 4]);
  });
});

describe('zillow_compare_properties tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerCompareTools(server, mockClient)
    );
  });

  it('fetches each zpid concurrently and returns aligned summary + results', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => {
      const m = /\/homedetails\/(\d+)_zpid/.exec(path);
      const zpid = m ? parseInt(m[1], 10) : 0;
      return htmlWith({
        zpid,
        price: zpid * 100_000,
        bedrooms: zpid,
        bathrooms: zpid,
        livingArea: zpid * 500,
      });
    });

    const r = await harness.callTool('zillow_compare_properties', {
      zpids: [1, 2, 3],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      summary: Array<{ field: string; values: unknown[] }>;
      results: Array<{ zpid: string; property?: { price?: number }; error?: string }>;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.results.map((res) => res.property?.price)).toEqual([
      100_000, 200_000, 300_000,
    ]);
    const summaryPrices = parsed.summary.find((s) => s.field === 'price')!;
    expect(summaryPrices.values).toEqual([100_000, 200_000, 300_000]);
  });

  it('captures per-property errors without failing the whole call', async () => {
    let call = 0;
    mockFetchHtml.mockImplementation(async () => {
      call++;
      if (call === 2) throw new Error('boom');
      return htmlWith({ zpid: call, price: 100 });
    });
    const r = await harness.callTool('zillow_compare_properties', {
      zpids: [1, 2, 3],
    });
    const parsed = parseToolResult<{
      results: Array<{ error?: string; property?: { price: number } }>;
    }>(r);
    expect(parsed.results[0].property?.price).toBe(100);
    expect(parsed.results[1].error).toMatch(/boom/);
    expect(parsed.results[2].property?.price).toBe(100);
  });

  it('errors when fewer than 2 ids provided', async () => {
    const r = await harness.callTool('zillow_compare_properties', { zpids: [1] });
    expect(r.isError).toBeTruthy();
  });

  it('accepts up to 25 zpids per call (issue #60 — cap raised from 8 to 25)', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => {
      const m = /\/homedetails\/(\d+)_zpid/.exec(path);
      const zpid = m ? parseInt(m[1], 10) : 0;
      return htmlWith({ zpid, price: zpid });
    });
    const zpids = Array.from({ length: 25 }, (_, i) => i + 1);
    const r = await harness.callTool('zillow_compare_properties', { zpids });
    const parsed = parseToolResult<{ count: number }>(r);
    expect(parsed.count).toBe(25);
  });

  it('rejects more than 25 zpids per call (cap enforced)', async () => {
    const zpids = Array.from({ length: 26 }, (_, i) => i + 1);
    const r = await harness.callTool('zillow_compare_properties', { zpids });
    expect(r.isError).toBeTruthy();
  });

  it('accepts urls as an alternative to zpids', async () => {
    mockFetchHtml.mockImplementation(async () =>
      htmlWith({ zpid: 99, price: 999 })
    );
    const r = await harness.callTool('zillow_compare_properties', {
      urls: [
        '/homedetails/a/99_zpid/',
        '/homedetails/b/99_zpid/',
      ],
    });
    const parsed = parseToolResult<{ count: number }>(r);
    expect(parsed.count).toBe(2);
  });
});
