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
 * The Learning tab case answers /api/admin/learning from a route stub, so it
 * checks the screen's rendering and filters whatever the deployed table holds.
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
  { id: 'learning', name: 'Learning', heading: 'Learning' },
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

  test('Learning tab: tiles, tables, filters and states, from a stubbed /api/admin/learning', async () => {
    // A fresh page in the signed-in context: the stub lives on this page only.
    const page = await signedIn.context().newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    const QUESTIONS = [
      { lab_slug: 'lab-a', question_id: 'q-hard', concept: 'gateway.routing', attempts: 10, correct: 3, percent_correct: 30 },
      { lab_slug: null, question_id: 'onboarding-q1', concept: 'basics.terminal', attempts: 2, correct: 0, percent_correct: 0 },
      { lab_slug: 'lab-b', question_id: 'q-easy', concept: 'storage.objects', attempts: 8, correct: 7, percent_correct: 87.5 },
      // Markup in a server string must be shown as text, never run.
      { lab_slug: 'lab-b', question_id: '<img src=x onerror=window.__learningXss=1>', concept: '<b>bold</b>', attempts: 6, correct: 5, percent_correct: 83.3 },
    ];
    const CONCEPTS = [
      { concept: 'basics.terminal', attempts: 2, correct: 0, percent_correct: 0 },
      { concept: 'gateway.routing', attempts: 10, correct: 3, percent_correct: 30 },
      { concept: 'storage.objects', attempts: 8, correct: 7, percent_correct: 87.5 },
    ];
    type Reply = { status?: number; body: unknown };
    let reply: Reply = { body: { available: true, questions: QUESTIONS, concepts: CONCEPTS } };
    const asked: URLSearchParams[] = []; // the query of each call (this file's `URL` is the admin's address)
    await page.route('**/api/admin/learning*', (route) => {
      asked.push(new URLSearchParams(route.request().url().split('?')[1] ?? ''));
      const lab = asked[asked.length - 1].get('lab');
      const body = lab && (reply.body as { questions?: typeof QUESTIONS }).questions
        ? { available: true, questions: QUESTIONS.filter((q) => q.lab_slug === lab), concepts: CONCEPTS }
        : reply.body;
      return route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await page.goto('/#learning');
    const panel = page.locator('#panel-learning');
    await expect(panel.getByRole('heading', { level: 2, name: 'Learning' })).toBeVisible();
    await expect(panel.locator('.state-loading')).toHaveCount(0);

    // Tiles: 20 answers in total, 4 questions, and the weakest concept with a real sample.
    const tile = (label: string) => panel.locator('.stat-tile', { hasText: label });
    await expect(tile('Total answers').locator('.tile-value')).toHaveText('20');
    await expect(tile('Distinct questions').locator('.tile-value')).toHaveText('4');
    await expect(tile('Weakest concept').locator('.tile-value')).toHaveText('gateway.routing');
    await expect(tile('Weakest concept')).toContainText('30% correct over 10 answers');

    // The note says answers are anonymous and what a low percent means.
    await expect(panel.locator('.learning-note')).toContainText('anonymous');
    await expect(panel.locator('.learning-note')).toContainText('review the lesson or the wording of this question');

    // Per-concept table: weakest first, each with a bar and its number.
    const concepts = panel.getByRole('region', { name: /by concept/i }).locator('tbody tr');
    await expect(concepts).toHaveCount(3);
    await expect(concepts.first()).toContainText('basics.terminal');
    await expect(concepts.nth(1).locator('.meter-value')).toHaveText('30%');
    await expect(concepts.nth(1).locator('.meter-fill')).toHaveCount(1);

    // Per-question table: weakest first by default, reversible, and flagged below 50%.
    const questions = panel.getByRole('region', { name: /^Questions by percent correct/ });
    const ids = () => questions.locator('tbody tr td:first-child').allTextContents();
    expect((await ids())[0]).toBe('onboarding-q1');
    expect((await ids())[1]).toBe('q-hard');
    await expect(questions.locator('tbody tr', { hasText: 'q-hard' }).getByText('review')).toBeVisible();
    await expect(questions.locator('tbody tr', { hasText: 'onboarding-q1' }).getByText('few answers')).toBeVisible();
    await expect(questions.locator('tbody tr', { hasText: 'onboarding-q1' })).toContainText('onboarding quiz');
    await expect(questions.locator('th[aria-sort]')).toHaveAttribute('aria-sort', 'ascending');
    await questions.getByRole('button', { name: /Percent correct/ }).click();
    await expect(panel.getByRole('region', { name: /^Questions by percent correct, strongest first/ }).locator('th[aria-sort]')).toHaveAttribute('aria-sort', 'descending');
    expect((await ids())[0]).toBe('q-easy');

    // Server text is text: the markup is on the page as characters and nothing ran.
    await expect(panel.getByText('<img src=x onerror=window.__learningXss=1>')).toBeVisible();
    await expect(panel.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __learningXss?: number }).__learningXss)).toBeUndefined();

    // The lab dropdown is filled from the answers and sends ?lab=; the dates send ?from= and ?to= (end date inclusive).
    await expect(panel.getByLabel('Lab')).toContainText('lab-a');
    await panel.getByLabel('Lab').selectOption('lab-a');
    await expect(panel.locator('tbody tr td:first-child', { hasText: 'q-easy' })).toHaveCount(0);
    expect(asked[asked.length - 1].get('lab')).toBe('lab-a');
    await panel.getByLabel('From (UTC)').fill('2026-09-01');
    await panel.getByLabel('To (UTC, inclusive)').fill('2026-09-30');
    await expect.poll(() => asked[asked.length - 1].get('to')).toBe(String(Date.parse('2026-10-01T00:00:00Z')));
    expect(asked[asked.length - 1].get('from')).toBe(String(Date.parse('2026-09-01T00:00:00Z')));
    expect(asked[asked.length - 1].get('lab')).toBe('lab-a');

    // A backwards range is refused on the page, without a request.
    const before = asked.length;
    await panel.getByLabel('From (UTC)').fill('2026-10-05');
    await expect(panel.getByRole('alert').filter({ hasText: 'From' })).toBeVisible();
    expect(asked.length).toBe(before);

    // Reset clears every filter and asks again without them.
    await panel.getByRole('button', { name: 'Reset' }).click();
    await expect.poll(() => asked[asked.length - 1].toString()).toBe('');

    // Empty, unavailable and error states.
    reply = { body: { available: true, questions: [], concepts: [] } };
    await panel.getByRole('button', { name: 'Refresh' }).click();
    await expect(panel.locator('.state-empty')).toContainText('No quiz answers have been recorded yet');

    reply = { body: { available: false, questions: [], concepts: [] } };
    await panel.getByRole('button', { name: 'Refresh' }).click();
    await expect(panel.locator('.state-empty')).toContainText('not in this database yet');

    reply = { status: 500, body: { error: { code: 'internal', message: 'D1 is having a bad day' } } };
    await panel.getByRole('button', { name: 'Refresh' }).click();
    await expect(panel.locator('.state-error')).toContainText('D1 is having a bad day');
    reply = { body: { available: true, questions: QUESTIONS, concepts: CONCEPTS } };
    await panel.getByRole('button', { name: 'Retry' }).click();
    await expect(panel.locator('.state-error')).toHaveCount(0);
    await expect(tile('Total answers').locator('.tile-value')).toHaveText('20');

    expect(pageErrors, 'uncaught page errors').toEqual([]);
    await page.close();
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
