import type { Config } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { runSync } from './sync.ts';

export function pushCommand(getConfig: () => Config): Command {
  return new Command('push')
    .description('Push commits to the remote')
    .option('--json', 'Output JSONL progress events', false)
    .action(async (opts: { json: boolean }) => {
      try {
        await runSync({ json: opts.json, op: 'push' }, getConfig());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ type: 'error', message: msg })}\n`);
        } else {
          process.stderr.write(`✗ push failed: ${msg}\n`);
        }
        process.exit(1);
      }
    });
}
