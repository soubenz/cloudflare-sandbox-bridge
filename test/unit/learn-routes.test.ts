import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type { Env } from '../../src/env';
import { mintSessionToken } from '../../src/auth';
import { learnKey, manifestKey, solutionKey, privateKey, currentKey, loadCatalogue } from '../../src/labs/bundle';
import { loadOnboarding } from '../../src/labs/onboarding';
import { parseOnboarding, type Onboarding } from '../../src/labs/learn';
import { sqliteD1 } from './sqlite-d1';

/**
 * The learning layer's backend, driven through the real router: publish with
 * a learn part, GET /labs/:slug/learn, the catalogue's has_learn, the onboarding
 * quiz, anonymous answer analytics (real SQLite, the repo's own migrations)
 * and GET /admin/learning.
 */

const pool = vi.hoisted(() => ({ admit: vi.fn(async () => {}), stats: vi.fn() }));
vi.mock('../../src/do/pool', () => ({ poolStub: () => pool }));

// The route calls loadOnboarding() with no argument; a test picks what that
// resolves to. 'real' runs the genuine loader (whatever is on disk).
const onboardingMode = vi.hoisted(() => ({ value: 'real' as 'real' | 'absent' | { raw: unknown } }));
vi.mock('../../src/labs/onboarding', async (importActual) => {
  const actual = await importActual<typeof import('../../src/labs/onboarding')>();
  return {
    ...actual,
    loadOnboarding: (loader?: Parameters<typeof actual.loadOnboarding>[0]) => {
      if (loader || onboardingMode.value === 'real') return actual.loadOnboarding(loader);
      const v = onboardingMode.value;
      return actual.loadOnboarding(async () => {
        if (v === 'absent') throw new Error('Failed to load url ../../packages/catalogue/onboarding.json');
        return v.raw;
      });
    },
  };
});

const { createRouter } = await import('../../src/router');
const app = createRouter();

const SERVICE = { Authorization: 'Bearer svc-key' };

/** In-memory R2 with the surface bundle.ts uses. */
function fakeBucket() {
  const store = new Map<string, string>();
  const bucket = {
    async get(key: string) {
      const v = store.get(key);
      return v === undefined ? null : { text: async () => v, json: async () => JSON.parse(v) };
    },
    async head(key: string) {
      return store.has(key) ? { key } : null;
    },
    async put(key: string, value: unknown) {
      store.set(key, typeof value === 'string' ? value : `bytes:${(value as ArrayBuffer).byteLength}`);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts: { prefix?: string } = {}) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort().map((key) => ({ key })), truncated: false };
    },
  };
  return { bucket, store };
}

function makeEnv() {
  const { db, sqlite } = sqliteD1();
  const { bucket, store } = fakeBucket();
  const env = { SANDBOX_API_KEY: 'svc-key', SESSION_TOKEN_SECRET: 'secret', PUBLIC_BASE_URL: 'https://api.test', DB: db, LABS_BUCKET: bucket } as unknown as Env;
  return { env, sqlite, store };
}

const call = (env: Env, method: string, path: string, opts: { json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}) =>
  app.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: { ...(opts.json !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
    }),
    env
  );
const j = async (res: Response) => (await res.json()) as any;

function manifest(slug: string, version = '1.0.0') {
  return {
    slug, version, title: `Lab ${slug}`, type: 'build', family: 'agent', timeout_minutes: 60,
    services: [{ name: 'svc', argv: ['x'], port: 8000 }],
    checks: [{ name: 'c', script: 'c.sh' }],
  };
}

const learnBundle = () => ({
  version: 1,
  story: { title: 'Monday at Larkfield', minutes: 2, body: 'You start on Monday.' },
  concepts: [{ id: 'gateway.routing-aliases', title: 'Aliases', minutes: 2, recap: 'An alias maps a name to a model.', body: 'An alias is a stable name.' }],
  questions: [
    {
      id: 'q-alias', concept: 'gateway.routing-aliases', type: 'single', prompt: 'What does an alias give callers?',
      options: [{ id: 'a', text: 'A stable name' }, { id: 'b', text: 'A faster model' }],
      answer: ['a'], explanation: 'Callers keep one name while the model behind it changes.',
    },
  ],
});

function publishForm(m: unknown, opts: { learn?: string | null; solution?: boolean; force?: boolean } = {}) {
  const form = new FormData();
  form.set('manifest', new Blob([JSON.stringify(m)], { type: 'application/json' }), 'manifest.json');
  form.set('workspace', new Blob([new Uint8Array(4)]), 'workspace.tgz');
  form.set('private', new Blob([new Uint8Array(4)]), 'private.tgz');
  if (opts.solution) form.set('solution', new Blob([new Uint8Array(4)]), 'solution.tgz');
  if (opts.learn != null) form.set('learn', new Blob([opts.learn], { type: 'application/json' }), 'learn.json');
  if (opts.force) form.set('force', 'true');
  return form;
}

const publish = (env: Env, m: unknown, opts: Parameters<typeof publishForm>[1] = {}) =>
  call(env, 'POST', '/labs/publish', { body: publishForm(m, opts), headers: SERVICE });

beforeEach(() => {
  onboardingMode.value = 'real';
});

describe('publish with a learn part', () => {
  it('stores the parsed bundle at learn.json and serves it at GET /labs/:slug/learn', async () => {
    const { env, store } = makeEnv();
    const res = await publish(env, manifest('gw-lab'), { learn: JSON.stringify(learnBundle()) });
    expect(res.status).toBe(201);
    expect(store.has(learnKey('gw-lab', '1.0.0'))).toBe(true);
    expect(learnKey('gw-lab', '1.0.0')).toBe('labs/gw-lab/1.0.0/learn.json');

    const got = await call(env, 'GET', '/labs/gw-lab/learn', { headers: SERVICE });
    expect(got.status).toBe(200);
    const body = await j(got);
    expect(body.version).toBe('1.0.0');
    // Defaults the CLI left out are filled in by the Worker's parse.
    expect(body.learn).toMatchObject({ version: 1, answers_file: 'answers.json', fields: [] });
    expect(body.learn.questions[0]).toMatchObject({ id: 'q-alias', diagnostic: true });
    expect(body.learn.story.title).toBe('Monday at Larkfield');
  });

  it('serves only the bundle: nothing from checks, the solution or the workspace', async () => {
    const { env, store } = makeEnv();
    await publish(env, manifest('gw-lab'), { learn: JSON.stringify(learnBundle()), solution: true });
    expect(store.has(solutionKey('gw-lab', '1.0.0'))).toBe(true);
    expect(store.has(privateKey('gw-lab', '1.0.0'))).toBe(true);
    const body = await j(await call(env, 'GET', '/labs/gw-lab/learn', { headers: SERVICE }));
    expect(Object.keys(body).sort()).toEqual(['learn', 'version']);
    expect(Object.keys(body.learn).sort()).toEqual(['answers_file', 'concepts', 'fields', 'questions', 'story', 'version']);
  });

  it('sets has_learn on the catalogue entry, true and false', async () => {
    const { env } = makeEnv();
    await publish(env, manifest('with-learn'), { learn: JSON.stringify(learnBundle()) });
    await publish(env, manifest('without-learn'));
    const index = await loadCatalogue(env);
    expect(Object.fromEntries(index.map((e) => [e.slug, e.has_learn]))).toEqual({ 'with-learn': true, 'without-learn': false });
    const listed = await j(await call(env, 'GET', '/labs', { headers: SERVICE }));
    expect(listed.find((e: { slug: string }) => e.slug === 'with-learn').has_learn).toBe(true);
  });

  it('does not trust the CLI: a bundle that fails parseLearnBundle is 400 and nothing is stored', async () => {
    const { env, store } = makeEnv();
    const bad = { ...learnBundle(), concepts: [{ ...learnBundle().concepts[0]!, id: 'nowhere.not-a-concept' }] };
    const res = await publish(env, manifest('gw-lab'), { learn: JSON.stringify(bad) });
    expect(res.status).toBe(400);
    const err = (await j(res)).error;
    expect(err.code).toBe('invalid_learn_bundle');
    expect(err.message).toMatch(/nowhere\.not-a-concept/);
    expect([...store.keys()]).toEqual([]);
  });

  it('lists every problem of a bad bundle, and refuses HTML in a lesson', async () => {
    const { env } = makeEnv();
    const c = learnBundle().concepts[0]!;
    const bad = { ...learnBundle(), concepts: [{ ...c, body: '<script>x</script>' }], questions: [{ ...learnBundle().questions[0]!, answer: ['zzz'] }] };
    const err = (await j(await publish(env, manifest('gw-lab'), { learn: JSON.stringify(bad) }))).error;
    expect(err.code).toBe('invalid_learn_bundle');
    expect(err.message).toMatch(/HTML/);
    expect(err.message).toMatch(/zzz/);
  });

  it('a learn part that is not JSON is 400 invalid_learn_bundle', async () => {
    const { env, store } = makeEnv();
    const res = await publish(env, manifest('gw-lab'), { learn: '{not json' });
    expect(res.status).toBe(400);
    expect((await j(res)).error.code).toBe('invalid_learn_bundle');
    expect(store.size).toBe(0);
  });

  it('an empty learn part counts as none', async () => {
    const { env, store } = makeEnv();
    const form = publishForm(manifest('gw-lab'));
    form.set('learn', new Blob([]), 'learn.json');
    const res = await call(env, 'POST', '/labs/publish', { body: form, headers: SERVICE });
    expect(res.status).toBe(201);
    expect(store.has(learnKey('gw-lab', '1.0.0'))).toBe(false);
  });

  it('a forced re-publish without a learn part removes the one the version had; a plain one keeps it out of the way', async () => {
    const { env, store } = makeEnv();
    await publish(env, manifest('gw-lab'), { learn: JSON.stringify(learnBundle()) });
    expect(store.has(learnKey('gw-lab', '1.0.0'))).toBe(true);
    expect((await publish(env, manifest('gw-lab'))).status).toBe(409);
    expect(store.has(learnKey('gw-lab', '1.0.0'))).toBe(true);
    expect((await publish(env, manifest('gw-lab'), { force: true })).status).toBe(201);
    expect(store.has(learnKey('gw-lab', '1.0.0'))).toBe(false);
    expect((await call(env, 'GET', '/labs/gw-lab/learn', { headers: SERVICE })).status).toBe(404);
    expect((await loadCatalogue(env))[0]!.has_learn).toBe(false);
  });

  it('a new version without learn/ serves no learn even though the old version had one', async () => {
    const { env, store } = makeEnv();
    await publish(env, manifest('gw-lab', '1.0.0'), { learn: JSON.stringify(learnBundle()) });
    await publish(env, manifest('gw-lab', '1.1.0'));
    expect(store.has(learnKey('gw-lab', '1.0.0'))).toBe(true);
    const res = await call(env, 'GET', '/labs/gw-lab/learn', { headers: SERVICE });
    expect(res.status).toBe(404);
    expect((await j(res)).error.code).toBe('no_learn');
  });
});

describe('GET /labs/:slug/learn', () => {
  it('404 lab_not_found for a lab that is not published, 404 no_learn for one without learning content', async () => {
    const { env } = makeEnv();
    const missing = await call(env, 'GET', '/labs/nothing-here/learn', { headers: SERVICE });
    expect(missing.status).toBe(404);
    expect((await j(missing)).error.code).toBe('lab_not_found');
    await publish(env, manifest('plain-lab'));
    const plain = await call(env, 'GET', '/labs/plain-lab/learn', { headers: SERVICE });
    expect(plain.status).toBe(404);
    expect((await j(plain)).error.code).toBe('no_learn');
  });

  it('needs the service key: none, a wrong key and a session token are all 401', async () => {
    const { env } = makeEnv();
    await publish(env, manifest('gw-lab'), { learn: JSON.stringify(learnBundle()) });
    const token = await mintSessionToken(env, { sid: 's1', uid: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 });
    for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: `Bearer ${token}` }] as Array<Record<string, string>>) {
      expect((await call(env, 'GET', '/labs/gw-lab/learn', { headers })).status).toBe(401);
    }
  });

  it('keeps serving a bundle whose concept has since left the registry (read is schema-only)', async () => {
    const { env, store } = makeEnv();
    await publish(env, manifest('gw-lab'), { learn: JSON.stringify(learnBundle()) });
    const stored = JSON.parse(store.get(learnKey('gw-lab', '1.0.0'))!);
    stored.concepts[0].id = 'retired.old-concept';
    stored.questions[0].concept = 'retired.old-concept';
    store.set(learnKey('gw-lab', '1.0.0'), JSON.stringify(stored));
    expect((await call(env, 'GET', '/labs/gw-lab/learn', { headers: SERVICE })).status).toBe(200);
  });

  it('a corrupt stored learn.json is a 500, not a crash', async () => {
    const { env, store } = makeEnv();
    await publish(env, manifest('gw-lab'), { learn: JSON.stringify(learnBundle()) });
    store.set(learnKey('gw-lab', '1.0.0'), JSON.stringify({ version: 2 }));
    expect((await call(env, 'GET', '/labs/gw-lab/learn', { headers: SERVICE })).status).toBe(500);
  });
});

describe('GET /learn/onboarding', () => {
  const onboardingOnDisk = existsSync('packages/catalogue/onboarding.json');

  it('needs the service key', async () => {
    const { env } = makeEnv();
    expect((await call(env, 'GET', '/learn/onboarding')).status).toBe(401);
  });

  it('with the real loader: the file on disk if there is one (parsed), a 404 no_onboarding if there is not', async () => {
    const { env } = makeEnv();
    const res = await call(env, 'GET', '/learn/onboarding', { headers: SERVICE });
    if (onboardingOnDisk) {
      expect(res.status).toBe(200);
      expect(await j(res)).toEqual(parseOnboarding(JSON.parse(readFileSync('packages/catalogue/onboarding.json', 'utf8'))));
    } else {
      expect(res.status).toBe(404);
      expect((await j(res)).error.code).toBe('no_onboarding');
    }
  });

  it('404 no_onboarding when the file is absent from the bundle', async () => {
    const { env } = makeEnv();
    onboardingMode.value = 'absent';
    const res = await call(env, 'GET', '/learn/onboarding', { headers: SERVICE });
    expect(res.status).toBe(404);
    expect((await j(res)).error.code).toBe('no_onboarding');
  });

  it('200 with the parsed quiz when present, 500 when the file is present but invalid', async () => {
    const { env } = makeEnv();
    if (!onboardingOnDisk) return; // a valid fixture needs the real quiz's questions; covered by the loader tests below
    const real = JSON.parse(readFileSync('packages/catalogue/onboarding.json', 'utf8'));
    onboardingMode.value = { raw: real };
    const ok = await call(env, 'GET', '/learn/onboarding', { headers: SERVICE });
    expect(ok.status).toBe(200);
    const body = await j(ok);
    expect(body.questions.length).toBe(real.questions.length);
    // The branching shape: a one-line blurb per area, and a basic or advanced level on every question.
    expect(Object.keys(body).sort()).toEqual(['areas', 'intro', 'questions', 'version']);
    expect(body.areas.map((a: { area: string }) => a.area).sort()).toEqual(['gateway', 'mcp', 'otel', 'platform', 'rag', 'sovereignty']);
    for (const a of body.areas) expect(a.blurb.length).toBeLessThanOrEqual(90);
    for (const q of body.questions) expect(['basic', 'advanced']).toContain(q.level);
    onboardingMode.value = { raw: { ...real, questions: real.questions.slice(0, 2) } };
    expect((await call(env, 'GET', '/learn/onboarding', { headers: SERVICE })).status).toBe(500);
    // An old-shaped quiz (no levels) is not served either.
    onboardingMode.value = { raw: { ...real, questions: real.questions.map(({ level: _l, ...rest }: { level: string }) => rest) } };
    expect((await call(env, 'GET', '/learn/onboarding', { headers: SERVICE })).status).toBe(500);
  });
});

describe('loadOnboarding', () => {
  it('is null when the import says the file is not there, for each way a bundler says so', async () => {
    for (const msg of [
      'Unknown variable dynamic import: ../../packages/catalogue/onboarding.json',
      'Module not found in bundle: ../../packages/catalogue/onboarding.json',
      'Failed to load url ../../packages/catalogue/onboarding.json (resolved id: x). Does the file exist?',
      "Cannot find module '../../packages/catalogue/onboarding.json'",
    ]) {
      expect(await loadOnboarding(async () => { throw new Error(msg); })).toBeNull();
    }
  });

  it('rethrows any other import failure, and throws on a present-but-invalid quiz', async () => {
    await expect(loadOnboarding(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(loadOnboarding(async () => ({ version: 1, intro: 'hi', questions: [] }))).rejects.toThrow(/Invalid onboarding quiz/);
  });

  it('the default loader agrees with the file system, whether or not another change has added the file yet', async () => {
    const onDisk = existsSync('packages/catalogue/onboarding.json');
    const got = await loadOnboarding();
    if (onDisk) {
      const expected: Onboarding = parseOnboarding(JSON.parse(readFileSync('packages/catalogue/onboarding.json', 'utf8')));
      expect(got).toEqual(expected);
    } else {
      expect(got).toBeNull();
    }
  });
});

const answer = (over: Record<string, unknown> = {}) => ({
  question_id: 'q-alias', concept: 'gateway.routing-aliases', correct: true, phase: 'diagnostic', ...over,
});
const post = (env: Env, json: unknown, headers: Record<string, string> = SERVICE) => call(env, 'POST', '/learn/answers', { json, headers });

describe('POST /learn/answers', () => {
  it('inserts every answer in one batch and stores nothing about the learner', async () => {
    const { env, sqlite } = makeEnv();
    const res = await post(env, {
      lab_slug: 'gw-lab', lab_version: '1.0.0',
      answers: [answer(), answer({ question_id: 'q-two', correct: false }), answer({ question_id: 'ob-1', phase: 'onboarding' })],
    });
    expect(res.status).toBe(201);
    expect(await j(res)).toEqual({ ok: true, recorded: 3 });
    const rows = sqlite.prepare('SELECT * FROM learn_answers ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.lab_slug, r.lab_version, r.question_id, r.concept, r.correct, r.phase])).toEqual([
      ['gw-lab', '1.0.0', 'q-alias', 'gateway.routing-aliases', 1, 'diagnostic'],
      ['gw-lab', '1.0.0', 'q-two', 'gateway.routing-aliases', 0, 'diagnostic'],
      ['gw-lab', '1.0.0', 'ob-1', 'gateway.routing-aliases', 1, 'onboarding'],
    ]);
    expect(typeof rows[0]!.created_at).toBe('number');
    // The table itself has no column that could identify anyone.
    const cols = (sqlite.prepare('PRAGMA table_info(learn_answers)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['id', 'lab_slug', 'lab_version', 'question_id', 'concept', 'correct', 'phase', 'created_at']);
  });

  it('lab_slug and lab_version are optional (onboarding), stored as NULL', async () => {
    const { env, sqlite } = makeEnv();
    expect((await post(env, { answers: [answer({ phase: 'onboarding' })] })).status).toBe(201);
    expect(sqlite.prepare('SELECT lab_slug, lab_version FROM learn_answers').get()).toEqual({ lab_slug: null, lab_version: null });
  });

  it('accepts 60 answers and refuses 61, an empty list and a missing list', async () => {
    const { env, sqlite } = makeEnv();
    expect((await post(env, { answers: Array.from({ length: 60 }, () => answer()) })).status).toBe(201);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM learn_answers').get()).toEqual({ n: 60 });
    for (const body of [{ answers: Array.from({ length: 61 }, () => answer()) }, { answers: [] }, {}]) {
      const res = await post(env, body);
      expect(res.status).toBe(400);
      expect((await j(res)).error.code).toBe('bad_answers');
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM learn_answers').get()).toEqual({ n: 60 });
  });

  it('refuses any identifying field: user_id, session_id or ip, at the top level or on an answer', async () => {
    const { env, sqlite } = makeEnv();
    for (const body of [
      { user_id: 'u1', answers: [answer()] },
      { session_id: 's1', answers: [answer()] },
      { ip: '1.2.3.4', answers: [answer()] },
      { answers: [answer({ user_id: 'u1' })] },
    ]) {
      const res = await post(env, body);
      expect(res.status).toBe(400);
      expect((await j(res)).error.code).toBe('bad_answers');
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM learn_answers').get()).toEqual({ n: 0 });
  });

  it('validates each field, and one bad answer stores none of the request', async () => {
    const { env, sqlite } = makeEnv();
    for (const bad of [
      answer({ phase: 'exam' }),
      answer({ correct: 'yes' }),
      answer({ concept: 'Not A Concept' }),
      answer({ question_id: 'Q 1' }),
      answer({ question_id: undefined }),
    ]) {
      expect((await post(env, { answers: [answer(), bad] })).status).toBe(400);
    }
    expect((await post(env, { lab_slug: 'Bad Slug', answers: [answer()] })).status).toBe(400);
    expect((await post(env, { lab_version: 'v1', answers: [answer()] })).status).toBe(400);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM learn_answers').get()).toEqual({ n: 0 });
  });

  it('a body that is not JSON is 400 bad_answers', async () => {
    const { env } = makeEnv();
    const res = await call(env, 'POST', '/learn/answers', { body: '{nope', headers: { ...SERVICE, 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
    expect((await j(res)).error.code).toBe('bad_answers');
  });

  it('needs the service key: none and a session token are 401, and nothing is written', async () => {
    const { env, sqlite } = makeEnv();
    const token = await mintSessionToken(env, { sid: 's1', uid: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 });
    for (const headers of [{}, { Authorization: `Bearer ${token}` }] as Array<Record<string, string>>) {
      expect((await post(env, { answers: [answer()] }, headers)).status).toBe(401);
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM learn_answers').get()).toEqual({ n: 0 });
  });
});

describe('GET /admin/learning', () => {
  async function seeded() {
    const made = makeEnv();
    const { env } = made;
    // gw-lab: q-alias 3 of 4 right, q-spend 1 of 2; other-lab: q-x 0 of 1; onboarding: ob-1 1 of 2.
    await post(env, { lab_slug: 'gw-lab', lab_version: '1.0.0', answers: [
      answer(), answer(), answer(), answer({ correct: false }),
      answer({ question_id: 'q-spend', concept: 'gateway.usage-and-spend' }), answer({ question_id: 'q-spend', concept: 'gateway.usage-and-spend', correct: false }),
    ] });
    await post(env, { lab_slug: 'other-lab', answers: [answer({ question_id: 'q-x', correct: false })] });
    await post(env, { answers: [answer({ question_id: 'ob-1', phase: 'onboarding' }), answer({ question_id: 'ob-1', phase: 'onboarding', correct: false })] });
    return made;
  }
  const get = (env: Env, qs = '', headers: Record<string, string> = SERVICE) => call(env, 'GET', `/admin/learning${qs}`, { headers });

  it('needs the service key; a session token is refused', async () => {
    const { env } = makeEnv();
    const token = await mintSessionToken(env, { sid: 's1', uid: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 });
    expect((await get(env, '', {})).status).toBe(401);
    expect((await get(env, '', { Authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it('reports attempts and percent_correct per (lab, question), weakest first, and totals per concept', async () => {
    const { env } = await seeded();
    const res = await get(env);
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.available).toBe(true);
    expect(body.questions).toEqual([
      { lab_slug: 'other-lab', question_id: 'q-x', concept: 'gateway.routing-aliases', attempts: 1, correct: 0, percent_correct: 0 },
      { lab_slug: null, question_id: 'ob-1', concept: 'gateway.routing-aliases', attempts: 2, correct: 1, percent_correct: 50 },
      { lab_slug: 'gw-lab', question_id: 'q-spend', concept: 'gateway.usage-and-spend', attempts: 2, correct: 1, percent_correct: 50 },
      { lab_slug: 'gw-lab', question_id: 'q-alias', concept: 'gateway.routing-aliases', attempts: 4, correct: 3, percent_correct: 75 },
    ]);
    expect(body.concepts).toEqual([
      { concept: 'gateway.routing-aliases', attempts: 7, correct: 4, percent_correct: 57.1 },
      { concept: 'gateway.usage-and-spend', attempts: 2, correct: 1, percent_correct: 50 },
    ]);
    // Aggregates only: no per-row, per-learner detail.
    expect(JSON.stringify(body)).not.toMatch(/user|session|ip"/);
  });

  it('narrows to one lab, and to a time window', async () => {
    const { env, sqlite } = await seeded();
    const one = await j(await get(env, '?lab=gw-lab'));
    expect(one.questions.map((q: { question_id: string }) => q.question_id)).toEqual(['q-spend', 'q-alias']);
    expect(one.concepts).toEqual([
      { concept: 'gateway.routing-aliases', attempts: 4, correct: 3, percent_correct: 75 },
      { concept: 'gateway.usage-and-spend', attempts: 2, correct: 1, percent_correct: 50 },
    ]);

    sqlite.exec(`UPDATE learn_answers SET created_at = 1000 WHERE lab_slug = 'other-lab'`);
    const windowed = await j(await get(env, '?from=2000'));
    expect(windowed.from).toBe(2000);
    expect(windowed.questions.some((q: { lab_slug: string }) => q.lab_slug === 'other-lab')).toBe(false);
    const early = await j(await get(env, '?to=2000'));
    expect(early.questions.map((q: { lab_slug: string }) => q.lab_slug)).toEqual(['other-lab']);
  });

  it('rejects a bad window, a bad lab and an inverted range with 400', async () => {
    const { env } = makeEnv();
    for (const qs of ['?from=nope', '?lab=Bad%20Lab', '?from=5000&to=1000']) {
      expect((await get(env, qs)).status).toBe(400);
    }
  });

  it('is empty, not an error, when nobody has answered; and available:false when the table is not migrated', async () => {
    const { env, sqlite } = makeEnv();
    expect(await j(await get(env))).toEqual({ available: true, questions: [], concepts: [] });
    sqlite.exec('DROP TABLE learn_answers');
    expect(await j(await get(env))).toEqual({ available: false, questions: [], concepts: [] });
  });
});
