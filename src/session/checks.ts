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
  const out = await proc.output();
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
    const pass = out.exitCode === 0 && !out.timedOut;
    const parsed = parseCheckOutput(out.stdout);
    const message = parsed?.message ?? lastNonEmptyLine(out.stdout) ?? (pass ? 'ok' : 'failed');
    return {
      name: check.name,
      pass: parsed?.pass ?? pass,
      message: pass ? message : `${message}\n${out.stderr.slice(-1024)}`.trim(),
      duration_ms,
      exit_code: out.exitCode,
      timed_out: out.timedOut,
      weight: check.weight,
    };
  } catch (err) {
    return {
      name: check.name,
      pass: false,
      message: `check errored: ${String(err)}`,
      duration_ms: Date.now() - started,
      exit_code: -1,
      timed_out: false,
      weight: check.weight,
    };
  }
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
