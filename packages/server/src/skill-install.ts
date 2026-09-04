import { type SpawnOptions, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import {
  EDITOR_PROJECT_SKILL_ROOT,
  type EditorId,
  OPENKNOWLEDGE_SKILLS_REPO,
  PROJECT_SKILL_EDITOR_IDS,
  skillRootActivationPath,
  USER_SKILL_HOSTS,
} from '@inkeep/open-knowledge-core';
import {
  type BuildSkillZipResult,
  buildSkillZip,
  resolveBundledSkillDir,
} from './build-skill-zip.ts';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
import { tracedCpSync, tracedMkdir, tracedMkdirSync, tracedRmSync } from './fs-traced.ts';
import { getLogger } from './logger.ts';
import { BUNDLE_SKILL_NAME, type BundleId } from './skill-bundles.ts';
import { recordSkillInstallEvent, type SkillInstallEventOutcome } from './skill-install-events.ts';
import { resolveSkillInstallReportSettings } from './skill-install-report-config.ts';
import { readKnownSkillPlacementRoots } from './skill-placements-store.ts';
import {
  readBundleDecision,
  readServerPackageVersion,
  readTargetRecordedAt,
  readTargetVersion,
  type SkillStateLogger,
  type SkillStateSurface,
  writeTargetVersion,
} from './skill-state.ts';
import { reportSkillInstall } from './skills-sh-install-report.ts';

export type SkillInstallLogger = SkillStateLogger;

export type SpawnLike = (
  command: string,
  args: readonly string[],
  opts: SpawnOptions,
) => ReturnType<typeof spawn>;

export interface InstallUserSkillOptions {
  home?: string;
  logger?: SkillInstallLogger;
  surface?: SkillStateSurface;
  bundleId?: BundleId;
  force?: boolean;
}

export type InstallUserSkillResult = 'installed' | 'skip-current' | 'failed' | 'no-hosts';

const LEGACY_USER_SKILL_NAME = 'open-knowledge';

const CENTRAL_HOST_DIR = '.agents';

function centralSkillDir(home: string, bundleName: string): string {
  return join(home, CENTRAL_HOST_DIR, 'skills', bundleName);
}

export interface DetectedSkillHost {
  readonly hostDir: string;
  readonly skillsRoot: string;
  readonly editorId: EditorId;
}

export function detectUserSkillHosts(home: string): DetectedSkillHost[] {
  return USER_SKILL_HOSTS.filter((host) => existsSync(join(home, host.hostDir)));
}

export interface ResolvedSkillHost {
  readonly editor: string;
  readonly skillsRoot: string;
  readonly custom: boolean;
}

export function resolveBuiltinSkillHosts(home: string): ResolvedSkillHost[] {
  const staticHosts: ResolvedSkillHost[] = detectUserSkillHosts(home).map((host) => ({
    editor: host.editorId,
    skillsRoot: host.skillsRoot,
    custom: false,
  }));
  const seen = new Set(staticHosts.map((host) => host.skillsRoot));
  const customHosts: ResolvedSkillHost[] = readKnownSkillPlacementRoots(home)
    .filter((root) => !seen.has(root) && existsSync(join(home, root)))
    .map((root) => ({ editor: root, skillsRoot: root, custom: true }));
  return [...staticHosts, ...customHosts];
}

export function detectProjectSkillEditors(projectDir: string): EditorId[] {
  return PROJECT_SKILL_EDITOR_IDS.filter((editorId) => {
    const root = EDITOR_PROJECT_SKILL_ROOT[editorId];
    return root !== null && existsSync(join(projectDir, skillRootActivationPath(root)));
  });
}

async function installedUserSkillExists(home: string, bundleName: string): Promise<boolean> {
  const candidates = detectUserSkillHosts(home).map((host) =>
    join(home, host.skillsRoot, bundleName),
  );
  if (existsSync(join(home, CENTRAL_HOST_DIR))) {
    candidates.push(centralSkillDir(home, bundleName));
  }

  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return true;
    } catch {}
  }
  return false;
}

function removeLegacyUserSkillDirs(
  home: string,
  hosts: readonly DetectedSkillHost[],
  logger: SkillInstallLogger,
): void {
  const legacySkillRoots = [...hosts.map((host) => host.skillsRoot), `${CENTRAL_HOST_DIR}/skills`];
  for (const skillsRoot of legacySkillRoots) {
    const legacyDir = join(home, skillsRoot, LEGACY_USER_SKILL_NAME);
    if (!existsSync(legacyDir)) continue;
    try {
      tracedRmSync(legacyDir, { recursive: true, force: true });
      logger.info?.(
        { event: 'skill-install.legacy-removed', path: legacyDir },
        'Removed pre-split `open-knowledge` user-global skill dir.',
      );
    } catch (err) {
      logger.warn(
        { event: 'skill-install.legacy-remove-failed', path: legacyDir, err },
        'Legacy `open-knowledge` skill removal failed; continuing with install.',
      );
    }
  }
}

function replaceSkillDir(sourceDir: string, destDir: string): void {
  tracedRmSync(destDir, { recursive: true, force: true });
  tracedMkdirSync(dirname(destDir), { recursive: true });
  tracedCpSync(sourceDir, destDir, { recursive: true });
}

interface SkillWriteEntry {
  path: string;
  status: 'written' | 'failed';
  error?: string;
}

function writeBundleToHosts(
  home: string,
  bundleName: string,
  sourceDir: string,
  hosts: readonly DetectedSkillHost[],
  includeCentral: boolean,
): SkillWriteEntry[] {
  const entries: SkillWriteEntry[] = [];
  const centralDest = centralSkillDir(home, bundleName);
  const destinations = [
    ...(includeCentral ? [centralDest] : []),
    ...hosts
      .map((host) => join(home, host.skillsRoot, bundleName))
      .filter((dest) => dest !== centralDest),
  ];

  for (const dest of destinations) {
    try {
      replaceSkillDir(sourceDir, dest);
      entries.push({ path: dest, status: 'written' });
    } catch (err) {
      entries.push({
        path: dest,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return entries;
}

export async function installUserSkill(
  opts: InstallUserSkillOptions = {},
): Promise<InstallUserSkillResult> {
  const home = opts.home ?? homedir();
  const logger: SkillInstallLogger = opts.logger ?? {
    warn: (data, message) => getLogger('skills').warn(data, message),
    info: (data, message) => getLogger('skills').info(data, message),
  };
  const surfaceAttribution: SkillStateSurface = opts.surface ?? 'cli-npx-skills-add';
  const bundleId = opts.bundleId ?? 'discovery';
  const bundleName = BUNDLE_SKILL_NAME[bundleId];

  if (!isAbsolute(home)) {
    logger.warn(
      { event: 'skill-install.failed', reason: 'home-not-absolute', home },
      'Skill install aborted — $HOME is not an absolute path.',
    );
    return 'failed';
  }

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
        bundle: bundleId,
        outcome,
        ...(version !== undefined ? { version } : {}),
        ...(reason !== undefined ? { reason } : {}),
      },
      { homedir: () => home, warn: logger.warn },
    );
  };

  let declined: boolean | null;
  try {
    declined = await readBundleDecision(home, bundleName, logger);
  } catch (err) {
    logger.warn(
      { event: 'skill-install.gate.decision-read-failed', bundle: bundleId, err },
      'Could not read the opt-out decision; skipping the install rather than risk reversing it.',
    );
    await report('skip-current', undefined, 'decision-read-failed');
    return 'skip-current';
  }
  if (declined === false) {
    logger.info?.(
      { event: 'skill-install.declined', bundle: bundleId },
      'Bundle is opted out; skipping user-global skill install.',
    );
    await report('skip-current', undefined, 'declined');
    return 'skip-current';
  }

  let currentVersion: string;
  try {
    currentVersion = await readServerPackageVersion();
  } catch (err) {
    logger.warn(
      { event: 'skill-install.failed', reason: 'version-read-failed', err },
      'Skill install aborted — could not read @inkeep/open-knowledge-server version.',
    );
    await report('failed', undefined, 'version-read-failed');
    return 'failed';
  }

  const existingVersion = await readTargetVersion(home, 'cli-hosts', logger).catch((err) => {
    logger.warn(
      { event: 'skill-install.gate.read-failed', err },
      'Could not read cli-hosts install-state; proceeding with fresh install.',
    );
    return null;
  });
  if (!opts.force && existingVersion !== null && existingVersion === currentVersion) {
    if (await installedUserSkillExists(home, bundleName)) {
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
      },
      'Sidecar matches current version but skill files are missing; reinstalling.',
    );
  }

  let bundleDir: string;
  try {
    bundleDir = resolveBundledSkillDir(bundleId, { checkDesktop: false });
  } catch (err) {
    logger.warn(
      {
        event: 'skill-install.failed',
        reason: 'bundled-asset-missing',
        err,
      },
      'Skill install aborted — bundled SKILL.md asset not found.',
    );
    await report('failed', currentVersion, 'bundled-asset-missing');
    return 'failed';
  }
  const hosts = detectUserSkillHosts(home);
  const includeCentral = existsSync(join(home, CENTRAL_HOST_DIR));
  if (hosts.length === 0 && !includeCentral) {
    logger.info?.(
      { event: 'skill-install.no-hosts', version: currentVersion },
      'No supported agent host detected; skipping user-global skill install.',
    );
    await report('skip-current', currentVersion, 'no-hosts');
    return 'no-hosts';
  }

  removeLegacyUserSkillDirs(home, hosts, logger);

  const entries = writeBundleToHosts(home, bundleName, bundleDir, hosts, includeCentral);
  const written = entries.filter((e) => e.status === 'written');
  const failed = entries.filter((e) => e.status === 'failed');

  if (written.length === 0) {
    logger.warn(
      { event: 'skill-install.failed', reason: 'write-failed', entries: failed },
      'Skill install failed — every destination write errored.',
    );
    await report('failed', currentVersion, 'write-failed');
    return 'failed';
  }

  try {
    await writeTargetVersion(home, 'cli-hosts', currentVersion, surfaceAttribution, logger);
  } catch (err) {
    logger.warn(
      { event: 'skill-install.failed', reason: 'sidecar-write-failed', err },
      'Skill install succeeded but sidecar write failed.',
    );
    await report('failed', currentVersion, 'sidecar-write-failed');
    return 'failed';
  }

  if (failed.length > 0) {
    logger.warn(
      { event: 'skill-install.partial', version: currentVersion, entries: failed },
      'Some agent hosts could not be written; the remaining copies are installed.',
    );
  }
  logger.info?.(
    {
      event: 'skill-install.installed',
      version: currentVersion,
      hosts: hosts.map((h) => h.editorId),
      paths: written.map((e) => e.path),
    },
    `OpenKnowledge skill installed to ${written.length} location(s): ${written
      .map((e) => e.path)
      .join(', ')}`,
  );
  await report('installed', currentVersion);
  void reportSkillInstall(
    {
      source: OPENKNOWLEDGE_SKILLS_REPO,
      skills: [bundleName],
      agents: hosts.map((h) => h.editorId),
      global: true,
      version: currentVersion,
    },
    { home, enabled: resolveSkillInstallReportSettings(home).enabled },
  );
  return 'installed';
}

const DOWNLOADS_DIR = 'Downloads';
const SKILL_FILENAME = 'openknowledge.skill';

export interface BuildAndOpenSkillOptions {
  out?: string;
  noOpen?: boolean;
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
  const detached: SpawnOptions = withHiddenWindowsConsole({
    detached: true,
    stdio: 'ignore',
  });
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
        { event: 'skill-install.gate.version-read-failed', err },
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
          { event: 'skill-install.gate.read-failed', err },
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

  let installedVersion: string | undefined;
  try {
    installedVersion = await readServerPackageVersion();
  } catch {
    installedVersion = undefined;
  }

  const baseResult: BuildAndOpenSkillResult = {
    status: 'built',
    outputPath: build.outputPath,
    size: build.size,
    sha256: build.sha256,
    skillVersion: installedVersion,
  };

  if (installedVersion) {
    try {
      await writeTargetVersion(
        home,
        'claude-cowork',
        installedVersion,
        'server-build-and-open',
        logger,
      );
    } catch (err) {
      logger?.warn?.(
        {
          event: 'skill-install.state-write-failed',
          target: 'claude-cowork',
          version: installedVersion,
          err,
        },
        'Skill bundle built but install-state write failed; gate will re-trigger build on next click.',
      );
    }
  }

  if (opts.noOpen) {
    await report('built', installedVersion);
    return baseResult;
  }

  const invocation = invokeFileAssociation(build.outputPath, platformName, spawnFn);
  if (!invocation.ok) {
    await report('built', installedVersion, `handoff-${invocation.reason}`);
    return {
      ...baseResult,
      handoffError: { reason: invocation.reason, message: invocation.message },
    };
  }

  await report('installed', installedVersion);
  void reportSkillInstall(
    {
      source: OPENKNOWLEDGE_SKILLS_REPO,
      skills: [BUNDLE_SKILL_NAME.project],
      agents: ['claude-desktop'],
      global: true,
      version: installedVersion,
    },
    { home, enabled: resolveSkillInstallReportSettings(home).enabled },
  );
  return { ...baseResult, status: 'installed' };
}
