import type { Page } from '@playwright/test';
import { test, expect, openConsole, signIn, API, LAB } from './fixtures';

/**
 * From home (a card per path) to a page that lists labs: the first path's page, and, when it draws
 * module cards, the first module's page. The rows are there.
 */
async function openFirstLabList(page: Page) {
  await openConsole(page);
  await page.waitForSelector('.path-card', { timeout: 30_000 });
  await page.locator('.path-card-title a').first().click();
  await page.waitForSelector('.lab, .module-card', { timeout: 30_000 });
  if (await page.locator('.module-card').count()) await page.locator('.module-card .module-title a').first().click();
  await page.waitForSelector('.lab', { timeout: 30_000 });
}

test.describe('lab launcher', () => {
  test('lists the learning paths once signed in, and a path leads to its labs', async ({ page }) => {
    await openConsole(page);
    const cards = page.locator('.path-card');
    await expect(cards.first()).toBeVisible({ timeout: 30_000 });
    expect(await cards.count()).toBeGreaterThan(0);
    // Home is the path cards: no lab rows on it.
    await expect(page.locator('.lab')).toHaveCount(0);
    await openFirstLabList(page);
    expect(await page.locator('.lab').count()).toBeGreaterThan(0);
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
    await openFirstLabList(page);
    const sub = await page.locator('.lab .lab-sub').first().textContent();
    // e.g. "hello@1.0.0 · agent · build · intro · 1 h", or with the newer
    // manifest fields "… · 20 min · 1 h limit · Free". Difficulty, the
    // time chip and the tier chip are optional, so they are matched as such
    // rather than pinned, but slug, version, family and type always lead.
    const time = '(?:\\d+ h(?: \\d+ min)?|\\d+ min)';
    expect(sub).toMatch(
      new RegExp(`^[a-z0-9-]+@\\d+\\.\\d+\\.\\d+ · (agent|gateway) · (build|break-fix|scale|explore|tune|exam)( · (intro|core|advanced))?( · ${time}( · ${time} limit)?)?( · Free)?$`)
    );
  });

  test('gives a learner enough to choose a lab without starting one', async ({ page }) => {
    // The card used to carry only a title and taxonomy words, which say
    // nothing about what you would actually do. A learner should not have
    // to spend a container to find that out.
    await openFirstLabList(page);
    // The first row on the page: the fixture labs are archived and have none. The summary and the
    // objectives are on the lab's own page, one link away.
    const lab = page.locator('.lab').first();
    await lab.getByRole('link', { name: 'About this lab' }).click();
    await expect(page.locator('.lab-detail .lab-summary')).not.toBeEmpty();
    await expect(page.locator('.lab-detail .lab-objectives li').first()).toBeVisible();
  });

  test('keeps archived labs out of the launcher, but in the catalogue', async ({ page }) => {
    await openConsole(page);
    await page.waitForSelector('.path-card', { timeout: 30_000 });
    // The catalogue API still lists every lab; the learner launcher draws only the ones that are not archived.
    const res = await page.request.get('/api/labs');
    expect(res.ok()).toBe(true);
    const labs = (await res.json()) as Array<{ slug: string; archived?: boolean }>;
    // The fixtures are archived, so `hello` is in the list (the suite starts it by slug) and has no card.
    const hello = labs.find((l) => l.slug === LAB);
    expect(hello, `the catalogue lists ${LAB}`).toBeTruthy();
    expect(hello!.archived, `${LAB} is archived`).toBe(true);
    // Home counts the labs of every path: the learner's, not the archived ones.
    await expect(page.locator('#labCount')).toHaveText(new RegExp(`^${labs.filter((l) => !l.archived).length} of ${labs.filter((l) => !l.archived).length} labs$`));
    // And no page lists an archived lab: not home, and not the first path's.
    await expect(page.locator('.lab')).toHaveCount(0);
    await page.locator('.path-card-title a').first().click();
    await page.waitForSelector('.lab, .module-card', { timeout: 30_000 });
    for (const l of labs.filter((x) => x.archived)) await expect(page.locator(`.lab[data-slug="${l.slug}"]`)).toHaveCount(0);
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
    await page.waitForSelector('.path-card');
    // Home counts every lab of every path.
    await expect(page.locator('#labCount')).toHaveText(/^(\d+) of \1 labs$/);
    await openFirstLabList(page);
    const total = await page.locator('.lab').count();
    await expect(page.locator('#labCount')).toHaveText(`${total} of ${total} labs`);
  });

  test('puts every path in a card with a heading', async ({ page }) => {
    await openConsole(page);
    await page.waitForSelector('.path-card');
    // Labs the manifests have not yet placed in a path land under one "All labs" card, so this holds for either catalogue.
    expect(await page.locator('.path-card').count()).toBeGreaterThan(0);
    expect(await page.locator('.path-card > h2.path-card-title').count()).toBe(await page.locator('.path-card').count());
    expect(await page.locator('.lab').count()).toBe(0);
  });

  test('does not show where the API lives: the footer is just the links', async ({ page }) => {
    await openConsole(page);
    await expect(page.locator('.footer')).not.toContainText(/workers\.dev|https?:/);
    await expect(page.locator('.footer .footer-link')).toHaveText(['Status', 'Feedback']);
  });
});
