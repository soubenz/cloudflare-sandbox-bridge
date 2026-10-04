import type { LabManifest, CheckSpec } from '../labs/manifest';
import type { SessionRuntime, CheckResultEntry, ChecksRun } from './state';
import { emitEvent } from './events';
import { privateKey } from '../labs/bundle';
import { newId } from '../lib/ids';
import { insertCheckRun, bestEffort } from './d1';
import { scoreRun } from './progress';
import { ensureStageDir, stagePath, archiveGuard, removeStaged } from './hydrate';
import { tryEmitSolutionUnlocked } from './solution';
import { announceNewAwards } from '../profile/notify';
import { refreshPath } from '../path/service';
import { ApiError } from '../lib/errors';

/**
 * Runs the lab's checker scripts and returns structured, per-criterion
 * results. Grader scripts are fetched from R2 into a root-only, per-run
 * directory and deleted afterward — never left resident in the container,
 * and never under /workspace, so a learner shell (running as `learner`)
 * cannot read them mid-session. See the design rule in the plan: "Check
 * scripts are never resident in the container between runs."
 */
export async function runChecks(rt: SessionRuntime, manifest: LabManifest, only?: string[]): Promise<ChecksRun> {
  // Validate first, so a rejected request neither takes the in-flight slot nor starts the interval.
  const checksToRun = selectChecks(manifest, only);
  if (checksToRun.length === 0) {
    // Nothing to execute: no events, no stored run, no check_runs row, no award recompute.
    const now = Date.now();
    return { run_id: newId(), started_at: now, finished_at: now, results: [] };
  }

  // One run at a time (409), and one per CHECK_MIN_INTERVAL_MS (429): every
  // finished run costs a D1 insert and an award recompute over the user's runs.
  // The slot is taken before the first await so two concurrent requests cannot both pass.
  if (checksInFlight.has(rt)) throw ApiError.conflict('checks_running', 'A check run is already in progress for this session');
  checksInFlight.add(rt);
  try {
    const last = await rt.lastChecks();
    const wait = last ? last.started_at + CHECK_MIN_INTERVAL_MS - Date.now() : 0;
    if (wait > 0) {
      // `retry_after_ms` is in the message too: details do not survive the DO RPC boundary (see fromSdkError).
      throw new ApiError(429, 'checks_too_frequent', `Checks can run once every ${CHECK_MIN_INTERVAL_MS / 1000} seconds; retry_after_ms=${wait}`, {
        retry_after_ms: wait,
      });
    }
    return await executeChecks(rt, manifest, checksToRun);
  } finally {
    checksInFlight.delete(rt);
  }
}

/** The shortest gap between the starts of two check runs of one session. */
export const CHECK_MIN_INTERVAL_MS = 2000;
const checksInFlight = new WeakSet<SessionRuntime>();

/** The manifest's checks named by `only` (all of them when it is absent). Throws 400 `unknown_check` for a selection that names no real check. */
export function selectChecks(manifest: LabManifest, only?: unknown): CheckSpec[] {
  if (only === undefined || only === null) return manifest.checks;
  const valid = manifest.checks.map((c) => c.name);
  const listed = `Valid checks: ${valid.join(', ')}`;
  if (!Array.isArray(only) || only.length === 0 || only.some((n) => typeof n !== 'string')) {
    throw ApiError.badRequest('unknown_check', `"only" must be a non-empty array of check names. ${listed}`, { valid });
  }
  const unknown = [...new Set(only as string[])].filter((n) => !valid.includes(n));
  if (unknown.length > 0) {
    throw ApiError.badRequest('unknown_check', `No such check: ${unknown.map((n) => JSON.stringify(n.slice(0, 80))).join(', ')}. ${listed}`, { unknown, valid });
  }
  return manifest.checks.filter((c) => (only as string[]).includes(c.name));
}

async function executeChecks(rt: SessionRuntime, manifest: LabManifest, checksToRun: CheckSpec[]): Promise<ChecksRun> {
  const backend = rt.backend();
  const runId = newId();
  const dir = `/run/opalix/checks-${runId}`;

  await rt.touchInput();

  const run: ChecksRun = { run_id: runId, started_at: Date.now(), results: [] };
  await rt.putLastChecks(run);
  emitEvent(rt, 'check.started', { run_id: runId, total: checksToRun.length });

  try {
    await stageCheckScripts(rt, dir, runId);
    const parallel = checksToRun.filter((c) => c.parallel);
    const sequential = checksToRun.filter((c) => !c.parallel);

    for (const check of sequential) {
      const result = await runOneCheck(rt, backend, dir, check, manifest.env);
      run.results.push(result);
      await rt.putLastChecks(run);
      emitEvent(rt, 'check.result', result);
    }
    if (parallel.length > 0) {
      const results = await Promise.all(parallel.map((check) => runOneCheck(rt, backend, dir, check, manifest.env)));
      for (const result of results) {
        run.results.push(result);
        emitEvent(rt, 'check.result', result);
      }
      await rt.putLastChecks(run);
    }
  } finally {
    await backend.exec(['rm', '-rf', dir]).catch(() => {});
  }

  run.finished_at = Date.now();
  await rt.putLastChecks(run);
  const { passed, score, passed_all } = scoreRun(run.results, manifest.checks.length);
  emitEvent(rt, 'check.finished', { run_id: runId, passed, total: run.results.length, score });

  await rt
    .appendChecksHistory({
      run_id: runId,
      started_at: run.started_at,
      finished_at: run.finished_at,
      passed,
      total: run.results.length,
      score,
      results: run.results.map((r) => ({ name: r.name, pass: r.pass, weight: r.weight })),
    })
    .catch((err) => emitEvent(rt, 'alert', { kind: 'checks_history_failed', error: String(err) }));

  // The run counter behind the solution unlock rule. Its own key, not the
  // length of the history above, which keeps only the last ten runs.
  await rt
    .recordCheckRun(passed_all)
    .catch((err) => emitEvent(rt, 'alert', { kind: 'check_run_count_failed', error: String(err) }));
  await tryEmitSolutionUnlocked(rt, manifest);

  // A run that executed nothing is never written (it would be an empty row that still triggers the award recompute).
  if (run.results.length === 0) return run;

  const meta = await rt.requireMeta();
  // The awards are recomputed only once the run is in D1, because they are
  // derived from `check_runs`. Both stay off the critical path: this is not awaited.
  bestEffort(
    insertCheckRun(rt.env, meta.id, run, {
      user_id: meta.user_id,
      lab_slug: meta.lab_slug,
      lab_version: meta.lab_version,
      total_checks: manifest.checks.length,
    })
      .then(() => announceNewAwards(rt, meta.user_id, meta.id))
      .then(() =>
        // A lab just completed: bring the learner's path up to date (rules only, no model call). Best
        // effort and after the row is written, so a failure here never touches the run or its result.
        passed_all ? refreshPath(rt.env, meta.user_id) : undefined
      ),
    'insertCheckRun / awards / refreshPath'
  );
  return run;
}

const STAGE_TIMEOUT_MS = 60_000;

async function stageCheckScripts(rt: SessionRuntime, dir: string, runId: string): Promise<void> {
  const meta = await rt.requireMeta();
  const obj = await rt.env.LABS_BUCKET.get(privateKey(meta.lab_slug, meta.lab_version));
  if (!obj) throw new Error(`private bundle missing for ${meta.lab_slug}@${meta.lab_version}`);
  const backend = rt.backend();
  const archive = stagePath(`checks-${runId}`);
  await ensureStageDir(rt);
  try {
    await backend.writeFile(archive, obj.body);
    // tar's stderr was discarded and its status was thrown away by the
    // trailing `rm`, so the exit check below could never see a failed
    // extraction: every grader would instead die with a bare "no such file"
    // and nothing would say why. Keep tar's status, keep its stderr, and
    // clean up either way. The archive sits in a root-only directory and
    // is refused unless root-owned (exit 97), so the learner cannot swap it.
    const proc = await backend.exec([
      'sh',
      '-c',
      `${archiveGuard(archive)} || exit $?
mkdir -m 700 -p ${dir} || exit 1
tar xzf ${archive} -C ${dir} --no-same-owner --wildcards 'checks/*'
status=$?
rm -f ${archive}
chown -R root:root ${dir}
chmod 700 ${dir}
exit $status`,
    ]);
    // Bounded, unlike every other output() call here: a wedged tar would
    // otherwise hang the whole check run with no deadline at all. utf8 so the
    // failure message below is text rather than a byte array.
    const out = await proc.output({ encoding: 'utf8', timeout: STAGE_TIMEOUT_MS });
    if (out.exitCode !== 0) {
      const why = (out.stderr || out.stdout || '').trim().slice(-400);
      throw new Error(
        `failed to stage check scripts (exit ${out.exitCode})${why ? `: ${why}` : ''}. ` +
          `The lab's private bundle must contain a checks/ directory.`
      );
    }
  } finally {
    await removeStaged(rt, archive);
  }
}

async function runOneCheck(
  rt: SessionRuntime,
  backend: ReturnType<SessionRuntime['backend']>,
  dir: string,
  check: CheckSpec,
  labEnv: Record<string, string>
): Promise<CheckResultEntry> {
  const started = Date.now();
  const scriptPath = `${dir}/checks/${check.script}`;
  try {
    // Check scripts see the lab's declared env, same as the learner does:
    // a grader asserting on configured behaviour needs the configuration.
    const proc = await backend.exec(['bash', scriptPath], {
      cwd: '/workspace',
      env: { ...labEnv, OPALIX_CHECK_NAME: check.name },
      timeout: check.timeout_s * 1000,
    });
    const out = await proc.output({ encoding: 'utf8', timeout: check.timeout_s * 1000 });
    const duration_ms = Date.now() - started;
    const { pass, message } = summarizeCheckOutput(out);
    return {
      name: check.name,
      pass,
      message,
      duration_ms,
      exit_code: out.exitCode,
      timed_out: out.timedOut,
      weight: check.weight,
    };
  } catch (err) {
    const { timed_out, message } = classifyCheckError(err, check.timeout_s);
    if (!timed_out) console.error('check errored', { session_id: rt.sessionId, check: check.name }, err);
    return {
      name: check.name,
      pass: false,
      message,
      duration_ms: Date.now() - started,
      exit_code: -1,
      timed_out,
      weight: check.weight,
    };
  }
}

/**
 * Classifies an error thrown while running one check as "the check ran out
 * of time" or "the check broke". `proc.output({ timeout })` does not return
 * a result with `timedOut: true` when it overruns — it *throws* the SDK's
 * ProcessWaitTimeoutError, so the timeout lands in runOneCheck's catch and
 * used to be reported as `timed_out: false`, erasing the one field that
 * tells a lab author their checker is merely slow.
 *
 * Matched by `name`, not `instanceof`: Workers RPC preserves a thrown
 * error's `name` and `message` across the DO boundary but drops the class
 * (the same constraint fromSdkError in src/lib/errors.ts works around), so
 * an `err instanceof ProcessWaitTimeoutError` test would be false exactly
 * where it matters. `output()` is the only wait runOneCheck performs, and
 * ProcessWaitTimeoutError is the only timeout it raises.
 */
const CHECK_TIMEOUT_ERROR_NAMES = new Set(['ProcessWaitTimeoutError']);

export function classifyCheckError(err: unknown, timeoutS: number): { timed_out: boolean; message: string } {
  const name = (err as { name?: string } | undefined)?.name;
  if (name !== undefined && CHECK_TIMEOUT_ERROR_NAMES.has(name)) {
    // Deliberately not the SDK's wording ("Process output did not complete
    // within 60000ms"): the author configured timeout_s, and that is the
    // number they can change.
    return { timed_out: true, message: `check exceeded its timeout_s of ${timeoutS}s` };
  }
  // The error text (SDK, container, RPC) is internal and this message reaches
  // the learner's browser; runOneCheck logs the original against the session.
  return { timed_out: false, message: 'check errored: the grader could not be run' };
}

/**
 * Turns one check process's output into the pass/message pair we report.
 * A script's JSON result line wins over its exit status, so the stderr tail
 * is appended on the *reported* verdict — a script that prints
 * `{"pass": true, ...}` and still exits non-zero must not hand the learner
 * a green check with an error dump stapled to it.
 */
export function summarizeCheckOutput(out: {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}): { pass: boolean; message: string } {
  const exitPass = out.exitCode === 0 && !out.timedOut;
  const parsed = parseCheckOutput(out.stdout);
  const pass = parsed?.pass ?? exitPass;
  const message = parsed?.message ?? lastNonEmptyLine(out.stdout) ?? (pass ? 'ok' : 'failed');
  return { pass, message: pass ? message : `${message}\n${out.stderr.slice(-1024)}`.trim() };
}

export function parseCheckOutput(stdout: string): { pass: boolean; message: string } | undefined {
  const line = lastNonEmptyLine(stdout);
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null && 'pass' in parsed && 'message' in parsed) {
      return { pass: Boolean(parsed.pass), message: String(parsed.message) };
    }
  } catch {
    // Not JSON; fall through to plain-text last line.
  }
  return undefined;
}

export function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1);
}
