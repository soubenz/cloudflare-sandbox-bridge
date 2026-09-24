import type { LabManifest, CheckSpec } from '../labs/manifest';
import type { SessionRuntime, CheckResultEntry, ChecksRun } from './state';
import { emitEvent } from './events';
import { privateKey } from '../labs/bundle';
import { newId } from '../lib/ids';
import { insertCheckRun, bestEffort } from './d1';

/**
 * Runs the lab's checker scripts and returns structured, per-criterion
 * results. Grader scripts are fetched from R2 into a root-only, per-run
 * directory and deleted afterward — never left resident in the container,
 * and never under /workspace, so a learner shell (running as `learner`)
 * cannot read them mid-session. See the design rule in the plan: "Check
 * scripts are never resident in the container between runs."
 */
export async function runChecks(rt: SessionRuntime, manifest: LabManifest, only?: string[]): Promise<ChecksRun> {
  const backend = rt.backend();
  const runId = newId();
  const dir = `/run/opalix/checks-${runId}`;

  await rt.touchInput();

  const checksToRun = only ? manifest.checks.filter((c) => only.includes(c.name)) : manifest.checks;
  const run: ChecksRun = { run_id: runId, started_at: Date.now(), results: [] };
  await rt.putLastChecks(run);
  emitEvent(rt, 'check.started', { run_id: runId, total: checksToRun.length });

  try {
    await stageCheckScripts(rt, dir);
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
  const passed = run.results.filter((r) => r.pass).length;
  const totalWeight = run.results.reduce((sum, r) => sum + r.weight, 0);
  const scoreWeight = run.results.filter((r) => r.pass).reduce((sum, r) => sum + r.weight, 0);
  const score = totalWeight > 0 ? scoreWeight / totalWeight : 0;
  emitEvent(rt, 'check.finished', { run_id: runId, passed, total: run.results.length, score });

  const meta = await rt.requireMeta();
  bestEffort(insertCheckRun(rt.env, meta.id, run), 'insertCheckRun');
  return run;
}

const STAGE_TIMEOUT_MS = 60_000;

async function stageCheckScripts(rt: SessionRuntime, dir: string): Promise<void> {
  const meta = await rt.requireMeta();
  const obj = await rt.env.LABS_BUCKET.get(privateKey(meta.lab_slug, meta.lab_version));
  if (!obj) throw new Error(`private bundle missing for ${meta.lab_slug}@${meta.lab_version}`);
  const backend = rt.backend();
  await backend.writeFile('/tmp/opalix-checks-stage.tgz', obj.body);
  const proc = await backend.exec([
    'sh',
    '-c',
    `mkdir -m 700 -p ${dir} && tar xzf /tmp/opalix-checks-stage.tgz -C ${dir} --no-same-owner --wildcards 'checks/*' 2>/dev/null; chown -R root:root ${dir}; chmod 700 ${dir}; rm -f /tmp/opalix-checks-stage.tgz`,
  ]);
  // Bounded, unlike every other output() call here: a wedged tar would
  // otherwise hang the whole check run with no deadline at all.
  const out = await proc.output({ timeout: STAGE_TIMEOUT_MS });
  if (out.exitCode !== 0) throw new Error(`failed to stage check scripts (exit ${out.exitCode})`);
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
  return { timed_out: false, message: `check errored: ${String(err)}` };
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
