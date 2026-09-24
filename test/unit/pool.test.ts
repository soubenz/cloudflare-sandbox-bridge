import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pool } from '../../src/do/pool';
import { createFakeStorage } from '../fakes/fake-storage';

/**
 * The Pool DO's own logic (claim bookkeeping and the alarm's reconcile step)
 * is pure storage manipulation once the container backend is replaced, so it
 * runs in the plain-Node unit pool against the fake storage. Only the backend
 * is mocked — `cloudflare:workers` is aliased to a stand-in base class in
 * vitest.config.ts. Anything that needs a real container stays in the
 * integration suite.
 */
const destroyed: string[] = [];
const ensureRunningFails = new Set<string>();

vi.mock('../../src/session/backend', () => ({
  cloudflareBackend: (_env: unknown, _family: string, sandboxId: string) => ({
    async ensureRunning() {
      if (ensureRunningFails.has(sandboxId)) throw new Error(`boom ${sandboxId}`);
    },
    async destroy() {
      destroyed.push(sandboxId);
    },
  }),
}));

function createPool(family = 'agent') {
  const storage = createFakeStorage();
  const ctx = { id: { name: family }, storage } as unknown as DurableObjectState;
  const pool = new Pool(ctx, {} as never);
  return { pool, storage };
}

/** Seeds `warm` directly so tests don't have to drive a refill to get entries. */
async function seedWarm(storage: ReturnType<typeof createFakeStorage>, ids: string[], now = Date.now()) {
  await storage.put(
    'warm',
    ids.map((sandbox_id) => ({ sandbox_id, created_at: now, ready_at: now, last_ping_at: now }))
  );
}

beforeEach(() => {
  destroyed.length = 0;
  ensureRunningFails.clear();
});

describe('Pool.claim', () => {
  it('is idempotent per session: a repeated claim replays the same sandbox and does not count twice', async () => {
    const { pool, storage } = createPool();
    await seedWarm(storage, ['agent-warm-1', 'agent-warm-2']);

    const first = await pool.claim('session-a');
    const second = await pool.claim('session-a');

    expect(second).toEqual(first);
    expect(first.warm).toBe(true);

    const stats = await pool.stats();
    expect(stats.stats.claims).toBe(1);
    expect(stats.stats.warm_hits).toBe(1);
    expect(stats.claimed).toBe(1);
    // The second claim must not have popped the other warm entry either.
    expect(stats.warm).toBe(1);
  });

  it('replays a cold claim as cold, without minting a second sandbox id', async () => {
    const { pool } = createPool();

    const first = await pool.claim('session-a');
    const second = await pool.claim('session-a');

    expect(first.warm).toBe(false);
    expect(second).toEqual(first);
    const stats = await pool.stats();
    expect(stats.stats.claims).toBe(1);
    expect(stats.stats.cold_misses).toBe(1);
  });

  it('still hands different sessions different sandboxes', async () => {
    const { pool, storage } = createPool();
    await seedWarm(storage, ['agent-warm-1', 'agent-warm-2']);

    const a = await pool.claim('session-a');
    const b = await pool.claim('session-b');

    expect(a.sandbox_id).not.toBe(b.sandbox_id);
    expect((await pool.stats()).stats.claims).toBe(2);
  });

  it('claims fresh again after the session released (the resume path)', async () => {
    const { pool, storage } = createPool();
    await seedWarm(storage, ['agent-warm-1', 'agent-warm-2']);

    const first = await pool.claim('session-a');
    await pool.release(first.sandbox_id);
    const second = await pool.claim('session-a');

    expect(second.sandbox_id).not.toBe(first.sandbox_id);
    expect((await pool.stats()).stats.claims).toBe(2);
  });
});

describe('Pool.alarm reconcile', () => {
  it('destroys the surplus when warm is above target', async () => {
    const { pool, storage } = createPool();
    await storage.put('config', { family: 'agent', target: 1, batch: 3, ping_every_s: 240 });
    await seedWarm(storage, ['agent-warm-1', 'agent-warm-2', 'agent-warm-3']);

    await pool.alarm();

    expect((await pool.stats()).warm).toBe(1);
    // Kept the oldest (head of the list) — that's what the next claim hands out.
    expect(destroyed.sort()).toEqual(['agent-warm-2', 'agent-warm-3']);
  });

  it('drops the whole warm list when the target is 0', async () => {
    const { pool, storage } = createPool();
    await storage.put('config', { family: 'agent', target: 0, batch: 3, ping_every_s: 240 });
    await seedWarm(storage, ['agent-warm-1', 'agent-warm-2']);

    await pool.alarm();

    expect((await pool.stats()).warm).toBe(0);
    expect(destroyed.sort()).toEqual(['agent-warm-1', 'agent-warm-2']);
  });

  it('shrinks even while a capacity backoff is holding refills off', async () => {
    const { pool, storage } = createPool();
    await storage.put('config', { family: 'agent', target: 1, batch: 3, ping_every_s: 240 });
    await storage.put('stats', {
      claims: 0,
      warm_hits: 0,
      cold_misses: 0,
      starts: 0,
      start_ms_total: 0,
      failures: 0,
      capacity_backoff_until: Date.now() + 60_000,
    });
    await seedWarm(storage, ['agent-warm-1', 'agent-warm-2']);

    await pool.alarm();

    expect((await pool.stats()).warm).toBe(1);
    expect(destroyed).toEqual(['agent-warm-2']);
  });

  it('refills toward the target when warm is short', async () => {
    const { pool, storage } = createPool();
    await storage.put('config', { family: 'agent', target: 2, batch: 3, ping_every_s: 240 });

    await pool.alarm();

    expect((await pool.stats()).warm).toBe(2);
    expect(destroyed).toEqual([]);
  });

  it('leaves warm alone when it already matches the target', async () => {
    const { pool, storage } = createPool();
    await storage.put('config', { family: 'agent', target: 2, batch: 3, ping_every_s: 240 });
    await seedWarm(storage, ['agent-warm-1', 'agent-warm-2']);

    await pool.alarm();

    expect((await pool.stats()).warm).toBe(2);
    expect(destroyed).toEqual([]);
  });

  it('does not touch claimed containers while shrinking', async () => {
    const { pool, storage } = createPool();
    await storage.put('config', { family: 'agent', target: 0, batch: 3, ping_every_s: 240 });
    await seedWarm(storage, ['agent-warm-1']);
    const claim = await pool.claim('session-a');

    await pool.alarm();

    expect(destroyed).toEqual([]);
    expect((await pool.stats()).claimed).toBe(1);
    expect(claim.sandbox_id).toBe('agent-warm-1');
  });
});

describe('Pool.prime', () => {
  it('lowering the target destroys the surplus', async () => {
    const { pool } = createPool();

    await pool.prime(2);
    expect((await pool.stats()).warm).toBe(2);

    await pool.prime(1);
    const after = await pool.stats();
    expect(after.warm).toBe(1);
    expect(after.config.target).toBe(1);
    expect(destroyed).toHaveLength(1);
  });

  it('clamps a negative target to 0 rather than shrinking by one', async () => {
    const { pool, storage } = createPool();
    await storage.put('config', { family: 'agent', target: 3, batch: 3, ping_every_s: 240 });
    await seedWarm(storage, ['agent-warm-1', 'agent-warm-2', 'agent-warm-3']);

    await pool.prime(-1);

    expect((await pool.stats()).config.target).toBe(0);
    expect((await pool.stats()).warm).toBe(0);
    expect(destroyed).toHaveLength(3);
  });
});

describe('Pool.drain', () => {
  it('destroys every warm container and leaves the target alone', async () => {
    const { pool, storage } = createPool();
    await storage.put('config', { family: 'agent', target: 2, batch: 3, ping_every_s: 240 });
    await seedWarm(storage, ['agent-warm-1', 'agent-warm-2']);

    await pool.drain();

    const after = await pool.stats();
    expect(after.warm).toBe(0);
    expect(after.config.target).toBe(2);
    expect(destroyed.sort()).toEqual(['agent-warm-1', 'agent-warm-2']);
  });
});
