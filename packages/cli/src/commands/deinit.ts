/**
 * `ok deinit` — remove OpenKnowledge from ONE project, leaving the user's
 * markdown content untouched. The per-project ring of the shared removal engine
 * (`deinitOps`), reused by `ok uninstall`'s recent-projects sweep.
 *
 * Re-running `ok start` after `ok deinit` re-scaffolds the project cleanly.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isHomeDir } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { accent, dim, error as errorColor, warning } from '../ui/colors.ts';
import { confirmDestructive } from '../ui/confirm.ts';
import {
  buildDeinitPlan,
  describeAttachedClients,
  type RunRemovalDeps,
  runRemoval,
} from './removal-plan.ts';
import {
  formatRemovalOutcome,
  formatRemovalPlan,
  removalOutcomeToJson,
  removalPlanToJson,
} from './removal-render.ts';

export interface DeinitOptions {
  cwd?: string;
  /** Override home (test-only). */
  home?: string;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  /** Test-only stdin override for the confirmation prompt. */
  confirmStream?: NodeJS.ReadableStream;
  /** Live-client probe seam (hits the running server over HTTP in production). */
  probeClients?: (lockDir: string) => Promise<number | null>;
  /** Test-only: stub the machine-touching removal primitives (stop-server, etc.)
   *  so the failed-exit branch is exercisable without real side effects. */
  runRemovalDeps?: RunRemovalDeps;
}

export interface DeinitResult {
  status: 'no-op' | 'dry-run' | 'cancelled' | 'done' | 'failed';
  message: string;
  exitCode: number;
}

export async function runDeinit(opts: DeinitOptions = {}): Promise<DeinitResult> {
  const projectRoot = resolve(opts.cwd ?? process.cwd());
  const home = opts.home ?? homedir();

  // Home is never a project, and here that matters more than anywhere else:
  // `~/.ok/` is OpenKnowledge's USER-GLOBAL directory, so the `.ok/` existence
  // check below is satisfied on every machine, and the plan would queue
  // `remove-path` for `global.yml`, `skills/` (the user's own unversioned
  // skills), `auth.yml` and `secrets.yml`. `--yes` skips the destructive
  // prompt, and the plan lines read like ordinary project paths. This is also
  // the command someone reaches for to undo an `ok init` that anchored them to
  // home, which is the worst possible place for that hazard.
  if (isHomeDir(projectRoot, home)) {
    return {
      status: 'failed',
      message:
        `${errorColor('Refusing to deinit your home directory.')}\n` +
        `  ${projectRoot}/.ok is OpenKnowledge's user-global directory (global.yml, skills/,\n` +
        `  auth.yml), not a project. Removing it would delete your global settings and skills.\n` +
        `  To remove OpenKnowledge everywhere, use 'ok uninstall'.`,
      exitCode: 64,
    };
  }

  // `.ok/` is the project marker; without it there is no OpenKnowledge footprint
  // to remove here (a stray editor-config entry would be handled by uninstall's
  // global sweep, not a per-project deinit).
  if (!existsSync(join(projectRoot, '.ok'))) {
    return {
      status: 'no-op',
      message: dim(`No OpenKnowledge project found at ${projectRoot}. Nothing to remove.`),
      exitCode: 0,
    };
  }

  const plan = buildDeinitPlan(projectRoot, home);
  const attached = await describeAttachedClients(plan, opts.probeClients);
  const attachedBlock =
    attached.length > 0 ? `\n\n${attached.map((l) => warning(l)).join('\n')}` : '';

  if (opts.dryRun) {
    return {
      status: 'dry-run',
      message: opts.json
        ? JSON.stringify(removalPlanToJson(plan, attached), null, 2)
        : `${accent('Would remove (dry-run — no changes made):')}\n\n${formatRemovalPlan(plan)}${attachedBlock}`,
      exitCode: 0,
    };
  }

  if (opts.json && !opts.yes) {
    return {
      status: 'failed',
      message: `${errorColor('Error:')} --json requires --yes (or --dry-run) so there is no interactive prompt.`,
      exitCode: 1,
    };
  }

  if (!opts.yes) {
    process.stderr.write(
      `${accent(`Remove OpenKnowledge from ${projectRoot}:`)}\n\n${formatRemovalPlan(plan)}${attachedBlock}\n\n`,
    );
    const confirmed = await confirmDestructive(
      `${accent('Remove these?')} ${dim('[y/N] ')}`,
      opts.confirmStream,
    );
    if (!confirmed) {
      return { status: 'cancelled', message: dim('Cancelled.'), exitCode: 0 };
    }
  }

  const outcome = await runRemoval(plan, opts.runRemovalDeps);
  return {
    status: outcome.failed.length > 0 ? 'failed' : 'done',
    message: opts.json
      ? JSON.stringify(removalOutcomeToJson('deinit', outcome, attached), null, 2)
      : formatRemovalOutcome(outcome),
    exitCode: outcome.failed.length > 0 ? 1 : 0,
  };
}

export function deinitCommand(): Command {
  return new Command('deinit')
    .description(
      'Remove OpenKnowledge from this project (its .ok/, editor MCP entries, git-exclude lines, shadow repo) while leaving your markdown content untouched. Re-run `ok start` to re-scaffold.',
    )
    .argument('[path]', 'Project directory (defaults to the current project)')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('--dry-run', 'Print the removal plan and exit without changing anything')
    .option('--json', 'Emit a machine-readable plan/outcome (requires --yes or --dry-run)')
    .action(
      async (
        pathArg: string | undefined,
        options: { yes?: boolean; dryRun?: boolean; json?: boolean },
      ) => {
        const result = await runDeinit({
          cwd: pathArg ?? process.cwd(),
          yes: options.yes,
          dryRun: options.dryRun,
          json: options.json,
        });
        process.stdout.write(`${result.message}\n`);
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
      },
    );
}
