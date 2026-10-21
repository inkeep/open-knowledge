import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createContentFilter } from './content-filter.ts';
import {
  contentHash,
  type DiskEvent,
  lastKnownHash,
  removeLastKnownHash,
  type StartWatcherOptions,
  startWatcher,
  type WatcherHandle,
} from './file-watcher.ts';
import { scanInPlaceSkillDirs, skillRootPathsFor } from './in-place-skills.ts';
import { getMetrics } from './metrics.ts';
import { createManualClock, type ManualClock } from './watcher-clock.test-helper.ts';
import { createWatcherDouble } from './watcher-double.test-helper.ts';
import {
  FRESHNESS_HASH_BUDGET,
  FRESHNESS_MAX_INTERVAL_MS,
  nextFreshnessDelayMs,
} from './watcher-freshness.ts';

const SETTLED_TIMESTAMPS_MS = 10_000;

function readCanBeRevoked(): boolean {
  if (process.platform === 'win32') return false;
  const dir = mkdtempSync(join(tmpdir(), 'ok-revoke-probe-'));
  const probe = join(dir, 'probe');
  try {
    writeFileSync(probe, 'probe');
    chmodSync(probe, 0o000);
    try {
      readFileSync(probe);
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') return true;
      throw err;
    }
  } finally {
    chmodSync(probe, 0o600);
    rmSync(dir, { recursive: true, force: true });
  }
}

const CAN_REVOKE_READ = readCanBeRevoked();

const walkGate = vi.hoisted(() => ({
  dir: null as string | null,
  afterRead: null as string | null,
  entered: false,
  release: null as (() => void) | null,
  directoryReads: new Map<string, number>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readdir = actual.readdir as (...args: unknown[]) => Promise<unknown>;
  const readFile = actual.readFile as (...args: unknown[]) => Promise<unknown>;
  const hold = async (): Promise<void> => {
    walkGate.entered = true;
    await new Promise<void>((resolve) => {
      walkGate.release = resolve;
    });
  };
  return {
    ...actual,
    readdir: async (...args: unknown[]) => {
      const dir = String(args[0]);
      walkGate.directoryReads.set(dir, (walkGate.directoryReads.get(dir) ?? 0) + 1);
      if (walkGate.dir !== null && dir === walkGate.dir) {
        walkGate.dir = null;
        await hold();
      }
      return readdir(...args);
    },
    readFile: async (...args: unknown[]) => {
      const content = await readFile(...args);
      if (walkGate.afterRead !== null && String(args[0]) === walkGate.afterRead) {
        walkGate.afterRead = null;
        await hold();
      }
      return content;
    },
  };
});

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function eventsFor(events: readonly DiskEvent[], kind: DiskEvent['kind'], docName: string) {
  return events.filter(
    (event) => event.kind === kind && 'docName' in event && event.docName === docName,
  );
}

describe('timed freshness re-check', () => {
  let tmpDir: string;
  let contentDir: string;
  let handle: WatcherHandle | undefined;
  let clock: ManualClock;
  let events: DiskEvent[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-watcher-freshness-'));
    contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    contentDir = realpathSync(contentDir);
    lastKnownHash.clear();
    clock = createManualClock(Date.now());
    events = [];
  });

  afterEach(async () => {
    walkGate.release?.();
    walkGate.dir = null;
    walkGate.afterRead = null;
    walkGate.entered = false;
    walkGate.release = null;
    walkGate.directoryReads.clear();
    await handle?.unsubscribe();
    handle = undefined;
    vi.useRealTimers();
    for (const locked of revoked.splice(0)) chmodSync(locked, 0o755);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const revoked: string[] = [];
  function revokeRead(path: string): void {
    chmodSync(path, 0o000);
    revoked.push(path);
  }

  async function flush(): Promise<void> {
    for (let round = 0; round < 5; round++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  let double: ReturnType<typeof createWatcherDouble>;

  async function watch(
    freshnessIntervalMs?: number | null,
    extra: Pick<StartWatcherOptions, 'onRecoveryComplete' | 'onRecoveryPassCompleted'> = {},
  ): Promise<WatcherHandle> {
    double = createWatcherDouble();
    handle = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      {
        nativeBackend: double.backend,
        clock,
        ...(freshnessIntervalMs === undefined ? {} : { freshnessIntervalMs }),
        ...extra,
      },
    );
    return handle;
  }

  function moveModificationTimeLater(path: string): void {
    const { atime, mtime } = statSync(path);
    utimesSync(path, atime, new Date(mtime.getTime() + 2_000));
  }

  function keepModificationTime(path: string, write: () => void): void {
    const { atime, mtime } = statSync(path);
    write();
    utimesSync(path, atime, mtime);
  }

  async function runTimedPass(advanceMs: number): Promise<void> {
    const before = getMetrics().freshnessPasses;
    clock.advance(advanceMs);
    await until(() => getMetrics().freshnessPasses > before, 'the timed pass to finish');
  }

  function settleTimestamps(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + SETTLED_TIMESTAMPS_MS);
  }

  function freezeTimestampsNow(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
  }

  test('a write the native watcher never delivered is applied by the next timed pass', async () => {
    await watch(5_000);
    writeFileSync(join(contentDir, 'silent.md'), '# Silent\n');
    const findsBefore = getMetrics().freshnessFinds;

    clock.advance(4_999);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(eventsFor(events, 'create', 'silent')).toHaveLength(0);

    await runTimedPass(1);
    expect(eventsFor(events, 'create', 'silent')).toHaveLength(1);
    expect(handle?.getFileIndex().has('silent')).toBe(true);
    expect(getMetrics().freshnessFinds - findsBefore).toBe(1);
  });

  test('a watcher started without an interval option runs no timed pass', async () => {
    await watch();
    writeFileSync(join(contentDir, 'library-default.md'), '# Library default\n');
    const passesBefore = getMetrics().freshnessPasses;
    clock.advance(FRESHNESS_MAX_INTERVAL_MS * 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getMetrics().freshnessPasses).toBe(passesBefore);
    expect(eventsFor(events, 'create', 'library-default')).toHaveLength(0);
  });

  test('a null interval turns the timed pass off, and an explicit re-check still finds the write', async () => {
    await watch(null);
    writeFileSync(join(contentDir, 'off.md'), '# Off\n');
    const passesBefore = getMetrics().freshnessPasses;
    clock.advance(FRESHNESS_MAX_INTERVAL_MS * 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getMetrics().freshnessPasses).toBe(passesBefore);
    expect(eventsFor(events, 'create', 'off')).toHaveLength(0);

    const result = await (handle as WatcherHandle).recheck();
    expect(result.status).toBe('completed');
    expect(eventsFor(events, 'create', 'off')).toHaveLength(1);
  });

  test('a pass reads only the files whose size, time or identity changed', async () => {
    writeFileSync(join(contentDir, 'one.md'), '# One\n');
    writeFileSync(join(contentDir, 'two.md'), '# Two\n');
    writeFileSync(join(contentDir, 'three.md'), '# Three\n');
    settleTimestamps();
    await watch(5_000);

    const hashedBefore = getMetrics().freshnessFilesHashed;
    await runTimedPass(5_000);
    expect(getMetrics().freshnessFilesHashed - hashedBefore).toBe(0);
    expect(events).toHaveLength(0);

    writeFileSync(join(contentDir, 'two.md'), '# Two, edited outside\n');
    const hashedBeforeEdit = getMetrics().freshnessFilesHashed;
    await runTimedPass(5_000);
    expect(getMetrics().freshnessFilesHashed - hashedBeforeEdit).toBe(1);
    expect(eventsFor(events, 'update', 'two')).toHaveLength(1);
    expect(events).toHaveLength(1);

    const hashedAfterIntake = getMetrics().freshnessFilesHashed;
    await runTimedPass(5_000);
    expect(getMetrics().freshnessFilesHashed - hashedAfterIntake).toBe(0);
  });

  test('a file changed within the timestamp granularity is read again until its times settle', async () => {
    freezeTimestampsNow();
    writeFileSync(join(contentDir, 'fresh.md'), '# Fresh\n');
    await watch(5_000);

    const hashedBefore = getMetrics().freshnessFilesHashed;
    await runTimedPass(5_000);
    await runTimedPass(5_000);
    expect(getMetrics().freshnessFilesHashed - hashedBefore).toBe(2);

    settleTimestamps();
    await runTimedPass(5_000);
    const hashedAfterSettle = getMetrics().freshnessFilesHashed;
    await runTimedPass(5_000);
    expect(getMetrics().freshnessFilesHashed - hashedAfterSettle).toBe(0);
    expect(events).toHaveLength(0);
  });

  test('changes beyond one pass budget are carried to the next pass', async () => {
    settleTimestamps();
    await watch(5_000);
    const total = FRESHNESS_HASH_BUDGET.files + 40;
    for (let index = 0; index < total; index++) {
      writeFileSync(join(contentDir, `bulk-${String(index).padStart(4, '0')}.md`), `# ${index}\n`);
    }

    const carriedBefore = getMetrics().freshnessCarryOver;
    await runTimedPass(5_000);
    expect(events.filter((event) => event.kind === 'create')).toHaveLength(
      FRESHNESS_HASH_BUDGET.files,
    );
    expect(getMetrics().freshnessCarryOver - carriedBefore).toBe(40);

    await runTimedPass(5_000);
    expect(events.filter((event) => event.kind === 'create')).toHaveLength(total);
  });

  test('an edit that keeps the file size and moves the modification time is found by the timed pass', async () => {
    const same = join(contentDir, 'same.md');
    writeFileSync(same, '# AAAA\n');
    settleTimestamps();
    await watch(5_000);

    writeFileSync(same, '# BBBB\n');
    moveModificationTimeLater(same);
    await runTimedPass(5_000);
    expect(eventsFor(events, 'update', 'same')).toHaveLength(1);
  });

  test('an edit that keeps the file size and the modification time is still found by the timed pass', async () => {
    const same = join(contentDir, 'same.md');
    writeFileSync(same, '# AAAA\n');
    await watch(5_000);

    keepModificationTime(same, () => writeFileSync(same, '# BBBB\n'));
    await runTimedPass(5_000);
    expect(eventsFor(events, 'update', 'same')).toHaveLength(1);
  });

  test.runIf(CAN_REVOKE_READ).each([
    ['a later modification time', true],
    ['an unchanged modification time', false],
  ] as const)(
    'a file that cannot be read, with %s, does not stop the pass from applying a change beside it',
    async (_label, settled) => {
      const locked = join(contentDir, 'locked.md');
      writeFileSync(locked, '# Locked\n');
      writeFileSync(join(contentDir, 'open.md'), '# Open\n');
      if (settled) settleTimestamps();
      const reconciled = vi.fn(async () => {});
      await watch(5_000, { onRecoveryComplete: reconciled });
      const unreadableBefore = getMetrics().watcherUnreadableEntries;

      if (settled) {
        revokeRead(locked);
        moveModificationTimeLater(locked);
      } else {
        keepModificationTime(locked, () => revokeRead(locked));
      }
      writeFileSync(join(contentDir, 'open.md'), '# Open, edited outside\n');
      reconciled.mockClear();
      await runTimedPass(5_000);
      expect(eventsFor(events, 'update', 'open')).toHaveLength(1);
      expect(eventsFor(events, 'delete', 'locked')).toHaveLength(0);
      expect(handle?.getFileIndex().has('locked')).toBe(true);
      expect(reconciled).not.toHaveBeenCalled();

      writeFileSync(join(contentDir, 'open.md'), '# Open, edited again\n');
      await runTimedPass(5_000);
      expect(eventsFor(events, 'update', 'open')).toHaveLength(2);
      expect(getMetrics().watcherUnreadableEntries - unreadableBefore).toBe(1);

      chmodSync(locked, 0o644);
      moveModificationTimeLater(locked);
      await runTimedPass(5_000);
      expect(reconciled).toHaveBeenCalledTimes(1);
    },
  );

  test.runIf(CAN_REVOKE_READ)(
    'a folder that cannot be listed keeps its documents while the rest of the tree is checked',
    async () => {
      mkdirSync(join(contentDir, 'private'));
      writeFileSync(join(contentDir, 'private', 'inside.md'), '# Inside\n');
      writeFileSync(join(contentDir, 'open.md'), '# Open\n');
      settleTimestamps();
      await watch(5_000);

      revokeRead(join(contentDir, 'private'));
      writeFileSync(join(contentDir, 'open.md'), '# Open, edited outside\n');
      await runTimedPass(5_000);
      expect(eventsFor(events, 'update', 'open')).toHaveLength(1);
      expect(events.filter((event) => event.kind === 'delete')).toHaveLength(0);
      expect(events.filter((event) => event.kind === 'folder-delete')).toHaveLength(0);
      expect(handle?.getFileIndex().has('private/inside')).toBe(true);
    },
  );

  test('an event the native watcher delivers while a timed pass walks the tree is applied before the pass ends', async () => {
    mkdirSync(join(contentDir, 'slow'));
    writeFileSync(join(contentDir, 'slow', 'a.md'), '# A\n');
    settleTimestamps();
    const double = createWatcherDouble();
    handle = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      { nativeBackend: double.backend, clock, freshnessIntervalMs: 5_000 },
    );
    const passesBefore = getMetrics().freshnessPasses;
    walkGate.dir = join(contentDir, 'slow');
    clock.advance(5_000);
    await until(() => walkGate.entered, 'the timed pass to reach the slow folder');

    const delivered = join(contentDir, 'delivered.md');
    writeFileSync(delivered, '# Delivered\n');
    double.subscriptionFor(contentDir).deliver([{ type: 'create', path: delivered }]);
    await until(
      () => eventsFor(events, 'create', 'delivered').length === 1,
      'the delivered event while the pass is still walking',
    );
    expect(getMetrics().freshnessPasses).toBe(passesBefore);

    walkGate.release?.();
    await until(() => getMetrics().freshnessPasses > passesBefore, 'the timed pass to finish');
    expect(eventsFor(events, 'create', 'delivered')).toHaveLength(1);
  });

  test('a skill folder added outside the app between passes is admitted by the next timed pass', async () => {
    const filter = createContentFilter({
      projectDir: contentDir,
      contentDir,
      inPlaceSkillDirs: scanInPlaceSkillDirs(contentDir),
      rescanInPlaceSkillDirs: () => scanInPlaceSkillDirs(contentDir),
      skillRootPaths: skillRootPathsFor(contentDir),
    });
    double = createWatcherDouble();
    handle = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      filter,
      { nativeBackend: double.backend, clock, freshnessIntervalMs: 5_000 },
    );
    const bundle = join(contentDir, '.claude', 'skills', 'added-later');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(
      join(bundle, 'SKILL.md'),
      '---\nname: added-later\ndescription: fixture\n---\n\n# Added later\n',
    );
    expect(filter.isExcluded('.claude/skills/added-later/SKILL.md')).toBe(true);

    await runTimedPass(5_000);
    expect(eventsFor(events, 'create', '.claude/skills/added-later/SKILL')).toHaveLength(1);
    expect(handle.getFileIndex().has('.claude/skills/added-later/SKILL')).toBe(true);
  });

  test('a change intake applies while a timed pass walks is kept, and the pass walks the tree once', async () => {
    const raced = join(contentDir, 'raced.md');
    writeFileSync(raced, '# Raced v1\n');
    settleTimestamps();
    await watch(5_000);
    writeFileSync(raced, '# Raced v2, edited outside\n');
    moveModificationTimeLater(raced);
    walkGate.afterRead = raced;
    walkGate.directoryReads.clear();
    const passesBefore = getMetrics().freshnessPasses;
    clock.advance(5_000);
    await until(() => walkGate.entered, 'the timed pass to read the edited file');

    const latest = '# Raced v3, edited again while the pass walks\n';
    writeFileSync(raced, latest);
    double.subscriptionFor(contentDir).deliver([{ type: 'update', path: raced }]);
    await until(() => lastKnownHash.get(raced) === contentHash(latest), 'intake to apply v3');
    walkGate.release?.();
    await until(() => getMetrics().freshnessPasses > passesBefore, 'the timed pass to finish');

    expect(walkGate.directoryReads.get(contentDir)).toBe(1);
    expect(lastKnownHash.get(raced)).toBe(contentHash(latest));
    expect(eventsFor(events, 'update', 'raced')).toHaveLength(1);
    await runTimedPass(5_000);
    expect(eventsFor(events, 'update', 'raced')).toHaveLength(1);
  });

  test('a Markdown link pointed at another file outside the app is followed by the timed pass', async () => {
    writeFileSync(join(contentDir, 'first.md'), '# First\n');
    writeFileSync(join(contentDir, 'second.md'), '# Second\n');
    const pointer = join(contentDir, 'pointer.md');
    symlinkSync(join(contentDir, 'first.md'), pointer);
    settleTimestamps();
    await watch(5_000);
    expect(handle?.getAliasMap().get('pointer')).toBe('first');

    rmSync(pointer);
    symlinkSync(join(contentDir, 'second.md'), pointer);
    await runTimedPass(5_000);
    expect(handle?.getAliasMap().get('pointer')).toBe('second');
  });

  test('a re-read while the content folder is missing reports no document deleted', async () => {
    const kept = join(contentDir, 'kept.md');
    writeFileSync(kept, '# Kept\n');
    await watch(null);

    rmSync(contentDir, { recursive: true, force: true });
    const result = await (handle as WatcherHandle).recheckPaths([kept]);
    expect(result).toEqual({ checked: 0, found: 0 });
    expect(events.filter((event) => event.kind === 'delete')).toHaveLength(0);
    expect(handle?.getFileIndex().has('kept')).toBe(true);
  });

  test('a re-read under an intact content folder reports a file deleted outside the app', async () => {
    const gone = join(contentDir, 'gone.md');
    writeFileSync(gone, '# Gone\n');
    await watch(null);

    rmSync(gone);
    const result = await (handle as WatcherHandle).recheckPaths([gone]);
    expect(result).toEqual({ checked: 1, found: 1 });
    expect(eventsFor(events, 'delete', 'gone')).toHaveLength(1);
  });

  test('stopping the watcher while a timed pass walks the tree waits for that pass, which counts nothing afterwards', async () => {
    mkdirSync(join(contentDir, 'slow'));
    writeFileSync(join(contentDir, 'slow', 'a.md'), '# A\n');
    settleTimestamps();
    const watching = await watch(5_000);
    const passesBefore = getMetrics().freshnessPasses;
    const incompleteBefore = getMetrics().freshnessPassesIncomplete;
    walkGate.dir = join(contentDir, 'slow');
    clock.advance(5_000);
    await until(() => walkGate.entered, 'the timed pass to reach the slow folder');

    let stopped = false;
    handle = undefined;
    const stopping = watching.unsubscribe().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    walkGate.release?.();
    await stopping;

    expect(getMetrics().freshnessPasses).toBe(passesBefore);
    expect(getMetrics().freshnessPassesIncomplete).toBe(incompleteBefore);
    expect(lastKnownHash.size).toBe(0);
  });

  test('a full re-check requested while a timed recovery is queued runs that recovery in full', async () => {
    settleTimestamps();
    const double = createWatcherDouble();
    let releaseQueue: () => void = () => {};
    const queueHeld = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    handle = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
        if (event.kind === 'create' && event.docName === 'blocker') await queueHeld;
      },
      undefined,
      { nativeBackend: double.backend, clock, freshnessIntervalMs: 5_000 },
    );
    const blocker = join(contentDir, 'blocker.md');
    writeFileSync(blocker, '# Blocker\n');
    double.subscriptionFor(contentDir).deliver([{ type: 'create', path: blocker }]);
    await until(() => eventsFor(events, 'create', 'blocker').length === 1, 'the queue to be held');

    const total = FRESHNESS_HASH_BUDGET.files + 40;
    for (let index = 0; index < total; index++) {
      writeFileSync(join(contentDir, `bulk-${String(index).padStart(4, '0')}.md`), `# ${index}\n`);
    }
    const hashedBefore = getMetrics().freshnessFilesHashed;
    clock.advance(5_000);
    await until(() => getMetrics().freshnessFilesHashed > hashedBefore, 'the timed probe');
    await flush();

    const full = (handle as WatcherHandle).recheck();
    releaseQueue();
    expect((await full).status).toBe('completed');
    const bulkCreates = events.filter(
      (event) => event.kind === 'create' && event.docName.startsWith('bulk-'),
    );
    expect(bulkCreates).toHaveLength(total);
  });

  test('an indexed document with no stored hash is read, not reported deleted, when the budget runs out', async () => {
    writeFileSync(join(contentDir, 'zz-kept.md'), '# Kept\n');
    settleTimestamps();
    await watch(5_000);
    removeLastKnownHash(join(contentDir, 'zz-kept.md'));
    for (let index = 0; index < FRESHNESS_HASH_BUDGET.files * 2 + 100; index++) {
      writeFileSync(join(contentDir, `bulk-${String(index).padStart(4, '0')}.md`), `# ${index}\n`);
    }

    await runTimedPass(5_000);
    expect(eventsFor(events, 'delete', 'zz-kept')).toHaveLength(0);
    expect(handle?.getFileIndex().has('zz-kept')).toBe(true);
  });

  test.runIf(process.platform !== 'win32')(
    'a re-read of a FIFO or a link to a device returns without reading it',
    async () => {
      await watch(null);
      const fifo = join(contentDir, 'pipe.md');
      execFileSync('mkfifo', [fifo]);
      const device = join(contentDir, 'zero.md');
      symlinkSync('/dev/zero', device);

      const result = await (handle as WatcherHandle).recheckPaths([fifo, device]);
      expect(result).toEqual({ checked: 2, found: 0 });
      expect(events).toHaveLength(0);
    },
  );

  test.runIf(CAN_REVOKE_READ)(
    'the per-pass hook says whether a completed pass observed the whole tree',
    async () => {
      writeFileSync(join(contentDir, 'open.md'), '# Open\n');
      const passes: Array<{ pass: number; whole: boolean }> = [];
      await watch(null, {
        onRecoveryPassCompleted: async (pass, whole) => {
          passes.push({ pass, whole });
        },
      });

      await (handle as WatcherHandle).recheck();
      expect(passes.at(-1)?.whole).toBe(true);

      mkdirSync(join(contentDir, 'locked'));
      revokeRead(join(contentDir, 'locked'));
      await (handle as WatcherHandle).recheck();
      expect(passes.at(-1)?.whole).toBe(false);
    },
  );

  test('a pass that cannot read the content root reports no completed pass', async () => {
    writeFileSync(join(contentDir, 'kept.md'), '# Kept\n');
    const passes: number[] = [];
    await watch(null, {
      onRecoveryPassCompleted: async (pass) => {
        passes.push(pass);
      },
    });
    const before = passes.length;

    rmSync(contentDir, { recursive: true, force: true });
    const result = await (handle as WatcherHandle).recheck();
    expect(result.status).toBe('incomplete');
    expect(passes).toHaveLength(before);
  });

  test('a content root that is gone leaves the known documents in place instead of deleting them', async () => {
    writeFileSync(join(contentDir, 'kept.md'), '# Kept\n');
    await watch(null);
    expect(handle?.getFileIndex().has('kept')).toBe(true);

    rmSync(contentDir, { recursive: true, force: true });
    const result = await (handle as WatcherHandle).recheck();
    expect(result.status).toBe('incomplete');
    expect(events.filter((event) => event.kind === 'delete')).toHaveLength(0);
    expect(handle?.getFileIndex().has('kept')).toBe(true);
  });
});

describe('freshness pass spacing', () => {
  test('a quick pass keeps the base interval', () => {
    expect(nextFreshnessDelayMs(0, 5_000)).toBe(5_000);
    expect(nextFreshnessDelayMs(200, 5_000)).toBe(5_000);
  });

  test('a slow pass spaces the next one so passes take about a twentieth of the time', () => {
    expect(nextFreshnessDelayMs(1_000, 5_000)).toBe(20_000);
  });

  test('the spacing never exceeds the maximum unless the base interval does', () => {
    expect(nextFreshnessDelayMs(30_000, 5_000)).toBe(FRESHNESS_MAX_INTERVAL_MS);
    expect(nextFreshnessDelayMs(30_000, 90_000)).toBe(90_000);
  });
});
