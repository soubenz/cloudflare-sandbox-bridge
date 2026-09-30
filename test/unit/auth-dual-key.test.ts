import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { KEY_HEADER, previousKeyHeader, requireBrowserAuth, requireServiceAuth } from '../../src/auth';
import type { Env } from '../../src/env';

const NEW_KEY = 'new-service-key';
const OLD_KEY = 'old-service-key';

const baseEnv = { SANDBOX_API_KEY: NEW_KEY, SESSION_TOKEN_SECRET: 'unit-test-secret' } as Env;
const windowEnv = { ...baseEnv, SANDBOX_API_KEY_PREVIOUS: OLD_KEY } as Env;

const req = (key?: string) =>
  new Request('https://api.test/pools', { headers: key ? { Authorization: `Bearer ${key}` } : {} });

function app(env: Env) {
  const a = new Hono<{ Bindings: Env }>();
  a.use('*', previousKeyHeader());
  a.onError((err) => new Response('unauthorized', { status: 401 }));
  a.get('/pools', (c) => {
    requireServiceAuth(c.req.raw, c.env);
    return c.json({ ok: true });
  });
  a.get('/sessions/:id', async (c) => {
    await requireBrowserAuth(c.req.raw, c.env, c.req.param('id'));
    return c.json({ ok: true });
  });
  return { fetch: (r: Request) => a.fetch(r, env) };
}

describe('service key dual-key window', () => {
  it('accepts the primary key', () => {
    expect(() => requireServiceAuth(req(NEW_KEY), windowEnv)).not.toThrow();
    expect(() => requireServiceAuth(req(NEW_KEY), baseEnv)).not.toThrow();
  });

  it('accepts the previous key when SANDBOX_API_KEY_PREVIOUS is set', () => {
    expect(() => requireServiceAuth(req(OLD_KEY), windowEnv)).not.toThrow();
  });

  it('rejects the previous key when SANDBOX_API_KEY_PREVIOUS is unset', () => {
    expect(() => requireServiceAuth(req(OLD_KEY), baseEnv)).toThrow(/service key/);
  });

  it('does not treat an empty SANDBOX_API_KEY_PREVIOUS as a key', () => {
    const emptyEnv = { ...baseEnv, SANDBOX_API_KEY_PREVIOUS: '' } as Env;
    expect(() => requireServiceAuth(req(''), emptyEnv)).toThrow();
    expect(() => requireServiceAuth(req(), emptyEnv)).toThrow();
  });

  it('rejects an unknown key even while the window is open', () => {
    expect(() => requireServiceAuth(req('something-else'), windowEnv)).toThrow(/service key/);
  });

  it('sets X-Opalix-Key: previous only on the previous-key path', async () => {
    const service = app(windowEnv);

    const viaOld = await service.fetch(req(OLD_KEY));
    expect(viaOld.status).toBe(200);
    expect(viaOld.headers.get(KEY_HEADER)).toBe('previous');

    const viaNew = await service.fetch(req(NEW_KEY));
    expect(viaNew.status).toBe(200);
    expect(viaNew.headers.get(KEY_HEADER)).toBeNull();

    const rejected = await service.fetch(req('something-else'));
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get(KEY_HEADER)).toBeNull();
  });

  it('returns 401 through the router shape once the window is closed', async () => {
    const res = await app(baseEnv).fetch(req(OLD_KEY));
    expect(res.status).toBe(401);
    expect(res.headers.get(KEY_HEADER)).toBeNull();
  });

  it('browser routes accept the previous service key too, with the header', async () => {
    const res = await app(windowEnv).fetch(
      new Request('https://api.test/sessions/abc', { headers: { Authorization: `Bearer ${OLD_KEY}` } })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(KEY_HEADER)).toBe('previous');
  });

  it('is installed on the real router', () => {
    // The router cannot be built under the Node pool (see auth-matrix.test.ts),
    // so pin the wiring at the source level.
    expect(readFileSync('src/router.ts', 'utf8')).toContain("app.use('*', previousKeyHeader());");
  });
});
