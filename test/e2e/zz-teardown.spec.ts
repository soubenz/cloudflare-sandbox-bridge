import { test, expect, openConsole, startOrResume, clearSharedSession } from './fixtures';

/**
 * Runs last, and is the suite's cleanup: a session left running holds a
 * container until its idle timeout. Making teardown a test rather than a
 * hook means a failure to clean up is reported rather than swallowed.
 */
test.describe('ending the session', () => {
  test('tears the session down and offers the way back to the labs', async ({ page }) => {
    await openConsole(page);
    await startOrResume(page);

    page.on('dialog', (d) => d.accept());
    await page.locator('#btnEnd').click();

    await expect(page.locator('#statePill')).toHaveText('ended', { timeout: 60_000 });
    for (const id of ['#btnChecks', '#btnSnapshot', '#btnEnd']) {
      await expect(page.locator(id)).toBeDisabled();
    }
    await expect(page.locator('#btnBackToLabs')).toBeVisible();

    await page.locator('#btnBackToLabs').click();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator('.lab').first()).toBeVisible({ timeout: 30_000 });

    clearSharedSession();
  });
});
