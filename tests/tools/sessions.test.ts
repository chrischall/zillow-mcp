import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SessionRegistry } from '../../src/sessions.js';
import { registerSessionTools } from '../../src/tools/sessions.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

// Single registry shared across the suite so it can carry state from one
// `it` to the next (mirrors how the other tool-suite tests share state).
// `reset()` between tests where we want a clean slate.
let registry: SessionRegistry;
let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeAll(async () => {
  registry = new SessionRegistry();
  harness = await createTestHarness((server) =>
    registerSessionTools(server, registry)
  );
});
afterAll(async () => {
  if (harness) await harness.close();
});

describe('session tools', () => {
  it('zillow_register_session adds a session and returns session_id + active_session_id', async () => {
    registry.reset();
    const r = await harness.callTool('zillow_register_session', {
      account_identity: 'alice@example.com',
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      session: { session_id: string; account_identity: string };
      active_session_id: string;
    }>(r);
    expect(parsed.session.account_identity).toBe('alice@example.com');
    expect(parsed.active_session_id).toBe(parsed.session.session_id);
  });

  it('zillow_get_session_context lists ALL registered sessions + active_session_id (issue #48)', async () => {
    registry.reset();
    registry.register({ account_identity: 'a' });
    const b = registry.register({ account_identity: 'b' });
    registry.setActive(b.session_id);

    const r = await harness.callTool('zillow_get_session_context', {});
    const parsed = parseToolResult<{
      active_session_id: string;
      sessions: Array<{ account_identity: string; session_id: string }>;
    }>(r);
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.active_session_id).toBe(b.session_id);
  });

  it('zillow_get_session_context returns empty when no sessions registered', async () => {
    registry.reset();
    const r = await harness.callTool('zillow_get_session_context', {});
    const parsed = parseToolResult<{
      active_session_id: string | null;
      sessions: unknown[];
    }>(r);
    expect(parsed.active_session_id).toBeNull();
    expect(parsed.sessions).toEqual([]);
  });

  it('zillow_set_active_session switches the active session', async () => {
    registry.reset();
    const a = registry.register({ account_identity: 'a' });
    const b = registry.register({ account_identity: 'b' });
    expect(registry.activeSessionId()).toBe(a.session_id);

    const r = await harness.callTool('zillow_set_active_session', {
      session_id: b.session_id,
    });
    const parsed = parseToolResult<{ active_session_id: string }>(r);
    expect(parsed.active_session_id).toBe(b.session_id);
  });

  it('zillow_set_active_session errors on unknown session_id', async () => {
    registry.reset();
    const r = await harness.callTool('zillow_set_active_session', {
      session_id: 'nope',
    });
    expect(r.isError).toBeTruthy();
  });

  it('re-registering the same account_identity keeps the same session_id (issue #47)', async () => {
    registry.reset();
    const r1 = await harness.callTool('zillow_register_session', {
      account_identity: 'alice@example.com',
    });
    const r2 = await harness.callTool('zillow_register_session', {
      account_identity: 'alice@example.com',
    });
    const parsed1 = parseToolResult<{ session: { session_id: string } }>(r1);
    const parsed2 = parseToolResult<{ session: { session_id: string } }>(r2);
    expect(parsed2.session.session_id).toBe(parsed1.session.session_id);
  });
});
