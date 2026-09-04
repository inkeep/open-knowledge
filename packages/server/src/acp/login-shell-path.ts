import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';
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

const spawnLoginShellProbe: RunLoginShellProbe = (shell, args, timeoutMs) =>
  new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, [...args], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolvePromise(null);
      return;
    }
    let out = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (out.length >= MAX_PROBE_STDOUT_BYTES) return;
      out += chunk;
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(out));
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
