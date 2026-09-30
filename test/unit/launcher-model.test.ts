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
  slug: string;
  title?: string;
  path?: string;
  module?: number;
  order?: number;
  tier?: string;
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
  skills: string[];
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
        { number: 1, title: 'Gateway', accent: 'teal', icon: 'route', intro: 'One door.', skills: ['a', 'b'] },
        { number: 2, title: 'Tools', accent: 'amber', icon: 'plug', intro: 'Tools.', skills: ['c', 'd'], optional: true },
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
    expect(p.modules[0]).toMatchObject({ number: 1, eyebrow: 'Module 1', title: 'Gateway', intro: 'One door.', skills: ['a', 'b'], icon: 'route', accent: 'teal', optional: false, known: true });
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

  it('falls back to "Module N" and no skills for a module the metadata does not know', () => {
    const m = buildLauncherModel([lab('a', { path: 'platform', module: 1 }), lab('b', { path: 'platform', module: 9 })], meta);
    const nine = m.paths[0]!.modules[1]!;
    expect(nine).toMatchObject({ number: 9, known: false, title: 'Module 9', intro: '', skills: [], icon: '', accent: 'slate', optional: false });
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
    expect(summaryLine({ labs: 31, done: 3, minutes: 1230, free: 2 })).toBe('31 labs · about 21 h · 2 free · 3 done');
    expect(summaryLine({ labs: 1, done: 0, minutes: 0, free: 0 })).toBe('1 lab · 0 done');
  });

  it('prints the module line', () => {
    expect(moduleMetaLine({ labs: 5, done: 2, minutes: 125, free: 1 })).toBe('5 labs · ~2 h · 1 free');
    expect(moduleMetaLine({ labs: 1, done: 0, minutes: 60, free: 0 })).toBe('1 lab · ~1 h');
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
        expect(bm.skills).toEqual(mod.skills);
        expect(bm.optional).toBe(Boolean((mod as { optional?: boolean }).optional));
      }
    }
  });
});
