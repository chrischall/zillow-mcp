import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import {
  InvalidPropertyUrlError,
  buildPath,
  extractZpidFromUrl,
  findPropertyInPageProps,
  registerPropertyTools,
  type RawProperty,
} from '../../src/tools/properties.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

function htmlWithProperty(raw: RawProperty): string {
  const cache = {
    'Property:1': { property: raw },
  };
  const nextData = {
    props: {
      pageProps: {
        gdpClientCache: JSON.stringify(cache),
      },
    },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData
  )}</script>`;
}

describe('extractZpidFromUrl', () => {
  it('pulls the zpid out of a canonical full URL', () => {
    expect(
      extractZpidFromUrl(
        'https://www.zillow.com/homedetails/268-Mallard-Rd-Lake-Lure-NC-28746/12345_zpid/'
      )
    ).toBe('12345');
  });

  it('handles a bare-path URL', () => {
    expect(extractZpidFromUrl('/homedetails/foo/99_zpid/')).toBe('99');
  });

  it('handles a path with no trailing slash', () => {
    expect(extractZpidFromUrl('/homedetails/foo/42_zpid')).toBe('42');
  });

  it('returns null for a slug-only URL (no _zpid)', () => {
    expect(
      extractZpidFromUrl(
        'https://www.zillow.com/homedetails/268-Mallard-Rd-Lake-Lure-NC-28746'
      )
    ).toBeNull();
  });

  it('returns null for the generic search URL', () => {
    expect(extractZpidFromUrl('https://www.zillow.com/homes/')).toBeNull();
  });
});

describe('buildPath', () => {
  it('builds the canonical bare path for a zpid arg', () => {
    expect(buildPath({ zpid: 12345 })).toBe('/homedetails/12345_zpid/');
  });

  it('passes a URL through urlToPath when it has a zpid', () => {
    expect(
      buildPath({
        url: 'https://www.zillow.com/homedetails/foo/12345_zpid/',
      })
    ).toBe('/homedetails/foo/12345_zpid/');
  });

  it('throws InvalidPropertyUrlError when the URL has no _zpid token', () => {
    expect(() =>
      buildPath({
        url: 'https://www.zillow.com/homedetails/268-Mallard-Rd-Lake-Lure-NC-28746',
      })
    ).toThrow(InvalidPropertyUrlError);
  });

  it('throws a clear hint when neither zpid nor url is provided', () => {
    expect(() => buildPath({})).toThrow(/zpid or url/);
  });
});

describe('findPropertyInPageProps', () => {
  it('returns the first property in gdpClientCache', () => {
    const cache = {
      foo: { property: { zpid: 42 } },
      bar: { property: { zpid: 99 } },
    };
    const property = findPropertyInPageProps({
      gdpClientCache: JSON.stringify(cache),
    });
    expect(property?.zpid).toBe(42);
  });

  it('supports componentProps.gdpClientCache for older builds', () => {
    const cache = { x: { property: { zpid: 7 } } };
    const property = findPropertyInPageProps({
      componentProps: { gdpClientCache: JSON.stringify(cache) },
    });
    expect(property?.zpid).toBe(7);
  });

  it('returns null when the cache is missing', () => {
    expect(findPropertyInPageProps({})).toBeNull();
  });

  it('returns null when the cache JSON is malformed', () => {
    expect(
      findPropertyInPageProps({ gdpClientCache: 'not json' })
    ).toBeNull();
  });

  it('skips entries without a property field', () => {
    const cache = { x: { foo: 'bar' }, y: { property: { zpid: 5 } } };
    const property = findPropertyInPageProps({
      gdpClientCache: JSON.stringify(cache),
    });
    expect(property?.zpid).toBe(5);
  });

  it('skips null entries in the cache', () => {
    // Defensive against Zillow shipping the cache with sparse entries.
    const cache = { x: null, y: { property: { zpid: 6 } } };
    const property = findPropertyInPageProps({
      gdpClientCache: JSON.stringify(cache),
    });
    expect(property?.zpid).toBe(6);
  });

  it('returns null when no entry has a property field', () => {
    const cache = { x: { foo: 'bar' }, y: { baz: 'qux' } };
    expect(
      findPropertyInPageProps({ gdpClientCache: JSON.stringify(cache) })
    ).toBeNull();
  });

  it('prefers Property:<zpid> keys over other entries that carry a property field', () => {
    // Belt-and-braces: if iteration order ever puts a non-Property
    // entry first, we should still pick the real property record.
    const cache = {
      ROOT_QUERY: { property: { zpid: 999 } }, // wrong shape, sorts first
      'Property:42': { property: { zpid: 42 } },
    };
    const property = findPropertyInPageProps({
      gdpClientCache: JSON.stringify(cache),
    });
    expect(property?.zpid).toBe(42);
  });

  it('falls back to any entry with a property field when no Property:<zpid> key exists', () => {
    const cache = { ROOT_QUERY: { property: { zpid: 5 } } };
    const property = findPropertyInPageProps({
      gdpClientCache: JSON.stringify(cache),
    });
    expect(property?.zpid).toBe(5);
  });
});

describe('zillow_get_property tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerPropertyTools(server, mockClient)
    );
  });

  it('fetches /homedetails/<zpid>_zpid/ and formats the property', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWithProperty({
        zpid: 12345,
        address: {
          streetAddress: '1 Main St',
          city: 'Brooklyn',
          state: 'NY',
          zipcode: '11215',
        },
        price: 1_500_000,
        zestimate: 1_550_000,
        rentZestimate: 6000,
        bedrooms: 3,
        bathrooms: 2,
        livingArea: 1600,
        yearBuilt: 1925,
        homeType: 'TOWNHOUSE',
        homeStatus: 'FOR_SALE',
      })
    );

    const result = await harness.callTool('zillow_get_property', { zpid: 12345 });
    expect(result.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/homedetails/12345_zpid/');

    const parsed = parseToolResult<{
      zpid: string;
      price: number;
      zestimate: number;
      beds: number;
      url: string;
    }>(result);
    expect(parsed.zpid).toBe('12345');
    expect(parsed.price).toBe(1_500_000);
    expect(parsed.zestimate).toBe(1_550_000);
    expect(parsed.beds).toBe(3);
    expect(parsed.url).toBe('https://www.zillow.com/homedetails/12345_zpid/');
  });

  it('accepts a full URL and reduces it to a path', async () => {
    mockFetchHtml.mockResolvedValue(htmlWithProperty({ zpid: 7 }));
    await harness.callTool('zillow_get_property', {
      url: 'https://www.zillow.com/homedetails/foo-bar/7_zpid/',
    });
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/homedetails/foo-bar/7_zpid/');
  });

  it('accepts a bare path (URL.parse falls through to the path branch)', async () => {
    mockFetchHtml.mockResolvedValue(htmlWithProperty({ zpid: 8 }));
    await harness.callTool('zillow_get_property', {
      url: '/homedetails/foo/8_zpid/',
    });
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/homedetails/foo/8_zpid/');
  });

  it('preserves a neighborhood from address', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWithProperty({
        zpid: 100,
        address: {
          streetAddress: '1 Main',
          city: 'Brooklyn',
          state: 'NY',
          zipcode: '11215',
          neighborhood: 'Park Slope',
        },
      })
    );
    const result = await harness.callTool('zillow_get_property', { zpid: 100 });
    const parsed = parseToolResult<{ neighborhood: string }>(result);
    expect(parsed.neighborhood).toBe('Park Slope');
  });

  it('throws when neither zpid nor url is provided', async () => {
    const result = await harness.callTool('zillow_get_property', {});
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/zpid or url/i);
  });

  it('throws a helpful error when property data is absent from the page', async () => {
    mockFetchHtml.mockResolvedValue(
      '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>'
    );
    const result = await harness.callTool('zillow_get_property', { zpid: 1 });
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/Could not locate property/i);
  });

  it('falls back to resoFacts.yearBuilt when the top-level yearBuilt is missing (issue #29)', async () => {
    // Verified live (May 2026): zpids 102228838, 102109205, 99388739 omit top-level yearBuilt but populate resoFacts.yearBuilt.
    mockFetchHtml.mockResolvedValue(
      htmlWithProperty({
        zpid: 102228838,
        // yearBuilt deliberately omitted at the top level
        resoFacts: { yearBuilt: 1966 },
      } as RawProperty)
    );
    const result = await harness.callTool('zillow_get_property', {
      zpid: 102228838,
    });
    const parsed = parseToolResult<{ year_built: number }>(result);
    expect(parsed.year_built).toBe(1966);
  });

  it('keeps the top-level yearBuilt when both paths are populated', async () => {
    // 456147481, 102205216: top-level yearBuilt is correct; fallback must not override.
    mockFetchHtml.mockResolvedValue(
      htmlWithProperty({
        zpid: 456147481,
        yearBuilt: 2007,
        resoFacts: { yearBuilt: 1900 },
      } as RawProperty)
    );
    const result = await harness.callTool('zillow_get_property', {
      zpid: 456147481,
    });
    const parsed = parseToolResult<{ year_built: number }>(result);
    expect(parsed.year_built).toBe(2007);
  });

  it('returns year_built undefined when neither path is populated', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWithProperty({ zpid: 1, resoFacts: {} } as RawProperty)
    );
    const result = await harness.callTool('zillow_get_property', { zpid: 1 });
    const parsed = parseToolResult<{ year_built?: number }>(result);
    expect(parsed.year_built).toBeUndefined();
  });
});
