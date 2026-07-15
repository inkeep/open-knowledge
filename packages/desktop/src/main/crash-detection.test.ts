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
  /** Advance and return the fake clock (10s per tick). */
  tick(): Date;
  dir: string;
}

function makeRig(): Rig {
  const dir = mkdtempSync(resolve(tmpdir(), 'ok-crash-detection-'));
  tmpDirs.push(dir);
  const emitted: OkBugReportCrashDetectedEvent[] = [];
  let rendererAvailable = true;
  let clockMs = Date.parse('2026-07-10T00:00:00.000Z');
  return {
    dir,
    emitted,
    setRendererAvailable(available: boolean) {
      rendererAvailable = available;
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
      logger: silentLogger,
    },
  };
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
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    detection.detectBootCrash();
    detection.handleRenderProcessGone({ reason: 'crashed' });
    detection.notifyRendererReady();

    expect(process.listenerCount('uncaughtException')).toBe(0);
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
