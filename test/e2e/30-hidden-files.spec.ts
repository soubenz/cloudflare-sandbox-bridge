import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { parse as parseYaml } from 'yaml';
import { serveConsole } from './console-server';
import { MODULE_PAGE, pressStart } from './browse';

/**
 * The editor's file tree leaves out what the learner never needs: brief.md and hints.md on every lab
 * (the Brief and Hints tabs show them), and the paths a lab's manifest lists under `hidden`, such as
 * see-what-a-gateway-does's `services/` (a scripted fake provider and the view tab's page). The files
 * are still in the workspace listing the API returns; only the tree drops them.
 *
 * Like 17-session-layout.spec.ts this needs no password, no API and no container: dashboard/public is
 * served locally and every call the console makes is a route stub. The workspace is the real one, read
 * from labs/see-what-a-gateway-does/workspace plus brief.md beside it, as `labs publish` lays it out,
 * and `hidden` is the lab's own manifest's.
 *
 * Run `npm run build:dashboard` first. HIDDEN_SHOTS_DIR chooses where the screenshots go (default
 * test/e2e/shots/hidden); HIDDEN_SHOTS=0 skips them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC = join(ROOT, 'dashboard/public');
const API = 'https://opalix-sandbox.soubenz94.workers.dev';
const SHOTS = process.env.HIDDEN_SHOTS_DIR || join(here, 'shots/hidden');
const SESSION_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';

const GATEWAY = 'see-what-a-gateway-does';
const PLAIN = 'a-lab-that-hides-nothing';

/** Every file of a lab's workspace as `labs publish` ships it: workspace/'s contents, brief.md and hints.md beside them. */
function publishedWorkspace(slug: string): Map<string, string> {
  const dir = join(ROOT, 'labs', slug);
  const files = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (name === '__pycache__') continue;
      if (statSync(full).isDirectory()) walk(full);
      else files.set(relative(join(dir, 'workspace'), full), readFileSync(full, 'utf8'));
    }
  };
  walk(join(dir, 'workspace'));
  for (const f of ['brief.md', 'hints.md']) if (existsSync(join(dir, f))) files.set(f, readFileSync(join(dir, f), 'utf8'));
  return files;
}

const gatewayHidden = (parseYaml(readFileSync(join(ROOT, 'labs', GATEWAY, 'manifest.yaml'), 'utf8')) as { hidden?: string[] }).hidden;

const WORKSPACES: Record<string, { files: Map<string, string>; hidden?: string[] }> = {
  [GATEWAY]: { files: publishedWorkspace(GATEWAY), hidden: gatewayHidden },
  // A lab with no `hidden` at all: only the platform's own brief.md and hints.md leave the tree.
  [PLAIN]: {
    files: new Map([
      ['brief.md', '# Brief\n\nEdit `app.py`.\n'],
      ['hints.md', 'Hints arrive on a timer.\n'],
      ['app.py', 'print("hi")\n'],
      ['services/fake_provider.py', 'x = 1\n'],
    ]),
  },
};

const lab = (o: Record<string, unknown>) => ({
  version: '1.0.0',
  type: 'explore',
  family: 'gateway',
  summary: `About ${o.slug}`,
  objectives: ['see it'],
  difficulty: 'intro',
  timeout_minutes: 60,
  estimated_minutes: 15,
  tier: 'free',
  path: 'ai-platform',
  module: 1,
  has_learn: false,
  progress: null,
  ...o,
});
const LABS = [
  lab({ slug: GATEWAY, title: 'See what a gateway actually does', order: 1 }),
  lab({ slug: PLAIN, title: 'A lab that hides nothing', type: 'build', order: 2 }),
];

const json = (route: Route, body: unknown, status = 200) => {
  const origin = route.request().headers()['origin'];
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {},
    body: JSON.stringify(body),
  });
};

/** The folder `dir` ('' for /workspace) of a file map, as the API lists it. */
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

async function stub(page: Page) {
  const s = { lab: GATEWAY, listed: [] as string[], errors: [] as string[] };
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) s.errors.push(msg.text());
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/api/me') return json(route, { sub: 'console', user_id: 'console' });
    if (url.pathname === '/api/labs') return json(route, LABS);
    if (url.pathname === '/api/onboarding') return json(route, { error: { code: 'no_onboarding', message: 'none' } }, 404);
    if (url.pathname.startsWith('/api/learn/')) return json(route, { error: { code: 'no_learn', message: 'no learning content' } }, 404);
    if (url.pathname === '/api/start' && method === 'POST') {
      s.lab = JSON.parse(route.request().postData() ?? '{}').lab;
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
    const ws = WORKSPACES[s.lab]!;
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (p === base && method === 'GET') {
      const now = Date.now();
      return json(route, {
        meta: { state: 'running', lab_slug: s.lab, started_at: now, expires_at: now + 3_000_000, end_reason: null },
        services: { view: { health: 'healthy' } },
        snapshots: [],
        cost: { usd: 0 },
        hints: { total: 0, schedule: [], delivered: [] },
        manifest_summary: {
          title: s.lab,
          learner_restart: false,
          checks: [{ name: 'gateway-is-up' }],
          services: [{ name: 'view', ui: true, port: 8962, label: 'Live view' }],
          ...(ws.hidden ? { hidden: ws.hidden } : {}),
        },
        checks_history: [],
        server_time: now,
      });
    }
    if (p === `${base}/events`) return new Promise<void>(() => {}); // held open and silent
    if (p === `${base}/files` && method === 'GET') {
      const dir = (url.searchParams.get('path') ?? '/workspace').replace(/^\/workspace\/?/, '');
      s.listed.push(dir);
      return json(route, listing(ws.files, dir));
    }
    const file = p.startsWith(`${base}/files/`) ? decodeURIComponent(p.slice(`${base}/files/`.length)) : null;
    if (file !== null && method === 'GET') {
      const text = ws.files.get(file);
      return text === undefined ? json(route, { error: { code: 'not_found', message: `${file} does not exist` } }, 404) : json(route, { content: text });
    }
    if (p.startsWith(`${base}/services/`) && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'text/html', headers: { 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'access-control-allow-credentials': 'true' }, body: '<!doctype html><title>view</title><p>view</p>' });
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

/** Starts `slug` from its module's page and opens the Editor, where the tree is. */
async function session(page: Page, slug: string) {
  const s = await stub(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('opalixOnboarded', '1');
    localStorage.setItem('opalixLearn', JSON.stringify({ v: 1, onboarding: { status: 'skipped', at: 1, levels: {} } }));
  });
  await page.goto(MODULE_PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
  await pressStart(page, slug);
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#statePill')).toHaveText('running');
  await expect(page.locator('#bootModal')).toBeHidden();
  await page.locator('#workspaceTabs [role="tab"]', { hasText: 'Editor' }).click();
  await expect(page.locator('#viewEditor #fileList li:has(.name)').first()).toBeVisible();
  return s;
}

const tree = (page: Page) => page.locator('#fileList .name').allTextContents();

async function shot(page: Page, name: string) {
  if (process.env.HIDDEN_SHOTS === '0') return;
  mkdirSync(SHOTS, { recursive: true });
  await page.locator('#viewEditor .files-pane').screenshot({ path: join(SHOTS, `${name}.png`) });
}

test.describe('the file tree', () => {
  test('leaves see-what-a-gateway-does\'s services/, lib/ and brief.md out, and shows the rest', async ({ page }) => {
    const s = await session(page, GATEWAY);
    expect(gatewayHidden).toEqual(['lib/', 'services/']);
    // The API lists them; the tree does not show them.
    expect(listing(WORKSPACES[GATEWAY]!.files, '').map((e) => e.name).sort()).toEqual(['answers.json', 'brief.md', 'gateway', 'lib', 'send_calls.py', 'services']);
    await expect.poll(() => tree(page)).toEqual(['gateway', 'answers.json', 'send_calls.py']);
    await shot(page, 'see-what-a-gateway-does-tree');
    // A folder that stays is still a folder that opens.
    await page.locator('#fileList button', { hasText: 'gateway' }).click();
    await expect.poll(() => tree(page)).toEqual(['gateway', 'config.yaml', 'answers.json', 'send_calls.py']);
    await shot(page, 'see-what-a-gateway-does-tree-expanded');
    // Nothing was listed inside services/ to decide: a hidden folder is dropped by its name.
    expect(s.listed).not.toContain('services');
    expect(s.listed).not.toContain('lib');
    // The Brief tab still shows the brief the tree leaves out.
    await expect(page.locator('#briefBody')).toContainText('What you have');
    expect(s.errors).toEqual([]);
  });

  test('on a lab that hides nothing, only brief.md and hints.md leave the tree', async ({ page }) => {
    const s = await session(page, PLAIN);
    await expect.poll(() => tree(page)).toEqual(['services', 'app.py']);
    await page.locator('#fileList button', { hasText: 'services' }).click();
    await expect.poll(() => tree(page)).toEqual(['services', 'fake_provider.py', 'app.py']);
    expect(s.errors).toEqual([]);
  });
});
