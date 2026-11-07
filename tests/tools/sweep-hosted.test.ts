import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { McpToolError } from '@chrischall/mcp-utils';
import type { ZillowClient } from '../../src/client.js';
import { sweepArea, type RawListing } from '../../src/tools/search.js';

// Hosted deployments (mcp-host) share no filesystem with the caller: an
// `output_path` written to the runner's disk is unreachable. There the sweep
// file goes to the blob store as a zip behind a signed link instead.

const region = {
  regionSelection: [{ regionId: 1, regionType: 4 }],
  mapBounds: { north: 10.5, south: 10.1, east: -20.6, west: -21.2 },
};

function listing(zpid: number, price: number): RawListing {
  return {
    zpid,
    hdpData: { homeInfo: { zpid, price, bedrooms: 3, bathrooms: 2, homeType: 'CONDO', latitude: 10.3, longitude: -20.9, city: 'Exampletown', state: 'ZZ', zipcode: '00000' } },
  };
}

function page(list: RawListing[], total: number): string {
  const sps = {
    queryState: { regionSelection: region.regionSelection, mapBounds: region.mapBounds },
    cat1: { searchResults: { listResults: list }, searchList: { totalResultCount: total } },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { searchPageState: sps } } })}</script>`;
}

/** resolve call + one complete tile holding the given listings. */
function queueSweep(list: RawListing[]) {
  fetchHtml.mockResolvedValueOnce(page([listing(1, 1)], 1));
  fetchHtml.mockResolvedValueOnce(page(list, list.length)).mockResolvedValueOnce(page([], list.length));
}

/** Minimal independent unzip: central directory → inflate. */
function unzip(zip: Uint8Array): Map<string, string> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const off = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
    const raw = zip.subarray(start, start + csize);
    out.set(name, new TextDecoder().decode(method === 8 ? inflateRawSync(raw) : raw));
    p += 46 + nameLen;
  }
  return out;
}

const BASE = 'https://host.example/b/reg_0123456789abcdef01234567';
const BLOB_ENV = { MCP_BLOB_BASE_URL: BASE, MCP_BLOB_SIGNING_KEY: 'a2V5' };

const fetchHtml = vi.fn();
const client = { fetchHtml } as unknown as ZillowClient;
let outRoot: string;
let puts: Array<{ url: string; type: string; bytes: Uint8Array }>;
let putStatus: number;

beforeEach(() => {
  fetchHtml.mockReset();
  outRoot = mkdtempSync(join(tmpdir(), 'sweep-hosted-'));
  vi.stubEnv('ZILLOW_OUTPUT_DIR', outRoot);
  puts = [];
  putStatus = 201;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    puts.push({ url, type: new Headers(init!.headers).get('content-type')!, bytes: new Uint8Array(init!.body as ArrayBuffer) });
    return new Response(null, { status: putStatus });
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('sweep output_path on a hosted deployment with a blob store', () => {
  it('uploads a zip holding the named .json file and returns a signed link, never touching disk', async () => {
    queueSweep([listing(11, 600_000), listing(12, 610_000)]);
    const s = await sweepArea(client, { location: 'Exampletown, ZZ', delay_ms: 0, output_path: 'area.json' }, { env: BLOB_ENV });

    expect(puts).toHaveLength(1);
    expect(puts[0]!.url.startsWith(`${BASE}/exp/`)).toBe(true);
    expect(puts[0]!.type).toBe('application/zip');
    const files = unzip(puts[0]!.bytes);
    expect([...files.keys()]).toEqual(['area.json']);
    const file = JSON.parse(files.get('area.json')!);
    expect(file.results.map((r: { zpid: string }) => r.zpid)).toEqual(['11', '12']);
    expect(file.query).not.toHaveProperty('output_path');

    expect(s.output_url).toMatch(new RegExp(`^${BASE}/exp/.+/part-0001\\.zip\\?`));
    expect(typeof s.output_expires_at).toBe('string');
    expect(s.output_file).toBe('area.json');
    expect(s).not.toHaveProperty('output_path');
    expect(s).not.toHaveProperty('results');
    expect(s.unique_listings).toBe(2);
    // Nothing written to the runner's disk.
    expect(readdirSync(outRoot)).toEqual([]);
  });

  it('uses only the base name of an absolute or nested output_path', async () => {
    queueSweep([listing(11, 600_000)]);
    const s = await sweepArea(client, { location: 'Exampletown, ZZ', delay_ms: 0, output_path: '/somewhere/else/deep.json' }, { env: BLOB_ENV });
    expect(s.output_file).toBe('deep.json');
    expect([...unzip(puts[0]!.bytes).keys()]).toEqual(['deep.json']);
    expect(existsSync('/somewhere/else/deep.json')).toBe(false);
  });

  it('falls back to a default entry name when sanitizing loses the .json extension', async () => {
    queueSweep([listing(11, 600_000)]);
    const s = await sweepArea(client, { location: 'Exampletown, ZZ', delay_ms: 0, output_path: 'a..json' }, { env: BLOB_ENV });
    expect(s.output_file).toBe('zillow-sweep.json');
  });

  it('still rejects a non-.json output_path before any request', async () => {
    await expect(sweepArea(client, { location: 'x', delay_ms: 0, output_path: 'notes.sh' }, { env: BLOB_ENV })).rejects.toThrow(/\.json/);
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it('refuses a file over the export part limit with a too_large error', async () => {
    queueSweep([listing(11, 600_000)]);
    const err = await sweepArea(
      client,
      { location: 'Exampletown, ZZ', delay_ms: 0, output_path: 'area.json' },
      { env: BLOB_ENV, exportMaxBytes: 64 }
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('too_large');
    expect(puts).toHaveLength(0);
  });

  it('surfaces a failed upload as an error rather than a dead link', async () => {
    putStatus = 500;
    queueSweep([listing(11, 600_000)]);
    await expect(
      sweepArea(client, { location: 'Exampletown, ZZ', delay_ms: 0, output_path: 'area.json' }, { env: BLOB_ENV })
    ).rejects.toThrow();
  });
});

describe('sweep on a hosted deployment with no blob store', () => {
  const HOSTED_NO_STORE = { MCP_DATA_DIR: '/data' };

  it('refuses output_path before any request instead of writing the runner disk', async () => {
    const err = await sweepArea(client, { location: 'x', delay_ms: 0, output_path: 'area.json' }, { env: HOSTED_NO_STORE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).message).toMatch(/output_path/);
    expect((err as McpToolError).message).toMatch(/omit/i);
    expect(fetchHtml).not.toHaveBeenCalled();
    expect(readdirSync(outRoot)).toEqual([]);
  });

  it('returns results inline when they fit', async () => {
    queueSweep([listing(11, 600_000)]);
    const s = await sweepArea(client, { location: 'Exampletown, ZZ', delay_ms: 0 }, { env: HOSTED_NO_STORE });
    expect(s.results?.map((r) => r.zpid)).toEqual(['11']);
  });

  it('refuses inline results over the hosted response cap with too_large', async () => {
    queueSweep([listing(11, 600_000), listing(12, 610_000)]);
    const err = await sweepArea(client, { location: 'Exampletown, ZZ', delay_ms: 0 }, { env: HOSTED_NO_STORE, inlineMaxBytes: 200 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('too_large');
  });
});

describe('sweep inline results over the hosted cap with a blob store', () => {
  it('delivers the full set as a link instead of an oversized inline reply', async () => {
    queueSweep([listing(11, 600_000), listing(12, 610_000)]);
    const s = await sweepArea(client, { location: 'Exampletown, ZZ', delay_ms: 0 }, { env: BLOB_ENV, inlineMaxBytes: 200 });
    expect(s).not.toHaveProperty('results');
    expect(s.output_url).toMatch(/part-0001\.zip/);
    expect(s.output_file).toBe('zillow-sweep.json');
    expect(s.note).toMatch(/too large/i);
    const file = JSON.parse(unzip(puts[0]!.bytes).get('zillow-sweep.json')!);
    expect(file.results).toHaveLength(2);
  });

  it('keeps small inline results inline', async () => {
    queueSweep([listing(11, 600_000)]);
    const s = await sweepArea(client, { location: 'Exampletown, ZZ', delay_ms: 0 }, { env: BLOB_ENV });
    expect(s.results).toHaveLength(1);
    expect(puts).toHaveLength(0);
  });
});

describe('sweep locally (no hosted env) is unchanged', () => {
  it('writes output_path to disk and ignores the inline cap', async () => {
    queueSweep([listing(11, 600_000), listing(12, 610_000)]);
    const s = await sweepArea(client, { location: 'Exampletown, ZZ', delay_ms: 0, output_path: 'area.json' }, { env: {} });
    expect(s.output_path).toBe(join(outRoot, 'area.json'));
    expect(JSON.parse(readFileSync(join(outRoot, 'area.json'), 'utf8')).results).toHaveLength(2);
    expect(puts).toHaveLength(0);

    queueSweep([listing(11, 600_000), listing(12, 610_000)]);
    const inline = await sweepArea(client, { location: 'Exampletown, ZZ', delay_ms: 0 }, { env: {}, inlineMaxBytes: 10 });
    expect(inline.results).toHaveLength(2);
  });
});
