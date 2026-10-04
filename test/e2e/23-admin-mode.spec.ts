import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { serveConsole } from './console-server';
import { MODULE_PAGE, pressStart } from './browse';

/**
 * Admin mode: the owner's developer view of the console.
 *
 * What is pinned here:
 *   - the switch exists only when GET /api/me says `can_admin: true`: not for false, not when the field is
 *     absent, and a stored "on" is then ignored and cleared;
 *   - the switch is a labelled role=switch, works from the keyboard, says On or Off in words, and is a 44px
 *     target on a phone; turning it on shows the "Admin mode on" pill and the "Admin panel" link, and the choice
 *     survives a reload;
 *   - a lab or a path step a learner could not start is startable, still says it is locked, and starts the lab;
 *   - "Admin: skip to Start" on the screens before a lab;
 *   - the Admin strip on the session screen: ids to copy, the live event log, and never the session token;
 *   - 390px and both themes;
 *   - a learner (and an admin who switched it off) sees exactly the screens a learner always saw.
 *
 * Like 16 to 22 this needs no password, no API and no container: a static server serves dashboard/public and
 * every call the console makes is answered by a route stub. Run `npm run build:dashboard` first.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC = join(ROOT, 'dashboard/public');
const API = 'https://opalix-sandbox.soubenz94.workers.dev';
const SESSION_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const TOKEN = 'test-token';
const ADMIN_URL = 'https://opalix-admin.soubenz94.workers.dev';
const LOCK_NOTE = 'Locked for learners \u2014 open anyway (admin)';

// --------------------------------------------------------------- the content

const lab = (o: Record<string, unknown>) => ({
  version: '1.0.0',
  type: 'build',
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
const OPEN = 'one-endpoint-one-key';
const LEARN = 'see-what-a-gateway-does';
const LOCKED = 'add-a-model-without-touching-app-code';
const PLAN_LOCKED = 'a-pro-only-lab';
const LABS = [
  lab({ slug: LEARN, title: 'See what a gateway does', order: 1, has_learn: true }),
  // Locked by a prerequisite: LEARN has not been passed.
  lab({ slug: LOCKED, title: 'Add a model without touching app code', order: 2, prerequisites: [LEARN] }),
  lab({ slug: OPEN, title: 'One endpoint, one key', order: 3 }),
  lab({ slug: PLAN_LOCKED, title: 'A pro only lab', order: 4, tier: 'pro' }),
];

const LEARN_BUNDLE = { version: 1, story: { title: 'The case', minutes: 1, body: 'A short story about a gateway.' }, concepts: [], questions: [], answers_file: 'answers.json', fields: [] };

const step = (slug: string, title: string, status: string) => ({
  slug,
  title,
  area: 'gateway',
  why: status === 'locked' ? 'Included with the Pro plan.' : `Why ${title}.`,
  estimated_minutes: 30,
  status,
  ...(status === 'locked' ? { lock: 'plan' } : {}),
});
const PATH = {
  steps: [step(OPEN, 'One endpoint, one key', 'next'), step(LOCKED, 'Add a model without touching app code', 'upcoming'), step(PLAN_LOCKED, 'A pro only lab', 'locked')],
  total_minutes: 90,
  weeks_estimate: 1,
  goal: { text: 'Run our gateway', kind: 'role-ready' },
  source: 'ai',
  generated_at: 1767700000000,
};

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
  /** What GET /api/me answers. */
  me: Record<string, unknown>;
  starts: string[];
  /** The text of the stream: the first connection to the session's events gets it, later ones are held open. */
  events: string;
  errors: string[];
}

const event = (id: number, name: string, data: unknown) => `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

async function stub(page: Page, init: Partial<Stub> = {}): Promise<Stub> {
  const s: Stub = { me: { sub: 'console', user_id: 'console', can_admin: true, admin_url: ADMIN_URL }, starts: [], events: '', errors: [], ...init };
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) s.errors.push(msg.text());
  });
  let eventsServed = 0;

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === '/api/me') return json(route, s.me);
    if (path === '/api/sessions/active') return json(route, { sessions: [] });
    if (path === '/api/labs') return json(route, LABS);
    if (path === '/api/onboarding') return json(route, { error: { code: 'no_onboarding', message: 'none' } }, 404);
    if (path === `/api/learn/${LEARN}`) return json(route, { version: '1.0.0', slug: LEARN, learn: LEARN_BUNDLE });
    if (path.startsWith('/api/learn/')) return json(route, { error: { code: 'no_learn', message: 'none' } }, 404);
    if (path === '/api/prepare' || path === '/api/prepare/cancel') return json(route, { ok: true }, 202);
    if (path === '/api/profile') return json(route, { error: 'nope' }, 404);
    if (path === '/api/path' && method === 'GET') return json(route, PATH);
    if (path === '/api/start' && method === 'POST') {
      const { lab: slug } = JSON.parse(route.request().postData() ?? '{}');
      s.starts.push(slug);
      return json(route, { id: SESSION_ID, state: 'starting', token: TOKEN, urls: { services: { echo: {} } } }, 202);
    }
    return json(route, { error: 'not stubbed' }, 404);
  });

  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const method = req.method();
    const base = `/sessions/${SESSION_ID}`;
    const cors = { 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'access-control-allow-credentials': 'true' };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (p === base && method === 'GET') {
      const now = Date.now();
      return json(route, {
        meta: { state: 'running', lab_slug: OPEN, started_at: now, expires_at: now + 3_000_000, end_reason: null },
        services: { echo: { health: 'healthy' } },
        snapshots: [],
        cost: { usd: 0.03 },
        hints: { total: 3, schedule: [0, 12, 30], delivered: [] },
        manifest_summary: { title: 'A lab', checks: [{ name: 'support answered by a' }] },
        checks: { run_id: 'run-1', started_at: now - 500, finished_at: now, results: [{ name: 'support answered by a', pass: true, weight: 1 }] },
        checks_history: [],
        server_time: now,
      });
    }
    if (p === `${base}/events`) {
      eventsServed++;
      if (eventsServed === 1 && s.events) return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', ...cors, 'cache-control': 'no-store' }, body: s.events });
      await new Promise<void>(() => {});
    }
    if (p === `${base}/files` && method === 'GET') return json(route, [{ name: 'brief.md', size: 30, isDirectory: false }]);
    if (p === `${base}/files/brief.md` && method === 'GET') return json(route, { content: '# The brief\n' });
    if (p === `${base}/services/echo/session` && method === 'POST') return route.fulfill({ status: 204, headers: cors });
    if (p.startsWith(`${base}/services/echo/`)) return route.fulfill({ status: 200, contentType: 'text/html', headers: cors, body: '<!doctype html><h1>Echo</h1>' });
    if (p.startsWith(base) && method !== 'GET') return json(route, {}, 200);
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

// -------------------------------------------------------------------- helpers

const SKIPPED = { v: 1, onboarding: { status: 'skipped', at: 1, levels: {} } };
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const FLAG = 'opalixAdminMode';

/** Opens the console on an address. `stored` seeds the admin flag (once per tab: a reload keeps what the page wrote); `theme` the saved theme. */
async function visit(page: Page, path: string, { stored, theme }: { stored?: boolean; theme?: 'light' | 'dark' } = {}) {
  await page.addInitScript(
    ([m, on, t]) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('opalixOnboarded', '1');
        localStorage.setItem('opalixLearn', m as string);
        if (on) localStorage.setItem('opalixAdminMode', '1');
        if (t) localStorage.setItem('opalixTheme', t as string);
        sessionStorage.setItem('seeded', '1');
      }
    },
    [JSON.stringify(SKIPPED), stored ?? false, theme ?? null] as const
  );
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
}

const flag = (page: Page) => page.evaluate((k) => localStorage.getItem(k), FLAG);
const adminSwitch = (page: Page) => page.getByRole('switch', { name: 'Admin' });
const pill = (page: Page) => page.locator('#adminPill');
const panelLink = (page: Page) => page.getByRole('link', { name: 'Admin panel' });
const row = (page: Page, slug: string) => page.locator(`.lab[data-slug="${slug}"]`);

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

/** Every word on the screens of a learner is a learner's: none of the platform's, none of admin mode's. */
const PLATFORM_WORDS = /\b(containers?|snapshots?|sandbox(es|ed)?|workers?|durable objects?|cloudflare|session tokens?|upstream|websockets?|API|slots?|service keys?|docker|firecracker|wrangler|D1|R2|VMs?)\b|HTTP\s*[1-5]\d\d|\b[45]\d\d: /i;
const ADMIN_WORDS = /\badmin\b|open anyway|locked for learners|skip to start|live events/i;
async function visibleCopy(page: Page, scope: string): Promise<string> {
  return page.locator(scope).evaluate((el) => {
    const attrs = [...el.querySelectorAll('[aria-label], [title], [aria-valuetext]')].map((e) => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('aria-valuetext')].filter(Boolean).join(' '));
    return `${(el as HTMLElement).innerText}\n${attrs.join('\n')}`;
  });
}
const expectLearnerCopy = async (page: Page, scope: string, screen: string) => {
  const text = await visibleCopy(page, scope);
  expect(text.match(PLATFORM_WORDS)?.[0] ?? null, `${screen}: a platform word`).toBeNull();
  expect(text.match(ADMIN_WORDS)?.[0] ?? null, `${screen}: an admin word`).toBeNull();
};

// =========================================================================
// who sees the switch
// =========================================================================

test.describe('who is shown the switch', () => {
  test('not when /api/me says can_admin is false, even with the flag stored on: it is ignored and cleared', async ({ page }) => {
    const s = await stub(page, { me: { sub: 'ada@example.com', user_id: 'u-0123456789abcdef01234567', can_admin: false } });
    await page.setViewportSize(WIDE);
    await visit(page, '/', { stored: true });

    await expect(page.locator('#identityName')).toHaveText('ada@example.com');
    await expect(page.locator('#adminSwitch')).toHaveCount(0);
    await expect(page.getByRole('switch')).toHaveCount(0);
    await expect(pill(page)).toHaveCount(0);
    await expect(panelLink(page)).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveAttribute('data-admin-mode', 'on');
    expect(await flag(page)).toBeNull();
    // And nothing of it survives a reload either.
    await page.reload();
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('#adminSwitch')).toHaveCount(0);
    expect(await flag(page)).toBeNull();
    expect(s.errors).toEqual([]);
  });

  test('not when /api/me does not say at all (an older Worker), and the stored flag is cleared', async ({ page }) => {
    await stub(page, { me: { sub: 'console', user_id: 'console' } });
    await page.setViewportSize(WIDE);
    await visit(page, MODULE_PAGE, { stored: true });
    await expect(page.locator('#adminSwitch')).toHaveCount(0);
    expect(await flag(page)).toBeNull();
    // Locks stay locks.
    await expect(row(page, LOCKED).locator('.lab-start')).toHaveAttribute('aria-disabled', 'true');
    await expect(row(page, LOCKED)).not.toContainText('open anyway');
  });

  test('a stored flag cannot switch it on without the Worker saying so (can_admin must be exactly true)', async ({ page }) => {
    await stub(page, { me: { sub: 'console', user_id: 'console', can_admin: 'true' } });
    await page.setViewportSize(WIDE);
    await visit(page, '/', { stored: true });
    await expect(page.locator('#adminSwitch')).toHaveCount(0);
    expect(await flag(page)).toBeNull();
  });

  test('shown when can_admin is true: off by default, a labelled switch beside the theme toggle', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/');

    const sw = adminSwitch(page);
    await expect(sw).toBeVisible();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(sw).toContainText('Admin');
    await expect(sw.locator('.admin-track-word')).toHaveText('Off');
    // Next to the theme toggle, in the account area.
    const order = await page.evaluate(() => {
      const account = document.getElementById('navAccount')!;
      const kids = [...account.children].map((c) => c.id);
      return { admin: kids.indexOf('adminSwitch'), theme: kids.indexOf('btnTheme') };
    });
    expect(order.admin).toBeGreaterThanOrEqual(0);
    expect(order.admin).toBe(order.theme - 1);
    // Off is a view like any other: no pill, no link, no ring.
    await expect(pill(page)).toHaveCount(0);
    await expect(panelLink(page)).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveAttribute('data-admin-mode', 'on');
    expect(await flag(page)).toBeNull();
    expect(s.errors).toEqual([]);
  });
});

// =========================================================================
// the switch itself
// =========================================================================

test.describe('the switch', () => {
  test('turns on and off, shows the pill and the Admin panel link, and the choice survives a reload', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/');
    const sw = adminSwitch(page);

    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(sw.locator('.admin-track-word')).toHaveText('On');
    await expect(pill(page)).toBeVisible();
    await expect(pill(page)).toHaveText('Admin mode on');
    await expect(page.locator('html')).toHaveAttribute('data-admin-mode', 'on');
    expect(await flag(page)).toBe('1');
    // The link opens the admin Worker in a new tab, and cannot reach back.
    const link = panelLink(page);
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', ADMIN_URL);
    await expect(link).toHaveAttribute('target', '_blank');
    expect(await link.getAttribute('rel')).toMatch(/noopener/);

    await page.reload();
    await page.waitForSelector('body[data-booted="1"]');
    await expect(adminSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect(pill(page)).toHaveText('Admin mode on');
    await expect(panelLink(page)).toBeVisible();

    await adminSwitch(page).click();
    await expect(adminSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await expect(pill(page)).toHaveCount(0);
    await expect(panelLink(page)).toHaveCount(0);
    expect(await flag(page)).toBeNull();
    await page.reload();
    await page.waitForSelector('body[data-booted="1"]');
    await expect(adminSwitch(page)).toHaveAttribute('aria-checked', 'false');
    expect(s.errors).toEqual([]);
  });

  test('the link only ever goes where the Worker said, and an address that is not https is not followed', async ({ page }) => {
    await stub(page, { me: { sub: 'console', user_id: 'console', can_admin: true, admin_url: 'javascript:alert(1)' } });
    await page.setViewportSize(WIDE);
    await visit(page, '/', { stored: true });
    await expect(panelLink(page)).toHaveAttribute('href', ADMIN_URL);
  });

  test('works from the keyboard: Tab reaches it, Space and Enter flip it, focus stays on it', async ({ page }) => {
    await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/');
    const sw = adminSwitch(page);
    await sw.focus();
    await expect(sw).toBeFocused();
    await page.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(sw).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(sw).toBeFocused();
    // It is a tab stop in the header, before the theme toggle.
    await page.locator('#btnHelp').focus();
    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await sw.evaluate((el) => el === document.activeElement);
    }
    expect(reached).toBe(true);
    await page.keyboard.press('Tab');
    await expect(page.locator('#btnTheme')).toBeFocused();
  });

  test('on a phone: behind the menu, a 44px target, nothing sticks out, and the pill is in the bar', async ({ page }) => {
    await stub(page);
    await page.setViewportSize(PHONE);
    await visit(page, '/');
    // The account controls are inside the menu on a phone, as the theme toggle is.
    await expect(adminSwitch(page)).toBeHidden();
    await page.locator('#btnMenu').click();
    const sw = adminSwitch(page);
    await expect(sw).toBeVisible();
    const box = (await sw.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    const link = panelLink(page);
    await expect(link).toBeVisible();
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await noHorizontalScroll(page);
    // Close the menu: the pill stays, so it cannot be forgotten.
    await page.locator('#btnMenu').click();
    await expect(pill(page)).toBeVisible();
    await expect(pill(page)).toHaveText('Admin mode on');
    await noHorizontalScroll(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} theme: the switch, the pill and the link are drawn, say it in words, and the pill is not told by colour alone`, async ({ page }) => {
      await stub(page);
      await page.setViewportSize(WIDE);
      await visit(page, '/', { theme, stored: true });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(pill(page)).toBeVisible();
      await expect(adminSwitch(page)).toHaveAttribute('aria-checked', 'true');
      // Shape and words, not colour: a dashed ring, an icon and text.
      const look = await pill(page).evaluate((el) => {
        const cs = getComputedStyle(el);
        return { style: cs.borderTopStyle, width: parseFloat(cs.borderTopWidth), svg: Boolean(el.querySelector('svg')), text: el.textContent };
      });
      expect(look).toEqual({ style: 'dashed', width: 2, svg: true, text: 'Admin mode on' });
      const ring = await page.evaluate(() => {
        const cs = getComputedStyle(document.body, '::after');
        return { style: cs.borderTopStyle, events: cs.pointerEvents };
      });
      expect(ring).toEqual({ style: 'dashed', events: 'none' });
      await expect(panelLink(page)).toBeVisible();
      await noHorizontalScroll(page);
      // The ring never takes a click: the labs are still reachable.
      await page.goto(MODULE_PAGE);
      await page.waitForSelector('body[data-booted="1"]');
      await row(page, OPEN).locator('.lab-start').click();
      await expect(page.locator('#workspace')).toBeVisible();
    });
  }
});

// =========================================================================
// locks are opened in the view
// =========================================================================

test.describe('locks', () => {
  test('a learner: the locked lab is locked, and says why', async ({ page }) => {
    await stub(page, { me: { sub: 'console', user_id: 'console', can_admin: false } });
    await page.setViewportSize(WIDE);
    await visit(page, MODULE_PAGE);
    const locked = row(page, LOCKED);
    await expect(locked).toHaveClass(/lab-locked/);
    await expect(locked.locator('.lab-start')).toHaveText('Locked');
    await expect(locked.locator('.lab-start')).toHaveAttribute('aria-disabled', 'true');
    await expect(locked.locator('.lab-lock')).toContainText('Locked until See what a gateway does passes');
  });

  test('admin on: a lab locked by a prerequisite is startable on its row, still shows the lock, and starts', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, MODULE_PAGE);
    const locked = row(page, LOCKED);
    await expect(locked.locator('.lab-start')).toHaveText('Locked');

    await adminSwitch(page).click();
    // The lock is still there, in words, and says it is for learners.
    await expect(locked).toHaveClass(/lab-locked/);
    await expect(locked.locator('.lab-lock')).toHaveText(LOCK_NOTE);
    const start = locked.locator('.lab-start');
    await expect(start).toHaveText('Start');
    await expect(start).not.toHaveAttribute('aria-disabled', 'true');
    await expect(start).toHaveAttribute('title', new RegExp(LOCK_NOTE.replace(/[()]/g, '\\$&')));
    // An open lab is as it was.
    await expect(row(page, OPEN).locator('.lab-start')).toHaveText('Start');
    await expect(row(page, OPEN).locator('.admin-lock')).toHaveCount(0);

    await start.click();
    await expect(page.locator('#workspace')).toBeVisible();
    expect(s.starts).toEqual([LOCKED]);
    expect(s.errors).toEqual([]);
  });

  test('admin on: the lab\'s own page opens too, with the lock line and no learner note', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, `/labs/${LOCKED}`);
    const own = page.locator(`.lab-detail[data-slug="${LOCKED}"]`);
    await expect(own.locator('.lab-start')).toHaveText('Locked');
    await expect(own.locator('.lab-detail-note')).toContainText('Pass every check of See what a gateway does first');

    await adminSwitch(page).click();
    await expect(own.locator('.lab-lock')).toHaveText(LOCK_NOTE);
    await expect(own.locator('.lab-detail-note')).not.toContainText('Pass every check');
    await expect(own.locator('.lab-start')).toHaveText('Start');
    await own.locator('.lab-start').click();
    await expect(page.locator('#workspace')).toBeVisible();
    expect(s.starts).toEqual([LOCKED]);
  });

  test('admin on: the address of a locked lab\'s session starts it instead of bouncing to its page', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, `/labs/${LOCKED}/session`, { stored: true });
    await expect(page.locator('#workspace')).toBeVisible();
    expect(s.starts).toEqual([LOCKED]);
  });

  test('a learner who opens that address is sent to the lab\'s page and nothing starts', async ({ page }) => {
    const s = await stub(page, { me: { sub: 'console', user_id: 'console', can_admin: false } });
    await page.setViewportSize(WIDE);
    await visit(page, `/labs/${LOCKED}/session`, { stored: true });
    await expect(page.locator('.lab-detail-title')).toBeVisible();
    await expect(page.locator('#workspace')).toBeHidden();
    expect(s.starts).toEqual([]);
  });

  test('admin on: a path step locked by the plan is startable, says it is locked for learners, and starts', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/paths/mine');
    const locked = page.locator(`.path-step[data-slug="${PLAN_LOCKED}"]`);
    await expect(locked.locator('.step-lock')).toHaveText('Part of the paid plan');
    // A plan lock offers the way to the plans page (an Unlock link), not a start.
    await expect(locked.locator('.unlock-link')).toBeVisible();
    await expect(locked.locator('.lab-start')).toHaveCount(0);

    await adminSwitch(page).click();
    await expect(locked).toHaveAttribute('data-status', 'locked');
    await expect(locked.locator('.step-lock')).toHaveText(LOCK_NOTE);
    const start = locked.locator('.lab-start');
    await expect(start).toHaveText('Start');
    await expect(start).not.toHaveAttribute('aria-disabled', 'true');
    // Turning it off puts the lock back.
    await adminSwitch(page).click();
    await expect(locked.locator('.step-lock')).toHaveText('Part of the paid plan');
    await expect(locked.locator('.unlock-link')).toBeVisible();
    await expect(locked.locator('.lab-start')).toHaveCount(0);

    await adminSwitch(page).click();
    await locked.locator('.lab-start').click();
    await expect(page.locator('#workspace')).toBeVisible();
    expect(s.starts).toEqual([PLAN_LOCKED]);
    expect(s.errors).toEqual([]);
  });
});

// =========================================================================
// "Admin: skip to Start"
// =========================================================================

test.describe('the screens before a lab', () => {
  test('admin on: "Admin: skip to Start" is there and goes straight to starting the lab', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, MODULE_PAGE, { stored: true });
    await pressStart(page, LEARN);
    await expect(page.locator('#learnHost [data-learn-heading]')).toBeVisible();

    const skip = page.getByRole('button', { name: 'Admin: skip to Start' });
    await expect(skip).toBeVisible();
    // It sits beside Skip all.
    await expect(page.getByRole('button', { name: 'Skip all, just start the lab' })).toBeVisible();
    await skip.click();
    await expect(page.locator('#workspace')).toBeVisible();
    expect(s.starts).toEqual([LEARN]);
    expect(s.errors).toEqual([]);
  });

  test('turning it on while a step is on screen adds it; turning it off takes it away', async ({ page }) => {
    await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, MODULE_PAGE);
    await pressStart(page, LEARN);
    await expect(page.locator('#learnHost [data-learn-heading]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Admin: skip to Start' })).toHaveCount(0);
    await adminSwitch(page).click();
    await expect(page.getByRole('button', { name: 'Admin: skip to Start' })).toBeVisible();
    await adminSwitch(page).click();
    await expect(page.getByRole('button', { name: 'Admin: skip to Start' })).toHaveCount(0);
  });

  test('a learner has no such button', async ({ page }) => {
    await stub(page, { me: { sub: 'console', user_id: 'console', can_admin: false } });
    await page.setViewportSize(WIDE);
    await visit(page, MODULE_PAGE, { stored: true });
    await pressStart(page, LEARN);
    await expect(page.locator('#learnHost [data-learn-heading]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Skip all, just start the lab' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Admin/ })).toHaveCount(0);
    await expectLearnerCopy(page, '#learnScreen', 'the story step');
  });
});

// =========================================================================
// the Admin strip on the session screen
// =========================================================================

test.describe('the Admin strip', () => {
  const events = [
    event(1, 'session.state', { state: 'running' }),
    event(2, 'check.result', { name: 'support answered by a', pass: true }),
    // A stream that carried the session token must not put it on the page.
    event(3, 'alert', { message: `retry with ${TOKEN}`, token: TOKEN, url: `${API}/sessions/${SESSION_ID}/events?token=${TOKEN}&n=3` }),
  ].join('');

  async function openSession(page: Page, { stored = true } = {}) {
    const s = await stub(page, { events });
    await page.setViewportSize(WIDE);
    await visit(page, MODULE_PAGE, { stored });
    await row(page, OPEN).locator('.lab-start').click();
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#statePill')).toHaveText('running');
    return s;
  }

  test('sits under the dock, collapsible, and shows the ids, the lab and version, the state and when it ends', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const s = await openSession(page);
    const strip = page.locator('#adminStrip');
    await expect(strip).toBeVisible();
    // Under the dock.
    const placed = await page.evaluate(() => {
      const dock = document.getElementById('dock')!.getBoundingClientRect();
      const strip = document.getElementById('adminStrip')!.getBoundingClientRect();
      return strip.top >= dock.bottom - 1;
    });
    expect(placed).toBe(true);

    const summary = strip.locator('summary');
    await expect(summary).toHaveText('Admin');
    // Collapsible: closed until opened, and opens from the keyboard.
    if (!(await strip.evaluate((el) => (el as HTMLDetailsElement).open))) await summary.click();
    await expect(strip).toHaveJSProperty('open', true);
    await summary.click();
    await expect(strip).toHaveJSProperty('open', false);
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(strip).toHaveJSProperty('open', true);

    const rows = strip.locator('.admin-row');
    await expect(rows).toHaveCount(5);
    await expect(rows.locator('dt')).toHaveText(['Session id', 'User id', 'Lab and version', 'State', 'Expires at']);
    await expect(rows.nth(0).locator('code')).toHaveText(SESSION_ID);
    await expect(rows.nth(1).locator('code')).toHaveText('console');
    await expect(rows.nth(2).locator('code')).toHaveText(`${OPEN}@1.0.0`);
    await expect(rows.nth(3).locator('code')).toHaveText('running');
    await expect(rows.nth(4).locator('code')).toHaveText(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

    // A copy button for each; it copies exactly what the row shows.
    await expect(strip.getByRole('button', { name: /^Copy / })).toHaveCount(5);
    await strip.getByRole('button', { name: 'Copy session id' }).click();
    await expect(strip.getByRole('button', { name: 'Copy session id' })).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SESSION_ID);
    await strip.getByRole('button', { name: 'Copy lab and version' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${OPEN}@1.0.0`);
    await strip.getByRole('button', { name: 'Copy user id' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('console');
    expect(s.errors).toEqual([]);
  });

  test('has the live events in a scrollable log, with the session token scrubbed out of them', async ({ page }) => {
    const s = await openSession(page);
    const strip = page.locator('#adminStrip');
    if (!(await strip.evaluate((el) => (el as HTMLDetailsElement).open))) await strip.locator('summary').click();
    const log = strip.getByRole('log', { name: 'Live events' });
    await expect(log).toBeVisible();
    await expect(log.locator('.admin-event-type')).toHaveText(['session.state', 'check.result', 'alert']);
    await expect(log.locator('.admin-event').nth(1)).toContainText('"pass":true');
    await expect(log.locator('.admin-event').nth(2)).toContainText('[hidden]');
    // Scrollable by keyboard.
    await expect(log).toHaveAttribute('tabindex', '0');
    const overflow = await log.evaluate((el) => getComputedStyle(el).overflowY);
    expect(overflow).toBe('auto');
    expect(s.errors).toEqual([]);
  });

  test('never shows or copies the session token: not in the text, the markup, the labels, or the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openSession(page);
    const strip = page.locator('#adminStrip');
    if (!(await strip.evaluate((el) => (el as HTMLDetailsElement).open))) await strip.locator('summary').click();
    await expect(strip.locator('.admin-event')).toHaveCount(3);
    await expect(strip.locator('.admin-note')).toHaveText('The session token is never shown or copied here.');

    const everything = await page.evaluate(() => ({
      text: document.body.innerText,
      html: document.documentElement.outerHTML,
    }));
    expect(everything.text).not.toContain('test-token');
    expect(everything.html).not.toContain('test-token');
    // Press every copy button: none of them puts the token on the clipboard.
    const buttons = strip.getByRole('button', { name: /^Copy / });
    for (let i = 0; i < (await buttons.count()); i++) {
      await buttons.nth(i).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain('test-token');
    }
    // The strip's own markup, attributes included, holds nothing like it either.
    const own = await strip.evaluate((el) => el.outerHTML);
    expect(own).not.toMatch(/test-token|bearer|authorization/i);
  });

  test('is not there when admin mode is off, and goes when it is switched off', async ({ page }) => {
    await openSession(page, { stored: false });
    await expect(page.locator('#adminStrip')).toHaveCount(0);
    await expect(adminSwitch(page)).toBeVisible();
    await adminSwitch(page).click();
    await expect(page.locator('#adminStrip')).toBeVisible();
    await expect(pill(page)).toBeVisible();
    await adminSwitch(page).click();
    await expect(page.locator('#adminStrip')).toHaveCount(0);
  });

  test('is not there for a learner, and no admin words are on the session screen', async ({ page }) => {
    await stub(page, { me: { sub: 'console', user_id: 'console', can_admin: false }, events });
    await page.setViewportSize(WIDE);
    await visit(page, MODULE_PAGE, { stored: true });
    await row(page, OPEN).locator('.lab-start').click();
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#statePill')).toHaveText('running');
    await expect(page.locator('#adminStrip')).toHaveCount(0);
    await expect(page.locator('#adminSwitch')).toHaveCount(0);
    await expectLearnerCopy(page, 'body', 'the session screen');
  });

  test('keeps the session bar usable at 1440 and the switch and pill in it', async ({ page }) => {
    await openSession(page);
    await expect(adminSwitch(page)).toBeVisible();
    await expect(pill(page)).toBeVisible();
    await expect(panelLink(page)).toBeVisible();
    await noHorizontalScroll(page);
  });
});

// =========================================================================
// what a learner sees does not change
// =========================================================================

test.describe('a normal learner\'s screens are unchanged', () => {
  const SCREENS: Array<[string, string, string]> = [
    ['Home', '/', '#launcher'],
    ['a path', '/paths/ai-platform', '#launcher'],
    ['a module', MODULE_PAGE, '#launcher'],
    ['a lab with a lock', `/labs/${LOCKED}`, '#launcher'],
    ['a path of their own', '/paths/mine', '#launcher'],
  ];

  /** The header and the page, as a person reads them. */
  const read = async (page: Page, scope: string) => `${await visibleCopy(page, '#nav')}\n=====\n${await visibleCopy(page, scope)}`;

  test('with can_admin false (and the flag stored) every screen reads exactly as it does with no admin support at all', async ({ browser, baseURL }) => {
    for (const [name, path, scope] of SCREENS) {
      const plain = await (await browser.newContext({ baseURL })).newPage();
      await stub(plain, { me: { sub: 'console', user_id: 'console' } });
      await plain.setViewportSize(WIDE);
      await visit(plain, path);
      const before = await read(plain, scope);

      const flagged = await (await browser.newContext({ baseURL })).newPage();
      await stub(flagged, { me: { sub: 'console', user_id: 'console', can_admin: false } });
      await flagged.setViewportSize(WIDE);
      await visit(flagged, path, { stored: true });
      expect(await read(flagged, scope), name).toBe(before);

      // And the words are a learner's.
      await expectLearnerCopy(flagged, scope, name);
      await expectLearnerCopy(flagged, '#nav', `${name}: the header`);
      await plain.context().close();
      await flagged.context().close();
    }
  });

  test('an admin who switched it off reads exactly what a learner reads, and the locks are locks again', async ({ page }) => {
    await stub(page);
    await page.setViewportSize(WIDE);
    for (const [name, path, scope] of SCREENS) {
      await visit(page, path, { stored: false });
      await adminSwitch(page).click();
      await adminSwitch(page).click();
      await expect(adminSwitch(page)).toHaveAttribute('aria-checked', 'false');
      const text = await visibleCopy(page, scope);
      expect(text.match(ADMIN_WORDS)?.[0] ?? null, name).toBeNull();
      await expectLearnerCopy(page, scope, name);
      // Reloading starts the next screen clean.
      await page.evaluate(() => sessionStorage.clear());
    }
    await visit(page, MODULE_PAGE);
    await expect(row(page, LOCKED).locator('.lab-start')).toHaveText('Locked');
    await expect(row(page, LOCKED).locator('.lab-start')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('.admin-lock, .admin-open, .admin-skip, .admin-strip, .admin-pill')).toHaveCount(0);
  });

  test('a learner\'s locked path step is still "Part of the paid plan", with an Unlock link and no start', async ({ page }) => {
    await stub(page, { me: { sub: 'console', user_id: 'console', can_admin: false } });
    await page.setViewportSize(WIDE);
    await visit(page, '/paths/mine', { stored: true });
    const locked = page.locator(`.path-step[data-slug="${PLAN_LOCKED}"]`);
    await expect(locked.locator('.step-lock')).toHaveText('Part of the paid plan');
    await expect(locked.locator('.unlock-link')).toBeVisible();
    await expect(locked.locator('.lab-start')).toHaveCount(0);
    await expect(locked.locator('.admin-open')).toHaveCount(0);
  });
});
