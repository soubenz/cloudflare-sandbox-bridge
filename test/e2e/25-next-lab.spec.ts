import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { serveConsole } from './console-server';

/**
 * One next lab, and a console that moves the way a learner expects.
 *
 * What is pinned here:
 *   - the profile's `next_lab` is the one answer: Home's "Your path" band, the "Suggested start" badge on the
 *     path card and on the module, and the card at the end of a finished lab all name the same lab;
 *   - a finished lab's result card says what it earned ("+120 XP", "Skill: Gateway and access 12 → 31") from the
 *     profile read again, and offers "Next lab: <title>" as a link;
 *   - "Back to labs" in a lab goes to the lab's module page, not to the lab's own page;
 *   - Home keeps all its blocks in one order: the hero, "Your path", "Your progress", the search and filters, then
 *     the path cards; "No labs match" sits just above the cards; there is no lone "Home" crumb;
 *   - the header's links go to their own addresses and say which page is open;
 *   - a lab's title in a module's row is a link to its page; a module's page ends with its neighbours;
 *   - a path of one or two labs and no modules says "More labs coming";
 *   - the filters use the console's words (Intro, Core, Advanced; Not started, In progress, Done).
 *
 * Like 16 to 24 this needs no password, no API and no container: a static server serves dashboard/public and
 * every call the console makes is answered by a route stub. Run `npm run build:dashboard` first.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC = join(ROOT, 'dashboard/public');
const API = 'https://opalix-sandbox.soubenz94.workers.dev';
const SESSION_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const TOKEN = 'test-token';
const WIDE = { width: 1440, height: 900 };

type PathMeta = { slug: string; title: string; modules: Array<{ number: number; title: string }> };
const meta = JSON.parse(readFileSync(join(ROOT, 'packages/catalogue/paths.json'), 'utf8')) as { paths: PathMeta[] };
const AI = meta.paths.find((p) => p.slug === 'ai-platform')!;
const moduleTitle = (n: number) => AI.modules.find((m) => m.number === n)!.title;
const moduleUrl = (n: number) => `/paths/ai-platform/modules/${n}`;

const lab = (o: Record<string, unknown>) => ({
  version: '1.0.0',
  type: 'build',
  family: 'gateway',
  summary: `About ${o.slug}`,
  objectives: ['do the thing'],
  difficulty: 'core',
  timeout_minutes: 30,
  estimated_minutes: 20,
  tier: 'free',
  path: 'ai-platform',
  module: 1,
  has_learn: false,
  progress: null,
  ...o,
});
const DONE = { attempts: 2, best_score: 1, passed_all: true, last_run_at: 1 };
const LABS = [
  lab({ slug: 'first-gateway-lab', title: 'First gateway lab', order: 1, difficulty: 'intro', progress: DONE }),
  lab({ slug: 'hard-budget', title: 'Hard budget', order: 2 }),
  lab({ slug: 'tools-reach-an-agent', title: 'Tools reach an agent', module: 2, order: 1, difficulty: 'intro' }),
  lab({ slug: 'why-a-document-matched', title: 'Why a document matched', module: 3, order: 1, difficulty: 'advanced' }),
  // A path of one lab, and one of three: only the first is "still coming".
  lab({ slug: 'shield-one', title: 'Shield one', path: 'securing-agents', module: 1, order: 1 }),
  lab({ slug: 'pa-1', title: 'Retry twice', path: 'production-agents', module: 1, order: 1, family: 'agent' }),
  lab({ slug: 'pa-2', title: 'Weekend bill', path: 'production-agents', module: 1, order: 2, family: 'agent' }),
  lab({ slug: 'pa-3', title: 'Sold out', path: 'production-agents', module: 1, order: 3, family: 'agent' }),
];

const NEXT = { slug: 'hard-budget', title: 'Hard budget', skill: 'gateway', path: 'ai-platform', module: 1 };

const SKILL = { area: 'gateway', title: moduleTitle(1) };
const profile = (o: { xp: number; gateway: number; next: typeof NEXT | null }) => ({
  user_id: 'console',
  xp: o.xp,
  level: { n: 2, title: 'Apprentice', xp_into: 20, xp_needed: 200 },
  streak: { days: 1, best: 1, last_active: '2026-01-06' },
  skills: [{ ...SKILL, score: o.gateway, level: o.gateway > 0 ? 'Foundations' : 'Not started', evaluation: 'x', labs_done: 1, labs_total: 2, next_lab: null, starting_level: null }],
  awards: { earned: [], locked: [] },
  overall: { score: o.gateway, level: o.gateway > 0 ? 'Foundations' : 'Not started', evaluation: 'x' },
  next_lab: o.next,
  updated_at: 1,
});
const compact = (p: ReturnType<typeof profile>) => ({
  user_id: p.user_id,
  overall: p.overall,
  level: p.level,
  xp: p.xp,
  streak: p.streak,
  top_skills: p.skills.map(({ area, title, score, level }) => ({ area, title, score, level })),
  recent_awards: [],
  next_lab: p.next_lab,
  updated_at: 1,
});

const BEFORE = profile({ xp: 100, gateway: 12, next: NEXT });
const AFTER = profile({ xp: 220, gateway: 31, next: NEXT });

const step = (slug: string, title: string, status: string) => ({ slug, title, area: 'gateway', why: `Why ${title}.`, estimated_minutes: 20, status });
const PATH = {
  steps: [step('first-gateway-lab', 'First gateway lab', 'done'), step('hard-budget', 'Hard budget', 'next'), step('tools-reach-an-agent', 'Tools reach an agent', 'upcoming')],
  total_minutes: 40,
  weeks_estimate: 1,
  goal: { text: 'Run our gateway', kind: 'role-ready' },
  source: 'ai',
  generated_at: 1,
};

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
  fullProfileReads: number;
  errors: string[];
}

/** The console's calls, answered. The first full profile read is the learner before the lab, every later one after it. */
async function stub(page: Page, opts: { path?: boolean } = {}): Promise<Stub> {
  const s: Stub = { fullProfileReads: 0, errors: [] };
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/me') return json(route, { sub: 'console', user_id: 'console' });
    if (path === '/api/sessions/active') return json(route, { sessions: [] });
    if (path === '/api/labs') return json(route, LABS);
    if (path === '/api/onboarding') return json(route, { error: 'none' }, 404);
    if (path === '/api/profile') {
      if (url.searchParams.get('compact') === '1') return json(route, compact(s.fullProfileReads > 0 ? AFTER : BEFORE));
      s.fullProfileReads++;
      return json(route, s.fullProfileReads === 1 ? BEFORE : AFTER);
    }
    if (path === '/api/path') return opts.path === false ? json(route, { error: { code: 'no_inputs', message: 'none' } }, 404) : json(route, PATH);
    return json(route, { error: 'not stubbed' }, 404);
  });
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const method = req.method();
    const base = `/sessions/${SESSION_ID}`;
    const cors = { 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'access-control-allow-credentials': 'true' };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (p === base && method === 'GET') {
      const now = Date.now();
      return json(route, {
        meta: { state: 'running', lab_slug: 'first-gateway-lab', started_at: now, expires_at: now + 3_000_000, end_reason: null },
        services: { echo: { health: 'healthy' } },
        snapshots: [],
        cost: { usd: 0.03 },
        hints: { total: 3, schedule: [0, 12, 30], delivered: [] },
        manifest_summary: { title: 'First gateway lab', checks: [{ name: 'support answered by a' }] },
        checks: { run_id: 'run-1', started_at: now - 500, finished_at: now, results: [{ name: 'support answered by a', pass: true, weight: 1 }] },
        checks_history: [],
        server_time: now,
      });
    }
    if (p === `${base}/events`) await new Promise<void>(() => {});
    if (p === `${base}/files` && method === 'GET') return json(route, [{ name: 'brief.md', size: 30, isDirectory: false }]);
    if (p === `${base}/files/brief.md` && method === 'GET') return json(route, { content: '# The brief\n' });
    if (p === `${base}/services/echo/session` && method === 'POST') return route.fulfill({ status: 204, headers: cors });
    if (p.startsWith(`${base}/services/echo/`)) return route.fulfill({ status: 200, contentType: 'text/html', headers: cors, body: '<!doctype html><h1>Echo</h1>' });
    if (p.startsWith(base) && method !== 'GET') return json(route, {}, 200);
    return json(route, { error: 'not stubbed' }, 404);
  });
  await page.routeWebSocket(/\/terminal/, () => {});
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

async function visit(page: Page, path: string, { running = false }: { running?: boolean } = {}) {
  await page.setViewportSize(WIDE);
  await page.addInitScript(
    ([run]) => {
      if (sessionStorage.getItem('seeded')) return;
      localStorage.setItem('opalixOnboarded', '1');
      localStorage.setItem('opalixLearn', '{"v":1,"onboarding":{"status":"skipped"}}');
      if (run) localStorage.setItem('opalix.session', JSON.stringify({ id: run[0], token: run[1], lab: 'first-gateway-lab', urls: { services: { echo: {} } } }));
      sessionStorage.setItem('seeded', '1');
    },
    [running ? [SESSION_ID, TOKEN] : null] as const
  );
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
}

const row = (page: Page, slug: string) => page.locator(`.lab[data-slug="${slug}"]`);
const here_ = (page: Page) => new URL(page.url()).pathname;
const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });
const top = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!.y;

test.describe('one next lab', () => {
  test('Home\'s path band, the Suggested start badges and the profile name the same lab', async ({ page }) => {
    const s = await stub(page);
    await visit(page, '/');
    await expect(page.locator('#homePath .next-title')).toHaveText('Hard budget');
    await expect(page.locator('#path-ai-platform .badge-suggested')).toHaveText('Suggested start');
    await expect(page.locator('#path-production-agents .badge-suggested')).toHaveCount(0);
    await page.locator('#path-ai-platform').getByRole('link', { name: 'AI platform engineering' }).click();
    await expect(page.locator('.module-card[data-module="1"] .badge-suggested')).toHaveText('Suggested start');
    await expect(page.locator('.module-card[data-module="2"] .badge-suggested')).toHaveCount(0);
    expect(s.errors).toEqual([]);
  });
});

test.describe('a finished lab', () => {
  test('says what it earned and offers the next lab, as a link', async ({ page }) => {
    const s = await stub(page);
    await visit(page, '/', { running: true });
    await expect(page.locator('#workspace')).toBeVisible();
    // Every check passes in the stub, so the result card is up (in the guide's Checks tab); the profile is read
    // again for what it earned.
    await expect(page.locator('#resultCard')).not.toHaveAttribute('hidden', '');
    await page.locator('#tabChecks').click();
    await expect(page.locator('#resultCard')).toBeVisible();
    const gain = page.locator('#resultGain');
    await expect(gain).toContainText('+120 XP');
    await expect(gain).toContainText(`Skill: ${moduleTitle(1)} 12 → 31`);
    const next = page.locator('#resultNextLink');
    await expect(next).toHaveText('Next lab: Hard budget');
    await expect(next).toHaveAttribute('href', '/labs/hard-budget');
    expect(s.fullProfileReads).toBeGreaterThanOrEqual(2);

    await next.click();
    await expect(page.locator('.lab-detail-title')).toHaveText('Hard budget');
    expect(here_(page)).toBe('/labs/hard-budget');
    expect(s.errors).toEqual([]);
  });

  test('"Back to labs" goes to the lab\'s module page, where the lab says Resume', async ({ page }) => {
    await stub(page);
    await visit(page, '/', { running: true });
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('#btnBackToLabs').click();
    await expect(page.locator('.module')).toBeVisible();
    expect(here_(page)).toBe(moduleUrl(1));
    await expect(row(page, 'first-gateway-lab').locator('.lab-start')).toHaveText('Resume');
    await expect(page.locator('#workspace')).toBeHidden();
  });
});

test.describe('Home, in one order', () => {
  test('the hero, Your path, Your progress, the filters, then the path cards, with no lone Home crumb', async ({ page }) => {
    const s = await stub(page);
    await visit(page, '/');
    await expect(page.locator('#homePath')).toBeVisible();
    await expect(page.locator('#homeProgress')).toBeVisible();
    await expect(page.locator('.path-card').first()).toBeVisible();
    const ys = [await top(page, '#heroTitle'), await top(page, '#homePath'), await top(page, '#homeProgress'), await top(page, '#labFilters'), await top(page, '.path-cards')];
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(new Set(ys).size).toBe(ys.length);
    await expect(crumbs(page)).toBeHidden();
    // Three paths in this catalogue, and no advice about what to do first.
    await expect(page.locator('#heroLede')).toHaveText('Three paths, each a run of hands-on labs.');
    expect(s.errors).toEqual([]);
  });

  test('"No labs match" sits between the filters and the path cards, and typing in the search keeps the focus', async ({ page }) => {
    await stub(page);
    await visit(page, '/');
    const search = page.locator('#labSearch');
    await search.click();
    await page.keyboard.type('zzzz');
    await expect(page.locator('#labNoMatch')).toBeVisible();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('zzzz');
    expect(await top(page, '#labFilters')).toBeLessThan(await top(page, '#labNoMatch'));
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.locator('#labNoMatch')).toBeHidden();
    await expect(page.locator('.path-card').first()).toBeVisible();
  });

  test('the filter chips use the console\'s words', async ({ page }) => {
    await stub(page);
    await visit(page, '/');
    const chips = (group: string) => page.getByRole('group', { name: group }).locator('.filter-chip');
    await expect(chips('Difficulty')).toHaveText(['Intro', 'Core', 'Advanced']);
    await expect(chips('Family')).toHaveText(['Agent', 'Gateway']);
    await expect(chips('Status')).toHaveText(['Not started', 'In progress', 'Done']);
  });

  test('a path of one lab says more labs are coming; a path with three does not', async ({ page }) => {
    await stub(page);
    await visit(page, '/');
    await expect(page.locator('#path-securing-agents .badge-soon')).toHaveText('More labs coming');
    await expect(page.locator('#path-production-agents .badge-soon')).toHaveCount(0);
    await expect(page.locator('#path-ai-platform .badge-soon')).toHaveCount(0);
  });
});

test.describe('the header', () => {
  test('Labs, Paths, Your path and Profile each go to their own address, and the open one is marked', async ({ page }) => {
    await stub(page);
    await visit(page, '/');
    const nav = page.getByRole('navigation', { name: 'Console' });
    await expect(nav.getByRole('link', { name: 'Labs' })).toHaveAttribute('href', '/');
    await expect(nav.getByRole('link', { name: 'Paths' })).toHaveAttribute('href', '/#paths');
    await expect(nav.getByRole('link', { name: 'Your path' })).toHaveAttribute('href', '/paths/mine');
    await expect(nav.getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/profile');
    await expect(page.locator('#navLabs')).toHaveAttribute('aria-current', 'page');

    await nav.getByRole('link', { name: 'Your path' }).click();
    expect(here_(page)).toBe('/paths/mine');
    await expect(page.locator('#navMyPath')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#navLabs')).not.toHaveAttribute('aria-current', 'page');

    await nav.getByRole('link', { name: 'Paths' }).click();
    expect(here_(page)).toBe('/');
    await expect(page.locator('#navLabs')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#paths')).toBeInViewport();
    await expect(page.locator('.path-card-title a').first()).toBeFocused();

    await page.locator('.path-card-title a').first().click();
    await expect(page.locator('#navPaths')).toHaveAttribute('aria-current', 'page');
    await nav.getByRole('link', { name: 'Profile' }).click();
    await expect(page.locator('#navProfile')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#navPaths')).not.toHaveAttribute('aria-current', 'page');
  });

  test('an address ending in #paths opens Home at the path cards', async ({ page }) => {
    await stub(page);
    await visit(page, '/#paths');
    await expect(page.locator('.path-card').first()).toBeInViewport();
  });
});

test.describe('modules and labs', () => {
  test('a lab\'s title in a module\'s row opens its page', async ({ page }) => {
    await stub(page);
    await visit(page, moduleUrl(1));
    const title = row(page, 'hard-budget').getByRole('heading', { level: 2 }).getByRole('link', { name: 'Hard budget' });
    await expect(title).toHaveAttribute('href', '/labs/hard-budget');
    await title.click();
    await expect(page.locator('.lab-detail-title')).toHaveText('Hard budget');
    expect(here_(page)).toBe('/labs/hard-budget');
  });

  test('a module\'s page ends with the module before it and the one after it', async ({ page }) => {
    await stub(page);
    await visit(page, moduleUrl(2));
    const foot = page.getByRole('navigation', { name: 'Other modules in this path' });
    await expect(foot.getByRole('link', { name: `Previous module: ${moduleTitle(1)}` })).toHaveAttribute('href', moduleUrl(1));
    await expect(foot.getByRole('link', { name: `Next module: ${moduleTitle(3)}` })).toHaveAttribute('href', moduleUrl(3));
    await foot.getByRole('link', { name: /^Next module/ }).click();
    expect(here_(page)).toBe(moduleUrl(3));
    // The last module has no "next", and the first has no "previous".
    await expect(page.getByRole('navigation', { name: 'Other modules in this path' }).getByRole('link')).toHaveText([`← Previous module: ${moduleTitle(2)}`]);
    await page.goto(moduleUrl(1), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.module');
    await expect(page.getByRole('navigation', { name: 'Other modules in this path' }).getByRole('link')).toHaveText([`Next module: ${moduleTitle(2)} →`]);
  });

  test('a module page shows "You will learn to" from the module\'s outcomes, in words, with its time as About', async ({ page }) => {
    await stub(page);
    await visit(page, moduleUrl(1));
    await expect(page.locator('.skills-label')).toHaveText('You will learn to');
    await expect(page.locator('.module-meta')).toHaveText('2 labs · About 40 min');
    await expect(page.locator('.module-progress')).toHaveText('1 of 2 labs done');
    await expect(row(page, 'hard-budget').locator('.chip-time')).toHaveText('20 min');
  });
});
