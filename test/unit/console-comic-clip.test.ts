import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CLIPS, KNOWN_CLIPS, parseClipLibrary } from '../../src/labs/clip';

/**
 * The clip scene (`scene: clip`): a short animation of the shared clip library (packages/catalogue/clips.json,
 * files in dashboard/public/media/clips/) under a panel's bubbles, caption, sound effect and screen lines. The
 * library and where its files are served; the schedule (dashboard/src/comic-timeline.js: when a clip plays, the
 * frame at any second, cues on a clip panel); the art and the picture (dashboard/src/comic-art.js, against a small
 * stand-in for the DOM); and what the player and its CSS promise (comic.js, comic.css).
 */

type Rect = { x: number; y: number; w: number; h: number };
type TClip = { id: string; kind: string; loop: boolean; seconds?: number; start: number; end: number };
type TPanel = {
  number: number;
  rect: Rect;
  push: { start: number; end: number } | null;
  scene: string;
  start: number;
  end: number;
  dur: number;
  popAt: number;
  captionAt: number | null;
  sfxAt: number | null;
  focusAt: number | null;
  bubbles: Array<{ start: number; end: number; wordTimes: number[] }>;
  lines: Array<{ start: number; end: number }>;
  shot: string | null;
  clip: TClip | null;
};
type Timeline = {
  total: number;
  shots: Array<{ kind: string }>;
  reel: { w: number; h: number };
  pages: Array<{ panels: TPanel[] }>;
  audio: Array<{ panel: number; start: number; end: number; seconds: number }>;
  stings: Array<{ panel: number; sound: string; at: number }>;
  clips: Array<{ panel: number; id: string; start: number; end: number }>;
};
const T = (await import('../../dashboard/src/comic-timeline.js' as string)) as {
  SCREENS: Record<string, { lines: Rect; device: Rect }>;
  DEFAULT_BG: Record<string, string>;
  CLIP_LAST_FRAME: number;
  cleanComic: (raw: unknown) => { title: string; pages: Array<{ panels: Array<Record<string, any>> }> } | null;
  buildTimeline: (c: unknown, o?: { audio?: unknown }) => Timeline;
  transcriptOf: (c: unknown) => string[];
  clipFor: (id: unknown) => { id: string; kind: string; src: string; poster?: string; alt: string; seconds?: number; loop: boolean; aspect: number } | undefined;
  clipTimeAt: (clip: Partial<TClip> | null, t: number, duration?: number) => number;
  clipPlaying: (clip: TClip | null, t: number) => boolean;
  clipProgress: (clip: TClip | null, t: number) => number;
  clipAspect: (c: unknown) => number;
  clipPanelHeight: (panel: unknown, w: number) => number;
  CLIP_ASPECT: number;
  CLOSE_ZOOM: number;
  pictureZoom: (p: unknown, t: number) => number;
  viewportAt: (tl: unknown, t: number, w: number, maxH?: number) => { w: number; h: number };
  cameraAt: (tl: unknown, t: number, vp: { w: number; h: number }) => { cx: number; cy: number; k: number };
  fitWidth: (w: number, h: number) => number;
  REEL: { shotPad: number };
  TIMING: { move: number };
};
const A = (await import('../../dashboard/src/comic-art.js' as string)) as {
  ART: { h: number; wide: number; square: number };
  artWidth: (scene: string) => number;
  sceneArt: (p: Record<string, unknown>) => { svg: string; lines: Rect | null; viewBox: string; width: number; height: number };
  clipMedia: (doc: unknown, clip: unknown, o?: { still?: boolean }) => FakeEl;
  clipVideo: (root: unknown) => FakeEl | null;
  clipOf: (panel: unknown) => { id: string } | null;
};
const fixture = await import('../e2e/comic-fixture');
const withSlug = (a: ReturnType<typeof fixture.narrationOf>) => ({ ...a, slug: 'fixture' });
const panelsOf = (tl: Timeline) => tl.pages.flatMap((p) => p.panels);
const css = readFileSync('dashboard/public/comic.css', 'utf8');
const player = readFileSync('dashboard/src/comic.js', 'utf8');
const STILL = 'night-office-still';

// ---------------------------------------------------------------------------
// The library and its files
// ---------------------------------------------------------------------------

describe('the clip library (packages/catalogue/clips.json)', () => {
  it('parses, with ids like a diagram\'s, unique, and a clip of each entry the console can play', () => {
    expect(CLIPS.length).toBeGreaterThan(0);
    for (const c of CLIPS) {
      expect(c.id).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
      expect(KNOWN_CLIPS.has(c.id)).toBe(true);
      expect(T.clipFor(c.id), c.id).toMatchObject({ id: c.id, kind: c.kind, src: c.src, alt: c.alt });
    }
    expect(KNOWN_CLIPS.has(STILL)).toBe(true);
  });

  it('keeps every file in dashboard/public/media/clips, tracked, of the type its name says and well under the asset limit', () => {
    const MAX = 25 * 1024 * 1024; // the largest single static asset Workers serves
    const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
    const starts = (b: Uint8Array, bytes: number[]) => bytes.every((x, k) => b[k] === x);
    const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
      png: (b) => starts(b, [137, 80, 78, 71, 13, 10, 26, 10]),
      webp: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
      jpg: (b) => starts(b, [0xff, 0xd8]),
      jpeg: (b) => starts(b, [0xff, 0xd8]),
      avif: (b) => ascii(b, 4, 12) === 'ftypavif',
      mp4: (b) => ascii(b, 4, 8) === 'ftyp',
      webm: (b) => starts(b, [0x1a, 0x45, 0xdf, 0xa3]),
    };
    for (const c of CLIPS) {
      for (const src of [c.src, c.poster].filter((s): s is string => Boolean(s))) {
        expect(src.startsWith('/media/clips/'), src).toBe(true);
        const file = join('dashboard/public', src);
        const size = statSync(file).size;
        expect(size, src).toBeGreaterThan(0);
        expect(size, src).toBeLessThan(MAX);
        const ext = src.split('.').pop()!;
        expect(MAGIC[ext]!(new Uint8Array(readFileSync(file))), src).toBe(true);
        // not git-ignored, so a fresh clone (and a deploy from it) has it
        expect(() => execFileSync('git', ['check-ignore', '-q', file]), src).toThrow();
      }
    }
  });

  it('is served by the console as static assets at /media/clips/<file>, behind the sign-in like every asset', () => {
    const wrangler = readFileSync('dashboard/wrangler.jsonc', 'utf8');
    expect(wrangler).toMatch(/"directory": "\.\/public"/);
    const worker = readFileSync('dashboard/src/worker.js', 'utf8');
    expect(worker).toContain('return env.ASSETS.fetch(request);');
    // the CSP lets the page load a video and an image of its own origin
    expect(worker).toContain("\"default-src 'self'\"");
    expect(worker).toContain("\"img-src 'self' data:\"");
    expect(worker).not.toMatch(/media-src/);
  });

  it('refuses an entry that is not a clip: a path outside /media/clips, the wrong kind of file, a looping still, a twin', () => {
    const ok = { id: 'x', kind: 'video', src: '/media/clips/x.mp4', alt: 'X.', loop: true, poster: '/media/clips/x.webp', seconds: 4 };
    expect(parseClipLibrary({ clips: [ok] })).toHaveLength(1);
    const bad: Array<[string, Record<string, unknown>]> = [
      ['another folder', { ...ok, src: '/media/x.mp4' }],
      ['a way out', { ...ok, src: '/media/clips/../x.mp4' }],
      ['an address', { ...ok, src: 'https://example.com/x.mp4' }],
      ['an image as a video', { ...ok, src: '/media/clips/x.png' }],
      ['a video as an image', { ...ok, kind: 'image', src: '/media/clips/x.mp4', loop: undefined }],
      ['a looping still', { ...ok, kind: 'image', src: '/media/clips/x.png' }],
      ['a video poster', { ...ok, poster: '/media/clips/x.mp4' }],
      ['markup in the alt', { ...ok, alt: '<b>x</b>' }],
      ['an id that is not one', { ...ok, id: 'X Y' }],
      ['a field it does not know', { ...ok, autoplay: true }],
      ['another kind', { ...ok, kind: 'gif' }],
    ];
    for (const [what, c] of bad) expect(() => parseClipLibrary({ clips: [c] }), what).toThrow(/Invalid clip library/);
    expect(() => parseClipLibrary({ clips: [ok, ok] })).toThrow(/two clips share an id/);
    // the console does not take the library's word for it either
    expect(T.clipFor('__proto__')).toBeUndefined();
    expect(T.clipFor(5)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

describe('the clip panel on the comic\'s clock', () => {
  const clean = T.cleanComic(fixture.V2)!;
  const tl = T.buildTimeline(clean, { audio: withSlug(fixture.narrationOf(fixture.V2)) });
  const silent = T.buildTimeline(clean);
  const all = panelsOf(tl);
  const i = all.findIndex((p) => p.scene === 'clip');
  const cp = all[i]!;
  const clipOf = (n: number) => tl.audio.find((c) => c.panel === n)!;
  const vo = (fixture.V2.pages[0]!.panels[i]!.voiceover as string).toLowerCase();
  const said = (phrase: string, end = false) => {
    const c = clipOf(cp.number);
    const at = vo.indexOf(phrase.toLowerCase());
    return c.start + ((end ? at + phrase.length : at) / vo.length) * c.seconds;
  };

  it('cleans a clip panel: its clip id, its speakers (not drawn), its words; an unknown clip keeps the panel on a plain card', () => {
    const p = clean.pages[0]!.panels[i]!;
    expect(p.scene).toBe('clip');
    expect(p.clip).toBe(STILL);
    expect(p.cast).toEqual(['tomasz']);
    expect(p.bubbles).toEqual([{ who: 'tomasz', text: 'There you are.', cue: 'one line' }]);
    expect(p.lines).toEqual(['team: search']);
    expect(p.lineCues).toEqual(['the gateway log']);
    const unknown = T.cleanComic({ title: 'T', pages: [{ panels: [{ scene: 'clip', clip: 'no-such', bubbles: [], caption: 'Still here.' }] }] })!;
    expect(unknown.pages[0]!.panels[0]).toMatchObject({ scene: 'clip', caption: 'Still here.' });
    expect(unknown.pages[0]!.panels[0]!.clip).toBeUndefined();
    expect(T.buildTimeline(unknown).clips).toEqual([]);
    // a clip on another scene is not carried
    expect(T.cleanComic({ title: 'T', pages: [{ panels: [{ scene: 'portrait', cast: ['maren'], clip: STILL, bubbles: [] }] }] })!.pages[0]!.panels[0]!.clip).toBeUndefined();
    expect(T.DEFAULT_BG.clip).toBe('night');
  });

  it('lists the clip schedule: the clip plays from its panel\'s start to its end, narrated or not', () => {
    expect(tl.clips).toEqual([{ panel: cp.number, id: STILL, start: cp.start, end: cp.end }]);
    expect(cp.clip).toEqual({ id: STILL, kind: 'image', loop: false, seconds: 6, start: cp.start, end: cp.end });
    for (const p of all) if (p !== cp) expect(p.clip, p.scene).toBeNull();
    const q = panelsOf(silent)[i]!;
    expect(silent.clips).toEqual([{ panel: q.number, id: STILL, start: q.start, end: q.end }]);
  });

  it('times its caption, sfx, screen line and bubble to the storyteller\'s words, like any panel', () => {
    expect(cp.captionAt).toBeCloseTo(said('late on sunday'), 9);
    expect(cp.sfxAt).toBeCloseTo(said('opened'), 9);
    expect(cp.lines[0]!.start).toBeCloseTo(said('the gateway log'), 9);
    expect(cp.bubbles[0]!.start).toBeCloseTo(said('one line', true), 9);
    // no sound on its sfx: no sting
    expect(tl.stings.map((s) => s.panel)).not.toContain(cp.number);
  });

  it('is timed exactly as the same words on a desk would be: a clip never changes when anything happens', () => {
    const asDesk = { ...fixture.V2, pages: [{ panels: fixture.V2.pages[0]!.panels.map((p, k) => (k === i ? { ...p, scene: 'desk', clip: undefined, cast: ['tomasz'] } : p)) }] };
    const other = panelsOf(T.buildTimeline(T.cleanComic(asDesk)!, { audio: withSlug(fixture.narrationOf(asDesk as never)) }))[i]!;
    for (const k of ['start', 'end', 'dur', 'popAt', 'captionAt', 'sfxAt', 'bubbles', 'lines'] as const) expect(cp[k], k).toEqual(other[k]);
    expect(tl.total).toBeCloseTo(T.buildTimeline(T.cleanComic(asDesk)!, { audio: withSlug(fixture.narrationOf(asDesk as never)) }).total, 9);
  });

  it('never moves the camera inside a clip panel: no push-in on its screen card, which is set to be read from the whole panel', () => {
    expect(cp.focusAt).toBeNull();
    expect(T.SCREENS.clip).toBeUndefined();
    for (const w of [380, 1000]) {
      const vp = T.viewportAt(tl, cp.start, w);
      for (const t of [cp.start + T.TIMING.move + 0.01, (cp.start + cp.end) / 2, cp.end - 0.01]) {
        const cam = T.cameraAt(tl, t, vp);
        // the whole panel is in frame: its centre in the middle, the camera no closer than its framing
        expect(cam.cx).toBeCloseTo(cp.rect.x + cp.rect.w / 2, 6);
        expect(cam.k * (cp.rect.w + 2 * T.REEL.shotPad)).toBeLessThanOrEqual(vp.w + 1e-6);
        expect(cam.k * (cp.rect.h + 2 * T.REEL.shotPad)).toBeLessThanOrEqual(vp.h + 1e-6);
      }
    }
  });

  it('reads the clip\'s alt first in the transcript', () => {
    expect(T.transcriptOf(clean)[i]).toBe(
      `Panel ${i + 1}. ${T.clipFor(STILL)!.alt} Sunday, 23:47. ${fixture.V2.pages[0]!.panels[i]!.voiceover} Tomas: There you are. On screen: team: search`
    );
  });

  it('gives the frame to show at any second as a pure function of the clock: seek, Replay and Skip land where playing would', () => {
    const loop: TClip = { id: 'v', kind: 'video', loop: true, seconds: 4, start: 10, end: 20 };
    const once: TClip = { ...loop, loop: false };
    // before the panel: the first frame; during: the time into the panel, round the clip
    expect(T.clipTimeAt(loop, 0, 4)).toBe(0);
    expect(T.clipTimeAt(loop, 10, 4)).toBe(0);
    expect(T.clipTimeAt(loop, 11.5, 4)).toBeCloseTo(1.5, 9);
    expect(T.clipTimeAt(loop, 15.25, 4)).toBeCloseTo(1.25, 9);
    // a clip that does not loop rests on its last frame once it is over
    expect(T.clipTimeAt(once, 11.5, 4)).toBeCloseTo(1.5, 9);
    expect(T.clipTimeAt(once, 15.25, 4)).toBeCloseTo(4 - T.CLIP_LAST_FRAME, 9);
    // from the panel's end on (and so on Skip, at the comic's end): the last frame
    expect(T.clipTimeAt(loop, 20, 4)).toBeCloseTo(4 - T.CLIP_LAST_FRAME, 9);
    expect(T.clipTimeAt(loop, 999, 4)).toBeCloseTo(4 - T.CLIP_LAST_FRAME, 9);
    // the video's own length wins over the library's once it is known; with neither, the first frame
    expect(T.clipTimeAt(loop, 13, 2.5)).toBeCloseTo(0.5, 9);
    expect(T.clipTimeAt(loop, 13, Number.NaN)).toBeCloseTo(3, 9);
    expect(T.clipTimeAt({ ...loop, seconds: undefined }, 13, undefined)).toBe(0);
    expect(T.clipTimeAt(null, 13, 4)).toBe(0);
    // the same t gives the same frame, whatever came before
    expect(T.clipTimeAt(loop, 17.3, 4)).toBe(T.clipTimeAt(loop, 17.3, 4));
    // it plays while its panel is on, and a still is pushed in by the panel's progress
    expect([9.99, 10, 19.99, 20].map((t) => T.clipPlaying(loop, t))).toEqual([false, true, true, false]);
    expect(T.clipPlaying(null, 12)).toBe(false);
    expect([0, 10, 15, 20, 30].map((t) => T.clipProgress(loop, t))).toEqual([0, 0, 0.5, 1, 1]);
    expect(T.clipProgress(null, 15)).toBe(0);
  });
});

describe('a clip panel is the clip\'s own shape, and a close shot pushes in the picture, never the camera', () => {
  const film = T.cleanComic(fixture.FILM)!;
  const tl = T.buildTimeline(film);
  const [phone, laptop, card] = panelsOf(tl);

  it('reads a clip\'s shape: its aspect, else its size in pixels, else 16:9', () => {
    expect(T.CLIP_ASPECT).toBeCloseTo(16 / 9, 9);
    expect(T.clipAspect({ aspect: '4:3', width: 1, height: 1 })).toBeCloseTo(4 / 3, 9);
    expect(T.clipAspect({ width: 1344, height: 752 })).toBeCloseTo(1344 / 752, 9);
    expect(T.clipAspect({ aspect: 2.4 })).toBeCloseTo(2.4, 9);
    for (const junk of [undefined, null, {}, { aspect: 'wide' }, { aspect: '1:0' }, { aspect: '100:1' }, { width: 0, height: 5 }]) expect(T.clipAspect(junk), JSON.stringify(junk)).toBeCloseTo(16 / 9, 9);
    expect(T.clipFor('phone-alert-night')!.aspect).toBeCloseTo(1344 / 752, 9);
    expect(T.clipFor(STILL)!.aspect).toBeCloseTo(960 / 440, 9);
  });

  it('draws a clip panel as tall as its clip needs (a 16:9 clip whole), the rows under it moved down', () => {
    expect(phone!.rect.h).toBeCloseTo(phone!.rect.w / (1344 / 752), 6);
    expect(laptop!.rect.h).toBeCloseTo(laptop!.rect.w / (1344 / 752), 6);
    expect(laptop!.rect.y).toBeCloseTo(phone!.rect.y + phone!.rect.h + 22, 6);
    expect(card!.rect.h).toBe(320);
    expect(card!.rect.y).toBeCloseTo(laptop!.rect.y + laptop!.rect.h + 22, 6);
    // never shorter than the page's row (the still is wider than the panel) nor taller than 4:3
    expect(T.clipPanelHeight({ scene: 'clip', clip: STILL }, 696)).toBe(320);
    expect(T.clipPanelHeight({ scene: 'clip', clip: 'no-such' }, 696)).toBeCloseTo(696 / (16 / 9), 6);
    // the V2 comic's still panel is laid out as before
    const v2 = panelsOf(T.buildTimeline(T.cleanComic(fixture.V2)!)).find((p) => p.scene === 'clip')!;
    expect(v2.rect.h).toBe(320);
  });

  it('has no camera push-in: a close panel\'s picture is pushed in from the camera\'s arrival to its end, gently, by the clock', () => {
    expect(tl.shots.filter((s) => s.kind === 'close')).toHaveLength(0);
    expect(phone!.push).toEqual({ start: phone!.start + T.TIMING.move, end: phone!.end });
    expect(card!.push).toBeNull();
    expect(T.CLOSE_ZOOM).toBeCloseTo(1.08, 9);
    const at = (f: number) => T.pictureZoom(phone, phone!.push!.start + f * (phone!.push!.end - phone!.push!.start));
    expect(T.pictureZoom(phone, phone!.start)).toBe(1);
    expect(at(0.25)).toBeGreaterThan(1);
    expect(at(0.75)).toBeGreaterThan(at(0.25));
    expect(at(1)).toBeCloseTo(T.CLOSE_ZOOM, 9);
    expect(T.pictureZoom(phone, tl.total)).toBeCloseTo(T.CLOSE_ZOOM, 9);
    expect(T.pictureZoom(card, card!.end)).toBe(1);
    // a still is pushed in slowly over its panel, to the same most
    const v2 = panelsOf(T.buildTimeline(T.cleanComic(fixture.V2)!)).find((p) => p.scene === 'clip')!;
    expect(T.pictureZoom(v2, v2.start)).toBe(1);
    expect(T.pictureZoom(v2, (v2.start + v2.end) / 2)).toBeCloseTo(1 + (T.CLOSE_ZOOM - 1) / 2, 9);
    expect(T.pictureZoom(v2, v2.end)).toBeCloseTo(T.CLOSE_ZOOM, 9);
  });

  it('frames the whole panel at every moment of a close shot, in a wide and a narrow container', () => {
    for (const w of [380, 1000, 1848]) {
      const vp = T.viewportAt(tl, phone!.start, w);
      for (const t of [phone!.start + T.TIMING.move, (phone!.start + phone!.end) / 2, phone!.end - 0.01]) {
        const cam = T.cameraAt(tl, t, vp);
        expect(cam.k * phone!.rect.w, `${w} at ${t}`).toBeLessThanOrEqual(vp.w + 1e-6);
        expect(cam.k * phone!.rect.h, `${w} at ${t}`).toBeLessThanOrEqual(vp.h + 1e-6);
        expect(Math.abs(cam.cx - (phone!.rect.x + phone!.rect.w / 2)) * cam.k).toBeLessThan(1e-6);
      }
    }
  });

  it('fits a full-screen frame to the screen at the shape the width plays at, and holds the viewport under its height', () => {
    expect(T.fitWidth(1920, 1000)).toBe(1777);
    expect(T.fitWidth(1280, 650)).toBe(1155);
    expect(T.fitWidth(700, 1000)).toBe(700);
    expect(T.fitWidth(0, 500)).toBe(0);
    const end = T.viewportAt(tl, tl.total, 1777, 1000);
    expect(end.h).toBe(1000);
    expect(T.viewportAt(tl, 0, 1777, 1000).h).toBeCloseTo(1777 / (16 / 9), 6);
  });
});

// ---------------------------------------------------------------------------
// The art and the picture
// ---------------------------------------------------------------------------

class FakeEl {
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  listeners = new Map<string, Array<() => void>>();
  text = '';
  [prop: string]: unknown;
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  get classList() {
    const get = () => new Set((this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
    return {
      add: (c: string) => this.setAttribute('class', [...get().add(c)].join(' ')),
      contains: (c: string) => get().has(c),
    };
  }
  appendChild(c: FakeEl) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  removeChild(c: FakeEl) {
    this.children = this.children.filter((x) => x !== c);
    c.parent = null;
    return c;
  }
  get parentNode() {
    return this.parent;
  }
  set textContent(v: string) {
    this.text = String(v);
  }
  get textContent() {
    return this.text;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string) {
    const fns = this.listeners.get(type) ?? [];
    this.listeners.delete(type); // every listener here is { once: true }
    for (const fn of fns) fn();
  }
}
const doc = { createElement: (t: string) => new FakeEl(t) };
const walk = (el: FakeEl): FakeEl[] => [el, ...el.children.flatMap(walk)];
const media = (root: FakeEl) => walk(root).filter((e) => e.classList.contains('cm-clip-media'));
const VIDEO = { id: 'v', kind: 'video', src: '/media/clips/v.mp4', poster: '/media/clips/v.webp', alt: 'A server room, lights blinking.', loop: true, seconds: 4 };

describe('the clip card\'s art', () => {
  it('is a wide panel that draws nobody and none of a lab\'s words: a shade for the words, no screen (the player sets the card)', () => {
    expect(A.artWidth('clip')).toBe(A.ART.wide);
    const bare = A.sceneArt({ scene: 'clip', cast: ['maren', 'tomasz'], clip: STILL, bubbles: [{ text: 'evil <img>' }], caption: 'x' });
    expect(bare.viewBox).toBe(`0 0 ${A.ART.wide} 320`);
    expect(bare.svg).toContain('class="cm-clip-shade"');
    expect(bare.svg).not.toContain('cm-clip-card');
    expect(bare.svg).not.toContain('data-cast'); // the speakers are not drawn
    expect(bare.svg).not.toContain(STILL);
    expect(bare.svg).not.toContain('/media/');
    const card = A.sceneArt({ scene: 'clip', cast: [], clip: STILL, bubbles: [], lines: ['team: search'] });
    expect(card.svg).not.toContain('cm-clip-card');
    expect(card.lines).toBeNull();
    expect(card.svg).not.toContain('team: search');
  });

  it('builds a muted, inline video that is never told to play here: preload metadata, the library\'s loop and poster', () => {
    const root = A.clipMedia(doc, VIDEO);
    expect(root.getAttribute('class')).toBe('cm-clip cm-clip--video');
    expect(root.getAttribute('data-clip')).toBe('v');
    const v = A.clipVideo(root)!;
    expect(v.tag).toBe('video');
    expect(v.muted).toBe(true);
    expect(v.playsInline).toBe(true);
    expect(v.loop).toBe(true);
    for (const a of ['muted', 'playsinline', 'loop']) expect(v.hasAttribute(a), a).toBe(true);
    expect(v.getAttribute('preload')).toBe('metadata');
    expect(v.getAttribute('poster')).toBe(VIDEO.poster);
    expect(v.getAttribute('src')).toBe(VIDEO.src);
    expect(v.hasAttribute('controls')).toBe(false);
    expect(v.hasAttribute('autoplay')).toBe(false);
    // the alt is there, as text, for when the clip cannot be shown
    const alt = walk(root).find((e) => e.classList.contains('cm-clip-alt'))!;
    expect(alt.textContent).toBe(VIDEO.alt);
    // a clip that does not loop does not
    expect(A.clipVideo(A.clipMedia(doc, { ...VIDEO, loop: false }))!.hasAttribute('loop')).toBe(false);
  });

  it('builds a still as an image the CSS pushes in, with an empty alt (the transcript reads the clip\'s)', () => {
    const lib = T.clipFor(STILL)!;
    const root = A.clipMedia(doc, lib);
    expect(A.clipVideo(root)).toBeNull();
    const [img] = media(root);
    expect(img!.tag).toBe('img');
    expect(img!.getAttribute('class')).toBe('cm-clip-media cm-clip-kb');
    expect(img!.getAttribute('src')).toBe(lib.src);
    expect(img!.getAttribute('alt')).toBe('');
    expect(A.clipOf({ clip: STILL })!.id).toBe(STILL);
    expect(A.clipOf({ clip: 'nope' })).toBeNull();
  });

  it('under reduced motion shows a video\'s poster, still, and a still without the push-in', () => {
    const [poster] = media(A.clipMedia(doc, VIDEO, { still: true }));
    expect(poster!.tag).toBe('img');
    expect(poster!.getAttribute('src')).toBe(VIDEO.poster);
    expect(poster!.getAttribute('class')).toBe('cm-clip-media cm-clip-poster');
    const [img] = media(A.clipMedia(doc, T.clipFor(STILL)!, { still: true }));
    expect(img!.getAttribute('class')).not.toContain('cm-clip-kb');
    // a video with no poster stays a video, which the player never plays under reduced motion
    expect(A.clipVideo(A.clipMedia(doc, { ...VIDEO, poster: undefined }, { still: true }))).not.toBeNull();
  });

  it('falls back from a clip that fails to its poster, and from there to a dark card that reads the alt: never a broken comic', () => {
    const root = A.clipMedia(doc, VIDEO);
    A.clipVideo(root)!.fire('error');
    expect(A.clipVideo(root)).toBeNull();
    const [poster] = media(root);
    expect(poster!.getAttribute('src')).toBe(VIDEO.poster);
    expect(root.classList.contains('cm-clip-failed')).toBe(false);
    poster!.fire('error');
    expect(media(root)).toHaveLength(0);
    expect(root.classList.contains('cm-clip-failed')).toBe(true);
    // no poster: straight to the dark card
    const still = A.clipMedia(doc, T.clipFor(STILL)!);
    media(still)[0]!.fire('error');
    expect(still.classList.contains('cm-clip-failed')).toBe(true);
    expect(media(still)).toHaveLength(0);
    // and a clip the library does not have is that card from the start
    for (const junk of [undefined, null, {}, { kind: 'gif', src: '/x' }]) {
      const none = A.clipMedia(doc, junk);
      expect(none.getAttribute('class'), JSON.stringify(junk)).toBe('cm-clip cm-clip-failed');
      expect(none.children).toHaveLength(0);
    }
  });

  it('never puts a lab\'s words into markup: the alt is text, the source an attribute of a library path', () => {
    const root = A.clipMedia(doc, { ...VIDEO, alt: '<img src=x onerror=alert(1)>' });
    const alt = walk(root).find((e) => e.classList.contains('cm-clip-alt'))!;
    expect(alt.textContent).toBe('<img src=x onerror=alert(1)>');
    // the only image is the blurred backdrop, of the library's poster
    const imgs = walk(root).filter((e) => e.tag === 'img');
    expect(imgs.map((i) => [i.getAttribute('class'), i.getAttribute('src'), i.getAttribute('alt')])).toEqual([['cm-clip-back', VIDEO.poster, '']]);
  });

  it('lays a blurred copy of the picture under it (the poster, or the still), which goes if it fails, and with the picture', () => {
    const v = A.clipMedia(doc, VIDEO);
    const back = walk(v).find((e) => e.classList.contains('cm-clip-back'))!;
    expect(back.getAttribute('aria-hidden')).toBe('true');
    expect(v.children.indexOf(back)).toBeLessThan(v.children.indexOf(A.clipVideo(v)!)); // under the video
    back.fire('error');
    expect(walk(v).some((e) => e.classList.contains('cm-clip-back'))).toBe(false);
    expect(A.clipVideo(v)).not.toBeNull();
    const still = A.clipMedia(doc, T.clipFor(STILL)!);
    expect(walk(still).find((e) => e.classList.contains('cm-clip-back'))!.getAttribute('src')).toBe(T.clipFor(STILL)!.src);
    media(still)[0]!.fire('error');
    expect(walk(still).some((e) => e.classList.contains('cm-clip-back'))).toBe(false);
    // a video with no poster has none
    expect(walk(A.clipMedia(doc, { ...VIDEO, poster: undefined })).some((e) => e.classList.contains('cm-clip-back'))).toBe(false);
  });
});

describe('the player and its CSS', () => {
  it('lays the clip under the art and every word, and plays a video only on the comic\'s clock, never in a test', () => {
    const build = player.slice(player.indexOf('function buildPanel'));
    expect(build.indexOf('clipMedia(document, lib, { still })')).toBeGreaterThan(0);
    expect(build.indexOf('clipMedia(document, lib, { still })')).toBeLessThan(build.indexOf('const art = sceneArt(panel)'));
    expect(player).toContain('(testMode || running()) && clipPlaying(c.tc, clock.t)');
    expect(player).toContain('if (want && !testMode) {');
    expect(player).toMatch(/!reduced && !userPaused && clock\.status === 'playing'/);
    expect(player).toContain('clips: tl.clips.map((c) => ({ ...c })),');
    expect(player).toContain('clipLog: () => clipLog.slice(),');
    // the only play() a clip gets is in the one branch a test never takes
    expect(player.match(/v\.play\(\)/g)).toHaveLength(1);
  });

  it('shows the whole clip (never cropped), pushes the picture layer in by --zoom, and holds it still under reduced motion', () => {
    expect(css).toMatch(/\.cm-clip-media \{[^}]*object-fit: contain;/);
    expect(css).toMatch(/\.cm-clip-back \{[^}]*filter: blur/);
    expect(css).toMatch(/\.cm-shot \{[^}]*transform: scale\(var\(--zoom, 1\)\)/);
    expect(css).not.toMatch(/--kb/);
    expect(css).toContain('.cm[data-reduced] .cm-shot { transform: none; }');
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{[^}]*\}\s*\.cm-shot \{ transform: none !important; \}/);
    // the words of a clip sit in a safe area 5% in, at most 45% of the panel a side, sized in the panel's own units
    expect(css).toMatch(/\.cm-scene-clip \{ container-type: size; \}/);
    expect(css).toMatch(/\.cm-over \{[^}]*inset: 5%;/);
    expect(css).toMatch(/\.cm-over \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.cm-over \.cm-bub \{[^}]*max-width: 100%;[^}]*cqw/);
    expect(css).toMatch(/\.cm-card \{[^}]*max-width: 89%;[^}]*cqw/);
    expect(css).toMatch(/\.cm-card \.cm-scrline \{ white-space: pre-wrap; overflow-wrap: anywhere; \}/);
    expect(css).toContain('.cm-clip-failed .cm-clip-alt { display: flex; }');
    expect(css).toMatch(/\.cm-scene-clip \{ --cm-pbg: var\(--cm-black\); --cm-pfg: var\(--cm-fg-black\); \}/);
    // the alt on the dark card is a pair the contrast check already holds (fg-black-muted on black)
    expect(css).toMatch(/\.cm-clip-alt \{[^}]*color: var\(--cm-fg-black-muted\)/);
  });
});
