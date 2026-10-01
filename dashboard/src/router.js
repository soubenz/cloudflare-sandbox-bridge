/**
 * A thin router over the History API. routes.js says what a URL means; this
 * moves the address bar and tells app.js when the learner moved by themselves
 * (Back, Forward, a link).
 *
 *   const router = createRouter();
 *   router.onRoute((route, { source }) => show(route));   // 'popstate' | 'link' | 'navigate'
 *   router.start();                                        // popstate + link clicks
 *   router.navigate('lab-step', { slug, step: 'lessons' });          // pushState, then onRoute
 *   router.navigate('session', { slug, tab: 'hints' }, { replace: true, silent: true });
 *
 * `silent` moves the URL without calling the handlers: for the screen that is
 * already showing and only needs its address to match. The query string is
 * kept from one URL to the next unless the params carry a `search` of their own.
 *
 * Links are intercepted when they are plain same-origin app links; anything a
 * browser does better (a new tab, a download, a file, /api and /auth) is left to it.
 * The decisions are `linkTarget` and `isAppPath`, pure so a test can pin them.
 */
import { buildRoute, parseRoute } from './routes.js';

/** Paths the Worker owns or serves as files: never an app route, never intercepted. */
const RESERVED = [/^\/api(\/|$)/, /^\/auth(\/|$)/, /^\/dist(\/|$)/, /^\/login\.js$/];

/** True for a pathname that the app (rather than the Worker or the file server) answers. */
export function isAppPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) return false;
  if (RESERVED.some((re) => re.test(pathname))) return false;
  // A file name (styles.css, diagrams-demo.html) is a static asset.
  const last = pathname.replace(/\/+$/, '').split('/').pop() ?? '';
  return !/\.[A-Za-z0-9]{1,8}$/.test(last);
}

/**
 * The URL (path + search) a click on a link should navigate to inside the app, or
 * null when the browser should handle it.
 *
 *   event   { button, ctrlKey, metaKey, shiftKey, altKey, defaultPrevented }
 *   link    { href (attribute), target, hasDownload, native (data-native), rel }
 *   origin  the page's origin
 *
 * `href` is resolved against `origin`; a link to another origin, a mailto:, a
 * bare #fragment, a download or a target=_blank link is not ours. Modified clicks
 * (ctrl, cmd, shift, alt, middle button) open new tabs and windows in the browser.
 */
export function linkTarget(event, link, origin) {
  if (!event || !link) return null;
  if (event.defaultPrevented) return null;
  if (event.button !== undefined && event.button !== 0) return null;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return null;
  if (link.hasDownload || link.native) return null;
  if (link.target && link.target !== '_self') return null;
  if (typeof link.rel === 'string' && /\bexternal\b/.test(link.rel)) return null;
  const href = link.href;
  if (typeof href !== 'string' || href === '' || href.startsWith('#')) return null;
  let url;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (!isAppPath(url.pathname)) return null;
  return url.pathname + url.search;
}

/** The router. `win` is injectable so a test can drive it with a stand-in. */
export function createRouter({ win = globalThis.window } = {}) {
  const handlers = new Set();
  let started = false;

  const current = () => parseRoute(win.location.pathname, win.location.search);
  const emit = (route, source) => {
    for (const h of [...handlers]) h(route, { source });
  };

  function navigate(name, params = {}, { replace = false, silent = false } = {}) {
    const search = params.search ?? win.location.search;
    const path = buildRoute(name, { ...params, search });
    const here = win.location.pathname + win.location.search;
    if (path !== here) {
      if (replace) win.history.replaceState(win.history.state, '', path);
      else win.history.pushState(null, '', path);
    }
    const route = current();
    if (!silent) emit(route, 'navigate');
    return route;
  }

  /** Moves to a URL taken from a link (already checked by linkTarget). */
  function open(url, { replace = false } = {}) {
    if (url !== win.location.pathname + win.location.search) {
      if (replace) win.history.replaceState(null, '', url);
      else win.history.pushState(null, '', url);
    }
    emit(current(), 'link');
  }

  function onClick(event) {
    const anchor = event.target?.closest?.('a[data-route], a[href^="/"]');
    if (!anchor) return;
    const target = linkTarget(
      event,
      {
        href: anchor.getAttribute('href'),
        target: anchor.getAttribute('target'),
        hasDownload: anchor.hasAttribute('download'),
        native: anchor.hasAttribute('data-native'),
        rel: anchor.getAttribute('rel'),
      },
      win.location.origin
    );
    if (!target) return;
    event.preventDefault();
    open(target);
  }

  return {
    current,
    navigate,
    open,
    onRoute(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    start() {
      if (started) return;
      started = true;
      win.addEventListener('popstate', () => emit(current(), 'popstate'));
      win.document.addEventListener('click', onClick);
    },
  };
}
