import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ZillowClient } from '../src/client.js';
import { buildTools } from '../src/registrars.js';
import { SessionRegistry } from '../src/sessions.js';
import { createTestHarness } from './helpers.js';

/**
 * Context-group hints (`_meta.mint`, mcp-host spec 2026-11-03 D4), asserted on
 * `tools/list` — what a host sees — for the exact registrar list index.ts
 * serves, so a new tool cannot skip the decision.
 */
type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: unknown[]; description?: string }> };
  _meta?: { mint?: Record<string, unknown> };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

const mockFetchHtml = vi.fn();
const client = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

async function harness() {
  const sessions = new SessionRegistry();
  return createTestHarness((server) => {
    for (const register of buildTools(sessions)) register(server, client);
  });
}

async function served(): Promise<Listed[]> {
  const h = await harness();
  const { tools } = await h.client.listTools();
  await h.close();
  return tools as Listed[];
}

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  zillow_search_properties: 'lookup',
  zillow_sweep_area: 'lookup',
  zillow_get_property: 'lookup',
  zillow_get_by_address: 'lookup',
  zillow_resolve_addresses: 'lookup',
  zillow_bulk_get: 'lookup',
  zillow_get_property_photos: 'lookup',
  zillow_get_zestimate_history: 'lookup',
  zillow_get_price_history: 'lookup',
  zillow_get_tax_history: 'lookup',
  zillow_compare_properties: 'lookup',
  zillow_get_saved_searches: 'whats-new',
  zillow_get_saved_homes: 'lookup',
  zillow_get_market_report: 'lookup',
  zillow_calculate_mortgage: 'other',
  zillow_calculate_affordability: 'other',
  zillow_estimate_rent_vs_buy: 'other',
  zillow_register_session: 'other',
  zillow_set_active_session: 'other',
  zillow_get_session_context: 'lookup',
};

beforeEach(() => vi.clearAllMocks());

describe('_meta.mint on tools/list', () => {
  it('names every served tool, so a new tool cannot skip the decision', async () => {
    const names = (await served()).map((t) => t.name).filter((n) => !n.endsWith('_healthcheck'));
    expect(names.sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it('every tool except the healthcheck is in the home group with the expected intent', async () => {
    const tools = await served();
    for (const t of tools) {
      if (t.name.endsWith('_healthcheck')) {
        // Registered by mcp-utils, which takes no _meta: it joins no group (spec D4).
        expect(t._meta?.mint, t.name).toBeUndefined();
        continue;
      }
      const m = t._meta?.mint;
      expect(m, t.name).toBeDefined();
      expect(m!.domain, t.name).toBe('home');
      expect(m!.intent, t.name).toBe(EXPECTED_INTENT[t.name]);
    }
  });

  it('every hint is shaped per the host contract', async () => {
    for (const t of await served()) {
      const m = t._meta?.mint;
      if (!m) continue;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(m).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(m.domain);
      expect(INTENTS, t.name).toContain(m.intent);
      if ('canonical' in m) expect(m.canonical, t.name).toBe(true);
      if ('subject' in m) {
        expect(typeof m.subject, t.name).toBe('string');
        expect(props, t.name).toHaveProperty(m.subject as string);
      }
      if ('when' in m) {
        const when = m.when as Record<string, string>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start);
        expect(props, t.name).toHaveProperty(when.end);
      }
      if ('aliases' in m) {
        const aliases = m.aliases as string[];
        expect(aliases.length, t.name).toBeGreaterThan(0);
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
        }
      }
    }
  });

  it('canonical only on read-only whats-new/due/on reads, at most one per intent', async () => {
    const canonical = (await served()).filter((t) => t._meta?.mint?.canonical === true);
    const perIntent = new Map<string, number>();
    for (const t of canonical) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(CANONICAL_INTENTS, t.name).toContain(t._meta!.mint!.intent);
      const intent = t._meta!.mint!.intent as string;
      perIntent.set(intent, (perIntent.get(intent) ?? 0) + 1);
    }
    for (const [intent, n] of perIntent) expect(n, intent).toBeLessThanOrEqual(1);
    expect(canonical.map((t) => [t.name, t._meta!.mint!.intent])).toEqual([
      ['zillow_get_saved_searches', 'whats-new'],
    ]);
  });

  it('saved searches: canonical whats-new, no subject (nothing listable), no range, a brief view', async () => {
    const t = (await served()).find((x) => x.name === 'zillow_get_saved_searches')!;
    expect(t._meta?.mint).toEqual({
      domain: 'home',
      intent: 'whats-new',
      canonical: true,
      aliases: ['new listings', 'saved searches', 'house hunting', 'homes for sale'],
    });
    expect(t.inputSchema.properties?.view?.enum).toEqual(['full', 'brief']);
  });

  it('saved searches: the view description names every brief status briefSearchLine can emit', async () => {
    const t = (await served()).find((x) => x.name === 'zillow_get_saved_searches')!;
    const desc = t.inputSchema.properties?.view?.description ?? '';
    for (const status of ['N new', 'no new listings', 'new count unknown']) {
      expect(desc, status).toContain(status);
    }
  });
});

function htmlWith(pageProps: Record<string, unknown>): string {
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps },
  })}</script>`;
}

const BRIEF_LINE = /^.+ — (\d{4}-\d{2}-\d{2}|no date) — .+$/;

describe('canonical reads answer view: brief', () => {
  it('every canonical read accepts view: brief and answers one shaped line per item ≤ 120 chars', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({
        savedSearches: [
          { id: 1, name: 'Lakeside 3 bed', newCount: 4, updatedAt: '2026-10-30T14:00:00Z', searchQueryState: {} },
          { id: 2, name: 'Downtown condos', newCount: 0, searchQueryState: {} },
          { id: 3, name: 'x'.repeat(200), updatedAt: 1793404800000, filterState: {} },
        ],
      }),
    );
    const h = await harness();
    const { tools } = await h.client.listTools();
    const canonical = (tools as Listed[]).filter((t) => t._meta?.mint?.canonical === true);
    expect(canonical.length).toBeGreaterThan(0);
    for (const t of canonical) {
      const result = await h.callTool(t.name, { view: 'brief' });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const lines = text.split('\n');
      expect(lines, t.name).toHaveLength(3);
      for (const line of lines) {
        expect(line.length, line).toBeLessThanOrEqual(120);
        expect(line, line).toMatch(BRIEF_LINE);
      }
    }
    await h.close();
  });

  it('saved searches brief lines name the search, its last update and the new-listing count', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({
        savedSearches: [
          { id: 1, name: 'Lakeside 3 bed', newCount: 4, updatedAt: '2026-10-30T14:00:00Z', searchQueryState: {} },
          { id: 2, name: 'Downtown condos', newCount: 0, searchQueryState: {} },
          { id: 3, updatedAt: 'not a date', filterState: {} },
        ],
      }),
    );
    const h = await harness();
    const result = await h.callTool('zillow_get_saved_searches', { view: 'brief' });
    await h.close();
    expect((result.content as Array<{ text: string }>)[0].text.split('\n')).toEqual([
      'Lakeside 3 bed — 2026-10-30 — 4 new',
      'Downtown condos — no date — no new listings',
      '(unnamed search) — no date — new count unknown',
    ]);
  });

  it('an empty saved-search list answers an empty brief, not an error', async () => {
    mockFetchHtml.mockResolvedValue(htmlWith({ savedSearches: [] }));
    const h = await harness();
    const result = await h.callTool('zillow_get_saved_searches', { view: 'brief' });
    await h.close();
    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text: string }>)[0].text).toBe('');
  });

  it('view omitted keeps the full JSON answer', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({ savedSearches: [{ id: 1, name: 'Lakeside 3 bed', newCount: 4, searchQueryState: {} }] }),
    );
    const h = await harness();
    const result = await h.callTool('zillow_get_saved_searches', {});
    await h.close();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed[0]).toMatchObject({ id: '1', name: 'Lakeside 3 bed', new_count: 4 });
  });
});
