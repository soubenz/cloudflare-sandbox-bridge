import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../src/env';
import { ApiError, fromSdkError } from '../../src/lib/errors';
import { currentKey, previousKey, manifestKey, INDEX_KEY, loadCurrentManifest, type LabIndexEntry } from '../../src/labs/bundle';

// rebuildIndex is spied on and calls through by default, so the index really
// is rebuilt from the fake bucket unless a test says otherwise.
const spy = vi.hoisted(() => ({ rebuildIndex: vi.fn() }));
vi.mock('../../src/labs/bundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/labs/bundle')>();
  spy.rebuildIndex.mockImplementation(actual.rebuildIndex);
  return { ...actual, rebuildIndex: spy.rebuildIndex };
});

const { mountAdmin } = await import('../../src/admin');

/** In-memory R2 with the surface bundle.ts and admin.ts use; list() truncates at `pageSize` and hands back a cursor. */
function fakeBucket(pageSize = 1000) {
  const store = new Map<string, string>();
  const uploaded = new Map<string, Date>();
  const puts: string[] = [];
  const bucket = {
    async get(key: string) {
      const v = store.get(key);
      return v === undefined ? null : { text: async () => v, json: async () => JSON.parse(v) };
    },
    async head(key: string) {
      return store.has(key) ? { key } : null;
    },
    async put(key: string, value: unknown) {
      puts.push(key);
      store.set(key, String(value));
      uploaded.set(key, new Date(Date.UTC(2026, 8, 1, 0, 0, puts.length)));
    },
    async list(opts: { prefix?: string; cursor?: string } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const slice = keys.slice(start, start + pageSize);
      const truncated = start + pageSize < keys.length;
      return {
        objects: slice.map((key) => ({ key, uploaded: uploaded.get(key) })),
        truncated,
        ...(truncated ? { cursor: String(start + pageSize) } : {}),
      };
    },
  };
  return { bucket: bucket as unknown as Env['LABS_BUCKET'], store, puts };
}

const manifest = (slug: string, version: string, extra: Record<string, unknown> = {}) => ({
  slug, version, title: `${slug} v${version}`, type: 'build', family: 'agent', timeout_minutes: 60,
  services: [{ name: 'api', argv: ['python3', 'app.py'], port: 8000, ui: true }],
  checks: [{ name: 'c1', script: 'c1.sh' }],
  ...extra,
});

function publish(store: Map<string, string>, slug: string, versions: string[], current: string, previous?: string, extra: Record<string, unknown> = {}) {
  for (const v of versions) store.set(manifestKey(slug, v), JSON.stringify(manifest(slug, v, extra)));
  store.set(currentKey(slug), current);
  if (previous) store.set(previousKey(slug), previous);
}

const KEY = { Authorization: 'Bearer svc-key' };

function setup(pageSize?: number) {
  const r2 = fakeBucket(pageSize);
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err) => (err instanceof ApiError ? err : fromSdkError(err)).toResponse());
  mountAdmin(app);
  const env = { SANDBOX_API_KEY: 'svc-key', LABS_BUCKET: r2.bucket } as unknown as Env;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = KEY) => {
    const res = await app.fetch(
      new Request(`https://api.test${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }),
      env
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  return { ...r2, env, call };
}

beforeEach(() => {
  spy.rebuildIndex.mockClear();
});

describe('GET /labs/:slug/versions', () => {
  it('lists every published version, newest first, marking current and previous', async () => {
    const { store, call } = setup();
    publish(store, 'lab-a', ['1.0.0', '1.1.0', '2.0.0', '1.10.0'], '1.1.0', '1.0.0', { estimated_minutes: 45 });
    // A neighbour whose slug shares a prefix must not leak in.
    publish(store, 'lab-a-extra', ['9.9.9'], '9.9.9');

    const { status, body } = await call('GET', '/labs/lab-a/versions');
    expect(status).toBe(200);
    expect(body.slug).toBe('lab-a');
    expect(body.current).toBe('1.1.0');
    expect(body.previous).toBe('1.0.0');
    expect(body.versions.map((v: { version: string }) => v.version)).toEqual(['2.0.0', '1.10.0', '1.1.0', '1.0.0']);
    expect(body.versions.find((v: { version: string }) => v.version === '1.1.0')).toMatchObject({
      current: true, previous: false, title: 'lab-a v1.1.0', manifest_version: '1.1.0', estimated_minutes: 45,
    });
    expect(body.versions.find((v: { version: string }) => v.version === '1.0.0')).toMatchObject({ current: false, previous: true });
    expect(body.versions.filter((v: { current: boolean }) => v.current)).toHaveLength(1);
    // Being newer than current does not make a version current.
    expect(body.versions[0]).toMatchObject({ version: '2.0.0', current: false, previous: false });
  });

  it('reports publish time from the manifest object (null when R2 gives none), and null estimated_minutes when the manifest has none', async () => {
    const { store, bucket, call } = setup();
    publish(store, 'lab-a', ['1.0.0', '1.1.0'], '1.1.0');
    // Only an object written through put() carries an upload time, as in R2.
    await bucket.put(manifestKey('lab-a', '1.0.0'), JSON.stringify(manifest('lab-a', '1.0.0')));
    const { body } = await call('GET', '/labs/lab-a/versions');
    expect(body.versions.find((v: { version: string }) => v.version === '1.0.0').estimated_minutes).toBeNull();
    expect(body.versions.find((v: { version: string }) => v.version === '1.0.0').published_at).toBe(Date.UTC(2026, 8, 1, 0, 0, 1));
    expect(body.versions.find((v: { version: string }) => v.version === '1.1.0').published_at).toBeNull();
    expect(body.previous).toBeNull();
  });

  it('follows the R2 list cursor past one page', async () => {
    const { store, call } = setup(2);
    publish(store, 'lab-a', ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0'], '1.4.0');
    const { body } = await call('GET', '/labs/lab-a/versions');
    expect(body.versions.map((v: { version: string }) => v.version)).toEqual(['1.4.0', '1.3.0', '1.2.0', '1.1.0', '1.0.0']);
  });

  it('a version whose manifest is unreadable is still listed, flagged, not a 500', async () => {
    const { store, call } = setup();
    publish(store, 'lab-a', ['1.0.0', '1.1.0'], '1.1.0');
    store.set(manifestKey('lab-a', '1.0.0'), '{not json');
    const { status, body } = await call('GET', '/labs/lab-a/versions');
    expect(status).toBe(200);
    expect(body.versions.find((v: { version: string }) => v.version === '1.0.0')).toMatchObject({ title: null, error: 'manifest unreadable' });
    expect(body.versions.find((v: { version: string }) => v.version === '1.1.0').error).toBeUndefined();
  });

  it('404 lab_not_found for a lab with nothing published, and for a slug that cannot be one', async () => {
    const { call } = setup();
    expect((await call('GET', '/labs/no-such-lab/versions')).body.error.code).toBe('lab_not_found');
    expect((await call('GET', '/labs/..%2Fsecrets/versions')).status).toBe(404);
    expect((await call('GET', '/labs/UPPER/versions')).status).toBe(404);
  });
});

describe('POST /labs/:slug/promote', () => {
  it('flips current, records the old current as previous, rebuilds the index, and answers { slug, current, previous }', async () => {
    const { store, call, env } = setup();
    publish(store, 'lab-a', ['1.0.0', '1.1.0', '2.0.0'], '1.1.0', '1.0.0');

    const { status, body } = await call('POST', '/labs/lab-a/promote', { version: '2.0.0' });

    expect(status).toBe(200);
    expect(body).toEqual({ slug: 'lab-a', current: '2.0.0', previous: '1.1.0' });
    expect(store.get(currentKey('lab-a'))).toBe('2.0.0');
    expect(store.get(previousKey('lab-a'))).toBe('1.1.0');
    expect(spy.rebuildIndex).toHaveBeenCalledTimes(1);
    expect(spy.rebuildIndex).toHaveBeenCalledWith(expect.objectContaining({ LABS_BUCKET: env.LABS_BUCKET }));

    // What the API reports for the lab, and the catalogue, both follow.
    expect((await loadCurrentManifest(env, 'lab-a')).version).toBe('2.0.0');
    const index = JSON.parse(store.get(INDEX_KEY)!) as LabIndexEntry[];
    expect(index.find((e) => e.slug === 'lab-a')!.version).toBe('2.0.0');
  });

  it('the index is rebuilt after both pointers are written, never before', async () => {
    const { store, call } = setup();
    publish(store, 'lab-a', ['1.0.0', '2.0.0'], '1.0.0');
    const seen: Array<string | undefined> = [];
    spy.rebuildIndex.mockImplementationOnce(async () => {
      seen.push(store.get(currentKey('lab-a')), store.get(previousKey('lab-a')));
      return [];
    });
    await call('POST', '/labs/lab-a/promote', { version: '2.0.0' });
    expect(seen).toEqual(['2.0.0', '1.0.0']);
  });

  it('rolling back to the previous version swaps the two pointers', async () => {
    const { store, call } = setup();
    publish(store, 'lab-a', ['1.0.0', '2.0.0'], '2.0.0', '1.0.0');
    const { body } = await call('POST', '/labs/lab-a/promote', { version: '1.0.0' });
    expect(body).toEqual({ slug: 'lab-a', current: '1.0.0', previous: '2.0.0' });
  });

  it('is idempotent: promoting what is already current keeps previous and writes no pointer', async () => {
    const { store, call, puts } = setup();
    publish(store, 'lab-a', ['1.0.0', '2.0.0'], '2.0.0', '1.0.0');
    puts.length = 0;

    const first = await call('POST', '/labs/lab-a/promote', { version: '2.0.0' });
    const second = await call('POST', '/labs/lab-a/promote', { version: '2.0.0' });

    for (const r of [first, second]) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ slug: 'lab-a', current: '2.0.0', previous: '1.0.0' });
    }
    expect(puts.filter((k) => k === currentKey('lab-a') || k === previousKey('lab-a'))).toEqual([]);
    expect(store.get(previousKey('lab-a'))).toBe('1.0.0');
  });

  it('the first promotion of a lab with no previous leaves previous null', async () => {
    const { store, call } = setup();
    store.set(manifestKey('lab-a', '1.0.0'), JSON.stringify(manifest('lab-a', '1.0.0')));
    const { body } = await call('POST', '/labs/lab-a/promote', { version: '1.0.0' });
    expect(body).toEqual({ slug: 'lab-a', current: '1.0.0', previous: null });
    expect(store.has(previousKey('lab-a'))).toBe(false);
  });

  it('404 unknown_version when the version was never published, and nothing is written or rebuilt', async () => {
    const { store, call, puts } = setup();
    publish(store, 'lab-a', ['1.0.0'], '1.0.0');
    puts.length = 0;

    const { status, body } = await call('POST', '/labs/lab-a/promote', { version: '3.0.0' });

    expect(status).toBe(404);
    expect(body.error.code).toBe('unknown_version');
    expect(puts).toEqual([]);
    expect(store.get(currentKey('lab-a'))).toBe('1.0.0');
    expect(spy.rebuildIndex).not.toHaveBeenCalled();
  });

  it('another lab\'s version is not this lab\'s version', async () => {
    const { store, call } = setup();
    publish(store, 'lab-a', ['1.0.0'], '1.0.0');
    publish(store, 'lab-b', ['5.0.0'], '5.0.0');
    expect((await call('POST', '/labs/lab-a/promote', { version: '5.0.0' })).body.error.code).toBe('unknown_version');
  });

  it('400 bad_version for a missing, non-string or path-like version; the bucket is never asked', async () => {
    const { store, call } = setup();
    publish(store, 'lab-a', ['1.0.0'], '1.0.0');
    for (const body of [{}, { version: 2 }, { version: '../1.0.0' }, { version: '1.0' }, { version: '' }, undefined]) {
      const r = await call('POST', '/labs/lab-a/promote', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe('bad_version');
    }
    expect(spy.rebuildIndex).not.toHaveBeenCalled();
  });

  it('a body that is not JSON is a 400, not a 500', async () => {
    const { env } = setup();
    const app = new Hono<{ Bindings: Env }>();
    app.onError((err) => (err instanceof ApiError ? err : fromSdkError(err)).toResponse());
    mountAdmin(app);
    const res = await app.fetch(new Request('https://api.test/labs/lab-a/promote', { method: 'POST', headers: KEY, body: '{oops' }), env);
    expect(res.status).toBe(400);
  });
});
