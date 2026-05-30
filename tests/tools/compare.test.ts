import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { buildSummary, registerCompareTools } from '../../src/tools/compare.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '../../src/transport-fetchproxy.js';
import { createTestHarness, parseToolResult } from '../helpers.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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

  it('includes lot_size_sqft + lot_size_acres in the summary (#82)', () => {
    const rows = buildSummary([
      {
        zpid: '1',
        property: {
          zpid: '1',
          url: 'u',
          lot_size: 45_738,
          lot_size_acres: 1.05,
        } as never,
      },
      {
        zpid: '2',
        property: {
          zpid: '2',
          url: 'v',
          lot_size: null,
          lot_size_acres: null,
        } as never,
      },
    ]);
    expect(rows.find((r) => r.field === 'lot_size_sqft')?.values).toEqual([45_738, null]);
    expect(rows.find((r) => r.field === 'lot_size_acres')?.values).toEqual([1.05, null]);
  });
});

describe('zillow_compare_properties tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerCompareTools(server, mockClient)
    );
  });

  it('fetches each zpid concurrently and returns aligned results (summary opt-in)', async () => {
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
      include_summary: true,
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      summary?: Array<{ field: string; values: unknown[] }>;
      results: Array<{ zpid: string; property?: { price?: number }; error?: string }>;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.results.map((res) => res.property?.price)).toEqual([
      100_000, 200_000, 300_000,
    ]);
    expect(parsed.summary).toBeDefined();
    const summaryPrices = parsed.summary!.find((s) => s.field === 'price')!;
    expect(summaryPrices.values).toEqual([100_000, 200_000, 300_000]);
  });

  it('omits summary by default (issue #45)', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => {
      const m = /\/homedetails\/(\d+)_zpid/.exec(path);
      const zpid = m ? parseInt(m[1], 10) : 0;
      return htmlWith({ zpid, price: zpid * 100_000 });
    });
    const r = await harness.callTool('zillow_compare_properties', {
      zpids: [1, 2],
    });
    const parsed = parseToolResult<{
      summary?: Array<{ field: string; values: unknown[] }>;
      results: unknown[];
    }>(r);
    expect(parsed.summary).toBeUndefined();
    expect(parsed.results).toHaveLength(2);
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

  it('accepts up to 25 zpids per call (issues #60, #79 — cap raised from 8 to 25)', async () => {
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

  it('rejects 26 zpids — boundary check on the 25 cap (issue #79)', async () => {
    const zpids = Array.from({ length: 26 }, (_, i) => i + 1);
    const r = await harness.callTool('zillow_compare_properties', { zpids });
    expect(r.isError).toBeTruthy();
  });

  it('rejects 26 urls — boundary check on the 25 cap (issue #79)', async () => {
    const urls = Array.from(
      { length: 26 },
      (_, i) => `/homedetails/x/${i + 1}_zpid/`
    );
    const r = await harness.callTool('zillow_compare_properties', { urls });
    expect(r.isError).toBeTruthy();
  });

  describe('tool description framing (issue #79)', () => {
    // The reporter said "compare looks like the fetch-many tool and
    // isn't" — the doc fix matters as much as the cap. Verify the
    // description (a) advertises the 25 cap so callers know it was
    // raised from 8, and (b) cross-references zillow_bulk_get so
    // batches >25 land at the right tool.
    async function getCompareDescription(): Promise<string> {
      const server = new McpServer({ name: 't', version: '0.0.0' });
      registerCompareTools(server, mockClient);
      const client = new Client({ name: 'tc', version: '0.0.0' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      const { tools } = await client.listTools();
      await client.close();
      await server.close();
      const t = tools.find((t) => t.name === 'zillow_compare_properties');
      if (!t) throw new Error('tool missing');
      return t.description ?? '';
    }

    it('description mentions the 25 cap and cross-references zillow_bulk_get', async () => {
      const d = await getCompareDescription();
      expect(d).toMatch(/25/);
      expect(d).toMatch(/zillow_bulk_get/);
    });

    it('description frames compare as side-by-side analysis, not fetch-many', async () => {
      const d = await getCompareDescription();
      expect(d).toMatch(/side[- ]by[- ]side/i);
    });
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

  describe('bulk concurrency + retry-once-on-timeout (issue #78 follow-up)', () => {
    // Compare used to do unbounded Promise.all for up to 25 zpids. The
    // round-3 session that motivated #78 saw 7-of-20 timeouts at
    // unlimited concurrency — 25 sits in the same risk window. These
    // tests mirror the bulk-get coverage so compare absorbs transient
    // SW evictions instead of failing rows.

    it('caps internal concurrency to BRIDGE_CONCURRENCY', async () => {
      let inFlight = 0;
      let peak = 0;
      mockFetchHtml.mockImplementation(async (path: string) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 8));
        inFlight--;
        const m = /\/homedetails\/(\d+)_zpid/.exec(path);
        const zpid = m ? parseInt(m[1], 10) : 0;
        return htmlWith({ zpid, price: 1 });
      });
      const zpids = Array.from({ length: 14 }, (_, i) => i + 1);
      await harness.callTool('zillow_compare_properties', { zpids });
      expect(peak).toBeLessThanOrEqual(6);
      expect(peak).toBeGreaterThan(1);
    });

    it('retries a sub-request once on FetchproxyTimeoutError, then returns property', async () => {
      const callsByZpid: Record<string, number> = {};
      mockFetchHtml.mockImplementation(async (path: string) => {
        const m = /\/homedetails\/(\d+)_zpid/.exec(path);
        const zpid = m ? m[1] : '0';
        callsByZpid[zpid] = (callsByZpid[zpid] ?? 0) + 1;
        if (zpid === '20' && callsByZpid[zpid] === 1) {
          throw new FetchproxyTimeoutError({
            url: '/x',
            timeoutMs: 30_000,
          });
        }
        return htmlWith({ zpid: parseInt(zpid, 10), price: 999 });
      });
      const r = await harness.callTool('zillow_compare_properties', {
        zpids: [10, 20, 30],
      });
      const parsed = parseToolResult<{
        results: Array<{ zpid: string; property?: { price: number }; error?: string }>;
      }>(r);
      expect(parsed.results[1].error).toBeUndefined();
      expect(parsed.results[1].property?.price).toBe(999);
      expect(callsByZpid['20']).toBe(2);
    });

    it('surfaces a bridge-timeout error after retry exhaustion (NOT a generic miss)', async () => {
      mockFetchHtml.mockImplementation(async () => {
        throw new FetchproxyTimeoutError({ url: '/x', timeoutMs: 30_000 });
      });
      const r = await harness.callTool('zillow_compare_properties', {
        zpids: [42, 43],
      });
      const parsed = parseToolResult<{
        results: Array<{ error?: string }>;
      }>(r);
      expect(parsed.results[0].error).toBeDefined();
      expect(parsed.results[0].error).toMatch(/timeout/i);
    });

    it('surfaces a "bridge unreachable" error when FetchproxyBridgeDownError fires after the revive retry', async () => {
      mockFetchHtml.mockImplementation(async () => {
        throw new FetchproxyBridgeDownError({
          originalError: 'Could not establish connection.',
          retryAttempted: true,
        });
      });
      const r = await harness.callTool('zillow_compare_properties', {
        zpids: [42, 43],
      });
      const parsed = parseToolResult<{
        results: Array<{ error?: string }>;
      }>(r);
      expect(parsed.results[0].error).toBeDefined();
      expect(parsed.results[0].error).toMatch(/^bridge unreachable: /);
    });
  });
});
