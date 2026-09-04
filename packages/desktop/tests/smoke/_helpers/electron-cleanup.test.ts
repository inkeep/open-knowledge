import { type ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';
import { closeAppBounded } from './electron-cleanup';

const spawnedProcs: ChildProcess[] = [];

afterEach(() => {
  for (const proc of spawnedProcs) {
    if (
      proc.pid !== undefined &&
      !proc.killed &&
      proc.exitCode === null &&
      proc.signalCode === null
    ) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {}
    }
  }
  spawnedProcs.length = 0;
});

function spawnNode(body: string): ChildProcess {
  const proc = spawn('node', ['-e', body], {
    detached: true,
    stdio: 'ignore',
  });
  spawnedProcs.push(proc);
  return proc;
}

async function awaitSpawn(proc: ChildProcess): Promise<void> {
  if (proc.pid !== undefined) return;
  await new Promise<void>((resolve) => {
    proc.once('spawn', () => resolve());
  });
}

describe('closeAppBounded — real subprocess contract', () => {
  test('(a) graceful exit during gracefulMs wait → returns shortly after exit, no SIGKILL fired', async () => {
    const proc = spawnNode(`setTimeout(() => process.exit(0), 100);`);
    await awaitSpawn(proc);

    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | string }> = [];
    const spyKill = (pid: number, signal: NodeJS.Signals | string) => {
      killCalls.push({ pid, signal });
    };

    const start = Date.now();
    await closeAppBounded(proc, { gracefulMs: 5_000, kill: spyKill, platform: 'linux' });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1_500);
    expect(killCalls).toEqual([]);
    expect(proc.exitCode === 0 || proc.signalCode !== null).toBe(true);
  });

  test('(b) hung subprocess (traps + ignores SIGTERM) → returns within gracefulMs + slack, kill spy receives (-pid, SIGKILL)', async () => {
    const hangBody = `
      process.on('SIGTERM', () => { /* swallow */ });
      setInterval(() => {}, 1000);
    `;
    const proc = spawnNode(hangBody);
    await awaitSpawn(proc);
    const pid = proc.pid;
    if (pid === undefined) throw new Error('spawn did not assign pid');

    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | string }> = [];
    const spyKill = (killPid: number, signal: NodeJS.Signals | string) => {
      killCalls.push({ pid: killPid, signal });
    };

    const start = Date.now();
    await closeAppBounded(proc, { gracefulMs: 300, kill: spyKill, platform: 'linux' });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(3_000);

    expect(killCalls.length).toBe(1);
    expect(killCalls[0]).toEqual({ pid: -pid, signal: 'SIGKILL' });
  });

  test('(c) already-exited subprocess → closeAppBounded returns ~immediately, no kill fired', async () => {
    const proc = spawnNode(`process.exit(0);`);
    await awaitSpawn(proc);
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      proc.once('exit', () => resolve());
    });
    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);

    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | string }> = [];
    const spyKill = (pid: number, signal: NodeJS.Signals | string) => {
      killCalls.push({ pid, signal });
    };

    const start = Date.now();
    await closeAppBounded(proc, { gracefulMs: 5_000, kill: spyKill, platform: 'linux' });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(killCalls).toEqual([]);
  });
});
