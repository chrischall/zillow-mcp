import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { BotWallError } from '../../src/client.js';
import {
  registerBulkGetTools,
  BULK_GET_MAX,
  BULK_GET_CHUNK_SIZE,
  chunk,
} from '../../src/tools/bulk-get.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '../../src/transport-fetchproxy.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
// `fetchPropertyRecord` tries GraphQL first (issue #99); these bulk tests
// cover the SSR scrape + throttle/deadline machinery, so `fetchJson` is
// stubbed to reject → the per-row fetch falls back to the SSR `fetchHtml`
// the assertions drive. (A BotWallError thrown from `fetchHtml` still
// propagates, exercising the bot-wall path.)
const mockFetchJson = vi.fn();
const mockClient = {
  fetchHtml: mockFetchHtml,
  fetchJson: mockFetchJson,
} as unknown as ZillowClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => {
  vi.clearAllMocks();
  mockFetchJson.mockRejectedValue(new Error('graphql disabled in this test'));
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

// Fast-path tuning so the throttle/backoff machinery doesn't make the
// suite wait on real wall-clock delays. A very high RPM effectively
// disables the throttle's gating; tiny backoff delays keep captcha-retry
// tests instant. Real defaults are exercised by their own assertions.
const FAST_TUNING = {
  ratePerMinute: 100_000,
  burst: 1000,
  backoffBaseMs: 1,
  backoffCapMs: 4,
  rng: () => 1,
  // Tiny overall deadline (issue #98) so a hung row trips the partial-
  // results path instantly instead of stalling the suite. Real default
  // (well under the MCP client timeout) is exercised separately.
  overallDeadlineMs: 200,
};

describe('zillow_bulk_get tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerBulkGetTools(server, mockClient, FAST_TUNING)
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

  it('surfaces lot_size + derived lot_size_acres per row, null-safe (#82)', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => {
      const m = /\/homedetails\/(\d+)_zpid/.exec(path);
      const zpid = m ? parseInt(m[1], 10) : 0;
      // zpid 1 = SFH with a lot; zpid 2 = condo (no lotSize).
      return htmlWith(
        zpid === 1 ? { zpid, lotSize: 45_738 } : { zpid }
      );
    });
    const r = await harness.callTool('zillow_bulk_get', { zpids: [1, 2] });
    const parsed = parseToolResult<{
      rows: Array<{
        property?: { lot_size: number | null; lot_size_acres: number | null };
      }>;
    }>(r);
    expect(parsed.rows[0].property?.lot_size).toBe(45_738);
    expect(parsed.rows[0].property?.lot_size_acres).toBe(1.05);
    expect(parsed.rows[1].property?.lot_size).toBeNull();
    expect(parsed.rows[1].property?.lot_size_acres).toBeNull();
    // Condo lot must be null, never 0.
    expect(parsed.rows[1].property?.lot_size_acres).not.toBe(0);
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

  describe('px-captcha classification + backoff retry (issue #90)', () => {
    it('classifies a px-captcha block as bot_challenge — NOT not-found, NOT generic error', async () => {
      // Always blocked, even on retry → the row stays a captcha block and
      // must be reported as such (never a bare miss).
      mockFetchHtml.mockImplementation(async () => {
        throw new BotWallError('/homedetails/x/42_zpid/');
      });
      const r = await harness.callTool('zillow_bulk_get', { zpids: [42] });
      const parsed = parseToolResult<{
        rows: Array<{ zpid: string; error?: string; error_kind?: string }>;
      }>(r);
      const row = parsed.rows[0];
      expect(row.error_kind).toBe('bot_challenge');
      // It must NOT look like a generic fetch failure or a not-found.
      expect(row.error).not.toMatch(/could not locate property/i);
      expect(row.error).toMatch(/captcha/i);
    });

    it('retries a px-captcha-blocked sub-request with backoff and recovers', async () => {
      // First attempt at zpid 20 trips the wall; the backoff retry clears.
      const callsByZpid: Record<string, number> = {};
      mockFetchHtml.mockImplementation(async (path: string) => {
        const m = /\/homedetails\/(\d+)_zpid/.exec(path);
        const zpid = m ? m[1] : '0';
        callsByZpid[zpid] = (callsByZpid[zpid] ?? 0) + 1;
        if (zpid === '20' && callsByZpid[zpid] === 1) {
          throw new BotWallError(path);
        }
        return htmlWith({ zpid: parseInt(zpid, 10), price: 555 });
      });
      const r = await harness.callTool('zillow_bulk_get', {
        zpids: [10, 20, 30],
      });
      const parsed = parseToolResult<{
        blocked?: number;
        rows: Array<{ zpid: string; property?: { price: number }; error?: string }>;
      }>(r);
      // The blocked row recovered on retry — no error, real property.
      expect(parsed.rows[1].error).toBeUndefined();
      expect(parsed.rows[1].property?.price).toBe(555);
      expect(callsByZpid['20']).toBe(2);
      // Nothing ultimately blocked → no partial-result envelope.
      expect(parsed.blocked ?? 0).toBe(0);
    });

    it('surfaces a partial-result envelope { blocked, retry_after_s } when captcha persists', async () => {
      // zpid 20 is permanently walled; others succeed. After exhausting
      // retries the batch returns partial with a blocked count + hint.
      mockFetchHtml.mockImplementation(async (path: string) => {
        const m = /\/homedetails\/(\d+)_zpid/.exec(path);
        const zpid = m ? m[1] : '0';
        if (zpid === '20') throw new BotWallError(path, 17);
        return htmlWith({ zpid: parseInt(zpid, 10), price: 1 });
      });
      const r = await harness.callTool('zillow_bulk_get', {
        zpids: [10, 20, 30],
      });
      const parsed = parseToolResult<{
        blocked: number;
        retry_after_s: number;
        rows: Array<{ zpid: string; error?: string; error_kind?: string }>;
      }>(r);
      expect(parsed.blocked).toBe(1);
      expect(parsed.retry_after_s).toBeGreaterThan(0);
      // The blocked row carries the captcha kind, the others are clean.
      const blockedRow = parsed.rows.find((row) => row.zpid === '20');
      expect(blockedRow?.error_kind).toBe('bot_challenge');
      const okRows = parsed.rows.filter((row) => row.zpid !== '20');
      expect(okRows.every((row) => row.error === undefined)).toBe(true);
    });

    it('a px-captcha block NEVER round-trips through the not-found diagnosis path', async () => {
      // Regression guard for the exact silent-corruption bug in #90:
      // a bot-wall must not be reported with the "Could not locate
      // property data … Zillow probably redirected …" not-found message.
      mockFetchHtml.mockImplementation(async () => {
        throw new BotWallError('/homedetails/x/7_zpid/');
      });
      const r = await harness.callTool('zillow_bulk_get', { zpids: [7] });
      const parsed = parseToolResult<{
        rows: Array<{ error?: string; error_kind?: string }>;
      }>(r);
      expect(parsed.rows[0].error_kind).toBe('bot_challenge');
      expect(parsed.rows[0].error).not.toMatch(/redirected/i);
      expect(parsed.rows[0].error).not.toMatch(/no listing found/i);
    });
  });

  describe('overall hard deadline → partial results, never wedges (issue #98)', () => {
    it('returns partial results when a single row hangs, others still resolve', async () => {
      // zpid 20 never settles; the overall deadline must fire and the
      // call must return with the other rows' real data plus a per-row
      // marker for the hung row — NOT hang for the full client timeout.
      mockFetchHtml.mockImplementation(async (path: string) => {
        const m = /\/homedetails\/(\d+)_zpid/.exec(path);
        const zpid = m ? m[1] : '0';
        if (zpid === '20') {
          // Never resolves — simulates the wedging row from the report.
          return new Promise<string>(() => {});
        }
        return htmlWith({ zpid: parseInt(zpid, 10), price: 777 });
      });
      const r = await harness.callTool(
        'zillow_bulk_get',
        { zpids: [10, 20, 30] },
        // tiny deadline so the test resolves instantly
      );
      const parsed = parseToolResult<{
        count: number;
        pending?: number;
        rows: Array<{
          zpid: string;
          property?: { price: number };
          error?: string;
          error_kind?: string;
        }>;
      }>(r);
      // Every input id still produces exactly one row, in input order.
      expect(parsed.count).toBe(3);
      expect(parsed.rows.map((row) => row.zpid)).toEqual(['10', '20', '30']);
      // The good rows returned real data.
      expect(parsed.rows[0].property?.price).toBe(777);
      expect(parsed.rows[2].property?.price).toBe(777);
      // The hung row is surfaced as pending — distinct, machine-readable,
      // and NOT a generic miss / not-found.
      expect(parsed.rows[1].property).toBeUndefined();
      expect(parsed.rows[1].error_kind).toBe('pending');
      expect(parsed.rows[1].error).not.toMatch(/could not locate property/i);
      // The partial-result envelope advertises the pending count.
      expect(parsed.pending).toBe(1);
    }, 5000);

    it('does not poison the connection: the handler resolves promptly even with a hung row', async () => {
      // Regression guard for the wedge: the call must settle well within
      // the test timeout despite a permanently-hanging row.
      mockFetchHtml.mockImplementation(async (path: string) => {
        const m = /\/homedetails\/(\d+)_zpid/.exec(path);
        const zpid = m ? m[1] : '0';
        if (zpid === '5') return new Promise<string>(() => {});
        return htmlWith({ zpid: parseInt(zpid, 10), price: 1 });
      });
      const start = Date.now();
      const r = await harness.callTool('zillow_bulk_get', { zpids: [1, 5, 9] });
      const elapsed = Date.now() - start;
      expect(r.isError).toBeFalsy();
      // The default test deadline is tiny (FAST_TUNING) so this returns fast.
      expect(elapsed).toBeLessThan(3000);
    }, 5000);

    it('all rows resolving before the deadline → no pending marker', async () => {
      mockFetchHtml.mockImplementation(async (path: string) => {
        const m = /\/homedetails\/(\d+)_zpid/.exec(path);
        const zpid = m ? parseInt(m[1], 10) : 0;
        return htmlWith({ zpid, price: zpid });
      });
      const r = await harness.callTool('zillow_bulk_get', { zpids: [1, 2] });
      const parsed = parseToolResult<{
        pending?: number;
        rows: Array<{ error_kind?: string }>;
      }>(r);
      expect(parsed.pending ?? 0).toBe(0);
      expect(parsed.rows.every((row) => row.error_kind === undefined)).toBe(true);
    });
  });

  describe('auto-chunk with paced dispatch (issue #90 part c)', () => {
    it('exposes a safe internal chunk size', () => {
      expect(BULK_GET_CHUNK_SIZE).toBeGreaterThan(0);
      expect(BULK_GET_CHUNK_SIZE).toBeLessThanOrEqual(25);
    });

    it('dispatches a large id list in safe-sized pages, never all at once', async () => {
      // Record how many distinct fetches are in flight across the whole
      // call. With paced chunking the peak concurrency stays bounded by
      // BRIDGE_CONCURRENCY even for a >chunk-size id list — pages are
      // dispatched sequentially, not fanned out together.
      let inFlight = 0;
      let peak = 0;
      mockFetchHtml.mockImplementation(async (path: string) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((res) => setTimeout(res, 4));
        inFlight--;
        const m = /\/homedetails\/(\d+)_zpid/.exec(path);
        const zpid = m ? parseInt(m[1], 10) : 0;
        return htmlWith({ zpid, price: zpid });
      });
      const n = BULK_GET_CHUNK_SIZE * 3 + 5;
      const zpids = Array.from({ length: n }, (_, i) => i + 1);
      const r = await harness.callTool('zillow_bulk_get', { zpids });
      const parsed = parseToolResult<{
        count: number;
        rows: Array<{ zpid: string; property?: { price: number } }>;
      }>(r);
      // Every id still produces exactly one row, in input order.
      expect(parsed.count).toBe(n);
      expect(parsed.rows.map((row) => row.zpid)).toEqual(
        zpids.map((z) => String(z))
      );
      // Peak in-flight never exceeds the concurrency cap — the chunks did
      // not all fan out simultaneously.
      expect(peak).toBeLessThanOrEqual(6);
    });
  });
});

// `chunk()` stays a local bulk-get helper after the 0.10.0 migration —
// the resilience kit hoisted TokenBucket/backoffDelayMs (now tested
// upstream in @fetchproxy/server) but not this array splitter.
describe('chunk()', () => {
  it('splits an array into pages of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns a single page when the input fits', () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });

  it('returns an empty array for empty input', () => {
    expect(chunk([], 5)).toEqual([]);
  });

  it('treats a non-positive size as a single page (defensive)', () => {
    expect(chunk([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
  });
});
