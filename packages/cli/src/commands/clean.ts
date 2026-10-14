import { type Config, resolveLockDir } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { runClean } from './clean-execution.ts';

export { buildCleanPlan, runClean } from './clean-execution.ts';

import type {
  SupervisionContext,
  SupervisionFormatRegistry,
} from './supervision-format-registry.ts';
import { supervisionFormats } from './supervision-formats.ts';

export function cleanCommand(
  getConfig: () => Config,
  getV1Context?: () => SupervisionContext,
  registry: SupervisionFormatRegistry = supervisionFormats,
): Command {
  return registry
    .addFormatOption(
      new Command('clean').description(
        'Prune a stale / corrupt open-knowledge lock file (never touches live locks)',
      ),
    )
    .action(async (options: { format?: string }) => {
      if (options.format !== undefined) {
        const context = getV1Context?.() ?? {
          project: { root: process.cwd(), resolution: 'cwd' as const },
          failure: null,
        };
        await registry.execute(options.format, { command: 'clean', context });
        return;
      }
      getConfig();
      const lockDir = resolveLockDir(process.cwd());
      const outcome = runClean({ lockDir });
      if (outcome.failed.length > 0) {
        process.exitCode = 1;
      }
    });
}
