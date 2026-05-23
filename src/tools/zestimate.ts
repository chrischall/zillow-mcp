import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractNextData, getPageProps } from '../next-data.js';
import { findPropertyInPageProps } from './properties.js';

/**
 * Zillow embeds Zestimate history inside the homedetails page's
 * gdpClientCache under either:
 *   - `homeValueChartData` (array of `{ points: [...] }` series), OR
 *   - `priceHistory` (the price-change feed; superset of estimates).
 *
 * For the v0 surface we expose the cleaner homeValueChartData if
 * present, falling back to a derived series from priceHistory.
 */

export interface ZestimatePoint {
  date: string;
  value: number;
  rent?: number;
}

interface RawHomeValuePoint {
  x?: number; // unix ms
  y?: number; // value
  date?: string;
  value?: number;
}

interface RawHomeValueChart {
  points?: RawHomeValuePoint[];
  name?: string;
}

interface RawPropertyWithCharts {
  homeValueChartData?: RawHomeValueChart[];
  priceHistory?: Array<{ date?: string; price?: number; event?: string }>;
  rentValueChartData?: RawHomeValueChart[];
}

function pointsFromChart(chart: RawHomeValueChart | undefined): ZestimatePoint[] {
  if (!chart?.points) return [];
  return chart.points
    .map((p) => {
      const date =
        p.date ??
        (typeof p.x === 'number'
          ? new Date(p.x).toISOString().slice(0, 10)
          : undefined);
      const value = p.value ?? p.y;
      if (!date || typeof value !== 'number') return null;
      return { date, value };
    })
    .filter((p): p is ZestimatePoint => p !== null);
}

export function extractZestimateHistory(raw: RawPropertyWithCharts): ZestimatePoint[] {
  const this_home =
    raw.homeValueChartData?.find((c) => c.name === 'This home') ??
    raw.homeValueChartData?.[0];
  const value_points = pointsFromChart(this_home);

  if (value_points.length > 0) {
    const rent_series =
      raw.rentValueChartData?.find((c) => c.name === 'This home') ??
      raw.rentValueChartData?.[0];
    const rent_points = pointsFromChart(rent_series);
    const rent_by_date = new Map(rent_points.map((p) => [p.date, p.value]));
    return value_points.map((p) => ({
      ...p,
      ...(rent_by_date.has(p.date) ? { rent: rent_by_date.get(p.date) } : {}),
    }));
  }

  // Fallback: derive from priceHistory's listing-price events.
  if (raw.priceHistory) {
    return raw.priceHistory
      .filter((h) => typeof h.date === 'string' && typeof h.price === 'number')
      .map((h) => ({ date: h.date as string, value: h.price as number }));
  }
  return [];
}

export function registerZestimateTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_get_zestimate_history',
    {
      description:
        "Historical Zestimate values for a property, by zpid. Returns a time series of {date, value, rent?} entries. Pulls from the same homedetails page as zillow_get_property — if you've already fetched the property, you have this data too.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        zpid: z
          .union([z.number().int().positive(), z.string()])
          .describe('Zillow Property ID'),
      },
    },
    async ({ zpid }) => {
      const html = await client.fetchHtml(`/homedetails/${zpid}_zpid/`);
      const nextData = extractNextData(html);
      const pageProps = getPageProps(nextData);
      const property = findPropertyInPageProps(pageProps);
      if (!property) {
        throw new Error(
          `Could not locate property data in __NEXT_DATA__ for zpid=${zpid}.`
        );
      }
      const series = extractZestimateHistory(property as RawPropertyWithCharts);
      return textResult({ zpid: String(zpid), points: series });
    }
  );
}
