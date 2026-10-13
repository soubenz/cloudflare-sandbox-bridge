import { describe, expect, it } from 'vitest';
import { panelSeconds } from '../../src/labs/comic-kit';
import { CAST_COMIC, SINGLE, castNarrationOf, narrationOf, oldShapeNarrationOf, type FixtureAudio } from '../e2e/comic-fixture';

/**
 * The characters speak their bubbles, in the console's schedule (dashboard/src/comic-timeline.js): with a narration
 * that has bubble clips (each in its speaker's voice) a panel's clips play one after another, the storyteller's
 * first 0.6 s in, then each spoken bubble 0.35 s after the clip before it ends; a bubble pops and types when its clip
 * starts; the panel lasts until the last clip ends plus the hold; never two clips at once. A narration that is half
 * voiced, or names the wrong speaker, plays the comic silent (whole). The player that runs it is comic.js
 * (window.__comicClock.audio lists every clip with who) and test/e2e/19-comic-audio.spec.ts.
 */

type Clip = { key: string; kind: 'voiceover' | 'bubble'; bubble: number | null; who?: string; panel: number; start: number; end: number; seconds: number };
type TBubble = { who?: string; start: number; end: number; step: number; wordTimes: number[] };
type TPanel = { number: number; start: number; end: number; dur: number; words: number; bubbles: TBubble[] };
type Timeline = { total: number; pages: Array<{ panels: TPanel[] }>; audio: Clip[] };

const T = (await import('../../dashboard/src/comic-timeline.js' as string)) as {
  TIMING: { voice: number; speakerGap: number; hold: number; bubblePop: number; word: number; bubbleLag: number };
  buildTimeline: (c: unknown, o?: { audio?: unknown }) => Timeline;
  cleanAudio: (raw: unknown) => { clips: Record<string, { seconds: number; text: string; who?: string }>; lines: Array<{ panel: number; kind: string; bubble?: number; clip: string }> } | null;
  cleanComic: (raw: unknown) => unknown;
  panelState: (p: TPanel, t: number) => { bubbles: Array<{ on: boolean; words: number; speaking: boolean }> };
};
const AU = (await import('../../dashboard/src/comic-audio.js' as string)) as {
  audioWanted: (clips: Clip[], t: number, o: { running: boolean; sound: boolean }) => { clip: Clip; offset: number } | null;
};

const slugged = (a: FixtureAudio) => ({ ...a, slug: 'cast' });
const comic = T.cleanComic(CAST_COMIC)!;
const tl = T.buildTimeline(comic, { audio: slugged(castNarrationOf(CAST_COMIC)) });
const panels = tl.pages.flatMap((p) => p.panels);
const silent = T.buildTimeline(comic);
const strip = (t: Timeline) => JSON.parse(JSON.stringify(t));

describe('cleaning a narration with the cast\'s voices', () => {
  it('keeps bubble lines with their bubble number, and who speaks each clip', () => {
    const a = T.cleanAudio(slugged(castNarrationOf(CAST_COMIC)))!;
    expect(a.lines.map((l) => `${l.panel}:${l.kind}:${l.bubble ?? '-'}`)).toEqual(['0:voiceover:-', '0:bubble:0', '1:voiceover:-', '1:bubble:0', '1:bubble:1', '2:voiceover:-', '2:bubble:0', '3:voiceover:-', '3:bubble:0', '4:voiceover:-']);
    expect(Object.values(a.clips).map((c) => c.who)).toEqual(['narrator', 'graham', 'narrator', 'ollie', 'jess', 'narrator', 'priya', 'narrator', 'maren', 'narrator']);
  });

  it('still turns the old caption-and-bubble shape off whole, and a bubble line whose clip names nobody', () => {
    expect(T.cleanAudio(slugged(oldShapeNarrationOf(SINGLE)))).toBeNull();
    const nobody = castNarrationOf(CAST_COMIC);
    delete nobody.clips[nobody.lines[1]!.clip]!.who;
    expect(T.cleanAudio(slugged(nobody))).toBeNull();
    const learner = castNarrationOf(CAST_COMIC);
    learner.clips[learner.lines[1]!.clip]!.who = 'you';
    expect(T.cleanAudio(slugged(learner))).toBeNull();
  });
});

describe('the schedule with the cast\'s voices', () => {
  it('lists every clip, the storyteller\'s and each spoken bubble\'s, with who speaks it', () => {
    expect(tl.audio.map((c) => `${c.panel}:${c.kind}:${c.who ?? 'narrator'}`)).toEqual([
      '1:voiceover:narrator',
      '1:bubble:graham',
      '2:voiceover:narrator',
      '2:bubble:ollie',
      '2:bubble:jess',
      '3:voiceover:narrator',
      '3:bubble:priya',
      '4:voiceover:narrator',
      '4:bubble:maren',
      '5:voiceover:narrator',
    ]);
    expect(tl.audio.filter((c) => c.kind === 'bubble').map((c) => c.bubble)).toEqual([0, 0, 1, 0, 0]);
  });

  it('plays a panel\'s clips one after another: the voiceover 0.6 s in, each bubble 0.35 s after the clip before it ends', () => {
    for (const p of panels) {
      const mine = tl.audio.filter((c) => c.panel === p.number);
      expect(mine[0]!.kind).toBe('voiceover');
      expect(mine[0]!.start).toBeCloseTo(p.start + T.TIMING.voice, 9);
      for (let i = 1; i < mine.length; i++) expect(mine[i]!.start, `panel ${p.number} clip ${i + 1}`).toBeCloseTo(mine[i - 1]!.end + T.TIMING.speakerGap, 9);
      for (const c of mine) expect(c.end).toBeCloseTo(c.start + c.seconds, 9);
    }
    expect(T.TIMING.speakerGap).toBe(0.35);
  });

  it('pops a spoken bubble when its clip starts and types it over the clip; its speaker talks until the clip ends', () => {
    for (const c of tl.audio.filter((x) => x.kind === 'bubble')) {
      const p = panels.find((x) => x.number === c.panel)!;
      const b = p.bubbles[c.bubble!]!;
      expect(b.who).toBe(c.who);
      expect(b.start).toBeCloseTo(c.start, 9);
      expect(b.wordTimes[0]).toBeCloseTo(c.start + T.TIMING.bubblePop, 9);
      expect(b.wordTimes[b.wordTimes.length - 1]!).toBeLessThan(c.end + 1e-9);
      expect(b.step).toBeLessThanOrEqual(T.TIMING.word);
      expect(b.end).toBeGreaterThanOrEqual(c.end - 1e-9);
      expect(T.panelState(p, c.start - 0.01).bubbles[c.bubble!]!.on).toBe(false);
      expect(T.panelState(p, c.start).bubbles[c.bubble!]!.on).toBe(true);
      expect(T.panelState(p, (c.start + c.end) / 2).bubbles[c.bubble!]!.speaking).toBe(true);
    }
  });

  it('gives a bubble nobody voices (the learner\'s) its turn after the clips before it, typed at the reading pace, with no clip', () => {
    const p = panels[3]!;
    const maren = tl.audio.find((c) => c.panel === 4 && c.kind === 'bubble')!;
    const you = p.bubbles[1]!;
    expect(you.who).toBe('you');
    expect(you.start).toBeCloseTo(maren.end + T.TIMING.speakerGap, 9);
    expect(you.step).toBe(T.TIMING.word);
    expect(tl.audio.some((c) => c.panel === 4 && c.bubble === 1)).toBe(false);
  });

  it('keeps a panel up until its last clip has ended and the hold has passed (or its reading time, if longer)', () => {
    for (const p of panels) {
      const mine = tl.audio.filter((c) => c.panel === p.number);
      const last = Math.max(...mine.map((c) => c.end), ...p.bubbles.map((b) => b.end));
      expect(p.dur, `panel ${p.number}`).toBeCloseTo(Math.max(panelSeconds(p.words), last - p.start + T.TIMING.hold), 9);
      expect(p.end).toBeGreaterThanOrEqual(last + T.TIMING.hold - 1e-9);
    }
  });

  it('never has two clips at once: every clip starts after the one before has ended, and the clock asks for one at a time', () => {
    for (let i = 1; i < tl.audio.length; i++) expect(tl.audio[i]!.start).toBeGreaterThan(tl.audio[i - 1]!.end);
    for (let t = 0; t < tl.total; t += 0.05) {
      const sounding = tl.audio.filter((c) => t >= c.start && t < c.end);
      expect(sounding.length, `t=${t}`).toBeLessThanOrEqual(1);
      const wanted = AU.audioWanted(tl.audio, t, { running: true, sound: true });
      expect(wanted?.clip ?? null).toBe(sounding[0] ?? null);
    }
  });

  it('is a pure function of the narration: the same schedule every time', () => {
    expect(strip(T.buildTimeline(comic, { audio: slugged(castNarrationOf(CAST_COMIC)) }))).toEqual(strip(tl));
  });
});

describe('a narration that does not match plays the comic silent, whole', () => {
  it('half voiced (a speaking bubble with no clip), a wrong speaker, or other words: no clip at all, the silent schedule', () => {
    const half = castNarrationOf(CAST_COMIC);
    const i = half.lines.findIndex((l) => l.kind === 'bubble' && l.panel === 1 && l.bubble === 1);
    delete half.clips[half.lines[i]!.clip];
    half.lines.splice(i, 1);
    const speaker = castNarrationOf(CAST_COMIC);
    speaker.clips[speaker.lines[1]!.clip]!.who = 'tomasz';
    const words = castNarrationOf(CAST_COMIC);
    words.clips[words.lines[1]!.clip]!.text = 'Somebody else said this.';
    const twice = castNarrationOf(CAST_COMIC);
    twice.lines.splice(2, 0, { ...twice.lines[1]! });
    const narrator = castNarrationOf(CAST_COMIC);
    narrator.clips[narrator.lines[0]!.clip]!.who = 'graham';
    for (const [name, a] of [['half', half], ['speaker', speaker], ['words', words], ['twice', twice], ['a voiceover in a character\'s mouth', narrator]] as const) {
      const t = T.buildTimeline(comic, { audio: slugged(a) });
      expect(t.audio, name).toEqual([]);
      expect(strip(t), name).toEqual(strip(silent));
    }
  });

  it('a narration of the voiceovers alone plays as today: the bubbles are text, typed after the voiceover starts', () => {
    const t = T.buildTimeline(comic, { audio: slugged(narrationOf(CAST_COMIC)) });
    expect(t.audio.every((c) => c.kind === 'voiceover')).toBe(true);
    expect(t.audio).toHaveLength(5);
    const p = t.pages[0]!.panels[1]!;
    expect(p.bubbles[0]!.start).toBeCloseTo(t.audio[1]!.start + T.TIMING.bubbleLag, 9);
  });
});
