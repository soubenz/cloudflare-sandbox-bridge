import { test, expect, signIn } from './fixtures';

/**
 * The launcher's structure: groups, prerequisites, filters, the first-run
 * dialog, the header's theme toggle and the footer. Nothing here starts a
 * lab, so the catalogue is stubbed where a spec needs particular labs; the
 * console's own Worker still serves the page, and signs it in.
 */

const lab = (o: Record<string, unknown>) => ({
  version: '1.0.0',
  type: 'build',
  family: 'agent',
  summary: `About ${o.slug}`,
  objectives: ['do the thing'],
  difficulty: 'intro',
  timeout_minutes: 30,
  progress: null,
  ...o,
});

async function stubLabs(page: import('@playwright/test').Page, labs: unknown[]) {
  await page.route('**/api/labs', (route) => route.fulfill({ json: labs }));
}

/** A signed-in page that has already read the first-run dialog, on the launcher. */
async function openLauncher(page: import('@playwright/test').Page, { onboarded = true } = {}) {
  await signIn(page);
  if (onboarded) await page.addInitScript(() => localStorage.setItem('opalixOnboarded', '1'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]', { timeout: 60_000 });
}

test.describe('launcher groups', () => {
  test('groups labs into sections, each headed by an h2', async ({ page }) => {
    await stubLabs(page, [
      lab({ slug: 'b', title: 'B lab', path: 'foundations', module: 2, order: 1 }),
      lab({ slug: 'a', title: 'A lab', path: 'foundations', module: 1, order: 1 }),
      lab({ slug: 'c', title: 'C lab' }),
    ]);
    await openLauncher(page);
    const groups = page.locator('.lab-group');
    await expect(groups).toHaveCount(3);
    // Modules in order, then the labs that have no path under "All labs".
    await expect(groups.nth(0)).toHaveAttribute('data-module', '1');
    await expect(groups.nth(1)).toHaveAttribute('data-module', '2');
    await expect(groups.nth(2).locator('h2.group-head')).toContainText('All labs');
    await expect(groups.nth(0).locator('h2.group-head')).toContainText('0/1 done');
    await expect(groups.nth(0).locator('.progress')).toBeVisible();
  });

  test('locks a lab whose prerequisite has not been passed', async ({ page }) => {
    await stubLabs(page, [
      lab({ slug: 'a', title: 'First lab', path: 'p', module: 1, order: 1 }),
      lab({ slug: 'b', title: 'Second lab', path: 'p', module: 1, order: 2, prerequisites: ['a'] }),
    ]);
    await openLauncher(page);
    const start = page.locator('.lab[data-slug="b"] button.lab-start');
    await expect(start).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('.lab[data-slug="b"]')).toContainText(/Locked until First lab passes/);
    await expect(start).toHaveAttribute('title', /Locked until/);
    await expect(page.locator('.lab[data-slug="a"] button.lab-start')).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('unlocks it once the prerequisite is passed, and marks that one done', async ({ page }) => {
    await stubLabs(page, [
      lab({ slug: 'a', title: 'First lab', path: 'p', module: 1, order: 1, progress: { attempts: 2, best_score: 1, passed_all: true, last_run_at: 1 } }),
      lab({ slug: 'b', title: 'Second lab', path: 'p', module: 1, order: 2, prerequisites: ['a'] }),
    ]);
    await openLauncher(page);
    await expect(page.locator('.lab[data-slug="b"] button.lab-start')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('.lab[data-slug="a"]')).toHaveClass(/lab-done/);
    await expect(page.locator('.lab[data-slug="a"] .chip-done')).toHaveText('Done · best 100%');
    await expect(page.locator('.lab-group h2.group-head')).toContainText('1/2 done');
  });

  test('the search box hides labs that do not match and updates the count', async ({ page }) => {
    await stubLabs(page, [
      lab({ slug: 'gateway-hello', title: 'Gateway hello', family: 'gateway' }),
      lab({ slug: 'hello', title: 'Hello, sandbox' }),
      lab({ slug: 'agent-tools', title: 'Agent tools' }),
    ]);
    await openLauncher(page);
    await expect(page.locator('#labCount')).toHaveText('3 of 3 labs');
    await page.locator('#labSearch').fill('gateway');
    await expect(page.locator('.lab[data-slug="gateway-hello"]')).toBeVisible();
    await expect(page.locator('.lab[data-slug="hello"]')).toBeHidden();
    await expect(page.locator('.lab[data-slug="agent-tools"]')).toBeHidden();
    await expect(page.locator('#labCount')).toHaveText('1 of 3 labs');
  });

  test('filter chips are toggle buttons and are remembered', async ({ page }) => {
    await stubLabs(page, [
      lab({ slug: 'one', title: 'One', difficulty: 'intro' }),
      lab({ slug: 'two', title: 'Two', difficulty: 'advanced' }),
    ]);
    await openLauncher(page);
    const advanced = page.locator('button.filter-chip[data-value="advanced"]');
    await expect(advanced).toHaveAttribute('aria-pressed', 'false');
    await advanced.click();
    await expect(advanced).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.lab[data-slug="one"]')).toBeHidden();
    await expect(page.locator('#labCount')).toHaveText('1 of 2 labs');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('button.filter-chip[data-value="advanced"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.lab[data-slug="one"]')).toBeHidden();
  });
});

test.describe('first run, header and footer', () => {
  test('a first visit opens the onboarding dialog once', async ({ page }) => {
    await stubLabs(page, [lab({ slug: 'hello', title: 'Hello, sandbox' })]);
    await openLauncher(page, { onboarded: false });
    await expect(page.locator('dialog#onboarding[open]')).toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click();
    await expect(page.locator('dialog#onboarding[open]')).toHaveCount(0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('dialog#onboarding[open]')).toHaveCount(0);

    // The header "?" brings it back.
    await page.locator('#btnHelp').click();
    await expect(page.locator('dialog#onboarding[open]')).toBeVisible();
  });

  test('the theme toggle puts data-theme on <html>', async ({ page }) => {
    await stubLabs(page, [lab({ slug: 'hello', title: 'Hello, sandbox' })]);
    await openLauncher(page);
    const html = page.locator('html');
    await page.locator('#btnTheme').click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.locator('#btnTheme').click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.locator('#btnTheme').click();
    await expect(html).not.toHaveAttribute('data-theme', /.*/);
    await page.locator('#btnTheme').click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('#btnTheme')).toHaveAttribute('aria-label', /Theme: light/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(html).toHaveAttribute('data-theme', 'light');
  });

  test('the header names who is signed in', async ({ page }) => {
    await stubLabs(page, [lab({ slug: 'hello', title: 'Hello, sandbox' })]);
    await openLauncher(page);
    await expect(page.locator('#identityName')).toHaveText('console');
    await expect(page.locator('#btnSignOut')).toBeVisible();
  });

  test('the footer links to Status and Feedback, and there is no operator button', async ({ page }) => {
    await stubLabs(page, [lab({ slug: 'hello', title: 'Hello, sandbox' })]);
    await openLauncher(page);
    const status = page.locator('.footer a', { hasText: 'Status' });
    const feedback = page.locator('.footer a', { hasText: 'Feedback' });
    await expect(status).toHaveAttribute('href', /\/status$/);
    await expect(feedback).toHaveAttribute('href', /\/feedback$/);
    await expect(status).toHaveAttribute('rel', /noopener/);
    await expect(feedback).toHaveAttribute('rel', /noopener/);
    await expect(page.locator('#btnOps')).toHaveCount(0);
    await expect(page.locator('#ops')).toHaveCount(0);
  });
});
