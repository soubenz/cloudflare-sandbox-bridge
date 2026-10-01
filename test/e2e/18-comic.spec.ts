import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Locator, type Page, type Route } from '@playwright/test';
import { parse as parseYaml } from 'yaml';

/**
 * The motion comic in the console: it plays in "Before you begin" (the story step) and nowhere
 * else, not in the session's guide; Replay and Skip are its only buttons; Skip ends it on the
 * finished comic and Replay starts it over; reduced motion shows it finished;
 * "Read as text" lists every panel; a lab with no comic (or one that cannot be
 * drawn) still shows the text story; nothing scrolls sideways at any width.
 *
 * Like 16-learning.spec.ts and 17-session-layout.spec.ts this needs no password,
 * no API and no container: a static server serves dashboard/public (the built
 * bundle, with the CSP from public/_headers) and every call the console makes is
 * answered by a route stub. The content is real: the learn bundle and the comic
 * are compiled from labs/see-what-a-gateway-does/learn, and a three-page comic with
 * the whole cast is written here.
 *
 * Screenshots are deterministic: with ?comicTest=1 the comic's clock does not run by
 * itself and window.__comicClock steps it, so "7 seconds in" is the same picture
 * every time. (That seam does not exist without the parameter; a test checks.)
 *
 * Run `npm run build:dashboard` first (the page loads dashboard/public/dist).
 * COMIC_SHOTS_DIR chooses where the screenshots go (default test/e2e/shots/comic);
 * COMIC_SHOTS=0 skips them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC = join(ROOT, 'dashboard/public');
const API = 'https://opalix-sandbox.soubenz94.workers.dev';
const SHOTS = process.env.COMIC_SHOTS_DIR || join(here, 'shots/comic');
const SESSION_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';

// --------------------------------------------------------------- the content

interface Panel {
  scene: string;
  cast: string[];
  bg?: string;
  prop: string;
  caption?: string;
  bubbles: Array<{ who?: string; text: string; pos?: string }>;
  sfx?: string;
  lines?: string[];
}
interface Comic {
  title: string;
  pages: Array<{ title?: string; panels: Panel[] }>;
}
interface Bundle {
  story?: { title: string; minutes: number; body: string };
  comic?: Comic;
  concepts: Array<{ id: string; title: string; minutes: number; recap: string; body: string }>;
  questions: unknown[];
  answers_file: string;
  fields: Array<{ key: string; prompt: string; kind: string; choices?: string[]; help?: string }>;
}

const panelOf = (p: Record<string, any>): Panel => ({ cast: [], prop: 'none', bubbles: [], ...p }) as unknown as Panel;

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
      return { id: data.id, title: data.title, minutes: data.minutes, recap: data.recap, body };
    });
  const quiz = parseYaml(readFileSync(join(dir, 'quiz.yaml'), 'utf8')) as { questions: Array<Record<string, unknown>> };
  const qs = parseYaml(readFileSync(join(dir, 'questions.yaml'), 'utf8')) as { answers_file: string; fields: Bundle['fields'] };
  const out: Bundle = {
    story: { title: story.data.title, minutes: story.data.minutes, body: story.body },
    concepts,
    questions: quiz.questions.map((q) => ({ diagnostic: true, ...q })),
    answers_file: qs.answers_file,
    fields: qs.fields,
  };
  const comicFile = join(dir, 'comic.yaml');
  if (existsSync(comicFile)) {
    const raw = parseYaml(readFileSync(comicFile, 'utf8')) as { title: string; panels?: Array<Record<string, any>>; pages?: Array<{ title?: string; panels: Array<Record<string, any>> }> };
    out.comic = { title: raw.title, pages: (raw.pages ?? [{ panels: raw.panels ?? [] }]).map((pg) => ({ ...(pg.title ? { title: pg.title } : {}), panels: pg.panels.map(panelOf) })) };
  }
  return out;
}

const EXPLORE = 'see-what-a-gateway-does';
const MULTI = 'follow-one-request-through-the-stack';
const NO_COMIC = 'see-how-requests-are-routed';
const BROKEN = 'prove-where-one-requests-data-went';
const PLAIN = 'see-how-tools-reach-an-agent';
const bundle = compileLearn(EXPLORE);
const single = bundle.comic!;

/** Three pages with the whole cast: a titled page of four, an untitled page of four, a closing titled page. */
const multi: Comic = {
  title: 'One slow request, no explanation',
  pages: [
    {
      title: 'Tuesday afternoon',
      panels: [
        panelOf({ scene: 'desk', cast: ['priya'], bg: 'sand', caption: 'Support, a little after two.', bubbles: [{ who: 'priya', text: 'This one took ages. Why did the assistant take so long to answer?' }], lines: ['agent: waiting on a reply...', 'waiting...', 'still waiting...'] }),
        panelOf({ scene: 'message', cast: ['jonas'], bg: 'lilac', prop: 'envelope', sfx: 'PING!', bubbles: [{ who: 'jonas', text: 'And what did it cost? I need a number per request.' }] }),
        panelOf({ scene: 'portrait', cast: ['maren'], bg: 'ice', prop: 'chart', sfx: 'HMM.', bubbles: [{ who: 'maren', text: 'That request was traced end to end. One request, four services, six spans. Read it.' }] }),
        panelOf({ scene: 'duo', cast: ['tomasz', 'anneke'], bg: 'mint', bubbles: [{ who: 'tomasz', text: 'The trace is in the lab.' }, { who: 'anneke', text: 'And nothing in it leaves the region.' }] }),
      ],
    },
    {
      panels: [
        panelOf({ scene: 'screen', caption: 'A small copy of the stack, and a trace to read.', lines: ['$ open jaeger, click Find Traces', '200 1 trace, 4 services, 6 spans', 'slowest span, not the top one: ?', '4xx cache.get missed'] }),
        panelOf({ scene: 'duo', cast: ['priya', 'anneke'], bg: 'rose', bubbles: [{ who: 'priya', text: 'Can customers see any of this?' }, { who: 'anneke', text: 'Only what we decide to show them.' }] }),
        panelOf({ scene: 'portrait', cast: ['anneke'], bg: 'navy', prop: 'document', bubbles: [{ who: 'anneke', text: 'Write down what you find, in numbers.' }] }),
        panelOf({ scene: 'desk', cast: ['tomasz'], bg: 'ice', prop: 'laptop', bubbles: [{ who: 'tomasz', text: 'I will keep the gateway up while you look.' }], lines: ['$ gateway --status', 'ready.'] }),
      ],
    },
    {
      title: 'Your turn',
      panels: [panelOf({ scene: 'you', bg: 'navy', caption: 'Your turn.', lines: ['$ cat /workspace/answers.json', 'ready.'] }), panelOf({ scene: 'message', cast: ['maren'], bg: 'sand', prop: 'key', sfx: 'GO!', bubbles: [{ who: 'maren', text: 'The lab is open.' }] })],
    },
  ],
};

const lab = (o: Record<string, unknown>): Record<string, any> => ({
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
  lab({ slug: MULTI, title: 'Follow one request through the stack', order: 2 }),
  lab({ slug: NO_COMIC, title: 'See how requests are routed', order: 3 }),
  lab({ slug: BROKEN, title: 'Prove where one request data went', order: 4 }),
  lab({ slug: PLAIN, title: 'See how tools reach an agent', order: 5, has_learn: false }),
];

/** The bundle each lab serves: the first has the real comic, the second a three-page one, the third none, the fourth one that cannot be drawn. */
const BUNDLES: Record<string, Bundle> = {
  [EXPLORE]: bundle,
  [MULTI]: { ...bundle, comic: multi },
  [NO_COMIC]: { ...bundle, comic: undefined },
  [BROKEN]: { ...bundle, comic: { title: 'Broken', pages: [{ panels: [{ scene: 'rocket' }] }] } as unknown as Comic },
};

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
  errors: string[];
}

async function stub(page: Page): Promise<Stub> {
  const waiting: Array<() => void> = [];
  const s: Stub = { starts: [], errors: [] };
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
    if (path.startsWith('/api/learn/') && method === 'GET') {
      const slug = decodeURIComponent(path.slice('/api/learn/'.length));
      const b = BUNDLES[slug];
      return b ? json(route, { version: '1.0.0', learn: b }) : json(route, { error: { code: 'no_learn', message: 'no learning content' } }, 404);
    }
    if (path === '/api/start' && method === 'POST') {
      const { lab: slug } = JSON.parse(route.request().postData() ?? '{}');
      s.starts.push(slug);
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
        meta: { state: 'running', lab_slug: s.starts.at(-1) ?? EXPLORE, started_at: now, expires_at: now + 3_000_000, end_reason: null },
        services: { echo: { health: 'healthy' } },
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

declare global {
  interface Window {
    __comicClock?: {
      seek: (t: number) => void;
      pause: () => void;
      resume: () => void;
      time: () => number;
      total: number;
      status: () => string;
      doneCalls: () => number;
      timeline: () => Timeline;
    };
  }
}
interface Timeline {
  total: number;
  parts: { lead: number; turns: number; titles: number; panels: number; outro: number };
  pages: Array<{ index: number; start: number; end: number; panels: Array<{ number: number; start: number; end: number; bubbles: Array<{ start: number; end: number }>; sfxAt: number | null }> }>;
}

/** Opens the console on the launcher. `test` gives the comic its deterministic clock; `theme` pins light or dark. */
async function open(page: Page, { theme, test: comicTest = false }: { theme?: 'light' | 'dark'; test?: boolean } = {}) {
  await page.addInitScript((t) => {
    localStorage.setItem('opalixOnboarded', '1');
    localStorage.setItem('opalixLearn', JSON.stringify({ v: 1, onboarding: { status: 'skipped', at: 1, levels: {} } }));
    if (t) localStorage.setItem('opalixTheme', t);
  }, theme ?? null);
  await page.goto(comicTest ? '/?comicTest=1' : '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
}

/** Presses Start on a lab's card: with learning content that opens Before you begin. */
const startCard = (page: Page, slug: string) => page.locator(`.lab[data-slug="${slug}"] .lab-start`).click();

/** Opens Before you begin on a lab (the comic or not). */
async function openBeforeYouBegin(page: Page, slug: string, opts: Parameters<typeof open>[1] = {}, size = { width: 1280, height: 900 }) {
  const s = await stub(page);
  await page.setViewportSize(size);
  await open(page, opts);
  await startCard(page, slug);
  await expect(page.locator('#learnHost [data-learn-heading]')).toBeVisible();
  return s;
}

/** Opens Before you begin on a lab and waits for the comic to be drawn. */
async function beforeYouBegin(page: Page, slug: string, opts: Parameters<typeof open>[1] = {}, size = { width: 1280, height: 900 }) {
  const s = await openBeforeYouBegin(page, slug, opts, size);
  await expect(page.locator('#learnHost .cm')).toBeVisible();
  return s;
}

/** Starts a lab through "Skip all, just start the lab" and waits for the running session, guide ready. */
async function runningLab(page: Page, slug: string, opts: Parameters<typeof open>[1] = {}, size = { width: 1440, height: 900 }) {
  const s = await stub(page);
  await page.setViewportSize(size);
  await open(page, opts);
  await startCard(page, slug);
  await page.getByRole('button', { name: 'Skip all, just start the lab' }).click();
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#statePill')).toHaveText('running');
  await expect(page.locator('#bootModal')).toBeHidden();
  await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
  return s;
}

const stage = (page: Page, within = 'body') => page.locator(`${within} .cm-stage`);
const replayBtn = (page: Page, within = 'body') => page.locator(within).getByRole('button', { name: 'Replay', exact: true });
const skipBtn = (page: Page, within = 'body') => page.locator(within).getByRole('button', { name: 'Skip', exact: true });
const timecode = (page: Page, within = 'body') => page.locator(`${within} .cm-time`);

/** The test clock's readings (CSP forbids evaluating a function's source in the page, so each is spelled out). */
const clock = {
  time: (page: Page) => page.evaluate(() => window.__comicClock!.time()),
  doneCalls: (page: Page) => page.evaluate(() => window.__comicClock!.doneCalls()),
  resume: (page: Page) => page.evaluate(() => window.__comicClock!.resume()),
};
const timeline = (page: Page) => page.evaluate(() => window.__comicClock!.timeline());

/** Puts the comic's clock at `t` seconds and lets the page paint it (and the fonts and the art settle). */
async function at(page: Page, t: number) {
  await page.evaluate(async (t) => {
    await document.fonts.ready;
    window.__comicClock!.seek(t);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, t);
}

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

const panelCount = (c: Comic) => c.pages.reduce((n, p) => n + p.panels.length, 0);

// =========================================================================
// plays in Before you begin
// =========================================================================

test.describe('in Before you begin', () => {
  test('plays by itself, as a picture with a title, with the text story folded under it', async ({ page }) => {
    const s = await beforeYouBegin(page, EXPLORE);
    const st = stage(page, '#learnHost');
    await expect(st).toHaveAttribute('role', 'img');
    await expect(st).toHaveAttribute('aria-label', `${single.title}. An animated comic of ${panelCount(single)} panels over ${single.pages.length} pages. The text version is below, under Read as text.`);
    // The clock runs on its own: the timecode moves off zero.
    await expect.poll(async () => (await timecode(page, '#learnHost').textContent())?.split(' / ')[0], { timeout: 8000 }).not.toBe('0:00');
    await expect(page.locator('#learnHost .cm')).toHaveAttribute('data-state', 'playing');
    // The screen's own heading is still the story's title, and the text story is there, folded.
    await expect(page.locator('#learnHost [data-learn-heading]')).toHaveText(bundle.story!.title);
    const fold = page.locator('#learnHost .cm-story-text');
    await expect(fold).not.toHaveAttribute('open', '');
    await fold.locator('summary').click();
    await expect(fold.locator('.learn-prose p').first()).toBeVisible();
    expect(s.errors).toEqual([]);
  });

  test('has exactly two buttons, Replay and Skip, and nothing else to press on the stage', async ({ page }) => {
    await beforeYouBegin(page, EXPLORE);
    const controls = page.locator('#learnHost .cm-controls');
    await expect(controls.getByRole('button')).toHaveText(['Replay', 'Skip']);
    expect(await page.locator('#learnHost .cm button').count()).toBe(2);
    expect(await page.locator('#learnHost .cm-stage button, #learnHost .cm-stage a, #learnHost .cm-stage input, #learnHost .cm-stage [tabindex]').count()).toBe(0);
    await expect(replayBtn(page, '#learnHost')).toBeEnabled();
    await expect(skipBtn(page, '#learnHost')).toBeEnabled();
  });

  test('Skip ends playback on the finished comic, once, and puts focus on Replay', async ({ page }) => {
    await beforeYouBegin(page, EXPLORE, { test: true });
    await expect(page.locator('#learnHost .cm')).toHaveAttribute('data-state', 'playing');
    expect(await clock.doneCalls(page)).toBe(0);
    await skipBtn(page, '#learnHost').click();
    const cm = page.locator('#learnHost .cm');
    await expect(cm).toHaveAttribute('data-state', 'done');
    // Every panel is drawn, every bubble fully typed, the bar full, the timecode at the end.
    await expect(cm.locator('.cm-panel.on')).toHaveCount(panelCount(single));
    await expect(cm.locator('.cm-bub.on')).toHaveCount(single.pages.flatMap((pg) => pg.panels).reduce((n, p) => n + p.bubbles.length, 0));
    expect(await cm.locator('.cm-w:not(.on)').count()).toBe(0);
    const parts = (await timecode(page, '#learnHost').textContent())!.split(' / ');
    expect(parts[0]).toBe(parts[1]);
    expect(await cm.locator('.cm-bar > span').evaluate((e) => parseFloat((e as HTMLElement).style.width))).toBe(100);
    await expect(skipBtn(page, '#learnHost')).toBeDisabled();
    await expect(replayBtn(page, '#learnHost')).toBeFocused();
    expect(await clock.doneCalls(page)).toBe(1);
    // It stays finished: the clock does not run again by itself.
    await page.waitForTimeout(400);
    await expect(cm).toHaveAttribute('data-state', 'done');
    expect(await clock.doneCalls(page)).toBe(1);
  });

  test('Replay starts again from page 1, with the panels gone and the clock at zero', async ({ page }) => {
    await beforeYouBegin(page, EXPLORE, { test: true });
    await skipBtn(page, '#learnHost').click();
    await expect(page.locator('#learnHost .cm')).toHaveAttribute('data-state', 'done');
    await replayBtn(page, '#learnHost').click();
    const cm = page.locator('#learnHost .cm');
    await expect(cm).toHaveAttribute('data-state', 'playing');
    await expect(cm.locator('.cm-panel.on')).toHaveCount(0);
    await expect(timecode(page, '#learnHost')).toHaveText(/^0:00 \/ /);
    await expect(skipBtn(page, '#learnHost')).toBeEnabled();
    // Step the clock: the first panel pops in when the camera arrives, not before.
    const tl = await timeline(page);
    await at(page, tl.pages[0]!.panels[0]!.start + 0.1);
    await expect(cm.locator('.cm-panel.on')).toHaveCount(0);
    await at(page, tl.pages[0]!.panels[0]!.start + 1.2);
    await expect(cm.locator('.cm-panel.on')).toHaveCount(1);
    await at(page, tl.pages[0]!.panels[2]!.start + 1.5);
    await expect(cm.locator('.cm-panel.on')).toHaveCount(3);
    // Finishing a second time reports done a second time (once per run).
    await skipBtn(page, '#learnHost').click();
    expect(await clock.doneCalls(page)).toBe(2);
  });

  test('plays without the seam: the clock runs by itself and Replay restarts it in real time', async ({ page }) => {
    await beforeYouBegin(page, EXPLORE);
    expect(await page.evaluate(() => window.__comicClock)).toBeUndefined();
    await expect.poll(async () => (await timecode(page, '#learnHost').textContent())?.split(' / ')[0], { timeout: 8000 }).not.toBe('0:00');
    await replayBtn(page, '#learnHost').click();
    await expect(timecode(page, '#learnHost')).toHaveText(/^0:00 \/ /);
    await expect(page.locator('#learnHost .cm')).toHaveAttribute('data-state', 'playing');
    await skipBtn(page, '#learnHost').click();
    await expect(page.locator('#learnHost .cm')).toHaveAttribute('data-state', 'done');
  });

  test('the buttons work from the keyboard and show where focus is', async ({ page }) => {
    await beforeYouBegin(page, EXPLORE, { test: true });
    await replayBtn(page, '#learnHost').focus();
    await page.keyboard.press('Tab');
    await expect(skipBtn(page, '#learnHost')).toBeFocused();
    const ring = await skipBtn(page, '#learnHost').evaluate((b) => {
      const st = getComputedStyle(b);
      return { style: st.outlineStyle, width: parseFloat(st.outlineWidth) };
    });
    expect(ring.style).not.toBe('none');
    expect(ring.width).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Enter');
    await expect(page.locator('#learnHost .cm')).toHaveAttribute('data-state', 'done');
    await expect(replayBtn(page, '#learnHost')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('#learnHost .cm')).toHaveAttribute('data-state', 'playing');
  });

  test('"Read as text" under the stage lists every panel, in order, as an ordered list', async ({ page }) => {
    await beforeYouBegin(page, EXPLORE);
    const text = page.locator('#learnHost .cm-text');
    await expect(text.locator('summary')).toHaveText('Read as text');
    await text.locator('summary').click();
    const items = text.locator('ol > li');
    await expect(items).toHaveCount(panelCount(single) + single.pages.length);
    await expect(items.nth(0)).toContainText('Page 1: Life without a gateway.');
    await expect(items.nth(1)).toContainText('Panel 1. Four teams, four providers, four keys.');
    await expect(items.nth(1)).toContainText('Maren: Welcome to the museum.');
    await expect(items.nth(2)).toContainText('Priya: Three in the morning');
    await expect(items.nth(6)).toContainText('Page 2: One front door.');
    await expect(items.nth(8)).toContainText('On screen: $ ask: support');
    await expect(items.nth(10)).toContainText('Panel 9. Your turn.');
    // The animated parts are out of the accessibility tree: the stage is one image.
    await expect(page.locator('#learnHost .cm-view')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#learnHost .cm-bar')).toHaveAttribute('aria-hidden', 'true');
  });

  test('a comic of several pages lists a heading line per page and numbers its panels across them', async ({ page }) => {
    await beforeYouBegin(page, MULTI);
    const text = page.locator('#learnHost .cm-text');
    await text.locator('summary').click();
    const items = text.locator('ol > li');
    await expect(items).toHaveCount(panelCount(multi) + 3);
    await expect(items.nth(0)).toHaveText('Page 1: Tuesday afternoon.');
    await expect(items.nth(1)).toContainText('Panel 1.');
    await expect(items.nth(5)).toHaveText('Page 2.');
    await expect(items.nth(6)).toContainText('Panel 5.');
    await expect(items.nth(10)).toHaveText('Page 3: Your turn.');
    await expect(items.last()).toContainText(`Panel ${panelCount(multi)}.`);
    await expect(page.locator('#learnHost .cm-stage')).toHaveAttribute('aria-label', /over 3 pages/);
  });

  test('a lab with no comic shows the text story as it always did', async ({ page }) => {
    await openBeforeYouBegin(page, NO_COMIC);
    await expect(page.locator('#learnHost [data-learn-heading]')).toHaveText(bundle.story!.title);
    await expect(page.locator('#learnHost .cm')).toHaveCount(0);
    await expect(page.locator('#learnHost .cm-story-text')).toHaveCount(0);
    await expect(page.locator('#learnHost .learn-prose p').first()).toBeVisible();
    await expect(page.locator('#learnHost .learn-wrap-comic, #learnHost.learn-wrap-comic')).toHaveCount(0);
  });

  test('a comic that cannot be drawn falls back to the text story, with no error', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    await startCard(page, BROKEN);
    await expect(page.locator('#learnHost [data-learn-heading]')).toHaveText(bundle.story!.title);
    await expect(page.locator('#learnHost .cm')).toHaveCount(0);
    await expect(page.locator('#learnHost .learn-prose p').first()).toBeVisible();
    expect(s.errors).toEqual([]);
  });

  test('going back to the labs takes the comic down: the clock is gone and nothing is left', async ({ page }) => {
    await beforeYouBegin(page, EXPLORE, { test: true });
    expect(await page.evaluate(() => Boolean(window.__comicClock))).toBe(true);
    await page.getByRole('button', { name: '← Back to labs' }).click();
    await expect(page.locator('#learnScreen')).toBeHidden();
    await expect(page.locator('.cm')).toHaveCount(0);
    expect(await page.evaluate(() => window.__comicClock)).toBeUndefined();
  });

  test('starting the lab takes the Before you begin comic down: the session has none', async ({ page }) => {
    const s = await beforeYouBegin(page, EXPLORE, { test: true });
    await page.getByRole('button', { name: 'Skip all, just start the lab' }).click();
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('.cm')).toHaveCount(0);
    expect(await page.evaluate(() => window.__comicClock)).toBeUndefined();
    expect(s.errors).toEqual([]);
  });

  test('moving on from the story takes the comic down too: the clock is gone before the lessons are read', async ({ page }) => {
    await beforeYouBegin(page, EXPLORE, { test: true });
    expect(await page.evaluate(() => Boolean(window.__comicClock))).toBe(true);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('.cm')).toHaveCount(0);
    expect(await page.evaluate(() => window.__comicClock)).toBeUndefined();
  });
});

// =========================================================================
// not in the session
// =========================================================================

test.describe('in the session', () => {
  test('a lab with a comic has no Story tab and no comic in its guide', async ({ page }) => {
    const s = await runningLab(page, EXPLORE);
    await expect(page.getByRole('tab', { name: 'Story' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Lessons' })).toHaveCount(0);
    await expect(page.locator('.cm, .cm-story, .cm-story-text, .learn-story')).toHaveCount(0);
    await expect(page.locator('.tab-active')).toHaveText('Brief');
    expect(s.errors).toEqual([]);
  });

  test('a lab with only a text story has none of it in its guide either', async ({ page }) => {
    await runningLab(page, NO_COMIC);
    await expect(page.locator('#guide .learn-prose, #guide .learn-story')).toHaveCount(0);
    expect(await page.locator('#guide').innerText()).not.toContain(bundle.story!.title);
  });
});

// =========================================================================
// reduced motion
// =========================================================================

test.describe('reduced motion', () => {
  test('shows the comic finished from the first moment: every panel drawn, no camera, the same two buttons', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await beforeYouBegin(page, EXPLORE);
    const cm = page.locator('#learnHost .cm');
    await expect(cm).toHaveAttribute('data-state', 'done');
    await expect(cm).toHaveAttribute('data-reduced', '1');
    await expect(cm.locator('.cm-panel.on')).toHaveCount(panelCount(single));
    expect(await cm.locator('.cm-w:not(.on)').count()).toBe(0);
    await expect(cm.locator('.cm-controls').getByRole('button')).toHaveText(['Replay', 'Skip']);
    await expect(skipBtn(page, '#learnHost')).toBeDisabled();
    const parts = (await timecode(page, '#learnHost').textContent())!.split(' / ');
    expect(parts[0]).toBe(parts[1]);
    // No camera: the reel sits at the one fit that shows the whole comic, and it does not move.
    const fit = async () => cm.locator('.cm-reel').evaluate((e) => ({ t: getComputedStyle(e).transform, w: (e as HTMLElement).offsetWidth, shown: e.getBoundingClientRect().width }));
    const a = await fit();
    const stageW = (await cm.locator('.cm-stage').boundingBox())!.width;
    expect(a.shown).toBeCloseTo(stageW, 0);
    await page.waitForTimeout(500);
    expect(await fit()).toEqual(a);
    // And nothing animates: no running animations anywhere on the stage.
    const running = await cm.evaluate((root) => root.getAnimations({ subtree: true }).filter((an) => an.playState === 'running').length);
    expect(running).toBe(0);
  });

  test('Replay still works, as cuts and not travelling (the camera sits on the panel)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await beforeYouBegin(page, EXPLORE, { test: true });
    await replayBtn(page, '#learnHost').click();
    const cm = page.locator('#learnHost .cm');
    await expect(cm).toHaveAttribute('data-state', 'playing');
    const tl = await timeline(page);
    await at(page, tl.pages[0]!.panels[1]!.start + 0.4);
    // The words of a bubble are there at once (no typing), the camera is on the panel already.
    const state = await cm.evaluate((root) => ({ shown: root.querySelectorAll('.cm-panel.on').length, untyped: root.querySelectorAll('.cm-bub.on .cm-w:not(.on)').length }));
    expect(state.shown).toBeGreaterThanOrEqual(1);
    expect(state.untyped).toBe(0);
    expect(await cm.evaluate((root) => root.getAnimations({ subtree: true }).filter((an) => an.playState === 'running').length)).toBe(0);
  });

  test('a lab with several pages shows every page, one under the other', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await beforeYouBegin(page, MULTI, {}, { width: 1280, height: 900 });
    const cm = page.locator('#learnHost .cm');
    await expect(cm.locator('.cm-sheet')).toHaveCount(3);
    await expect(cm.locator('.cm-banner')).toHaveCount(2);
    const sheets = await cm.locator('.cm-sheet').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
    expect(sheets[0]!).toBeLessThan(sheets[1]!);
    expect(sheets[1]!).toBeLessThan(sheets[2]!);
    await expect(cm.locator('.cm-panel.on')).toHaveCount(panelCount(multi));
    // The stage is as tall as the whole comic needs, so nothing is cut off.
    const st = (await cm.locator('.cm-stage').boundingBox())!;
    const last = (await cm.locator('.cm-sheet').last().boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(st.y + st.height + 1);
  });
});

// =========================================================================
// the clock is one clock: the picture is a function of the time
// =========================================================================

test.describe('one clock', () => {
  test('is not there unless the page asks for it', async ({ page }) => {
    await beforeYouBegin(page, EXPLORE);
    expect(await page.evaluate(() => 'comicTest' in (document.querySelector('.cm') as HTMLElement).dataset || (document.querySelector('.cm') as HTMLElement).hasAttribute('data-test'))).toBe(false);
    expect(await page.evaluate(() => window.__comicClock)).toBeUndefined();
  });

  test('panels pop in at the times the schedule says, and the same time gives the same picture', async ({ page }) => {
    await beforeYouBegin(page, EXPLORE, { test: true });
    const tl = await timeline(page);
    const p = tl.pages[0]!.panels;
    // The clock waits for the test: nothing has moved.
    await expect(page.locator('#learnHost .cm-panel.on')).toHaveCount(0);
    expect(await clock.time(page)).toBe(0);
    const frame = async (t: number) => {
      await at(page, t);
      return page.evaluate(() => ({
        on: document.querySelectorAll('.cm-panel.on').length,
        words: document.querySelectorAll('.cm-w.on').length,
        reel: getComputedStyle(document.querySelector('.cm-reel')!).transform,
        time: document.querySelector('.cm-time')!.textContent,
      }));
    };
    const a = await frame(p[3]!.start + 2);
    expect(a.on).toBe(4);
    await frame(p[0]!.start + 1);
    const b = await frame(p[3]!.start + 2);
    expect(b).toEqual(a);
    // Words are typed one at a time, not all at once.
    const bub = p[0]!.bubbles[0]!;
    const early = await frame(bub.start + 0.6);
    const late = await frame(bub.end + 0.3);
    expect(late.words).toBeGreaterThan(early.words);
    expect(early.words).toBeGreaterThan(0);
  });

  test('total time is the sum of the panels, the turns and the ends, and the timecode shows it', async ({ page }) => {
    await beforeYouBegin(page, MULTI, { test: true });
    const tl = await timeline(page);
    const sum = tl.parts.lead + tl.parts.turns + tl.parts.titles + tl.parts.panels + tl.parts.outro;
    expect(sum).toBeCloseTo(tl.total, 6);
    const mm = (n: number) => `${Math.floor(Math.floor(n) / 60)}:${String(Math.floor(n) % 60).padStart(2, '0')}`; // the clock floors, as mmss() does
    await expect(timecode(page, '#learnHost')).toHaveText(new RegExp(`/ ${mm(tl.total)}$`));
    expect(tl.pages).toHaveLength(3);
  });
});

// =========================================================================
// width: nothing scrolls sideways, and the words stay readable
// =========================================================================

test.describe('layout', () => {
  for (const width of [800, 1000, 1280, 1440]) {
    test(`Before you begin at ${width}px: the stage fits its card, playing and finished, with no sideways scroll`, async ({ page }) => {
      await beforeYouBegin(page, MULTI, { test: true }, { width, height: 900 });
      const tl = await timeline(page);
      for (const t of [tl.pages[0]!.panels[1]!.start + 2, tl.pages[1]!.panels[0]!.start + 2, tl.total]) {
        await at(page, t);
        await noHorizontalScroll(page);
        const st = (await stage(page, '#learnHost').boundingBox())!;
        const card = (await page.locator('#learnHost').boundingBox())!;
        expect(st.x).toBeGreaterThanOrEqual(card.x);
        expect(st.x + st.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
      }
    });
  }

  test('the stage scales with its container: wider card, wider stage, same picture', async ({ page }) => {
    await beforeYouBegin(page, EXPLORE, { test: true }, { width: 1440, height: 900 });
    const wide = (await stage(page, '#learnHost').boundingBox())!.width;
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(async () => (await stage(page, '#learnHost').boundingBox())!.width).toBeLessThan(wide);
    await noHorizontalScroll(page);
  });

  for (const viewport of [1000, 800]) {
    test(`at ${viewport}px the bubbles, captions and screen lines stay readable on every panel`, async ({ page }) => {
      await beforeYouBegin(page, EXPLORE, { test: true }, { width: viewport, height: 900 });
      const tl = await timeline(page);
      // Bubbles, name tags and captions are about 11px or more on screen. A screen's lines are read once the
      // camera has pushed in on its monitor (a 40 character line cannot be bigger than the monitor it is typed on).
      const floor = 10.9;
      const linesFloor = 9.5;
      for (const pg of tl.pages) {
        for (const panel of pg.panels) {
          await at(page, panel.end - 0.1);
          const sizes = await page.evaluate((n) => {
            const fig = document.querySelector(`.cm-panel[data-panel="${n}"]`)!;
            const reel = document.querySelector('.cm-reel') as HTMLElement;
            const scale = reel.getBoundingClientRect().width / reel.offsetWidth;
            const px = (sel: string) => [...fig.querySelectorAll(sel)].filter((e) => e.getClientRects().length && getComputedStyle(e).opacity !== '0').map((e) => parseFloat(getComputedStyle(e).fontSize) * scale);
            return { bubble: px('.cm-bub.on .cm-w'), tag: px('.cm-bub.on .cm-tag'), caption: px('.cm-cap.on'), lines: px('.cm-line.on') };
          }, panel.number);
          for (const [what, list] of Object.entries(sizes)) for (const v of list) expect(v, `panel ${panel.number} ${what} is ${v.toFixed(1)}px on screen`).toBeGreaterThanOrEqual(what === 'lines' ? linesFloor : floor);
        }
      }
      await noHorizontalScroll(page);
      await at(page, tl.total);
      await noHorizontalScroll(page);
    });
  }
});

// =========================================================================
// pictures (not assertions of looks: for a person to open and judge)
// =========================================================================

test.describe('pictures', () => {
  test.skip(process.env.COMIC_SHOTS === '0', 'COMIC_SHOTS=0');
  test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

  const shotOf = async (page: Page, name: string, within: Locator) => {
    await within.screenshot({ path: join(SHOTS, `${name}.png`) });
  };

  for (const theme of ['light', 'dark'] as const) {
    for (const [name, slug] of [['single', EXPLORE], ['multi', MULTI]] as const) {
      test(`${name} comic, ${theme}: a frame mid-play and the finished page`, async ({ page }) => {
        await beforeYouBegin(page, slug, { theme, test: true }, { width: 1280, height: 1000 });
        const tl = await timeline(page);
        const st = stage(page, '#learnHost');
        const pg = tl.pages[Math.min(1, tl.pages.length - 1)]!;
        // Each panel at its fullest, so the cast, the bubbles and the screens can all be judged.
        for (const p of tl.pages.flatMap((x) => x.panels)) {
          await at(page, p.end - 0.15);
          await shotOf(page, `${name}-${theme}-panel-${String(p.number).padStart(2, '0')}`, st);
        }
        await at(page, pg.panels[0]!.start + 2.5);
        await shotOf(page, `${name}-${theme}-mid`, st);
        // The page turn, half way.
        if (tl.pages.length > 1) {
          await at(page, tl.pages[1]!.start + 0.7);
          await shotOf(page, `${name}-${theme}-turn`, st);
        }
        // The finished comic is as tall as the whole comic: give the window the height to show it.
        await at(page, tl.total);
        const height = (await st.boundingBox())!.height;
        await page.setViewportSize({ width: 1280, height: Math.min(Math.ceil(height) + 320, 4200) });
        await at(page, tl.total);
        await shotOf(page, `${name}-${theme}-finished`, st);
      });
    }
  }
});
