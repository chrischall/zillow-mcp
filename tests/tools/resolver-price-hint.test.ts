import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { registerResolveAddressesTools, priceBandFromHint } from '../../src/tools/resolve-addresses.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

// Issue #74: bulk resolver accepts an optional `price_hint` per row.
// The hint expands into a ±0.5% band that the search-fallback rung
// uses to narrow the city/state-scoped search.

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

let bulk: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (bulk) await bulk.close();
});

const EMPTY_HTML =
  '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>';

function htmlListing(args: {
  zpid: number;
  streetAddress: string;
  city: string;
  state: string;
  zip: string;
}): string {
  const nextData = {
    props: {
      pageProps: {
        searchPageState: {
          queryState: { regionSelection: [], mapBounds: null },
          cat1: {
            searchResults: {
              listResults: [
                {
                  zpid: args.zpid,
                  detailUrl: `/homedetails/${args.zpid}_zpid/`,
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
        },
      },
    },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData
  )}</script>`;
}

describe('priceBandFromHint', () => {
  it('derives a ±0.5% band around the hint', () => {
    const band = priceBandFromHint(1_000_000);
    expect(band.min).toBe(995_000);
    expect(band.max).toBe(1_005_000);
  });

  it('rounds the delta to at least 1 dollar', () => {
    const band = priceBandFromHint(100);
    expect(band.min).toBeLessThan(100);
    expect(band.max).toBeGreaterThan(100);
  });
});

describe('bulk resolve with price_hint (issue #74)', () => {
  it('setup', async () => {
    bulk = await createTestHarness((s) => registerResolveAddressesTools(s, mockClient));
  });

  it('a row resolves WITH price_hint that fails without it', async () => {
    // The mock distinguishes the bare scope-resolve call (no
    // price filter in the URL) from the price-filtered second call
    // (`price%22` substring is present in the JSON-encoded query
    // state). The bare resolve returns a region payload (no listings
    // yet); the filtered call returns the listing only when the
    // request URL actually carries the price band.
    const regionHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          searchPageState: {
            queryState: {
              regionSelection: [{ regionId: 41568, regionType: 6 }],
              mapBounds: { north: 35.55, south: 35.4, east: -82.05, west: -82.25 },
            },
            cat1: { searchResults: { listResults: [] } },
          },
        },
      },
    })}</script>`;

    mockFetchHtml.mockImplementation(async (path: string) => {
      const decoded = decodeURIComponent(path).toLowerCase();
      // Variant-level direct + rung-2 calls — always miss.
      if (decoded.includes('231 bluebird') || decoded.includes('blue bird')) {
        return EMPTY_HTML;
      }
      // Rung-3 city-drop attempt (slug has no "lake lure" word).
      if (decoded.includes('231 ') && !decoded.includes('lake lure')) {
        return EMPTY_HTML;
      }
      // Rung-4 scope resolve OR filtered search — same path, the
      // filtered one carries a `searchQueryState` query string.
      if (decoded.includes('lake lure')) {
        // searchQueryState is JSON-encoded — the `"price":{"min"`
        // substring (URL-encoded) tells us the price band is in play.
        const hasPriceFilter =
          decoded.includes('%22price%22') ||
          decoded.includes('"price"');
        if (!hasPriceFilter) return regionHtml;
        return htmlListing({
          zpid: 23100,
          streetAddress: '231 Bluebird Rd',
          city: 'Lake Lure',
          state: 'NC',
          zip: '28746',
        });
      }
      return EMPTY_HTML;
    });

    // Without hint: no resolve.
    const withoutHint = await bulk.callTool('zillow_resolve_addresses', {
      addresses: [
        {
          address: '231 Bluebird Rd',
          city: 'Lake Lure',
          state: 'NC',
          zip: '28746',
        },
      ],
    });
    const withoutParsed = parseToolResult<{
      results: Array<{ resolved: boolean }>;
    }>(withoutHint);
    expect(withoutParsed.results[0].resolved).toBe(false);

    // With hint: resolves.
    const withHint = await bulk.callTool('zillow_resolve_addresses', {
      addresses: [
        {
          address: '231 Bluebird Rd',
          city: 'Lake Lure',
          state: 'NC',
          zip: '28746',
          price_hint: 1_000_000,
        },
      ],
    });
    const withParsed = parseToolResult<{
      results: Array<{ resolved: boolean; zpid?: string; confidence?: string }>;
    }>(withHint);
    expect(withParsed.results[0].resolved).toBe(true);
    expect(withParsed.results[0].zpid).toBe('23100');
    expect(withParsed.results[0].confidence).toBe('search_fallback');
  });
});
