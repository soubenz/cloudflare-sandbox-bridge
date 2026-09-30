import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { admissionDecision, resolveMaxInstances, availableSlots, DEFAULT_MAX_INSTANCES } from '../../src/lib/pool-health';
import type { Env } from '../../src/env';
import { createFakeStorage } from '../fakes/fake-storage';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock('../../src/session/backend', () => ({ cloudflareBackend: () => ({ destroy: async () => {}, ensureRunning: async () => {} }) }));

const now = 1_000_000;
const base = { claimed: 0, warm: 0, max: 10, backoffUntil: 0, now };

describe('admissionDecision (B-19)', () => {
  it.each([
    ['an empty pool admits', base, { ok: true }],
    ['a warm container admits even when claimed + warm reaches max', { ...base, claimed: 4, warm: 6 }, { ok: true }],
    ['a warm container admits during a capacity backoff (claiming it starts nothing)', { ...base, warm: 1, backoffUntil: now + 60_000 }, { ok: true }],
    ['claimed below max with nothing warm admits a cold start', { ...base, claimed: 9 }, { ok: true }],
    ['claimed at max with nothing warm refuses', { ...base, claimed: 10 }, { ok: false, retry_after_s: 30 }],
    ['claimed above max refuses too', { ...base, claimed: 12 }, { ok: false, retry_after_s: 30 }],
    ['a capacity backoff refuses a cold start for the time left', { ...base, claimed: 2, backoffUntil: now + 45_000 }, { ok: false, retry_after_s: 45 }],
    ['a partial second rounds up', { ...base, backoffUntil: now + 1_200 }, { ok: false, retry_after_s: 2 }],
    ['a backoff that has passed no longer refuses', { ...base, backoffUntil: now - 1 }, { ok: true }],
    ['a backoff ending exactly now no longer refuses', { ...base, backoffUntil: now }, { ok: true }],
    ['a long backoff is capped at 300s', { ...base, backoffUntil: now + 3_600_000 }, { ok: false, retry_after_s: 300 }],
    ['max 1 with one claimed refuses', { ...base, max: 1, claimed: 1 }, { ok: false, retry_after_s: 30 }],
  ] as const)('%s', (_name, input, expected) => {
    expect(admissionDecision(input)).toEqual(expected);
  });
});

describe('max_instances plumbing', () => {
  it.each([
    [undefined, 10],
    ['', 10],
    ['abc', 10],
    ['0', 10],
    ['-2', 10],
    ['2.5', 10],
    ['25', 25],
  ] as const)('resolveMaxInstances(%s) = %s', (raw, expected) => {
    expect(resolveMaxInstances(raw)).toBe(expected);
  });

  it('available is what live sessions leave free, never negative', () => {
    expect(availableSlots(3, 10)).toBe(7);
    expect(availableSlots(12, 10)).toBe(0);
  });
});

/**
 * `max_instances` on the container classes is what the platform enforces; the
 * MAX_INSTANCES_* vars are what admission control compares against. Same
 * pattern as the egress host constants: two places, one test that keeps them
 * equal. A var that is not set in wrangler.jsonc counts as the default the
 * code falls back to, so this stays meaningful before the vars are added.
 */
describe('MAX_INSTANCES vars match wrangler.jsonc container max_instances', () => {
  const config = parse(readFileSync(join(__dirname, '../../wrangler.jsonc'), 'utf8')) as {
    containers: Array<{ class_name: string; max_instances: number }>;
    vars: Record<string, string>;
  };
  const maxOf = (className: string) => config.containers.find((c) => c.class_name === className)!.max_instances;

  it.each([
    ['AgentLab', 'MAX_INSTANCES_AGENT'],
    ['GatewayLab', 'MAX_INSTANCES_GATEWAY'],
  ] as const)('%s <-> %s', (className, varName) => {
    expect(maxOf(className)).toBeGreaterThan(0);
    const effective = config.vars[varName] ?? String(DEFAULT_MAX_INSTANCES);
    expect(typeof effective).toBe('string');
    expect(resolveMaxInstances(effective)).toBe(maxOf(className));
  });
});

async function makePool(env: Partial<Env>, family = 'agent') {
  const { Pool } = await import('../../src/do/pool');
  const storage = createFakeStorage();
  const ctx = { id: { name: family }, storage };
  return { pool: new Pool(ctx as never, env as Env), storage };
}

describe('Pool.admit() and stats()', () => {
  it('throws 503 at_capacity with retry_after_s when the live sessions hold every instance', async () => {
    const { pool, storage } = await makePool({ MAX_INSTANCES_AGENT: '2' });
    await storage.put('claimed', { a: { session_id: 's1', claimed_at: 1 }, b: { session_id: 's2', claimed_at: 1 } });
    await expect(pool.admit()).rejects.toMatchObject({
      status: 503,
      code: 'at_capacity',
      details: { retry_after_s: 30 },
      message: expect.stringContaining('retry_after_s=30'),
    });
  });

  it('admits while a warm container exists, and refuses during a backoff with nothing warm', async () => {
    const { pool, storage } = await makePool({ MAX_INSTANCES_AGENT: '1' });
    await storage.put('claimed', { a: { session_id: 's1', claimed_at: 1 } });
    await storage.put('warm', [{ sandbox_id: 'w', created_at: 1, ready_at: 1, last_ping_at: 1 }]);
    await expect(pool.admit()).resolves.toBeUndefined();

    const backoff = await makePool({ MAX_INSTANCES_AGENT: '5' });
    await backoff.pool.stats(); // initialises the pool's config and stats
    await backoff.storage.put('stats', { capacity_backoff_until: Date.now() + 90_000 });
    await expect(backoff.pool.admit()).rejects.toMatchObject({ code: 'at_capacity' });
  });

  it('defaults to 10 and reads the gateway var for the gateway family; stats exposes max_instances and available', async () => {
    const agent = await makePool({});
    await agent.storage.put('claimed', { a: { session_id: 's1', claimed_at: 1 } });
    expect(await agent.pool.stats()).toMatchObject({ max_instances: 10, available: 9, claimed: 1 });

    const gateway = await makePool({ MAX_INSTANCES_AGENT: '3', MAX_INSTANCES_GATEWAY: '4' }, 'gateway');
    expect(await gateway.pool.stats()).toMatchObject({ max_instances: 4, available: 4 });
  });
});
