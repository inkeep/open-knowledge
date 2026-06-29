
import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  addOkPathsToGitExclude,
  getOkArtifactPaths,
  readSharingMode,
} from '../../sharing/git-exclude.ts';
import { accent, success, warning } from '../../ui/colors.ts';

interface UnshareOptions {
  json: boolean;
  project?: string;
}

interface UnshareJsonReport {
  type: 'sharing-unshare';
  projectRoot: string;
  mode: 'shared' | 'local-only' | 'no-git';
  appended: string[];
  alreadyPresent: string[];
}

interface UnshareRefusalReport {
  type: 'sharing-unshare';
  projectRoot: string;
  mode: 'refused-tracked';
  tracked: string[];
  remediation: string;
}

export function sharingUnshareCommand(): Command {
  return new Command('unshare')
    .description(
      'Switch this project to local-only mode (add OK artifacts to .git/info/exclude so they stay out of git)',
    )
    .option('--project <dir>', 'Project root (defaults to cwd)')
    .option('--json', 'Output JSON', false)
    .action(async (opts: UnshareOptions) => {
      const projectRoot = resolve(opts.project ?? process.cwd());
      const paths = getOkArtifactPaths(projectRoot);
      const result = addOkPathsToGitExclude(projectRoot, paths);

      if (result.kind === 'refused-tracked') {
        if (opts.json) {
          const report: UnshareRefusalReport = {
            type: 'sharing-unshare',
            projectRoot,
            mode: 'refused-tracked',
            tracked: result.tracked,
            remediation: result.remediation,
          };
          process.stdout.write(`${JSON.stringify(report)}\n`);
        } else {
          process.stderr.write(`${result.remediation}\n`);
        }
        process.exitCode = 1;
        return;
      }

      if (result.kind === 'no-exclude') {
        emitNoExclude(opts.json, projectRoot, result.reason);
        return;
      }

      const mode = readSharingMode(projectRoot);
      if (opts.json) {
        const report: UnshareJsonReport = {
          type: 'sharing-unshare',
          projectRoot,
          mode,
          appended: result.appended,
          alreadyPresent: result.alreadyPresent,
        };
        process.stdout.write(`${JSON.stringify(report)}\n`);
        return;
      }

      if (result.appended.length === 0) {
        process.stderr.write(
          `${accent('Sharing mode is already')} ${success('local-only')} ${accent('— nothing to do.')}\n`,
        );
        return;
      }
      process.stderr.write(
        `${success('✓')} ${accent('Sharing mode set to')} ${success('local-only')}\n`,
      );
      process.stderr.write(
        `  Added ${result.appended.length} path(s) to ${accent('.git/info/exclude')} (per-clone, not committed).\n`,
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
      `${JSON.stringify({ type: 'sharing-unshare', projectRoot, mode: 'no-git', appended: [], alreadyPresent: [], reason })}\n`,
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
