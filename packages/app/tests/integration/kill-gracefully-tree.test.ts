import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  installSignalBoundary,
  type SignalBoundary,
} from '../../../../test-support/held-signal-boundary.test-helper';
import { killGracefully } from '../stress/_helpers/server-process.ts';

const DESCENDANT_REPORT_BOUND_MS = 10_000;
const DESCENDANT_EXIT_BOUND_MS = 5_000;
const GROUP_EXIT_BOUND_MS = 2_000;

const DESCENDANT = `sh -c 'echo DESC=$$; exec cat <&3 >/dev/null'`;
const TERM_IGNORING_DESCENDANT = `sh -c 'trap "" TERM; echo DESC=$$; exec cat <&3 >/dev/null'`;

interface LifelineTree {
  proc: ChildProcess;
  output: () => string;
}

let boundary: SignalBoundary;
const trees: ChildProcess[] = [];

beforeEach(() => {
  boundary = installSignalBoundary({ deliverToHeldChildren: true });
});

afterEach(() => {
  for (const proc of trees) {
    if (proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {}
    }
    proc.stdio[3]?.destroy();
  }
  trees.length = 0;
  boundary.restore();
  vi.restoreAllMocks();
});

function spawnLifelineTree(script: string): LifelineTree {
  const proc = boundary.hold(
    spawn('sh', ['-c', script], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore', 'pipe'],
    }),
  );
  trees.push(proc);
  let output = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  return { proc, output: () => output };
}

function pidOf(proc: ChildProcess): number {
  if (proc.pid === undefined) throw new Error('the tree was spawned without a pid');
  return proc.pid;
}

async function awaitOutput(tree: LifelineTree, pattern: RegExp): Promise<RegExpExecArray> {
  const deadline = Date.now() + DESCENDANT_REPORT_BOUND_MS;
  while (Date.now() < deadline) {
    const match = pattern.exec(tree.output());
    if (match !== null) return match;
    await wait(25);
  }
  throw new Error(`the tree never printed ${pattern}; output so far: ${tree.output()}`);
}

async function reportedDescendant(tree: LifelineTree): Promise<number> {
  return Number((await awaitOutput(tree, /DESC=(\d+)/))[1]);
}

function isGroupMember(pid: number, pgid: number): boolean {
  const res = spawnSync('ps', ['-o', 'pgid=,stat=', '-p', String(pid)], { encoding: 'utf8' });
  const [group, stat] = (res.stdout ?? '').trim().split(/\s+/);
  return Number(group) === pgid && stat !== undefined && !stat.startsWith('Z');
}

async function until(predicate: () => boolean, boundMs: number): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await wait(25);
  }
  return true;
}

async function exited(proc: ChildProcess): Promise<void> {
  if (proc.exitCode === null && proc.signalCode === null) await once(proc, 'exit');
}

function captureConsoleText(): () => string {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  };
  vi.spyOn(console, 'warn').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  return () => lines.join('\n');
}

async function settle(run: () => Promise<void>): Promise<string> {
  try {
    await run();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function mentionsAny(text: string, pids: readonly number[]): boolean {
  return pids.some((pid) => new RegExp(`(^|\\D)${pid}(\\D|$)`).test(text));
}

describe('killGracefully signals only a tree whose leader it still holds', () => {
  test('stops a live tree through its group, then sends nothing once the leader has exited', async () => {
    const tree = spawnLifelineTree(`${DESCENDANT} & wait`);
    const leaderPid = pidOf(tree.proc);
    const descendantPid = await reportedDescendant(tree);
    expect(isGroupMember(descendantPid, leaderPid)).toBe(true);
    expect(process.kill).toBe(boundary.send);

    await killGracefully(tree.proc, GROUP_EXIT_BOUND_MS);

    expect({
      refused: boundary.refused,
      leaderExited: tree.proc.exitCode !== null || tree.proc.signalCode !== null,
      descendantGone: await until(
        () => !isGroupMember(descendantPid, leaderPid),
        DESCENDANT_EXIT_BOUND_MS,
      ),
    }).toEqual({ refused: [], leaderExited: true, descendantGone: true });
  });

  test('a descendant that outlives its already-exited leader is reaped or reported, never reached through the stale group id', async () => {
    const tree = spawnLifelineTree(`${DESCENDANT} & wait`);
    const leaderPid = pidOf(tree.proc);
    const descendantPid = await reportedDescendant(tree);
    tree.proc.kill('SIGKILL');
    await exited(tree.proc);
    expect(isGroupMember(descendantPid, leaderPid)).toBe(true);
    const consoleText = captureConsoleText();
    expect(process.kill).toBe(boundary.send);

    const failure = await settle(() => killGracefully(tree.proc, GROUP_EXIT_BOUND_MS));

    const reported = mentionsAny(`${consoleText()}\n${failure}`, [leaderPid, descendantPid]);
    expect({
      refused: boundary.refused,
      descendantReapedOrReported:
        reported ||
        (await until(() => !isGroupMember(descendantPid, leaderPid), DESCENDANT_EXIT_BOUND_MS)),
    }).toEqual({ refused: [], descendantReapedOrReported: true });
  });

  test('a descendant that ignores SIGTERM and outlives the leader SIGTERM stopped is reaped or reported, never reached through the stale group id', async () => {
    const tree = spawnLifelineTree(`${TERM_IGNORING_DESCENDANT} & wait`);
    const leaderPid = pidOf(tree.proc);
    const descendantPid = await reportedDescendant(tree);
    expect(isGroupMember(descendantPid, leaderPid)).toBe(true);
    const consoleText = captureConsoleText();
    expect(process.kill).toBe(boundary.send);

    const failure = await settle(() => killGracefully(tree.proc, GROUP_EXIT_BOUND_MS));

    const reported = mentionsAny(`${consoleText()}\n${failure}`, [leaderPid, descendantPid]);
    expect({
      refused: boundary.refused,
      leaderExited: tree.proc.exitCode !== null || tree.proc.signalCode !== null,
      descendantReapedOrReported:
        reported ||
        (await until(() => !isGroupMember(descendantPid, leaderPid), DESCENDANT_EXIT_BOUND_MS)),
    }).toEqual({ refused: [], leaderExited: true, descendantReapedOrReported: true });
  });

  test('escalates to SIGKILL while the leader is still held when the tree ignores SIGTERM', async () => {
    const tree = spawnLifelineTree('trap "" TERM; echo READY; while :; do sleep 1; done');
    const leaderPid = pidOf(tree.proc);
    await awaitOutput(tree, /READY/);
    expect(process.kill).toBe(boundary.send);

    await killGracefully(tree.proc, 300);

    expect(tree.proc.signalCode).toBe('SIGKILL');
    let groupGone = false;
    const deadline = Date.now() + GROUP_EXIT_BOUND_MS;
    while (!groupGone && Date.now() < deadline) {
      try {
        process.kill(-leaderPid, 0);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        groupGone = code === 'ESRCH';
        if (!groupGone && code !== 'EPERM') throw err;
      }
      if (!groupGone) await wait(25);
    }
    expect({ refused: boundary.refused, groupGone }).toEqual({ refused: [], groupGone: true });
  });

  test('sends nothing to the group of a tree that has fully exited', async () => {
    const tree = spawnLifelineTree('exit 0');
    await exited(tree.proc);
    expect(process.kill).toBe(boundary.send);

    await killGracefully(tree.proc, 500);

    expect(boundary.refused).toEqual([]);
  });

  test('reports no survivor when the leader exits on SIGTERM and its group drains', async () => {
    const tree = spawnLifelineTree(`${DESCENDANT} & wait`);
    const leaderPid = pidOf(tree.proc);
    const descendantPid = await reportedDescendant(tree);
    expect(isGroupMember(descendantPid, leaderPid)).toBe(true);
    const consoleText = captureConsoleText();
    expect(process.kill).toBe(boundary.send);

    const failure = await settle(() => killGracefully(tree.proc, DESCENDANT_REPORT_BOUND_MS));

    expect({
      leaderStoppedBy: tree.proc.signalCode,
      groupDrained: await until(
        () => !isGroupMember(descendantPid, leaderPid),
        DESCENDANT_EXIT_BOUND_MS,
      ),
      survivorReported: mentionsAny(`${consoleText()}\n${failure}`, [leaderPid, descendantPid]),
    }).toEqual({ leaderStoppedBy: 'SIGTERM', groupDrained: true, survivorReported: false });
  });
});
