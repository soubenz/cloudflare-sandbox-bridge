import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/env';
import { INDEX_KEY, type LabIndexEntry } from '../../src/labs/bundle';
import { PATH_MODEL } from '../../src/path/ai';
import type { AiCall, AiRequest } from '../../src/path/ai';
import type { PathInputs } from '../../src/path/inputs';
import { ensurePath, refreshPath, saveInputs, saveInputsAndRecompute, type PathJson } from '../../src/path/service';
import { sqliteD1, type Sqlite } from './sqlite-d1';
import { CATALOGUE, lab, slugs } from './path-fixtures';

/**
 * The path service against a real SQLite built from the repo's migrations
 * (so the new migration's SQL is exercised) and an in-memory catalogue. The
 * model call is always an injected stub: nothing here touches the network.
 */

const NOW = 1_700_000_000_000;
const deps = (ai: AiCall, extra: { timeoutMs?: number } = {}) => ({ ai, now: () => NOW, ...extra });

function setup(catalogue: LabIndexEntry[] = CATALOGUE) {
  const { db, sqlite } = sqliteD1();
  const bucket = { get: async (key: string) => (key === INDEX_KEY ? { json: async () => catalogue } : null) };
  const env = { DB: db, LABS_BUCKET: bucket } as unknown as Env;
  return { env, sqlite };
}

const setPlan = (sqlite: Sqlite, user: string, plan: string) =>
  sqlite.prepare(`INSERT INTO users (id, plan, created_at) VALUES (?, ?, ?)`).run(user, plan, NOW);

let runSeq = 0;
const complete = (sqlite: Sqlite, user: string, labSlug: string) =>
  sqlite
    .prepare(`INSERT INTO check_runs (id, session_id, started_at, user_id, lab_slug, passed_all) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(`run-${++runSeq}`, `sess-${runSeq}`, NOW, user, labSlug);

const INPUTS: PathInputs = {
  areas: { gateway: 'new', mcp: 'strong', rag: 'familiar' },
  goal_text: 'Run our company AI gateway',
  goal_kind: 'role-ready',
  hours_per_week: 2,
};

/** A stub model that answers with `reply` (or the result of a function of the request). */
function stub(reply: string | object | ((req: AiRequest) => unknown)) {
  return vi.fn<AiCall>(async (req) => {
    const r = typeof reply === 'function' ? (reply as (req: AiRequest) => unknown)(req) : reply;
    return typeof r === 'string' ? r : JSON.stringify(r);
  });
}

/** A model that answers validly: every lab in the prompt, in the order given. */
const echo = () => stub((req) => ({ steps: [...req.user.matchAll(/^- (\S+) \|/gm)].map((m) => ({ slug: m[1], why: 'Next up.' })) }));

describe('GET before inputs', () => {
  it('is 404 no_inputs, and never calls the model', async () => {
    const { env } = setup();
    const ai = echo();
    await expect(ensurePath(env, 'u1', {}, deps(ai))).rejects.toMatchObject({ status: 404, code: 'no_inputs' });
    expect(ai).not.toHaveBeenCalled();
  });
});

describe('golden path', () => {
  // The model's reply is deliberately flawed: a lab before its prerequisite, a
  // made-up slug, a duplicate, a reason that is too long, one that looks like
  // code, and one lab missing a reason.
  const REPLY = {
    steps: [
      { slug: 'standalone', why: 'Start with a quick win on a problem you will recognise.' },
      { slug: 'rag-basics', why: 'x'.repeat(121) },
      { slug: 'gw-capstone', why: 'Pulls the gateway ideas together on spend.' },
      { slug: 'gw-routing', why: 'Run `litellm --config` to add a model.' },
      { slug: 'made-up-lab', why: 'This lab does not exist.' },
      { slug: 'standalone', why: 'Duplicate.' },
      { slug: 'mcp-virtual' },
    ],
  };

  const EXPECTED: PathJson = {
    steps: [
      { slug: 'gw-intro', title: 'See what a gateway does', area: 'gateway', why: 'You have already finished this lab.', estimated_minutes: 20, status: 'done' },
      { slug: 'standalone', title: 'Weekend bill', area: 'agents', why: 'Start with a quick win on a problem you will recognise.', estimated_minutes: 40, status: 'next' },
      { slug: 'rag-basics', title: 'See why a document matched', area: 'rag', why: 'Builds on the earlier steps in Retrieval as a service.', estimated_minutes: 30, status: 'upcoming' },
      { slug: 'gw-routing', title: 'Add a model without touching app code', area: 'gateway', why: 'A first step into Gateway and access, which is new to you.', estimated_minutes: 30, status: 'upcoming' },
      { slug: 'gw-capstone', title: 'Hard budget per team', area: 'gateway', why: 'Pulls the gateway ideas together on spend.', estimated_minutes: 45, status: 'upcoming' },
      { slug: 'mcp-virtual', title: 'One endpoint for every tool', area: 'mcp', why: 'One lab to confirm what you already know about Tools and MCP.', estimated_minutes: 35, status: 'upcoming' },
    ],
    total_minutes: 180,
    weeks_estimate: 2,
    goal: { text: 'Run our company AI gateway', kind: 'role-ready' },
    source: 'ai',
    generated_at: NOW,
  };

  it('fixed inputs and a fixed model reply give exactly this path', async () => {
    const { env, sqlite } = setup();
    setPlan(sqlite, 'u1', 'pro');
    complete(sqlite, 'u1', 'gw-intro');
    const ai = stub(REPLY);
    const { path, cache } = await saveInputsAndRecompute(env, 'u1', INPUTS, deps(ai));
    expect(cache).toBe('miss');
    expect(path).toEqual(EXPECTED);
    expect(JSON.stringify(path)).toBe(JSON.stringify(EXPECTED)); // key order is part of the shape

    // The row is stored as the response is, with the model and a SHA-256 key.
    const row = sqlite.prepare(`SELECT * FROM user_paths WHERE user_id = 'u1'`).get() as Record<string, unknown>;
    expect(JSON.parse(row.path_json as string)).toEqual(EXPECTED);
    expect(row).toMatchObject({ source: 'ai', model: PATH_MODEL, created_at: NOW, updated_at: NOW });
    expect(row.input_hash).toMatch(/^[0-9a-f]{64}$/);
    const inputsRow = sqlite.prepare(`SELECT * FROM user_profile_inputs WHERE user_id = 'u1'`).get() as Record<string, unknown>;
    expect(inputsRow).toMatchObject({ goal_text: 'Run our company AI gateway', goal_kind: 'role-ready', hours_per_week: 2, updated_at: NOW });
    expect(JSON.parse(inputsRow.areas_json as string)).toEqual(INPUTS.areas);
  });

  it('a free learner: the same golden shape with locked steps, each saying why', async () => {
    const catalogue = [
      lab('gw-intro', { title: 'See what a gateway does', path: 'ai-platform', module: 1, order: 1, difficulty: 'intro', tier: 'free', estimated_minutes: 20 }),
      lab('gw-routing', { title: 'Add a model without touching app code', path: 'ai-platform', module: 1, order: 2, prerequisites: ['gw-intro'], estimated_minutes: 30 }),
      lab('gw-followup', { title: 'Read the spend report', path: 'ai-platform', module: 1, order: 3, prerequisites: ['gw-routing'], tier: 'free', estimated_minutes: 15 }),
    ];
    const { env, sqlite } = setup(catalogue);
    complete(sqlite, 'u1', 'gw-intro');
    const { path } = await saveInputsAndRecompute(env, 'u1', { ...INPUTS, areas: {} }, deps(stub({ steps: [] })));
    const expected: PathJson = {
      steps: [
        { slug: 'gw-intro', title: 'See what a gateway does', area: 'gateway', why: 'You have already finished this lab.', estimated_minutes: 20, status: 'done' },
        { slug: 'gw-routing', title: 'Add a model without touching app code', area: 'gateway', why: 'This lab is included with the Pro plan.', estimated_minutes: 30, status: 'locked', lock: 'plan' },
        { slug: 'gw-followup', title: 'Read the spend report', area: 'gateway', why: 'Unlocks after Add a model without touching app code.', estimated_minutes: 15, status: 'locked', lock: 'prerequisite' },
      ],
      total_minutes: 0,
      weeks_estimate: 0,
      goal: { text: 'Run our company AI gateway', kind: 'role-ready' },
      source: 'rules',
      generated_at: NOW,
    };
    expect(path).toEqual(expected);
    expect(JSON.stringify(path)).toBe(JSON.stringify(expected));
  });

  it('asks the model once, at temperature-0 settings, with the allowed labs only', async () => {
    const { env, sqlite } = setup();
    setPlan(sqlite, 'u1', 'pro');
    complete(sqlite, 'u1', 'gw-intro');
    const ai = stub(REPLY);
    await saveInputsAndRecompute(env, 'u1', INPUTS, deps(ai));
    expect(ai).toHaveBeenCalledTimes(1);
    const req = ai.mock.calls[0]![0];
    expect(req.model).toBe(PATH_MODEL);
    expect(req.skipCache).toBe(false);
    // Allowed: not done (gw-intro), not skipped by 'strong' (mcp-intro), not archived (old-lab).
    for (const slug of ['gw-routing', 'gw-capstone', 'mcp-virtual', 'rag-basics', 'standalone']) expect(req.user).toContain(slug);
    for (const slug of ['gw-intro', 'mcp-intro', 'old-lab']) expect(req.user).not.toContain(slug);
    expect(req.user).toContain('"Run our company AI gateway"');
    expect(req.user).toContain('Hours per week: 2');
  });
});

describe('cache', () => {
  it('the same inputs return the stored path and do not call the model', async () => {
    const { env } = setup();
    const ai = stub({ steps: CATALOGUE.map((l) => ({ slug: l.slug, why: 'ok' })) });
    await saveInputs(env, 'u1', INPUTS, NOW);
    const first = await ensurePath(env, 'u1', {}, deps(ai));
    const second = await ensurePath(env, 'u1', {}, deps(ai));
    expect(first.cache).toBe('miss');
    expect(second.cache).toBe('hit');
    expect(second.path).toEqual(first.path);
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('re-sending identical inputs is a hit too', async () => {
    const { env } = setup();
    const ai = echo();
    await saveInputsAndRecompute(env, 'u1', INPUTS, deps(ai));
    const again = await saveInputsAndRecompute(env, 'u1', { ...INPUTS }, deps(ai));
    expect(again.cache).toBe('hit');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('force bypasses the cache and the gateway cache, and replaces the stored path', async () => {
    const { env, sqlite } = setup();
    const ai = echo();
    await saveInputsAndRecompute(env, 'u1', INPUTS, deps(ai));
    const forced = await ensurePath(env, 'u1', { force: true }, { ai, now: () => NOW + 5 });
    expect(forced.cache).toBe('forced');
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[1]![0].skipCache).toBe(true);
    const row = sqlite.prepare(`SELECT created_at, updated_at FROM user_paths WHERE user_id = 'u1'`).get();
    expect(row).toEqual({ created_at: NOW, updated_at: NOW + 5 });
  });

  it.each([
    ['a different goal', { ...INPUTS, goal_text: 'Something else' }],
    ['different hours', { ...INPUTS, hours_per_week: 9 }],
    ['a different quiz level', { ...INPUTS, areas: { ...INPUTS.areas, rag: 'new' as const } }],
    ['a different goal kind', { ...INPUTS, goal_kind: 'explore' as const }],
  ])('%s makes a new key and asks the model again', async (_name, changed) => {
    const { env } = setup();
    const ai = echo();
    await saveInputsAndRecompute(env, 'u1', INPUTS, deps(ai));
    const next = await saveInputsAndRecompute(env, 'u1', changed, deps(ai));
    expect(next.cache).toBe('miss');
    expect(ai).toHaveBeenCalledTimes(2);
  });

  it('a new version of an allowed lab, or a lab that appears, makes a new key', async () => {
    const { env, sqlite } = setup();
    const ai = echo();
    await saveInputsAndRecompute(env, 'u1', INPUTS, deps(ai));
    const bumped = CATALOGUE.map((l) => (l.slug === 'rag-basics' ? { ...l, version: '1.1.0' } : l));
    const env2 = { ...env, LABS_BUCKET: { get: async () => ({ json: async () => bumped }) } } as unknown as Env;
    expect((await ensurePath(env2, 'u1', {}, deps(ai))).cache).toBe('miss');
    void sqlite;
  });

  it('a completed lab or a plan change makes a new key', async () => {
    const { env, sqlite } = setup();
    const ai = echo();
    await saveInputsAndRecompute(env, 'u1', INPUTS, deps(ai));
    complete(sqlite, 'u1', 'standalone');
    expect((await ensurePath(env, 'u1', {}, deps(ai))).cache).toBe('miss');
    setPlan(sqlite, 'u1', 'pro');
    expect((await ensurePath(env, 'u1', {}, deps(ai))).cache).toBe('miss');
  });

  it('users do not share a cache', async () => {
    const { env } = setup();
    const ai = echo();
    await saveInputsAndRecompute(env, 'u1', INPUTS, deps(ai));
    await saveInputsAndRecompute(env, 'u2', INPUTS, deps(ai));
    expect(ai).toHaveBeenCalledTimes(2);
  });
});

describe('fallback to the rules', () => {
  const rulesOrderPro = ['gw-routing', 'gw-capstone', 'mcp-virtual', 'rag-basics', 'standalone'];

  async function run(ai: AiCall, extra: { timeoutMs?: number } = {}) {
    const { env, sqlite } = setup();
    setPlan(sqlite, 'u1', 'pro');
    complete(sqlite, 'u1', 'gw-intro');
    const result = await saveInputsAndRecompute(env, 'u1', INPUTS, deps(ai, extra));
    return { ...result, sqlite };
  }

  it.each([
    ['the call throws', () => vi.fn<AiCall>(async () => { throw new Error('gateway answered 502'); })],
    ['the reply is not JSON', () => stub('Sure! Here is your order: gw-routing, then ...')],
    ['the reply has no steps', () => stub({ order: 'whatever' })],
    ['the reply names no lab', () => stub({ steps: [{ nope: 1 }] })],
  ])('%s: source is rules, in rules order, with generic reasons', async (_name, make) => {
    const { path, sqlite } = await run(make());
    expect(path.source).toBe('rules');
    expect(slugs(path.steps.filter((s) => s.status !== 'done'))).toEqual(rulesOrderPro);
    expect(path.steps[0]).toMatchObject({ slug: 'gw-intro', status: 'done' });
    expect(path.steps[1]).toMatchObject({ slug: 'gw-routing', status: 'next', why: 'A first step into Gateway and access, which is new to you.' });
    expect(path.steps.every((s) => s.why.length > 0 && s.why.length <= 120)).toBe(true);
    expect(sqlite.prepare(`SELECT source, model FROM user_paths`).get()).toEqual({ source: 'rules', model: null });
  });

  it('a model that does not answer within the timeout is abandoned', async () => {
    const hang = vi.fn<AiCall>(() => new Promise<string>(() => {}));
    const { path } = await run(hang, { timeoutMs: 20 });
    expect(hang).toHaveBeenCalledTimes(1);
    expect(path.source).toBe('rules');
  });

  it('the timeout aborts the call it gave up on', async () => {
    let aborted = false;
    const slow = vi.fn<AiCall>((_req, signal) => new Promise<string>(() => signal.addEventListener('abort', () => (aborted = true))));
    await run(slow, { timeoutMs: 20 });
    expect(aborted).toBe(true);
  });

  it('a fallback path is cached like any other: the next read does not ask the model again', async () => {
    const { env } = setup();
    const ai = vi.fn<AiCall>(async () => { throw new Error('down'); });
    await saveInputsAndRecompute(env, 'u1', INPUTS, deps(ai));
    expect((await ensurePath(env, 'u1', {}, deps(ai))).cache).toBe('hit');
    expect(ai).toHaveBeenCalledTimes(1);
  });
});

describe('what the model is never asked', () => {
  it('with nothing or one lab to order there is no model call', async () => {
    const one = [lab('only', { path: 'x', module: 1, order: 1, tier: 'free' })];
    const { env } = setup(one);
    const ai = echo();
    const { path } = await saveInputsAndRecompute(env, 'u1', INPUTS, deps(ai));
    expect(ai).not.toHaveBeenCalled();
    expect(path).toMatchObject({ source: 'rules', total_minutes: 30, weeks_estimate: 1 });
    expect(path.steps).toEqual([{ slug: 'only', title: 'Lab only', area: null, why: 'The next step on your path.', estimated_minutes: 30, status: 'next' }]);

    const empty = setup([]);
    const none = await saveInputsAndRecompute(empty.env, 'u1', INPUTS, deps(ai));
    expect(none.path).toMatchObject({ steps: [], total_minutes: 0, weeks_estimate: 0, source: 'rules' });
    expect(ai).not.toHaveBeenCalled();
  });

  it('a free learner: pro labs are shown locked, last, outside the totals, and never sent to the model', async () => {
    const { env } = setup(); // no users row: the free plan
    const ai = stub((req) => ({ steps: [...req.user.matchAll(/^- (\S+) \|/gm)].map((m) => ({ slug: m[1], why: 'Next up.' })).reverse() }));
    const { path } = await saveInputsAndRecompute(env, 'u1', { ...INPUTS, areas: {} }, deps(ai));
    const prompt = ai.mock.calls[0]![0].user;
    for (const locked of ['gw-routing', 'gw-capstone', 'rag-basics']) expect(prompt).not.toContain(locked);
    // The stub reversed the rules' order; mcp-virtual is moved back behind its prerequisite.
    expect(path.steps.map((s) => `${s.slug}:${s.status}`)).toEqual([
      'standalone:next',
      'mcp-intro:upcoming',
      'mcp-virtual:upcoming',
      'gw-intro:upcoming',
      'gw-routing:locked',
      'gw-capstone:locked',
      'rag-basics:locked',
    ]);
    expect(path.total_minutes).toBe(40 + 35 + 25 + 20);
  });
});

describe('locked steps say why', () => {
  const FREE_INPUTS = { ...INPUTS, areas: {} };

  it('a plan lock carries lock: plan and the stock reason', async () => {
    const { env } = setup();
    const { path } = await saveInputsAndRecompute(env, 'u1', FREE_INPUTS, deps(echo()));
    const locked = path.steps.filter((s) => s.status === 'locked');
    expect(locked.map((s) => `${s.slug}:${s.lock}`)).toEqual(['gw-routing:plan', 'gw-capstone:plan', 'rag-basics:plan']);
    for (const s of locked) expect(s.why).toBe('This lab is included with the Pro plan.');
    // Only locked steps have the field.
    for (const s of path.steps.filter((x) => x.status !== 'locked')) expect(s).not.toHaveProperty('lock');
  });

  it('a prerequisite lock carries lock: prerequisite and names the lab it waits for', async () => {
    const catalogue = [
      lab('a', { title: 'First lab', path: 'x', module: 1, order: 1, tier: 'free' }),
      lab('b', { title: 'Paid lab', path: 'x', module: 1, order: 2, prerequisites: ['a'] }),
      lab('c', { title: 'Free lab after paid', path: 'x', module: 1, order: 3, prerequisites: ['b'], tier: 'free' }),
    ];
    const { env } = setup(catalogue);
    const { path } = await saveInputsAndRecompute(env, 'u1', FREE_INPUTS, deps(echo()));
    expect(path.steps.map((s) => [s.slug, s.status, s.lock, s.why])).toEqual([
      ['a', 'next', undefined, 'The next step on your path.'],
      ['b', 'locked', 'plan', 'This lab is included with the Pro plan.'],
      ['c', 'locked', 'prerequisite', 'Unlocks after Paid lab.'],
    ]);
  });

  it('a very long prerequisite title is cut so the reason stays one short sentence', async () => {
    const catalogue = [lab('b', { title: 'T'.repeat(200), path: 'x', module: 1, order: 1 }), lab('c', { path: 'x', module: 1, order: 2, prerequisites: ['b'], tier: 'free' })];
    const { env } = setup(catalogue);
    const { path } = await saveInputsAndRecompute(env, 'u1', FREE_INPUTS, deps(echo()));
    const c = path.steps.find((s) => s.slug === 'c')!;
    expect(c.lock).toBe('prerequisite');
    expect(c.why.length).toBeLessThanOrEqual(120);
    expect(c.why).toMatch(/^Unlocks after T+…\.$/);
  });

  it('a path stored before steps carried lock gets it on the next read, and nothing else changes', async () => {
    const catalogue = [
      lab('a', { path: 'x', module: 1, order: 1, tier: 'free' }),
      lab('b', { title: 'Paid lab', path: 'x', module: 1, order: 2, prerequisites: ['a'] }),
      lab('c', { path: 'x', module: 1, order: 3, prerequisites: ['b'], tier: 'free' }),
    ];
    const { env, sqlite } = setup(catalogue);
    const first = await saveInputsAndRecompute(env, 'u1', FREE_INPUTS, deps(echo()));
    const old = { ...first.path, steps: first.path.steps.map(({ lock: _lock, ...rest }) => ({ ...rest, ...(rest.status === 'locked' ? { why: 'Included with the Pro plan.' } : {}) })) };
    sqlite.prepare(`UPDATE user_paths SET path_json = ? WHERE user_id = 'u1'`).run(JSON.stringify(old));
    const ai = echo();
    const again = await ensurePath(env, 'u1', {}, deps(ai));
    expect(again.cache).toBe('hit');
    expect(ai).not.toHaveBeenCalled();
    expect(again.path).toEqual(first.path);
  });
});

describe('statuses', () => {
  it('done first, then the first not-done step is next and the rest upcoming', async () => {
    const { env, sqlite } = setup();
    setPlan(sqlite, 'u1', 'pro');
    complete(sqlite, 'u1', 'gw-intro');
    complete(sqlite, 'u1', 'standalone');
    const { path } = await saveInputsAndRecompute(env, 'u1', { ...INPUTS, areas: {} }, deps(echo()));
    expect(path.steps.map((s) => `${s.slug}:${s.status}`)).toEqual([
      'gw-intro:done',
      'standalone:done',
      'gw-routing:next',
      'gw-capstone:upcoming',
      'mcp-intro:upcoming',
      'mcp-virtual:upcoming',
      'rag-basics:upcoming',
    ]);
  });

  it('when every lab is done there is no next step and no time left', async () => {
    const { env, sqlite } = setup();
    setPlan(sqlite, 'u1', 'pro');
    for (const l of CATALOGUE.filter((c) => !c.archived)) complete(sqlite, 'u1', l.slug);
    const { path } = await saveInputsAndRecompute(env, 'u1', { ...INPUTS, areas: {} }, deps(echo()));
    expect(path.steps.every((s) => s.status === 'done')).toBe(true);
    expect(path).toMatchObject({ total_minutes: 0, weeks_estimate: 0 });
  });

  it('weeks round up from the hours per week', async () => {
    const { env } = setup([lab('a', { estimated_minutes: 60, tier: 'free' }), lab('b', { estimated_minutes: 61, tier: 'free' }), lab('c', { estimated_minutes: 60, tier: 'free' })]);
    const ai = echo();
    const weeks = async (hours: number) => (await saveInputsAndRecompute(env, 'u1', { ...INPUTS, areas: {}, hours_per_week: hours }, deps(ai))).path.weeks_estimate;
    expect(await weeks(1)).toBe(4); // 181 minutes at 60 a week
    expect(await weeks(3)).toBe(2); // 181 at 180 a week
    expect(await weeks(20)).toBe(1);
  });
});

describe('refreshPath, after a lab is completed', () => {
  it('marks the lab done, moves next, keeps the order and reasons, and does not call the model', async () => {
    const { env, sqlite } = setup();
    setPlan(sqlite, 'u1', 'pro');
    const ai = stub({ steps: [{ slug: 'standalone', why: 'A quick win first.' }, { slug: 'rag-basics', why: 'Then retrieval.' }] });
    const before = (await saveInputsAndRecompute(env, 'u1', { ...INPUTS, areas: {} }, deps(ai))).path;
    expect(before.steps[0]).toMatchObject({ slug: 'standalone', status: 'next', why: 'A quick win first.' });
    const hashBefore = (sqlite.prepare(`SELECT input_hash FROM user_paths`).get() as { input_hash: string }).input_hash;

    complete(sqlite, 'u1', 'standalone');
    expect(await refreshPath(env, 'u1', { ai, now: () => NOW + 10 })).toBe('refreshed');

    expect(ai).toHaveBeenCalledTimes(1);
    const row = sqlite.prepare(`SELECT input_hash, path_json, source, model FROM user_paths`).get() as { input_hash: string; path_json: string; source: string; model: string };
    const after = JSON.parse(row.path_json) as PathJson;
    expect(row.input_hash).not.toBe(hashBefore);
    expect(row).toMatchObject({ source: 'ai', model: PATH_MODEL });
    expect(after.steps[0]).toMatchObject({ slug: 'standalone', status: 'done' });
    expect(after.steps[1]).toMatchObject({ slug: 'rag-basics', status: 'next', why: 'Then retrieval.' });
    expect(slugs(after.steps).filter((s) => s !== 'standalone')).toEqual(slugs(before.steps).filter((s) => s !== 'standalone'));
    expect(after.total_minutes).toBe(before.total_minutes - 40);
    expect(after.generated_at).toBe(NOW + 10);

    // The next read is a hit, not a new model call.
    expect((await ensurePath(env, 'u1', {}, deps(ai))).cache).toBe('hit');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing the path was built from has changed', async () => {
    const { env } = setup();
    const ai = echo();
    await saveInputsAndRecompute(env, 'u1', INPUTS, deps(ai));
    expect(await refreshPath(env, 'u1', deps(ai))).toBe('current');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('has nothing to do for a user with no inputs, or no stored path yet', async () => {
    const { env } = setup();
    const ai = echo();
    expect(await refreshPath(env, 'nobody', deps(ai))).toBe('none');
    await saveInputs(env, 'u1', INPUTS, NOW);
    expect(await refreshPath(env, 'u1', deps(ai))).toBe('none');
    expect(ai).not.toHaveBeenCalled();
  });

  it('a lab published since is appended in rules order with a generic reason', async () => {
    const { env, sqlite } = setup();
    setPlan(sqlite, 'u1', 'pro');
    const ai = echo();
    await saveInputsAndRecompute(env, 'u1', { ...INPUTS, areas: {} }, deps(ai));
    const added = [...CATALOGUE, lab('brand-new', { path: 'production-agents', module: 1, order: 2, title: 'Brand new', estimated_minutes: 15 })];
    const env2 = { ...env, LABS_BUCKET: { get: async () => ({ json: async () => added }) } } as unknown as Env;
    expect(await refreshPath(env2, 'u1', deps(ai))).toBe('refreshed');
    const path = JSON.parse((sqlite.prepare(`SELECT path_json FROM user_paths`).get() as { path_json: string }).path_json) as PathJson;
    expect(path.steps.at(-1)).toMatchObject({ slug: 'brand-new', status: 'upcoming', why: 'Builds on the earlier steps in Agent builder.' });
    expect(ai).toHaveBeenCalledTimes(1);
  });
});

describe('storage', () => {
  beforeEach(() => {
    runSeq = 0;
  });

  it('replaces a user\'s inputs in place: one row per user', async () => {
    const { env, sqlite } = setup();
    await saveInputs(env, 'u1', INPUTS, NOW);
    await saveInputs(env, 'u1', { ...INPUTS, hours_per_week: 7, goal_text: null }, NOW + 1);
    const rows = sqlite.prepare(`SELECT * FROM user_profile_inputs`).all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([{ user_id: 'u1', areas_json: JSON.stringify({ gateway: 'new', mcp: 'strong', rag: 'familiar' }), goal_text: null, goal_kind: 'role-ready', hours_per_week: 7, updated_at: NOW + 1 }]);
  });

  it('the migration refuses out-of-range hours and an unknown goal kind or source', () => {
    const { sqlite } = setup();
    const insert = (kind: string, hours: number) =>
      sqlite.prepare(`INSERT INTO user_profile_inputs (user_id, areas_json, goal_kind, hours_per_week, updated_at) VALUES ('x', '{}', ?, ?, 0)`).run(kind, hours);
    expect(() => insert('explore', 0)).toThrow();
    expect(() => insert('explore', 21)).toThrow();
    expect(() => insert('career', 5)).toThrow();
    expect(() => insert('explore', 5)).not.toThrow();
    expect(() => sqlite.prepare(`INSERT INTO user_paths (user_id, input_hash, path_json, source, created_at, updated_at) VALUES ('x','h','{}','guess',0,0)`).run()).toThrow();
  });

  it('an unreadable stored path is treated as no cache and replaced', async () => {
    const { env, sqlite } = setup();
    const ai = echo();
    await saveInputsAndRecompute(env, 'u1', INPUTS, deps(ai));
    sqlite.prepare(`UPDATE user_paths SET path_json = 'not json'`).run();
    expect((await ensurePath(env, 'u1', {}, deps(ai))).cache).toBe('miss');
    expect(() => JSON.parse((sqlite.prepare(`SELECT path_json FROM user_paths`).get() as { path_json: string }).path_json)).not.toThrow();
  });
});
