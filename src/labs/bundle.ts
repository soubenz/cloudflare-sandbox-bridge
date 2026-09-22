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
export function currentKey(slug: string): string {
  return `labs/${slug}/current`;
}
export const INDEX_KEY = 'labs/index.json';

export interface LabIndexEntry {
  slug: string;
  version: string;
  title: string;
  type: LabManifest['type'];
  family: LabManifest['family'];
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

/**
 * Publishes a lab bundle: validates the manifest, writes manifest +
 * workspace.tgz + private.tgz under the version path, flips `current`, and
 * rebuilds the catalogue. `solution/` is never part of either archive — the
 * CLI's `labs publish` excludes it before calling this.
 */
export async function publishLab(
  env: Env,
  input: { manifestJson: unknown; workspaceTgz: ReadableStream | ArrayBuffer; privateTgz: ReadableStream | ArrayBuffer }
): Promise<{ slug: string; version: string }> {
  const manifest = parseManifest(input.manifestJson);
  const { slug, version } = manifest;

  await Promise.all([
    env.LABS_BUCKET.put(manifestKey(slug, version), JSON.stringify(manifest, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    }),
    env.LABS_BUCKET.put(workspaceKey(slug, version), input.workspaceTgz),
    env.LABS_BUCKET.put(privateKey(slug, version), input.privateTgz),
  ]);
  await env.LABS_BUCKET.put(currentKey(slug), version);

  await rebuildIndex(env);
  return { slug, version };
}

async function rebuildIndex(env: Env): Promise<void> {
  const listed = await env.LABS_BUCKET.list({ prefix: 'labs/' });
  const slugs = new Set<string>();
  for (const obj of listed.objects) {
    const m = /^labs\/([^/]+)\/current$/.exec(obj.key);
    if (m) slugs.add(m[1]!);
  }
  const entries: LabIndexEntry[] = [];
  for (const slug of slugs) {
    try {
      const { manifest } = await loadCurrentManifest(env, slug);
      entries.push({ slug: manifest.slug, version: manifest.version, title: manifest.title, type: manifest.type, family: manifest.family });
    } catch {
      // Skip a slug whose current pointer is briefly inconsistent mid-publish.
    }
  }
  entries.sort((a, b) => a.slug.localeCompare(b.slug));
  await env.LABS_BUCKET.put(INDEX_KEY, JSON.stringify(entries, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
}
