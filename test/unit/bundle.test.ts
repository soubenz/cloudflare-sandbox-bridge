import { describe, it, expect, vi } from 'vitest';
import {
  publishLab,
  rebuildIndex,
  loadCatalogue,
  listCatalogue,
  pageCatalogue,
  manifestKey,
  currentKey,
  previousKey,
  INDEX_KEY,
  type LabIndexEntry,
} from '../../src/labs/bundle';
import type { Env } from '../../src/env';
import { ApiError } from '../../src/lib/errors';

/** Minimal in-memory R2 whose list() truncates at `pageSize` keys and hands back a cursor, like the real one at 1000. */
function fakeBucket(pageSize = 1000) {
  const store = new Map<string, string>();
  const listCalls: unknown[] = [];
  const bucket = {
    async get(key: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return { text: async () => v, json: async () => JSON.parse(v) };
    },
    async head(key: string) {
      return store.has(key) ? { key } : null;
    },
    async put(key: string, value: unknown) {
      store.set(key, typeof value === 'string' ? value : `bytes:${(value as ArrayBuffer).byteLength}`);
    },
    async list(opts: { prefix?: string; cursor?: string } = {}) {
      listCalls.push(opts);
      const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const slice = keys.slice(start, start + pageSize);
      const truncated = start + pageSize < keys.length;
      return {
        objects: slice.map((key) => ({ key })),
        truncated,
        ...(truncated ? { cursor: String(start + pageSize) } : {}),
      };
    },
  };
  const env = { LABS_BUCKET: bucket } as unknown as Env;
  return { env, store, listCalls };
}

function manifest(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    version: '1.0.0',
    title: `Lab ${slug}`,
    type: 'build',
    family: 'agent',
    timeout_minutes: 60,
    services: [{ name: 'svc', argv: ['x'], port: 8000 }],
    checks: [{ name: 'c', script: 'c.sh' }],
    ...extra,
  };
}

const bytes = () => new ArrayBuffer(4);
const publish = (env: Env, m: unknown, force?: boolean) =>
  publishLab(env, { manifestJson: m, workspaceTgz: bytes(), privateTgz: bytes(), force });

/** Seed a published lab straight into the store, bypassing publishLab. */
function seed(store: Map<string, string>, slug: string, extra: Record<string, unknown> = {}) {
  const m = { ...manifest(slug, extra), idle_minutes: 10, env: {}, pressure: [], hints: [], objectives: [], egress: { allow: [] }, tier: 'pro', ...extra };
  store.set(manifestKey(slug, '1.0.0'), JSON.stringify(m));
  store.set(currentKey(slug), '1.0.0');
}

describe('rebuildIndex ordering', () => {
  it('sorts by (path ?? zz, module ?? 999, order ?? 999, slug) regardless of insertion order', async () => {
    const { env, store } = fakeBucket();
    seed(store, 'zeta-unplaced');
    seed(store, 'alpha-unplaced');
    seed(store, 'b-two', { path: 'beta', module: 1, order: 2 });
    seed(store, 'b-one', { path: 'beta', module: 1, order: 1 });
    seed(store, 'a-mod2', { path: 'alpha', module: 2, order: 1 });
    seed(store, 'a-mod1-second', { path: 'alpha', module: 1, order: 2 });
    seed(store, 'a-mod1-first', { path: 'alpha', module: 1, order: 1 });
    seed(store, 'a-nomodule', { path: 'alpha' });
    seed(store, 'a-tie-y', { path: 'alpha', module: 1, order: 3 });
    seed(store, 'a-tie-x', { path: 'alpha', module: 1, order: 3 });

    await rebuildIndex(env);
    const index = await loadCatalogue(env);
    expect(index.map((e) => e.slug)).toEqual([
      'a-mod1-first',
      'a-mod1-second',
      'a-tie-x',
      'a-tie-y',
      'a-mod2',
      'a-nomodule',
      'b-one',
      'b-two',
      'alpha-unplaced',
      'zeta-unplaced',
    ]);
  });

  it('carries the catalogue fields into the index entry', async () => {
    const { env } = fakeBucket();
    await publish(env, manifest('placed-lab', { path: 'p', module: 3, order: 4, prerequisites: ['x'], tier: 'free', estimated_minutes: 30 }));
    const [e] = await loadCatalogue(env);
    expect(e).toMatchObject({ path: 'p', module: 3, order: 4, prerequisites: ['x'], tier: 'free', estimated_minutes: 30 });
  });

  it('indexes every slug when the bucket holds more than one list() page', async () => {
    const { env, store, listCalls } = fakeBucket(1000);
    for (let i = 0; i < 1100; i++) seed(store, `lab-${String(i).padStart(4, '0')}`);
    // Bulk that pushes `current` pointers across the 1000-key boundary.
    for (let i = 0; i < 1200; i++) store.set(`labs/lab-0000/9.9.${i}/workspace.tgz`, 'x');
    expect(store.size).toBeGreaterThan(2000);

    const entries = await rebuildIndex(env);
    expect(entries).toHaveLength(1100);
    expect(new Set(entries.map((e) => e.slug)).size).toBe(1100);
    expect(listCalls.length).toBeGreaterThan(2);
    const written = JSON.parse(store.get(INDEX_KEY)!) as LabIndexEntry[];
    expect(written).toHaveLength(1100);
  });
});

describe('publishLab', () => {
  it('409 version_exists on re-publishing the same version without force', async () => {
    const { env } = fakeBucket();
    await publish(env, manifest('one-lab'));
    const err = await publish(env, manifest('one-lab')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe('version_exists');
  });

  it('force overwrites the version', async () => {
    const { env, store } = fakeBucket();
    await publish(env, manifest('one-lab', { title: 'First' }));
    await publish(env, manifest('one-lab', { title: 'Second' }), true);
    expect(JSON.parse(store.get(manifestKey('one-lab', '1.0.0'))!).title).toBe('Second');
    expect((await loadCatalogue(env))[0]!.title).toBe('Second');
  });

  it('copies the old current to previous before flipping it', async () => {
    const { env, store } = fakeBucket();
    await publish(env, manifest('one-lab'));
    expect(store.has(previousKey('one-lab'))).toBe(false);
    await publish(env, manifest('one-lab', { version: '1.1.0' }));
    expect(store.get(previousKey('one-lab'))).toBe('1.0.0');
    expect(store.get(currentKey('one-lab'))).toBe('1.1.0');
    // A forced re-publish of the current version keeps the real rollback target.
    await publish(env, manifest('one-lab', { version: '1.1.0', title: 'Again' }), true);
    expect(store.get(previousKey('one-lab'))).toBe('1.0.0');
  });

  it('warns, without failing, on prerequisites that are not published', async () => {
    const { env } = fakeBucket();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await publish(env, manifest('base-lab'));
      const r = await publish(env, manifest('next-lab', { prerequisites: ['base-lab', 'ghost-lab'] }));
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain('ghost-lab');
      expect((await publish(env, manifest('base-lab', { version: '1.0.1' }))).warnings).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('listCatalogue', () => {
  async function catalogue() {
    const { env, store } = fakeBucket();
    seed(store, 'lab-a1', { path: 'alpha', module: 1, order: 1, tier: 'free' });
    seed(store, 'lab-a2', { path: 'alpha', module: 1, order: 2 });
    seed(store, 'lab-a3', { path: 'alpha', module: 2, order: 1, tier: 'free' });
    seed(store, 'lab-b1', { path: 'beta', module: 1, order: 1 });
    seed(store, 'loose');
    await rebuildIndex(env);
    return env;
  }

  it('filters by path, module and tier', async () => {
    const env = await catalogue();
    expect((await listCatalogue(env, { path: 'alpha' })).labs.map((e) => e.slug)).toEqual(['lab-a1', 'lab-a2', 'lab-a3']);
    expect((await listCatalogue(env, { path: 'alpha', module: 1 })).labs.map((e) => e.slug)).toEqual(['lab-a1', 'lab-a2']);
    expect((await listCatalogue(env, { tier: 'free' })).labs.map((e) => e.slug)).toEqual(['lab-a1', 'lab-a3']);
    expect((await listCatalogue(env, { path: 'alpha', tier: 'pro' })).labs.map((e) => e.slug)).toEqual(['lab-a2']);
  });

  it('pages with limit and cursor, and omits next on the last page', async () => {
    const env = await catalogue();
    const p1 = await listCatalogue(env, { limit: 2 });
    expect(p1.labs.map((e) => e.slug)).toEqual(['lab-a1', 'lab-a2']);
    expect(p1.next).toBe('lab-a2');
    const p2 = await listCatalogue(env, { limit: 2, cursor: p1.next });
    expect(p2.labs.map((e) => e.slug)).toEqual(['lab-a3', 'lab-b1']);
    const p3 = await listCatalogue(env, { limit: 2, cursor: p2.next });
    expect(p3.labs.map((e) => e.slug)).toEqual(['loose']);
    expect(p3.next).toBeUndefined();
  });

  it('pages within a filter, and rejects a cursor that is not in it', async () => {
    const env = await catalogue();
    const p1 = await listCatalogue(env, { path: 'alpha', limit: 2 });
    expect(p1.next).toBe('lab-a2');
    expect((await listCatalogue(env, { path: 'alpha', limit: 2, cursor: p1.next })).labs.map((e) => e.slug)).toEqual(['lab-a3']);
    await expect(listCatalogue(env, { path: 'beta', cursor: 'lab-a2' })).rejects.toMatchObject({ status: 400, code: 'bad_cursor' });
  });

  it('treats index entries without a tier as pro and clamps limit', () => {
    const legacy = [{ slug: 'old', version: '1.0.0', title: 't', type: 'build', family: 'agent', objectives: [], timeout_minutes: 60 }] as unknown as LabIndexEntry[];
    expect(pageCatalogue(legacy, { tier: 'pro' }).labs).toHaveLength(1);
    expect(pageCatalogue(legacy, { tier: 'free' }).labs).toHaveLength(0);
    expect(pageCatalogue(legacy, { limit: 0 }).labs).toHaveLength(1);
  });
});
