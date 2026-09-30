import { test, expect, type Page, type Response } from '@playwright/test';

/**
 * The admin panel, against a real deployment (or a local harness).
 *
 *   OPALIX_ADMIN_URL=https://opalix-admin.<account>.workers.dev \
 *   OPALIX_ADMIN_PASSWORD=... npx playwright test test/e2e/admin
 *
 * Skipped when either is unset, so a plain `npm run test:e2e` against the
 * console is unaffected. Optional: OPALIX_SERVICE_KEY, the API's service key,
 * which lets the "no secret in any response" check look for that exact value
 * as well as for the names of the secrets.
 *
 * Nothing here changes platform state: it never ends a session, primes or
 * drains a pool, or promotes a version. It stops at each confirm dialog and
 * cancels. Login is limited to five attempts a minute per address, and this
 * file spends three (one wrong through the form, one wrong through the API,
 * one right); the right one is shared by every later test.
 */

const URL = process.env.OPALIX_ADMIN_URL;
const PASSWORD = process.env.OPALIX_ADMIN_PASSWORD;
const SERVICE_KEY = process.env.OPALIX_SERVICE_KEY;

test.skip(!URL || !PASSWORD, 'set OPALIX_ADMIN_URL and OPALIX_ADMIN_PASSWORD to run the admin specs');
test.describe.configure({ mode: 'serial' });
test.use({ baseURL: URL });

const COOKIE = '__Host-opx_admin';

const TABS = [
  { id: 'sessions', name: 'Sessions', heading: 'Sessions' },
  { id: 'pools', name: 'Pools', heading: 'Pools' },
  { id: 'catalogue', name: 'Catalogue', heading: 'Catalogue' },
  { id: 'usage', name: 'Usage & cost', heading: 'Usage & cost' },
  { id: 'users', name: 'Users', heading: 'Users' },
  { id: 'waitlist', name: 'Waitlist', heading: 'Waitlist' },
  { id: 'feedback', name: 'Feedback', heading: 'Feedback' },
] as const;

/** Every text response the page received, so secrets can be searched for afterwards. */
function collectBodies(page: Page) {
  const bodies: Array<{ url: string; body: string }> = [];
  const pending: Array<Promise<void>> = [];
  page.on('response', (res: Response) => {
    const type = res.headers()['content-type'] ?? '';
    if (!/text|json|javascript|css|xml/.test(type)) return;
    pending.push(
      res
        .text()
        .then((body) => void bodies.push({ url: res.url(), body }))
        .catch(() => undefined) // a redirect or aborted response has no body
    );
  });
  return { bodies, settle: () => Promise.all(pending) };
}

let signedIn: Page;

test.describe('admin panel', () => {
  test('a wrong password is a 401 and sets no cookie', async ({ page, context, request }) => {
    await page.goto('/');
    await expect(page.getByLabel('Password')).toBeVisible();
    await page.getByLabel('Password').fill('definitely-not-the-password');
    const [res] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/auth/login')), page.getByRole('button', { name: 'Sign in' }).click()]);
    expect(res.status()).toBe(401);
    await expect(page.locator('#err')).toHaveText('Wrong password.');
    expect((await context.cookies()).filter((c) => c.name.includes('opx_admin'))).toEqual([]);

    // The same through the API directly: no Set-Cookie header either.
    const direct = await request.post('/auth/login', { data: { password: 'also-wrong' } });
    expect(direct.status()).toBe(401);
    expect(direct.headers()['set-cookie']).toBeUndefined();
  });

  test('signed out: the API proxy is a 401, the page is the login form, and the headers are tight', async ({ request }) => {
    const api = await request.get('/api/pools');
    expect(api.status()).toBe(401);
    expect(await api.json()).toEqual({ error: 'not signed in' });

    const page = await request.get('/');
    const html = await page.text();
    expect(html).toContain('<script src="/login.js"');
    expect(html).not.toMatch(/<script>|\son\w+=|\sstyle=/);
    expect(html).not.toContain('<style');

    const headers = page.headers();
    const csp = headers['content-security-policy'] ?? '';
    const directive = (name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name));
    expect(directive('script-src')).toBe("script-src 'self'");
    expect(directive('style-src')).toBe("style-src 'self'");
    expect(directive('connect-src')).toBe("connect-src 'self'"); // the admin never talks to the API from the browser
    expect(directive('frame-src')).toBe("frame-src 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');

    // A GET must not be able to sign anyone out.
    expect((await request.get('/auth/logout')).status()).toBe(405);
  });

  test('the right password sets an HttpOnly __Host- cookie and opens the panel', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: URL });
    signedIn = await context.newPage();
    await signedIn.goto('/');
    await signedIn.getByLabel('Password').fill(PASSWORD!);
    await signedIn.getByRole('button', { name: 'Sign in' }).click();

    await expect(signedIn).toHaveTitle('Opalix Ops');
    await expect(signedIn.getByRole('tablist', { name: 'Sections' })).toBeVisible();
    const cookie = (await context.cookies()).find((c) => c.name === COOKIE);
    expect(cookie, `cookie ${COOKIE}`).toBeTruthy();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.secure).toBe(true);
    expect(cookie!.path).toBe('/');
    expect(cookie!.value).not.toContain(PASSWORD!);
  });

  test('every tab loads without an error state, and none is left loading', async () => {
    const failures: string[] = [];
    signedIn.on('response', (r) => {
      if (r.url().includes('/api/') && r.status() >= 400) failures.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    });
    const consoleErrors: string[] = [];
    signedIn.on('pageerror', (e) => consoleErrors.push(e.message));

    for (const tab of TABS) {
      await signedIn.getByRole('tab', { name: tab.name }).click();
      const panel = signedIn.locator(`#panel-${tab.id}`);
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('heading', { level: 2, name: tab.heading })).toBeVisible();
      await expect(signedIn.getByRole('tab', { name: tab.name })).toHaveAttribute('aria-selected', 'true');
      // Settled: no spinner, no error. What is left is a table, tiles or an honest empty state.
      await expect(panel.locator('.state-loading')).toHaveCount(0);
      await expect(panel.locator('.state-error'), `${tab.name} shows an error`).toHaveCount(0);
    }
    expect(failures, 'API calls that failed').toEqual([]);
    expect(consoleErrors, 'uncaught page errors').toEqual([]);
  });

  test('destructive buttons ask first, and Cancel does nothing', async () => {
    const posts: string[] = [];
    signedIn.on('request', (r) => {
      if (r.method() !== 'GET' && r.url().includes('/api/')) posts.push(`${r.method()} ${r.url()}`);
    });

    // Pools: Drain opens the confirm; Cancel closes it.
    await signedIn.getByRole('tab', { name: 'Pools' }).click();
    const drain = signedIn.locator('#panel-pools').getByRole('button', { name: 'Drain' }).first();
    await expect(drain).toBeVisible();
    await drain.click();
    await expect(signedIn.locator('#confirm')).toBeVisible();
    await expect(signedIn.locator('#confirmTitle')).toContainText('Drain');
    await signedIn.getByRole('button', { name: 'Cancel' }).click();
    await expect(signedIn.locator('#confirm')).toBeHidden();

    // Catalogue: a lab's versions expand, and Promote asks before doing anything.
    await signedIn.getByRole('tab', { name: 'Catalogue' }).click();
    const versions = signedIn.locator('#panel-catalogue').getByRole('button', { name: 'Versions' }).first();
    await expect(versions).toBeVisible();
    await versions.click();
    await expect(signedIn.locator('#panel-catalogue .versions').first()).toBeVisible();
    const promote = signedIn.locator('#panel-catalogue').getByRole('button', { name: 'Promote' }).first();
    if (await promote.count()) {
      await promote.click();
      await expect(signedIn.locator('#confirm')).toBeVisible();
      await signedIn.getByRole('button', { name: 'Cancel' }).click();
      await expect(signedIn.locator('#confirm')).toBeHidden();
    }

    // Sessions: End, when anything is live, asks too.
    await signedIn.getByRole('tab', { name: 'Sessions' }).click();
    const end = signedIn.locator('#panel-sessions').getByRole('button', { name: 'End' }).first();
    if (await end.count()) {
      await end.click();
      await expect(signedIn.locator('#confirm')).toBeVisible();
      await signedIn.getByRole('button', { name: 'Cancel' }).click();
      await expect(signedIn.locator('#confirm')).toBeHidden();
    }

    expect(posts, 'nothing was sent').toEqual([]);
  });

  test('neither the password nor the service key appears in any page source or response body', async ({ browser }) => {
    // A fresh page in the signed-in context, so every asset and API response is captured from the start.
    const context = signedIn.context();
    const page = await context.newPage();
    const seen = collectBodies(page);
    await page.goto('/');
    for (const tab of TABS) {
      await page.getByRole('tab', { name: tab.name }).click();
      await expect(page.locator(`#panel-${tab.id} .state-loading`)).toHaveCount(0);
    }
    await seen.settle();
    const source = await page.content();

    const secrets = [PASSWORD!, ...(SERVICE_KEY ? [SERVICE_KEY] : [])];
    const names = ['SANDBOX_API_KEY', 'ADMIN_COOKIE_SECRET', 'ADMIN_PASSWORD', 'Bearer '];
    for (const { url, body } of [...seen.bodies, { url: 'page source', body: source }]) {
      for (const s of secrets) expect(body.includes(s), `a secret value is in ${url}`).toBe(false);
      for (const n of names) expect(body.includes(n), `"${n}" is in ${url}`).toBe(false);
    }
    // The bundle really was among what was searched.
    expect(seen.bodies.some((b) => b.url.endsWith('/dist/app.js'))).toBe(true);
    expect(seen.bodies.some((b) => b.url.includes('/api/'))).toBe(true);

    // The cookie is not readable from script.
    expect(await page.evaluate(() => document.cookie)).toBe('');
    await page.close();
    void browser;
  });

  test('sign out ends the session: POST /auth/logout, then the API is a 401 again', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: URL, storageState: await signedIn.context().storageState() });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('tablist', { name: 'Sections' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByLabel('Password')).toBeVisible();
    expect((await context.cookies()).some((c) => c.name === COOKIE && c.value !== '')).toBe(false);
    expect((await context.request.get('/api/pools')).status()).toBe(401);
    await context.close();
  });
});
