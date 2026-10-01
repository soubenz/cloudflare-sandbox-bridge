/**
 * Where to send someone after they sign in: the page they asked for, if it is a
 * page of this console and nothing else.
 *
 * The login page is served at the URL that was requested (the Worker answers a
 * deep link such as /labs/x/session with the login form when there is no
 * cookie), and after a successful sign-in the browser goes back there. The
 * address can also be given as `?next=/labs/x`. Either way it is attacker-
 * controllable text, so it is reduced here to a same-origin path or to "/":
 * an open redirect through a sign-in link is the classic way this goes wrong.
 *
 * Accepted: a path that starts with exactly one "/", has no backslash and no
 * control character (raw or percent-encoded), still has exactly one leading
 * "/" after dot segments are resolved, and is not the Worker's own (/api, /auth,
 * /dist, /login.js). Its query string is kept (minus `next`); a fragment is not.
 * Everything else is "/". Never throws.
 */

const BASE = 'https://console.invalid';
const MAX_LENGTH = 2048;
const HOSTILE = /[\\\u0000-\u001f\u007f]/;
const OWN = [/^\/api(\/|$)/, /^\/auth(\/|$)/, /^\/dist(\/|$)/, /^\/login\.js$/];

export function safeReturnPath(raw) {
  try {
    if (typeof raw !== 'string' || raw === '' || raw.length > MAX_LENGTH) return '/';
    if (raw[0] !== '/' || raw[1] === '/') return '/';
    if (HOSTILE.test(raw)) return '/';
    // A percent-encoded backslash or control character is the same attack one decode later.
    if (HOSTILE.test(decodeURIComponent(raw))) return '/';
    const url = new URL(raw, BASE);
    if (url.origin !== BASE) return '/';
    // "/.//evil.com" resolves to "//evil.com", which a browser reads as another host.
    if (url.pathname.startsWith('//')) return '/';
    if (OWN.some((re) => re.test(url.pathname))) return '/';
    if (url.searchParams.has('next')) url.searchParams.delete('next');
    return url.pathname + url.search;
  } catch {
    return '/';
  }
}

/**
 * The page to return to for a request to the login page: an explicit `?next=`
 * if there is one (valid or not: a bad one means "/", not "whatever else is in
 * the URL"), else the page that was asked for.
 */
export function returnPathFor(url) {
  const next = url.searchParams.get('next');
  return next !== null ? safeReturnPath(next) : safeReturnPath(url.pathname + url.search);
}
