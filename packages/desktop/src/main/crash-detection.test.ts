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
import { installWasInFlightDuring } from './auto-updater.ts';
import {
  type CrashDetectionDeps,
  createCrashDetection,
  type InstallInFlight,
  SENTINEL_HEARTBEAT_INTERVAL_MS,
  startLocalCrashReporter,
} from './crash-detection.ts';
import { buildMinidump } from './minidump.test-helper.ts';
import { type AppState, emptyState } from './state-store.ts';

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
/** A third version, for telling two dumps in one scan apart by their stamps. */
const BLIP_VERSION = '0.44.2';

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
   * Ours, carrying Chromium's `process_type` crash key and nothing else of
   * note — the annotation that says which child died, in the dump's own
   * vocabulary (`gpu-process`, `renderer`) rather than Electron's.
   */
  ownDumpWithProcessType(processType: string, version?: string): Buffer;
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
  /**
   * Arm (or clear) the updater's "an install may still be running" verdict,
   * simulating a session the installer killed to swap the binary.
   */
  setInstallInFlight(inFlight: InstallInFlight | null): void;
  /** Swap the running app version, simulating an auto-update between sessions. */
  setAppVersion(version: string): void;
  /** Advance and return the fake clock (10s per tick). */
  tick(): Date;
  /** Jump the fake clock forward, for windows measured in minutes. */
  advance(ms: number): void;
  /**
   * Read the fake clock without moving it, to date a moment in the session
   * under test before advancing past it. Reading it must not perturb the tick
   * budget the surrounding assertions depend on, which is why this exists
   * alongside `tick`.
   */
  nowMs(): number;
  dir: string;
}

function makeRig(): Rig {
  const dir = mkdtempSync(resolve(tmpdir(), 'ok-crash-detection-'));
  tmpDirs.push(dir);
  const emitted: OkBugReportCrashDetectedEvent[] = [];
  const warnings: Record<string, unknown>[] = [];
  let rendererAvailable = true;
  let bootSessionUuid: string | null = 'boot-epoch-a';
  let installInFlight: InstallInFlight | null = null;
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
    ownDumpWithProcessType: (processType: string, version = CRASHED_VERSION) =>
      buildMinidump(ownModules, {
        annotations: { _productName: 'OpenKnowledge', _version: version, prod: 'Electron' },
        annotationObjects: [{}, { process_type: processType }],
      }),
    setRendererAvailable(available: boolean) {
      rendererAvailable = available;
    },
    setBootSessionUuid(uuid: string | null) {
      bootSessionUuid = uuid;
    },
    setInstallInFlight(inFlight: InstallInFlight | null) {
      installInFlight = inFlight;
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
    nowMs() {
      return clockMs;
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
      installInFlight: () => installInFlight,
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

  test('the reasons Windows gives reach the suppression breadcrumb', () => {
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
    // What Electron's win32 `session-end` hands us; `powerMonitor` on
    // linux/darwin has nothing to pass and calls this with no argument.
    sessionA.noteOsShutdown(['shutdown', 'logoff']);

    createCrashDetection(rig.deps).detectBootCrash();

    const breadcrumb = warnLines.find(
      (line) => line.event === 'crash-detection.machine-level-death',
    );
    expect(breadcrumb?.reason).toBe('os-shutdown');
    expect(breadcrumb?.osShutdownReasons).toEqual(['shutdown', 'logoff']);
  });

  test('an OS shutdown that named no cause reads as null, not an empty list', () => {
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
    // The macOS/Linux caller's shape — and the shape every sentinel written
    // before this field existed has.
    sessionA.noteOsShutdown();
    expect(readSentinel(rig).osShutdownReasons).toBeUndefined();

    createCrashDetection(rig.deps).detectBootCrash();

    const breadcrumb = warnLines.find(
      (line) => line.event === 'crash-detection.machine-level-death',
    );
    // Suppression is unaffected — the reasons are commentary, never a
    // precondition.
    expect(breadcrumb?.reason).toBe('os-shutdown');
    expect(breadcrumb?.osShutdownReasons).toBeNull();
  });

  test('a non-array from the native boundary still records the marker', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();

    // The parameter type is a compile-time claim about a value that arrives
    // from Electron's win32 event, not a runtime guarantee. If this threw, it
    // would take `writeSentinel` with it and lose the marker entirely — the
    // one thing this path exists to write.
    expect(() => sessionA.noteOsShutdown(null as unknown as readonly string[])).not.toThrow();

    expect(readSentinel(rig).pendingOsShutdownAt).toBeTruthy();
    expect(readSentinel(rig).osShutdownReasons).toBeUndefined();

    // And the marker still does its job.
    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(armed).toBeNull();
  });

  test('junk elements are filtered on the way IN, not just on the way out', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();

    sessionA.noteOsShutdown(['shutdown', '', 42, 'logoff'] as unknown as readonly string[]);

    // Asserted against the sentinel rather than the breadcrumb on purpose: the
    // read path filters again on every boot, so reading through a second
    // session would pass even if this write had persisted the junk. Only the
    // file says whether the write side did its job.
    expect((readSentinel(rig) as Record<string, unknown>).osShutdownReasons).toEqual([
      'shutdown',
      'logoff',
    ]);
  });

  test('a malformed reasons array degrades to null rather than throwing', () => {
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
    sessionA.noteOsShutdown(['shutdown']);
    // This file is read across app-version boundaries, so the array is only as
    // well-formed as whichever build wrote it.
    const sentinel = readSentinel(rig) as Record<string, unknown>;
    sentinel.osShutdownReasons = [42, '', null];
    writeFileSync(rig.deps.sentinelPath, JSON.stringify(sentinel));

    createCrashDetection(rig.deps).detectBootCrash();

    const breadcrumb = warnLines.find(
      (line) => line.event === 'crash-detection.machine-level-death',
    );
    expect(breadcrumb?.reason).toBe('os-shutdown');
    expect(breadcrumb?.osShutdownReasons).toBeNull();
  });

  test('a cancelled OS shutdown clears the reasons along with the marker', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.noteOsShutdown(['shutdown']);
    expect((readSentinel(rig) as Record<string, unknown>).osShutdownReasons).toEqual(['shutdown']);

    // Outlive the marker TTL, as the cancelled-shutdown test below does.
    for (let i = 0; i < 15; i++) sessionA.noteAlive();

    // A cause left behind for an ending that never happened would name a
    // shutdown in the breadcrumb of whatever killed the app next.
    expect(readSentinel(rig).pendingOsShutdownAt).toBeUndefined();
    expect(readSentinel(rig).osShutdownReasons).toBeUndefined();
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

  test('a sentinel-driven boot with no dump omits the accessibility fields entirely', () => {
    // The other half of the distinction the sibling test pins. A dirty shutdown
    // that left no dump means nothing was ever read, and an explicit null here
    // would claim we read a dump and it stayed silent. Absent and null are two
    // different findings; a `?? null` on this line would merge them.
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    // Session ends without markCleanQuit and without seeding any dump.

    const infoLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: (payload: Record<string, unknown>) => {
        infoLines.push(payload);
      },
      warn: () => {},
    };
    createCrashDetection(rig.deps).detectBootCrash();

    const breadcrumb = infoLines.find((line) => line.event === 'crash-detection.boot');
    expect(breadcrumb?.dirtyShutdown).toBe(true);
    expect(breadcrumb).not.toHaveProperty('crashedAccessibilityMode');
    expect(breadcrumb).not.toHaveProperty('crashedAccessibilityModeParseFailed');
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
 * When the dead session was last known alive, and whether the machine ended it
 * rather than the app failing — asleep, or mid-shutdown. The arming breadcrumb
 * is what a dirty-shutdown report gets reconstructed from, and on the path
 * where a fresh dump routes a machine-level death here it is the only record.
 * So a crash it cannot date leaves the death anywhere in the gap between the
 * session's last log line and the next launch, and one whose machine-level
 * cause it cannot name reads as an ordinary crash.
 */
describe('when a boot invitation says the dead session stopped', () => {
  test('the boot breadcrumb dates the dead session to its last heartbeat', () => {
    // Without this the line names a crash but never says when it happened, so
    // the window the session could have died in is the whole gap between its
    // last log line and this launch. The heartbeat refreshes the value every
    // SENTINEL_HEARTBEAT_INTERVAL_MS, which narrows that window to a minute —
    // and the readings it separates ("died early, the relaunch was late" vs
    // "hung until the relaunch") point at completely different bugs.
    const rig = makeRig();
    const dying = createCrashDetection(rig.deps);
    dying.detectBootCrash();
    rig.advance(5 * 60_000);
    dying.noteAlive();
    const lastAliveAt = readSentinel(rig).lastAliveAt;
    expect(lastAliveAt).toBeDefined();

    const infoLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: (payload: Record<string, unknown>) => {
        infoLines.push(payload);
      },
      warn: () => {},
    };
    createCrashDetection(rig.deps).detectBootCrash();

    const breadcrumb = infoLines.find((line) => line.event === 'crash-detection.boot');
    expect(breadcrumb?.lastAliveAt).toBe(lastAliveAt);
    expect(breadcrumb?.suspendedAt).toBeNull();
    expect(breadcrumb?.pendingOsShutdownAt).toBeNull();
    // The fourth witness the suppression predicate is built from. Present as an
    // explicit null on every dirty-shutdown prompt, which is what lets a reader
    // tell this build from one predating the question entirely.
    expect(breadcrumb).toHaveProperty('attemptedInstall');
    expect(breadcrumb?.attemptedInstall).toBeNull();
  });

  test('a sentinel written before the liveness fields existed logs them as null', () => {
    // Logged even when null, for the same reason the version beside them is:
    // "we could not tell" is itself the finding, and an old-format sentinel and
    // a torn write otherwise reach the report identically. A field that
    // vanished here would be indistinguishable from a build predating the line.
    const rig = makeRig();
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    writeFileSync(
      rig.deps.sentinelPath,
      `${JSON.stringify({ bootId: '1784494925550', startedAt: '2026-07-09T21:02:05.550Z' })}\n`,
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
    expect(breadcrumb).toHaveProperty('lastAliveAt');
    expect(breadcrumb).toHaveProperty('suspendedAt');
    expect(breadcrumb).toHaveProperty('pendingOsShutdownAt');
    expect(breadcrumb?.lastAliveAt).toBeNull();
    expect(breadcrumb?.suspendedAt).toBeNull();
    expect(breadcrumb?.pendingOsShutdownAt).toBeNull();
  });

  test('a dump-driven arming after a death asleep carries the suspend marker', () => {
    // The one path a non-null suspend marker reaches this line: a fresh dump
    // overrides the died-asleep suppression, so the session is reported as the
    // process dying rather than the machine ending it. The marker is then the
    // only thing telling a reader the crash happened with the lid shut, which
    // is the difference between a renderer fault and a power-loss artifact.
    const rig = makeRig();
    const dying = createCrashDetection(rig.deps);
    dying.detectBootCrash();
    dying.noteSuspend();
    const { lastAliveAt, suspendedAt } = readSentinel(rig);
    expect(suspendedAt).toBeDefined();
    expect(lastAliveAt).toBeDefined();
    seedMinidump(rig, 'pending/native.dmp', rig.tick());

    const infoLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: (payload: Record<string, unknown>) => {
        infoLines.push(payload);
      },
      warn: () => {},
    };
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    // Pin the routing the premise above depends on. Both branches forward
    // these two fields identically, so a refactor that dropped the suspend
    // marker from `machineLevelDeath` would fall through to the ordinary
    // dirty-shutdown branch and nothing here would notice.
    expect(armed.eventId).toMatch(/^boot:dump:/);
    expect(armed.context.dirtyShutdown).toBe(false);

    const breadcrumb = infoLines.find((line) => line.event === 'crash-detection.boot');
    expect(breadcrumb?.suspendedAt).toBe(suspendedAt);
    expect(breadcrumb?.lastAliveAt).toBe(lastAliveAt);
    expect(breadcrumb?.pendingOsShutdownAt).toBeNull();
  });

  test('a dump-driven arming after an announced OS shutdown carries that marker', () => {
    // The third witness the suppression predicate is built from, and it reaches
    // this line under the same dump override as the suspend marker. Without it
    // a reader seeing no suspend marker cannot separate an ordinary crash from
    // one the OS killed mid-quit, because on this path the suppression
    // breadcrumb that would have said so is never emitted at all.
    const rig = makeRig();
    const dying = createCrashDetection(rig.deps);
    dying.detectBootCrash();
    dying.noteOsShutdown();
    const pendingOsShutdownAt = readSentinel(rig).pendingOsShutdownAt;
    expect(pendingOsShutdownAt).toBeDefined();
    seedMinidump(rig, 'pending/native.dmp', rig.tick());

    const infoLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: (payload: Record<string, unknown>) => {
        infoLines.push(payload);
      },
      warn: () => {},
    };
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.eventId).toMatch(/^boot:dump:/);
    expect(armed.context.dirtyShutdown).toBe(false);

    const breadcrumb = infoLines.find((line) => line.event === 'crash-detection.boot');
    expect(breadcrumb?.pendingOsShutdownAt).toBe(pendingOsShutdownAt);
    expect(breadcrumb?.suspendedAt).toBeNull();
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

describe('auto-update install kill suppression', () => {
  /** What the updater reports while an install it committed to may still be running. */
  const IN_FLIGHT: InstallInFlight = {
    attemptedVersion: '0.61.3',
    handoffAt: Date.parse('2026-08-23T23:10:28.727Z'),
    recordedHandoff: true,
  };

  test('a session the installer killed never prompts', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    // Session A is killed by the installer swapping the binary underneath it:
    // no quit sequence runs, so the sentinel survives dirty. Same kernel
    // session, no OS-shutdown marker, no suspend marker, no dump — every
    // existing suppression class correctly declines, which is why this one
    // has to exist.
    rig.setInstallInFlight(IN_FLIGHT);

    const sessionB = createCrashDetection(rig.deps);
    expect(sessionB.detectBootCrash()).toBeNull();
    sessionB.notifyRendererReady();
    expect(rig.emitted).toHaveLength(0);
  });

  test('suppression logs a breadcrumb naming the attempted version', () => {
    const rig = makeRig();
    const infoLines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: (payload: Record<string, unknown>) => {
        infoLines.push(payload);
      },
      warn: () => {},
    };
    createCrashDetection(rig.deps).detectBootCrash();

    rig.setInstallInFlight(IN_FLIGHT);
    createCrashDetection(rig.deps).detectBootCrash();

    const breadcrumb = infoLines.find(
      (line) => line.event === 'crash-detection.machine-level-death',
    );
    expect(breadcrumb?.reason).toBe('update-install');
    // Naming the version is the whole point: without it a suppressed boot is
    // indistinguishable in the logs from one where detection never ran.
    expect(breadcrumb?.attemptedInstall).toBe('0.61.3');
    expect(breadcrumb?.recordedHandoff).toBe(true);
    // Every other moment on this line is an ISO string. A raw epoch here would
    // read as a plausible number beside them and quietly cost the reader the
    // comparison the field exists for. Named apart from the updater's own
    // `handoffAt`, which stays epoch ms, so one key never carries two
    // datatypes across the stream the two modules share.
    expect(breadcrumb?.handoffAtIso).toBe('2026-08-23T23:10:28.727Z');
  });

  test('a fresh minidump still prompts through an install kill', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    seedMinidump(rig, 'pending/native-crash.dmp', rig.tick());
    // The app native-crashed while an install happened to be in flight. A dump
    // is proof the app itself faulted, and proof outranks every suppression
    // class — the same rule the reboot path follows.
    rig.setInstallInFlight(IN_FLIGHT);

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(armed?.kind).toBe('boot');
    if (armed?.kind === 'boot') {
      expect(armed.context.newMinidumps).toBe(1);
    }
  });

  test('a dirty shutdown with no install in flight prompts exactly as before', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    // The no-regression case the reboot class pinned: kill -9 with nothing
    // staged, same kernel epoch. Nothing about this class may quieten it.
    rig.setInstallInFlight(null);

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(armed?.kind).toBe('boot');
    if (armed?.kind === 'boot') {
      expect(armed.context.dirtyShutdown).toBe(true);
    }
  });

  test('the win32 installer-swap shape is suppressed', () => {
    const rig = makeRig();
    rig.deps.platform = 'win32';
    rig.setAppVersion('0.58.8');
    // A session boots on the old binary while the NSIS installer runs, and is
    // killed mid-swap. The next boot is the newly installed version, so the
    // versions differ here — but a version delta cannot itself be the
    // classifier: when an install FAILS the relaunched app is the same version
    // as the one killed, and the delta is zero on exactly that subset.
    createCrashDetection(rig.deps).detectBootCrash();

    rig.setInstallInFlight(IN_FLIGHT);
    rig.setAppVersion('0.61.3');
    const sessionB = createCrashDetection(rig.deps);
    expect(sessionB.detectBootCrash()).toBeNull();
    sessionB.notifyRendererReady();
    expect(rig.emitted).toHaveLength(0);
  });

  test('a staging-fallback handoff suppresses too', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    // No live process saw the commit (a force-quit, a power loss), so the
    // updater fell back to the staging moment. A session that reached neither
    // commit point, neither the "Relaunch now" click nor `before-quit`, takes
    // this path. `crash-detection.ts` keeps the platform account.
    rig.setInstallInFlight({ ...IN_FLIGHT, recordedHandoff: false });

    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('an absent reader leaves every existing verdict unchanged', () => {
    const rig = makeRig();
    // Any caller that wires no updater state must behave exactly as before:
    // fail-open toward prompting.
    rig.deps.installInFlight = undefined;
    createCrashDetection(rig.deps).detectBootCrash();

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(armed?.kind).toBe('boot');
  });
});

/**
 * The join between crash detection and the updater's verdict, exercised with
 * the real predicate rather than a canned answer.
 *
 * Every test in the block above hands detection a fixed `InstallInFlight` and
 * so can only observe what detection does with a verdict, never how the
 * verdict was reached. The bound that decides the verdict is a window measured
 * from the install handoff, which means the instant the question is asked in
 * changes the answer. These tests therefore wire the real updater predicate and
 * model the one variable no test at either rung models: how long the app stayed
 * closed between the session the installer killed and the boot that detects it.
 *
 * The dep here answers about the span the previous session died in, which
 * detection bounds below by the sentinel's own `lastAliveAt` and above by the
 * moment this boot noticed the death. When the sentinel carries no usable one that
 * lower bound collapses onto the detecting boot's own clock, the one frame in
 * which the question decays with how long the app stayed closed, so a test
 * that suppresses only once a usable lower bound arrives is pinning the frame
 * rather than the plumbing.
 */
describe('the instant the install-kill question is asked in', () => {
  const ATTEMPTED = '0.61.3';
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

  /**
   * What a boot reads after a quit committed to an install: an attempt with a
   * handoff stamped at `handoffAt` and nothing yet observed to land. Callers
   * place that moment before, during, or after the doomed session's life
   * deliberately, since where it falls relative to the last heartbeat is what
   * most of this block is about.
   */
  function committedInstall(handoffAt: number): AppState {
    return {
      ...emptyState(),
      versionPendingInstall: ATTEMPTED,
      attemptedInstall: ATTEMPTED,
      attemptedInstallHandoffAt: handoffAt,
      versionPendingInstallStagedAt: handoffAt - 60_000,
      attemptedInstallDeferredBoots: 0,
    };
  }

  /**
   * What a boot reads after a download finished and nothing quit afterwards:
   * an attempt on record with no handoff stamped, so the only moment the
   * updater can date the commit to is when the artifact was staged. A session
   * that reached neither commit point arrives in exactly this shape, whatever
   * ended it. `crash-detection.ts` keeps the platform account.
   */
  function stagedButNeverCommitted(stagedAt: number): AppState {
    return {
      ...emptyState(),
      versionPendingInstall: ATTEMPTED,
      attemptedInstall: ATTEMPTED,
      attemptedInstallHandoffAt: null,
      versionPendingInstallStagedAt: stagedAt,
      attemptedInstallDeferredBoots: 0,
    };
  }

  function wireRealUpdater(rig: Rig, state: AppState): void {
    // The span forwarded whole, as the dep declares it. Substituting either end
    // would substitute the detecting boot's own clock, which is the one frame
    // this block exists to prove the verdict is not asked in.
    rig.deps.installInFlight = (span) =>
      installWasInFlightDuring(state, span, state.versionPendingInstallStagedAt);
  }

  test('an install in flight when the previous session died stays suppressed however late the reopen', () => {
    const rig = makeRig();
    wireRealUpdater(rig, committedInstall(rig.nowMs()));
    // The doomed session boots on the outgoing binary and is killed mid-swap,
    // so no quit sequence runs and its sentinel survives dirty, dated by the
    // heartbeat it wrote while alive.
    createCrashDetection(rig.deps).detectBootCrash();

    // The user does not come back until the evening. Whether an install was
    // running when that session died is settled history by then, and no amount
    // of the app sitting closed can unsettle it.
    rig.advance(TWO_HOURS_MS);

    const sessionB = createCrashDetection(rig.deps);
    expect(sessionB.detectBootCrash()).toBeNull();
    sessionB.notifyRendererReady();
    expect(rig.emitted).toHaveLength(0);
  });

  test('the same install kill is still suppressed when the user reopens promptly', () => {
    const rig = makeRig();
    wireRealUpdater(rig, committedInstall(rig.nowMs()));
    createCrashDetection(rig.deps).detectBootCrash();

    // The negative control for the test above. Anchoring the question to the
    // death must not cost the suppression that already works on a fast reopen,
    // which is what a fix that merely widened or moved the window would do.
    rig.advance(5 * 60_000);

    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('a dirty shutdown with nothing committed still prompts however late the reopen', () => {
    const rig = makeRig();
    // Nothing was ever handed off, so there is no install to attribute the
    // death to and the prompt is the whole point. This is the guard against
    // answering the frame question by suppressing everything.
    wireRealUpdater(rig, emptyState());
    createCrashDetection(rig.deps).detectBootCrash();

    rig.advance(TWO_HOURS_MS);

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

  test('a clean quit inside an install window arms nothing, with no death to date', () => {
    const rig = makeRig();
    wireRealUpdater(rig, committedInstall(rig.nowMs()));
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.markCleanQuit();

    rig.advance(TWO_HOURS_MS);

    // No sentinel means no previous session to anchor to. Reaching for an
    // anchor that is not there must stay a no-op rather than throwing or
    // arming on a session that quit properly.
    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
    expect(rig.emitted).toHaveLength(0);
  });

  test('a torn sentinel carries no death to anchor to, so a late reopen still prompts', () => {
    const rig = makeRig();
    wireRealUpdater(rig, committedInstall(rig.nowMs()));
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    writeFileSync(rig.deps.sentinelPath, 'torn-write-not-json');

    rig.advance(TWO_HOURS_MS);

    // Nothing in the file survived, so there is no lower bound on the death
    // and the detecting clock is the only instant there is. Falling back to it
    // is the fail-open-toward-prompting posture this module takes for any
    // probe it cannot reason from, rather than inventing an anchor.
    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

  test('a torn sentinel on a prompt reopen keeps the suppression it has today', () => {
    const rig = makeRig();
    wireRealUpdater(rig, committedInstall(rig.nowMs()));
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    writeFileSync(rig.deps.sentinelPath, 'torn-write-not-json');

    rig.advance(5 * 60_000);

    // The other half of the same fallback, and the half a fix that treated a
    // missing anchor as "assume no install" would silently regress: the
    // installer really did kill this session, and losing the sentinel to a
    // torn write is not evidence that it did not.
    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('a sentinel written before the liveness fields existed still suppresses a prompt reopen', () => {
    const rig = makeRig();
    const prevBootedAt = rig.nowMs();
    wireRealUpdater(rig, committedInstall(prevBootedAt));
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    // The shape an upgrade from a build predating the heartbeat field leaves
    // behind: readable, dated only by the instant the session started, and
    // carrying no version either, since that field is younger still. A reopen
    // this fast is inside the window under any lower bound at or after that
    // instant, so the suppression must not depend on `lastAliveAt` being
    // present.
    writeFileSync(
      rig.deps.sentinelPath,
      JSON.stringify({
        bootId: String(prevBootedAt),
        startedAt: new Date(prevBootedAt).toISOString(),
      }),
    );

    rig.advance(5 * 60_000);

    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('a handoff stamped after the previous session stopped heartbeating still suppresses', () => {
    const rig = makeRig();
    // The doomed session starts with nothing committed, so its sentinel is
    // dated by the heartbeat it last wrote rather than by any install record.
    createCrashDetection(rig.deps).detectBootCrash();
    const lastAliveMs = Date.parse(readSentinel(rig).lastAliveAt ?? '');

    // Setup shared with the late-reopen sibling below, which differs only in
    // how long the user stays away. This one reopens promptly, so it pins the
    // half of the class that worked before the span reduction and must not
    // regress.
    rig.advance(SENTINEL_HEARTBEAT_INTERVAL_MS - 15_000);
    const handoffAt = rig.nowMs();
    wireRealUpdater(rig, committedInstall(handoffAt));
    // Asserted rather than assumed: a rig whose two moments coincided would
    // suppress under every anchoring scheme and would therefore pin nothing.
    expect(handoffAt).toBeGreaterThan(lastAliveMs);

    rig.advance(5 * 60_000);

    // A question asked only at the last heartbeat reads this handoff as
    // sitting in the future, which the updater declines to reason from and
    // reports as no install at all. Anchoring there would arm a false prompt
    // on a prompt reopen, which is the half of the class that has always
    // worked. The death is an interval, and the install was in flight at its
    // far end.
    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('a sentinel dated only by when its session started collapses onto this boot', () => {
    const rig = makeRig();
    const prevBootedAt = rig.nowMs();
    // A commit made before the doomed session started, which is the shape an
    // install that never lands leaves behind: the record outlives the
    // relaunch, and the session that inherits it is the one the installer
    // kills on the next attempt.
    wireRealUpdater(rig, committedInstall(prevBootedAt - 5 * 60_000));
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    writeFileSync(
      rig.deps.sentinelPath,
      JSON.stringify({
        bootId: String(prevBootedAt),
        startedAt: new Date(prevBootedAt).toISOString(),
      }),
    );

    rig.advance(TWO_HOURS_MS);

    // A session cannot die before it started, so that stamp does bound the
    // death from below, and it is deliberately not used anyway. It dates the
    // boot, not the death, so a session the installer killed seconds in and
    // one that ran for hours before genuinely crashing arrive here as the same
    // input, and reading it would resolve that ambiguity toward silence for
    // both. The span collapses onto this boot instead and the prompt is owed.
    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

  test('an unreadable last-alive stamp reads as no heartbeat at all', () => {
    const rig = makeRig();
    const prevBootedAt = rig.nowMs();
    wireRealUpdater(rig, committedInstall(prevBootedAt - 5 * 60_000));
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    // The sentinel reader admits any non-empty string, so a field mangled by a
    // partial write, or written in some other build's format, arrives here as
    // text no date parser will take.
    writeFileSync(
      rig.deps.sentinelPath,
      JSON.stringify({
        bootId: String(prevBootedAt),
        startedAt: new Date(prevBootedAt).toISOString(),
        lastAliveAt: 'not-a-date',
        appVersion: CRASHED_VERSION,
      }),
    );

    rig.advance(TWO_HOURS_MS);

    // Present but unparseable has to land where absent lands, or the parse
    // failure quietly buys a suppression the same sentinel would not get if
    // the field had been left out entirely.
    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

  test('an unreadable last-alive stamp still renders a suppression breadcrumb', () => {
    const rig = makeRig();
    const prevBootedAt = rig.nowMs();
    // The two siblings above both park the handoff outside the grace, so the
    // verdict is null and the breadcrumb is never built. Putting it inside is
    // what carries an unparseable stamp all the way to the line that formats
    // the span, which is the only place a raw NaN would throw rather than
    // degrade. `detectBootCrash()` returning at all is half the assertion.
    wireRealUpdater(rig, committedInstall(prevBootedAt));
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    writeFileSync(
      rig.deps.sentinelPath,
      JSON.stringify({
        bootId: String(prevBootedAt),
        startedAt: new Date(prevBootedAt).toISOString(),
        lastAliveAt: 'not-a-date',
        appVersion: CRASHED_VERSION,
      }),
    );

    rig.advance(5 * 60_000);
    const lines = captureInfo(rig);
    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();

    const breadcrumb = suppressionBreadcrumb(lines);
    expect(breadcrumb.deathFromSource).toBe('detected-at');
    expect(breadcrumb.deathFrom).toBe(new Date(rig.nowMs()).toISOString());
  });

  test('an unreadable last-alive stamp does not clear the staleness bound', () => {
    const rig = makeRig();
    const prevBootedAt = rig.nowMs();
    // Handed off well outside the in-flight window before that session even
    // booted, so the correct verdict is that nothing was still running and the
    // prompt is owed.
    wireRealUpdater(rig, committedInstall(prevBootedAt - 45 * 60_000));
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    writeFileSync(
      rig.deps.sentinelPath,
      JSON.stringify({
        bootId: String(prevBootedAt),
        startedAt: new Date(prevBootedAt).toISOString(),
        lastAliveAt: 'not-a-date',
        appVersion: CRASHED_VERSION,
      }),
    );

    rig.advance(TWO_HOURS_MS);

    // Every comparison against a non-number is false, so an anchor that
    // reached the updater as one would pass the staleness bound by failing it
    // and suppress prompts this class was never meant to touch. The stale
    // handoff has to arrive at the window as a real number and lose.
    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

  test('a handoff stamped after the last heartbeat still suppresses a late reopen', () => {
    const rig = makeRig();
    // Setup identical to the prompt-reopen sibling above, up to the reopen
    // delay further down, which is the only thing that differs and is the whole
    // reduction: the window lands strictly inside the span rather than touching
    // either end.
    createCrashDetection(rig.deps).detectBootCrash();
    const lastAliveMs = Date.parse(readSentinel(rig).lastAliveAt ?? '');
    rig.advance(SENTINEL_HEARTBEAT_INTERVAL_MS - 15_000);
    const handoffAt = rig.nowMs();
    wireRealUpdater(rig, committedInstall(handoffAt));
    expect(handoffAt).toBeGreaterThan(lastAliveMs);

    // And then the user does not come back until the evening. The install
    // window opens after the last heartbeat and closes long before the reopen,
    // so it lies strictly inside the span between them and touches neither
    // end. Two questions asked at the ends of that span both come back empty
    // and arm a prompt for a session the installer ended on purpose.
    rig.advance(TWO_HOURS_MS);

    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('a commit no live process recorded still suppresses a prompt reopen', () => {
    const rig = makeRig();
    // The half of the stampless branch that must keep working. Nothing quit, so
    // the staging moment is the only date the updater has, and the question
    // falls back to the detecting instant. Inside the grace of that download the
    // answer is still a suppression, exactly as it was before the span reduction
    // existed. Without this the branch has no positive case anywhere, and a
    // refactor that bailed out early on a null stamp would leave every other
    // assertion in this file green.
    wireRealUpdater(rig, stagedButNeverCommitted(rig.nowMs()));
    createCrashDetection(rig.deps).detectBootCrash();

    rig.advance(5 * 60_000);

    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('a commit no live process recorded does not widen the span', () => {
    const rig = makeRig();
    // Nothing ever quit, so no handoff was stamped and the staging moment is
    // the only date the updater has. That moment records a download finishing,
    // not a process committing to run an installer, so widening the span for
    // it would read every dirty shutdown inside the grace of a completed
    // download as an install kill. The span reasoning stops at the stamped
    // shape and this path answers exactly as it did before.
    wireRealUpdater(rig, stagedButNeverCommitted(rig.nowMs()));
    createCrashDetection(rig.deps).detectBootCrash();

    rig.advance(TWO_HOURS_MS);

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

  test('a staged install whose window closed before the death still prompts', () => {
    const rig = makeRig();
    // Same shape, staged well outside the window before the doomed session was
    // last alive. The staging fallback is a loose lower bound on the commit,
    // not a licence to suppress every death that follows a download.
    wireRealUpdater(rig, stagedButNeverCommitted(rig.nowMs() - 45 * 60_000));
    createCrashDetection(rig.deps).detectBootCrash();

    rig.advance(TWO_HOURS_MS);

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

  /**
   * Swap in a payload-capturing logger, as the breadcrumb test in the block
   * above does. The tier label is a second expression of the same fallback
   * ladder that produced the bound, so the two can disagree with every verdict
   * still correct, and a responder who trusts a label naming the wrong tier
   * chases a widened span that never happened.
   */
  function captureInfo(rig: Rig): Array<Record<string, unknown>> {
    const lines: Array<Record<string, unknown>> = [];
    rig.deps.logger = {
      info: (payload: Record<string, unknown>) => {
        lines.push(payload);
      },
      warn: (payload: Record<string, unknown>) => {
        rig.warnings.push(payload);
      },
    };
    return lines;
  }

  function suppressionBreadcrumb(lines: Array<Record<string, unknown>>) {
    const line = lines.find((l) => l.event === 'crash-detection.machine-level-death');
    expect(line).toBeDefined();
    return line as Record<string, unknown>;
  }

  test('a suppression names the handoff it accepted and the tier that dated the span', () => {
    const rig = makeRig();
    const handoffAt = rig.nowMs();
    wireRealUpdater(rig, committedInstall(handoffAt));
    createCrashDetection(rig.deps).detectBootCrash();
    const lastAliveMs = Date.parse(readSentinel(rig).lastAliveAt ?? '');

    rig.advance(TWO_HOURS_MS);
    const lines = captureInfo(rig);
    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();

    const breadcrumb = suppressionBreadcrumb(lines);
    // ISO rather than epoch ms, so a responder can read it against deathFrom on
    // the same line without converting one of the two by hand, and under its
    // own key so the updater's epoch-ms `handoffAt` keeps one datatype.
    expect(breadcrumb.handoffAtIso).toBe(new Date(handoffAt).toISOString());
    expect(breadcrumb.deathFromSource).toBe('last-alive');
    expect(breadcrumb.deathFrom).toBe(new Date(lastAliveMs).toISOString());
    // The width the question was actually asked over. A non-zero value here is
    // what marks a suppression whose span widened, which is the only shape the
    // handoff-against-deathFrom read above is valid on.
    expect(breadcrumb.deathSpanMs).toBe(rig.nowMs() - lastAliveMs);
  });

  test('a heartbeat postdating this boot collapses the span without inverting it', () => {
    const rig = makeRig();
    const handoffAt = rig.nowMs();
    wireRealUpdater(rig, committedInstall(handoffAt));
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    // A clock correction across the quit leaves a heartbeat dated after the
    // boot that reads it. The span has no width to report there, so zero is
    // the true answer rather than a negative one, and a triage rule keyed on a
    // non-zero width has to exclude this line rather than count it.
    const impossibleLastAlive = rig.nowMs() + 3 * 60 * 60 * 1000;
    writeFileSync(
      rig.deps.sentinelPath,
      JSON.stringify({
        bootId: String(rig.nowMs()),
        startedAt: new Date(rig.nowMs()).toISOString(),
        lastAliveAt: new Date(impossibleLastAlive).toISOString(),
        appVersion: CRASHED_VERSION,
      }),
    );

    rig.advance(5 * 60_000);
    const lines = captureInfo(rig);
    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();

    const breadcrumb = suppressionBreadcrumb(lines);
    expect(breadcrumb.deathSpanMs).toBe(0);
    // The inversion itself stays legible: both unclamped moments are on the
    // line, so a reader can still see that the floor postdates the detection.
    expect(breadcrumb.deathFrom).toBe(new Date(impossibleLastAlive).toISOString());
    expect(Date.parse(breadcrumb.detectedAt as string)).toBeLessThan(impossibleLastAlive);
    expect(breadcrumb.deathFromSource).toBe('last-alive');
  });

  test('a fresh dump inside an install window prompts and names the attempt', () => {
    const rig = makeRig();
    wireRealUpdater(rig, committedInstall(rig.nowMs()));
    createCrashDetection(rig.deps).detectBootCrash();

    rig.advance(5 * 60_000);
    seedMinidump(rig, 'faulted.dmp', new Date(rig.nowMs()));
    const lines = captureInfo(rig);

    // The installer ended the session AND the app faulted on its own, so the
    // dump decides: this prompts as the dump-driven variant rather than being
    // suppressed. It is also the only route by which the boot line carries a
    // non-null attempt, which is what makes the key readable as evidence there
    // rather than only as an era marker.
    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(false);
    const boot = lines.find((l) => l.event === 'crash-detection.boot');
    expect(boot?.attemptedInstall).toBe(ATTEMPTED);
  });

  test('a torn sentinel says the span collapsed onto this boot, and warns', () => {
    const rig = makeRig();
    wireRealUpdater(rig, committedInstall(rig.nowMs()));
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    writeFileSync(rig.deps.sentinelPath, 'torn-write-not-json');

    rig.advance(5 * 60_000);
    const lines = captureInfo(rig);
    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();

    // A file that parsed and carried no dates reaches the breadcrumb as the
    // same nulls, so without the warn a degraded read is indistinguishable
    // from a clean one that simply had nothing to say.
    expect(suppressionBreadcrumb(lines).deathFromSource).toBe('detected-at');
    expect(rig.warnings.map((w) => w.event)).toContain('crash-detection.sentinel-parse-failed');
  });

  test('a sentinel that exists but cannot be read warns rather than passing as absent', () => {
    const rig = makeRig();
    // A directory where the file should be stands in for the class the field
    // actually produces: an antivirus or indexer lock, a permission the app
    // lost. The read throws with something other than ENOENT, so the previous
    // session still did not clean-quit, but every dated field is gone and the
    // span collapses. That reaches the breadcrumb identically to a build from
    // before those fields existed, and the two call for opposite responses,
    // so the errno is the only thing that separates them.
    mkdirSync(rig.deps.sentinelPath, { recursive: true });

    const armed = createCrashDetection(rig.deps).detectBootCrash();

    const warn = rig.warnings.find((w) => w.event === 'crash-detection.sentinel-read-failed');
    expect(warn).toBeDefined();
    // The errno is the whole point of the line, so assert it arrives rather
    // than trusting the payload shape. Presence first: an optional chain into a
    // negative matcher passes on `undefined`, which would let a payload that
    // dropped `err` keep this green.
    const errno = (warn?.err as NodeJS.ErrnoException | undefined)?.code;
    expect(errno).toBeDefined();
    // Asserted as "not the missing-file code" rather than as the exact one,
    // because EISDIR is this rig's way of provoking the class and the field
    // produces others.
    expect(errno).not.toBe('ENOENT');
    // The other half of the same catch: a file that exists but cannot be read
    // is still a session that did not clean-quit, so the prompt is owed.
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

  test('the heartbeat outranks the start of the session when the two straddle the grace', () => {
    const rig = makeRig();
    const prevBootedAt = rig.nowMs();
    // Handed off a minute before the doomed session even started, so the
    // window had closed many hours before that session actually died.
    wireRealUpdater(rig, committedInstall(prevBootedAt - 60_000));
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    const diedAt = prevBootedAt + 8 * 60 * 60 * 1000;
    writeFileSync(
      rig.deps.sentinelPath,
      JSON.stringify({
        bootId: String(prevBootedAt),
        startedAt: new Date(prevBootedAt).toISOString(),
        lastAliveAt: new Date(diedAt).toISOString(),
        appVersion: CRASHED_VERSION,
      }),
    );

    rig.advance(9 * 60 * 60 * 1000);

    // Both dates are sound lower bounds on the death and they disagree by a
    // whole session, which is why the order they are tried in is a decision
    // rather than a detail. Reaching past the heartbeat to the earlier one
    // would carry this handoff back inside the window and silence a genuine
    // crash eight hours into a session.
    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });
});

/**
 * Deaths the app deliberately declined to prompt for.
 *
 * A recoverable GPU death is swallowed on purpose — the process relaunches in
 * about a second and the user sees nothing worth describing. The dump it wrote
 * outlives the session anyway, and the next boot's scan has no way to tell it
 * from the dump of a crash nobody was ever told about, so before this the app
 * spent one session hiding a blip and the next one asking about it.
 *
 * The two-session shape is the rest of this file's. The cases are each other's
 * controls: the same bytes, moved in time or given a different process type,
 * must still reach the user.
 */
describe('dumps of deaths the app declined to prompt for', () => {
  test('a swallowed GPU death does not come back as a boot prompt', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    expect(sessionA.detectBootCrash()).toBeNull();

    sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    expect(rig.emitted).toHaveLength(0);
    seedMinidump(
      rig,
      'completed/gpu.dmp',
      new Date(rig.nowMs()),
      rig.ownDumpWithProcessType('gpu-process'),
    );
    sessionA.markCleanQuit();

    const sessionB = createCrashDetection(rig.deps);
    expect(sessionB.detectBootCrash()).toBeNull();
    sessionB.notifyRendererReady();
    expect(rig.emitted).toHaveLength(0);
    sessionB.markCleanQuit();

    // And the boot after that, and every one after it. Nothing moves the scan
    // floor without a prompt to answer, so the dump stays visible forever — a
    // record that stopped applying once its dump had been seen would hand the
    // user the same bogus prompt one launch later, intermittently, which is
    // harder to report than never having suppressed it at all.
    const sessionC = createCrashDetection(rig.deps);
    expect(sessionC.detectBootCrash()).toBeNull();
    sessionC.notifyRendererReady();
    expect(rig.emitted).toHaveLength(0);
  });

  test('the same dump still prompts when no death was declined', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    expect(sessionA.detectBootCrash()).toBeNull();
    seedMinidump(
      rig,
      'completed/gpu.dmp',
      new Date(rig.nowMs()),
      rig.ownDumpWithProcessType('gpu-process'),
    );
    sessionA.markCleanQuit();

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(false);
  });

  test('a renderer dump beside a declined GPU death is a different crash and still prompts', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    expect(sessionA.detectBootCrash()).toBeNull();

    sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    // The renderer commonly dies moments after the GPU process does, and that
    // death is the one the user felt. Landing inside the declined death's
    // window must not retire it.
    seedMinidump(
      rig,
      'completed/renderer.dmp',
      new Date(rig.nowMs()),
      rig.ownDumpWithProcessType('renderer'),
    );
    sessionA.markCleanQuit();

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(false);
  });

  test('a GPU dump written long after the declined death is a separate incident', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    expect(sessionA.detectBootCrash()).toBeNull();

    sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    rig.advance(4 * 60_000);
    seedMinidump(
      rig,
      'completed/gpu-later.dmp',
      new Date(rig.nowMs()),
      rig.ownDumpWithProcessType('gpu-process'),
    );
    sessionA.markCleanQuit();

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(false);
  });

  test('a dump that names no process type still prompts, because the main process names none', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    expect(sessionA.detectBootCrash()).toBeNull();

    sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    // The browser process is launched without a `--type=` switch and so records
    // no process type at all. Reading that silence as consent would retire the
    // dump of a native main-process crash that happened to land beside a GPU
    // blip, which is the crash this whole scan exists to catch.
    seedMinidump(rig, 'completed/unannotated.dmp', new Date(rig.nowMs()));
    sessionA.markCleanQuit();

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(false);
  });

  test('a retired dump is still offered to a report the user opens themselves', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    expect(sessionA.detectBootCrash()).toBeNull();

    sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    seedMinidump(
      rig,
      'completed/gpu.dmp',
      new Date(rig.nowMs()),
      rig.ownDumpWithProcessType('gpu-process'),
    );
    sessionA.markCleanQuit();

    // Retirement decides what the app ASKS about, never what it can attach.
    // The report path and the boot dialog's attach question have to answer
    // "is there a dump" the same way, or the checkbox goes missing while the
    // file sits right there on disk.
    const sessionB = createCrashDetection(rig.deps);
    expect(sessionB.detectBootCrash()).toBeNull();
    expect(sessionB.newestMinidumpForReport().path).not.toBeNull();
  });

  test('a boot that arms for another reason still offers the retired dump', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    expect(sessionA.detectBootCrash()).toBeNull();

    sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    seedMinidump(
      rig,
      'completed/gpu.dmp',
      new Date(rig.nowMs()),
      rig.ownDumpWithProcessType('gpu-process'),
    );
    // No clean quit: the session died, and the sentinel arms this boot on its
    // own. The GPU blip is not what is being asked about, but it is still the
    // newest dump on disk, so the dialog's attach question and the report path
    // have to agree that a dump exists.
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());
    expect(armed.context.dirtyShutdown).toBe(true);
    expect(armed.context.newMinidumps).toBe(0);
    expect(armed.minidumpAvailable).toBe(true);
  });

  test('a threshold death that lost the invite slot still prompts at the next boot', () => {
    const rig = makeRig();
    const session = createCrashDetection(rig.deps);
    expect(session.detectBootCrash()).toBeNull();
    // Nothing can take the prompt, so the first invitation stays pending and
    // holds the single slot against everything that follows.
    rig.setRendererAvailable(false);

    session.handleChildProcessGone({ type: 'utility', reason: 'crashed' });
    session.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    session.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    session.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    // The third GPU death crossed the threshold, so it is written no record of
    // its own — and it lost the slot, so it was never raised either. Its dump
    // is the only thing still carrying it, and that dump lands inside the
    // window of the two declines before it. Those records have to be gone by
    // now, or they retire the one GPU failure the threshold exists to
    // escalate. Forgetting them instead costs a prompt the user dismisses.
    seedMinidump(
      rig,
      'completed/gpu-third.dmp',
      new Date(rig.nowMs()),
      rig.ownDumpWithProcessType('gpu-process'),
    );
    session.markCleanQuit();

    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());
    expect(armed.context.newMinidumps).toBe(1);
  });

  test('the version comes from the arming dump, not from a newer retired one', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    expect(sessionA.detectBootCrash()).toBeNull();

    // The crash the user felt, stamped with the version that died.
    const armingAt = new Date(rig.nowMs());
    seedMinidump(rig, 'completed/renderer.dmp', armingAt, rig.ownDumpStamped(CRASHED_VERSION));
    // Then a GPU blip the app swallows, whose dump is NEWER. Selecting the
    // event's dump by ownership alone would take this one and stamp the report
    // with a different death's version.
    rig.advance(1_000);
    sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    // Stamped with a version the arming dump does not carry, so taking the
    // wrong dump shows up as the wrong answer rather than the same one twice.
    seedMinidump(
      rig,
      'completed/gpu.dmp',
      new Date(rig.nowMs()),
      rig.ownDumpWithProcessType('gpu-process', BLIP_VERSION),
    );
    sessionA.markCleanQuit();

    rig.setAppVersion(DETECTING_VERSION);
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());
    expect(armed.context.newMinidumps).toBe(1);
    expect(armed.eventId).toBe(`boot:dump:${armingAt.getTime()}`);
    expect(armed.crashedAppVersion).toBe(CRASHED_VERSION);
  });

  test('a record outlives the boot that used it, because its dump does too', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    expect(sessionA.detectBootCrash()).toBeNull();

    sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    seedMinidump(
      rig,
      'completed/gpu.dmp',
      new Date(rig.nowMs()),
      rig.ownDumpWithProcessType('gpu-process'),
    );
    sessionA.markCleanQuit();

    // Pairing a record with its dump does not finish the record's job. The
    // dump is still on disk and still above the scan floor, so only an
    // acknowledgment — which never comes on a path where nothing is ever
    // raised — retires the two of them together.
    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
    const stored = JSON.parse(readFileSync(rig.deps.ackStorePath, 'utf8')) as {
      declinedDeaths: { processType: string }[];
    };
    expect(stored.declinedDeaths).toHaveLength(1);
  });

  test('the record list is capped, dropping the oldest first', () => {
    const rig = makeRig();
    const session = createCrashDetection(rig.deps);
    expect(session.detectBootCrash()).toBeNull();

    // Spaced beyond the relatedness window so every death counts as isolated
    // and is declined — the path on which nothing ever drains the list. The
    // first one's moment is read back while it is the only record, so it names
    // the oldest entry whichever end eviction later comes off.
    rig.advance(6 * 60_000);
    session.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    const afterFirst = JSON.parse(readFileSync(rig.deps.ackStorePath, 'utf8')) as {
      declinedDeaths: { at: string }[];
    };
    expect(afterFirst.declinedDeaths).toHaveLength(1);
    const oldestAt = afterFirst.declinedDeaths[0]?.at ?? '';

    for (let i = 0; i < 24; i++) {
      rig.advance(6 * 60_000);
      session.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    }

    const stored = JSON.parse(readFileSync(rig.deps.ackStorePath, 'utf8')) as {
      declinedDeaths: { at: string }[];
    };
    expect(stored.declinedDeaths).toHaveLength(20);
    // The newest records are the ones whose dumps are most likely still to be
    // asked about, so eviction has to come off the front.
    expect(stored.declinedDeaths.map((d) => d.at)).not.toContain(oldestAt);

    // And the eviction has to mean something. A dump belonging to the record
    // that fell off the front prompts again; one belonging to the newest
    // surviving record is still retired, so exactly one of the two arms.
    const evictedAt = new Date(Date.parse(oldestAt));
    seedMinidump(
      rig,
      'completed/evicted.dmp',
      evictedAt,
      rig.ownDumpWithProcessType('gpu-process'),
    );
    const survivingAt = new Date(Date.parse(stored.declinedDeaths.at(-1)?.at ?? ''));
    seedMinidump(
      rig,
      'completed/surviving.dmp',
      survivingAt,
      rig.ownDumpWithProcessType('gpu-process'),
    );
    session.markCleanQuit();

    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());
    expect(armed.context.newMinidumps).toBe(1);
    expect(armed.eventId).toBe(`boot:dump:${evictedAt.getTime()}`);
  });

  test('acking drops the records the new baseline has already made moot', () => {
    const rig = makeRig();
    const session = createCrashDetection(rig.deps);
    expect(session.detectBootCrash()).toBeNull();

    session.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    const staleAt = new Date(rig.nowMs()).toISOString();
    rig.advance(10 * 60_000);
    session.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    const recentAt = new Date(rig.nowMs()).toISOString();
    session.ack('crash:child:whatever');

    // The baseline now sits at the ack. Dumps at or before it are filtered out
    // of the next scan anyway, so a record older than the match window can
    // never pair with anything again — while the one the baseline has only
    // just passed still can.
    const stored = JSON.parse(readFileSync(rig.deps.ackStorePath, 'utf8')) as {
      declinedDeaths: { at: string }[];
    };
    expect(stored.declinedDeaths.map((d) => d.at)).toEqual([recentAt]);
    expect(stored.declinedDeaths.map((d) => d.at)).not.toContain(staleAt);
  });

  test('a GPU that crossed the invite threshold is still reported after an unanswered prompt', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    expect(sessionA.detectBootCrash()).toBeNull();

    sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    // The third death is the one that finally invites. Its dump lands inside
    // the window of the two that were declined, so the records those left
    // must not survive to retire it: the user was told about this crash and
    // never answered, and the next boot is the only place left to re-raise it.
    expect(rig.emitted).toHaveLength(1);
    seedMinidump(
      rig,
      'completed/gpu-third.dmp',
      new Date(rig.nowMs()),
      rig.ownDumpWithProcessType('gpu-process'),
    );
    sessionA.markCleanQuit();

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(false);
  });

  test('an ack store written before this field reads as no declined deaths, not as corruption', () => {
    const rig = makeRig();
    const baselineAt = new Date(rig.nowMs()).toISOString();
    mkdirSync(dirname(rig.deps.ackStorePath), { recursive: true });
    writeFileSync(
      rig.deps.ackStorePath,
      `${JSON.stringify({ ackedEventIds: [], minidumpBaselineAt: baselineAt })}\n`,
    );
    rig.advance(60_000);
    seedMinidump(rig, 'completed/fresh.dmp', new Date(rig.nowMs()));

    const detection = createCrashDetection(rig.deps);
    // Rejecting the store would re-baseline to now and swallow this dump, so
    // the prompt is what proves the older shape was accepted rather than
    // repaired.
    expect(bootInvite(detection.detectBootCrash()).context.dirtyShutdown).toBe(false);
    detection.ack('boot:some-event');
    expect(JSON.parse(readFileSync(rig.deps.ackStorePath, 'utf8')) as unknown).toMatchObject({
      declinedDeaths: [],
    });
  });
});
