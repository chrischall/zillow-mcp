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
});

describe('findSavedHomes', () => {
  it('returns pageProps.savedHomes when present', () => {
    const homes = [{ zpid: 1, hdpUrl: '/x' }];
    expect(findSavedHomes({ savedHomes: homes })).toBe(homes);
  });

  it('falls back to favoriteHomes', () => {
    const homes = [{ zpid: 2, hdpUrl: '/y' }];
    expect(findSavedHomes({ favoriteHomes: homes })).toBe(homes);
  });

  it('returns [] when nothing matches', () => {
    expect(findSavedHomes({})).toEqual([]);
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
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/user/savedSearches/');
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
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/myzillow/favorites/');
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
