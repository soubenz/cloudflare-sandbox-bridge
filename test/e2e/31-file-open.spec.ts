import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { serveConsole } from './console-server';
import { MODULE_PAGE, pressStart } from './browse';

/**
 * Opening a file is instant: once the tree is drawn, the console reads the text files it lists in one batch
 * call (POST /sessions/:id/files/read) and an open shows the file from that, without waiting for the file's
 * own read (a round trip into the lab's machine, ~1 s live). The own read still happens, in the background,
 * and replaces the text only when it changed and nothing is unsaved (dashboard/src/file-cache.js).
 *
 * Like 17-session-layout.spec.ts and 30-hidden-files.spec.ts this needs no password, no API and no
 * container: dashboard/public is served locally and every call the console makes is a route stub. The single
 * read is held back on purpose (READ_DELAY_MS), so a test that sees the text before then saw the batch's.
 *
 * Run `npm run build:dashboard` first. FILE_OPEN_SHOTS_DIR chooses where the screenshot goes (default
 * test/e2e/shots/file-open); FILE_OPEN_SHOTS=0 skips it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC = join(ROOT, 'dashboard/public');
const API = 'https://opalix-sandbox.soubenz94.workers.dev';
const SHOTS = process.env.FILE_OPEN_SHOTS_DIR || join(here, 'shots/file-open');
const SESSION_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const SLUG = 'open-files-fast';

/** Long enough that seeing the text before it means the single read was not waited for. */
const READ_DELAY_MS = 4_000;

const BIG = 'x'.repeat(200 * 1024);
const START_FILES: Record<string, string> = {
  'brief.md': '# Brief\n\nOpen `app.py`.\n',
  'app.py': 'def handler(request):\n    return "hello from app.py"\n',
  'notes.md': '# Notes\n\nnothing yet\n',
  'config/settings.yaml': 'mode: fast\n',
  'big.log': BIG,
  'logo.png': 'PNG',
};

const LAB = {
  slug: SLUG,
  title: 'Open files fast',
  version: '1.0.0',
  type: 'build',
  family: 'gateway',
  summary: 'A lab with a few files',
  objectives: ['open them'],
  difficulty: 'intro',
  timeout_minutes: 60,
  estimated_minutes: 15,
  tier: 'free',
  path: 'ai-platform',
  module: 1,
  order: 1,
  has_learn: false,
  progress: null,
};

const json = (route: Route, body: unknown, status = 200) => {
  const origin = route.request().headers()['origin'];
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {},
    body: JSON.stringify(body),
  });
};

function listing(files: Map<string, string>, dir: string) {
  const prefix = dir ? `${dir}/` : '';
  const seen = new Map<string, { name: string; size: number; isDirectory: boolean }>();
  for (const [path, text] of files) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...rest] = path.slice(prefix.length).split('/');
    seen.set(name!, { name: name!, size: rest.length ? 0 : text.length, isDirectory: rest.length > 0 });
  }
  return [...seen.values()];
}

interface Stub {
  /** What the single read answers (the file as it is now). */
  files: Map<string, string>;
  /** What the batch answers, when it should differ from `files` (the file as it was). */
  batchFiles: Map<string, string>;
  batches: string[][];
  reads: string[];
  writes: string[];
  readDelay: number;
  batchStatus: number;
  errors: string[];
}

async function stub(page: Page): Promise<Stub> {
  const s: Stub = {
    files: new Map(Object.entries(START_FILES)),
    batchFiles: new Map(),
    batches: [],
    reads: [],
    writes: [],
    readDelay: READ_DELAY_MS,
    batchStatus: 200,
    errors: [],
  };
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) s.errors.push(msg.text());
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/api/me') return json(route, { sub: 'console', user_id: 'console' });
    if (url.pathname === '/api/labs') return json(route, [LAB]);
    if (url.pathname === '/api/onboarding') return json(route, { error: { code: 'no_onboarding', message: 'none' } }, 404);
    if (url.pathname.startsWith('/api/learn/')) return json(route, { error: { code: 'no_learn', message: 'no learning content' } }, 404);
    if (url.pathname === '/api/start' && method === 'POST') return json(route, { id: SESSION_ID, state: 'starting', token: 'test-token', urls: { services: {} } }, 202);
    return json(route, { error: 'not stubbed' }, 404);
  });

  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const p = url.pathname;
    const base = `/sessions/${SESSION_ID}`;
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (p === base && method === 'GET') {
      const now = Date.now();
      return json(route, {
        meta: { state: 'running', lab_slug: SLUG, started_at: now, expires_at: now + 3_000_000, end_reason: null },
        services: {},
        snapshots: [],
        cost: { usd: 0 },
        hints: { total: 0, schedule: [], delivered: [] },
        manifest_summary: { title: LAB.title, learner_restart: false, checks: [{ name: 'it-works' }], services: [] },
        checks_history: [],
        server_time: now,
      });
    }
    if (p === `${base}/events`) return new Promise<void>(() => {}); // held open and silent
    if (p === `${base}/files` && method === 'GET') {
      const dir = (url.searchParams.get('path') ?? '/workspace').replace(/^\/workspace\/?/, '');
      return json(route, listing(s.files, dir));
    }
    if (p === `${base}/files/read` && method === 'POST') {
      const { paths } = JSON.parse(req.postData() ?? '{}') as { paths: string[] };
      s.batches.push(paths);
      if (s.batchStatus !== 200) return json(route, { error: { code: 'internal_error', message: 'Internal error' } }, s.batchStatus);
      return json(route, {
        files: paths.map((path) => {
          const text = s.batchFiles.get(path) ?? s.files.get(path);
          return text === undefined ? { path, error: { code: 'not_found', message: `No such file or directory: ${path}` } } : { path, content: text, encoding: 'utf-8' };
        }),
      });
    }
    const file = p.startsWith(`${base}/files/`) ? decodeURIComponent(p.slice(`${base}/files/`.length)) : null;
    if (file !== null && method === 'GET') {
      s.reads.push(file);
      await new Promise((r) => setTimeout(r, s.readDelay));
      const text = s.files.get(file);
      return text === undefined ? json(route, { error: { code: 'not_found', message: `${file} does not exist` } }, 404) : json(route, { content: text, encoding: 'utf-8' });
    }
    if (file !== null && method === 'PUT') {
      s.writes.push(file);
      s.files.set(file, req.postData() ?? '');
      return json(route, { ok: true });
    }
    if (p.startsWith(base) && method !== 'GET') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'access-control-allow-credentials': 'true' } });
    return json(route, { error: 'not stubbed' }, 404);
  });

  await page.routeWebSocket(/\/terminal/, () => {});
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

/** Starts the lab and opens the Editor tab, where the tree is. */
async function session(page: Page, prepare?: (s: Stub) => void) {
  const s = await stub(page);
  prepare?.(s);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('opalixOnboarded', '1');
    localStorage.setItem('opalixLearn', JSON.stringify({ v: 1, onboarding: { status: 'skipped', at: 1, levels: {} } }));
  });
  await page.goto(MODULE_PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
  await pressStart(page, SLUG);
  await expect(page.locator('#statePill')).toHaveText('running');
  await expect(page.locator('#bootModal')).toBeHidden();
  await page.locator('#workspaceTabs [role="tab"]', { hasText: 'Editor' }).click();
  await expect(page.locator('#fileList li:has(.name)').first()).toBeVisible();
  return s;
}

const fileButton = (page: Page, name: string) => page.locator('#fileList button', { hasText: name });
const editorText = (page: Page) => page.locator('#viewEditor .cm-content');

test.describe('opening a file', () => {
  test('a file the tree listed opens from the batch read, without waiting for its own read', async ({ page }) => {
    const s = await session(page);
    // One batch for the tree's text files: not the big one, not the image, not the folder (nor brief.md, which the tree leaves out).
    await expect.poll(() => s.batches.length).toBe(1);
    expect(s.batches[0]!.sort()).toEqual(['app.py', 'notes.md']);

    const clicked = Date.now();
    await fileButton(page, 'app.py').click();
    await expect(editorText(page)).toContainText('hello from app.py', { timeout: READ_DELAY_MS / 2 });
    const shownAfter = Date.now() - clicked;
    expect(shownAfter).toBeLessThan(READ_DELAY_MS / 2);
    await expect(page.locator('#editorPath')).toHaveText('app.py');
    await expect(page.locator('#editorStatus')).toHaveText('');
    await expect(page.locator('#btnSaveFile')).toBeEnabled();
    // The file's own read is still made, in the background, to catch a change.
    await expect.poll(() => s.reads).toContain('app.py');
    if (process.env.FILE_OPEN_SHOTS !== '0') {
      mkdirSync(SHOTS, { recursive: true });
      await page.locator('#viewEditor').screenshot({ path: join(SHOTS, 'opened-from-prefetch.png') });
    }

    // Expanding a folder reads what it shows, in a batch of its own.
    await fileButton(page, 'config').click();
    await expect.poll(() => s.batches.length).toBe(2);
    expect(s.batches[1]).toEqual(['config/settings.yaml']);
    await fileButton(page, 'settings.yaml').click();
    await expect(editorText(page)).toContainText('mode: fast', { timeout: READ_DELAY_MS / 2 });
    expect(s.errors).toEqual([]);
  });

  test('the background read replaces the text when the file changed, but never over unsaved edits', async ({ page }) => {
    const s = await session(page, (stubbed) => {
      stubbed.readDelay = 800;
      // What the batch saw is older than the file now (a terminal command changed both since).
      stubbed.batchFiles.set('app.py', 'old = 1\n');
      stubbed.batchFiles.set('notes.md', '# Notes\n\nold notes\n');
      stubbed.files.set('notes.md', '# Notes\n\nnew notes\n');
      stubbed.files.set('app.py', 'new = 2\n');
    });
    await expect.poll(() => s.batches.length).toBe(1);

    // Not touched: the newer text replaces the older one once the read lands.
    await fileButton(page, 'app.py').click();
    await expect(editorText(page)).toContainText('old = 1');
    await expect(editorText(page)).toContainText('new = 2');
    await expect(page.locator('#editorStatus')).not.toHaveText('unsaved');

    // Typed into before the read lands: the edits stay, unsaved.
    await fileButton(page, 'notes.md').click();
    await expect(editorText(page)).toContainText('old notes');
    await editorText(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('mine');
    await expect.poll(() => s.reads.filter((r) => r === 'notes.md').length).toBe(1);
    await page.waitForTimeout(1_200);
    await expect(editorText(page)).toContainText('old notes');
    await expect(editorText(page)).toContainText('mine');
    await expect(editorText(page)).not.toContainText('new notes');
    await expect(page.locator('#editorStatus')).toHaveText('unsaved');
    expect(s.errors).toEqual([]);
  });

  test('a save keeps what was written, and a failed batch falls back to the single read', async ({ page }) => {
    const s = await session(page, (stubbed) => {
      stubbed.batchStatus = 500;
      stubbed.readDelay = 0;
    });
    await expect.poll(() => s.batches.length).toBe(1);
    await fileButton(page, 'app.py').click();
    await expect(editorText(page)).toContainText('hello from app.py');
    await editorText(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('# saved');
    await page.locator('#btnSaveFile').click();
    await expect(page.locator('#editorStatus')).toHaveText('saved');
    expect(s.files.get('app.py')).toContain('# saved');

    // Reopening shows the saved text straight away, from what the save wrote.
    await fileButton(page, 'notes.md').click();
    await expect(editorText(page)).toContainText('nothing yet');
    s.readDelay = READ_DELAY_MS;
    await fileButton(page, 'app.py').click();
    await expect(editorText(page)).toContainText('# saved', { timeout: READ_DELAY_MS / 2 });
    expect(s.errors).toEqual([]);
  });
});
