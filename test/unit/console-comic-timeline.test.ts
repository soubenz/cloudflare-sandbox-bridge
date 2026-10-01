import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ComicSchema } from '../../src/labs/comic';
import { PAGE_W, comicPagesTranscript, comicTranscript, layoutComic, panelSeconds } from '../../src/labs/comic-kit';

/**
 * The motion comic's schedule and its clock (dashboard/src/comic-timeline.js): when
 * each panel pops in, when each word of a bubble and each screen line is typed, where the
 * camera looks, how long it all takes, and the Replay / Skip state machine. Pure module,
 * imported directly; the player that draws it (comic.js) is exercised by test/e2e/18-comic.spec.ts.
 */
type Rect = { x: number; y: number; w: number; h: number };
type Panel = { scene: string; cast: string[]; bg?: string; prop: string; caption?: string; bubbles: Array<{ who?: string; text: string; pos?: string }>; sfx?: string; lines?: string[] };
type Comic = { title: string; pages: Array<{ title?: string; panels: Panel[] }> };
type TPanel = {
  index: number;
  number: number;
  page: number;
  scene: string;
  start: number;
  end: number;
  dur: number;
  words: number;
  rect: Rect;
  popAt: number;
  captionAt: number | null;
  sfxAt: number | null;
  focusAt: number | null;
  bubbles: Array<{ who?: string; pos?: string; start: number; end: number; step: number; wordTimes: number[] }>;
  lines: Array<{ start: number; end: number }>;
};
type TPage = { index: number; title: string | null; start: number; end: number; panelsStart: number; sheet: Rect; banner: Rect | null; body: Rect; panels: TPanel[] };
type Shot = { t: number; dur: number; rect: Rect; kind: string; narrowOnly?: boolean };
type Timeline = { total: number; parts: { lead: number; turns: number; titles: number; panels: number; outro: number }; reel: { w: number; h: number }; pages: TPage[]; shots: Shot[]; outro: { start: number; end: number } };
type Clock = { t: number; status: 'playing' | 'done' };
type State = {
  on: boolean;
  active: boolean;
  caption: boolean;
  sfx: boolean;
  shake: boolean;
  bubbles: Array<{ on: boolean; words: number; speaking: boolean }>;
  lines: number[];
};
type Cam = { cx: number; cy: number; k: number };
const T = (await import('../../dashboard/src/comic-timeline.js' as string)) as {
  TIMING: { lead: number; turn: number; title: number; move: number; pop: number; caption: number; sfx: number; content: number; bubblePop: number; bubbleGap: number; word: number; hold: number; line: number; outro: number; shake: number };
  REEL: { margin: number; paper: number; gap: number; banner: number; shotPad: number };
  MAX_STEP: number;
  NARROW: number;
  SCREENS: Record<'desk' | 'screen' | 'you', { lines: Rect; device: Rect }>;
  DEFAULT_BG: Record<string, string>;
  panelWords: (p: Panel) => number;
  cleanComic: (raw: unknown) => Comic | null;
  transcriptOf: (c: Comic) => string[];
  buildTimeline: (c: Comic) => Timeline;
  panelsOf: (tl: Timeline) => TPanel[];
  panelState: (p: TPanel, t: number) => State;
  bannerOn: (p: TPage, t: number) => boolean;
  playAspect: (w: number) => number;
  cameraFor: (r: Rect, vp: { w: number; h: number }) => Cam;
  cameraTransform: (c: Cam, vp: { w: number; h: number }) => string;
  cameraAt: (tl: Timeline, t: number, vp: { w: number; h: number }) => Cam;
  viewportAt: (tl: Timeline, t: number, w: number) => { w: number; h: number };
  textScale: (r: Rect, vp: { w: number; h: number }, o?: { minPx?: number; basePx?: number; max?: number }) => number;
  initialClock: (tl: Timeline, o?: { reduced?: boolean }) => Clock;
  clockReduce: (s: Clock, a: { type: string; dt?: number; t?: number }, total: number) => Clock;
  justFinished: (a: Clock, b: Clock) => boolean;
  mmss: (s: number, round?: (n: number) => number) => string;
};

const panel = (over: Partial<Panel> = {}): Panel => ({ scene: 'portrait', cast: ['maren'], prop: 'none', bubbles: [{ who: 'maren', text: 'Hello there, this is a bubble.' }], ...over });
const desk = (over: Partial<Panel> = {}) => panel({ scene: 'desk', cast: ['jonas'], lines: ['$ one', 'two'], ...over });
const screen = (over: Partial<Panel> = {}) => panel({ scene: 'screen', cast: [], bubbles: [], caption: 'A screen.', lines: ['$ run it', '200 ok'], ...over });
const duo = () => panel({ scene: 'duo', cast: ['priya', 'anneke'], bubbles: [{ who: 'priya', text: 'One two three four five.' }, { who: 'anneke', text: 'Six seven eight nine ten eleven.' }] });

const ONE: Comic = { title: 'One page', pages: [{ panels: [desk(), panel({ scene: 'message', sfx: 'PING!', prop: 'envelope' }), panel(), screen(), duo(), panel({ scene: 'you', cast: [], bubbles: [], caption: 'Your turn.', lines: ['$ go', 'ready.'] })] }] };
const THREE: Comic = {
  title: 'Three pages',
  pages: [
    { title: 'Monday', panels: [desk(), panel(), duo(), screen()] },
    { panels: [panel({ scene: 'message', sfx: 'HMM.' }), desk(), screen()] },
    { title: 'The end', panels: [panel({ scene: 'you', cast: [], bubbles: [], lines: ['$ x'] }), panel()] },
  ],
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('how long a comic takes', () => {
  it('is the beats at the ends plus panelSeconds of every panel: one page', () => {
    const tl = T.buildTimeline(ONE);
    const expected = ONE.pages[0]!.panels.map((p) => panelSeconds(T.panelWords(p)));
    expect(tl.parts.panels).toBeCloseTo(sum(expected), 9);
    expect(tl.parts.lead).toBe(T.TIMING.lead);
    expect(tl.parts.turns).toBe(0);
    expect(tl.parts.titles).toBe(0);
    expect(tl.parts.outro).toBe(T.TIMING.outro);
    expect(tl.total).toBeCloseTo(T.TIMING.lead + sum(expected) + T.TIMING.outro, 9);
    expect(tl.parts.lead + tl.parts.turns + tl.parts.titles + tl.parts.panels + tl.parts.outro).toBeCloseTo(tl.total, 9);
    expect(tl.outro).toEqual({ start: tl.total - T.TIMING.outro, end: tl.total });
  });

  it('counts every word a panel shows (said, captioned, on its screen), so a screen panel is not a flash', () => {
    expect(T.panelWords(screen())).toBe(2 + 3 + 2); // "A screen." + "$ run it" + "200 ok"
    expect(T.panelWords(duo())).toBe(5 + 6);
    expect(T.panelWords(panel({ bubbles: [], caption: 'x' }))).toBe(1);
    const dur = (p: Panel) => T.buildTimeline({ title: 't', pages: [{ panels: [p] }] }).pages[0]!.panels[0]!.dur;
    expect(dur(screen())).toBe(panelSeconds(7));
    expect(dur(panel({ bubbles: [], caption: 'x' }))).toBe(3.6); // never under the floor
    expect(dur(panel({ bubbles: [{ text: Array(80).fill('word').join(' ') }] }))).toBe(7.5); // never over the ceiling
  });

  it('adds a turn per page after the first, and a title card for each titled page', () => {
    const tl = T.buildTimeline(THREE);
    const panels = sum(THREE.pages.flatMap((p) => p.panels).map((p) => panelSeconds(T.panelWords(p))));
    expect(tl.parts.panels).toBeCloseTo(panels, 9);
    expect(tl.parts.turns).toBeCloseTo(2 * T.TIMING.turn, 9);
    expect(tl.parts.titles).toBeCloseTo(2 * T.TIMING.title, 9);
    expect(tl.parts.lead).toBe(T.TIMING.lead);
    expect(tl.total).toBeCloseTo(T.TIMING.lead + 2 * T.TIMING.turn + 2 * T.TIMING.title + panels + T.TIMING.outro, 9);
  });

  it('has page boundaries that meet: each page starts where the one before ended, and its panels follow its intro', () => {
    const tl = T.buildTimeline(THREE);
    expect(tl.pages.map((p) => p.title)).toEqual(['Monday', null, 'The end']);
    expect(tl.pages[0]!.start).toBe(0);
    for (let i = 1; i < tl.pages.length; i++) expect(tl.pages[i]!.start).toBeCloseTo(tl.pages[i - 1]!.end, 9);
    expect(tl.pages[2]!.end).toBeCloseTo(tl.outro.start, 9);
    // intro: lead (page 1) or turn (the rest), plus the title card when there is one
    expect(tl.pages[0]!.panelsStart - tl.pages[0]!.start).toBeCloseTo(T.TIMING.lead + T.TIMING.title, 9);
    expect(tl.pages[1]!.panelsStart - tl.pages[1]!.start).toBeCloseTo(T.TIMING.turn, 9);
    expect(tl.pages[2]!.panelsStart - tl.pages[2]!.start).toBeCloseTo(T.TIMING.turn + T.TIMING.title, 9);
    // panels run back to back and are numbered across pages
    const all = T.panelsOf(tl);
    expect(all.map((p) => p.number)).toEqual(all.map((_, i) => i + 1));
    expect(all).toHaveLength(9);
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1]!;
      const b = all[i]!;
      if (a.page === b.page) expect(b.start).toBeCloseTo(a.end, 9);
      else expect(b.start).toBeGreaterThan(a.end);
    }
    for (const p of all) expect(p.end - p.start).toBeCloseTo(p.dur, 9);
  });

  it('every comic the repo ships plays for a sensible time, with every word and line typed before its panel ends', () => {
    let found = 0;
    for (const dir of readdirSync('labs')) {
      const file = join('labs', dir, 'learn', 'comic.yaml');
      if (!existsSync(file)) continue;
      found++;
      const comic = ComicSchema.parse(parseYaml(readFileSync(file, 'utf8'))) as unknown as Comic;
      const clean = T.cleanComic(comic)!;
      expect(clean, dir).not.toBeNull();
      expect(clean.pages.flatMap((p) => p.panels), dir).toHaveLength(comic.pages.flatMap((p) => p.panels).length);
      const tl = T.buildTimeline(clean);
      expect(tl.total, dir).toBeGreaterThan(20);
      expect(tl.total, dir).toBeLessThan(90);
      for (const p of T.panelsOf(tl)) {
        for (const b of p.bubbles) expect(b.end + T.TIMING.hold, `${dir} panel ${p.number}`).toBeLessThanOrEqual(p.end + 1e-9);
        for (const l of p.lines) expect(l.end, `${dir} panel ${p.number}`).toBeLessThan(p.end - 0.5);
      }
    }
    expect(found).toBeGreaterThanOrEqual(6);
  });
});

describe('what is typed when', () => {
  const tl = T.buildTimeline(ONE);
  const deskP = tl.pages[0]!.panels[0]!;
  const duoP = tl.pages[0]!.panels[4]!;

  it('gives every word of a bubble its own time, in order, at the pace panelSeconds budgets for', () => {
    const b = deskP.bubbles[0]!;
    expect(b.wordTimes).toHaveLength('Hello there, this is a bubble.'.split(' ').length);
    for (let i = 1; i < b.wordTimes.length; i++) expect(b.wordTimes[i]! - b.wordTimes[i - 1]!).toBeCloseTo(b.step, 9);
    expect(b.step).toBeLessThanOrEqual(T.TIMING.word);
    expect(b.wordTimes[0]).toBeGreaterThanOrEqual(b.start + T.TIMING.bubblePop - 1e-9);
    expect(b.start).toBeGreaterThanOrEqual(deskP.start + T.TIMING.content - 1e-9);
  });

  it('has speakers take turns: the second bubble pops after the first is done', () => {
    const [a, b] = duoP.bubbles;
    expect(a!.wordTimes).toHaveLength(5);
    expect(b!.wordTimes).toHaveLength(6);
    expect(b!.start).toBeGreaterThanOrEqual(a!.end + T.TIMING.bubbleGap - 1e-9);
    expect(a!.who).toBe('priya');
    expect(b!.who).toBe('anneke');
  });

  it('slows the typing rather than overrun a long panel, but never past the pace it started at', () => {
    const long = T.buildTimeline({ title: 't', pages: [{ panels: [panel({ bubbles: [{ text: Array(30).fill('w').join(' ') }, { text: Array(30).fill('w').join(' ') }] })] }] }).pages[0]!.panels[0]!;
    expect(long.dur).toBe(7.5);
    const [a, b] = long.bubbles;
    expect(a!.step).toBeLessThan(T.TIMING.word);
    expect(b!.end + T.TIMING.hold).toBeLessThanOrEqual(long.end + 1e-9);
  });

  it('types screen lines one after another, each finished before the next is half way through the panel hold', () => {
    const lines = deskP.lines;
    expect(lines).toHaveLength(2);
    expect(lines[1]!.start).toBeGreaterThan(lines[0]!.start);
    expect(lines[0]!.end).toBeLessThanOrEqual(lines[1]!.start + 1e-9);
    expect(lines[1]!.end).toBeLessThan(deskP.end - T.TIMING.hold + 1e-9);
  });

  it('reports what has appeared at a given time, as flags and counts only', () => {
    const msg = tl.pages[0]!.panels[1]!;
    const before = T.panelState(msg, msg.start + 0.05);
    expect(before.on).toBe(false);
    expect(before.active).toBe(true);
    expect(before.sfx).toBe(false);
    const popped = T.panelState(msg, msg.popAt + 0.01);
    expect(popped.on).toBe(true);
    const slam = T.panelState(msg, msg.sfxAt! + 0.1);
    expect(slam.sfx).toBe(true);
    expect(slam.shake).toBe(true);
    expect(T.panelState(msg, msg.sfxAt! + T.TIMING.shake + 0.1).shake).toBe(false);
    const half = T.panelState(deskP, deskP.bubbles[0]!.wordTimes[2]! + 0.001);
    expect(half.bubbles[0]).toEqual({ on: true, words: 3, speaking: true });
    expect(half.caption).toBe(false); // this panel has no caption
    const withCaption = tl.pages[0]!.panels[3]!;
    expect(T.panelState(withCaption, withCaption.captionAt! - 0.01).caption).toBe(false);
    expect(T.panelState(withCaption, withCaption.captionAt! + 0.01).caption).toBe(true);
    expect(T.panelState(deskP, deskP.bubbles[0]!.end + 0.5).bubbles[0]!.speaking).toBe(false);
    const mid = T.panelState(deskP, deskP.lines[0]!.start + (deskP.lines[0]!.end - deskP.lines[0]!.start) / 2);
    expect(mid.lines[0]).toBeCloseTo(0.5, 5);
    expect(mid.lines[1]).toBe(0);
  });

  it('shows a title banner as the camera arrives, and the first page\'s from the start', () => {
    const t3 = T.buildTimeline(THREE);
    expect(T.bannerOn(t3.pages[0]!, 0)).toBe(true);
    expect(T.bannerOn(t3.pages[2]!, t3.pages[2]!.start)).toBe(false);
    expect(T.bannerOn(t3.pages[2]!, t3.pages[2]!.start + T.TIMING.turn)).toBe(true);
  });
});

describe('the finished state (what reduced motion shows from the first moment)', () => {
  const tl = T.buildTimeline(THREE);

  it('starts done, at the end of the clock, when motion is reduced, and playing at zero otherwise', () => {
    expect(T.initialClock(tl, { reduced: true })).toEqual({ t: tl.total, status: 'done' });
    expect(T.initialClock(tl, { reduced: false })).toEqual({ t: 0, status: 'playing' });
    expect(T.initialClock(tl)).toEqual({ t: 0, status: 'playing' });
  });

  it('has every part of every panel on at the end: bubbles fully typed, lines complete, captions and sound effects in', () => {
    for (const p of T.panelsOf(tl)) {
      const s = T.panelState(p, tl.total);
      expect(s.on).toBe(true);
      expect(s.active).toBe(false);
      expect(s.shake).toBe(false);
      expect(s.caption).toBe(p.captionAt !== null);
      expect(s.sfx).toBe(p.sfxAt !== null);
      s.bubbles.forEach((b, i) => expect(b).toEqual({ on: true, words: p.bubbles[i]!.wordTimes.length, speaking: false }));
      for (const l of s.lines) expect(l).toBe(1);
    }
    for (const page of tl.pages) expect(T.bannerOn(page, tl.total)).toBe(true);
  });

  it('frames the whole reel with no camera left to move: one fit, as wide as the container, as tall as the comic', () => {
    for (const w of [300, 420, 700, 1000, 1280]) {
      const vp = T.viewportAt(tl, tl.total, w);
      const cam = T.cameraAt(tl, tl.total, vp);
      expect(vp.h).toBeCloseTo(tl.reel.h * (w / tl.reel.w), 6);
      expect(cam.k).toBeCloseTo(w / tl.reel.w, 9);
      expect(cam.cx).toBeCloseTo(tl.reel.w / 2, 9);
      expect(cam.cy).toBeCloseTo(tl.reel.h / 2, 9);
      // the camera's transform puts the reel's top left at the viewport's top left
      expect(T.cameraTransform(cam, vp)).toBe(`translate(0.00px, 0.00px) scale(${cam.k.toFixed(5)})`);
    }
  });

  it('is the same at any time after the end', () => {
    const vp = T.viewportAt(tl, tl.total, 1000);
    expect(T.cameraAt(tl, tl.total + 10, vp)).toEqual(T.cameraAt(tl, tl.total, vp));
  });
});

describe('the camera', () => {
  const tl = T.buildTimeline(ONE);
  const wideVp = { w: 1000, h: 1000 / (16 / 9) };
  const [wide, square] = [tl.pages[0]!.panels[0]!, tl.pages[0]!.panels[1]!];

  it('lays panels out as comic-kit does: a wide panel is two columns, a square one is one', () => {
    const laid = layoutComic(ONE.pages[0]!.panels as never).placements;
    expect(wide.rect.w).toBe(laid[0]!.w);
    expect(square.rect.w).toBe(laid[1]!.w);
    expect(wide.rect.w).toBeGreaterThan(square.rect.w * 2 - 1);
    expect(tl.reel.w).toBe(PAGE_W + 2 * (T.REEL.margin + T.REEL.paper));
    for (const p of T.panelsOf(tl)) {
      expect(p.rect.x).toBeGreaterThanOrEqual(T.REEL.margin + T.REEL.paper - 1e-9);
      expect(p.rect.x + p.rect.w).toBeLessThanOrEqual(tl.reel.w - T.REEL.margin - T.REEL.paper + 1e-9);
      expect(p.rect.y + p.rect.h).toBeLessThanOrEqual(tl.reel.h);
    }
  });

  it('frames a wide panel less close than a square one, each centred on the panel', () => {
    const grow = (r: Rect) => ({ x: r.x - T.REEL.shotPad, y: r.y - T.REEL.shotPad, w: r.w + 2 * T.REEL.shotPad, h: r.h + 2 * T.REEL.shotPad });
    const a = T.cameraFor(grow(wide.rect), wideVp);
    const b = T.cameraFor(grow(square.rect), wideVp);
    expect(a.k).toBeLessThan(b.k);
    expect(a.cx).toBeCloseTo(wide.rect.x + wide.rect.w / 2, 9);
    expect(a.cy).toBeCloseTo(wide.rect.y + wide.rect.h / 2, 9);
    expect(b.cx).toBeCloseTo(square.rect.x + square.rect.w / 2, 9);
    // the panel fills the frame: the limiting side touches its edges (less the padding)
    expect(Math.max(wide.rect.w + 56, (wide.rect.h + 56) * (16 / 9)) * a.k).toBeCloseTo(wideVp.w, 6);
    // a wide frame is limited by height for a square panel, by width for a wide one
    expect((square.rect.h + 56) * b.k).toBeCloseTo(wideVp.h, 6);
    expect((wide.rect.w + 56) * a.k).toBeCloseTo(wideVp.w, 6);
  });

  it('is on a panel by the time the panel is about to pop in, and travels there, not jumps', () => {
    const vp = T.viewportAt(tl, wide.start, 1000);
    const home = T.cameraAt(tl, wide.start + T.TIMING.move + 0.01, vp);
    const half = T.cameraAt(tl, wide.start + T.TIMING.move / 2, vp);
    const from = T.cameraAt(tl, wide.start - 0.01, vp);
    expect(home.cx).toBeCloseTo(wide.rect.x + wide.rect.w / 2, 6);
    expect(half.cx).not.toBeCloseTo(home.cx, 1);
    expect(half.cx).not.toBeCloseTo(from.cx, 1);
    expect(from.k).toBeLessThan(home.k); // from the page to the panel: zooming in
    const next = T.cameraAt(tl, square.start + T.TIMING.move + 0.01, vp);
    expect(next.cx).toBeCloseTo(square.rect.x + square.rect.w / 2, 6);
    expect(next.k).toBeGreaterThan(home.k);
  });

  it('keeps the frame the same height while it plays and only grows it in the pull-back at the end', () => {
    const play = 1000 / T.playAspect(1000);
    expect(T.viewportAt(tl, 0, 1000).h).toBeCloseTo(play, 9);
    expect(T.viewportAt(tl, tl.outro.start, 1000).h).toBeCloseTo(play, 9);
    const mid = T.viewportAt(tl, tl.outro.start + T.TIMING.outro / 2, 1000).h;
    const whole = tl.reel.h * (1000 / tl.reel.w);
    expect(mid).toBeGreaterThan(Math.min(play, whole));
    expect(mid).toBeLessThan(Math.max(play, whole));
    expect(T.viewportAt(tl, tl.total, 1000).h).toBeCloseTo(whole, 9);
  });

  it('shapes the frame to the container: wide on a big screen, squarer in a narrow guide', () => {
    expect(T.playAspect(1440)).toBeCloseTo(16 / 9, 9);
    expect(T.playAspect(900)).toBeCloseTo(16 / 9, 9);
    expect(T.playAspect(700)).toBeCloseTo(4 / 3, 9);
    expect(T.playAspect(380)).toBe(1);
  });

  it('flies to a page\'s title card, then to its first panel, on a multi-page comic', () => {
    const t3 = T.buildTimeline(THREE);
    const vp = T.viewportAt(t3, 0, 1000);
    const [p0, p1, p2] = t3.pages;
    const onBanner = T.cameraAt(t3, p2!.start + T.TIMING.turn + 0.05, vp);
    expect(onBanner.cy).toBeCloseTo(p2!.banner!.y + p2!.banner!.h / 2, 6);
    const first = p2!.panels[0]!;
    const onPanel = T.cameraAt(t3, first.start + T.TIMING.move + 0.01, vp);
    expect(onPanel.cy).toBeCloseTo(first.rect.y + first.rect.h / 2, 6);
    expect(onPanel.cy).toBeGreaterThan(onBanner.cy);
    // an untitled page is flown to as a whole sheet
    const onSheet = T.cameraAt(t3, p1!.start + T.TIMING.turn - 0.01, vp);
    expect(onSheet.cx).toBeCloseTo(p1!.sheet.x + p1!.sheet.w / 2, 1);
    expect(onSheet.cy).toBeCloseTo(p1!.sheet.y + p1!.sheet.h / 2, 0);
    expect(p0!.sheet.y).toBeLessThan(p1!.sheet.y);
    expect(p1!.sheet.y).toBeLessThan(p2!.sheet.y);
  });
});

describe('a narrow container', () => {
  const tl = T.buildTimeline(ONE);
  const wideVp = { w: 1000, h: 562.5 };
  const narrowVp = { w: 380, h: 380 };
  const deskP = tl.pages[0]!.panels[0]!;
  const squareP = tl.pages[0]!.panels[1]!;

  it('draws a wide panel\'s words bigger (up to a limit) so that they are about 13px for a bubble on screen, and leaves a wide stage alone', () => {
    expect(T.textScale(deskP.rect, wideVp)).toBe(1);
    expect(T.textScale(squareP.rect, wideVp)).toBe(1);
    const s = T.textScale(deskP.rect, narrowVp);
    expect(s).toBeGreaterThan(1.2);
    expect(s).toBeLessThanOrEqual(1.9);
    const k = T.cameraFor({ x: deskP.rect.x - 28, y: deskP.rect.y - 28, w: deskP.rect.w + 56, h: deskP.rect.h + 56 }, narrowVp).k;
    expect(15 * s * k).toBeGreaterThanOrEqual(12.9);
    // a square panel is nearly one to one, so barely needs it
    expect(T.textScale(squareP.rect, narrowVp)).toBeLessThan(T.textScale(deskP.rect, narrowVp));
    // the cap holds however small the container
    expect(T.textScale(deskP.rect, { w: 100, h: 100 })).toBe(1.9);
    expect(T.textScale(deskP.rect, { w: 100, h: 100 }, { max: 2.4 })).toBe(2.4);
  });

  it('pushes the camera in on a screen only there, once what is said has been said', () => {
    expect(deskP.focusAt).not.toBeNull();
    expect(deskP.focusAt!).toBeGreaterThan(deskP.bubbles[0]!.end);
    expect(deskP.focusAt!).toBeLessThan(deskP.end - 0.5);
    expect(squareP.focusAt).toBeNull();
    const shots = tl.shots.filter((s) => s.narrowOnly);
    expect(shots.length).toBe(T.panelsOf(tl).filter((p) => p.focusAt !== null).length);
    const t = deskP.focusAt! + 0.8;
    const wide = T.cameraAt(tl, t, wideVp);
    const narrow = T.cameraAt(tl, t, narrowVp);
    const dev = T.SCREENS.desk.device;
    // wide: still on the whole panel. narrow: on the monitor.
    expect(wide.cx).toBeCloseTo(deskP.rect.x + deskP.rect.w / 2, 6);
    expect(narrow.cx).toBeCloseTo(deskP.rect.x + 4 + dev.x + dev.w / 2, 6);
    expect(narrow.cy).toBeCloseTo(deskP.rect.y + 4 + dev.y + dev.h / 2, 6);
    expect(T.cameraFor(deskP.rect, narrowVp).k).toBeLessThan(narrow.k);
  });
});

describe('Replay and Skip: the clock', () => {
  const total = 40;
  const start = { t: 0, status: 'playing' as const };

  it('advances by the time that passed, never by more than one step per frame', () => {
    const a = T.clockReduce(start, { type: 'tick', dt: 0.016 }, total);
    expect(a).toEqual({ t: 0.016, status: 'playing' });
    expect(T.clockReduce(a, { type: 'tick', dt: 5 }, total).t).toBeCloseTo(0.016 + T.MAX_STEP, 9); // a hidden tab does not skip ahead
    expect(T.clockReduce(a, { type: 'tick', dt: -1 }, total)).toEqual(a);
    expect(T.clockReduce(a, { type: 'tick', dt: Number.NaN }, total)).toEqual(a);
  });

  it('finishes at the end, exactly, and stays finished', () => {
    const near = { t: total - 0.05, status: 'playing' as const };
    const done = T.clockReduce(near, { type: 'tick', dt: 0.1 }, total);
    expect(done).toEqual({ t: total, status: 'done' });
    expect(T.justFinished(near, done)).toBe(true);
    expect(T.clockReduce(done, { type: 'tick', dt: 0.1 }, total)).toBe(done);
    expect(T.justFinished(done, T.clockReduce(done, { type: 'tick', dt: 0.1 }, total))).toBe(false);
  });

  it('Skip jumps to the finished comic, and reports it done once however often it is pressed', () => {
    const mid = { t: 12.3, status: 'playing' as const };
    const skipped = T.clockReduce(mid, { type: 'skip' }, total);
    expect(skipped).toEqual({ t: total, status: 'done' });
    expect(T.justFinished(mid, skipped)).toBe(true);
    const again = T.clockReduce(skipped, { type: 'skip' }, total);
    expect(again).toBe(skipped);
    expect(T.justFinished(skipped, again)).toBe(false);
  });

  it('Replay starts again from the beginning, from the middle or from the end, and can finish again', () => {
    for (const s of [{ t: 12.3, status: 'playing' as const }, { t: total, status: 'done' as const }]) {
      expect(T.clockReduce(s, { type: 'replay' }, total)).toEqual({ t: 0, status: 'playing' });
    }
    const replayed = T.clockReduce({ t: total, status: 'done' }, { type: 'replay' }, total);
    const finished = T.clockReduce(replayed, { type: 'skip' }, total);
    expect(T.justFinished(replayed, finished)).toBe(true);
  });

  it('seeks to a time for the test clock, clamped to the comic, and is done at the end', () => {
    expect(T.clockReduce(start, { type: 'seek', t: 7.5 }, total)).toEqual({ t: 7.5, status: 'playing' });
    expect(T.clockReduce(start, { type: 'seek', t: -3 }, total)).toEqual({ t: 0, status: 'playing' });
    expect(T.clockReduce(start, { type: 'seek', t: 400 }, total)).toEqual({ t: total, status: 'done' });
    expect(T.clockReduce({ t: total, status: 'done' }, { type: 'seek', t: 5 }, total)).toEqual({ t: 5, status: 'playing' });
  });

  it('ignores an action it does not know', () => {
    expect(T.clockReduce(start, { type: 'pause' }, total)).toBe(start);
  });

  it('plays a whole comic out by ticks to exactly its total', () => {
    const tl = T.buildTimeline(ONE);
    let s = T.initialClock(tl);
    let frames = 0;
    let finishes = 0;
    while (s.status === 'playing' && frames < 100000) {
      const next = T.clockReduce(s, { type: 'tick', dt: 1 / 60 }, tl.total);
      if (T.justFinished(s, next)) finishes++;
      s = next;
      frames++;
    }
    expect(s).toEqual({ t: tl.total, status: 'done' });
    expect(finishes).toBe(1);
    expect(frames).toBeCloseTo(tl.total * 60, -1);
  });

  it('writes a time as m:ss', () => {
    expect(T.mmss(0)).toBe('0:00');
    expect(T.mmss(59.9)).toBe('0:59');
    expect(T.mmss(61)).toBe('1:01');
    expect(T.mmss(59.5, Math.round)).toBe('1:00');
    expect(T.mmss(-4)).toBe('0:00');
    expect(T.mmss(Number.NaN)).toBe('0:00');
  });
});

describe('the transcript (the accessible equivalent of the stage)', () => {
  it('is comic-kit\'s own text: one numbered line per panel on one page', () => {
    const t = T.transcriptOf(ONE);
    expect(t).toEqual(comicTranscript(ONE.pages[0]!.panels as never));
    expect(t).toHaveLength(6);
    expect(t[0]).toBe('Panel 1. Maren: Hello there, this is a bubble. On screen: $ one / two');
    expect(t[3]).toBe('Panel 4. A screen. On screen: $ run it / 200 ok');
    expect(t[4]).toBe('Panel 5. Priya: One two three four five. Anneke: Six seven eight nine ten eleven.');
    expect(t[5]).toBe('Panel 6. Your turn. On screen: $ go / ready.');
  });

  it('has a heading line per page and numbers panels across pages, on several', () => {
    const t = T.transcriptOf(THREE);
    expect(t).toEqual(comicPagesTranscript(THREE.pages as never));
    expect(t).toHaveLength(3 + 9);
    expect(t[0]).toBe('Page 1: Monday.');
    expect(t[1]).toMatch(/^Panel 1\. /);
    expect(t[5]).toBe('Page 2.');
    expect(t[6]).toMatch(/^Panel 5\. /);
    expect(t[9]).toBe('Page 3: The end.');
    expect(t[11]).toMatch(/^Panel 9\. /);
  });
});

describe('cleaning what the API sent', () => {
  it('accepts a normalised comic and the flat panels form, and hands back nothing for junk', () => {
    expect(T.cleanComic(ONE)).toEqual({ ...ONE, pages: [{ panels: ONE.pages[0]!.panels.map((p) => expect.objectContaining({ scene: p.scene })) }] });
    const flat = T.cleanComic({ title: 'Flat', panels: [desk()] })!;
    expect(flat.pages).toHaveLength(1);
    for (const junk of [null, undefined, 'x', 5, [], {}, { title: '' }, { title: 'T' }, { title: 'T', pages: [] }, { title: 'T', pages: [{ panels: [] }] }, { title: 'T', pages: [{ panels: [{ scene: 'rocket' }] }] }, { title: 3, pages: [{ panels: [desk()] }] }]) {
      expect(T.cleanComic(junk), JSON.stringify(junk)).toBeNull();
    }
  });

  it('drops what it cannot draw and keeps the rest', () => {
    const c = T.cleanComic({
      title: 'Mixed',
      pages: [
        { title: 'One', panels: [desk(), { scene: 'rocket' }, panel({ cast: ['nobody'] }), panel({ cast: ['maren', 'maren'], bg: 'plaid', prop: 'sword', bubbles: [{ who: 'ghost', text: 'Boo', pos: 'xx' }, { text: '' }] })] },
        { panels: [{ scene: 'rocket' }] },
        'junk',
      ],
    })!;
    expect(c.pages).toHaveLength(1);
    const [a, b] = c.pages[0]!.panels;
    expect(c.pages[0]!.panels).toHaveLength(2);
    expect(a!.scene).toBe('desk');
    // a person who is not in the cast is dropped; a portrait with nobody in it cannot be drawn
    expect(b!.cast).toEqual(['maren']);
    expect(b!.bg).toBeUndefined();
    expect(b!.prop).toBe('none');
    expect(b!.bubbles).toEqual([{ text: 'Boo' }]);
  });

  it('caps the pages, the panels, the lines and the bubbles at what the checker allows', () => {
    const many = T.cleanComic({ title: 'T', pages: Array.from({ length: 9 }, () => ({ panels: Array.from({ length: 14 }, () => desk({ lines: Array.from({ length: 9 }, (_, i) => `l${i}`), bubbles: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] })) })) })!;
    expect(many.pages).toHaveLength(6);
    expect(many.pages[0]!.panels).toHaveLength(9);
    expect(many.pages[0]!.panels[0]!.lines).toHaveLength(6);
    expect(many.pages[0]!.panels[0]!.bubbles).toHaveLength(2);
  });

  it('gives every scene a default background that the kit knows', () => {
    expect(Object.keys(T.DEFAULT_BG).sort()).toEqual(['desk', 'duo', 'message', 'portrait', 'screen', 'you']);
    for (const bg of Object.values(T.DEFAULT_BG)) expect(['ice', 'sand', 'mint', 'navy', 'lilac', 'cobalt', 'rose']).toContain(bg);
  });
});
