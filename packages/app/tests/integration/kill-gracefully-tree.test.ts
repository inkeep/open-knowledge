import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { killGracefully } from '../stress/_helpers/server-process.ts';

const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const proc of spawned) {
    if (proc.pid !== undefined) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {}
    }
  }
  spawned.length = 0;
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw err;
  }
}

async function waitForChildPid(parentPid: number, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = execFileSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8' }).trim();
      if (out) return Number.parseInt(out.split('\n')[0] as string, 10);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    }
    await wait(50);
  }
  throw new Error(`no child of ${parentPid} appeared within ${timeoutMs}ms`);
}

function spawnTree(): ChildProcess {
  const proc = spawn('sh', ['-c', 'sleep 300; true'], {
    detached: true,
    stdio: 'ignore',
  });
  spawned.push(proc);
  return proc;
}

describe('killGracefully process-tree reaping', () => {
  test('kills both the direct child and its descendant', async () => {
    const proc = spawnTree();
    expect(proc.pid).toBeDefined();
    const childPid = await waitForChildPid(proc.pid as number);
    expect(isAlive(childPid)).toBe(true);

    await killGracefully(proc, 2_000);

    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
    const deadline = Date.now() + 2_000;
    while (isAlive(childPid) && Date.now() < deadline) {
      await wait(25);
    }
    expect(isAlive(childPid)).toBe(false);
  });

  test('sweeps surviving descendants when the direct child already exited', async () => {
    const proc = spawnTree();
    const parentPid = proc.pid as number;
    const childPid = await waitForChildPid(parentPid);

    process.kill(parentPid, 'SIGKILL');
    await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    expect(isAlive(childPid)).toBe(true);

    await killGracefully(proc, 2_000);

    const deadline = Date.now() + 2_000;
    while (isAlive(childPid) && Date.now() < deadline) {
      await wait(25);
    }
    expect(isAlive(childPid)).toBe(false);
  });

  test('escalates to SIGKILL when the tree ignores SIGTERM', async () => {
    const proc = spawn('sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], {
      detached: true,
      stdio: 'ignore',
    });
    spawned.push(proc);
    await waitForChildPid(proc.pid as number);

    await killGracefully(proc, 300);

    expect(proc.signalCode).toBe('SIGKILL');
    const pid = proc.pid as number;
    const deadline = Date.now() + 2_000;
    let groupGone = false;
    while (!groupGone && Date.now() < deadline) {
      try {
        process.kill(-pid, 0);
      } catch (err) {
        groupGone = (err as NodeJS.ErrnoException).code === 'ESRCH';
        if (!groupGone) throw err;
      }
      if (!groupGone) await wait(25);
    }
    expect(groupGone).toBe(true);
  });

  test('is a no-op on a fully-exited tree (no ESRCH escape)', async () => {
    const proc = spawn('sh', ['-c', 'true'], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    await killGracefully(proc, 500);
  });
});
