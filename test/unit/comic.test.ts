import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComicSchema, checkComic, allPanels } from '../../src/labs/comic';
import { CAST, SCENES, PAGE, PAGE_W, layoutComic, panelSeconds, comicTranscript, comicPagesTranscript } from '../../src/labs/comic-kit';
import { compileLearnDir } from '../../cli/src/learn-compile';

const panel = (over: Record<string, unknown> = {}) => ({ scene: 'portrait', cast: ['maren'], bubbles: [{ who: 'maren', text: 'Hello there.' }], ...over });
/** wide, square, square, wide, square, wide: three rows that fill exactly */
const GOOD = {
  title: 'Which provider answered?',
  panels: [
    panel({ scene: 'desk', cast: ['jonas'], bubbles: [{ who: 'jonas', text: 'Which provider answered?' }], lines: ['$ $ $', '?'] }),
    panel({ scene: 'message', cast: ['maren'], sfx: 'PING!', prop: 'envelope', bubbles: [{ who: 'maren', text: 'Nobody can answer this.' }] }),
    panel({ scene: 'portrait', cast: ['maren'], bubbles: [{ who: 'maren', text: 'Tell me what it really does.' }] }),
    panel({ scene: 'screen', cast: [], bubbles: [], caption: 'A small copy of the system.', lines: ['$ python3 send_calls.py support', '200  deployment ?'] }),
    panel({ scene: 'duo', cast: ['maren', 'tomasz'], bubbles: [{ who: 'maren', text: 'Send it a few calls.' }] }),
    panel({ scene: 'you', cast: [], bubbles: [], caption: 'Your turn.', lines: ['$ gateway --start', 'ready.'] }),
  ],
};

describe('comic schema and checks', () => {
  it('accepts a complete comic and finds nothing to fix', () => {
    const c = ComicSchema.parse(GOOD);
    expect(checkComic(c)).toEqual([]);
    expect(c.pages).toHaveLength(1);
    expect(c.pages[0]!.panels[1]!.prop).toBe('envelope');
    expect(c.pages[0]!.panels[2]!.prop).toBe('none');
  });

  it('rejects markup, unknown scenes and unknown people', () => {
    expect(() => ComicSchema.parse({ ...GOOD, title: '<b>x</b>' })).toThrow();
    expect(() => ComicSchema.parse({ ...GOOD, panels: [...GOOD.panels.slice(0, 5), panel({ scene: 'rocket' })] })).toThrow();
    expect(() => ComicSchema.parse({ ...GOOD, panels: [...GOOD.panels.slice(0, 5), panel({ cast: ['nobody'] })] })).toThrow();
  });

  it('needs at least 4 panels in all, across any number of pages', () => {
    expect(checkComic(ComicSchema.parse({ ...GOOD, panels: GOOD.panels.slice(0, 3) })).join()).toMatch(/at least 4 panels/);
    expect(ComicSchema.parse({ title: 'T', pages: [{ panels: GOOD.panels.slice(0, 2) }, { panels: GOOD.panels.slice(2, 4) }] }).pages).toHaveLength(2);
  });

  it('accepts several pages with different panel counts and normalises a flat list to one page', () => {
    const multi = ComicSchema.parse({
      title: 'Two pages',
      pages: [
        { title: 'Monday', panels: GOOD.panels.slice(0, 5) },
        { panels: [GOOD.panels[5], GOOD.panels[1], GOOD.panels[2]] },
      ],
    });
    expect(multi.pages.map((p) => p.panels.length)).toEqual([5, 3]);
    expect(checkComic(multi)).toEqual([]);
    expect(allPanels(multi).map((p) => [p.page, p.indexInPage, p.number]).slice(4, 7)).toEqual([[1, 5, 5], [2, 1, 6], [2, 2, 7]]);
    const flat = ComicSchema.parse(GOOD);
    expect(flat.pages).toHaveLength(1);
    expect(flat.pages[0]!.panels).toHaveLength(6);
  });

  it('rejects both pages and panels, neither, too many pages and too many panels on a page', () => {
    expect(() => ComicSchema.parse({ title: 'T', pages: [{ panels: GOOD.panels }], panels: GOOD.panels })).toThrow(/either pages or panels/);
    expect(() => ComicSchema.parse({ title: 'T' })).toThrow(/needs pages/);
    expect(() => ComicSchema.parse({ title: 'T', pages: Array.from({ length: 7 }, () => ({ panels: GOOD.panels })) })).toThrow();
    expect(() => ComicSchema.parse({ title: 'T', pages: [{ panels: Array.from({ length: 10 }, () => GOOD.panels[1]) }] })).toThrow();
  });

  it('names the page in problems once there is more than one', () => {
    const c = ComicSchema.parse({ title: 'T', pages: [{ panels: GOOD.panels.slice(0, 3) }, { panels: [{ ...GOOD.panels[4], cast: ['maren'] }, GOOD.panels[1]] }] });
    expect(checkComic(c).join()).toMatch(/comic page 2 panel 1 \(duo\): needs 2 cast member/);
  });

  it('flags the wrong number of people, a speaker who is not there, and a silent panel', () => {
    const duoAlone = ComicSchema.parse({ ...GOOD, panels: GOOD.panels.map((p, i) => (i === 4 ? { ...p, cast: ['maren'] } : p)) });
    expect(checkComic(duoAlone).join()).toMatch(/needs 2 cast member/);
    const ghost = ComicSchema.parse({ ...GOOD, panels: GOOD.panels.map((p, i) => (i === 2 ? { ...p, bubbles: [{ who: 'tomasz', text: 'Hi.' }] } : p)) });
    expect(checkComic(ghost).join()).toMatch(/tomasz speaks but is not in the panel/);
    const silent = ComicSchema.parse({ ...GOOD, panels: GOOD.panels.map((p, i) => (i === 2 ? { ...p, bubbles: [] } : p)) });
    expect(checkComic(silent).join()).toMatch(/says nothing/);
  });

  it('requires lines for screen and you scenes', () => {
    const bare = ComicSchema.parse({ ...GOOD, panels: GOOD.panels.map((p, i) => (i === 3 ? { ...p, lines: undefined } : p)) });
    expect(checkComic(bare).join()).toMatch(/needs lines to show/);
  });

  it('flags too many spoken words', () => {
    const long = 'word '.repeat(60).trim();
    const c = ComicSchema.parse({ ...GOOD, panels: GOOD.panels.map((p) => ({ ...p, bubbles: [{ text: long.slice(0, 140) }, { text: long.slice(0, 140) }] })) });
    expect(checkComic(c).join()).toMatch(/spoken words/);
    const many = ComicSchema.parse({ title: 'T', pages: Array.from({ length: 6 }, () => ({ panels: [{ scene: 'portrait', cast: ['maren'], bubbles: [{ text: 'ab '.repeat(50).trim() }, { text: 'ab '.repeat(50).trim() }] }] })) });
    expect(checkComic(many).join()).toMatch(/in all/);
  });
});

describe('page layout', () => {
  it('places panels in reading order on a three-column page', () => {
    const { placements, rows, problems } = layoutComic(ComicSchema.parse(GOOD).pages[0]!.panels);
    expect(problems).toEqual([]);
    expect(rows).toBe(3);
    expect(placements.map((p) => [p.row, p.col, p.span])).toEqual([[0, 0, 2], [0, 2, 1], [1, 0, 1], [1, 1, 2], [2, 0, 1], [2, 1, 2]]);
    expect(placements[0]!.w).toBeCloseTo(2 * PAGE.colW + PAGE.gap, 1);
    expect(placements[1]!.x).toBeCloseTo(2 * (PAGE.colW + PAGE.gap), 1);
    expect(placements[3]!.y).toBeCloseTo(PAGE.rowH + PAGE.gap, 1);
  });

  it('works for any number of panels: a wide panel that does not fit starts a new row and short rows are centred', () => {
    const l = layoutComic([{ scene: 'message' }, { scene: 'duo' }, { scene: 'desk' }, { scene: 'desk' }, { scene: 'portrait' }]);
    expect(l.problems).toEqual([]);
    expect(l.placements.map((p) => [p.row, p.span])).toEqual([[0, 1], [0, 1], [1, 2], [2, 2], [2, 1]]);
    // row 0 holds two squares, centred on the page
    const a = l.placements[0]!;
    const b = l.placements[1]!;
    expect(a.x + (b.x + b.w - a.x) / 2).toBeCloseTo(PAGE_W / 2, 1);
    // row 1 is one wide panel, centred too
    expect(l.placements[2]!.x + l.placements[2]!.w / 2).toBeCloseTo(PAGE_W / 2, 1);
    // row 2 is full width: wide then square, starting at the left edge
    expect(l.placements[3]!.x).toBeCloseTo(0, 1);
    expect(l.height).toBeCloseTo(3 * PAGE.rowH + 2 * PAGE.gap, 1);
    expect(layoutComic([{ scene: 'you' }]).rows).toBe(1);
    expect(layoutComic(Array.from({ length: 9 }, () => ({ scene: 'message' as const }))).rows).toBe(3);
  });

  it('every scene has a span of 1 or 2', () => {
    for (const s of Object.values(SCENES)) expect([1, 2]).toContain(s.span);
  });

  it('gives a panel a few seconds, more for more words, never unbounded', () => {
    expect(panelSeconds(0)).toBeGreaterThanOrEqual(5);
    expect(panelSeconds(20)).toBeGreaterThan(panelSeconds(5));
    expect(panelSeconds(500)).toBeLessThanOrEqual(18);
  });
});

describe('transcript', () => {
  it('reads every panel as plain text with speaker names', () => {
    const t = comicTranscript(ComicSchema.parse(GOOD).pages[0]!.panels);
    expect(t).toHaveLength(6);
    expect(t[0]).toBe('Panel 1. Jonas: Which provider answered? On screen: $ $ $ / ?');
    expect(t[3]).toBe('Panel 4. A small copy of the system. On screen: $ python3 send_calls.py support / 200  deployment ?');
    expect(CAST.map((c) => c.id)).toContain('you');
    const two = ComicSchema.parse({ title: 'T', pages: [{ title: 'Monday', panels: GOOD.panels.slice(0, 2) }, { panels: GOOD.panels.slice(2, 4) }] });
    const pt = comicPagesTranscript(two.pages);
    expect(pt[0]).toBe('Page 1: Monday.');
    expect(pt.filter((l) => l.startsWith('Panel')).map((l) => l.slice(0, 8))).toEqual(['Panel 1.', 'Panel 2.', 'Panel 3.', 'Panel 4.']);
    expect(pt).toContain('Page 2.');
    expect(comicPagesTranscript(ComicSchema.parse(GOOD).pages)).toHaveLength(6);
  });
});

describe('compileLearnDir with a comic', () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'opalix-comic-'));
    mkdirSync(join(d, 'learn'), { recursive: true });
    writeFileSync(join(d, 'learn', 'story.md'), '---\ntitle: Monday\nminutes: 2\n---\nYou start on Monday.\n');
    return d;
  };
  const yaml = (c: unknown) => JSON.stringify(c);

  it('compiles comic.yaml into the bundle next to the text story', () => {
    const d = dir();
    try {
      writeFileSync(join(d, 'learn', 'comic.yaml'), yaml(GOOD));
      const r = compileLearnDir(d)!;
      expect(r.problems).toEqual([]);
      expect(r.bundle!.comic!.pages[0]!.panels).toHaveLength(6);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('requires the text story alongside a comic', () => {
    const d = dir();
    try {
      rmSync(join(d, 'learn', 'story.md'));
      writeFileSync(join(d, 'learn', 'comic.yaml'), yaml(GOOD));
      expect(compileLearnDir(d)!.problems.join()).toMatch(/comic needs learn\/story\.md/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('reports a bad comic and invalid YAML without throwing', () => {
    const d = dir();
    const e = dir();
    try {
      writeFileSync(join(d, 'learn', 'comic.yaml'), yaml({ ...GOOD, panels: GOOD.panels.slice(0, 2) }));
      expect(compileLearnDir(d)!.problems.join()).toMatch(/at least 4 panels/);
      writeFileSync(join(e, 'learn', 'comic.yaml'), 'panels: [unclosed');
      expect(compileLearnDir(e)!.problems.join()).toMatch(/comic\.yaml: not valid YAML/);
    } finally {
      rmSync(d, { recursive: true, force: true });
      rmSync(e, { recursive: true, force: true });
    }
  });
});
