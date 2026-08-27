/**
 * `ok config-sharing unshare` — switch the project to local-only mode by
 * appending OK artifact paths to `.git/info/exclude`.
 *
 * Runs the tracked-files safety check inside
 * `addOkPathsToGitExclude`. When any OK artifact path is already tracked
 * upstream, the operation refuses with a multi-line diagnostic naming the
 * exact `git rm --cached` remediation commands — `.git/info/exclude`
 * cannot hide tracked files, so silently completing the operation would
 * mislead the user.
 *
 * Exit code:
 *   0  on a successful transition (or on a no-op when already local-only)
 *   1  on the tracked-files refusal
 *   0  on `no-exclude` outcomes (no git repo, etc.) with a warning to stderr
 */

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
  /** Stale skill-projection lines an older build wrote, cleared by this run. */
  removed: string[];
}

interface UnshareRefusalReport {
  type: 'sharing-unshare';
  projectRoot: string;
  mode: 'refused-tracked';
  tracked: string[];
  remediation: string;
}

/**
 * Print the stale entries a drain just cleared. Shared by the three commands
 * that can reach a draining write so the copy cannot drift between them.
 * No-op when nothing was cleared, so it composes onto any success path.
 */
export function writeClearedEntries(removed: readonly string[]): void {
  if (removed.length === 0) return;
  process.stderr.write(`  Cleared ${removed.length} stale entry(s) left by an older version:\n`);
  for (const p of removed) process.stderr.write(`    ${p}\n`);
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
          removed: result.removed,
        };
        process.stdout.write(`${JSON.stringify(report)}\n`);
        return;
      }

      if (result.appended.length === 0) {
        // Not necessarily a no-op: the add path also drains stale skill lines,
        // so this branch covers both "already local-only" and "already
        // local-only, and we just cleared entries an older build left".
        if (result.removed.length > 0) {
          process.stderr.write(
            `${success('✓')} ${accent('Sharing mode is already')} ${success('local-only')}${accent('.')}\n`,
          );
          writeClearedEntries(result.removed);
          return;
        }
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
      // Composes with the line above rather than competing with it: the
      // ordinary upgrade path both appends newer config paths and drains stale
      // skill lines in the SAME pass, and the drain is the half the user needs
      // to know about.
      writeClearedEntries(result.removed);
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
