import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountIdFrom, narrateLab, planNarration } from '../../cli/src/narrate';
import { buildLearnUpload } from '../../cli/src/commands/labs';
import { compileLearnDir, readComic } from '../../cli/src/learn-compile';
import { AudioSchema } from '../../src/labs/learn';
import { mp3Seconds } from '../../src/labs/mp3';
import { TTS_MODEL } from '../../src/labs/comic-kit';

/**
 * `labs narrate`, against a stubbed fetch (no network): which clips it makes, that a second run
 * makes none, that clips nothing uses are removed, that it retries, and that the audio.json it
 * writes is what `labs learn-check` and `labs publish` accept. Plus: the narration committed for
 * the real labs is in step with their comics.
 */

const ROOT = join(__dirname, '..', '..');
const CLIP = readFileSync(join(__dirname, '..', 'fixtures', 'audio', 'maren-thalia.mp3'));

const COMIC = (maren = 'Find out what it really does.') => `title: Which provider answered?
panels:
  - scene: desk
    cast: [jonas]
    caption: Tuesday, a little after ten.
    bubbles:
      - { who: jonas, text: "Which provider answered?" }
    lines: ["invoice: one line"]
  - scene: portrait
    cast: [maren]
    bubbles:
      - { who: maren, text: "${maren}" }
  - scene: screen
    caption: A small copy of it.
    lines: ["$ send_calls.py", "ready."]
  - scene: you
    caption: Your turn.
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
  it('plans one clip per distinct (voice, words): caption first, learner and screen lines left out', () => {
    const dir = lab();
    try {
      const plan = planNarration(readComic(dir).comic!);
      expect(plan.lines.map((l) => `${l.panel}:${l.kind}:${l.voice}`)).toEqual(['0:caption:atlas', '0:bubble:arcas', '1:bubble:thalia', '2:caption:atlas', '3:caption:atlas']);
      expect(plan.clips).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makes every clip, writes learn/audio/<key>.mp3 and learn/audio.json, calling the model as documented', async () => {
    const dir = lab();
    try {
      const s = stub();
      const r = await narrateLab(dir, opts(s));
      expect(r).toMatchObject({ lines: 5, clips: 5, made: 5, reused: 0, removed: 0, requests: 5, wroteIndex: true });
      expect(r.characters).toBe('Tuesday, a little after ten.Which provider answered?Find out what it really does.A small copy of it.Your turn.'.length);

      expect(s.calls).toHaveLength(5);
      expect(s.calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/${TTS_MODEL}`);
      expect(s.calls[0]!.headers.authorization).toBe('Bearer tok-secret');
      expect(s.calls.map((c) => c.body.speaker).sort()).toEqual(['arcas', 'atlas', 'atlas', 'atlas', 'thalia']);
      expect(s.calls.find((c) => c.body.speaker === 'thalia')!.body.text).toBe('Find out what it really does.');
      expect(s.peak()).toBeLessThanOrEqual(3);

      expect(clipFiles(dir)).toHaveLength(5);
      expect(clipFiles(dir).every((f) => /^[0-9a-f]{16}\.mp3$/.test(f))).toBe(true);
      const audio = AudioSchema.parse(JSON.parse(readFileSync(join(dir, 'learn', 'audio.json'), 'utf8')));
      expect(audio.model).toBe(TTS_MODEL);
      expect(Object.keys(audio.clips)).toHaveLength(5);
      expect(audio.lines).toHaveLength(5);
      const [key, clip] = Object.entries(audio.clips)[0]!;
      expect(clip.bytes).toBe(CLIP.length);
      expect(clip.seconds).toBeCloseTo(mp3Seconds(new Uint8Array(CLIP)), 1);
      expect(new Uint8Array(readFileSync(join(dir, "learn", "audio", `${key}.mp3`)))).toEqual(new Uint8Array(CLIP));
      expect(r.seconds).toBeCloseTo(5 * mp3Seconds(new Uint8Array(CLIP)), 5);
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
      expect(r).toMatchObject({ made: 0, reused: 5, removed: 0, requests: 0, characters: 0, wroteIndex: false });
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
      expect(r).toMatchObject({ made: 1, reused: 4, removed: 1, wroteIndex: true });
      const now = clipFiles(dir);
      expect(now).toHaveLength(5);
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
      expect(r).toMatchObject({ made: 5, requests: 0, wroteIndex: false });
      expect(r.characters).toBeGreaterThan(100);
      expect(lines.filter((l) => l.includes('would make'))).toHaveLength(5);
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
      expect(r.made).toBe(5);
      expect(r.requests).toBe(7); // five clips, two of the first attempts were refused once
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

describe('the account id', () => {
  it('comes from the environment, else from wrangler.jsonc vars', () => {
    expect(accountIdFrom({ CLOUDFLARE_ACCOUNT_ID: 'from-env' }, join(ROOT, 'wrangler.jsonc'))).toBe('from-env');
    expect(accountIdFrom({}, join(ROOT, 'wrangler.jsonc'))).toMatch(/^[0-9a-f]{32}$/);
    expect(accountIdFrom({}, join(ROOT, 'no-such-file.jsonc'))).toBeUndefined();
  });
});

// The committed narration of the labs that have a comic: each must be in step with its comic.yaml, or the
// voice would say words the panel does not show. (Run `labs narrate labs/<slug>` after changing a comic.)
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
      const lines: string[] = [];
      const r = await narrateLab(dir, { dryRun: true, log: (l) => lines.push(l) });
      expect(lines, 'a dry run has nothing to make or remove').toEqual([]);
      expect(r).toMatchObject({ made: 0, removed: 0 });
      // Every committed clip is really an MP3 of about the length audio.json says.
      for (const [key, clip] of Object.entries(compiled.bundle!.audio!.clips)) {
        const bytes = new Uint8Array(readFileSync(join(dir, 'learn', 'audio', `${key}.mp3`)));
        expect(bytes.length).toBe(clip.bytes);
        expect(Math.abs(mp3Seconds(bytes) - clip.seconds)).toBeLessThan(0.02);
      }
    });
  }
});

