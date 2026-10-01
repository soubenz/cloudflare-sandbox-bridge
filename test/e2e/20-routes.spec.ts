import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { parse as parseYaml } from 'yaml';
import { serveConsole, serveWorker } from './console-server';

/**
 * Real addresses for the console: /labs/<slug>, /labs/<slug>/lessons, /labs/<slug>/session/hints ...
 * (dashboard/src/routes.js has the table, docs/console-routes.md the story).
 *
 * What is pinned here:
 *   - a deep link opens the screen it names, and a refresh keeps the learner there;
 *   - Back and Forward move between screens (lessons -> story -> launcher), and Back out of a running
 *     lab goes to the launcher with the Rejoin card, without ending it;
 *   - /labs/<slug>/session starts the lab when nothing is running and rejoins it when something is;
 *   - a tab change inside the session replaces the address in place (the history does not grow);
 *   - an unknown lab, path, step or tab ends in "not found" or in the address that does exist;
 *   - a phone at a deep link gets the desktop notice, with that lab's own link;
 *   - the tab title follows the screen; a session id or token is never in an address;
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
const TOKEN = 'test-token';

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
}

async function stub(page: Page): Promise<Stub> {
  const waiting: Array<() => void> = [];
  const s: Stub = { starts: [], ends: [], sessionCalls: [], errors: [], session: { state: 'running', lab: null } };
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) s.errors.push(msg.text());
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === '/api/me') return json(route, { sub: 'console' });
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
const startCard = (page: Page, slug: string) => page.locator(`.lab[data-slug="${slug}"] .lab-start`).click();
const urlLog = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('__urls') || '[]') as string[]);

async function inSession(page: Page) {
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#statePill')).toHaveText('running');
  await expect(page.locator('#bootModal')).toBeHidden();
  await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
}

/** Neither a session id nor a token is in what the address bar showed. */
async function noSecretsInAddresses(page: Page) {
  expect(page.url()).not.toMatch(new RegExp(`${SESSION_ID}|${TOKEN}`, 'i'));
  for (const u of await urlLog(page)) {
    expect(u, 'an address the page wrote').not.toMatch(new RegExp(`${SESSION_ID}|${TOKEN}|token=`, 'i'));
    // And each one is an address of the table in routes.js.
    expect(u.split('?')[0], 'an address the page wrote').toMatch(/^\/(?:$|onboarding$|paths\/[a-z0-9-]+(?:\/modules\/\d+)?$|labs\/[a-z0-9-]+(?:\/(?:story|questions|lessons|session(?:\/(?:brief|questions|hints|checks|solution|terminal|editor|service\/[A-Za-z0-9._-]+))?))?$)/);
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

  test('/labs/<slug> opens the first step the lab has, and says so in the address (replaced, not pushed)', async ({ page }) => {
    await stub(page);
    await wide(page);
    const before = await historyLength(page);
    await visit(page, `/labs/${EXPLORE}`);
    await expect(heading(page)).toHaveText(full.story!.title);
    expect(here_(page)).toBe(`/labs/${EXPLORE}/story`);
    expect(await historyLength(page)).toBe(before + 1);
  });

  test('a lab without a story begins at its lessons; one with questions due begins at them', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, `/labs/${LESSONS_ONLY}`);
    await expect(heading(page)).toHaveText(LESSONS);
    expect(here_(page)).toBe(`/labs/${LESSONS_ONLY}/lessons`);

    const asking = await page.context().newPage();
    await stub(asking);
    await visit(asking, `/labs/${LESSONS_ASKING}`, { mastery: SKIPPED });
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

  test('a lab with nothing to read lands on the launcher at its card, and starts nothing', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await visit(page, `/labs/${PLAIN}`);
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator(`.lab[data-slug="${PLAIN}"] .lab-start`)).toBeFocused();
    expect(here_(page)).toBe(`/labs/${PLAIN}`);
    await expect(page).toHaveTitle(`${PLAIN_TITLE} · Opalix labs`);
    // Its steps do not exist: they end up here too.
    await page.goto(`/labs/${PLAIN}/lessons`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    expect(here_(page)).toBe(`/labs/${PLAIN}`);
    expect(s.starts).toEqual([]);
    await expect(page.locator('#workspace')).toBeHidden();
  });

  test('answering the quick questions replaces their address with the lessons\' (Back goes to the story)', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, `/labs/${EXPLORE}/story`, { mastery: SKIPPED });
    await page.getByRole('button', { name: 'Continue' }).click();
    expect(here_(page)).toBe(`/labs/${EXPLORE}/questions`);
    await expect(page).toHaveTitle(`Quick questions · ${EXPLORE_TITLE} · Opalix labs`);
    const length = await historyLength(page);
    for (let i = 0; i < 20 && (await heading(page).innerText()) !== LESSONS; i++) {
      await host(page).locator('.quiz-option input').first().check();
      await page.getByRole('button', { name: 'Check', exact: true }).click();
      await host(page).locator('.quiz-form .learn-actions button').filter({ hasNotText: 'Check' }).click();
    }
    await expect(heading(page)).toHaveText(LESSONS);
    expect(here_(page)).toBe(`/labs/${EXPLORE}/lessons`);
    expect(await historyLength(page)).toBe(length);
    await page.goBack();
    await expect(heading(page)).toHaveText(full.story!.title);
    expect(here_(page)).toBe(`/labs/${EXPLORE}/story`);
  });
});

// =========================================================================
// Back and Forward
// =========================================================================

test.describe('Back and Forward', () => {
  test('story -> lessons -> session -> launcher, and forward again, with no session id or token in any address', async ({ page }) => {
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
    expect(here_(page)).toBe(`/labs/${EXPLORE}/session`);
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
    await page.goBack();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator('#learnScreen')).toBeHidden();
    expect(here_(page)).toBe('/');
    await expect(page).toHaveTitle('Opalix labs');
    await expect(page.locator('#resumeCard')).toBeVisible();
    expect(s.ends).toEqual([]);

    // Forward all the way: the session is rejoined, not started again.
    await page.goForward();
    await expect(heading(page)).toHaveText(full.story!.title);
    await page.goForward();
    await expect(heading(page)).toHaveText(LESSONS);
    await page.goForward();
    await inSession(page);
    expect(here_(page)).toBe(`/labs/${EXPLORE}/session`);
    expect(s.starts).toEqual([EXPLORE]);
    expect(s.ends).toEqual([]);
    expect(s.errors).toEqual([]);
    await noSecretsInAddresses(page);
  });

  test('Back out of a running lab is the launcher with the Rejoin card; the lab is not ended; a refresh stays on the launcher', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await visit(page, '/');
    await startCard(page, PLAIN);
    await inSession(page);
    expect(here_(page)).toBe(`/labs/${PLAIN}/session`);

    await page.goBack();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator('#workspace')).toBeHidden();
    expect(here_(page)).toBe('/');
    await expect(page.locator('#heroTitle')).toHaveText('Pick up where you left off.');
    await expect(page.locator('#resumeCard')).toContainText(PLAIN_TITLE);
    await expect(page.locator(`.lab[data-slug="${PLAIN}"] .lab-start`)).toHaveText('Rejoin');
    expect(s.ends).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('opalix.session'))).toContain(SESSION_ID);

    // A refresh of the launcher does not walk back in: Back put the learner here.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator('#workspace')).toBeHidden();
    await expect(page.locator('#resumeCard')).toBeVisible();

    // Rejoin is one press, and puts the lab's address back.
    await page.getByRole('button', { name: /Rejoin the lab/ }).click();
    await inSession(page);
    expect(here_(page)).toBe(`/labs/${PLAIN}/session`);
    expect(s.errors).toEqual([]);
  });

  test('Ending the lab replaces its address with the launcher\'s, so Back cannot lead to a lab that is gone', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    await visit(page, '/');
    await startCard(page, PLAIN);
    await inSession(page);
    await page.locator('#btnEnd').click();
    await page.locator('#endDialog').getByRole('button', { name: 'Discard' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    expect(here_(page)).toBe('/');
    expect(s.ends).toHaveLength(1);
    // Back is the launcher the learner came from, not the dead session.
    await page.goBack();
    expect(here_(page)).not.toContain('/session');
    expect(s.starts).toEqual([PLAIN]);
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

test.describe('/labs/<slug>/session', () => {
  test('starts the lab when nothing is running, and a refresh then rejoins it', async ({ page }) => {
    const s = await stub(page);
    await wide(page);
    const before = await historyLength(page);
    await visit(page, `/labs/${PLAIN}/session`);
    await inSession(page);
    expect(s.starts).toEqual([PLAIN]);
    expect(here_(page)).toBe(`/labs/${PLAIN}/session`);
    expect(await historyLength(page)).toBe(before + 1);
    await expect(page).toHaveTitle(`Session · ${PLAIN_TITLE} · Opalix labs`);
    await expect(page.locator('#sessionTitle')).toHaveText(PLAIN_TITLE);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await inSession(page);
    // The remembered session was asked about, not started again.
    expect(s.starts).toEqual([PLAIN]);
    expect(s.errors).toEqual([]);
    await noSecretsInAddresses(page);
  });

  test('rejoins the lab that is running instead of starting another', async ({ page }) => {
    const s = await stub(page);
    s.session.lab = PLAIN;
    await wide(page);
    await visit(page, `/labs/${PLAIN}/session`, { remembered: PLAIN });
    await inSession(page);
    expect(s.starts).toEqual([]);
    expect(here_(page)).toBe(`/labs/${PLAIN}/session`);
  });

  test('a link to another lab while one is running lands in the running lab, with its own address, and says so', async ({ page }) => {
    const s = await stub(page);
    s.session.lab = PLAIN;
    await wide(page);
    await visit(page, `/labs/${STORY_ONLY}/session`, { remembered: PLAIN });
    await inSession(page);
    expect(s.starts).toEqual([]);
    expect(here_(page)).toBe(`/labs/${PLAIN}/session`);
    await expect(page.locator('#toast')).toContainText('You already had a lab running');
    await expect(page).toHaveTitle(`Session · ${PLAIN_TITLE} · Opalix labs`);
  });

  test('a session that has ended is not restarted by a refresh: the lab is one press away', async ({ page }) => {
    const s = await stub(page);
    s.session.state = 'ended';
    await wide(page);
    await visit(page, `/labs/${PLAIN}/session`, { remembered: PLAIN });
    await expect(page.locator('#launcher')).toBeVisible();
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
    expect(here_(page)).toBe(`/labs/${PLAIN}/session`);
    expect(s.starts).toEqual([]);
    // Back is the launcher, and a refresh there stays.
    await page.goBack();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator('#resumeCard')).toBeVisible();
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
      ['#tabChecks', `/labs/${PLAIN}/session/checks`],
      ['#tabHints', `/labs/${PLAIN}/session/hints`],
      ['#tabBrief', `/labs/${PLAIN}/session/brief`],
      ['#tabTerminal', `/labs/${PLAIN}/session/terminal`],
      ['#tabEditor', `/labs/${PLAIN}/session/editor`],
      ['#serviceTabs .tab[data-service="echo"]', `/labs/${PLAIN}/session/service/echo`],
    ];
    for (const [selector, path] of steps) {
      await page.locator(selector).click();
      expect(here_(page), selector).toBe(path);
      expect(await historyLength(page), selector).toBe(length);
    }
    // The keyboard changes tabs the same way.
    await page.locator('#tabBrief').click();
    await page.locator('#tabBrief').press('ArrowRight');
    expect(here_(page)).toBe(`/labs/${PLAIN}/session/checks`);
    expect(await historyLength(page)).toBe(length);
    await noSecretsInAddresses(page);
  });

  test('a refresh keeps the tab: guide tab, workspace tab, service tab', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, `/labs/${PLAIN}/session/hints`, { remembered: PLAIN });
    await inSession(page);
    await expect(page.locator('#tabHints')).toHaveAttribute('aria-selected', 'true');
    expect(here_(page)).toBe(`/labs/${PLAIN}/session/hints`);

    await page.goto(`/labs/${PLAIN}/session/terminal`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await inSession(page);
    await expect(page.locator('#tabTerminal')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#viewTerminal')).toHaveClass(/view-active/);
    // The guide opens on its first tab: the address named a workspace tab only.
    await expect(page.locator('#tabBrief')).toHaveAttribute('aria-selected', 'true');

    await page.goto(`/labs/${PLAIN}/session/service/echo`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await inSession(page);
    await expect(page.locator('#serviceTabs .tab[data-service="echo"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#viewService')).toHaveClass(/view-active/);
    expect(here_(page)).toBe(`/labs/${PLAIN}/session/service/echo`);
  });

  test('a tab the lab does not have, or that does not exist, makes the address the session\'s own', async ({ page }) => {
    await stub(page);
    await wide(page);
    for (const tab of ['solution', 'questions', 'nope', 'service/ghost', 'service', 'brief/extra']) {
      await page.goto(`/labs/${PLAIN}/session/${tab}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-booted="1"]');
      await inSession(page);
      await expect.poll(() => here_(page), tab).toBe(`/labs/${PLAIN}/session`);
      await expect(page.locator('#tabBrief')).toHaveAttribute('aria-selected', 'true');
    }
  });

  test('Back after tab changes leaves the session in one step, not one per tab', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, '/');
    await startCard(page, PLAIN);
    await inSession(page);
    for (const selector of ['#tabChecks', '#tabHints', '#tabTerminal', '#tabEditor']) await page.locator(selector).click();
    await page.goBack();
    await expect(page.locator('#launcher')).toBeVisible();
    expect(here_(page)).toBe('/');
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
    for (const path of ['/nope', '/labs', '/labs/', '/labs/a//b', '/labs/Caf%C3%A9', `/labs/${long}`, '/paths/nope', '/paths/ai-platform/modules/99', '/labs/x/y/z', '/onboarding/extra', '/a/b/c/d']) {
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

test.describe('/paths/<path>', () => {
  test('opens the launcher at that path; a pill keeps the address in step', async ({ page }) => {
    await stub(page);
    await wide(page);
    await visit(page, '/paths/ai-platform');
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator('#path-ai-platform')).toBeVisible();
    await expect(page).toHaveTitle('Opalix labs');
    expect(here_(page)).toBe('/paths/ai-platform');

    await page.goto('/paths/ai-platform/modules/1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('#path-ai-platform-module-1')).toBeVisible();
    expect(here_(page)).toBe('/paths/ai-platform/modules/1');

    await page.goto('/paths/no-such-path', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('#notFound')).toBeVisible();
    await page.goto('/paths/ai-platform/modules/42', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('#notFound')).toBeVisible();
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
    expect(here_(page)).toBe(`/labs/${PLAIN}/session`);
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
      const { url, server }: { url: string; server: Server } = await serveWorker({ labs: LABS, learn: (slug) => BUNDLES[slug] ?? null });
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
    await expect(heading(page)).toHaveText(LESSONS);
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

  gated('the Worker answers /api/* with 401 JSON, not the form, when signed out', async ({ page, gateServer }) => {
    const res = await page.request.get(`${gateServer}/api/labs`);
    expect(res.status()).toBe(401);
    expect(res.headers()['content-type']).toContain('json');
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
  test('the launcher shows none of them: no "Other labs" band, no cards, no pill, and the counts leave them out', async ({ page }) => {
    const s = await stubArchived(page);
    await wide(page);
    await visit(page, '/');
    await expect(page.locator('.lab')).toHaveCount(LABS.length);
    for (const l of WITH_ARCHIVED.filter((x) => x.archived)) await expect(page.locator(`.lab[data-slug="${l.slug}"]`)).toHaveCount(0);
    // One path, so no signpost and no band for labs with no path.
    await expect(page.locator('.lab-group')).toHaveCount(1);
    await expect(page.locator('#path-other')).toHaveCount(0);
    await expect(page.locator('#labList')).not.toContainText('Other labs');
    await expect(page.locator('#pathNav')).toBeHidden();
    // The totals are the learner's: five labs, not nine.
    await expect(page.locator('#labCount')).toHaveText(`${LABS.length} of ${LABS.length} labs`);
    await expect(page.locator('.lab-group .path-summary')).toContainText(`${LABS.length} labs`);
    await expect(page.locator('.lab-group .progress').first()).toHaveAttribute('aria-valuemax', String(LABS.length));
    // The archived labs' own family (agent) is not offered as a filter.
    await expect(page.locator('button.filter-chip[data-filter="family"]')).toHaveText(['gateway']);
    expect(s.starts).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  test('search finds none of them, by title or by slug', async ({ page }) => {
    await stubArchived(page);
    await wide(page);
    await visit(page, '/');
    for (const q of ['hello', 'Impatient', ARCHIVED_STORY]) {
      await page.locator('#labSearch').fill(q);
      await expect(page.locator('.lab:not([hidden])')).toHaveCount(0);
      await expect(page.locator('#labNoMatch')).toBeVisible();
      await expect(page.locator('#labCount')).toHaveText(`0 of ${LABS.length} labs`);
    }
    // A lab that is not archived is still found by the same box.
    await page.locator('#labSearch').fill(PLAIN_TITLE);
    await expect(page.locator('.lab:not([hidden])')).toHaveCount(1);
  });

  test('the "Other labs" band is still there for a real lab with no path', async ({ page }) => {
    await stubArchived(page);
    const loose = lab({ slug: 'loose-real', title: 'A loose real lab', ...NO_PATH });
    await page.route('**/api/labs', (route) => json(route, [...WITH_ARCHIVED, loose]));
    await wide(page);
    await visit(page, '/');
    await expect(page.locator('#path-other')).toBeVisible();
    await expect(page.locator('#path-other .lab')).toHaveCount(1);
    await expect(page.locator('#path-other .lab')).toHaveAttribute('data-slug', 'loose-real');
    await expect(page.locator('#labCount')).toHaveText(`${LABS.length + 1} of ${LABS.length + 1} labs`);
  });

  test('a catalogue with only archived labs says no labs are published, and their addresses still open', async ({ page }) => {
    const s = await stub(page);
    await page.route('**/api/labs', (route) => json(route, WITH_ARCHIVED.filter((l) => l.archived)));
    await wide(page);
    await visit(page, '/');
    await expect(page.locator('#labList .empty-state')).toContainText('No labs are published yet');
    await expect(page.locator('.lab')).toHaveCount(0);
    await visit(page, `/labs/${ARCHIVED_STORY}`);
    await expect(page.locator('#notFound')).toBeHidden();
    await expect(heading(page)).toHaveText(full.story!.title);
    expect(s.starts).toEqual([]);
  });

  test('/labs/<slug> still opens the page of an archived lab with something to read, not "Page not found"', async ({ page }) => {
    const s = await stubArchived(page);
    await wide(page);
    await visit(page, `/labs/${ARCHIVED_STORY}`);
    await expect(page.locator('#notFound')).toBeHidden();
    await expect(heading(page)).toHaveText(full.story!.title);
    expect(here_(page)).toBe(`/labs/${ARCHIVED_STORY}/story`);
    await expect(page).toHaveTitle('Archived with a story · Opalix labs');
    expect(s.starts).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  test('/labs/<slug> of an archived lab with nothing to read lands on the launcher, not "Page not found"', async ({ page }) => {
    const s = await stubArchived(page);
    await wide(page);
    await visit(page, '/labs/hello');
    await expect(page.locator('#notFound')).toBeHidden();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator('.lab[data-slug="hello"]')).toHaveCount(0);
    expect(here_(page)).toBe('/labs/hello');
    await expect(page).toHaveTitle('Hello, sandbox · Opalix labs');
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
    expect(here_(page)).toBe('/labs/hello/session');
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

  test('a running archived lab is rejoined, and the resume card names it though the launcher has no card for it', async ({ page }) => {
    const s = await stubArchived(page);
    s.session.lab = 'hello';
    await wide(page);
    await visit(page, '/', { remembered: 'hello' });
    await inSession(page);
    expect(here_(page)).toBe('/labs/hello/session');
    expect(s.starts).toEqual([]);
    await page.goBack();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator('#resumeCard')).toContainText('Hello, sandbox');
    await expect(page.locator('.lab[data-slug="hello"]')).toHaveCount(0);
    // Rejoin asks the API to start the lab, which hands back the running session (as for any lab).
    await page.getByRole('button', { name: /Rejoin the lab/ }).click();
    await inSession(page);
    expect(here_(page)).toBe('/labs/hello/session');
    expect(s.starts).toEqual(['hello']);
    expect(s.errors).toEqual([]);
  });
});
