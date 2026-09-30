import { Command } from 'commander';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { OpalixClient } from '../client';
import { compileLearnDir } from '../learn-compile';

/**
 * The lint rules live in scripts/lint-labs.mjs (plain Node, also runnable as
 * `node scripts/lint-labs.mjs`). Loaded by a computed URL so the CLI's
 * typecheck (allowJs is off) does not try to resolve the .mjs, and typed here
 * by hand.
 */
export interface LintFinding {
  rule: string;
  file: string;
  line: number;
  message: string;
}
export interface LintModule {
  lintLab(dir: string): { errors: LintFinding[]; warnings: LintFinding[] };
  lintAndReport(dirs: string[], log?: (line: string) => void): { errors: number; warnings: number; labs: number };
}

export async function loadLintModule(): Promise<LintModule> {
  const url = new URL('../../../scripts/lint-labs.mjs', import.meta.url);
  return (await import(url.href)) as LintModule;
}

/**
 * Never publish build droppings from the author's machine.
 *
 * `workspace/` is extracted verbatim into the learner's container, so a
 * stale `.pyc` left by whoever last ran the lab locally would ship to every
 * learner and shadow the `.py` source a break-fix lab asks them to edit.
 * `.gitignore` stops them being committed; this stops them being published
 * from a working tree regardless. Snapshots already exclude `__pycache__`
 * (see session/lifecycle.ts) — this closes the same hole on the way in.
 */
export const TAR_EXCLUDES = [
  '--exclude=__pycache__',
  '--exclude=*.pyc',
  '--exclude=*.pyo',
  '--exclude=.DS_Store',
  '--exclude=.pytest_cache',
  '--exclude=.ruff_cache',
];

/**
 * Files under `solution/` that `labs publish` uploads, as sorted POSIX paths
 * relative to it. The reveal shows these to learners, so the rules are
 * narrower than what `labs test` applies:
 *
 *   - a top-level `_degenerate/` directory is never uploaded (the author's
 *     wrong answers, kept to prove the checks discriminate);
 *   - nothing under a directory or with a name starting with `.`
 *     (`.DS_Store`, `.pytest_cache`, editor droppings);
 *   - no `__pycache__` directory and no `*.pyc` / `*.pyo`;
 *   - symlinks are skipped, so nothing outside `solution/` can be pulled in.
 */
export function collectSolutionUploadFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const name = entry.name;
      if (name.startsWith('.') || name.includes('\n')) continue;
      if (entry.isSymbolicLink()) continue;
      const full = join(current, name);
      if (entry.isDirectory()) {
        if (name === '__pycache__' || (current === dir && name === '_degenerate')) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (name.endsWith('.pyc') || name.endsWith('.pyo')) continue;
        out.push(relative(dir, full).split(sep).join('/'));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * `solution/` as a gzip tarball with the files at the archive root, exactly
 * as they map onto /workspace, or undefined when there is no solution
 * directory or nothing in it to upload. The file list is explicit (`-T -`)
 * instead of `--exclude` patterns, whose matching differs between GNU tar
 * and bsdtar; the `./` prefix keeps a name that starts with `-` from being
 * read as an option. COPYFILE_DISABLE stops macOS tar adding `._` files.
 */
export function buildSolutionTgz(solutionDir: string): { tgz: Buffer; files: string[] } | undefined {
  if (!existsSync(solutionDir) || !statSync(solutionDir).isDirectory()) return undefined;
  const files = collectSolutionUploadFiles(solutionDir);
  if (files.length === 0) return undefined;
  const tgz = execFileSync('tar', ['czf', '-', '-C', solutionDir, '-T', '-'], {
    input: files.map((f) => `./${f}`).join('\n') + '\n',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    maxBuffer: 256 * 1024 * 1024,
  });
  return { tgz, files };
}

/**
 * The lab's learn/ folder as the JSON the Worker stores at `learn.json`, or
 * undefined when the lab has no learn/ folder. Throws an Error listing every
 * problem when the folder does not compile, so a lab with broken learning
 * content is never published (the same check as `labs learn-check`). The
 * Worker validates the bundle again on its side; this only spares the author
 * a round trip.
 */
export function buildLearnUpload(dir: string): { json: string; lessons: number; questions: number; fields: number } | undefined {
  const result = compileLearnDir(dir);
  if (result === null) return undefined;
  if (result.problems.length > 0) {
    const n = result.problems.length;
    throw new Error(
      `refusing to publish ${dir}: learn/ has ${n} problem${n === 1 ? '' : 's'}:\n${result.problems.map((p) => `  - ${p}`).join('\n')}\n(fix them; \`labs learn-check ${dir}\` prints the same list)`
    );
  }
  const b = result.bundle!;
  return { json: JSON.stringify(b), lessons: b.concepts.length, questions: b.questions.length, fields: b.fields.length };
}

function buildTgz(sourceDir: string, subdirs: string[]): Buffer {
  const staging = mkdtempSync(join(tmpdir(), 'opalix-publish-'));
  try {
    const present = subdirs.filter((d) => existsSync(join(sourceDir, d)));
    if (present.length === 0) return Buffer.alloc(0);
    const out = join(staging, 'bundle.tgz');
    execFileSync('tar', ['czf', out, ...TAR_EXCLUDES, '-C', sourceDir, ...present]);
    return execFileSync('cat', [out]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function registerLabsCommands(program: Command, getClient: () => OpalixClient): void {
  const labs = program.command('labs').description('Manage lab content');

  labs
    .command('list')
    .description('List published labs')
    .action(async () => {
      const rows = await getClient().listLabs();
      for (const r of rows) console.log(`${r.slug}@${r.version}\t${r.family}\t${r.type}\t${r.title}`);
    });

  labs
    .command('lint <dir...>')
    .description('Lint lab directories (leaks, -B, canonical ports, hints, brief length, pressure disclosure); exits 1 on errors')
    .action(async (dirs: string[]) => {
      const missing = dirs.filter((d) => !existsSync(join(d, 'manifest.yaml')));
      if (missing.length > 0) throw new Error(`No manifest.yaml in ${missing.join(', ')}`);
      const { errors } = (await loadLintModule()).lintAndReport(dirs);
      if (errors > 0) process.exitCode = 1;
    });

  labs
    .command('learn-check <dir...>')
    .description('Compile and validate each lab\'s learn/ folder (story, lessons, quiz, questions); exits 1 on any problem')
    .action((dirs: string[]) => {
      let failed = 0;
      for (const dir of dirs) {
        const result = compileLearnDir(dir);
        if (result === null) {
          console.log(`${dir}: no learn/ folder`);
          continue;
        }
        if (result.problems.length > 0) {
          failed++;
          console.error(`${dir}: ${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}`);
          for (const p of result.problems) console.error(`  - ${p}`);
        } else {
          const b = result.bundle!;
          console.log(`${dir}: ok (${b.concepts.length} lessons, ${b.questions.length} questions, ${b.fields.length} fields${b.story ? ', story' : ''})`);
        }
      }
      if (failed > 0) process.exitCode = 1;
    });

  labs
    .command('publish <dir>')
    .description(
      'Publish a lab directory (manifest.yaml, workspace/, checks/, pressure/, and solution/ minus _degenerate/ — stored privately, shown to learners once they have earned it; learn/ is compiled and refused if it has problems)'
    )
    .option('--force', 'overwrite a version that is already published (default: the server answers 409 version_exists)')
    .option('--skip-lint', 'publish even if `labs lint` reports errors')
    .action(async (dir: string, opts: { force?: boolean; skipLint?: boolean }) => {
      const manifestPath = join(dir, 'manifest.yaml');
      if (!existsSync(manifestPath)) throw new Error(`No manifest.yaml in ${dir}`);
      if (opts.skipLint) {
        console.warn(`WARNING: --skip-lint: not linting ${dir}`);
      } else {
        // Findings go to stderr so stdout stays the publish result.
        const { errors } = (await loadLintModule()).lintAndReport([dir], (line) => console.error(line));
        if (errors > 0) {
          throw new Error(`refusing to publish ${dir}: ${errors} lint error${errors === 1 ? '' : 's'} (fix them, or pass --skip-lint)`);
        }
      }
      const manifestJson = parseYaml(readFileSync(manifestPath, 'utf8'));

      // Compile learn/ before packing anything: a lab whose learning content
      // does not check out is refused with every problem listed.
      const learn = buildLearnUpload(dir);

      // workspace.tgz gets everything a learner should see, laid out exactly as
      // it should land at /workspace in the container: the *contents* of the
      // lab's workspace/ directory at the archive root (not nested under a
      // "workspace/" entry — hydrate.ts extracts this archive directly into
      // /workspace, so a nested folder here would land as /workspace/workspace/...),
      // plus brief.md/hints.md as siblings so the learner sees them alongside
      // their own files.
      const workspaceStaging = mkdtempSync(join(tmpdir(), 'opalix-ws-'));
      try {
        execFileSync('sh', ['-c', `mkdir -p '${workspaceStaging}' && cp -r '${dir}'/workspace/* '${workspaceStaging}/' 2>/dev/null; true`]);
        for (const f of ['brief.md', 'hints.md']) {
          if (existsSync(join(dir, f))) execFileSync('cp', [join(dir, f), join(workspaceStaging, f)]);
        }
        const workspaceTgz = execFileSync('tar', ['czf', '-', ...TAR_EXCLUDES, '-C', workspaceStaging, '.']);
        const privateTgz = buildTgz(dir, ['checks', 'pressure']);

        const form = new FormData();
        form.set('manifest', new Blob([JSON.stringify(manifestJson)], { type: 'application/json' }), 'manifest.json');
        form.set('workspace', new Blob([workspaceTgz]), 'workspace.tgz');
        form.set('private', new Blob([privateTgz.length > 0 ? privateTgz : Buffer.alloc(0)]), 'private.tgz');

        // solution/ is stored privately and revealed to a learner under the
        // unlock rule (docs/lab-authoring.md). No solution directory, nothing sent.
        const solution = buildSolutionTgz(join(dir, 'solution'));
        if (solution) {
          form.set('solution', new Blob([solution.tgz]), 'solution.tgz');
          console.error(`solution/: ${solution.files.length} file${solution.files.length === 1 ? '' : 's'} packed for the reveal`);
        }

        // learn/ is compiled to one JSON document and stored at learn.json;
        // the Worker re-validates it. No learn/ folder, nothing sent.
        if (learn) {
          form.set('learn', new Blob([learn.json], { type: 'application/json' }), 'learn.json');
          console.error(`learn/: ${learn.lessons} lesson${learn.lessons === 1 ? '' : 's'}, ${learn.questions} question${learn.questions === 1 ? '' : 's'}, ${learn.fields} field${learn.fields === 1 ? '' : 's'} compiled`);
        }

        if (opts.force) form.set('force', 'true');

        const result: { slug: string; version: string; warnings?: string[] } = await getClient().publishLab(form);
        console.log(result);
        for (const w of result.warnings ?? []) console.warn(`WARNING: ${w}`);
      } finally {
        rmSync(workspaceStaging, { recursive: true, force: true });
      }
    });

  labs
    .command('test <dir>')
    .description('Verify a lab directory: checks must fail on a fresh session and pass once solution/ is applied')
    .option('--user <id>', 'user id to start the session as', 'opalix-cli-test')
    .action(async (dir: string, opts: { user: string }) => {
      const manifestPath = join(dir, 'manifest.yaml');
      if (!existsSync(manifestPath)) throw new Error(`No manifest.yaml in ${dir}`);
      const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as {
        slug?: string;
        type?: string;
        title?: string;
        services?: { name?: string; argv?: string[]; cwd?: string; healthcheck?: { timeout_s?: number } }[];
      };
      const slug = manifest.slug;
      if (!slug) throw new Error(`${manifestPath} has no slug`);

      // This command applies the author's local solution/ (including
      // `_degenerate/`'s exclusion), not the published one, which is why it
      // takes that directory rather than a bare slug, exactly like
      // `labs publish <dir>` does. The session itself runs whatever version
      // of the lab is currently published.
      const solutionDir = join(dir, 'solution');
      const hasSolution = existsSync(solutionDir);
      const solutionFiles = hasSolution ? collectSolutionFiles(solutionDir) : [];

      console.log(`Lab "${slug}"${manifest.type ? ` (${manifest.type})` : ''} from ${dir}`);
      if (!hasSolution) console.log(`No ${join(dir, 'solution')} directory — the pass case cannot be verified.`);
      else if (solutionFiles.length === 0) console.log(`${solutionDir} is empty — the pass case cannot be verified.`);

      const client = getClient();
      console.log(`Starting a session for "${slug}" (fresh)...`);
      const started = await client.startSession(slug, opts.user).catch((err: unknown) => {
        throw new Error(`could not start a session for "${slug}" (is the lab published? \`opalix labs publish ${dir}\`): ${err instanceof Error ? err.message : String(err)}`);
      });
      const authed = new OpalixClient({ baseUrl: client.baseUrl, sessionToken: started.token });

      let fresh: CheckResultLine[] = [];
      let afterSolution: CheckResultLine[] | undefined;
      try {
        console.log(`Session ${started.id} state=${started.state}. Waiting for it to become running...`);
        await waitForRunning(authed, started.id, startBudgetMs(manifest.services));

        console.log('\nFresh-session checks (at least one is expected to FAIL):');
        fresh = checkResults(await authed.runChecks(started.id));
        for (const line of formatCheckSummary(fresh)) console.log(line);

        if (hasSolution && solutionFiles.length > 0) {
          console.log(`\nApplying ${solutionDir} into /workspace (${solutionFiles.length} file${solutionFiles.length === 1 ? '' : 's'})...`);
          for (const rel of solutionFiles) {
            const content = readFileSync(join(solutionDir, ...rel.split('/')), 'utf8');
            await authed.writeFile(started.id, encodeWorkspacePath(rel), content);
            console.log(`  PUT /workspace/${rel} (${Buffer.byteLength(content)} bytes)`);
          }

          // Writing a file never reloads an already-running process: a
          // service that reads its own source once at boot (e.g. a Flask
          // app started with `app.run()`) keeps executing whatever was in
          // memory when it started, exactly like a real learner's own
          // in-browser editor requires a Restart click before an edit takes
          // effect. Only restart a service whose own argv actually
          // references one of the written files (its entrypoint script, not
          // a config file some other service merely reads) -- restarting
          // every service unconditionally hit a real, pre-existing platform
          // bug live (`/services/:name/restart` on Grafana:
          // ProcessWaitTimeoutError, ~5s SIGTERM wait not honoured) and
          // broke an otherwise-passing lab (tell-finance-who-spent-the-money)
          // whose solution only ever edits a dashboard JSON file nothing's
          // argv points at.
          const solutionRelPaths = solutionFiles.map((rel) => rel.split('/').join('/'));
          const affectedServices = (manifest.services ?? []).filter((s) => {
            const argv = s.argv ?? [];
            return solutionRelPaths.some((rel) => argv.some((a) => typeof a === 'string' && a.includes(rel)));
          });
          if (affectedServices.length > 0) {
            const names = affectedServices.map((s) => s.name).filter((n): n is string => !!n);
            console.log(`\nRestarting services whose own entrypoint the solution edited: ${names.join(', ')}...`);
            for (const name of names) {
              await authed.restartService(started.id, name);
            }
          }

          console.log('\nPost-solution checks (every one must PASS):');
          afterSolution = checkResults(await authed.runChecks(started.id));
          for (const line of formatCheckSummary(afterSolution)) console.log(line);
        }
      } finally {
        // A leaked container bills until something reaps it, so ending the
        // session is not conditional on anything above having worked.
        try {
          await authed.end(started.id, false);
          console.log(`\nEnded session ${started.id}.`);
        } catch (err) {
          console.error(`\nWARNING: failed to end session ${started.id} — end it by hand (\`opalix session end\` or DELETE /sessions/${started.id}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const problems = judgeLabTest({ fresh, afterSolution, hasSolution: hasSolution && solutionFiles.length > 0 });
      if (problems.length > 0) {
        console.error(`\nFAIL: lab "${slug}" is not verified:`);
        for (const p of problems) console.error(`  - ${p}`);
        process.exitCode = 1;
        return;
      }
      console.log(`\nPASS: lab "${slug}" fails as designed on a fresh session and passes every check once solution/ is applied.`);
    });
}

export interface CheckResultLine {
  name: string;
  pass: boolean;
  message: string;
}

/** Narrows the API's check run (results may be absent on a malformed response) to the fields this command reports on. */
function checkResults(run: { results?: Array<{ name: string; pass: boolean; message: string }> } | undefined): CheckResultLine[] {
  return (run?.results ?? []).map((r) => ({ name: r.name, pass: r.pass, message: r.message }));
}

/** Every file under `dir`, as POSIX-ish paths relative to it, sorted for a stable upload order. */
/**
 * Every file under solution/, except `_degenerate/`: lab authors keep the
 * wrong answers that prove their checks discriminate there, and those must
 * never land in a learner's workspace, not even during `labs test`.
 */
export function collectSolutionFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && statSync(full).isDirectory());
      if (isDir && current === dir && entry.name === '_degenerate') continue;
      if (isDir) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** `PUT /sessions/:id/files/:path{.+}` takes a path, not a single segment, so encode each segment and keep the separators. */
export function encodeWorkspacePath(relativePath: string): string {
  return relativePath.split('/').map(encodeURIComponent).join('/');
}

export function formatCheckSummary(results: readonly CheckResultLine[]): string[] {
  if (results.length === 0) return ['  (no checks ran)'];
  const lines = results.map((r) => {
    const message = r.message.split('\n').map((l) => l.trim()).filter(Boolean).join(' / ');
    return `  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${message ? ` — ${message}` : ''}`;
  });
  const passed = results.filter((r) => r.pass).length;
  lines.push(`  ${passed}/${results.length} check${results.length === 1 ? '' : 's'} passed.`);
  return lines;
}

/**
 * The verdict on a lab, from the two check runs. Empty means the lab is
 * sound: it poses a real task (something fails before the learner acts) and
 * that task is solvable (everything passes once the author's own solution is
 * in place). Anything returned here is a defect in the *lab*, not in the run.
 */
export function judgeLabTest(input: {
  fresh: readonly CheckResultLine[];
  afterSolution?: readonly CheckResultLine[];
  hasSolution: boolean;
}): string[] {
  const problems: string[] = [];

  if (input.fresh.length === 0) {
    problems.push('no checks ran on the fresh session — the lab declares no checks, or the run failed');
  } else if (input.fresh.every((r) => r.pass)) {
    problems.push(
      `all ${input.fresh.length} check${input.fresh.length === 1 ? '' : 's'} passed on a fresh session, before the learner did anything — this lab has no task in it`
    );
  }

  if (!input.hasSolution) {
    problems.push('no solution/ directory to apply — the pass case was NOT verified');
    return problems;
  }

  if (input.afterSolution === undefined) {
    problems.push('the post-solution check run did not complete');
    return problems;
  }
  if (input.afterSolution.length === 0) {
    problems.push('no checks ran after applying solution/');
    return problems;
  }
  for (const r of input.afterSolution.filter((c) => !c.pass)) {
    const message = r.message.split('\n').map((l) => l.trim()).filter(Boolean).join(' / ');
    problems.push(`check "${r.name}" still fails after applying solution/: ${message || 'no message'}`);
  }
  return problems;
}

/**
 * How long a session may take to reach `running`. Services start one after
 * another, and each may use its whole healthcheck budget, so a fixed wait
 * cut off labs with several slow services: a gateway lab (Postgres, then
 * LiteLLM migrating a fresh database) takes about 75 s live, over the
 * 60 s this used to allow. The extra 180 s covers claiming a container
 * (a cold one has taken 21 s) and hydrating the workspace.
 */
function startBudgetMs(services: { healthcheck?: { timeout_s?: number } }[] | undefined): number {
  const healthchecks = (services ?? []).reduce((total, s) => total + (s?.healthcheck?.timeout_s ?? 30), 0);
  return (healthchecks + 180) * 1000;
}

async function waitForRunning(client: OpalixClient, sessionId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await client.status(sessionId);
    if (status.meta.state === 'running') return;
    if (status.meta.state === 'ended') throw new Error('Session ended before becoming running');
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Timed out waiting for session to become running');
}
