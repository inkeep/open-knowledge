import { type ChildProcess, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import { augmentAgentSpawnPath } from '@inkeep/open-knowledge-core';
import { projectLocalSlidevBin } from './slidev-resolve.ts';

export interface SlidevProcess {
  onExit(cb: (code: number | null) => void): void;
  signal(signal: 'SIGTERM' | 'SIGKILL'): void;
  isAlive(): boolean;
  readonly pid: number | undefined;
  readonly spawnError?: NodeJS.ErrnoException | undefined;
}

export type ReadinessProbe = { reachable: false } | { reachable: true; hasVersionMeta: boolean };

type SlidevStartFailure = 'spawn-error' | 'exited-early' | 'timeout' | 'unsupported-server';

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

export async function startSlidevServer(deps: StartSlidevDeps): Promise<StartSlidevResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let port: number;
  let child: SlidevProcess;
  try {
    port = await deps.findFreePort();
    child = deps.spawnSlidev(port);
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'slides-spawn-error',
        code: (err as NodeJS.ErrnoException | null)?.code ?? null,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
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
      child.signal('SIGKILL');
      return { ok: false, reason: 'unsupported-server' };
    }
    if (deps.now() >= deadline) {
      child.signal('SIGKILL');
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
  | { readonly mode: 'login-shell'; readonly file: string; readonly args: readonly string[] }
  | {
      readonly mode: 'windows-shell';
      readonly file: string;
      readonly args: readonly string[];
      readonly verbatim: true;
    };

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cmdQuote(value: string): string {
  return `"${value}"`;
}

export function buildSlidevInvocation(
  config: SlidevSpawnConfig,
  port: number,
  platform: NodeJS.Platform = process.platform,
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
  const cmdline = `exec slidev ${shSingleQuote(config.docPath)} ${portArgs.join(' ')}`;
  return { mode: 'login-shell', file: config.shell, args: ['-l', '-i', '-c', cmdline] };
}

function signalSlidevChild(child: ChildProcess, sig: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      child.kill();
    } catch {}
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {}
  }
}

function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function repairedSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PATH = augmentAgentSpawnPath(env.PATH, {
    platform: process.platform,
    homeDir: homedir(),
    isDir,
    delimiter,
  });
  return env;
}

export function realSpawnSlidev(config: SlidevSpawnConfig, port: number): SlidevProcess {
  const invocation = buildSlidevInvocation(config, port);
  const child = spawn(invocation.file, [...invocation.args], {
    cwd: config.projectRoot,
    env: repairedSpawnEnv(),
    stdio: 'ignore',
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    windowsVerbatimArguments: invocation.mode === 'windows-shell',
  });
  let alive = true;
  let spawnError: NodeJS.ErrnoException | undefined;
  child.on('exit', () => {
    alive = false;
  });
  child.on('error', (err: NodeJS.ErrnoException) => {
    alive = false;
    spawnError = err;
    console.warn(
      JSON.stringify({
        event: 'slides-child-error',
        code: err?.code ?? null,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  });
  return {
    onExit: (cb) => {
      child.on('exit', (code) => cb(code));
      child.on('error', () => cb(null));
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
