import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountIdFrom, importNarration, narrateLab, planNarration, sha256Hex } from '../../cli/src/narrate';
import { buildLearnUpload } from '../../cli/src/commands/labs';
import { compileLearnDir, readComic } from '../../cli/src/learn-compile';
import { AudioSchema } from '../../src/labs/learn';
import { mp3Seconds } from '../../src/labs/mp3';
import { NARRATOR_VOICE, TTS_MODEL, clipKey, legacyNarrationLines, usesVoiceover } from '../../src/labs/comic-kit';

/**
 * `labs narrate`, against a stubbed fetch (no network): which clips it makes (one per panel voiceover, all
 * in the one narrator voice), that a second run makes none, that clips nothing uses are removed, that it
 * retries, and that the audio.json it writes is what `labs learn-check` and `labs publish` accept. Plus: the
 * narration committed for the real labs is in step with their comics.
 */

const ROOT = join(__dirname, '..', '..');
const CLIP = readFileSync(join(__dirname, '..', 'fixtures', 'audio', 'maren-thalia.mp3'));

const COMIC = (voice = 'Find out what it really does.') => `title: Which provider answered?
panels:
  - scene: desk
    cast: [maren]
    caption: Tuesday, a little after ten.
    voiceover: On Tuesday finance asked us a question nobody could answer.
    bubbles:
      - { who: maren, text: "Which provider answered?" }
    lines: ["invoice: one line"]
  - scene: portrait
    cast: [tomasz]
    voiceover: ${voice}
    bubbles:
      - { who: tomasz, text: "I built it, I can tell you." }
  - scene: screen
    caption: A small copy of it.
    voiceover: We made a small copy for you to look at.
    lines: ["$ send_calls.py", "ready."]
  - scene: you
    caption: Your turn.
    voiceover: Your turn.
    lines: ["$ go", "ready."]
`;

function lab(comic = COMIC()): string {
  const dir = mkdtempSync(join(tmpdir(), 'opalix-narrate-'));
  mkdirSync(join(dir, 'learn'), { recursive: true });
  writeFileSync(join(dir, 'learn', 'story.md'), '---\ntitle: Monday\nminutes: 2\n---\nYou start on Monday.\n');
  writeFileSync(join(dir, 'learn', 'comic.yaml'), comic);
  return dir;
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { text: string; speaker: string };
}

/** A fetch that answers every call with the sample clip, after `script` (one status per call) if given. */
function stub(script: number[] = []) {
  const calls: Call[] = [];
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const status = script.shift() ?? 200;
    if (status !== 200) return new Response(JSON.stringify({ errors: [{ message: `status ${status}` }] }), { status, headers: status === 429 ? { 'retry-after': '0' } : {} });
    return new Response(CLIP, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, peak: () => peak };
}

const opts = (s: ReturnType<typeof stub>, extra: Record<string, unknown> = {}) => ({ token: 'tok-secret', accountId: 'acct123', fetchImpl: s.fetchImpl, sleep: async () => {}, ...extra });
const clipFiles = (dir: string) => (existsSync(join(dir, 'learn', 'audio')) ? readdirSync(join(dir, 'learn', 'audio')).sort() : []);

describe('labs narrate', () => {
  it('plans one clip per distinct voiceover, all in the narrator voice: captions, bubbles and screen lines are left out', () => {
    const dir = lab();
    try {
      const plan = planNarration(readComic(dir).comic!);
      expect(plan.lines.map((l) => `${l.panel}:${l.kind}:${l.voice}`)).toEqual(['0:voiceover:thalia', '1:voiceover:thalia', '2:voiceover:thalia', '3:voiceover:thalia']);
      expect(plan.clips).toHaveLength(4);
      expect(plan.clips.every((c) => c.voice === NARRATOR_VOICE)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makes every clip, writes learn/audio/<key>.mp3 and learn/audio.json, calling the model as documented', async () => {
    const dir = lab();
    try {
      const s = stub();
      const r = await narrateLab(dir, opts(s));
      expect(r).toMatchObject({ lines: 4, clips: 4, made: 4, reused: 0, removed: 0, requests: 4, wroteIndex: true });
      expect(r.characters).toBe('On Tuesday finance asked us a question nobody could answer.Find out what it really does.We made a small copy for you to look at.Your turn.'.length);

      expect(s.calls).toHaveLength(4);
      expect(s.calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/${TTS_MODEL}`);
      expect(s.calls[0]!.headers.authorization).toBe('Bearer tok-secret');
      expect(s.calls.map((c) => c.body.speaker)).toEqual(['thalia', 'thalia', 'thalia', 'thalia']); // one storyteller
      expect(s.calls.map((c) => c.body.text).sort()).toEqual(['Find out what it really does.', 'On Tuesday finance asked us a question nobody could answer.', 'We made a small copy for you to look at.', 'Your turn.']);
      expect(s.calls.map((c) => c.body.text)).not.toContain('Which provider answered?'); // bubbles are text only
      expect(s.peak()).toBeLessThanOrEqual(3);

      expect(clipFiles(dir)).toHaveLength(4);
      expect(clipFiles(dir).every((f) => /^[0-9a-f]{16}\.mp3$/.test(f))).toBe(true);
      const audio = AudioSchema.parse(JSON.parse(readFileSync(join(dir, 'learn', 'audio.json'), 'utf8')));
      expect(audio.model).toBe(TTS_MODEL);
      expect(Object.keys(audio.clips)).toHaveLength(4);
      expect(audio.lines).toHaveLength(4);
      expect(audio.lines.map((l) => ({ panel: l.panel, kind: l.kind, bubble: l.bubble }))).toEqual([0, 1, 2, 3].map((panel) => ({ panel, kind: 'voiceover', bubble: undefined })));
      expect(Object.values(audio.clips).every((c) => c.voice === NARRATOR_VOICE)).toBe(true);
      const [key, clip] = Object.entries(audio.clips)[0]!;
      expect(clip.bytes).toBe(CLIP.length);
      expect(clip.seconds).toBeCloseTo(mp3Seconds(new Uint8Array(CLIP)), 1);
      expect(new Uint8Array(readFileSync(join(dir, "learn", "audio", `${key}.mp3`)))).toEqual(new Uint8Array(CLIP));
      expect(r.seconds).toBeCloseTo(4 * mp3Seconds(new Uint8Array(CLIP)), 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second run makes no network call and rewrites nothing', async () => {
    const dir = lab();
    try {
      await narrateLab(dir, opts(stub()));
      const before = readFileSync(join(dir, 'learn', 'audio.json'), 'utf8');
      const s = stub();
      // No token at all: nothing is missing, so none is needed.
      const r = await narrateLab(dir, { fetchImpl: s.fetchImpl });
      expect(s.calls).toHaveLength(0);
      expect(r).toMatchObject({ made: 0, reused: 4, removed: 0, requests: 0, characters: 0, wroteIndex: false });
      expect(readFileSync(join(dir, 'learn', 'audio.json'), 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makes only the clip whose words changed and deletes the one nothing uses', async () => {
    const dir = lab();
    try {
      await narrateLab(dir, opts(stub()));
      const had = clipFiles(dir);
      writeFileSync(join(dir, 'learn', 'comic.yaml'), COMIC('Find out why it does that.'));
      const s = stub();
      const r = await narrateLab(dir, opts(s));
      expect(s.calls.map((c) => c.body.text)).toEqual(['Find out why it does that.']);
      expect(r).toMatchObject({ made: 1, reused: 3, removed: 1, wroteIndex: true });
      const now = clipFiles(dir);
      expect(now).toHaveLength(4);
      expect(had.filter((f) => !now.includes(f))).toHaveLength(1);
      // The new index is the one `labs learn-check` accepts.
      expect(compileLearnDir(dir)!.problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--dry-run lists what it would make and its characters, and touches nothing', async () => {
    const dir = lab();
    try {
      const lines: string[] = [];
      const s = stub();
      const r = await narrateLab(dir, { ...opts(s), dryRun: true, log: (l) => lines.push(l) });
      expect(s.calls).toHaveLength(0);
      expect(r).toMatchObject({ made: 4, requests: 0, wroteIndex: false });
      expect(r.characters).toBeGreaterThan(100);
      expect(lines.filter((l) => l.includes('would make'))).toHaveLength(4);
      expect(lines.join('\n')).toContain('Find out what it really does.');
      expect(existsSync(join(dir, 'learn', 'audio'))).toBe(false);
      expect(existsSync(join(dir, 'learn', 'audio.json'))).toBe(false);
      // A dry run needs no token.
      await expect(narrateLab(dir, { dryRun: true })).resolves.toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says what is missing when there is no token (and never prints one)', async () => {
    const dir = lab();
    try {
      const s = stub();
      const err = await narrateLab(dir, { fetchImpl: s.fetchImpl, accountId: 'acct123' }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/CLOUDFLARE_API_TOKEN/);
      const err2 = await narrateLab(dir, { fetchImpl: s.fetchImpl, token: 'tok-secret' }).catch((e: Error) => e);
      expect((err2 as Error).message).toMatch(/CLOUDFLARE_ACCOUNT_ID/);
      expect((err2 as Error).message).not.toContain('tok-secret');
      expect(s.calls).toHaveLength(0);
      expect(existsSync(join(dir, 'learn', 'audio.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries a 429 and a 5xx with backoff, then succeeds', async () => {
    const dir = lab();
    try {
      const waits: number[] = [];
      const s = stub([429, 503, 200]);
      const r = await narrateLab(dir, opts(s, { concurrency: 1, sleep: async (ms: number) => void waits.push(ms) }));
      expect(r.made).toBe(4);
      expect(r.requests).toBe(6); // four clips, two of the first attempts were refused once
      expect(waits).toHaveLength(2);
      expect(waits[1]!).toBeGreaterThan(waits[0]! - 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives up after its tries on a service that keeps failing, and on a refusal at once', async () => {
    const dir = lab();
    try {
      const down = stub(Array(50).fill(500));
      await expect(narrateLab(dir, opts(down, { attempts: 3, concurrency: 1 }))).rejects.toThrow(/after 3 tries/);
      expect(down.calls).toHaveLength(3);
      const refused = stub(Array(50).fill(400));
      await expect(narrateLab(dir, opts(refused, { concurrency: 1 }))).rejects.toThrow(/refused/);
      expect(refused.calls).toHaveLength(1); // a 400 is not retried
      expect(existsSync(join(dir, 'learn', 'audio.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an answer that is not an MP3 and never writes it', async () => {
    const dir = lab();
    try {
      const fetchImpl = (async () => new Response('{"success":false}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
      await expect(narrateLab(dir, opts({ calls: [], fetchImpl, peak: () => 0 }))).rejects.toThrow(/not an MP3/);
      expect(clipFiles(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('explains a lab with no comic', async () => {
    const dir = lab();
    try {
      rmSync(join(dir, 'learn', 'comic.yaml'));
      await expect(narrateLab(dir, { dryRun: true })).rejects.toThrow(/no learn\/comic\.yaml/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('labs narrate and the contract', () => {
  it('says what to add when no panel has a voiceover (an old comic), and writes nothing', async () => {
    const dir = lab(COMIC().replace(/^ +voiceover: .*\n/gm, ''));
    try {
      const s = stub();
      await expect(narrateLab(dir, opts(s))).rejects.toThrow(/no panel has a `voiceover`/);
      expect(s.calls).toHaveLength(0);
      expect(existsSync(join(dir, 'learn', 'audio.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a panel without a voiceover simply has no clip', async () => {
    const dir = lab(COMIC().replace(/^ +voiceover: We made a small copy.*\n/m, ''));
    try {
      const s = stub();
      const r = await narrateLab(dir, opts(s));
      expect(r).toMatchObject({ lines: 3, clips: 3, made: 3 });
      expect(AudioSchema.parse(JSON.parse(readFileSync(join(dir, 'learn', 'audio.json'), 'utf8'))).lines.map((l) => l.panel)).toEqual([0, 1, 3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a comic that uses a retired person, before any call', async () => {
    const dir = lab(COMIC().replace('cast: [tomasz]', 'cast: [priya]').replace('who: tomasz', 'who: priya'));
    try {
      const s = stub();
      await expect(narrateLab(dir, opts(s))).rejects.toThrow(/priya is retired: use maren, tomasz or you/);
      expect(s.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces old-shape narration (caption and bubble clips): learn-check refuses it, narrate makes the voiceover clips and removes the old ones', async () => {
    const dir = lab();
    try {
      // The audio an earlier version of narrate wrote for this comic: a clip per caption and per bubble.
      const clips: Record<string, unknown> = {};
      mkdirSync(join(dir, 'learn', 'audio'), { recursive: true });
      const lines = legacyNarrationLines(readComic(dir).comic!).map((l) => {
        const key = clipKey(TTS_MODEL, l.voice, l.text, sha256Hex);
        clips[key] = { voice: l.voice, text: l.text, seconds: mp3Seconds(new Uint8Array(CLIP)), bytes: CLIP.length };
        writeFileSync(join(dir, 'learn', 'audio', `${key}.mp3`), CLIP);
        return { panel: l.panel, kind: l.kind, ...(l.bubble !== undefined ? { bubble: l.bubble } : {}), clip: key };
      });
      writeFileSync(join(dir, 'learn', 'audio.json'), JSON.stringify({ model: TTS_MODEL, clips, lines }));
      expect(compileLearnDir(dir)!.problems.join('\n')).toMatch(/old caption-and-bubble format.*labs narrate/);
      const r = await narrateLab(dir, opts(stub()));
      expect(r.made).toBe(4);
      expect(r.removed).toBe(Object.keys(clips).length);
      expect(compileLearnDir(dir)!.problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what narration does to learn-check and publish', () => {
  it('learn-check says to run narrate when the comic changed after it, or a clip file is gone', async () => {
    const dir = lab();
    try {
      await narrateLab(dir, opts(stub()));
      expect(compileLearnDir(dir)!.problems).toEqual([]);
      const first = clipFiles(dir)[0]!;
      rmSync(join(dir, 'learn', 'audio', first));
      expect(compileLearnDir(dir)!.problems.join('\n')).toMatch(/does not exist; run `labs narrate`/);
      await narrateLab(dir, opts(stub()));
      writeFileSync(join(dir, 'learn', 'comic.yaml'), COMIC('Something else entirely.'));
      expect(compileLearnDir(dir)!.problems.join('\n')).toMatch(/out of date with comic\.yaml.*labs narrate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publish sends the bundle with its audio index and every clip, byte for byte', async () => {
    const dir = lab();
    try {
      await narrateLab(dir, opts(stub()));
      const up = buildLearnUpload(dir)!;
      const bundle = JSON.parse(up.json);
      expect(Object.keys(bundle.audio.clips).sort()).toEqual(up.audio.map((c) => c.name.slice(0, -4)).sort());
      expect(up.audio.every((c) => /^[0-9a-f]{16}\.mp3$/.test(c.name) && Buffer.compare(c.bytes, CLIP) === 0)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a lab with no narration uploads no clips', () => {
    const dir = lab();
    try {
      expect(buildLearnUpload(dir)!.audio).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const CLOSING = (voice = 'The alias had moved and nobody had noticed.') => `title: What we found
panels:
  - scene: desk
    cast: [maren]
    voiceover: By Friday we knew which provider had answered.
    bubbles:
      - { who: maren, text: "So that was it." }
  - scene: portrait
    cast: [tomasz]
    voiceover: ${voice}
  - scene: screen
    voiceover: Here is the line that told us.
    lines: ["alias: fast = provider-b"]
  - scene: you
    voiceover: Now you know where to look.
    lines: ["$ done"]
`;

/** A lab with an opener and a closing comic. */
function labWithClosing(closing = CLOSING()): string {
  const dir = lab();
  writeFileSync(join(dir, 'learn', 'closing.md'), '---\ntitle: Friday\nminutes: 2\n---\nBy Friday we knew.\n');
  writeFileSync(join(dir, 'learn', 'closing.yaml'), closing);
  return dir;
}

describe('labs narrate and the closing comic', () => {
  it('narrates the opener and the closing in one run into learn/audio, writing audio.json and closing-audio.json', async () => {
    const dir = labWithClosing();
    try {
      const s = stub();
      const r = await narrateLab(dir, opts(s));
      expect(r).toMatchObject({ lines: 8, clips: 8, made: 8, reused: 0, removed: 0, wroteIndex: true });
      expect(clipFiles(dir)).toHaveLength(8);
      const opener = AudioSchema.parse(JSON.parse(readFileSync(join(dir, 'learn', 'audio.json'), 'utf8')));
      const closing = AudioSchema.parse(JSON.parse(readFileSync(join(dir, 'learn', 'closing-audio.json'), 'utf8')));
      expect(opener.lines).toHaveLength(4);
      expect(closing.lines.map((l) => l.panel)).toEqual([0, 1, 2, 3]);
      expect(Object.values(closing.clips).map((c) => c.text)).toContain('Now you know where to look.');
      expect(Object.keys(closing.clips).every((k) => clipFiles(dir).includes(`${k}.mp3`))).toBe(true);
      expect(compileLearnDir(dir)!.problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never removes the closing clips as orphans, and a second run makes nothing', async () => {
    const dir = labWithClosing();
    try {
      await narrateLab(dir, opts(stub()));
      const s = stub();
      const r = await narrateLab(dir, { fetchImpl: s.fetchImpl });
      expect(s.calls).toHaveLength(0);
      expect(r).toMatchObject({ made: 0, reused: 8, removed: 0, wroteIndex: false });
      // Changing only the opener replaces one opener clip and leaves the closing's alone.
      writeFileSync(join(dir, 'learn', 'comic.yaml'), COMIC('Find out why it does that.'));
      const r2 = await narrateLab(dir, opts(stub()));
      expect(r2).toMatchObject({ made: 1, reused: 7, removed: 1 });
      expect(compileLearnDir(dir)!.problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('learn-check says closing-audio.json is stale when closing.yaml changed, or a closing clip is gone', async () => {
    const dir = labWithClosing();
    try {
      await narrateLab(dir, opts(stub()));
      writeFileSync(join(dir, 'learn', 'closing.yaml'), CLOSING('Something else entirely.'));
      expect(compileLearnDir(dir)!.problems.join('\n')).toMatch(/learn\/closing-audio\.json is out of date with closing\.yaml.*labs narrate/);
      await narrateLab(dir, opts(stub()));
      expect(compileLearnDir(dir)!.problems).toEqual([]);
      const closing = JSON.parse(readFileSync(join(dir, 'learn', 'closing-audio.json'), 'utf8')) as { lines: { clip: string }[] };
      rmSync(join(dir, 'learn', 'audio', `${closing.lines[3]!.clip}.mp3`));
      expect(compileLearnDir(dir)!.problems.join('\n')).toMatch(/closing-audio\.json names clip [0-9a-f]{16}, but .* does not exist; run `labs narrate`/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a closing comic with nothing to speak, before any call', async () => {
    const dir = labWithClosing(CLOSING().replace(/voiceover:/g, 'caption:'));
    try {
      const s = stub();
      await expect(narrateLab(dir, opts(s))).rejects.toThrow(/closing comic has nothing to speak/);
      expect(s.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publish uploads the closing clips beside the opener clips, each once', async () => {
    const dir = labWithClosing();
    try {
      await narrateLab(dir, opts(stub()));
      const up = buildLearnUpload(dir)!;
      const bundle = JSON.parse(up.json);
      const want = [...new Set([...Object.keys(bundle.audio.clips), ...Object.keys(bundle.closing.audio.clips)])].sort();
      expect(want).toHaveLength(8);
      expect(up.audio.map((c) => c.name.slice(0, -4)).sort()).toEqual(want);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- importing clips made elsewhere (`labs narrate --from-dir`) ----------------------------------

const EL_MODEL = 'elevenlabs/eleven_v4';
const EL_VOICE = 'QIhD5ivPGEoYZQDocuHI';
const VOICEOVERS = ['On Tuesday finance asked us a question nobody could answer.', 'Find out what it really does.', 'We made a small copy for you to look at.', 'Your turn.'];
const CLOSING_VOICEOVERS = ['By Friday we knew which provider had answered.', 'The alias had moved and nobody had noticed.', 'Here is the line that told us.', 'Now you know where to look.'];

/** A tiny synthetic MP3: `n` MPEG-1 layer III frames (128 kbps, 44.1 kHz, 417 bytes each), so each file's size says which it is. */
function frames(n: number): Buffer {
  const bytes = Buffer.alloc(417 * n);
  for (let i = 0; i < n; i++) bytes.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  return bytes;
}

/** A folder of clips: `files` maps a path inside it to its bytes. */
function clipsDir(files: Record<string, Buffer | string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'opalix-clips-'));
  for (const [rel, bytes] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), bytes);
  }
  return dir;
}

/** NN.mp3 for each voiceover, the n-th made of `first + n` frames. */
const numbered = (count: number, first = 3, prefix = '') =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${String(i + 1).padStart(2, '0')}.mp3`, frames(first + i)]));

const keyOf = (text: string) => clipKey(EL_MODEL, EL_VOICE, text, sha256Hex);
const readAudio = (dir: string, name = 'audio.json') => AudioSchema.parse(JSON.parse(readFileSync(join(dir, 'learn', name), 'utf8')));
const imp = (dir: string, from: string, extra: Partial<Parameters<typeof importNarration>[1]> = {}) => importNarration(dir, { fromDir: from, model: EL_MODEL, voice: EL_VOICE, ...extra });

describe('labs narrate --from-dir (clips made by another text-to-speech)', () => {
  it('files NN.mp3 in voiceover order under keys of the given model and voice, and learn-check and publish accept it', () => {
    const dir = lab();
    const from = clipsDir(numbered(4));
    try {
      const r = imp(dir, from);
      expect(r).toMatchObject({ lines: 4, clips: 4, made: 4, reused: 0, removed: 0, requests: 0, wroteIndex: true });
      const audio = readAudio(dir);
      expect(audio.model).toBe(EL_MODEL);
      expect(audio.lines.map((l) => l.clip)).toEqual(VOICEOVERS.map(keyOf));
      VOICEOVERS.forEach((text, i) => {
        const clip = audio.clips[keyOf(text)]!;
        expect(clip).toMatchObject({ voice: EL_VOICE, text, bytes: 417 * (3 + i) });
        expect(clip.seconds).toBeCloseTo(((3 + i) * 1152) / 44100, 2);
        expect(Buffer.compare(readFileSync(join(dir, 'learn', 'audio', `${keyOf(text)}.mp3`)), frames(3 + i))).toBe(0);
      });
      // learn-check takes the model and voice as given; publish uploads the clips like any others.
      expect(compileLearnDir(dir)!.problems).toEqual([]);
      expect(buildLearnUpload(dir)!.audio.map((c) => c.name).sort()).toEqual(VOICEOVERS.map((t) => `${keyOf(t)}.mp3`).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(from, { recursive: true, force: true });
    }
  });

  it('with a manifest.json matches each file to its panel by its words, not by order, and takes the model and voice from it', () => {
    const dir = lab();
    const from = clipsDir({
      'turn.mp3': frames(9),
      'tuesday.mp3': frames(3),
      'copy.mp3': frames(7),
      'find.mp3': frames(5),
      'manifest.json': JSON.stringify({
        model: EL_MODEL,
        voice: EL_VOICE,
        clips: [
          { file: 'turn.mp3', text: VOICEOVERS[3] },
          { file: 'copy.mp3', text: VOICEOVERS[2] },
          { file: 'tuesday.mp3', text: VOICEOVERS[0] },
          { file: 'find.mp3', text: VOICEOVERS[1] },
        ],
      }),
    });
    try {
      const r = importNarration(dir, { fromDir: from });
      expect(r).toMatchObject({ lines: 4, made: 4 });
      const audio = readAudio(dir);
      expect(audio.lines.map((l) => audio.clips[l.clip]!.bytes)).toEqual([3, 5, 7, 9].map((n) => 417 * n));
      expect(compileLearnDir(dir)!.problems).toEqual([]);
      // A flag that disagrees with the manifest is refused rather than silently preferred.
      expect(() => importNarration(dir, { fromDir: from, voice: 'thalia' })).toThrow(/--voice thalia disagrees with manifest\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(from, { recursive: true, force: true });
    }
  });

  it('refuses a folder with more or fewer clips than voiceovers, naming both numbers, and writes nothing', () => {
    const dir = lab();
    const few = clipsDir(numbered(3));
    const many = clipsDir(numbered(5));
    try {
      expect(() => imp(dir, few)).toThrow(/has 3 clips but comic\.yaml has 4 voiceovers/);
      expect(() => imp(dir, many)).toThrow(/has 5 clips but comic\.yaml has 4 voiceovers/);
      expect(() => importNarration(dir, { fromDir: few, voice: EL_VOICE })).toThrow(/--model is needed/);
      expect(clipFiles(dir)).toEqual([]);
      expect(existsSync(join(dir, 'learn', 'audio.json'))).toBe(false);
    } finally {
      for (const d of [dir, few, many]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('refuses a manifest clip whose words are not in the comic (a stale clip), and one that leaves a voiceover without a clip', () => {
    const dir = lab();
    const entries = VOICEOVERS.map((text, i) => ({ file: `${i + 1}.mp3`, text }));
    const stale = clipsDir({ '1.mp3': frames(3), '2.mp3': frames(4), '3.mp3': frames(5), '4.mp3': frames(6), 'manifest.json': JSON.stringify({ model: EL_MODEL, voice: EL_VOICE, clips: entries.map((e, i) => (i === 1 ? { ...e, text: 'Find out what it did last week.' } : e)) }) });
    const short = clipsDir({ '1.mp3': frames(3), '2.mp3': frames(4), '3.mp3': frames(5), 'manifest.json': JSON.stringify({ model: EL_MODEL, voice: EL_VOICE, clips: entries.slice(0, 3) }) });
    try {
      expect(() => importNarration(dir, { fromDir: stale })).toThrow(/not a voiceover of comic\.yaml:\n {2}- 2\.mp3: "Find out what it did last week\."/);
      expect(() => importNarration(dir, { fromDir: short })).toThrow(/has 3 clips but comic\.yaml has 4 distinct voiceovers; no clip for:\n {2}- "Your turn\."/);
      expect(clipFiles(dir)).toEqual([]);
      expect(existsSync(join(dir, 'learn', 'audio.json'))).toBe(false);
    } finally {
      for (const d of [dir, stale, short]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('refuses a file that is not an MP3 or is over the size limit, before writing anything', () => {
    const dir = lab();
    const notMp3 = clipsDir({ ...numbered(4), '02.mp3': 'ID3? no, just text' });
    const big = clipsDir({ ...numbered(4), '03.mp3': frames(1000) });
    try {
      expect(() => imp(dir, notMp3)).toThrow(/02\.mp3 is not an MP3/);
      expect(() => imp(dir, big)).toThrow(/03\.mp3 is 417000 bytes, over the 409600 limit/);
      expect(clipFiles(dir)).toEqual([]);
    } finally {
      for (const d of [dir, notMp3, big]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('imports the opener and the closing (closing/NN.mp3) into one learn/audio, and needs both when the lab has a closing', () => {
    const dir = labWithClosing();
    const openerOnly = clipsDir(numbered(4));
    const both = clipsDir({ ...numbered(4), ...numbered(4, 11, 'closing/') });
    try {
      expect(() => imp(dir, openerOnly)).toThrow(/has a closing comic \(learn\/closing\.yaml\): its clips are needed too/);
      const r = imp(dir, both);
      expect(r).toMatchObject({ lines: 8, clips: 8, made: 8, reused: 0, removed: 0, wroteIndex: true });
      expect(clipFiles(dir)).toHaveLength(8);
      const closing = readAudio(dir, 'closing-audio.json');
      expect(closing.model).toBe(EL_MODEL);
      expect(closing.lines.map((l) => l.clip)).toEqual(CLOSING_VOICEOVERS.map(keyOf));
      expect(closing.lines.map((l) => closing.clips[l.clip]!.bytes)).toEqual([11, 12, 13, 14].map((n) => 417 * n));
      expect(compileLearnDir(dir)!.problems).toEqual([]);
      // Closing clips for a lab with no closing are refused too.
      const plain = lab();
      try {
        expect(() => imp(plain, both)).toThrow(/clips for a closing \(closing\/\), but .* has no learn\/closing\.yaml/);
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    } finally {
      for (const d of [dir, openerOnly, both]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('a second run reuses every clip, overwrites none and rewrites nothing; --dry-run lists file → panel → key and touches nothing', () => {
    const dir = lab();
    const from = clipsDir(numbered(4));
    try {
      const lines: string[] = [];
      const dry = imp(dir, from, { dryRun: true, log: (l) => lines.push(l) });
      expect(dry).toMatchObject({ made: 4, wroteIndex: false });
      expect(lines).toHaveLength(4);
      expect(lines[1]).toBe(`  02.mp3 → comic.yaml panel 2 → ${keyOf(VOICEOVERS[1]!)}.mp3 (would copy)  ${VOICEOVERS[1]}`);
      expect(existsSync(join(dir, 'learn', 'audio'))).toBe(false);
      expect(existsSync(join(dir, 'learn', 'audio.json'))).toBe(false);

      imp(dir, from);
      const before = readFileSync(join(dir, 'learn', 'audio.json'), 'utf8');
      // A different take under the same name: the key (same model, voice and words) is already there, so it is kept.
      writeFileSync(join(from, '01.mp3'), frames(20));
      const r = imp(dir, from);
      expect(r).toMatchObject({ made: 0, reused: 4, removed: 0, wroteIndex: false });
      expect(readFileSync(join(dir, 'learn', 'audio.json'), 'utf8')).toBe(before);
      expect(readFileSync(join(dir, 'learn', 'audio', `${keyOf(VOICEOVERS[0]!)}.mp3`)).length).toBe(417 * 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(from, { recursive: true, force: true });
    }
  });

  it('learn-check calls an imported narration stale after a voiceover edit; importing again replaces just that clip', () => {
    const dir = lab();
    const from = clipsDir(numbered(4));
    try {
      imp(dir, from);
      writeFileSync(join(dir, 'learn', 'comic.yaml'), COMIC('Find out why it does that.'));
      expect(compileLearnDir(dir)!.problems.join('\n')).toMatch(/learn\/audio\.json is out of date with comic\.yaml.*labs narrate/);
      writeFileSync(join(from, '02.mp3'), frames(8));
      const r = imp(dir, from);
      expect(r).toMatchObject({ made: 1, reused: 3, removed: 1, wroteIndex: true });
      expect(readAudio(dir).clips[keyOf('Find out why it does that.')]!.bytes).toBe(417 * 8);
      expect(clipFiles(dir)).toHaveLength(4);
      expect(compileLearnDir(dir)!.problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(from, { recursive: true, force: true });
    }
  });

  it('learn-check still wants one voice: an imported narration with a clip in another voice is stale', () => {
    const dir = lab();
    const from = clipsDir(numbered(4));
    try {
      imp(dir, from);
      const audio = JSON.parse(readFileSync(join(dir, 'learn', 'audio.json'), 'utf8'));
      audio.clips[keyOf(VOICEOVERS[2]!)].voice = 'SomeOtherVoice123';
      writeFileSync(join(dir, 'learn', 'audio.json'), JSON.stringify(audio));
      expect(compileLearnDir(dir)!.problems.join('\n')).toMatch(/panel 3: the voiceover or the narrator's voice changed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(from, { recursive: true, force: true });
    }
  });
});

describe('the account id', () => {
  it('comes from the environment, else from wrangler.jsonc vars', () => {
    expect(accountIdFrom({ CLOUDFLARE_ACCOUNT_ID: 'from-env' }, join(ROOT, 'wrangler.jsonc'))).toBe('from-env');
    expect(accountIdFrom({}, join(ROOT, 'wrangler.jsonc'))).toMatch(/^[0-9a-f]{32}$/);
    expect(accountIdFrom({}, join(ROOT, 'no-such-file.jsonc'))).toBeUndefined();
  });
});

// The committed narration of the labs that have a comic: each must be in step with its comic.yaml, or the
// voice would say words the panel does not show. (Run `labs narrate labs/<slug>` after changing a comic.)
//
// The labs move from the old contract (caption and bubble narration, several voices) to the voiceover
// contract one rewrite at a time, so each lab is held to the contract it is written to: a comic with at least
// one `voiceover` must have the one-voice narration (a dry run has nothing to make or remove); a comic without
// keeps its old narration, which learn-check still accepts. Either way the bundle compiles with no problem
// and every clip file is a real MP3 of the length audio.json says.
describe('the narration committed with the labs', () => {
  const slugs = readdirSync(join(ROOT, 'labs')).filter((s) => existsSync(join(ROOT, 'labs', s, 'learn', 'comic.yaml')));
  it('covers the six explore labs that have a comic', () => {
    expect(slugs.length).toBeGreaterThanOrEqual(6);
  });
  for (const slug of slugs) {
    it(`${slug}: audio.json matches comic.yaml, every clip is there, nothing is left over`, async () => {
      const dir = join(ROOT, 'labs', slug);
      expect(existsSync(join(dir, 'learn', 'audio.json'))).toBe(true);
      const compiled = compileLearnDir(dir)!;
      expect(compiled.problems).toEqual([]);
      if (usesVoiceover(compiled.bundle!.comic!)) {
        const lines: string[] = [];
        const r = await narrateLab(dir, { dryRun: true, log: (l) => lines.push(l) });
        expect(lines, 'a dry run has nothing to make or remove').toEqual([]);
        expect(r).toMatchObject({ made: 0, removed: 0 });
        expect(compiled.bundle!.audio!.lines.every((l) => l.kind === 'voiceover')).toBe(true);
      }
      // Every committed clip is really an MP3 of about the length audio.json says.
      for (const [key, clip] of Object.entries(compiled.bundle!.audio!.clips)) {
        const bytes = new Uint8Array(readFileSync(join(dir, 'learn', 'audio', `${key}.mp3`)));
        expect(bytes.length).toBe(clip.bytes);
        expect(Math.abs(mp3Seconds(bytes) - clip.seconds)).toBeLessThan(0.02);
      }
    });
  }
});

