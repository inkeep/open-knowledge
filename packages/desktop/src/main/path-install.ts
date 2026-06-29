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
import { wrapperPathInBundle } from './bundle-paths.ts';

const NAMES = ['ok', 'open-knowledge'] as const;
const BEGIN = '# >>> open-knowledge cli >>>';
const END = '# <<< open-knowledge cli <<<';
const BLOCK_RE = /^# >>> open-knowledge cli >>>\n[\s\S]*?^# <<< open-knowledge cli <<<\n?/m;

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

interface PathDiscovery {
  capturedAt: string;
  pathEntries: string[];
  shellUsed: string;
  okBinAlreadyOnPath: boolean;
}

interface PathInstallMarker {
  version: 1;
  installedAt: string;
  bundleVersion: string;
  bundleWrapperPath: string;
  binDir: string;
  envShimPath: string;
  rcFiles: string[];
  /** Rc files the user stripped the managed block from — never write to these
   *  again. `~/.ok/*` self-heals forever; the user's own rc files get one shot
   *  plus refreshes only while the block is still present. */
  rcOptOuts: string[];
  pathDiscovery: PathDiscovery | null;
  extraSymlinks: Array<{
    path: string;
    target: string;
    createdAt: string;
    kind: 'created' | 'refreshed-our-own';
  }>;
}

export type EnsureCliOnPathResult =
  | { status: 'skipped'; reason: string }
  | { status: 'healthy-current'; marker: PathInstallMarker }
  | { status: 'installed'; marker: PathInstallMarker; summary: string }
  | { status: 'installed-silent'; marker: PathInstallMarker }
  | { status: 'failed-all'; error: string };

/** The PATH leg of the combined startup-reclaim toast (consumed by the main
 *  process dispatcher + serialized to the renderer). `none` = stay silent. */
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
}

export function pathInstallMarkerPath(home: string): string {
  return join(home, 'Library', 'Application Support', 'OpenKnowledge', 'path-install.json');
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
): Array<{ path: string; create: boolean; content: string }> {
  const base = [
    { path: join(home, '.zshrc'), create: shell?.endsWith('/zsh') ?? false, content: block() },
    { path: join(home, '.bash_profile'), create: false, content: block() },
    {
      path: join(home, '.config', 'fish', 'conf.d', 'open-knowledge.fish'),
      create: true,
      content: fishBlock(),
    },
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

async function defaultSpawn(
  command: string,
  args: string[],
  opts: { timeoutMs: number; env: Record<string, string | undefined> },
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }>(
    (resolve) => {
      const child = nodeSpawn(command, args, {
        env: opts.env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
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
  const shell = env.SHELL ?? '/bin/zsh';
  const spawn = opts.spawn ?? defaultSpawn;
  const logger = opts.logger ?? DEFAULT_LOGGER;
  try {
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
  if (platform !== 'darwin') return { status: 'skipped', reason: 'platform' };
  if (!isPackaged && forceEnv !== '1') return { status: 'skipped', reason: 'dev-mode' };
  if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath))
    return { status: 'skipped', reason: 'bad-executable-path' };

  const wrapper = wrapperPathInBundle(executablePath);
  const prior = readMarker(home, fs, logger);
  if (prior && markerHealthy(prior, home, wrapper, fs, logger)) {
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
    const targets = rcTargets(home, (opts.env ?? process.env).SHELL, fs).filter(
      (target) => !rcOptOuts.includes(target.path),
    );
    const activePriorRcFiles = (prior?.rcFiles ?? []).filter((file) => !rcOptOuts.includes(file));
    const canSkipRc =
      prior != null &&
      discovery?.okBinAlreadyOnPath === true &&
      activePriorRcFiles.every((file) => rcBlockHealthy(file, fs));
    phase = 'upsertRcBlocks';
    const rcFiles: string[] = [];
    const changedRcFiles: string[] = [];
    if (canSkipRc && prior) {
      rcFiles.push(...activePriorRcFiles);
    } else {
      for (const target of targets) {
        if (upsertBlock(target.path, target.content, fs)) changedRcFiles.push(target.path);
        rcFiles.push(target.path);
      }
    }
    phase = 'cleanupExtraSymlinks';
    const cleanup = removeRecordedExtraSymlinks(prior?.extraSymlinks ?? [], fs, logger);
    phase = 'writeMarker';
    const marker: PathInstallMarker = {
      version: 1,
      installedAt: (opts.now?.() ?? new Date()).toISOString(),
      bundleVersion,
      bundleWrapperPath: wrapper,
      binDir: okBin(home),
      envShimPath: shim,
      rcFiles,
      rcOptOuts,
      pathDiscovery: discovery,
      extraSymlinks: cleanup.remaining,
    };
    writeMarker(home, marker, fs);
    logger.event({ event: 'path-install-symlink-success', binDir: marker.binDir });
    if (changedRcFiles.length > 0)
      logger.event({ event: 'path-install-rc-append-success', rcFiles: changedRcFiles });
    const tildify = (p: string) => (p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
    const parts: string[] = [];
    if (changedRcFiles.length > 0)
      parts.push(
        `Added ok to your PATH — managed block in ${changedRcFiles.map(tildify).join(', ')}.`,
      );
    if (newOptOuts.length > 0)
      parts.push(
        `You removed the OpenKnowledge block from ${newOptOuts.map(tildify).join(', ')} — it won't be re-added.`,
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
