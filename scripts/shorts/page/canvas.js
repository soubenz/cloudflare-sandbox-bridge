/**
 * The `canvas` visual: one persistent scene that builds up while the narration
 * runs, in the manner of a whiteboard explainer. A scene declares its elements
 * once (chips, nodes, arrows, packets, lists, cards, a terminal...), all hidden
 * unless `visible: true`. Each segment's `beats` then change it on a word:
 * show / hide an element, draw an arrow, send a packet along it, put a dashed
 * focus box round something, pulse a ring, dim, move, recolour or retext,
 * switch the layout to `split` (the terminal beside or under the canvas), start
 * the terminal typing (`run`) and light a highlight (`mark`).
 *
 * Elements sit on a 1000 x 700 grid (`pos: [x, y]` is the element's centre),
 * scaled to the frame, so one scene serves both formats. Like everything on
 * the page, update(t) depends on t alone.
 */

export const PALETTE = {
  pink: '#ff7eb6', yellow: '#ffd166', cyan: '#5ad8f5', green: '#6ee7a8', blue: '#8ab4ff',
  violet: '#c4a3ff', orange: '#ffa94d', red: '#ff6b6b', white: '#f2f2f2', grey: '#8a8f98',
};
const W = 1000;
const H = 700;

/** Where the canvas (and, in `split`, the terminal) sits in each format, in frame pixels. */
export const REGIONS = {
  vertical: {
    canvas: { canvas: { x: 40, y: 150, w: 1000, h: 700 } },
    split: { canvas: { x: 140, y: 118, w: 800, h: 560 }, term: { x: 40, y: 690, w: 1000, h: 470 } },
  },
  landscape: {
    canvas: { canvas: { x: 330, y: 100, w: 1260, h: 860 } },
    split: { canvas: { x: 30, y: 170, w: 1020, h: 714 }, term: { x: 1080, y: 130, w: 810, h: 820 } },
  },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
const easeOut = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
const easeInOut = (x) => { x = clamp(x, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const backOut = (x) => { x = clamp(x, 0, 1); const c = 1.7; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
const asList = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const SVG = 'http://www.w3.org/2000/svg';

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
function s(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
/** Text with emoji in the colour emoji font. */
function rich(el, text) {
  for (const p of String(text ?? '').split(/(\p{Extended_Pictographic}️?)/u)) {
    if (!p) continue;
    if (/\p{Extended_Pictographic}/u.test(p)) el.appendChild(h('span', 'emoji', p));
    else el.appendChild(document.createTextNode(p));
  }
  return el;
}

/** Line icons, 24-unit grid, drawn in the element's colour. */
const ICONS = {
  agent: '<rect x="4" y="7" width="16" height="12" rx="3"/><circle cx="9" cy="13" r="1.4"/><circle cx="15" cy="13" r="1.4"/><path d="M12 7V4M10 4h4"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  gateway: '<path d="M5 21V9a7 7 0 0 1 14 0v12"/><path d="M3 21h18M12 13v4"/>',
  key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M21 12v2"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 11a3.5 3.5 0 0 0 1 7z"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  check: '<path d="M5 12l4 4 10-10"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  log: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  model: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a3 3 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
};
function icon(name, size) {
  const span = h('span', 'cv-ico');
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.server}</svg>`;
  return span;
}

// --- syntax colours for terminal and card lines ------------------------------------------

const JSONISH = /(https?:\/\/[^\s"']+)|("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-->|<--)|(-?\b\d+(?:\.\d+)?\b)/g;
function lineSpans(line, highlights, colorOf) {
  const cls = new Array(line.length).fill('');
  const mark = (a, b, c) => { for (let i = a; i < b; i++) cls[i] = c; };
  let m;
  JSONISH.lastIndex = 0;
  while ((m = JSONISH.exec(line))) {
    if (m[1]) mark(m.index, m.index + m[0].length, 'tk-url');
    else if (m[2]) mark(m.index, m.index + m[2].length, m[3] ? 'tk-key' : 'tk-str');
    else if (m[4]) mark(m.index, m.index + m[0].length, 'tk-lit');
    else if (m[5]) mark(m.index, m.index + m[0].length, 'tk-arrow');
    else if (m[6]) mark(m.index, m.index + m[0].length, 'tk-num');
  }
  const hl = new Array(line.length).fill(-1);
  highlights.forEach((spec, i) => {
    if (spec.lines && !new RegExp(spec.lines).test(line)) return;
    const re = new RegExp(spec.match, 'g');
    let x;
    while ((x = re.exec(line))) {
      if (!x[0].length) { re.lastIndex++; continue; }
      for (let k = x.index; k < x.index + x[0].length; k++) hl[k] = i;
    }
  });
  const frag = document.createDocumentFragment();
  const marks = [];
  let i = 0;
  while (i < line.length) {
    const hi = hl[i];
    let j = i;
    while (j < line.length && hl[j] === hi) j++;
    let host = frag;
    if (hi >= 0) {
      host = h('span', 'cv-hl');
      host.style.setProperty('--c', colorOf(highlights[hi].color || 'green'));
      marks.push({ node: host, id: highlights[hi].id });
      frag.appendChild(host);
    }
    let a = i;
    while (a < j) {
      let b = a;
      while (b < j && cls[b] === cls[a]) b++;
      const text = line.slice(a, b);
      host.appendChild(cls[a] ? h('span', cls[a], text) : document.createTextNode(text));
      a = b;
    }
    i = j;
  }
  return { frag, marks };
}

/** "0,2,5-10" -> [0, 2, 5, 6, ..., 10] */
function lineSet(spec, n) {
  if (spec == null) return [...Array(n).keys()];
  const out = [];
  for (const part of String(spec).split(',')) {
    const [a, b] = part.split('-').map((x) => Number(x.trim()));
    for (let k = a; k <= (Number.isFinite(b) ? b : a); k++) if (k >= 0 && k < n) out.push(k);
  }
  return out;
}

// --- the scene ------------------------------------------------------------------------------

export function buildCanvas(v, { format = 'vertical' } = {}) {
  const scene = v.scene || {};
  const colorMap = v.colors || {};
  const colorOf = (name) => {
    if (!name) return PALETTE.white;
    const mapped = colorMap[name] ?? name;
    return PALETTE[mapped] || (/^#/.test(mapped) ? mapped : PALETTE.white);
  };
  const regions = REGIONS[format] || REGIONS.vertical;

  const root = h('div', 'cv-root');
  const cv = h('div', 'cv');
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  root.appendChild(cv);
  const under = s('svg', { class: 'cv-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  const over = s('svg', { class: 'cv-svg cv-over', viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  cv.appendChild(under);
  const layer = h('div', 'cv-layer');
  cv.appendChild(layer);
  cv.appendChild(over);

  // Element state is folded from events (t-sorted) every frame.
  const items = new Map(); // id -> { spec, node, kind, ev: [] , hw, hh }
  const sceneEv = [];
  const terminals = [];

  function addItem(id, spec, node, kind) {
    const it = { id, spec, node, kind, ev: [], hw: 0, hh: 0, pos: spec.pos ? [...spec.pos] : [W / 2, H / 2] };
    items.set(id, it);
    return it;
  }

  for (const [id, spec] of Object.entries(scene.elements || {})) {
    const type = spec.type;
    const c = colorOf(spec.color);
    if (type === 'arrow') {
      const g = s('g', { class: 'cv-arrow' });
      const path = s('path', { class: 'cv-arrow-line', stroke: c, 'stroke-dasharray': spec.dashed ? '10 9' : 'none' });
      const head = s('path', { class: 'cv-arrow-head', fill: c });
      g.append(path, head);
      let label = null;
      if (spec.label) {
        label = h('div', 'cv-el cv-arrow-label', spec.label);
        label.style.setProperty('--c', c);
        layer.appendChild(label);
      }
      under.appendChild(g);
      const it = addItem(id, spec, g, 'arrow');
      Object.assign(it, { path, head, label });
      continue;
    }
    if (type === 'packet') {
      const node = h('div', 'cv-el cv-packet', spec.label || '');
      node.style.setProperty('--c', c);
      layer.appendChild(node);
      addItem(id, spec, node, 'packet');
      continue;
    }
    if (type === 'terminal') {
      const term = buildTerminal(id, spec, colorOf);
      root.appendChild(term.el);
      const it = addItem(id, spec, term.el, 'terminal');
      it.term = term;
      terminals.push(it);
      continue;
    }
    let node;
    if (type === 'kicker') node = h('div', 'cv-el cv-kicker', spec.text);
    else if (type === 'title') {
      node = rich(h('div', `cv-el cv-title${spec.underline ? ' underline' : ''}`), spec.text);
      if (spec.size) node.style.fontSize = `${spec.size}px`;
      if (spec.width) node.style.width = `${spec.width}px`;
    } else if (type === 'text') {
      node = rich(h('div', `cv-el cv-text font-${spec.font || 'hand'}`), spec.text);
      if (spec.size) node.style.fontSize = `${spec.size}px`;
      if (spec.width) node.style.width = `${spec.width}px`;
    } else if (type === 'chip') {
      node = h('div', `cv-el cv-chip font-${spec.font || 'hand'}`);
      if (spec.icon) node.appendChild(icon(spec.icon, 32));
      rich(node.appendChild(h('span', 'cv-label')), spec.text);
      if (spec.sub) node.appendChild(h('span', 'cv-sub', spec.sub));
    } else if (type === 'node') {
      node = h('div', 'cv-el cv-node');
      if (spec.icon) node.appendChild(icon(spec.icon, 50));
      const txt = h('div', 'cv-node-text');
      rich(txt.appendChild(h('div', 'cv-label')), spec.label);
      if (spec.sub) txt.appendChild(h('div', 'cv-sub', spec.sub));
      node.appendChild(txt);
      if (spec.width) node.style.width = `${spec.width}px`;
    } else if (type === 'circle') {
      node = h('div', 'cv-el cv-circle', spec.text ?? '');
    } else if (type === 'bubble') {
      node = rich(h('div', `cv-el cv-bubble side-${spec.side || 'left'}`), spec.text);
      if (spec.width) node.style.maxWidth = `${spec.width}px`;
    } else if (type === 'stamp') {
      node = h('div', 'cv-el cv-stamp', spec.text);
      if (spec.size) node.style.fontSize = `${spec.size}px`;
    } else if (type === 'icon') {
      node = h('div', 'cv-el cv-icon');
      node.appendChild(icon(spec.icon, spec.size || 64));
    } else if (type === 'list') {
      node = h('div', `cv-el cv-list${spec.row ? ' row' : ''}`);
      if (spec.title) node.appendChild(h('div', 'cv-list-title', spec.title));
      const it = addItem(id, spec, node, 'list');
      it.children = (spec.items || []).map((x, k) => {
        const item = typeof x === 'string' ? { text: x } : x;
        const chip = h('div', `cv-chip font-${item.font || spec.font || 'mono'}`);
        rich(chip.appendChild(h('span', 'cv-label')), item.text);
        chip.style.setProperty('--c', colorOf(item.color || spec.color));
        node.appendChild(chip);
        const child = { id: `${id}/${k}`, node: chip, ev: [], gated: Boolean(spec.gate) };
        items.set(child.id, { ...child, kind: 'item', spec: item, parent: it });
        return items.get(child.id);
      });
      node.style.setProperty('--c', c);
      layer.appendChild(node);
      continue;
    } else if (type === 'card') {
      node = h('div', 'cv-el cv-card');
      if (spec.title) node.appendChild(h('div', 'cv-card-title', spec.title));
      const marks = [];
      for (const line of spec.lines || []) {
        const row = h('div', 'cv-card-line');
        const sp = lineSpans(line, spec.highlight || [], colorOf);
        row.appendChild(sp.frag);
        marks.push(...sp.marks);
        node.appendChild(row);
      }
      const it = addItem(id, spec, node, 'card');
      it.marks = marks;
      node.style.setProperty('--c', c);
      layer.appendChild(node);
      continue;
    } else {
      throw new Error(`scene "${scene.id || v.segment}": element "${id}" has unknown type "${type}"`);
    }
    node.style.setProperty('--c', c);
    layer.appendChild(node);
    addItem(id, spec, node, type);
  }

  // Events from the beats.
  const ev = (id, e) => {
    const it = items.get(id);
    if (it) it.ev.push(e);
  };
  for (const b of v.beats || []) {
    const t = b.t;
    asList(b.show).forEach((id, k) => ev(id, { t: t + k * (b.stagger || 0), k: 'show' }));
    asList(b.hide).forEach((id) => ev(id, { t, k: 'hide' }));
    asList(b.dim).forEach((id) => ev(id, { t, k: 'dim' }));
    if (b.undim === 'all') for (const id of items.keys()) ev(id, { t, k: 'undim' });
    else asList(b.undim).forEach((id) => ev(id, { t, k: 'undim' }));
    asList(b.ring).forEach((id) => ev(id, { t, k: 'ring' }));
    asList(b.travel).forEach((id, k) => ev(id, { t: t + k * (b.stagger || 0), k: 'travel' }));
    for (const [id, p] of Object.entries(b.move || {})) ev(id, { t, k: 'move', v: p });
    for (const [id, txt] of Object.entries(b.text || {})) ev(id, { t, k: 'text', v: txt });
    for (const [id, col] of Object.entries(b.color || {})) ev(id, { t, k: 'color', v: col });
    if ('focus' in b) sceneEv.push({ t, k: 'focus', v: asList(b.focus) });
    if (b.layout) sceneEv.push({ t, k: 'layout', v: b.layout });
    if (b.run) ev(b.run, { t, k: 'run', v: b.times });
    for (const m of asList(b.mark)) {
      for (const it of items.values()) if ((it.kind === 'terminal' || it.kind === 'card') && (it.spec.highlight || []).some((x) => x.id === m)) it.ev.push({ t, k: 'mark', v: m });
    }
  }
  for (const it of items.values()) it.ev.sort((a, b) => a.t - b.t);
  sceneEv.sort((a, b) => a.t - b.t);

  const focusRect = s('rect', { class: 'cv-focus', rx: 18 });
  over.appendChild(focusRect);
  const ringLayer = s('g');
  over.appendChild(ringLayer);
  const rings = [];

  /** The element's state at t: { shown, alpha, scale, pos, ... } folded from its events. */
  function state(it, t) {
    let shownAt = it.spec.visible ? -1e9 : null;
    let hiddenAt = null;
    let dimAt = null;
    let undimAt = null;
    let pos = it.pos || [0, 0];
    let from = pos;
    let movedAt = null;
    let text = null;
    let color = null;
    let ringAt = null;
    let travelAt = null;
    let run = null;
    const marks = new Set();
    for (const e of it.ev) {
      if (e.t > t) break;
      if (e.k === 'show') { shownAt = e.t; hiddenAt = null; }
      else if (e.k === 'hide') hiddenAt = e.t;
      else if (e.k === 'dim') { dimAt = e.t; undimAt = null; }
      else if (e.k === 'undim' && dimAt != null) undimAt = e.t;
      else if (e.k === 'move') { from = pos; pos = e.v; movedAt = e.t; }
      else if (e.k === 'text') text = e.v;
      else if (e.k === 'color') color = e.v;
      else if (e.k === 'ring') ringAt = e.t;
      else if (e.k === 'travel') travelAt = e.t;
      else if (e.k === 'run') run = e.v;
      else if (e.k === 'mark') marks.add(e.v);
    }
    let alpha = 0;
    let scale = 1;
    if (shownAt != null) {
      const k = (t - shownAt) / 0.32;
      alpha = clamp(k * 1.6, 0, 1);
      scale = lerp(0.82, 1, backOut(k));
      if (hiddenAt != null) alpha *= 1 - clamp((t - hiddenAt) / 0.28, 0, 1);
    }
    let dim = 0;
    if (dimAt != null) dim = clamp((t - dimAt) / 0.35, 0, 1) * (undimAt != null ? 1 - clamp((t - undimAt) / 0.35, 0, 1) : 1);
    const mk = movedAt == null ? 1 : easeInOut((t - movedAt) / 0.6);
    const p = [lerp(from[0], pos[0], mk), lerp(from[1], pos[1], mk)];
    return { shownAt, hiddenAt, alpha, scale, dim, pos: p, text, color, ringAt, travelAt, run, marks };
  }

  function edgePoint(it, toward, st) {
    const [cx, cy] = st.pos;
    const dx = toward[0] - cx;
    const dy = toward[1] - cy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const tt = Math.min(it.hw / Math.max(1e-6, Math.abs(ux)), it.hh / Math.max(1e-6, Math.abs(uy)));
    return [cx + ux * (tt + 10), cy + uy * (tt + 10)];
  }

  function arrowEnds(it, t) {
    const a = items.get(it.spec.from);
    const b = items.get(it.spec.to);
    if (!a || !b) return null;
    const sa = state(a, t);
    const sb = state(b, t);
    let p0 = edgePoint(a, sb.pos, sa);
    let p1 = edgePoint(b, sa.pos, sb);
    const off = it.spec.offset || 0; // parallel lanes for two arrows between the same pair
    if (off) {
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
      const nx = -(p1[1] - p0[1]) / len;
      const ny = (p1[0] - p0[0]) / len;
      p0 = [p0[0] + nx * off, p0[1] + ny * off];
      p1 = [p1[0] + nx * off, p1[1] + ny * off];
    }
    return [p0, p1];
  }

  function regionRect(name) {
    const r = (regions[name] || regions.canvas).canvas;
    const sc = Math.min(r.w / W, r.h / H);
    return { x: r.x + (r.w - W * sc) / 2, y: r.y + (r.h - H * sc) / 2, s: sc };
  }

  let measured = false;
  function measure() {
    for (const it of items.values()) {
      if (it.kind === 'arrow' || it.kind === 'item' || it.kind === 'terminal') continue;
      it.hw = (it.node.offsetWidth / 2) * (it.spec.scale || 1);
      it.hh = (it.node.offsetHeight / 2) * (it.spec.scale || 1);
    }
    for (const it of terminals) it.term.measure(regions.split.term);
    measured = true;
  }

  function update(t) {
    if (!measured) measure();
    // Layout: canvas alone, or split with the terminal.
    let layout = scene.layout || 'canvas';
    let prevLayout = layout;
    let layoutAt = -1e9;
    for (const e of sceneEv) if (e.k === 'layout' && e.t <= t) { prevLayout = layout; layout = e.v; layoutAt = e.t; }
    const lk = easeInOut((t - layoutAt) / 0.6);
    const ra = regionRect(prevLayout);
    const rb = regionRect(layout);
    const sc = lerp(ra.s, rb.s, lk);
    cv.style.transform = `translate(${lerp(ra.x, rb.x, lk)}px, ${lerp(ra.y, rb.y, lk)}px) scale(${sc})`;
    const splitness = layout === 'split' ? lk : prevLayout === 'split' ? 1 - lk : 0;

    // Only the terminal run last is on show (crossfading from the one before).
    let active = terminals[0];
    let activeAt = -Infinity;
    for (const it of terminals) for (const e of it.ev) if (e.k === 'run' && e.t <= t && e.t > activeAt) { active = it; activeAt = e.t; }
    const states = new Map();
    for (const it of items.values()) {
      if (it.kind === 'item') continue;
      const st = state(it, t);
      states.set(it.id, st);
      if (it.kind === 'arrow') continue;
      if (it.kind === 'terminal') {
        const on = it !== active ? 0 : activeAt === -Infinity ? 1 : clamp((t - activeAt) / 0.3, 0, 1);
        it.term.update(t, st, splitness * on);
        continue;
      }
      if (it.kind === 'packet') continue;
      const n = it.node;
      n.style.opacity = String(st.alpha * (1 - 0.75 * st.dim));
      n.style.left = `${st.pos[0]}px`;
      n.style.top = `${st.pos[1]}px`;
      const rot = it.kind === 'stamp' ? ` rotate(${it.spec.rotate ?? -8}deg)` : '';
      const slam = it.kind === 'stamp' && st.shownAt != null ? lerp(1.8, 1, easeOut((t - st.shownAt) / 0.18)) : st.scale;
      n.style.transform = `translate(-50%, -50%) scale(${slam * (it.spec.scale || 1)})${rot}`;
      n.style.visibility = st.alpha > 0.001 ? 'visible' : 'hidden';
      if (st.color) n.style.setProperty('--c', colorOf(st.color));
      if (st.text != null && it.lastText !== st.text) {
        const target = n.querySelector('.cv-label') || n;
        target.textContent = '';
        rich(target, st.text);
        it.lastText = st.text;
        it.hw = (n.offsetWidth / 2) * (it.spec.scale || 1);
        it.hh = (n.offsetHeight / 2) * (it.spec.scale || 1);
      }
      if (it.kind === 'card') for (const m of it.marks) m.node.classList.toggle('on', st.marks.has(m.id));
      if (it.kind === 'list') {
        for (const ch of it.children) {
          let a = 1;
          let scl = 1;
          if (ch.gated) {
            const cs = state(ch, t);
            a = cs.alpha * (1 - 0.75 * cs.dim);
            scl = cs.scale;
            if (cs.color) ch.node.style.setProperty('--c', colorOf(cs.color));
            if (cs.ringAt != null) ringFor(ch, cs, t, n);
          }
          ch.node.style.opacity = String(a);
          ch.node.style.transform = `scale(${scl})`;
        }
      }
    }

    // Arrows draw themselves from source to target.
    for (const it of items.values()) {
      if (it.kind !== 'arrow') continue;
      const st = states.get(it.id);
      const ends = st.alpha > 0 ? arrowEnds(it, t) : null;
      if (!ends) { it.node.style.opacity = '0'; if (it.label) it.label.style.opacity = '0'; continue; }
      const draw = st.shownAt == null ? 1 : easeOut((t - st.shownAt) / 0.5);
      const [p0, p1] = ends;
      const tip = [lerp(p0[0], p1[0], draw), lerp(p0[1], p1[1], draw)];
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
      const ux = (p1[0] - p0[0]) / len;
      const uy = (p1[1] - p0[1]) / len;
      const base = [tip[0] - ux * 16, tip[1] - uy * 16];
      it.path.setAttribute('d', `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)} L${base[0].toFixed(1)} ${base[1].toFixed(1)}`);
      it.head.setAttribute('d', `M${tip[0].toFixed(1)} ${tip[1].toFixed(1)} L${(base[0] - uy * 8).toFixed(1)} ${(base[1] + ux * 8).toFixed(1)} L${(base[0] + uy * 8).toFixed(1)} ${(base[1] - ux * 8).toFixed(1)} Z`);
      const a = String(clamp(draw * 3, 0, 1) * st.alpha * (1 - 0.75 * st.dim));
      it.node.style.opacity = a;
      if (st.color) { it.path.setAttribute('stroke', colorOf(st.color)); it.head.setAttribute('fill', colorOf(st.color)); }
      if (it.label) {
        const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
        // The normal that points up (or left, on a vertical arrow); `labelSide: below` takes the other one.
        let nx = -uy;
        let ny = ux;
        if (ny > 0 || (Math.abs(ny) < 1e-6 && nx > 0)) { nx = -nx; ny = -ny; }
        const d = it.spec.labelSide === 'below' ? -30 : 30;
        it.label.style.left = `${mid[0] + nx * d}px`;
        it.label.style.top = `${mid[1] + ny * d}px`;
        it.label.style.opacity = String(clamp((draw - 0.6) * 3, 0, 1) * st.alpha * (1 - 0.75 * st.dim));
        it.label.style.transform = 'translate(-50%, -50%)';
      }
    }

    // Packets ride an arrow.
    for (const it of items.values()) {
      if (it.kind !== 'packet') continue;
      const st = states.get(it.id);
      const n = it.node;
      const arrow = items.get(it.spec.on);
      if (st.travelAt == null || !arrow) { n.style.opacity = '0'; n.style.visibility = 'hidden'; continue; }
      const ends = arrowEnds(arrow, t);
      if (!ends) { n.style.opacity = '0'; continue; }
      const dur = it.spec.dur || 1.1;
      const k = (t - st.travelAt) / dur;
      const [a0, b0] = it.spec.reverse ? [ends[1], ends[0]] : ends;
      // The pill rides between the arrow's ends, its edge (not its middle) reaching the tip,
      // so one that stays never covers the box it arrived at.
      const len = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) || 1;
      const ux = (b0[0] - a0[0]) / len;
      const uy = (b0[1] - a0[1]) / len;
      const half = Math.min(len / 2, Math.abs(ux) * (n.offsetWidth / 2) + Math.abs(uy) * (n.offsetHeight / 2) + 6);
      const a = [a0[0] + ux * half, a0[1] + uy * half];
      const b = [b0[0] - ux * half, b0[1] - uy * half];
      const e = easeInOut(k);
      n.style.left = `${lerp(a[0], b[0], e)}px`;
      n.style.top = `${lerp(a[1], b[1], e) - (it.spec.lift ?? 0)}px`;
      const fadeOut = it.spec.stay ? 1 : 1 - clamp((k - 1) / 0.3, 0, 1);
      const hidden = st.hiddenAt != null && st.hiddenAt >= st.travelAt ? 1 - clamp((t - st.hiddenAt) / 0.28, 0, 1) : 1;
      n.style.opacity = String(clamp(k * 8, 0, 1) * fadeOut * hidden * (1 - 0.75 * st.dim));
      n.style.visibility = 'visible';
      n.style.transform = 'translate(-50%, -50%)';
      if (st.text != null && it.lastText !== st.text) { n.textContent = st.text; it.lastText = st.text; }
    }

    // The dashed focus box, round the union of its targets.
    let focus = null;
    let focusAt = 0;
    for (const e of sceneEv) if (e.k === 'focus' && e.t <= t) { focus = e.v; focusAt = e.t; }
    const targets = (focus || []).map((id) => items.get(id)).filter(Boolean);
    if (targets.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const it of targets) {
        const box = boxOf(it, states, t);
        x0 = Math.min(x0, box[0]); y0 = Math.min(y0, box[1]); x1 = Math.max(x1, box[2]); y1 = Math.max(y1, box[3]);
      }
      const k = easeOut((t - focusAt) / 0.3);
      const pad = lerp(30, 14, k);
      focusRect.setAttribute('x', (x0 - pad).toFixed(1));
      focusRect.setAttribute('y', (y0 - pad).toFixed(1));
      focusRect.setAttribute('width', (x1 - x0 + 2 * pad).toFixed(1));
      focusRect.setAttribute('height', (y1 - y0 + 2 * pad).toFixed(1));
      focusRect.setAttribute('stroke-dashoffset', String((-t * 28).toFixed(1)));
      focusRect.style.opacity = String(clamp(k * 1.5, 0, 1));
      focusRect.setAttribute('stroke', colorOf(targets[0].spec.color));
    } else focusRect.style.opacity = '0';

    // Ring pulses.
    rings.forEach((r) => r.remove());
    rings.length = 0;
    for (const it of items.values()) {
      if (it.kind === 'item' || it.kind === 'arrow' || it.kind === 'terminal') continue;
      const st = states.get(it.id);
      if (st.ringAt != null) ringFor(it, st, t);
    }
  }

  function boxOf(it, states, t) {
    if (it.kind === 'item') {
      const pr = it.parent;
      const ps = states.get(pr.id) || state(pr, t);
      const ox = ps.pos[0] - pr.hw;
      const oy = ps.pos[1] - pr.hh;
      return [ox + it.node.offsetLeft, oy + it.node.offsetTop, ox + it.node.offsetLeft + it.node.offsetWidth, oy + it.node.offsetTop + it.node.offsetHeight];
    }
    const st = states.get(it.id) || state(it, t);
    return [st.pos[0] - it.hw, st.pos[1] - it.hh, st.pos[0] + it.hw, st.pos[1] + it.hh];
  }

  function ringFor(it, st, t) {
    const age = t - st.ringAt;
    if (age < 0 || age > 1.2) return;
    const b = boxOf(it, new Map(), t);
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    const r0 = Math.max(b[2] - b[0], b[3] - b[1]) / 2 + 6;
    for (const lag of [0, 0.25]) {
      const k = clamp((age - lag) / 0.9, 0, 1);
      if (k <= 0) continue;
      const c = s('circle', { cx: cx.toFixed(1), cy: cy.toFixed(1), r: (r0 + 34 * easeOut(k)).toFixed(1), class: 'cv-ring', stroke: colorOf(it.spec.color) });
      c.style.opacity = String((1 - k) * 0.9);
      ringLayer.appendChild(c);
      rings.push(c);
    }
  }

  return { el: root, measure, update, full: true };
}

// --- the terminal of a split scene -----------------------------------------------------------

function buildTerminal(id, spec, colorOf) {
  const el = h('div', 'cv-term');
  const bar = h('div', 'cv-term-bar');
  bar.append(h('i'), h('i'), h('i'), h('span', null, spec.title || 'learner@opalix: /workspace'));
  el.appendChild(bar);
  const body = h('div', 'cv-term-body');
  const cmdLine = h('div', 'cv-term-line cv-term-cmd');
  cmdLine.append(h('span', 'ps1', `${spec.prompt || '$'} `));
  const cmd = h('span', 'cmd');
  const cursor = h('span', 'cursor');
  cmdLine.append(cmd, cursor);
  const view = h('div', 'cv-term-view');
  const scroll = h('div', 'cv-term-scroll');
  view.appendChild(scroll);
  body.append(cmdLine, view);
  el.appendChild(body);

  const clip = spec.clip || 400;
  const all = String(spec.output || '').replace(/\n$/, '').split('\n');
  const keep = lineSet(spec.show, all.length);
  const rows = [];
  const marks = [];
  keep.forEach((li, k) => {
    if (k > 0 && li !== keep[k - 1] + 1) {
      const gap = h('div', 'cv-term-line cv-term-gap', '…');
      scroll.appendChild(gap);
      rows.push({ node: gap, at: li });
    }
    const line = all[li].length > clip ? `${all[li].slice(0, clip - 2)} …` : all[li];
    const row = h('div', 'cv-term-line');
    const sp = lineSpans(line, spec.highlight || [], colorOf);
    row.appendChild(sp.frag);
    marks.push(...sp.marks.map((m) => ({ ...m, row })));
    scroll.appendChild(row);
    rows.push({ node: row, at: li });
  });
  const endLine = h('div', 'cv-term-line');
  endLine.append(h('span', 'ps1', `${spec.prompt || '$'} `));
  const cursor2 = h('span', 'cursor');
  endLine.appendChild(cursor2);
  scroll.appendChild(endLine);
  let LINE = 36;
  let region = null;

  return {
    el,
    measure(r) {
      region = r;
      el.style.left = `${r.x}px`;
      el.style.top = `${r.y}px`;
      el.style.width = `${r.w}px`;
      LINE = parseFloat(getComputedStyle(scroll).lineHeight) || LINE;
      const pad = parseFloat(getComputedStyle(body).paddingTop) + parseFloat(getComputedStyle(body).paddingBottom);
      const room = r.h - bar.offsetHeight - pad - cmdLine.offsetHeight - 16;
      const need = Math.ceil(scroll.scrollHeight / LINE - 0.02) * LINE;
      view.style.height = `${Math.min(Math.floor(room / LINE) * LINE, need)}px`;
    },
    update(t, st, splitness) {
      el.style.opacity = String(splitness);
      el.style.visibility = splitness > 0.001 ? 'visible' : 'hidden';
      el.style.transform = `translateY(${(1 - easeOut(splitness)) * 40}px)`;
      const times = st.run;
      if (!times) {
        cmd.textContent = '';
        rows.forEach((r) => { r.node.style.display = 'none'; });
        endLine.style.display = 'none';
        cursor.style.visibility = Math.floor(t * 2) % 2 === 0 ? 'visible' : 'hidden';
        return;
      }
      const n = Math.round(clamp((t - times.typeStart) / (times.typeEnd - times.typeStart), 0, 1) * spec.command.length);
      cmd.textContent = spec.command.slice(0, n);
      const blink = Math.floor(t * 2) % 2 === 0;
      cursor.style.visibility = t < times.outputStart && (t < times.typeStart || n >= spec.command.length ? blink : true) ? 'visible' : 'hidden';
      rows.forEach((r) => { r.node.style.display = t >= times.outputStart + r.at * times.lineGap ? '' : 'none'; });
      endLine.style.display = t >= times.outputEnd ? '' : 'none';
      cursor2.style.visibility = blink ? 'visible' : 'hidden';
      let lastMarked = null;
      for (const m of marks) {
        const on = st.marks.has(m.id);
        m.node.classList.toggle('on', on);
        if (on) lastMarked = m.row;
      }
      // Output reads from the top; it scrolls only to keep the newest highlight (or, before any, the newest line) in view.
      const target = lastMarked ? lastMarked.offsetTop + lastMarked.offsetHeight : 0;
      const over = Math.max(0, target - view.clientHeight);
      scroll.style.transform = `translateY(${-Math.ceil(over / LINE - 0.02) * LINE}px)`;
      void region;
    },
  };
}
