import { test, expect, API } from './fixtures';

test.describe('the checker', () => {
  test('runs and renders a result per criterion', async ({ session }) => {
    await session.locator('#btnChecks').click();
    await expect(session.locator('.check').first()).toBeVisible({ timeout: 60_000 });

    const row = await session.locator('.check').first().innerText();
    expect(row).toContain('greeting-file-exists');
  });

  test('marks a failing check with an icon and a reason, not colour alone', async ({ session }) => {
    await session.locator('#btnChecks').click();
    const first = session.locator('.check').first();
    await expect(first).toBeVisible({ timeout: 60_000 });

    // The lab is unsolved in this run, so the grader should say why.
    await expect(first).toHaveClass(/check-fail/);
    await expect(first.locator('.check-mark')).toHaveText('✗');
    expect(await first.locator('.check-msg').innerText()).toMatch(/greeting\.txt/);
  });

  test('reports the run on the event stream', async ({ session }) => {
    await session.locator('#btnChecks').click();
    await expect(session.locator('#eventList li', { hasText: 'check.finished' }).first()).toBeVisible({
      timeout: 60_000,
    });
    const summary = await session.locator('#eventList li', { hasText: 'check.finished' }).first().innerText();
    expect(summary).toMatch(/\d+\/\d+ passed/);
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

    await session.locator('#btnChecks').click();
    await expect(session.locator('.check-pass').first()).toBeVisible({ timeout: 60_000 });
    await expect(session.locator('.check-pass .check-mark').first()).toHaveText('✓');
  });
});
