import type { SessionRuntime } from './state';
import type { FileEncoding, FileInfo, ListFilesResult } from './backend';
import { STAGE_DIR, ensureStageDir } from './hydrate';
import { WORKSPACE_ROOT } from '../lib/paths';
import { ApiError } from '../lib/errors';

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

async function run(rt: SessionRuntime, argv: readonly [string, ...string[]]): Promise<Ran> {
  const proc = await rt.backend().exec(argv, EXEC_OPTIONS);
  const out = await proc.output();
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

export async function readWorkspaceFile(rt: SessionRuntime, path: string): Promise<{ content: string; encoding?: FileEncoding }> {
  const r = await run(rt, ['sh', '-c', READ_SCRIPT, '_', path]);
  if (r.exitCode !== 0) throw failure(r, 'read');

  const base64 = r.stdout.trim();
  try {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    // Not valid UTF-8: hand the bytes back as base64, as the SDK does.
    return { content: base64, encoding: 'base64' };
  }
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

export async function listWorkspaceDir(rt: SessionRuntime, path: string): Promise<ListFilesResult> {
  const r = await run(rt, ['sh', '-c', LIST_SCRIPT, '_', path]);
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
