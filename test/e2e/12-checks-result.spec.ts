import { test, expect, API, SERVICE_KEY, patchStatus, sessionIdOf } from './fixtures';

/**
 * The learner's view of grading: the Checks block (weights, full messages,
 * points, earlier runs), the Hints block with its locked slots, and the
 * result card that appears once every check has passed.
 *
 * The session is shared with the other specs, so nothing here assumes a
 * fresh workspace. The graded file is written through the files API — the
 * console cannot create one — and it is set to a wrong value first so the
 * first run fails whatever an earlier spec left behind.
 */
test.describe('checks, hints and the result card', () => {
  test.skip(!SERVICE_KEY, 'needs OPALIX_KEY to write the graded file');

  async function writeGreeting(sessionId: string, content: string): Promise<void> {
    const res = await fetch(`${API}/sessions/${sessionId}/files/greeting.txt`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
      body: content,
    });
    expect(res.ok).toBe(true);
  }

  test('lists a slot for every hint, with a countdown on the ones still locked', async ({ session }) => {
    // The hello lab's only hint unlocks two minutes in, and the session is
    // shared, so by now it may well be delivered. Push it into the future
    // on the status the console reads rather than depending on the clock.
    await patchStatus(session, (body) => {
      const hints = body.hints ?? { delivered: [], total: 1, schedule: [2] };
      hints.delivered = [];
      hints.schedule = hints.schedule.map(() => 999);
      hints.total = Math.max(hints.total, hints.schedule.length, 1);
      body.hints = hints;
      body.meta.started_at = Date.now();
      body.server_time = Date.now();
    });
    // The stream replays recent events, which would deliver the real hint
    // over the locked slot; the console falls back to polling status.
    await session.route(/\/sessions\/[^/]+\/events/, (route) => route.abort());
    await session.reload({ waitUntil: 'domcontentloaded' });
    await session.waitForSelector('body[data-booted="1"]', { timeout: 60_000 });

    const locked = session.locator('#hintsPanel .hint-locked').first();
    await expect(locked).toBeVisible({ timeout: 60_000 });
    await expect(locked).toContainText(/Hint 1 · unlocks in/);
    await expect(locked).toContainText(/\d+h|\d+m/);
    // No way to reveal it early.
    await expect(locked.getByRole('button')).toHaveCount(0);
  });

  test('shows weights, points and previous runs, then the result card on a full pass', async ({ session }) => {
    const sessionId = await sessionIdOf(session);

    // A wrong greeting: the grader fails it with a reason.
    await writeGreeting(sessionId, 'not the greeting');
    await session.locator('#btnChecks').click();
    await expect(session.locator('.check').first()).toBeVisible({ timeout: 60_000 });
    await expect(session.locator('.check[data-weight]').first()).toBeVisible();
    await expect(session.locator('#checksSummary')).toHaveText(/\d+\/\d+ pts · \d+\/\d+ checks/);
    await expect(session.locator('.check-fail .check-detail').first()).toContainText(/greeting\.txt/);

    // The same run from the button inside the Checks block.
    await expect(session.locator('#btnChecksInline')).toBeEnabled();

    // Solve it and grade again, from the block's own button this time.
    await writeGreeting(sessionId, 'hello from opalix');
    await session.locator('#btnChecksInline').click();
    await expect(session.locator('.check-pass').first()).toBeVisible({ timeout: 60_000 });

    const card = session.locator('#resultCard');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toHaveAttribute('role', 'status');
    await expect(card.getByRole('heading')).toBeVisible();
    await expect(card).toContainText(/\d+\/\d+ checks/);
    await expect(card.locator('#resultTime')).toHaveText(/^\d+:\d\d$/);
    await expect(card.locator('#resultHints')).toHaveText(/^\d+ of \d+$/);

    // Every run before the one on screen, newest first.
    await expect(session.locator('details.check-history')).toBeVisible({ timeout: 30_000 });
    await session.locator('details.check-history summary').click();
    const history = session.locator('details.check-history li');
    await expect(history.first()).toBeVisible();
    expect(await history.count()).toBeGreaterThanOrEqual(1);

    // A second passing run does not bring the card back or add another.
    await session.locator('#btnChecks').click();
    await expect(session.locator('.check-pass').first()).toBeVisible({ timeout: 60_000 });
    await expect(session.locator('#resultCard')).toHaveCount(1);
    await expect(session.locator('#confetti i')).toHaveCount(0);
  });

  test('takes a rating and says thanks', async ({ session }) => {
    const sessionId = await sessionIdOf(session);
    await writeGreeting(sessionId, 'hello from opalix');
    // The console reads a lab finished earlier as done, so the card is
    // there without another run.
    const card = session.locator('#resultCard');
    if (!(await card.isVisible())) {
      await session.locator('#btnChecks').click();
      await expect(card).toBeVisible({ timeout: 60_000 });
    }

    await expect(card.getByRole('group', { name: /How was this lab/ })).toBeVisible();
    await expect(card.locator('#btnFeedback')).toBeDisabled();
    await card.locator('input[name="rating"][value="5"]').check();
    await card.locator('#feedbackText').fill('Clear and quick.');
    const sent = session.waitForRequest((r) => r.method() === 'POST' && /\/sessions\/[^/]+\/feedback$/.test(r.url()));
    await card.locator('#btnFeedback').click();
    expect(JSON.parse((await sent).postData() ?? '{}')).toEqual({ rating: 5, text: 'Clear and quick.' });
    await expect(card.getByText('Thanks')).toBeVisible();
    await expect(card.locator('#feedbackForm')).toBeHidden();
  });
});
