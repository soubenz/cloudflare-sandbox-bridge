import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Which routes require a credential, asserted against the source.
 *
 * Nothing else in CI can catch a route being opened by accident: the unit
 * suite never builds a router, and every integration suite carries a
 * service key, so both stay green whatever the auth on a route is. That is
 * exactly how an unauthenticated session-start route survived in
 * production — it was gated on a var, and no test ever read that var.
 *
 * This is a source-level assertion rather than a live request because the
 * router needs a Workers runtime to instantiate. It is deliberately dumb:
 * it reads the handler bodies and checks which auth helper each one calls.
 */
const router = readFileSync('src/router.ts', 'utf8');

/** The body of `app.<method>('<path>', …)` up to the next route registration. */
function handlerFor(method: string, path: string): string {
  const needle = `app.${method}('${path}'`;
  const start = router.indexOf(needle);
  if (start === -1) throw new Error(`route not found in src/router.ts: ${method.toUpperCase()} ${path}`);
  const next = router.indexOf('\n  app.', start + needle.length);
  return router.slice(start, next === -1 ? undefined : next);
}

const SERVICE_KEY_ONLY: Array<[string, string]> = [
  ['post', '/sessions'],
  ['post', '/sessions/start'],
  ['get', '/sessions'],
  ['get', '/labs'],
  ['get', '/labs/:slug'],
  ['post', '/labs/publish'],
  ['get', '/pools'],
  ['get', '/pools/:family'],
  ['post', '/pools/:family/prime'],
  ['post', '/pools/:family/drain'],
  ['post', '/sessions/:id/events'],
  ['get', '/users/:uid/sessions'],
  ['get', '/usage'],
  ['get', '/users/:uid/progress'],
  ['get', '/users/:uid/checks'],
];

/** Reachable with a session token — the browser holds one of these legitimately. */
const SESSION_TOKEN: Array<[string, string]> = [
  ['get', '/sessions/:id'],
  ['post', '/sessions/:id/checks'],
  ['post', '/sessions/:id/snapshot'],
  ['post', '/sessions/:id/touch'],
  ['delete', '/sessions/:id'],
  ['get', '/sessions/:id/events'],
  ['get', '/sessions/:id/files'],
  ['get', '/sessions/:id/checks'],
  ['get', '/sessions/:id/progress-summary'],
  ['post', '/sessions/:id/feedback'],
  ['post', '/sessions/:id/services/:name/session'],
];

describe('route auth matrix', () => {
  it.each(SERVICE_KEY_ONLY)('%s %s requires the service key', (method, path) => {
    expect(handlerFor(method, path)).toContain('requireServiceAuth(');
  });

  it.each(SESSION_TOKEN)('%s %s accepts a session token', (method, path) => {
    expect(handlerFor(method, path)).toContain('requireBrowserAuth(');
  });

  it('GET /health is public but /health?deep=1 requires the service key', () => {
    const body = handlerFor('get', '/health');
    const deepGate = body.indexOf("c.req.query('deep') !== '1'");
    const auth = body.indexOf('requireServiceAuth(');
    const deepWork = body.indexOf('deepHealth(');
    expect(deepGate, 'the plain path must return before anything else').toBeGreaterThan(-1);
    expect(auth, 'the deep path must call requireServiceAuth').toBeGreaterThan(deepGate);
    expect(deepWork, 'auth must run before the deep checks').toBeGreaterThan(auth);
    // The early return for the plain path sits before the auth call.
    expect(body.slice(deepGate, auth)).toContain('return c.json({ ok: true })');
  });

  it('the service cookie route refuses the service key and is registered before the proxy', () => {
    // The cookie would carry whatever bearer authenticated, so a service key
    // must never reach the DO handler; and `/services/:name/*` would swallow
    // the route if it were registered first.
    const body = handlerFor('post', '/sessions/:id/services/:name/session');
    expect(body).toContain("auth.kind !== 'session'");
    expect(router.indexOf("app.post('/sessions/:id/services/:name/session'")).toBeLessThan(
      router.indexOf("app.all('/sessions/:id/services/:name/*'")
    );
  });

  it('has no unauthenticated session-start route', () => {
    expect(router).not.toContain("'/dev/sessions'");
    expect(router).not.toContain('DEV_OPEN_SESSIONS');
  });

  it('gates every route on something', () => {
    // Any registration whose body calls neither helper is a hole. /health is
    // the one deliberate exception.
    const holes: string[] = [];
    for (const m of router.matchAll(/\n  app\.(get|post|put|delete|all)\('([^']+)'/g)) {
      const [, method, path] = m;
      if (path === '/health') continue;
      const body = handlerFor(method!, path!);
      if (!body.includes('requireServiceAuth(') && !body.includes('requireBrowserAuth(')) {
        holes.push(`${method!.toUpperCase()} ${path}`);
      }
    }
    expect(holes, `routes with no auth check: ${holes.join(', ')}`).toEqual([]);
  });
});
