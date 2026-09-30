import { test, expect } from './fixtures';

test.describe('a running session', () => {
  test('reaches running and shows its identity', async ({ session }) => {
    await expect(session.locator('#statePill')).toHaveText('running');
    await expect(session.locator('#sessionLab')).toHaveText('hello');
    // ULID: 26 chars, Crockford base32.
    await expect(session.locator('#sessionId')).toHaveText(/^[0-9a-hjkmnp-tv-z]{26}$/i);
  });

  test('streams events over SSE, cross-origin', async ({ session }) => {
    // The raw event log left the learner console with the operator panel.
    // What proves the *stream* arrived (as opposed to a status poll) is the
    // stream pill: it is shown only while the SSE connection is down, and a
    // notice lands in Lab activity without it ever appearing.
    const notices = session.locator('#noticeList li');
    await expect(notices.first()).toBeVisible({ timeout: 30_000 });
    await expect(session.locator('#streamPill')).toBeHidden();
  });

  test('shows the learner lab activity rather than raw telemetry', async ({ session }) => {
    // What a learner sees of the same stream: prose, no event types, no
    // payloads. The pane is theirs — no operator key is involved — and a
    // service coming up healthy is the first thing to land.
    await expect(session.locator('#activityPane')).toBeVisible();
    const notices = session.locator('#noticeList li');
    await expect(notices.first()).toBeVisible({ timeout: 60_000 });
    const text = await notices.first().innerText();
    expect(text).not.toMatch(/session\.state|check\.(started|result)|\{/);
  });

  test('reports the lab service as healthy', async ({ session }) => {
    // The Services block carries each service's live health, fed by the
    // same service.health events the operator log used to show raw.
    const health = session.locator('#serviceList li .svc-health').first();
    await expect(health).toHaveText('healthy', { timeout: 60_000 });
    await expect(health).toHaveAttribute('data-health', 'healthy');
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
