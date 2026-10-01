import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { TTS_MODEL, clipKey, legacyNarrationLines, narrationLines, panelSeconds } from '../../src/labs/comic-kit';

/**
 * The comic's storyteller as logic with no browser: the timeline when the lab is narrated (one voiceover
 * clip per voiced panel, started 0.6 s into the panel, the panel as long as the voice needs, bubbles typed
 * as text within the clip, no change at all without audio) and the scheduling state machine
 * (dashboard/src/comic-audio.js) that turns the one clock into play and stop. The player that runs it, with
 * real Audio elements, is test/e2e/19-comic-audio.spec.ts.
 */
type Panel = { scene: string; cast: string[]; bg?: string; prop: string; caption?: string; voiceover?: string; bubbles: Array<{ who?: string; text: string; pos?: string }>; sfx?: string; lines?: string[] };
type Comic = { title: string; pages: Array<{ title?: string; panels: Panel[] }> };
type Clip = { key: string; kind: 'voiceover'; bubble: null; panel: number; start: number; end: number; seconds: number };
type TBubble = { start: number; end: number; step: number; wordTimes: number[] };
type TPanel = { number: number; start: number; end: number; dur: number; captionAt: number | null; bubbles: TBubble[]; lines: Array<{ start: number; end: number }> };
type Timeline = { total: number; pages: Array<{ index: number; start: number; panels: TPanel[] }>; audio: Clip[] };
type AudioIn = { slug: string; clips: Record<string, { seconds: number; text: string; voice?: string }>; lines: Array<{ panel: number; kind: string; bubble?: number; clip: string }> };
type AState = { current: string | null; blocked: boolean; finished: string | null; failed: string[] };
type Cmd = { type: 'play' | 'stop'; key: string; offset?: number };
type Wanted = { clip: Clip; offset: number } | null;

const T = (await import('../../dashboard/src/comic-timeline.js' as string)) as {
  TIMING: { content: number; bubblePop: number; bubbleGap: number; hold: number; word: number; caption: number; voice: number; bubbleLag: number; bubbleTail: number; breath: number };
  buildTimeline: (c: Comic, o?: { audio?: unknown }) => Timeline;
  cleanAudio: (raw: unknown) => AudioIn | null;
  cleanComic: (raw: unknown) => Comic | null;
  panelState: (p: TPanel, t: number) => { bubbles: Array<{ on: boolean; words: number; speaking: boolean }> };
  panelWords: (p: Panel) => number;
};
const A = (await import('../../dashboard/src/comic-audio.js' as string)) as {
  LATE_START: number;
  audioWanted: (clips: Clip[], t: number, o: { running: boolean; sound: boolean }) => Wanted;
  audioReduce: (s: AState, e: Record<string, unknown>) => { state: AState; commands: Cmd[] };
  initialAudio: () => AState;
  clipUrl: (slug: string, key: string) => string;
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const panel = (over: Partial<Panel> = {}): Panel => ({ scene: 'portrait', cast: ['maren'], prop: 'none', bubbles: [{ who: 'maren', text: 'Hello there, this is a bubble.' }], ...over });
const COMIC: Comic = {
  title: 'Voiced',
  pages: [
    {
      panels: [
        panel({ scene: 'desk', cast: ['maren'], caption: 'Tuesday, a little after ten.', voiceover: 'On Tuesday finance asked us a question we could not answer.', bubbles: [{ who: 'maren', text: 'Which provider answered, and what did that one reply cost?' }], lines: ['$ one', 'two'] }),
        panel({ scene: 'duo', cast: ['maren', 'tomasz'], voiceover: 'Tomasz and I looked at it together.', bubbles: [{ who: 'maren', text: 'One two three four five.' }, { who: 'tomasz', text: 'Six seven eight nine ten eleven.' }] }),
        panel({ scene: 'screen', cast: [], bubbles: [], lines: ['$ run it', '200 ok'] }), // nothing spoken
        panel({ scene: 'you', cast: [], bubbles: [], caption: 'Your turn.', voiceover: 'Now it is your turn.', lines: ['$ go', 'ready.'] }),
      ],
    },
    { title: 'Later', panels: [panel({ voiceover: 'It took us all afternoon.', bubbles: [{ text: 'Somebody said it.' }] }), panel({ voiceover: 'And that was the end of it.' })] },
  ],
};

/** The narration a CLI run would write: one clip per voiceover, each 1.5 s plus a twelfth of a second per character. */
function narration(comic: Comic = COMIC, secondsOf = (text: string) => 1.5 + text.length / 12): AudioIn {
  const clips: AudioIn['clips'] = {};
  const lines = narrationLines(comic as any).map((l) => {
    const clip = clipKey(TTS_MODEL, l.voice, l.text, sha);
    clips[clip] = { seconds: secondsOf(l.text), text: l.text, voice: l.voice };
    return { panel: l.panel, kind: l.kind, clip };
  });
  return { slug: 'a-lab', clips, lines };
}

const panelsOf = (tl: Timeline) => tl.pages.flatMap((p) => p.panels);
const allPanels = (c: Comic) => c.pages.flatMap((p) => p.panels);

describe('without narration the timeline is exactly what it was', () => {
  const plain = T.buildTimeline(COMIC);
  it('has no clips, and ignores absent or empty narration', () => {
    expect(plain.audio).toEqual([]);
    expect(T.buildTimeline(COMIC, {})).toEqual(plain);
    expect(T.buildTimeline(COMIC, { audio: undefined })).toEqual(plain);
    expect(T.buildTimeline(COMIC, { audio: null })).toEqual(plain);
    expect(T.buildTimeline(COMIC, { audio: { slug: 'x', clips: {}, lines: [] } })).toEqual(plain);
    expect(T.buildTimeline(COMIC, { audio: 'nonsense' })).toEqual(plain);
  });

  it('keeps every panel at its reading time (the voiceover is heard, not read, so it adds no words)', () => {
    panelsOf(plain).forEach((p, i) => expect(p.dur).toBe(panelSeconds(T.panelWords(allPanels(COMIC)[i]!))));
  });

  it('turns the narration off whole when anything does not match the comic (a voice never says other words, a story is never half voiced)', () => {
    const a = narration();
    const wrongText = structuredClone(a);
    wrongText.clips[wrongText.lines[1]!.clip]!.text = 'Some other words entirely.';
    expect(T.buildTimeline(COMIC, { audio: wrongText })).toEqual(plain);
    const noVoiceover = structuredClone(a);
    noVoiceover.lines.push({ panel: 2, kind: 'voiceover', clip: a.lines[0]!.clip }); // the screen panel has none
    expect(T.buildTimeline(COMIC, { audio: noVoiceover })).toEqual(plain);
    const missingPanel = structuredClone(a);
    missingPanel.lines.push({ panel: 99, kind: 'voiceover', clip: a.lines[0]!.clip });
    expect(T.buildTimeline(COMIC, { audio: missingPanel })).toEqual(plain);
    const twice = structuredClone(a);
    twice.lines.push(a.lines[0]!);
    expect(T.buildTimeline(COMIC, { audio: twice })).toEqual(plain);
    const incomplete = structuredClone(a);
    incomplete.lines.pop(); // the last voiceover has no clip
    expect(T.buildTimeline(COMIC, { audio: incomplete })).toEqual(plain);
  });

  it('plays old-shape narration (caption and bubble lines, several voices) silent, whole, whether the comic is old or new', () => {
    const old = (comic: Comic): AudioIn => {
      const clips: AudioIn['clips'] = {};
      const lines = legacyNarrationLines(comic as any).map((l) => {
        const clip = clipKey(TTS_MODEL, l.voice, l.text, sha);
        clips[clip] = { seconds: 2, text: l.text, voice: l.voice };
        return { panel: l.panel, kind: l.kind, ...(l.bubble !== undefined ? { bubble: l.bubble } : {}), clip };
      });
      return { slug: 'a-lab', clips, lines };
    };
    expect(old(COMIC).lines.length).toBeGreaterThan(5);
    expect(T.cleanAudio(old(COMIC))).toBeNull();
    expect(T.buildTimeline(COMIC, { audio: old(COMIC) })).toEqual(plain);
    // an old comic (no voiceover anywhere) with its own old narration
    const oldComic: Comic = { title: 'Old', pages: [{ panels: allPanels(COMIC).map(({ voiceover: _v, ...p }) => p) }] };
    const oldPlain = T.buildTimeline(oldComic);
    expect(T.buildTimeline(oldComic, { audio: old(oldComic) })).toEqual(oldPlain);
    expect(oldPlain.audio).toEqual([]);
    // old lines mixed into a new narration turn all of it off
    const mixed = narration();
    const k = old(COMIC).lines[0]!;
    mixed.clips[k.clip] = { seconds: 2, text: 'Tuesday, a little after ten.' };
    mixed.lines.push(k);
    expect(T.buildTimeline(COMIC, { audio: mixed })).toEqual(plain);
  });
});

describe('with narration the storyteller sets the pace', () => {
  const audio = narration();
  const tl = T.buildTimeline(COMIC, { audio });
  const plain = T.buildTimeline(COMIC);
  const secondsOf = (key: string) => audio.clips[key]!.seconds;
  const voicedPanels = [1, 2, 4, 5, 6]; // panel numbers with a voiceover

  it('has one voiceover clip per voiced panel, in time order, none overlapping, each as long as its file', () => {
    expect(tl.audio).toHaveLength(5);
    expect(tl.audio.map((c) => c.panel)).toEqual(voicedPanels);
    expect(tl.audio.every((c) => c.kind === 'voiceover' && c.bubble === null)).toBe(true);
    expect(tl.audio.map((c) => c.key).sort()).toEqual(audio.lines.map((l) => l.clip).sort());
    for (let i = 1; i < tl.audio.length; i++) expect(tl.audio[i]!.start).toBeGreaterThanOrEqual(tl.audio[i - 1]!.end - 1e-9);
    for (const c of tl.audio) expect(c.end - c.start).toBeCloseTo(secondsOf(c.key), 9);
    expect(tl.audio.some((c) => c.panel === 3)).toBe(false); // the screen panel is silent
  });

  it('starts each clip 0.6 s into its panel', () => {
    expect(T.TIMING.voice).toBe(0.6);
    for (const c of tl.audio) expect(c.start).toBeCloseTo(panelsOf(tl)[c.panel - 1]!.start + 0.6, 9);
  });

  it('keeps each voiced panel on screen for the larger of its reading time and the clip end plus the hold, so no clip is cut', () => {
    for (const c of tl.audio) {
      const p = panelsOf(tl)[c.panel - 1]!;
      const reading = panelsOf(plain)[c.panel - 1]!.dur;
      expect(p.dur).toBeCloseTo(Math.max(reading, c.end - p.start + T.TIMING.hold), 9);
      expect(p.end).toBeGreaterThanOrEqual(c.end + T.TIMING.hold - 1e-9);
    }
    expect(tl.total).toBeGreaterThan(plain.total);
  });

  it('leaves a panel with no voiceover exactly as long as it was', () => {
    const screen = panelsOf(tl)[2]!;
    expect(screen.dur).toBe(panelsOf(plain)[2]!.dur);
  });

  it('leaves silence of at least a breath between one voiceover and the next', () => {
    expect(T.TIMING.breath).toBe(0.5);
    for (let i = 1; i < tl.audio.length; i++) {
      const gap = tl.audio[i]!.start - tl.audio[i - 1]!.end;
      expect(gap).toBeGreaterThanOrEqual(T.TIMING.breath);
      // within a page it is at least the panel hold plus the 0.6 s the next one waits (a panel that takes longer to read adds more)
      if (tl.audio[i]!.panel === tl.audio[i - 1]!.panel + 1 && panelsOf(tl)[tl.audio[i]!.panel - 1]!.start === panelsOf(tl)[tl.audio[i - 1]!.panel - 1]!.end) {
        expect(gap).toBeGreaterThanOrEqual(T.TIMING.hold + T.TIMING.voice - 1e-9);
      }
    }
  });

  it('fades the caption in at the panel start, voiced or not', () => {
    const p0 = panelsOf(tl)[0]!;
    expect(p0.captionAt).toBeCloseTo(p0.start + T.TIMING.caption, 9);
    expect(p0.captionAt!).toBeLessThan(tl.audio[0]!.start);
  });

  it('types a panel\'s bubbles as text, the first 0.8 s after the clip starts, one after the other at the reading pace', () => {
    const duo = panelsOf(tl)[1]!;
    const clip = tl.audio.find((c) => c.panel === 2)!;
    const [a, b] = duo.bubbles as [TBubble, TBubble];
    expect(a.start).toBeCloseTo(clip.start + T.TIMING.bubbleLag, 9);
    expect(a.wordTimes).toHaveLength(5);
    expect(a.wordTimes[0]).toBeCloseTo(a.start + T.TIMING.bubblePop, 9);
    for (const x of [a, b]) {
      expect(x.step).toBeCloseTo(T.TIMING.word, 9);
      for (let i = 1; i < x.wordTimes.length; i++) expect(x.wordTimes[i]! - x.wordTimes[i - 1]!).toBeCloseTo(T.TIMING.word, 9);
    }
    expect(b.start).toBeCloseTo(a.end + T.TIMING.bubbleGap, 9);
    // all within the voiceover (plus its tail), nothing typed after the panel
    expect(b.end).toBeLessThanOrEqual(clip.end + T.TIMING.bubbleTail + 1e-9);
    expect(b.end + T.TIMING.hold).toBeLessThanOrEqual(duo.end + 1 + 1e-9);
  });

  it('types faster, never slower, when there are more bubble words than the voiceover leaves room for', () => {
    const comic: Comic = { title: 't', pages: [{ panels: [panel({ voiceover: 'Short.', bubbles: [{ text: Array(12).fill('word').join(' ') }, { text: Array(12).fill('word').join(' ') }] })] }] };
    const out = T.buildTimeline(comic, { audio: narration(comic, () => 2) });
    const clip = out.audio[0]!;
    const [a, b] = panelsOf(out)[0]!.bubbles as [TBubble, TBubble];
    expect(a.step).toBeLessThan(T.TIMING.word);
    expect(a.step).toBeGreaterThanOrEqual(0.03);
    expect(b.step).toBe(a.step);
    expect(b.end).toBeLessThanOrEqual(clip.end + T.TIMING.bubbleTail + 1e-9);
    // a roomy clip keeps the reading pace and finishes early
    const roomy = T.buildTimeline(comic, { audio: narration(comic, () => 40) });
    expect((panelsOf(roomy)[0]!.bubbles[0] as TBubble).step).toBeCloseTo(T.TIMING.word, 9);
    expect((panelsOf(roomy)[0]!.bubbles[1] as TBubble).end).toBeLessThan(roomy.audio[0]!.end);
  });

  it('never cuts a panel before its bubbles are typed, even when they cannot all fit the voiceover', () => {
    const comic: Comic = { title: 't', pages: [{ panels: [panel({ voiceover: 'Short.', bubbles: [{ text: Array(70).fill('word').join(' ') }, { text: Array(70).fill('word').join(' ') }] })] }] };
    const out = T.buildTimeline(comic, { audio: narration(comic, () => 1) });
    const p = panelsOf(out)[0]!;
    for (const b of p.bubbles) expect(b.end + T.TIMING.hold).toBeLessThanOrEqual(p.end + 1e-9);
    expect(p.end).toBeGreaterThanOrEqual(out.audio[0]!.end + T.TIMING.hold - 1e-9);
  });

  it('shows the speaker as speaking while their bubble is typed', () => {
    const p1 = panelsOf(tl)[1]!;
    const [a, b] = p1.bubbles as [TBubble, TBubble];
    const mid = (x: TBubble) => (x.start + T.TIMING.bubblePop + x.end) / 2;
    expect(T.panelState(p1, mid(a)).bubbles.map((x) => x.speaking)).toEqual([true, false]);
    expect(T.panelState(p1, mid(b)).bubbles.map((x) => x.speaking)).toEqual([false, true]);
    expect(T.panelState(p1, mid(b)).bubbles[0]!.words).toBe(5);
  });

  it('keeps a long clip from being cut off, and a short one from shortening a panel', () => {
    const long = T.buildTimeline(COMIC, { audio: narration(COMIC, () => 30) });
    for (const c of long.audio) expect(panelsOf(long)[c.panel - 1]!.end).toBeGreaterThan(c.end);
    const tiny = T.buildTimeline(COMIC, { audio: narration(COMIC, () => 0.2) });
    panelsOf(tiny).forEach((p, i) => expect(p.dur).toBeGreaterThanOrEqual(panelsOf(plain)[i]!.dur));
  });
});

describe('cleanAudio', () => {
  const good = narration();
  it('keeps a well-formed narration and drops what cannot be trusted', () => {
    const c = T.cleanAudio(good)!;
    expect(c.slug).toBe('a-lab');
    expect(c.lines).toHaveLength(good.lines.length);
    expect(c.lines.every((l) => l.kind === 'voiceover')).toBe(true);
    expect(T.cleanAudio({ ...good, slug: '../x' })).toBeNull();
    expect(T.cleanAudio({ ...good, slug: undefined })).toBeNull();
    expect(T.cleanAudio({ ...good, lines: 'x' })).toBeNull();
    expect(T.cleanAudio(null)).toBeNull();
    const k = good.lines[0]!.clip;
    const bad = T.cleanAudio({ ...good, clips: { ...good.clips, [k]: { seconds: -1, text: 'x' }, 'not-hex': { seconds: 1, text: 'y' } } })!;
    expect(Object.keys(bad.clips)).not.toContain(k);
    expect(Object.keys(bad.clips)).not.toContain('not-hex');
    expect(bad.lines.some((l) => l.clip === k)).toBe(false);
  });
  it('refuses a line of any other kind (the old caption and bubble narration) as a whole', () => {
    expect(T.cleanAudio({ ...good, lines: [...good.lines, { panel: 0, kind: 'caption', clip: good.lines[0]!.clip }] })).toBeNull();
    expect(T.cleanAudio({ ...good, lines: [{ panel: 0, kind: 'bubble', bubble: 0, clip: good.lines[0]!.clip }] })).toBeNull();
  });
  it('builds clip URLs from the slug and key only', () => {
    expect(A.clipUrl('a-lab', '82111213e8173703')).toBe('/api/audio/a-lab/82111213e8173703.mp3');
  });
});

// ---------------------------------------------------------------------------------------------

describe('which clip should be sounding', () => {
  const tl = T.buildTimeline(COMIC, { audio: narration() });
  const [c0, c1] = tl.audio as [Clip, Clip];
  it('is the clip the clock is inside, and how far into it', () => {
    const w = A.audioWanted(tl.audio, c0.start + 0.5, { running: true, sound: true })!;
    expect(w.clip.key).toBe(c0.key);
    expect(w.offset).toBeCloseTo(0.5, 9);
    expect(A.audioWanted(tl.audio, c0.start - 0.01, { running: true, sound: true })).toBeNull();
    expect(A.audioWanted(tl.audio, c0.end, { running: true, sound: true })?.clip.key).not.toBe(c0.key); // the end is exclusive
    expect(A.audioWanted(tl.audio, (c0.end + c1.start) / 2, { running: true, sound: true })).toBeNull();
  });
  it('is nothing while the clock waits or the sound is off', () => {
    expect(A.audioWanted(tl.audio, c0.start + 0.5, { running: false, sound: true })).toBeNull();
    expect(A.audioWanted(tl.audio, c0.start + 0.5, { running: true, sound: false })).toBeNull();
  });
});

/** Drives the state machine like the player: `sync` at a clock time, tracking what would be playing. */
function player(clips: Clip[]) {
  let state = A.initialAudio();
  const playing = new Set<string>();
  const log: Array<{ at: number; cmd: Cmd }> = [];
  let peak = 0;
  let t = 0;
  const run = (event: Record<string, unknown>) => {
    // A clip that ended, or whose play() was refused or failed, is no longer sounding.
    if (['ended', 'rejected', 'errored'].includes(event.type as string)) playing.delete(event.key as string);
    const out = A.audioReduce(state, event);
    state = out.state;
    for (const cmd of out.commands) {
      log.push({ at: t, cmd });
      if (cmd.type === 'stop') playing.delete(cmd.key);
      else playing.add(cmd.key);
      peak = Math.max(peak, playing.size);
    }
    return out.commands;
  };
  const at = (time: number, o: { running?: boolean; sound?: boolean } = {}) => {
    t = time;
    return run({ type: 'sync', wanted: A.audioWanted(clips, time, { running: o.running ?? true, sound: o.sound ?? true }) });
  };
  return {
    at,
    run,
    playing,
    log,
    peak: () => peak,
    state: () => state,
    plays: () => log.filter((l) => l.cmd.type === 'play'),
    stops: () => log.filter((l) => l.cmd.type === 'stop'),
  };
}

describe('the audio state machine', () => {
  const tl = T.buildTimeline(COMIC, { audio: narration() });
  const clips = tl.audio;

  it('plays each clip once, when the clock reaches its start, and stops it when its time is up; never two at once', () => {
    const p = player(clips);
    for (let t = 0; t <= tl.total; t += 1 / 60) p.at(t);
    p.at(tl.total + 1);
    expect(p.plays().map((l) => l.cmd.key)).toEqual(clips.map((c) => c.key));
    for (const { at, cmd } of p.plays()) {
      const clip = clips.find((c) => c.key === cmd.key)!;
      expect(at).toBeGreaterThanOrEqual(clip.start);
      expect(at - clip.start).toBeLessThan(0.05);
      expect(cmd.offset).toBe(0); // a frame late starts from the top, not seeking into the clip
    }
    expect(p.stops()).toHaveLength(clips.length);
    expect(p.peak()).toBe(1);
    expect(p.playing.size).toBe(0);
  });

  it('stops the clip on Skip (the clock is finished, so nothing is wanted)', () => {
    const p = player(clips);
    const c = clips[1]!;
    p.at(c.start + 0.01);
    expect([...p.playing]).toEqual([c.key]);
    p.at(tl.total, { running: false }); // Skip: status done, not running
    expect(p.playing.size).toBe(0);
  });

  it('stops on Replay and plays the first clip again from the top, once the clock gets to it', () => {
    const p = player(clips);
    p.at(clips[2]!.start + 0.4);
    expect([...p.playing]).toEqual([clips[2]!.key]);
    p.at(0); // Replay: the clock is back at 0
    expect(p.playing.size).toBe(0);
    p.at(clips[0]!.start + 0.001);
    expect([...p.playing]).toEqual([clips[0]!.key]);
    expect(p.peak()).toBe(1);
  });

  it('on a seek stops the old clip and starts the new one at the offset', () => {
    const p = player(clips);
    p.at(clips[0]!.start + 0.5);
    const target = clips[3]!;
    p.at(target.start + 1.2);
    expect([...p.playing]).toEqual([target.key]);
    const last = p.plays().at(-1)!;
    expect(last.cmd.key).toBe(target.key);
    expect(last.cmd.offset).toBeCloseTo(1.2, 9);
    expect(p.peak()).toBe(1);
    // Seeking back into the same clip it is on changes nothing; seeking to silence stops it.
    p.at(target.start + 0.3);
    expect(p.plays()).toHaveLength(2);
    p.at(clips[0]!.start - 0.001);
    expect(p.playing.size).toBe(0);
  });

  it('waits with the clock (hidden tab, scrolled away) and picks the clip up again where the clock is', () => {
    const p = player(clips);
    const c = clips[1]!;
    p.at(c.start + 0.1);
    p.at(c.start + 0.1, { running: false });
    expect(p.playing.size).toBe(0);
    p.at(c.start + 0.1, { running: false });
    expect(p.stops()).toHaveLength(1); // stopped once, not on every frame
    p.at(c.start + 2);
    expect([...p.playing]).toEqual([c.key]);
    expect(p.plays().at(-1)!.cmd.offset).toBeCloseTo(2, 9);
  });

  it('stops on Sound off and starts again on Sound on, mid-clip', () => {
    const p = player(clips);
    const c = clips[0]!;
    p.at(c.start + 0.5);
    p.at(c.start + 0.6, { sound: false });
    expect(p.playing.size).toBe(0);
    p.at(c.start + 0.7, { sound: false });
    p.at(c.start + 0.8);
    expect([...p.playing]).toEqual([c.key]);
    expect(p.plays().at(-1)!.cmd.offset).toBeCloseTo(0.8, 9);
  });

  it('does not play a clip again after it ended by itself while the clock still has a moment of it', () => {
    const p = player(clips);
    const c = clips[0]!;
    p.at(c.start + 0.01);
    p.run({ type: 'ended', key: c.key });
    expect(p.state().current).toBeNull();
    p.at(c.end - 0.05);
    expect(p.plays()).toHaveLength(1);
    p.at(c.end + 0.01); // the clock has moved on
    p.at(clips[0]!.start + 0.01); // ...and a Replay gets it again
    expect(p.plays()).toHaveLength(2);
  });

  it('skips a clip that cannot load, in silence, and carries on with the next', () => {
    const p = player(clips);
    const [a, b] = clips as [Clip, Clip];
    p.at(a.start + 0.01);
    p.run({ type: 'errored', key: a.key });
    expect(p.state().failed).toEqual([a.key]);
    expect(p.state().blocked).toBe(false);
    p.at(a.start + 0.5); // still inside it: it is not tried again
    expect(p.plays()).toHaveLength(1);
    p.at(b.start + 0.01);
    expect([...p.playing]).toContain(b.key);
    // A play() that fails for any reason other than the browser wanting a tap is the same: skipped.
    const q = player(clips);
    q.at(a.start + 0.01);
    q.run({ type: 'rejected', key: a.key, name: 'NotSupportedError' });
    expect(q.state()).toMatchObject({ failed: [a.key], blocked: false, current: null });
  });

  it('blocks on NotAllowedError (the browser wants a tap), plays nothing more until a tap, then plays where the clock is', () => {
    const p = player(clips);
    const [a, b] = clips as [Clip, Clip];
    p.at(a.start + 0.01);
    p.run({ type: 'rejected', key: a.key, name: 'NotAllowedError' });
    expect(p.state()).toMatchObject({ blocked: true, current: null, failed: [] });
    p.at(a.start + 1);
    p.at(b.start + 0.01);
    expect(p.plays()).toHaveLength(1); // not retried on every frame
    p.run({ type: 'gesture' });
    expect(p.state().blocked).toBe(false);
    p.at(b.start + 1.5);
    expect(p.plays().at(-1)!.cmd).toMatchObject({ key: b.key });
    expect(p.plays().at(-1)!.cmd.offset).toBeCloseTo(1.5, 9);
  });

  it('ignores a refusal that arrives for a clip it has already stopped', () => {
    const p = player(clips);
    const [a, b] = clips as [Clip, Clip];
    p.at(a.start + 0.01);
    p.at(b.start + 0.01);
    p.run({ type: 'rejected', key: a.key, name: 'NotAllowedError' });
    expect(p.state().blocked).toBe(false);
    expect(p.state().current).toBe(b.key);
  });

  it('never has two clips playing, whatever order skip, replay, seek, hide and sound arrive in', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let round = 0; round < 40; round++) {
      const p = player(clips);
      let sound = true;
      let running = true;
      for (let step = 0; step < 120; step++) {
        const r = rand();
        if (r < 0.1) sound = !sound;
        else if (r < 0.2) running = !running;
        else if (r < 0.25) p.run({ type: 'gesture' });
        else if (r < 0.3 && p.state().current) p.run({ type: 'rejected', key: p.state().current, name: rand() < 0.5 ? 'NotAllowedError' : 'AbortError' });
        else if (r < 0.33 && p.state().current) p.run({ type: 'ended', key: p.state().current });
        p.at(rand() * tl.total, { running, sound });
        expect(p.playing.size).toBeLessThanOrEqual(1);
        expect([...p.playing]).toEqual(p.state().current ? [p.state().current] : []);
      }
      expect(p.peak()).toBeLessThanOrEqual(1);
    }
  });

  it('LATE_START is shorter than a clip gap, so a late frame never skips into the next clip', () => {
    expect(A.LATE_START).toBeLessThan(T.TIMING.breath);
  });
});

describe('the real comics and their real narration', () => {
  // The labs move to the voiceover contract one rewrite at a time: a comic with at least one voiceover must
  // schedule its committed narration without a mismatch; a comic that still has the old narration plays silent
  // (any old-shape line turns it off whole), exactly like a lab with none.
  it('schedules the committed narration of every lab whose comic has a voiceover, and plays an old one silent', async () => {
    const { existsSync, readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { parse } = await import('yaml');
    const { ComicSchema } = await import('../../src/labs/comic');
    const root = join(__dirname, '..', '..', 'labs');
    let voiced = 0;
    let silent = 0;
    for (const slug of readdirSync(root)) {
      const dir = join(root, slug, 'learn');
      if (!existsSync(join(dir, 'comic.yaml')) || !existsSync(join(dir, 'audio.json'))) continue;
      const comic = ComicSchema.parse(parse(readFileSync(join(dir, 'comic.yaml'), 'utf8')));
      const audio = JSON.parse(readFileSync(join(dir, 'audio.json'), 'utf8'));
      const cleaned = T.cleanComic(comic)!;
      const plain = T.buildTimeline(cleaned);
      const tl = T.buildTimeline(cleaned, { audio: { ...audio, slug } });
      if (allPanels(cleaned as Comic).some((p) => p.voiceover)) {
        voiced += 1;
        expect(tl.audio, slug).toHaveLength(audio.lines.length);
        expect(tl.total, slug).toBeGreaterThanOrEqual(plain.total);
        expect(tl.total, slug).toBeLessThan(300);
      } else {
        silent += 1;
        expect(tl, `${slug} (old narration plays silent)`).toEqual(plain);
      }
    }
    expect(voiced + silent).toBeGreaterThanOrEqual(6);
  });
});
