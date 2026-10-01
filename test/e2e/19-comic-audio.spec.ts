import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Locator, type Page, type Route } from '@playwright/test';
import { serveConsole } from './console-server';
import { MULTI as MULTI_COMIC, SINGLE, bundleOf, narrationOf, oldShapeNarrationOf, type FixtureAudio, type FixtureBundle } from './comic-fixture';

/**
 * The motion comic's storyteller in the console: a lab whose comic is narrated (one voiceover clip per
 * panel, one narrator voice; speech bubbles are text only) gets a Sound on/off toggle beside Replay and
 * Skip (remembered, on by default), each clip is started by the comic's own clock at the time the
 * timeline gives it (0.6 s into its panel) and exactly one plays at a time, Skip and Replay and the toggle
 * stop it, the browser's refusal to start sound shows a "Tap to turn the sound on" button, reduced motion
 * plays nothing by itself, a clip that will not load is skipped, narration of the old shape (caption and
 * bubble clips) or of other words plays silent, and a lab without narration is exactly as it was.
 *
 * Like 18-comic.spec.ts this needs no password, no API and no container: a static server serves
 * dashboard/public (the built bundle, with the CSP from public/_headers) and every call the console makes
 * is answered by a route stub, the audio route included (it serves a real mp3 fixture). The content is
 * inline (comic-fixture.ts): a small learn bundle, a two-page and a three-page comic written to the
 * current contract, and their narration with made-up clip lengths; no lab's own content is read. In test
 * mode (?comicTest=1) the comic never starts real playback: the
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

// A small comic written to the current contract (a voiceover per panel, Maren, Tomasz and You, bubbles as text)
// with the narration `labs narrate` would write for it, three or five made-up clips (every clip the stub serves
// is the same sample mp3). See comic-fixture.ts; no lab's own comic or narration is read.
type Bundle = FixtureBundle;

const VOICED = 'see-what-a-gateway-does';
const MULTI = 'follow-one-request-through-the-stack';
const SILENT = 'see-how-requests-are-routed';
const OLD_SHAPE = 'prove-where-one-requests-data-went';
const MISMATCH = 'see-why-a-document-matched';
const audio = narrationOf(SINGLE);
const multiAudio = narrationOf(MULTI_COMIC);
const bundle = bundleOf(SINGLE, audio);
/** The old narration: a clip per caption and per bubble, several voices. A console plays it silent, whole. */
const oldShape = oldShapeNarrationOf(SINGLE);
/** Narration of other words than the comic's: a voice must never say what the panel does not. */
const wrongWords: FixtureAudio = structuredClone(audio);
wrongWords.clips[wrongWords.lines[1]!.clip]!.text = 'Some other words entirely.';
const BUNDLES: Record<string, Bundle> = {
  [VOICED]: bundle,
  [MULTI]: bundleOf(MULTI_COMIC, multiAudio),
  [SILENT]: bundleOf(SINGLE),
  [OLD_SHAPE]: bundleOf(SINGLE, oldShape),
  [MISMATCH]: bundleOf(SINGLE, wrongWords),
};
/** The labs whose clips the audio route serves. */
const NARRATED = new Set([VOICED, MULTI, OLD_SHAPE, MISMATCH]);

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
  lab({ slug: VOICED, title: 'See what a gateway does', order: 1 }),
  lab({ slug: MULTI, title: 'Follow one request through the stack', order: 2 }),
  lab({ slug: SILENT, title: 'See how requests are routed', order: 3 }),
  lab({ slug: OLD_SHAPE, title: 'Prove where one request data went', order: 4 }),
  lab({ slug: MISMATCH, title: 'See why a document matched', order: 5 }),
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
    if (!m || !NARRATED.has(m[1]!)) return route.fulfill({ status: 404, body: 'no' });
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
  kind: 'voiceover';
  bubble: null;
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
  timeline: () => { total: number; pages: Array<{ panels: Array<{ number: number; start: number; end: number; captionAt: number | null; bubbles: Array<{ start: number; end: number; wordTimes: number[] }> }> }> };
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
  test('the seam lists one voiceover clip per voiced panel with the start the timeline gives it', async ({ page }) => {
    await beforeYouBegin(page, VOICED);
    const list = await clips(page);
    expect(list).toHaveLength(audio.lines.length);
    expect(list.map((c) => c.panel)).toEqual([1, 2, 3, 5, 6]); // panel 4 is a silent screen
    expect(list.every((c) => c.kind === 'voiceover' && c.bubble === null)).toBe(true);
    expect(list.map((c) => c.key).sort()).toEqual(audio.lines.map((l) => l.clip).sort());
    for (const c of list) {
      expect(c.url).toBe(`/api/audio/${VOICED}/${c.key}.mp3`);
      expect(c.end - c.start).toBeCloseTo(audio.clips[c.key]!.seconds, 2);
    }
    // Never two at once, and a breath of silence between one voiceover and the next.
    for (let i = 1; i < list.length; i++) expect(list[i]!.start - list[i - 1]!.end).toBeGreaterThanOrEqual(0.5);
    // Each clip starts 0.6 s into its panel, and the panel is held until the voice is done and the hold has passed.
    const tl = await timeline(page);
    const panels = tl.pages.flatMap((p) => p.panels);
    for (const c of list) {
      const p = panels[c.panel - 1]!;
      expect(c.start).toBeCloseTo(p.start + 0.6, 6);
      expect(p.end).toBeGreaterThanOrEqual(c.end + 2 - 1e-6);
    }
    expect(panels[3]!.captionAt).toBeCloseTo(panels[3]!.start + 0.5, 6); // a caption fades in at the panel start, voiced or not
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

  test('shows a bubble as text only, typed after the voiceover starts and within it, one bubble after the other', async ({ page }) => {
    await beforeYouBegin(page, VOICED);
    const list = await clips(page);
    const tl = await timeline(page);
    const duo = tl.pages[1]!.panels[0]!; // panel 5: two bubbles
    const c = list.find((x) => x.panel === duo.number)!;
    const panel = page.locator(`#learnHost .cm-panel[data-panel="${duo.number}"]`);
    const totals = [await panel.locator('.cm-bub').nth(0).locator('.cm-w').count(), await panel.locator('.cm-bub').nth(1).locator('.cm-w').count()];
    expect(duo.bubbles[0]!.start).toBeCloseTo(c.start + 0.8, 6);
    // Nothing is typed until 0.8 s after the voice starts.
    await at(page, c.start + 0.7);
    expect(await bubbleWordsOn(panel, 0)).toBe(0);
    // Half way through the first bubble's words, some are typed and not all.
    const w = duo.bubbles[0]!.wordTimes;
    await at(page, (w[0]! + w.at(-1)!) / 2 + 0.01);
    const half = await bubbleWordsOn(panel, 0);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(totals[0]!);
    expect(await bubbleWordsOn(panel, 1)).toBe(0); // the second speaker waits their turn
    // By the end of the voice plus a second both are fully typed; no clip is ever made for a bubble.
    await at(page, c.end + 1.05);
    expect(await bubbleWordsOn(panel, 0)).toBe(totals[0]);
    expect(await bubbleWordsOn(panel, 1)).toBe(totals[1]);
    expect(duo.bubbles[1]!.end).toBeLessThanOrEqual(c.end + 1 + 1e-6);
    expect(list.filter((x) => x.panel === duo.number)).toHaveLength(1);
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
    // The clip is the voiceover of panel 1, which the timeline starts about 4 s in (lead, the first page's title card, the 0.6 s beat).
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

test.describe('narration a console cannot trust plays silent, whole', () => {
  for (const [what, slug] of [
    ['of the old shape (a clip per caption and per bubble, several voices)', OLD_SHAPE],
    ['of other words than the comic\'s', MISMATCH],
  ] as const) {
    test(`${what}: Replay and Skip only, no sound controls, nothing scheduled, nothing fetched, nothing broken`, async ({ page }) => {
      const s = await beforeYouBegin(page, slug);
      await expect(page.locator('#learnHost .cm-controls').getByRole('button')).toHaveText(['Replay', 'Skip']);
      await expect(page.locator('#btnComicSound, #btnComicTapSound')).toHaveCount(0);
      expect(await clips(page)).toEqual([]);
      const tl = await timeline(page);
      // The comic is on its ordinary, silent schedule: no panel is held for a voice.
      const silent = tl.pages.flatMap((p) => p.panels);
      for (const t of [silent[0]!.start + 1, silent[2]!.start + 1, silent[4]!.start + 1]) {
        await at(page, t);
        expect(await log(page)).toEqual([]);
      }
      expect(s.clipRequests).toEqual([]);
      await skipBtn(page).click();
      await expect(cm(page)).toHaveAttribute('data-state', 'done');
      expect(s.errors).toEqual([]);
    });
  }
});

test.describe('exactly one clip at a time', () => {
  test('sweeping the whole clock, one clip is sounding at most, and it is the one the timeline says', async ({ page }) => {
    await beforeYouBegin(page, VOICED);
    const tl = await timeline(page);
    const list = await clips(page);
    for (let t = 0; t <= tl.total; t += 0.4) {
      await at(page, t);
      const want = list.find((c) => t >= c.start && t < c.end)?.key ?? null;
      expect((await audioState(page)).current, `at ${t.toFixed(1)} s`).toBe(want);
    }
    const entries = await log(page);
    neverTwoAtOnce(entries);
    expect(new Set(entries.filter((e) => e.type === 'play').map((e) => e.key))).toEqual(new Set(list.map((c) => c.key)));
  });
});

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

test.describe('a narrated comic of several pages', () => {
  test('has a clip per voiced panel across the pages, in order, each inside its panel, one at a time', async ({ page }) => {
    await beforeYouBegin(page, MULTI);
    const tl = await timeline(page);
    const list = await clips(page);
    expect(tl.pages).toHaveLength(3);
    expect(list).toHaveLength(9); // every panel of the comic is voiced
    expect(list.map((c) => c.panel)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const panels = tl.pages.flatMap((p) => p.panels);
    for (const c of list) {
      const p = panels[c.panel - 1]!;
      expect(c.start).toBeGreaterThanOrEqual(p.start + 0.6 - 1e-6);
      expect(c.end).toBeLessThanOrEqual(p.end);
    }
    for (let i = 1; i < list.length; i++) expect(list[i]!.start).toBeGreaterThan(list[i - 1]!.end);
    // Jump over a page turn: the clip of the earlier page stops, the next starts at its offset.
    await at(page, list[3]!.start + 0.5);
    expect((await audioState(page)).current).toBe(list[3]!.key);
    await at(page, list[4]!.start + 0.4);
    expect((await audioState(page)).current).toBe(list[4]!.key);
    neverTwoAtOnce(await log(page));
  });

  for (const width of [800, 1000, 1280]) {
    test(`at ${width}px the stage and its Sound toggle fit the card, with no sideways scroll`, async ({ page }) => {
      const s = await stub(page);
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      await page.locator(`.lab[data-slug="${MULTI}"] .lab-start`).click();
      await expect(cm(page)).toBeVisible();
      const tl = await timeline(page);
      for (const t of [tl.pages[0]!.panels[1]!.start + 2, tl.pages[1]!.panels[0]!.start + 2, tl.total]) {
        await at(page, t);
        await noHorizontalScroll(page);
      }
      await expect(soundBtn(page)).toBeVisible();
      const box = (await soundBtn(page).boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
      expect(s.errors).toEqual([]);
    });
  }
});
