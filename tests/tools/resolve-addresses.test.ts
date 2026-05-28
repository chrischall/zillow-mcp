import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { registerResolveAddressesTools } from '../../src/tools/resolve-addresses.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '../../src/transport-fetchproxy.js';
import { createTestHarness, parseToolResult } from '../helpers.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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

    it('caps internal concurrency to BULK_CONCURRENCY (issue #78)', async () => {
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
