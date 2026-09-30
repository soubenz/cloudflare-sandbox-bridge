import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { aggregateUsage, queryUsage, resolveWindow, pricePerHour, USAGE_SQL, DEFAULT_WINDOW_MS, type UsageRow } from '../../src/session/usage';
import type { Env } from '../../src/env';

const H = 3_600_000;
const prices = { agent: 0.074, gateway: 0.148 };

function fakeEnv(rows: UsageRow[], vars: Partial<Env> = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all() {
              calls.push({ sql, params });
              return { results: rows };
            },
          };
        },
      };
    },
  };
  return { env: { DB, ...vars } as unknown as Env, calls };
}

describe('aggregateUsage', () => {
  it('turns ms into hours and prices each family', () => {
    const rows: UsageRow[] = [
      { family: 'agent', sessions: 3, ms: 10 * H },
      { family: 'gateway', sessions: 2, ms: 5 * H },
    ];
    const r = aggregateUsage(rows, { from: 0, to: 100 }, prices);
    expect(r.by_family.agent).toEqual({ hours: 10, usd: 0.74, sessions: 3 });
    expect(r.by_family.gateway).toEqual({ hours: 5, usd: 0.74, sessions: 2 });
    expect(r.total_usd).toBe(1.48);
    expect(r.from).toBe(0);
    expect(r.to).toBe(100);
  });

  it('reports zeros for a family with no rows, and ignores unknown families', () => {
    const r = aggregateUsage([{ family: 'other', sessions: 9, ms: 99 * H }], { from: 0, to: 1 }, prices);
    expect(r.by_family.agent).toEqual({ hours: 0, usd: 0, sessions: 0 });
    expect(r.by_family.gateway).toEqual({ hours: 0, usd: 0, sessions: 0 });
    expect(r.total_usd).toBe(0);
  });

  it('treats a NULL sum as zero hours', () => {
    const r = aggregateUsage([{ family: 'agent', sessions: 1, ms: null }], { from: 0, to: 1 }, prices);
    expect(r.by_family.agent).toEqual({ hours: 0, usd: 0, sessions: 1 });
  });
});

describe('queryUsage', () => {
  it('binds the window into the clamped-overlap SQL and prices with env overrides', async () => {
    const { env, calls } = fakeEnv([{ family: 'agent', sessions: 1, ms: 2 * H }], { PRICE_PER_HOUR_AGENT: '0.5' });
    const r = await queryUsage(env, { from: 1000, to: 9000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe(USAGE_SQL);
    // ended_at/to clamp, to, started_at/from clamp, overlap test (started_at < to, COALESCE(ended_at,to) > from)
    expect(calls[0]!.params).toEqual([9000, 9000, 1000, 9000, 9000, 1000]);
    expect(r.by_family.agent.usd).toBe(1);
    expect(r.by_family.gateway.usd).toBe(0);
  });

  it('defaults to 0.074 and 0.148 per hour when the vars are absent or invalid', async () => {
    const { env } = fakeEnv([
      { family: 'agent', sessions: 1, ms: H },
      { family: 'gateway', sessions: 1, ms: H },
    ]);
    const r = await queryUsage(env, { from: 0, to: 1 });
    expect(r.by_family.agent.usd).toBe(0.074);
    expect(r.by_family.gateway.usd).toBe(0.148);
    expect(r.total_usd).toBe(0.222);
    expect(pricePerHour({ PRICE_PER_HOUR_AGENT: 'abc' } as Env, 'agent')).toBe(0.074);
    expect(pricePerHour({ PRICE_PER_HOUR_GATEWAY: '-1' } as Env, 'gateway')).toBe(0.148);
    expect(pricePerHour({ PRICE_PER_HOUR_GATEWAY: '0' } as Env, 'gateway')).toBe(0);
  });
});

describe('resolveWindow', () => {
  const now = 1_800_000_000_000;
  it('defaults to the last 30 days', () => {
    expect(resolveWindow(undefined, undefined, now)).toEqual({ from: now - DEFAULT_WINDOW_MS, to: now });
  });
  it('honours explicit from/to and floors fractions', () => {
    expect(resolveWindow('1000', '5000.9', now)).toEqual({ from: 1000, to: 5000 });
  });
  it('defaults from relative to an explicit to', () => {
    expect(resolveWindow(undefined, String(DEFAULT_WINDOW_MS + 5), now)).toEqual({ from: 5, to: DEFAULT_WINDOW_MS + 5 });
  });
  it.each([['abc', undefined], [undefined, 'x'], ['-5', undefined], ['5000', '1000'], ['1000', '1000']])('rejects from=%s to=%s', (from, to) => {
    expect(() => resolveWindow(from, to, now)).toThrow(/bad_window|must/);
  });
});

// The clamping lives in SQL, so run the real query against SQLite when the
// runtime has it (node:sqlite, Node >= 22.5). The fake-DB tests above cannot
// prove the arithmetic.
type Sqlite = { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } } };
let sqlite: Sqlite | undefined;
try {
  // createRequire: vite's resolver does not know node:sqlite as a builtin yet.
  sqlite = createRequire(import.meta.url)('node:sqlite') as Sqlite;
} catch {
  sqlite = undefined;
}

describe.skipIf(!sqlite)('usage SQL against real SQLite', () => {
  it('clamps sessions to the window and skips never-started ones', async () => {
    const db = new sqlite!.DatabaseSync(':memory:');
    db.exec('CREATE TABLE sessions (id TEXT, family TEXT, started_at INTEGER, ended_at INTEGER)');
    const ins = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)');
    const from = 10 * H;
    const to = 20 * H;
    ins.run('inside', 'agent', 11 * H, 13 * H); //          2h
    ins.run('starts-before', 'agent', 5 * H, 12 * H); //    clamped to from: 2h
    ins.run('ends-after', 'gateway', 18 * H, 30 * H); //    clamped to to: 2h
    ins.run('still-running', 'gateway', 19 * H, null); //   counts to `to`: 1h
    ins.run('spans-all', 'agent', 0, 100 * H); //           10h
    ins.run('before-window', 'agent', 1 * H, 10 * H); //    ends exactly at from: excluded
    ins.run('after-window', 'agent', 20 * H, 25 * H); //    starts exactly at to: excluded
    ins.run('never-started', 'agent', null, null); //       excluded
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...params: unknown[]) => ({ all: async () => ({ results: db.prepare(sql).all(...params) }) }),
        }),
      },
    } as unknown as Env;
    const r = await queryUsage(env, { from, to });
    expect(r.by_family.agent).toEqual({ hours: 14, usd: 1.036, sessions: 3 });
    expect(r.by_family.gateway).toEqual({ hours: 3, usd: 0.444, sessions: 2 });
    expect(r.total_usd).toBe(1.48);
  });
});
