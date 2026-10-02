import { expect, type Page } from '@playwright/test';

/**
 * Getting around the launcher's pages from a spec: home lists the paths, a path its modules, a module its
 * labs (each with a Start button), and a lab has a page of its own with one. The local specs (16 to 20)
 * start labs from wherever the page happens to be.
 */

/** The module that holds the labs of the specs' stub catalogues (path `ai-platform`, module 1). */
export const MODULE_PAGE = '/paths/ai-platform/modules/1';

const trail = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });

/**
 * Presses Start for a lab wherever the page is: on its row (a module's page), on its own page, or, from
 * the page of another lab, through the trail's module link to the row.
 */
export async function pressStart(page: Page, slug: string): Promise<void> {
  const row = page.locator(`.lab[data-slug="${slug}"] .lab-start`);
  const own = page.locator(`.lab-detail[data-slug="${slug}"] .lab-start`);
  if (!(await row.count()) && !(await own.count())) {
    await trail(page).getByRole('link', { name: /^Module \d+/ }).click();
    await expect(row).toBeVisible();
  }
  await ((await row.count()) ? row : own).click();
}
