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
 * first word is spoken. Throws naming the segment when the phrase is not there.
 */
export function cueTime(at, seg) {
  if (typeof at === 'number') return at;
  const want = String(at).split(/\s+/).map(norm).filter(Boolean);
  const words = seg.words.map((w) => norm(w.text));
  for (let i = 0; i + want.length <= words.length; i++) {
    if (want.every((w, k) => words[i + k] === w)) return Math.max(0, seg.words[i].start - 0.06);
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

/**
 * The page's timeline. `segs[i]` is the video's segment i plus its narration:
 * `{ id, vo, visuals, duration, words: [{ text, start, end }] }`, word times
 * in seconds of the (trimmed, tempo-adjusted) clip.
 * pace: { lead, gap, tail, visualLead } in seconds.
 */
export function buildTimeline(video, segs, pace) {
  const { lead = 0.1, gap = 0.26, tail = 1.0, visualLead = 0.14, padIn = 0, padOut = 0 } = pace;
  let cursor = lead;
  const placed = segs.map((s) => {
    const audioStart = cursor;
    // The clip carries padIn/padOut of its own quiet; the gap is the whole pause between voices.
    cursor = audioStart + s.duration + Math.max(0, gap - padIn - padOut);
    return { ...s, audioStart };
  });
  const last = placed[placed.length - 1];
  const duration = last.audioStart + last.duration + tail;

  const visuals = [];
  const captions = [];
  placed.forEach((s, i) => {
    const vStart = i === 0 ? 0 : Math.max(0, s.audioStart - visualLead);
    const vEnd = i + 1 < placed.length ? Math.max(vStart, placed[i + 1].audioStart - visualLead) : duration;
    s.visualStart = vStart;
    s.visualEnd = vEnd;
    const list = s.visuals || [];
    const resolved = list.map((v) => resolveCues(v, s, s.audioStart));
    resolved.forEach((v, k) => {
      const start = k === 0 ? vStart : Math.max(vStart, v.t ?? vStart);
      visuals.push({ ...v, segment: s.id, start, end: vEnd });
      if (k > 0) visuals[visuals.length - 2].end = start;
    });

    const abs = s.words.map((w) => ({ text: w.text, start: s.audioStart + w.start, end: s.audioStart + w.end }));
    const chunks = captionChunks(abs);
    const nextStart = i + 1 < placed.length ? placed[i + 1].audioStart : duration;
    chunks.forEach((c, k) => {
      const start = c[0].start - 0.04;
      const end = k + 1 < chunks.length ? chunks[k + 1][0].start - 0.04 : Math.min(c[c.length - 1].end + 0.3, nextStart - 0.04);
      captions.push({ start, end, words: c });
    });
  });
  visuals.forEach((v, k) => { v.index = k; });
  return {
    duration,
    segments: placed.map(({ id, audioStart, duration: d, visualStart, visualEnd }) => ({ id, audioStart, duration: d, visualStart, visualEnd })),
    visuals,
    captions,
  };
}
