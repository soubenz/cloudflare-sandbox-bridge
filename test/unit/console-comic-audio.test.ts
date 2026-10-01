import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { TTS_MODEL, clipKey, narrationLines, panelSeconds } from '../../src/labs/comic-kit';

/**
 * The comic's voices as logic with no browser: the timeline when the lab is narrated (every line's start
 * and end from its clip, typing spread over the clip, panels as long as the voice needs, no change at all
 * without audio) and the scheduling state machine (dashboard/src/comic-audio.js) that turns the one clock
 * into play and stop. The player that runs it, with real Audio elements, is test/e2e/18-comic.spec.ts.
 */
type Panel = { scene: string; cast: string[]; bg?: string; prop: string; caption?: string; bubbles: Array<{ who?: string; text: string; pos?: string }>; sfx?: string; lines?: string[] };
type Comic = { title: string; pages: Array<{ title?: string; panels: Panel[] }> };
type Clip = { key: string; kind: 'caption' | 'bubble'; bubble: number | null; panel: number; start: number; end: number; seconds: number };
type TBubble = { start: number; end: number; step: number; wordTimes: number[] };
type TPanel = { start: number; end: number; dur: number; captionAt: number | null; bubbles: TBubble[]; lines: Array<{ start: number; end: number }> };
type Timeline = { total: number; pages: Array<{ index: number; start: number; panels: TPanel[] }>; audio: Clip[] };
type AudioIn = { slug: string; clips: Record<string, { seconds: number; text: string; voice?: string }>; lines: Array<{ panel: number; kind: string; bubble?: number; clip: string }> };
type AState = { current: string | null; blocked: boolean; finished: string | null; failed: string[] };
type Cmd = { type: 'play' | 'stop'; key: string; offset?: number };
type Wanted = { clip: Clip; offset: number } | null;

const T = (await import('../../dashboard/src/comic-timeline.js' as string)) as {
  TIMING: { content: number; bubblePop: number; hold: number; word: number };
  VOICE_GAP: number;
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
        panel({ scene: 'desk', cast: ['jonas'], caption: 'Tuesday, a little after ten.', bubbles: [{ who: 'jonas', text: 'Which provider answered, and what did that one reply cost?' }], lines: ['$ one', 'two'] }),
        panel({ scene: 'duo', cast: ['priya', 'anneke'], bubbles: [{ who: 'priya', text: 'One two three four five.' }, { who: 'anneke', text: 'Six seven eight nine ten eleven.' }] }),
        panel({ scene: 'screen', cast: [], bubbles: [], lines: ['$ run it', '200 ok'] }), // nothing spoken
        panel({ scene: 'you', cast: [], bubbles: [], caption: 'Your turn.', lines: ['$ go', 'ready.'] }),
      ],
    },
    { title: 'Later', panels: [panel({ bubbles: [{ text: 'Somebody said it.' }] }), panel()] },
  ],
};

/** The narration a CLI run would write, with each clip given a length of 2 s plus a fifth of its characters per ten. */
function narration(comic: Comic = COMIC, secondsOf = (text: string) => 1.5 + text.length / 12): AudioIn {
  const clips: AudioIn['clips'] = {};
  const lines = narrationLines(comic as any).map((l) => {
    const clip = clipKey(TTS_MODEL, l.voice, l.text, sha);
    clips[clip] = { seconds: secondsOf(l.text), text: l.text, voice: l.voice };
    return { panel: l.panel, kind: l.kind, ...(l.bubble !== undefined ? { bubble: l.bubble } : {}), clip };
  });
  return { slug: 'a-lab', clips, lines };
}

const panelsOf = (tl: Timeline) => tl.pages.flatMap((p) => p.panels);

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

  it('keeps every panel at its reading time', () => {
    panelsOf(plain).forEach((p, i) => expect(p.dur).toBe(panelSeconds(T.panelWords(COMIC.pages.flatMap((g) => g.panels)[i]!))));
  });

  it('turns the narration off whole when any line does not match the comic (a voice never says other words)', () => {
    const a = narration();
    const wrongText = structuredClone(a);
    wrongText.clips[wrongText.lines[1]!.clip]!.text = 'Some other words entirely.';
    expect(T.buildTimeline(COMIC, { audio: wrongText })).toEqual(plain);
    const missingPanel = structuredClone(a);
    missingPanel.lines.push({ panel: 99, kind: 'caption', clip: a.lines[0]!.clip });
    expect(T.buildTimeline(COMIC, { audio: missingPanel })).toEqual(plain);
    const missingBubble = structuredClone(a);
    missingBubble.lines.push({ panel: 0, kind: 'bubble', bubble: 1, clip: a.lines[1]!.clip });
    expect(T.buildTimeline(COMIC, { audio: missingBubble })).toEqual(plain);
    const twice = structuredClone(a);
    twice.lines.push(a.lines[0]!);
    expect(T.buildTimeline(COMIC, { audio: twice })).toEqual(plain);
  });
});

describe('with narration the voice sets the pace', () => {
  const audio = narration();
  const tl = T.buildTimeline(COMIC, { audio });
  const plain = T.buildTimeline(COMIC);
  const secondsOf = (key: string) => audio.clips[key]!.seconds;

  it('lists every clip once, in time order, none overlapping, one gap apart within a panel', () => {
    expect(tl.audio).toHaveLength(audio.lines.length);
    expect(tl.audio.map((c) => c.key).sort()).toEqual(audio.lines.map((l) => l.clip).sort());
    for (let i = 1; i < tl.audio.length; i++) expect(tl.audio[i]!.start).toBeGreaterThanOrEqual(tl.audio[i - 1]!.end - 1e-9);
    for (const c of tl.audio) expect(c.end - c.start).toBeCloseTo(secondsOf(c.key), 9);
    const first = tl.audio.filter((c) => c.panel === 2); // panel number 2: the duo
    expect(first).toHaveLength(2);
    expect(first[1]!.start - first[0]!.end).toBeCloseTo(T.VOICE_GAP, 9);
  });

  it('starts the caption clip when the caption appears, and the bubbles after it', () => {
    const p0 = panelsOf(tl)[0]!;
    const [cap, bub] = tl.audio.filter((c) => c.panel === 1);
    expect(cap!.kind).toBe('caption');
    expect(cap!.start).toBeCloseTo(p0.captionAt!, 9);
    expect(bub!.kind).toBe('bubble');
    expect(bub!.start).toBeCloseTo(cap!.end + T.VOICE_GAP, 9);
    // The bubble pops as its voice starts and is done when the voice is.
    expect(p0.bubbles[0]!.start).toBeCloseTo(bub!.start - T.TIMING.bubblePop, 9);
    expect(p0.bubbles[0]!.end).toBeCloseTo(bub!.end, 9);
  });

  it('starts a panel with no caption on its first bubble, after the usual beat', () => {
    const p = panelsOf(tl)[4]!; // "Somebody said it."
    const clip = tl.audio.find((c) => c.panel === 5)!;
    expect(clip.start).toBeCloseTo(p.start + T.TIMING.content + T.TIMING.bubblePop, 9);
  });

  it('types the words across the clip, longer words taking longer, finishing before the voice does', () => {
    const p1 = panelsOf(tl)[1]!;
    const b = p1.bubbles[1]!; // "Six seven eight nine ten eleven."
    const clip = tl.audio.find((c) => c.panel === 2 && c.bubble === 1)!;
    const words = 'Six seven eight nine ten eleven.'.split(' ');
    expect(b.wordTimes).toHaveLength(words.length);
    expect(b.wordTimes[0]).toBeCloseTo(clip.start, 9);
    expect(b.wordTimes.every((t, i) => i === 0 || t > b.wordTimes[i - 1]!)).toBe(true);
    expect(b.wordTimes[words.length - 1]!).toBeLessThan(clip.end);
    const total = words.reduce((n, w) => n + w.length + 1, 0);
    words.forEach((w, i) => {
      const next = i + 1 < words.length ? b.wordTimes[i + 1]! : clip.end;
      expect(next - b.wordTimes[i]!).toBeCloseTo(((w.length + 1) / total) * (clip.end - clip.start), 9);
    });
  });

  it('shows the speaker as speaking while their clip plays', () => {
    const p1 = panelsOf(tl)[1]!;
    const first = tl.audio.find((c) => c.panel === 2 && c.bubble === 0)!;
    const second = tl.audio.find((c) => c.panel === 2 && c.bubble === 1)!;
    const mid = (c: Clip) => (c.start + c.end) / 2;
    expect(T.panelState(p1, mid(first)).bubbles.map((b) => b.speaking)).toEqual([true, false]);
    expect(T.panelState(p1, mid(second)).bubbles.map((b) => b.speaking)).toEqual([false, true]);
    expect(T.panelState(p1, mid(second)).bubbles[0]!.words).toBe(5); // the first has typed out fully by then
  });

  it('keeps each panel on screen until its last clip is done plus the usual hold, never shorter than reading takes', () => {
    panelsOf(tl).forEach((p, i) => {
      const clips = tl.audio.filter((c) => c.panel === i + 1);
      const reading = panelsOf(plain)[i]!.dur;
      if (clips.length === 0) {
        expect(p.dur).toBe(reading);
        return;
      }
      const lastEnd = Math.max(...clips.map((c) => c.end));
      expect(p.dur).toBeCloseTo(Math.max(reading, lastEnd - p.start + T.TIMING.hold), 9);
      expect(p.end).toBeGreaterThanOrEqual(lastEnd + T.TIMING.hold - 1e-9);
    });
    expect(tl.total).toBeGreaterThan(plain.total);
  });

  it('leaves a panel with nothing spoken exactly as it was', () => {
    const screen = panelsOf(tl)[2]!;
    expect(screen.dur).toBe(panelsOf(plain)[2]!.dur);
    expect(tl.audio.some((c) => c.panel === 3)).toBe(false);
  });

  it('keeps a long clip from being cut off, and a short one from shortening a panel', () => {
    const long = T.buildTimeline(COMIC, { audio: narration(COMIC, () => 30) });
    for (const c of long.audio) expect(long.pages.flatMap((p) => p.panels)[c.panel - 1]!.end).toBeGreaterThan(c.end);
    const tiny = T.buildTimeline(COMIC, { audio: narration(COMIC, () => 0.2) });
    tiny.pages.flatMap((p) => p.panels).forEach((p, i) => expect(p.dur).toBeGreaterThanOrEqual(panelsOf(plain)[i]!.dur));
  });

  it('types a bubble that has no clip (the learner\'s) at the usual pace in its turn', () => {
    const comic: Comic = { title: 't', pages: [{ panels: [panel({ scene: 'desk', cast: ['you', 'tomasz'], bubbles: [{ who: 'tomasz', text: 'Good luck.' }, { who: 'you', text: 'I will look now.' }], lines: ['x'] })] }] };
    const out = T.buildTimeline(comic, { audio: narration(comic) });
    const [said, mine] = panelsOf(out)[0]!.bubbles;
    expect(out.audio).toHaveLength(1);
    expect(mine!.start).toBeGreaterThan(said!.end);
    expect(mine!.wordTimes[1]! - mine!.wordTimes[0]!).toBeCloseTo(T.TIMING.word, 9);
  });
});

describe('cleanAudio', () => {
  const good = narration();
  it('keeps a well-formed narration and drops what cannot be trusted', () => {
    const c = T.cleanAudio(good)!;
    expect(c.slug).toBe('a-lab');
    expect(c.lines).toHaveLength(good.lines.length);
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
    expect(A.audioWanted(tl.audio, (c0.end + c1.start) / 2 - 1e-9 + (c1.start - c0.end) / 2 - 1e-6, { running: true, sound: true })).toBeNull();
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
    expect(A.LATE_START).toBeLessThan(T.VOICE_GAP);
  });
});

describe('the real comic and its real narration', () => {
  it('schedules the committed narration of see-what-a-gateway-does without a mismatch', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { parse } = await import('yaml');
    const { ComicSchema } = await import('../../src/labs/comic');
    const dir = join(__dirname, '..', '..', 'labs', 'see-what-a-gateway-does', 'learn');
    const comic = ComicSchema.parse(parse(readFileSync(join(dir, 'comic.yaml'), 'utf8')));
    const audio = JSON.parse(readFileSync(join(dir, 'audio.json'), 'utf8'));
    const cleaned = T.cleanComic(comic)!;
    const tl = T.buildTimeline(cleaned, { audio: { ...audio, slug: 'see-what-a-gateway-does' } });
    expect(tl.audio).toHaveLength(audio.lines.length);
    expect(tl.audio.length).toBeGreaterThanOrEqual(6);
    const plain = T.buildTimeline(cleaned);
    expect(tl.total).toBeGreaterThanOrEqual(plain.total);
  });
});
