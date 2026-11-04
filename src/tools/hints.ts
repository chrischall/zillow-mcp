import type { McpServer } from '@modelcontextprotocol/server';

/**
 * Context-group hints, published on each tool as `_meta.mint` (mcp-host's
 * `mintHintSchema`, context-groups spec 2026-11-03 D4): which canonical group
 * a tool belongs to, what kind of ask it answers, and the everyday words its
 * name and description lack. Inert data: a host that does not read them sees
 * an extra `_meta` key and nothing else. The shape is fixed by the host's
 * contract, so it is restated here rather than imported — this server takes
 * no dependency on mcp-host.
 *
 * Every zillow tool is in the `home` group. Exactly one read is canonical —
 * `zillow_get_saved_searches` for `whats-new` ("anything new on my saved
 * searches?"), which is the only what's-new/due/on question Zillow answers.
 * No tool declares a `subject`: nothing here can LIST a person's subjects at
 * start (a saved search is a query, not a person, property or account), so
 * the contract's subject enum has nothing honest to publish.
 *
 * `subject` and `when` would name THIS tool's own argument names, never
 * values; `aliases` are lowercase, at most 8, each at most 40 chars.
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'home';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

/** `_meta` for a Zillow tool: every tool here is in the `home` domain. */
export function homeMeta(
  intent: MintIntent,
  extra: Omit<MintHint, 'domain' | 'intent'> = {},
): { mint: MintHint } {
  return { mint: { domain: 'home', intent, ...extra } };
}

/** What people say when they mean a listing or a property on Zillow. */
export const PROPERTY_ALIASES = ['house', 'home', 'listing', 'property', 'real estate'];

/** What people say when they mean the money side of buying a home. */
export const MONEY_ALIASES = ['mortgage', 'monthly payment', 'afford', 'home loan', 'rent or buy'];

/**
 * `_meta` for the tools registered by shared registrars that take no `_meta`
 * of their own (realty-core's calculators, mcp-utils' session trio). The
 * healthcheck is deliberately absent: it joins no group (spec D4).
 */
export const SHARED_REGISTRAR_META: Record<string, { mint: MintHint }> = {
  zillow_calculate_mortgage: homeMeta('other', { aliases: MONEY_ALIASES }),
  zillow_calculate_affordability: homeMeta('other', { aliases: MONEY_ALIASES }),
  zillow_register_session: homeMeta('other'),
  zillow_set_active_session: homeMeta('other'),
  zillow_get_session_context: homeMeta('lookup'),
};

/**
 * A view of `server` whose `registerTool` adds the `_meta` above to a tool a
 * shared registrar registers, and passes everything else through untouched.
 * A `_meta` the registrar already set is kept and the hint merged beside it.
 */
export function withSharedRegistrarMeta(server: McpServer): McpServer {
  const registerTool = ((
    name: string,
    config: { _meta?: Record<string, unknown> },
    cb: unknown,
  ) => {
    const meta = SHARED_REGISTRAR_META[name];
    return (server.registerTool as (n: string, c: unknown, f: unknown) => unknown)(
      name,
      meta ? { ...config, _meta: { ...config._meta, ...meta } } : config,
      cb,
    );
  }) as McpServer['registerTool'];
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool') return registerTool;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
