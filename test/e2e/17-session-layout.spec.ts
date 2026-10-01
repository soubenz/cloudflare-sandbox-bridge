import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Locator, type Page, type Route } from '@playwright/test';
import { parse as parseYaml } from 'yaml';
import { serveConsole } from './console-server';

/**
 * The session screen's layout: the guide (Brief, Questions, Checks, Hints, Solution) beside the
 * workspace window, the rail it collapses to, the dock under both. The story and the lessons are
 * not in it: they are read full screen before the lab starts (19-lessons-flow.spec.ts).
 *
 * Like 16-learning.spec.ts this needs no password, no API and no container: a small static
 * server serves dashboard/public (the built bundle, with the CSP from public/_headers) and every
 * call the console makes is answered by a route stub, the session's too (status, events, files,
 * checks, the service proxy, the end call). The learn bundle is the real one, compiled from
 * labs/see-what-a-gateway-does/learn.
 *
 * Run `npm run build:dashboard` first (the page loads dashboard/public/dist).
 * SESSION_SHOTS_DIR chooses where the screenshots go (default test/e2e/shots/session);
 * SESSION_SHOTS=0 skips them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC = join(ROOT, 'dashboard/public');
const API = 'https://opalix-sandbox.soubenz94.workers.dev';
const SHOTS = process.env.SESSION_SHOTS_DIR || join(here, 'shots/session');
const SESSION_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';

// --------------------------------------------------------------- the content

interface Bundle {
  story?: { title: string; minutes: number; body: string };
  concepts: Array<{ id: string; title: string; minutes: number; recap: string; body: string }>;
  questions: unknown[];
  answers_file: string;
  fields: Array<{ key: string; prompt: string; kind: string; choices?: string[]; help?: string }>;
}

/** The lab's learn/ folder as the bundle the API would serve (the CLI's compiler cannot be imported here). */
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
      return { id: data.id, title: data.title, minutes: data.minutes, recap: data.recap, body };
    });
  const quiz = parseYaml(readFileSync(join(dir, 'quiz.yaml'), 'utf8')) as { questions: Array<Record<string, unknown>> };
  const qs = parseYaml(readFileSync(join(dir, 'questions.yaml'), 'utf8')) as { answers_file: string; fields: Bundle['fields'] };
  return {
    story: { title: story.data.title, minutes: story.data.minutes, body: story.body },
    concepts,
    questions: quiz.questions.map((q) => ({ diagnostic: true, ...q })),
    answers_file: qs.answers_file,
    fields: qs.fields,
  };
}

const EXPLORE = 'see-what-a-gateway-does';
const BUILD_LEARN = 'put-a-hard-budget-on-every-team';
const BUILD = 'keep-eu-data-on-eu-routes';
const EXPLORE_PLAIN = 'see-how-requests-are-routed-plain';
const SOLVED = 'fix-the-split-brain-chat';
const bundle = compileLearn(EXPLORE);
/** A build lab's bundle: the same lessons and story, but no graded questions. */
const buildBundle: Bundle = { ...bundle, fields: [] };
const ANSWERS_TEMPLATE = JSON.stringify({ support_deployment: null, support_tokens_hello: null, unknown_alias_status: null }, null, 2) + '\n';

const lab = (o: Record<string, unknown>): Record<string, any> => ({
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
  has_learn: false,
  progress: null,
  ...o,
});
const LABS = [
  lab({ slug: EXPLORE, title: 'See what a gateway does', type: 'explore', order: 1, has_learn: true }),
  lab({ slug: EXPLORE_PLAIN, title: 'See how requests are routed', type: 'explore', order: 2 }),
  lab({ slug: BUILD_LEARN, title: 'Put a hard budget on every team', order: 3, has_learn: true }),
  lab({ slug: BUILD, title: 'Keep EU data on EU routes', order: 4 }),
  lab({ slug: SOLVED, title: 'Fix the split-brain chat', type: 'break-fix', order: 5 }),
];

// ------------------------------------------------------------- a fake console

interface Stub {
  /** What the next status says: `expires_at` in ms from now, and the lab's state and end reason. */
  status: { expiresInMs: number; state: string; endReason: string | null };
  /** Server-sent events the stream delivers when it is next opened (`id`, `event`, `data`); a stream with none waits for emit(). */
  events: Array<{ id: number; event: string; data: unknown }>;
  /** Delivers events on the stream now, as the API would push them to a running lab. */
  emit: (...events: Array<{ id: number; event: string; data: unknown }>) => void;
  resumes: number;
  touches: number;
  starts: string[];
  files: Map<string, string>;
  puts: string[];
  checkRuns: number;
  restarts: string[];
  ends: string[];
  errors: string[];
  /** Whether the next check run passes everything. */
  pass: { value: boolean };
  /** Shown as the status's `solution` field, per lab. */
  solution: { value: unknown };
}

const json = (route: Route, body: unknown, status = 200, extra: Record<string, string> = {}) => {
  const origin = route.request().headers()['origin'];
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { ...(origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {}), ...extra },
    body: JSON.stringify(body),
  });
};

async function stub(page: Page): Promise<Stub> {
  const waiting: Array<() => void> = [];
  const s: Stub = {
    status: { expiresInMs: 3_000_000, state: 'running', endReason: null },
    events: [],
    emit: (...events) => {
      s.events.push(...events);
      while (waiting.length) waiting.shift()!();
    },
    resumes: 0,
    touches: 0,
    starts: [],
    files: new Map([['answers.json', ANSWERS_TEMPLATE], ['gateway.yaml', 'model_list:\n  - model_name: support\n']]),
    puts: [],
    checkRuns: 0,
    restarts: [],
    ends: [],
    errors: [],
    pass: { value: false },
    solution: { value: undefined },
  };
  let lastRun: Record<string, unknown> | null = null;
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
    if (path.startsWith('/api/learn/') && method === 'GET') {
      const slug = decodeURIComponent(path.slice('/api/learn/'.length));
      if (slug === EXPLORE) return json(route, { version: '1.0.0', learn: bundle });
      if (slug === BUILD_LEARN) return json(route, { version: '1.0.0', learn: buildBundle });
      return json(route, { error: { code: 'no_learn', message: 'no learning content' } }, 404);
    }
    if (path === '/api/start' && method === 'POST') {
      const { lab: slug } = JSON.parse(route.request().postData() ?? '{}');
      s.starts.push(slug);
      return json(route, { id: SESSION_ID, state: 'starting', token: 'test-token', urls: { services: { echo: {} } } }, 202);
    }
    return json(route, { error: 'not stubbed' }, 404);
  });

  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const p = url.pathname;
    const base = `/sessions/${SESSION_ID}`;
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (p === base && method === 'GET') {
      const now = Date.now();
      const slug = s.starts.at(-1) ?? EXPLORE;
      return json(route, {
        meta: { state: s.status.state, lab_slug: slug, started_at: now, expires_at: now + s.status.expiresInMs, end_reason: s.status.endReason },
        services: { echo: { health: 'healthy' } },
        snapshots: [],
        cost: { usd: 0.03 },
        hints: { total: 3, schedule: [0, 12, 30], delivered: [{ index: 0, after_minutes: 0, text: 'Read the provider log first.' }] },
        manifest_summary: { title: 'A lab', checks: [{ name: 'support answered by a' }, { name: 'token count matches' }] },
        checks: lastRun ?? undefined,
        checks_history: lastRun ? [lastRun] : [],
        solution: slug === SOLVED ? s.solution.value : undefined,
        server_time: now,
      });
    }
    if (p === base && method === 'DELETE') {
      s.ends.push(url.search);
      return json(route, { ok: true });
    }
    if (p === `${base}/events`) {
      // Held open, saying nothing, until there are events; they are delivered once and the stream closes
      // (as a dropped one does), and the console opens it again.
      if (!s.events.length) await new Promise<void>((resolve) => waiting.push(resolve));
      const batch = s.events.splice(0);
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'cache-control': 'no-store' },
        body: batch.map((e) => `id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join(''),
      });
    }
    if (p === `${base}/touch` && method === 'POST') {
      s.touches++;
      return json(route, {});
    }
    if (p === `${base}/resume` && method === 'POST') {
      s.resumes++;
      s.status.state = 'running';
      s.status.endReason = null;
      return json(route, { meta: { state: 'resuming' }, token: 'test-token' });
    }
    if (p === `${base}/files` && method === 'GET') {
      const names = ['brief.md', ...[...s.files.keys()]];
      return json(route, names.map((name) => ({ name, size: name === 'brief.md' ? 30 : (s.files.get(name)?.length ?? 0), isDirectory: false })));
    }
    const file = p.startsWith(`${base}/files/`) ? decodeURIComponent(p.slice(`${base}/files/`.length)) : null;
    if (file !== null && method === 'GET') {
      if (file === 'brief.md') return json(route, { content: '# The brief\n\nSend a few calls and compare what the gateway says with what the provider says.\n\n## What to do\n\n- Send `support` a call.\n- Open the view tab.\n\n## Start here\n\n```\npython3 -B send_calls.py support "hello gateway"\npython3 -B send_calls.py fast "hello gateway"\n```\n' });
      const text = s.files.get(file);
      return text === undefined ? json(route, { error: { code: 'not_found', message: `${file} does not exist` } }, 404) : json(route, { content: text });
    }
    if (file !== null && method === 'PUT') {
      s.files.set(file, req.postData() ?? '');
      s.puts.push(file);
      return json(route, { ok: true });
    }
    if (p === `${base}/checks` && method === 'POST') {
      s.checkRuns++;
      const now = Date.now();
      lastRun = {
        run_id: `run-${s.checkRuns}`,
        started_at: now - 500,
        finished_at: now,
        results: [
          { name: 'support answered by a', pass: true, weight: 1 },
          { name: 'token count matches', pass: s.pass.value, weight: 2, message: s.pass.value ? '' : 'expected 11' },
        ],
      };
      return json(route, lastRun);
    }
    if (p === `${base}/services/echo/session` && method === 'POST') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'access-control-allow-credentials': 'true' } });
    if (p === `${base}/services/echo/restart` && method === 'POST') {
      s.restarts.push('echo');
      return json(route, { health: 'healthy' });
    }
    if (p.startsWith(`${base}/services/echo/`) && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: { 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'access-control-allow-credentials': 'true' },
        body: '<!doctype html><title>echo</title><body style="font:16px sans-serif"><h1>Echo service</h1><p>This is the lab service, answering.</p></body>',
      });
    }
    if (p.startsWith(base) && method !== 'GET') return json(route, {}, 200);
    return json(route, { error: 'not stubbed' }, 404);
  });

  // The terminal's WebSocket: accepted and silent.
  await page.routeWebSocket(/\/terminal/, () => {});
  return s;
}

// ----------------------------------------------------------------- the server

// The local stand-in for the Worker (static files, the CSP, and the SPA fallback for deep links) is shared: see console-server.ts.
const serve = serveConsole;

const test = base.extend<object, { staticServer: string }>({
  staticServer: [
    async ({}, use) => {
      if (!existsSync(join(PUBLIC, 'dist/app.js'))) throw new Error('dashboard/public/dist/app.js is missing: run `npm run build:dashboard` first');
      const { url, server } = await serve();
      await use(url);
      await new Promise((done) => server.close(done));
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ staticServer }, use) => use(staticServer),
});

// -------------------------------------------------------------------- helpers

/** Opens the console on the launcher, past the things that are other specs' business. */
async function open(page: Page, { theme }: { theme?: 'light' | 'dark' } = {}) {
  await page.addInitScript((t) => {
    localStorage.setItem('opalixOnboarded', '1');
    localStorage.setItem('opalixLearn', JSON.stringify({ v: 1, onboarding: { status: 'skipped', at: 1, levels: {} } }));
    if (t) localStorage.setItem('opalixTheme', t);
  }, theme ?? null);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
}

/** Starts a lab from its card (past "Before you begin" when it has one) and waits for the running session. */
async function startLab(page: Page, slug: string) {
  await page.locator(`.lab[data-slug="${slug}"] .lab-start`).click();
  const skip = page.getByRole('button', { name: 'Skip all, just start the lab' });
  if (LABS.find((l) => l.slug === slug)?.has_learn) await skip.click();
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#statePill')).toHaveText('running');
  await expect(page.locator('#bootModal')).toBeHidden();
  // The guide's tabs are final once the brief and the bundle have been read.
  await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
}

async function session(page: Page, slug: string, size = { width: 1440, height: 900 }, opts: { theme?: 'light' | 'dark' } = {}) {
  const s = await stub(page);
  await page.setViewportSize(size);
  await open(page, opts);
  await startLab(page, slug);
  return s;
}

const guide = (page: Page) => page.locator('#guide');
const rail = (page: Page) => page.locator('#guideRail');
const guideTabs = (page: Page) => page.locator('#guideTabs [role="tab"]:not([hidden])');
/** The guide's tabs by their data-guide-tab id, in the order shown. */
const tabIds = (page: Page) => guideTabs(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.guideTab));
const railIds = (page: Page) => page.locator('#railTabs button').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.railTab));
const activeTab = (page: Page) => page.locator('#guideTabs [role="tab"][aria-selected="true"]');
const widthOf = async (l: Locator) => (await l.boundingBox())!.width;

/** The page is not wider than the window; on failure, names the elements that stick out. */
const noHorizontalScroll = async (page: Page) => {
  const over = await page.evaluate(() => {
    const width = window.innerWidth;
    const wide: string[] = [];
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== 'visible' && p.getBoundingClientRect().right <= width + 0.5) return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > width + 0.5 && !clipped(el)) wide.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String((el as HTMLElement).className).split(' ')[0]} right=${Math.round(r.right)}`);
    }
    return { extra: document.documentElement.scrollWidth - width, wide: wide.slice(0, 8) };
  });
  expect(over.extra, `sticking out: ${over.wide.join(', ')}`).toBeLessThanOrEqual(0);
};

// =========================================================================
// the guide: open by default, and the tabs a lab has
// =========================================================================

test.describe('the guide', () => {
  test('is open by default on a wide window, beside the workspace window, with the rail out of the way', async ({ page }) => {
    const s = await session(page, BUILD);
    await expect(guide(page)).toBeVisible();
    await expect(rail(page)).toBeHidden();
    await expect(page.locator('#workspace')).toHaveAttribute('data-guide', 'open');
    await expect(page.locator('#window')).toBeVisible();
    // Two columns: the guide is to the left of the window, about 520px wide, the window takes the rest.
    const g = (await guide(page).boundingBox())!;
    const w = (await page.locator('#window').boundingBox())!;
    expect(g.x + g.width).toBeLessThanOrEqual(w.x);
    expect(g.width).toBeGreaterThan(480);
    expect(g.width).toBeLessThanOrEqual(521);
    expect(w.width).toBeGreaterThan(800);
    // The toggle says so, to a screen reader too.
    const toggle = page.locator('#btnGuideToggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-controls', 'guide');
    await expect(toggle).toContainText('Hide guide');
    expect(s.errors).toEqual([]);
  });

  test('opens a build lab on its Brief: Brief, Checks, Hints', async ({ page }) => {
    await session(page, BUILD);
    expect(await tabIds(page)).toEqual(['brief', 'checks', 'hints']);
    await expect(activeTab(page)).toHaveAttribute('data-guide-tab', 'brief');
    await expect(activeTab(page)).toHaveText('Brief');
    await expect(page.locator('#viewBrief')).toBeVisible();
    await expect(page.locator('#briefBody h2').first()).toHaveText('The brief');
    // What the lab says it teaches leads the brief.
    await expect(page.locator('#briefBody .objectives li').first()).toHaveText('do the thing');
  });

  test('gives a build lab that ships lessons no Lessons tab, and no folded story: it is Brief, Checks, Hints', async ({ page }) => {
    await session(page, BUILD_LEARN);
    expect(await tabIds(page)).toEqual(['brief', 'checks', 'hints']);
    await expect(activeTab(page)).toHaveText('Brief');
    await expect(guide(page).getByRole('tab', { name: 'Lessons' })).toHaveCount(0);
    await expect(guide(page).getByRole('tab', { name: 'Story' })).toHaveCount(0);
    // Nothing of the lessons or the story is folded into any pane of the guide.
    await expect(guide(page).locator('.lesson, .learn-story, .md-diagram, .cm')).toHaveCount(0);
    const text = await guide(page).innerText();
    expect(text).not.toContain(bundle.story!.title);
    for (const c of bundle.concepts) expect(text).not.toContain(c.title);
  });

  test('opens an explore lab on its Brief, then Questions and Hints: no Story, no Lessons', async ({ page }) => {
    await session(page, EXPLORE);
    expect(await tabIds(page)).toEqual(['brief', 'questions', 'hints']);
    await expect(activeTab(page)).toHaveAttribute('data-guide-tab', 'brief');
    await expect(page.locator('#viewBrief')).toBeVisible();
    await expect(guide(page).getByRole('tab', { name: 'Story' })).toHaveCount(0);
    await expect(guide(page).getByRole('tab', { name: 'Lessons' })).toHaveCount(0);
    await expect(guide(page).locator('.lesson, .learn-story, .md-diagram, .cm')).toHaveCount(0);
    // Its checks are read under its questions, so it has no Checks tab.
    await expect(page.locator('#tabChecks')).toBeHidden();
  });

  test('an explore lab without learning content is opened like any other lab: Brief, Checks, Hints', async ({ page }) => {
    await session(page, EXPLORE_PLAIN);
    expect(await tabIds(page)).toEqual(['brief', 'checks', 'hints']);
    await expect(activeTab(page)).toHaveText('Brief');
  });

  test('adds the Solution tab only when the API says a solution exists', async ({ page }) => {
    const s = await stub(page);
    s.solution.value = { available: true, unlocked: false, rule: 'Unlocks after 2 check runs.', progress: { check_runs: 0, hints_delivered: 1, hints_total: 3, completed: false } };
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await startLab(page, SOLVED);
    expect(await tabIds(page)).toEqual(['brief', 'checks', 'hints', 'solution']);
    await page.getByRole('tab', { name: 'Solution' }).click();
    await expect(page.locator('#solutionBlock')).toBeVisible();
    await expect(page.locator('#solutionBlock')).toContainText('Unlocks after 2 check runs.');
    // Locked: no way to open it early.
    await expect(page.locator('#solutionBlock').getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Solution/ })).toHaveAttribute('aria-label', 'Solution, locked');
    // A lab with no solution has no such tab.
    s.solution.value = undefined;
    await page.locator('#btnEnd').click();
    await page.locator('#endDialog').getByRole('button', { name: 'Discard' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await startLab(page, BUILD);
    await expect(page.locator('#tabSolution')).toBeHidden();
  });

  test('reads the Hints: the delivered one, the locked one with its countdown, and no reveal button', async ({ page }) => {
    await session(page, BUILD);
    await page.getByRole('tab', { name: /Hints/ }).click();
    await expect(page.locator('#viewHints')).toBeVisible();
    await expect(page.locator('#hintsPanel .hint').first()).toContainText('Read the provider log first.');
    await expect(page.locator('#hintsPanel .hint-locked').first()).toContainText(/Hint 2 · unlocks in/);
    await expect(page.locator('#hintsPanel').getByRole('button')).toHaveCount(0);
    // One step per slot, decoration for the eye: the first shown, the others locked.
    await expect(page.locator('#hintSteps span')).toHaveCount(3);
    await expect(page.locator('#hintSteps .on')).toHaveCount(1);
    await expect(page.locator('#hintsMeta')).toHaveText('1 of 3 shown');
  });
});

// =========================================================================
// hiding the guide: the rail
// =========================================================================

test.describe('hiding the guide', () => {
  test('hide leaves a 64px rail, gives the width to the window, and the keyboard lands on Show', async ({ page }) => {
    await session(page, EXPLORE);
    const before = await widthOf(page.locator('#window'));
    await page.locator('#btnGuideHide').click();

    await expect(guide(page)).toBeHidden();
    await expect(rail(page)).toBeVisible();
    await expect(page.locator('#workspace')).toHaveAttribute('data-guide', 'closed');
    expect(Math.round(await widthOf(rail(page)))).toBe(64);
    expect(await widthOf(page.locator('#window'))).toBeGreaterThan(before + 400);
    await expect(page.locator('#btnGuideShow')).toBeFocused();
    await expect(page.locator('#btnGuideShow')).toHaveAttribute('aria-label', 'Show guide');
    await expect(page.locator('#btnGuideShow')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#btnGuideToggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#btnGuideToggle')).toContainText('Show guide');
  });

  test('the rail has an icon for every tab, each named for what it opens and its count', async ({ page }) => {
    await session(page, EXPLORE);
    await page.locator('#btnGuideHide').click();
    expect(await railIds(page)).toEqual(['brief', 'questions', 'hints']);
    const names = await page.locator('#railTabs button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(names).toEqual(['Brief', 'Questions, 0 of 3 answered', 'Hints, 1 of 3 shown']);
    // Every one is a real button of a touch-friendly size.
    for (const box of await page.locator('#railTabs button, #btnGuideShow').all()) {
      const r = (await box.boundingBox())!;
      expect(r.width).toBeGreaterThanOrEqual(44);
      expect(r.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('a rail icon reopens the guide on that tab, with the keyboard on the tab', async ({ page }) => {
    await session(page, EXPLORE);
    await page.locator('#btnGuideHide').click();
    await page.getByRole('button', { name: /^Questions, / }).click();

    await expect(guide(page)).toBeVisible();
    await expect(rail(page)).toBeHidden();
    await expect(activeTab(page)).toHaveAttribute('data-guide-tab', 'questions');
    await expect(page.locator('#viewQuestions')).toBeVisible();
    await expect(page.locator('#tabQuestions')).toBeFocused();
    await expect(page.locator('#btnGuideToggle')).toHaveAttribute('aria-expanded', 'true');
  });

  test('Show on the rail reopens the guide on the tab it was on', async ({ page }) => {
    await session(page, BUILD);
    await page.getByRole('tab', { name: /Hints/ }).click();
    await page.locator('#btnGuideHide').click();
    await page.locator('#btnGuideShow').click();
    await expect(guide(page)).toBeVisible();
    await expect(activeTab(page)).toHaveAttribute('data-guide-tab', 'hints');
    await expect(page.locator('#tabHints')).toBeFocused();
  });

  test('the header button hides and shows the guide too, and keeps the keyboard', async ({ page }) => {
    await session(page, BUILD);
    const toggle = page.locator('#btnGuideToggle');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(guide(page)).toBeHidden();
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(guide(page)).toBeVisible();
    await expect(toggle).toBeFocused();
  });

  test('the terminal refits when the guide is hidden: it fills the room it was given', async ({ page }) => {
    await session(page, BUILD);
    await page.getByRole('tab', { name: 'Terminal' }).click();
    const screen = page.locator('.xterm-screen');
    await expect(screen).toBeVisible();
    const narrow = await widthOf(screen);
    await page.locator('#btnGuideHide').click();
    await expect.poll(async () => widthOf(screen)).toBeGreaterThan(narrow + 200);
  });
});

// =========================================================================
// the guide's state is for this lab only
// =========================================================================

test.describe('the guide per lab', () => {
  test('starting another lab opens the guide again, on its first tab: nothing is remembered', async ({ page }) => {
    await session(page, EXPLORE);
    await page.getByRole('tab', { name: 'Questions' }).click();
    await page.locator('#btnGuideHide').click();
    await expect(guide(page)).toBeHidden();

    // End this lab (through the dialog, as a learner does) and start a build lab.
    await page.locator('#btnEnd').click();
    await page.locator('#endDialog').getByRole('button', { name: 'Discard' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await startLab(page, BUILD);

    await expect(guide(page)).toBeVisible();
    await expect(rail(page)).toBeHidden();
    await expect(activeTab(page)).toHaveAttribute('data-guide-tab', 'brief');
    await expect(page.locator('#btnGuideToggle')).toHaveAttribute('aria-expanded', 'true');
    // And nothing was written for it: the state is not in the browser's storage.
    const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => /guide/i.test(k)));
    expect(stored).toEqual([]);
  });

  test('the same lab started again also opens with its guide open', async ({ page }) => {
    await session(page, BUILD);
    await page.locator('#btnGuideHide').click();
    await page.locator('#btnEnd').click();
    await page.locator('#endDialog').getByRole('button', { name: 'Discard' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await startLab(page, BUILD);
    await expect(guide(page)).toBeVisible();
  });

  test('a reload of a running lab is a new start for the guide: open again, on the tab the address names', async ({ page }) => {
    await session(page, EXPLORE);
    await page.getByRole('tab', { name: 'Questions' }).click();
    await page.locator('#btnGuideHide').click();
    // The tab is in the address (in place), the guide being hidden is not.
    await expect(page).toHaveURL(/\/labs\/[a-z0-9-]+\/session\/questions$/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
    await expect(guide(page)).toBeVisible();
    await expect(activeTab(page)).toHaveAttribute('data-guide-tab', 'questions');
  });

  test('a reload at the session address itself opens the first tab', async ({ page }) => {
    await session(page, EXPLORE);
    await page.getByRole('tab', { name: 'Questions' }).click();
    await page.goto(new URL(page.url()).pathname.replace(/\/questions$/, ''), { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
    await expect(activeTab(page)).toHaveAttribute('data-guide-tab', 'brief');
  });
});

test.describe('the guide on a narrower window', () => {
  for (const width of [1179, 1100, 1000]) {
    test(`starts collapsed to the rail at ${width}px, and opens on demand`, async ({ page }) => {
      await session(page, BUILD, { width, height: 800 });
      await expect(rail(page)).toBeVisible();
      await expect(guide(page)).toBeHidden();
      await expect(page.locator('#btnGuideToggle')).toHaveAttribute('aria-expanded', 'false');
      await noHorizontalScroll(page);

      await page.getByRole('button', { name: /^Brief/ }).click();
      await expect(guide(page)).toBeVisible();
      await expect(activeTab(page)).toHaveAttribute('data-guide-tab', 'brief');
      // Open, the two columns still fit.
      await noHorizontalScroll(page);
      const g = (await guide(page).boundingBox())!;
      const w = (await page.locator('#window').boundingBox())!;
      expect(g.x + g.width).toBeLessThanOrEqual(w.x);
      expect(w.width).toBeGreaterThan(400);
    });
  }

  test('starts open at exactly 1180px', async ({ page }) => {
    await session(page, BUILD, { width: 1180, height: 800 });
    await expect(guide(page)).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('widening the window after the start does not move the guide the learner chose', async ({ page }) => {
    await session(page, BUILD, { width: 1000, height: 800 });
    await expect(rail(page)).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(rail(page)).toBeVisible();
    await expect(guide(page)).toBeHidden();
  });
});

// =========================================================================
// the dock, the header tags and the tab badges follow the checks
// =========================================================================

test.describe('running the checks', () => {
  test('takes the learner to the results and updates the tab badge, the header tag and the dock', async ({ page }) => {
    const s = await session(page, BUILD);
    // Before any run: the plan, open dots, and a primary button that says what it does.
    await expect(page.locator('#dockProgress')).toHaveText('2 checks to pass');
    await expect(page.locator('#dockDots i')).toHaveCount(2);
    await expect(page.locator('#dockDots i.o')).toHaveCount(2);
    await expect(page.locator('#btnDockAction')).toHaveText('Run checks');
    await expect(page.locator('#statChecks')).toHaveText('—');

    await page.locator('#btnChecks').click();
    await expect(activeTab(page)).toHaveAttribute('data-guide-tab', 'checks');
    await expect(page.locator('#viewChecks')).toBeVisible();
    await expect(page.locator('#checksPanel .check')).toHaveCount(2);
    await expect(page.locator('#checksSummary')).toHaveText('1/3 pts · 1/2 checks');
    // The failing check says why; weights and the marks are words, not colour alone.
    await expect(page.locator('#checksPanel .check-fail .check-mark')).toHaveText('✗');
    await expect(page.locator('#checksPanel .check-fail .check-detail')).toHaveText('expected 11');
    await expect(page.locator('#checksPanel .check[data-weight="2"] .chip-weight')).toHaveText('×2');
    await expect(page.locator('#checksPanel .check-pass .check-mark')).toHaveText('✓');

    // The dock, the header tag and the tab badge all say one of two.
    await expect(page.locator('#dockProgress')).toHaveText('1 of 2 checks passing');
    await expect(page.locator('#dockDots i')).toHaveCount(2);
    await expect(page.locator('#dockDots i.f')).toHaveCount(1);
    await expect(page.locator('#statChecks')).toHaveText('1/2');
    await expect(page.locator('#tabChecks')).toHaveAttribute('aria-label', 'Checks, 1 of 2 passing');
    await expect(page.locator('#tabChecks .gtab-badge')).toHaveText('1/2');
    await expect(page.locator('#sessionLive')).toHaveText(/Checks: 1\/3 pts · 1\/2 checks/);
    expect(s.checkRuns).toBe(1);
    // The button is back to its label, not stuck on Running.
    await expect(page.locator('#btnChecks')).toHaveText('Run checks');
    await expect(page.locator('#btnDockAction')).toHaveText('Run checks');
  });

  test('the dock button and the Checks tab button run the same checks', async ({ page }) => {
    const s = await session(page, BUILD);
    await page.locator('#btnDockAction').click();
    await expect(page.locator('#checksPanel .check')).toHaveCount(2);
    await page.locator('#btnChecksInline').click();
    await expect.poll(() => s.checkRuns).toBe(2);
    await expect(page.locator('#checksPanel .check')).toHaveCount(2);
  });

  test('shows the result card in the guide once every check passes, and says so', async ({ page }) => {
    const s = await session(page, BUILD);
    s.pass.value = true;
    await page.locator('#btnChecks').click();
    await expect(page.locator('#resultCard')).toBeVisible();
    await expect(page.locator('#resultCard')).toHaveAttribute('role', 'status');
    await expect(page.locator('#resultChecks')).toContainText('2/2 checks');
    await expect(page.locator('#dockProgress')).toHaveText('2 of 2 checks passing');
    await expect(page.locator('#dockDots i.f')).toHaveCount(0);
    await expect(page.locator('#sessionLive')).toHaveText(/Lab complete|Checks:/);
  });

  test('with the guide hidden, the run is still seen in the dock, and a finished lab is announced', async ({ page }) => {
    const s = await session(page, BUILD);
    await page.locator('#btnGuideHide').click();
    s.pass.value = true;
    await page.locator('#btnDockAction').click();
    await expect(page.locator('#dockProgress')).toHaveText('2 of 2 checks passing');
    // The rail's Checks icon carries the count.
    await expect(page.getByRole('button', { name: 'Checks, 2 of 2 passing' })).toBeVisible();
    await expect(page.locator('#toast')).toContainText('Lab complete');
    // The guide stayed as the learner left it.
    await expect(guide(page)).toBeHidden();
  });
});

// =========================================================================
// an explore lab: answers
// =========================================================================

test.describe('an explore lab', () => {
  test('counts answers in the dock, the header and the tab, and its button goes from "Answer questions" to "Check my answers"', async ({ page }) => {
    const s = await session(page, EXPLORE);
    await expect(page.locator('#answersTag')).toBeVisible();
    await expect(page.locator('#checksTag')).toBeHidden();
    await expect(page.locator('#dockProgress')).toHaveText('0 of 3 answered');
    await expect(page.locator('#btnDockAction')).toHaveText('Answer questions');
    await expect(page.locator('#btnChecks')).toContainText('Check answers');

    // "Answer questions" takes the learner to the questions, at the first unanswered.
    await page.locator('#btnDockAction').click();
    await expect(activeTab(page)).toHaveAttribute('data-guide-tab', 'questions');
    await expect(page.locator('#viewQuestions')).toBeVisible();
    await expect(page.locator('.qfield[data-key="support_deployment"] input[value="a"]')).toBeFocused();

    const card = (key: string) => page.locator(`.qfield[data-key="${key}"]`);
    await expect(card('support_deployment').locator('.qfield-status')).toHaveText('Not answered');
    await card('support_deployment').locator('input[value="a"]').check();
    await expect(card('support_deployment').locator('.qfield-status')).toHaveText('Answered');
    await expect(page.locator('#dockProgress')).toHaveText('1 of 3 answered');
    await expect(page.locator('#tabQuestions')).toHaveAttribute('aria-label', 'Questions, 1 of 3 answered');
    await expect(page.locator('#statAnswers')).toHaveText('1/3');
    await expect(page.locator('.qform-status')).toHaveText('Saved', { timeout: 5000 });
    await expect(card('support_deployment').locator('.qfield-status')).toHaveText('Saved');

    await card('support_tokens_hello').locator('input').fill('11');
    await card('unknown_alias_status').locator('input').fill('400');
    await expect(page.locator('#dockProgress')).toHaveText('3 of 3 answered');
    await expect(page.locator('#dockDots i.o')).toHaveCount(0);
    await expect(page.locator('#btnDockAction')).toHaveText('Check my answers');
    await expect(page.locator('#btnRunChecksForm')).toHaveText('Check my answers');

    // The dock's button now runs the checks, and the results are read under the form.
    await expect(page.locator('.qform-status')).toHaveText('Saved', { timeout: 5000 });
    await page.locator('#btnDockAction').click();
    await expect.poll(() => s.checkRuns).toBe(1);
    await expect(page.locator('#viewQuestions #checksPanel .check')).toHaveCount(2);
    await expect(page.locator('#viewQuestions #checksPanel .check-fail')).toContainText('token count matches');
    expect(s.errors).toEqual([]);
  });

  test('its guide badges: questions answered, hints shown', async ({ page }) => {
    await session(page, EXPLORE);
    // Hints say their count to a screen reader; the tab itself stays plain.
    await expect(page.locator('#tabHints')).toHaveAttribute('aria-label', 'Hints, 1 of 3 shown');
    await expect(page.locator('#tabHints .gtab-badge')).toBeHidden();
    await expect(page.locator('#tabQuestions .gtab-badge')).toHaveText('0/3');
  });

  test('opens on the service it is about: the first tab of the window', async ({ page }) => {
    await session(page, EXPLORE);
    await expect(page.locator('#tabEcho, #serviceTabs .tab').first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#viewService')).toBeVisible();
    await expect(page.locator('#windowTitle')).toHaveText('echo');
  });
});

// =========================================================================
// the workspace window
// =========================================================================

test.describe('the workspace window', () => {
  test('has a bar with the title and the RUNNING pill, and tabs for the terminal, the editor and each service', async ({ page }) => {
    await session(page, BUILD);
    await expect(page.locator('#window .window-bar')).toBeVisible();
    await expect(page.locator('#statePill')).toHaveText('running');
    await expect(page.locator('#statePill')).toHaveCSS('text-transform', 'uppercase');
    await expect(page.locator('#windowTitle')).toHaveText('Editor');
    const names = await page.locator('#workspaceTabs [role="tab"]').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
    expect(names).toEqual(['Terminal', 'Editor', 'echo']);
    await expect(page.locator('#workspaceTabs [role="tab"][aria-selected="true"]')).toHaveText('Editor');
    // The files are in the editor, as a tree on its left.
    await expect(page.locator('#viewEditor #fileList li:has(.name)').first()).toBeVisible();
    const tree = (await page.locator('#viewEditor .files-pane').boundingBox())!;
    const pane = (await page.locator('#viewEditor .editor-pane').boundingBox())!;
    expect(tree.x + tree.width).toBeLessThanOrEqual(pane.x + 1);
  });

  test('the service tab loads the service through the proxy, with its health dot', async ({ page }) => {
    const s = await session(page, BUILD);
    const tab = page.locator('#serviceTabs .tab[data-service="echo"]');
    await expect(tab.locator('.svc-dot')).toHaveAttribute('data-health', 'healthy');
    const asked = page.waitForRequest((r) => r.url().includes('/services/echo/session') && r.method() === 'POST');
    await tab.click();
    await asked;
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#viewService')).toBeVisible();
    await expect(page.locator('#windowTitle')).toHaveText('echo');
    await expect(page.locator('#serviceFrame')).toHaveAttribute('src', new RegExp(`^${API}/sessions/${SESSION_ID}/services/echo/`));
    await expect(page.frameLocator('#serviceFrame').getByRole('heading', { name: 'Echo service' })).toBeVisible();
    await expect(page.locator('#serviceDown')).toBeHidden();
    await expect(page.locator('#serviceOpen')).toHaveAttribute('href', new RegExp(`^${API}/sessions/`));
    expect(await page.locator('#serviceOpen').getAttribute('href')).not.toContain('token=');
    // Restart, from the service's own toolbar.
    await page.locator('#btnServiceRestart').click();
    await expect.poll(() => s.restarts.length).toBe(1);
    await expect(page.locator('#btnServiceRestart')).toHaveText('Restart');
  });

  test('a service that is not answering shows its card with Restart and Retry', async ({ page }) => {
    await session(page, BUILD);
    await page.route(/\/services\/echo\/(\?.*)?$/, (route) => json(route, { error: { code: 'service_down', message: 'down' } }, 502));
    await page.locator('#serviceTabs .tab[data-service="echo"]').click();
    const down = page.locator('#serviceDown');
    await expect(down).toBeVisible();
    await expect(down).toContainText('echo is not answering');
    await expect(down.getByRole('button', { name: 'Restart' })).toBeEnabled();
    await expect(down.getByRole('button', { name: 'Retry' })).toBeEnabled();
    await expect(page.locator('#serviceFrame')).toBeHidden();
  });

  test('the Services popover lists every service with its health and a Restart, and closes with Escape', async ({ page }) => {
    const s = await session(page, BUILD);
    const button = page.locator('#btnServices');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#servicesPop')).toBeHidden();
    await expect(page.locator('#servicesCount')).toHaveText('1/1');
    await expect(page.locator('#servicesDot')).toHaveAttribute('data-health', 'healthy');

    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const row = page.locator('#serviceList li[data-service="echo"]');
    await expect(row).toBeVisible();
    await expect(row.locator('.svc-health')).toHaveText('healthy');
    await row.getByRole('button', { name: 'Restart' }).click();
    await expect.poll(() => s.restarts.length).toBe(1);
    await expect(row.getByRole('button')).toHaveText('Restart');

    await page.keyboard.press('Escape');
    await expect(page.locator('#servicesPop')).toBeHidden();
    await expect(button).toBeFocused();
    // A click elsewhere closes it too.
    await button.click();
    await expect(page.locator('#servicesPop')).toBeVisible();
    await page.locator('#windowTitle').click();
    await expect(page.locator('#servicesPop')).toBeHidden();
  });

  test('the editor opens a file from the tree, marks it dirty, and saves it', async ({ page }) => {
    const s = await session(page, BUILD);
    await page.locator('#fileList li', { hasText: 'gateway.yaml' }).click();
    await expect(page.locator('#editorPath')).toHaveText('gateway.yaml');
    await expect(page.locator('#windowTitle')).toHaveText('gateway.yaml');
    await expect(page.locator('.cm-content')).toContainText('model_list');
    await page.locator('.cm-content').fill('changed: true');
    await expect(page.locator('#editorPath')).toHaveAttribute('data-dirty', '1');
    await page.locator('#btnSaveFile').click();
    await expect(page.locator('#editorStatus')).toHaveText('saved');
    expect(s.puts).toContain('gateway.yaml');
    // A new file, from the tree's own button.
    page.once('dialog', (d) => d.accept('notes.txt'));
    await page.locator('#btnNewFile').click();
    await expect(page.locator('#editorPath')).toHaveText('notes.txt');
    await page.locator('#btnRefreshFiles').click();
    await expect(page.locator('#fileList li', { hasText: 'notes.txt' })).toBeVisible();
  });

  test('the editor is painted in the window’s navy, not a grey of its own', async ({ page }) => {
    await session(page, BUILD);
    await page.locator('#fileList li', { hasText: 'gateway.yaml' }).click();
    await expect(page.locator('.cm-content')).toContainText('model_list');
    const colours = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return {
        window: css.getPropertyValue('--navy-deep').trim(),
        editor: getComputedStyle(document.querySelector('.cm-editor')!).backgroundColor,
        gutters: getComputedStyle(document.querySelector('.cm-gutters')!).backgroundColor,
      };
    });
    const rgb = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    expect(colours.editor).toBe(rgb(colours.window));
    expect(colours.gutters).toBe(rgb(colours.window));
  });

  test('the terminal is painted in the window’s terminal navy', async ({ page }) => {
    await session(page, BUILD);
    await page.getByRole('tab', { name: 'Terminal' }).click();
    await expect(page.locator('.xterm-screen')).toBeVisible();
    const colours = await page.evaluate(() => ({
      token: getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim(),
      well: getComputedStyle(document.querySelector('#term')!).backgroundColor,
      viewport: getComputedStyle(document.querySelector('.xterm-viewport')!).backgroundColor,
    }));
    const n = parseInt(colours.token.slice(1), 16);
    const rgb = `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    expect(colours.well).toBe(rgb);
    expect(colours.viewport).toBe(rgb);
  });

  test('the idle banner, the expiry banner and the ended banner keep their buttons', async ({ page }) => {
    await session(page, BUILD);
    await expect(page.locator('#idleBanner')).toBeHidden();
    await expect(page.locator('#endedBanner')).toBeHidden();
    await expect(page.locator('#btnImHere')).toBeAttached();
    await expect(page.locator('#idleBanner')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#expiryBanner')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#activityPane')).toBeVisible();
    await expect(page.locator('#noticeList')).toHaveAttribute('role', 'log');
    await expect(page.locator('#activityPane h2')).toHaveText('Lab activity');
  });
});

// =========================================================================
// the header
// =========================================================================

test.describe('the header', () => {
  test('says where the lab sits, its title, the time left, the checks, the cost and the three actions', async ({ page }) => {
    await session(page, BUILD);
    await expect(page.locator('#sessionTitle')).toHaveText('Keep EU data on EU routes');
    await expect(page.locator('#sessionLab')).toHaveText(BUILD);
    await expect(page.locator('#sessionWhere')).toHaveText(/ · lab \d+ of \d+ · $/);
    await expect(page.locator('#expiryTimer')).toHaveText(/^\d+:\d{2} left$/);
    await expect(page.locator('#statCost')).toHaveText('≈ $0.03');
    await expect(page.locator('#dockCostValue')).toHaveText('≈ $0.03');
    for (const id of ['#btnChecks', '#btnSnapshot', '#btnEnd']) await expect(page.locator(id)).toBeEnabled();
    await expect(page.locator('#btnEnd')).toHaveText('End lab');
    // The links, the help and the account belong to the launcher; the theme stays.
    await expect(page.locator('#navLinks')).toBeHidden();
    await expect(page.locator('#btnTheme')).toBeVisible();
  });

  test('ends the lab through the end dialog, from the header button', async ({ page }) => {
    const s = await session(page, BUILD);
    await page.locator('#btnEnd').click();
    const dialog = page.locator('#endDialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'End and keep my work' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    expect(s.ends).toHaveLength(1);
    expect(s.ends[0]).toContain('snapshot=1');
  });
});

// =========================================================================
// what a learner is told while the lab runs: banners and the activity strip
// =========================================================================

test.describe('banners and the activity strip', () => {
  test('warns above the window when under five minutes remain, and End becomes End & snapshot', async ({ page }) => {
    const s = await stub(page);
    s.status.expiresInMs = 4 * 60_000;
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await startLab(page, BUILD);
    const banner = page.locator('#expiryBanner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('role', 'alert');
    await expect(banner).toContainText(/Ends in \d+:\d{2}/);
    await expect(page.locator('#btnEnd')).toHaveText('End & snapshot');
    await expect(page.locator('#expiryTimer')).toHaveAttribute('data-urgent', '1');
    // It is over the window, in the stage column, where it cannot be scrolled past.
    const b = (await banner.boundingBox())!;
    const w = (await page.locator('#window').boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(w.y + 1);
    // The window gave up height for it rather than being pushed off screen.
    expect(w.y + w.height).toBeLessThanOrEqual(900);
  });

  test('asks "still there?" on an idle warning, with a countdown in the banner and the window bar, and clears on "I\'m here"', async ({ page }) => {
    const s = await stub(page);
    s.events = [{ id: 1, event: 'session.idle_warning', data: {} }];
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await startLab(page, BUILD);
    const banner = page.locator('#idleBanner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('role', 'alert');
    await expect(banner).toContainText(/1:5\d/);
    await expect(page.locator('#idleClock')).toHaveText(/^idle 1:5\d$/);
    // It is in the activity strip too, as prose.
    await expect(page.locator('#noticeList li', { hasText: 'Still there?' }).first()).toBeVisible();
    await banner.getByRole('button', { name: "I'm here" }).click();
    await expect.poll(() => s.touches).toBe(1);
    await expect(banner).toBeHidden();
    await expect(page.locator('#idleClock')).toBeHidden();
  });

  test('an ended session says why, above the window, and offers Resume, Restart and Back to labs', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await startLab(page, BUILD);
    // The lab ends on its own: the API says so, and the status agrees.
    s.status.state = 'ended';
    s.status.endReason = 'idle';
    s.emit({ id: 50, event: 'session.state', data: { state: 'ended', reason: 'idle' } });
    const banner = page.locator('#endedBanner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('nothing happened in it');
    await expect(page.locator('#statePill')).toHaveText('ended');
    await expect(banner.getByRole('button', { name: 'Resume from snapshot' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Restart lab' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Back to labs' })).toBeVisible();
    // Nothing can be run in a dead lab.
    for (const id of ['#btnChecks', '#btnSnapshot', '#btnEnd', '#btnDockAction']) await expect(page.locator(id)).toBeDisabled();
    await expect(page.locator('#termStatus')).toBeHidden();

    // Resume boots it again, and the buttons come back with it.
    await banner.getByRole('button', { name: 'Resume from snapshot' }).click();
    await expect(banner).toBeHidden();
    await expect(page.locator('#statePill')).toHaveText('running');
    expect(s.resumes).toBe(1);
    for (const id of ['#btnChecks', '#btnSnapshot', '#btnEnd', '#btnDockAction']) await expect(page.locator(id)).toBeEnabled();
  });

  test('an ended lab with an error has only the way back', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await startLab(page, BUILD);
    s.status.state = 'ended';
    s.status.endReason = 'error';
    s.emit({ id: 51, event: 'session.state', data: { state: 'ended', reason: 'error' } });
    const banner = page.locator('#endedBanner');
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Resume from snapshot' })).toBeHidden();
    await expect(banner.getByRole('button', { name: 'Restart lab' })).toBeHidden();
    await banner.getByRole('button', { name: 'Back to labs' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
  });

  test('a pressure event opens the strip so it is not missed, and the strip can be folded again', async ({ page }) => {
    const s = await stub(page);
    s.events = [
      { id: 1, event: 'session.state', data: { state: 'running' } },
      { id: 2, event: 'service.health', data: { service: 'echo', health: 'healthy' } },
      { id: 3, event: 'pressure', data: { event_id: 'p1', title: 'A second wave', message: 'Traffic doubles at minute 10.' } },
    ];
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await startLab(page, BUILD);
    const strip = page.locator('#activityPane');
    await expect(page.locator('#noticeList li', { hasText: 'A second wave' })).toBeVisible();
    await expect(strip).toHaveAttribute('data-open', 'true');
    await expect(page.locator('#noticeCount')).toHaveText('2 notices');
    const toggle = page.locator('#btnActivityToggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveText('Show less');
    await expect(page.locator('#noticeList li')).toHaveCount(2);
    await expect(page.locator('#noticeList li').nth(1)).toBeVisible();
    await toggle.click();
    await expect(strip).toHaveAttribute('data-open', 'false');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Folded, the newest is still the one in view.
    await expect(page.locator('#noticeList li').first()).toContainText('A second wave');
    await expect(page.locator('#noticeList li').first()).toBeVisible();
    await expect(page.locator('#noticeList li').nth(1)).not.toBeInViewport();
  });

  test('a dropped stream shows the reconnecting pill in the window bar', async ({ page }) => {
    const s = await stub(page);
    s.events = [{ id: 1, event: 'service.health', data: { service: 'echo', health: 'healthy' } }];
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await startLab(page, BUILD);
    // The stub's stream ends after its events, as a dropped one does: the pill says the page is not live.
    await expect(page.locator('#streamPill')).toBeVisible();
    await expect(page.locator('#streamPill')).toContainText('reconnecting');
    const pill = (await page.locator('#streamPill').boundingBox())!;
    const bar = (await page.locator('#window .window-bar').boundingBox())!;
    expect(pill.y).toBeGreaterThanOrEqual(bar.y);
    expect(pill.y + pill.height).toBeLessThanOrEqual(bar.y + bar.height);
  });
});

// =========================================================================
// the keyboard and assistive technology
// =========================================================================

test.describe('code blocks', () => {
  test('a code block in the brief has a Copy button that puts exactly the code on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await session(page, BUILD);
    const block = page.locator('#briefBody pre').first();
    await expect(block).toBeVisible();
    await block.hover();
    const copy = block.getByRole('button', { name: 'Copy this code' });
    await expect(copy).toBeVisible();
    await copy.click();
    await expect(block.getByRole('button', { name: 'Code copied' })).toBeVisible();
    await expect(block.locator('.code-copy-label')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'python3 -B send_calls.py support "hello gateway"\npython3 -B send_calls.py fast "hello gateway"'
    );
    // The label returns, and the button is never part of what a learner selects as code.
    await expect(block.locator('.code-copy-label')).toHaveText('Copy', { timeout: 5_000 });
  });

  test('the button can be reached and used from the keyboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await session(page, BUILD);
    const copy = page.locator('#briefBody pre').first().getByRole('button', { name: 'Copy this code' });
    await copy.focus();
    await expect(copy).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('#briefBody pre .code-copy-label').first()).toHaveText('Copied');
  });
});

test.describe('keyboard and accessibility', () => {
  test('the guide is a tablist with arrow-key roving, Home and End, and one tab stop', async ({ page }) => {
    await session(page, EXPLORE);
    const list = page.locator('#guideTabs');
    await expect(list).toHaveAttribute('role', 'tablist');
    await expect(list).toHaveAttribute('aria-label', 'Guide sections');
    // Exactly one tab is in the tab order: the selected one.
    const stops = await guideTabs(page).evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).map((e) => (e as HTMLElement).dataset.guideTab));
    expect(stops).toEqual(['brief']);
    // Every tab controls a panel that is labelled by it.
    for (const id of await tabIds(page)) {
      const tab = page.locator(`#guideTabs [data-guide-tab="${id}"]`);
      const panel = await tab.getAttribute('aria-controls');
      await expect(page.locator(`#${panel}`)).toHaveAttribute('role', 'tabpanel');
      await expect(page.locator(`#${panel}`)).toHaveAttribute('aria-labelledby', (await tab.getAttribute('id'))!);
    }

    await page.locator('#tabBrief').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#tabQuestions')).toBeFocused();
    await expect(page.locator('#tabQuestions')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#viewQuestions')).toBeVisible();
    await expect(page.locator('#viewBrief')).toBeHidden();
    await page.keyboard.press('End');
    await expect(page.locator('#tabHints')).toBeFocused();
    await expect(page.locator('#viewHints')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#tabBrief')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#tabHints')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.locator('#tabBrief')).toBeFocused();
    await expect(page.locator('#tabBrief')).toHaveAttribute('aria-selected', 'true');
    // Only the active tab is tabbable, still.
    const after = await guideTabs(page).evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).map((e) => (e as HTMLElement).dataset.guideTab));
    expect(after).toEqual(['brief']);
  });

  test('the workspace tabs rove with the arrow keys too, and the keyboard stays on them', async ({ page }) => {
    await session(page, BUILD);
    await expect(page.locator('#workspaceTabs')).toHaveAttribute('role', 'tablist');
    await page.locator('#tabEditor').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#tabTerminal')).toBeFocused();
    await expect(page.locator('#tabTerminal')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#viewTerminal')).toBeVisible();
    // The terminal did not take the keyboard from the tab.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#tabEditor')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.locator('#serviceTabs .tab')).toBeFocused();
    await expect(page.locator('#viewService')).toBeVisible();
    await page.keyboard.press('Home');
    await expect(page.locator('#tabTerminal')).toBeFocused();
  });

  test('the whole guide can be driven from the keyboard: hide, rail, reopen, tab', async ({ page }) => {
    await session(page, EXPLORE);
    await page.locator('#btnGuideHide').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#btnGuideShow')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Brief' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(guide(page)).toBeVisible();
    await expect(page.locator('#tabBrief')).toBeFocused();
    await expect(activeTab(page)).toHaveAttribute('data-guide-tab', 'brief');
  });

  test('the live regions are there: the checks, the result, the activity log and the solution', async ({ page }) => {
    await session(page, BUILD);
    await expect(page.locator('#sessionLive')).toHaveAttribute('role', 'status');
    await expect(page.locator('#checksPanel')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#checksSummary')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#hintsPanel')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#resultCard')).toHaveAttribute('role', 'status');
    await expect(page.locator('#noticeList')).toHaveAttribute('role', 'log');
  });

  test('the hide, show and rail buttons are named, the dock is a labelled region, nothing is named by colour alone', async ({ page }) => {
    await session(page, BUILD);
    await expect(page.getByRole('button', { name: 'Hide guide', exact: true })).toHaveCount(2); // the one in the guide and the header's
    await expect(page.getByRole('region', { name: 'Progress' })).toBeVisible();
    await expect(page.locator('#dockDots')).toHaveAttribute('role', 'img');
    expect(await page.locator('#dockDots').getAttribute('aria-label')).toMatch(/checks/);
    await expect(page.getByRole('region', { name: 'Guide', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Workspace', exact: true })).toBeVisible();
  });

  test('the motion is off when the learner asks for less of it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await session(page, BUILD);
    const animated = await page.evaluate(() => [...document.querySelectorAll('#workspace *')].filter((el) => getComputedStyle(el).animationName !== 'none').length);
    expect(animated).toBe(0);
  });
});

// =========================================================================
// nothing sticks out
// =========================================================================

test.describe('no horizontal scroll', () => {
  for (const width of [1000, 1280, 1440]) {
    for (const slug of [BUILD, EXPLORE]) {
      test(`${slug === EXPLORE ? 'explore' : 'build'} lab at ${width}px, guide open and hidden`, async ({ page }) => {
        await session(page, slug, { width, height: 820 });
        // Open it (it starts collapsed below 1180) and look at every tab.
        if (await rail(page).isVisible()) await page.locator('#btnGuideShow').click();
        for (const id of await tabIds(page)) {
          await page.locator(`#guideTabs [data-guide-tab="${id}"]`).click();
          await noHorizontalScroll(page);
        }
        for (const view of ['terminal', 'editor', 'service']) {
          await page.locator(view === 'service' ? '#serviceTabs .tab' : `#workspaceTabs .tab[data-view="${view}"]`).click();
          await noHorizontalScroll(page);
        }
        await page.locator('#btnGuideHide').click();
        await noHorizontalScroll(page);
        // The page itself does not scroll: the guide and the window do, inside themselves.
        const scrolls = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
        expect(scrolls).toBeLessThanOrEqual(0);
      });
    }
  }

  for (const width of [1920, 2560]) {
    test(`on a ${width}px screen the two columns fill the window: no empty margins either side`, async ({ page }) => {
      await session(page, EXPLORE, { width, height: 1100 });
      const ws = (await page.locator('.workspace').boundingBox())!;
      const guide = (await page.locator('.guide').boundingBox())!;
      const win = (await page.locator('#window').first().boundingBox())!;
      // The workspace spans the window (a little padding is fine) ...
      expect(ws.x).toBeLessThanOrEqual(1);
      expect(ws.width).toBeGreaterThanOrEqual(width - 2);
      // ... and the guide hugs the left padding while the navy window reaches the right one.
      expect(guide.x).toBeLessThanOrEqual(32);
      expect(width - (win.x + win.width)).toBeLessThanOrEqual(32);
      await noHorizontalScroll(page);
    });
  }

  test('a window narrowed to a phone’s width after the start still holds together', async ({ page }) => {
    await session(page, EXPLORE);
    await page.setViewportSize({ width: 390, height: 844 });
    await noHorizontalScroll(page);
    await page.getByRole('tab', { name: 'Questions' }).click();
    await noHorizontalScroll(page);
    await page.locator('#btnGuideHide').click();
    await noHorizontalScroll(page);
  });
});

// =========================================================================
// screenshots
// =========================================================================

const VARIANTS = [
  { name: 'light-1440', theme: 'light' as const, width: 1440, height: 900 },
  { name: 'dark-1440', theme: 'dark' as const, width: 1440, height: 900 },
  { name: 'light-1000', theme: 'light' as const, width: 1000, height: 800 },
  { name: 'dark-1000', theme: 'dark' as const, width: 1000, height: 800 },
];

test.describe('screenshots', () => {
  test.skip(process.env.SESSION_SHOTS === '0', 'SESSION_SHOTS=0');

  for (const v of VARIANTS) {
    test(`the session screen, ${v.name}`, async ({ page }) => {
      mkdirSync(SHOTS, { recursive: true });
      await page.emulateMedia({ colorScheme: v.theme, reducedMotion: 'reduce' });
      const s = await session(page, BUILD, { width: v.width, height: v.height }, { theme: v.theme });
      const shot = async (name: string) => {
        await noHorizontalScroll(page);
        await page.screenshot({ path: join(SHOTS, `${name}-${v.name}.png`) });
      };
      const openGuide = async () => {
        if (await rail(page).isVisible()) await page.locator('#btnGuideShow').click();
      };

      // A build lab: the brief (open), after a failing run (checks), the hidden guide with its rail.
      await openGuide();
      await page.locator('#fileList li', { hasText: 'gateway.yaml' }).click();
      await expect(page.locator('.cm-content')).toContainText('model_list');
      await shot('build-brief-open');
      await page.getByRole('tab', { name: /Hints/ }).click();
      await shot('build-hints');
      await page.locator('#btnChecks').click();
      await expect(page.locator('#checksPanel .check')).toHaveCount(2);
      await shot('build-checks');
      s.pass.value = true;
      await page.locator('#btnChecks').click();
      await expect(page.locator('#resultCard')).toBeVisible();
      await shot('build-complete');
      await page.getByRole('tab', { name: 'Terminal' }).click();
      await expect(page.locator('.xterm-screen')).toBeVisible();
      await page.getByRole('tab', { name: 'Brief' }).click();
      await shot('build-terminal');
      await page.locator('#btnServices').click();
      await shot('build-services');
      await page.keyboard.press('Escape');
      await page.locator('#btnGuideHide').click();
      await shot('build-hidden');

      // An explore lab: the brief, the questions, hidden.
      await page.locator('#btnEnd').click();
      await page.locator('#endDialog').getByRole('button', { name: 'Discard' }).click();
      await expect(page.locator('#launcher')).toBeVisible();
      await startLab(page, EXPLORE);
      await openGuide();
      await expect(page.locator('#viewService')).toBeVisible();
      await expect(page.frameLocator('#serviceFrame').getByRole('heading', { name: 'Echo service' })).toBeVisible();
      await shot('explore-brief');
      await page.getByRole('tab', { name: 'Questions' }).click();
      await page.locator('.qfield[data-key="support_deployment"] input[value="a"]').check();
      await page.locator('.qfield[data-key="support_tokens_hello"] input').fill('11');
      await expect(page.locator('.qform-status')).toHaveText('Saved', { timeout: 5000 });
      await shot('explore-questions');
      await page.locator('#btnGuideHide').click();
      await shot('explore-hidden');

      // A window narrowed to a phone's width after the start (a phone cannot start a lab): one column.
      if (v.width === 1440) {
        await page.setViewportSize({ width: 390, height: 844 });
        await shot('explore-hidden-narrowed');
        await page.locator('#btnGuideShow').click();
        await shot('explore-open-narrowed');
      }
    });
  }
});
