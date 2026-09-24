import { test, expect, consoleErrorsFor, upgradeHeaderStripped } from './fixtures';

test.describe('the terminal', () => {
  test('attaches and echoes what the learner types', async ({ session }) => {
    await session.locator('.tab[data-view="terminal"]').click();
    await expect(session.locator('.xterm-screen')).toBeVisible({ timeout: 30_000 });

    // Let the shell draw its prompt before typing, or the first keystrokes
    // land before the PTY is listening.
    await session.waitForTimeout(2500);
    await session.locator('.xterm-screen').click();
    await session.keyboard.type('echo playwright-terminal-ok');
    await session.keyboard.press('Enter');

    const echoed = await session
      .waitForFunction(
        () => document.querySelector('.xterm-screen')?.textContent?.includes('playwright-terminal-ok'),
        null,
        { timeout: 30_000 }
      )
      .then(() => true)
      .catch(() => false);

    // Only skip on the specific evidence of a stripped handshake: a
    // genuinely broken terminal must still fail.
    test.skip(
      !echoed && upgradeHeaderStripped(consoleErrorsFor(session)),
      'the network between here and the API strips the WebSocket Upgrade header'
    );
    expect(echoed).toBe(true);
  });

  test('renders an xterm viewport sized to its pane', async ({ session }) => {
    await session.locator('.tab[data-view="terminal"]').click();
    const screen = session.locator('.xterm-screen');
    await expect(screen).toBeVisible({ timeout: 30_000 });

    const box = await screen.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(200);
    expect(box?.height ?? 0).toBeGreaterThan(100);
  });
});
