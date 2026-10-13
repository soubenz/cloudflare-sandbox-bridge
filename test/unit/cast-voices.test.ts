import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ACTIVE_CAST_IDS, NARRATOR_ID, SPEAKING_CAST_IDS, isSpokenBubble, spokenLines } from '../../src/labs/comic-kit';
import { ComicSchema, checkComic } from '../../src/labs/comic';
import { AudioSchema, LearnBundleSchema, checkLearnBundle, parseLearnBundle, type LearnBundle } from '../../src/labs/learn';
import { VOICE_CAST, VoiceCastSchema, voiceNameOf, voicesOf } from '../../src/labs/voices';
import { CAST_COMIC, CAST_VOICES, CLOSING, bundleOf, castNarrationOf, narrationOf, oldShapeNarrationOf, type FixtureAudio } from '../e2e/comic-fixture';

/**
 * The characters speak their bubbles: the voice cast (packages/catalogue/voices.json), what is spoken
 * (comic-kit spokenLines), the narration index with per-clip `who` (src/labs/learn.ts AudioSchema) and the
 * integrity rule `labs learn-check` holds it to (a comic is never half voiced).
 */

const panel = (p: Record<string, unknown>) => ({ scene: 'desk', cast: [], prop: 'none', bubbles: [], ...p }) as any;
const check = (audio: FixtureAudio, comic = CAST_COMIC) => checkLearnBundle(LearnBundleSchema.parse(bundleOf(comic, audio)) as LearnBundle).join('\n');

describe('the voice cast (packages/catalogue/voices.json)', () => {
  it('gives the narrator and every speaking person their own voice of one model; the learner has none', () => {
    const raw = JSON.parse(readFileSync('packages/catalogue/voices.json', 'utf8'));
    expect(VoiceCastSchema.parse(raw)).toEqual(VOICE_CAST);
    expect(VOICE_CAST.model).toBe('higgsfield/elevenlabs');
    expect(VOICE_CAST.narrator).toEqual({ name: 'Mark', voice: '27c04473-84a9-4b60-a41f-c8e8458bd4f1' });
    expect(Object.keys(VOICE_CAST.cast).sort()).toEqual([...SPEAKING_CAST_IDS].sort());
    expect(SPEAKING_CAST_IDS).toEqual(['maren', 'tomasz', 'graham', 'ollie', 'jess', 'priya']);
    expect(ACTIVE_CAST_IDS).toContain('you');
    expect(SPEAKING_CAST_IDS).not.toContain('you');
    expect(voicesOf()).toEqual(CAST_VOICES);
    expect(new Set(Object.values(voicesOf())).size).toBe(7);
    expect(voiceNameOf('narrator')).toBe('Mark');
    expect(voiceNameOf('graham')).toBe('Sterling');
    expect(voiceNameOf('you')).toBeUndefined();
  });

  it('refuses a cast with someone missing, someone unknown, the learner, or two people sharing a voice', () => {
    const base = structuredClone(VOICE_CAST);
    const without = structuredClone(base);
    delete (without.cast as Record<string, unknown>).jess;
    expect(() => VoiceCastSchema.parse(without)).toThrow(/jess has no voice/);
    expect(() => VoiceCastSchema.parse({ ...base, cast: { ...base.cast, you: { name: 'X', voice: 'x1' } } })).toThrow(/you is not of the speaking cast/);
    expect(() => VoiceCastSchema.parse({ ...base, cast: { ...base.cast, jonas: { name: 'X', voice: 'x1' } } })).toThrow(/jonas is not of the speaking cast/);
    expect(() => VoiceCastSchema.parse({ ...base, cast: { ...base.cast, ollie: base.cast.maren } })).toThrow(/two speakers share a voice/);
    expect(() => VoiceCastSchema.parse({ ...base, narrator: { name: 'Mark', voice: 'has space' } })).toThrow();
  });
});

describe('spokenLines: who speaks what, in playing order', () => {
  it('per panel the voiceover first, then each bubble of a speaking person in order; the learner, nobody and the retired stay text', () => {
    const comic = {
      pages: [
        { panels: [panel({ voiceover: 'It was a Monday.', bubbles: [{ who: 'graham', text: 'Who signed this?' }, { who: 'you', text: 'Not me.' }] })] },
        { panels: [panel({ bubbles: [{ text: 'Somebody.' }, { who: 'jess', text: 'Ship it!' }] }), panel({ voiceover: 'Later.', bubbles: [{ who: 'jonas', text: 'Old.' }, { who: 'priya', text: 'Be kind.' }] })] },
      ],
    };
    expect(spokenLines(comic)).toEqual([
      { panel: 0, kind: 'voiceover', who: 'narrator', text: 'It was a Monday.' },
      { panel: 0, kind: 'bubble', bubble: 0, who: 'graham', text: 'Who signed this?' },
      { panel: 1, kind: 'bubble', bubble: 1, who: 'jess', text: 'Ship it!' },
      { panel: 2, kind: 'voiceover', who: 'narrator', text: 'Later.' },
      { panel: 2, kind: 'bubble', bubble: 1, who: 'priya', text: 'Be kind.' },
    ]);
    expect(NARRATOR_ID).toBe('narrator');
    expect(isSpokenBubble({ who: 'ollie' })).toBe(true);
    for (const who of ['you', 'jonas', 'anneke', undefined]) expect(isSpokenBubble({ who }), String(who)).toBe(false);
  });

  it('the cast fixture is a valid comic of the new people, with nine spoken lines', () => {
    expect(checkComic(ComicSchema.parse(CAST_COMIC))).toEqual([]);
    const lines = spokenLines(CAST_COMIC as never);
    expect(lines.map((l) => l.who)).toEqual(['narrator', 'graham', 'narrator', 'ollie', 'jess', 'narrator', 'priya', 'narrator', 'maren', 'narrator']);
  });
});

describe('the narration index with the cast\'s voices', () => {
  it('lets a clip say who speaks it (narrator or a speaking person) and needs a bubble number on a bubble line', () => {
    const audio = castNarrationOf(CAST_COMIC);
    const parsed = AudioSchema.parse(audio);
    expect(Object.values(parsed.clips).map((c) => c.who)).toEqual(['narrator', 'graham', 'narrator', 'ollie', 'jess', 'narrator', 'priya', 'narrator', 'maren', 'narrator']);
    expect(parsed.lines.filter((l) => l.kind === 'bubble').map((l) => [l.panel, l.bubble])).toEqual([[0, 0], [1, 0], [1, 1], [2, 0], [3, 0]]);
    const bad = (who: string) => {
      const a = structuredClone(audio);
      Object.values(a.clips)[1]!.who = who;
      return a;
    };
    for (const who of ['you', 'jonas', 'somebody']) expect(() => AudioSchema.parse(bad(who)), who).toThrow();
    const noNumber = structuredClone(audio);
    delete noNumber.lines[1]!.bubble;
    expect(() => AudioSchema.parse(noNumber)).toThrow(/is a bubble and needs its bubble number/);
    // the single-voice shape (no `who`) still parses
    expect(() => AudioSchema.parse(narrationOf(CAST_COMIC))).not.toThrow();
  });
});

describe('learn-check: the characters speak their bubbles, all of them or none', () => {
  it('accepts a narration that voices every bubble of a speaking person in their own voice', () => {
    expect(check(castNarrationOf(CAST_COMIC))).toBe('');
    expect(() => parseLearnBundle(bundleOf(CAST_COMIC, castNarrationOf(CAST_COMIC)))).not.toThrow();
  });

  it('still accepts a narration of the voiceovers alone (no bubble clips): the bubbles are text, as before', () => {
    expect(check(narrationOf(CAST_COMIC))).toBe('');
  });

  it('fails a narration that voices some bubbles but not all, naming the panel and the bubble', () => {
    const partly = castNarrationOf(CAST_COMIC);
    const i = partly.lines.findIndex((l) => l.kind === 'bubble' && l.panel === 1 && l.bubble === 1);
    const [gone] = partly.lines.splice(i, 1);
    delete partly.clips[gone!.clip];
    expect(check(partly)).toBe(
      'learn/audio.json voices some bubbles but not panel 2 bubble 2 of comic.yaml (Jess: "Can we still ship on Friday?"): once one bubble is spoken every bubble of maren, tomasz, graham, ollie, jess, priya must be; import its clip with `labs narrate --from-dir`'
    );
    // and a comic edited to add a speaking bubble after the narration was made
    const added = structuredClone(CAST_COMIC);
    added.pages[0]!.panels[2]!.cast = ['priya', 'graham'];
    added.pages[0]!.panels[2]!.scene = 'duo';
    added.pages[0]!.panels[2]!.bubbles.push({ who: 'graham', text: 'Agreed.' });
    expect(check(castNarrationOf(CAST_COMIC), added)).toMatch(/voices some bubbles but not panel 3 bubble 2 of comic\.yaml \(Graham: "Agreed\."\)/);
  });

  it('calls it out of date when a bubble\'s words or speaker changed, a clip is in the narrator\'s voice, or one person has two voices', () => {
    const words = structuredClone(CAST_COMIC);
    words.pages[0]!.panels[0]!.bubbles[0]!.text = 'Who approved this?';
    expect(check(castNarrationOf(CAST_COMIC), words)).toMatch(/learn\/audio\.json is out of date with comic\.yaml \(panel 1 bubble 1: the bubble's words or its speaker changed\)/);

    const speaker = castNarrationOf(CAST_COMIC);
    const ollie = speaker.lines.find((l) => l.kind === 'bubble' && l.panel === 1 && l.bubble === 0)!;
    speaker.clips[ollie.clip]!.who = 'tomasz';
    expect(check(speaker)).toMatch(/panel 2 bubble 1: the bubble's words or its speaker changed/);

    const narrated = castNarrationOf(CAST_COMIC);
    const graham = narrated.lines.find((l) => l.kind === 'bubble' && l.panel === 0)!;
    narrated.clips[graham.clip]!.voice = CAST_VOICES.narrator!;
    expect(check(narrated)).toMatch(/panel 1 bubble 1: Graham speaks in the narrator's voice/);

    const twoVoices = structuredClone(CAST_COMIC);
    twoVoices.pages[0]!.panels[3]!.bubbles = [{ who: 'maren', text: 'Have a look at the log.' }, { who: 'you', text: 'On it.' }];
    twoVoices.pages[0]!.panels[0]!.cast = ['maren'];
    twoVoices.pages[0]!.panels[0]!.bubbles = [{ who: 'maren', text: 'Who signed off on this?' }];
    const a = castNarrationOf(twoVoices);
    const first = a.lines.find((l) => l.kind === 'bubble' && l.panel === 0)!;
    a.clips[first.clip]!.voice = 'another-voice';
    expect(check(a, twoVoices)).toMatch(/panel 4 bubble 1: Maren speaks in two voices \(another-voice and 3c2b83c0/);
  });

  it('a narrator clip marked as somebody else is the narrator\'s voice changed; old-shape bubble lines (no who) are still refused', () => {
    const a = castNarrationOf(CAST_COMIC);
    a.clips[a.lines[0]!.clip]!.who = 'maren';
    expect(check(a)).toMatch(/panel 1: the voiceover or the narrator's voice changed/);
    expect(check(oldShapeNarrationOf(CAST_COMIC))).toMatch(/it is in the old caption-and-bubble format/);
  });

  it('holds a closing narration to the same rule', () => {
    const closing = structuredClone(CLOSING);
    closing.pages[0]!.panels[1]!.bubbles = [{ who: 'tomasz', text: 'It moved.' }];
    const bundle = { ...bundleOf(CAST_COMIC, castNarrationOf(CAST_COMIC)), fields: [], closing: { story: { title: 'Friday', minutes: 1, body: 'By Friday.' }, comic: closing, audio: castNarrationOf(closing) } };
    expect(checkLearnBundle(LearnBundleSchema.parse(bundle) as LearnBundle)).toEqual([]);
    const partly = castNarrationOf(closing);
    partly.lines = partly.lines.filter((l) => !(l.kind === 'bubble' && l.panel === 0));
    partly.clips = Object.fromEntries(Object.entries(partly.clips).filter(([k]) => partly.lines.some((l) => l.clip === k)));
    const bad = { ...bundle, closing: { ...bundle.closing, audio: partly } };
    expect(checkLearnBundle(LearnBundleSchema.parse(bad) as LearnBundle).join('\n')).toMatch(/learn\/closing-audio\.json voices some bubbles but not panel 1 bubble 1 of closing\.yaml \(Maren: "So that was it\."\)/);
  });
});
