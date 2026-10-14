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
 *   Open  ->  story  ->  questions  ->  lessons  ->  the closing story  ->  one game a step  ->  Finish the warm-up
 *
 * The closing comes before the games: it explains what they test.
 *
 * What is pinned here:
 *   - its card says Open (not Start) and carries the "Start here" chip;
 *   - Open runs the whole flow, whatever the screen size and whether it was seen before: there is no
 *     "Skip all", nothing is prepared and no session is started;
 *   - a lab has at most two games (the fixture's: a sort and an order-and-nest), each played through its game
 *     UI (Start, the cards with the keys; "what happens next" with a tap and the number keys, a step out of turn
 *     costing a heart) in test mode (`window.__opalixGameTest`: no count-in, no clock, no delays), and ends on
 *     its end screen;
 *   - a game's Continue (the last game's "Finish the warm-up") comes on once it is solved or skipped, the
 *     addresses are /closing and /games (?step=N for a later game), and a refresh keeps the games already solved;
 *   - the games only go forward: no game step has a Back to the closing story or to an earlier game;
 *   - "Skip this game" moves on, and the first game's "Skip all games" finishes the warm-up at once, the
 *     skipped games sent as { id, solved: false, skipped: true, tries: 0 };
 *   - "Finish the warm-up" POSTs /api/warmups/<slug>/complete once, with every game and its tries, then shows the
 *     warm-up's last screen at /labs/<slug>/done, "Warm-up done" with "Next: <title>" (28-done-next pins the rest);
 *     a failed POST keeps the learner on the
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
    // The games' test mode: no count-in, no clock, no delays, no sound.
    (window as unknown as { __opalixGameTest: boolean }).__opalixGameTest = true;
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
const game = (page: Page, id: string) => host(page).locator(`.game[data-game="${id}"]`);

/** The order an order-and-nest fixture's steps happen in: its tree flattened depth first, siblings by order. */
function routeOf(g: any): string[] {
  const out: string[] = [];
  const walk = (parent: string | null) => {
    for (const s of g.steps.filter((x: any) => x.parent === parent).sort((a: any, b: any) => a.order - b.order)) {
      out.push(s.id);
      walk(s.id);
    }
  };
  walk(null);
  return out;
}

/** Plays the game on screen to the right answer, first time, through its game UI, and waits for its end screen. */
async function solve(page: Page, fixture: (typeof GAMES)[number]) {
  const g = fixture as any;
  const root = game(page, g.id);
  await expect(root).toBeVisible();
  await expect(root).toHaveAttribute('data-phase', 'intro');
  await root.locator('.game-start').click();
  await expect(root).toHaveAttribute('data-phase', 'play');
  if (g.kind === 'sort' || g.kind === 'flag') {
    const deck: Array<{ id: string; answer: string }> =
      g.kind === 'sort' ? g.cards.map((c: any) => ({ id: c.id, answer: c.bucket })) : g.items.map((i: any) => ({ id: i.id, answer: i.flag ? 'flag' : 'leave' }));
    const left = g.kind === 'sort' ? g.buckets[0].id : 'leave';
    for (let n = 0; n < deck.length; n++) {
      const card = root.locator('.game-cardx');
      const id = await card.getAttribute('data-card');
      const answer = deck.find((c) => c.id === id)!.answer;
      // A sort is played with the keys (the card has the focus), a flag by tapping the sides.
      if (g.kind === 'sort') {
        await expect(card).toBeFocused();
        await page.keyboard.press(answer === left ? 'ArrowLeft' : 'ArrowRight');
      } else await root.locator(`.game-bucket[data-bucket="${answer}"]`).click();
    }
  } else if (g.kind === 'sliders') {
    await root.locator(`.game-ask-option[data-option="${g.ask.answer}"]`).click();
  } else {
    // What happens next: the first step tapped, the others picked with their number keys.
    for (const [i, id] of routeOf(g).entries()) {
      await expect(root.locator('.game-route-ask')).toHaveText(i === 0 ? 'What happens first?' : 'What happens next?');
      // The focus stays in the pool, on its first card.
      await expect(root.locator('.game-route-card').first()).toBeFocused();
      if (i === 0) await root.locator(`.game-route-card[data-id="${id}"]`).click();
      else {
        const pool = await root.locator('.game-route-card').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
        await page.keyboard.press(String(pool.indexOf(id) + 1));
      }
      if (i < g.steps.length - 1) await expect(root.locator('.game-route-slot[data-filled="true"]')).toHaveCount(i + 1);
    }
  }
  await expect(root).toHaveAttribute('data-phase', 'end');
  await expect(root.locator('.game-end-title')).toBeVisible();
  await expect(root.locator('.game-stars')).toHaveAttribute('aria-label', '3 of 3 stars');
}

/** From the card's Open to the first game, through the story, the question, the lessons and the closing story. */
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

  // The lessons step has no title of its own: the heading is the first lesson's title.
  await expect(host(page).locator('.learn-lessons')).toHaveAttribute('aria-label', 'Lessons');
  await expect(host(page).locator('[data-learn-heading]')).toHaveText(BUNDLE.concepts[0]!.title);
  await expect(host(page).locator('[data-learn-heading]')).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/lessons$`));
  await expect(page.locator('#btnNextStep')).toHaveText('Continue');
  await page.locator('#btnNextStep').click();

  // The closing story, after the lessons and before the games: Continue, and its Back goes to the lessons.
  await expect(heading(page)).toHaveText(BUNDLE.closing!.story.title);
  await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/closing$`));
  await expect(page.locator('#btnBackLessons')).toBeVisible();
  await expect(page.locator('#btnSkipAll')).toHaveCount(0);
  await expect(page.locator('#btnStoryNext')).toHaveText('Continue');
  await page.locator('#btnStoryNext').click();
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

  test('runs story, questions, lessons, the closing story and every game, and Finish records it once and lands on Done', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await toTheGames(page);

    // One game a step: /games for the first, ?step=N for the other (story 1, round 2, lessons 3, closing 4, games 5 and 6).
    // No game goes back; the last game's button finishes the warm-up.
    for (const [k, game] of GAMES.entries()) {
      const last = k === GAMES.length - 1;
      await expect(heading(page)).toHaveText(`Game ${k + 1} of ${GAMES.length}`);
      await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/games${k === 0 ? '' : `\\?step=${5 + k}`}$`));
      // The games only go forward: no Back to the closing story, nor to an earlier game; Back to labs stays.
      await expect(page.locator('#btnBackClosing')).toHaveCount(0);
      await expect(page.locator('#btnBackGame')).toHaveCount(0);
      await expect(page.locator('#btnBeforeBack')).toBeVisible();
      // Skip this game is on every game, Skip all games on the first only.
      await expect(page.locator('#btnSkipGame')).toBeVisible();
      await expect(page.locator('#btnSkipAllGames')).toHaveCount(k === 0 ? 1 : 0);
      await expect(gameNext(page)).toBeDisabled();
      await expect(gameNext(page)).toHaveText(last ? 'Finish the warm-up' : 'Continue');
      await expect(page.locator('#btnSkipAll')).toHaveCount(0);
      await solve(page, game);
      await expect(gameNext(page)).toBeEnabled();
      // The end screen's own Continue is the step's: the first game is left with it.
      if (k === 0) await host(page).locator('.game-continue').click();
      else if (!last) await gameNext(page).click();
    }
    expect(s.completes).toHaveLength(0);
    await gameNext(page).click();

    // The warm-up's last screen, and the next lab named.
    await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/done$`));
    await expect(heading(page)).toHaveText('Warm-up done');
    await expect(page.locator('#btnDoneNext')).toHaveText(`Next: ${NEXT_TITLE}`);

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
    // The last game's button was the Finish: the POST failed, and the learner is still on the last game.
    const finish = gameNext(page);
    await expect(page.locator('#toast')).toHaveAttribute('data-tone', 'bad');
    await expect(page.locator('#toastText')).toContainText('Could not finish the warm-up');
    await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/games\\?step=${4 + GAMES.length}$`));
    await expect(heading(page)).toHaveText(`Game ${GAMES.length} of ${GAMES.length}`);
    await expect(finish).toBeEnabled();
    await expect(finish).toHaveText('Finish the warm-up');
    expect(s.completes).toHaveLength(1);

    await finish.click();
    await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/done$`));
    await expect(heading(page)).toHaveText('Warm-up done');
    expect(s.completes).toHaveLength(2);
    expect(s.completes[1]).toEqual(s.completes[0]);
  });

  test('a refresh on a later game keeps the games already solved', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await toTheGames(page);
    await solve(page, GAMES[0]!);
    await gameNext(page).click();
    await expect(heading(page)).toHaveText(`Game 2 of ${GAMES.length}`);

    await page.reload();
    await page.waitForSelector('body[data-booted="1"]');
    await expect(heading(page)).toHaveText(`Game 2 of ${GAMES.length}`);
    await expect(gameNext(page)).toBeDisabled();
    await expect(page.locator('#btnBackGame')).toHaveCount(0);
    // The first game is still solved: finishing the rest sends it with its one try.
    for (const g of GAMES.slice(1)) {
      await solve(page, g);
      await gameNext(page).click();
    }
    await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/done$`));
    expect(s.completes[0]!.games).toEqual(GAMES.map((g) => ({ id: g.id, solved: true, tries: 1 })));
  });

  test('Skip all games, on the first game, finishes the warm-up at once with every game skipped', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await toTheGames(page);
    await expect(heading(page)).toHaveText(`Game 1 of ${GAMES.length}`);
    // Skipping needs no Start and asks nothing.
    await page.locator('#btnSkipAllGames').click();
    await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/done$`));
    await expect(heading(page)).toHaveText('Warm-up done');
    expect(s.completes).toHaveLength(1);
    expect(s.completes[0]!.games).toEqual(GAMES.map((g) => ({ id: g.id, solved: false, skipped: true, tries: 0 })));
    expect(s.errors).toEqual([]);
  });

  test('Skip this game moves on (during play too); a skipped game is sent as skipped beside the solved one', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await toTheGames(page);
    // Game 1 skipped before Start: game 2 is next, and it has no Skip all games.
    await page.locator('#btnSkipGame').click();
    await expect(heading(page)).toHaveText(`Game 2 of ${GAMES.length}`);
    await expect(page.locator('#btnSkipAllGames')).toHaveCount(0);
    expect(s.completes).toHaveLength(0);
    // Game 2, the last: started, a step tapped out of turn, then skipped part-way. That finishes the warm-up.
    const g = GAMES[1]! as any;
    const root = game(page, g.id);
    await root.locator('.game-start').click();
    await expect(root).toHaveAttribute('data-phase', 'play');
    const route = routeOf(g);
    await root.locator(`.game-route-card[data-id="${route[1]}"]`).click();
    await expect(root.locator('.game-lives')).toHaveAttribute('aria-label', '2 of 3 hearts left');
    const first = g.steps.find((x: any) => x.id === route[0]).text;
    await expect(root.locator('.game-bubble')).toHaveText(`Not yet. First: ${first}.`);
    await expect(root.locator('.game-route-card')).toHaveCount(route.length);
    await page.locator('#btnSkipGame').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/done$`));
    expect(s.completes[0]!.games).toEqual([
      { id: GAMES[0]!.id, solved: false, skipped: true, tries: 0 },
      { id: GAMES[1]!.id, solved: false, skipped: true, tries: 0 },
    ]);
  });

  test('a step tapped out of turn costs a heart and the host names the step that comes first; the game can still be won', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await toTheGames(page);
    await solve(page, GAMES[0]!);
    await gameNext(page).click();
    const g = GAMES[1]! as any;
    const root = game(page, g.id);
    await root.locator('.game-start').click();
    const route = routeOf(g);
    // The last step first: its own why is what the host says.
    await root.locator(`.game-route-card[data-id="${route.at(-1)}"]`).click();
    await expect(root.locator('.game-lives')).toHaveAttribute('aria-label', '2 of 3 hearts left');
    await expect(root.locator('.game-bubble')).toHaveText(`Not yet. ${g.steps.find((x: any) => x.id === route.at(-1)).why}`);
    await expect(root.locator('.game-status')).toContainText('Not yet.');
    await expect(root.locator('.game-route-card').first()).toBeFocused();
    for (const id of route) await root.locator(`.game-route-card[data-id="${id}"]`).click();
    await expect(root).toHaveAttribute('data-phase', 'end');
    await expect(root.locator('.game-stars')).toHaveAttribute('aria-label', '2 of 3 stars');
    await expect(root.locator('.game-route-answer-step')).toHaveCount(route.length);
    await gameNext(page).click();
    await expect(page).toHaveURL(new RegExp(`/labs/${WARM}/done$`));
    expect(s.completes[0]!.games).toEqual(GAMES.map((x) => ({ id: x.id, solved: true, tries: 1 })));
    expect(s.errors).toEqual([]);
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
