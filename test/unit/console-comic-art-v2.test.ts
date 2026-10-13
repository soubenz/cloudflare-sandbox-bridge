import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SCENES } from '../../src/labs/comic-kit';

/**
 * The motion comic's art, second round (dashboard/src/comic-art.js): moods and poses on the
 * busts, the night background, the black card, the diagram card and how its picture is
 * stepped, and the CSS that animates them (dashboard/public/comic.css). Strings of SVG are
 * checked without a browser; the diagram card runs against a small stand-in for the DOM.
 */
type Look = { mood?: string; pose?: string };
type Entry = string | ({ who: string } & Look);
type Panel = { scene: string; cast: Entry[]; prop: string; bubbles: unknown[]; bg?: string; diagram?: string; lines?: string[]; caption?: string };
type Art = { svg: string; lines: unknown; viewBox: string; width: number; height: number; stack?: { x: number; y: number; w: number; h: number } };
const A = (await import('../../dashboard/src/comic-art.js' as string)) as {
  MOODS: string[];
  POSES: string[];
  bust: (id: Entry, x: number, y: number, w: number, extra?: string, look?: Look) => string;
  castEntry: (c: unknown) => { who: string; mood?: string; pose?: string } | null;
  sceneArt: (p: Panel) => Art;
  artWidth: (scene: string) => number;
  diagramFor: (p: unknown) => { id: string; steps: unknown[] } | null;
  applyDiagramStep: (fig: unknown, p: unknown, step: unknown) => number;
  releaseDiagram: (fig: unknown) => void;
  isClockCaption: (t: unknown) => boolean;
};
const library = JSON.parse(readFileSync('packages/catalogue/diagrams.json', 'utf8')) as { diagrams: { id: string; steps: unknown[] }[] };
const css = readFileSync('dashboard/public/comic.css', 'utf8');

const ALL_SCENES = [...new Set([...Object.keys(SCENES), 'black', 'diagram'])];
const maxCast = (scene: string) => (SCENES as Record<string, { maxCast: number }>)[scene]?.maxCast ?? 0;
const panelFor = (scene: string, over: Partial<Panel> = {}): Panel => ({
  scene,
  cast: (['maren', 'tomasz'] as Entry[]).slice(0, maxCast(scene)),
  prop: 'none',
  bubbles: [],
  ...(scene === 'diagram' ? { diagram: library.diagrams[0]!.id } : {}),
  ...over,
});
const EVIL = '<img src=x onerror=alert(1)> "quoted" & more';

describe('moods and poses', () => {
  it('reads a cast entry written either way, and drops what it does not know', () => {
    expect(A.castEntry('maren')).toEqual({ who: 'maren' });
    expect(A.castEntry({ who: 'maren', mood: 'tired', pose: 'phone' })).toEqual({ who: 'maren', mood: 'tired', pose: 'phone' });
    expect(A.castEntry({ who: 'maren', mood: 'furious', pose: 'cartwheel' })).toEqual({ who: 'maren' });
    for (const junk of [null, undefined, 5, {}, { who: 3 }, []]) expect(A.castEntry(junk), JSON.stringify(junk)).toBeNull();
    expect(A.MOODS).toEqual(['tired', 'worried', 'pleased', 'surprised']);
    expect(A.POSES).toEqual(['phone', 'typing', 'shrug']);
  });

  it('draws a plain entry exactly as before: an object without mood or pose, or an unknown one, is the id', () => {
    for (const id of ['maren', 'tomasz', 'graham', 'ollie', 'jess', 'priya', 'jonas', 'anneke', 'you']) {
      const plain = A.bust(id, 10, 20, 120, 'cm-tilt');
      expect(A.bust({ who: id }, 10, 20, 120, 'cm-tilt'), id).toBe(plain);
      expect(A.bust({ who: id, mood: 'angry', pose: 'dance' }, 10, 20, 120, 'cm-tilt'), id).toBe(plain);
      expect(plain).not.toContain('cm-mood-');
      expect(plain).not.toContain('cm-pose-');
    }
  });

  it('gives every mood its own face, which still blinks and talks', () => {
    for (const id of ['maren', 'tomasz', 'graham', 'ollie', 'jess', 'priya', 'jonas', 'anneke']) {
      const faces = new Set([A.bust(id, 0, 0, 120)]);
      for (const mood of A.MOODS) {
        const svg = A.bust({ who: id, mood }, 0, 0, 120);
        expect(svg, `${id} ${mood}`).toContain(`cm-mood-${mood}`);
        expect(svg, `${id} ${mood}`).toContain('class="cm-eye"');
        expect(svg, `${id} ${mood}`).toContain('class="cm-mouth"');
        expect(svg, `${id} ${mood}`).toContain('class="cm-brow"');
        faces.add(svg.replace(/cm-mood-\w+/, ''));
      }
      expect(faces.size, id).toBe(A.MOODS.length + 1); // the drawing differs, not just the class
    }
    // what each mood is made of
    const face = (mood: string) => A.bust({ who: 'maren', mood }, 0, 0, 120);
    expect(face('tired')).toMatch(/<rect class="cm-mouth"[^>]*height="3.5"/); // a flat mouth
    expect(face('worried')).toMatch(/<ellipse class="cm-mouth"[^>]*rx="3.6"/); // a small o
    expect(face('pleased')).toContain('fill-opacity=".5"'); // lifted, blushing cheeks
    expect(face('surprised')).toMatch(/<g class="cm-eye"><circle[^>]*fill="#fff"/); // wide white eyes
    // Jonas keeps his heavy brows in every mood
    expect(A.bust({ who: 'jonas', mood: 'worried' }, 0, 0, 120)).toContain('class="cm-brow" d="M42 46.5L53 41.5');
    expect(A.bust({ who: 'jonas', mood: 'worried' }, 0, 0, 120)).toContain('stroke-width="5"');
  });

  it('gives every pose its own hands, for anybody including the learner', () => {
    for (const id of ['maren', 'graham', 'ollie', 'jess', 'priya', 'you']) {
      const shapes = new Set([A.bust(id, 0, 0, 120)]);
      for (const pose of A.POSES) {
        const svg = A.bust({ who: id, pose }, 0, 0, 120);
        expect(svg, `${id} ${pose}`).toContain(`cm-pose-${pose}`);
        shapes.add(svg.replace(/cm-pose-\w+/, ''));
      }
      expect(shapes.size, id).toBe(A.POSES.length + 1);
    }
    expect(A.bust({ who: 'maren', pose: 'phone' }, 0, 0, 120)).toContain('class="cm-glow"');
    expect(A.bust({ who: 'maren', pose: 'typing' }, 0, 0, 120).match(/class="cm-key/g)).toHaveLength(2);
    expect(A.bust({ who: 'maren', pose: 'shrug' }, 0, 0, 120)).not.toContain('M8 130c2-30 22-42 52-42s50 12 52 42z'); // the shoulders are up
    // a mood and a pose together; the `look` argument overrides the entry
    const both = A.bust({ who: 'tomasz', mood: 'tired', pose: 'typing' }, 0, 0, 120);
    expect(both).toContain('cm-mood-tired cm-pose-typing');
    expect(A.bust('tomasz', 0, 0, 120, '', { mood: 'tired', pose: 'typing' })).toBe(both);
  });

  it('puts moods and poses on the people of a scene', () => {
    const desk = A.sceneArt(panelFor('desk', { cast: [{ who: 'maren', mood: 'tired', pose: 'typing' }] })).svg;
    expect(desk).toContain('cm-mood-tired cm-pose-typing');
    expect(desk).toContain('data-cast="maren"');
    const duo = A.sceneArt(panelFor('duo', { cast: [{ who: 'maren', pose: 'shrug' }, 'tomasz'] })).svg;
    expect(duo).toContain('cm-pose-shrug');
    expect(duo).toContain('data-cast="tomasz"');
  });

  it('never writes a cast id that could break out of its attribute', () => {
    const svg = A.bust({ who: '"><script>alert(1)</script>' }, 0, 0, 120);
    expect(svg).not.toContain('<script');
    expect(svg).toContain('data-cast="you"');
  });
});

describe('the new grounds and cards', () => {
  it('draws every scene, by day and by night, with none of a lab\'s words and no script', () => {
    for (const scene of ALL_SCENES) {
      for (const bg of [undefined, 'night']) {
        const art = A.sceneArt(panelFor(scene, { bg, caption: EVIL, lines: [EVIL], bubbles: [{ text: EVIL }], diagram: scene === 'diagram' ? library.diagrams[0]!.id : EVIL }));
        const what = `${scene} ${bg ?? 'day'}`;
        expect(art.svg.length, what).toBeGreaterThan(200);
        expect(art.svg, what).not.toContain('<script');
        expect(art.svg, what).not.toContain('onerror');
        expect(art.svg, what).not.toContain('quoted');
        expect(art.svg, what).not.toMatch(/<text[\s>]/);
        expect(art.viewBox, what).toBe(`0 0 ${art.width} 320`);
        expect(art.width, what).toBe(A.artWidth(scene));
      }
    }
    // the diagram's id is a lab's word too: the frame never names it
    const id = library.diagrams[0]!.id;
    expect(A.sceneArt(panelFor('diagram', { diagram: id })).svg).not.toContain(id);
  });

  it('leaves a day panel as it was: night is drawn only on the night background', () => {
    for (const scene of ALL_SCENES) {
      const day = A.sceneArt(panelFor(scene)).svg;
      expect(A.sceneArt(panelFor(scene, { bg: 'ice' })).svg, scene).toBe(day);
      expect(day, scene).not.toContain('cm-moon');
    }
  });

  it('lights the night: a moon, and on the desk a lamp\'s cone and a glowing screen', () => {
    for (const scene of ['desk', 'duo', 'message', 'portrait', 'screen', 'you']) {
      const night = A.sceneArt(panelFor(scene, { bg: 'night' })).svg;
      expect(night, scene).toContain('class="cm-moon"');
      expect(night, scene).not.toBe(A.sceneArt(panelFor(scene)).svg);
    }
    expect(A.sceneArt(panelFor('desk', { bg: 'night' })).svg).toContain('class="cm-cone"');
    expect(A.sceneArt(panelFor('duo', { bg: 'night' })).svg).toContain('class="cm-cone"');
    // the desk's screen box for the typed lines does not move at night
    expect(A.sceneArt(panelFor('desk', { bg: 'night' })).lines).toEqual(A.sceneArt(panelFor('desk')).lines);
    expect(css).toMatch(/\.cm-bg-night \{[^}]*--cm-pbg: var\(--cm-bg-night\)/);
  });

  it('draws the black card as its own dark plate with grain and a ruled band for the captions', () => {
    const art = A.sceneArt(panelFor('black'));
    expect(art.svg).toContain('fill="var(--cm-black)"');
    expect(art.svg).toContain('class="cm-grain"');
    expect(art.svg).toContain('url(#cm-vignette)');
    expect(art.svg).toContain('class="cm-rules"');
    expect(art.lines).toBeNull();
    const s = art.stack!;
    expect(s.x).toBeGreaterThan(0);
    expect(s.y).toBeGreaterThan(0);
    expect(s.x + s.w).toBeLessThan(art.width);
    expect(s.y + s.h).toBeLessThan(art.height);
    expect(A.sceneArt(panelFor('black')).svg).toBe(art.svg); // the grain is the same every time
  });

  it('draws the diagram card as a plate with an empty port, and a presenter when the panel has one', () => {
    const art = A.sceneArt(panelFor('diagram', { cast: [] }));
    expect(art.svg).toContain('class="diagram cm-dgm cm-dgm-idle"');
    expect(art.svg).toMatch(/<svg class="cm-dgm-port"[^>]*><\/svg>/);
    expect(art.svg).toContain('fill="var(--cm-dgm-plate)"');
    expect(art.svg).not.toContain('data-cast');
    const presented = A.sceneArt(panelFor('diagram', { cast: [{ who: 'maren', pose: 'shrug' }] })).svg;
    expect(presented).toContain('data-cast="maren"');
  });

  it('uses only variables comic.css defines, and names no colour in a rule outside the token blocks', () => {
    const all = ALL_SCENES.flatMap((s) => [A.sceneArt(panelFor(s)).svg, A.sceneArt(panelFor(s, { bg: 'night' })).svg]).join('') +
      A.MOODS.map((mood) => A.bust({ who: 'maren', mood }, 0, 0, 1)).join('') + A.POSES.map((pose) => A.bust({ who: 'maren', pose }, 0, 0, 1)).join('');
    const used = new Set([...all.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]!));
    for (const v of used) expect(css, v).toContain(`${v}:`);
    for (const t of ['--cm-bg-night', '--cm-fg-night', '--cm-black', '--cm-fg-black', '--cm-black-rule']) expect(css, t).toMatch(new RegExp(`^\\s*${t}: #[0-9a-f]{6};`, 'm'));
  });
});

describe('the motion of the new parts', () => {
  it('has the pop, the poses\' loops and the grain, and stops them all where it stops the other loops', () => {
    expect(css).toMatch(/\.cm-pop \{ animation: cm-pop 0\.22s ease-out both; \}/);
    expect(css).toMatch(/@keyframes cm-pop \{ 0% \{ scale: 0\.6; \} 60% \{ scale: 1\.08; \} 100% \{ scale: 1; \} \}/);
    for (const k of ['cm-glow', 'cm-key', 'cm-grain']) expect(css, k).toContain(`@keyframes ${k} `);
    // every loop lives inside the reel, where the still rules reach it
    expect(css).toContain('.cm[data-state="done"] .cm-reel *, .cm[data-reduced] .cm-reel *, .cm[data-test] .cm-reel * { animation: none !important; }');
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.cm-reel \* \{ animation: none !important;/);
  });

  it('tells a caption that gives the time from one that does not', () => {
    for (const t of ['23:47', '3:12', 'Saturday 03:12', 'Mon 9:05 pm', '02:14. Still awake.']) expect(A.isClockCaption(t), t).toBe(true);
    for (const t of ['MEANWHILE', 'Later that night', 'Ratio 3:1', '123:456', '12:5', '', undefined, 5]) expect(A.isClockCaption(t), String(t)).toBe(false);
    // the player sets the class only on a caption that tells the time; any other caption is built as before
    const player = readFileSync('dashboard/src/comic.js', 'utf8');
    expect(player).toContain("el('figcaption', isClockCaption(panel.caption) ? 'cm-cap cm-caption--clock' : 'cm-cap', panel.caption)");
  });

  it('styles a black card\'s words: a mono small-caps title, captions sliding up with a rule between, from tokens only', () => {
    const rule = (sel: string) => new RegExp(`(^|\\n)${sel.replace(/[.+]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`).exec(css)?.[2] ?? '';
    expect(rule('.cm-stack')).toContain('color: var(--cm-fg-black)');
    expect(rule('.cm-stack-title')).toContain('var(--mono)');
    expect(rule('.cm-stack-title')).toContain('all-small-caps');
    expect(rule('.cm-stack-title')).toContain('var(--tt, 1)'); // scales up on a phone like every caption
    expect(rule('.cm-stack-line')).toContain('var(--ts, 1)');
    expect(rule('.cm-stack-line')).toMatch(/opacity: 0; transform: translateY\(0\.6em\); transition: opacity/);
    expect(rule('.cm-stack-line + .cm-stack-line')).toContain('border-top: 1px solid var(--cm-black-rule)');
    expect(css).toContain('.cm-stack-title.on, .cm-stack-line.on { opacity: 1; transform: none; }');
    expect(css).toMatch(/^\s*--cm-fg-black-muted: #[0-9a-f]{6};/m);
  });

  it('sets a clock caption in tabular mono figures', () => {
    const rule = /\.cm-caption--clock \{([^}]*)\}/.exec(css)![1]!;
    expect(rule).toContain('var(--mono)');
    expect(rule).toContain('tabular-nums');
    expect(css.indexOf('.cm-caption--clock {')).toBeGreaterThan(css.indexOf('.cm-cap {')); // it wins over the caption's font
  });
});

// ---------------------------------------------------------------------------
// The diagram card's picture, against a stand-in DOM (no jsdom in this repo)
// ---------------------------------------------------------------------------

class FakeEl {
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  text = '';
  constructor(
    public tag: string,
    public ownerDocument: unknown = null
  ) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  get classList() {
    const get = () => new Set((this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
    const set = (s: Set<string>) => this.setAttribute('class', [...s].join(' '));
    return {
      add: (c: string) => set(get().add(c)),
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
  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }
  set textContent(v: string) {
    this.children = [];
    this.text = String(v);
  }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  addEventListener() {}
  removeEventListener() {}
  closest(sel: string) {
    const cls = sel.replace(/^\./, '');
    for (let n: FakeEl | null = this; n; n = n.parent) if (n.classList.contains(cls)) return n;
    return null;
  }
}
const walk = (el: FakeEl): FakeEl[] => [el, ...el.children.flatMap(walk)];
const byClass = (el: FakeEl, cls: string) => walk(el).filter((e) => e.classList.contains(cls));

/** A comic root holding one diagram panel, its frame and port as sceneArt draws them. */
function fakePanel(comicAttrs: Record<string, string> = {}, reduced = false) {
  const listeners: string[] = [];
  const doc = {
    hidden: false,
    defaultView: { matchMedia: () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }) },
    createElement: (t: string) => new FakeEl(t, doc),
    createElementNS: (_ns: string, t: string) => new FakeEl(t, doc),
    addEventListener: (t: string) => listeners.push(t),
    removeEventListener: (t: string) => listeners.splice(listeners.indexOf(t), 1),
  };
  const cm = new FakeEl('div', doc);
  cm.setAttribute('class', 'cm');
  for (const [k, v] of Object.entries(comicAttrs)) cm.setAttribute(k, v);
  const fig = cm.appendChild(new FakeEl('figure', doc));
  fig.setAttribute('class', 'cm-pane cm-scene-diagram');
  const frame = fig.appendChild(new FakeEl('g', doc));
  frame.setAttribute('class', 'diagram cm-dgm cm-dgm-idle');
  const port = frame.appendChild(new FakeEl('svg', doc));
  port.setAttribute('class', 'cm-dgm-port');
  return { cm, fig, frame, port, listeners };
}

describe('applyDiagramStep', () => {
  const known = library.diagrams.find((d) => d.steps.length >= 3)!;
  const panel = { scene: 'diagram', diagram: known.id };

  it('returns without throwing whatever it is handed', () => {
    for (const fig of [undefined, null, {}, 5, 'x', { querySelector: () => { throw new Error('boom'); } }]) {
      expect(A.applyDiagramStep(fig, panel, 0)).toBe(-1);
      expect(A.applyDiagramStep(fig, { scene: 'diagram', diagram: 'no-such-diagram' }, 0)).toBe(-1);
      expect(() => A.releaseDiagram(fig)).not.toThrow();
    }
    for (const p of [undefined, null, {}, { diagram: 5 }, { diagram: '__proto__' }]) expect(A.diagramFor(p)).toBeNull();
    expect(A.diagramFor(panel)!.id).toBe(known.id);
  });

  it('mounts the diagram player\'s picture in the port and steps it', () => {
    const { fig, frame, port } = fakePanel();
    expect(A.applyDiagramStep(fig, panel, -1)).toBe(-1);
    expect(port.children).toHaveLength(1);
    const pic = port.children[0]!;
    expect(pic.classList.contains('diagram-svg')).toBe(true);
    expect(pic.getAttribute('viewBox')).toMatch(/^-5 [\d.]+ 110 [\d.]+$/); // the diagram's own viewBox: it scales to the port
    expect(pic.getAttribute('width')).toBe('100%');
    expect(frame.classList.contains('cm-dgm-idle')).toBe(true); // nothing yet
    expect(byClass(pic, 'diagram-node').length).toBeGreaterThan(1);
    // no controls, caption or title come along: only the picture
    expect(byClass(fig, 'diagram-controls')).toHaveLength(0);
    expect(byClass(fig, 'diagram-caption')).toHaveLength(0);

    expect(A.applyDiagramStep(fig, panel, 1)).toBe(1);
    expect(frame.classList.contains('cm-dgm-idle')).toBe(false);
    expect(frame.getAttribute('data-step')).toBe('1');
    expect(port.children[0]).toBe(pic); // stepped in place, not built again
    expect(A.applyDiagramStep(fig, panel, 999)).toBe(known.steps.length - 1);
    expect(A.applyDiagramStep(fig, panel, Number.NaN)).toBe(-1);
    expect(frame.classList.contains('cm-dgm-idle')).toBe(true);
  });

  it('empties the frame for an id the library does not have', () => {
    const { fig, frame, port } = fakePanel();
    A.applyDiagramStep(fig, panel, 0);
    expect(port.children).toHaveLength(1);
    expect(A.applyDiagramStep(fig, { ...panel, diagram: 'no-such-diagram' }, 0)).toBe(-1);
    expect(port.children).toHaveLength(0);
    expect(frame.classList.contains('cm-dgm-idle')).toBe(true);
  });

  it('builds the picture still under reduced motion, the test clock and a finished comic, and lets it go', () => {
    for (const [attrs, reduced] of [[{ 'data-reduced': '1' }, false], [{ 'data-test': '1' }, false], [{ 'data-state': 'done' }, false], [{}, true]] as const) {
      const { fig, port, listeners } = fakePanel(attrs, reduced);
      expect(A.applyDiagramStep(fig, panel, 0)).toBe(0);
      expect(port.children[0]!.classList.contains('diagram-svg')).toBe(true);
      expect(listeners).toContain('visibilitychange');
      A.releaseDiagram(fig);
      expect(port.children).toHaveLength(0);
      expect(listeners).not.toContain('visibilitychange'); // the player's listeners went with it
    }
  });

  it('builds anew when the comic turns still mid-way, so packets stop travelling', () => {
    const { cm, fig, port } = fakePanel();
    A.applyDiagramStep(fig, panel, 0);
    const first = port.children[0]!;
    cm.setAttribute('data-state', 'done');
    A.applyDiagramStep(fig, panel, 0);
    expect(port.children).toHaveLength(1);
    expect(port.children[0]).not.toBe(first);
  });
});
