import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { tracedOpenUnlinkedSync } from '../fs-traced.ts';
import type { PinoLogger } from '../logger.ts';

const LOGIN_SHELL_PROBE_TIMEOUT_MS = 5_000;

const MAX_PROBE_STDOUT_BYTES = 512 * 1024;

const PATH_BEGIN = '__OK_PATH_BEGIN__';
const PATH_END = '__OK_PATH_END__';

const PROBE_SCRIPT = `printf %s ${PATH_BEGIN}; printenv PATH; printf %s ${PATH_END}`;

export function loginShellProbeArgs(): readonly string[] {
  return ['-l', '-i', '-c', PROBE_SCRIPT];
}

function interactiveShellProbeArgs(): readonly string[] {
  return ['-i', '-c', PROBE_SCRIPT];
}

const SPLIT_STARTUP_SHELLS = new Set(['bash', 'sh']);

export function parseLoginShellPath(stdout: string): string | null {
  const begin = stdout.lastIndexOf(PATH_BEGIN);
  if (begin === -1) return null;
  const from = begin + PATH_BEGIN.length;
  const end = stdout.indexOf(PATH_END, from);
  if (end === -1) return null;
  const value = stdout.slice(from, end).trim();
  return value === '' ? null : value;
}

export function mergeLoginShellPath(
  current: string | undefined,
  loginShellPath: string,
  delim: string,
): string {
  const entries = (current ?? '').split(delim).filter((e) => e !== '');
  const seen = new Set(entries);
  for (const entry of loginShellPath.split(delim)) {
    if (entry === '' || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries.join(delim);
}

export function preferLoginShellPath(
  current: string | undefined,
  loginShellPath: string,
  delim: string,
): string {
  return mergeLoginShellPath(loginShellPath, current ?? '', delim);
}

const NON_INTERACTIVE_SHELLS = new Set(['false', 'nologin', 'sync']);

type RunLoginShellProbe = (
  shell: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string | null>;

export interface LoginShellPathDeps {
  log: PinoLogger;
  platform?: NodeJS.Platform;
  shell?: string | undefined;
  timeoutMs?: number;
  runProbe?: RunLoginShellProbe;
  now?: () => number;
}

const liveProbes = new Set<ChildProcess>();
let killLiveProbesOnExit = false;

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function killProbeTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || hasExited(child)) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {}
  }
  child.kill('SIGKILL');
}

function killLiveProbes(): void {
  for (const child of liveProbes) killProbeTree(child);
}

function trackLiveProbe(child: ChildProcess): void {
  liveProbes.add(child);
  const forget = (): void => {
    liveProbes.delete(child);
  };
  child.once('exit', forget);
  child.once('error', forget);
  if (killLiveProbesOnExit) return;
  killLiveProbesOnExit = true;
  process.on('exit', killLiveProbes);
}

function readProbeOutput(fd: number): string | null {
  try {
    const size = Math.min(fstatSync(fd).size, MAX_PROBE_STDOUT_BYTES);
    const buffer = Buffer.alloc(size);
    const read = readSync(fd, buffer, 0, size, 0);
    return buffer.toString('utf8', 0, read);
  } catch {
    return null;
  }
}

const spawnLoginShellProbe: RunLoginShellProbe = (shell, args, timeoutMs) =>
  new Promise((resolvePromise) => {
    let output: number;
    try {
      output = tracedOpenUnlinkedSync(join(tmpdir(), `ok-login-shell-path-${randomUUID()}`));
    } catch {
      resolvePromise(null);
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(shell, [...args], {
        stdio: ['ignore', output, 'ignore'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      closeSync(output);
      resolvePromise(null);
      return;
    }
    trackLiveProbe(child);
    let settled = false;
    const finish = (result: () => string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result());
      try {
        closeSync(output);
      } catch {}
    };
    const timer = setTimeout(() => {
      killProbeTree(child);
      finish(() => null);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', () => finish(() => null));
    child.on('close', () => finish(() => readProbeOutput(output)));
  });

const FAILED_PROBE_RETRY_MS = 60_000;

async function captureShellPath(
  deps: LoginShellPathDeps,
  shell: string,
  args: readonly string[],
  timeoutMs: number,
  runProbe: RunLoginShellProbe,
): Promise<string | null> {
  const startedAt = Date.now();
  const stdout = await runProbe(shell, args, timeoutMs).catch(() => null);
  const elapsed = Date.now() - startedAt;
  if (stdout === null) {
    deps.log.debug({ shell, args, elapsed }, '[login-shell-path] probe produced no output');
    return null;
  }
  const value = parseLoginShellPath(stdout);
  if (value === null) {
    deps.log.debug({ shell, args, elapsed }, '[login-shell-path] probe output carried no PATH');
    return null;
  }
  return value;
}

export function createLoginShellPathProvider(
  deps: LoginShellPathDeps,
): () => Promise<string | null> {
  const platform = deps.platform ?? process.platform;
  const shell = deps.shell ?? process.env.SHELL;
  const timeoutMs = deps.timeoutMs ?? LOGIN_SHELL_PROBE_TIMEOUT_MS;
  const runProbe = deps.runProbe ?? spawnLoginShellProbe;
  const now = deps.now ?? Date.now;
  let answer: Promise<string | null> | null = null;
  let retryFailedAfter = 0;

  const probe = async (): Promise<string | null> => {
    if (platform === 'win32') return null;
    if (shell === undefined || shell === '') {
      deps.log.debug({}, '[login-shell-path] no $SHELL; skipping probe');
      return null;
    }
    const base = shell.slice(shell.lastIndexOf('/') + 1);
    if (NON_INTERACTIVE_SHELLS.has(base)) {
      deps.log.debug({ shell }, '[login-shell-path] login-refusing shell; skipping probe');
      return null;
    }
    const login = await captureShellPath(deps, shell, loginShellProbeArgs(), timeoutMs, runProbe);
    if (!SPLIT_STARTUP_SHELLS.has(base)) return login;
    const interactive = await captureShellPath(
      deps,
      shell,
      interactiveShellProbeArgs(),
      timeoutMs,
      runProbe,
    );
    if (login === null) return interactive;
    if (interactive === null) return login;
    return mergeLoginShellPath(login, interactive, delimiter);
  };

  return () => {
    if (answer !== null) return answer;
    if (now() < retryFailedAfter) return Promise.resolve(null);
    const pending = probe().catch(() => null);
    answer = pending;
    void pending.then((value) => {
      if (value !== null) return;
      answer = null;
      retryFailedAfter = now() + FAILED_PROBE_RETRY_MS;
    });
    return pending;
  };
}

let sharedProvider: (() => Promise<string | null>) | null = null;

export function getSharedLoginShellPathProvider(log: PinoLogger): () => Promise<string | null> {
  sharedProvider ??= createLoginShellPathProvider({ log });
  return sharedProvider;
}

export function resetSharedLoginShellPathProvider(): void {
  sharedProvider = null;
}
