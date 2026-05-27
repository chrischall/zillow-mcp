import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { registerResolveAddressesTools } from '../../src/tools/resolve-addresses.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

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
});
