import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { registerBulkGetTools, BULK_GET_MAX } from '../../src/tools/bulk-get.js';
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

describe('zillow_bulk_get tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerBulkGetTools(server, mockClient)
    );
  });

  it('returns one row per input zpid, fetched concurrently (issue #46)', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => {
      const m = /\/homedetails\/(\d+)_zpid/.exec(path);
      const zpid = m ? parseInt(m[1], 10) : 0;
      return htmlWith({ zpid, price: zpid * 1000 });
    });

    const r = await harness.callTool('zillow_bulk_get', {
      zpids: [10, 20, 30],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      rows: Array<{ zpid: string; property?: { price?: number }; error?: string }>;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.rows.map((row) => row.property?.price)).toEqual([
      10_000, 20_000, 30_000,
    ]);
  });

  it('captures per-row errors without failing the batch (issue #46)', async () => {
    let call = 0;
    mockFetchHtml.mockImplementation(async () => {
      call++;
      if (call === 2) throw new Error('upstream 502');
      return htmlWith({ zpid: call, price: 100 });
    });
    const r = await harness.callTool('zillow_bulk_get', {
      zpids: [1, 2, 3],
    });
    const parsed = parseToolResult<{
      rows: Array<{ error?: string; property?: { price?: number } }>;
    }>(r);
    expect(parsed.rows[0].property?.price).toBe(100);
    expect(parsed.rows[1].error).toMatch(/upstream 502/);
    expect(parsed.rows[2].property?.price).toBe(100);
  });

  it('accepts urls as an alternative to zpids', async () => {
    mockFetchHtml.mockImplementation(async () =>
      htmlWith({ zpid: 99, price: 999 })
    );
    const r = await harness.callTool('zillow_bulk_get', {
      urls: ['/homedetails/a/99_zpid/', '/homedetails/b/99_zpid/'],
    });
    const parsed = parseToolResult<{ count: number }>(r);
    expect(parsed.count).toBe(2);
  });

  it('rejects calls that exceed BULK_GET_MAX', async () => {
    const tooMany = Array.from({ length: BULK_GET_MAX + 1 }, (_, i) => i + 1);
    const r = await harness.callTool('zillow_bulk_get', { zpids: tooMany });
    expect(r.isError).toBeTruthy();
  });

  it('rejects calls with neither zpids nor urls', async () => {
    const r = await harness.callTool('zillow_bulk_get', {});
    expect(r.isError).toBeTruthy();
  });

  it('does NOT include a summary table by default (issue #46 — structured rows only)', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => {
      const m = /\/homedetails\/(\d+)_zpid/.exec(path);
      const zpid = m ? parseInt(m[1], 10) : 0;
      return htmlWith({ zpid, price: zpid * 1000 });
    });
    const r = await harness.callTool('zillow_bulk_get', { zpids: [1, 2] });
    const parsed = parseToolResult<Record<string, unknown>>(r);
    expect(parsed.summary).toBeUndefined();
  });
});
