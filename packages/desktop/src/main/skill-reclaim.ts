import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  rmSync as fsRmSync,
  statSync as fsStatSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { assertProjectPathSafe, EDITOR_TARGETS, type EditorId } from '@inkeep/open-knowledge';

interface SkillReclaimLogger {
  event(payload: { event: string; [key: string]: unknown }): void;
  warn(message: string, ctx?: object): void;
}

const DEFAULT_LOGGER: SkillReclaimLogger = {
  event: (payload) => console.warn(JSON.stringify(payload)),
  warn: (message, ctx) => console.warn('[skill-reclaim]', message, ctx ?? ''),
};

const HOSTS_WITH_USER_SKILL_DIR: ReadonlyArray<{
  readonly hostDir: string;
  readonly editorId: EditorId;
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

const OK_MCP_MARKER = '# ok-mcp-v1';

const USER_SKILL_DIR_NAME = 'open-knowledge-discovery';
const PROJECT_SKILL_DIR_NAME = 'open-knowledge';
const LEGACY_SKILL_DIR_NAME = 'open-knowledge';
const CENTRAL_USER_SKILL_REL = ['.agents', 'skills', USER_SKILL_DIR_NAME] as const;

interface SkillFsOps {
  existsSync(path: string): boolean;
  isDirectory(path: string): boolean;
  readdirSync(path: string): string[];
  readFileSync(path: string): Buffer;
  writeFileSync(path: string, content: Buffer): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

const defaultFsOps: SkillFsOps = {
  existsSync: (path) => fsExistsSync(path),
  isDirectory: (path) => {
    try {
      return fsStatSync(path).isDirectory();
    } catch {
      return false;
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

function replaceDir(sourceDir: string, destDir: string, fs: SkillFsOps): void {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(dirname(destDir), { recursive: true });
  copyDirContents(sourceDir, destDir, fs);
}

function copyDirContents(sourceDir: string, destDir: string, fs: SkillFsOps): void {
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

function removeLegacyUserSkillDirs(home: string, fs: SkillFsOps, logger: SkillReclaimLogger): void {
  for (const host of HOSTS_WITH_USER_SKILL_DIR) {
    const legacyDir = join(home, host.hostDir, 'skills', LEGACY_SKILL_DIR_NAME);
    if (!fs.existsSync(legacyDir)) continue;
    try {
      fs.rmSync(legacyDir, { recursive: true, force: true });
      logger.event({ event: 'user-skill-reclaim-legacy-removed', path: legacyDir });
    } catch (err) {
      logger.event({
        event: 'user-skill-reclaim-legacy-remove-failed',
        path: legacyDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

type UserSkillReclaimEntry =
  | { kind: 'central'; path: string; status: 'written' | 'overwritten' | 'failed'; error?: string }
  | {
      kind: 'host';
      hostDir: string;
      editorId: string;
      path: string;
      status: 'written' | 'overwritten' | 'skipped-host-absent' | 'failed';
      error?: string;
    };

type UserSkillReclaimResult =
  | { status: 'skipped'; reason: string }
  | { status: 'done'; version: string; entries: UserSkillReclaimEntry[] };

interface ReclaimUserSkillsOpts {
  home: string;
  isPackaged: boolean;
  platform: 'darwin' | 'win32' | 'linux' | string;
  executablePath: string;
  forceEnv?: string | null | undefined;
  reclaimDisableEnv?: string | null | undefined;
  deps: {
    resolveBundledSkillDir(): string;
    readServerPackageVersion(): Promise<string>;
    writeTargetVersion(
      home: string,
      target: 'cli-hosts',
      version: string,
      surface: 'desktop-direct',
    ): Promise<void>;
    recordSkillInstallEvent(event: {
      ts: string;
      surface: 'desktop-direct';
      target: 'cli-hosts';
      bundle?: 'discovery';
      outcome: 'installed' | 'failed';
      version?: string;
      reason?: string;
    }): Promise<void>;
  };
  fs?: SkillFsOps;
  now?: () => Date;
  logger?: SkillReclaimLogger;
}

export async function reclaimUserSkillsOnLaunch(
  opts: ReclaimUserSkillsOpts,
): Promise<UserSkillReclaimResult> {
  const {
    home,
    isPackaged,
    platform,
    executablePath,
    forceEnv,
    reclaimDisableEnv,
    deps,
    fs = defaultFsOps,
    now,
    logger = DEFAULT_LOGGER,
  } = opts;
  const nowDate = (): Date => (now ? now() : new Date());

  if (reclaimDisableEnv === '1') return { status: 'skipped', reason: 'reclaim-disabled' };
  if (platform !== 'darwin') return { status: 'skipped', reason: 'platform' };
  if (!isPackaged && forceEnv !== '1') return { status: 'skipped', reason: 'dev-mode' };
  if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath)) {
    return { status: 'skipped', reason: 'bad-executable-path' };
  }

  let sourceDir: string;
  try {
    sourceDir = deps.resolveBundledSkillDir();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.event({ event: 'user-skill-reclaim-bundle-missing', error });
    await deps
      .recordSkillInstallEvent({
        ts: nowDate().toISOString(),
        surface: 'desktop-direct',
        target: 'cli-hosts',
        bundle: 'discovery',
        outcome: 'failed',
        reason: `bundle-missing:${error}`,
      })
      .catch(() => {});
    return { status: 'skipped', reason: 'bundle-missing' };
  }

  let version: string;
  try {
    version = await deps.readServerPackageVersion();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.event({ event: 'user-skill-reclaim-version-read-failed', error });
    await deps
      .recordSkillInstallEvent({
        ts: nowDate().toISOString(),
        surface: 'desktop-direct',
        target: 'cli-hosts',
        bundle: 'discovery',
        outcome: 'failed',
        reason: `version-read-failed:${error}`,
      })
      .catch(() => {});
    return { status: 'skipped', reason: 'version-read-failed' };
  }

  removeLegacyUserSkillDirs(home, fs, logger);

  const entries: UserSkillReclaimEntry[] = [];

  const centralDest = join(home, ...CENTRAL_USER_SKILL_REL);
  const centralExistedBefore = fs.existsSync(centralDest);
  try {
    replaceDir(sourceDir, centralDest, fs);
    entries.push({
      kind: 'central',
      path: centralDest,
      status: centralExistedBefore ? 'overwritten' : 'written',
    });
    logger.event({
      event: 'user-skill-reclaim-central-written',
      path: centralDest,
      preexisting: centralExistedBefore,
      version,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    entries.push({ kind: 'central', path: centralDest, status: 'failed', error });
    logger.event({ event: 'user-skill-reclaim-central-failed', path: centralDest, error });
  }

  for (const host of HOSTS_WITH_USER_SKILL_DIR) {
    const hostRoot = join(home, host.hostDir);
    const hostDest = join(hostRoot, 'skills', USER_SKILL_DIR_NAME);
    if (hostDest === centralDest) {
      continue;
    }
    if (!fs.existsSync(hostRoot)) {
      entries.push({
        kind: 'host',
        hostDir: host.hostDir,
        editorId: host.editorId,
        path: hostDest,
        status: 'skipped-host-absent',
      });
      continue;
    }
    const existedBefore = fs.existsSync(hostDest);
    try {
      replaceDir(sourceDir, hostDest, fs);
      entries.push({
        kind: 'host',
        hostDir: host.hostDir,
        editorId: host.editorId,
        path: hostDest,
        status: existedBefore ? 'overwritten' : 'written',
      });
      logger.event({
        event: 'user-skill-reclaim-host-written',
        editorId: host.editorId,
        path: hostDest,
        preexisting: existedBefore,
        version,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      entries.push({
        kind: 'host',
        hostDir: host.hostDir,
        editorId: host.editorId,
        path: hostDest,
        status: 'failed',
        error,
      });
      logger.event({
        event: 'user-skill-reclaim-host-failed',
        editorId: host.editorId,
        path: hostDest,
        error,
      });
    }
  }

  const anyWriteSucceeded = entries.some(
    (e) => e.status === 'written' || e.status === 'overwritten',
  );
  if (anyWriteSucceeded) {
    let stateWriteError: string | null = null;
    try {
      await deps.writeTargetVersion(home, 'cli-hosts', version, 'desktop-direct');
    } catch (err) {
      stateWriteError = err instanceof Error ? err.message : String(err);
      logger.warn('writeTargetVersion failed', { error: stateWriteError });
    }
    await deps
      .recordSkillInstallEvent({
        ts: nowDate().toISOString(),
        surface: 'desktop-direct',
        target: 'cli-hosts',
        bundle: 'discovery',
        outcome: stateWriteError === null ? 'installed' : 'failed',
        version,
        ...(stateWriteError === null ? {} : { reason: `state-write-failed:${stateWriteError}` }),
      })
      .catch(() => {});
  } else {
    await deps
      .recordSkillInstallEvent({
        ts: nowDate().toISOString(),
        surface: 'desktop-direct',
        target: 'cli-hosts',
        bundle: 'discovery',
        outcome: 'failed',
        version,
        reason: 'all-targets-failed',
      })
      .catch(() => {});
  }

  return { status: 'done', version, entries };
}

type ProjectSkillReclaimEntry = {
  editorId: string;
  hostDir: string;
  path: string;
  status: 'no-token' | 'reclaimed' | 'created' | 'failed';
  error?: string;
};

type ProjectSkillReclaimResult =
  | { status: 'skipped'; reason: string }
  | { status: 'done'; entries: ProjectSkillReclaimEntry[] };

interface ReclaimProjectSkillsOpts {
  projectDir: string;
  executablePath: string;
  isPackaged: boolean;
  platform: 'darwin' | 'win32' | 'linux' | string;
  forceEnv?: string | null | undefined;
  reclaimDisableEnv?: string | null | undefined;
  createIfWired?: boolean;
  deps: {
    resolveBundledSkillDir(): string;
  };
  fs?: SkillFsOps;
  logger?: SkillReclaimLogger;
}

function editorWiredForOk(configPath: string | undefined, fs: SkillFsOps): boolean {
  if (!configPath) return false;
  try {
    if (!fs.existsSync(configPath)) return false;
    return fs.readFileSync(configPath).toString('utf8').includes(OK_MCP_MARKER);
  } catch {
    return false;
  }
}

export async function reclaimProjectSkillsOnProjectOpen(
  opts: ReclaimProjectSkillsOpts,
): Promise<ProjectSkillReclaimResult> {
  const {
    projectDir,
    executablePath,
    isPackaged,
    platform,
    forceEnv,
    reclaimDisableEnv,
    createIfWired = false,
    deps,
    fs = defaultFsOps,
    logger = DEFAULT_LOGGER,
  } = opts;

  if (reclaimDisableEnv === '1') return { status: 'skipped', reason: 'reclaim-disabled' };
  if (platform !== 'darwin') return { status: 'skipped', reason: 'platform' };
  if (!isPackaged && forceEnv !== '1') return { status: 'skipped', reason: 'dev-mode' };
  if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath)) {
    return { status: 'skipped', reason: 'bad-executable-path' };
  }

  let sourceDir: string;
  try {
    sourceDir = deps.resolveBundledSkillDir();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.event({ event: 'project-skill-reclaim-bundle-missing', error });
    return { status: 'skipped', reason: 'bundle-missing' };
  }

  const entries: ProjectSkillReclaimEntry[] = [];
  for (const host of HOSTS_WITH_USER_SKILL_DIR) {
    const dest = join(projectDir, host.hostDir, 'skills', PROJECT_SKILL_DIR_NAME);
    const skillFile = join(dest, 'SKILL.md');
    const skillExists = fs.existsSync(skillFile);
    const projectConfigPath = EDITOR_TARGETS[host.editorId]?.projectConfigPath?.(projectDir);
    const wired = !skillExists && createIfWired && editorWiredForOk(projectConfigPath, fs);
    if (!skillExists && !wired) {
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        status: 'no-token',
      });
      logger.event({
        event: 'project-skill-reclaim-no-token',
        editorId: host.editorId,
        path: dest,
      });
      continue;
    }
    try {
      assertProjectPathSafe(dest, projectDir);
      replaceDir(sourceDir, dest, fs);
      const status = skillExists ? 'reclaimed' : 'created';
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        status,
      });
      logger.event({
        event: skillExists ? 'project-skill-reclaim-reclaimed' : 'project-skill-reclaim-created',
        editorId: host.editorId,
        path: dest,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        status: 'failed',
        error,
      });
      logger.event({
        event: 'project-skill-reclaim-failed',
        editorId: host.editorId,
        path: dest,
        error,
      });
    }
  }

  return { status: 'done', entries };
}
