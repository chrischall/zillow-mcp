import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import {
  extractZestimateHistory,
  registerZestimateTools,
} from '../../src/tools/zestimate.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
// `zillow_get_zestimate_history` now routes through the shared
// `fetchPropertyRecord`, which tries the inline GraphQL POST first
// (issue #99) and falls back to the SSR scrape. The SSR-path tests
// below stub `fetchJson` to reject so the fallback is exercised; the
// GraphQL-path test lets it succeed.
const mockFetchJson = vi.fn();
const mockClient = {
  fetchHtml: mockFetchHtml,
  fetchJson: mockFetchJson,
} as unknown as ZillowClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => {
  vi.clearAllMocks();
  mockFetchJson.mockRejectedValue(new Error('graphql disabled in this test'));
});
afterAll(async () => {
  if (harness) await harness.close();
});

function htmlWithCharts(
  charts: unknown,
  rentCharts?: unknown,
  zpid: number = 12345
): string {
  const cache = {
    [`Property:${zpid}`]: {
      property: {
        zpid,
        homeValueChartData: charts,
        ...(rentCharts !== undefined ? { rentValueChartData: rentCharts } : {}),
      },
    },
  };
  const nextData = {
    props: { pageProps: { gdpClientCache: JSON.stringify(cache) } },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData
  )}</script>`;
}

describe('extractZestimateHistory', () => {
  it('extracts {date, value} from homeValueChartData[].points (x ms, y val)', () => {
    const points = extractZestimateHistory({
      homeValueChartData: [
        {
          name: 'This home',
          points: [
            { x: Date.parse('2024-01-01'), y: 100 },
            { x: Date.parse('2024-02-01'), y: 110 },
          ],
        },
      ],
    });
    expect(points).toEqual([
      { date: '2024-01-01', value: 100 },
      { date: '2024-02-01', value: 110 },
    ]);
  });

  it('attaches rent values when rentValueChartData matches the date', () => {
    const points = extractZestimateHistory({
      homeValueChartData: [
        {
          name: 'This home',
          points: [{ x: Date.parse('2024-01-01'), y: 100 }],
        },
      ],
      rentValueChartData: [
        {
          name: 'This home',
          points: [{ x: Date.parse('2024-01-01'), y: 3 }],
        },
      ],
    });
    expect(points).toEqual([{ date: '2024-01-01', value: 100, rent: 3 }]);
  });

  it('prefers the "This home" series when multiple exist', () => {
    const points = extractZestimateHistory({
      homeValueChartData: [
        {
          name: 'Comparable',
          points: [{ x: Date.parse('2024-01-01'), y: 999 }],
        },
        {
          name: 'This home',
          points: [{ x: Date.parse('2024-01-01'), y: 100 }],
        },
      ],
    });
    expect(points).toEqual([{ date: '2024-01-01', value: 100 }]);
  });

  it('accepts the {date, value} point format alongside {x, y}', () => {
    const points = extractZestimateHistory({
      homeValueChartData: [
        {
          name: 'This home',
          points: [{ date: '2024-03-01', value: 750_000 }],
        },
      ],
    });
    expect(points).toEqual([{ date: '2024-03-01', value: 750_000 }]);
  });

  it('drops malformed points (missing date or value)', () => {
    const points = extractZestimateHistory({
      homeValueChartData: [
        {
          name: 'This home',
          points: [
            { x: Date.parse('2024-01-01'), y: 100 },
            { x: Date.parse('2024-02-01') }, // missing y
            { y: 110 }, // missing x AND date
          ],
        },
      ],
    });
    expect(points).toEqual([{ date: '2024-01-01', value: 100 }]);
  });

  it('falls back to priceHistory when chart data is absent', () => {
    const points = extractZestimateHistory({
      priceHistory: [
        { date: '2023-01-01', price: 500_000, event: 'Listed for sale' },
        { date: '2024-01-01', price: 525_000, event: 'Listing price changed' },
      ],
    });
    expect(points).toEqual([
      { date: '2023-01-01', value: 500_000 },
      { date: '2024-01-01', value: 525_000 },
    ]);
  });

  it('falls back to priceHistory when homeValueChartData is present but empty', () => {
    const points = extractZestimateHistory({
      homeValueChartData: [],
      priceHistory: [{ date: '2023-06-01', price: 600_000 }],
    });
    expect(points).toEqual([{ date: '2023-06-01', value: 600_000 }]);
  });

  it('returns [] when neither source is available', () => {
    expect(extractZestimateHistory({})).toEqual([]);
  });
});

describe('zillow_get_zestimate_history tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerZestimateTools(server, mockClient)
    );
  });

  it('errors when property data is absent from the page', async () => {
    mockFetchHtml.mockResolvedValue(
      '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>'
    );
    const result = await harness.callTool('zillow_get_zestimate_history', {
      zpid: 999,
    });
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/Could not locate property/i);
  });

  it('fetches the homedetails page and returns the series', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWithCharts([
        {
          name: 'This home',
          points: [{ x: Date.parse('2024-06-01'), y: 800_000 }],
        },
      ])
    );
    const result = await harness.callTool('zillow_get_zestimate_history', {
      zpid: 12345,
    });
    expect(result.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/homedetails/12345_zpid/');
    const parsed = parseToolResult<{
      zpid: string;
      points: { date: string; value: number }[];
    }>(result);
    expect(parsed.zpid).toBe('12345');
    expect(parsed.points).toEqual([{ date: '2024-06-01', value: 800_000 }]);
  });

  it('accepts a url instead of zpid (parity with zillow_get_property)', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWithCharts([
        {
          name: 'This home',
          points: [{ x: Date.parse('2024-06-01'), y: 1_000_000 }],
        },
      ])
    );
    await harness.callTool('zillow_get_zestimate_history', {
      url: 'https://www.zillow.com/homedetails/main-st/77_zpid/',
    });
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/homedetails/main-st/77_zpid/');
  });

  it('errors when neither zpid nor url is provided', async () => {
    const result = await harness.callTool('zillow_get_zestimate_history', {});
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/zpid or url/i);
  });

  // The history tool now shares the GraphQL-first `fetchPropertyRecord`,
  // so the chart series MUST flow through the GraphQL arm (not just SSR).
  // Here GraphQL SUCCEEDS and the SSR scrape is never reached.
  it('returns the series via the GraphQL path (no SSR fallback)', async () => {
    mockFetchJson.mockReset();
    mockFetchJson.mockResolvedValueOnce({
      data: {
        property: {
          zpid: 12345,
          homeValueChartData: [
            {
              name: 'This home',
              points: [{ x: Date.parse('2024-06-01'), y: 800_000 }],
            },
          ],
          rentValueChartData: [
            {
              name: 'This home',
              points: [{ x: Date.parse('2024-06-01'), y: 3_200 }],
            },
          ],
        },
      },
    });
    const result = await harness.callTool('zillow_get_zestimate_history', {
      zpid: 12345,
    });
    expect(result.isError).toBeFalsy();
    // GraphQL served it — the SSR scrape was never reached.
    expect(mockFetchHtml).not.toHaveBeenCalled();
    const parsed = parseToolResult<{
      zpid: string;
      points: { date: string; value: number; rent?: number }[];
    }>(result);
    expect(parsed.zpid).toBe('12345');
    expect(parsed.points).toEqual([
      { date: '2024-06-01', value: 800_000, rent: 3_200 },
    ]);
  });

  // Bug #1 transparency: an empty series should say WHY.
  it('adds an SSR-omission note when neither chart data nor priceHistory is present', async () => {
    // htmlWithCharts(undefined) → property has no homeValueChartData key
    // and no priceHistory (the lean ForSalePriorityQuery shape).
    mockFetchHtml.mockResolvedValueOnce(htmlWithCharts(undefined));
    const result = await harness.callTool('zillow_get_zestimate_history', {
      zpid: 12345,
    });
    const parsed = parseToolResult<{ points: unknown[]; note?: string }>(result);
    expect(parsed.points).toEqual([]);
    expect(parsed.note).toMatch(/server-rendered/i);
    expect(parsed.note).toMatch(/Zestimate history/);
  });

  it('notes a genuine empty when chart data is present but empty', async () => {
    mockFetchHtml.mockResolvedValueOnce(htmlWithCharts([]));
    const result = await harness.callTool('zillow_get_zestimate_history', {
      zpid: 12345,
    });
    const parsed = parseToolResult<{ points: unknown[]; note?: string }>(result);
    expect(parsed.points).toEqual([]);
    expect(parsed.note).toMatch(/no Zestimate history on record/i);
  });
});
