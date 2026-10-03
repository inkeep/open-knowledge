import type { Config } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { runSync, syncFailureMessage } from './sync.ts';

export function pullCommand(getConfig: () => Config): Command {
  return new Command('pull')
    .description('Pull changes from the remote')
    .option('--json', 'Output JSONL progress events', false)
    .action(async (opts: { json: boolean }) => {
      try {
        await runSync({ json: opts.json, op: 'pull' }, getConfig());
      } catch (err) {
        const msg = syncFailureMessage(err);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ type: 'error', message: msg })}\n`);
        } else {
          process.stderr.write(`✗ pull failed: ${msg}\n`);
        }
        process.exit(1);
      }
    });
}
