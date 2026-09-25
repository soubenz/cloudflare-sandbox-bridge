import { test, expect, openConsole } from './fixtures';

/**
 * The pool tiles read GET /pools, which is service-key-only now that the
 * dev switch is gone. The operator panel has always had a field for pasting
 * that key; these tests use it rather than relying on the route being open,
 * which is what they did before.
 */
const SERVICE_KEY = process.env.OPALIX_KEY;

async function openOperator(page: Parameters<typeof openConsole>[0]) {
  await openConsole(page);
  await page.locator('#btnOps').click();
  await page.locator('#opsKey').fill(SERVICE_KEY!);
  await page.locator('#btnSaveKey').click();
}

test.describe('the operator view', () => {
  test.skip(!SERVICE_KEY, 'needs OPALIX_KEY: GET /pools requires the service key');

  test('shows a tile per family with warm and claimed counts', async ({ page }) => {
    await openOperator(page);

    const tiles = page.locator('.tile');
    await expect(tiles.first()).toBeVisible({ timeout: 30_000 });
    expect(await tiles.count()).toBeGreaterThanOrEqual(2);

    // Counts, not collections: GET /pools reports numbers.
    await expect(tiles.first().locator('.tile-value')).toHaveText(/^\d+ warm$/);
    await expect(tiles.first().locator('.tile-sub')).toHaveText(/\d+ claimed · target \d+/);
  });

  test('names both families', async ({ page }) => {
    await openOperator(page);
    await expect(page.locator('.tile').first()).toBeVisible({ timeout: 30_000 });

    const labels = await page.locator('.tile-label').allTextContents();
    expect(labels.join(' ')).toContain('agent pool');
    expect(labels.join(' ')).toContain('gateway pool');
  });

  test('shows nothing at all without a service key', async ({ page }) => {
    // This used to assert that the *actions* were refused while the tiles
    // still rendered, because GET /pools was open. It is not: the whole
    // panel now needs the key, which is a stronger position than the one
    // this test was defending.
    await openConsole(page);
    await page.locator('#btnOps').click();
    await expect(page.locator('#poolTiles')).toContainText(/401|service key|unauthor/i, { timeout: 30_000 });
    await expect(page.locator('.tile')).toHaveCount(0);
  });

  test('refuses a destructive action when the key is wrong', async ({ page }) => {
    // The key gets the tiles on screen; a *bad* key must still not drain a
    // pool. Prime and drain are the two irreversible things here.
    await openConsole(page);
    await page.locator('#btnOps').click();
    await page.locator('#opsKey').fill('not-the-service-key');
    await page.locator('#btnSaveKey').click();
    await expect(page.locator('#poolTiles')).toContainText(/401|service key|unauthor/i, { timeout: 30_000 });
    await expect(page.locator('.tile')).toHaveCount(0);
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
