/**
 * In-memory registry of authenticated Zillow sessions. Today the
 * underlying fetchproxy bridge talks to ONE signed-in browser, so the
 * routing here is largely bookkeeping — but it establishes the API
 * surface (`session_id` keys, `active_session_id`, the per-session
 * metadata shape) that the upcoming multi-browser fetchproxy support
 * will fill in. Mirrors the model in chrischall/onehome-mcp#34.
 *
 * Sessions are keyed by signed-in account identity — re-registering the
 * same `account_identity` updates the existing entry rather than
 * creating a duplicate. (Issue #47.)
 *
 * `getSessionContext()` returns the full registry plus
 * `active_session_id`, which is what `zillow_get_session_context`
 * surfaces. (Issue #48.)
 */

import { randomUUID } from 'node:crypto';

export type AuthMode = 'browser_session' | 'unknown';

export interface RegisteredSession {
  session_id: string;
  /**
   * Caller-provided identity for the signed-in account — usually a
   * saved-account email but any opaque string the caller wants to use
   * for de-duping is fine. Tools route to a specific session by
   * matching this identity in `zillow_set_active_session` /
   * `?session_id=`. (Issue #47.)
   */
  account_identity: string;
  auth_mode: AuthMode;
  /** Whether the session is currently considered usable for tool calls. */
  auth_ready: boolean;
  /** ISO timestamp of when the session was last registered/refreshed. */
  registered_at: string;
  /** Optional ISO timestamp; null means "no known expiry" — Zillow cookies last for months. */
  auth_expires_at: string | null;
}

export interface SessionContext {
  active_session_id: string | null;
  sessions: RegisteredSession[];
}

/**
 * Per-process registry. Module-level so all tool registrations share it;
 * the constructor takes no arguments, so it's safe to instantiate per
 * test.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, RegisteredSession>();
  private activeId: string | null = null;

  /**
   * Register a new session (or refresh the existing one keyed by
   * `account_identity`). Returns the (possibly pre-existing) session_id.
   * The first registered session becomes the active session.
   */
  register(args: {
    account_identity: string;
    auth_mode?: AuthMode;
    auth_expires_at?: string | null;
  }): RegisteredSession {
    const identity = args.account_identity.trim();
    if (identity.length === 0) {
      throw new Error('register: account_identity must be non-empty.');
    }
    // De-dupe by account_identity — re-registering the same account
    // updates the existing entry in place.
    for (const existing of this.sessions.values()) {
      if (existing.account_identity === identity) {
        existing.auth_mode = args.auth_mode ?? existing.auth_mode;
        existing.auth_ready = true;
        existing.registered_at = new Date().toISOString();
        existing.auth_expires_at =
          args.auth_expires_at !== undefined
            ? args.auth_expires_at
            : existing.auth_expires_at;
        return { ...existing };
      }
    }
    const sess: RegisteredSession = {
      session_id: randomUUID(),
      account_identity: identity,
      auth_mode: args.auth_mode ?? 'browser_session',
      auth_ready: true,
      registered_at: new Date().toISOString(),
      auth_expires_at: args.auth_expires_at ?? null,
    };
    this.sessions.set(sess.session_id, sess);
    if (this.activeId === null) this.activeId = sess.session_id;
    return { ...sess };
  }

  /** Returns true on success, false if the session_id is unknown. */
  setActive(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.activeId = sessionId;
    return true;
  }

  /** Look up a session by id. */
  get(sessionId: string): RegisteredSession | null {
    const s = this.sessions.get(sessionId);
    return s ? { ...s } : null;
  }

  /** Returns a snapshot suitable for serialization. */
  context(): SessionContext {
    return {
      active_session_id: this.activeId,
      sessions: Array.from(this.sessions.values()).map((s) => ({ ...s })),
    };
  }

  /** Number of registered sessions. */
  size(): number {
    return this.sessions.size;
  }

  /** Active session id, if any. */
  activeSessionId(): string | null {
    return this.activeId;
  }

  /**
   * Resolve which session id a tool call should route through.
   * - When `requested` is set and known, returns it.
   * - When `requested` is set but unknown, throws.
   * - When `requested` is undefined, falls back to the active session.
   * - When no sessions are registered, returns null (callers should
   *   continue with the default bridge transport).
   */
  resolve(requested: string | undefined): string | null {
    if (requested !== undefined) {
      if (!this.sessions.has(requested)) {
        throw new Error(
          `Unknown session_id "${requested}". Call zillow_get_session_context to see the registered sessions.`
        );
      }
      return requested;
    }
    return this.activeId;
  }

  /** Test helper. */
  reset(): void {
    this.sessions.clear();
    this.activeId = null;
  }
}
