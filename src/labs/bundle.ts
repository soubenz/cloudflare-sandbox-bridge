import type { Env } from '../env';
import type { LabManifest } from './manifest';
import { isWarmUp, parseManifest } from './manifest';
import { ApiError } from '../lib/errors';
import { LearnBundleSchema, MAX_AUDIO_CLIPS, MAX_AUDIO_CLIP_BYTES, learnAudioClips, parseLearnBundle, type LearnBundle } from './learn';
import { looksLikeMp3 } from './mp3';

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
/**
 * The lab's compiled learning layer (story, lessons, quiz, graded fields) as
 * one JSON document: `LearnBundle`, validated by `parseLearnBundle` at
 * publish. Unlike solution.tgz it is meant for learners, so GET
 * /labs/:slug/learn serves it; it never holds anything from checks/ or
 * solution/.
 */
export function learnKey(slug: string, version: string): string {
  return `labs/${slug}/${version}/learn.json`;
}
/**
 * One narration clip of the lab's comic (learn.json's `audio`): `file` is `<16 hex>.mp3`.
 * Meant for learners like learn.json: GET /labs/:slug/audio/:file serves it, and only files a
 * publish uploaded against the bundle's own audio index are ever stored here.
 */
export function audioKey(slug: string, version: string, file: string): string {
  return `labs/${slug}/${version}/audio/${file}`;
}
/** A clip's file name: its sixteen-hex key and .mp3. */
export const CLIP_FILE = /^[0-9a-f]{16}\.mp3$/;
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
  /** Absent for a warm-up, which has no container. */
  family?: LabManifest['family'];
  /** Catalogue context, so a learner can choose without starting a container. */
  summary?: string;
  objectives: string[];
  difficulty?: LabManifest['difficulty'];
  /** Absent for a warm-up, which never starts a session. */
  timeout_minutes?: number;
  /** Catalogue placement (all optional except `tier`, which defaults to 'pro'). */
  path?: string;
  module?: number;
  order?: number;
  prerequisites?: string[];
  tier: LabManifest['tier'];
  estimated_minutes?: number;
  /** Present (and true) only for an archived lab: hidden from learners, still startable by slug. Absent otherwise, so other entries stay as they were. */
  archived?: true;
  /** True when the current version ships a learning layer (`learn.json`), so the console can offer "Before you begin" without fetching it. */
  has_learn: boolean;
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

/**
 * The learning layer of a lab's current version, or null when the lab is
 * published but ships none. An unpublished lab is 404 `lab_not_found`, like
 * `loadCurrentManifest`. Read with the bundle's own schema only: the concept
 * registry can change after a publish, and a lab that was valid then must
 * not start failing to serve now.
 */
export async function loadCurrentLearn(env: Env, slug: string): Promise<{ version: string; learn: LearnBundle } | null> {
  const currentObj = await env.LABS_BUCKET.get(currentKey(slug));
  if (!currentObj) throw ApiError.notFound('lab_not_found', `No published lab "${slug}"`);
  const version = (await currentObj.text()).trim();
  const obj = await env.LABS_BUCKET.get(learnKey(slug, version));
  if (!obj) return null;
  const parsed = LearnBundleSchema.safeParse(await obj.json());
  if (!parsed.success) throw ApiError.internal(`lab "${slug}" version "${version}" has a learn.json that does not parse`);
  return { version, learn: parsed.data };
}

/** The current version of a lab, for routes that read one of its stored files. 404 `lab_not_found` when unpublished. */
export async function currentVersion(env: Env, slug: string): Promise<string> {
  const currentObj = await env.LABS_BUCKET.get(currentKey(slug));
  if (!currentObj) throw ApiError.notFound('lab_not_found', `No published lab "${slug}"`);
  return (await currentObj.text()).trim();
}

/**
 * Checks the clips a publish uploaded against the bundle's narration index and returns them
 * by file name. Throws `400 invalid_audio` unless: every name is `<16 hex>.mp3`, no name repeats,
 * there are at most MAX_AUDIO_CLIPS, each is at most MAX_AUDIO_CLIP_BYTES, starts like an MP3 and is as
 * long as the index says, and the uploaded set is exactly the set the opener's and the closing's `audio.clips` name.
 */
export function checkAudioUpload(learn: LearnBundle | undefined, clips: readonly { name: string; bytes: ArrayBuffer }[]): void {
  const bad = (message: string): never => {
    throw ApiError.badRequest('invalid_audio', message);
  };
  // The opener's and the closing comic's narration together (learnAudioClips).
  const hasIndex = learn?.audio !== undefined || learn?.closing?.audio !== undefined;
  if (clips.length === 0 && !hasIndex) return;
  if (!hasIndex) bad('audio clips were uploaded but the learn bundle has no audio index');
  const index = learnAudioClips(learn!);
  if (clips.length > MAX_AUDIO_CLIPS) bad(`a lab may carry at most ${MAX_AUDIO_CLIPS} audio clips (got ${clips.length})`);
  const seen = new Set<string>();
  for (const c of clips) {
    if (!CLIP_FILE.test(c.name)) bad(`audio file name "${c.name.slice(0, 40)}" is not <16 hex digits>.mp3`);
    if (seen.has(c.name)) bad(`audio file ${c.name} is uploaded twice`);
    seen.add(c.name);
    if (c.bytes.byteLength > MAX_AUDIO_CLIP_BYTES) bad(`audio file ${c.name} is ${c.bytes.byteLength} bytes; the limit is ${MAX_AUDIO_CLIP_BYTES}`);
    const key = c.name.slice(0, -4);
    const entry = index[key];
    if (!entry) bad(`audio file ${c.name} is not referenced by the bundle's audio index`);
    if (!looksLikeMp3(new Uint8Array(c.bytes))) bad(`audio file ${c.name} is not an MP3`);
    if (entry!.bytes !== c.bytes.byteLength) bad(`audio file ${c.name} is ${c.bytes.byteLength} bytes but the index says ${entry!.bytes}`);
  }
  for (const key of Object.keys(index)) {
    if (!seen.has(`${key}.mp3`)) bad(`the audio index names clip ${key}, but ${key}.mp3 was not uploaded`);
  }
}

export async function loadCatalogue(env: Env): Promise<LabIndexEntry[]> {
  const obj = await env.LABS_BUCKET.get(INDEX_KEY);
  if (!obj) return [];
  // An index written before the learning layer has no `has_learn`; those labs have none.
  return ((await obj.json()) as Array<Omit<LabIndexEntry, 'has_learn'> & { has_learn?: boolean }>).map((e) => ({ ...e, has_learn: e.has_learn === true }));
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
 * A warm-up has no container, so it carries no tarballs (any sent are not
 * stored) and must carry a learn bundle instead: without one it is
 * `400 invalid_learn_bundle`.
 * `solution/` is never part of either of those archives. When the CLI sends
 * one it is stored on its own, at `solutionKey`, and never served by a
 * catalogue route; a forced re-publish that carries none removes the one the
 * version already had, so the stored bundle always matches the last publish.
 * The same holds for `learn.json` (the compiled learning layer): the Worker
 * validates it with `parseLearnBundle` before anything is written, because
 * it must not trust the CLI, and stores the parsed (defaults filled) form.
 * A bundle that does not validate is `400 invalid_learn_bundle` and nothing
 * of the publish is stored.
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
    /** Required unless the manifest is a warm-up. */
    workspaceTgz?: ReadableStream | ArrayBuffer;
    /** Required unless the manifest is a warm-up. */
    privateTgz?: ReadableStream | ArrayBuffer;
    /** Optional: the lab's solution/ as a gzip tarball (see `solutionKey`). */
    solutionTgz?: ReadableStream | ArrayBuffer;
    /** Optional: the compiled learn/ folder, as parsed JSON (see `learnKey`). Validated here. */
    learnJson?: unknown;
    /** Optional: the narration clips the bundle's `audio` index names (see `audioKey`). Validated here. */
    audioClips?: { name: string; bytes: ArrayBuffer }[];
    force?: boolean;
  }
): Promise<{ slug: string; version: string; warnings: string[] }> {
  const manifest = parseManifest(input.manifestJson);
  const { slug, version } = manifest;
  const warmUp = isWarmUp(manifest);
  if (!warmUp && (input.workspaceTgz === undefined || input.privateTgz === undefined)) {
    throw ApiError.badRequest('bad_publish_payload', 'a lab needs both workspace and private archives');
  }

  let learn: LearnBundle | undefined;
  if (input.learnJson !== undefined) {
    try {
      learn = parseLearnBundle(input.learnJson);
    } catch (err) {
      throw ApiError.badRequest('invalid_learn_bundle', err instanceof Error ? err.message : String(err));
    }
  }

  // A warm-up is nothing but its learning layer.
  if (warmUp && learn === undefined) throw ApiError.badRequest('invalid_learn_bundle', 'a warm-up needs learn/');

  const audioClips = input.audioClips ?? [];
  checkAudioUpload(learn, audioClips);

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
    !warmUp ? env.LABS_BUCKET.put(workspaceKey(slug, version), input.workspaceTgz!) : Promise.resolve(),
    !warmUp ? env.LABS_BUCKET.put(privateKey(slug, version), input.privateTgz!) : Promise.resolve(),
    input.solutionTgz !== undefined
      ? env.LABS_BUCKET.put(solutionKey(slug, version), input.solutionTgz)
      : input.force === true
        ? env.LABS_BUCKET.delete(solutionKey(slug, version))
        : Promise.resolve(),
    learn !== undefined
      ? env.LABS_BUCKET.put(learnKey(slug, version), JSON.stringify(learn, null, 2), {
          httpMetadata: { contentType: 'application/json' },
        })
      : input.force === true
        ? env.LABS_BUCKET.delete(learnKey(slug, version))
        : Promise.resolve(),
    ...audioClips.map((c) => env.LABS_BUCKET.put(audioKey(slug, version, c.name), c.bytes, { httpMetadata: { contentType: 'audio/mpeg' } })),
  ]);
  // A forced re-publish leaves exactly the clips of this publish, like learn.json and solution.tgz.
  if (input.force === true) {
    const keep = new Set(audioClips.map((c) => audioKey(slug, version, c.name)));
    for (const key of await listAllKeys(env, audioKey(slug, version, ''))) {
      if (!keep.has(key)) await env.LABS_BUCKET.delete(key);
    }
  }

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
          const { version, manifest } = await loadCurrentManifest(env, slug);
          const hasLearn = (await env.LABS_BUCKET.head(learnKey(slug, version))) !== null;
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
            // Only when true: every other entry keeps exactly its old shape.
            ...(manifest.archived ? { archived: true as const } : {}),
            has_learn: hasLearn,
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
