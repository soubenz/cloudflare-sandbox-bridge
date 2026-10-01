import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CAST, NARRATOR_VOICE, TTS_MODEL, clipKey, narrationLines } from '../../src/labs/comic-kit';
import { AudioSchema, LearnBundleSchema, checkLearnBundle, type LearnBundle } from '../../src/labs/learn';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const panel = (p: Record<string, unknown>) => ({ scene: 'desk', cast: [], prop: 'none', bubbles: [], ...p }) as any;

describe('the voices are configured in one place', () => {
  it('gives every person but the learner a voice, the narrator one, and no two the same', () => {
    expect(TTS_MODEL).toBe('@cf/deepgram/aura-2-en');
    expect(NARRATOR_VOICE).toBe('atlas');
    const byId = Object.fromEntries(CAST.map((c) => [c.id, c.voice]));
    expect(byId).toEqual({ maren: 'thalia', tomasz: 'orion', priya: 'luna', jonas: 'arcas', anneke: 'andromeda', you: undefined });
    const voices = [NARRATOR_VOICE, ...CAST.map((c) => c.voice).filter(Boolean)];
    expect(new Set(voices).size).toBe(voices.length);
  });
});

describe('narrationLines', () => {
  it('reads the caption first, then the bubbles in order, per panel, counting panels across pages', () => {
    const comic = {
      pages: [
        { panels: [panel({ scene: 'duo', cast: ['jonas', 'maren'], caption: 'Tuesday.', bubbles: [{ who: 'jonas', text: 'Which one?' }, { who: 'maren', text: 'This one.' }] })] },
        { panels: [panel({ scene: 'portrait', cast: ['priya'], bubbles: [{ who: 'priya', text: 'Hi.' }] }), panel({ caption: 'Later.' })] },
      ],
    };
    expect(narrationLines(comic)).toEqual([
      { panel: 0, kind: 'caption', voice: 'atlas', text: 'Tuesday.' },
      { panel: 0, kind: 'bubble', bubble: 0, voice: 'arcas', text: 'Which one?' },
      { panel: 0, kind: 'bubble', bubble: 1, voice: 'thalia', text: 'This one.' },
      { panel: 1, kind: 'bubble', bubble: 0, voice: 'luna', text: 'Hi.' },
      { panel: 2, kind: 'caption', voice: 'atlas', text: 'Later.' },
    ]);
  });

  it('gives a bubble with no speaker to the narrator', () => {
    const lines = narrationLines({ pages: [{ panels: [panel({ bubbles: [{ text: 'Somebody said it.' }] })] }] });
    expect(lines).toEqual([{ panel: 0, kind: 'bubble', bubble: 0, voice: NARRATOR_VOICE, text: 'Somebody said it.' }]);
  });

  it('never speaks the learner, screen lines or sound effects, and keeps bubble numbers', () => {
    const lines = narrationLines({
      pages: [
        {
          panels: [
            panel({
              scene: 'desk',
              cast: ['you', 'tomasz'],
              sfx: 'PING!',
              lines: ['$ send_calls.py', 'ready.'],
              bubbles: [{ who: 'you', text: 'I will look.' }, { who: 'tomasz', text: 'Good.' }],
            }),
            panel({ scene: 'screen', lines: ['$ ls', 'a b c'] }),
          ],
        },
      ],
    });
    expect(lines).toEqual([{ panel: 0, kind: 'bubble', bubble: 1, voice: 'orion', text: 'Good.' }]);
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
    const comic = { pages: [{ panels: [panel({ caption: 'Your turn.' }), panel({ caption: 'Your turn.' })] }] };
    const keys = narrationLines(comic).map((l) => clipKey(TTS_MODEL, l.voice, l.text, sha));
    expect(keys[0]).toBe(keys[1]);
  });
});

// ---- the narration inside a learn bundle -----------------------------------------------------

const comic = {
  title: 'T',
  panels: [
    panel({ scene: 'desk', cast: ['jonas'], caption: 'Tuesday.', bubbles: [{ who: 'jonas', text: 'Which provider answered?' }], lines: ['x'] }),
    panel({ scene: 'portrait', cast: ['maren'], bubbles: [{ who: 'maren', text: 'Find out.' }] }),
    panel({ scene: 'screen', lines: ['$ run', 'ok'], caption: 'A copy.' }),
    panel({ scene: 'you', caption: 'Your turn.', lines: ['$ go'] }),
  ],
};

function bundle(audio?: unknown): any {
  return {
    version: 1,
    story: { title: 'S', minutes: 1, body: 'text' },
    comic,
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

describe('learn.audio', () => {
  it('accepts narration that matches the comic word for word', () => {
    expect(LearnBundleSchema.safeParse(bundle(audioFor(comic))).success).toBe(true);
    expect(audioProblems(bundle(audioFor(comic)))).toEqual([]);
  });

  it('says to run labs narrate when a caption or a bubble changed since', () => {
    const stale = bundle(audioFor(comic));
    stale.comic = { ...comic, panels: comic.panels.map((p, i) => (i === 1 ? panel({ ...p, bubbles: [{ who: 'maren', text: 'Find out why.' }] }) : p)) };
    expect(audioProblems(stale).join('\n')).toMatch(/audio\.json is out of date.*labs narrate/);
  });

  it('notices a changed speaker (voice) and a changed number of lines', () => {
    const swapped = bundle(audioFor(comic));
    swapped.comic = { ...comic, panels: comic.panels.map((p, i) => (i === 1 ? panel({ ...p, cast: ['priya'], bubbles: [{ who: 'priya', text: 'Find out.' }] }) : p)) };
    expect(audioProblems(swapped).join('\n')).toMatch(/out of date/);
    const more = bundle(audioFor(comic));
    more.comic = { ...comic, panels: [...comic.panels, panel({ scene: 'message', cast: ['maren'], bubbles: [{ who: 'maren', text: 'New.' }] })] };
    expect(audioProblems(more).join('\n')).toMatch(/spoken lines/);
  });

  it('is refused without a comic, with a line naming a missing clip, or with an unused clip', () => {
    const noComic = bundle(audioFor(comic));
    delete noComic.comic;
    expect(audioProblems(noComic).join('\n')).toMatch(/no comic\.yaml/);

    const a = audioFor(comic);
    a.lines[0].clip = 'ffffffffffffffff';
    expect(AudioSchema.safeParse(a).success).toBe(false);

    const b = audioFor(comic);
    b.clips['0000000000000000'] = { voice: 'atlas', text: 'x', seconds: 1, bytes: 10 };
    expect(AudioSchema.safeParse(b).success).toBe(false);
  });

  it('limits what a clip may claim: key shape, size, length and at most 80 clips', () => {
    const base = audioFor(comic);
    const key = Object.keys(base.clips)[0]!;
    const withClip = (patch: Record<string, unknown>) => ({ ...base, clips: { ...base.clips, [key]: { ...base.clips[key], ...patch } } });
    expect(AudioSchema.safeParse(withClip({ bytes: 400 * 1024 + 1 })).success).toBe(false);
    expect(AudioSchema.safeParse(withClip({ seconds: 0 })).success).toBe(false);
    expect(AudioSchema.safeParse(withClip({ voice: 'ATLAS; drop' })).success).toBe(false);
    expect(AudioSchema.safeParse({ ...base, clips: { 'not-a-key': base.clips[key], ...base.clips } }).success).toBe(false);
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 81; i++) many[i.toString(16).padStart(16, '0')] = { voice: 'atlas', text: 't', seconds: 1, bytes: 10 };
    expect(AudioSchema.safeParse({ model: TTS_MODEL, clips: many, lines: [] }).success).toBe(false);
  });
});
