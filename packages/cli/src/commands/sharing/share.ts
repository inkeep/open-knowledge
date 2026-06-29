
import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  getOkArtifactPaths,
  readSharingMode,
  removeOkPathsFromGitExclude,
} from '../../sharing/git-exclude.ts';
import { accent, info, success, warning } from '../../ui/colors.ts';

interface ShareOptions {
  json: boolean;
  project?: string;
}

interface ShareJsonReport {
  type: 'sharing-share';
  projectRoot: string;
  mode: 'shared' | 'local-only' | 'no-git';
  removed: string[];
}

export function sharingShareCommand(): Command {
  return new Command('share')
    .description('Switch this project to shared mode (commit OK config alongside content)')
    .option('--project <dir>', 'Project root (defaults to cwd)')
    .option('--json', 'Output JSON', false)
    .action(async (opts: ShareOptions) => {
      const projectRoot = resolve(opts.project ?? process.cwd());
      const before = readSharingMode(projectRoot);
      const paths = getOkArtifactPaths(projectRoot);
      const result = removeOkPathsFromGitExclude(projectRoot, paths);

      if (result.kind === 'no-exclude') {
        emitNoExclude(opts.json, projectRoot, result.reason);
        return;
      }

      const after = readSharingMode(projectRoot);
      if (opts.json) {
        const report: ShareJsonReport = {
          type: 'sharing-share',
          projectRoot,
          mode: after,
          removed: result.removed,
        };
        process.stdout.write(`${JSON.stringify(report)}\n`);
        return;
      }

      if (before === 'shared') {
        process.stderr.write(
          `${info('Sharing mode is already')} ${accent('shared')} ${info('— nothing to do.')}\n`,
        );
        return;
      }
      process.stderr.write(
        `${success('✓')} ${accent('Sharing mode set to')} ${success('shared')}\n`,
      );
      process.stderr.write(
        `  Removed OK paths from ${accent('.git/info/exclude')}; commit the files to share with teammates.\n`,
      );
    });
}

function emitNoExclude(
  json: boolean,
  projectRoot: string,
  reason: 'no-git' | 'no-info-dir' | 'malformed-pointer' | 'inaccessible',
): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ type: 'sharing-share', projectRoot, mode: 'no-git', removed: [], reason })}\n`,
    );
    return;
  }
  const messages: Record<typeof reason, string> = {
    'no-git': 'No git repository here — sharing mode does not apply.',
    'no-info-dir': "The gitdir's info/ folder is absent; cannot toggle sharing mode.",
    'malformed-pointer':
      'The .git pointer file is malformed (stale worktree). Run `git worktree prune` and try again.',
    inaccessible: 'The .git path is inaccessible (permissions or mount issue).',
  };
  process.stderr.write(`${warning(messages[reason])}\n`);
}
