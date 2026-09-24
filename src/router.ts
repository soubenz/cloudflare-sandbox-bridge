import { Hono } from 'hono';
import type { Env } from './env';
import { isFamily } from './families/registry';
import { loadCurrentManifest, loadCatalogue, publishLab } from './labs/bundle';
import { parseManifest } from './labs/manifest';
import { requireServiceAuth, requireBrowserAuth, mintSessionToken } from './auth';
import { ApiError, fromSdkError } from './lib/errors';
import { workspacePath } from './lib/paths';
import { insertSession } from './session/d1';
import { poolStub } from './do/pool';
import { newId } from './lib/ids';
import { corsMiddleware } from './cors';

export function createRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.use('*', corsMiddleware());

  app.onError((err, c) => {
    const apiErr = err instanceof ApiError ? err : fromSdkError(err);
    return apiErr.toResponse();
  });

  app.get('/health', (c) => c.json({ ok: true }));

  // --- Labs catalogue (service auth; the app backend proxies this to learners) ---

  app.get('/labs', async (c) => {
    requireServiceAuthUnlessOpen(c);
    return c.json(await loadCatalogue(c.env));
  });

  app.get('/labs/:slug', async (c) => {
    requireServiceAuthUnlessOpen(c);
    const { version, manifest } = await loadCurrentManifest(c.env, c.req.param('slug'));
    return c.json({ version, manifest });
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
    const result = await publishLab(c.env, {
      manifestJson,
      workspaceTgz: await workspaceFile.arrayBuffer(),
      privateTgz: await privateFile.arrayBuffer(),
    });
    return c.json(result, 201);
  });

  // --- Pool ops (service auth) ---

  app.get('/pools', async (c) => {
    requireServiceAuthUnlessOpen(c);
    const families = ['agent', 'gateway'] as const;
    const stats = await Promise.all(families.map((f) => poolStub(c.env, f).stats()));
    return c.json(Object.fromEntries(families.map((f, i) => [f, stats[i]])));
  });

  app.get('/pools/:family', async (c) => {
    requireServiceAuthUnlessOpen(c);
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

  // --- Sessions ---

  app.post('/sessions', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const body = await c.req.json<{ lab: string; user_id: string }>();
    if (!body.lab || !body.user_id) throw ApiError.badRequest('missing_fields', 'lab and user_id are required');
    return c.json(await createSession(c.env, body.lab, body.user_id), 202);
  });

  /**
   * Unauthenticated session start for the dashboard, which is a separate
   * Worker with no service key. Gated on DEV_OPEN_SESSIONS so it can be
   * closed from config alone.
   *
   * The user id is derived from the caller's IP, which makes the existing
   * D1 one-active-session-per-user index the rate limit: a given address
   * gets one live container and a 409 until it ends. That is the whole of
   * the protection here — it stops a loop from spawning containers, and
   * nothing stops someone with many addresses.
   */
  app.post('/dev/sessions', async (c) => {
    if (c.env.DEV_OPEN_SESSIONS !== '1') throw ApiError.notFound('not_found', 'Not found');
    const body = await c.req.json<{ lab?: string }>().catch(() => ({}) as { lab?: string });
    if (!body.lab) throw ApiError.badRequest('missing_fields', 'lab is required');
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
    const userId = `dev-${await shortHash(ip)}`;

    // Rejoining beats a 409. One address gets one container, so a reload, a
    // second tab, or anyone else behind the same NAT would otherwise hit a
    // wall they cannot clear. Handing back the session they already have is
    // both what someone reloading expects and what keeps the fence usable.
    const existing = await activeSessionFor(c.env, userId);
    if (existing) return c.json(await rejoinSession(c.env, existing), 200);

    return c.json(await createSession(c.env, body.lab, userId), 202);
  });

  app.get('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    return c.json(await stub.status());
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

  return app;
}

/** Shared by POST /sessions and the dev endpoint; the only difference between them is who may call. */
async function createSession(env: Env, lab: string, userId: string) {
  const { version, manifest } = await loadCurrentManifest(env, lab);
  if (!isFamily(manifest.family)) throw ApiError.internal(`lab "${lab}" has an unknown family "${manifest.family}"`);

  const sessionId = newId();
  // Reserve the one-active-session-per-user slot in D1 first; a unique-index
  // conflict here is the enforcement point, not a check-then-act race.
  await insertSession(env, {
    id: sessionId,
    user_id: userId,
    lab_slug: manifest.slug,
    lab_version: version,
    family: manifest.family,
    state: 'starting',
    created_at: Date.now(),
    resumed_count: 0,
  }).catch((err) => {
    throw ApiError.conflict('active_session_exists', 'This user already has an active session', { cause: String(err) });
  });

  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  const { meta, token } = await stub.create({ userId, labSlug: manifest.slug, labVersion: version, family: manifest.family, manifest });

  return {
    id: sessionId,
    state: meta.state,
    token,
    urls: sessionUrls(env, sessionId, manifest.services.filter((s) => s.ui).map((s) => s.name)),
  };
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

/** Read-only routes the dashboard needs. Still service-key-only unless the dev switch is on. */
function requireServiceAuthUnlessOpen(c: { req: { raw: Request }; env: Env }): void {
  if (c.env.DEV_OPEN_SESSIONS === '1') return;
  requireServiceAuth(c.req.raw, c.env);
}

/** A short, stable, non-reversible label for an IP — used only as a D1 key, never shown. */
async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
