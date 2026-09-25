import { test, expect, openConsole, signIn, API, LAB } from './fixtures';

test.describe('lab launcher', () => {
  test('lists published labs once signed in', async ({ page }) => {
    await openConsole(page);
    const labs = page.locator('.lab');
    await expect(labs.first()).toBeVisible({ timeout: 30_000 });
    expect(await labs.count()).toBeGreaterThan(0);
  });

  test('shows nothing at all without signing in', async ({ browser }) => {
    // This test used to assert the opposite: the catalogue was readable
    // with no credential, because the console had no server side and the
    // API left the route open so it could work. That is the hole this
    // replaced, so the assertion inverts with it.
    const fresh = await browser.newContext();
    try {
      const page = await fresh.newPage();
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('input[type="password"]')).toBeVisible();
      await expect(page.locator('.lab')).toHaveCount(0);

      // And the data behind it is refused, not merely unrendered.
      const res = await fresh.request.get('/api/labs');
      expect(res.status()).toBe(401);
    } finally {
      await fresh.close();
    }
  });

  test('refuses a wrong password', async ({ browser }) => {
    const fresh = await browser.newContext();
    try {
      const res = await fresh.request.post('/auth/login', { data: { password: 'not-the-password' } });
      expect(res.status()).toBe(401);
      const after = await fresh.request.get('/api/labs');
      expect(after.status()).toBe(401);
    } finally {
      await fresh.close();
    }
  });

  test('shows each lab with its slug, version and family', async ({ page }) => {
    await openConsole(page);
    await page.waitForSelector('.lab');
    const sub = await page.locator('.lab .lab-sub').first().textContent();
    // e.g. "hello@1.0.0 · agent · build · intro · 60 min" — difficulty and
    // duration are optional in the manifest, so they are matched as such
    // rather than pinned, but slug, version, family and type always lead.
    expect(sub).toMatch(
      /^[a-z0-9-]+@\d+\.\d+\.\d+ · (agent|gateway) · (build|break-fix|scale)( · (intro|core|advanced))?( · \d+ min)?$/
    );
  });

  test('gives a learner enough to choose a lab without starting one', async ({ page }) => {
    // The card used to carry only a title and taxonomy words, which say
    // nothing about what you would actually do. A learner should not have
    // to spend a container to find that out.
    await openConsole(page);
    const lab = page.locator(`.lab[data-slug="${LAB}"]`);
    await expect(lab.locator('.lab-summary')).not.toBeEmpty();
    await expect(lab.locator('.lab-objectives li').first()).toBeVisible();
  });

  test('offers the hello fixture lab', async ({ page }) => {
    await openConsole(page);
    // By slug: `hasText: 'hello'` also matches the gateway-hello row, so
    // this passed while the hello lab was missing entirely.
    const lab = page.locator(`.lab[data-slug="${LAB}"]`);
    await expect(lab).toBeVisible();
    await expect(lab.locator('.lab-sub')).toHaveText(new RegExp(`^${LAB}@`));
  });

  test('surfaces a failing catalogue instead of hanging', async ({ page }) => {
    // This used to point `opalix.apiBase` at an invalid host. The lab list
    // no longer comes from there: it is served by this console's own Worker
    // at /api/labs, so the stored API base cannot break it any more. Fail
    // the real request instead, which is both truer and deterministic.
    await signIn(page);
    await page.route('**/api/labs', (route) => route.abort());
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#labList .error')).toBeVisible({ timeout: 30_000 });
    await page.unroute('**/api/labs');
  });

  test('names the API it is talking to', async ({ page }) => {
    await openConsole(page);
    await expect(page.locator('#apiLabel')).toHaveText(API);
  });
});
