import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import {
  InvalidPropertyUrlError,
  buildPath,
  extractZpidFromUrl,
  findPropertyInPageProps,
  format,
  registerPropertyTools,
  type RawProperty,
} from '../../src/tools/properties.js';
import { createTestHarness, parseToolResult } from '../helpers.js';
import type { ExtractedFeatures } from '../../src/features.js';

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

describe('format() — FormattedProperty contract', () => {
  // PR #61 polish nit: the FormattedProperty contract guarantees
  // extracted_features is always populated by format(). The interface
  // should reflect that — i.e. the field is non-optional. This test
  // asserts the source-level type by destructuring into a non-optional
  // local (which only typechecks if FormattedProperty.extracted_features
  // is declared as required, not `?:`).
  it('declares extracted_features as a required (non-optional) field', () => {
    const out = format({ zpid: 1, description: 'Lakefront cabin' } as RawProperty);
    // Force the type-system to demand a present-and-typed value. If
    // FormattedProperty regresses to `extracted_features?: ...`, this
    // assignment errors at `tsc --noEmit`.
    const features: ExtractedFeatures = out.extracted_features;
    expect(features.lake_front).toBe(true);
  });

  it('still populates extracted_features when description is absent', () => {
    const out = format({ zpid: 1 } as RawProperty);
    const features: ExtractedFeatures = out.extracted_features;
    expect(features).toEqual({
      lake_front: false,
      hot_tub: false,
      basement: null,
      furnished: null,
      dock: null,
      community: null,
    });
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

  it('surfaces mls_street_address alongside the address.streetAddress (issue #30)', async () => {
    // For some zpids the page-level streetAddress disagrees with the
    // canonical MLS form. Surface both so the caller can disambiguate.
    // Verified live for zpid 248872078 (109 vs 169 Overlook Point Ln).
    mockFetchHtml.mockResolvedValue(
      htmlWithProperty({
        zpid: 248872078,
        address: {
          streetAddress: '109 Overlook Point Ln',
          city: 'Lake Lure',
          state: 'NC',
          zipcode: '28746',
        },
        mlsStreetAddress: '169 Overlook Point Ln',
      } as RawProperty)
    );
    const result = await harness.callTool('zillow_get_property', {
      zpid: 248872078,
    });
    const parsed = parseToolResult<{
      address: { streetAddress: string };
      mls_street_address: string;
    }>(result);
    expect(parsed.address.streetAddress).toBe('109 Overlook Point Ln');
    expect(parsed.mls_street_address).toBe('169 Overlook Point Ln');
  });

  it('surfaces mls_street_address even with whitespace-only differences from streetAddress', async () => {
    // For zpid 208205936 the two differ only in spacing ("131 Pier Point
    // Dr" vs "131 Pierpoint Dr"). Both must be reachable.
    mockFetchHtml.mockResolvedValue(
      htmlWithProperty({
        zpid: 208205936,
        address: { streetAddress: '131 Pier Point Dr' },
        mlsStreetAddress: '131 Pierpoint Dr',
      } as RawProperty)
    );
    const result = await harness.callTool('zillow_get_property', {
      zpid: 208205936,
    });
    const parsed = parseToolResult<{
      address: { streetAddress: string };
      mls_street_address: string;
    }>(result);
    expect(parsed.address.streetAddress).toBe('131 Pier Point Dr');
    expect(parsed.mls_street_address).toBe('131 Pierpoint Dr');
  });

  it('omits mls_street_address when the page payload lacks it', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWithProperty({
        zpid: 1,
        address: { streetAddress: '1 Main St' },
      } as RawProperty)
    );
    const result = await harness.callTool('zillow_get_property', { zpid: 1 });
    const parsed = parseToolResult<{ mls_street_address?: string }>(result);
    expect(parsed.mls_street_address).toBeUndefined();
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

  describe('P1 schema (issues #42–#50, #57)', () => {
    it('derives hoa_monthly_usd from monthlyHoaFee directly when present (issue #42)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({
          zpid: 1,
          monthlyHoaFee: 414,
        } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{ hoa_monthly_usd: number | null }>(result);
      expect(parsed.hoa_monthly_usd).toBe(414);
    });

    it('derives hoa_monthly_usd from associationFee + Annually frequency (issue #42)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({
          zpid: 1,
          resoFacts: {
            associationFee: 4967,
            associationFeeFrequency: 'Annually',
          },
        } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{ hoa_monthly_usd: number | null }>(result);
      expect(parsed.hoa_monthly_usd).toBe(414);
    });

    it('hoa_monthly_usd is null when no HOA info is present', async () => {
      mockFetchHtml.mockResolvedValue(htmlWithProperty({ zpid: 1 } as RawProperty));
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{ hoa_monthly_usd: number | null }>(result);
      expect(parsed.hoa_monthly_usd).toBeNull();
    });

    it('hoa_monthly_usd is null when frequency is unrecognized', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({
          zpid: 1,
          resoFacts: { associationFee: 100, associationFeeFrequency: 'EveryFortnight' },
        } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{ hoa_monthly_usd: number | null }>(result);
      expect(parsed.hoa_monthly_usd).toBeNull();
    });

    it('computes price_drop_* from price + previousPrice (issue #43)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({
          zpid: 1,
          price: 480_000,
          previousPrice: 500_000,
        } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{
        price_drop_amount: number | null;
        price_drop_percent: number | null;
      }>(result);
      expect(parsed.price_drop_amount).toBe(20_000);
      expect(parsed.price_drop_percent).toBe(4.0);
    });

    it('price_drop_* are null when previousPrice is missing', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({ zpid: 1, price: 500_000 } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{
        price_drop_amount: number | null;
        price_drop_percent: number | null;
      }>(result);
      expect(parsed.price_drop_amount).toBeNull();
      expect(parsed.price_drop_percent).toBeNull();
    });

    it('surfaces days_on_market (alias for daysOnZillow) (issue #43)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({ zpid: 1, daysOnZillow: 30 } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{ days_on_market: number | null }>(result);
      expect(parsed.days_on_market).toBe(30);
    });

    it('days_on_market is null when neither daysOnZillow nor timeOnZillow present', async () => {
      mockFetchHtml.mockResolvedValue(htmlWithProperty({ zpid: 1 } as RawProperty));
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{ days_on_market: number | null }>(result);
      expect(parsed.days_on_market).toBeNull();
    });

    it('nulls out the placeholder tax_annual: 1 with tax_status="new_construction" (issues #44, #77)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({ zpid: 1, taxAnnualAmount: 1 } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{
        tax_annual: number | null;
        tax_status: string;
      }>(result);
      expect(parsed.tax_annual).toBeNull();
      expect(parsed.tax_status).toBe('new_construction');
    });

    it('nulls out the placeholder tax_annual: 0 with tax_status="new_construction" (issues #44, #77)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({ zpid: 1, taxAnnualAmount: 0 } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{
        tax_annual: number | null;
        tax_status: string;
      }>(result);
      expect(parsed.tax_annual).toBeNull();
      expect(parsed.tax_status).toBe('new_construction');
    });

    it('keeps a real tax_annual and sets tax_status="available" (issue #77)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({ zpid: 1, taxAnnualAmount: 5432 } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{
        tax_annual: number | null;
        tax_status: string;
      }>(result);
      expect(parsed.tax_annual).toBe(5432);
      expect(parsed.tax_status).toBe('available');
    });

    it('sets tax_status="unavailable" when no tax field at all (issue #77)', async () => {
      // Distinguishes "Zillow has no tax data for this home" from "lookup failed".
      mockFetchHtml.mockResolvedValue(htmlWithProperty({ zpid: 1 } as RawProperty));
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{
        tax_annual: number | null;
        tax_status: string;
      }>(result);
      expect(parsed.tax_annual).toBeNull();
      expect(parsed.tax_status).toBe('unavailable');
    });

    describe('zestimate_status / last_sold_status (issue #77)', () => {
      it('zestimate_status="available" when zestimate is a positive number', async () => {
        mockFetchHtml.mockResolvedValue(
          htmlWithProperty({ zpid: 1, zestimate: 500_000 } as RawProperty)
        );
        const result = await harness.callTool('zillow_get_property', { zpid: 1 });
        const parsed = parseToolResult<{ zestimate_status: string }>(result);
        expect(parsed.zestimate_status).toBe('available');
      });

      it('zestimate_status="rent_only" when only rentZestimate is set (e.g. 181 Highland Hts)', async () => {
        // Session reporter: 181 Highland Hts resolved fine but returned
        // null sale Zestimate + a real rent Zestimate. That genuinely-
        // absent state must be distinguishable from a hard lookup miss.
        mockFetchHtml.mockResolvedValue(
          htmlWithProperty({ zpid: 1, rentZestimate: 3500 } as RawProperty)
        );
        const result = await harness.callTool('zillow_get_property', { zpid: 1 });
        const parsed = parseToolResult<{ zestimate_status: string }>(result);
        expect(parsed.zestimate_status).toBe('rent_only');
      });

      it('zestimate_status="unavailable" when both zestimate and rentZestimate are null (e.g. 193 Downing Pl)', async () => {
        mockFetchHtml.mockResolvedValue(htmlWithProperty({ zpid: 1 } as RawProperty));
        const result = await harness.callTool('zillow_get_property', { zpid: 1 });
        const parsed = parseToolResult<{ zestimate_status: string }>(result);
        expect(parsed.zestimate_status).toBe('unavailable');
      });

      it('last_sold_status="available" when a Sold event exists in priceHistory', async () => {
        mockFetchHtml.mockResolvedValue(
          htmlWithProperty({
            zpid: 1,
            priceHistory: [{ date: '2023-06-01', event: 'Sold', price: 750_000 }],
          } as RawProperty)
        );
        const result = await harness.callTool('zillow_get_property', { zpid: 1 });
        const parsed = parseToolResult<{ last_sold_status: string }>(result);
        expect(parsed.last_sold_status).toBe('available');
      });

      it('last_sold_status="never_sold" when priceHistory has events but no Sold', async () => {
        // Distinguishes "Zillow saw a price change but no sale" from
        // "Zillow has no history for this property".
        mockFetchHtml.mockResolvedValue(
          htmlWithProperty({
            zpid: 1,
            priceHistory: [
              { date: '2025-01-15', event: 'Listed for sale', price: 800_000 },
            ],
          } as RawProperty)
        );
        const result = await harness.callTool('zillow_get_property', { zpid: 1 });
        const parsed = parseToolResult<{ last_sold_status: string }>(result);
        expect(parsed.last_sold_status).toBe('never_sold');
      });

      it('last_sold_status="unavailable" when priceHistory is absent', async () => {
        mockFetchHtml.mockResolvedValue(htmlWithProperty({ zpid: 1 } as RawProperty));
        const result = await harness.callTool('zillow_get_property', { zpid: 1 });
        const parsed = parseToolResult<{ last_sold_status: string }>(result);
        expect(parsed.last_sold_status).toBe('unavailable');
      });
    });

    it('reads tax_annual from resoFacts when top-level is missing (issue #44 fallback)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({
          zpid: 1,
          resoFacts: { taxAnnualAmount: 8200 },
        } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{ tax_annual: number | null }>(result);
      expect(parsed.tax_annual).toBe(8200);
    });

    it('always emits portal_url_hyperlink as a Sheets HYPERLINK formula (issue #49)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({ zpid: 12345 } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 12345 });
      const parsed = parseToolResult<{ portal_url_hyperlink: string; url: string }>(result);
      expect(parsed.portal_url_hyperlink).toMatch(/^=HYPERLINK\(/);
      expect(parsed.portal_url_hyperlink).toContain(parsed.url);
      expect(parsed.portal_url_hyperlink).toContain('"Zillow"');
    });

    it('surfaces address_alternates when mlsStreetAddress differs from streetAddress (issue #50)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({
          zpid: 248872078,
          address: { streetAddress: '109 Overlook Point Ln' },
          mlsStreetAddress: '169 Overlook Point Ln',
        } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 248872078 });
      const parsed = parseToolResult<{ address_alternates?: string[] }>(result);
      expect(parsed.address_alternates).toContain('169 Overlook Point Ln');
    });

    it('omits address_alternates when no alternates differ from the primary (issue #50)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({
          zpid: 1,
          address: { streetAddress: '1 Main St' },
          mlsStreetAddress: '1 Main St',
        } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{ address_alternates?: string[] }>(result);
      expect(parsed.address_alternates).toBeUndefined();
    });

    it('picks up altAddresses[] from raw payload (issue #50)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({
          zpid: 1,
          address: { streetAddress: '1 Main St' },
          altAddresses: ['1 Main Street', '1 Main St.'],
        } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{ address_alternates?: string[] }>(result);
      // Both variants differ from "1 Main St" after normalization? "1 Main Street" yes, "1 Main St." normalizes to same.
      expect(parsed.address_alternates).toContain('1 Main Street');
    });

    it('extracts last_sold_* from priceHistory (issue #57)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({
          zpid: 1,
          priceHistory: [
            { date: '2025-01-15', event: 'Listed for sale', price: 800_000 },
            { date: '2023-06-01', event: 'Sold', price: 750_000 },
            { date: '2020-01-01', event: 'Sold', price: 500_000 },
          ],
        } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{
        last_sold_date: string | null;
        last_sold_price: number | null;
      }>(result);
      expect(parsed.last_sold_date).toBe('2023-06-01');
      expect(parsed.last_sold_price).toBe(750_000);
    });

    it('last_sold_* are null when no Sold event in history (issue #57)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({
          zpid: 1,
          priceHistory: [{ date: '2025-01-01', event: 'Listed for sale', price: 1 }],
        } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{
        last_sold_date: string | null;
        last_sold_price: number | null;
      }>(result);
      expect(parsed.last_sold_date).toBeNull();
      expect(parsed.last_sold_price).toBeNull();
    });

    it('computes zest_vs_list_pct = (list - zest) / zest * 100 (issue #57)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({ zpid: 1, price: 550_000, zestimate: 500_000 } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{ zest_vs_list_pct: number | null }>(result);
      expect(parsed.zest_vs_list_pct).toBe(10.0);
    });

    it('zest_vs_list_pct is negative when listed below zestimate (issue #57)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({ zpid: 1, price: 450_000, zestimate: 500_000 } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{ zest_vs_list_pct: number | null }>(result);
      expect(parsed.zest_vs_list_pct).toBe(-10.0);
    });

    it('zest_vs_list_pct is null when zestimate is missing (issue #57)', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWithProperty({ zpid: 1, price: 500_000 } as RawProperty)
      );
      const result = await harness.callTool('zillow_get_property', { zpid: 1 });
      const parsed = parseToolResult<{ zest_vs_list_pct: number | null }>(result);
      expect(parsed.zest_vs_list_pct).toBeNull();
    });
  });

  it('omits the raw description by default (issue #40)', async () => {
    // Per-listing context-saving: callers usually keyword-parse and
    // discard the description on receipt.
    mockFetchHtml.mockResolvedValue(
      htmlWithProperty({
        zpid: 5,
        description: 'Lakefront with hot tub. Finished basement.',
      } as RawProperty)
    );
    const result = await harness.callTool('zillow_get_property', { zpid: 5 });
    const parsed = parseToolResult<{ description?: string }>(result);
    expect(parsed.description).toBeUndefined();
  });

  it('keeps the description when include_description: true', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWithProperty({
        zpid: 5,
        description: 'Lakefront with hot tub.',
      } as RawProperty)
    );
    const result = await harness.callTool('zillow_get_property', {
      zpid: 5,
      include_description: true,
    });
    const parsed = parseToolResult<{ description?: string }>(result);
    expect(parsed.description).toBe('Lakefront with hot tub.');
  });

  it('always populates extracted_features when a description exists (issue #41)', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWithProperty({
        zpid: 5,
        description: 'Lakefront with private dock and hot tub. Finished basement.',
      } as RawProperty)
    );
    const result = await harness.callTool('zillow_get_property', { zpid: 5 });
    // Typed non-optional — PR #61 polish nit: the FormattedProperty
    // contract guarantees extracted_features is always present, so the
    // type shouldn't make callers thread `!` assertions.
    const parsed = parseToolResult<{
      extracted_features: {
        lake_front: boolean;
        hot_tub: boolean;
        basement: string | null;
        dock: string | null;
      };
    }>(result);
    expect(parsed.extracted_features).toBeDefined();
    expect(parsed.extracted_features.lake_front).toBe(true);
    expect(parsed.extracted_features.hot_tub).toBe(true);
    expect(parsed.extracted_features.basement).toBe('finished');
    expect(parsed.extracted_features.dock).toBe('private');
  });

  it('populates extracted_features with the five-field schema even on empty descriptions', async () => {
    // Issue #41 calls out that all five binary/categorical features
    // should always be present (populated when possible). We surface
    // them whether or not the listing has a description.
    mockFetchHtml.mockResolvedValue(htmlWithProperty({ zpid: 5 } as RawProperty));
    const result = await harness.callTool('zillow_get_property', { zpid: 5 });
    const parsed = parseToolResult<{
      extracted_features: {
        lake_front: boolean;
        hot_tub: boolean;
        basement: string | null;
        furnished: string | null;
        dock: string | null;
        community: string | null;
      };
    }>(result);
    expect(parsed.extracted_features).toEqual({
      lake_front: false,
      hot_tub: false,
      basement: null,
      furnished: null,
      dock: null,
      community: null,
    });
  });
});
