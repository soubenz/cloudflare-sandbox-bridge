import { test, expect, openConsole } from './fixtures';

test.describe('the operator view', () => {
  test('shows a tile per family with warm and claimed counts', async ({ page }) => {
    await openConsole(page);
    await page.locator('#btnOps').click();

    const tiles = page.locator('.tile');
    await expect(tiles.first()).toBeVisible({ timeout: 30_000 });
    expect(await tiles.count()).toBeGreaterThanOrEqual(2);

    // Counts, not collections: GET /pools reports numbers.
    await expect(tiles.first().locator('.tile-value')).toHaveText(/^\d+ warm$/);
    await expect(tiles.first().locator('.tile-sub')).toHaveText(/\d+ claimed · target \d+/);
  });

  test('names both families', async ({ page }) => {
    await openConsole(page);
    await page.locator('#btnOps').click();
    await expect(page.locator('.tile').first()).toBeVisible({ timeout: 30_000 });

    const labels = await page.locator('.tile-label').allTextContents();
    expect(labels.join(' ')).toContain('agent pool');
    expect(labels.join(' ')).toContain('gateway pool');
  });

  test('refuses prime and drain without a service key', async ({ page }) => {
    await openConsole(page);
    await page.locator('#btnOps').click();
    await expect(page.locator('.tile').first()).toBeVisible({ timeout: 30_000 });

    // Destructive pool actions stay behind the service key even while
    // session start is open, so this must not go through.
    await page.locator('.tile').first().locator('[data-act="drain"]').click();
    await expect(page.locator('#opsKeyStatus')).toHaveText(/service key/i);
  });

  test('toggles back to whatever it was showing', async ({ page }) => {
    await openConsole(page);
    // Either the picker or a running session, depending on whether this
    // run has started one yet; the panel must restore what it covered.
    const cameFromWorkspace = await page.locator('#workspace').isVisible();

    await page.locator('#btnOps').click();
    await expect(page.locator('#ops')).toBeVisible();

    await page.locator('#btnOps').click();
    await expect(page.locator('#ops')).toBeHidden();
    await expect(page.locator(cameFromWorkspace ? '#workspace' : '#launcher')).toBeVisible();
  });
});
