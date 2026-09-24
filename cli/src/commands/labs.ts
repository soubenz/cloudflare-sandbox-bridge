import { Command } from 'commander';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { OpalixClient } from '../client';

function buildTgz(sourceDir: string, subdirs: string[]): Buffer {
  const staging = mkdtempSync(join(tmpdir(), 'opalix-publish-'));
  try {
    const present = subdirs.filter((d) => existsSync(join(sourceDir, d)));
    if (present.length === 0) return Buffer.alloc(0);
    const out = join(staging, 'bundle.tgz');
    execFileSync('tar', ['czf', out, '-C', sourceDir, ...present]);
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
    .command('publish <dir>')
    .description('Publish a lab directory (manifest.yaml, workspace/, checks/, pressure/ — solution/ is never uploaded)')
    .action(async (dir: string) => {
      const manifestPath = join(dir, 'manifest.yaml');
      if (!existsSync(manifestPath)) throw new Error(`No manifest.yaml in ${dir}`);
      const manifestJson = parseYaml(readFileSync(manifestPath, 'utf8'));

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
        const workspaceTgz = execFileSync('tar', ['czf', '-', '-C', workspaceStaging, '.']);
        const privateTgz = buildTgz(dir, ['checks', 'pressure']);

        const form = new FormData();
        form.set('manifest', new Blob([JSON.stringify(manifestJson)], { type: 'application/json' }), 'manifest.json');
        form.set('workspace', new Blob([workspaceTgz]), 'workspace.tgz');
        form.set('private', new Blob([privateTgz.length > 0 ? privateTgz : Buffer.alloc(0)]), 'private.tgz');

        console.log(await getClient().publishLab(form));
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
      const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as { slug?: string; type?: string; title?: string };
      const slug = manifest.slug;
      if (!slug) throw new Error(`${manifestPath} has no slug`);

      // solution/ is deliberately never published (see `labs publish`), so it
      // only ever exists in the author's local lab directory — which is why
      // this command takes that directory rather than a bare slug, exactly
      // like `labs publish <dir>` does. The session itself runs whatever
      // version of the lab is currently published.
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
        await waitForRunning(authed, started.id);

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
export function collectSolutionFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && statSync(full).isDirectory());
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
