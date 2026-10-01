/**
 * The console's URLs, as pure functions with no DOM: what a pathname means
 * (`parseRoute`), the pathname a screen has (`buildRoute`), and the page title
 * a screen wears (`routeTitle`). router.js moves the browser's history around
 * them; app.js decides what each route shows.
 *
 *   /                                  the launcher (all paths)
 *   /paths/<path>                      the launcher, scrolled to that learning path
 *   /paths/<path>/modules/<n>          ... or to one of its modules
 *   /onboarding                        the platform quiz
 *   /labs/<slug>                       the lab's entry: its first "before you begin" step
 *   /labs/<slug>/story|questions|lessons[?step=N]
 *                                      the steps before the lab starts: N is the step's place in the
 *                                      flow (story, round 1, lessons, round 2 ...); without it, the first
 *                                      step of that kind
 *   /labs/<slug>/session               starts the lab, or rejoins it when it is running
 *   /labs/<slug>/session/brief|questions|hints|checks|solution
 *                                      the guide's tabs
 *   /labs/<slug>/session/terminal|editor
 *   /labs/<slug>/session/service/<name>
 *                                      the workspace window's tabs
 *   anything else                      { name: 'not-found' }
 *
 * A URL names a lab and a place in it, never a session: no session id and no
 * token is ever part of one, so a link is safe to send to someone else (it
 * starts the lab for them, or rejoins theirs).
 *
 * `parseRoute` never throws, whatever it is given.
 */

/** A lab or path slug as the console accepts one in a URL. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
/** A service's name as it appears in /session/service/<name>. */
export const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const MODULE_NUMBER = /^[1-9][0-9]{0,2}$/;

/** The steps before a lab starts, in the order the flow shows them. */
export const LAB_STEPS = ['story', 'questions', 'lessons'];
/** The guide's tabs, as they are spelled in a URL. */
export const GUIDE_TAB_NAMES = ['brief', 'questions', 'hints', 'checks', 'solution'];
/** The workspace window's tabs without a name of their own (a service's is `service/<name>`). */
export const VIEW_TAB_NAMES = ['terminal', 'editor'];

const MAX_SEARCH = 2048;
const MAX_NOT_FOUND_PATH = 200;

export const isSlug = (s) => typeof s === 'string' && SLUG.test(s);

/** '?a=b' or '', never longer than a sane query. */
function cleanSearch(search) {
  if (typeof search !== 'string') return '';
  // A fragment is not part of a search, and the console never keeps one.
  const s = search.split('#')[0];
  return s.length > 1 && s.length <= MAX_SEARCH && s.startsWith('?') ? s : '';
}

const STEP_NUMBER = /^[1-9][0-9]{0,2}$/;

/** The `step` of a search ('?a=b&step=3'): its number, or null when there is none or it is not a plain 1-999. */
function stepParam(search) {
  for (const part of search.slice(1).split('&')) {
    const [key, value = ''] = part.split('=');
    if (key === 'step') return STEP_NUMBER.test(value) ? Number(value) : null;
  }
  return null;
}

/**
 * A search with its `step` replaced by `n` (or dropped, for null), every other parameter as it was.
 * `step` belongs to the flow's own address: it must not be carried to the lab's other screens.
 */
function withStep(search, n) {
  const kept = search.length > 1 ? search.slice(1).split('&').filter((part) => part.split('=')[0] !== 'step') : [];
  if (n !== null) kept.push(`step=${n}`);
  return kept.length ? `?${kept.join('&')}` : '';
}

/** One path segment decoded, or null when it is not valid percent-encoding or hides a separator. */
function decodeSegment(raw) {
  let s;
  try {
    s = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (s === '' || /[\\/\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

const notFound = (pathname, search) => ({
  name: 'not-found',
  path: typeof pathname === 'string' ? pathname.slice(0, MAX_NOT_FOUND_PATH) : '',
  search,
});

/**
 * The route a location stands for.
 *
 *   { name: 'launcher' }
 *   { name: 'path', path, module? }
 *   { name: 'onboarding' }
 *   { name: 'lab', slug }
 *   { name: 'lab-step', slug, step, n? }   n: the `?step=N` place in the flow (1-based), when the address has a valid one
 *   { name: 'session', slug, tab?, service?, invalidTab? }
 *   { name: 'not-found', path }
 *
 * Every result carries `search` ('?x=y' or ''). `tab` is a guide tab, 'terminal',
 * 'editor' or 'service' (with `service` the name). A session URL whose last part
 * is not a tab at all keeps its lab and says `invalidTab`, so the console can
 * send the learner to the session itself rather than to a dead end.
 */
export function parseRoute(pathname, search = '') {
  const q = cleanSearch(search);
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return notFound(pathname, q);

  // Trailing slashes mean nothing: /labs/x/ is /labs/x.
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed === '') return { name: 'launcher', search: q };

  const raw = trimmed.slice(1).split('/');
  const parts = [];
  for (const r of raw) {
    const d = decodeSegment(r);
    if (d === null) return notFound(trimmed, q);
    parts.push(d);
  }
  const [head, ...rest] = parts;

  if (head === 'onboarding') return rest.length === 0 ? { name: 'onboarding', search: q } : notFound(trimmed, q);

  if (head === 'paths') {
    if (!isSlug(rest[0])) return notFound(trimmed, q);
    if (rest.length === 1) return { name: 'path', path: rest[0], search: q };
    if (rest.length === 3 && rest[1] === 'modules' && MODULE_NUMBER.test(rest[2])) {
      return { name: 'path', path: rest[0], module: Number(rest[2]), search: q };
    }
    return notFound(trimmed, q);
  }

  if (head === 'labs') {
    const slug = rest[0];
    if (!isSlug(slug)) return notFound(trimmed, q);
    const tail = rest.slice(1);
    if (tail.length === 0) return { name: 'lab', slug, search: q };
    if (tail[0] !== 'session') {
      if (!(tail.length === 1 && LAB_STEPS.includes(tail[0]))) return notFound(trimmed, q);
      // `?step=N` is the step's place in the whole flow (1-based): rounds and lesson chunks share /questions and /lessons.
      const n = stepParam(q);
      return { name: 'lab-step', slug, step: tail[0], ...(n === null ? {} : { n }), search: q };
    }
    const sub = tail.slice(1);
    const base = { name: 'session', slug, search: q };
    if (sub.length === 0) return base;
    if (sub.length === 1 && (GUIDE_TAB_NAMES.includes(sub[0]) || VIEW_TAB_NAMES.includes(sub[0]))) return { ...base, tab: sub[0] };
    if (sub.length === 2 && sub[0] === 'service' && SERVICE_NAME.test(sub[1])) return { ...base, tab: 'service', service: sub[1] };
    return { ...base, invalidTab: true };
  }

  return notFound(trimmed, q);
}

/**
 * The pathname (and `search`, when the params carry one) of a route. This one
 * does throw (a RangeError) on params that no URL of the console could hold:
 * that is a bug in the caller, not input to be tolerated.
 */
export function buildRoute(name, params = {}) {
  const need = (ok, what) => {
    if (!ok) throw new RangeError(`buildRoute(${name}): ${what}`);
  };
  const seg = encodeURIComponent;
  let path;
  let stepNumber = null;
  switch (name) {
    case 'launcher':
      path = '/';
      break;
    case 'onboarding':
      path = '/onboarding';
      break;
    case 'path':
      need(isSlug(params.path), 'path is not a slug');
      path = `/paths/${seg(params.path)}`;
      if (params.module !== undefined && params.module !== null) {
        need(Number.isInteger(params.module) && MODULE_NUMBER.test(String(params.module)), 'module is not a number');
        path += `/modules/${params.module}`;
      }
      break;
    case 'lab':
      need(isSlug(params.slug), 'slug is not a slug');
      path = `/labs/${seg(params.slug)}`;
      break;
    case 'lab-step':
      need(isSlug(params.slug), 'slug is not a slug');
      need(LAB_STEPS.includes(params.step), 'unknown step');
      path = `/labs/${seg(params.slug)}/${params.step}`;
      if (params.n !== undefined && params.n !== null) {
        need(Number.isInteger(params.n) && STEP_NUMBER.test(String(params.n)), 'step number is not a number');
        stepNumber = params.n;
      }
      break;
    case 'session': {
      need(isSlug(params.slug), 'slug is not a slug');
      path = `/labs/${seg(params.slug)}/session`;
      const { tab } = params;
      if (tab === undefined || tab === null || tab === '') break;
      if (tab === 'service') {
        need(typeof params.service === 'string' && SERVICE_NAME.test(params.service), 'service is not a service name');
        path += `/service/${seg(params.service)}`;
      } else {
        need(GUIDE_TAB_NAMES.includes(tab) || VIEW_TAB_NAMES.includes(tab), 'unknown tab');
        path += `/${tab}`;
      }
      break;
    }
    default:
      throw new RangeError(`buildRoute: unknown route "${name}"`);
  }
  return path + withStep(cleanSearch(params.search), stepNumber);
}

/**
 * What the tab of the browser says for a route. `labTitle` is the lab's title
 * (its slug when the catalogue has none), `null` when the lab is not known.
 */
export function routeTitle(route, labTitle = null) {
  const site = 'Opalix labs';
  const lab = typeof labTitle === 'string' && labTitle ? labTitle : (route?.slug ?? null);
  switch (route?.name) {
    case 'launcher':
    case 'path':
      return site;
    case 'onboarding':
      return `Platform quiz · ${site}`;
    case 'lab':
      return lab ? `${lab} · ${site}` : site;
    case 'lab-step': {
      const lead = route.step === 'lessons' ? 'Lessons' : route.step === 'questions' ? 'Quick questions' : null;
      return [lead, lab, site].filter(Boolean).join(' · ');
    }
    case 'session':
      return lab ? `Session · ${lab} · ${site}` : `Session · ${site}`;
    case 'not-found':
      return `Not found · ${site}`;
    default:
      return site;
  }
}
