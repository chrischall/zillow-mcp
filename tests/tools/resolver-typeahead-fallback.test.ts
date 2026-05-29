import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { resolveAddressFull } from '../../src/tools/resolver.js';
import { FetchproxyTimeoutError } from '../../src/transport-fetchproxy.js';

// Issue #100 (P1-2): when the typeahead/direct rung (rung 1,
// `resolveDirect` → `/homes/<slug>_rb/`) TIMES OUT or comes back EMPTY,
// the resolver must fall through to the search-fallback rung
// (`zillow_search_properties` + whole-token street match) rather than
// aborting the whole ladder on the timeout. Search-fallback is a
// first-class rung, not a last-ditch that a rung-1 timeout can skip.

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

beforeEach(() => vi.clearAllMocks());

interface MockListing {
  zpid: number;
  streetAddress: string;
  city: string;
  state: string;
  zip: string;
}

// A direct-resolve page (rung 1/2/3 shape): a region-less page whose
// first listResults row is the match.
function htmlDirect(l: MockListing): string {
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

// A region-pinned search page (rung 4 step-2 shape) carrying several
// listings; search-fallback whole-token-matches the street address.
function htmlRegionSearch(listings: MockListing[]): string {
  const sps = {
    queryState: {
      regionSelection: [{ regionId: 70190, regionType: 7 }],
      mapBounds: { west: -82.3, east: -82.1, south: 35.4, north: 35.5 },
    },
    cat1: {
      searchResults: {
        listResults: listings.map((l) => ({
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
        })),
      },
    },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { searchPageState: sps } },
  })}</script>`;
}

const TARGET: MockListing = {
  zpid: 555,
  streetAddress: '268 Mallard Rd',
  city: 'Lake Lure',
  state: 'NC',
  zip: '28746',
};

describe('typeahead/direct rung TIMEOUT → search-fallback rung (issue #100)', () => {
  it('does not abort the ladder when rung 1 times out — search-fallback resolves', async () => {
    // Every full-address direct/suffix/locality attempt TIMES OUT (the
    // typeahead-equivalent resolve hangs). The city/state-scoped
    // search-fallback request succeeds and whole-token-matches the street.
    //
    // CONSOLIDATION (realty-mcp#1): realty-core's broader `buildVariants`
    // emits greedy compound splits ("268 Mal Lard Rd") that break the
    // "mallard" substring, so scope detection must key on the ABSENCE of
    // the house number `268` (scope = city+state, no street number) rather
    // than the street name.
    mockFetchHtml.mockImplementation(async (path: string) => {
      const decoded = decodeURIComponent(path).toLowerCase();
      // The scope-only search-fallback request: city + state, NO street
      // number (street variants all carry the `268` house number).
      const isScopeSearch =
        decoded.includes('lake lure') && !decoded.includes('268');
      if (isScopeSearch) {
        return htmlRegionSearch([
          { ...TARGET, zpid: 999, streetAddress: '1 Other St' },
          TARGET,
        ]);
      }
      // Any address-bearing typeahead/direct attempt hangs → timeout.
      throw new FetchproxyTimeoutError({ url: path, timeoutMs: 30_000 });
    });

    const out = await resolveAddressFull(mockClient, {
      address: '268 Mallard Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });

    expect('hit' in out).toBe(true);
    if ('hit' in out) {
      expect(out.hit.via).toBe('search_fallback');
      expect(String(out.hit.formatted.zpid)).toBe('555');
    }
  });

  it('still resolves via search-fallback when rung 1 returns EMPTY (regression for the existing fall-through)', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => {
      const decoded = decodeURIComponent(path).toLowerCase();
      // CONSOLIDATION (realty-mcp#1): key scope detection on the absence
      // of the `268` house number — greedy compound-split variants break
      // the "mallard" substring (see the timeout test above).
      const isScopeSearch =
        decoded.includes('lake lure') && !decoded.includes('268');
      if (isScopeSearch) {
        return htmlRegionSearch([TARGET]);
      }
      // Empty page for every address-bearing attempt.
      return '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"queryState":{"regionSelection":[],"mapBounds":null},"cat1":{"searchResults":{"listResults":[]}}}}}}</script>';
    });

    const out = await resolveAddressFull(mockClient, {
      address: '268 Mallard Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect('hit' in out).toBe(true);
    if ('hit' in out) {
      expect(out.hit.via).toBe('search_fallback');
    }
  });

  it('a rung-1 timeout that direct-resolves on a later rung still wins (timeout is not fatal)', async () => {
    // Rung 1 (full slug incl. street) times out; the suffix-expanded
    // attempt ("Mallard Road") succeeds via direct-resolve. The timeout
    // on rung 1 must not abort before rung 2 gets its chance.
    mockFetchHtml.mockImplementation(async (path: string) => {
      const decoded = decodeURIComponent(path).toLowerCase();
      if (decoded.includes('mallard-road') || decoded.includes('mallard road')) {
        return htmlDirect({ ...TARGET, streetAddress: '268 Mallard Road' });
      }
      throw new FetchproxyTimeoutError({ url: path, timeoutMs: 30_000 });
    });

    const out = await resolveAddressFull(mockClient, {
      address: '268 Mallard Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect('hit' in out).toBe(true);
    if ('hit' in out) {
      // Resolved on the suffix-expansion rung, despite the rung-1 timeout.
      expect(out.hit.via).toBe('suffix_expansion');
      expect(String(out.hit.formatted.zpid)).toBe('555');
    }
  });

  it('a NON-timeout transport error still propagates (not swallowed)', async () => {
    mockFetchHtml.mockImplementation(async () => {
      throw new Error('catastrophic bridge failure');
    });
    await expect(
      resolveAddressFull(mockClient, {
        address: '268 Mallard Rd',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      })
    ).rejects.toThrow(/catastrophic bridge failure/);
  });
});
