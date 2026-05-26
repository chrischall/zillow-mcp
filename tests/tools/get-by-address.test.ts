import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import {
  buildAddressSlug,
  registerGetByAddressTools,
} from '../../src/tools/get-by-address.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

beforeEach(() => vi.clearAllMocks());

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

function htmlWithFirstListing(args: {
  zpid: number;
  detailUrl: string;
  streetAddress: string;
  city?: string;
  state?: string;
  zipcode?: string;
}): string {
  const nextData = {
    props: {
      pageProps: {
        searchPageState: {
          cat1: {
            searchResults: {
              listResults: [
                {
                  zpid: args.zpid,
                  detailUrl: args.detailUrl,
                  hdpData: {
                    homeInfo: {
                      zpid: args.zpid,
                      streetAddress: args.streetAddress,
                      city: args.city,
                      state: args.state,
                      zipcode: args.zipcode,
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

describe('buildAddressSlug', () => {
  it('joins the supplied fields into a single space-separated phrase', () => {
    expect(
      buildAddressSlug({
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      })
    ).toBe('126 Sleeping Bear Ln Lake Lure NC 28746');
  });

  it('skips missing optional parts', () => {
    expect(buildAddressSlug({ address: '155 Quail Cove Blvd 1601' })).toBe(
      '155 Quail Cove Blvd 1601'
    );
  });
});

describe('zillow_get_by_address tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerGetByAddressTools(server, mockClient)
    );
  });

  it('resolves an address to zpid + canonical URL via the search slug', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWithFirstListing({
        zpid: 102228838,
        detailUrl:
          '/homedetails/126-Sleeping-Bear-Ln-Lake-Lure-NC-28746/102228838_zpid/',
        streetAddress: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zipcode: '28746',
      })
    );
    const result = await harness.callTool('zillow_get_by_address', {
      address: '126 Sleeping Bear Ln',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(result.isError).toBeFalsy();
    // It must hit the /homes/<slug>_rb/ path (the bare resolve form).
    expect(mockFetchHtml.mock.calls[0][0]).toBe(
      '/homes/126%20Sleeping%20Bear%20Ln%20Lake%20Lure%20NC%2028746_rb/'
    );

    const parsed = parseToolResult<{
      resolved: boolean;
      zpid: string;
      url: string;
      street_address: string;
      city?: string;
      state?: string;
      zip?: string;
    }>(result);
    expect(parsed.resolved).toBe(true);
    expect(parsed.zpid).toBe('102228838');
    expect(parsed.url).toBe(
      'https://www.zillow.com/homedetails/126-Sleeping-Bear-Ln-Lake-Lure-NC-28746/102228838_zpid/'
    );
    expect(parsed.street_address).toBe('126 Sleeping Bear Ln');
    expect(parsed.city).toBe('Lake Lure');
    expect(parsed.state).toBe('NC');
    expect(parsed.zip).toBe('28746');
  });

  it('returns resolved=false when no listing comes back', async () => {
    mockFetchHtml.mockResolvedValue(
      '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>'
    );
    const result = await harness.callTool('zillow_get_by_address', {
      address: '999 Nowhere Ln',
      city: 'Atlantis',
      state: 'XX',
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult<{ resolved: boolean; error?: string }>(
      result
    );
    expect(parsed.resolved).toBe(false);
    expect(parsed.error).toMatch(/no listing found/i);
  });

  it('returns resolved=false when the page has no searchPageState at all', async () => {
    mockFetchHtml.mockResolvedValue('<html>nothing</html>');
    const result = await harness.callTool('zillow_get_by_address', {
      address: '999 Nowhere Ln',
    });
    const parsed = parseToolResult<{ resolved: boolean }>(result);
    expect(parsed.resolved).toBe(false);
  });

  it('errors when address is missing', async () => {
    const result = await harness.callTool('zillow_get_by_address', {});
    expect(result.isError).toBeTruthy();
  });

  it('builds an absolute URL when detailUrl is missing — falls back to zpid path', async () => {
    // Some responses include zpid but no detailUrl. We still want a
    // canonical URL on the way out.
    const nextData = {
      props: {
        pageProps: {
          searchPageState: {
            cat1: {
              searchResults: {
                listResults: [
                  {
                    zpid: 12345,
                    hdpData: {
                      homeInfo: {
                        zpid: 12345,
                        streetAddress: '1 Main St',
                        city: 'Brooklyn',
                        state: 'NY',
                        zipcode: '11215',
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
    mockFetchHtml.mockResolvedValue(
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
        nextData
      )}</script>`
    );
    const result = await harness.callTool('zillow_get_by_address', {
      address: '1 Main St',
      city: 'Brooklyn',
      state: 'NY',
      zip: '11215',
    });
    const parsed = parseToolResult<{ zpid: string; url: string }>(result);
    expect(parsed.zpid).toBe('12345');
    expect(parsed.url).toBe(
      'https://www.zillow.com/homedetails/12345_zpid/'
    );
  });
});
