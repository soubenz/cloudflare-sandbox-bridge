import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { parse as parseYaml } from 'yaml';
import { serveConsole } from './console-server';
import { MODULE_PAGE, pressStart } from './browse';

/**
 * The flow before a lab starts, and what the session screen no longer has.
 *
 *   story  ->  Round 1 (up to 5 questions)  ->  lessons, part 1, FULL SCREEN  ->  Round 2  ->  lessons, part 2 ... ->  Start the lab
 *
 * (The order and its rules are unit tested in test/unit/console-learn-flow.test.ts; here they are
 * seen in a browser: the alternation, "Round n of m", the feedback, Back, refresh, deep links.)
 *
 * The lessons take the whole content area of the console (not the 360 to 520px guide pane),
 * with the text on the left and its diagram large on the right from 1280px; a lab with a story
 * but no lessons goes from the story to Start, one with lessons but no story begins at them.
 * In the session neither the Story nor the Lessons is a tab or a pane any more, for an explore
 * lab and for a build lab alike; a learner who rejoins a running lab goes straight in.
 *
 * Like 16, 17 and 18 this needs no password, no API and no container: a static server serves
 * dashboard/public (the built bundle, with the CSP from public/_headers) and every call the
 * console makes is answered by a route stub. The content is real: the learn bundle and the
 * comic are compiled from labs/see-what-a-gateway-does/learn, and the other labs of this spec
 * are that bundle with parts taken away.
 *
 * Run `npm run build:dashboard` first (the page loads dashboard/public/dist).
 * FLOW_SHOTS_DIR chooses where the screenshots go (default test/e2e/shots/flow); FLOW_SHOTS=0 skips them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC = join(ROOT, 'dashboard/public');
const API = 'https://opalix-sandbox.soubenz94.workers.dev';
const SHOTS = process.env.FLOW_SHOTS_DIR || join(here, 'shots/flow');
const SESSION_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';

// --------------------------------------------------------------- the content

interface Question {
  id: string;
  concept: string;
  type: 'single' | 'multi';
  prompt: string;
  options: Array<{ id: string; text: string }>;
  answer: string[];
  explanation: string;
  diagnostic?: boolean;
}
interface Bundle {
  story?: { title: string; minutes: number; body: string };
  comic?: { title: string; pages: Array<{ title?: string; panels: Array<Record<string, any>> }> };
  concepts: Array<{ id: string; title: string; minutes: number; recap: string; body: string }>;
  questions: Question[];
  answers_file: string;
  fields: Array<{ key: string; prompt: string; kind: string; choices?: string[]; help?: string }>;
}

/** The lab's learn/ folder as the bundle the API would serve (the CLI's compiler cannot be imported here), comic included. */
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
    .sort((a, b) => a.order - b.order) // stable, as the compiler: lower `order` first, then file name
    .map(({ order: _order, ...c }) => c);
  const quiz = parseYaml(readFileSync(join(dir, 'quiz.yaml'), 'utf8')) as { questions: Question[] };
  const qs = parseYaml(readFileSync(join(dir, 'questions.yaml'), 'utf8')) as { answers_file: string; fields: Bundle['fields'] };
  const raw = parseYaml(readFileSync(join(dir, 'comic.yaml'), 'utf8')) as { title: string; panels?: Array<Record<string, any>>; pages?: Array<{ title?: string; panels: Array<Record<string, any>> }> };
  const panelOf = (p: Record<string, any>) => ({ cast: [], prop: 'none', bubbles: [], ...p });
  return {
    story: { title: story.data.title, minutes: story.data.minutes, body: story.body },
    comic: { title: raw.title, pages: (raw.pages ?? [{ panels: raw.panels ?? [] }]).map((pg) => ({ ...(pg.title ? { title: pg.title } : {}), panels: pg.panels.map(panelOf) })) },
    concepts,
    questions: quiz.questions.map((q) => ({ diagnostic: true, ...q })),
    answers_file: qs.answers_file,
    fields: qs.fields,
  };
}

const full = compileLearn('see-what-a-gateway-does');
const DIAGNOSTIC_COUNT = full.questions.filter((q) => q.diagnostic !== false).length;
const ALIASES = 'gateway.routing-aliases';

/** An explore lab with everything: a comic, its text story, lessons, quick questions and graded fields. */
const EXPLORE = 'see-what-a-gateway-does';
/** A build lab: the comic, the story and the lessons, but no quick questions and no graded fields. */
const BUILD = 'put-a-hard-budget-on-every-team';
/** A story (and its comic), and no lessons. */
const STORY_ONLY = 'a-story-and-no-lessons';
/** A text story (no comic) and lessons, no questions. */
const TEXT_STORY = 'a-text-story-and-lessons';
/** Lessons and no story. */
const LESSONS_ONLY = 'lessons-and-no-story';
/** Lessons and no story, with quick questions. */
const LESSONS_ASKING = 'lessons-and-no-story-with-questions';
/** A story, the lessons and four questions: one round, then all the lessons as one chunk. */
const FEW_QUESTIONS = 'a-lab-with-four-questions';
const PLAIN = 'a-lab-with-nothing-to-read';

const BUNDLES: Record<string, Bundle> = {
  [FEW_QUESTIONS]: { ...full, comic: undefined, questions: full.questions.filter((q) => q.diagnostic !== false).slice(0, 4), fields: [] },
  [EXPLORE]: full,
  [BUILD]: { ...full, questions: [], fields: [] },
  [STORY_ONLY]: { story: full.story, comic: full.comic, concepts: [], questions: [], answers_file: full.answers_file, fields: [] },
  [TEXT_STORY]: { ...full, comic: undefined, questions: [], fields: [] },
  [LESSONS_ONLY]: { ...full, story: undefined, comic: undefined, questions: [], fields: [] },
  [LESSONS_ASKING]: { ...full, story: undefined, comic: undefined, fields: [] },
};

const lab = (o: Record<string, unknown>) => ({
  version: '1.0.0',
  type: 'explore',
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
  lab({ slug: EXPLORE, title: 'See what a gateway does', order: 1 }),
  lab({ slug: BUILD, title: 'Put a hard budget on every team', type: 'build', order: 2 }),
  lab({ slug: STORY_ONLY, title: 'A story and no lessons', order: 3 }),
  lab({ slug: TEXT_STORY, title: 'A text story and lessons', order: 4 }),
  lab({ slug: LESSONS_ONLY, title: 'Lessons and no story', order: 5 }),
  lab({ slug: LESSONS_ASKING, title: 'Lessons and no story, with questions', order: 6 }),
  lab({ slug: PLAIN, title: 'A lab with nothing to read', order: 7, has_learn: false }),
  lab({ slug: FEW_QUESTIONS, title: 'A lab with four questions', order: 8 }),
];

// ------------------------------------------------------------- a fake console

const json = (route: Route, body: unknown, status = 200, extra: Record<string, string> = {}) => {
  const origin = route.request().headers()['origin'];
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { ...(origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {}), ...extra },
    body: JSON.stringify(body),
  });
};

interface Stub {
  starts: string[];
  /** The labs POST /api/prepare was asked to warm up, in order. */
  prepares: string[];
  /** The bodies POST /api/prepare/cancel carried (a beacon included). */
  cancels: Array<Record<string, any>>;
  /** The status POST /api/prepare answers (the API refusing, say); 202 by default. */
  prepareStatus: number;
  posted: Array<Record<string, any>>;
  learnFetches: string[];
  errors: string[];
}

/** `lab` is the lab a session that was not started through /api/start reports (a rejoined one). */
async function stub(page: Page, { lab: rejoined = EXPLORE }: { lab?: string } = {}): Promise<Stub> {
  const waiting: Array<() => void> = [];
  const s: Stub = { starts: [], prepares: [], cancels: [], prepareStatus: 202, posted: [], learnFetches: [], errors: [] };
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) s.errors.push(msg.text());
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === '/api/me') return json(route, { sub: 'console', user_id: 'console' });
    if (path === '/api/labs') return json(route, LABS);
    if (path === '/api/onboarding') return json(route, { error: { code: 'no_onboarding', message: 'none' } }, 404);
    if (path === '/api/learn/answers' && method === 'POST') {
      s.posted.push(JSON.parse(route.request().postData() ?? '{}'));
      return json(route, { ok: true, recorded: 1 }, 201);
    }
    if (path.startsWith('/api/learn/') && method === 'GET') {
      const slug = decodeURIComponent(path.slice('/api/learn/'.length));
      s.learnFetches.push(slug);
      const b = BUNDLES[slug];
      return b ? json(route, { version: '1.0.0', learn: b }) : json(route, { error: { code: 'no_learn', message: 'no learning content' } }, 404);
    }
    if (path === '/api/prepare' && method === 'POST') {
      s.prepares.push(JSON.parse(route.request().postData() ?? '{}').lab);
      return s.prepareStatus === 202 ? json(route, { prepared: true }, 202) : json(route, { error: { code: 'x', message: 'refused' } }, s.prepareStatus);
    }
    if (path === '/api/prepare/cancel' && method === 'POST') {
      s.cancels.push(JSON.parse(route.request().postData() ?? '{}'));
      return json(route, { ok: true });
    }
    if (path === '/api/start' && method === 'POST') {
      const { lab: slug } = JSON.parse(route.request().postData() ?? '{}');
      s.starts.push(slug);
      return json(route, { id: SESSION_ID, state: 'starting', token: 'test-token', urls: { services: {} } }, 202);
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
        meta: { state: 'running', lab_slug: s.starts.at(-1) ?? rejoined, started_at: now, expires_at: now + 3_000_000, end_reason: null },
        services: {},
        snapshots: [],
        cost: { usd: 0.03 },
        hints: { total: 3, schedule: [0, 12, 30], delivered: [] },
        manifest_summary: { title: 'A lab', checks: [{ name: 'support answered by a' }] },
        checks_history: [],
        server_time: now,
      });
    }
    if (p === `${base}/events`) {
      // Held open and silent: nothing here is about events.
      await new Promise<void>((resolve) => waiting.push(resolve));
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', ...cors, 'cache-control': 'no-store' }, body: '' });
    }
    if (p === `${base}/files` && method === 'GET') return json(route, [{ name: 'brief.md', size: 30, isDirectory: false }]);
    if (p === `${base}/files/brief.md` && method === 'GET') return json(route, { content: '# The brief\n\nSend a few calls.\n' });
    if (p.startsWith(`${base}/files/`) && method === 'GET') return json(route, { error: { code: 'not_found', message: 'no such file' } }, 404);
    if (p.startsWith(base) && method !== 'GET') return json(route, {}, 200);
    return json(route, { error: 'not stubbed' }, 404);
  });

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

type Mastery = { onboarding?: { status: 'done' | 'skipped' | null; at?: number; levels?: Record<string, string> }; concepts?: Record<string, { known: boolean }>; overrides?: Record<string, string> };
const SKIPPED: Mastery = { onboarding: { status: 'skipped', at: 1, levels: {} } };

interface OpenOptions {
  theme?: 'light' | 'dark';
  mastery?: Mastery;
  /** Gives the comic its deterministic test clock. */
  comicTest?: boolean;
  /** A session this browser remembers, as it would after a reload. */
  remembered?: string;
  /** The address to open instead of the module's page (a deep link). */
  url?: string;
}

/** Opens the console on the module's page (where the labs' rows are), past the things that are other specs' business. */
async function open(page: Page, { theme, mastery = SKIPPED, comicTest = false, remembered, url }: OpenOptions = {}) {
  await page.addInitScript(
    ([t, m, r]) => {
      localStorage.setItem('opalixOnboarded', '1');
      // Seeded once, so a reload in the test keeps what the page stored since.
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('opalixLearn', m as string);
        sessionStorage.setItem('seeded', '1');
      }
      if (t) localStorage.setItem('opalixTheme', t as string);
      if (r) localStorage.setItem('opalix.session', JSON.stringify({ id: (r as { id: string }).id, token: 'test-token', lab: (r as { lab: string }).lab, urls: { services: {} } }));
    },
    [theme ?? null, JSON.stringify({ v: 1, ...mastery }), remembered ? { id: SESSION_ID, lab: remembered } : null] as const
  );
  await page.goto(url ?? (comicTest ? `${MODULE_PAGE}?comicTest=1` : MODULE_PAGE), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
}

/** Every concept of the lab already known, so no question is asked and every lesson starts folded. */
const ALL_KNOWN: Mastery = { ...SKIPPED, concepts: Object.fromEntries(full.concepts.map((c) => [c.id, { known: true }])) };

const startCard = (page: Page, slug: string) => pressStart(page, slug);
const screen = (page: Page) => page.locator('#learnScreen');
const host = (page: Page) => page.locator('#learnHost');
const heading = (page: Page) => host(page).locator('[data-learn-heading]');
const LESSONS = 'Lessons for this lab';

/** Opens the console wide, and presses Start on a lab. */
async function begin(page: Page, slug: string, size = { width: 1440, height: 900 }, opts: OpenOptions = {}) {
  const s = await stub(page);
  await page.setViewportSize(size);
  await open(page, opts);
  await startCard(page, slug);
  await expect(heading(page)).toBeVisible();
  return s;
}

/** Past the story (Continue) to the lessons step. */
async function toLessons(page: Page, slug: string, size?: { width: number; height: number }, opts: OpenOptions = {}) {
  const s = await begin(page, slug, size, opts);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(heading(page)).toHaveText(LESSONS);
  return s;
}

/** The question on screen. */
async function onScreen(page: Page): Promise<Question> {
  const prompt = (await page.locator('.quiz-prompt').innerText()).trim();
  return full.questions.find((x) => x.prompt === prompt)!;
}

/** Answers the question on screen, right or deliberately wrong, and waits for its feedback (does not move on). */
async function answerOnly(page: Page, right: (q: Question) => boolean): Promise<Question> {
  const q = await onScreen(page);
  const pick = right(q) ? q.answer : [q.options.find((o) => !q.answer.includes(o.id))!.id];
  for (const id of pick) await page.locator(`.quiz-option[data-option="${id}"] input`).check();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.locator('.quiz-feedback')).toContainText(q.explanation);
  return q;
}
const nextButton = (page: Page) => page.locator('.quiz-form .learn-actions button').filter({ hasNotText: 'Check' });

/** Answers the question on screen, then moves on. */
async function answerNext(page: Page, right: (q: Question) => boolean) {
  const q = await answerOnly(page, right);
  await nextButton(page).click();
  return q;
}

/** Answers every question of the round on screen, then moves on past it; returns the questions, in the order asked. Never use it on the last round (it would start the lab). */
async function runRound(page: Page, right: (q: Question) => boolean): Promise<Question[]> {
  const asked: Question[] = [];
  while (await page.locator('.quiz-prompt').count()) asked.push(await answerNext(page, right));
  return asked;
}
/** The old name: Round 1 is the quick questions. */
const runQuiz = runRound;

/**
 * Goes through the whole flow from wherever it is, answering with `right`, until the last step's own
 * Start the lab is on screen (the button of the last lessons, or of the last question once it is answered).
 * Returns every question asked, in order.
 */
async function toTheEnd(page: Page, right: (q: Question) => boolean = () => true): Promise<Question[]> {
  const asked: Question[] = [];
  for (let guard = 0; guard < 60; guard++) {
    if (await page.locator('.quiz-prompt').count()) {
      asked.push(await answerOnly(page, right));
      const next = nextButton(page);
      if ((await next.innerText()).trim() === 'Start the lab') return asked;
      await next.click();
    } else if (await page.locator('#btnNextStep').count()) {
      await page.locator('#btnNextStep').click();
    } else if (await page.locator('#btnStoryNext').count()) {
      await page.locator('#btnStoryNext').click();
    } else {
      return asked;
    }
  }
  throw new Error('the flow did not end');
}
/** The Start the lab of the last step: the lessons' button, or the answered last question's. */
const startButton = (page: Page) => page.locator('[data-start="primary"]');

async function enterSession(page: Page) {
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#statePill')).toHaveText('running');
  await expect(page.locator('#bootModal')).toBeHidden();
  await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
}

const tabIds = (page: Page) => page.locator('#guideTabs [role="tab"]:not([hidden])').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.guideTab));

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

/** The width the learn screen leaves a card inside it: the window minus the screen's padding (and a scrollbar, if any). */
const contentWidth = (page: Page) =>
  page.evaluate(() => {
    const el = document.getElementById('learnScreen')!;
    const cs = getComputedStyle(el);
    return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  });

const box = async (l: ReturnType<Page['locator']>) => (await l.boundingBox())!;

// =========================================================================
// the flow: story, lessons, start
// =========================================================================

test.describe('the flow before the lab', () => {
  test('story, then the lessons full screen, then the lab: the session starts only on Start the lab', async ({ page }) => {
    const s = await begin(page, BUILD);
    // 1. The story, with its comic.
    await expect(heading(page)).toHaveText(full.story!.title);
    await expect(heading(page)).toBeFocused();
    await expect(host(page).locator('.cm')).toBeVisible();
    expect(s.starts).toEqual([]);
    await page.getByRole('button', { name: 'Continue' }).click();

    // 2. The lessons, in a screen of their own: the story is gone from it, the comic is down.
    await expect(heading(page)).toHaveText(LESSONS);
    await expect(heading(page)).toBeFocused();
    await expect(host(page).locator('.cm')).toHaveCount(0);
    await expect(host(page).locator('.lesson')).toHaveCount(full.concepts.length);
    await expect(host(page).locator('.lesson[data-state="expanded"]')).toHaveCount(full.concepts.length);
    await expect(host(page).locator('.plan-summary')).toHaveText(`${full.concepts.length} lessons to read.`);
    await expect(page.locator('#workspace')).toBeHidden();
    expect(s.starts).toEqual([]);

    // 3. Start the lab: the session boots.
    await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
    await enterSession(page);
    expect(s.starts).toEqual([BUILD]);
    await expect(screen(page)).toBeHidden();
    expect(s.errors).toEqual([]);
  });

  test('the quick questions sit between the story and the lessons, and the lessons then follow the answers', async ({ page }) => {
    const s = await begin(page, EXPLORE);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toHaveText('Round 1 of 3 · question 1 of 5');
    // Round 1 is five questions, one about each concept; the aliases ones are all answered right.
    expect(await runQuiz(page, (q) => q.concept === ALIASES)).toHaveLength(5);
    await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
    await expect(page.locator(`.lesson[data-concept="${ALIASES}"]`)).toHaveAttribute('data-state', 'collapsed');
    await expect(host(page).locator('.plan-summary')).toContainText('1 folded to a recap');
    expect(s.starts).toEqual([]);
  });

  test('says each step to a screen reader, moves focus to its heading, and shows the steps as quiet dots', async ({ page }) => {
    await begin(page, TEXT_STORY);
    const live = page.locator('#learnScreen > p.sr-only[role="status"]');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveText(`Step 1 of 2: ${full.story!.title}`);
    // One dot per step and a ring for Start the lab; the first is the current one.
    await expect(host(page).locator('.steps-dots i')).toHaveCount(3);
    await expect(host(page).locator('.steps-dots i.now')).toHaveCount(1);
    await expect(host(page).locator('.steps-dots i[data-kind="story"].now')).toHaveCount(1);
    await expect(host(page).locator('.steps-dots')).toHaveAttribute('aria-hidden', 'true');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(live).toHaveText('Step 2 of 2: Lessons');
    await expect(heading(page)).toBeFocused();
    await expect(host(page).locator('.steps-dots i.done')).toHaveCount(1);
    await expect(host(page).locator('.steps-dots i[data-kind="lessons"].now')).toHaveCount(1);
    // The live region goes with the screen.
    await page.getByRole('button', { name: '← Back to labs' }).click();
    await expect(page.locator('#learnScreen > p.sr-only')).toHaveCount(0);
  });

  test('Skip on the comic ends it on the finished page, and Continue then goes to the lessons', async ({ page }) => {
    await begin(page, BUILD, { width: 1440, height: 900 }, { comicTest: true });
    await expect(host(page).locator('.cm')).toBeVisible();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(host(page).locator('.cm')).toHaveAttribute('data-state', 'done');
    // Nothing is taken away from the learner: the story stays until they say so.
    await expect(heading(page)).toHaveText(full.story!.title);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toHaveText(LESSONS);
    await expect(host(page).locator('.cm')).toHaveCount(0);
  });

  test('a learner who asked for reduced motion still sees the story (the comic starts finished) before the lessons', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await begin(page, BUILD);
    await expect(host(page).locator('.cm')).toHaveAttribute('data-state', 'done');
    await page.waitForTimeout(400);
    await expect(heading(page)).toHaveText(full.story!.title);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toHaveText(LESSONS);
    // The lessons step itself animates nothing.
    const animated = await page.evaluate(() => [...document.querySelectorAll('#learnScreen *')].filter((el) => getComputedStyle(el).animationName !== 'none').length);
    expect(animated).toBe(0);
  });

  test('a text story (no comic) ends with a plain Continue', async ({ page }) => {
    await begin(page, TEXT_STORY);
    await expect(host(page).locator('.cm')).toHaveCount(0);
    await expect(host(page).locator('.learn-prose p').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toHaveText(LESSONS);
  });

  test('a lab with a story and no lessons goes from the story straight to Start', async ({ page }) => {
    const s = await begin(page, STORY_ONLY);
    await expect(heading(page)).toHaveText(full.story!.title);
    await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
    await expect(host(page).locator('.steps-dots i')).toHaveCount(2);
    expect(s.starts).toEqual([]);
    await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
    await enterSession(page);
    expect(s.starts).toEqual([STORY_ONLY]);
    expect(await tabIds(page)).toEqual(['brief', 'checks', 'hints']);
  });

  test('a lab with lessons and no story begins at the lessons', async ({ page }) => {
    const s = await begin(page, LESSONS_ONLY);
    await expect(heading(page)).toHaveText(LESSONS);
    await expect(heading(page)).toBeFocused();
    await expect(host(page).locator('.lesson')).toHaveCount(full.concepts.length);
    await expect(host(page).locator('.steps-dots i')).toHaveCount(2);
    // No story to go back to.
    await expect(page.getByRole('button', { name: '← Back to the story' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '← Back to labs' })).toBeVisible();
    await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
    await enterSession(page);
    expect(s.starts).toEqual([LESSONS_ONLY]);
  });

  test('a lab with lessons, no story and quick questions begins at the questions, then the lessons', async ({ page }) => {
    await begin(page, LESSONS_ASKING);
    await expect(heading(page)).toHaveText('Round 1 of 3 · question 1 of 5');
    // No story: Round 1 is the first step.
    await expect(page.getByRole('button', { name: '← Back to the story' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^← (Back to the questions|Previous question)$/ })).toHaveCount(0);
    await runQuiz(page, () => false);
    await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
  });

  test('a lab with nothing to read starts as it always did', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await startCard(page, PLAIN);
    await enterSession(page);
    await expect(screen(page)).toBeHidden();
    expect(s.learnFetches).toEqual([]);
    expect(s.starts).toEqual([PLAIN]);
    expect(await tabIds(page)).toEqual(['brief', 'checks', 'hints']);
  });

  test('Skip all, just start the lab is on the lessons step, and starts the lab', async ({ page }) => {
    const s = await toLessons(page, BUILD);
    await page.getByRole('button', { name: 'Skip all, just start the lab' }).click();
    await enterSession(page);
    expect(s.starts).toEqual([BUILD]);
  });
});

// =========================================================================
// back
// =========================================================================

test.describe('going back', () => {
  test('Back keeps the answers: a question already answered is shown answered, nothing is asked or posted twice', async ({ page }) => {
    const s = await begin(page, EXPLORE, { width: 1440, height: 900 }, { comicTest: true });
    await page.getByRole('button', { name: 'Continue' }).click();
    const first = await answerNext(page, () => false);
    await expect.poll(() => s.posted.length).toBe(1);
    await expect(heading(page)).toHaveText('Round 1 of 3 · question 2 of 5');

    // Previous question: the first one again, answered (wrong, as it was), with its feedback and Next, and nothing to Check.
    await page.getByRole('button', { name: '← Previous question' }).click();
    await expect(heading(page)).toHaveText('Round 1 of 3 · question 1 of 5');
    await expect(heading(page)).toBeFocused();
    expect(await onScreen(page)).toEqual(first);
    await expect(page.locator('.quiz-feedback')).toContainText(first.explanation);
    await expect(page.locator('.quiz-feedback')).toHaveAttribute('data-result', 'incorrect');
    await expect(page.getByRole('button', { name: 'Check', exact: true })).toHaveCount(0);
    await expect(page.locator('.quiz-option input:disabled')).toHaveCount(first.options.length);
    await expect(page.locator('.quiz-option[data-state="incorrect"]')).toHaveCount(1);
    expect(s.posted).toHaveLength(1);

    // From the first question, Back goes to the story; Continue comes back to the first question not yet answered.
    await page.getByRole('button', { name: '← Back to the story' }).click();
    await expect(heading(page)).toHaveText(full.story!.title);
    await expect(heading(page)).toBeFocused();
    await expect(host(page).locator('.cm')).toBeVisible();
    await expect(host(page).locator('.quiz')).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toHaveText('Round 1 of 3 · question 2 of 5');
    await expect(page.getByRole('button', { name: 'Check', exact: true })).toBeVisible();

    // Finish the round: five answers, five posts, one each.
    await runRound(page, () => false);
    await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
    await expect.poll(() => s.posted.length).toBe(5);

    // Back from the lessons: the round's last question, answered. Its Next goes to the lessons again.
    await page.getByRole('button', { name: '← Back to the questions' }).click();
    await expect(heading(page)).toHaveText('Round 1 of 3 · question 5 of 5');
    await expect(page.locator('.quiz-feedback')).not.toBeEmpty();
    await expect(page.getByRole('button', { name: 'Check', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'See the lessons' }).click();
    await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
    expect(s.posted).toHaveLength(5);
    expect(s.posted.flatMap((b) => b.answers)).toHaveLength(5);
    expect(new Set(s.posted.flatMap((b) => b.answers.map((a: any) => a.question_id))).size).toBe(5);
    expect(s.starts).toEqual([]);
  });

  test('Back to labs from the lessons returns to the launcher: no session, nothing left on screen', async ({ page }) => {
    const s = await toLessons(page, BUILD);
    await page.getByRole('button', { name: '← Back to labs' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(screen(page)).toBeHidden();
    await expect(host(page).locator('*')).toHaveCount(0);
    await expect(page.locator('.lesson, .cm')).toHaveCount(0);
    expect(s.starts).toEqual([]);
    // And the lab can be started again from the top.
    await startCard(page, BUILD);
    await expect(heading(page)).toHaveText(full.story!.title);
  });
});

// =========================================================================
// the lessons: the whole screen
// =========================================================================

test.describe('the lessons screen', () => {
  for (const width of [1440, 2000]) {
    test(`takes the whole content width at ${width}px, not the 520px guide pane or an 880px card`, async ({ page }) => {
      await toLessons(page, BUILD, { width, height: 1000 });
      const vw = width;
      const available = await contentWidth(page);
      expect(available).toBeGreaterThan(vw * 0.9);
      const h = await box(host(page));
      // The screen's content spans the window minus its gutters.
      expect(h.width).toBeGreaterThanOrEqual(available * 0.95);
      expect(h.width).toBeGreaterThanOrEqual((vw - 2 * 48) * 0.9);
      expect(h.width).toBeGreaterThan(880);
      // Every lesson card is as wide as the screen.
      for (const card of await host(page).locator('.lesson').all()) {
        const c = await box(card);
        expect(c.width).toBeGreaterThanOrEqual(available * 0.95);
      }
      // The bar with Start the lab is as wide too, and the head is on the page, not in a narrow card.
      expect((await box(host(page).locator('.learn-actions-sticky'))).width).toBeGreaterThanOrEqual(available * 0.95);
      expect(await host(page).evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
      await noHorizontalScroll(page);
    });
  }

  for (const width of [1280, 1440, 2000]) {
    test(`at ${width}px the text is on the left and its diagram, large, on the right`, async ({ page }) => {
      await toLessons(page, BUILD, { width, height: 1000 });
      const lesson = host(page).locator('.lesson[data-state="expanded"]').first();
      const body = lesson.locator('.lesson-body');
      const p = body.locator('p').first();
      const d = body.locator('.md-diagram').first();
      await expect(d.locator('.diagram svg')).toBeVisible();
      const [pb, db, bb] = [await box(p), await box(d), await box(body)];
      // Side by side: the diagram starts after the text ends, and both are inside the lesson.
      expect(db.x).toBeGreaterThanOrEqual(pb.x + pb.width - 1);
      expect(db.x + db.width).toBeLessThanOrEqual(bb.x + bb.width + 1);
      expect(db.width).toBeGreaterThanOrEqual(400);
      // The reading line is at most 72 characters wide.
      const ch72 = await body.evaluate((el) => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;visibility:hidden;width:72ch;height:1px';
        el.append(probe);
        const w = probe.getBoundingClientRect().width;
        probe.remove();
        return w;
      });
      for (const para of await body.locator(':scope > p').all()) expect((await box(para)).width).toBeLessThanOrEqual(ch72 + 1);
      await noHorizontalScroll(page);
    });
  }

  for (const width of [1000, 1200]) {
    test(`at ${width}px it is one column: the diagram sits in the text, as wide as the text`, async ({ page }) => {
      await toLessons(page, BUILD, { width, height: 1000 });
      const body = host(page).locator('.lesson[data-state="expanded"]').first().locator('.lesson-body');
      const p = body.locator('p').first();
      const d = body.locator('.md-diagram').first();
      await expect(d.locator('.diagram svg')).toBeVisible();
      const [pb, db] = [await box(p), await box(d)];
      expect(Math.abs(db.x - pb.x)).toBeLessThanOrEqual(1);
      expect(db.width).toBeGreaterThan(300);
      await noHorizontalScroll(page);
    });
  }

  test('each lesson shows its text and its diagram player, and a long line of code does not widen the page', async ({ page }) => {
    await toLessons(page, BUILD);
    for (const card of await host(page).locator('.lesson').all()) {
      await card.scrollIntoViewIfNeeded();
      await expect(card.locator('.lesson-body p').first()).toBeVisible();
      await expect(card.locator('.diagram').first()).toHaveAttribute('role', 'group');
    }
    await noHorizontalScroll(page);
  });

  test('counts the lessons read as they come into view, and a folded one counts from the start', async ({ page }) => {
    await toLessons(page, BUILD, { width: 1440, height: 800 });
    const tally = host(page).locator('.lessons-tally');
    const total = full.concepts.length;
    await expect(tally).toHaveText(new RegExp(`^[0-9] of ${total} lessons read$`));
    // Scroll through them: the count reaches the total.
    for (const card of await host(page).locator('.lesson').all()) {
      await card.scrollIntoViewIfNeeded();
      await card.locator('.lesson-body').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    }
    await expect(tally).toHaveText(`${total} of ${total} lessons read`);
  });

  test('a folded lesson counts as read from the start, and opening it makes it unread until it is seen', async ({ page }) => {
    await toLessons(page, BUILD, { width: 1440, height: 800 }, { mastery: { ...SKIPPED, overrides: { [ALIASES]: 'skipped' } } });
    const tally = host(page).locator('.lessons-tally');
    const total = full.concepts.length;
    await expect(page.locator(`.lesson[data-concept="${ALIASES}"]`)).toHaveAttribute('data-state', 'collapsed');
    // The folded one is counted, whatever else has been seen.
    const read = Number((await tally.innerText()).split(' ')[0]);
    expect(read).toBeGreaterThanOrEqual(1);
    await page.locator(`.lesson[data-concept="${ALIASES}"]`).getByRole('button', { name: 'Show me the lesson anyway' }).click();
    await expect(page.locator(`.lesson[data-concept="${ALIASES}"]`)).toHaveAttribute('data-state', 'expanded');
    await expect(tally).toHaveText(new RegExp(`of ${total} lessons read$`));
  });

  test('"I know this, skip" and "Show me the lesson anyway" work on this screen and are remembered', async ({ page }) => {
    await toLessons(page, BUILD);
    const aliases = page.locator(`.lesson[data-concept="${ALIASES}"]`);
    await aliases.getByRole('button', { name: 'I know this, skip' }).click();
    await expect(aliases).toHaveAttribute('data-state', 'collapsed');
    await expect(aliases.locator('.lesson-recap')).toHaveText(full.concepts.find((c) => c.id === ALIASES)!.recap);
    await expect(aliases.getByRole('button', { name: 'Show me the lesson anyway' })).toBeFocused();
    await expect(host(page).locator('.plan-summary')).toContainText('1 folded to a recap');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('opalixLearn')!).overrides)).toEqual({ [ALIASES]: 'skipped' });
    await aliases.getByRole('button', { name: 'Show me the lesson anyway' }).click();
    await expect(aliases).toHaveAttribute('data-state', 'expanded');
    await expect(aliases.locator('.diagram').first()).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('opalixLearn')!).overrides)).toEqual({ [ALIASES]: 'forced' });
  });
});

// =========================================================================
// the mastery record and the answers analytics are as they were
// =========================================================================

test.describe('the quick questions still record and report', () => {
  test('answers are stored per concept (Round 1) and posted anonymously, one post per answered question', async ({ page }) => {
    const s = await begin(page, EXPLORE);
    await page.getByRole('button', { name: 'Continue' }).click();
    await runQuiz(page, (q) => q.concept === ALIASES);
    await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
    const m = await page.evaluate(() => JSON.parse(localStorage.getItem('opalixLearn')!));
    expect(m.concepts[ALIASES]).toEqual({ known: true });
    expect(Object.values(m.concepts).filter((c: any) => c.known === false).length).toBe(full.concepts.length - 1);
    await expect.poll(() => s.posted.length).toBe(5);
    for (const body of s.posted) {
      expect(body.lab_slug).toBe(EXPLORE);
      expect(body.lab_version).toBe('1.0.0');
      expect(body.answers).toHaveLength(1);
      expect(new Set(body.answers.map((a: any) => a.phase))).toEqual(new Set(['diagnostic']));
      expect(Object.keys(body).sort()).toEqual(['answers', 'lab_slug', 'lab_version']);
      expect(Object.keys(body.answers[0]).sort()).toEqual(['concept', 'correct', 'phase', 'question_id']);
    }
    // Five different questions, one about each concept.
    expect(new Set(s.posted.map((b) => b.answers[0].concept)).size).toBe(5);
    expect(new Set(s.posted.map((b) => b.answers[0].question_id)).size).toBe(5);
  });

  test('the Questions tab of the running session is unaffected: it renders its fields and counts the answers', async ({ page }) => {
    const s = await begin(page, EXPLORE);
    await page.getByRole('button', { name: 'Continue' }).click();
    await toTheEnd(page, () => true);
    await startButton(page).click();
    await enterSession(page);
    expect(s.starts).toEqual([EXPLORE]);
    await page.getByRole('tab', { name: 'Questions' }).click();
    await expect(page.locator('.qfield')).toHaveCount(full.fields.length);
    await expect(page.locator('#tabQuestions .gtab-badge')).toHaveText(`0/${full.fields.length}`);
    expect(s.errors).toEqual([]);
  });
});

// =========================================================================
// the session: neither the story nor the lessons
// =========================================================================

test.describe('the session screen', () => {
  test('an explore lab at 1440px: Brief, Questions, Hints, with no Story and no Lessons', async ({ page }) => {
    const s = await begin(page, EXPLORE, { width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Continue' }).click();
    await toTheEnd(page, () => false);
    await startButton(page).click();
    await enterSession(page);
    expect(await tabIds(page)).toEqual(['brief', 'questions', 'hints']);
    await expect(page.locator('#guideTabs .tab-active')).toHaveText('Brief');
    await expect(page.getByRole('tab', { name: 'Story' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Lessons' })).toHaveCount(0);
    await expect(page.locator('#guide .lesson, #guide .md-diagram, #guide .cm, #guide .learn-story')).toHaveCount(0);
    expect(await page.locator('#guide').innerText()).not.toContain(full.story!.title);
    expect(s.errors).toEqual([]);
  });

  test('a build lab with lessons at 1440px: Brief, Checks, Hints, and no folded story or lessons either', async ({ page }) => {
    const s = await toLessons(page, BUILD);
    await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
    await enterSession(page);
    expect(await tabIds(page)).toEqual(['brief', 'checks', 'hints']);
    await expect(page.locator('#guideTabs .tab-active')).toHaveText('Brief');
    await expect(page.getByRole('tab', { name: 'Story' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Lessons' })).toHaveCount(0);
    await expect(page.locator('#guide .lesson, #guide .md-diagram, #guide .cm, #guide .learn-story')).toHaveCount(0);
    const text = await page.locator('#guide').innerText();
    expect(text).not.toContain(full.story!.title);
    for (const c of full.concepts) expect(text).not.toContain(c.title);
    // The rail has no icon for them either.
    await page.locator('#btnGuideHide').click();
    expect(await page.locator('#railTabs button').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.railTab))).toEqual(['brief', 'checks', 'hints']);
    expect(s.errors).toEqual([]);
  });

  test('the markup and the script have no Story or Lessons panel left in them', async ({ page }) => {
    await begin(page, BUILD);
    const ids = await page.evaluate(() => ['tabStory', 'tabLessons', 'viewStory', 'viewLessons', 'storyBody', 'lessonsBody'].filter((id) => document.getElementById(id)));
    expect(ids).toEqual([]);
  });
});

// =========================================================================
// a learner who rejoins a running lab goes straight in
// =========================================================================

test.describe('rejoining', () => {
  test('a reload of a running lab goes straight to the session: no story, no lessons, no learn screen', async ({ page }) => {
    const s = await stub(page, { lab: BUILD });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, { remembered: BUILD, url: '/' });
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(screen(page)).toBeHidden();
    await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('.cm, .lesson')).toHaveCount(0);
    expect(await tabIds(page)).toEqual(['brief', 'checks', 'hints']);
    expect(s.starts).toEqual([]);
    expect(s.posted).toEqual([]);
    // A reload of the session screen is the same.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(screen(page)).toBeHidden();
    expect(s.errors).toEqual([]);
  });

  test('the explore lab too: its guide has Brief and Questions straight away', async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, { remembered: EXPLORE, url: '/' });
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(screen(page)).toBeHidden();
    await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
    expect(await tabIds(page)).toEqual(['brief', 'questions', 'hints']);
  });
});

// =========================================================================
// no sideways scroll
// =========================================================================

test.describe('no horizontal scroll', () => {
  for (const width of [1000, 1280, 1440, 2000]) {
    test(`the story, the lessons and the session at ${width}px`, async ({ page }) => {
      await begin(page, BUILD, { width, height: 900 });
      await noHorizontalScroll(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(heading(page)).toHaveText(LESSONS);
      for (const card of await host(page).locator('.lesson').all()) {
        await card.scrollIntoViewIfNeeded();
        await noHorizontalScroll(page);
      }
      await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
      await enterSession(page);
      await noHorizontalScroll(page);
    });
  }

  test('the lessons screen on a window narrowed to a phone', async ({ page }) => {
    await toLessons(page, BUILD);
    await page.setViewportSize({ width: 390, height: 844 });
    await noHorizontalScroll(page);
    for (const el of await host(page).locator('.lesson, .diagram, pre').all()) {
      const r = await box(el);
      expect(r.x + r.width).toBeLessThanOrEqual(390.5);
    }
  });
});

// =========================================================================
// pictures (not assertions of looks: for a person to open and judge)
// =========================================================================

const VARIANTS = [
  { name: 'light-1440', theme: 'light' as const, width: 1440, height: 900 },
  { name: 'dark-1440', theme: 'dark' as const, width: 1440, height: 900 },
  { name: 'light-2000', theme: 'light' as const, width: 2000, height: 1100 },
  { name: 'dark-2000', theme: 'dark' as const, width: 2000, height: 1100 },
];

test.describe('screenshots', () => {
  test.skip(process.env.FLOW_SHOTS === '0', 'FLOW_SHOTS=0');

  for (const v of VARIANTS) {
    test(`the flow, ${v.name}`, async ({ page }) => {
      mkdirSync(SHOTS, { recursive: true });
      await page.emulateMedia({ colorScheme: v.theme, reducedMotion: 'reduce' });
      const shot = async (name: string) => {
        await noHorizontalScroll(page);
        await page.screenshot({ path: join(SHOTS, `${name}-${v.name}.png`) });
      };

      // The story step, the comic finished (reduced motion).
      const s = await begin(page, EXPLORE, { width: v.width, height: v.height }, { theme: v.theme });
      await expect(host(page).locator('.cm')).toHaveAttribute('data-state', 'done');
      await shot('story');

      // Round 1: a question, then the same one answered (feedback at once).
      await page.getByRole('button', { name: 'Continue' }).click();
      await shot('round-1-question');
      await answerOnly(page, () => true);
      await shot('round-1-answered');
      await nextButton(page).click();
      await runRound(page, (q) => q.concept === ALIASES);

      // The lessons, part 1, full screen: the top, then a lesson with its diagram, then the foot.
      await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
      await shot('lessons-a-top');
      const open = host(page).locator('.lesson[data-state="expanded"]').last();
      await open.scrollIntoViewIfNeeded();
      await shot('lessons-a-diagram');
      await host(page).locator('.learn-actions-sticky').scrollIntoViewIfNeeded();
      await shot('lessons-a-foot');

      // Round 2, a wrong answer for its feedback, then on to the session through Skip all.
      await page.getByRole('button', { name: 'Continue to the questions' }).click();
      await expect(heading(page)).toHaveText('Round 2 of 3 · question 1 of 5');
      await answerOnly(page, () => false);
      await shot('round-2-wrong');
      await page.getByRole('button', { name: 'Skip all, just start the lab' }).click();

      // The session screen's guide: an explore lab, then a build lab.
      await enterSession(page);
      await shot('session-explore-tabs');
      await page.locator('#btnEnd').click();
      await page.locator('#endDialog').getByRole('button', { name: 'Discard' }).click();
      await expect(page.locator('#launcher')).toBeVisible();
      await startCard(page, BUILD);
      await page.getByRole('button', { name: 'Skip all, just start the lab' }).click();
      await enterSession(page);
      await shot('session-build-tabs');
      expect(s.errors).toEqual([]);
    });
  }
});

// =========================================================================
// rounds of questions, alternating with the lessons
// =========================================================================

/** Opens the console on a deep link (the address, not the card), past the launcher. */
async function deepLink(page: Page, path: string, opts: OpenOptions = {}) {
  const s = await stub(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, { ...opts, url: path });
  await expect(heading(page)).toBeVisible();
  return s;
}
const here_ = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search;
const live = (page: Page) => page.locator('#learnScreen > p.sr-only[role="status"]');
const roundHeading = (r: number, of: number, q: number, n = 5) => `Round ${r} of ${of} · question ${q} of ${n}`;
const conceptIds = full.concepts.map((c) => c.id);
const CHUNK_A = conceptIds.slice(0, 3);
const CHUNK_B = conceptIds.slice(3);

/** To Round `r` (1 to 3) of the explore lab, answering everything before it right. Returns the questions asked on the way. */
async function toRound(page: Page, r: number, right: (q: Question) => boolean = () => true): Promise<Question[]> {
  await page.getByRole('button', { name: 'Continue' }).click();
  const asked: Question[] = [];
  for (let i = 1; i < r; i++) {
    asked.push(...(await runRound(page, right)));
    await page.getByRole('button', { name: 'Continue to the questions' }).click();
  }
  return asked;
}

test.describe('rounds of questions and lessons', () => {
  test('15 questions and 5 lessons: story, Round 1, lessons A, Round 2, lessons B, Round 3, then Start the lab', async ({ page }) => {
    const s = await begin(page, EXPLORE);
    await expect(live(page)).toHaveText(`Step 1 of 6: ${full.story!.title}`);
    await page.getByRole('button', { name: 'Continue' }).click();

    const askedIn: Question[][] = [];
    const titlesIn: string[][] = [];
    // Where each step lives in the address: the first of its kind has the plain path, the others ?step=N.
    const address = ['/questions', '/lessons', '/questions?step=4', '/lessons?step=5', '/questions?step=6'];
    for (let r = 1; r <= 3; r++) {
      const step = 2 * r;
      await expect(live(page)).toHaveText(`Step ${step} of 6: Questions, round ${r} of 3`);
      expect(here_(page)).toBe(`/labs/${EXPLORE}${address[2 * r - 2]}`);
      await expect(host(page).locator('.steps-dots i')).toHaveCount(7);
      await expect(host(page).locator('.steps-dots i.now')).toHaveCount(1);
      expect(await host(page).locator('.steps-dots i').evaluateAll((els) => els.findIndex((e) => e.classList.contains('now')))).toBe(step - 1);
      expect(await host(page).locator('.steps-dots i[data-kind="round"]').count()).toBe(3);
      expect(await host(page).locator('.steps-dots i[data-kind="lessons"]').count()).toBe(2);
      const asked: Question[] = [];
      for (let k = 1; k <= 5; k++) {
        await expect(heading(page)).toHaveText(roundHeading(r, 3, k));
        await expect(heading(page)).toBeFocused();
        // Immediate feedback with the explanation, before moving on.
        const q = await answerOnly(page, () => true);
        await expect(page.locator('.quiz-feedback')).toHaveAttribute('data-result', 'correct');
        asked.push(q);
        const label = (await nextButton(page).innerText()).trim();
        if (k < 5) {
          expect(label).toBe('Next');
          await nextButton(page).click();
        } else if (r < 3) {
          expect(label).toBe('See the lessons');
          await nextButton(page).click();
        } else {
          // The flow ends on a round: the last question's button is Start the lab.
          expect(label).toBe('Start the lab');
        }
      }
      askedIn.push(asked);
      if (r === 3) break;
      const part = r;
      await expect(heading(page)).toHaveText(`Lessons, part ${part} of 2`);
      await expect(heading(page)).toBeFocused();
      await expect(live(page)).toHaveText(`Step ${step + 1} of 6: Lessons, part ${part} of 2`);
      expect(here_(page)).toBe(`/labs/${EXPLORE}${address[2 * r - 1]}`);
      titlesIn.push(await host(page).locator('.lesson-title').allInnerTexts());
      await page.getByRole('button', { name: 'Continue to the questions' }).click();
    }

    // The lessons are the lab's, in order: three, then two (the foundation lesson first).
    expect(titlesIn[0]).toEqual(full.concepts.slice(0, 3).map((c) => c.title));
    expect(titlesIn[1]).toEqual(full.concepts.slice(3).map((c) => c.title));
    // Round 1: one question about each concept, the foundation's first.
    expect(askedIn[0]!.map((q) => q.concept)).toEqual(conceptIds);
    // Round 2 is about the lessons just read, Round 3 about the last ones (plus the leftover of the first).
    expect(askedIn[1]!.every((q) => CHUNK_A.includes(q.concept))).toBe(true);
    expect(askedIn[2]!.filter((q) => CHUNK_B.includes(q.concept))).toHaveLength(4);
    expect(askedIn[2]!.filter((q) => CHUNK_A.includes(q.concept))).toHaveLength(1);
    // Nothing twice, nothing missing.
    const all = askedIn.flat().map((q) => q.id);
    expect(new Set(all).size).toBe(15);
    expect([...all].sort()).toEqual(full.questions.map((q) => q.id).sort());
    // The question that is not diagnostic has a home too (not in Round 1).
    const notDiagnostic = full.questions.filter((q) => q.diagnostic === false).map((q) => q.id);
    expect(askedIn[0]!.some((q) => notDiagnostic.includes(q.id))).toBe(false);
    expect(all.filter((id) => notDiagnostic.includes(id))).toHaveLength(notDiagnostic.length);

    // One post per answered question, nothing else.
    expect(s.posted).toHaveLength(15);
    expect(s.posted.every((b) => b.answers.length === 1)).toBe(true);
    expect(new Set(s.posted.map((b) => b.answers[0].question_id)).size).toBe(15);
    expect(s.starts).toEqual([]);

    // The session starts only when the last question's Start the lab is pressed.
    await startButton(page).click();
    await enterSession(page);
    expect(s.starts).toEqual([EXPLORE]);
    expect(s.errors).toEqual([]);
  });

  test('only Round 1 sets what is folded: a later round does not change the lessons', async ({ page }) => {
    await begin(page, EXPLORE);
    // Round 1 all wrong: every lesson of part 1 is open.
    await toRound(page, 2, () => false);
    await expect(heading(page)).toHaveText(roundHeading(2, 3, 1));
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('opalixLearn')!).concepts);
    expect(Object.values(before).every((c: any) => c.known === false)).toBe(true);
    // Round 2 all right changes nothing in the record.
    await runRound(page, () => true);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('opalixLearn')!).concepts)).toEqual(before);
    await expect(heading(page)).toHaveText('Lessons, part 2 of 2');
    await expect(host(page).locator('.lesson[data-state="expanded"]')).toHaveCount(CHUNK_B.length);
  });

  test('the lessons of a later chunk are numbered on from the first', async ({ page }) => {
    await begin(page, EXPLORE);
    await page.getByRole('button', { name: 'Continue' }).click();
    await runRound(page, () => false);
    await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
    // The list's counter starts after the lessons before it: none, then the three of part 1 (the circles read 4 and 5).
    const startsAfter = () => host(page).locator('.lesson-list').evaluate((el) => getComputedStyle(el).counterReset);
    expect(await startsAfter()).toBe('lesson 0');
    await page.getByRole('button', { name: 'Continue to the questions' }).click();
    await runRound(page, () => false);
    await expect(heading(page)).toHaveText('Lessons, part 2 of 2');
    expect(await startsAfter()).toBe('lesson 3');
  });

  test('a lab with four questions has one round, then all its lessons as one chunk, then Start', async ({ page }) => {
    const s = await begin(page, FEW_QUESTIONS);
    await expect(live(page)).toHaveText(`Step 1 of 3: ${full.story!.title}`);
    await page.getByRole('button', { name: 'Continue' }).click();
    // One round: no "Round 1 of 1".
    await expect(heading(page)).toHaveText('Question 1 of 4');
    await expect(live(page)).toHaveText('Step 2 of 3: Questions');
    expect(await runRound(page, () => true)).toHaveLength(4);
    await expect(heading(page)).toHaveText(LESSONS);
    await expect(live(page)).toHaveText('Step 3 of 3: Lessons');
    await expect(host(page).locator('.lesson')).toHaveCount(full.concepts.length);
    await expect(host(page).locator('.steps-dots i')).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'Continue to the questions' })).toHaveCount(0);
    expect(s.posted).toHaveLength(4);
    await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
    await enterSession(page);
    expect(s.starts).toEqual([FEW_QUESTIONS]);
  });

  test('a concept asked twice in Round 1 is known only when both answers were right', async ({ page }) => {
    await begin(page, FEW_QUESTIONS);
    await page.getByRole('button', { name: 'Continue' }).click();
    const foundation = full.concepts[0]!.id;
    const asked = await runRound(page, (q) => q.concept === ALIASES || q.id === 'q-gateway-what');
    expect(asked.map((q) => q.id)).toEqual(['q-gateway-what', 'q-alias-caller-sends', 'q-gateway-problems', 'q-alias-where-defined']);
    const m = await page.evaluate(() => JSON.parse(localStorage.getItem('opalixLearn')!).concepts);
    // The foundation concept: right once, wrong once. Aliases: right twice.
    expect(m[foundation]).toEqual({ known: false });
    expect(m[ALIASES]).toEqual({ known: true });
    await expect(page.locator(`.lesson[data-concept="${foundation}"]`)).toHaveAttribute('data-state', 'expanded');
    await expect(page.locator(`.lesson[data-concept="${ALIASES}"]`)).toHaveAttribute('data-state', 'collapsed');
  });

  test('a lab with no questions goes story, lessons, Start, with no round anywhere', async ({ page }) => {
    const s = await begin(page, BUILD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toHaveText(LESSONS);
    await expect(host(page).locator('.quiz, .quiz-option')).toHaveCount(0);
    await expect(live(page)).toHaveText('Step 2 of 2: Lessons');
    expect(s.posted).toEqual([]);
    expect(here_(page)).toBe(`/labs/${BUILD}/lessons`);
  });

  test('a question round is a centred column, narrower than the lessons, and moves nothing at all with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await begin(page, EXPLORE, { width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toHaveText(roundHeading(1, 3, 1));
    const h = await box(host(page));
    expect(h.width).toBeLessThanOrEqual(762);
    expect(h.width).toBeGreaterThan(600);
    const screenBox = await box(screen(page));
    expect(Math.abs(h.x - screenBox.x - (screenBox.x + screenBox.width - (h.x + h.width)))).toBeLessThan(24);
    await answerOnly(page, () => true);
    const animated = await page.evaluate(() => [...document.querySelectorAll('#learnScreen *')].filter((el) => getComputedStyle(el).animationName !== 'none').length);
    expect(animated).toBe(0);
    await nextButton(page).click();
    await runRound(page, () => true);
    // The lessons that follow are as wide as the screen.
    await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
    expect((await box(host(page))).width).toBeGreaterThan(1100);
  });

  test('can be done with the keyboard alone: options, Check (Enter), Next, and the lessons buttons', async ({ page }) => {
    await begin(page, EXPLORE);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toBeFocused();
    // From the heading, Tab reaches the first option; Space picks it, Enter checks the form.
    await page.keyboard.press('Tab');
    await expect(page.locator('.quiz-option input').first()).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('.quiz-option input').first()).toBeChecked();
    await page.keyboard.press('Enter');
    await expect(page.locator('.quiz-feedback')).not.toBeEmpty();
    await expect(page.locator('.quiz-feedback')).toBeFocused();
    // The feedback is announced and Next is the next stop; Enter moves on and the new heading takes focus.
    await page.keyboard.press('Tab');
    await expect(nextButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(heading(page)).toHaveText(roundHeading(1, 3, 2));
    await expect(heading(page)).toBeFocused();
    // Every button of the screen can be reached by Tab.
    const reachable = new Set<string>();
    await page.locator('.quiz-prompt').focus();
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      reachable.add(await page.evaluate(() => (document.activeElement as HTMLElement)?.id || (document.activeElement as HTMLElement)?.textContent?.trim() || ''));
    }
    for (const name of ['btnSkipAll', 'btnBeforeBack', 'btnPrevQuestion', 'Check']) expect([...reachable].some((x) => x === name || x.startsWith(name)), `${name} is reachable: ${[...reachable].join(' | ')}`).toBe(true);
    // The rest of Round 1 by keyboard, then the lessons' "Continue" with Enter.
    for (let q = 2; q <= 5; q++) {
      await expect(heading(page)).toHaveText(roundHeading(1, 3, q));
      const cur = await onScreen(page);
      for (const id of cur.answer) await page.locator(`.quiz-option[data-option="${id}"] input`).focus().then(() => page.keyboard.press('Space'));
      await page.getByRole('button', { name: 'Check', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.quiz-feedback')).toHaveAttribute('data-result', 'correct');
      await nextButton(page).focus();
      await page.keyboard.press('Enter');
    }
    await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
    await page.locator('#btnNextStep').focus();
    await page.keyboard.press('Enter');
    await expect(heading(page)).toHaveText(roundHeading(2, 3, 1));
  });
});

test.describe('going back and forward through the flow', () => {
  test("the browser's Back and Forward walk the steps and nothing is asked again", async ({ page }) => {
    const s = await begin(page, EXPLORE);
    await toRound(page, 2, () => true);
    await expect(heading(page)).toHaveText(roundHeading(2, 3, 1));
    expect(here_(page)).toBe(`/labs/${EXPLORE}/questions?step=4`);
    await answerNext(page, () => true);
    expect(s.posted).toHaveLength(6);

    await page.goBack();
    await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
    expect(here_(page)).toBe(`/labs/${EXPLORE}/lessons`);
    await page.goBack();
    // Round 1, every question answered: it opens on the last, answered; nothing to Check.
    await expect(heading(page)).toHaveText(roundHeading(1, 3, 5));
    await expect(page.getByRole('button', { name: 'Check', exact: true })).toHaveCount(0);
    await expect(page.locator('.quiz-feedback')).not.toBeEmpty();
    await page.goBack();
    await expect(heading(page)).toHaveText(full.story!.title);
    await page.goForward();
    await expect(heading(page)).toHaveText(roundHeading(1, 3, 5));
    await page.goForward();
    await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
    await page.goForward();
    // Round 2 on its first question not yet answered: the second.
    await expect(heading(page)).toHaveText(roundHeading(2, 3, 2));
    expect(s.posted).toHaveLength(6);
    expect(s.starts).toEqual([]);
  });

  test('Back from Round 2 goes to the lessons, from the second lessons to Round 2, with answers kept', async ({ page }) => {
    const s = await begin(page, EXPLORE);
    await toRound(page, 2, () => true);
    await expect(page.getByRole('button', { name: '← Back to the lessons' })).toBeVisible();
    await page.getByRole('button', { name: '← Back to the lessons' }).click();
    await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
    await expect(page.getByRole('button', { name: '← Back to the questions' })).toBeVisible();
    await page.getByRole('button', { name: '← Back to the questions' }).click();
    await expect(heading(page)).toHaveText(roundHeading(1, 3, 5));
    expect(s.posted).toHaveLength(5);
  });
});

test.describe('Skip all, just start the lab, at every step', () => {
  test('on a question of a later round', async ({ page }) => {
    const s = await begin(page, EXPLORE);
    await toRound(page, 2, () => true);
    await expect(heading(page)).toHaveText(roundHeading(2, 3, 1));
    await page.getByRole('button', { name: 'Skip all, just start the lab' }).click();
    await enterSession(page);
    expect(s.starts).toEqual([EXPLORE]);
    // What was answered was kept (and posted); nothing else was.
    expect(s.posted).toHaveLength(5);
  });

  test('on the lessons of part 2, and on the first question', async ({ page }) => {
    const s = await begin(page, EXPLORE);
    await toRound(page, 3, () => true);
    await page.getByRole('button', { name: '← Back to the lessons' }).click();
    await expect(heading(page)).toHaveText('Lessons, part 2 of 2');
    await page.getByRole('button', { name: 'Skip all, just start the lab' }).click();
    await enterSession(page);
    expect(s.starts).toEqual([EXPLORE]);
  });

  test('a skipped question leaves its answer unrecorded: nothing is decided for the learner', async ({ page }) => {
    const s = await begin(page, EXPLORE);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Skip all, just start the lab' }).click();
    await enterSession(page);
    expect(s.posted).toEqual([]);
    expect(((await page.evaluate(() => JSON.parse(localStorage.getItem('opalixLearn')!))).concepts ?? {})).toEqual({});
  });
});

test.describe('a refresh and a link come back to the step', () => {
  test('a refresh in the middle of Round 2 and on the second lessons returns to the same step with the answers kept', async ({ page }) => {
    const s = await begin(page, EXPLORE);
    await toRound(page, 2, () => false);
    await answerNext(page, () => true);
    await answerNext(page, () => true);
    await expect(heading(page)).toHaveText(roundHeading(2, 3, 3));
    expect(s.posted).toHaveLength(7);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(heading(page)).toHaveText(roundHeading(2, 3, 3));
    expect(here_(page)).toBe(`/labs/${EXPLORE}/questions?step=4`);
    await expect(live(page)).toHaveText('Step 4 of 6: Questions, round 2 of 3');
    // The two answered questions are still answered (not asked again) and nothing more was posted.
    await page.getByRole('button', { name: '← Previous question' }).click();
    await expect(heading(page)).toHaveText(roundHeading(2, 3, 2));
    await expect(page.locator('.quiz-feedback')).toHaveAttribute('data-result', 'correct');
    await expect(page.getByRole('button', { name: 'Check', exact: true })).toHaveCount(0);
    expect(s.posted).toHaveLength(7);
    // Round 1's results are in the record too: the plan was not made again, so the same rounds follow.
    await nextButton(page).click();
    await runRound(page, () => true);
    await expect(heading(page)).toHaveText('Lessons, part 2 of 2');
    expect(here_(page)).toBe(`/labs/${EXPLORE}/lessons?step=5`);
    expect(s.posted).toHaveLength(10);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(heading(page)).toHaveText('Lessons, part 2 of 2');
    await expect(host(page).locator('.lesson-title')).toHaveText(full.concepts.slice(3).map((c) => c.title));
    expect(here_(page)).toBe(`/labs/${EXPLORE}/lessons?step=5`);
    await expect(live(page)).toHaveText('Step 5 of 6: Lessons, part 2 of 2');
    await page.getByRole('button', { name: 'Continue to the questions' }).click();
    await expect(heading(page)).toHaveText(roundHeading(3, 3, 1));
    expect(s.posted).toHaveLength(10);
  });

  test('a refresh on Round 1 and on the story is the same step', async ({ page }) => {
    await begin(page, EXPLORE);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(heading(page)).toHaveText(full.story!.title);
    await page.getByRole('button', { name: 'Continue' }).click();
    await answerNext(page, () => true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(heading(page)).toHaveText(roundHeading(1, 3, 2));
    expect(here_(page)).toBe(`/labs/${EXPLORE}/questions`);
  });

  test('a deep link to a later step opens it, one with a step number out of range opens the first step', async ({ page }) => {
    await deepLink(page, `/labs/${EXPLORE}/lessons?step=5`);
    await expect(heading(page)).toHaveText('Lessons, part 2 of 2');
    expect(here_(page)).toBe(`/labs/${EXPLORE}/lessons?step=5`);
    await expect(live(page)).toHaveText('Step 5 of 6: Lessons, part 2 of 2');
  });

  for (const [what, link, startsAt] of [
    ['a step number past the end', `/lessons?step=99`, 'story'],
    ['a step number just past the end', `/questions?step=7`, 'story'],
    ['a step of 0', `/questions?step=0`, 'round 1'],
    ['a step that is not a number', `/lessons?step=abc`, 'lessons 1'],
    ['a negative step', `/lessons?step=-3`, 'lessons 1'],
    ['an empty step', `/questions?step=`, 'round 1'],
  ] as const) {
    test(`${what} (${link}) falls back to a first step and the address is corrected`, async ({ page }) => {
      const s = await deepLink(page, `/labs/${EXPLORE}${link}`);
      const expected: Record<string, [string, string]> = {
        story: [full.story!.title, 'story'],
        'round 1': [roundHeading(1, 3, 1), 'questions'],
        'lessons 1': ['Lessons, part 1 of 2', 'lessons'],
      };
      await expect(heading(page)).toHaveText(expected[startsAt]![0]);
      await expect.poll(() => here_(page)).toBe(`/labs/${EXPLORE}/${expected[startsAt]![1]}`);
      expect(s.errors).toEqual([]);
    });
  }

  test('the step number wins over the word: /story?step=4 is Round 2, and the address says so', async ({ page }) => {
    await deepLink(page, `/labs/${EXPLORE}/story?step=4`);
    await expect(heading(page)).toHaveText(roundHeading(2, 3, 1));
    await expect.poll(() => here_(page)).toBe(`/labs/${EXPLORE}/questions?step=4`);
  });

  for (const [word, text] of [
    ['story', full.story!.title],
    ['questions', roundHeading(1, 3, 1)],
    ['lessons', 'Lessons, part 1 of 2'],
  ] as const) {
    test(`the old address /labs/<slug>/${word} is still valid`, async ({ page }) => {
      await deepLink(page, `/labs/${EXPLORE}/${word}`);
      await expect(heading(page)).toHaveText(text);
      expect(here_(page)).toBe(`/labs/${EXPLORE}/${word}`);
    });
  }
});

test.describe('rounds and lessons: no horizontal scroll', () => {
  for (const width of [1000, 1280, 1440, 2000]) {
    test(`a round (asked and answered) and a lessons chunk at ${width}px`, async ({ page }) => {
      await begin(page, EXPLORE, { width, height: 900 });
      await page.getByRole('button', { name: 'Continue' }).click();
      await noHorizontalScroll(page);
      await answerOnly(page, () => false);
      await noHorizontalScroll(page);
      await nextButton(page).click();
      await runRound(page, () => false);
      await expect(heading(page)).toHaveText('Lessons, part 1 of 2');
      for (const card of await host(page).locator('.lesson').all()) {
        await card.scrollIntoViewIfNeeded();
        await noHorizontalScroll(page);
      }
      const available = await contentWidth(page);
      for (const card of await host(page).locator('.lesson').all()) expect((await box(card)).width).toBeGreaterThanOrEqual(available * 0.95);
      await page.getByRole('button', { name: 'Continue to the questions' }).click();
      await noHorizontalScroll(page);
    });
  }

  test('a round on a window narrowed to a phone', async ({ page }) => {
    await begin(page, EXPLORE);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await noHorizontalScroll(page);
    await answerOnly(page, () => true);
    await noHorizontalScroll(page);
    for (const el of await host(page).locator('.quiz-option, .steps-dots, .learn-actions .btn').all()) {
      // (The Next button is hidden until a question is answered.)
      const r = await el.boundingBox();
      if (r) expect(r.x + r.width).toBeLessThanOrEqual(390.5);
    }
  });
});

// =========================================================================
// the lab is warmed up while the last steps are read, and is invisible
// =========================================================================

test.describe('warming the lab up (POST /api/prepare)', () => {
  /** Lets a fire-and-forget request reach the stub. */
  const settle = (page: Page) => page.waitForTimeout(150);

  test('prepares once, when the second-to-last step is shown, and never again for Back, Forward or the last step', async ({ page }) => {
    // story, Round 1 (four questions), lessons: the second-to-last step is the round.
    const s = await begin(page, FEW_QUESTIONS);
    await settle(page);
    expect(s.prepares, 'not on the story').toEqual([]);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toHaveText('Question 1 of 4');
    await expect.poll(() => s.prepares).toEqual([FEW_QUESTIONS]);

    await runRound(page, () => true);
    await expect(heading(page)).toHaveText(LESSONS);
    await page.getByRole('button', { name: '← Back to the questions' }).click();
    await settle(page);
    expect(s.prepares, 'once per visit').toEqual([FEW_QUESTIONS]);
    expect(s.cancels).toEqual([]);
  });

  test('a lab of a story and lessons warms up as soon as the story is shown; one of lessons alone, as soon as they are', async ({ page }) => {
    const s = await begin(page, TEXT_STORY);
    await expect.poll(() => s.prepares).toEqual([TEXT_STORY]);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toHaveText(LESSONS);
    await settle(page);
    expect(s.prepares).toEqual([TEXT_STORY]);

    const t = await begin(page, LESSONS_ONLY);
    await expect.poll(() => t.prepares).toEqual([LESSONS_ONLY]);
  });

  test('a long flow warms up on the step before the last, not before', async ({ page }) => {
    const s = await begin(page, EXPLORE);
    // The dots are the steps and one more, for Start.
    const stepCount = (await host(page).locator('.steps-dots i').count()) - 1;
    expect(stepCount).toBeGreaterThanOrEqual(4);
    // Walk step by step; the warm-up must appear exactly when step (n - 1) of n is on screen.
    let shown = 1;
    for (let guard = 0; guard < 40 && shown < stepCount - 1; guard++) {
      expect(s.prepares, `before step ${stepCount - 1} of ${stepCount}`).toEqual([]);
      if (await page.locator('.quiz-prompt').count()) {
        await answerOnly(page, () => true);
        const next = nextButton(page);
        const wasLast = (await heading(page).innerText()).match(/question (\d+) of (\d+)/i);
        await next.click();
        if (!wasLast || wasLast[1] === wasLast[2]) shown++;
      } else if (await page.locator('#btnNextStep').count()) {
        await page.locator('#btnNextStep').click();
        shown++;
      } else if (await page.locator('#btnStoryNext').count()) {
        await page.locator('#btnStoryNext').click();
        shown++;
      }
    }
    expect(shown).toBe(stepCount - 1);
    await expect.poll(() => s.prepares).toEqual([EXPLORE]);
  });

  test('"Skip all" starts at once and warms nothing up', async ({ page }) => {
    const s = await begin(page, FEW_QUESTIONS);
    await page.locator('#btnSkipAll').click();
    await enterSession(page);
    await settle(page);
    expect(s.starts).toEqual([FEW_QUESTIONS]);
    expect(s.prepares).toEqual([]);
    expect(s.cancels).toEqual([]);
  });

  test('Start after the warm-up runs the normal start, and the warm lab is not cancelled', async ({ page }) => {
    const s = await begin(page, FEW_QUESTIONS);
    await page.getByRole('button', { name: 'Continue' }).click();
    await runRound(page, () => true);
    await expect(heading(page)).toHaveText(LESSONS);
    await expect.poll(() => s.prepares).toEqual([FEW_QUESTIONS]);
    await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
    await enterSession(page);
    // Pressing Start (and a page that closes after it) must never cancel what the start is using.
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await settle(page);
    expect(s.starts).toEqual([FEW_QUESTIONS]);
    expect(s.cancels).toEqual([]);
  });

  for (const status of [409, 503, 500]) {
    test(`a warm-up the API refuses (${status}) changes nothing: the flow and Start work as before`, async ({ page }) => {
      const s = await stub(page);
      s.prepareStatus = status;
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page);
      await startCard(page, TEXT_STORY);
      await expect.poll(() => s.prepares).toEqual([TEXT_STORY]);
      await expect(heading(page)).toBeVisible();
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(heading(page)).toHaveText(LESSONS);
      await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
      await enterSession(page);
      expect(s.starts).toEqual([TEXT_STORY]);
      expect(s.errors).toEqual([]);
    });
  }

  test('a warm-up whose request fails at the network changes nothing either', async ({ page }) => {
    const s = await stub(page);
    await page.route('**/api/prepare', (route) => route.abort('failed'));
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await startCard(page, TEXT_STORY);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toHaveText(LESSONS);
    await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
    await enterSession(page);
    expect(s.starts).toEqual([TEXT_STORY]);
    expect(s.errors).toEqual([]);
  });

  test('Back to labs drops the warm lab, leaves no Rejoin card, and the next visit warms it again', async ({ page }) => {
    const s = await begin(page, TEXT_STORY);
    await expect.poll(() => s.prepares).toEqual([TEXT_STORY]);
    await page.getByRole('button', { name: '← Back to labs' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect.poll(() => s.cancels).toEqual([{ lab: TEXT_STORY }]);
    // Invisible: nothing is running, so no resume card and no "pick up" hero.
    await expect(page.locator('#resumeCard')).toBeHidden();
    await expect(page.locator('#heroTitle')).toContainText('Pick your next');
    expect(s.starts).toEqual([]);

    await startCard(page, TEXT_STORY);
    await expect(heading(page)).toBeVisible();
    await expect.poll(() => s.prepares).toEqual([TEXT_STORY, TEXT_STORY]);
  });

  test('leaving the flow by the browser (a route change away) drops the warm lab too', async ({ page }) => {
    const s = await begin(page, TEXT_STORY);
    await expect.poll(() => s.prepares).toEqual([TEXT_STORY]);
    await page.goBack();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect.poll(() => s.cancels).toEqual([{ lab: TEXT_STORY }]);
    await expect(page.locator('#resumeCard')).toBeHidden();
  });

  test('a page that closes sends the cancel as a beacon', async ({ page }) => {
    const s = await begin(page, TEXT_STORY);
    await expect.poll(() => s.prepares).toEqual([TEXT_STORY]);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect.poll(() => s.cancels).toEqual([{ lab: TEXT_STORY }]);
  });

  test('nothing is cancelled when nothing was warmed up', async ({ page }) => {
    const s = await begin(page, FEW_QUESTIONS);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.getByRole('button', { name: '← Back to labs' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await settle(page);
    expect(s.prepares).toEqual([]);
    expect(s.cancels).toEqual([]);
  });

  test('a phone cannot run a lab, so it warms nothing up', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize({ width: 390, height: 844 });
    // A phone cannot press Start on a card (the desktop notice stops it), but a link opens the steps.
    await open(page, { url: `/labs/${TEXT_STORY}/story` });
    await expect(heading(page)).toBeVisible();
    await settle(page);
    expect(s.prepares).toEqual([]);
  });

  test('a lab already running goes straight into the session: no flow, no warm-up', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, { remembered: EXPLORE });
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(screen(page)).toBeHidden();
    await settle(page);
    expect(s.prepares).toEqual([]);
    expect(s.cancels).toEqual([]);
  });
});
