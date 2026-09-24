import { test, expect } from './fixtures';

test.describe('a running session', () => {
  test('reaches running and shows its identity', async ({ session }) => {
    await expect(session.locator('#statePill')).toHaveText('running');
    await expect(session.locator('#sessionLab')).toHaveText('hello');
    // ULID: 26 chars, Crockford base32.
    await expect(session.locator('#sessionId')).toHaveText(/^[0-9a-hjkmnp-tv-z]{26}$/i);
  });

  test('streams events over SSE, cross-origin', async ({ session }) => {
    // The raw event log is operator telemetry now, so it lives behind the
    // Operator panel rather than in the learner's workspace. Still asserted
    // on the log itself: it is the only place that proves the *stream*
    // arrived, as opposed to something the console could have polled.
    await session.locator('#btnOps').click();
    const events = session.locator('#eventList li');
    await expect(events.first()).toBeVisible({ timeout: 30_000 });
    const types = await session.locator('#eventList .what').allTextContents();
    expect(types).toContain('session.state');
    await session.locator('#btnOps').click();
  });

  test('shows the learner lab activity rather than raw telemetry', async ({ session }) => {
    // What a learner sees of the same stream: prose, no event types, no
    // payloads. A service coming up healthy is the first thing to land.
    const notices = session.locator('#noticeList li');
    await expect(notices.first()).toBeVisible({ timeout: 60_000 });
    const text = await notices.first().innerText();
    expect(text).not.toMatch(/session\.state|check\.(started|result)|\{/);
  });

  test('reports the lab service as healthy', async ({ session }) => {
    await session.locator('#btnOps').click();
    const details = await session.locator('#eventList li', { hasText: 'service.health' }).first().innerText();
    expect(details).toContain('healthy');
    // Leave the panel as it was found; specs share one page.
    await session.locator('#btnOps').click();
  });

  test('opens on the brief, so the learner is told the task', async ({ session }) => {
    // The console used to drop a learner into an empty terminal with the
    // brief sitting unread in the workspace. Landing on the task is the
    // whole point, so assert both the tab and its rendered content.
    await expect(session.locator('.tab-active')).toHaveText('Brief');
    const brief = session.locator('#briefBody');
    await expect(brief.locator('h2').first()).toBeVisible({ timeout: 30_000 });
    // Rendered, not raw: no leftover Markdown syntax on screen.
    await expect(brief).toContainText('greeting.txt');
    expect(await brief.innerText()).not.toMatch(/^#{1,4} |\*\*/m);
    // The lab's objectives lead the brief.
    await expect(session.locator('.objectives li').first()).toBeVisible();
  });

  test('counts down to the hard timeout', async ({ session }) => {
    const timer = session.locator('#expiryTimer');
    await expect(timer).toHaveText(/^\d+:\d{2} left$/, { timeout: 30_000 });

    const first = await timer.textContent();
    await session.waitForTimeout(2500);
    expect(await timer.textContent()).not.toBe(first);
  });

  test('enables the session controls', async ({ session }) => {
    for (const id of ['#btnChecks', '#btnSnapshot', '#btnEnd']) {
      await expect(session.locator(id)).toBeEnabled();
    }
  });
});
