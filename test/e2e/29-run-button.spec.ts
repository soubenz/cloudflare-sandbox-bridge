import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { serveConsole } from './console-server';
import { MODULE_PAGE, pressStart } from './browse';

/**
 * The Run button on a lab brief's shell blocks (dashboard/src/code-copy.js).
 *
 * What is pinned here:
 *   - a ```bash block in the brief of a running lab has Run beside Copy; a plain block, a ```python one and
 *     a ```bash one with a `<placeholder>` in it have Copy only;
 *   - Run puts the terminal on screen (the Terminal tab selected, the address ending in /terminal) and the
 *     terminal's socket receives Ctrl-E Ctrl-U, then each command with Enter, comments and blank lines left out;
 *     a ```console block runs only its `$ ` lines, without the prompt;
 *   - Run is reachable from the keyboard;
 *   - with the terminal not connected, Run says "Terminal not ready", sends nothing and stays on the brief;
 *   - once the lab is left, the brief has no Run buttons.
 *
 * Like 16 to 28 this needs no password, no API and no container: a small static server serves
 * dashboard/public and every call is answered by a route stub, the terminal's socket too. Run
 * `npm run build:dashboard` first. RUN_SHOTS=<dir> also saves screenshots of the brief (light, dark, phone).
 */

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(resolve(here, '../..'), 'dashboard/public');
const API = 'https://opalix-sandbox.soubenz94.workers.dev';
const SESSION_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const SHOTS = process.env.RUN_SHOTS ?? '';
const SLUG = 'keep-eu-data-on-eu-routes';

const LABS = [
  {
    slug: SLUG,
    version: '1.0.0',
    title: 'Keep EU data on EU routes',
    type: 'build',
    family: 'gateway',
    summary: 'Route EU traffic to EU deployments.',
    objectives: ['send a call through the gateway'],
    difficulty: 'intro',
    timeout_minutes: 30,
    estimated_minutes: 20,
    tier: 'free',
    path: 'ai-platform',
    module: 1,
    order: 1,
    has_learn: false,
    progress: null,
  },
];

const SUPPORT = 'python3 -B send_calls.py support "hello gateway"';
const FAST = 'python3 -B send_calls.py fast "hello gateway"';
const BRIEF = [
  '# See what a gateway actually does',
  '',
  'LiteLLM sits between the app and the provider. Talk to it with `send_calls.py`.',
  '',
  '## Start here',
  '',
  '```bash',
  '# one call to each alias',
  SUPPORT,
  '',
  FAST,
  '```',
  '',
  'Each run prints the HTTP status and the deployment that answered.',
  '',
  '## Check the gateway',
  '',
  '```console',
  '$ curl -s localhost:4000/health/readiness',
  '{"status": "healthy"}',
  '```',
  '',
  '## What the config looks like',
  '',
  '```',
  'model_list:',
  '  - model_name: support',
  '```',
  '',
  '## Onboard your team',
  '',
  '```bash',
  'python3 -B platform/onboard.py <team-name>',
  '```',
  '',
  '```python',
  'print("not a shell command")',
  '```',
  '',
].join('\n');

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
  /** What each terminal socket the page opened has sent: text frames as they are, binary ones decoded. */
  terminals: Array<{ frames: string[] }>;
  /** Close every terminal socket as soon as it opens: a terminal that never gets connected. */
  refuse: boolean;
  errors: string[];
}

async function stub(page: Page, o: Partial<Stub> = {}): Promise<Stub> {
  const s: Stub = { terminals: [], refuse: false, errors: [], ...o };
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/me') return json(route, { sub: 'console', user_id: 'console' });
    if (path === '/api/labs') return json(route, LABS);
    if (path === '/api/onboarding') return json(route, { error: { code: 'no_onboarding', message: 'none' } }, 404);
    if (path.startsWith('/api/learn/')) return json(route, { error: { code: 'no_learn', message: 'no learning content' } }, 404);
    if (path === '/api/start' && method === 'POST') return json(route, { id: SESSION_ID, state: 'starting', token: 'test-token', urls: { services: {} } }, 202);
    return json(route, { error: 'not stubbed' }, 404);
  });
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const method = req.method();
    const sess = `/sessions/${SESSION_ID}`;
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (p === sess && method === 'GET') {
      const now = Date.now();
      return json(route, {
        meta: { state: 'running', lab_slug: SLUG, started_at: now, expires_at: now + 3_000_000, end_reason: null },
        services: {},
        snapshots: [],
        manifest_summary: { title: 'A lab', checks: [{ name: 'gateway-is-up' }] },
        checks_history: [],
        server_time: now,
      });
    }
    if (p === `${sess}/events`) return new Promise<void>(() => {}); // held open, saying nothing
    if (p === `${sess}/files` && method === 'GET') return json(route, [{ name: 'brief.md', size: BRIEF.length, isDirectory: false }]);
    if (p === `${sess}/files/brief.md` && method === 'GET') return json(route, { content: BRIEF });
    if (p === sess && method === 'DELETE') return json(route, { ok: true });
    if (p.startsWith(sess) && method !== 'GET') return json(route, {});
    return json(route, { error: 'not stubbed' }, 404);
  });
  // The terminal's socket: accepted and silent, keeping what the page types into it.
  await page.routeWebSocket(/\/terminal/, (ws) => {
    const entry = { frames: [] as string[] };
    s.terminals.push(entry);
    ws.onMessage((m) => entry.frames.push(typeof m === 'string' ? m : Buffer.from(m).toString('utf8')));
    if (s.refuse) ws.close({ code: 1006 });
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

async function startLab(page: Page, { theme, size = { width: 1440, height: 900 } }: { theme?: 'light' | 'dark'; size?: { width: number; height: number } } = {}) {
  await page.setViewportSize(size);
  await page.addInitScript((t) => {
    localStorage.setItem('opalixOnboarded', '1');
    localStorage.setItem('opalixLearn', JSON.stringify({ v: 1, onboarding: { status: 'skipped', at: 1, levels: {} } }));
    if (t) localStorage.setItem('opalixTheme', t);
  }, theme ?? null);
  await page.goto(MODULE_PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
  await pressStart(page, SLUG);
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#statePill')).toHaveText('running');
  await expect(page.locator('#guide')).toHaveAttribute('data-ready', 'true');
}

const blocks = (page: Page) => page.locator('#briefBody pre');
const bashBlock = (page: Page) => blocks(page).nth(0);
const consoleBlock = (page: Page) => blocks(page).nth(1);
/** The commands a terminal was sent after it opened (resize and ping frames are control messages, not typing). */
const typed = (frames: string[]) => frames.filter((f) => !f.startsWith('\x01'));

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.locator('#briefBody').screenshot({ path: join(SHOTS, `${name}-brief.png`) });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test.describe('the Run button on a brief’s shell blocks', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('is on the bash and console blocks, beside Copy; a plain and a python block have Copy only', async ({ page }) => {
    const s = await stub(page);
    await startLab(page);
    await expect(blocks(page)).toHaveCount(5);
    await expect(bashBlock(page)).toHaveAttribute('data-lang', 'bash');
    for (const i of [0, 1]) {
      const pre = blocks(page).nth(i);
      const run = pre.getByRole('button', { name: 'Run this in the terminal' });
      await expect(run).toBeVisible();
      await expect(run).toHaveText('Run');
      await expect(pre.getByRole('button', { name: 'Copy this code' })).toBeVisible();
      // Run comes first, then Copy in the corner; neither covers the code.
      const runBox = (await run.boundingBox())!;
      const copyBox = (await pre.getByRole('button', { name: 'Copy this code' }).boundingBox())!;
      const codeBox = (await pre.locator('code').boundingBox())!;
      expect(runBox.x + runBox.width).toBeLessThanOrEqual(copyBox.x);
      expect(runBox.y + runBox.height).toBeLessThanOrEqual(codeBox.y);
    }
    // A bash block with a <placeholder> to fill in cannot be run as written: Copy only.
    await expect(blocks(page).nth(3)).toHaveAttribute('data-lang', 'bash');
    for (const i of [2, 3, 4]) {
      await expect(blocks(page).nth(i).locator('.code-run')).toHaveCount(0);
      await expect(blocks(page).nth(i).locator('.code-copy')).toHaveCount(1);
    }
    await shot(page, 'desktop-light');
    expect(s.errors).toEqual([]);
  });

  test('shows the terminal and types the commands into it, pressing Enter after each', async ({ page }) => {
    const s = await stub(page);
    await startLab(page);
    await expect.poll(() => s.terminals.length).toBe(1);
    // The terminal is not on screen yet: the workspace opens on the files.
    await expect(page.locator('#viewTerminal')).toBeHidden();
    await bashBlock(page).getByRole('button', { name: 'Run this in the terminal' }).click();
    await expect(bashBlock(page).locator('.code-run-label')).toHaveText('Running');
    // Just as the Terminal tab would: the tab selected, the view shown, the address following it.
    await expect(page.locator('#tabTerminal')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#viewTerminal')).toBeVisible();
    await expect(page).toHaveURL(/\/session\/[^/]+\/terminal$/);
    await expect.poll(() => typed(s.terminals[0]!.frames)).toEqual(['\x05\x15', `${SUPPORT}\r`, `${FAST}\r`]);
    await shot(page, 'desktop-light-after-run');
    // The label comes back.
    await expect(bashBlock(page).locator('.code-run-label')).toHaveText('Run', { timeout: 5_000 });
    expect(s.errors).toEqual([]);
  });

  test('a console block runs only its prompted lines, without the prompt; Run works from the keyboard', async ({ page }) => {
    const s = await stub(page);
    await startLab(page);
    await expect.poll(() => s.terminals.length).toBe(1);
    const run = consoleBlock(page).getByRole('button', { name: 'Run this in the terminal' });
    await run.focus();
    await expect(run).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => typed(s.terminals[0]!.frames)).toEqual(['\x05\x15', 'curl -s localhost:4000/health/readiness\r']);
    await expect(page.locator('#viewTerminal')).toBeVisible();
  });

  test('with the terminal not connected it says "Terminal not ready", sends nothing and leaves the workspace as it was', async ({ page }) => {
    const s = await stub(page, { refuse: true });
    await startLab(page);
    await expect.poll(() => s.terminals.length).toBeGreaterThanOrEqual(1);
    const run = bashBlock(page).getByRole('button', { name: 'Run this in the terminal' });
    await run.click();
    await expect(bashBlock(page).locator('.code-run-label')).toHaveText('Terminal not ready');
    await expect(page.locator('#viewTerminal')).toBeHidden();
    await expect(page.locator('#tabTerminal')).toHaveAttribute('aria-selected', 'false');
    for (const t of s.terminals) expect(typed(t.frames)).toEqual([]);
    await expect(bashBlock(page).locator('.code-run-label')).toHaveText('Run', { timeout: 5_000 });
  });

  test('is gone once the lab is left', async ({ page }) => {
    await stub(page);
    await startLab(page);
    await expect(page.locator('#briefBody .code-run')).toHaveCount(2);
    await page.locator('#btnEnd').click();
    await page.locator('#endDialog').getByRole('button', { name: 'Discard' }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator('#briefBody .code-run')).toHaveCount(0);
    // Copy stays on the blocks (in its corner), for whenever the brief is read again.
    await expect(page.locator('#briefBody .code-copy')).toHaveCount(5);
  });

  test('looks right in the dark and on a phone', async ({ page }) => {
    test.skip(!SHOTS, 'screenshots only: set RUN_SHOTS=<dir>');
    await stub(page);
    await startLab(page, { theme: 'dark' });
    await expect(bashBlock(page).locator('.code-run')).toBeVisible();
    await shot(page, 'desktop-dark');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(bashBlock(page).locator('.code-run')).toBeVisible();
    await bashBlock(page).scrollIntoViewIfNeeded();
    await shot(page, 'phone-dark');
    await bashBlock(page).locator('.code-run').click();
    await expect(page.locator('#viewTerminal')).toBeVisible();
    await shot(page, 'phone-dark-after-run');
  });

  test('on a phone both buttons show and fit in the block', async ({ page }) => {
    await stub(page);
    // A lab is started on a wide screen (a phone is asked to use a desktop), then read narrow.
    await startLab(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const pre = bashBlock(page);
    await pre.scrollIntoViewIfNeeded();
    const run = pre.locator('.code-run');
    const copy = pre.locator('.code-copy');
    await expect(run).toBeVisible();
    await expect(copy).toBeVisible();
    expect(await copy.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    const box = (await pre.boundingBox())!;
    const r = (await run.boundingBox())!;
    const c = (await copy.boundingBox())!;
    expect(r.x).toBeGreaterThanOrEqual(box.x);
    expect(c.x + c.width).toBeLessThanOrEqual(box.x + box.width);
    await shot(page, 'phone-light');
    // The window is stacked under the guide here: Run brings the terminal into view.
    await run.click();
    await expect(page.locator('#viewTerminal')).toBeVisible();
    await expect(page.locator('#viewTerminal')).toBeInViewport();
  });
});
