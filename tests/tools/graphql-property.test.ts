import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SQFT_PER_ACRE } from '@chrischall/realty-core';
import type { ZillowClient } from '../../src/client.js';
import {
  PROPERTY_DETAIL_SHA256_HASH,
  PersistedQueryNotFoundError,
  buildGraphqlPropertyPath,
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

describe('persistedQuery response parsing (issue #99)', () => {
  it('maps { data: { property } } onto FormattedProperty', async () => {
    mockFetchJson.mockResolvedValue(sanitizedResponse());
    const { raw, path } = await fetchPropertyViaGraphql(mockClient, {
      zpid: 12345,
    });
    expect(path.startsWith('/graphql/?')).toBe(true);
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

  it('issues a GET with the constructed headers (no cookies)', async () => {
    mockFetchJson.mockResolvedValue(sanitizedResponse());
    await fetchPropertyViaGraphql(mockClient, { zpid: 12345 });
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    const [calledPath, init] = mockFetchJson.mock.calls[0];
    expect(calledPath).toContain('/graphql/?');
    expect(init.method).toBe('GET');
    const headerKeys = Object.keys(init.headers).map((k) => k.toLowerCase());
    expect(headerKeys).not.toContain('cookie');
    expect(init.headers['client-id']).toBe(
      'not-for-sale-sub-app-browser-client'
    );
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

describe('PersistedQueryNotFound handling (issue #99 — hashes rotate)', () => {
  it('throws PersistedQueryNotFoundError when the hash has rotated', async () => {
    mockFetchJson.mockResolvedValue({
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

  it('the error message names the rotated-hash recovery path', async () => {
    mockFetchJson.mockResolvedValue({
      errors: [{ message: 'PersistedQueryNotFound' }],
    });
    await expect(
      fetchPropertyViaGraphql(mockClient, { zpid: 12345 })
    ).rejects.toThrow(/re-extract/i);
  });

  it('surfaces other GraphQL errors distinctly (not a silent miss)', async () => {
    mockFetchJson.mockResolvedValue({
      errors: [{ message: 'Some other GraphQL error' }],
    });
    await expect(
      fetchPropertyViaGraphql(mockClient, { zpid: 12345 })
    ).rejects.toThrow(/Some other GraphQL error/);
  });

  it('throws a clear error when the property is absent from a 200 response', async () => {
    mockFetchJson.mockResolvedValue({ data: { property: null } });
    await expect(
      fetchPropertyViaGraphql(mockClient, { zpid: 12345 })
    ).rejects.toThrow(/no property/i);
  });
});
