import { type Config, resolveLockDir } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { runClean } from './clean-execution.ts';

export { buildCleanPlan, runClean } from './clean-execution.ts';

import { buildCleanV1, cleanV1Failure } from './clean-v1.ts';
import type { V1Project } from './supervision-json-v1.ts';
import { addV1FormatOption, writeV1Document } from './supervision-json-v1-output.ts';

export function cleanCommand(
  getConfig: () => Config,
  getV1Context?: () => { project: V1Project; failure: string | null },
): Command {
  return addV1FormatOption(
    new Command('clean').description(
      'Prune a stale / corrupt open-knowledge lock file (never touches live locks)',
    ),
  ).action((options: { format?: string }) => {
    if (options.format === 'json-v1') {
      const context = getV1Context?.() ?? {
        project: { root: process.cwd(), resolution: 'cwd' as const },
        failure: null,
      };
      if (context.failure !== null) {
        writeV1Document(cleanV1Failure('project-unavailable', context.failure));
        return;
      }
      try {
        writeV1Document(buildCleanV1(context.project));
      } catch (error) {
        writeV1Document(
          cleanV1Failure(
            'operation-failed',
            error instanceof Error ? error.message : String(error),
            context.project,
          ),
        );
      }
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
