import { test, expect } from './fixtures';

test.describe('the workspace', () => {
  test('lists the lab files with sizes', async ({ session }) => {
    const files = session.locator('#fileList li');
    await expect(files.first()).toBeVisible({ timeout: 30_000 });
    const names = await session.locator('#fileList .name').allTextContents();
    expect(names.join(' ')).toContain('README.md');
    // A regular file reports a size; only directories are blank.
    expect(await session.locator('#fileList .size').first().textContent()).toMatch(/\d/);
  });

  test('opens a file into the editor', async ({ session }) => {
    await session.locator('#fileList li', { hasText: 'README' }).first().click();
    await expect(session.locator('#editorPath')).toHaveText('README.md');
    await expect(session.locator('.cm-content')).not.toBeEmpty({ timeout: 30_000 });
    await expect(session.locator('#btnSaveFile')).toBeEnabled();
  });

  test('writes an edit back into the container and reads it again', async ({ session }) => {
    const marker = `edited-by-playwright-${Date.now()}`;

    await session.locator('#fileList li', { hasText: 'README' }).first().click();
    await expect(session.locator('.cm-content')).not.toBeEmpty({ timeout: 30_000 });
    await session.locator('.cm-content').fill(marker);
    await session.locator('#btnSaveFile').click();
    await expect(session.locator('#editorStatus')).toHaveText('saved', { timeout: 30_000 });

    // Re-open from the container rather than trusting what is on screen.
    await session.locator('#fileList li', { hasText: 'brief' }).first().click();
    await expect(session.locator('#editorPath')).toHaveText('brief.md');
    await session.locator('#fileList li', { hasText: 'README' }).first().click();
    await expect(session.locator('.cm-content')).toHaveText(marker, { timeout: 30_000 });
  });

  test('creates a new file, which is how a lab task gets done', async ({ session }) => {
    // The hello lab asks for /workspace/greeting.txt, which no lab ships.
    // Without this the console could only edit what was already there and
    // the lab could not be finished in a browser at all.
    const name = `created-${Date.now()}.txt`;
    session.once('dialog', (d) => d.accept(name));
    await session.locator('#btnNewFile').click();

    await expect(session.locator('#fileList li', { hasText: name })).toBeVisible({ timeout: 30_000 });
    await expect(session.locator('#editorPath')).toHaveText(name);

    // And it is writable straight away, not just listed.
    await expect(session.locator('.cm-content')).toBeVisible({ timeout: 30_000 });
    await session.locator('.cm-content').fill('written into a file the console made');
    await session.locator('#btnSaveFile').click();
    await expect(session.locator('#editorStatus')).toHaveText('saved', { timeout: 30_000 });
  });

  test('refuses a path that escapes the workspace', async ({ session }) => {
    session.once('dialog', (d) => d.accept('../../etc/passwd'));
    await session.locator('#btnNewFile').click();
    await expect(session.locator('#fileError')).toBeVisible({ timeout: 10_000 });
  });

  test('highlights by language rather than showing plain text', async ({ session }) => {
    // A lab is read and edited as code; syntax colouring is the difference
    // between an editor and a textarea with a monospace font.
    await session.locator('#fileList li', { hasText: 'index.html' }).first().click();
    await expect(session.locator('.cm-content')).toBeVisible({ timeout: 30_000 });
    await expect(session.locator('.cm-content .ͼb, .cm-content .ͼc, .cm-content [class^="ͼ"]').first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test('refreshes the listing on demand', async ({ session }) => {
    await session.locator('#btnRefreshFiles').click();
    await expect(session.locator('#fileList li').first()).toBeVisible();
  });
});
