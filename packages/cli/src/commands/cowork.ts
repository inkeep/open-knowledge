/**
 * `ok cowork` — build the `openknowledge.skill` bundle and open the Claude
 * Desktop App so you can upload it for Claude Chat & Cowork.
 *
 * DELIBERATELY HIDDEN + UNADVERTISED. This is a power-user escape hatch for the
 * one niche Claude Chat/Cowork needs (a separate, isolated Skills list inside
 * the Desktop App that `ok init`'s editor wiring can't reach). It is registered
 * as a hidden command (absent from `ok --help`) and `ok init` does NOT push a
 * hint toward it — discovery is pull-only, via the Open Knowledge skill when a
 * user explicitly asks about Claude Cowork. Renamed from the misleading
 * `ok install-skill` (which built a bundle, never auto-installed) — do NOT
 * re-advertise it or restore the init-time hint.
 *
 * Flow:
 *   1. Build `openknowledge.skill` from the bundled SKILL.md source.
 *   2. Write to ~/Downloads/openknowledge.skill (or `--out <path>`).
 *   3. Invoke the OS file association (`open` / `start` / `xdg-open`) —
 *      this opens the Claude Desktop App but does NOT auto-install.
 *   4. User completes the manual upload inside the Claude Desktop App:
 *      Customize → Skills → + → Create skill → Upload skill → pick file.
 *
 * Why this exists: `ok init` installs the skill into Claude via `npx skills
 * add`, but that flow doesn't reach Claude Chat or Cowork modes (they read from
 * a separate, isolated Skills list inside the Claude Desktop App).
 *
 * The underlying `buildAndOpenSkill` lives in `@inkeep/open-knowledge-server`
 * (alongside `buildSkillZip`). The `POST /api/install-skill` endpoint and the
 * Electron main-process skill bridge delegate to the same primitive. All call
 * sites read/write the shared `~/.ok/skill-state/claude-cowork` install-state
 * file via helpers in `skill-state.ts` so the click-time gate covers all
 * surfaces.
 */

import {
  type BuildAndOpenSkillResult,
  buildAndOpenSkill,
  type SpawnLike,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { accent, dim, error as errorColor, info, success, warning } from '../ui/colors.ts';

interface BuildDesktopSkillOptions {
  /** Output file path. Defaults to ~/Downloads/openknowledge.skill. */
  out?: string;
  /** Skip the OS file-association invocation. Just emit the file. */
  noOpen?: boolean;
  /** Bypass the install-state gate and rebuild unconditionally. When Claude
   * Desktop has lost the skill, `--force` rebuilds the bundle without
   * consulting `~/.ok/skill-state/claude-cowork`. */
  force?: boolean;
  /** Test seam — override the spawn function so we can assert spawn args. */
  spawnFn?: SpawnLike;
  /** Test seam — override the platform tag. */
  platformName?: NodeJS.Platform;
  /** Test seam — override `$HOME` so the install-state gate reads/writes
   * a tmpdir instead of the real `~/.ok/skill-state/`. */
  home?: string;
}

/**
 * CLI return shape — augments the shared `BuildAndOpenSkillResult` with the
 * colored, terminal-ready `message` and `exitCode` the Commander action prints.
 */
interface BuildDesktopSkillCliResult extends BuildAndOpenSkillResult {
  message: string;
  exitCode: number;
}

const UPLOAD_STEPS = [
  `    1. ${accent('Customize')} (sidebar) → ${accent('Skills')}`,
  `    2. Click the ${accent('+')} button`,
  `    3. Click ${accent('Create skill')}`,
  `    4. Click ${accent('Upload skill')}`,
  `    5. Pick ${accent('openknowledge.skill')} from Downloads`,
];

const MANUAL_UPLOAD_HINT = info(
  `  Open the Claude Desktop App, then: ${accent('Customize → Skills → + → Create skill → Upload skill')} → pick the file.`,
);

function formatBuiltMessage(result: BuildAndOpenSkillResult): string {
  const lines = [
    success(`Built ${result.outputPath}`),
    dim(`  ${result.size} bytes  •  sha256 ${result.sha256?.slice(0, 12)}…`),
  ];
  if (result.handoffError) {
    lines.push(warning(`  Handoff failed: ${result.handoffError.message}`));
  }
  lines.push(MANUAL_UPLOAD_HINT);
  return lines.join('\n');
}

function formatSkipCurrentMessage(result: BuildAndOpenSkillResult): string {
  const version = result.skillVersion ?? 'unknown';
  const recordedAt = result.recordedAt ?? 'unknown';
  return [
    info(`OpenKnowledge skill ${accent(`v${version}`)} already delivered to Claude Desktop.`),
    dim(`  Recorded at ${recordedAt} in ~/.ok/skill-state.yml`),
    dim(`  Use ${accent('--force')} to rebuild and re-open the install dialog.`),
  ].join('\n');
}

function formatInstalledMessage(result: BuildAndOpenSkillResult): string {
  const versionSuffix = result.skillVersion ? `  •  Skill v${result.skillVersion}` : '';
  return [
    success(`Built ${result.outputPath}`),
    dim(`  ${result.size} bytes  •  sha256 ${result.sha256?.slice(0, 12)}…${versionSuffix}`),
    info('  Claude Desktop App opened. Now upload the file manually:'),
    ...UPLOAD_STEPS,
    dim(
      `  If Claude Desktop didn't open, open it and start at step 1. The file is at ${result.outputPath}`,
    ),
  ].join('\n');
}

function formatFailedMessage(result: BuildAndOpenSkillResult): string {
  return `${errorColor('Error:')} ${result.buildError ?? 'unknown build failure'}`;
}

/**
 * Programmatic entry point — same shape as `runSeed`: callable from the
 * Commander action or directly from tests. Delegates the actual build +
 * file-association work to the shared `buildAndOpenSkill` helper; this
 * function only owns the colored-output framing.
 */
export async function runCoworkSkill(
  opts: BuildDesktopSkillOptions = {},
): Promise<BuildDesktopSkillCliResult> {
  const result = await buildAndOpenSkill(opts);

  if (result.status === 'failed') {
    return { ...result, message: formatFailedMessage(result), exitCode: 1 };
  }
  if (result.status === 'skip-current') {
    return { ...result, message: formatSkipCurrentMessage(result), exitCode: 0 };
  }
  if (result.status === 'installed') {
    return { ...result, message: formatInstalledMessage(result), exitCode: 0 };
  }
  // 'built' — either --no-open, unsupported platform, or soft handoff failure.
  return { ...result, message: formatBuiltMessage(result), exitCode: 0 };
}

/**
 * Commander-style factory. Registered HIDDEN in `cli.ts` — see the file header.
 * The description is still set (so `ok cowork --help` is usable for the rare
 * user who already knows the command), but the command does not appear in the
 * top-level help listing and is not surfaced anywhere proactively.
 */
export function coworkCommand(): Command {
  return new Command('cowork')
    .description(
      'Build openknowledge.skill and open the Claude Desktop App so you can upload it for Claude Chat & Cowork. (Advanced/rarely needed — `ok init` already wires Claude.)',
    )
    .option('--out <path>', 'Custom output path (default: ~/Downloads/openknowledge.skill)')
    .option('--no-open', 'Build the file but skip the OS file-association handoff')
    .option('--force', 'Bypass the install-state gate and rebuild unconditionally')
    .action(async (cliOpts: { out?: string; open: boolean; force?: boolean }) => {
      const result = await runCoworkSkill({
        out: cliOpts.out,
        // Commander's `--no-open` sets `cliOpts.open === false` when the flag is passed.
        noOpen: !cliOpts.open,
        force: cliOpts.force ?? false,
      });
      process.stdout.write(`${result.message}\n`);
      if (result.exitCode !== 0) process.exit(result.exitCode);
    });
}
