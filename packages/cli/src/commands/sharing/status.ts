/**
 * `ok config-sharing status` — print the current sharing mode, the OK paths
 * currently in `.git/info/exclude`, and any OK paths tracked upstream
 * (informational; the user is in `local-only` mode but a teammate
 * committed a file that should also be cleaned up via `git rm --cached`).
 *
 * Pure read — never writes. Safe to invoke from any CI / scripted context.
 */

import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  getExcludedOkPaths,
  getOkArtifactPaths,
  probeTrackedOkPaths,
  readSharingMode,
  type SharingMode,
} from '../../sharing/git-exclude.ts';
import { accent, info, success, warning } from '../../ui/colors.ts';

interface StatusOptions {
  json: boolean;
  project?: string;
}

interface StatusJsonReport {
  type: 'sharing-status';
  projectRoot: string;
  mode: SharingMode;
  excluded: string[];
  trackedUpstream: string[];
}

export function sharingStatusCommand(): Command {
  return new Command('status')
    .description('Print the current sharing mode and the OK paths in .git/info/exclude')
    .option('--project <dir>', 'Project root (defaults to cwd)')
    .option('--json', 'Output JSON', false)
    .action(async (opts: StatusOptions) => {
      const projectRoot = resolve(opts.project ?? process.cwd());
      const mode = readSharingMode(projectRoot);
      const excluded = [...getExcludedOkPaths(projectRoot)];
      const trackedUpstream = probeTrackedOkPaths(
        projectRoot,
        getOkArtifactPaths(projectRoot),
      ).tracked;

      if (opts.json) {
        const report: StatusJsonReport = {
          type: 'sharing-status',
          projectRoot,
          mode,
          excluded,
          trackedUpstream,
        };
        process.stdout.write(`${JSON.stringify(report)}\n`);
        return;
      }

      const lines: string[] = [];
      lines.push(`OpenKnowledge sharing mode: ${formatMode(mode)}`);
      lines.push('');
      lines.push(`Excluded from git via ${accent('.git/info/exclude')}:`);
      if (excluded.length === 0) {
        lines.push('  (none)');
      } else {
        for (const p of excluded) lines.push(`  ${p}`);
      }
      lines.push('');
      lines.push('Other OK paths exist but are tracked upstream:');
      if (trackedUpstream.length === 0) {
        lines.push('  (none)');
      } else {
        for (const p of trackedUpstream) lines.push(`  ${p}`);
      }
      lines.push('');
      lines.push(
        `Toggle with: ${info(mode === 'local-only' ? 'ok config-sharing share' : 'ok config-sharing unshare')}`,
      );
      process.stdout.write(`${lines.join('\n')}\n`);
    });
}

function formatMode(mode: SharingMode): string {
  switch (mode) {
    case 'shared':
      return success('shared');
    case 'local-only':
      return success('local-only');
    case 'no-git':
      return warning('no-git (not a git repository)');
  }
}
