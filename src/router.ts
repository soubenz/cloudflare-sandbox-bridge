import { Hono, type MiddlewareHandler } from 'hono';
import type { Env } from './env';
import { isFamily } from './families/registry';
import { loadCurrentManifest, loadCurrentLearn, listCatalogue, publishLab, solutionKey, audioKey, currentVersion, CLIP_FILE, INDEX_KEY } from './labs/bundle';
import { parseAnswersBody, recordAnswers } from './labs/learn-answers';
import { loadOnboarding } from './labs/onboarding';
import { MAX_AUDIO_CLIPS, MAX_AUDIO_CLIP_BYTES } from './labs/learn';
import { parseByteRange } from './lib/range';
import { parseManifest } from './labs/manifest';
import { requireServiceAuth, requireBrowserAuth, mintSessionToken, previousKeyHeader } from './auth';
import { ApiError, fromSdkError } from './lib/errors';
import { workspacePath } from './lib/paths';
import { insertSession, upsertFeedback, healSessionRow, isActiveSessionConflict } from './session/d1';
import { healIfStale, healUserActiveRows } from './session/reconcile';
import { userProgress, sessionProgressSummary, sessionChecks, userChecks, parseFeedback, clampLimit } from './session/progress';
import { poolStub } from './do/pool';
import { newId } from './lib/ids';
import { corsMiddleware } from './cors';
import { queryUsage, resolveWindow } from './session/usage';
import { readSolutionFiles } from './session/solution';
import { TarError } from './lib/tar';
import { mountAdmin } from './admin';
import { loadProfile } from './profile/store';
import { compactProfile } from './profile/compute';
import { parseUserId, parseStartingLevels } from './profile/request';
import { parsePathInputs } from './path/inputs';
import { ensurePath, saveInputsAndRecompute, type PathResult } from './path/service';

export function createRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Registered first, so it wraps corsMiddleware: it answers the preflight
  // for these routes itself and adds `Access-Control-Allow-Credentials` to
  // the response corsMiddleware has already given an origin.
  app.use('/sessions/:id/services/:name/*', credentialedCors());
  app.use('*', corsMiddleware());
  app.use('*', previousKeyHeader());

  app.onError((err, c) => {
    const apiErr = err instanceof ApiError ? err : fromSdkError(err);
    const response = apiErr.toResponse();
    if (apiErr.code === 'at_capacity') {
      const retryAfter = (apiErr.details as { retry_after_s?: number } | undefined)?.retry_after_s ?? 30;
      response.headers.set('Retry-After', String(retryAfter));
    }
    return response;
  });

  // Plain GET /health is public liveness. `?deep=1` exercises D1, R2 and the
  // pools, which is what an external probe wants; it costs real reads and
  // reveals pool state, so it takes the service key.
  app.get('/health', async (c) => {
    if (c.req.query('deep') !== '1') return c.json({ ok: true });
    requireServiceAuth(c.req.raw, c.env);
    const { body, status } = await deepHealth(c.env);
    return c.json(body, status);
  });

  // --- Labs catalogue (service auth; the app backend proxies this to learners) ---

  app.get('/labs', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const q = c.req.query();
    const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
    const { labs, next } = await listCatalogue(c.env, {
      path: q.path || undefined,
      module: num(q.module),
      tier: q.tier === 'free' || q.tier === 'pro' ? q.tier : undefined,
      limit: num(q.limit),
      cursor: q.cursor || undefined,
    });
    // Unpaged callers (the console, the CLI) get the bare array they always
    // did; `next` is only added when there is another page.
    return next ? c.json({ labs, next }) : c.json(labs);
  });

  app.get('/labs/:slug', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const { version, manifest } = await loadCurrentManifest(c.env, c.req.param('slug'));
    return c.json({ version, manifest });
  });

  // The lab's learning layer (story, lessons, quiz, graded fields). Service
  // key like GET /labs/:slug: the console Worker reads it for a learner. It
  // is only what `labs publish` compiled from learn/, never anything from
  // checks/ or solution/. 404 `no_learn` when the lab ships none.
  app.get('/labs/:slug/learn', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const slug = c.req.param('slug');
    const found = await loadCurrentLearn(c.env, slug);
    if (!found) throw ApiError.notFound('no_learn', `Lab "${slug}" has no learning content`);
    // The slug rides along so the console can build the narration URLs (/api/audio/<slug>/<file>)
    // from the bundle alone.
    return c.json({ slug, ...found });
  });

  // One narration clip of the lab's comic, an mp3 uploaded by `labs publish` against
  // the bundle's audio index. Service key like the learn route (the console Worker proxies
  // it for a signed-in learner); the file name is a content hash, so it is cached for a year.
  // Range requests are answered so the player can seek.
  app.get('/labs/:slug/audio/:file', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const slug = c.req.param('slug');
    const file = c.req.param('file');
    if (!CLIP_FILE.test(file)) throw ApiError.notFound('no_audio', 'No such audio clip');
    const key = audioKey(slug, await currentVersion(c.env, slug), file);
    const head = await c.env.LABS_BUCKET.head(key);
    if (!head) throw ApiError.notFound('no_audio', 'No such audio clip');
    const headers: Record<string, string> = {
      'content-type': 'audio/mpeg',
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=31536000, immutable',
    };
    const size = head.size;
    const range = parseByteRange(c.req.header('range'), size);
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
    if (range) {
      const part = await c.env.LABS_BUCKET.get(key, { range: { offset: range.start, length: range.end - range.start + 1 } });
      if (!part) throw ApiError.notFound('no_audio', 'No such audio clip');
      return new Response(part.body, {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': String(range.end - range.start + 1) },
      });
    }
    const whole = await c.env.LABS_BUCKET.get(key);
    if (!whole) throw ApiError.notFound('no_audio', 'No such audio clip');
    return new Response(whole.body, { status: 200, headers: { ...headers, 'content-length': String(size) } });
  });

  app.post('/labs/publish', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const form = await c.req.raw.formData();
    const manifestFile = form.get('manifest');
    const workspaceFile = form.get('workspace');
    const privateFile = form.get('private');
    if (!(manifestFile instanceof File) || !(workspaceFile instanceof File) || !(privateFile instanceof File)) {
      throw ApiError.badRequest('bad_publish_payload', 'multipart form must include manifest, workspace, private files');
    }
    const manifestJson = JSON.parse(await manifestFile.text());
    // Optional: a lab with no solution/ sends no part (an empty one counts as none).
    const solutionFile = form.get('solution');
    const solutionTgz = solutionFile instanceof File && solutionFile.size > 0 ? await solutionFile.arrayBuffer() : undefined;
    // Optional: the compiled learn/ folder as JSON. publishLab validates it
    // (the CLI is not trusted); an empty part counts as none.
    const learnFile = form.get('learn');
    let learnJson: unknown;
    if (learnFile instanceof File && learnFile.size > 0) {
      try {
        learnJson = JSON.parse(await learnFile.text());
      } catch {
        throw ApiError.badRequest('invalid_learn_bundle', 'the learn part is not valid JSON');
      }
    }
    // Optional: the narration clips (`audio` parts, one mp3 each, named <16 hex>.mp3) the learn
    // bundle's audio index names. publishLab checks the set against the index.
    const audioClips: { name: string; bytes: ArrayBuffer }[] = [];
    for (const part of form.getAll('audio')) {
      if (!(part instanceof File)) throw ApiError.badRequest('invalid_audio', 'an audio part is not a file');
      if (part.type !== 'audio/mpeg') throw ApiError.badRequest('invalid_audio', `audio file ${part.name.slice(0, 40)} is ${part.type || 'untyped'}, not audio/mpeg`);
      if (part.size > MAX_AUDIO_CLIP_BYTES) throw ApiError.badRequest('invalid_audio', `audio file ${part.name.slice(0, 40)} is ${part.size} bytes; the limit is ${MAX_AUDIO_CLIP_BYTES}`);
      if (audioClips.length >= MAX_AUDIO_CLIPS) throw ApiError.badRequest('invalid_audio', `a lab may carry at most ${MAX_AUDIO_CLIPS} audio clips`);
      audioClips.push({ name: part.name, bytes: await part.arrayBuffer() });
    }
    const result = await publishLab(c.env, {
      manifestJson,
      workspaceTgz: await workspaceFile.arrayBuffer(),
      privateTgz: await privateFile.arrayBuffer(),
      ...(solutionTgz ? { solutionTgz } : {}),
      ...(learnJson !== undefined ? { learnJson } : {}),
      ...(audioClips.length > 0 ? { audioClips } : {}),
      force: form.get('force') === 'true',
    });
    return c.json(result, 201);
  });

  // --- Learning layer (service auth; the console Worker calls these for learners) ---

  // The one-time platform onboarding quiz (packages/catalogue/onboarding.json).
  app.get('/learn/onboarding', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const onboarding = await loadOnboarding();
    if (!onboarding) throw ApiError.notFound('no_onboarding', 'No onboarding quiz is published');
    return c.json(onboarding);
  });

  // Anonymous quiz-answer analytics: no user id, no session id, no IP.
  app.post('/learn/answers', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const body = parseAnswersBody(await c.req.json().catch(() => undefined));
    return c.json({ ok: true, recorded: await recordAnswers(c.env, body) }, 201);
  });

  // --- Pool ops (service auth) ---

  app.get('/pools', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const families = ['agent', 'gateway'] as const;
    const stats = await Promise.all(families.map((f) => poolStub(c.env, f).stats()));
    return c.json(Object.fromEntries(families.map((f, i) => [f, stats[i]])));
  });

  app.get('/pools/:family', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const family = c.req.param('family');
    if (!isFamily(family)) throw ApiError.notFound('unknown_family', `No family "${family}"`);
    return c.json(await poolStub(c.env, family).stats());
  });

  app.post('/pools/:family/prime', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const family = c.req.param('family');
    if (!isFamily(family)) throw ApiError.notFound('unknown_family', `No family "${family}"`);
    const body = await c.req.json<{ target?: number }>().catch(() => ({}) as { target?: number });
    await poolStub(c.env, family).prime(body.target);
    return c.json({ ok: true });
  });

  // prime() only ever grows the pool — its alarm acts when target - warm
  // is positive — so lowering the target strands the surplus, and a warm
  // standard-1 container left running is real money.
  app.post('/pools/:family/drain', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const family = c.req.param('family');
    if (!isFamily(family)) throw ApiError.notFound('unknown_family', `No family "${family}"`);
    await poolStub(c.env, family).drain();
    return c.json({ ok: true });
  });

  // --- Usage / spend estimate (service auth) ---

  app.get('/usage', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const window = resolveWindow(c.req.query('from'), c.req.query('to'), Date.now());
    return c.json(await queryUsage(c.env, window));
  });

  // --- Sessions ---

  app.post('/sessions', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const body = await c.req.json<{ lab: string; user_id: string }>();
    if (!body.lab || !body.user_id) throw ApiError.badRequest('missing_fields', 'lab and user_id are required');
    return c.json(await createSession(c.env, body.lab, body.user_id), 202);
  });

  /**
   * Rejoin-or-create, for interactive clients.
   *
   * `POST /sessions` is a strict create: a second live session for the same
   * user is a 409, which is what the CLI and the integration suite want.
   * A console does not: a reload, a second tab or a restored browser should
   * land back in the session it already has rather than on a wall it cannot
   * clear. Same service key, same `user_id`; the only difference is whether
   * a conflict is an error or a rejoin.
   *
   * This replaces the old `POST /dev/sessions`, which was unauthenticated
   * and guessed an identity from the caller's address or a self-issued id.
   * The caller is now the dashboard Worker, which knows who its user is.
   */
  app.post('/sessions/start', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    type StartBody = { lab?: string; user_id?: string };
    const body = await c.req.json<StartBody>().catch((): StartBody => ({}));
    if (!body.lab || !body.user_id) throw ApiError.badRequest('missing_fields', 'lab and user_id are required');

    // A row whose DO has ended (or never existed) is not a session to rejoin:
    // close it and start fresh rather than mint a token for nothing.
    const existing = await activeSessionFor(c.env, body.user_id);
    if (existing && (await healIfStale(c.env, existing.id)) === 'live') return c.json(await rejoinSession(c.env, existing), 200);

    return c.json(await createSession(c.env, body.lab, body.user_id), 202);
  });

  app.get('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    return c.json(await stub.status());
  });

  /**
   * The lab's solution, as files to diff against the learner's own work.
   * Session token only: the service key is refused, like the cookie route
   * below, so the reveal is only ever the learner's own view. The unlock
   * decision is the DO's (`status().solution`), so this route and the status
   * block can never disagree.
   */
  app.get('/sessions/:id/solution', async (c) => {
    const id = c.req.param('id');
    const auth = await requireBrowserAuth(c.req.raw, c.env, id);
    if (auth.kind !== 'session') {
      throw new ApiError(403, 'session_token_required', 'The solution is shown to the learner and needs a session token, not the service key');
    }
    const status = await c.env.SESSION.get(c.env.SESSION.idFromName(id)).status();
    const noSolution = () => ApiError.notFound('no_solution', 'This lab has no solution to show');
    if (!status.solution.available) throw noSolution();
    const { rule, progress } = status.solution;
    if (!status.solution.unlocked) {
      throw new ApiError(403, 'solution_locked', 'The solution is still locked for this session', { rule, progress });
    }
    const obj = await c.env.LABS_BUCKET.get(solutionKey(status.meta.lab_slug, status.meta.lab_version));
    if (!obj) throw noSolution();
    try {
      return c.json(await readSolutionFiles(obj.body));
    } catch (err) {
      if (err instanceof TarError) throw new ApiError(500, 'solution_unreadable', `The stored solution could not be read: ${err.message}`);
      throw err;
    }
  });

  app.get('/sessions/:id/files/:path{.+}', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    const result = await stub.readFile(workspacePath(c.req.param('path')));
    return c.json(result);
  });

  app.put('/sessions/:id/files/:path{.+}', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const body = await c.req.text();
    if (body.length > 2 * 1024 * 1024) throw ApiError.payloadTooLarge('File exceeds 2 MiB write limit');
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    await stub.writeFile(workspacePath(c.req.param('path')), body);
    return c.json({ ok: true });
  });

  app.get('/sessions/:id/files', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    // The query value went straight to listFiles, so listing outside the
    // workspace needed no encoding trick at all.
    const path = workspacePath(c.req.query('path') ?? '/workspace');
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    return c.json(await stub.listFiles(path));
  });

  app.delete('/sessions/:id/files/:path{.+}', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    await stub.deleteFile(workspacePath(c.req.param('path')));
    return c.json({ ok: true });
  });

  app.post('/sessions/:id/checks', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const body = await c.req.json<{ only?: string[] }>().catch(() => ({}) as { only?: string[] });
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    return c.json(await stub.runChecks(body.only));
  });

  // The last N runs of this session, from D1 (the DO keeps only the last run
  // and a compact history), newest first.
  app.get('/sessions/:id/checks', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    return c.json(await sessionChecks(c.env, id, clampLimit(c.req.query('limit'))));
  });

  // This user's standing on this session's lab: attempts, best score, and how
  // many of the attempts were made in this session.
  app.get('/sessions/:id/progress-summary', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const { meta } = await c.env.SESSION.get(c.env.SESSION.idFromName(id)).status();
    return c.json(await sessionProgressSummary(c.env, id, meta.user_id, meta.lab_slug));
  });

  app.post('/sessions/:id/feedback', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    // Validate before touching the DO: a bad body costs nothing.
    const { rating, text } = parseFeedback(await c.req.json().catch(() => undefined));
    const { meta } = await c.env.SESSION.get(c.env.SESSION.idFromName(id)).status();
    await upsertFeedback(c.env, { session_id: id, user_id: meta.user_id, lab_slug: meta.lab_slug, rating, text });
    return c.json({ ok: true }, 201);
  });

  app.post('/sessions/:id/events', async (c) => {
    requireServiceAuth(c.req.raw, c.env); // the LLM Worker, not a browser
    const id = c.req.param('id');
    const body = await c.req.json<{ type: string; data: unknown }>();
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    await stub.pushEvent(body.type, body.data);
    return c.json({ ok: true });
  });

  app.post('/sessions/:id/services/:name/restart', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    return c.json(await stub.restartService(c.req.param('name')));
  });

  // Sets the service-proxy cookie from a credentialed fetch, so the console
  // can point an iframe and an "open in new tab" link at a URL with no token
  // in it. Registered before the `/services/:name/*` proxy route below, which
  // would otherwise take it. A service key is refused: the cookie would carry
  // it, and the cookie is only ever meant to hold a session token.
  app.post('/sessions/:id/services/:name/session', async (c) => {
    const id = c.req.param('id');
    const auth = await requireBrowserAuth(c.req.raw, c.env, id);
    if (auth.kind !== 'session') {
      throw new ApiError(403, 'session_token_required', 'This route sets a session cookie and needs a session token, not the service key');
    }
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    return stub.fetch(c.req.raw);
  });

  app.post('/sessions/:id/snapshot', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    return c.json(await stub.snapshot());
  });

  app.post('/sessions/:id/resume', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    return c.json(await stub.resume());
  });

  // "I'm here" from the idle banner: moves the idle clock like a file write
  // does, and nothing else. 204 so there is no body to parse.
  app.post('/sessions/:id/touch', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    await stub.touch();
    return c.body(null, 204);
  });

  app.delete('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const snapshot = c.req.query('snapshot') !== '0';
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    await stub.end(snapshot);
    return c.json({ ok: true });
  });

  // --- Routes that must reach the DO's fetch() directly: terminal WS, events SSE, service proxy ---

  app.all('/sessions/:id/terminal', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    return stub.fetch(c.req.raw);
  });

  app.get('/sessions/:id/events', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    return stub.fetch(c.req.raw);
  });

  app.all('/sessions/:id/services/:name/*', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    return stub.fetch(c.req.raw);
  });

  // Every live session, for operations: ending a stray container needs a
  // way to find it, and the pool only reports counts.
  app.get('/sessions', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const result = await c.env.DB.prepare(
      `SELECT id, user_id, lab_slug, state, created_at FROM sessions
       WHERE state IN ('starting','running','recovering','resuming')
       ORDER BY created_at DESC LIMIT 200`
    ).all();
    return c.json(result.results);
  });

  app.get('/users/:uid/sessions', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const activeOnly = c.req.query('active') === '1';
    const query = activeOnly
      ? `SELECT * FROM sessions WHERE user_id = ? AND state IN ('starting','running','recovering','resuming') ORDER BY created_at DESC`
      : `SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`;
    const result = await c.env.DB.prepare(query).bind(c.req.param('uid')).all();
    return c.json(result.results);
  });

  // --- Progress and check history (service auth; the app backend proxies these to learners) ---

  app.get('/users/:uid/progress', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    return c.json(await userProgress(c.env, c.req.param('uid')));
  });

  app.get('/users/:uid/checks', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const q = c.req.query();
    const before = q.before === undefined || q.before === '' ? undefined : Number(q.before);
    if (before !== undefined && !Number.isFinite(before)) throw ApiError.badRequest('bad_cursor', '`before` must be an epoch-ms number');
    return c.json(await userChecks(c.env, c.req.param('uid'), { lab: q.lab || undefined, limit: clampLimit(q.limit), before }));
  });

  // --- Profile: skill scores, XP and awards (service auth; the app backend proxies these to learners) ---

  // Everything the profile page shows; `?compact=1` is the slice the Home widget needs.
  // `?starting=gateway:ok,mcp:new` echoes the browser-held onboarding result as each skill's `starting_level`.
  app.get('/users/:uid/profile', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const uid = parseUserId(c.req.param('uid'));
    const profile = await loadProfile(c.env, uid, { starting: parseStartingLevels(c.req.query('starting')) });
    return c.json(c.req.query('compact') === '1' ? compactProfile(profile) : profile);
  });

  app.get('/users/:uid/awards', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const uid = parseUserId(c.req.param('uid'));
    const { awards } = await loadProfile(c.env, uid);
    return c.json({ user_id: uid, earned: awards.earned, locked: awards.locked });
  });

  // --- Personal learning path (service auth; the console Worker calls these for learners) ---
  // The rules choose the labs, a model may order them, the server validates the order; see docs/api.md.

  const pathResponse = (c: { json: (body: unknown) => Response }, { path, cache }: PathResult) => {
    const res = c.json(path);
    res.headers.set('x-path-cache', cache);
    return res;
  };

  // The quiz outcome, goal and hours. Replaces what was stored and recomputes the path (a cache hit when nothing changed).
  app.put('/users/:uid/path-inputs', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const inputs = parsePathInputs(await c.req.json().catch(() => undefined));
    return pathResponse(c, await saveInputsAndRecompute(c.env, pathUserId(c.req.param('uid')), inputs));
  });

  app.post('/users/:uid/path', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    return pathResponse(c, await ensurePath(c.env, pathUserId(c.req.param('uid')), { force: c.req.query('force') === '1' }));
  });

  app.get('/users/:uid/path', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    return pathResponse(c, await ensurePath(c.env, pathUserId(c.req.param('uid'))));
  });

  // The admin panel's routes (service key only), kept in their own module.
  mountAdmin(app);

  return app;
}

/** A user id from the path of a learning-path route: non-empty and short enough to be one. */
function pathUserId(uid: string): string {
  if (uid.length === 0 || uid.length > 128) throw ApiError.badRequest('invalid_user_id', 'user id must be 1-128 characters');
  return uid;
}

type CheckResult = 'ok' | string;

/** Runs one health check, reporting `ok` or the error message rather than throwing. */
async function check(fn: () => Promise<unknown>): Promise<CheckResult> {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return `fail: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Body and status for GET /health?deep=1: D1, R2 and both pools. Any failing check makes it a 503 that names the check. */
async function deepHealth(env: Env) {
  const poolFamilies = ['agent', 'gateway'] as const;
  const pools: Record<string, { degraded: boolean; warm: number } | { error: string }> = {};
  const [d1, r2] = await Promise.all([
    check(() => env.DB.prepare('SELECT 1').first()),
    check(async () => {
      // head() resolves null for a missing key rather than throwing.
      if (!(await env.LABS_BUCKET.head(INDEX_KEY))) throw new Error(`${INDEX_KEY} not found`);
    }),
    ...poolFamilies.map(async (f) => {
      try {
        const s = await poolStub(env, f).stats();
        pools[f] = { degraded: s.stats.degraded, warm: s.warm };
      } catch (err) {
        pools[f] = { error: err instanceof Error ? err.message : String(err) };
      }
    }),
  ]);
  const failing = [
    ...(d1 === 'ok' ? [] : ['d1']),
    ...(r2 === 'ok' ? [] : ['r2']),
    ...poolFamilies.flatMap((f) => {
      const p = pools[f]!;
      return 'error' in p ? [`pools.${f}`] : p.degraded ? [`pools.${f} (degraded)`] : [];
    }),
  ];
  const ok = failing.length === 0;
  return {
    status: ok ? (200 as const) : (503 as const),
    body: { ok, ...(ok ? {} : { failing }), checks: { d1, r2, pools } },
  };
}

/** Shared by POST /sessions and POST /sessions/start; the only difference between them is who may call. */
async function createSession(env: Env, lab: string, userId: string, ipHash?: string) {
  const { version, manifest } = await loadCurrentManifest(env, lab);
  if (!isFamily(manifest.family)) throw ApiError.internal(`lab "${lab}" has an unknown family "${manifest.family}"`);

  // Refuse before reserving anything in D1: a session the pool cannot give a
  // container to would otherwise hold the user's one slot while it fails.
  await poolStub(env, manifest.family)
    .admit()
    .catch((err) => {
      throw fromSdkError(err);
    });

  const sessionId = newId();
  const row = {
    id: sessionId,
    user_id: userId,
    lab_slug: manifest.slug,
    lab_version: version,
    family: manifest.family,
    state: 'starting' as const,
    created_at: Date.now(),
    resumed_count: 0,
    ip_hash: ipHash,
  };
  await reserveSessionSlot(env, row);

  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  let created: Awaited<ReturnType<typeof stub.create>>;
  try {
    created = await stub.create({ userId, labSlug: manifest.slug, labVersion: version, family: manifest.family, manifest });
  } catch (err) {
    // The row was reserved but no session exists: leaving it `starting` would
    // lock the user out until the sweeper found it.
    await healSessionRow(env, sessionId, {}).catch((healErr) => console.error('could not close the row of a session that failed to create:', healErr));
    throw err;
  }
  const { meta, token } = created;

  return {
    id: sessionId,
    state: meta.state,
    token,
    urls: sessionUrls(env, sessionId, manifest.services.filter((s) => s.ui).map((s) => s.name)),
  };
}

/**
 * Reserves the user's one-active-session slot in D1; the unique index is the
 * enforcement point, not a check-then-act race. Only that index's violation
 * is a 409. If the row that holds the slot is stale (its DO ended or never
 * existed) it is closed and the insert retried once; any other D1 failure is
 * a 500, not a misleading "already has a session".
 */
async function reserveSessionSlot(env: Env, row: Parameters<typeof insertSession>[1]): Promise<void> {
  const conflict = (err: unknown) => ApiError.conflict('active_session_exists', 'This user already has an active session', { cause: String(err) });
  try {
    await insertSession(env, row);
    return;
  } catch (err) {
    if (!isActiveSessionConflict(err)) throw ApiError.internal('Could not reserve the session slot', { cause: String(err) });
    if (!(await healUserActiveRows(env, row.user_id))) throw conflict(err);
  }
  try {
    await insertSession(env, row);
  } catch (err) {
    throw isActiveSessionConflict(err) ? conflict(err) : ApiError.internal('Could not reserve the session slot', { cause: String(err) });
  }
}

/** The one live session this user already has, if any. */
async function activeSessionFor(env: Env, userId: string): Promise<{ id: string; lab_slug: string; lab_version: string } | null> {
  const row = await env.DB.prepare(
    `SELECT id, lab_slug, lab_version FROM sessions
     WHERE user_id = ? AND state IN ('starting','running','recovering','resuming')
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(userId)
    .first<{ id: string; lab_slug: string; lab_version: string }>();
  return row ?? null;
}

/** Same response shape as a fresh start, with a newly minted token for the session already running. */
async function rejoinSession(env: Env, row: { id: string; lab_slug: string; lab_version: string }) {
  const stub = env.SESSION.get(env.SESSION.idFromName(row.id));
  const status = await stub.status();
  const token = await mintSessionToken(env, {
    sid: row.id,
    uid: status.meta.user_id,
    exp: Math.floor(((status.meta.expires_at ?? Date.now() + 60 * 60_000) + 10 * 60_000) / 1000),
  });
  return {
    id: row.id,
    state: status.meta.state,
    token,
    rejoined: true,
    urls: sessionUrls(env, row.id, Object.entries(status.services).filter(([, s]) => s.spec.ui).map(([name]) => name)),
  };
}

function sessionUrls(env: Env, sessionId: string, uiServices: string[]) {
  return {
    status: `${env.PUBLIC_BASE_URL}/sessions/${sessionId}`,
    terminal: `${env.PUBLIC_BASE_URL.replace(/^http/, 'ws')}/sessions/${sessionId}/terminal`,
    events: `${env.PUBLIC_BASE_URL}/sessions/${sessionId}/events`,
    services: Object.fromEntries(uiServices.map((name) => [name, `${env.PUBLIC_BASE_URL}/sessions/${sessionId}/services/${name}/`])),
  };
}

/**
 * CORS for the routes the console calls with `credentials: 'include'` — the
 * cookie mint and the service proxy. A credentialed response is only
 * readable by the page if it names the caller's origin (never `*`) and sets
 * `Access-Control-Allow-Credentials: true`; corsMiddleware echoes the
 * matched origin but does not set the second header, and it answers
 * preflights before any route runs, so both are added here. The origin
 * list is the same `DASHBOARD_ORIGIN` var, so an origin that is not allowed
 * gets no CORS headers at all, as before.
 */
function credentialedCors(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const origin = c.req.header('Origin');
    const list = (c.env.DASHBOARD_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
    const allowed = origin && list.includes(origin) ? origin : undefined;

    if (allowed && c.req.method === 'OPTIONS' && c.req.header('Access-Control-Request-Method')) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowed,
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': c.req.header('Access-Control-Request-Headers') ?? 'Authorization,Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    }

    await next();
    // A WebSocket upgrade's 101 cannot be copied into a new Response.
    if (!allowed || c.req.header('Upgrade')?.toLowerCase() === 'websocket') return;
    const headers = new Headers(c.res.headers);
    headers.set('Access-Control-Allow-Origin', allowed);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.append('Vary', 'Origin');
    c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
  };
}
