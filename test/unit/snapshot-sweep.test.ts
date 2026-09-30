import { describe, it, expect } from 'vitest';
import { deleteExpiredSnapshots, shouldSweepSnapshots } from '../../src/session/d1';
import type { Env } from '../../src/env';

function fakeEnv(changes: number) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              calls.push({ sql, params });
              return { success: true, meta: { changes } };
            },
          };
        },
      };
    },
  };
  return { env: { DB } as unknown as Env, calls };
}

describe('deleteExpiredSnapshots', () => {
  it('deletes from snapshots where expires_at < now and returns meta.changes', async () => {
    const { env, calls } = fakeEnv(4);
    const deleted = await deleteExpiredSnapshots(env, 1_700_000_000_000);
    expect(deleted).toBe(4);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/DELETE FROM snapshots WHERE expires_at < \?/);
    expect(calls[0]!.params).toEqual([1_700_000_000_000]);
  });
});

describe('shouldSweepSnapshots (hour gate)', () => {
  it('sweeps on the first 5-minute run of the hour', () => {
    expect(shouldSweepSnapshots(Date.UTC(2026, 8, 30, 12, 3))).toBe(true);
    expect(shouldSweepSnapshots(Date.UTC(2026, 8, 30, 12, 0))).toBe(true);
  });
  it('skips the other runs', () => {
    expect(shouldSweepSnapshots(Date.UTC(2026, 8, 30, 12, 17))).toBe(false);
    expect(shouldSweepSnapshots(Date.UTC(2026, 8, 30, 12, 5))).toBe(false);
  });
});
