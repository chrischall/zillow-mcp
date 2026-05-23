import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import {
  findSavedHomes,
  findSavedSearches,
  registerSavedTools,
} from '../../src/tools/saved.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

function htmlWith(pageProps: Record<string, unknown>): string {
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps },
  })}</script>`;
}

describe('findSavedSearches', () => {
  it('returns pageProps.savedSearches when present', () => {
    const searches = [{ id: 1, name: 'Brooklyn', searchQueryState: {} }];
    expect(findSavedSearches({ savedSearches: searches })).toBe(searches);
  });

  it('falls back to userSavedSearches', () => {
    const searches = [{ id: 1, filterState: {} }];
    expect(findSavedSearches({ userSavedSearches: searches })).toBe(searches);
  });

  it('returns [] when no candidate array is found', () => {
    expect(findSavedSearches({ foo: 'bar' })).toEqual([]);
  });

  it('shape-walks pageProps when direct keys miss', () => {
    // The direct keys (savedSearches, userSavedSearches) are absent —
    // but a generically-named array contains entries that pass the
    // shape predicate. The walker should still find it.
    const searches = [{ id: 5, name: 'X', filterState: { x: 1 } }];
    const result = findSavedSearches({ data: searches });
    expect(result).toBe(searches);
  });

  it('shape-walker accepts searchQueryState or filterState as the marker', () => {
    const a = findSavedSearches({
      blob: [{ id: 1, searchQueryState: {} }],
    });
    const b = findSavedSearches({
      blob: [{ id: 1, filterState: {} }],
    });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('shape-walker skips arrays whose first element lacks the marker', () => {
    const result = findSavedSearches({
      noise: [{ unrelated: true }],
      good: [{ filterState: {} }],
    });
    expect(result).toEqual([{ filterState: {} }]);
  });
});

describe('findSavedHomes', () => {
  it('returns pageProps.savedHomes when present', () => {
    const homes = [{ zpid: 1, hdpUrl: '/x' }];
    expect(findSavedHomes({ savedHomes: homes })).toBe(homes);
  });

  it('falls back to userSavedHomes', () => {
    const homes = [{ zpid: 3, hdpUrl: '/z' }];
    expect(findSavedHomes({ userSavedHomes: homes })).toBe(homes);
  });

  it('falls back to favoriteHomes', () => {
    const homes = [{ zpid: 2, hdpUrl: '/y' }];
    expect(findSavedHomes({ favoriteHomes: homes })).toBe(homes);
  });

  it('returns [] when nothing matches', () => {
    expect(findSavedHomes({})).toEqual([]);
  });

  it('shape-walks pageProps when direct keys miss', () => {
    const homes = [{ zpid: 12, hdpUrl: '/x' }];
    const result = findSavedHomes({ data: homes });
    expect(result).toBe(homes);
  });

  it('shape-walker requires zpid + (hdpUrl or savedAt)', () => {
    expect(
      findSavedHomes({ blob: [{ zpid: 1, hdpUrl: '/x' }] })
    ).toHaveLength(1);
    expect(
      findSavedHomes({ blob: [{ zpid: 1, savedAt: '2026-01-01' }] })
    ).toHaveLength(1);
    expect(findSavedHomes({ blob: [{ zpid: 1 }] })).toEqual([]);
    expect(findSavedHomes({ blob: [{ hdpUrl: '/x' }] })).toEqual([]);
  });

  it('flattens homes across collectionsResponse[].homes (current Zillow shape)', () => {
    const collectionsResponse = [
      {
        id: 'col-1',
        name: 'Default',
        homes: [
          { zpid: 1, hdpUrl: '/homedetails/1_zpid/' },
          { zpid: 2, hdpUrl: '/homedetails/2_zpid/' },
        ],
      },
      {
        id: 'col-2',
        name: 'Beach houses',
        homes: [{ zpid: 3, hdpUrl: '/homedetails/3_zpid/' }],
      },
    ];
    const result = findSavedHomes({ collectionsResponse });
    expect(result.map((h) => h.zpid)).toEqual([1, 2, 3]);
  });

  it('accepts `properties` and `items` as alternate keys inside a collection', () => {
    const result = findSavedHomes({
      collectionsResponse: [
        { properties: [{ zpid: 10, hdpUrl: '/x' }] },
        { items: [{ zpid: 20, hdpUrl: '/y' }] },
      ],
    });
    expect(result.map((h) => h.zpid)).toEqual([10, 20]);
  });

  it('returns [] when collectionsResponse exists but every collection is empty', () => {
    expect(
      findSavedHomes({
        collectionsResponse: [{ id: 'c', name: 'Empty', homes: [] }],
      })
    ).toEqual([]);
  });

  it('returns [] when collectionsResponse is an empty array (user has no collections)', () => {
    expect(findSavedHomes({ collectionsResponse: [] })).toEqual([]);
  });

  it('falls back to top-level savedHomes shape when collectionsResponse is absent', () => {
    const homes = [{ zpid: 7, hdpUrl: '/old' }];
    expect(findSavedHomes({ savedHomes: homes })).toBe(homes);
  });
});

describe('saved-tool formatting via the MCP boundary', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;

  beforeEach(async () => {
    if (h) await h.close();
    h = await createTestHarness((server) =>
      registerSavedTools(server, mockClient)
    );
  });

  it('formatSearch handles a search with no id (stays undefined)', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({
        savedSearches: [{ name: 'Anonymous', searchQueryState: {} }],
      })
    );
    const result = await h.callTool('zillow_get_saved_searches', {});
    const parsed = parseToolResult<Array<{ id?: string }>>(result);
    expect(parsed[0].id).toBeUndefined();
  });

  it('formatHome prefers an absolute hdpUrl over the synthesized fallback', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({
        savedHomes: [
          { zpid: 5, hdpUrl: 'https://www.zillow.com/homedetails/5_zpid/' },
        ],
      })
    );
    const result = await h.callTool('zillow_get_saved_homes', {});
    const parsed = parseToolResult<Array<{ url: string }>>(result);
    expect(parsed[0].url).toBe('https://www.zillow.com/homedetails/5_zpid/');
  });

  it('formatHome falls back to /homedetails/<zpid>_zpid/ when hdpUrl is missing', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({ savedHomes: [{ zpid: 42 }] })
    );
    const result = await h.callTool('zillow_get_saved_homes', {});
    const parsed = parseToolResult<Array<{ url: string }>>(result);
    expect(parsed[0].url).toBe('https://www.zillow.com/homedetails/42_zpid/');
  });
});

describe('saved tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerSavedTools(server, mockClient)
    );
  });

  it('zillow_get_saved_searches GETs /user/savedSearches/', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({
        savedSearches: [
          {
            id: 10,
            name: 'Park Slope 2-bed',
            newCount: 3,
            totalCount: 47,
            notificationFrequency: 'DAILY',
            searchQueryState: { foo: 'bar' },
            updatedAt: '2026-05-01',
          },
        ],
      })
    );

    const result = await harness.callTool('zillow_get_saved_searches', {});
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/myzillow/SavedSearches');
    const parsed = parseToolResult<Array<{ id: string; new_count: number }>>(
      result
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('10');
    expect(parsed[0].new_count).toBe(3);
  });

  it('zillow_get_saved_homes GETs /myzillow/favorites/', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({
        savedHomes: [
          {
            zpid: 99,
            hdpUrl: '/homedetails/99_zpid/',
            price: 800_000,
            address: { streetAddress: '1 Oak', city: 'X', state: 'NY' },
            savedAt: '2026-04-01',
          },
        ],
      })
    );
    const result = await harness.callTool('zillow_get_saved_homes', {});
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/myzillow/favorites');
    const parsed = parseToolResult<Array<{ zpid: string; price: number; url: string }>>(
      result
    );
    expect(parsed[0].zpid).toBe('99');
    expect(parsed[0].url).toBe('https://www.zillow.com/homedetails/99_zpid/');
  });

  it('returns an empty array when the user has no saved searches', async () => {
    mockFetchHtml.mockResolvedValue(htmlWith({ savedSearches: [] }));
    const result = await harness.callTool('zillow_get_saved_searches', {});
    const parsed = parseToolResult<unknown[]>(result);
    expect(parsed).toEqual([]);
  });
});
