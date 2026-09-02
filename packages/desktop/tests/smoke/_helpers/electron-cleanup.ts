import type { ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';

export interface CloseAppBoundedOpts {
  gracefulMs?: number;
  kill?: (pid: number, signal: NodeJS.Signals | string) => void;
  taskkill?: (pid: number) => void;
  platform?: NodeJS.Platform;
}

const POST_KILL_REAP_MS = 2_000;

function taskkillTree(pid: number): void {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    timeout: 5_000,
  });
}

export function captureAppProcess(app: ElectronApplication): ChildProcess {
  return app.process();
}

const LOCK_SEARCH_DEPTH = 3;

function collectServerLockPids(dir: string, depth: number, out: number[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.ok') {
      try {
        const raw = readFileSync(join(dir, '.ok', 'local', 'server.lock'), 'utf8');
        const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
        if (typeof pid === 'number' && Number.isInteger(pid) && pid > 1) out.push(pid);
      } catch {}
      continue;
    }
    if (depth > 0) collectServerLockPids(join(dir, entry.name), depth - 1, out);
  }
}

export function reapDetachedServers(dirs: readonly string[]): void {
  const pids: number[] = [];
  for (const dir of dirs) collectServerLockPids(dir, LOCK_SEARCH_DEPTH, pids);
  for (const pid of new Set(pids)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

export async function closeAppBounded(
  proc: ChildProcess | null,
  opts: CloseAppBoundedOpts = {},
): Promise<void> {
  if (proc === null) return;

  if (isProcessGone(proc)) return;

  const gracefulMs = opts.gracefulMs ?? 5_000;

  await waitForExit(proc, gracefulMs);

  if (isProcessGone(proc)) return;

  const killFn = opts.kill ?? process.kill.bind(process);
  if (typeof proc.pid === 'number' && Number.isInteger(proc.pid) && proc.pid > 0) {
    if ((opts.platform ?? process.platform) === 'win32') {
      (opts.taskkill ?? taskkillTree)(proc.pid);
      await waitForExit(proc, Math.min(gracefulMs, POST_KILL_REAP_MS));
      return;
    }
    try {
      killFn(-proc.pid, 'SIGKILL');
    } catch {}
  }
}

function isProcessGone(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null || proc.killed === true;
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (isProcessGone(proc)) {
      resolve();
      return;
    }
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      proc.off('exit', settle);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(settle, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    proc.once('exit', settle);
  });
}
