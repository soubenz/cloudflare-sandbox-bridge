import { test as base, expect, type Page } from '@playwright/test';

export const API = process.env.OPALIX_URL || 'https://opalix-sandbox.soubenz94.workers.dev';

/**
 * A running lab session, shared by every spec in the run.
 *
 * Sessions are real containers, so the suite pays for exactly one. The
 * first spec to ask for it starts a lab; the rest land on the same session
 * because the API's dev start route rejoins the caller's live session
 * rather than refusing a second one. That makes the fixture cheap and
 * incidentally exercises rejoin on every file.
 *
 * The session is torn down by zz-teardown.spec.ts, which ends it through
 * the UI — cleanup and a test of the end-session flow in one, so a leaked
 * container cannot outlive the run silently.
 */
type Fixtures = {
  /** The console, with a session running and the workspace on screen. */
  session: Page;
};

export const test = base.extend<Fixtures>({
  session: async ({ page }, use) => {
    consoleErrorsByPage.set(page, collectConsoleErrors(page));
    socketErrorsByPage.set(page, collectSocketErrors(page));
    await openConsole(page);
    await startOrResume(page);
    await use(page);
  },
});

/** WebSocket handshake failures, which never reach the console log. */
const socketErrorsByPage = new WeakMap<Page, string[]>();

function collectSocketErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('websocket', (ws) => {
    ws.on('socketerror', (err) => errors.push(`${ws.url()} :: ${err}`));
  });
  return errors;
}

export function socketErrorsFor(page: Page): string[] {
  return socketErrorsByPage.get(page) ?? [];
}

/**
 * Console errors are collected from before the first navigation, because
 * the interesting ones (a refused WebSocket) happen while the session is
 * starting — attaching a listener inside a test misses them.
 */
const consoleErrorsByPage = new WeakMap<Page, string[]>();

export function consoleErrorsFor(page: Page): string[] {
  return consoleErrorsByPage.get(page) ?? [];
}

/**
 * Loads the console, points it at the API under test, and carries over the
 * session this run has already started so every spec lands in the same
 * container. Playwright gives each test a fresh context, so the console's
 * own localStorage does not survive between them — the id and token are
 * held here and re-seeded.
 */
export async function openConsole(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ([api, session]) => {
      localStorage.setItem('opalix.apiBase', api as string);
      if (session) localStorage.setItem('opalix.session', session as string);
    },
    [API, sharedSession] as const
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  // The console decides between resuming a session and showing the picker
  // asynchronously. Waiting for that decision keeps every spec from racing
  // it — and a spec that raced it is how the operator panel was found
  // being slammed shut by a late resume.
  await page.waitForSelector('body[data-booted="1"]', { timeout: 60_000 });
}

/** The session every spec shares, as the console stores it. */
let sharedSession: string | null = null;

export function clearSharedSession(): void {
  sharedSession = null;
}

/**
 * Resumes the run's session if the console already has one, and otherwise
 * starts the `hello` lab. Exactly one container is created per run: a
 * session is real money, and the API fences how many can be live at once.
 */
export async function startOrResume(page: Page): Promise<string> {
  // openConsole already waited for the boot decision, so this reads the
  // settled state rather than guessing at it with a timeout — guessing is
  // what made a slow resume start a second container.
  const resumed = await page.locator('#workspace').isVisible();

  if (!resumed) {
    await page.waitForSelector('.lab', { timeout: 30_000 });
    await page.locator('.lab', { hasText: 'hello' }).first().locator('button').click();
    await page.waitForSelector('#workspace:not([hidden])', { timeout: 30_000 });
  }

  await expect(page.locator('#statePill')).toHaveText('running', { timeout: 120_000 });
  sharedSession = await page.evaluate(() => localStorage.getItem('opalix.session'));
  return (await page.locator('#sessionId').textContent()) ?? '';
}

/**
 * True when the network between here and the API strips the WebSocket
 * handshake headers. `Upgrade` and `Connection` are hop-by-hop, so a proxy
 * that re-issues rather than tunnels the request drops them and the Worker
 * then refuses to return a WebSocket at all. That is a property of the
 * network, not of the console, so terminal specs skip rather than fail —
 * but only on that specific evidence, so a genuinely broken terminal still
 * reports as broken.
 */
export function upgradeHeaderStripped(errors: string[]): boolean {
  // The Worker answers a handshake it cannot upgrade with a 500 carrying
  // "did not contain the header Upgrade: websocket". Any other failure —
  // a 4xx, a close, a timeout — is not this, and must still fail the test.
  return errors.some((e) => /Unexpected response code: 500/.test(e));
}

/** Collects browser console errors for the life of a page. */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

export { expect };
