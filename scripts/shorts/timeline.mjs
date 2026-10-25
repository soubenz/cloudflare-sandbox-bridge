/**
 * From a video's segments and their narration to the timeline the page plays:
 * when every clip starts, which visual is on screen, when each cue lands and
 * which caption words show. Pure: no I/O, so it is easy to reason about and test.
 *
 * Times are seconds from the start of the video.
 */

/** No video may run longer than this (the owner's rule: one short per lesson concept, 3 minutes at most). */
export const MAX_SECONDS = 180;

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Seconds from a segment's narration start for a cue: a number is already
 * seconds; a phrase is found in the segment's words and lands just before its
 * first word is spoken (`phrase #2` for its second occurrence). Throws naming
 * the segment when the phrase is not there.
 */
export function cueTime(at, seg) {
  if (typeof at === 'number') return at;
  const m = /^(.*?)\s*#(\d+)$/.exec(String(at));
  const nth = m ? Number(m[2]) : 1;
  const want = String(m ? m[1] : at).split(/\s+/).map(norm).filter(Boolean);
  const words = seg.words.map((w) => norm(w.text));
  let seen = 0;
  for (let i = 0; i + want.length <= words.length; i++) {
    if (want.every((w, k) => words[i + k] === w) && ++seen === nth) return Math.max(0, seg.words[i].start - 0.06);
  }
  throw new Error(`segment "${seg.id}": cue "${at}" is not in its voiceover ("${seg.vo}")`);
}

/**
 * Splits a segment's timed words into caption chunks of 2 to 5 words: a chunk
 * ends at punctuation, at a pause, or when it reaches `maxWords` / `maxChars`;
 * a lone trailing word joins the chunk before it when that still fits.
 */
export function captionChunks(words, { maxWords = 4, maxChars = 18 } = {}) {
  const len = (ws) => ws.reduce((s, w) => s + w.text.length + 1, -1);
  // Phrases first: split at punctuation and at pauses, so a chunk never straddles a comma.
  const phrases = [];
  let cur = [];
  words.forEach((w, i) => {
    if (cur.length && w.start - words[i - 1].end > 0.4) { phrases.push(cur); cur = []; }
    cur.push(w);
    if (/[.,:;!?]$/.test(w.text)) { phrases.push(cur); cur = []; }
  });
  if (cur.length) phrases.push(cur);
  // A one-word phrase reads as a stutter: fold it into a neighbour within the same sentence.
  for (let i = 0; i < phrases.length; i++) {
    if (phrases[i].length !== 1) continue;
    const prev = phrases[i - 1];
    const next = phrases[i + 1];
    const prevEndsSentence = !prev || /[.!?:]$/.test(prev[prev.length - 1].text);
    if (!prevEndsSentence && prev.length < 5) { prev.push(...phrases[i]); phrases.splice(i--, 1); }
    else if (next && !/[.!?:]$/.test(phrases[i][0].text)) { next.unshift(...phrases[i]); phrases.splice(i--, 1); }
  }
  // Then each phrase into the fewest, most even pieces that fit.
  const chunks = [];
  for (const p of phrases) {
    let k = Math.ceil(p.length / maxWords);
    for (;;) {
      const pieces = [];
      let at = 0;
      for (let j = 0; j < k; j++) {
        const size = Math.ceil((p.length - at) / (k - j));
        pieces.push(p.slice(at, at + size));
        at += size;
      }
      if (k >= p.length || pieces.every((x) => len(x) <= maxChars || x.length === 1)) { chunks.push(...pieces); break; }
      k++;
    }
  }
  return chunks;
}

/** Every `at` in a visual's spec gets a `t`: the absolute time it resolves to. */
function resolveCues(node, seg, base) {
  if (Array.isArray(node)) return node.map((n) => resolveCues(n, seg, base));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = resolveCues(v, seg, base);
  if ('at' in node) out.t = base + cueTime(node.at, seg);
  return out;
}

/**
 * The 180 s rule, checked before a single frame is drawn. `segs` carry
 * `{ id, duration }` (narration seconds after tempo); `total` is the whole
 * video's length. Throws a message naming what to trim.
 */
export function assertLength(videoId, segs, total, max = MAX_SECONDS) {
  if (total <= max) return;
  const over = total - max;
  const narration = segs.reduce((s, x) => s + x.duration, 0);
  const byLength = [...segs].sort((a, b) => b.duration - a.duration);
  const fix = byLength[0].duration > over
    ? `Trim segment "${byLength[0].id}" (${byLength[0].duration.toFixed(1)} s of narration) by at least ${over.toFixed(1)} s, or split this video in two.`
    : `Trim these segments by ${over.toFixed(1)} s between them, longest first: ${byLength.slice(0, 4).map((x) => `"${x.id}" ${x.duration.toFixed(1)} s`).join(', ')}; or split this video in two.`;
  throw new Error(`video "${videoId}" would run ${total.toFixed(1)} s (narration ${narration.toFixed(1)} s), over the ${max} s limit by ${over.toFixed(1)} s. ${fix}`);
}

/** Pace defaults (seconds), every one overridable by `pace:` in short.yaml. */
export const PACE = {
  lead: 0.3, // quiet before the first word
  gap: 0.7, // quiet between two segments' voices
  tail: 2.5, // hold after the last word (the end card eases in here)
  maxPause: 0.6, // longest pause kept inside one clip
  visualLead: 0.2, // a visual arrives this long before its voice
  transition: 0.7, // a soft cross-fade between scenes
  enter: 0.7, // an element's entrance: pop with overshoot, write-on text, draw-on arrow
  packet: 1.2, // seconds per hop for a travelling packet
  pulse: 1, // 1: a soft ring pulses on each element as it lands; 0: none
  drift: 4, // camera drift on the board, in grid units (0: still)
  beatHold: 2.5, // the last beat of a segment holds this long before the next voice
  minBeatGap: 2.0, // warn when an element appears sooner than this after the one before
  pageTransition: 0.6, // a page break: erase, slide, zoom or fade
  pageMax: 6, // warn when a page has more elements than this
  cardHold: 1.4, // a title card (`card:` beat) stays this long (and the narration pauses for it)
  minStep: 3.5, // a diagram step (legacy `diagram` visual) stays at least this long
  minOutputHold: 4.0, // terminal output stays this long after its last highlight
  captionWords: 4, // most words in one karaoke caption
  typing: 16, // characters per second when a command is typed
};

const PAGE_TRANSITIONS = ['erase', 'slide', 'zoom', 'fade'];

/**
 * The quiet a segment's beats ask for: a `pause: <seconds>` beat (and a
 * `card:` title card, which pauses for as long as it shows) opens a gap in
 * the narration just before its cue word. Returns the segment with its word
 * times shifted and its duration grown, the cuts (in seconds of the clip as
 * spoken, for the audio mix) and, per beat index, where its pause starts.
 */
function applyPauses(s, pace) {
  const cuts = [];
  const startOf = new Map();
  (s.beats || []).forEach((b, k) => {
    let pad = Number(b.pause) || 0;
    if (b.card && !b.pause) pad = 1.0 + (b.card.hold ?? pace.cardHold);
    if (pad <= 0) return;
    let at = 0;
    if (typeof b.at === 'number') at = b.at;
    else if (b.at != null) {
      const cue = cueTime(b.at, s) + 0.06;
      const i = s.words.findIndex((w) => Math.abs(w.start - cue) < 1e-6);
      at = i > 0 ? (s.words[i - 1].end + s.words[i].start) / 2 : Math.max(0, cue - 0.02);
    }
    cuts.push({ at, pad, beat: k });
  });
  cuts.sort((a, b) => a.at - b.at);
  if (!cuts.length) return { s, cuts, startOf };
  const before = (t) => cuts.reduce((n, c) => n + (c.at < t - 1e-6 ? c.pad : 0), 0);
  const upTo = (t) => cuts.reduce((n, c) => n + (c.at <= t + 1e-6 ? c.pad : 0), 0);
  for (const c of cuts) startOf.set(c.beat, c.at + before(c.at));
  const words = s.words.map((w) => ({ ...w, start: w.start + upTo(w.start), end: w.end + upTo(w.start) }));
  const total = cuts.reduce((n, c) => n + c.pad, 0);
  return { s: { ...s, words, duration: s.duration + total }, cuts: cuts.map(({ at, pad }) => ({ at, pad })), startOf };
}

/**
 * When a terminal types and prints, from the time `t0` it is started:
 * { typeStart, typeEnd, outputStart, lineGap, outputEnd }. Shared with the page.
 */
export function terminalTimes(v, t0, pace) {
  const typeStart = t0 + 0.4;
  const typeDur = v.typingSeconds ?? Math.min(2.2, Math.max(0.8, String(v.command || '').length / pace.typing));
  const typeEnd = typeStart + typeDur;
  const outputStart = typeEnd + 0.45;
  const lineGap = 0.07;
  const lines = String(v.output || '').replace(/\n$/, '').split('\n').length;
  return { typeStart, typeEnd, outputStart, lineGap, outputEnd: outputStart + lines * lineGap };
}

const asList = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

/**
 * The page's timeline. `segs[i]` is the video's segment i plus its narration:
 * `{ id, vo, scene?, beats?, visuals?, duration, words: [{ text, start, end }] }`,
 * word times in seconds of the processed clip. `pace` is PACE with overrides.
 *
 * A segment with a `scene` opens a canvas that stays on screen, building up,
 * until a later segment opens another scene (or uses legacy `visuals`). Each
 * segment's `beats` change that canvas on its own words.
 *
 * Segments are laid end to end `gap` apart, except that a segment is held
 * longer (the next voice waits) when the visual it ends would otherwise leave
 * too soon: a terminal's output less than `minOutputHold` after its last
 * highlight, or a legacy diagram step under `minStep`. Holds that cannot be
 * fixed that way come back as `warnings` naming the segment.
 */
export function buildTimeline(video, segs, paceIn, { captions = 'small' } = {}) {
  const pace = { ...PACE, ...paceIn };
  const warnings = [];
  const visuals = [];
  const words = [];
  const placed = [];
  let scene = null; // the canvas visual being built
  let audioStart = pace.lead;
  for (let i = 0; i < segs.length; i++) {
    const paused = applyPauses(segs[i], pace);
    const s = paused.s;
    const vStart = i === 0 ? 0 : Math.max(placed[i - 1].visualStart, audioStart - pace.visualLead);
    const opens = Boolean(s.scene || (s.visuals && s.visuals.length));
    if (i > 0 && opens) {
      placed[i - 1].visualEnd = vStart;
      const prev = visuals.at(-1);
      if (prev) prev.end = vStart;
    }
    if (!opens && !scene && !visuals.length) throw new Error(`segment "${s.id}": the first segment needs a \`scene\` (or \`visuals\`)`);
    const seg = { ...s, audioStart, cuts: paused.cuts, visualStart: opens ? vStart : (placed[i - 1]?.visualStart ?? 0) };
    placed.push(seg);
    const audioEnd = audioStart + s.duration;
    const nextOpens = i + 1 < segs.length && Boolean(segs[i + 1].scene || (segs[i + 1].visuals && segs[i + 1].visuals.length));
    let needEnd = audioEnd;

    if (s.scene) {
      scene = { type: 'canvas', segment: s.id, start: vStart, end: Infinity, scene: s.scene, colors: video.colors || {}, beats: [], termLast: -Infinity, lastShow: -Infinity };
      visuals.push(scene);
      // Pages: each page's elements (not counting arrows, packets, the terminal or its title) should be few.
      const pages = (s.scene.pages || []).map((pg) => pg.id);
      const els = Object.entries(s.scene.elements || {});
      for (const [id, el] of els) if (el.page != null && !pages.includes(el.page)) throw new Error(`segment "${s.id}": element "${id}" is on page "${el.page}", which scene "${s.scene.id || s.id}" does not list in \`pages\``);
      const counted = (pg) => els.filter(([, el]) => (el.page ?? null) === pg && !['arrow', 'packet', 'terminal'].includes(el.type)).length;
      for (const pg of pages.length ? pages : [null]) {
        const n = counted(pg);
        if (n > pace.pageMax) warnings.push(`segment "${s.id}": ${pg ? `page "${pg}"` : `scene "${s.scene.id || s.id}"`} has ${n} elements, over pageMax ${pace.pageMax} (split it with another page)`);
      }
    } else if (s.visuals && s.visuals.length) {
      scene = null;
      let mine = s.visuals.map((v) => resolveCues(v, s, audioStart));
      mine = mine.map((v, k) => ({ ...v, segment: s.id, start: k === 0 ? vStart : Math.max(vStart, v.t ?? vStart) }));
      mine.forEach((v, k) => { v.end = k + 1 < mine.length ? mine[k + 1].start : Infinity; });
      for (const v of mine) {
        if (v.type === 'diagram') {
          const steps = (v.steps || [{ n: 1 }]).map((st, k) => ({ n: typeof st === 'number' ? st : st.n, t: k === 0 ? v.start : (st.t ?? v.start) }));
          v.steps = steps;
          steps.forEach((st, k) => {
            const until = k + 1 < steps.length ? steps[k + 1].t : v.end;
            if (until === Infinity) needEnd = Math.max(needEnd, st.t + pace.minStep);
            else if (until - st.t < pace.minStep - 1e-6) warnings.push(`segment "${s.id}": diagram ${v.id} step ${st.n} shows ${(until - st.t).toFixed(1)} s, under minStep ${pace.minStep} s`);
          });
        }
        if (v.type === 'terminal') {
          Object.assign(v, terminalTimes(v, v.start, pace));
          for (const hl of v.highlight || []) if (hl.t == null || hl.t < v.outputEnd) hl.t = Math.max(hl.t ?? 0, v.outputEnd + 0.3);
          const last = Math.max(v.outputEnd, ...(v.highlight || []).map((hl) => hl.t));
          if (v.end === Infinity) needEnd = Math.max(needEnd, last + pace.minOutputHold);
          else if (v.end - last < pace.minOutputHold) warnings.push(`segment "${s.id}": terminal output shows ${(v.end - last).toFixed(1)} s after its last highlight, under minOutputHold ${pace.minOutputHold} s`);
        }
      }
      visuals.push(...mine);
    }

    // Beats: each change to the canvas, on the word that names it.
    if (s.beats && s.beats.length) {
      if (!scene) throw new Error(`segment "${s.id}": has beats but no scene is open (legacy \`visuals\` take no beats)`);
      const els = scene.scene.elements || {};
      const pages = (scene.scene.pages || []).map((pg) => pg.id);
      let lastBeat = -Infinity;
      for (const [k, b] of s.beats.entries()) {
        const t = paused.startOf.has(k) ? audioStart + paused.startOf.get(k) : b.at == null ? Math.max(scene.start, audioStart - 0.1) : audioStart + cueTime(b.at, s);
        const beat = { ...b, t, segment: s.id };
        if (b.page != null) {
          if (!pages.includes(b.page)) throw new Error(`segment "${s.id}": page: "${b.page}" is not one of scene "${scene.scene.id || scene.segment}"'s pages (${pages.join(', ') || 'none'})`);
          if (b.transition && !PAGE_TRANSITIONS.includes(b.transition)) throw new Error(`segment "${s.id}": transition must be ${PAGE_TRANSITIONS.join(', ')}, not ${b.transition}`);
        }
        if (b.show != null) {
          if (t - scene.lastShow < pace.minBeatGap - 1e-6) warnings.push(`segment "${s.id}": "${asList(b.show).join(', ')}" appears ${(t - scene.lastShow).toFixed(1)} s after the element before it (at "${b.at ?? 'start'}"), under minBeatGap ${pace.minBeatGap} s`);
          scene.lastShow = t + (asList(b.show).length - 1) * (b.stagger || 0);
        }
        if (b.page != null) scene.lastShow = -Infinity;
        if (b.show != null || b.ring != null || b.travel != null || b.focus != null || b.page != null) lastBeat = Math.max(lastBeat, t);
        for (const id of [...asList(b.show), ...asList(b.hide), ...asList(b.ring), ...asList(b.travel), ...asList(b.focus), ...asList(b.dim), ...Object.keys(b.move || {}), ...Object.keys(b.text || {}), ...Object.keys(b.color || {})]) {
          const base = String(id).split('/')[0];
          if (!els[base]) throw new Error(`segment "${s.id}": beat at "${b.at ?? 'start'}" names "${id}", which is not an element of scene "${scene.scene.id || scene.segment}"`);
        }
        if (b.run) {
          const term = els[b.run];
          if (!term || term.type !== 'terminal') throw new Error(`segment "${s.id}": run: "${b.run}" is not a terminal element`);
          beat.times = terminalTimes(term, t, pace);
          scene.termLast = Math.max(scene.termLast, beat.times.outputEnd);
        }
        for (const m of asList(b.mark)) {
          const term = Object.values(els).find((e) => e.type === 'terminal' && (e.highlight || []).some((hl) => hl.id === m));
          const card = Object.values(els).find((e) => e.type === 'card' && (e.highlight || []).some((hl) => hl.id === m));
          if (!term && !card) throw new Error(`segment "${s.id}": mark: "${m}" is not the id of a terminal or card highlight`);
          if (term) scene.termLast = Math.max(scene.termLast, t);
        }
        if (b.layout === 'canvas' && scene.termLast > -Infinity && t - scene.termLast < pace.minOutputHold) {
          warnings.push(`segment "${s.id}": the terminal leaves ${(t - scene.termLast).toFixed(1)} s after its last highlight, under minOutputHold ${pace.minOutputHold} s`);
        }
        if (b.layout === 'canvas') scene.termLast = -Infinity;
        scene.beats.push(beat);
      }
      // The terminal must stay a while after its last highlight before this scene closes.
      if ((nextOpens || i + 1 === segs.length) && scene.termLast > -Infinity) needEnd = Math.max(needEnd, scene.termLast + pace.minOutputHold);
      // And the segment's last change gets its hold before the next voice starts.
      if (lastBeat > -Infinity) needEnd = Math.max(needEnd, lastBeat + pace.beatHold - pace.visualLead - 0.2);
    }

    for (const w of s.words) words.push({ text: w.text, start: audioStart + w.start, end: audioStart + w.end, segment: i });
    const natural = audioEnd + pace.gap;
    const held = needEnd + pace.visualLead + 0.2;
    if (held > natural + 0.05 && i + 1 < segs.length) warnings.push(`segment "${s.id}": held ${(held - natural).toFixed(1)} s longer than its voice so its visual can finish (beatHold / minOutputHold / minStep)`);
    seg.audioEnd = audioEnd;
    seg.needEnd = needEnd;
    audioStart = i + 1 < segs.length ? Math.max(natural, held) : audioStart;
  }
  const last = placed[placed.length - 1];
  const endCardAt = last.audioEnd + 0.5;
  const endCard = video.endCard === false ? null : { at: endCardAt, title: video.endCard?.title ?? video.title, sub: video.endCard?.sub ?? 'Hands-on lab · opalix' };
  const duration = Math.max(last.audioEnd + pace.tail, last.needEnd + 0.5, endCard ? endCardAt + 2.0 : 0);
  last.visualEnd = duration;
  visuals.filter((v) => v.end === Infinity).forEach((v) => { v.end = duration; });
  visuals.forEach((v, k) => { v.index = k; delete v.termLast; delete v.lastShow; });
  return {
    duration,
    transition: pace.transition,
    pace,
    endCard,
    captionsMode: captions,
    segments: placed.map(({ id, audioStart: a, duration: d, visualStart, visualEnd, cuts }) => ({ id, audioStart: a, duration: d, visualStart, visualEnd, cuts })),
    visuals,
    captions: chunksToCues(words, captions === 'karaoke' ? { maxWords: pace.captionWords, maxChars: 18 } : { maxWords: 8, maxChars: 44 }),
    subtitles: chunksToCues(words, { maxWords: 8, maxChars: 44 }),
    warnings,
  };
}

/** Caption cues from timed words, chunked within each segment: [{ start, end, words }]. */
function chunksToCues(words, opts) {
  const cues = [];
  const bySeg = new Map();
  for (const w of words) bySeg.set(w.segment, [...(bySeg.get(w.segment) || []), w]);
  for (const ws of bySeg.values()) {
    const chunks = captionChunks(ws, opts);
    chunks.forEach((c, k) => {
      const start = c[0].start - 0.05;
      const end = k + 1 < chunks.length ? chunks[k + 1][0].start - 0.05 : c[c.length - 1].end + 0.35;
      cues.push({ start, end, words: c.map(({ text, start: a, end: b }) => ({ text, start: a, end: b })) });
    });
  }
  cues.forEach((c, k) => { if (cues[k + 1]) c.end = Math.min(c.end, cues[k + 1].start); });
  return cues;
}

const vttTime = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, '0')}`;
};

/** A WebVTT sidecar from the timeline's subtitle cues. */
export function toVtt(timeline) {
  const body = timeline.subtitles.map((c, k) => `${k + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.words.map((w) => w.text).join(' ')}\n`);
  return `WEBVTT\n\n${body.join('\n')}`;
}
