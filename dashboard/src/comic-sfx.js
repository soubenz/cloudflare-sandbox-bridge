/**
 * The motion comic's sound stings: the short sound a sound effect makes (`sfx: { text, sound }` in
 * comic.yaml, docs/learning-content.md), synthesised with Web Audio. No files: each sting is a few
 * oscillators and a burst of filtered noise, 80 to 400 ms long.
 *
 *   phone     two buzz bursts            ping      a sine with a fast decay
 *   thud      a low knock and noise      register  two quick high clicks, then a chime
 *   whoosh    a noise sweep, low to high pop       a short falling blip
 *   tick      a click
 *
 * The comic's one clock decides when (comic-timeline.js puts each sting at its sfx's moment, cue-timed);
 * comic.js asks stingsDue() each time the clock moves forwards and plays what it returns, never while the
 * Sound toggle is off, in test mode, under reduced motion, or when the comic is paused or finished. A sting
 * is short, so Skip and Replay stop nothing. Stings sit STING_DB under the storyteller.
 *
 * One AudioContext serves every comic on the page: made by unlockStings() inside the learner's first tap on
 * a comic (a browser allows sound only after one), and kept. Until then, and where there is no Web Audio,
 * playSting() does nothing.
 */

import { STING_SOUNDS } from '../../src/labs/comic-kit.ts';

export { STING_SOUNDS };

/** Stings are this many decibels under the storyteller (whose clips play at full volume). */
export const STING_DB = -14;
export const STING_GAIN = Math.pow(10, STING_DB / 20);

/** A sting whose moment the clock passed more than this long ago is not played (a seek, a long frame): it would land late. */
export const STING_LATE = 0.3;

/** How long each sting sounds, in seconds: what the synthesis below schedules, all between 80 and 400 ms. */
export const STING_SECONDS = { phone: 0.27, ping: 0.35, thud: 0.23, register: 0.4, whoosh: 0.37, pop: 0.09, tick: 0.08 };

/**
 * The stings (`{ sound, at }`, in time order) whose moment the clock reached going forwards from `from` to
 * `to`: `from < at <= to`, and no more than STING_LATE ago. Going backwards (Replay, a seek back) is none. Pure.
 */
export function stingsDue(stings, from, to) {
  if (!(to > from)) return [];
  return stings.filter((s) => s.at > from && s.at <= to && to - s.at <= STING_LATE);
}

// ---------------------------------------------------------------------------
// The synthesis: each sting is scheduled on `ctx` into `out` from time `t0`
// ---------------------------------------------------------------------------

/** A gain that rises to `peak` in `attack` seconds and falls away over `decay`. */
function envelope(ctx, t0, peak, attack, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  return g;
}

/** An oscillator note, optionally sliding to `to` Hz over its length. */
function tone(ctx, out, t0, { type = 'sine', freq, to, peak, attack = 0.004, decay }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + attack + decay);
  const g = envelope(ctx, t0, peak, attack, decay);
  o.connect(g);
  g.connect(out);
  o.start(t0);
  o.stop(t0 + attack + decay);
}

/** A burst of white noise through a filter, optionally sweeping to `to` Hz. */
function burst(ctx, out, t0, noise, { type, freq, to, q = 0.7, peak, attack = 0.002, decay }) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + attack + decay);
  f.Q.value = q;
  const g = envelope(ctx, t0, peak, attack, decay);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  src.start(t0);
  src.stop(t0 + attack + decay);
}

/** Each sting, scheduled from `t0`; `noise` is a buffer of white noise. Exported for the tests. */
export const SYNTH = {
  phone: (ctx, out, t0) => {
    for (const at of [t0, t0 + 0.15]) {
      tone(ctx, out, at, { type: 'square', freq: 180, peak: 0.3, attack: 0.01, decay: 0.11 });
      tone(ctx, out, at, { type: 'square', freq: 236, peak: 0.18, attack: 0.01, decay: 0.11 });
    }
  },
  ping: (ctx, out, t0) => {
    tone(ctx, out, t0, { freq: 1320, peak: 0.8, decay: 0.34 });
    tone(ctx, out, t0, { freq: 2640, peak: 0.18, decay: 0.18 });
  },
  thud: (ctx, out, t0, noise) => {
    tone(ctx, out, t0, { freq: 95, to: 45, peak: 0.9, decay: 0.22 });
    burst(ctx, out, t0, noise, { type: 'lowpass', freq: 240, peak: 0.6, decay: 0.12 });
  },
  register: (ctx, out, t0, noise) => {
    burst(ctx, out, t0, noise, { type: 'highpass', freq: 3500, peak: 0.5, attack: 0.001, decay: 0.015 });
    burst(ctx, out, t0 + 0.06, noise, { type: 'highpass', freq: 3500, peak: 0.5, attack: 0.001, decay: 0.015 });
    tone(ctx, out, t0 + 0.12, { freq: 1568, peak: 0.45, decay: 0.275 });
    tone(ctx, out, t0 + 0.12, { freq: 2093, peak: 0.3, decay: 0.275 });
  },
  whoosh: (ctx, out, t0, noise) => {
    burst(ctx, out, t0, noise, { type: 'bandpass', freq: 300, to: 2800, q: 1.2, peak: 0.7, attack: 0.16, decay: 0.2 });
  },
  pop: (ctx, out, t0) => {
    tone(ctx, out, t0, { type: 'triangle', freq: 620, to: 240, peak: 0.8, attack: 0.003, decay: 0.085 });
  },
  tick: (ctx, out, t0, noise) => {
    burst(ctx, out, t0, noise, { type: 'highpass', freq: 4000, peak: 0.6, attack: 0.001, decay: 0.01 });
    tone(ctx, out, t0, { type: 'square', freq: 2200, peak: 0.12, attack: 0.001, decay: 0.079 });
  },
};

/** Half a second of white noise, made once per context. */
function whiteNoise(ctx) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * 0.5));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

// ---------------------------------------------------------------------------
// The one context of the page
// ---------------------------------------------------------------------------

/** `{ ctx, out, noise }`: the shared context, its output at STING_GAIN, and its noise; null until the first tap. */
let shared = null;

/**
 * Call inside the learner's tap: makes the page's one AudioContext (or wakes it if the browser suspended it).
 * Returns whether stings can play. Safe to call on every tap.
 */
export function unlockStings() {
  try {
    if (!shared) {
      const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (typeof AC !== 'function') return false;
      const ctx = new AC();
      const out = ctx.createGain();
      out.gain.value = STING_GAIN;
      out.connect(ctx.destination);
      shared = { ctx, out, noise: null };
    }
    if (shared.ctx.state === 'suspended') shared.ctx.resume?.()?.catch?.(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Plays a sting now, if the context exists; an unknown sound or any failure plays nothing. Returns whether it was started. */
export function playSting(sound) {
  if (!shared || !Object.hasOwn(SYNTH, sound) || shared.ctx.state === 'closed') return false;
  try {
    shared.noise ??= whiteNoise(shared.ctx);
    SYNTH[sound](shared.ctx, shared.out, shared.ctx.currentTime + 0.005, shared.noise);
    return true;
  } catch {
    return false;
  }
}
