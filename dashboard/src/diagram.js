/**
 * The animated diagram player for lessons (data format: src/labs/diagram.ts,
 * library: packages/catalogue/diagrams.json).
 *
 * Two halves, like diff.js: pure functions with no DOM (layoutEdge, stepModel,
 * nextIndex, nodeBox, placeNote), which the unit tests import directly, and
 * renderDiagram(), which builds the element from them.
 *
 * Nothing here ever writes markup. Every element is made with createElement /
 * createElementNS and every string from the diagram goes in through
 * setAttribute or textContent, so text from a diagram file (or, one day, from
 * a learner) cannot become a tag. Kinds and tones are looked up in a fixed
 * list before they reach a class name.
 *
 * Styling is diagram.css: token custom properties only, light and dark.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The grid: nodes sit on 0-100 both ways. The picture is 110 wide (the grid
 * plus a 5-unit margin each side, so a wide box on a node at x=8 keeps its
 * place instead of being pushed inwards) and 64 tall.
 */
export const VIEW_X0 = -5;
export const VIEW_W = 110;
export const VIEW_H = 64;
const VIEW_X1 = VIEW_X0 + VIEW_W;
const Y_PAD = 2;
const Y_SCALE = 0.6;

export const KINDS = ['client', 'gateway', 'service', 'store', 'model', 'tool', 'person', 'log'];
export const TONES = ['default', 'ok', 'warn', 'bad'];

/** Type sizes in grid units, mirrored by the font-size rules in diagram.css. */
const FS_LABEL = 2.6;
const FS_SUB = 2.0;
const FS_EDGE = 2.1;
const FS_PACKET = 2.2;
const FS_NOTE = 2.2;
/** Average advance as a fraction of the font size: proportional sans, and mono. */
const W_SANS = 0.58;
const W_MONO = 0.6;

const NODE_PAD_X = 2.3;
const NODE_PAD_Y = 2.0;
const NODE_MIN_W = 12;
const LINE_LABEL = 3.3;
const LINE_SUB = 2.6;
/** Longest run of characters on one line of a node's label and sub text. */
const WRAP_LABEL = 10;
const WRAP_SUB = 15;
const ARROW = 1.6;

const DEFAULTS = {
  stepMs: 3200,
  packetMs: 1600,
  loopPauseMs: 2400,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const kindOf = (k) => (KINDS.includes(k) ? k : 'service');
const toneOf = (t) => (TONES.includes(t) ? t : 'default');
const textOf = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Grid position of a node in picture units. */
export function nodeCentre(node) {
  return { x: clamp(num(node.x, 50), 0, 100), y: Y_PAD + clamp(num(node.y, 50), 0, 100) * Y_SCALE };
}

/**
 * At most two lines, split where the longer of the two is shortest, so that
 * "Onboarding portal" breaks as "Onboarding / portal" and not "Onboarding
 * po / rtal". Text that fits in `max` stays on one line.
 */
function twoLines(text, max) {
  const words = textOf(text).split(/\s+/).filter(Boolean);
  const whole = words.join(' ');
  if (whole.length <= max || words.length < 2) return whole ? [whole] : [];
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const worst = Math.max(a.length, b.length);
    if (!best || worst < best.worst) best = { worst, lines: [a, b] };
  }
  // A one- or two-letter orphan ("Deployment / a") reads worse than a wide box.
  return Math.min(best.lines[0].length, best.lines[1].length) < 3 ? [whole] : best.lines;
}

/**
 * The rounded box a node is drawn in: centred on its grid position, sized to
 * its (wrapped) text, and nudged inwards if that would push it past the
 * picture edge. Returns { x, y, w, h, cx, cy, labelLines, subLines } where
 * cx, cy are the centre after the nudge, which is where edges aim.
 */
export function nodeBox(node) {
  const labelLines = twoLines(node.label, WRAP_LABEL);
  const subLines = node.sub ? twoLines(node.sub, WRAP_SUB) : [];
  const widest = (ls, fs, k) => ls.reduce((m, l) => Math.max(m, l.length * fs * k), 0);
  const textW = Math.max(widest(labelLines, FS_LABEL, W_SANS * 1.04), widest(subLines, FS_SUB, W_SANS));
  const w = Math.min(VIEW_W - 2, Math.max(NODE_MIN_W, textW + NODE_PAD_X * 2 + 1.4));
  const h = NODE_PAD_Y * 2 + labelLines.length * LINE_LABEL + subLines.length * LINE_SUB;
  const c = nodeCentre(node);
  const cx = clamp(c.x, VIEW_X0 + 1 + w / 2, VIEW_X1 - 1 - w / 2);
  const cy = clamp(c.y, 1 + h / 2, VIEW_H - 1 - h / 2);
  return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy, labelLines, subLines };
}

function nodeMap(diagram) {
  const m = new Map();
  for (const n of (diagram && diagram.nodes) || []) m.set(n.id, n);
  return m;
}

/** Where the line from (cx, cy) heading along (dx, dy) leaves a box centred there. */
function exitDistance(box, dx, dy) {
  const tx = dx === 0 ? Infinity : box.w / 2 / Math.abs(dx);
  const ty = dy === 0 ? Infinity : box.h / 2 / Math.abs(dy);
  return Math.min(tx, ty);
}

/**
 * The line for an edge, from the border of its source box to the border of
 * its target box (the arrowhead tip lands on the border). Returns
 * { x1, y1, x2, y2, mx, my, len, dx, dy } with (dx, dy) the unit direction
 * from source to target, or null if either end names no node.
 */
export function layoutEdge(diagram, edge) {
  const nodes = nodeMap(diagram);
  const a = nodes.get(edge.from);
  const b = nodes.get(edge.to);
  if (!a || !b) return null;
  const A = nodeBox(a);
  const B = nodeBox(b);
  let dx = B.cx - A.cx;
  let dy = B.cy - A.cy;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) {
    // Two boxes on the same spot: no direction to draw. Point right.
    dx = 1;
    dy = 0;
  } else {
    dx /= dist;
    dy /= dist;
  }
  const t1 = exitDistance(A, dx, dy);
  const t2 = exitDistance(B, dx, dy);
  const x1 = A.cx + dx * t1;
  const y1 = A.cy + dy * t1;
  const x2 = B.cx - dx * t2;
  const y2 = B.cy - dy * t2;
  const len = Math.max(0, (x2 - x1) * dx + (y2 - y1) * dy);
  return { x1, y1, x2, y2, mx: (x1 + x2) / 2, my: (y1 + y2) / 2, len, dx, dy };
}

/**
 * Everything one step shows, cleaned against the diagram: nodes and edges a
 * step names that do not exist are dropped rather than throwing. `i` is
 * clamped into range.
 *   { index, total, caption, active: [nodeId], packets: [{ edge, from, to,
 *     reverse, label, tone }], notes: [{ node, text, tone }] }
 * A reverse packet swaps `from` and `to`: they always say where it starts
 * and where it ends.
 */
export function stepModel(diagram, i) {
  const steps = (diagram && diagram.steps) || [];
  const total = steps.length;
  const index = total === 0 ? 0 : clamp(Math.trunc(num(i, 0)), 0, total - 1);
  const step = steps[index] || {};
  const nodes = nodeMap(diagram);
  const edges = new Map(((diagram && diagram.edges) || []).map((e) => [e.id, e]));
  const packets = [];
  for (const p of step.packets || []) {
    const e = edges.get(p.edge);
    if (!e || !nodes.has(e.from) || !nodes.has(e.to)) continue;
    const reverse = p.reverse === true;
    packets.push({
      edge: e.id,
      from: reverse ? e.to : e.from,
      to: reverse ? e.from : e.to,
      reverse,
      label: p.label == null ? '' : textOf(p.label),
      tone: toneOf(p.tone),
    });
  }
  return {
    index,
    total,
    caption: textOf(step.caption),
    active: (step.active || []).filter((id) => nodes.has(id)),
    packets,
    notes: (step.notes || [])
      .filter((n) => nodes.has(n.node))
      .map((n) => ({ node: n.node, text: textOf(n.text), tone: toneOf(n.tone) })),
  };
}

/**
 * The step after (dir > 0) or before (dir < 0) `i`. With `loop` it wraps
 * round; without it it stops at the ends. Anything out of range or not a
 * number is read as the nearest valid step, and an empty diagram is step 0.
 */
export function nextIndex(i, total, dir, loop) {
  const n = Math.trunc(num(total, 0));
  if (n <= 0) return 0;
  const cur = clamp(Math.trunc(num(i, 0)), 0, n - 1);
  const d = num(dir, 1) < 0 ? -1 : 1;
  const next = cur + d;
  if (next >= 0 && next < n) return next;
  if (!loop) return cur;
  return d > 0 ? 0 : n - 1;
}

/** Breaks text at spaces into lines of at most `max` characters (a longer word keeps its own line). */
export function wrapText(text, max) {
  const words = textOf(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > max) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const NOTE_GAP = 1.6;
const NOTE_LINE_H = 3.0;
const NOTE_PAD_X = 1.8;
const NOTE_PAD_Y = 1.3;
const NOTE_WRAP = 18;

/** Whether the segment (x1,y1)-(x2,y2) touches the rectangle (Liang-Barsky). */
export function segmentHitsRect(x1, y1, x2, y2, r) {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, x1 - r.x) && clip(dx, r.x + r.w - x1) && clip(-dy, y1 - r.y) && clip(dy, r.y + r.h - y1) && t0 <= t1;
}

const grow = (r, m) => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
const rectsOverlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Where to draw a note beside `node`: the wrapped lines, the callout's
 * rectangle and the side it sits on. Tries right, left, below and above and
 * takes the one that leaves the picture least, covers no other node, crosses
 * fewest edges and does not sit on a note already placed (`taken` is a list
 * of rectangles). Pure, so it can be tested.
 */
export function placeNote(diagram, nodeId, text, taken = []) {
  const nodes = nodeMap(diagram);
  const node = nodes.get(nodeId);
  if (!node) return null;
  // Even lines: "sum cost, group by team" as two halves, not a long line and an orphan.
  const whole = textOf(text).trim();
  const wanted = Math.max(1, Math.ceil(whole.length / NOTE_WRAP));
  const lines = wrapText(whole, Math.ceil(whole.length / wanted) + 2);
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const w = longest * FS_NOTE * W_SANS + NOTE_PAD_X * 2;
  const h = Math.max(1, lines.length) * NOTE_LINE_H + NOTE_PAD_Y * 2;
  const box = nodeBox(node);
  const others = [];
  for (const [id, n] of nodes) if (id !== nodeId) others.push(nodeBox(n));
  const segments = [];
  for (const e of (diagram && diagram.edges) || []) {
    const l = layoutEdge(diagram, e);
    if (l) segments.push(l);
  }
  const below = box.y + box.h + NOTE_GAP;
  const above = box.y - NOTE_GAP - h;
  const candidates = [
    { side: 'right', x: box.x + box.w + NOTE_GAP, y: box.cy - h / 2 },
    { side: 'left', x: box.x - NOTE_GAP - w, y: box.cy - h / 2 },
    { side: 'below', x: box.cx - w / 2, y: below },
    { side: 'above', x: box.cx - w / 2, y: above },
    { side: 'below', x: box.x, y: below },
    { side: 'below', x: box.x + box.w - w, y: below },
    { side: 'above', x: box.x, y: above },
    { side: 'above', x: box.x + box.w - w, y: above },
  ];
  let best = null;
  candidates.forEach((c, order) => {
    const rect = { x: c.x, y: c.y, w, h };
    // Slide a candidate back inside the picture; what it cannot recover is the cost.
    const fx = clamp(rect.x, VIEW_X0 + 0.5, Math.max(VIEW_X0 + 0.5, VIEW_X1 - 0.5 - w));
    const fy = clamp(rect.y, 0.5, Math.max(0.5, VIEW_H - 0.5 - h));
    const shift = Math.abs(fx - rect.x) + Math.abs(fy - rect.y);
    rect.x = fx;
    rect.y = fy;
    let cost = order * 0.5 + shift * 2;
    if (rectsOverlap(rect, grow(box, 0.6))) cost += 500;
    for (const o of others) if (rectsOverlap(rect, grow(o, 0.6))) cost += 400;
    for (const s of segments) if (segmentHitsRect(s.x1, s.y1, s.x2, s.y2, rect)) cost += 40;
    for (const t of taken) if (rectsOverlap(rect, t)) cost += 300;
    if (!best || cost < best.cost) best = { cost, side: c.side, rect };
  });
  return { lines, side: best.side, ...best.rect };
}

/** Size of the pill for a packet with this label, in grid units. */
export function packetSize(label) {
  return label ? { w: Math.max(6, label.length * FS_PACKET * W_MONO + 3), h: 4.2 } : { w: 3, h: 3 };
}

/** Margin kept round the content of the picture, and the least height it is drawn at, in grid units. */
const VIEW_MARGIN = 6;
const VIEW_MIN_H = 26;

/**
 * Where an edge's label sits: centred on (x, y), beside the line on its upper
 * side (or the right for a level line), clear of a packet riding it.
 * Returns { x, y, w, h } for the text's box.
 */
export function edgeLabelSpot(label, l) {
  let nx = -l.dy;
  let ny = l.dx;
  if (ny > 0 || (ny === 0 && nx < 0)) {
    nx = -nx;
    ny = -ny;
  }
  const text = textOf(label);
  const w = text.length * FS_EDGE * W_SANS;
  const h = FS_EDGE;
  const off = 1.5 + Math.abs(nx) * (w / 2) + Math.abs(ny) * (h / 2 + 1.4);
  return { x: l.mx + nx * off, y: l.my + ny * off, w, h };
}

/** Distance along an edge at which a travelling packet starts, and (mirrored) ends. */
function rideStart(l, w, h) {
  const ext = (w / 2) * Math.abs(l.dx) + (h / 2) * Math.abs(l.dy) + 0.6;
  return Math.max(Math.min(ext, l.len / 2), l.len * 0.28);
}

/**
 * The part of the picture that has something in it, as the viewBox to draw:
 * { x, y, w, h }. The width is always the grid's. The height fits the node
 * boxes, edge labels, packet pills (at rest and at both ends of their ride)
 * and note boxes of every step, plus a margin, and is never below a minimum
 * nor above the full picture, so a diagram on one row is not drawn in a tall
 * empty frame and a tall one is drawn as before.
 */
export function viewBoxFor(diagram) {
  let lo = Infinity;
  let hi = -Infinity;
  const take = (y0, y1) => {
    lo = Math.min(lo, y0);
    hi = Math.max(hi, y1);
  };
  const nodes = (diagram && diagram.nodes) || [];
  for (const n of nodes) {
    const b = nodeBox(n);
    take(b.y, b.y + b.h);
  }
  for (const e of (diagram && diagram.edges) || []) {
    const l = layoutEdge(diagram, e);
    if (l && e.label) {
      const r = edgeLabelSpot(e.label, l);
      take(r.y - r.h / 2, r.y + r.h / 2);
    }
  }
  const total = ((diagram && diagram.steps) || []).length;
  for (let i = 0; i < total; i++) {
    const m = stepModel(diagram, i);
    const perEdge = new Map();
    for (const p of m.packets) perEdge.set(p.edge, (perEdge.get(p.edge) || 0) + 1);
    const seen = new Map();
    const taken = [];
    for (const p of m.packets) {
      const e = ((diagram && diagram.edges) || []).find((x) => x.id === p.edge);
      const l = e && layoutEdge(diagram, e);
      if (!l) continue;
      const { w, h } = packetSize(p.label);
      const lane = seen.get(p.edge) || 0;
      seen.set(p.edge, lane + 1);
      const shift = (lane - (perEdge.get(p.edge) - 1) / 2) * (h + 0.8);
      const oy = l.dx * shift;
      const s0 = rideStart(l, w, h);
      for (const y of [l.my + oy, l.y1 + l.dy * s0 + oy, l.y1 + l.dy * (l.len - s0) + oy]) take(y - h / 2, y + h / 2);
      taken.push({ x: l.mx - w / 2, y: l.my - h / 2, w, h });
    }
    for (const n of m.notes) {
      const spot = placeNote(diagram, n.node, n.text, taken);
      if (!spot) continue;
      take(spot.y, spot.y + spot.h);
      taken.push({ x: spot.x, y: spot.y, w: spot.w, h: spot.h });
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { x: VIEW_X0, y: 0, w: VIEW_W, h: VIEW_H };
  const h = clamp(hi - lo + 2 * VIEW_MARGIN, VIEW_MIN_H, VIEW_H);
  const y = clamp((lo + hi) / 2 - h / 2, 0, VIEW_H - h);
  return { x: VIEW_X0, y, w: VIEW_W, h };
}

/** A sentence for what a step sends and notes, for the text list. */
export function stepDetail(diagram, model) {
  const nodes = nodeMap(diagram);
  const name = (id) => textOf((nodes.get(id) || {}).label) || id;
  const parts = [];
  for (const p of model.packets) {
    const what = p.label ? `${p.label}, ` : '';
    parts.push(`Sent: ${what}${name(p.from)} to ${name(p.to)}.`);
  }
  for (const n of model.notes) parts.push(`Note beside ${name(n.node)}: ${n.text}.`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

let instance = 0;

function setAttrs(el, attrs) {
  if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] != null) el.setAttribute(k, String(attrs[k]));
  return el;
}

const f = (n) => Math.round(n * 100) / 100;

/**
 * Builds the player. `diagram` is one entry of the diagram library.
 * opts (all optional):
 *   document       the document to build in (tests pass a stand-in)
 *   autoplay       true (default): play when scrolled into view; false: never
 *   reducedMotion  force the reduced-motion behaviour on or off; by default
 *                  the media query decides, live
 *   stepMs, packetMs, loopPauseMs   timings, in milliseconds
 *   startIndex     the step shown first (default 0)
 * The returned element has destroy(), which stops the timer and removes every
 * listener and observer, plus play(), pause() and goTo(i) for callers.
 */
export function renderDiagram(diagram, opts = {}) {
  const doc = opts.document || document;
  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const cfg = {
    stepMs: num(opts.stepMs, DEFAULTS.stepMs),
    packetMs: num(opts.packetMs, DEFAULTS.packetMs),
    loopPauseMs: num(opts.loopPauseMs, DEFAULTS.loopPauseMs),
  };
  const uid = `dg${++instance}`;
  const html = (tag, cls, text) => {
    const el = doc.createElement(tag);
    if (cls) el.setAttribute('class', cls);
    if (text != null) el.textContent = text;
    return el;
  };
  const svg = (tag, attrs, cls, text) => {
    const el = doc.createElementNS(SVG_NS, tag);
    if (cls) el.setAttribute('class', cls);
    setAttrs(el, attrs);
    if (text != null) el.textContent = text;
    return el;
  };

  const nodes = (diagram.nodes || []).filter((n) => n && typeof n.id === 'string');
  const edges = (diagram.edges || []).filter((e) => e && typeof e.id === 'string');
  const total = (diagram.steps || []).length;
  const boxes = new Map(nodes.map((n) => [n.id, nodeBox(n)]));
  const lines = new Map();
  for (const e of edges) {
    const l = layoutEdge(diagram, e);
    if (l) lines.set(e.id, l);
  }

  // --- root ---------------------------------------------------------------
  const root = html('div', 'diagram');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', textOf(diagram.title));
  root.setAttribute('aria-describedby', `${uid}-summary`);
  root.setAttribute('data-diagram-id', textOf(diagram.id));

  const titleEl = html('div', 'diagram-title', textOf(diagram.title));
  titleEl.setAttribute('aria-hidden', 'true');
  const summaryEl = html('p', 'diagram-sr-only', textOf(diagram.summary));
  summaryEl.setAttribute('id', `${uid}-summary`);

  // --- picture ------------------------------------------------------------
  const figure = html('div', 'diagram-figure');
  const view = viewBoxFor(diagram);
  const picture = svg('svg', {
    viewBox: `${f(view.x)} ${f(view.y)} ${f(view.w)} ${f(view.h)}`,
    preserveAspectRatio: 'xMidYMid meet',
    'aria-hidden': 'true',
    focusable: 'false',
  }, 'diagram-svg');

  const defs = svg('defs');
  const markers = {};
  for (const lit of [false, true]) {
    const id = `${uid}-arrow${lit ? '-lit' : ''}`;
    markers[lit ? 'lit' : 'plain'] = id;
    const m = svg('marker', {
      id,
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: ARROW,
      markerHeight: ARROW,
      markerUnits: 'userSpaceOnUse',
      orient: 'auto',
    });
    m.appendChild(svg('path', { d: 'M0 1 L10 5 L0 9 z' }, lit ? 'diagram-arrow diagram-arrow-lit' : 'diagram-arrow'));
    defs.appendChild(m);
  }
  picture.appendChild(defs);

  const edgeLayer = svg('g', null, 'diagram-edges');
  const edgeEls = new Map();
  for (const e of edges) {
    const l = lines.get(e.id);
    if (!l) continue;
    const g = svg('g', null, 'diagram-edge');
    g.setAttribute('data-edge', e.id);
    // The line stops where the arrowhead's base begins, so the tip, not the
    // line's end, touches the box.
    const lx = l.x2 - l.dx * ARROW * 0.8;
    const ly = l.y2 - l.dy * ARROW * 0.8;
    const line = svg('line', { x1: f(l.x1), y1: f(l.y1), x2: f(lx), y2: f(ly), 'marker-end': `url(#${markers.plain})` }, 'diagram-edge-line');
    g.appendChild(line);
    if (e.label) {
      const spot = edgeLabelSpot(e.label, l);
      g.appendChild(svg('text', { x: f(spot.x), y: f(spot.y), 'text-anchor': 'middle' }, 'diagram-edge-label', textOf(e.label)));
    }
    edgeLayer.appendChild(g);
    edgeEls.set(e.id, { g, line });
  }
  picture.appendChild(edgeLayer);

  const nodeLayer = svg('g', null, 'diagram-nodes');
  const nodeEls = new Map();
  for (const n of nodes) {
    const b = boxes.get(n.id);
    const kind = kindOf(n.kind);
    const g = svg('g', null, `diagram-node diagram-kind-${kind}`);
    g.setAttribute('data-node', n.id);
    g.setAttribute('data-kind', kind);
    const r = 2.2;
    g.appendChild(svg('rect', { x: f(b.x - 0.6), y: f(b.y - 0.6), width: f(b.w + 1.2), height: f(b.h + 1.2), rx: r + 0.6 }, 'diagram-node-glow'));
    g.appendChild(svg('rect', { x: f(b.x), y: f(b.y), width: f(b.w), height: f(b.h), rx: r }, 'diagram-node-box'));
    // The kind accent: a bar down the left edge, inside the rounded corners.
    g.appendChild(svg('rect', { x: f(b.x + 1.1), y: f(b.y + 1.5), width: 0.8, height: f(b.h - 3), rx: 0.4 }, 'diagram-node-bar'));
    let ty = b.y + NODE_PAD_Y;
    for (const ln of b.labelLines) {
      g.appendChild(svg('text', { x: f(b.cx + 0.6), y: f(ty + LINE_LABEL / 2), 'text-anchor': 'middle' }, 'diagram-node-label', ln));
      ty += LINE_LABEL;
    }
    for (const ln of b.subLines) {
      g.appendChild(svg('text', { x: f(b.cx + 0.6), y: f(ty + LINE_SUB / 2), 'text-anchor': 'middle' }, 'diagram-node-sub', ln));
      ty += LINE_SUB;
    }
    nodeLayer.appendChild(g);
    nodeEls.set(n.id, g);
  }
  picture.appendChild(nodeLayer);

  const noteLayer = svg('g', null, 'diagram-notes');
  const packetLayer = svg('g', null, 'diagram-packets');
  picture.appendChild(noteLayer);
  picture.appendChild(packetLayer);
  figure.appendChild(picture);

  // --- caption and controls ----------------------------------------------
  const caption = html('p', 'diagram-caption');
  caption.setAttribute('aria-live', 'polite');
  caption.setAttribute('aria-atomic', 'true');

  const button = (cls, glyph, label) => {
    const b = html('button', `diagram-btn ${cls}`);
    b.setAttribute('type', 'button');
    const g = html('span', 'diagram-btn-glyph', glyph);
    g.setAttribute('aria-hidden', 'true');
    const t = html('span', 'diagram-btn-label', label);
    b.appendChild(g);
    b.appendChild(t);
    return { b, g, t };
  };
  const play = button('diagram-play', '▶', 'Play');
  const prev = button('diagram-prev', '‹', 'Previous');
  const next = button('diagram-next', '›', 'Next');
  const restart = button('diagram-restart', '↺', 'Restart');
  const count = html('span', 'diagram-count');

  const controls = html('div', 'diagram-controls');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Playback');
  controls.appendChild(play.b);
  controls.appendChild(prev.b);
  controls.appendChild(next.b);
  controls.appendChild(count);
  controls.appendChild(restart.b);

  // --- the text version ---------------------------------------------------
  const text = html('details', 'diagram-text');
  text.appendChild(html('summary', 'diagram-text-summary', 'Read as text'));
  const list = html('ol', 'diagram-steps');
  for (let i = 0; i < total; i++) {
    const m = stepModel(diagram, i);
    const li = html('li', 'diagram-step-caption');
    li.appendChild(html('span', 'diagram-step-text', m.caption));
    const detail = stepDetail(diagram, m);
    if (detail) li.appendChild(html('span', 'diagram-step-detail', detail));
    list.appendChild(li);
  }
  text.appendChild(list);

  root.appendChild(titleEl);
  root.appendChild(summaryEl);
  root.appendChild(figure);
  root.appendChild(caption);
  root.appendChild(controls);
  root.appendChild(text);

  // --- state --------------------------------------------------------------
  const mq = win && typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => (typeof opts.reducedMotion === 'boolean' ? opts.reducedMotion : Boolean(mq && mq.matches));
  let index = total === 0 ? 0 : clamp(Math.trunc(num(opts.startIndex, 0)), 0, total - 1);
  let playing = false;
  /** Playing because it scrolled into view, not because someone pressed Play. */
  let auto = false;
  /** Someone pressed something: autoplay never starts (or resumes) again. */
  let touched = false;
  let inView = false;
  let timer = null;
  let destroyed = false;
  let running = [];

  function clearTimer() {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function stopAnimations() {
    for (const a of running) {
      try {
        a.cancel();
      } catch {
        // Already finished or detached.
      }
    }
    running = [];
  }

  function packetPill(p, label, tone) {
    const g = svg('g', null, `diagram-packet diagram-tone-${tone}`);
    g.setAttribute('data-edge', p.edge);
    if (p.reverse) g.setAttribute('data-reverse', 'true');
    const { w, h } = packetSize(label);
    g.appendChild(svg('rect', { x: f(-w / 2), y: f(-h / 2), width: f(w), height: h, rx: f(h / 2) }, 'diagram-packet-pill'));
    if (label) g.appendChild(svg('text', { x: 0, y: 0, 'text-anchor': 'middle' }, 'diagram-packet-label', label));
    return { g, w, h };
  }

  function draw(animate) {
    stopAnimations();
    const model = stepModel(diagram, index);
    const active = new Set(model.active);
    for (const [id, g] of nodeEls) g.classList.toggle('is-lit', active.has(id));
    const litEdges = new Set(model.packets.map((p) => p.edge));
    for (const [id, e] of edgeEls) {
      const lit = litEdges.has(id);
      e.g.classList.toggle('is-lit', lit);
      e.line.setAttribute('marker-end', `url(#${lit ? markers.lit : markers.plain})`);
    }

    caption.textContent = model.caption;
    count.textContent = `Step ${model.index + 1} of ${model.total}`;
    prev.b.setAttribute('aria-disabled', String(model.index <= 0));
    next.b.setAttribute('aria-disabled', String(model.index >= model.total - 1));
    root.setAttribute('data-step', String(model.index));

    // Notes.
    while (noteLayer.firstChild) noteLayer.removeChild(noteLayer.firstChild);
    // A note keeps clear of the packets resting at the middle of their edges too.
    const taken = [];
    for (const p of model.packets) {
      const l = lines.get(p.edge);
      if (!l) continue;
      const { w, h } = packetSize(p.label);
      taken.push({ x: l.mx - w / 2, y: l.my - h / 2, w, h });
    }
    for (const n of model.notes) {
      const spot = placeNote(diagram, n.node, n.text, taken);
      if (!spot) continue;
      taken.push({ x: spot.x, y: spot.y, w: spot.w, h: spot.h });
      const g = svg('g', null, `diagram-note diagram-tone-${n.tone}`);
      g.setAttribute('data-node', n.node);
      g.appendChild(svg('rect', { x: f(spot.x), y: f(spot.y), width: f(spot.w), height: f(spot.h), rx: 1.6 }, 'diagram-note-box'));
      spot.lines.forEach((ln, k) => {
        g.appendChild(svg('text', { x: f(spot.x + NOTE_PAD_X), y: f(spot.y + NOTE_PAD_Y + NOTE_LINE_H * (k + 0.5)) }, 'diagram-note-text', ln));
      });
      noteLayer.appendChild(g);
    }

    // Packets: at the edge midpoint unless they may travel.
    while (packetLayer.firstChild) packetLayer.removeChild(packetLayer.firstChild);
    const travel = animate && !reduced();
    const stagger = model.packets.length > 1 ? Math.min(cfg.packetMs, Math.max(0, (cfg.stepMs * 0.9 - cfg.packetMs) / (model.packets.length - 1))) : 0;
    // Packets sharing an edge ride in separate lanes either side of the line,
    // so a request and its reply never sit on top of one another.
    const perEdge = new Map();
    for (const p of model.packets) perEdge.set(p.edge, (perEdge.get(p.edge) || 0) + 1);
    const seen = new Map();
    model.packets.forEach((p, k) => {
      const l = lines.get(p.edge);
      if (!l) return;
      const { g, w, h } = packetPill(p, p.label, p.tone);
      const lane = seen.get(p.edge) || 0;
      seen.set(p.edge, lane + 1);
      const shift = (lane - (perEdge.get(p.edge) - 1) / 2) * (h + 0.8);
      const ox = -l.dy * shift;
      const oy = l.dx * shift;
      g.setAttribute('transform', `translate(${f(l.mx + ox)} ${f(l.my + oy)})`);
      packetLayer.appendChild(g);
      if (!travel || typeof g.animate !== 'function') return;
      // Ends of the ride: from just clear of the source box to just clear of
      // the target box, but never so far that a wide pill on a short edge
      // stops moving altogether.
      const s0 = rideStart(l, w, h);
      const sign = p.reverse ? -1 : 1;
      const at = (s) => {
        const t = sign > 0 ? s : l.len - s;
        return `translate(${f(l.x1 + l.dx * t + ox)}px, ${f(l.y1 + l.dy * t + oy)}px)`;
      };
      const from = at(s0);
      const to = at(l.len - s0);
      try {
        const anim = g.animate(
          [
            { transform: from, opacity: 0, offset: 0 },
            { transform: from, opacity: 1, offset: 0.1 },
            { transform: to, opacity: 1, offset: 1 },
          ],
          { duration: cfg.packetMs, delay: stagger * k, easing: 'ease-in-out', fill: 'both' }
        );
        running.push(anim);
      } catch {
        // No Web Animations here: the pill stays at the midpoint.
      }
    });
  }

  function syncPlayButton() {
    play.g.textContent = playing ? '⏸' : '▶';
    play.t.textContent = playing ? 'Pause' : 'Play';
    root.classList.toggle('is-playing', playing);
  }

  function schedule() {
    clearTimer();
    if (!playing || destroyed || (doc.hidden === true)) return;
    const last = index >= total - 1;
    timer = setTimeout(() => {
      timer = null;
      if (!playing || destroyed) return;
      index = nextIndex(index, total, 1, true);
      draw(true);
      schedule();
    }, cfg.stepMs + (last ? cfg.loopPauseMs : 0));
  }

  function setPlaying(on, fromAuto) {
    if (total < 2) on = false;
    playing = on;
    auto = on && Boolean(fromAuto);
    syncPlayButton();
    if (on) {
      draw(true);
      schedule();
    } else {
      clearTimer();
    }
  }

  /** Any hand on the player: autoplay gives way for good. */
  function touch() {
    touched = true;
    if (auto) setPlaying(false);
    auto = false;
  }

  function goTo(i, animate = true) {
    index = total === 0 ? 0 : clamp(Math.trunc(num(i, 0)), 0, total - 1);
    draw(animate);
    if (playing) schedule();
  }

  const on = (target, type, fn, o) => {
    target.addEventListener(type, fn, o);
    disposers.push(() => target.removeEventListener(type, fn, o));
  };
  const disposers = [];

  on(play.b, 'click', () => {
    touched = true;
    if (playing) {
      setPlaying(false);
    } else {
      // Playing from the last step means playing again from the first.
      if (index >= total - 1) index = 0;
      setPlaying(true, false);
    }
  });
  on(prev.b, 'click', () => {
    touch();
    if (prev.b.getAttribute('aria-disabled') === 'true') return;
    goTo(nextIndex(index, total, -1, false));
  });
  on(next.b, 'click', () => {
    touch();
    if (next.b.getAttribute('aria-disabled') === 'true') return;
    goTo(nextIndex(index, total, 1, false));
  });
  on(restart.b, 'click', () => {
    touched = true;
    index = 0;
    if (reduced()) {
      setPlaying(false);
      draw(false);
    } else {
      // From a paused or a running state alike: start over and play.
      setPlaying(true, false);
    }
  });
  // Poking at the picture or the text list counts too.
  // (The buttons handle themselves: stopping on their pointerdown or keydown
  // would let the click that follows start playback again.)
  const outsideButtons = (ev) => !(ev.target && typeof ev.target.closest === 'function' && ev.target.closest('.diagram-btn'));
  on(root, 'pointerdown', (ev) => {
    if (!outsideButtons(ev)) return;
    if (auto) touch();
    touched = true;
  });
  on(root, 'keydown', (ev) => {
    if (!outsideButtons(ev)) return;
    if (auto) touch();
    touched = true;
  });
  on(text, 'toggle', () => {
    if (auto) touch();
    touched = true;
  });

  // Hidden tab: stop the clock, and pick it up again when it is back.
  if (doc.addEventListener) {
    on(doc, 'visibilitychange', () => {
      if (doc.hidden) clearTimer();
      else schedule();
    });
  }

  // Reduced motion switched on mid-way: stop travelling and playing at once.
  if (mq && typeof mq.addEventListener === 'function' && typeof opts.reducedMotion !== 'boolean') {
    on(mq, 'change', () => {
      if (reduced()) {
        if (auto) setPlaying(false);
        draw(false);
      }
    });
  }

  let observer = null;
  const IO = win && win.IntersectionObserver;
  if (opts.autoplay !== false && IO && total > 1) {
    observer = new IO(
      (entries) => {
        const e = entries[entries.length - 1];
        if (!e) return;
        inView = e.isIntersecting;
        if (inView && !touched && !playing && !reduced() && !destroyed) setPlaying(true, true);
        else if (!inView && auto) setPlaying(false);
      },
      { threshold: 0.5 }
    );
    observer.observe(root);
  }

  root.destroy = () => {
    destroyed = true;
    clearTimer();
    stopAnimations();
    if (observer) observer.disconnect();
    observer = null;
    while (disposers.length) disposers.pop()();
  };
  root.play = () => {
    touched = true;
    setPlaying(true, false);
  };
  root.pause = () => {
    touched = true;
    setPlaying(false);
  };
  root.goTo = (i) => {
    touched = true;
    goTo(i);
  };

  syncPlayButton();
  draw(false);
  if (reduced()) root.classList.add('is-reduced');
  return root;
}

/**
 * Replaces every `[data-diagram="<id>"]` placeholder under `root` with a
 * player. The diagram comes from `library` (an array of diagrams) or from
 * `<script type="application/json" data-diagram-library>` blocks in the page,
 * which are data, not code, so a strict script-src policy allows them. A
 * placeholder may carry data-autoplay="false", data-step-ms, data-packet-ms,
 * data-reduced-motion="true|false" and data-start. A `[data-diagram-all]`
 * container is filled with one non-autoplaying player per library diagram.
 */
export function mountDiagrams(root = document, library = []) {
  const byId = new Map();
  for (const d of library) byId.set(d.id, d);
  for (const s of root.querySelectorAll('script[type="application/json"][data-diagram-library]')) {
    try {
      const parsed = JSON.parse(s.textContent || '{}');
      for (const d of Array.isArray(parsed) ? parsed : parsed.diagrams || []) byId.set(d.id, d);
    } catch {
      // A broken block hides its own diagrams only.
    }
  }
  // <div data-diagram-all> stands for one placeholder per diagram in the library.
  for (const all of root.querySelectorAll('[data-diagram-all]')) {
    if (all.dataset.mounted) continue;
    all.dataset.mounted = '1';
    for (const d of library) {
      const wrap = root.ownerDocument ? root.ownerDocument.createElement('div') : document.createElement('div');
      wrap.setAttribute('data-diagram', d.id);
      wrap.setAttribute('data-autoplay', 'false');
      all.appendChild(wrap);
    }
  }
  const players = [];
  for (const slot of root.querySelectorAll('[data-diagram]')) {
    if (slot.dataset.mounted) continue;
    const d = byId.get(slot.getAttribute('data-diagram'));
    slot.dataset.mounted = '1';
    if (!d) {
      slot.textContent = 'Diagram not found.';
      continue;
    }
    const o = {};
    if (slot.dataset.autoplay === 'false') o.autoplay = false;
    if (slot.dataset.stepMs) o.stepMs = Number(slot.dataset.stepMs);
    if (slot.dataset.packetMs) o.packetMs = Number(slot.dataset.packetMs);
    if (slot.dataset.reducedMotion) o.reducedMotion = slot.dataset.reducedMotion === 'true';
    if (slot.dataset.start) o.startIndex = Number(slot.dataset.start);
    const el = renderDiagram(d, o);
    slot.textContent = '';
    slot.appendChild(el);
    players.push(el);
  }
  return players;
}
