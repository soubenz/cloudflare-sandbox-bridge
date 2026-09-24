import { test, expect, API } from './fixtures';

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
    const response = session.waitForResponse((r) => r.url().includes('/services/echo/'), { timeout: 30_000 });
    await session.locator('#serviceTabs .tab').first().click();
    const res = await response;

    const setCookie = (await res.headerValue('set-cookie')) ?? '';
    // Third-party by construction: the console and the API are separate
    // origins, so without Partitioned the browser drops it.
    expect(setCookie).toContain('Partitioned');
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Secure');
  });

  test('points the iframe at the API, not the console', async ({ session }) => {
    await session.locator('#serviceTabs .tab').first().click();
    await expect(session.locator('#serviceFrame')).toHaveAttribute('src', new RegExp(`^${API}/sessions/`));
  });
});
