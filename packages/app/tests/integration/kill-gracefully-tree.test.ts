/**
 * killGracefully must reap the spawned process TREE, not just the direct
 * child. The e2e fixtures spawn `pnpm run dev` — a shim whose real server
 * (vite) is a descendant. SIGKILL is never relayed, so a shim-only kill
 * orphans a live Vite that keeps the port bound and its file-watchers on the
 * contentDir while teardown rmSyncs that directory under it — the
 * teardown/cleanup race behind the docs-open F0 hard-fail class (content-dir
 * subpaths vanishing mid-run for a live worker's server).
 *
 * The tree shape here mirrors the fixture's: a shell parent (stand-in for
 * the pnpm shim) with a long-lived child (stand-in for vite). `sh -c
 * 'sleep 300; true'` — the trailing `true` stops sh from exec-ing sleep
 * directly, forcing a real two-process tree.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { killGracefully } from '../stress/_helpers/server-process.ts';

// Best-effort sweep so an assertion failure BEFORE a test's killGracefully
// call cannot orphan a detached sleep tree for its full 300s.
const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const proc of spawned) {
    if (proc.pid !== undefined) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        /* tree already gone */
      }
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
    // EPERM means the pid exists but belongs to another user — alive.
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw err;
  }
}

/** Poll `pgrep -P <pid>` until the shell's child appears. */
async function waitForChildPid(parentPid: number, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = execFileSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8' }).trim();
      if (out) return Number.parseInt(out.split('\n')[0] as string, 10);
    } catch (err) {
      // pgrep exits 1 while no child exists yet; a missing binary is a real
      // environment problem and must fail loudly, not read as "no child".
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    }
    await wait(50);
  }
  throw new Error(`no child of ${parentPid} appeared within ${timeoutMs}ms`);
}

function spawnTree(): ChildProcess {
  const proc = spawn('sh', ['-c', 'sleep 300; true'], {
    // Mirrors the fixtures' spawn: own process group so the group-kill path
    // is the one under test.
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
    // The descendant must not survive as an orphan. Poll briefly: group
    // signal delivery is immediate, but give the scheduler a beat.
    const deadline = Date.now() + 2_000;
    while (isAlive(childPid) && Date.now() < deadline) {
      await wait(25);
    }
    expect(isAlive(childPid)).toBe(false);
  });

  test('sweeps surviving descendants when the direct child already exited', async () => {
    // Reproduces the shim-crashed-but-server-lives shape: kill only the
    // shell with a non-relayed SIGKILL, leaving the sleep orphaned in the
    // group, then assert killGracefully's early-exit path sweeps it.
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
    // `trap "" TERM` alone is not enough: group-SIGTERM would kill the inner
    // sleep, letting the script run to completion and exit cleanly without
    // ever forcing escalation. The respawn loop keeps the TERM-ignoring
    // shell alive past the timeout, so only the SIGKILL branch can end it.
    const proc = spawn('sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], {
      detached: true,
      stdio: 'ignore',
    });
    spawned.push(proc);
    await waitForChildPid(proc.pid as number);

    await killGracefully(proc, 300);

    expect(proc.signalCode).toBe('SIGKILL');
    // The whole group must be gone: kill(-pid, 0) reports ESRCH once the
    // last member (the current inner sleep) is reaped.
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
    // Must not throw — the group is gone and both kill paths report ESRCH.
    await killGracefully(proc, 500);
  });
});
