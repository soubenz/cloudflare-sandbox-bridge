import { test, expect, emit, fulfillCors, patchStatus, sessionIdOf, SERVICE_KEY } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Ending a session, and what a learner sees when one ends on its own.
 *
 * None of these may really end the run's shared session (every later spec
 * joins it), so the API's DELETE and the resume/start calls are answered
 * locally, and "ended" is shown by rewriting the status the console reads.
 * Both the fake `ended` event and the rewrite are needed: the console only
 * believes an `ended` event once the API's own status agrees.
 */

const DELETE_PATTERN = /\/sessions\/[^/]+\?snapshot=/;

/** Answers `DELETE /sessions/:id?snapshot=…`, recording the URLs it saw. */
async function stubEnd(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.route(DELETE_PATTERN, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    seen.push(route.request().url());
    await fulfillCors(route, 200, { ok: true });
  });
  return seen;
}

test.describe('ending a session', () => {
  test('asks whether to keep the work, with Cancel to back out', async ({ session }) => {
    await session.locator('#btnEnd').click();
    const dialog = session.locator('#endDialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'End and keep my work' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Discard' })).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(session.locator('#workspace')).toBeVisible();
    await expect(session.locator('#btnEnd')).toBeEnabled();
  });

  test('"End and keep my work" ends with a snapshot', async ({ session }) => {
    const seen = await stubEnd(session);
    await session.locator('#btnEnd').click();
    await session.locator('#endDialog').getByRole('button', { name: 'End and keep my work' }).click();

    await expect(session.locator('#launcher')).toBeVisible({ timeout: 30_000 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('snapshot=1');
  });

  test('"Discard" ends without one', async ({ session }) => {
    const seen = await stubEnd(session);
    await session.locator('#btnEnd').click();
    await session.locator('#endDialog').getByRole('button', { name: 'Discard' }).click();

    await expect(session.locator('#launcher')).toBeVisible({ timeout: 30_000 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('snapshot=0');
  });
});

test.describe('a session that ended on its own', () => {
  test.skip(!SERVICE_KEY, 'needs OPALIX_KEY to push the ended event');

  /** Shows the console an `ended` session, as the API would report one. */
  async function endedBy(page: Page, reason: string, ended: { value: boolean } = { value: true }) {
    await patchStatus(page, (body) => {
      if (!ended.value) return;
      body.meta.state = 'ended';
      body.meta.end_reason = reason;
    });
    await emit(page.request, await sessionIdOf(page), 'session.state', { state: 'ended', reason });
  }

  test('offers to resume or restart after an idle end', async ({ session }) => {
    await endedBy(session, 'idle');
    const banner = session.locator('#endedBanner');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText('nothing happened in it');
    await expect(banner.locator('button:has-text("Resume")')).toBeVisible();
    await expect(banner.locator('button:has-text("Restart")')).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Back to labs' })).toBeVisible();
  });

  test('offers the same after the time limit', async ({ session }) => {
    await endedBy(session, 'expired');
    const banner = session.locator('#endedBanner');
    await expect(banner.locator('button:has-text("Resume")')).toBeVisible({ timeout: 30_000 });
    await expect(banner.locator('button:has-text("Restart")')).toBeVisible();
  });

  test('offers only a way back when the end was an error', async ({ session }) => {
    await endedBy(session, 'error');
    const banner = session.locator('#endedBanner');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner.locator('button:has-text("Resume")')).toBeHidden();
    await expect(banner.locator('button:has-text("Restart")')).toBeHidden();
    await expect(banner.getByRole('button', { name: 'Back to labs' })).toBeVisible();
  });

  test('"Resume my work" asks the API to resume, then starts the session again', async ({ session }) => {
    const ended = { value: true };
    let resumed = 0;
    // The API's answer to a resume: the same session, `resuming`, a token.
    await session.route(/\/sessions\/[^/]+\/resume$/, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      resumed++;
      ended.value = false;
      const saved = await session.evaluate(() => JSON.parse(localStorage.getItem('opalix.session') ?? '{}'));
      await fulfillCors(route, 200, { meta: { state: 'resuming' }, token: saved.token });
    });
    await endedBy(session, 'idle', ended);

    await session.locator('#endedBanner button:has-text("Resume")').click();
    // Back through the normal start: the live session's status is real again.
    await expect(session.locator('#endedBanner')).toBeHidden({ timeout: 30_000 });
    await expect(session.locator('#statePill')).toHaveText('running', { timeout: 60_000 });
    expect(resumed).toBe(1);
  });

  test('"Restart lab" starts the lab again by its slug', async ({ session }) => {
    const bodies: string[] = [];
    await session.route('**/api/start', async (route) => {
      bodies.push(route.request().postData() ?? '');
      // Not a real start: the run's one container must not be disturbed.
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'stubbed' }) });
    });
    await endedBy(session, 'idle');

    await session.locator('#endedBanner button:has-text("Restart")').click();
    await expect.poll(() => bodies.length, { timeout: 30_000 }).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ lab: 'hello' });
  });
});
