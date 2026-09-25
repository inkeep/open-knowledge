import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  installSignalBoundary,
  type SignalBoundary,
} from '../../../../../test-support/held-signal-boundary.test-helper';
import {
  AppCleanupIncompleteError,
  type CloseAppBoundedOpts,
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

const HANG_FOREVER = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
const GRACEFUL_WAIT_THE_ROOT_EXITS_INSIDE_MS = 3_000;

function exitAfter(ms: number): string {
  return `setTimeout(() => process.exit(0), ${ms});`;
}

function rootScript(afterHolderSpawn: string, holderGroup: 'root' | 'own'): string {
  return [
    "const { spawn } = require('node:child_process');",
    `const holder = spawn('sh', ['-c', 'exec cat <&3'], { stdio: ['inherit', 'inherit', 'inherit', 3], detached: ${holderGroup === 'own'} });`,
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

const liveRoots: ChildProcess[] = [];
let boundary: SignalBoundary | undefined;

afterEach(() => {
  for (const root of liveRoots) {
    root.kill('SIGKILL');
    root.stdio[3]?.destroy();
  }
  liveRoots.length = 0;
});

async function spawnStreamHeldTree(
  afterHolderSpawn: string,
  holderGroup: 'root' | 'own' = 'root',
): Promise<StreamHeldTree> {
  const root = spawn(process.execPath, ['-e', rootScript(afterHolderSpawn, holderGroup)], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    detached: true,
  });
  liveRoots.push(root);
  boundary?.hold(root);
  if (root.pid === undefined) await once(root, 'spawn');
  const rootPid = root.pid;
  if (rootPid === undefined) throw new Error('spawn did not assign a root pid');

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

  return { root, rootPid, holderPid, closeObserved: () => closeObserved };
}

async function rootExited(tree: StreamHeldTree): Promise<void> {
  if (tree.root.exitCode === null && tree.root.signalCode === null) {
    await once(tree.root, 'exit');
  }
}

function settleClose(
  tree: StreamHeldTree,
  opts: CloseAppBoundedOpts,
): Promise<'returned' | 'reported-failure' | 'threw'> {
  return closeAppBounded(tree.root, opts).then(
    () => 'returned' as const,
    (error: unknown) =>
      error instanceof AppCleanupIncompleteError ? ('reported-failure' as const) : 'threw',
  );
}

describe.skipIf(process.platform === 'win32')(
  'closeAppBounded — close, not exit, is the postcondition',
  () => {
    beforeEach(() => {
      boundary = installSignalBoundary({ deliverToHeldChildren: true });
    });

    afterEach(() => {
      boundary?.restore();
      boundary = undefined;
    });

    function heldBoundary(): SignalBoundary {
      if (boundary === undefined || process.kill !== boundary.send) {
        throw new Error('the signal boundary is not installed; refusing to run code that signals');
      }
      return boundary;
    }

    test('(1) root exits on its own while a same-group descendant still holds its stdio → nothing is signalled once the root has exited, and closure is never claimed while the holder lives', async () => {
      const tree = await spawnStreamHeldTree(exitAfter(150));
      const signals = heldBoundary();
      const calledAt = Date.now();
      let rootExitedAt =
        tree.root.exitCode === null && tree.root.signalCode === null ? undefined : calledAt;
      tree.root.once('exit', () => {
        rootExitedAt ??= Date.now();
      });

      const outcome = await settleClose(tree, {
        gracefulMs: GRACEFUL_WAIT_THE_ROOT_EXITS_INSIDE_MS,
        postKillReapMs: REAP_MS,
        platform: 'linux',
      });

      expect({
        rootExitedInsideTheGracefulWait:
          rootExitedAt !== undefined &&
          rootExitedAt - calledAt < GRACEFUL_WAIT_THE_ROOT_EXITS_INSIDE_MS,
        refused: signals.refused,
        outcome: outcome === 'threw' ? 'threw' : 'settled',
        claimedCleanupComplete: outcome === 'returned' && isAlive(tree.holderPid),
      }).toEqual({
        rootExitedInsideTheGracefulWait: true,
        refused: [],
        outcome: 'settled',
        claimedCleanupComplete: false,
      });
    });

    test('(2) hung root with a stdio-holding descendant → returns only once the group kill reached both and the launched process closed', async () => {
      const tree = await spawnStreamHeldTree(HANG_FOREVER);
      const signals = heldBoundary();

      await closeAppBounded(tree.root, { gracefulMs: 500, platform: 'linux' });

      expect({
        refused: signals.refused,
        closeObserved: tree.closeObserved(),
        rootAlive: isAlive(tree.rootPid),
        holderAlive: isAlive(tree.holderPid),
      }).toEqual({ refused: [], closeObserved: true, rootAlive: false, holderAlive: false });
    });

    test('(3) win32 tree-kill reports ETIMEDOUT once and kills nothing, then succeeds → converges to real closure', async () => {
      const tree = await spawnStreamHeldTree(HANG_FOREVER);
      heldBoundary();
      const attempts: TaskkillOutcome[] = [];

      const taskkill = async (pid: number): Promise<TaskkillOutcome> => {
        if (attempts.length === 0) {
          const timedOut = timedOutTaskkill();
          attempts.push(timedOut);
          return timedOut;
        }
        tree.root.kill('SIGKILL');
        tree.root.stdio[3]?.destroy();
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
      heldBoundary();
      const attempts: number[] = [];

      const taskkill = async (pid: number): Promise<TaskkillOutcome> => {
        attempts.push(pid);
        return timedOutTaskkill();
      };

      const outcome = await settleClose(tree, {
        gracefulMs: 500,
        postKillReapMs: REAP_MS,
        taskkill,
        platform: 'win32',
      });

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

    test('(5) root already exited before the call while a same-group descendant still holds its stdio → nothing is signalled after the exit, and closure is never claimed while the holder lives', async () => {
      const tree = await spawnStreamHeldTree(exitAfter(50));
      await rootExited(tree);
      const signals = heldBoundary();

      const outcome = await settleClose(tree, {
        gracefulMs: 1_000,
        postKillReapMs: REAP_MS,
        platform: 'linux',
      });

      expect({
        refused: signals.refused,
        outcome: outcome === 'threw' ? 'threw' : 'settled',
        claimedCleanupComplete: outcome === 'returned' && isAlive(tree.holderPid),
      }).toEqual({ refused: [], outcome: 'settled', claimedCleanupComplete: false });
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
      const signals = heldBoundary();
      tree.root.kill('SIGTERM');
      expect(tree.root.killed).toBe(true);
      expect(isAlive(tree.rootPid)).toBe(true);

      await closeAppBounded(tree.root, { gracefulMs: 500, platform: 'linux' });

      expect({
        refused: signals.refused,
        closeObserved: tree.closeObserved(),
        rootAlive: isAlive(tree.rootPid),
        holderAlive: isAlive(tree.holderPid),
      }).toEqual({ refused: [], closeObserved: true, rootAlive: false, holderAlive: false });
    });

    test('(8) root exits while its stdio holder sits in a group of its own → nothing is signalled at the emptied root group, and closure is never claimed while the holder lives', async () => {
      const tree = await spawnStreamHeldTree(exitAfter(50), 'own');
      await rootExited(tree);
      const signals = heldBoundary();

      const outcome = await settleClose(tree, {
        gracefulMs: 300,
        postKillReapMs: REAP_MS,
        platform: 'linux',
      });

      expect({
        refused: signals.refused,
        outcome: outcome === 'threw' ? 'threw' : 'settled',
        claimedCleanupComplete: outcome === 'returned' && isAlive(tree.holderPid),
      }).toEqual({ refused: [], outcome: 'settled', claimedCleanupComplete: false });
    });
  },
);
