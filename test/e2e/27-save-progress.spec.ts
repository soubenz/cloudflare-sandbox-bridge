import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { serveConsole } from './console-server';
import { MODULE_PAGE } from './browse';
import { GAMES, warmUpBundleOf } from './comic-fixture';

/**
 * Saving progress (docs/learning-content.md, "Saving progress"): the learner's place in a warm-up is saved on
 * the server as they go, so a fresh browser (a new context: no sessionStorage, no localStorage) offers
 * "Continue where you left off" on the lab's page and on Open, and Continue lands on the saved step.
 *
 * Like 16 to 26 this needs no password, no API and no container: a static server serves dashboard/public and
 * every call is answered by a route stub, which here also keeps the one saved place (GET, PUT, DELETE
 * /api/learn-progress/<slug>) across browser contexts. Run `npm run build:dashboard` first.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(resolve(here, '../..'), 'dashboard/public');
const WIDE = { width: 1440, height: 900 };

const WARM = 'meet-the-platform-team';
const WARM_TITLE = 'Meet the platform team';
const BUNDLE = warmUpBundleOf();
const QUESTION = BUNDLE.questions[0] as { id: string; answer: string[] };
/** story 1, round 2, lessons 3, closing 4, then one step per game. */
const TOTAL = 4 + GAMES.length;

const LABS = [
  {
    slug: WARM,
    version: '1.0.0',
    title: WARM_TITLE,
    type: 'warm-up',
    summary: 'Meet the people you will work with.',
    objectives: ['meet the team'],
    difficulty: 'intro',
    estimated_minutes: 10,
    tier: 'free',
    path: 'ai-platform',
    module: 1,
    order: 1,
    has_learn: true,
    progress: null,
  },
];

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** The server's side: the one saved place, and what was sent to it. */
interface Server {
  saved: { version: string; state: Record<string, any> } | null;
  puts: Array<{ version: string; state: Record<string, any> }>;
  deletes: number;
}

async function stub(context: BrowserContext, server: Server) {
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === '/api/me') return json(route, { sub: 'console', user_id: 'console' });
    if (path === '/api/labs') return json(route, LABS);
    if (path === '/api/onboarding') return json(route, { error: { code: 'no_onboarding', message: 'none' } }, 404);
    if (path === '/api/learn/answers') return json(route, { ok: true, recorded: 1 }, 201);
    if (path === `/api/learn/${WARM}`) return json(route, { slug: WARM, version: '1.0.0', learn: BUNDLE });
    if (path === `/api/learn-progress/${WARM}`) {
      if (method === 'GET') return json(route, { user_id: 'console', slug: WARM, progress: server.saved ? { ...server.saved, updated_at: 1 } : null });
      if (method === 'PUT') {
        const body = JSON.parse(route.request().postData() ?? '{}');
        server.puts.push(body);
        server.saved = body;
        return json(route, { saved: true, updated_at: 1 });
      }
      if (method === 'DELETE') {
        server.deletes++;
        const had = server.saved !== null;
        server.saved = null;
        return json(route, { deleted: had });
      }
    }
    return json(route, { error: { code: 'not_found', message: 'not stubbed' } }, 404);
  });
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

/** A fresh browser: its own storage, the onboarding quiz already behind it. */
async function freshBrowser(browser: import('@playwright/test').Browser, baseURL: string, server: Server): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL, viewport: WIDE, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    (window as unknown as { __opalixGameTest: boolean }).__opalixGameTest = true;
    localStorage.setItem('opalixOnboarded', '1');
    if (!localStorage.getItem('opalixLearn')) localStorage.setItem('opalixLearn', JSON.stringify({ v: 1, onboarding: { status: 'skipped', at: 1, levels: {} } }));
  });
  await stub(context, server);
  const page = await context.newPage();
  return { context, page };
}

async function go(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
}

const heading = (page: Page) => page.locator('#learnHost .learn-head [data-learn-heading]').first();
/** The lessons step is on screen: it has no title of its own, its heading is the title of the lesson on screen. */
async function onLessons(page: Page) {
  await expect(page.locator('#learnHost .learn-lessons')).toHaveAttribute('aria-label', 'Lessons');
  await expect(page.locator('#learnHost [data-learn-heading]')).toHaveClass(/lesson-title/);
}

test.describe('saving progress', () => {
  test('a warm-up left on its lessons is offered again in a fresh browser, and Continue lands on them', async ({ browser, baseURL }) => {
    const server: Server = { saved: null, puts: [], deletes: 0 };

    // Browser one: the story, the question, then the lessons; then the browser is closed.
    const one = await freshBrowser(browser, baseURL!, server);
    await go(one.page, MODULE_PAGE);
    await one.page.locator(`.lab[data-slug="${WARM}"] .lab-start`).click();
    await expect(heading(one.page)).toHaveText(BUNDLE.story!.title);
    // Nothing worth coming back to yet: nothing saved.
    expect(server.puts).toHaveLength(0);
    await one.page.locator('#btnStoryNext').click();
    await expect(one.page).toHaveURL(new RegExp(`/labs/${WARM}/questions$`));
    for (const id of QUESTION.answer) await one.page.locator(`.quiz-option[data-option="${id}"] input`).check();
    await one.page.getByRole('button', { name: 'Check', exact: true }).click();
    await one.page.locator('.quiz-form .learn-actions button', { hasText: 'See the lessons' }).click();
    await onLessons(one.page);
    await expect.poll(() => server.saved?.state.at).toBe(2);
    expect(server.saved!.version).toBe('1.0.0');
    expect(Object.keys(server.saved!.state.answers)).toEqual([QUESTION.id]);
    await one.context.close();

    // Browser two: the lab's page says where they left off.
    const two = await freshBrowser(browser, baseURL!, server);
    await go(two.page, `/labs/${WARM}`);
    const side = two.page.locator(`.lab-detail[data-slug="${WARM}"] .lab-progress`);
    await expect(side).toBeVisible();
    await expect(side).toContainText(`You left off at Step 3 of ${TOTAL}: Lessons.`);
    await two.page.locator('#btnLabContinue').click();
    await onLessons(two.page);
    await expect(two.page).toHaveURL(new RegExp(`/labs/${WARM}/lessons$`));
    // The answer came along: Back to the questions shows it answered, nothing asked again.
    await two.page.locator('#btnBackQuestions').click();
    await expect(two.page.locator('.quiz-form .learn-actions button', { hasText: 'See the lessons' })).toBeVisible();
    await two.context.close();
  });

  test('Open offers Continue or Start over; Start over forgets the place and starts at the story', async ({ browser, baseURL }) => {
    const server: Server = { saved: null, puts: [], deletes: 0 };
    // A place saved by another browser, one step in.
    const one = await freshBrowser(browser, baseURL!, server);
    await go(one.page, MODULE_PAGE);
    await one.page.locator(`.lab[data-slug="${WARM}"] .lab-start`).click();
    await one.page.locator('#btnStoryNext').click();
    await expect.poll(() => server.saved?.state.at).toBe(1);
    await one.context.close();

    const two = await freshBrowser(browser, baseURL!, server);
    await go(two.page, MODULE_PAGE);
    await two.page.locator(`.lab[data-slug="${WARM}"] .lab-start`).click();
    await expect(heading(two.page)).toHaveText('Welcome back');
    await expect(two.page.locator('#learnHost')).toContainText(`You left off at Step 2 of ${TOTAL}: Questions.`);
    await expect(two.page.locator('#btnContinueFlow')).toBeVisible();
    await two.page.locator('#btnStartOver').click();
    await expect(heading(two.page)).toHaveText(BUNDLE.story!.title);
    await expect.poll(() => server.deletes).toBe(1);
    expect(server.saved).toBeNull();
    await two.context.close();
  });

  test('a place saved against another version of the warm-up is not offered', async ({ browser, baseURL }) => {
    const server: Server = { saved: null, puts: [], deletes: 0 };
    const one = await freshBrowser(browser, baseURL!, server);
    await go(one.page, MODULE_PAGE);
    await one.page.locator(`.lab[data-slug="${WARM}"] .lab-start`).click();
    await one.page.locator('#btnStoryNext').click();
    await expect.poll(() => server.saved?.state.at).toBe(1);
    await one.context.close();
    server.saved = { ...server.saved!, version: '0.9.0' };

    const two = await freshBrowser(browser, baseURL!, server);
    await go(two.page, `/labs/${WARM}`);
    await expect(two.page.locator(`.lab-detail[data-slug="${WARM}"] .lab-start`)).toBeVisible();
    await expect(two.page.locator('.lab-progress')).toBeHidden();
    await two.page.locator(`.lab-detail[data-slug="${WARM}"] .lab-start`).click();
    await expect(heading(two.page)).toHaveText(BUNDLE.story!.title);
    await expect.poll(() => server.deletes).toBe(1);
    await two.context.close();
  });
});
