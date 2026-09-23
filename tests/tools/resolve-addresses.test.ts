import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { BotWallError } from '../../src/client.js';
import { registerResolveAddressesTools } from '../../src/tools/resolve-addresses.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '../../src/transport-fetchproxy.js';
import { createTestHarness, parseToolResult } from '../helpers.js';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

/**
 * Build a Zillow search HTML payload with a single listing that includes
 * a matching token from the supplied address (so the
 * `listingsMatchLocation` guard passes).
 */
function htmlWithListing(args: {
  zpid: number;
  detailUrl?: string;
  city?: string;
  state?: string;
  zip?: string;
  streetAddress?: string;
}): string {
  const sps = {
    queryState: { regionSelection: [], mapBounds: null },
    cat1: {
      searchResults: {
        listResults: [
          {
            zpid: args.zpid,
            detailUrl: args.detailUrl ?? `/homedetails/x/${args.zpid}_zpid/`,
            hdpData: {
              homeInfo: {
                zpid: args.zpid,
                streetAddress: args.streetAddress,
                city: args.city,
                state: args.state,
                zipcode: args.zip,
              },
            },
          },
        ],
      },
    },
  };
  const nextData = { props: { pageProps: { searchPageState: sps } } };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData
  )}</script>`;
}

describe('zillow_resolve_addresses tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerResolveAddressesTools(server, mockClient)
    );
  });

  it('returns one row per address, fetched concurrently (issue #53)', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => {
      // Pull the first numeric token out of the slug as the fake zpid,
      // and infer the city from a known set so the location guard passes.
      const m = /\/homes\/([^_]+)_rb/.exec(path);
      const slug = m ? decodeURIComponent(m[1]) : '';
      if (slug.includes('126 Sleeping')) {
        return htmlWithListing({
          zpid: 100,
          streetAddress: '126 Sleeping Bear Ln',
          city: 'Lake Lure',
          state: 'NC',
          zip: '28746',
        });
      }
      if (slug.includes('1 Main')) {
        return htmlWithListing({
          zpid: 200,
          streetAddress: '1 Main St',
          city: 'Brooklyn',
          state: 'NY',
          zip: '11215',
        });
      }
      return htmlWithListing({ zpid: 0 });
    });

    const r = await harness.callTool('zillow_resolve_addresses', {
      addresses: ['126 Sleeping Bear Ln, Lake Lure, NC', '1 Main St, Brooklyn, NY'],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      results: Array<{
        address: string;
        resolved: boolean;
        zpid?: string;
        url?: string;
        confidence?: string;
      }>;
    }>(r);
    expect(parsed.count).toBe(2);
    expect(parsed.results[0].resolved).toBe(true);
    expect(parsed.results[0].zpid).toBe('100');
    expect(parsed.results[1].resolved).toBe(true);
    expect(parsed.results[1].zpid).toBe('200');
  });

  it('degrades to resolved=false (confidence="none") when no listing comes back', async () => {
    mockFetchHtml.mockResolvedValue(
      `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>`
    );
    const r = await harness.callTool('zillow_resolve_addresses', {
      addresses: ['1 Nowhere St, Nowhere, ZZ'],
    });
    const parsed = parseToolResult<{
      results: Array<{ resolved: boolean; confidence: string }>;
    }>(r);
    expect(parsed.results[0].resolved).toBe(false);
    expect(parsed.results[0].confidence).toBe('none');
  });

  it('captures per-row errors without failing the batch', async () => {
    let call = 0;
    mockFetchHtml.mockImplementation(async () => {
      call++;
      if (call === 2) throw new Error('upstream 502');
      return htmlWithListing({
        zpid: 100,
        streetAddress: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
      });
    });
    const r = await harness.callTool('zillow_resolve_addresses', {
      addresses: ['126 Sleeping Bear Ln, Lake Lure, NC', 'fail', '126 Sleeping Bear Ln, Lake Lure, NC'],
    });
    const parsed = parseToolResult<{
      results: Array<{ resolved: boolean; error?: string; zpid?: string }>;
    }>(r);
    expect(parsed.results[0].resolved).toBe(true);
    expect(parsed.results[1].resolved).toBe(false);
    expect(parsed.results[1].error).toMatch(/upstream 502/);
    expect(parsed.results[2].resolved).toBe(true);
  });

  it('rejects empty addresses[] arrays', async () => {
    const r = await harness.callTool('zillow_resolve_addresses', { addresses: [] });
    expect(r.isError).toBeTruthy();
  });

  describe('bulk concurrency + retry-once-on-timeout (issue #78)', () => {
    it('retries a sub-request once on FetchproxyTimeoutError, then resolves cleanly', async () => {
      // First fetch for row 2 throws a timeout; the retry succeeds.
      // Row 2 should land as `resolved: true` — a transient SW eviction
      // must NOT surface as a hard "no listing found".
      let row2Calls = 0;
      mockFetchHtml.mockImplementation(async (path: string) => {
        if (path.includes('Highland')) {
          row2Calls++;
          if (row2Calls === 1) {
            throw new FetchproxyTimeoutError({
              url: path,
              timeoutMs: 30_000,
            });
          }
          return htmlWithListing({
            zpid: 200,
            streetAddress: '181 Highland Hts',
            city: 'Lake Lure',
            state: 'NC',
            zip: '28746',
          });
        }
        return htmlWithListing({
          zpid: 100,
          streetAddress: '126 Sleeping Bear Ln',
          city: 'Lake Lure',
          state: 'NC',
          zip: '28746',
        });
      });

      const r = await harness.callTool('zillow_resolve_addresses', {
        addresses: [
          '126 Sleeping Bear Ln, Lake Lure, NC',
          '181 Highland Hts, Lake Lure, NC',
        ],
      });
      const parsed = parseToolResult<{
        results: Array<{ resolved: boolean; zpid?: string; error?: string }>;
      }>(r);
      expect(parsed.results[0].resolved).toBe(true);
      expect(parsed.results[1].resolved).toBe(true);
      expect(parsed.results[1].zpid).toBe('200');
      expect(row2Calls).toBe(2);
    });

    it('surfaces a distinct bridge-timeout error after the retry also times out — NOT "no listing found"', async () => {
      // Reporter's specific complaint: a bridge timeout used to render
      // as `resolved: false` with no error context, indistinguishable
      // from a genuine miss. After retry exhaustion the row must carry
      // an error that mentions the bridge timeout, not the
      // "no listing found" string the miss path uses.
      mockFetchHtml.mockImplementation(async () => {
        throw new FetchproxyTimeoutError({ url: '/x', timeoutMs: 30_000 });
      });
      const r = await harness.callTool('zillow_resolve_addresses', {
        addresses: ['1 Foo St, Bar, NC'],
      });
      const parsed = parseToolResult<{
        results: Array<{ resolved: boolean; error?: string }>;
      }>(r);
      expect(parsed.results[0].resolved).toBe(false);
      expect(parsed.results[0].error).toBeDefined();
      // Must NOT collapse onto the genuine-miss copy.
      expect(parsed.results[0].error).not.toMatch(/no listing found/i);
      // Must mention the bridge timeout so the caller can decide to retry.
      expect(parsed.results[0].error).toMatch(/timeout/i);
    });

    it('surfaces a "bridge unreachable" error when FetchproxyBridgeDownError fires after the revive retry', async () => {
      // Item 2 follow-up to #84 (PR #78): the bridge_down branch on
      // resolve-addresses.ts L181-183 was previously uncovered. When
      // the transport's `bridgeReviveDelayMs` retry also fails, the
      // inner call raises FetchproxyBridgeDownError (NOT a timeout) —
      // the per-row error must rewrite to `bridge unreachable: ...`
      // and the row must NOT collapse onto `no listing found`.
      mockFetchHtml.mockImplementation(async () => {
        throw new FetchproxyBridgeDownError({
          originalError: 'Could not establish connection.',
          retryAttempted: true,
        });
      });
      const r = await harness.callTool('zillow_resolve_addresses', {
        addresses: ['1 Foo St, Bar, NC'],
      });
      const parsed = parseToolResult<{
        results: Array<{ resolved: boolean; error?: string }>;
      }>(r);
      expect(parsed.results[0].resolved).toBe(false);
      expect(parsed.results[0].error).toBeDefined();
      expect(parsed.results[0].error).not.toMatch(/no listing found/i);
      expect(parsed.results[0].error).toMatch(/^bridge unreachable: /);
    });

    it('caps internal concurrency to BRIDGE_CONCURRENCY (issue #78)', async () => {
      // 14 addresses, watch in-flight count peak. With unlimited fan-out
      // it would peak at 14; with the cap it should stay ≤ 6.
      let inFlight = 0;
      let peak = 0;
      mockFetchHtml.mockImplementation(async (path: string) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 8));
        inFlight--;
        const m = /\/homes\/([^_]+)_rb/.exec(path);
        const slug = m ? decodeURIComponent(m[1]) : '';
        // Use the first word of the slug as a fake zpid by index.
        const i = parseInt(slug.split(' ')[0] || '0', 10);
        return htmlWithListing({
          zpid: i + 1000,
          streetAddress: `${i} Main St`,
          city: 'Brooklyn',
          state: 'NY',
          zip: '11215',
        });
      });
      const addresses = Array.from(
        { length: 14 },
        (_, i) => `${i} Main St, Brooklyn, NY`
      );
      await harness.callTool('zillow_resolve_addresses', { addresses });
      expect(peak).toBeLessThanOrEqual(6);
      expect(peak).toBeGreaterThan(1);
    });
  });

  describe('overall hard deadline → partial results, never wedges (issue #98)', () => {
    const FAST_TUNING = { overallDeadlineMs: 200 };

    it('a single hung row is backfilled as pending; others still resolve', async () => {
      // The middle address never settles (its first rung fetch hangs); the
      // overall deadline must fire and the call must return the other rows'
      // real data plus a per-row pending marker for the hung row — NOT hang
      // for the full client timeout.
      const dh = await createTestHarness((server) =>
        registerResolveAddressesTools(server, mockClient, FAST_TUNING)
      );
      mockFetchHtml.mockImplementation(async (path: string) => {
        const slug = decodeURIComponent(
          /\/homes\/([^_]+)_rb/.exec(path)?.[1] ?? ''
        );
        if (slug.includes('Hang')) {
          // Never resolves — simulates the wedging row from the report.
          return new Promise<string>(() => {});
        }
        if (slug.includes('Sleeping Bear')) {
          return htmlWithListing({
            zpid: 100,
            streetAddress: '126 Sleeping Bear Ln',
            city: 'Lake Lure',
            state: 'NC',
            zip: '28746',
          });
        }
        if (slug.includes('Highland')) {
          return htmlWithListing({
            zpid: 300,
            streetAddress: '181 Highland Hts',
            city: 'Lake Lure',
            state: 'NC',
            zip: '28746',
          });
        }
        return htmlWithListing({ zpid: 0, streetAddress: 'none' });
      });
      const r = await dh.callTool('zillow_resolve_addresses', {
        addresses: [
          '126 Sleeping Bear Ln, Lake Lure, NC',
          '1 Hang Ln, Nowhere, NC',
          '181 Highland Hts, Lake Lure, NC',
        ],
      });
      const parsed = parseToolResult<{
        count: number;
        pending?: number;
        results: Array<{
          resolved: boolean;
          zpid?: string;
          error?: string;
          error_kind?: string;
        }>;
      }>(r);
      // Every input still produces exactly one row, in input order.
      expect(parsed.count).toBe(3);
      // The good rows returned real data.
      expect(parsed.results[0].resolved).toBe(true);
      expect(parsed.results[0].zpid).toBe('100');
      expect(parsed.results[2].resolved).toBe(true);
      expect(parsed.results[2].zpid).toBe('300');
      // The hung row is surfaced as pending — distinct, machine-readable,
      // and NOT a generic miss / not-found.
      expect(parsed.results[1].resolved).toBe(false);
      expect(parsed.results[1].error_kind).toBe('pending');
      expect(parsed.results[1].error).not.toMatch(/no listing found/i);
      // The partial-result envelope advertises the pending count.
      expect(parsed.pending).toBe(1);
      await dh.close();
    }, 5000);

    it('does not poison the connection: resolves promptly despite a hung row', async () => {
      const dh = await createTestHarness((server) =>
        registerResolveAddressesTools(server, mockClient, FAST_TUNING)
      );
      mockFetchHtml.mockImplementation(async (path: string) => {
        const slug = decodeURIComponent(
          /\/homes\/([^_]+)_rb/.exec(path)?.[1] ?? ''
        );
        if (slug.includes('Hang')) return new Promise<string>(() => {});
        return htmlWithListing({ zpid: 0, streetAddress: 'none' });
      });
      const start = Date.now();
      const r = await dh.callTool('zillow_resolve_addresses', {
        addresses: ['1 Hang Ln, Nowhere, NC', '2 Foo St, Bar, NC'],
      });
      const elapsed = Date.now() - start;
      expect(r.isError).toBeFalsy();
      expect(elapsed).toBeLessThan(3000);
      await dh.close();
    }, 5000);

    it('all rows resolving before the deadline → no pending marker', async () => {
      const dh = await createTestHarness((server) =>
        registerResolveAddressesTools(server, mockClient, FAST_TUNING)
      );
      mockFetchHtml.mockImplementation(async () =>
        htmlWithListing({
          zpid: 100,
          streetAddress: '126 Sleeping Bear Ln',
          city: 'Lake Lure',
          state: 'NC',
          zip: '28746',
        })
      );
      const r = await dh.callTool('zillow_resolve_addresses', {
        addresses: [
          '126 Sleeping Bear Ln, Lake Lure, NC',
          '126 Sleeping Bear Ln, Lake Lure, NC',
        ],
      });
      const parsed = parseToolResult<{
        pending?: number;
        results: Array<{ error_kind?: string }>;
      }>(r);
      expect(parsed.pending ?? 0).toBe(0);
      expect(parsed.results.every((row) => row.error_kind === undefined)).toBe(
        true
      );
      await dh.close();
    });
  });

  // fleet-audit#288: every ladder fetch is paced by a per-call RPM token
  // bucket, and a bot-wall is reported distinctly (never a plain miss).
  describe('bot-wall governor (fleet-audit#288)', () => {
    const EMPTY =
      '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>';

    it('reports a bot-wall block as error_kind bot_challenge with a blocked/retry_after_s envelope', async () => {
      const dh = await createTestHarness((server) =>
        registerResolveAddressesTools(server, mockClient, { overallDeadlineMs: 2000 })
      );
      mockFetchHtml.mockImplementation(async (path: string) => {
        throw new BotWallError(path, 17);
      });
      const r = await dh.callTool('zillow_resolve_addresses', {
        addresses: ['126 Sleeping Bear Ln, Lake Lure, NC'],
      });
      const parsed = parseToolResult<{
        blocked?: number;
        retry_after_s?: number;
        results: Array<{ resolved: boolean; error_kind?: string; error?: string }>;
      }>(r);
      expect(parsed.results[0].resolved).toBe(false);
      expect(parsed.results[0].error_kind).toBe('bot_challenge');
      expect(parsed.results[0].error).not.toMatch(/no listing found/i);
      expect(parsed.blocked).toBe(1);
      expect(parsed.retry_after_s).toBe(17);
      await dh.close();
    });

    it('stops dialling Zillow for the rest of the call once the wall trips', async () => {
      const dh = await createTestHarness((server) =>
        registerResolveAddressesTools(server, mockClient, { overallDeadlineMs: 2000 })
      );
      mockFetchHtml.mockImplementation(async (path: string) => {
        throw new BotWallError(path, 5);
      });
      const addresses = Array.from({ length: 12 }, (_, i) => `${100 + i} Oak Dr, Lake Lure, NC`);
      const r = await dh.callTool('zillow_resolve_addresses', { addresses });
      const parsed = parseToolResult<{ blocked?: number }>(r);
      expect(parsed.blocked).toBe(12);
      // At most one fetch per concurrent runner before the breaker trips.
      expect(mockFetchHtml.mock.calls.length).toBeLessThanOrEqual(6);
      await dh.close();
    });

    it('spends a rate-governor token on every ladder fetch', async () => {
      const dh = await createTestHarness((server) =>
        registerResolveAddressesTools(server, mockClient, {
          overallDeadlineMs: 300,
          ratePerMinute: 60,
          burst: 2,
        })
      );
      mockFetchHtml.mockResolvedValue(EMPTY);
      await dh.callTool('zillow_resolve_addresses', {
        addresses: ['126 Sleeping Bear Ln, Lake Lure, NC', '4521 Mountainview Drive, Lake Lure, NC'],
      });
      // burst 2 + 1 token/s over a 300ms deadline → at most 2-3 fetches,
      // not the dozens a 2-row ladder would otherwise fire.
      expect(mockFetchHtml.mock.calls.length).toBeLessThanOrEqual(3);
      await dh.close();
    });

    // Review follow-up on #288: rung 5's scope resolve used a bare
    // `catch { return null }`, so a wall hit there — the LAST rung, and the
    // rural-address path — collapsed onto "no listing found".
    const SCOPE_PATH = '/homes/Lake%20Lure%20NC_rb/';

    it('reports a wall that trips only on the rung-5 scope fetch as bot_challenge, not a miss', async () => {
      const dh = await createTestHarness((server) =>
        registerResolveAddressesTools(server, mockClient, {
          overallDeadlineMs: 2000,
          ratePerMinute: 100_000,
          burst: 1000,
        })
      );
      mockFetchHtml.mockImplementation(async (path: string) => {
        if (path === SCOPE_PATH) throw new BotWallError(path, 9);
        return EMPTY;
      });
      const r = await dh.callTool('zillow_resolve_addresses', {
        addresses: ['126 Sleeping Bear Ln, Lake Lure, NC'],
      });
      const parsed = parseToolResult<{
        blocked?: number;
        retry_after_s?: number;
        results: Array<{ resolved: boolean; error_kind?: string; error?: string }>;
      }>(r);
      expect(mockFetchHtml.mock.calls.map((c) => c[0])).toContain(SCOPE_PATH);
      expect(parsed.results[0].resolved).toBe(false);
      expect(parsed.results[0].error_kind).toBe('bot_challenge');
      expect(parsed.results[0].error).not.toMatch(/no listing found/i);
      expect(parsed.blocked).toBe(1);
      expect(parsed.retry_after_s).toBe(9);
      await dh.close();
    });

    it('blocks a concurrent row whose next dial after the trip is the rung-5 scope resolve', async () => {
      const tuning = { overallDeadlineMs: 2000, ratePerMinute: 100_000, burst: 1000 };
      const rowB = '126 Sleeping Bear Ln, Lake Lure, NC';
      const rowA = '1 Tripwire Rd, Boone, NC';

      // Dry run: record row B's ladder so we know its last dial before rung 5.
      const dry = await createTestHarness((server) =>
        registerResolveAddressesTools(server, mockClient, tuning)
      );
      mockFetchHtml.mockResolvedValue(EMPTY);
      await dry.callTool('zillow_resolve_addresses', { addresses: [rowB] });
      await dry.close();
      const bPaths = mockFetchHtml.mock.calls.map((c) => c[0] as string);
      const scopeIdx = bPaths.indexOf(SCOPE_PATH);
      expect(scopeIdx).toBeGreaterThan(0);
      const lastBeforeScope = bPaths[scopeIdx - 1];
      mockFetchHtml.mockReset();

      // Row A's first dial hangs until row B reaches its last pre-rung-5
      // fetch, then trips the wall; row B's in-flight fetch returns a clean
      // miss, so its NEXT dial — the rung-5 scope resolve — meets the
      // tripped breaker.
      let releaseA!: () => void;
      const aGate = new Promise<void>((res) => (releaseA = res));
      let aTripped!: () => void;
      const aDone = new Promise<void>((res) => (aTripped = res));
      mockFetchHtml.mockImplementation(async (path: string) => {
        if (/boone/i.test(path)) {
          await aGate;
          aTripped();
          throw new BotWallError(path, 11);
        }
        if (path === lastBeforeScope) {
          releaseA();
          await aDone;
          await new Promise((r) => setTimeout(r, 0));
        }
        return EMPTY;
      });
      const dh = await createTestHarness((server) =>
        registerResolveAddressesTools(server, mockClient, tuning)
      );
      const r = await dh.callTool('zillow_resolve_addresses', { addresses: [rowA, rowB] });
      const parsed = parseToolResult<{
        blocked?: number;
        results: Array<{ address: string; resolved: boolean; error_kind?: string; error?: string }>;
      }>(r);
      const b = parsed.results.find((x) => x.address === rowB)!;
      expect(b.error_kind).toBe('bot_challenge');
      expect(b.error).not.toMatch(/no listing found/i);
      expect(parsed.blocked).toBe(2);
      // Row B never actually dialled the scope path — the breaker stopped it.
      expect(mockFetchHtml.mock.calls.map((c) => c[0])).not.toContain(SCOPE_PATH);
      await dh.close();
    });

    it('surfaces a bridge timeout with error_kind timeout', async () => {
      const dh = await createTestHarness((server) =>
        registerResolveAddressesTools(server, mockClient, {
          overallDeadlineMs: 2000,
          ratePerMinute: 100_000,
          burst: 1000,
        })
      );
      mockFetchHtml.mockImplementation(async () => {
        throw new FetchproxyTimeoutError({ url: '/x', timeoutMs: 30_000 });
      });
      const r = await dh.callTool('zillow_resolve_addresses', {
        addresses: ['126 Sleeping Bear Ln, Lake Lure, NC'],
      });
      const parsed = parseToolResult<{ results: Array<{ error_kind?: string }> }>(r);
      expect(parsed.results[0].error_kind).toBe('timeout');
      await dh.close();
    });
  });

  // fleet-audit#289: after the deadline answers, queued/in-flight ladders
  // must not keep firing fetches in the background.
  it('stops issuing ladder fetches after the deadline has returned', async () => {
    const dh = await createTestHarness((server) =>
      registerResolveAddressesTools(server, mockClient, { overallDeadlineMs: 100 })
    );
    mockFetchHtml.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>';
    });
    const addresses = Array.from({ length: 20 }, (_, i) => `${100 + i} Oak Dr, Lake Lure, NC`);
    const r = await dh.callTool('zillow_resolve_addresses', { addresses });
    const parsed = parseToolResult<{ pending?: number }>(r);
    expect(parsed.pending ?? 0).toBeGreaterThan(0);
    const atReturn = mockFetchHtml.mock.calls.length;
    await new Promise((res) => setTimeout(res, 400));
    expect(mockFetchHtml.mock.calls.length).toBe(atReturn);
    await dh.close();
  }, 5000);

  describe('tool description honesty (issue #80)', () => {
    // Description must (a) surface price_hint as load-bearing, (b) drop
    // the stale "bulk is weaker than single" caveat now that #73 shipped,
    // (c) document the locality-remap rung + resolved_city / queried_city
    // fields including the cohort's mountain-MLS cases.
    async function getDescription(): Promise<string> {
      const server = new McpServer({ name: 't', version: '0.0.0' });
      registerResolveAddressesTools(server, mockClient);
      const client = new Client({ name: 'tc', version: '0.0.0' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      const { tools } = await client.listTools();
      await client.close();
      await server.close();
      const t = tools.find((t) => t.name === 'zillow_resolve_addresses');
      if (!t) throw new Error('tool missing');
      return t.description ?? '';
    }

    it('flags price_hint as load-bearing for rural / locality-mismatched rows', async () => {
      const d = await getDescription();
      expect(d).toMatch(/price_hint/);
      expect(d).toMatch(/load-bearing/i);
      expect(d).toMatch(/rural|mountain-MLS/i);
    });

    it('does not carry the stale "bulk is weaker than single" caveat (#73 shipped)', async () => {
      const d = await getDescription();
      // The pre-#73 description warned bulk was weaker than looping the
      // single call. Now they share a resolver — that warning is stale.
      expect(d).not.toMatch(/weaker than/i);
      expect(d).not.toMatch(/until #?\d/i);
      // And it should affirmatively say bulk and single walk the same ladder.
      expect(d).toMatch(/same/i);
      expect(d).toMatch(/same 4-rung resolver|same ladder|shared resolver/i);
    });

    it('documents the locality-remap rung and queried_city / resolved_city fields', async () => {
      const d = await getDescription();
      expect(d).toMatch(/locality[ _-]remap/i);
      expect(d).toMatch(/queried_city/);
      expect(d).toMatch(/resolved_city/);
    });

    it("cites the cohort's mountain-MLS remap cases (Lake Lure / Banner Elk)", async () => {
      const d = await getDescription();
      expect(d).toMatch(/Lake Lure/);
      expect(d).toMatch(/Banner Elk/);
    });
  });
});
