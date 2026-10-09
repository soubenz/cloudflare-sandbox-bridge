import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { serveConsole } from './console-server';
import { MODULE_PAGE } from './browse';
import { GAMES, warmUpBundleOf } from './comic-fixture';

/**
 * A warm-up: a lab with no container, only its learn bundle.
 *
 *   Open  ->  story  ->  questions  ->  lessons  ->  one game a step  ->  the closing story  ->  Finish the warm-up
 *
 * What is pinned here:
 *   - its card says Open (not Start) and carries the "Start here" chip;
 *   - Open runs the whole flow, whatever the screen size and whether it was seen before: there is no
 *     "Skip all", nothing is prepared and no session is started;
 *   - a game's Continue comes on once it is solved, the addresses are /games (?step=N for a later one) and
 *     /closing, and a refresh keeps the games already solved;
 *   - "Finish the warm-up" POSTs /api/warmups/<slug>/complete once, with every game and its tries, then lands on
 *     the lab's page, which says Done, with "Warm-up done. Next: <title>"; a failed POST keeps the learner on the
 *     last step to try again.
 *
 * Like 16 to 25 this needs no password, no API and no container: a static server serves dashboard/public and
 * every call the console makes is answered by a route stub. Run `npm run build:dashboard` first.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC = join(ROOT, 'dashboard/public');
const WIDE = { width: 1440, height: 900 };

const WARM = 'meet-the-platform-team';
const WARM_TITLE = 'Meet the platform team';
const NEXT = 'see-what-a-gateway-does';
const NEXT_TITLE = 'See what a gateway does';
const BUNDLE = warmUpBundleOf();
const QUESTION = BUNDLE.questions[0] as { id: string; answer: string[] };
const PASSED = { attempts: 1, best_score: 1, passed_all: true, last_run_at: 1 };

/** The catalogue: the warm-up first (free, no family, no time limit), then an ordinary lab. */
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
  /** The bodies POST /api/warmups/<slug>/complete carried, in order. */
  completes: Array<Record<string, any>>;
  /** The statuses the next completes answer with (then 200). */
  failNext: number[];
  /** Set once a complete has succeeded: the catalogue then says the warm-up is passed. */
  done: boolean;
  starts: string[];
  prepares: string[];
  errors: string[];
}

async function stub(page: Page): Promise<Stub> {
  const s: Stub = { completes: [], failNext: [], done: false, starts: [], prepares: [], errors: [] };
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === '/api/me') return json(route, { sub: 'console', user_id: 'console' });
    if (path === '/api/labs') return json(route, labs(s.done));
    if (path === '/api/onboarding') return json(route, { error: { code: 'no_onboarding', message: 'none' } }, 404);
    if (path === '/api/learn/answers' && method === 'POST') return json(route, { ok: true, recorded: 1 }, 201);
    if (path === `/api/learn/${WARM}` && method === 'GET') return json(route, { slug: WARM, version: '1.0.0', learn: BUNDLE });
    if (path === `/api/warmups/${WARM}/complete` && method === 'POST') {
      s.completes.push(JSON.parse(route.request().postData() ?? '{}'));
      const fail = s.failNext.shift();
      if (fail) return json(route, { error: { code: 'internal', message: 'Something went wrong.' } }, fail);
      s.done = true;
      return json(route, { done: true });
    }
    if (path === '/api/prepare' && method === 'POST') {
      s.prepares.push(JSON.parse(route.request().postData() ?? '{}').lab);
      return json(route, { prepared: true }, 202);
    }
    if (path === '/api/start' && method === 'POST') {
      s.starts.push(JSON.parse(route.request().postData() ?? '{}').lab);
      return json(route, { error: { code: 'not_startable', message: 'A warm-up has nothing to start.' } }, 400);
    }
    return json(route, { error: { code: 'not_found', message: 'not stubbed' } }, 404);
  });
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

async function open(page: Page, url = MODULE_PAGE) {
  await page.addInitScript(() => {
    localStorage.setItem('opalixOnboarded', '1');
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('opalixLearn', JSON.stringify({ v: 1, onboarding: { status: 'skipped', at: 1, levels: {} } }));
      sessionStorage.setItem('seeded', '1');
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
}

const host = (page: Page) => page.locator('#learnHost');
/** The step's own heading (a flag or sliders game holds a question screen with a hidden one of its own). */
const heading = (page: Page) => host(page).locator('.learn-head [data-learn-heading]').first();
const card = (page: Page) => page.locator(`.lab[data-slug="${WARM}"]`);
const gameNext = (page: Page) => page.locator('#btnGameNext');
const check = (page: Page) => host(page).locator('.game button', { hasText: /^Check$/ });

/** Plays the game on screen to the right answer, first time. */
async function solve(page: Page, game: (typeof GAMES)[number]) {
  const g = game as any;
  await expect(host(page).locator(`.game[data-game="${g.id}"]`)).toBeVisible();
  if (g.kind === 'sort') {
    for (const c of g.cards) {
      const label = g.buckets.find((b: any) => b.id === c.bucket).label;
      await host(page).locator(`.game-card[data-card="${c.id}"] .game-bucket`, { hasText: label }).click();
    }
    await check(page).click();
  } else if (g.kind === 'flag') {
    for (const i of g.items.filter((x: any) => x.flag)) await host(page).locator(`.game .quiz-option[data-option="${i.id}"] input`).check();
    await check(page).click();
  } else if (g.kind === 'sliders') {
    await host(page).locator(`.game .quiz-option[data-option="${g.ask.answer}"] input`).check();
    await check(page).click();
  } else {
    // The rows start shuffled: move each into place with Up, then indent the children.
    const target = ['gw', 'alias', 'provider'];
    for (let i = 0; i < target.length; i++) {
      for (let guard = 0; guard < target.length; guard++) {
        const order = await host(page).locator('.game-outline .game-row').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
        if (order.indexOf(target[i]) <= i) break;
        await host(page).locator(`.game-row[data-id="${target[i]}"] [data-action="up"]`).click();
      }
    }
    for (const id of ['alias', 'provider']) await host(page).locator(`.game-row[data-id="${id}"] [data-action="indent"]`).click();
    await check(page).click();
  }
  await expect(host(page).locator('.game-status')).toContainText('Solved');
}

/** From the card's Open to the first game, through the story, the question and the lessons. */
async function toTheGames(page: Page) {
  await card(page).locator('.lab-start').click();
  await expect(heading(page)).toHaveText(BUNDLE.story!.title);
  await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/story$`));
  await expect(host(page).locator('.learn-eyebrow').first()).toContainText(`Warm-up · ${WARM_TITLE}`);
  // A warm-up has nothing to start, so nothing to skip to.
  await expect(page.locator('#btnSkipAll')).toHaveCount(0);
  await page.locator('#btnStoryNext').click();

  await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/questions$`));
  for (const id of QUESTION.answer) await page.locator(`.quiz-option[data-option="${id}"] input`).check();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.locator('#btnSkipAll')).toHaveCount(0);
  await page.locator('.quiz-form .learn-actions button', { hasText: 'See the lessons' }).click();

  await expect(heading(page)).toHaveText('Lessons for this lab');
  await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/lessons$`));
  await expect(page.locator('#btnNextStep')).toHaveText('Continue');
  await page.locator('#btnNextStep').click();
}

// ---------------------------------------------------------------------- tests

test.describe('a warm-up', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(WIDE);
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('its card says Open and "Start here"', async ({ page }) => {
    await stub(page);
    await open(page);
    await expect(card(page).locator('.lab-start')).toHaveText('Open');
    await expect(card(page).locator('.chip-start')).toHaveText('Start here');
    await expect(card(page).locator('.chip-type')).toHaveText('Warm-up');
  });

  test('runs story, questions, lessons, every game and the closing story, and Finish records it once and lands on Done', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await toTheGames(page);

    // One game a step: /games for the first, ?step=N for the others (story 1, round 2, lessons 3, games 4 to 7).
    for (const [k, game] of GAMES.entries()) {
      await expect(heading(page)).toHaveText(`Game ${k + 1} of ${GAMES.length}`);
      await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/games${k === 0 ? '' : `\\?step=${4 + k}`}$`));
      await expect(gameNext(page)).toBeDisabled();
      await expect(gameNext(page)).toHaveText('Continue');
      await solve(page, game);
      await expect(gameNext(page)).toBeEnabled();
      await gameNext(page).click();
    }

    // The closing story, last: its button finishes the warm-up.
    await expect(heading(page)).toHaveText(BUNDLE.closing!.story.title);
    await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/closing$`));
    const finish = page.locator('#btnStoryNext');
    await expect(finish).toHaveText('Finish the warm-up');
    await expect(page.locator('#btnSkipAll')).toHaveCount(0);
    await finish.click();

    // The lab's page, which now says Done, and the next lab named.
    await expect(page).toHaveURL(new RegExp(`/labs/${WARM}$`));
    await expect(page.locator('#learnScreen')).toBeHidden();
    await expect(page.locator(`.lab-detail[data-slug="${WARM}"] .chip-done`)).toContainText('Done');
    await expect(page.locator('#toastText')).toHaveText(`Warm-up done. Next: ${NEXT_TITLE}`);

    expect(s.completes).toHaveLength(1);
    const body = s.completes[0]!;
    expect(Object.keys(body).sort()).toEqual(['games', 'started_at']);
    expect(typeof body.started_at).toBe('number');
    expect(body.started_at).toBeLessThanOrEqual(Date.now());
    expect(body.games).toEqual(GAMES.map((g) => ({ id: g.id, solved: true, tries: 1 })));
    // Nothing was started or warmed: a warm-up has no container.
    expect(s.starts).toEqual([]);
    expect(s.prepares).toEqual([]);

    // Its card, on the module's page, says Done too.
    await page.goto(MODULE_PAGE);
    await page.waitForSelector('body[data-booted="1"]');
    await expect(card(page).locator('.chip-done')).toContainText('Done');
    await expect(card(page).locator('.lab-start')).toHaveText('Open again');
    expect(s.completes).toHaveLength(1);
    expect(s.errors).toEqual([]);
  });

  test('a failed POST keeps the learner on the last step, and Finish tries again', async ({ page }) => {
    const s = await stub(page);
    s.failNext.push(500);
    await open(page);
    await toTheGames(page);
    for (const game of GAMES) {
      await solve(page, game);
      await gameNext(page).click();
    }
    const finish = page.locator('#btnStoryNext');
    await finish.click();
    await expect(page.locator('#toast')).toHaveAttribute('data-tone', 'bad');
    await expect(page.locator('#toastText')).toContainText('Could not finish the warm-up');
    await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/closing$`));
    await expect(finish).toBeEnabled();
    await expect(finish).toHaveText('Finish the warm-up');
    expect(s.completes).toHaveLength(1);

    await finish.click();
    await expect(page).toHaveURL(new RegExp(`/labs/${WARM}$`));
    await expect(page.locator(`.lab-detail[data-slug="${WARM}"] .chip-done`)).toContainText('Done');
    expect(s.completes).toHaveLength(2);
    expect(s.completes[1]).toEqual(s.completes[0]);
  });

  test('a refresh on a later game keeps the games already solved', async ({ page }) => {
    await stub(page);
    await open(page);
    await toTheGames(page);
    await solve(page, GAMES[0]!);
    await gameNext(page).click();
    await expect(heading(page)).toHaveText(`Game 2 of ${GAMES.length}`);

    await page.reload();
    await page.waitForSelector('body[data-booted="1"]');
    await expect(heading(page)).toHaveText(`Game 2 of ${GAMES.length}`);
    await expect(gameNext(page)).toBeDisabled();
    await page.locator('#btnBackGame').click();
    await expect(heading(page)).toHaveText(`Game 1 of ${GAMES.length}`);
    await expect(gameNext(page)).toBeEnabled();
    await expect(host(page).locator('.game-solved-note')).toContainText('You solved this one in 1 try');
  });

  test('opens on a phone-sized screen too: there is nothing to run', async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await card(page).locator('.lab-start').click();
    await expect(heading(page)).toHaveText(BUNDLE.story!.title);
    await expect(page.locator('#desktopNotice')).toBeHidden();
  });
});
