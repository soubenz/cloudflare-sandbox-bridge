import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import realMeta from '../../packages/catalogue/paths.json';

/**
 * The launcher's grouping and every number it prints. The module is a
 * browser module with no DOM, imported directly; the specifier is cast so the
 * TypeScript project (which does not compile JS) needs no declaration file.
 */
interface Lab {
  archived?: boolean;
  slug: string;
  title?: string;
  path?: string;
  module?: number;
  order?: number;
  tier?: string;
  plan?: string;
  bypass?: boolean;
  estimated_minutes?: number;
  prerequisites?: string[];
  progress?: { attempts: number; best_score: number | null; passed_all: boolean } | null;
}
interface Entry {
  lab: Lab;
  index: number;
  done: boolean;
  status: 'done' | 'started' | 'todo';
  locked: boolean;
  lockedBy: string | null;
  lockedByTitle: string | null;
  planLocked: boolean;
  free: boolean;
  minutes: number;
}
interface Totals {
  labs: number;
  done: number;
  minutes: number;
  free: number;
}
interface Module {
  number: number | null;
  known: boolean;
  eyebrow: string;
  title: string;
  intro: string;
  outcomes: string[];
  icon: string;
  accent: string;
  optional: boolean;
  labs: Entry[];
  totals: Totals;
}
interface Path {
  slug: string;
  known: boolean;
  other: boolean;
  title: string;
  intro: string;
  icon: string;
  accent: string;
  cards: boolean;
  modules: Module[];
  labs: Entry[];
  totals: Totals;
}
interface Model {
  paths: Path[];
  totals: Totals;
}
const model = (await import('../../dashboard/src/launcher-model.js' as string)) as {
  buildLauncherModel: (labs: Lab[], meta: unknown, opts?: { passed?: Set<string> }) => Model;
  minutesLabel: (n: unknown) => string;
  approxMinutes: (n: unknown) => string;
  summaryLine: (t: Totals) => string;
  moduleMetaLine: (t: Totals) => string;
  humanize: (s: string) => string;
  ACCENTS: string[];
  ICONS: Record<string, string>;
};
const { buildLauncherModel, minutesLabel, approxMinutes, summaryLine, moduleMetaLine, humanize } = model;

const lab = (slug: string, over: Partial<Lab> = {}): Lab => ({ slug, title: `Title of ${slug}`, estimated_minutes: 30, ...over });
const slugs = (entries: Entry[]) => entries.map((e) => e.lab.slug);

/** Metadata in the shape of packages/catalogue/paths.json. */
const meta = {
  paths: [
    { slug: 'agents', title: 'Agents', accent: 'blue', icon: 'bolt', intro: 'About agents.', modules: [] },
    {
      slug: 'platform',
      title: 'Platform',
      accent: 'violet',
      icon: 'layers',
      intro: 'About the platform.',
      modules: [
        { number: 1, title: 'Gateway', accent: 'teal', icon: 'route', intro: 'One door.', outcomes: ['a', 'b'] },
        { number: 2, title: 'Tools', accent: 'amber', icon: 'plug', intro: 'Tools.', outcomes: ['c', 'd'], optional: true },
      ],
    },
  ],
};

describe('buildLauncherModel: order', () => {
  const labs = [
    lab('p2-b', { path: 'platform', module: 2, order: 2 }),
    lab('a2', { path: 'agents', order: 2 }),
    lab('loose-z'),
    lab('p1-b', { path: 'platform', module: 1, order: 2 }),
    lab('p2-a', { path: 'platform', module: 2, order: 1 }),
    lab('a1', { path: 'agents', order: 1 }),
    lab('p1-a', { path: 'platform', module: 1, order: 1 }),
    lab('loose-a'),
  ];

  it('lists paths in the metadata order, not alphabetically, and puts labs with no path last', () => {
    const m = buildLauncherModel(labs, meta);
    expect(m.paths.map((p) => p.slug)).toEqual(['agents', 'platform', '']);
    expect(m.paths[2]!.other).toBe(true);
    expect(m.paths[2]!.title).toBe('Other labs');
  });

  it('orders modules by number and labs by order, then slug, and numbers each lab within its module', () => {
    const m = buildLauncherModel(labs, meta);
    const platform = m.paths[1]!;
    expect(platform.modules.map((x) => x.number)).toEqual([1, 2]);
    expect(slugs(platform.modules[0]!.labs)).toEqual(['p1-a', 'p1-b']);
    expect(slugs(platform.modules[1]!.labs)).toEqual(['p2-a', 'p2-b']);
    expect(platform.modules[1]!.labs.map((e) => e.index)).toEqual([1, 2]);
    expect(slugs(platform.labs)).toEqual(['p1-a', 'p1-b', 'p2-a', 'p2-b']);
    expect(slugs(m.paths[2]!.labs)).toEqual(['loose-a', 'loose-z']);
  });

  it('breaks a tie on order by slug and sorts labs with no order last', () => {
    const m = buildLauncherModel(
      [lab('z', { path: 'agents', order: 1 }), lab('b', { path: 'agents' }), lab('a', { path: 'agents', order: 1 }), lab('c', { path: 'agents' })],
      meta,
    );
    expect(slugs(m.paths[0]!.labs)).toEqual(['a', 'z', 'b', 'c']);
  });

  it('does not depend on the order the labs arrive in', () => {
    const a = buildLauncherModel(labs, meta);
    const b = buildLauncherModel([...labs].reverse(), meta);
    expect(b.paths.map((p) => slugs(p.labs))).toEqual(a.paths.map((p) => slugs(p.labs)));
  });

  it('calls the leftover group "All labs" when nothing has a path', () => {
    const m = buildLauncherModel([lab('x'), lab('y')], meta);
    expect(m.paths).toHaveLength(1);
    expect(m.paths[0]!.title).toBe('All labs');
    expect(m.paths[0]!.cards).toBe(false);
  });

  it('gives an empty catalogue no paths and no totals', () => {
    const m = buildLauncherModel([], meta);
    expect(m.paths).toEqual([]);
    expect(m.totals).toEqual({ labs: 0, done: 0, minutes: 0, free: 0 });
  });
});

describe('buildLauncherModel: metadata', () => {
  it('carries the title, intro, icon and accent of a path and a module', () => {
    const m = buildLauncherModel([lab('p1', { path: 'platform', module: 1 })], meta);
    const p = m.paths[0]!;
    expect(p).toMatchObject({ title: 'Platform', intro: 'About the platform.', icon: 'layers', accent: 'violet', known: true, cards: true });
    expect(p.modules[0]).toMatchObject({ number: 1, eyebrow: 'Module 1', title: 'Gateway', intro: 'One door.', outcomes: ['a', 'b'], icon: 'route', accent: 'teal', optional: false, known: true });
  });

  it('flags an optional module and leaves the others alone', () => {
    const m = buildLauncherModel([lab('p1', { path: 'platform', module: 1 }), lab('p2', { path: 'platform', module: 2 })], meta);
    expect(m.paths[0]!.modules.map((x) => x.optional)).toEqual([false, true]);
  });

  it('drops a module the metadata describes but no lab uses', () => {
    const m = buildLauncherModel([lab('p2', { path: 'platform', module: 2 })], meta);
    expect(m.paths[0]!.modules.map((x) => x.number)).toEqual([2]);
    expect(m.paths[0]!.cards).toBe(true);
  });

  it('falls back to a humanised slug and no intro for a path the metadata does not know', () => {
    const m = buildLauncherModel([lab('x', { path: 'agent-foundations' })], meta);
    expect(m.paths[0]).toMatchObject({ slug: 'agent-foundations', title: 'Agent foundations', intro: '', icon: '', accent: 'slate', known: false });
  });

  it('puts unknown paths after the known ones, by slug, and before the labs with no path', () => {
    const m = buildLauncherModel([lab('l'), lab('z', { path: 'zzz' }), lab('a', { path: 'aaa' }), lab('p', { path: 'platform' })], meta);
    expect(m.paths.map((p) => p.slug)).toEqual(['platform', 'aaa', 'zzz', '']);
  });

  it('falls back to "Module N" and no outcomes for a module the metadata does not know', () => {
    const m = buildLauncherModel([lab('a', { path: 'platform', module: 1 }), lab('b', { path: 'platform', module: 9 })], meta);
    const nine = m.paths[0]!.modules[1]!;
    expect(nine).toMatchObject({ number: 9, known: false, title: 'Module 9', intro: '', outcomes: [], icon: '', accent: 'slate', optional: false });
  });

  it('shows module cards for an unknown path only when its labs span several modules', () => {
    expect(buildLauncherModel([lab('a', { path: 'new', module: 1 })], meta).paths[0]!.cards).toBe(false);
    const two = buildLauncherModel([lab('a', { path: 'new', module: 1 }), lab('b', { path: 'new', module: 2 })], meta);
    expect(two.paths[0]!.cards).toBe(true);
    expect(two.paths[0]!.modules.map((x) => x.title)).toEqual(['Module 1', 'Module 2']);
  });

  it('never throws for missing, empty or malformed metadata', () => {
    const labs = [lab('a', { path: 'agents' }), lab('b', { path: 'platform', module: 3 }), lab('c')];
    for (const bad of [undefined, null, {}, { paths: null }, { paths: [] }, { paths: [null, 3, {}] }, { paths: [{ slug: 'agents', accent: 'puce', icon: 7, modules: 'nope' }] }, 'text']) {
      const m = buildLauncherModel(labs, bad);
      expect(m.paths.map((p) => p.slug)).toEqual(['agents', 'platform', '']);
      expect(m.totals.labs).toBe(3);
    }
    // Accent outside the design's set falls back to slate.
    expect(buildLauncherModel(labs, { paths: [{ slug: 'agents', accent: 'puce' }] }).paths[0]!.accent).toBe('slate');
  });

  it('never throws for odd labs (no slug, no fields)', () => {
    const m = buildLauncherModel([null, undefined, {}, 4, lab('ok', { path: 'agents' })] as unknown as Lab[], meta);
    expect(m.totals.labs).toBe(1);
    expect(buildLauncherModel(undefined as unknown as Lab[], meta).paths).toEqual([]);
  });
});

describe('buildLauncherModel: single-module paths', () => {
  it('has no module cards for a path whose metadata lists no modules, whatever its labs say', () => {
    const m = buildLauncherModel([lab('a', { path: 'agents', order: 1 }), lab('b', { path: 'agents', order: 2 })], meta);
    const p = m.paths[0]!;
    expect(p.cards).toBe(false);
    expect(p.modules).toHaveLength(1);
    expect(slugs(p.modules[0]!.labs)).toEqual(['a', 'b']);
  });

  it('treats a lab with no module number as module 1', () => {
    const m = buildLauncherModel([lab('a', { path: 'platform' }), lab('b', { path: 'platform', module: 1 })], meta);
    expect(m.paths[0]!.modules.map((x) => x.number)).toEqual([1]);
    expect(m.paths[0]!.modules[0]!.labs).toHaveLength(2);
  });
});

describe('buildLauncherModel: totals', () => {
  const labs = [
    lab('a1', { path: 'agents', order: 1, tier: 'free', estimated_minutes: 35 }),
    lab('a2', { path: 'agents', order: 2, tier: 'free', estimated_minutes: 45 }),
    lab('a3', { path: 'agents', order: 3, tier: 'pro', estimated_minutes: 40 }),
    lab('p1', { path: 'platform', module: 1, order: 1, tier: 'free', estimated_minutes: 15 }),
    lab('p2', { path: 'platform', module: 1, order: 2, estimated_minutes: 75 }),
    lab('q1', { path: 'platform', module: 2, order: 1, estimated_minutes: 60 }),
    lab('o1', { estimated_minutes: 20 }),
  ];
  const passed = new Set(['a1', 'p2', 'o1']);

  it('sums labs, done, minutes and free per module, per path and overall', () => {
    const m = buildLauncherModel(labs, meta, { passed });
    expect(m.paths[0]!.totals).toEqual({ labs: 3, done: 1, minutes: 120, free: 2 });
    const platform = m.paths[1]!;
    expect(platform.modules[0]!.totals).toEqual({ labs: 2, done: 1, minutes: 90, free: 1 });
    expect(platform.modules[1]!.totals).toEqual({ labs: 1, done: 0, minutes: 60, free: 0 });
    expect(platform.totals).toEqual({ labs: 3, done: 1, minutes: 150, free: 1 });
    expect(m.paths[2]!.totals).toEqual({ labs: 1, done: 1, minutes: 20, free: 0 });
    expect(m.totals).toEqual({ labs: 7, done: 3, minutes: 290, free: 3 });
  });

  it('reads "done" from the progress on the labs when no passed set is given', () => {
    const withProgress = labs.map((l) => (l.slug === 'a2' ? { ...l, progress: { attempts: 3, best_score: 1, passed_all: true } } : l));
    const m = buildLauncherModel(withProgress, meta);
    expect(m.paths[0]!.totals.done).toBe(1);
    expect(m.paths[0]!.labs.map((e) => e.status)).toEqual(['todo', 'done', 'todo']);
  });

  it('counts a lab with no estimate as zero minutes rather than NaN', () => {
    const m = buildLauncherModel([lab('a', { path: 'agents', estimated_minutes: undefined }), lab('b', { path: 'agents', estimated_minutes: 20 }), lab('c', { path: 'agents', estimated_minutes: 'x' as unknown as number })], meta);
    expect(m.paths[0]!.totals.minutes).toBe(20);
    expect(m.paths[0]!.labs.map((e) => e.minutes)).toEqual([0, 20, 0]);
  });

  it('marks a lab that was attempted but not passed as started', () => {
    const m = buildLauncherModel([lab('a', { path: 'agents', progress: { attempts: 2, best_score: 0.4, passed_all: false } })], meta);
    expect(m.paths[0]!.labs[0]!.status).toBe('started');
  });

  it('marks free labs from the tier', () => {
    const m = buildLauncherModel(labs, meta, { passed });
    expect(m.paths[0]!.labs.map((e) => e.free)).toEqual([true, true, false]);
  });
});

describe('buildLauncherModel: locks', () => {
  const labs = [
    lab('first', { path: 'agents', order: 1, title: 'First lab' }),
    lab('second', { path: 'agents', order: 2, prerequisites: ['first'] }),
    lab('third', { path: 'agents', order: 3, prerequisites: ['first', 'second'] }),
    lab('ghost', { path: 'agents', order: 4, prerequisites: ['not-in-the-catalogue'] }),
  ];

  it('locks a lab whose prerequisite has not been passed and names it by title', () => {
    const m = buildLauncherModel(labs, meta, { passed: new Set() });
    const [first, second, third, ghost] = m.paths[0]!.labs as [Entry, Entry, Entry, Entry];
    expect(first).toMatchObject({ locked: false, lockedBy: null, lockedByTitle: null });
    expect(second).toMatchObject({ locked: true, lockedBy: 'first', lockedByTitle: 'First lab' });
    expect(third).toMatchObject({ locked: true, lockedBy: 'first' });
    // A prerequisite the catalogue does not list counts as unmet; the slug stands in for its title.
    expect(ghost).toMatchObject({ locked: true, lockedBy: 'not-in-the-catalogue', lockedByTitle: 'not-in-the-catalogue' });
  });

  it('reports the first unmet prerequisite and unlocks once every one is passed', () => {
    const one = buildLauncherModel(labs, meta, { passed: new Set(['first']) }).paths[0]!.labs;
    expect(one[1]).toMatchObject({ locked: false });
    expect(one[2]).toMatchObject({ locked: true, lockedBy: 'second', lockedByTitle: 'Title of second' });
    const both = buildLauncherModel(labs, meta, { passed: new Set(['first', 'second']) }).paths[0]!.labs;
    expect(both[2]).toMatchObject({ locked: false, lockedBy: null });
  });

  it('resolves a prerequisite that sits in another path or module', () => {
    const m = buildLauncherModel(
      [lab('base', { path: 'agents', title: 'The base' }), lab('later', { path: 'platform', module: 2, prerequisites: ['base'] })],
      meta,
      { passed: new Set() },
    );
    expect(m.paths[1]!.labs[0]).toMatchObject({ locked: true, lockedByTitle: 'The base' });
  });
});

describe('minutesLabel', () => {
  it('reads minutes under an hour as minutes', () => {
    expect(minutesLabel(5)).toBe('5 min');
    expect(minutesLabel(45)).toBe('45 min');
    expect(minutesLabel(59)).toBe('59 min');
  });

  it('reads whole hours as hours and the rest as hours and minutes', () => {
    expect(minutesLabel(60)).toBe('1 h');
    expect(minutesLabel(130)).toBe('2 h 10 min');
    expect(minutesLabel(180)).toBe('3 h');
    expect(minutesLabel(1230)).toBe('20 h 30 min');
  });

  it('rounds fractions and says "0 min" for anything that is not a positive number', () => {
    expect(minutesLabel(44.6)).toBe('45 min');
    for (const bad of [0, -5, NaN, undefined, null, 'abc', Infinity]) expect(minutesLabel(bad)).toBe('0 min');
  });
});

describe('approxMinutes and the summary lines', () => {
  it('rounds to five minutes under two hours, the half hour under ten, the hour above', () => {
    expect(approxMinutes(35)).toBe('35 min');
    expect(approxMinutes(43)).toBe('45 min');
    expect(approxMinutes(90)).toBe('1 h 30 min');
    expect(approxMinutes(310)).toBe('5 h');
    expect(approxMinutes(325)).toBe('5.5 h');
    expect(approxMinutes(1230)).toBe('21 h');
    expect(approxMinutes(0)).toBe('');
    expect(approxMinutes(NaN)).toBe('');
  });

  it('prints the path line the design asks for, leaving out what is zero', () => {
    // How far along the learner is has its own line ("3 of 31 labs done"), so the totals line holds only what the path is.
    expect(summaryLine({ labs: 31, done: 3, minutes: 1230, free: 2 })).toBe('31 labs · About 21 h · 2 free');
    expect(summaryLine({ labs: 1, done: 0, minutes: 0, free: 0 })).toBe('1 lab');
  });

  it('prints the module line', () => {
    expect(moduleMetaLine({ labs: 5, done: 2, minutes: 125, free: 1 })).toBe('5 labs · About 2 h · 1 free');
    expect(moduleMetaLine({ labs: 1, done: 0, minutes: 60, free: 0 })).toBe('1 lab · About 1 h');
  });
});

describe('humanize', () => {
  it('turns a slug into a sentence-case label', () => {
    expect(humanize('agent-foundations')).toBe('Agent foundations');
    expect(humanize('a_b--c')).toBe('A b c');
    expect(humanize('')).toBe('');
  });
});

describe('the real catalogue', () => {
  function placed(): Lab[] {
    const root = join(__dirname, '..', '..', 'labs');
    const out: Lab[] = [];
    for (const slug of readdirSync(root)) {
      const file = join(root, slug, 'manifest.yaml');
      if (!existsSync(file)) continue;
      const m = parse(readFileSync(file, 'utf8')) as Lab & { title: string };
      out.push({ ...m, slug });
    }
    return out;
  }

  it('groups every published lab under a described path and module, and every icon and accent has a glyph and a token', () => {
    const labs = placed();
    const m = buildLauncherModel(labs, realMeta);
    // Paths in the order of paths.json, none of them a fallback.
    expect(m.paths.filter((p) => !p.other).map((p) => p.slug)).toEqual(realMeta.paths.map((p) => p.slug));
    for (const p of m.paths) {
      if (p.other) continue;
      expect(p.known, p.slug).toBe(true);
      expect(model.ICONS[p.icon], `${p.slug} icon "${p.icon}"`).toBeTruthy();
      expect(model.ACCENTS, `${p.slug} accent`).toContain(p.accent);
      for (const mod of p.modules) {
        if (p.cards) {
          expect(mod.known, `${p.slug}#${mod.number}`).toBe(true);
          expect(model.ICONS[mod.icon], `${p.slug}#${mod.number} icon "${mod.icon}"`).toBeTruthy();
          expect(model.ACCENTS).toContain(mod.accent);
        }
      }
    }
    // Every lab that names a path is somewhere on the page, exactly once.
    const placedSlugs = m.paths.flatMap((p) => slugs(p.labs));
    expect(new Set(placedSlugs).size).toBe(placedSlugs.length);
    expect(placedSlugs.length).toBe(labs.length);
    // Every lab in labs/ is placed, so the catalogue has no "Other labs" group.
    expect(m.paths.some((p) => p.other)).toBe(labs.some((l) => !l.path));
  });

  it('has module cards only for the platform path', () => {
    const m = buildLauncherModel(placed(), realMeta);
    expect(m.paths.filter((p) => p.cards).map((p) => p.slug)).toEqual(['ai-platform']);
    expect(m.paths.find((p) => p.slug === 'ai-platform')!.modules.map((x) => x.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('carries the metadata copy through untouched', () => {
    const m = buildLauncherModel(placed(), realMeta);
    for (const p of realMeta.paths) {
      const built = m.paths.find((x) => x.slug === p.slug)!;
      expect(built.title).toBe(p.title);
      expect(built.intro).toBe(p.intro);
      for (const mod of p.modules) {
        const bm = built.modules.find((x) => x.number === mod.number)!;
        expect(bm.outcomes).toEqual(mod.outcomes);
        expect(bm.optional).toBe(Boolean((mod as { optional?: boolean }).optional));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The hero, the running lab's place, and which modules open.

const extra = (await import('../../dashboard/src/launcher-model.js' as string)) as {
  heroLede: (count: unknown) => string;
  locateLab: (model: Model, slug: string) => { path: Path; module: Module; entry: Entry; position: number; total: number } | null;
  moreLabsComing: (path: Path) => boolean;
  siblingModules: (path: Path, module: Module) => { prev: Module | null; next: Module | null };
  isPlanLocked: (lab: unknown) => boolean;
};

describe('heroLede', () => {
  it('counts the paths in words and says nothing about what to do first', () => {
    expect(extra.heroLede(4)).toBe('Four paths, each a run of hands-on labs.');
    expect(extra.heroLede(2)).toMatch(/^Two paths, each a run of hands-on labs\./);
    expect(extra.heroLede(11)).toMatch(/^11 paths, each/);
  });
  it('copes with one path and with none', () => {
    expect(extra.heroLede(1)).toBe('One path, a run of hands-on labs.');
    for (const n of [0, -1, NaN, undefined, 'x']) expect(extra.heroLede(n)).toBe('Each path is a run of hands-on labs.');
  });
});

describe('locateLab', () => {
  const labs = [
    lab('a1', { path: 'agents', order: 1 }),
    lab('p1-a', { path: 'platform', module: 1, order: 1 }),
    lab('p1-b', { path: 'platform', module: 1, order: 2 }),
    lab('p2-a', { path: 'platform', module: 2, order: 1 }),
    lab('loose'),
  ];
  const m = buildLauncherModel(labs, meta);
  it('says which module a lab is in, where, and out of how many', () => {
    const at = extra.locateLab(m, 'p1-b')!;
    expect(at.path.slug).toBe('platform');
    expect(at.module.number).toBe(1);
    expect(at.position).toBe(2);
    expect(at.total).toBe(2);
    expect(at.entry.lab.slug).toBe('p1-b');
    expect(extra.locateLab(m, 'p2-a')!.position).toBe(1);
    expect(extra.locateLab(m, 'loose')!.path.other).toBe(true);
  });
  it('is null for a lab the catalogue does not have', () => {
    expect(extra.locateLab(m, 'nope')).toBeNull();
    expect(extra.locateLab(null as unknown as Model, 'a1')).toBeNull();
  });
});

describe('moreLabsComing', () => {
  const pathOf = (labs: Lab[], slug: string) => buildLauncherModel(labs, meta).paths.find((p) => p.slug === slug)!;
  it('is true for a path with no modules and two labs or fewer', () => {
    expect(extra.moreLabsComing(pathOf([lab('x', { path: 'agents' })], 'agents'))).toBe(true);
    expect(extra.moreLabsComing(pathOf([lab('x', { path: 'agents' }), lab('y', { path: 'agents' })], 'agents'))).toBe(true);
  });
  it('is false once the path has three labs, has module cards, or is the Other labs group', () => {
    expect(extra.moreLabsComing(pathOf(['x', 'y', 'z'].map((s) => lab(s, { path: 'agents' })), 'agents'))).toBe(false);
    expect(extra.moreLabsComing(pathOf([lab('x', { path: 'platform', module: 1 })], 'platform'))).toBe(false);
    expect(extra.moreLabsComing(buildLauncherModel([lab('loose')], meta).paths.find((p) => p.other)!)).toBe(false);
  });
});

describe('siblingModules', () => {
  const platform = buildLauncherModel(
    [1, 2, 3].map((n) => lab(`m${n}`, { path: 'platform', module: n, order: 1 })),
    meta,
  ).paths.find((p) => p.slug === 'platform')!;
  it('names the module before and the one after, and none past either end', () => {
    const [one, two, three] = platform.modules as [Module, Module, Module];
    expect(extra.siblingModules(platform, two)).toEqual({ prev: one, next: three });
    expect(extra.siblingModules(platform, one)).toEqual({ prev: null, next: two });
    expect(extra.siblingModules(platform, three)).toEqual({ prev: two, next: null });
  });
  it('has none for a path without module cards, or a module that is not in it', () => {
    const flat = buildLauncherModel([lab('x', { path: 'agents' })], meta).paths.find((p) => p.slug === 'agents')!;
    expect(extra.siblingModules(flat, flat.modules[0]!)).toEqual({ prev: null, next: null });
    expect(extra.siblingModules(platform, { number: 9 } as Module)).toEqual({ prev: null, next: null });
  });
});

describe('plan locks', () => {
  it('a Pro lab on the free plan is locked, unless the subject bypasses the plan', () => {
    expect(extra.isPlanLocked({ tier: 'pro', plan: 'free' })).toBe(true);
    expect(extra.isPlanLocked({ tier: 'pro', plan: 'free', bypass: true })).toBe(false);
    expect(extra.isPlanLocked({ tier: 'pro', plan: 'pro' })).toBe(false);
    expect(extra.isPlanLocked({ tier: 'free', plan: 'free' })).toBe(false);
  });
  it('is not locked when the catalogue did not say which plan this is', () => {
    expect(extra.isPlanLocked({ tier: 'pro' })).toBe(false);
    expect(extra.isPlanLocked(null)).toBe(false);
  });
  it('puts the lock on the lab\'s entry, apart from a lock behind another lab', () => {
    const m = buildLauncherModel(
      [lab('free-one', { path: 'agents', order: 1, tier: 'free', plan: 'free' }), lab('pro-one', { path: 'agents', order: 2, tier: 'pro', plan: 'free' }), lab('pro-admin', { path: 'agents', order: 3, tier: 'pro', plan: 'free', bypass: true })],
      meta,
      { passed: new Set() },
    );
    expect(m.paths[0]!.labs.map((e) => [e.lab.slug, e.planLocked, e.locked])).toEqual([
      ['free-one', false, false],
      ['pro-one', true, false],
      ['pro-admin', false, false],
    ]);
  });
});

const learner = (await import('../../dashboard/src/launcher-model.js' as string)) as {
  isArchived: (lab: unknown) => boolean;
  visibleLabs: (labs: unknown) => Lab[];
};
const learnModel = (await import('../../dashboard/src/learn-model.js' as string)) as {
  suggestStart: (next: unknown, labs?: unknown[]) => { path: string; number: number } | null;
};
describe('archived labs', () => {
  const arch = (slug: string, over: Partial<Lab> = {}): Lab => ({ ...lab(slug, over), archived: true });

  const catalogue = [
    lab('a1', { path: 'agents', order: 1 }),
    lab('p1-a', { path: 'platform', module: 1, order: 1, tier: 'free', progress: { attempts: 1, best_score: 1, passed_all: true } }),
    lab('p1-b', { path: 'platform', module: 1, order: 2, prerequisites: ['fx-hidden'] }),
    arch('p1-hidden', { path: 'platform', module: 1, order: 3 }),
    arch('p2-hidden', { path: 'platform', module: 2, order: 1 }),
    arch('fixture-agents', { path: 'agents', order: 2 }),
    arch('hello'),
    arch('impatient'),
    arch('fx-hidden'),
  ];

  it('knows an archived lab and leaves the others, whatever they hold', () => {
    expect(learner.isArchived({ slug: 'x', archived: true })).toBe(true);
    expect(learner.isArchived({ slug: 'x', archived: false })).toBe(false);
    expect(learner.isArchived({ slug: 'x' })).toBe(false);
    expect(learner.isArchived(null)).toBe(false);
    expect(learner.visibleLabs(catalogue).map((l) => l.slug)).toEqual(['a1', 'p1-a', 'p1-b']);
    expect(learner.visibleLabs(undefined)).toEqual([]);
  });

  it('leaves archived labs out of every group, and the "Other labs" group disappears when only they have no path', () => {
    const m = buildLauncherModel(catalogue, meta);
    expect(m.paths.map((p) => p.slug)).toEqual(['agents', 'platform']);
    expect(m.paths.some((p) => p.other)).toBe(false);
    expect(slugs(m.paths[0]!.labs)).toEqual(['a1']);
    expect(slugs(m.paths[1]!.labs)).toEqual(['p1-a', 'p1-b']);
    const everyShown = m.paths.flatMap((p) => p.modules.flatMap((x) => slugs(x.labs)));
    expect(everyShown.sort()).toEqual(['a1', 'p1-a', 'p1-b']);
  });

  it('drops a module whose labs are all archived, and a path that only archived labs belong to', () => {
    const m = buildLauncherModel(catalogue, meta);
    expect(m.paths[1]!.modules.map((x) => x.number)).toEqual([1]);
    const onlyHidden = buildLauncherModel([lab('keep', { path: 'platform', module: 1 }), arch('gone', { path: 'agents' })], meta);
    expect(onlyHidden.paths.map((p) => p.slug)).toEqual(['platform']);
  });

  it('counts only what a learner sees, per module, per path and overall', () => {
    const m = buildLauncherModel(catalogue, meta);
    expect(m.paths[0]!.totals).toEqual({ labs: 1, done: 0, minutes: 30, free: 0 });
    expect(m.paths[1]!.totals).toEqual({ labs: 2, done: 1, minutes: 60, free: 1 });
    expect(m.paths[1]!.modules[0]!.totals.labs).toBe(2);
    expect(m.totals).toEqual({ labs: 3, done: 1, minutes: 90, free: 1 });
  });

  it('still names an archived prerequisite by title, and counts it passed when it was', () => {
    const m = buildLauncherModel(catalogue, meta);
    const b = m.paths[1]!.modules[0]!.labs.find((e) => e.lab.slug === 'p1-b')!;
    expect(b.locked).toBe(true);
    expect(b.lockedBy).toBe('fx-hidden');
    expect(b.lockedByTitle).toBe('Title of fx-hidden');
    const passed = buildLauncherModel(catalogue, meta, { passed: new Set(['p1-a', 'fx-hidden']) });
    expect(passed.paths[1]!.modules[0]!.labs.find((e) => e.lab.slug === 'p1-b')!.locked).toBe(false);
  });

  it('keeps a real lab with no path in "Other labs"', () => {
    const m = buildLauncherModel([...catalogue, lab('loose')], meta);
    expect(m.paths.map((p) => p.slug)).toEqual(['agents', 'platform', '']);
    expect(m.paths[2]!.other).toBe(true);
    expect(slugs(m.paths[2]!.labs)).toEqual(['loose']);
    expect(m.totals.labs).toBe(4);
  });

  it('gives a catalogue of only archived labs an empty launcher', () => {
    const m = buildLauncherModel([arch('hello'), arch('impatient')], meta);
    expect(m.paths).toEqual([]);
    expect(m.totals).toEqual({ labs: 0, done: 0, minutes: 0, free: 0 });
  });

  it('does not place an archived lab in the launcher, while the full list still resolves it by slug', () => {
    const m = buildLauncherModel(catalogue, meta);
    expect(extra.locateLab(m, 'hello')).toBeNull();
    expect(extra.locateLab(m, 'p1-hidden')).toBeNull();
    expect(extra.locateLab(m, 'p1-a')).not.toBeNull();
    // What app.js does: a deep link looks the slug up in the whole catalogue, never in the model.
    const bySlug = new Map(catalogue.map((l) => [l.slug, l]));
    expect(bySlug.get('hello')?.title).toBe('Title of hello');
    expect(bySlug.get('p1-hidden')).toBeDefined();
    expect(bySlug.get('nope')).toBeUndefined();
  });

  it('never suggests a module that only archived labs would fill', () => {
    const labs = [
      lab('g1', { path: 'ai-platform', module: 1, order: 1, progress: { attempts: 1, best_score: 1, passed_all: true } }),
      arch('rag-only-archived', { path: 'ai-platform', module: 3, order: 1 }),
      lab('o1', { path: 'ai-platform', module: 4, order: 1 }),
    ];
    const cardsOf = (m: Model) => m.paths.flatMap((p) => (p.cards ? p.modules.map((x) => ({ path: p.slug, number: x.number as number })) : []));
    const cards = cardsOf(buildLauncherModel(labs, realMeta));
    expect(cards.map((c) => c.number)).toEqual([1, 4]);
    // Until the profile answers, the console's copy of the catalogue rule finds the next lab: archived ones never count.
    expect(learnModel.suggestStart(undefined, labs)).toEqual({ path: 'ai-platform', number: 4 });

    // The same catalogue with nothing archived would have suggested module 3: the filter is what moves it.
    const unarchived = labs.map((l) => ({ ...l, archived: false }));
    expect(learnModel.suggestStart(undefined, unarchived)).toEqual({ path: 'ai-platform', number: 3 });
  });
});

const pages = (await import('../../dashboard/src/launcher-model.js' as string)) as {
  pathId: (p: Path) => string;
  findPath: (m: Model, id: string) => Path | null;
  findModule: (p: Path | null, n: number) => Module | null;
  moduleLabel: (m: Module) => string;
  pathCardLine: (p: Path) => string;
  breadcrumbs: (m: Model, route: Record<string, unknown>, lab?: Lab | null) => Array<{ label: string; route: Record<string, unknown> | null }>;
  scopeEntries: (m: Model, route: Record<string, unknown>) => Entry[];
};

describe('the pages: paths, modules, trail and scope', () => {
  const labs = [
    lab('a1', { path: 'agents', order: 1, estimated_minutes: 60 }),
    lab('a2', { path: 'agents', order: 2, estimated_minutes: 60 }),
    lab('p1-a', { path: 'platform', module: 1, order: 1 }),
    lab('p1-b', { path: 'platform', module: 1, order: 2 }),
    lab('p2-a', { path: 'platform', module: 2, order: 1 }),
    lab('loose'),
    lab('hello', { archived: true }),
  ];
  const m = buildLauncherModel(labs, meta);

  it('names a path by its slug in an address, and the labs with no path "other"', () => {
    expect(pages.pathId(m.paths[0]!)).toBe('agents');
    expect(pages.findPath(m, 'platform')!.title).toBe('Platform');
    expect(pages.findPath(m, 'other')!.other).toBe(true);
    expect(pages.findPath(m, 'nope')).toBeNull();
    expect(pages.findPath(null as unknown as Model, 'agents')).toBeNull();
  });

  it('finds a module only on a path that draws module cards', () => {
    const platform = pages.findPath(m, 'platform')!;
    expect(pages.findModule(platform, 2)!.title).toBe('Tools');
    expect(pages.findModule(platform, 3)).toBeNull();
    // `agents` has one implicit module and "other" none with a number: neither has a module to address.
    expect(pages.findModule(pages.findPath(m, 'agents'), 1)).toBeNull();
    expect(pages.findModule(pages.findPath(m, 'other'), 1)).toBeNull();
    expect(pages.findModule(null, 1)).toBeNull();
  });

  it('labels a module with its number and, when the metadata has one, its title', () => {
    const platform = pages.findPath(m, 'platform')!;
    expect(pages.moduleLabel(platform.modules[0]!)).toBe('Module 1: Gateway');
    expect(pages.moduleLabel({ ...platform.modules[0]!, known: false, title: 'Module 1' })).toBe('Module 1');
  });

  it('prints a path card line: modules, labs and about how long, leaving out what is zero', () => {
    expect(pages.pathCardLine(pages.findPath(m, 'platform')!)).toBe('2 modules · 3 labs · About 1 h 30 min');
    expect(pages.pathCardLine(pages.findPath(m, 'agents')!)).toBe('2 labs · About 2 h');
    const one = buildLauncherModel([lab('x', { path: 'platform', module: 1, estimated_minutes: 0 })], meta).paths[0]!;
    expect(pages.pathCardLine(one)).toBe('1 module · 1 lab');
  });

  it('builds the trail Home > Path > Module > Lab, the page itself last and not a link', () => {
    const labels = (route: Record<string, unknown>, l: Lab | null = null) => pages.breadcrumbs(m, route, l).map((c) => c.label);
    expect(labels({ name: 'launcher' })).toEqual(['Home']);
    expect(labels({ name: 'path', path: 'platform' })).toEqual(['Home', 'Platform']);
    expect(labels({ name: 'module', path: 'platform', module: 2 })).toEqual(['Home', 'Platform', 'Module 2: Tools']);
    expect(labels({ name: 'lab', slug: 'p2-a' }, labs[4]!)).toEqual(['Home', 'Platform', 'Module 2: Tools', 'Title of p2-a']);
    // A path with no module cards has no module in the trail; "other" is still a path of the trail.
    expect(labels({ name: 'lab', slug: 'a1' }, labs[0]!)).toEqual(['Home', 'Agents', 'Title of a1']);
    expect(labels({ name: 'lab', slug: 'loose' }, labs[5]!)).toEqual(['Home', 'Other labs', 'Title of loose']);
    // An archived lab is not in the model: Home > Lab.
    expect(labels({ name: 'lab', slug: 'hello' }, labs[6]!)).toEqual(['Home', 'Title of hello']);
    // Without a title it falls back to the slug; a path the catalogue does not know is humanised.
    expect(labels({ name: 'lab', slug: 'hello' })).toEqual(['Home', 'hello']);
    expect(labels({ name: 'path', path: 'new-things' })).toEqual(['Home', 'New things']);
  });

  it('links every crumb but the last to a route of the table', () => {
    const trail = pages.breadcrumbs(m, { name: 'lab', slug: 'p2-a' }, labs[4]!);
    expect(trail.map((c) => c.route)).toEqual([
      { name: 'launcher' },
      { name: 'path', path: 'platform' },
      { name: 'module', path: 'platform', module: 2 },
      null,
    ]);
    expect(pages.breadcrumbs(m, { name: 'launcher' })[0]!.route).toBeNull();
  });

  it('scopes search and filters to the labs of the page: all of them, a path\'s or a module\'s', () => {
    expect(slugs(pages.scopeEntries(m, { name: 'launcher' }))).toEqual(['a1', 'a2', 'p1-a', 'p1-b', 'p2-a', 'loose']);
    expect(slugs(pages.scopeEntries(m, { name: 'path', path: 'platform' }))).toEqual(['p1-a', 'p1-b', 'p2-a']);
    expect(slugs(pages.scopeEntries(m, { name: 'module', path: 'platform', module: 1 }))).toEqual(['p1-a', 'p1-b']);
    expect(pages.scopeEntries(m, { name: 'module', path: 'platform', module: 9 })).toEqual([]);
    // A lab's own page has none, and neither does a page the catalogue does not know.
    expect(pages.scopeEntries(m, { name: 'lab', slug: 'a1' })).toEqual([]);
    expect(pages.scopeEntries(m, { name: 'path', path: 'nope' })).toEqual([]);
  });
});
