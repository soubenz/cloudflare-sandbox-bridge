import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TTS_MODEL, clipKey, narrationLines, type NarrationLine } from '../../src/labs/comic-kit';
import { MAX_AUDIO_CLIPS, MAX_AUDIO_CLIP_BYTES, type LearnAudio } from '../../src/labs/learn';
import { looksLikeMp3, mp3Seconds } from '../../src/labs/mp3';
import { readComic } from './learn-compile';

/**
 * `labs narrate <dir>`: gives a lab's motion comic its voices.
 *
 * One storyteller voice tells the story: the words to speak are the `voiceover` of each panel and the
 * voice is the narrator's, both from comic-kit (narrationLines, NARRATOR_VOICE). Bubbles are text only
 * and are never voiced. Each distinct
 * (model, voice, text) is one mp3 in `learn/audio/<clipKey>.mp3`, made by Workers AI text-to-speech
 * over its REST endpoint, and `learn/audio.json` indexes them (clip lengths and sizes, and which
 * clip reads which panel's voiceover). Both are committed: publishing never calls the model. Running it
 * again makes only the clips that are missing, so a second run with nothing changed makes no
 * network call, and clips nothing refers to any more are deleted.
 */

export const sha256Hex = (input: string): string => createHash('sha256').update(input).digest('hex');

export interface PlannedClip {
  key: string;
  voice: string;
  text: string;
}
export interface NarrationPlan {
  /** Every spoken line in reading order, with the key of its clip. */
  lines: (NarrationLine & { key: string })[];
  /** The distinct clips, in order of first use. */
  clips: PlannedClip[];
}

/** The lines of a comic and the distinct clips they need. Pure. */
export function planNarration(comic: Parameters<typeof narrationLines>[0], model: string = TTS_MODEL): NarrationPlan {
  const lines = narrationLines(comic).map((l) => ({ ...l, key: clipKey(model, l.voice, l.text, sha256Hex) }));
  const clips = new Map<string, PlannedClip>();
  for (const l of lines) if (!clips.has(l.key)) clips.set(l.key, { key: l.key, voice: l.voice, text: l.text });
  return { lines, clips: [...clips.values()] };
}

/** The audio.json for a plan, given each clip's measured length and size. Deterministic, so a second run writes the same bytes. */
export function buildAudioIndex(plan: NarrationPlan, measured: ReadonlyMap<string, { seconds: number; bytes: number }>, model: string = TTS_MODEL): LearnAudio {
  const clips: LearnAudio['clips'] = {};
  for (const c of plan.clips) {
    const m = measured.get(c.key)!;
    clips[c.key] = { voice: c.voice, text: c.text, seconds: Math.round(m.seconds * 100) / 100, bytes: m.bytes };
  }
  return {
    model,
    clips,
    lines: plan.lines.map((l) => ({ panel: l.panel, kind: l.kind, clip: l.key })),
  };
}

/** The Cloudflare account id: the environment's, else the one in wrangler.jsonc's vars. */
export function accountIdFrom(env: Record<string, string | undefined>, wranglerPath: string): string | undefined {
  if (env.CLOUDFLARE_ACCOUNT_ID) return env.CLOUDFLARE_ACCOUNT_ID;
  try {
    return /"CLOUDFLARE_ACCOUNT_ID"\s*:\s*"([0-9a-f]{32})"/.exec(readFileSync(wranglerPath, 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

export interface NarrateOptions {
  dryRun?: boolean;
  /** Workers AI API token; the command reads CLOUDFLARE_API_TOKEN. Never printed. */
  token?: string;
  accountId?: string;
  fetchImpl?: typeof fetch;
  /** Most requests in flight at once (at most 3). */
  concurrency?: number;
  /** Tries per clip on 429/5xx/network errors. */
  attempts?: number;
  /** Replaced in tests so backoff does not wait. */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface NarrateResult {
  lab: string;
  /** Voiceovers in the comic and the closing comic, and the distinct clips they need together. */
  lines: number;
  clips: number;
  /** Clips synthesised by this run (or that a dry run would synthesise), and their characters. */
  made: number;
  characters: number;
  /** Clips reused from disk, and orphans removed. */
  reused: number;
  removed: number;
  /** Network calls made (retries included). */
  requests: number;
  /** Total playing seconds of all the lab's clips and their bytes (zero on a dry run that has missing clips). */
  seconds: number;
  bytes: number;
  wroteIndex: boolean;
}

const CLIP_FILE = /^[0-9a-f]{16}\.mp3$/;
/** A failure that trying again cannot fix (a refused request, a body that is not an MP3). */
class FatalError extends Error {}
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One text-to-speech call with retries; resolves with the mp3 bytes. */
async function synthesise(clip: PlannedClip, o: Required<Pick<NarrateOptions, 'token' | 'accountId' | 'fetchImpl' | 'attempts' | 'sleep'>>, count: () => void): Promise<Buffer> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${o.accountId}/ai/run/${TTS_MODEL}`;
  let lastError = '';
  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    let wait = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    try {
      count();
      const res = await o.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: clip.text, speaker: clip.voice }),
      });
      if (res.ok) {
        const bytes = Buffer.from(await res.arrayBuffer());
        if (!looksLikeMp3(bytes)) throw new FatalError(`${clip.voice}: the model answered with something that is not an MP3 (${(res.headers.get('content-type') ?? 'no content type')})`);
        if (bytes.length > MAX_AUDIO_CLIP_BYTES) throw new FatalError(`${clip.voice}: clip is ${bytes.length} bytes, over the ${MAX_AUDIO_CLIP_BYTES} limit; shorten the line`);
        return bytes;
      }
      const body = (await res.text().catch(() => '')).slice(0, 300);
      lastError = `HTTP ${res.status} ${body}`;
      if (res.status !== 429 && res.status < 500) {
        throw new FatalError(`text-to-speech refused "${clip.text.slice(0, 40)}" (${lastError})`);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) wait = Math.max(wait, Math.min(retryAfter, 60) * 1000);
    } catch (e) {
      if (e instanceof FatalError) throw e;
      lastError = (e as Error).message;
    }
    if (attempt < o.attempts) await o.sleep(wait);
  }
  throw new Error(`text-to-speech failed for "${clip.text.slice(0, 40)}" after ${o.attempts} tries (${lastError})`);
}

/** Runs `fn` over `items`, at most `width` at a time; the first failure stops starting new work and is thrown. */
async function pool<T>(items: readonly T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined && next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (e) {
        failure = failure ?? e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker));
  if (failure !== undefined) throw failure;
}

/**
 * Narrates one lab directory: the opener (learn/comic.yaml into learn/audio.json) and, when the lab has
 * one, the closing (learn/closing.yaml into learn/closing-audio.json). Both share learn/audio/, so the
 * clips are planned together: a clip either comic uses is kept, and only clips neither uses are removed.
 * Throws an Error with the reason when it cannot.
 */
export async function narrateLab(labDir: string, opts: NarrateOptions = {}): Promise<NarrateResult> {
  const log = opts.log ?? (() => {});
  const { comic, problems } = readComic(labDir);
  if (!comic) throw new Error(`cannot narrate ${labDir}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  const plan = planNarration(comic);
  if (plan.lines.length === 0) throw new Error(`${labDir}: the comic has nothing to speak: no panel has a \`voiceover\` (the storyteller reads the voiceovers; see docs/learning-content.md)`);

  let closingPlan: NarrationPlan | undefined;
  if (existsSync(join(labDir, 'learn', 'closing.yaml'))) {
    const closing = readComic(labDir, 'closing.yaml');
    if (!closing.comic) throw new Error(`cannot narrate the closing of ${labDir}:\n${closing.problems.map((p) => `  - ${p}`).join('\n')}`);
    closingPlan = planNarration(closing.comic);
    if (closingPlan.lines.length === 0) {
      throw new Error(`${labDir}: the closing comic has nothing to speak: no panel of closing.yaml has a \`voiceover\` (see docs/learning-content.md)`);
    }
  }

  // The distinct clips of both comics, in order of first use (a line both say is one clip).
  const all = new Map<string, PlannedClip>();
  for (const c of [...plan.clips, ...(closingPlan?.clips ?? [])]) if (!all.has(c.key)) all.set(c.key, c);
  const clips = [...all.values()];
  if (clips.length > MAX_AUDIO_CLIPS) {
    throw new Error(`${labDir}: the comic${closingPlan ? ' and the closing' : ''} need${closingPlan ? '' : 's'} ${clips.length} distinct clips and a lab may carry at most ${MAX_AUDIO_CLIPS}; shorten it`);
  }

  const audioDir = join(labDir, 'learn', 'audio');
  const onDisk = existsSync(audioDir) ? readdirSync(audioDir).filter((f) => CLIP_FILE.test(f)) : [];
  const have = (key: string) => onDisk.includes(`${key}.mp3`) && statSync(join(audioDir, `${key}.mp3`)).size > 0;
  const missing = clips.filter((c) => !have(c.key));
  const wanted = new Set(clips.map((c) => `${c.key}.mp3`));
  const orphans = onDisk.filter((f) => !wanted.has(f));
  const characters = missing.reduce((n, c) => n + c.text.length, 0);

  const result: NarrateResult = {
    lab: labDir,
    lines: plan.lines.length + (closingPlan?.lines.length ?? 0),
    clips: clips.length,
    made: missing.length,
    characters,
    reused: clips.length - missing.length,
    removed: orphans.length,
    requests: 0,
    seconds: 0,
    bytes: 0,
    wroteIndex: false,
  };

  if (opts.dryRun) {
    for (const c of missing) log(`  would make ${c.key}.mp3  ${c.voice.padEnd(10)} ${c.text}`);
    for (const f of orphans) log(`  would remove ${f} (nothing uses it)`);
    return result;
  }

  if (missing.length > 0) {
    if (!opts.token) throw new Error('set CLOUDFLARE_API_TOKEN (an API token that may run Workers AI) to make narration; `labs narrate --dry-run` needs none');
    if (!opts.accountId) throw new Error('set CLOUDFLARE_ACCOUNT_ID (or keep it in wrangler.jsonc vars) to make narration');
    mkdirSync(audioDir, { recursive: true });
    const o = {
      token: opts.token,
      accountId: opts.accountId,
      fetchImpl: opts.fetchImpl ?? fetch,
      attempts: opts.attempts ?? 5,
      sleep: opts.sleep ?? defaultSleep,
    };
    await pool(missing, Math.min(3, opts.concurrency ?? 3), async (clip) => {
      const bytes = await synthesise(clip, o, () => {
        result.requests += 1;
      });
      // Written whole or not at all, so an interrupted run never leaves half a clip that the next run would trust.
      const tmp = join(audioDir, `.${clip.key}.tmp`);
      writeFileSync(tmp, bytes);
      renameSync(tmp, join(audioDir, `${clip.key}.mp3`));
      log(`  made ${clip.key}.mp3  ${clip.voice.padEnd(10)} ${bytes.length} bytes  ${clip.text}`);
    });
  }

  for (const f of orphans) {
    rmSync(join(audioDir, f));
    log(`  removed ${f} (nothing uses it)`);
  }

  const measured = new Map<string, { seconds: number; bytes: number }>();
  for (const c of clips) {
    const bytes = readFileSync(join(audioDir, `${c.key}.mp3`));
    const seconds = mp3Seconds(bytes);
    if (!(seconds > 0)) throw new Error(`${c.key}.mp3 holds no audio (clip for "${c.text.slice(0, 40)}"); delete it and run again`);
    measured.set(c.key, { seconds, bytes: bytes.length });
    result.seconds += seconds;
    result.bytes += bytes.length;
  }
  const indexes: [string, NarrationPlan][] = [['audio.json', plan]];
  if (closingPlan) indexes.push(['closing-audio.json', closingPlan]);
  for (const [name, p] of indexes) {
    const index = `${JSON.stringify(buildAudioIndex(p, measured), null, 2)}\n`;
    const indexPath = join(labDir, 'learn', name);
    const before = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
    if (before !== index) {
      writeFileSync(indexPath, index);
      result.wroteIndex = true;
    }
  }
  return result;
}
