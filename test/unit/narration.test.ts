import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ACTIVE_CAST_IDS, CAST, LEGACY_NARRATOR_VOICE, NARRATOR_VOICE, RETIRED_CAST_IDS, TTS_MODEL, clipKey, legacyNarrationLines, narrationLines, usesVoiceover } from '../../src/labs/comic-kit';
import { AudioSchema, LearnBundleSchema, checkLearnBundle, type LearnBundle } from '../../src/labs/learn';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const panel = (p: Record<string, unknown>) => ({ scene: 'desk', cast: [], prop: 'none', bubbles: [], ...p }) as any;

describe('the storyteller is configured in one place', () => {
  it('has one female narrator voice, no voice for anybody in the cast, and the three retired people marked', () => {
    expect(TTS_MODEL).toBe('@cf/deepgram/aura-2-en');
    expect(NARRATOR_VOICE).toBe('thalia');
    expect(CAST.every((c) => !('voice' in c))).toBe(true);
    expect(ACTIVE_CAST_IDS).toEqual(['maren', 'tomasz', 'you']);
    expect(RETIRED_CAST_IDS).toEqual(['priya', 'jonas', 'anneke']);
    expect(CAST.map((c) => c.id)).toEqual(['maren', 'tomasz', 'priya', 'jonas', 'anneke', 'you']); // the art keeps every entry
  });
});

describe('narrationLines', () => {
  it('is the voiceover of each panel, in reading order, all in the narrator voice, counting panels across pages', () => {
    const comic = {
      pages: [
        { panels: [panel({ scene: 'duo', cast: ['maren', 'tomasz'], caption: 'Tuesday.', voiceover: 'It was a Tuesday.', bubbles: [{ who: 'maren', text: 'Which one?' }] })] },
        { panels: [panel({ scene: 'portrait', cast: ['maren'], voiceover: 'Maren looked up.' }), panel({ caption: 'Later.' }), panel({ voiceover: 'Then it got late.' })] },
      ],
    };
    expect(narrationLines(comic)).toEqual([
      { panel: 0, kind: 'voiceover', voice: 'thalia', text: 'It was a Tuesday.' },
      { panel: 1, kind: 'voiceover', voice: 'thalia', text: 'Maren looked up.' },
      { panel: 3, kind: 'voiceover', voice: 'thalia', text: 'Then it got late.' },
    ]);
  });

  it('skips a panel with no voiceover, and never speaks captions, bubbles (any speaker), screen lines or sound effects', () => {
    const lines = narrationLines({
      pages: [
        {
          panels: [
            panel({ scene: 'desk', cast: ['you', 'tomasz'], caption: 'A caption.', sfx: 'PING!', lines: ['$ send_calls.py', 'ready.'], bubbles: [{ who: 'you', text: 'I will look.' }, { who: 'tomasz', text: 'Good.' }, { text: 'Somebody said it.' }] }),
            panel({ scene: 'screen', lines: ['$ ls', 'a b c'] }),
          ],
        },
      ],
    });
    expect(lines).toEqual([]);
  });

  it('uses the narrator voice only, whoever the panel shows', () => {
    const lines = narrationLines({ pages: [{ panels: ['maren', 'tomasz', 'you', 'priya'].map((who) => panel({ cast: [who], voiceover: `Said about ${who}.` })) }] });
    expect(new Set(lines.map((l) => l.voice))).toEqual(new Set([NARRATOR_VOICE]));
  });

  it('knows whether a comic is written to the voiceover contract', () => {
    expect(usesVoiceover({ pages: [{ panels: [panel({ caption: 'x' })] }] })).toBe(false);
    expect(usesVoiceover({ pages: [{ panels: [panel({ caption: 'x' }), panel({ voiceover: 'Said.' })] }] })).toBe(true);
  });
});

describe('the old caption-and-bubble narration (kept only so live labs validate until they are rewritten)', () => {
  it('reads the caption first, then the bubbles in their speakers\' old voices, as it always did', () => {
    const comic = {
      pages: [
        { panels: [panel({ scene: 'duo', cast: ['jonas', 'maren'], caption: 'Tuesday.', bubbles: [{ who: 'jonas', text: 'Which one?' }, { who: 'maren', text: 'This one.' }] })] },
        { panels: [panel({ scene: 'portrait', cast: ['priya'], bubbles: [{ who: 'priya', text: 'Hi.' }, { text: 'Narrated.' }] }), panel({ cast: ['you'], bubbles: [{ who: 'you', text: 'Me.' }], caption: 'Later.' })] },
      ],
    };
    expect(LEGACY_NARRATOR_VOICE).toBe('atlas');
    expect(legacyNarrationLines(comic)).toEqual([
      { panel: 0, kind: 'caption', voice: 'atlas', text: 'Tuesday.' },
      { panel: 0, kind: 'bubble', bubble: 0, voice: 'arcas', text: 'Which one?' },
      { panel: 0, kind: 'bubble', bubble: 1, voice: 'thalia', text: 'This one.' },
      { panel: 1, kind: 'bubble', bubble: 0, voice: 'luna', text: 'Hi.' },
      { panel: 1, kind: 'bubble', bubble: 1, voice: 'atlas', text: 'Narrated.' },
      { panel: 2, kind: 'caption', voice: 'atlas', text: 'Later.' },
    ]);
  });
});

describe('clipKey', () => {
  it('is sixteen hex digits, stable, and changes with the model, the voice and the words', () => {
    const k = clipKey(TTS_MODEL, 'atlas', 'Your turn.', sha);
    expect(k).toMatch(/^[0-9a-f]{16}$/);
    expect(clipKey(TTS_MODEL, 'atlas', 'Your turn.', sha)).toBe(k);
    expect(clipKey(TTS_MODEL, 'luna', 'Your turn.', sha)).not.toBe(k);
    expect(clipKey(TTS_MODEL, 'atlas', 'Your turn!', sha)).not.toBe(k);
    expect(clipKey('@cf/other/model', 'atlas', 'Your turn.', sha)).not.toBe(k);
    // Pinned: the committed clips are named by this, so it must never drift.
    expect(k).toBe(sha(`${TTS_MODEL}\natlas\nYour turn.`).slice(0, 16));
    expect(k).toBe('14cf90c0da3739d0');
  });

  it('is the same file for the same words in the same voice, wherever they are spoken', () => {
    const comic = { pages: [{ panels: [panel({ voiceover: 'Your turn.' }), panel({ voiceover: 'Your turn.' })] }] };
    const keys = narrationLines(comic).map((l) => clipKey(TTS_MODEL, l.voice, l.text, sha));
    expect(keys[0]).toBe(keys[1]);
  });
});

// ---- the narration inside a learn bundle -----------------------------------------------------

const comic = {
  title: 'T',
  panels: [
    panel({ scene: 'desk', cast: ['maren'], caption: 'Tuesday.', voiceover: 'On Tuesday finance had a question.', bubbles: [{ who: 'maren', text: 'Which provider answered?' }], lines: ['x'] }),
    panel({ scene: 'portrait', cast: ['tomasz'], bubbles: [{ who: 'tomasz', text: 'Find out.' }] }),
    panel({ scene: 'screen', lines: ['$ run', 'ok'], caption: 'A copy.', voiceover: 'We made a small copy of it.' }),
    panel({ scene: 'you', caption: 'Your turn.', voiceover: 'Now it is your turn.', lines: ['$ go'] }),
  ],
};

function bundle(audio?: unknown, c: unknown = comic): any {
  return {
    version: 1,
    story: { title: 'S', minutes: 1, body: 'text' },
    comic: c,
    ...(audio ? { audio } : {}),
    concepts: [],
    questions: [],
    fields: [{ key: 'a', prompt: 'p', kind: 'text' }],
  };
}

function audioFor(c: { panels: unknown[] }): any {
  const lines = narrationLines({ pages: [{ panels: c.panels as any[] }] });
  const clips: Record<string, unknown> = {};
  const out = lines.map((l, i) => {
    const key = clipKey(TTS_MODEL, l.voice, l.text, sha);
    clips[key] = { voice: l.voice, text: l.text, seconds: 2 + i, bytes: 1000 + i };
    return { panel: l.panel, kind: l.kind, clip: key };
  });
  return { model: TTS_MODEL, clips, lines: out };
}

/** The old-shape narration of a comic: a clip per caption and per bubble, in the old voices. */
function legacyAudioFor(c: { panels: unknown[] }): any {
  const lines = legacyNarrationLines({ pages: [{ panels: c.panels as any[] }] });
  const clips: Record<string, unknown> = {};
  const out = lines.map((l, i) => {
    const key = clipKey(TTS_MODEL, l.voice, l.text, sha);
    clips[key] = { voice: l.voice, text: l.text, seconds: 2 + i, bytes: 1000 + i };
    return { panel: l.panel, kind: l.kind, ...(l.bubble !== undefined ? { bubble: l.bubble } : {}), clip: key };
  });
  return { model: TTS_MODEL, clips, lines: out };
}

/** Problems about the audio only (the toy comic has other, unrelated ones: it is short on panels). */
function audioProblems(b: unknown): string[] {
  const parsed = LearnBundleSchema.safeParse(b);
  if (!parsed.success) return parsed.error.issues.map((i) => i.message);
  return checkLearnBundle(parsed.data as LearnBundle).filter((p) => /audio|narrat/.test(p));
}

describe('learn.audio (the storyteller)', () => {
  it('accepts narration that matches the voiceovers word for word, one clip per voiced panel', () => {
    const a = audioFor(comic);
    expect(a.lines.map((l: any) => [l.panel, l.kind])).toEqual([[0, 'voiceover'], [2, 'voiceover'], [3, 'voiceover']]);
    expect(LearnBundleSchema.safeParse(bundle(a)).success).toBe(true);
    expect(audioProblems(bundle(a))).toEqual([]);
  });

  it('says to run labs narrate when a voiceover changed since', () => {
    const stale = bundle(audioFor(comic));
    stale.comic = { ...comic, panels: comic.panels.map((p, i) => (i === 2 ? panel({ ...p, voiceover: 'We made a bigger copy of it.' }) : p)) };
    expect(audioProblems(stale).join('\n')).toMatch(/audio\.json is out of date.*voiceover.*labs narrate/);
  });

  it('does not mind a changed caption or bubble: only the voiceover is spoken', () => {
    const b = bundle(audioFor(comic));
    b.comic = { ...comic, panels: comic.panels.map((p, i) => (i === 0 ? panel({ ...p, caption: 'Another label.', bubbles: [{ who: 'maren', text: 'Something new.' }] }) : p)) };
    expect(audioProblems(b)).toEqual([]);
  });

  it('notices a voice that is not the narrator\'s, a moved voiceover and a changed number of voiceovers', () => {
    const other = audioFor(comic);
    const k = other.lines[0].clip;
    other.clips[k].voice = 'atlas';
    expect(audioProblems(bundle(other)).join('\n')).toMatch(/voiceover or the narrator's voice changed/);

    const moved = bundle(audioFor(comic));
    moved.comic = { ...comic, panels: comic.panels.map((p, i) => (i === 2 ? panel({ ...p, voiceover: undefined }) : i === 1 ? panel({ ...p, voiceover: 'We made a small copy of it.' }) : p)) };
    expect(audioProblems(moved).join('\n')).toMatch(/is not where the comic has it/);

    const more = bundle(audioFor(comic));
    more.comic = { ...comic, panels: [...comic.panels, panel({ scene: 'message', cast: ['maren'], voiceover: 'One more thing.', bubbles: [{ who: 'maren', text: 'New.' }] })] };
    expect(audioProblems(more).join('\n')).toMatch(/the comic has 4 voiceovers, the narration 3/);
  });

  it('refuses old-shape audio (caption and bubble lines) for a comic that has a voiceover, and says to run labs narrate', () => {
    const old = legacyAudioFor(comic);
    expect(AudioSchema.safeParse(old).success).toBe(true); // still parses; the cross-check is what refuses it
    expect(audioProblems(bundle(old)).join('\n')).toMatch(/out of date.*old caption-and-bubble format.*labs narrate/);
  });

  it('is refused without a comic, with a line naming a missing clip, with an unused clip, or a voiceover numbered like a bubble', () => {
    const noComic = bundle(audioFor(comic));
    delete noComic.comic;
    expect(audioProblems(noComic).join('\n')).toMatch(/no comic\.yaml/);

    const a = audioFor(comic);
    a.lines[0].clip = 'ffffffffffffffff';
    expect(AudioSchema.safeParse(a).success).toBe(false);

    const b = audioFor(comic);
    b.clips['0000000000000000'] = { voice: 'thalia', text: 'x', seconds: 1, bytes: 10 };
    expect(AudioSchema.safeParse(b).success).toBe(false);

    const c = audioFor(comic);
    c.lines[0].bubble = 0;
    expect(AudioSchema.safeParse(c).success).toBe(false);
  });

  it('limits what a clip may claim: key shape, size, length, text up to 240 characters and at most 80 clips', () => {
    const base = audioFor(comic);
    const key = Object.keys(base.clips)[0]!;
    const withClip = (patch: Record<string, unknown>) => ({ ...base, clips: { ...base.clips, [key]: { ...base.clips[key], ...patch } } });
    expect(AudioSchema.safeParse(withClip({ bytes: 400 * 1024 + 1 })).success).toBe(false);
    expect(AudioSchema.safeParse(withClip({ seconds: 0 })).success).toBe(false);
    expect(AudioSchema.safeParse(withClip({ voice: 'THALIA; drop' })).success).toBe(false);
    expect(AudioSchema.safeParse(withClip({ text: 'a'.repeat(240) })).success).toBe(true);
    expect(AudioSchema.safeParse(withClip({ text: 'a'.repeat(241) })).success).toBe(false);
    expect(AudioSchema.safeParse({ ...base, clips: { 'not-a-key': base.clips[key], ...base.clips } }).success).toBe(false);
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 81; i++) many[i.toString(16).padStart(16, '0')] = { voice: 'thalia', text: 't', seconds: 1, bytes: 10 };
    expect(AudioSchema.safeParse({ model: TTS_MODEL, clips: many, lines: [] }).success).toBe(false);
  });
});

describe('an old comic keeps validating with its own old narration (nothing live breaks before the rewrite)', () => {
  const oldComic = {
    title: 'T',
    panels: [
      panel({ scene: 'desk', cast: ['jonas'], caption: 'Tuesday.', bubbles: [{ who: 'jonas', text: 'Which provider answered?' }], lines: ['x'] }),
      panel({ scene: 'portrait', cast: ['maren'], bubbles: [{ who: 'maren', text: 'Find out.' }] }),
      panel({ scene: 'screen', lines: ['$ run', 'ok'], caption: 'A copy.' }),
      panel({ scene: 'you', caption: 'Your turn.', lines: ['$ go'] }),
    ],
  };

  it('accepts the matching old narration', () => {
    expect(audioProblems(bundle(legacyAudioFor(oldComic), oldComic))).toEqual([]);
    expect(checkLearnBundle(LearnBundleSchema.parse(bundle(legacyAudioFor(oldComic), oldComic)) as LearnBundle).join()).not.toMatch(/retired/);
  });

  it('still says to run labs narrate when the old comic changed, or the narration does not fit', () => {
    const stale = bundle(legacyAudioFor(oldComic), oldComic);
    stale.comic = { ...oldComic, panels: oldComic.panels.map((p, i) => (i === 1 ? panel({ ...p, bubbles: [{ who: 'maren', text: 'Find out why.' }] }) : p)) };
    expect(audioProblems(stale).join('\n')).toMatch(/audio\.json is out of date.*labs narrate/);
    const swapped = bundle(legacyAudioFor(oldComic), oldComic);
    swapped.comic = { ...oldComic, panels: oldComic.panels.map((p, i) => (i === 1 ? panel({ ...p, cast: ['priya'], bubbles: [{ who: 'priya', text: 'Find out.' }] }) : p)) };
    expect(audioProblems(swapped).join('\n')).toMatch(/out of date/);
    const more = bundle(legacyAudioFor(oldComic), oldComic);
    more.comic = { ...oldComic, panels: [...oldComic.panels, panel({ scene: 'message', cast: ['maren'], bubbles: [{ who: 'maren', text: 'New.' }] })] };
    expect(audioProblems(more).join('\n')).toMatch(/spoken lines/);
  });

  it('refuses new-shape audio on an old comic (nothing to speak there)', () => {
    expect(audioProblems(bundle(audioFor(comic), oldComic)).join('\n')).toMatch(/out of date/);
  });
});
