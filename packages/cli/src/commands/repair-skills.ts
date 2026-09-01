import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  rmSync as fsRmSync,
  statSync as fsStatSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { USER_SKILL_HOSTS } from '@inkeep/open-knowledge-core';
import {
  BUNDLE_SKILL_NAME,
  type BundleId,
  readBundleDecision,
  readServerPackageVersion,
  readTargetVersion,
  recordSkillInstallEvent,
  resolveBundledSkillDir,
  resolveBundleEnabled,
  type SkillInstallEvent,
  USER_GLOBAL_BUNDLE_IDS,
  writeBundleDecision,
  writeTargetVersion,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { canonicalizeForCompare } from '../integrations/resolve-project-root.ts';
import {
  applyLegacyFanoutSweep,
  type LegacyFanoutSweepPlan,
  planLegacyFanoutSweep,
  removeUserGlobalSkillBundle,
} from '../integrations/skill-teardown.ts';
import { assertProjectPathSafe } from '../integrations/write-project-skill.ts';
import { accent, dim, warning } from '../ui/colors.ts';
import {
  EDITOR_TARGETS,
  type EditorId,
  type EditorMcpTarget,
  HOSTS_WITH_USER_SKILL_DIR,
} from './editors.ts';

const USER_SKILL_DIR_NAME = 'open-knowledge-discovery';
const PROJECT_SKILL_DIR_NAME = 'open-knowledge';
const CENTRAL_USER_SKILL_REL = ['.agents', 'skills', USER_SKILL_DIR_NAME] as const;

export interface RepairSkillsLogEvent {
  event: string;
  scope?: 'project' | 'user';
  editorId?: string;
  hostDir?: string;
  path?: string;
  version?: string;
  preexisting?: boolean;
  reason?: string;
  bundle?: string;
  error?: string;
}

export interface RepairSkillsFsOps {
  existsSync(path: string): boolean;
  isDirectory(path: string): boolean;
  readdirSync(path: string): string[];
  readFileSync(path: string): Buffer;
  writeFileSync(path: string, content: Buffer): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

const defaultFsOps: RepairSkillsFsOps = {
  existsSync: (path) => fsExistsSync(path),
  isDirectory: (path) => {
    try {
      return fsStatSync(path).isDirectory();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  },
  readdirSync: (path) => fsReaddirSync(path),
  readFileSync: (path) => fsReadFileSync(path),
  writeFileSync: (path, content) => {
    fsWriteFileSync(path, content);
  },
  mkdirSync: (path, options) => {
    fsMkdirSync(path, options);
  },
  rmSync: (path, options) => {
    fsRmSync(path, options);
  },
};

export interface RepairSkillsDeps {
  resolveProjectBundledSkillDir?(): string;
  resolveUserBundledSkillDir?(bundle: BundleId): string;
  readBundledVersion?(): Promise<string>;
  readRecordedVersion?(home: string): Promise<string | null>;
  writeRecordedVersion?(home: string, version: string): Promise<void>;
  recordEvent?(event: SkillInstallEvent): Promise<void>;
  readBundleDecision?(home: string, bundleName: string): Promise<boolean | null>;
  writeBundleDecision?(home: string, bundleName: string, enabled: boolean): Promise<void>;
  removeBundleFromDisk?(home: string, bundleId: BundleId): void;
}

const defaultDeps: Required<RepairSkillsDeps> = {
  resolveProjectBundledSkillDir: () => resolveBundledSkillDir('project', { checkDesktop: false }),
  resolveUserBundledSkillDir: (bundle) => resolveBundledSkillDir(bundle, { checkDesktop: false }),
  readBundledVersion: () => readServerPackageVersion(),
  readRecordedVersion: (home) => readTargetVersion(home, 'cli-hosts'),
  writeRecordedVersion: (home, version) =>
    writeTargetVersion(home, 'cli-hosts', version, 'cli-start'),
  recordEvent: (event) => recordSkillInstallEvent(event),
  readBundleDecision: (home, name) => readBundleDecision(home, name),
  writeBundleDecision: (home, name, enabled) => writeBundleDecision(home, name, enabled),
  removeBundleFromDisk: (home, bundleId) => removeUserGlobalSkillBundle(home, bundleId),
};

export interface RepairSkillsContext {
  projectDir: string;
  reclaimDisableEnv?: string | null;
  home?: string;
  logger?: (event: RepairSkillsLogEvent) => void;
  deps?: RepairSkillsDeps;
  fs?: RepairSkillsFsOps;
  confirmLegacyCleanup?: (plan: LegacyFanoutSweepPlan) => Promise<boolean>;
}

export type ProjectSkillOutcome =
  | 'no-token'
  | 'present'
  | 'created'
  | 'failed'
  | 'skipped-global-collision';
export type UserSkillCentralOutcome = 'written' | 'skipped-present' | 'failed';
export type UserSkillHostOutcome =
  | 'written'
  | 'skipped-present'
  | 'skipped-host-absent'
  | 'skipped-collapsed-with-central'
  | 'failed';

export interface ProjectSkillEntry {
  editorId: string;
  hostDir: string;
  path: string;
  outcome: ProjectSkillOutcome;
  error?: string;
}

export type UserSkillEntry =
  | {
      kind: 'central';
      path: string;
      outcome: UserSkillCentralOutcome;
      error?: string;
    }
  | {
      kind: 'host';
      editorId: string;
      hostDir: string;
      path: string;
      outcome: UserSkillHostOutcome;
      error?: string;
    };

export type ProjectSweepResult =
  | { outcome: 'done'; entries: ProjectSkillEntry[] }
  | { outcome: 'skipped'; reason: string };

export type UserSweepResult =
  | { outcome: 'done'; version: string; entries: UserSkillEntry[] }
  | { outcome: 'skipped'; reason: string };

export type RepairSkillsResult =
  | { status: 'skipped'; reason: string }
  | {
      status: 'done';
      project: ProjectSweepResult;
      user: UserSweepResult;
      legacySwept: string[];
      legacyCleanupDeclined: boolean;
      legacyCleanupFailed: boolean;
    };

function defaultLogger(event: RepairSkillsLogEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

function replaceDir(sourceDir: string, destDir: string, fs: RepairSkillsFsOps): void {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(dirname(destDir), { recursive: true });
  copyDirContents(sourceDir, destDir, fs);
}

function copyDirContents(sourceDir: string, destDir: string, fs: RepairSkillsFsOps): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir)) {
    const src = join(sourceDir, entry);
    const dst = join(destDir, entry);
    if (fs.isDirectory(src)) {
      copyDirContents(src, dst, fs);
    } else {
      fs.writeFileSync(dst, fs.readFileSync(src));
    }
  }
}

function userBundleExists(home: string, bundleName: string, fs: RepairSkillsFsOps): boolean {
  return (
    fs.existsSync(join(home, '.agents', 'skills', bundleName)) ||
    USER_SKILL_HOSTS.some((host) => fs.existsSync(join(home, host.skillsRoot, bundleName)))
  );
}

function installUserBundleToHostDirs(
  home: string,
  bundleDirName: string,
  sourceDir: string,
  fs: RepairSkillsFsOps,
  logger: (event: RepairSkillsLogEvent) => void,
  version: string,
): { entries: UserSkillEntry[]; anyWritten: boolean; anyDestinationSucceeded: boolean } {
  const entries: UserSkillEntry[] = [];
  const centralDest = join(home, '.agents', 'skills', bundleDirName);
  if (userBundleExists(home, bundleDirName, fs)) {
    if (fs.existsSync(centralDest)) {
      entries.push({ kind: 'central', path: centralDest, outcome: 'skipped-present' });
    }
    for (const host of USER_SKILL_HOSTS) {
      const hostDest = join(home, host.skillsRoot, bundleDirName);
      if (hostDest === centralDest) continue;
      if (!fs.existsSync(join(home, host.hostDir))) {
        entries.push({
          kind: 'host',
          editorId: host.editorId,
          hostDir: host.hostDir,
          path: hostDest,
          outcome: 'skipped-host-absent',
        });
        continue;
      }
      if (fs.existsSync(hostDest)) {
        entries.push({
          kind: 'host',
          editorId: host.editorId,
          hostDir: host.hostDir,
          path: hostDest,
          outcome: 'skipped-present',
        });
      }
    }
    return { entries, anyWritten: false, anyDestinationSucceeded: true };
  }
  const centralRootExists = fs.existsSync(join(home, '.agents'));
  if (centralRootExists && fs.existsSync(centralDest)) {
    entries.push({ kind: 'central', path: centralDest, outcome: 'skipped-present' });
  } else if (centralRootExists) {
    try {
      replaceDir(sourceDir, centralDest, fs);
      entries.push({ kind: 'central', path: centralDest, outcome: 'written' });
      logger({
        event: 'user-skill-reclaim-central-written',
        scope: 'user',
        path: centralDest,
        preexisting: false,
        version,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      entries.push({ kind: 'central', path: centralDest, outcome: 'failed', error });
      logger({
        event: 'user-skill-reclaim-central-failed',
        scope: 'user',
        path: centralDest,
        error,
      });
    }
  }

  for (const host of USER_SKILL_HOSTS) {
    const hostRoot = join(home, host.hostDir);
    const hostDest = join(home, host.skillsRoot, bundleDirName);
    if (hostDest === centralDest) {
      entries.push({
        kind: 'host',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        outcome: 'skipped-collapsed-with-central',
      });
      continue;
    }
    if (!fs.existsSync(hostRoot)) {
      entries.push({
        kind: 'host',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        outcome: 'skipped-host-absent',
      });
      continue;
    }
    if (fs.existsSync(hostDest)) {
      entries.push({
        kind: 'host',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        outcome: 'skipped-present',
      });
      continue;
    }
    try {
      replaceDir(sourceDir, hostDest, fs);
      entries.push({
        kind: 'host',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        outcome: 'written',
      });
      logger({
        event: 'user-skill-reclaim-host-written',
        scope: 'user',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        preexisting: false,
        version,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      entries.push({
        kind: 'host',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        outcome: 'failed',
        error,
      });
      logger({
        event: 'user-skill-reclaim-host-failed',
        scope: 'user',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        error,
      });
    }
  }
  return {
    entries,
    anyWritten: entries.some((entry) => entry.outcome === 'written'),
    anyDestinationSucceeded: entries.some(
      (entry) => entry.outcome === 'written' || entry.outcome === 'skipped-present',
    ),
  };
}

const OK_MCP_MARKER_PREFIX = '# ok-mcp-';

function editorWiredForOk(configPath: string | undefined, fs: RepairSkillsFsOps): boolean {
  if (!configPath) return false;
  try {
    if (!fs.existsSync(configPath)) return false;
    const bytes = fs.readFileSync(configPath).toString('utf8');
    return bytes.includes(OK_MCP_MARKER_PREFIX);
  } catch {
    return false;
  }
}

function projectConfigIsGlobalConfig(
  target: EditorMcpTarget | undefined,
  projectConfigPath: string | undefined,
  projectDir: string,
  home: string,
): boolean {
  if (!target || !projectConfigPath) return false;
  let globalConfigPath: string;
  try {
    globalConfigPath = target.configPath(projectDir, home);
  } catch {
    return false;
  }
  const canonical = (filePath: string): string =>
    join(canonicalizeForCompare(dirname(filePath)), basename(filePath));
  return canonical(projectConfigPath) === canonical(globalConfigPath);
}

function runProjectSweep(
  projectDir: string,
  home: string,
  deps: Required<RepairSkillsDeps>,
  fs: RepairSkillsFsOps,
  logger: (event: RepairSkillsLogEvent) => void,
): ProjectSweepResult {
  let sourceDir: string;
  try {
    sourceDir = deps.resolveProjectBundledSkillDir();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger({ event: 'project-skill-reclaim-bundle-missing', scope: 'project', error });
    return { outcome: 'skipped', reason: 'bundle-missing' };
  }

  const entries: ProjectSkillEntry[] = [];
  for (const host of HOSTS_WITH_USER_SKILL_DIR) {
    const dest = join(projectDir, host.hostDir, 'skills', PROJECT_SKILL_DIR_NAME);
    const skillFile = join(dest, 'SKILL.md');
    const skillExists = fs.existsSync(skillFile);
    if (skillExists) {
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        outcome: 'present',
      });
      continue;
    }
    const target = EDITOR_TARGETS[host.editorId as EditorId];
    const projectConfigPath = target?.projectConfigPath?.(projectDir);
    if (projectConfigIsGlobalConfig(target, projectConfigPath, projectDir, home)) {
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        outcome: 'skipped-global-collision',
      });
      logger({
        event: 'project-skill-reclaim-skipped-global-collision',
        scope: 'project',
        editorId: host.editorId,
        path: dest,
      });
      continue;
    }
    const wired = editorWiredForOk(projectConfigPath, fs);
    if (!wired) {
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        outcome: 'no-token',
      });
      logger({
        event: 'project-skill-reclaim-no-token',
        scope: 'project',
        editorId: host.editorId,
        path: dest,
      });
      continue;
    }
    try {
      assertProjectPathSafe(dest, projectDir);
      replaceDir(sourceDir, dest, fs);
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        outcome: 'created',
      });
      logger({
        event: 'project-skill-reclaim-created',
        scope: 'project',
        editorId: host.editorId,
        path: dest,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        outcome: 'failed',
        error,
      });
      logger({
        event: 'project-skill-reclaim-failed',
        scope: 'project',
        editorId: host.editorId,
        path: dest,
        error,
      });
    }
  }

  return { outcome: 'done', entries };
}

async function runUserSweep(
  home: string,
  deps: Required<RepairSkillsDeps>,
  fs: RepairSkillsFsOps,
  logger: (event: RepairSkillsLogEvent) => void,
): Promise<UserSweepResult> {
  const recordEventSoft = (event: SkillInstallEvent): void => {
    void deps.recordEvent(event).catch(() => {});
  };
  const nowIso = (): string => new Date().toISOString();

  let bundledVersion: string;
  try {
    bundledVersion = await deps.readBundledVersion();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger({ event: 'user-skill-reclaim-version-read-failed', scope: 'user', error });
    recordEventSoft({
      ts: nowIso(),
      surface: 'cli-start',
      target: 'cli-hosts',
      bundle: 'discovery',
      outcome: 'failed',
      reason: `version-read-failed:${error}`,
    });
    return { outcome: 'skipped', reason: 'version-read-failed' };
  }

  let recordedVersion: string | null;
  try {
    recordedVersion = await deps.readRecordedVersion(home);
  } catch (err) {
    logger({
      event: 'user-skill-reclaim-version-read-error',
      scope: 'user',
      error: err instanceof Error ? err.message : String(err),
    });
    recordedVersion = null;
  }

  const resolvedBundles: Array<{ id: BundleId; sourceDir: string }> = [];
  let lastResolveError: string | null = null;
  for (const bundleId of USER_GLOBAL_BUNDLE_IDS) {
    try {
      resolvedBundles.push({ id: bundleId, sourceDir: deps.resolveUserBundledSkillDir(bundleId) });
    } catch (err) {
      lastResolveError = err instanceof Error ? err.message : String(err);
    }
  }
  if (resolvedBundles.length === 0) {
    logger({
      event: 'user-skill-reclaim-bundle-missing',
      scope: 'user',
      error: lastResolveError ?? 'no user-global bundles',
    });
    recordEventSoft({
      ts: nowIso(),
      surface: 'cli-start',
      target: 'cli-hosts',
      outcome: 'failed',
      reason: `bundle-missing:${lastResolveError}`,
    });
    return { outcome: 'skipped', reason: 'bundle-missing' };
  }

  const gatedBundles: Array<{ id: BundleId; sourceDir: string }> = [];
  for (const bundle of resolvedBundles) {
    const name = BUNDLE_SKILL_NAME[bundle.id];
    const onDisk = userBundleExists(home, name, fs);
    const decision = await deps.readBundleDecision(home, name).catch(() => null);
    if (!resolveBundleEnabled(decision, { installedOnDisk: onDisk })) {
      if (onDisk) {
        try {
          deps.removeBundleFromDisk(home, bundle.id);
          logger({
            event: 'user-skill-reclaim-bundle-declined-removed',
            scope: 'user',
            bundle: bundle.id,
          });
        } catch (err) {
          logger({
            event: 'user-skill-reclaim-bundle-remove-failed',
            scope: 'user',
            bundle: bundle.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      continue;
    }
    if (decision === null && onDisk) {
      try {
        await deps.writeBundleDecision(home, name, true);
      } catch (err) {
        logger({
          event: 'user-skill-reclaim-grandfather-write-failed',
          scope: 'user',
          bundle: bundle.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    gatedBundles.push(bundle);
  }
  if (gatedBundles.length === 0) {
    return { outcome: 'skipped', reason: 'all-bundles-declined' };
  }

  const allEnabledOnDisk = gatedBundles.every((b) =>
    userBundleExists(home, BUNDLE_SKILL_NAME[b.id], fs),
  );
  if (recordedVersion !== null && recordedVersion === bundledVersion && allEnabledOnDisk) {
    logger({
      event: 'user-skill-reclaim-skipped-version-current',
      scope: 'user',
      version: bundledVersion,
    });
    return { outcome: 'skipped', reason: 'version-current' };
  }

  const entries: UserSkillEntry[] = [];
  const allBundlesResolved = resolvedBundles.length === USER_GLOBAL_BUNDLE_IDS.length;
  const bundleResults: Array<{
    id: BundleId;
    anyWritten: boolean;
    landed: boolean;
    centralFailed: boolean;
    hostFailed: boolean;
  }> = [];
  for (const { id, sourceDir } of gatedBundles) {
    const result = installUserBundleToHostDirs(
      home,
      BUNDLE_SKILL_NAME[id],
      sourceDir,
      fs,
      logger,
      bundledVersion,
    );
    entries.push(...result.entries);
    bundleResults.push({
      id,
      anyWritten: result.anyWritten,
      landed: result.anyDestinationSucceeded,
      centralFailed: result.entries.some((e) => e.kind === 'central' && e.outcome === 'failed'),
      hostFailed: result.entries.some((e) => e.kind === 'host' && e.outcome === 'failed'),
    });
  }

  const anyCentralFailed = bundleResults.some((b) => b.centralFailed);
  const allBundlesLanded = bundleResults.every((b) => b.landed);
  if (allBundlesResolved && allBundlesLanded && !anyCentralFailed) {
    let stateWriteError: string | null = null;
    try {
      await deps.writeRecordedVersion(home, bundledVersion);
      logger({
        event: 'user-skill-reclaim-version-recorded',
        scope: 'user',
        version: bundledVersion,
      });
    } catch (err) {
      stateWriteError = err instanceof Error ? err.message : String(err);
      logger({
        event: 'user-skill-reclaim-version-record-failed',
        scope: 'user',
        version: bundledVersion,
        error: stateWriteError,
      });
    }
    for (const { id, anyWritten } of bundleResults) {
      recordEventSoft({
        ts: nowIso(),
        surface: 'cli-start',
        target: 'cli-hosts',
        bundle: id,
        outcome: stateWriteError !== null ? 'failed' : anyWritten ? 'installed' : 'skip-current',
        version: bundledVersion,
        ...(stateWriteError === null ? {} : { reason: `state-write-failed:${stateWriteError}` }),
      });
    }
  } else {
    if (!allBundlesResolved) {
      recordEventSoft({
        ts: nowIso(),
        surface: 'cli-start',
        target: 'cli-hosts',
        outcome: 'failed',
        version: bundledVersion,
        reason: 'bundle-unresolved',
      });
    }
    for (const { id, centralFailed, hostFailed } of bundleResults) {
      if (!centralFailed && !hostFailed) continue;
      recordEventSoft({
        ts: nowIso(),
        surface: 'cli-start',
        target: 'cli-hosts',
        bundle: id,
        outcome: 'failed',
        version: bundledVersion,
        reason: hostFailed ? 'all-writes-failed' : 'central-write-failed',
      });
    }
  }

  return { outcome: 'done', version: bundledVersion, entries };
}

export async function repairSkills(ctx: RepairSkillsContext): Promise<RepairSkillsResult> {
  const logger = ctx.logger ?? defaultLogger;
  const fs = ctx.fs ?? defaultFsOps;
  const home = ctx.home ?? homedir();
  const deps: Required<RepairSkillsDeps> = { ...defaultDeps, ...ctx.deps };

  if (ctx.reclaimDisableEnv === '1') {
    logger({ event: 'skill-repair-skipped', reason: 'reclaim-disabled' });
    return { status: 'skipped', reason: 'reclaim-disabled' };
  }

  const project = runProjectSweep(ctx.projectDir, home, deps, fs, logger);
  const user = await runUserSweep(home, deps, fs, logger);
  const legacyPlan = planLegacyFanoutSweep(home);
  let legacySwept: string[] = [];
  let legacyCleanupDeclined = false;
  let legacyCleanupFailed = false;
  if (legacyPlan.skillDirs.length > 0 || legacyPlan.emptyDirs.length > 0) {
    const approved = ctx.confirmLegacyCleanup ? await ctx.confirmLegacyCleanup(legacyPlan) : false;
    if (approved) {
      try {
        legacySwept = applyLegacyFanoutSweep(home, legacyPlan);
      } catch (err) {
        legacyCleanupFailed = true;
        logger({
          event: 'legacy-fanout-cleanup-refused',
          scope: 'user',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      for (const path of legacySwept) {
        logger({ event: 'legacy-fanout-path-removed', scope: 'user', path });
      }
    } else {
      legacyCleanupDeclined = true;
      logger({ event: 'legacy-fanout-cleanup-declined', scope: 'user' });
    }
  }

  return { status: 'done', project, user, legacySwept, legacyCleanupDeclined, legacyCleanupFailed };
}

function repairSkillsResultExitCode(result: RepairSkillsResult): number {
  if (result.status === 'skipped') {
    return result.reason === 'reclaim-disabled' ? 0 : 1;
  }
  if (result.project.outcome === 'skipped') return 1;
  if (
    result.user.outcome === 'skipped' &&
    result.user.reason !== 'version-current' &&
    result.user.reason !== 'all-bundles-declined'
  ) {
    return 1;
  }
  if (result.project.entries.some((e) => e.outcome === 'failed')) return 1;
  if (result.user.outcome === 'done' && result.user.entries.some((e) => e.outcome === 'failed'))
    return 1;
  return 0;
}

function formatRepairSkillsResult(result: RepairSkillsResult): string {
  if (result.status === 'skipped') {
    return `Skipped: ${result.reason}`;
  }
  const lines: string[] = ['Skill reclaim complete.'];
  if (result.project.outcome === 'done') {
    const present = result.project.entries.filter((e) => e.outcome === 'present').length;
    const created = result.project.entries.filter((e) => e.outcome === 'created').length;
    const noToken = result.project.entries.filter((e) => e.outcome === 'no-token').length;
    const failed = result.project.entries.filter((e) => e.outcome === 'failed').length;
    const globalCollision = result.project.entries.filter(
      (e) => e.outcome === 'skipped-global-collision',
    ).length;
    lines.push(
      `  Project: ${present} present, ${created} created, ${noToken} no-token, ${failed} failed.`,
    );
    if (globalCollision > 0) {
      lines.push(
        `  Skipped ${globalCollision} host(s) whose project config path is their user-global config (not a project directory).`,
      );
    }
  } else {
    lines.push(`  Project: skipped (${result.project.reason}).`);
  }
  if (result.user.outcome === 'done') {
    const written = result.user.entries.filter((e) => e.outcome === 'written').length;
    const present = result.user.entries.filter((e) => e.outcome === 'skipped-present').length;
    const skipped = result.user.entries.filter(
      (e) => e.outcome === 'skipped-host-absent' || e.outcome === 'skipped-collapsed-with-central',
    ).length;
    const failed = result.user.entries.filter((e) => e.outcome === 'failed').length;
    lines.push(
      `  User (${result.user.version}): ${written} written, ${present} present, ${skipped} skipped, ${failed} failed.`,
    );
  } else {
    lines.push(`  User: skipped (${result.user.reason}).`);
  }
  if (result.legacySwept.length > 0) {
    lines.push(`  Cleanup: removed ${result.legacySwept.length} path(s) from a pre-0.42 install.`);
  } else if (result.legacyCleanupFailed) {
    lines.push('  Cleanup: failed — see logs; pre-0.42 directories left in place.');
  } else if (result.legacyCleanupDeclined) {
    lines.push('  Cleanup: declined — pre-0.42 directories left in place.');
  }
  return lines.join('\n');
}

export function repairSkillsCommand(): Command {
  return new Command('repair-skills')
    .description(
      'Refresh bundled SKILL.md files for installed AI editors (project-local + user-global). Runs automatically during `ok start`; this command forces an explicit sweep.',
    )
    .option(
      '-y, --yes',
      'Skip the confirmation prompt for removing directories left by a pre-0.42 install.',
    )
    .action(async (opts: { yes?: boolean }) => {
      const result = await repairSkills({
        projectDir: resolvePath(process.cwd()),
        reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
        confirmLegacyCleanup: (plan) => confirmLegacyCleanup(plan, { yes: opts.yes === true }),
      });
      process.stdout.write(`${formatRepairSkillsResult(result)}\n`);
      process.exitCode = repairSkillsResultExitCode(result);
    });
}

async function confirmLegacyCleanup(
  plan: LegacyFanoutSweepPlan,
  opts: { yes: boolean; input?: NodeJS.ReadableStream & { isTTY?: boolean } },
): Promise<boolean> {
  const home = homedir();
  const show = (p: string) => `~/${relative(home, p)}`;
  const input = opts.input ?? process.stdin;

  const lines: string[] = [
    '',
    accent(
      'A previous version of OpenKnowledge installed its skill into agent tools you may never have used.',
    ),
    dim(
      '(Versions before 0.42 wrote to every host a third-party installer knew about — see issue #820.)',
    ),
  ];
  if (plan.skillDirs.length > 0) {
    lines.push(
      '',
      `${accent('Remove OpenKnowledge skills:')} ${plan.skillDirs.length}`,
      ...plan.skillDirs.map((p) => `  ${show(p)}`),
    );
  }
  if (plan.emptyDirs.length > 0) {
    const heading =
      plan.skillDirs.length > 0
        ? 'Then remove these, which hold nothing else once the above are gone:'
        : 'Remove these empty directories, left behind by that install:';
    lines.push(
      '',
      `${accent(heading)} ${plan.emptyDirs.length}`,
      ...plan.emptyDirs.map((p) => `  ${show(p)}`),
    );
  }
  lines.push(
    '',
    dim('Nothing outside these paths is touched. A directory that still holds anything is kept.'),
  );
  process.stdout.write(`${lines.join('\n')}\n`);

  if (opts.yes) return true;
  if (!input.isTTY) {
    process.stdout.write(
      `${warning('Not a terminal — skipping cleanup. Re-run with `ok repair-skills --yes` to remove these.')}\n`,
    );
    return false;
  }

  const rl = createInterface({ input, output: process.stdout });
  try {
    const answer = (await rl.question(`\n${accent('Remove them?')} ${dim('[y/N] ')}`))
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export const __testing = {
  HOSTS_WITH_USER_SKILL_DIR,
  USER_SKILL_HOSTS,
  USER_SKILL_DIR_NAME,
  PROJECT_SKILL_DIR_NAME,
  CENTRAL_USER_SKILL_REL,
  formatRepairSkillsResult,
  repairSkillsResultExitCode,
  confirmLegacyCleanup,
};
