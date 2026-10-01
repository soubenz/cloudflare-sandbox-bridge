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
    // e.g. "hello@1.0.0 · agent · build · intro · 60 min", or with the newer
    // manifest fields "… · ~20 min · 60 min limit · Free". Difficulty, the
    // time chip and the tier chip are optional, so they are matched as such
    // rather than pinned, but slug, version, family and type always lead.
    expect(sub).toMatch(
      /^[a-z0-9-]+@\d+\.\d+\.\d+ · (agent|gateway) · (build|break-fix|scale|explore|tune|exam)( · (intro|core|advanced))?( · (~\d+ min · \d+ min limit|\d+ min))?( · Free)?$/
    );
  });

  test('gives a learner enough to choose a lab without starting one', async ({ page }) => {
    // The card used to carry only a title and taxonomy words, which say
    // nothing about what you would actually do. A learner should not have
    // to spend a container to find that out.
    await openConsole(page);
    // The first card on the page: the fixture labs are archived and have none.
    await page.waitForSelector('.lab', { timeout: 30_000 });
    const lab = page.locator('.lab').first();
    await expect(lab.locator('.lab-summary')).not.toBeEmpty();
    await lab.locator('.lab-more > summary').click();
    await expect(lab.locator('.lab-objectives li').first()).toBeVisible();
  });

  test('keeps archived labs out of the launcher, but in the catalogue', async ({ page }) => {
    await openConsole(page);
    await page.waitForSelector('.lab', { timeout: 30_000 });
    // The catalogue API still lists every lab; the learner launcher draws only the ones that are not archived.
    const res = await page.request.get('/api/labs');
    expect(res.ok()).toBe(true);
    const labs = (await res.json()) as Array<{ slug: string; archived?: boolean }>;
    // The fixtures are archived, so `hello` is in the list (the suite starts it by slug) and has no card.
    const hello = labs.find((l) => l.slug === LAB);
    expect(hello, `the catalogue lists ${LAB}`).toBeTruthy();
    expect(hello!.archived, `${LAB} is archived`).toBe(true);
    for (const l of labs) {
      await expect(page.locator(`.lab[data-slug="${l.slug}"]`)).toHaveCount(l.archived ? 0 : 1);
    }
    await expect(page.locator('#labCount')).toHaveText(new RegExp(`^${labs.filter((l) => !l.archived).length} of ${labs.filter((l) => !l.archived).length} labs$`));
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

  test('counts the labs it shows as "N of M labs"', async ({ page }) => {
    await openConsole(page);
    await page.waitForSelector('.lab');
    const total = await page.locator('.lab').count();
    await expect(page.locator('#labCount')).toHaveText(`${total} of ${total} labs`);
  });

  test('puts every card inside a group with a heading', async ({ page }) => {
    await openConsole(page);
    await page.waitForSelector('.lab');
    // Labs the manifests have not yet placed in a path and module all land
    // under one "All labs" group, so this holds for either catalogue.
    expect(await page.locator('.lab-group').count()).toBeGreaterThan(0);
    expect(await page.locator('.lab-group > h2.group-head').count()).toBe(await page.locator('.lab-group').count());
    expect(await page.locator('.lab:not(.lab-group .lab)').count()).toBe(0);
  });

  test('names the API it is talking to', async ({ page }) => {
    await openConsole(page);
    await expect(page.locator('#apiLabel')).toHaveText(API);
  });
});
