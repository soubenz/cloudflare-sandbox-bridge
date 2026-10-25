/**
 * The short's player. render.mjs opens index.html in headless Chromium, calls
 * `shorts.init(timeline, diagrams)` once, then `shorts.seek(t)` for every frame
 * and takes a screenshot. seek(t) is deterministic: everything on screen is a
 * function of t alone (no timers, no CSS transitions, Web Animations paused and
 * set by hand), so frames can be drawn in any order and by several pages.
 *
 * Visual types (the `type` of an entry in a segment's `visuals`):
 *   card      kicker / title / sub / brand / cta lines, each popping in at its cue
 *   chat      a support chat: messages, a fact chip and a stamp, each on a cue
 *   agent     an agent box: model + tool slot, the slot going missing, a guess and a stamp
 *   diagram   a diagram of packages/catalogue/diagrams.json, drawn by the lessons'
 *             own dashboard/src/diagram.js, stepped on cues, the camera easing onto
 *             what each step lights
 *   terminal  a command typed at a prompt, then its real output, with highlights on cues
 *   code      real source lines with syntax colours, lines lit on cues
 *   canvas    a persistent scene that builds up on narrated beats (canvas.js); the
 *             format the videos are written in now. The types above are the older,
 *             one-screen-per-segment visuals and still work.
 */
import { renderDiagram } from '/dashboard/src/diagram.js';
import { buildCanvas } from '/scripts/shorts/page/canvas.js';

let TRANSITION = 0.4; // seconds: every cut between visuals (timeline.transition)
const POP = 0.3; // seconds: an element popping in

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeOut = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
const easeInOut = (x) => { x = clamp(x, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const backOut = (x) => { x = clamp(x, 0, 1); const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
const lerp = (a, b, k) => a + (b - a) * k;

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/** Text with emoji wrapped so they render in the colour emoji font. */
function rich(el, text) {
  const parts = String(text).split(/(\p{Extended_Pictographic}️?)/u);
  for (const p of parts) {
    if (!p) continue;
    if (/\p{Extended_Pictographic}/u.test(p)) el.appendChild(h('span', 'emoji', p));
    else el.appendChild(document.createTextNode(p));
  }
  return el;
}

const MARK = '<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="6"/><circle cx="12" cy="12" r="4.5"/></svg>';

/** An element that pops in at time `at` (absolute seconds): scale and fade. */
function pop(el, t, at, { from = 0.7, dy = 0, bounce = true } = {}) {
  const k = at == null ? 1 : (t - at) / POP;
  if (k <= 0) {
    el.style.opacity = '0';
    el.style.transform = `translateY(${dy}px) scale(${from})`;
    return;
  }
  const e = bounce ? backOut(k) : easeOut(k);
  el.style.opacity = String(clamp(k * 1.6, 0, 1));
  el.style.transform = `translateY(${lerp(dy, 0, e)}px) scale(${lerp(from, 1, e)})`;
}

/** A stamp slamming down: big and transparent to its size, rotated. */
function slam(el, t, at, rot = -8) {
  const k = at == null ? 1 : (t - at) / 0.16;
  if (k <= 0) { el.style.opacity = '0'; return; }
  const e = easeOut(k);
  el.style.opacity = String(clamp(k * 2, 0, 1));
  el.style.transform = `translateY(-50%) rotate(${rot}deg) scale(${lerp(2.2, 1, e)})`;
}

// ---------------------------------------------------------------- visuals --

function buildCard(v) {
  const el = h('div', 'card');
  const items = [];
  const add = (node, spec) => { el.appendChild(node); items.push({ node, t: spec?.t ?? v.start }); };
  if (v.kicker) add(h('div', 'line kicker', typeof v.kicker === 'string' ? v.kicker : v.kicker.text), v.kicker);
  if (v.title) add(rich(h('div', 'line title'), typeof v.title === 'string' ? v.title : v.title.text), v.title);
  if (v.sub) add(h('div', 'line sub', typeof v.sub === 'string' ? v.sub : v.sub.text), v.sub);
  if (v.brand) {
    const b = h('div', 'line big-brand');
    b.innerHTML = MARK;
    b.appendChild(h('span', null, typeof v.brand === 'string' ? v.brand : v.brand.text || 'opalix'));
    add(b, v.brand);
  }
  if (v.cta) add(h('div', 'line cta', typeof v.cta === 'string' ? v.cta : v.cta.text), v.cta);
  return { el, update(t) { for (const it of items) pop(it.node, t, it.t, { from: 0.6, dy: 40 }); } };
}

function buildChat(v) {
  const el = h('div', 'panel chat');
  const head = h('div', 'chat-head');
  head.appendChild(h('div', 'chat-avatar', (v.agent || 'Assistant').slice(0, 1)));
  const who = h('div');
  who.appendChild(h('div', 'chat-name', v.agent || 'Assistant'));
  const st = h('div', 'chat-status');
  st.appendChild(h('b', null, '● '));
  st.appendChild(document.createTextNode(v.status || 'AI agent · online'));
  who.appendChild(st);
  head.appendChild(who);
  el.appendChild(head);
  const msgs = h('div', 'msgs');
  el.appendChild(msgs);
  const items = [];
  let lastAgent = null;
  for (const m of v.messages || []) {
    const b = h('div', `bubble ${m.from === 'customer' ? 'customer' : 'agent'}`);
    if (m.name) b.appendChild(h('span', 'who', m.name));
    rich(b, m.text);
    msgs.appendChild(b);
    items.push({ node: b, t: m.t ?? v.start });
    if (m.from !== 'customer') lastAgent = b;
  }
  let chip = null;
  if (v.chip) {
    chip = h('div', 'chip');
    const txt = h('div');
    if (v.chip.label) txt.appendChild(h('small', null, v.chip.label));
    rich(txt, v.chip.text);
    chip.appendChild(txt);
    msgs.appendChild(chip);
  }
  let stamp = null;
  if (v.stamp && lastAgent) {
    stamp = h('div', 'stamp', v.stamp.text);
    stamp.style.left = 'calc(100% - 46px)';
    stamp.style.top = '50%';
    lastAgent.appendChild(stamp);
  }
  return {
    el,
    update(t) {
      for (const it of items) pop(it.node, t, it.t, { from: 0.5, dy: 30 });
      if (chip) pop(chip, t, v.chip.t ?? v.start, { from: 0.4 });
      if (stamp) slam(stamp, t, v.stamp.t, v.stamp.rotate ?? -9);
    },
  };
}

function buildAgent(v) {
  const el = h('div', 'panel agent-card');
  const title = h('div', 'agent-title');
  title.appendChild(h('span', 'bar'));
  title.appendChild(document.createTextNode(v.title || 'Agent'));
  el.appendChild(title);
  const row = h('div', 'agent-row');
  const model = h('div', 'agent-box model');
  rich(model.appendChild(h('div', 'icon')), v.model?.icon || '🧠');
  model.appendChild(h('div', 'lbl', v.model?.label || 'AI model'));
  const plus = h('div', 'plus', '+');
  const tool = h('div', 'agent-box tool');
  rich(tool.appendChild(h('div', 'icon')), v.tool?.icon || '🔧');
  const toolLbl = tool.appendChild(h('div', 'lbl', v.tool?.label || 'tools'));
  const q = h('div', 'q', '?');
  row.append(model, plus, tool);
  el.appendChild(row);
  let guess = null;
  let stamp = null;
  if (v.guess) {
    guess = h('div', 'agent-guess');
    const b = rich(h('div', 'bubble agent'), v.guess.text);
    guess.appendChild(b);
    if (v.guess.stamp) {
      stamp = h('div', 'stamp', v.guess.stamp);
      stamp.style.left = 'calc(100% - 46px)';
      stamp.style.top = '50%';
      guess.appendChild(stamp);
    }
    el.appendChild(guess);
  }
  return {
    el,
    update(t) {
      pop(model, t, v.model?.t ?? v.start, { from: 0.6 });
      pop(plus, t, v.tool?.t ?? v.start, { from: 0.3 });
      pop(tool, t, v.tool?.t ?? v.start, { from: 0.6 });
      const missing = v.missing && t >= v.missing.t;
      tool.classList.toggle('missing', Boolean(missing));
      if (missing && !tool.contains(q)) {
        tool.replaceChildren(q, h('div', 'lbl', v.missing.label || 'no tool'));
      } else if (!missing && tool.contains(q)) {
        tool.replaceChildren(rich(h('div', 'icon'), v.tool?.icon || '🔧'), toolLbl);
      }
      if (missing) {
        const k = (t - v.missing.t) / 0.5;
        q.style.transform = `scale(${1 + 0.12 * Math.sin(Math.min(k, 6) * Math.PI)})`;
      }
      if (guess) pop(guess, t, v.guess.t, { from: 0.5, dy: 40 });
      if (stamp) slam(stamp, t, v.guess.stampAt ?? (v.guess.t + 0.35), -8);
    },
  };
}

/** Bounding box (px, relative to `base`) of the elements a step lights. */
function stepRegion(svg, diagram) {
  const base = svg.getBoundingClientRect();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const els = [...svg.querySelectorAll('.diagram-node.is-lit .diagram-node-box, .diagram-edge.is-lit, .diagram-note')];
  // A packet rides between two boxes: keep both ends of a lit edge in frame.
  for (const g of svg.querySelectorAll('.diagram-edge.is-lit')) {
    const e = (diagram.edges || []).find((x) => x.id === g.getAttribute('data-edge'));
    for (const id of e ? [e.from, e.to] : []) {
      const box = svg.querySelector(`.diagram-node[data-node="${CSS.escape(id)}"] .diagram-node-box`);
      if (box) els.push(box);
    }
  }
  for (const n of els) {
    const r = n.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    x0 = Math.min(x0, r.left - base.left); y0 = Math.min(y0, r.top - base.top);
    x1 = Math.max(x1, r.right - base.left); y1 = Math.max(y1, r.bottom - base.top);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: base.width, h: base.height };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function buildDiagram(v, library) {
  const diagram = library[v.id];
  if (!diagram) throw new Error(`no diagram "${v.id}"`);
  const el = h('div', 'dg-wrap');
  el.appendChild(h('div', 'heading', v.title || diagram.title));
  const player = renderDiagram(diagram, { controls: false, autoplay: false, reducedMotion: false, packetMs: 1400, stepMs: 3500 });
  el.appendChild(player);
  const stepLine = h('div', 'dg-step');
  el.appendChild(stepLine);
  const total = (diagram.steps || []).length;
  const steps = (v.steps || [{ n: 1, t: v.start }]).map((s) => {
    if (!(s.n >= 1 && s.n <= total)) throw new Error(`diagram "${v.id}" has steps 1-${total}, not ${s.n}`);
    return s;
  });
  const svg = player.querySelector('.diagram-svg');
  const figure = player.querySelector('.diagram-figure');
  let regions = null;
  let shown = -1;
  const maxZoom = v.zoom ?? 1.5;
  const pad = 26;

  function camera(region) {
    const W = figure.clientWidth;
    const H = figure.clientHeight;
    const sw = svg.clientWidth;
    const sh = svg.clientHeight;
    const r = { x: region.x - pad, y: region.y - pad, w: region.w + 2 * pad, h: region.h + 2 * pad };
    const s = clamp(Math.min(W / r.w, H / r.h), 1, maxZoom);
    let tx = W / 2 - s * (r.x + r.w / 2);
    let ty = H / 2 - s * (r.y + r.h / 2);
    tx = clamp(tx, W - s * sw, 0);
    ty = s * sh <= H ? (H - s * sh) / 2 : clamp(ty, H - s * sh, 0);
    return { s, tx, ty };
  }

  return {
    el,
    measure() {
      // The figure keeps the natural height of the whole picture; the camera works inside it.
      const want = v.height || parseFloat(getComputedStyle(el).getPropertyValue('--dg-h')) || 620;
      figure.style.height = `${Math.max(svg.getBoundingClientRect().height, want)}px`;
      regions = steps.map((s) => {
        player.goTo(s.n - 1);
        return camera(stepRegion(svg, diagram));
      });
      shown = -1;
    },
    update(t) {
      let k = 0;
      for (let i = 0; i < steps.length; i++) if (t >= steps[i].t) k = i;
      const step = steps[k];
      const dwell = (k + 1 < steps.length ? steps[k + 1].t : v.end) - step.t;
      if (shown !== k) {
        player.goTo(step.n - 1);
        shown = k;
      }
      // Packets ride at whatever pace fits the time the step is on screen.
      const rate = Math.max(0.6, 1.4 / Math.max(0.3, dwell * 0.8));
      for (const a of player.getAnimations({ subtree: true })) {
        a.pause();
        a.currentTime = Math.max(0, (t - step.t) * 1000 * rate);
      }
      const to = regions[k];
      const from = k > 0 ? regions[k - 1] : to;
      const e = easeInOut((t - step.t) / 0.6);
      svg.style.transform = `translate(${lerp(from.tx, to.tx, e)}px, ${lerp(from.ty, to.ty, e)}px) scale(${lerp(from.s, to.s, e)})`;
      stepLine.replaceChildren(document.createTextNode('STEP '), h('b', null, String(step.n)), document.createTextNode(` / ${total}`));
    },
  };
}

// --- syntax colouring ---------------------------------------------------------

const JSONISH = /(https?:\/\/[^\s"']+)|("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null|True|False|None)\b|(-->|<--)|(-?\b\d+(?:\.\d+)?\b)/g;
const PY_KW = new Set('def return if else elif for in while import from as with try except raise not and or is None True False class lambda print const let function async await new'.split(' '));

/** Per-character token classes for a line. */
function colourLine(line, lang) {
  const cls = new Array(line.length).fill('');
  const mark = (a, b, c) => { for (let i = a; i < b; i++) cls[i] = c; };
  if (lang === 'python' || lang === 'js') {
    const re = /(#.*$|\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)(?=\()|\b([A-Za-z_]\w*)\b/g;
    let m;
    while ((m = re.exec(line))) {
      if (m[1]) mark(m.index, m.index + m[0].length, 'tk-com');
      else if (m[2]) mark(m.index, m.index + m[0].length, 'tk-str');
      else if (m[3]) mark(m.index, m.index + m[0].length, 'tk-num');
      else if (m[4]) mark(m.index, m.index + m[0].length, PY_KW.has(m[4]) ? 'tk-kw' : 'tk-fn');
      else if (m[5] && PY_KW.has(m[5])) mark(m.index, m.index + m[0].length, 'tk-kw');
    }
    return cls;
  }
  let m;
  JSONISH.lastIndex = 0;
  while ((m = JSONISH.exec(line))) {
    if (m[1]) mark(m.index, m.index + m[0].length, 'tk-url');
    else if (m[2]) mark(m.index, m.index + m[2].length, m[3] ? 'tk-key' : 'tk-str');
    else if (m[4]) mark(m.index, m.index + m[0].length, 'tk-lit');
    else if (m[5]) mark(m.index, m.index + m[0].length, 'tk-arrow');
    else if (m[6]) mark(m.index, m.index + m[0].length, 'tk-num');
  }
  return cls;
}

/** Builds a line's spans: token colours, plus highlight spans (returned for later toggling). */
function lineSpans(line, lang, highlights) {
  const cls = colourLine(line, lang);
  const hl = new Array(line.length).fill(-1);
  highlights.forEach((spec, i) => {
    if (spec.lines && !new RegExp(spec.lines).test(line)) return;
    const re = new RegExp(spec.match, 'g');
    let m;
    while ((m = re.exec(line))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      for (let k = m.index; k < m.index + m[0].length; k++) hl[k] = i;
    }
  });
  const frag = document.createDocumentFragment();
  const marks = [];
  let i = 0;
  while (i < line.length) {
    const hi = hl[i];
    let j = i;
    while (j < line.length && hl[j] === hi) j++;
    const host = hi >= 0 ? h('span', `hl tone-${highlights[hi].tone || 'default'}`) : frag;
    if (hi >= 0) { marks.push({ node: host, spec: highlights[hi] }); frag.appendChild(host); }
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

function buildTerminal(v) {
  const el = h('div', 'panel term');
  const bar = h('div', 'term-bar');
  bar.append(h('i'), h('i'), h('i'), h('span', null, v.title || 'learner@opalix: /workspace'));
  el.appendChild(bar);
  const body = h('div', 'term-body');
  // The command line is pinned above the output: it never scrolls away.
  const prompt = v.prompt || '$';
  const cmdLine = h('div', 'term-line term-cmd term-scroll');
  cmdLine.append(h('span', 'ps1', `${prompt} `));
  const cmd = h('span', 'cmd');
  const cursor = h('span', 'cursor');
  cmdLine.append(cmd, cursor);
  const view = h('div', 'term-view');
  const scroll = h('div', 'term-scroll');
  view.appendChild(scroll);
  body.append(cmdLine, view);
  el.appendChild(body);

  const highlights = v.highlight || [];
  const clip = v.clip || 160;
  const lines = String(v.output || '').replace(/\n$/, '').split('\n').map((l) => (l.length > clip ? `${l.slice(0, clip - 2)} …` : l));
  const outEls = [];
  const marks = [];
  for (const l of lines) {
    const row = h('div', 'term-line');
    const s = lineSpans(l, 'jsonish', highlights);
    row.appendChild(s.frag);
    marks.push(...s.marks);
    scroll.appendChild(row);
    outEls.push(row);
  }
  const endLine = h('div', 'term-line');
  endLine.appendChild(h('span', 'ps1', `${prompt} `));
  const cursor2 = h('span', 'cursor');
  endLine.appendChild(cursor2);
  scroll.appendChild(endLine);

  // Times come from the timeline (timeline.mjs terminalTimes), so holds can be checked before rendering.
  const { typeStart, typeEnd, outputStart, lineGap } = v;
  const lineAt = (i) => outputStart + i * lineGap;
  for (const m of marks) m.t = m.spec.t ?? lineAt(lines.length) + 0.3;
  let LINE = 46;

  return {
    el,
    measure(wrap, stage) {
      LINE = parseFloat(getComputedStyle(scroll).lineHeight) || LINE;
      const others = [...wrap.children].filter((c) => c !== el).reduce((n, c) => n + c.offsetHeight + parseFloat(getComputedStyle(c).marginTop || 0), 0);
      const pad = parseFloat(getComputedStyle(body).paddingTop) + parseFloat(getComputedStyle(body).paddingBottom);
      const room = stage.clientHeight - others - bar.offsetHeight - pad - cmdLine.offsetHeight - 8;
      const need = Math.ceil(scroll.scrollHeight / LINE - 0.02) * LINE;
      view.style.height = `${Math.min(Math.floor(room / LINE) * LINE, need)}px`;
    },
    update(t) {
      const n = Math.round(clamp((t - typeStart) / (typeEnd - typeStart), 0, 1) * v.command.length);
      cmd.textContent = v.command.slice(0, n);
      const blink = Math.floor(t * 2) % 2 === 0;
      cursor.style.visibility = t < outputStart && (t < typeStart || n >= v.command.length ? blink : true) ? 'visible' : 'hidden';
      outEls.forEach((row, i) => { row.style.display = t >= lineAt(i) ? '' : 'none'; });
      endLine.style.display = t >= lineAt(lines.length) ? '' : 'none';
      cursor2.style.visibility = blink ? 'visible' : 'hidden';
      for (const m of marks) m.node.classList.toggle('on', t >= m.t);
      // Scroll like a terminal, whole lines only: the newest output stays in view.
      const overflow = scroll.scrollHeight - view.clientHeight;
      scroll.style.transform = `translateY(${-Math.max(0, Math.ceil(overflow / LINE - 0.02)) * LINE}px)`;
    },
  };
}

function buildCode(v) {
  const el = h('div', 'panel term');
  const bar = h('div', 'term-bar');
  bar.append(h('i'), h('i'), h('i'), h('span', null, v.file || 'code'));
  el.appendChild(bar);
  const body = h('div', 'term-body');
  const scroll = h('div', 'code-scroll');
  body.appendChild(scroll);
  el.appendChild(body);
  const first = v.firstLine || 1;
  const rows = String(v.code || '').replace(/\n$/, '').split('\n').map((line, i) => {
    const row = h('div', 'code-line');
    row.appendChild(h('span', 'ln', String(first + i)));
    const code = h('span', 'src');
    code.appendChild(lineSpans(line, v.lang || 'python', []).frag);
    row.appendChild(code);
    scroll.appendChild(row);
    return row;
  });
  const marks = (v.highlight || []).map((s) => ({ ...s, from: s.lines[0] - first, to: (s.lines[1] ?? s.lines[0]) - first }));
  return {
    el,
    update(t) {
      rows.forEach((row, i) => {
        pop(row, t, v.start + 0.05 + i * 0.025, { from: 1, dy: 14, bounce: false });
        row.classList.toggle('on', marks.some((m) => t >= (m.t ?? v.start) && i >= m.from && i <= m.to));
      });
    },
  };
}

function buildCallout(c) {
  const el = h('div', `callout tone-${c.tone || 'ok'}`);
  rich(el, c.text);
  return el;
}

let FORMAT = 'vertical';
const BUILDERS = { card: buildCard, chat: buildChat, agent: buildAgent, diagram: buildDiagram, terminal: buildTerminal, code: buildCode, canvas: (v) => buildCanvas(v, { format: FORMAT }) };

// ------------------------------------------------------------------ player --

let T = null;
let stage, capBox, bar;
const built = [];
const capEls = [];

function transitionStyle(v, i) {
  return v.transition || (v.type === 'canvas' ? 'zoom' : ['zoom', 'slide', 'zoom', 'slide-left'][i % 4]);
}

function placeIn(el, kind, k) {
  const e = easeInOut(k);
  el.style.opacity = String(clamp(k * 1.2, 0, 1));
  if (kind === 'slide') el.style.transform = `translateY(${lerp(60, 0, e)}px)`;
  else if (kind === 'slide-left') el.style.transform = `translateX(${lerp(90, 0, e)}px)`;
  else el.style.transform = `scale(${lerp(0.94, 1, e)})`;
}

function placeOut(el, kind, k) {
  const e = easeInOut(k);
  el.style.opacity = String(clamp(1 - k * 1.2, 0, 1));
  if (kind === 'slide') el.style.transform = `translateY(${lerp(0, -60, e)}px)`;
  else if (kind === 'slide-left') el.style.transform = `translateX(${lerp(0, -90, e)}px)`;
  else el.style.transform = `scale(${lerp(1, 1.04, e)})`;
}

async function init(timeline, library, format = 'vertical') {
  T = timeline;
  TRANSITION = timeline.transition ?? TRANSITION;
  FORMAT = format;
  document.documentElement.classList.add(`fmt-${format}`, `cap-${timeline.captionsMode || 'small'}`);
  stage = document.getElementById('stage');
  const sceneBox = document.getElementById('scene');
  capBox = document.getElementById('captions');
  bar = document.querySelector('.progress i');
  document.querySelector('.brand').insertAdjacentHTML('afterbegin', MARK);

  for (const [i, v] of T.visuals.entries()) {
    const b = BUILDERS[v.type];
    if (!b) throw new Error(`unknown visual type "${v.type}" in segment "${v.segment}"`);
    const inst = b(v, library);
    const wrap = h('div', inst.full ? 'visual visual-full' : 'visual');
    wrap.appendChild(inst.el);
    for (const c of v.callouts || []) {
      const node = buildCallout(c);
      wrap.appendChild(node);
      const prev = inst.update;
      inst.update = (t) => { prev(t); pop(node, t, c.t ?? v.start, { from: 0.5, dy: 30 }); };
    }
    (inst.full ? sceneBox : stage).appendChild(wrap);
    built.push({ v, wrap, inst, kind: transitionStyle(v, i) });
  }
  await document.fonts.ready;
  await Promise.all(['800 92px "Funnel Display"', '700 40px "Funnel Sans"', '600 34px "JetBrains Mono"', '40px "Noto Color Emoji"', '700 40px "Kalam"']
    .map((f) => document.fonts.load(f, 'Abc🧠').catch(() => null)));
  for (const b of built) if (b.inst.measure) b.inst.measure(b.wrap, stage);
  for (const c of T.captionsMode === 'off' ? [] : T.captions) {
    const el = h('div', 'cap');
    const ws = c.words.map((w) => {
      const s = h('span', 'w', w.text);
      el.appendChild(s);
      return s;
    });
    el.style.display = 'none';
    capBox.appendChild(el);
    capEls.push({ c, el, ws });
  }
  seek(0);
  return { visuals: built.length, captions: capEls.length };
}

function seek(t) {
  bar.style.width = `${(clamp(t / T.duration, 0, 1) * 100).toFixed(3)}%`;

  let cur = built.findIndex((b) => t >= b.v.start && t < b.v.end);
  if (cur < 0) cur = built.length - 1;
  built.forEach((b, i) => {
    const into = t - b.v.start;
    const nextB = built[i + 1];
    let visible = false;
    if (i === cur) {
      visible = true;
      if (i > 0 && into < TRANSITION) placeIn(b.wrap, b.kind, into / TRANSITION);
      else { b.wrap.style.opacity = '1'; b.wrap.style.transform = 'none'; }
    } else if (nextB && i === cur - 1 && t - nextB.v.start < TRANSITION) {
      visible = true;
      placeOut(b.wrap, nextB.kind, (t - nextB.v.start) / TRANSITION);
    }
    b.wrap.style.display = visible ? '' : 'none';
    if (visible) b.inst.update(t);
  });

  for (const { c, el, ws } of capEls) {
    const on = t >= c.start && t < c.end;
    el.style.display = on ? '' : 'none';
    if (!on) continue;
    const k = (t - c.start) / 0.18;
    el.style.transform = `scale(${lerp(0.94, 1, easeOut(k))})`;
    el.style.opacity = String(clamp(k * 2, 0, 1));
    let now = -1;
    c.words.forEach((w, i) => { if (t >= w.start - 0.03) now = i; });
    ws.forEach((s, i) => {
      s.classList.toggle('now', i === now);
      s.classList.toggle('later', i > now);
    });
  }
}

window.shorts = { init, seek };
