import { test, expect, emit, fulfillCors, patchStatus, sessionIdOf, SERVICE_KEY, API } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * The Solution block and the "Compare with my work" dialog.
 *
 * What the API says about the solution is faked at both ends: the `solution`
 * field of the status the console polls is rewritten (`patchStatus`), and
 * `GET /sessions/:id/solution` is answered here. The learner's own files are
 * NOT faked: the dialog reads them through the real files route, so the
 * comparison is against the real hello workspace. Two paths are chosen for
 * that. `brief.md` ships with every lab and is never written by another
 * spec, so a solution that differs from it shows `-` lines (yours) and a `+`
 * line (the solution's). A path with a timestamp in it cannot exist, so it
 * reads as an empty file and every line of the solution is a `+`.
 *
 * Nothing here needs the API to serve `/solution` yet: the route is mocked,
 * so only a running session (and `OPALIX_KEY`, for the one event test) is used.
 */

const RULE = 'Unlocks after 2 check runs, or once every hint has been used.';

const lockedSolution = (progress: Record<string, unknown> = {}) => ({
  available: true,
  unlocked: false,
  rule: RULE,
  progress: { check_runs: 1, hints_delivered: 2, hints_total: 3, completed: false, ...progress },
});
const unlockedSolution = () => ({
  available: true,
  unlocked: true,
  rule: RULE,
  progress: { check_runs: 2, hints_delivered: 2, hints_total: 3, completed: false },
});

/** Never exists in a workspace, so the learner's side of it is empty. */
const NEW_FILE = `e2e-solution-${Date.now()}.txt`;
const NEW_CONTENT = 'alpha\nbeta\ngamma\n';
const BRIEF_SOLUTION = 'SOLUTION-ONLY-LINE\n';

/** Serves `solution` as the status's `solution` field, and lets a test change it. */
async function serveSolutionStatus(page: Page, initial: unknown) {
  const current = { value: initial as Record<string, unknown> | undefined };
  await patchStatus(page, (body) => {
    if (current.value === undefined) delete body.solution;
    else body.solution = current.value;
  });
  return current;
}

/** Reload so the console reads the status again, then wait for it to settle. */
async function reloadConsole(page: Page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]', { timeout: 60_000 });
  await expect(page.locator('#statePill')).toHaveText('running', { timeout: 60_000 });
}

/** Answers `/solution` with these files, with the CORS headers the console's origin needs. */
async function serveSolution(page: Page, files: Array<{ path: string; content: string }>, truncated = false) {
  await page.route('**/sessions/*/solution', (route) => fulfillCors(route, 200, { files, truncated }));
}

/** The learner's brief.md exactly as the container holds it. */
async function readBrief(page: Page): Promise<string> {
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('opalix.session') ?? '{}'));
  const res = await page.request.get(`${API}/sessions/${saved.id}/files/brief.md`, {
    headers: { Authorization: `Bearer ${saved.token}` },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).content as string;
}

test.describe('solution reveal', () => {
  test('shows nothing when the API has no solution to offer', async ({ session }) => {
    const status = await serveSolutionStatus(session, undefined);
    await reloadConsole(session);
    await expect(session.locator('#hintsPanel')).toBeVisible();
    await expect(session.locator('#solutionBlock')).toBeHidden();

    status.value = { ...unlockedSolution(), available: false };
    await reloadConsole(session);
    await expect(session.locator('#solutionBlock')).toBeHidden();
  });

  test('says what unlocks it and how far along the learner is, with no way to reveal it early', async ({ session }) => {
    await serveSolutionStatus(session, lockedSolution());
    await reloadConsole(session);

    const block = session.locator('#solutionBlock');
    await expect(block).toBeVisible();
    await expect(block.getByRole('heading', { name: 'Solution' })).toBeVisible();
    await expect(block).toContainText(RULE);
    await expect(session.locator('#solutionProgress')).toHaveText('Checks run 1 · Hints used 2 of 3');
    await expect(block.locator('.solution-lock')).toBeVisible();
    // The absence of a reveal-anyway button is intended.
    await expect(block.locator('#btnSolutionOpen')).toBeHidden();
    await expect(block.getByRole('button')).toHaveCount(0);
    await expect(session.locator('#solutionReady')).toBeHidden();
  });

  test('treats a completed lab as unlocked', async ({ session }) => {
    await serveSolutionStatus(session, lockedSolution({ completed: true }));
    await reloadConsole(session);
    await expect(session.locator('#btnSolutionOpen')).toBeVisible();
  });

  test('offers the comparison once unlocked, and shows +/- lines with their glyphs', async ({ session }) => {
    await serveSolutionStatus(session, unlockedSolution());
    await serveSolution(
      session,
      [
        { path: 'brief.md', content: BRIEF_SOLUTION },
        { path: NEW_FILE, content: NEW_CONTENT },
      ],
      true
    );
    await reloadConsole(session);

    const block = session.locator('#solutionBlock');
    await expect(block).toContainText('The solution is available');
    const open = session.locator('#btnSolutionOpen');
    await expect(open).toHaveText('Compare with my work');
    await expect(session.locator('#solutionLocked')).toBeHidden();

    await open.click();
    const dialog = session.locator('#solutionDialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-labelledby', 'solutionDialogTitle');
    await expect(dialog.getByRole('heading', { name: 'Compare with the solution' })).toBeVisible();

    // Both files are listed, and the brief (which the learner has) is the first that differs.
    const files = dialog.locator('#solutionFiles .sol-file');
    await expect(files).toHaveCount(2);
    await expect(files.nth(0)).toContainText('brief.md');
    await expect(files.nth(1)).toContainText(NEW_FILE);
    await expect(files.nth(1)).toContainText('not in your work');
    await expect(dialog.locator('#solutionPath')).toHaveText('brief.md');
    await expect(dialog.locator('#solutionTruncated')).toHaveText('Some files were left out because they are large.');

    // Yours out, the solution's in: every learner line is a `-`, the one solution line a `+`.
    const added = dialog.locator('#solutionDiff .dl-add');
    const removed = dialog.locator('#solutionDiff .dl-del');
    await expect(added).toHaveCount(1);
    await expect(added.first().locator('.dl-sign')).toHaveText('+');
    await expect(added.first().locator('.dl-text')).toHaveText('SOLUTION-ONLY-LINE');
    expect(await removed.count()).toBeGreaterThan(0);
    await expect(removed.first().locator('.dl-sign')).toHaveText('-');
    // Line numbers: a deleted line has yours, an added one the solution's.
    await expect(added.first().locator('.dl-n').nth(1)).toHaveText('1');
    await expect(removed.first().locator('.dl-n').first()).toHaveText('1');
    await expect(dialog.locator('#solutionCounts')).toHaveText(new RegExp(`^\\+1 -${await removed.count()}$`));

    // A file the learner does not have: all of it is added, and it says so.
    await files.nth(1).click();
    await expect(dialog.locator('#solutionPath')).toHaveText(NEW_FILE);
    await expect(dialog.locator('#solutionDiff .dl-add')).toHaveCount(3);
    await expect(dialog.locator('#solutionDiff .dl-del')).toHaveCount(0);
    await expect(dialog.locator('#solutionDiff .dl-add .dl-sign')).toHaveText(['+', '+', '+']);
    await expect(dialog.locator('#solutionDiff .dl-text')).toHaveText(['alpha', 'beta', 'gamma']);
    await expect(dialog.locator('#solutionFileNote')).toHaveText('This file is not in your workspace yet.');

    // Read-only: nothing here edits, applies or saves.
    await expect(dialog.locator('textarea, input, [contenteditable="true"], .cm-content')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /apply|edit|save|replace/i })).toHaveCount(0);

    // The diff pane scrolls sideways itself; the page does not.
    const overflow = await session.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    // Escape closes it and focus goes back to the button that opened it.
    await session.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
  });

  test('marks a file that already matches, and copies the solution file', async ({ session, context }) => {
    const brief = await readBrief(session);
    await serveSolutionStatus(session, unlockedSolution());
    await serveSolution(session, [
      { path: 'brief.md', content: brief },
      { path: NEW_FILE, content: NEW_CONTENT },
    ]);
    await reloadConsole(session);

    await session.locator('#btnSolutionOpen').click();
    const dialog = session.locator('#solutionDialog');
    const files = dialog.locator('#solutionFiles .sol-file');
    await expect(files).toHaveCount(2);
    await expect(files.nth(0)).toContainText('matches');
    await expect(files.nth(1)).not.toContainText('matches');
    // The file that differs is the one opened first.
    await expect(dialog.locator('#solutionPath')).toHaveText(NEW_FILE);
    await expect(dialog.locator('#solutionTruncated')).toBeHidden();

    await files.nth(0).click();
    await expect(dialog.locator('#solutionFileNote')).toHaveText('Your file matches the solution.');
    await expect(dialog.locator('#solutionDiff .dl-add, #solutionDiff .dl-del')).toHaveCount(0);
    // Unchanged text is collapsed, not listed line by line, whatever its length.
    await expect(dialog.locator('#solutionDiff .dl-gap')).toHaveCount(0);

    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await files.nth(1).click();
    await dialog.getByRole('button', { name: 'Copy solution file' }).click();
    await expect(dialog.locator('#solutionCopyNote')).toContainText(`Copied ${NEW_FILE}`);
    expect(await session.evaluate(() => navigator.clipboard.readText())).toBe(NEW_CONTENT);

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await expect(session.locator('#btnSolutionOpen')).toBeFocused();
  });

  test('folds long unchanged stretches down to three lines of context', async ({ session }) => {
    // The learner's brief with one line in the middle changed: everything
    // around it is unchanged and must fold.
    const brief = await readBrief(session);
    const lines = brief.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    test.skip(lines.length < 12, 'the brief is too short to fold');
    const changed = [...lines];
    changed[Math.floor(lines.length / 2)] = 'THE ONE CHANGED LINE';
    await serveSolutionStatus(session, unlockedSolution());
    await serveSolution(session, [{ path: 'brief.md', content: changed.join('\n') + '\n' }]);
    await reloadConsole(session);

    await session.locator('#btnSolutionOpen').click();
    const dialog = session.locator('#solutionDialog');
    await expect(dialog.locator('#solutionDiff .dl-add')).toHaveText(/THE ONE CHANGED LINE/);
    const gaps = dialog.locator('#solutionDiff .dl-gap');
    expect(await gaps.count()).toBeGreaterThan(0);
    await expect(gaps.first()).toHaveText(/^… \d+ unchanged lines? …$/);
    // At most three unchanged lines sit beside the change on each side.
    const context = await dialog.locator('#solutionDiff .dl-same').count();
    expect(context).toBeLessThanOrEqual(6);
    expect(context).toBeGreaterThan(0);
  });

  test('re-renders as locked when the API says it still is', async ({ session }) => {
    const status = await serveSolutionStatus(session, unlockedSolution());
    await session.route('**/sessions/*/solution', (route) => {
      // What the API would now say about the status too.
      status.value = lockedSolution({ check_runs: 0, hints_delivered: 1 });
      return fulfillCors(route, 403, {
        error: {
          code: 'solution_locked',
          message: 'The solution is locked',
          details: { rule: RULE, progress: { check_runs: 0, hints_delivered: 1, hints_total: 3, completed: false } },
        },
      });
    });
    await reloadConsole(session);

    await session.locator('#btnSolutionOpen').click();
    const dialog = session.locator('#solutionDialog');
    await expect(dialog.locator('#solutionStatus')).toContainText('The solution is still locked');
    await expect(dialog.locator('#solutionStatus')).toContainText(RULE);
    await expect(dialog.locator('#solutionStatus')).toContainText('Checks run 0 · Hints used 1 of 3');
    await expect(dialog.locator('#solutionBody')).toBeHidden();
    await expect(dialog.locator('#btnSolutionCopy')).toBeDisabled();

    // The block behind it is locked again, with the progress the API sent.
    await session.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(session.locator('#solutionProgress')).toHaveText('Checks run 0 · Hints used 1 of 3');
    await expect(session.locator('#solutionReady')).toBeHidden();
    await expect(session.locator('#solutionBlock').getByRole('button')).toHaveCount(0);
  });

  test('says so when it cannot load the solution, and Retry tries again', async ({ session }) => {
    await serveSolutionStatus(session, unlockedSolution());
    let calls = 0;
    await session.route('**/sessions/*/solution', (route) => {
      calls++;
      if (calls === 1) return fulfillCors(route, 500, { error: { code: 'internal', message: 'the store is down' } });
      return fulfillCors(route, 200, { files: [{ path: NEW_FILE, content: NEW_CONTENT }], truncated: false });
    });
    await reloadConsole(session);

    await session.locator('#btnSolutionOpen').click();
    const dialog = session.locator('#solutionDialog');
    await expect(dialog.locator('#solutionStatus')).toContainText('Could not load the solution');
    await expect(dialog.locator('#solutionStatus')).toContainText('the store is down');
    const retry = dialog.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();

    await retry.click();
    await expect(dialog.locator('#solutionDiff .dl-add')).toHaveCount(3);
    await expect(dialog.locator('#solutionStatus')).toBeHidden();
    await expect(retry).toBeHidden();
    expect(calls).toBe(2);
  });

  test('shows a loading line while the solution is on its way', async ({ session }) => {
    await serveSolutionStatus(session, unlockedSolution());
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await session.route('**/sessions/*/solution', async (route) => {
      await gate;
      await fulfillCors(route, 200, { files: [{ path: NEW_FILE, content: NEW_CONTENT }], truncated: false });
    });
    await reloadConsole(session);

    await session.locator('#btnSolutionOpen').click();
    await expect(session.locator('#solutionStatusText')).toHaveText('Loading the solution…');
    release();
    await expect(session.locator('#solutionDiff .dl-add')).toHaveCount(3);
  });

  test('announces the unlock as a notice and opens the block', async ({ session }) => {
    test.skip(!SERVICE_KEY, 'needs OPALIX_KEY to push events into the session');
    const status = await serveSolutionStatus(session, lockedSolution());
    await reloadConsole(session);
    await expect(session.locator('#btnSolutionOpen')).toBeHidden();

    // The status the console re-reads after the event agrees with it.
    status.value = unlockedSolution();
    await emit(session.request, await sessionIdOf(session), 'solution.unlocked', {});

    const notice = session.locator('#noticeList li', { hasText: 'The solution is now available' });
    await expect(notice.first()).toBeVisible({ timeout: 30_000 });
    await expect(notice.first()).toHaveClass(/ev-good/);
    await expect(session.locator('#btnSolutionOpen')).toBeVisible();
    await expect(session.locator('#solutionBlock')).toContainText('The solution is available');
  });
});
