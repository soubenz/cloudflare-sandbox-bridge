import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { serveConsole } from './console-server';
import { MODULE_PAGE } from './browse';
import { warmUpBundleOf } from './comic-fixture';

/**
 * The way on from a finished lab.
 *
 * What is pinned here:
 *   - "Finish the warm-up" ends on the warm-up's own last screen, at /labs/<slug>/done: "Warm-up done", one line on
 *     the games, a big "Next: <the next lab> →" (the launcher's next lab) and "Back to labs"; Next opens the next
 *     lab's page; a refresh of /done shows it again, and /done for a warm-up not done yet is the lab's page;
 *   - a finished lab's page leads with "Next: <title> →", "Open again" under it;
 *   - it never shows "You left off …" with Continue and Start over: progress left over from opening it again is
 *     deleted without a word, and a second run under way is one quiet "Continue your second run";
 *   - opening a finished warm-up again and leaving it on its first step saves nothing (even with lessons read
 *     before, which the lessons pager remembers in this browser).
 *
 * Like 16 to 27 this needs no password, no API and no container: a static server serves dashboard/public and
 * every call is answered by a route stub. Run `npm run build:dashboard` first. SHOTS=<dir> also saves screenshots.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(resolve(here, '../..'), 'dashboard/public');
const WIDE = { width: 1440, height: 900 };
const SHOTS = process.env.SHOTS ?? '';

const WARM = 'meet-the-platform-team';
const WARM_TITLE = 'Meet the platform team';
const NEXT = 'see-what-a-gateway-does';
const NEXT_TITLE = 'See what a gateway does';
const BUNDLE = warmUpBundleOf();
const QUESTION = BUNDLE.questions[0] as { id: string; answer: string[] };
/** When the warm-up was done (the catalogue's `last_run_at`, ms). */
const DONE_AT = 1_000_000;
const PASSED = { attempts: 1, best_score: 1, passed_all: true, last_run_at: DONE_AT };

const labs = (warmDone: boolean) => [
  {
    slug: WARM,
    version: '1.0.0',
    title: WARM_TITLE,
    type: 'warm-up',
    summary: 'Meet the people you will work with, and play a few games before your first lab.',
    objectives: ['meet the team'],
    difficulty: 'intro',
    estimated_minutes: 10,
    tier: 'free',
    path: 'ai-platform',
    module: 1,
    order: 1,
    has_learn: true,
    progress: warmDone ? PASSED : null,
  },
  {
    slug: NEXT,
    version: '1.0.0',
    title: NEXT_TITLE,
    type: 'explore',
    family: 'gateway',
    summary: 'The first lab.',
    objectives: ['send a call'],
    difficulty: 'intro',
    timeout_minutes: 30,
    estimated_minutes: 20,
    tier: 'free',
    path: 'ai-platform',
    module: 1,
    order: 2,
    has_learn: false,
    progress: null,
  },
];

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

type Saved = { version: string; state: Record<string, any>; updated_at: number } | null;
interface Stub {
  done: boolean;
  completes: number;
  saved: Saved;
  puts: Array<{ version: string; state: Record<string, any> }>;
  deletes: number;
  errors: string[];
}

async function stub(page: Page, o: Partial<Stub> = {}): Promise<Stub> {
  const s: Stub = { done: false, completes: 0, saved: null, puts: [], deletes: 0, errors: [], ...o };
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === '/api/me') return json(route, { sub: 'console', user_id: 'console' });
    if (path === '/api/labs') return json(route, labs(s.done));
    if (path === '/api/onboarding') return json(route, { error: { code: 'no_onboarding', message: 'none' } }, 404);
    if (path === '/api/learn/answers') return json(route, { ok: true, recorded: 1 }, 201);
    if (path === `/api/learn/${WARM}`) return json(route, { slug: WARM, version: '1.0.0', learn: BUNDLE });
    if (path === `/api/warmups/${WARM}/complete` && method === 'POST') {
      s.completes++;
      s.done = true;
      s.saved = null;
      return json(route, { done: true });
    }
    if (path === `/api/learn-progress/${WARM}`) {
      if (method === 'GET') return json(route, { user_id: 'console', slug: WARM, progress: s.saved });
      if (method === 'PUT') {
        const body = JSON.parse(route.request().postData() ?? '{}');
        s.puts.push(body);
        s.saved = { ...body, updated_at: DONE_AT + 5000 };
        return json(route, { saved: true, updated_at: DONE_AT + 5000 });
      }
      if (method === 'DELETE') {
        s.deletes++;
        s.saved = null;
        return json(route, { deleted: true });
      }
    }
    return json(route, { error: { code: 'not_found', message: 'not stubbed' } }, 404);
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

/** `lessons`: what the lessons pager remembers of the warm-up in this browser (lessons read on an earlier visit). */
async function open(page: Page, url: string, { lessons = false } = {}) {
  await page.addInitScript(
    ({ slug, lessons }) => {
      (window as unknown as { __opalixGameTest: boolean }).__opalixGameTest = true;
      localStorage.setItem('opalixOnboarded', '1');
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('opalixLearn', JSON.stringify({ v: 1, onboarding: { status: 'skipped', at: 1, levels: {} } }));
        if (lessons) localStorage.setItem('opalix.lessonPages', JSON.stringify({ [slug]: { at: 0, pages: [], read: ['gateway.alias'] } }));
        sessionStorage.setItem('seeded', '1');
      }
    },
    { slug: WARM, lessons }
  );
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
}

const host = (page: Page) => page.locator('#learnHost');
const heading = (page: Page) => host(page).locator('.learn-head [data-learn-heading]').first();
const side = (page: Page, slug = WARM) => page.locator(`.lab-detail[data-slug="${slug}"] .lab-detail-side`);

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** From the module page's Open to the first game, then "Skip all games": the warm-up is finished. */
async function finishWarmUp(page: Page) {
  await page.locator(`.lab[data-slug="${WARM}"] .lab-start`).click();
  await expect(heading(page)).toHaveText(BUNDLE.story!.title);
  await page.locator('#btnStoryNext').click();
  for (const id of QUESTION.answer) await page.locator(`.quiz-option[data-option="${id}"] input`).check();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await page.locator('.quiz-form .learn-actions button', { hasText: 'See the lessons' }).click();
  // The lessons (their look is the lessons step's own business): on past them.
  await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/lessons$`));
  await page.getByRole('group', { name: 'Lesson pages' }).getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(heading(page)).toHaveText(BUNDLE.closing!.story.title);
  await page.locator('#btnStoryNext').click();
  await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/games$`));
  await page.locator('#btnSkipAllGames').click();
}

test.describe('the way on from a finished lab', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(WIDE);
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('finishing a warm-up shows "Warm-up done" with Next to the next lab, at /done', async ({ page }) => {
    const s = await stub(page);
    await open(page, MODULE_PAGE);
    await finishWarmUp(page);

    // The warm-up's own last screen, in place of the last game's address: no jump to the lab's page.
    await expect(heading(page)).toHaveText('Warm-up done');
    await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/done$`));
    await expect(page.locator('#learnScreen')).toBeVisible();
    await expect(heading(page)).toBeFocused();
    await expect(host(page).locator('.learn-eyebrow').first()).toHaveText(`Warm-up · ${WARM_TITLE}`);
    // Every game was skipped: the line just says it is finished.
    await expect(host(page).locator('.learn-done .learn-head')).toContainText('You finished the warm-up.');
    const next = page.locator('#btnDoneNext');
    await expect(next).toHaveText(`Next: ${NEXT_TITLE}`);
    await expect(next).toHaveAttribute('href', `/labs/${NEXT}`);
    await expect(page.getByRole('link', { name: `Next: ${NEXT_TITLE}` })).toBeVisible();
    await expect(page.locator('#btnDoneBack')).toHaveText('Back to labs');
    await expect(page.locator('#btnDoneBack')).toHaveAttribute('href', MODULE_PAGE);
    expect(await page.title()).toBe(`Done · ${WARM_TITLE} · Opalix labs`);
    expect(s.completes).toBe(1);
    await shot(page, 'warm-up-done');

    // A refresh keeps the screen (the warm-up is done on the server).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(heading(page)).toHaveText('Warm-up done');
    await expect(page.locator('#btnDoneNext')).toHaveText(`Next: ${NEXT_TITLE}`);

    // Next opens the next lab's page.
    await page.locator('#btnDoneNext').click();
    await expect(page).toHaveURL(new RegExp(`/labs/${NEXT}$`));
    await expect(page.locator('.lab-detail-title')).toHaveText(NEXT_TITLE);
    expect(s.errors).toEqual([]);
  });

  test('/done for a warm-up that is not done is the lab\'s page', async ({ page }) => {
    const s = await stub(page);
    await open(page, `/labs/${WARM}/done`);
    await expect(page).toHaveURL(new RegExp(`/labs/${WARM}$`));
    await expect(page.locator('.lab-detail-title')).toHaveText(WARM_TITLE);
    await expect(page.locator('#btnLabNext')).toBeHidden();
    expect(s.errors).toEqual([]);
  });

  test('a done lab\'s page leads with Next, then Open again, and shows no "You left off" box (left-over progress is deleted)', async ({ page }) => {
    // The case in the report: the warm-up done, then opened again, which left "Step 1 of 8" saved.
    const s = await stub(page, {
      done: true,
      saved: { version: '1.0.0', state: { v: 1, steps: [{ kind: 'story' }], at: 0, answers: {}, lessons: { read: ['gateway.alias'] }, label: 'Story' }, updated_at: DONE_AT + 60_000 },
    });
    await open(page, `/labs/${WARM}`);
    const card = side(page);
    await expect(card.locator('.chip-done')).toContainText('Done');
    const next = card.locator('#btnLabNext');
    await expect(next).toBeVisible();
    await expect(next).toHaveText(`Next: ${NEXT_TITLE}`);
    await expect(next).toHaveAttribute('href', `/labs/${NEXT}`);
    await expect(next).toHaveClass(/btn-accent/);
    const again = card.locator('.lab-start');
    await expect(again).toHaveText('Open again');
    await expect(again).not.toHaveClass(/btn-accent|btn-strong/);
    // Next comes first.
    const [a, b] = [await next.boundingBox(), await again.boundingBox()];
    expect(a!.y).toBeLessThan(b!.y);
    // No resume box, and the left-over place is gone from the server.
    await expect.poll(() => s.deletes).toBe(1);
    await expect(card.locator('.lab-progress')).toBeHidden();
    await expect(card).not.toContainText('You left off');
    await expect(page.locator('#btnLabStartOver')).toHaveCount(0);
    await shot(page, 'done-lab-page');

    await next.click();
    await expect(page.locator('.lab-detail-title')).toHaveText(NEXT_TITLE);
    expect(s.errors).toEqual([]);
  });

  test('a second run of a done warm-up, past its first step, is one quiet "Continue your second run"', async ({ page }) => {
    const steps = [{ kind: 'story' }, { kind: 'round' }, { kind: 'lessons' }];
    const s = await stub(page, { done: true, saved: { version: '1.0.0', state: { v: 1, steps, at: 2, answers: {}, label: 'Lessons' }, updated_at: DONE_AT + 60_000 } });
    await open(page, `/labs/${WARM}`);
    const card = side(page);
    await expect(card.locator('#btnLabNext')).toBeVisible();
    const again = card.locator('#btnLabContinue');
    await expect(again).toHaveText('Continue your second run');
    await expect(card).not.toContainText('You left off');
    await expect(page.locator('#btnLabStartOver')).toHaveCount(0);
    expect(s.deletes).toBe(0);
    expect(s.errors).toEqual([]);
  });

  test('opening a done warm-up again and leaving on its first step saves nothing, and its page stays clean', async ({ page }) => {
    const s = await stub(page, { done: true });
    // Lessons read on the first run are still in this browser's lessons pager.
    await open(page, `/labs/${WARM}`, { lessons: true });
    await side(page).locator('.lab-start').click();
    await expect(heading(page)).toHaveText(BUNDLE.story!.title);
    await page.waitForTimeout(1500);
    await page.locator('#btnBeforeBack').click();
    await expect(page).toHaveURL(new RegExp(`/labs/${WARM}$`));
    await expect(side(page).locator('#btnLabNext')).toBeVisible();
    await page.waitForTimeout(500);
    expect(s.puts).toEqual([]);
    await expect(side(page).locator('.lab-progress')).toBeHidden();
    expect(s.errors).toEqual([]);
  });
});
