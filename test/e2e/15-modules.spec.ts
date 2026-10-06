import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, signIn } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Path cards, module cards and lab rows: the launcher's four pages (home, a path, a module, a lab).
 *
 * The API is stubbed (`/api/labs` returns a catalogue in the shape the console's
 * Worker serves, progress included), so every number below is derived from the
 * fixture. The copy that is checked (titles, intros, outcomes, the optional flag)
 * is read from packages/catalogue/paths.json itself, so editing the copy
 * cannot break this spec and a card that shows something else does.
 */

interface ModuleMeta {
  number: number;
  title: string;
  intro: string;
  outcomes: string[];
  optional?: boolean;
}
interface PathMeta {
  slug: string;
  title: string;
  intro: string;
  modules: ModuleMeta[];
}
const here = dirname(fileURLToPath(import.meta.url));
const meta = JSON.parse(readFileSync(join(here, '../../packages/catalogue/paths.json'), 'utf8')) as { paths: PathMeta[] };
const pathMeta = (slug: string) => meta.paths.find((p) => p.slug === slug)!;
const moduleMeta = (slug: string, n: number) => pathMeta(slug).modules.find((m) => m.number === n)!;

const done = { attempts: 3, best_score: 0.92, passed_all: true, last_run_at: 1 };
const started = { attempts: 1, best_score: 0.4, passed_all: false, last_run_at: 1 };

const lab = (o: Record<string, unknown>) => ({
  version: '1.0.0',
  type: 'build',
  family: 'agent',
  summary: `About ${o.slug}`,
  objectives: ['do the thing'],
  difficulty: 'core',
  timeout_minutes: 60,
  tier: 'pro',
  progress: null,
  ...o,
});

/**
 * production-agents is a single-module path (no module cards); ai-platform has
 * modules 1, 2 and 5 (5 is optional in the copy); `loose` belongs to no path.
 */
const LABS = [
  // production-agents: 4 labs, 150 min, 2 free, 1 done
  lab({ slug: 'pa1', title: 'Retry twice', path: 'production-agents', module: 1, order: 1, tier: 'free', estimated_minutes: 35, type: 'break-fix', progress: done }),
  lab({ slug: 'pa2', title: 'Weekend bill', path: 'production-agents', module: 1, order: 2, tier: 'free', estimated_minutes: 45, type: 'break-fix' }),
  lab({ slug: 'pa3', title: 'Sold out', path: 'production-agents', module: 1, order: 3, estimated_minutes: 40, type: 'break-fix', prerequisites: ['pa2'] }),
  lab({ slug: 'pa4', title: 'Forgotten rules', path: 'production-agents', module: 1, order: 4, estimated_minutes: 30, type: 'break-fix', progress: started }),
  // ai-platform module 1: 5 labs, 160 min, 1 free, 2 done
  lab({ slug: 'g1', title: 'See the gateway', path: 'ai-platform', module: 1, order: 1, tier: 'free', estimated_minutes: 20, type: 'explore', difficulty: 'intro', progress: done }),
  lab({ slug: 'g2', title: 'One endpoint, one key', path: 'ai-platform', module: 1, order: 2, estimated_minutes: 30, progress: done }),
  lab({ slug: 'g3', title: 'Hard budget', path: 'ai-platform', module: 1, order: 3, estimated_minutes: 60, prerequisites: ['g2'] }),
  lab({ slug: 'g4', title: 'Add a model', path: 'ai-platform', module: 1, order: 4, estimated_minutes: 40, progress: started }),
  lab({ slug: 'g5', title: 'Provider fails', path: 'ai-platform', module: 1, order: 5, estimated_minutes: 10 }),
  // module 2: 2 labs, the second locked behind g3 (not passed)
  lab({ slug: 't1', title: 'Tools reach an agent', path: 'ai-platform', module: 2, order: 1, estimated_minutes: 25, type: 'explore', difficulty: 'intro' }),
  lab({ slug: 't2', title: 'One endpoint for tools', path: 'ai-platform', module: 2, order: 2, estimated_minutes: 35, prerequisites: ['g3'] }),
  // module 5 (optional)
  lab({ slug: 'r1', title: 'Two replicas', path: 'ai-platform', module: 5, order: 5, estimated_minutes: 60, difficulty: 'advanced', type: 'break-fix' }),
  lab({ slug: 'loose', title: 'Loose lab', estimated_minutes: 15 }),
];
const PATH_ORDER = ['production-agents', 'ai-platform', ''];

async function stubLabs(page: Page, labs: unknown[] = LABS) {
  await page.route('**/api/labs', (route) => route.fulfill({ json: labs }));
}

const MARKER = '.path-card, .module-card, .module, .lab-rows, .lab-detail, #labList .empty-state, #labList .error, #signedOut';

/** A signed-in page that has already read the first-run dialog, on a page of the launcher (home unless `at` says otherwise). */
async function openLauncher(page: Page, opts: { width?: number; height?: number; at?: string } = {}) {
  await page.setViewportSize({ width: opts.width ?? 1440, height: opts.height ?? 900 });
  await signIn(page);
  await page.addInitScript(() => (localStorage.setItem('opalixOnboarded', '1'), localStorage.setItem('opalixLearn', '{"v":1,"onboarding":{"status":"skipped"}}')));
  await page.goto(opts.at ?? '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]', { timeout: 60_000 });
  await page.waitForSelector(MARKER, { timeout: 30_000 });
}

/** Moves to another page without leaving the app (what a link does). */
async function goInApp(page: Page, url: string) {
  await page.evaluate((u) => {
    history.pushState(null, '', u);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}

const PA = '/paths/production-agents';
const AI = '/paths/ai-platform';
const moduleUrl = (n: number) => `${AI}/modules/${n}`;
const pathCard = (page: Page, slug: string) => page.locator(`.path-card[data-path="${slug}"]`);
const moduleCard = (page: Page, n: number) => page.locator(`.module-card[data-module="${n}"]`);
const row = (page: Page, slug: string) => page.locator(`.lab[data-slug="${slug}"]`);
const outline = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#launcher h1, #launcher h2, #launcher h3, #launcher h4, #launcher h5, #launcher h6')]
      .filter((h) => (h as HTMLElement).offsetParent !== null)
      .map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent ?? '').trim() }))
  );

test.describe('home: path cards', () => {
  test('one card per path, in the order of the catalogue copy, each with its title, intro, counts and progress', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const cards = page.locator('.path-card');
    await expect(cards).toHaveCount(3);
    await expect(cards.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.path))).resolves.toEqual(PATH_ORDER);

    for (const slug of ['production-agents', 'ai-platform']) {
      const c = pathCard(page, slug);
      await expect(c.locator('h2.path-card-title')).toHaveText(pathMeta(slug).title);
      await expect(c.locator('.path-card-intro')).toHaveText(pathMeta(slug).intro);
      await expect(c.locator('.path-tile svg')).toBeVisible();
    }
    await expect(pathCard(page, 'production-agents').locator('.path-card-line')).toHaveText('4 labs · About 2.5 h');
    await expect(pathCard(page, 'ai-platform').locator('.path-card-line')).toHaveText('3 modules · 8 labs · About 4.5 h');
    await expect(pathCard(page, 'production-agents').locator('.path-card-progress')).toHaveText('1 of 4 labs done');
    await expect(pathCard(page, 'ai-platform').locator('.path-card-progress')).toHaveText('2 of 8 labs done');
    await expect(pathCard(page, '').locator('h2.path-card-title')).toHaveText('Other labs');
    await expect(pathCard(page, '').locator('.path-card-intro')).toHaveCount(0);
    await expect(pathCard(page, '').locator('.path-card-line')).toHaveText('1 lab · About 15 min');
  });

  test('the bar of a path counts the labs passed', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const bar = pathCard(page, 'ai-platform').locator('.progress');
    await expect(bar).toHaveAttribute('role', 'progressbar');
    await expect(bar).toHaveAttribute('aria-valuemax', '8');
    await expect(bar).toHaveAttribute('aria-valuenow', '2');
    const [fill, track] = await bar.evaluate((el) => [(el.firstElementChild as HTMLElement).getBoundingClientRect().width, el.getBoundingClientRect().width]);
    expect(fill / track).toBeCloseTo(2 / 8, 1);
  });

  test('home holds the path cards and nothing under them: no module, no lab', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    for (const sel of ['.module', '.module-card', '.lab', '.lab-rows', '.lab-detail']) await expect(page.locator(sel), sel).toHaveCount(0);
    // A card is one link, to its path's page.
    await expect(pathCard(page, 'ai-platform').getByRole('link')).toHaveAttribute('href', AI);
  });
});

test.describe('a path\'s page', () => {
  test('a single-module path shows its labs straight under the band, with no module card', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { at: PA });
    const band = page.locator('.lab-group[data-path="production-agents"]');
    await expect(band.locator('> h1.group-head')).toHaveText(pathMeta('production-agents').title);
    await expect(band.locator('> .path-intro')).toHaveText(pathMeta('production-agents').intro);
    await expect(band.locator('> .path-tile svg')).toBeVisible();
    await expect(band.locator('.path-summary')).toHaveText('4 labs · About 2.5 h · 2 free');
    await expect(band.locator('.path-progress')).toHaveText('1 of 4 labs done');
    await expect(page.locator('.module, .module-card')).toHaveCount(0);
    await expect(band.locator('.lab')).toHaveCount(4);
    await expect(band.locator('.lab .lab-num')).toHaveText(['1', '2', '3', '4']);
    // Labs with no path are the same: one plain list, on /paths/other.
    await page.goto('/paths/other', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]');
    await expect(page.locator('.module, .module-card')).toHaveCount(0);
    await expect(page.locator('.lab')).toHaveCount(1);
    await expect(page.locator('.lab-group > h1.group-head')).toHaveText('Other labs');
    await expect(page.locator('.lab-group > .path-intro')).toHaveCount(0);
  });

  test('the overall bar and totals of a path are on its page', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { at: AI });
    await expect(page.locator('.path-summary')).toHaveText('8 labs · About 4.5 h · 1 free');
    await expect(page.locator('.path-progress')).toHaveText('2 of 8 labs done');
    const bar = page.locator('.path-stats .progress');
    await expect(bar).toHaveAttribute('aria-valuemax', '8');
    await expect(bar).toHaveAttribute('aria-valuenow', '2');
  });

  test('a card per module of a multi-module path, with the eyebrow, title and intro from the copy; the title opens the module', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { at: AI });
    const cards = page.locator('.module-card');
    await expect(cards).toHaveCount(3);
    await expect(cards.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.module))).resolves.toEqual(['1', '2', '5']);
    for (const n of [1, 2, 5]) {
      const m = moduleMeta('ai-platform', n);
      const c = moduleCard(page, n);
      await expect(c.locator('.module-eyebrow .module-num')).toHaveText(`Module ${n}`);
      await expect(c.locator('h2.module-title')).toHaveText(m.title);
      await expect(c.locator('.module-intro')).toHaveText(m.intro);
      await expect(c.locator('.module-tile svg')).toBeVisible();
      await expect(c.getByRole('link', { name: m.title })).toHaveAttribute('href', moduleUrl(n));
      // The skills and the labs are on the module's own page.
      await expect(c.locator('.skill-list, .lab')).toHaveCount(0);
    }
    await expect(page.locator('.lab')).toHaveCount(0);
  });

  test('the Optional badge appears on the module the copy flags, and only there', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { at: AI });
    expect(moduleMeta('ai-platform', 5).optional).toBe(true);
    await expect(moduleCard(page, 5).locator('.badge-optional')).toHaveText('Optional');
    await expect(moduleCard(page, 1).locator('.badge-optional')).toHaveCount(0);
    await expect(moduleCard(page, 2).locator('.badge-optional')).toHaveCount(0);
  });

  test('a module counts its labs, minutes, free labs and progress from the progress it is given', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { at: AI });
    const one = moduleCard(page, 1);
    await expect(one.locator('.module-meta')).toHaveText('5 labs · About 2.5 h · 1 free');
    await expect(one.locator('.module-progress')).toHaveText('2 of 5 labs done');
    const bar = one.locator('.progress');
    await expect(bar).toHaveAttribute('aria-valuenow', '2');
    await expect(bar).toHaveAttribute('aria-valuemax', '5');
    const [fill, track] = await bar.evaluate((el) => [(el.firstElementChild as HTMLElement).getBoundingClientRect().width, el.getBoundingClientRect().width]);
    expect(fill / track).toBeCloseTo(0.4, 1);
    await expect(moduleCard(page, 2).locator('.module-meta')).toHaveText('2 labs · About 1 h');
    await expect(moduleCard(page, 2).locator('.module-progress')).toHaveText('0 of 2 labs done');
    await expect(moduleCard(page, 5).locator('.module-meta')).toHaveText('1 lab · About 1 h');
  });
});

test.describe('a module\'s page', () => {
  test('the panel on the left: number, title, intro and skills from the copy, the big number, the icon and a progress meter', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { at: moduleUrl(2) });
    const m = moduleMeta('ai-platform', 2);
    const panel = page.locator('.module-info');
    await expect(panel.locator('.module-eyebrow .module-num')).toHaveText('Module 2');
    await expect(panel.locator('h1.module-title')).toHaveText(m.title);
    await expect(panel.locator('.module-intro')).toHaveText(m.intro);
    await expect(panel.locator('.skills-label')).toHaveText('You will learn to');
    await expect(panel.locator('.skill-list li')).toHaveText(m.outcomes);
    expect(m.outcomes.length).toBeGreaterThanOrEqual(2);
    expect(m.outcomes.length).toBeLessThanOrEqual(4);
    await expect(panel.locator('.module-bignum')).toHaveText('02');
    await expect(panel.locator('.module-bignum')).toHaveAttribute('aria-hidden', 'true');
    await expect(panel.locator('.module-tile svg')).toBeVisible();
    await expect(panel.locator('.module-progress')).toHaveText('0 of 2 labs done');
    await expect(panel.getByRole('progressbar', { name: `Labs done in ${m.title}` })).toHaveAttribute('aria-valuemax', '2');
    // The Optional badge is on the panel of the module the copy flags.
    await goInApp(page, moduleUrl(5));
    await expect(page.locator('.module-info .badge-optional')).toHaveText('Optional');
  });

  test('a module counts its labs, minutes and free labs, with the labs as numbered rows: title, type, minutes, difficulty and a Free chip for the free ones', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { at: moduleUrl(1) });
    const one = page.locator('.module');
    await expect(one.locator('.module-meta')).toHaveText('5 labs · About 2.5 h · 1 free');
    await expect(one.locator('.module-progress')).toHaveText('2 of 5 labs done');
    await expect(one.locator('.lab')).toHaveCount(5);
    await expect(one.locator('.lab .lab-num')).toHaveText(['1', '2', '3', '4', '5']);
    await expect(one.locator('.lab h2.lab-title')).toHaveText(['See the gateway', 'One endpoint, one key', 'Hard budget', 'Add a model', 'Provider fails']);

    const first = row(page, 'g1');
    await expect(first.locator('.chip-type')).toHaveText('Explore');
    await expect(first.locator('.chip-time')).toContainText('20 min');
    await expect(first.locator('.chip-difficulty')).toHaveText('intro');
    await expect(first.locator('.chip-tier')).toHaveText('Free');
    await expect(row(page, 'g2').locator('.chip-tier')).toHaveCount(0);
    // The row's text is still the plain "slug@version · family · type …" line.
    await expect(first.locator('.lab-sub')).toHaveText(/^g1@1\.0\.0 · agent · Explore · intro · 20 min · 1 h limit · Free$/);
  });

  test('"About this lab" is a link to the lab\'s own page, with its summary and objectives', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { at: moduleUrl(1) });
    const r = row(page, 'g2');
    await expect(r.locator('.lab-summary')).toHaveCount(0);
    const about = r.getByRole('link', { name: 'About this lab' });
    await expect(about).toHaveAttribute('href', '/labs/g2');
    await about.click();
    await expect(page.locator('.lab-detail .lab-summary')).toHaveText('About g2');
    await expect(page.locator('.lab-detail .lab-objectives li').first()).toHaveText('do the thing');
    await expect(page.locator('.lab-detail-title')).toHaveText('One endpoint, one key');
  });
});

test.describe('lab status', () => {
  test('done, in progress, not started and locked each say so', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { at: moduleUrl(1) });
    await expect(row(page, 'g1')).toHaveClass(/lab-done/);
    await expect(row(page, 'g1').locator('.chip-done')).toHaveText('Done · best 92%');
    await expect(row(page, 'g4').locator('.lab-state')).toHaveText('In progress · best 40%');
    await expect(row(page, 'g5').locator('.lab-state')).toHaveText('Not started');
    // g2 is passed, so g3 is open; t2 (module 2) needs g3, which is not.
    await expect(row(page, 'g3')).not.toHaveClass(/lab-locked/);
    await goInApp(page, moduleUrl(2));
    await expect(row(page, 't2')).toHaveClass(/lab-locked/);
    await expect(row(page, 't2').locator('.lab-lock')).toHaveText('Locked until Hard budget passes');
    await goInApp(page, PA);
    await expect(row(page, 'pa3').locator('.lab-lock')).toHaveText('Locked until Weekend bill passes');
  });

  test('a locked lab keeps aria-disabled and a click does nothing; an open one starts', async ({ page }) => {
    let starts = 0;
    await page.route('**/api/start', (route) => {
      starts++;
      return route.fulfill({ status: 500, json: { error: 'no container in a stubbed test' } });
    });
    await stubLabs(page);
    await openLauncher(page, { at: moduleUrl(2) });
    const locked = row(page, 't2').locator('button.lab-start');
    await expect(locked).toHaveAttribute('aria-disabled', 'true');
    await expect(locked).toHaveAttribute('title', /Locked until Hard budget passes/);
    // aria-disabled, not disabled: a person can still press it. Playwright treats aria-disabled
    // as disabled and would wait forever, so force the click through.
    await locked.click({ force: true });
    await page.waitForTimeout(300);
    expect(starts).toBe(0);
    await expect(row(page, 't2').locator('.notice')).toBeHidden();

    // An open lab does start, and its failure is shown inside its own row.
    await goInApp(page, moduleUrl(1));
    await row(page, 'g5').locator('button.lab-start').click();
    await expect(row(page, 'g5').locator('.notice')).toContainText('Could not start this lab');
    expect(starts).toBe(1);
  });
});

test.describe('getting from page to page', () => {
  test('home -> path -> module -> lab by the links on the cards and rows, and the trail leads back up', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const here_ = () => new URL(page.url()).pathname;
    await pathCard(page, 'ai-platform').getByRole('link', { name: pathMeta('ai-platform').title }).click();
    expect(here_()).toBe(AI);
    await moduleCard(page, 2).getByRole('link', { name: moduleMeta('ai-platform', 2).title }).click();
    expect(here_()).toBe(moduleUrl(2));
    await row(page, 't1').getByRole('link', { name: 'About this lab' }).click();
    expect(here_()).toBe('/labs/t1');
    const trail = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(trail.locator('li')).toHaveText(['Home', pathMeta('ai-platform').title, `Module 2: ${moduleMeta('ai-platform', 2).title}`, 'Tools reach an agent']);
    await trail.getByRole('link', { name: /^Module 2/ }).click();
    expect(here_()).toBe(moduleUrl(2));
    await trail.getByRole('link', { name: pathMeta('ai-platform').title }).click();
    expect(here_()).toBe(AI);
    await trail.getByRole('link', { name: 'Home' }).click();
    expect(here_()).toBe('/');
  });
});

test.describe('search and filters over paths and modules', () => {
  test('act on the page they are on: cards without a match are left out, and the count is "n of N labs" of that page', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    await expect(page.locator('#labCount')).toHaveText(`${LABS.length} of ${LABS.length} labs`);

    await page.locator('#labSearch').fill('replicas');
    await expect(page.locator('#labCount')).toHaveText(`1 of ${LABS.length} labs`);
    await expect(page.locator('.path-card')).toHaveCount(1);
    await expect(pathCard(page, 'ai-platform')).toBeVisible();
    await expect(pathCard(page, 'ai-platform').locator('.path-card-progress')).toHaveText('2 of 8 labs done · 1 match');

    await pathCard(page, 'ai-platform').getByRole('link', { name: pathMeta('ai-platform').title }).click();
    await expect(page.locator('#labCount')).toHaveText('1 of 8 labs');
    await expect(page.locator('.module-card')).toHaveCount(1);
    await expect(moduleCard(page, 5)).toBeVisible();

    await moduleCard(page, 5).getByRole('link', { name: moduleMeta('ai-platform', 5).title }).click();
    await expect(page.locator('#labCount')).toHaveText('1 of 1 labs');
    await expect(row(page, 'r1')).toBeVisible();

    await goInApp(page, moduleUrl(1));
    await expect(page.locator('#labCount')).toHaveText('0 of 5 labs');
    await expect(page.locator('#labNoMatch')).toBeVisible();
    await expect(page.locator('.lab')).toHaveCount(0);

    await goInApp(page, '/');
    await page.locator('#labSearch').fill('zzz nothing');
    await expect(page.locator('#labCount')).toHaveText(`0 of ${LABS.length} labs`);
    await expect(page.locator('#labNoMatch')).toBeVisible();
    await expect(page.locator('.path-card')).toHaveCount(0);

    await page.locator('#btnClearFilters').click();
    await expect(page.locator('#labCount')).toHaveText(`${LABS.length} of ${LABS.length} labs`);
    await expect(page.locator('.path-card')).toHaveCount(3);
  });

  test('the status and difficulty chips filter across the page, and a module keeps its own totals', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    await page.locator('button.filter-chip[data-filter="status"][data-value="done"]').click();
    // pa1, g1 and g2 are done.
    await expect(page.locator('#labCount')).toHaveText(`3 of ${LABS.length} labs`);
    await expect(page.locator('.path-card')).toHaveCount(2);
    await expect(pathCard(page, '')).toHaveCount(0);

    await goInApp(page, moduleUrl(1));
    await expect(row(page, 'g1')).toBeVisible();
    await expect(page.locator('.lab')).toHaveCount(2);
    // Leaving labs out does not change what the module says about itself.
    await expect(page.locator('.module-meta')).toHaveText('5 labs · About 2.5 h · 1 free');
    await expect(page.locator('.module-progress')).toHaveText('2 of 5 labs done');
    await goInApp(page, moduleUrl(2));
    await expect(page.locator('.lab')).toHaveCount(0);

    await goInApp(page, '/');
    await page.locator('button.filter-chip[data-filter="difficulty"][data-value="advanced"]').click();
    await expect(page.locator('#labCount')).toHaveText(`0 of ${LABS.length} labs`);
  });

  test('a saved filter is applied to the first render', async ({ page }) => {
    await stubLabs(page);
    await signIn(page);
    await page.addInitScript(() => {
      (localStorage.setItem('opalixOnboarded', '1'), localStorage.setItem('opalixLearn', '{"v":1,"onboarding":{"status":"skipped"}}'));
      localStorage.setItem('opalixFilters', JSON.stringify({ q: 'replicas', difficulty: [], family: [], status: [] }));
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-booted="1"]', { timeout: 60_000 });
    await expect(page.locator('#labCount')).toHaveText(`1 of ${LABS.length} labs`);
    await expect(pathCard(page, 'production-agents')).toHaveCount(0);
    await expect(page.locator('#labSearch')).toHaveValue('replicas');
  });
});

test.describe('headings', () => {
  test('each page has one h1 and no level skipped: home h1 > path h2; a path h1 > module h2; a module h1 > lab h2', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const check = async (label: string, expected: Array<[number, number]>) => {
      const levels = (await outline(page)).map((h) => h.level);
      expect(levels.filter((l) => l === 1), `${label}: one h1`).toHaveLength(1);
      expect(levels[0], `${label}: it comes first`).toBe(1);
      levels.forEach((l, i) => {
        if (i > 0) expect(l, `${label}: a heading is at most one level deeper than the one before`).toBeLessThanOrEqual(levels[i - 1]! + 1);
      });
      for (const [level, count] of expected) expect(levels.filter((l) => l === level), `${label}: h${level}`).toHaveLength(count);
    };
    await check('home', [[2, 3]]);
    await goInApp(page, AI);
    await expect(page.locator('.module-card').first()).toBeVisible();
    await check('a path', [[2, 3]]);
    await goInApp(page, moduleUrl(1));
    await expect(page.locator('.lab').first()).toBeVisible();
    await check('a module', [[2, 5]]);
    await goInApp(page, '/labs/g1');
    await expect(page.locator('.lab-detail')).toBeVisible();
    await check('a lab', [[2, 3]]);
  });

  test('a path\'s band, a module\'s card and a lab\'s row are named by their heading', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { at: AI });
    await expect(page.getByRole('region', { name: pathMeta('ai-platform').title })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: moduleMeta('ai-platform', 1).title })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: `Labs done in ${moduleMeta('ai-platform', 1).title}` })).toHaveAttribute('aria-valuenow', '2');
    await goInApp(page, moduleUrl(1));
    await expect(page.getByRole('region', { name: moduleMeta('ai-platform', 1).title })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: moduleMeta('ai-platform', 1).title })).toBeVisible();
    await expect(page.locator('.lab h2.lab-title')).toHaveCount(5);
  });
});

test.describe('states', () => {
  test('shows skeletons while loading, without the filters', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/labs', async (route) => {
      await gate;
      await route.fulfill({ json: LABS });
    });
    await signIn(page);
    await page.addInitScript(() => (localStorage.setItem('opalixOnboarded', '1'), localStorage.setItem('opalixLearn', '{"v":1,"onboarding":{"status":"skipped"}}')));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.lab-skeleton')).toHaveCount(3);
    await expect(page.locator('#labList')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#labFilters')).toBeHidden();
    release();
    await expect(pathCard(page, 'ai-platform')).toBeVisible();
    await expect(page.locator('.lab-skeleton')).toHaveCount(0);
    await expect(page.locator('#labList')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#labFilters')).toBeVisible();
  });

  test('shows the signed-out state on a 401', async ({ page }) => {
    await page.route('**/api/labs', (route) => route.fulfill({ status: 401, json: { error: 'not signed in' } }));
    await openLauncher(page);
    await expect(page.locator('#signedOut')).toContainText('You are signed out');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.locator('.path-card')).toHaveCount(0);
  });

  test('shows the error state on a failure and recovers on Try again', async ({ page }) => {
    let fail = true;
    await page.route('**/api/labs', (route) => (fail ? route.fulfill({ status: 500, json: { error: 'boom' } }) : route.fulfill({ json: LABS })));
    await openLauncher(page);
    await expect(page.locator('#labList .error')).toContainText('Could not load labs');
    await expect(page.locator('#labFilters')).toBeHidden();
    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(pathCard(page, 'ai-platform')).toBeVisible();
    await expect(page.locator('#labFilters')).toBeVisible();
  });

  test('shows the empty state when nothing is published', async ({ page }) => {
    await stubLabs(page, []);
    await openLauncher(page);
    await expect(page.locator('#labList .empty-state')).toContainText('No labs are available yet');
    await expect(page.locator('#labFilters')).toBeHidden();
  });

  test('copes with catalogue data the copy does not describe', async ({ page }) => {
    await stubLabs(page, [
      lab({ slug: 'n1', title: 'New path lab', path: 'brand-new-path', module: 1, order: 1 }),
      lab({ slug: 'n2', title: 'Second in a new module', path: 'brand-new-path', module: 2, order: 1 }),
      lab({ slug: 'p1', title: 'Known path, module the copy lacks', path: 'ai-platform', module: 9, order: 1 }),
    ]);
    await openLauncher(page);
    // Known paths first, then the unknown; the humanised slug stands in for a title and there is no intro.
    await expect(page.locator('.path-card h2')).toHaveText([pathMeta('ai-platform').title, 'Brand new path']);
    await expect(pathCard(page, 'brand-new-path').locator('.path-card-intro')).toHaveCount(0);
    await goInApp(page, '/paths/brand-new-path');
    await expect(page.locator('.module-card h2')).toHaveText(['Module 1', 'Module 2']);
    await goInApp(page, moduleUrl(9));
    await expect(page.locator('.module-info h1')).toHaveText('Module 9');
    await expect(page.locator('.module-info .skills-label')).toHaveCount(0);
  });
});

test.describe('themes and small screens', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`renders in the ${scheme} theme with the accent of each path and module`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await stubLabs(page);
      await openLauncher(page);
      const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      // Each path card carries an accent; the tint of its icon is not the page colour.
      const accents = await page.locator('.path-card[data-accent]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.accent));
      expect(accents.length).toBe(3);
      const tile = await pathCard(page, 'ai-platform').locator('.path-tile').evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(tile).not.toBe(await bodyBg());
      // A path's page: the module cards carry theirs, and the band's text is the console's normal text colour, never the accent.
      await goInApp(page, AI);
      expect(await page.locator('.module-card[data-accent]').count()).toBe(3);
      const [intro, ink2, accentInk] = await page.locator('.path-intro').evaluate((el) => {
        const colour = (value: string) => {
          const probe = document.createElement('span');
          probe.style.color = value;
          document.body.append(probe);
          const resolved = getComputedStyle(probe).color;
          probe.remove();
          return resolved;
        };
        return [getComputedStyle(el).color, colour('var(--ink-2)'), colour('var(--a-ink, var(--accent-violet-ink))')];
      });
      expect(intro).toBe(ink2);
      expect(intro).not.toBe(accentInk);
      // The module panel is on its family's tint too, not on the card colour.
      await goInApp(page, moduleUrl(1));
      const panel = await page.locator('.module-info').evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(panel).not.toBe(await bodyBg());
    });
  }

  test('at phone width nothing overflows sideways on any page, the header fits, and touch targets are 44px', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { width: 390, height: 844 });
    const overflow = () => page.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth, body: document.body.scrollWidth - window.innerWidth }));
    for (const url of ['/', AI, moduleUrl(1), '/labs/g1']) {
      await goInApp(page, url);
      await expect(page.locator(MARKER).first()).toBeVisible();
      const o = await overflow();
      expect(o.page, url).toBeLessThanOrEqual(0);
      expect(o.body, url).toBeLessThanOrEqual(0);
    }

    // The header is one slim pill: the brand and a menu button, which opens the rest inside the pill.
    const headerRight = () => page.evaluate(() => Math.max(...[...document.querySelectorAll('.bar *')].filter((el) => (el as HTMLElement).offsetParent !== null).map((el) => el.getBoundingClientRect().right)));
    await expect(page.locator('#btnMenu')).toBeVisible();
    await expect(page.locator('#btnMenu')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#btnSignOut')).toBeHidden();
    expect(await headerRight()).toBeLessThanOrEqual(390);
    await page.locator('#btnMenu').click();
    await expect(page.locator('#btnMenu')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#btnSignOut')).toBeVisible();
    // Help is only shown inside a lab.
    await expect(page.locator('#btnHelp')).toBeHidden();
    await expect(page.locator('#btnTheme')).toBeVisible();
    // Every header control ends inside the viewport (the identity text is dropped below 520px).
    expect(await headerRight()).toBeLessThanOrEqual(390);
    await expect(page.locator('#identity')).toBeHidden();
    // Escape closes the menu and puts focus back on its button.
    await page.keyboard.press('Escape');
    await expect(page.locator('#btnMenu')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#btnMenu')).toBeFocused();
    await expect(page.locator('#btnSignOut')).toBeHidden();

    const size = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
    await goInApp(page, moduleUrl(1));
    await expect(page.locator('.lab').first()).toBeVisible();
    for (const selector of ['.lab-start', '.lab-about', '.crumbs a', 'button.filter-chip', '#btnMenu', '#labSearch']) {
      const box = await size(selector);
      expect(box.height, `${selector} height`).toBeGreaterThanOrEqual(44);
    }
    await page.locator('#btnMenu').click();
    for (const selector of ['#btnSignOut', '#btnTheme', '#btnHelp']) {
      const box = await size(selector);
      expect(box.height, `${selector} height`).toBeGreaterThanOrEqual(44);
    }
    expect((await size('#btnTheme')).width).toBeGreaterThanOrEqual(44);
    expect((await size('#btnMenu')).width).toBeGreaterThanOrEqual(44);
    // The module is one column, and a lab row keeps its Start button inside the card.
    const c = page.locator('.module');
    const [cardBox, startBox, titleBox] = await Promise.all([c.boundingBox(), c.locator('.lab-start').first().boundingBox(), c.locator('.module-title').boundingBox()]);
    expect(startBox!.x + startBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
    expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
  });

  test('at desktop width a module puts its labs beside its info; below ~1080px they stack', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { width: 1440, height: 900, at: moduleUrl(1) });
    const c = page.locator('.module');
    let [info, rows] = await Promise.all([c.locator('.module-info').boundingBox(), c.locator('.lab-rows').boundingBox()]);
    expect(rows!.x).toBeGreaterThan(info!.x + info!.width - 2);
    await page.setViewportSize({ width: 900, height: 900 });
    [info, rows] = await Promise.all([c.locator('.module-info').boundingBox(), c.locator('.lab-rows').boundingBox()]);
    expect(rows!.y).toBeGreaterThan(info!.y + info!.height - 2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('the launcher, as the landing page draws it', () => {
  test('home asks for the next lab when nothing is running; a row says Start, Open again or Locked', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    await expect(page.locator('#heroTitle')).toHaveText('Pick your next lab.');
    await expect(page.locator('#resumeCard')).toBeHidden();
    await expect(page.locator('#heroLede')).toHaveText('Two paths, each a run of hands-on labs.');
    await goInApp(page, moduleUrl(1));
    await expect(row(page, 'g1').locator('.lab-start')).toHaveText('Open again');
    await expect(row(page, 'g5').locator('.lab-start')).toHaveText('Start');
    await goInApp(page, moduleUrl(2));
    await expect(row(page, 't2').locator('.lab-start')).toHaveText('Locked');
    // A done row shows a check in its circle (the number stays in the markup), an open one its number.
    await goInApp(page, moduleUrl(1));
    await expect(row(page, 'g1').locator('.lab-num')).toHaveText('1');
    await expect(row(page, 'g1')).toHaveClass(/lab-done/);
  });

  test('the header is the landing page\'s pill: brand, Labs, Paths, Help, theme, sign out', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const nav = page.getByRole('navigation', { name: 'Console' });
    await expect(page.locator('.brand')).toContainText('opalix');
    await expect(page.locator('.brand .beta-tag')).toHaveText('LABS');
    await expect(nav.getByRole('link', { name: 'Labs' })).toHaveAttribute('aria-current', 'page');
    // Three more links, each to its own address: the path cards on Home, the learner's own path, and the profile.
    await expect(nav.getByRole('link', { name: 'Paths' })).toHaveAttribute('href', '/#paths');
    await expect(nav.getByRole('link', { name: 'Your path' })).toHaveAttribute('href', '/paths/mine');
    await expect(nav.getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/profile');
    await expect(nav.getByRole('button', { name: 'Help' })).toBeVisible();
    await expect(page.locator('#identityInitials')).toHaveText('CO');
    const radius = await page.locator('.nav').evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    expect(parseFloat(radius)).toBeGreaterThan(40);
    // Paths is home, and focus lands on the first path.
    await nav.getByRole('link', { name: 'Paths' }).click();
    await expect(page.locator('.path-card-title a').first()).toBeFocused();
    // Help opens the existing dialog.
    await nav.getByRole('button', { name: 'Help' }).click();
    await expect(page.locator('dialog#onboarding[open]')).toBeVisible();
  });

  test('the console uses Funnel Display, Funnel Sans and JetBrains Mono, self-hosted', async ({ page }) => {
    const fonts: string[] = [];
    page.on('response', (r) => { if (r.url().endsWith('.woff2')) fonts.push(new URL(r.url()).pathname); });
    const external: string[] = [];
    page.on('request', (r) => { if (!r.url().startsWith(new URL(page.url() || 'about:blank').origin) && /fonts\.(googleapis|gstatic)/.test(r.url())) external.push(r.url()); });
    await stubLabs(page);
    await openLauncher(page);
    await page.evaluate(() => document.fonts.ready);
    const faces = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')));
    expect(faces).toEqual(expect.arrayContaining(['Funnel Display', 'Funnel Sans']));
    expect(fonts.every((f) => f.startsWith('/dist/fonts/'))).toBe(true);
    expect(external).toEqual([]);
    const family = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).fontFamily);
    expect(await family('#heroTitle')).toContain('Funnel Display');
    expect(await family('.lede')).toContain('Funnel Sans');
    await goInApp(page, moduleUrl(1));
    await expect(page.locator('.lab').first()).toBeVisible();
    expect(await family('.lab-sub .chip')).toContain('JetBrains Mono');
  });
});

test.describe('a path with many modules', () => {
  const MANY: Array<Record<string, unknown>> = [1, 2, 3, 4, 5, 6, 7].map((n) => lab({ slug: `m${n}`, title: `Lab of module ${n}`, path: 'ai-platform', module: n, order: 1, estimated_minutes: 20 }));

  test('lists every module as a card (none is folded away) and each opens its own page', async ({ page }) => {
    await stubLabs(page, MANY);
    await openLauncher(page, { at: AI });
    await expect(page.locator('.module-card')).toHaveCount(7);
    await expect(page.locator('.lab, .module')).toHaveCount(0);
    await moduleCard(page, 6).getByRole('link').click();
    await expect(page.locator('.module .lab')).toHaveCount(1);
    await expect(row(page, 'm6')).toBeVisible();
    await expect(page.locator('.module-title')).toBeFocused();
  });

  test('a search leaves the modules without a match out of the path\'s page', async ({ page }) => {
    await stubLabs(page, MANY);
    await openLauncher(page, { at: AI });
    await page.locator('#labSearch').fill('module 6');
    await expect(page.locator('.module-card')).toHaveCount(1);
    await expect(moduleCard(page, 6)).toBeVisible();
    await page.locator('#btnClearFilters').click();
    await expect(page.locator('.module-card')).toHaveCount(7);
  });
});
