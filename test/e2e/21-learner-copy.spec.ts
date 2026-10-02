import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { parse as parseYaml } from 'yaml';
import { serveConsole, serveWorker } from './console-server';

/**
 * What a learner reads never describes how the platform is built.
 *
 * test/unit/learner-copy.test.ts scans the source for the forbidden words. This visits the screens
 * as a browser draws them, with the API stubbed, and reads what is on the page: the text a person can
 * see, plus the tooltips and labels a screen reader or a hover would give them. It is the check that
 * the words are not assembled at run time (an error message, a status code, a reason the API sent).
 *
 * Screens: the launcher, "How this console works", a page that is not there, the platform quiz, the
 * story before a lab, the dialog while a lab starts, a running session (guide tabs, checks, hints,
 * the activity feed after the API reports a restart, an expiry warning, an idle warning and an internal
 * alert), the terminal reconnecting, the end dialog, every way a session can end, the result card, a lab
 * that cannot start, a launcher that cannot load, the sign-in page, and the public site.
 *
 * Needs no password, no API and no container (see 17-session-layout.spec.ts for the stub). Run
 * `npm run build:dashboard` first.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC = join(ROOT, 'dashboard/public');
const API = 'https://opalix-sandbox.soubenz94.workers.dev';
const SESSION_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';

/** The platform's own vocabulary. Lab subject matter (a gateway, a model, a trace) is not in it. */
const PLATFORM_WORDS = [
  'containers?',
  'snapshots?',
  'VMs?',
  'virtual machines?',
  'sandbox(?:es|ed|ing)?',
  'workers?',
  'durable objects?',
  'cloudflare',
  'R2',
  'D1',
  'session tokens?',
  'upstream',
  'web ?sockets?',
  'API',
  'slots?',
  'service (?:key|binding)',
  'docker',
  'firecracker',
  'wrangler',
  '1006',
  'terminal_[a-z_]+',
];
const wordsRe = (words: string[]) => new RegExp(`(?<![A-Za-z0-9_])(?:${words.join('|')})(?![A-Za-z0-9_])|[45]\\d\\d(?=: )|HTTP\\s*[1-5]\\d\\d|closed \\(\\d+\\)`, 'i');
const FORBIDDEN = wordsRe(PLATFORM_WORDS);
/** The public site lists what the labs are about, and one lab is about a worker service. */
const FORBIDDEN_SITE = wordsRe(PLATFORM_WORDS.filter((w) => w !== 'workers?' && w !== 'API'));

/** Everything the page says: its visible text, and the tooltips, labels and placeholders on it. */
async function copyOn(page: Page): Promise<string> {
  return page.evaluate(() => {
    const extra: string[] = [];
    for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],[alt]')) {
      // Hidden things (a closed dialog, a hidden banner) are not on the page for anyone.
      if (!(el as HTMLElement).offsetParent && getComputedStyle(el).position !== 'fixed') continue;
      for (const a of ['title', 'aria-label', 'placeholder', 'alt']) {
        const v = el.getAttribute(a);
        if (v) extra.push(v);
      }
    }
    return `${document.title}\n${document.body.innerText}\n${extra.join('\n')}`;
  });
}

async function saysNothingOfThePlatform(page: Page, screen: string, re: RegExp = FORBIDDEN) {
  const text = await copyOn(page);
  const hit = re.exec(text);
  expect(hit, `${screen}: the page says "${hit?.[0]}" in: …${hit ? text.slice(Math.max(0, hit.index - 80), hit.index + 80).replace(/\s+/g, ' ') : ''}…`).toBeNull();
  // Something was read: an empty page would pass for the wrong reason.
  expect(text.replace(/\s/g, '').length, `${screen} is not empty`).toBeGreaterThan(40);
}

// --------------------------------------------------------------- the content

interface Bundle {
  story?: { title: string; minutes: number; body: string };
  concepts: Array<{ id: string; title: string; minutes: number; recap: string; body: string }>;
  questions: Array<Record<string, unknown>>;
  answers_file: string;
  fields: Array<Record<string, unknown>>;
}

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

const bundle = compileLearn('see-what-a-gateway-does');
const onboarding = JSON.parse(readFileSync(join(ROOT, 'packages/catalogue/onboarding.json'), 'utf8')) as Record<string, unknown>;

const EXPLORE = 'see-what-a-gateway-does';
const BUILD = 'keep-eu-data-on-eu-routes';
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
  has_learn: false,
  progress: null,
  ...o,
});
const LABS = [lab({ slug: EXPLORE, title: 'See what a gateway does', type: 'explore', order: 1, has_learn: true }), lab({ slug: BUILD, title: 'Keep EU data on EU routes', order: 2 })];

// ------------------------------------------------------------- a fake console

interface Stub {
  status: { state: string; endReason: string | null; expiresInMs: number };
  emit: (...events: Array<{ id: number; event: string; data: unknown }>) => void;
  terminals: Array<{ close: () => void }>;
  pass: { value: boolean };
  errors: string[];
}

const json = (route: Route, body: unknown, status = 200) => {
  const origin = route.request().headers()['origin'];
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {},
    body: JSON.stringify(body),
  });
};

async function stub(page: Page): Promise<Stub> {
  const waiting: Array<() => void> = [];
  const queue: Array<{ id: number; event: string; data: unknown }> = [];
  const s: Stub = {
    status: { state: 'running', endReason: null, expiresInMs: 3_000_000 },
    emit: (...events) => {
      queue.push(...events);
      while (waiting.length) waiting.shift()!();
    },
    terminals: [],
    pass: { value: false },
    errors: [],
  };
  let lastRun: Record<string, unknown> | null = null;
  let checkRuns = 0;
  let lab_: string = BUILD;
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/me') return json(route, { sub: 'console' });
    if (path === '/api/labs') return json(route, LABS);
    if (path === '/api/onboarding') return json(route, { version: 1, ...onboarding });
    if (path === '/api/learn/answers' && method === 'POST') return json(route, { ok: true, recorded: 1 }, 201);
    if (path.startsWith('/api/learn/') && method === 'GET') {
      const slug = decodeURIComponent(path.slice('/api/learn/'.length));
      return slug === EXPLORE ? json(route, { version: '1.0.0', learn: bundle }) : json(route, { error: { code: 'no_learn', message: 'none' } }, 404);
    }
    if (path === '/api/start' && method === 'POST') {
      lab_ = JSON.parse(route.request().postData() ?? '{}').lab;
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
    const cors = { 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'access-control-allow-credentials': 'true' };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (p === base && method === 'GET') {
      const now = Date.now();
      return json(route, {
        meta: { state: s.status.state, lab_slug: lab_, started_at: now, expires_at: now + s.status.expiresInMs, end_reason: s.status.endReason },
        services: { echo: { health: 'healthy' } },
        snapshots: [],
        cost: { usd: 0.03 },
        hints: { total: 3, schedule: [0, 12, 30], delivered: [{ index: 0, after_minutes: 0, text: 'Read the provider log first.' }] },
        manifest_summary: { title: 'A lab', learner_restart: true, checks: [{ name: 'support answered by a' }, { name: 'the count matches' }] },
        checks: lastRun ?? undefined,
        checks_history: lastRun ? [lastRun] : [],
        server_time: now,
      });
    }
    if (p === base && method === 'DELETE') return json(route, { ok: true });
    if (p === `${base}/events`) {
      if (!queue.length) await new Promise<void>((resolveWait) => waiting.push(resolveWait));
      const batch = queue.splice(0);
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', ...cors, 'cache-control': 'no-store' },
        body: batch.map((e) => `id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join(''),
      });
    }
    if (p === `${base}/files` && method === 'GET') return json(route, [{ name: 'brief.md', size: 30, isDirectory: false }]);
    if (p === `${base}/files/brief.md` && method === 'GET') return json(route, { content: '# The brief\n\nSend a few calls and compare what the gateway says with what the provider says.\n' });
    if (p.startsWith(`${base}/files/`) && method === 'GET') return json(route, { error: { code: 'not_found', message: 'no such file' } }, 404);
    if (p === `${base}/checks` && method === 'POST') {
      checkRuns++;
      const now = Date.now();
      lastRun = {
        run_id: `run-${checkRuns}`,
        started_at: now - 500,
        finished_at: now,
        results: [
          { name: 'support answered by a', pass: true, weight: 1 },
          { name: 'the count matches', pass: s.pass.value, weight: 2, message: s.pass.value ? '' : 'expected 11' },
        ],
      };
      return json(route, lastRun);
    }
    if (p.includes('/services/echo/session') && method === 'POST') return route.fulfill({ status: 204, headers: cors });
    if (p.startsWith(`${base}/services/echo/`) && method === 'GET') return route.fulfill({ status: 200, contentType: 'text/html', headers: cors, body: '<!doctype html><h1>Echo service</h1>' });
    if (p.startsWith(base) && method !== 'GET') return json(route, {}, 200);
    return json(route, { error: 'not stubbed' }, 404);
  });

  await page.routeWebSocket(/\/terminal/, (ws) => {
    s.terminals.push({ close: () => ws.close({ code: 1006 }) });
  });
  return s;
}

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

/** Opens the console on an address, past the first-run dialog; `quiz` leaves the platform quiz for the learner to take. */
async function open(page: Page, path = '/', { quiz = false }: { quiz?: boolean } = {}) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript((q) => {
    localStorage.setItem('opalixOnboarded', '1');
    if (!q) localStorage.setItem('opalixLearn', JSON.stringify({ v: 1, onboarding: { status: 'skipped', at: 1, levels: {} } }));
  }, quiz);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
}

/** Starts the build lab from its card, and leaves the session on screen once it reports `running`. */
async function startBuildLab(page: Page, s: Stub, { hold = false }: { hold?: boolean } = {}) {
  if (hold) s.status.state = 'starting';
  await page.locator(`.lab[data-slug="${BUILD}"] .lab-start`).click();
  await expect(page.locator('#workspace')).toBeVisible();
  if (hold) return;
  await expect(page.locator('#statePill')).toHaveText('running');
  await expect(page.locator('#bootModal')).toBeHidden();
  await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
}

// =========================================================================
// before a lab
// =========================================================================

test.describe('before a lab starts', () => {
  test('the launcher, the help dialog and a page that is not there', async ({ page }) => {
    await stub(page);
    await open(page);
    await expect(page.locator(`.lab[data-slug="${BUILD}"]`)).toBeVisible();
    await saysNothingOfThePlatform(page, 'the launcher');

    await page.locator('#btnHelp').click();
    await expect(page.locator('#onboarding')).toBeVisible();
    await expect(page.locator('#onboarding')).toContainText('How this console works');
    await saysNothingOfThePlatform(page, 'the help dialog');
    await page.keyboard.press('Escape');

    await page.goto('/nothing-lives-here', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('#notFound')).toBeVisible();
    await saysNothingOfThePlatform(page, 'the not-found page');
  });

  test('the platform quiz, and the story and quick questions of a lab', async ({ page }) => {
    await stub(page);
    await open(page, '/onboarding', { quiz: true });
    await expect(page.locator('#learnHost')).toContainText('areas');
    await saysNothingOfThePlatform(page, 'the platform quiz');

    await page.evaluate(() => localStorage.setItem('opalixLearn', JSON.stringify({ v: 1, onboarding: { status: 'skipped', at: 1, levels: {} } })));
    await page.goto(`/labs/${EXPLORE}/story`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('#learnHost [data-learn-heading]')).toBeVisible();
    await saysNothingOfThePlatform(page, 'the story');
  });

  test('a lab that cannot start says so in plain words, with no status code', async ({ page }) => {
    await stub(page);
    await open(page);
    // Registered after the stub's own route, so it answers first.
    await page.route('**/api/start', (route) => json(route, { error: { code: 'container_unavailable', message: 'pool exhausted: no container (terminal_upstream_closed 1006)' } }, 500));
    await page.locator(`.lab[data-slug="${BUILD}"] .lab-start`).click();
    const error = page.locator('#launchError');
    await expect(error).toContainText('Could not start this lab');
    await expect(error).toContainText('Something went wrong on our side');
    await saysNothingOfThePlatform(page, 'a failed start');
  });

  test('a busy platform says the labs are busy and that it will try again', async ({ page }) => {
    await stub(page);
    await open(page);
    await page.route('**/api/start', (route) => json(route, { error: { code: 'container_unavailable', message: 'pool exhausted' } }, 503));
    await page.locator(`.lab[data-slug="${BUILD}"] .lab-start`).click();
    await expect(page.locator('#launchError')).toContainText('Labs are busy right now');
    await saysNothingOfThePlatform(page, 'the busy notice');
  });

  test('a launcher that cannot load says so in plain words', async ({ page }) => {
    await stub(page);
    await page.route('**/api/labs', (route) => json(route, { error: 'database is down' }, 502));
    await open(page);
    await expect(page.locator('#labList .error')).toContainText('Could not load labs');
    await saysNothingOfThePlatform(page, 'a launcher that did not load');
  });
});

// =========================================================================
// the session
// =========================================================================

test.describe('a lab session', () => {
  test('the dialog while the lab starts, then every guide tab, the checks and the result card', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await startBuildLab(page, s, { hold: true });
    await expect(page.locator('#bootModal')).toBeVisible();
    await expect(page.locator('#bootTitle')).toHaveText('Starting your lab');
    await saysNothingOfThePlatform(page, 'the dialog while a lab starts');

    s.status.state = 'running';
    await expect(page.locator('#statePill')).toHaveText('running', { timeout: 15_000 });
    await expect(page.locator('#bootModal')).toBeHidden();
    await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
    await saysNothingOfThePlatform(page, 'the session header, brief and dock');

    await page.getByRole('tab', { name: 'Hints' }).click();
    await saysNothingOfThePlatform(page, 'the hints tab');
    await page.getByRole('tab', { name: 'Checks' }).click();
    await page.locator('#btnChecksInline').click();
    await expect(page.locator('#checksPanel .check-name').first()).toBeVisible();
    await saysNothingOfThePlatform(page, 'the checks tab, with a failing check');

    s.pass.value = true;
    await page.locator('#btnChecksInline').click();
    await expect(page.locator('#resultCard')).toBeVisible();
    await saysNothingOfThePlatform(page, 'the result card');

    await page.getByRole('tab', { name: 'Brief' }).click();
    await page.getByRole('tab', { name: 'Editor' }).click();
    await saysNothingOfThePlatform(page, 'the editor');
  });

  test('the activity feed, after the API reports a restart, an expiry, an idle warning and an internal alert', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await startBuildLab(page, s);
    s.emit(
      { id: 1, event: 'session.expiring', data: { reason: 'hard_timeout' } },
      { id: 2, event: 'session.idle_warning', data: {} },
      { id: 3, event: 'alert', data: { kind: 'terminal_upstream_closed', message: 'terminal_upstream_closed', error: 'closed (1006)' } },
      { id: 4, event: 'container.restarted', data: {} }
    );
    await expect(page.locator('#noticeList')).toContainText('Your lab restarted');
    await expect(page.locator('#noticeList')).toContainText('Something went wrong');
    // The activity feed is one line until it is opened.
    if (await page.locator('#btnActivityToggle').isVisible()) await page.locator('#btnActivityToggle').click();
    await expect(page.locator('#noticeList')).toContainText('Session ending soon');
    await saysNothingOfThePlatform(page, 'the activity feed');
    expect(await page.locator('#noticeList').innerText()).not.toMatch(/terminal_upstream_closed|1006/);
    await expect(page.locator('#idleBanner')).toBeVisible();
    await saysNothingOfThePlatform(page, 'the idle warning');
  });

  test('the terminal says it is reconnecting, and what to do when it cannot', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await startBuildLab(page, s);
    await expect.poll(() => s.terminals.length).toBe(1);
    s.terminals[0]!.close();
    await expect(page.locator('#termStatusText')).toContainText('Reconnecting');
    await saysNothingOfThePlatform(page, 'the terminal reconnecting');
    // A restart reported by the API leaves the terminal waiting with a button, and with words
    // (the lab is not running again yet, so nothing re-attaches under the assertion).
    s.status.state = 'starting';
    s.emit({ id: 1, event: 'container.restarted', data: {} });
    await expect(page.locator('#termStatusText')).toContainText('restarted');
    await saysNothingOfThePlatform(page, 'the terminal after a restart');
  });

  test('the warning under five minutes, and the end dialog', async ({ page }) => {
    const s = await stub(page);
    s.status.expiresInMs = 4 * 60_000;
    await open(page);
    await startBuildLab(page, s);
    await expect(page.locator('#expiryBanner')).toBeVisible();
    await expect(page.locator('#btnEnd')).toHaveText('End & save');
    await saysNothingOfThePlatform(page, 'the expiry warning');

    await page.locator('#btnEnd').click();
    await expect(page.locator('#endDialog')).toBeVisible();
    await saysNothingOfThePlatform(page, 'the end dialog');
    await page.locator('#btnEndCancel').click();
    await expect(page.locator('#endDialog')).toBeHidden();

    await page.locator('#btnSnapshot').click();
    await expect(page.locator('#toast')).toContainText('Progress saved');
    await saysNothingOfThePlatform(page, 'the saved-progress notice');
  });

  for (const reason of ['idle', 'expired', 'error', 'evicted', 'user']) {
    test(`a session that ended (${reason}) says why and what to do next`, async ({ page }) => {
      const s = await stub(page);
      await open(page);
      await startBuildLab(page, s);
      s.status.state = 'ended';
      s.status.endReason = reason;
      s.emit({ id: 50, event: 'session.state', data: { state: 'ended', reason } });
      await expect(page.locator('#endedBanner')).toBeVisible();
      await saysNothingOfThePlatform(page, `the ended banner (${reason})`);
      expect(await page.locator('#expiryTimer').innerText()).toBe('ended');
    });
  }

  test('a lab that is gone says so without a status code', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    // The session's status is refused as gone: the dialog says it is no longer available, and offers the way back.
    await page.route(`${API}/sessions/${SESSION_ID}`, (route) => (route.request().method() === 'GET' ? json(route, { error: { code: 'not_found', message: 'session not found in the pool' } }, 404) : route.fallback()));
    s.status.state = 'starting';
    await page.locator(`.lab[data-slug="${BUILD}"] .lab-start`).click();
    await expect(page.locator('#bootError')).toContainText('no longer available', { timeout: 15_000 });
    await saysNothingOfThePlatform(page, 'a lab that is gone');
  });
});

// =========================================================================
// the sign-in page
// =========================================================================

const gated = base.extend<object, { gateServer: string }>({
  gateServer: [
    async ({}, use) => {
      const { url, server }: { url: string; server: Server } = await serveWorker({ labs: LABS, learn: () => null });
      await use(url);
      await new Promise((done) => server.close(done));
    },
    { scope: 'worker' },
  ],
});

gated.describe('the sign-in page', () => {
  gated('asks for the password without saying what the console starts', async ({ page, gateServer }) => {
    await page.goto(`${gateServer}/`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#f')).toBeVisible();
    await saysNothingOfThePlatform(page, 'the sign-in page');
    await page.fill('#pw', 'wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#err')).toHaveText('Wrong password.');
    await saysNothingOfThePlatform(page, 'a wrong password');
  });
});

// =========================================================================
// the public site
// =========================================================================

test.describe('the public site', () => {
  const pages = readdirSync(join(ROOT, 'site/public'))
    .filter((f) => f.endsWith('.html') && f !== 'privacy.html')
    .sort();
  test('has pages to read', () => {
    expect(pages).toEqual(expect.arrayContaining(['index.html', 'waitlist.html', 'status.html', 'labs.html', 'feedback.html']));
    // The privacy page names its processor on purpose, and is the one page left out.
    expect(pages).not.toContain('privacy.html');
  });
  for (const file of pages) {
    test(`${file} says nothing of how the platform is built`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      // The status page asks the live service; with nothing to ask it settles on its own wording.
      await page.route('**/health', (route) => route.abort());
      await page.goto(pathToFileURL(join(ROOT, 'site/public', file)).href, { waitUntil: 'domcontentloaded' });
      await saysNothingOfThePlatform(page, `site/${file}`, FORBIDDEN_SITE);
    });
  }
});
