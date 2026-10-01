import { test, expect, API, SERVICE_KEY, sessionIdOf } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Runs the checks from the header button and waits for the Checks tab to be
 * the one on screen.
 *
 * The header button is enabled as soon as the session is running, but the
 * guide (Brief / Checks / Hints tabs) is only built once the brief and the
 * learn bundle have been read. A run started before that has no Checks tab to
 * go to, and when the guide is built it lands on its first tab, Brief, over
 * the results -- so the rows exist but are hidden. Wait for the guide first,
 * as a learner does, then press the button and expect to be taken to Checks.
 */
async function runChecksFromHeader(page: Page): Promise<void> {
  await expect(page.locator('#guide[data-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await page.locator('#btnChecks').click();
  await expect(page.locator('#tabChecks')).toHaveAttribute('aria-selected', 'true');
}

test.describe('the checker', () => {
  test('runs and renders a result per criterion', async ({ session }) => {
    await runChecksFromHeader(session);
    await expect(session.locator('.check').first()).toBeVisible({ timeout: 60_000 });

    const row = await session.locator('.check').first().innerText();
    expect(row).toContain('greeting-file-exists');
  });

  test('marks a failing check with an icon and a reason, not colour alone', async ({ session }) => {
    // The session is shared and outlives a run, so an earlier run (or the pass
    // test below) may have left the graded file correct. Make it wrong first,
    // so the grader has something to fail.
    test.skip(!SERVICE_KEY, 'needs OPALIX_KEY to put the graded file in a failing state');
    const res = await fetch(`${API}/sessions/${await sessionIdOf(session)}/files/greeting.txt`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
      body: 'not the greeting',
    });
    expect(res.ok).toBe(true);
    await runChecksFromHeader(session);
    const first = session.locator('.check').first();
    await expect(first).toBeVisible({ timeout: 60_000 });

    // The graded file is wrong (set above), so the grader should say why.
    await expect(first).toHaveClass(/check-fail/);
    await expect(first.locator('.check-mark')).toHaveText('✗');
    expect(await first.locator('.check-msg').innerText()).toMatch(/greeting\.txt/);
  });

  test('reports the run in the checks block', async ({ session }) => {
    await runChecksFromHeader(session);
    // The raw event log is gone from the learner console; the stream's
    // check.finished refreshes the checks block, whose summary carries the
    // weighted score and the pass count.
    await expect(session.locator('#checksSummary')).toHaveText(/\d+\/\d+ checks/, { timeout: 60_000 });
    // The history sits in a closed <details>: its rows exist but are not
    // visible until the summary is opened, so open it and then look.
    await session.locator('details.check-history > summary').first().click();
    await expect(session.locator('details.check-history li').first()).toBeVisible();
  });

  // The lab asks the learner to create /workspace/greeting.txt, and the
  // console has no way to create a file — only to edit one that already
  // exists. So the file is written through the API here, which still
  // proves the thing worth proving: the grader reads the live container
  // and the console renders a pass. Creating files from the console is a
  // real gap, tracked separately.
  test('renders a pass once the graded file exists', async ({ session }) => {
    const key = process.env.OPALIX_KEY;
    test.skip(!key, 'needs OPALIX_KEY to create the graded file the console cannot');

    const sessionId = await session.locator('#sessionId').textContent();
    const res = await fetch(`${API}/sessions/${sessionId}/files/greeting.txt`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${key}` },
      body: 'hello from opalix',
    });
    expect(res.ok).toBe(true);

    await runChecksFromHeader(session);
    await expect(session.locator('.check-pass').first()).toBeVisible({ timeout: 60_000 });
    await expect(session.locator('.check-pass .check-mark').first()).toHaveText('✓');
  });
});
