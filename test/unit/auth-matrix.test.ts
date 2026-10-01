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
const admin = readFileSync('src/admin.ts', 'utf8');

/** The body of `app.<method>('<path>', …)` up to the next route registration. */
function handlerFor(method: string, path: string, source: string = router): string {
  const needle = `app.${method}('${path}'`;
  const start = source.indexOf(needle);
  if (start === -1) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  const next = source.indexOf('\n  app.', start + needle.length);
  return source.slice(start, next === -1 ? undefined : next);
}

const SERVICE_KEY_ONLY: Array<[string, string]> = [
  ['post', '/sessions'],
  ['post', '/sessions/start'],
  ['get', '/sessions'],
  ['get', '/labs'],
  ['get', '/labs/:slug'],
  ['get', '/labs/:slug/learn'],
  ['get', '/labs/:slug/audio/:file'],
  ['post', '/labs/publish'],
  ['get', '/learn/onboarding'],
  ['post', '/learn/answers'],
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

/** The admin panel's routes live in src/admin.ts and are service-key only. */
const ADMIN_SERVICE_KEY_ONLY: Array<[string, string]> = [
  ['get', '/admin/sessions'],
  ['get', '/admin/usage/summary'],
  ['get', '/admin/users'],
  ['get', '/admin/waitlist'],
  ['get', '/admin/feedback'],
  ['get', '/admin/learning'],
  ['get', '/labs/:slug/versions'],
  ['post', '/labs/:slug/promote'],
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
  ['get', '/sessions/:id/solution'],
];

describe('route auth matrix', () => {
  it.each(ADMIN_SERVICE_KEY_ONLY)('admin: %s %s requires the service key and nothing weaker', (method, path) => {
    const body = handlerFor(method, path, admin);
    expect(body).toContain('requireServiceAuth(');
    expect(body).not.toContain('requireBrowserAuth(');
  });

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

  it('the solution route is session-token only, and is the only reader of solution.tgz', () => {
    // A service key must be refused exactly like the cookie route refuses it:
    // the reveal is the learner's view, and nothing else should be able to
    // pull a lab's answer with the shared key.
    const body = handlerFor('get', '/sessions/:id/solution');
    expect(body).toContain("auth.kind !== 'session'");
    expect(body).toContain('session_token_required');
    expect(body.indexOf("auth.kind !== 'session'")).toBeLessThan(body.indexOf('.status()'));
    // No catalogue or other route may build the key, so nothing else serves the file.
    expect(router.split('solutionKey(').length - 1, 'solutionKey( appears once in the router').toBe(1);
    expect(body).toContain('solutionKey(');
    expect(router).not.toMatch(/solution\.tgz/);
  });

  it('the learn routes take the service key only, like GET /labs/:slug, and never read checks or the solution', () => {
    // The console Worker reads a lab's learning content through the service
    // key; no session token is involved, and the bundle is only what
    // `labs publish` compiled from learn/.
    for (const [method, path] of [
      ['get', '/labs/:slug/learn'],
      ['get', '/learn/onboarding'],
      ['post', '/learn/answers'],
    ] as const) {
      const body = handlerFor(method, path);
      expect(body, `${method} ${path}`).toContain('requireServiceAuth(');
      expect(body, `${method} ${path}`).not.toContain('requireBrowserAuth(');
      expect(body, `${method} ${path}`).not.toMatch(/solutionKey\(|privateKey\(|workspaceKey\(/);
    }
    expect(handlerFor('get', '/labs/:slug/learn').indexOf('requireServiceAuth(')).toBeLessThan(handlerFor('get', '/labs/:slug/learn').indexOf('loadCurrentLearn('));
    // The answers table is anonymous: the route must not hand it an identity.
    const answers = handlerFor('post', '/learn/answers');
    expect(answers).not.toMatch(/user_id|uid|CF-Connecting-IP|x-forwarded-for|c\.req\.header\(/i);
  });

  it('the narration route takes the service key only and reads nothing but the lab\'s own audio files', () => {
    // Clips are what `labs publish` uploaded against the learn bundle's audio index; the console Worker
    // proxies them for a signed-in learner. Like the learn route it never touches checks/ or solution/.
    const body = handlerFor('get', '/labs/:slug/audio/:file');
    expect(body).toContain('requireServiceAuth(');
    expect(body).not.toContain('requireBrowserAuth(');
    expect(body).not.toMatch(/solutionKey\(|privateKey\(|workspaceKey\(/);
    expect(body.indexOf('requireServiceAuth(')).toBeLessThan(body.indexOf('audioKey('));
    expect(body).toContain('CLIP_FILE.test(file)');
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
    for (const m of admin.matchAll(/\n  app\.(get|post|put|delete|all)\('([^']+)'/g)) {
      const [, method, path] = m;
      if (!handlerFor(method!, path!, admin).includes('requireServiceAuth(')) holes.push(`admin ${method!.toUpperCase()} ${path}`);
    }
    expect(holes, `routes with no auth check: ${holes.join(', ')}`).toEqual([]);
  });
});
