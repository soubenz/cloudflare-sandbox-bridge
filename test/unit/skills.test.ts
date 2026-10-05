import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import pathsMeta from '../../packages/catalogue/paths.json';
import concepts from '../../packages/catalogue/concepts.json';
import onboarding from '../../packages/catalogue/onboarding.json';
import { QUIZ_SKILLS, SKILLS, deriveSkills, skillById, skillForPlacement, type SkillDef } from '../../src/skills';
import { AREAS, areaById, areaForPlacement } from '../../src/profile/areas';
import { AREAS as RULE_AREAS, labArea } from '../../src/path/rules';

/** The console's copy (dashboard/src/skills.js), imported as plain JS. */
const consoleSkills = (await import('../../dashboard/src/skills.js' as string)) as {
  SKILLS: SkillDef[];
  deriveSkills: (meta?: unknown, quiz?: unknown) => SkillDef[];
  skillForPlacement: (path: unknown, module: unknown) => SkillDef | null;
  skillById: (id: string) => SkillDef | null;
  skillLook: (id: string) => { icon: string; accent: string };
};

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

type ModuleMeta = { number: number; title: string; skill?: string; icon?: string; accent?: string };
type PathMeta = { slug: string; title: string; skill?: string; icon?: string; accent?: string; modules: ModuleMeta[] };
const PATHS = (pathsMeta as unknown as { paths: PathMeta[] }).paths;

describe('the skill list', () => {
  it('is the ten skills, ids to titles, in the order of paths.json', () => {
    expect(SKILLS.map((s) => [s.id, s.title])).toEqual([
      ['agents', 'Agent builder'],
      ['security', 'Agent security'],
      ['gateway', 'Gateway and access'],
      ['mcp', 'Tools and MCP'],
      ['rag', 'Retrieval as a service'],
      ['otel', 'Observability and cost'],
      ['runtime', 'Runtime and durability'],
      ['platform', 'Self-service and golden paths'],
      ['sovereignty', 'Compliance and sovereignty'],
      ['evals', 'Agent evals and releases'],
    ]);
  });

  it('keeps the six old area ids on AI-platform modules 1, 2, 3, 4, 6 and 7, so stored data needs no migration', () => {
    const at = (n: number) => SKILLS.find((s) => s.path === 'ai-platform' && s.module === n)?.id;
    expect([1, 2, 3, 4, 6, 7].map(at)).toEqual(['gateway', 'mcp', 'rag', 'otel', 'platform', 'sovereignty']);
    expect(at(5)).toBe('runtime');
  });

  it('has unique single-word ids that the console and the profile route accept', () => {
    expect(new Set(SKILLS.map((s) => s.id)).size).toBe(SKILLS.length);
    for (const s of SKILLS) {
      expect(s.id, s.id).toMatch(/^[a-z]+$/); // AREA_ID in dashboard/src/learn-model.js
      expect(s.id, s.id).toMatch(/^[a-z]{2,24}$/); // startingParam in dashboard/src/profile.js
    }
  });

  it('takes every title, icon and accent from its module, or from its path when the path has no modules', () => {
    for (const s of SKILLS) {
      const path = PATHS.find((p) => p.slug === s.path)!;
      const source = s.module === null ? path : path.modules.find((m) => m.number === s.module)!;
      expect(path.modules.length === 0, s.id).toBe(s.module === null);
      expect({ id: s.id, title: s.title, icon: s.icon, accent: s.accent }).toEqual({ id: source.skill, title: source.title, icon: source.icon, accent: source.accent });
    }
  });

  it('is the same list on the server and in the console', () => {
    expect(consoleSkills.SKILLS).toEqual(SKILLS.map((s) => ({ ...s })));
    for (const s of SKILLS) expect(consoleSkills.skillLook(s.id)).toEqual({ icon: s.icon, accent: s.accent });
    expect(consoleSkills.skillLook('nope')).toEqual({ icon: 'grid', accent: 'slate' });
  });

  it('marks as quiz skills exactly the areas the onboarding quiz asks about', () => {
    expect(QUIZ_SKILLS.map((s) => s.id).sort()).toEqual([...concepts.quiz].sort());
    expect(QUIZ_SKILLS.map((s) => s.id).sort()).toEqual(onboarding.areas.map((a) => a.area).sort());
    for (const id of concepts.quiz) expect(skillById(id), id).toBeDefined();
    for (const s of SKILLS) expect(s.quiz, s.id).toBe(onboarding.questions.some((q) => q.concept.startsWith(`${s.id}.`)));
  });

  it('names a skill for every concept: concept ids are <skill>.<name>', () => {
    const ids = new Set(SKILLS.map((s) => s.id));
    for (const c of concepts.concepts) expect(ids.has(c.id.split('.')[0]!), c.id).toBe(true);
  });

  it('maps every published lab to exactly one skill, and every skill has a lab', () => {
    const labs = placements().filter((p) => !p.archived);
    const stray: string[] = [];
    for (const l of labs) {
      const matches = SKILLS.filter((s) => s.path === l.path && (s.module === null || s.module === (l.module ?? 1)));
      if (matches.length !== 1) stray.push(`${l.slug} (${l.path} module ${l.module}) -> ${matches.length}`);
      expect(skillForPlacement(l.path, l.module)?.id, l.slug).toBe(matches[0]?.id);
      expect(labArea({ path: l.path, module: l.module }), l.slug).toBe(matches[0]?.id);
    }
    expect(stray).toEqual([]);
    for (const s of SKILLS) expect(labs.some((l) => skillForPlacement(l.path, l.module)?.id === s.id), s.id).toBe(true);
  });

  it('maps a placement with no path, an unknown path or an unknown module to no skill', () => {
    expect(skillForPlacement(undefined, 1)).toBeUndefined();
    expect(skillForPlacement('ai-platform', undefined)).toBeUndefined();
    expect(skillForPlacement('ai-platform', 99)).toBeUndefined();
    expect(skillForPlacement('nowhere', 1)).toBeUndefined();
    expect(skillForPlacement('production-agents', 1)?.id).toBe('agents');
    expect(skillForPlacement('ai-platform', 3)?.id).toBe('rag');
    expect(consoleSkills.skillForPlacement('evals-releases', 1)?.id).toBe('evals');
    expect(consoleSkills.skillForPlacement(undefined, 1)).toBeNull();
    expect(consoleSkills.skillForPlacement('ai-platform', 5)?.id).toBe('runtime');
  });

  it('is what the profile and the path rules read', () => {
    expect(AREAS).toBe(SKILLS);
    expect(areaById('mcp')?.module).toBe(2);
    expect(areaById('nope')).toBeUndefined();
    expect(areaForPlacement({ path: 'securing-agents', module: 1 })?.id).toBe('security');
    expect(Object.keys(RULE_AREAS)).toEqual(SKILLS.map((s) => s.id));
    expect(RULE_AREAS.agents).toEqual({ title: 'Agent builder', path: 'production-agents', module: null });
  });

  it('refuses a paths file with a missing or repeated skill id', () => {
    const one = (extra: Partial<PathMeta>) => ({ paths: [{ slug: 'x', title: 'X', modules: [], ...extra }] });
    expect(() => deriveSkills(one({}), [])).toThrow(/needs a "skill" id/);
    expect(() => deriveSkills(one({ skill: 'Bad-Id' }), [])).toThrow(/needs a "skill" id/);
    expect(() => deriveSkills({ paths: [{ slug: 'a', title: 'A', skill: 'same', modules: [] }, { slug: 'b', title: 'B', skill: 'same', modules: [] }] }, [])).toThrow(/named twice/);
    expect(deriveSkills(one({ skill: 'ok' }), ['ok'])).toEqual([{ id: 'ok', title: 'X', path: 'x', module: null, icon: 'grid', accent: 'slate', quiz: true }]);
    // The console's copy is forgiving: a bad entry is left out rather than breaking the page.
    expect(consoleSkills.deriveSkills(one({}), [])).toEqual([]);
  });
});
