import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { serveConsole } from './console-server';

/**
 * The learner's skills, awards and personal path.
 *
 * What is pinned here:
 *   - /profile: the level and XP, the streak, the overall score, a card per skill (ring, level name, the plain
 *     evaluation, labs done, "Next lab"), and the awards shelf (earned, then locked with `have/need`), for a new
 *     learner, one part-way and one at the top;
 *   - Home: the "Your progress" band above the path cards (and its empty state), and the "Your path" band;
 *   - the award toast (a polite live region, confetti only when motion is allowed) and the result card's line;
 *   - /paths/mine: the steps in the service's order with their state in words, Recompute, Change my goal;
 *   - the quiz's two last questions and the body sent to PUT /api/path-inputs;
 *   - headings, landmarks, keyboard, 390px, light and dark, and the words (no platform words on these screens).
 *
 * Like 16 to 20 this needs no password, no API and no container: a static server with the Worker's
 * single-page-application fallback serves dashboard/public, and every call the console makes is answered by a
 * route stub. Run `npm run build:dashboard` first.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC = join(ROOT, 'dashboard/public');
const API = 'https://opalix-sandbox.soubenz94.workers.dev';
const SESSION_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const TOKEN = 'test-token';

// --------------------------------------------------------------- the content

const onboarding = JSON.parse(readFileSync(join(ROOT, 'packages/catalogue/onboarding.json'), 'utf8')) as {
  intro: string;
  questions: Array<{ id: string; concept: string; prompt: string; options: Array<{ id: string; text: string }>; answer: string[]; explanation: string; level?: string }>;
};
const concepts = JSON.parse(readFileSync(join(ROOT, 'packages/catalogue/concepts.json'), 'utf8')) as { areas: Record<string, { title: string; module: number }> };
const AREAS = Object.entries(concepts.areas)
  .map(([area, a]) => ({ area, title: a.title, module: a.module }))
  .sort((a, b) => a.module - b.module);
const probe = (area: string, level: 'basic' | 'advanced') => onboarding.questions.find((q) => q.concept.startsWith(`${area}.`) && q.level === level)!;

const lab = (o: Record<string, unknown>) => ({
  version: '1.0.0',
  type: 'build',
  family: 'gateway',
  summary: `About ${o.slug}`,
  objectives: ['do the thing'],
  difficulty: 'intro',
  timeout_minutes: 30,
  estimated_minutes: 20,
  tier: 'free',
  path: 'ai-platform',
  module: 1,
  order: 1,
  has_learn: false,
  progress: null,
  ...o,
});
const LABS = [
  lab({ slug: 'see-what-a-gateway-does', title: 'See what a gateway does', order: 1 }),
  lab({ slug: 'add-a-model-without-touching-app-code', title: 'Add a model without touching app code', order: 2 }),
  lab({ slug: 'one-endpoint-one-key', title: 'One endpoint, one key', order: 3 }),
  lab({ slug: 'route-by-intent', title: 'Route by intent', order: 4 }),
  lab({ slug: 'guard-the-spend', title: 'Guard the spend', order: 5 }),
  lab({ slug: 'retrieve-with-citations', title: 'Retrieve with citations', order: 6 }),
  lab({ slug: 'a-pro-only-lab', title: 'A pro only lab', order: 7, tier: 'pro' }),
];

// ------------------------------------------------------------ the learner's data

type Award = { id: string; title: string; description: string; icon: string; tier: 'bronze' | 'silver' | 'gold'; earned_at?: number; session_id?: string; progress?: { have: number; need: number } };

const skill = (area: string, o: Record<string, unknown>) => ({
  area,
  title: concepts.areas[area]!.title,
  score: 0,
  level: 'Not started',
  evaluation: `You have not started ${concepts.areas[area]!.title} yet. Begin with "A first lab".`,
  labs_done: 0,
  labs_total: 4,
  next_lab: { slug: 'see-what-a-gateway-does', title: 'See what a gateway does' },
  starting_level: null,
  ...o,
});

const EARNED_AT = 1767700000000;
const LOCKED: Award[] = [
  { id: 'ten-labs', title: 'Ten down', description: 'Finish ten labs.', icon: 'trophy', tier: 'silver', progress: { have: 3, need: 10 } },
  { id: 'streak-7', title: 'A full week', description: 'Finish a lab on seven days in a row.', icon: 'flame', tier: 'gold', progress: { have: 2, need: 7 } },
];

const NEW_LEARNER = {
  user_id: 'console',
  xp: 0,
  level: { n: 1, title: 'Newcomer', xp_into: 0, xp_needed: 100 },
  streak: { days: 0, best: 0, last_active: null },
  skills: AREAS.map((a) => skill(a.area, {})),
  awards: {
    earned: [] as Award[],
    locked: [{ id: 'first-lab', title: 'First steps', description: 'Finish your first lab.', icon: 'flag', tier: 'bronze', progress: { have: 0, need: 1 } }, ...LOCKED.map((a) => ({ ...a, progress: { have: 0, need: a.progress!.need } }))] as Award[],
  },
  overall: { score: 0, level: 'Not started', evaluation: 'Overall you have not started yet. Finish a lab to begin your score.' },
  updated_at: EARNED_AT,
};

const MID_LEARNER = {
  user_id: 'console',
  xp: 275,
  level: { n: 3, title: 'Apprentice', xp_into: 25, xp_needed: 250 },
  streak: { days: 2, best: 4, last_active: '2026-01-06' },
  skills: AREAS.map((a, i) =>
    skill(
      a.area,
      i === 0
        ? {
            score: 67,
            level: 'Proficient',
            evaluation: 'You are confident in LLM gateway: 3 of 6 labs finished, with strong results. Next up: "One endpoint, one key".',
            labs_done: 3,
            labs_total: 6,
            next_lab: { slug: 'one-endpoint-one-key', title: 'One endpoint, one key' },
            starting_level: 'ok',
          }
        : i === 1
          ? { score: 34, level: 'Practitioner', evaluation: 'You are building skill in Tools and MCP. Next up: "Route by intent".', labs_done: 1, labs_total: 5, next_lab: { slug: 'route-by-intent', title: 'Route by intent' } }
          : i === 2
            ? { score: 12, level: 'Foundations', evaluation: 'You have made a start in Retrieval.', labs_done: 1, labs_total: 6, next_lab: { slug: 'retrieve-with-citations', title: 'Retrieve with citations' } }
            : i === 3
              ? { score: 0, level: 'Not started', labs_done: 0, labs_total: 0, next_lab: null, evaluation: 'There are no labs in Observability yet.' }
              : i === 4
                ? { score: 90, level: 'Expert', evaluation: 'You have finished every lab in Platform.', labs_done: 4, labs_total: 4, next_lab: null }
                : {}
    )
  ),
  awards: {
    earned: [
      { id: 'streak-3', title: 'On a roll', description: 'Finish a lab on three days in a row.', icon: 'flame', tier: 'silver', earned_at: EARNED_AT, session_id: 's2' },
      { id: 'first-lab', title: 'First steps', description: 'Finish your first lab.', icon: 'flag', tier: 'bronze', earned_at: EARNED_AT - 86_400_000 * 3, session_id: 's1' },
      { id: 'quick', title: 'Quick study', description: 'Finish a lab without a hint.', icon: 'bolt', tier: 'bronze', earned_at: EARNED_AT - 86_400_000 * 4, session_id: 's1' },
      { id: 'tidy', title: 'Tidy work', description: 'Pass every check on the first run.', icon: 'star', tier: 'bronze', earned_at: EARNED_AT - 86_400_000 * 5, session_id: 's1' },
    ] as Award[],
    locked: LOCKED,
  },
  overall: { score: 11, level: 'Foundations', evaluation: 'Overall you are at Foundations level. Keep going: a few more labs will move your score.' },
  updated_at: EARNED_AT,
};

const TOP_LEARNER = {
  user_id: 'console',
  xp: 5200,
  level: { n: 10, title: 'Legend', xp_into: 600, xp_needed: 0 },
  streak: { days: 30, best: 30, last_active: '2026-01-06' },
  skills: AREAS.map((a) => skill(a.area, { score: 92, level: 'Expert', evaluation: `You have finished every lab in ${a.title}, with excellent results.`, labs_done: 5, labs_total: 5, next_lab: null })),
  awards: {
    earned: [
      { id: 'all-labs', title: 'Every lab', description: 'Finish every lab.', icon: 'medal', tier: 'gold', earned_at: EARNED_AT, session_id: 's9' },
      { id: 'ten-labs', title: 'Ten down', description: 'Finish ten labs.', icon: 'trophy', tier: 'silver', earned_at: EARNED_AT - 1000, session_id: 's8' },
      { id: 'first-lab', title: 'First steps', description: 'Finish your first lab.', icon: 'flag', tier: 'bronze', earned_at: EARNED_AT - 2000, session_id: 's1' },
    ] as Award[],
    locked: [] as Award[],
  },
  overall: { score: 92, level: 'Expert', evaluation: 'Overall you are at Expert level.' },
  updated_at: EARNED_AT,
};

type Profile = typeof MID_LEARNER;
const compact = (p: Profile) => ({
  user_id: p.user_id,
  overall: p.overall,
  level: p.level,
  xp: p.xp,
  streak: p.streak,
  top_skills: [...p.skills].sort((a, b) => b.score - a.score).slice(0, 3).map(({ area, title, score, level }) => ({ area, title, score, level })),
  recent_awards: p.awards.earned.slice(0, 3).map(({ id, title, description, icon, tier, earned_at }) => ({ id, title, description, icon, tier, earned_at })),
  updated_at: p.updated_at,
});

const step = (slug: string, title: string, status: string, o: Record<string, unknown> = {}) => ({ slug, title, area: 'gateway', why: `Why ${title}.`, estimated_minutes: 30, status, ...o });
const PATH_A = {
  steps: [
    step('see-what-a-gateway-does', 'See what a gateway does', 'done', { estimated_minutes: 20, why: 'You have already finished this lab.' }),
    step('add-a-model-without-touching-app-code', 'Add a model without touching app code', 'next', { why: 'A first step into LLM gateway, which is new to you.' }),
    step('one-endpoint-one-key', 'One endpoint, one key', 'upcoming'),
    step('route-by-intent', 'Route by intent', 'upcoming', { area: 'mcp', estimated_minutes: 45 }),
    step('guard-the-spend', 'Guard the spend', 'upcoming'),
    step('retrieve-with-citations', 'Retrieve with citations', 'upcoming', { area: 'rag' }),
    step('a-pro-only-lab', 'A pro only lab', 'locked', { why: 'Included with the Pro plan.', lock: 'plan' }),
  ],
  total_minutes: 165,
  weeks_estimate: 2,
  goal: { text: 'Run our gateway', kind: 'role-ready' },
  source: 'ai',
  generated_at: EARNED_AT,
};
const PRICING = 'https://opalix-site.soubenz94.workers.dev/#pricing';
/** Every kind of locked step: a plan lock, a lock behind another lab, and two from before `lock` existed. */
const PATH_LOCKS = {
  ...PATH_A,
  steps: [
    PATH_A.steps[0]!,
    PATH_A.steps[1]!,
    step('plan-locked-lab', 'Plan locked lab', 'locked', { why: 'Included with the Pro plan.', lock: 'plan' }),
    step('waits-for-a-lab', 'Waits for a lab', 'locked', { why: 'Unlocks after Plan locked lab.', lock: 'prerequisite' }),
    step('old-plan-lock', 'Old plan lock', 'locked', { why: 'Included with the Pro plan.' }),
    step('old-other-lock', 'Old other lock', 'locked', { why: 'Something else holds this one.' }),
  ],
};
/** The same labs in another order, with the next one finished: what Recompute and a saved goal bring back. */
const PATH_B = {
  ...PATH_A,
  steps: [
    PATH_A.steps[0]!,
    { ...PATH_A.steps[1]!, status: 'done', why: 'You have already finished this lab.' },
    { ...PATH_A.steps[5]!, status: 'next', why: 'Retrieval is where your goal needs you most.' },
    PATH_A.steps[3]!,
    PATH_A.steps[2]!,
    PATH_A.steps[4]!,
    PATH_A.steps[6]!,
  ],
  total_minutes: 135,
  weeks_estimate: 1,
  goal: { text: 'Learn retrieval', kind: 'specific-skill' },
};

// ------------------------------------------------------------- a fake console

const json = (route: Route, body: unknown, status = 200) => {
  const origin = route.request().headers()['origin'];
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {},
    body: JSON.stringify(body),
  });
};

interface Stub {
  /** The search of every GET /api/profile. */
  profileCalls: string[];
  /** What GET /api/profile answers; a number is a status to fail with. */
  profile: Profile | number;
  /** What GET /api/path answers (null: 404, no goal yet) and what a recompute or a saved goal brings back. */
  path: typeof PATH_A | null;
  next: typeof PATH_A | null;
  pathReads: number;
  recomputes: string[];
  puts: Array<Record<string, unknown>>;
  /** The status PUT /api/path-inputs answers with (200 unless a test says otherwise). */
  putStatus: number;
  starts: string[];
  /** The text of the stream: the first connection to the session's events gets it, later ones are held open. */
  events: string;
  errors: string[];
}

async function stub(page: Page, init: Partial<Stub> = {}): Promise<Stub> {
  const s: Stub = { profileCalls: [], profile: MID_LEARNER, path: PATH_A, next: PATH_B, pathReads: 0, recomputes: [], puts: [], putStatus: 200, starts: [], events: '', errors: [], ...init };
  page.on('pageerror', (err) => s.errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) s.errors.push(msg.text());
  });
  let eventsServed = 0;

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === '/api/me') return json(route, { sub: 'console', user_id: 'console' });
    if (path === '/api/sessions/active') return json(route, { sessions: [] });
    if (path === '/api/labs') return json(route, LABS);
    if (path === '/api/onboarding') return json(route, { version: 1, ...onboarding });
    if (path === '/api/learn/answers' && method === 'POST') return json(route, { ok: true, recorded: 1 }, 201);
    if (path.startsWith('/api/learn/')) return json(route, { error: { code: 'no_learn', message: 'none' } }, 404);
    if (path === '/api/profile' && method === 'GET') {
      s.profileCalls.push(url.search);
      if (typeof s.profile === 'number') return json(route, { error: 'nope' }, s.profile);
      return json(route, url.searchParams.get('compact') === '1' ? compact(s.profile) : s.profile);
    }
    if (path === '/api/path' && method === 'GET') {
      s.pathReads++;
      return s.path ? json(route, s.path) : json(route, { error: { code: 'no_inputs', message: 'none' } }, 404);
    }
    if (path === '/api/path' && method === 'POST') {
      s.recomputes.push(url.search);
      s.path = s.next ?? s.path;
      return json(route, s.path);
    }
    if (path === '/api/path-inputs' && method === 'PUT') {
      s.puts.push(JSON.parse(route.request().postData() ?? '{}'));
      if (s.putStatus !== 200) return json(route, { error: 'nope' }, s.putStatus);
      s.path = s.next ?? PATH_A;
      return json(route, s.path);
    }
    if (path === '/api/start' && method === 'POST') {
      const { lab: slug } = JSON.parse(route.request().postData() ?? '{}');
      s.starts.push(slug);
      return json(route, { id: SESSION_ID, state: 'starting', token: TOKEN, urls: { services: { echo: {} } } }, 202);
    }
    return json(route, { error: 'not stubbed' }, 404);
  });

  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const method = req.method();
    const base = `/sessions/${SESSION_ID}`;
    const cors = { 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'access-control-allow-credentials': 'true' };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (p === base && method === 'GET') {
      const now = Date.now();
      return json(route, {
        meta: { state: 'running', lab_slug: 'see-what-a-gateway-does', started_at: now, expires_at: now + 3_000_000, end_reason: null },
        services: { echo: { health: 'healthy' } },
        snapshots: [],
        cost: { usd: 0.03 },
        hints: { total: 3, schedule: [0, 12, 30], delivered: [] },
        manifest_summary: { title: 'A lab', checks: [{ name: 'support answered by a' }] },
        checks: { run_id: 'run-1', started_at: now - 500, finished_at: now, results: [{ name: 'support answered by a', pass: true, weight: 1 }] },
        checks_history: [],
        server_time: now,
      });
    }
    if (p === `${base}/events`) {
      eventsServed++;
      if (eventsServed === 1 && s.events) return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', ...cors, 'cache-control': 'no-store' }, body: s.events });
      await new Promise<void>(() => {});
    }
    if (p === `${base}/files` && method === 'GET') return json(route, [{ name: 'brief.md', size: 30, isDirectory: false }]);
    if (p === `${base}/files/brief.md` && method === 'GET') return json(route, { content: '# The brief\n' });
    if (p === `${base}/services/echo/session` && method === 'POST') return route.fulfill({ status: 204, headers: cors });
    if (p.startsWith(`${base}/services/echo/`)) return route.fulfill({ status: 200, contentType: 'text/html', headers: cors, body: '<!doctype html><h1>Echo</h1>' });
    if (p.startsWith(base) && method !== 'GET') return json(route, {}, 200);
    return json(route, { error: 'not stubbed' }, 404);
  });
  await page.routeWebSocket(/\/terminal/, () => {});
  return s;
}

const test = base.extend<object, { staticServer: string }>({
  staticServer: [
    async ({}, use) => {
      if (!existsSync(join(PUBLIC, 'dist/app.js'))) throw new Error('dashboard/public/dist/app.js is missing: run `npm run build:dashboard` first');
      const { url, server } = await serveConsole();
      await use(url);
      await new Promise((done) => server.close(done));
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ staticServer }, use) => use(staticServer),
});

// -------------------------------------------------------------------- helpers

type Mastery = { onboarding?: { status: 'done' | 'skipped' | null; at?: number; levels?: Record<string, string> } };
const SKIPPED: Mastery = { onboarding: { status: 'skipped', at: 1, levels: {} } };
const DONE: Mastery = { onboarding: { status: 'done', at: 5, levels: { gateway: 'ok', mcp: 'new', rag: 'strong', otel: 'new', platform: 'new', sovereignty: 'new' } } };

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Opens the console on an address, past the things that are other specs' business. What the page stores is seeded once per tab. */
async function visit(page: Page, path: string, { mastery = SKIPPED, remembered, goal }: { mastery?: Mastery; remembered?: string; goal?: Record<string, unknown> } = {}) {
  await page.addInitScript(
    ([m, r, g]) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('opalixOnboarded', '1');
        localStorage.setItem('opalixLearn', m as string);
        if (g) localStorage.setItem('opalixPathGoal', g as string);
        if (r) localStorage.setItem('opalix.session', JSON.stringify({ id: (r as { id: string }).id, token: 'test-token', lab: (r as { lab: string }).lab, urls: { services: { echo: {} } } }));
        sessionStorage.setItem('seeded', '1');
      }
    },
    [JSON.stringify({ v: 1, ...mastery }), remembered ? { id: SESSION_ID, lab: remembered } : null, goal ? JSON.stringify(goal) : null] as const
  );
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-booted="1"]');
}

const here_ = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search;
const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });
const host = (page: Page) => page.locator('#learnHost');
const heading = (page: Page) => host(page).locator('[data-learn-heading]');

/** The page is not wider than the window; on failure, names the elements that stick out. */
const noHorizontalScroll = async (page: Page) => {
  const over = await page.evaluate(() => {
    const width = window.innerWidth;
    const wide: string[] = [];
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== 'visible' && p.getBoundingClientRect().right <= width + 0.5) return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > width + 0.5 && !clipped(el)) wide.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String((el as HTMLElement).className).split(' ')[0]} right=${Math.round(r.right)}`);
    }
    return { extra: document.documentElement.scrollWidth - width, wide: wide.slice(0, 8) };
  });
  expect(over.extra, `sticking out: ${over.wide.join(', ')}`).toBeLessThanOrEqual(0);
};

/** Every word on the screens of this spec is a learner's: none of the platform's. */
const PLATFORM_WORDS = /\b(containers?|snapshots?|sandbox(es|ed)?|workers?|durable objects?|cloudflare|session tokens?|upstream|websockets?|API|slots?|service keys?|docker|firecracker|wrangler|D1|R2|VMs?)\b|HTTP\s*[1-5]\d\d|\b[45]\d\d: /i;
async function expectLearnerCopy(page: Page, scope = '#launcher') {
  const text = await page.locator(scope).evaluate((el) => (el as HTMLElement).innerText);
  const attrs = await page.locator(`${scope} [aria-label], ${scope} [title], ${scope} [aria-valuetext]`).evaluateAll((els) => els.map((e) => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('aria-valuetext')].filter(Boolean).join(' ')));
  const all = `${text}\n${attrs.join('\n')}`;
  expect(all.match(PLATFORM_WORDS)?.[0] ?? null, 'a platform word on a learner screen').toBeNull();
}

// =========================================================================
// the profile page
// =========================================================================

test.describe('the profile page', () => {
  test('a new learner: level 1, every skill not started, no awards yet, and what is still to earn', async ({ page }) => {
    const s = await stub(page, { profile: NEW_LEARNER as unknown as Profile });
    await page.setViewportSize(WIDE);
    await visit(page, '/profile');

    await expect(page.getByRole('heading', { level: 1, name: 'Your profile' })).toBeVisible();
    await expect(page).toHaveTitle('Your profile · Opalix labs');
    await expect(page.locator('.profile-level-name')).toHaveText('Level 1 Newcomer');
    const xp = page.getByRole('meter', { name: 'XP towards level 2' });
    await expect(xp).toHaveAttribute('aria-valuenow', '0');
    await expect(xp).toHaveAttribute('aria-valuemax', '100');
    await expect(page.locator('.xp-line')).toContainText('0 XP');
    await expect(page.locator('.xp-line')).toContainText('0 of 100 XP to level 2');
    await expect(page.locator('.streak')).toContainText('No streak yet');
    const overall = page.getByRole('meter', { name: 'Overall score' });
    await expect(overall).toHaveAttribute('aria-valuenow', '0');
    await expect(overall).toHaveAttribute('aria-valuetext', '0 out of 100, Not started');
    await expect(page.locator('.overall-eval')).toContainText('Finish a lab to begin your score');

    // Six skills, in the quiz's order, each Not started with its sentence and a way to the first lab.
    const cards = page.locator('.skill-card');
    await expect(cards).toHaveCount(6);
    await expect(cards.locator('.skill-title')).toHaveText(AREAS.map((a) => a.title));
    for (const a of AREAS) {
      const card = page.locator(`.skill-card[data-area="${a.area}"]`);
      await expect(card.locator('.level-name')).toHaveText('Not started');
      await expect(card.getByRole('meter', { name: `${a.title} score` })).toHaveAttribute('aria-valuenow', '0');
      await expect(card.locator('.skill-eval')).toContainText('You have not started');
      await expect(card.locator('.skill-labs-line')).toHaveText('0 of 4 labs done');
      await expect(card.getByRole('link', { name: /^Next lab/ })).toHaveAttribute('href', '/labs/see-what-a-gateway-does');
    }

    // Awards: none earned, a hint on how to earn one, and every award locked with how far along it is.
    await expect(page.getByRole('heading', { level: 3, name: 'Earned (0)' })).toBeVisible();
    await expect(page.locator('.awards-empty')).toContainText('Finish a lab to earn your first one');
    await expect(page.locator('#awardsEarned')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 3, name: 'Still to earn (3)' })).toBeVisible();
    const locked = page.locator('#awardsLocked .award-card');
    await expect(locked).toHaveCount(3);
    await expect(locked.first().locator('.award-title')).toHaveText('First steps');
    await expect(locked.first().locator('.award-count')).toHaveText('0/1');
    // The call was the profile's own: no user in it, and the quiz result only as a starting point.
    expect(s.profileCalls.length).toBeGreaterThan(0);
    expect(s.profileCalls.every((q) => !/user/.test(q))).toBe(true);
  });

  test('a learner part-way: the scores, the level names, the evaluations, the streak, earned awards with their date and locked ones with have/need', async ({ page }) => {
    await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/profile');

    await expect(page.locator('.profile-level-name')).toHaveText('Level 3 Apprentice');
    const xp = page.getByRole('meter', { name: 'XP towards level 4' });
    await expect(xp).toHaveAttribute('aria-valuenow', '25');
    await expect(xp).toHaveAttribute('aria-valuemax', '250');
    await expect(xp).toHaveAttribute('aria-valuetext', '25 of 250 XP to level 4');
    await expect(page.locator('.xp-line')).toContainText('275 XP');
    await expect(page.locator('.streak')).toContainText('2-day streak');
    await expect(page.locator('.streak')).toContainText('Best: 4 days');
    await expect(page.getByRole('meter', { name: 'Overall score' })).toHaveAttribute('aria-valuenow', '11');
    await expect(page.locator('.profile-overall .level-name')).toHaveText('Foundations');
    await expect(page.locator('.overall-eval')).toContainText('Overall you are at Foundations level');

    const gateway = page.locator('.skill-card[data-area="gateway"]');
    await expect(gateway.getByRole('meter', { name: 'LLM gateway score' })).toHaveAttribute('aria-valuenow', '67');
    await expect(gateway.getByRole('meter', { name: 'LLM gateway score' })).toHaveAttribute('aria-valuetext', '67 out of 100, Proficient');
    await expect(gateway.locator('.level-name')).toHaveText('Proficient');
    await expect(gateway.locator('.skill-eval')).toHaveText('You are confident in LLM gateway: 3 of 6 labs finished, with strong results. Next up: "One endpoint, one key".');
    await expect(gateway.locator('.skill-labs-line')).toHaveText('3 of 6 labs done');
    await expect(gateway.getByRole('meter', { name: 'Labs done in LLM gateway' })).toHaveAttribute('aria-valuenow', '3');
    await expect(gateway.locator('.skill-quiz')).toHaveText('Quiz starting point: Familiar');
    await expect(gateway.getByRole('link', { name: 'Next lab: One endpoint, one key' })).toHaveAttribute('href', '/labs/one-endpoint-one-key');
    // The level names, one per band.
    const names = AREAS.map((a) => page.locator(`.skill-card[data-area="${a.area}"] .level-name`));
    await expect(names[0]!).toHaveText('Proficient');
    await expect(names[1]!).toHaveText('Practitioner');
    await expect(names[2]!).toHaveText('Foundations');
    await expect(names[3]!).toHaveText('Not started');
    await expect(names[4]!).toHaveText('Expert');
    // An area with no next lab says why: nothing to do, or nothing there yet.
    await expect(page.locator('.skill-card[data-area="platform"] .skill-all-done')).toHaveText('Every lab in this area is done.');
    await expect(page.locator('.skill-card[data-area="platform"] a.skill-next')).toHaveCount(0);
    await expect(page.locator('.skill-card[data-area="otel"] .skill-labs-line')).toHaveText('No labs here yet');

    // Awards: earned first, newest first, each with a title, what it was for, its tier in words and the day.
    const earned = page.locator('#awardsEarned .award-card');
    await expect(earned).toHaveCount(4);
    await expect(earned.locator('.award-title')).toHaveText(['On a roll', 'First steps', 'Quick study', 'Tidy work']);
    const first = earned.first();
    await expect(first.locator('.award-desc')).toHaveText('Finish a lab on three days in a row.');
    await expect(first.locator('.award-tier')).toHaveText('Silver award');
    await expect(first.locator('time')).toHaveText(/\w{3} \d{1,2}, 2026/);
    await expect(first.locator('time')).toHaveAttribute('datetime', /^2026-01-0\d/);
    await expect(earned.nth(1).locator('.award-tier')).toHaveText('Bronze award');
    await expect(earned.first()).toHaveAttribute('data-tier', 'silver');
    // Locked ones come after, dimmer, with their progress as numbers and as a meter.
    const locked = page.locator('#awardsLocked .award-card');
    await expect(locked).toHaveCount(2);
    await expect(locked.first()).toHaveAttribute('data-state', 'locked');
    await expect(locked.first().locator('.award-title')).toHaveText('Ten down');
    await expect(locked.first().locator('.award-count')).toHaveText('3/10');
    const meter = locked.first().getByRole('meter', { name: 'Progress towards Ten down' });
    await expect(meter).toHaveAttribute('aria-valuenow', '3');
    await expect(meter).toHaveAttribute('aria-valuemax', '10');
    await expect(meter).toHaveAttribute('aria-valuetext', '3 of 10');
    await expect(locked.nth(1).locator('.award-tier')).toHaveText('Gold award');
    await expect(locked.first().locator('.award-meta')).toContainText('Not earned yet');
    const order = await page.evaluate(() => {
      const shelf = document.querySelector('#awardsEarned')!;
      const rest = document.querySelector('#awardsLocked')!;
      return Boolean(shelf.compareDocumentPosition(rest) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(order).toBe(true);
  });

  test('a learner at the top: the last level, every skill Expert, a gold award, nothing left to earn', async ({ page }) => {
    await stub(page, { profile: TOP_LEARNER as unknown as Profile });
    await page.setViewportSize(WIDE);
    await visit(page, '/profile');
    await expect(page.locator('.profile-level-name')).toHaveText('Level 10 Legend');
    await expect(page.getByRole('meter', { name: 'XP' })).toHaveAttribute('aria-valuetext', 'Top level reached');
    await expect(page.locator('.xp-line')).toContainText('Top level reached');
    await expect(page.locator('.streak')).toContainText('30-day streak');
    await expect(page.locator('.skill-card .level-name')).toHaveText(AREAS.map(() => 'Expert'));
    await expect(page.locator('.skill-card .skill-all-done')).toHaveCount(6);
    await expect(page.getByRole('meter', { name: 'Overall score' })).toHaveAttribute('aria-valuenow', '92');
    const gold = page.locator('#awardsEarned .award-card[data-tier="gold"]');
    await expect(gold).toHaveCount(1);
    await expect(gold.locator('.award-tier')).toHaveText('Gold award');
    await expect(page.getByRole('heading', { level: 3, name: 'Earned (3)' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: /Still to earn/ })).toHaveCount(0);
  });

  test('passes the quiz result as a starting point (and only that), never a user', async ({ page }) => {
    const s = await stub(page);
    await visit(page, '/profile', { mastery: DONE });
    await expect.poll(() => s.profileCalls.length).toBeGreaterThan(0);
    const query = new URLSearchParams(s.profileCalls[0]);
    expect(query.get('starting')).toBe('gateway:ok,mcp:new,rag:strong,otel:new,platform:new,sovereignty:new');
    expect(query.has('compact')).toBe(false);
    expect([...query.keys()].sort()).toEqual(['starting']);
  });

  test('says so in plain words when the profile cannot be read, and tries again', async ({ page }) => {
    const s = await stub(page, { profile: 500 });
    await visit(page, '/profile');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Could not load your profile. Something went wrong on our side. Please try again in a moment.');
    await expect(page.locator('.skill-card')).toHaveCount(0);
    s.profile = MID_LEARNER;
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('.skill-card')).toHaveCount(6);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(s.errors).toEqual([]);
  });

  test('the header link, the breadcrumb and the heading: a nav landmark, Home > Profile, focus on the heading', async ({ page }) => {
    await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/');
    const link = page.locator('#navProfile');
    await expect(link).toHaveText('Profile');
    await expect(link).toHaveAttribute('href', '/profile');
    await expect(page.locator('#navLabs')).toHaveAttribute('aria-current', 'page');
    await link.click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Your profile' })).toBeFocused();
    await expect(link).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#navLabs')).not.toHaveAttribute('aria-current', 'page');
    await expect(page).toHaveTitle('Your profile · Opalix labs');
    const items = crumbs(page).getByRole('listitem');
    await expect(items).toHaveText(['Home', 'Profile']);
    await expect(crumbs(page).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    await expect(crumbs(page).locator('[aria-current="page"]')).toHaveText('Profile');
    await expect(page.locator('#routeLive')).toHaveText('Your profile');
    // Back to Home through the trail, and Back/Forward keep the page.
    await crumbs(page).getByRole('link', { name: 'Home' }).click();
    await expect(page.locator('#heroTitle')).toBeVisible();
    await page.goBack();
    await expect(page.locator('.profile-level-name')).toBeVisible();
    // A skill's button opens that lab's own page.
    await page.locator('.skill-card[data-area="gateway"]').getByRole('link', { name: /^Next lab/ }).click();
    await expect(page).toHaveURL(/\/labs\/one-endpoint-one-key$/);
    await expect(page.locator('.lab-detail-title')).toHaveText('One endpoint, one key');
  });

  test('headings run h1 > h2 > h3, every meter is named, and the page works from the keyboard', async ({ page }) => {
    await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/profile');
    await expect(page.locator('.skill-card')).toHaveCount(6);

    const outline = await page.locator('#labList').evaluate((root) => [...root.querySelectorAll('h1, h2, h3, h4')].map((h) => `${h.tagName.toLowerCase()}:${h.textContent!.trim()}`));
    expect(outline[0]).toBe('h1:Your profile');
    expect(outline.filter((h) => h.startsWith('h1:'))).toHaveLength(1);
    expect(outline.filter((h) => h.startsWith('h2:'))).toEqual(['h2:Level 3 Apprentice', 'h2:Overall score', 'h2:Your skills', 'h2:Awards']);
    // A level never skips a step down: a h3 only after a h2, a h4 only after a h3.
    let at = 0;
    for (const h of outline) {
      const level = Number(h[1]);
      expect(level, h).toBeLessThanOrEqual(at + 1);
      at = level;
    }
    // Every meter and every region has a name; no meter is only a picture.
    const unnamed = await page.locator('[role="meter"]').evaluateAll((els) => els.filter((e) => !e.getAttribute('aria-label') || e.getAttribute('aria-valuenow') === null).length);
    expect(unnamed).toBe(0);
    const regions = await page.locator('#labList section').evaluateAll((els) => els.filter((e) => !e.getAttribute('aria-labelledby') && !e.getAttribute('aria-label')).length);
    expect(regions).toBe(0);
    // A level is a word, not only a colour.
    for (const chip of await page.locator('.skill-card .level-name').all()) expect((await chip.innerText()).trim().length).toBeGreaterThan(0);

    // Keyboard: Tab reaches the first "Next lab" link, and Enter opens the lab.
    const first = page.locator('.skill-card[data-area="gateway"]').getByRole('link', { name: /^Next lab/ });
    await first.focus();
    await expect(first).toBeFocused();
    const ring = await first.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(ring).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/labs\/one-endpoint-one-key$/);
  });

  test('on a phone: nothing sticks out sideways, the cards stack, the buttons are touch-sized', async ({ page }) => {
    await stub(page);
    await page.setViewportSize(PHONE);
    await visit(page, '/profile');
    await expect(page.locator('.skill-card')).toHaveCount(6);
    await noHorizontalScroll(page);
    const xs = await page.locator('.skill-card').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(xs).size).toBe(1);
    const box = await page.locator('.skill-card[data-area="gateway"] a.skill-next').boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('#awardsLocked .award-card').first()).toBeVisible();
    await noHorizontalScroll(page);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`reads in ${scheme} mode: the page's colours come from the theme, with text apart from its ground`, async ({ page }) => {
      await stub(page);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(WIDE);
      await visit(page, '/profile');
      await expect(page.locator('.skill-card')).toHaveCount(6);
      const look = await page.evaluate(() => {
        const css = (sel: string, prop: string) => getComputedStyle(document.querySelector(sel)!).getPropertyValue(prop);
        return {
          page: css('body', 'background-color'),
          card: css('.skill-card', 'background-color'),
          title: css('.skill-title', 'color'),
          locked: css('#awardsLocked .award-card', 'background-color'),
          tier: css('#awardsEarned .award-badge', 'border-top-color'),
        };
      });
      expect(look.card).not.toBe(look.title);
      expect(look.page).not.toBe(look.card);
      expect(look.locked).not.toBe(look.card);
      // Light is a pale page and dark a deep one.
      const lum = (rgb: string) => {
        const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      if (scheme === 'light') expect(lum(look.card)).toBeGreaterThan(200);
      else expect(lum(look.card)).toBeLessThan(80);
      expect(look.tier).not.toBe('rgba(0, 0, 0, 0)');
    });
  }

  test('uses learner words only', async ({ page }) => {
    await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/profile');
    await expect(page.locator('.skill-card')).toHaveCount(6);
    await expectLearnerCopy(page);
  });
});

// =========================================================================
// Home
// =========================================================================

test.describe('Home: Your progress', () => {
  test('a brand-new learner is asked to finish a lab, not shown zeroes', async ({ page }) => {
    await stub(page, { profile: NEW_LEARNER as unknown as Profile, path: null });
    await page.setViewportSize(WIDE);
    await visit(page, '/');
    const band = page.locator('#homeProgress');
    await expect(band).toBeVisible();
    await expect(band.getByRole('heading', { level: 2, name: 'Your progress' })).toBeVisible();
    await expect(band.locator('.band-empty')).toHaveText('Finish a lab to start your score.');
    await expect(band.getByRole('link', { name: 'View profile' })).toHaveAttribute('href', '/profile');
    await expect(band.locator('[role="meter"]')).toHaveCount(0);
    await expect(page.locator('#homePath')).toHaveCount(0);
  });

  test('a learner with progress: score and level, XP, streak, the top three skills, the last three awards, above the path cards', async ({ page }) => {
    const s = await stub(page, { path: null });
    await page.setViewportSize(WIDE);
    await visit(page, '/');
    const band = page.locator('#homeProgress');
    await expect(band).toBeVisible();
    await expect(band.getByRole('meter', { name: 'Overall score' })).toHaveAttribute('aria-valuenow', '11');
    await expect(band.locator('.band-score .level-name')).toHaveText('Foundations');
    await expect(band.locator('.band-level')).toHaveText('Level 3 · Apprentice');
    await expect(band.getByRole('meter', { name: 'XP towards level 4' })).toHaveAttribute('aria-valuenow', '25');
    await expect(band.locator('.band-xp-line')).toHaveText('25 of 250 XP to level 4');
    await expect(band.locator('.streak')).toContainText('2-day streak');
    // The three best skills, best first.
    const skills = band.locator('.band-skill');
    await expect(skills).toHaveCount(3);
    await expect(skills.locator('.band-skill-name')).toHaveText(['Self-service platform', 'LLM gateway', 'Tools and MCP']);
    await expect(skills.locator('.band-skill-score')).toHaveText(['90', '67', '34']);
    await expect(band.getByRole('meter', { name: 'LLM gateway score' })).toHaveAttribute('aria-valuenow', '67');
    // The last three awards, with their tier said in words for a screen reader.
    const awards = band.locator('.mini-award');
    await expect(awards).toHaveCount(3);
    await expect(awards.first()).toContainText('On a roll');
    await expect(awards.first().locator('.sr-only')).toHaveText('Silver award: ');
    await expect(band.getByRole('link', { name: 'View profile' })).toBeVisible();
    // It uses the compact slice, and sits above the path cards.
    expect(s.profileCalls.some((q) => /compact=1/.test(q))).toBe(true);
    const above = await page.evaluate(() => Boolean(document.querySelector('#homeProgress')!.compareDocumentPosition(document.querySelector('.path-cards')!) & Node.DOCUMENT_POSITION_FOLLOWING));
    expect(above).toBe(true);
    // "View profile" opens the page.
    await band.getByRole('link', { name: 'View profile' }).click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.locator('.skill-card')).toHaveCount(6);
  });

  test('a profile that cannot be read leaves Home as it was: no band, no error', async ({ page }) => {
    const s = await stub(page, { profile: 500, path: null });
    await page.setViewportSize(WIDE);
    await visit(page, '/');
    await expect(page.locator('.path-card').first()).toBeVisible();
    await expect.poll(() => s.profileCalls.length).toBeGreaterThan(0);
    await expect(page.locator('#homeProgress')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(s.errors).toEqual([]);
  });

  test('on a phone it stacks and nothing sticks out', async ({ page }) => {
    await stub(page, { path: PATH_A });
    await page.setViewportSize(PHONE);
    await visit(page, '/');
    await expect(page.locator('#homeProgress')).toBeVisible();
    await expect(page.locator('#homePath')).toBeVisible();
    await noHorizontalScroll(page);
    await expectLearnerCopy(page);
  });
});

test.describe('Home: Your path', () => {
  test('the next lab as a big card with its reason, the three steps after it, the time left and a way to the whole path', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/', { mastery: DONE });
    const band = page.locator('#homePath');
    await expect(band).toBeVisible();
    await expect(band.getByRole('heading', { level: 2, name: 'Your path' })).toBeVisible();
    await expect(band.locator('.path-goal')).toHaveText('Your goal: Run our gateway');
    const next = band.locator('.next-card');
    await expect(next.getByRole('heading', { level: 3, name: 'Add a model without touching app code' })).toBeVisible();
    await expect(next.locator('.next-why')).toHaveText('A first step into LLM gateway, which is new to you.');
    await expect(next.locator('.chip-area')).toHaveText('LLM gateway');
    await expect(next.locator('.chip').last()).toHaveText('30 min');
    await expect(next.getByRole('button', { name: 'Start' })).toBeVisible();
    // The three after it, as a small timeline in order.
    const coming = band.locator('.mini-step');
    await expect(coming).toHaveCount(3);
    await expect(coming.locator('.mini-step-title')).toHaveText(['One endpoint, one key', 'Route by intent', 'Guard the spend']);
    await expect(band.getByRole('heading', { level: 3, name: 'Coming up' })).toBeVisible();
    await expect(band.locator('.path-totals')).toHaveText('2 h 45 min to go · about 2 weeks');
    await expect(band.getByRole('link', { name: 'See the whole path' })).toHaveAttribute('href', '/paths/mine');
    // The path band comes first, then the progress band, then the path cards.
    const order = await page.evaluate(() => {
      const at = (sel: string) => document.querySelector(sel)!;
      const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return [before(at('#homePath'), at('#homeProgress')), before(at('#homeProgress'), at('.path-cards'))];
    });
    expect(order).toEqual([true, true]);
    expect(s.pathReads).toBeGreaterThan(0);
    // Start begins the lab.
    await next.getByRole('button', { name: 'Start' }).click();
    await expect.poll(() => s.starts).toEqual(['add-a-model-without-touching-app-code']);
    expect(s.errors).toEqual([]);
  });

  test('is not there without a goal, unless the quiz was taken: then it offers to make one', async ({ page }) => {
    await stub(page, { path: null });
    await page.setViewportSize(WIDE);
    await visit(page, '/');
    await expect(page.locator('#homeProgress')).toBeVisible();
    await expect(page.locator('#homePath')).toHaveCount(0);

    const other = await page.context().newPage();
    await stub(other, { path: null });
    await other.setViewportSize(WIDE);
    await visit(other, '/', { mastery: DONE });
    const invite = other.locator('#homePath');
    await expect(invite).toBeVisible();
    await expect(invite.locator('.band-empty')).toContainText('Tell us what you are aiming for');
    await expect(invite.getByRole('link', { name: 'Make my path' })).toHaveAttribute('href', '/paths/mine');
  });

  test('a path with nothing left says so instead of a next lab', async ({ page }) => {
    const done = { ...PATH_A, steps: PATH_A.steps.map((x) => (x.status === 'locked' ? x : { ...x, status: 'done' })), total_minutes: 0, weeks_estimate: 0 };
    await stub(page, { path: done });
    await page.setViewportSize(WIDE);
    await visit(page, '/', { mastery: DONE });
    const band = page.locator('#homePath');
    await expect(band.locator('.next-card-done')).toContainText('You have finished every lab on your path');
    await expect(band.locator('.mini-step')).toHaveCount(0);
    await expect(band.locator('.path-totals')).toHaveText('Nothing left to do on this path.');
  });
});

// =========================================================================
// the award toast
// =========================================================================

const AWARD_EVENT = (id: string, title: string, tier: string, n = 1) => `id: ${n}\nevent: award.earned\ndata: ${JSON.stringify({ id, title, tier })}\n\n`;

test.describe('the award toast', () => {
  test('celebrates an award that comes in on the lab\'s event stream: its title and tier, in a polite live region, with confetti', async ({ page }) => {
    const s = await stub(page, { events: AWARD_EVENT('first-lab', 'First steps', 'bronze') });
    await page.setViewportSize(WIDE);
    await visit(page, '/', { remembered: 'see-what-a-gateway-does' });
    const live = page.locator('#awardToasts');
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    const toast = live.locator('.award-toast');
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText('Award earned');
    await expect(toast).toContainText('First steps');
    await expect(toast.locator('.award-toast-tier')).toHaveText('Bronze award');
    await expect(toast).toHaveAttribute('data-tier', 'bronze');
    // Motion is on: confetti.
    await expect(toast.locator('.confetti i')).toHaveCount(20);
    // It takes no focus, and can be dismissed from the keyboard.
    expect(await page.evaluate(() => document.activeElement?.closest('#awardToasts') === null)).toBe(true);
    const close = toast.getByRole('button', { name: 'Dismiss: First steps' });
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(toast).toHaveCount(0);
    // The lab's activity list has it too, in words.
    await expect(page.locator('#noticeList')).toContainText('Award earned');
    expect(s.errors).toEqual([]);
  });

  test('no confetti when the learner asked for reduced motion; the toast is the same', async ({ page }) => {
    await stub(page, { events: AWARD_EVENT('ten-labs', 'Ten down', 'gold') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(WIDE);
    await visit(page, '/', { remembered: 'see-what-a-gateway-does' });
    const toast = page.locator('#awardToasts .award-toast');
    await expect(toast).toContainText('Ten down');
    await expect(toast.locator('.award-toast-tier')).toHaveText('Gold award');
    await page.waitForTimeout(300);
    await expect(page.locator('.confetti i')).toHaveCount(0);
  });

  test('says each new award once, and puts it on the result card', async ({ page }) => {
    await stub(page, { events: AWARD_EVENT('first-lab', 'First steps', 'bronze', 1) + AWARD_EVENT('first-lab', 'First steps', 'bronze', 2) + AWARD_EVENT('streak-3', 'On a roll', 'silver', 3) });
    await page.setViewportSize(WIDE);
    await visit(page, '/', { remembered: 'see-what-a-gateway-does' });
    await expect(page.locator('#awardToasts .award-toast')).toHaveCount(2);
    await expect(page.locator('#awardToasts .award-toast').first()).toContainText('First steps');
    await expect(page.locator('#awardToasts .award-toast').nth(1)).toContainText('On a roll');
    // The lab is complete in the stub, so its result card is up (in the guide's Checks tab), and shows what the lab earned.
    await expect(page.locator('#resultCard')).not.toHaveAttribute('hidden', '');
    const awards = page.locator('#resultAwards');
    await expect(awards).not.toHaveAttribute('hidden', '');
    await expect(awards.locator('.result-awards-label')).toHaveText('New awards');
    await expect(awards.locator('.mini-award')).toHaveCount(2);
  });

  test('refreshes Home\'s numbers: Home was drawn, a lab earned an award, and back at Home the band has asked again', async ({ page }) => {
    const s = await stub(page, { events: AWARD_EVENT('first-lab', 'First steps', 'bronze') });
    await page.setViewportSize(WIDE);
    await visit(page, '/', { mastery: DONE });
    await expect(page.locator('#homeProgress .band-xp-line')).toHaveText('25 of 250 XP to level 4');
    const before = s.profileCalls.length;
    // The answer is still fresh (30 seconds), so only the award can make Home ask again.
    s.profile = { ...MID_LEARNER, xp: 300, level: { ...MID_LEARNER.level, xp_into: 50 } };
    await page.locator('#homePath .next-card').getByRole('button', { name: 'Start' }).click();
    await expect(page.locator('#awardToasts .award-toast')).toHaveCount(1);
    await page.goBack();
    await expect(page.locator('#homeProgress .band-xp-line')).toHaveText('50 of 250 XP to level 4');
    expect(s.profileCalls.length).toBeGreaterThan(before);
  });
});

// =========================================================================
// /paths/mine
// =========================================================================

test.describe('/paths/mine', () => {
  const steps = (page: Page) => page.locator('.path-step');

  test('lists the steps in the service\'s order, each with its state in words, its reason, area, time and way in', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/paths/mine', { mastery: DONE });
    await expect(page.getByRole('heading', { level: 1, name: 'Your path' })).toBeVisible();
    await expect(page).toHaveTitle('Your path · Opalix labs');
    await expect(crumbs(page).getByRole('listitem')).toHaveText(['Home', 'Your path']);
    await expect(crumbs(page).locator('[aria-current="page"]')).toHaveText('Your path');
    await expect(page.locator('.mypath-goal')).toHaveText('Be ready for a role: Run our gateway');
    await expect(page.locator('.mypath-totals')).toHaveText('2 h 45 min to go · about 2 weeks');

    await expect(steps(page)).toHaveCount(7);
    await expect(steps(page).locator('.step-title')).toHaveText([
      'See what a gateway does',
      'Add a model without touching app code',
      'One endpoint, one key',
      'Route by intent',
      'Guard the spend',
      'Retrieve with citations',
      'A pro only lab',
    ]);
    const statuses = await steps(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-status')));
    expect(statuses).toEqual(['done', 'next', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'locked']);
    // The state is a word on every step.
    await expect(steps(page).locator('.step-status')).toHaveText(['Done', 'Next up', 'Coming up', 'Coming up', 'Coming up', 'Coming up', 'Locked']);

    const next = steps(page).nth(1);
    await expect(next.locator('.step-why')).toHaveText('A first step into LLM gateway, which is new to you.');
    await expect(next.locator('.chip-area')).toHaveText('LLM gateway');
    await expect(next.locator('.chip').last()).toHaveText('30 min');
    await expect(next.getByRole('button', { name: 'Start' })).toBeVisible();
    await expect(steps(page).nth(3).locator('.chip-area')).toHaveText('Tools and MCP');
    await expect(steps(page).nth(3).locator('.chip').last()).toHaveText('45 min');
    // A done step can be opened again; a locked one says why, in plain words, and cannot start.
    await expect(steps(page).nth(0).getByRole('button', { name: 'Open again' })).toBeVisible();
    const locked = steps(page).nth(6);
    await expect(locked.locator('.step-lock')).toHaveText('Part of the paid plan');
    // A plan lock offers the way out instead of a dead button: a link to the plans page.
    await expect(locked.getByRole('button')).toHaveCount(0);
    await expect(locked.getByRole('link', { name: 'Unlock A pro only lab with a plan' })).toHaveAttribute('href', PRICING);
    expect(s.starts).toEqual([]);
    // The title is a link to the lab's own page.
    await expect(steps(page).nth(2).getByRole('link', { name: 'One endpoint, one key' })).toHaveAttribute('href', '/labs/one-endpoint-one-key');
    // Start begins the lab.
    await next.getByRole('button', { name: 'Start' }).click();
    await expect.poll(() => s.starts).toEqual(['add-a-model-without-touching-app-code']);
  });

  test('a plan-locked step has an Unlock link to the plans page (same tab); a step locked behind another lab says which and has none', async ({ page }) => {
    const s = await stub(page, { path: PATH_LOCKS });
    await page.setViewportSize(WIDE);
    await visit(page, '/paths/mine', { mastery: DONE });
    const rows = page.locator('.path-step');
    await expect(rows).toHaveCount(6);

    // Plan lock: the paid-plan line, and an Unlock link-button that is a real link (keyboard, middle-click), named for its lab.
    const plan = rows.nth(2);
    await expect(plan.locator('.step-lock')).toHaveText('Part of the paid plan');
    const unlock = plan.getByRole('link', { name: 'Unlock Plan locked lab with a plan' });
    await expect(unlock).toHaveText('Unlock');
    await expect(unlock).toHaveAttribute('href', PRICING);
    await expect(unlock).not.toHaveAttribute('target', /.+/);
    await expect(unlock).toHaveClass(/\bbtn\b/);
    expect(await unlock.evaluate((e) => e.tagName)).toBe('A');
    await expect(unlock).toHaveAccessibleDescription('Part of the paid plan');
    await expect(plan.getByRole('button')).toHaveCount(0);

    // Prerequisite lock: the service's sentence, the disabled Locked button, no Unlock.
    const waits = rows.nth(3);
    await expect(waits.locator('.step-lock')).toHaveText('Unlocks after Plan locked lab.');
    await expect(waits.getByRole('link', { name: /Unlock/ })).toHaveCount(0);
    await expect(waits.getByRole('button', { name: 'Locked' })).toHaveAttribute('aria-disabled', 'true');

    // An older response: the stock plan line still means a plan lock; any other text gets no button.
    const oldPlan = rows.nth(4);
    await expect(oldPlan.getByRole('link', { name: 'Unlock Old plan lock with a plan' })).toHaveAttribute('href', PRICING);
    const oldOther = rows.nth(5);
    await expect(oldOther.locator('.step-lock')).toHaveText('Something else holds this one.');
    await expect(oldOther.getByRole('link', { name: /Unlock/ })).toHaveCount(0);

    // Exactly the plan locks offer it.
    await expect(page.getByRole('link', { name: /^Unlock .* with a plan$/ })).toHaveCount(2);
    expect(s.starts).toEqual([]);
    await expectLearnerCopy(page);
  });

  test('Unlock is reached from the keyboard in reading order, and Enter opens the plans page in the same tab', async ({ page, context }) => {
    await stub(page, { path: PATH_LOCKS });
    await page.route('https://opalix-site.soubenz94.workers.dev/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Plans</title><h1 id="pricing">Plans</h1>' }));
    await page.setViewportSize(WIDE);
    await visit(page, '/paths/mine', { mastery: DONE });
    const rows = page.locator('.path-step');
    await expect(rows).toHaveCount(6);
    await rows.nth(2).getByRole('link', { name: 'Plan locked lab', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Unlock Plan locked lab with a plan' })).toBeFocused();
    // Then straight on to the next step's title: the prerequisite step has no Unlock to stop at, and its disabled button comes after its title.
    await page.keyboard.press('Tab');
    await expect(rows.nth(3).getByRole('link', { name: 'Waits for a lab', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(rows.nth(3).getByRole('button', { name: 'Locked' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('link', { name: 'Unlock Plan locked lab with a plan' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(PRICING);
    expect(context.pages()).toHaveLength(1);
  });

  test('on a phone the Unlock link is touch-sized and nothing sticks out sideways', async ({ page }) => {
    await stub(page, { path: PATH_LOCKS });
    await page.setViewportSize(PHONE);
    await visit(page, '/paths/mine', { mastery: DONE });
    await expect(page.locator('.path-step')).toHaveCount(6);
    const unlock = page.getByRole('link', { name: 'Unlock Plan locked lab with a plan' });
    await expect(unlock).toBeVisible();
    const box = await unlock.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await noHorizontalScroll(page);
    await expectLearnerCopy(page);
  });

  test('Recompute asks for a fresh path (?force=1), says so politely, and shows the new order', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/paths/mine', { mastery: DONE });
    await expect(steps(page)).toHaveCount(7);
    await page.getByRole('button', { name: 'Recompute' }).click();
    await expect.poll(() => s.recomputes).toEqual(['?force=1']);
    await expect(steps(page).nth(2).locator('.step-title')).toHaveText('Retrieve with citations');
    await expect(steps(page).nth(2)).toHaveAttribute('data-status', 'next');
    await expect(steps(page).nth(1)).toHaveAttribute('data-status', 'done');
    await expect(page.locator('.mypath-goal')).toHaveText('Learn a specific skill: Learn retrieval');
    await expect(page.locator('.mypath-totals')).toHaveText('2 h 15 min to go · about 1 week');
    const live = page.locator('.mypath-live');
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveText('Your path is up to date.');
  });

  test('Change my goal opens the two questions, filled in, and saving sends them with the quiz result', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/paths/mine', { mastery: DONE, goal: { goal_kind: 'role-ready', goal_text: 'Run our gateway', hours_per_week: 4 } });
    const change = page.getByRole('button', { name: 'Change my goal' });
    await expect(change).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#goalForm')).toHaveCount(0);
    await change.click();
    await expect(change).toHaveAttribute('aria-expanded', 'true');
    const form = page.locator('#goalForm');
    await expect(form).toBeVisible();
    // Filled in with what was said last time, and the first choice has focus.
    await expect(form.getByRole('radio', { name: /Be ready for a role/ })).toBeChecked();
    await expect(form.getByRole('radio', { name: /Be ready for a role/ })).toBeFocused();
    await expect(form.getByLabel('In a few words, what is it? (optional)')).toHaveValue('Run our gateway');
    await expect(form.getByRole('radio', { name: '4 hours' })).toBeChecked();

    await form.getByRole('radio', { name: /Learn a specific skill/ }).check();
    await form.getByLabel('In a few words, what is it? (optional)').fill('Retrieval with citations');
    await form.getByRole('radio', { name: '6 hours' }).check();
    await form.getByRole('button', { name: 'Save and update my path' }).click();
    await expect.poll(() => s.puts.length).toBe(1);
    expect(s.puts[0]).toEqual({
      areas: { gateway: 'ok', mcp: 'new', rag: 'strong', otel: 'new', platform: 'new', sovereignty: 'new' },
      goal_kind: 'specific-skill',
      goal_text: 'Retrieval with citations',
      hours_per_week: 6,
    });
    await expect(page.locator('.path-step').nth(2).locator('.step-title')).toHaveText('Retrieve with citations');
    await expect(page.locator('#goalForm')).toHaveCount(0);
    await expect(page.locator('.mypath-live')).toHaveText('Your goal is saved and your path is updated.');
    // What was said is kept for next time.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('opalixPathGoal')!))).toEqual({ goal_kind: 'specific-skill', goal_text: 'Retrieval with citations', hours_per_week: 6 });
  });

  test('the goal form checks the hours, can be cancelled, and says so when saving fails', async ({ page }) => {
    const s = await stub(page, { putStatus: 500 });
    await page.setViewportSize(WIDE);
    await visit(page, '/paths/mine', { mastery: DONE });
    await page.getByRole('button', { name: 'Change my goal' }).click();
    const form = page.locator('#goalForm');
    await form.getByLabel(/Another number of hours/).fill('25');
    await form.getByRole('button', { name: 'Save and update my path' }).click();
    await expect(form.locator('.goal-hours-message')).toHaveText('Enter a whole number of hours from 1 to 20.');
    expect(s.puts).toEqual([]);
    await form.getByLabel(/Another number of hours/).fill('12');
    await form.getByRole('button', { name: 'Save and update my path' }).click();
    await expect.poll(() => s.puts.length).toBe(1);
    expect(s.puts[0]!.hours_per_week).toBe(12);
    await expect(form.getByRole('alert')).toContainText('Could not save your goal. Something went wrong on our side. Please try again in a moment.');
    // The form stays open with what was typed; Cancel closes it and returns focus to the button.
    await expect(form).toBeVisible();
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#goalForm')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Change my goal' })).toBeFocused();
    await expect(page.locator('.path-step')).toHaveCount(7);
  });

  test('with no goal yet it asks the two questions, and saving makes the path', async ({ page }) => {
    const s = await stub(page, { path: null });
    await page.setViewportSize(WIDE);
    await visit(page, '/paths/mine');
    await expect(page.getByRole('heading', { level: 1, name: 'Your path' })).toBeVisible();
    await expect(page.locator('.mypath-lede')).toContainText('Answer two questions');
    await expect(page.locator('.path-step')).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /Explore/ })).toBeChecked();
    await expect(page.getByRole('radio', { name: '4 hours' })).toBeChecked();
    await page.getByRole('button', { name: 'Make my path' }).click();
    await expect.poll(() => s.puts.length).toBe(1);
    // No quiz result in this browser: the areas are empty, and the goal is the default one.
    expect(s.puts[0]).toEqual({ areas: {}, goal_kind: 'explore', hours_per_week: 4 });
    await expect(page.locator('.path-step')).toHaveCount(7);
  });

  test('says so in plain words when the path cannot be read, and tries again', async ({ page }) => {
    const s = await stub(page);
    await page.route('**/api/path', (route) => (route.request().method() === 'GET' && s.pathReads === 0 && ++s.pathReads ? json(route, { error: 'boom' }, 500) : route.fallback()));
    await visit(page, '/paths/mine', { mastery: DONE });
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Could not load your path. Something went wrong on our side. Please try again in a moment.');
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('.path-step')).toHaveCount(7);
  });

  test('works from the keyboard: Enter opens the form, the arrow keys move through the choices, every control has a name', async ({ page }) => {
    await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/paths/mine', { mastery: DONE });
    await expect(page.getByRole('heading', { level: 1, name: 'Your path' })).toBeVisible();
    const change = page.getByRole('button', { name: 'Change my goal' });
    await change.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('radio', { name: /Be ready for a role|Explore/ }).first()).toBeVisible();
    // Arrow keys move through the choices as in any radio group.
    await page.getByRole('radio', { name: /Explore/ }).focus();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('radio', { name: /Learn a specific skill/ })).toBeChecked();
    // Every control of the page has an accessible name.
    const unnamed = await page.locator('#labList button, #labList a, #labList input').evaluateAll((els) =>
      els.filter((e) => !(e.getAttribute('aria-label') || (e as HTMLElement).innerText?.trim() || e.closest('label')?.textContent?.trim() || e.getAttribute('placeholder'))).length
    );
    expect(unnamed).toBe(0);
  });

  test('on a phone: the steps stack, the buttons are touch-sized, nothing sticks out; also with the form open', async ({ page }) => {
    await stub(page);
    await page.setViewportSize(PHONE);
    await visit(page, '/paths/mine', { mastery: DONE });
    await expect(page.locator('.path-step')).toHaveCount(7);
    await noHorizontalScroll(page);
    const box = await page.locator('.path-step').nth(1).getByRole('button', { name: 'Start' }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole('button', { name: 'Change my goal' }).click();
    await expect(page.locator('#goalForm')).toBeVisible();
    await noHorizontalScroll(page);
    await expectLearnerCopy(page);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`reads in ${scheme} mode, and a step's state does not rest on colour`, async ({ page }) => {
      await stub(page);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(WIDE);
      await visit(page, '/paths/mine', { mastery: DONE });
      await expect(page.locator('.path-step')).toHaveCount(7);
      const look = await page.evaluate(() => {
        const css = (el: Element, prop: string) => getComputedStyle(el).getPropertyValue(prop);
        const rows = [...document.querySelectorAll('.path-step')];
        return { page: css(document.body, 'background-color'), row: css(rows[2]!, 'background-color'), locked: css(rows[6]!, 'background-color'), lockedBorder: css(rows[6]!, 'border-top-style'), nextBorder: css(rows[1]!, 'border-top-width'), plainBorder: css(rows[2]!, 'border-top-width') };
      });
      expect(look.row).not.toBe(look.page);
      expect(look.locked).not.toBe(look.row);
      // Locked is dashed and the next step has a heavier edge, as well as the words.
      expect(look.lockedBorder).toBe('dashed');
      expect(parseFloat(look.nextBorder)).toBeGreaterThan(parseFloat(look.plainBorder));
    });
  }
});

// =========================================================================
// the quiz's two last questions
// =========================================================================

test.describe('the quiz: what you are aiming for, and hours a week', () => {
  const open = async (page: Page, goal?: Record<string, unknown>) => {
    const s = await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/onboarding', { mastery: { onboarding: { status: null } }, goal });
    await expect(heading(page)).toHaveText('What have you worked with?');
    return s;
  };
  const start = async (page: Page, ...areas: string[]) => {
    for (const a of areas) await page.locator(`.ob-choice input[value="${a}"]`).check();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
  };
  const answerOne = async (page: Page, right: boolean) => {
    const prompt = (await page.locator('.quiz-prompt').innerText()).trim();
    const question = onboarding.questions.find((q) => q.prompt === prompt)!;
    const pick = right ? question.answer : [question.options.find((o) => !question.answer.includes(o.id))!.id];
    for (const id of pick) await page.locator(`.quiz-option[data-option="${id}"] input`).check();
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.locator('.quiz-feedback')).toHaveAttribute('data-result', right ? 'correct' : 'incorrect');
    await page.getByRole('button', { name: /^(Next|Next: your goal)$/ }).click();
  };

  test('come last: two screens after the area questions, with something chosen from the start', async ({ page }) => {
    await open(page);
    await start(page, 'gateway');
    await answerOne(page, true);
    await answerOne(page, false);
    // The area's last question leads on to the goal, not straight to the summary.
    await expect(heading(page)).toHaveText('What are you aiming for?');
    await expect(heading(page)).toBeFocused();
    await expect(host(page).locator('.learn-eyebrow')).toHaveText('Your path · question 1 of 2');
    const kinds = host(page).getByRole('radio');
    await expect(kinds).toHaveCount(3);
    await expect(host(page).getByRole('radio', { name: /Be ready for a role/ })).not.toBeChecked();
    await expect(host(page).getByRole('radio', { name: /Learn a specific skill/ })).not.toBeChecked();
    await expect(host(page).getByRole('radio', { name: /Explore/ })).toBeChecked();
    const text = host(page).getByLabel('In a few words, what is it? (optional)');
    await expect(text).toHaveValue('');
    await expect(text).toHaveAttribute('maxlength', '200');
    await expect(host(page).locator('.goal-text-count')).toHaveText('0 of 200 characters');
    await text.fill('Run our gateway');
    await expect(host(page).locator('.goal-text-count')).toHaveText('15 of 200 characters');
    await host(page).getByRole('radio', { name: /Be ready for a role/ }).check();
    await host(page).getByRole('button', { name: 'Next', exact: true }).click();

    await expect(heading(page)).toHaveText('How many hours a week can you give this?');
    await expect(heading(page)).toBeFocused();
    await expect(host(page).locator('.learn-eyebrow')).toHaveText('Your path · question 2 of 2');
    const chips = host(page).locator('.chip-choice-text');
    await expect(chips).toHaveText(['2 hours', '4 hours', '6 hours', '10 hours']);
    await expect(host(page).getByRole('radio', { name: '4 hours' })).toBeChecked();
    await host(page).getByLabel(/Another number of hours/).fill('12');
    await expect(host(page).getByRole('radio', { name: '4 hours' })).not.toBeChecked();
    await host(page).getByRole('button', { name: 'See where to start' }).click();
    await expect(heading(page)).toHaveText('Where to start');
  });

  test('send the quiz result, the goal and the hours to PUT /api/path-inputs (ok stays ok), then the path is on Home', async ({ page }) => {
    const s = await open(page);
    // gateway: right at basic, wrong at advanced (familiar, "ok"); rag: right and right (strong).
    await start(page, 'gateway', 'rag');
    await answerOne(page, true);
    await answerOne(page, false);
    await answerOne(page, true);
    await answerOne(page, true);
    await expect(heading(page)).toHaveText('What are you aiming for?');
    await host(page).getByRole('radio', { name: /Learn a specific skill/ }).check();
    await host(page).getByLabel('In a few words, what is it? (optional)').fill('  Put a   gateway in front of our models ');
    await host(page).getByRole('button', { name: 'Next', exact: true }).click();
    await host(page).getByRole('radio', { name: '10 hours' }).check();
    await host(page).getByRole('button', { name: 'See where to start' }).click();
    await expect(heading(page)).toHaveText('Where to start');
    await expect.poll(() => s.puts.length).toBe(1);
    expect(s.puts[0]).toEqual({
      areas: { gateway: 'ok', mcp: 'new', rag: 'strong', otel: 'new', platform: 'new', sovereignty: 'new' },
      goal_kind: 'specific-skill',
      goal_text: 'Put a gateway in front of our models',
      hours_per_week: 10,
    });
    // The browser never names a user, and the quiz result is still its own.
    expect(Object.keys(s.puts[0]!).sort()).toEqual(['areas', 'goal_kind', 'goal_text', 'hours_per_week']);
    await host(page).getByRole('button', { name: 'Browse all labs' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#homePath')).toBeVisible();
    // The path the answers brought back is the one on Home.
    await expect(page.locator('#homePath .next-title')).toContainText('Retrieve with citations');
    expect(s.errors).toEqual([]);
  });

  test('"None of these yet" still asks them, and sends every area as new', async ({ page }) => {
    const s = await open(page);
    await start(page, 'none');
    await expect(heading(page)).toHaveText('What are you aiming for?');
    await host(page).getByRole('button', { name: 'Next', exact: true }).click();
    await host(page).getByRole('button', { name: 'See where to start' }).click();
    await expect(heading(page)).toHaveText('Where to start');
    await expect.poll(() => s.puts.length).toBe(1);
    expect(s.puts[0]).toEqual({ areas: Object.fromEntries(AREAS.map((a) => [a.area, 'new'])), goal_kind: 'explore', hours_per_week: 4 });
  });

  test('check the hours: nothing is sent until they are a whole number from 1 to 20', async ({ page }) => {
    const s = await open(page);
    await start(page, 'none');
    await host(page).getByRole('button', { name: 'Next', exact: true }).click();
    const box = host(page).getByLabel(/Another number of hours/);
    for (const bad of ['0', '21', '2.5', '']) {
      await box.fill(bad);
      await expect(host(page).getByRole('radio', { name: 'Other number of hours' })).toBeChecked();
      await host(page).getByRole('button', { name: 'See where to start' }).click();
      await expect(heading(page)).toHaveText('How many hours a week can you give this?');
      await expect(host(page).locator('.goal-hours-message')).toHaveText('Enter a whole number of hours from 1 to 20.');
    }
    expect(s.puts).toEqual([]);
    await box.fill('20');
    await host(page).getByRole('button', { name: 'See where to start' }).click();
    await expect(heading(page)).toHaveText('Where to start');
    await expect.poll(() => s.puts.length).toBe(1);
    expect(s.puts[0]!.hours_per_week).toBe(20);
  });

  test('can be skipped: the defaults (or what was said last time) are sent, and Back keeps the goal', async ({ page }) => {
    const s = await open(page, { goal_kind: 'role-ready', goal_text: 'Run it', hours_per_week: 6 });
    await start(page, 'none');
    // Filled in from last time.
    await expect(host(page).getByRole('radio', { name: /Be ready for a role/ })).toBeChecked();
    await host(page).getByRole('radio', { name: /Learn a specific skill/ }).check();
    await host(page).getByRole('button', { name: 'Next', exact: true }).click();
    await expect(host(page).getByRole('radio', { name: '6 hours' })).toBeChecked();
    await host(page).getByRole('button', { name: 'Back' }).click();
    await expect(heading(page)).toHaveText('What are you aiming for?');
    await expect(host(page).getByRole('radio', { name: /Learn a specific skill/ })).toBeChecked();
    await host(page).getByRole('button', { name: 'Skip these questions' }).click();
    await expect(heading(page)).toHaveText('Where to start');
    await expect.poll(() => s.puts.length).toBe(1);
    expect(s.puts[0]!.goal_kind).toBe('specific-skill');
    expect(s.puts[0]!.goal_text).toBe('Run it');
    expect(s.puts[0]!.hours_per_week).toBe(6);
  });

  test('a path that cannot be saved is not shown, and the quiz does not mention it', async ({ page }) => {
    const s = await stub(page, { putStatus: 500, path: null });
    await page.setViewportSize(WIDE);
    await visit(page, '/onboarding', { mastery: { onboarding: { status: null } } });
    await start(page, 'none');
    await host(page).getByRole('button', { name: 'Next', exact: true }).click();
    await host(page).getByRole('button', { name: 'See where to start' }).click();
    await expect(heading(page)).toHaveText('Where to start');
    await expect.poll(() => s.puts.length).toBe(1);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await host(page).getByRole('button', { name: 'Browse all labs' }).click();
    await expect(page.locator('.path-card').first()).toBeVisible();
    // No path to show: only the offer to make one (the quiz was taken), never a next lab.
    await expect(page.locator('#homePath .next-card')).toHaveCount(0);
    await expect(page.locator('#homePath').getByRole('link', { name: 'Make my path' })).toBeVisible();
    expect(s.errors).toEqual([]);
  });

  test('a retake asks again (starting from the last answers) and sends the new result, which rebuilds the path', async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize(WIDE);
    await visit(page, '/', { mastery: DONE, goal: { goal_kind: 'role-ready', goal_text: 'Run our gateway', hours_per_week: 4 } });
    await expect(page.locator('#btnRetakeQuiz')).toBeVisible();
    await page.locator('#btnRetakeQuiz').click();
    await expect(heading(page)).toHaveText('What have you worked with?');
    await start(page, 'none');
    await expect(host(page).getByRole('radio', { name: /Be ready for a role/ })).toBeChecked();
    await expect(host(page).getByLabel('In a few words, what is it? (optional)')).toHaveValue('Run our gateway');
    await host(page).getByRole('button', { name: 'Next', exact: true }).click();
    await host(page).getByRole('radio', { name: '2 hours' }).check();
    await host(page).getByRole('button', { name: 'See where to start' }).click();
    await expect.poll(() => s.puts.length).toBe(1);
    expect(s.puts[0]).toEqual({ areas: Object.fromEntries(AREAS.map((a) => [a.area, 'new'])), goal_kind: 'role-ready', goal_text: 'Run our gateway', hours_per_week: 2 });
    await host(page).getByRole('button', { name: 'Browse all labs' }).click();
    // The path the new answers brought back is the one on Home.
    await expect(page.locator('#homePath .next-title')).toContainText('Retrieve with citations');
  });

  test('on a phone: the two screens fit, the choices stack, the chips are touch-sized', async ({ page }) => {
    await stub(page);
    await page.setViewportSize(PHONE);
    await visit(page, '/onboarding', { mastery: { onboarding: { status: null } } });
    await start(page, 'none');
    await expect(heading(page)).toHaveText('What are you aiming for?');
    await noHorizontalScroll(page);
    const xs = await host(page).locator('.goal-choices .ob-choice').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(xs).size).toBe(1);
    await expectLearnerCopy(page, '#learnScreen');
    await host(page).getByRole('button', { name: 'Next', exact: true }).click();
    await noHorizontalScroll(page);
    const chip = await host(page).locator('.chip-choice').first().boundingBox();
    expect(chip!.height).toBeGreaterThanOrEqual(44);
    await expectLearnerCopy(page, '#learnScreen');
  });

  test('the chips and the choices work from the keyboard', async ({ page }) => {
    await open(page);
    await start(page, 'none');
    await host(page).getByRole('radio', { name: /Explore/ }).focus();
    await page.keyboard.press('ArrowUp');
    await expect(host(page).getByRole('radio', { name: /Learn a specific skill/ })).toBeChecked();
    // The three choices are one tab stop; the next one is the goal line.
    await page.keyboard.press('Tab');
    await expect(host(page).getByLabel('In a few words, what is it? (optional)')).toBeFocused();
    await page.keyboard.type('Learn RAG');
    await page.keyboard.press('Enter');
    await expect(heading(page)).toHaveText('How many hours a week can you give this?');
    await host(page).getByRole('radio', { name: '4 hours' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(host(page).getByRole('radio', { name: '6 hours' })).toBeChecked();
    const outline = await host(page).getByRole('radio', { name: '6 hours' }).evaluate((el) => getComputedStyle(el.closest('label')!).outlineStyle);
    expect(outline).not.toBe('none');
  });
});

// =========================================================================
// the quiz's last screen: "Where to start"
// =========================================================================

test.describe('the quiz: where to start', () => {
  type Mix = Record<string, 'strong' | 'ok'>;
  const answerOne = async (page: Page, right: boolean) => {
    const prompt = (await page.locator('.quiz-prompt').innerText()).trim();
    const question = onboarding.questions.find((q) => q.prompt === prompt)!;
    const pick = right ? question.answer : [question.options.find((o) => !question.answer.includes(o.id))!.id];
    for (const id of pick) await page.locator(`.quiz-option[data-option="${id}"] input`).check();
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await page.getByRole('button', { name: /^(Next|Next: your goal)$/ }).click();
  };

  /**
   * Takes the quiz to its last screen. `mix` names the areas to tick and the level each ends at (strong: right,
   * right; ok: right, wrong); the areas it leaves out are new. With `goal` the two goal questions are answered
   * (kind, text, hours), else they are skipped (the defaults, or what was said last time).
   */
  async function reach(page: Page, mix: Mix, goal?: { kind: RegExp; text?: string; hours?: string }) {
    const ticked = AREAS.filter((a) => mix[a.area]);
    if (ticked.length === 0) await page.locator('.ob-choice input[value="none"]').check();
    for (const a of ticked) await page.locator(`.ob-choice input[value="${a.area}"]`).check();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    for (const a of ticked) {
      await answerOne(page, true);
      await answerOne(page, mix[a.area] === 'strong');
    }
    await expect(heading(page)).toHaveText('What are you aiming for?');
    if (!goal) await host(page).getByRole('button', { name: 'Skip these questions' }).click();
    else {
      await host(page).getByRole('radio', { name: goal.kind }).check();
      if (goal.text) await host(page).getByLabel('In a few words, what is it? (optional)').fill(goal.text);
      await host(page).getByRole('button', { name: 'Next', exact: true }).click();
      if (goal.hours) await host(page).getByRole('radio', { name: goal.hours }).check();
      await host(page).getByRole('button', { name: 'See where to start' }).click();
    }
    await expect(heading(page)).toHaveText('Where to start');
  }

  const visitQuiz = async (page: Page, init: Partial<Stub> = {}, size = WIDE, goal?: Record<string, unknown>, modules = true) => {
    const s = await stub(page, init);
    // A lab in every module of the platform's path, so that every area has a page to open (answers before the stub's own).
    if (modules) {
      const spread = [...LABS, ...AREAS.filter((a) => a.module > 1).map((a) => lab({ slug: `a-lab-in-module-${a.module}`, title: `A lab in module ${a.module}`, module: a.module, order: 1 }))];
      await page.route('**/api/labs', (route) => json(route, spread));
    }
    await page.setViewportSize(size);
    await visit(page, '/onboarding', { mastery: { onboarding: { status: null } }, goal });
    await expect(heading(page)).toHaveText('What have you worked with?');
    return s;
  };

  const card = (page: Page) => host(page).locator('.start-card');
  const allStrong = Object.fromEntries(AREAS.map((a) => [a.area, 'strong'])) as Mix;

  test('everything new: the first area is the one answer, with "new to you" as the reason', async ({ page }) => {
    await visitQuiz(page);
    await reach(page, {});
    await expect(heading(page)).toBeFocused();
    await expect(host(page).locator('.learn-eyebrow')).toHaveText('Your starting point');
    await expect(card(page).getByRole('heading', { level: 2 })).toHaveText('Start here');
    await expect(card(page).locator('.start-title')).toHaveText(AREAS[0]!.title);
    await expect(card(page).locator('.start-why')).toHaveText('You said this is new to you, so we begin here.');
    await expect(card(page).locator('.tile svg')).toHaveCount(1);
    await expect(card(page).getByRole('button', { name: `Start with ${AREAS[0]!.title}` })).toBeVisible();
    // One card, not six: a quiet line per area below it.
    await expect(host(page).locator('.start-card')).toHaveCount(1);
    await expect(host(page).locator('.told-row')).toHaveCount(AREAS.length);
  });

  test('a mix of strong, familiar and new: the first area that is NEW is the answer', async ({ page }) => {
    await visitQuiz(page);
    await reach(page, { gateway: 'strong', mcp: 'ok' });
    await expect(card(page).locator('.start-title')).toHaveText('Retrieval');
    await expect(card(page).locator('.start-why')).toHaveText('You said this is new to you, so we begin here.');
    const row = (area: string) => host(page).locator(`.told-row[data-area="${area}"]`);
    await expect(row('gateway')).toContainText('You know this well');
    await expect(row('mcp')).toContainText('You have some experience');
    await expect(row('rag')).toContainText('New to you');
    // Level is shape and words, never colour alone: a full, a half and an empty dot, each beside its phrase.
    const dots = await host(page).locator('.told-dot').evaluateAll((els) =>
      els.map((e) => ({ level: e.getAttribute('data-level'), gradient: getComputedStyle(e).backgroundImage !== 'none', fill: getComputedStyle(e).backgroundColor }))
    );
    const dot = (level: string) => dots.find((d) => d.level === level)!;
    expect(dot('ok').gradient).toBe(true);
    expect(dot('strong').fill).not.toBe(dot('new').fill);
  });

  test('familiar and strong only: the first familiar area, "a good place to build on"', async ({ page }) => {
    await visitQuiz(page);
    await reach(page, { ...allStrong, rag: 'ok', otel: 'ok' });
    await expect(card(page).locator('.start-title')).toHaveText('Retrieval');
    await expect(card(page).locator('.start-why')).toHaveText('You know part of this already — a good place to build on.');
  });

  test('everything strong: it says so, and each area can be opened from its own line', async ({ page }) => {
    await visitQuiz(page);
    await reach(page, allStrong);
    await expect(card(page).locator('.start-why')).toHaveText('You know all of this well. Pick the area you want to sharpen.');
    await expect(host(page).locator('.told-row[data-level="strong"]')).toHaveCount(AREAS.length);
    const last = AREAS[AREAS.length - 1]!;
    await host(page).getByRole('button', { name: `Open ${last.title}` }).click();
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/paths/ai-platform/modules/${last.module}$`));
  });

  test('"Start with ..." leaves the quiz and opens that area\'s page, in place of the quiz in the history', async ({ page }) => {
    const s = await visitQuiz(page);
    await reach(page, { gateway: 'strong' });
    const next = AREAS[1]!;
    await expect(card(page).locator('.start-title')).toHaveText(next.title);
    const history = await page.evaluate(() => window.history.length);
    await card(page).getByRole('button', { name: `Start with ${next.title}` }).click();
    await expect(page.locator('#learnScreen')).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/paths/ai-platform/modules/${next.module}$`));
    await expect(page.locator('#launcher')).toBeVisible();
    // The quiz is replaced, not stacked: Back would not come back to it.
    expect(await page.evaluate(() => window.history.length)).toBe(history);
    const stored = JSON.parse((await page.evaluate(() => localStorage.getItem('opalixLearn')))!);
    expect(stored.onboarding.status).toBe('done');
    expect(s.errors).toEqual([]);
  });

  test('when the area has no page, "Start with ..." falls back to the labs list instead of a dead end', async ({ page }) => {
    const s = await visitQuiz(page, {}, WIDE, undefined, false);
    await reach(page, { gateway: 'strong' });
    await card(page).getByRole('button', { name: /^Start with / }).click();
    await expect(page.locator('#learnScreen')).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#launcher')).toBeVisible();
    await expect(page.locator('#notFound')).toBeHidden();
    expect(s.errors).toEqual([]);
  });

  test('the goal recap: the learner\'s own words and hours, and "Change" goes back to the goal question', async ({ page }) => {
    const s = await visitQuiz(page);
    await reach(page, {}, { kind: /Be ready for a role/, text: 'Run our gateway', hours: '6 hours' });
    await expect(host(page).locator('.goal-recap')).toContainText('Your goal: Run our gateway · about 6 hours a week');
    await expect.poll(() => s.puts.length).toBe(1);

    await host(page).getByRole('button', { name: 'Change your goal' }).click();
    await expect(heading(page)).toHaveText('What are you aiming for?');
    await expect(host(page).getByRole('radio', { name: /Be ready for a role/ })).toBeChecked();
    await expect(host(page).getByLabel('In a few words, what is it? (optional)')).toHaveValue('Run our gateway');
    await host(page).getByRole('radio', { name: /Explore/ }).check();
    await host(page).getByLabel('In a few words, what is it? (optional)').fill('');
    await host(page).getByRole('button', { name: 'Next', exact: true }).click();
    await host(page).getByRole('radio', { name: '2 hours' }).check();
    await host(page).getByRole('button', { name: 'See where to start' }).click();
    await expect(heading(page)).toHaveText('Where to start');
    await expect(host(page).locator('.goal-recap')).toContainText('Your goal: explore · about 2 hours a week');
    // The new goal is saved again, and the start card is as it was.
    await expect.poll(() => s.puts.length).toBe(2);
    expect(s.puts[1]).toMatchObject({ goal_kind: 'explore', hours_per_week: 2 });
    await expect(card(page).locator('.start-title')).toHaveText(AREAS[0]!.title);
  });

  test('skipping the goal questions still shows the recap, from the defaults', async ({ page }) => {
    await visitQuiz(page);
    await reach(page, {});
    await expect(host(page).locator('.goal-recap')).toContainText('Your goal: explore · about 4 hours a week');
  });

  test('"See my personal path" waits for the save, then opens /paths/mine', async ({ page }) => {
    const s = await visitQuiz(page);
    await reach(page, { gateway: 'ok' });
    await expect.poll(() => s.puts.length).toBe(1);
    const see = host(page).getByRole('button', { name: 'See my personal path' });
    await expect(see).toBeVisible();
    await see.click();
    await expect(page.locator('#learnScreen')).toBeHidden();
    await expect(page).toHaveURL(/\/paths\/mine$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Your path' })).toBeVisible();
    expect(s.errors).toEqual([]);
  });

  test('a path that could not be saved: no "See my personal path", and nothing says why', async ({ page }) => {
    const s = await visitQuiz(page, { putStatus: 500, path: null });
    await reach(page, {});
    await expect.poll(() => s.puts.length).toBe(1);
    await page.waitForTimeout(200);
    await expect(host(page).getByRole('button', { name: 'See my personal path' })).toBeHidden();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: /^Start with / })).toBeVisible();
    await expect(host(page).getByRole('button', { name: 'Browse all labs' })).toBeVisible();
    expect(s.errors).toEqual([]);
  });

  test('"Browse all labs" is the way to the labs list, and the screen explains itself in two short lines', async ({ page }) => {
    await visitQuiz(page);
    await reach(page, {});
    await expect(host(page)).toContainText('We shorten lessons on what you already know and open them in full where it is new. You can still open or skip any lesson.');
    await expect(host(page)).toContainText('You can retake this any time from the ? menu.');
    await host(page).locator('#btnOnboardingDone2').click();
    await expect(page.locator('#learnScreen')).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#launcher')).toBeVisible();
  });

  test('no module number anywhere on it, no marks, and none of the platform\'s words', async ({ page }) => {
    await visitQuiz(page);
    await reach(page, { gateway: 'strong', mcp: 'ok' }, { kind: /Learn a specific skill/, text: 'Trace a request', hours: '10 hours' });
    const text = await host(page).innerText();
    expect(text).not.toMatch(/\bmodules?\b/i);
    expect(text).not.toMatch(/\b(score|scored|grade|graded|points|percent)\b|\d+\s*%/i);
    // The only digit on the screen is the learner's own hours.
    expect(text.replace('about 10 hours a week', '')).not.toMatch(/\d/);
    await expectLearnerCopy(page, '#learnScreen');
    const labels = await host(page).locator('[aria-label], [title]').evaluateAll((els) => els.map((e) => `${e.getAttribute('aria-label')} ${e.getAttribute('title')}`));
    expect(labels.join(' ')).not.toMatch(/\bmodule\b/i);
  });

  test('the progress bar reads as finished: every step filled, with a check and "Done"', async ({ page }) => {
    await visitQuiz(page);
    await reach(page, {});
    const bar = host(page).locator('.steps');
    await expect(bar).toHaveClass(/steps-done/);
    await expect(bar.locator('i.on')).toHaveCount(4);
    await expect(bar.locator('.steps-done-label')).toHaveText('Done');
    await expect(bar.locator('.steps-done-label svg')).toHaveCount(1);
  });

  test('landmarks and keyboard: one h1, named sections, the heading has focus, every action is a real button in order', async ({ page }) => {
    await visitQuiz(page);
    await reach(page, {});
    await expect(host(page).getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(host(page).getByRole('heading', { level: 2 })).toHaveText(['Start here', 'What you told us']);
    await expect(host(page).getByRole('region', { name: 'Start here' })).toHaveCount(1);
    await expect(host(page).getByRole('region', { name: 'What you told us' })).toHaveCount(1);
    await expect(heading(page)).toBeFocused();
    await expect(host(page).getByRole('button', { name: 'See my personal path' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(card(page).getByRole('button', { name: /^Start with / })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(host(page).getByRole('button', { name: 'See my personal path' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(host(page).getByRole('button', { name: 'Change your goal' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(host(page).getByRole('button', { name: 'Browse all labs' })).toBeFocused();
    // Enter on the start card's button opens the area.
    await card(page).getByRole('button', { name: /^Start with / }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/paths/ai-platform/modules/${AREAS[0]!.module}$`));
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`on a phone, ${scheme}: no sideways scroll, 44px targets, the answer on the first screen`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await visitQuiz(page, {}, PHONE);
      await reach(page, { gateway: 'strong', mcp: 'ok', rag: 'ok' }, { kind: /Learn a specific skill/, text: 'A very long goal line that has to wrap on a narrow screen without pushing the page sideways', hours: '10 hours' });
      await noHorizontalScroll(page);
      for (const b of await host(page).getByRole('button').all()) {
        const box = await b.boundingBox();
        expect(box!.height, await b.innerText()).toBeGreaterThanOrEqual(43.5);
        expect(box!.x + box!.width).toBeLessThanOrEqual(390.5);
      }
      await expectLearnerCopy(page, '#learnScreen');
      const shots = process.env.SUMMARY_SHOTS_DIR;
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, `where-to-start-${scheme}-390.png`), fullPage: true });
      }
    });
  }
});
