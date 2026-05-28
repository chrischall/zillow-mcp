import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { registerBulkGetTools, BULK_GET_MAX } from '../../src/tools/bulk-get.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '../../src/transport-fetchproxy.js';
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

  describe('bulk concurrency + retry-once-on-timeout (issue #78)', () => {
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
      const r = await harness.callTool('zillow_bulk_get', {
        zpids: [10, 20, 30],
      });
      const parsed = parseToolResult<{
        rows: Array<{ zpid: string; property?: { price: number }; error?: string }>;
      }>(r);
      expect(parsed.rows[1].error).toBeUndefined();
      expect(parsed.rows[1].property?.price).toBe(999);
      expect(callsByZpid['20']).toBe(2);
    });

    it('surfaces a bridge-timeout error after retry exhaustion (NOT a generic miss)', async () => {
      mockFetchHtml.mockImplementation(async () => {
        throw new FetchproxyTimeoutError({ url: '/x', timeoutMs: 30_000 });
      });
      const r = await harness.callTool('zillow_bulk_get', { zpids: [42] });
      const parsed = parseToolResult<{
        rows: Array<{ error?: string }>;
      }>(r);
      expect(parsed.rows[0].error).toBeDefined();
      expect(parsed.rows[0].error).toMatch(/timeout/i);
    });

    it('surfaces a "bridge unreachable" error when FetchproxyBridgeDownError fires after the revive retry', async () => {
      // Item 2 follow-up to #84 (PR #78): the bridge_down branch on
      // bulk-get.ts ~L117 was previously uncovered. When the
      // transport's `bridgeReviveDelayMs` retry also fails, the inner
      // call raises FetchproxyBridgeDownError (NOT a timeout) — the
      // per-row error must rewrite to `bridge unreachable: ...` so the
      // caller can distinguish a dead SW from a true upstream miss.
      mockFetchHtml.mockImplementation(async () => {
        throw new FetchproxyBridgeDownError({
          originalError: 'Could not establish connection.',
          retryAttempted: true,
        });
      });
      const r = await harness.callTool('zillow_bulk_get', { zpids: [42] });
      const parsed = parseToolResult<{
        rows: Array<{ error?: string }>;
      }>(r);
      expect(parsed.rows[0].error).toBeDefined();
      expect(parsed.rows[0].error).toMatch(/^bridge unreachable: /);
    });

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
      await harness.callTool('zillow_bulk_get', { zpids });
      expect(peak).toBeLessThanOrEqual(6);
      expect(peak).toBeGreaterThan(1);
    });
  });
});
