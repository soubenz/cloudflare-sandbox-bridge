import { describe, it, expect } from 'vitest';

/**
 * The router (dashboard/src/router.js): which link clicks it takes over (pure functions, so every
 * modifier key is pinned) and how navigate/popstate/click move a history. The History API is replaced
 * by a small stand-in; the real one is exercised by test/e2e/20-routes.spec.ts.
 */
type Ev = { button?: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; defaultPrevented?: boolean };
type Link = { href: string | null; target?: string | null; hasDownload?: boolean; native?: boolean; rel?: string | null };
const m = (await import('../../dashboard/src/router.js' as string)) as {
  isAppPath: (p: unknown) => boolean;
  linkTarget: (e: Ev | null, l: Link | null, origin: string) => string | null;
  createRouter: (o: { win: unknown }) => {
    current: () => { name: string; [k: string]: unknown };
    navigate: (name: string, params?: Record<string, unknown>, o?: { replace?: boolean; silent?: boolean }) => { name: string };
    open: (url: string, o?: { replace?: boolean }) => void;
    onRoute: (h: (route: { name: string }, o: { source: string }) => void) => () => void;
    start: () => void;
  };
};

const ORIGIN = 'https://console.test';
const click = (over: Ev = {}): Ev => ({ button: 0, ...over });
const t = (href: string | null, link: Partial<Link> = {}, ev: Ev = {}) => m.linkTarget(click(ev), { href, ...link }, ORIGIN);

describe('isAppPath', () => {
  it('is true for the app addresses and false for what the Worker or the file server answers', () => {
    for (const ok of ['/', '/labs/x', '/labs/x/session/checks', '/paths/p', '/onboarding', '/no-such-page', '/labs/x/', '/u/console/labs/x/session/s1', '/u/console/labs/x/session/s1/service/echo', '/paths/p/modules/2']) expect(m.isAppPath(ok), ok).toBe(true);
    for (const no of ['/api/labs', '/api', '/auth/logout', '/auth', '/dist/app.js', '/login.js', '/styles.css', '/diagrams-demo.html', '/x/y.map', '//evil.example', '', 'labs/x', null, undefined, 3]) {
      expect(m.isAppPath(no as string), String(no)).toBe(false);
    }
  });
});

describe('linkTarget', () => {
  it('takes a plain same-origin app link, path and query', () => {
    expect(t('/labs/x')).toBe('/labs/x');
    expect(t('/labs/x/lessons?a=1')).toBe('/labs/x/lessons?a=1');
    expect(t(`${ORIGIN}/labs/x`)).toBe('/labs/x');
    expect(t('/')).toBe('/');
    expect(t('/labs/x#frag')).toBe('/labs/x');
  });

  it('leaves every modified click to the browser (a new tab or window)', () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) expect(t('/labs/x', {}, mod), JSON.stringify(mod)).toBeNull();
    // Middle and right button.
    expect(t('/labs/x', {}, { button: 1 })).toBeNull();
    expect(t('/labs/x', {}, { button: 2 })).toBeNull();
    // A click something already handled.
    expect(t('/labs/x', {}, { defaultPrevented: true })).toBeNull();
  });

  it('leaves links that are not ours', () => {
    expect(t('https://evil.example/labs/x')).toBeNull();
    expect(t('//evil.example/labs/x')).toBeNull();
    expect(t('mailto:a@b.c')).toBeNull();
    expect(t('javascript:alert(1)')).toBeNull();
    expect(t('#paths')).toBeNull();
    expect(t('')).toBeNull();
    expect(t(null)).toBeNull();
    expect(t('/labs/x', { target: '_blank' })).toBeNull();
    expect(t('/labs/x', { target: '_self' })).toBe('/labs/x');
    expect(t('/labs/x', { hasDownload: true })).toBeNull();
    expect(t('/labs/x', { native: true })).toBeNull();
    expect(t('/labs/x', { rel: 'noopener external' })).toBeNull();
    // The Worker's own paths and files.
    for (const p of ['/api/labs', '/auth/logout', '/dist/app.js', '/login.js', '/comic.css']) expect(t(p), p).toBeNull();
    expect(m.linkTarget(null, { href: '/labs/x' }, ORIGIN)).toBeNull();
    expect(m.linkTarget(click(), null, ORIGIN)).toBeNull();
  });
});

/** A History API with just enough in it: a stack, an index, popstate on go(). */
function fakeWindow(start = '/') {
  const stack: string[] = [start];
  let at = 0;
  const listeners: Record<string, Array<(e?: unknown) => void>> = {};
  const clicks: Array<(e: unknown) => void> = [];
  const win = {
    location: {
      origin: ORIGIN,
      get pathname() {
        return new URL(stack[at]!, ORIGIN).pathname;
      },
      get search() {
        return new URL(stack[at]!, ORIGIN).search;
      },
    },
    history: {
      state: null,
      pushState(_s: unknown, _t: string, url: string) {
        stack.splice(at + 1);
        stack.push(url);
        at++;
      },
      replaceState(_s: unknown, _t: string, url: string) {
        stack[at] = url;
      },
      go(delta: number) {
        at = Math.max(0, Math.min(stack.length - 1, at + delta));
        for (const l of listeners.popstate ?? []) l();
      },
      get length() {
        return stack.length;
      },
    },
    addEventListener(type: string, l: () => void) {
      (listeners[type] ??= []).push(l);
    },
    document: {
      addEventListener(_type: string, l: (e: unknown) => void) {
        clicks.push(l);
      },
    },
  };
  return { win, stack, at: () => at, clicks };
}

describe('createRouter', () => {
  it('navigate pushes (or replaces), keeps the query, and tells the handlers', () => {
    const f = fakeWindow('/?comicTest=1');
    const router = m.createRouter({ win: f.win });
    const seen: Array<[string, string]> = [];
    router.onRoute((route, { source }) => seen.push([route.name, source]));

    router.navigate('lab', { slug: 'x1' });
    expect(f.stack).toEqual(['/?comicTest=1', '/labs/x1?comicTest=1']);
    router.navigate('lab-step', { slug: 'x1', step: 'story' }, { replace: true });
    expect(f.stack).toEqual(['/?comicTest=1', '/labs/x1/story?comicTest=1']);
    router.navigate('launcher', { search: '' });
    expect(f.stack.at(-1)).toBe('/');
    expect(seen).toEqual([
      ['lab', 'navigate'],
      ['lab-step', 'navigate'],
      ['launcher', 'navigate'],
    ]);
  });

  it('silent moves the address without telling anyone, and the same address is not pushed twice', () => {
    const f = fakeWindow('/');
    const router = m.createRouter({ win: f.win });
    let calls = 0;
    router.onRoute(() => calls++);
    router.navigate('session', { slug: 'x1' }, { silent: true });
    router.navigate('session', { slug: 'x1' }, { silent: true });
    expect(f.stack).toEqual(['/', '/labs/x1/session']);
    expect(calls).toBe(0);
    expect(router.current()).toMatchObject({ name: 'session', slug: 'x1' });
  });

  it('replaceState on a tab change leaves the history length alone', () => {
    const f = fakeWindow('/');
    const router = m.createRouter({ win: f.win });
    router.navigate('session', { slug: 'x1' }, { silent: true });
    const length = f.win.history.length;
    for (const tab of ['checks', 'hints', 'terminal', 'brief']) router.navigate('session', { slug: 'x1', tab }, { replace: true, silent: true });
    router.navigate('session', { slug: 'x1', tab: 'service', service: 'echo' }, { replace: true, silent: true });
    expect(f.win.history.length).toBe(length);
    expect(f.stack.at(-1)).toBe('/labs/x1/session/service/echo');
  });

  it('popstate (Back and Forward) tells the handlers the route that is now showing', () => {
    const f = fakeWindow('/');
    const router = m.createRouter({ win: f.win });
    router.start();
    router.navigate('lab-step', { slug: 'x1', step: 'story' }, { silent: true });
    router.navigate('lab-step', { slug: 'x1', step: 'lessons' }, { silent: true });
    const seen: string[] = [];
    router.onRoute((route, { source }) => seen.push(`${route.name}:${(route as { step?: string }).step ?? ''}:${source}`));
    f.win.history.go(-1);
    f.win.history.go(-1);
    f.win.history.go(1);
    expect(seen).toEqual(['lab-step:story:popstate', 'launcher::popstate', 'lab-step:story:popstate']);
  });

  it('an address that is no route is a not-found route, not an error', () => {
    const f = fakeWindow('/labs/%2e%2e/x');
    const router = m.createRouter({ win: f.win });
    expect(router.current().name).toBe('not-found');
  });

  it('open() moves to a path taken from a link', () => {
    const f = fakeWindow('/');
    const router = m.createRouter({ win: f.win });
    const seen: string[] = [];
    router.onRoute((route, { source }) => seen.push(`${route.name}:${source}`));
    router.open('/labs/x1/session');
    expect(f.stack.at(-1)).toBe('/labs/x1/session');
    expect(seen).toEqual(['session:link']);
  });

  it('the click listener intercepts a plain app link and leaves a modified one alone', () => {
    const f = fakeWindow('/');
    const router = m.createRouter({ win: f.win });
    router.start();
    router.start(); // idempotent
    expect(f.clicks).toHaveLength(1);
    const seen: string[] = [];
    router.onRoute((route) => seen.push(route.name));
    const anchor = (href: string, extra: Record<string, string | null> = {}) => ({
      getAttribute: (n: string) => (n === 'href' ? href : (extra[n] ?? null)),
      hasAttribute: (n: string) => n in extra && extra[n] !== undefined,
    });
    const event = (a: ReturnType<typeof anchor>, over: Ev = {}) => {
      let prevented = false;
      const e = { button: 0, target: { closest: () => a }, preventDefault: () => (prevented = true), ...over };
      f.clicks[0]!(e);
      return prevented;
    };
    expect(event(anchor('/labs/x1'))).toBe(true);
    expect(f.stack.at(-1)).toBe('/labs/x1');
    expect(event(anchor('/labs/x2'), { ctrlKey: true })).toBe(false);
    expect(event(anchor('/labs/x3'), { button: 1 })).toBe(false);
    expect(event(anchor('https://evil.example/'))).toBe(false);
    expect(event(anchor('/api/labs'))).toBe(false);
    expect(event(anchor('/labs/x4', { 'data-native': '' }))).toBe(false);
    expect(f.stack.at(-1)).toBe('/labs/x1');
    expect(seen).toEqual(['lab']);
  });
});
