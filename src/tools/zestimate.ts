import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { fetchPropertyRecord } from './properties.js';

/**
 * Zillow embeds Zestimate history inside the property record under
 * either:
 *   - `homeValueChartData` (array of `{ points: [...] }` series), OR
 *   - `priceHistory` (the price-change feed; superset of estimates).
 *
 * For the v0 surface we expose the cleaner homeValueChartData if
 * present, falling back to a derived series from priceHistory.
 *
 * The record is fetched through the shared `fetchPropertyRecord` (the SSR
 * `/homedetails/` scrape) — the same source every other property tool
 * uses, so the chart fields arrive on the one `__NEXT_DATA__` property
 * object without a second fetch.
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
      title: 'Get Zestimate history for a property',
      description:
        "Historical Zestimate values for a property by zpid or homedetails URL. Returns a time series of {date, value, rent?} entries (rent included when Zillow has a rent Zestimate for the property). Note: zillow_get_property returns only the *current* Zestimate as a scalar — call this tool when you need the trend. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get Zestimate history for a property',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        zpid: z
          .union([z.number().int().positive(), z.string()])
          .optional()
          .describe('Zillow Property ID. Provide either zpid or url.'),
        url: z
          .string()
          .optional()
          .describe(
            'Zillow homedetails URL (or path). Provide either zpid or url.'
          ),
      },
    },
    async ({ zpid, url }) => {
      if (zpid === undefined && !url) {
        throw new Error(
          'zillow_get_zestimate_history: must provide either zpid or url'
        );
      }
      const { raw } = await fetchPropertyRecord(client, { zpid, url });
      const series = extractZestimateHistory(raw as RawPropertyWithCharts);
      return textResult({
        zpid: String(raw.zpid ?? zpid ?? ''),
        points: series,
      });
    }
  );
}
