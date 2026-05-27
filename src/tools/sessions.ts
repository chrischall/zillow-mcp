import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '../mcp.js';
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
 */

export function registerSessionTools(
  server: McpServer,
  registry: SessionRegistry
): void {
  server.registerTool(
    'zillow_register_session',
    {
      title: 'Register a signed-in Zillow session',
      description:
        'Register (or refresh) an authenticated Zillow session keyed by signed-in account identity. ' +
        'Re-registering the same `account_identity` updates the existing session rather than creating a duplicate. ' +
        'Returns the `session_id` to use when routing per-tool calls. ' +
        'The first registered session becomes the default `active_session_id`.',
      annotations: {
        title: 'Register a signed-in Zillow session',
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        account_identity: z
          .string()
          .min(1)
          .describe(
            'Caller-supplied identifier for the signed-in account (typically the saved-account email).'
          ),
        auth_expires_at: z
          .string()
          .optional()
          .describe('Optional ISO timestamp at which the session expires.'),
      },
    },
    async ({ account_identity, auth_expires_at }) => {
      const sess = registry.register({
        account_identity,
        auth_expires_at: auth_expires_at ?? null,
      });
      return textResult({
        session: sess,
        active_session_id: registry.activeSessionId(),
      });
    }
  );

  server.registerTool(
    'zillow_set_active_session',
    {
      title: 'Set the active Zillow session',
      description:
        'Switch which registered session subsequent tool calls route through by default. ' +
        'Pass a `session_id` previously returned by `zillow_register_session`. ' +
        'Tools that accept an explicit `session_id` parameter override this default per-call.',
      annotations: {
        title: 'Set the active Zillow session',
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        session_id: z.string().min(1).describe('Session id to make active.'),
      },
    },
    async ({ session_id }) => {
      const ok = registry.setActive(session_id);
      if (!ok) {
        throw new Error(
          `Unknown session_id "${session_id}". Call zillow_get_session_context to see the registered sessions.`
        );
      }
      return textResult({
        active_session_id: registry.activeSessionId(),
        context: registry.context(),
      });
    }
  );

  server.registerTool(
    'zillow_get_session_context',
    {
      title: 'List all registered Zillow sessions',
      description:
        'Return the full set of registered sessions plus the current `active_session_id`. ' +
        'Useful for diagnostics — confirms which accounts are routable and which session is the default. ' +
        'Returns `{ active_session_id, sessions: [{ session_id, account_identity, auth_mode, auth_ready, registered_at, auth_expires_at }, ...] }`. ' +
        'When no sessions are registered, `sessions` is empty and `active_session_id` is null.',
      annotations: {
        title: 'List all registered Zillow sessions',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async () => {
      return textResult(registry.context());
    }
  );
}
