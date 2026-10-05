import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { serveConsole } from './console-server';

/**
 * A Pro lab on the free plan is locked in the catalogue, not only on /paths/mine.
 *
 * The console's Worker puts `plan` on every lab (and `bypass: true` for the owner's own subject), and a
 * row or a lab's page draws the lock from them: the same lock chip and Unlock link as a locked step on the
 * learner's path, the short plan wording ("Pro plan"), Start switched off, and no "None. You can start
 * right away." on the page of a lab that cannot be started. A learner on the Pro plan, the owner's subject
 * and the owner's developer view each see it open; a start the service refuses says why in the same sentence.
 *
 * Like 16 to 23 this needs no password, no API and no container: a static server serves dashboard/public and
 * every call the console makes is answered by a route stub. Run `npm run build:dashboard` first.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC = join(ROOT, 'dashboard/public');
/** Where an Unlock link goes: the plans page of the public site, as the footer's Status link says. */
const PRICING = 'https://opalix-site.soubenz94.workers.dev/#pricing';
const LONG = 'This lab is included with the Pro plan.';
const WIDE = { width: 1440, height: 900 };
const MODULE_1 = '/paths/ai-platform/modules/1';

const lab = (o: Record<string, unknown>) => ({
  version: '1.0.0',
  type: 'build',
  family: 'gateway',
  summary: `About ${o.slug}`,
  objectives: ['do the thing'],
  difficulty: 'core',
  timeout_minutes: 30,
  estimated_minutes: 20,
  tier: 'pro',
  path: 'ai-platform',
  module: 1,
  has_learn: false,
  progress: null,
  ...o,
});

/** Module 1 of the platform path: a free lab, a Pro lab with nothing before it, and a Pro lab behind the free one. */
const catalogue = (extra: Record<string, unknown> = {}) => [
  lab({ slug: 'free-start', title: 'A free start', order: 1, tier: 'free', ...extra }),
  lab({ slug: 'pro-open', title: 'A Pro lab', order: 2, tier: 'pro', ...extra }),
  lab({ slug: 'pro-after', title: 'A Pro lab after the free one', order: 3, tier: 'pro', prerequisites: ['free-start'], ...extra }),
];

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

interface Stub {
  starts: string[];
  errors: string[];
}

async function stub(page: Page, opts: { labs: unknown[]; me?: Record<string, unknown>; startStatus?: number }): Promise<Stub> {
  const s: Stub = { starts: [], errors: [] };
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return json(route, { sub: 'console', user_id: 'console', ...opts.me });
    if (path === '/api/sessions/active') return json(route, { sessions: [] });
    if (path === '/api/labs') return json(route, opts.labs);
    if (path === '/api/start' && route.request().method() === 'POST') {
      s.starts.push(JSON.parse(route.request().postData() ?? '{}').lab);
      if (opts.startStatus) return json(route, { error: { code: 'plan_required', message: LONG } }, opts.startStatus);
    }
    return json(route, { error: 'not stubbed' }, 404);
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

async function visit(page: Page, path: string, { adminOn = false }: { adminOn?: boolean } = {}) {
  await page.setViewportSize(WIDE);
  await page.addInitScript((on) => {
    localStorage.setItem('opalixOnboarded', '1');
    localStorage.setItem('opalixLearn', '{"v":1,"onboarding":{"status":"skipped"}}');
    if (on) localStorage.setItem('opalixAdminMode', '1');
  }, adminOn);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
  await page.waitForSelector('.lab, .lab-detail, .path-card');
}

const row = (page: Page, slug: string) => page.locator(`.lab[data-slug="${slug}"]`);

test.describe('a Pro lab on the free plan', () => {
  test('is locked on its row: the Pro plan chip, an Unlock link to the plans page, and Start switched off', async ({ page }) => {
    const s = await stub(page, { labs: catalogue({ plan: 'free' }) });
    await visit(page, MODULE_1);

    const pro = row(page, 'pro-open');
    await expect(pro).toHaveClass(/lab-plan-locked/);
    await expect(pro.locator('.lab-lock')).toHaveText('Pro plan');
    const unlock = pro.getByRole('link', { name: 'Unlock A Pro lab with a plan' });
    await expect(unlock).toHaveText('Unlock');
    await expect(unlock).toHaveAttribute('href', PRICING);
    await expect(unlock).not.toHaveAttribute('target', /.+/);
    // The same link-button as a locked step on /paths/mine.
    await expect(unlock).toHaveClass(/\bunlock-link\b/);
    const start = pro.locator('.lab-start');
    await expect(start).toHaveText('Start');
    await expect(start).toBeDisabled();
    await start.click({ force: true });
    expect(s.starts).toEqual([]);

    // A free lab beside it is just as it was.
    const free = row(page, 'free-start');
    await expect(free).not.toHaveClass(/lab-plan-locked/);
    await expect(free.locator('.lab-lock, .unlock-link')).toHaveCount(0);
    await expect(free.locator('.lab-start')).toBeEnabled();
    await expect(free.locator('.lab-state')).toHaveText('Not started');
    expect(s.errors).toEqual([]);
  });

  test('says the plan first when a lab is locked twice: behind another lab and behind the plan', async ({ page }) => {
    await stub(page, { labs: catalogue({ plan: 'free' }) });
    await visit(page, MODULE_1);
    const both = row(page, 'pro-after');
    await expect(both.locator('.lab-lock')).toHaveText('Pro plan');
    await expect(both.getByRole('link', { name: /^Unlock / })).toHaveAttribute('href', PRICING);
    await expect(both.locator('.lab-start')).toBeDisabled();
  });

  test('has a lab page that says why, and does not say "You can start right away"', async ({ page }) => {
    const s = await stub(page, { labs: catalogue({ plan: 'free' }) });
    await visit(page, '/labs/pro-open');
    const detail = page.locator('.lab-detail');
    await expect(detail).toHaveClass(/lab-plan-locked/);
    await expect(detail.locator('.lab-status .lab-lock')).toHaveText('Pro plan');
    await expect(detail.getByRole('link', { name: 'Unlock A Pro lab with a plan' })).toHaveAttribute('href', PRICING);
    await expect(detail.locator('.lab-start')).toBeDisabled();
    await expect(detail.locator('.lab-detail-side .lab-detail-note')).toHaveText(LONG);
    await expect(detail).not.toContainText('None. You can start right away.');
    await expect(detail.locator('.lab-prereq-section')).toHaveCount(0);
    expect(s.starts).toEqual([]);

    // A lab that can be started still says it has no prerequisites.
    await page.goto('/labs/free-start', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lab-detail');
    await expect(page.locator('.lab-prereq-section')).toContainText('None. You can start right away.');
    await expect(page.locator('.lab-detail .lab-start')).toBeEnabled();
  });

  test('a lab with a prerequisite keeps its Prerequisites list when it is locked', async ({ page }) => {
    await stub(page, { labs: catalogue({ plan: 'free' }) });
    await visit(page, '/labs/pro-after');
    await expect(page.locator('.lab-prereq-section .lab-prereqs li')).toContainText('A free start');
  });

  test('is told so, in the same sentence, when a start is refused all the same', async ({ page }) => {
    // The catalogue did not say which plan this is (an older Worker): Start is there, and the service says no.
    const s = await stub(page, { labs: catalogue(), startStatus: 403 });
    await visit(page, MODULE_1);
    await expect(row(page, 'pro-open').locator('.lab-lock')).toHaveCount(0);
    await row(page, 'pro-open').locator('.lab-start').click();
    await expect(page.locator('#launchError')).toHaveText(`Could not start this lab. ${LONG}`);
    expect(s.starts).toEqual(['pro-open']);
  });
});

test.describe('nobody else is held back', () => {
  test('a learner on the Pro plan sees every lab open', async ({ page }) => {
    await stub(page, { labs: catalogue({ plan: 'pro' }) });
    await visit(page, MODULE_1);
    await expect(page.locator('.lab-plan-locked')).toHaveCount(0);
    await expect(page.locator('.unlock-link')).toHaveCount(0);
    await expect(row(page, 'pro-open').locator('.lab-start')).toBeEnabled();
  });

  test('the owner\'s subject (bypass) sees them open, whatever the plan says', async ({ page }) => {
    await stub(page, { labs: catalogue({ plan: 'free', bypass: true }), me: { can_admin: true } });
    await visit(page, MODULE_1);
    await expect(page.locator('.lab-plan-locked')).toHaveCount(0);
    await expect(page.locator('.unlock-link')).toHaveCount(0);
    await expect(row(page, 'pro-open').locator('.lab-start')).toBeEnabled();
    await expect(row(page, 'pro-open').locator('.lab-state')).toHaveText('Not started');
  });

  test('the developer view opens a plan-locked lab and says it is locked for learners', async ({ page }) => {
    // No `bypass` in this answer: the plan lock is drawn, and the owner's view opens it as it does any lock.
    const s = await stub(page, { labs: catalogue({ plan: 'free' }), me: { can_admin: true, admin_url: 'https://admin.example' } });
    await visit(page, MODULE_1, { adminOn: true });
    const pro = row(page, 'pro-open');
    await expect(pro.locator('.lab-lock')).toHaveText('Locked for learners — open anyway (admin)');
    await expect(pro.locator('.unlock-link')).toHaveCount(0);
    const start = pro.locator('.lab-start');
    await expect(start).toBeEnabled();
    await expect(start).toHaveText('Start');
    await start.click();
    await expect.poll(() => s.starts).toEqual(['pro-open']);
  });
});
