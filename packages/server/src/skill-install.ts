import { type SpawnOptions, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  type BuildSkillZipResult,
  buildSkillZip,
  resolveBundledSkillDir,
} from './build-skill-zip.ts';
import { tracedMkdir } from './fs-traced.ts';
import { recordSkillInstallEvent, type SkillInstallEventOutcome } from './skill-install-events.ts';
import {
  readServerPackageVersion,
  readTargetRecordedAt,
  readTargetVersion,
  type SkillStateLogger,
  type SkillStateSurface,
  writeTargetVersion,
} from './skill-state.ts';

export type SkillInstallLogger = SkillStateLogger;

export type SpawnLike = (
  command: string,
  args: readonly string[],
  opts: SpawnOptions,
) => ReturnType<typeof spawn>;

export interface InstallUserSkillOptions {
  home?: string;
  logger?: SkillInstallLogger;
  spawn?: SpawnLike;
  timeoutMs?: number;
  surface?: SkillStateSurface;
  platform?: NodeJS.Platform;
}

export type InstallUserSkillResult = 'installed' | 'skip-current' | 'failed';

const CENTRAL_SKILL_DIR_REL = ['.agents', 'skills', 'open-knowledge-discovery'] as const;

const LEGACY_USER_SKILL_NAME = 'open-knowledge';

const LEGACY_USER_SKILL_HOST_DIRS = ['.claude', '.cursor', '.agents'] as const;

const SKILLS_CLI_SPEC = 'skills@~1.5.0';

const DEFAULT_TIMEOUT_MS = 60_000;

function centralSkillDir(home: string): string {
  return join(home, ...CENTRAL_SKILL_DIR_REL);
}

async function centralSkillExists(home: string): Promise<boolean> {
  try {
    const info = await stat(centralSkillDir(home));
    return info.isDirectory();
  } catch {
    return false;
  }
}

interface SpawnOutcome {
  kind: 'ok' | 'nonzero' | 'timeout' | 'spawn-error';
  exitCode?: number | null;
  stderr: string;
  error?: Error;
}

export function quoteForWindowsShell(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
}

function runSpawn(
  spawnFn: SpawnLike,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  platform: NodeJS.Platform,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    const useShell = platform === 'win32';
    const spawnArgs = useShell ? args.map(quoteForWindowsShell) : args;
    try {
      child = spawnFn(command, spawnArgs, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(useShell ? { shell: true } : {}),
      });
    } catch (err) {
      resolve({ kind: 'spawn-error', stderr: '', error: err as Error });
      return;
    }

    let stderr = '';
    let settled = false;
    const settle = (outcome: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    });

    child.on('error', (err) => {
      settle({ kind: 'spawn-error', stderr, error: err });
    });

    child.on('exit', (code) => {
      if (code === 0) settle({ kind: 'ok', exitCode: code, stderr });
      else settle({ kind: 'nonzero', exitCode: code, stderr });
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
      settle({ kind: 'timeout', stderr });
    }, timeoutMs);
  });
}

async function anyLegacyUserSkillExists(home: string): Promise<boolean> {
  for (const hostDir of LEGACY_USER_SKILL_HOST_DIRS) {
    try {
      const info = await stat(join(home, hostDir, 'skills', LEGACY_USER_SKILL_NAME));
      if (info.isDirectory()) return true;
    } catch {}
  }
  return false;
}

async function removeLegacyUserSkill(
  home: string,
  spawnFn: SpawnLike,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  logger: SkillInstallLogger,
  platform: NodeJS.Platform,
): Promise<void> {
  if (!(await anyLegacyUserSkillExists(home))) return;
  const args = ['-y', SKILLS_CLI_SPEC, 'remove', '--agent', '*', '-g', LEGACY_USER_SKILL_NAME];
  const outcome = await runSpawn(spawnFn, 'npx', args, env, timeoutMs, platform);
  if (outcome.kind !== 'ok') {
    logger.warn(
      {
        event: 'skill-install.legacy-remove-failed',
        reason: outcome.kind,
        exitCode: outcome.exitCode,
        stderr: outcome.stderr,
      },
      'Legacy `open-knowledge` skill removal did not exit cleanly; continuing with install.',
    );
  }
}

export async function installUserSkill(
  opts: InstallUserSkillOptions = {},
): Promise<InstallUserSkillResult> {
  const home = opts.home ?? homedir();
  const logger: SkillInstallLogger = opts.logger ?? {
    warn: (data, message) => console.warn(message, data),
    info: (data, message) => console.info(message, data),
  };
  const spawnFn = opts.spawn ?? (spawn as SpawnLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const surfaceAttribution: SkillStateSurface = opts.surface ?? 'cli-npx-skills-add';
  const platform = opts.platform ?? process.platform;

  const report = async (
    outcome: SkillInstallEventOutcome,
    version?: string,
    reason?: string,
  ): Promise<void> => {
    await recordSkillInstallEvent(
      {
        ts: new Date().toISOString(),
        surface: surfaceAttribution,
        target: 'cli-hosts',
        bundle: 'discovery',
        outcome,
        ...(version !== undefined ? { version } : {}),
        ...(reason !== undefined ? { reason } : {}),
      },
      { homedir: () => home, warn: logger.warn },
    );
  };

  let currentVersion: string;
  try {
    currentVersion = await readServerPackageVersion();
  } catch (err) {
    logger.warn(
      { event: 'skill-install.failed', reason: 'version-read-failed', error: String(err) },
      'Skill install aborted — could not read @inkeep/open-knowledge-server version.',
    );
    await report('failed', undefined, 'version-read-failed');
    return 'failed';
  }

  const existingVersion = await readTargetVersion(home, 'cli-hosts', logger).catch((err) => {
    logger.warn(
      { event: 'skill-install.gate.read-failed', error: String(err) },
      'Could not read cli-hosts install-state; proceeding with fresh install.',
    );
    return null;
  });
  if (existingVersion !== null && existingVersion === currentVersion) {
    if (await centralSkillExists(home)) {
      logger.info?.(
        { event: 'skill-install.skip-current', version: currentVersion },
        'OpenKnowledge skill already installed at current version; skipping.',
      );
      await report('skip-current', currentVersion);
      return 'skip-current';
    }
    logger.info?.(
      {
        event: 'skill-install.reinstall-missing',
        version: currentVersion,
        path: centralSkillDir(home),
      },
      'Sidecar matches current version but skill files are missing; reinstalling.',
    );
  }

  let discoveryDir: string;
  try {
    discoveryDir = resolveBundledSkillDir('discovery', { checkDesktop: false });
  } catch (err) {
    logger.warn(
      {
        event: 'skill-install.failed',
        reason: 'bundled-asset-missing',
        error: String(err),
      },
      'Skill install aborted — bundled discovery SKILL.md asset not found.',
    );
    await report('failed', currentVersion, 'bundled-asset-missing');
    return 'failed';
  }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };

  await removeLegacyUserSkill(home, spawnFn, env, timeoutMs, logger, platform);

  const args = ['-y', SKILLS_CLI_SPEC, 'add', discoveryDir, '--agent', '*', '-g', '-y', '--copy'];
  const outcome = await runSpawn(spawnFn, 'npx', args, env, timeoutMs, platform);

  if (outcome.kind === 'ok') {
    try {
      await writeTargetVersion(home, 'cli-hosts', currentVersion, surfaceAttribution, logger);
    } catch (err) {
      logger.warn(
        { event: 'skill-install.failed', reason: 'sidecar-write-failed', error: String(err) },
        'Skill install succeeded but sidecar write failed.',
      );
      await report('failed', currentVersion, 'sidecar-write-failed');
      return 'failed';
    }
    logger.info?.(
      { event: 'skill-install.installed', version: currentVersion },
      'OpenKnowledge skill installed to detected agent hosts.',
    );
    await report('installed', currentVersion);
    return 'installed';
  }

  if (outcome.kind === 'timeout') {
    logger.warn(
      { event: 'skill-install.failed', reason: 'timeout', timeoutMs, stderr: outcome.stderr },
      'Skill install subprocess timed out. Run manually: npx ' +
        `${SKILLS_CLI_SPEC} add ${discoveryDir} --agent '*' -g -y --copy`,
    );
    await report('failed', currentVersion, 'timeout');
    return 'failed';
  }

  if (outcome.kind === 'spawn-error') {
    logger.warn(
      {
        event: 'skill-install.failed',
        reason: 'spawn-error',
        error: String(outcome.error),
        stderr: outcome.stderr,
      },
      'Skill install failed — `npx` unavailable or spawn errored. Run manually: npx ' +
        `${SKILLS_CLI_SPEC} add ${discoveryDir} --agent '*' -g -y --copy`,
    );
    await report('failed', currentVersion, 'spawn-error');
    return 'failed';
  }

  logger.warn(
    {
      event: 'skill-install.failed',
      reason: 'nonzero-exit',
      exitCode: outcome.exitCode,
      stderr: outcome.stderr,
    },
    'Skill install subprocess exited non-zero. Run manually: npx ' +
      `${SKILLS_CLI_SPEC} add ${discoveryDir} --agent '*' -g -y --copy`,
  );
  await report('failed', currentVersion, `nonzero-exit:${outcome.exitCode ?? 'unknown'}`);
  return 'failed';
}

const DOWNLOADS_DIR = 'Downloads';
const SKILL_FILENAME = 'openknowledge.skill';

export interface BuildAndOpenSkillOptions {
  out?: string;
  noOpen?: boolean;
  /** Bypass the per-target `claude-cowork` install-state gate. Used by the
   * "Reinstall skill" affordance and by the CLI's `--force` flag. */
  force?: boolean;
  spawnFn?: SpawnLike;
  platformName?: NodeJS.Platform;
  home?: string;
  logger?: SkillInstallLogger;
}

export type BuildAndOpenSkillStatus = 'installed' | 'built' | 'failed' | 'skip-current';

export interface BuildAndOpenSkillResult {
  status: BuildAndOpenSkillStatus;
  outputPath?: string;
  size?: number;
  sha256?: string;
  skillVersion?: string;
  handoffError?: { reason: 'unsupported-platform' | 'spawn-error'; message: string };
  buildError?: string;
  recordedAt?: string;
}

function defaultDownloadsPath(home: string): string {
  return join(home, DOWNLOADS_DIR, SKILL_FILENAME);
}

function invokeFileAssociation(
  skillPath: string,
  platformName: NodeJS.Platform,
  spawnFn: SpawnLike,
): { ok: true } | { ok: false; reason: 'unsupported-platform' | 'spawn-error'; message: string } {
  const detached: SpawnOptions = { detached: true, stdio: 'ignore' };
  try {
    if (platformName === 'darwin') {
      spawnFn('open', [skillPath], detached).unref();
      return { ok: true };
    }
    if (platformName === 'win32') {
      spawnFn('cmd', ['/c', 'start', '""', skillPath], detached).unref();
      return { ok: true };
    }
    if (platformName === 'linux') {
      spawnFn('xdg-open', [skillPath], detached).unref();
      return { ok: true };
    }
    return {
      ok: false,
      reason: 'unsupported-platform',
      message: `Platform '${platformName}' has no file-association invocation wired.`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn-error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function buildAndOpenSkill(
  opts: BuildAndOpenSkillOptions = {},
): Promise<BuildAndOpenSkillResult> {
  const home = opts.home ?? homedir();
  const outputPath = resolvePath(opts.out ?? defaultDownloadsPath(home));
  const platformName = opts.platformName ?? osPlatform();
  const spawnFn = opts.spawnFn ?? spawn;
  const logger = opts.logger;

  const report = async (
    outcome: SkillInstallEventOutcome,
    version?: string,
    reason?: string,
  ): Promise<void> => {
    await recordSkillInstallEvent(
      {
        ts: new Date().toISOString(),
        surface: 'server-build-and-open',
        target: 'claude-cowork',
        bundle: 'project',
        outcome,
        ...(version !== undefined ? { version } : {}),
        ...(reason !== undefined ? { reason } : {}),
      },
      { homedir: () => home, warn: logger?.warn },
    );
  };

  if (!opts.force) {
    let currentVersion: string | null = null;
    try {
      currentVersion = await readServerPackageVersion();
    } catch (err) {
      logger?.warn?.(
        { event: 'skill-install.gate.version-read-failed', error: String(err) },
        'Could not read @inkeep/open-knowledge-server version for gate check; rebuilding.',
      );
    }

    if (currentVersion !== null) {
      let recordedVersion: string | null = null;
      let recordedAt: string | null = null;
      try {
        [recordedVersion, recordedAt] = await Promise.all([
          readTargetVersion(home, 'claude-cowork', logger),
          readTargetRecordedAt(home, 'claude-cowork', logger),
        ]);
      } catch (err) {
        logger?.warn?.(
          { event: 'skill-install.gate.read-failed', error: String(err) },
          'Could not read claude-cowork install-state; rebuilding.',
        );
      }

      if (recordedVersion !== null && recordedVersion === currentVersion) {
        logger?.info?.(
          {
            event: 'skill-install.skip-current',
            target: 'claude-cowork',
            version: currentVersion,
          },
          'OpenKnowledge skill already delivered at current version; skipping rebuild.',
        );
        await report('skip-current', currentVersion);
        return {
          status: 'skip-current',
          skillVersion: currentVersion,
          ...(recordedAt !== null ? { recordedAt } : {}),
        };
      }
    }
  }

  try {
    await tracedMkdir(dirname(outputPath), { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await report('failed', undefined, `mkdir-failed:${message}`);
    return {
      status: 'failed',
      buildError: `could not create output directory: ${message}`,
    };
  }

  let build: BuildSkillZipResult;
  try {
    build = await buildSkillZip({ outputPath, bundle: 'project' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await report('failed', undefined, `build-failed:${message}`);
    return {
      status: 'failed',
      buildError: message,
    };
  }

  const baseResult: BuildAndOpenSkillResult = {
    status: 'built',
    outputPath: build.outputPath,
    size: build.size,
    sha256: build.sha256,
    skillVersion: build.skillVersion,
  };

  if (build.skillVersion) {
    try {
      await writeTargetVersion(
        home,
        'claude-cowork',
        build.skillVersion,
        'server-build-and-open',
        logger,
      );
    } catch (err) {
      logger?.warn?.(
        {
          event: 'skill-install.state-write-failed',
          target: 'claude-cowork',
          version: build.skillVersion,
          error: String(err),
        },
        'Skill bundle built but install-state write failed; gate will re-trigger build on next click.',
      );
    }
  }

  if (opts.noOpen) {
    await report('built', build.skillVersion);
    return baseResult;
  }

  const invocation = invokeFileAssociation(build.outputPath, platformName, spawnFn);
  if (!invocation.ok) {
    await report('built', build.skillVersion, `handoff-${invocation.reason}`);
    return {
      ...baseResult,
      handoffError: { reason: invocation.reason, message: invocation.message },
    };
  }

  await report('installed', build.skillVersion);
  return { ...baseResult, status: 'installed' };
}
