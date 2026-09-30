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

    // End opens a dialog now rather than a confirm(); the run's cleanup has
    // no work to keep, so it discards.
    await page.locator('#btnEnd').click();
    await page.locator('#endDialog').getByRole('button', { name: 'Discard' }).click();

    // Ending is deliberate and has an obvious next step, so the console
    // takes it: no dead workspace parked behind one more button. (A session
    // that ends on its own — idle, expiry, error — still stops and explains
    // itself; that is a different path.)
    await expect(page.locator('#launcher')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.lab').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#workspace')).toBeHidden();
    await expect(page.locator('#sessionBar')).toBeHidden();

    clearSharedSession();
  });
});
