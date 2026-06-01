import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSessionTools as registerSharedSessionTools } from '@chrischall/mcp-utils/session';
import type { SessionRegistry } from '../sessions.js';

/**
 * MCP tool surface for the session registry (`src/sessions.ts`).
 *
 * - `zillow_register_session` — adds (or refreshes) an authenticated
 *   session. (Issue #47.)
 * - `zillow_set_active_session` — explicitly switch which session
 *   subsequent calls route through. (Issue #47.)
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
  registerSharedSessionTools(server, registry, {
    prefix: 'zillow',
    serviceLabel: 'Zillow',
  });
}
