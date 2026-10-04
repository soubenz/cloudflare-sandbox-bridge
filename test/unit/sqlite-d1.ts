import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import type { Env } from '../../src/env';

/**
 * A D1-shaped wrapper over one in-memory SQLite database built from the
 * repo's own migration files (same engine D1 runs), with `batch()` as one
 * transaction like D1's. Shared by the tests that need real SQL.
 */

// `node:sqlite` is prefix-only; a require() sidesteps the bundler's resolver.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): unknown };
  };
};

const MIGRATIONS = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();

export type Sqlite = InstanceType<typeof DatabaseSync>;

export function sqliteD1(): { db: Env['DB']; sqlite: Sqlite } {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of MIGRATIONS) sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));

  interface Bound {
    all(): Promise<{ results: unknown[] }>;
    first(): Promise<unknown>;
    run(): Promise<{ meta: { changes: number } }>;
    sql: string;
    params: unknown[];
  }
  const bound = (sql: string, params: unknown[]): Bound => ({
    sql,
    params,
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    run: async () => {
      const result = sqlite.prepare(sql).run(...params) as { changes?: number | bigint };
      return { meta: { changes: Number(result?.changes ?? 0) } };
    },
  });
  const db = {
    prepare: (sql: string) => ({ ...bound(sql, []), bind: (...p: unknown[]) => bound(sql, p) }),
    batch: async (stmts: Bound[]) => {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return { db: db as unknown as Env['DB'], sqlite };
}
