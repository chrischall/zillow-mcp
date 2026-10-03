import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ZillowClient } from '../../src/client.js';
import { registerGetByAddressTools } from '../../src/tools/get-by-address.js';
import { registerResolveAddressesTools } from '../../src/tools/resolve-addresses.js';
import {
  loadLocalityAliases,
  DEFAULT_LOCALITY_ALIASES,
} from '../../src/tools/resolver.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

// Issue #75: locality remap. When the caller-supplied city fails, the
// resolver should (a) retry with city dropped (street + state + zip
// only) and (b) substitute known city aliases (Lake Lure ↔ Rutherfordton).

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

let single: Awaited<ReturnType<typeof createTestHarness>>;
let bulk: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (single) await single.close();
  if (bulk) await bulk.close();
});

const EMPTY_HTML =
  '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchPageState":{"cat1":{"searchResults":{"listResults":[]}}}}}}</script>';

function htmlListing(args: {
  zpid: number;
  streetAddress: string;
  city: string;
  state: string;
  zip: string;
}): string {
  const nextData = {
    props: {
      pageProps: {
        searchPageState: {
          queryState: { regionSelection: [], mapBounds: null },
          cat1: {
            searchResults: {
              listResults: [
                {
                  zpid: args.zpid,
                  detailUrl: `/homedetails/${args.zpid}_zpid/`,
                  hdpData: {
                    homeInfo: {
                      zpid: args.zpid,
                      streetAddress: args.streetAddress,
                      city: args.city,
                      state: args.state,
                      zipcode: args.zip,
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

const aliasesOf = (city: string, state = 'NC'): string[] =>
  loadLocalityAliases().lookup({ city, state }).aliases;

describe('locality alias defaults', () => {
  it('ships with Lake Lure ↔ Rutherfordton (issue #81 #75)', () => {
    expect(aliasesOf('Lake Lure')).toContain('Rutherfordton');
    expect(aliasesOf('Rutherfordton')).toContain('Lake Lure');
  });

  it('ships with Beech Mountain ↔ Banner Elk and Sugar Mountain ↔ Banner Elk', () => {
    expect(aliasesOf('Beech Mountain')).toContain('Banner Elk');
    expect(aliasesOf('Sugar Mountain')).toContain('Banner Elk');
    // Registered both ways, partners collected in order.
    expect(aliasesOf('Banner Elk')).toEqual(['Beech Mountain', 'Sugar Mountain']);
  });

  it('matches the city case-insensitively and in any state (pairs are state-less)', () => {
    expect(aliasesOf('LAKE LURE', 'SC')).toEqual(['Rutherfordton']);
    expect(loadLocalityAliases().lookup({ city: 'lake lure', state: '' }).aliases).toEqual([
      'Rutherfordton',
    ]);
  });

  it('exports the defaults as a constant', () => {
    expect(DEFAULT_LOCALITY_ALIASES).toBeDefined();
    expect(Array.isArray(DEFAULT_LOCALITY_ALIASES)).toBe(true);
  });
});

describe('ZILLOW_LOCALITY_ALIASES_FILE (documented [a, b] pair format)', () => {
  const ENV = 'ZILLOW_LOCALITY_ALIASES_FILE';
  let dir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zillow-aliases-'));
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env[ENV];
    loadLocalityAliases(); // unset env resets the cache
    errSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const writeAliases = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  it('loads the documented pair format, both ways, replacing the defaults', () => {
    process.env[ENV] = writeAliases(
      'a.json',
      JSON.stringify([
        ['Lake Lure', 'Chimney Rock'],
        ['Hilton Head', 'Bluffton'],
      ])
    );
    expect(aliasesOf('Lake Lure')).toEqual(['Chimney Rock']);
    expect(aliasesOf('Chimney Rock')).toEqual(['Lake Lure']);
    expect(aliasesOf('hilton head', 'SC')).toEqual(['Bluffton']);
    expect(aliasesOf('Beech Mountain')).toEqual([]); // overrides, not merges
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('de-duplicates partners of a shared city in file order', () => {
    process.env[ENV] = writeAliases(
      'b.json',
      JSON.stringify([
        ['A', 'Hub'],
        ['B', 'Hub'],
        ['A', 'Hub'],
      ])
    );
    expect(aliasesOf('Hub')).toEqual(['A', 'B']);
    expect(aliasesOf('A')).toEqual(['Hub']);
  });

  it('caches a successful load and re-reads only when the path changes', () => {
    const first = writeAliases('c1.json', JSON.stringify([['X', 'Y']]));
    process.env[ENV] = first;
    expect(aliasesOf('X')).toEqual(['Y']);
    writeFileSync(first, JSON.stringify([['X', 'Z']]));
    expect(aliasesOf('X')).toEqual(['Y']); // cached
    process.env[ENV] = writeAliases('c2.json', JSON.stringify([['X', 'Z']]));
    expect(aliasesOf('X')).toEqual(['Z']);
  });

  it('falls back to the defaults (once-logged) when the file is missing', () => {
    process.env[ENV] = join(dir, 'nope.json');
    expect(aliasesOf('Lake Lure')).toEqual(['Rutherfordton']);
    expect(aliasesOf('Lake Lure')).toEqual(['Rutherfordton']);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toMatch(/not found — falling back to DEFAULT_LOCALITY_ALIASES/);
  });

  it('falls back to the defaults when a pair is malformed', () => {
    process.env[ENV] = writeAliases('bad.json', JSON.stringify([['Lake Lure', 'A', 'B']]));
    expect(aliasesOf('Lake Lure')).toEqual(['Rutherfordton']);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toMatch(/\[0\] must be a \[string, string\] pair/);
  });

  it('falls back to the defaults on invalid JSON', () => {
    process.env[ENV] = writeAliases('junk.json', '{not json');
    expect(aliasesOf('Lake Lure')).toEqual(['Rutherfordton']);
    expect(String(errSpy.mock.calls[0][0])).toMatch(/failed to load ZILLOW_LOCALITY_ALIASES_FILE/);
  });
});

describe('city-drop rung (issue #75)', () => {
  it('setup', async () => {
    single = await createTestHarness((s) => registerGetByAddressTools(s, mockClient));
    bulk = await createTestHarness((s) => registerResolveAddressesTools(s, mockClient));
  });

  it('resolves when the supplied city is wrong but {street, state, zip} hits', async () => {
    // First two calls (direct + suffix-expansion variant) miss because
    // the supplied city "Lake Lure" yields nothing; the city-drop rung
    // hits because the Rutherfordton listing is keyed off the zip.
    mockFetchHtml.mockImplementation(async (path: string) => {
      const decoded = decodeURIComponent(path).toLowerCase();
      // Returns the listing ONLY when the slug has no "lake lure" in it.
      if (decoded.includes('lake lure')) return EMPTY_HTML;
      if (decoded.includes('212 ridgeway')) {
        return htmlListing({
          zpid: 8100,
          streetAddress: '212 Ridgeway Rd',
          city: 'Rutherfordton',
          state: 'NC',
          zip: '28746',
        });
      }
      return EMPTY_HTML;
    });

    const r = await single.callTool('zillow_get_by_address', {
      address: '212 Ridgeway Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<{
      resolved: boolean;
      zpid?: string;
      city?: string;
      via?: string;
    }>(r);
    expect(parsed.resolved).toBe(true);
    expect(parsed.zpid).toBe('8100');
    expect(parsed.city).toBe('Rutherfordton');
  });

  it('bulk: surfaces queried_city + resolved_city on a remapped row', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => {
      const decoded = decodeURIComponent(path).toLowerCase();
      if (decoded.includes('lake lure')) return EMPTY_HTML;
      if (decoded.includes('212 ridgeway')) {
        return htmlListing({
          zpid: 8100,
          streetAddress: '212 Ridgeway Rd',
          city: 'Rutherfordton',
          state: 'NC',
          zip: '28746',
        });
      }
      return EMPTY_HTML;
    });

    const r = await bulk.callTool('zillow_resolve_addresses', {
      addresses: [
        {
          address: '212 Ridgeway Rd',
          city: 'Lake Lure',
          state: 'NC',
          zip: '28746',
        },
      ],
    });
    const parsed = parseToolResult<{
      results: Array<{
        resolved: boolean;
        queried_city?: string;
        resolved_city?: string;
      }>;
    }>(r);
    expect(parsed.results[0].resolved).toBe(true);
    expect(parsed.results[0].queried_city).toBe('Lake Lure');
    expect(parsed.results[0].resolved_city).toBe('Rutherfordton');
  });
});

describe('locality alias rung (issue #75)', () => {
  it('substitutes a known alias (Lake Lure → Rutherfordton)', async () => {
    // Slug contains a "Lake Lure" word → empty. Slug contains
    // "Rutherfordton" → the listing.
    mockFetchHtml.mockImplementation(async (path: string) => {
      const decoded = decodeURIComponent(path).toLowerCase();
      if (decoded.includes('rutherfordton') && decoded.includes('212 ridgeway')) {
        return htmlListing({
          zpid: 9100,
          streetAddress: '212 Ridgeway Rd',
          city: 'Rutherfordton',
          state: 'NC',
          zip: '28139',
        });
      }
      return EMPTY_HTML;
    });

    const r = await single.callTool('zillow_get_by_address', {
      address: '212 Ridgeway Rd',
      city: 'Lake Lure',
      state: 'NC',
      // Note: no zip — forces the alias rung instead of city-drop+zip.
    });
    const parsed = parseToolResult<{ resolved: boolean; zpid?: string; city?: string }>(r);
    expect(parsed.resolved).toBe(true);
    expect(parsed.zpid).toBe('9100');
    expect(parsed.city).toBe('Rutherfordton');
  });
});
