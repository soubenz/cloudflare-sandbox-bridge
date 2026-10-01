import type { Page } from '@playwright/test';
import { test, expect, emit, fulfillCors, openConsole, patchStatus, sessionIdOf, SERVICE_KEY } from './fixtures';

/**
 * The console when things go wrong under it: a dropped event stream, a
 * session token that has aged out, a service that will not start, no free
 * lab slot. Nothing here may disturb the run's shared session.
 */

const EVENTS = /\/sessions\/[^/]+\/events/;
const FILES = /\/sessions\/[^/]+\/files\?/;

test.describe('a dropped event stream', () => {
  test('shows a reconnecting pill, and keeps the state pill current by polling', async ({ session }) => {
    // Refuse the stream from here on, then reload so the console opens it
    // against the block. The boot itself is left alone: it finishes by polling.
    let degraded = false;
    await session.route(EVENTS, (route) => route.abort());
    await patchStatus(session, (body) => {
      // What the API would report if the session changed while the stream was down.
      if (degraded && body.meta.state === 'running') body.meta.state = 'recovering';
    });
    await session.reload({ waitUntil: 'domcontentloaded' });

    await expect(session.locator('#streamPill')).toBeVisible({ timeout: 5_000 });
    await expect(session.locator('#streamPill')).toContainText('reconnecting');
    await expect(session.locator('#statePill')).toHaveText('running', { timeout: 60_000 });

    degraded = true;
    // Three errors in, the console polls the status itself (every 10s) —
    // the only way it can learn this now.
    await expect(session.locator('#statePill')).toHaveText('recovering', { timeout: 60_000 });
  });

  test('hides the pill again once the stream is back', async ({ session }) => {
    let blocked = true;
    await session.route(EVENTS, (route) => (blocked ? route.abort() : route.fallback()));
    await session.reload({ waitUntil: 'domcontentloaded' });
    await expect(session.locator('#streamPill')).toBeVisible({ timeout: 5_000 });

    blocked = false;
    // The browser's own retry finds the stream and the pill goes.
    await expect(session.locator('#streamPill')).toBeHidden({ timeout: 30_000 });
  });
});

/**
 * The session screen once the console has finished starting it: the boot
 * modal gone, the guide built and the first file listing on screen. Stubs for
 * the expired-token specs are installed only after this, so that the request
 * they refuse is the one the spec makes and not one the page makes by itself
 * while it is still opening (which would be answered with the 401 first, and
 * leave the click below it with nothing to land on).
 */
async function settled(page: Page): Promise<void> {
  await expect(page.locator('#bootModal')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('#guide[data-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await expect(page.locator('#fileList li:has(.name)').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#btnRefreshFiles')).toBeEnabled();
}

test.describe('a session token that has expired', () => {
  test('is replaced by rejoining, and the same session carries on', async ({ session }) => {
    const id = await sessionIdOf(session);
    await settled(session);

    const listings: number[] = []; // status of every file listing the page made, in order
    let rejoins = 0;
    let refused = false;
    session.on('response', (res) => {
      if (FILES.test(res.url()) && res.request().method() === 'GET') listings.push(res.status());
    });
    session.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/start$/.test(req.url())) rejoins++;
    });
    // The API refuses the first file listing, as it would an aged-out token.
    await session.route(FILES, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      if (refused) return route.fallback();
      refused = true;
      await fulfillCors(route, 401, { error: { code: 'unauthorized', message: 'Session token expired' } });
    });

    await session.locator('#btnRefreshFiles').click();

    // Refused once, then asked again with the token the rejoin returned. The
    // page may list files again for its own reasons (a file written, a
    // service coming up), so the count is a floor, not an exact number.
    await expect.poll(() => listings.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    expect(listings[0]).toBe(401);
    await expect.poll(() => listings.at(-1), { timeout: 30_000 }).toBe(200);
    // One refusal cost one rejoin, not a loop of them.
    expect(rejoins).toBe(1);
    await expect(session.locator('#fileList li:has(.name)').first()).toBeVisible();
    await expect(session.locator('#sessionId')).toHaveText(id);
    await expect(session.locator('#workspace')).toBeVisible();
    await expect(session.locator('#launchError')).toBeHidden();
  });

  test('says the learner is signed out when the rejoin is refused too', async ({ session }) => {
    await settled(session);
    await session.route(FILES, (route) =>
      route.request().method() === 'GET'
        ? fulfillCors(route, 401, { error: { code: 'unauthorized', message: 'Session token expired' } })
        : route.fallback()
    );
    await session.route('**/api/start', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'signed out' }) })
    );

    await session.locator('#btnRefreshFiles').click();

    await expect(session.locator('#launcher')).toBeVisible({ timeout: 30_000 });
    await expect(session.locator('#launchError')).toContainText('Signed out — sign in to return to your running lab');
    await expect(session.locator('#workspace')).toBeHidden();
    // Signing out is not a failed start: the boot modal must not be left over it.
    await expect(session.locator('#bootModal')).toBeHidden();
  });
});

test.describe('no free lab slot', () => {
  test('says so and that it will try again', async ({ page }) => {
    await openConsole(page);
    // The picker, not the run's session: forget it in this browser only.
    await page.evaluate(() => localStorage.removeItem('opalix.session'));
    await page.route('**/api/start', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'pool exhausted' }) })
    );
    // Go to the launcher itself, not a reload: a resumed session leaves the
    // address at /labs/<slug>, and a lab's address starts that lab on load,
    // which would hit the stubbed 503 before the picker was ever on screen.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]', { timeout: 60_000 });

    await page.locator('.lab[data-slug="hello"] button').click();
    await expect(page.locator('#launchError')).toContainText('All lab slots are busy — retrying in 30s');
  });
});

test.describe('a service that will not start', () => {
  test.skip(!SERVICE_KEY, 'needs OPALIX_KEY to push the unhealthy report');

  test('keeps the service’s last log lines under its boot row', async ({ session }) => {
    const id = await sessionIdOf(session);
    await emit(session.request, id, 'service.health', { service: 'api', health: 'unhealthy', logs_tail: 'boom' });
    try {
      // A fresh console replays the stream from the start, boot included.
      await session.reload({ waitUntil: 'domcontentloaded' });
      const rows = session.locator('#bootServices .boot-svc');
      await expect(rows.first()).toBeAttached({ timeout: 60_000 });
      const logs = session.locator('#bootServices .boot-svc[data-service="api"] pre.logs-tail');
      await expect(logs).toContainText('boom');
      // Collapsed by default: there when asked for, not in the way.
      await expect(session.locator('#bootServices .boot-svc[data-service="api"] details')).not.toHaveAttribute('open', '');
    } finally {
      // Leave the shared session's stream as it was found.
      await emit(session.request, id, 'service.health', { service: 'api', health: 'healthy' });
    }
  });
});
