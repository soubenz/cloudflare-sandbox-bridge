import { describe, it, expect } from 'vitest';
import { createFakeRuntime } from '../fakes/fake-runtime';
import { FakeBackend } from '../fakes/fake-backend';
import { proxyService, mintServiceCookie, sessionCookie } from '../../src/session/proxy';
import type { ServiceRuntime, SessionRuntime } from '../../src/session/state';

const SID = 'test-session';
const TOKEN = 'eyJzaWQiOiJ0In0.c2ln';

function spec(over: Record<string, unknown> = {}) {
  return { name: 'echo', argv: ['echo'], depends_on: [], port: 8080, ui: true, ...over } as unknown as ServiceRuntime['spec'];
}

async function setup(services: Record<string, Partial<ServiceRuntime> & { spec: ServiceRuntime['spec'] }>) {
  const { rt } = createFakeRuntime(SID);
  const backend = new FakeBackend();
  (rt as unknown as { _backend: unknown })._backend = backend.asBackend();
  await rt.putMeta({
    id: SID, user_id: 'u', lab_slug: 'l', lab_version: '1', family: 'agent', state: 'running', created_at: 1, resumed_count: 0,
  });
  await rt.putServices(
    Object.fromEntries(Object.entries(services).map(([k, v]) => [k, { restarts: 0, health: 'healthy', ...v } as ServiceRuntime]))
  );
  return { rt: rt as SessionRuntime, backend };
}

const url = (qs = '') => `https://api.test/sessions/${SID}/services/echo/${qs}`;

describe('sessionCookie', () => {
  it('carries the attributes a cross-site iframe needs', () => {
    const cookie = sessionCookie(SID, TOKEN);
    expect(cookie.startsWith(`opx_s_${SID}=${TOKEN};`)).toBe(true);
    const attrs = cookie.split('; ').slice(1);
    expect(attrs).toEqual([`Path=/sessions/${SID}/`, 'HttpOnly', 'Secure', 'SameSite=None', 'Partitioned']);
  });
});

describe('mintServiceCookie', () => {
  it('answers 204 with the same cookie the ?token= path sets', async () => {
    const { rt } = await setup({ echo: { spec: spec() } });
    const res = await mintServiceCookie(
      rt, new Request(url('session'), { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }), 'echo', SID
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Set-Cookie')).toBe(sessionCookie(SID, TOKEN));
  });

  it('is 404 for an unknown service and 403 for one with ui: false', async () => {
    const { rt } = await setup({ echo: { spec: spec() }, admin: { spec: spec({ name: 'admin', ui: false }) } });
    const req = () => new Request(url('session'), { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
    await expect(mintServiceCookie(rt, req(), 'nope', SID)).rejects.toMatchObject({ status: 404, code: 'unknown_service' });
    await expect(mintServiceCookie(rt, req(), 'admin', SID)).rejects.toMatchObject({ status: 403, code: 'not_exposed' });
  });

  it('still mints for an unhealthy service, so the console can see the 502 itself', async () => {
    const { rt } = await setup({ echo: { spec: spec(), health: 'unhealthy' } });
    const res = await mintServiceCookie(
      rt, new Request(url('session'), { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }), 'echo', SID
    );
    expect(res.status).toBe(204);
  });

  it('needs a token to put in the cookie', async () => {
    const { rt } = await setup({ echo: { spec: spec() } });
    await expect(mintServiceCookie(rt, new Request(url('session'), { method: 'POST' }), 'echo', SID)).rejects.toMatchObject({ status: 401 });
  });
});

describe('proxyService ?token=', () => {
  const html = { Accept: 'text/html,application/xhtml+xml' };

  it('redirects a document navigation to the same URL minus the token, with the cookie', async () => {
    const { rt, backend } = await setup({ echo: { spec: spec() } });
    const res = await proxyService(rt, new Request(url(`?a=1&token=${TOKEN}&b=2`), { headers: html }), 'echo', SID);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/sessions/${SID}/services/echo/?a=1&b=2`);
    expect(res.headers.get('Set-Cookie')).toBe(sessionCookie(SID, TOKEN));
    expect(backend.callsTo('containerFetch')).toHaveLength(0);
  });

  it('proxies a non-document request with ?token= and sets the cookie on the response', async () => {
    const { rt, backend } = await setup({ echo: { spec: spec() } });
    const res = await proxyService(rt, new Request(url(`?token=${TOKEN}`), { headers: { Accept: '*/*' } }), 'echo', SID);
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toBe(sessionCookie(SID, TOKEN));
    const forwarded = backend.callsTo('containerFetch')[0]![0] as Request;
    expect(new URL(forwarded.url).searchParams.has('token')).toBe(false);
  });

  it('does not redirect a document request that carries no token', async () => {
    const { rt } = await setup({ echo: { spec: spec() } });
    const res = await proxyService(rt, new Request(url(), { headers: html }), 'echo', SID);
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('answers 502 for an unhealthy service before redirecting', async () => {
    const { rt } = await setup({ echo: { spec: spec(), health: 'unhealthy' } });
    await expect(proxyService(rt, new Request(url(`?token=${TOKEN}`), { headers: html }), 'echo', SID)).rejects.toMatchObject({ status: 502 });
  });
});
