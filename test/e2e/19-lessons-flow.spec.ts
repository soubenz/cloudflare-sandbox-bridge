import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { parse as parseYaml } from 'yaml';

/**
 * The flow before a lab starts, and what the session screen no longer has.
 *
 *   story  ->  (the quick questions)  ->  the lessons, FULL SCREEN  ->  Start the lab
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
const PLAIN = 'a-lab-with-nothing-to-read';

const BUNDLES: Record<string, Bundle> = {
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
  posted: Array<Record<string, any>>;
  learnFetches: string[];
  errors: string[];
}

/** `lab` is the lab a session that was not started through /api/start reports (a rejoined one). */
async function stub(page: Page, { lab: rejoined = EXPLORE }: { lab?: string } = {}): Promise<Stub> {
  const waiting: Array<() => void> = [];
  const s: Stub = { starts: [], posted: [], learnFetches: [], errors: [] };
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

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/** The CSP the deployed console sends (public/_headers), so a violation is seen here. */
const CSP = /Content-Security-Policy:\s*(.+)/.exec(readFileSync(join(PUBLIC, '_headers'), 'utf8'))?.[1]?.trim();

function serve(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', ...(CSP ? { 'content-security-policy': CSP } : {}) });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server })));
}

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
}

/** Opens the console on the launcher, past the things that are other specs' business. */
async function open(page: Page, { theme, mastery = SKIPPED, comicTest = false, remembered }: OpenOptions = {}) {
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
  await page.goto(comicTest ? '/?comicTest=1' : '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
}

/** Every concept of the lab already known, so no question is asked and every lesson starts folded. */
const ALL_KNOWN: Mastery = { ...SKIPPED, concepts: Object.fromEntries(full.concepts.map((c) => [c.id, { known: true }])) };

const startCard = (page: Page, slug: string) => page.locator(`.lab[data-slug="${slug}"] .lab-start`).click();
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

/** Answers the quick question on screen, right or deliberately wrong, then moves on. */
async function answerNext(page: Page, right: (q: Question) => boolean) {
  const prompt = (await page.locator('.quiz-prompt').innerText()).trim();
  const q = full.questions.find((x) => x.prompt === prompt)!;
  const pick = right(q) ? q.answer : [q.options.find((o) => !q.answer.includes(o.id))!.id];
  for (const id of pick) await page.locator(`.quiz-option[data-option="${id}"] input`).check();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.locator('.quiz-feedback')).not.toBeEmpty();
  await page.locator('.quiz-form .learn-actions button').filter({ hasNotText: 'Check' }).click();
}
async function runQuiz(page: Page, right: (q: Question) => boolean) {
  let n = 0;
  while (await page.locator('.quiz-prompt').count()) {
    await answerNext(page, right);
    n++;
  }
  return n;
}

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
    await expect(heading(page)).toHaveText(`Question 1 of ${DIAGNOSTIC_COUNT}`);
    expect(await runQuiz(page, (q) => q.concept === ALIASES)).toBe(DIAGNOSTIC_COUNT);
    await expect(heading(page)).toHaveText(LESSONS);
    await expect(page.locator(`.lesson[data-concept="${ALIASES}"]`)).toHaveAttribute('data-state', 'collapsed');
    await expect(host(page).locator('.plan-summary')).toContainText('1 folded to a recap');
    expect(s.starts).toEqual([]);
  });

  test('says each step to a screen reader, moves focus to its heading, and counts the steps', async ({ page }) => {
    await begin(page, TEXT_STORY);
    const live = page.locator('#learnScreen > p.sr-only[role="status"]');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveText(`Step 1 of 2: ${full.story!.title}`);
    await expect(host(page).locator('.steps i.on')).toHaveCount(1);
    await expect(host(page).locator('.steps i')).toHaveCount(2);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(live).toHaveText('Step 2 of 2: Lessons');
    await expect(heading(page)).toBeFocused();
    await expect(host(page).locator('.steps i.on')).toHaveCount(2);
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
    await expect(host(page).locator('.steps i')).toHaveCount(1);
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
    await expect(host(page).locator('.steps i')).toHaveCount(1);
    // No story to go back to.
    await expect(page.getByRole('button', { name: '← Back to the story' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '← Back to labs' })).toBeVisible();
    await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
    await enterSession(page);
    expect(s.starts).toEqual([LESSONS_ONLY]);
  });

  test('a lab with lessons, no story and quick questions begins at the questions, then the lessons', async ({ page }) => {
    await begin(page, LESSONS_ASKING);
    await expect(heading(page)).toHaveText(`Question 1 of ${DIAGNOSTIC_COUNT}`);
    await runQuiz(page, () => false);
    await expect(heading(page)).toHaveText(LESSONS);
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
  test('Back to the story shows the story again, and Continue returns to the lessons without asking the questions twice', async ({ page }) => {
    const s = await begin(page, EXPLORE, { width: 1440, height: 900 }, { comicTest: true });
    await page.getByRole('button', { name: 'Continue' }).click();
    await runQuiz(page, () => false);
    await expect(heading(page)).toHaveText(LESSONS);
    expect(s.posted).toHaveLength(1);

    await page.getByRole('button', { name: '← Back to the story' }).click();
    await expect(heading(page)).toHaveText(full.story!.title);
    await expect(heading(page)).toBeFocused();
    await expect(host(page).locator('.cm')).toBeVisible();
    await expect(host(page).locator('.lesson')).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue' }).click();
    // The lessons, not Question 1 again; and nothing more was posted.
    await expect(heading(page)).toHaveText(LESSONS);
    expect(s.posted).toHaveLength(1);
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
  test('answers are stored per concept and posted as one anonymous diagnostic of the lab', async ({ page }) => {
    const s = await begin(page, EXPLORE);
    await page.getByRole('button', { name: 'Continue' }).click();
    await runQuiz(page, (q) => q.concept === ALIASES);
    await expect(heading(page)).toHaveText(LESSONS);
    const m = await page.evaluate(() => JSON.parse(localStorage.getItem('opalixLearn')!));
    expect(m.concepts[ALIASES]).toEqual({ known: true });
    expect(Object.values(m.concepts).filter((c: any) => c.known === false).length).toBe(full.concepts.length - 1);
    await expect.poll(() => s.posted.length).toBe(1);
    const body = s.posted[0]!;
    expect(body.lab_slug).toBe(EXPLORE);
    expect(body.lab_version).toBe('1.0.0');
    expect(body.answers).toHaveLength(DIAGNOSTIC_COUNT);
    expect(new Set(body.answers.map((a: any) => a.phase))).toEqual(new Set(['diagnostic']));
    expect(Object.keys(body).sort()).toEqual(['answers', 'lab_slug', 'lab_version']);
  });

  test('the Questions tab of the running session is unaffected: it renders its fields and counts the answers', async ({ page }) => {
    const s = await begin(page, EXPLORE);
    await page.getByRole('button', { name: 'Continue' }).click();
    await runQuiz(page, () => true);
    await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
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
    await runQuiz(page, () => false);
    await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
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
    await open(page, { remembered: BUILD });
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
    await open(page, { remembered: EXPLORE });
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

      // The quick questions, one of them.
      await page.getByRole('button', { name: 'Continue' }).click();
      await shot('questions');
      await runQuiz(page, (q) => q.concept === ALIASES);

      // The lessons, full screen: the top, then a lesson with its diagram, then the foot.
      await expect(heading(page)).toHaveText(LESSONS);
      await shot('lessons-top');
      const open = host(page).locator('.lesson[data-state="expanded"]').nth(1);
      await open.scrollIntoViewIfNeeded();
      await shot('lessons-diagram');
      await host(page).locator('.learn-actions-sticky').scrollIntoViewIfNeeded();
      await shot('lessons-foot');

      // The session screen's guide: an explore lab, then a build lab.
      await page.getByRole('button', { name: 'Start the lab', exact: true }).click();
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
