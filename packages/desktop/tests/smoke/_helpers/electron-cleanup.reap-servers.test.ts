import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  installSignalBoundary,
  type SignalBoundary,
} from '../../../../../test-support/held-signal-boundary.test-helper';
import { DETACHED_SERVER_RELEASE_BOUND_MS, reapDetachedServers } from './electron-cleanup';

const PID_BEYOND_ANY_KERNEL_LIMIT = 4_194_319;
const SECOND_PID_BEYOND_ANY_KERNEL_LIMIT = 4_194_337;
const STAND_IN_LIFETIME_MS = 5_000;
const LOCK_READY_BOUND_MS = 20_000;
const REAP_LIVENESS_BOUND_MS = 120_000;

const STAND_IN_SERVER = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const [lockPath, logPath, lifetimeMs] = process.argv.slice(1);',
  'fs.mkdirSync(path.dirname(lockPath), { recursive: true });',
  "fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, hostname: 'stand-in', kind: 'interactive', port: 0, startedAt: new Date().toISOString() }));",
  'const release = (line) => {',
  "  fs.appendFileSync(logPath, line + '\\n');",
  '  try { fs.unlinkSync(lockPath); } catch {}',
  '  process.exit(0);',
  '};',
  "for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2']) process.on(name, () => release('signal:' + name));",
  "setTimeout(() => release('released'), Number(lifetimeMs));",
].join('\n');

const LIFELINE_STAND_IN_SERVER = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const [lockPath, logPath] = process.argv.slice(1);',
  'fs.mkdirSync(path.dirname(lockPath), { recursive: true });',
  "fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, hostname: 'stand-in', kind: 'interactive', port: 0, startedAt: new Date().toISOString() }));",
  'const release = (line) => {',
  "  try { fs.appendFileSync(logPath, line + '\\n'); } catch {}",
  "  try { if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid === process.pid) fs.unlinkSync(lockPath); } catch {}",
  '  process.exit(0);',
  '};',
  "for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2']) process.on(name, () => release('signal:' + name));",
  "process.stdin.on('end', () => release('lifeline-closed'));",
  'process.stdin.resume();',
].join('\n');

let root: string;
let boundary: SignalBoundary;
let standIns: ChildProcess[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-reap-servers-'));
  standIns = [];
  boundary = installSignalBoundary({ deliverToHeldChildren: false });
});

afterEach(async () => {
  boundary.restore();
  vi.restoreAllMocks();
  for (const standIn of standIns) {
    if (standIn.exitCode === null && standIn.signalCode === null) await once(standIn, 'exit');
  }
  rmSync(root, { recursive: true, force: true });
});

function seedLock(dir: string, lock: Record<string, unknown>): string {
  const local = join(dir, '.ok', 'local');
  mkdirSync(local, { recursive: true });
  const lockPath = join(local, 'server.lock');
  writeFileSync(lockPath, JSON.stringify(lock));
  return lockPath;
}

function settle(run: () => unknown): Promise<{ value: unknown; error: unknown }> {
  return Promise.resolve()
    .then(run)
    .then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
}

function spawnStandIn(lockPath: string, logPath: string): ChildProcess {
  const standIn = spawn(
    process.execPath,
    ['-e', STAND_IN_SERVER, lockPath, logPath, String(STAND_IN_LIFETIME_MS)],
    { stdio: 'ignore' },
  );
  standIns.push(standIn);
  return standIn;
}

async function waitForLockNaming(lockPath: string, pid: number): Promise<void> {
  const deadline = Date.now() + LOCK_READY_BOUND_MS;
  while (Date.now() < deadline) {
    if (existsSync(lockPath)) {
      try {
        if ((JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown }).pid === pid) return;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the stand-in server never wrote a lock naming pid ${pid} at ${lockPath}`);
}

function logLines(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
}

function captureConsoleText(): () => string[] {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  };
  vi.spyOn(console, 'warn').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  vi.spyOn(console, 'log').mockImplementation(record);
  return () => lines;
}

function describeOutcome(outcome: { value: unknown; error: unknown }): string {
  if (outcome.error !== undefined) {
    return outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
  }
  return outcome.value === undefined ? '' : JSON.stringify(outcome.value);
}

describe('reapDetachedServers — signals only what it holds', () => {
  test(
    'a server.lock naming a process this code never spawned draws no signal, at every depth the reaper searches',
    async () => {
      seedLock(root, {
        pid: PID_BEYOND_ANY_KERNEL_LIMIT,
        hostname: 'a-different-host.example',
        startedAt: '2001-01-01T00:00:00.000Z',
        kind: 'interactive',
        port: 1,
      });
      seedLock(join(root, 'a', 'b', 'c'), { pid: SECOND_PID_BEYOND_ANY_KERNEL_LIMIT });
      expect(process.kill).toBe(boundary.send);

      await settle(() => reapDetachedServers([root]));

      expect(boundary.refused).toEqual([]);
    },
    REAP_LIVENESS_BOUND_MS,
  );

  test(
    'a live process named by a server.lock is neither signalled nor assumed stopped: it stops on its own or the reaper reports it',
    async () => {
      const lockPath = join(root, '.ok', 'local', 'server.lock');
      const logPath = join(root, 'stand-in.log');
      const standIn = spawnStandIn(lockPath, logPath);
      if (standIn.pid === undefined) await once(standIn, 'spawn');
      const standInPid = standIn.pid;
      if (standInPid === undefined) throw new Error('the stand-in server never received a pid');
      await waitForLockNaming(lockPath, standInPid);
      expect(standIn.exitCode === null && standIn.signalCode === null).toBe(true);
      const consoleText = captureConsoleText();
      expect(process.kill).toBe(boundary.send);

      const outcome = await settle(() => reapDetachedServers([root]));

      const standInLogAtReturn = logLines(logPath);
      const exitedAtReturn = standIn.exitCode !== null || standIn.signalCode !== null;
      const reportText = [...consoleText(), describeOutcome(outcome)].join('\n');
      const reported = reportText.includes(String(standInPid)) || reportText.includes(lockPath);
      if (standIn.exitCode === null && standIn.signalCode === null) await once(standIn, 'exit');

      expect({
        refused: boundary.refused,
        signalsThatReachedTheStandIn: [
          ...logLines(logPath).filter((line) => line.startsWith('signal:')),
          ...(standIn.signalCode === null ? [] : [`signal:${standIn.signalCode}`]),
        ],
        stoppedOnItsOwnOrReported:
          standInLogAtReturn.includes('released') || exitedAtReturn || reported,
      }).toEqual({
        refused: [],
        signalsThatReachedTheStandIn: [],
        stoppedOnItsOwnOrReported: true,
      });
    },
    REAP_LIVENESS_BOUND_MS,
  );
});

function captureWarnings(): () => string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  });
  return () => lines;
}

function mentionsPid(text: string, pid: number): boolean {
  return new RegExp(`(^|\\D)${pid}(\\D|$)`).test(text);
}

function probeErrorCode(pid: number): string | undefined {
  try {
    process.kill(pid, 0);
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
}

describe('reapDetachedServers — reports what outlives the release bound, never signals it', () => {
  const lifelines: ChildProcess[] = [];

  afterEach(async () => {
    for (const standIn of lifelines) {
      standIn.stdin?.end();
      if (standIn.exitCode === null && standIn.signalCode === null) await once(standIn, 'exit');
    }
    lifelines.length = 0;
  });

  function spawnLifelineStandIn(lockPath: string, logPath: string): ChildProcess {
    const standIn = spawn(process.execPath, ['-e', LIFELINE_STAND_IN_SERVER, lockPath, logPath], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    lifelines.push(standIn);
    return standIn;
  }

  async function startLifelineStandIn(): Promise<{
    standIn: ChildProcess;
    standInPid: number;
    lockPath: string;
    logPath: string;
  }> {
    const lockPath = join(root, '.ok', 'local', 'server.lock');
    const logPath = join(root, 'stand-in.log');
    const standIn = spawnLifelineStandIn(lockPath, logPath);
    if (standIn.pid === undefined) await once(standIn, 'spawn');
    const standInPid = standIn.pid;
    if (standInPid === undefined) throw new Error('the stand-in server never received a pid');
    await waitForLockNaming(lockPath, standInPid);
    return { standIn, standInPid, lockPath, logPath };
  }

  function signalsThatReached(standIn: ChildProcess, logPath: string): string[] {
    return [
      ...logLines(logPath).filter((line) => line.startsWith('signal:')),
      ...(standIn.signalCode === null ? [] : [`signal:${standIn.signalCode}`]),
    ];
  }

  test(
    'a server.lock whose pid a probe reports as not running is stale: the reaper returns no survivor for it and warns nothing about it',
    async () => {
      const staleLockPaths = [
        seedLock(root, { pid: PID_BEYOND_ANY_KERNEL_LIMIT }),
        seedLock(join(root, 'a', 'b', 'c'), { pid: SECOND_PID_BEYOND_ANY_KERNEL_LIMIT }),
      ];
      const warnings = captureWarnings();
      expect(process.kill).toBe(boundary.send);

      const survivors = await reapDetachedServers([root]);

      expect({
        probes: [PID_BEYOND_ANY_KERNEL_LIMIT, SECOND_PID_BEYOND_ANY_KERNEL_LIMIT].map(
          probeErrorCode,
        ),
        survivors,
        warningsNamingAStaleLock: warnings().filter(
          (line) =>
            staleLockPaths.some((lockPath) => line.includes(lockPath)) ||
            mentionsPid(line, PID_BEYOND_ANY_KERNEL_LIMIT) ||
            mentionsPid(line, SECOND_PID_BEYOND_ANY_KERNEL_LIMIT),
        ),
        refused: boundary.refused,
      }).toEqual({
        probes: ['ESRCH', 'ESRCH'],
        survivors: [],
        warningsNamingAStaleLock: [],
        refused: [],
      });
    },
    REAP_LIVENESS_BOUND_MS,
  );

  test(
    'a live server that outlives the release bound is returned and warned with its pid and exact lock path, and is never signalled',
    async () => {
      const lockPath = join(root, '.ok', 'local', 'server.lock');
      const logPath = join(root, 'stand-in.log');
      const staleLockPath = seedLock(join(root, 'stale-project'), {
        pid: PID_BEYOND_ANY_KERNEL_LIMIT,
      });
      const standIn = spawnLifelineStandIn(lockPath, logPath);
      if (standIn.pid === undefined) await once(standIn, 'spawn');
      const standInPid = standIn.pid;
      if (standInPid === undefined) throw new Error('the stand-in server never received a pid');
      await waitForLockNaming(lockPath, standInPid);
      const warnings = captureWarnings();
      expect(process.kill).toBe(boundary.send);

      let survivors: unknown;
      let aliveWhenTheReaperReturned = false;
      try {
        survivors = await reapDetachedServers([root]);
        aliveWhenTheReaperReturned = standIn.exitCode === null && standIn.signalCode === null;
      } finally {
        standIn.stdin?.end();
      }
      if (standIn.exitCode === null && standIn.signalCode === null) await once(standIn, 'exit');

      expect({
        releaseBoundIsExported: typeof DETACHED_SERVER_RELEASE_BOUND_MS === 'number',
        aliveWhenTheReaperReturned,
        survivors,
        warnedWithPidAndLockPath: warnings().some(
          (line) => line.includes(lockPath) && mentionsPid(line, standInPid),
        ),
        staleLockReported: warnings().some(
          (line) => line.includes(staleLockPath) || mentionsPid(line, PID_BEYOND_ANY_KERNEL_LIMIT),
        ),
        refused: boundary.refused,
        signalsThatReachedTheStandIn: [
          ...logLines(logPath).filter((line) => line.startsWith('signal:')),
          ...(standIn.signalCode === null ? [] : [`signal:${standIn.signalCode}`]),
        ],
      }).toEqual({
        releaseBoundIsExported: true,
        aliveWhenTheReaperReturned: true,
        survivors: [{ lockPath, pid: standInPid }],
        warnedWithPidAndLockPath: true,
        staleLockReported: false,
        refused: [],
        signalsThatReachedTheStandIn: [],
      });
    },
    REAP_LIVENESS_BOUND_MS + DETACHED_SERVER_RELEASE_BOUND_MS,
  );

  test.each<[string, (lockText: string) => string]>([
    ['empty', () => ''],
    ['short of its last byte', (lockText) => lockText.slice(0, -1)],
  ])(
    'a live server whose lock reads %s mid-rewrite after the reaper collected it is still returned and warned as a survivor, and is never signalled',
    async (_torn, tear) => {
      const { standIn, standInPid, lockPath, logPath } = await startLifelineStandIn();
      const tornText = tear(readFileSync(lockPath, 'utf8'));
      const warnings = captureWarnings();
      expect(process.kill).toBe(boundary.send);

      let survivors: unknown;
      let probedBeforeTheTear = false;
      let lockTextWhenTheReaperReturned: string | undefined;
      let aliveWhenTheReaperReturned = false;
      try {
        const reaping = reapDetachedServers([root]);
        probedBeforeTheTear = boundary.probes.some((probe) => probe.target === standInPid);
        writeFileSync(lockPath, tornText);
        survivors = await reaping;
        lockTextWhenTheReaperReturned = readFileSync(lockPath, 'utf8');
        aliveWhenTheReaperReturned = standIn.exitCode === null && standIn.signalCode === null;
      } finally {
        standIn.stdin?.end();
      }
      if (standIn.exitCode === null && standIn.signalCode === null) await once(standIn, 'exit');

      expect({
        probedBeforeTheTear,
        lockTextWhenTheReaperReturned,
        aliveWhenTheReaperReturned,
        survivors,
        warnedWithPidAndLockPath: warnings().some(
          (line) => line.includes(lockPath) && mentionsPid(line, standInPid),
        ),
        refused: boundary.refused,
        signalsThatReachedTheStandIn: signalsThatReached(standIn, logPath),
      }).toEqual({
        probedBeforeTheTear: true,
        lockTextWhenTheReaperReturned: tornText,
        aliveWhenTheReaperReturned: true,
        survivors: [{ lockPath, pid: standInPid }],
        warnedWithPidAndLockPath: true,
        refused: [],
        signalsThatReachedTheStandIn: [],
      });
    },
    REAP_LIVENESS_BOUND_MS + DETACHED_SERVER_RELEASE_BOUND_MS,
  );

  test(
    'a lock that a server left torn when it exited is dropped once the probe finds no process: no survivor and no warning, though the lock stays on disk',
    async () => {
      const { standIn, standInPid, lockPath, logPath } = await startLifelineStandIn();
      const warnings = captureWarnings();
      expect(process.kill).toBe(boundary.send);

      let survivors: unknown;
      try {
        const reaping = reapDetachedServers([root]);
        writeFileSync(lockPath, '');
        standIn.stdin?.end();
        survivors = await reaping;
      } finally {
        standIn.stdin?.end();
      }
      if (standIn.exitCode === null && standIn.signalCode === null) await once(standIn, 'exit');

      expect({
        standInLog: logLines(logPath),
        lockLeftOnDisk: existsSync(lockPath),
        survivors,
        warningsNamingTheLock: warnings().filter(
          (line) => line.includes(lockPath) || mentionsPid(line, standInPid),
        ),
        refused: boundary.refused,
        signalsThatReachedTheStandIn: signalsThatReached(standIn, logPath),
      }).toEqual({
        standInLog: ['lifeline-closed'],
        lockLeftOnDisk: true,
        survivors: [],
        warningsNamingTheLock: [],
        refused: [],
        signalsThatReachedTheStandIn: [],
      });
    },
    REAP_LIVENESS_BOUND_MS + DETACHED_SERVER_RELEASE_BOUND_MS,
  );

  test(
    'a lock that reads empty mid-rewrite at the instant the reaper collects is still kept, and the live server it names once readable is returned and warned as a survivor, and never signalled',
    async () => {
      const { standIn, standInPid, lockPath, logPath } = await startLifelineStandIn();
      const lockText = readFileSync(lockPath, 'utf8');
      const warnings = captureWarnings();
      expect(process.kill).toBe(boundary.send);

      let survivors: unknown;
      let aliveWhenTheReaperReturned = false;
      try {
        writeFileSync(lockPath, '');
        const reaping = reapDetachedServers([root]);
        writeFileSync(lockPath, lockText);
        survivors = await reaping;
        aliveWhenTheReaperReturned = standIn.exitCode === null && standIn.signalCode === null;
      } finally {
        standIn.stdin?.end();
      }
      if (standIn.exitCode === null && standIn.signalCode === null) await once(standIn, 'exit');

      expect({
        aliveWhenTheReaperReturned,
        survivors,
        warnedWithPidAndLockPath: warnings().some(
          (line) => line.includes(lockPath) && mentionsPid(line, standInPid),
        ),
        refused: boundary.refused,
        signalsThatReachedTheStandIn: signalsThatReached(standIn, logPath),
      }).toEqual({
        aliveWhenTheReaperReturned: true,
        survivors: [{ lockPath, pid: standInPid }],
        warnedWithPidAndLockPath: true,
        refused: [],
        signalsThatReachedTheStandIn: [],
      });
    },
    REAP_LIVENESS_BOUND_MS + DETACHED_SERVER_RELEASE_BOUND_MS,
  );
});
