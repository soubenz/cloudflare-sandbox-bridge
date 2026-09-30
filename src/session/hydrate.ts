import type { SessionRuntime } from './state';
import { workspaceKey, privateKey } from '../labs/bundle';

async function runOrThrow(rt: SessionRuntime, argv: readonly [string, ...string[]], what: string): Promise<void> {
  const proc = await rt.backend().exec(argv, { timeout: 60_000 });
  const out = await proc.output();
  if (out.exitCode !== 0) {
    throw new Error(`${what} failed (exit ${out.exitCode}): ${new TextDecoder().decode(out.stderr).slice(0, 500)}`);
  }
}

/**
 * Archives are staged in a root-only directory, never the world-writable
 * temp dir: the learner can write there and could otherwise replace an
 * archive between the Worker's writeFile and the extract exec. Init creates
 * this directory at boot; ensureStageDir repeats it (idempotent, root) for
 * a warm container that predates that change. The SDK's writeFile has no
 * permissions option and is not known to create parents, so the directory
 * is created in its own exec first and the archive is chmod 0600'd inside
 * the single extract command.
 */
export const STAGE_DIR = '/run/opalix/stage';

export function stagePath(id: string): string {
  return `${STAGE_DIR}/${id}.tgz`;
}

export async function ensureStageDir(rt: SessionRuntime): Promise<void> {
  await runOrThrow(
    rt,
    ['sh', '-c', `mkdir -p ${STAGE_DIR} && chmod 0700 /run/opalix ${STAGE_DIR} && chown root:root /run/opalix ${STAGE_DIR}`],
    'stage dir setup'
  );
}

/** Shell prefix for an extract command: refuse a non-root-owned archive, then lock its mode. */
export function archiveGuard(archive: string): string {
  return `[ "$(stat -c %u ${archive})" = 0 ] || exit 97; chmod 0600 ${archive}`;
}

/** Best-effort removal so a failed extract leaves no archive behind. */
export async function removeStaged(rt: SessionRuntime, archive: string): Promise<void> {
  await rt.backend().exec(['rm', '-f', archive]).catch(() => {});
}

/**
 * Extracts workspace.tgz (learner-visible files) to /workspace as the
 * `learner` user. Skipped on resume when a snapshot is restored instead
 * (see lifecycle.resume) — restoreBackup() replaces this entirely.
 *
 * Delivery is `writeFile` of the whole archive in one call. Archives are
 * deliberately not served to the container over an egress host: any such
 * handler would be reachable from the learner's terminal.
 */
export async function hydrateWorkspaceFiles(rt: SessionRuntime, labSlug: string, labVersion: string): Promise<void> {
  const backend = rt.backend();
  const workspaceObj = await rt.env.LABS_BUCKET.get(workspaceKey(labSlug, labVersion));
  if (!workspaceObj) throw new Error(`workspace bundle missing for ${labSlug}@${labVersion}`);
  const archive = stagePath(`workspace-${crypto.randomUUID()}`);
  await ensureStageDir(rt);
  try {
    await backend.writeFile(archive, workspaceObj.body);
    await runOrThrow(
      rt,
      [
        'sh',
        '-c',
        `${archiveGuard(archive)} && tar xzf ${archive} -C /workspace --no-same-owner && chown -R learner:learner /workspace && rm -f ${archive}`,
      ],
      'workspace hydrate'
    );
  } finally {
    await removeStaged(rt, archive);
  }
}

/**
 * Extracts only pressure/ from private.tgz to /opt/lab, persistently for
 * the session's lifetime (root-owned, 0700 — pressure events fire on a
 * schedule throughout the session so their scripts must already be in
 * place). checks/ is deliberately NOT extracted here — see checks.ts,
 * which stages private.tgz fresh into an ephemeral dir at check time and
 * deletes it after, so grader scripts are never resident between runs.
 * Called on every start AND every resume (unlike workspace files, which a
 * resume gets from restoreBackup instead).
 */
export async function hydratePressureScripts(rt: SessionRuntime, labSlug: string, labVersion: string): Promise<void> {
  const backend = rt.backend();
  const privateObj = await rt.env.LABS_BUCKET.get(privateKey(labSlug, labVersion));
  if (!privateObj) throw new Error(`private bundle missing for ${labSlug}@${labVersion}`);
  const archive = stagePath(`private-${crypto.randomUUID()}`);
  await ensureStageDir(rt);
  try {
    await backend.writeFile(archive, privateObj.body);
    await runOrThrow(
      rt,
      [
        'sh',
        '-c',
        `${archiveGuard(archive)}; rm -rf /opt/lab && mkdir -m 700 -p /opt/lab && tar xzf ${archive} -C /opt/lab --no-same-owner --wildcards 'pressure/*' 2>/dev/null; chown -R root:root /opt/lab && rm -f ${archive}`,
      ],
      'private bundle hydrate'
    );
  } finally {
    await removeStaged(rt, archive);
  }
}

/**
 * Makes the session's environment actually visible inside the container.
 * Three routes, because no single one reaches everything:
 *
 *  - DO storage, which is the authoritative copy: every exec that needs
 *    the env reads it back from there and passes it explicitly. The SDK's
 *    `setEnvVars` keeps an in-memory field on the Sandbox DO that it does
 *    not restore after an eviction, so it is a convenience for ad-hoc
 *    execs, never the mechanism.
 *  - `/etc/opalix/session.env` is a file an agent or service can read
 *    directly, and is what the LLM egress contract refers to.
 *  - `/etc/profile.d/opalix.sh` exists because the terminal is opened with
 *    `su -l learner`, and a login shell resets the environment — without
 *    the drop-in the learner sees none of the lab's declared env, which
 *    makes any lab whose task references it unsolvable.
 */
export async function applySessionEnv(rt: SessionRuntime, vars: Record<string, string>): Promise<void> {
  const backend = rt.backend();
  await rt.putSessionEnv(vars);
  await backend.setEnvVars(vars);
  // Only well-formed identifiers: this file is sourced by every login
  // shell, so a key like `A`cmd`` or `MY-KEY` would be executed or would
  // break the shell's startup. parseManifest rejects these at publish
  // time; this is the second line of defence.
  const lines = Object.entries(vars)
    .filter(([k]) => SHELL_IDENTIFIER.test(k))
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`);
  await backend.writeFile(
    '/etc/opalix/session.env',
    `# Generated by Opalix at session start. Do not edit.\n${lines.join('\n')}\n`
  );
  await backend.writeFile(
    '/etc/profile.d/opalix.sh',
    '[ -r /etc/opalix/session.env ] && . /etc/opalix/session.env\n'
  );
}

const SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Single-quoted, so nothing in a lab-authored value is expanded by the shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
