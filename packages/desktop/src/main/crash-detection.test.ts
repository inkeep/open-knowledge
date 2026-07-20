/**
 * Crash-detection pipeline tests: injected signal sources, a fake renderer
 * push, and tmpdir-backed sentinel/store/minidump paths — the same
 * injectable-deps posture as the sibling IPC handler tests. The clock is a
 * deterministic advancing fake so sentinel boot ids, ack baselines, and
 * seeded minidump mtimes are all comparable without wall-clock races.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { OkBugReportCrashDetectedEvent } from '@inkeep/open-knowledge-core';
import {
  type CrashDetectionDeps,
  createCrashDetection,
  startLocalCrashReporter,
} from './crash-detection.ts';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const silentLogger = {
  info: () => {},
  warn: () => {},
};

interface Rig {
  deps: CrashDetectionDeps;
  emitted: OkBugReportCrashDetectedEvent[];
  /** Flip to false to simulate "no live renderer window can take the event". */
  setRendererAvailable(available: boolean): void;
  /** Swap the kernel boot-session identity, simulating a reboot between sessions. */
  setBootSessionUuid(uuid: string | null): void;
  /** Advance and return the fake clock (10s per tick). */
  tick(): Date;
  dir: string;
}

function makeRig(): Rig {
  const dir = mkdtempSync(resolve(tmpdir(), 'ok-crash-detection-'));
  tmpDirs.push(dir);
  const emitted: OkBugReportCrashDetectedEvent[] = [];
  let rendererAvailable = true;
  let bootSessionUuid: string | null = 'boot-epoch-a';
  let clockMs = Date.parse('2026-07-10T00:00:00.000Z');
  return {
    dir,
    emitted,
    setRendererAvailable(available: boolean) {
      rendererAvailable = available;
    },
    setBootSessionUuid(uuid: string | null) {
      bootSessionUuid = uuid;
    },
    tick() {
      clockMs += 10_000;
      return new Date(clockMs);
    },
    deps: {
      sentinelPath: join(dir, 'user-data', 'bug-report-dirty-shutdown.json'),
      ackStorePath: join(dir, 'user-data', 'bug-report-crash-acks.json'),
      crashDumpsDir: join(dir, 'crash-dumps'),
      emit(event) {
        if (!rendererAvailable) return false;
        emitted.push(event);
        return true;
      },
      now: () => {
        clockMs += 10_000;
        return new Date(clockMs);
      },
      currentBootSessionUuid: () => bootSessionUuid,
      logger: silentLogger,
    },
  };
}

function readSentinel(rig: Rig): Record<string, string | undefined> {
  return JSON.parse(readFileSync(rig.deps.sentinelPath, 'utf8')) as Record<
    string,
    string | undefined
  >;
}

/** Seed a minidump whose mtime is pinned to the fake clock's timeline. */
function seedMinidump(rig: Rig, relPath: string, at: Date): void {
  const dumpPath = join(rig.deps.crashDumpsDir, relPath);
  mkdirSync(dirname(dumpPath), { recursive: true });
  writeFileSync(dumpPath, 'minidump-bytes');
  utimesSync(dumpPath, at, at);
}

describe('runtime process-gone invitations', () => {
  test('abnormal renderer death arms one report invitation', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    detection.handleRenderProcessGone({ reason: 'crashed', exitCode: 5 });

    expect(rig.emitted).toHaveLength(1);
    const event = rig.emitted[0];
    expect(event?.kind).toBe('render-process-gone');
    expect(event?.eventId).toBeTruthy();
    if (event?.kind === 'render-process-gone') {
      expect(event.context.reason).toBe('crashed');
      expect(event.context.exitCode).toBe(5);
    }
    // No dump on disk for this crash, so the invite offers no dump option.
    expect(event?.minidumpAvailable).toBe(false);
  });

  test('a renderer crash with a fresh minidump on disk reports it as available', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    seedMinidump(rig, 'completed/renderer.dmp', rig.tick());

    detection.handleRenderProcessGone({ reason: 'crashed' });

    expect(rig.emitted[0]?.minidumpAvailable).toBe(true);
  });

  test('routine process teardown never invites', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    for (const reason of ['clean-exit', 'killed', 'abnormal-exit']) {
      detection.handleRenderProcessGone({ reason });
      detection.handleChildProcessGone({ type: 'Utility', reason });
    }

    expect(rig.emitted).toHaveLength(0);
  });

  test('abnormal child-process death invites with the child identity', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    detection.handleChildProcessGone({ type: 'GPU', reason: 'oom', exitCode: 1 });

    expect(rig.emitted).toHaveLength(1);
    const event = rig.emitted[0];
    expect(event?.kind).toBe('child-process-gone');
    if (event?.kind === 'child-process-gone') {
      expect(event.context.processType).toBe('GPU');
      expect(event.context.reason).toBe('oom');
    }
  });

  test('a second crash stays silent while one invitation is unanswered, and invites again after ack', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    detection.handleRenderProcessGone({ reason: 'crashed' });
    detection.handleRenderProcessGone({ reason: 'crashed' });
    expect(rig.emitted).toHaveLength(1);

    const first = rig.emitted[0];
    if (!first) throw new Error('expected a first invitation');
    detection.ack(first.eventId);

    detection.handleRenderProcessGone({ reason: 'oom' });
    expect(rig.emitted).toHaveLength(2);
    expect(rig.emitted[1]?.eventId).not.toBe(first.eventId);
  });

  test('with no live renderer the invitation waits and delivers exactly once on renderer-ready', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    rig.setRendererAvailable(false);
    detection.handleRenderProcessGone({ reason: 'crashed' });
    expect(rig.emitted).toHaveLength(0);

    rig.setRendererAvailable(true);
    detection.notifyRendererReady();
    expect(rig.emitted).toHaveLength(1);

    detection.notifyRendererReady();
    expect(rig.emitted).toHaveLength(1);
  });
});

describe('boot-time detection', () => {
  test('a dirty shutdown invites once at the next boot, delivered on renderer-ready', () => {
    const rig = makeRig();

    const sessionA = createCrashDetection(rig.deps);
    expect(sessionA.detectBootCrash()).toBeNull();
    // Session A ends without markCleanQuit — a crash leaves its sentinel behind.

    const sessionB = createCrashDetection(rig.deps);
    const armed = sessionB.detectBootCrash();
    expect(armed?.kind).toBe('boot');
    if (armed?.kind === 'boot') {
      expect(armed.context.dirtyShutdown).toBe(true);
      expect(armed.context.newMinidumps).toBe(0);
      // A dirty shutdown that left no native dump offers no dump option.
      expect(armed.minidumpAvailable).toBe(false);
    }

    // Boot events wait for the first ready renderer instead of racing window load.
    expect(rig.emitted).toHaveLength(0);
    sessionB.notifyRendererReady();
    expect(rig.emitted).toHaveLength(1);
    sessionB.notifyRendererReady();
    expect(rig.emitted).toHaveLength(1);
  });

  test('a clean quit clears the sentinel and the next boot stays silent', () => {
    const rig = makeRig();

    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    expect(existsSync(rig.deps.sentinelPath)).toBe(true);
    sessionA.markCleanQuit();
    expect(existsSync(rig.deps.sentinelPath)).toBe(false);

    const sessionB = createCrashDetection(rig.deps);
    expect(sessionB.detectBootCrash()).toBeNull();
    sessionB.notifyRendererReady();
    expect(rig.emitted).toHaveLength(0);
  });

  test('an acknowledged boot event never re-prompts, but a later crash prompts as a new event', () => {
    const rig = makeRig();

    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    // Session A crashes.

    const sessionB = createCrashDetection(rig.deps);
    const first = sessionB.detectBootCrash();
    if (!first) throw new Error('expected a boot invitation after the dirty shutdown');
    sessionB.ack(first.eventId);
    expect(readFileSync(rig.deps.ackStorePath, 'utf8')).toContain(first.eventId);
    sessionB.markCleanQuit();

    const sessionC = createCrashDetection(rig.deps);
    expect(sessionC.detectBootCrash()).toBeNull();
    // Session C crashes too — a genuinely new event, so the next boot invites again.

    const sessionD = createCrashDetection(rig.deps);
    const second = sessionD.detectBootCrash();
    expect(second?.kind).toBe('boot');
    expect(second?.eventId).not.toBe(first.eventId);
  });

  test('minidumps predating the store never invite; a fresh one does, and ack retires it', () => {
    const rig = makeRig();
    seedMinidump(rig, 'pending/ancient.dmp', new Date('2026-07-09T00:00:00.000Z'));

    const sessionA = createCrashDetection(rig.deps);
    expect(sessionA.detectBootCrash()).toBeNull();
    sessionA.markCleanQuit();

    seedMinidump(rig, 'pending/fresh.dmp', rig.tick());
    const sessionB = createCrashDetection(rig.deps);
    const armed = sessionB.detectBootCrash();
    expect(armed?.kind).toBe('boot');
    if (armed?.kind === 'boot') {
      expect(armed.context.dirtyShutdown).toBe(false);
      expect(armed.context.newMinidumps).toBe(1);
      expect(armed.minidumpAvailable).toBe(true);
    }
    if (!armed) throw new Error('expected a minidump-driven boot invitation');
    sessionB.ack(armed.eventId);
    sessionB.markCleanQuit();

    const sessionC = createCrashDetection(rig.deps);
    expect(sessionC.detectBootCrash()).toBeNull();
  });

  test('a corrupt acknowledgment store fails open to a fresh baseline', () => {
    const rig = makeRig();
    mkdirSync(dirname(rig.deps.ackStorePath), { recursive: true });
    writeFileSync(rig.deps.ackStorePath, 'not json{');
    seedMinidump(rig, 'pending/old.dmp', new Date('2026-07-09T00:00:00.000Z'));

    const detection = createCrashDetection(rig.deps);
    expect(detection.detectBootCrash()).toBeNull();

    const rewritten: unknown = JSON.parse(readFileSync(rig.deps.ackStorePath, 'utf8'));
    expect((rewritten as { ackedEventIds: string[] }).ackedEventIds).toEqual([]);
  });

  test('an unreadable sentinel still counts as a dirty shutdown', () => {
    const rig = makeRig();
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    writeFileSync(rig.deps.sentinelPath, 'torn-write-not-json');

    const detection = createCrashDetection(rig.deps);
    const armed = detection.detectBootCrash();
    expect(armed?.kind).toBe('boot');
    if (armed?.kind === 'boot') {
      expect(armed.context.dirtyShutdown).toBe(true);
    }
  });
});

describe('machine-level death suppression', () => {
  test('a dirty shutdown from the same kernel session still prompts', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    // Session A crashes; the machine keeps running (same boot-session uuid).

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(armed?.kind).toBe('boot');
    if (armed?.kind === 'boot') {
      expect(armed.context.dirtyShutdown).toBe(true);
    }
  });

  test('a dirty shutdown across a kernel reboot never prompts', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    // Session A is killed by a machine reboot — next boot is a new kernel session.

    rig.setBootSessionUuid('boot-epoch-b');
    const sessionB = createCrashDetection(rig.deps);
    expect(sessionB.detectBootCrash()).toBeNull();
    sessionB.notifyRendererReady();
    expect(rig.emitted).toHaveLength(0);

    // The replacement sentinel carries the new kernel session's identity.
    expect(readSentinel(rig).bootSessionUuid).toBe('boot-epoch-b');
  });

  test('suppression logs a breadcrumb naming the reboot', () => {
    const rig = makeRig();
    const infoLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: (payload: Record<string, unknown>) => {
        infoLines.push(payload);
      },
      warn: () => {},
    };
    createCrashDetection(rig.deps).detectBootCrash();

    rig.setBootSessionUuid('boot-epoch-b');
    createCrashDetection(rig.deps).detectBootCrash();

    const breadcrumb = infoLines.find(
      (line) => line.event === 'crash-detection.machine-level-death',
    );
    expect(breadcrumb?.reason).toBe('system-reboot');
    expect(breadcrumb?.prevBootSessionUuid).toBe('boot-epoch-a');
    expect(breadcrumb?.currentBootSessionUuid).toBe('boot-epoch-b');
    expect(breadcrumb?.lastAliveAt).toBeTruthy();
  });

  test('a fresh minidump still prompts across a reboot, as the dump-driven variant', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    seedMinidump(rig, 'pending/native-crash.dmp', rig.tick());
    // The app native-crashed (dump on disk), then the machine rebooted.

    rig.setBootSessionUuid('boot-epoch-b');
    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(armed?.kind).toBe('boot');
    expect(armed?.eventId).toStartWith('boot:dump:');
    if (armed?.kind === 'boot') {
      expect(armed.context.dirtyShutdown).toBe(false);
      expect(armed.context.newMinidumps).toBe(1);
    }
  });

  test('a session that died asleep (suspended, never resumed) never prompts', () => {
    const rig = makeRig();
    const infoLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: (payload: Record<string, unknown>) => {
        infoLines.push(payload);
      },
      warn: () => {},
    };
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.noteSuspend();
    // The machine loses power while asleep (e.g. the battery dies) — safe-sleep
    // resume preserves the kernel boot session (Apple's IOPMrootDomain docs:
    // BootSessionUUID "remain[s] same across sleep/wake/hibernate cycle"), so
    // there is no reboot to detect, and no OS-shutdown marker either — the OS
    // never got a chance to announce anything before power was cut.

    const sessionB = createCrashDetection(rig.deps);
    const armed = sessionB.detectBootCrash();
    expect(armed).toBeNull();
    sessionB.notifyRendererReady();
    expect(rig.emitted).toHaveLength(0);

    const breadcrumb = infoLines.find(
      (line) => line.event === 'crash-detection.machine-level-death',
    );
    expect(breadcrumb?.reason).toBe('suspended');
    expect(breadcrumb?.suspendedAt).toBeTruthy();
  });

  test('a session that resumed from suspend before a later, unrelated crash still prompts', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.noteSuspend();
    sessionA.noteResume();
    // Session A wakes normally, then later crashes for an unrelated reason
    // (still no markCleanQuit) — this pins that `noteResume()` actually
    // clears the suspend marker, since a regression there would silently
    // suppress every crash following any sleep/wake cycle.

    const sessionB = createCrashDetection(rig.deps);
    const armed = sessionB.detectBootCrash();
    expect(armed?.kind).toBe('boot');
    if (armed?.kind === 'boot') {
      expect(armed.context.dirtyShutdown).toBe(true);
    }
    sessionB.notifyRendererReady();
    expect(rig.emitted).toHaveLength(1);
  });

  test('an OS shutdown that outran the quit sequence never prompts', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.noteOsShutdown();
    // The OS kills the app before will-quit completes — same kernel session
    // on the next launch (shutdown was e.g. a logout-style teardown).

    const sessionB = createCrashDetection(rig.deps);
    expect(sessionB.detectBootCrash()).toBeNull();
    sessionB.notifyRendererReady();
    expect(rig.emitted).toHaveLength(0);
  });

  test('an OS-shutdown suppression logs a warn breadcrumb naming the marker', () => {
    const rig = makeRig();
    const warnLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: () => {},
      warn: (payload: Record<string, unknown>) => {
        warnLines.push(payload);
      },
    };
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.noteOsShutdown();

    createCrashDetection(rig.deps).detectBootCrash();

    const breadcrumb = warnLines.find(
      (line) => line.event === 'crash-detection.machine-level-death',
    );
    expect(breadcrumb?.reason).toBe('os-shutdown');
    expect(breadcrumb?.pendingOsShutdownAt).toBeTruthy();
    expect(breadcrumb?.prevBootSessionUuid).toBe('boot-epoch-a');
  });

  test('a cancelled OS shutdown stops suppressing once heartbeats outlive the marker', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.noteOsShutdown();
    // The user cancels the shutdown; the app keeps running and heartbeating
    // past the marker TTL (the fake clock advances 10s per heartbeat), then
    // genuinely crashes.
    for (let i = 0; i < 15; i++) sessionA.noteAlive();
    expect(readSentinel(rig).pendingOsShutdownAt).toBeUndefined();

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(armed?.kind).toBe('boot');
  });

  test('a pre-upgrade sentinel without a kernel identity prompts as before', () => {
    const rig = makeRig();
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    writeFileSync(
      rig.deps.sentinelPath,
      `${JSON.stringify({ bootId: '1784494925550', startedAt: '2026-07-09T21:02:05.550Z' })}\n`,
    );

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(armed?.kind).toBe('boot');
    expect(armed?.eventId).toBe('boot:1784494925550');
  });

  test('no kernel identity available fails open to prompting', () => {
    // Probe unavailable in the crashed session: its sentinel has no uuid.
    const rig = makeRig();
    rig.setBootSessionUuid(null);
    createCrashDetection(rig.deps).detectBootCrash();
    rig.setBootSessionUuid('boot-epoch-b');
    expect(createCrashDetection(rig.deps).detectBootCrash()?.kind).toBe('boot');

    // Probe unavailable in the detecting session.
    const rig2 = makeRig();
    createCrashDetection(rig2.deps).detectBootCrash();
    rig2.setBootSessionUuid(null);
    expect(createCrashDetection(rig2.deps).detectBootCrash()?.kind).toBe('boot');
  });

  test('the heartbeat refreshes liveness and freezes after a clean quit', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    detection.detectBootCrash();
    const first = readSentinel(rig).lastAliveAt;
    if (first === undefined) throw new Error('expected lastAliveAt in the sentinel');

    detection.noteAlive();
    const second = readSentinel(rig).lastAliveAt;
    if (second === undefined) throw new Error('expected lastAliveAt after a heartbeat');
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));

    detection.markCleanQuit();
    expect(existsSync(rig.deps.sentinelPath)).toBe(false);
    // A straggling timer tick after the orderly quit must not resurrect the
    // sentinel — that would turn every clean quit into a phantom crash.
    detection.noteAlive();
    expect(existsSync(rig.deps.sentinelPath)).toBe(false);
  });

  test('suspend and resume are mirrored into the sentinel', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    detection.detectBootCrash();

    detection.noteSuspend();
    expect(readSentinel(rig).suspendedAt).toBeTruthy();

    detection.noteResume();
    expect(readSentinel(rig).suspendedAt).toBeUndefined();
  });
});

describe('newest un-acked minidump lookup', () => {
  test('returns the newest dump past the ack baseline, and none once acked', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    const older = rig.tick();
    const newer = rig.tick();
    seedMinidump(rig, 'pending/older.dmp', older);
    seedMinidump(rig, 'completed/newer.dmp', newer);

    expect(detection.newestMinidumpPath()).toBe(
      join(rig.deps.crashDumpsDir, 'completed', 'newer.dmp'),
    );

    detection.ack('boot:some-earlier-event');
    expect(detection.newestMinidumpPath()).toBeNull();
  });

  test('dumps already covered by the fresh-install baseline never surface', () => {
    const rig = makeRig();
    seedMinidump(rig, 'pending/historic.dmp', new Date(Date.parse('2026-07-09T00:00:00.000Z')));
    const detection = createCrashDetection(rig.deps);

    expect(detection.newestMinidumpPath()).toBeNull();
  });

  test('a crash-dumps dir Crashpad has not created yet reads as no dump', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    expect(detection.newestMinidumpPath()).toBeNull();
  });
});

describe('process-level invariants', () => {
  test('crash detection registers no userland uncaughtException handler', () => {
    // Assert crash detection adds no NET uncaughtException listener rather than an
    // absolute count of zero: the test runner installs its own handler, so the
    // baseline is nonzero and only the delta attributable to createCrashDetection
    // is meaningful.
    const before = process.listenerCount('uncaughtException');
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    detection.detectBootCrash();
    detection.handleRenderProcessGone({ reason: 'crashed' });
    detection.notifyRendererReady();

    expect(process.listenerCount('uncaughtException')).toBe(before);
  });

  test('the crash reporter starts local-only, with upload disabled', () => {
    const calls: Array<{ uploadToServer: boolean }> = [];
    startLocalCrashReporter({
      start(options) {
        calls.push(options);
      },
    });

    expect(calls).toEqual([{ uploadToServer: false }]);
  });
});
