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
import { afterEach, describe, expect, test, vi } from 'vitest';
import { installWasInFlightDuring } from './auto-updater.ts';
import {
  type CrashDetectionDeps,
  createCrashDetection,
  GPU_CRASH_INVITE_THRESHOLD,
  GPU_CRASH_WINDOW_MS,
  type InstallInFlight,
  MAX_DECLINED_DEATHS,
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

const FOREIGN_DUMP = buildMinidump([
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/lib/dyld',
]);

const UNPARSEABLE_DUMP = Buffer.from('minidump-bytes-that-are-not-a-minidump');

const CRASHED_VERSION = '0.41.0';
const DETECTING_VERSION = '0.46.1';
const BLIP_VERSION = '0.44.2';

interface Rig {
  deps: CrashDetectionDeps;
  emitted: OkBugReportCrashDetectedEvent[];
  warnings: Record<string, unknown>[];
  infos: Record<string, unknown>[];
  ownDump: Buffer;
  ownDumpStamped(version: string): Buffer;
  ownDumpWithAxMode(version: string, mode: string): Buffer;
  ownDumpWithProcessType(processType: string, version?: string): Buffer;
  ownDumpSimulated: Buffer;
  setRendererAvailable(available: boolean): void;
  setBootSessionUuid(uuid: string | null): void;
  setInstallInFlight(inFlight: InstallInFlight | null): void;
  setAppVersion(version: string): void;
  tick(): Date;
  advance(ms: number): void;
  nowMs(): number;
  dir: string;
}

function makeRig(): Rig {
  const dir = mkdtempSync(resolve(tmpdir(), 'ok-crash-detection-'));
  tmpDirs.push(dir);
  const emitted: OkBugReportCrashDetectedEvent[] = [];
  const warnings: Record<string, unknown>[] = [];
  const infos: Record<string, unknown>[] = [];
  let rendererAvailable = true;
  let bootSessionUuid: string | null = 'boot-epoch-a';
  let installInFlight: InstallInFlight | null = null;
  let clockMs = Date.parse('2026-07-10T00:00:00.000Z');
  const appBundleRoot = join(dir, 'Applications', 'OpenKnowledge.app');
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
    infos,
    ownDump: buildMinidump(ownModules),
    ownDumpSimulated: buildMinidump(ownModules, { exceptionCode: 0x4350_7378 }),
    ownDumpStamped: (version: string) =>
      buildMinidump(ownModules, {
        annotations: { _productName: 'OpenKnowledge', _version: version, prod: 'Electron' },
      }),
    ownDumpWithAxMode: (version: string, mode: string) =>
      buildMinidump(ownModules, {
        annotations: { _productName: 'OpenKnowledge', _version: version, prod: 'Electron' },
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
        info: (payload) => {
          infos.push(payload);
        },
        warn: (payload) => {
          warnings.push(payload);
        },
      },
    },
  };
  return rig;
}

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

    rig.advance(60 * 60_000);
    detection.handleRenderProcessGone({ reason: 'crashed' });

    expect(rig.emitted).toHaveLength(2);
    expect(rig.emitted[1]?.eventId).not.toBe(first.eventId);
  });

  test('a crash inside the relatedness window still dedupes against the pending invitation', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);

    detection.handleRenderProcessGone({ reason: 'crashed' });
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

describe('recoverable GPU crashes', () => {
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

    const sessionB = createCrashDetection(rig.deps);
    const armed = sessionB.detectBootCrash();
    expect(armed?.kind).toBe('boot');
    if (armed?.kind === 'boot') {
      expect(armed.context.dirtyShutdown).toBe(true);
      expect(armed.context.newMinidumps).toBe(0);
      expect(armed.minidumpAvailable).toBe(false);
    }

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

    const sessionB = createCrashDetection(rig.deps);
    const first = sessionB.detectBootCrash();
    if (!first) throw new Error('expected a boot invitation after the dirty shutdown');
    sessionB.ack(first.eventId);
    expect(readFileSync(rig.deps.ackStorePath, 'utf8')).toContain(first.eventId);
    sessionB.markCleanQuit();

    const sessionC = createCrashDetection(rig.deps);
    expect(sessionC.detectBootCrash()).toBeNull();

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

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(armed?.kind).toBe('boot');
    if (armed?.kind === 'boot') {
      expect(armed.context.dirtyShutdown).toBe(true);
    }
  });

  test('a dirty shutdown across a kernel reboot never prompts', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();

    rig.setBootSessionUuid('boot-epoch-b');
    const sessionB = createCrashDetection(rig.deps);
    expect(sessionB.detectBootCrash()).toBeNull();
    sessionB.notifyRendererReady();
    expect(rig.emitted).toHaveLength(0);

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

    rig.setBootSessionUuid('boot-epoch-b');
    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(armed?.kind).toBe('boot');
    expect(armed?.eventId.slice(0, 'boot:dump:'.length)).toBe('boot:dump:');
    if (armed?.kind === 'boot') {
      expect(armed.context.dirtyShutdown).toBe(false);
      expect(armed.context.newMinidumps).toBe(1);
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
    sessionA.noteOsShutdown();
    expect(readSentinel(rig).osShutdownReasons).toBeUndefined();

    createCrashDetection(rig.deps).detectBootCrash();

    const breadcrumb = warnLines.find(
      (line) => line.event === 'crash-detection.machine-level-death',
    );
    expect(breadcrumb?.reason).toBe('os-shutdown');
    expect(breadcrumb?.osShutdownReasons).toBeNull();
  });

  test('a non-array from the native boundary still records the marker', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();

    expect(() => sessionA.noteOsShutdown(null as unknown as readonly string[])).not.toThrow();

    expect(readSentinel(rig).pendingOsShutdownAt).toBeTruthy();
    expect(readSentinel(rig).osShutdownReasons).toBeUndefined();

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(armed).toBeNull();
  });

  test('junk elements are filtered on the way IN, not just on the way out', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();

    sessionA.noteOsShutdown(['shutdown', '', 42, 'logoff'] as unknown as readonly string[]);

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

    for (let i = 0; i < 15; i++) sessionA.noteAlive();

    expect(readSentinel(rig).pendingOsShutdownAt).toBeUndefined();
    expect(readSentinel(rig).osShutdownReasons).toBeUndefined();
  });

  test('a cancelled OS shutdown stops suppressing once heartbeats outlive the marker', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.noteOsShutdown();
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
    const rig = makeRig();
    rig.setBootSessionUuid(null);
    createCrashDetection(rig.deps).detectBootCrash();
    rig.setBootSessionUuid('boot-epoch-b');
    expect(createCrashDetection(rig.deps).detectBootCrash()?.kind).toBe('boot');

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

describe('crash-dump ownership filtering', () => {
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

    expect(armed?.kind).toBe('boot');
    if (armed?.kind === 'boot') {
      expect(armed.context.newMinidumps).toBe(1);
      expect(armed.minidumpAvailable).toBe(false);
    }
    expect(session.newestMinidumpForReport().path).toBeNull();
  });

  test('a foreign dump does not override machine-level-death suppression', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    seedMinidump(rig, 'pending/soffice.dmp', rig.tick(), FOREIGN_DUMP);

    rig.setBootSessionUuid('boot-epoch-b');
    const session = createCrashDetection(rig.deps);

    expect(session.detectBootCrash()).toBeNull();
  });

  test('a dirty shutdown still prompts when the only fresh dump is foreign', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
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
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    seedMinidump(rig, 'completed/soffice.dmp', rig.tick(), FOREIGN_DUMP);
    seedMinidump(rig, 'completed/torn.dmp', rig.tick(), UNPARSEABLE_DUMP);
    const ownPath = seedMinidump(rig, 'completed/ours.dmp', rig.tick());

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

    expect(detection.newestMinidumpForReport()).toEqual({
      path: ownPath,
      foreignSkipped: 1,
      unknownSkipped: 0,
    });
  });

  test('a runtime crash says how many foreign dumps it walked past', () => {
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

    const breadcrumb = infoLines.find(
      (line) => line.event === 'crash-detection.foreign-dumps-ignored',
    );
    expect(breadcrumb?.count).toBe(1);
  });
});

describe('process-level invariants', () => {
  test('crash detection registers no userland uncaughtException handler', () => {
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

describe('the version a boot invitation attributes the crash to', () => {
  test('a dirty shutdown names the crashed version, not the detecting one', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();

    rig.setAppVersion(DETECTING_VERSION);
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.context.dirtyShutdown).toBe(true);
    expect(armed.crashedAppVersion).toBe(CRASHED_VERSION);
  });

  test('a dirty shutdown keeps its sentinel as witness even with a dump of its own', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    const bootId = readSentinel(rig).bootId;
    seedMinidump(rig, 'pending/native.dmp', rig.tick(), rig.ownDumpStamped('0.41.0-beta.4'));

    rig.setAppVersion(DETECTING_VERSION);
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.context.dirtyShutdown).toBe(true);
    expect(armed.eventId).toBe(`boot:${bootId}`);
    expect(armed.crashedAppVersion).toBe(CRASHED_VERSION);
  });

  test('a dump-driven event reads the version stamped inside the dump', () => {
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

    expect(armed.eventId).toBe(`boot:dump:${ourCrashAt.getTime()}`);
    expect(armed.crashedAppVersion).toBe(CRASHED_VERSION);
  });

  test('an unreadable dump ahead of an owned one leaves the version unknown', () => {
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
    expect(armed.minidumpAvailable).toBe(true);
  });

  test('an unchanged version is still reported, so agreement is legible', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());

    expect(armed.crashedAppVersion).toBe(CRASHED_VERSION);
    expect(rig.deps.appVersion).toBe(CRASHED_VERSION);
  });

  test('a sentinel written before the field existed still prompts, with no version', () => {
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
    expect(breadcrumb?.crashedAppVersion).toBe(CRASHED_VERSION);
  });

  test('a sentinel-driven boot with no dump omits the accessibility fields entirely', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();

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

describe('when a boot invitation says the dead session stopped', () => {
  test('the boot breadcrumb dates the dead session to its last heartbeat', () => {
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
    expect(breadcrumb).toHaveProperty('attemptedInstall');
    expect(breadcrumb?.attemptedInstall).toBeNull();
  });

  test('a sentinel written before the liveness fields existed logs them as null', () => {
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

    expect(armed.eventId).toMatch(/^boot:dump:/);
    expect(armed.context.dirtyShutdown).toBe(false);

    const breadcrumb = infoLines.find((line) => line.event === 'crash-detection.boot');
    expect(breadcrumb?.suspendedAt).toBe(suspendedAt);
    expect(breadcrumb?.lastAliveAt).toBe(lastAliveAt);
    expect(breadcrumb?.pendingOsShutdownAt).toBeNull();
  });

  test('a dump-driven arming after an announced OS shutdown carries that marker', () => {
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

describe('non-crash minidumps', () => {
  function afterCleanQuit(rig: Rig): void {
    const sessionA = createCrashDetection(rig.deps);
    sessionA.detectBootCrash();
    sessionA.markCleanQuit();
  }

  test('a clean quit whose only fresh dump is a snapshot arms nothing', () => {
    const rig = makeRig();
    afterCleanQuit(rig);
    seedMinidump(rig, 'pending/watchdog.dmp', rig.tick(), rig.ownDumpSimulated);

    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('a real crash still arms even when a snapshot sits alongside it', () => {
    const rig = makeRig();
    afterCleanQuit(rig);
    const crashedAt = rig.tick();
    seedMinidump(rig, 'pending/real.dmp', crashedAt);
    seedMinidump(rig, 'pending/watchdog.dmp', rig.tick(), rig.ownDumpSimulated);

    expect(bootInvite(createCrashDetection(rig.deps).detectBootCrash()).eventId).toBe(
      `boot:dump:${crashedAt.getTime()}`,
    );
  });

  test('an unreadable dump still arms — indeterminate is not a non-crash', () => {
    const rig = makeRig();
    afterCleanQuit(rig);
    seedMinidump(rig, 'pending/torn.dmp', rig.tick(), UNPARSEABLE_DUMP);

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

    expect(createCrashDetection(rig.deps).detectBootCrash()).not.toBeNull();
  });

  test('a snapshot alone offers no dump to attach', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    seedMinidump(rig, 'pending/watchdog.dmp', rig.tick(), rig.ownDumpSimulated);

    detection.handleRenderProcessGone({ reason: 'crashed', exitCode: 5 });

    expect(rig.emitted.at(-1)?.minidumpAvailable).toBe(false);
    expect(detection.newestMinidumpForReport().path).toBeNull();
  });

  test('a newer snapshot does not shadow the real crash dump being reported', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    const realPath = seedMinidump(rig, 'pending/real.dmp', rig.tick());
    seedMinidump(rig, 'pending/watchdog.dmp', rig.tick(), rig.ownDumpSimulated);

    expect(detection.newestMinidumpForReport().path).toBe(realPath);
  });

  test('skipped snapshots are counted apart from foreign and unreadable ones', () => {
    const rig = makeRig();
    const detection = createCrashDetection(rig.deps);
    seedMinidump(rig, 'pending/watchdog.dmp', rig.tick(), rig.ownDumpSimulated);

    detection.handleRenderProcessGone({ reason: 'crashed', exitCode: 5 });

    const logged = rig.warnings.at(-1);
    expect(logged?.nonCrashDumpsSkipped).toBe(1);
    expect(logged?.foreignDumpsIgnored).toBe(0);
    expect(logged?.unreadableDumpsSkipped).toBe(0);
  });
});

describe('auto-update install kill suppression', () => {
  const IN_FLIGHT: InstallInFlight = {
    attemptedVersion: '0.61.3',
    handoffAt: Date.parse('2026-08-23T23:10:28.727Z'),
    recordedHandoff: true,
  };

  test('a session the installer killed never prompts', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
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
    expect(breadcrumb?.attemptedInstall).toBe('0.61.3');
    expect(breadcrumb?.recordedHandoff).toBe(true);
    expect(breadcrumb?.handoffAtIso).toBe('2026-08-23T23:10:28.727Z');
  });

  test('a fresh minidump still prompts through an install kill', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    seedMinidump(rig, 'pending/native-crash.dmp', rig.tick());
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
    rig.setInstallInFlight({ ...IN_FLIGHT, recordedHandoff: false });

    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('an absent reader leaves every existing verdict unchanged', () => {
    const rig = makeRig();
    rig.deps.installInFlight = undefined;
    createCrashDetection(rig.deps).detectBootCrash();

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(armed?.kind).toBe('boot');
  });
});

describe('the instant the install-kill question is asked in', () => {
  const ATTEMPTED = '0.61.3';
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

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
    rig.deps.installInFlight = (span) =>
      installWasInFlightDuring(state, span, state.versionPendingInstallStagedAt);
  }

  test('an install in flight when the previous session died stays suppressed however late the reopen', () => {
    const rig = makeRig();
    wireRealUpdater(rig, committedInstall(rig.nowMs()));
    createCrashDetection(rig.deps).detectBootCrash();

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

    rig.advance(5 * 60_000);

    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('a dirty shutdown with nothing committed still prompts however late the reopen', () => {
    const rig = makeRig();
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

    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
    expect(rig.emitted).toHaveLength(0);
  });

  test('a torn sentinel carries no death to anchor to, so a late reopen still prompts', () => {
    const rig = makeRig();
    wireRealUpdater(rig, committedInstall(rig.nowMs()));
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    writeFileSync(rig.deps.sentinelPath, 'torn-write-not-json');

    rig.advance(TWO_HOURS_MS);

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

  test('a torn sentinel on a prompt reopen keeps the suppression it has today', () => {
    const rig = makeRig();
    wireRealUpdater(rig, committedInstall(rig.nowMs()));
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
    writeFileSync(rig.deps.sentinelPath, 'torn-write-not-json');

    rig.advance(5 * 60_000);

    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('a sentinel written before the liveness fields existed still suppresses a prompt reopen', () => {
    const rig = makeRig();
    const prevBootedAt = rig.nowMs();
    wireRealUpdater(rig, committedInstall(prevBootedAt));
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
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
    createCrashDetection(rig.deps).detectBootCrash();
    const lastAliveMs = Date.parse(readSentinel(rig).lastAliveAt ?? '');

    rig.advance(SENTINEL_HEARTBEAT_INTERVAL_MS - 15_000);
    const handoffAt = rig.nowMs();
    wireRealUpdater(rig, committedInstall(handoffAt));
    expect(handoffAt).toBeGreaterThan(lastAliveMs);

    rig.advance(5 * 60_000);

    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('a sentinel dated only by when its session started collapses onto this boot', () => {
    const rig = makeRig();
    const prevBootedAt = rig.nowMs();
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

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

  test('an unreadable last-alive stamp reads as no heartbeat at all', () => {
    const rig = makeRig();
    const prevBootedAt = rig.nowMs();
    wireRealUpdater(rig, committedInstall(prevBootedAt - 5 * 60_000));
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

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

  test('an unreadable last-alive stamp still renders a suppression breadcrumb', () => {
    const rig = makeRig();
    const prevBootedAt = rig.nowMs();
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

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

  test('a handoff stamped after the last heartbeat still suppresses a late reopen', () => {
    const rig = makeRig();
    createCrashDetection(rig.deps).detectBootCrash();
    const lastAliveMs = Date.parse(readSentinel(rig).lastAliveAt ?? '');
    rig.advance(SENTINEL_HEARTBEAT_INTERVAL_MS - 15_000);
    const handoffAt = rig.nowMs();
    wireRealUpdater(rig, committedInstall(handoffAt));
    expect(handoffAt).toBeGreaterThan(lastAliveMs);

    rig.advance(TWO_HOURS_MS);

    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('a commit no live process recorded still suppresses a prompt reopen', () => {
    const rig = makeRig();
    wireRealUpdater(rig, stagedButNeverCommitted(rig.nowMs()));
    createCrashDetection(rig.deps).detectBootCrash();

    rig.advance(5 * 60_000);

    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
  });

  test('a commit no live process recorded does not widen the span', () => {
    const rig = makeRig();
    wireRealUpdater(rig, stagedButNeverCommitted(rig.nowMs()));
    createCrashDetection(rig.deps).detectBootCrash();

    rig.advance(TWO_HOURS_MS);

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

  test('a staged install whose window closed before the death still prompts', () => {
    const rig = makeRig();
    wireRealUpdater(rig, stagedButNeverCommitted(rig.nowMs() - 45 * 60_000));
    createCrashDetection(rig.deps).detectBootCrash();

    rig.advance(TWO_HOURS_MS);

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

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
    expect(breadcrumb.handoffAtIso).toBe(new Date(handoffAt).toISOString());
    expect(breadcrumb.deathFromSource).toBe('last-alive');
    expect(breadcrumb.deathFrom).toBe(new Date(lastAliveMs).toISOString());
    expect(breadcrumb.deathSpanMs).toBe(rig.nowMs() - lastAliveMs);
  });

  test('a heartbeat postdating this boot collapses the span without inverting it', () => {
    const rig = makeRig();
    const handoffAt = rig.nowMs();
    wireRealUpdater(rig, committedInstall(handoffAt));
    mkdirSync(dirname(rig.deps.sentinelPath), { recursive: true });
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

    expect(suppressionBreadcrumb(lines).deathFromSource).toBe('detected-at');
    expect(rig.warnings.map((w) => w.event)).toContain('crash-detection.sentinel-parse-failed');
  });

  test('a sentinel that exists but cannot be read warns rather than passing as absent', () => {
    const rig = makeRig();
    mkdirSync(rig.deps.sentinelPath, { recursive: true });

    const armed = createCrashDetection(rig.deps).detectBootCrash();

    const warn = rig.warnings.find((w) => w.event === 'crash-detection.sentinel-read-failed');
    expect(warn).toBeDefined();
    const errno = (warn?.err as NodeJS.ErrnoException | undefined)?.code;
    expect(errno).toBeDefined();
    expect(errno).not.toBe('ENOENT');
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });

  test('the heartbeat outranks the start of the session when the two straddle the grace', () => {
    const rig = makeRig();
    const prevBootedAt = rig.nowMs();
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

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(true);
  });
});

describe('dumps of deaths the app declined to prompt for', () => {
  test('a swallowed GPU death does not come back as a boot prompt', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    expect(sessionA.detectBootCrash()).toBeNull();

    sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    expect(rig.emitted).toHaveLength(0);
    const declinedAt = new Date(rig.nowMs());
    const dumpAt = new Date(declinedAt.getTime() + 5_000);
    seedMinidump(rig, 'completed/gpu.dmp', dumpAt, rig.ownDumpWithProcessType('gpu-process'));
    sessionA.markCleanQuit();

    const sessionB = createCrashDetection(rig.deps);
    expect(sessionB.detectBootCrash()).toBeNull();
    expect(rig.infos).toContainEqual(
      expect.objectContaining({
        event: 'crash-detection.dump-retired',
        dumpMtimeAt: dumpAt.toISOString(),
        declinedAt: declinedAt.toISOString(),
        processType: 'gpu-process',
      }),
    );
    sessionB.notifyRendererReady();
    expect(rig.emitted).toHaveLength(0);
    sessionB.markCleanQuit();

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
    expect(rig.infos).not.toContainEqual(
      expect.objectContaining({ event: 'crash-detection.dump-beside-decline-unclassified' }),
    );
  });

  test('a renderer dump beside a declined GPU death is a different crash and still prompts', () => {
    const rig = makeRig();
    const sessionA = createCrashDetection(rig.deps);
    expect(sessionA.detectBootCrash()).toBeNull();

    sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    seedMinidump(
      rig,
      'completed/renderer.dmp',
      new Date(rig.nowMs()),
      rig.ownDumpWithProcessType('renderer'),
    );
    sessionA.markCleanQuit();

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(false);
    expect(rig.infos).not.toContainEqual(
      expect.objectContaining({ event: 'crash-detection.dump-beside-decline-unclassified' }),
    );
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
    seedMinidump(rig, 'completed/unannotated.dmp', new Date(rig.nowMs()));
    sessionA.markCleanQuit();

    const armed = createCrashDetection(rig.deps).detectBootCrash();
    expect(bootInvite(armed).context.dirtyShutdown).toBe(false);
    expect(rig.infos).toContainEqual(
      expect.objectContaining({
        event: 'crash-detection.dump-beside-decline-unclassified',
        unnamed: 1,
        parseFailed: 0,
      }),
    );
  });

  test('a dump whose annotation read throws is counted apart from one that says nothing', async () => {
    const CRASHPAD_INFO_MODULE_LIST_PREFIX_BYTES = 52;
    const rig = makeRig();
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...realFs,
      readSync: (
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number,
      ) => {
        if (length === CRASHPAD_INFO_MODULE_LIST_PREFIX_BYTES)
          throw new Error('crashpad layout moved');
        return realFs.readSync(fd, buffer, offset, length, position);
      },
    }));
    try {
      const mocked = await import('./crash-detection.ts');
      const sessionA = mocked.createCrashDetection(rig.deps);
      expect(sessionA.detectBootCrash()).toBeNull();

      sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
      seedMinidump(
        rig,
        'completed/gpu.dmp',
        new Date(rig.nowMs()),
        rig.ownDumpWithProcessType('gpu-process'),
      );
      sessionA.markCleanQuit();

      const sessionB = mocked.createCrashDetection(rig.deps);
      expect(bootInvite(sessionB.detectBootCrash()).context.dirtyShutdown).toBe(false);
      expect(rig.infos).toContainEqual(
        expect.objectContaining({
          event: 'crash-detection.dump-beside-decline-unclassified',
          unnamed: 0,
          parseFailed: 1,
        }),
      );
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
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
    const armed = bootInvite(createCrashDetection(rig.deps).detectBootCrash());
    expect(armed.context.dirtyShutdown).toBe(true);
    expect(armed.context.newMinidumps).toBe(0);
    expect(armed.minidumpAvailable).toBe(true);
  });

  test('a threshold death that lost the invite slot still prompts at the next boot', () => {
    const rig = makeRig();
    const session = createCrashDetection(rig.deps);
    expect(session.detectBootCrash()).toBeNull();
    rig.setRendererAvailable(false);

    session.handleChildProcessGone({ type: 'utility', reason: 'crashed' });
    session.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    session.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    session.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
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

    const armingAt = new Date(rig.nowMs());
    seedMinidump(rig, 'completed/renderer.dmp', armingAt, rig.ownDumpStamped(CRASHED_VERSION));
    rig.advance(1_000);
    sessionA.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
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

    expect(createCrashDetection(rig.deps).detectBootCrash()).toBeNull();
    const stored = JSON.parse(readFileSync(rig.deps.ackStorePath, 'utf8')) as {
      declinedDeaths: { processType: string }[];
    };
    expect(stored.declinedDeaths).toHaveLength(1);
  });

  test('the cap covers a day of the fastest within-session cadence that never prompts', () => {
    const SUSTAINED_HOURS = 24;
    const declinesPerHour = 3_600_000 / (GPU_CRASH_WINDOW_MS / (GPU_CRASH_INVITE_THRESHOLD - 1));
    expect(MAX_DECLINED_DEATHS).toBeGreaterThanOrEqual(SUSTAINED_HOURS * declinesPerHour);
  });

  test('the record list is capped, dropping the oldest first', () => {
    const rig = makeRig();
    const seededAt: string[] = [];
    for (let i = 0; i < MAX_DECLINED_DEATHS - 1; i++) {
      seededAt.push(new Date(rig.nowMs() - (MAX_DECLINED_DEATHS - i) * 6 * 60_000).toISOString());
    }
    mkdirSync(dirname(rig.deps.ackStorePath), { recursive: true });
    writeFileSync(
      rig.deps.ackStorePath,
      JSON.stringify({
        ackedEventIds: [],
        minidumpBaselineAt: new Date(rig.nowMs() - MAX_DECLINED_DEATHS * 12 * 60_000).toISOString(),
        declinedDeaths: seededAt.map((at) => ({ at, processType: 'gpu-process' })),
      }),
    );
    const session = createCrashDetection(rig.deps);
    expect(session.detectBootCrash()).toBeNull();
    const oldestAt = seededAt[0] ?? '';

    rig.advance(6 * 60_000);
    session.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });
    rig.advance(6 * 60_000);
    session.handleChildProcessGone({ type: 'GPU', reason: 'crashed' });

    const stored = JSON.parse(readFileSync(rig.deps.ackStorePath, 'utf8')) as {
      declinedDeaths: { at: string }[];
    };
    expect(stored.declinedDeaths).toHaveLength(MAX_DECLINED_DEATHS);
    expect(stored.declinedDeaths.map((d) => d.at)).not.toContain(oldestAt);

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
    expect(rig.emitted).toHaveLength(1);
    seedMinidump(
      rig,
      'completed/gpu-third.dmp',
      new Date(rig.nowMs()),
      rig.ownDumpWithProcessType('gpu-process'),
    );
    sessionA.markCleanQuit();

    expect(rig.infos).toContainEqual(
      expect.objectContaining({
        event: 'crash-detection.declined-deaths-cleared',
        processType: 'gpu-process',
        cleared: 2,
      }),
    );

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
    expect(bootInvite(detection.detectBootCrash()).context.dirtyShutdown).toBe(false);
    detection.ack('boot:some-event');
    expect(JSON.parse(readFileSync(rig.deps.ackStorePath, 'utf8')) as unknown).toMatchObject({
      declinedDeaths: [],
    });
  });
});
