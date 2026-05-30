/**
 * In-memory registry of authenticated Zillow sessions.
 *
 * The registry itself — keyed by `session_id`, de-duped by
 * `account_identity`, with an `active_session_id` pointer and the
 * `register` / `setActive` / `resolve` / `getContext` surface — is the
 * fleet-shared `SessionRegistry` from `@chrischall/mcp-utils/session`
 * (the byte-identical implementation hoisted out of
 * zillow/redfin/compass/homes/onehome). It's re-exported here so the
 * `zillow_*` tools and tests keep importing `{ SessionRegistry }` from
 * `'../sessions.js'` unchanged.
 *
 * Today the underlying fetchproxy bridge talks to ONE signed-in browser,
 * so the routing here is largely bookkeeping — but it establishes the API
 * surface (`session_id` keys, `active_session_id`, the per-session
 * metadata shape) that the upcoming multi-browser fetchproxy support
 * will fill in. (Issues #47 / #48.)
 */
export {
  SessionRegistry,
  createSessionRegistry,
} from '@chrischall/mcp-utils/session';
export type {
  AuthMode,
  SessionToken as RegisteredSession,
  SessionContext,
} from '@chrischall/mcp-utils/session';
