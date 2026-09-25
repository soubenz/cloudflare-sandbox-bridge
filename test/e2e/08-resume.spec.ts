import { test, expect, openConsole, startOrResume, signIn } from './fixtures';

test.describe('session continuity', () => {
  test('comes back to the running lab after a reload', async ({ page }) => {
    await openConsole(page);
    const first = await startOrResume(page);

    // A learner closing the tab and returning should land back in their
    // lab, not at the picker with a container still running somewhere.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#workspace')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#statePill')).toHaveText('running', { timeout: 60_000 });
    await expect(page.locator('#sessionId')).toHaveText(first);
  });

  test('restores the workspace panels on resume', async ({ page }) => {
    await openConsole(page);
    await startOrResume(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.locator('#fileList li').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#serviceTabs .tab').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#expiryTimer')).toHaveText(/left$/, { timeout: 30_000 });
  });

  test('falls back to the picker when the stored session is gone', async ({ page }) => {
    await signIn(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.setItem(
        'opalix.session',
        JSON.stringify({ id: '01000000000000000000000000', token: 'not-a-real-token', lab: 'hello', urls: {} })
      );
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    // A dead session must not leave a dead workspace on screen.
    await expect(page.locator('#launcher')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.lab').first()).toBeVisible({ timeout: 30_000 });
  });
});
