import { Command } from 'commander';
import { OpalixClient } from '../client';

export function registerPoolCommands(program: Command, getClient: () => OpalixClient): void {
  const pool = program.command('pool').description('Warm pool operations');

  pool
    .command('stats <family>')
    .action(async (family: string) => {
      console.log(await getClient().poolStats(family));
    });

  pool
    .command('prime <family>')
    .option('--target <n>', 'warm pool target', (v) => Number.parseInt(v, 10))
    .action(async (family: string, opts: { target?: number }) => {
      console.log(await getClient().primePool(family, opts.target));
    });
}
