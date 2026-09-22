#!/usr/bin/env node
import { Command } from 'commander';
import { OpalixClient } from './client';
import { registerLabsCommands } from './commands/labs';
import { registerSessionCommands } from './commands/session';
import { registerPoolCommands } from './commands/pool';

const program = new Command();
program.name('opalix').description('Command-line client for the Opalix sandbox API').version('0.1.0');

program.option('--url <url>', 'sandbox API base URL', process.env.OPALIX_URL ?? 'http://localhost:8787');
program.option('--key <key>', 'service API key', process.env.OPALIX_KEY);

function getBaseUrl(): string {
  return program.opts<{ url: string }>().url;
}

function getClient(): OpalixClient {
  const opts = program.opts<{ url: string; key?: string }>();
  if (!opts.key) throw new Error('Set OPALIX_KEY or pass --key (the SANDBOX_API_KEY service secret)');
  return new OpalixClient({ baseUrl: opts.url, serviceKey: opts.key });
}

registerLabsCommands(program, getClient);
registerPoolCommands(program, getClient);
registerSessionCommands(program, getClient, getBaseUrl);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
