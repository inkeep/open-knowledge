
import type { ChildProcess } from 'node:child_process';
import type { ElectronApplication } from '@playwright/test';

export interface CloseAppBoundedOpts {
  gracefulMs?: number;
  kill?: (pid: number, signal: NodeJS.Signals | string) => void;
}

export function captureAppProcess(app: ElectronApplication): ChildProcess {
  return app.process();
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
    try {
      killFn(-proc.pid, 'SIGKILL');
    } catch {
    }
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
