import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { parse as parseYaml } from 'yaml';
import { serveConsole } from './console-server';

/**
 * The learning flow of the console: the platform quiz, "Before you begin"
 * (the story, the questions, then the lessons full screen), the Questions tab, and a
 * lab without learning content. The story and the lessons are not in the session at
 * all: 19-lessons-flow.spec.ts covers the full-screen layout and that.
 *
 * Unlike the specs that drive a deployed console, this one needs no password,
 * no API and no container. A small static server serves dashboard/public (the
 * built bundle, dist included, with the CSP from public/_headers so a policy
 * violation shows up as a console error) and every call the console makes is
 * answered by a route stub: /api/labs, /api/onboarding, /api/learn/*, /api/start
 * for the console Worker, and the session, files and checks endpoints for the
 * API. The Worker's own routes are covered by test/unit/console-worker.test.ts.
 *
 * The content is real: the learn bundle is compiled from
 * labs/see-what-a-gateway-does/learn and the onboarding quiz is
 * packages/catalogue/onboarding.json, so a change to either that breaks the
 * console shows up here.
 *
 * Run `npm run build:dashboard` first (the page loads dashboard/public/dist).
 * LEARN_SHOTS_DIR chooses where the screenshots go (default test/e2e/shots/learn).
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC = join(ROOT, 'dashboard/public');
const API = 'https://opalix-sandbox.soubenz94.workers.dev';
const SHOTS = process.env.LEARN_SHOTS_DIR || join(here, 'shots/learn');

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
  /** Onboarding questions only: how deep the branching quiz probes with it. */
  level?: 'basic' | 'advanced';
}
interface Concept {
  id: string;
  title: string;
  minutes: number;
  recap: string;
  body: string;
}
interface Field {
  key: string;
  prompt: string;
  kind: 'text' | 'number' | 'choice';
  choices?: string[];
  help?: string;
}
interface Bundle {
  story?: { title: string; minutes: number; body: string };
  concepts: Concept[];
  questions: Question[];
  answers_file: string;
  fields: Field[];
}

const GATEWAY = 'see-what-a-gateway-does';
const PLAIN = 'see-how-requests-are-routed-plain';
const LEARN_404 = 'has-learn-but-none-published';
const LEARN_500 = 'has-learn-but-the-fetch-fails';
const NOQUIZ = 'a-lab-that-asks-no-questions';

/**
 * The lab's learn/ folder as the bundle the API would serve. The CLI's own
 * compiler cannot be imported here (Playwright loads specs as plain ESM, which
 * refuses the JSON imports the compiler's schema module makes), so this reads
 * the same files the same way; test/unit/learn.test.ts covers the compiler.
 */
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
    .sort((a, b) => a.order - b.order) // as the compiler: lower `order` first (the foundation lesson), then file name
    .map(({ order: _order, ...c }) => c as Concept);
  const quiz = parseYaml(readFileSync(join(dir, 'quiz.yaml'), 'utf8')) as { questions: Question[] };
  const qs = parseYaml(readFileSync(join(dir, 'questions.yaml'), 'utf8')) as { answers_file: string; fields: Field[] };
  return {
    story: { title: story.data.title, minutes: story.data.minutes, body: story.body },
    concepts,
    questions: quiz.questions.map((q) => ({ diagnostic: true, ...q })),
    answers_file: qs.answers_file,
    fields: qs.fields,
  };
}

const bundle = compileLearn(GATEWAY);
const onboarding = JSON.parse(readFileSync(join(ROOT, 'packages/catalogue/onboarding.json'), 'utf8')) as { intro: string; areas: Array<{ area: string; blurb: string }>; questions: Question[] };
const concepts = JSON.parse(readFileSync(join(ROOT, 'packages/catalogue/concepts.json'), 'utf8')) as { areas: Record<string, { title: string; module: number }> };

/** The platform's areas in module order, and the two questions the branching quiz probes each with. */
const AREAS = Object.entries(concepts.areas)
  .map(([area, a]) => ({ area, title: a.title, module: a.module }))
  .sort((a, b) => a.module - b.module);
const probe = (area: string, level: 'basic' | 'advanced') => onboarding.questions.find((q) => q.concept.startsWith(`${area}.`) && q.level === level)!;
const titleOf = (area: string) => concepts.areas[area]!.title;
const stepText = (area: string, n: number) => `${titleOf(area)} \u00b7 question ${n} of up to 2`;

/** The lesson of a concept, and the diagnostic questions about it. */
const lessonOf = (id: string) => bundle.concepts.find((c) => c.id === id)!;
const diagnosticsOf = (id: string) => bundle.questions.filter((q) => q.concept === id && q.diagnostic !== false);
const ALIASES = 'gateway.routing-aliases';
const SPEND = 'gateway.usage-and-spend';
const DIAGNOSTIC_COUNT = bundle.questions.filter((q) => q.diagnostic !== false).length;
/**
 * The flow of this lab: 15 questions and 5 lessons are three rounds of five and two chunks of
 * lessons (3 and 2, in lesson order: what-is, aliases, spend, then errors, reload). Round 1 asks one
 * question about each concept; the rest follow their lessons (the order itself is unit tested:
 * console-learn-flow.test.ts, and seen end to end in 19-lessons-flow.spec.ts).
 */
const CHUNK_A = bundle.concepts.slice(0, 3).map((c) => c.id);
const ROUND_1 = 'Round 1 of 3 · question 1 of 5';
const LESSONS_A = 'Lessons, part 1 of 2';

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
  has_learn: false,
  progress: null,
  ...o,
});

const LABS = [
  lab({ slug: GATEWAY, title: 'See what a gateway does', module: 1, has_learn: true }),
  lab({ slug: LEARN_404, title: 'Has learn but none published', module: 1, order: 2, has_learn: true }),
  lab({ slug: LEARN_500, title: 'Has learn but the fetch fails', module: 1, order: 3, has_learn: true }),
  lab({ slug: NOQUIZ, title: 'Asks no questions', module: 1, order: 4, has_learn: true }),
  lab({ slug: PLAIN, title: 'See how requests are routed', module: 2, has_learn: false }),
  lab({ slug: 'see-why-a-document-matched', title: 'See why a document matched', module: 3, has_learn: false }),
];

// ------------------------------------------------------------- a fake console

type Answers = Record<string, unknown>;
interface Stub {
  starts: string[];
  learnFetches: string[];
  onboardingFetches: number;
  posted: Array<Record<string, any>>;
  files: Map<string, string>;
  puts: Array<{ path: string; body: string }>;
  checkRuns: number;
  errors: string[];
}
interface StubOptions {
  onboarding?: 'ok' | 'none' | 'error' | 'legacy';
  files?: Record<string, string>;
  /** Delay before each file write answers, to hold a save in flight. */
  putDelayMs?: number;
  /** The lab a session that was not started through /api/start reports (default the gateway lab). */
  lab?: string;
}

const json = (route: Route, body: unknown, status = 200, extra: Record<string, string> = {}) => {
  const origin = route.request().headers()['origin'];
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}), ...extra },
    body: JSON.stringify(body),
  });
};

const SESSION_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';

async function stub(page: Page, opts: StubOptions = {}): Promise<Stub> {
  const s: Stub = { starts: [], learnFetches: [], onboardingFetches: 0, posted: [], files: new Map(Object.entries(opts.files ?? {})), puts: [], checkRuns: 0, errors: [] };
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    // A stubbed 404 is logged by the browser itself; that is not a fault of the page.
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) s.errors.push(msg.text());
  });

  // The console Worker's routes.
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === '/api/me') return json(route, { sub: 'console', user_id: 'console' });
    if (path === '/api/labs') return json(route, LABS);
    if (path === '/api/onboarding') {
      s.onboardingFetches++;
      if (opts.onboarding === 'none') return json(route, { error: { code: 'no_onboarding', message: 'No onboarding quiz is published' } }, 404);
      if (opts.onboarding === 'error') return json(route, { error: 'boom' }, 500);
      // A quiz as the API served it before questions had a level: the console must not offer it.
      if (opts.onboarding === 'legacy') return json(route, { version: 1, intro: onboarding.intro, questions: onboarding.questions.map(({ level: _l, ...q }) => q) });
      return json(route, { version: 1, ...onboarding });
    }
    if (path === '/api/learn/answers' && method === 'POST') {
      s.posted.push(JSON.parse(route.request().postData() ?? '{}'));
      return json(route, { ok: true, recorded: 1 }, 201);
    }
    if (path.startsWith('/api/learn/') && method === 'GET') {
      const slug = decodeURIComponent(path.slice('/api/learn/'.length));
      s.learnFetches.push(slug);
      if (slug === GATEWAY) return json(route, { version: '1.0.0', learn: bundle });
      if (slug === NOQUIZ) return json(route, { version: '1.0.0', learn: { ...bundle, questions: [] } });
      if (slug === LEARN_500) return json(route, { error: 'boom' }, 500);
      return json(route, { error: { code: 'no_learn', message: 'no learning content' } }, 404);
    }
    if (path === '/api/start' && method === 'POST') {
      const { lab: slug } = JSON.parse(route.request().postData() ?? '{}');
      s.starts.push(slug);
      return json(route, { id: SESSION_ID, state: 'starting', token: 'test-token', urls: { services: {} } }, 202);
    }
    return json(route, { error: 'not stubbed' }, 404);
  });

  // The API the session talks to, cross-origin.
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const p = url.pathname;
    const base = `/sessions/${SESSION_ID}`;
    if (p === base && method === 'GET') {
      const now = Date.now();
      return json(route, {
        meta: { state: 'running', lab_slug: s.starts.at(-1) ?? opts.lab ?? GATEWAY, started_at: now, expires_at: now + 3_600_000, end_reason: null },
        services: {},
        snapshots: [],
        cost: { usd: 0 },
        hints: { total: 0, schedule: [], delivered: [] },
        checks_history: [],
        server_time: now,
      });
    }
    if (p === `${base}/events`) return; // held open: the stream simply never says anything
    if (p === `${base}/files` && method === 'GET') {
      const names = ['brief.md', ...[...s.files.keys()]];
      return json(route, names.map((name) => ({ name, size: name === 'brief.md' ? 30 : (s.files.get(name)?.length ?? 0), isDirectory: false })));
    }
    const file = p.startsWith(`${base}/files/`) ? decodeURIComponent(p.slice(`${base}/files/`.length)) : null;
    if (file !== null && method === 'GET') {
      if (file === 'brief.md') return json(route, { content: '# The brief\n\nSend a few calls and compare.' });
      const text = s.files.get(file);
      return text === undefined ? json(route, { error: { code: 'not_found', message: `${file} does not exist` } }, 404) : json(route, { content: text });
    }
    if (file !== null && method === 'PUT') {
      if (opts.putDelayMs) await new Promise((r) => setTimeout(r, opts.putDelayMs));
      const body = req.postData() ?? '';
      s.files.set(file, body);
      s.puts.push({ path: file, body });
      return json(route, { ok: true });
    }
    if (p === `${base}/checks` && method === 'POST') {
      s.checkRuns++;
      const now = Date.now();
      return json(route, {
        run_id: `run-${s.checkRuns}`,
        started_at: now - 500,
        finished_at: now,
        results: [
          { name: 'support answered by a', pass: true, weight: 1 },
          { name: 'token count matches', pass: false, weight: 2, message: 'expected 11' },
        ],
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

type Mastery = {
  onboarding?: { status: 'done' | 'skipped' | null; at?: number; levels?: Record<string, string> };
  concepts?: Record<string, { known: boolean }>;
  overrides?: Record<string, string>;
};

/** Opens the console with some of this browser's state already in place. */
async function open(page: Page, { mastery, theme }: { mastery?: Mastery | null; theme?: 'light' | 'dark' } = {}) {
  await page.addInitScript(
    ([m, t]) => {
      // The "How this console works" dialog is another spec's business.
      localStorage.setItem('opalixOnboarded', '1');
      // Seeded once, so a reload in the test keeps what the page stored since.
      if (m && !sessionStorage.getItem('seeded')) {
        localStorage.setItem('opalixLearn', m as string);
        sessionStorage.setItem('seeded', '1');
      }
      if (t) localStorage.setItem('opalixTheme', t as string);
    },
    [mastery ? JSON.stringify({ v: 1, ...mastery }) : null, theme ?? null] as const
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
}

const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('opalixLearn') ?? 'null'));

/** A mastery record where the platform quiz has been skipped, so it does not interrupt. */
const SKIPPED: Mastery = { onboarding: { status: 'skipped', at: 1, levels: {} } };

const screen = (page: Page) => page.locator('#learnScreen');
const heading = (page: Page) => screen(page).locator('[data-learn-heading]');

/** Picks options for a question (right or deliberately wrong), checks, and reads the verdict. */
async function answer(page: Page, questions: Question[], right: boolean): Promise<{ question: Question; correct: boolean }> {
  const prompt = (await page.locator('.quiz-prompt').innerText()).trim();
  const question = questions.find((q) => q.prompt === prompt);
  if (!question) throw new Error(`no question with the prompt "${prompt}"`);
  const pick = right ? question.answer : [question.options.find((o) => !question.answer.includes(o.id))!.id];
  for (const id of pick) await page.locator(`.quiz-option[data-option="${id}"] input`).check();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  const feedback = page.locator('.quiz-feedback');
  await expect(feedback).toHaveAttribute('data-result', right ? 'correct' : 'incorrect');
  await expect(feedback).toContainText(right ? 'Correct.' : 'Not quite.');
  await expect(feedback).toContainText(question.explanation);
  return { question, correct: right };
}

const next = (page: Page) => page.locator('.quiz-form .learn-actions button').filter({ hasNotText: 'Check' }).click();

/** Answers every question that follows, right where `right(question)` says so; returns what was answered. */
async function runQuiz(page: Page, questions: Question[], right: (q: Question) => boolean): Promise<Question[]> {
  const asked: Question[] = [];
  for (;;) {
    if (!(await page.locator('.quiz-prompt').count())) break;
    const { question } = await answer(page, questions, right(await currentQuestion(page, questions)));
    asked.push(question);
    await next(page);
  }
  return asked;
}

/**
 * Goes on through the rest of the flow (the next rounds and lessons), answering with `right`, until
 * the last step's own Start the lab is on screen (the last lessons', or the last question's once answered).
 */
async function toTheEnd(page: Page, questions: Question[], right: (q: Question) => boolean): Promise<void> {
  for (let guard = 0; guard < 60; guard++) {
    if (await page.locator('.quiz-prompt').count()) {
      await answer(page, questions, right(await currentQuestion(page, questions)));
      const label = (await page.locator('.quiz-form .learn-actions button').filter({ hasNotText: 'Check' }).innerText()).trim();
      if (label === 'Start the lab') return;
      await next(page);
    } else if (await page.locator('#btnNextStep').count()) {
      await page.locator('#btnNextStep').click();
    } else {
      return;
    }
  }
  throw new Error('the flow did not end');
}

async function currentQuestion(page: Page, questions: Question[]): Promise<Question> {
  const prompt = (await page.locator('.quiz-prompt').innerText()).trim();
  return questions.find((q) => q.prompt === prompt)!;
}

/** The page is not wider than the window; on failure, names the elements that stick out. */
const noHorizontalScroll = async (page: Page) => {
  const over = await page.evaluate(() => {
    const width = window.innerWidth;
    const wide: string[] = [];
    // An element inside something that clips or scrolls (a code block, a tab strip) is not what widens the page.
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

/** Starts the gateway lab from its card, past the learn screens when there are any. */
async function enterSession(page: Page) {
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#statePill')).toHaveText('running');
  await expect(page.locator('#bootModal')).toBeHidden();
}

// =========================================================================
// the platform quiz: a short, branching probe
// =========================================================================

/** Ticks areas (by id) on the first screen, then presses Start. */
async function startQuiz(page: Page, ...areas: string[]) {
  for (const a of areas) await page.locator(`.ob-choice input[value="${a}"]`).check();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
}

/** The button that moves past an answered question: "Next", or "See where to start" on the last. */
const nextQuestion = (page: Page) => page.getByRole('button', { name: /^(Next|See where to start)$/ }).click();

/** Answers the question on screen (right or deliberately wrong), then moves on; returns it. */
async function step(page: Page, right: boolean): Promise<Question> {
  const { question } = await answer(page, onboarding.questions, right);
  await nextQuestion(page);
  return question;
}

/** Answers every question that follows with `right(question)`; returns what was asked, in order. */
async function probeAll(page: Page, right: (q: Question) => boolean): Promise<Question[]> {
  const asked: Question[] = [];
  while (await page.locator('.quiz-prompt').count()) {
    const q = await currentQuestion(page, onboarding.questions);
    asked.push(await step(page, right(q)));
  }
  return asked;
}

const levelOf = (page: Page, area: string) => page.locator(`.level-row[data-area="${area}"] .level-chip`);

test.describe('the platform quiz', () => {
  test('opens on "What have you worked with?": a checklist of the six areas, and nothing about a number of questions', async ({ page }) => {
    const s = await stub(page);
    await open(page);

    await expect(screen(page)).toBeVisible();
    await expect(page.locator('#launcher')).toBeHidden();
    await expect(heading(page)).toHaveText('What have you worked with?');
    await expect(heading(page)).toBeFocused();
    await expect(screen(page)).toContainText('no score');
    const text = await screen(page).innerText();
    expect(text).not.toMatch(/\b18\b|\b\d+\s+questions\b|\b4 minutes\b|\bminutes\b/i);
    expect(text).not.toMatch(/Question \d+ of \d+/);

    // A real fieldset with a legend, holding one real checkbox per area in module order, then "None of these yet".
    const set = screen(page).locator('fieldset.ob-set');
    await expect(set).toHaveCount(1);
    await expect(set.locator('legend')).toHaveText('Pick the areas you have worked with');
    const boxes = set.locator('input[type="checkbox"]');
    await expect(boxes).toHaveCount(AREAS.length + 1);
    for (const [i, a] of AREAS.entries()) {
      await expect(boxes.nth(i)).toHaveAttribute('value', a.area);
      const choice = set.locator('.ob-choice').nth(i);
      await expect(choice.locator('.ob-choice-title')).toHaveText(a.title);
      await expect(choice.locator('.ob-choice-blurb')).toHaveText(onboarding.areas.find((x) => x.area === a.area)!.blurb);
      expect(onboarding.areas.find((x) => x.area === a.area)!.blurb.length).toBeLessThanOrEqual(90);
      // Each checkbox is named by its title (and blurb).
      await expect(page.getByRole('checkbox', { name: new RegExp(a.title) })).toHaveCount(1);
    }
    await expect(page.getByRole('checkbox', { name: /None of these yet/ })).toHaveCount(1);
    await expect(boxes.last()).toHaveAttribute('value', 'none');
    await expect(boxes.locator('xpath=self::*[@checked]')).toHaveCount(0);

    // "Skip for now" is always there; "Start" needs a choice and says so when pressed without one.
    await expect(page.getByRole('button', { name: 'Skip for now' })).toBeEnabled();
    const start = page.getByRole('button', { name: 'Start', exact: true });
    await expect(start).toHaveAttribute('aria-disabled', 'true');
    // aria-disabled, not disabled: it can still be pressed, and then says what is missing (force skips Playwright's enabled wait).
    await start.click({ force: true });
    await expect(screen(page).locator('.ob-message')).toContainText(/Choose at least one/);
    await expect(heading(page)).toHaveText('What have you worked with?');
    await page.locator('.ob-choice input[value="rag"]').check();
    await expect(start).toHaveAttribute('aria-disabled', 'false');
    await expect(screen(page).locator('.ob-message')).toBeHidden();
    await screenshotLayoutCheck(page);
    expect(s.posted).toEqual([]);
  });

  test('"None of these yet" is exclusive with the areas', async ({ page }) => {
    await stub(page);
    await open(page);
    const box = (v: string) => page.locator(`.ob-choice input[value="${v}"]`);
    await box('gateway').check();
    await box('rag').check();
    await box('none').check();
    await expect(box('gateway')).not.toBeChecked();
    await expect(box('rag')).not.toBeChecked();
    await expect(box('none')).toBeChecked();
    await box('otel').check();
    await expect(box('none')).not.toBeChecked();
    await expect(box('otel')).toBeChecked();
  });

  test('wrong at the basic question stops that area after ONE question and moves to the next ticked area', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await startQuiz(page, 'mcp', 'gateway'); // ticked out of order: asked in module order

    // Progress names the area and the step, never "Question 3 of 18".
    await expect(heading(page)).toHaveText(stepText('gateway', 1));
    await expect(heading(page)).toBeFocused();
    await expect(screen(page).locator('.learn-eyebrow')).toHaveText('Area 1 of 2');
    expect(await screen(page).innerText()).not.toMatch(/Question \d+ of \d+(?! of up)|of 18/);
    await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible();
    expect((await currentQuestion(page, onboarding.questions)).id).toBe(probe('gateway', 'basic').id);

    // Checking with nothing chosen says so and does not move on.
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.locator('.quiz-feedback')).toContainText(/Choose/);
    await expect(heading(page)).toHaveText(stepText('gateway', 1));

    await answer(page, onboarding.questions, false);
    await expect(page.locator('.quiz-feedback')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('.quiz-feedback')).toBeFocused();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeVisible();
    await nextQuestion(page);

    // Not the gateway's advanced question: the next area's first one.
    await expect(heading(page)).toHaveText(stepText('mcp', 1));
    await expect(screen(page).locator('.learn-eyebrow')).toHaveText('Area 2 of 2');
    expect((await currentQuestion(page, onboarding.questions)).id).toBe(probe('mcp', 'basic').id);
    await answer(page, onboarding.questions, false);
    // The last answer of the last area offers the summary.
    await expect(page.getByRole('button', { name: 'See where to start' })).toBeVisible();
    await nextQuestion(page);

    await expect(heading(page)).toHaveText('Where to start');
    await expect(heading(page)).toBeFocused();
    for (const a of AREAS) await expect(levelOf(page, a.area)).toHaveText('New');
    await expect(screen(page).locator('.learn-lede')).toHaveText('Start with module 1, LLM gateway.');

    // Only the two questions that were asked went out, once, anonymously.
    await expect.poll(() => s.posted.length).toBe(1);
    const body = s.posted[0]!;
    expect(Object.keys(body)).toEqual(['answers']);
    expect(body.answers.map((a: any) => a.question_id)).toEqual([probe('gateway', 'basic').id, probe('mcp', 'basic').id]);
    for (const a of body.answers) {
      expect(Object.keys(a).sort()).toEqual(['concept', 'correct', 'phase', 'question_id']);
      expect(a.phase).toBe('onboarding');
      expect(a.correct).toBe(false);
    }
    expect(JSON.stringify(body)).not.toMatch(/user|session|console|subject/i);
    expect(s.errors).toEqual([]);
  });

  test('right at basic then right at advanced is strong; the rest are new, with their own summary lines', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await startQuiz(page, 'mcp');
    await expect(heading(page)).toHaveText(stepText('mcp', 1));
    const asked: string[] = [];
    asked.push((await step(page, true)).id);
    await expect(heading(page)).toHaveText(stepText('mcp', 2));
    await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible();
    await answer(page, onboarding.questions, true);
    asked.push((await currentQuestion(page, onboarding.questions)).id);
    await expect(page.getByRole('button', { name: 'See where to start' })).toBeVisible();
    await nextQuestion(page);
    expect(asked).toEqual([probe('mcp', 'basic').id, probe('mcp', 'advanced').id]);

    // The summary: one row per module from the registry, a chip and a line each, no marks.
    await expect(heading(page)).toHaveText('Where to start');
    await expect(page.locator('.level-row')).toHaveCount(AREAS.length);
    for (const a of AREAS) {
      const row = page.locator(`.level-row[data-area="${a.area}"]`);
      await expect(row).toContainText(`Module ${a.module}`);
      await expect(row).toContainText(a.title);
      await expect(levelOf(page, a.area)).toHaveText(a.area === 'mcp' ? 'Strong' : 'New');
      await expect(row.locator('.level-line')).toContainText(a.area === 'mcp' ? 'short recaps' : `Start with module ${a.module}`);
    }
    await expect(screen(page).locator('.learn-lede')).toHaveText('Start with module 1, LLM gateway.');
    await expect(screen(page)).toContainText('You can retake this any time from the ? menu.');
    expect(await screen(page).innerText()).not.toMatch(/\b(score|scored|grade|graded|points|percent)\b|\d+\s*%/i);

    await expect.poll(() => s.posted.length).toBe(1);
    expect(s.posted[0]!.answers.map((a: any) => [a.question_id, a.correct])).toEqual([[probe('mcp', 'basic').id, true], [probe('mcp', 'advanced').id, true]]);

    await page.getByRole('button', { name: 'Go to the labs' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(screen(page)).toBeHidden();
    // The first module that is new gets the chip: module 1, not the strong module 2.
    await expect(page.locator('.badge-suggested')).toHaveCount(1);
    // Home marks the path that holds it; the path's page marks the module: module 1, not the strong module 2.
    await expect(page.locator('#path-ai-platform .badge-suggested')).toHaveText('Suggested start');
    await onPath(page);
    await expect(page.locator('.badge-suggested')).toHaveCount(1);
    await expect(page.locator('.module-card[data-module="1"] .badge-suggested')).toHaveText('Suggested start');

    // Stored in this browser, and never shown again by itself.
    const m = await stored(page);
    expect(m.onboarding.status).toBe('done');
    expect(m.onboarding.levels).toEqual({ gateway: 'new', mcp: 'strong', rag: 'new', otel: 'new', platform: 'new', sovereignty: 'new' });
    await page.reload();
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('.module-card').first()).toBeVisible();
    await expect(screen(page)).toBeHidden();
    expect(s.errors).toEqual([]);
  });

  test('right at basic, wrong at advanced is familiar (ok); several areas, each settled before the next', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await startQuiz(page, 'rag', 'gateway');
    const asked: Question[] = [];
    // gateway: basic right, advanced wrong; rag: basic wrong.
    asked.push(await step(page, true));
    await expect(heading(page)).toHaveText(stepText('gateway', 2));
    asked.push(await step(page, false));
    await expect(heading(page)).toHaveText(stepText('rag', 1));
    asked.push(await step(page, false));
    expect(asked.map((q) => q.id)).toEqual([probe('gateway', 'basic').id, probe('gateway', 'advanced').id, probe('rag', 'basic').id]);

    await expect(heading(page)).toHaveText('Where to start');
    await expect(levelOf(page, 'gateway')).toHaveText('Familiar');
    await expect(page.locator('.level-row[data-area="gateway"] .level-line')).toContainText('Some of module 1 is familiar');
    await expect(levelOf(page, 'rag')).toHaveText('New');
    await expect(screen(page).locator('.learn-lede')).toHaveText('Start with module 2, Tools and MCP.');
    await expect.poll(() => s.posted.length).toBe(1);
    expect(s.posted[0]!.answers).toHaveLength(3);
    expect((await stored(page)).onboarding.levels.gateway).toBe('ok');
  });

  test('an area you did not tick gets no question at all and starts as new', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await startQuiz(page, 'otel');
    const asked = await probeAll(page, () => true);
    expect(asked).toHaveLength(2);
    for (const q of asked) expect(q.concept.startsWith('otel.')).toBe(true);
    await expect(heading(page)).toHaveText('Where to start');
    for (const a of AREAS) await expect(levelOf(page, a.area)).toHaveText(a.area === 'otel' ? 'Strong' : 'New');
    await expect.poll(() => s.posted.length).toBe(1);
    for (const a of s.posted[0]!.answers) expect(a.concept.startsWith('otel.')).toBe(true);
    expect(s.posted[0]!.answers).toHaveLength(2);
  });

  test('the most it ever asks is two per ticked area: all six wrong is 6 questions, all six right is 12', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await startQuiz(page, ...AREAS.map((a) => a.area));
    expect(await probeAll(page, () => false)).toHaveLength(AREAS.length);
    await expect(heading(page)).toHaveText('Where to start');
    await expect.poll(() => s.posted.length).toBe(1);
    expect(s.posted[0]!.answers).toHaveLength(AREAS.length);
    await page.getByRole('button', { name: 'Go to the labs' }).click();

    await page.locator('#btnRetakeQuiz').click();
    await startQuiz(page, ...AREAS.map((a) => a.area));
    const asked = await probeAll(page, () => true);
    expect(asked).toHaveLength(AREAS.length * 2);
    expect(asked.map((q) => q.level)).toEqual(AREAS.flatMap(() => ['basic', 'advanced']));
    await expect(page.locator('.level-row[data-level="strong"]')).toHaveCount(AREAS.length);
    await expect(screen(page).locator('.learn-lede')).toHaveText('You can start with any module.');
    expect(asked.some((q) => q.type === 'multi')).toBe(true);
  });

  test('"None of these yet" goes straight to the summary with every area new, asking nothing', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await startQuiz(page, 'none');
    await expect(heading(page)).toHaveText('Where to start');
    await expect(page.locator('.quiz-prompt')).toHaveCount(0);
    await expect(page.locator('.level-row')).toHaveCount(AREAS.length);
    await expect(page.locator('.level-row[data-level="new"]')).toHaveCount(AREAS.length);
    await expect(screen(page).locator('.learn-lede')).toHaveText('Start with module 1, LLM gateway.');
    // Nothing was asked, so nothing is sent; the result is stored as done.
    await page.waitForTimeout(200);
    expect(s.posted).toEqual([]);
    const m = await stored(page);
    expect(m.onboarding.status).toBe('done');
    expect(Object.values(m.onboarding.levels)).toEqual(AREAS.map(() => 'new'));
    await page.getByRole('button', { name: 'Go to the labs' }).click();
    await onPath(page);
    await expect(page.locator('.module-card[data-module="1"] .badge-suggested')).toHaveCount(1);
    await page.reload();
    await page.waitForSelector('body[data-booted="1"]');
    await expect(screen(page)).toBeHidden();
  });

  test('"Not sure" reveals the answer kindly and counts as not knowing it yet, at basic (new) and at advanced (familiar)', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await startQuiz(page, 'gateway', 'mcp');
    const q = await currentQuestion(page, onboarding.questions);
    await page.getByRole('button', { name: 'Not sure' }).click();
    const feedback = page.locator('.quiz-feedback');
    await expect(feedback).toHaveAttribute('data-result', 'unsure');
    await expect(feedback).toHaveAttribute('aria-live', 'polite');
    await expect(feedback).toBeFocused();
    await expect(feedback).toContainText('No problem.');
    await expect(feedback).toContainText(q.explanation);
    expect((await feedback.innerText()).toLowerCase()).not.toMatch(/wrong|incorrect|fail|not quite/);
    await expect(page.locator(`.quiz-option[data-option="${q.answer[0]}"] .quiz-option-flag`)).toContainText('Correct answer');
    await expect(page.getByRole('button', { name: 'Not sure' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Check', exact: true })).toBeHidden();
    await nextQuestion(page);

    // Gateway stopped at one question; mcp: right at basic, then "Not sure" at advanced.
    await expect(heading(page)).toHaveText(stepText('mcp', 1));
    await step(page, true);
    await expect(heading(page)).toHaveText(stepText('mcp', 2));
    await page.getByRole('button', { name: 'Not sure' }).click();
    await expect(page.getByRole('button', { name: 'See where to start' })).toBeVisible();
    await nextQuestion(page);

    await expect(levelOf(page, 'gateway')).toHaveText('New');
    await expect(levelOf(page, 'mcp')).toHaveText('Familiar');
    await expect.poll(() => s.posted.length).toBe(1);
    expect(s.posted[0]!.answers.map((a: any) => a.correct)).toEqual([false, true, false]);
  });

  test('a multiple-choice question in the probe is checkboxes; a single-choice one is radios', async ({ page }) => {
    await stub(page);
    await open(page);
    // Platform opens with a single-choice or multiple-choice basic question, as the file says; sovereignty's advanced is multiple.
    await startQuiz(page, 'platform', 'sovereignty');
    const kind = (q: Question) => (q.type === 'multi' ? 'checkbox' : 'radio');
    const b1 = probe('platform', 'basic');
    await expect(page.locator('.quiz-option input').first()).toHaveAttribute('type', kind(b1));
    await step(page, false);
    const b2 = probe('sovereignty', 'basic');
    await expect(page.locator('.quiz-option input').first()).toHaveAttribute('type', kind(b2));
    await step(page, true);
    const a2 = probe('sovereignty', 'advanced');
    await expect(page.locator('.quiz-option input').first()).toHaveAttribute('type', kind(a2));
    const kinds = new Set([b1.type, b2.type, a2.type]);
    expect(kinds.has('multi')).toBe(true);
    await expect(page.locator('.quiz-hint')).toHaveText(a2.type === 'multi' ? 'Choose all that apply.' : 'Choose one answer.');
  });

  test('"Skip for now" from the first screen is remembered and the quiz never comes back by itself', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await expect(heading(page)).toHaveText('What have you worked with?');
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(screen(page)).toBeHidden();
    expect((await stored(page)).onboarding.status).toBe('skipped');
    expect(s.posted).toEqual([]);
    // No "Suggested start" without a quiz.
    await expect(page.locator('.badge-suggested')).toHaveCount(0);

    await page.reload();
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('.path-card').first()).toBeVisible();
    await expect(screen(page)).toBeHidden();
    // Give a late offer the time it would need.
    await page.waitForTimeout(500);
    await expect(screen(page)).toBeHidden();
    expect(s.errors).toEqual([]);
  });

  test('"Skip for now" in the middle of the quiz leaves, and records nothing but the skip', async ({ page }) => {
    const s = await stub(page);
    await open(page);
    await startQuiz(page, 'gateway', 'mcp');
    await step(page, true);
    await expect(heading(page)).toHaveText(stepText('gateway', 2));
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    const m = await stored(page);
    expect(m.onboarding.status).toBe('skipped');
    expect(m.onboarding.levels).toEqual({});
    expect(s.posted).toEqual([]);
    await page.reload();
    await page.waitForSelector('body[data-booted="1"]');
    await page.waitForTimeout(300);
    await expect(screen(page)).toBeHidden();
  });

  test('can be retaken from the header; skipping a retake keeps the levels already earned', async ({ page }) => {
    const levels = { gateway: 'strong', mcp: 'ok', rag: 'new' };
    const s = await stub(page);
    await open(page, { mastery: { onboarding: { status: 'done', at: 5, levels } } });
    await expect(page.locator('.path-card').first()).toBeVisible();
    await expect(screen(page)).toBeHidden();

    // Next to the help control.
    const retake = page.locator('#btnRetakeQuiz');
    await expect(retake).toBeVisible();
    const help = await page.locator('#btnHelp').boundingBox();
    const at = await retake.boundingBox();
    expect(Math.abs(at!.y - help!.y)).toBeLessThan(20);

    await retake.click();
    await expect(heading(page)).toHaveText('What have you worked with?');
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    expect((await stored(page)).onboarding).toEqual({ status: 'done', at: 5, levels });
    expect(s.posted).toEqual([]);
  });

  test('can be retaken from the ? menu, and the summary says so', async ({ page }) => {
    await stub(page);
    await open(page);
    await startQuiz(page, 'none');
    await expect(screen(page)).toContainText('You can retake this any time from the ? menu.');
    await page.getByRole('button', { name: 'Go to the labs' }).click();
    await expect(page.locator('#launcher')).toBeVisible();

    await page.locator('#btnHelp').click();
    await expect(page.locator('#onboarding')).toHaveAttribute('open', '');
    await expect(page.locator('#btnOnboardingRetake')).toBeVisible();
    await page.locator('#btnOnboardingRetake').click();
    await expect(heading(page)).toHaveText('What have you worked with?');
    await expect(page.locator('#onboarding')).not.toHaveAttribute('open', '');
    // A fresh checklist each time: nothing pre-ticked.
    await expect(page.locator('.ob-choice input:checked')).toHaveCount(0);
  });

  test('a finished retake replaces the levels and moves the suggestion', async ({ page }) => {
    await stub(page);
    await open(page, { mastery: { onboarding: { status: 'done', at: 5, levels: { gateway: 'new', mcp: 'strong' } } } });
    await onPath(page);
    await expect(page.locator('.module-card[data-module="1"] .badge-suggested')).toHaveCount(1);
    await page.locator('#btnRetakeQuiz').click();
    await startQuiz(page, 'gateway');
    await probeAll(page, () => true);
    await expect(heading(page)).toHaveText('Where to start');
    // Unticked areas are new on a retake too: the suggestion moves to module 2.
    await expect(levelOf(page, 'gateway')).toHaveText('Strong');
    await expect(levelOf(page, 'mcp')).toHaveText('New');
    await page.getByRole('button', { name: 'Go to the labs' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator('.badge-suggested')).toHaveCount(1);
    await onPath(page);
    await expect(page.locator('.module-card[data-module="2"] .badge-suggested')).toHaveCount(1);
    const m = await stored(page);
    expect(m.onboarding.levels.gateway).toBe('strong');
    expect(m.onboarding.levels.mcp).toBe('new');
  });

  test('does not appear, and offers no retake, when there is no quiz, it cannot be read, or it has the old shape', async ({ page }) => {
    for (const mode of ['none', 'error', 'legacy'] as const) {
      const p = await page.context().newPage();
      const s = await stub(p, { onboarding: mode });
      await open(p);
      await expect(p.locator('.path-card').first()).toBeVisible();
      await p.waitForTimeout(300);
      await expect(screen(p)).toBeHidden();
      await expect(p.locator('#btnRetakeQuiz')).toBeHidden();
      expect(s.onboardingFetches).toBeGreaterThan(0);
      expect(s.errors).toEqual([]);
      await p.close();
    }
  });

  test('the quiz waits for the first-run dialog to be read', async ({ page }) => {
    await stub(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('#onboarding')).toHaveAttribute('open', '');
    await expect(screen(page)).toBeHidden();
    await page.getByRole('button', { name: 'Got it' }).click();
    await expect(heading(page)).toHaveText('What have you worked with?');
  });

  test('is keyboard operable and keeps the answer in words, not colour alone', async ({ page }) => {
    await stub(page);
    await open(page);
    // Focus starts on the heading; Tab reaches the first checkbox, Space ticks it.
    await page.keyboard.press('Tab');
    await expect(page.locator('.ob-choice input[value="gateway"]')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('.ob-choice input[value="gateway"]')).toBeChecked();
    // Through the other five areas and "None of these yet" to Start.
    for (let i = 0; i < AREAS.length + 1; i++) await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(heading(page)).toHaveText(stepText('gateway', 1));
    await expect(heading(page)).toBeFocused();

    const q = probe('gateway', 'basic');
    // Tab into the options, choose with the keyboard, check with Enter.
    await page.locator('.quiz-option input').first().focus();
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Check', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.quiz-feedback')).toBeFocused();
    const right = q.answer.length === 1 && q.answer[0] === q.options[0]!.id;
    await expect(page.locator('.quiz-feedback')).toContainText(right ? 'Correct.' : 'Not quite.');
    // The correct option says so in text.
    await expect(page.locator(`.quiz-option[data-option="${q.answer[0]}"] .quiz-option-flag`)).toContainText('Correct answer');
  });

  test('keeps the 390px layout: no sideways scroll on any step, and the checklist is one column of 44px targets', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stub(page);
    await open(page);
    await noHorizontalScroll(page);
    const boxes = await page.locator('.ob-choice').evaluateAll((els) => els.map((e) => ({ left: Math.round(e.getBoundingClientRect().left), h: e.getBoundingClientRect().height })));
    expect(new Set(boxes.map((b) => b.left)).size).toBe(1);
    for (const b of boxes) expect(b.h).toBeGreaterThanOrEqual(44);
    await startQuiz(page, 'gateway', 'sovereignty');
    await noHorizontalScroll(page);
    await step(page, true);
    await noHorizontalScroll(page);
    await step(page, true);
    await noHorizontalScroll(page);
    await expect(heading(page)).toHaveText(stepText('sovereignty', 1));
    await page.getByRole('button', { name: 'Not sure' }).click();
    await noHorizontalScroll(page);
    await nextQuestion(page);
    await expect(heading(page)).toHaveText('Where to start');
    await noHorizontalScroll(page);
  });
});

// =========================================================================
// Before you begin
// =========================================================================

/**
 * Moves to a page of the launcher without leaving the app (what a link does): the history gets the
 * address, and the console shows it. The pages are home, a path and a module.
 */
async function goToPage(page: Page, url: string, marker: string) {
  await page.evaluate((u) => {
    history.pushState(null, '', u);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, url);
  await expect(page.locator(marker).first()).toBeVisible();
}
const onPath = (page: Page) => goToPage(page, '/paths/ai-platform', '.module-card');

/** Presses Start on a lab's row, on the page of the module that holds it. */
async function startLab(page: Page, slug: string) {
  const row = page.locator(`.lab[data-slug="${slug}"] .lab-start`);
  if (!(await row.count())) await goToPage(page, `/paths/ai-platform/modules/${(LABS as unknown as Array<{ slug: string; module: number }>).find((l) => l.slug === slug)!.module}`, '.module .lab');
  await row.click();
}

/** Starts the gateway lab from its row. */
const startCard = (page: Page) => startLab(page, GATEWAY);

test.describe('Before you begin', () => {
  test('shows the story first, and does not start the session until Start the lab is pressed', async ({ page }) => {
    const s = await stub(page);
    await open(page, { mastery: SKIPPED });
    await startCard(page);

    await expect(screen(page)).toBeVisible();
    await expect(page.locator('#launcher')).toBeHidden();
    await expect(heading(page)).toHaveText(bundle.story!.title);
    await expect(heading(page)).toBeFocused();
    await expect(screen(page).locator('.learn-meta')).toHaveText(`${bundle.story!.minutes} min read`);
    // Rendered markdown, not its source.
    await expect(screen(page).locator('.learn-prose p').first()).toBeVisible();
    expect(await screen(page).locator('.learn-prose').innerText()).not.toMatch(/\*\*|`/);
    expect(s.learnFetches).toEqual([GATEWAY]);
    expect(s.starts).toEqual([]);

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toHaveText(ROUND_1);
    expect(s.starts).toEqual([]);
    await expect(page.getByRole('button', { name: 'Skip all, just start the lab' })).toBeVisible();
    expect(s.errors).toEqual([]);
  });

  test('asks Round 1 one question per screen, one about each concept, and collapses the concept that was answered fully right', async ({ page }) => {
    const s = await stub(page);
    await open(page, { mastery: SKIPPED });
    await startCard(page);
    await page.getByRole('button', { name: 'Continue' }).click();

    // Know aliases, miss everything else.
    const asked = await runQuiz(page, bundle.questions, (q) => q.concept === ALIASES);
    expect(asked).toHaveLength(5);
    expect(asked.map((q) => q.concept)).toEqual(bundle.concepts.map((c) => c.id));
    expect(asked.every((q) => q.diagnostic !== false)).toBe(true);

    await expect(heading(page)).toHaveText(LESSONS_A);
    await expect(heading(page)).toBeFocused();
    const aliases = page.locator(`.lesson[data-concept="${ALIASES}"]`);
    await expect(aliases).toHaveAttribute('data-state', 'collapsed');
    await expect(aliases.locator('.lesson-recap')).toHaveText(lessonOf(ALIASES).recap);
    await expect(aliases.locator('.lesson-body')).toHaveCount(0);
    await expect(aliases.locator('.lesson-chip')).toHaveText('You know this');
    await expect(aliases.getByRole('button', { name: 'Show me the lesson anyway' })).toBeVisible();
    // The first chunk holds three of the five lessons: the rest are for after Round 2.
    await expect(page.locator('.lesson')).toHaveCount(CHUNK_A.length);
    for (const id of CHUNK_A.filter((id) => id !== ALIASES)) {
      const card = page.locator(`.lesson[data-concept="${id}"]`);
      await expect(card).toHaveAttribute('data-state', 'expanded');
      await expect(card.locator('.lesson-body')).toBeVisible();
      await expect(card.getByRole('button', { name: 'I know this, skip' })).toBeVisible();
    }
    await expect(page.locator('.plan-summary')).toContainText('1 folded to a recap');

    // The outcome is stored per concept, and each answer is posted anonymously as a diagnostic of this lab, once.
    const m = await stored(page);
    expect(m.concepts[ALIASES]).toEqual({ known: true });
    expect(m.concepts[SPEND]).toEqual({ known: false });
    await expect.poll(() => s.posted.length).toBe(5);
    for (const body of s.posted) {
      expect(body.lab_slug).toBe(GATEWAY);
      expect(body.lab_version).toBe('1.0.0');
      expect(body.answers).toHaveLength(1);
      expect(new Set(body.answers.map((a: any) => a.phase))).toEqual(new Set(['diagnostic']));
      expect(Object.keys(body).sort()).toEqual(['answers', 'lab_slug', 'lab_version']);
    }
    expect(new Set(s.posted.map((b) => b.answers[0].question_id)).size).toBe(5);
    expect(s.starts).toEqual([]);
  });

  test('one miss is enough to keep a concept open', async ({ page }) => {
    await stub(page);
    await open(page, { mastery: SKIPPED });
    await startCard(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    // Everything right except the aliases question.
    await runQuiz(page, bundle.questions, (q) => q.concept !== ALIASES);
    await expect(page.locator(`.lesson[data-concept="${ALIASES}"]`)).toHaveAttribute('data-state', 'expanded');
    await expect(page.locator(`.lesson[data-concept="${SPEND}"]`)).toHaveAttribute('data-state', 'collapsed');
    expect((await stored(page)).concepts[ALIASES]).toEqual({ known: false });
    expect((await stored(page)).concepts[SPEND]).toEqual({ known: true });
  });

  test('only asks about concepts that are not already known', async ({ page }) => {
    await stub(page);
    await open(page, { mastery: { ...SKIPPED, concepts: { [ALIASES]: { known: true } } } });
    await startCard(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    // 12 questions are left: two rounds of 6 with all the lessons between them.
    await expect(heading(page)).toHaveText('Round 1 of 2 · question 1 of 6');
    const asked = await runQuiz(page, bundle.questions, () => false);
    expect(asked.some((q) => q.concept === ALIASES)).toBe(false);
    expect(asked).toHaveLength(6);
    await expect(heading(page)).toHaveText('Lessons for this lab');
    await expect(page.locator('.lesson')).toHaveCount(bundle.concepts.length);
    // Still known, so still folded.
    await expect(page.locator(`.lesson[data-concept="${ALIASES}"]`)).toHaveAttribute('data-state', 'collapsed');
  });

  test('goes straight to the lessons when every concept is already known', async ({ page }) => {
    const known = Object.fromEntries(bundle.concepts.map((c) => [c.id, { known: true }]));
    await stub(page);
    await open(page, { mastery: { ...SKIPPED, concepts: known } });
    await startCard(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toHaveText('Lessons for this lab');
    await expect(page.locator('.lesson[data-state="collapsed"]')).toHaveCount(bundle.concepts.length);
    await expect(page.locator('.plan-summary')).toContainText('You already know what this lab needs');
  });

  test('the learner overrides: "Show me the lesson anyway" and "I know this, skip", remembered', async ({ page }) => {
    const s = await stub(page);
    await open(page, { mastery: SKIPPED });
    await startCard(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await runQuiz(page, bundle.questions, (q) => q.concept === ALIASES);

    const aliases = page.locator(`.lesson[data-concept="${ALIASES}"]`);
    const spend = page.locator(`.lesson[data-concept="${SPEND}"]`);

    // Open a folded lesson; its diagram and text appear, the button flips, focus stays on it.
    await aliases.getByRole('button', { name: 'Show me the lesson anyway' }).click();
    await expect(aliases).toHaveAttribute('data-state', 'expanded');
    await expect(aliases.locator('.lesson-body')).toBeVisible();
    await expect(aliases.locator('.lesson-chip')).toHaveText('Opened by you');
    await expect(aliases.getByRole('button', { name: 'I know this, skip' })).toBeFocused();

    // Fold an open one.
    await spend.getByRole('button', { name: 'I know this, skip' }).click();
    await expect(spend).toHaveAttribute('data-state', 'collapsed');
    await expect(spend.locator('.lesson-recap')).toHaveText(lessonOf(SPEND).recap);
    await expect(spend.locator('.lesson-chip')).toHaveText('Skipped');
    await expect(spend.getByRole('button', { name: 'Show me the lesson anyway' })).toBeFocused();

    const m = await stored(page);
    expect(m.overrides).toEqual({ [ALIASES]: 'forced', [SPEND]: 'skipped' });

    // A second start of the same lab respects them: forced stays open even though known, skipped stays folded.
    await page.getByRole('button', { name: '← Back to labs' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await startCard(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    // Aliases is known (nothing asked about it); the rest are asked again.
    await runQuiz(page, bundle.questions, () => false);
    await expect(page.locator(`.lesson[data-concept="${ALIASES}"]`)).toHaveAttribute('data-state', 'expanded');
    await expect(page.locator(`.lesson[data-concept="${SPEND}"]`)).toHaveAttribute('data-state', 'collapsed');
    expect(s.starts).toEqual([]);
  });

  test('a lesson shows its text and its embedded diagram', async ({ page }) => {
    await stub(page);
    await open(page, { mastery: SKIPPED });
    await startCard(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await runQuiz(page, bundle.questions, () => false);
    const card = page.locator(`.lesson[data-concept="${ALIASES}"]`);
    await expect(card.locator('.lesson-body p').first()).toBeVisible();
    const diagram = card.locator('.diagram');
    await expect(diagram.first()).toBeVisible();
    await expect(diagram.first().locator('svg')).toBeVisible();
    // The diagram is a labelled group with its steps available as text.
    await expect(diagram.first()).toHaveAttribute('role', 'group');
  });

  test('starts the lab only when Start the lab is pressed, then boots', async ({ page }) => {
    const s = await stub(page);
    await open(page, { mastery: SKIPPED });
    await startCard(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await runQuiz(page, bundle.questions, () => true);
    await expect(heading(page)).toHaveText(LESSONS_A);
    await expect(page.locator('.lesson[data-state="collapsed"]')).toHaveCount(CHUNK_A.length);
    expect(s.starts).toEqual([]);
    // Nothing starts the session on the way: it is the last step's Start the lab that does.
    await toTheEnd(page, bundle.questions, () => true);
    expect(s.starts).toEqual([]);
    await page.locator('[data-start="primary"]').click();
    await enterSession(page);
    expect(s.starts).toEqual([GATEWAY]);
    await expect(screen(page)).toBeHidden();
    expect(s.errors).toEqual([]);
  });

  test('"Skip all, just start the lab" starts from the story, before any question', async ({ page }) => {
    const s = await stub(page);
    await open(page, { mastery: SKIPPED });
    await startCard(page);
    await page.getByRole('button', { name: 'Skip all, just start the lab' }).click();
    await enterSession(page);
    expect(s.starts).toEqual([GATEWAY]);
    expect(s.posted).toEqual([]);
    // Nothing was decided on the learner's behalf.
    expect((await stored(page)).concepts ?? {}).toEqual({});
  });

  test('"Skip all, just start the lab" is on a question screen too, and "Back to labs" returns', async ({ page }) => {
    const s = await stub(page);
    await open(page, { mastery: SKIPPED });
    await startCard(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: '← Back to labs' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(screen(page)).toBeHidden();
    expect(s.starts).toEqual([]);

    await startCard(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Skip all, just start the lab' }).click();
    await enterSession(page);
    expect(s.starts).toEqual([GATEWAY]);
  });

  test('a failed start leaves the lessons on screen with the buttons working again', async ({ page }) => {
    const s = await stub(page);
    await page.route('**/api/start', (route) => json(route, { error: 'no container in a stubbed test' }, 500));
    await open(page, { mastery: { ...SKIPPED, concepts: Object.fromEntries(bundle.concepts.map((c) => [c.id, { known: true }])) } });
    await startCard(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('Could not start this lab');
    await expect(heading(page)).toHaveText('Lessons for this lab');
    await expect(page.getByRole('button', { name: 'Start the lab', exact: true })).toBeEnabled();
    await expect(page.locator('#workspace')).toBeHidden();
    expect(s.starts).toEqual([]);
  });

  test("a 'strong' platform area starts the lessons folded when the lab asks no questions of its own", async ({ page }) => {
    const s = await stub(page);
    await open(page, { mastery: { onboarding: { status: 'done', at: 1, levels: { gateway: 'strong' } } } });
    await startLab(page, NOQUIZ);
    await page.getByRole('button', { name: 'Continue' }).click();
    // No question to ask: the lessons are next, folded because the quiz said this area is strong.
    await expect(heading(page)).toHaveText('Lessons for this lab');
    for (const c of bundle.concepts) {
      const card = page.locator(`.lesson[data-concept="${c.id}"]`);
      await expect(card).toHaveAttribute('data-state', 'collapsed');
      await expect(card.locator('.lesson-chip')).toHaveText('Familiar from your quiz');
    }
    expect(s.posted).toEqual([]);
    expect(s.starts).toEqual([]);
  });

  test('an answered diagnostic beats a strong area: a missed concept opens', async ({ page }) => {
    await stub(page);
    await open(page, { mastery: { onboarding: { status: 'done', at: 1, levels: { gateway: 'strong' } } } });
    await startCard(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await runQuiz(page, bundle.questions, (q) => q.concept !== SPEND);
    await expect(heading(page)).toHaveText(LESSONS_A);
    await expect(page.locator(`.lesson[data-concept="${SPEND}"]`)).toHaveAttribute('data-state', 'expanded');
    await expect(page.locator(`.lesson[data-concept="${ALIASES}"]`)).toHaveAttribute('data-state', 'collapsed');
  });

  test('keeps to the screen width at 390px', async ({ page }) => {
    await stub(page);
    await open(page, { mastery: SKIPPED });
    // A phone cannot start a lab (see "the desktop notice"), so the screen is opened on a wide window
    // and the window is then narrowed to a phone's: the screens themselves must fit.
    await startCard(page);
    await expect(heading(page)).toHaveText(bundle.story!.title);
    await page.setViewportSize({ width: 390, height: 844 });
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await noHorizontalScroll(page);
    await runQuiz(page, bundle.questions, () => false);
    await expect(heading(page)).toHaveText(LESSONS_A);
    await noHorizontalScroll(page);
    for (const box of await page.locator('#learnScreen .lesson, #learnScreen .quiz-option, #learnScreen .diagram').all()) {
      const r = await box.boundingBox();
      if (r) expect(r.x + r.width).toBeLessThanOrEqual(390.5);
    }
  });
});

// =========================================================================
// in the session
// =========================================================================

const ANSWERS_TEMPLATE = JSON.stringify({ support_deployment: null, support_tokens_hello: null, unknown_alias_status: null }, null, 2) + '\n';

/** Starts the gateway lab and goes straight in. */
async function intoSession(page: Page, opts: StubOptions = {}, mastery: Mastery = SKIPPED) {
  const s = await stub(page, { files: { 'answers.json': ANSWERS_TEMPLATE }, ...opts });
  await open(page, { mastery });
  await startCard(page);
  await page.getByRole('button', { name: 'Skip all, just start the lab' }).click();
  await enterSession(page);
  // The guide's tabs are built once the brief has loaded.
  await expect(page.locator('#tabBrief')).toBeVisible();
  await expect(page.locator('#tabQuestions')).toBeVisible();
  return s;
}

const field = (page: Page, key: string) => page.locator(`.qfield[data-key="${key}"]`);
const lastPut = (s: Stub) => JSON.parse(s.puts.at(-1)!.body) as Answers;

test.describe('the session screen has neither the story nor the lessons', () => {
  test('an explore lab opens on its Brief, then Questions and Hints: no Story tab, no Lessons tab', async ({ page }) => {
    await intoSession(page);
    await expect(page.locator('.tab-active')).toHaveText('Brief');
    const tabs = await page.locator('#guideTabs .tab:visible').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.guideTab));
    expect(tabs).toEqual(['brief', 'questions', 'hints']);
    await expect(page.getByRole('tab', { name: 'Story' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Lessons' })).toHaveCount(0);
    // The workspace window keeps its own tabs.
    expect(await page.locator('#workspaceTabs .tab:visible').allInnerTexts()).toEqual(['Terminal', 'Editor']);
  });

  test('renders no lesson, no diagram and no comic anywhere in the session, and none of the story', async ({ page }) => {
    await intoSession(page);
    await expect(page.locator('#workspace .lesson, #workspace .md-diagram, #workspace .cm, #workspace .learn-story')).toHaveCount(0);
    await expect(page.locator('#guideRail #railTabs button')).toHaveCount(3);
    const text = await page.locator('#workspace').innerText();
    expect(text).not.toContain(bundle.story!.title);
    for (const c of bundle.concepts) expect(text).not.toContain(c.title);
  });

  test('is on a phone-width page without widening it', async ({ page }) => {
    await intoSession(page);
    // Starting a lab is for a computer; a window narrowed after that must still hold together.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#viewBrief')).toBeVisible();
    await noHorizontalScroll(page);
    // The tab is reachable in the scrolling tab strip.
    await expect(page.getByRole('tab', { name: 'Questions' })).toBeAttached();
  });
});

test.describe('the Questions tab', () => {
  test('renders each field with its prompt and help, and loads the current values', async ({ page }) => {
    await intoSession(page, {
      files: { 'answers.json': JSON.stringify({ support_deployment: 'b', support_tokens_hello: 12, unknown_alias_status: null, notes: 'keep me' }) },
    });
    await page.getByRole('tab', { name: 'Questions' }).click();
    await expect(page.locator('#viewQuestions')).toBeVisible();
    await expect(page.locator('.qfield')).toHaveCount(bundle.fields.length);
    for (const f of bundle.fields) {
      const box = field(page, f.key);
      await expect(box).toContainText(f.prompt.replace(/`/g, ''));
      if (f.help) await expect(box.locator('.qfield-help')).toContainText(f.help.slice(0, 30));
    }
    // A choice with two choices is radios; a number is a number input.
    await expect(field(page, 'support_deployment').locator('input[type="radio"]')).toHaveCount(2);
    await expect(field(page, 'support_tokens_hello').locator('input[type="number"]')).toBeVisible();
    // Current values, from the file.
    await expect(field(page, 'support_deployment').locator('input[value="b"]')).toBeChecked();
    await expect(field(page, 'support_tokens_hello').locator('input')).toHaveValue('12');
    await expect(field(page, 'unknown_alias_status').locator('input')).toHaveValue('');
    // The controls are labelled and described.
    const input = field(page, 'support_tokens_hello').locator('input');
    await expect(input).toHaveAccessibleName(/total token count/);
    await expect(input).toHaveAccessibleDescription(/send_calls\.py/);
  });

  test('writes answers.json as JSON with the right types after a pause, and says Saved', async ({ page }) => {
    const s = await intoSession(page, {
      files: { 'answers.json': JSON.stringify({ support_deployment: null, support_tokens_hello: null, unknown_alias_status: null, notes: 'keep me' }) },
    });
    await page.getByRole('tab', { name: 'Questions' }).click();
    await expect(page.locator('.qfield')).toHaveCount(bundle.fields.length);
    const status = page.locator('.qform-status');

    await field(page, 'support_deployment').locator('input[value="a"]').check();
    await expect(status).toHaveText('Unsaved changes');
    // Typing several characters is one write, after ~600 ms of quiet.
    const tokens = field(page, 'support_tokens_hello').locator('input');
    await tokens.pressSequentially('11', { delay: 40 });
    const before = s.puts.length;
    expect(before).toBe(0);
    await expect(status).toHaveText('Saved', { timeout: 5000 });
    expect(s.puts).toHaveLength(1);
    expect(s.puts[0]!.path).toBe('answers.json');
    const written = JSON.parse(s.puts[0]!.body);
    expect(written).toEqual({ support_deployment: 'a', support_tokens_hello: 11, unknown_alias_status: null, notes: 'keep me' });
    expect(typeof written.support_tokens_hello).toBe('number');
    expect(written.unknown_alias_status).toBeNull();
    // Unknown keys survive.
    expect(written.notes).toBe('keep me');

    // Emptying a number writes null, not 0 or "".
    await tokens.fill('');
    await expect(status).toHaveText('Saved', { timeout: 5000 });
    expect(lastPut(s).support_tokens_hello).toBeNull();
    // A decimal stays a number.
    await field(page, 'unknown_alias_status').locator('input').fill('404');
    await expect(status).toHaveText('Saved', { timeout: 5000 });
    expect(lastPut(s).unknown_alias_status).toBe(404);
  });

  test('the Save button writes at once', async ({ page }) => {
    const s = await intoSession(page);
    await page.getByRole('tab', { name: 'Questions' }).click();
    await field(page, 'support_deployment').locator('input[value="b"]').check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.qform-status')).toHaveText('Saved');
    expect(lastPut(s).support_deployment).toBe('b');
    expect(s.puts.length).toBe(1);
  });

  const UNREADABLE: Array<[string, Record<string, string>]> = [
    ['missing', {}],
    ['not JSON', { 'answers.json': '{ this is not json' }],
    ['not an object', { 'answers.json': '[1,2,3]' }],
  ];
  for (const [what, files] of UNREADABLE) {
    test(`a file that is ${what} reads as empty, and is written out whole`, async ({ page }) => {
      const s = await intoSession(page, { files });
      await page.getByRole('tab', { name: 'Questions' }).click();
      await expect(page.locator('.qfield')).toHaveCount(bundle.fields.length);
      await expect(page.locator('.qfield input[type="number"]').first()).toHaveValue('');
      await expect(page.locator('.qfield input[type="radio"]:checked')).toHaveCount(0);
      await field(page, 'unknown_alias_status').locator('input').fill('500');
      await expect(page.locator('.qform-status')).toHaveText('Saved', { timeout: 5000 });
      // Every field is in the file, the untouched ones null.
      expect(lastPut(s)).toEqual({ support_deployment: null, support_tokens_hello: null, unknown_alias_status: 500 });
      expect(s.errors).toEqual([]);
    });
  }

  test('re-reads before writing and merges by key when the file changed in the editor meanwhile', async ({ page }) => {
    const s = await intoSession(page, { files: { 'answers.json': JSON.stringify({ support_deployment: null, support_tokens_hello: null, unknown_alias_status: null, notes: 'v1' }) } });
    await page.getByRole('tab', { name: 'Questions' }).click();
    await expect(page.locator('.qfield')).toHaveCount(bundle.fields.length);

    // Someone edits the file: a key the form shows but the learner has not touched, and a key it does not know.
    s.files.set('answers.json', JSON.stringify({ support_deployment: 'b', support_tokens_hello: null, unknown_alias_status: 404, notes: 'edited in the editor', extra: [1] }));

    // The learner changes a different key in the form.
    await field(page, 'support_tokens_hello').locator('input').fill('22');
    await expect(page.locator('.qform-status')).toHaveText('Saved', { timeout: 5000 });
    expect(lastPut(s)).toEqual({ support_deployment: 'b', support_tokens_hello: 22, unknown_alias_status: 404, notes: 'edited in the editor', extra: [1] });
    // What the editor wrote now shows in the untouched controls.
    await expect(field(page, 'support_deployment').locator('input[value="b"]')).toBeChecked();
    await expect(field(page, 'unknown_alias_status').locator('input')).toHaveValue('404');

    // A key the learner changed wins over an edit to the same key.
    s.files.set('answers.json', JSON.stringify({ support_deployment: 'a', support_tokens_hello: 99, unknown_alias_status: 404, notes: 'again' }));
    await field(page, 'support_tokens_hello').locator('input').fill('23');
    await expect(page.locator('.qform-status')).toHaveText('Saved', { timeout: 5000 });
    expect(lastPut(s)).toEqual({ support_deployment: 'a', support_tokens_hello: 23, unknown_alias_status: 404, notes: 'again' });
  });

  test('shows an edit made elsewhere when the tab is opened again', async ({ page }) => {
    const s = await intoSession(page);
    await page.getByRole('tab', { name: 'Questions' }).click();
    await expect(page.locator('.qfield')).toHaveCount(bundle.fields.length);
    await page.getByRole('tab', { name: 'Brief' }).click();
    s.files.set('answers.json', JSON.stringify({ support_deployment: 'b', support_tokens_hello: 7, unknown_alias_status: null }));
    await page.getByRole('tab', { name: 'Questions' }).click();
    await expect(field(page, 'support_tokens_hello').locator('input')).toHaveValue('7');
    await expect(field(page, 'support_deployment').locator('input[value="b"]')).toBeChecked();
  });

  test('a failed write says so and keeps the answers for another try', async ({ page }) => {
    const s = await intoSession(page);
    await page.route(`${API}/sessions/${SESSION_ID}/files/answers.json`, (route) => (route.request().method() === 'PUT' ? json(route, { error: 'disk full' }, 500) : route.fallback()));
    await page.getByRole('tab', { name: 'Questions' }).click();
    await field(page, 'unknown_alias_status').locator('input').fill('500');
    await expect(page.locator('.qform-status')).toContainText('Not saved', { timeout: 5000 });
    await expect(field(page, 'unknown_alias_status').locator('input')).toHaveValue('500');
    expect(s.puts).toEqual([]);
  });

  test('Check my answers saves what is pending, then runs the console’s own checks', async ({ page }) => {
    const s = await intoSession(page);
    await page.getByRole('tab', { name: 'Questions' }).click();
    await field(page, 'support_deployment').locator('input[value="a"]').check();
    await page.locator('#btnRunChecksForm').click();
    await expect(page.locator('.qform-checks')).toContainText('1/3 pts · 1/2 checks');
    // The write came first, and the existing Checks panel shows the same run.
    expect(lastPut(s).support_deployment).toBe('a');
    expect(s.checkRuns).toBe(1);
    await expect(page.locator('#checksPanel .check')).toHaveCount(2);
    await expect(page.locator('#checksSummary')).toContainText('1/3 pts');
  });

  test('the editor and the form agree: a write is shown in an open, unmodified answers.json', async ({ page }) => {
    const s = await intoSession(page);
    await page.locator('#fileList button', { hasText: 'answers.json' }).click();
    await expect(page.locator('#editorPath')).toHaveText('answers.json');
    await expect(page.locator('#editorMount .cm-content')).toContainText('support_deployment');
    await page.getByRole('tab', { name: 'Questions' }).click();
    await field(page, 'unknown_alias_status').locator('input').fill('418');
    await expect(page.locator('.qform-status')).toHaveText('Saved', { timeout: 5000 });
    await page.getByRole('tab', { name: 'Editor' }).click();
    await expect(page.locator('#editorMount .cm-content')).toContainText('418');
    expect(s.puts).toHaveLength(1);
  });

  test('keeps to the screen width at 390px', async ({ page }) => {
    await intoSession(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: 'Questions' }).click();
    await expect(page.locator('.qfield')).toHaveCount(bundle.fields.length);
    await noHorizontalScroll(page);
    const rights = await page.locator('#questionsBody .qfield, #questionsBody input, #questionsBody .qform-actions').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
    for (const right of rights) expect(right).toBeLessThanOrEqual(390.5);
  });
});

// =========================================================================
// labs without learning content
// =========================================================================

test.describe('a lab without learning content', () => {
  test('goes straight to the boot, fetches no bundle and adds no tabs', async ({ page }) => {
    const s = await stub(page);
    await open(page, { mastery: SKIPPED });
    await startLab(page, PLAIN);
    await enterSession(page);
    expect(s.starts).toEqual([PLAIN]);
    expect(s.learnFetches).toEqual([]);
    await expect(screen(page)).toBeHidden();
    await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('#tabQuestions')).toBeHidden();
    expect(await page.locator('#guideTabs .tab:visible').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.guideTab))).toEqual(['brief', 'checks', 'hints']);
    expect(await page.locator('#workspaceTabs .tab:visible').allInnerTexts()).toEqual(['Terminal', 'Editor']);
    await expect(page.locator('.tab-active')).toHaveText('Brief');
    expect(s.errors).toEqual([]);
  });

  for (const [what, slug] of [['is missing (404)', LEARN_404], ['fails (500)', LEARN_500]] as const) {
    test(`a lab marked has_learn whose bundle ${what} also goes straight to the boot`, async ({ page }) => {
      const s = await stub(page);
      await open(page, { mastery: SKIPPED });
      await startLab(page, slug);
      await enterSession(page);
      expect(s.learnFetches).toContain(slug);
      expect(s.starts).toEqual([slug]);
      await expect(page.locator('#learnScreen')).toBeHidden();
      await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
      await expect(page.locator('#tabQuestions')).toBeHidden();
      expect(s.errors).toEqual([]);
    });
  }

  test('a remembered running session is resumed as before, with no learning screens in between', async ({ page }) => {
    const s = await stub(page, { lab: PLAIN });
    // The console comes back to the session this browser was in.
    await page.addInitScript(([id]) => localStorage.setItem('opalix.session', JSON.stringify({ id, token: 'test-token', lab: 'see-how-requests-are-routed-plain', urls: { services: {} } })), [SESSION_ID]);
    await open(page, { mastery: SKIPPED });
    // Booted straight into the remembered session: no launcher, no learn screen.
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(screen(page)).toBeHidden();
    expect(s.learnFetches).toEqual([]);
  });
});

// =========================================================================
// the desktop notice: a phone cannot run a lab
// =========================================================================

/** Every request that would make or rejoin a session: the console's start route and the API's session routes. */
function watchSessionRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname === '/api/start' || (req.url().startsWith(API) && url.pathname.startsWith('/sessions'))) seen.push(`${req.method()} ${url.pathname}`);
  });
  return seen;
}

const PHONE = { width: 390, height: 844 };
const notice = (page: Page) => page.locator('#desktopNotice');
/** A browser that remembers a lab that is still running (PLAIN), as after closing the tab. */
const rememberRunning = (page: Page) =>
  page.addInitScript(([id]) => localStorage.setItem('opalix.session', JSON.stringify({ id, token: 'test-token', lab: 'see-how-requests-are-routed-plain', urls: { services: {} } })), [SESSION_ID]);

test.describe('the desktop notice', () => {
  test('Start on a phone shows the notice instead of starting: no session is requested', async ({ page }) => {
    const s = await stub(page, { lab: PLAIN });
    const requests = watchSessionRequests(page);
    await page.setViewportSize(PHONE);
    await open(page, { mastery: SKIPPED });
    await startLab(page, PLAIN);

    await expect(notice(page)).toBeVisible();
    await expect(page.locator('#dnTitle')).toHaveText('Labs work best on a desktop.');
    await expect(page.locator('#dnTitle')).toBeFocused();
    await expect(page.locator('#launcher')).toBeHidden();
    await expect(page.locator('#workspace')).toBeHidden();
    await expect(page.locator('#bootModal')).toBeHidden();
    expect(s.starts).toEqual([]);
    expect(requests).toEqual([]);
    // Nothing is offered that does not work here, and nothing sticks out.
    await expect(page.locator('#dnRunning')).toBeHidden();
    await noHorizontalScroll(page);
    expect(s.errors).toEqual([]);
  });

  test('a lab with lessons gets the notice too, before any learning screen and without fetching the lesson', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(PHONE);
    await open(page, { mastery: SKIPPED });
    await startCard(page);
    await expect(notice(page)).toBeVisible();
    await expect(screen(page)).toBeHidden();
    expect(s.learnFetches).toEqual([]);
    expect(s.starts).toEqual([]);
  });

  test('offers the link by email and to copy, and a way back to the labs', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await stub(page);
    await page.setViewportSize(PHONE);
    await open(page, { mastery: SKIPPED });
    await startLab(page, PLAIN);
    const origin = new URL(page.url()).origin;

    const email = page.getByRole('link', { name: 'Email me the link' });
    const href = (await email.getAttribute('href'))!;
    expect(href.startsWith('mailto:?subject=')).toBe(true);
    const params = new URLSearchParams(href.slice('mailto:?'.length));
    expect(params.get('subject')).toMatch(/desktop/i);
    // The link names the lab that was about to start, not just the console: a link to the lab itself.
    expect(params.get('body')).toContain(`${origin}/labs/${PLAIN}`);

    // Copying puts this origin's URL on the clipboard and says so.
    await page.getByRole('button', { name: 'Copy the link' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    await expect(page.locator('#dnStatus')).toHaveText('Link copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/labs/${PLAIN}`);
    await expect(page.locator('#dnManual')).toBeHidden();

    await page.getByRole('button', { name: 'Browse the labs anyway' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(notice(page)).toBeHidden();
    // The page the learner was on (the module's) is back, and its heading takes the focus.
    await expect(page.locator('.module .lab').first()).toBeVisible();
    await expect(page.locator('.module-title')).toBeFocused();
  });

  test('where the clipboard cannot be written the link is shown selected', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
    await stub(page);
    await page.setViewportSize(PHONE);
    await open(page, { mastery: SKIPPED });
    await startLab(page, PLAIN);
    await page.getByRole('button', { name: 'Copy the link' }).click();
    const field = page.getByLabel('Link to this console');
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(`${new URL(page.url()).origin}/labs/${PLAIN}`);
    const selected = await field.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0));
    expect(selected).toBe(`${new URL(page.url()).origin}/labs/${PLAIN}`);
    await expect(page.locator('#dnStatus')).toContainText('selected');
  });

  test('a lab that is still running waits as a card: Rejoin on a phone explains, and starts nothing', async ({ page }) => {
    const s = await stub(page, { lab: PLAIN });
    const requests = watchSessionRequests(page);
    await rememberRunning(page);
    await page.setViewportSize(PHONE);
    await open(page, { mastery: SKIPPED });
    // A phone does not walk back into the lab on load: it sees the launcher, with the lab in progress.
    await expect(page.locator('#workspace')).toBeHidden();
    await expect(page.locator('#launcher')).toBeVisible();
    const resume = page.locator('#resumeCard');
    await expect(resume).toBeVisible();
    await expect(page.locator('#heroTitle')).toHaveText('Pick up where you left off.');
    await expect(resume).toContainText('See how requests are routed');
    await expect(resume).toContainText('left');
    // Its row, on the module's page, says Resume.
    await goToPage(page, '/paths/ai-platform/modules/2', '.module .lab');
    await expect(page.locator(`.lab[data-slug="${PLAIN}"] .lab-start`)).toHaveText('Resume');
    await goToPage(page, '/', '.path-card');
    await expect(resume).toBeVisible();

    await page.getByRole('button', { name: /Rejoin the lab/ }).click();
    await expect(notice(page)).toBeVisible();
    // The running lab is on the notice, to be rejoined from a computer.
    await expect(page.locator('#dnRunning')).toBeVisible();
    await expect(page.locator('#dnRunningTitle')).toHaveText('See how requests are routed');
    await expect(page.locator('#dnRunningMeta')).toContainText('rejoin from a computer');
    expect(s.starts).toEqual([]);
    // The status of the remembered lab was read; nothing was started or rejoined.
    expect(requests.filter((r) => r.startsWith('POST'))).toEqual([]);
    // The record stays for the computer.
    expect(await page.evaluate(() => localStorage.getItem('opalix.session'))).toContain(SESSION_ID);
    await noHorizontalScroll(page);
  });

  test('on a desktop the same Start starts the lab, with no notice', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, { mastery: SKIPPED });
    await startLab(page, PLAIN);
    await enterSession(page);
    expect(s.starts).toEqual([PLAIN]);
    await expect(notice(page)).toBeHidden();
  });

  test('the line is 760px: one pixel narrower is a phone, 760 starts a lab', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize({ width: 759, height: 900 });
    await open(page, { mastery: SKIPPED });
    await startLab(page, PLAIN);
    await expect(notice(page)).toBeVisible();
    expect(s.starts).toEqual([]);
    // Widening the window brings the launcher back by itself.
    await page.setViewportSize({ width: 760, height: 900 });
    await expect(notice(page)).toBeHidden();
    await expect(page.locator('#launcher')).toBeVisible();
    await startLab(page, PLAIN);
    await enterSession(page);
    expect(s.starts).toEqual([PLAIN]);
  });

  test('a window shrunk after Before you begin opened is asked again when Start the lab is pressed', async ({ page }) => {
    const s = await stub(page);
    await open(page, { mastery: SKIPPED });
    await startCard(page);
    await expect(heading(page)).toHaveText(bundle.story!.title);
    await page.setViewportSize(PHONE);
    await page.getByRole('button', { name: 'Skip all, just start the lab' }).click();
    await expect(notice(page)).toBeVisible();
    await expect(screen(page)).toBeHidden();
    expect(s.starts).toEqual([]);
  });

  test('a tablet held upright (a touch screen under 900px) gets the notice; turned sideways it does not', async ({ browser, staticServer }) => {
    const context = await browser.newContext({ baseURL: staticServer, viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      const s = await stub(page);
      await open(page, { mastery: SKIPPED });
      await startLab(page, PLAIN);
      await expect(notice(page)).toBeVisible();
      expect(s.starts).toEqual([]);
      await page.setViewportSize({ width: 1180, height: 820 });
      await expect(notice(page)).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test('reading still works on a phone: the launcher, its filters, the lessons list and the quiz are not gated', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(PHONE);
    await open(page, { mastery: null });
    // The quiz opens on its own and can be done.
    await expect(heading(page)).toHaveText('What have you worked with?');
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await page.locator('#labSearch').fill('routed');
    await expect(page.locator('#labCount')).toHaveText(`1 of ${LABS.length} labs`);
    await expect(page.locator('.path-card')).toHaveCount(1);
    await onPath(page);
    await expect(page.locator('.module-card')).toHaveCount(1);
    await expect(page.locator('.module-card')).toHaveAttribute('data-module', '2');
    await noHorizontalScroll(page);
    expect(s.starts).toEqual([]);
  });
});

// =========================================================================
// screenshots
// =========================================================================

/** Fails when a learning screen is wider than the window. */
async function screenshotLayoutCheck(page: Page) {
  await noHorizontalScroll(page);
}

const VARIANTS = [
  { name: 'light-1440', theme: 'light' as const, width: 1440, height: 900 },
  { name: 'dark-1440', theme: 'dark' as const, width: 1440, height: 900 },
  { name: 'light-390', theme: 'light' as const, width: 390, height: 844 },
  { name: 'dark-390', theme: 'dark' as const, width: 390, height: 844 },
];

test.describe('screenshots', () => {
  test.skip(process.env.LEARN_SHOTS === '0', 'LEARN_SHOTS=0');

  for (const v of VARIANTS) {
    test(`learning screens, ${v.name}`, async ({ page }) => {
      mkdirSync(SHOTS, { recursive: true });
      await page.setViewportSize({ width: v.width, height: v.height });
      await page.emulateMedia({ colorScheme: v.theme, reducedMotion: 'reduce' });
      await stub(page, { files: { 'answers.json': ANSWERS_TEMPLATE } });
      const shot = async (name: string) => {
        await noHorizontalScroll(page);
        await page.screenshot({ path: join(SHOTS, `${name}-${v.name}.png`), fullPage: false });
      };

      // The platform quiz: the checklist, a question mid-probe, the summary.
      await open(page, { theme: v.theme });
      await expect(heading(page)).toHaveText('What have you worked with?');
      await shot('onboarding-select');
      await page.locator('.ob-choice input[value="gateway"]').check();
      await page.locator('.ob-choice input[value="mcp"]').check();
      await shot('onboarding-select-ticked');
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await expect(heading(page)).toHaveText(stepText('gateway', 1));
      await step(page, true);
      await expect(heading(page)).toHaveText(stepText('gateway', 2));
      const adv = probe('gateway', 'advanced');
      await shot('onboarding-question-open');
      await page.locator(`.quiz-option[data-option="${adv.options.find((o) => !adv.answer.includes(o.id))!.id}"] input`).check();
      await page.getByRole('button', { name: 'Check', exact: true }).click();
      await shot('onboarding-question');
      await nextQuestion(page);
      await probeAll(page, () => false);
      await expect(heading(page)).toHaveText('Where to start');
      await shot('onboarding-summary');
      await page.getByRole('button', { name: 'Go to the labs' }).click();
      await expect(page.locator('.badge-suggested')).toHaveCount(1);
      await page.locator('.badge-suggested').scrollIntoViewIfNeeded();
      await shot('launcher-suggested');
      await page.locator('#launcher').evaluate((el) => { el.scrollTop = 0; window.scrollTo(0, 0); });
      await shot('launcher');
      if (v.width < 760) {
        await startLab(page, PLAIN);
        await expect(page.locator('#desktopNotice')).toBeVisible();
        await shot('desktop-notice');
        await page.getByRole('button', { name: 'Browse the labs anyway' }).click();
        await expect(page.locator('#launcher')).toBeVisible();
      }

      // A phone cannot start a lab, so the window is wide for the moment a lab is started and is then
      // put back: what is photographed is the phone-sized screen.
      const wide = async (act: () => Promise<unknown>) => {
        if (v.width >= 760) return act();
        await page.setViewportSize({ width: 1280, height: 800 });
        await act();
        await page.setViewportSize({ width: v.width, height: v.height });
      };

      // Before you begin: the story, a question, the lessons.
      await wide(() => startCard(page));
      await expect(heading(page)).toHaveText(bundle.story!.title);
      await shot('before-story');
      await page.getByRole('button', { name: 'Continue' }).click();
      await shot('before-question');
      await runQuiz(page, bundle.questions, (x) => x.concept === ALIASES);
      await expect(heading(page)).toHaveText(LESSONS_A);
      await shot('before-lessons');
      await page.locator(`.lesson[data-concept="${SPEND}"] .diagram`).first().scrollIntoViewIfNeeded();
      await shot('before-lessons-diagram');

      // In the session: the questions form.
      await wide(async () => {
        await page.getByRole('button', { name: 'Skip all, just start the lab' }).click();
        await enterSession(page);
      });
      await page.getByRole('tab', { name: 'Questions' }).click();
      await field(page, 'support_deployment').locator('input[value="a"]').check();
      await field(page, 'support_tokens_hello').locator('input').fill('11');
      await expect(page.locator('.qform-status')).toHaveText('Saved', { timeout: 5000 });
      await shot('questions');
    });
  }
});
