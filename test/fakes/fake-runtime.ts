import { SessionRuntime } from '../../src/session/state';
import type { Env } from '../../src/env';
import { createFakeStorage } from './fake-storage';

/**
 * Builds a real SessionRuntime backed by an in-memory fake
 * DurableObjectState, so unit tests exercise the actual state.ts /
 * timers.ts / events.ts code paths rather than a hand-duplicated model of
 * them. Only `storage` is faked; `sql` is a no-op stub sufficient for
 * modules that don't touch it (timers, manifest-adjacent logic). Tests
 * that need real SQL behavior (events.ts's ring buffer) are out of scope
 * for this fake — see the note in vitest.config.ts about the container-
 * and DO-runtime-dependent integration suite.
 */
export function createFakeRuntime(sessionId = 'test-session'): { rt: SessionRuntime; storage: ReturnType<typeof createFakeStorage> } {
  const storage = createFakeStorage();
  const fakeCtx = {
    id: { name: sessionId },
    storage: { ...storage, sql: { exec: () => [] } },
    acceptWebSocket: () => {},
    getWebSockets: () => [],
  };
  const fakeEnv: Partial<Env> = { SESSION_TOKEN_SECRET: 'test-secret' };
  const rt = new SessionRuntime(fakeCtx as unknown as DurableObjectState, fakeEnv as Env, sessionId);
  return { rt, storage };
}
