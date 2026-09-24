import { Hono } from 'hono';
import type { Env } from './env';
import { isFamily } from './families/registry';
import { loadCurrentManifest, loadCatalogue, publishLab } from './labs/bundle';
import { parseManifest } from './labs/manifest';
import { requireServiceAuth, requireBrowserAuth } from './auth';
import { ApiError, fromSdkError } from './lib/errors';
import { insertSession } from './session/d1';
import { poolStub } from './do/pool';
import { newId } from './lib/ids';

export function createRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.onError((err, c) => {
    const apiErr = err instanceof ApiError ? err : fromSdkError(err);
    return apiErr.toResponse();
  });

  app.get('/health', (c) => c.json({ ok: true }));

  // --- Labs catalogue (service auth; the app backend proxies this to learners) ---

  app.get('/labs', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    return c.json(await loadCatalogue(c.env));
  });

  app.get('/labs/:slug', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
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
    // Lowering the target now destroys the surplus, so a bad number here
    // costs containers rather than just being ignored — reject it.
    if (body.target !== undefined && (!Number.isInteger(body.target) || body.target < 0)) {
      throw ApiError.badRequest('bad_target', 'target must be a non-negative integer');
    }
    await poolStub(c.env, family).prime(body.target);
    return c.json({ ok: true });
  });

  // Destroys every warm container right now without touching the target, so
  // the alarm loop refills afterwards. To shrink a pool for good, lower the
  // target via /prime (and POOL_TARGET_*, which the 5-minute cron re-applies).
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

    const { version, manifest } = await loadCurrentManifest(c.env, body.lab);
    if (!isFamily(manifest.family)) throw ApiError.internal(`lab "${body.lab}" has an unknown family "${manifest.family}"`);

    const sessionId = newId();
    // Reserve the one-active-session-per-user slot in D1 first; a unique-index
    // conflict here is the enforcement point, not a check-then-act race.
    await insertSession(c.env, {
      id: sessionId,
      user_id: body.user_id,
      lab_slug: manifest.slug,
      lab_version: version,
      family: manifest.family,
      state: 'starting',
      created_at: Date.now(),
      resumed_count: 0,
    }).catch((err) => {
      throw ApiError.conflict('active_session_exists', 'This user already has an active session', { cause: String(err) });
    });

    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(sessionId));
    const { meta, token } = await stub.create({ userId: body.user_id, labSlug: manifest.slug, labVersion: version, family: manifest.family, manifest });

    return c.json(
      {
        id: sessionId,
        state: meta.state,
        token,
        urls: {
          status: `${c.env.PUBLIC_BASE_URL}/sessions/${sessionId}`,
          terminal: `${c.env.PUBLIC_BASE_URL.replace(/^http/, 'ws')}/sessions/${sessionId}/terminal`,
          events: `${c.env.PUBLIC_BASE_URL}/sessions/${sessionId}/events`,
          services: Object.fromEntries(manifest.services.filter((s) => s.ui).map((s) => [s.name, `${c.env.PUBLIC_BASE_URL}/sessions/${sessionId}/services/${s.name}/`])),
        },
      },
      202
    );
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
    const result = await stub.readFile(`/workspace/${c.req.param('path')}`);
    return c.json(result);
  });

  app.put('/sessions/:id/files/:path{.+}', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const body = await c.req.text();
    if (body.length > 2 * 1024 * 1024) throw ApiError.payloadTooLarge('File exceeds 2 MiB write limit');
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    await stub.writeFile(`/workspace/${c.req.param('path')}`, body);
    return c.json({ ok: true });
  });

  app.get('/sessions/:id/files', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const path = c.req.query('path') ?? '/workspace';
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    return c.json(await stub.listFiles(path));
  });

  app.delete('/sessions/:id/files/:path{.+}', async (c) => {
    const id = c.req.param('id');
    await requireBrowserAuth(c.req.raw, c.env, id);
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName(id));
    await stub.deleteFile(`/workspace/${c.req.param('path')}`);
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
