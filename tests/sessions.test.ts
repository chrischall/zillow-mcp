import { describe, it, expect, beforeEach } from 'vitest';
import { SessionRegistry } from '../src/sessions.js';

describe('SessionRegistry', () => {
  let registry: SessionRegistry;
  beforeEach(() => {
    registry = new SessionRegistry();
  });

  it('starts empty with no active session', () => {
    const ctx = registry.context();
    expect(ctx.sessions).toEqual([]);
    expect(ctx.active_session_id).toBeNull();
  });

  it('register() returns a session_id and sets the first session as active (issue #47)', () => {
    const sess = registry.register({ account_identity: 'alice@example.com' });
    expect(sess.session_id).toMatch(/[0-9a-f-]/);
    expect(sess.account_identity).toBe('alice@example.com');
    expect(sess.auth_ready).toBe(true);
    expect(registry.activeSessionId()).toBe(sess.session_id);
  });

  it('register() keeps the existing session_id when re-registering the same account_identity (issue #47)', () => {
    const a = registry.register({ account_identity: 'alice@example.com' });
    const b = registry.register({ account_identity: 'alice@example.com' });
    expect(b.session_id).toBe(a.session_id);
    expect(registry.size()).toBe(1);
  });

  it('register() creates distinct sessions for different account identities', () => {
    const a = registry.register({ account_identity: 'alice@example.com' });
    const b = registry.register({ account_identity: 'bob@example.com' });
    expect(a.session_id).not.toBe(b.session_id);
    expect(registry.size()).toBe(2);
    // First one stays active
    expect(registry.activeSessionId()).toBe(a.session_id);
  });

  it('setActive() switches the active session', () => {
    const a = registry.register({ account_identity: 'a' });
    const b = registry.register({ account_identity: 'b' });
    expect(registry.setActive(b.session_id)).toBe(true);
    expect(registry.activeSessionId()).toBe(b.session_id);
    // Switching back
    expect(registry.setActive(a.session_id)).toBe(true);
    expect(registry.activeSessionId()).toBe(a.session_id);
  });

  it('setActive() returns false for unknown ids', () => {
    expect(registry.setActive('nope')).toBe(false);
  });

  it('context() returns all sessions + active_session_id (issue #48)', () => {
    const a = registry.register({ account_identity: 'a' });
    const b = registry.register({ account_identity: 'b' });
    registry.setActive(b.session_id);
    const ctx = registry.context();
    expect(ctx.sessions).toHaveLength(2);
    expect(ctx.active_session_id).toBe(b.session_id);
    const identities = ctx.sessions.map((s) => s.account_identity).sort();
    expect(identities).toEqual(['a', 'b']);
  });

  it('resolve() with no requested id returns the active session', () => {
    const a = registry.register({ account_identity: 'a' });
    expect(registry.resolve(undefined)).toBe(a.session_id);
  });

  it('resolve() with a known id returns it', () => {
    const a = registry.register({ account_identity: 'a' });
    expect(registry.resolve(a.session_id)).toBe(a.session_id);
  });

  it('resolve() throws on an unknown id', () => {
    registry.register({ account_identity: 'a' });
    expect(() => registry.resolve('unknown-id')).toThrow(/Unknown session_id/);
  });

  it('resolve() returns null when registry is empty', () => {
    expect(registry.resolve(undefined)).toBeNull();
  });

  it('register() rejects empty account_identity', () => {
    expect(() => registry.register({ account_identity: '   ' })).toThrow();
  });
});
