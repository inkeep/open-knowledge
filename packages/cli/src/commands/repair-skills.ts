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
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  readServerPackageVersion,
  readTargetVersion,
  recordSkillInstallEvent,
  resolveBundledSkillDir,
  type SkillInstallEvent,
  writeTargetVersion,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { assertProjectPathSafe } from '../integrations/write-project-skill.ts';
import { CHAIN_VERSION_SENTINEL, EDITOR_TARGETS, type EditorId } from './editors.ts';

const HOSTS_WITH_USER_SKILL_DIR: ReadonlyArray<{
  readonly hostDir: string;
  readonly editorId: string;
}> = [
  { hostDir: '.claude', editorId: 'claude' },
  { hostDir: '.cursor', editorId: 'cursor' },
  { hostDir: '.agents', editorId: 'codex' },
  // Copilot CLI reads project skills from .github/skills, so that is its project
  // host dir. It has no ~/.github user skill dir, so the user sweep reports
  // skipped-host-absent; its user-level discovery skill is served by the central
  // ~/.agents/skills write (Copilot CLI also reads ~/.agents/skills).
  { hostDir: '.github', editorId: 'copilot' },
];

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
  resolveDiscoveryBundledSkillDir?(): string;
  readBundledVersion?(): Promise<string>;
  readRecordedVersion?(home: string): Promise<string | null>;
  writeRecordedVersion?(home: string, version: string): Promise<void>;
  recordEvent?(event: SkillInstallEvent): Promise<void>;
}

const defaultDeps: Required<RepairSkillsDeps> = {
  resolveProjectBundledSkillDir: () => resolveBundledSkillDir('project', { checkDesktop: false }),
  resolveDiscoveryBundledSkillDir: () =>
    resolveBundledSkillDir('discovery', { checkDesktop: false }),
  readBundledVersion: () => readServerPackageVersion(),
  readRecordedVersion: (home) => readTargetVersion(home, 'cli-hosts'),
  writeRecordedVersion: (home, version) =>
    writeTargetVersion(home, 'cli-hosts', version, 'cli-start'),
  recordEvent: (event) => recordSkillInstallEvent(event),
};

export interface RepairSkillsContext {
  projectDir: string;
  reclaimDisableEnv?: string | null;
  home?: string;
  logger?: (event: RepairSkillsLogEvent) => void;
  deps?: RepairSkillsDeps;
  fs?: RepairSkillsFsOps;
}

export type ProjectSkillOutcome = 'no-token' | 'reclaimed' | 'created' | 'failed';
export type UserSkillCentralOutcome = 'written' | 'overwritten' | 'failed';
export type UserSkillHostOutcome =
  | 'written'
  | 'overwritten'
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

function editorWiredForOk(configPath: string | undefined, fs: RepairSkillsFsOps): boolean {
  if (!configPath) return false;
  try {
    if (!fs.existsSync(configPath)) return false;
    return fs.readFileSync(configPath).toString('utf8').includes(CHAIN_VERSION_SENTINEL);
  } catch {
    return false;
  }
}

function runProjectSweep(
  projectDir: string,
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
    const projectConfigPath =
      EDITOR_TARGETS[host.editorId as EditorId]?.projectConfigPath?.(projectDir);
    const wired = !skillExists && editorWiredForOk(projectConfigPath, fs);
    if (!skillExists && !wired) {
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
      const outcome: ProjectSkillOutcome = skillExists ? 'reclaimed' : 'created';
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        outcome,
      });
      logger({
        event: skillExists ? 'project-skill-reclaim-reclaimed' : 'project-skill-reclaim-created',
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

  if (recordedVersion !== null && recordedVersion === bundledVersion) {
    logger({
      event: 'user-skill-reclaim-skipped-version-current',
      scope: 'user',
      version: bundledVersion,
    });
    return { outcome: 'skipped', reason: 'version-current' };
  }

  let sourceDir: string;
  try {
    sourceDir = deps.resolveDiscoveryBundledSkillDir();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger({ event: 'user-skill-reclaim-bundle-missing', scope: 'user', error });
    recordEventSoft({
      ts: nowIso(),
      surface: 'cli-start',
      target: 'cli-hosts',
      bundle: 'discovery',
      outcome: 'failed',
      reason: `bundle-missing:${error}`,
    });
    return { outcome: 'skipped', reason: 'bundle-missing' };
  }

  const entries: UserSkillEntry[] = [];

  const centralDest = join(home, ...CENTRAL_USER_SKILL_REL);
  const centralExistedBefore = fs.existsSync(centralDest);
  try {
    replaceDir(sourceDir, centralDest, fs);
    entries.push({
      kind: 'central',
      path: centralDest,
      outcome: centralExistedBefore ? 'overwritten' : 'written',
    });
    logger({
      event: 'user-skill-reclaim-central-written',
      scope: 'user',
      path: centralDest,
      preexisting: centralExistedBefore,
      version: bundledVersion,
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

  for (const host of HOSTS_WITH_USER_SKILL_DIR) {
    const hostRoot = join(home, host.hostDir);
    const hostDest = join(hostRoot, 'skills', USER_SKILL_DIR_NAME);
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
    const existedBefore = fs.existsSync(hostDest);
    try {
      replaceDir(sourceDir, hostDest, fs);
      entries.push({
        kind: 'host',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        outcome: existedBefore ? 'overwritten' : 'written',
      });
      logger({
        event: 'user-skill-reclaim-host-written',
        scope: 'user',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        preexisting: existedBefore,
        version: bundledVersion,
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

  const centralEntry = entries.find((e) => e.kind === 'central');
  const anyWriteSucceeded =
    centralEntry?.outcome === 'written' || centralEntry?.outcome === 'overwritten';
  if (anyWriteSucceeded) {
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
    recordEventSoft({
      ts: nowIso(),
      surface: 'cli-start',
      target: 'cli-hosts',
      bundle: 'discovery',
      outcome: stateWriteError === null ? 'installed' : 'failed',
      version: bundledVersion,
      ...(stateWriteError === null ? {} : { reason: `state-write-failed:${stateWriteError}` }),
    });
  } else {
    const anyHostFailed = entries.some((e) => e.kind === 'host' && e.outcome === 'failed');
    recordEventSoft({
      ts: nowIso(),
      surface: 'cli-start',
      target: 'cli-hosts',
      bundle: 'discovery',
      outcome: 'failed',
      version: bundledVersion,
      reason: anyHostFailed ? 'all-writes-failed' : 'no-hosts-installed',
    });
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

  const project = runProjectSweep(ctx.projectDir, deps, fs, logger);
  const user = await runUserSweep(home, deps, fs, logger);

  return { status: 'done', project, user };
}

function repairSkillsResultExitCode(result: RepairSkillsResult): number {
  if (result.status === 'skipped') {
    return result.reason === 'reclaim-disabled' ? 0 : 1;
  }
  if (result.project.outcome === 'skipped') return 1;
  if (result.user.outcome === 'skipped' && result.user.reason !== 'version-current') return 1;
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
    const reclaimed = result.project.entries.filter((e) => e.outcome === 'reclaimed').length;
    const created = result.project.entries.filter((e) => e.outcome === 'created').length;
    const noToken = result.project.entries.filter((e) => e.outcome === 'no-token').length;
    const failed = result.project.entries.filter((e) => e.outcome === 'failed').length;
    lines.push(
      `  Project: ${reclaimed} reclaimed, ${created} created, ${noToken} no-token, ${failed} failed.`,
    );
  } else {
    lines.push(`  Project: skipped (${result.project.reason}).`);
  }
  if (result.user.outcome === 'done') {
    const written = result.user.entries.filter(
      (e) => e.outcome === 'written' || e.outcome === 'overwritten',
    ).length;
    const skipped = result.user.entries.filter(
      (e) => e.outcome === 'skipped-host-absent' || e.outcome === 'skipped-collapsed-with-central',
    ).length;
    const failed = result.user.entries.filter((e) => e.outcome === 'failed').length;
    lines.push(
      `  User (${result.user.version}): ${written} written, ${skipped} skipped, ${failed} failed.`,
    );
  } else {
    lines.push(`  User: skipped (${result.user.reason}).`);
  }
  return lines.join('\n');
}

export function repairSkillsCommand(): Command {
  return new Command('repair-skills')
    .description(
      'Refresh bundled SKILL.md files for installed AI editors (project-local + user-global). Runs automatically during `ok start`; this command forces an explicit sweep.',
    )
    .action(async () => {
      const result = await repairSkills({
        projectDir: resolvePath(process.cwd()),
        reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
      });
      process.stdout.write(`${formatRepairSkillsResult(result)}\n`);
      process.exitCode = repairSkillsResultExitCode(result);
    });
}

export const __testing = {
  HOSTS_WITH_USER_SKILL_DIR,
  USER_SKILL_DIR_NAME,
  PROJECT_SKILL_DIR_NAME,
  CENTRAL_USER_SKILL_REL,
  formatRepairSkillsResult,
  repairSkillsResultExitCode,
};
