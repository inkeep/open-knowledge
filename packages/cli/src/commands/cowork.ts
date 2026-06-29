import {
  type BuildAndOpenSkillResult,
  buildAndOpenSkill,
  type SpawnLike,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { accent, dim, error as errorColor, info, success, warning } from '../ui/colors.ts';

interface BuildDesktopSkillOptions {
  out?: string;
  noOpen?: boolean;
  /** Bypass the install-state gate and rebuild unconditionally. When Claude
   * Desktop has lost the skill, `--force` rebuilds the bundle without
   * consulting `~/.ok/skill-state/claude-cowork`. */
  force?: boolean;
  spawnFn?: SpawnLike;
  platformName?: NodeJS.Platform;
  /** Test seam — override `$HOME` so the install-state gate reads/writes
   * a tmpdir instead of the real `~/.ok/skill-state/`. */
  home?: string;
}

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
  return { ...result, message: formatBuiltMessage(result), exitCode: 0 };
}

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
        noOpen: !cliOpts.open,
        force: cliOpts.force ?? false,
      });
      process.stdout.write(`${result.message}\n`);
      if (result.exitCode !== 0) process.exit(result.exitCode);
    });
}
