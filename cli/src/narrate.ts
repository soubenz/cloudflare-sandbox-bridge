import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { TTS_MODEL, clipKey, narrationLines, type NarrationLine } from '../../src/labs/comic-kit';
import { MAX_AUDIO_CLIPS, MAX_AUDIO_CLIP_BYTES, VOICE_ID, type LearnAudio } from '../../src/labs/learn';
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
 *
 * `labs narrate <dir> --from-dir <clips>` (importNarration) files clips made by another text-to-speech
 * the same way: same keys (of that model and voice), same indexes, same orphan cleanup, and no network.
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

/** The lines of a comic and the distinct clips they need; `voice` replaces the narrator's (imported clips). Pure. */
export function planNarration(comic: Parameters<typeof narrationLines>[0], model: string = TTS_MODEL, voice?: string): NarrationPlan {
  const lines = narrationLines(comic).map((l) => ({ ...l, voice: voice ?? l.voice, key: clipKey(model, voice ?? l.voice, l.text, sha256Hex) }));
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

/** Both comics of a lab planned together: the opener's lines, the closing's (when the lab has one) and the distinct clips of both. */
interface LabPlan {
  plan: NarrationPlan;
  closingPlan?: NarrationPlan;
  /** The distinct clips of both comics, in order of first use (a line both say is one clip). */
  clips: PlannedClip[];
}

/** Reads and plans the opener and, when there is one, the closing. Throws with the reason when either cannot be narrated. */
function planLab(labDir: string, model?: string, voice?: string): LabPlan {
  const { comic, problems } = readComic(labDir);
  if (!comic) throw new Error(`cannot narrate ${labDir}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  const plan = planNarration(comic, model, voice);
  if (plan.lines.length === 0) throw new Error(`${labDir}: the comic has nothing to speak: no panel has a \`voiceover\` (the storyteller reads the voiceovers; see docs/learning-content.md)`);

  let closingPlan: NarrationPlan | undefined;
  if (existsSync(join(labDir, 'learn', 'closing.yaml'))) {
    const closing = readComic(labDir, 'closing.yaml');
    if (!closing.comic) throw new Error(`cannot narrate the closing of ${labDir}:\n${closing.problems.map((p) => `  - ${p}`).join('\n')}`);
    closingPlan = planNarration(closing.comic, model, voice);
    if (closingPlan.lines.length === 0) {
      throw new Error(`${labDir}: the closing comic has nothing to speak: no panel of closing.yaml has a \`voiceover\` (see docs/learning-content.md)`);
    }
  }

  const all = new Map<string, PlannedClip>();
  for (const c of [...plan.clips, ...(closingPlan?.clips ?? [])]) if (!all.has(c.key)) all.set(c.key, c);
  const clips = [...all.values()];
  if (clips.length > MAX_AUDIO_CLIPS) {
    throw new Error(`${labDir}: the comic${closingPlan ? ' and the closing' : ''} need${closingPlan ? '' : 's'} ${clips.length} distinct clips and a lab may carry at most ${MAX_AUDIO_CLIPS}; shorten it`);
  }
  return { plan, ...(closingPlan ? { closingPlan } : {}), clips };
}

/** What learn/audio/ holds against the plan: the clips still to make, and the files nothing uses any more. */
function audioOnDisk(labDir: string, clips: readonly PlannedClip[]): { audioDir: string; missing: PlannedClip[]; orphans: string[] } {
  const audioDir = join(labDir, 'learn', 'audio');
  const onDisk = existsSync(audioDir) ? readdirSync(audioDir).filter((f) => CLIP_FILE.test(f)) : [];
  const have = (key: string) => onDisk.includes(`${key}.mp3`) && statSync(join(audioDir, `${key}.mp3`)).size > 0;
  const wanted = new Set(clips.map((c) => `${c.key}.mp3`));
  return { audioDir, missing: clips.filter((c) => !have(c.key)), orphans: onDisk.filter((f) => !wanted.has(f)) };
}

/** Written whole or not at all, so an interrupted run never leaves half a clip that the next run would trust. */
function writeClip(audioDir: string, key: string, bytes: Uint8Array): void {
  const tmp = join(audioDir, `.${key}.tmp`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, join(audioDir, `${key}.mp3`));
}

/** Once every clip is on disk: removes the orphans, measures each clip and writes audio.json (and closing-audio.json). */
function finishLab(labDir: string, lab: LabPlan, audioDir: string, orphans: readonly string[], model: string, result: NarrateResult, log: (line: string) => void): void {
  for (const f of orphans) {
    rmSync(join(audioDir, f));
    log(`  removed ${f} (nothing uses it)`);
  }

  const measured = new Map<string, { seconds: number; bytes: number }>();
  for (const c of lab.clips) {
    const bytes = readFileSync(join(audioDir, `${c.key}.mp3`));
    const seconds = mp3Seconds(bytes);
    if (!(seconds > 0)) throw new Error(`${c.key}.mp3 holds no audio (clip for "${c.text.slice(0, 40)}"); delete it and run again`);
    measured.set(c.key, { seconds, bytes: bytes.length });
    result.seconds += seconds;
    result.bytes += bytes.length;
  }
  const indexes: [string, NarrationPlan][] = [['audio.json', lab.plan]];
  if (lab.closingPlan) indexes.push(['closing-audio.json', lab.closingPlan]);
  for (const [name, p] of indexes) {
    const index = `${JSON.stringify(buildAudioIndex(p, measured, model), null, 2)}\n`;
    const indexPath = join(labDir, 'learn', name);
    const before = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
    if (before !== index) {
      writeFileSync(indexPath, index);
      result.wroteIndex = true;
    }
  }
}

/**
 * Narrates one lab directory: the opener (learn/comic.yaml into learn/audio.json) and, when the lab has
 * one, the closing (learn/closing.yaml into learn/closing-audio.json). Both share learn/audio/, so the
 * clips are planned together: a clip either comic uses is kept, and only clips neither uses are removed.
 * Throws an Error with the reason when it cannot.
 */
export async function narrateLab(labDir: string, opts: NarrateOptions = {}): Promise<NarrateResult> {
  const log = opts.log ?? (() => {});
  const lab = planLab(labDir);
  const { clips } = lab;
  const { audioDir, missing, orphans } = audioOnDisk(labDir, clips);
  const characters = missing.reduce((n, c) => n + c.text.length, 0);

  const result: NarrateResult = {
    lab: labDir,
    lines: lab.plan.lines.length + (lab.closingPlan?.lines.length ?? 0),
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
      writeClip(audioDir, clip.key, bytes);
      log(`  made ${clip.key}.mp3  ${clip.voice.padEnd(10)} ${bytes.length} bytes  ${clip.text}`);
    });
  }

  finishLab(labDir, lab, audioDir, orphans, TTS_MODEL, result, log);
  return result;
}

// ---------------------------------------------------------------------------
// Import: clips made by another text-to-speech, filed as if `labs narrate` had made them
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /**
   * The folder of clips: `01.mp3`, `02.mp3`, ... in voiceover order for the opener and the same in `closing/`
   * for the closing; or a `manifest.json` there that names each clip's words, matched to the comic by text.
   */
  fromDir: string;
  /** The model and voice that made the clips, stored as given (they are part of each clip's key). A manifest may give them instead. */
  model?: string;
  voice?: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

const ManifestClips = z.array(z.object({ file: z.string().min(1), text: z.string().min(1) }).strict());
/** `<fromDir>/manifest.json`: which file speaks which words, for the opener (`clips`) and the closing. */
const ImportManifestSchema = z
  .object({ model: z.string().optional(), voice: z.string().optional(), clips: ManifestClips, closing: ManifestClips.optional() })
  .strict();
type ManifestEntry = z.infer<typeof ManifestClips>[number];

/** One voiceover line and the file (relative to the clips folder) that speaks it. */
interface ImportSource {
  file: string;
  comic: string;
  line: NarrationPlan['lines'][number];
}

/** By order: `<rel>/NN.mp3`, numbered 1 to N without gaps, one per voiceover of `comic` in reading order. */
function sourcesByOrder(fromDir: string, rel: string, plan: NarrationPlan, comic: string): ImportSource[] {
  const where = join(fromDir, rel);
  const names = readdirSync(where).filter((f) => /\.mp3$/i.test(f));
  const stray = names.filter((f) => !/^\d+\.mp3$/.test(f));
  if (stray.length > 0) throw new Error(`${where}: ${stray.join(', ')} ${stray.length === 1 ? 'is' : 'are'} not named NN.mp3 (01.mp3, 02.mp3, ... in voiceover order)`);
  const files = names.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  if (files.length !== plan.lines.length) {
    throw new Error(`${where} has ${files.length} clip${files.length === 1 ? '' : 's'} but ${comic} has ${plan.lines.length} voiceover${plan.lines.length === 1 ? '' : 's'}; there must be one NN.mp3 per voiceover, in order`);
  }
  files.forEach((f, i) => {
    if (parseInt(f, 10) !== i + 1) throw new Error(`${where}: clip ${i + 1} should be ${String(i + 1).padStart(2, '0')}.mp3 but is ${f}; number the clips 1 to ${files.length} without gaps`);
  });
  return plan.lines.map((line, i) => ({ file: rel === '' ? files[i]! : join(rel, files[i]!), comic, line }));
}

/** By manifest: each entry's words must be a voiceover of `comic`, and each voiceover must have exactly one entry. */
function sourcesByText(entries: readonly ManifestEntry[], list: string, plan: NarrationPlan, comic: string): ImportSource[] {
  const voiced = new Set(plan.lines.map((l) => l.text));
  // A clip of words the comic does not have is a stale clip: refuse it rather than let it land on some panel.
  const unknown = entries.filter((e) => !voiced.has(e.text));
  if (unknown.length > 0) {
    throw new Error(`manifest.json \`${list}\`: ${unknown.length} clip${unknown.length === 1 ? ' speaks words that are' : 's speak words that are'} not a voiceover of ${comic}:\n${unknown.map((e) => `  - ${e.file}: "${e.text}"`).join('\n')}`);
  }
  const fileOf = new Map<string, string>();
  for (const e of entries) {
    if (fileOf.has(e.text)) throw new Error(`manifest.json \`${list}\`: ${fileOf.get(e.text)} and ${e.file} both speak "${e.text}"; keep one`);
    fileOf.set(e.text, e.file);
  }
  const missing = [...voiced].filter((t) => !fileOf.has(t));
  if (missing.length > 0) {
    throw new Error(`manifest.json \`${list}\` has ${entries.length} clip${entries.length === 1 ? '' : 's'} but ${comic} has ${voiced.size} distinct voiceover${voiced.size === 1 ? '' : 's'}; no clip for:\n${missing.map((t) => `  - "${t}"`).join('\n')}`);
  }
  return plan.lines.map((line) => ({ file: fileOf.get(line.text)!, comic, line }));
}

/** The flag's value, else the manifest's; both given must agree. */
function pick(name: 'model' | 'voice', flag: string | undefined, manifest: string | undefined): string {
  if (flag !== undefined && manifest !== undefined && flag !== manifest) throw new Error(`--${name} ${flag} disagrees with manifest.json's ${name} "${manifest}"; give one`);
  const value = flag ?? manifest;
  if (value === undefined) throw new Error(`--${name} is needed: the ${name} that made the clips, stored as given in audio.json (or put \`${name}\` in manifest.json)`);
  return value;
}

/**
 * Files clips made outside the repo into a lab exactly as `narrateLab` would have made them: each goes to
 * learn/audio/<clipKey(model, voice, text)>.mp3 (a key already there is reused, not overwritten), the
 * indexes are written by buildAudioIndex, and clips nothing uses are removed. Every source file is checked
 * (an MP3, under the size limit, with audio in it) before anything is written. Never calls a model.
 */
export function importNarration(labDir: string, opts: ImportOptions): NarrateResult {
  const log = opts.log ?? (() => {});
  const { fromDir } = opts;
  if (!existsSync(fromDir) || !statSync(fromDir).isDirectory()) throw new Error(`${fromDir} is not a folder of clips`);

  let manifest: z.infer<typeof ImportManifestSchema> | undefined;
  const manifestPath = join(fromDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      throw new Error(`${manifestPath}: not valid JSON (${(e as Error).message})`);
    }
    const parsed = ImportManifestSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`${manifestPath}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
    manifest = parsed.data;
  }
  const model = pick('model', opts.model, manifest?.model);
  const voice = pick('voice', opts.voice, manifest?.voice);
  if (!/^\S{1,80}$/.test(model)) throw new Error(`model "${model}" must be 1 to 80 characters with no spaces`);
  if (!VOICE_ID.test(voice)) throw new Error(`voice "${voice}" must be one token of letters, digits and . _ : / - (at most 80)`);

  const lab = planLab(labDir, model, voice);
  const hasClosingClips = manifest ? manifest.closing !== undefined : existsSync(join(fromDir, 'closing'));
  if (!lab.closingPlan && hasClosingClips) {
    throw new Error(`${fromDir} has clips for a closing (${manifest ? 'manifest.json `closing`' : 'closing/'}), but ${labDir} has no learn/closing.yaml`);
  }
  if (lab.closingPlan && !hasClosingClips) {
    throw new Error(`${labDir} has a closing comic (learn/closing.yaml): its clips are needed too, ${manifest ? 'as a `closing` list in manifest.json' : `as NN.mp3 in ${join(fromDir, 'closing')}`}`);
  }
  const sources = manifest ? sourcesByText(manifest.clips, 'clips', lab.plan, 'comic.yaml') : sourcesByOrder(fromDir, '', lab.plan, 'comic.yaml');
  if (lab.closingPlan) {
    sources.push(...(manifest ? sourcesByText(manifest.closing!, 'closing', lab.closingPlan, 'closing.yaml') : sourcesByOrder(fromDir, 'closing', lab.closingPlan, 'closing.yaml')));
  }

  // One file per key (identical words share a clip, the first file that speaks them is the one kept), each checked before anything is written.
  const fileOf = new Map<string, string>();
  for (const s of sources) if (!fileOf.has(s.line.key)) fileOf.set(s.line.key, s.file);
  const bytesOf = new Map<string, Buffer>();
  for (const [key, file] of fileOf) {
    const path = join(fromDir, file);
    if (!existsSync(path)) throw new Error(`${path} does not exist`);
    const bytes = readFileSync(path);
    if (!looksLikeMp3(bytes)) throw new Error(`${path} is not an MP3`);
    if (bytes.length > MAX_AUDIO_CLIP_BYTES) throw new Error(`${path} is ${bytes.length} bytes, over the ${MAX_AUDIO_CLIP_BYTES} limit; shorten the line`);
    if (!(mp3Seconds(bytes) > 0)) throw new Error(`${path} holds no audio`);
    bytesOf.set(key, bytes);
  }

  const { clips } = lab;
  const { audioDir, missing, orphans } = audioOnDisk(labDir, clips);
  const result: NarrateResult = {
    lab: labDir,
    lines: lab.plan.lines.length + (lab.closingPlan?.lines.length ?? 0),
    clips: clips.length,
    made: missing.length,
    characters: missing.reduce((n, c) => n + c.text.length, 0),
    reused: clips.length - missing.length,
    removed: orphans.length,
    requests: 0,
    seconds: 0,
    bytes: 0,
    wroteIndex: false,
  };

  if (opts.dryRun) {
    const toCopy = new Set(missing.map((c) => c.key));
    for (const s of sources) {
      const kept = fileOf.get(s.line.key)!;
      const what = !toCopy.has(s.line.key) ? 'already there' : kept === s.file ? 'would copy' : `same words as ${kept}`;
      log(`  ${s.file} → ${s.comic} panel ${s.line.panel + 1} → ${s.line.key}.mp3 (${what})  ${s.line.text}`);
    }
    for (const f of orphans) log(`  would remove ${f} (nothing uses it)`);
    return result;
  }

  if (missing.length > 0) mkdirSync(audioDir, { recursive: true });
  for (const c of missing) {
    writeClip(audioDir, c.key, bytesOf.get(c.key)!);
    log(`  copied ${fileOf.get(c.key)} → ${c.key}.mp3  ${c.text}`);
  }
  finishLab(labDir, lab, audioDir, orphans, model, result, log);
  return result;
}
