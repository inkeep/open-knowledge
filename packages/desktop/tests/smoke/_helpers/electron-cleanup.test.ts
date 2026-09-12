import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AppCleanupIncompleteError,
  closeAppBounded,
  type TaskkillOutcome,
} from './electron-cleanup';
import { reapedTaskkill, timedOutTaskkill } from './electron-cleanup.test-helper';

const REAP_MS = 50;

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

  test('(b) hung subprocess and a kill spy that reaps nothing → every attempt targets (-pid, SIGKILL) and the call reports incomplete closure', async () => {
    const hangBody = `
      process.on('SIGTERM', () => {});
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

    await expect(
      closeAppBounded(proc, {
        gracefulMs: 300,
        postKillReapMs: REAP_MS,
        kill: spyKill,
        platform: 'linux',
      }),
    ).rejects.toBeInstanceOf(AppCleanupIncompleteError);

    expect(killCalls).toEqual([
      { pid: -pid, signal: 'SIGKILL' },
      { pid: -pid, signal: 'SIGKILL' },
    ]);
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

const HOLDER_SCRIPT = 'setInterval(() => {}, 1000);';
const HANG_FOREVER = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

function exitAfter(ms: number): string {
  return `setTimeout(() => process.exit(0), ${ms});`;
}

function rootScript(afterHolderSpawn: string): string {
  return [
    "const { spawn } = require('node:child_process');",
    `const holder = spawn(process.execPath, ['-e', ${JSON.stringify(HOLDER_SCRIPT)}], { stdio: 'inherit' });`,
    afterHolderSpawn,
    "process.stdout.write('HOLDER_PID=' + holder.pid + '\\n');",
  ].join('\n');
}

function psStat(pid: number): string {
  const res = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  if (res.error !== undefined) throw res.error;
  return (res.stdout ?? '').trim();
}

function isAlive(pid: number): boolean {
  const stat = psStat(pid);
  return stat.length > 0 && !stat.startsWith('Z');
}

interface StreamHeldTree {
  root: ChildProcess;
  rootPid: number;
  holderPid: number;
  closeObserved: () => boolean;
}

interface TrackedTree {
  rootPid: number;
  holderPid: number | undefined;
}

const liveTrees: TrackedTree[] = [];

afterEach(() => {
  for (const tracked of liveTrees) {
    try {
      process.kill(-tracked.rootPid, 'SIGKILL');
    } catch {}
    if (tracked.holderPid === undefined) continue;
    try {
      process.kill(tracked.holderPid, 'SIGKILL');
    } catch {}
  }
  liveTrees.length = 0;
});

async function spawnStreamHeldTree(afterHolderSpawn: string): Promise<StreamHeldTree> {
  const root = spawn(process.execPath, ['-e', rootScript(afterHolderSpawn)], {
    stdio: 'pipe',
    detached: true,
  });
  if (root.pid === undefined) await once(root, 'spawn');
  const rootPid = root.pid;
  if (rootPid === undefined) throw new Error('spawn did not assign a root pid');

  const tracked: TrackedTree = { rootPid, holderPid: undefined };
  liveTrees.push(tracked);

  let closeObserved = false;
  root.once('close', () => {
    closeObserved = true;
  });

  let stdout = '';
  root.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  root.stderr?.on('data', () => {});

  const holderPid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('root process never reported its stdio-holding descendant')),
      10_000,
    );
    const check = () => {
      const match = /HOLDER_PID=(\d+)/.exec(stdout);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      root.stdout?.off('data', check);
      resolve(Number(match[1]));
    };
    root.stdout?.on('data', check);
    check();
  });

  tracked.holderPid = holderPid;
  return { root, rootPid, holderPid, closeObserved: () => closeObserved };
}

describe.skipIf(process.platform === 'win32')(
  'closeAppBounded — close, not exit, is the postcondition',
  () => {
    test('(1) root exits on its own while a descendant still holds its stdio → returns only once the launched process closed', async () => {
      const tree = await spawnStreamHeldTree(exitAfter(150));

      await closeAppBounded(tree.root, { gracefulMs: 1_000, platform: 'linux' });

      expect({
        closeObserved: tree.closeObserved(),
        holderAlive: isAlive(tree.holderPid),
      }).toEqual({ closeObserved: true, holderAlive: false });
    });

    test('(2) hung root with a stdio-holding descendant → returns only once the group kill reached both and the launched process closed', async () => {
      const tree = await spawnStreamHeldTree(HANG_FOREVER);

      await closeAppBounded(tree.root, { gracefulMs: 500, platform: 'linux' });

      expect({
        closeObserved: tree.closeObserved(),
        rootAlive: isAlive(tree.rootPid),
        holderAlive: isAlive(tree.holderPid),
      }).toEqual({ closeObserved: true, rootAlive: false, holderAlive: false });
    });

    test('(3) win32 tree-kill reports ETIMEDOUT once and kills nothing, then succeeds → converges to real closure', async () => {
      const tree = await spawnStreamHeldTree(HANG_FOREVER);
      const attempts: TaskkillOutcome[] = [];

      const taskkill = async (pid: number): Promise<TaskkillOutcome> => {
        if (attempts.length === 0) {
          const timedOut = timedOutTaskkill();
          attempts.push(timedOut);
          return timedOut;
        }
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
        const reaped = reapedTaskkill(pid);
        attempts.push(reaped);
        return reaped;
      };

      await closeAppBounded(tree.root, { gracefulMs: 500, taskkill, platform: 'win32' });

      expect({
        closeObserved: tree.closeObserved(),
        rootAlive: isAlive(tree.rootPid),
        holderAlive: isAlive(tree.holderPid),
      }).toEqual({ closeObserved: true, rootAlive: false, holderAlive: false });
      expect(attempts.length).toBe(2);
    });

    test('(4) win32 tree-kill always reports ETIMEDOUT and kills nothing → never returns normally while the tree is still alive', async () => {
      const tree = await spawnStreamHeldTree(HANG_FOREVER);
      const attempts: number[] = [];

      const taskkill = async (pid: number): Promise<TaskkillOutcome> => {
        attempts.push(pid);
        return timedOutTaskkill();
      };

      const outcome = await closeAppBounded(tree.root, {
        gracefulMs: 500,
        postKillReapMs: REAP_MS,
        taskkill,
        platform: 'win32',
      }).then(
        () => 'returned' as const,
        (error: unknown) =>
          error instanceof AppCleanupIncompleteError ? ('reported-failure' as const) : 'threw',
      );

      const rootAlive = isAlive(tree.rootPid);
      const holderAlive = isAlive(tree.holderPid);

      expect({
        outcome,
        attemptedPids: attempts,
        claimedCleanupComplete: outcome === 'returned' && (rootAlive || holderAlive),
      }).toEqual({
        outcome: 'reported-failure',
        attemptedPids: [tree.rootPid, tree.rootPid],
        claimedCleanupComplete: false,
      });
    });

    test('(5) root already exited before the call while a descendant still holds its stdio → escalation still establishes closure', async () => {
      const tree = await spawnStreamHeldTree(exitAfter(50));
      if (tree.root.exitCode === null && tree.root.signalCode === null) {
        await once(tree.root, 'exit');
      }

      await closeAppBounded(tree.root, { gracefulMs: 1_000, platform: 'linux' });

      expect({
        closeObserved: tree.closeObserved(),
        holderAlive: isAlive(tree.holderPid),
      }).toEqual({ closeObserved: true, holderAlive: false });
    });

    test('(7) a piped process that already closed before the call → the structural fallback returns without a kill', async () => {
      const proc = spawn(process.execPath, ['-e', 'process.exit(0);'], {
        stdio: 'pipe',
        detached: true,
      });
      spawnedProcs.push(proc);
      proc.stdout?.on('data', () => {});
      proc.stderr?.on('data', () => {});
      await once(proc, 'close');

      const killCalls: number[] = [];
      const start = Date.now();
      await closeAppBounded(proc, {
        gracefulMs: 5_000,
        kill: (pid) => {
          killCalls.push(pid);
        },
        platform: 'linux',
      });

      expect({ elapsedUnder250ms: Date.now() - start < 250, killCalls }).toEqual({
        elapsedUnder250ms: true,
        killCalls: [],
      });
    });

    test('(6) a signal was sent but the root ignored it → `killed === true` alone is not closure', async () => {
      const tree = await spawnStreamHeldTree(HANG_FOREVER);
      tree.root.kill('SIGTERM');
      expect(tree.root.killed).toBe(true);
      expect(isAlive(tree.rootPid)).toBe(true);

      await closeAppBounded(tree.root, { gracefulMs: 500, platform: 'linux' });

      expect({
        closeObserved: tree.closeObserved(),
        rootAlive: isAlive(tree.rootPid),
        holderAlive: isAlive(tree.holderPid),
      }).toEqual({ closeObserved: true, rootAlive: false, holderAlive: false });
    });
  },
);
