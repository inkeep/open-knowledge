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
import { HOSTS_WITH_USER_SKILL_DIR } from '@inkeep/open-knowledge';
import { resolveBundleEnabled, USER_SKILL_HOSTS } from '@inkeep/open-knowledge-core';
import { classifyInstallShape } from './install-shape.ts';

interface SkillReclaimLogger {
  event(payload: { event: string; [key: string]: unknown }): void;
  warn(message: string, ctx?: object): void;
}

const DEFAULT_LOGGER: SkillReclaimLogger = {
  event: (payload) => console.warn(JSON.stringify(payload)),
  warn: (message, ctx) => console.warn('[skill-reclaim]', message, ctx ?? ''),
};

const LEGACY_SKILL_DIR_NAME = 'open-knowledge';

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
  const legacyHostDirs = [
    ...HOSTS_WITH_USER_SKILL_DIR.map((h) => h.hostDir),
    '.agents',
    '.pi/agent',
    '.copilot',
    '.gemini',
  ];
  for (const hostDir of legacyHostDirs) {
    const legacyDir = join(home, hostDir, 'skills', LEGACY_SKILL_DIR_NAME);
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
  | {
      kind: 'central';
      path: string;
      status: 'written' | 'skipped-present' | 'failed';
      error?: string;
    }
  | {
      kind: 'host';
      hostDir: string;
      editorId: string;
      path: string;
      status: 'written' | 'skipped-present' | 'skipped-host-absent' | 'failed';
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
  env?: Record<string, string | undefined>;
  forceEnv?: string | null | undefined;
  reclaimDisableEnv?: string | null | undefined;
  seed?: boolean;
  deps: {
    userGlobalBundles: ReadonlyArray<{ id: string; name: string }>;
    resolveBundledSkillDir(bundle: string): string;
    readServerPackageVersion(): Promise<string>;
    readBundleDecision(home: string, bundleName: string): Promise<boolean | null>;
    writeBundleDecision(home: string, bundleName: string, enabled: boolean): Promise<void>;
    removeBundleFromDisk(bundleId: string): void;
    reportInstalled?(skillNames: readonly string[], scope?: string): void;
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
      bundle?: string;
      outcome: 'installed' | 'failed';
      version?: string;
      reason?: string;
    }): Promise<void>;
  };
  fs?: SkillFsOps;
  now?: () => Date;
  logger?: SkillReclaimLogger;
}

function bundleInstalledAnywhere(home: string, bundleDirName: string, fs: SkillFsOps): boolean {
  if (fs.existsSync(join(home, '.agents', 'skills', bundleDirName))) return true;
  return USER_SKILL_HOSTS.some((host) => fs.existsSync(join(home, host.skillsRoot, bundleDirName)));
}

function installUserBundleToHostDirs(
  home: string,
  bundleDirName: string,
  sourceDir: string,
  fs: SkillFsOps,
  logger: SkillReclaimLogger,
  version: string,
): { entries: UserSkillReclaimEntry[]; anyWritten: boolean; anyDestinationSucceeded: boolean } {
  const entries: UserSkillReclaimEntry[] = [];
  const centralDest = join(home, '.agents', 'skills', bundleDirName);
  if (bundleInstalledAnywhere(home, bundleDirName, fs)) {
    if (fs.existsSync(centralDest)) {
      entries.push({ kind: 'central', path: centralDest, status: 'skipped-present' });
    }
    for (const host of USER_SKILL_HOSTS) {
      const hostDest = join(home, host.skillsRoot, bundleDirName);
      if (hostDest === centralDest) continue;
      if (!fs.existsSync(join(home, host.hostDir))) {
        entries.push({
          kind: 'host',
          hostDir: host.hostDir,
          editorId: host.editorId,
          path: hostDest,
          status: 'skipped-host-absent',
        });
        continue;
      }
      if (fs.existsSync(hostDest)) {
        entries.push({
          kind: 'host',
          hostDir: host.hostDir,
          editorId: host.editorId,
          path: hostDest,
          status: 'skipped-present',
        });
      }
    }
    return { entries, anyWritten: false, anyDestinationSucceeded: true };
  }
  const centralRootExists = fs.existsSync(join(home, '.agents'));
  if (centralRootExists && fs.existsSync(centralDest)) {
    entries.push({ kind: 'central', path: centralDest, status: 'skipped-present' });
  } else if (centralRootExists) {
    try {
      replaceDir(sourceDir, centralDest, fs);
      entries.push({ kind: 'central', path: centralDest, status: 'written' });
      logger.event({
        event: 'user-skill-reclaim-central-written',
        path: centralDest,
        preexisting: false,
        version,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      entries.push({ kind: 'central', path: centralDest, status: 'failed', error });
      logger.event({ event: 'user-skill-reclaim-central-failed', path: centralDest, error });
    }
  }

  for (const host of USER_SKILL_HOSTS) {
    const hostRoot = join(home, host.hostDir);
    const hostDest = join(home, host.skillsRoot, bundleDirName);
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
    if (fs.existsSync(hostDest)) {
      entries.push({
        kind: 'host',
        hostDir: host.hostDir,
        editorId: host.editorId,
        path: hostDest,
        status: 'skipped-present',
      });
      continue;
    }
    try {
      replaceDir(sourceDir, hostDest, fs);
      entries.push({
        kind: 'host',
        hostDir: host.hostDir,
        editorId: host.editorId,
        path: hostDest,
        status: 'written',
      });
      logger.event({
        event: 'user-skill-reclaim-host-written',
        editorId: host.editorId,
        path: hostDest,
        preexisting: false,
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
  return {
    entries,
    anyWritten: entries.some((entry) => entry.status === 'written'),
    anyDestinationSucceeded: entries.some(
      (entry) => entry.status === 'written' || entry.status === 'skipped-present',
    ),
  };
}

function userBundleExists(home: string, bundleName: string, fs: SkillFsOps): boolean {
  return (
    fs.existsSync(join(home, '.agents', 'skills', bundleName)) ||
    USER_SKILL_HOSTS.some((host) => fs.existsSync(join(home, host.skillsRoot, bundleName)))
  );
}

export async function reconcileUserGlobalSkillBundles(
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
  if (!isPackaged && forceEnv !== '1') return { status: 'skipped', reason: 'dev-mode' };
  const installShape = classifyInstallShape(platform, executablePath, opts.env ?? process.env);
  if (installShape.kind === 'appimage') {
    return { status: 'skipped', reason: 'appimage-ephemeral' };
  }
  if (installShape.kind === 'unsupported') {
    return { status: 'skipped', reason: 'bad-executable-path' };
  }

  const resolvedBundles: Array<{ id: string; name: string; sourceDir: string }> = [];
  let lastResolveError: string | null = null;
  for (const bundle of deps.userGlobalBundles) {
    try {
      resolvedBundles.push({ ...bundle, sourceDir: deps.resolveBundledSkillDir(bundle.id) });
    } catch (err) {
      lastResolveError = err instanceof Error ? err.message : String(err);
    }
  }
  if (resolvedBundles.length === 0) {
    logger.event({
      event: 'user-skill-reclaim-bundle-missing',
      error: lastResolveError ?? 'no user-global bundles',
    });
    await deps
      .recordSkillInstallEvent({
        ts: nowDate().toISOString(),
        surface: 'desktop-direct',
        target: 'cli-hosts',
        outcome: 'failed',
        reason: `bundle-missing:${lastResolveError}`,
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

  const gatedBundles: typeof resolvedBundles = [];
  for (const bundle of resolvedBundles) {
    const onDisk = userBundleExists(home, bundle.name, fs);
    const decision = await deps.readBundleDecision(home, bundle.name).catch(() => null);
    if (!resolveBundleEnabled(decision, { installedOnDisk: onDisk })) {
      if (onDisk) {
        try {
          deps.removeBundleFromDisk(bundle.id);
          logger.event({ event: 'user-skill-reclaim-bundle-declined-removed', bundle: bundle.id });
        } catch (err) {
          logger.event({
            event: 'user-skill-reclaim-bundle-remove-failed',
            bundle: bundle.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      continue;
    }
    if (decision === null && onDisk) {
      try {
        await deps.writeBundleDecision(home, bundle.name, true);
      } catch (err) {
        logger.event({
          event: 'user-skill-reclaim-grandfather-write-failed',
          bundle: bundle.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    gatedBundles.push(bundle);
  }

  if (gatedBundles.length === 0) {
    return { status: 'skipped', reason: 'all-bundles-declined' };
  }

  if (opts.seed === false) {
    return { status: 'skipped', reason: 'reconcile-only' };
  }

  const entries: UserSkillReclaimEntry[] = [];
  const installedBundleNames: string[] = [];
  const bundleResults: Array<{ id: string; landed: boolean; failed: boolean }> = [];
  for (const bundle of gatedBundles) {
    const result = installUserBundleToHostDirs(
      home,
      bundle.name,
      bundle.sourceDir,
      fs,
      logger,
      version,
    );
    if (result.anyWritten) installedBundleNames.push(bundle.name);
    entries.push(...result.entries);
    bundleResults.push({
      id: bundle.id,
      landed: result.anyDestinationSucceeded,
      failed: result.entries.some((e) => e.status === 'failed'),
    });
  }
  if (installedBundleNames.length > 0) deps.reportInstalled?.(installedBundleNames);

  const anyWriteSucceeded = installedBundleNames.length > 0;
  const allBundlesLanded = bundleResults.every((b) => b.landed);
  if (anyWriteSucceeded && allBundlesLanded) {
    let stateWriteError: string | null = null;
    try {
      await deps.writeTargetVersion(home, 'cli-hosts', version, 'desktop-direct');
    } catch (err) {
      stateWriteError = err instanceof Error ? err.message : String(err);
      logger.warn('writeTargetVersion failed', { error: stateWriteError });
    }
    for (const bundle of gatedBundles) {
      await deps
        .recordSkillInstallEvent({
          ts: nowDate().toISOString(),
          surface: 'desktop-direct',
          target: 'cli-hosts',
          bundle: bundle.id,
          outcome: stateWriteError === null ? 'installed' : 'failed',
          version,
          ...(stateWriteError === null ? {} : { reason: `state-write-failed:${stateWriteError}` }),
        })
        .catch(() => {});
    }
  } else {
    for (const { id, failed } of bundleResults) {
      if (!failed) continue;
      await deps
        .recordSkillInstallEvent({
          ts: nowDate().toISOString(),
          surface: 'desktop-direct',
          target: 'cli-hosts',
          bundle: id,
          outcome: 'failed',
          version,
          reason: 'all-targets-failed',
        })
        .catch(() => {});
    }
  }

  return { status: 'done', version, entries };
}
