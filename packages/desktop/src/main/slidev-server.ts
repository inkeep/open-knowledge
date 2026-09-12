import { type ChildProcess, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createServer } from 'node:net';
import { augmentAgentSpawnPath } from '@inkeep/open-knowledge-core';
import {
  composeOkChildEnv,
  hasNoResolvableOkHome,
  type OkManagedBinDirsOptions,
  okChildEnvOptionsFromProcess,
  okManagedBinDirs,
  okPathDelimiter,
} from '../shared/ok-child-env.ts';
import {
  commandWithManagedPath,
  interactiveShellArgs,
  quoteShellArg,
  type ShellCommandFamily,
  shellCommandFamily,
} from '../shared/terminal-shell.ts';
import { windowsPathKey } from '../shared/windows-env.ts';
import { getLogger } from './desktop-logger.ts';
import { projectLocalSlidevBin } from './slidev-resolve.ts';

export interface SlidevProcess {
  onExit(cb: (code: number | null) => void): void;
  signal(signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  isAlive(): boolean;
  readonly pid: number | undefined;
  readonly spawnError?: NodeJS.ErrnoException | undefined;
}

export type ReadinessProbe = { reachable: false } | { reachable: true; hasVersionMeta: boolean };

type SlidevStartFailure =
  | 'spawn-error'
  | 'port-error'
  | 'exited-early'
  | 'timeout'
  | 'unsupported-server';

export type StartSlidevResult =
  | { ok: true; port: number; process: SlidevProcess }
  | { ok: false; reason: SlidevStartFailure };

export interface StartSlidevDeps {
  findFreePort(): Promise<number>;
  spawnSlidev(port: number): SlidevProcess;
  probeReady(port: number): Promise<ReadinessProbe>;
  now(): number;
  delay(ms: number): Promise<void>;
  onSpawned?(process: SlidevProcess): void;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

function logSlidevFailure(event: string, err: unknown): void {
  getLogger('slidev-server').warn(
    { event, code: (err as NodeJS.ErrnoException | null)?.code ?? null, err },
    'slidev server failure',
  );
}

export async function startSlidevServer(deps: StartSlidevDeps): Promise<StartSlidevResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let port: number;
  let child: SlidevProcess;
  try {
    port = await deps.findFreePort();
  } catch (err) {
    logSlidevFailure('slides-port-error', err);
    return { ok: false, reason: 'port-error' };
  }
  try {
    child = deps.spawnSlidev(port);
  } catch (err) {
    logSlidevFailure('slides-spawn-error', err);
    return { ok: false, reason: 'spawn-error' };
  }
  deps.onSpawned?.(child);

  let exited = false;
  child.onExit(() => {
    exited = true;
  });

  const deadline = deps.now() + timeoutMs;
  while (true) {
    if (exited) {
      if (child.spawnError !== undefined) return { ok: false, reason: 'spawn-error' };
      return { ok: false, reason: 'exited-early' };
    }
    const probe = await deps.probeReady(port);
    if (exited) {
      if (child.spawnError !== undefined) return { ok: false, reason: 'spawn-error' };
      return { ok: false, reason: 'exited-early' };
    }
    if (probe.reachable) {
      if (probe.hasVersionMeta) return { ok: true, port, process: child };
      void child.signal('SIGKILL');
      return { ok: false, reason: 'unsupported-server' };
    }
    if (deps.now() >= deadline) {
      void child.signal('SIGKILL');
      return { ok: false, reason: 'timeout' };
    }
    await deps.delay(pollIntervalMs);
  }
}

export function findFreePort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        server.close();
        rejectPort(new Error('could not resolve a free port'));
        return;
      }
      const { port } = addr;
      server.close(() => resolvePort(port));
    });
  });
}

const SLIDEV_VERSION_META_RE = /<meta[^>]*slidev:version/i;

const PROBE_TIMEOUT_MS = 2_000;

export async function probeSlidevReady(port: number): Promise<ReadinessProbe> {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { reachable: false };
    const html = await res.text();
    return { reachable: true, hasVersionMeta: SLIDEV_VERSION_META_RE.test(html) };
  } catch {
    return { reachable: false };
  }
}

export type SlidevSpawnConfig = {
  readonly docPath: string;
  readonly shell: string;
} & (
  | { readonly source: 'project-local'; readonly projectRoot: string }
  | { readonly source: 'global'; readonly projectRoot: string | undefined }
);

export type SlidevInvocation =
  | { readonly mode: 'direct'; readonly file: string; readonly args: readonly string[] }
  | {
      readonly mode: 'interactive-shell';
      readonly file: string;
      readonly args: readonly string[];
      readonly family: ShellCommandFamily;
    }
  | {
      readonly mode: 'windows-shell';
      readonly file: string;
      readonly args: readonly string[];
      readonly verbatim: true;
    };

function cmdQuote(value: string): string {
  return `"${value}"`;
}

const JOB_CONTROL_OPT_OUT: Record<ShellCommandFamily, string> = {
  posix: 'set +m; ',
  fish: 'status job-control none; ',
  fallback: '',
};

export function buildSlidevInvocation(
  config: SlidevSpawnConfig,
  port: number,
  platform: NodeJS.Platform,
  managedBinDirs: readonly string[],
): SlidevInvocation {
  const portArgs = ['--port', String(port)];
  if (platform === 'win32') {
    const target =
      config.source === 'project-local'
        ? projectLocalSlidevBin(config.projectRoot, platform)
        : 'slidev';
    const cmdline = `"${cmdQuote(target)} ${cmdQuote(config.docPath)} ${portArgs.join(' ')}"`;
    return {
      mode: 'windows-shell',
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', cmdline],
      verbatim: true,
    };
  }
  if (config.source === 'project-local') {
    const bin = projectLocalSlidevBin(config.projectRoot, platform);
    return { mode: 'direct', file: bin, args: [config.docPath, ...portArgs] };
  }
  const family = shellCommandFamily(config.shell);
  const runSlidev = `slidev ${quoteShellArg(config.shell, config.docPath)} ${portArgs.join(' ')}`;
  const launched = `${JOB_CONTROL_OPT_OUT[family]}${runSlidev}`;
  const cmdline = commandWithManagedPath(config.shell, launched, managedBinDirs);
  return {
    mode: 'interactive-shell',
    file: config.shell,
    args: [...interactiveShellArgs(platform), '-c', cmdline],
    family,
  };
}

export interface SignalSlidevChildDeps {
  readonly platform?: NodeJS.Platform;
  readonly killWindowsTree?: (pid: number) => Promise<void>;
  readonly timeoutMs?: number;
}

const WINDOWS_TREE_KILL_TIMEOUT_MS = 5_000;

function taskkillWindowsTree(pid: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      killer.kill();
      settle(new Error('taskkill timed out'));
    }, timeoutMs);
    timer.unref();
    killer.once('error', (error) => settle(error));
    killer.once('exit', (code) => {
      if (code === 0) settle();
      else settle(new Error(`taskkill exited with status ${code ?? 'unknown'}`));
    });
  });
}

export function signalSlidevChild(
  child: ChildProcess,
  sig: 'SIGTERM' | 'SIGKILL',
  deps: SignalSlidevChildDeps = {},
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  if ((deps.platform ?? process.platform) === 'win32') {
    const timeoutMs = deps.timeoutMs ?? WINDOWS_TREE_KILL_TIMEOUT_MS;
    const killTree = deps.killWindowsTree ?? ((treePid) => taskkillWindowsTree(treePid, timeoutMs));
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (err?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err !== undefined) {
          getLogger('slidev-server').warn(
            { event: 'slides-tree-kill-failed', pid, signal: sig, err },
            'slidev server failure',
          );
        }
        resolve();
      };
      const timer = setTimeout(() => finish(new Error('taskkill timed out')), timeoutMs);
      timer.unref();
      void Promise.resolve()
        .then(() => killTree(pid))
        .then(
          () => finish(),
          (err: unknown) => finish(err),
        );
    });
  }
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {}
  }
  return Promise.resolve();
}

function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function composeSlidevSpawnEnv(
  parentEnv: Record<string, string | undefined>,
  options: OkManagedBinDirsOptions,
  isDirSync: (dir: string) => boolean = isDir,
): Record<string, string> {
  const env = composeOkChildEnv(parentEnv, options);
  const homeDir = options.home;
  if (!homeDir) {
    if (hasNoResolvableOkHome(options)) {
      getLogger('slidev-server').warn(
        { event: 'slides-no-ok-managed-home', platform: options.platform },
        'Slidev child has no resolvable home directory',
      );
    }
    return env;
  }
  const pathKey = windowsPathKey(env);
  env[pathKey] = augmentAgentSpawnPath(env[pathKey], {
    platform: options.platform,
    homeDir,
    isDir: isDirSync,
    delimiter: okPathDelimiter(options.platform),
  });
  return env;
}

export function slidevSpawnEnv(
  options: OkManagedBinDirsOptions = okChildEnvOptionsFromProcess(),
): NodeJS.ProcessEnv {
  return composeSlidevSpawnEnv(process.env, options);
}

export function adaptSlidevChild(child: ChildProcess): SlidevProcess {
  let alive = true;
  let spawnError: NodeJS.ErrnoException | undefined;
  child.on('exit', () => {
    alive = false;
  });
  child.on('error', (err: NodeJS.ErrnoException) => {
    if (child.pid === undefined) {
      alive = false;
      spawnError = err;
    }
    logSlidevFailure('slides-child-error', err);
  });
  return {
    onExit: (cb) => {
      let reported = false;
      const report = (code: number | null) => {
        if (reported) return;
        reported = true;
        cb(code);
      };
      child.on('exit', (code) => report(code));
      child.on('error', () => {
        if (child.pid === undefined) report(null);
      });
    },
    get spawnError() {
      return spawnError;
    },
    signal: (sig) => signalSlidevChild(child, sig),
    isAlive: () => alive,
    get pid() {
      return child.pid;
    },
  };
}

export function realSpawnSlidev(config: SlidevSpawnConfig, port: number): SlidevProcess {
  const options = okChildEnvOptionsFromProcess();
  const invocation = buildSlidevInvocation(
    config,
    port,
    process.platform,
    okManagedBinDirs(options),
  );
  if (invocation.mode === 'interactive-shell') {
    getLogger('slidev-server').info(
      {
        event: 'slides-launch-shell-resolved',
        platform: options.platform,
        shellCommandFamily: invocation.family,
      },
      'Slidev deck launches through an interactive shell',
    );
  }
  const child = spawn(invocation.file, [...invocation.args], {
    cwd: config.projectRoot,
    env: slidevSpawnEnv(options),
    stdio: 'ignore',
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    windowsVerbatimArguments: invocation.mode === 'windows-shell',
  });
  return adaptSlidevChild(child);
}
