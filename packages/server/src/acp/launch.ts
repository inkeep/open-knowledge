import { type ChildProcess, spawn } from 'node:child_process';
import { constants, existsSync, statSync } from 'node:fs';
import { access, chmod, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { augmentAgentSpawnPath, OK_DIR, OK_HOSTED_AGENT_ENV } from '@inkeep/open-knowledge-core';
import {
  tracedMkdir,
  tracedMkdirSync,
  tracedRm,
  tracedWriteFile,
  tracedWriteFileSync,
} from '../fs-traced.ts';
import type { PinoLogger } from '../logger.ts';
import { downloadToFileWithSha, extractArchive, isWithin, sanitizeSegment } from './archive.ts';
import { mergeLoginShellPath, preferLoginShellPath } from './login-shell-path.ts';
import type { ManagedRuntime } from './managed-runtime.ts';
import type { CustomAgentEntry, RegistryAgent, RegistryBinaryTarget } from './registry.ts';
import { STALE_INSTALL_ARTIFACT_AGE_MS, stagedInstall } from './staged-install.ts';

export interface ResolvedLaunch {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  kind: 'npx' | 'uvx' | 'binary' | 'custom';
  pathFromOverlay: boolean;
}

export const MINIMUM_NPX_NODE_MAJOR = 22;

export class AgentLaunchError extends Error {
  readonly code:
    | 'unsupported-platform'
    | 'no-distribution'
    | 'install-failed'
    | 'command-not-found';
  constructor(code: AgentLaunchError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentLaunchError';
    this.code = code;
  }
}

function defaultBinaryCacheDir(): string {
  return join(homedir(), OK_DIR, 'acp-agents');
}

function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function mergedEnv(overlay?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.toLowerCase() === 'npm_config_overrides') continue;
    base[k] = v;
  }
  base[pathKey(base)] = augmentAgentSpawnPath(envPath(base), {
    platform: process.platform,
    homeDir: homedir(),
    isDir,
    delimiter,
  });
  return { ...base, ...overlay };
}

export function agentSpawnPath(): string | undefined {
  return envPath(mergedEnv());
}

export function overlaySetsPath(overlay?: Record<string, string>): boolean {
  return overlay !== undefined && Object.keys(overlay).some((k) => k.toLowerCase() === 'path');
}

export function withHostedAgentMarker(env: Record<string, string>): Record<string, string> {
  return { ...env, [OK_HOSTED_AGENT_ENV]: '1' };
}

export async function resolveRegistryLaunch(
  agent: RegistryAgent,
  platformKey: string | null,
  log: PinoLogger,
  binaryCacheDir: string = defaultBinaryCacheDir(),
): Promise<ResolvedLaunch> {
  const dist = agent.distribution;
  if (dist.npx !== undefined) {
    return {
      cmd: 'npx',
      args: ['-y', dist.npx.package, ...(dist.npx.args ?? [])],
      env: mergedEnv(dist.npx.env),
      kind: 'npx',
      pathFromOverlay: overlaySetsPath(dist.npx.env),
    };
  }
  if (dist.uvx !== undefined) {
    return {
      cmd: 'uvx',
      args: [dist.uvx.package, ...(dist.uvx.args ?? [])],
      env: mergedEnv(dist.uvx.env),
      kind: 'uvx',
      pathFromOverlay: overlaySetsPath(dist.uvx.env),
    };
  }
  if (dist.binary !== undefined) {
    if (platformKey === null || dist.binary[platformKey] === undefined) {
      throw new AgentLaunchError(
        'unsupported-platform',
        `${agent.name} has no build for this platform`,
      );
    }
    const target = dist.binary[platformKey];
    const root = await ensureBinaryInstalled(agent.id, agent.version, target, binaryCacheDir, log);
    const cmd = resolve(root, target.cmd.replace(/\\/g, '/'));
    if (!isWithin(root, cmd)) {
      throw new AgentLaunchError(
        'install-failed',
        `${agent.name} manifest cmd escapes its archive`,
      );
    }
    return {
      cmd,
      args: [...(target.args ?? [])],
      env: mergedEnv(target.env),
      kind: 'binary',
      pathFromOverlay: overlaySetsPath(target.env),
    };
  }
  throw new AgentLaunchError('no-distribution', `${agent.name} has no supported distribution`);
}

export function resolveCustomLaunch(entry: CustomAgentEntry): ResolvedLaunch {
  return {
    cmd: entry.command,
    args: [...(entry.args ?? [])],
    env: mergedEnv(entry.env),
    kind: 'custom',
    pathFromOverlay: overlaySetsPath(entry.env),
  };
}

export function rewriteLaunchToManagedRuntime(
  launch: ResolvedLaunch,
  runtime: ManagedRuntime,
): ResolvedLaunch {
  const env = { ...launch.env };
  env[pathKey(env)] = prependPath(runtime.binDir, envPath(env));
  const pathFromOverlay = launch.pathFromOverlay;
  if (runtime.kind === 'node') {
    env.npm_config_cache = runtime.cacheDir;
    return { cmd: runtime.npxBin, args: [...launch.args], env, kind: 'npx', pathFromOverlay };
  }
  env.UV_CACHE_DIR = runtime.cacheDir;
  return { cmd: runtime.uvxBin, args: [...launch.args], env, kind: 'uvx', pathFromOverlay };
}

export function withLoginShellPath(launch: ResolvedLaunch, loginShellPath: string): ResolvedLaunch {
  return { ...launch, env: withLoginShellPathEnv(launch.env, loginShellPath) };
}

export function withPreferredLoginShellPath(
  launch: ResolvedLaunch,
  loginShellPath: string,
): ResolvedLaunch {
  const env = { ...launch.env };
  env[pathKey(env)] = preferLoginShellPath(envPath(env), loginShellPath, delimiter);
  return { ...launch, env };
}

export function withLoginShellPathEnv(
  env: Record<string, string>,
  loginShellPath: string,
): Record<string, string> {
  const next = { ...env };
  next[pathKey(next)] = mergeLoginShellPath(envPath(next), loginShellPath, delimiter);
  return next;
}

function pathKey(env: Record<string, string>): string {
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === 'path') return k;
  }
  return 'PATH';
}

function prependPath(dir: string, existing: string | undefined): string {
  return existing !== undefined && existing !== '' ? `${dir}${delimiter}${existing}` : dir;
}

export interface EnsureBinaryInstallOptions {
  fetchImpl?: typeof fetch;
  beforeCommit?: () => Promise<void>;
  commitLockTimeoutMs?: number;
}

async function findInstalledBinary(
  versionDir: string,
  target: RegistryBinaryTarget,
  log: PinoLogger,
): Promise<string | null> {
  try {
    if (!(await stat(versionDir)).isDirectory()) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err, versionDir }, '[acp-launch] could not inspect cached agent binary');
    }
    return null;
  }

  const cmdPath = resolve(versionDir, target.cmd.replace(/\\/g, '/'));
  if (!isWithin(versionDir, cmdPath)) return null;
  if (!(await isExecutableFile(cmdPath))) {
    return null;
  }
  return versionDir;
}

class DeterministicInstallError extends Error {}

function installFailureMarkerPath(agentDir: string, version: string): string {
  return join(agentDir, `.install-failed-${sanitizeSegment(version)}`);
}

async function readInstallFailureMarker(
  markerPath: string,
  target: RegistryBinaryTarget,
  log: PinoLogger,
): Promise<string | null> {
  let mtimeMs: number;
  let raw: string;
  try {
    mtimeMs = (await stat(markerPath)).mtimeMs;
    raw = await readFile(markerPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err, markerPath }, '[acp-launch] could not read the install failure marker');
    }
    return null;
  }
  if (Date.now() - mtimeMs > STALE_INSTALL_ARTIFACT_AGE_MS) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.archive !== target.archive ||
      parsed.cmd !== target.cmd ||
      parsed.sha256 !== (target.sha256 ?? null)
    ) {
      return null;
    }
    return typeof parsed.reason === 'string' ? parsed.reason : null;
  } catch {
    log.warn(
      { markerPath },
      '[acp-launch] install failure marker is malformed — treating it as absent',
    );
    return null;
  }
}

async function writeInstallFailureMarker(
  markerPath: string,
  target: RegistryBinaryTarget,
  reason: string,
  log: PinoLogger,
): Promise<void> {
  const payload = JSON.stringify({
    archive: target.archive,
    cmd: target.cmd,
    sha256: target.sha256 ?? null,
    reason,
  });
  await tracedWriteFile(markerPath, payload).catch((err) => {
    log.warn({ err, markerPath }, '[acp-launch] could not record the failed binary install');
  });
}

export async function ensureBinaryInstalled(
  id: string,
  version: string,
  target: RegistryBinaryTarget,
  cacheDir: string,
  log: PinoLogger,
  opts: EnsureBinaryInstallOptions = {},
): Promise<string> {
  const versionDir = join(cacheDir, sanitizeSegment(id), sanitizeSegment(version));
  const markerPath = installFailureMarkerPath(dirname(versionDir), version);
  try {
    return await stagedInstall<string>({
      versionDir,
      stagingLabel: sanitizeSegment(version),
      findInstalled: () => findInstalledBinary(versionDir, target, log),
      prepare: async (stagingDir) => {
        const remembered = await readInstallFailureMarker(markerPath, target, log);
        if (remembered !== null) {
          throw new Error(
            `${remembered} (remembered from a recent attempt — retried when the manifest changes or after a day)`,
          );
        }
        await tracedRm(markerPath, { force: true });
        log.info({ id, version, archive: target.archive }, '[acp-launch] downloading agent binary');
        const isZip = /\.zip$/i.test(new URL(target.archive).pathname);
        const archivePath = join(stagingDir, isZip ? 'archive.zip' : 'archive.tar.gz');
        const sha = await downloadToFileWithSha(target.archive, archivePath, {
          signal: AbortSignal.timeout(120_000),
          fetchImpl: opts.fetchImpl,
        });
        if (target.sha256 !== undefined) {
          if (sha !== target.sha256.toLowerCase()) {
            throw new Error(`archive checksum mismatch: expected ${target.sha256}, got ${sha}`);
          }
        } else {
          log.warn(
            { id, version, archive: target.archive },
            '[acp-launch] manifest carries no sha256 for the binary archive — installing unverified',
          );
        }

        const extractDir = join(stagingDir, 'extracted');
        await tracedMkdir(extractDir, { recursive: true });
        await extractArchive(archivePath, extractDir, isZip);
        const cmdPath = resolve(extractDir, target.cmd.replace(/\\/g, '/'));
        if (!isWithin(extractDir, cmdPath)) {
          throw new DeterministicInstallError('manifest cmd escapes the extracted archive');
        }
        await chmod(cmdPath, 0o755).catch(() => {});
        if (!(await isExecutableFile(cmdPath))) {
          throw new DeterministicInstallError(
            `extracted agent archive has no usable command at ${target.cmd}`,
          );
        }
        return extractDir;
      },
      log,
      logPrefix: '[acp-launch]',
      logContext: { id, version },
      installedMessage: 'agent binary installed',
      missingAfterCommitMessage: 'installed agent binary not found after extract',
      beforeCommit: opts.beforeCommit,
      commitLockTimeoutMs: opts.commitLockTimeoutMs,
    });
  } catch (err) {
    if (err instanceof DeterministicInstallError) {
      await writeInstallFailureMarker(markerPath, target, err.message, log);
    }
    throw new AgentLaunchError(
      'install-failed',
      `installing ${id}@${version} failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export async function preflightLaunch(launch: ResolvedLaunch): Promise<void> {
  if (await isLaunchable(launch.cmd, envPath(launch.env))) return;
  throw new AgentLaunchError('command-not-found', missingCommandHint(launch));
}

function missingCommandHint(launch: ResolvedLaunch): string {
  switch (launch.kind) {
    case 'npx':
      return `\`${launch.cmd}\` was not found. This agent runs through npx, which ships with Node.js — install Node.js (https://nodejs.org) and make sure it is on your PATH.`;
    case 'uvx':
      return `\`${launch.cmd}\` was not found. This agent runs through uvx, which ships with uv — install uv (https://docs.astral.sh/uv/getting-started/installation/) and make sure it is on your PATH.`;
    case 'binary':
      return `the agent binary at ${launch.cmd} is missing or not executable.`;
    case 'custom':
      return `\`${launch.cmd}\` was not found on your PATH. A desktop app launched from the Dock or Finder doesn't inherit your shell's PATH, so an agent installed only in a shell-configured location won't be visible here — use an absolute path to the command, or install it to a standard location.`;
  }
}

export function brokenInterpreterHint(launch: ResolvedLaunch, detail: string): string {
  const cause =
    launch.kind === 'uvx'
      ? 'That usually means its uv is broken. Reinstall or repair uv and try again.'
      : 'That usually means its Node.js is broken — on macOS a common cause is a Homebrew `node` whose `icu4c` library was upgraded out from under it. Reinstall or repair Node.js and try again.';
  return `\`${launch.cmd}\` is installed but failed to run (${detail}). ${cause}`;
}

export function unrepairableManagedRuntimeHint(launch: ResolvedLaunch, detail: string): string {
  const runtime = launch.kind === 'uvx' ? 'uv' : 'Node.js';
  return `OK downloaded a fresh copy of ${runtime} and it still can't run (${detail}). Something on this machine is stopping it — antivirus, a security policy, or an unsupported CPU are the usual causes.`;
}

export function incompatibleManagedRuntimeHint(detail: string): string {
  return `OK's private Node.js runtime is incompatible (${detail}). Update Open Knowledge and try again.`;
}

export function undeletableManagedRuntimeHint(launch: ResolvedLaunch, detail: string): string {
  const runtime = launch.kind === 'uvx' ? 'uv' : 'Node.js';
  return `OK's own copy of ${runtime} is damaged (${detail}) and couldn't be replaced — another agent may still be using it. Close other agent threads and try again.`;
}

export function declinedRepairHint(launch: ResolvedLaunch): string {
  const runtime = launch.kind === 'uvx' ? 'uv' : 'Node.js';
  return `OK's own copy of ${runtime} is damaged and can't run this agent. Start the agent again to let OK download a fresh copy.`;
}

const PROBE_OUTPUT_MAX = 2_000;
const PROBE_DETAIL_MAX = 300;

export function probeInterpreterHealth(
  launch: ResolvedLaunch,
  timeoutMs = 5_000,
  log?: PinoLogger,
): Promise<string | null> {
  const win = process.platform === 'win32';
  const resolved = win ? resolveWindowsCommand(launch.cmd, envPath(launch.env)) : launch.cmd;
  const wrap = win && /\.(cmd|bat)$/i.test(resolved);
  const { cmd, args } = wrap
    ? windowsCmdWrap(resolved, ['--version'])
    : { cmd: resolved, args: ['--version'] };
  return new Promise((settleProbe) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        env: launch.env,
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: false,
        detached: !win,
        windowsHide: true,
        windowsVerbatimArguments: wrap,
      });
    } catch (err) {
      settleProbe(err instanceof Error ? err.message : String(err));
      return;
    }
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < PROBE_OUTPUT_MAX) stderr += chunk;
    });
    let settled = false;
    const settle = (detail: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settleProbe(detail);
    };
    const timer = setTimeout(() => {
      terminateAgentTree(child, { graceMs: 0, forceWaitMs: 0 }).catch(() => {});
      log?.debug(
        { cmd: launch.cmd, kind: launch.kind, timeoutMs },
        '[acp-launch] interpreter health probe timed out — proceeding with the launch',
      );
      settle(null);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (err) => settle(err.message));
    child.on('exit', (code, signal) => {
      if (signal === null && (code === null || code === 0)) {
        settle(null);
        return;
      }
      const firstStderrLine = stderr
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '');
      const reason = signal ?? `exit code ${code}`;
      settle(
        firstStderrLine !== undefined
          ? `${reason}: ${firstStderrLine.slice(0, PROBE_DETAIL_MAX)}`
          : reason,
      );
    });
  });
}

export function probeNpxNodeCompatibility(
  launch: ResolvedLaunch,
  timeoutMs = 5_000,
  log?: PinoLogger,
): Promise<string | null> {
  const win = process.platform === 'win32';
  const resolved = resolveNpxNodeCommand(launch);
  return new Promise((settleProbe) => {
    let child: ChildProcess;
    try {
      child = spawn(resolved, ['--version'], {
        env: launch.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: !win,
        windowsHide: true,
      });
    } catch (err) {
      settleProbe(
        `Node.js version probe could not start: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < PROBE_OUTPUT_MAX) stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < PROBE_OUTPUT_MAX) stderr += chunk;
    });
    let settled = false;
    const settle = (detail: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settleProbe(detail);
    };
    const timer = setTimeout(() => {
      terminateAgentTree(child, { graceMs: 0, forceWaitMs: 0 }).catch(() => {});
      log?.debug(
        { cmd: launch.cmd, kind: launch.kind, timeoutMs },
        '[acp-launch] Node.js compatibility probe timed out — proceeding with the launch',
      );
      settle(null);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (err) => settle(`Node.js version probe failed: ${err.message}`));
    child.on('close', (code, signal) => {
      if (signal !== null || (code !== null && code !== 0)) {
        const firstStderrLine = stderr
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line !== '');
        const reason = signal ?? `exit code ${code}`;
        settle(
          firstStderrLine === undefined
            ? `Node.js version probe failed with ${reason}`
            : `Node.js version probe failed with ${reason}: ${firstStderrLine.slice(0, PROBE_DETAIL_MAX)}`,
        );
        return;
      }
      const version = stdout.trim();
      const match = /^v?(\d+)(?:\.|$)/.exec(version);
      if (match === null) {
        settle(
          version === ''
            ? 'Node.js version probe returned no version'
            : `Node.js reported an unrecognized version: ${version.slice(0, PROBE_DETAIL_MAX)}`,
        );
        return;
      }
      const major = Number.parseInt(match[1] ?? '', 10);
      settle(
        major >= MINIMUM_NPX_NODE_MAJOR
          ? null
          : `Node.js ${version} is incompatible; Node.js ${MINIMUM_NPX_NODE_MAJOR} or newer is required`,
      );
    });
  });
}

export function incompatibleNodeHint(launch: ResolvedLaunch, detail: string): string {
  return `\`${launch.cmd}\` cannot run this agent with the selected Node.js runtime (${detail}). Upgrade Node.js or let Open Knowledge download a private compatible copy.`;
}

export function envPath(env: Record<string, string>): string | undefined {
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === 'path') return v;
  }
  return process.env.PATH;
}

export function isPathQualified(cmd: string): boolean {
  const win = process.platform === 'win32';
  return isAbsolute(cmd) || cmd.includes('/') || (win && cmd.includes('\\'));
}

async function isLaunchable(cmd: string, pathEnv: string | undefined): Promise<boolean> {
  const win = process.platform === 'win32';
  if (isPathQualified(cmd)) {
    return isExecutableFile(cmd);
  }
  const exts = win
    ? [
        '',
        ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((e) => e.trim())
          .filter((e) => e !== ''),
      ]
    : [''];
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      if (await isExecutableFile(join(dir, cmd + ext))) return true;
    }
  }
  return false;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const st = await stat(candidate);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveWindowsCommand(cmd: string, pathEnv: string | undefined): string {
  if (isAbsolute(cmd) || cmd.includes('\\') || cmd.includes('/')) return cmd;
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return cmd;
}

export function resolveNpxNodeCommand(
  launch: ResolvedLaunch,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return 'node';
  const pathEnv = envPath(launch.env);
  const resolvedNpx = resolveWindowsCommand(launch.cmd, pathEnv);
  const npxWasResolved =
    resolvedNpx !== launch.cmd ||
    isAbsolute(resolvedNpx) ||
    resolvedNpx.includes('/') ||
    resolvedNpx.includes('\\');
  if (npxWasResolved) {
    const siblingNode = join(dirname(resolvedNpx), 'node.exe');
    try {
      if (statSync(siblingNode).isFile()) return siblingNode;
    } catch {}
  }
  return resolveWindowsCommand('node', pathEnv);
}

function quoteCmdArg(arg: string): string {
  if (arg === '') return '""';
  return /[\s"&()<>^|%]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

export function windowsCmdWrap(cmd: string, args: string[]): { cmd: string; args: string[] } {
  const inner = [`"${cmd}"`, ...args.map(quoteCmdArg)].join(' ');
  return { cmd: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${inner}"`] };
}

function acpNpxIsolatedCwd(): string {
  const dir = join(homedir(), OK_DIR, 'acp-npx-cwd');
  tracedMkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = join(dir, 'package.json');
  if (!existsSync(marker)) {
    tracedWriteFileSync(
      marker,
      `${JSON.stringify({ name: 'openknowledge-acp-npx-isolated', version: '0.0.0', private: true }, null, 2)}\n`,
    );
  }
  return dir;
}

export function spawnAcpAgent(launch: ResolvedLaunch, cwd: string): ChildProcess {
  if (!isAbsolute(cwd)) {
    throw new Error(`spawnAcpAgent requires an absolute cwd, got: ${cwd}`);
  }
  const win = process.platform === 'win32';
  const resolved = win ? resolveWindowsCommand(launch.cmd, envPath(launch.env)) : launch.cmd;
  const wrap = win && /\.(cmd|bat)$/i.test(resolved);
  const { cmd, args } = wrap
    ? windowsCmdWrap(resolved, launch.args)
    : { cmd: resolved, args: launch.args };
  const spawnCwd = launch.kind === 'npx' ? acpNpxIsolatedCwd() : cwd;
  return spawn(cmd, args, {
    cwd: spawnCwd,
    env: withHostedAgentMarker(launch.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: !win,
    windowsHide: true,
    windowsVerbatimArguments: wrap,
  });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function awaitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolvePromise(false);
    }, timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

function signalAgentGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined || hasExited(child)) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {}
  try {
    child.kill(signal);
  } catch {}
}

export async function terminateAgentTree(
  child: ChildProcess,
  opts: { graceMs: number; forceWaitMs?: number },
): Promise<boolean> {
  const forceWaitMs = opts.forceWaitMs ?? 2_000;
  if (hasExited(child)) return true;
  if (process.platform === 'win32') {
    if (child.pid !== undefined) {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
        }).unref();
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    }
    return awaitExit(child, Math.max(opts.graceMs, forceWaitMs));
  }
  signalAgentGroup(child, 'SIGTERM');
  if (await awaitExit(child, opts.graceMs)) return true;
  signalAgentGroup(child, 'SIGKILL');
  return awaitExit(child, forceWaitMs);
}
