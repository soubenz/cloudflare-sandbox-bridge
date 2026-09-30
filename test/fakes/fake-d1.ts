import type { Env } from '../../src/env';

export interface D1Call {
  sql: string;
  params: unknown[];
  kind: 'run' | 'first' | 'all';
}

/**
 * Programmable D1: every statement is recorded, and `handler` answers it by
 * returning the rows (`all`), the row (`first`) or nothing (`run`), or by
 * throwing to simulate a D1 failure. Only the `prepare().bind().run/first/all`
 * surface the app uses is implemented.
 */
export function createFakeD1(handler: (call: D1Call) => unknown = () => undefined) {
  const calls: D1Call[] = [];
  const exec = (sql: string, params: unknown[], kind: D1Call['kind']) => {
    const call = { sql: sql.replace(/\s+/g, ' ').trim(), params, kind };
    calls.push(call);
    return handler(call);
  };
  const db = {
    prepare(sql: string) {
      const stmt = (params: unknown[]) => ({
        run: async () => (exec(sql, params, 'run') as object | undefined) ?? { meta: { changes: 1 } },
        first: async () => exec(sql, params, 'first') ?? null,
        all: async () => ({ results: (exec(sql, params, 'all') as unknown[] | undefined) ?? [] }),
      });
      return { ...stmt([]), bind: (...params: unknown[]) => stmt(params) };
    },
  };
  return { db: db as unknown as Env['DB'], calls, callsMatching: (re: RegExp) => calls.filter((c) => re.test(c.sql)) };
}
