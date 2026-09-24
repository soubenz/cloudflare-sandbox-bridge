import { test, expect, openConsole, API, LAB } from './fixtures';

test.describe('lab launcher', () => {
  test('lists published labs without a service key', async ({ page }) => {
    await openConsole(page);
    const labs = page.locator('.lab');
    await expect(labs.first()).toBeVisible({ timeout: 30_000 });
    expect(await labs.count()).toBeGreaterThan(0);
  });

  test('shows each lab with its slug, version and family', async ({ page }) => {
    await openConsole(page);
    await page.waitForSelector('.lab');
    const sub = await page.locator('.lab .lab-sub').first().textContent();
    // e.g. "hello@1.0.0 · agent · build"
    expect(sub).toMatch(/^[a-z0-9-]+@\d+\.\d+\.\d+ · (agent|gateway) · (build|break-fix|scale)$/);
  });

  test('offers the hello fixture lab', async ({ page }) => {
    await openConsole(page);
    // By slug: `hasText: 'hello'` also matches the gateway-hello row, so
    // this passed while the hello lab was missing entirely.
    const lab = page.locator(`.lab[data-slug="${LAB}"]`);
    await expect(lab).toBeVisible();
    await expect(lab.locator('.lab-sub')).toHaveText(new RegExp(`^${LAB}@`));
  });

  test('surfaces an unreachable API instead of hanging', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('opalix.apiBase', 'https://opalix-does-not-exist.invalid'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#labList .error')).toBeVisible({ timeout: 30_000 });
    // Leave the API pointing somewhere real for the specs that follow.
    await page.evaluate((api) => localStorage.setItem('opalix.apiBase', api), API);
  });

  test('names the API it is talking to', async ({ page }) => {
    await openConsole(page);
    await expect(page.locator('#apiLabel')).toHaveText(API);
  });
});
