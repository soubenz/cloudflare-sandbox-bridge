import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FILM, V2 } from '../e2e/comic-fixture';

/**
 * The motion comic player (dashboard/src/comic.js) mounted on a small stand-in for the DOM: what a panel is made
 * of (the picture layer the camera's close shot pushes in, and the words over it, which never move), the Full
 * screen button, and "Continuing…" after a comic that played to its end. The clock is driven through the test seam
 * (`?comicTest=1`, window.__comicClock) and a hand-cranked requestAnimationFrame.
 */

// ---------------------------------------------------------------------------
// A stand-in for the DOM: enough of it for the player
// ---------------------------------------------------------------------------

type Listener = (e: FakeEvent) => void;
type FakeEvent = { type: string; key?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; defaultPrevented?: boolean; preventDefault?: () => void };

class FakeStyle {
  props = new Map<string, string>();
  [k: string]: unknown;
  setProperty(k: string, v: string) {
    this.props.set(k, String(v));
  }
  removeProperty(k: string) {
    this.props.delete(k);
  }
  getPropertyValue(k: string) {
    return this.props.get(k) ?? '';
  }
}

class FakeEl {
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  listeners = new Map<string, Listener[]>();
  style = new FakeStyle();
  dataset: Record<string, string> = {};
  text = '';
  html = '';
  hidden = false;
  tabIndex = 0;
  type = '';
  id = '';
  disabled = false;
  /** Every element is as wide as a desktop learning card: the player reads its width from its root. */
  clientWidth = 1000;
  clientHeight = 0;
  offsetHeight = 40;
  [prop: string]: unknown;
  constructor(public tag: string, public doc: FakeDoc) {}
  get className() {
    return this.attrs.get('class') ?? '';
  }
  set className(v: string) {
    this.attrs.set('class', v);
  }
  setAttribute(k: string, v: string) {
    if (k === 'class') this.className = String(v);
    else this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  toggleAttribute(k: string, on?: boolean) {
    const want = on === undefined ? !this.attrs.has(k) : on;
    if (want) this.attrs.set(k, '');
    else this.attrs.delete(k);
    return want;
  }
  get classList() {
    const get = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const set = (s: Set<string>) => (this.className = [...s].join(' '));
    return {
      add: (...c: string[]) => set(new Set([...get(), ...c])),
      remove: (c: string) => {
        const s = get();
        s.delete(c);
        set(s);
      },
      contains: (c: string) => get().has(c),
      toggle: (c: string, on?: boolean) => {
        const s = get();
        const want = on === undefined ? !s.has(c) : on;
        if (want) s.add(c);
        else s.delete(c);
        set(s);
        return want;
      },
    };
  }
  append(...nodes: Array<FakeEl | string>) {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? this.doc.createTextNode(n) : n);
  }
  appendChild(c: FakeEl) {
    if (c.parent) c.parent.removeChild(c);
    c.parent = this;
    this.children.push(c);
    return c;
  }
  removeChild(c: FakeEl) {
    this.children = this.children.filter((x) => x !== c);
    c.parent = null;
    return c;
  }
  replaceChildren(...nodes: FakeEl[]) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    this.parent?.removeChild(this);
  }
  after(n: FakeEl) {
    const p = this.parent!;
    if (n.parent) n.parent.removeChild(n);
    n.parent = p;
    p.children.splice(p.children.indexOf(this) + 1, 0, n);
  }
  get parentNode() {
    return this.parent;
  }
  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }
  set textContent(v: string) {
    this.children = [];
    this.text = String(v);
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set innerHTML(v: string) {
    this.html = String(v);
  }
  get innerHTML() {
    return this.html;
  }
  querySelectorAll() {
    return [];
  }
  querySelector() {
    return null;
  }
  closest(sel: string) {
    const cls = sel.replace(/^\./, '');
    for (let n: FakeEl | null = this; n; n = n.parent) if (n.classList.contains(cls)) return n;
    return null;
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  /** Fires an event here and up the tree, as a bubbling DOM event would. */
  dispatch(e: FakeEvent) {
    const ev = { defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, ...e } as FakeEvent;
    ev.preventDefault = () => (ev.defaultPrevented = true);
    for (let n: FakeEl | null = this; n; n = n.parent) for (const fn of n.listeners.get(e.type) ?? []) fn(ev);
    return ev;
  }
  click() {
    if (!this.disabled) this.dispatch({ type: 'click' });
  }
  focus() {
    this.doc.activeElement = this;
  }
}

class FakeDoc {
  body: FakeEl;
  activeElement: FakeEl | null = null;
  hidden = false;
  fullscreenEnabled = true;
  fullscreenElement: FakeEl | null = null;
  exits = 0;
  listeners = new Map<string, Listener[]>();
  constructor() {
    this.body = new FakeEl('body', this);
  }
  createElement(tag: string) {
    return new FakeEl(tag, this);
  }
  createElementNS(_ns: string, tag: string) {
    return new FakeEl(tag, this);
  }
  createTextNode(text: string) {
    const t = new FakeEl('#text', this);
    t.text = text;
    return t;
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type });
  }
  exitFullscreen() {
    this.exits += 1;
    this.fullscreenElement = null;
    this.fire('fullscreenchange');
    return Promise.resolve();
  }
}

const walk = (el: FakeEl): FakeEl[] => [el, ...el.children.flatMap(walk)];
const byClass = (el: FakeEl, cls: string) => walk(el).filter((e) => e.classList.contains(cls));
const one = (el: FakeEl, cls: string) => byClass(el, cls)[0]!;
const within = (el: FakeEl, ancestor: FakeEl) => {
  for (let n: FakeEl | null = el; n; n = n.parent) if (n === ancestor) return true;
  return false;
};

// ---------------------------------------------------------------------------
// The page round the player
// ---------------------------------------------------------------------------

type Seam = {
  seek: (t: number) => void;
  resume: () => void;
  total: number;
  status: () => string;
  timeline: () => { pages: Array<{ panels: Array<{ number: number; scene: string; start: number; end: number; rect: { x: number; y: number; w: number; h: number }; push: { start: number; end: number } | null }> }> };
  ended: () => string | null;
  continuing: () => boolean;
  continueNow: () => void;
  fullscreen: () => boolean;
};
let doc: FakeDoc;
let frames: Array<(ts: number) => void>;
let search: string;
const { mountComic } = (await import('../../dashboard/src/comic.js' as string)) as {
  mountComic: (c: unknown, comic: unknown, o?: Record<string, unknown>) => { destroy: () => void };
};

beforeEach(() => {
  doc = new FakeDoc();
  frames = [];
  search = '?comicTest=1';
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', {
    get location() {
      return { search };
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn: (ts: number) => void) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('Audio', undefined);
  // a frame can go full screen
  (FakeEl.prototype as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = function (this: FakeEl) {
    this.doc.fullscreenElement = this;
    this.doc.fire('fullscreenchange');
    return Promise.resolve();
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (FakeEl.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
});

function mount(comic: unknown, opts: Record<string, unknown> = {}) {
  const host = doc.createElement('div');
  const handle = mountComic(host, comic, opts);
  const root = host.children[0]!;
  const seam = (globalThis as unknown as { window: { __comicClock?: Seam } }).window.__comicClock!;
  return { host, root, handle, seam };
}

/** Runs the clock as the browser would, a frame every 100 ms, until the comic has finished (or `max` frames). */
function playToEnd(seam: Seam, max = 5000) {
  seam.resume();
  let ts = 0;
  for (let i = 0; i < max && seam.status() === 'playing'; i++) {
    const fn = frames.shift();
    if (!fn) break;
    ts += 100;
    fn(ts);
  }
}

const buttons = (root: FakeEl) => walk(root).filter((e) => e.tag === 'button');
const label = (b: FakeEl) => b.textContent.trim();

// ---------------------------------------------------------------------------
// A panel: the picture moves, the words over it do not
// ---------------------------------------------------------------------------

describe('a clip panel is a film shot: the picture is pushed in, the words never move and are never cut', () => {
  it('puts the clip and the art in the picture layer, and the bubbles, caption, sfx and screen card in the safe area over it', () => {
    const { root } = mount(FILM);
    const fig = byClass(root, 'cm-pane').find((f) => f.dataset.panel === '1')!;
    const shot = one(fig, 'cm-shot');
    const over = one(fig, 'cm-over');
    expect(shot.parent).toBe(fig);
    expect(over.parent).toBe(fig);
    expect(within(one(fig, 'cm-clip'), shot)).toBe(true);
    expect(within(one(fig, 'cm-art'), shot)).toBe(true);
    for (const cls of ['cm-bub', 'cm-cap', 'cm-sfx', 'cm-card']) {
      const el = one(fig, cls);
      expect(within(el, over), cls).toBe(true);
      expect(within(el, shot), cls).toBe(false);
    }
    // the caption a lower-third clock tag, the bubble on the left, the card at the top right with both lines
    expect(one(fig, 'cm-cap').classList.contains('cm-caption--clock')).toBe(true);
    expect(within(one(fig, 'cm-bub'), one(fig, 'cm-over-l'))).toBe(true);
    expect(within(one(fig, 'cm-card'), one(fig, 'cm-over-r'))).toBe(true);
    expect(byClass(one(fig, 'cm-card'), 'cm-scrline').map((r) => r.textContent)).toEqual(['support assistant: down', 'search assistant: fine']);
    // no screen box laid over a drawn screen on a clip
    expect(byClass(fig, 'cm-lines')).toHaveLength(0);
    // two speakers: the second goes to the right, under the card
    const two = byClass(root, 'cm-pane').find((f) => f.dataset.panel === '2')!;
    const right = one(two, 'cm-over-r');
    expect(right.children.map((c) => c.classList.contains('cm-card') ? 'card' : c.classList.contains('cm-bub') ? 'bubble' : '?')).toEqual(['card', 'bubble']);
  });

  it('pushes in only the picture layer on a close shot, up to 1.08, by the clock; the words over it get no transform', () => {
    const { root, seam } = mount(FILM);
    const tp = seam.timeline().pages[0]!.panels[0]!;
    expect(tp.push).not.toBeNull();
    const fig = byClass(root, 'cm-pane').find((f) => f.dataset.panel === '1')!;
    const shot = one(fig, 'cm-shot');
    const over = one(fig, 'cm-over');
    seam.seek(tp.start + 0.1);
    expect(shot.style.getPropertyValue('--zoom')).toBe('');
    const zooms = [0.35, 0.6, 0.95].map((f) => {
      seam.seek(tp.push!.start + f * (tp.push!.end - tp.push!.start));
      return Number(shot.style.getPropertyValue('--zoom'));
    });
    expect(zooms[0]).toBeGreaterThan(1);
    expect(zooms[1]).toBeGreaterThan(zooms[0]!);
    expect(zooms[2]).toBeGreaterThan(zooms[1]!);
    expect(zooms[2]).toBeLessThanOrEqual(1.08);
    // the overlay and everything in it carry no zoom, no transform
    for (const el of walk(over)) {
      expect(el.style.getPropertyValue('--zoom'), el.className).toBe('');
      expect(el.style.transform ?? '', el.className).toBe('');
    }
    // and nothing else in the panel is given the zoom
    expect(walk(fig).filter((e) => e.style.getPropertyValue('--zoom') !== '')).toEqual([shot]);
  });

  it('frames the whole clip panel with the camera, never closer, even on a close shot', () => {
    const { root, seam } = mount(FILM);
    const tp = seam.timeline().pages[0]!.panels[0]!;
    const reel = one(root, 'cm-reel');
    const stage = one(root, 'cm-stage');
    seam.seek(tp.end - 0.1);
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(String(reel.style.transform))!;
    const [tx, ty, k] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const h = parseFloat(String(stage.style.height));
    // the panel's four corners land inside the 1000-wide stage
    expect(tx + k * tp.rect.x).toBeGreaterThanOrEqual(0);
    expect(tx + k * (tp.rect.x + tp.rect.w)).toBeLessThanOrEqual(1000);
    expect(ty + k * tp.rect.y).toBeGreaterThanOrEqual(0);
    expect(ty + k * (tp.rect.y + tp.rect.h)).toBeLessThanOrEqual(h);
  });

  it('keeps the other scenes as they were: their words on the panel, a drawn screen\'s lines in the picture', () => {
    const { root } = mount(V2);
    const desk = byClass(root, 'cm-pane').find((f) => f.dataset.scene === 'desk')!;
    expect(byClass(desk, 'cm-over')).toHaveLength(0);
    for (const cls of ['cm-bub', 'cm-cap', 'cm-sfx']) expect(one(desk, cls).parent, cls).toBe(desk);
    expect(within(one(desk, 'cm-lines'), one(desk, 'cm-shot'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full screen
// ---------------------------------------------------------------------------

describe('Full screen', () => {
  it('is a button beside the others that puts the frame (stage and controls) full screen and back, pressed while it is', () => {
    const { root, seam } = mount(FILM);
    const controls = one(root, 'cm-controls');
    expect(buttons(controls).map(label)).toEqual(['Pause', 'Replay', 'Skip', 'Sound on', 'Full screen']);
    const btn = buttons(controls).find((b) => b.id === 'btnComicFullscreen')!;
    const frame = one(root, 'cm-frame');
    expect(within(one(root, 'cm-stage'), frame) && within(controls, frame)).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.click();
    expect(doc.fullscreenElement).toBe(frame);
    expect(seam.fullscreen()).toBe(true);
    expect(label(btn)).toBe('Exit full screen');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(root.hasAttribute('data-fullscreen')).toBe(true);
    btn.click();
    expect(doc.exits).toBe(1);
    expect(label(btn)).toBe('Full screen');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(root.hasAttribute('data-fullscreen')).toBe(false);
  });

  it('toggles on F with the comic focused, not with a modifier', () => {
    const { root } = mount(FILM);
    const frame = one(root, 'cm-frame');
    const replay = buttons(root).find((b) => b.id === 'btnComicReplay')!;
    replay.dispatch({ type: 'keydown', key: 'f', ctrlKey: true });
    expect(doc.fullscreenElement).toBeNull();
    const ev = replay.dispatch({ type: 'keydown', key: 'f' });
    expect(ev.defaultPrevented).toBe(true);
    expect(doc.fullscreenElement).toBe(frame);
    frame.dispatch({ type: 'keydown', key: 'F' });
    expect(doc.fullscreenElement).toBeNull();
  });

  it('sizes the stage to fit the screen above the controls, letterboxed, and keeps the camera working', () => {
    const { root, seam } = mount(FILM);
    const frame = one(root, 'cm-frame');
    const stage = one(root, 'cm-stage');
    frame.clientWidth = 1920;
    frame.clientHeight = 1080;
    buttons(root).find((b) => b.id === 'btnComicFullscreen')!.click();
    const w = parseFloat(String(stage.style.width));
    const h = parseFloat(String(stage.style.height));
    expect(w).toBeGreaterThan(1000);
    expect(w).toBeLessThanOrEqual(1920);
    expect(h).toBeLessThanOrEqual(1080 - 40);
    expect(w / h).toBeCloseTo(16 / 9, 1);
    // the finished comic is framed inside the screen, not run off it
    seam.seek(seam.total);
    expect(parseFloat(String(stage.style.height))).toBeLessThanOrEqual(1080 - 40);
  });

  it('is left when the comic goes', () => {
    const { root, handle } = mount(FILM);
    buttons(root).find((b) => b.id === 'btnComicFullscreen')!.click();
    expect(doc.fullscreenElement).not.toBeNull();
    handle.destroy();
    expect(doc.exits).toBe(1);
    expect(doc.listeners.get('fullscreenchange') ?? []).toHaveLength(0);
  });

  it('is not offered where the browser cannot do it', () => {
    doc.fullscreenEnabled = false;
    const { root } = mount(FILM);
    expect(buttons(root).find((b) => b.id === 'btnComicFullscreen')).toBeUndefined();
    expect(buttons(one(root, 'cm-controls')).map(label)).toEqual(['Pause', 'Replay', 'Skip', 'Sound on']);
  });
});

// ---------------------------------------------------------------------------
// After the comic: on to the next step
// ---------------------------------------------------------------------------

describe('a comic that has played to its end continues by itself', () => {
  it('shows "Continuing…" with Stay here once the clock runs out, and in a test waits for continueNow', () => {
    const onContinue = vi.fn();
    const { root, seam } = mount(FILM, { onContinue });
    // nothing waits, and nothing is there to press, until the comic has played to its end
    expect(byClass(root, 'cm-next')).toHaveLength(0);
    playToEnd(seam);
    expect(seam.ended()).toBe('played');
    expect(seam.continuing()).toBe(true);
    const note = one(root, 'cm-next');
    expect(note.hidden).toBe(false);
    expect(note.parent).toBe(one(root, 'cm-frame'));
    expect(note.textContent).toContain('Continuing…');
    expect(buttons(note).map(label)).toEqual(['Stay here']);
    expect(onContinue).not.toHaveBeenCalled();
    seam.continueNow();
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(note.hidden).toBe(true);
    expect(byClass(root, 'cm-next')).toHaveLength(0);
    seam.continueNow();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('goes on after CONTINUE_MS outside a test, unless the learner presses Stay here', async () => {
    const { CONTINUE_MS } = (await import('../../dashboard/src/comic.js' as string)) as { CONTINUE_MS: number };
    expect(CONTINUE_MS).toBe(1500);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    search = '';
    const go = vi.fn();
    const first = mountComic(doc.createElement('div'), FILM, { onContinue: go });
    let ts = 0;
    for (let i = 0; i < 5000 && frames.length; i++) frames.shift()!((ts += 100));
    vi.advanceTimersByTime(CONTINUE_MS - 1);
    expect(go).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(go).toHaveBeenCalledTimes(1);
    first.destroy();

    const stay = vi.fn();
    const host = doc.createElement('div');
    const second = mountComic(host, FILM, { onContinue: stay });
    for (let i = 0; i < 5000 && frames.length; i++) frames.shift()!((ts += 100));
    const note = one(host, 'cm-next');
    expect(note.hidden).toBe(false);
    buttons(note)[0]!.click();
    expect(note.hidden).toBe(true);
    expect(byClass(host, 'cm-next')).toHaveLength(0);
    vi.advanceTimersByTime(CONTINUE_MS * 2);
    expect(stay).not.toHaveBeenCalled();
    second.destroy();
  });

  it('never after Skip, a seek to the end, or without somewhere to go', () => {
    const onContinue = vi.fn();
    const a = mount(FILM, { onContinue });
    buttons(a.root).find((b) => b.id === 'btnComicSkip')!.click();
    expect(a.seam.ended()).toBe('skipped');
    expect(a.seam.continuing()).toBe(false);
    a.handle.destroy();
    const b = mount(FILM, { onContinue });
    b.seam.seek(b.seam.total);
    expect(b.seam.ended()).toBe('seek');
    expect(b.seam.continuing()).toBe(false);
    b.handle.destroy();
    const c = mount(FILM);
    playToEnd(c.seam);
    expect(c.seam.ended()).toBe('played');
    expect(c.seam.continuing()).toBe(false);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('tells onDone how the comic finished', () => {
    const onDone = vi.fn();
    const { root, seam } = mount(FILM, { onDone });
    buttons(root).find((b) => b.id === 'btnComicSkip')!.click();
    expect(onDone).toHaveBeenCalledWith({ how: 'skipped' });
    expect(seam.status()).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// The text version
// ---------------------------------------------------------------------------

describe('the text version', () => {
  it('is for screen readers only: no disclosure to open, every panel listed in a visually hidden list', () => {
    const { root } = mount(FILM);
    expect(walk(root).filter((e) => e.tag === 'details' || e.tag === 'summary')).toHaveLength(0);
    const text = one(root, 'cm-text');
    expect(text.classList.contains('sr-only')).toBe(true);
    expect(byClass(text, 'cm-transcript')[0]!.children).toHaveLength(FILM.pages[0]!.panels.length);
    // the diagram panels read only the steps they show
    const items = byClass(text, 'cm-transcript')[0]!.children.map((li) => li.textContent);
    expect(items[4]).toMatch(/^Panel 5\. .*Diagram: [^.]+\. [^.]+\.$/);
  });
});
