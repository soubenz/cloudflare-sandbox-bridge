import { test, expect, API, emit, sessionIdOf, SERVICE_KEY } from './fixtures';

test.describe('the lab service UI', () => {
  test('offers a tab for each service the manifest marks ui', async ({ session }) => {
    const tabs = session.locator('#serviceTabs .tab');
    await expect(tabs.first()).toBeVisible({ timeout: 30_000 });
    await expect(tabs.first()).toHaveText('echo');
  });

  test('loads through the path proxy into a cross-origin iframe', async ({ session }) => {
    // Assert on the network: the iframe is cross-origin, so its document is
    // unreachable from here and "unreachable" must not read as success.
    const response = session.waitForResponse(
      (r) => r.url().includes('/services/echo/') && r.request().method() === 'GET',
      { timeout: 30_000 }
    );
    await session.locator('#serviceTabs .tab').first().click();

    const res = await response;
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('real Opalix lab container');
  });

  test('sets a partitioned session cookie so the embed keeps it', async ({ session }) => {
    // The console asks for the cookie with a credentialed POST before it
    // points the iframe anywhere, so the cookie arrives on that response.
    const response = session.waitForResponse(
      (r) => r.url().includes('/services/echo/session') && r.request().method() === 'POST',
      { timeout: 30_000 }
    );
    await session.locator('#serviceTabs .tab').first().click();
    const res = await response;
    expect(res.status()).toBe(204);

    const setCookie = (await res.headerValue('set-cookie')) ?? '';
    // Third-party by construction: the console and the API are separate
    // origins, so without Partitioned the browser drops it.
    expect(setCookie).toContain('Partitioned');
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    // A credentialed cross-origin response is unreadable without these.
    expect(await res.headerValue('access-control-allow-credentials')).toBe('true');
    expect(await res.headerValue('access-control-allow-origin')).not.toBe('*');
  });

  test('keeps the session token out of the iframe URL and the open-in-new-tab link', async ({ session }) => {
    await session.locator('#serviceTabs .tab').first().click();
    const frame = session.locator('#serviceFrame');
    await expect(frame).toHaveAttribute('src', new RegExp(`^${API}/sessions/`));

    // When the browser refuses the cookie the console falls back to a
    // tokenised iframe URL by design; the link stays token-less regardless.
    const fallback = await session.locator('#servicePanel').getAttribute('data-cookie-fallback');
    test.info().annotations.push({ type: 'cookie-fallback', description: String(Boolean(fallback)) });
    await expect(session.locator('#serviceOpen')).toHaveAttribute('href', new RegExp(`^${API}/sessions/`));
    expect(await session.locator('#serviceOpen').getAttribute('href')).not.toContain('token=');
    if (fallback) {
      test.info().annotations.push({ type: 'note', description: 'iframe token assertion skipped: cookie fallback in use' });
    } else {
      expect(await frame.getAttribute('src')).not.toContain('token=');
    }
  });

  test('shows a service-down card instead of a broken iframe when the service answers 502', async ({ session, request }) => {
    test.skip(!SERVICE_KEY, 'needs OPALIX_KEY to push service.health into the session');
    const id = await sessionIdOf(session);

    // The real echo service is healthy; make the console see it as down.
    // Credentialed CORS needs the exact origin and Allow-Credentials.
    await session.route(/\/services\/echo\/(\?.*)?$/, async (route) => {
      const origin = route.request().headers()['origin'] ?? '';
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' },
        body: JSON.stringify({ error: { code: 'service_down', message: 'Service "echo" is currently unhealthy' } }),
      });
    });

    try {
      await emit(request, id, 'service.health', { service: 'echo', health: 'unhealthy', logs_tail: 'boom' });
      await expect(session.locator('#serviceTabs .tab[data-service="echo"] .svc-dot')).toHaveAttribute('data-health', 'unhealthy');

      await session.locator('#serviceTabs .tab').first().click();
      const down = session.locator('#serviceDown');
      await expect(down).toBeVisible({ timeout: 30_000 });
      await expect(down).toContainText('echo is not answering');
      await expect(down.getByRole('button', { name: 'Restart' })).toBeEnabled();
      await expect(down.getByRole('button', { name: 'Retry' })).toBeEnabled();
      await expect(session.locator('#serviceFrame')).toBeHidden();
      await expect(session.locator('#serviceLoading')).toBeHidden();

      // The log tail is collapsed until asked for.
      await down.locator('summary').click();
      await expect(down.locator('pre')).toContainText('boom');
    } finally {
      // The stream replays recent events to later pages; leave echo healthy.
      await emit(request, id, 'service.health', { service: 'echo', health: 'healthy' });
    }
  });

  test('lists every service with a restart that brings it back healthy', async ({ session }) => {
    // Tabs only cover ui: true services; this list is how a learner who
    // changed a service's config restarts it, since their shell can't.
    const row = session.locator('#serviceList li[data-service="echo"]');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.locator('.svc-health')).toHaveText('healthy');

    const restart = session.waitForResponse(
      (r) => r.url().includes('/services/echo/restart') && r.request().method() === 'POST',
      { timeout: 90_000 }
    );
    await row.getByRole('button', { name: 'Restart' }).click();
    await expect(row.getByRole('button')).toHaveText('Restarting…');
    const res = await restart;
    expect(res.status()).toBe(200);
    await expect(row.locator('.svc-health')).toHaveText('healthy');
    await expect(row.getByRole('button')).toHaveText('Restart');
  });
});
