import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { registerGetByAddressTools } from '../../src/tools/get-by-address.js';
import { registerResolveAddressesTools } from '../../src/tools/resolve-addresses.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

// Parity regression for issue #73: the bulk `zillow_resolve_addresses`
// must run the same 4-rung strategy (direct → suffix-expansion →
// locality-remap → search-fallback) that the single `zillow_get_by_address` does. The
// real-world headline: a 20-address batch returned 0/20 via bulk while
// 17/20 resolved via single. The test below shares one mock backing
// store across both tools and asserts the resolved/unresolved partition
// matches address-for-address.

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

let single: Awaited<ReturnType<typeof createTestHarness>>;
let bulk: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (single) await single.close();
  if (bulk) await bulk.close();
});

interface MockListing {
  zpid: number;
  streetAddress: string;
  city: string;
  state: string;
  zip: string;
}

// Build a fake Zillow store keyed by the resolver-slug substring that
// would actually appear in the input. Each entry tells the mock to
// return that listing only when the request slug contains the trigger.
interface MockEntry {
  trigger: string;
  listing: MockListing;
}

function htmlListing(l: MockListing): string {
  const sps = {
    queryState: { regionSelection: [], mapBounds: null },
    cat1: {
      searchResults: {
        listResults: [
          {
            zpid: l.zpid,
            detailUrl: `/homedetails/${l.zpid}_zpid/`,
            hdpData: {
              homeInfo: {
                zpid: l.zpid,
                streetAddress: l.streetAddress,
                city: l.city,
                state: l.state,
                zipcode: l.zip,
              },
            },
          },
        ],
      },
    },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { searchPageState: sps } },
  })}</script>`;
}

const EMPTY_HTML =
  '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>';

function buildMockBackend(entries: MockEntry[]): (path: string) => Promise<string> {
  return async (path: string) => {
    const decoded = decodeURIComponent(path).toLowerCase();
    for (const e of entries) {
      if (decoded.includes(e.trigger.toLowerCase())) {
        return htmlListing(e.listing);
      }
    }
    return EMPTY_HTML;
  };
}

describe('bulk/single resolver parity (issue #73)', () => {
  it('setup', async () => {
    single = await createTestHarness((s) => registerGetByAddressTools(s, mockClient));
    bulk = await createTestHarness((s) => registerResolveAddressesTools(s, mockClient));
  });

  it('bulk returns the same resolved partition as N single calls for a mixed corpus', async () => {
    // 5-address corpus: 3 resolve via direct, 1 via suffix-expansion, 1
    // genuinely absent. The direct rung uses the input slug; the
    // suffix-expansion rung is triggered by swapping the trailing
    // suffix; the mock returns the listing only when the slug contains
    // the expanded form ("Mallard Road") — so the single resolver hits
    // it on rung 2 and the bulk MUST do the same.
    const entries: MockEntry[] = [
      {
        trigger: '126 sleeping bear ln',
        listing: {
          zpid: 100,
          streetAddress: '126 Sleeping Bear Ln',
          city: 'Lake Lure',
          state: 'NC',
          zip: '28746',
        },
      },
      {
        trigger: '99 hidden cove',
        listing: {
          zpid: 200,
          streetAddress: '99 Hidden Cove',
          city: 'Lake Lure',
          state: 'NC',
          zip: '28746',
        },
      },
      {
        trigger: '1 main st',
        listing: {
          zpid: 300,
          streetAddress: '1 Main St',
          city: 'Brooklyn',
          state: 'NY',
          zip: '11215',
        },
      },
      {
        // Only matches the EXPANDED form — exercises the suffix rung.
        trigger: '268 mallard road',
        listing: {
          zpid: 400,
          streetAddress: '268 Mallard Road',
          city: 'Lake Lure',
          state: 'NC',
          zip: '28746',
        },
      },
    ];

    const corpus = [
      { address: '126 Sleeping Bear Ln', city: 'Lake Lure', state: 'NC', zip: '28746' },
      { address: '99 Hidden Cove', city: 'Lake Lure', state: 'NC', zip: '28746' },
      { address: '1 Main St', city: 'Brooklyn', state: 'NY', zip: '11215' },
      { address: '268 Mallard Rd', city: 'Lake Lure', state: 'NC', zip: '28746' },
      { address: '999 Nowhere Ln', city: 'Atlantis', state: 'XX' },
    ];

    // 1) Single-call resolutions
    mockFetchHtml.mockImplementation(buildMockBackend(entries));
    const singleZpids: Array<string | null> = [];
    for (const row of corpus) {
      const r = await single.callTool('zillow_get_by_address', row);
      const parsed = parseToolResult<{ resolved: boolean; zpid?: string }>(r);
      singleZpids.push(parsed.resolved ? parsed.zpid ?? null : null);
    }

    // 2) Bulk resolution
    mockFetchHtml.mockClear();
    mockFetchHtml.mockImplementation(buildMockBackend(entries));
    const bulkAddresses = corpus.map((c) =>
      [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ')
    );
    const bulkR = await bulk.callTool('zillow_resolve_addresses', {
      addresses: bulkAddresses,
    });
    const bulkParsed = parseToolResult<{
      results: Array<{ resolved: boolean; zpid?: string }>;
    }>(bulkR);
    const bulkZpids = bulkParsed.results.map((r) => (r.resolved ? r.zpid ?? null : null));

    // Parity assertion: partition + zpids identical address-for-address.
    expect(bulkZpids).toEqual(singleZpids);
    // Sanity: at least the suffix-expansion case actually resolved.
    expect(singleZpids[3]).toBe('400');
  });
});
