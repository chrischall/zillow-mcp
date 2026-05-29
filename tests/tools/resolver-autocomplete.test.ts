import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import {
  AUTOCOMPLETE_OPERATION_NAME,
  buildAutocompletePath,
  buildAutocompleteBody,
  autocompleteHeaders,
  fetchAutocompleteAddressCandidates,
  selectAutocompleteMatch,
  resolveAddressFull,
} from '../../src/tools/resolver.js';
import { FetchproxyTimeoutError } from '../../src/transport-fetchproxy.js';

// Issue #101: a high-recall typeahead rung backed by Zillow's own
// canonical `zg-graph GetAutocompleteResults` endpoint. The query is sent
// INLINE (full GraphQL text in the body — no persisted hash → no rotation
// risk). Cookies are supplied AMBIENTLY by the bridge; this rung NEVER
// sets/reads/logs a cookie.

const mockFetchHtml = vi.fn();
const mockFetchJson = vi.fn();
const mockClient = {
  fetchHtml: mockFetchHtml,
  fetchJson: mockFetchJson,
} as unknown as ZillowClient;

beforeEach(() => vi.clearAllMocks());

// A SANITIZED slice of the GetAutocompleteResults response. No cookies,
// no session data. `SearchAssistanceAddressResult.id` is the full address
// string; non-address result types (regions, schools) carry other fields.
function sanitizedAutocomplete(ids: string[]): unknown {
  return {
    data: {
      searchAssistanceResult: {
        requestId: 7,
        results: [
          {
            __typename: 'SearchAssistanceRegionResult',
            regionId: 70190,
            id: 'region-noise',
          },
          ...ids.map((id) => ({
            __typename: 'SearchAssistanceAddressResult',
            id,
          })),
          {
            __typename: 'SearchAssistanceSchoolResult',
            id: 'school-noise',
          },
        ],
      },
    },
  };
}

describe('GetAutocompleteResults request construction (issue #101)', () => {
  it('POSTs to zg-graph with the GetAutocompleteResults operationName + resultTypes', () => {
    const path = buildAutocompletePath('3538 tre');
    expect(path.startsWith('/zg-graph?')).toBe(true);
    const url = new URL('https://www.zillow.com' + path);
    expect(url.searchParams.get('operationName')).toBe(
      AUTOCOMPLETE_OPERATION_NAME
    );
    expect(url.searchParams.get('query')).toBe('3538 tre');
    expect(url.searchParams.getAll('resultType')).toContain('FORSALE');
    expect(url.searchParams.getAll('resultType')).toContain('REGIONS');
    expect(url.searchParams.get('shouldRequestSpellCorrectedMetadata')).toBe(
      'false'
    );
  });

  it('sends the GraphQL query INLINE in the body (no persisted hash)', () => {
    const body = buildAutocompleteBody('3538 tre');
    expect(body.operationName).toBe(AUTOCOMPLETE_OPERATION_NAME);
    // Inline query text — full operation, not a sha256 hash.
    expect(typeof body.query).toBe('string');
    expect(body.query).toContain('query GetAutocompleteResults');
    expect(body.query).toContain('zgsAutocompleteRequest');
    // No persistedQuery extension anywhere (the whole point of #101).
    expect(JSON.stringify(body)).not.toContain('persistedQuery');
    expect(JSON.stringify(body)).not.toContain('sha256Hash');
    expect(body.variables.query).toBe('3538 tre');
    expect(body.variables.shouldRequestSpellCorrectedMetadata).toBe(false);
    expect(Array.isArray(body.resultType)).toBe(true);
  });

  it('sends the required headers and NO cookies', () => {
    const headers = autocompleteHeaders();
    expect(headers['content-type']).toBe('application/json');
    expect(headers['origin']).toBe('https://www.zillow.com');
    expect(headers['referer']).toContain('/homes/for_sale/');
    expect(headers['x-caller-id']).toBe('static-search-page-graphql');
    // ABSOLUTE RULE: never any cookie header.
    const keys = Object.keys(headers).map((k) => k.toLowerCase());
    expect(keys).not.toContain('cookie');
    for (const v of Object.values(headers)) {
      expect(v.toLowerCase()).not.toContain('cookie');
    }
  });

  it('issues a POST through fetchJson with the constructed path + headers (no cookies)', async () => {
    mockFetchJson.mockResolvedValue(
      sanitizedAutocomplete(['3538 Trent St Charlotte, NC 28209'])
    );
    await fetchAutocompleteAddressCandidates(mockClient, '3538 tre');
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    const [calledPath, init] = mockFetchJson.mock.calls[0];
    expect(calledPath).toContain('/zg-graph?');
    expect(init.method).toBe('POST');
    expect(init.body.operationName).toBe(AUTOCOMPLETE_OPERATION_NAME);
    const headerKeys = Object.keys(init.headers).map((k) => k.toLowerCase());
    expect(headerKeys).not.toContain('cookie');
    expect(init.headers['x-caller-id']).toBe('static-search-page-graphql');
  });
});

describe('GetAutocompleteResults candidate parsing (issue #101)', () => {
  it('extracts only SearchAssistanceAddressResult.id strings', async () => {
    mockFetchJson.mockResolvedValue(
      sanitizedAutocomplete([
        '3538 Trent St Charlotte, NC 28209',
        '3538 Trenton Ave Charlotte, NC 28205',
      ])
    );
    const candidates = await fetchAutocompleteAddressCandidates(
      mockClient,
      '3538 tre'
    );
    expect(candidates).toEqual([
      '3538 Trent St Charlotte, NC 28209',
      '3538 Trenton Ave Charlotte, NC 28205',
    ]);
  });

  it('returns [] when the response has no address results', async () => {
    mockFetchJson.mockResolvedValue(sanitizedAutocomplete([]));
    const candidates = await fetchAutocompleteAddressCandidates(
      mockClient,
      'nowhere'
    );
    expect(candidates).toEqual([]);
  });

  it('returns [] (graceful) on a malformed / unexpected response shape', async () => {
    mockFetchJson.mockResolvedValue({ data: {} });
    expect(
      await fetchAutocompleteAddressCandidates(mockClient, 'x')
    ).toEqual([]);
    mockFetchJson.mockResolvedValue(null);
    expect(
      await fetchAutocompleteAddressCandidates(mockClient, 'x')
    ).toEqual([]);
  });
});

describe('autocomplete street-match selection (issue #101)', () => {
  it('whole-token street-matches the input against the candidate ids', () => {
    const candidates = [
      '3539 Trent St Charlotte, NC 28209', // wrong house number
      '3538 Trent St Charlotte, NC 28209', // exact
      '3538 Trenton Ave Charlotte, NC 28205', // wrong street
    ];
    const match = selectAutocompleteMatch(candidates, '3538 Trent St');
    expect(match).toBe('3538 Trent St Charlotte, NC 28209');
  });

  it('requires EVERY discriminating input token (no partial-street false match)', () => {
    const candidates = ['3538 Trenton Ave Charlotte, NC 28205'];
    // "Trent St" tokens are not all present in "Trenton Ave".
    expect(selectAutocompleteMatch(candidates, '3538 Trent St')).toBeNull();
  });

  it('returns null when input tokenizes to nothing discriminating', () => {
    expect(selectAutocompleteMatch(['1 St City, ST 00000'], '1 St')).toBeNull();
  });
});

// End-to-end rung wiring inside resolveAddressFull.

interface MockListing {
  zpid: number;
  streetAddress: string;
  city: string;
  state: string;
  zip: string;
}

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

const EMPTY_PAGE =
  '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"queryState":{"regionSelection":[],"mapBounds":null},"cat1":{"searchResults":{"listResults":[]}}}}}}</script>';

const TARGET: MockListing = {
  zpid: 808,
  streetAddress: '3538 Trent St',
  city: 'Charlotte',
  state: 'NC',
  zip: '28209',
};

describe('autocomplete rung wired into resolveAddressFull (issue #101)', () => {
  it('resolves via autocomplete: typeahead → street-match → address→zpid', async () => {
    // Caller has the wrong city ("Pineville"), so rung 1 (direct, full
    // input slug) MISSES. The autocomplete rung surfaces the CANONICAL
    // address (correct city "Charlotte"), which then direct-resolves to a
    // zpid via the existing address→zpid path.
    mockFetchJson.mockResolvedValue(
      sanitizedAutocomplete(['3538 Trent St Charlotte, NC 28209'])
    );
    mockFetchHtml.mockImplementation(async (path: string) => {
      const decoded = decodeURIComponent(path).toLowerCase();
      // Only the canonical autocomplete address (with "charlotte") resolves;
      // the caller slug (with "pineville") misses.
      if (decoded.includes('charlotte')) {
        return htmlDirect(TARGET);
      }
      return EMPTY_PAGE;
    });

    const out = await resolveAddressFull(mockClient, {
      address: '3538 Trent St',
      city: 'Pineville',
      state: 'NC',
    });
    expect('hit' in out).toBe(true);
    if ('hit' in out) {
      expect(out.hit.via).toBe('autocomplete');
      expect(String(out.hit.formatted.zpid)).toBe('808');
      // The finalSlug is the canonical autocomplete address.
      expect(out.finalSlug).toContain('Charlotte');
    }
  });

  it('falls back to existing rungs when autocomplete returns no usable match (no regression)', async () => {
    // Autocomplete returns an unrelated address → no street-match. The
    // direct rung resolves the original caller slug.
    mockFetchJson.mockResolvedValue(
      sanitizedAutocomplete(['9999 Elsewhere Dr Other City, NC 28000'])
    );
    mockFetchHtml.mockResolvedValue(htmlDirect(TARGET));

    const out = await resolveAddressFull(mockClient, {
      address: '3538 Trent St',
      city: 'Charlotte',
      state: 'NC',
    });
    expect('hit' in out).toBe(true);
    if ('hit' in out) {
      expect(out.hit.via).toBe('direct');
      expect(String(out.hit.formatted.zpid)).toBe('808');
    }
  });

  it('falls back gracefully when autocomplete throws a NON-timeout error', async () => {
    // A transport error from the autocomplete endpoint must NOT abort the
    // ladder — it is an enhancement rung. The direct rung still resolves.
    mockFetchJson.mockRejectedValue(new Error('zg-graph 500'));
    mockFetchHtml.mockResolvedValue(htmlDirect(TARGET));

    const out = await resolveAddressFull(mockClient, {
      address: '3538 Trent St',
      city: 'Charlotte',
      state: 'NC',
    });
    expect('hit' in out).toBe(true);
    if ('hit' in out) {
      expect(out.hit.via).toBe('direct');
    }
  });

  it('an autocomplete TIMEOUT does not skip later rungs but is remembered (issue #100 taxonomy)', async () => {
    // Direct rung MISSES (empty). Autocomplete TIMES OUT. Every later
    // direct attempt also times out, and there is no search scope that
    // resolves → the ladder must re-throw the timeout, never a silent miss.
    mockFetchJson.mockRejectedValue(
      new FetchproxyTimeoutError({ url: '/zg-graph', timeoutMs: 30_000 })
    );
    mockFetchHtml.mockImplementation(async (path: string) => {
      const decoded = decodeURIComponent(path).toLowerCase();
      // The scope-only search-fallback request also times out.
      throw new FetchproxyTimeoutError({ url: path, timeoutMs: 30_000 });
    });

    await expect(
      resolveAddressFull(mockClient, {
        address: '3538 Trent St',
        city: 'Charlotte',
        state: 'NC',
      })
    ).rejects.toBeInstanceOf(FetchproxyTimeoutError);
  });
});
