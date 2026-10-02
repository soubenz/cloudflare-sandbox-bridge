import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { parse as parseYaml } from 'yaml';
import { serveConsole, serveWorker } from './console-server';

/**
 * Real addresses for the console: /, /paths/<path>, /paths/<path>/modules/<n>, /labs/<slug>,
 * /labs/<slug>/lessons, /u/<user>/labs/<slug>/session/<session>/hints ...
 * (dashboard/src/routes.js has the table, docs/console-routes.md the story).
 *
 * What is pinned here:
 *   - the launcher is four pages, not one: home (a card per path), a path (a card per module), a module
 *     (its intro beside its labs) and a lab (its own page), each with a breadcrumb trail, a search that
 *     acts on that page's labs, and an address that Back, Forward and a refresh keep;
 *   - a deep link opens the screen it names, and a refresh keeps the learner there;
 *   - Back and Forward move between screens (lessons -> story -> the lab's page), and Back out of a running
 *     lab goes to the lab's page, without ending it; home still carries the "lab running" card;
 *   - a session's address is /u/<user>/labs/<slug>/session/<session>[/<tab>]: the old address redirects
 *     to it once the session is known, another learner's id is "not found", a session that is not the
 *     learner's active one is "not active" (with Rejoin when they have another for the lab), and a
 *     refresh re-enters the same session; the token is never in an address;
 *   - /labs/<slug>/session starts the lab when nothing is running and rejoins it when something is;
 *   - a tab change inside the session replaces the address in place (the history does not grow);
 *   - an unknown lab, path, module, step or tab ends in "not found" or in the address that does exist;
 *   - a phone at a deep link gets the desktop notice, with that lab's own link;
 *   - the tab title follows the screen;
 *   - signing in returns to the page that was asked for, and never to another site (the real Worker
 *     serves the gate here, in front of the same files).
 *
 * Like 16 to 19 this needs no password for the console (except where the gate is the point), no API
 * and no container: a static server with the Worker's single-page-application fallback serves
 * dashboard/public, and every call the console makes is answered by a route stub. The learning content
 * is real (labs/see-what-a-gateway-does/learn) and the other labs are that bundle with parts taken away.
 *
 * Run `npm run build:dashboard` first.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC = join(ROOT, 'dashboard/public');
const API = 'https://opalix-sandbox.soubenz94.workers.dev';
const SESSION_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const OTHER_SESSION_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN = 'test-token';
/** The opaque id GET /api/me hands out for the signed-in learner, and so the `<user>` of a session's address. */
const USER_ID = 'console';
/** A session's address, as the console writes it. */
const sessionUrl = (slug: string, tab = '', id = SESSION_ID, user = USER_ID) => `/u/${user}/labs/${slug}/session/${id}${tab ? `/${tab}` : ''}`;

// --------------------------------------------------------------- the content

interface Bundle {
  story?: { title: string; minutes: number; body: string };
  comic?: unknown;
  concepts: Array<{ id: string; title: string; minutes: number; recap: string; body: string }>;
  questions: Array<Record<string, unknown>>;
  answers_file: string;
  fields: Array<Record<string, unknown>>;
}

/** The lab's learn/ folder as the bundle the API would serve it. */
function compileLearn(slug: string): Bundle {
  const dir = join(ROOT, 'labs', slug, 'learn');
  const split = (text: string) => {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)!;
    return { data: parseYaml(m[1]!) as Record<string, any>, body: m[2]!.trim() };
  };
  const story = split(readFileSync(join(dir, 'story.md'), 'utf8'));
  const concepts = readdirSync(join(dir, 'concepts'))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const { data, body } = split(readFileSync(join(dir, 'concepts', f), 'utf8'));
      return { order: typeof data.order === 'number' ? data.order : 100, id: data.id, title: data.title, minutes: data.minutes, recap: data.recap, body };
    })
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...c }) => c);
  const quiz = parseYaml(readFileSync(join(dir, 'quiz.yaml'), 'utf8')) as { questions: Array<Record<string, unknown>> };
  const qs = parseYaml(readFileSync(join(dir, 'questions.yaml'), 'utf8')) as { answers_file: string; fields: Array<Record<string, unknown>> };
  return {
    story: { title: story.data.title, minutes: story.data.minutes, body: story.body },
    concepts,
    questions: quiz.questions.map((q) => ({ diagnostic: true, ...q })),
    answers_file: qs.answers_file,
    fields: qs.fields,
  };
}

const full = compileLearn('see-what-a-gateway-does');

/** A lab with a story, lessons, quick questions and graded fields. */
const EXPLORE = 'see-what-a-gateway-does';
const EXPLORE_TITLE = 'See what a gateway does';
/** A story, and no lessons. */
const STORY_ONLY = 'a-story-and-no-lessons';
/** Lessons, and no story. */
const LESSONS_ONLY = 'lessons-and-no-story';
/** Lessons and no story, with quick questions: it begins at the questions. */
const LESSONS_ASKING = 'lessons-and-no-story-with-questions';
/** Nothing to read before it starts. */
const PLAIN = 'a-lab-with-nothing-to-read';
const PLAIN_TITLE = 'A lab with nothing to read';

const BUNDLES: Record<string, Bundle> = {
  [EXPLORE]: full,
  [STORY_ONLY]: { story: full.story, concepts: [], questions: [], answers_file: full.answers_file, fields: [] },
  [LESSONS_ONLY]: { ...full, story: undefined, questions: [], fields: [] },
  [LESSONS_ASKING]: { ...full, story: undefined, fields: [] },
};

const lab = (o: Record<string, unknown>) => ({
  version: '1.0.0',
  type: 'build',
  family: 'gateway',
  summary: `About ${o.slug}`,
  objectives: ['do the thing'],
  difficulty: 'intro',
  timeout_minutes: 30,
  estimated_minutes: 20,
  tier: 'free',
  path: 'ai-platform',
  module: 1,
  order: 1,
  has_learn: true,
  progress: null,
  ...o,
});
const LABS = [
  lab({ slug: EXPLORE, title: EXPLORE_TITLE, type: 'explore', order: 1 }),
  lab({ slug: STORY_ONLY, title: 'A story and no lessons', order: 2 }),
  lab({ slug: LESSONS_ONLY, title: 'Lessons and no story', order: 3 }),
  lab({ slug: LESSONS_ASKING, title: 'Lessons and no story, with questions', order: 4 }),
  lab({ slug: PLAIN, title: PLAIN_TITLE, order: 5, has_learn: false }),
];

// ------------------------------------------------------------- a fake console

const json = (route: Route, body: unknown, status = 200) => {
  const origin = route.request().headers()['origin'];
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {},
    body: JSON.stringify(body),
  });
};

interface Stub {
  /** Labs the console asked /api/start for. */
  starts: string[];
  /** Calls that would end a session. */
  ends: string[];
  /** Every call to the session's own routes (not GETs of status, files and events). */
  sessionCalls: string[];
  errors: string[];
  /** What the API says the remembered session is. */
  session: { state: string; lab: string | null };
  /** What GET /api/sessions/active says: derived from `session` by default, a fixed list, or null for a Worker without the route. */
  active: 'derive' | null | Array<{ id: string; lab: string; state: string }>;
  /** What GET /api/me says. */
  me: { sub: string; user_id: string };
}

async function stub(page: Page): Promise<Stub> {
  const waiting: Array<() => void> = [];
  const s: Stub = { starts: [], ends: [], sessionCalls: [], errors: [], session: { state: 'running', lab: null }, active: 'derive', me: { sub: 'console', user_id: USER_ID } };
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) s.errors.push(msg.text());
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === '/api/me') return json(route, s.me);
    if (path === '/api/sessions/active') {
      if (s.active === null) return json(route, { error: 'not found' }, 404);
      const live = s.session.lab && ['running', 'starting'].includes(s.session.state);
      return json(route, { sessions: s.active === 'derive' ? (live ? [{ id: SESSION_ID, lab: s.session.lab, state: s.session.state }] : []) : s.active });
    }
    if (path === '/api/labs') return json(route, LABS);
    if (path === '/api/onboarding') return json(route, { error: { code: 'no_onboarding', message: 'none' } }, 404);
    if (path === '/api/learn/answers' && method === 'POST') return json(route, { ok: true, recorded: 1 }, 201);
    if (path.startsWith('/api/learn/') && method === 'GET') {
      const slug = decodeURIComponent(path.slice('/api/learn/'.length));
      const b = BUNDLES[slug];
      return b ? json(route, { version: '1.0.0', learn: b }) : json(route, { error: { code: 'no_learn', message: 'no learning content' } }, 404);
    }
    if (path === '/api/start' && method === 'POST') {
      const { lab: slug } = JSON.parse(route.request().postData() ?? '{}');
      s.starts.push(slug);
      s.session = { state: 'running', lab: slug };
      return json(route, { id: SESSION_ID, state: 'starting', token: TOKEN, urls: { services: { echo: {} } } }, 202);
    }
    return json(route, { error: 'not stubbed' }, 404);
  });

  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const p = url.pathname;
    const base = `/sessions/${SESSION_ID}`;
    const cors = { 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'access-control-allow-credentials': 'true' };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (p.startsWith(base) && method !== 'GET') s.sessionCalls.push(`${method} ${p.slice(base.length) || '/'}`);
    if (p === base && method === 'GET') {
      const now = Date.now();
      return json(route, {
        meta: { state: s.session.state, lab_slug: s.session.lab ?? PLAIN, started_at: now, expires_at: now + 3_000_000, end_reason: null },
        services: { echo: { health: 'healthy' } },
        snapshots: [],
        cost: { usd: 0.03 },
        hints: { total: 3, schedule: [0, 12, 30], delivered: [] },
        manifest_summary: { title: 'A lab', checks: [{ name: 'support answered by a' }] },
        checks_history: [],
        server_time: now,
      });
    }
    if (p === base && method === 'DELETE') {
      s.ends.push(url.search);
      s.session.state = 'ended';
      return json(route, { ok: true });
    }
    if (p === `${base}/events`) {
      // Held open and silent: nothing here is about events.
      await new Promise<void>((resolveWait) => waiting.push(resolveWait));
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', ...cors, 'cache-control': 'no-store' }, body: '' });
    }
    if (p === `${base}/files` && method === 'GET') return json(route, [{ name: 'brief.md', size: 30, isDirectory: false }]);
    if (p === `${base}/files/brief.md` && method === 'GET') return json(route, { content: '# The brief\n\nSend a few calls.\n' });
    if (p.startsWith(`${base}/files/`) && method === 'GET') return json(route, { error: { code: 'not_found', message: 'no such file' } }, 404);
    if (p === `${base}/services/echo/session` && method === 'POST') return route.fulfill({ status: 204, headers: cors });
    if (p.startsWith(`${base}/services/echo/`) && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'text/html', headers: cors, body: '<!doctype html><title>echo</title><h1>Echo service</h1>' });
    }
    if (p.startsWith(base) && method !== 'GET') return json(route, {}, 200);
    return json(route, { error: 'not stubbed' }, 404);
  });

  await page.routeWebSocket(/\/terminal/, () => {});
  return s;
}

// ----------------------------------------------------------------- the server

const test = base.extend<object, { staticServer: string }>({
  staticServer: [
    async ({}, use) => {
      if (!existsSync(join(PUBLIC, 'dist/app.js'))) throw new Error('dashboard/public/dist/app.js is missing: run `npm run build:dashboard` first');
      const { url, server } = await serveConsole();
      await use(url);
      await new Promise((done) => server.close(done));
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ staticServer }, use) => use(staticServer),
});

// -------------------------------------------------------------------- helpers

type Mastery = { onboarding?: { status: 'done' | 'skipped' | null; at?: number; levels?: Record<string, string> }; concepts?: Record<string, { known: boolean }> };
const SKIPPED: Mastery = { onboarding: { status: 'skipped', at: 1, levels: {} } };
/** Every concept of the lab already known, so no question is asked. */
const ALL_KNOWN: Mastery = { ...SKIPPED, concepts: Object.fromEntries(full.concepts.map((c) => [c.id, { known: true }])) };

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

interface OpenOptions {
  mastery?: Mastery;
  /** A session this browser remembers (the lab it was started for). */
  remembered?: string;
}

/**
 * Opens the console on an address, past the things that are other specs' business. What the page
 * stores is seeded once per tab, so a reload in the test keeps what the page stored since. Every
 * address the page writes with pushState/replaceState is logged to sessionStorage (`__urls`).
 */
async function visit(page: Page, path: string, { mastery = ALL_KNOWN, remembered }: OpenOptions = {}) {
  await page.addInitScript(
    ([m, r]) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('opalixOnboarded', '1');
        localStorage.setItem('opalixLearn', m as string);
        if (r) localStorage.setItem('opalix.session', JSON.stringify({ id: (r as { id: string }).id, token: 'test-token', lab: (r as { lab: string }).lab, urls: { services: { echo: {} } } }));
        sessionStorage.setItem('seeded', '1');
      }
      const log = (u: unknown) => {
        try {
          const all = JSON.parse(sessionStorage.getItem('__urls') || '[]');
          all.push(String(u));
          sessionStorage.setItem('__urls', JSON.stringify(all));
        } catch {
          /* no storage, no log */
        }
      };
      if (location.protocol.startsWith('http')) log(location.pathname + location.search);
      for (const method of ['pushState', 'replaceState'] as const) {
        const original = history[method];
        history[method] = function (this: History, state: unknown, title: string, url?: string | URL | null) {
          if (url !== undefined && url !== null) log(url);
          return original.call(this, state, title, url);
        };
      }
    },
    [JSON.stringify({ v: 1, ...mastery }), remembered ? { id: SESSION_ID, lab: remembered } : null] as const
  );
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
}

const wide = (page: Page) => page.setViewportSize(WIDE);
const here_ = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search;
const historyLength = (page: Page) => page.evaluate(() => history.length);
const host = (page: Page) => page.locator('#learnHost');
const heading = (page: Page) => host(page).locator('[data-learn-heading]');
const LESSONS = 'Lessons for this lab';
const MODULE_1 = '/paths/ai-platform/modules/1';

/** Clicks through the pages to the module that holds the labs: home, its path, its module. */
async function openModule(page: Page) {
  await page.locator('#path-ai-platform .path-card-title a').click();
  await expect(page.locator('.module-card[data-module="1"]')).toBeVisible();
  await page.locator('.module-card[data-module="1"] .module-title a').click();
  await expect(page.locator('.module .lab').first()).toBeVisible();
  expect(here_(page)).toBe(MODULE_1);
}

/** Presses Start on a lab's row, finding its module through the pages first (from home). */
async function startCard(page: Page, slug: string) {
  if (!(await page.locator(`.lab[data-slug="${slug}"]`).count())) await openModule(page);
  await page.locator(`.lab[data-slug="${slug}"] .lab-start`).click();
}
const urlLog = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('__urls') || '[]') as string[]);

async function inSession(page: Page) {
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#statePill')).toHaveText('running');
  await expect(page.locator('#bootModal')).toBeHidden();
  await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
}

const TAB = 'brief|questions|hints|checks|solution|terminal|editor|service\\/[A-Za-z0-9._-]+';
const TABLE = new RegExp(
  `^/(?:$|onboarding$|paths/[a-z0-9-]+(?:/modules/\\d+)?$|labs/[a-z0-9-]+(?:/(?:story|questions|lessons|session(?:/(?:${TAB}))?))?$|u/[A-Za-z0-9_-]+/labs/[a-z0-9-]+/session/[A-Za-z0-9_-]+(?:/(?:${TAB}))?$)`
);

/**
 * No token is in what the address bar showed, a session id is only where the table puts it
 * (/u/<user>/labs/<slug>/session/<session>), and every address is one of the table in routes.js.
 */
async function noSecretsInAddresses(page: Page) {
  const urls = [here_(page), ...(await urlLog(page))];
  for (const u of urls) {
    expect(u, 'an address the page wrote').not.toMatch(new RegExp(`${TOKEN}|token=|@`, 'i'));
    const path = u.split('?')[0]!;
    if (path.includes(SESSION_ID)) expect(path, 'a session id outside a session address').toMatch(/^\/u\/[A-Za-z0-9_-]+\/labs\/[a-z0-9-]+\/session\/[A-Za-z0-9_-]+/);
    expect(path, 'an address the page wrote').toMatch(TABLE);
  }
}

/** The page is not wider than the window. */
const noHorizontalScroll = async (page: Page) => {
  const over = await page.evaluate(() => ({ extra: document.documentElement.scrollWidth - window.innerWidth }));
  expect(over.extra).toBeLessThanOrEqual(0);
};

// =========================================================================
// deep links into the steps before a lab
// =========================================================================

test.describe('the steps before a lab have addresses', () => {
  test('/labs/<slug>/lessons opens the lessons, and a refresh keeps the learner there', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await visit(page, `/labs/${EXPLORE}/lessons`);
    await expect(heading(page)).toHaveText(LESSONS);
    await expect(page.locator('#launcher')).toBeHidden();
    expect(here_(page)).toBe(`/labs/${EXPLORE}/lessons`);
    await expect(page).toHaveTitle(`Lessons · ${EXPLORE_TITLE} · Opalix labs`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(heading(page)).toHaveText(LESSONS);
    expect(here_(page)).toBe(`/labs/${EXPLORE}/lessons`);
    // Reading starts nothing.
    expect(s.starts).toEqual([]);
    expect(s.errors).toEqual([]);
    await noSecretsInAddresses(page);
  });

  test('/labs/<slug>/story opens the story, with the lab in the title; a refresh keeps it', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, `/labs/${EXPLORE}/story`);
    await expect(heading(page)).toHaveText(full.story!.title);
    await expect(page).toHaveTitle(`${EXPLORE_TITLE} · Opalix labs`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(heading(page)).toHaveText(full.story!.title);
    expect(here_(page)).toBe(`/labs/${EXPLORE}/story`);
  });

  test('/labs/<slug> is the lab\'s own page, not a step: it reads nothing and starts nothing, and Start there opens the first step', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    const before = await historyLength(page);
    await visit(page, `/labs/${EXPLORE}`);
    await expect(page.locator('.lab-detail')).toBeVisible();
    await expect(page.locator('.lab-detail-title')).toHaveText(EXPLORE_TITLE);
    await expect(page.locator('#learnScreen')).toBeHidden();
    expect(here_(page)).toBe(`/labs/${EXPLORE}`);
    expect(await historyLength(page)).toBe(before + 1);
    await expect(page).toHaveTitle(`${EXPLORE_TITLE} · Opalix labs`);

    await page.locator('.lab-detail .lab-start').click();
    await expect(heading(page)).toHaveText(full.story!.title);
    expect(here_(page)).toBe(`/labs/${EXPLORE}/story`);
    expect(await historyLength(page)).toBe(before + 2);
    // Back is the lab's page again.
    await page.goBack();
    await expect(page.locator('.lab-detail')).toBeVisible();
    expect(here_(page)).toBe(`/labs/${EXPLORE}`);
    expect(s.starts).toEqual([]);
  });

  test('a lab without a story begins at its lessons; one with questions due begins at them', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, `/labs/${LESSONS_ONLY}`);
    await page.locator('.lab-detail .lab-start').click();
    await expect(heading(page)).toHaveText(LESSONS);
    expect(here_(page)).toBe(`/labs/${LESSONS_ONLY}/lessons`);

    const asking = await page.context().newPage();
    await stub(asking);
    await visit(asking, `/labs/${LESSONS_ASKING}`, { mastery: SKIPPED });
    await asking.locator('.lab-detail .lab-start').click();
    await expect(asking.locator('#learnHost')).toContainText('A few quick questions');
    expect(here_(asking)).toBe(`/labs/${LESSONS_ASKING}/questions`);
    await expect(asking).toHaveTitle(`Quick questions · Lessons and no story, with questions · Opalix labs`);
  });

  test('a step the lab does not have opens the first one it does (address replaced)', async ({ page }) => {
    await stub(page);
    await wide(page);
    const before = await historyLength(page);
    await visit(page, `/labs/${STORY_ONLY}/lessons`);
    await expect(heading(page)).toHaveText(full.story!.title);
    expect(here_(page)).toBe(`/labs/${STORY_ONLY}/story`);
    expect(await historyLength(page)).toBe(before + 1);

    await page.goto(`/labs/${LESSONS_ONLY}/story`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(heading(page)).toHaveText(LESSONS);
    expect(here_(page)).toBe(`/labs/${LESSONS_ONLY}/lessons`);
    // Questions that are not due are skipped the same way.
    await page.goto(`/labs/${EXPLORE}/questions`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(heading(page)).toHaveText(LESSONS);
    expect(here_(page)).toBe(`/labs/${EXPLORE}/lessons`);
  });

  test('a lab with nothing to read has no steps: their addresses end at its own page, and nothing is started', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await visit(page, `/labs/${PLAIN}`);
    await expect(page.locator('.lab-detail')).toBeVisible();
    await expect(page.locator('.lab-detail-title')).toHaveText(PLAIN_TITLE);
    expect(here_(page)).toBe(`/labs/${PLAIN}`);
    await expect(page).toHaveTitle(`${PLAIN_TITLE} · Opalix labs`);
    // Its steps do not exist: they end up here too.
    await page.goto(`/labs/${PLAIN}/lessons`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('.lab-detail')).toBeVisible();
    expect(here_(page)).toBe(`/labs/${PLAIN}`);
    expect(s.starts).toEqual([]);
    await expect(page.locator('#workspace')).toBeHidden();
  });

  test('every step of the flow has its own address (rounds and lessons carry ?step=N past the first), and Back walks the steps', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, `/labs/${EXPLORE}/story`, { mastery: SKIPPED });
    await page.getByRole('button', { name: 'Continue' }).click();
    expect(here_(page)).toBe(`/labs/${EXPLORE}/questions`);
    await expect(page).toHaveTitle(`Quick questions · ${EXPLORE_TITLE} · Opalix labs`);
    const length = await historyLength(page);
    const answerRound = async () => {
      // The first option of every question: right or wrong does not matter to the address.
      while (await host(page).locator('.quiz-prompt').count()) {
        await host(page).locator('.quiz-option input').first().check();
        await page.getByRole('button', { name: 'Check', exact: true }).click();
        await host(page).locator('.quiz-form .learn-actions button').filter({ hasNotText: 'Check' }).click();
      }
    };
    await answerRound();
    // Round 1 -> lessons, part 1: one more entry, and the first lessons keep the plain /lessons.
    await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
    expect(here_(page)).toBe(`/labs/${EXPLORE}/lessons`);
    expect(await historyLength(page)).toBe(length + 1);
    await expect(page).toHaveTitle(`Lessons · ${EXPLORE_TITLE} · Opalix labs`);
    // On to Round 2 (the fourth step of six) and the second lessons (the fifth).
    await page.getByRole('button', { name: 'Continue to the questions' }).click();
    expect(here_(page)).toBe(`/labs/${EXPLORE}/questions?step=4`);
    await answerRound();
    await expect(heading(page)).toHaveText('Lessons, part 2 of 2');
    expect(here_(page)).toBe(`/labs/${EXPLORE}/lessons?step=5`);
    await expect(page).toHaveTitle(`Lessons · ${EXPLORE_TITLE} · Opalix labs`);
    expect(await historyLength(page)).toBe(length + 3);

    // Back walks the steps, one at a time; the address is the step's.
    await page.goBack();
    await expect(heading(page)).toHaveText('Round 2 of 3 · question 5 of 5');
    expect(here_(page)).toBe(`/labs/${EXPLORE}/questions?step=4`);
    await page.goBack();
    await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
    expect(here_(page)).toBe(`/labs/${EXPLORE}/lessons`);
    await page.goBack();
    await expect(heading(page)).toHaveText('Round 1 of 3 · question 5 of 5');
    expect(here_(page)).toBe(`/labs/${EXPLORE}/questions`);
    await page.goBack();
    await expect(heading(page)).toHaveText(full.story!.title);
    expect(here_(page)).toBe(`/labs/${EXPLORE}/story`);
    // Nothing was asked again: going Forward lands on answered questions.
    await page.goForward();
    await expect(heading(page)).toHaveText('Round 1 of 3 · question 5 of 5');
    await expect(page.getByRole('button', { name: 'Check', exact: true })).toHaveCount(0);
  });

  test('leaving the flow goes to the lab\'s page and drops its step number from the address', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, `/labs/${EXPLORE}/lessons?step=5&keep=1`, { mastery: SKIPPED });
    await expect(heading(page)).toHaveText('Lessons, part 2 of 2');
    expect(here_(page)).toBe(`/labs/${EXPLORE}/lessons?keep=1&step=5`);
    await page.getByRole('button', { name: '← Back to labs' }).click();
    await expect(page.locator('.lab-detail')).toBeVisible();
    // Another query parameter is kept from screen to screen; the flow's own step is not.
    expect(here_(page)).toBe(`/labs/${EXPLORE}?keep=1`);
  });
});

// =========================================================================
// Back and Forward
// =========================================================================

test.describe('Back and Forward', () => {
  test('home -> path -> module -> story -> lessons -> session, back all the way and forward again, with no token in any address', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await visit(page, '/');
    await expect(page).toHaveTitle('Opalix labs');
    await startCard(page, EXPLORE);
    await expect(heading(page)).toHaveText(full.story!.title);
    expect(here_(page)).toBe(`/labs/${EXPLORE}/story`);

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toHaveText(LESSONS);
    expect(here_(page)).toBe(`/labs/${EXPLORE}/lessons`);

    await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
    await inSession(page);
    expect(here_(page)).toBe(sessionUrl(EXPLORE));
    await expect(page).toHaveTitle(`Session · ${EXPLORE_TITLE} · Opalix labs`);
    expect(s.starts).toEqual([EXPLORE]);
    await noSecretsInAddresses(page);

    // Back out of the lab: the lessons it began with (the lab keeps running).
    await page.goBack();
    await expect(heading(page)).toHaveText(LESSONS);
    await expect(page.locator('#workspace')).toBeHidden();
    expect(here_(page)).toBe(`/labs/${EXPLORE}/lessons`);
    await page.goBack();
    await expect(heading(page)).toHaveText(full.story!.title);
    expect(here_(page)).toBe(`/labs/${EXPLORE}/story`);
    // The module's page, where its row now says Resume.
    await page.goBack();
    await expect(page.locator('.module')).toBeVisible();
    await expect(page.locator('#learnScreen')).toBeHidden();
    expect(here_(page)).toBe(MODULE_1);
    await expect(page.locator(`.lab[data-slug="${EXPLORE}"] .lab-start`)).toHaveText('Resume');
    await page.goBack();
    await expect(page.locator('.module-card')).toBeVisible();
    expect(here_(page)).toBe('/paths/ai-platform');
    await page.goBack();
    await expect(page.locator('.path-card')).toBeVisible();
    expect(here_(page)).toBe('/');
    await expect(page).toHaveTitle('Opalix labs');
    // Home carries the "lab running" card.
    await expect(page.locator('#resumeCard')).toBeVisible();
    expect(s.ends).toEqual([]);

    // Forward all the way: the session is rejoined, not started again.
    for (let i = 0; i < 5; i++) await page.goForward();
    await inSession(page);
    expect(here_(page)).toBe(sessionUrl(EXPLORE));
    expect(s.starts).toEqual([EXPLORE]);
    expect(s.ends).toEqual([]);
    expect(s.errors).toEqual([]);
    await noSecretsInAddresses(page);
  });

  test('Back out of a running lab is the module\'s page with Resume; the lab is not ended; home has the card; a refresh there stays', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await visit(page, '/');
    await startCard(page, PLAIN);
    await inSession(page);
    expect(here_(page)).toBe(sessionUrl(PLAIN));

    await page.goBack();
    await expect(page.locator('.module')).toBeVisible();
    await expect(page.locator('#workspace')).toBeHidden();
    expect(here_(page)).toBe(MODULE_1);
    await expect(page.locator(`.lab[data-slug="${PLAIN}"] .lab-start`)).toHaveText('Resume');
    await expect(page.locator(`.lab[data-slug="${PLAIN}"] .badge-running`)).toBeVisible();
    // The hero and the card belong to home.
    await expect(page.locator('#resumeCard')).toBeHidden();
    await expect(page.locator('#heroTitle')).toBeHidden();
    expect(s.ends).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('opalix.session'))).toContain(SESSION_ID);

    // The lab's own page says Resume too.
    await page.locator(`.lab[data-slug="${PLAIN}"] .lab-about`).click();
    await expect(page.locator('.lab-detail .lab-start')).toHaveText('Resume');
    expect(here_(page)).toBe(`/labs/${PLAIN}`);

    // Home: the navy card with Rejoin, and the hero says so.
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Home' }).click();
    await expect(page.locator('#heroTitle')).toHaveText('Pick up where you left off.');
    await expect(page.locator('#resumeCard')).toContainText(PLAIN_TITLE);
    expect(here_(page)).toBe('/');

    // A refresh of home does not walk back in: Back put the learner outside the lab.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('#workspace')).toBeHidden();
    await expect(page.locator('#resumeCard')).toBeVisible();

    // Rejoin is one press, and puts the session's address back.
    await page.getByRole('button', { name: /Rejoin the lab/ }).click();
    await inSession(page);
    expect(here_(page)).toBe(sessionUrl(PLAIN));
    expect(s.errors).toEqual([]);
  });

  test('Ending the lab replaces the session\'s address with the lab\'s page, so Back cannot lead to a session that is gone', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await visit(page, '/');
    await startCard(page, PLAIN);
    await inSession(page);
    await page.locator('#btnEnd').click();
    await page.locator('#endDialog').getByRole('button', { name: 'Discard' }).click();
    await expect(page.locator('.lab-detail')).toBeVisible();
    expect(here_(page)).toBe(`/labs/${PLAIN}`);
    await expect(page.locator('.lab-detail .lab-start')).toHaveText('Start');
    expect(s.ends).toHaveLength(1);
    // Back is the module the learner came from, not the dead session.
    await page.goBack();
    await expect(page.locator('.module')).toBeVisible();
    expect(here_(page)).toBe(MODULE_1);
    expect(s.starts).toEqual([PLAIN]);
  });

  test('"Back to labs" in a running lab leaves it running and goes to the lab\'s page', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await visit(page, '/');
    await startCard(page, PLAIN);
    await inSession(page);
    await page.locator('#btnBackToLabs').click();
    await expect(page.locator('.lab-detail')).toBeVisible();
    await expect(page.locator('#workspace')).toBeHidden();
    expect(here_(page)).toBe(`/labs/${PLAIN}`);
    await expect(page.locator('.lab-detail .lab-start')).toHaveText('Resume');
    expect(s.ends).toEqual([]);
    // Resume is the same session: one press, the same address. The API's start is what rejoins it (as for the resume card).
    await page.locator('.lab-detail .lab-start').click();
    await inSession(page);
    expect(here_(page)).toBe(sessionUrl(PLAIN));
    expect(s.starts).toEqual([PLAIN, PLAIN]);
    expect(s.ends).toEqual([]);
  });

  test('a link is followed inside the app, and a modified click is left to the browser', async ({ page, context }) => {
    await stub(page);
    await wide(page);
    await visit(page, '/labs/no-such-lab');
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    const link = page.getByRole('link', { name: 'Back to the labs' });
    await expect(link).toBeVisible();
    // Ctrl-click opens another tab; this one stays where it was.
    const popup = context.waitForEvent('page');
    await link.click({ modifiers: ['Control'] });
    const other = await popup;
    await other.waitForLoadState('domcontentloaded');
    expect(new URL(other.url()).pathname).toBe('/');
    await other.close();
    expect(here_(page)).toBe('/labs/no-such-lab');
    // A plain click is the app's: no page load (the marker survives), the launcher, one step on.
    const length = await historyLength(page);
    await link.click();
    await expect(page.locator('#launcher')).toBeVisible();
    expect(here_(page)).toBe('/');
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
    expect(await historyLength(page)).toBe(length + 1);
    await page.goBack();
    await expect(page.locator('#nfTitle')).toBeVisible();
    expect(here_(page)).toBe('/labs/no-such-lab');
  });
});

// =========================================================================
// the session's own address
// =========================================================================

test.describe('/labs/<slug>/session (the old address)', () => {
  test('starts the lab when nothing is running and becomes the new address, in place; a refresh then rejoins it', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    const before = await historyLength(page);
    await visit(page, `/labs/${PLAIN}/session`);
    await inSession(page);
    expect(s.starts).toEqual([PLAIN]);
    expect(here_(page)).toBe(sessionUrl(PLAIN));
    // Replaced, not pushed: the old address is not left behind in the history.
    expect(await historyLength(page)).toBe(before + 1);
    await expect(page).toHaveTitle(`Session · ${PLAIN_TITLE} · Opalix labs`);
    await expect(page.locator('#sessionTitle')).toHaveText(PLAIN_TITLE);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await inSession(page);
    // The remembered session was asked about, not started again, and the address is the same one.
    expect(s.starts).toEqual([PLAIN]);
    expect(here_(page)).toBe(sessionUrl(PLAIN));
    expect(s.errors).toEqual([]);
    await noSecretsInAddresses(page);
  });

  test('rejoins the lab that is running instead of starting another, with the session\'s address', async ({ page }) => {
    const s = await stub(page);
    s.session.lab = PLAIN;
    await wide(page);
    await visit(page, `/labs/${PLAIN}/session`, { remembered: PLAIN });
    await inSession(page);
    expect(s.starts).toEqual([]);
    expect(here_(page)).toBe(sessionUrl(PLAIN));
  });

  test('keeps its tab and its query when it becomes the new address', async ({ page, browser, staticServer }) => {
    const s = await stub(page);
    s.session.lab = PLAIN;
    await wide(page);
    const before = await historyLength(page);
    await visit(page, `/labs/${PLAIN}/session/hints?comicTest=1`, { remembered: PLAIN });
    await inSession(page);
    await expect(page.locator('#tabHints')).toHaveAttribute('aria-selected', 'true');
    expect(here_(page)).toBe(`${sessionUrl(PLAIN, 'hints')}?comicTest=1`);
    expect(await historyLength(page)).toBe(before + 1);
    // Starting from the old address keeps the tab as well.
    const fresh = await (await browser.newContext({ baseURL: staticServer })).newPage();
    const s2 = await stub(fresh);
    await wide(fresh);
    await visit(fresh, `/labs/${PLAIN}/session/service/echo`);
    await inSession(fresh);
    expect(s2.starts).toEqual([PLAIN]);
    expect(here_(fresh)).toBe(sessionUrl(PLAIN, 'service/echo'));
    await expect(fresh.locator('#serviceTabs .tab[data-service="echo"]')).toHaveAttribute('aria-selected', 'true');
  });

  test('a link to another lab while one is running lands in the running lab, with its own address, and says so', async ({ page }) => {
    const s = await stub(page);
    s.session.lab = PLAIN;
    await wide(page);
    await visit(page, `/labs/${STORY_ONLY}/session`, { remembered: PLAIN });
    await inSession(page);
    expect(s.starts).toEqual([]);
    expect(here_(page)).toBe(sessionUrl(PLAIN));
    await expect(page.locator('#toast')).toContainText('You already had a lab running');
    await expect(page).toHaveTitle(`Session · ${PLAIN_TITLE} · Opalix labs`);
  });

  test('a session that has ended is not restarted by a refresh: the lab\'s page is one press away', async ({ page }) => {
    const s = await stub(page);
    s.session.state = 'ended';
    await wide(page);
    await visit(page, `/labs/${PLAIN}/session`, { remembered: PLAIN });
    await expect(page.locator('.lab-detail')).toBeVisible();
    await expect(page.locator('#workspace')).toBeHidden();
    expect(s.starts).toEqual([]);
    expect(here_(page)).toBe(`/labs/${PLAIN}`);
    expect(await page.evaluate(() => localStorage.getItem('opalix.session'))).toBeNull();
  });

  test('the bare "/" still walks back into the lab this browser was in, one step on from "/"', async ({ page }) => {
    const s = await stub(page);
    s.session.lab = PLAIN;
    await wide(page);
    await visit(page, '/', { remembered: PLAIN });
    await inSession(page);
    expect(here_(page)).toBe(sessionUrl(PLAIN));
    expect(s.starts).toEqual([]);
    // Back is home, with the card, and a refresh there stays.
    await page.goBack();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator('#resumeCard')).toBeVisible();
  });
});

// =========================================================================
// /u/<user>/labs/<slug>/session/<session>
// =========================================================================

test.describe('the session\'s own address: the learner and the session in it', () => {
  test('Start puts /u/<user>/labs/<slug>/session/<session> in the address; the id comes from /api/me', async ({ page }) => {
    const s = await stub(page);
    s.me = { sub: 'console', user_id: 'u-5f3a9c' };
    await wide(page);
    await visit(page, `/labs/${PLAIN}`);
    await page.locator('.lab-detail .lab-start').click();
    await inSession(page);
    expect(here_(page)).toBe(sessionUrl(PLAIN, '', SESSION_ID, 'u-5f3a9c'));
    // A tab keeps both ids.
    await page.locator('#tabChecks').click();
    expect(here_(page)).toBe(sessionUrl(PLAIN, 'checks', SESSION_ID, 'u-5f3a9c'));
    await noSecretsInAddresses(page);
  });

  test('an email is never in an address: the learner is named by the opaque id the Worker hands out', async ({ page }) => {
    const s = await stub(page);
    s.me = { sub: 'ada@example.com', user_id: 'u-0123456789abcdef01234567' };
    await wide(page);
    await visit(page, `/labs/${PLAIN}/session`);
    await inSession(page);
    expect(here_(page)).toBe(sessionUrl(PLAIN, '', SESSION_ID, 'u-0123456789abcdef01234567'));
    expect(here_(page)).not.toMatch(/@|ada|example/i);
    for (const u of await urlLog(page)) expect(u).not.toMatch(/@|ada|example/i);
    // The header still says who is signed in.
    await expect(page.locator('#identityName')).toHaveText('ada@example.com');
  });

  test('a refresh on the address re-enters the same session: nothing is started, the tab is kept', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await visit(page, `/labs/${PLAIN}/session`);
    await inSession(page);
    await page.locator('#tabHints').click();
    expect(here_(page)).toBe(sessionUrl(PLAIN, 'hints'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await inSession(page);
    await expect(page.locator('#tabHints')).toHaveAttribute('aria-selected', 'true');
    expect(here_(page)).toBe(sessionUrl(PLAIN, 'hints'));
    expect(s.starts).toEqual([PLAIN]);
    expect(s.errors).toEqual([]);
  });

  test('another learner\'s id is "not found": nothing is asked of the API and nothing starts', async ({ page }) => {
    const s = await stub(page);
    s.session.lab = PLAIN;
    await wide(page);
    for (const user of ['someone-else', 'u-ffffff', 'CONSOLE']) {
      await page.goto(sessionUrl(PLAIN, '', SESSION_ID, user), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-booted="1"]');
      await expect(page.locator('#notFound'), user).toBeVisible();
      await expect(page.locator('#workspace')).toBeHidden();
      await expect(page).toHaveTitle('Not found · Opalix labs');
    }
    expect(s.starts).toEqual([]);
    expect(s.sessionCalls).toEqual([]);
  });

  test('a lab that is not in the catalogue is "not found" at the new address too', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await page.goto(sessionUrl('no-such-lab'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('#notFound')).toBeVisible();
    expect(s.starts).toEqual([]);
  });

  test('a session that is not the active one says so, with Back to labs and no Rejoin when the learner has none for the lab', async ({ page }) => {
    const s = await stub(page);
    s.session = { state: 'ended', lab: null };
    await wide(page);
    await visit(page, sessionUrl(PLAIN, '', OTHER_SESSION_ID));
    await expect(page.locator('#sessionGone')).toBeVisible();
    await expect(page.locator('#sgTitle')).toBeFocused();
    await expect(page.locator('#sgTitle')).toContainText('not active');
    await expect(page.locator('#sgRejoin')).toBeHidden();
    await expect(page).toHaveTitle('Session not active · Opalix labs');
    await expect(page.locator('#workspace')).toBeHidden();
    await expect(page.locator('#launcher')).toBeHidden();
    expect(here_(page)).toBe(sessionUrl(PLAIN, '', OTHER_SESSION_ID));
    expect(s.starts).toEqual([]);
    await noHorizontalScroll(page);

    await page.getByRole('link', { name: 'Back to labs' }).click();
    await expect(page.locator('.path-card')).toBeVisible();
    await expect(page.locator('#sessionGone')).toBeHidden();
    expect(here_(page)).toBe('/');
  });

  test('a different active session for the lab is offered as Rejoin, and the address is replaced with that session\'s id', async ({ page }) => {
    const s = await stub(page);
    s.session.lab = PLAIN;
    await wide(page);
    const before = await historyLength(page);
    await visit(page, sessionUrl(PLAIN, '', OTHER_SESSION_ID), { remembered: PLAIN });
    await expect(page.locator('#sessionGone')).toBeVisible();
    await expect(page.locator('#sgRejoin')).toBeVisible();
    await expect(page.locator('#sgRejoin')).toHaveText('Rejoin');
    expect(s.starts).toEqual([]);
    expect(await historyLength(page)).toBe(before + 1);

    await page.locator('#sgRejoin').click();
    await inSession(page);
    expect(here_(page)).toBe(sessionUrl(PLAIN));
    // Replaced, not pushed.
    expect(await historyLength(page)).toBe(before + 1);
    await expect(page.locator('#sessionGone')).toBeHidden();
    await noSecretsInAddresses(page);
  });

  test('a fresh browser at the address of the learner\'s active session rejoins it; the address stays', async ({ page }) => {
    const s = await stub(page);
    s.session.lab = PLAIN;
    await wide(page);
    await visit(page, sessionUrl(PLAIN, 'hints'));
    await inSession(page);
    // This browser held no token, so the API's start (a rejoin) handed one out.
    expect(s.starts).toEqual([PLAIN]);
    expect(here_(page)).toBe(sessionUrl(PLAIN, 'hints'));
    await expect(page.locator('#tabHints')).toHaveAttribute('aria-selected', 'true');
    expect(s.errors).toEqual([]);
  });

  test('a fresh browser at an address with another session\'s id gets the active session\'s id in its place when it chooses Rejoin', async ({ page }) => {
    const s = await stub(page);
    s.session.lab = PLAIN;
    await wide(page);
    await visit(page, sessionUrl(PLAIN, '', OTHER_SESSION_ID));
    await expect(page.locator('#sgRejoin')).toBeVisible();
    await page.locator('#sgRejoin').click();
    await inSession(page);
    expect(here_(page)).toBe(sessionUrl(PLAIN));
    expect(s.starts).toEqual([PLAIN]);
  });

  test('a session running for a different lab is not offered as Rejoin for this one', async ({ page }) => {
    const s = await stub(page);
    s.session.lab = STORY_ONLY;
    await wide(page);
    await visit(page, sessionUrl(PLAIN), { remembered: STORY_ONLY });
    await expect(page.locator('#sessionGone')).toBeVisible();
    await expect(page.locator('#sgRejoin')).toBeHidden();
    expect(s.starts).toEqual([]);
  });

  test('without the Worker\'s list of active sessions the page still says "not active" (and offers no Rejoin)', async ({ page }) => {
    const s = await stub(page);
    s.active = null;
    await wide(page);
    await visit(page, sessionUrl(PLAIN));
    await expect(page.locator('#sessionGone')).toBeVisible();
    await expect(page.locator('#sgRejoin')).toBeHidden();
    expect(s.starts).toEqual([]);
  });

  test('a remembered session that has ended is "not active" at its own address', async ({ page }) => {
    const s = await stub(page);
    s.session = { state: 'ended', lab: PLAIN };
    await wide(page);
    await visit(page, sessionUrl(PLAIN), { remembered: PLAIN });
    await expect(page.locator('#sessionGone')).toBeVisible();
    await expect(page.locator('#sgRejoin')).toBeHidden();
    expect(s.starts).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('opalix.session'))).toBeNull();
  });

  test('a Worker that sends no user id (an older one) keeps the old address, and the new one is "not found"', async ({ page }) => {
    const s = await stub(page);
    s.me = { sub: 'console' } as unknown as Stub['me'];
    await wide(page);
    await visit(page, `/labs/${PLAIN}/session`);
    await inSession(page);
    expect(here_(page)).toBe(`/labs/${PLAIN}/session`);
    await page.locator('#tabHints').click();
    expect(here_(page)).toBe(`/labs/${PLAIN}/session/hints`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await inSession(page);
    expect(s.starts).toEqual([PLAIN]);
    // Without a learner's id there is nobody for a new-form address to be for.
    await page.goto(sessionUrl(PLAIN), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('#notFound')).toBeVisible();
  });

  test('a session this browser kept for another learner is not taken up', async ({ page }) => {
    const s = await stub(page);
    s.session.lab = PLAIN;
    await wide(page);
    await page.addInitScript(
      ([id, lab]) => localStorage.setItem('opalix.session', JSON.stringify({ id, token: 'test-token', lab, userId: 'someone-else', urls: { services: { echo: {} } } })),
      [SESSION_ID, PLAIN]
    );
    await visit(page, `/labs/${PLAIN}/session`);
    await inSession(page);
    // The record belonged to someone else, so it was not asked about: the console asked to start (a rejoin), as for a fresh browser.
    expect(s.starts).toEqual([PLAIN]);
    expect(here_(page)).toBe(sessionUrl(PLAIN));
    // And what it keeps now is this learner's.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('opalix.session') ?? '{}').userId)).toBe(USER_ID);
  });

  test('Back and Forward between a lab\'s page and its session address keep the same session', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await visit(page, `/labs/${PLAIN}`);
    await page.locator('.lab-detail .lab-start').click();
    await inSession(page);
    await page.goBack();
    await expect(page.locator('.lab-detail')).toBeVisible();
    await page.goForward();
    await inSession(page);
    expect(here_(page)).toBe(sessionUrl(PLAIN));
    expect(s.starts).toEqual([PLAIN]);
    expect(s.ends).toEqual([]);
  });
});

test.describe('tabs inside the session', () => {
  test('a tab change replaces the address in place: the history does not grow', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, `/labs/${PLAIN}/session`);
    await inSession(page);
    const length = await historyLength(page);

    const steps: Array<[string, string]> = [
      ['#tabChecks', sessionUrl(PLAIN, 'checks')],
      ['#tabHints', sessionUrl(PLAIN, 'hints')],
      ['#tabBrief', sessionUrl(PLAIN, 'brief')],
      ['#tabTerminal', sessionUrl(PLAIN, 'terminal')],
      ['#tabEditor', sessionUrl(PLAIN, 'editor')],
      ['#serviceTabs .tab[data-service="echo"]', sessionUrl(PLAIN, 'service/echo')],
    ];
    for (const [selector, path] of steps) {
      await page.locator(selector).click();
      expect(here_(page), selector).toBe(path);
      expect(await historyLength(page), selector).toBe(length);
    }
    // The keyboard changes tabs the same way.
    await page.locator('#tabBrief').click();
    await page.locator('#tabBrief').press('ArrowRight');
    expect(here_(page)).toBe(sessionUrl(PLAIN, 'checks'));
    expect(await historyLength(page)).toBe(length);
    await noSecretsInAddresses(page);
  });

  test('a refresh keeps the tab: guide tab, workspace tab, service tab', async ({ page }) => {
    const s = await stub(page);
    s.session.lab = PLAIN;
    await wide(page);
    await visit(page, sessionUrl(PLAIN, 'hints'), { remembered: PLAIN });
    await inSession(page);
    await expect(page.locator('#tabHints')).toHaveAttribute('aria-selected', 'true');
    expect(here_(page)).toBe(sessionUrl(PLAIN, 'hints'));

    await page.goto(sessionUrl(PLAIN, 'terminal'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await inSession(page);
    await expect(page.locator('#tabTerminal')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#viewTerminal')).toHaveClass(/view-active/);
    // The guide opens on its first tab: the address named a workspace tab only.
    await expect(page.locator('#tabBrief')).toHaveAttribute('aria-selected', 'true');

    await page.goto(sessionUrl(PLAIN, 'service/echo'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await inSession(page);
    await expect(page.locator('#serviceTabs .tab[data-service="echo"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#viewService')).toHaveClass(/view-active/);
    expect(here_(page)).toBe(sessionUrl(PLAIN, 'service/echo'));
  });

  test('a tab the lab does not have, or that does not exist, makes the address the session\'s own', async ({ page }) => {
    const s = await stub(page);
    s.session.lab = PLAIN;
    await wide(page);
    for (const tab of ['solution', 'questions', 'nope', 'service/ghost', 'service', 'brief/extra']) {
      await page.goto(sessionUrl(PLAIN, tab), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-booted="1"]');
      await inSession(page);
      await expect.poll(() => here_(page), tab).toBe(sessionUrl(PLAIN));
      await expect(page.locator('#tabBrief')).toHaveAttribute('aria-selected', 'true');
    }
    // The old address takes the same road.
    await page.goto(`/labs/${PLAIN}/session/nope`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await inSession(page);
    await expect.poll(() => here_(page)).toBe(sessionUrl(PLAIN));
  });

  test('Back after tab changes leaves the session in one step, not one per tab', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, '/');
    await startCard(page, PLAIN);
    await inSession(page);
    for (const selector of ['#tabChecks', '#tabHints', '#tabTerminal', '#tabEditor']) await page.locator(selector).click();
    await page.goBack();
    await expect(page.locator('.module')).toBeVisible();
    expect(here_(page)).toBe(MODULE_1);
  });
});

// =========================================================================
// addresses that are nothing
// =========================================================================

test.describe('not found', () => {
  test('an unknown lab, at any of its addresses, is a not-found screen with a way back', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    for (const tail of ['', '/story', '/lessons', '/session', '/session/hints']) {
      await page.goto(`/labs/no-such-lab${tail}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-booted="1"]');
      await expect(page.locator('#notFound')).toBeVisible();
      await expect(page.locator('#nfTitle')).toBeFocused();
      await expect(page.locator('#nfTitle')).toContainText('Page not found');
      await expect(page).toHaveTitle('Not found · Opalix labs');
      await expect(page.locator('#launcher')).toBeHidden();
      await expect(page.locator('#workspace')).toBeHidden();
      expect(here_(page)).toBe(`/labs/no-such-lab${tail}`);
    }
    await page.getByRole('link', { name: 'Back to the labs' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator('#notFound')).toBeHidden();
    await expect(page).toHaveTitle('Opalix labs');
    expect(here_(page)).toBe('/');
    // Nothing was started for a lab that does not exist.
    expect(s.starts).toEqual([]);
    expect(s.sessionCalls).toEqual([]);
  });

  test('an unknown path, and a path that is not a path of the console, are not found', async ({ page }) => {
    await stub(page);
    await wide(page);
    const long = 'a'.repeat(120);
    const bad = [
      '/nope', '/labs', '/labs/', '/labs/a//b', '/labs/Caf%C3%A9', `/labs/${long}`, '/paths/nope', '/paths/ai-platform/modules/99', '/labs/x/y/z', '/onboarding/extra', '/a/b/c/d',
      // The new session address, wrongly spelled.
      '/u', '/u/console', '/u/console/labs', `/u/console/labs/${PLAIN}`, `/u/console/labs/${PLAIN}/session`, `/u/console/labs/${PLAIN}/lessons/${SESSION_ID}`,
      `/u/console/labs/${PLAIN}/sessions/${SESSION_ID}`, `/u/me@example.com/labs/${PLAIN}/session/${SESSION_ID}`, `/u/%2f/labs/${PLAIN}/session/${SESSION_ID}`,
    ];
    for (const path of bad) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-booted="1"]');
      await expect(page.locator('#notFound'), path).toBeVisible();
      await expect(page, path).toHaveTitle('Not found · Opalix labs');
    }
    await noHorizontalScroll(page);
  });

  test('a trailing slash is the same address', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, `/labs/${EXPLORE}/lessons/`);
    await expect(heading(page)).toHaveText(LESSONS);
  });
});

// =========================================================================
// paths
// =========================================================================

/** Five labs in two modules of the platform path, and one lab on a path with no module cards. */
const PAGES_LABS = [
  lab({ slug: 'alpha-one', title: 'Alpha one', module: 1, order: 1, summary: 'The first alpha.', difficulty: 'intro', family: 'gateway' }),
  lab({ slug: 'alpha-two', title: 'Alpha two', module: 1, order: 2, has_learn: false, difficulty: 'core', family: 'gateway' }),
  lab({ slug: 'beta-one', title: 'Beta one', module: 2, order: 1, has_learn: false, difficulty: 'intro', family: 'mcp' }),
  lab({ slug: 'beta-two', title: 'Beta two', module: 2, order: 2, has_learn: false, difficulty: 'core', family: 'mcp' }),
  lab({ slug: 'shield-one', title: 'Shield one', path: 'securing-agents', module: 1, order: 1, has_learn: false }),
];

async function stubPages(page: Page, labs: unknown[] = PAGES_LABS): Promise<Stub> {
  const s = await stub(page);
  await page.route('**/api/labs', (route) => json(route, labs));
  return s;
}

const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });
const crumbTexts = (page: Page) => crumbs(page).locator('li').allInnerTexts();

test.describe('the launcher is four pages', () => {
  test('home is the path cards only: title, a line, module and lab counts, progress; no modules, no lab list', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await visit(page, '/');
    await expect(page.locator('#labList .path-card')).toHaveCount(1);
    const card = page.locator('#path-ai-platform');
    await expect(card.getByRole('heading', { level: 2 })).toHaveText('Building an AI platform');
    await expect(card.getByRole('link', { name: 'Building an AI platform' })).toHaveAttribute('href', '/paths/ai-platform');
    await expect(card.locator('.path-card-intro')).not.toBeEmpty();
    // One module (all five labs are in it), five labs of twenty minutes.
    await expect(card.locator('.path-card-line')).toHaveText('1 module · 5 labs · about 1 h 40 min');
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '5');
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    await expect(card.locator('.path-card-progress')).toHaveText('0 of 5 done');
    // None of what belongs to the pages below it.
    for (const sel of ['.module', '.module-card', '.lab', '.lab-rows', '.lab-detail']) await expect(page.locator(sel), sel).toHaveCount(0);
    await expect(page.locator('#heroTitle')).toBeVisible();
    await expect(page.locator('#labFilters')).toBeVisible();
    await expect(page.locator('#labCount')).toHaveText('5 of 5 labs');
    expect(await crumbTexts(page)).toEqual(['Home']);
    await expect(crumbs(page).locator('[aria-current="page"]')).toHaveText('Home');
    expect(s.errors).toEqual([]);
  });

  test('a path\'s page is its module cards only, each opening the module', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, '/');
    await page.getByRole('link', { name: 'Building an AI platform' }).click();
    expect(here_(page)).toBe('/paths/ai-platform');
    await expect(page.locator('h1.group-head')).toHaveText('Building an AI platform');
    await expect(page.locator('h1.group-head')).toBeFocused();
    await expect(page).toHaveTitle('Building an AI platform · Opalix labs');
    await expect(page.locator('#routeLive')).toHaveText('Building an AI platform');
    await expect(page.locator('#hello')).toBeHidden();
    await expect(page.locator('.path-intro')).not.toBeEmpty();
    await expect(page.locator('.path-summary')).toContainText('5 labs');
    const card = page.locator('.module-card[data-module="1"]');
    await expect(card.locator('.module-num')).toHaveText('Module 1');
    await expect(card.getByRole('heading', { level: 2 })).toHaveText('Gateway and access');
    await expect(card.locator('.module-intro')).not.toBeEmpty();
    await expect(card.locator('.module-meta')).toContainText('5 labs');
    await expect(card.locator('.module-progress')).toHaveText('0 of 5 done');
    await expect(card.getByRole('link', { name: 'Gateway and access' })).toHaveAttribute('href', MODULE_1);
    for (const sel of ['.path-card', '.module', '.lab', '.lab-rows']) await expect(page.locator(sel), sel).toHaveCount(0);
    expect(await crumbTexts(page)).toEqual(['Home', 'Building an AI platform']);
  });

  test('a module\'s page: number, title, intro, "You will learn to" and a progress meter on the left; the labs as rows on the right', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await visit(page, '/');
    await openModule(page);
    const info = page.locator('.module-info');
    await expect(info.locator('.module-num')).toHaveText('Module 1');
    await expect(info.getByRole('heading', { level: 1 })).toHaveText('Gateway and access');
    await expect(info.getByRole('heading', { level: 1 })).toBeFocused();
    await expect(info.locator('.module-intro')).not.toBeEmpty();
    await expect(info.locator('.skills-label')).toHaveText('You will learn to');
    await expect(info.locator('.skill-list li')).toHaveCount(3);
    await expect(info.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '5');
    await expect(info.locator('.module-progress')).toHaveText('0 of 5 done');
    await expect(page.locator('#routeLive')).toHaveText('Module 1: Gateway and access');
    await expect(page).toHaveTitle('Gateway and access · Building an AI platform · Opalix labs');

    const rows = page.locator('.lab-rows .lab');
    await expect(rows).toHaveCount(5);
    const first = rows.first();
    await expect(first.locator('.lab-num')).toHaveText('1');
    await expect(first.getByRole('heading', { level: 2 })).toHaveText(EXPLORE_TITLE);
    await expect(first.locator('.chip-difficulty')).toHaveText('intro');
    await expect(first.locator('.chip-time')).toContainText('~20 min');
    await expect(first.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
    await expect(first.getByRole('link', { name: 'About this lab' })).toHaveAttribute('href', `/labs/${EXPLORE}`);
    // The panel is on the left of the rows, side by side on a wide screen.
    const left = await info.boundingBox();
    const right = await page.locator('.lab-rows').boundingBox();
    expect(left!.x).toBeLessThan(right!.x);
    expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x + 1);
    // Nothing of the other pages.
    for (const sel of ['.path-card', '.module-card', '.lab-detail']) await expect(page.locator(sel), sel).toHaveCount(0);
    expect(await crumbTexts(page)).toEqual(['Home', 'Building an AI platform', 'Module 1: Gateway and access']);
    expect(s.errors).toEqual([]);
  });

  test('a lab\'s page: title, summary, objectives, chips, prerequisites, Start; the row\'s "About this lab" opens it', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await visit(page, '/');
    await openModule(page);
    await page.locator(`.lab[data-slug="${EXPLORE}"]`).getByRole('link', { name: 'About this lab' }).click();
    expect(here_(page)).toBe(`/labs/${EXPLORE}`);
    const detail = page.locator('.lab-detail');
    await expect(detail.getByRole('heading', { level: 1 })).toHaveText(EXPLORE_TITLE);
    await expect(detail.getByRole('heading', { level: 1 })).toBeFocused();
    await expect(detail.locator('.lab-summary')).toHaveText(`About ${EXPLORE}`);
    await expect(detail.locator('.lab-objectives li')).toHaveText(['do the thing']);
    await expect(detail.locator('.lab-sub .chip-type')).toHaveText('explore');
    await expect(detail.locator('.lab-sub .chip-difficulty')).toHaveText('intro');
    await expect(detail.locator('.lab-sub .chip-time')).toContainText('~20 min');
    await expect(detail.locator('.lab-prereq-section')).toContainText('None. You can start right away.');
    await expect(detail.locator('.lab-start')).toHaveText('Start');
    await expect(detail.locator('.lab-status')).toHaveText('Not started');
    await expect(page.locator('#routeLive')).toHaveText(EXPLORE_TITLE);
    for (const sel of ['.path-card', '.module-card', '.module', '.lab']) await expect(page.locator(sel), sel).toHaveCount(0);
    await expect(page.locator('#labFilters')).toBeHidden();
    expect(await crumbTexts(page)).toEqual(['Home', 'Building an AI platform', 'Module 1: Gateway and access', EXPLORE_TITLE]);
    expect(s.starts).toEqual([]);
  });

  test('the trail is a nav landmark whose links go up one page at a time; the page itself is the one item that is not a link', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, `/labs/${EXPLORE}`);
    const nav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(nav).toHaveCount(1);
    await expect(nav.locator('ol > li')).toHaveCount(4);
    await expect(nav.locator('a')).toHaveCount(3);
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(nav.locator('[aria-current="page"]')).toHaveText(EXPLORE_TITLE);
    await expect(nav.locator('a')).toHaveText(['Home', 'Building an AI platform', 'Module 1: Gateway and access']);

    await nav.getByRole('link', { name: 'Module 1: Gateway and access' }).click();
    expect(here_(page)).toBe(MODULE_1);
    await expect(page.locator('.module')).toBeVisible();
    await crumbs(page).getByRole('link', { name: 'Building an AI platform' }).click();
    expect(here_(page)).toBe('/paths/ai-platform');
    await expect(page.locator('.module-card')).toBeVisible();
    await crumbs(page).getByRole('link', { name: 'Home' }).click();
    expect(here_(page)).toBe('/');
    await expect(page.locator('.path-card')).toBeVisible();
    await expect(page.locator('#heroTitle')).toBeFocused();
    await expect(page.locator('#routeLive')).toHaveText('Labs');
  });

  test('every page has an address that a deep link, a refresh, Back and Forward keep', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    const pages: Array<[string, string]> = [
      ['/', '.path-card'],
      ['/paths/ai-platform', '.module-card'],
      [MODULE_1, '.module .lab'],
      [`/labs/${EXPLORE}`, '.lab-detail'],
    ];
    // A deep link, and a refresh of it.
    for (const [url, marker] of pages) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-booted="1"]');
      await expect(page.locator(marker).first(), url).toBeVisible();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-booted="1"]');
      await expect(page.locator(marker).first(), `${url} refreshed`).toBeVisible();
      expect(here_(page)).toBe(url);
    }
    // Back and Forward through the pages the clicks built.
    await visit(page, '/');
    await openModule(page);
    await page.locator(`.lab[data-slug="${EXPLORE}"]`).getByRole('link', { name: 'About this lab' }).click();
    for (const [url, marker] of [...pages].reverse().slice(1)) {
      await page.goBack();
      await expect(page.locator(marker).first(), url).toBeVisible();
      expect(here_(page)).toBe(url);
    }
    for (const [url, marker] of pages.slice(1)) {
      await page.goForward();
      await expect(page.locator(marker).first(), url).toBeVisible();
      expect(here_(page)).toBe(url);
    }
    expect(s.errors).toEqual([]);
  });

  test('an unknown path, module or lab is "not found"; a path with no module cards has its labs on its own page', async ({ page }) => {
    await stubPages(page);
    await wide(page);
    await visit(page, '/');
    for (const url of ['/paths/no-such-path', '/paths/ai-platform/modules/42', '/paths/securing-agents/modules/2', '/labs/no-such-lab', '/paths/no-such-path/modules/1']) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-booted="1"]');
      await expect(page.locator('#notFound'), url).toBeVisible();
      await expect(page, url).toHaveTitle('Not found · Opalix labs');
      expect(here_(page)).toBe(url);
    }
    // securing-agents is one implicit module: its labs are on the path's page, and its module address leads there.
    await page.goto('/paths/securing-agents', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('.lab-rows-flat .lab')).toHaveCount(1);
    await expect(page.locator('.module-card')).toHaveCount(0);
    const before = await historyLength(page);
    await page.goto('/paths/securing-agents/modules/1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    expect(here_(page)).toBe('/paths/securing-agents');
    await expect(page.locator('.lab-rows-flat .lab')).toHaveCount(1);
    expect(await historyLength(page)).toBe(before + 1);
    // The lab on it: Home > Path > Lab (no module in the trail).
    await page.locator('.lab[data-slug="shield-one"]').getByRole('link', { name: 'About this lab' }).click();
    expect(await crumbTexts(page)).toEqual(['Home', 'Securing agents', 'Shield one']);
  });

  test('the header\'s Labs and Paths, and the brand, go home', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, MODULE_1);
    await page.locator('#navLabs').click();
    await expect(page.locator('.path-card')).toBeVisible();
    expect(here_(page)).toBe('/');
    await page.goto(`/labs/${EXPLORE}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await page.locator('#navPaths').click();
    await expect(page.locator('.path-card')).toBeVisible();
    expect(here_(page)).toBe('/');
    await expect(page.locator('.path-card-title a').first()).toBeFocused();
    await page.locator('#brandLink').click();
    expect(here_(page)).toBe('/');
  });

  test('a lab whose prerequisite is not passed is Locked, with the reason, on its row and on its page; passing it opens it', async ({ page }) => {
    const base = PAGES_LABS.slice(0, 2).map((l) => ({ ...l }));
    const locked = [base[0], { ...base[1], prerequisites: ['alpha-one'] }];
    const s = await stubPages(page, locked);
    await wide(page);
    await visit(page, MODULE_1);
    const row = page.locator('.lab[data-slug="alpha-two"]');
    await expect(row).toHaveClass(/lab-locked/);
    await expect(row.locator('.lab-lock')).toHaveText('Locked until Alpha one passes');
    await expect(row.locator('.lab-start')).toHaveText('Locked');
    await expect(row.locator('.lab-start')).toHaveAttribute('aria-disabled', 'true');
    await row.locator('.lab-start').click({ force: true });
    expect(s.starts).toEqual([]);
    await expect(page.locator('#workspace')).toBeHidden();
    await expect(page.locator('#learnScreen')).toBeHidden();

    await row.getByRole('link', { name: 'About this lab' }).click();
    const detail = page.locator('.lab-detail');
    await expect(detail.locator('.lab-start')).toHaveText('Locked');
    await expect(detail.locator('.lab-lock')).toHaveText('Locked until Alpha one passes');
    await expect(detail.locator('.lab-detail-side')).toContainText('Pass every check of Alpha one first');
    const prereq = detail.locator('.lab-prereqs li');
    await expect(prereq).toHaveCount(1);
    await expect(prereq.getByRole('link', { name: 'Alpha one' })).toHaveAttribute('href', '/labs/alpha-one');
    await expect(prereq.locator('.prereq-state')).toHaveText('Not passed yet');

    // With the prerequisite passed, the same page offers Start.
    const passed = [{ ...base[0], progress: { attempts: 1, best_score: 1, passed_all: true, last_run_at: 1 } }, locked[1]];
    await page.route('**/api/labs', (route) => json(route, passed));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('.lab-detail .lab-start')).toHaveText('Start');
    await expect(page.locator('.lab-detail .lab-lock')).toHaveCount(0);
    await expect(page.locator('.lab-prereqs .prereq-state')).toHaveText('Passed');
  });
});

test.describe('search and filters act on the page they are on', () => {
  const rowsOn = (page: Page) => page.locator('.lab-rows .lab');

  test('the labs of the page are what is searched and counted: all of them on home, a path\'s, a module\'s', async ({ page }) => {
    await stubPages(page);
    await wide(page);
    await visit(page, '/');
    await expect(page.locator('#labCount')).toHaveText('5 of 5 labs');
    await page.locator('#labSearch').fill('beta two');
    // Home: only the path that holds a match keeps its card, and says how many match.
    await expect(page.locator('.path-card')).toHaveCount(1);
    await expect(page.locator('#path-ai-platform .path-card-progress')).toHaveText('0 of 4 done · 1 match');
    await expect(page.locator('#path-securing-agents')).toHaveCount(0);
    await expect(page.locator('#labCount')).toHaveText('1 of 5 labs');

    // A path's page: the module that holds a match; the count is the path's labs.
    await page.locator('#path-ai-platform').getByRole('link', { name: 'Building an AI platform' }).click();
    await expect(page.locator('.module-card')).toHaveCount(1);
    await expect(page.locator('.module-card')).toHaveAttribute('data-module', '2');
    await expect(page.locator('#labCount')).toHaveText('1 of 4 labs');

    // A module's page: its rows; the count is the module's labs. The same search, kept from page to page.
    await page.locator('.module-card .module-title a').click();
    await expect(rowsOn(page)).toHaveCount(1);
    await expect(rowsOn(page).first()).toHaveAttribute('data-slug', 'beta-two');
    await expect(page.locator('#labCount')).toHaveText('1 of 2 labs');
    await expect(page.locator('#labSearch')).toHaveValue('beta two');

    // The other module has nothing that matches: its panel stays, with the no-match line (in the app, as a link does).
    await page.evaluate(() => {
      history.pushState(null, '', '/paths/ai-platform/modules/1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.module-title')).toHaveText('Gateway and access');
    await expect(page.locator('#labCount')).toHaveText('0 of 2 labs');
    await expect(page.locator('#labNoMatch')).toBeVisible();
    await expect(rowsOn(page)).toHaveCount(0);
    await expect(page.locator('.module-info')).toBeVisible();
    // A deep link is not left with every lab hidden by a search saved earlier: it opens with the filters cleared.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('#labSearch')).toHaveValue('');
    await expect(rowsOn(page)).toHaveCount(2);
  });

  test('a search typed on a module\'s page persists, as it does today, and Clear filters brings every row back', async ({ page }) => {
    await stubPages(page);
    await wide(page);
    await visit(page, '/paths/ai-platform/modules/2');
    await page.locator('#labSearch').fill('beta one');
    await expect(rowsOn(page)).toHaveCount(1);
    await expect(page.locator('#btnClearFilters')).toBeVisible();
    // Kept in this browser: a refresh of the same page shows it again.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('opalixFilters') ?? '{}').q)).toBe('beta one');
    await page.locator('#btnClearFilters').click();
    await expect(rowsOn(page)).toHaveCount(2);
    await expect(page.locator('#labSearch')).toHaveValue('');
    await expect(page.locator('#btnClearFilters')).toBeHidden();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('opalixFilters') ?? '{}').q)).toBe('');
  });

  test('the difficulty, family and status chips filter the labs of the page too', async ({ page }) => {
    await stubPages(page);
    await wide(page);
    await visit(page, '/paths/ai-platform/modules/1');
    await expect(rowsOn(page)).toHaveCount(2);
    await page.locator('button.filter-chip[data-filter="difficulty"][data-value="core"]').click();
    await expect(rowsOn(page)).toHaveCount(1);
    await expect(rowsOn(page).first()).toHaveAttribute('data-slug', 'alpha-two');
    await expect(page.locator('#labCount')).toHaveText('1 of 2 labs');
    // The family chip of a lab on another page is offered everywhere (the facets are the catalogue's).
    await expect(page.locator('button.filter-chip[data-filter="family"]')).toHaveText(['gateway', 'mcp']);
    await page.locator('button.filter-chip[data-filter="family"][data-value="mcp"]').click();
    await expect(page.locator('#labNoMatch')).toBeVisible();
    await page.locator('#btnClearFilters').click();
    await page.locator('button.filter-chip[data-filter="status"][data-value="done"]').click();
    await expect(rowsOn(page)).toHaveCount(0);
  });

  test('a lab\'s own page has no search: it is about one lab', async ({ page }) => {
    await stubPages(page);
    await wide(page);
    await visit(page, '/labs/alpha-one');
    await expect(page.locator('.lab-detail')).toBeVisible();
    await expect(page.locator('#labFilters')).toBeHidden();
    await expect(page.locator('#labCount')).toHaveText('');
  });
});

// =========================================================================
// a phone at a deep link
// =========================================================================

test.describe('on a phone', () => {
  test('/labs/<slug>/session shows the desktop notice with that lab\'s own link, and starts nothing', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const s = await stub(page);
    await page.setViewportSize(PHONE);
    await visit(page, `/labs/${PLAIN}/session`);
    await expect(page.locator('#desktopNotice')).toBeVisible();
    await expect(page.locator('#dnTitle')).toBeFocused();
    await expect(page.locator('#workspace')).toBeHidden();
    await expect(page.locator('#launcher')).toBeHidden();
    const origin = new URL(page.url()).origin;
    const email = (await page.getByRole('link', { name: 'Email me the link' }).getAttribute('href'))!;
    expect(new URLSearchParams(email.slice('mailto:?'.length)).get('body')).toContain(`${origin}/labs/${PLAIN}`);
    await page.getByRole('button', { name: 'Copy the link' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/labs/${PLAIN}`);
    expect(s.starts).toEqual([]);
    expect(s.sessionCalls).toEqual([]);
    await noHorizontalScroll(page);

    // The way out is the launcher, and the address follows.
    await page.getByRole('button', { name: 'Browse the labs anyway' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    expect(here_(page)).toBe('/');
  });

  test('reading is still allowed at a deep link; Start there shows the notice for that lab', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(PHONE);
    await visit(page, `/labs/${EXPLORE}/lessons`);
    await expect(heading(page)).toHaveText(LESSONS);
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
    await expect(page.locator('#desktopNotice')).toBeVisible();
    expect(await page.locator('#dnEmail').getAttribute('href')).toContain(encodeURIComponent(`/labs/${EXPLORE}`));
    expect(s.starts).toEqual([]);
  });

  test('a window widened to a desktop brings the address\'s own screen: the lab starts', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(PHONE);
    await visit(page, `/labs/${PLAIN}/session`);
    await expect(page.locator('#desktopNotice')).toBeVisible();
    await page.setViewportSize(WIDE);
    await inSession(page);
    expect(s.starts).toEqual([PLAIN]);
    expect(here_(page)).toBe(sessionUrl(PLAIN));
  });

  test('a session\'s address shows the notice too, with the lab\'s own link, and rejoins nothing', async ({ page }) => {
    const s = await stub(page);
    s.session.lab = PLAIN;
    await page.setViewportSize(PHONE);
    await visit(page, sessionUrl(PLAIN), { remembered: PLAIN });
    await expect(page.locator('#desktopNotice')).toBeVisible();
    expect(await page.locator('#dnEmail').getAttribute('href')).toContain(encodeURIComponent(`/labs/${PLAIN}`));
    expect(s.starts).toEqual([]);
    expect(s.sessionCalls).toEqual([]);
    await noHorizontalScroll(page);
  });

  test('the pages are readable on a phone: home, a path, a module and a lab, with no sideways scroll', async ({ page }) => {
    await stub(page);
    await page.setViewportSize(PHONE);
    await visit(page, '/');
    for (const [url, marker] of [['/', '.path-card'], ['/paths/ai-platform', '.module-card'], [MODULE_1, '.module .lab'], [`/labs/${EXPLORE}`, '.lab-detail']] as const) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-booted="1"]');
      await expect(page.locator(marker).first(), url).toBeVisible();
      await noHorizontalScroll(page);
    }
    // Start is gated on a phone, from a lab's page too.
    await page.locator('.lab-detail .lab-start').click();
    await expect(page.locator('#desktopNotice')).toBeVisible();
  });
});

// =========================================================================
// titles, announcements
// =========================================================================

test.describe('the tab title and the screen reader', () => {
  test('the title follows the screen', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, '/');
    await expect(page).toHaveTitle('Opalix labs');
    await startCard(page, EXPLORE);
    await expect(page).toHaveTitle(`${EXPLORE_TITLE} · Opalix labs`);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveTitle(`Lessons · ${EXPLORE_TITLE} · Opalix labs`);
    await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
    await inSession(page);
    await expect(page).toHaveTitle(`Session · ${EXPLORE_TITLE} · Opalix labs`);
    await page.goBack();
    await expect(page).toHaveTitle(`Lessons · ${EXPLORE_TITLE} · Opalix labs`);
    await page.goBack();
    await page.goBack();
    await expect(page).toHaveTitle('Gateway and access · Building an AI platform · Opalix labs');
    await page.goBack();
    await expect(page).toHaveTitle('Building an AI platform · Opalix labs');
    await page.goBack();
    await expect(page).toHaveTitle('Opalix labs');
  });

  test('a route change is said, and focus lands on the screen\'s heading', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, '/');
    await startCard(page, EXPLORE);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toBeFocused();
    await expect(page.locator('#learnScreen > p.sr-only[role="status"]')).toHaveText(/^Step 2 of 2: Lessons$/);
    await page.goBack();
    await expect(heading(page)).toBeFocused();
    await expect(page.locator('#learnScreen > p.sr-only[role="status"]')).toHaveText(new RegExp(`^Step 1 of 2: ${full.story!.title}$`));
    await page.goBack();
    await expect(page.locator('.module-title')).toBeFocused();
    await expect(page.locator('#routeLive')).toHaveText('Module 1: Gateway and access');
    await page.goBack();
    await expect(page.locator('h1.group-head')).toBeFocused();
    await page.goBack();
    await expect(page.locator('#heroTitle')).toBeFocused();
    await expect(page.locator('#routeLive')).toHaveText('Labs');
  });
});

// =========================================================================
// signing in returns to the page that was asked for
// =========================================================================

/** The real Worker, with the password gate, in front of the same files. */
const gated = base.extend<object, { gateServer: string }>({
  gateServer: [
    async ({}, use) => {
      const { url, server }: { url: string; server: Server } = await serveWorker({
        labs: LABS,
        learn: (slug) => BUNDLES[slug] ?? null,
        // The API's rows: this learner's live session, with fields the console must not pass on.
        sessions: [{ id: SESSION_ID, user_id: 'console', lab_slug: PLAIN, state: 'running', created_at: 1, secret: 'never-shown' }],
      });
      await use(url);
      await new Promise((done) => server.close(done));
    },
    { scope: 'worker' },
  ],
});

gated.describe('the password gate', () => {
  gated('a deep link shows the sign-in form at that address, and signing in lands on it', async ({ page, gateServer }) => {
    await page.setViewportSize(WIDE);
    await page.addInitScript(() => {
      localStorage.setItem('opalixOnboarded', '1');
      localStorage.setItem('opalixLearn', '{"v":1,"onboarding":{"status":"skipped"}}');
    });
    const response = await page.goto(`${gateServer}/labs/${EXPLORE}/lessons`, { waitUntil: 'domcontentloaded' });
    expect(response!.status()).toBe(200);
    await expect(page.locator('#f')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/labs/${EXPLORE}/lessons`);

    await page.fill('#pw', 'wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#err')).toHaveText('Wrong password.');
    expect(new URL(page.url()).pathname).toBe(`/labs/${EXPLORE}/lessons`);

    await page.fill('#pw', 'pw');
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Nothing is known here, so the lab's first lessons are part 1 of 2 (the questions come between).
    await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
    expect(new URL(page.url()).pathname).toBe(`/labs/${EXPLORE}/lessons`);
    await expect(page).toHaveTitle(`Lessons · ${EXPLORE_TITLE} · Opalix labs`);
  });

  gated('?next= is followed only to a path of the console, never to another site', async ({ page, gateServer }) => {
    const origin = new URL(gateServer).origin;
    await page.addInitScript(() => {
      localStorage.setItem('opalixOnboarded', '1');
      localStorage.setItem('opalixLearn', '{"v":1,"onboarding":{"status":"skipped"}}');
    });
    // A valid one lands there ...
    await page.goto(`${gateServer}/?next=${encodeURIComponent(`/labs/${EXPLORE}/story`)}`, { waitUntil: 'domcontentloaded' });
    await page.fill('#pw', 'pw');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(`${origin}/labs/${EXPLORE}/story`);
    await expect(heading(page)).toHaveText(full.story!.title);

    // ... and the hostile ones land on the launcher of this origin (the cookie is already set, so sign out first).
    for (const next of ['//evil.example/x', 'https://evil.example/x', '/\\evil.example', '/.//evil.example']) {
      await page.evaluate(() => fetch('/auth/logout', { method: 'POST' }));
      await page.goto(`${gateServer}/?next=${encodeURIComponent(next)}`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#f')).toBeVisible();
      await page.fill('#pw', 'pw');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForSelector('body[data-booted="1"]');
      expect(new URL(page.url()).origin, next).toBe(origin);
      expect(new URL(page.url()).pathname, next).toBe('/');
      await expect(page.locator('#launcher')).toBeVisible();
    }
  });

  gated('a session\'s address is the sign-in form while signed out, and signing in lands on it: the real Worker names the learner and lists their sessions', async ({ page, gateServer }) => {
    await page.setViewportSize(WIDE);
    await page.addInitScript(() => {
      localStorage.setItem('opalixOnboarded', '1');
      localStorage.setItem('opalixLearn', '{"v":1,"onboarding":{"status":"skipped"}}');
    });
    // Another session's address, for a lab this learner has a session for.
    const address = sessionUrl(PLAIN, '', OTHER_SESSION_ID);
    const response = await page.goto(`${gateServer}${address}`, { waitUntil: 'domcontentloaded' });
    expect(response!.status()).toBe(200);
    await expect(page.locator('#f')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(address);
    await page.fill('#pw', 'pw');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForSelector('body[data-booted="1"]');
    expect(new URL(page.url()).pathname).toBe(address);
    // Not the learner's active session, but they have another for this lab: Rejoin is offered.
    await expect(page.locator('#sessionGone')).toBeVisible();
    await expect(page.locator('#sgRejoin')).toBeVisible();

    // Their id is what the Worker says it is, and another's is not found.
    const me = await page.evaluate(() => fetch('/api/me').then((r) => r.json()));
    expect(me).toEqual({ sub: 'console', user_id: 'console' });
    const active = await page.evaluate(() => fetch('/api/sessions/active').then((r) => r.json()));
    expect(active).toEqual({ sessions: [{ id: SESSION_ID, lab: PLAIN, state: 'running' }] });
    expect(JSON.stringify(active)).not.toMatch(/never-shown|user_id|console/);
    await page.goto(`${gateServer}${sessionUrl(PLAIN, '', SESSION_ID, 'someone-else')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('#notFound')).toBeVisible();
  });

  gated('the Worker answers /api/* with 401 JSON, not the form, when signed out', async ({ page, gateServer }) => {
    for (const path of ['/api/labs', '/api/me', '/api/sessions/active']) {
      const res = await page.request.get(`${gateServer}${path}`);
      expect(res.status(), path).toBe(401);
      expect(res.headers()['content-type'], path).toContain('json');
    }
  });
});

// =========================================================================
// no sideways scroll
// =========================================================================

test.describe('no horizontal scroll at the new addresses', () => {
  for (const width of [390, 768, 1280, 1440]) {
    test(`the steps, the not-found screen and the session at ${width}px`, async ({ page }) => {
      await stub(page);
      await page.setViewportSize({ width, height: 900 });
      await visit(page, `/labs/${EXPLORE}/story`);
      await expect(heading(page)).toHaveText(full.story!.title);
      await noHorizontalScroll(page);
      await page.goto(`/labs/${EXPLORE}/lessons`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-booted="1"]');
      await expect(heading(page)).toHaveText(LESSONS);
      await noHorizontalScroll(page);
      await page.goto('/labs/no-such-lab', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-booted="1"]');
      await expect(page.locator('#notFound')).toBeVisible();
      await noHorizontalScroll(page);
      // The four pages and the "not active" page.
      for (const [url, marker] of [['/', '.path-card'], ['/paths/ai-platform', '.module-card'], [MODULE_1, '.module .lab'], [`/labs/${EXPLORE}`, '.lab-detail']] as const) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('body[data-booted="1"]');
        await expect(page.locator(marker).first(), url).toBeVisible();
        await noHorizontalScroll(page);
      }
      await page.goto(sessionUrl(PLAIN, '', OTHER_SESSION_ID), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-booted="1"]');
      // A phone is told labs need a desktop before anything else; wider screens are told the session is not active.
      await expect(page.locator(width < 760 ? '#desktopNotice' : '#sessionGone')).toBeVisible();
      await noHorizontalScroll(page);
      if (width >= 1280) {
        await page.goto(`/labs/${PLAIN}/session`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('body[data-booted="1"]');
        await inSession(page);
        await noHorizontalScroll(page);
      }
    });
  }
});

// =========================================================================
// archived labs: hidden from the launcher, still reachable by address
// =========================================================================

/**
 * The catalogue the way the API serves it once the five test fixtures are archived: every lab is
 * there, the archived ones flagged. One archived lab has a story (so its address opens a step);
 * `hello`, `impatient` and `gateway-hello` have nothing to read and belong to no path.
 */
const ARCHIVED_STORY = 'archived-with-a-story';
type LabRow = Record<string, unknown> & { slug: string; archived?: boolean };
const archivedLab = (o: LabRow) => lab({ archived: true, family: 'agent', has_learn: false, ...o }) as unknown as LabRow;
const NO_PATH = { path: undefined, module: undefined, order: undefined };
const WITH_ARCHIVED: LabRow[] = [
  ...(LABS as unknown as LabRow[]),
  archivedLab({ slug: 'hello', title: 'Hello, sandbox', ...NO_PATH }),
  archivedLab({ slug: 'impatient', title: 'Impatient (idle-timeout fixture)', ...NO_PATH }),
  archivedLab({ slug: 'gateway-hello', title: 'Gateway hello', family: 'gateway', ...NO_PATH }),
  archivedLab({ slug: ARCHIVED_STORY, title: 'Archived with a story', order: 9, has_learn: true }),
];
BUNDLES[ARCHIVED_STORY] = { story: full.story, concepts: [], questions: [], answers_file: full.answers_file, fields: [] };

/** The stub, with the catalogue above in place of its own. */
async function stubArchived(page: Page): Promise<Stub> {
  const s = await stub(page);
  // The last route registered answers first, so this replaces the catalogue and leaves the rest of the stub.
  await page.route('**/api/labs', (route) => json(route, WITH_ARCHIVED));
  return s;
}

test.describe('archived labs', () => {
  test('home shows none of them: no "Other labs" card, and the counts leave them out', async ({ page }) => {
    const s = await stubArchived(page);
    await wide(page);
    await visit(page, '/');
    // One path, so one card, and no card for labs with no path.
    await expect(page.locator('.path-card')).toHaveCount(1);
    await expect(page.locator('#path-other')).toHaveCount(0);
    await expect(page.locator('#labList')).not.toContainText('Other labs');
    // The totals are the learner's: five labs, not nine.
    await expect(page.locator('#labCount')).toHaveText(`${LABS.length} of ${LABS.length} labs`);
    await expect(page.locator('.path-card-line')).toContainText(`${LABS.length} labs`);
    await expect(page.locator('.path-card .progress').first()).toHaveAttribute('aria-valuemax', String(LABS.length));
    // The archived labs' own family (agent) is not offered as a filter.
    await expect(page.locator('button.filter-chip[data-filter="family"]')).toHaveText(['gateway']);
    // The module's page lists the five, and none of the archived ones.
    await openModule(page);
    await expect(page.locator('.lab')).toHaveCount(LABS.length);
    for (const l of WITH_ARCHIVED.filter((x) => x.archived)) await expect(page.locator(`.lab[data-slug="${l.slug}"]`)).toHaveCount(0);
    await expect(page.locator('.module-progress')).toHaveText(`0 of ${LABS.length} done`);
    expect(s.starts).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  test('search finds none of them, by title or by slug', async ({ page }) => {
    await stubArchived(page);
    await wide(page);
    await visit(page, '/');
    for (const q of ['hello', 'Impatient', ARCHIVED_STORY]) {
      await page.locator('#labSearch').fill(q);
      await expect(page.locator('.path-card')).toHaveCount(0);
      await expect(page.locator('#labNoMatch')).toBeVisible();
      await expect(page.locator('#labCount')).toHaveText(`0 of ${LABS.length} labs`);
    }
    // A lab that is not archived is still found by the same box, and the card says so.
    await page.locator('#labSearch').fill(PLAIN_TITLE);
    await expect(page.locator('.path-card')).toHaveCount(1);
    await expect(page.locator('#labCount')).toHaveText(`1 of ${LABS.length} labs`);
    await openModule(page);
    await expect(page.locator('.lab')).toHaveCount(1);
    await expect(page.locator('.lab')).toHaveAttribute('data-slug', PLAIN);
  });

  test('the "Other labs" card is still there for a real lab with no path, and its page lists it', async ({ page }) => {
    await stubArchived(page);
    const loose = lab({ slug: 'loose-real', title: 'A loose real lab', ...NO_PATH });
    await page.route('**/api/labs', (route) => json(route, [...WITH_ARCHIVED, loose]));
    await wide(page);
    await visit(page, '/');
    await expect(page.locator('.path-card')).toHaveCount(2);
    await expect(page.locator('#path-other')).toBeVisible();
    await expect(page.locator('#labCount')).toHaveText(`${LABS.length + 1} of ${LABS.length + 1} labs`);
    await page.locator('#path-other').getByRole('link', { name: 'Other labs' }).click();
    expect(here_(page)).toBe('/paths/other');
    await expect(page.locator('.lab')).toHaveCount(1);
    await expect(page.locator('.lab')).toHaveAttribute('data-slug', 'loose-real');
    expect(await crumbTexts(page)).toEqual(['Home', 'Other labs']);
  });

  test('a catalogue with only archived labs says no labs are published, and their addresses still open', async ({ page }) => {
    const s = await stub(page);
    await page.route('**/api/labs', (route) => json(route, WITH_ARCHIVED.filter((l) => l.archived)));
    await wide(page);
    await visit(page, '/');
    await expect(page.locator('#labList .empty-state')).toContainText('No labs are available yet');
    await expect(page.locator('.lab')).toHaveCount(0);
    await expect(page.locator('.path-card')).toHaveCount(0);
    await visit(page, `/labs/${ARCHIVED_STORY}`);
    await expect(page.locator('#notFound')).toBeHidden();
    await expect(page.locator('.lab-detail-title')).toHaveText('Archived with a story');
    expect(s.starts).toEqual([]);
  });

  test('/labs/<slug> of an archived lab with something to read is its page, and Start opens the story, not "Page not found"', async ({ page }) => {
    const s = await stubArchived(page);
    await wide(page);
    await visit(page, `/labs/${ARCHIVED_STORY}`);
    await expect(page.locator('#notFound')).toBeHidden();
    await expect(page.locator('.lab-detail-title')).toHaveText('Archived with a story');
    expect(here_(page)).toBe(`/labs/${ARCHIVED_STORY}`);
    await expect(page).toHaveTitle('Archived with a story · Opalix labs');
    await page.locator('.lab-detail .lab-start').click();
    await expect(heading(page)).toHaveText(full.story!.title);
    expect(here_(page)).toBe(`/labs/${ARCHIVED_STORY}/story`);
    expect(s.starts).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  test('/labs/<slug> of an archived lab with nothing to read is its page, with Home > Lab for a trail, not "Page not found"', async ({ page }) => {
    const s = await stubArchived(page);
    await wide(page);
    await visit(page, '/labs/hello');
    await expect(page.locator('#notFound')).toBeHidden();
    await expect(page.locator('.lab-detail-title')).toHaveText('Hello, sandbox');
    await expect(page.locator('.lab[data-slug="hello"]')).toHaveCount(0);
    expect(here_(page)).toBe('/labs/hello');
    await expect(page).toHaveTitle('Hello, sandbox · Opalix labs');
    expect(await crumbTexts(page)).toEqual(['Home', 'Hello, sandbox']);
    // A lab that does not exist is still not found.
    await page.goto('/labs/never-published', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('#notFound')).toBeVisible();
    expect(s.starts).toEqual([]);
  });

  test('/labs/<slug>/session starts an archived lab by its slug, and a refresh rejoins it', async ({ page }) => {
    const s = await stubArchived(page);
    await wide(page);
    await visit(page, '/labs/hello/session');
    await inSession(page);
    expect(s.starts).toEqual(['hello']);
    expect(here_(page)).toBe(sessionUrl('hello'));
    await expect(page.locator('#sessionLab')).toHaveText('hello');
    await expect(page.locator('#sessionTitle')).toHaveText('Hello, sandbox');
    await expect(page).toHaveTitle('Session · Hello, sandbox · Opalix labs');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await inSession(page);
    expect(s.starts).toEqual(['hello']);
    expect(s.errors).toEqual([]);
    await noSecretsInAddresses(page);
  });

  test('a running archived lab is rejoined, and the resume card names it though no page lists it', async ({ page }) => {
    const s = await stubArchived(page);
    s.session.lab = 'hello';
    await wide(page);
    await visit(page, '/', { remembered: 'hello' });
    await inSession(page);
    expect(here_(page)).toBe(sessionUrl('hello'));
    expect(s.starts).toEqual([]);
    await page.goBack();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator('#resumeCard')).toContainText('Hello, sandbox');
    await expect(page.locator('.lab[data-slug="hello"]')).toHaveCount(0);
    // Rejoin asks the API to start the lab, which hands back the running session (as for any lab).
    await page.getByRole('button', { name: /Rejoin the lab/ }).click();
    await inSession(page);
    expect(here_(page)).toBe(sessionUrl('hello'));
    expect(s.starts).toEqual(['hello']);
    expect(s.errors).toEqual([]);
  });
});
