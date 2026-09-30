import type { Env } from '../env';
import type { LabManifest } from './manifest';
import { parseManifest } from './manifest';
import { ApiError } from '../lib/errors';

export function manifestKey(slug: string, version: string): string {
  return `labs/${slug}/${version}/manifest.json`;
}
export function workspaceKey(slug: string, version: string): string {
  return `labs/${slug}/${version}/workspace.tgz`;
}
export function privateKey(slug: string, version: string): string {
  return `labs/${slug}/${version}/private.tgz`;
}
/**
 * The lab's solution/ directory as a gzip tarball. Private like private.tgz:
 * no catalogue route serves it, and the only reader is the session solution
 * route (GET /sessions/:id/solution), which gates it on the unlock rule.
 */
export function solutionKey(slug: string, version: string): string {
  return `labs/${slug}/${version}/solution.tgz`;
}
export function currentKey(slug: string): string {
  return `labs/${slug}/current`;
}
/** The version `current` pointed at before the last flip; the rollback target. */
export function previousKey(slug: string): string {
  return `labs/${slug}/previous`;
}
export const INDEX_KEY = 'labs/index.json';

export interface LabIndexEntry {
  slug: string;
  version: string;
  title: string;
  type: LabManifest['type'];
  family: LabManifest['family'];
  /** Catalogue context, so a learner can choose without starting a container. */
  summary?: string;
  objectives: string[];
  difficulty?: LabManifest['difficulty'];
  timeout_minutes: number;
  /** Catalogue placement (all optional except `tier`, which defaults to 'pro'). */
  path?: string;
  module?: number;
  order?: number;
  prerequisites?: string[];
  tier: LabManifest['tier'];
  estimated_minutes?: number;
}

/** Resolves a lab's current published version and manifest. Used by POST /sessions and GET /labs/{slug}. */
export async function loadCurrentManifest(env: Env, slug: string): Promise<{ version: string; manifest: LabManifest }> {
  const currentObj = await env.LABS_BUCKET.get(currentKey(slug));
  if (!currentObj) throw ApiError.notFound('lab_not_found', `No published lab "${slug}"`);
  const version = (await currentObj.text()).trim();
  const manifestObj = await env.LABS_BUCKET.get(manifestKey(slug, version));
  if (!manifestObj) throw ApiError.internal(`lab "${slug}" current version "${version}" has no manifest`);
  const manifest = parseManifest(await manifestObj.json());
  return { version, manifest };
}

export async function loadCatalogue(env: Env): Promise<LabIndexEntry[]> {
  const obj = await env.LABS_BUCKET.get(INDEX_KEY);
  if (!obj) return [];
  return (await obj.json()) as LabIndexEntry[];
}

export interface CatalogueQuery {
  path?: string;
  module?: number;
  tier?: 'free' | 'pro';
  /** Page size; default 50, clamped to 1-200. */
  limit?: number;
  /** The `next` value of the previous page (the last slug it returned). */
  cursor?: string;
}

export const DEFAULT_CATALOGUE_LIMIT = 50;
export const MAX_CATALOGUE_LIMIT = 200;

/**
 * Filters and pages the catalogue. The index is already sorted by
 * `catalogueOrder`, so the cursor is simply the last slug of the previous
 * page: the next page starts after that slug's position in the filtered
 * list. `next` is absent on the last page.
 */
export function pageCatalogue(entries: LabIndexEntry[], q: CatalogueQuery = {}): { labs: LabIndexEntry[]; next?: string } {
  const filtered = entries.filter(
    (e) =>
      (q.path === undefined || e.path === q.path) &&
      (q.module === undefined || e.module === q.module) &&
      // Indexes written before B-13 carry no tier; those labs are 'pro'.
      (q.tier === undefined || (e.tier ?? 'pro') === q.tier)
  );
  let start = 0;
  if (q.cursor !== undefined && q.cursor !== '') {
    const at = filtered.findIndex((e) => e.slug === q.cursor);
    if (at < 0) throw ApiError.badRequest('bad_cursor', `Unknown cursor "${q.cursor}" for this filter`);
    start = at + 1;
  }
  const limit = Math.min(MAX_CATALOGUE_LIMIT, Math.max(1, Math.trunc(q.limit ?? DEFAULT_CATALOGUE_LIMIT)));
  const labs = filtered.slice(start, start + limit);
  const more = start + limit < filtered.length;
  return more ? { labs, next: labs[labs.length - 1]!.slug } : { labs };
}

/** Loads the index and returns one filtered page. The router's `GET /labs` (a later card) calls this. */
export async function listCatalogue(env: Env, q: CatalogueQuery = {}): Promise<{ labs: LabIndexEntry[]; next?: string }> {
  return pageCatalogue(await loadCatalogue(env), q);
}

/** Index order: (path ?? 'zz', module ?? 999, order ?? 999, slug). Unplaced labs sort last, by slug. */
export function compareCatalogueEntries(a: LabIndexEntry, b: LabIndexEntry): number {
  return (
    (a.path ?? 'zz').localeCompare(b.path ?? 'zz') ||
    (a.module ?? 999) - (b.module ?? 999) ||
    (a.order ?? 999) - (b.order ?? 999) ||
    a.slug.localeCompare(b.slug)
  );
}

/**
 * Publishes a lab bundle: validates the manifest, writes manifest +
 * workspace.tgz + private.tgz under the version path, records the old
 * `current` in `previous`, flips `current`, and rebuilds the catalogue.
 * `solution/` is never part of either of those archives. When the CLI sends
 * one it is stored on its own, at `solutionKey`, and never served by a
 * catalogue route; a forced re-publish that carries none removes the one the
 * version already had, so the stored bundle always matches the last publish.
 *
 * A version is immutable once published: re-publishing the same
 * `<slug>/<version>` is `409 version_exists` unless `force` is true, because
 * running sessions and snapshots resolve labs by version.
 *
 * `warnings` are non-fatal: today, prerequisites that name a slug which is
 * not in the catalogue (yet — labs are published in any order).
 */
export async function publishLab(
  env: Env,
  input: {
    manifestJson: unknown;
    workspaceTgz: ReadableStream | ArrayBuffer;
    privateTgz: ReadableStream | ArrayBuffer;
    /** Optional: the lab's solution/ as a gzip tarball (see `solutionKey`). */
    solutionTgz?: ReadableStream | ArrayBuffer;
    force?: boolean;
  }
): Promise<{ slug: string; version: string; warnings: string[] }> {
  const manifest = parseManifest(input.manifestJson);
  const { slug, version } = manifest;

  if (input.force !== true && (await env.LABS_BUCKET.head(manifestKey(slug, version)))) {
    throw ApiError.conflict(
      'version_exists',
      `Lab "${slug}" version ${version} is already published; bump the version, or pass force to overwrite it`
    );
  }

  await Promise.all([
    env.LABS_BUCKET.put(manifestKey(slug, version), JSON.stringify(manifest, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    }),
    env.LABS_BUCKET.put(workspaceKey(slug, version), input.workspaceTgz),
    env.LABS_BUCKET.put(privateKey(slug, version), input.privateTgz),
    input.solutionTgz !== undefined
      ? env.LABS_BUCKET.put(solutionKey(slug, version), input.solutionTgz)
      : input.force === true
        ? env.LABS_BUCKET.delete(solutionKey(slug, version))
        : Promise.resolve(),
  ]);

  // Keep the rollback target. A forced re-publish of the version that is
  // already current must not overwrite `previous` with itself, or the real
  // previous version is lost.
  const old = await env.LABS_BUCKET.get(currentKey(slug));
  if (old) {
    const oldVersion = (await old.text()).trim();
    if (oldVersion && oldVersion !== version) await env.LABS_BUCKET.put(previousKey(slug), oldVersion);
  }
  await env.LABS_BUCKET.put(currentKey(slug), version);

  const index = await rebuildIndex(env);
  const known = new Set(index.map((e) => e.slug));
  const warnings: string[] = [];
  for (const pre of manifest.prerequisites ?? []) {
    if (!known.has(pre)) {
      const w = `prerequisite "${pre}" of "${slug}" is not a published lab`;
      console.warn(w);
      warnings.push(w);
    }
  }
  return { slug, version, warnings };
}

/** Lists every key under `prefix`, following `truncated`/`cursor` — one R2 list() call returns at most 1000. */
async function listAllKeys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.LABS_BUCKET.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const obj of page.objects) keys.push(obj.key);
    if (!page.truncated) return keys;
    cursor = page.cursor;
    if (!cursor) return keys;
  }
}

export async function rebuildIndex(env: Env): Promise<LabIndexEntry[]> {
  const slugs = new Set<string>();
  for (const key of await listAllKeys(env, 'labs/')) {
    const m = /^labs\/([^/]+)\/current$/.exec(key);
    if (m) slugs.add(m[1]!);
  }
  const entries: LabIndexEntry[] = [];
  const pending = [...slugs];
  const WIDTH = 16;
  for (let i = 0; i < pending.length; i += WIDTH) {
    await Promise.all(
      pending.slice(i, i + WIDTH).map(async (slug) => {
        try {
          const { manifest } = await loadCurrentManifest(env, slug);
          entries.push({
            slug: manifest.slug,
            version: manifest.version,
            title: manifest.title,
            type: manifest.type,
            family: manifest.family,
            summary: manifest.summary,
            objectives: manifest.objectives,
            difficulty: manifest.difficulty,
            timeout_minutes: manifest.timeout_minutes,
            path: manifest.path,
            module: manifest.module,
            order: manifest.order,
            prerequisites: manifest.prerequisites,
            tier: manifest.tier,
            estimated_minutes: manifest.estimated_minutes,
          });
        } catch {
          // Skip a slug whose current pointer is briefly inconsistent mid-publish.
        }
      })
    );
  }
  entries.sort(compareCatalogueEntries);
  await env.LABS_BUCKET.put(INDEX_KEY, JSON.stringify(entries, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
  return entries;
}
