import type { SessionRuntime } from './state';
import type { FileEncoding, FileInfo, ListFilesResult } from './backend';
import { STAGE_DIR, ensureStageDir } from './hydrate';
import { WORKSPACE_ROOT } from '../lib/paths';
import { ApiError } from '../lib/errors';
import { workspacePath } from '../lib/paths';
import type { OpTiming } from '../lib/timing';

/**
 * Files API against the container, in two layers, because `workspacePath()`
 * is lexical and a learner owns /workspace: `ln -s /opt/lab /workspace/leak`
 * makes `leak/...` a lexically clean path that the Worker (root) would
 * happily follow to root-only material, and a PUT through
 * `x -> /etc/profile.d/evil.sh` would be a root write from a session token.
 *
 *  1. Realpath fence: resolve the path (root, `realpath -m`, so it works for
 *     files that do not exist yet) and refuse anything that lands outside
 *     /workspace. Cheap, and gives the obvious probes a clean 400.
 *  2. Kernel enforcement: the operation itself runs as `learner` via
 *     `runuser`. Whatever a symlink points at, learner can only reach what
 *     learner can reach, and the check is made by the kernel at open time,
 *     so a link swapped in after the fence (TOCTOU) gains nothing.
 *
 * A permission failure and a fence failure answer identically (400
 * bad_path), so probing with symlinks does not reveal what exists behind
 * them.
 */

/** Same cap the route applies; repeated here because this is where bytes (not UTF-16 units) are known. */
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;

/**
 * The fence is the head of every script below, so a file operation is ONE container call (each call costs
 * ~200 ms; a separate fence call doubled the time to open a file). 97 is not an exit code any of the learner-side
 * commands uses, so it can only mean "the path escapes /workspace".
 */
const FENCE_ESCAPES = 97;
const FENCE = `p=$(realpath -m -- "$1") || exit 1; case "$p" in /workspace|/workspace/*) ;; *) exit ${FENCE_ESCAPES};; esac;`;

// Absolute path: the Worker's exec runs as root, and util-linux puts runuser
// in /usr/sbin, which is not guaranteed to be on the PATH exec inherits.
// Confirmed present in both live images at /usr/sbin/runuser.
const AS_LEARNER = ['/usr/sbin/runuser', '-u', 'learner', '--'] as const;

/** The fence, then `inner` (a `sh -c` script taking the path as $1) as learner. */
const fencedAsLearner = (inner: string) => `${FENCE} exec ${AS_LEARNER.join(' ')} sh -c '${inner}' _ "$1"`;

const READ_SCRIPT = fencedAsLearner('base64 -w0 -- "$1"');
const LIST_SCRIPT = fencedAsLearner('cd -- "$1" && find . -mindepth 1 -maxdepth 1 -printf "%y\\t%s\\t%T@\\t%f\\0"');
const DELETE_SCRIPT = fencedAsLearner('rm -f -- "$1"');
/**
 * Runs as root so the redirect from the root-only stage file is opened by
 * root (the stage dir is 0700 and learner must not be able to enter it); the
 * inherited descriptor is then all learner's `cat` ever sees. `mkdir -p` is
 * learner's too, so a parent chain can never be created outside what learner
 * may write.
 */
const WRITE_SCRIPT = `${FENCE} exec ${AS_LEARNER.join(' ')} sh -c 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"' _ "$1" < "$2"`;

const EXEC_OPTIONS = { timeout: 30_000, cwd: '/' } as const;

interface Ran {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return '';
}

/** One exec; with `timing`, starting the process and waiting for its output are timed apart (see lib/timing.ts). */
async function run(rt: SessionRuntime, argv: readonly [string, ...string[]], timing?: OpTiming): Promise<Ran> {
  const timed = <T>(name: string, fn: () => Promise<T>) => (timing ? timing.time(name, fn) : fn());
  const proc = await timed('exec', () => rt.backend().exec(argv, EXEC_OPTIONS));
  const out = await timed('output', () => proc.output());
  return { exitCode: out.exitCode, stdout: asText(out.stdout), stderr: asText(out.stderr) };
}

function escapes(): ApiError {
  return ApiError.badRequest('bad_path', `path escapes ${WORKSPACE_ROOT}`);
}

/** Maps a failed learner-side operation to the API error the caller should see. */
function failure(r: Ran, what: string): ApiError {
  if (r.exitCode === FENCE_ESCAPES) return escapes();
  const err = r.stderr;
  if (/Permission denied|Is a directory|Not a directory/i.test(err)) return escapes();
  if (/No such file or directory/i.test(err)) return ApiError.notFound('not_found', `No such file or directory: ${what}`);
  return ApiError.internal(`${what} failed (exit ${r.exitCode}): ${err.slice(0, 500)}`);
}

export async function readWorkspaceFile(rt: SessionRuntime, path: string, timing?: OpTiming): Promise<{ content: string; encoding?: FileEncoding }> {
  const r = await run(rt, ['sh', '-c', READ_SCRIPT, '_', path], timing);
  if (r.exitCode !== 0) throw failure(r, 'read');
  return decoded(r.stdout.trim());
}

/** The file's bytes as text when they are UTF-8, else as the base64 they came in as (the SDK's shape). */
function decoded(base64: string, bytes = fromBase64(base64)): { content: string; encoding: FileEncoding } {
  try {
    return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { content: base64, encoding: 'base64' };
  }
}

function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
}

// ------------------------------------------------------------ batch read

/** At most this many paths in one batch read, so one call stays one bounded exec. */
export const MAX_BATCH_FILES = 30;
/** A file larger than this is answered `too_large` in a batch; the single read still returns it. */
export const MAX_BATCH_FILE_BYTES = 256 * 1024;

/**
 * Many files in ONE container call: the console reads the files its tree shows ahead of a click, so opening
 * one is not a container round trip (each costs ~0.5-0.8 s end to end).
 *
 * The same two layers as a single read, per path. Root runs the realpath fence over every path and blanks the
 * ones that land outside /workspace; then ONE `runuser` hands the whole list to learner, who stats and reads
 * each. A blank is answered as an escape without being touched. Only a regular file is read (a FIFO or a link
 * to /dev/zero would block or never end), and only up to the size cap, checked by stat first and again on the
 * bytes that came back, since a file can grow in between.
 *
 * One line per path, in order: `E` (escapes, a directory, unreadable), `N` (missing), `L <size>` (too large),
 * `O <base64>` (the bytes), or `O <base64> !` when the read itself failed after the checks.
 */
const BATCH_FENCE =
  'n=$#; i=0; while [ "$i" -lt "$n" ]; do a=$1; shift; p=$(realpath -m -- "$a") || p=; ' +
  'case "$p" in /workspace|/workspace/*) set -- "$@" "$a";; *) set -- "$@" "";; esac; i=$((i+1)); done;';
const BATCH_READ =
  'for f; do ' +
  'if [ -z "$f" ]; then echo E; continue; fi; ' +
  'if ! s=$(stat -L -c %s -- "$f" 2>&1); then case "$s" in *"No such file"*) echo N;; *) echo E;; esac; continue; fi; ' +
  'if [ ! -f "$f" ] || [ ! -r "$f" ]; then echo E; continue; fi; ' +
  `if [ "$s" -gt ${MAX_BATCH_FILE_BYTES} ]; then echo "L $s"; continue; fi; ` +
  'printf "O "; base64 -w0 -- "$f" 2>/dev/null || printf " !"; echo; ' +
  'done';
const BATCH_SCRIPT = `${BATCH_FENCE} exec ${AS_LEARNER.join(' ')} sh -c '${BATCH_READ}' _ "$@"`;

export type BatchReadEntry =
  | { path: string; content: string; encoding: FileEncoding }
  | { path: string; error: { code: 'bad_path' | 'not_found' | 'too_large'; message: string } };

/**
 * The batch body: `{ "paths": ["send_calls.py", "gateway/config.yaml"] }`, 1 to MAX_BATCH_FILES strings,
 * each a path as the single read's URL takes it (relative to /workspace, or absolute inside it).
 */
export function parseBatchReadBody(text: string): string[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw ApiError.badRequest('bad_batch', 'Body must be JSON: {"paths": ["file.py", ...]}');
  }
  const paths = (body as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string' && p !== '')) {
    throw ApiError.badRequest('bad_batch', '"paths" must be a non-empty array of file paths');
  }
  if (paths.length > MAX_BATCH_FILES) {
    throw ApiError.badRequest('bad_batch', `At most ${MAX_BATCH_FILES} paths per batch read`, { max: MAX_BATCH_FILES });
  }
  return paths as string[];
}

/**
 * Reads `paths` (as the client gave them) in one exec and answers each in order: its content, or why not.
 * A path `workspacePath` refuses never reaches the container; when no path is left, no exec runs at all.
 */
export async function readWorkspaceFiles(rt: SessionRuntime, paths: string[], timing?: OpTiming): Promise<BatchReadEntry[]> {
  const escaped = (path: string): BatchReadEntry => ({ path, error: { code: 'bad_path', message: `path escapes ${WORKSPACE_ROOT}` } });
  const resolved = paths.map((path) => {
    try {
      return workspacePath(path);
    } catch {
      return null;
    }
  });
  const absolute = resolved.filter((p): p is string => p !== null);
  if (absolute.length === 0) return paths.map(escaped);

  const r = await run(rt, ['sh', '-c', BATCH_SCRIPT, '_', ...absolute], timing);
  if (r.exitCode !== 0) throw failure(r, 'read');
  const lines = r.stdout.split('\n');
  if (lines.pop() !== '' || lines.length !== absolute.length) {
    throw ApiError.internal(`batch read answered ${lines.length} lines for ${absolute.length} paths`);
  }

  let next = 0;
  return paths.map((path, i): BatchReadEntry => {
    if (resolved[i] === null) return escaped(path);
    const line = lines[next++]!;
    if (line === 'N') return { path, error: { code: 'not_found', message: `No such file or directory: ${path}` } };
    if (line.startsWith('L ')) return tooLarge(path, Number(line.slice(2)));
    if (!line.startsWith('O ') || line.endsWith(' !')) return escaped(path);
    const base64 = line.slice(2);
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(base64);
    } catch {
      return escaped(path);
    }
    if (bytes.length > MAX_BATCH_FILE_BYTES) return tooLarge(path, bytes.length);
    return { path, ...decoded(base64, bytes) };
  });
}

function tooLarge(path: string, size: number): BatchReadEntry {
  return {
    path,
    error: { code: 'too_large', message: `${path} is ${size} bytes; a batch read returns files up to ${MAX_BATCH_FILE_BYTES} bytes (read it on its own)` },
  };
}

export async function writeWorkspaceFile(rt: SessionRuntime, path: string, content: string): Promise<void> {
  if (new TextEncoder().encode(content).length > MAX_WRITE_BYTES) {
    throw ApiError.payloadTooLarge('File exceeds 2 MiB write limit');
  }

  const staged = `${STAGE_DIR}/write-${crypto.randomUUID()}`;
  await ensureStageDir(rt);
  try {
    await rt.backend().writeFile(staged, content);
    const r = await run(rt, ['sh', '-c', WRITE_SCRIPT, '_', path, staged]);
    if (r.exitCode !== 0) throw failure(r, 'write');
  } finally {
    await rt.backend().exec(['rm', '-f', staged]).catch(() => {});
  }
}

export async function listWorkspaceDir(rt: SessionRuntime, path: string, timing?: OpTiming): Promise<ListFilesResult> {
  const r = await run(rt, ['sh', '-c', LIST_SCRIPT, '_', path], timing);
  if (r.exitCode !== 0) throw failure(r, 'list');

  const base = path.replace(/\/+$/, '');
  const files: FileInfo[] = [];
  for (const record of r.stdout.split('\0')) {
    if (record === '') continue;
    // name is last and may itself contain tabs, so only the first three separators count.
    const [kind, size, mtime, ...rest] = record.split('\t');
    const name = rest.join('\t');
    files.push({
      name,
      absolutePath: `${base}/${name}`,
      relativePath: name,
      type: kind === 'f' ? 'file' : kind === 'd' ? 'directory' : kind === 'l' ? 'symlink' : 'other',
      size: Number(size) || 0,
      modifiedAt: new Date((Number(mtime) || 0) * 1000).toISOString(),
    });
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { files, count: files.length };
}

export async function deleteWorkspaceFile(rt: SessionRuntime, path: string): Promise<void> {
  const r = await run(rt, ['sh', '-c', DELETE_SCRIPT, '_', path]);
  if (r.exitCode !== 0) throw failure(r, 'delete');
}
