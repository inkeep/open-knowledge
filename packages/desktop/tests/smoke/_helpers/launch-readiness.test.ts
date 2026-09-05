import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOOT_HEARTBEAT_ABANDONED_SUFFIX,
  BOOT_HEARTBEAT_EVENTS,
  BOOT_HEARTBEAT_MAX_BEATS,
  DESKTOP_BOOT_EVENT,
  SPAWN_STARTUP_DEADLINE_MS,
  SPAWN_WAIT_EXTENSION_FACTOR,
  SPAWN_WAIT_HEARTBEAT_MS,
  startupMarkLine,
  UTILITY_INIT_TIMEOUT_MS,
} from '../../../src/shared/boot-narration.ts';
import {
  BOOT_LOG_CAP_MS,
  BOOT_LOG_HEARTBEAT_MS,
  BOOT_LOG_STALL_MS,
  type BootLogSnapshot,
  bootGapSourceFor,
  bootLogDirFor,
  bootLogGapSummary,
  classifyBootLog,
  describeMissingBootLog,
  formatBootGapLine,
  giveUpReason,
  hasBootCompleted,
  launchDesktopApp,
  launchHomeFor,
  READY_WAIT_GIVE_UP_REASONS,
  readBootLog,
  readBootLogLines,
  readyWaitsFor,
  rememberLaunchHome,
  tryBootLogFor,
  tryFirstWaitFor,
  type WindowMode,
  waitForReadySignal,
  waitForWindowByMode,
} from './launch-readiness.ts';

function markLine(phase: string, elapsedMs: number, time: string): string {
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
    ).rejects.toThrow(/NOT FOUND/);
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

  it("clears the unpackaged app's own utility-fork deadline", () => {
    expect(BOOT_LOG_CAP_MS).toBeGreaterThan(UTILITY_INIT_TIMEOUT_MS);
  });

  it('lets the cap stay the operative verdict on a boot that never shows a window', () => {
    expect(BOOT_HEARTBEAT_MAX_BEATS * SPAWN_WAIT_HEARTBEAT_MS).toBeGreaterThan(BOOT_LOG_CAP_MS);
  });

  it("is deliberately below the packaged path's graduated spawn budget", () => {
    expect(BOOT_LOG_CAP_MS).toBeLessThan(SPAWN_STARTUP_DEADLINE_MS * SPAWN_WAIT_EXTENSION_FACTOR);
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

  it('disarms mid-wait when the app shows its window, so the cap decides not the stall', async () => {
    let clock = 0;
    const lines = [JSON.stringify({ event: DESKTOP_BOOT_EVENT, time: '2026-09-04T00:00:00.000Z' })];
    await expect(
      waitForReadySignal<string>({
        probe: async () => undefined,
        home: '/unused',
        what: 'editor window',
        capMs: 20_000,
        now: () => clock,
        sleep: async () => {
          clock += 1_000;
          if (clock === 3_000)
            lines.push(markLine('windowShown', 3_000, '2026-09-04T00:00:03.000Z'));
        },
        readLog: () => snapshot({ lines, lineCount: lines.length, lastEvent: 'desktop.boot' }),
      }),
    ).rejects.toThrow(/kept logging boot activity/);
    expect(clock).toBeGreaterThan(BOOT_LOG_STALL_MS);
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
  it('snapshots the boot log when boot ends, not at teardown', async () => {
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
    await expect(waitForWindowByMode(app, 'editor', { capMs: 300, pollMs: 60 })).rejects.toThrow();
    expect(tryFirstWaitFor(app)?.reason).toBe('cap');
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
      'no desktop log file at teardown (a test.afterEach removed the launch home before the fixture could read it, or the app wrote no log file)',
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
      'boot-complete',
    );
    expect(bootGapSourceFor({ hasLines: true, snapshotted: true, homeShared: true })).toBe(
      'boot-complete',
    );
    expect(bootGapSourceFor({ hasLines: true, snapshotted: false, homeShared: false })).toBe(
      'teardown-read',
    );
    expect(bootGapSourceFor({ hasLines: true, snapshotted: false, homeShared: true })).toBe(
      'teardown-read-shared-home',
    );
  });
});

describe('formatBootGapLine', () => {
  it('states the measured gap next to the bound it has to clear', () => {
    const line = formatBootGapLine({
      slot: 0,
      source: 'boot-complete',
      readyWaitCount: 2,
      firstWait: {
        ordinal: 0,
        what: 'editor window',
        elapsedMs: 2_100,
        capMs: 9_000,
        gaveUp: false,
        reason: 'none',
      },
      summary: bootLogGapSummary([
        markLine('appReady', 0, '2026-09-04T00:00:00.000Z'),
        markLine('serverSpawned', 1_400, '2026-09-04T00:00:01.400Z'),
        markLine('windowShown', 3_000, '2026-09-04T00:00:03.000Z'),
      ]),
    });
    expect(line).toContain('[boot-gap] slot=0');
    expect(line).toContain('source=boot-complete');
    expect(line).toContain(`stallMs=${BOOT_LOG_STALL_MS}`);
    expect(line).toContain('totalBootMs=3000');
    expect(line).toContain('maxGapMs=1600');
    expect(line).toContain('firstWaitMs=2100');
    expect(line).toContain('firstWaitCapMs=9000');
    expect(line).not.toContain(`firstWaitCapMs=${BOOT_LOG_CAP_MS}`);
    expect(line).toContain('firstWaitWhat="editor window"');
    expect(line).toContain('firstWaitGaveUp=false');
    expect(line).toContain('firstWaitReason=none');
    expect(line).toContain('readyWaitCount=2');
    expect(line).toContain('bootComplete=true');
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
        source: 'boot-complete',
        readyWaitCount: 1,
        firstWait: {
          ordinal: 0,
          what: 'editor window',
          elapsedMs: 25_000,
          capMs: BOOT_LOG_CAP_MS,
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
