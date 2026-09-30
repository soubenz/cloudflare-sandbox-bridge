import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { DIAGRAMS, type Diagram } from '../../src/labs/diagram';

/**
 * The diagram player of the learner console. Like the differ, it is a
 * browser module split into pure functions (layout, step model, stepping)
 * and a DOM builder. The pure part is tested directly. The DOM part runs
 * against a small stand-in for `document` (no jsdom in this repo), which is
 * enough to check what matters here: nothing but createElement, setAttribute
 * and textContent ever touches the tree, every step has its caption in the
 * text list, and the timers, observers and listeners come and go with the
 * element.
 */
type Box = { x: number; y: number; w: number; h: number; cx: number; cy: number; labelLines: string[]; subLines: string[] };
type Line = { x1: number; y1: number; x2: number; y2: number; mx: number; my: number; len: number; dx: number; dy: number };
type Model = {
  index: number;
  total: number;
  caption: string;
  active: string[];
  packets: Array<{ edge: string; from: string; to: string; reverse: boolean; label: string; tone: string }>;
  notes: Array<{ node: string; text: string; tone: string }>;
};
type Player = FakeEl & { destroy: () => void; play: () => void; pause: () => void; goTo: (i: number) => void };
const mod = (await import('../../dashboard/src/diagram.js' as string)) as {
  VIEW_X0: number;
  VIEW_W: number;
  VIEW_H: number;
  KINDS: string[];
  TONES: string[];
  nodeBox: (n: unknown) => Box;
  layoutEdge: (d: unknown, e: unknown) => Line | null;
  stepModel: (d: unknown, i: number) => Model;
  nextIndex: (i: number, total: number, dir: number, loop?: boolean) => number;
  wrapText: (t: string, max: number) => string[];
  segmentHitsRect: (x1: number, y1: number, x2: number, y2: number, r: { x: number; y: number; w: number; h: number }) => boolean;
  packetSize: (label: string) => { w: number; h: number };
  viewBoxFor: (d: unknown) => { x: number; y: number; w: number; h: number };
  placeNote: (d: unknown, node: string, text: string, taken?: unknown[]) => { lines: string[]; side: string; x: number; y: number; w: number; h: number } | null;
  renderDiagram: (d: unknown, o?: Record<string, unknown>) => Player;
  mountDiagrams: (root: unknown, library?: unknown[]) => Player[];
};
const { nodeBox, layoutEdge, stepModel, nextIndex, wrapText, segmentHitsRect, packetSize, viewBoxFor, placeNote, renderDiagram, VIEW_X0, VIEW_W, VIEW_H, KINDS, TONES } = mod;

const sample = DIAGRAMS.find((d) => d.id === 'gateway-alias-routing') as Diagram;
const edgeOf = (d: Diagram, id: string) => d.edges.find((e) => e.id === id)!;

/** A diagram with the given nodes and edges, one step per edge. */
function tiny(nodes: Array<Partial<Diagram['nodes'][number]> & { id: string }>, edges: Array<{ id: string; from: string; to: string }>): Diagram {
  return {
    id: 'tiny',
    title: 'Tiny',
    summary: 'Tiny diagram.',
    nodes: nodes.map((n) => ({ label: n.id, kind: 'service', x: 50, y: 50, ...n })),
    edges,
    steps: [
      { caption: 'One.', active: [nodes[0]!.id], packets: [], notes: [] },
      { caption: 'Two.', active: [nodes[1]!.id], packets: [], notes: [] },
    ],
  } as Diagram;
}

describe('nodeBox', () => {
  it('sizes a box to its text, wraps long text and stays inside the picture', () => {
    const short = nodeBox({ id: 'a', label: 'App', kind: 'client', x: 50, y: 50 });
    const long = nodeBox({ id: 'a', label: 'A rather long label ok', sub: 'and a sub line that runs on', kind: 'client', x: 50, y: 50 });
    expect(long.w).toBeGreaterThan(short.w);
    expect(long.labelLines.length).toBe(2);
    expect(long.subLines.length).toBe(2);
    expect(long.h).toBeGreaterThan(short.h);
    for (const [x, y] of [[4, 6], [96, 94], [4, 94], [96, 6]]) {
      const b = nodeBox({ id: 'a', label: 'Deployment b', sub: 'behind the alias', kind: 'model', x, y });
      expect(b.x).toBeGreaterThanOrEqual(VIEW_X0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(VIEW_X0 + VIEW_W);
      expect(b.y + b.h).toBeLessThanOrEqual(VIEW_H);
    }
  });

  it('never throws on missing text', () => {
    const b = nodeBox({ id: 'a', x: 10, y: 10 });
    expect(b.labelLines).toEqual([]);
    expect(Number.isFinite(b.w) && Number.isFinite(b.h)).toBe(true);
  });
});

describe('the shared library, drawn', () => {
  it('leaves room between every pair of node boxes', () => {
    for (const d of DIAGRAMS) {
      const boxes = d.nodes.map((n) => [n.id, nodeBox(n)] as const);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const [ia, a] = boxes[i]!;
          const [ib, b] = boxes[j]!;
          const gapX = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
          const gapY = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
          expect(Math.max(gapX, gapY), `${d.id}: ${ia} and ${ib} are too close`).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });
});

describe('the shared library, drawn: labels ride in the gaps', () => {
  type Rect = { x: number; y: number; w: number; h: number };
  /** A node that is lit draws a glow this far outside its box, so a label must stay clear of that too. */
  const GLOW = 0.6;
  const hit = (a: Rect, b: Rect) => a.x < b.x + b.w + GLOW && b.x - GLOW < a.x + a.w && a.y < b.y + b.h + GLOW && b.y - GLOW < a.y + a.h;
  const fmt = (r: Rect) => `[${r.x.toFixed(1)},${r.y.toFixed(1)} ${r.w.toFixed(1)}x${r.h.toFixed(1)}]`;

  /**
   * The pill of every labelled packet as the player places it: centred on the
   * edge midpoint, pushed sideways into its own lane when an edge carries more
   * than one packet in a step (same arithmetic as `draw` in diagram.js).
   */
  function pillsOf(d: Diagram, i: number) {
    const m = stepModel(d, i);
    const perEdge = new Map<string, number>();
    for (const p of m.packets) perEdge.set(p.edge, (perEdge.get(p.edge) ?? 0) + 1);
    const seen = new Map<string, number>();
    const out: Array<{ label: string; edge: string; rect: Rect; rest: Rect }> = [];
    for (const p of m.packets) {
      const edge = d.edges.find((e) => e.id === p.edge)!;
      const l = layoutEdge(d, edge)!;
      const { w, h } = packetSize(p.label);
      const lane = seen.get(p.edge) ?? 0;
      seen.set(p.edge, lane + 1);
      const shift = (lane - (perEdge.get(p.edge)! - 1) / 2) * (h + 0.8);
      const cx = l.mx - l.dy * shift;
      const cy = l.my + l.dx * shift;
      const rect = { x: cx - w / 2, y: cy - h / 2, w, h };
      // `taken` in draw() uses the un-shifted midpoint box.
      out.push({ label: p.label, edge: p.edge, rect, rest: { x: l.mx - w / 2, y: l.my - h / 2, w, h } });
    }
    return out;
  }

  it('keeps every packet pill clear of every node box and its glow', () => {
    const bad: string[] = [];
    for (const d of DIAGRAMS) {
      const boxes = d.nodes.map((n) => [n.id, nodeBox(n)] as const);
      d.steps.forEach((_, i) => {
        for (const p of pillsOf(d, i)) {
          if (!p.label) continue;
          for (const [id, b] of boxes) if (hit(p.rect, b)) bad.push(`${d.id} step ${i + 1}: packet "${p.label}" on ${p.edge} ${fmt(p.rect)} covers node ${id} ${fmt(b)}`);
        }
      });
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('keeps every step note clear of every node box and its glow, as drawn beside the resting packets', () => {
    const bad: string[] = [];
    for (const d of DIAGRAMS) {
      const boxes = d.nodes.map((n) => [n.id, nodeBox(n)] as const);
      d.steps.forEach((_, i) => {
        const taken: Rect[] = pillsOf(d, i).map((p) => p.rest);
        for (const n of stepModel(d, i).notes) {
          const spot = placeNote(d, n.node, n.text, taken)!;
          for (const [id, b] of boxes) if (hit(spot, b)) bad.push(`${d.id} step ${i + 1}: note "${n.text}" on ${n.node} ${fmt(spot)} covers node ${id} ${fmt(b)}`);
          taken.push({ x: spot.x, y: spot.y, w: spot.w, h: spot.h });
        }
      });
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});

describe('viewBoxFor', () => {
  it('draws a one-row diagram in a shorter frame than a two-row one', () => {
    const oneRow = tiny([{ id: 'l', x: 10, y: 50 }, { id: 'm', x: 50, y: 50 }, { id: 'r', x: 90, y: 50 }], [{ id: 'l-m', from: 'l', to: 'm' }, { id: 'm-r', from: 'm', to: 'r' }]);
    const twoRows = tiny([{ id: 'l', x: 10, y: 15 }, { id: 'm', x: 50, y: 50 }, { id: 'r', x: 90, y: 85 }], [{ id: 'l-m', from: 'l', to: 'm' }, { id: 'm-r', from: 'm', to: 'r' }]);
    const a = viewBoxFor(oneRow);
    const b = viewBoxFor(twoRows);
    expect(a.h).toBeLessThan(b.h);
    expect(a.w).toBe(VIEW_W);
    expect(a.x).toBe(VIEW_X0);
    expect(a.h).toBeGreaterThanOrEqual(26);
    // The same holds for the real thing: what is drawn is what is in the frame.
    const cfg = DIAGRAMS.find((d) => d.id === 'platform-end-to-end-check') as Diagram;
    const flat = DIAGRAMS.find((d) => d.id === 'otel-parent-child') as Diagram;
    expect(viewBoxFor(flat).h).toBeLessThan(viewBoxFor(cfg).h);
  });

  it('keeps every node, pill and note of every library diagram inside the frame, with a margin of air', () => {
    for (const d of DIAGRAMS) {
      const v = viewBoxFor(d);
      expect(v.h, d.id).toBeLessThanOrEqual(VIEW_H);
      expect(v.y, d.id).toBeGreaterThanOrEqual(0);
      expect(v.y + v.h, d.id).toBeLessThanOrEqual(VIEW_H);
      const inside = (y0: number, y1: number, what: string) => {
        expect(y0, `${d.id}: ${what}`).toBeGreaterThanOrEqual(v.y);
        expect(y1, `${d.id}: ${what}`).toBeLessThanOrEqual(v.y + v.h);
      };
      for (const n of d.nodes) {
        const b = nodeBox(n);
        inside(b.y, b.y + b.h, `node ${n.id}`);
      }
      d.steps.forEach((_, i) => {
        const m = stepModel(d, i);
        for (const p of m.packets) {
          const l = layoutEdge(d, d.edges.find((e) => e.id === p.edge))!;
          const { h } = packetSize(p.label);
          inside(l.my - h / 2, l.my + h / 2, `step ${i + 1} packet ${p.label}`);
        }
        for (const n of m.notes) {
          const s = placeNote(d, n.node, n.text, [])!;
          inside(s.y, s.y + s.h, `step ${i + 1} note ${n.text}`);
        }
      });
    }
  });

  it('is what the player sets as the picture viewBox', () => {
    const { doc } = fakeEnv();
    for (const d of DIAGRAMS) {
      const el = renderDiagram(d, { document: doc, autoplay: false });
      const v = viewBoxFor(d);
      const svgEl = all(el).find((e) => e.tag === 'svg')!;
      const parts = svgEl.getAttribute('viewBox')!.split(' ').map(Number);
      expect(parts[0]).toBe(v.x);
      expect(parts[2]).toBe(v.w);
      expect(parts[1]).toBeCloseTo(v.y, 1);
      expect(parts[3]).toBeCloseTo(v.h, 1);
    }
  });
});

describe('layoutEdge', () => {
  it('starts and ends on the borders of the two boxes, not at their centres', () => {
    const e = edgeOf(sample, 'app-gw');
    const l = layoutEdge(sample, e)!;
    const a = nodeBox(sample.nodes.find((n) => n.id === 'app'));
    const b = nodeBox(sample.nodes.find((n) => n.id === 'gw'));
    // Both ends sit on their box outline.
    const onOutline = (x: number, y: number, bx: Box) => {
      const inX = x >= bx.x - 1e-6 && x <= bx.x + bx.w + 1e-6;
      const inY = y >= bx.y - 1e-6 && y <= bx.y + bx.h + 1e-6;
      const onV = Math.abs(x - bx.x) < 1e-6 || Math.abs(x - (bx.x + bx.w)) < 1e-6;
      const onH = Math.abs(y - bx.y) < 1e-6 || Math.abs(y - (bx.y + bx.h)) < 1e-6;
      return inX && inY && (onV || onH);
    };
    expect(onOutline(l.x1, l.y1, a)).toBe(true);
    expect(onOutline(l.x2, l.y2, b)).toBe(true);
    // Shorter than centre to centre, and pointing from source to target.
    expect(l.len).toBeLessThan(Math.hypot(b.cx - a.cx, b.cy - a.cy));
    expect(l.len).toBeGreaterThan(0);
    expect(l.dx).toBeGreaterThan(0.99);
    expect(l.mx).toBeCloseTo((l.x1 + l.x2) / 2);
    expect(l.my).toBeCloseTo((l.y1 + l.y2) / 2);
  });

  it('runs diagonally when the nodes are not level, still on the borders', () => {
    const l = layoutEdge(sample, edgeOf(sample, 'gw-a'))!;
    expect(l.dy).toBeLessThan(0);
    expect(Math.hypot(l.dx, l.dy)).toBeCloseTo(1);
    const a = nodeBox(sample.nodes.find((n) => n.id === 'a'));
    // The end is inside the target's bounding rectangle's outline.
    expect(l.x2).toBeLessThanOrEqual(a.x + a.w + 1e-6);
    expect(l.x2).toBeGreaterThanOrEqual(a.x - 1e-6);
  });

  it('is null for an edge naming a node that is not there, and safe for two nodes on one spot', () => {
    expect(layoutEdge(sample, { id: 'x', from: 'app', to: 'ghost' })).toBeNull();
    const d = tiny([{ id: 'p' }, { id: 'q' }], [{ id: 'p-q', from: 'p', to: 'q' }]);
    const l = layoutEdge(d, d.edges[0])!;
    expect(Number.isFinite(l.x1 + l.y1 + l.x2 + l.y2)).toBe(true);
  });

  it('draws every edge in the shared library between distinct points', () => {
    for (const d of DIAGRAMS) {
      for (const e of d.edges) {
        const l = layoutEdge(d, e);
        expect(l, `${d.id}/${e.id}`).not.toBeNull();
        expect(l!.len, `${d.id}/${e.id} is too short to see`).toBeGreaterThan(4);
      }
    }
  });
});

describe('stepModel', () => {
  it('lists lit nodes, packets and notes of a step', () => {
    const m = stepModel(sample, 1);
    expect(m.index).toBe(1);
    expect(m.total).toBe(4);
    expect(m.caption).toContain('looks the alias up');
    expect(m.active).toEqual(['gw', 'a', 'b']);
    expect(m.packets).toEqual([]);
    expect(m.notes).toEqual([{ node: 'gw', text: 'support = deployment a', tone: 'ok' }]);
  });

  it('says where a packet starts and ends, swapping them when it is a reverse one', () => {
    const fwd = stepModel(sample, 2).packets[0]!;
    expect(fwd).toMatchObject({ edge: 'gw-a', from: 'gw', to: 'a', reverse: false, label: 'chat request', tone: 'default' });
    const back = stepModel(sample, 3).packets;
    expect(back.map((p) => [p.from, p.to, p.reverse])).toEqual([
      ['a', 'gw', true],
      ['gw', 'app', true],
    ]);
  });

  it('clamps the index and drops references to things that do not exist', () => {
    expect(stepModel(sample, -3).index).toBe(0);
    expect(stepModel(sample, 99).index).toBe(3);
    expect(stepModel(sample, Number.NaN).index).toBe(0);
    const broken = {
      ...sample,
      steps: [{ caption: 'c', active: ['app', 'ghost'], packets: [{ edge: 'nope' }, { edge: 'app-gw', tone: 'weird' }], notes: [{ node: 'ghost', text: 'x' }] }],
    };
    const m = stepModel(broken, 0);
    expect(m.active).toEqual(['app']);
    expect(m.packets).toHaveLength(1);
    expect(m.packets[0]!.tone).toBe('default');
    expect(m.notes).toEqual([]);
  });

  it('keeps every step of every library diagram whole', () => {
    for (const d of DIAGRAMS) {
      d.steps.forEach((s, i) => {
        const m = stepModel(d, i);
        expect(m.caption).toBe(s.caption);
        expect(m.active).toEqual(s.active);
        expect(m.packets).toHaveLength(s.packets.length);
        expect(m.notes).toHaveLength(s.notes.length);
      });
    }
  });
});

describe('nextIndex', () => {
  it('steps forward and back and stops at the ends without loop', () => {
    expect(nextIndex(0, 5, 1, false)).toBe(1);
    expect(nextIndex(3, 5, -1, false)).toBe(2);
    expect(nextIndex(4, 5, 1, false)).toBe(4);
    expect(nextIndex(0, 5, -1, false)).toBe(0);
    expect(nextIndex(0, 5, 1)).toBe(1);
  });

  it('wraps round with loop', () => {
    expect(nextIndex(4, 5, 1, true)).toBe(0);
    expect(nextIndex(0, 5, -1, true)).toBe(4);
    expect(nextIndex(2, 5, 1, true)).toBe(3);
  });

  it('reads out-of-range and odd input as the nearest step, and an empty diagram as 0', () => {
    expect(nextIndex(-4, 5, 1, false)).toBe(1);
    expect(nextIndex(40, 5, 1, false)).toBe(4);
    expect(nextIndex(Number.NaN, 5, 1, false)).toBe(1);
    expect(nextIndex(0, 0, 1, true)).toBe(0);
    expect(nextIndex(3, 1, 1, true)).toBe(0);
    expect(nextIndex(1, 3, 0, false)).toBe(2);
  });
});

describe('wrapText and note placement', () => {
  it('wraps at spaces and keeps a long word whole', () => {
    expect(wrapText('support = deployment a', 12)).toEqual(['support =', 'deployment a']);
    expect(wrapText('short', 20)).toEqual(['short']);
    expect(wrapText('extraordinarily', 5)).toEqual(['extraordinarily']);
    expect(wrapText('', 5)).toEqual([]);
  });

  it('finds crossings of a segment with a rectangle', () => {
    const r = { x: 10, y: 10, w: 10, h: 10 };
    expect(segmentHitsRect(0, 15, 30, 15, r)).toBe(true);
    expect(segmentHitsRect(0, 0, 30, 5, r)).toBe(false);
    expect(segmentHitsRect(12, 12, 14, 14, r)).toBe(true);
    expect(segmentHitsRect(0, 0, 9, 9, r)).toBe(false);
  });

  it('puts every library note inside the picture and clear of every node', () => {
    for (const d of DIAGRAMS) {
      const boxes = new Map(d.nodes.map((n) => [n.id, nodeBox(n)]));
      d.steps.forEach((s, i) => {
        const taken: Array<{ x: number; y: number; w: number; h: number }> = [];
        for (const n of stepModel(d, i).notes) {
          const spot = placeNote(d, n.node, n.text, taken)!;
          const at = `${d.id} step ${i + 1} note on ${n.node}`;
          expect(spot.x, at).toBeGreaterThanOrEqual(VIEW_X0);
          expect(spot.y, at).toBeGreaterThanOrEqual(0);
          expect(spot.x + spot.w, at).toBeLessThanOrEqual(VIEW_X0 + VIEW_W);
          expect(spot.y + spot.h, at).toBeLessThanOrEqual(VIEW_H);
          for (const [id, b] of boxes) {
            const overlap = spot.x < b.x + b.w && b.x < spot.x + spot.w && spot.y < b.y + b.h && b.y < spot.y + spot.h;
            expect(overlap, `${at} covers node ${id}`).toBe(false);
          }
          taken.push(spot);
        }
      });
    }
  });

  it('moves a note off a side that has no room', () => {
    const d = tiny([{ id: 'l', x: 6, y: 50 }, { id: 'r', x: 94, y: 50 }], [{ id: 'l-r', from: 'l', to: 'r' }]);
    const spot = placeNote(d, 'r', 'a note that would not fit on the right', [])!;
    expect(spot.side).not.toBe('right');
    expect(placeNote(d, 'ghost', 'x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A stand-in DOM
// ---------------------------------------------------------------------------

class FakeText {
  constructor(public data: string) {}
}

class FakeEl {
  attrs = new Map<string, string>();
  children: Array<FakeEl | FakeText> = [];
  listeners: Array<[string, unknown]> = [];
  parent: FakeEl | null = null;
  classSet = new Set<string>();
  constructor(
    public tag: string,
    public ns: string | null
  ) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
    if (k === 'class') this.classSet = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  getAttribute(k: string) {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  get classList() {
    const self = this;
    return {
      add: (c: string) => self.classSet.add(c),
      remove: (c: string) => self.classSet.delete(c),
      contains: (c: string) => self.classSet.has(c),
      toggle: (c: string, on?: boolean) => {
        const want = on === undefined ? !self.classSet.has(c) : on;
        if (want) self.classSet.add(c);
        else self.classSet.delete(c);
        return want;
      },
    };
  }
  appendChild<T extends FakeEl | FakeText>(c: T): T {
    if (c instanceof FakeEl) c.parent = this;
    this.children.push(c);
    return c;
  }
  removeChild<T extends FakeEl | FakeText>(c: T): T {
    this.children = this.children.filter((x) => x !== c);
    if (c instanceof FakeEl) c.parent = null;
    return c;
  }
  get firstChild(): FakeEl | FakeText | null {
    return this.children[0] ?? null;
  }
  set textContent(v: string) {
    this.children = v === '' ? [] : [new FakeText(String(v))];
  }
  get textContent(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.data : c.textContent)).join('');
  }
  addEventListener(type: string, fn: unknown) {
    this.listeners.push([type, fn]);
  }
  removeEventListener(type: string, fn: unknown) {
    this.listeners = this.listeners.filter(([t, f]) => !(t === type && f === fn));
  }
  emit(type: string, extra: Record<string, unknown> = {}) {
    for (const [t, fn] of [...this.listeners]) if (t === type) (fn as (e: unknown) => void)({ type, target: this, ...extra });
  }
  closest(sel: string) {
    const cls = sel.replace(/^\./, '');
    for (let n: FakeEl | null = this; n; n = n.parent) if (n.classSet.has(cls)) return n;
    return null;
  }
  click() {
    this.emit('click');
  }
}

function walk(el: FakeEl, visit: (e: FakeEl) => void) {
  visit(el);
  for (const c of el.children) if (c instanceof FakeEl) walk(c, visit);
}
const all = (el: FakeEl) => {
  const out: FakeEl[] = [];
  walk(el, (e) => out.push(e));
  return out;
};
const byClass = (el: FakeEl, cls: string) => all(el).filter((e) => e.classSet.has(cls));
const one = (el: FakeEl, cls: string) => {
  const found = byClass(el, cls);
  expect(found, cls).toHaveLength(1);
  return found[0]!;
};

type FakeWin = {
  IntersectionObserver: new (cb: (e: Array<{ isIntersecting: boolean }>) => void, o?: unknown) => unknown;
  matchMedia: (q: string) => { matches: boolean; addEventListener: () => void; removeEventListener: () => void };
};

/** A document, its window, and handles to the observer and the visibility event. */
function fakeEnv(opts: { reduced?: boolean } = {}) {
  const observers: Array<{ cb: (e: Array<{ isIntersecting: boolean }>) => void; disconnected: boolean; target: unknown }> = [];
  const win = {
    IntersectionObserver: class {
      rec: (typeof observers)[number];
      constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) {
        this.rec = { cb, disconnected: false, target: null };
        observers.push(this.rec);
      }
      observe(t: unknown) {
        this.rec.target = t;
      }
      disconnect() {
        this.rec.disconnected = true;
      }
    },
    matchMedia: () => ({ matches: Boolean(opts.reduced), addEventListener() {}, removeEventListener() {} }),
  } as unknown as FakeWin;
  const docListeners: Array<[string, () => void]> = [];
  const doc = {
    hidden: false,
    defaultView: win,
    createElement: (t: string) => new FakeEl(t, null),
    createElementNS: (ns: string, t: string) => new FakeEl(t, ns),
    addEventListener: (t: string, f: () => void) => docListeners.push([t, f]),
    removeEventListener: (t: string, f: () => void) => {
      const i = docListeners.findIndex(([x, g]) => x === t && g === f);
      if (i >= 0) docListeners.splice(i, 1);
    },
  };
  return {
    doc,
    observers,
    docListeners,
    seen: (visible: boolean) => observers.forEach((o) => o.cb([{ isIntersecting: visible }])),
    hide: (hidden: boolean) => {
      doc.hidden = hidden;
      for (const [t, f] of [...docListeners]) if (t === 'visibilitychange') f();
    },
  };
}

const HOSTILE = {
  id: 'hostile',
  title: 'T <b>bold</b> & "q"',
  summary: 'S <script>alert(1)</script>',
  nodes: [
    { id: 'a', label: '<img src=x onerror=alert(1)>', sub: '</svg><script>x</script>', kind: 'client', x: 20, y: 50 },
    { id: 'b', label: '&lt;b&gt;', kind: 'evil"><script>', x: 80, y: 50 },
  ],
  edges: [{ id: 'a-b', from: 'a', to: 'b', label: '<a href=javascript:1>' }],
  steps: [
    { caption: 'C1 <script>alert(1)</script>', active: ['a'], packets: [{ edge: 'a-b', label: '<svg onload=1>', tone: 'bad" onclick="x' }], notes: [] },
    { caption: 'C2 <style>*{display:none}</style>', active: ['b'], packets: [], notes: [{ node: 'b', text: '<iframe src=//evil>', tone: 'warn' }] },
  ],
};

describe('renderDiagram: the tree', () => {
  it('is a labelled group with a description, live caption, controls and a text list', () => {
    const { doc } = fakeEnv();
    const el = renderDiagram(sample, { document: doc, autoplay: false });
    expect(el.getAttribute('role')).toBe('group');
    expect(el.getAttribute('aria-label')).toBe(sample.title);
    const descId = el.getAttribute('aria-describedby')!;
    const desc = all(el).find((e) => e.getAttribute('id') === descId)!;
    expect(desc.textContent).toBe(sample.summary);
    expect(desc.classSet.has('diagram-sr-only')).toBe(true);
    const caption = one(el, 'diagram-caption');
    expect(caption.getAttribute('aria-live')).toBe('polite');
    expect(caption.textContent).toBe(sample.steps[0]!.caption);
    expect(one(el, 'diagram-count').textContent).toBe('Step 1 of 4');
    for (const cls of ['diagram-play', 'diagram-prev', 'diagram-next', 'diagram-restart']) {
      const b = one(el, cls);
      expect(b.tag).toBe('button');
      expect(b.getAttribute('type')).toBe('button');
    }
    const details = one(el, 'diagram-text');
    expect(details.tag).toBe('details');
    expect(one(details, 'diagram-text-summary').textContent).toBe('Read as text');
    // The picture is decoration for assistive tech: everything in it is in the text.
    expect(all(el).find((e) => e.tag === 'svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws one node group per node, one edge per edge and lights the step\'s nodes', () => {
    const { doc } = fakeEnv();
    const el = renderDiagram(sample, { document: doc, autoplay: false, startIndex: 1 });
    expect(byClass(el, 'diagram-node')).toHaveLength(sample.nodes.length);
    expect(byClass(el, 'diagram-edge')).toHaveLength(sample.edges.length);
    const lit = byClass(el, 'diagram-node').filter((n) => n.classSet.has('is-lit')).map((n) => n.getAttribute('data-node'));
    expect(lit.sort()).toEqual(['a', 'b', 'gw']);
    expect(byClass(el, 'diagram-note')).toHaveLength(1);
    expect(byClass(el, 'diagram-note-text').map((t) => t.textContent).join(' ')).toBe('support = deployment a');
  });

  it('lists every step caption, in order, in the text list', () => {
    const { doc } = fakeEnv();
    for (const d of DIAGRAMS) {
      const el = renderDiagram(d, { document: doc, autoplay: false });
      const items = byClass(one(el, 'diagram-text'), 'diagram-step-caption');
      expect(items, d.id).toHaveLength(d.steps.length);
      items.forEach((li, i) => {
        expect(li.tag).toBe('li');
        expect(one(li, 'diagram-step-text').textContent).toBe(d.steps[i]!.caption);
      });
    }
    // Packets and notes carry information too, so the text says them.
    const el = renderDiagram(sample, { document: doc, autoplay: false });
    const detail = byClass(el, 'diagram-step-detail').map((e) => e.textContent);
    expect(detail[0]).toContain('model: support, Support app to Gateway');
    expect(detail[1]).toContain('Note beside Gateway: support = deployment a');
  });

  it('builds hostile text as text only: no script, no markup, no injected class', () => {
    const { doc } = fakeEnv();
    const el = renderDiagram(HOSTILE, { document: doc, autoplay: false });
    const tags = new Set(all(el).map((e) => e.tag.toLowerCase()));
    for (const banned of ['script', 'img', 'iframe', 'style', 'a', 'b', 'object', 'embed', 'link', 'foreignobject']) expect(tags.has(banned), banned).toBe(false);
    // The strings arrive verbatim, as text.
    expect(el.getAttribute('aria-label')).toBe(HOSTILE.title);
    expect(one(el, 'diagram-title').textContent).toBe(HOSTILE.title);
    expect(one(el, 'diagram-caption').textContent).toBe(HOSTILE.steps[0]!.caption);
    expect(byClass(el, 'diagram-node-label').map((e) => e.textContent).join(' ')).toContain('<img');
    expect(byClass(el, 'diagram-edge-label')[0]!.textContent).toBe('<a href=javascript:1>');
    // Unknown kinds and tones fall back to known class names.
    for (const e of all(el)) for (const c of e.classSet) expect(/^[a-z0-9-]+$/.test(c), `class "${c}"`).toBe(true);
    const kinds = byClass(el, 'diagram-node').map((n) => n.getAttribute('data-kind'));
    expect(kinds.every((k) => KINDS.includes(k!))).toBe(true);
    const tones = all(el).flatMap((e) => [...e.classSet]).filter((c) => c.startsWith('diagram-tone-')).map((c) => c.slice('diagram-tone-'.length));
    expect(tones.every((t) => TONES.includes(t))).toBe(true);
    // Every text node in the tree came from textContent, so the whole text is what was given.
    const shown = el.textContent;
    expect(shown).toContain('<script>alert(1)</script>');
    expect(shown).toContain('<iframe src=//evil>');
  });

  it('never uses an API that parses markup, in the source', () => {
    const src = readFileSync(new URL('../../dashboard/src/diagram.js', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'DOMParser', 'createContextualFragment', 'eval(', 'new Function']) {
      expect(code.includes(banned), banned).toBe(false);
    }
  });

  it('styles from tokens only: no hex colour and no rgb() in the stylesheet', () => {
    const css = readFileSync(new URL('../../dashboard/public/diagram.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(css.match(/\brgba?\(|\bhsla?\(/g)).toBeNull();
    expect(css).toContain('prefers-reduced-motion');
  });
});

describe('renderDiagram: the player', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('steps with Next and Previous, marks the ends and updates caption and count', () => {
    const { doc } = fakeEnv();
    const el = renderDiagram(sample, { document: doc, autoplay: false });
    const caption = one(el, 'diagram-caption');
    const count = one(el, 'diagram-count');
    const prev = one(el, 'diagram-prev');
    const next = one(el, 'diagram-next');
    expect(prev.getAttribute('aria-disabled')).toBe('true');
    next.click();
    expect(count.textContent).toBe('Step 2 of 4');
    expect(caption.textContent).toBe(sample.steps[1]!.caption);
    expect(prev.getAttribute('aria-disabled')).toBe('false');
    next.click();
    next.click();
    expect(count.textContent).toBe('Step 4 of 4');
    expect(next.getAttribute('aria-disabled')).toBe('true');
    next.click();
    expect(count.textContent).toBe('Step 4 of 4');
    prev.click();
    expect(count.textContent).toBe('Step 3 of 4');
    one(el, 'diagram-restart').click();
    expect(el.getAttribute('data-step')).toBe('0');
    el.destroy();
  });

  it('plays on a timer, ~3.2 s a step, loops after a pause, and pauses on demand', () => {
    vi.useFakeTimers();
    const { doc } = fakeEnv();
    const el = renderDiagram(sample, { document: doc, autoplay: false });
    const play = one(el, 'diagram-play');
    expect(one(play, 'diagram-btn-label').textContent).toBe('Play');
    play.click();
    expect(one(play, 'diagram-btn-label').textContent).toBe('Pause');
    vi.advanceTimersByTime(3199);
    expect(el.getAttribute('data-step')).toBe('0');
    vi.advanceTimersByTime(2);
    expect(el.getAttribute('data-step')).toBe('1');
    vi.advanceTimersByTime(3200 * 2);
    expect(el.getAttribute('data-step')).toBe('3');
    // The last step is held for the loop pause on top of its own time, then it wraps.
    vi.advanceTimersByTime(3200 + 2400 - 5);
    expect(el.getAttribute('data-step')).toBe('3');
    vi.advanceTimersByTime(10);
    expect(el.getAttribute('data-step')).toBe('0');
    play.click();
    expect(one(play, 'diagram-btn-label').textContent).toBe('Play');
    vi.advanceTimersByTime(20_000);
    expect(el.getAttribute('data-step')).toBe('0');
    el.destroy();
  });

  it('autoplays when scrolled into view, stops for good on any touch and never restarts by itself', () => {
    vi.useFakeTimers();
    const env = fakeEnv();
    const el = renderDiagram(sample, { document: env.doc });
    expect(env.observers).toHaveLength(1);
    expect(env.observers[0]!.target).toBe(el);
    expect(el.classSet.has('is-playing')).toBe(false);
    env.seen(true);
    expect(el.classSet.has('is-playing')).toBe(true);
    vi.advanceTimersByTime(3300);
    expect(el.getAttribute('data-step')).toBe('1');
    // Scrolling away pauses it, scrolling back resumes it (nobody touched it).
    env.seen(false);
    expect(el.classSet.has('is-playing')).toBe(false);
    env.seen(true);
    expect(el.classSet.has('is-playing')).toBe(true);
    // A pointer press on the picture ends autoplay.
    one(el, 'diagram-figure').parent!.emit('pointerdown', { target: one(el, 'diagram-figure') });
    expect(el.classSet.has('is-playing')).toBe(false);
    const step = el.getAttribute('data-step');
    vi.advanceTimersByTime(30_000);
    expect(el.getAttribute('data-step')).toBe(step);
    env.seen(false);
    env.seen(true);
    expect(el.classSet.has('is-playing')).toBe(false);
    el.destroy();
  });

  it('stops autoplay on Next, and a keydown outside the buttons counts too', () => {
    vi.useFakeTimers();
    const env = fakeEnv();
    const el = renderDiagram(sample, { document: env.doc });
    env.seen(true);
    one(el, 'diagram-next').click();
    expect(el.classSet.has('is-playing')).toBe(false);
    expect(el.getAttribute('data-step')).toBe('1');
    el.destroy();

    const env2 = fakeEnv();
    const el2 = renderDiagram(sample, { document: env2.doc });
    env2.seen(true);
    el2.emit('keydown', { target: one(el2, 'diagram-text-summary') });
    expect(el2.classSet.has('is-playing')).toBe(false);
    el2.destroy();
  });

  it('a click on Pause during autoplay pauses and stays paused', () => {
    vi.useFakeTimers();
    const env = fakeEnv();
    const el = renderDiagram(sample, { document: env.doc });
    env.seen(true);
    const play = one(el, 'diagram-play');
    // Pointer and key events that start on a button must not stop it early:
    // the click that follows would then start it again.
    el.emit('pointerdown', { target: play });
    expect(el.classSet.has('is-playing')).toBe(true);
    play.click();
    expect(el.classSet.has('is-playing')).toBe(false);
    el.destroy();
  });

  it('pauses while the tab is hidden and resumes when it is back', () => {
    vi.useFakeTimers();
    const env = fakeEnv();
    const el = renderDiagram(sample, { document: env.doc, autoplay: false });
    one(el, 'diagram-play').click();
    env.hide(true);
    vi.advanceTimersByTime(60_000);
    expect(el.getAttribute('data-step')).toBe('0');
    env.hide(false);
    vi.advanceTimersByTime(3300);
    expect(el.getAttribute('data-step')).toBe('1');
    el.destroy();
  });

  it('with reduced motion never autoplays and never asks for a travelling packet', () => {
    vi.useFakeTimers();
    const env = fakeEnv({ reduced: true });
    const el = renderDiagram(sample, { document: env.doc });
    env.seen(true);
    expect(el.classSet.has('is-playing')).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(el.getAttribute('data-step')).toBe('0');
    expect(el.classSet.has('is-reduced')).toBe(true);
    // Packets rest at the middle of their edge, and a step change is immediate.
    el.goTo(2);
    const pill = one(el, 'diagram-packet');
    const l = layoutEdge(sample, edgeOf(sample, 'gw-a'))!;
    expect(pill.getAttribute('transform')).toBe(`translate(${Math.round(l.mx * 100) / 100} ${Math.round(l.my * 100) / 100})`);
    // Two packets on one edge rest in two lanes, not on top of each other.
    const twin = { ...sample, steps: [{ caption: 'c', active: [], packets: [{ edge: 'gw-a', label: 'ask' }, { edge: 'gw-a', reverse: true, label: 'reply' }], notes: [] }, sample.steps[0]] };
    const el2 = renderDiagram(twin, { document: env.doc });
    const [p1, p2] = byClass(el2, 'diagram-packet').map((e) => e.getAttribute('transform'));
    expect(p1).not.toBe(p2);
    el2.destroy();
    expect(el.getAttribute('data-step')).toBe('2');
    el.destroy();
  });

  it('animates packets when it may, one animation per packet, with a stagger inside the step', () => {
    const env = fakeEnv();
    const el = renderDiagram(sample, { document: env.doc, autoplay: false, startIndex: 0 });
    const calls: Array<{ el: FakeEl; frames: unknown; opts: { duration: number; delay: number } }> = [];
    // Give every element the Web Animations API from here on.
    (FakeEl.prototype as unknown as { animate: unknown }).animate = function (this: FakeEl, frames: unknown, opts: { duration: number; delay: number }) {
      calls.push({ el: this, frames, opts });
      return { cancel() {} };
    };
    try {
      el.goTo(3);
    } finally {
      delete (FakeEl.prototype as unknown as { animate?: unknown }).animate;
    }
    expect(calls).toHaveLength(2);
    expect(calls[0]!.opts.duration).toBe(1600);
    expect(calls[0]!.opts.delay).toBe(0);
    expect(calls[1]!.opts.delay).toBeGreaterThan(0);
    expect(calls[1]!.opts.delay + calls[1]!.opts.duration).toBeLessThan(3200);
    el.destroy();
  });

  it('destroy stops the timer, disconnects the observer and removes every listener', () => {
    vi.useFakeTimers();
    const env = fakeEnv();
    const el = renderDiagram(sample, { document: env.doc });
    env.seen(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(env.docListeners.length).toBeGreaterThan(0);
    el.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(env.observers[0]!.disconnected).toBe(true);
    expect(env.docListeners).toHaveLength(0);
    for (const e of all(el)) expect(e.listeners, e.tag).toHaveLength(0);
    // A late observer callback or click does nothing.
    env.seen(true);
    one(el, 'diagram-next').click();
    expect(vi.getTimerCount()).toBe(0);
    el.destroy();
  });

  it('does not observe or play a one-step diagram', () => {
    const env = fakeEnv();
    const one1 = { ...sample, steps: [sample.steps[0]] };
    const el = renderDiagram(one1, { document: env.doc });
    expect(env.observers).toHaveLength(0);
    one(el, 'diagram-play').click();
    expect(el.classSet.has('is-playing')).toBe(false);
    el.destroy();
  });
});
