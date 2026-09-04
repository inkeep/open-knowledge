import { spawn as nodeSpawn } from 'node:child_process';
import {
  existsSync as fsExistsSync,
  lstatSync as fsLstatSync,
  mkdirSync as fsMkdirSync,
  readFileSync as fsReadFileSync,
  readlinkSync as fsReadlinkSync,
  renameSync as fsRenameSync,
  symlinkSync as fsSymlinkSync,
  unlinkSync as fsUnlinkSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  PATH_SHIM_BEGIN as BEGIN,
  PATH_SHIM_BLOCK_RE as BLOCK_RE,
  PATH_SHIM_END as END,
  type PathDiscovery,
  type PathInstallConsent,
  type PathInstallMarker,
  pathInstallMarkerPath,
} from '@inkeep/open-knowledge';
import type { McpWiringPathInstallDescriptor } from '../shared/ipc-channels.ts';
import { classifyInstallShape } from './install-shape.ts';

export { pathInstallMarkerPath };

const NAMES = ['ok', 'open-knowledge'] as const;

interface PathInstallFsOps {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, content: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  unlinkSync(path: string): void;
  symlinkSync(target: string, path: string): void;
  renameSync(oldPath: string, newPath: string): void;
  readlinkSync(path: string): string;
  lstatSync(path: string): { isSymbolicLink(): boolean };
}

const defaultFsOps: PathInstallFsOps = {
  existsSync: (path) => fsExistsSync(path),
  readFileSync: (path, encoding) => fsReadFileSync(path, encoding),
  writeFileSync: (path, content) => fsWriteFileSync(path, content),
  mkdirSync: (path, options) => fsMkdirSync(path, options),
  unlinkSync: (path) => fsUnlinkSync(path),
  symlinkSync: (target, path) => fsSymlinkSync(target, path),
  renameSync: (oldPath, newPath) => fsRenameSync(oldPath, newPath),
  readlinkSync: (path) => fsReadlinkSync(path),
  lstatSync: (path) => fsLstatSync(path),
};

interface PathInstallLogger {
  event(payload: { event: string; [key: string]: unknown }): void;
}

const DEFAULT_LOGGER: PathInstallLogger = {
  event: (payload) => console.warn(JSON.stringify(payload)),
};

export type EnsureCliOnPathResult =
  | { status: 'skipped'; reason: string }
  | { status: 'healthy-current'; marker: PathInstallMarker }
  | { status: 'installed'; marker: PathInstallMarker; summary: string }
  | { status: 'installed-silent'; marker: PathInstallMarker }
  | { status: 'failed-all'; error: string };

export type StartupToastPathLeg =
  | { status: 'none' }
  | { status: 'installed'; summary: string }
  | { status: 'failed'; summary: string };

export function computePathLeg(result: EnsureCliOnPathResult): StartupToastPathLeg {
  switch (result.status) {
    case 'installed':
      return { status: 'installed', summary: result.summary };
    case 'failed-all':
      return { status: 'failed', summary: result.error };
    case 'installed-silent':
    case 'healthy-current':
    case 'skipped':
      return { status: 'none' };
    default: {
      const _exhaustive: never = result;
      throw new Error(
        `unhandled ensureCliOnPath status: ${(_exhaustive as { status: string }).status}`,
      );
    }
  }
}

interface EnsureCliOnPathOpts {
  executablePath: string;
  isPackaged: boolean;
  platform: 'darwin' | 'win32' | 'linux' | string;
  forceEnv?: string | null | undefined;
  reclaimDisableEnv?: string | null | undefined;
  env?: Record<string, string | undefined>;
  home: string;
  bundleVersion: string;
  fs?: PathInstallFsOps;
  spawn?: (
    command: string,
    args: string[],
    opts: { timeoutMs: number; env: Record<string, string | undefined> },
  ) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }>;
  logger?: PathInstallLogger;
  now?: () => Date;
  consentDecision?: PathInstallConsent;
}

function readMarker(
  home: string,
  fs: PathInstallFsOps,
  logger: PathInstallLogger,
): PathInstallMarker | null {
  const path = pathInstallMarkerPath(home);
  if (!fs.existsSync(path)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8')) as PathInstallMarker;
    if (parsed?.version !== 1) {
      logger.event({ event: 'path-install-marker-version-unknown', foundVersion: parsed?.version });
      return null;
    }
    if (
      parsed.consent !== undefined &&
      parsed.consent?.status !== 'granted' &&
      parsed.consent?.status !== 'declined'
    ) {
      logger.event({ event: 'path-install-marker-consent-invalid' });
      return { ...parsed, consent: undefined };
    }
    return parsed;
  } catch (err) {
    logger.event({
      event: 'path-install-marker-read-failed',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function writeMarker(home: string, marker: PathInstallMarker, fs: PathInstallFsOps): void {
  const path = pathInstallMarkerPath(home);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`);
}

function okBin(home: string): string {
  return join(home, '.ok', 'bin');
}

function envShim(home: string): string {
  return join(home, '.ok', 'env.sh');
}

const MANAGED_HINT =
  '# ! Contents within this block are managed by OpenKnowledge. Do not edit.\n# ! Delete this whole block to opt out — OpenKnowledge will not re-add it.';

function block(): string {
  return `${BEGIN}\n${MANAGED_HINT}\n[ -f "$HOME/.ok/env.sh" ] && . "$HOME/.ok/env.sh"\n${END}\n`;
}

function fishBlock(): string {
  return `${BEGIN}\n${MANAGED_HINT}\nif test -d "$HOME/.ok/bin"\n  if not contains "$HOME/.ok/bin" $PATH\n    set -gx PATH "$HOME/.ok/bin" $PATH\n  end\nend\n${END}\n`;
}

function rcTargets(
  home: string,
  shell: string | undefined,
  fs: PathInstallFsOps,
  platform: string = process.platform,
): Array<{ path: string; create: boolean; content: string }> {
  const fishConfigDir = join(home, '.config', 'fish');
  const fishDetected =
    (shell?.endsWith('/fish') ?? false) ||
    fs.existsSync(join(fishConfigDir, 'config.fish')) ||
    fs.existsSync(join(fishConfigDir, 'fish_variables'));
  const base = [
    { path: join(home, '.zshrc'), create: shell?.endsWith('/zsh') ?? false, content: block() },
    {
      path: join(home, '.bash_profile'),
      create: platform === 'darwin' && (shell?.endsWith('/bash') ?? false),
      content: block(),
    },
    ...(platform === 'linux'
      ? [
          {
            path: join(home, '.bashrc'),
            create: shell?.endsWith('/bash') ?? false,
            content: block(),
          },
        ]
      : []),
    ...(fishDetected
      ? [
          {
            path: join(fishConfigDir, 'conf.d', 'open-knowledge.fish'),
            create: true,
            content: fishBlock(),
          },
        ]
      : []),
  ];
  return base.filter((t) => t.create || fs.existsSync(t.path));
}

function upsertBlock(path: string, content: string, fs: PathInstallFsOps): boolean {
  const prior = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
  if (prior.includes(BEGIN) && prior.includes(END)) {
    const next = prior.replace(BLOCK_RE, content);
    if (next !== prior) fs.writeFileSync(path, next.endsWith('\n') ? next : `${next}\n`);
    return next !== prior;
  }
  fs.mkdirSync(dirname(path), { recursive: true });
  const sep =
    prior === '' ? '' : prior.endsWith('\n\n') ? '' : prior.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(path, `${prior}${sep}${content}\n`);
  return true;
}

function rcBlockHealthy(path: string, fs: PathInstallFsOps): boolean {
  if (!fs.existsSync(path)) return false;
  const text = fs.readFileSync(path, 'utf8');
  return text.includes(BEGIN) && text.includes(END);
}

function tildify(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function linkPointsTo(
  path: string,
  target: string,
  fs: PathInstallFsOps,
  logger?: PathInstallLogger,
): boolean {
  try {
    return fs.readlinkSync(path) === target;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'EINVAL') {
      logger?.event({
        event: 'path-install-readlink-unexpected-error',
        path,
        code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }
}

function canonicalHealthy(
  home: string,
  wrapper: string,
  fs: PathInstallFsOps,
  logger?: PathInstallLogger,
): boolean {
  return NAMES.every((name) => linkPointsTo(join(okBin(home), name), wrapper, fs, logger));
}

function replaceSymlinkAtomic(link: string, wrapper: string, fs: PathInstallFsOps): void {
  const tmp = `${link}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.unlinkSync(tmp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.symlinkSync(wrapper, tmp);
  try {
    fs.renameSync(tmp, link);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function installCanonical(home: string, wrapper: string, fs: PathInstallFsOps): void {
  const bin = okBin(home);
  fs.mkdirSync(bin, { recursive: true });
  for (const name of NAMES) {
    replaceSymlinkAtomic(join(bin, name), wrapper, fs);
  }
}

export async function defaultSpawn(
  command: string,
  args: string[],
  opts: { timeoutMs: number; env: Record<string, string | undefined> },
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }>(
    (resolve) => {
      const child = nodeSpawn(command, args, {
        env: opts.env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.unref();
      let stdout = '';
      let stderr = '';
      let hardKill: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        child.stdout.removeAllListeners('data');
        child.stderr.removeAllListeners('data');
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill();
        hardKill = setTimeout(() => child.kill('SIGKILL'), 1000);
        hardKill.unref();
        resolve({ code: null, stdout, stderr, timedOut: true });
      }, opts.timeoutMs);
      timer.unref();
      child.stdout.on('data', (d) => {
        stdout += String(d);
      });
      child.stderr.on('data', (d) => {
        stderr += String(d);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: 1, stdout, stderr: err.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (hardKill) clearTimeout(hardKill);
        resolve({ code, stdout, stderr });
      });
    },
  );
}

async function discoverRealInteractivePath(
  opts: EnsureCliOnPathOpts,
): Promise<PathDiscovery | null> {
  const env = opts.env ?? process.env;
  const shell = env.SHELL ?? (opts.platform === 'linux' ? '/bin/bash' : '/bin/zsh');
  const spawn = opts.spawn ?? defaultSpawn;
  const logger = opts.logger ?? DEFAULT_LOGGER;
  try {
    // biome-ignore lint/plugin/require-windowshide-on-spawn: injected command-runner seam; defaultSpawn owns child_process options
    const result = await spawn(shell, ['-ilc', 'printf %s "$PATH"'], { timeoutMs: 2000, env });
    if (result.code !== 0 || result.timedOut || !result.stdout) {
      logger.event({
        event: 'path-discovery-failed',
        shell,
        code: result.code,
        timedOut: result.timedOut ?? false,
      });
      return null;
    }
    const pathEntries = result.stdout.split(':').filter(Boolean);
    const binDir = okBin(opts.home);
    return {
      capturedAt: (opts.now?.() ?? new Date()).toISOString(),
      pathEntries,
      shellUsed: shell,
      okBinAlreadyOnPath: pathEntries.includes(binDir),
    };
  } catch (err) {
    logger.event({
      event: 'path-discovery-failed',
      shell,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function removeRecordedExtraSymlinks(
  recorded: PathInstallMarker['extraSymlinks'],
  fs: PathInstallFsOps,
  logger: PathInstallLogger,
): { remaining: PathInstallMarker['extraSymlinks']; removedCount: number } {
  const remaining: PathInstallMarker['extraSymlinks'] = [];
  let removedCount = 0;
  for (const entry of recorded) {
    try {
      const stat = fs.lstatSync(entry.path);
      if (!stat.isSymbolicLink() || fs.readlinkSync(entry.path) !== entry.target) continue;
      fs.unlinkSync(entry.path);
      removedCount += 1;
      logger.event({ event: 'path-install-extra-symlink-removed', path: entry.path });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      remaining.push(entry);
      logger.event({
        event: 'path-install-extra-symlink-remove-failed',
        path: entry.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { remaining, removedCount };
}

function markerHealthy(
  marker: PathInstallMarker,
  home: string,
  wrapper: string,
  fs: PathInstallFsOps,
  logger?: PathInstallLogger,
): boolean {
  if (marker.bundleWrapperPath !== wrapper) return false;
  if (!canonicalHealthy(home, wrapper, fs, logger)) return false;
  if (!marker.rcFiles.every((file) => rcBlockHealthy(file, fs))) return false;
  if (marker.extraSymlinks.length > 0) return false;
  return true;
}

export async function ensureCliOnPath(opts: EnsureCliOnPathOpts): Promise<EnsureCliOnPathResult> {
  const {
    executablePath,
    isPackaged,
    platform,
    forceEnv,
    reclaimDisableEnv,
    home,
    bundleVersion,
    fs = defaultFsOps,
    logger = DEFAULT_LOGGER,
  } = opts;
  if (reclaimDisableEnv === '1') return { status: 'skipped', reason: 'reclaim-disabled' };
  if (platform === 'win32') return { status: 'skipped', reason: 'installer-managed' };
  if (platform !== 'darwin' && platform !== 'linux')
    return { status: 'skipped', reason: 'platform' };
  if (!isPackaged && forceEnv !== '1') return { status: 'skipped', reason: 'dev-mode' };
  const shape = classifyInstallShape(platform, executablePath, opts.env ?? process.env);
  if (shape.kind === 'appimage') return { status: 'skipped', reason: 'appimage-ephemeral' };
  if (shape.kind === 'unsupported') return { status: 'skipped', reason: 'bad-executable-path' };

  const wrapper = shape.wrapperPath;
  const prior = readMarker(home, fs, logger);
  const explicitDecision = opts.consentDecision !== undefined;
  if (prior && !explicitDecision && markerHealthy(prior, home, wrapper, fs, logger)) {
    if (!prior.consent && prior.rcFiles.length > 0) {
      const marker: PathInstallMarker = {
        ...prior,
        consent: { status: 'granted', at: (opts.now?.() ?? new Date()).toISOString() },
      };
      try {
        writeMarker(home, marker, fs);
      } catch (err) {
        logger.event({
          event: 'path-install-consent-stamp-failed',
          error: err instanceof Error ? err.message : String(err),
        });
        return { status: 'healthy-current', marker: prior };
      }
      logger.event({
        event: 'path-install-consent-granted',
        source: 'grandfather',
        rcFileCount: prior.rcFiles.length,
      });
      return { status: 'healthy-current', marker };
    }
    logger.event({ event: 'path-install-healthy-current', binDir: prior.binDir });
    return { status: 'healthy-current', marker: prior };
  }

  let phase:
    | 'installCanonical'
    | 'writeEnvShim'
    | 'discoverPath'
    | 'checkRcHealth'
    | 'upsertRcBlocks'
    | 'cleanupExtraSymlinks'
    | 'writeMarker' = 'installCanonical';
  try {
    logger.event({ event: 'path-install-check-started' });
    installCanonical(home, wrapper, fs);
    phase = 'writeEnvShim';
    const shim = envShim(home);
    fs.mkdirSync(dirname(shim), { recursive: true });
    fs.writeFileSync(
      shim,
      '# OpenKnowledge CLI environment — managed file, do not edit.\ncase ":$' +
        '{PATH}:" in\n  *:"$' +
        '{HOME}/.ok/bin":*) ;;\n  *) export PATH="$' +
        '{HOME}/.ok/bin:$' +
        '{PATH}" ;;\nesac\n',
    );

    phase = 'discoverPath';
    const discovery = await discoverRealInteractivePath(opts);
    phase = 'checkRcHealth';
    const priorOptOuts = prior?.rcOptOuts ?? [];
    const newOptOuts = (prior?.rcFiles ?? []).filter(
      (file) => !priorOptOuts.includes(file) && !rcBlockHealthy(file, fs),
    );
    const rcOptOuts = [...priorOptOuts, ...newOptOuts];
    for (const file of newOptOuts) {
      logger.event({ event: 'path-install-rc-opt-out', path: file });
    }
    const targets = rcTargets(home, (opts.env ?? process.env).SHELL, fs, platform).filter(
      (target) => !rcOptOuts.includes(target.path),
    );
    const activePriorRcFiles = (prior?.rcFiles ?? []).filter((file) => !rcOptOuts.includes(file));
    const explicitGrant = opts.consentDecision?.status === 'granted';
    const canSkipRc =
      !explicitGrant &&
      prior != null &&
      discovery?.okBinAlreadyOnPath === true &&
      activePriorRcFiles.every((file) => rcBlockHealthy(file, fs));
    const nowIso = (opts.now?.() ?? new Date()).toISOString();
    const grandfatherEvidence =
      activePriorRcFiles.some((file) => rcBlockHealthy(file, fs)) ||
      targets.some((target) => rcBlockHealthy(target.path, fs));
    const consent: PathInstallConsent | undefined =
      opts.consentDecision ??
      prior?.consent ??
      (grandfatherEvidence ? { status: 'granted', at: nowIso } : undefined);
    const rcConsented = consent?.status === 'granted';
    phase = 'upsertRcBlocks';
    const rcFiles: string[] = [];
    const changedRcFiles: string[] = [];
    if (canSkipRc && prior) {
      rcFiles.push(...activePriorRcFiles);
    } else if (rcConsented) {
      rcFiles.push(...activePriorRcFiles);
      for (const target of targets) {
        if (upsertBlock(target.path, target.content, fs)) changedRcFiles.push(target.path);
        if (!rcFiles.includes(target.path)) rcFiles.push(target.path);
      }
    } else {
      rcFiles.push(...activePriorRcFiles.filter((file) => rcBlockHealthy(file, fs)));
    }
    phase = 'cleanupExtraSymlinks';
    const cleanup = removeRecordedExtraSymlinks(prior?.extraSymlinks ?? [], fs, logger);
    phase = 'writeMarker';
    const marker: PathInstallMarker = {
      version: 1,
      installedAt: nowIso,
      bundleVersion,
      bundleWrapperPath: wrapper,
      binDir: okBin(home),
      envShimPath: shim,
      rcFiles,
      rcOptOuts,
      pathDiscovery: discovery,
      extraSymlinks: cleanup.remaining,
      ...(consent ? { consent } : {}),
    };
    writeMarker(home, marker, fs);
    if (consent && consent.status !== prior?.consent?.status) {
      logger.event({
        event:
          consent.status === 'granted'
            ? 'path-install-consent-granted'
            : 'path-install-consent-declined',
        source: opts.consentDecision ? 'dialog' : 'grandfather',
        rcTargetCount: targets.length,
      });
    }
    logger.event({ event: 'path-install-symlink-success', binDir: marker.binDir });
    if (changedRcFiles.length > 0)
      logger.event({ event: 'path-install-rc-append-success', rcFiles: changedRcFiles });
    const parts: string[] = [];
    if (changedRcFiles.length > 0)
      parts.push(
        `Added ok to your PATH — managed block in ${changedRcFiles.map((p) => tildify(p, home)).join(', ')}.`,
      );
    if (newOptOuts.length > 0)
      parts.push(
        `You removed the OpenKnowledge block from ${newOptOuts.map((p) => tildify(p, home)).join(', ')} — it won't be re-added.`,
      );
    if (cleanup.removedCount > 0)
      parts.push(
        `Removed ${cleanup.removedCount} leftover ok symlink(s) created by an older version.`,
      );
    if (parts.length === 0) return { status: 'installed-silent', marker };
    return { status: 'installed', marker, summary: parts.join(' ') };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.event({ event: 'path-install-failed-all', phase, error, stack });
    return { status: 'failed-all', error };
  }
}

export function computePathInstallDescriptor(opts: {
  home: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  fs?: PathInstallFsOps;
  logger?: PathInstallLogger;
}): McpWiringPathInstallDescriptor {
  const { home, fs = defaultFsOps, logger = DEFAULT_LOGGER } = opts;
  const marker = readMarker(home, fs, logger);
  const rcOptOuts = marker?.rcOptOuts ?? [];
  const targets = rcTargets(home, (opts.env ?? process.env).SHELL, fs, opts.platform).filter(
    (target) => !rcOptOuts.includes(target.path),
  );
  const candidates = new Set<string>([
    ...targets.map((target) => target.path),
    ...(marker?.rcFiles ?? []),
  ]);
  const blockPresent = [...candidates].some((path) => rcBlockHealthy(path, fs));
  return {
    shellDetected: targets.length > 0,
    rcFilesToTouch: targets.map((target) => tildify(target.path, home)),
    alreadyInstalled: blockPresent || marker?.consent?.status === 'granted',
  };
}

export function isPathShimInstalled(opts: {
  home: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  fs?: PathInstallFsOps;
  logger?: PathInstallLogger;
}): boolean {
  const { home, fs = defaultFsOps, logger = DEFAULT_LOGGER } = opts;
  const marker = readMarker(home, fs, logger);
  const candidates = new Set<string>([
    ...rcTargets(home, (opts.env ?? process.env).SHELL, fs, opts.platform).map(
      (target) => target.path,
    ),
    ...(marker?.rcFiles ?? []),
  ]);
  return [...candidates].some((path) => rcBlockHealthy(path, fs));
}

export type RemovePathShimResult =
  | { status: 'removed'; strippedFiles: string[] }
  | { status: 'not-installed' }
  | { status: 'failed'; error: string };

export function removePathShimFromRcFiles(opts: {
  home: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  fs?: PathInstallFsOps;
  logger?: PathInstallLogger;
  now?: () => Date;
}): RemovePathShimResult {
  const { home, fs = defaultFsOps, logger = DEFAULT_LOGGER } = opts;
  const marker = readMarker(home, fs, logger);
  const okOwnedFishConf = join(home, '.config', 'fish', 'conf.d', 'open-knowledge.fish');
  const candidates = new Set<string>([
    ...rcTargets(home, (opts.env ?? process.env).SHELL, fs, opts.platform).map(
      (target) => target.path,
    ),
    ...(marker?.rcFiles ?? []),
    okOwnedFishConf,
  ]);
  const strippedFiles: string[] = [];
  try {
    for (const path of candidates) {
      if (!fs.existsSync(path)) continue;
      const prior = fs.readFileSync(path, 'utf8');
      let next = prior;
      while (BLOCK_RE.test(next)) next = next.replace(BLOCK_RE, '');
      if (next === prior) continue;
      if (next.trim() === '' && path === okOwnedFishConf) {
        fs.unlinkSync(path);
      } else {
        fs.writeFileSync(path, next);
      }
      strippedFiles.push(path);
      logger.event({ event: 'path-install-rc-block-removed', path: tildify(path, home) });
    }
    const consentAlreadyDeclined = marker?.consent?.status === 'declined';
    if (marker && (strippedFiles.length > 0 || !consentAlreadyDeclined)) {
      writeMarker(
        home,
        {
          ...marker,
          rcFiles: [],
          consent: { status: 'declined', at: (opts.now?.() ?? new Date()).toISOString() },
        },
        fs,
      );
      logger.event({
        event: 'path-install-consent-declined',
        source: 'settings',
        rcTargetCount: strippedFiles.length,
      });
    }
    if (strippedFiles.length === 0 && (marker === null || consentAlreadyDeclined)) {
      return { status: 'not-installed' };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.event({ event: 'path-install-remove-failed', error });
    return { status: 'failed', error };
  }
  return { status: 'removed', strippedFiles };
}
