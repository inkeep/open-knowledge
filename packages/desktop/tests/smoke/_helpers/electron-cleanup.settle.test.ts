import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  installSignalBoundary,
  type SignalBoundary,
} from '../../../../../test-support/held-signal-boundary.test-helper';
import {
  AppCleanupIncompleteError,
  type CloseAppBoundedOpts,
  cleanupIncompleteReport,
  closeAppBounded,
  closeAppsThenAwaitServerRelease,
  type ServerLockRecord,
  SMOKE_SERVER_RELEASE_WINDOW_MS,
} from './electron-cleanup';
import { PACKAGED_SMOKE_SERVER_IDLE_SHUTDOWN_MS } from './launch-desktop';

const APP_PID = 4_194_327;
const GRACEFUL_MS = 50;
const REAP_MS = 250;
const SURVIVOR_WINDOW_MS = 400;
const STAND_IN_RELEASE_LIVENESS_BOUND_MS = 20_000;
const LOCK_READY_BOUND_MS = 20_000;
const WATCH_LIVENESS_BOUND_MS = 20_000;
const WATCH_INTERVAL_MS = 10;
const ROW_LIVENESS_BOUND_MS = 120_000;

const STAND_IN_SERVER = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const [lockPath, logPath] = process.argv.slice(1);',
  'fs.mkdirSync(path.dirname(lockPath), { recursive: true });',
  "fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, hostname: 'stand-in', kind: 'interactive', port: 0, startedAt: new Date().toISOString() }));",
  'const exitLeavingTheLock = (line) => {',
  "  try { fs.appendFileSync(logPath, line + '\\n'); } catch {}",
  '  process.exit(0);',
  '};',
  "for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2']) process.on(name, () => exitLeavingTheLock('signal:' + name));",
  "process.stdin.on('end', () => exitLeavingTheLock('lifeline-closed'));",
  'process.stdin.resume();',
].join('\n');

type CloseAndAwaitOutcome = Awaited<ReturnType<typeof closeAppsThenAwaitServerRelease>>;

type GroupKill = NonNullable<CloseAppBoundedOpts['kill']>;

interface AppDouble extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdio: { destroyed: boolean }[];
  closeEmitted: boolean;
}

function appHasExited(app: AppDouble): boolean {
  return app.exitCode !== null || app.signalCode !== null;
}

function closeOnceStdioIsShut(app: AppDouble): void {
  if (app.closeEmitted || !appHasExited(app)) return;
  if (app.stdio.some((slot) => !slot.destroyed)) return;
  app.closeEmitted = true;
  app.emit('close', app.exitCode, app.signalCode);
}

function appDouble(stdio: 'held-by-its-server' | 'its-own'): AppDouble {
  const app = new EventEmitter() as AppDouble;
  app.pid = APP_PID;
  app.exitCode = null;
  app.signalCode = null;
  app.closeEmitted = false;
  app.stdio =
    stdio === 'held-by-its-server'
      ? [{ destroyed: false }, { destroyed: false }, { destroyed: false }]
      : [];
  return app;
}

function releaseStdio(app: AppDouble): void {
  for (const slot of app.stdio) slot.destroyed = true;
  closeOnceStdioIsShut(app);
}

interface RecordedGroupKill {
  target: number;
  signal: NodeJS.Signals | string;
  whileHeld: boolean;
}

function groupKillRecorder(app: AppDouble): { sent: RecordedGroupKill[]; kill: GroupKill } {
  const sent: RecordedGroupKill[] = [];
  const kill: GroupKill = (target, signal) => {
    const whileHeld = !appHasExited(app);
    sent.push({ target, signal, whileHeld });
    if (!whileHeld) return;
    app.signalCode = signal as NodeJS.Signals;
    app.emit('exit', null, signal);
    closeOnceStdioIsShut(app);
  };
  return { sent, kill };
}

let root: string;
let boundary: SignalBoundary;
let standIns: ChildProcess[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-settle-servers-'));
  standIns = [];
  boundary = installSignalBoundary({ deliverToHeldChildren: false });
});

afterEach(async () => {
  boundary.restore();
  vi.restoreAllMocks();
  for (const standIn of standIns) {
    standIn.stdin?.end();
    if (standIn.exitCode === null && standIn.signalCode === null) await once(standIn, 'exit');
  }
  rmSync(root, { recursive: true, force: true });
});

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

async function startStandInServer(): Promise<{
  standIn: ChildProcess;
  pid: number;
  lockPath: string;
  logPath: string;
}> {
  const lockPath = join(root, '.ok', 'local', 'server.lock');
  const logPath = join(root, 'stand-in.log');
  const standIn = spawn(process.execPath, ['-e', STAND_IN_SERVER, lockPath, logPath], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  standIns.push(standIn);
  if (standIn.pid === undefined) await once(standIn, 'spawn');
  const pid = standIn.pid;
  if (pid === undefined) throw new Error('the stand-in server never received a pid');
  await waitForLockNaming(lockPath, pid);
  return { standIn, pid, lockPath, logPath };
}

function signalsThatReached(standIn: ChildProcess, logPath: string): string[] {
  const logged = existsSync(logPath)
    ? readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('signal:'))
    : [];
  return [...logged, ...(standIn.signalCode === null ? [] : [`signal:${standIn.signalCode}`])];
}

function probedSince(from: number | undefined, pid: number): boolean {
  return from !== undefined && boundary.probes.slice(from).some((probe) => probe.target === pid);
}

async function watchFor(condition: () => boolean, stopWatching: () => boolean): Promise<boolean> {
  const deadline = Date.now() + WATCH_LIVENESS_BOUND_MS;
  while (!condition()) {
    if (stopWatching() || Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
  }
  return true;
}

function whatTheCallReturned(outcome: { value: unknown; error: unknown }): unknown {
  if (outcome.error !== undefined) {
    return {
      threw: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    };
  }
  const value = outcome.value as Partial<CloseAndAwaitOutcome> | undefined;
  return {
    unclosed: value?.unclosed,
    survivors: value?.survivors,
    closedAfterServerRelease: value?.closedAfterServerRelease,
  };
}

function track(
  run: () => Promise<CloseAndAwaitOutcome>,
  sequence: string[],
): { settled: Promise<{ value: unknown; error: unknown }>; hasReturned: () => boolean } {
  let returned = false;
  const settled = Promise.resolve()
    .then(run)
    .then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    )
    .then((outcome) => {
      returned = true;
      sequence.push('call returned');
      return outcome;
    });
  return { settled, hasReturned: () => returned };
}

function observeApp(app: AppDouble, sequence: string[]): () => number | undefined {
  let probesWhenTheAppExited: number | undefined;
  app.once('exit', () => {
    probesWhenTheAppExited = boundary.probes.length;
    sequence.push('app exited');
  });
  app.once('close', () => {
    sequence.push('app closed');
  });
  return () => probesWhenTheAppExited;
}

describe('closeAppsThenAwaitServerRelease — closes the apps, waits for the servers under their dirs to release, then looks once more for each close', () => {
  test(
    "an app whose close can only follow its server's exit is closed once that server releases inside the window, and is not reported",
    async () => {
      expect(typeof closeAppsThenAwaitServerRelease).toBe('function');
      const { standIn, pid, logPath } = await startStandInServer();
      const app = appDouble('held-by-its-server');
      const sequence: string[] = [];
      const probesWhenTheAppExited = observeApp(app, sequence);
      standIn.once('exit', () => {
        sequence.push('server exited');
        releaseStdio(app);
      });
      const { sent, kill } = groupKillRecorder(app);
      expect(process.kill).toBe(boundary.send);

      const { settled, hasReturned } = track(
        () =>
          closeAppsThenAwaitServerRelease([app as unknown as ChildProcess], [root], {
            gracefulMs: GRACEFUL_MS,
            postKillReapMs: REAP_MS,
            serverReleaseWindowMs: STAND_IN_RELEASE_LIVENESS_BOUND_MS,
            kill,
            platform: 'linux',
          }),
        sequence,
      );
      let reaperWatchedTheLiveServerAfterTheAppDied = false;
      try {
        reaperWatchedTheLiveServerAfterTheAppDied = await watchFor(
          () => probedSince(probesWhenTheAppExited(), pid),
          hasReturned,
        );
      } finally {
        standIn.stdin?.end();
      }
      const outcome = await settled;
      if (standIn.exitCode === null && standIn.signalCode === null) await once(standIn, 'exit');

      expect({
        reaperWatchedTheLiveServerAfterTheAppDied,
        returned: whatTheCallReturned(outcome),
        sequence,
        groupKills: sent,
        refused: boundary.refused,
        signalsThatReachedTheStandIn: signalsThatReached(standIn, logPath),
      }).toEqual({
        reaperWatchedTheLiveServerAfterTheAppDied: true,
        returned: { unclosed: [], survivors: [], closedAfterServerRelease: [APP_PID] },
        sequence: ['app exited', 'server exited', 'app closed', 'call returned'],
        groupKills: [{ target: -APP_PID, signal: 'SIGKILL', whileHeld: true }],
        refused: [],
        signalsThatReachedTheStandIn: [],
      });
    },
    ROW_LIVENESS_BOUND_MS,
  );

  test(
    "a server that outlives the window is reported as a survivor and never signalled, and its app's unclosed failure is the one the first close attempt raised",
    async () => {
      expect(typeof closeAppsThenAwaitServerRelease).toBe('function');
      const { standIn, pid, lockPath, logPath } = await startStandInServer();
      const app = appDouble('held-by-its-server');
      const sequence: string[] = [];
      observeApp(app, sequence);
      standIn.once('exit', () => {
        sequence.push('server exited');
        releaseStdio(app);
      });
      const { sent, kill } = groupKillRecorder(app);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(process.kill).toBe(boundary.send);

      let outcome: { value: unknown; error: unknown };
      let sequenceWhenTheCallReturned: string[];
      let serverAliveWhenTheCallReturned: boolean;
      let firstPassFailure: unknown;
      try {
        outcome = await track(
          () =>
            closeAppsThenAwaitServerRelease([app as unknown as ChildProcess], [root], {
              gracefulMs: GRACEFUL_MS,
              postKillReapMs: REAP_MS,
              serverReleaseWindowMs: SURVIVOR_WINDOW_MS,
              kill,
              platform: 'linux',
            }),
          sequence,
        ).settled;
        sequenceWhenTheCallReturned = [...sequence];
        serverAliveWhenTheCallReturned = standIn.exitCode === null && standIn.signalCode === null;
        firstPassFailure = await closeAppBounded(app as unknown as ChildProcess, {
          gracefulMs: GRACEFUL_MS,
          postKillReapMs: REAP_MS,
          kill,
          platform: 'linux',
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
      } finally {
        standIn.stdin?.end();
      }
      if (standIn.exitCode === null && standIn.signalCode === null) await once(standIn, 'exit');
      const unclosed = (outcome.value as Partial<CloseAndAwaitOutcome> | undefined)?.unclosed;

      expect({
        returned: whatTheCallReturned(outcome),
        firstPassRaisedAnAppCleanupIncompleteError:
          firstPassFailure instanceof AppCleanupIncompleteError,
        unclosedIsThatSameFailure: unclosed?.length === 1 && unclosed[0] === firstPassFailure,
        serverAliveWhenTheCallReturned,
        sequenceWhenTheCallReturned,
        groupKills: sent,
        refused: boundary.refused,
        signalsThatReachedTheStandIn: signalsThatReached(standIn, logPath),
      }).toEqual({
        returned: {
          unclosed: [firstPassFailure],
          survivors: [{ lockPath, pid }],
          closedAfterServerRelease: [],
        },
        firstPassRaisedAnAppCleanupIncompleteError: true,
        unclosedIsThatSameFailure: true,
        serverAliveWhenTheCallReturned: true,
        sequenceWhenTheCallReturned: ['app exited', 'call returned'],
        groupKills: [{ target: -APP_PID, signal: 'SIGKILL', whileHeld: true }],
        refused: [],
        signalsThatReachedTheStandIn: [],
      });
    },
    ROW_LIVENESS_BOUND_MS,
  );

  test(
    'an app that closes on the group kill leaves nothing to look at again, and the call still returns only after its server released on its own',
    async () => {
      expect(typeof closeAppsThenAwaitServerRelease).toBe('function');
      const { standIn, pid, logPath } = await startStandInServer();
      const app = appDouble('its-own');
      const sequence: string[] = [];
      const probesWhenTheAppExited = observeApp(app, sequence);
      standIn.once('exit', () => {
        sequence.push('server exited');
      });
      const { sent, kill } = groupKillRecorder(app);
      expect(process.kill).toBe(boundary.send);

      const { settled, hasReturned } = track(
        () =>
          closeAppsThenAwaitServerRelease([app as unknown as ChildProcess], [root], {
            gracefulMs: GRACEFUL_MS,
            postKillReapMs: REAP_MS,
            serverReleaseWindowMs: STAND_IN_RELEASE_LIVENESS_BOUND_MS,
            kill,
            platform: 'linux',
          }),
        sequence,
      );
      let reaperWatchedTheLiveServerAfterTheAppDied = false;
      try {
        reaperWatchedTheLiveServerAfterTheAppDied = await watchFor(
          () => probedSince(probesWhenTheAppExited(), pid),
          hasReturned,
        );
      } finally {
        standIn.stdin?.end();
      }
      const outcome = await settled;
      if (standIn.exitCode === null && standIn.signalCode === null) await once(standIn, 'exit');

      expect({
        reaperWatchedTheLiveServerAfterTheAppDied,
        returned: whatTheCallReturned(outcome),
        sequence,
        groupKills: sent,
        refused: boundary.refused,
        signalsThatReachedTheStandIn: signalsThatReached(standIn, logPath),
      }).toEqual({
        reaperWatchedTheLiveServerAfterTheAppDied: true,
        returned: { unclosed: [], survivors: [], closedAfterServerRelease: [] },
        sequence: ['app exited', 'app closed', 'server exited', 'call returned'],
        groupKills: [{ target: -APP_PID, signal: 'SIGKILL', whileHeld: true }],
        refused: [],
        signalsThatReachedTheStandIn: [],
      });
    },
    ROW_LIVENESS_BOUND_MS,
  );

  test(
    'a close that arrives only after the server released is still admitted within the reap window',
    async () => {
      expect(typeof closeAppsThenAwaitServerRelease).toBe('function');
      const { standIn, pid, logPath } = await startStandInServer();
      const app = appDouble('held-by-its-server');
      const sequence: string[] = [];
      const probesWhenTheAppExited = observeApp(app, sequence);
      let probesWhenTheServerExited: number | undefined;
      standIn.once('exit', () => {
        probesWhenTheServerExited = boundary.probes.length;
        sequence.push('server exited');
      });
      const { sent, kill } = groupKillRecorder(app);
      expect(process.kill).toBe(boundary.send);

      const { settled, hasReturned } = track(
        () =>
          closeAppsThenAwaitServerRelease([app as unknown as ChildProcess], [root], {
            gracefulMs: GRACEFUL_MS,
            postKillReapMs: REAP_MS,
            serverReleaseWindowMs: STAND_IN_RELEASE_LIVENESS_BOUND_MS,
            kill,
            platform: 'linux',
          }),
        sequence,
      );
      let reaperWatchedTheLiveServerAfterTheAppDied = false;
      let reaperLookedAgainAfterTheServerExited = false;
      try {
        reaperWatchedTheLiveServerAfterTheAppDied = await watchFor(
          () => probedSince(probesWhenTheAppExited(), pid),
          hasReturned,
        );
        standIn.stdin?.end();
        reaperLookedAgainAfterTheServerExited = await watchFor(
          () => probedSince(probesWhenTheServerExited, pid),
          hasReturned,
        );
      } finally {
        standIn.stdin?.end();
        releaseStdio(app);
      }
      const outcome = await settled;
      if (standIn.exitCode === null && standIn.signalCode === null) await once(standIn, 'exit');

      expect({
        reaperWatchedTheLiveServerAfterTheAppDied,
        reaperLookedAgainAfterTheServerExited,
        returned: whatTheCallReturned(outcome),
        sequence,
        groupKills: sent,
        refused: boundary.refused,
        signalsThatReachedTheStandIn: signalsThatReached(standIn, logPath),
      }).toEqual({
        reaperWatchedTheLiveServerAfterTheAppDied: true,
        reaperLookedAgainAfterTheServerExited: true,
        returned: { unclosed: [], survivors: [], closedAfterServerRelease: [APP_PID] },
        sequence: ['app exited', 'server exited', 'app closed', 'call returned'],
        groupKills: [{ target: -APP_PID, signal: 'SIGKILL', whileHeld: true }],
        refused: [],
        signalsThatReachedTheStandIn: [],
      });
    },
    ROW_LIVENESS_BOUND_MS,
  );

  test(
    'a server whose lock reads empty mid-rewrite while the reaper watches it is still waited for, so its app closes once that server releases and is not reported',
    async () => {
      expect(typeof closeAppsThenAwaitServerRelease).toBe('function');
      const { standIn, pid, lockPath, logPath } = await startStandInServer();
      const app = appDouble('held-by-its-server');
      const sequence: string[] = [];
      const probesWhenTheAppExited = observeApp(app, sequence);
      standIn.once('exit', () => {
        sequence.push('server exited');
        releaseStdio(app);
      });
      const { sent, kill } = groupKillRecorder(app);
      expect(process.kill).toBe(boundary.send);

      const { settled, hasReturned } = track(
        () =>
          closeAppsThenAwaitServerRelease([app as unknown as ChildProcess], [root], {
            gracefulMs: GRACEFUL_MS,
            postKillReapMs: REAP_MS,
            serverReleaseWindowMs: STAND_IN_RELEASE_LIVENESS_BOUND_MS,
            kill,
            platform: 'linux',
          }),
        sequence,
      );
      let reaperWatchedTheLiveServerAfterTheAppDied = false;
      let reaperProbedTheServerAgainAfterTheTear = false;
      try {
        reaperWatchedTheLiveServerAfterTheAppDied = await watchFor(
          () => probedSince(probesWhenTheAppExited(), pid),
          hasReturned,
        );
        writeFileSync(lockPath, '');
        const probesWhenTheLockWasTorn = boundary.probes.length;
        reaperProbedTheServerAgainAfterTheTear = await watchFor(
          () => probedSince(probesWhenTheLockWasTorn, pid),
          hasReturned,
        );
      } finally {
        standIn.stdin?.end();
      }
      const outcome = await settled;
      if (standIn.exitCode === null && standIn.signalCode === null) await once(standIn, 'exit');

      expect({
        reaperWatchedTheLiveServerAfterTheAppDied,
        reaperProbedTheServerAgainAfterTheTear,
        returned: whatTheCallReturned(outcome),
        sequence,
        groupKills: sent,
        refused: boundary.refused,
        signalsThatReachedTheStandIn: signalsThatReached(standIn, logPath),
      }).toEqual({
        reaperWatchedTheLiveServerAfterTheAppDied: true,
        reaperProbedTheServerAgainAfterTheTear: true,
        returned: { unclosed: [], survivors: [], closedAfterServerRelease: [APP_PID] },
        sequence: ['app exited', 'server exited', 'app closed', 'call returned'],
        groupKills: [{ target: -APP_PID, signal: 'SIGKILL', whileHeld: true }],
        refused: [],
        signalsThatReachedTheStandIn: [],
      });
    },
    ROW_LIVENESS_BOUND_MS,
  );

  test('the window the teardown gives servers to release outlasts the lifetime a packaged launch gives each server', () => {
    expect({
      windowIsExported: typeof SMOKE_SERVER_RELEASE_WINDOW_MS === 'number',
      lifetimeIsExported: typeof PACKAGED_SMOKE_SERVER_IDLE_SHUTDOWN_MS === 'number',
      windowOutlastsTheLifetime:
        SMOKE_SERVER_RELEASE_WINDOW_MS > PACKAGED_SMOKE_SERVER_IDLE_SHUTDOWN_MS,
    }).toEqual({
      windowIsExported: true,
      lifetimeIsExported: true,
      windowOutlastsTheLifetime: true,
    });
  });
});

function mentionsPid(text: string, pid: number): boolean {
  return new RegExp(`(^|\\D)${pid}(\\D|$)`).test(text);
}

describe('cleanupIncompleteReport — the app-cleanup-incomplete attachment body', () => {
  const survivingServers = [
    {
      lockPath: join(tmpdir(), 'ok-smoke-report', 'consent', '.ok', 'local', 'server.lock'),
      pid: 4_194_319,
    },
    {
      lockPath: join(tmpdir(), 'ok-smoke-report', 'create-new', 'a', '.ok', 'local', 'server.lock'),
      pid: 41_943,
    },
  ] satisfies ServerLockRecord[];

  function unclosedApps(): Error[] {
    const exited = appDouble('held-by-its-server');
    exited.exitCode = 0;
    return [
      new AppCleanupIncompleteError(
        exited as unknown as ChildProcess,
        [{ lever: 'leader-exited', elapsedMs: 0 }],
        GRACEFUL_MS,
      ),
      new Error('app pid 4194333 did not close'),
    ];
  }

  test('there is nothing to report when every app closed and no server outlived the window', () => {
    expect(typeof cleanupIncompleteReport).toBe('function');
    expect({
      reportIsExported: typeof cleanupIncompleteReport === 'function',
      body: cleanupIncompleteReport([], []),
    }).toStrictEqual({
      reportIsExported: true,
      body: undefined,
    });
  });

  test.each<[string, 'unclosed' | 'survivors' | 'both']>([
    ['an app did not close', 'unclosed'],
    ['a server outlived the window', 'survivors'],
    ['both happened', 'both'],
  ])(
    "the body carries every unclosed app's failure and names every surviving server by pid and exact lock path when %s",
    (_case, which) => {
      const unclosed = which === 'survivors' ? [] : unclosedApps();
      const survivors = which === 'unclosed' ? [] : survivingServers;
      expect(typeof cleanupIncompleteReport).toBe('function');
      const body = cleanupIncompleteReport(unclosed, survivors);

      expect({
        reportIsExported: typeof cleanupIncompleteReport === 'function',
        bodyIsText: typeof body === 'string',
        unclosedFailuresCarried: unclosed.map((error) => body?.includes(error.message) === true),
        survivorsNamed: survivors.map(
          (server) =>
            body !== undefined && mentionsPid(body, server.pid) && body.includes(server.lockPath),
        ),
      }).toEqual({
        reportIsExported: true,
        bodyIsText: true,
        unclosedFailuresCarried: unclosed.map(() => true),
        survivorsNamed: survivors.map(() => true),
      });
    },
  );

  test('a server lock that never yields a readable pid within the release window is named in the warning and the body by its exact path alone, and nothing is probed or signalled', async () => {
    const local = join(root, '.ok', 'local');
    mkdirSync(local, { recursive: true });
    const lockPath = join(local, 'server.lock');
    writeFileSync(lockPath, '');
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    expect(process.kill).toBe(boundary.send);

    const outcome = await track(
      () =>
        closeAppsThenAwaitServerRelease([], [root], {
          gracefulMs: GRACEFUL_MS,
          postKillReapMs: REAP_MS,
          serverReleaseWindowMs: SURVIVOR_WINDOW_MS,
        }),
      [],
    ).settled;
    const value = outcome.value as CloseAndAwaitOutcome | undefined;
    const body =
      value === undefined ? undefined : cleanupIncompleteReport(value.unclosed, value.survivors);

    expect({
      returned: whatTheCallReturned(outcome),
      lockNamedInAWarning: warnings.some((line) => line.includes(lockPath)),
      bodyNamesTheLock: body?.includes(lockPath) === true,
      textThatPrintsAnAbsentPid: [...warnings, ...(body === undefined ? [] : [body])].filter(
        (text) => text.includes('undefined'),
      ),
      probes: boundary.probes,
      refused: boundary.refused,
    }).toEqual({
      returned: {
        unclosed: [],
        survivors: [{ lockPath, pid: undefined }],
        closedAfterServerRelease: [],
      },
      lockNamedInAWarning: true,
      bodyNamesTheLock: true,
      textThatPrintsAnAbsentPid: [],
      probes: [],
      refused: [],
    });
  });
});
