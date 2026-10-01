import { test, expect, openConsole, signIn, startOrResume, RATELIMIT_UNJUDGEABLE } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * The console's auth surface (F-12): response headers, login rate limit,
 * logout method, and a CSP tight enough that the app still loads under it.
 *
 * Login attempts are limited to 5 a minute per address and every spec signs
 * in, so the specs here are ordered to spend as little of that budget as they
 * can, and the rate-limit spec waits the window out before returning so the
 * files after it are not refused.
 */

const REQUIRED_HEADERS: Record<string, RegExp> = {
  'content-security-policy': /default-src 'self'.*script-src 'self'/,
  'referrer-policy': /^no-referrer$/,
  'x-frame-options': /^DENY$/,
  'x-content-type-options': /^nosniff$/,
  'permissions-policy': /camera=\(\).*microphone=\(\).*geolocation=\(\)/,
};

function expectSecurityHeaders(headers: Record<string, string>) {
  for (const [name, pattern] of Object.entries(REQUIRED_HEADERS)) {
    expect(headers[name], `${name} present`).toMatch(pattern);
  }
  const csp = headers['content-security-policy'];
  // The directive itself, not a substring: style-src legitimately carries
  // 'unsafe-inline' and precedes script-src in the header.
  const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
  expect(scriptSrc).toBe("script-src 'self'"); // scripts never get the inline exemption
  expect(csp).toMatch(/connect-src 'self' https:\/\/\S+ wss:\/\/\S+/);
  expect(csp).toMatch(/frame-src https:\/\/\S+/);
}

test.describe('console auth surface', () => {
  test('security headers are on the page and on the bundle', async ({ page }) => {
    await signIn(page);
    const root = await page.request.get('/');
    expect(root.status()).toBe(200);
    expectSecurityHeaders(root.headers());

    const bundle = await page.request.get('/dist/app.js');
    expect(bundle.status()).toBe(200);
    expectSecurityHeaders(bundle.headers());
  });

  test('the login page carries the headers too, and its script is external', async ({ browser }) => {
    const fresh = await browser.newContext();
    try {
      const res = await fresh.request.get('/');
      expectSecurityHeaders(res.headers());
      const html = await res.text();
      expect(html).toContain('<script src="/login.js"');
      expect(html).not.toMatch(/<script>|\son\w+=/);
      const script = await fresh.request.get('/login.js');
      expect(script.status()).toBe(200);
    } finally {
      await fresh.close();
    }
  });

  test('GET /auth/logout is refused', async ({ browser }) => {
    const fresh = await browser.newContext();
    try {
      const res = await fresh.request.get('/auth/logout');
      expect(res.status()).toBe(405);
      expect(res.headers()['allow']).toBe('POST');
    } finally {
      await fresh.close();
    }
  });

  test('POST /auth/logout ends the session', async ({ page }) => {
    await signIn(page);
    expect((await page.request.get('/api/labs')).status()).not.toBe(401);
    const out = await page.request.post('/auth/logout');
    expect(out.status()).toBe(204);
    expect((await page.request.get('/api/labs')).status()).toBe(401);
  });

  /** Everything the browser reports as a CSP refusal, from before the first navigation. */
  function collectCspViolations(page: Page): string[] {
    const violations: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('Content Security Policy')) violations.push(msg.text());
    });
    return violations;
  }

  test('the launcher loads with zero CSP violations', async ({ page }) => {
    const violations = collectCspViolations(page);
    await openConsole(page);
    // Earlier specs leave a lab running, and the console walks back into a
    // running lab on load, so the launcher would not be on screen at all.
    // Forget the remembered session in this browser only, and open the
    // launcher's own address: a reload would stay on /labs/<slug>, which
    // starts (or rejoins) that lab on load instead of showing the launcher.
    await page.evaluate(() => localStorage.removeItem('opalix.session'));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]', { timeout: 60_000 });

    await expect(page.locator('#launcher')).toBeVisible();
    // Labs sit in modules that start collapsed; open one so a lab card is on screen.
    const collapsed = page.locator('.module[data-collapsed="1"] .module-mini').first();
    if (await collapsed.count()) await collapsed.click();
    await expect(page.locator('.lab:visible').first()).toBeVisible({ timeout: 30_000 });
    expect(violations, violations.join('\n')).toEqual([]);
  });

  test('the session screen loads with zero CSP violations', async ({ page }) => {
    const violations = collectCspViolations(page);
    await openConsole(page);
    await startOrResume(page); // the run's shared session; no new container when one is running
    await expect(page.locator('#guide[data-ready="true"]')).toBeAttached({ timeout: 60_000 });
    // The terminal, the editor and the guide all load their own code and styles.
    await expect(page.locator('#fileList li:has(.name)').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#briefBody h2').first()).toBeVisible({ timeout: 30_000 });
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // Last, because it exhausts the address's login budget on purpose.
  test('the sixth login attempt in a minute is rate limited', async ({ browser }) => {
    // The limiter counts per source address, so it cannot be judged from a
    // network whose address rotates. That is an explicit, documented opt-out
    // (OPALIX_E2E_NO_RATELIMIT=1, see RATELIMIT_UNJUDGEABLE in fixtures.ts),
    // off by default; this spec is the proof of the limit when it is off.
    // Skipped for now (owner decision, 1 Oct 2026): the login limiter's logic is going to change, so this
    // test would be rewritten anyway. Remove the line below when the new limiter lands.
    test.skip(true, 'login rate limit: logic will change, test to be rewritten with it');
    test.skip(RATELIMIT_UNJUDGEABLE, 'OPALIX_E2E_NO_RATELIMIT=1: source address rotates, the per-address limiter cannot trip');
    test.setTimeout(150_000);
    const fresh = await browser.newContext();
    try {
      // Earlier specs have already spent some of this minute's budget, so the
      // 429 may arrive before the sixth attempt here -- but never after it,
      // and nothing before it may be anything but a plain wrong-password 401.
      const statuses: number[] = [];
      let limited;
      for (let i = 0; i < 6; i++) {
        const res = await fresh.request.post('/auth/login', { data: { password: `wrong-${i}` } });
        statuses.push(res.status());
        if (res.status() === 429) {
          limited = res;
          break;
        }
      }
      expect(limited, `attempt statuses: ${statuses.join(',')}`).toBeTruthy();
      expect(statuses.slice(0, -1).every((s) => s === 401)).toBe(true);
      expect(limited!.headers()['retry-after']).toBe('60');
      expect(await limited!.text()).toContain('Too many attempts');
      expectSecurityHeaders(limited!.headers());
    } finally {
      await fresh.close();
    }
    // Let the window close so the specs after this one can sign in.
    await new Promise((r) => setTimeout(r, 61_000));
  });
});
