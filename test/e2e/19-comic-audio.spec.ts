import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Locator, type Page, type Route } from '@playwright/test';
import { parse as parseYaml } from 'yaml';
import { serveConsole } from './console-server';

/**
 * The motion comic's voices in the console: a lab whose comic is narrated gets a Sound on/off toggle
 * beside Replay and Skip (remembered, on by default), each clip is started by the comic's own clock at
 * the time the timeline gives it, Skip and Replay and the toggle stop it, the browser's refusal to start
 * sound shows a "Tap to turn the sound on" button, reduced motion plays nothing by itself, a clip that
 * will not load is skipped, and a lab without narration is exactly as it was.
 *
 * Like 18-comic.spec.ts this needs no password, no API and no container: a static server serves
 * dashboard/public (the built bundle, with the CSP from public/_headers) and every call the console makes
 * is answered by a route stub, the audio route included (it serves a real mp3 fixture). The content is
 * real: the learn bundle, the comic and its narration (learn/audio.json) are those of
 * labs/see-what-a-gateway-does. In test mode (?comicTest=1) the comic never starts real playback: the
 * player records what it decided in window.__comicClock.audioLog(), and `?comicAudio=blocked` makes its
 * play() refuse as a browser does before anyone has tapped.
 *
 * Run `npm run build:dashboard` first (the page loads dashboard/public/dist).
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC = join(ROOT, 'dashboard/public');
const API = 'https://opalix-sandbox.soubenz94.workers.dev';
const SESSION_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const CLIP = readFileSync(join(here, '../fixtures/audio/maren-thalia.mp3'));

// --------------------------------------------------------------- the content

interface Bundle {
  story?: { title: string; minutes: number; body: string };
  comic?: { title: string; pages: Array<{ panels: Array<Record<string, any>> }> };
  audio?: { model: string; clips: Record<string, { voice: string; text: string; seconds: number; bytes: number }>; lines: Array<{ panel: number; kind: string; bubble?: number; clip: string }> };
  concepts: unknown[];
  questions: unknown[];
  answers_file: string;
  fields: unknown[];
}

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
  const qs = parseYaml(readFileSync(join(dir, 'questions.yaml'), 'utf8')) as { answers_file: string; fields: unknown[] };
  const raw = parseYaml(readFileSync(join(dir, 'comic.yaml'), 'utf8')) as { title: string; panels?: Array<Record<string, any>>; pages?: Array<{ title?: string; panels: Array<Record<string, any>> }> };
  return {
    story: { title: story.data.title, minutes: story.data.minutes, body: story.body },
    comic: {
      title: raw.title,
      pages: (raw.pages ?? [{ panels: raw.panels ?? [] }]).map((pg) => ({ ...(pg.title ? { title: pg.title } : {}), panels: pg.panels.map((p) => ({ cast: [], prop: 'none', bubbles: [], ...p })) })),
    },
    audio: JSON.parse(readFileSync(join(dir, 'audio.json'), 'utf8')),
    concepts,
    questions: quiz.questions.map((q) => ({ diagnostic: true, ...q })),
    answers_file: qs.answers_file,
    fields: qs.fields,
  };
}

const VOICED = 'see-what-a-gateway-does';
const SILENT = 'see-how-requests-are-routed';
const bundle = compileLearn(VOICED);
const audio = bundle.audio!;
const BUNDLES: Record<string, Bundle> = { [VOICED]: bundle, [SILENT]: { ...bundle, audio: undefined } };

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
const LABS = [lab({ slug: VOICED, title: 'See what a gateway does', order: 1 }), lab({ slug: SILENT, title: 'See how requests are routed', order: 2 })];

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
  errors: string[];
  /** Clip files asked for, in order. */
  clipRequests: string[];
  /** Clip files that answer 404. */
  missing: Set<string>;
}

async function stub(page: Page): Promise<Stub> {
  const s: Stub = { errors: [], clipRequests: [], missing: new Set() };
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) s.errors.push(msg.text());
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/me') return json(route, { sub: 'console' });
    if (path === '/api/labs') return json(route, LABS);
    if (path === '/api/onboarding') return json(route, { error: { code: 'no_onboarding', message: 'none' } }, 404);
    if (path.startsWith('/api/learn/') && route.request().method() === 'GET') {
      const slug = decodeURIComponent(path.slice('/api/learn/'.length));
      const b = BUNDLES[slug];
      // The API sends the lab's slug beside the bundle; the player builds the clip URLs from it.
      return b ? json(route, { slug, version: '1.0.0', learn: b }) : json(route, { error: { code: 'no_learn', message: 'none' } }, 404);
    }
    return json(route, { error: 'not stubbed' }, 404);
  });
  // Registered after the catch-all, so it is asked first.
  await page.route('**/api/audio/**', async (route) => {
    const m = /^\/api\/audio\/([^/]+)\/([0-9a-f]{16}\.mp3)$/.exec(new URL(route.request().url()).pathname);
    if (!m || m[1] !== VOICED) return route.fulfill({ status: 404, body: 'no' });
    s.clipRequests.push(m[2]!);
    if (s.missing.has(m[2]!)) return route.fulfill({ status: 404, body: 'gone' });
    return route.fulfill({ status: 200, contentType: 'audio/mpeg', headers: { 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=60' }, body: CLIP });
  });
  await page.route(`${API}/**`, (route) => json(route, { error: 'not stubbed' }, 404));
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

interface Clip {
  key: string;
  kind: 'caption' | 'bubble';
  bubble: number | null;
  panel: number;
  start: number;
  end: number;
  seconds: number;
  url: string;
}
interface LogEntry {
  type: 'play' | 'stop';
  key: string;
  at: number;
  offset?: number;
}
interface Seam {
  seek: (t: number) => void;
  time: () => number;
  doneCalls: () => number;
  timeline: () => { total: number; pages: Array<{ panels: Array<{ number: number; start: number; captionAt: number | null; bubbles: Array<{ start: number; end: number; wordTimes: number[] }> }> }> };
  audio: Clip[];
  audioLog: () => LogEntry[];
  audioState: () => { sound: boolean; blocked: boolean; current: string | null; failed: string[] };
}
/** The page's window, as far as the comic's test seam goes (18-comic.spec.ts declares the same global for its own, smaller view of it). */
type W = { __comicClock?: Seam };

async function open(page: Page, { query = 'comicTest=1' }: { query?: string } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('opalixOnboarded', '1');
    localStorage.setItem('opalixLearn', JSON.stringify({ v: 1, onboarding: { status: 'skipped', at: 1, levels: {} } }));
  });
  await page.goto(query ? `/?${query}` : '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
}

/** Opens Before you begin on a lab and waits for the comic to be drawn. */
async function beforeYouBegin(page: Page, slug: string, opts: Parameters<typeof open>[1] = {}) {
  const s = await stub(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, opts);
  await page.locator(`.lab[data-slug="${slug}"] .lab-start`).click();
  await expect(page.locator('#learnHost .cm')).toBeVisible();
  return s;
}

const cm = (page: Page) => page.locator('#learnHost .cm');
const soundBtn = (page: Page) => page.locator('#learnHost .cm-controls').getByRole('button', { name: /^Sound o(n|ff)$/ });
const tapBtn = (page: Page) => page.locator('#learnHost .cm').getByRole('button', { name: 'Tap to turn the sound on' });
const replayBtn = (page: Page) => page.locator('#learnHost').getByRole('button', { name: 'Replay', exact: true });
const skipBtn = (page: Page) => page.locator('#learnHost').getByRole('button', { name: 'Skip', exact: true });
const clips = (page: Page) => page.evaluate(() => (window as unknown as W).__comicClock!.audio);
const log = (page: Page) => page.evaluate(() => (window as unknown as W).__comicClock!.audioLog());
const audioState = (page: Page) => page.evaluate(() => (window as unknown as W).__comicClock!.audioState());
const timeline = (page: Page) => page.evaluate(() => (window as unknown as W).__comicClock!.timeline());

async function at(page: Page, t: number) {
  await page.evaluate(async (t) => {
    (window as unknown as W).__comicClock!.seek(t);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, t);
}

/** What the log says is sounding after each entry: never more than one clip. */
function neverTwoAtOnce(entries: LogEntry[]) {
  const playing = new Set<string>();
  for (const e of entries) {
    if (e.type === 'play') playing.add(e.key);
    else playing.delete(e.key);
    expect(playing.size, `after ${e.type} ${e.key} at ${e.at}`).toBeLessThanOrEqual(1);
  }
}

const bubbleWordsOn = (panel: Locator, bubble: number) => panel.locator('.cm-bub').nth(bubble).locator('.cm-w.on').count();

// =========================================================================

test.describe('the Sound toggle', () => {
  test('is the third control beside Replay and Skip, on by default, named for its state and pressed when on', async ({ page }) => {
    const s = await beforeYouBegin(page, VOICED);
    await expect(page.locator('#learnHost .cm-controls').getByRole('button')).toHaveText(['Replay', 'Skip', 'Sound on']);
    await expect(soundBtn(page)).toHaveAccessibleName('Sound on');
    await expect(soundBtn(page)).toHaveAttribute('aria-pressed', 'true');
    // Replay and Skip are still the only playback controls, and the stage itself has no controls in it.
    expect(await page.locator('#learnHost .cm-stage button, #learnHost .cm-stage a, #learnHost .cm-stage input').count()).toBe(0);
    await expect(tapBtn(page)).toBeHidden();
    expect(s.errors).toEqual([]);
  });

  test('toggles, says so, and is remembered for the next comic', async ({ page }) => {
    await beforeYouBegin(page, VOICED);
    await soundBtn(page).click();
    await expect(soundBtn(page)).toHaveAccessibleName('Sound off');
    await expect(soundBtn(page)).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => localStorage.getItem('opalix.comicSound'))).toBe('0');
    expect((await audioState(page)).sound).toBe(false);
    // Reload: the story's own address (/labs/<slug>/story) comes back to the story, and the choice survives.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page).toHaveURL(new RegExp(`/labs/${VOICED}/story`));
    await expect(soundBtn(page)).toHaveAccessibleName('Sound off');
    await expect(soundBtn(page)).toHaveAttribute('aria-pressed', 'false');
    await soundBtn(page).click();
    await expect(soundBtn(page)).toHaveAccessibleName('Sound on');
    expect(await page.evaluate(() => localStorage.getItem('opalix.comicSound'))).toBe('1');
  });

  test('works from the keyboard', async ({ page }) => {
    await beforeYouBegin(page, VOICED);
    await skipBtn(page).focus();
    await page.keyboard.press('Tab');
    await expect(soundBtn(page)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(soundBtn(page)).toHaveAccessibleName('Sound off');
  });

  test('turning it off stops the clip that is sounding, and nothing starts until it is on again', async ({ page }) => {
    await beforeYouBegin(page, VOICED);
    const list = await clips(page);
    await at(page, list[1]!.start + 0.4);
    expect((await audioState(page)).current).toBe(list[1]!.key);
    await soundBtn(page).click();
    expect((await audioState(page)).current).toBeNull();
    expect((await log(page)).at(-1)).toMatchObject({ type: 'stop', key: list[1]!.key });
    const before = (await log(page)).length;
    await at(page, list[2]!.start + 0.4);
    expect((await log(page)).length).toBe(before);
    await soundBtn(page).click();
    expect((await audioState(page)).current).toBe(list[2]!.key);
    expect((await log(page)).at(-1)).toMatchObject({ type: 'play', key: list[2]!.key });
    neverTwoAtOnce(await log(page));
  });
});

test.describe('the clips follow the clock', () => {
  test('the seam lists every spoken line of the comic with the start the timeline gives it', async ({ page }) => {
    await beforeYouBegin(page, VOICED);
    const list = await clips(page);
    expect(list).toHaveLength(audio.lines.length);
    expect(list.map((c) => c.key).sort()).toEqual(audio.lines.map((l) => l.clip).sort());
    for (const c of list) {
      expect(c.url).toBe(`/api/audio/${VOICED}/${c.key}.mp3`);
      expect(c.end - c.start).toBeCloseTo(audio.clips[c.key]!.seconds, 2);
    }
    for (let i = 1; i < list.length; i++) expect(list[i]!.start).toBeGreaterThanOrEqual(list[i - 1]!.end);
    // The first line is the caption of panel 1, spoken as it appears; the next is the first bubble, one gap after.
    const tl = await timeline(page);
    const p1 = tl.pages[0]!.panels[0]!;
    expect(list[0]).toMatchObject({ kind: 'caption', panel: 1 });
    expect(list[0]!.start).toBeCloseTo(p1.captionAt!, 6);
    expect(list[1]).toMatchObject({ kind: 'bubble', panel: 1, bubble: 0 });
    expect(list[1]!.start).toBeCloseTo(list[0]!.end + 0.35, 6);
    expect(p1.bubbles[0]!.end).toBeCloseTo(list[1]!.end, 6);
    // Narrated panels are held until the voice is done.
    expect(tl.total).toBeGreaterThan(list.at(-1)!.end);
  });

  test('starts each clip when the clock reaches its start, stops it when its time is up, one at a time', async ({ page }) => {
    await beforeYouBegin(page, VOICED);
    const list = await clips(page);
    expect(await log(page)).toEqual([]);
    for (const c of list) {
      await at(page, c.start + 0.02);
      const last = (await log(page)).at(-1)!;
      expect(last, c.key).toMatchObject({ type: 'play', key: c.key });
      expect(last.at).toBeCloseTo(c.start + 0.02, 2);
      expect(last.offset).toBe(0);
      expect((await audioState(page)).current).toBe(c.key);
      // The gap after it is silence.
      await at(page, c.end + 0.02);
      expect((await audioState(page)).current).toBeNull();
    }
    const entries = await log(page);
    expect(entries.filter((e) => e.type === 'play').map((e) => e.key)).toEqual(list.map((c) => c.key));
    neverTwoAtOnce(entries);
  });

  test('a clock jump into the middle of a clip starts it at that point; a jump out of it stops it', async ({ page }) => {
    await beforeYouBegin(page, VOICED);
    const list = await clips(page);
    const c = list[3]!;
    await at(page, c.start + 1.5);
    expect((await log(page)).at(-1)).toMatchObject({ type: 'play', key: c.key });
    expect((await log(page)).at(-1)!.offset).toBeCloseTo(1.5, 2);
    await at(page, list[0]!.start - 0.1);
    expect((await audioState(page)).current).toBeNull();
    expect((await log(page)).at(-1)).toMatchObject({ type: 'stop', key: c.key });
  });

  test('types a bubble\'s words across its clip, so the typing keeps pace with the voice', async ({ page }) => {
    await beforeYouBegin(page, VOICED);
    const list = await clips(page);
    const c = list.find((x) => x.kind === 'bubble' && x.panel === 1)!;
    const panel = page.locator('#learnHost .cm-panel[data-panel="1"]');
    const total = await panel.locator('.cm-bub').first().locator('.cm-w').count();
    await at(page, c.start - 0.02);
    expect(await bubbleWordsOn(panel, 0)).toBe(0);
    await at(page, c.start + (c.end - c.start) / 2);
    const half = await bubbleWordsOn(panel, 0);
    expect(half).toBeGreaterThan(total * 0.25);
    expect(half).toBeLessThan(total);
    await at(page, c.end - 0.02);
    expect(await bubbleWordsOn(panel, 0)).toBe(total);
  });

  test('preloads the clips of the first page as the comic starts, and no real playback happens in test mode', async ({ page }) => {
    const s = await beforeYouBegin(page, VOICED);
    await expect.poll(() => new Set(s.clipRequests).size, { timeout: 8000 }).toBe(Object.keys(audio.clips).length);
    expect(await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => r.name.includes('/api/audio/')).length)).toBeGreaterThan(0);
  });
});

test.describe('Skip, Replay and the end', () => {
  test('Skip stops the clip that is sounding and nothing sounds after it', async ({ page }) => {
    await beforeYouBegin(page, VOICED);
    const list = await clips(page);
    await at(page, list[2]!.start + 0.5);
    expect((await audioState(page)).current).toBe(list[2]!.key);
    await skipBtn(page).click();
    await expect(cm(page)).toHaveAttribute('data-state', 'done');
    expect((await audioState(page)).current).toBeNull();
    expect((await log(page)).at(-1)).toMatchObject({ type: 'stop', key: list[2]!.key });
    await page.waitForTimeout(300);
    expect((await log(page)).at(-1)).toMatchObject({ type: 'stop' });
    neverTwoAtOnce(await log(page));
  });

  test('Replay stops what is sounding and plays the comic again from its first clip', async ({ page }) => {
    await beforeYouBegin(page, VOICED);
    const list = await clips(page);
    await at(page, list[0]!.start + 0.1);
    await at(page, list[4]!.start + 0.3);
    await skipBtn(page).click();
    await replayBtn(page).click();
    await expect(cm(page)).toHaveAttribute('data-state', 'playing');
    expect((await audioState(page)).current).toBeNull(); // the clock is at 0: nothing yet
    await at(page, list[0]!.start + 0.02);
    const entries = await log(page);
    expect(entries.at(-1)).toMatchObject({ type: 'play', key: list[0]!.key });
    expect(entries.filter((e) => e.type === 'play' && e.key === list[0]!.key)).toHaveLength(2);
    neverTwoAtOnce(entries);
  });

  test('Replay in the middle of a clip stops it at once', async ({ page }) => {
    await beforeYouBegin(page, VOICED);
    const list = await clips(page);
    await at(page, list[3]!.start + 0.3);
    expect((await audioState(page)).current).toBe(list[3]!.key);
    await replayBtn(page).click();
    expect((await audioState(page)).current).toBeNull();
    expect((await log(page)).at(-1)).toMatchObject({ type: 'stop', key: list[3]!.key });
  });

  test('the comic finishes and calls onDone as before: narration does not change Skip\'s contract', async ({ page }) => {
    await beforeYouBegin(page, VOICED);
    await skipBtn(page).click();
    expect(await page.evaluate(() => (window as unknown as W).__comicClock!.doneCalls())).toBe(1);
    await expect(replayBtn(page)).toBeFocused();
    await expect(skipBtn(page)).toBeDisabled();
  });
});

test.describe('when the browser will not start sound by itself', () => {
  test('shows a small Tap to turn the sound on button in the frame, and a tap starts the clip where the clock is', async ({ page }) => {
    const s = await beforeYouBegin(page, VOICED, { query: 'comicTest=1&comicAudio=blocked' });
    const list = await clips(page);
    await expect(tapBtn(page)).toBeHidden();
    await at(page, list[1]!.start + 0.02);
    await expect(tapBtn(page)).toBeVisible();
    expect((await audioState(page)).blocked).toBe(true);
    // A small non-modal button over the frame: inside the comic, not a dialog, and the comic still has its own controls.
    expect(await page.locator('#learnHost [role="dialog"], #learnHost dialog').count()).toBe(0);
    const box = (await tapBtn(page).boundingBox())!;
    const frame = (await page.locator('#learnHost .cm').boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(frame.y);
    expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
    expect(box.width).toBeLessThan(frame.width / 2);
    await expect(replayBtn(page)).toBeEnabled();
    // Nothing is tried again on every frame while it waits.
    const refused = (await log(page)).filter((e) => e.type === 'play').length;
    await at(page, list[1]!.start + 0.5);
    expect((await log(page)).filter((e) => e.type === 'play').length).toBe(refused);

    await at(page, list[2]!.start + 0.7);
    await tapBtn(page).click();
    await expect(tapBtn(page)).toBeHidden();
    expect((await audioState(page)).blocked).toBe(false);
    const last = (await log(page)).at(-1)!;
    expect(last).toMatchObject({ type: 'play', key: list[2]!.key });
    expect(last.offset).toBeCloseTo(0.7, 1);
    expect((await audioState(page)).current).toBe(list[2]!.key);
    expect(s.errors).toEqual([]);
  });

  test('Replay is also a tap: it unblocks sound, with no extra button needed', async ({ page }) => {
    await beforeYouBegin(page, VOICED, { query: 'comicTest=1&comicAudio=blocked' });
    const list = await clips(page);
    await at(page, list[0]!.start + 0.02);
    await expect(tapBtn(page)).toBeVisible();
    await replayBtn(page).click();
    await expect(tapBtn(page)).toBeHidden();
    await at(page, list[0]!.start + 0.02);
    expect((await audioState(page)).current).toBe(list[0]!.key);
  });

  test('with Sound off there is nothing to ask for', async ({ page }) => {
    await beforeYouBegin(page, VOICED, { query: 'comicTest=1&comicAudio=blocked' });
    await soundBtn(page).click();
    const list = await clips(page);
    await at(page, list[1]!.start + 0.02);
    await expect(tapBtn(page)).toBeHidden();
    expect(await log(page)).toEqual([]);
  });
});

test.describe('reduced motion', () => {
  test('plays no audio by itself; Replay plays the comic hard-cut, with its audio', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const s = await beforeYouBegin(page, VOICED);
    await expect(cm(page)).toHaveAttribute('data-state', 'done');
    await expect(cm(page)).toHaveAttribute('data-reduced', '1');
    expect(await log(page)).toEqual([]);
    expect((await audioState(page)).current).toBeNull();
    // Nothing was fetched ahead either: it starts finished.
    expect(s.clipRequests).toEqual([]);
    // The toggle is there all the same.
    await expect(soundBtn(page)).toHaveAccessibleName('Sound on');
    await replayBtn(page).click();
    await expect(cm(page)).toHaveAttribute('data-state', 'playing');
    const list = await clips(page);
    await at(page, list[0]!.start + 0.02);
    expect((await log(page)).at(-1)).toMatchObject({ type: 'play', key: list[0]!.key });
    await skipBtn(page).click();
    expect((await audioState(page)).current).toBeNull();
  });
});

test.describe('a clip that cannot be loaded', () => {
  test('is skipped in silence: the comic carries on with the next clip and shows no error', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const list = audio.lines;
    s.missing.add(list[1]!.clip + '.mp3');
    await open(page);
    await page.locator(`.lab[data-slug="${VOICED}"] .lab-start`).click();
    await expect(cm(page)).toBeVisible();
    await expect.poll(async () => (await audioState(page)).failed, { timeout: 8000 }).toEqual([list[1]!.clip]);
    const c = await clips(page);
    await at(page, c[1]!.start + 0.3);
    expect((await log(page)).filter((e) => e.key === c[1]!.key)).toEqual([]);
    expect((await audioState(page)).current).toBeNull();
    await at(page, c[2]!.start + 0.02);
    expect((await log(page)).at(-1)).toMatchObject({ type: 'play', key: c[2]!.key });
    await expect(cm(page)).toHaveAttribute('data-state', 'playing');
    expect(s.errors).toEqual([]);
  });
});

test.describe('real playback (no test seam)', () => {
  test('the running clock starts the first clip on an Audio element of its URL, one at a time, and Skip pauses it', async ({ page }) => {
    // Record what the page asks of its media elements; the browser's own playback is left out of it.
    await page.addInitScript(() => {
      const calls: Array<{ type: string; src: string; at: number; t: number }> = [];
      (window as any).__mediaCalls = calls;
      const t0 = performance.now();
      const proto = HTMLMediaElement.prototype;
      proto.play = function (this: HTMLMediaElement) {
        calls.push({ type: 'play', src: new URL(this.src).pathname, at: performance.now() - t0, t: this.currentTime });
        return Promise.resolve();
      };
      const pause = proto.pause;
      proto.pause = function (this: HTMLMediaElement) {
        calls.push({ type: 'pause', src: new URL(this.src || 'http://x/').pathname, at: performance.now() - t0, t: this.currentTime });
        return pause.call(this);
      };
    });
    const s = await beforeYouBegin(page, VOICED, { query: '' });
    const first = audio.lines[0]!.clip;
    const media = () => page.evaluate(() => (window as any).__mediaCalls as Array<{ type: string; src: string; at: number; t: number }>);
    await expect.poll(async () => (await media()).filter((c) => c.type === 'play').length, { timeout: 15000 }).toBeGreaterThan(0);
    const firstPlay = (await media()).find((c) => c.type === 'play')!;
    expect(firstPlay.src).toBe(`/api/audio/${VOICED}/${first}.mp3`);
    // The clip is the caption of panel 1, which the timeline starts about 2 s in (lead, camera move, caption beat).
    expect(firstPlay.at).toBeGreaterThan(1000);
    // Skip pauses what is sounding and nothing plays after it.
    await skipBtn(page).click();
    await expect(cm(page)).toHaveAttribute('data-state', 'done');
    const afterSkip = await media();
    expect(afterSkip.at(-1)).toMatchObject({ type: 'pause' });
    await page.waitForTimeout(500);
    expect((await media()).length).toBe(afterSkip.length);
    // Never two playing at once: between two plays there is a pause.
    let playing = 0;
    for (const c of afterSkip) {
      playing += c.type === 'play' ? 1 : -1;
      expect(playing).toBeLessThanOrEqual(1);
    }
    expect(s.errors).toEqual([]);
  });

  test('Sound off before the comic starts: nothing is fetched or played', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('opalix.comicSound', '0');
      (window as any).__plays = 0;
      HTMLMediaElement.prototype.play = function () {
        (window as any).__plays += 1;
        return Promise.resolve();
      };
    });
    const s = await beforeYouBegin(page, VOICED, { query: '' });
    await expect(soundBtn(page)).toHaveAccessibleName('Sound off');
    await expect.poll(async () => (await timecodeSeconds(page)) > 3, { timeout: 15000 }).toBe(true);
    expect(await page.evaluate(() => (window as any).__plays)).toBe(0);
    expect(s.clipRequests).toEqual([]);
  });
});

const timecodeSeconds = async (page: Page) => {
  const t = ((await page.locator('#learnHost .cm-time').textContent()) ?? '0:00').split(' / ')[0]!.split(':').map(Number);
  return t[0]! * 60 + t[1]!;
};

test.describe('a lab with no narration', () => {
  test('is exactly as it was: Replay and Skip only, no sound controls, nothing fetched, nothing scheduled', async ({ page }) => {
    const s = await beforeYouBegin(page, SILENT);
    await expect(page.locator('#learnHost .cm-controls').getByRole('button')).toHaveText(['Replay', 'Skip']);
    expect(await page.locator('#learnHost .cm button').count()).toBe(2);
    await expect(page.locator('#btnComicSound, #btnComicTapSound')).toHaveCount(0);
    expect(await clips(page)).toEqual([]);
    const tl = await timeline(page);
    await at(page, tl.pages[0]!.panels[1]!.start + 1);
    expect(await log(page)).toEqual([]);
    expect(s.clipRequests).toEqual([]);
    await skipBtn(page).click();
    await expect(cm(page)).toHaveAttribute('data-state', 'done');
    expect(s.errors).toEqual([]);
  });

  test('an old API that sends no slug plays the comic silently, with no sound controls', async ({ page }) => {
    const s = await stub(page);
    // Registered last, so it answers first: the same bundle, without the slug beside it.
    await page.route('**/api/learn/**', (route) => json(route, { version: '1.0.0', learn: bundle }));
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    await page.locator(`.lab[data-slug="${VOICED}"] .lab-start`).click();
    await expect(cm(page)).toBeVisible();
    await expect(soundBtn(page)).toHaveCount(0);
    expect(s.clipRequests).toEqual([]);
  });
});
