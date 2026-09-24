import { test, expect } from './fixtures';

test.describe('a running session', () => {
  test('reaches running and shows its identity', async ({ session }) => {
    await expect(session.locator('#statePill')).toHaveText('running');
    await expect(session.locator('#sessionLab')).toHaveText('hello');
    // ULID: 26 chars, Crockford base32.
    await expect(session.locator('#sessionId')).toHaveText(/^[0-9a-hjkmnp-tv-z]{26}$/i);
  });

  test('streams events over SSE, cross-origin', async ({ session }) => {
    const events = session.locator('#eventList li');
    await expect(events.first()).toBeVisible({ timeout: 30_000 });
    const types = await session.locator('#eventList .what').allTextContents();
    expect(types).toContain('session.state');
  });

  test('reports the lab service as healthy', async ({ session }) => {
    const details = await session.locator('#eventList li', { hasText: 'service.health' }).first().innerText();
    expect(details).toContain('healthy');
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
