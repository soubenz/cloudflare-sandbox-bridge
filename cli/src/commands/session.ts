import { Command } from 'commander';
import { OpalixClient } from '../client';
import { saveSession, loadSession, clearSession } from '../session-file';
import { attachTerminal } from '../terminal';

function requireCurrent(): { id: string; token: string; baseUrl: string } {
  const s = loadSession();
  if (!s?.id) throw new Error('No current session. Run `opalix session start <lab>` first.');
  return s;
}

export function registerSessionCommands(program: Command, getClient: () => OpalixClient, getBaseUrl: () => string): void {
  const session = program.command('session').description('Manage a lab session');

  session
    .command('start <lab>')
    .option('--user <id>', 'user id', 'opalix-cli')
    .description('Start a session and wait for it to become running')
    .action(async (lab: string, opts: { user: string }) => {
      const started = await getClient().startSession(lab, opts.user);
      console.log(`Session ${started.id} state=${started.state}`);
      const baseUrl = getBaseUrl();
      saveSession({ id: started.id, token: started.token, baseUrl });

      const authed = new OpalixClient({ baseUrl, sessionToken: started.token });
      for (let i = 0; i < 60; i++) {
        const status = await authed.status(started.id);
        if (status.meta.state === 'running') {
          console.log('Session is running.');
          console.log('Services:', Object.entries(status.services).map(([n, s]) => `${n}=${s.health}`).join(', '));
          return;
        }
        if (status.meta.state === 'ended') throw new Error('Session ended before becoming running');
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error('Timed out waiting for session to become running');
    });

  session
    .command('status')
    .description('Show the current session status')
    .action(async () => {
      const s = requireCurrent();
      const client = new OpalixClient({ baseUrl: s.baseUrl, sessionToken: s.token });
      console.log(JSON.stringify(await client.status(s.id), null, 2));
    });

  session
    .command('attach')
    .description('Attach a terminal to the current session')
    .action(async () => {
      const s = requireCurrent();
      const client = new OpalixClient({ baseUrl: s.baseUrl, sessionToken: s.token });
      console.log('Attaching (Ctrl+D at the remote shell to exit)...');
      await attachTerminal(client.terminalUrl(s.id));
    });

  const files = session.command('files').description('File operations on the current session');

  files
    .command('ls [path]')
    .action(async (path?: string) => {
      const s = requireCurrent();
      const client = new OpalixClient({ baseUrl: s.baseUrl, sessionToken: s.token });
      console.log(await client.listFiles(s.id, path));
    });

  files
    .command('get <path>')
    .action(async (path: string) => {
      const s = requireCurrent();
      const client = new OpalixClient({ baseUrl: s.baseUrl, sessionToken: s.token });
      const result = await client.readFile(s.id, path);
      process.stdout.write(result.content);
    });

  files
    .command('put <path> <localFile>')
    .action(async (path: string, localFile: string) => {
      const { readFileSync } = await import('node:fs');
      const s = requireCurrent();
      const client = new OpalixClient({ baseUrl: s.baseUrl, sessionToken: s.token });
      const content = readFileSync(localFile, 'utf8');
      console.log(await client.writeFile(s.id, path, content));
    });

  files
    .command('rm <path>')
    .action(async (path: string) => {
      const s = requireCurrent();
      const client = new OpalixClient({ baseUrl: s.baseUrl, sessionToken: s.token });
      console.log(await client.deleteFile(s.id, path));
    });

  session
    .command('check')
    .option('--only <names>', 'comma-separated check names')
    .description('Run the lab checker')
    .action(async (opts: { only?: string }) => {
      const s = requireCurrent();
      const client = new OpalixClient({ baseUrl: s.baseUrl, sessionToken: s.token });
      const results = await client.runChecks(s.id, opts.only?.split(','));
      console.log(JSON.stringify(results, null, 2));
    });

  session
    .command('events')
    .description('Stream live session events')
    .action(async () => {
      const s = requireCurrent();
      const client = new OpalixClient({ baseUrl: s.baseUrl, sessionToken: s.token });
      const res = await fetch(client.eventsUrl(s.id));
      if (!res.body) throw new Error('No event stream body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        process.stdout.write(decoder.decode(value));
      }
    });

  session
    .command('restart <name>')
    .description('Restart one service')
    .action(async (name: string) => {
      const s = requireCurrent();
      const client = new OpalixClient({ baseUrl: s.baseUrl, sessionToken: s.token });
      console.log(await client.restartService(s.id, name));
    });

  session
    .command('open <name>')
    .description('Print a tokenised URL for a service UI')
    .action((name: string) => {
      const s = requireCurrent();
      const client = new OpalixClient({ baseUrl: s.baseUrl, sessionToken: s.token });
      console.log(client.serviceUrl(s.id, name));
    });

  session
    .command('snapshot')
    .action(async () => {
      const s = requireCurrent();
      const client = new OpalixClient({ baseUrl: s.baseUrl, sessionToken: s.token });
      console.log(await client.snapshot(s.id));
    });

  session
    .command('resume')
    .action(async () => {
      const s = requireCurrent();
      const client = new OpalixClient({ baseUrl: s.baseUrl, sessionToken: s.token });
      const result = await client.resume(s.id);
      saveSession({ id: s.id, token: result.token, baseUrl: s.baseUrl });
      console.log(result);
    });

  session
    .command('end')
    .option('--no-snapshot', 'skip the final snapshot')
    .action(async (opts: { snapshot: boolean }) => {
      const s = requireCurrent();
      const client = new OpalixClient({ baseUrl: s.baseUrl, sessionToken: s.token });
      console.log(await client.end(s.id, opts.snapshot));
      clearSession();
    });
}
