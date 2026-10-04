import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/env';
import { parseManifest } from '../../src/labs/manifest';
import { fromSdkError, ApiError } from '../../src/lib/errors';

/**
 * Internal error text (D1/SQLite, SDK, archive parsers) must never be in a
 * response body: the console Worker relays bodies to the browser. The text
 * goes to the log with the ids that locate it.
 */

vi.mock('../../src/do/pool', () => ({ poolStub: () => ({ admit: async () => {} }) }));
const manifest = parseManifest({
  slug: 'lab-a', version: '1.0.0', title: 'Lab A', type: 'build', family: 'agent', timeout_minutes: 90, idle_minutes: 10,
  services: [{ name: 'api', argv: ['python3', 'app.py'], port: 8000 }],
  checks: [{ name: 'c1', script: 'c1.sh' }],
});
vi.mock('../../src/labs/bundle', () => ({
  loadCurrentManifest: async () => ({ version: '1.0.0', manifest }),
  listCatalogue: async () => ({ labs: [] }),
  publishLab: async () => ({}),
  INDEX_KEY: 'labs/index.json',
}));

const { createRouter } = await import('../../src/router');
const app = createRouter();

const LEAK = 'SQLITE_ERROR: no such column secret_col in table sessions at offset 4242';
const UNIQUE_LEAK = 'D1_ERROR: UNIQUE constraint failed: sessions.user_id: SQLITE_CONSTRAINT (index sessions_active_user, user secret-user-9)';

/** A D1 whose INSERT INTO sessions throws `insertError`; every SELECT finds nothing (no stale row to heal). */
function envWith(insertError: Error): Env {
  const stmt = (sql: string) => {
    const run = async () => {
      if (/INSERT INTO sessions/i.test(sql)) throw insertError;
      return { meta: { changes: 0 } };
    };
    const bound = { run, all: async () => ({ results: [] }), first: async () => null };
    return { ...bound, bind: () => bound };
  };
  return {
    SANDBOX_API_KEY: 'svc-key',
    SESSION_TOKEN_SECRET: 'secret',
    PUBLIC_BASE_URL: 'https://api.test',
    DB: { prepare: stmt },
    SESSION: { idFromName: (id: string) => id, get: () => ({}) },
  } as unknown as Env;
}

const start = (env: Env) =>
  app.fetch(
    new Request('https://api.test/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer svc-key' },
      body: JSON.stringify({ lab: 'lab-a', user_id: 'user-7' }),
    }),
    env
  );

let logged: unknown[][];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args));
});
afterEach(() => vi.restoreAllMocks());

describe('a failing D1 insert on POST /sessions', () => {
  it('a non-conflict D1 error is a 500 whose body has none of its text', async () => {
    const res = await start(envWith(new Error(LEAK)));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error).toEqual({ code: 'internal_error', message: 'Could not reserve the session slot' });
    for (const fragment of [LEAK, 'SQLITE', 'secret_col', 'offset', 'cause']) expect(text).not.toContain(fragment);
    // The diagnostic is in the log, with the ids and without any token.
    const line = logged.find((l) => l.includes(LEAK) || l.some((a) => a instanceof Error && a.message === LEAK));
    expect(line).toBeDefined();
    expect(JSON.stringify(line![1])).toContain('user-7');
    expect(JSON.stringify(line![1])).toContain('session_id');
  });

  it('the one-active-session conflict is a 409 with the client message only', async () => {
    const res = await start(envWith(new Error(UNIQUE_LEAK)));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text).error).toEqual({ code: 'active_session_exists', message: 'This user already has an active session' });
    for (const fragment of ['UNIQUE', 'SQLITE', 'sessions_active_user', 'secret-user-9', 'cause']) expect(text).not.toContain(fragment);
  });

  it('a non-Error rejection leaks nothing either', async () => {
    const res = await start(envWith('raw string failure from the driver' as unknown as Error));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('raw string failure');
  });
});

describe('an unrecognised error reaching the router', () => {
  it('is a 500 with a fixed message; the original text is logged, only the class name is exposed', () => {
    const err = new Error('D1_ERROR: no such table: users_secret');
    err.name = 'D1Error';
    const api = fromSdkError(err);
    expect(api.status).toBe(500);
    expect(api.message).toBe('Internal error');
    expect(JSON.stringify(api.toResponse().status) + JSON.stringify(api.details)).not.toContain('users_secret');
    expect(api.details).toEqual({ error_name: 'D1Error' });
    expect(logged.flat().join(' ')).toContain('users_secret');
  });

  it('client-facing ApiErrors keep their message', () => {
    expect(fromSdkError(ApiError.notFound('lab_not_found', 'No lab "x"')).message).toBe('No lab "x"');
  });
});
