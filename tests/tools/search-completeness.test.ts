import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ZillowClient } from '../../src/client.js';
import {
  buildSearchQueryState,
  outsideBounds,
  passesNumericFilters,
  quarter,
  runRegionSearch,
  sweepArea,
  totalResultCount,
  type FormattedListing,
  type MapBounds,
  type RawListing,
} from '../../src/tools/search.js';

const region = {
  regionSelection: [{ regionId: 13713, regionType: 4 }],
  mapBounds: { north: 37.5, south: 37.1, east: -121.6, west: -122.2 },
};

function listing(zpid: number, price: number, lat = 37.3, lng = -121.9, beds = 3, baths = 2): RawListing {
  return {
    zpid,
    hdpData: { homeInfo: { zpid, price, bedrooms: beds, bathrooms: baths, homeType: 'CONDO', latitude: lat, longitude: lng, city: 'San Jose', state: 'CA', zipcode: '95128' } },
  };
}

function page(list: RawListing[], total?: number, where: 'searchList' | 'categoryTotals' = 'searchList'): string {
  const sps: Record<string, unknown> = {
    queryState: { regionSelection: region.regionSelection, mapBounds: region.mapBounds },
    cat1: { searchResults: { listResults: list }, ...(total !== undefined && where === 'searchList' ? { searchList: { totalResultCount: total } } : {}) },
    ...(total !== undefined && where === 'categoryTotals' ? { categoryTotals: { cat1: { totalResultCount: total } } } : {}),
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { searchPageState: sps } } })}</script>`;
}

const fetchHtml = vi.fn();
const client = { fetchHtml } as unknown as ZillowClient;
beforeEach(() => fetchHtml.mockReset());
afterEach(() => vi.useRealTimers());

describe('totalResultCount', () => {
  it('reads cat1.searchList, then categoryTotals, else null', () => {
    expect(totalResultCount({ cat1: { searchList: { totalResultCount: 812 } } })).toBe(812);
    expect(totalResultCount({ categoryTotals: { cat1: { totalResultCount: 9 } } })).toBe(9);
    expect(totalResultCount({ cat1: {} })).toBeNull();
    expect(totalResultCount(null)).toBeNull();
  });
});

describe('guards', () => {
  const f = (o: Partial<FormattedListing>): FormattedListing => ({ zpid: '1', address: 'x', ...o });
  it('drops listings outside numeric filters but keeps missing fields', () => {
    expect(passesNumericFilters(f({ price: 1_300_000 }), { location: 'x', price_max: 935_000 })).toBe(false);
    expect(passesNumericFilters(f({ price: 900_000 }), { location: 'x', price_max: 935_000 })).toBe(true);
    expect(passesNumericFilters(f({}), { location: 'x', price_max: 935_000, beds_min: 2 })).toBe(true);
    expect(passesNumericFilters(f({ beds: 1 }), { location: 'x', beds_min: 2 })).toBe(false);
    expect(passesNumericFilters(f({ baths: 1.5 }), { location: 'x', baths_min: 2 })).toBe(false);
  });
  it('flags listings outside the viewport', () => {
    const b: MapBounds = { north: 37.4, south: 37.3, east: -121.8, west: -121.9 };
    expect(outsideBounds(f({ latitude: 37.35, longitude: -121.85 }), b)).toBe(false);
    expect(outsideBounds(f({ latitude: 37.5, longitude: -121.85 }), b)).toBe(true);
    expect(outsideBounds(f({}), b)).toBe(false);
  });
  it('quarters a box into four exact children', () => {
    const q = quarter({ north: 2, south: 0, east: 2, west: 0 });
    expect(q).toHaveLength(4);
    expect(q[0]).toEqual({ north: 2, south: 1, west: 0, east: 1 });
    expect(q[3]).toEqual({ north: 1, south: 0, west: 1, east: 2 });
  });
  it('pins a caller viewport into the query state', () => {
    const b = { north: 37.4, south: 37.3, east: -121.8, west: -121.9 };
    const sqs = buildSearchQueryState({ location: 'San Jose, CA', map_bounds: b }, region);
    expect(sqs.mapBounds).toEqual(b);
    expect(sqs.regionSelection).toEqual(region.regionSelection);
    expect(sqs.isMapVisible).toBe(true);
  });
});

describe('runRegionSearch completeness report', () => {
  it('walks pages, applies the filter guard and reports not truncated when all fetched', async () => {
    const p1 = Array.from({ length: 40 }, (_, i) => listing(i + 1, 800_000));
    const p2 = [listing(41, 820_000), listing(42, 1_350_000)]; // 42 violates price_max
    fetchHtml.mockResolvedValueOnce(page(p1, 42)).mockResolvedValueOnce(page(p2, 42)).mockResolvedValueOnce(page([], 42));
    const { results, meta } = await runRegionSearch(client, { location: 'San Jose, CA', price_max: 935_000 }, region, 1000);
    expect(results).toHaveLength(41);
    expect(meta).toMatchObject({ total_result_count: 42, fetched: 42, dropped_filter_guard: 1, truncated: false, stop_reason: 'empty_page', pages_fetched: 3 });
  });
  it('reports truncation when Zillow says more exist than it served', async () => {
    const p1 = Array.from({ length: 40 }, (_, i) => listing(i + 1, 700_000));
    fetchHtml.mockResolvedValueOnce(page(p1, 1694)).mockResolvedValueOnce(page(p1, 1694)); // repeated page = Zillow stopped paging
    const { meta } = await runRegionSearch(client, { location: 'San Jose, CA' }, region, 1000);
    expect(meta.truncated).toBe(true);
    expect(meta.stop_reason).toBe('repeat_page');
    expect(meta.total_result_count).toBe(1694);
  });
  it('counts filter-passing matches, not padded pages, against the total', async () => {
    // Zillow says 3 match, serves 4 (one off-filter) then runs out: the 1-listing
    // shortfall is reported, but it is a guard disagreement, not truncation.
    const p1 = [listing(1, 800_000), listing(2, 820_000), listing(3, 1_500_000), listing(4, 1_600_000)];
    fetchHtml.mockResolvedValueOnce(page(p1, 3)).mockResolvedValueOnce(page([], 3));
    const { meta } = await runRegionSearch(client, { location: 'x', price_max: 935_000 }, region, 1000);
    expect(meta).toMatchObject({ fetched: 4, matched: 2, shortfall: 1, truncated: false });
    expect(meta.dropped.map((d) => d.reason)).toEqual(['price_above_max', 'price_above_max']);
  });
  it('flags truncation when matches fall short and we stopped paging ourselves', async () => {
    const p1 = Array.from({ length: 40 }, (_, i) => listing(i + 1, i < 20 ? 800_000 : 1_500_000));
    fetchHtml.mockResolvedValueOnce(page(p1, 30));
    const { meta } = await runRegionSearch(client, { location: 'x', price_max: 935_000, auto_paginate: false }, region, 1000);
    expect(meta).toMatchObject({ fetched: 40, matched: 20, shortfall: 10, truncated: true, stop_reason: 'single_page' });
  });
  it('reads the total from categoryTotals when searchList is absent', async () => {
    fetchHtml.mockResolvedValueOnce(page([listing(1, 1)], 1, 'categoryTotals')).mockResolvedValueOnce(page([], 1, 'categoryTotals'));
    const { meta } = await runRegionSearch(client, { location: 'x' }, region, 1000);
    expect(meta.total_result_count).toBe(1);
    expect(meta.truncated).toBe(false);
  });
});

describe('sweepArea', () => {
  it('quarters a capped tile, dedupes across tiles and writes the full set', async () => {
    // resolve call
    fetchHtml.mockResolvedValueOnce(page([listing(999, 700_000)], 5));
    // root tile: Zillow says 500 (> tile_cap 400) -> split right after page 1
    const forty = Array.from({ length: 40 }, (_, i) => listing(i + 1, 700_000));
    fetchHtml.mockResolvedValueOnce(page(forty, 500));
    // four children: each complete; child 0 and 1 share zpid 7 (boundary listing)
    for (const ids of [[7, 101], [7, 102], [103], [104, 105]]) {
      fetchHtml.mockResolvedValueOnce(page(ids.map((z) => listing(z, 650_000)), ids.length)).mockResolvedValueOnce(page([], ids.length));
    }
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    const out = join(dir, 'z.json');
    const s = await sweepArea(client, { location: 'San Jose, CA', delay_ms: 0, output_path: out, tile_cap: 400 });
    expect(s.complete).toBe(true);
    expect(s.split_tiles).toBe(1);
    expect(s.leaf_tiles).toBe(4);
    expect(s.unique_listings).toBe(6); // 7,101,102,103,104,105
    const file = JSON.parse(readFileSync(out, 'utf8'));
    expect(file.results).toHaveLength(6);
    expect(file.tiles).toHaveLength(5);
  });
  it('returns the listings inline when no output_path is given', async () => {
    fetchHtml.mockResolvedValueOnce(page([listing(1, 1)], 1));
    fetchHtml.mockResolvedValueOnce(page([listing(11, 600_000), listing(12, 610_000)], 2)).mockResolvedValueOnce(page([], 2));
    const s = await sweepArea(client, { location: 'San Jose, CA', delay_ms: 0 });
    expect(s.complete).toBe(true);
    expect(s).not.toHaveProperty('output_path');
    expect(s.results?.map((r) => r.zpid)).toEqual(['11', '12']);
  });
  it('stops at the request budget and reports incomplete', async () => {
    fetchHtml.mockResolvedValueOnce(page([listing(1, 1)], 1));
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    const s = await sweepArea(client, { location: 'San Jose, CA', delay_ms: 0, output_path: join(dir, 'z.json'), max_requests: 1 });
    expect(s.complete).toBe(false);
    expect(s.budget_hit).toBe(true);
  });
});

describe('deep-page errors and early splits', () => {
  it('keeps earlier pages when a later page fails, and reports truncation', async () => {
    const p1 = Array.from({ length: 40 }, (_, i) => listing(i + 1, 700_000));
    fetchHtml.mockResolvedValueOnce(page(p1, 900)).mockRejectedValueOnce(new Error('Zillow API error: 400 for GET /homes/...'));
    const { results, meta } = await runRegionSearch(client, { location: 'x' }, region, 1000);
    expect(results).toHaveLength(40);
    expect(meta).toMatchObject({ stop_reason: 'page_error', truncated: true, pages_fetched: 1 });
    expect(meta.page_error).toMatch(/400/);
  });
  it('still throws when the first page fails', async () => {
    fetchHtml.mockRejectedValueOnce(new Error('boom'));
    await expect(runRegionSearch(client, { location: 'x' }, region, 1000)).rejects.toThrow('boom');
  });
  it('stops after page 1 when the total is over the split threshold', async () => {
    fetchHtml.mockResolvedValueOnce(page([listing(1, 1)], 5000));
    const { meta } = await runRegionSearch(client, { location: 'x' }, region, 1000, { splitAbove: 400 });
    expect(meta).toMatchObject({ stop_reason: 'over_split_threshold', pages_fetched: 1, truncated: true });
  });
  it('sweep splits a big tile after one request and survives a failing tile', async () => {
    fetchHtml.mockResolvedValueOnce(page([listing(999, 1)], 1)); // resolve
    fetchHtml.mockResolvedValueOnce(page([listing(1, 1)], 5000)); // root: over cap -> split after 1 page
    fetchHtml.mockRejectedValueOnce(new Error('bridge timeout')); // child 0 fails on page 1
    for (const ids of [[11], [12], [13]]) fetchHtml.mockResolvedValueOnce(page(ids.map((z) => listing(z, 600_000)), 1)).mockResolvedValueOnce(page([], 1));
    const s = await sweepArea(client, { location: 'San Jose, CA', delay_ms: 0 });
    expect(s.split_tiles).toBe(1);
    expect(s.complete).toBe(false);
    expect(s.tile_errors?.[0]).toMatchObject({ id: 't0' });
    expect(s.unique_listings).toBe(3);
  });
});

describe('sweep request budget is a hard limit', () => {
  const forty = (base: number) => Array.from({ length: 40 }, (_, i) => listing(base + i + 1, 700_000));
  it('runRegionSearch stops at maxPages with a budget stop reason', async () => {
    fetchHtml.mockResolvedValueOnce(page(forty(0), 900)).mockResolvedValueOnce(page(forty(40), 900)).mockResolvedValueOnce(page(forty(80), 900));
    const { results, meta } = await runRegionSearch(client, { location: 'x' }, region, 1000, { maxPages: 2 });
    expect(fetchHtml).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(80);
    expect(meta).toMatchObject({ stop_reason: 'budget', pages_fetched: 2, truncated: true });
  });
  it('a deep max-depth tile cannot overrun max_requests', async () => {
    fetchHtml.mockResolvedValueOnce(page([listing(999, 1)], 1)); // resolve
    for (let p = 0; p < 10; p++) fetchHtml.mockResolvedValueOnce(page(forty(p * 40), 900));
    const s = await sweepArea(client, { location: 'San Jose, CA', delay_ms: 0, max_depth: 0, max_requests: 3 });
    expect(fetchHtml).toHaveBeenCalledTimes(3);
    expect(s.requests).toBe(3);
    expect(s.budget_hit).toBe(true);
    expect(s.complete).toBe(false);
  });
  it('a tile that exactly uses up the budget without truncation is not a budget hit', async () => {
    fetchHtml.mockResolvedValueOnce(page([listing(999, 1)], 1)); // resolve
    fetchHtml.mockResolvedValueOnce(page(forty(0), 80)).mockResolvedValueOnce(page(forty(40), 80));
    const s = await sweepArea(client, { location: 'San Jose, CA', delay_ms: 0, max_depth: 0, max_requests: 3 }); // resolve + 2 pages
    expect(s.requests).toBe(3);
    expect(s.unique_listings).toBe(80);
    expect(s.budget_hit).toBe(false);
    expect(s.complete).toBe(true);
  });
});

describe('sweep delay applies between every request', () => {
  it('runRegionSearch pauses delayMs between pages of one tile', async () => {
    vi.useFakeTimers();
    const p1 = Array.from({ length: 40 }, (_, i) => listing(i + 1, 700_000));
    fetchHtml.mockResolvedValueOnce(page(p1, 41)).mockResolvedValueOnce(page([listing(41, 1)], 41)).mockResolvedValueOnce(page([], 41));
    const run = runRegionSearch(client, { location: 'x' }, region, 1000, { delayMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchHtml).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchHtml).toHaveBeenCalledTimes(3);
    const { meta } = await run;
    expect(meta.pages_fetched).toBe(3);
  });
});

describe('sweep output_path validation', () => {
  it('rejects a relative path before any request', async () => {
    await expect(sweepArea(client, { location: 'San Jose, CA', delay_ms: 0, output_path: 'out/z.json' })).rejects.toThrow(/absolute/);
    expect(fetchHtml).not.toHaveBeenCalled();
  });
  it('rejects a path without a .json extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    await expect(sweepArea(client, { location: 'San Jose, CA', delay_ms: 0, output_path: join(dir, '.bashrc') })).rejects.toThrow(/\.json/);
    expect(fetchHtml).not.toHaveBeenCalled();
  });
  it('refuses to overwrite an existing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    const out = join(dir, 'z.json');
    writeFileSync(out, 'keep me');
    await expect(sweepArea(client, { location: 'San Jose, CA', delay_ms: 0, output_path: out })).rejects.toThrow(/already exists/);
    expect(readFileSync(out, 'utf8')).toBe('keep me');
    expect(fetchHtml).not.toHaveBeenCalled();
  });
});
