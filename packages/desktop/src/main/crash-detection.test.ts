/**
 * Crash-detection pipeline tests: injected signal sources, a fake renderer
 * push, and tmpdir-backed sentinel/store/minidump paths — the same
 * injectable-deps posture as the sibling IPC handler tests. The clock is a
 * deterministic advancing fake so sentinel boot ids, ack baselines, and
 * seeded minidump mtimes are all comparable without wall-clock races.
 */

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
import { afterEach, describe, expect, test } from 'vitest';
import {
  type CrashDetectionDeps,
  createCrashDetection,
  startLocalCrashReporter,
} from './crash-detection.ts';
import { buildMinidump } from './minidump.test-helper.ts';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A third-party GUI app that inherited our exception handler and aborted. */
const FOREIGN_DUMP = buildMinidump([
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/lib/dyld',
]);

/** Truncated past the header — the shape a crash-during-dump-write leaves. */
const UNPARSEABLE_DUMP = Buffer.from('minidump-bytes-that-are-not-a-minidump');

/**
 * The version a rig runs as by default, and the one it is updated to when a
 * test needs the crashed session and the detecting session to disagree — which
 * is the whole point of recording the crashed one separately.
 */
const CRASHED_VERSION = '0.41.0';
const DETECTING_VERSION = '0.46.1';

interface Rig {
  deps: CrashDetectionDeps;
  emitted: OkBugReportCrashDetectedEvent[];
  /** Structured payloads the detection logged at warn level, in order. */
  warnings: Record<string, unknown>[];
  /** A dump naming one of this rig's own executables as its main module. */
  ownDump: Buffer;
  /** The same dump, plus the Crashpad annotations a real one carries. */
  ownDumpStamped(version: string): Buffer;
  /**
   * A dump stamped like `ownDumpStamped`, plus Chromium's `ax_mode` crash key
   * in the module annotation objects — the SEPARATE structure real dumps carry
   * it in, not the simple dictionary beside the version.
   */
  ownDumpWithAxMode(version: string, mode: string): Buffer;
  /**
   * Ours, but captured by `CRASHPAD_SIMULATE_CRASH()` rather than by a fault —
   * what Chromium's GPU watchdog leaves behind for a process it then lets keep
   * running.
   */
  ownDumpSimulated: Buffer;
  /** Flip to false to simulate "no live renderer window can take the event". */
  setRendererAvailable(available: boolean): void;
  /** Swap the kernel boot-session identity, simulating a reboot between sessions. */
  setBootSessionUuid(uuid: string | null): void;
  /** Swap the running app version, simulating an auto-update between sessions. */
  setAppVersion(version: string): void;
  /** Advance and return the fake clock (10s per tick). */
  tick(): Date;
  /** Jump the fake clock forward, for windows measured in minutes. */
  advance(ms: number): void;
  dir: string;
}

function makeRig(): Rig {
  const dir = mkdtempSync(resolve(tmpdir(), 'ok-crash-detection-'));
  tmpDirs.push(dir);
  const emitted: OkBugReportCrashDetectedEvent[] = [];
  const warnings: Record<string, unknown>[] = [];
  let rendererAvailable = true;
  let bootSessionUuid: string | null = 'boot-epoch-a';
  let clockMs = Date.parse('2026-07-10T00:00:00.000Z');
  const appBundleRoot = join(dir, 'Applications', 'OpenKnowledge.app');
  // A helper process rather than the main binary: renderer/GPU/utility crashes
  // are the common case, and they must resolve inside the bundle root too.
  const ownModules = [
    join(
      appBundleRoot,
      'Contents',
      'Frameworks',
      'OpenKnowledge Helper (Renderer).app',
      'Contents',
      'MacOS',
      'OpenKnowledge Helper (Renderer)',
    ),
    '/usr/lib/dyld',
  ];
  const rig: Rig = {
    dir,
    emitted,
    warnings,
    ownDump: buildMinidump(ownModules),
    // 'CPsx' — kMachExceptionSimulated. Written as a literal rather than
    // imported from the production module so a change there fails here.
    ownDumpSimulated: buildMinidump(ownModules, { exceptionCode: 0x4350_7378 }),
    ownDumpStamped: (version: string) =>
      buildMinidump(ownModules, {
        annotations: { _productName: 'OpenKnowledge', _version: version, prod: 'Electron' },
      }),
    ownDumpWithAxMode: (version: string, mode: string) =>
      buildMinidump(ownModules, {
        annotations: { _productName: 'OpenKnowledge', _version: version, prod: 'Electron' },
        // A module carrying nothing comes first, as in a real dump, so a walk
        // that gave up at the first link would fail this.
        annotationObjects: [{}, { ax_mode: mode, process_type: 'renderer' }],
      }),
    setRendererAvailable(available: boolean) {
      rendererAvailable = available;
    },
    setBootSessionUuid(uuid: string | null) {
      bootSessionUuid = uuid;
    },
    setAppVersion(version: string) {
      rig.deps.appVersion = version;
    },
    tick() {
      clockMs += 10_000;
      return new Date(clockMs);
    },
    advance(ms: number) {
      clockMs += ms;
    },
    deps: {
      sentinelPath: join(dir, 'user-data', 'bug-report-dirty-shutdown.json'),
      ackStorePath: join(dir, 'user-data', 'bug-report-crash-acks.json'),
      crashDumpsDir: join(dir, 'crash-dumps'),
      appBundleRoot,
      appVersion: CRASHED_VERSION,
      // Pinned so the rig behaves identically on a macOS dev box and on Linux
      // CI. Left to `process.platform`, every crash-kind assertion below would
      // pass vacuously on CI, where the predicate is deliberately inert.
      platform: 'darwin',
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
      logger: {
        info: () => {},
        warn: (payload) => {
          warnings.push(payload);
        },
      },
    },
  };
  return rig;
}

/**
 * Narrow an armed invitation to the boot variant, failing if there isn't one.
 * Throwing rather than returning null keeps a regression in arming from
 * quietly reducing a caller to zero assertions, which an `if (kind === 'boot')`
 * guard around the interesting expectations would do.
 */
function bootInvite(armed: OkBugReportCrashDetectedEvent | null) {
  expect(armed?.kind).toBe('boot');
  if (armed?.kind !== 'boot') throw new Error('expected a boot invitation, got none');
  return armed;
}

function readSentinel(rig: Rig): Record<string, string | undefined> {
  return JSON.parse(readFileSync(rig.deps.sentinelPath, 'utf8')) as Record<
    string,
    string | undefined
  >;
}

/**
 * Seed a minidump whose mtime is pinned to the fake clock's timeline. Defaults
 * to a dump owned by this rig's app bundle, so every pre-existing test keeps
 * meaning "a dump for one of our own processes is on disk".
 */
function seedMinidump(rig: Rig, relPath: string, at: Date, contents: Buffer = rig.ownDump): string {
  const dumpPath = join(rig.deps.crashDumpsDir, relPath);
  mkdirSync(dirname(dumpPath), { recursive: true });
  writeFileSync(dumpPath, contents);
  utimesSync(dumpPath, at, at);
  return dumpPath;
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

    detection.handleChildProcessGone({ type: 'Utility', reason: 'oom', exitCode: 1 });

    expect(rig.emitted).toHaveLength(1);
    const event = rig.emitted[0];
    expect(event?.kind).toBe('child-process-gone');
    if (event?.kind === 'child-process-gone') {
      expect(event.context.processType).toBe('Utility');
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

  test('a crash an hour after an unanswered invitation supersedes it instead of staying silent', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    detection.handleRenderProcessGone({ reason: 'crashed' });
    expect(rig.emitted).toHaveLength(1);
    const first = rig.emitted[0];
    if (!first) throw new Error('expected a first invitation');

    // Nobody answers the first prompt. An hour later an independent crash
    // fires — the user has to hear about that one, or the app recovers in
    // silence and the only evidence is a window that blinked.
    rig.advance(60 * 60_000);
    detection.handleRenderProcessGone({ reason: 'crashed' });

    expect(rig.emitted).toHaveLength(2);
    expect(rig.emitted[1]?.eventId).not.toBe(first.eventId);
  });

  test('a crash inside the relatedness window still dedupes against the pending invitation', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    detection.handleRenderProcessGone({ reason: 'crashed' });
    // A crashloop's repeats belong to the incident the user was already asked
    // about; stacking a second prompt on them is the noise the guard prevents.
    rig.advance(30_000);
    detection.handleRenderProcessGone({ reason: 'crashed' });

    expect(rig.emitted).toHaveLength(1);
  });

  test('a superseded invitation is logged so the silence is legible after the fact', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    detection.handleRenderProcessGone({ reason: 'crashed' });
    const first = rig.emitted[0];
    if (!first) throw new Error('expected a first invitation');
    rig.advance(60 * 60_000);
    detection.handleRenderProcessGone({ reason: 'crashed' });

    const superseded = rig.warnings.find((w) => w.event === 'crash-detection.superseded');
    expect(superseded).toBeDefined();
    expect(superseded?.supersededEventId).toBe(first.eventId);
  });
});

/**
 * Chromium replaces a dead GPU process on its own, so the death the user is
 * being asked about is one they never saw. These pin the carve-out that holds
 * the prompt back, and the repeat that earns it anyway.
 */
describe('recoverable GPU crashes', () => {
  /** The payload of the one line every child death logs, suppressed or not. */
  function childGoneLog(rig: Rig): Record<string, unknown> | undefined {
    return rig.warnings.find((w) => w.event === 'crash-detection.child-process-gone');
  }

  test('an isolated GPU death never reaches the user', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    detection.handleChildProcessGone({ type: 'GPU', reason: 'crashed', exitCode: 5 });

    expect(rig.emitted).toHaveLength(0);
  });

  test('a suppressed GPU death still leaves a breadcrumb naming why', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    detection.handleChildProcessGone({ type: 'GPU', reason: 'crashed', exitCode: 5 });

    expect(childGoneLog(rig)).toMatchObject({
      processType: 'GPU',
      reason: 'crashed',
      exitCode: 5,
      gpuCrashesInWindow: 1,
      invitationSuppressed: 'gpu-recoverable',
    });
  });

  test('a GPU that will not stay up invites once the deaths repeat in the window', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    detection.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    detection.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    expect(rig.emitted).toHaveLength(0);

    detection.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });

    expect(rig.emitted).toHaveLength(1);
    const event = rig.emitted[0];
    expect(event?.kind).toBe('child-process-gone');
    if (event?.kind === 'child-process-gone') {
      expect(event.context.processType).toBe('GPU');
    }
    // The line that finally invited names the count it decided on, and drops
    // the suppression marker — otherwise the two outcomes read alike in a log.
    const invited = rig.warnings
      .filter((w) => w.event === 'crash-detection.child-process-gone')
      .at(-1);
    expect(invited).toMatchObject({ gpuCrashesInWindow: 3 });
    expect(invited).not.toHaveProperty('invitationSuppressed');
  });

  test('deaths spread beyond the window are independent blips, not a pattern', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    detection.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    detection.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    rig.advance(6 * 60_000);
    detection.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });

    expect(rig.emitted).toHaveLength(0);
  });

  test('the reason does not change the carve-out — an oom GPU recovers the same way', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    detection.handleChildProcessGone({ type: 'GPU', reason: 'oom' });

    expect(rig.emitted).toHaveLength(0);
  });

  test('routine GPU teardown does not count toward the window', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    // Ordering guard: the crash-reason gate runs before the GPU counter, so an
    // ordinary teardown must not fill the window. Were it counted, the second
    // real death below would land third and invite.
    detection.handleChildProcessGone({ type: 'GPU', reason: 'clean-exit' });
    detection.handleChildProcessGone({ type: 'GPU', reason: 'killed' });
    detection.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    detection.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });

    expect(rig.emitted).toHaveLength(0);
  });

  test('every other child process still invites on its first death', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    detection.handleChildProcessGone({ type: 'Utility', reason: 'crashed' });

    expect(rig.emitted).toHaveLength(1);
    expect(childGoneLog(rig)).not.toHaveProperty('gpuCrashesInWindow');
  });

  test('a renderer crash still invites while GPU deaths are being held back', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    detection.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    detection.handleRenderProcessGone({ reason: 'crashed' });

    expect(rig.emitted).toHaveLength(1);
    expect(rig.emitted[0]?.kind).toBe('render-process-gone');
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
    expect(armed?.eventId.slice(0, 'boot:dump:'.length)).toBe('boot:dump:');
    if (armed?.kind === 'boot') {
      expect(armed.context.dirtyShutdown).toBe(false);
      expect(armed.context.newMinidumps).toBe(1);
      // Ownership decides availability, and this is the one path that reaches
      // it across a boot-session boundary — a root that went stale between
      // sessions would show up here and nowhere else.
      expect(armed.minidumpAvailable).toBe(true);
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

    expect(detection.newestMinidumpForReport().path).toBe(
      join(rig.deps.crashDumpsDir, 'completed', 'newer.dmp'),
    );

    detection.ack('boot:some-earlier-event');
    expect(detection.newestMinidumpForReport().path).toBeNull();
  });

  test('dumps already covered by the fresh-install baseline never surface', () => {
    const rig = makeRig();
    seedMinidump(rig, 'pending/historic.dmp', new Date(Date.parse('2026-07-09T00:00:00.000Z')));
    const detection = createCrashDetection(rig.deps);

    expect(detection.newestMinidumpForReport().path).toBeNull();
  });

  test('a crash-dumps dir Crashpad has not created yet reads as no dump', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    expect(detection.newestMinidumpForReport().path).toBeNull();
  });
});

/**
 * macOS inherits Mach exception ports across fork/exec, so anything descended
 * from the app — the in-app terminal's shell, an MCP server, an unrelated GUI
 * app launched from that shell — writes its crash into OUR crash database under
 * OUR annotations. Two separate consequences are pinned here: a foreign dump
 * must not arm a report invitation, and (the serious one) it must never be
 * attachable to a bundle that leaves the machine carrying another program's
 * process memory.
 */
describe('crash-dump ownership filtering', () => {
  /** Boot with a clean previous session, so dumps are the only arming signal. */
  function bootAfterCleanQuit(rig: Rig) {
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.markCleanQuit();
  }

  test('a dump from one of our own processes still arms and is still attachable', () => {
    const rig = makeRig();
    bootAfterCleanQuit(rig);
    const ownPath = seedMinidump(rig, 'pending/ours.dmp', rig.tick());

    const session = createCrashDetection(rig.deps);
    const armed = session.detectBootCrash();

    expect(armed?.kind).toBe('boot');
    if (armed?.kind === 'boot') {
      expect(armed.context.dirtyShutdown).toBe(false);
      expect(armed.context.newMinidumps).toBe(1);
      expect(armed.minidumpAvailable).toBe(true);
    }
    expect(session.newestMinidumpForReport().path).toBe(ownPath);
  });

  test('a dump from a foreign process neither arms nor is attachable', () => {
    const rig = makeRig();
    bootAfterCleanQuit(rig);
    seedMinidump(rig, 'pending/soffice.dmp', rig.tick(), FOREIGN_DUMP);

    const session = createCrashDetection(rig.deps);

    // The shape that misfires without the ownership gate: the app quit
    // cleanly, a third-party app the user launched from the in-app terminal
    // aborted, and the next boot claimed "the previous session crashed".
    expect(session.detectBootCrash()).toBeNull();
    session.notifyRendererReady();
    expect(rig.emitted).toHaveLength(0);
    expect(session.newestMinidumpForReport().path).toBeNull();
  });

  test('a bundle-root prefix collision does not read as ownership', () => {
    const rig = makeRig();
    bootAfterCleanQuit(rig);
    seedMinidump(
      rig,
      'pending/lookalike.dmp',
      rig.tick(),
      buildMinidump([`${rig.deps.appBundleRoot}.malicious/Contents/MacOS/OpenKnowledge`]),
    );

    const session = createCrashDetection(rig.deps);

    expect(session.detectBootCrash()).toBeNull();
    expect(session.newestMinidumpForReport().path).toBeNull();
  });

  test('an unparseable dump still arms, but is never attachable', () => {
    const rig = makeRig();
    bootAfterCleanQuit(rig);
    seedMinidump(rig, 'pending/torn.dmp', rig.tick(), UNPARSEABLE_DUMP);

    const session = createCrashDetection(rig.deps);
    const armed = session.detectBootCrash();

    // Fail open on the prompt: a dump truncated by the very crash that wrote it
    // is probably ours, and a wrong guess costs one dismissible question.
    expect(armed?.kind).toBe('boot');
    if (armed?.kind === 'boot') {
      expect(armed.context.newMinidumps).toBe(1);
      // Fail closed on egress: memory whose owner we cannot establish is memory
      // the consent dialog cannot honestly describe.
      expect(armed.minidumpAvailable).toBe(false);
    }
    expect(session.newestMinidumpForReport().path).toBeNull();
  });

  test('a foreign dump does not override machine-level-death suppression', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    seedMinidump(rig, 'pending/soffice.dmp', rig.tick(), FOREIGN_DUMP);
    // The machine rebooted out from under the session. A dump written for some
    // other program is no evidence that this app native-crashed first, so the
    // fresh-dump override must not engage.

    rig.setBootSessionUuid('boot-epoch-b');
    const session = createCrashDetection(rig.deps);

    expect(session.detectBootCrash()).toBeNull();
  });

  test('a dirty shutdown still prompts when the only fresh dump is foreign', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    // Session A really did die (its sentinel survives) while an unrelated
    // descendant also crashed — same kernel session, so no reboot suppression.
    seedMinidump(rig, 'pending/soffice.dmp', rig.tick(), FOREIGN_DUMP);

    const armed = createCrashDetection(rig.deps).detectBootCrash();

    expect(armed?.kind).toBe('boot');
    if (armed?.kind === 'boot') {
      expect(armed.context.dirtyShutdown).toBe(true);
      expect(armed.context.newMinidumps).toBe(0);
      expect(armed.minidumpAvailable).toBe(false);
    }
  });

  test('the newest OWN dump is attachable even when a newer foreign dump exists', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    const ownPath = seedMinidump(rig, 'completed/ours.dmp', rig.tick());
    seedMinidump(rig, 'pending/soffice.dmp', rig.tick(), FOREIGN_DUMP);

    expect(detection.newestMinidumpForReport().path).toBe(ownPath);
  });

  test('a runtime crash offers no dump when only a foreign dump is on disk', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    seedMinidump(rig, 'completed/soffice.dmp', rig.tick(), FOREIGN_DUMP);

    detection.handleRenderProcessGone({ reason: 'crashed' });

    expect(rig.emitted[0]?.minidumpAvailable).toBe(false);
    expect(detection.newestMinidumpForReport().path).toBeNull();
  });

  test('the report lookup carries the skip counts alongside the dump it found', () => {
    // The report path needs its own copy of these: the boot-time breadcrumb
    // only fires at boot, so a report composed later has no other record of
    // what the ownership walk rejected.
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    seedMinidump(rig, 'completed/soffice.dmp', rig.tick(), FOREIGN_DUMP);
    seedMinidump(rig, 'completed/torn.dmp', rig.tick(), UNPARSEABLE_DUMP);
    const ownPath = seedMinidump(rig, 'completed/ours.dmp', rig.tick());

    // Newest-first, so the owned dump seeded last is reached first and the
    // older rejects are never classified — nothing to count.
    expect(detection.newestMinidumpForReport()).toEqual({
      path: ownPath,
      foreignSkipped: 0,
      unknownSkipped: 0,
    });
  });

  test('an empty-handed report lookup says what it walked past to get there', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    seedMinidump(rig, 'completed/soffice.dmp', rig.tick(), FOREIGN_DUMP);
    seedMinidump(rig, 'completed/torn.dmp', rig.tick(), UNPARSEABLE_DUMP);

    // Without the split, "a descendant crashed" and "we could not read the
    // dump at all" both reach the report as a bare absent dump.
    expect(detection.newestMinidumpForReport()).toEqual({
      path: null,
      foreignSkipped: 1,
      unknownSkipped: 1,
    });
  });

  test('the report lookup still stops at the first owned dump', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    seedMinidump(rig, 'completed/soffice.dmp', rig.tick(), FOREIGN_DUMP);
    const ownPath = seedMinidump(rig, 'completed/ours.dmp', rig.tick());
    seedMinidump(rig, 'completed/newer-soffice.dmp', rig.tick(), FOREIGN_DUMP);

    // One newer foreign dump gets classified on the way to ours; the older one
    // is never reached. Counting every fresh dump instead would mean parsing
    // the whole crash database on each lookup.
    expect(detection.newestMinidumpForReport()).toEqual({
      path: ownPath,
      foreignSkipped: 1,
      unknownSkipped: 0,
    });
  });

  test('a runtime crash says how many foreign dumps it walked past', () => {
    // "No checkbox" has two very different causes at runtime — Crashpad still
    // flushing our dump, or a descendant's dump being skipped — and only this
    // count tells an operator which one they are looking at.
    const rig = makeRig();
    const warnLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: () => {},
      warn: (payload: Record<string, unknown>) => {
        warnLines.push(payload);
      },
    };
    const detection = createCrashDetection(rig.deps);
    seedMinidump(rig, 'completed/soffice.dmp', rig.tick(), FOREIGN_DUMP);

    detection.handleRenderProcessGone({ reason: 'crashed' });

    expect(
      warnLines.find((line) => line.event === 'crash-detection.render-process-gone')
        ?.foreignDumpsIgnored,
    ).toBe(1);
  });

  test('a runtime crash counts unreadable dumps apart from foreign ones', () => {
    // The two mean different things to whoever reads the line: a foreign dump
    // is a descendant crashing, an unreadable one is a half-flushed dump or
    // the first sign the format drifted. Folded together they say neither.
    const rig = makeRig();
    const warnLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: () => {},
      warn: (payload: Record<string, unknown>) => {
        warnLines.push(payload);
      },
    };
    const detection = createCrashDetection(rig.deps);
    seedMinidump(rig, 'completed/torn.dmp', rig.tick(), UNPARSEABLE_DUMP);

    detection.handleRenderProcessGone({ reason: 'crashed' });

    const line = warnLines.find((l) => l.event === 'crash-detection.render-process-gone');
    expect(line?.unreadableDumpsSkipped).toBe(1);
    expect(line?.foreignDumpsIgnored).toBe(0);
    expect(rig.emitted[0]?.minidumpAvailable).toBe(false);
  });

  test('an own dump found first is not reported as foreign dumps ignored', () => {
    // The walk stops at the first owned dump, so the count only ever describes
    // what it actually rejected getting there.
    const rig = makeRig();
    const warnLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: () => {},
      warn: (payload: Record<string, unknown>) => {
        warnLines.push(payload);
      },
    };
    const detection = createCrashDetection(rig.deps);
    seedMinidump(rig, 'completed/ours.dmp', rig.tick());

    detection.handleChildProcessGone({ type: 'Utility', reason: 'crashed' });

    const line = warnLines.find((l) => l.event === 'crash-detection.child-process-gone');
    expect(line?.foreignDumpsIgnored).toBe(0);
    expect(rig.emitted[0]?.minidumpAvailable).toBe(true);
  });

  test('ignored foreign dumps leave a breadcrumb', () => {
    const rig = makeRig();
    const infoLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: (payload: Record<string, unknown>) => {
        infoLines.push(payload);
      },
      warn: () => {},
    };
    bootAfterCleanQuit(rig);
    seedMinidump(rig, 'pending/soffice.dmp', rig.tick(), FOREIGN_DUMP);

    createCrashDetection(rig.deps).detectBootCrash();

    // A silent suppression is indistinguishable from detection never running.
    const breadcrumb = infoLines.find(
      (line) => line.event === 'crash-detection.foreign-dumps-ignored',
    );
    expect(breadcrumb?.count).toBe(1);
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

/**
 * Which version a boot-time invitation names. The report is composed by the
 * session that DETECTS the crash, which an auto-update in between makes a
 * different build from the one that died — and the detecting session's own
 * version is the one thing that must never be substituted, since it is exactly
 * the wrong answer in the case worth reporting.
 */
describe('the version a boot invitation attributes the crash to', () => {
  test('a dirty shutdown names the crashed version, not the detecting one', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();

    // The app is replaced by an auto-update before the next launch notices.
    rig.setAppVersion(DETECTING_VERSION);
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.context.dirtyShutdown).toBe(true);
    expect(armed.crashedAppVersion).toBe(CRASHED_VERSION);
  });

  test('a dirty shutdown keeps its sentinel as witness even with a dump of its own', () => {
    // The ordinary same-boot-session crash, and the pivot the whole attribution
    // turns on: both witnesses are present and they disagree, and the sentinel
    // is the one that decided the event id, so it is the one that names the
    // version. A refactor that made a sentinel-present shutdown dump-driven
    // would read the dump here instead — silently, with every neighbouring
    // test still green, since each of those has only one witness to choose from.
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    const bootId = readSentinel(rig).bootId;
    seedMinidump(rig, 'pending/native.dmp', rig.tick(), rig.ownDumpStamped('0.41.0-beta.4'));

    rig.setAppVersion(DETECTING_VERSION);
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.context.dirtyShutdown).toBe(true);
    // Asserted as the exact id rather than "not a dump id": the form names
    // which witness decided, which is the thing the version has to follow.
    expect(armed.eventId).toBe(`boot:${bootId}`);
    expect(armed.crashedAppVersion).toBe(CRASHED_VERSION);
  });

  test('a dump-driven event reads the version stamped inside the dump', () => {
    // No sentinel survives a clean quit, so the dump is the only witness left.
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.markCleanQuit();
    seedMinidump(rig, 'pending/native.dmp', rig.tick(), rig.ownDumpStamped(CRASHED_VERSION));

    rig.setAppVersion(DETECTING_VERSION);
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.eventId.slice(0, 'boot:dump:'.length)).toBe('boot:dump:');
    expect(armed.context.dirtyShutdown).toBe(false);
    expect(armed.crashedAppVersion).toBe(CRASHED_VERSION);
  });

  test('the dump wins over the sentinel when a reboot makes the event dump-driven', () => {
    // Both witnesses exist here and they disagree. The dump is the more
    // precise one: it was written at the moment of the crash, while the
    // sentinel only records the session that happened to be running.
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    seedMinidump(rig, 'pending/native.dmp', rig.tick(), rig.ownDumpStamped('0.41.0-beta.3'));

    rig.setBootSessionUuid('boot-epoch-b');
    rig.setAppVersion(DETECTING_VERSION);
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.eventId.slice(0, 'boot:dump:'.length)).toBe('boot:dump:');
    expect(armed.crashedAppVersion).toBe('0.41.0-beta.3');
  });

  test('the version comes from the dump the event names, not the newest one', () => {
    // A descendant process that inherited our exception handler crashes AFTER
    // we do, and Crashpad stamps OUR annotations onto its dump — so the newest
    // dump in the database names the post-update build while describing an
    // unrelated program's death. Taking it would reinstate exactly the
    // misattribution this attributes around, and it sorts first.
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.markCleanQuit();
    const ourCrashAt = rig.tick();
    seedMinidump(rig, 'pending/ours.dmp', ourCrashAt, rig.ownDumpStamped(CRASHED_VERSION));
    seedMinidump(
      rig,
      'pending/descendant.dmp',
      rig.tick(),
      buildMinidump(['/Applications/LibreOffice.app/Contents/MacOS/soffice'], {
        annotations: { _version: DETECTING_VERSION },
      }),
    );

    rig.setAppVersion(DETECTING_VERSION);
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    // The id is keyed to our dump, and the version has to describe that same one.
    expect(armed.eventId).toBe(`boot:dump:${ourCrashAt.getTime()}`);
    expect(armed.crashedAppVersion).toBe(CRASHED_VERSION);
  });

  test('an unreadable dump ahead of an owned one leaves the version unknown', () => {
    // Arming fails open on a dump it cannot parse, so that dump still counts
    // toward the event and, being newest, still names it — and then the version
    // has to describe that same dump, which has nothing to say. Reading the
    // owned dump behind it would pin a version to an event id that names a
    // different crash. The silence is the intended outcome, not a gap: unknown
    // stays unknown, and the version never describes a dump other than the one
    // the reader is looking at.
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.markCleanQuit();
    seedMinidump(rig, 'pending/ours.dmp', rig.tick(), rig.ownDumpStamped(CRASHED_VERSION));
    const tornAt = rig.tick();
    seedMinidump(rig, 'pending/torn.dmp', tornAt, UNPARSEABLE_DUMP);

    rig.setAppVersion(DETECTING_VERSION);
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.eventId).toBe(`boot:dump:${tornAt.getTime()}`);
    expect(armed.crashedAppVersion).toBeUndefined();
    // Only the version was declined. The owned dump behind it is still there
    // to attach, so the silence costs the report nothing else.
    expect(armed.minidumpAvailable).toBe(true);
  });

  test('an unchanged version is still reported, so agreement is legible', () => {
    // Silence would be ambiguous: a reader could not tell "the same build" from
    // "too old to say".
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.crashedAppVersion).toBe(CRASHED_VERSION);
    expect(rig.deps.appVersion).toBe(CRASHED_VERSION);
  });

  test('a sentinel written before the field existed still prompts, with no version', () => {
    // The sentinel is read across app-version boundaries, so an older binary's
    // file must degrade to unknown rather than break detection.
    const rig = makeRig();
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    writeFileSync(
      rig.deps.sentinelPath,
      `${JSON.stringify({ bootId: '1784494925550', startedAt: '2026-07-09T21:02:05.550Z' })}\n`,
    );

    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.eventId).toBe('boot:1784494925550');
    expect(armed.crashedAppVersion).toBeUndefined();
  });

  test('a sentinel version that could forge a report line is refused', () => {
    // The sentinel is a file on disk like any other, and its value lands on
    // the same line-oriented report body the dump annotation does, so it gets
    // the same gate rather than being trusted for having been ours once.
    const rig = makeRig();
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    writeFileSync(
      rig.deps.sentinelPath,
      `${JSON.stringify({
        bootId: '1784494925550',
        startedAt: '2026-07-09T21:02:05.550Z',
        appVersion: `0.41.0${String.fromCharCode(10)}Crash source: something untrue`,
      })}\n`,
    );

    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.crashedAppVersion).toBeUndefined();
  });

  test('a dump carrying no annotations still arms and attaches, with no version', () => {
    // Absence of a version must never cost the report anything else.
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.markCleanQuit();
    seedMinidump(rig, 'pending/native.dmp', rig.tick());

    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.minidumpAvailable).toBe(true);
    expect(armed.crashedAppVersion).toBeUndefined();
  });

  test('a dump whose annotations are unreadable still arms, with no version', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.markCleanQuit();
    const corrupt = buildMinidump(
      [
        join(
          rig.deps.appBundleRoot,
          'Contents',
          'Frameworks',
          'OpenKnowledge Helper (Renderer).app',
          'Contents',
          'MacOS',
          'OpenKnowledge Helper (Renderer)',
        ),
      ],
      { annotations: { _version: CRASHED_VERSION }, annotationsRva: 0xffff },
    );
    seedMinidump(rig, 'pending/native.dmp', rig.tick(), corrupt);

    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.minidumpAvailable).toBe(true);
    expect(armed.crashedAppVersion).toBeUndefined();
  });

  test("this session's sentinel records the version now running", () => {
    const rig = makeRig();
    rig.setAppVersion(DETECTING_VERSION);
    createCrashDetection(rig.deps).detectBootCrash();

    expect(readSentinel(rig).appVersion).toBe(DETECTING_VERSION);
  });

  test('the boot breadcrumb carries both versions', () => {
    // This log line is what an incident gets reconstructed from when no report
    // was ever filed, so the pair has to be legible there too.
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();

    const infoLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: (payload: Record<string, unknown>) => {
        infoLines.push(payload);
      },
      warn: () => {},
    };
    rig.setAppVersion(DETECTING_VERSION);
    createCrashDetection(rig.deps).detectBootCrash();

    const breadcrumb = infoLines.find((line) => line.event === 'crash-detection.boot');
    expect(breadcrumb?.crashedAppVersion).toBe(CRASHED_VERSION);
    expect(breadcrumb?.detectingAppVersion).toBe(DETECTING_VERSION);
  });

  test('the boot breadcrumb tells an absent version apart from a broken parse', () => {
    // A dump too old to carry the annotation and a parser that broke on a
    // Crashpad layout change both reach the report as no version at all, and
    // they send whoever debugs it in opposite directions. The flag beside the
    // version is the only thing that separates them, so a dump that simply
    // registered no annotations is the case that must NOT read as a failure.
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.markCleanQuit();
    seedMinidump(rig, 'pending/native.dmp', rig.tick());

    const infoLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: (payload: Record<string, unknown>) => {
        infoLines.push(payload);
      },
      warn: () => {},
    };
    createCrashDetection(rig.deps).detectBootCrash();

    const breadcrumb = infoLines.find((line) => line.event === 'crash-detection.boot');
    expect(breadcrumb?.crashedAppVersion).toBeNull();
    expect(breadcrumb?.crashedAppVersionParseFailed).toBe(false);
  });

  test('the boot breadcrumb names the accessibility mode the dead session ran with', () => {
    // The precondition the Blink accessibility CHECK crashes turn on: that
    // CHECK is only reachable with a live accessibility tree, and
    // OK_FORCE_A11Y is opt-in, so before this line the tree's presence could
    // only be argued from circumstance. Chromium records it on every dump;
    // nothing read it.
    const mode = 'kNativeAPIs | kWebContents | kInlineTextBoxes | kExtendedPropert';
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.markCleanQuit();
    seedMinidump(
      rig,
      'pending/native.dmp',
      rig.tick(),
      rig.ownDumpWithAxMode(CRASHED_VERSION, mode),
    );

    const infoLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: (payload: Record<string, unknown>) => {
        infoLines.push(payload);
      },
      warn: () => {},
    };
    createCrashDetection(rig.deps).detectBootCrash();

    const breadcrumb = infoLines.find((line) => line.event === 'crash-detection.boot');
    expect(breadcrumb?.crashedAccessibilityMode).toBe(mode);
    expect(breadcrumb?.crashedAccessibilityModeParseFailed).toBe(false);
    // Read from the SAME dump as the version, so the two describe one death.
    expect(breadcrumb?.crashedAppVersion).toBe(CRASHED_VERSION);
  });

  test('a dump carrying no accessibility mode logs null, not a missing field', () => {
    // "We looked and the dump does not say" is itself the finding, and it is
    // NOT "accessibility was off" — a dump for a process with no renderer in it
    // never registers the key at all. A field that vanished here would make the
    // absent case indistinguishable from a build that predates this line.
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.markCleanQuit();
    seedMinidump(rig, 'pending/native.dmp', rig.tick(), rig.ownDumpStamped(CRASHED_VERSION));

    const infoLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: (payload: Record<string, unknown>) => {
        infoLines.push(payload);
      },
      warn: () => {},
    };
    createCrashDetection(rig.deps).detectBootCrash();

    const breadcrumb = infoLines.find((line) => line.event === 'crash-detection.boot');
    expect(breadcrumb).toHaveProperty('crashedAccessibilityMode');
    expect(breadcrumb?.crashedAccessibilityMode).toBeNull();
    expect(breadcrumb?.crashedAccessibilityModeParseFailed).toBe(false);
  });

  test('a foreign dump does not make the event dump-driven', () => {
    // A descendant process crashing is not this app crashing, so its dump must
    // not flip the event off the sentinel path — and the sentinel, not the
    // version the foreign dump happens to carry, stays the witness.
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    seedMinidump(
      rig,
      'pending/foreign.dmp',
      rig.tick(),
      buildMinidump(['/Applications/LibreOffice.app/Contents/MacOS/soffice'], {
        annotations: { _version: '9.9.9' },
      }),
    );

    rig.setAppVersion(DETECTING_VERSION);
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.context.dirtyShutdown).toBe(true);
    expect(armed.crashedAppVersion).toBe(CRASHED_VERSION);
  });
});

/**
 * Dumps that were captured without a fault.
 *
 * Chromium's GPU watchdog calls `DumpWithoutCrashing()` on a process that
 * merely looks stalled and may then let it keep running. The dump it leaves is
 * genuinely ours, so ownership says `'ours'` and every pre-existing signal
 * treats it as a crash. These tests pin the two consequences that fixes: the
 * app must stop asking about failures that never happened, and — the sharper
 * one — such a dump must never be handed to a report about a real crash.
 *
 * Each boot case runs the two-session shape the rest of this file uses: a
 * first session establishes the minidump baseline and quits cleanly, dumps are
 * seeded after it, and a second session does the detecting. Seeding before the
 * baseline exists would leave every dump filtered out, which reads as a pass
 * for the suppression cases while proving nothing.
 */
describe('non-crash minidumps', () => {
  /** Baseline the store, quit clean, and hand back a rig ready to seed dumps into. */
  function afterCleanQuit(rig: Rig): void {
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.markCleanQuit();
  }

  test('a clean quit whose only fresh dump is a snapshot arms nothing', () => {
    const rig = makeRig();
    afterCleanQuit(rig);
    seedMinidump(rig, 'pending/watchdog.dmp', rig.tick(), rig.ownDumpSimulated);

    // Before this change the dump alone armed the prompt, framed as an
    // unclean shutdown for a session that quit cleanly.
    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('a real crash still arms even when a snapshot sits alongside it', () => {
    const rig = makeRig();
    afterCleanQuit(rig);
    const crashedAt = rig.tick();
    seedMinidump(rig, 'pending/real.dmp', crashedAt);
    seedMinidump(rig, 'pending/watchdog.dmp', rig.tick(), rig.ownDumpSimulated);

    // The exclusion is per-dump, never per-scan: one snapshot in the set must
    // not suppress the crash sitting next to it.
    expect(bootInvite(createCrashDetection(rig.deps).detectBootCrash()).eventId).toBe(
      `boot:dump:${crashedAt.getTime()}`,
    );
  });

  test('an unreadable dump still arms — indeterminate is not a non-crash', () => {
    const rig = makeRig();
    afterCleanQuit(rig);
    seedMinidump(rig, 'pending/torn.dmp', rig.tick(), UNPARSEABLE_DUMP);

    // Arming keeps failing open. A dump truncated by the very fault that wrote
    // it must stay reportable.
    expect(createCrashDetection(rig.deps).detectBootCrash()).not.toBeNull();
  });

  test.each<NodeJS.Platform>([
    'linux',
    'win32',
  ])('on %s the snapshot still arms, because the predicate is gated off there', (platform) => {
    const rig = makeRig();
    rig.deps.platform = platform;
    afterCleanQuit(rig);
    seedMinidump(rig, 'pending/watchdog.dmp', rig.tick(), rig.ownDumpSimulated);

    // Those platforms' sentinels are known from Crashpad source but have not
    // been measured against a real dump there, so behavior must stay exactly
    // what it is today until one is.
    expect(createCrashDetection(rig.deps).detectBootCrash()).not.toBeNull();
  });

  test('a snapshot alone offers no dump to attach', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    seedMinidump(rig, 'pending/watchdog.dmp', rig.tick(), rig.ownDumpSimulated);

    detection.handleRenderProcessGone({ reason: 'crashed', exitCode: 5 });

    // Otherwise the report dialog offers to ship GPU process memory for a
    // crash that never occurred, pre-checked.
    expect(rig.emitted.at(-1)?.minidumpAvailable).toBe(false);
    expect(detection.newestMinidumpForReport().path).toBeNull();
  });

  test('a newer snapshot does not shadow the real crash dump being reported', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    const realPath = seedMinidump(rig, 'pending/real.dmp', rig.tick());
    seedMinidump(rig, 'pending/watchdog.dmp', rig.tick(), rig.ownDumpSimulated);

    // Resolution walks newest-first, so the snapshot is encountered FIRST.
    // Stepping over it rather than stopping is what keeps a legitimate crash
    // report from carrying the wrong process's memory under a consent notice
    // describing a different failure.
    expect(detection.newestMinidumpForReport().path).toBe(realPath);
  });

  test('skipped snapshots are counted apart from foreign and unreadable ones', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    seedMinidump(rig, 'pending/watchdog.dmp', rig.tick(), rig.ownDumpSimulated);

    detection.handleRenderProcessGone({ reason: 'crashed', exitCode: 5 });

    // Three counters, three meanings. Folded together, "detection declined on
    // purpose" would be indistinguishable from "the parser broke".
    const logged = rig.warnings.at(-1);
    expect(logged?.nonCrashDumpsSkipped).toBe(1);
    expect(logged?.foreignDumpsIgnored).toBe(0);
    expect(logged?.unreadableDumpsSkipped).toBe(0);
  });
});
