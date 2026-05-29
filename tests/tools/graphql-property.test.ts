import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SQFT_PER_ACRE } from '@chrischall/realty-core';
import type { ZillowClient } from '../../src/client.js';
import {
  PROPERTY_DETAIL_SHA256_HASH,
  PROPERTY_DETAIL_OPERATION_NAME,
  PROPERTY_DETAIL_INLINE_QUERY,
  GraphqlValidationError,
  PersistedQueryNotFoundError,
  GRAPHQL_ENDPOINT_PATH,
  buildGraphqlPropertyPath,
  buildInlineGraphqlBody,
  graphqlPropertyHeaders,
  propertyDetailHash,
  fetchPropertyViaGraphql,
  type GraphqlPropertyResponse,
} from '../../src/tools/graphql-property.js';
import { format } from '../../src/tools/properties.js';

const mockFetchJson = vi.fn();
const mockClient = { fetchJson: mockFetchJson } as unknown as ZillowClient;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ZILLOW_PROPERTY_QUERY_HASH;
});

describe('persistedQuery request construction (issue #99)', () => {
  it('uses the documented property-detail sha256Hash by default', () => {
    expect(PROPERTY_DETAIL_SHA256_HASH).toBe(
      '28d4cee0936bc44b55b4f101de016bd409ed667a842848cf6086aa48e6c792f0'
    );
    expect(propertyDetailHash()).toBe(PROPERTY_DETAIL_SHA256_HASH);
  });

  it('allows the hash to be overridden via env (hashes rotate)', () => {
    process.env.ZILLOW_PROPERTY_QUERY_HASH = 'deadbeef';
    expect(propertyDetailHash()).toBe('deadbeef');
  });

  it('builds the /graphql/ path with url-encoded extensions + variables', () => {
    const path = buildGraphqlPropertyPath({ zpid: 12345 });
    expect(path.startsWith('/graphql/?')).toBe(true);

    const url = new URL('https://www.zillow.com' + path);
    const extensions = JSON.parse(url.searchParams.get('extensions') ?? '{}');
    const variables = JSON.parse(url.searchParams.get('variables') ?? '{}');

    expect(extensions).toEqual({
      persistedQuery: {
        version: 1,
        sha256Hash: PROPERTY_DETAIL_SHA256_HASH,
      },
    });
    expect(variables).toEqual({
      zpid: 12345,
      altId: null,
      deviceTypeV2: 'WEB_DESKTOP',
      includeLastSoldListing: true,
    });
  });

  it('sends the required headers and NO cookies', () => {
    const headers = graphqlPropertyHeaders({ zpid: 12345 });
    expect(headers['accept']).toBe('*/*');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['client-id']).toBe('not-for-sale-sub-app-browser-client');
    expect(headers['x-z-enable-oauth-conversion']).toBe('true');
    expect(headers['referer']).toContain('/homedetails/');
    expect(headers['referer']).toContain('12345_zpid');
    // ABSOLUTE RULE: never any cookie header.
    const keys = Object.keys(headers).map((k) => k.toLowerCase());
    expect(keys).not.toContain('cookie');
    for (const v of Object.values(headers)) {
      expect(v.toLowerCase()).not.toContain('cookie');
    }
  });

  it('uses the caller-supplied slug in the referer', () => {
    const headers = graphqlPropertyHeaders({
      zpid: 12345,
      slug: '268-Mallard-Rd-Lake-Lure-NC-28746',
    });
    expect(headers['referer']).toBe(
      'https://www.zillow.com/homedetails/268-Mallard-Rd-Lake-Lure-NC-28746/12345_zpid/'
    );
  });

  it('derives the slug from a full homedetails url for the referer', async () => {
    mockFetchJson.mockResolvedValue(sanitizedResponse());
    await fetchPropertyViaGraphql(mockClient, {
      zpid: 12345,
      url: '/homedetails/268-Mallard-Rd-Lake-Lure-NC-28746/12345_zpid/',
    });
    const [, init] = mockFetchJson.mock.calls[0];
    expect(init.headers['referer']).toBe(
      'https://www.zillow.com/homedetails/268-Mallard-Rd-Lake-Lure-NC-28746/12345_zpid/'
    );
  });
});

// A small SANITIZED mock of the GraphQL response shape — no cookies, no
// session data. Mirrors `{ data: { property: { … } } }`.
function sanitizedResponse(): GraphqlPropertyResponse {
  return {
    data: {
      property: {
        zpid: 12345,
        hdpUrl: '/homedetails/268-Mallard-Rd-Lake-Lure-NC-28746/12345_zpid/',
        price: 450000,
        zestimate: 460000,
        bedrooms: 3,
        bathrooms: 2,
        livingArea: 1800,
        lotSize: 45738,
        yearBuilt: 1998,
        homeType: 'SINGLE_FAMILY',
        homeStatus: 'FOR_SALE',
        address: {
          streetAddress: '268 Mallard Rd',
          city: 'Lake Lure',
          state: 'NC',
          zipcode: '28746',
        },
        resoFacts: { yearBuilt: 1998 },
        priceHistory: [
          { event: 'Sold', date: '2019-06-01', price: 300000 },
        ],
        taxHistory: [],
      },
    },
  };
}

describe('inline GraphQL request construction (no hash — shirk the hash)', () => {
  it('exposes a named operation + a full inline query string (no persisted hash)', () => {
    expect(PROPERTY_DETAIL_OPERATION_NAME).toBe('PropertyDetail');
    // A full inline query — NOT a persisted-query reference.
    expect(PROPERTY_DETAIL_INLINE_QUERY).toContain('query PropertyDetail');
    expect(PROPERTY_DETAIL_INLINE_QUERY).toContain('property(');
    expect(PROPERTY_DETAIL_INLINE_QUERY).not.toContain('persistedQuery');
    expect(PROPERTY_DETAIL_INLINE_QUERY).not.toContain('sha256');
  });

  it('mirrors the persisted-query variables as the operation args', () => {
    // The arg signature is inferred from the persisted query's variables.
    expect(PROPERTY_DETAIL_INLINE_QUERY).toContain('$zpid: ID!');
    expect(PROPERTY_DETAIL_INLINE_QUERY).toContain('$altId: ID');
    expect(PROPERTY_DETAIL_INLINE_QUERY).toContain('$deviceTypeV2: DeviceType');
    expect(PROPERTY_DETAIL_INLINE_QUERY).toContain(
      '$includeLastSoldListing: Boolean'
    );
    expect(PROPERTY_DETAIL_INLINE_QUERY).toContain('zpid: $zpid');
    expect(PROPERTY_DETAIL_INLINE_QUERY).toContain('altId: $altId');
    expect(PROPERTY_DETAIL_INLINE_QUERY).toContain('deviceTypeV2: $deviceTypeV2');
    expect(PROPERTY_DETAIL_INLINE_QUERY).toContain(
      'includeLastSoldListing: $includeLastSoldListing'
    );
  });

  it('curates exactly the fields the parser consumes downstream', () => {
    const q = PROPERTY_DETAIL_INLINE_QUERY;
    // A representative sample of the curated fields (parser-consumed keys).
    for (const field of [
      'zpid',
      'hdpUrl',
      'price',
      'zestimate',
      'rentZestimate',
      'bedrooms',
      'bathrooms',
      'livingArea',
      'lotSize',
      'lotAreaValue',
      'lotAreaUnits',
      'yearBuilt',
      'homeType',
      'homeStatus',
      'description',
      'latitude',
      'longitude',
      'daysOnZillow',
      'pageViewCount',
      'favoriteCount',
      'taxAssessedValue',
      'taxAssessedYear',
      'mlsStreetAddress',
      'monthlyHoaFee',
      'taxAnnualAmount',
      'previousPrice',
      'timeOnZillow',
      'altAddresses',
      'streetAddress',
      'neighborhood',
      'associationFee',
      'associationFeeFrequency',
      'priceHistory',
      'taxHistory',
      'schools',
      'studentsPerTeacher',
    ]) {
      expect(q, `expected curated field "${field}"`).toContain(field);
    }
  });

  it('builds an inline POST body { operationName, query, variables }', () => {
    const body = buildInlineGraphqlBody({ zpid: 12345 });
    expect(body.operationName).toBe('PropertyDetail');
    expect(body.query).toBe(PROPERTY_DETAIL_INLINE_QUERY);
    expect(body.variables).toEqual({
      zpid: 12345,
      altId: null,
      deviceTypeV2: 'WEB_DESKTOP',
      includeLastSoldListing: true,
    });
    // No persisted-query extensions ride along.
    expect('extensions' in body).toBe(false);
  });

  it('PRIMARY path is an inline POST to /graphql/ with cookie-free headers + slugged referer', async () => {
    mockFetchJson.mockResolvedValue(sanitizedResponse());
    await fetchPropertyViaGraphql(mockClient, {
      zpid: 12345,
      slug: '268-Mallard-Rd-Lake-Lure-NC-28746',
    });
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    const [calledPath, init] = mockFetchJson.mock.calls[0];
    // Bare endpoint — no persistedQuery extensions in the query string.
    expect(calledPath).toBe(GRAPHQL_ENDPOINT_PATH);
    expect(calledPath).not.toContain('extensions');
    expect(init.method).toBe('POST');
    expect(init.body.operationName).toBe('PropertyDetail');
    expect(init.body.query).toContain('query PropertyDetail');
    expect(init.body.variables.zpid).toBe(12345);
    // Cookie-free headers, slugged referer.
    const headerKeys = Object.keys(init.headers).map((k) => k.toLowerCase());
    expect(headerKeys).not.toContain('cookie');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['client-id']).toBe(
      'not-for-sale-sub-app-browser-client'
    );
    expect(init.headers['x-z-enable-oauth-conversion']).toBe('true');
    expect(init.headers['referer']).toBe(
      'https://www.zillow.com/homedetails/268-Mallard-Rd-Lake-Lure-NC-28746/12345_zpid/'
    );
  });
});

describe('response parsing (inline + persisted share one parser)', () => {
  it('maps { data: { property } } onto FormattedProperty', async () => {
    mockFetchJson.mockResolvedValue(sanitizedResponse());
    const { raw, path } = await fetchPropertyViaGraphql(mockClient, {
      zpid: 12345,
    });
    expect(path).toBe(GRAPHQL_ENDPOINT_PATH);
    const formatted = format(raw);
    expect(formatted.zpid).toBe('12345');
    expect(formatted.price).toBe(450000);
    expect(formatted.beds).toBe(3);
    expect(formatted.lot_size).toBe(45738);
    expect(formatted.lot_size_acres).toBe(1.05);
    expect(formatted.address?.city).toBe('Lake Lure');
    expect(formatted.last_sold_status).toBe('available');
    expect(formatted.last_sold_price).toBe(300000);
  });
});

describe('normalizeLot — GraphQL lot fields → canonical lotSize (sqft)', () => {
  function lotResponse(
    lot: Partial<{
      lotSize: number;
      lotAreaValue: number;
      lotAreaUnits: string;
    }>
  ): GraphqlPropertyResponse {
    return { data: { property: { zpid: 12345, ...lot } } };
  }

  it('converts an acre lotAreaValue to sqft via SQFT_PER_ACRE', async () => {
    mockFetchJson.mockResolvedValue(
      lotResponse({ lotAreaValue: 1.05, lotAreaUnits: 'acres' })
    );
    const { raw } = await fetchPropertyViaGraphql(mockClient, { zpid: 12345 });
    expect(raw.lotSize).toBeCloseTo(SQFT_PER_ACRE * 1.05);
    expect(format(raw).lot_size_acres).toBe(1.05);
  });

  it('uses an explicit sqft lotAreaValue verbatim', async () => {
    mockFetchJson.mockResolvedValue(
      lotResponse({ lotAreaValue: 45738, lotAreaUnits: 'sqft' })
    );
    const { raw } = await fetchPropertyViaGraphql(mockClient, { zpid: 12345 });
    expect(raw.lotSize).toBe(45738);
  });
});

describe('persisted-hash fallback (demoted — only on explicit override)', () => {
  it('does NOT touch the persisted GET path when no override is set', async () => {
    mockFetchJson.mockResolvedValue(sanitizedResponse());
    await fetchPropertyViaGraphql(mockClient, { zpid: 12345 });
    // Exactly one call — the inline POST. No persisted GET retry.
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    const [, init] = mockFetchJson.mock.calls[0];
    expect(init.method).toBe('POST');
  });

  it('falls through inline → persisted GET when ZILLOW_PROPERTY_QUERY_HASH is set and inline 200s with a validation error', async () => {
    process.env.ZILLOW_PROPERTY_QUERY_HASH = 'deadbeef';
    mockFetchJson
      // Inline POST: a GraphQL validation failure (the schema rejected the
      // inline op) — must fall through to the persisted fallback, not bubble.
      .mockResolvedValueOnce({
        errors: [{ message: 'Cannot query field "foo" on type "Property".' }],
      })
      // Persisted GET: succeeds.
      .mockResolvedValueOnce(sanitizedResponse());
    const { raw } = await fetchPropertyViaGraphql(mockClient, { zpid: 12345 });
    expect(raw.price).toBe(450000);
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
    const [inlinePath, inlineInit] = mockFetchJson.mock.calls[0];
    const [persistedPath, persistedInit] = mockFetchJson.mock.calls[1];
    expect(inlineInit.method).toBe('POST');
    expect(inlinePath).toBe(GRAPHQL_ENDPOINT_PATH);
    expect(persistedInit.method).toBe('GET');
    expect(persistedPath).toContain('extensions');
    expect(persistedPath).toContain('deadbeef');
  });

  it('persisted fallback uses the override hash in the extensions', () => {
    process.env.ZILLOW_PROPERTY_QUERY_HASH = 'deadbeef';
    expect(propertyDetailHash()).toBe('deadbeef');
    const path = buildGraphqlPropertyPath({ zpid: 12345 });
    expect(path).toContain('deadbeef');
  });
});

describe('error classification — fall through vs propagate', () => {
  it('classifies an inline GraphQL validation error as GraphqlValidationError', async () => {
    mockFetchJson.mockResolvedValue({
      errors: [
        { message: 'Cannot query field "lotAreaValue" on type "Property".' },
      ],
    });
    // No override → no persisted fallback → the validation error surfaces
    // as a distinct, fall-through-able class (not a silent miss, not a wall).
    await expect(
      fetchPropertyViaGraphql(mockClient, { zpid: 12345 })
    ).rejects.toBeInstanceOf(GraphqlValidationError);
  });

  it('a PersistedQueryNotFound on the persisted fallback throws PersistedQueryNotFoundError', async () => {
    process.env.ZILLOW_PROPERTY_QUERY_HASH = 'deadbeef';
    mockFetchJson
      .mockResolvedValueOnce({
        errors: [{ message: 'Cannot query field "x".' }],
      })
      .mockResolvedValueOnce({
        errors: [
          {
            message: 'PersistedQueryNotFound',
            extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' },
          },
        ],
      });
    await expect(
      fetchPropertyViaGraphql(mockClient, { zpid: 12345 })
    ).rejects.toBeInstanceOf(PersistedQueryNotFoundError);
  });

  it('the PersistedQueryNotFound message names the recovery path', async () => {
    process.env.ZILLOW_PROPERTY_QUERY_HASH = 'deadbeef';
    mockFetchJson
      .mockResolvedValueOnce({ errors: [{ message: 'validation' }] })
      .mockResolvedValueOnce({
        errors: [{ message: 'PersistedQueryNotFound' }],
      });
    await expect(
      fetchPropertyViaGraphql(mockClient, { zpid: 12345 })
    ).rejects.toThrow(/re-extract/i);
  });

  it('throws a clear error when the property is absent from a 200 response', async () => {
    mockFetchJson.mockResolvedValue({ data: { property: null } });
    await expect(
      fetchPropertyViaGraphql(mockClient, { zpid: 12345 })
    ).rejects.toThrow(/no property/i);
  });

  it('a BotWallError from the inline POST propagates (not buried as a validation miss)', async () => {
    const { BotWallError } = await import('../../src/client.js');
    mockFetchJson.mockRejectedValue(new BotWallError('/graphql/'));
    await expect(
      fetchPropertyViaGraphql(mockClient, { zpid: 12345 })
    ).rejects.toBeInstanceOf(BotWallError);
  });

  it('a BotWallError on the persisted fallback also propagates', async () => {
    process.env.ZILLOW_PROPERTY_QUERY_HASH = 'deadbeef';
    const { BotWallError } = await import('../../src/client.js');
    mockFetchJson
      .mockResolvedValueOnce({ errors: [{ message: 'validation' }] })
      .mockRejectedValueOnce(new BotWallError('/graphql/'));
    await expect(
      fetchPropertyViaGraphql(mockClient, { zpid: 12345 })
    ).rejects.toBeInstanceOf(BotWallError);
  });
});
