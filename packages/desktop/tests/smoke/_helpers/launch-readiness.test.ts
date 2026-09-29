import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WaterfallPhase } from '../../../src/main/startup-waterfall.ts';
import {
  BOOT_HEARTBEAT_ABANDONED_SUFFIX,
  BOOT_HEARTBEAT_EVENTS,
  BOOT_HEARTBEAT_MAX_BEATS,
  DESKTOP_BOOT_EVENT,
  DESKTOP_OPEN_PROJECT_FAILED_EVENT,
  isBootHeartbeatEvent,
  isStartupMarkEvent,
  SPAWN_STARTUP_DEADLINE_MS,
  SPAWN_WAIT_EXTENSION_FACTOR,
  SPAWN_WAIT_HEARTBEAT_MS,
  startupMarkLine,
  UTILITY_INIT_PHASES,
  UTILITY_INIT_TIMEOUT_MS,
  UTILITY_WAIT_EXPIRED_EVENT,
  UTILITY_WAIT_EXTENDED_EVENT,
  UTILITY_WAIT_LATE_KILL_EVENT,
  utilityInitPhaseEvent,
} from '../../../src/shared/boot-narration.ts';
import {
  BOOT_LOG_CAP_MS,
  BOOT_LOG_HEARTBEAT_MS,
  BOOT_LOG_POLL_MS,
  BOOT_LOG_STALL_MS,
  type BootLogSnapshot,
  bootGapLineFor,
  bootGapSourceFor,
  bootLogDirFor,
  bootLogGapSummary,
  bootNarrationFor,
  classifyBootLog,
  DECLARED_UTILITY_BUDGET_CEILING_MS,
  describeMissingBootLog,
  EVERY_STARTUP_PHASE,
  formatBootGapLine,
  giveUpReason,
  hasBootCompleted,
  isMoreCompleteNarration,
  lastAdvancementMs,
  launchAdvancementPhases,
  launchDesktopApp,
  launchHomeFor,
  parseDeclaredPhaseBudget,
  READY_WAIT_GIVE_UP_REASONS,
  type ReadyDeadline,
  type ReadyWaitRecord,
  readBootLog,
  readBootLogLines,
  readinessWorstCaseMs,
  readyWaitsFor,
  rememberLaunchHome,
  sinceLastAdvancementMs,
  tryBootLogFor,
  tryFirstWaitFor,
  UTILITY_TIMEOUT_OBSERVATION_MARGIN_MS,
  type WindowMode,
  waitForReadySignal,
  waitForWindowByMode,
} from './launch-readiness.ts';
import {
  type GiveUp,
  giveUpOf,
  LAUNCH_REACHING_THE_CEILING_OF,
  launchBootingAfterTheWaitsFirstRead,
  launchBootingAfterTheWaitsFirstReadBesideTheDayBeforesLog,
  pollIntervalOf,
  READINESS_CALLS,
  READINESS_PATHS,
  reachOf,
  utilityForkBootingAfterTheWaitsFirstRead,
  utilityForkTheLastStageKeptAlive,
  utilityForkTheLastStageKeptAliveBesideTheDayBeforesLog,
  utilityForkWhoseFirstBeatLandsOnTheLastStagePoll,
} from './readiness-reach.test-helper.ts';

function markLine(phase: WaterfallPhase, elapsedMs: number, time: string): string {
  return JSON.stringify({ time, ...startupMarkLine(phase, elapsedMs) });
}

function seedHome(lines: string[] = []): string {
  const home = mkdtempSync(join(tmpdir(), 'ok-readiness-'));
  if (lines.length > 0) {
    const dir = bootLogDirFor(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'desktop.2026-09-03.log'), `${lines.join('\n')}\n`, 'utf8');
  }
  return home;
}

function snapshot(over: Partial<BootLogSnapshot> = {}): BootLogSnapshot {
  return {
    dir: '/tmp/x/.ok/logs',
    exists: true,
    fileCount: 1,
    unreadableReason: undefined,
    unreadableFiles: [],
    lines: [],
    lineCount: 0,
    lastEvent: undefined,
    tail: '',
    ...over,
  };
}

describe('readBootLog', () => {
  it('reports absent when the app never wrote a log', () => {
    const snap = readBootLog(seedHome());
    expect(snap.exists).toBe(false);
    expect(snap.lineCount).toBe(0);
    expect(snap.lastEvent).toBeUndefined();
  });

  it('names the boot phase the app actually emitted, not the record type', () => {
    const snap = readBootLog(
      seedHome([
        JSON.stringify({ event: 'desktop.boot', version: '1.2.3' }),
        markLine('serverSpawned', 8_500, '2026-09-04T00:00:08.500Z'),
      ]),
    );
    expect(snap.exists).toBe(true);
    expect(snap.lineCount).toBe(2);
    expect(snap.lastEvent).toBe('desktop.startup.serverSpawned');
  });

  it('skips unparseable trailing lines when naming the last event', () => {
    const snap = readBootLog(
      seedHome([
        markLine('serverLockReady', 25_500, '2026-09-04T00:00:25.500Z'),
        'not-json-at-all',
      ]),
    );
    expect(snap.lastEvent).toBe('desktop.startup.serverLockReady');
  });

  it('exposes the same lines readBootLogLines returns, from one scan', () => {
    const home = seedHome([
      JSON.stringify({ event: DESKTOP_BOOT_EVENT }),
      markLine('appReady', 0, '2026-09-04T00:00:00.000Z'),
    ]);
    expect(readBootLogLines(home)).toEqual(readBootLog(home).lines);
    expect(readBootLogLines(home)).toHaveLength(2);
  });

  it('separates "present but empty" from "the app never logged"', () => {
    const home = seedHome([]);
    mkdirSync(bootLogDirFor(home), { recursive: true });
    writeFileSync(join(bootLogDirFor(home), 'desktop.2026-09-03.log'), '', 'utf8');
    const snap = readBootLog(home);
    expect(snap.exists).toBe(true);
    expect(snap.fileCount).toBe(1);
    expect(snap.lineCount).toBe(0);
  });
});

describe('waitForReadySignal — progress gating', () => {
  it('returns as soon as the probe resolves', async () => {
    const found = await waitForReadySignal<string>({
      probe: async () => 'editor-page',
      home: '/unused',
      what: 'editor window',
      readLog: () => snapshot(),
      now: () => 0,
      sleep: async () => {},
    });
    expect(found).toBe('editor-page');
  });

  it('keeps waiting while the app is still logging progress, well past the stall bound', async () => {
    let clock = 0;
    let ticks = 0;
    const found = await waitForReadySignal<string>({
      probe: async () => (clock >= BOOT_LOG_CAP_MS - 2_000 ? 'editor-page' : undefined),
      home: '/unused',
      what: 'editor window',
      now: () => clock,
      sleep: async () => {
        clock += 1_000;
        ticks += 1;
      },
      readLog: () => snapshot({ lineCount: ticks, lastEvent: 'serverSpawned' }),
    });
    expect(found).toBe('editor-page');
    expect(clock).toBeGreaterThan(BOOT_LOG_STALL_MS);
  });

  it('gives up long before the cap when the app logs nothing new', async () => {
    let clock = 0;
    await expect(
      waitForReadySignal<string>({
        probe: async () => undefined,
        home: '/unused',
        what: 'editor window',
        now: () => clock,
        sleep: async () => {
          clock += 1_000;
        },
        readLog: () => snapshot({ lineCount: 3, lastEvent: 'desktop.boot' }),
      }),
    ).rejects.toThrow(/logged no new boot activity/);
    expect(clock).toBeLessThan(BOOT_LOG_CAP_MS);
    expect(clock).toBeLessThanOrEqual(BOOT_LOG_STALL_MS + 1_000);
  });

  it('still names the first window as the end of narration when no window has been shown', async () => {
    let clock = 0;
    const message = await waitForReadySignal<string>({
      probe: async () => undefined,
      home: '/unused',
      what: 'editor window',
      now: () => clock,
      sleep: async () => {
        clock += 1_000;
      },
      readLog: () => snapshot({ lineCount: 3, lastEvent: 'desktop.boot' }),
    }).then(
      () => 'the wait resolved instead of giving up',
      (error: unknown) => (error as Error).message,
    );
    expect(message).toContain('until the first window is shown');
    expect(message).not.toContain('while a startup phase it declared is still open');
  });

  it('names the boot phase and the log tail when it gives up', async () => {
    let clock = 0;
    await expect(
      waitForReadySignal<string>({
        probe: async () => undefined,
        home: '/unused',
        what: 'editor window',
        now: () => clock,
        sleep: async () => {
          clock += 1_000;
        },
        readLog: () =>
          snapshot({
            lineCount: 1,
            lastEvent: 'spawn-lock-timeout',
            tail: '{"event":"spawn-lock-timeout"}',
          }),
      }),
    ).rejects.toThrow(/spawn-lock-timeout/);
  });

  it('says the log is missing when the app never logged at all', async () => {
    let clock = 0;
    await expect(
      waitForReadySignal<string>({
        probe: async () => undefined,
        home: '/unused',
        what: 'editor window',
        now: () => clock,
        sleep: async () => {
          clock += 1_000;
        },
        readLog: () => snapshot({ exists: false }),
      }),
    ).rejects.toThrow(
      'Boot log: /tmp/x/.ok/logs (NOT FOUND, the cause is not determined here (it may have been removed, never written, or written elsewhere))',
    );
  });

  it('says the log cannot explain the wait, rather than blaming the app, on the stall path', async () => {
    let guardClock = 0;
    const error = await waitForReadySignal<string>({
      probe: async () => undefined,
      home: '/unused',
      what: 'editor window',
      now: () => guardClock,
      sleep: async () => {
        guardClock += 1_000;
      },
      readLog: () => snapshot({ exists: false }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('and the boot log cannot say why');
    expect((error as Error).message).not.toContain('stopped making progress');
    expect(guardClock).toBe(BOOT_LOG_STALL_MS);
  });

  it('stops at the absolute cap even while progress keeps arriving', async () => {
    let clock = 0;
    let ticks = 0;
    await expect(
      waitForReadySignal<string>({
        probe: async () => undefined,
        home: '/unused',
        what: 'editor window',
        now: () => clock,
        sleep: async () => {
          clock += 1_000;
          ticks += 1;
        },
        readLog: () => snapshot({ lineCount: ticks }),
      }),
    ).rejects.toThrow(/kept logging boot activity/);
    expect(clock).toBeGreaterThanOrEqual(BOOT_LOG_CAP_MS);
  });

  it('surfaces the last probe error instead of swallowing it', async () => {
    let clock = 0;
    await expect(
      waitForReadySignal<string>({
        probe: async () => {
          throw new Error('Execution context was destroyed');
        },
        home: '/unused',
        what: 'editor window',
        now: () => clock,
        sleep: async () => {
          clock += 1_000;
        },
        readLog: () => snapshot({ lineCount: 1 }),
      }),
    ).rejects.toThrow(/Execution context was destroyed/);
  });

  it('still reports a probe error that stopped throwing before the deadline', async () => {
    let clock = 0;
    await expect(
      waitForReadySignal<string>({
        probe: async () => {
          if (clock < 5_000) throw new Error('Execution context was destroyed');
          return undefined;
        },
        home: '/unused',
        what: 'editor window',
        now: () => clock,
        sleep: async () => {
          clock += 1_000;
        },
        readLog: () => snapshot({ lineCount: 1 }),
      }),
    ).rejects.toThrow(/Probe threw on 5 of \d+ polls; last: Execution context was destroyed/);
  });

  it('says plainly when the probe never threw, so absence is not read as evidence', async () => {
    let clock = 0;
    await expect(
      waitForReadySignal<string>({
        probe: async () => undefined,
        home: '/unused',
        what: 'editor window',
        now: () => clock,
        sleep: async () => {
          clock += 1_000;
        },
        readLog: () => snapshot({ lineCount: 1 }),
      }),
    ).rejects.toThrow(/Probe errors: none on any poll\./);
  });

  it("liveness 'none' waits out a post-boot silence the stall rule would have failed", async () => {
    let clock = 0;
    const found = await waitForReadySignal<string>({
      probe: async () => (clock >= 20_000 ? 'terminal-page' : undefined),
      home: '/unused',
      what: 'terminal window',
      liveness: 'none',
      capMs: BOOT_LOG_CAP_MS,
      now: () => clock,
      sleep: async () => {
        clock += 1_000;
      },
      readLog: () => snapshot({ lineCount: 7, lastEvent: 'desktop.startup.windowShown' }),
    });
    expect(found).toBe('terminal-page');
    expect(clock).toBeGreaterThan(BOOT_LOG_STALL_MS);
  });
});

describe('waitForWindowByMode', () => {
  it('returns the page whose renderer reports the requested mode', async () => {
    const editor = { evaluate: async () => 'editor' };
    const navigator = { evaluate: async () => 'navigator' };
    const found = await waitForWindowByMode({ windows: () => [navigator, editor] }, 'editor', {
      home: '/unused',
    });
    expect(found).toBe(editor);
  });

  it('keeps scanning past a page that throws, and finds a later match', async () => {
    const broken = {
      evaluate: async (): Promise<string | undefined> => {
        throw new Error('Target closed');
      },
    };
    const editor = { evaluate: async () => 'editor' };
    const found = await waitForWindowByMode({ windows: () => [broken, editor] }, 'editor', {
      home: '/unused',
    });
    expect(found).toBe(editor);
  });

  it('finds a ready page without waiting for an older pending page', async () => {
    const pending = Promise.withResolvers<string | undefined>();
    const navigator = { evaluate: () => pending.promise };
    const editor = { evaluate: async () => 'editor' };
    try {
      await expect(
        waitForWindowByMode({ windows: () => [navigator, editor] }, 'editor', {
          home: '/unused',
          capMs: 100,
          stallMs: 600_000,
          pollMs: 10,
        }),
      ).resolves.toBe(editor);
    } finally {
      pending.resolve('navigator');
    }
  });

  it('finds a ready page that arrives while an older page is still pending', async () => {
    const pending = Promise.withResolvers<string | undefined>();
    const started = Promise.withResolvers<void>();
    const navigator = {
      evaluate: () => {
        started.resolve();
        return pending.promise;
      },
    };
    const editor = { evaluate: async () => 'editor' };
    let pages = [navigator];
    const waiting = waitForWindowByMode({ windows: () => pages }, 'editor', {
      home: '/unused',
      capMs: 100,
      stallMs: 600_000,
      pollMs: 10,
    });
    await started.promise;
    pages = [navigator, editor];
    try {
      await expect(waiting).resolves.toBe(editor);
    } finally {
      pending.resolve('navigator');
    }
  });

  it('keeps at most one evaluation in flight per page and requests only on the poll cadence', async () => {
    const pending = Promise.withResolvers<string | undefined>();
    let pendingCalls = 0;
    let pendingInFlight = 0;
    let maxPendingInFlight = 0;
    let navigatorCalls = 0;
    const held = {
      evaluate: () => {
        pendingCalls += 1;
        pendingInFlight += 1;
        maxPendingInFlight = Math.max(maxPendingInFlight, pendingInFlight);
        return pending.promise.finally(() => {
          pendingInFlight -= 1;
        });
      },
    };
    const navigator = {
      evaluate: async () => {
        navigatorCalls += 1;
        return 'navigator';
      },
    };
    const waiting = waitForWindowByMode({ windows: () => [held, navigator] }, 'editor', {
      home: '/unused',
      capMs: 120,
      stallMs: 600_000,
      pollMs: 10,
    });
    try {
      await expect(waiting).rejects.toThrow(/did not arrive/);
    } finally {
      pending.resolve('navigator');
    }
    expect(pendingCalls).toBe(1);
    expect(maxPendingInFlight).toBe(1);
    expect(navigatorCalls).toBeGreaterThan(1);
    expect(navigatorCalls).toBeLessThanOrEqual(15);
  });

  it('handles a page rejection that arrives after the cap', () => {
    const scriptDir = mkdtempSync(join(tmpdir(), 'ok-window-readiness-strict-'));
    const script = join(scriptDir, 'late-rejection.mjs');
    const home = seedHome();
    try {
      writeFileSync(
        script,
        [
          'const { waitForWindowByMode } = await import(process.argv[2]);',
          'let fail = (error) => { throw error; };',
          'const pending = new Promise((_resolve, reject) => { fail = reject; });',
          'const page = { evaluate: () => pending };',
          "setTimeout(() => fail(new Error('renderer detached after the cap')), 250);",
          "const error = await waitForWindowByMode({ windows: () => [page] }, 'editor', {",
          '  home: process.argv[3],',
          '  capMs: 60,',
          '  stallMs: 600_000,',
          '  pollMs: 10,',
          '}).catch((e) => e);',
          "if (!(error instanceof Error)) { console.error('the wait did not give up'); process.exit(2); }",
          'await new Promise((resolve) => setTimeout(resolve, 600));',
          "console.log('survived');",
        ].join('\n'),
        'utf8',
      );
      const run = spawnSync(
        process.execPath,
        [
          '--unhandled-rejections=strict',
          script,
          new URL('./launch-readiness.ts', import.meta.url).href,
          home,
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      expect({
        status: run.status,
        stdout: run.stdout.trim(),
        stderr: run.stderr.trim(),
      }).toEqual({ status: 0, stdout: 'survived', stderr: '' });
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('surfaces errors only when no settled page read cleanly', async () => {
    const first = {
      evaluate: async (): Promise<string | undefined> => {
        throw new Error('first target closed');
      },
    };
    const second = {
      evaluate: async (): Promise<string | undefined> => {
        throw new Error('second target closed');
      },
    };
    const error = await waitForWindowByMode({ windows: () => [first, second] }, 'editor', {
      home: '/unused',
      capMs: 80,
      stallMs: 600_000,
      pollMs: 10,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('second target closed');

    const navigator = { evaluate: async () => 'navigator' };
    const cleanError = await waitForWindowByMode({ windows: () => [first, navigator] }, 'editor', {
      home: '/unused',
      capMs: 80,
      stallMs: 600_000,
      pollMs: 10,
    }).catch((caught: unknown) => caught);
    expect(cleanError).toBeInstanceOf(Error);
    expect((cleanError as Error).message).toContain('Probe errors: none on any poll.');
    expect((cleanError as Error).message).not.toContain('first target closed');
  });
});

describe('launchDesktopApp', () => {
  it('passes the app through on success', async () => {
    const app = { id: 'app' };
    const launched = await launchDesktopApp({ launch: async () => app }, {}, { home: '/unused' });
    expect(launched).toBe(app);
  });

  it('annotates a launch timeout with the boot phase the harness could not otherwise see', async () => {
    await expect(
      launchDesktopApp(
        {
          launch: async () => {
            throw new Error('electron.launch: Timeout 30000ms exceeded.');
          },
        },
        {},
        {
          home: '/unused',
          readLog: () =>
            snapshot({ lineCount: 4, lastEvent: 'appReady', tail: '{"event":"appReady"}' }),
        },
      ),
    ).rejects.toThrow(/appReady/);
  });

  it('keeps the original launch failure text alongside the annotation', async () => {
    await expect(
      launchDesktopApp(
        {
          launch: async () => {
            throw new Error('electron.launch: Timeout 30000ms exceeded.');
          },
        },
        {},
        { home: '/unused', readLog: () => snapshot({ exists: false }) },
      ),
    ).rejects.toThrow(/Timeout 30000ms exceeded/);
  });

  it('retains the on-disk boot log and original cause before failed-launch cleanup', async () => {
    const line = markLine('serverSpawned', 8_500, '2026-09-04T00:00:08.500Z');
    const home = seedHome([line]);
    const failure = new Error('electron.launch: Timeout 30000ms exceeded.');
    try {
      const launch = launchDesktopApp(
        {
          launch: async () => {
            throw failure;
          },
        },
        {},
        { home },
      ).catch((error) => {
        rmSync(home, { recursive: true, force: true });
        throw error;
      });
      await expect(launch).rejects.toMatchObject({
        message: expect.stringContaining(line),
        cause: failure,
      });
      expect(existsSync(home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('launch-home registry', () => {
  it('remembers the home a launch used, so readiness can find the boot log', () => {
    const app = {};
    rememberLaunchHome(app, '/tmp/home-a');
    expect(launchHomeFor(app)).toBe('/tmp/home-a');
  });

  it('records the home as part of a successful launch', async () => {
    const app = {};
    await launchDesktopApp({ launch: async () => app }, {}, { home: '/tmp/home-b' });
    expect(launchHomeFor(app)).toBe('/tmp/home-b');
  });

  it('explains itself when an app was not launched through the helper', () => {
    expect(() => launchHomeFor({})).toThrow(/not launched through launchDesktopApp/);
  });

  it('lets waitForWindowByMode resolve the home from the registry', async () => {
    const editor = { evaluate: async () => 'editor' };
    const app = { windows: () => [editor] };
    rememberLaunchHome(app, '/tmp/home-c');
    await expect(waitForWindowByMode(app, 'editor')).resolves.toBe(editor);
  });
});

describe("stall bound is a contract against the app's boot narration", () => {
  it("reads its cadence from the app's own heartbeat constant, not a second copy", () => {
    expect(BOOT_LOG_HEARTBEAT_MS).toBe(SPAWN_WAIT_HEARTBEAT_MS);
  });

  it("tolerates at least two heartbeats missed at the app's cadence", () => {
    expect(BOOT_LOG_STALL_MS).toBeGreaterThanOrEqual(SPAWN_WAIT_HEARTBEAT_MS * 2);
  });

  it("does not fail a boot that keeps heartbeating on the app's own cadence", async () => {
    let clock = 0;
    let lines = 0;
    const found = await waitForReadySignal<string>({
      probe: async () => (clock >= BOOT_LOG_CAP_MS - 2_000 ? 'editor-page' : undefined),
      home: '/unused',
      what: 'editor window',
      now: () => clock,
      sleep: async () => {
        clock += 1_000;
        if (clock % BOOT_LOG_HEARTBEAT_MS === 0) lines += 1;
      },
      readLog: () => snapshot({ lineCount: lines, lastEvent: 'desktop-spawn-wait-progress' }),
    });
    expect(found).toBe('editor-page');
    expect(clock).toBeGreaterThan(BOOT_LOG_STALL_MS);
  });
});

describe("the wait records which of the app's own startup stages arrived while it waited", () => {
  const bootLine = (time: string): string => JSON.stringify({ time, event: DESKTOP_BOOT_EVENT });
  const beatLine = (time: string, lastPhase: string): string =>
    JSON.stringify({ time, event: BOOT_HEARTBEAT_EVENTS.boot, lastPhase });

  it("names the app's own stages and nothing else, in the order it first saw each", () => {
    expect(
      launchAdvancementPhases([
        bootLine('2026-09-24T00:00:00.000Z'),
        markLine('appReady', 0, '2026-09-24T00:00:00.100Z'),
        beatLine('2026-09-24T00:00:05.000Z', 'appReady'),
        JSON.stringify({ time: '2026-09-24T00:00:06.000Z', msg: 'project window created' }),
        markLine('windowCreated', 7_000, '2026-09-24T00:00:07.000Z'),
        rendererRelayedLineAt('2026-09-24T00:00:08.000Z', 'desktop.startup.renderer-step-0'),
        markLine('loadUrlResolved', 9_000, '2026-09-24T00:00:09.000Z'),
      ]),
    ).toEqual([
      'desktop.startup.appReady',
      'desktop.startup.windowCreated',
      'desktop.startup.loadUrlResolved',
    ]);
  });

  it('counts a stage once however many times the line is read back', () => {
    expect(
      launchAdvancementPhases([
        markLine('windowCreated', 1_000, '2026-09-24T00:00:01.000Z'),
        markLine('windowCreated', 1_000, '2026-09-24T00:00:01.000Z'),
      ]),
    ).toEqual(['desktop.startup.windowCreated']);
  });

  it('describes this launch, not the one before it', () => {
    expect(
      launchAdvancementPhases([
        bootLine('2026-09-24T00:00:00.000Z'),
        markLine('windowShown', 3_000, '2026-09-24T00:00:03.000Z'),
        bootLine('2026-09-24T00:01:00.000Z'),
        markLine('appReady', 0, '2026-09-24T00:01:00.100Z'),
      ]),
    ).toEqual(['desktop.startup.appReady']);
  });

  it('reports each stage once, with the elapsed time the wait observed it', async () => {
    let clock = 0;
    const seen: Array<{ event: string; atMs: number }> = [];
    const narration = [bootLine('2026-09-24T00:00:00.000Z')];
    const found = await waitForReadySignal<string>({
      probe: async () => (clock >= 4_000 ? 'editor-page' : undefined),
      home: '/unused',
      what: 'editor window',
      now: () => clock,
      sleep: async () => {
        clock += 1_000;
        if (clock === 2_000) {
          narration.push(markLine('windowCreated', 2_000, '2026-09-24T00:00:02.000Z'));
        }
        if (clock === 3_000) {
          narration.push(markLine('loadUrlResolved', 3_000, '2026-09-24T00:00:03.000Z'));
          narration.push(markLine('loadUrlResolved', 3_000, '2026-09-24T00:00:03.000Z'));
        }
      },
      readLog: () => snapshot({ lines: narration, lineCount: narration.length }),
      onAdvancement: (advancement) => {
        seen.push(advancement);
      },
    });
    expect(found).toBe('editor-page');
    expect(seen).toEqual([
      { event: 'desktop.startup.windowCreated', atMs: 2_000 },
      { event: 'desktop.startup.loadUrlResolved', atMs: 3_000 },
    ]);
  });

  it('carries the stages it read off the real boot log into the record the triage line reads', async () => {
    const home = seedHome([
      bootLine('2026-09-24T00:00:00.000Z'),
      markLine('windowCreated', 1_000, '2026-09-24T00:00:01.000Z'),
      markLine('loadUrlResolved', 2_000, '2026-09-24T00:00:02.000Z'),
    ]);
    try {
      let polls = 0;
      const editor = {
        evaluate: async (): Promise<string | undefined> => {
          polls += 1;
          return polls > 1 ? 'editor' : undefined;
        },
      };
      const app = { windows: () => [editor] };
      await expect(waitForWindowByMode(app, 'editor', { home, pollMs: 1 })).resolves.toBe(editor);
      const record = tryFirstWaitFor(app);
      expect(record?.advancements.map((advancement) => advancement.event)).toEqual([
        'desktop.startup.windowCreated',
        'desktop.startup.loadUrlResolved',
      ]);
      const last = lastAdvancementMs(record as ReadyWaitRecord);
      expect(last).toBeGreaterThanOrEqual(0);
      expect(sinceLastAdvancementMs(record as ReadyWaitRecord)).toBe(
        (record as ReadyWaitRecord).elapsedMs - (last as number),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('separates advancement from a boot the app only heartbeats through', async () => {
    let clock = 0;
    const seen: string[] = [];
    const narration = [
      bootLine('2026-09-24T00:00:00.000Z'),
      markLine('loadUrlResolved', 100, '2026-09-24T00:00:00.100Z'),
    ];
    await expect(
      waitForReadySignal<string>({
        probe: async () => undefined,
        home: '/unused',
        what: 'editor window',
        now: () => clock,
        sleep: async () => {
          clock += 1_000;
          if (clock % BOOT_LOG_HEARTBEAT_MS === 0) {
            narration.push(beatLine(new Date(clock).toISOString(), 'loadUrlResolved'));
          }
        },
        readLog: () => snapshot({ lines: narration, lineCount: narration.length }),
        onAdvancement: (advancement) => {
          seen.push(advancement.event);
        },
      }),
    ).rejects.toThrow(/kept logging boot activity/);
    expect(seen).toEqual(['desktop.startup.loadUrlResolved']);
    expect(clock).toBeGreaterThanOrEqual(BOOT_LOG_CAP_MS);
  });

  it('carries the advancement record into the triage line', () => {
    const line = formatBootGapLine({
      slot: 0,
      source: 'wait-snapshot',
      readyWaitCount: 1,
      firstWait: {
        ordinal: 0,
        what: 'editor window',
        elapsedMs: 25_217,
        capMs: BOOT_LOG_CAP_MS,
        requestedCapMs: BOOT_LOG_CAP_MS,
        gaveUp: true,
        reason: 'cap',
        advancements: [
          { event: 'desktop.startup.windowCreated', atMs: 17_138 },
          { event: 'desktop.startup.loadUrlResolved', atMs: 19_261 },
        ],
      },
      summary: undefined,
      reason: 'no summary',
    });
    expect(line).toContain(
      'firstWaitAdvancements=["desktop.startup.windowCreated","desktop.startup.loadUrlResolved"]',
    );
    expect(line).toContain('firstWaitLastAdvancementMs=19261');
    expect(line).toContain('firstWaitSinceAdvancementMs=5956');
  });

  it('says there was no advancement rather than printing a zero', () => {
    const line = formatBootGapLine({
      slot: 0,
      source: 'wait-snapshot',
      readyWaitCount: 1,
      firstWait: {
        ordinal: 0,
        what: 'editor window',
        elapsedMs: 25_000,
        capMs: BOOT_LOG_CAP_MS,
        requestedCapMs: BOOT_LOG_CAP_MS,
        gaveUp: true,
        reason: 'cap',
        advancements: [],
      },
      summary: undefined,
      reason: 'no summary',
    });
    expect(line).toContain('firstWaitAdvancements=[]');
    expect(line).toContain('firstWaitLastAdvancementMs=none');
    expect(line).toContain('firstWaitSinceAdvancementMs=none');
  });
});

describe('bootLogGapSummary', () => {
  it("reports the largest silence between the app's own stages", () => {
    const lines = [
      JSON.stringify({ time: '2026-09-04T00:00:00.000Z', event: DESKTOP_BOOT_EVENT }),
      markLine('serverSpawned', 2_000, '2026-09-04T00:00:02.000Z'),
      JSON.stringify({
        time: '2026-09-04T00:00:16.000Z',
        event: 'desktop-spawn-wait-progress',
      }),
    ];
    const s = bootLogGapSummary(lines);
    expect(s.lineCount).toBe(3);
    expect(s.maxGapMs).toBe(14_000);
    expect(s.maxGapAfterPhase).toBe('desktop.startup.serverSpawned');
    expect(s.beatsSeen).toBe(1);
    expect(s.bootComplete).toBe(false);
  });

  it("measures the app's own stages, not the liveness beat bracketing them", () => {
    const lines = [
      markLine('appReady', 0, '2026-09-04T00:00:00.000Z'),
      JSON.stringify({
        time: '2026-09-04T00:00:05.000Z',
        event: BOOT_HEARTBEAT_EVENTS.boot,
        lastPhase: 'appReady',
      }),
      JSON.stringify({
        time: '2026-09-04T00:00:10.000Z',
        event: BOOT_HEARTBEAT_EVENTS.boot,
        lastPhase: 'appReady',
      }),
      markLine('serverSpawned', 12_000, '2026-09-04T00:00:12.000Z'),
    ];
    const s = bootLogGapSummary(lines);
    expect(s.maxGapMs).toBe(12_000);
    expect(s.maxGapAfterPhase).toBe('desktop.startup.appReady');
    expect(s.beatsSeen).toBe(2);
    expect(s.lastBeatPhase).toBe('appReady');
    expect(s.phases).toEqual(['desktop.startup.appReady', 'desktop.startup.serverSpawned']);
  });

  it('reports the silence the app is still sitting in, not just the hops it finished', () => {
    const beat = (sec: number) =>
      JSON.stringify({
        time: `2026-09-04T00:00:${String(sec).padStart(2, '0')}.000Z`,
        event: BOOT_HEARTBEAT_EVENTS.boot,
        lastPhase: 'serverSpawned',
      });
    const s = bootLogGapSummary([
      JSON.stringify({ time: '2026-09-04T00:00:00.000Z', event: DESKTOP_BOOT_EVENT }),
      markLine('serverSpawned', 2_000, '2026-09-04T00:00:02.000Z'),
      beat(7),
      beat(12),
      beat(17),
      beat(22),
      beat(27),
    ]);
    expect(s.maxGapMs).toBe(25_000);
    expect(s.maxGapAfterPhase).toBe('desktop.startup.serverSpawned');
    expect(s.openStageMs).toBe(25_000);
    expect(s.lastBeatPhase).toBe('serverSpawned');
  });

  it('classifies an abandoned heartbeat as a beat, not as a boot stage', () => {
    const s = bootLogGapSummary([
      markLine('appReady', 0, '2026-09-04T00:00:00.000Z'),
      JSON.stringify({
        time: '2026-09-04T00:02:05.000Z',
        event: `${BOOT_HEARTBEAT_EVENTS.boot}${BOOT_HEARTBEAT_ABANDONED_SUFFIX}`,
        lastPhase: 'appReady',
      }),
    ]);
    expect(s.phases).toEqual(['desktop.startup.appReady']);
    expect(s.beatsSeen).toBe(1);
    expect(s.openStageMs).toBe(125_000);
  });

  it('describes the launch in progress, not the one that already finished', () => {
    const boot = (t: string) => JSON.stringify({ time: t, event: DESKTOP_BOOT_EVENT });
    const s = bootLogGapSummary([
      boot('2026-09-04T00:00:00.000Z'),
      markLine('appReady', 0, '2026-09-04T00:00:01.000Z'),
      markLine('windowShown', 2_000, '2026-09-04T00:00:02.000Z'),
      boot('2026-09-04T00:01:00.000Z'),
      markLine('serverSpawned', 1_000, '2026-09-04T00:01:01.000Z'),
      JSON.stringify({
        time: '2026-09-04T00:01:26.000Z',
        event: BOOT_HEARTBEAT_EVENTS.boot,
        lastPhase: 'serverSpawned',
      }),
    ]);
    expect(s.bootComplete).toBe(false);
    expect(s.openStageMs).toBe(25_000);
    expect(s.maxGapAfterPhase).toBe('desktop.startup.serverSpawned');
    expect(s.phases).not.toContain('desktop.startup.appReady');
  });

  it('reports how long the app took to boot, not just the gaps within it', () => {
    const s = bootLogGapSummary([
      JSON.stringify({ time: '2026-09-04T00:00:00.000Z', event: DESKTOP_BOOT_EVENT }),
      markLine('appReady', 1_000, '2026-09-04T00:00:01.000Z'),
      markLine('serverSpawned', 3_000, '2026-09-04T00:00:03.000Z'),
      markLine('windowShown', 9_000, '2026-09-04T00:00:09.000Z'),
    ]);
    expect(s.totalBootMs).toBe(9_000);
    expect(s.maxGapMs).toBe(6_000);
    expect(s.bootComplete).toBe(true);
  });

  it('counts trailing beats in the total, which stop at no phase line', () => {
    const s = bootLogGapSummary([
      JSON.stringify({ time: '2026-09-04T00:00:00.000Z', event: DESKTOP_BOOT_EVENT }),
      markLine('serverSpawned', 1_000, '2026-09-04T00:00:01.000Z'),
      JSON.stringify({
        time: '2026-09-04T00:00:06.000Z',
        event: BOOT_HEARTBEAT_EVENTS.boot,
        lastPhase: 'serverSpawned',
      }),
      JSON.stringify({
        time: '2026-09-04T00:00:11.000Z',
        event: BOOT_HEARTBEAT_EVENTS.boot,
        lastPhase: 'serverSpawned',
      }),
    ]);
    expect(s.totalBootMs).toBe(11_000);
    expect(s.phases.at(-1)).toBe('desktop.startup.serverSpawned');
  });

  it('measures boot, not the idle test that follows it', () => {
    const lines = [
      markLine('appReady', 0, '2026-09-04T00:00:00.000Z'),
      markLine('windowShown', 3_000, '2026-09-04T00:00:03.000Z'),
      JSON.stringify({ time: '2026-09-04T00:00:45.000Z', event: 'terminal-session-exit' }),
    ];
    const s = bootLogGapSummary(lines);
    expect(s.bootComplete).toBe(true);
    expect(s.lineCount).toBe(2);
    expect(s.maxGapMs).toBe(3_000);
  });

  it('ends boot at the window it showed, not at a later renderer line that borrows the startup-stage prefix', () => {
    const s = bootLogGapSummary([
      markLine('appReady', 0, '2026-09-04T00:00:00.000Z'),
      markLine('windowShown', 3_000, '2026-09-04T00:00:03.000Z'),
      rendererRelayedLineAt('2026-09-04T00:00:10.000Z', 'desktop.startup.renderer-step-0'),
      JSON.stringify({ time: '2026-09-04T00:00:45.000Z', event: 'terminal-session-exit' }),
    ]);
    expect(s.phases).toEqual(['desktop.startup.appReady', 'desktop.startup.windowShown']);
    expect(s.lineCount).toBe(2);
    expect(s.maxGapMs).toBe(3_000);
    expect(s.bootComplete).toBe(true);
  });

  it('is empty-safe when the app logged nothing', () => {
    expect(bootLogGapSummary([])).toEqual({
      totalBootMs: 0,
      lineCount: 0,
      maxGapMs: 0,
      maxGapAfterPhase: undefined,
      openStageMs: 0,
      beatsSeen: 0,
      bootComplete: false,
      phases: [],
    });
  });
});

describe('the cap is a livelock backstop, deliberately tighter than the app can take', () => {
  it('keeps the stall bound below the cap, so a silent boot reads as silence not as a timeout', () => {
    expect(BOOT_LOG_STALL_MS).toBeLessThan(BOOT_LOG_CAP_MS);
  });

  it("keeps main's heartbeat running past the latest deadline a startup stage can set", () => {
    expect(BOOT_HEARTBEAT_MAX_BEATS * SPAWN_WAIT_HEARTBEAT_MS).toBeGreaterThan(
      BOOT_LOG_CAP_MS + BOOT_LOG_STALL_MS,
    );
  });

  it("keeps the latest deadline a startup stage can set below the packaged path's graduated spawn budget", () => {
    expect(BOOT_LOG_CAP_MS + BOOT_LOG_STALL_MS).toBeLessThan(
      SPAWN_STARTUP_DEADLINE_MS * SPAWN_WAIT_EXTENSION_FACTOR,
    );
  });

  it("keeps the latest deadline a startup stage can set inside the one the app's declared utility budget can already reach", () => {
    expect(BOOT_LOG_STALL_MS).toBeLessThanOrEqual(
      UTILITY_INIT_TIMEOUT_MS + UTILITY_TIMEOUT_OBSERVATION_MARGIN_MS,
    );
  });
});

const DEEP_LINK_APP_T0 = Date.parse('2026-09-22T14:28:32.504Z');

const LAUNCH_RESOLVED_AT_MS = 400;

const MEASURED_FORK_OFFSETS = [861, 3919, 6210, 10423] as const;

const UTILITY_TIMEOUT_VERDICT = `utility init timed out after ${UTILITY_INIT_TIMEOUT_MS}ms`;

const LATE_WINDOW_FORK_MS = 3_514;

interface NarrationLine {
  at: number;
  text: string;
}

function isoAt(atMs: number): string {
  return new Date(DEEP_LINK_APP_T0 + atMs).toISOString();
}

function markAt(phase: WaterfallPhase, atMs: number): NarrationLine {
  return { at: atMs, text: markLine(phase, atMs, isoAt(atMs)) };
}

function eventAt(atMs: number, body: Record<string, unknown>): NarrationLine {
  return { at: atMs, text: JSON.stringify({ time: isoAt(atMs), ...body }) };
}

function deepLinkNarration(forkAtMs: number): NarrationLine[] {
  const beats: NarrationLine[] = [];
  for (
    let beat = SPAWN_WAIT_HEARTBEAT_MS;
    beat < UTILITY_INIT_TIMEOUT_MS;
    beat += SPAWN_WAIT_HEARTBEAT_MS
  ) {
    beats.push(
      eventAt(forkAtMs + beat, {
        event: BOOT_HEARTBEAT_EVENTS.utilityWait,
        elapsedMs: beat,
        initTimeoutMs: UTILITY_INIT_TIMEOUT_MS,
      }),
    );
  }
  return [
    eventAt(0, { event: DESKTOP_BOOT_EVENT }),
    markAt('serverSpawned', forkAtMs),
    eventAt(forkAtMs + 900, { event: 'desktop-navigator-load-resolved' }),
    markAt('windowShown', forkAtMs + 1_300),
    ...beats,
    eventAt(forkAtMs + UTILITY_INIT_TIMEOUT_MS, {
      event: DESKTOP_OPEN_PROJECT_FAILED_EVENT,
      entryPoint: 'deep-link',
      err: { message: UTILITY_TIMEOUT_VERDICT },
    }),
  ];
}

function lateWindowNarration(): NarrationLine[] {
  return [
    ...deepLinkNarration(LATE_WINDOW_FORK_MS).slice(0, -1),
    markAt('serverLockReady', 22_213),
    markAt('windowCreated', 22_231),
    markAt('loadUrlResolved', 23_445),
    eventAt(23_474, { subsystem: 'project', msg: 'project window created' }),
  ];
}

interface VirtualClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  startDeadline: (ms: number) => ReadyDeadline;
  readLog: (home: string) => BootLogSnapshot;
}

function virtualClock(home: string, narration: readonly NarrationLine[]): VirtualClock {
  let clock = 0;
  const pending: { at: number; resolve: () => void }[] = [];
  const logFile = join(bootLogDirFor(home), 'desktop.0.log');
  const publish = (): void => {
    const appElapsed = LAUNCH_RESOLVED_AT_MS + clock;
    const visible = narration.filter((entry) => entry.at <= appElapsed).map((entry) => entry.text);
    writeFileSync(logFile, visible.length === 0 ? '' : `${visible.join('\n')}\n`, 'utf8');
  };
  publish();
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const entry = pending[i];
        if (entry !== undefined && entry.at <= clock) {
          pending.splice(i, 1);
          entry.resolve();
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
    startDeadline: (ms: number) => {
      const reached = Promise.withResolvers<void>();
      const entry = { at: clock + ms, resolve: reached.resolve };
      pending.push(entry);
      return {
        expired: reached.promise,
        cancel: () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
        },
      };
    },
    readLog: (readFrom: string) => {
      publish();
      return readBootLog(readFrom);
    },
  };
}

interface WaitOutcome {
  gaveUp: boolean;
  message: string;
  elapsedMs: number;
}

async function waitWithoutEditorWindow(narration: readonly NarrationLine[]): Promise<WaitOutcome> {
  const home = seedHome();
  mkdirSync(bootLogDirFor(home), { recursive: true });
  const clock = virtualClock(home, narration);
  const settled = await waitForReadySignal<string>({
    home,
    what: 'editor window',
    probe: async () => undefined,
    now: clock.now,
    sleep: clock.sleep,
    readLog: clock.readLog,
    startDeadline: clock.startDeadline,
  }).then(
    () => ({ gaveUp: false, message: '' }),
    (error: unknown) => ({ gaveUp: true, message: (error as Error).message }),
  );
  return { ...settled, elapsedMs: clock.now() };
}

function verdictReadableAtMs(forkAtMs: number): number {
  return forkAtMs + UTILITY_INIT_TIMEOUT_MS - LAUNCH_RESOLVED_AT_MS;
}

const FORKS_THE_STATIC_CAP_CUTS_SHORT = MEASURED_FORK_OFFSETS.filter(
  (forkAtMs) => verdictReadableAtMs(forkAtMs) > BOOT_LOG_CAP_MS,
);

describe("the wait outlives the app's own deadline for the phase the window is gated behind", () => {
  it('runs exactly the measured forks whose verdict lands past the static cap', () => {
    expect(FORKS_THE_STATIC_CAP_CUTS_SHORT).toEqual([6210, 10423]);
  });

  it.each(FORKS_THE_STATIC_CAP_CUTS_SHORT)(
    "reports the app's own open-project verdict when the utility fork landed at %ims",
    async (forkAtMs) => {
      const outcome = await waitWithoutEditorWindow(deepLinkNarration(forkAtMs));
      expect(outcome.gaveUp).toBe(true);
      expect(outcome.elapsedMs).toBeGreaterThan(BOOT_LOG_CAP_MS);
      expect(outcome.message).toContain(DESKTOP_OPEN_PROJECT_FAILED_EVENT);
      expect(outcome.message).toContain(UTILITY_TIMEOUT_VERDICT);
      expect(outcome.message).not.toContain(
        `Last main-process boot event: ${BOOT_HEARTBEAT_EVENTS.utilityWait}`,
      );
    },
  );

  it("stays inside the app's own declared budget when the app never publishes a verdict", async () => {
    const forkAtMs = MEASURED_FORK_OFFSETS[2];
    const outcome = await waitWithoutEditorWindow(deepLinkNarration(forkAtMs).slice(0, -1));
    expect(outcome.gaveUp).toBe(true);
    expect(outcome.elapsedMs).toBeLessThanOrEqual(
      forkAtMs -
        LAUNCH_RESOLVED_AT_MS +
        UTILITY_INIT_TIMEOUT_MS +
        UTILITY_TIMEOUT_OBSERVATION_MARGIN_MS +
        BOOT_LOG_POLL_MS,
    );
  });
});

describe('the give-up describes the narration the wait actually read', () => {
  it('does not report activity across a silence that ran through the whole open phase', async () => {
    const silentAfterFirstWindow = deepLinkNarration(MEASURED_FORK_OFFSETS[0]).slice(0, 4);
    const outcome = await waitWithoutEditorWindow(silentAfterFirstWindow);
    expect(outcome.gaveUp).toBe(true);
    expect(outcome.message).not.toContain('kept logging boot activity');
    expect(outcome.message).toContain('logged no new boot activity');
  });

  it('treats the app going quiet after its own verdict as a closed phase, not a stall', async () => {
    const verdictThenQuiet: NarrationLine[] = [
      eventAt(0, { event: DESKTOP_BOOT_EVENT }),
      markAt('serverSpawned', 500),
      markAt('windowShown', 1_800),
      eventAt(5_500, {
        event: BOOT_HEARTBEAT_EVENTS.utilityWait,
        elapsedMs: 5_000,
        initTimeoutMs: SPAWN_STARTUP_DEADLINE_MS,
      }),
      eventAt(7_000, {
        event: DESKTOP_OPEN_PROJECT_FAILED_EVENT,
        entryPoint: 'deep-link',
        err: { message: UTILITY_TIMEOUT_VERDICT },
      }),
    ];
    const outcome = await waitWithoutEditorWindow(verdictThenQuiet);
    expect(outcome.gaveUp).toBe(true);
    expect(outcome.elapsedMs).toBe(BOOT_LOG_CAP_MS);
    expect(outcome.message).not.toContain('logged no new boot activity');
    expect(outcome.message).toContain('kept logging boot activity');
  });
});

describe('the boot-gap line covers the phase the wait gave up in', () => {
  const narration = lateWindowNarration();
  const lines = narration.map((entry) => entry.text);
  const launchSpanMs = (narration.at(-1)?.at ?? 0) - (narration[0]?.at ?? 0);
  const heartbeatsEmitted = narration.filter((entry) =>
    entry.text.includes(BOOT_HEARTBEAT_EVENTS.utilityWait),
  ).length;

  it('spans the whole launch the harness read, not the prefix that ends at the first window', () => {
    expect(launchSpanMs).toBeGreaterThan(0);
    expect(bootLogGapSummary(lines).totalBootMs).toBe(launchSpanMs);
  });

  it('counts the heartbeats the app emitted after it showed its first window', () => {
    expect(heartbeatsEmitted).toBeGreaterThan(0);
    expect(bootLogGapSummary(lines).beatsSeen).toBe(heartbeatsEmitted);
  });

  it('renders that span into the [boot-gap] triage line', () => {
    const line = bootGapLineFor({
      slot: 0,
      narration: bootNarrationFor(lines, snapshot({ lines, lineCount: lines.length })),
      readyWaitCount: 1,
      homeShared: false,
    });
    expect(formatBootGapLine(line)).toContain(`totalBootMs=${launchSpanMs}`);
  });
});

function withUtilityBeats(
  narration: readonly NarrationLine[],
  rewrite: (beat: Record<string, unknown>) => string,
): NarrationLine[] {
  return narration.map((entry) => {
    const parsed = JSON.parse(entry.text) as Record<string, unknown>;
    return parsed.event === BOOT_HEARTBEAT_EVENTS.utilityWait
      ? { at: entry.at, text: rewrite(parsed) }
      : entry;
  });
}

describe('a budget the app did not declare cleanly buys the wait no extra time', () => {
  const granting = deepLinkNarration(MEASURED_FORK_OFFSETS[2]);

  it('outlives the static cap when every beat declares a well-formed budget', async () => {
    const outcome = await waitWithoutEditorWindow(granting);
    expect(outcome.gaveUp).toBe(true);
    expect(outcome.elapsedMs).toBeGreaterThan(BOOT_LOG_CAP_MS);
    expect(outcome.message).toContain(UTILITY_TIMEOUT_VERDICT);
  });

  it.each([
    [
      'an initTimeoutMs that is not a number',
      (beat: Record<string, unknown>) =>
        JSON.stringify({ ...beat, initTimeoutMs: String(beat.initTimeoutMs) }),
    ],
    [
      'an initTimeoutMs the JSON parse overflowed to Infinity',
      (beat: Record<string, unknown>) =>
        JSON.stringify(beat).replace(
          `"initTimeoutMs":${UTILITY_INIT_TIMEOUT_MS}`,
          '"initTimeoutMs":1e999',
        ),
    ],
    [
      'a negative elapsedMs',
      (beat: Record<string, unknown>) =>
        JSON.stringify({ ...beat, elapsedMs: -(beat.elapsedMs as number) }),
    ],
    [
      'a beat line that does not parse',
      (beat: Record<string, unknown>) => `${JSON.stringify(beat)}{`,
    ],
    [
      'an initTimeoutMs larger than the budget the app can declare',
      (beat: Record<string, unknown>) =>
        JSON.stringify({ ...beat, initTimeoutMs: DECLARED_UTILITY_BUDGET_CEILING_MS + 1 }),
    ],
    [
      'the budget on a heartbeat that does not own the open phase',
      (beat: Record<string, unknown>) =>
        JSON.stringify({ ...beat, event: BOOT_HEARTBEAT_EVENTS.spawnWait }),
    ],
  ])('stops at the static cap when the app published %s', async (_label, rewrite) => {
    const outcome = await waitWithoutEditorWindow(withUtilityBeats(granting, rewrite));
    expect(outcome.gaveUp).toBe(true);
    expect(outcome.elapsedMs).toBe(BOOT_LOG_CAP_MS);
    expect(outcome.message).not.toContain(UTILITY_TIMEOUT_VERDICT);
  });

  it('stops granting once the app overruns the budget it kept declaring', async () => {
    const forkAtMs = MEASURED_FORK_OFFSETS[2];
    const overrunBeats: NarrationLine[] = [];
    for (
      let elapsedMs = UTILITY_INIT_TIMEOUT_MS;
      elapsedMs <= UTILITY_INIT_TIMEOUT_MS * 2;
      elapsedMs += SPAWN_WAIT_HEARTBEAT_MS
    ) {
      overrunBeats.push(
        eventAt(forkAtMs + elapsedMs, {
          event: BOOT_HEARTBEAT_EVENTS.utilityWait,
          elapsedMs,
          initTimeoutMs: UTILITY_INIT_TIMEOUT_MS,
        }),
      );
    }
    const lastBeatReadableAt = (overrunBeats.at(-1)?.at ?? 0) - LAUNCH_RESOLVED_AT_MS;
    expect(overrunBeats.length).toBeGreaterThan(1);
    expect(lastBeatReadableAt).toBeGreaterThan(BOOT_LOG_CAP_MS);
    const outcome = await waitWithoutEditorWindow([
      ...deepLinkNarration(forkAtMs).slice(0, -1),
      ...overrunBeats,
    ]);
    expect(outcome.gaveUp).toBe(true);
    expect(outcome.elapsedMs).toBeLessThan(lastBeatReadableAt);
  });

  it('still takes a beat that reports it is exactly at the budget it declares', async () => {
    const forkAtMs = MEASURED_FORK_OFFSETS[0];
    const atBudget = [
      ...deepLinkNarration(forkAtMs).slice(0, -1),
      eventAt(forkAtMs + UTILITY_INIT_TIMEOUT_MS, {
        event: BOOT_HEARTBEAT_EVENTS.utilityWait,
        elapsedMs: UTILITY_INIT_TIMEOUT_MS,
        initTimeoutMs: UTILITY_INIT_TIMEOUT_MS,
      }),
    ];
    const outcome = await waitWithoutEditorWindow(atBudget);
    expect(outcome.gaveUp).toBe(true);
    expect(outcome.elapsedMs).toBeGreaterThan(BOOT_LOG_CAP_MS);
  });
});

const UTILITY_WAIT_HARD_CAP_MS = UTILITY_INIT_TIMEOUT_MS * SPAWN_WAIT_EXTENSION_FACTOR;

function utilityWaitBeatLine(elapsedMs: number, initTimeoutMs: number): string {
  return JSON.stringify({ event: BOOT_HEARTBEAT_EVENTS.utilityWait, elapsedMs, initTimeoutMs });
}

function graduatedUtilityNarration(forkAtMs: number, lastBeatElapsedMs: number): NarrationLine[] {
  const beatsFromTheStartupDeadline: NarrationLine[] = [];
  for (
    let elapsedMs = UTILITY_INIT_TIMEOUT_MS;
    elapsedMs <= lastBeatElapsedMs;
    elapsedMs += SPAWN_WAIT_HEARTBEAT_MS
  ) {
    beatsFromTheStartupDeadline.push(
      eventAt(forkAtMs + elapsedMs, {
        event: BOOT_HEARTBEAT_EVENTS.utilityWait,
        elapsedMs,
        initTimeoutMs:
          elapsedMs > UTILITY_INIT_TIMEOUT_MS ? UTILITY_WAIT_HARD_CAP_MS : UTILITY_INIT_TIMEOUT_MS,
      }),
    );
  }
  return [...deepLinkNarration(forkAtMs).slice(0, -1), ...beatsFromTheStartupDeadline];
}

describe("the wait honors the hard cap a live utility's startup wait graduates to", () => {
  it('reads a utility-wait beat declaring the hard cap as a budget, and refuses one declaring past it', () => {
    const graduatedElapsedMs = UTILITY_INIT_TIMEOUT_MS + SPAWN_WAIT_HEARTBEAT_MS;
    expect(
      parseDeclaredPhaseBudget(utilityWaitBeatLine(graduatedElapsedMs, UTILITY_WAIT_HARD_CAP_MS)),
    ).toEqual({ elapsedMs: graduatedElapsedMs, initTimeoutMs: UTILITY_WAIT_HARD_CAP_MS });
    expect(
      parseDeclaredPhaseBudget(
        utilityWaitBeatLine(graduatedElapsedMs, UTILITY_WAIT_HARD_CAP_MS + 1),
      ),
    ).toBeUndefined();
  });

  it('finds an editor window that answers past the startup deadline, inside the graduated budget', async () => {
    const forkAtMs = MEASURED_FORK_OFFSETS[0];
    const readyAtElapsedMs =
      UTILITY_INIT_TIMEOUT_MS + UTILITY_TIMEOUT_OBSERVATION_MARGIN_MS + SPAWN_WAIT_HEARTBEAT_MS;
    const windowAnswersAtMs = forkAtMs + readyAtElapsedMs - LAUNCH_RESOLVED_AT_MS;
    expect(windowAnswersAtMs).toBeGreaterThan(BOOT_LOG_CAP_MS);
    expect(readyAtElapsedMs).toBeLessThan(UTILITY_WAIT_HARD_CAP_MS);

    const home = seedHome();
    mkdirSync(bootLogDirFor(home), { recursive: true });
    const clock = virtualClock(home, graduatedUtilityNarration(forkAtMs, readyAtElapsedMs));
    const outcome = await waitForReadySignal<string>({
      home,
      what: 'editor window',
      probe: async () => (clock.now() >= windowAnswersAtMs ? 'graduated-editor-page' : undefined),
      now: clock.now,
      sleep: clock.sleep,
      readLog: clock.readLog,
      startDeadline: clock.startDeadline,
    }).then(
      (found) => ({ found, gaveUpWith: undefined }),
      (error: unknown) => ({ found: undefined, gaveUpWith: (error as Error).message }),
    );
    expect(outcome).toEqual({ found: 'graduated-editor-page', gaveUpWith: undefined });
  });
});

function utilityWaitBeatWrittenAt(
  forkAtMs: number,
  sinceForkMs: number,
  initTimeoutMs: number,
): NarrationLine {
  return eventAt(forkAtMs + sinceForkMs, {
    event: BOOT_HEARTBEAT_EVENTS.utilityWait,
    elapsedMs: sinceForkMs,
    initTimeoutMs,
  });
}

function graduatingUtilityNarration(
  forkAtMs: number,
  options: {
    graduationBeat: boolean;
    decisionLateMs: number;
    graduatedBeatsLateMs: number;
    lastBeatElapsedMs: number;
  },
): NarrationLine[] {
  const decisionWrittenAtMs = UTILITY_INIT_TIMEOUT_MS + options.decisionLateMs;
  const lines: NarrationLine[] = [
    ...deepLinkNarration(forkAtMs).slice(0, -1),
    utilityWaitBeatWrittenAt(forkAtMs, decisionWrittenAtMs, UTILITY_INIT_TIMEOUT_MS),
  ];
  if (options.graduationBeat) {
    lines.push(utilityWaitBeatWrittenAt(forkAtMs, decisionWrittenAtMs, UTILITY_WAIT_HARD_CAP_MS));
  }
  for (
    let nominalMs = UTILITY_INIT_TIMEOUT_MS + SPAWN_WAIT_HEARTBEAT_MS;
    nominalMs <= options.lastBeatElapsedMs;
    nominalMs += SPAWN_WAIT_HEARTBEAT_MS
  ) {
    lines.push(
      utilityWaitBeatWrittenAt(
        forkAtMs,
        nominalMs + options.decisionLateMs + options.graduatedBeatsLateMs,
        UTILITY_WAIT_HARD_CAP_MS,
      ),
    );
  }
  return lines;
}

async function waitForEditorWindowAnsweringAt(
  narration: readonly NarrationLine[],
  windowAnswersAtMs: number,
): Promise<{ found: string | undefined; gaveUpWith: string | undefined }> {
  const home = seedHome();
  mkdirSync(bootLogDirFor(home), { recursive: true });
  const clock = virtualClock(home, narration);
  return waitForReadySignal<string>({
    home,
    what: 'editor window',
    probe: async () => (clock.now() >= windowAnswersAtMs ? 'graduated-editor-page' : undefined),
    now: clock.now,
    sleep: clock.sleep,
    readLog: clock.readLog,
    startDeadline: clock.startDeadline,
  }).then(
    (found) => ({ found, gaveUpWith: undefined }),
    (error: unknown) => ({ found: undefined, gaveUpWith: (error as Error).message }),
  );
}

describe("the wait grants its observation margin after the app's declared decision, not only up to it", () => {
  it.each(FORKS_THE_STATIC_CAP_CUTS_SHORT)(
    'finds an editor window in the graduated tier when the lines the app writes at its startup deadline run a poll late, for a utility fork at %ims',
    async (forkAtMs) => {
      const windowAnswersAtElapsedMs = UTILITY_INIT_TIMEOUT_MS + SPAWN_WAIT_HEARTBEAT_MS;
      const outcome = await waitForEditorWindowAnsweringAt(
        graduatingUtilityNarration(forkAtMs, {
          graduationBeat: true,
          decisionLateMs: BOOT_LOG_POLL_MS,
          graduatedBeatsLateMs: 0,
          lastBeatElapsedMs: windowAnswersAtElapsedMs,
        }),
        forkAtMs + windowAnswersAtElapsedMs - LAUNCH_RESOLVED_AT_MS,
      );
      expect(outcome).toEqual({ found: 'graduated-editor-page', gaveUpWith: undefined });
    },
  );
});

describe('the graduated budget reaches the wait on the beat the app writes at its decision', () => {
  it('keeps waiting through a late first graduated heartbeat because the graduation beat declared the hard cap', async () => {
    const forkAtMs = MEASURED_FORK_OFFSETS[0];
    const windowAnswersAtElapsedMs = UTILITY_INIT_TIMEOUT_MS + 2 * SPAWN_WAIT_HEARTBEAT_MS;
    const windowAnswersAtMs = forkAtMs + windowAnswersAtElapsedMs - LAUNCH_RESOLVED_AT_MS;
    const narrationWith = (graduationBeat: boolean): NarrationLine[] =>
      graduatingUtilityNarration(forkAtMs, {
        graduationBeat,
        decisionLateMs: 0,
        graduatedBeatsLateMs: BOOT_LOG_POLL_MS,
        lastBeatElapsedMs: windowAnswersAtElapsedMs,
      });

    const withoutGraduationBeat = await waitForEditorWindowAnsweringAt(
      narrationWith(false),
      windowAnswersAtMs,
    );
    expect(withoutGraduationBeat.found).toBeUndefined();

    const withGraduationBeat = await waitForEditorWindowAnsweringAt(
      narrationWith(true),
      windowAnswersAtMs,
    );
    expect(withGraduationBeat).toEqual({ found: 'graduated-editor-page', gaveUpWith: undefined });
  });
});

describe("the wait honors a live utility's whole graduated budget", () => {
  it('finds an editor window that answers one heartbeat before the hard cap', async () => {
    const forkAtMs = MEASURED_FORK_OFFSETS[3];
    const windowAnswersAtElapsedMs = UTILITY_WAIT_HARD_CAP_MS - SPAWN_WAIT_HEARTBEAT_MS;
    const windowAnswersAtMs = forkAtMs + windowAnswersAtElapsedMs - LAUNCH_RESOLVED_AT_MS;
    expect(windowAnswersAtMs).toBeGreaterThan(
      BOOT_LOG_CAP_MS +
        BOOT_LOG_STALL_MS +
        UTILITY_INIT_TIMEOUT_MS +
        UTILITY_TIMEOUT_OBSERVATION_MARGIN_MS,
    );

    const outcome = await waitForEditorWindowAnsweringAt(
      graduatingUtilityNarration(forkAtMs, {
        graduationBeat: true,
        decisionLateMs: 0,
        graduatedBeatsLateMs: 0,
        lastBeatElapsedMs: windowAnswersAtElapsedMs,
      }),
      windowAnswersAtMs,
    );
    expect(outcome).toEqual({ found: 'graduated-editor-page', gaveUpWith: undefined });
  });
});

function exportedEventName(event: string): string {
  expect(event, 'boot-narration exports the event name').toBeTypeOf('string');
  return event;
}

describe("the utility's startup diagnostics are neither launch progress nor a budget to the wait", () => {
  it('reads the phase-mark, graduation and expiry lines as neither heartbeats, startup stages nor declared budgets', () => {
    const extendedEvent = exportedEventName(UTILITY_WAIT_EXTENDED_EVENT);
    const expiredEvent = exportedEventName(UTILITY_WAIT_EXPIRED_EVENT);
    expect(UTILITY_INIT_PHASES, 'boot-narration exports UTILITY_INIT_PHASES').toBeInstanceOf(Array);
    expect(utilityInitPhaseEvent, 'boot-narration exports utilityInitPhaseEvent').toBeTypeOf(
      'function',
    );
    const phaseEvents = UTILITY_INIT_PHASES.map((phase) => utilityInitPhaseEvent(phase));
    const diagnosticEvents = [...phaseEvents, extendedEvent, expiredEvent];
    expect(phaseEvents.length).toBeGreaterThan(0);
    expect(isBootHeartbeatEvent(BOOT_HEARTBEAT_EVENTS.utilityWait)).toBe(true);
    expect(isStartupMarkEvent(startupMarkLine('serverSpawned', 0).event)).toBe(true);
    expect(diagnosticEvents.filter((event) => isBootHeartbeatEvent(event))).toEqual([]);
    expect(diagnosticEvents.filter((event) => isStartupMarkEvent(event))).toEqual([]);

    const forkAtMs = MEASURED_FORK_OFFSETS[0];
    const launch = deepLinkNarration(forkAtMs).slice(0, -1);
    const diagnostics: NarrationLine[] = [
      ...phaseEvents.map((event, index) =>
        eventAt(forkAtMs + index + 1, { event, sinceForkMs: index + 1 }),
      ),
      eventAt(forkAtMs + UTILITY_INIT_TIMEOUT_MS, {
        event: extendedEvent,
        startupDeadlineMs: UTILITY_INIT_TIMEOUT_MS,
        hardCapMs: UTILITY_WAIT_HARD_CAP_MS,
      }),
      eventAt(forkAtMs + UTILITY_WAIT_HARD_CAP_MS, {
        event: expiredEvent,
        budgetMs: UTILITY_WAIT_HARD_CAP_MS,
        graduated: true,
        termination: 'killed',
      }),
    ];
    const bootLog = (narration: readonly NarrationLine[]): string[] =>
      [...narration].sort((a, b) => a.at - b.at).map((entry) => entry.text);
    const withoutDiagnostics = bootLog(launch);
    const withDiagnostics = bootLog([...launch, ...diagnostics]);

    expect(launchAdvancementPhases(withoutDiagnostics).length).toBeGreaterThan(0);
    expect(launchAdvancementPhases(withDiagnostics)).toEqual(
      launchAdvancementPhases(withoutDiagnostics),
    );
    expect(
      launch.filter((line) => parseDeclaredPhaseBudget(line.text) !== undefined).length,
    ).toBeGreaterThan(0);
    expect(diagnostics.map((line) => parseDeclaredPhaseBudget(line.text))).toEqual(
      diagnostics.map(() => undefined),
    );
    expect(bootLogGapSummary(withoutDiagnostics).beatsSeen).toBeGreaterThan(0);
    expect(bootLogGapSummary(withDiagnostics).beatsSeen).toBe(
      bootLogGapSummary(withoutDiagnostics).beatsSeen,
    );
  });

  it('reads the line narrating a late kill as neither a heartbeat, a startup stage nor a declared budget', () => {
    const lateKillEvent = exportedEventName(UTILITY_WAIT_LATE_KILL_EVENT);
    expect(isBootHeartbeatEvent(BOOT_HEARTBEAT_EVENTS.utilityWait)).toBe(true);
    expect(isStartupMarkEvent(startupMarkLine('serverSpawned', 0).event)).toBe(true);
    expect(isBootHeartbeatEvent(lateKillEvent)).toBe(false);
    expect(isStartupMarkEvent(lateKillEvent)).toBe(false);

    const forkAtMs = MEASURED_FORK_OFFSETS[0];
    const launch = deepLinkNarration(forkAtMs);
    const lateKill = eventAt(forkAtMs + UTILITY_INIT_TIMEOUT_MS + SPAWN_WAIT_HEARTBEAT_MS, {
      event: lateKillEvent,
      pid: 10001,
      termination: 'killed',
    });
    const withoutLateKill = launch.map((line) => line.text);
    const withLateKill = [...withoutLateKill, lateKill.text];

    expect(launchAdvancementPhases(withoutLateKill).length).toBeGreaterThan(0);
    expect(launchAdvancementPhases(withLateKill)).toEqual(launchAdvancementPhases(withoutLateKill));
    expect(
      launch.filter((line) => parseDeclaredPhaseBudget(line.text) !== undefined).length,
    ).toBeGreaterThan(0);
    expect(parseDeclaredPhaseBudget(lateKill.text)).toBeUndefined();
    expect(bootLogGapSummary(withoutLateKill).beatsSeen).toBeGreaterThan(0);
    expect(bootLogGapSummary(withLateKill).beatsSeen).toBe(
      bootLogGapSummary(withoutLateKill).beatsSeen,
    );
  });
});

function sameInstantDecisionNarration(
  forkAtMs: number,
  graduationBeat: 'first' | 'a poll later',
  lastBeatElapsedMs: number,
): NarrationLine[] {
  const intervalBeat = utilityWaitBeatWrittenAt(
    forkAtMs,
    UTILITY_INIT_TIMEOUT_MS,
    UTILITY_INIT_TIMEOUT_MS,
  );
  const graduation = eventAt(
    forkAtMs + UTILITY_INIT_TIMEOUT_MS + (graduationBeat === 'first' ? 0 : BOOT_LOG_POLL_MS),
    {
      event: BOOT_HEARTBEAT_EVENTS.utilityWait,
      elapsedMs: UTILITY_INIT_TIMEOUT_MS,
      initTimeoutMs: UTILITY_WAIT_HARD_CAP_MS,
    },
  );
  const lines: NarrationLine[] = [
    ...deepLinkNarration(forkAtMs).slice(0, -1),
    ...(graduationBeat === 'first' ? [graduation, intervalBeat] : [intervalBeat, graduation]),
  ];
  for (
    let nominalMs = UTILITY_INIT_TIMEOUT_MS + SPAWN_WAIT_HEARTBEAT_MS;
    nominalMs <= lastBeatElapsedMs;
    nominalMs += SPAWN_WAIT_HEARTBEAT_MS
  ) {
    lines.push(
      utilityWaitBeatWrittenAt(forkAtMs, nominalMs + BOOT_LOG_POLL_MS, UTILITY_WAIT_HARD_CAP_MS),
    );
  }
  return lines;
}

describe('the graduated budget reaches the wait whichever of the two beats the app writes at its decision it reads first', () => {
  it.each([
    { graduationBeat: 'first', reachesTheLog: 'before the interval beat of the same instant' },
    {
      graduationBeat: 'a poll later',
      reachesTheLog: 'a poll after the interval beat, stamped with the same elapsed time',
    },
  ] as const)(
    'keeps waiting through a late first graduated heartbeat when the graduation beat reaches the log $reachesTheLog',
    async ({ graduationBeat }) => {
      const forkAtMs = MEASURED_FORK_OFFSETS[0];
      const windowAnswersAtElapsedMs = UTILITY_INIT_TIMEOUT_MS + 2 * SPAWN_WAIT_HEARTBEAT_MS;
      const windowAnswersAtMs = forkAtMs + windowAnswersAtElapsedMs - LAUNCH_RESOLVED_AT_MS;

      const withoutGraduationBeat = await waitForEditorWindowAnsweringAt(
        graduatingUtilityNarration(forkAtMs, {
          graduationBeat: false,
          decisionLateMs: 0,
          graduatedBeatsLateMs: BOOT_LOG_POLL_MS,
          lastBeatElapsedMs: windowAnswersAtElapsedMs,
        }),
        windowAnswersAtMs,
      );
      expect(withoutGraduationBeat.found).toBeUndefined();

      const outcome = await waitForEditorWindowAnsweringAt(
        sameInstantDecisionNarration(forkAtMs, graduationBeat, windowAnswersAtElapsedMs),
        windowAnswersAtMs,
      );
      expect(outcome).toEqual({ found: 'graduated-editor-page', gaveUpWith: undefined });
    },
  );
});

function slowForkNarration(): NarrationLine[] {
  const forkAtMs = BOOT_LOG_CAP_MS + LAUNCH_RESOLVED_AT_MS - SPAWN_WAIT_HEARTBEAT_MS;
  const lines: NarrationLine[] = [eventAt(0, { event: DESKTOP_BOOT_EVENT })];
  for (let at = SPAWN_WAIT_HEARTBEAT_MS; at < forkAtMs; at += SPAWN_WAIT_HEARTBEAT_MS) {
    lines.push(eventAt(at, { event: BOOT_HEARTBEAT_EVENTS.navigatorLoad, elapsedMs: at }));
  }
  lines.push(markAt('serverSpawned', forkAtMs), markAt('windowShown', forkAtMs + 1_300));
  for (
    let elapsedMs = SPAWN_WAIT_HEARTBEAT_MS;
    elapsedMs < UTILITY_INIT_TIMEOUT_MS;
    elapsedMs += SPAWN_WAIT_HEARTBEAT_MS
  ) {
    lines.push(
      eventAt(forkAtMs + elapsedMs, {
        event: BOOT_HEARTBEAT_EVENTS.utilityWait,
        elapsedMs,
        initTimeoutMs: UTILITY_INIT_TIMEOUT_MS,
      }),
    );
  }
  return lines;
}

describe('the extension keeps the probe running rather than only deferring the verdict', () => {
  it('finds a window that arrives after the static cap but inside the declared budget', async () => {
    const home = seedHome();
    mkdirSync(bootLogDirFor(home), { recursive: true });
    const clock = virtualClock(home, deepLinkNarration(MEASURED_FORK_OFFSETS[2]));
    const found = await waitForReadySignal<string>({
      home,
      what: 'editor window',
      probe: async () => (clock.now() > BOOT_LOG_CAP_MS ? 'late-editor-page' : undefined),
      now: clock.now,
      sleep: clock.sleep,
      readLog: clock.readLog,
      startDeadline: clock.startDeadline,
    });
    expect(found).toBe('late-editor-page');
    expect(clock.now()).toBeGreaterThan(BOOT_LOG_CAP_MS);
  });

  it('keeps probing past the static cap when the utility fork lands one heartbeat before it', async () => {
    const home = seedHome();
    mkdirSync(bootLogDirFor(home), { recursive: true });
    const clock = virtualClock(home, slowForkNarration());
    const found = await waitForReadySignal<string>({
      home,
      what: 'editor window',
      probe: async () => (clock.now() > BOOT_LOG_CAP_MS ? 'post-cap-editor-page' : undefined),
      now: clock.now,
      sleep: clock.sleep,
      readLog: clock.readLog,
      startDeadline: clock.startDeadline,
    });
    expect(found).toBe('post-cap-editor-page');
    expect(clock.now()).toBeGreaterThan(BOOT_LOG_CAP_MS);
  });

  it('stops blaming a probe that was outstanding when the static cap fired, once a startup stage read on that lap renews the wait', async () => {
    const home = seedHome();
    mkdirSync(bootLogDirFor(home), { recursive: true });
    const lines = syntheticLaunch({
      stages: [
        ...EVERY_STARTUP_PHASE.slice(0, EVERY_STARTUP_PHASE.indexOf('loadUrlResolved')).map(
          (phase) => stageLine(phase, -BOOT_LOG_POLL_MS),
        ),
        stageLine('loadUrlResolved', BOOT_LOG_CAP_MS),
      ],
      logsUntilMs: BOOT_LOG_CAP_MS + 2 * BOOT_LOG_STALL_MS,
    });
    const clock = virtualClock(
      home,
      lines.map((line) => ({ at: LAUNCH_RESOLVED_AT_MS + line.readableFromMs, text: line.text })),
    );
    let overranTheCap = false;
    const outcome = await waitForReadySignal<string>({
      home,
      what: 'editor window',
      probe: async () => {
        if (!overranTheCap && clock.now() >= BOOT_LOG_CAP_MS - BOOT_LOG_POLL_MS) {
          overranTheCap = true;
          await clock.sleep(BOOT_LOG_POLL_MS * 2);
        }
        return undefined;
      },
      now: clock.now,
      sleep: clock.sleep,
      readLog: clock.readLog,
      startDeadline: clock.startDeadline,
    }).then(
      () => ({ gaveUp: false, message: '' }),
      (error: unknown) => ({ gaveUp: true, message: (error as Error).message }),
    );
    expect(overranTheCap).toBe(true);
    expect(outcome.gaveUp).toBe(true);
    expect(
      clock.now(),
      'the wait kept probing past the lap the static cap preempted',
    ).toBeGreaterThan(BOOT_LOG_CAP_MS + BOOT_LOG_POLL_MS * 2);
    expect(outcome.message).not.toContain('The last probe had not answered when the cap fired.');
  });
});

describe('the stall rule applies only while boot narration is live', () => {
  const late = (mode: string) => {
    let polls = 0;
    return { evaluate: async () => (++polls >= 20 ? mode : undefined) };
  };
  const waitFor = (
    mode: WindowMode,
    page: { evaluate: () => Promise<string | undefined> },
    home: string,
  ) =>
    waitForWindowByMode({ windows: () => [page] }, mode, {
      home,
      stallMs: 150,
      pollMs: 20,
      capMs: 5_000,
    });

  it('arms it for a wait issued before the app has shown its first window', async () => {
    const home = seedHome([JSON.stringify({ event: DESKTOP_BOOT_EVENT })]);
    await expect(waitFor('editor', late('editor'), home)).rejects.toThrow(
      /logged no new boot activity/,
    );
    await expect(waitFor('navigator', late('navigator'), home)).rejects.toThrow(
      /logged no new boot activity/,
    );
  });

  it('drops it once boot is over, whatever the mode — the log is silent by design then', async () => {
    const home = seedHome([
      JSON.stringify({ event: DESKTOP_BOOT_EVENT }),
      markLine('windowShown', 3_000, '2026-09-04T00:00:03.000Z'),
    ]);
    const editor = late('editor');
    await expect(waitFor('editor', editor, home)).resolves.toBe(editor);
    const terminal = late('terminal');
    await expect(waitFor('terminal', terminal, home)).resolves.toBe(terminal);
  });

  const MID_WAIT_CAP_MS = 20_000;

  const BOOT_ONLY_SEED = [
    JSON.stringify({ event: DESKTOP_BOOT_EVENT, time: '2026-09-04T00:00:00.000Z' }),
  ];

  const windowShownMidWait = (seed: readonly string[]) => {
    let clock = 0;
    const lines = [...seed];
    const settled = waitForReadySignal<string>({
      probe: async () => undefined,
      home: '/unused',
      what: 'editor window',
      capMs: MID_WAIT_CAP_MS,
      now: () => clock,
      sleep: async () => {
        clock += 1_000;
        if (clock === 3_000) lines.push(markLine('windowShown', 3_000, '2026-09-04T00:00:03.000Z'));
      },
      readLog: () => snapshot({ lines, lineCount: lines.length, lastEvent: 'desktop.boot' }),
    });
    return { settled, gaveUpAt: () => clock };
  };

  it('disarms mid-wait when nothing the app declared is still open, so the cap decides', async () => {
    const run = windowShownMidWait(BOOT_ONLY_SEED);
    await expect(run.settled).rejects.toThrow(/kept logging boot activity/);
    expect(run.gaveUpAt()).toBeGreaterThan(BOOT_LOG_STALL_MS);
  });

  it('keeps it armed over that same narration plus one line the app never closed', async () => {
    const run = windowShownMidWait([
      ...BOOT_ONLY_SEED,
      markLine('serverSpawned', 500, '2026-09-04T00:00:00.500Z'),
    ]);
    await expect(run.settled).rejects.toThrow(/logged no new boot activity/);
    expect(run.gaveUpAt()).toBeLessThan(MID_WAIT_CAP_MS);
  });

  it('blames the open phase it stalled in, not a window it had already shown', async () => {
    const run = windowShownMidWait([
      ...BOOT_ONLY_SEED,
      markLine('serverSpawned', 500, '2026-09-04T00:00:00.500Z'),
    ]);
    const message = await run.settled.then(
      () => 'the wait resolved instead of giving up',
      (error: unknown) => (error as Error).message,
    );
    expect(message).not.toContain('until the first window is shown');
    expect(message).toContain('while a startup phase it declared is still open');
  });

  it('reads boot completion off the app mark, not off a mode list', () => {
    expect(hasBootCompleted([JSON.stringify({ event: DESKTOP_BOOT_EVENT })])).toBe(false);
    expect(hasBootCompleted([markLine('windowShown', 0, '2026-09-04T00:00:00.000Z')])).toBe(true);
    expect(
      hasBootCompleted([
        markLine('windowShown', 0, '2026-09-04T00:00:00.000Z'),
        JSON.stringify({ event: DESKTOP_BOOT_EVENT, time: '2026-09-04T00:01:00.000Z' }),
      ]),
    ).toBe(false);
  });
});

describe('boot-log evidence survives a spec that removes its own launch home', () => {
  it('snapshots the boot log when the wait ends, not at teardown', async () => {
    const home = seedHome([
      JSON.stringify({ time: '2026-09-04T00:00:00.000Z', event: DESKTOP_BOOT_EVENT }),
      markLine('appReady', 0, '2026-09-04T00:00:01.000Z'),
    ]);
    const editor = { evaluate: async () => 'editor' };
    const app = { windows: () => [editor] };
    rememberLaunchHome(app, home);
    await waitForWindowByMode(app, 'editor');
    rmSync(home, { recursive: true, force: true });
    expect(readBootLogLines(home)).toEqual([]);
    expect(tryBootLogFor(app)).toHaveLength(2);
  });

  it('remembers nothing when the app never logged, so callers can say so', async () => {
    const editor = { evaluate: async () => 'editor' };
    const app = { windows: () => [editor] };
    rememberLaunchHome(app, seedHome());
    await waitForWindowByMode(app, 'editor');
    expect(tryBootLogFor(app)).toBeUndefined();
  });

  it('remembers the narration a give-up read, so a removed log dir cannot erase it', async () => {
    const narration = [
      JSON.stringify({ time: '2026-09-04T00:00:00.000Z', event: DESKTOP_BOOT_EVENT }),
      markLine('appReady', 0, '2026-09-04T00:00:01.000Z'),
      markLine('serverSpawned', 500, '2026-09-04T00:00:01.500Z'),
    ];
    const home = seedHome(narration);
    const app = { windows: () => [] };
    rememberLaunchHome(app, home);
    await expect(
      waitForWindowByMode(app, 'editor', { capMs: 300, stallMs: 600_000, pollMs: 20 }),
    ).rejects.toThrow(/did not arrive/);
    expect(tryFirstWaitFor(app)).toMatchObject({ gaveUp: true, reason: 'cap' });
    rmSync(join(home, '.ok'), { recursive: true, force: true });
    expect(readBootLogLines(home)).toEqual([]);
    expect(tryBootLogFor(app)).toEqual(narration);
  });

  it('remembers the narration even when the give-up probe never answered', async () => {
    const narration = [
      JSON.stringify({ time: '2026-09-04T00:00:00.000Z', event: DESKTOP_BOOT_EVENT }),
      markLine('appReady', 0, '2026-09-04T00:00:01.000Z'),
      markLine('serverSpawned', 500, '2026-09-04T00:00:01.500Z'),
    ];
    const home = seedHome(narration);
    const stuck = Promise.withResolvers<string | undefined>();
    let answered = false;
    const page = {
      evaluate: () =>
        stuck.promise.then((mode) => {
          answered = true;
          return mode;
        }),
    };
    const app = { windows: () => [page] };
    rememberLaunchHome(app, home);
    await expect(
      waitForWindowByMode(app, 'editor', { capMs: 300, stallMs: 600_000, pollMs: 20 }),
    ).rejects.toThrow(/did not arrive/);
    const probeAnswered = answered;
    stuck.resolve(undefined);
    expect({ probeAnswered, wait: tryFirstWaitFor(app) }).toMatchObject({
      probeAnswered: false,
      wait: { gaveUp: true, reason: 'cap' },
    });
    rmSync(join(home, '.ok'), { recursive: true, force: true });
    expect(tryBootLogFor(app)).toEqual(narration);
  });

  it('still remembers nothing when a give-up found no log, so unavailable stays honest', async () => {
    const app = { windows: () => [] };
    rememberLaunchHome(app, seedHome());
    await expect(
      waitForWindowByMode(app, 'editor', { capMs: 300, stallMs: 600_000, pollMs: 20 }),
    ).rejects.toThrow(/did not arrive/);
    expect(tryFirstWaitFor(app)).toMatchObject({ gaveUp: true, reason: 'notfound' });
    expect(tryBootLogFor(app)).toBeUndefined();
  });

  it('keeps the fuller narration when a later wait reads a log that has since shrunk', async () => {
    const opening = JSON.stringify({ time: '2026-09-04T00:00:00.000Z', event: DESKTOP_BOOT_EVENT });
    const whole = [
      opening,
      markLine('appReady', 0, '2026-09-04T00:00:01.000Z'),
      markLine('serverLockReady', 14_428, '2026-09-04T00:00:14.428Z'),
    ];
    const home = seedHome(whole);
    const editor = { evaluate: async () => 'editor' };
    const app = { windows: () => [editor] };
    rememberLaunchHome(app, home);
    await waitForWindowByMode(app, 'editor');
    expect(tryBootLogFor(app)).toEqual(whole);

    writeFileSync(join(bootLogDirFor(home), 'desktop.2026-09-03.log'), `${opening}\n`, 'utf8');
    expect(readBootLogLines(home)).toEqual([opening]);

    await waitForWindowByMode(app, 'editor');
    expect(tryBootLogFor(app)).toEqual(whole);
  });
});

describe('the teardown line reports the most complete narration the run produced', () => {
  const early = [
    JSON.stringify({ time: '2026-09-04T00:00:00.000Z', event: DESKTOP_BOOT_EVENT }),
    markLine('appReady', 0, '2026-09-04T00:00:01.000Z'),
  ];
  const whole = [
    ...early,
    markLine('serverLockReady', 14_428, '2026-09-04T00:00:14.428Z'),
    markLine('windowCreated', 14_521, '2026-09-04T00:00:14.521Z'),
    markLine('loadUrlResolved', 18_569, '2026-09-04T00:00:18.569Z'),
  ];

  it('prefers the longer on-disk log to a snapshot taken earlier in the run', () => {
    const onDisk = readBootLog(seedHome(whole));
    expect(onDisk.lines).toEqual(whole);
    const gap = bootGapLineFor({
      slot: 0,
      narration: bootNarrationFor(early, onDisk),
      readyWaitCount: 1,
      homeShared: false,
    });
    expect(gap.summary?.lineCount).toBe(whole.length);
    expect(gap.reason).toBeUndefined();
  });

  it('keeps the snapshot when the disk read came back empty', () => {
    const onDisk = readBootLog(seedHome());
    expect(onDisk.lines).toEqual([]);
    const gap = bootGapLineFor({
      slot: 0,
      narration: bootNarrationFor(whole, onDisk),
      readyWaitCount: 1,
      homeShared: false,
    });
    expect(gap.summary?.lineCount).toBe(whole.length);
    expect(gap.source).toBe('wait-snapshot');
  });

  it('names no cause at all when it has narration to report', () => {
    const gap = bootGapLineFor({
      slot: 0,
      narration: bootNarrationFor(early, readBootLog(seedHome(whole))),
      readyWaitCount: 1,
      homeShared: false,
    });
    expect(gap.summary).toBeDefined();
    expect(gap.reason).toBeUndefined();
  });

  it('names the cause it can see when neither side narrated anything at all', () => {
    const onDisk = readBootLog(seedHome());
    expect(onDisk.exists).toBe(false);
    const gap = bootGapLineFor({
      slot: 0,
      narration: bootNarrationFor(undefined, onDisk),
      readyWaitCount: 1,
      homeShared: false,
    });
    expect({ summary: gap.summary, source: gap.source, reason: gap.reason }).toEqual({
      summary: undefined,
      source: 'unavailable',
      reason:
        'no desktop log file when the fixture read it; the cause is not determined here (it may have been removed, never written, or written elsewhere)',
    });
  });

  it('credits the disk read when the disk read is what it reported', () => {
    const onDisk = readBootLog(seedHome(whole));
    expect(onDisk.lines).toEqual(whole);
    expect(
      bootGapLineFor({
        slot: 0,
        narration: bootNarrationFor(early, onDisk),
        readyWaitCount: 1,
        homeShared: false,
      }).source,
    ).toBe('teardown-read');
    expect(
      bootGapLineFor({
        slot: 0,
        narration: bootNarrationFor(early, onDisk),
        readyWaitCount: 1,
        homeShared: true,
      }).source,
    ).toBe('teardown-read-shared-home');
  });

  it('labels a give-up snapshot by the wait that took it, not by a boot that never completed', async () => {
    const home = seedHome(early);
    const app = { windows: () => [] };
    rememberLaunchHome(app, home);
    await expect(
      waitForWindowByMode(app, 'editor', { capMs: 300, stallMs: 600_000, pollMs: 20 }),
    ).rejects.toThrow(/did not arrive/);
    rmSync(join(home, '.ok'), { recursive: true, force: true });
    const firstWait = tryFirstWaitFor(app);
    const gap = bootGapLineFor({
      slot: 0,
      narration: bootNarrationFor(tryBootLogFor(app), readBootLog(home)),
      readyWaitCount: readyWaitsFor(app)?.length ?? 0,
      ...(firstWait === undefined ? {} : { firstWait }),
      homeShared: false,
    });
    expect(gap.summary?.lineCount).toBe(early.length);
    expect({ source: gap.source, bootComplete: gap.summary?.bootComplete }).toEqual({
      source: 'wait-snapshot',
      bootComplete: false,
    });
  });
});
describe('the recorded ready wait names which wait it measured', () => {
  const slowFirstPoll = () => {
    const editor = { evaluate: async () => 'editor' };
    let polls = 0;
    return { windows: () => (polls++ === 0 ? [] : [editor]) };
  };

  it('carries the cap that actually bounded it, not the module default', async () => {
    const app = slowFirstPoll();
    rememberLaunchHome(app, seedHome());
    await waitForWindowByMode(app, 'editor', { pollMs: 80, capMs: 9_000 });
    const wait = tryFirstWaitFor(app);
    expect(wait?.what).toBe('editor window');
    expect(wait?.capMs).toBe(9_000);
    expect(wait?.gaveUp).toBe(false);
    expect(wait?.elapsedMs).toBeGreaterThanOrEqual(50);
  });

  it('carries the deadline the app bought it, beside the cap its caller asked for', async () => {
    const home = seedHome([
      JSON.stringify({ event: DESKTOP_BOOT_EVENT, time: '2026-09-04T00:00:00.000Z' }),
      markLine('serverSpawned', 500, '2026-09-04T00:00:00.500Z'),
      JSON.stringify({
        time: '2026-09-04T00:00:05.500Z',
        event: BOOT_HEARTBEAT_EVENTS.utilityWait,
        elapsedMs: SPAWN_WAIT_HEARTBEAT_MS,
        initTimeoutMs: UTILITY_INIT_TIMEOUT_MS,
      }),
    ]);
    const app = slowFirstPoll();
    rememberLaunchHome(app, home);
    await waitForWindowByMode(app, 'editor', { pollMs: 20, capMs: 300 });
    const wait = tryFirstWaitFor(app);
    expect(wait?.requestedCapMs).toBe(300);
    expect(wait?.capMs).toBeGreaterThan(300);
  });

  it('carries the deadline a startup stage bought it into the record and the triage line, beside the cap its caller asked for', async () => {
    const home = seedHome([
      JSON.stringify({ event: DESKTOP_BOOT_EVENT, time: '2026-09-04T00:00:00.000Z' }),
      markLine('appReady', 0, '2026-09-04T00:00:00.100Z'),
    ]);
    const editor = { evaluate: async () => 'editor' };
    let windowsCalls = 0;
    const app = {
      windows: () => {
        windowsCalls += 1;
        if (windowsCalls === 2) {
          appendFileSync(
            join(bootLogDirFor(home), 'desktop.2026-09-03.log'),
            `${markLine('loadUrlResolved', 900, '2026-09-04T00:00:00.900Z')}\n`,
            'utf8',
          );
        }
        return windowsCalls >= 3 ? [editor] : [];
      },
    };
    rememberLaunchHome(app, home);
    const requestedCapMs = BOOT_LOG_STALL_MS / 2;
    try {
      await expect(
        waitForWindowByMode(app, 'editor', { pollMs: 20, capMs: requestedCapMs }),
      ).resolves.toBe(editor);
      const wait = tryFirstWaitFor(app);
      expect(wait?.advancements.map((advancement) => advancement.event)).toContain(
        'desktop.startup.loadUrlResolved',
      );
      expect(wait?.requestedCapMs).toBe(requestedCapMs);
      expect(wait?.capMs).toBeGreaterThan(requestedCapMs);
      expect(wait?.capMs).toBeLessThanOrEqual(requestedCapMs + BOOT_LOG_STALL_MS);
      const line = formatBootGapLine(
        bootGapLineFor({
          slot: 0,
          narration: bootNarrationFor(tryBootLogFor(app), readBootLog(home)),
          readyWaitCount: readyWaitsFor(app)?.length ?? 0,
          ...(wait === undefined ? {} : { firstWait: wait }),
          homeShared: false,
        }),
      );
      expect(line).toContain(`firstWaitCapMs=${wait?.capMs}`);
      expect(line).toContain(`firstWaitRequestedCapMs=${requestedCapMs}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports the first wait, not a later re-find of an already-open window', async () => {
    const app = slowFirstPoll();
    rememberLaunchHome(app, seedHome());
    await waitForWindowByMode(app, 'editor', { pollMs: 80 });
    await waitForWindowByMode(app, 'editor', { capMs: 10_000 });
    const waits = readyWaitsFor(app) ?? [];
    expect(waits).toHaveLength(2);
    const launch = tryFirstWaitFor(app);
    expect(launch?.ordinal).toBe(0);
    expect(launch?.capMs).toBe(BOOT_LOG_CAP_MS);
    expect(launch?.elapsedMs).toBeGreaterThan(waits[1]?.elapsedMs ?? Number.POSITIVE_INFINITY);
  });

  it('records the wait that gave up, so the over-cap sample is not dropped', async () => {
    const app = { windows: () => [] };
    rememberLaunchHome(app, seedHome());
    await expect(waitForWindowByMode(app, 'editor', { capMs: 300, pollMs: 60 })).rejects.toThrow();
    const wait = tryFirstWaitFor(app);
    expect(wait?.gaveUp).toBe(true);
    expect(wait?.capMs).toBe(300);
    expect(wait?.reason).toBe('notfound');
  });

  it('separates a cap fired over a narrating app from one that never logged', async () => {
    const app = { windows: () => [] };
    rememberLaunchHome(
      app,
      seedHome([
        JSON.stringify({ time: '2026-09-04T00:00:00.000Z', event: DESKTOP_BOOT_EVENT }),
        markLine('appReady', 0, '2026-09-04T00:00:01.000Z'),
      ]),
    );
    const error = await waitForWindowByMode(app, 'editor', { capMs: 300, pollMs: 60 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(tryFirstWaitFor(app)?.reason).toBe('cap');
    const message = (error as Error).message;
    expect(message).toContain('though the app kept logging boot activity');
    expect(message).not.toContain('The last probe had not answered');
  });
});

describe('one classifier decides both the prose and the reason token', () => {
  it('calls a per-file read failure unreadable, though the directory itself read fine', () => {
    expect(
      classifyBootLog(
        snapshot({
          exists: true,
          unreadableFiles: ['desktop.2026-09-04.log (EBUSY)'],
          lineCount: 3,
        }),
      ),
    ).toBe('unreadable');
  });

  it('keeps unreadable ahead of notfound, which co-occur whenever the directory itself failed', () => {
    expect(classifyBootLog(snapshot({ exists: false, unreadableReason: 'EACCES' }))).toBe(
      'unreadable',
    );
    expect(classifyBootLog(snapshot({ exists: false }))).toBe('notfound');
  });

  it('names the teardown states it can tell apart, without claiming a cause it cannot know', () => {
    expect(describeMissingBootLog(snapshot({ exists: false }))).toBe(
      'no desktop log file when the fixture read it; the cause is not determined here (it may have been removed, never written, or written elsewhere)',
    );
    expect(describeMissingBootLog(snapshot({ exists: true, lineCount: 0 }))).toBe(
      'log files present but empty',
    );
    expect(describeMissingBootLog(snapshot({ exists: true, lineCount: 4 }))).toBe(
      'log files present and readable',
    );
  });

  it('names which half of an unreadable log failed, so a dir fault is not read as a file fault', () => {
    expect(describeMissingBootLog(snapshot({ exists: false, unreadableReason: 'EACCES' }))).toBe(
      'log dir unreadable (EACCES)',
    );
    expect(
      describeMissingBootLog(
        snapshot({
          exists: true,
          lineCount: 3,
          unreadableFiles: ['desktop.2026-09-04.log (EBUSY)'],
        }),
      ),
    ).toBe('log files unreadable: desktop.2026-09-04.log (EBUSY)');
  });

  it('separates a log that was opened and never written from one that is absent', () => {
    expect(classifyBootLog(snapshot({ exists: true, lineCount: 0 }))).toBe('empty');
    expect(classifyBootLog(snapshot({ exists: true, lineCount: 4 }))).toBe('ok');
  });

  it('maps every log state to its reason, so the token cannot blame the app for a runner fault', () => {
    const locked = snapshot({
      exists: true,
      lineCount: 3,
      unreadableFiles: ['desktop.2026-09-04.log (EBUSY)'],
    });
    expect(giveUpReason('stall', locked)).toBe('unreadable');
    expect(giveUpReason('cap', locked)).toBe('unreadable');
    expect(giveUpReason('cap', snapshot({ exists: false, unreadableReason: 'EACCES' }))).toBe(
      'unreadable',
    );
    expect(giveUpReason('cap', snapshot({ exists: false }))).toBe('notfound');
    expect(giveUpReason('cap', snapshot({ exists: true, lineCount: 0 }))).toBe('empty');
    expect(giveUpReason('cap', snapshot({ exists: true, lineCount: 4 }))).toBe('cap');
    expect(giveUpReason('stall', snapshot({ exists: true, lineCount: 4 }))).toBe('stall');
  });

  it('names the fault and declines to blame the app in one message, on the unreadable path', async () => {
    let clock = 0;
    const locked = snapshot({
      exists: true,
      lineCount: 3,
      unreadableFiles: ['desktop.2026-09-04.log (EBUSY)'],
    });
    expect(classifyBootLog(locked)).toBe('unreadable');
    const error = await waitForReadySignal<string>({
      probe: async () => undefined,
      home: '/unused',
      what: 'editor window',
      capMs: 500,
      now: () => clock,
      sleep: async () => {
        clock += 100;
      },
      readLog: () => locked,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/UNREADABLE files: [\s\S]*not evidence about the app/);
    expect((error as Error).message).toContain('and the boot log cannot say why');
  });

  it('records stall as the reason on the path that already drives it', async () => {
    const home = seedHome([JSON.stringify({ event: DESKTOP_BOOT_EVENT })]);
    const app = { windows: () => [{ evaluate: async () => 'navigator' }] };
    rememberLaunchHome(app, home);
    await expect(
      waitForWindowByMode(app, 'editor', { home, stallMs: 150, pollMs: 20, capMs: 5_000 }),
    ).rejects.toThrow(/logged no new boot activity/);
    expect(tryFirstWaitFor(app)?.reason).toBe('stall');
  });
});

describe('boot-log unreadability is not blamed on the app', () => {
  it('separates a permissions/fd failure from "the app never logged"', async () => {
    let clock = 0;
    await expect(
      waitForReadySignal<string>({
        probe: async () => undefined,
        home: '/unused',
        what: 'editor window',
        now: () => clock,
        sleep: async () => {
          clock += 1_000;
        },
        readLog: () => snapshot({ exists: false, unreadableReason: 'EACCES' }),
      }),
    ).rejects.toThrow(/UNREADABLE, EACCES .*runner\s+filesystem problem/s);
  });

  it('still says NOT FOUND when the directory is simply absent', () => {
    const s = readBootLog(seedHome());
    expect(s.exists).toBe(false);
    expect(s.unreadableReason).toBeUndefined();
  });
});

describe('bootGapSourceFor', () => {
  it('labels every combination the teardown loop can produce', () => {
    expect(bootGapSourceFor({ hasLines: false, snapshotted: false, homeShared: false })).toBe(
      'unavailable',
    );
    expect(bootGapSourceFor({ hasLines: false, snapshotted: false, homeShared: true })).toBe(
      'unavailable',
    );
    expect(bootGapSourceFor({ hasLines: true, snapshotted: true, homeShared: false })).toBe(
      'wait-snapshot',
    );
    expect(bootGapSourceFor({ hasLines: true, snapshotted: true, homeShared: true })).toBe(
      'wait-snapshot',
    );
    expect(bootGapSourceFor({ hasLines: true, snapshotted: false, homeShared: false })).toBe(
      'teardown-read',
    );
    expect(bootGapSourceFor({ hasLines: true, snapshotted: false, homeShared: true })).toBe(
      'teardown-read-shared-home',
    );
  });
});

describe('isMoreCompleteNarration', () => {
  it('accepts a candidate that says more than what is already held', () => {
    expect(isMoreCompleteNarration(['a', 'b'], ['a'])).toBe(true);
    expect(isMoreCompleteNarration(['a'], undefined)).toBe(true);
  });

  it('rejects a candidate that says the same or less, so a tie keeps what is held', () => {
    expect(isMoreCompleteNarration(['a'], ['a', 'b'])).toBe(false);
    expect(isMoreCompleteNarration(['b'], ['a'])).toBe(false);
    expect(isMoreCompleteNarration([], undefined)).toBe(false);
  });
});

describe('formatBootGapLine', () => {
  it('states the measured gap next to the bound it has to clear', () => {
    const line = formatBootGapLine({
      slot: 0,
      source: 'wait-snapshot',
      readyWaitCount: 2,
      firstWait: {
        ordinal: 0,
        what: 'editor window',
        elapsedMs: 2_100,
        capMs: 9_000,
        requestedCapMs: 9_000,
        gaveUp: false,
        reason: 'none',
        advancements: [
          { event: 'desktop.startup.windowCreated', atMs: 900 },
          { event: 'desktop.startup.loadUrlResolved', atMs: 1_600 },
        ],
      },
      summary: bootLogGapSummary([
        markLine('appReady', 0, '2026-09-04T00:00:00.000Z'),
        markLine('serverSpawned', 1_400, '2026-09-04T00:00:01.400Z'),
        markLine('windowShown', 3_000, '2026-09-04T00:00:03.000Z'),
      ]),
    });
    expect(line).toContain('[boot-gap] slot=0');
    expect(line).toContain('source=wait-snapshot');
    expect(line).toContain(`stallMs=${BOOT_LOG_STALL_MS}`);
    expect(line).toContain('totalBootMs=3000');
    expect(line).toContain('maxGapMs=1600');
    expect(line).toContain('firstWaitMs=2100');
    expect(line).toContain('firstWaitCapMs=9000');
    expect(line).toContain('firstWaitRequestedCapMs=9000');
    expect(line).not.toContain(`firstWaitCapMs=${BOOT_LOG_CAP_MS}`);
    expect(line).toContain('firstWaitWhat="editor window"');
    expect(line).toContain('firstWaitGaveUp=false');
    expect(line).toContain('firstWaitReason=none');
    expect(line).toContain('readyWaitCount=2');
    expect(line).toContain('bootComplete=true');
  });

  it('separates the deadline the wait ran to from the one its caller asked for', () => {
    const line = formatBootGapLine({
      slot: 0,
      source: 'wait-snapshot',
      readyWaitCount: 1,
      firstWait: {
        ordinal: 0,
        what: 'editor window',
        elapsedMs: 30_100,
        capMs: 30_000,
        requestedCapMs: BOOT_LOG_CAP_MS,
        gaveUp: true,
        reason: 'cap',
        advancements: [],
      },
      summary: undefined,
      reason: 'no summary',
    });
    expect(line).toContain('firstWaitCapMs=30000');
    expect(line).toContain(`firstWaitRequestedCapMs=${BOOT_LOG_CAP_MS}`);
  });

  it('says why there is no measurement rather than printing a zero', () => {
    const line = formatBootGapLine({
      slot: 1,
      source: 'unavailable',
      summary: undefined,
      reason: 'log dir gone at teardown',
    });
    expect(line).toContain('slot=1');
    expect(line).toContain('source=unavailable');
    expect(line).toContain('reason="log dir gone at teardown"');
    expect(line).toContain('firstWaitMs=none');
    expect(line).toContain('firstWaitCapMs=none');
    expect(line).toContain('firstWaitRequestedCapMs=none');
    expect(line).toContain('firstWaitWhat=none');
    expect(line).toContain('firstWaitGaveUp=none');
    expect(line).toContain('firstWaitReason=none');
    expect(line).toContain('readyWaitCount=0');
    expect(line).not.toContain('maxGapMs');
  });

  it('emits every give-up reason from the closed set, so a new one cannot appear unannounced', () => {
    expect([...READY_WAIT_GIVE_UP_REASONS]).toEqual([
      'stall',
      'cap',
      'unreadable',
      'notfound',
      'empty',
      'none',
    ]);
    for (const reason of READY_WAIT_GIVE_UP_REASONS) {
      const line = formatBootGapLine({
        slot: 0,
        source: 'wait-snapshot',
        readyWaitCount: 1,
        firstWait: {
          ordinal: 0,
          what: 'editor window',
          elapsedMs: 25_000,
          capMs: BOOT_LOG_CAP_MS,
          requestedCapMs: BOOT_LOG_CAP_MS,
          advancements: [],
          gaveUp: reason !== 'none',
          reason,
        },
        summary: undefined,
        reason: 'no summary',
      });
      expect(line).toContain(`firstWaitReason=${reason}`);
      expect(line).toContain(reason === 'none' ? 'firstWaitGaveUp=false' : 'firstWaitGaveUp=true');
    }
  });
});

describe('the cap bounds the wait itself, not only the gaps between polls', () => {
  const RELEASE_AFTER_MS = 5_000;

  function heldProbe<T>() {
    const gate = Promise.withResolvers<T | undefined>();
    let calls = 0;
    return {
      probe: async () => {
        calls += 1;
        return gate.promise;
      },
      hit: (value: T) => gate.resolve(value),
      miss: () => gate.resolve(undefined),
      calls: () => calls,
    };
  }

  function timerDeadline(ms: number) {
    const reached = Promise.withResolvers<void>();
    const timer = setTimeout(reached.resolve, ms);
    return { expired: reached.promise, cancel: () => clearTimeout(timer) };
  }

  function narratingHome(): string {
    return seedHome([
      JSON.stringify({ time: '2026-09-04T00:00:00.000Z', event: DESKTOP_BOOT_EVENT }),
      markLine('appReady', 0, '2026-09-04T00:00:01.000Z'),
      markLine('serverSpawned', 500, '2026-09-04T00:00:01.500Z'),
    ]);
  }

  it('gives up at the cap while the probe is still pending', async () => {
    const gate = heldProbe<string>();
    let released = false;
    const release = setTimeout(() => {
      released = true;
      gate.miss();
    }, RELEASE_AFTER_MS);
    const error = await waitForReadySignal<string>({
      probe: gate.probe,
      home: narratingHome(),
      what: 'editor window',
      capMs: 80,
      stallMs: 600_000,
      pollMs: 10,
    }).catch((e: unknown) => e);
    clearTimeout(release);
    gate.miss();
    expect(released).toBe(false);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/did not arrive within \d+ms\./);
    expect((error as Error).message).not.toContain('though the app kept logging boot activity');
    expect((error as Error).message).toContain(
      'The last probe had not answered when the cap fired.',
    );
    expect(gate.calls()).toBe(1);
  });

  it('discards a hit that arrives after the cap instead of reporting it as success', async () => {
    const gate = heldProbe<string>();
    let released = false;
    const release = setTimeout(() => {
      released = true;
      gate.hit('late-editor-page');
    }, RELEASE_AFTER_MS);
    const outcome = await waitForReadySignal<string>({
      probe: gate.probe,
      home: narratingHome(),
      what: 'editor window',
      capMs: 80,
      stallMs: 600_000,
      pollMs: 10,
    }).then(
      (value) => ({ resolvedWith: value }),
      (error: unknown) => ({ rejectedWith: (error as Error).message }),
    );
    clearTimeout(release);
    gate.hit('late-editor-page');
    expect(released).toBe(false);
    expect(outcome).not.toHaveProperty('resolvedWith');
    expect(outcome).toMatchObject({ rejectedWith: expect.stringMatching(/did not arrive/) });
  });

  it('swallows a probe rejection that arrives after the cap, so no worker dies of it', () => {
    const script = join(mkdtempSync(join(tmpdir(), 'ok-readiness-strict-')), 'late-rejection.mjs');
    writeFileSync(
      script,
      [
        'const { waitForReadySignal } = await import(process.argv[2]);',
        'let fail = (error) => { throw error; };',
        'const gate = new Promise((_resolve, reject) => { fail = reject; });',
        "setTimeout(() => fail(new Error('renderer detached after the cap')), 250);",
        'const error = await waitForReadySignal({',
        '  probe: async () => gate,',
        '  home: process.argv[3],',
        "  what: 'editor window',",
        '  capMs: 60,',
        '  stallMs: 600_000,',
        '  pollMs: 10,',
        '}).catch((e) => e);',
        "if (!(error instanceof Error)) { console.error('the wait did not give up'); process.exit(2); }",
        'await new Promise((r) => setTimeout(r, 600));',
        "console.log('survived');",
      ].join('\n'),
      'utf8',
    );
    const run = spawnSync(
      process.execPath,
      [
        '--unhandled-rejections=strict',
        script,
        new URL('./launch-readiness.ts', import.meta.url).href,
        narratingHome(),
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
    expect({
      status: run.status,
      stdout: run.stdout.trim(),
      stderr: run.stderr.trim(),
    }).toEqual({ status: 0, stdout: 'survived', stderr: '' });
  });

  it('records a give-up when no editor exists and one window never answers', async () => {
    let releaseStuck: () => void = () => {};
    const stuck = {
      evaluate: () =>
        new Promise<string | undefined>((resolve) => {
          releaseStuck = () => resolve('navigator');
        }),
    };
    const navigator = { evaluate: async () => 'navigator' };
    const app = { windows: () => [stuck, navigator] };
    rememberLaunchHome(app, narratingHome());
    let released = false;
    const release = setTimeout(() => {
      released = true;
      releaseStuck();
    }, RELEASE_AFTER_MS);
    const outcome = await waitForWindowByMode(app, 'editor', {
      capMs: 80,
      stallMs: 600_000,
      pollMs: 10,
    }).then(
      (page) => ({ resolvedWith: page }),
      (error: unknown) => ({ rejectedWith: (error as Error).message }),
    );
    clearTimeout(release);
    releaseStuck();
    expect(released).toBe(false);
    expect(outcome).not.toHaveProperty('resolvedWith');
    expect(outcome).toMatchObject({ rejectedWith: expect.stringMatching(/did not arrive/) });
    expect(outcome).toMatchObject({
      rejectedWith: expect.stringContaining('The last probe had not answered when the cap fired.'),
    });
    expect(tryFirstWaitFor(app)).toMatchObject({ gaveUp: true, reason: 'cap', capMs: 80 });
  });

  it('lets the deadline end the wait even when the caller supplies a clock of its own', async () => {
    const gate = heldProbe<string>();
    let reachDeadline: () => void = () => {};
    const outcome = waitForReadySignal<string>({
      probe: gate.probe,
      home: '/unused',
      what: 'editor window',
      capMs: 600_000,
      stallMs: 600_000,
      pollMs: 1,
      now: () => 0,
      readLog: () => snapshot({ lineCount: 3, lastEvent: 'desktop.startup.serverSpawned' }),
      startDeadline: () => ({
        expired: new Promise<void>((resolve) => {
          reachDeadline = resolve;
        }),
        cancel: () => {},
      }),
    }).then(
      (value) => ({ resolvedWith: value }),
      (error: unknown) => ({ rejectedWith: (error as Error).message }),
    );
    await Promise.resolve();
    reachDeadline();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const settledOrStillWaiting = await Promise.race([
      outcome,
      new Promise<{ stillWaiting: true }>((resolve) => {
        watchdog = setTimeout(() => resolve({ stillWaiting: true }), 2_000);
      }),
    ]);
    clearTimeout(watchdog);
    gate.hit('editor-page');
    expect(settledOrStillWaiting).toMatchObject({
      rejectedWith: expect.stringMatching(/did not arrive within 0ms/),
    });
  });

  it('arms one deadline for the whole wait, not a fresh one per poll', async () => {
    const gate = heldProbe<string>();
    let polls = 0;
    let armings = 0;
    let released = false;
    const release = setTimeout(() => {
      released = true;
      gate.miss();
    }, RELEASE_AFTER_MS);
    const error = await waitForReadySignal<string>({
      probe: async () => (polls++ < 3 ? undefined : gate.probe()),
      home: narratingHome(),
      what: 'editor window',
      capMs: 400,
      stallMs: 600_000,
      pollMs: 5,
      startDeadline: (ms) => {
        armings += 1;
        return timerDeadline(ms);
      },
    }).catch((e: unknown) => e);
    clearTimeout(release);
    gate.miss();
    expect({ released, armings }).toEqual({ released: false, armings: 1 });
    expect(polls).toBeGreaterThan(1);
    expect((error as Error).message).toContain(
      'The last probe had not answered when the cap fired.',
    );
  });

  it('reports a stall over a latched lap without claiming the probe was outstanding', async () => {
    let clock = 0;
    let sleeps = 0;
    let probes = 0;
    let reachDeadline: () => void = () => {};
    const error = await waitForReadySignal<string>({
      probe: async () => {
        probes += 1;
        throw new Error('Execution context was destroyed');
      },
      home: '/unused',
      what: 'editor window',
      capMs: 600_000,
      stallMs: 150,
      liveness: 'boot',
      pollMs: 1,
      now: () => clock,
      sleep: () =>
        new Promise((resolve) => {
          sleeps += 1;
          clock += 200;
          if (sleeps === 1) reachDeadline();
          setTimeout(resolve, 0);
        }),
      readLog: () => snapshot({ lineCount: 3, lastEvent: 'desktop.startup.serverSpawned' }),
      startDeadline: () => ({
        expired: new Promise<void>((resolve) => {
          reachDeadline = resolve;
        }),
        cancel: () => {},
      }),
    }).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(probes).toBe(1);
    expect(message).toContain('Probe threw on 1 of 1 polls');
    expect(message).toContain('logged no new boot activity for 150ms (gave up after 200ms)');
    expect(message).not.toContain('The last probe had not answered');
  });

  it('discloses the pending probe even when a later-poll hang trips the stall clock first', async () => {
    const gate = heldProbe<string>();
    let polls = 0;
    let released = false;
    const release = setTimeout(() => {
      released = true;
      gate.miss();
    }, RELEASE_AFTER_MS);
    const error = await waitForReadySignal<string>({
      probe: async () => (polls++ < 2 ? undefined : gate.probe()),
      home: '/unused',
      what: 'editor window',
      capMs: 400,
      stallMs: 120,
      liveness: 'boot',
      pollMs: 5,
      readLog: () => snapshot({ lineCount: 3, lastEvent: 'desktop.startup.serverSpawned' }),
    }).catch((e: unknown) => e);
    clearTimeout(release);
    gate.miss();
    const message = (error as Error).message;
    expect(released).toBe(false);
    expect(message).toMatch(/logged no new boot activity/);
    expect(message).toContain('The last probe had not answered when the cap fired.');
  });
});

interface RecordedFirstWait {
  source: {
    workflowRun: string;
    job: string;
    traceAttachment: { name: string; sha1: string };
  };
  trace: { launchElectronEnd: string; evaluateStart: string; evaluateEnd: string };
  lane: { bootGapLine: string; giveUpDiagnostics: string[] };
  bootLog: string[];
}

const RECORDED_FIRST_WAIT = JSON.parse(
  readFileSync(
    new URL(
      './fixtures/recorded-first-wait-windows-terminal-tabs-2026-09-24.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as RecordedFirstWait;

const RECORDED_WAIT_STARTED_AT = Date.parse(RECORDED_FIRST_WAIT.trace.launchElectronEnd);

function sinceRecordedWaitStarted(iso: string): number {
  return Date.parse(iso) - RECORDED_WAIT_STARTED_AT;
}

const RECORDED_EVALUATE_ISSUED_MS = sinceRecordedWaitStarted(
  RECORDED_FIRST_WAIT.trace.evaluateStart,
);

const RECORDED_EVALUATE_ANSWERED_MS = sinceRecordedWaitStarted(
  RECORDED_FIRST_WAIT.trace.evaluateEnd,
);

const RECORDED_EDITOR_PAGE = 'the editor page the recorded evaluate answered for';

const STARTUP_STAGE_EVENTS: ReadonlySet<string> = new Set(
  EVERY_STARTUP_PHASE.map((phase) => startupMarkLine(phase, 0).event),
);

const POLL_TO_READ_PLUS_POLL_TO_ACT_MS = 2 * BOOT_LOG_POLL_MS;

const LONGEST_WAIT_THE_STAGES_CAN_BUY_MS = BOOT_LOG_CAP_MS + BOOT_LOG_STALL_MS;

const REPLAY_WATCHDOG_MS = 2 * LONGEST_WAIT_THE_STAGES_CAN_BUY_MS;

interface RecordedLine {
  text: string;
  readableFromMs: number;
  fields: Record<string, unknown>;
}

function stringField(line: RecordedLine, key: string): string | undefined {
  const value = line.fields[key];
  return typeof value === 'string' ? value : undefined;
}

function recordedLinesInFileOrder(): RecordedLine[] {
  let readableFromMs = Number.NEGATIVE_INFINITY;
  return RECORDED_FIRST_WAIT.bootLog.map((text) => {
    const fields = JSON.parse(text) as RecordedLine['fields'] & { time: string };
    readableFromMs = Math.max(readableFromMs, sinceRecordedWaitStarted(fields.time));
    return { text, readableFromMs, fields };
  });
}

function isStartupStage(line: RecordedLine): boolean {
  const event = stringField(line, 'event');
  return event !== undefined && STARTUP_STAGE_EVENTS.has(event);
}

function lastStageReadableFromMs(lines: readonly RecordedLine[]): number {
  return Math.max(...lines.filter(isStartupStage).map((line) => line.readableFromMs));
}

function isRendererDriven(line: RecordedLine): boolean {
  return (
    stringField(line, 'source') === 'renderer-console' ||
    stringField(line, 'subsystem') === 'probe-spawn'
  );
}

function withMainHeartbeatingOnItsOwnBudget(lines: readonly RecordedLine[]): RecordedLine[] {
  const beats = lines.filter((line) => stringField(line, 'event') === BOOT_HEARTBEAT_EVENTS.boot);
  const last = beats.at(-1);
  if (last === undefined) return [...lines];
  const template = JSON.parse(last.text) as Record<string, unknown> & {
    elapsedMs: number;
    msg: string;
  };
  const continued: RecordedLine[] = [];
  for (let beat = beats.length + 1; beat <= BOOT_HEARTBEAT_MAX_BEATS + 1; beat += 1) {
    const laterMs = (beat - beats.length) * SPAWN_WAIT_HEARTBEAT_MS;
    const readableFromMs = last.readableFromMs + laterMs;
    const elapsedMs = template.elapsedMs + laterMs;
    const body = {
      ...template,
      time: new Date(RECORDED_WAIT_STARTED_AT + readableFromMs).toISOString(),
      elapsedMs,
      ...(beat > BOOT_HEARTBEAT_MAX_BEATS
        ? {
            event: `${BOOT_HEARTBEAT_EVENTS.boot}${BOOT_HEARTBEAT_ABANDONED_SUFFIX}`,
            beats: BOOT_HEARTBEAT_MAX_BEATS,
            msg: `${template.msg} — giving up on narration after ${elapsedMs}ms`,
          }
        : {}),
    };
    continued.push({ text: JSON.stringify(body), readableFromMs, fields: body });
  }
  return [...lines, ...continued];
}

function recordedStalledRenderer(): RecordedLine[] {
  return withMainHeartbeatingOnItsOwnBudget(
    recordedLinesInFileOrder().filter((line) => !isRendererDriven(line)),
  );
}

function startingLater(lines: readonly RecordedLine[], laterByMs: number): RecordedLine[] {
  return lines.map((line) => ({ ...line, readableFromMs: line.readableFromMs - laterByMs }));
}

function recordedLineShape(matches: (line: RecordedLine) => boolean): Record<string, unknown> {
  const found = recordedLinesInFileOrder().find(matches);
  if (found === undefined) throw new Error('the recording has no line of that shape');
  return JSON.parse(found.text) as Record<string, unknown>;
}

const RECORDED_BOOT_SHAPE = recordedLineShape(
  (line) => stringField(line, 'event') === DESKTOP_BOOT_EVENT,
);

const RECORDED_STAGE_SHAPE = recordedLineShape(isStartupStage);

const RECORDED_HEARTBEAT_SHAPE = recordedLineShape(
  (line) => stringField(line, 'event') === BOOT_HEARTBEAT_EVENTS.boot,
);

const RECORDED_RENDERER_CONSOLE_SHAPE = recordedLineShape(
  (line) => stringField(line, 'source') === 'renderer-console',
);

function lineShapedLike(
  shape: Record<string, unknown>,
  readableFromMs: number,
  fields: Record<string, unknown>,
): RecordedLine {
  const body = {
    ...shape,
    time: new Date(RECORDED_WAIT_STARTED_AT + readableFromMs).toISOString(),
    ...fields,
  };
  return { text: JSON.stringify(body), readableFromMs, fields: body };
}

function stageLine(phase: WaterfallPhase, readableFromMs: number): RecordedLine {
  return lineShapedLike(RECORDED_STAGE_SHAPE, readableFromMs, {
    ...startupMarkLine(phase, readableFromMs),
    msg: `startup ${phase}`,
  });
}

function rendererRelayedEventLine(readableFromMs: number, event: string): RecordedLine {
  return lineShapedLike(RECORDED_RENDERER_CONSOLE_SHAPE, readableFromMs, {
    level: 30,
    event,
    msg: event,
  });
}

function rendererRelayedLineAt(time: string, event: string): string {
  return JSON.stringify({ ...JSON.parse(rendererRelayedEventLine(0, event).text), time });
}

function syntheticLaunch(input: {
  stages: readonly RecordedLine[];
  others?: readonly RecordedLine[];
  logsUntilMs: number;
}): RecordedLine[] {
  const stages = [...input.stages].sort((a, b) => a.readableFromMs - b.readableFromMs);
  const beats: RecordedLine[] = [];
  for (let at = SPAWN_WAIT_HEARTBEAT_MS; at <= input.logsUntilMs; at += SPAWN_WAIT_HEARTBEAT_MS) {
    const reached = stages.filter((stage) => stage.readableFromMs <= at).at(-1);
    beats.push(
      lineShapedLike(RECORDED_HEARTBEAT_SHAPE, at, {
        elapsedMs: at,
        lastPhase:
          (reached === undefined ? undefined : stringField(reached, 'phase')) ??
          '(no phase marked yet)',
      }),
    );
  }
  return [
    lineShapedLike(RECORDED_BOOT_SHAPE, -BOOT_LOG_POLL_MS, {}),
    ...stages,
    ...(input.others ?? []),
    ...beats,
  ].sort((a, b) => a.readableFromMs - b.readableFromMs);
}

class ReplayOutlivedItsWatchdog extends Error {}

type ReplayVerdict =
  | { admitted: string; atMs: number }
  | { gaveUp: string; atMs: number; head: string }
  | { stillWaitingAtMs: number };

interface FirstWaitReplay {
  verdict: ReplayVerdict;
  elapsedMs: number;
  message: string;
  reportedCapMs: number | undefined;
  heldProbeLaps: number;
}

async function replayFirstWait(input: {
  lines: readonly RecordedLine[];
  pendingFromMs: number;
  answersAtMs?: number;
  probeHoldsTheLoopFromMs?: number;
  logUnreadableUntilMs?: number;
}): Promise<FirstWaitReplay> {
  const home = seedHome();
  try {
    mkdirSync(bootLogDirFor(home), { recursive: true });
    const clock = virtualClock(
      home,
      input.lines.map((line) => ({
        at: LAUNCH_RESOLVED_AT_MS + line.readableFromMs,
        text: line.text,
      })),
    );
    const answered = (): boolean =>
      input.answersAtMs !== undefined && clock.now() >= input.answersAtMs;
    const holdsTheLoop = (): boolean =>
      input.probeHoldsTheLoopFromMs !== undefined && clock.now() >= input.probeHoldsTheLoopFromMs;
    const logUnreadable = (): boolean =>
      input.logUnreadableUntilMs !== undefined && clock.now() < input.logUnreadableUntilMs;
    let reportedCapMs: number | undefined;
    let armedDeadlineAtMs = Number.POSITIVE_INFINITY;
    let heldProbeLaps = 0;
    const settled = await waitForReadySignal<string>({
      home,
      what: 'editor window',
      capMs: BOOT_LOG_CAP_MS,
      probe: async () => {
        if (answered()) return RECORDED_EDITOR_PAGE;
        if (!holdsTheLoop()) return undefined;
        heldProbeLaps += 1;
        const holdsUntilMs = Math.min(armedDeadlineAtMs, REPLAY_WATCHDOG_MS);
        await clock.sleep(Math.max(holdsUntilMs - clock.now(), 0));
        return holdsUntilMs < armedDeadlineAtMs
          ? undefined
          : new Promise<string | undefined>(() => {});
      },
      isProbePending: () => clock.now() >= input.pendingFromMs && !answered(),
      onCapExtended: (capMs) => {
        reportedCapMs = capMs;
      },
      now: clock.now,
      sleep: async (ms) => {
        if (clock.now() + ms > REPLAY_WATCHDOG_MS) throw new ReplayOutlivedItsWatchdog();
        await clock.sleep(ms);
      },
      readLog: (readFrom) =>
        logUnreadable()
          ? snapshot({
              dir: bootLogDirFor(readFrom),
              exists: false,
              fileCount: 0,
              unreadableReason: 'EACCES',
            })
          : clock.readLog(readFrom),
      startDeadline: (ms) => {
        armedDeadlineAtMs = clock.now() + ms;
        return clock.startDeadline(ms);
      },
    }).then(
      (admitted): Pick<FirstWaitReplay, 'verdict' | 'message'> => ({
        verdict: { admitted, atMs: clock.now() },
        message: '',
      }),
      (error: unknown): Pick<FirstWaitReplay, 'verdict' | 'message'> => {
        if (error instanceof ReplayOutlivedItsWatchdog) {
          return { verdict: { stillWaitingAtMs: clock.now() }, message: '' };
        }
        const message = error instanceof Error ? error.message : String(error);
        const reason = (error as { reason?: unknown }).reason;
        return {
          verdict: {
            gaveUp: typeof reason === 'string' ? reason : 'no reason given',
            atMs: clock.now(),
            head: message.split('\n')[0] ?? '',
          },
          message,
        };
      },
    );
    return { ...settled, elapsedMs: clock.now(), reportedCapMs, heldProbeLaps };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function preemptedNoLaterThanMs(lastStageFromMs: number): number {
  return (
    Math.max(BOOT_LOG_CAP_MS, lastStageFromMs + BOOT_LOG_STALL_MS) +
    POLL_TO_READ_PLUS_POLL_TO_ACT_MS
  );
}

const BOOT_GAP_SUMMARY_FIELDS = [
  'source',
  'totalBootMs',
  'maxGapMs',
  'openStageMs',
  'beatsSeen',
  'lineCount',
  'bootComplete',
  'afterPhase',
  'lastBeatPhase',
] as const;

function bootGapFields(line: string, keys: readonly string[]): Record<string, string> {
  const all = new Map<string, string>();
  for (const [, key, value] of line.matchAll(/(\w+)=("[^"]*"|\S+)/g)) {
    if (key !== undefined && value !== undefined) all.set(key, value);
  }
  const present: Array<[string, string]> = [];
  for (const key of keys) {
    const value = all.get(key);
    if (value !== undefined) present.push([key, value]);
  }
  return Object.fromEntries(present);
}

describe(`the first-window wait recorded on merge_group run ${RECORDED_FIRST_WAIT.source.workflowRun}, job ${RECORDED_FIRST_WAIT.source.job}`, () => {
  it(`is byte for byte the ${RECORDED_FIRST_WAIT.source.traceAttachment.name} attachment the lane's trace names by its sha1`, () => {
    expect(createHash('sha1').update(RECORDED_FIRST_WAIT.bootLog.join('\n')).digest('hex')).toBe(
      RECORDED_FIRST_WAIT.source.traceAttachment.sha1,
    );
  });

  it("reads here the way the lane's own [boot-gap] line summarized it", () => {
    const lane = bootGapFields(RECORDED_FIRST_WAIT.lane.bootGapLine, BOOT_GAP_SUMMARY_FIELDS);
    const here = bootGapFields(
      formatBootGapLine(
        bootGapLineFor({
          slot: 0,
          narration: bootNarrationFor(RECORDED_FIRST_WAIT.bootLog, snapshot({ exists: false })),
          readyWaitCount: 1,
          homeShared: false,
        }),
      ),
      BOOT_GAP_SUMMARY_FIELDS,
    );
    expect(Object.keys(lane)).toEqual([...BOOT_GAP_SUMMARY_FIELDS]);
    expect(here).toEqual(lane);
  });
});

describe("the first-window bound admits a launch still advancing through the app's own startup stages", () => {
  it('admits the window the recorded launch answered past the static cap, within one stall bound of its last startup stage', async () => {
    const lines = recordedLinesInFileOrder();
    expect(
      RECORDED_EVALUATE_ANSWERED_MS,
      'the recorded window answered after the static cap',
    ).toBeGreaterThan(BOOT_LOG_CAP_MS);
    expect(
      RECORDED_EVALUATE_ANSWERED_MS - lastStageReadableFromMs(lines),
      'and within one stall bound of the last startup stage the recorded app narrated',
    ).toBeLessThan(BOOT_LOG_STALL_MS);
    const replay = await replayFirstWait({
      lines,
      pendingFromMs: RECORDED_EVALUATE_ISSUED_MS,
      answersAtMs: RECORDED_EVALUATE_ANSWERED_MS,
    });
    expect(replay.verdict).toMatchObject({ admitted: RECORDED_EDITOR_PAGE });
  });

  it('admits a window that answers soon after a startup stage the wait first reads on the poll its static cap fires', async () => {
    const answersAtMs = BOOT_LOG_CAP_MS + BOOT_LOG_STALL_MS / 2;
    const lines = syntheticLaunch({
      stages: [
        ...EVERY_STARTUP_PHASE.slice(0, EVERY_STARTUP_PHASE.indexOf('loadUrlResolved')).map(
          (phase) => stageLine(phase, -BOOT_LOG_POLL_MS),
        ),
        stageLine('loadUrlResolved', BOOT_LOG_CAP_MS),
      ],
      logsUntilMs: answersAtMs,
    });
    const replay = await replayFirstWait({ lines, pendingFromMs: 0, answersAtMs });
    expect(replay.verdict).toMatchObject({ admitted: RECORDED_EDITOR_PAGE });
  });
});

describe('the first-window bound still preempts a launch that has stopped advancing', () => {
  it('preempts at the static cap a launch that reaches no new startup stage while the wait runs, however long main keeps logging', async () => {
    const stalled = recordedStalledRenderer();
    const laterByMs = lastStageReadableFromMs(stalled) + BOOT_LOG_POLL_MS;
    const lines = startingLater(stalled, laterByMs);
    expect(
      lines.filter(isStartupStage).every((line) => line.readableFromMs < 0),
      'every startup stage was narrated before the wait began',
    ).toBe(true);
    expect(
      lines.filter((line) => line.readableFromMs > BOOT_LOG_CAP_MS).length,
      'main keeps logging past the static cap',
    ).toBeGreaterThan(0);
    const replay = await replayFirstWait({
      lines,
      pendingFromMs: RECORDED_EVALUATE_ISSUED_MS - laterByMs,
    });
    expect(replay.verdict).toMatchObject({ gaveUp: expect.any(String) });
    expect(replay.elapsedMs).toBeLessThanOrEqual(
      BOOT_LOG_CAP_MS + POLL_TO_READ_PLUS_POLL_TO_ACT_MS,
    );
    expect(replay.message).not.toContain('logged no new boot activity');
  });

  it('preempts the recorded launch once its renderer stalls, within one stall bound of the last stage main narrated, and blames nothing main did not do', async () => {
    const lines = recordedStalledRenderer();
    const lastStageFromMs = lastStageReadableFromMs(lines);
    expect(
      lines.filter((line) => line.readableFromMs > lastStageFromMs + BOOT_LOG_STALL_MS).length,
      'main keeps logging for longer than one stall bound after its last stage',
    ).toBeGreaterThan(0);
    const replay = await replayFirstWait({ lines, pendingFromMs: RECORDED_EVALUATE_ISSUED_MS });
    expect(replay.verdict).toMatchObject({ gaveUp: expect.any(String) });
    expect(replay.elapsedMs).toBeLessThanOrEqual(preemptedNoLaterThanMs(lastStageFromMs));
    expect(
      replay.elapsedMs,
      'a wait that outlives the static cap reports the bound that decided it',
    ).toBeLessThanOrEqual(
      (replay.reportedCapMs ?? BOOT_LOG_CAP_MS) + POLL_TO_READ_PLUS_POLL_TO_ACT_MS,
    );
    expect(replay.message).not.toContain('logged no new boot activity');
    expect(replay.message).toContain('Probe errors: none on any poll.');
    expect(replay.message).toMatch(/last probe had not answered/);
    expect(replay.message.split('\n')).toEqual(
      expect.arrayContaining(RECORDED_FIRST_WAIT.lane.giveUpDiagnostics),
    );
  });

  it('gives the recorded launch the silence verdict, not the static cap, once main falls quiet right after its last startup stage', async () => {
    const lines = recordedLinesInFileOrder();
    const lastStageFromMs = lastStageReadableFromMs(lines);
    expect(
      lastStageFromMs + BOOT_LOG_STALL_MS,
      'a silence that starts at the last stage outlasts the static cap',
    ).toBeGreaterThan(BOOT_LOG_CAP_MS);
    const replay = await replayFirstWait({
      lines: lines.filter((line) => line.readableFromMs <= lastStageFromMs),
      pendingFromMs: RECORDED_EVALUATE_ISSUED_MS,
    });
    expect(replay.verdict).toMatchObject({ gaveUp: 'stall' });
    expect(replay.elapsedMs).toBeLessThanOrEqual(
      lastStageFromMs + BOOT_LOG_STALL_MS + POLL_TO_READ_PLUS_POLL_TO_ACT_MS,
    );
    expect(replay.message).toContain('logged no new boot activity');
    expect(replay.message).not.toContain('kept logging boot activity');
    expect(replay.message).toMatch(/last probe had not answered/);
  });

  it('preempts the recorded stalled renderer no later than its last stage allows, even when its probe holds the loop across every deadline', async () => {
    const lines = recordedStalledRenderer();
    const lastStageFromMs = lastStageReadableFromMs(lines);
    expect(
      lines
        .filter(isStartupStage)
        .some(
          (line) =>
            line.readableFromMs > RECORDED_EVALUATE_ISSUED_MS &&
            line.readableFromMs <= BOOT_LOG_CAP_MS,
        ),
      'a startup stage turns readable while the held probe keeps the wait from reading the log',
    ).toBe(true);
    const replay = await replayFirstWait({
      lines,
      pendingFromMs: RECORDED_EVALUATE_ISSUED_MS,
      probeHoldsTheLoopFromMs: RECORDED_EVALUATE_ISSUED_MS,
    });
    expect(replay.heldProbeLaps).toBeGreaterThan(0);
    expect(replay.verdict).toMatchObject({ gaveUp: expect.any(String) });
    expect(replay.elapsedMs).toBeLessThanOrEqual(preemptedNoLaterThanMs(lastStageFromMs));
    expect(replay.message).toMatch(/last probe had not answered/);
  });

  it('preempts at the static cap a launch whose stages all predate the wait, though an unreadable log hid them until late in it', async () => {
    const stalled = recordedStalledRenderer();
    const laterByMs = lastStageReadableFromMs(stalled) + BOOT_LOG_POLL_MS;
    const lines = startingLater(stalled, laterByMs);
    const logUnreadableUntilMs = BOOT_LOG_CAP_MS - BOOT_LOG_STALL_MS + BOOT_LOG_POLL_MS;
    expect(
      lines.filter(isStartupStage).every((line) => line.readableFromMs < 0),
      'every startup stage was narrated before the wait began',
    ).toBe(true);
    expect(
      logUnreadableUntilMs + BOOT_LOG_STALL_MS,
      'a stage dated at the first read that could see the log would carry the wait past the static cap',
    ).toBeGreaterThan(BOOT_LOG_CAP_MS);
    const replay = await replayFirstWait({
      lines,
      pendingFromMs: RECORDED_EVALUATE_ISSUED_MS - laterByMs,
      logUnreadableUntilMs,
    });
    expect(replay.reportedCapMs).toBeUndefined();
    expect(replay.verdict).toMatchObject({ gaveUp: 'cap', atMs: BOOT_LOG_CAP_MS });
  });
});

describe('the longest wait startup stages can buy is the static cap plus one stall bound', () => {
  it('ends a launch that reaches every startup stage as late as it can, each one just inside a stall bound of the last', async () => {
    const lines = syntheticLaunch({
      stages: EVERY_STARTUP_PHASE.map((phase, index) =>
        stageLine(phase, BOOT_LOG_CAP_MS + index * (BOOT_LOG_STALL_MS - BOOT_LOG_POLL_MS)),
      ),
      logsUntilMs: REPLAY_WATCHDOG_MS,
    });
    expect(launchAdvancementPhases(lines.map((line) => line.text))).toHaveLength(
      EVERY_STARTUP_PHASE.length,
    );
    const replay = await replayFirstWait({ lines, pendingFromMs: 0 });
    expect(replay.verdict).toMatchObject({ gaveUp: expect.any(String) });
    expect(replay.elapsedMs).toBeLessThanOrEqual(
      LONGEST_WAIT_THE_STAGES_CAN_BUY_MS + POLL_TO_READ_PLUS_POLL_TO_ACT_MS,
    );
  });

  it('does not let lines that only borrow the startup-stage prefix buy time without end', async () => {
    const impostors: RecordedLine[] = [];
    for (
      let fromMs = BOOT_LOG_CAP_MS;
      fromMs < REPLAY_WATCHDOG_MS;
      fromMs += BOOT_LOG_STALL_MS - BOOT_LOG_POLL_MS
    ) {
      impostors.push(
        rendererRelayedEventLine(fromMs, `desktop.startup.renderer-step-${impostors.length}`),
      );
    }
    const lines = syntheticLaunch({
      stages: EVERY_STARTUP_PHASE.filter((phase) => phase !== 'windowShown').map((phase) =>
        stageLine(phase, -BOOT_LOG_POLL_MS),
      ),
      others: impostors,
      logsUntilMs: REPLAY_WATCHDOG_MS,
    });
    const stagePrefixed = new Set(
      lines
        .map((line) => stringField(line, 'event'))
        .filter((event): event is string => event !== undefined && isStartupMarkEvent(event)),
    );
    expect(
      stagePrefixed.size,
      'the narration offers more stage-prefixed events than the app has startup stages',
    ).toBeGreaterThan(EVERY_STARTUP_PHASE.length);
    const replay = await replayFirstWait({ lines, pendingFromMs: 0 });
    expect(replay.verdict).toMatchObject({ gaveUp: expect.any(String) });
    expect(replay.elapsedMs).toBeLessThanOrEqual(
      LONGEST_WAIT_THE_STAGES_CAN_BUY_MS + POLL_TO_READ_PLUS_POLL_TO_ACT_MS,
    );
    expect(
      replay.reportedCapMs,
      'a line that only borrows the prefix renews nothing',
    ).toBeUndefined();
    expect(replay.elapsedMs).toBeLessThanOrEqual(
      BOOT_LOG_CAP_MS + POLL_TO_READ_PLUS_POLL_TO_ACT_MS,
    );
  });
});

describe("a launch the app narrates inside its own contract still reaches the app's own verdict", () => {
  for (const { label, options } of READINESS_CALLS) {
    it(label, async () => {
      const launch = utilityForkTheLastStageKeptAlive(options);
      const reach = await reachOf(launch, 2 * launch.appVerdictAtMs);
      expect(reach).toMatchObject({ gaveUpAtMs: expect.any(Number) });
      expect('gaveUpAtMs' in reach ? reach.gaveUpAtMs : Number.NaN).toBeGreaterThan(
        launch.appVerdictAtMs,
      );
      expect('message' in reach ? reach.message : '').toContain(DESKTOP_OPEN_PROJECT_FAILED_EVENT);
    });
  }
});

describe('the latest deadline the helper arms is the shared worst case of the path the launch takes', () => {
  for (const { label, options } of READINESS_CALLS) {
    for (const path of READINESS_PATHS) {
      it(`${label}, on the ${path} path`, async () => {
        const worstCaseMs = readinessWorstCaseMs({ path, ...options });
        const launch = LAUNCH_REACHING_THE_CEILING_OF[path](options);
        const giveUp = giveUpOf(await reachOf(launch, 2 * worstCaseMs), launch);
        expect(giveUp.decidingCapMs, launch.name).toBe(worstCaseMs);
        expect(giveUp.gaveUpAtMs).toBeGreaterThanOrEqual(worstCaseMs);
        expect(giveUp.gaveUpAtMs).toBeLessThan(worstCaseMs + pollIntervalOf(options));
      });
    }
  }
});

describe("a launch inside the app's own contract, read on a poll out of phase with the app's heartbeat, runs to the app's own last grant", () => {
  const launch = utilityForkWhoseFirstBeatLandsOnTheLastStagePoll({ pollMs: BOOT_LOG_POLL_MS + 3 });
  const forkWorstCaseMs = readinessWorstCaseMs({ path: 'fork', ...launch.options });

  it("arms the grant the app's last beat bought, and gives up naming the app's verdict", async () => {
    const giveUp = giveUpOf(await reachOf(launch, 2 * forkWorstCaseMs), launch);
    expect(giveUp.declaredGrantMs).toBeDefined();
    expect(giveUp.decidingCapMs).toBe(giveUp.declaredGrantMs);
    expect(giveUp.gaveUpAtMs).toBeGreaterThan(launch.appVerdictAtMs);
    expect(giveUp.message).toContain(DESKTOP_OPEN_PROJECT_FAILED_EVENT);
  });

  it("finds that grant inside the fork path's worst case", async () => {
    const giveUp = giveUpOf(await reachOf(launch, 2 * forkWorstCaseMs), launch);
    expect(giveUp.declaredGrantMs).toBeDefined();
    expect(giveUp.declaredGrantMs).toBeLessThanOrEqual(forkWorstCaseMs);
  });
});

describe("a launch inside the app's own contract, read on polls further out of phase with the app's heartbeat, still runs to the app's own last grant", () => {
  for (const pollMs of [
    BOOT_LOG_POLL_MS + 20,
    BOOT_LOG_POLL_MS + 60,
    BOOT_LOG_POLL_MS + 83,
    BOOT_LOG_POLL_MS + 150,
    2 * BOOT_LOG_POLL_MS - 1,
  ]) {
    it(`read every ${pollMs}ms, arms the grant the app's last beat bought, gives up naming the app's verdict, and finds that grant inside the fork path's worst case`, async () => {
      const launch = utilityForkWhoseFirstBeatLandsOnTheLastStagePoll({ pollMs });
      const forkWorstCaseMs = readinessWorstCaseMs({ path: 'fork', ...launch.options });
      const giveUp = giveUpOf(await reachOf(launch, 2 * forkWorstCaseMs), launch);
      expect(giveUp.declaredGrantMs, `read every ${pollMs}ms`).toBeDefined();
      expect(giveUp.decidingCapMs, `read every ${pollMs}ms`).toBe(giveUp.declaredGrantMs);
      expect(giveUp.gaveUpAtMs).toBeGreaterThan(launch.appVerdictAtMs);
      expect(giveUp.message).toContain(DESKTOP_OPEN_PROJECT_FAILED_EVENT);
      expect(giveUp.declaredGrantMs).toBeLessThanOrEqual(forkWorstCaseMs);
    });
  }
});

function anEarlierLaunchThatStoppedJustAfterItsUtilityWaitGraduated(pollMs: number) {
  const forkAtMs = MEASURED_FORK_OFFSETS[0];
  const graduatedAtMs = forkAtMs + UTILITY_INIT_TIMEOUT_MS;
  return graduatingUtilityNarration(forkAtMs, {
    graduationBeat: true,
    decisionLateMs: 0,
    graduatedBeatsLateMs: 0,
    lastBeatElapsedMs: UTILITY_INIT_TIMEOUT_MS,
  }).map(({ at, text }) => ({ atMs: at - graduatedAtMs - pollMs, text }));
}

describe('a launch that boots after the wait first reads a home an earlier launch left its log in', () => {
  const verdictOf = ({ gaveUpAtMs, decidingCapMs, advancements }: GiveUp) => ({
    gaveUpAtMs,
    decidingCapMs,
    advancements,
  });

  it('decides as it would alone in that home, and records only its own stages', async () => {
    const alone = launchBootingAfterTheWaitsFirstRead({}, { sharedWithAnEarlierLaunch: false });
    const shared = launchBootingAfterTheWaitsFirstRead({}, { sharedWithAnEarlierLaunch: true });
    const aloneGiveUp = giveUpOf(await reachOf(alone, REPLAY_WATCHDOG_MS), alone);
    const sharedGiveUp = giveUpOf(await reachOf(shared, REPLAY_WATCHDOG_MS), shared);
    expect(verdictOf(sharedGiveUp)).toEqual(verdictOf(aloneGiveUp));
    expect(sharedGiveUp.advancements.map((advancement) => advancement.event)).toEqual(
      shared.ownStageEvents,
    );
    expect(aloneGiveUp.decidingCapMs).toBe(
      readinessWorstCaseMs({ path: 'packaged', ...alone.options }),
    );
  });

  it("decides as it would alone when the earlier launch stopped inside its utility wait, and reaches the app's own verdict", async () => {
    const alone = utilityForkBootingAfterTheWaitsFirstRead(
      {},
      { sharedWithALaunchThatStoppedInItsUtilityWait: false },
    );
    const shared = utilityForkBootingAfterTheWaitsFirstRead(
      {},
      { sharedWithALaunchThatStoppedInItsUtilityWait: true },
    );
    const aloneGiveUp = giveUpOf(await reachOf(alone, REPLAY_WATCHDOG_MS), alone);
    const sharedGiveUp = giveUpOf(await reachOf(shared, REPLAY_WATCHDOG_MS), shared);
    expect(verdictOf(sharedGiveUp)).toEqual(verdictOf(aloneGiveUp));
    expect(sharedGiveUp.gaveUpAtMs).toBeGreaterThan(shared.appVerdictAtMs);
    expect(sharedGiveUp.message).toContain(DESKTOP_OPEN_PROJECT_FAILED_EVENT);
  });

  it("decides as it would alone when the earlier launch stopped just after its utility wait graduated, and reaches the app's own verdict", async () => {
    const alone = utilityForkBootingAfterTheWaitsFirstRead(
      {},
      { sharedWithALaunchThatStoppedInItsUtilityWait: false },
    );
    const shared = {
      ...alone,
      name: "a utility fork booting after the wait's first read, into a home an earlier launch left just after its utility wait graduated",
      narrationUntil: (untilMs: number) => [
        ...anEarlierLaunchThatStoppedJustAfterItsUtilityWaitGraduated(
          pollIntervalOf(alone.options),
        ),
        ...alone.narrationUntil(untilMs),
      ],
    };
    const watchMs = 2 * readinessWorstCaseMs({ path: 'fork', ...alone.options });
    const aloneGiveUp = giveUpOf(await reachOf(alone, watchMs), alone);
    const sharedGiveUp = giveUpOf(await reachOf(shared, watchMs), shared);
    expect(verdictOf(sharedGiveUp)).toEqual(verdictOf(aloneGiveUp));
    expect(sharedGiveUp.gaveUpAtMs).toBeGreaterThan(shared.appVerdictAtMs);
    expect(sharedGiveUp.message).toContain(DESKTOP_OPEN_PROJECT_FAILED_EVENT);
  });
});

describe('a wait over a home that also holds the log a launch the day before left decides as it would had every poll read both logs', () => {
  const recordOf = ({
    gaveUpAtMs,
    reason,
    decidingCapMs,
    declaredGrantMs,
    advancements,
  }: GiveUp) => ({
    gaveUpAtMs,
    reason,
    decidingCapMs,
    declaredGrantMs,
    advancements,
  });

  it("reads past a poll that could not read the launch's own log, and still reaches the app's own verdict", async () => {
    const alone = utilityForkTheLastStageKeptAlive({});
    const beside = utilityForkTheLastStageKeptAliveBesideTheDayBeforesLog(
      {},
      { unreadableOnOnePollOfTheDeclaredGrant: false },
    );
    const glitched = utilityForkTheLastStageKeptAliveBesideTheDayBeforesLog(
      {},
      { unreadableOnOnePollOfTheDeclaredGrant: true },
    );
    const watchMs = 2 * alone.appVerdictAtMs;
    const aloneGiveUp = giveUpOf(await reachOf(alone, watchMs), alone);
    const besideGiveUp = giveUpOf(await reachOf(beside, watchMs), beside);
    const glitchedGiveUp = giveUpOf(await reachOf(glitched, watchMs), glitched);
    expect(recordOf(besideGiveUp)).toEqual(recordOf(aloneGiveUp));
    expect(recordOf(glitchedGiveUp)).toEqual(recordOf(besideGiveUp));
    expect(glitchedGiveUp.gaveUpAtMs).toBeGreaterThan(glitched.appVerdictAtMs);
    expect(glitchedGiveUp.message).toContain(DESKTOP_OPEN_PROJECT_FAILED_EVENT);
  });

  it('adopts a launch that boots while the earlier log cannot be read, and records only its own stages', async () => {
    const alone = launchBootingAfterTheWaitsFirstRead({}, { sharedWithAnEarlierLaunch: false });
    const beside = launchBootingAfterTheWaitsFirstReadBesideTheDayBeforesLog(
      {},
      { unreadableFromTheBootUntilMainsFirstHeartbeat: false },
    );
    const glitched = launchBootingAfterTheWaitsFirstReadBesideTheDayBeforesLog(
      {},
      { unreadableFromTheBootUntilMainsFirstHeartbeat: true },
    );
    const aloneGiveUp = giveUpOf(await reachOf(alone, REPLAY_WATCHDOG_MS), alone);
    const besideGiveUp = giveUpOf(await reachOf(beside, REPLAY_WATCHDOG_MS), beside);
    const glitchedGiveUp = giveUpOf(await reachOf(glitched, REPLAY_WATCHDOG_MS), glitched);
    expect(recordOf(besideGiveUp)).toEqual(recordOf(aloneGiveUp));
    expect(recordOf(glitchedGiveUp)).toEqual(recordOf(besideGiveUp));
    expect(glitchedGiveUp.advancements.map((advancement) => advancement.event)).toEqual(
      glitched.ownStageEvents,
    );
  });
});
