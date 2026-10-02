import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, signIn } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Path bands, module cards and lab rows on the launcher.
 *
 * The API is stubbed (`/api/labs` returns a catalogue in the shape the console's
 * Worker serves, progress included), so every number below is derived from the
 * fixture. The copy that is checked (titles, intros, skills, the optional flag)
 * is read from packages/catalogue/paths.json itself, so editing the copy
 * cannot break this spec and a card that shows something else does.
 */

interface ModuleMeta {
  number: number;
  title: string;
  intro: string;
  skills: string[];
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

/** A signed-in page that has already read the first-run dialog, on the launcher. */
async function openLauncher(page: Page, opts: { width?: number; height?: number } = {}) {
  await page.setViewportSize({ width: opts.width ?? 1440, height: opts.height ?? 900 });
  await signIn(page);
  await page.addInitScript(() => (localStorage.setItem('opalixOnboarded', '1'), localStorage.setItem('opalixLearn', '{"v":1,"onboarding":{"status":"skipped"}}')));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]', { timeout: 60_000 });
  await page.waitForSelector('.lab, #labList .empty-state', { timeout: 30_000 });
}

const section = (page: Page, slug: string) => page.locator(slug ? `.lab-group[data-path="${slug}"]` : '.lab-group[data-path=""]');
const card = (page: Page, path: string, n: number) => section(page, path).locator(`.module[data-module="${n}"]`);
const row = (page: Page, slug: string) => page.locator(`.lab[data-slug="${slug}"]`);

test.describe('path bands', () => {
  test('one band per path, in the order of the catalogue copy, each with its title, intro and totals', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const groups = page.locator('.lab-group');
    await expect(groups).toHaveCount(3);
    await expect(groups.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.path))).resolves.toEqual(PATH_ORDER);

    for (const slug of ['production-agents', 'ai-platform']) {
      const band = section(page, slug);
      await expect(band.locator('> h2.group-head')).toHaveText(pathMeta(slug).title);
      await expect(band.locator('> .path-intro')).toHaveText(pathMeta(slug).intro);
      await expect(band.locator('> .path-tile svg')).toBeVisible();
    }
    await expect(section(page, 'production-agents').locator('.path-summary')).toHaveText('4 labs · about 2.5 h · 2 free · 1 done');
    await expect(section(page, 'ai-platform').locator('.path-summary')).toHaveText('8 labs · about 4.5 h · 1 free · 2 done');
    await expect(section(page, '').locator('> h2.group-head')).toHaveText('Other labs');
    await expect(section(page, '').locator('> .path-intro')).toHaveCount(0);
  });

  test('the overall bar of a path counts the labs passed', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const bar = section(page, 'ai-platform').locator('.path-stats .progress');
    await expect(bar).toHaveAttribute('role', 'progressbar');
    await expect(bar).toHaveAttribute('aria-valuemax', '8');
    await expect(bar).toHaveAttribute('aria-valuenow', '2');
    const [fill, track] = await bar.evaluate((el) => [(el.firstElementChild as HTMLElement).getBoundingClientRect().width, el.getBoundingClientRect().width]);
    expect(fill / track).toBeCloseTo(2 / 8, 1);
  });

  test('a single-module path shows its labs straight under the band, with no module card', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const band = section(page, 'production-agents');
    await expect(band.locator('.module')).toHaveCount(0);
    await expect(band.locator('.lab')).toHaveCount(4);
    await expect(band.locator('.lab .lab-num')).toHaveText(['1', '2', '3', '4']);
    // Labs with no path are the same: one plain list.
    await expect(section(page, '').locator('.module')).toHaveCount(0);
    await expect(section(page, '').locator('.lab')).toHaveCount(1);
  });
});

test.describe('module cards', () => {
  test('a card per module of a multi-module path, with the eyebrow, title, intro and skills from the copy', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const modules = section(page, 'ai-platform').locator('.module');
    await expect(modules).toHaveCount(3);
    await expect(modules.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.module))).resolves.toEqual(['1', '2', '5']);

    for (const n of [1, 2, 5]) {
      const m = moduleMeta('ai-platform', n);
      const c = card(page, 'ai-platform', n);
      await expect(c.locator('.module-eyebrow .module-num')).toHaveText(`Module ${n}`);
      await expect(c.locator('h3.module-title')).toHaveText(m.title);
      await expect(c.locator('.module-intro')).toHaveText(m.intro);
      await expect(c.locator('.skills-label')).toHaveText('You will learn to');
      await expect(c.locator('.skill-list li')).toHaveText(m.skills);
      expect(m.skills.length).toBeGreaterThanOrEqual(2);
      expect(m.skills.length).toBeLessThanOrEqual(4);
      await expect(c.locator('.module-tile svg')).toBeVisible();
    }
  });

  test('the Optional badge appears on the module the copy flags, and only there', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    expect(moduleMeta('ai-platform', 5).optional).toBe(true);
    await expect(card(page, 'ai-platform', 5).locator('.badge-optional')).toHaveText('Optional');
    await expect(card(page, 'ai-platform', 1).locator('.badge-optional')).toHaveCount(0);
    await expect(card(page, 'ai-platform', 2).locator('.badge-optional')).toHaveCount(0);
  });

  test('a module counts its labs, minutes, free labs and progress from the progress it is given', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const one = card(page, 'ai-platform', 1);
    await expect(one.locator('.module-meta')).toHaveText('5 labs · ~2.5 h · 1 free');
    await expect(one.locator('.module-progress')).toHaveText('2 of 5 done');
    const bar = one.locator('.progress');
    await expect(bar).toHaveAttribute('aria-valuenow', '2');
    await expect(bar).toHaveAttribute('aria-valuemax', '5');
    const [fill, track] = await bar.evaluate((el) => [(el.firstElementChild as HTMLElement).getBoundingClientRect().width, el.getBoundingClientRect().width]);
    expect(fill / track).toBeCloseTo(0.4, 1);

    const two = card(page, 'ai-platform', 2);
    await expect(two.locator('.module-meta')).toHaveText('2 labs · ~1 h');
    await expect(two.locator('.module-progress')).toHaveText('0 of 2 done');
    await expect(card(page, 'ai-platform', 5).locator('.module-meta')).toHaveText('1 lab · ~1 h');
  });

  test('a card lists its labs as numbered rows: title, type, minutes, difficulty and a Free chip for the free ones', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const one = card(page, 'ai-platform', 1);
    await expect(one.locator('.lab')).toHaveCount(5);
    await expect(one.locator('.lab .lab-num')).toHaveText(['1', '2', '3', '4', '5']);
    await expect(one.locator('.lab h4.lab-title')).toHaveText(['See the gateway', 'One endpoint, one key', 'Hard budget', 'Add a model', 'Provider fails']);

    const first = row(page, 'g1');
    await expect(first.locator('.chip-type')).toHaveText('explore');
    await expect(first.locator('.chip-time')).toContainText('~20 min');
    await expect(first.locator('.chip-difficulty')).toHaveText('intro');
    await expect(first.locator('.chip-tier')).toHaveText('Free');
    await expect(row(page, 'g2').locator('.chip-tier')).toHaveCount(0);
    // The row's text is still the plain "slug@version · family · type …" line.
    await expect(first.locator('.lab-sub')).toHaveText(/^g1@1\.0\.0 · agent · explore · intro · ~20 min · 60 min limit · Free$/);
  });

  test('a lab row opens to its summary and objectives', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const r = row(page, 'g2');
    await expect(r.locator('.lab-summary')).toBeHidden();
    await r.locator('.lab-more > summary').click();
    await expect(r.locator('.lab-summary')).toHaveText('About g2');
    await expect(r.locator('.lab-objectives li').first()).toHaveText('do the thing');
  });
});

test.describe('lab status', () => {
  test('done, in progress, not started and locked each say so', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    await expect(row(page, 'g1')).toHaveClass(/lab-done/);
    await expect(row(page, 'g1').locator('.chip-done')).toHaveText('Done · best 92%');
    await expect(row(page, 'g4').locator('.lab-state')).toHaveText('In progress · best 40%');
    await expect(row(page, 'g5').locator('.lab-state')).toHaveText('Not started');
    // g2 is passed, so g3 is open; t2 needs g3, which is not.
    await expect(row(page, 'g3')).not.toHaveClass(/lab-locked/);
    await expect(row(page, 't2')).toHaveClass(/lab-locked/);
    await expect(row(page, 't2').locator('.lab-lock')).toHaveText('Locked until Hard budget passes');
    await expect(row(page, 'pa3').locator('.lab-lock')).toHaveText('Locked until Weekend bill passes');
  });

  test('a locked lab keeps aria-disabled and a click does nothing; an open one starts', async ({ page }) => {
    let starts = 0;
    await page.route('**/api/start', (route) => {
      starts++;
      return route.fulfill({ status: 500, json: { error: 'no container in a stubbed test' } });
    });
    await stubLabs(page);
    await openLauncher(page);
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
    await row(page, 'g5').locator('button.lab-start').click();
    await expect(row(page, 'g5').locator('.notice')).toContainText('Could not start this lab');
    expect(starts).toBe(1);
  });
});

test.describe('path navigator', () => {
  test('one pill per path with its lab count, and it does not displace the search and filters', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const nav = page.getByRole('navigation', { name: 'Learning paths' });
    await expect(nav).toBeVisible();
    const pills = nav.locator('a.path-pill');
    await expect(pills).toHaveCount(3);
    await expect(pills.nth(0)).toContainText(pathMeta('production-agents').title);
    await expect(pills.nth(0).locator('.pill-count')).toHaveText('4');
    await expect(pills.nth(1).locator('.pill-count')).toHaveText('8');
    await expect(pills.nth(2)).toContainText('Other labs');
    await expect(pills.nth(2).locator('.pill-count')).toHaveText('1');
    // The first path is in view at the top.
    await expect(pills.nth(0)).toHaveAttribute('aria-current', 'true');
    await expect(pills.nth(1)).not.toHaveAttribute('aria-current', 'true');
    // Above the search row, which still works.
    const [navBox, searchBox] = await Promise.all([nav.boundingBox(), page.locator('#labSearch').boundingBox()]);
    expect(navBox!.y).toBeLessThan(searchBox!.y);
    await page.locator('#labSearch').fill('Weekend');
    await expect(page.locator('#labCount')).toHaveText(`1 of ${LABS.length} labs`);
  });

  test('a pill scrolls to its path and marks it, and scrolling on moves the mark', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { height: 700 });
    const pills = page.locator('a.path-pill');
    const launcherTop = () => page.evaluate(() => document.getElementById('launcher')!.getBoundingClientRect().top);
    const topOf = (slug: string) => page.evaluate((s) => document.querySelector(`.lab-group[data-path="${s}"]`)!.getBoundingClientRect().top, slug);

    await pills.nth(1).click();
    await expect(pills.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(pills.nth(0)).not.toHaveAttribute('aria-current', 'true');
    // The path's band ends up just under the sticky navigator.
    await expect.poll(async () => Math.round((await topOf('ai-platform')) - (await launcherTop())), { timeout: 5000 }).toBeLessThan(140);
    await expect.poll(async () => Math.round((await topOf('ai-platform')) - (await launcherTop())), { timeout: 5000 }).toBeGreaterThanOrEqual(0);
    // Focus moved to the heading, so a screen reader announces where it landed.
    await expect(page.locator('.lab-group[data-path="ai-platform"] > h2.group-head')).toBeFocused();

    // The reader's own scrolling takes over at once, without waiting for the jump to settle:
    // to the end of the page, then back to the top.
    await page.mouse.move(720, 400);
    await page.mouse.wheel(0, 100_000);
    await expect(pills.nth(2)).toHaveAttribute('aria-current', 'true');
    await expect(pills.nth(1)).not.toHaveAttribute('aria-current', 'true');
    await page.mouse.wheel(0, -100_000);
    await expect(pills.nth(0)).toHaveAttribute('aria-current', 'true');
    // Scrolling by script (no wheel, key or touch) moves it too once the page has settled.
    await pills.nth(1).click();
    await expect(pills.nth(1)).toHaveAttribute('aria-current', 'true');
    // Let the smooth scroll finish (how long it takes depends on how far the path is), then the page has settled.
    let last = -1;
    for (let i = 0; i < 40; i++) {
      const top = await page.evaluate(() => document.getElementById('launcher')!.scrollTop);
      if (top === last) break;
      last = top;
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(400);
    await page.evaluate(() => { document.getElementById('launcher')!.scrollTop = 0; });
    await expect(pills.nth(0)).toHaveAttribute('aria-current', 'true');
  });

  test('works from the keyboard: Tab reaches a pill, Enter follows it', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { height: 700 });
    const pill = page.locator('a.path-pill[data-path="ai-platform"]');
    await pill.focus();
    await expect(pill).toBeFocused();
    // A visible focus ring, from the keyboard.
    const outline = await pill.evaluate((el) => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThan(0);
    await page.keyboard.press('Enter');
    await expect(page.locator('.lab-group[data-path="ai-platform"] > h2.group-head')).toBeFocused();
    await expect(pill).toHaveAttribute('aria-current', 'true');
    // Tab goes on to the next pill, not back to the top of the page.
    await pill.focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('a.path-pill[data-path=""]')).toBeFocused();
  });

  test('with reduced motion the jump is immediate', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubLabs(page);
    await openLauncher(page, { height: 700 });
    await page.locator('a.path-pill[data-path="ai-platform"]').click();
    const gap = await page.evaluate(() => document.querySelector('.lab-group[data-path="ai-platform"]')!.getBoundingClientRect().top - document.getElementById('launcher')!.getBoundingClientRect().top);
    expect(gap).toBeLessThan(140);
    expect(gap).toBeGreaterThanOrEqual(0);
    // Nothing moves on its own: no animation or transition is left running on the launcher.
    const moving = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && !((a as CSSAnimation).animationName ?? '').includes('spin')).length);
    expect(moving).toBe(0);
  });

  test('a single group has no navigator', async ({ page }) => {
    await stubLabs(page, [lab({ slug: 'only', title: 'Only lab' })]);
    await openLauncher(page);
    await expect(page.locator('#pathNav')).toBeHidden();
    await expect(page.locator('.lab-group')).toHaveCount(1);
  });
});

test.describe('search and filters over paths and modules', () => {
  test('hide the labs, then the modules and paths left empty, and say "n of N labs"', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    await expect(page.locator('#labCount')).toHaveText(`${LABS.length} of ${LABS.length} labs`);

    await page.locator('#labSearch').fill('replicas');
    await expect(page.locator('#labCount')).toHaveText(`1 of ${LABS.length} labs`);
    await expect(row(page, 'r1')).toBeVisible();
    await expect(card(page, 'ai-platform', 5)).toBeVisible();
    await expect(card(page, 'ai-platform', 1)).toBeHidden();
    await expect(card(page, 'ai-platform', 2)).toBeHidden();
    await expect(section(page, 'production-agents')).toBeHidden();
    await expect(section(page, '')).toBeHidden();
    await expect(section(page, 'ai-platform')).toBeVisible();
    // The navigator follows: a hidden path loses its pill, the shown one counts what is shown.
    await expect(page.locator('a.path-pill[data-path="production-agents"]')).toBeHidden();
    await expect(page.locator('a.path-pill[data-path="ai-platform"] .pill-count')).toHaveText('1');
    await expect(page.locator('a.path-pill[data-path="ai-platform"]')).toHaveAttribute('aria-current', 'true');

    await page.locator('#labSearch').fill('zzz nothing');
    await expect(page.locator('#labCount')).toHaveText(`0 of ${LABS.length} labs`);
    await expect(page.locator('#labNoMatch')).toBeVisible();
    await expect(page.locator('.lab-group:visible')).toHaveCount(0);
    await expect(page.locator('#pathNav')).toBeHidden();

    await page.locator('#btnClearFilters').click();
    await expect(page.locator('#pathNav')).toBeVisible();
    await expect(page.locator('#labCount')).toHaveText(`${LABS.length} of ${LABS.length} labs`);
    await expect(page.locator('.lab-group:visible')).toHaveCount(3);
    await expect(page.locator('.module:visible')).toHaveCount(3);
  });

  test('the status and difficulty chips filter across modules, and a module keeps its own totals', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    await page.locator('button.filter-chip[data-filter="status"][data-value="done"]').click();
    // pa1, g1 and g2 are done.
    await expect(page.locator('#labCount')).toHaveText(`3 of ${LABS.length} labs`);
    await expect(card(page, 'ai-platform', 1)).toBeVisible();
    await expect(card(page, 'ai-platform', 1).locator('.lab:visible')).toHaveCount(2);
    await expect(card(page, 'ai-platform', 2)).toBeHidden();
    await expect(section(page, '')).toBeHidden();
    // Hiding labs does not change what the module says about itself.
    await expect(card(page, 'ai-platform', 1).locator('.module-meta')).toHaveText('5 labs · ~2.5 h · 1 free');
    await expect(card(page, 'ai-platform', 1).locator('.module-progress')).toHaveText('2 of 5 done');

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
    await expect(section(page, 'production-agents')).toBeHidden();
    await expect(page.locator('#labSearch')).toHaveValue('replicas');
  });
});

test.describe('headings', () => {
  test('one h1, a path h2, a module h3 and a lab h4, with no level skipped', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const outline = await page.evaluate(() =>
      [...document.querySelectorAll('#launcher h1, #launcher h2, #launcher h3, #launcher h4, #launcher h5, #launcher h6')].map((h) => ({
        level: Number(h.tagName[1]),
        parent: (h.parentElement as HTMLElement).className,
        text: (h.textContent ?? '').trim(),
      })),
    );
    const levels = outline.map((h) => h.level);
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    // Going down the page a heading is at most one level deeper than the one before it.
    levels.forEach((l, i) => {
      if (i > 0) expect(l, `${outline[i]!.text} follows ${outline[i - 1]!.text}`).toBeLessThanOrEqual(levels[i - 1]! + 1);
    });
    expect(levels.filter((l) => l === 2)).toHaveLength(3);
    expect(levels.filter((l) => l === 4)).toHaveLength(LABS.length);
    // Path h2 sit directly in their section; module h3 are the cards' titles.
    await expect(page.locator('.lab-group > h2')).toHaveCount(3);
    await expect(page.locator('.module h3.module-title')).toHaveCount(3);
    await expect(page.locator('.lab h4.lab-title')).toHaveCount(LABS.length);
    await expect(page.locator('.lab h2, .lab h3, .module h2, .lab-group h5')).toHaveCount(0);
  });

  test('a section and a card are named by their heading', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    await expect(page.getByRole('region', { name: pathMeta('ai-platform').title })).toBeVisible();
    await expect(page.getByRole('region', { name: moduleMeta('ai-platform', 2).title })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: moduleMeta('ai-platform', 1).title })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: `Labs done in ${moduleMeta('ai-platform', 1).title}` })).toHaveAttribute('aria-valuenow', '2');
  });
});

test.describe('states', () => {
  test('shows skeletons while loading, without the navigator or filters', async ({ page }) => {
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
    await expect(page.locator('#pathNav')).toBeHidden();
    await expect(page.locator('#labFilters')).toBeHidden();
    release();
    await expect(row(page, 'g1')).toBeVisible();
    await expect(page.locator('.lab-skeleton')).toHaveCount(0);
    await expect(page.locator('#labList')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#pathNav')).toBeVisible();
  });

  test('shows the signed-out state on a 401, with no navigator', async ({ page }) => {
    await page.route('**/api/labs', (route) => route.fulfill({ status: 401, json: { error: 'not signed in' } }));
    await openLauncher(page);
    await expect(page.locator('#signedOut')).toContainText('You are signed out');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.locator('.lab-group')).toHaveCount(0);
    await expect(page.locator('#pathNav')).toBeHidden();
  });

  test('shows the error state on a failure and recovers on Try again', async ({ page }) => {
    let fail = true;
    await page.route('**/api/labs', (route) => (fail ? route.fulfill({ status: 500, json: { error: 'boom' } }) : route.fulfill({ json: LABS })));
    await openLauncher(page);
    await expect(page.locator('#labList .error')).toContainText('Could not load labs');
    await expect(page.locator('#pathNav')).toBeHidden();
    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(row(page, 'g1')).toBeVisible();
    await expect(page.locator('#pathNav')).toBeVisible();
  });

  test('shows the empty state when nothing is published', async ({ page }) => {
    await stubLabs(page, []);
    await openLauncher(page);
    await expect(page.locator('#labList .empty-state')).toContainText('No labs are available yet');
    await expect(page.locator('#pathNav')).toBeHidden();
  });

  test('copes with catalogue data the copy does not describe', async ({ page }) => {
    await stubLabs(page, [
      lab({ slug: 'n1', title: 'New path lab', path: 'brand-new-path', module: 1, order: 1 }),
      lab({ slug: 'n2', title: 'Second in a new module', path: 'brand-new-path', module: 2, order: 1 }),
      lab({ slug: 'p1', title: 'Known path, module the copy lacks', path: 'ai-platform', module: 9, order: 1 }),
    ]);
    await openLauncher(page);
    // Known paths first, then the unknown; the humanised slug stands in for a title and there is no intro.
    await expect(page.locator('.lab-group > h2')).toHaveText([pathMeta('ai-platform').title, 'Brand new path']);
    await expect(section(page, 'brand-new-path').locator('.path-intro')).toHaveCount(0);
    await expect(section(page, 'brand-new-path').locator('.module h3')).toHaveText(['Module 1', 'Module 2']);
    await expect(card(page, 'ai-platform', 9).locator('h3')).toHaveText('Module 9');
    await expect(card(page, 'ai-platform', 9).locator('.skills-label')).toHaveCount(0);
  });
});

test.describe('themes and small screens', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`renders in the ${scheme} theme with the accent of each path and module`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await stubLabs(page);
      await openLauncher(page);
      const band = section(page, 'ai-platform');
      // The path band and each module carry an accent; the tint of the band's icon is not the page colour.
      const accents = await page.locator('.lab-group[data-accent], .module[data-accent]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.accent));
      expect(accents.length).toBe(3 + 3);
      const bg = await band.locator('> .path-tile').evaluate((el) => getComputedStyle(el).backgroundColor);
      const page_ = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).not.toBe(page_);
      // The module panel is on its family's tint too, not on the card colour.
      const panel = await card(page, 'ai-platform', 1).locator('.module-info').evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(panel).not.toBe(page_);
      // Body text on the tinted band is the console's normal text colour, never the accent.
      const [intro, ink2, accentInk] = await band.locator('.path-intro').evaluate((el) => {
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
    });
  }

  test('at phone width nothing overflows sideways, the header fits, and touch targets are 44px', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { width: 390, height: 844 });
    const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth, body: document.body.scrollWidth - window.innerWidth }));
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.body).toBeLessThanOrEqual(0);

    // The header is one slim pill: the brand and a menu button, which opens the rest inside the pill.
    const headerRight = () => page.evaluate(() => Math.max(...[...document.querySelectorAll('.bar *')].filter((el) => (el as HTMLElement).offsetParent !== null).map((el) => el.getBoundingClientRect().right)));
    await expect(page.locator('#btnMenu')).toBeVisible();
    await expect(page.locator('#btnMenu')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#btnSignOut')).toBeHidden();
    expect(await headerRight()).toBeLessThanOrEqual(390);
    await page.locator('#btnMenu').click();
    await expect(page.locator('#btnMenu')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#btnSignOut')).toBeVisible();
    await expect(page.locator('#btnHelp')).toBeVisible();
    await expect(page.locator('#btnTheme')).toBeVisible();
    // Every header control ends inside the viewport (the identity text is dropped below 520px).
    expect(await headerRight()).toBeLessThanOrEqual(390);
    await expect(page.locator('#identity')).toBeHidden();

    const size = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
    for (const selector of ['.lab-start', 'a.path-pill', 'button.filter-chip', '#btnSignOut', '#btnTheme', '#btnHelp', '#btnMenu', '.lab-more > summary', '#labSearch']) {
      const box = await size(selector);
      expect(box.height, `${selector} height`).toBeGreaterThanOrEqual(44);
    }
    expect((await size('#btnTheme')).width).toBeGreaterThanOrEqual(44);
    expect((await size('#btnMenu')).width).toBeGreaterThanOrEqual(44);
    // Escape closes the menu and puts focus back on its button.
    await page.keyboard.press('Escape');
    await expect(page.locator('#btnMenu')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#btnMenu')).toBeFocused();
    await expect(page.locator('#btnSignOut')).toBeHidden();
    // A module card is one column, and a lab row keeps its Start button inside the card.
    const c = card(page, 'ai-platform', 1);
    await c.scrollIntoViewIfNeeded();
    const [cardBox, startBox, titleBox] = await Promise.all([c.boundingBox(), c.locator('.lab-start').first().boundingBox(), c.locator('.module-title').boundingBox()]);
    expect(startBox!.x + startBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
    expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
  });

  test('at desktop width a module puts its labs beside its info; below ~1080px they stack', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page, { width: 1440, height: 900 });
    const c = card(page, 'ai-platform', 1);
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
  test('a row says Start, Open again or Locked, and the hero asks for the next lab when nothing is running', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    await expect(page.locator('#heroTitle')).toHaveText('Pick your next lab.');
    await expect(page.locator('#resumeCard')).toBeHidden();
    await expect(page.locator('#heroLede')).toHaveText(/^Two paths, each a run of hands-on labs\. Start with an explore lab/);
    await expect(row(page, 'g1').locator('.lab-start')).toHaveText('Open again');
    await expect(row(page, 'g5').locator('.lab-start')).toHaveText('Start');
    await expect(row(page, 't2').locator('.lab-start')).toHaveText('Locked');
    // A done row shows a check in its circle (the number stays in the markup), an open one its number.
    await expect(row(page, 'g1').locator('.lab-num')).toHaveText('1');
    await expect(row(page, 'g1')).toHaveClass(/lab-done/);
  });

  test('the big number, the icon tile and the skills sit on the module panel, and the path has its icon tile and totals', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const c = card(page, 'ai-platform', 2);
    await expect(c.locator('.module-bignum')).toHaveText('02');
    await expect(c.locator('.module-bignum')).toHaveAttribute('aria-hidden', 'true');
    await expect(c.locator('.module-tile svg')).toBeVisible();
    await expect(section(page, 'ai-platform').locator('.path-summary b')).toHaveText('8 labs');
  });

  test('the header is the landing page\'s pill: brand, Labs, Paths, Help, theme, sign out', async ({ page }) => {
    await stubLabs(page);
    await openLauncher(page);
    const nav = page.getByRole('navigation', { name: 'Console' });
    await expect(page.locator('.brand')).toContainText('opalix');
    await expect(page.locator('.brand .beta-tag')).toHaveText('LABS');
    await expect(nav.getByRole('link', { name: 'Labs' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('button', { name: 'Help' })).toBeVisible();
    await expect(page.locator('#identityInitials')).toHaveText('CO');
    const radius = await page.locator('.nav').evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    expect(parseFloat(radius)).toBeGreaterThan(40);
    // Paths goes to the path navigator, and focus lands on its first pill.
    await nav.getByRole('link', { name: 'Paths' }).click();
    await expect(page.locator('a.path-pill').first()).toBeFocused();
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
    expect(await family('.lab-sub .chip')).toContain('JetBrains Mono');
  });
});

test.describe('a path with many modules', () => {
  const MANY: Array<Record<string, unknown>> = [1, 2, 3, 4, 5, 6, 7].map((n) => lab({ slug: `m${n}`, title: `Lab of module ${n}`, path: 'ai-platform', module: n, order: 1, estimated_minutes: 20 }));

  test('opens the first two modules, condenses the rest to cards, and opens one on demand', async ({ page }) => {
    await stubLabs(page, MANY);
    await openLauncher(page);
    await expect(page.locator('.module')).toHaveCount(7);
    // Every module is still in the page; only the later ones show as a card.
    await expect(page.locator('.module[data-collapsed="1"]')).toHaveCount(5);
    await expect(card(page, 'ai-platform', 1).locator('.module-info')).toBeVisible();
    await expect(card(page, 'ai-platform', 2).locator('.lab')).toBeVisible();
    const mini = card(page, 'ai-platform', 5).getByRole('button', { name: /Module 5/ });
    await expect(mini).toBeVisible();
    await expect(mini).toHaveAttribute('aria-expanded', 'false');
    await expect(card(page, 'ai-platform', 5).locator('.lab')).toBeHidden();
    await mini.click();
    await expect(card(page, 'ai-platform', 5).locator('.lab')).toBeVisible();
    await expect(card(page, 'ai-platform', 5).locator('h3.module-title')).toBeFocused();
    await expect(page.locator('.module[data-collapsed="1"]')).toHaveCount(4);
  });

  test('a search opens every module that has a match', async ({ page }) => {
    await stubLabs(page, MANY);
    await openLauncher(page);
    await page.locator('#labSearch').fill('module 6');
    await expect(card(page, 'ai-platform', 6)).toBeVisible();
    await expect(card(page, 'ai-platform', 6).locator('.lab')).toBeVisible();
    await expect(card(page, 'ai-platform', 4)).toBeHidden();
    await page.locator('#btnClearFilters').click();
    await expect(card(page, 'ai-platform', 6).locator('.lab')).toBeHidden();
  });

  test('a module with a lab under way opens by itself', async ({ page }) => {
    await stubLabs(page, MANY.map((l) => (l.slug === 'm6' ? { ...l, progress: started } : l)) as unknown[]);
    await openLauncher(page);
    await expect(card(page, 'ai-platform', 6).locator('.lab')).toBeVisible();
    await expect(card(page, 'ai-platform', 5).locator('.lab')).toBeHidden();
  });
});
