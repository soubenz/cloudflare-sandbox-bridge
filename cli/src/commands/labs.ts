import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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

      // workspace.tgz gets everything a learner should see: workspace/ plus brief.md/hints.md at the lab root.
      const workspaceStaging = mkdtempSync(join(tmpdir(), 'opalix-ws-'));
      try {
        execFileSync('sh', ['-c', `mkdir -p '${workspaceStaging}/workspace' && cp -r '${dir}'/workspace/* '${workspaceStaging}/workspace/' 2>/dev/null; true`]);
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
    .command('test <slug>')
    .description('Start a session, apply solution/, expect checks to pass; start fresh, expect the designed failures')
    .action(async (slug: string) => {
      const client = getClient();
      console.log(`Starting a session for "${slug}" (fresh)...`);
      const started = await client.startSession(slug, 'opalix-cli-test');
      console.log(`Session ${started.id} state=${started.state}. Waiting for it to become running...`);
      const authed = new OpalixClient({ baseUrl: client.baseUrl, sessionToken: started.token });
      await waitForRunning(authed, started.id);

      console.log('Running checks on the fresh session (expect the designed failures)...');
      const freshResults = await authed.runChecks(started.id);
      console.log(freshResults);

      await authed.end(started.id, false);
      console.log('Fresh-session check done. Apply solution/ manually and re-run with --after-solution to verify the pass case (not yet automated).');
    });
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
