import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CAST, SCENES } from '../../src/labs/comic-kit';
import { ComicSchema } from '../../src/labs/comic';
import { compileLearnDir } from '../../cli/src/learn-compile';

/**
 * The motion comic's art (dashboard/src/comic-art.js) and how a learn bundle reaches the
 * player (dashboard/src/learn-model.js normalizeLearn). The art is strings of SVG; the
 * tests check what must hold of them without a browser: every person and scene draws,
 * the cast are told apart, nothing a lab wrote can get into the markup, every colour
 * the interface owns is a variable. Drawing it is test/e2e/18-comic.spec.ts.
 */
type Panel = { scene: string; cast: string[]; prop: string; bubbles: unknown[]; lines?: string[]; caption?: string };
const A = (await import('../../dashboard/src/comic-art.js' as string)) as {
  ART: { h: number; wide: number; square: number };
  artWidth: (scene: string) => number;
  bust: (id: string, x: number, y: number, w: number, extra?: string) => string;
  sceneArt: (p: Panel) => { svg: string; lines: { x: number; y: number; w: number; h: number } | null; viewBox: string; width: number; height: number };
  captionIsDisplay: (scene: string) => boolean;
};
type R = { x: number; y: number; w: number; h: number };
const T = (await import('../../dashboard/src/comic-timeline.js' as string)) as { SCREENS: Record<'desk' | 'screen' | 'you', { lines: R; device: R }> };
const L = (await import('../../dashboard/src/learn-model.js' as string)) as {
  normalizeLearn: (e: unknown) => { version: string; learn: { comic?: { title: string; pages: unknown[] }; story?: { title: string } } } | null;
};

const castFor = (scene: string) => ['maren', 'jonas'].slice(0, SCENES[scene as keyof typeof SCENES].maxCast);
const panelFor = (scene: string, over: Partial<Panel> = {}): Panel => ({ scene, cast: castFor(scene), prop: 'none', bubbles: [], ...over });

describe('the cast', () => {
  it('draws every person in the story bible, and the learner', () => {
    expect(CAST.map((c) => c.id)).toEqual(['maren', 'tomasz', 'priya', 'jonas', 'anneke', 'you']);
    for (const c of CAST) {
      const svg = A.bust(c.id, 10, 20, 120);
      expect(svg, c.id).toContain(`data-cast="${c.id}"`);
      expect(svg, c.id).toContain('viewBox="0 0 120 130"');
      expect(svg, c.id).toContain('x="10"');
      expect(svg, c.id).toContain('y="20"');
      expect(svg, c.id).toContain('width="120"');
      expect(svg, c.id).toContain('height="130.0"');
    }
  });

  it('tells them apart: no two busts are the same drawing, and each has what names it', () => {
    const drawn = new Map(CAST.map((c) => [c.id, A.bust(c.id, 0, 0, 120)]));
    expect(new Set(drawn.values()).size).toBe(CAST.length);
    // Priya: a support headset with a microphone, long hair; Anneke: square glasses, a blond bob, a lanyard with a badge
    expect(drawn.get('priya')).toContain('stroke="#26305a" stroke-width="5"'); // the headset band
    expect(drawn.get('priya')).toContain('<circle cx="48" cy="92" r="5"'); // the microphone
    expect(drawn.get('anneke')).toContain('<rect x="33" y="50" width="24" height="17" rx="4"'); // square glasses
    expect(drawn.get('anneke')).toContain('#e6bf62'); // blond
    expect(drawn.get('anneke')).toContain('stroke="#3552f2" stroke-width="4"'); // the lanyard
    expect(drawn.get('tomasz')).toContain('<circle cx="46" cy="58" r="10"'); // round glasses
    expect(drawn.get('tomasz')).not.toContain('<rect x="33" y="50"');
    // the shirts differ, so a person is known by colour across the page
    const shirts = new Set(['maren', 'tomasz', 'priya', 'jonas', 'anneke'].map((id) => /M8 130c2-30 22-42 52-42s50 12 52 42z" fill="(#[0-9a-f]{6})"/.exec(drawn.get(id)!)![1]));
    expect(shirts.size).toBe(5);
    // everybody blinks and talks: eyes and mouth carry the classes comic.css animates (the learner has no face)
    for (const id of ['maren', 'tomasz', 'priya', 'jonas', 'anneke']) {
      expect(drawn.get(id), id).toContain('class="cm-eye"');
      expect(drawn.get(id), id).toContain('class="cm-mouth"');
    }
  });

  it('draws an unknown person as the learner rather than not at all', () => {
    expect(A.bust('stranger', 0, 0, 100)).toContain('data-cast="stranger"');
    expect(A.bust('stranger', 0, 0, 100).replace('stranger', 'you')).toBe(A.bust('you', 0, 0, 100));
  });
});

describe('the scenes', () => {
  it('draws every scene at the size comic-kit gives its panel, with the same height', () => {
    expect(A.ART).toEqual({ h: 320, wide: 697, square: 337 });
    for (const scene of Object.keys(SCENES)) {
      const art = A.sceneArt(panelFor(scene));
      const wide = SCENES[scene as keyof typeof SCENES].span === 2;
      expect(art.width, scene).toBe(wide ? 697 : 337);
      expect(art.height, scene).toBe(320);
      expect(art.viewBox, scene).toBe(`0 0 ${art.width} 320`);
      expect(art.svg.length, scene).toBeGreaterThan(200);
      expect(A.artWidth(scene)).toBe(art.width);
    }
  });

  it('puts the people of a panel in it, and the screen scenes\' typed text in a box over the art', () => {
    expect(A.sceneArt(panelFor('portrait', { cast: ['priya'] })).svg).toContain('data-cast="priya"');
    const duo = A.sceneArt(panelFor('duo', { cast: ['tomasz', 'anneke'] })).svg;
    expect(duo).toContain('data-cast="tomasz"');
    expect(duo).toContain('data-cast="anneke"');
    expect(A.sceneArt(panelFor('you')).svg).toContain('data-cast="you"');
    for (const [scene, box] of Object.entries(T.SCREENS)) {
      const art = A.sceneArt(panelFor(scene));
      expect(art.lines, scene).toEqual(box.lines);
      // the box lies inside the panel, and inside the device it is drawn on
      expect(box.lines.x + box.lines.w).toBeLessThanOrEqual(art.width);
      expect(box.lines.y + box.lines.h).toBeLessThanOrEqual(art.height);
      expect(box.lines.x).toBeGreaterThanOrEqual(box.device.x);
      expect(box.lines.x + box.lines.w).toBeLessThanOrEqual(box.device.x + box.device.w);
      expect(box.lines.y).toBeGreaterThanOrEqual(box.device.y);
      expect(box.lines.y + box.lines.h).toBeLessThanOrEqual(box.device.y + box.device.h);
    }
    for (const scene of ['message', 'portrait', 'duo']) expect(A.sceneArt(panelFor(scene)).lines, scene).toBeNull();
  });

  it('draws each prop a panel can name, and none when it names none', () => {
    const none = A.sceneArt(panelFor('portrait')).svg;
    const seen = new Set<string>();
    for (const prop of ['envelope', 'laptop', 'chart', 'map', 'key', 'document']) {
      const svg = A.sceneArt(panelFor('portrait', { prop })).svg;
      expect(svg, prop).not.toBe(none);
      expect(svg.length, prop).toBeGreaterThan(none.length);
      seen.add(svg);
    }
    expect(seen.size).toBe(6);
    // a message always has something that arrives: the envelope when it names no prop
    expect(A.sceneArt(panelFor('message')).svg).toBe(A.sceneArt(panelFor('message', { prop: 'envelope' })).svg);
    expect(A.sceneArt(panelFor('message', { prop: 'key' })).svg).not.toBe(A.sceneArt(panelFor('message')).svg);
  });

  it('puts none of a lab\'s words in the markup: captions, bubbles and lines are drawn as text elsewhere', () => {
    const evil = '<img src=x onerror=alert(1)> "quoted" & more';
    const art = A.sceneArt(panelFor('desk', { caption: evil, lines: [evil], bubbles: [{ text: evil }] }));
    expect(art.svg).not.toContain('onerror');
    expect(art.svg).not.toContain('quoted');
    expect(art.svg).not.toMatch(/<text[\s>]/); // not one word is drawn in the art itself
    expect(art.svg).not.toContain('<script');
  });

  it('shows a closing panel\'s caption as the big words, and no other scene\'s', () => {
    expect(A.captionIsDisplay('you')).toBe(true);
    for (const s of ['desk', 'message', 'portrait', 'screen', 'duo']) expect(A.captionIsDisplay(s)).toBe(false);
  });

  it('names no colour of the interface: it reads a variable for outline, screen and ground', () => {
    const all = Object.keys(SCENES).map((s) => A.sceneArt(panelFor(s)).svg).join('');
    expect(all).toContain('var(--cm-ink)');
    expect(all).toContain('var(--cm-screen-bg)');
    // the only variables it uses are ones comic.css defines
    const css = readFileSync('dashboard/public/comic.css', 'utf8');
    const used = new Set([...all.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]!));
    for (const v of used) expect(css, v).toContain(`${v}:`);
  });
});

describe('a learn bundle reaches the player', () => {
  const bundle = (over: Record<string, unknown> = {}) => ({ version: 1, story: { title: 'T', minutes: 2, body: 'B' }, concepts: [], questions: [], answers_file: 'answers.json', fields: [], ...over });
  const comic = { title: 'C', pages: [{ panels: [panelFor('portrait')] }] };

  it('carries a comic through normalizeLearn (the console strips what it does not know)', () => {
    const out = L.normalizeLearn({ version: '1.0.0', learn: bundle({ comic }) })!;
    expect(out.learn.comic).toEqual(comic);
    expect(out.learn.story?.title).toBe('T');
  });

  it('leaves a bundle without a comic exactly as it was, and drops one that is not a comic at all', () => {
    expect('comic' in L.normalizeLearn({ version: '1.0.0', learn: bundle() })!.learn).toBe(false);
    for (const junk of [null, 'x', 5, [], {}, { title: 'T' }, { title: '', pages: [] }, { title: 'T', pages: 'x' }, { pages: [] }]) {
      expect('comic' in L.normalizeLearn({ version: '1.0.0', learn: bundle({ comic: junk }) })!.learn, JSON.stringify(junk)).toBe(false);
    }
  });

  it('keeps the comic of every lab that ships one, whole', () => {
    let n = 0;
    for (const dir of readdirSync('labs')) {
      if (!existsSync(join('labs', dir, 'learn', 'comic.yaml'))) continue;
      n++;
      const compiled = compileLearnDir(join('labs', dir))!;
      expect(compiled.problems, dir).toEqual([]);
      const served = compiled.bundle!;
      expect(served.comic, dir).toBeDefined();
      const out = L.normalizeLearn({ version: '1.0.0', learn: served })!;
      expect(out.learn.comic, dir).toEqual(served.comic);
      // and the file is what the schema says it is
      expect(ComicSchema.safeParse(parseYaml(readFileSync(join('labs', dir, 'learn', 'comic.yaml'), 'utf8'))).success, dir).toBe(true);
    }
    expect(n).toBeGreaterThanOrEqual(6);
  });
});

describe('the player module', () => {
  it('refuses a comic it cannot play before it touches the page, so the caller can fall back to the text story', async () => {
    const { mountComic } = (await import('../../dashboard/src/comic.js' as string)) as { mountComic: (c: unknown, comic: unknown, o?: unknown) => unknown };
    for (const junk of [null, {}, { title: 'T', pages: [] }, { title: 'T', pages: [{ panels: [{ scene: 'rocket' }] }] }]) {
      expect(() => mountComic({}, junk), JSON.stringify(junk)).toThrow(/nothing to play/);
    }
  });
});
