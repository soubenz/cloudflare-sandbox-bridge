import type { Env } from '../env';
import type { LabManifest } from '../labs/manifest';
import type { SessionRuntime, SessionMeta } from './state';
import { solutionKey } from '../labs/bundle';
import { emitEvent } from './events';
import { gunzip, parseTar, type TarFile } from '../lib/tar';

/**
 * Solution reveal: once a learner has made a real attempt, the lab's
 * solution/ is shown to them as files to diff against their own work.
 *
 * This module holds the unlock rule (a pure function), the status block,
 * the one-shot `solution.unlocked` event, and the reader that turns the
 * stored tarball into the files the route returns.
 */

/** The fixed, human-readable form of the rule, shown to the learner verbatim. */
export const SOLUTION_RULE = 'Pass every check, or use every hint and run the checks twice.';

/** With every hint delivered, this many check runs are also needed. */
export const SOLUTION_MIN_CHECK_RUNS = 2;

export interface SolutionProgress {
  check_runs: number;
  hints_delivered: number;
  hints_total: number;
  /** Some run passed every check the lab defines (the condition behind D1's `completed_at`). */
  completed: boolean;
}

export interface SolutionStatus {
  /** The lab version this session runs has a solution.tgz. */
  available: boolean;
  unlocked: boolean;
  rule: string;
  progress: SolutionProgress;
}

/**
 * The unlock rule: the lab is completed, OR every hint the manifest defines
 * has been delivered and at least two check runs have happened. A lab with
 * no hints needs only the two runs. Once true it stays true, because every
 * input only grows.
 */
export function isSolutionUnlocked(p: SolutionProgress): boolean {
  if (p.completed) return true;
  return p.hints_delivered >= p.hints_total && p.check_runs >= SOLUTION_MIN_CHECK_RUNS;
}

export function buildSolutionStatus(progress: SolutionProgress, available: boolean): SolutionStatus {
  return { available, unlocked: isSolutionUnlocked(progress), rule: SOLUTION_RULE, progress };
}

/** This session's standing against the rule, from what the DO has stored. */
export async function solutionProgress(rt: SessionRuntime, manifest?: LabManifest): Promise<SolutionProgress> {
  const [check_runs, completed, delivered] = await Promise.all([rt.checkRunCount(), rt.checksCompleted(), rt.hintsDelivered()]);
  return { check_runs, hints_delivered: delivered.length, hints_total: manifest?.hints.length ?? 0, completed };
}

/** True when the lab version has a solution.tgz. A failing R2 read is "not available", never a failed status(). */
export async function solutionAvailable(env: Env, meta: Pick<SessionMeta, 'lab_slug' | 'lab_version'>): Promise<boolean> {
  try {
    return (await env.LABS_BUCKET.head(solutionKey(meta.lab_slug, meta.lab_version))) !== null;
  } catch {
    return false;
  }
}

/**
 * Emits `solution.unlocked` the first time the rule holds, and never again.
 * Called at the end of a check run and after a hint is delivered. Nothing is
 * emitted (and the flag is left unset) for a lab version with no solution,
 * so the console is never told about a reveal that is not there. The flag is
 * DO storage, so it survives container recovery and resume.
 */
export async function maybeEmitSolutionUnlocked(rt: SessionRuntime, manifest?: LabManifest): Promise<boolean> {
  if (await rt.solutionUnlockedEmitted()) return false;
  const m = manifest ?? (await rt.manifest());
  if (!isSolutionUnlocked(await solutionProgress(rt, m))) return false;
  if (!(await solutionAvailable(rt.env, await rt.requireMeta()))) return false;
  if (!(await rt.markSolutionUnlockedEmitted())) return false;
  emitEvent(rt, 'solution.unlocked', {});
  return true;
}

/** `maybeEmitSolutionUnlocked` for callers that must not fail because of it: a problem becomes an `alert`. */
export async function tryEmitSolutionUnlocked(rt: SessionRuntime, manifest?: LabManifest): Promise<void> {
  await maybeEmitSolutionUnlocked(rt, manifest).catch((err) => emitEvent(rt, 'alert', { kind: 'solution_unlock_failed', error: String(err) }));
}

// --- Reading the stored tarball ---

export const SOLUTION_LIMITS = {
  /** Largest single file returned. */
  maxFileBytes: 64 * 1024,
  maxFiles: 40,
  /** Sum of the returned file sizes. */
  maxTotalBytes: 512 * 1024,
  /** Output cap for gunzip, against a decompression bomb. */
  maxUnpackedBytes: 16 * 1024 * 1024,
} as const;

export interface SolutionFile {
  path: string;
  content: string;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** Decodes valid UTF-8 with no NUL byte; anything else (a binary) is undefined. */
function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.indexOf(0) !== -1) return undefined;
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Picks the files to return, in path order. Files that are not text are
 * skipped silently; a text file dropped by a size or count cap sets
 * `truncated`.
 */
export function selectSolutionFiles(
  entries: readonly TarFile[],
  limits: Pick<typeof SOLUTION_LIMITS, 'maxFileBytes' | 'maxFiles' | 'maxTotalBytes'> = SOLUTION_LIMITS
): { files: SolutionFile[]; truncated: boolean } {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files: SolutionFile[] = [];
  let total = 0;
  let truncated = false;
  for (const entry of sorted) {
    const content = decodeText(entry.content);
    if (content === undefined) continue;
    if (entry.content.length > limits.maxFileBytes) {
      truncated = true;
      continue;
    }
    if (files.length >= limits.maxFiles) {
      truncated = true;
      break;
    }
    if (total + entry.content.length > limits.maxTotalBytes) {
      truncated = true;
      continue;
    }
    files.push({ path: entry.path, content });
    total += entry.content.length;
  }
  return { files, truncated };
}

/** Gunzips and untars a solution.tgz body into the response of `GET /sessions/:id/solution`. Throws TarError on a corrupt or unsafe archive. */
export async function readSolutionFiles(body: ReadableStream<Uint8Array>): Promise<{ files: SolutionFile[]; truncated: boolean }> {
  const { bytes, truncated: cut } = await gunzip(body, SOLUTION_LIMITS.maxUnpackedBytes);
  const parsed = parseTar(bytes, { tolerateTruncation: cut });
  const picked = selectSolutionFiles(parsed.files);
  return { files: picked.files, truncated: picked.truncated || cut || parsed.truncated };
}
