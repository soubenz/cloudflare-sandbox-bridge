import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import onboarding from '../../packages/catalogue/onboarding.json';
import concepts from '../../packages/catalogue/concepts.json';
import { AREAS, UNMAPPED_MODULES, areaForPlacement, areaById } from '../../src/profile/areas';

/** Placement of every lab in labs/, read from the manifests. */
function placements(): Array<{ slug: string; path?: string; module?: number; archived: boolean }> {
  const root = join(__dirname, '..', '..', 'labs');
  const out: Array<{ slug: string; path?: string; module?: number; archived: boolean }> = [];
  for (const slug of readdirSync(root)) {
    const file = join(root, slug, 'manifest.yaml');
    if (!existsSync(file)) continue;
    const m = parse(readFileSync(file, 'utf8')) as { path?: string; module?: number; archived?: boolean };
    out.push({ slug, ...(m.path ? { path: m.path } : {}), ...(m.module !== undefined ? { module: m.module } : {}), archived: m.archived === true });
  }
  return out;
}

describe('skill areas', () => {
  it('are exactly the areas of the onboarding quiz, in its order, with the concepts file titles', () => {
    expect(AREAS.map((a) => a.id)).toEqual(onboarding.areas.map((a) => a.area));
    for (const a of AREAS) {
      const c = (concepts.areas as Record<string, { title: string; path: string; module: number }>)[a.id];
      expect(c, `${a.id} is in concepts.json`).toBeDefined();
      expect({ title: a.title, path: a.path, module: a.module }).toEqual({ title: c!.title, path: c!.path, module: c!.module });
    }
  });

  it('are six, each with a unique id and a unique module', () => {
    expect(AREAS).toHaveLength(6);
    expect(new Set(AREAS.map((a) => a.id)).size).toBe(6);
    expect(new Set(AREAS.map((a) => `${a.path}#${a.module}`)).size).toBe(6);
  });

  it('are fed by every module a published, non-archived lab sits in, or that module is listed as unmapped on purpose', () => {
    const unmapped = new Set(UNMAPPED_MODULES.map((m) => `${m.path}#${m.module}`));
    const stray: string[] = [];
    for (const l of placements().filter((p) => !p.archived && p.path !== undefined)) {
      const module = l.module ?? 1;
      const mapped = areaForPlacement({ path: l.path, module }) !== undefined;
      if (!mapped && !unmapped.has(`${l.path}#${module}`)) stray.push(`${l.slug} (${l.path} module ${module})`);
    }
    expect(stray, `labs in a module that maps to no area and is not in UNMAPPED_MODULES: ${stray.join(', ')}`).toEqual([]);
  });

  it('never list a module as both mapped and unmapped, and every unmapped module still has labs', () => {
    const labs = placements().filter((p) => !p.archived);
    for (const u of UNMAPPED_MODULES) {
      expect(areaForPlacement(u), `${u.path}#${u.module}`).toBeUndefined();
      expect(labs.some((l) => l.path === u.path && (l.module ?? 1) === u.module), `${u.path}#${u.module} has labs`).toBe(true);
    }
  });

  it('every area has at least one published lab', () => {
    const labs = placements().filter((p) => !p.archived);
    for (const a of AREAS) expect(labs.some((l) => l.path === a.path && l.module === a.module), a.id).toBe(true);
  });

  it('map a lab with no placement, or an unmapped module, to no area', () => {
    expect(areaForPlacement({})).toBeUndefined();
    expect(areaForPlacement({ path: 'ai-platform' })).toBeUndefined();
    expect(areaForPlacement({ path: 'ai-platform', module: 5 })).toBeUndefined();
    expect(areaForPlacement({ path: 'production-agents', module: 1 })).toBeUndefined();
    expect(areaForPlacement({ path: 'ai-platform', module: 3 })?.id).toBe('rag');
    expect(areaById('mcp')?.module).toBe(2);
    expect(areaById('nope')).toBeUndefined();
  });
});
