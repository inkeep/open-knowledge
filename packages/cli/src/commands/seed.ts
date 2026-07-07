/**
 * `ok seed` — scaffold the Karpathy three-layer knowledge-base structure.
 *
 * Creates `external-sources/`, `research/`, `articles/`, an optional
 * `log.md`, and writes per-folder `<folder>/.ok/frontmatter.yml` defaults
 * that surface as agent guidance via `exec("ls <folder>")`.
 *
 * Replaces the former `init-content` MCP tool with a deterministic CLI.
 */

import { relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  applySeed,
  DEFAULT_PACK_ID,
  formatPackRationale,
  type PackId,
  planSeed,
  type ScaffoldPlan,
  SeedPrerequisiteError,
  STARTER_PACK_IDS,
  STARTER_PACKS,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { accent, dim, error as errorColor, info, success, warning } from '../ui/colors.ts';

interface SeedCommandOptions {
  cwd?: string;
  /**
   * Subfolder (relative to `cwd`) where the chosen starter pack is
   * scaffolded. `.` / `''` scaffolds at the project root (historical behavior).
   * When omitted and stdin is a TTY, the user is prompted interactively.
   */
  root?: string;
  /**
   * Starter pack to scaffold. Defaults to `'knowledge-base'` for back-compat
   * with single-scaffold callers. See `STARTER_PACKS` for the full registry.
   */
  pack?: PackId;
  /** Skip the Y/n confirmation prompt. */
  yes?: boolean;
  /** Print the plan and exit without writing. */
  dryRun?: boolean;
  /** Test-only: override stdin for confirmation. */
  confirmStream?: NodeJS.ReadableStream;
}

function isPackId(value: unknown): value is PackId {
  return typeof value === 'string' && STARTER_PACK_IDS.includes(value as PackId);
}

interface SeedCommandResult {
  /** 'applied' (writes happened) | 'dry-run' | 'no-op' (already seeded) | 'cancelled' | 'prerequisite-missing' | 'failed' */
  status: 'applied' | 'dry-run' | 'no-op' | 'cancelled' | 'prerequisite-missing' | 'failed';
  message: string;
  plan?: ScaffoldPlan;
  /** Non-zero on prerequisite-missing or failed. */
  exitCode: number;
}

/**
 * Programmatic entry point. Thin wrapper around planSeed + applySeed that
 * owns confirmation prompting and output formatting. Called by both the
 * Commander action and integration tests.
 */
export async function runSeed(opts: SeedCommandOptions = {}): Promise<SeedCommandResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const packId: PackId = opts.pack ?? DEFAULT_PACK_ID;

  if (!STARTER_PACKS[packId]) {
    return {
      status: 'failed',
      message: `${errorColor('Error:')} Unknown pack "${packId}". Available: ${STARTER_PACK_IDS.join(', ')}`,
      exitCode: 1,
    };
  }

  let plan: ScaffoldPlan;
  try {
    // A dry-run previews a pack before `ok init`, so it must not require an
    // initialized project — skip the prerequisite gate in that mode only.
    plan = await planSeed({
      projectDir: cwd,
      rootDir: opts.root,
      packId,
      skipPrerequisite: opts.dryRun === true,
    });
  } catch (err) {
    if (err instanceof SeedPrerequisiteError) {
      return {
        status: 'prerequisite-missing',
        message: `${errorColor('Error:')} ${err.message}`,
        exitCode: 1,
      };
    }
    return {
      status: 'failed',
      message: `${errorColor('Error:')} ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
    };
  }

  if (plan.created.length === 0) {
    const packName = STARTER_PACKS[packId].name;
    return {
      status: 'no-op',
      message: `${success(`Your ${packName} pack is already seeded.`)}\n${dim('Nothing to do.')}`,
      plan,
      exitCode: 0,
    };
  }

  if (opts.dryRun) {
    // Surface the pack's organizing principle (per-folder "why" + templates),
    // not just the file tree — so the reader can adapt the pattern into a
    // similar structure of their own. The plan tree stays below it.
    const rationale = formatPackRationale(STARTER_PACKS[packId]);
    return {
      status: 'dry-run',
      message: `${accent('Reference this pack for inspiration (dry-run — no changes made):')}\n\n${rationale}\n\n${accent('Plan:')}\n\n${formatPlanBody(plan, cwd)}`,
      plan,
      exitCode: 0,
    };
  }

  if (!opts.yes) {
    const confirmed = await confirm(
      `${accent('Plan:')}\n\n${formatPlanBody(plan, cwd)}\n\n${accent('Apply?')} ${dim('[Y/n] ')}`,
      opts.confirmStream,
    );
    if (!confirmed) {
      return {
        status: 'cancelled',
        message: dim('Cancelled.'),
        plan,
        exitCode: 0,
      };
    }
  }

  // applySeed reads absolute paths from plan.created directly, so it needs
  // only projectDir + packId — rootDir is already baked into the plan entries.
  const applyResult = await applySeed(plan, { projectDir: cwd, packId });

  if (applyResult.errors.length > 0) {
    const errorLines = applyResult.errors.map((e) => `  ${errorColor('✗')} ${e.path}: ${e.error}`);
    return {
      status: 'failed',
      message: [
        `${warning('Applied')} ${applyResult.applied} entries, ${warning(String(applyResult.errors.length))} error(s):`,
        ...errorLines,
      ].join('\n'),
      plan,
      exitCode: 1,
    };
  }

  const packName = STARTER_PACKS[packId].name;

  // `applySeed` installs the pack's project-local skill for every editor set up
  // for this project (single install site shared with the desktop IPC + HTTP
  // seed paths). Surface which editors got it.
  const skillLine =
    applyResult.packSkillsInstalled.length > 0
      ? `\n${dim(`Installed the ${packName} skill for: ${applyResult.packSkillsInstalled.join(', ')}`)}`
      : '';

  return {
    status: 'applied',
    message: `${success(`✓ Seeded ${packName}`)} ${dim(`(${applyResult.applied} entries, ${applyResult.durationMs}ms)`)}${skillLine}`,
    plan,
    exitCode: 0,
  };
}

/** Print the registry of available packs as a small CLI table. */
function formatPackList(): string {
  const lines: string[] = [accent('Available packs:')];
  for (const id of STARTER_PACK_IDS) {
    const pack = STARTER_PACKS[id];
    lines.push(`  ${success(id)}  ${dim('—')} ${pack.name}: ${pack.description}`);
  }
  return lines.join('\n');
}

/** Format a ScaffoldPlan as a plain colored list for CLI output. */
function formatPlanBody(plan: ScaffoldPlan, cwd: string): string {
  const lines: string[] = [];

  const folders = plan.created.filter((e) => e.kind === 'folder');
  const files = plan.created.filter((e) => e.kind === 'file');

  if (folders.length > 0) {
    lines.push(accent('Folders to create:'));
    for (const f of folders) {
      lines.push(
        `  ${success('+')} ${info(relative(cwd, resolve(cwd, f.path)) || f.path)}${dim('/')}`,
      );
    }
  }

  if (files.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(accent('Files to create:'));
    for (const f of files) {
      lines.push(`  ${success('+')} ${info(relative(cwd, resolve(cwd, f.path)) || f.path)}`);
    }
  }

  if (plan.skipped.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(dim('Already present (skipped):'));
    for (const s of plan.skipped) {
      lines.push(`  ${dim(`· ${s.path} (${s.reason})`)}`);
    }
  }

  if (plan.warnings.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(warning('Warnings:'));
    for (const w of plan.warnings) {
      lines.push(`  ${warning('!')} ${w}`);
    }
  }

  return lines.join('\n');
}

async function confirm(prompt: string, input?: NodeJS.ReadableStream): Promise<boolean> {
  const rl = createInterface({ input: input ?? process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    // Default Y on empty input
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Commander subcommand factory. Registered in cli.ts alongside init/start/mcp. */
export function seedCommand(): Command {
  return new Command('seed')
    .description(
      `Scaffold a starter pack into the project. Defaults to "${DEFAULT_PACK_ID}" — the Karpathy three-layer knowledge base. Use --pack to pick a different pack (run with --list-packs to see all). Use --root to place pack folders inside a subfolder instead of the project root.`,
    )
    .argument('[path]', 'Project directory (defaults to cwd)')
    .option(
      '-p, --pack <id>',
      `Starter pack to scaffold. One of: ${STARTER_PACK_IDS.join(', ')}. Defaults to "${DEFAULT_PACK_ID}".`,
    )
    .option(
      '-r, --root <path>',
      'Subfolder (relative to the project dir) to scaffold into — created if missing. Defaults to the project root when omitted in non-interactive runs; prompts on a TTY.',
    )
    .option('--list-packs', 'List available starter packs and exit.')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--dry-run', 'Print the plan and exit without writing')
    .action(
      async (
        pathArg: string | undefined,
        opts: {
          pack?: string;
          root?: string;
          listPacks?: boolean;
          yes?: boolean;
          dryRun?: boolean;
        },
      ) => {
        if (opts.listPacks) {
          process.stdout.write(`${formatPackList()}\n`);
          return;
        }
        if (opts.pack !== undefined && !isPackId(opts.pack)) {
          process.stderr.write(
            `${errorColor('Error:')} Unknown pack "${opts.pack}". Available: ${STARTER_PACK_IDS.join(', ')}\n`,
          );
          process.exitCode = 1;
          return;
        }
        const result = await runSeed({
          cwd: pathArg ?? process.cwd(),
          pack: opts.pack as PackId | undefined,
          root: opts.root,
          yes: opts.yes,
          dryRun: opts.dryRun,
        });
        process.stdout.write(`${result.message}\n`);
        if (result.exitCode !== 0) {
          process.exitCode = result.exitCode;
        }
      },
    );
}
