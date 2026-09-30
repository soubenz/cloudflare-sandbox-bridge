import { test, expect, emit, patchStatus, sessionIdOf, SERVICE_KEY } from './fixtures';

/**
 * What a learner is told while a lab runs: the activity pane, the idle
 * banner and the expiry banner. Events are pushed with the service key
 * (see `emit`), so these skip without one.
 */
test.describe('lab notices', () => {
  test.skip(!SERVICE_KEY, 'needs OPALIX_KEY to push events into the session');

  test('shows the activity pane to a learner, with no operator key', async ({ session }) => {
    await expect(session.locator('#activityPane')).toBeVisible();
    await expect(session.locator('#noticeList')).toHaveAttribute('role', 'log');
    // Labelled for what it is, not for who it is for.
    await expect(session.locator('#activityPane h2')).toHaveText('Lab activity');
    await expect(session.locator('#activityPane .block-meta')).toHaveCount(0);
    // The raw event log is still operator-only.
    await expect(session.locator('#ops')).toBeHidden();
  });

  test('turns a pressure event into a notice', async ({ session }) => {
    const title = `Pressure ${Date.now()}`;
    await emit(session.request, await sessionIdOf(session), 'pressure', {
      event_id: 'e2e',
      title,
      message: 'A deadline moved up.',
    });
    await expect(session.locator('#noticeList li', { hasText: title })).toBeVisible({ timeout: 30_000 });
  });

  test('says how long is left from the session clock when it is about to expire', async ({ session }) => {
    await emit(session.request, await sessionIdOf(session), 'session.expiring', { reason: 'hard_timeout' });
    const notice = session.locator('#noticeList li', { hasText: 'Session ending soon' }).first();
    await expect(notice).toBeVisible({ timeout: 30_000 });
    // Minutes are worked out from expires_at; the payload carries none.
    await expect(notice).toContainText(/About \d+ minutes? left/);
    await expect(notice).not.toContainText('NaN');
  });

  test('asks "still there?" on an idle warning and clears on "I\'m here"', async ({ session }) => {
    const banner = session.locator('#idleBanner');
    await expect(banner).toBeHidden();

    await emit(session.request, await sessionIdOf(session), 'session.idle_warning', { idle_ms: 13 * 60_000 });
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toHaveAttribute('role', 'alert');
    // Counts down from the API's two-minute warning.
    await expect(banner).toContainText(/1:5\d/);

    const touched = session.waitForRequest((r) => r.method() === 'POST' && /\/sessions\/[^/]+\/touch$/.test(r.url()));
    await banner.getByRole('button', { name: "I'm here" }).click();
    await touched;
    await expect(banner).toBeHidden();
  });

  test('warns that the session is ending when under five minutes remain', async ({ session }) => {
    // Rewrite the status the console reads so the session appears to end in
    // four minutes, then reload so the console takes its clock from it.
    await patchStatus(session, (body) => {
      body.meta.expires_at = Date.now() + 4 * 60_000;
    });
    await session.reload({ waitUntil: 'domcontentloaded' });

    const banner = session.locator('#expiryBanner');
    await expect(banner).toBeVisible({ timeout: 60_000 });
    await expect(banner).toContainText(/Ends in \d+:\d{2}/);
    await expect(banner).toHaveAttribute('role', 'alert');
    await expect(session.locator('#btnEnd')).toHaveText('End & snapshot');
  });
});
