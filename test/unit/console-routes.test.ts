import { describe, it, expect } from 'vitest';

/**
 * The console's URLs (dashboard/src/routes.js): what an address means, the address a screen has,
 * and the tab title it wears. Pure module, imported directly. The table is in docs/console-routes.md.
 */
type Route = { name: string; search: string; [k: string]: unknown };
const r = (await import('../../dashboard/src/routes.js' as string)) as {
  parseRoute: (pathname: unknown, search?: unknown) => Route;
  buildRoute: (name: string, params?: Record<string, unknown>) => string;
  routeTitle: (route: unknown, labTitle?: string | null, titles?: { path?: string; module?: string }) => string;
  SLUG: RegExp;
  OPAQUE_ID: RegExp;
  isSlug: (s: unknown) => boolean;
  isOpaqueId: (s: unknown) => boolean;
};

const parse = (p: string, q = '') => r.parseRoute(p, q);
const without = ({ search: _search, ...rest }: Route) => rest;

describe('parseRoute', () => {
  it('reads every route of the table', () => {
    expect(without(parse('/'))).toEqual({ name: 'launcher' });
    expect(without(parse('/paths/ai-platform'))).toEqual({ name: 'path', path: 'ai-platform' });
    expect(without(parse('/paths/ai-platform/modules/3'))).toEqual({ name: 'module', path: 'ai-platform', module: 3 });
    expect(without(parse('/paths/other'))).toEqual({ name: 'path', path: 'other' });
    expect(without(parse('/onboarding'))).toEqual({ name: 'onboarding' });
    expect(without(parse('/labs/see-what-a-gateway-does'))).toEqual({ name: 'lab', slug: 'see-what-a-gateway-does' });
    for (const step of ['story', 'questions', 'lessons']) {
      expect(without(parse(`/labs/x1/${step}`))).toEqual({ name: 'lab-step', slug: 'x1', step });
    }
    expect(without(parse('/labs/x1/session'))).toEqual({ name: 'session', slug: 'x1' });
    for (const tab of ['brief', 'questions', 'hints', 'checks', 'solution', 'terminal', 'editor']) {
      expect(without(parse(`/labs/x1/session/${tab}`))).toEqual({ name: 'session', slug: 'x1', tab });
    }
    expect(without(parse('/labs/x1/session/service/litellm'))).toEqual({ name: 'session', slug: 'x1', tab: 'service', service: 'litellm' });
  });

  it('reads the new session address: the learner\'s id, the lab, the session\'s id and the tab', () => {
    const base = { name: 'session', slug: 'x1', userId: 'console', sessionId: '01j9zzzzzzzzzzzzzzzzzzzzzz' };
    expect(without(parse('/u/console/labs/x1/session/01j9zzzzzzzzzzzzzzzzzzzzzz'))).toEqual(base);
    for (const tab of ['brief', 'questions', 'hints', 'checks', 'solution', 'terminal', 'editor']) {
      expect(without(parse(`/u/console/labs/x1/session/01j9zzzzzzzzzzzzzzzzzzzzzz/${tab}`))).toEqual({ ...base, tab });
    }
    expect(without(parse('/u/console/labs/x1/session/01j9zzzzzzzzzzzzzzzzzzzzzz/service/litellm'))).toEqual({ ...base, tab: 'service', service: 'litellm' });
    // A tab that is nothing keeps the session, flagged, as in the old form.
    expect(parse('/u/console/labs/x1/session/01j9zzzzzzzzzzzzzzzzzzzzzz/nope').invalidTab).toBe(true);
    expect(parse('/u/console/labs/x1/session/01j9zzzzzzzzzzzzzzzzzzzzzz/service').invalidTab).toBe(true);
  });

  it('reads the old session address with no ids: it is the one that starts or rejoins', () => {
    const route = parse('/labs/x1/session/hints');
    expect(route.userId).toBeUndefined();
    expect(route.sessionId).toBeUndefined();
  });

  it('round-trips every route through buildRoute', () => {
    const paths = [
      '/',
      '/paths/ai-platform',
      '/paths/ai-platform/modules/12',
      '/onboarding',
      '/labs/a',
      '/labs/see-what-a-gateway-does/story',
      '/labs/see-what-a-gateway-does/questions',
      '/labs/see-what-a-gateway-does/lessons',
      '/labs/see-what-a-gateway-does/session',
      '/labs/see-what-a-gateway-does/session/brief',
      '/labs/see-what-a-gateway-does/session/questions',
      '/labs/see-what-a-gateway-does/session/hints',
      '/labs/see-what-a-gateway-does/session/checks',
      '/labs/see-what-a-gateway-does/session/solution',
      '/labs/see-what-a-gateway-does/session/terminal',
      '/labs/see-what-a-gateway-does/session/editor',
      '/labs/see-what-a-gateway-does/session/service/echo',
      '/labs/see-what-a-gateway-does/session/service/my.svc_2-x',
      '/u/console/labs/x1/session/01j9zzzzzzzzzzzzzzzzzzzzzz',
      '/u/u-1a2b3c/labs/x1/session/01J9ZZZZZZZZZZZZZZZZZZZZZZ/hints',
      '/u/console/labs/x1/session/s1/service/echo',
    ];
    for (const path of paths) {
      const { name, ...params } = parse(path);
      expect(name, path).not.toBe('not-found');
      expect(r.buildRoute(name, params), path).toBe(path);
    }
  });

  it('keeps the query, and builds it back', () => {
    const route = parse('/labs/x1/session/checks', '?comicTest=1&a=b');
    expect(route.search).toBe('?comicTest=1&a=b');
    const { name, ...params } = route;
    expect(r.buildRoute(name, params)).toBe('/labs/x1/session/checks?comicTest=1&a=b');
    expect(parse('/', '?x=1').search).toBe('?x=1');
    // No query, a bare "?", a fragment and junk are all "no query".
    for (const q of ['', '?', '#frag', 'x=1', undefined, null, 42]) expect(r.parseRoute('/', q).search, String(q)).toBe('');
    expect(parse('/', '?x=1#frag').search).toBe('?x=1');
    expect(parse('/', `?${'a'.repeat(5000)}`).search).toBe('');
  });

  it('treats trailing slashes as nothing', () => {
    expect(without(parse('/labs/x1/'))).toEqual({ name: 'lab', slug: 'x1' });
    expect(without(parse('/labs/x1/session///'))).toEqual({ name: 'session', slug: 'x1' });
    expect(without(parse('/paths/p1/'))).toEqual({ name: 'path', path: 'p1' });
    expect(without(parse('/onboarding/'))).toEqual({ name: 'onboarding' });
    expect(parse('//').name).toBe('launcher');
  });

  it('decodes percent-encoding once and validates what it finds', () => {
    // A slug cannot hold anything that needs encoding, so an encoded letter is still the letter ...
    expect(without(parse('/labs/%78%31'))).toEqual({ name: 'lab', slug: 'x1' });
    // ... and an encoded separator or dot-dot is no slug at all.
    for (const bad of ['/labs/%2e%2e', '/labs/%2E%2E/session', '/labs/a%2fb', '/labs/a%5cb', '/labs/%00', '/labs/%', '/labs/%E0%A4%A', '/labs/a%zz']) {
      expect(parse(bad).name, bad).toBe('not-found');
    }
  });

  it('does not throw on, or accept, hostile or odd input', () => {
    const bad = [
      '/labs/../x',
      '/labs/./x',
      '/labs/a//b',
      '//labs/x',
      '/labs//x',
      '/labs/',
      '/labs',
      '/labs/-x',
      '/labs/X',
      '/labs/a b',
      '/labs/a.b',
      '/labs/a_b',
      '/labs/café',
      '/labs/\u{1F600}',
      '/labs/‮',
      `/labs/${'a'.repeat(82)}`,
      '/labs/x1/lessons/extra',
      '/labs/x1/nope',
      '/labs/x1/Session',
      '/paths',
      '/paths/-x',
      '/paths/p1/modules',
      '/paths/p1/modules/0',
      '/paths/p1/modules/x',
      '/paths/p1/modules/1/extra',
      '/paths/p1/other',
      '/u',
      '/u/console',
      '/u/console/labs',
      '/u/console/labs/x1',
      '/u/console/labs/x1/session',
      '/u/console/labs/x1/lessons/s1',
      '/u/console/labs/X1/session/s1',
      '/u/console/lab/x1/session/s1',
      '/u/console/labs/x1/sessions/s1',
      '/u/con.sole/labs/x1/session/s1',
      '/u/me@example.com/labs/x1/session/s1',
      '/u/%40/labs/x1/session/s1',
      '/u/console/labs/x1/session/-s1',
      '/u/console/labs/x1/session/s1%2Fs2',
      `/u/${'a'.repeat(65)}/labs/x1/session/s1`,
      `/u/console/labs/x1/session/${'a'.repeat(65)}`,
      '/onboarding/x',
      '/Onboarding',
      '/api/labs',
      '/auth/login',
      '/something/else',
      'labs/x1',
      '',
      'https://evil.example/labs/x1',
      '\\labs\\x1',
    ];
    for (const path of bad) {
      let route: Route | undefined;
      expect(() => (route = parse(path)), path).not.toThrow();
      expect(route!.name, path).toBe('not-found');
    }
    // A slug at its limit is fine; one more is not.
    expect(parse(`/labs/${'a'.repeat(81)}`).name).toBe('lab');
    for (const junk of [undefined, null, 42, {}, [], true]) {
      expect(() => r.parseRoute(junk as unknown, junk as unknown), String(junk)).not.toThrow();
      expect(r.parseRoute(junk as unknown).name).toBe('not-found');
    }
  });

  it('keeps a session address whose tab is unknown, flagged, so the console can send it to the session', () => {
    for (const path of ['/labs/x1/session/nope', '/labs/x1/session/service', '/labs/x1/session/service/a/b', '/labs/x1/session/brief/extra', '/labs/x1/session/Brief']) {
      const route = parse(path);
      expect(route.name, path).toBe('session');
      expect(route.slug).toBe('x1');
      expect(route.invalidTab, path).toBe(true);
      expect(route.tab).toBeUndefined();
    }
  });

  it('records where a not-found route was, capped', () => {
    expect(parse('/nope/at/all').path).toBe('/nope/at/all');
    expect((parse(`/${'z'.repeat(500)}`).path as string).length).toBeLessThanOrEqual(200);
  });

  it('has no slot for a token, and a session id is only ever where the table puts it', () => {
    // A session id (a ULID) is not a lab slug, so it is not a lab, and /sessions/<id> is nothing.
    expect(parse('/labs/01J9ZZZZZZZZZZZZZZZZZZZZZZ').name).toBe('not-found');
    expect(parse('/sessions/01j9zzzzzzzzzzzzzzzzzzzzzz').name).toBe('not-found');
    expect(parse('/labs/x1/session/01j9zzzzzzzzzzzzzzzzzzzzzz').invalidTab).toBe(true);
    // The token has no key in any route: whatever the query says is only a query.
    expect(Object.keys(parse('/u/console/labs/x1/session/s1', '?token=secret'))).not.toContain('token');
  });
});

describe('parseRoute: the step of the flow', () => {
  it('reads ?step=N as the 1-based place in the flow, and leaves it out when there is none or it is not a plain number', () => {
    expect(without(parse('/labs/x1/questions', '?step=4'))).toEqual({ name: 'lab-step', slug: 'x1', step: 'questions', n: 4 });
    expect(without(parse('/labs/x1/lessons', '?a=b&step=12'))).toEqual({ name: 'lab-step', slug: 'x1', step: 'lessons', n: 12 });
    for (const bad of ['?step=0', '?step=-1', '?step=abc', '?step=', '?step=1.5', '?step=0003', '?step=99999', '?step=4x']) {
      expect(without(parse('/labs/x1/lessons', bad)), bad).toEqual({ name: 'lab-step', slug: 'x1', step: 'lessons' });
    }
    // The raw search stays as it was, for the rest of the console.
    expect(parse('/labs/x1/lessons', '?step=4').search).toBe('?step=4');
    // Only the three step addresses take it; anything else about them is still not found.
    expect(parse('/labs/x1/nope', '?step=4').name).toBe('not-found');
    expect(without(parse('/labs/x1/session', '?step=4'))).toEqual({ name: 'session', slug: 'x1' });
  });

  it('round-trips an address with a step', () => {
    const route = parse('/labs/x1/questions', '?step=4') as unknown as { name: string; slug: string; step: string; n: number };
    expect(r.buildRoute(route.name, route)).toBe('/labs/x1/questions?step=4');
  });
});

describe('buildRoute', () => {
  it('builds each route', () => {
    expect(r.buildRoute('launcher')).toBe('/');
    expect(r.buildRoute('onboarding')).toBe('/onboarding');
    expect(r.buildRoute('path', { path: 'ai-platform' })).toBe('/paths/ai-platform');
    expect(r.buildRoute('path', { path: 'ai-platform', module: 2 })).toBe('/paths/ai-platform/modules/2');
    expect(r.buildRoute('module', { path: 'ai-platform', module: 2 })).toBe('/paths/ai-platform/modules/2');
    expect(r.buildRoute('lab', { slug: 'x1' })).toBe('/labs/x1');
    expect(r.buildRoute('lab-step', { slug: 'x1', step: 'lessons' })).toBe('/labs/x1/lessons');
    expect(r.buildRoute('session', { slug: 'x1' })).toBe('/labs/x1/session');
    expect(r.buildRoute('session', { slug: 'x1', tab: 'hints' })).toBe('/labs/x1/session/hints');
    expect(r.buildRoute('session', { slug: 'x1', tab: 'service', service: 'echo' })).toBe('/labs/x1/session/service/echo');
    expect(r.buildRoute('launcher', { search: '?a=1' })).toBe('/?a=1');
  });

  it('builds the new session address when it has both ids, and the old one when it has neither', () => {
    const ids = { userId: 'console', sessionId: '01j9zzzzzzzzzzzzzzzzzzzzzz' };
    expect(r.buildRoute('session', { slug: 'x1', ...ids })).toBe('/u/console/labs/x1/session/01j9zzzzzzzzzzzzzzzzzzzzzz');
    expect(r.buildRoute('session', { slug: 'x1', ...ids, tab: 'hints' })).toBe('/u/console/labs/x1/session/01j9zzzzzzzzzzzzzzzzzzzzzz/hints');
    expect(r.buildRoute('session', { slug: 'x1', ...ids, tab: 'service', service: 'echo', search: '?comicTest=1' })).toBe(
      '/u/console/labs/x1/session/01j9zzzzzzzzzzzzzzzzzzzzzz/service/echo?comicTest=1'
    );
    expect(r.buildRoute('session', { slug: 'x1', userId: null, sessionId: undefined })).toBe('/labs/x1/session');
  });

  it('refuses a session address with one id, or an id that is not opaque (an email, a path)', () => {
    expect(() => r.buildRoute('session', { slug: 'x1', userId: 'console' })).toThrow(RangeError);
    expect(() => r.buildRoute('session', { slug: 'x1', sessionId: 's1' })).toThrow(RangeError);
    for (const bad of ['me@example.com', 'a/b', '../x', '', ' ', 'a b', 'x'.repeat(65)]) {
      expect(() => r.buildRoute('session', { slug: 'x1', userId: bad || undefined, sessionId: 's1' }), bad).toThrow(RangeError);
      expect(() => r.buildRoute('session', { slug: 'x1', userId: 'console', sessionId: bad || undefined }), bad).toThrow(RangeError);
    }
  });

  it('puts the step of the flow in ?step=N, keeping other parameters, and carries it to no other route', () => {
    expect(r.buildRoute('lab-step', { slug: 'x1', step: 'questions', n: 4 })).toBe('/labs/x1/questions?step=4');
    expect(r.buildRoute('lab-step', { slug: 'x1', step: 'lessons', n: 5, search: '?comicTest=1' })).toBe('/labs/x1/lessons?comicTest=1&step=5');
    // A step already in the search is replaced, and dropped when the route has none.
    expect(r.buildRoute('lab-step', { slug: 'x1', step: 'lessons', n: 5, search: '?step=3&a=b' })).toBe('/labs/x1/lessons?a=b&step=5');
    expect(r.buildRoute('lab-step', { slug: 'x1', step: 'story', search: '?step=3&a=b' })).toBe('/labs/x1/story?a=b');
    expect(r.buildRoute('lab-step', { slug: 'x1', step: 'story', search: '?step=3' })).toBe('/labs/x1/story');
    expect(r.buildRoute('session', { slug: 'x1', search: '?step=3&a=b' })).toBe('/labs/x1/session?a=b');
    expect(r.buildRoute('launcher', { search: '?step=3' })).toBe('/');
    expect(() => r.buildRoute('lab-step', { slug: 'x1', step: 'lessons', n: 0 })).toThrow(RangeError);
    expect(() => r.buildRoute('lab-step', { slug: 'x1', step: 'lessons', n: 1.5 })).toThrow(RangeError);
    expect(() => r.buildRoute('lab-step', { slug: 'x1', step: 'lessons', n: 1000 })).toThrow(RangeError);
  });

  it('ignores params that do not belong to the route (a token cannot ride along)', () => {
    const url = r.buildRoute('session', { slug: 'x1', userId: 'console', sessionId: 's1', id: '01J9ZZZZZZZZZZZZZZZZZZZZZZ', token: 'secret' });
    expect(url).toBe('/u/console/labs/x1/session/s1');
    expect(url).not.toMatch(/01J9|secret/);
  });

  it('refuses params no address of the console could hold', () => {
    expect(() => r.buildRoute('lab', { slug: '../x' })).toThrow(RangeError);
    expect(() => r.buildRoute('lab', { slug: 'A' })).toThrow(RangeError);
    expect(() => r.buildRoute('lab', {})).toThrow(RangeError);
    expect(() => r.buildRoute('lab-step', { slug: 'x1', step: 'nope' })).toThrow(RangeError);
    expect(() => r.buildRoute('session', { slug: 'x1', tab: 'nope' })).toThrow(RangeError);
    expect(() => r.buildRoute('session', { slug: 'x1', tab: 'service' })).toThrow(RangeError);
    expect(() => r.buildRoute('session', { slug: 'x1', tab: 'service', service: 'a/b' })).toThrow(RangeError);
    expect(() => r.buildRoute('path', { path: 'p1', module: 0 })).toThrow(RangeError);
    expect(() => r.buildRoute('module', { path: 'p1' })).toThrow(RangeError);
    expect(() => r.buildRoute('module', { path: 'p1', module: 1.5 })).toThrow(RangeError);
    expect(() => r.buildRoute('nope')).toThrow(RangeError);
  });

  it('drops a search that is not one', () => {
    expect(r.buildRoute('launcher', { search: 'x=1' })).toBe('/');
    expect(r.buildRoute('launcher', { search: '?' })).toBe('/');
  });
});

describe('opaque ids', () => {
  it('accepts letters, numerals, _ and inner -, to 64 characters, and nothing that names a person', () => {
    for (const ok of ['console', 'u-1a2b3c4d', '01j9zzzzzzzzzzzzzzzzzzzzzz', '01J9ZZZZZZZZZZZZZZZZZZZZZZ', 'a', 'a'.repeat(64), 'a_b-c']) expect(r.isOpaqueId(ok), ok).toBe(true);
    for (const bad of ['', '-a', '_a', 'me@example.com', 'a.b', 'a b', 'a/b', 'a'.repeat(65), 'café', 1, null, undefined]) expect(r.isOpaqueId(bad), String(bad)).toBe(false);
    expect(r.OPAQUE_ID.source).toBe('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$');
  });
});

describe('slugs', () => {
  it('accepts lowercase letters, digits and inner hyphens, to 81 characters', () => {
    for (const ok of ['a', '0', 'a-b', 'see-what-a-gateway-does', `a${'-b'.repeat(40)}`, 'a'.repeat(81)]) expect(r.isSlug(ok), ok).toBe(true);
    for (const bad of ['', '-a', 'A', 'a_b', 'a.b', 'a b', 'a/b', 'a'.repeat(82), 'café', 1, null, undefined]) expect(r.isSlug(bad), String(bad)).toBe(false);
    expect(r.SLUG.source).toBe('^[a-z0-9][a-z0-9-]{0,80}$');
  });
});

describe('routeTitle', () => {
  const t = (name: string, extra: Record<string, unknown> = {}, lab: string | null = 'See what a gateway does') => r.routeTitle({ name, slug: 'see-what-a-gateway-does', ...extra }, lab);

  it('names the screen, the lab and the site', () => {
    expect(r.routeTitle({ name: 'launcher' })).toBe('Opalix labs');
    expect(r.routeTitle({ name: 'path', path: 'ai-platform' })).toBe('Opalix labs');
    expect(r.routeTitle({ name: 'path', path: 'ai-platform' }, null, { path: 'Building an AI platform' })).toBe('Building an AI platform · Opalix labs');
    expect(r.routeTitle({ name: 'module', path: 'ai-platform', module: 2 }, null, { path: 'Building an AI platform', module: 'Tools and MCP' })).toBe(
      'Tools and MCP · Building an AI platform · Opalix labs'
    );
    expect(r.routeTitle({ name: 'module', path: 'ai-platform', module: 2 })).toBe('Opalix labs');
    expect(t('lab')).toBe('See what a gateway does · Opalix labs');
    expect(t('lab-step', { step: 'story' })).toBe('See what a gateway does · Opalix labs');
    expect(t('lab-step', { step: 'questions' })).toBe('Quick questions · See what a gateway does · Opalix labs');
    expect(t('lab-step', { step: 'lessons' })).toBe('Lessons · See what a gateway does · Opalix labs');
    expect(t('session')).toBe('Session · See what a gateway does · Opalix labs');
    expect(r.routeTitle({ name: 'not-found', path: '/x' })).toBe('Not found · Opalix labs');
    expect(r.routeTitle({ name: 'onboarding' })).toMatch(/Opalix labs$/);
  });

  it('falls back to the slug while the catalogue is not loaded, and never throws', () => {
    expect(t('lab', {}, null)).toBe('see-what-a-gateway-does · Opalix labs');
    expect(t('session', {}, null)).toBe('Session · see-what-a-gateway-does · Opalix labs');
    expect(r.routeTitle(undefined)).toBe('Opalix labs');
    expect(r.routeTitle({ name: 'who-knows' })).toBe('Opalix labs');
  });
});
