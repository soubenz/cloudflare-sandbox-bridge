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
    await expect(session.locator('#editorBody')).not.toBeEmpty();
    await expect(session.locator('#btnSaveFile')).toBeEnabled();
  });

  test('writes an edit back into the container and reads it again', async ({ session }) => {
    const marker = `edited-by-playwright-${Date.now()}`;

    await session.locator('#fileList li', { hasText: 'README' }).first().click();
    await expect(session.locator('#editorBody')).not.toBeEmpty();
    await session.locator('#editorBody').fill(marker);
    await session.locator('#btnSaveFile').click();
    await expect(session.locator('#editorStatus')).toHaveText('saved', { timeout: 30_000 });

    // Re-open from the container rather than trusting what is on screen.
    await session.locator('#fileList li', { hasText: 'brief' }).first().click();
    await expect(session.locator('#editorPath')).toHaveText('brief.md');
    await session.locator('#fileList li', { hasText: 'README' }).first().click();
    await expect(session.locator('#editorBody')).toHaveValue(marker, { timeout: 30_000 });
  });

  test('refreshes the listing on demand', async ({ session }) => {
    await session.locator('#btnRefreshFiles').click();
    await expect(session.locator('#fileList li').first()).toBeVisible();
  });
});
