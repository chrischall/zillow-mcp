import type { McpServer } from '@modelcontextprotocol/server';
import { registerSessionTools as registerSharedSessionTools } from '@chrischall/mcp-utils/session';
import type { SessionRegistry } from '../sessions.js';

/**
 * MCP tool surface for the session registry (`src/sessions.ts`).
 *
 * - `zillow_register_session` — adds (or refreshes) an authenticated
 *   session. (Issue #47.)
 * - `zillow_set_active_session` — mark which registered session is the
 *   current account label (label only — see `routing` below). (Issue #47.)
 * - `zillow_get_session_context` — returns the full registry plus
 *   `active_session_id`. (Issue #48.)
 *
 * Tools that touch account-scoped data (`zillow_get_saved_homes`,
 * `zillow_get_saved_searches`) accept an optional `session_id`
 * parameter — wired through their own registrations in saved.ts.
 *
 * The trio is the fleet-shared `registerSessionTools` from
 * `@chrischall/mcp-utils/session`, bound to the `zillow` prefix. It's
 * wrapped here (rather than called directly in index.ts) so the
 * `zillow`-specific prefix lives in one place and the existing
 * `(server, registry)` call sites stay unchanged.
 */
export function registerSessionTools(
  server: McpServer,
  registry: SessionRegistry
): void {
  registerSharedSessionTools(withAdditiveSessionWrites(server), registry, {
    prefix: 'zillow',
    serviceLabel: 'Zillow',
    // Nothing in zillow-mcp reads the registry to route a request — every
    // call rides the one bound browser tab — so the descriptions must not
    // promise routing (fleet-audit#1092).
    routing: 'label-only',
    labelOnlyNote:
      'Every zillow tool call goes through whichever browser tab the ContextMint Bridge ' +
      'extension is signed into; to read a different account, sign that tab into it.',
  });
}

/**
 * The two session writes, classified by the inverse test. The shared
 * registrar (mcp-utils 3.0.0) sets `readOnlyHint: false` but no
 * `destructiveHint`, which the spec defaults to TRUE — so both were
 * published as destructive. Neither is: they touch only the process-local,
 * label-only registry (nothing routes on it, nothing reaches another person,
 * a restart clears it), and the one piece of prior state either replaces —
 * which session is active — is restored by `zillow_set_active_session`.
 */
const ADDITIVE_SESSION_WRITES = new Set([
  'zillow_register_session',
  'zillow_set_active_session',
]);

/**
 * A view of `server` whose `registerTool` adds `destructiveHint: false` to
 * the session writes above and passes everything else through untouched.
 */
function withAdditiveSessionWrites(server: McpServer): McpServer {
  const registerTool = ((
    name: string,
    config: { annotations?: Record<string, unknown> },
    cb: unknown
  ) =>
    (server.registerTool as (n: string, c: unknown, f: unknown) => unknown)(
      name,
      ADDITIVE_SESSION_WRITES.has(name)
        ? { ...config, annotations: { ...config.annotations, destructiveHint: false } }
        : config,
      cb
    )) as McpServer['registerTool'];
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool') return registerTool;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
