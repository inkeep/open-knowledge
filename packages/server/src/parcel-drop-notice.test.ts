import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Event } from '@parcel/watcher';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';
import {
  type ContentFilter,
  type ContentFilterOptions,
  createContentFilter,
  createContentFilterAsync,
} from './content-filter.ts';
import { _resetDocExtensionsForTests, getDocExtension } from './doc-extensions.ts';
import {
  classifyEvents,
  contentHash,
  type DiskEvent,
  getWatcherDecisionRingSnapshot,
  handleRawEvents,
  lastKnownHash,
  reconcileFileIndexAfterFilterRebuild,
  registerRemoval,
  registerWrite,
  removalTracker,
  startWatcher,
  updateFileIndex,
  type WatcherHandle,
  writeTracker,
} from './file-watcher.ts';
import { type HeadWatcherHandle, startHeadWatcher } from './head-watcher.ts';
import {
  scanGlobalInPlaceSkills,
  scanInPlaceSkillDirs,
  scanInPlaceSkills,
  skillRootPathsFor,
} from './in-place-skills.ts';
import { localTargetInventoryFromWatcher } from './local-target-inventory.ts';
import { getLogger } from './logger.ts';
import {
  forgetNativeSubscriptions,
  nativeSubscriptionDirs,
  nativeSubscriptionOn,
} from './parcel-watcher-double.test-helper.ts';
import { startPolledPathWatcher } from './polled-path-watcher.ts';
import { createServer, type ServerInstance } from './server-factory.ts';
import * as skillPlacements from './skill-placements.ts';
import { mutateSkillPlacementsStore, readSkillPlacementsStore } from './skill-placements-store.ts';

vi.mock('@parcel/watcher', async () => {
  const { parcelWatcherModule } = await import('./parcel-watcher-double.test-helper.ts');
  return parcelWatcherModule;
});

const headBatchSchedule = vi.hoisted(() => ({
  armed: false,
  hold: null as Promise<void> | null,
  begun: null as (() => void) | null,
  ended: null as (() => void) | null,
  begins: [] as unknown[],
  ends: [] as unknown[],
}));

vi.mock('./head-watcher.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./head-watcher.ts')>();
  const startHeadWatcher: typeof original.startHeadWatcher = (
    projectRoot,
    onBatchBegin,
    onBatchEnd,
    opts,
  ) =>
    headBatchSchedule.armed
      ? original.startHeadWatcher(
          projectRoot,
          async (info) => {
            try {
              await onBatchBegin(info);
            } finally {
              headBatchSchedule.begins.push(info);
              headBatchSchedule.begun?.();
            }
            await headBatchSchedule.hold;
          },
          async (info) => {
            try {
              await onBatchEnd(info);
            } finally {
              headBatchSchedule.ends.push(info);
              headBatchSchedule.ended?.();
            }
          },
          opts,
        )
      : original.startHeadWatcher(projectRoot, onBatchBegin, onBatchEnd, opts);
  return { ...original, startHeadWatcher };
});

const deniedSkillRootRead = vi.hoisted(() => ({
  path: null as string | null,
  observed: false,
  error: null as Error | null,
}));
const admissionFault = vi.hoisted(() => ({
  operation: null as 'exists' | 'stat' | 'lstat' | 'realpath' | 'read' | 'readdir' | null,
  path: null as string | null,
  observed: false,
  maskedAncestor: null as string | null,
  descendantPath: null as string | null,
  descendantShape: null as 'missing' | 'directory' | null,
  descendantObserved: false,
  descendantError: null as NodeJS.ErrnoException | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const fail = (operation: Exclude<typeof admissionFault.operation, null>, path: unknown): void => {
    if (admissionFault.operation !== operation || String(path) !== admissionFault.path) return;
    admissionFault.observed = true;
    throw Object.assign(new Error('directory read denied'), { code: 'EACCES', path });
  };
  const denyRealpath = (path: unknown): void => {
    fail('realpath', path);
    if (admissionFault.maskedAncestor && String(path) === admissionFault.maskedAncestor) {
      admissionFault.observed = true;
      throw Object.assign(new Error('directory read denied'), { code: 'EACCES', path });
    }
  };
  return {
    ...fs,
    existsSync: ((...args: Parameters<typeof fs.existsSync>) => {
      if (String(args[0]) === admissionFault.maskedAncestor) {
        admissionFault.observed = true;
        return false;
      }
      fail('exists', args[0]);
      return fs.existsSync(...args);
    }) as typeof fs.existsSync,
    statSync: ((...args: Parameters<typeof fs.statSync>) => {
      fail('stat', args[0]);
      if (admissionFault.maskedAncestor && String(args[0]) === admissionFault.maskedAncestor) {
        admissionFault.observed = true;
        throw Object.assign(new Error('directory read denied'), { code: 'EACCES', path: args[0] });
      }
      return fs.statSync(...args);
    }) as typeof fs.statSync,
    lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => {
      fail('lstat', args[0]);
      if (admissionFault.maskedAncestor && String(args[0]) === admissionFault.maskedAncestor) {
        admissionFault.observed = true;
        throw Object.assign(new Error('directory read denied'), { code: 'EACCES', path: args[0] });
      }
      return fs.lstatSync(...args);
    }) as typeof fs.lstatSync,
    realpathSync: Object.assign(
      ((...args: Parameters<typeof fs.realpathSync>) => {
        denyRealpath(args[0]);
        return fs.realpathSync(...args);
      }) as typeof fs.realpathSync,
      {
        native: ((...args: Parameters<typeof fs.realpathSync.native>) => {
          denyRealpath(args[0]);
          return fs.realpathSync.native(...args);
        }) as typeof fs.realpathSync.native,
      },
    ),
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      fail('read', args[0]);
      if (admissionFault.maskedAncestor && String(args[0]) === admissionFault.maskedAncestor) {
        admissionFault.observed = true;
        throw Object.assign(new Error('directory read denied'), { code: 'EACCES', path: args[0] });
      }
      if (String(args[0]) === admissionFault.descendantPath && !admissionFault.descendantObserved) {
        admissionFault.descendantObserved = true;
        fs.unlinkSync(String(args[0]));
        if (admissionFault.descendantShape === 'directory') fs.mkdirSync(String(args[0]));
      }
      try {
        return fs.readFileSync(...args);
      } catch (error) {
        if (String(args[0]) === admissionFault.descendantPath) {
          admissionFault.descendantError = error as NodeJS.ErrnoException;
        }
        throw error;
      }
    }) as typeof fs.readFileSync,
    readdirSync: ((...args: Parameters<typeof fs.readdirSync>) => {
      fail('readdir', args[0]);
      if (admissionFault.maskedAncestor && String(args[0]) === admissionFault.maskedAncestor) {
        admissionFault.observed = true;
        throw Object.assign(new Error('directory read denied'), { code: 'EACCES', path: args[0] });
      }
      if (String(args[0]) === deniedSkillRootRead.path) {
        deniedSkillRootRead.observed = true;
        throw (
          deniedSkillRootRead.error ??
          Object.assign(new Error('directory read denied'), { code: 'EACCES' })
        );
      }
      return fs.readdirSync(...args);
    }) as typeof fs.readdirSync,
  };
});

const deniedDirectoryRead = vi.hoisted(() => ({ path: null as string | null }));
const deviceContrast = vi.hoisted(() => ({
  path: null as string | null,
  device: null as number | null,
  inode: null as number | null,
  observed: false,
}));
const memberStatSchedule = vi.hoisted(() => ({
  path: null as string | null,
  entered: null as (() => void) | null,
  resume: null as Promise<void> | null,
  seen: [] as string[],
}));
const scanSchedule = vi.hoisted(() => ({
  holdPath: null as string | null,
  entered: null as (() => void) | null,
  resume: null as Promise<void> | null,
  firstEntry: null as string | null,
  orderedEntries: null as readonly string[] | null,
  orderedPath: null as string | null,
}));
const classificationReadSchedule = vi.hoisted(() => ({
  path: null as string | null,
  holdRead: 0,
  seen: [] as string[],
  captured: null as string | null,
  entered: null as (() => void) | null,
  resume: null as Promise<void> | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: (async (...args: Parameters<typeof fs.lstat>) => {
      const result = await fs.lstat(...args);
      memberStatSchedule.seen.push(String(args[0]));
      if (String(args[0]) === memberStatSchedule.path) {
        memberStatSchedule.path = null;
        memberStatSchedule.entered?.();
        await memberStatSchedule.resume;
      }
      if (String(args[0]) !== deviceContrast.path) return result;
      deviceContrast.observed = true;
      if (deviceContrast.device === null || deviceContrast.inode === null) return result;
      return Object.assign(result, { dev: deviceContrast.device, ino: deviceContrast.inode });
    }) as typeof fs.lstat,
    readFile: (async (...args: Parameters<typeof fs.readFile>) => {
      const content = await fs.readFile(...args);
      if (String(args[0]) === classificationReadSchedule.path && typeof content === 'string') {
        classificationReadSchedule.seen.push(content);
        if (classificationReadSchedule.seen.length === classificationReadSchedule.holdRead) {
          classificationReadSchedule.captured = content;
          classificationReadSchedule.entered?.();
          await classificationReadSchedule.resume;
        }
      }
      return content;
    }) as typeof fs.readFile,
    readdir: (async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === deniedDirectoryRead.path) {
        deniedDirectoryRead.path = null;
        return Promise.reject(
          Object.assign(new Error('directory read denied'), { code: 'EACCES' }),
        );
      }
      const entries = await fs.readdir(...args);
      if (String(args[0]) === scanSchedule.orderedPath) {
        entries.sort((left, right) => {
          const leftName = typeof left === 'string' ? left : left.name;
          const rightName = typeof right === 'string' ? right : right.name;
          if (scanSchedule.orderedEntries) {
            const leftIndex = scanSchedule.orderedEntries.indexOf(leftName);
            const rightIndex = scanSchedule.orderedEntries.indexOf(rightName);
            if (leftIndex !== -1 || rightIndex !== -1) {
              if (leftIndex === -1) return 1;
              if (rightIndex === -1) return -1;
              return leftIndex - rightIndex;
            }
          }
          return (
            Number(rightName === scanSchedule.firstEntry) -
            Number(leftName === scanSchedule.firstEntry)
          );
        });
      }
      if (String(args[0]) === scanSchedule.holdPath) {
        scanSchedule.holdPath = null;
        scanSchedule.entered?.();
        await scanSchedule.resume;
      }
      return entries;
    }) as typeof fs.readdir,
  };
});

const notices = [
  'Events were dropped by the FSEvents client. File system must be re-scanned.',
  'Too many events. File system must be re-scanned.',
  'Events were dropped by the kernel. File system must be re-scanned.',
];

const oldOid = '1'.repeat(40);
const newOid = '2'.repeat(40);
const handles: Array<WatcherHandle | HeadWatcherHandle> = [];
const cleanupDirs: string[] = [];
const releaseLatches: Array<() => void> = [];
let contentDir: string;

beforeEach(() => {
  headBatchSchedule.armed = false;
  headBatchSchedule.hold = null;
  headBatchSchedule.begun = null;
  headBatchSchedule.ended = null;
  headBatchSchedule.begins = [];
  headBatchSchedule.ends = [];
  scanSchedule.holdPath = null;
  scanSchedule.entered = null;
  scanSchedule.resume = null;
  scanSchedule.firstEntry = null;
  scanSchedule.orderedEntries = null;
  scanSchedule.orderedPath = null;
  classificationReadSchedule.path = null;
  classificationReadSchedule.holdRead = 0;
  classificationReadSchedule.seen = [];
  classificationReadSchedule.captured = null;
  classificationReadSchedule.entered = null;
  classificationReadSchedule.resume = null;
  admissionFault.operation = null;
  admissionFault.path = null;
  admissionFault.observed = false;
  admissionFault.maskedAncestor = null;
  admissionFault.descendantPath = null;
  admissionFault.descendantShape = null;
  admissionFault.descendantObserved = false;
  admissionFault.descendantError = null;
  deniedSkillRootRead.path = null;
  deniedSkillRootRead.observed = false;
  deniedSkillRootRead.error = null;
  deniedDirectoryRead.path = null;
  deviceContrast.path = null;
  deviceContrast.device = null;
  deviceContrast.inode = null;
  deviceContrast.observed = false;
  memberStatSchedule.path = null;
  memberStatSchedule.entered = null;
  memberStatSchedule.resume = null;
  memberStatSchedule.seen = [];
  forgetNativeSubscriptions();
  _resetDocExtensionsForTests();
  lastKnownHash.clear();
  writeTracker.clear();
  removalTracker.clear();
  contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-parcel-notice-')));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  headBatchSchedule.armed = false;
  headBatchSchedule.hold = null;
  headBatchSchedule.begun = null;
  headBatchSchedule.ended = null;
  admissionFault.operation = null;
  admissionFault.path = null;
  admissionFault.maskedAncestor = null;
  admissionFault.descendantPath = null;
  admissionFault.descendantShape = null;
  admissionFault.descendantError = null;
  deniedSkillRootRead.path = null;
  deniedSkillRootRead.error = null;
  deniedDirectoryRead.path = null;
  deviceContrast.path = null;
  deviceContrast.device = null;
  deviceContrast.inode = null;
  memberStatSchedule.path = null;
  memberStatSchedule.entered = null;
  memberStatSchedule.resume = null;
  memberStatSchedule.seen = [];
  for (const release of releaseLatches.splice(0)) release();
  for (const handle of handles.splice(0)) await handle.unsubscribe();
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(contentDir, { recursive: true, force: true });
  for (const path of cleanupDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function deliver(dir: string, events: Event[], error: Error | null = null): Promise<void> {
  await nativeSubscriptionOn(dir).deliver(events, error);
  await vi.runAllTimersAsync();
}

async function watchContent(
  filter?: ContentFilter,
  onEvent?: (event: DiskEvent) => Promise<void>,
): Promise<{
  watcher: WatcherHandle;
  events: DiskEvent[];
  rawBatches: string[][];
}> {
  const events: DiskEvent[] = [];
  const rawBatches: string[][] = [];
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
      await onEvent?.(event);
    },
    filter,
    {
      forceBackend: 'parcel',
      platform: 'darwin',
      onRawBatch: (paths) => {
        rawBatches.push([...paths]);
      },
    },
  );
  handles.push(watcher);
  return { watcher, events, rawBatches };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releaseLatches.push(release);
  return { promise, release };
}

async function deliverNotice(dir: string, events: Event[] = []): Promise<void> {
  await deliver(dir, events, new Error(notices[0]));
}

function writeDoc(name: string, content: string): string {
  const path = join(contentDir, name);
  writeFileSync(path, content);
  return path;
}

function writeSkillFixture(relativeDir: string, body = '# Fixture\n'): string {
  const path = join(contentDir, relativeDir, 'SKILL.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `---\nname: ${relativeDir.split('/').at(-1)}\ndescription: Fixture\n---\n\n${body}`,
  );
  return path;
}

function dynamicSkillFilter(): ContentFilter {
  return createContentFilter({
    projectDir: contentDir,
    contentDir,
    inPlaceSkillDirs: scanInPlaceSkillDirs(contentDir),
    rescanInPlaceSkillDirs: () => scanInPlaceSkillDirs(contentDir),
    skillRootPaths: skillRootPathsFor(contentDir),
  });
}

function writeSkillLedger(value: unknown): string {
  const path = join(contentDir, '.ok', 'local', 'skill-placements.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

function denyAdmission(
  operation: Exclude<typeof admissionFault.operation, null>,
  path: string,
): void {
  admissionFault.operation = operation;
  admissionFault.path = path;
  admissionFault.observed = false;
}

function clearAdmissionDenial(): void {
  admissionFault.operation = null;
  admissionFault.path = null;
  admissionFault.maskedAncestor = null;
}

function createGitDir(): string {
  const gitDir = join(contentDir, '.git');
  mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(gitDir, 'refs', 'heads', 'main'), `${oldOid}\n`);
  writeFileSync(join(gitDir, 'refs', 'heads', 'feature'), `${newOid}\n`);
  return gitDir;
}

async function watchHead(
  onBegin?: Parameters<typeof startHeadWatcher>[1],
  onEnd?: Parameters<typeof startHeadWatcher>[2],
): Promise<{
  watcher: HeadWatcherHandle;
  begins: unknown[];
  ends: unknown[];
}> {
  const begins: unknown[] = [];
  const ends: unknown[] = [];
  const watcher = await startHeadWatcher(
    contentDir,
    async (info) => {
      begins.push(info);
      await onBegin?.(info);
    },
    async (info) => {
      ends.push(info);
      await onEnd?.(info);
    },
    { forceBackend: 'parcel', platform: 'darwin' },
  );
  handles.push(watcher);
  expect(watcher.getLastKnownBranch()).toBe('main');
  return { watcher, begins, ends };
}

function expectHeadSettled(watched: {
  watcher: HeadWatcherHandle;
  begins: unknown[];
  ends: unknown[];
}): void {
  expect(watched.begins).toHaveLength(1);
  expect(watched.ends).toEqual([
    {
      headMoved: true,
      oldHead: oldOid,
      newHead: newOid,
      timeout: false,
      batchKind: 'cross-branch',
      oldBranch: 'main',
      newBranch: 'feature',
    },
  ]);
  expect(watched.watcher.getLastKnownBranch()).toBe('feature');
}

test('a regular content batch still reaches the disk watcher', async () => {
  const { watcher, events, rawBatches } = await watchContent();
  const path = writeDoc('announced.md', '# Announced\n');
  await deliver(contentDir, [{ type: 'create', path }]);

  expect(events).toContainEqual({
    kind: 'create',
    path,
    docName: 'announced',
    content: '# Announced\n',
  });
  expect(watcher.getFileIndex().has('announced')).toBe(true);
  expect(rawBatches).toContainEqual([path]);
});

test.each(notices)(
  'content notice processes its batch and restores missing disk changes: %s',
  async (notice) => {
    const changed = writeDoc('changed.md', '# Before\n');
    const removed = writeDoc('removed.md', '# Removed\n');
    const { watcher, events, rawBatches } = await watchContent();
    expect([...watcher.getFileIndex().keys()].sort()).toEqual(['changed', 'removed']);

    const announced = writeDoc('announced.md', '# Announced\n');
    const hidden = writeDoc('hidden.md', '# Hidden\n');
    writeFileSync(changed, '# After\n');
    unlinkSync(removed);
    await deliver(contentDir, [{ type: 'create', path: announced }], new Error(notice));

    expect.soft(rawBatches).toContainEqual([announced]);
    expect.soft(events).toContainEqual({
      kind: 'create',
      path: announced,
      docName: 'announced',
      content: '# Announced\n',
    });
    expect.soft(events).toContainEqual({
      kind: 'create',
      path: hidden,
      docName: 'hidden',
      content: '# Hidden\n',
    });
    expect.soft(events).toContainEqual(
      expect.objectContaining({
        kind: 'update',
        path: changed,
        docName: 'changed',
        content: '# After\n',
      }),
    );
    expect.soft(events).toContainEqual({ kind: 'delete', path: removed, docName: 'removed' });
    expect([...watcher.getFileIndex().keys()].sort()).toEqual(['announced', 'changed', 'hidden']);
  },
);

test.each(notices)('empty content notice restores an omitted disk change: %s', async (notice) => {
  const { watcher, events } = await watchContent();
  const hidden = writeDoc('hidden.md', '# Hidden\n');
  await deliver(contentDir, [], new Error(notice));

  expect(events).toContainEqual({
    kind: 'create',
    path: hidden,
    docName: 'hidden',
    content: '# Hidden\n',
  });
  expect(watcher.getFileIndex().has('hidden')).toBe(true);
});

test('a regular HEAD batch settles the disk branch', async () => {
  const gitDir = createGitDir();
  const watched = await watchHead();
  const path = join(gitDir, 'HEAD');
  writeFileSync(path, 'ref: refs/heads/feature\n');
  await deliver(gitDir, [{ type: 'update', path }]);

  expectHeadSettled(watched);
  expect(watched.begins).toEqual([{ trigger: 'HEAD' }]);
});

test('a rejected HEAD unsubscribe still ends the open batch and clears its timers', async () => {
  const gitDir = createGitDir();
  const ends: unknown[] = [];
  const failure = new Error('native unsubscribe failed');
  let dispatchHead: ((rawPath: string) => void) | undefined;
  const watcher = await startHeadWatcher(
    contentDir,
    async () => {},
    async (info) => {
      ends.push(info);
    },
    {
      subscribeForTest: async (_gitDir, dispatch) => {
        dispatchHead = dispatch;
        return async () => {
          throw failure;
        };
      },
    },
  );
  if (!dispatchHead) throw new Error('HEAD dispatch was not registered');
  dispatchHead(join(gitDir, 'HEAD'));
  await vi.advanceTimersByTimeAsync(1);
  expect(ends).toEqual([]);
  expect(vi.getTimerCount()).toBe(2);

  await expect(watcher.unsubscribe()).rejects.toBe(failure);

  expect(ends).toEqual([
    {
      headMoved: false,
      oldHead: oldOid,
      newHead: oldOid,
      timeout: false,
      batchKind: 'within-branch',
      oldBranch: 'main',
      newBranch: 'main',
    },
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(notices)('HEAD notice processes its delivered HEAD event: %s', async (notice) => {
  const gitDir = createGitDir();
  const watched = await watchHead();
  const path = join(gitDir, 'HEAD');
  writeFileSync(path, 'ref: refs/heads/feature\n');
  await deliver(gitDir, [{ type: 'update', path }], new Error(notice));

  expectHeadSettled(watched);
  expect(watched.begins).toEqual([{ trigger: 'HEAD' }]);
});

test.each(notices)(
  'HEAD notice restores a branch change omitted from a nonempty batch: %s',
  async (notice) => {
    const gitDir = createGitDir();
    const watched = await watchHead();
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/feature\n');
    const configPath = join(gitDir, 'config');
    writeFileSync(configPath, '[core]\n');
    await deliver(gitDir, [{ type: 'update', path: configPath }], new Error(notice));

    expectHeadSettled(watched);
  },
);

test.each(notices)('empty HEAD notice restores an omitted branch change: %s', async (notice) => {
  const gitDir = createGitDir();
  const watched = await watchHead();
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/feature\n');
  await deliver(gitDir, [], new Error(notice));

  expectHeadSettled(watched);
});

test('fatal Parcel errors remain observable for both watchers', async () => {
  const diagnostics: Array<{ name: string; err: unknown }> = [];
  for (const name of ['file-watcher', 'head-watcher']) {
    const logger = getLogger(name);
    for (const method of ['error', 'warn'] as const) {
      vi.spyOn(logger, method).mockImplementation((data) => {
        diagnostics.push({ name, err: data.err });
      });
    }
  }

  const { watcher, events, rawBatches } = await watchContent();
  const gitDir = createGitDir();
  const watched = await watchHead();
  const announced = writeDoc('announced.md', '# Announced\n');
  writeDoc('hidden.md', '# Hidden\n');
  const headPath = join(gitDir, 'HEAD');
  writeFileSync(headPath, 'ref: refs/heads/feature\n');
  const fatal = new Error('Failed to read changes');
  await deliver(contentDir, [{ type: 'create', path: announced }], fatal);
  await deliver(gitDir, [{ type: 'update', path: headPath }], fatal);

  for (const name of ['file-watcher', 'head-watcher']) {
    expect(diagnostics).toContainEqual({ name, err: fatal });
  }
  expect(events).toEqual([]);
  expect(rawBatches).toEqual([]);
  expect([...watcher.getFileIndex().keys()]).toEqual([]);
  expect(watched.begins).toEqual([]);
  expect(watched.ends).toEqual([]);
  expect(watched.watcher.getLastKnownBranch()).toBe('main');
});

test('repeated content notices do not repeat effects already applied from a supplied batch and disk scan', async () => {
  const { watcher, events, rawBatches } = await watchContent();
  const announced = writeDoc('announced.md', '# Announced\n');
  writeDoc('hidden.md', '# Hidden\n');
  const general = join(contentDir, 'data.csv');
  writeFileSync(general, 'a,b\n');
  const emptyFolder = join(contentDir, 'empty-folder');
  mkdirSync(emptyFolder);

  await deliverNotice(contentDir, [{ type: 'create', path: announced }]);
  expect
    .soft(events.filter((event) => event.kind === 'create' && event.docName === 'announced'))
    .toHaveLength(1);
  expect
    .soft(events.filter((event) => event.kind === 'create' && event.docName === 'hidden'))
    .toHaveLength(1);
  expect.soft(rawBatches).toContainEqual([announced]);
  expect
    .soft(events)
    .toContainEqual(
      expect.objectContaining({ kind: 'file-create', path: general, relativePath: 'data.csv' }),
    );
  expect
    .soft(events)
    .toContainEqual({ kind: 'folder-create', path: emptyFolder, relativePath: 'empty-folder' });
  expect.soft(indexedRow(watcher, 'data.csv', 'file')?.kind).toBe('file');
  expect.soft(watcher.getFolderIndex().has('empty-folder')).toBe(true);

  const settledEvents = [...events];
  const settledIndex = [...watcher.getFileIndex().keys()].sort();
  await deliverNotice(contentDir);

  expect(events).toEqual(settledEvents);
  expect([...watcher.getFileIndex().keys()].sort()).toEqual(settledIndex);
  expect(watcher.getFileIndex().has('hidden')).toBe(true);
  expect(Boolean(indexedRow(watcher, 'data.csv', 'file'))).toBe(true);
  expect(watcher.getFolderIndex().has('empty-folder')).toBe(true);
});

test('a notice recovers an omitted rename through the established rename event', async () => {
  const oldPath = writeDoc('old-name.md', '# Same Content\n');
  const { watcher, events } = await watchContent();
  const newPath = join(contentDir, 'new-name.md');
  renameSync(oldPath, newPath);

  await deliverNotice(contentDir);

  expect(events).toContainEqual({
    kind: 'rename',
    oldPath,
    newPath,
    oldDocName: 'old-name',
    newDocName: 'new-name',
    content: '# Same Content\n',
  });
  expect([...watcher.getFileIndex().keys()]).toEqual(['new-name']);
});

test('a notice recovers conflict-marked bytes as a conflict event', async () => {
  const path = writeDoc('conflicted.md', '# Before\n');
  const { watcher, events } = await watchContent();
  const conflict = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';
  writeFileSync(path, conflict);

  await deliverNotice(contentDir);

  expect(events).toContainEqual({
    kind: 'conflict',
    path,
    docName: 'conflicted',
    content: conflict,
  });
  expect(events.some((event) => event.kind === 'update' && event.docName === 'conflicted')).toBe(
    false,
  );
  expect(watcher.getFileIndex().has('conflicted')).toBe(true);
});

test('notice recovery keeps self-write and self-removal suppression while applying an external sibling', async () => {
  const ownPath = writeDoc('own.md', '# Before\n');
  const removedPath = writeDoc('removed.md', '# Removed\n');
  const { watcher, events } = await watchContent();
  const ownContent = '# After\n';
  writeFileSync(ownPath, ownContent);
  registerWrite(ownPath, contentHash(ownContent));
  registerRemoval(removedPath);
  unlinkSync(removedPath);
  const externalPath = writeDoc('external.md', '# External\n');

  await deliverNotice(contentDir);

  expect.soft(events).toContainEqual({
    kind: 'create',
    path: externalPath,
    docName: 'external',
    content: '# External\n',
  });
  expect(
    events.some((event) => 'docName' in event && ['own', 'removed'].includes(event.docName)),
  ).toBe(false);
  expect(watcher.getFileIndex().get('own')?.title).toBe('After');
  expect(watcher.getFileIndex().has('removed')).toBe(false);
  expect(lastKnownHash.get(ownPath)).toBe(contentHash(ownContent));
  expect(lastKnownHash.has(removedPath)).toBe(false);
});

test('notice recovery respects markdown, general-file and directory filters while admitting a sibling asset', async () => {
  writeFileSync(join(contentDir, '.okignore'), 'ignored.md\nignored.csv\ndist/\n');
  const filter = createContentFilter({ projectDir: contentDir, contentDir });
  const { watcher, events } = await watchContent(filter);
  const freshDir = join(contentDir, 'fresh');
  mkdirSync(freshDir);
  const notePath = join(freshDir, 'note.md');
  const assetPath = join(freshDir, 'pic.png');
  writeFileSync(notePath, '# Note\n');
  writeFileSync(assetPath, 'fake-png-bytes');
  writeDoc('ignored.md', '# Ignored\n');
  writeFileSync(join(contentDir, 'ignored.csv'), 'ignore,me\n');
  mkdirSync(join(contentDir, 'dist'));
  writeFileSync(join(contentDir, 'dist', 'hidden.md'), '# Hidden\n');

  await deliverNotice(contentDir);

  expect
    .soft(events)
    .toContainEqual({ kind: 'create', path: notePath, docName: 'fresh/note', content: '# Note\n' });
  expect
    .soft(events)
    .toContainEqual({ kind: 'asset-create', path: assetPath, relativePath: 'fresh/pic.png' });
  expect(watcher.getFileIndex().has('fresh/note')).toBe(true);
  expect(Boolean(indexedRow(watcher, 'fresh/pic.png', 'file'))).toBe(true);
  expect(watcher.getFileIndex().has('ignored')).toBe(false);
  expect(Boolean(indexedRow(watcher, 'ignored.csv', 'file'))).toBe(false);
  expect(watcher.getFolderIndex().has('dist')).toBe(false);
  expect(watcher.getFileIndex().has('dist/hidden')).toBe(false);
  expect(
    events.some(
      (event) =>
        'path' in event && (event.path.includes('ignored') || event.path.includes('/dist/')),
    ),
  ).toBe(false);
  const noteIndex = events.findIndex(
    (event) => event.kind === 'create' && event.docName === 'fresh/note',
  );
  const assetIndex = events.findIndex(
    (event) => event.kind === 'asset-create' && event.relativePath === 'fresh/pic.png',
  );
  expect(noteIndex).toBeLessThan(assetIndex);
  expect(filter.isExcluded('fresh/pic.png')).toBe(false);
});

test('notice recovery without a filter still admits ordinary markdown and general files', async () => {
  const { watcher, events } = await watchContent();
  const regular = writeDoc('regular.md', '# Regular\n');
  await deliver(contentDir, [{ type: 'create', path: regular }]);
  expect(events).toContainEqual({
    kind: 'create',
    path: regular,
    docName: 'regular',
    content: '# Regular\n',
  });

  const general = join(contentDir, 'ordinary.csv');
  writeFileSync(general, 'a,b\n');
  await deliverNotice(contentDir);

  expect(events).toContainEqual(
    expect.objectContaining({ kind: 'file-create', path: general, relativePath: 'ordinary.csv' }),
  );
  expect(indexedRow(watcher, 'ordinary.csv', 'file')?.kind).toBe('file');
});

test('notice recovery refreshes in-place bundle admission and notifies raw observers of unchanged and removed paths', async () => {
  const filter = createContentFilter({
    projectDir: contentDir,
    contentDir,
    inPlaceSkillDirs: scanInPlaceSkillDirs(contentDir),
    rescanInPlaceSkillDirs: () => scanInPlaceSkillDirs(contentDir),
    skillRootPaths: skillRootPathsFor(contentDir),
  });
  const { watcher, events, rawBatches } = await watchContent(filter);
  const bundleDir = join(contentDir, '.claude', 'skills', 'fresh-fixture');
  mkdirSync(bundleDir, { recursive: true });
  const skillPath = join(bundleDir, 'SKILL.md');
  const skillContent = '---\nname: fresh-fixture\ndescription: fixture\n---\n\n# Fresh fixture\n';
  writeFileSync(skillPath, skillContent);
  const hostPath = join(contentDir, '.claude', 'plugins', 'settings.md');
  mkdirSync(join(contentDir, '.claude', 'plugins'), { recursive: true });
  writeFileSync(hostPath, '# Host settings\n');
  expect(filter.isExcluded('.claude/skills/fresh-fixture/SKILL.md')).toBe(true);

  await deliverNotice(contentDir);

  expect.soft(events).toContainEqual({
    kind: 'create',
    path: skillPath,
    docName: '.claude/skills/fresh-fixture/SKILL',
    content: skillContent,
  });
  expect.soft(watcher.getFileIndex().has('.claude/skills/fresh-fixture/SKILL')).toBe(true);
  expect.soft(rawBatches[0]).toEqual([]);
  expect.soft(rawBatches.slice(1).some((paths) => paths.includes(skillPath))).toBe(true);
  expect(watcher.getFileIndex().has('.claude/plugins/settings')).toBe(false);
  expect(filter.isExcluded('.claude/plugins/settings.md')).toBe(true);

  const settledEvents = [...events];
  const beforeUnchanged = rawBatches.length;
  await deliverNotice(contentDir);
  expect(events).toEqual(settledEvents);
  expect
    .soft(rawBatches.slice(beforeUnchanged).some((paths) => paths.includes(skillPath)))
    .toBe(true);

  rmSync(bundleDir, { recursive: true, force: true });
  const beforeRemoval = rawBatches.length;
  await deliverNotice(contentDir);
  expect.soft(watcher.getFileIndex().has('.claude/skills/fresh-fixture/SKILL')).toBe(false);
  expect.soft(watcher.getFolderIndex().has('.claude/skills/fresh-fixture')).toBe(false);
  expect(rawBatches.slice(beforeRemoval).some((paths) => paths.includes(skillPath))).toBe(true);
  expect(watcher.getFileIndex().has('.claude/plugins/settings')).toBe(false);
});

test.each([
  { factory: 'sync', surface: 'notice' },
  { factory: 'sync', surface: 'normal rebuild' },
  { factory: 'async', surface: 'notice' },
  { factory: 'async', surface: 'normal rebuild' },
] as const)(
  '$factory admission keeps a known skill when its root cannot be read during $surface',
  async ({ factory, surface }) => {
    const skillDir = '.claude/skills/fixture';
    const docName = `${skillDir}/SKILL`;
    const skillPath = join(contentDir, skillDir, 'SKILL.md');
    const skillRoot = join(contentDir, '.claude', 'skills');
    const before = '---\nname: fixture\ndescription: Fixture\n---\n\n# Before\n';
    const after = '---\nname: fixture\ndescription: Fixture\n---\n\n# After\n';
    mkdirSync(join(contentDir, skillDir), { recursive: true });
    writeFileSync(skillPath, before);

    const options: ContentFilterOptions = {
      projectDir: contentDir,
      contentDir,
      inPlaceSkillDirs: scanInPlaceSkillDirs(contentDir),
      rescanInPlaceSkillDirs: () => scanInPlaceSkillDirs(contentDir),
      skillRootPaths: skillRootPathsFor(contentDir),
    };
    const filter =
      factory === 'sync' ? createContentFilter(options) : await createContentFilterAsync(options);
    const { watcher, events } = await watchContent(filter);
    const knownFolders = ['.claude', '.claude/skills', skillDir];
    expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
    expect(watcher.getFileIndex().has(docName)).toBe(true);
    for (const folder of knownFolders) expect(watcher.getFolderIndex().has(folder)).toBe(true);

    const warningErrors: unknown[] = [];
    const logger = getLogger('content-filter');
    const originalWarn = logger.warn.bind(logger);
    vi.spyOn(logger, 'warn').mockImplementation((data, message) => {
      warningErrors.push(data.err);
      originalWarn(data, message);
    });
    const priorFingerprint = filter.inPlaceSkillDirsFingerprint();
    const failure = Object.assign(new Error('skill root read denied'), { code: 'EACCES' });
    deniedSkillRootRead.path = skillRoot;
    deniedSkillRootRead.observed = false;
    deniedSkillRootRead.error = failure;
    try {
      expect.soft(filter.peekFreshInPlaceSkillDirsFingerprint()).toBe(priorFingerprint);
      expect(filter.inPlaceSkillDirsFingerprint()).toBe(priorFingerprint);
      if (surface === 'notice') {
        await deliverNotice(contentDir);
      } else {
        await filter.rebuildIgnorePatterns();
        const pruned = await reconcileFileIndexAfterFilterRebuild(watcher);
        expect.soft(pruned).toEqual({ prunedFiles: 0, prunedFolders: 0 });
      }
    } finally {
      deniedSkillRootRead.path = null;
    }

    expect(deniedSkillRootRead.observed).toBe(true);
    expect.soft(warningErrors).toContain(failure);
    expect.soft(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
    expect.soft(watcher.getFileIndex().has(docName)).toBe(true);
    for (const folder of knownFolders) {
      expect.soft(watcher.getFolderIndex().has(folder)).toBe(true);
    }
    expect
      .soft(
        events.some(
          (event) =>
            (event.kind === 'delete' && event.docName === docName) ||
            (event.kind === 'folder-delete' && knownFolders.includes(event.relativePath)),
        ),
      )
      .toBe(false);

    expect(readFileSync(skillPath, 'utf8')).toBe(before);
    writeFileSync(skillPath, after);
    if (surface === 'notice') {
      await deliverNotice(contentDir);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'update',
          path: skillPath,
          docName,
          content: after,
        }),
      );
    } else {
      await filter.rebuildIgnorePatterns();
      await reconcileFileIndexAfterFilterRebuild(watcher);
    }
    expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
    expect(watcher.getFileIndex().has(docName)).toBe(true);
    expect(watcher.getFileIndex().get(docName)?.title).toBe('After');
    for (const folder of knownFolders) expect(watcher.getFolderIndex().has(folder)).toBe(true);

    const laterDir = '.claude/skills/later';
    writeSkillFixture(laterDir);
    const currentFingerprint = filter.inPlaceSkillDirsFingerprint();
    expect(filter.peekFreshInPlaceSkillDirsFingerprint()).toContain(laterDir);
    expect(filter.inPlaceSkillDirsFingerprint()).toBe(currentFingerprint);
    filter.refreshInPlaceSkillDirs();
    expect(filter.isExcluded(`${laterDir}/SKILL.md`)).toBe(false);
  },
);

test('an unreadable skill-root ancestor cannot masquerade as a missing root', async () => {
  const skillDir = '.claude/skills/fixture';
  const path = writeSkillFixture(skillDir);
  const filter = dynamicSkillFilter();
  const { watcher, events } = await watchContent(filter);
  const root = join(contentDir, '.claude', 'skills');
  expect(watcher.getFileIndex().has(`${skillDir}/SKILL`)).toBe(true);

  admissionFault.maskedAncestor = root;
  admissionFault.observed = false;
  try {
    expect(existsSync(root)).toBe(false);
    expect(() => statSync(root)).toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect(() => realpathSync(root)).toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect(() => readdirSync(root)).toThrow(expect.objectContaining({ code: 'EACCES' }));
    filter.refreshInPlaceSkillDirs();
    expect(admissionFault.observed).toBe(true);
    expect.soft(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
    expect.soft(watcher.getFileIndex().has(`${skillDir}/SKILL`)).toBe(true);
    expect.soft(watcher.getFolderIndex().has(skillDir)).toBe(true);
    expect(events).toEqual([]);
  } finally {
    clearAdmissionDenial();
  }

  expect(readFileSync(path, 'utf8')).toContain('# Fixture');
  filter.refreshInPlaceSkillDirs();
  expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
});

test.each(['missing', 'empty', 'non-directory'] as const)(
  'a $0 skill root is a complete empty inventory',
  (shape) => {
    const root = join(contentDir, '.claude', 'skills');
    if (shape === 'empty') mkdirSync(root, { recursive: true });
    if (shape === 'non-directory') {
      mkdirSync(dirname(root), { recursive: true });
      writeFileSync(root, 'not a directory');
    }
    expect([...scanInPlaceSkillDirs(contentDir)]).toEqual([]);
    expect(scanInPlaceSkills(contentDir)).toEqual([]);
  },
);

test.each(['missing manifest', 'non-file manifest', 'removed bundle'] as const)(
  '$0 is ordinary non-admission',
  (shape) => {
    const skillDir = '.claude/skills/fixture';
    const bundle = join(contentDir, skillDir);
    if (shape === 'removed bundle') {
      writeSkillFixture(skillDir);
      expect([...scanInPlaceSkillDirs(contentDir)]).toEqual([skillDir]);
      rmSync(bundle, { recursive: true, force: true });
    } else {
      mkdirSync(bundle, { recursive: true });
      if (shape === 'non-file manifest') mkdirSync(join(bundle, 'SKILL.md'));
    }
    expect([...scanInPlaceSkillDirs(contentDir)]).toEqual([]);
  },
);

test('a manifest directory link withdraws admission and a file link restores it', () => {
  const skillDir = '.claude/skills/fixture';
  const manifest = writeSkillFixture(skillDir);
  const manifestBytes = readFileSync(manifest, 'utf8');
  const filter = dynamicSkillFilter();
  expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);

  const directoryTarget = join(contentDir, 'manifest-directory');
  mkdirSync(directoryTarget);
  unlinkSync(manifest);
  symlinkSync(directoryTarget, manifest);
  expect(statSync(manifest).isDirectory()).toBe(true);
  expect(scanInPlaceSkills(contentDir)).toEqual([]);
  filter.refreshInPlaceSkillDirs();
  expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(true);
  expect(filter.inPlaceSkillDirsFingerprint()).toBe('');

  const fileTarget = join(contentDir, 'linked-manifest.md');
  writeFileSync(fileTarget, manifestBytes);
  unlinkSync(manifest);
  symlinkSync(fileTarget, manifest);
  expect(statSync(manifest).isFile()).toBe(true);
  expect([...scanInPlaceSkillDirs(contentDir)]).toEqual([skillDir]);
  filter.refreshInPlaceSkillDirs();
  expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
  expect(filter.inPlaceSkillDirsFingerprint()).toBe(skillDir);
});

test('a case-mismatched manifest directory withdraws admission until restoration', () => {
  const skillDir = '.claude/skills/fixture';
  const manifest = writeSkillFixture(skillDir);
  const manifestBytes = readFileSync(manifest, 'utf8');
  const filter = dynamicSkillFilter();
  expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);

  unlinkSync(manifest);
  const alternateCase = join(dirname(manifest), 'skill.md');
  mkdirSync(alternateCase);
  expect(readdirSync(dirname(manifest))).toContain('skill.md');
  expect(scanInPlaceSkills(contentDir)).toEqual([]);
  filter.refreshInPlaceSkillDirs();
  expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(true);
  expect(filter.inPlaceSkillDirsFingerprint()).toBe('');

  rmSync(alternateCase, { recursive: true, force: true });
  writeFileSync(manifest, manifestBytes);
  expect([...scanInPlaceSkillDirs(contentDir)]).toEqual([skillDir]);
  filter.refreshInPlaceSkillDirs();
  expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
  expect(filter.inPlaceSkillDirsFingerprint()).toBe(skillDir);
});

test('an unreadable skill root does not replace a complete nonempty admission with its readable remainder', async () => {
  const deniedDir = '.claude/skills/denied-fixture';
  const readableDir = '.codex/skills/readable-fixture';
  writeSkillFixture(deniedDir);
  writeSkillFixture(readableDir);
  const filter = dynamicSkillFilter();
  const before = [...scanInPlaceSkillDirs(contentDir)].sort();
  expect(before).toEqual([deniedDir, readableDir].sort());
  const deniedRoot = join(contentDir, '.claude', 'skills');

  denyAdmission('readdir', deniedRoot);
  try {
    expect(scanInPlaceSkills(contentDir).map((skill) => skill.dir)).toEqual([readableDir]);
    expect(scanGlobalInPlaceSkills(contentDir).map((skill) => skill.dir)).toEqual([readableDir]);
    filter.refreshInPlaceSkillDirs();
    expect(admissionFault.observed).toBe(true);
    expect.soft(filter.isExcluded(`${deniedDir}/SKILL.md`)).toBe(false);
    expect.soft(filter.isExcluded(`${readableDir}/SKILL.md`)).toBe(false);
    expect.soft(filter.inPlaceSkillDirsFingerprint()).toBe(before.join('\n'));
  } finally {
    clearAdmissionDenial();
  }

  const laterDir = '.claude/skills/later-fixture';
  writeSkillFixture(laterDir);
  filter.refreshInPlaceSkillDirs();
  expect(filter.isExcluded(`${deniedDir}/SKILL.md`)).toBe(false);
  expect(filter.isExcluded(`${laterDir}/SKILL.md`)).toBe(false);
  expect(filter.isExcluded(`${readableDir}/SKILL.md`)).toBe(false);
});

test.each([
  { fault: 'candidate stat', operation: 'stat', target: 'bundle' },
  { fault: 'candidate lstat', operation: 'lstat', target: 'bundle' },
  { fault: 'bundle listing', operation: 'readdir', target: 'bundle' },
  { fault: 'nested reference listing', operation: 'readdir', target: 'references' },
  { fault: 'manifest stat', operation: 'stat', target: 'manifest' },
  { fault: 'changed manifest read', operation: 'read', target: 'manifest' },
  { fault: 'changed reference read', operation: 'read', target: 'reference' },
] as const)('$fault cannot withdraw an admitted skill', ({ operation, target }) => {
  const skillDir = '.claude/skills/fixture';
  const manifest = writeSkillFixture(skillDir);
  const bundle = dirname(manifest);
  const references = join(bundle, 'references');
  mkdirSync(references);
  const reference = join(references, 'context.md');
  writeFileSync(reference, '# Before reference\n');
  const beforeCatalog = scanInPlaceSkills(contentDir);
  expect(beforeCatalog.map((skill) => skill.dir)).toEqual([skillDir]);
  const filter = dynamicSkillFilter();

  if (target === 'manifest')
    writeFileSync(manifest, `${readFileSync(manifest, 'utf8')}# Changed manifest bytes\n`);
  if (target === 'reference') writeFileSync(reference, '# Changed reference with more bytes\n');
  const path = {
    bundle,
    references,
    manifest,
    reference,
  }[target];
  denyAdmission(operation, path);
  try {
    filter.refreshInPlaceSkillDirs();
    expect(admissionFault.observed).toBe(true);
    expect.soft(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
    expect.soft(filter.inPlaceSkillDirsFingerprint()).toBe(skillDir);
  } finally {
    clearAdmissionDenial();
  }

  filter.refreshInPlaceSkillDirs();
  expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
  expect(scanInPlaceSkills(contentDir).map((skill) => skill.dir)).toEqual([skillDir]);
  if (target === 'manifest' || target === 'reference') {
    expect(scanInPlaceSkills(contentDir)[0].contentHash).not.toBe(beforeCatalog[0].contentHash);
  }
});

test.each(['missing', 'directory'] as const)(
  'a reference becoming %s during its real read retains the known skill',
  (shape) => {
    const skillDir = '.claude/skills/fixture';
    const manifest = writeSkillFixture(skillDir);
    const references = join(dirname(manifest), 'references');
    mkdirSync(references);
    const reference = join(references, 'context.md');
    writeFileSync(reference, '# Reference\n');
    const filter = dynamicSkillFilter();
    const priorFingerprint = filter.inPlaceSkillDirsFingerprint();
    expect(priorFingerprint).toBe(skillDir);
    writeFileSync(manifest, `${readFileSync(manifest, 'utf8')}# Changed manifest bytes\n`);

    admissionFault.descendantPath = reference;
    admissionFault.descendantShape = shape;
    try {
      filter.refreshInPlaceSkillDirs();
      expect(admissionFault.descendantObserved).toBe(true);
      expect(admissionFault.descendantError?.code).toBe(shape === 'missing' ? 'ENOENT' : 'EISDIR');
      expect.soft(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
      expect.soft(filter.inPlaceSkillDirsFingerprint()).toBe(priorFingerprint);
    } finally {
      admissionFault.descendantPath = null;
    }

    expect(readFileSync(manifest, 'utf8')).toContain('# Changed manifest bytes');
    expect([...scanInPlaceSkillDirs(contentDir)]).toEqual([skillDir]);
    filter.refreshInPlaceSkillDirs();
    expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
  },
);

test.each([
  { fault: 'ledger read denied' },
  { fault: 'ledger ancestor hidden' },
  { fault: 'ledger invalid JSON' },
  { fault: 'configured path resolution denied' },
] as const)('$fault cannot withdraw an admitted custom root', ({ fault }) => {
  const skillDir = 'extra/skills/fixture';
  const manifest = writeSkillFixture(skillDir);
  const validLedger = JSON.stringify({ schema: 1, skills: {}, roots: ['extra/skills'] });
  const ledger = writeSkillLedger(validLedger);
  const filter = dynamicSkillFilter();
  expect([...scanInPlaceSkillDirs(contentDir)]).toEqual([skillDir]);
  expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);

  if (fault === 'ledger read denied') denyAdmission('read', ledger);
  if (fault === 'ledger ancestor hidden') admissionFault.maskedAncestor = ledger;
  if (fault === 'configured path resolution denied') denyAdmission('realpath', contentDir);
  if (fault === 'ledger invalid JSON') writeFileSync(ledger, '{ invalid JSON');
  try {
    if (fault === 'ledger ancestor hidden') {
      expect(existsSync(ledger)).toBe(false);
      expect(() => readFileSync(ledger, 'utf8')).toThrow(
        expect.objectContaining({ code: 'EACCES' }),
      );
    }
    if (fault === 'ledger read denied' || fault === 'ledger invalid JSON') {
      expect(readSkillPlacementsStore(contentDir).roots).toBeUndefined();
    }
    filter.refreshInPlaceSkillDirs();
    if (fault !== 'ledger invalid JSON') expect(admissionFault.observed).toBe(true);
    expect.soft(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
    expect.soft(filter.inPlaceSkillDirsFingerprint()).toBe(skillDir);
  } finally {
    clearAdmissionDenial();
  }

  expect(readFileSync(manifest, 'utf8')).toContain('# Fixture');
  expect(readFileSync(ledger, 'utf8')).toBe(
    fault === 'ledger invalid JSON' ? '{ invalid JSON' : validLedger,
  );
  writeFileSync(ledger, validLedger);
  const laterDir = 'extra/skills/later';
  writeSkillFixture(laterDir);
  filter.refreshInPlaceSkillDirs();
  expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
  expect(filter.isExcluded(`${laterDir}/SKILL.md`)).toBe(false);
});

const customRootSkillDir = 'extra/skills/fixture';
const standardCopyOfCustomRootSkillDir = '.claude/skills/fixture';
const refreshedStandardSkillDir = '.claude/skills/refresh-fixture';
const rawStandardSkillDir = '.claude/skills/raw-fixture';
const duplicateSkillName = 'duplicate';
const defaultDuplicateSkillDir = `.agents/skills/${duplicateSkillName}`;
const preferredDuplicateSkillDir = `.claude/skills/${duplicateSkillName}`;
const cursorDuplicateSkillDir = `.cursor/skills/${duplicateSkillName}`;
const unreadableForkSkillDir = '.claude/skills/fork';
const readableForkSkillDir = '.codex/skills/fork';

function fingerprintOf(...dirs: string[]): string {
  return [...dirs].sort().join('\n');
}

function prepareSkillServerProject(ledgerValue: unknown): { home: string; ledger: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-admission-home-')));
  cleanupDirs.push(home);
  const ledger = writeSkillLedger(ledgerValue);
  writeFileSync(join(contentDir, '.ok', 'config.yml'), '');
  writeFileSync(join(contentDir, '.ok', '.gitignore'), '');
  const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: contentDir,
    env: gitEnv,
  });
  configureTestGitRepository(contentDir);
  return { home, ledger };
}

function writeReferencedSkillFixture(relativeDir: string): string {
  const manifest = writeSkillFixture(relativeDir);
  const references = join(dirname(manifest), 'references');
  mkdirSync(references);
  writeFileSync(join(references, 'context.md'), '# Reference\n');
  return references;
}

function prepareCustomRootSkillProject(): { home: string; ledger: string; references: string } {
  const references = writeReferencedSkillFixture(customRootSkillDir);
  const project = prepareSkillServerProject({ schema: 1, skills: {}, roots: ['extra/skills'] });
  return { ...project, references };
}

function preparePreferredDuplicateSkillProject(): { home: string; ledger: string } {
  writeSkillFixture(defaultDuplicateSkillDir);
  writeSkillFixture(preferredDuplicateSkillDir);
  expect(readFileSync(join(contentDir, preferredDuplicateSkillDir, 'SKILL.md'), 'utf8')).toBe(
    readFileSync(join(contentDir, defaultDuplicateSkillDir, 'SKILL.md'), 'utf8'),
  );
  expect([...scanInPlaceSkillDirs(contentDir)]).toEqual([defaultDuplicateSkillDir]);
  return prepareSkillServerProject({
    schema: 1,
    skills: {},
    sources: { [duplicateSkillName]: 'claude' },
  });
}

function startSkillServer(home: string): ServerInstance {
  return createServer({
    contentDir,
    projectDir: contentDir,
    configHomedirOverride: home,
    quiet: true,
    port: 0,
    gitEnabled: false,
  });
}

async function startOpenPollingClockInput(): Promise<() => Promise<void>> {
  return startPolledPathWatcher({
    listPaths: async () => [],
    onEvent: () => {},
    onError: () => {},
  });
}

async function deliverRawSkillEvents(server: ServerInstance, events: Event[]): Promise<void> {
  const copies = vi.spyOn(skillPlacements, 'resyncRecordedSkillCopies');
  const rebuilds = vi.spyOn(server.contentFilter, 'rebuildIgnorePatterns');
  try {
    await nativeSubscriptionOn(contentDir).deliver(events);
    const refresh = await vi.waitUntil(() =>
      copies.mock.results.find((result, index) => {
        const [projectDir, root, override] = copies.mock.calls[index];
        return (
          result.type === 'return' &&
          projectDir === contentDir &&
          root === contentDir &&
          override === undefined
        );
      }),
    );
    await Promise.allSettled([refresh.value, ...rebuilds.mock.results.map(({ value }) => value)]);
  } finally {
    copies.mockRestore();
    rebuilds.mockRestore();
  }
}

async function deliverRawSkillCreate(server: ServerInstance, path: string): Promise<void> {
  await deliverRawSkillEvents(server, [{ type: 'create', path }]);
}

test.each([{ fault: 'ledger invalid JSON' }, { fault: 'bundle subdirectory unreadable' }] as const)(
  '$fault keeps the admitted custom root while server refreshes admit new standard-root skills',
  async ({ fault }) => {
    vi.useRealTimers();
    const { home, ledger, references } = prepareCustomRootSkillProject();
    let server: ServerInstance | undefined;
    let stopPolling: (() => Promise<void>) | undefined;
    try {
      server = startSkillServer(home);
      await server.ready;
      const filter = server.contentFilter;
      expect(filter.inPlaceSkillDirsFingerprint()).toBe(customRootSkillDir);
      expect(filter.isExcluded(`${customRootSkillDir}/SKILL.md`)).toBe(false);

      if (fault === 'ledger invalid JSON') {
        writeFileSync(ledger, '{ invalid JSON');
        expect(readSkillPlacementsStore(contentDir).roots).toBeUndefined();
      } else {
        denyAdmission('readdir', references);
      }

      writeSkillFixture(refreshedStandardSkillDir);
      expect(filter.isExcluded(`${refreshedStandardSkillDir}/SKILL.md`)).toBe(true);
      filter.refreshInPlaceSkillDirs();
      if (fault !== 'ledger invalid JSON') expect(admissionFault.observed).toBe(true);
      expect.soft(filter.isExcluded(`${customRootSkillDir}/SKILL.md`)).toBe(false);
      expect.soft(filter.isExcluded(`${refreshedStandardSkillDir}/SKILL.md`)).toBe(false);

      admissionFault.observed = false;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      stopPolling = await startOpenPollingClockInput();
      await expect(
        deliverRawSkillCreate(server, writeSkillFixture(rawStandardSkillDir)),
      ).resolves.toBeUndefined();
      if (fault !== 'ledger invalid JSON') expect(admissionFault.observed).toBe(true);
      expect.soft(filter.isExcluded(`${customRootSkillDir}/SKILL.md`)).toBe(false);
      expect.soft(filter.isExcluded(`${rawStandardSkillDir}/SKILL.md`)).toBe(false);
      expect(filter.inPlaceSkillDirsFingerprint()).toBe(
        [customRootSkillDir, refreshedStandardSkillDir, rawStandardSkillDir].sort().join('\n'),
      );
    } finally {
      clearAdmissionDenial();
      await stopPolling?.();
      vi.useRealTimers();
      await server?.destroy();
    }
  },
);

test.each([
  { factory: 'sync', surface: 'refresh' },
  { factory: 'sync', surface: 'fingerprint peek' },
  { factory: 'sync', surface: 'rebuild' },
  { factory: 'async', surface: 'refresh' },
  { factory: 'async', surface: 'fingerprint peek' },
  { factory: 'async', surface: 'rebuild' },
] as const)(
  'an invalid-JSON ledger keeps the admitted custom root while $surface on the $factory filter admits a new standard-root skill',
  async ({ factory, surface }) => {
    const { ledger } = prepareCustomRootSkillProject();
    const options: ContentFilterOptions = {
      projectDir: contentDir,
      contentDir,
      inPlaceSkillDirs: scanInPlaceSkillDirs(contentDir),
      rescanInPlaceSkillDirs: (priorAdmission) => scanInPlaceSkillDirs(contentDir, priorAdmission),
      skillRootPaths: skillRootPathsFor(contentDir),
    };
    const filter =
      factory === 'sync' ? createContentFilter(options) : await createContentFilterAsync(options);
    expect(filter.inPlaceSkillDirsFingerprint()).toBe(customRootSkillDir);
    expect(filter.isExcluded(`${customRootSkillDir}/SKILL.md`)).toBe(false);

    writeFileSync(ledger, '{ invalid JSON');
    expect(readSkillPlacementsStore(contentDir).roots).toBeUndefined();
    writeSkillFixture(refreshedStandardSkillDir);
    expect(filter.isExcluded(`${refreshedStandardSkillDir}/SKILL.md`)).toBe(true);

    const refreshedAdmission = fingerprintOf(customRootSkillDir, refreshedStandardSkillDir);
    if (surface === 'fingerprint peek') {
      expect(filter.peekFreshInPlaceSkillDirsFingerprint()).toBe(refreshedAdmission);
    } else {
      if (surface === 'refresh') {
        filter.refreshInPlaceSkillDirs();
      } else {
        expect.soft(await filter.rebuildIgnorePatterns()).toMatchObject({ ok: true });
      }
      expect.soft(filter.isExcluded(`${customRootSkillDir}/SKILL.md`)).toBe(false);
      expect.soft(filter.isExcluded(`${refreshedStandardSkillDir}/SKILL.md`)).toBe(false);
      expect(filter.inPlaceSkillDirsFingerprint()).toBe(refreshedAdmission);
    }
  },
);

test('a denied ledger read keeps the prior admission until server refreshes can read it', async () => {
  vi.useRealTimers();
  const { home, ledger } = prepareCustomRootSkillProject();
  let server: ServerInstance | undefined;
  let stopPolling: (() => Promise<void>) | undefined;
  try {
    server = startSkillServer(home);
    await server.ready;
    const filter = server.contentFilter;
    expect(filter.inPlaceSkillDirsFingerprint()).toBe(customRootSkillDir);

    denyAdmission('read', ledger);
    writeSkillFixture(refreshedStandardSkillDir);
    filter.refreshInPlaceSkillDirs();
    expect(admissionFault.observed).toBe(true);
    expect.soft(filter.isExcluded(`${customRootSkillDir}/SKILL.md`)).toBe(false);
    expect.soft(filter.inPlaceSkillDirsFingerprint()).toBe(customRootSkillDir);

    admissionFault.observed = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stopPolling = await startOpenPollingClockInput();
    const rawPath = writeSkillFixture(rawStandardSkillDir);
    await expect(deliverRawSkillCreate(server, rawPath)).resolves.toBeUndefined();
    expect(admissionFault.observed).toBe(true);
    expect.soft(filter.isExcluded(`${customRootSkillDir}/SKILL.md`)).toBe(false);
    expect.soft(filter.inPlaceSkillDirsFingerprint()).toBe(customRootSkillDir);

    clearAdmissionDenial();
    await expect(deliverRawSkillCreate(server, rawPath)).resolves.toBeUndefined();
    expect(filter.inPlaceSkillDirsFingerprint()).toBe(
      [customRootSkillDir, refreshedStandardSkillDir, rawStandardSkillDir].sort().join('\n'),
    );
  } finally {
    clearAdmissionDenial();
    await stopPolling?.();
    vi.useRealTimers();
    await server?.destroy();
  }
});

test('an invalid-JSON ledger keeps the preferred copy of a duplicate skill while server refreshes admit new standard-root skills', async () => {
  vi.useRealTimers();
  const { home, ledger } = preparePreferredDuplicateSkillProject();
  let server: ServerInstance | undefined;
  let stopPolling: (() => Promise<void>) | undefined;
  try {
    server = startSkillServer(home);
    await server.ready;
    const filter = server.contentFilter;
    expect(filter.inPlaceSkillDirsFingerprint()).toBe(preferredDuplicateSkillDir);
    expect(filter.isExcluded(`${defaultDuplicateSkillDir}/SKILL.md`)).toBe(true);

    writeFileSync(ledger, '{ invalid JSON');
    expect(readSkillPlacementsStore(contentDir).sources).toBeUndefined();
    writeSkillFixture(refreshedStandardSkillDir);
    expect(filter.isExcluded(`${refreshedStandardSkillDir}/SKILL.md`)).toBe(true);
    filter.refreshInPlaceSkillDirs();
    expect.soft(filter.isExcluded(`${preferredDuplicateSkillDir}/SKILL.md`)).toBe(false);
    expect.soft(filter.isExcluded(`${defaultDuplicateSkillDir}/SKILL.md`)).toBe(true);
    expect
      .soft(filter.inPlaceSkillDirsFingerprint())
      .toBe(fingerprintOf(preferredDuplicateSkillDir, refreshedStandardSkillDir));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stopPolling = await startOpenPollingClockInput();
    await expect(
      deliverRawSkillCreate(server, writeSkillFixture(rawStandardSkillDir)),
    ).resolves.toBeUndefined();
    expect.soft(filter.isExcluded(`${defaultDuplicateSkillDir}/SKILL.md`)).toBe(true);
    expect(filter.inPlaceSkillDirsFingerprint()).toBe(
      fingerprintOf(preferredDuplicateSkillDir, refreshedStandardSkillDir, rawStandardSkillDir),
    );
  } finally {
    await stopPolling?.();
    vi.useRealTimers();
    await server?.destroy();
  }
});

test.each([
  { remaining: 'one copy', extraCopies: [] },
  { remaining: 'two copies', extraCopies: [cursorDuplicateSkillDir] },
] as const)(
  'an invalid-JSON ledger does not retain a preferred duplicate copy that left the disk with $remaining still present',
  async ({ extraCopies }) => {
    vi.useRealTimers();
    const { home, ledger } = preparePreferredDuplicateSkillProject();
    for (const dir of extraCopies) writeSkillFixture(dir);
    let server: ServerInstance | undefined;
    let stopPolling: (() => Promise<void>) | undefined;
    try {
      server = startSkillServer(home);
      await server.ready;
      const filter = server.contentFilter;
      expect(filter.inPlaceSkillDirsFingerprint()).toBe(preferredDuplicateSkillDir);

      writeFileSync(ledger, '{ invalid JSON');
      rmSync(join(contentDir, preferredDuplicateSkillDir), { recursive: true, force: true });
      expect(existsSync(join(contentDir, preferredDuplicateSkillDir))).toBe(false);
      expect(existsSync(join(contentDir, defaultDuplicateSkillDir, 'SKILL.md'))).toBe(true);
      for (const dir of extraCopies)
        expect(existsSync(join(contentDir, dir, 'SKILL.md'))).toBe(true);
      filter.refreshInPlaceSkillDirs();
      expect.soft(filter.isExcluded(`${defaultDuplicateSkillDir}/SKILL.md`)).toBe(false);
      for (const dir of extraCopies) expect.soft(filter.isExcluded(`${dir}/SKILL.md`)).toBe(true);
      expect.soft(filter.inPlaceSkillDirsFingerprint()).toBe(defaultDuplicateSkillDir);

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      stopPolling = await startOpenPollingClockInput();
      await expect(
        deliverRawSkillCreate(server, writeSkillFixture(rawStandardSkillDir)),
      ).resolves.toBeUndefined();
      for (const dir of extraCopies) expect.soft(filter.isExcluded(`${dir}/SKILL.md`)).toBe(true);
      expect(filter.inPlaceSkillDirsFingerprint()).toBe(
        fingerprintOf(defaultDuplicateSkillDir, rawStandardSkillDir),
      );
    } finally {
      await stopPolling?.();
      vi.useRealTimers();
      await server?.destroy();
    }
  },
);

test('an unreadable skill bundle keeps a same-name fork admitted while it remains on disk and withdraws it once it leaves', async () => {
  vi.useRealTimers();
  const references = writeReferencedSkillFixture(unreadableForkSkillDir);
  writeSkillFixture(readableForkSkillDir, '# Fork variant\n');
  const { home } = prepareSkillServerProject({ schema: 1, skills: {} });
  let server: ServerInstance | undefined;
  try {
    server = startSkillServer(home);
    await server.ready;
    const filter = server.contentFilter;
    expect(filter.inPlaceSkillDirsFingerprint()).toBe(
      fingerprintOf(unreadableForkSkillDir, readableForkSkillDir),
    );

    denyAdmission('readdir', references);
    filter.refreshInPlaceSkillDirs();
    expect(admissionFault.observed).toBe(true);
    expect.soft(filter.isExcluded(`${unreadableForkSkillDir}/SKILL.md`)).toBe(false);
    expect.soft(filter.isExcluded(`${readableForkSkillDir}/SKILL.md`)).toBe(false);
    expect
      .soft(filter.inPlaceSkillDirsFingerprint())
      .toBe(fingerprintOf(unreadableForkSkillDir, readableForkSkillDir));

    rmSync(join(contentDir, readableForkSkillDir), { recursive: true, force: true });
    expect(existsSync(join(contentDir, readableForkSkillDir))).toBe(false);
    admissionFault.observed = false;
    filter.refreshInPlaceSkillDirs();
    expect(admissionFault.observed).toBe(true);
    expect.soft(filter.isExcluded(`${unreadableForkSkillDir}/SKILL.md`)).toBe(false);
    expect(filter.inPlaceSkillDirsFingerprint()).toBe(unreadableForkSkillDir);
  } finally {
    clearAdmissionDenial();
    await server?.destroy();
  }
});

test('an invalid-JSON ledger never admits a standard-root copy beside its retained custom-root skill', async () => {
  vi.useRealTimers();
  const { home, ledger } = prepareCustomRootSkillProject();
  let server: ServerInstance | undefined;
  let stopPolling: (() => Promise<void>) | undefined;
  try {
    server = startSkillServer(home);
    await server.ready;
    const filter = server.contentFilter;
    expect(filter.inPlaceSkillDirsFingerprint()).toBe(customRootSkillDir);

    writeFileSync(ledger, '{ invalid JSON');
    writeReferencedSkillFixture(standardCopyOfCustomRootSkillDir);
    for (const file of ['SKILL.md', 'references/context.md']) {
      expect(readFileSync(join(contentDir, standardCopyOfCustomRootSkillDir, file), 'utf8')).toBe(
        readFileSync(join(contentDir, customRootSkillDir, file), 'utf8'),
      );
    }
    writeSkillFixture(refreshedStandardSkillDir);
    filter.refreshInPlaceSkillDirs();
    expect.soft(filter.isExcluded(`${customRootSkillDir}/SKILL.md`)).toBe(false);
    expect.soft(filter.isExcluded(`${standardCopyOfCustomRootSkillDir}/SKILL.md`)).toBe(true);
    expect
      .soft(filter.inPlaceSkillDirsFingerprint())
      .toBe(fingerprintOf(customRootSkillDir, refreshedStandardSkillDir));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stopPolling = await startOpenPollingClockInput();
    await expect(
      deliverRawSkillCreate(server, writeSkillFixture(rawStandardSkillDir)),
    ).resolves.toBeUndefined();
    expect.soft(filter.isExcluded(`${standardCopyOfCustomRootSkillDir}/SKILL.md`)).toBe(true);
    expect(filter.inPlaceSkillDirsFingerprint()).toBe(
      fingerprintOf(customRootSkillDir, refreshedStandardSkillDir, rawStandardSkillDir),
    );
  } finally {
    await stopPolling?.();
    vi.useRealTimers();
    await server?.destroy();
  }
});

test('an unreadable configured skill root retains its admitted custom bundle', () => {
  const skillDir = 'extra/skills/fixture';
  const manifest = writeSkillFixture(skillDir);
  const manifestBytes = readFileSync(manifest, 'utf8');
  const ledgerBytes = JSON.stringify({ schema: 1, skills: {}, roots: ['extra/skills'] });
  const ledger = writeSkillLedger(ledgerBytes);
  const filter = dynamicSkillFilter();
  const priorFingerprint = filter.inPlaceSkillDirsFingerprint();
  expect(priorFingerprint).toBe(skillDir);
  expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);

  const configuredRoot = join(contentDir, 'extra', 'skills');
  denyAdmission('realpath', configuredRoot);
  try {
    expect(realpathSync(contentDir)).toBe(contentDir);
    expect(readFileSync(ledger, 'utf8')).toBe(ledgerBytes);
    expect(realpathSync(manifest)).toBe(manifest);
    expect(admissionFault.observed).toBe(false);
    filter.refreshInPlaceSkillDirs();
    expect(admissionFault.observed).toBe(true);
    expect.soft(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
    expect.soft(filter.inPlaceSkillDirsFingerprint()).toBe(priorFingerprint);
  } finally {
    clearAdmissionDenial();
  }

  expect(readFileSync(manifest, 'utf8')).toBe(manifestBytes);
  expect(readFileSync(ledger, 'utf8')).toBe(ledgerBytes);
  const laterDir = 'extra/skills/later';
  writeSkillFixture(laterDir);
  filter.refreshInPlaceSkillDirs();
  expect(filter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
  expect(filter.isExcluded(`${laterDir}/SKILL.md`)).toBe(false);
});

test('a failed configured root preserves readable catalogs and prior admission', () => {
  const deniedDir = 'extra/skills/denied-fixture';
  const readableDir = 'other/skills/readable-fixture';
  writeSkillFixture(deniedDir);
  writeSkillFixture(readableDir);
  const ledgerBytes = JSON.stringify({
    schema: 1,
    skills: {},
    roots: ['extra/skills', 'other/skills'],
  });
  const ledger = writeSkillLedger(ledgerBytes);
  const filter = dynamicSkillFilter();
  const priorFingerprint = filter.inPlaceSkillDirsFingerprint();
  expect(priorFingerprint).toBe([deniedDir, readableDir].join('\n'));

  denyAdmission('realpath', join(contentDir, 'extra', 'skills'));
  try {
    expect(readSkillPlacementsStore(contentDir).roots).toEqual(['other/skills']);
    admissionFault.observed = false;
    expect(scanInPlaceSkills(contentDir).map((skill) => skill.dir)).toEqual([readableDir]);
    expect(scanGlobalInPlaceSkills(contentDir).map((skill) => skill.dir)).toEqual([readableDir]);
    filter.refreshInPlaceSkillDirs();
    expect(admissionFault.observed).toBe(true);
    expect(filter.inPlaceSkillDirsFingerprint()).toBe(priorFingerprint);
    expect(filter.isExcluded(`${deniedDir}/SKILL.md`)).toBe(false);
    expect(filter.isExcluded(`${readableDir}/SKILL.md`)).toBe(false);
  } finally {
    clearAdmissionDenial();
  }

  expect(readFileSync(ledger, 'utf8')).toBe(ledgerBytes);
  const laterDir = 'extra/skills/later-fixture';
  writeSkillFixture(laterDir);
  filter.refreshInPlaceSkillDirs();
  expect(filter.isExcluded(`${laterDir}/SKILL.md`)).toBe(false);
});

test('a denied child ancestor preserves public ledger reads and no-op writes', async () => {
  const skillDir = 'extra/skills/fixture';
  const manifest = writeSkillFixture(skillDir);
  const manifestBytes = readFileSync(manifest, 'utf8');
  const stored = {
    schema: 1,
    skills: { fixture: [{ path: skillDir, mode: 'copy', hash: 'fixture-hash' }] },
    roots: ['extra/skills'],
  };
  const ledgerBytes = `${JSON.stringify(stored, null, 2)}\n`;
  const ledger = writeSkillLedger(ledgerBytes);
  admissionFault.maskedAncestor = join(contentDir, skillDir);
  try {
    const before = readSkillPlacementsStore(contentDir);
    expect(admissionFault.observed).toBe(true);
    expect(before.roots).toEqual(stored.roots);
    expect(before.skills.fixture).toEqual(stored.skills.fixture);

    admissionFault.observed = false;
    await mutateSkillPlacementsStore(contentDir, () => {});
    expect(admissionFault.observed).toBe(true);
    const after = readSkillPlacementsStore(contentDir);
    expect(after.roots).toEqual(stored.roots);
    expect(after.skills.fixture).toEqual(stored.skills.fixture);
  } finally {
    clearAdmissionDenial();
  }

  expect(readFileSync(ledger, 'utf8')).toBe(ledgerBytes);
  expect(readFileSync(manifest, 'utf8')).toBe(manifestBytes);
  expect([...scanInPlaceSkillDirs(contentDir)]).toEqual([skillDir]);
});

test('an unreadable source-preference ledger cannot change the canonical skill copy', () => {
  const agentDir = '.agents/skills/fixture';
  const preferredDir = '.claude/skills/fixture';
  writeSkillFixture(agentDir);
  writeSkillFixture(preferredDir);
  const ledgerBytes = JSON.stringify({ schema: 1, skills: {}, sources: { fixture: 'claude' } });
  const ledger = writeSkillLedger(ledgerBytes);
  expect(scanInPlaceSkills(contentDir).find((skill) => skill.name === 'fixture')?.dir).toBe(
    preferredDir,
  );
  const filter = dynamicSkillFilter();

  denyAdmission('read', ledger);
  try {
    filter.refreshInPlaceSkillDirs();
    expect(admissionFault.observed).toBe(true);
    expect.soft(filter.isExcluded(`${preferredDir}/SKILL.md`)).toBe(false);
    expect.soft(filter.isExcluded(`${agentDir}/SKILL.md`)).toBe(true);
  } finally {
    clearAdmissionDenial();
  }

  expect(readFileSync(ledger, 'utf8')).toBe(ledgerBytes);
  filter.refreshInPlaceSkillDirs();
  expect(filter.isExcluded(`${preferredDir}/SKILL.md`)).toBe(false);
  expect(scanInPlaceSkills(contentDir).find((skill) => skill.name === 'fixture')?.dir).toBe(
    preferredDir,
  );
});

test('missing and rejected ledger paths leave a valid in-root skill selectable', () => {
  const skillDir = '.claude/skills/fixture';
  writeSkillFixture(skillDir);
  expect([...scanInPlaceSkillDirs(contentDir)]).toEqual([skillDir]);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ok-admission-outside-')));
  cleanupDirs.push(outside);
  const outsideSkill = join(outside, 'skills', 'escaped');
  mkdirSync(outsideSkill, { recursive: true });
  writeFileSync(
    join(outsideSkill, 'SKILL.md'),
    '---\nname: escaped\ndescription: Fixture\n---\n\n# Escaped\n',
  );
  symlinkSync(outside, join(contentDir, 'linked'));
  const ledger = writeSkillLedger({
    schema: 1,
    skills: {},
    roots: ['../outside/skills', '/absolute/skills', 'linked/skills', 'extra/skills'],
  });
  writeSkillFixture('extra/skills/accepted');
  expect([...scanInPlaceSkillDirs(contentDir)].sort()).toEqual(
    [skillDir, 'extra/skills/accepted'].sort(),
  );
  expect(readFileSync(ledger, 'utf8')).toContain('../outside/skills');
  expect(scanInPlaceSkills(contentDir).some((skill) => skill.dir === 'linked/skills/escaped')).toBe(
    false,
  );
});

test('server startup and raw skill refresh retain admission across an unreadable root', async () => {
  vi.useRealTimers();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-admission-home-')));
  cleanupDirs.push(home);
  const skillDir = '.claude/skills/fixture';
  const skillPath = writeSkillFixture(skillDir);
  const skillRoot = join(contentDir, '.claude', 'skills');
  const visiblePath = writeDoc('visible.md', '# Before\n');
  mkdirSync(join(contentDir, '.ok'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'config.yml'), '');
  writeFileSync(join(contentDir, '.ok', '.gitignore'), '');
  const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: contentDir,
    env: gitEnv,
  });
  configureTestGitRepository(contentDir);

  let server: ServerInstance | undefined;
  let connection:
    | Awaited<ReturnType<ServerInstance['hocuspocus']['openDirectConnection']>>
    | undefined;
  let stopPolling: (() => Promise<void>) | undefined;
  denyAdmission('readdir', skillRoot);
  try {
    server = createServer({
      contentDir,
      projectDir: contentDir,
      configHomedirOverride: home,
      quiet: true,
      port: 0,
      gitEnabled: false,
    });
    await server.ready;
    expect(admissionFault.observed).toBe(true);
    expect(server.contentFilter.isExcluded('visible.md')).toBe(false);
    const subscription = nativeSubscriptionOn(contentDir);
    connection = await server.hocuspocus.openDirectConnection('visible');
    expect(server.hocuspocus.documents.get('visible')?.getText('source').toString()).toBe(
      '# Before\n',
    );
    writeFileSync(visiblePath, '# After\n');
    await subscription.deliver([{ type: 'update', path: visiblePath }]);
    expect(server.hocuspocus.documents.get('visible')?.getText('source').toString()).toBe(
      '# After\n',
    );

    clearAdmissionDenial();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stopPolling = await startOpenPollingClockInput();
    await expect(
      deliverRawSkillEvents(server, [{ type: 'update', path: skillPath }]),
    ).resolves.toBeUndefined();
    expect(server.contentFilter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);

    denyAdmission('readdir', skillRoot);
    await expect(
      deliverRawSkillEvents(server, [{ type: 'update', path: skillPath }]),
    ).resolves.toBeUndefined();
    expect(admissionFault.observed).toBe(true);
    expect.soft(server.contentFilter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);

    clearAdmissionDenial();
    const laterDir = '.claude/skills/later';
    const laterPath = writeSkillFixture(laterDir);
    await expect(
      deliverRawSkillEvents(server, [{ type: 'create', path: laterPath }]),
    ).resolves.toBeUndefined();
    expect(server.contentFilter.isExcluded(`${skillDir}/SKILL.md`)).toBe(false);
    expect(server.contentFilter.isExcluded(`${laterDir}/SKILL.md`)).toBe(false);
  } finally {
    clearAdmissionDenial();
    await stopPolling?.();
    vi.useRealTimers();
    await connection?.disconnect();
    await server?.destroy();
  }
});

test('notice recovery finds nested markdown, general files and empty folders', async () => {
  const { watcher, events } = await watchContent();
  const nested = join(contentDir, 'outer', 'inner');
  mkdirSync(join(nested, 'empty'), { recursive: true });
  const notePath = join(nested, 'note.md');
  const dataPath = join(contentDir, 'outer', 'data.json');
  writeFileSync(notePath, '# Nested\n');
  writeFileSync(dataPath, '{}\n');

  await deliverNotice(contentDir);

  expect.soft(watcher.getFolderIndex().has('outer')).toBe(true);
  expect.soft(watcher.getFolderIndex().has('outer/inner')).toBe(true);
  expect.soft(watcher.getFolderIndex().has('outer/inner/empty')).toBe(true);
  expect
    .soft(events)
    .toContainEqual(
      expect.objectContaining({ kind: 'folder-create', relativePath: 'outer/inner/empty' }),
    );
  expect.soft(events).toContainEqual({
    kind: 'create',
    path: notePath,
    docName: 'outer/inner/note',
    content: '# Nested\n',
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: 'file-create',
      path: dataPath,
      relativePath: 'outer/data.json',
    }),
  );
  expect(watcher.getFileIndex().has('outer/inner/note')).toBe(true);
  expect(Boolean(indexedRow(watcher, 'outer/data.json', 'file'))).toBe(true);
});

test('notice recovery removes a collapsed directory and its indexed descendants', async () => {
  const nested = join(contentDir, 'outer', 'inner');
  mkdirSync(nested, { recursive: true });
  const notePath = join(nested, 'note.md');
  const generalPath = join(nested, 'data.csv');
  writeFileSync(notePath, '# Nested\n');
  writeFileSync(generalPath, 'gone\n');
  const { watcher, events } = await watchContent();
  expect(watcher.getFileIndex().has('outer/inner/note')).toBe(true);
  rmSync(join(contentDir, 'outer'), { recursive: true, force: true });

  await deliverNotice(contentDir);

  expect
    .soft(events)
    .toContainEqual({ kind: 'delete', path: notePath, docName: 'outer/inner/note' });
  expect.soft(events).toContainEqual({
    kind: 'file-delete',
    path: generalPath,
    relativePath: 'outer/inner/data.csv',
  });
  expect
    .soft(events)
    .toContainEqual(expect.objectContaining({ kind: 'folder-delete', relativePath: 'outer' }));
  expect(watcher.getFolderIndex().has('outer')).toBe(false);
  expect(watcher.getFolderIndex().has('outer/inner')).toBe(false);
  expect(watcher.getFileIndex().has('outer/inner/note')).toBe(false);
  expect(Boolean(indexedRow(watcher, 'outer/inner/data.csv', 'file'))).toBe(false);
});

test('notice recovery tracks general-file changes and asset notifications outside the markdown view', async () => {
  const changed = join(contentDir, 'changed.csv');
  const removed = join(contentDir, 'removed.csv');
  const removedAsset = join(contentDir, 'removed.png');
  writeFileSync(changed, 'old\n');
  writeFileSync(removed, 'gone\n');
  writeFileSync(removedAsset, 'old-asset');
  const { watcher, events } = await watchContent();
  const created = join(contentDir, 'created.csv');
  const asset = join(contentDir, 'pic.png');
  writeFileSync(created, 'new\n');
  writeFileSync(asset, 'fake-png-bytes');
  writeFileSync(changed, 'new,more,bytes\n');
  const changedStat = statSync(changed);
  unlinkSync(removed);
  unlinkSync(removedAsset);

  await deliverNotice(contentDir);

  expect
    .soft(events)
    .toContainEqual(
      expect.objectContaining({ kind: 'file-create', path: created, relativePath: 'created.csv' }),
    );
  expect.soft(events).toContainEqual(
    expect.objectContaining({
      kind: 'file-update',
      path: changed,
      relativePath: 'changed.csv',
      size: Buffer.byteLength('new,more,bytes\n'),
      modifiedTs: changedStat.mtime.getTime(),
      inode: Number(changedStat.ino),
    }),
  );
  expect
    .soft(events)
    .toContainEqual({ kind: 'file-delete', path: removed, relativePath: 'removed.csv' });
  expect
    .soft(events)
    .toContainEqual({ kind: 'asset-create', path: asset, relativePath: 'pic.png' });
  expect
    .soft(events)
    .toContainEqual({ kind: 'asset-delete', path: removedAsset, relativePath: 'removed.png' });
  expect
    .soft(events)
    .toContainEqual({ kind: 'file-delete', path: removedAsset, relativePath: 'removed.png' });
  expect.soft(Boolean(indexedRow(watcher, 'created.csv', 'file'))).toBe(true);
  expect.soft(Boolean(indexedRow(watcher, 'removed.csv', 'file'))).toBe(false);
  expect.soft(Boolean(indexedRow(watcher, 'removed.png', 'file'))).toBe(false);
  expect.soft(indexedRow(watcher, 'changed.csv', 'file')?.size).toBe(changedStat.size);
  expect
    .soft(indexedRow(watcher, 'changed.csv', 'file')?.modified)
    .toBe(changedStat.mtime.toISOString());
  expect(watcher.getFileIndex().has('created.csv')).toBe(false);
  expect(lastKnownHash.has(created)).toBe(false);
  expect(lastKnownHash.has(asset)).toBe(false);
});

test('notice recovery updates and removes a lexical file alias without deleting its target', async () => {
  const firstTarget = writeDoc('first.md', '# First\n');
  const secondTarget = writeDoc('second.md', '# Second\n');
  const aliasPath = join(contentDir, 'linked.MdX');
  symlinkSync(firstTarget, aliasPath);
  const { watcher, events } = await watchContent();
  expect(watcher.getAliasMap().get('linked')).toBe('first');

  unlinkSync(aliasPath);
  symlinkSync(secondTarget, aliasPath);
  await deliverNotice(contentDir);

  expect.soft(watcher.getAliasMap().get('linked')).toBe('second');
  expect.soft(watcher.getFileIndex().get('first')?.aliases).not.toContain('linked');
  expect.soft(watcher.getFileIndex().get('second')?.aliases).toContain('linked');
  expect.soft([...watcher.getFileIndex().keys()].sort()).toEqual(['first', 'second']);

  unlinkSync(aliasPath);
  await deliverNotice(contentDir);

  expect(events).toContainEqual({ kind: 'delete', path: aliasPath, docName: 'linked' });
  expect(watcher.getAliasMap().has('linked')).toBe(false);
  expect(watcher.getFileIndex().get('second')?.aliases).not.toContain('linked');
  expect(watcher.getFileIndex().has('second')).toBe(true);
  expect(events.some((event) => event.kind === 'delete' && event.docName === 'second')).toBe(false);
});

test('an ordinary alias record retains its lexical path for an omitted deletion', async () => {
  const target = writeDoc('ordinary-target.md', '# Target\n');
  const { watcher, events } = await watchContent();
  const alias = join(contentDir, 'ordinary-alias.MdX');
  symlinkSync(target, alias);
  await deliver(contentDir, [{ type: 'create', path: alias }]);
  unlinkSync(alias);

  await deliverNotice(contentDir);

  expect(events).toContainEqual({ kind: 'delete', path: alias, docName: 'ordinary-alias' });
  expect(watcher.getFileIndex().has('ordinary-target')).toBe(true);
});

test('notice recovery preserves canonical folder identity and rejects broken, cyclic and out-of-root links', async () => {
  const canonicalDir = join(contentDir, 'canonical');
  mkdirSync(canonicalDir);
  const canonicalNote = join(canonicalDir, 'note.md');
  writeFileSync(canonicalNote, '# Canonical\n');
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-parcel-outside-')));
  cleanupDirs.push(outsideDir);
  const outsideNote = join(outsideDir, 'outside.md');
  writeFileSync(outsideNote, '# Outside\n');
  const { watcher, events } = await watchContent();

  symlinkSync(canonicalDir, join(contentDir, 'linked-folder'));
  symlinkSync(canonicalDir, join(canonicalDir, 'cycle'));
  symlinkSync(join(contentDir, 'missing.md'), join(contentDir, 'broken.md'));
  symlinkSync(outsideNote, join(contentDir, 'escape.md'));
  await deliverNotice(contentDir);

  expect(watcher.getFolderAliasIndex().get('linked-folder')).toBe('canonical');
  expect(watcher.getFolderIndex().has('linked-folder')).toBe(false);
  expect(watcher.getFileIndex().has('canonical/note')).toBe(true);
  expect(watcher.getFileIndex().has('linked-folder/note')).toBe(false);
  expect(watcher.getFileIndex().has('broken')).toBe(false);
  expect(watcher.getFileIndex().has('escape')).toBe(false);
  expect(events.some((event) => 'docName' in event && event.docName === 'escape')).toBe(false);
  expect([...watcher.getFileIndex().keys()]).toEqual(['canonical/note']);

  unlinkSync(join(contentDir, 'linked-folder'));
  await deliverNotice(contentDir);
  expect(watcher.getFolderAliasIndex().has('linked-folder')).toBe(false);
  expect(watcher.getFolderIndex().has('canonical')).toBe(true);
  expect(watcher.getFileIndex().has('canonical/note')).toBe(true);
});

test('startup and index-only reseeding retain extension and metadata contracts during later notice recovery', async () => {
  const metaPath = writeDoc('CaseEntry.MD', '---\ntitle: Before\n---\n\n# Ignored\n');
  const binaryPath = join(contentDir, 'payload.bin');
  writeFileSync(binaryPath, Buffer.alloc(32, 0xff));
  const { watcher, events } = await watchContent();
  expect(watcher.getFileIndex().get('CaseEntry')?.title).toBe('Before');
  expect(getDocExtension('CaseEntry')).toBe('.MD');
  expect(indexedRow(watcher, 'payload.bin', 'file')?.kind).toBe('file');
  expect(lastKnownHash.has(binaryPath)).toBe(false);

  writeDoc('Rebuilt.mdx', '# Rebuilt\n');
  await watcher.rescanFromDisk();
  expect(watcher.getFileIndex().has('Rebuilt')).toBe(true);
  expect(getDocExtension('Rebuilt')).toBe('.mdx');
  expect(events).toEqual([]);

  const beforeGeneration = watcher.getFileIndexGeneration();
  writeFileSync(metaPath, '---\ntitle: After\n---\n\n# Ignored\n');
  await deliverNotice(contentDir);

  expect(events).toContainEqual(
    expect.objectContaining({
      kind: 'update',
      path: metaPath,
      docName: 'CaseEntry',
      previousIndexedFields: { title: 'Before', description: undefined, type: undefined },
    }),
  );
  expect(watcher.getFileIndex().get('CaseEntry')?.title).toBe('After');
  expect(watcher.getFileIndexGeneration()).toBeGreaterThan(beforeGeneration);
  expect(lastKnownHash.has(binaryPath)).toBe(false);
});

test('index-only reseeding retains the registered preferred file after it disappears', async () => {
  writeDoc('reseed-priority.md', '# Shadowed\n');
  const preferredPath = writeDoc('reseed-priority.mdx', '# Preferred\n');
  const { watcher, events } = await watchContent();
  expect(watcher.getFileIndex().get('reseed-priority')?.canonicalPath).toBe(preferredPath);
  expect(getDocExtension('reseed-priority')).toBe('.mdx');

  unlinkSync(preferredPath);
  await watcher.rescanFromDisk();

  expect(watcher.getFileIndex().get('reseed-priority')?.canonicalPath).toBe(preferredPath);
  expect(getDocExtension('reseed-priority')).toBe('.mdx');
  expect(events).toEqual([]);
});

test('an index-only reseed started by a raw notice observer preserves omitted recovery', async () => {
  const events: DiskEvent[] = [];
  let watcher: WatcherHandle | undefined;
  let reseed: Promise<void> | undefined;
  watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
    },
    undefined,
    {
      forceBackend: 'parcel',
      platform: 'darwin',
      onRawBatch: () => {
        if (reseed === undefined && watcher !== undefined) reseed = watcher.rescanFromDisk();
      },
    },
  );
  handles.push(watcher);
  const hidden = writeDoc('hidden-reseed.md', '# Hidden\n');

  await deliverNotice(contentDir);
  await reseed;

  expect(events).toContainEqual({
    kind: 'create',
    path: hidden,
    docName: 'hidden-reseed',
    content: '# Hidden\n',
  });
  expect(watcher.getFileIndex().has('hidden-reseed')).toBe(true);
});

test('a public content callback index update survives notice publication', async () => {
  let watcher: WatcherHandle | undefined;
  const sidePath = join(contentDir, 'side.md');
  watcher = await startWatcher(
    contentDir,
    async (event) => {
      if (event.kind !== 'create' || event.docName !== 'first') return;
      writeFileSync(sidePath, '# Side\n');
      watcher?.mutateFileIndex({
        kind: 'create',
        path: sidePath,
        docName: 'side',
        content: '# Side\n',
      });
    },
    undefined,
    { forceBackend: 'parcel', platform: 'darwin' },
  );
  handles.push(watcher);
  writeDoc('first.md', '# First\n');

  await deliverNotice(contentDir);

  expect(watcher.getFileIndex().has('first')).toBe(true);
  expect(watcher.getFileIndex().get('side')?.canonicalPath).toBe(sidePath);
  expect(watcher.getFileIndex().get('side')?.title).toBe('Side');
});

test.each(['markdown', 'general'] as const)(
  'a public %s creation during directory observation remains indexed',
  async (kind) => {
    const { watcher, events } = await watchContent();
    const entered = deferred();
    const resume = deferred();
    scanSchedule.holdPath = contentDir;
    scanSchedule.entered = entered.release;
    scanSchedule.resume = resume.promise;
    const pending = deliverNotice(contentDir);
    try {
      await entered.promise;
      const name = kind === 'markdown' ? 'fresh.md' : 'fresh.csv';
      const path = writeDoc(name, '# Fresh\n');
      const key = kind === 'markdown' ? 'fresh' : name;
      const stat = statSync(path);
      watcher.mutateFileIndex(
        kind === 'markdown'
          ? { kind: 'create', path, docName: key, content: '# Fresh\n' }
          : {
              kind: 'file-create',
              path,
              relativePath: key,
              size: stat.size,
              modifiedTs: stat.mtimeMs,
              inode: stat.ino,
            },
      );
      expect(Boolean(indexedRow(watcher, key, kind === 'markdown' ? 'markdown' : 'file'))).toBe(
        true,
      );
      resume.release();
      await pending;
      expect(readFileSync(path, 'utf8')).toBe('# Fresh\n');
      expect.soft(events).toEqual([]);
      expect(Boolean(indexedRow(watcher, key, kind === 'markdown' ? 'markdown' : 'file'))).toBe(
        true,
      );
    } finally {
      resume.release();
      await pending;
    }
  },
);

test('notices during a running recovery scan share one follow-up scan and keep delivered records in order', async () => {
  const sentinel = writeDoc('sentinel.md', '# Sentinel\n');
  const delivered = ['second', 'third', 'fourth'];
  scanSchedule.orderedPath = contentDir;
  scanSchedule.orderedEntries = [
    'sentinel.md',
    ...delivered.map((name) => `${name}.md`),
    'omitted.md',
  ];
  const { watcher, events, rawBatches } = await watchContent();
  memberStatSchedule.seen = [];
  rawBatches.length = 0;
  const entered = deferred();
  const resume = deferred();
  scanSchedule.holdPath = contentDir;
  scanSchedule.entered = entered.release;
  scanSchedule.resume = resume.promise;
  const subscription = nativeSubscriptionOn(contentDir);
  const pending = [subscription.deliver([], new Error(notices[0]))];
  const deliveredPaths: string[] = [];
  try {
    await entered.promise;
    writeDoc('omitted.md', '# Omitted\n');
    for (const [index, name] of delivered.entries()) {
      const path = writeDoc(`${name}.md`, `# ${name}\n`);
      deliveredPaths.push(path);
      pending.push(
        subscription.deliver(
          [{ type: 'create', path }],
          new Error(notices[(index + 1) % notices.length]),
        ),
      );
    }
    resume.release();
    await Promise.all(pending);
    await vi.runAllTimersAsync();

    expect(rawBatches.filter((batch) => batch.length > 0 && !batch.includes(sentinel))).toEqual(
      deliveredPaths.map((path) => [path]),
    );
    const created = events.flatMap((event) => (event.kind === 'create' ? [event.docName] : []));
    expect(created.filter((name) => delivered.includes(name))).toEqual(delivered);
    expect(created).toContain('omitted');
    for (const name of ['sentinel', ...delivered, 'omitted']) {
      expect(watcher.getFileIndex().has(name)).toBe(true);
    }
    expect(memberStatSchedule.seen.filter((path) => path === sentinel)).toHaveLength(2);
  } finally {
    resume.release();
    await Promise.all(pending);
  }
});

test.each(['alias.csv', 'real.csv'])(
  'general-file recovery keeps a single target when %s is enumerated first',
  async (firstEntry) => {
    const real = writeDoc('real.csv', 'before\n');
    const alias = join(contentDir, 'alias.csv');
    symlinkSync(real, alias);
    scanSchedule.orderedPath = contentDir;
    scanSchedule.firstEntry = firstEntry;
    const { watcher, events } = await watchContent();
    expect(indexedIdentityRows(watcher).filter((entry) => entry.kind === 'file')).toEqual([
      expect.objectContaining({
        name: 'real.csv',
        canonicalPath: real,
        aliases: ['alias.csv'],
      }),
    ]);
    writeFileSync(real, 'after,more,bytes\n');
    await deliverNotice(contentDir);
    expect.soft(indexedIdentityRows(watcher)).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'file-update', path: real, relativePath: 'real.csv' }),
    );
    events.length = 0;
    await deliverNotice(contentDir);
    expect.soft(events).toEqual([]);
    unlinkSync(alias);
    await deliverNotice(contentDir);
    expect
      .soft(events.some((event) => event.kind === 'file-delete' && event.path === real))
      .toBe(false);
    const other = writeDoc('other.csv', 'other\n');
    symlinkSync(other, alias);
    await deliverNotice(contentDir);
    const entries = indexedIdentityRows(watcher);
    expect.soft(entries.filter((entry) => entry.canonicalPath === real)).toHaveLength(1);
    expect.soft(entries.filter((entry) => entry.canonicalPath === other)).toHaveLength(1);
    expect(readFileSync(real, 'utf8')).toBe('after,more,bytes\n');
    events.length = 0;
    unlinkSync(real);
    await deliverNotice(contentDir);
    expect(events).toContainEqual({
      kind: 'file-delete',
      path: real,
      relativePath: 'real.csv',
    });
    expect(indexedIdentityRows(watcher).some((entry) => entry.canonicalPath === real)).toBe(false);
  },
);

test.each(['markdown', 'general'] as const)(
  'a public %s recreation during recovery supersedes a pending deletion',
  async (kind) => {
    const first = writeDoc('first.md', '# First\n');
    const name = kind === 'markdown' ? 'later.md' : 'later.csv';
    const later = writeDoc(name, '# Before\n');
    const key = kind === 'markdown' ? 'later' : name;
    scanSchedule.orderedPath = contentDir;
    scanSchedule.firstEntry = 'first.md';
    const watched = await watchContent(undefined, async (event) => {
      if (event.kind !== 'delete' || event.docName !== 'first') return;
      writeFileSync(later, '# Recreated\n');
      const stat = statSync(later);
      watched.watcher.mutateFileIndex(
        kind === 'markdown'
          ? { kind: 'create', path: later, docName: key, content: '# Recreated\n' }
          : {
              kind: 'file-create',
              path: later,
              relativePath: key,
              size: stat.size,
              modifiedTs: stat.mtimeMs,
              inode: stat.ino,
            },
      );
    });
    expect(
      Boolean(indexedRow(watched.watcher, key, kind === 'markdown' ? 'markdown' : 'file')),
    ).toBe(true);
    unlinkSync(first);
    unlinkSync(later);

    await deliverNotice(contentDir);

    expect(watched.events).toContainEqual({ kind: 'delete', path: first, docName: 'first' });
    expect(readFileSync(later, 'utf8')).toBe('# Recreated\n');
    expect
      .soft(watched.events.filter((event) => 'path' in event && event.path === later))
      .toEqual([]);
    expect(indexedRow(watched.watcher, key, kind === 'markdown' ? 'markdown' : 'file')?.size).toBe(
      Buffer.byteLength('# Recreated\n'),
    );
  },
);

test('a public recreation during recovery retains its restored parent directory', async () => {
  const first = writeDoc('first.md', '# First\n');
  const folder = join(contentDir, 'nested');
  mkdirSync(folder);
  const later = writeDoc('nested/later.md', '# Before\n');
  scanSchedule.orderedPath = contentDir;
  scanSchedule.firstEntry = 'first.md';
  const watched = await watchContent(undefined, async (event) => {
    if (event.kind !== 'delete' || event.docName !== 'first') return;
    mkdirSync(folder);
    writeFileSync(later, '# Recreated\n');
    watched.watcher.mutateFileIndex({
      kind: 'create',
      path: later,
      docName: 'nested/later',
      content: '# Recreated\n',
    });
  });
  expect(watched.watcher.getFolderIndex().has('nested')).toBe(true);
  unlinkSync(first);
  rmSync(folder, { recursive: true });

  await deliverNotice(contentDir);

  expect(watched.events).toContainEqual({ kind: 'delete', path: first, docName: 'first' });
  expect(readFileSync(later, 'utf8')).toBe('# Recreated\n');
  expect.soft(Boolean(indexedRow(watched.watcher, 'nested/later', 'markdown'))).toBe(true);
  expect.soft(watched.events).not.toContainEqual({
    kind: 'folder-delete',
    path: folder,
    relativePath: 'nested',
  });
  expect(watched.watcher.getFolderIndex().has('nested')).toBe(true);
});

test('a delivered general-file alias record stays one identity after recovery', async () => {
  const real = writeDoc('real.csv', 'one\n');
  const alias = join(contentDir, 'alias.csv');
  symlinkSync(real, alias);
  const { watcher, events } = await watchContent();
  await deliverNotice(contentDir);
  expect(indexedIdentityRows(watcher)).toHaveLength(1);
  await deliver(contentDir, [{ type: 'update', path: alias }]);
  events.length = 0;

  await deliverNotice(contentDir);

  expect(readFileSync(alias, 'utf8')).toBe('one\n');
  expect.soft(events.filter((event) => 'path' in event && event.path === alias)).toEqual([]);
  expect(indexedIdentityRows(watcher)).toHaveLength(1);
});

test.each(['create', 'update'] as const)(
  'a delivered alias %s preserves its former general-file target',
  async (type) => {
    const real = writeDoc('real.csv', 'first\n');
    const other = writeDoc('other.csv', 'second\n');
    const alias = join(contentDir, 'alias.csv');
    symlinkSync(real, alias);
    scanSchedule.orderedPath = contentDir;
    scanSchedule.firstEntry = 'alias.csv';
    const { watcher, events } = await watchContent();
    expect(indexedAliasOwner(watcher, 'alias.csv')?.canonicalPath).toBe(real);
    unlinkSync(alias);
    symlinkSync(other, alias);

    await deliver(contentDir, [{ type, path: alias }]);

    expect(readFileSync(real, 'utf8')).toBe('first\n');
    expect(readFileSync(alias, 'utf8')).toBe('second\n');
    const entries = indexedIdentityRows(watcher);
    expect.soft(entries.filter((entry) => entry.canonicalPath === real)).toHaveLength(1);
    expect.soft(entries.filter((entry) => entry.canonicalPath === other)).toHaveLength(1);
    events.length = 0;
    await deliverNotice(contentDir);
    await deliverNotice(contentDir);
    expect.soft(events.filter((event) => event.kind === 'file-delete')).toEqual([]);
    const recovered = indexedIdentityRows(watcher);
    expect(recovered.filter((entry) => entry.canonicalPath === real)).toHaveLength(1);
    expect(recovered.filter((entry) => entry.canonicalPath === other)).toHaveLength(1);
  },
);

test('a delivered alias retarget keeps sibling aliases on their original target', async () => {
  const real = writeDoc('real.csv', 'first\n');
  const alias = join(contentDir, 'alias.csv');
  const sibling = join(contentDir, 'sibling.csv');
  symlinkSync(real, alias);
  symlinkSync(real, sibling);
  scanSchedule.orderedPath = contentDir;
  scanSchedule.firstEntry = 'alias.csv';
  const { watcher } = await watchContent();
  expect(indexedAliasOwner(watcher, 'alias.csv')?.aliases).toContain('sibling.csv');
  const other = writeDoc('other.csv', 'second\n');
  unlinkSync(alias);
  symlinkSync(other, alias);

  await deliver(contentDir, [{ type: 'update', path: alias }]);

  expect(readFileSync(sibling, 'utf8')).toBe('first\n');
  expect(readFileSync(alias, 'utf8')).toBe('second\n');
  const owners = indexedIdentityRows(watcher).filter((entry) =>
    entry.aliases.includes('sibling.csv'),
  );
  expect.soft(owners).toHaveLength(1);
  expect.soft(owners.map((entry) => entry.canonicalPath)).toEqual([real]);
  await deliverNotice(contentDir);
  await deliverNotice(contentDir);
  const recovered = indexedIdentityRows(watcher);
  expect(recovered.filter((entry) => entry.canonicalPath === real)).toHaveLength(1);
  expect(recovered.filter((entry) => entry.canonicalPath === other)).toHaveLength(1);
});

test('an ordinary canonical file update retains its aliases beside a same-stem document', async () => {
  const real = writeDoc('real.csv', 'first\n');
  const document = writeDoc('real.csv.md', '# Document\n');
  const alias = join(contentDir, 'alias.csv');
  const sibling = join(contentDir, 'sibling.csv');
  symlinkSync(real, alias);
  symlinkSync(real, sibling);
  scanSchedule.orderedPath = contentDir;
  scanSchedule.firstEntry = 'alias.csv';
  const { watcher, events } = await watchContent();
  expect(indexedRow(watcher, 'real.csv', 'file')?.aliases).toEqual(['alias.csv', 'sibling.csv']);
  expect(indexedRow(watcher, 'real.csv', 'markdown')?.canonicalPath).toBe(document);
  writeFileSync(real, 'changed,longer,bytes\n');

  await deliver(contentDir, [{ type: 'update', path: real }]);

  expect(events).toContainEqual(
    expect.objectContaining({ kind: 'file-update', path: real, relativePath: 'real.csv' }),
  );
  const rows = indexedIdentityRows(watcher);
  expect(
    rows.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real),
  ).toHaveLength(1);
  expect(rows.find((entry) => entry.kind === 'file' && entry.canonicalPath === real)).toMatchObject(
    {
      name: 'real.csv',
      aliases: ['alias.csv', 'sibling.csv'],
      size: statSync(real).size,
      inode: Number(statSync(real).ino),
      modified: statSync(real).mtime.toISOString(),
    },
  );
  expect(
    rows.filter((entry) => entry.kind === 'markdown' && entry.canonicalPath === document),
  ).toHaveLength(1);
  expect(readFileSync(alias, 'utf8')).toBe('changed,longer,bytes\n');
  expect(readFileSync(sibling, 'utf8')).toBe('changed,longer,bytes\n');
  expect(readFileSync(document, 'utf8')).toBe('# Document\n');
});

test('an ordinary alias retarget retains aliases already owned by its new target', async () => {
  const real = writeDoc('real.csv', 'first\n');
  const other = writeDoc('other.csv', 'second,longer\n');
  const document = writeDoc('real.csv.md', '# Document\n');
  const alias = join(contentDir, 'alias.csv');
  const oldSibling = join(contentDir, 'old-sibling.csv');
  const newSibling = join(contentDir, 'new-sibling.csv');
  symlinkSync(real, alias);
  symlinkSync(real, oldSibling);
  symlinkSync(other, newSibling);
  scanSchedule.orderedPath = contentDir;
  scanSchedule.firstEntry = 'alias.csv';
  const { watcher, events } = await watchContent();
  expect(indexedRow(watcher, 'real.csv', 'file')?.aliases).toEqual([
    'alias.csv',
    'old-sibling.csv',
  ]);
  expect(indexedRow(watcher, 'other.csv', 'file')?.aliases).toEqual(['new-sibling.csv']);
  unlinkSync(alias);
  symlinkSync(other, alias);

  await deliver(contentDir, [{ type: 'update', path: alias }]);

  expect(events).toContainEqual(
    expect.objectContaining({ kind: 'file-update', path: alias, relativePath: 'alias.csv' }),
  );
  const rows = indexedIdentityRows(watcher);
  expect(
    rows.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real),
  ).toHaveLength(1);
  expect(
    rows.filter((entry) => entry.kind === 'file' && entry.canonicalPath === other),
  ).toHaveLength(1);
  expect(rows.find((entry) => entry.kind === 'file' && entry.canonicalPath === real)).toMatchObject(
    {
      aliases: ['old-sibling.csv'],
      size: statSync(real).size,
      inode: Number(statSync(real).ino),
    },
  );
  expect(
    rows.find((entry) => entry.kind === 'file' && entry.canonicalPath === other),
  ).toMatchObject({
    name: 'other.csv',
    aliases: expect.arrayContaining(['alias.csv', 'new-sibling.csv']),
    size: statSync(other).size,
    inode: Number(statSync(other).ino),
  });
  expect(
    rows.find((entry) => entry.kind === 'file' && entry.canonicalPath === other)?.aliases,
  ).toHaveLength(2);
  expect(
    rows.filter((entry) => entry.kind === 'markdown' && entry.canonicalPath === document),
  ).toHaveLength(1);
  expect(readFileSync(alias, 'utf8')).toBe('second,longer\n');
  expect(readFileSync(oldSibling, 'utf8')).toBe('first\n');
  expect(readFileSync(newSibling, 'utf8')).toBe('second,longer\n');
  expect(readFileSync(document, 'utf8')).toBe('# Document\n');
});

test('a general-file alias retarget does not discard later delivered records', async () => {
  const real = writeDoc('real.csv', 'first\n');
  const document = writeDoc('real.csv.md', '# Document\n');
  const other = writeDoc('other.csv', 'second\n');
  const alias = join(contentDir, 'alias.csv');
  symlinkSync(real, alias);
  scanSchedule.orderedPath = contentDir;
  scanSchedule.firstEntry = 'alias.csv';
  const { watcher, events } = await watchContent();
  expect(indexedAliasOwner(watcher, 'alias.csv')?.canonicalPath).toBe(real);
  expect(watcher.getFileIndex().get('real.csv')?.canonicalPath).toBe(document);
  const later = writeDoc('later.csv', 'later\n');
  unlinkSync(alias);
  symlinkSync(other, alias);

  await deliver(contentDir, [
    { type: 'update', path: alias },
    { type: 'create', path: later },
  ]);

  expect(readFileSync(real, 'utf8')).toBe('first\n');
  expect(watcher.getFileIndex().get('real.csv')?.canonicalPath).toBe(document);
  expect
    .soft(events)
    .toContainEqual(
      expect.objectContaining({ kind: 'file-create', path: later, relativePath: 'later.csv' }),
    );
  expect(indexedRow(watcher, 'later.csv', 'file')?.canonicalPath).toBe(later);
});

test('notice recovery retains a general-file alias beside a matching document stem', async () => {
  const real = writeDoc('real.csv', 'first\n');
  const document = writeDoc('real.csv.md', '# Document\n');
  const alias = join(contentDir, 'alias.csv');
  symlinkSync(real, alias);
  scanSchedule.orderedPath = contentDir;
  scanSchedule.firstEntry = 'alias.csv';
  const { watcher, events } = await watchContent();
  expect(indexedAliasOwner(watcher, 'alias.csv')?.canonicalPath).toBe(real);
  expect(watcher.getFileIndex().get('real.csv')?.canonicalPath).toBe(document);

  await deliverNotice(contentDir);
  await deliverNotice(contentDir);

  expect(readFileSync(real, 'utf8')).toBe('first\n');
  expect(readFileSync(alias, 'utf8')).toBe('first\n');
  expect(readFileSync(document, 'utf8')).toBe('# Document\n');
  expect.soft(events).toEqual([]);
  const entries = indexedIdentityRows(watcher);
  expect.soft(entries.filter((entry) => entry.canonicalPath === real)).toHaveLength(1);
  expect(entries.filter((entry) => entry.canonicalPath === document)).toHaveLength(1);
});

test('notice recovery keeps file links exact beside a matching document stem', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const real = writeDoc('real.csv', 'first\n');
  writeDoc('real.csv.md', '# Document\n');
  const alias = join(contentDir, 'alias.csv');
  symlinkSync(real, alias);
  writeDoc('source.md', '# Source\n\n[Target](real.csv)\n\n[Alias](alias.csv)\n');
  scanSchedule.orderedPath = contentDir;
  scanSchedule.firstEntry = 'alias.csv';
  const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: contentDir,
    env: gitEnv,
  });
  configureTestGitRepository(contentDir);
  const server = await bootCompositionRig(contentDir);
  try {
    await server.ready;
    const statuses = async () => {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/forward-links?docName=source`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        localTargets: Array<{ href: string; status: string }>;
      };
      return Object.fromEntries(body.localTargets.map((target) => [target.href, target.status]));
    };
    const expected = { 'real.csv': 'exact', 'alias.csv': 'exact' };
    expect(await statuses()).toEqual(expected);
    const subscription = nativeSubscriptionOn(contentDir);

    await subscription.deliver([], new Error(notices[0]));
    await subscription.deliver([], new Error(notices[0]));

    expect(readFileSync(real, 'utf8')).toBe('first\n');
    expect(readFileSync(alias, 'utf8')).toBe('first\n');
    expect(await statuses()).toEqual(expected);
  } finally {
    await server.destroy();
  }
});

test('a delivered alias retarget preserves both real link targets', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const real = writeDoc('real.csv', 'first\n');
  const other = writeDoc('other.csv', 'second\n');
  const alias = join(contentDir, 'alias.csv');
  symlinkSync(real, alias);
  writeDoc(
    'source.md',
    '# Source\n\n[First](real.csv)\n\n[Second](other.csv)\n\n[Alias](alias.csv)\n',
  );
  scanSchedule.orderedPath = contentDir;
  scanSchedule.firstEntry = 'alias.csv';
  const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: contentDir,
    env: gitEnv,
  });
  configureTestGitRepository(contentDir);
  const server = await bootCompositionRig(contentDir);
  try {
    await server.ready;
    const statuses = async () => {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/forward-links?docName=source`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        localTargets: Array<{ href: string; status: string }>;
      };
      return Object.fromEntries(body.localTargets.map((target) => [target.href, target.status]));
    };
    const expected = { 'real.csv': 'exact', 'other.csv': 'exact', 'alias.csv': 'exact' };
    expect(await statuses()).toEqual(expected);
    unlinkSync(alias);
    symlinkSync(other, alias);
    const subscription = nativeSubscriptionOn(contentDir);

    await subscription.deliver([{ type: 'update', path: alias }]);

    expect(readFileSync(real, 'utf8')).toBe('first\n');
    expect(readFileSync(alias, 'utf8')).toBe('second\n');
    expect.soft(await statuses()).toEqual(expected);
    await subscription.deliver([], new Error(notices[0]));
    await subscription.deliver([], new Error(notices[0]));
    expect(await statuses()).toEqual(expected);
  } finally {
    await server.destroy();
  }
});

test('a delivered general-file alias retains both link targets after recovery', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const real = writeDoc('real.csv', 'one\n');
  const alias = join(contentDir, 'alias.csv');
  symlinkSync(real, alias);
  writeDoc('source.md', '# Source\n\n[Target](real.csv)\n\n[Alias](alias.csv)\n');
  const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: contentDir,
    env: gitEnv,
  });
  configureTestGitRepository(contentDir);
  const server = await bootCompositionRig(contentDir);
  try {
    await server.ready;
    const statuses = async () => {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/forward-links?docName=source`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        localTargets: Array<{ href: string; status: string }>;
      };
      return Object.fromEntries(body.localTargets.map((target) => [target.href, target.status]));
    };
    const subscription = nativeSubscriptionOn(contentDir);
    await subscription.deliver([], new Error(notices[0]));
    expect(await statuses()).toEqual({ 'real.csv': 'exact', 'alias.csv': 'exact' });
    await subscription.deliver([{ type: 'update', path: alias }]);
    expect(await statuses()).toEqual({ 'real.csv': 'exact', 'alias.csv': 'exact' });

    await subscription.deliver([], new Error(notices[0]));

    expect(readFileSync(alias, 'utf8')).toBe('one\n');
    expect(await statuses()).toEqual({ 'real.csv': 'exact', 'alias.csv': 'exact' });
  } finally {
    await server.destroy();
  }
});

test.each(['alias.csv', 'real.csv'])(
  'general-file links retain their disk status with %s enumerated first',
  async (firstEntry) => {
    vi.useRealTimers();
    const real = writeDoc('real.csv', 'before\n');
    const alias = join(contentDir, 'alias.csv');
    symlinkSync(real, alias);
    writeDoc('source.md', '# Source\n\n[Target](real.csv)\n\n[Alias](alias.csv)\n');
    scanSchedule.orderedPath = contentDir;
    scanSchedule.firstEntry = firstEntry;
    const gitEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
      cwd: contentDir,
      env: gitEnv,
    });
    configureTestGitRepository(contentDir);
    const server = await bootCompositionRig(contentDir);
    try {
      await server.ready;
      const statuses = async () => {
        const response = await fetch(
          `http://127.0.0.1:${server.port}/api/forward-links?docName=source`,
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          localTargets: Array<{ href: string; status: string }>;
        };
        return Object.fromEntries(body.localTargets.map((target) => [target.href, target.status]));
      };
      expect(await statuses()).toEqual({ 'real.csv': 'exact', 'alias.csv': 'exact' });
      writeFileSync(real, 'after,more,bytes\n');
      const subscription = nativeSubscriptionOn(contentDir);
      await subscription.deliver([], new Error(notices[0]));
      expect(await statuses()).toEqual({ 'real.csv': 'exact', 'alias.csv': 'exact' });
      await subscription.deliver([], new Error(notices[0]));
      expect.soft(await statuses()).toEqual({ 'real.csv': 'exact', 'alias.csv': 'exact' });
      unlinkSync(alias);
      await subscription.deliver([], new Error(notices[0]));
      expect.soft(await statuses()).toEqual({ 'real.csv': 'exact', 'alias.csv': 'missing' });
      const other = writeDoc('other.csv', 'other\n');
      symlinkSync(other, alias);
      await subscription.deliver([], new Error(notices[0]));
      expect(await statuses()).toEqual({ 'real.csv': 'exact', 'alias.csv': 'exact' });
      expect(readFileSync(real, 'utf8')).toBe('after,more,bytes\n');
      unlinkSync(other);
      await subscription.deliver([], new Error(notices[0]));
      expect(await statuses()).toEqual({ 'real.csv': 'exact', 'alias.csv': 'missing' });
    } finally {
      await server.destroy();
    }
  },
);

test('a public content callback can remove an observed entry before notice publication', async () => {
  let watcher: WatcherHandle | undefined;
  const path = join(contentDir, 'first.md');
  watcher = await startWatcher(
    contentDir,
    async (event) => {
      if (event.kind === 'create' && event.docName === 'first') {
        watcher?.mutateFileIndex({ kind: 'delete', path, docName: 'first' });
      }
    },
    undefined,
    { forceBackend: 'parcel', platform: 'darwin' },
  );
  handles.push(watcher);
  writeFileSync(path, '# First\n');

  await deliverNotice(contentDir);

  expect(watcher.getFileIndex().has('first')).toBe(false);
});

test('a public content callback keeps a newer same-title index update', async () => {
  let watcher: WatcherHandle | undefined;
  const path = join(contentDir, 'first.md');
  const newer = '# First\n\n';
  watcher = await startWatcher(
    contentDir,
    async (event) => {
      if (event.kind === 'create' && event.docName === 'first') {
        writeFileSync(path, newer);
        watcher?.mutateFileIndex({ kind: 'update', path, docName: 'first', content: newer });
      }
    },
    undefined,
    { forceBackend: 'parcel', platform: 'darwin' },
  );
  handles.push(watcher);
  writeFileSync(path, '# First\n');

  await deliverNotice(contentDir);

  expect(watcher.getFileIndex().get('first')?.size).toBe(Buffer.byteLength(newer));
});

test('notice recovery keeps the preferred mdx file for a shared document stem', async () => {
  const mdPath = writeDoc('priority-fixture.md', '# Shadowed\n');
  const mdxPath = writeDoc('priority-fixture.mdx', '# Preferred\n');
  const { watcher, events } = await watchContent();
  expect([...watcher.getFileIndex().keys()]).toEqual(['priority-fixture']);
  expect(watcher.getFileIndex().get('priority-fixture')?.canonicalPath).toBe(mdxPath);
  expect(watcher.getFileIndex().get('priority-fixture')?.title).toBe('Preferred');
  expect(getDocExtension('priority-fixture')).toBe('.mdx');

  writeFileSync(mdxPath, '# Updated preferred\n');
  await deliverNotice(contentDir);

  expect(events).toContainEqual(
    expect.objectContaining({
      kind: 'update',
      path: mdxPath,
      docName: 'priority-fixture',
      content: '# Updated preferred\n',
    }),
  );
  expect([...watcher.getFileIndex().keys()]).toEqual(['priority-fixture']);
  expect(watcher.getFileIndex().get('priority-fixture')?.canonicalPath).toBe(mdxPath);
  expect(watcher.getFileIndex().get('priority-fixture')?.title).toBe('Updated preferred');
  expect(getDocExtension('priority-fixture')).toBe('.mdx');
  expect(events.some((event) => 'path' in event && event.path === mdPath)).toBe(false);
});

test('a denied external directory read preserves known content and permits the next real recovery', async () => {
  const guardedDir = join(contentDir, 'guarded');
  mkdirSync(guardedDir);
  const guardedPath = join(guardedDir, 'keep.md');
  writeFileSync(guardedPath, '# Before\n');
  const { watcher, events } = await watchContent();
  expect(watcher.getFileIndex().has('guarded/keep')).toBe(true);
  const diagnostics: unknown[] = [];
  for (const method of ['error', 'warn'] as const) {
    vi.spyOn(getLogger('file-watcher'), method).mockImplementation((data) => {
      diagnostics.push(data);
    });
  }

  deniedDirectoryRead.path = guardedDir;
  try {
    await deliverNotice(contentDir);
  } finally {
    deniedDirectoryRead.path = null;
  }

  expect.soft(watcher.getFileIndex().has('guarded/keep')).toBe(true);
  expect
    .soft(events.some((event) => event.kind === 'delete' && event.docName === 'guarded/keep'))
    .toBe(false);
  expect
    .soft(
      diagnostics.some((data) => {
        if (typeof data !== 'object' || data === null) return false;
        const record = data as { err?: unknown; code?: unknown };
        return (
          record.code === 'EACCES' ||
          (record.err instanceof Error && 'code' in record.err && record.err.code === 'EACCES')
        );
      }),
    )
    .toBe(true);

  writeFileSync(guardedPath, '# After\n');
  await deliverNotice(contentDir);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: 'update',
      path: guardedPath,
      docName: 'guarded/keep',
      content: '# After\n',
    }),
  );
  expect(watcher.getFileIndex().get('guarded/keep')?.title).toBe('After');
});

test('an overlapping notice follows an admitted content callback and preserves later disk state', async () => {
  const entered = deferred();
  const resume = deferred();
  const completed: string[] = [];
  const { watcher, events } = await watchContent(undefined, async (event) => {
    if (event.kind !== 'create') return;
    if (event.docName === 'first') {
      entered.release();
      await resume.promise;
    }
    completed.push(event.docName);
  });
  const subscription = nativeSubscriptionOn(contentDir);
  const firstPath = writeDoc('first.md', '# First\n');
  const firstDelivery = subscription.deliver([{ type: 'create', path: firstPath }]);
  await entered.promise;

  const secondPath = writeDoc('second.md', '# Second\n');
  writeDoc('third.md', '# Third\n');
  const noticeDelivery = subscription.deliver(
    [{ type: 'create', path: secondPath }],
    new Error(notices[0]),
  );
  expect(events.filter((event) => event.kind === 'create').map((event) => event.docName)).toEqual([
    'first',
  ]);

  resume.release();
  await Promise.all([firstDelivery, noticeDelivery]);
  await vi.runAllTimersAsync();

  expect(events.filter((event) => event.kind === 'create').map((event) => event.docName)).toEqual([
    'first',
    'second',
    'third',
  ]);
  expect(completed).toEqual(['first', 'second', 'third']);
  expect([...watcher.getFileIndex().keys()].sort()).toEqual(['first', 'second', 'third']);
});

test('a supplied notice delete cannot overtake a held content callback', async () => {
  const removed = writeDoc('removed.md', '# Removed\n');
  const entered = deferred();
  const resume = deferred();
  const entries: string[] = [];
  const completed: string[] = [];
  const { watcher } = await watchContent(undefined, async (event) => {
    const label =
      event.kind === 'create' || event.kind === 'delete'
        ? `${event.kind}:${event.docName}`
        : event.kind;
    entries.push(label);
    if (label === 'create:first') {
      entered.release();
      await resume.promise;
    }
    completed.push(label);
  });
  const subscription = nativeSubscriptionOn(contentDir);
  const first = writeDoc('first.md', '# First\n');
  const firstDelivery = subscription.deliver([{ type: 'create', path: first }]);
  await entered.promise;

  unlinkSync(removed);
  writeDoc('omitted.md', '# Omitted\n');
  const laterDelivery = subscription.deliver(
    [{ type: 'delete', path: removed }],
    new Error(notices[0]),
  );
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(entries).toEqual(['create:first']);
  expect(completed).toEqual([]);

  resume.release();
  await Promise.all([firstDelivery, laterDelivery]);
  await vi.runAllTimersAsync();
  expect(entries).toContain('delete:removed');
  expect(entries).toContain('create:omitted');
  expect(completed[0]).toBe('create:first');
  expect(completed).toContain('delete:removed');
  expect(completed).toContain('create:omitted');
  expect(watcher.getFileIndex().has('removed')).toBe(false);
  expect(watcher.getFileIndex().has('omitted')).toBe(true);
});

test('a rejected content consumer stays observable and does not poison later notice recovery', async () => {
  const failed = new Error('content consumer rejected');
  const diagnostics: unknown[] = [];
  vi.spyOn(getLogger('file-watcher'), 'error').mockImplementation((data) => {
    diagnostics.push(data.err);
  });
  const { watcher, events } = await watchContent(undefined, async (event) => {
    if (event.kind === 'create' && event.docName === 'first') throw failed;
  });
  const firstPath = writeDoc('first.md', '# First\n');
  await deliver(contentDir, [{ type: 'create', path: firstPath }]);

  const secondPath = writeDoc('second.md', '# Second\n');
  const thirdPath = writeDoc('third.md', '# Third\n');
  await deliverNotice(contentDir, [{ type: 'create', path: secondPath }]);

  expect.soft(diagnostics).toContain(failed);
  expect
    .soft(events)
    .toContainEqual({ kind: 'create', path: secondPath, docName: 'second', content: '# Second\n' });
  expect(events).toContainEqual({
    kind: 'create',
    path: thirdPath,
    docName: 'third',
    content: '# Third\n',
  });
  expect([...watcher.getFileIndex().keys()].sort()).toEqual(['first', 'second', 'third']);
});

test('release drains an admitted notice and closes delivery before later or native-release callbacks', async () => {
  const entered = deferred();
  const resume = deferred();
  const lifecycle: string[] = [];
  const { watcher, events } = await watchContent(undefined, async (event) => {
    if (event.kind === 'create' && event.docName === 'announced') {
      entered.release();
      await resume.promise;
      lifecycle.push('consumer-completed');
    }
  });
  const subscription = nativeSubscriptionOn(contentDir);
  const announced = writeDoc('announced.md', '# Announced\n');
  const delivery = subscription.deliver(
    [{ type: 'create', path: announced }],
    new Error(notices[0]),
  );
  const enteredBeforeDeliveryEnded = await Promise.race([
    entered.promise.then(() => true),
    delivery.then(() => false),
  ]);
  expect(enteredBeforeDeliveryEnded).toBe(true);

  const queuedPath = writeDoc('queued.md', '# Queued\n');
  const queuedDelivery = subscription.deliver(
    [{ type: 'create', path: queuedPath }],
    new Error(notices[0]),
  );
  expect(events.filter((event) => event.kind === 'create').map((event) => event.docName)).toEqual([
    'announced',
  ]);
  const duringPath = writeDoc('during.md', '# During\n');
  subscription.deliverWhileReleasing([{ type: 'create', path: duringPath }], new Error(notices[0]));
  const releaseSettled = vi.fn();
  const releasing = watcher.unsubscribe().then(() => {
    lifecycle.push('release-resolved');
    releaseSettled();
  });
  await Promise.resolve();
  expect(releaseSettled).not.toHaveBeenCalled();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(releaseSettled).not.toHaveBeenCalled();
  expect(lifecycle).toEqual([]);
  resume.release();
  await Promise.all([delivery, queuedDelivery, releasing]);
  expect(lifecycle).toEqual(['consumer-completed', 'release-resolved']);

  const settledEvents = [...events];
  const settledIndex = [...watcher.getFileIndex().keys()];
  const afterPath = writeDoc('after.md', '# After\n');
  await subscription.deliver([{ type: 'create', path: afterPath }], new Error(notices[0]));
  await vi.runAllTimersAsync();

  expect(events).toEqual(settledEvents);
  expect([...watcher.getFileIndex().keys()]).toEqual(settledIndex);
  expect(watcher.getFileIndex().has('queued')).toBe(
    events.some((event) => event.kind === 'create' && event.docName === 'queued'),
  );
  expect(
    events.some((event) => 'docName' in event && ['during', 'after'].includes(event.docName)),
  ).toBe(false);
  expect(subscription.nativeReleases()).toBe(1);
});

test('Windows release closes admission without native unsubscribe after a notice', async () => {
  const events: DiskEvent[] = [];
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
    },
    undefined,
    { forceBackend: 'parcel', platform: 'win32' },
  );
  handles.push(watcher);
  const subscription = nativeSubscriptionOn(contentDir);
  await watcher.unsubscribe();
  const late = writeDoc('late.md', '# Late\n');
  await subscription.deliver([{ type: 'create', path: late }], new Error(notices[0]));

  expect(events).toEqual([]);
  expect(watcher.getFileIndex().has('late')).toBe(false);
  expect(subscription.nativeReleases()).toBe(0);
});

test('an empty HEAD notice settles a same-branch OID movement', async () => {
  const gitDir = createGitDir();
  const watched = await watchHead();
  writeFileSync(join(gitDir, 'refs', 'heads', 'main'), `${newOid}\n`);
  await deliverNotice(gitDir);

  expect(watched.ends).toEqual([
    {
      headMoved: true,
      oldHead: oldOid,
      newHead: newOid,
      timeout: false,
      batchKind: 'within-branch',
      oldBranch: 'main',
      newBranch: 'main',
    },
  ]);
  expect(watched.watcher.getLastKnownBranch()).toBe('main');
});

test('an empty HEAD notice settles a detached HEAD', async () => {
  const gitDir = createGitDir();
  const watched = await watchHead();
  writeFileSync(join(gitDir, 'HEAD'), `${newOid}\n`);
  await deliverNotice(gitDir);

  expect(watched.ends).toEqual([
    {
      headMoved: true,
      oldHead: oldOid,
      newHead: newOid,
      timeout: false,
      batchKind: 'detached-head',
      oldBranch: 'main',
      newBranch: `detached-${newOid.slice(0, 12)}`,
    },
  ]);
  expect(watched.watcher.getLastKnownBranch()).toBe(`detached-${newOid.slice(0, 12)}`);
});

test('an empty HEAD notice settles an unchanged HEAD without claiming movement', async () => {
  const gitDir = createGitDir();
  const watched = await watchHead();
  await deliverNotice(gitDir);

  expect(watched.ends).toEqual([
    {
      headMoved: false,
      oldHead: oldOid,
      newHead: oldOid,
      timeout: false,
      batchKind: 'within-branch',
      oldBranch: 'main',
      newBranch: 'main',
    },
  ]);
  expect(watched.watcher.getLastKnownBranch()).toBe('main');
});

test('repeated HEAD notices during an async begin settle one open batch before release', async () => {
  const gitDir = createGitDir();
  const entered = deferred();
  const resume = deferred();
  const watched = await watchHead(async () => {
    entered.release();
    await resume.promise;
  });
  const subscription = nativeSubscriptionOn(gitDir);
  const headPath = join(gitDir, 'HEAD');
  writeFileSync(headPath, 'ref: refs/heads/feature\n');
  const firstDelivery = subscription.deliver(
    [{ type: 'update', path: headPath }],
    new Error(notices[0]),
  );
  const enteredBeforeDeliveryEnded = await Promise.race([
    entered.promise.then(() => true),
    firstDelivery.then(() => false),
  ]);
  expect(enteredBeforeDeliveryEnded).toBe(true);

  const secondDelivery = subscription.deliver([], new Error(notices[0]));
  resume.release();
  await Promise.all([firstDelivery, secondDelivery]);
  await vi.runAllTimersAsync();

  expect(watched.begins).toEqual([{ trigger: 'HEAD' }]);
  expect(watched.ends).toHaveLength(1);
  expect(watched.watcher.getLastKnownBranch()).toBe('feature');
  await watched.watcher.unsubscribe();
  await subscription.deliver([], new Error(notices[0]));
  await vi.runAllTimersAsync();
  expect(watched.begins).toHaveLength(1);
});

test('a HEAD notice arriving during async settlement schedules the next disk observation', async () => {
  const gitDir = createGitDir();
  const endEntered = deferred();
  const resumeEnd = deferred();
  let endCalls = 0;
  const completed: string[] = [];
  const watched = await watchHead(
    async () => {
      completed.push('begin-completed');
    },
    async () => {
      endCalls++;
      if (endCalls === 1) {
        endEntered.release();
        await resumeEnd.promise;
      }
      completed.push('end-completed');
    },
  );
  const subscription = nativeSubscriptionOn(gitDir);
  const headPath = join(gitDir, 'HEAD');
  writeFileSync(headPath, 'ref: refs/heads/feature\n');
  await subscription.deliver([{ type: 'update', path: headPath }]);
  const settlingFirst = vi.advanceTimersToNextTimerAsync();
  await endEntered.promise;

  writeFileSync(headPath, 'ref: refs/heads/main\n');
  const noticeDelivery = subscription.deliver([], new Error(notices[0]));
  let atRelease:
    | {
        begins: unknown[];
        ends: unknown[];
        completed: string[];
        branch: string | null;
      }
    | undefined;
  const releasing = watched.watcher.unsubscribe().then(() => {
    atRelease = {
      begins: [...watched.begins],
      ends: [...watched.ends],
      completed: [...completed],
      branch: watched.watcher.getLastKnownBranch(),
    };
  });
  resumeEnd.release();
  await Promise.all([settlingFirst, noticeDelivery, releasing]);

  expect(atRelease?.begins).toHaveLength(2);
  expect(atRelease?.ends).toHaveLength(2);
  expect(atRelease?.ends[1]).toEqual({
    headMoved: true,
    oldHead: newOid,
    newHead: oldOid,
    timeout: false,
    batchKind: 'cross-branch',
    oldBranch: 'feature',
    newBranch: 'main',
  });
  expect(atRelease?.completed).toEqual([
    'begin-completed',
    'end-completed',
    'begin-completed',
    'end-completed',
  ]);
  expect(atRelease?.branch).toBe('main');
  await vi.runAllTimersAsync();
  expect({
    begins: watched.begins,
    ends: watched.ends,
    completed,
    branch: watched.watcher.getLastKnownBranch(),
  }).toEqual(atRelease);
  await subscription.deliver([], new Error(notices[0]));
  await vi.runAllTimersAsync();
  expect({
    begins: watched.begins,
    ends: watched.ends,
    completed,
    branch: watched.watcher.getLastKnownBranch(),
  }).toEqual(atRelease);
});

async function inventoryAuditBroken(port: number, href: string): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}/api/audit`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    files: Array<{ diagnostics: Array<{ localTarget?: { href: string } }> }>;
  };
  return body.files
    .flatMap((file) => file.diagnostics)
    .some((diagnostic) => diagnostic.localTarget?.href === href);
}

async function inventoryForwardStatuses(port: number): Promise<Record<string, string>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/forward-links?docName=source`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    localTargets: Array<{ href: string; status: string }>;
  };
  return Object.fromEntries(body.localTargets.map((target) => [target.href, target.status]));
}

async function bootInventoryServer() {
  const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: contentDir,
    env: gitEnv,
  });
  configureTestGitRepository(contentDir);
  const server = await bootCompositionRig(contentDir);
  await server.ready;
  return server;
}

test.each([
  { kind: 'markdown', action: 'add' },
  { kind: 'markdown', action: 'remove' },
  { kind: 'markdown', action: 'retarget' },
  { kind: 'folder', action: 'add' },
  { kind: 'folder', action: 'remove' },
  { kind: 'folder', action: 'retarget' },
  { kind: 'empty-folder', action: 'add' },
  { kind: 'empty-folder', action: 'remove' },
  { kind: 'empty-folder', action: 'retarget' },
] as const)(
  'a completed notice reconciles a $kind alias $action in real HTTP views',
  async ({ kind, action }) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const canonical = join(contentDir, 'canonical');
    mkdirSync(canonical);
    const target = kind === 'markdown' ? join(canonical, 'note.md') : canonical;
    if (kind !== 'empty-folder') writeFileSync(join(canonical, 'note.md'), '# Note\n');
    if (kind === 'folder') writeFileSync(join(canonical, 'data.csv'), 'data\n');
    writeDoc('asset.csv', 'control\n');
    const alias = join(contentDir, kind === 'markdown' ? 'linked.md' : 'linked-folder');
    const href =
      kind === 'markdown'
        ? 'linked.md'
        : kind === 'folder'
          ? 'linked-folder/note.md'
          : 'linked-folder/';
    const source = `# Source\n\n[Link](${href})\n\n[Control](asset.csv)\n${kind === 'folder' ? '\n[Data](linked-folder/data.csv)\n' : ''}`;
    const sourcePath = writeDoc('source.md', source);
    if (action !== 'add') symlinkSync(target, alias);
    const server = await bootInventoryServer();
    try {
      const subscription = nativeSubscriptionOn(contentDir);
      if (kind === 'empty-folder' && action !== 'add') {
        writeFileSync(sourcePath, source.replace('# Source', '# Source ready'));
        await subscription.deliver([{ type: 'update', path: sourcePath }]);
      }
      expect(await inventoryAuditBroken(server.port, href)).toBe(action === 'add');
      const beforeFiles = await inventoryForwardStatuses(server.port);
      expect(beforeFiles['asset.csv']).toBe('exact');
      if (kind === 'folder') {
        expect(beforeFiles['linked-folder/data.csv']).toBe(action === 'add' ? 'missing' : 'exact');
      }

      if (action === 'add') {
        symlinkSync(target, alias);
      } else {
        unlinkSync(alias);
        if (action === 'retarget') {
          const replacement = join(contentDir, 'replacement');
          if (kind === 'folder') {
            mkdirSync(replacement);
            writeFileSync(join(replacement, 'data.csv'), 'replacement\n');
            symlinkSync(replacement, alias);
          } else {
            symlinkSync(replacement, alias);
          }
        }
      }

      for (const _notice of [1, 2]) {
        await subscription.deliver([], new Error(notices[0]));
        expect(await inventoryAuditBroken(server.port, href)).toBe(action !== 'add');
        const files = await inventoryForwardStatuses(server.port);
        expect(files['asset.csv']).toBe('exact');
        if (kind === 'folder') {
          expect(files['linked-folder/data.csv']).toBe(action === 'remove' ? 'missing' : 'exact');
        }
      }
      if (kind !== 'empty-folder')
        expect(readFileSync(join(canonical, 'note.md'), 'utf8')).toBe('# Note\n');
    } finally {
      await server.destroy();
    }
  },
);

test('completed recovery observes final alias maps and generation on repeated notices', async () => {
  const canonical = writeDoc('canonical.md', '# Canonical\n');
  const folder = join(contentDir, 'canonical-folder');
  mkdirSync(folder);
  writeFileSync(join(folder, 'note.md'), '# Note\n');
  let watcher: WatcherHandle | undefined;
  const completed: Array<{
    generation: number;
    markdownAlias: string | undefined;
    folderAlias: string | undefined;
    fileAliases: string[];
  }> = [];
  const options = {
    forceBackend: 'parcel' as const,
    platform: 'darwin' as const,
    onRecoveryComplete: async () => {
      if (!watcher) throw new Error('watcher not ready');
      completed.push({
        generation: watcher.getFileIndexGeneration(),
        markdownAlias: watcher.getAliasMap().get('linked'),
        folderAlias: watcher.getFolderAliasIndex().get('linked-folder'),
        fileAliases: watcher.getFileIndex().get('canonical')?.aliases ?? [],
      });
    },
  };
  watcher = await startWatcher(contentDir, async () => {}, undefined, options);
  handles.push(watcher);
  const initialGeneration = watcher.getFileIndexGeneration();
  const markdownAlias = join(contentDir, 'linked.md');
  const folderAlias = join(contentDir, 'linked-folder');
  symlinkSync(canonical, markdownAlias);
  symlinkSync(folder, folderAlias);

  await deliverNotice(contentDir);
  expect(completed).toHaveLength(1);
  expect(completed[0]).toMatchObject({
    markdownAlias: 'canonical',
    folderAlias: 'canonical-folder',
    fileAliases: expect.arrayContaining(['linked']),
  });
  expect(completed[0].generation).toBeGreaterThan(initialGeneration);
  expect.soft(completed[0].generation).toBe(watcher.getFileIndexGeneration());

  await deliverNotice(contentDir);
  expect(completed).toHaveLength(2);
  expect(completed[1].generation).toBeGreaterThan(completed[0].generation);
  expect.soft(completed[1].generation).toBe(watcher.getFileIndexGeneration());
  expect(completed[1]).toMatchObject({
    markdownAlias: 'canonical',
    folderAlias: 'canonical-folder',
  });

  const other = writeDoc('other.md', '# Other\n');
  const otherFolder = join(contentDir, 'other-folder');
  mkdirSync(otherFolder);
  unlinkSync(markdownAlias);
  symlinkSync(other, markdownAlias);
  unlinkSync(folderAlias);
  symlinkSync(otherFolder, folderAlias);
  await deliverNotice(contentDir);
  expect(completed).toHaveLength(3);
  expect(completed[2]).toMatchObject({ markdownAlias: 'other', folderAlias: 'other-folder' });

  unlinkSync(markdownAlias);
  unlinkSync(folderAlias);
  await deliverNotice(contentDir);
  expect(completed).toHaveLength(4);
  expect(completed[3]).toMatchObject({ markdownAlias: undefined, folderAlias: undefined });
  expect(readFileSync(canonical, 'utf8')).toBe('# Canonical\n');
  expect(readFileSync(other, 'utf8')).toBe('# Other\n');
});

test('an incomplete directory observation does not report inventory completion', async () => {
  const target = writeDoc('canonical.md', '# Canonical\n');
  const completed: string[] = [];
  const options = {
    forceBackend: 'parcel' as const,
    platform: 'darwin' as const,
    onRecoveryComplete: async () => {
      completed.push('complete');
    },
  };
  const watcher = await startWatcher(contentDir, async () => {}, undefined, options);
  handles.push(watcher);
  symlinkSync(target, join(contentDir, 'linked.md'));
  deniedDirectoryRead.path = contentDir;

  await deliverNotice(contentDir);
  expect(deniedDirectoryRead.path).toBeNull();
  expect(completed).toEqual([]);
  expect(watcher.getAliasMap().has('linked')).toBe(false);

  await deliverNotice(contentDir);
  expect(completed).toEqual(['complete']);
  expect(watcher.getAliasMap().get('linked')).toBe('canonical');
});

test('notice delivery and release wait for the completed-inventory callback', async () => {
  const target = writeDoc('canonical.md', '# Canonical\n');
  const entered = deferred();
  const resume = deferred();
  const completed: string[] = [];
  const options = {
    forceBackend: 'parcel' as const,
    platform: 'darwin' as const,
    onRecoveryComplete: async () => {
      entered.release();
      await resume.promise;
      completed.push('callback');
    },
  };
  const watcher = await startWatcher(contentDir, async () => {}, undefined, options);
  handles.push(watcher);
  symlinkSync(target, join(contentDir, 'linked.md'));
  const delivery = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  let deliverySettled = false;
  void delivery.then(() => {
    deliverySettled = true;
  });
  try {
    const first = await Promise.race([
      entered.promise.then(() => 'callback-entered'),
      delivery.then(() => 'delivery-settled'),
    ]);
    expect(first).toBe('callback-entered');
    expect(deliverySettled).toBe(false);
    let releaseSettled = false;
    const releasing = watcher.unsubscribe().then(() => {
      releaseSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(releaseSettled).toBe(false);
    resume.release();
    await Promise.all([delivery, releasing]);
    expect(completed).toEqual(['callback']);
    expect(deliverySettled).toBe(true);
    expect(releaseSettled).toBe(true);
    expect(nativeSubscriptionOn(contentDir).nativeReleases()).toBeGreaterThan(0);
  } finally {
    resume.release();
    await delivery;
  }
});

test('alias-only recovery publishes a local-targets stateless frame from the real server', async () => {
  vi.useRealTimers();
  mkdirSync(join(contentDir, 'canonical'));
  const target = join(contentDir, 'canonical', 'note.md');
  writeFileSync(target, '# Note\n');
  writeDoc('source.md', '# Source\n\n[Link](linked.md)\n');
  const server = await bootInventoryServer();
  try {
    expect(await inventoryAuditBroken(server.port, 'linked.md')).toBe(true);
    const systemDoc = server.serverInstance.hocuspocus.documents.get('__system__');
    expect(systemDoc).toBeDefined();
    if (!systemDoc) throw new Error('system document unavailable');
    const originalBroadcast = systemDoc.broadcastStateless.bind(systemDoc);
    let resolveFrame!: () => void;
    const frame = new Promise<void>((resolve) => {
      resolveFrame = resolve;
    });
    let observingNotice = false;
    const outbound = vi.spyOn(systemDoc, 'broadcastStateless').mockImplementation((payload) => {
      const result = originalBroadcast(payload);
      try {
        if (observingNotice && (JSON.parse(payload) as { ch?: string }).ch === 'local-targets') {
          resolveFrame();
        }
      } catch {
        return result;
      }
      return result;
    });
    const signal = vi.spyOn(server.serverInstance.cc1Broadcaster, 'signal');
    const localFrames = () =>
      outbound.mock.calls.filter(([payload]) => {
        try {
          return (JSON.parse(payload) as { ch?: string }).ch === 'local-targets';
        } catch {
          return false;
        }
      }).length;
    const previousFrames = localFrames();
    const previousSignals = signal.mock.calls.filter(
      ([channel]) => channel === 'local-targets',
    ).length;
    observingNotice = true;
    symlinkSync(target, join(contentDir, 'linked.md'));
    await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    expect(
      signal.mock.calls.filter(([channel]) => channel === 'local-targets').length,
    ).toBeGreaterThan(previousSignals);
    await frame;
    expect(localFrames()).toBeGreaterThan(previousFrames);
    expect(await inventoryAuditBroken(server.port, 'linked.md')).toBe(false);
  } finally {
    await server.destroy();
  }
});

test.each(['markdown', 'empty-folder'] as const)(
  'a valid %s alias retarget keeps its real HTTP assessment exact',
  async (kind) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const first = join(contentDir, 'first');
    const second = join(contentDir, 'second');
    mkdirSync(first);
    mkdirSync(second);
    const targetA = kind === 'markdown' ? join(first, 'note.md') : first;
    const targetB = kind === 'markdown' ? join(second, 'note.md') : second;
    if (kind === 'markdown') {
      writeFileSync(targetA, '# First\n');
      writeFileSync(targetB, '# Second\n');
    }
    const alias = join(contentDir, kind === 'markdown' ? 'linked.md' : 'linked-folder');
    const href = kind === 'markdown' ? 'linked.md' : 'linked-folder/';
    symlinkSync(targetA, alias);
    const source = `# Source\n\n[Link](${href})\n\n[Control](asset.csv)\n`;
    const sourcePath = writeDoc('source.md', source);
    writeDoc('asset.csv', 'control\n');
    const server = await bootInventoryServer();
    try {
      const subscription = nativeSubscriptionOn(contentDir);
      if (kind === 'empty-folder') {
        writeFileSync(sourcePath, source.replace('# Source', '# Source ready'));
        await subscription.deliver([{ type: 'update', path: sourcePath }]);
      }
      expect(await inventoryAuditBroken(server.port, href)).toBe(false);
      expect((await inventoryForwardStatuses(server.port))['asset.csv']).toBe('exact');
      unlinkSync(alias);
      symlinkSync(targetB, alias);
      await subscription.deliver([], new Error(notices[0]));
      expect(await inventoryAuditBroken(server.port, href)).toBe(false);
      expect((await inventoryForwardStatuses(server.port))['asset.csv']).toBe('exact');
      await subscription.deliver([], new Error(notices[0]));
      expect(await inventoryAuditBroken(server.port, href)).toBe(false);
      if (kind === 'markdown') expect(readFileSync(targetB, 'utf8')).toBe('# Second\n');
    } finally {
      await server.destroy();
    }
  },
);

test('overlapping content and HEAD notices settle the owned Git branch and alias assessment', async () => {
  vi.useRealTimers();
  const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: contentDir, env: gitEnv, encoding: 'utf8' }).trim();
  git(['init', '--quiet', '--initial-branch=main']);
  configureTestGitRepository(contentDir);
  git(['config', 'user.email', 'notice-test@example.com']);
  git(['config', 'user.name', 'Notice Test']);
  const canonical = join(contentDir, 'canonical');
  mkdirSync(canonical);
  writeFileSync(join(canonical, 'note.md'), '# Note\n');
  const sourcePath = writeDoc('source.md', '# Main\n\n[Link](linked.md)\n');
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'main state']);
  git(['checkout', '--quiet', '-b', 'feature']);
  writeFileSync(sourcePath, '# Feature\n\n[Link](linked.md)\n');
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'feature state']);
  git(['checkout', '--quiet', 'main']);
  const server = await bootCompositionRig(contentDir);
  const entered = deferred();
  const resume = deferred();
  let contentNotice: Promise<void> | undefined;
  let headNotice: Promise<void> | undefined;
  try {
    await server.ready;
    expect(await inventoryAuditBroken(server.port, 'linked.md')).toBe(true);
    const broadcaster = server.serverInstance.cc1Broadcaster;
    const originalEmit = broadcaster.emitBranchSwitched.bind(broadcaster);
    let resolveBranch!: (branch: string) => void;
    const branchSettled = new Promise<string>((resolve) => {
      resolveBranch = resolve;
    });
    vi.spyOn(broadcaster, 'emitBranchSwitched').mockImplementation((branch) => {
      originalEmit(branch);
      resolveBranch(branch);
    });

    symlinkSync(join(canonical, 'note.md'), join(contentDir, 'linked.md'));
    scanSchedule.holdPath = contentDir;
    scanSchedule.entered = entered.release;
    scanSchedule.resume = resume.promise;
    contentNotice = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    const scanEntered = await Promise.race([
      entered.promise.then(() => true),
      contentNotice.then(() => false),
    ]);
    expect(scanEntered).toBe(true);
    git(['checkout', '--quiet', 'feature']);
    headNotice = nativeSubscriptionOn(join(contentDir, '.git')).deliver([], new Error(notices[0]));
    resume.release();
    await Promise.all([contentNotice, headNotice]);
    expect(await branchSettled).toBe('feature');
    expect(git(['branch', '--show-current'])).toBe('feature');
    expect(readFileSync(sourcePath, 'utf8')).toContain('# Feature');
    const documentResponse = await fetch(
      `http://127.0.0.1:${server.port}/api/document?docName=source`,
    );
    expect(documentResponse.status).toBe(200);
    const document = (await documentResponse.json()) as { content: string };
    expect(document.content).toContain('# Feature');
    expect(await inventoryAuditBroken(server.port, 'linked.md')).toBe(false);
  } finally {
    resume.release();
    await Promise.allSettled([contentNotice, headNotice].filter((value) => value !== undefined));
    await server.destroy();
  }
});

test.each(['realpath', 'stat'] as const)(
  'an unreadable former alias target during %s preserves later records and known state',
  async (operation) => {
    const blocked = join(contentDir, 'blocked');
    mkdirSync(blocked);
    const prior = writeDoc('blocked/real.csv', 'prior\n');
    const other = writeDoc('other.csv', 'other,more\n');
    const alias = join(contentDir, 'alias.csv');
    symlinkSync(prior, alias);
    scanSchedule.orderedPath = contentDir;
    scanSchedule.firstEntry = 'alias.csv';
    const priorStat = statSync(prior);
    const events: DiskEvent[] = [];
    const completed: string[] = [];
    const logger = getLogger('file-watcher');
    const warnings = vi.spyOn(logger, 'warn');
    const errors = vi.spyOn(logger, 'error');
    const watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      {
        forceBackend: 'parcel',
        platform: 'darwin',
        onRecoveryComplete: async () => {
          completed.push('complete');
        },
      },
    );
    handles.push(watcher);
    expect(indexedAliasOwner(watcher, 'alias.csv')?.canonicalPath).toBe(prior);
    unlinkSync(alias);
    symlinkSync(other, alias);
    const later = writeDoc('later.csv', 'later\n');
    denyAdmission(operation, prior);
    deniedDirectoryRead.path = blocked;

    await deliverNotice(contentDir, [
      { type: 'update', path: alias },
      { type: 'create', path: later },
    ]);

    expect(admissionFault.observed).toBe(true);
    expect
      .soft(events)
      .toContainEqual(
        expect.objectContaining({ kind: 'file-create', path: later, relativePath: 'later.csv' }),
      );
    expect.soft(Boolean(indexedRow(watcher, 'later.csv', 'file'))).toBe(true);
    expect.soft(deniedDirectoryRead.path).toBeNull();
    expect(completed).toEqual([]);
    const priorEntries = indexedIdentityRows(watcher).filter(
      (entry) => entry.canonicalPath === prior,
    );
    expect(priorEntries).toHaveLength(1);
    expect(priorEntries[0]).toMatchObject({
      size: priorStat.size,
      modified: priorStat.mtime.toISOString(),
      inode: Number(priorStat.ino),
    });
    const diagnostic = JSON.stringify([...warnings.mock.calls, ...errors.mock.calls]);
    expect(diagnostic).toContain('EACCES');
    expect(diagnostic).toContain(JSON.stringify(prior).slice(1, -1));
    expect(
      events.filter((event) => event.kind === 'file-delete' || event.kind === 'delete'),
    ).toEqual([]);

    clearAdmissionDenial();
    deniedDirectoryRead.path = null;
    writeFileSync(prior, 'restored,prior,content\n');
    await deliverNotice(contentDir);

    expect(completed).toEqual(['complete']);
    const entries = indexedIdentityRows(watcher);
    expect(entries.filter((entry) => entry.canonicalPath === prior)).toHaveLength(1);
    expect(entries.find((entry) => entry.canonicalPath === prior)?.size).toBe(
      Buffer.byteLength('restored,prior,content\n'),
    );
    expect(entries.filter((entry) => entry.canonicalPath === other)).toHaveLength(1);
    expect(entries.find((entry) => entry.canonicalPath === other)?.aliases).toContain('alias.csv');
    expect(Boolean(indexedRow(watcher, 'later.csv', 'file'))).toBe(true);
    expect(
      events.filter(
        (event) => event.kind === 'file-delete' && [prior, other, later].includes(event.path),
      ),
    ).toEqual([]);
  },
);

test('an unreadable former alias target retains readable sibling HTTP links', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const blocked = join(contentDir, 'blocked');
  mkdirSync(blocked);
  const prior = writeDoc('blocked/real.csv', 'prior\n');
  const other = writeDoc('other.csv', 'other\n');
  const alias = join(contentDir, 'alias.csv');
  symlinkSync(prior, alias);
  writeDoc(
    'source.md',
    '# Source\n\n[Former](blocked/real.csv)\n\n[Alias](alias.csv)\n\n[Later](later.csv)\n',
  );
  scanSchedule.orderedPath = contentDir;
  scanSchedule.firstEntry = 'alias.csv';
  const server = await bootInventoryServer();
  try {
    expect(await inventoryForwardStatuses(server.port)).toEqual({
      'blocked/real.csv': 'exact',
      'alias.csv': 'exact',
      'later.csv': 'missing',
    });
    unlinkSync(alias);
    symlinkSync(other, alias);
    const later = writeDoc('later.csv', 'later\n');
    denyAdmission('realpath', prior);
    deniedDirectoryRead.path = blocked;
    const subscription = nativeSubscriptionOn(contentDir);

    await subscription.deliver(
      [
        { type: 'update', path: alias },
        { type: 'create', path: later },
      ],
      new Error(notices[0]),
    );

    expect(admissionFault.observed).toBe(true);
    expect(readFileSync(later, 'utf8')).toBe('later\n');
    expect.soft(await inventoryForwardStatuses(server.port)).toEqual({
      'blocked/real.csv': 'exact',
      'alias.csv': 'exact',
      'later.csv': 'exact',
    });
    clearAdmissionDenial();
    deniedDirectoryRead.path = null;
    await subscription.deliver([], new Error(notices[0]));
    expect(await inventoryForwardStatuses(server.port)).toEqual({
      'blocked/real.csv': 'exact',
      'alias.csv': 'exact',
      'later.csv': 'exact',
    });
  } finally {
    clearAdmissionDenial();
    deniedDirectoryRead.path = null;
    await server.destroy();
  }
});

test.each([
  ['before', 'original'],
  ['during', 'original'],
  ['before', 'changed'],
  ['during', 'changed'],
] as const)(
  'public recreation %s recovery with %s bytes preserves the next rename lifecycle',
  async (timing, bytes) => {
    vi.useRealTimers();
    const gitEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
      cwd: contentDir,
      env: gitEnv,
    });
    configureTestGitRepository(contentDir);
    const originalBytes = '# Original\n\nEarlier bytes.\n';
    const recreatedBytes =
      bytes === 'original' ? originalBytes : '# Recreated\n\nDifferent bytes now.\n';
    mkdirSync(join(contentDir, '.ok', 'templates'), { recursive: true });
    writeFileSync(join(contentDir, '.ok', 'templates', 'recreated.md'), recreatedBytes);
    const first = writeDoc('first.md', '# First\n\nSeparate content.\n');
    const later = writeDoc('later.md', originalBytes);
    const moved = join(contentDir, 'moved.md');
    scanSchedule.orderedPath = contentDir;
    scanSchedule.firstEntry = 'first.md';
    let server: Awaited<ReturnType<typeof bootCompositionRig>> | undefined;
    const connections: Array<{ disconnect(): Promise<void> }> = [];
    let armed = false;
    let hookCount = 0;
    let recreationCount = 0;
    try {
      server = await bootCompositionRig(contentDir);
      await server.ready;
      const active = server;
      const firstConnection = await active.serverInstance.hocuspocus.openDirectConnection('first');
      connections.push(firstConnection);
      const laterConnection = await active.serverInstance.hocuspocus.openDirectConnection('later');
      connections.push(laterConnection);
      const lifecycle = laterConnection.document.getMap('lifecycle');
      expect(laterConnection.document.getText('source').toString()).toBe(originalBytes);
      const recreate = async () => {
        const response = await fetch(`http://127.0.0.1:${active.port}/api/create-page`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'later.md', template: 'recreated' }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ docName: 'later' });
        expect(readFileSync(later, 'utf8')).toBe(recreatedBytes);
        recreationCount += 1;
      };
      active.serverInstance.hocuspocus.configuration.extensions.push({
        async afterUnloadDocument({ documentName }: { documentName: string }) {
          if (!armed || documentName !== 'first') return;
          hookCount += 1;
          if (timing === 'during') await recreate();
        },
      });
      const subscription = nativeSubscriptionOn(contentDir);
      unlinkSync(first);
      unlinkSync(later);
      expect(existsSync(first)).toBe(false);
      expect(existsSync(later)).toBe(false);
      if (timing === 'before') await recreate();
      armed = true;
      await subscription.deliver([], new Error(notices[0]));
      armed = false;
      expect(hookCount).toBe(1);
      expect(recreationCount).toBe(1);
      expect(readFileSync(later, 'utf8')).toBe(recreatedBytes);
      expect(lifecycle.get('status')).toBeUndefined();
      expect(lifecycle.get('newPath')).toBeUndefined();
      const ringPath = (name: string) => `.../${basename(contentDir)}/${name}`;
      expect(
        getWatcherDecisionRingSnapshot().filter(
          (entry) => entry.decision === 'dispatched' && entry.path === ringPath('later.md'),
        ),
      ).toEqual([]);
      const afterRecoveryResponse = await fetch(`http://127.0.0.1:${active.port}/api/documents`);
      expect(afterRecoveryResponse.status).toBe(200);
      const afterRecovery = (await afterRecoveryResponse.json()) as {
        documents: Array<{ docName: string }>;
      };
      expect(afterRecovery.documents.map((document) => document.docName)).toContain('later');
      expect(afterRecovery.documents.map((document) => document.docName)).not.toContain('first');

      const beforeMove = readFileSync(later, 'utf8');
      renameSync(later, moved);
      expect(existsSync(later)).toBe(false);
      expect(readFileSync(moved, 'utf8')).toBe(beforeMove);
      await subscription.deliver([
        { type: 'delete', path: later },
        { type: 'create', path: moved },
      ]);
      const dispatched = getWatcherDecisionRingSnapshot()
        .filter(
          (entry) =>
            entry.decision === 'dispatched' &&
            (entry.path === ringPath('later.md') || entry.path === ringPath('moved.md')),
        )
        .map((entry) => entry.kind);
      const inventoryResponse = await fetch(`http://127.0.0.1:${active.port}/api/documents`);
      const movedResponse = await fetch(
        `http://127.0.0.1:${active.port}/api/document?docName=moved`,
      );
      expect.soft(inventoryResponse.status).toBe(200);
      const inventory = (await inventoryResponse.json()) as {
        documents: Array<{ docName: string }>;
      };
      expect.soft(inventory.documents.map((document) => document.docName)).toContain('moved');
      expect.soft(inventory.documents.map((document) => document.docName)).not.toContain('later');
      expect.soft(movedResponse.status).toBe(200);
      const movedDocument = (await movedResponse.json()) as { content: string };
      expect.soft(movedDocument.content).toBe(recreatedBytes);
      expect.soft(dispatched).toEqual(['rename']);
      expect.soft(lifecycle.get('status')).toBe('renamed');
      expect.soft(lifecycle.get('newPath')).toBe('moved');
    } finally {
      armed = false;
      try {
        await Promise.all(connections.map((connection) => connection.disconnect()));
      } finally {
        try {
          await server?.destroy();
        } finally {
          const dirs = nativeSubscriptionDirs();
          const releases = dirs.map((dir) => nativeSubscriptionOn(dir).nativeReleases());
          rmSync(contentDir, { recursive: true, force: true });
          expect(existsSync(contentDir)).toBe(false);
          expect(dirs).toHaveLength(2);
          expect(releases).toEqual([1, 1]);
        }
      }
    }
  },
);

test.each(['before', 'during'] as const)(
  'a supplied later delete follows %s-notice public recreation and the completed scan restores inventory',
  async (timing) => {
    vi.useRealTimers();
    const gitEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
      cwd: contentDir,
      env: gitEnv,
    });
    configureTestGitRepository(contentDir);
    const recreatedBytes = '# Recreated\n\nContent after the supplied deletes.\n';
    mkdirSync(join(contentDir, '.ok', 'templates'), { recursive: true });
    writeFileSync(join(contentDir, '.ok', 'templates', 'recreated.md'), recreatedBytes);
    const first = writeDoc('first.md', '# First\n');
    const later = writeDoc('later.md', '# Earlier later\n');
    let server: Awaited<ReturnType<typeof bootCompositionRig>> | undefined;
    const connections: Array<{ disconnect(): Promise<void> }> = [];
    const phases: string[] = [];
    let armed = false;
    let recreations = 0;
    try {
      server = await bootCompositionRig(contentDir);
      await server.ready;
      const active = server;
      connections.push(await active.serverInstance.hocuspocus.openDirectConnection('first'));
      connections.push(await active.serverInstance.hocuspocus.openDirectConnection('later'));
      const recreate = async () => {
        const response = await fetch(`http://127.0.0.1:${active.port}/api/create-page`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'later.md', template: 'recreated' }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ docName: 'later' });
        expect(readFileSync(later, 'utf8')).toBe(recreatedBytes);
        recreations += 1;
        phases.push('recreated');
      };
      active.serverInstance.hocuspocus.configuration.extensions.push({
        async afterUnloadDocument({ documentName }: { documentName: string }) {
          if (!armed) return;
          if (documentName === 'first') {
            phases.push('first-unloaded');
            if (timing === 'during') await recreate();
          } else if (documentName === 'later') {
            phases.push('later-unloaded');
          }
        },
      });
      unlinkSync(first);
      unlinkSync(later);
      expect(existsSync(first)).toBe(false);
      expect(existsSync(later)).toBe(false);
      if (timing === 'before') await recreate();
      armed = true;
      await nativeSubscriptionOn(contentDir).deliver(
        [
          { type: 'delete', path: first },
          { type: 'delete', path: later },
        ],
        new Error(notices[0]),
      );
      armed = false;
      expect(phases).toEqual(
        timing === 'before'
          ? ['recreated', 'first-unloaded', 'later-unloaded']
          : ['first-unloaded', 'recreated', 'later-unloaded'],
      );
      expect(recreations).toBe(1);
      expect(readFileSync(later, 'utf8')).toBe(recreatedBytes);
      const inventoryResponse = await fetch(`http://127.0.0.1:${active.port}/api/documents`);
      expect(inventoryResponse.status).toBe(200);
      const inventory = (await inventoryResponse.json()) as {
        documents: Array<{ docName: string }>;
      };
      expect.soft(inventory.documents.map((document) => document.docName)).toContain('later');
      const contentResponse = await fetch(
        `http://127.0.0.1:${active.port}/api/document?docName=later`,
      );
      expect.soft(contentResponse.status).toBe(200);
      const content = (await contentResponse.json()) as { content: string };
      expect.soft(content.content).toBe(recreatedBytes);
    } finally {
      armed = false;
      try {
        await Promise.all(connections.map((connection) => connection.disconnect()));
      } finally {
        try {
          await server?.destroy();
        } finally {
          const dirs = nativeSubscriptionDirs();
          const releases = dirs.map((dir) => nativeSubscriptionOn(dir).nativeReleases());
          rmSync(contentDir, { recursive: true, force: true });
          expect(existsSync(contentDir)).toBe(false);
          expect(dirs).toHaveLength(2);
          expect(releases).toEqual([1, 1]);
        }
      }
    }
  },
);

test('a public file created during directory observation keeps its next rename identity', async () => {
  const { watcher, events } = await watchContent();
  const entered = deferred();
  const resume = deferred();
  scanSchedule.holdPath = contentDir;
  scanSchedule.entered = entered.release;
  scanSchedule.resume = resume.promise;
  const pending = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  try {
    await entered.promise;
    const created = writeDoc('observed-later.md', '# Created during observation\n');
    watcher.mutateFileIndex({
      kind: 'create',
      path: created,
      docName: 'observed-later',
      content: '# Created during observation\n',
    });
    expect(watcher.getFileIndex().get('observed-later')?.canonicalPath).toBe(created);
    resume.release();
    await pending;
    await vi.runAllTimersAsync();
    expect(events).toEqual([]);
    expect(readFileSync(created, 'utf8')).toBe('# Created during observation\n');
    expect(watcher.getFileIndex().get('observed-later')?.canonicalPath).toBe(created);

    const moved = join(contentDir, 'observed-moved.md');
    renameSync(created, moved);
    expect(readFileSync(moved, 'utf8')).toBe('# Created during observation\n');
    await deliver(contentDir, [
      { type: 'delete', path: created },
      { type: 'create', path: moved },
    ]);
    expect(events).toEqual([
      {
        kind: 'rename',
        oldPath: created,
        newPath: moved,
        oldDocName: 'observed-later',
        newDocName: 'observed-moved',
        content: '# Created during observation\n',
      },
    ]);
    expect(watcher.getFileIndex().has('observed-later')).toBe(false);
    expect(watcher.getFileIndex().get('observed-moved')?.canonicalPath).toBe(moved);
  } finally {
    resume.release();
    await pending;
  }
});

test('two public updates during a captured classification read keep the latest rename identity', async () => {
  const path = writeDoc('changing.md', '# Initial\n');
  const { watcher, events } = await watchContent();
  const entered = deferred();
  const resume = deferred();
  const observed = '# Observed externally\n';
  const newer = '# Newer publicly\n';
  const latest = '# Latest publicly\n';
  classificationReadSchedule.path = path;
  classificationReadSchedule.holdRead = 2;
  classificationReadSchedule.entered = entered.release;
  classificationReadSchedule.resume = resume.promise;
  writeFileSync(path, observed);
  const pending = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  try {
    await entered.promise;
    expect(classificationReadSchedule.seen).toEqual([observed, observed]);
    expect(classificationReadSchedule.captured).toBe(observed);
    writeFileSync(path, newer);
    watcher.mutateFileIndex({ kind: 'update', path, docName: 'changing', content: newer });
    writeFileSync(path, latest);
    watcher.mutateFileIndex({ kind: 'update', path, docName: 'changing', content: latest });
    expect(watcher.getFileIndex().get('changing')?.size).toBe(Buffer.byteLength(latest));
    resume.release();
    await pending;
    await vi.runAllTimersAsync();
    expect(readFileSync(path, 'utf8')).toBe(latest);
    expect(watcher.getFileIndex().get('changing')?.size).toBe(Buffer.byteLength(latest));
    expect(events).toEqual([]);

    const moved = join(contentDir, 'changed-moved.md');
    renameSync(path, moved);
    expect(readFileSync(moved, 'utf8')).toBe(latest);
    await deliver(contentDir, [
      { type: 'delete', path },
      { type: 'create', path: moved },
    ]);
    expect(events).toEqual([
      {
        kind: 'rename',
        oldPath: path,
        newPath: moved,
        oldDocName: 'changing',
        newDocName: 'changed-moved',
        content: latest,
      },
    ]);
    expect(watcher.getFileIndex().get('changed-moved')?.canonicalPath).toBe(moved);
  } finally {
    resume.release();
    await pending;
  }
});

test.each(['before', 'during'] as const)(
  'a public rename %s recovery preserves both old-path creation and destination rename',
  async (timing) => {
    const trigger = writeDoc('rename-trigger.md', '# Trigger\n');
    const source = writeDoc('rename-source.md', '# Moved publicly\n');
    const destination = join(contentDir, 'rename-destination.md');
    const third = join(contentDir, 'rename-third.md');
    const events: DiskEvent[] = [];
    let watcher: WatcherHandle | undefined;
    let publicRenames = 0;
    const publiclyRename = () => {
      renameSync(source, destination);
      watcher?.mutateFileIndex({
        kind: 'rename',
        oldPath: source,
        newPath: destination,
        oldDocName: 'rename-source',
        newDocName: 'rename-destination',
        content: '# Moved publicly\n',
      });
      publicRenames += 1;
    };
    watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
        if (timing === 'during' && event.kind === 'delete' && event.docName === 'rename-trigger') {
          publiclyRename();
        }
      },
      undefined,
      { forceBackend: 'parcel', platform: 'darwin' },
    );
    handles.push(watcher);
    if (timing === 'before') publiclyRename();
    unlinkSync(trigger);
    await deliverNotice(contentDir);
    expect(publicRenames).toBe(1);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(destination, 'utf8')).toBe('# Moved publicly\n');
    expect(watcher.getFileIndex().has('rename-source')).toBe(false);
    expect(watcher.getFileIndex().get('rename-destination')?.canonicalPath).toBe(destination);
    events.length = 0;

    writeFileSync(source, '# Distinct recreated source\n');
    renameSync(destination, third);
    expect(readFileSync(source, 'utf8')).toBe('# Distinct recreated source\n');
    expect(readFileSync(third, 'utf8')).toBe('# Moved publicly\n');
    await deliver(contentDir, [
      { type: 'create', path: source },
      { type: 'delete', path: destination },
      { type: 'create', path: third },
    ]);
    expect(events).toEqual([
      {
        kind: 'rename',
        oldPath: destination,
        newPath: third,
        oldDocName: 'rename-destination',
        newDocName: 'rename-third',
        content: '# Moved publicly\n',
      },
      {
        kind: 'create',
        path: source,
        docName: 'rename-source',
        content: '# Distinct recreated source\n',
      },
    ]);
    expect(watcher.getFileIndex().get('rename-source')?.canonicalPath).toBe(source);
    expect(watcher.getFileIndex().get('rename-third')?.canonicalPath).toBe(third);
  },
);

test('a public delete after a recovery-time upsert leaves the next external create new', async () => {
  const { watcher, events } = await watchContent();
  const entered = deferred();
  const resume = deferred();
  scanSchedule.holdPath = contentDir;
  scanSchedule.entered = entered.release;
  scanSchedule.resume = resume.promise;
  const pending = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  try {
    await entered.promise;
    const path = writeDoc('transient.md', '# Public transient\n');
    watcher.mutateFileIndex({
      kind: 'create',
      path,
      docName: 'transient',
      content: '# Public transient\n',
    });
    expect(watcher.getFileIndex().has('transient')).toBe(true);
    unlinkSync(path);
    watcher.mutateFileIndex({ kind: 'delete', path, docName: 'transient' });
    expect(existsSync(path)).toBe(false);
    expect(watcher.getFileIndex().has('transient')).toBe(false);
    resume.release();
    await pending;
    await vi.runAllTimersAsync();
    expect(events).toEqual([]);
    expect(watcher.getFileIndex().has('transient')).toBe(false);
    expect(existsSync(path)).toBe(false);

    writeFileSync(path, '# Externally new and different\n');
    await deliver(contentDir, [{ type: 'create', path }]);
    expect(events).toEqual([
      {
        kind: 'create',
        path,
        docName: 'transient',
        content: '# Externally new and different\n',
      },
    ]);
    expect(watcher.getFileIndex().get('transient')?.canonicalPath).toBe(path);
  } finally {
    resume.release();
    await pending;
  }
});

test('a public recreation survives a rejected recovery consumer and later notices still run', async () => {
  const first = writeDoc('failed-first.md', '# First\n');
  const later = writeDoc('failed-later.md', '# Original\n');
  const moved = join(contentDir, 'failed-moved.md');
  const failure = new Error('public recreation consumer rejected');
  const errors = vi.spyOn(getLogger('file-watcher'), 'error');
  const events: DiskEvent[] = [];
  const completed: string[] = [];
  let watcher: WatcherHandle | undefined;
  let recreated = false;
  watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
      if (event.kind !== 'delete' || event.docName !== 'failed-first') return;
      writeFileSync(later, '# Publicly recreated after failure\n');
      watcher?.mutateFileIndex({
        kind: 'create',
        path: later,
        docName: 'failed-later',
        content: '# Publicly recreated after failure\n',
      });
      recreated = true;
      throw failure;
    },
    undefined,
    {
      forceBackend: 'parcel',
      platform: 'darwin',
      onRecoveryComplete: async () => {
        completed.push('complete');
      },
    },
  );
  handles.push(watcher);
  unlinkSync(first);
  unlinkSync(later);
  await deliverNotice(contentDir);
  expect(recreated).toBe(true);
  expect(errors.mock.calls.some(([detail]) => detail.err === failure)).toBe(true);
  expect(completed).toEqual([]);
  expect(readFileSync(later, 'utf8')).toBe('# Publicly recreated after failure\n');
  expect(watcher.getFileIndex().get('failed-later')?.canonicalPath).toBe(later);
  events.length = 0;

  renameSync(later, moved);
  expect(readFileSync(moved, 'utf8')).toBe('# Publicly recreated after failure\n');
  await deliver(contentDir, [
    { type: 'delete', path: later },
    { type: 'create', path: moved },
  ]);
  expect.soft(events).toEqual([
    {
      kind: 'rename',
      oldPath: later,
      newPath: moved,
      oldDocName: 'failed-later',
      newDocName: 'failed-moved',
      content: '# Publicly recreated after failure\n',
    },
  ]);
  const omitted = writeDoc('failure-omitted.md', '# Omitted after failure\n');
  await deliverNotice(contentDir);
  expect(completed).toEqual(['complete']);
  expect(events).toContainEqual({
    kind: 'create',
    path: omitted,
    docName: 'failure-omitted',
    content: '# Omitted after failure\n',
  });
  expect(watcher.getFileIndex().get('failure-omitted')?.canonicalPath).toBe(omitted);
});

test('an incomplete directory observation retains a concurrent public write for its next rename', async () => {
  const blocked = join(contentDir, 'blocked');
  mkdirSync(blocked);
  writeDoc('blocked/known.md', '# Known\n');
  const completed: string[] = [];
  const events: DiskEvent[] = [];
  const logger = getLogger('file-watcher');
  const warnings = vi.spyOn(logger, 'warn');
  const errors = vi.spyOn(logger, 'error');
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
    },
    undefined,
    {
      forceBackend: 'parcel',
      platform: 'darwin',
      onRecoveryComplete: async () => {
        completed.push('complete');
      },
    },
  );
  handles.push(watcher);
  const entered = deferred();
  const resume = deferred();
  scanSchedule.holdPath = contentDir;
  scanSchedule.entered = entered.release;
  scanSchedule.resume = resume.promise;
  const pending = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  try {
    await entered.promise;
    const created = writeDoc('incomplete-public.md', '# Public during incomplete scan\n');
    watcher.mutateFileIndex({
      kind: 'create',
      path: created,
      docName: 'incomplete-public',
      content: '# Public during incomplete scan\n',
    });
    deniedDirectoryRead.path = blocked;
    resume.release();
    await pending;
    await vi.runAllTimersAsync();
    expect(deniedDirectoryRead.path).toBeNull();
    expect(JSON.stringify([...warnings.mock.calls, ...errors.mock.calls])).toContain('EACCES');
    expect(completed).toEqual([]);
    expect(readFileSync(created, 'utf8')).toBe('# Public during incomplete scan\n');
    expect(watcher.getFileIndex().get('incomplete-public')?.canonicalPath).toBe(created);
    expect(watcher.getFileIndex().has('blocked/known')).toBe(true);
    expect(events).toEqual([]);

    const moved = join(contentDir, 'incomplete-moved.md');
    renameSync(created, moved);
    expect(readFileSync(moved, 'utf8')).toBe('# Public during incomplete scan\n');
    await deliver(contentDir, [
      { type: 'delete', path: created },
      { type: 'create', path: moved },
    ]);
    expect.soft(events).toEqual([
      {
        kind: 'rename',
        oldPath: created,
        newPath: moved,
        oldDocName: 'incomplete-public',
        newDocName: 'incomplete-moved',
        content: '# Public during incomplete scan\n',
      },
    ]);
    const omitted = writeDoc('after-incomplete.md', '# Later complete scan\n');
    await deliverNotice(contentDir);
    expect(completed).toEqual(['complete']);
    expect(watcher.getFileIndex().get('after-incomplete')?.canonicalPath).toBe(omitted);
  } finally {
    deniedDirectoryRead.path = null;
    resume.release();
    await pending;
  }
});

test('a public write in the awaited recovery-complete callback keeps its next rename identity', async () => {
  const entered = deferred();
  const resume = deferred();
  const events: DiskEvent[] = [];
  const completed: string[] = [];
  const created = join(contentDir, 'completed-public.md');
  let watcher: WatcherHandle | undefined;
  watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
    },
    undefined,
    {
      forceBackend: 'parcel',
      platform: 'darwin',
      onRecoveryComplete: async () => {
        entered.release();
        await resume.promise;
        writeFileSync(created, '# Written at completion\n');
        watcher?.mutateFileIndex({
          kind: 'create',
          path: created,
          docName: 'completed-public',
          content: '# Written at completion\n',
        });
        completed.push('complete');
      },
    },
  );
  handles.push(watcher);
  const pending = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  try {
    await entered.promise;
    expect(completed).toEqual([]);
    expect(existsSync(created)).toBe(false);
    expect(watcher.getFileIndex().has('completed-public')).toBe(false);
    const deliveryEndedBeforeRelease = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
    expect(deliveryEndedBeforeRelease).toBe(false);
    resume.release();
    await pending;
    await vi.runAllTimersAsync();
    expect(completed).toEqual(['complete']);
    expect(readFileSync(created, 'utf8')).toBe('# Written at completion\n');
    expect(watcher.getFileIndex().get('completed-public')?.canonicalPath).toBe(created);
    expect(events).toEqual([]);

    const moved = join(contentDir, 'completed-moved.md');
    renameSync(created, moved);
    expect(readFileSync(moved, 'utf8')).toBe('# Written at completion\n');
    await deliver(contentDir, [
      { type: 'delete', path: created },
      { type: 'create', path: moved },
    ]);
    expect(events).toEqual([
      {
        kind: 'rename',
        oldPath: created,
        newPath: moved,
        oldDocName: 'completed-public',
        newDocName: 'completed-moved',
        content: '# Written at completion\n',
      },
    ]);
    expect(watcher.getFileIndex().get('completed-moved')?.canonicalPath).toBe(moved);
  } finally {
    resume.release();
    await pending;
  }
});

test.each(['outside', 'after-complete', 'after-failed'] as const)(
  'a public index-only write %s recovery remains a first ordinary create',
  async (phase) => {
    const events: DiskEvent[] = [];
    const completed: string[] = [];
    let failedCallbacks = 0;
    const watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
        if (
          phase === 'after-failed' &&
          event.kind === 'create' &&
          event.docName === 'failure-trigger'
        ) {
          failedCallbacks += 1;
          throw new Error('ordinary control failed notice');
        }
      },
      undefined,
      {
        forceBackend: 'parcel',
        platform: 'darwin',
        onRecoveryComplete: async () => {
          completed.push('complete');
        },
      },
    );
    handles.push(watcher);
    if (phase === 'after-complete') {
      await deliverNotice(contentDir);
      expect(completed).toEqual(['complete']);
    } else if (phase === 'after-failed') {
      writeDoc('failure-trigger.md', '# Trigger\n');
      await deliverNotice(contentDir);
      expect(failedCallbacks).toBe(1);
      expect(completed).toEqual([]);
    }
    events.length = 0;
    const path = writeDoc('ordinary-public.md', '# Public index only\n');
    watcher.mutateFileIndex({
      kind: 'create',
      path,
      docName: 'ordinary-public',
      content: '# Public index only\n',
    });
    expect(watcher.getFileIndex().get('ordinary-public')?.canonicalPath).toBe(path);
    await deliver(contentDir, [{ type: 'create', path }]);
    expect(events).toEqual([
      {
        kind: 'create',
        path,
        docName: 'ordinary-public',
        content: '# Public index only\n',
      },
    ]);
  },
);

test('a rejected reserved public mutation during recovery leaves its first classification new', async () => {
  const { watcher, events } = await watchContent();
  const entered = deferred();
  const resume = deferred();
  scanSchedule.holdPath = contentDir;
  scanSchedule.entered = entered.release;
  scanSchedule.resume = resume.promise;
  const pending = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  try {
    await entered.promise;
    const reserved = writeDoc('__system__.md', '# Reserved on disk\n');
    watcher.mutateFileIndex({
      kind: 'create',
      path: reserved,
      docName: '__system__',
      content: '# Reserved on disk\n',
    });
    expect(watcher.getFileIndex().has('__system__')).toBe(false);
    resume.release();
    await pending;
    await vi.runAllTimersAsync();
    expect(events).toEqual([]);
    expect(watcher.getFileIndex().has('__system__')).toBe(false);
    expect(readFileSync(reserved, 'utf8')).toBe('# Reserved on disk\n');
    expect(await classifyEvents([{ type: 'create', path: reserved }], contentDir)).toEqual([
      {
        kind: 'create',
        path: reserved,
        docName: '__system__',
        content: '# Reserved on disk\n',
      },
    ]);
  } finally {
    resume.release();
    await pending;
  }
});

test('a public index-only write inside an ordinary consumer keeps its first create ordinary', async () => {
  const events: DiskEvent[] = [];
  const created = join(contentDir, 'ordinary-callback-public.md');
  let watcher: WatcherHandle | undefined;
  let callbacks = 0;
  watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
      if (event.kind !== 'create' || event.docName !== 'ordinary-callback-trigger') return;
      callbacks += 1;
      writeFileSync(created, '# Public from ordinary callback\n');
      watcher?.mutateFileIndex({
        kind: 'create',
        path: created,
        docName: 'ordinary-callback-public',
        content: '# Public from ordinary callback\n',
      });
    },
    undefined,
    { forceBackend: 'parcel', platform: 'darwin' },
  );
  handles.push(watcher);
  const trigger = writeDoc('ordinary-callback-trigger.md', '# Trigger\n');
  await deliver(contentDir, [{ type: 'create', path: trigger }]);
  expect(callbacks).toBe(1);
  expect(readFileSync(created, 'utf8')).toBe('# Public from ordinary callback\n');
  expect(watcher.getFileIndex().get('ordinary-callback-public')?.canonicalPath).toBe(created);
  events.length = 0;

  await deliver(contentDir, [{ type: 'create', path: created }]);
  expect(events).toEqual([
    {
      kind: 'create',
      path: created,
      docName: 'ordinary-callback-public',
      content: '# Public from ordinary callback\n',
    },
  ]);
});

test('a public delete during recovery removes a previously indexed file identity', async () => {
  const target = writeDoc('known-delete-target.md', '# Known at startup\n');
  const trigger = writeDoc('known-delete-trigger.md', '# Trigger\n');
  const events: DiskEvent[] = [];
  const completed: string[] = [];
  const phases: string[] = [];
  let callbackCount = 0;
  let watcher: WatcherHandle | undefined;
  watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
      if (event.kind !== 'delete' || event.docName !== 'known-delete-trigger') return;
      callbackCount += 1;
      writeFileSync(target, '# Public update before deletion\n');
      watcher?.mutateFileIndex({
        kind: 'update',
        path: target,
        docName: 'known-delete-target',
        content: '# Public update before deletion\n',
      });
      expect(readFileSync(target, 'utf8')).toBe('# Public update before deletion\n');
      phases.push('updated');
      unlinkSync(target);
      watcher?.mutateFileIndex({ kind: 'delete', path: target, docName: 'known-delete-target' });
      phases.push('deleted');
    },
    undefined,
    {
      forceBackend: 'parcel',
      platform: 'darwin',
      onRecoveryComplete: async () => {
        completed.push('complete');
      },
    },
  );
  handles.push(watcher);
  expect(readFileSync(target, 'utf8')).toBe('# Known at startup\n');
  expect(watcher.getFileIndex().get('known-delete-target')?.canonicalPath).toBe(target);
  unlinkSync(trigger);

  await deliverNotice(contentDir);

  expect(callbackCount).toBe(1);
  expect(phases).toEqual(['updated', 'deleted']);
  expect(completed).toEqual(['complete']);
  expect(existsSync(target)).toBe(false);
  expect(watcher.getFileIndex().has('known-delete-target')).toBe(false);
  expect(
    events.filter((event) => 'docName' in event && event.docName === 'known-delete-target'),
  ).toEqual([]);
  events.length = 0;

  writeFileSync(target, '# Externally recreated with distinct bytes\n');
  expect(readFileSync(target, 'utf8')).toBe('# Externally recreated with distinct bytes\n');
  await deliver(contentDir, [{ type: 'create', path: target }]);

  expect.soft(events).toEqual([
    {
      kind: 'create',
      path: target,
      docName: 'known-delete-target',
      content: '# Externally recreated with distinct bytes\n',
    },
  ]);
  expect(watcher.getFileIndex().get('known-delete-target')?.canonicalPath).toBe(target);
  expect(readFileSync(target, 'utf8')).toBe('# Externally recreated with distinct bytes\n');
});

function indexedRow(watcher: WatcherHandle, name: string, kind: 'markdown' | 'file') {
  return indexedIdentityRows(watcher).find((entry) => entry.name === name && entry.kind === kind);
}

function indexedAliasOwner(watcher: WatcherHandle, alias: string) {
  return indexedIdentityRows(watcher).find(
    (entry) => entry.kind === 'file' && entry.aliases.includes(alias),
  );
}

function indexedIdentityRows(watcher: WatcherHandle) {
  return [...watcher.getAllFilesIndex()].map(([name, entry]) => ({
    name,
    kind: entry.kind,
    canonicalPath: entry.canonicalPath,
    aliases: [...entry.aliases],
    size: entry.size,
    modified: entry.modified,
    inode: entry.inode,
  }));
}

function indexedGeneralRows(watcher: WatcherHandle) {
  return indexedIdentityRows(watcher).filter((entry) => entry.kind === 'file');
}

function indexedFileTargets(watcher: WatcherHandle): string[] {
  return localTargetInventoryFromWatcher(watcher, contentDir)?.fileTargets.toSorted() ?? [];
}

async function listedEntries(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/api/documents`);
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      documents: Array<{
        kind: string;
        docName?: string;
        size?: number;
        modified?: string;
        isSymlink?: boolean;
        targetPath?: string | null;
      }>;
    }
  ).documents;
}

async function searchedFiles(port: number, query: string): Promise<string[]> {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/search?query=${encodeURIComponent(query)}&intent=omnibar`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { results: Array<{ kind: string; path: string }> };
  return body.results.filter((result) => result.kind === 'file').map((result) => result.path);
}

test.each([
  ['alias.csv', true, 'update'],
  ['alias.csv', true, 'create'],
  ['real.csv', true, 'update'],
  ['real.csv', true, 'create'],
  ['real.csv', false, 'none'],
] as const)(
  'same-stem watcher inventory retains both kinds with %s first, alias %s and retarget %s',
  async (firstEntry, withAlias, retargetRecord) => {
    const real = writeDoc('real.csv', 'first,short\n');
    const other = writeDoc('other.csv', 'second,longer,bytes\n');
    const document = writeDoc('real.csv.md', '# Real CSV document\n');
    const alias = join(contentDir, 'alias.csv');
    const sibling = join(contentDir, 'sibling.csv');
    if (withAlias) {
      symlinkSync(real, alias);
      symlinkSync(real, sibling);
    }
    scanSchedule.orderedPath = contentDir;
    scanSchedule.firstEntry = firstEntry;
    const { watcher, events } = await watchContent();
    const initial = indexedIdentityRows(watcher);
    expect(watcher.getFileIndex().get('real.csv')?.canonicalPath).toBe(document);
    expect
      .soft(initial.filter((entry) => entry.name === 'real.csv' && entry.kind === 'markdown'))
      .toHaveLength(1);
    expect
      .soft(initial.filter((entry) => entry.name === 'real.csv' && entry.kind === 'file'))
      .toHaveLength(1);
    expect
      .soft(initial.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real))
      .toHaveLength(1);
    expect
      .soft(initial.find((entry) => entry.kind === 'file' && entry.canonicalPath === real))
      .toMatchObject({
        name: 'real.csv',
        size: statSync(real).size,
        inode: Number(statSync(real).ino),
        aliases: withAlias ? expect.arrayContaining(['alias.csv', 'sibling.csv']) : [],
      });
    if (withAlias) {
      unlinkSync(alias);
      symlinkSync(other, alias);
      const later = writeDoc('later.csv', 'later\n');
      await deliver(contentDir, [
        { type: retargetRecord === 'create' ? 'create' : 'update', path: alias },
        { type: 'create', path: later },
      ]);
      expect(readFileSync(alias, 'utf8')).toBe('second,longer,bytes\n');
      expect(readFileSync(sibling, 'utf8')).toBe('first,short\n');
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'file-create', path: later, relativePath: 'later.csv' }),
      );
      const afterRetarget = indexedIdentityRows(watcher);
      expect
        .soft(
          afterRetarget.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real),
        )
        .toHaveLength(1);
      expect
        .soft(
          afterRetarget.filter((entry) => entry.kind === 'file' && entry.canonicalPath === other),
        )
        .toHaveLength(1);
      expect
        .soft(afterRetarget.find((entry) => entry.kind === 'file' && entry.canonicalPath === real))
        .toMatchObject({
          name: 'real.csv',
          aliases: ['sibling.csv'],
          size: statSync(real).size,
          inode: Number(statSync(real).ino),
        });
      expect
        .soft(afterRetarget.find((entry) => entry.kind === 'file' && entry.canonicalPath === other))
        .toMatchObject({
          name: 'other.csv',
          aliases: ['alias.csv'],
          size: statSync(other).size,
          inode: Number(statSync(other).ino),
        });
      events.length = 0;
    }
    await deliverNotice(contentDir);
    await deliverNotice(contentDir);
    expect(readFileSync(real, 'utf8')).toBe('first,short\n');
    expect(readFileSync(document, 'utf8')).toBe('# Real CSV document\n');
    expect
      .soft(events.filter((event) => event.kind === 'file-delete' && event.path === real))
      .toEqual([]);
    const settled = indexedIdentityRows(watcher);
    expect
      .soft(settled.filter((entry) => entry.name === 'real.csv' && entry.kind === 'markdown'))
      .toHaveLength(1);
    expect
      .soft(settled.filter((entry) => entry.name === 'real.csv' && entry.kind === 'file'))
      .toHaveLength(1);
    expect
      .soft(settled.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real))
      .toHaveLength(1);
    if (withAlias) {
      expect
        .soft(
          settled.find((entry) => entry.kind === 'file' && entry.canonicalPath === other)?.aliases,
        )
        .toEqual(['alias.csv']);
      expect
        .soft(
          settled.find((entry) => entry.kind === 'file' && entry.canonicalPath === real)?.aliases,
        )
        .toEqual(['sibling.csv']);
    }
  },
);

test.each([
  ['alias.csv', 'retarget', true],
  ['real.csv', 'retarget', true],
  ['alias.csv', 'unchanged', true],
  ['alias.csv', 'retarget', false],
] as const)(
  'same-stem HTTP identity with %s first, %s alias and document %s follows disk truth',
  async (firstEntry, action, withDocument) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const real = writeDoc('real.csv', 'first,short\n');
    const other = writeDoc('other.csv', 'second,longer,bytes\n');
    const alias = join(contentDir, 'alias.csv');
    const listingAlias = join(contentDir, 'listing-only.csv');
    symlinkSync(real, alias);
    symlinkSync(other, listingAlias);
    if (withDocument) {
      writeDoc('real.csv.md', '# Real CSV document\n');
      writeDoc('inventory.csv', 'unreferenced,file\n');
      writeDoc('inventory.csv.md', '# Unreferenced document\n');
    }
    writeDoc(
      'source.md',
      '# Source\n\n[Target](real.csv)\n\n[Other](other.csv)\n\n[Alias](alias.csv)\n\n[Document](real.csv.md)\n\n[Absent](missing.csv)\n',
    );
    scanSchedule.orderedPath = contentDir;
    scanSchedule.firstEntry = firstEntry;
    const server = await bootInventoryServer();
    try {
      const expected = {
        'real.csv': 'exact',
        'other.csv': 'exact',
        'alias.csv': 'exact',
        'missing.csv': 'missing',
      };
      const before = await inventoryForwardStatuses(server.port);
      if (firstEntry === 'real.csv' && withDocument) expect.soft(before).toEqual(expected);
      else expect(before).toEqual(expected);
      const subscription = nativeSubscriptionOn(contentDir);
      if (action === 'retarget') {
        unlinkSync(alias);
        symlinkSync(other, alias);
        await subscription.deliver([{ type: 'update', path: alias }]);
        const afterOrdinaryRetarget = await inventoryForwardStatuses(server.port);
        if (firstEntry === 'real.csv' && withDocument) {
          expect.soft(afterOrdinaryRetarget).toEqual(expected);
        } else {
          expect(afterOrdinaryRetarget).toEqual(expected);
        }
      }
      const currentTarget = action === 'retarget' ? other : real;
      expect(realpathSync(alias)).toBe(currentTarget);
      expect(readFileSync(alias, 'utf8')).toBe(
        action === 'retarget' ? 'second,longer,bytes\n' : 'first,short\n',
      );
      await subscription.deliver([], new Error(notices[0]));
      await subscription.deliver([], new Error(notices[0]));
      expect(readFileSync(real, 'utf8')).toBe('first,short\n');
      expect(readFileSync(other, 'utf8')).toBe('second,longer,bytes\n');
      expect.soft(await inventoryForwardStatuses(server.port)).toEqual(expected);
      expect.soft(await inventoryAuditBroken(server.port, 'real.csv')).toBe(false);
      expect.soft(await inventoryAuditBroken(server.port, 'alias.csv')).toBe(false);
      expect(await inventoryAuditBroken(server.port, 'missing.csv')).toBe(true);
      if (action === 'retarget' && withDocument) {
        expect
          .soft(
            getWatcherDecisionRingSnapshot().filter(
              (entry) =>
                entry.decision === 'dispatched' &&
                entry.path === `.../${basename(contentDir)}/real.csv` &&
                (entry.kind === 'file-delete' || entry.kind === 'asset-delete'),
            ),
          )
          .toEqual([]);
      }
      const realAsset = await fetch(`http://127.0.0.1:${server.port}/api/asset-text?path=real.csv`);
      const otherAsset = await fetch(
        `http://127.0.0.1:${server.port}/api/asset-text?path=other.csv`,
      );
      const aliasAsset = await fetch(
        `http://127.0.0.1:${server.port}/api/asset-text?path=alias.csv`,
      );
      expect(realAsset.status).toBe(200);
      expect(await realAsset.text()).toBe('first,short\n');
      expect(otherAsset.status).toBe(200);
      expect(await otherAsset.text()).toBe('second,longer,bytes\n');
      expect(aliasAsset.status).toBe(400);
      if (withDocument) {
        const documentResponse = await fetch(
          `http://127.0.0.1:${server.port}/api/document?docName=real.csv`,
        );
        expect(documentResponse.status).toBe(200);
        const page = (await documentResponse.json()) as { content: string };
        expect(page.content).toBe('# Real CSV document\n');
      }
      const listingResponse = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
      expect(listingResponse.status).toBe(200);
      const listing = (await listingResponse.json()) as {
        documents: Array<{
          kind: string;
          docName: string;
          targetPath?: string | null;
          isSymlink?: boolean;
        }>;
      };
      if (action === 'retarget' && withDocument) {
        expect
          .soft(
            listing.documents.filter(
              (entry) => entry.kind === 'document' && entry.docName === 'real.csv',
            ),
          )
          .toHaveLength(1);
        expect
          .soft(
            listing.documents.filter(
              (entry) => entry.kind === 'asset' && entry.docName === 'real.csv',
            ),
          )
          .toHaveLength(1);
        expect
          .soft(
            listing.documents.filter(
              (entry) => entry.kind === 'document' && entry.docName === 'inventory.csv',
            ),
          )
          .toHaveLength(1);
        expect
          .soft(
            listing.documents.filter(
              (entry) => entry.kind === 'file' && entry.docName === 'inventory.csv',
            ),
          )
          .toHaveLength(1);
        expect
          .soft(
            listing.documents.find(
              (entry) => entry.kind === 'file' && entry.docName === 'listing-only.csv',
            ),
          )
          .toMatchObject({
            targetPath: 'other.csv',
            isSymlink: true,
          });
        const searchResponse = await fetch(
          `http://127.0.0.1:${server.port}/api/search?query=real.csv&intent=omnibar&limit=100`,
        );
        expect(searchResponse.status).toBe(200);
        const search = (await searchResponse.json()) as {
          results: Array<{ kind: string; path: string }>;
        };
        expect
          .soft(
            search.results
              .filter((entry) => entry.path === 'real.csv')
              .map((entry) => entry.kind)
              .sort(),
          )
          .toEqual(['file', 'page']);
      }
    } finally {
      await server.destroy();
    }
  },
);

test.each(['old-target', 'new-target', 'alias', 'markdown'] as const)(
  'same-stem retarget then remove %s preserves the surviving HTTP identity',
  async (removed) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const real = writeDoc('real.csv', 'first,short\n');
    const other = writeDoc('other.csv', 'second,longer,bytes\n');
    const document = writeDoc('real.csv.md', '# Real CSV document\n');
    const alias = join(contentDir, 'alias.csv');
    symlinkSync(real, alias);
    writeDoc(
      'source.md',
      '# Source\n\n[Target](real.csv)\n\n[Other](other.csv)\n\n[Alias](alias.csv)\n',
    );
    scanSchedule.orderedPath = contentDir;
    scanSchedule.firstEntry = 'alias.csv';
    const server = await bootInventoryServer();
    try {
      const subscription = nativeSubscriptionOn(contentDir);
      expect(await inventoryForwardStatuses(server.port)).toEqual({
        'real.csv': 'exact',
        'other.csv': 'exact',
        'alias.csv': 'exact',
      });
      unlinkSync(alias);
      symlinkSync(other, alias);
      await subscription.deliver([{ type: 'update', path: alias }]);
      await subscription.deliver([], new Error(notices[0]));
      const beforeRemoval = await inventoryForwardStatuses(server.port);
      expect.soft(beforeRemoval).toEqual({
        'real.csv': 'exact',
        'other.csv': 'exact',
        'alias.csv': 'exact',
      });
      const path =
        removed === 'old-target'
          ? real
          : removed === 'new-target'
            ? other
            : removed === 'alias'
              ? alias
              : document;
      unlinkSync(path);
      await subscription.deliver([{ type: 'delete', path }]);
      await subscription.deliver([], new Error(notices[0]));
      const expected = {
        'real.csv': removed === 'old-target' ? 'missing' : 'exact',
        'other.csv': removed === 'new-target' ? 'missing' : 'exact',
        'alias.csv': removed === 'new-target' || removed === 'alias' ? 'missing' : 'exact',
      };
      expect.soft(await inventoryForwardStatuses(server.port)).toEqual(expected);
      for (const [href, status] of Object.entries(expected)) {
        expect.soft(await inventoryAuditBroken(server.port, href)).toBe(status === 'missing');
      }
      expect(existsSync(real)).toBe(removed !== 'old-target');
      expect(existsSync(other)).toBe(removed !== 'new-target');
      expect(existsSync(document)).toBe(removed !== 'markdown');
      if (removed !== 'alias' && removed !== 'new-target') {
        expect(realpathSync(alias)).toBe(other);
        expect(readFileSync(alias, 'utf8')).toBe('second,longer,bytes\n');
      }
      const listingResponse = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
      expect(listingResponse.status).toBe(200);
      const listing = (await listingResponse.json()) as {
        documents: Array<{ kind: string; docName: string }>;
      };
      expect
        .soft(
          listing.documents.filter(
            (entry) => entry.kind === 'document' && entry.docName === 'real.csv',
          ),
        )
        .toHaveLength(removed === 'markdown' ? 0 : 1);
      expect
        .soft(
          listing.documents.filter(
            (entry) =>
              (entry.kind === 'asset' || entry.kind === 'file') && entry.docName === 'real.csv',
          ),
        )
        .toHaveLength(removed === 'old-target' ? 0 : 1);
    } finally {
      await server.destroy();
    }
  },
);

test.each(['file', 'markdown'] as const)(
  'same-spelling public %s mutation preserves the other domain and its recovery change',
  async (publicDomain) => {
    const real = writeDoc('real.csv', 'original,file\n');
    const document = writeDoc('real.csv.md', '# Original document\n');
    const trigger = writeDoc('identity-trigger.md', '# Trigger\n');
    const alias = join(contentDir, 'alias.csv');
    symlinkSync(real, alias);
    scanSchedule.orderedPath = contentDir;
    scanSchedule.firstEntry = 'alias.csv';
    const events: DiskEvent[] = [];
    const completed: string[] = [];
    let watcher: WatcherHandle | undefined;
    let publicCallbacks = 0;
    watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
        if (event.kind !== 'delete' || event.docName !== 'identity-trigger') return;
        publicCallbacks += 1;
        if (publicDomain === 'file') {
          writeFileSync(real, 'public,file,updated\n');
          const stat = statSync(real);
          watcher?.mutateFileIndex({
            kind: 'file-update',
            path: real,
            relativePath: 'real.csv',
            size: stat.size,
            modifiedTs: stat.mtimeMs,
            inode: Number(stat.ino),
          });
        } else {
          writeFileSync(document, '# Public document update\n');
          watcher?.mutateFileIndex({
            kind: 'update',
            path: document,
            docName: 'real.csv',
            content: '# Public document update\n',
          });
        }
      },
      undefined,
      {
        forceBackend: 'parcel',
        platform: 'darwin',
        onRecoveryComplete: async () => {
          completed.push('complete');
        },
      },
    );
    handles.push(watcher);
    const before = indexedIdentityRows(watcher);
    expect(
      before.filter((entry) => entry.kind === 'markdown' && entry.canonicalPath === document),
    ).toHaveLength(1);
    expect(
      before.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real),
    ).toHaveLength(1);
    if (publicDomain === 'file') writeFileSync(document, '# External document update\n');
    else writeFileSync(real, 'external,file,updated\n');
    unlinkSync(trigger);

    await deliverNotice(contentDir);

    expect(publicCallbacks).toBe(1);
    expect(completed).toEqual(['complete']);
    const expectedExternalKind = publicDomain === 'file' ? 'update' : 'file-update';
    const externalPath = publicDomain === 'file' ? document : real;
    expect
      .soft(events)
      .toContainEqual(expect.objectContaining({ kind: expectedExternalKind, path: externalPath }));
    expect(readFileSync(real, 'utf8')).toBe(
      publicDomain === 'file' ? 'public,file,updated\n' : 'external,file,updated\n',
    );
    expect(readFileSync(document, 'utf8')).toBe(
      publicDomain === 'file' ? '# External document update\n' : '# Public document update\n',
    );
    const after = indexedIdentityRows(watcher);
    expect
      .soft(after.filter((entry) => entry.kind === 'markdown' && entry.canonicalPath === document))
      .toHaveLength(1);
    expect
      .soft(after.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real))
      .toHaveLength(1);
    expect
      .soft(after.find((entry) => entry.kind === 'file' && entry.canonicalPath === real)?.size)
      .toBe(statSync(real).size);
    expect.soft(watcher.getFileIndex().get('real.csv')?.size).toBe(statSync(document).size);

    if (publicDomain === 'file') {
      unlinkSync(real);
      watcher.mutateFileIndex({ kind: 'file-delete', path: real, relativePath: 'real.csv' });
    } else {
      unlinkSync(document);
      watcher.mutateFileIndex({ kind: 'delete', path: document, docName: 'real.csv' });
    }
    const surviving = indexedIdentityRows(watcher);
    expect
      .soft(
        surviving.filter((entry) => entry.kind === 'markdown' && entry.canonicalPath === document),
      )
      .toHaveLength(publicDomain === 'file' ? 1 : 0);
    expect
      .soft(surviving.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real))
      .toHaveLength(publicDomain === 'markdown' ? 1 : 0);
  },
);

test.each(['incomplete', 'consumer-error'] as const)(
  'same-stem alias identity survives %s recovery and the next complete notice',
  async (exit) => {
    const real = writeDoc('real.csv', 'first,short\n');
    const other = writeDoc('other.csv', 'second,longer,bytes\n');
    const document = writeDoc('real.csv.md', '# Real CSV document\n');
    const alias = join(contentDir, 'alias.csv');
    const trigger = writeDoc('identity-error-trigger.md', '# Trigger\n');
    const blocked = join(contentDir, 'blocked');
    mkdirSync(blocked);
    writeDoc('blocked/known.md', '# Known\n');
    symlinkSync(real, alias);
    scanSchedule.orderedPath = contentDir;
    scanSchedule.firstEntry = 'alias.csv';
    const events: DiskEvent[] = [];
    const completed: string[] = [];
    const failure = new Error('identity recovery consumer rejected');
    const logger = getLogger('file-watcher');
    const warnings = vi.spyOn(logger, 'warn');
    const errors = vi.spyOn(logger, 'error');
    let rejected = 0;
    const watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
        if (
          exit === 'consumer-error' &&
          event.kind === 'delete' &&
          event.docName === 'identity-error-trigger' &&
          rejected === 0
        ) {
          rejected += 1;
          throw failure;
        }
      },
      undefined,
      {
        forceBackend: 'parcel',
        platform: 'darwin',
        onRecoveryComplete: async () => {
          completed.push('complete');
        },
      },
    );
    handles.push(watcher);
    unlinkSync(alias);
    symlinkSync(other, alias);
    await deliver(contentDir, [{ type: 'update', path: alias }]);
    events.length = 0;
    unlinkSync(trigger);
    if (exit === 'incomplete') deniedDirectoryRead.path = blocked;
    try {
      await deliverNotice(contentDir);
      expect(completed).toEqual([]);
      if (exit === 'incomplete') {
        expect(deniedDirectoryRead.path).toBeNull();
        expect(JSON.stringify([...warnings.mock.calls, ...errors.mock.calls])).toContain('EACCES');
      } else {
        expect(rejected).toBe(1);
        expect(errors.mock.calls.some(([detail]) => detail.err === failure)).toBe(true);
      }
      deniedDirectoryRead.path = null;
      events.length = 0;
      await deliverNotice(contentDir);
      expect(completed).toEqual(['complete']);
      expect(readFileSync(real, 'utf8')).toBe('first,short\n');
      expect(readFileSync(document, 'utf8')).toBe('# Real CSV document\n');
      expect(realpathSync(alias)).toBe(other);
      expect(readFileSync(alias, 'utf8')).toBe('second,longer,bytes\n');
      const settled = indexedIdentityRows(watcher);
      expect
        .soft(settled.filter((entry) => entry.kind === 'markdown' && entry.name === 'real.csv'))
        .toHaveLength(1);
      expect
        .soft(settled.filter((entry) => entry.kind === 'file' && entry.name === 'real.csv'))
        .toHaveLength(1);
      expect
        .soft(
          settled.find((entry) => entry.kind === 'file' && entry.canonicalPath === real)?.aliases,
        )
        .toEqual([]);
      expect
        .soft(
          settled.find((entry) => entry.kind === 'file' && entry.canonicalPath === other)?.aliases,
        )
        .toEqual(['alias.csv']);
      expect
        .soft(events.filter((event) => event.kind === 'file-delete' && event.path === real))
        .toEqual([]);
    } finally {
      deniedDirectoryRead.path = null;
    }
  },
);

test.each(['add', 'remove', 'retarget'] as const)(
  'same-stem file alias %s retains canonical file and document identities',
  async (action) => {
    const real = writeDoc('real.csv', 'first,short\n');
    const other = writeDoc('other.csv', 'second,longer,bytes\n');
    const document = writeDoc('real.csv.md', '# Real CSV document\n');
    const alias = join(contentDir, 'alias.csv');
    if (action !== 'add') symlinkSync(real, alias);
    scanSchedule.orderedPath = contentDir;
    scanSchedule.firstEntry = action === 'add' ? 'real.csv' : 'alias.csv';
    const { watcher, events } = await watchContent();
    if (action === 'add') {
      symlinkSync(real, alias);
      await deliver(contentDir, [{ type: 'create', path: alias }]);
    } else if (action === 'remove') {
      unlinkSync(alias);
      await deliver(contentDir, [{ type: 'delete', path: alias }]);
    } else {
      unlinkSync(alias);
      symlinkSync(other, alias);
      await deliver(contentDir, [{ type: 'update', path: alias }]);
    }
    await deliverNotice(contentDir);
    expect(readFileSync(real, 'utf8')).toBe('first,short\n');
    expect(readFileSync(document, 'utf8')).toBe('# Real CSV document\n');
    const settled = indexedIdentityRows(watcher);
    expect
      .soft(settled.filter((entry) => entry.name === 'real.csv' && entry.kind === 'markdown'))
      .toHaveLength(1);
    expect
      .soft(settled.filter((entry) => entry.name === 'real.csv' && entry.kind === 'file'))
      .toHaveLength(1);
    expect
      .soft(settled.find((entry) => entry.kind === 'file' && entry.canonicalPath === real))
      .toMatchObject({
        name: 'real.csv',
        aliases: action === 'add' ? ['alias.csv'] : [],
        size: statSync(real).size,
        inode: Number(statSync(real).ino),
      });
    expect
      .soft(
        settled.find((entry) => entry.kind === 'file' && entry.canonicalPath === other)?.aliases,
      )
      .toEqual(action === 'retarget' ? ['alias.csv'] : []);
    expect
      .soft(events.filter((event) => event.kind === 'file-delete' && event.path === real))
      .toEqual([]);
    if (action !== 'remove') {
      expect(realpathSync(alias)).toBe(action === 'retarget' ? other : real);
    } else {
      expect(existsSync(alias)).toBe(false);
    }
  },
);

test('same-stem folder alias listing retains both child kinds on repeated inventory reads', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const canonical = join(contentDir, 'canonical');
  mkdirSync(canonical);
  writeFileSync(join(canonical, 'real.csv'), 'physical,file\n');
  writeFileSync(join(canonical, 'real.csv.md'), '# Logical document\n');
  symlinkSync(canonical, join(contentDir, 'linked-folder'));
  const server = await bootInventoryServer();
  try {
    const readRows = async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        documents: Array<{ kind: string; docName: string; targetPath?: string | null }>;
      };
      return body.documents;
    };
    const verify = (rows: Awaited<ReturnType<typeof readRows>>) => {
      expect
        .soft(
          rows.filter(
            (entry) => entry.docName === 'canonical/real.csv' && entry.kind === 'document',
          ),
        )
        .toHaveLength(1);
      expect
        .soft(
          rows.filter((entry) => entry.docName === 'canonical/real.csv' && entry.kind === 'file'),
        )
        .toHaveLength(1);
      expect
        .soft(
          rows.filter(
            (entry) => entry.docName === 'linked-folder/real.csv' && entry.kind === 'document',
          ),
        )
        .toEqual([expect.objectContaining({ targetPath: 'canonical/real.csv.md' })]);
      expect
        .soft(
          rows.filter(
            (entry) => entry.docName === 'linked-folder/real.csv' && entry.kind === 'file',
          ),
        )
        .toEqual([expect.objectContaining({ targetPath: 'canonical/real.csv' })]);
    };
    verify(await readRows());
    await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    verify(await readRows());
    expect(readFileSync(join(canonical, 'real.csv'), 'utf8')).toBe('physical,file\n');
    expect(readFileSync(join(canonical, 'real.csv.md'), 'utf8')).toBe('# Logical document\n');
  } finally {
    await server.destroy();
  }
});

test('ordinary same-stem alias removal drops only that alias before notice recovery', async () => {
  const real = writeDoc('real.csv', 'canonical,file\n');
  const document = writeDoc('real.csv.md', '# Same-stem document\n');
  const alias = join(contentDir, 'alias.csv');
  const sibling = join(contentDir, 'sibling.csv');
  symlinkSync(real, alias);
  symlinkSync(real, sibling);
  scanSchedule.orderedPath = contentDir;
  scanSchedule.firstEntry = 'alias.csv';
  const { watcher, events } = await watchContent();
  const initial = indexedIdentityRows(watcher);
  expect(
    initial.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real),
  ).toHaveLength(1);
  expect(
    initial.filter((entry) => entry.kind === 'markdown' && entry.canonicalPath === document),
  ).toHaveLength(1);
  const originalFile = initial.find(
    (entry) => entry.kind === 'file' && entry.canonicalPath === real,
  );
  expect(originalFile?.size).toBe(statSync(real).size);
  expect(originalFile?.inode).toBe(Number(statSync(real).ino));
  unlinkSync(alias);

  await deliver(contentDir, [{ type: 'delete', path: alias }]);

  const immediate = indexedIdentityRows(watcher);
  expect
    .soft(immediate.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real))
    .toHaveLength(1);
  expect.soft(immediate.flatMap((entry) => entry.aliases)).not.toContain('alias.csv');
  expect
    .soft(
      immediate.find((entry) => entry.kind === 'file' && entry.canonicalPath === real)?.aliases ??
        [],
    )
    .toContain('sibling.csv');
  expect
    .soft(immediate.find((entry) => entry.kind === 'file' && entry.canonicalPath === real))
    .toMatchObject({
      size: statSync(real).size,
      inode: Number(statSync(real).ino),
    });
  expect
    .soft(
      immediate.filter((entry) => entry.kind === 'markdown' && entry.canonicalPath === document),
    )
    .toHaveLength(1);
  expect(readFileSync(real, 'utf8')).toBe('canonical,file\n');
  expect(readFileSync(sibling, 'utf8')).toBe('canonical,file\n');
  expect(readFileSync(document, 'utf8')).toBe('# Same-stem document\n');
  events.length = 0;

  await deliverNotice(contentDir);
  await deliverNotice(contentDir);

  const recovered = indexedIdentityRows(watcher);
  expect
    .soft(recovered.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real))
    .toHaveLength(1);
  expect.soft(recovered.flatMap((entry) => entry.aliases)).not.toContain('alias.csv');
  expect
    .soft(
      recovered.find((entry) => entry.kind === 'file' && entry.canonicalPath === real)?.aliases ??
        [],
    )
    .toContain('sibling.csv');
  expect
    .soft(
      recovered.filter((entry) => entry.kind === 'markdown' && entry.canonicalPath === document),
    )
    .toHaveLength(1);
  expect(events.filter((event) => event.kind === 'file-delete' && event.path === real)).toEqual([]);
});

test('a public general-file recreation during recovery retains its restored parent', async () => {
  const first = writeDoc('first.md', '# First\n');
  const folder = join(contentDir, 'nested');
  mkdirSync(folder);
  const later = writeDoc('nested/later.csv', 'before,bytes\n');
  scanSchedule.orderedPath = contentDir;
  scanSchedule.firstEntry = 'first.md';
  let recreations = 0;
  const watched = await watchContent(undefined, async (event) => {
    if (event.kind !== 'delete' || event.docName !== 'first') return;
    mkdirSync(folder);
    writeFileSync(later, 'recreated,general,bytes\n');
    const stat = statSync(later);
    watched.watcher.mutateFileIndex({
      kind: 'file-create',
      path: later,
      relativePath: 'nested/later.csv',
      size: stat.size,
      modifiedTs: stat.mtimeMs,
      inode: Number(stat.ino),
    });
    recreations += 1;
  });
  expect(watched.watcher.getFolderIndex().has('nested')).toBe(true);
  expect(
    indexedIdentityRows(watched.watcher).filter(
      (entry) => entry.kind === 'file' && entry.canonicalPath === later,
    ),
  ).toHaveLength(1);
  unlinkSync(first);
  rmSync(folder, { recursive: true });

  await deliverNotice(contentDir);

  expect(recreations).toBe(1);
  expect(watched.events).toContainEqual({ kind: 'delete', path: first, docName: 'first' });
  expect(readFileSync(later, 'utf8')).toBe('recreated,general,bytes\n');
  expect(watched.watcher.getFolderIndex().has('nested')).toBe(true);
  expect
    .soft(
      indexedIdentityRows(watched.watcher).filter(
        (entry) => entry.kind === 'file' && entry.canonicalPath === later,
      ),
    )
    .toEqual([
      expect.objectContaining({
        name: 'nested/later.csv',
        size: statSync(later).size,
        inode: Number(statSync(later).ino),
      }),
    ]);
  expect
    .soft(
      watched.events.filter(
        (event) =>
          'path' in event &&
          event.path === later &&
          (event.kind === 'file-delete' || event.kind === 'asset-delete'),
      ),
    )
    .toEqual([]);
  expect.soft(watched.events).not.toContainEqual({
    kind: 'folder-delete',
    path: folder,
    relativePath: 'nested',
  });
  expect(watched.watcher.getFileIndex().has('first')).toBe(false);
});

test.each(['general', 'markdown'] as const)(
  'same-stem %s ignore rebuild prunes and reseeds only its own identity',
  async (excludedDomain) => {
    const real = writeDoc('real.csv', 'canonical,file\n');
    const document = writeDoc('real.csv.md', '# Same-stem document\n');
    const alias = join(contentDir, 'alias.csv');
    symlinkSync(real, alias);
    scanSchedule.orderedPath = contentDir;
    scanSchedule.firstEntry = 'alias.csv';
    const ignore = join(contentDir, '.okignore');
    writeFileSync(ignore, '');
    const filter = dynamicSkillFilter();
    const events: DiskEvent[] = [];
    const watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      filter,
      { forceBackend: 'parcel', platform: 'darwin' },
    );
    handles.push(watcher);
    const initial = indexedIdentityRows(watcher);
    expect(
      initial.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real),
    ).toHaveLength(1);
    expect(
      initial.filter((entry) => entry.kind === 'markdown' && entry.canonicalPath === document),
    ).toHaveLength(1);
    expect(watcher.getFileIndex().has('real.csv')).toBe(true);
    const initialView = watcher.getFileIndex();
    const beforeGeneration = watcher.getFileIndexGeneration();
    writeFileSync(ignore, excludedDomain === 'general' ? 'real.csv\n' : 'real.csv.md\n');
    expect((await filter.rebuildIgnorePatterns()).ok).toBe(true);

    const pruned = await reconcileFileIndexAfterFilterRebuild(watcher);

    expect(pruned).toEqual({ prunedFiles: 1, prunedFolders: 0 });
    expect(watcher.getFileIndexGeneration()).toBeGreaterThan(beforeGeneration);
    expect(watcher.getFileIndex()).not.toBe(initialView);
    const excluded = indexedIdentityRows(watcher);
    expect
      .soft(excluded.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real))
      .toHaveLength(excludedDomain === 'general' ? 0 : 1);
    expect
      .soft(
        excluded.filter((entry) => entry.kind === 'markdown' && entry.canonicalPath === document),
      )
      .toHaveLength(excludedDomain === 'markdown' ? 0 : 1);
    expect.soft(watcher.getFileIndex().has('real.csv')).toBe(excludedDomain === 'general');
    if (excludedDomain === 'general') {
      expect.soft(excluded.flatMap((entry) => entry.aliases)).not.toContain('alias.csv');
    } else {
      expect
        .soft(
          excluded.find((entry) => entry.kind === 'file' && entry.canonicalPath === real)
            ?.aliases ?? [],
        )
        .toContain('alias.csv');
    }
    expect(events).toEqual([]);
    const excludedGeneration = watcher.getFileIndexGeneration();
    const excludedView = watcher.getFileIndex();
    writeFileSync(ignore, '');
    expect((await filter.rebuildIgnorePatterns()).ok).toBe(true);

    const restoredCounts = await reconcileFileIndexAfterFilterRebuild(watcher);

    expect(restoredCounts).toEqual({ prunedFiles: 0, prunedFolders: 0 });
    expect(watcher.getFileIndexGeneration()).toBeGreaterThan(excludedGeneration);
    expect(watcher.getFileIndex()).not.toBe(excludedView);
    const restored = indexedIdentityRows(watcher);
    expect
      .soft(restored.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real))
      .toHaveLength(1);
    expect
      .soft(
        restored.filter((entry) => entry.kind === 'markdown' && entry.canonicalPath === document),
      )
      .toHaveLength(1);
    expect
      .soft(restored.find((entry) => entry.kind === 'file' && entry.canonicalPath === real))
      .toMatchObject({
        size: statSync(real).size,
        inode: Number(statSync(real).ino),
        aliases: ['alias.csv'],
      });
    expect(watcher.getFileIndex().get('real.csv')?.canonicalPath).toBe(document);
    expect(readFileSync(real, 'utf8')).toBe('canonical,file\n');
    expect(readFileSync(document, 'utf8')).toBe('# Same-stem document\n');
    expect(events).toEqual([]);
  },
);

test.each(['file', 'markdown'] as const)(
  'same-spelling public %s update during observation preserves the external counterpart',
  async (publicDomain) => {
    const real = writeDoc('real.csv', 'original,file\n');
    const document = writeDoc('real.csv.md', '# Original document\n');
    const alias = join(contentDir, 'alias.csv');
    symlinkSync(real, alias);
    scanSchedule.orderedPath = contentDir;
    scanSchedule.firstEntry = 'alias.csv';
    const events: DiskEvent[] = [];
    const completed: string[] = [];
    const watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      {
        forceBackend: 'parcel',
        platform: 'darwin',
        onRecoveryComplete: async () => {
          completed.push('complete');
        },
      },
    );
    handles.push(watcher);
    const initial = indexedIdentityRows(watcher);
    expect(
      initial.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real),
    ).toHaveLength(1);
    expect(
      initial.filter((entry) => entry.kind === 'markdown' && entry.canonicalPath === document),
    ).toHaveLength(1);
    if (publicDomain === 'file') writeFileSync(document, '# External document update\n');
    else writeFileSync(real, 'external,file,updated\n');
    const entered = deferred();
    const resume = deferred();
    scanSchedule.holdPath = contentDir;
    scanSchedule.entered = entered.release;
    scanSchedule.resume = resume.promise;
    const pending = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    try {
      await entered.promise;
      if (publicDomain === 'file') {
        writeFileSync(real, 'public,file,updated\n');
        const stat = statSync(real);
        watcher.mutateFileIndex({
          kind: 'file-update',
          path: real,
          relativePath: 'real.csv',
          size: stat.size,
          modifiedTs: stat.mtimeMs,
          inode: Number(stat.ino),
        });
      } else {
        writeFileSync(document, '# Public document update\n');
        watcher.mutateFileIndex({
          kind: 'update',
          path: document,
          docName: 'real.csv',
          content: '# Public document update\n',
        });
      }
      resume.release();
      await pending;
      await vi.runAllTimersAsync();
      expect(completed).toEqual(['complete']);
      const externalPath = publicDomain === 'file' ? document : real;
      const externalKind = publicDomain === 'file' ? 'update' : 'file-update';
      expect
        .soft(events)
        .toContainEqual(expect.objectContaining({ kind: externalKind, path: externalPath }));
      expect(readFileSync(real, 'utf8')).toBe(
        publicDomain === 'file' ? 'public,file,updated\n' : 'external,file,updated\n',
      );
      expect(readFileSync(document, 'utf8')).toBe(
        publicDomain === 'file' ? '# External document update\n' : '# Public document update\n',
      );
      const settled = indexedIdentityRows(watcher);
      expect
        .soft(settled.filter((entry) => entry.kind === 'file' && entry.canonicalPath === real))
        .toHaveLength(1);
      expect
        .soft(
          settled.filter((entry) => entry.kind === 'markdown' && entry.canonicalPath === document),
        )
        .toHaveLength(1);
      expect
        .soft(settled.find((entry) => entry.kind === 'file' && entry.canonicalPath === real)?.size)
        .toBe(statSync(real).size);
      expect.soft(watcher.getFileIndex().get('real.csv')?.size).toBe(statSync(document).size);
    } finally {
      resume.release();
      await pending;
    }
  },
);

test.each(['a.csv', 'b.csv'] as const)(
  'general inode dedup retains a later symlink alias resolving to %s',
  async (targetName) => {
    const first = writeDoc('a.csv', 'same,inode,content\n');
    const hardlink = join(contentDir, 'b.csv');
    const alias = join(contentDir, 'z-alias.csv');
    linkSync(first, hardlink);
    symlinkSync(join(contentDir, targetName), alias);
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries = ['a.csv', 'b.csv', 'z-alias.csv'];
    let watcher: WatcherHandle | undefined;
    try {
      expect(statSync(first).ino).toBe(statSync(hardlink).ino);
      expect(realpathSync(alias)).toBe(join(contentDir, targetName));
      watcher = await startWatcher(contentDir, async () => {}, undefined, {
        forceBackend: 'parcel',
        platform: 'darwin',
      });
      const rows = indexedIdentityRows(watcher).filter((entry) => entry.kind === 'file');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: 'a.csv',
        canonicalPath: first,
        inode: Number(statSync(first).ino),
      });
      expect(readFileSync(alias, 'utf8')).toBe('same,inode,content\n');
      expect.soft(rows[0]?.aliases).toContain('z-alias.csv');
    } finally {
      scanSchedule.orderedEntries = null;
      scanSchedule.orderedPath = null;
      await watcher?.unsubscribe();
      if (watcher) expect(nativeSubscriptionOn(contentDir).nativeReleases()).toBe(1);
      rmSync(contentDir, { recursive: true, force: true });
      expect(existsSync(contentDir)).toBe(false);
    }
  },
);

test.each([
  { name: 'alias create to a', action: 'alias', record: 'create', target: 'a.csv', first: 'a.csv' },
  { name: 'alias create to b', action: 'alias', record: 'create', target: 'b.csv', first: 'a.csv' },
  { name: 'alias update to a', action: 'alias', record: 'update', target: 'a.csv', first: 'a.csv' },
  { name: 'alias update to b', action: 'alias', record: 'update', target: 'b.csv', first: 'a.csv' },
  { name: 'direct update a', action: 'direct', record: 'update', target: 'a.csv', first: 'a.csv' },
  { name: 'direct update b', action: 'direct', record: 'update', target: 'b.csv', first: 'a.csv' },
  { name: 'public update a', action: 'public', record: null, target: 'a.csv', first: 'a.csv' },
  { name: 'public update b', action: 'public', record: null, target: 'b.csv', first: 'a.csv' },
  { name: 'order a to b', action: 'order', record: null, target: 'a.csv', first: 'a.csv' },
  { name: 'order b to a', action: 'order', record: null, target: 'a.csv', first: 'b.csv' },
] as const)(
  'an inode-linked general file remains present through $name and repeated notices',
  async ({ action, record, target, first }) => {
    const bytes = 'same,inode,content\n';
    const a = writeDoc('a.csv', bytes);
    const b = join(contentDir, 'b.csv');
    const alias = join(contentDir, 'z-alias.csv');
    linkSync(a, b);
    symlinkSync(join(contentDir, target), alias);
    const second = first === 'a.csv' ? 'b.csv' : 'a.csv';
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries = [first, second, 'z-alias.csv'];
    const disk = () => ({
      a: {
        inode: Number(statSync(a).ino),
        links: statSync(a).nlink,
        regular: lstatSync(a).isFile(),
        canonicalPath: realpathSync(a),
        bytes: readFileSync(a, 'utf8'),
      },
      b: {
        inode: Number(statSync(b).ino),
        links: statSync(b).nlink,
        regular: lstatSync(b).isFile(),
        canonicalPath: realpathSync(b),
        bytes: readFileSync(b, 'utf8'),
      },
      alias: {
        inode: Number(statSync(alias).ino),
        symlink: lstatSync(alias).isSymbolicLink(),
        canonicalPath: realpathSync(alias),
        bytes: readFileSync(alias, 'utf8'),
      },
    });
    const initialDisk = disk();
    expect(initialDisk.a.inode).toBe(initialDisk.b.inode);
    expect(initialDisk.a.links).toBe(2);
    expect(initialDisk.b.links).toBe(2);
    expect(initialDisk.a.regular).toBe(true);
    expect(initialDisk.b.regular).toBe(true);
    expect(initialDisk.a.canonicalPath).toBe(a);
    expect(initialDisk.b.canonicalPath).toBe(b);
    expect(initialDisk.alias.symlink).toBe(true);
    expect(initialDisk.alias.canonicalPath).toBe(join(contentDir, target));
    expect([initialDisk.a.bytes, initialDisk.b.bytes, initialDisk.alias.bytes]).toEqual([
      bytes,
      bytes,
      bytes,
    ]);
    const events: DiskEvent[] = [];
    let watcher: WatcherHandle | undefined;
    try {
      watcher = await startWatcher(
        contentDir,
        async (event) => {
          events.push(event);
        },
        undefined,
        { forceBackend: 'parcel', platform: 'darwin' },
      );
      const active = watcher;
      const indexedPhysical = () =>
        indexedIdentityRows(active).filter(
          (entry) =>
            entry.kind === 'file' &&
            entry.inode === initialDisk.a.inode &&
            entry.size === statSync(a).size,
        );
      expect(indexedPhysical().length).toBeGreaterThan(0);
      const initialRepresentative = indexedPhysical()[0]?.name;
      if (action === 'order') {
        scanSchedule.orderedEntries = [second, first, 'z-alias.csv'];
        expect(events).toEqual([]);
      } else if (action === 'public') {
        const path = join(contentDir, target);
        const stat = statSync(path);
        const generation = active.getFileIndexGeneration();
        active.mutateFileIndex({
          kind: 'file-update',
          path,
          relativePath: target,
          size: stat.size,
          modifiedTs: stat.mtimeMs,
          inode: Number(stat.ino),
        });
        expect(active.getFileIndexGeneration()).toBeGreaterThan(generation);
      } else {
        const path = action === 'alias' ? alias : join(contentDir, target);
        await deliver(contentDir, [{ type: record, path }]);
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: record === 'create' ? 'file-create' : 'file-update',
            path,
          }),
        );
      }
      expect(disk()).toEqual(initialDisk);
      expect.soft(indexedPhysical().length).toBeGreaterThan(0);
      expect.soft(indexedPhysical()).toHaveLength(1);
      expect.soft(indexedPhysical()[0]?.name).toBe(initialRepresentative);
      expect.soft(indexedFileTargets(active)).toEqual(['a.csv', 'b.csv', 'z-alias.csv'].toSorted());
      events.length = 0;

      await deliverNotice(contentDir);
      const firstNoticeEvents = [...events];
      const firstNoticeRows = indexedPhysical();
      const firstNoticeTargets = indexedFileTargets(active);
      events.length = 0;
      await deliverNotice(contentDir);
      const repeatedNoticeEvents = [...events];

      expect(disk()).toEqual(initialDisk);
      expect.soft(indexedPhysical().length).toBeGreaterThan(0);
      expect.soft(firstNoticeRows).toHaveLength(1);
      expect.soft(firstNoticeRows[0]?.name).toBe(initialRepresentative);
      expect.soft(firstNoticeTargets).toEqual(['a.csv', 'b.csv', 'z-alias.csv'].toSorted());
      expect.soft(indexedPhysical()).toHaveLength(1);
      expect.soft(indexedPhysical()[0]?.name).toBe(initialRepresentative);
      expect.soft(indexedFileTargets(active)).toEqual(['a.csv', 'b.csv', 'z-alias.csv'].toSorted());
      expect
        .soft(
          firstNoticeEvents.filter(
            (event) =>
              (event.kind === 'asset-delete' || event.kind === 'file-delete') &&
              (event.path === a || event.path === b),
          ),
        )
        .toEqual([]);
      expect.soft(repeatedNoticeEvents).toEqual([]);
    } finally {
      scanSchedule.orderedEntries = null;
      scanSchedule.orderedPath = null;
      await watcher?.unsubscribe();
      if (watcher) expect(nativeSubscriptionOn(contentDir).nativeReleases()).toBe(1);
      rmSync(contentDir, { recursive: true, force: true });
      expect(existsSync(contentDir)).toBe(false);
    }
  },
);

test.each(['direct b update', 'order a to b'] as const)(
  'an admitted hardlink and actual symlink stay truthful in HTTP after $0',
  async (arm) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const bytes = 'same,inode,content\n';
    const a = writeDoc('a.csv', bytes);
    const b = join(contentDir, 'b.csv');
    const z = join(contentDir, 'z-alias.csv');
    const y = join(contentDir, 'y-alias.csv');
    linkSync(a, b);
    symlinkSync(a, z);
    symlinkSync(b, y);
    writeDoc('source.md', '# Source\n\n[A](a.csv)\n\n[B](b.csv)\n\n[Z](z-alias.csv)\n');
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries = ['a.csv', 'b.csv', 'y-alias.csv', 'z-alias.csv', 'source.md'];
    const physical = () => ({
      a: {
        inode: Number(statSync(a).ino),
        links: statSync(a).nlink,
        regular: lstatSync(a).isFile(),
        canonicalPath: realpathSync(a),
        bytes: readFileSync(a, 'utf8'),
      },
      b: {
        inode: Number(statSync(b).ino),
        links: statSync(b).nlink,
        regular: lstatSync(b).isFile(),
        canonicalPath: realpathSync(b),
        bytes: readFileSync(b, 'utf8'),
      },
      z: { symlink: lstatSync(z).isSymbolicLink(), target: realpathSync(z) },
      y: { symlink: lstatSync(y).isSymbolicLink(), target: realpathSync(y) },
    });
    const initialDisk = physical();
    expect(initialDisk.a.inode).toBe(initialDisk.b.inode);
    expect(initialDisk.a.links).toBe(2);
    expect(initialDisk.b.links).toBe(2);
    expect(initialDisk.a.regular).toBe(true);
    expect(initialDisk.b.regular).toBe(true);
    expect(initialDisk.a.canonicalPath).toBe(a);
    expect(initialDisk.b.canonicalPath).toBe(b);
    expect(initialDisk.z).toEqual({ symlink: true, target: a });
    expect(initialDisk.y).toEqual({ symlink: true, target: b });
    expect([initialDisk.a.bytes, initialDisk.b.bytes]).toEqual([bytes, bytes]);
    let server: Awaited<ReturnType<typeof bootInventoryServer>> | undefined;
    try {
      server = await bootInventoryServer();
      const active = server;
      const snapshot = async () => {
        const statuses = await inventoryForwardStatuses(active.port);
        const audit = {
          a: await inventoryAuditBroken(active.port, 'a.csv'),
          b: await inventoryAuditBroken(active.port, 'b.csv'),
        };
        const listingResponse = await fetch(`http://127.0.0.1:${active.port}/api/documents`);
        expect(listingResponse.status).toBe(200);
        const listing = (await listingResponse.json()) as {
          documents: Array<{
            kind: string;
            docName: string;
            isSymlink?: boolean;
            targetPath?: string | null;
          }>;
        };
        for (const path of ['a.csv', 'b.csv'] as const) {
          const response = await fetch(
            `http://127.0.0.1:${active.port}/api/asset-text?path=${path}`,
          );
          expect(response.status).toBe(200);
          expect(await response.text()).toBe(bytes);
        }
        const aliasAsset = await fetch(
          `http://127.0.0.1:${active.port}/api/asset-text?path=z-alias.csv`,
        );
        expect(aliasAsset.status).toBe(400);
        expect(physical()).toEqual(initialDisk);
        return {
          statuses,
          audit,
          unreferenced: listing.documents.find(
            (entry) => entry.kind === 'file' && entry.docName === 'y-alias.csv',
          ),
        };
      };
      const initial = await snapshot();
      expect(initial.statuses['a.csv']).toBe('exact');
      expect(initial.statuses['z-alias.csv']).toBe('exact');
      expect(initial.audit.a).toBe(false);
      if (arm === 'direct b update') {
        await nativeSubscriptionOn(contentDir).deliver([{ type: 'update', path: b }]);
      } else {
        scanSchedule.orderedEntries = ['b.csv', 'a.csv', 'y-alias.csv', 'z-alias.csv', 'source.md'];
      }
      const beforeNotice = await snapshot();
      const retained = arm === 'direct b update' ? 'b.csv' : 'a.csv';
      expect(beforeNotice.statuses['a.csv']).toBe('exact');
      expect(beforeNotice.statuses['z-alias.csv']).toBe('exact');
      expect(beforeNotice.statuses[retained]).toBe('exact');
      expect(beforeNotice.audit[retained === 'a.csv' ? 'a' : 'b']).toBe(false);

      await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
      const afterNotice = await snapshot();

      for (const [href, status] of Object.entries(beforeNotice.statuses)) {
        if (status === 'exact') expect.soft(afterNotice.statuses[href]).toBe('exact');
      }
      expect.soft(afterNotice.statuses[retained]).toBe('exact');
      expect.soft(afterNotice.audit[retained === 'a.csv' ? 'a' : 'b']).toBe(false);
      expect.soft(await inventoryAuditBroken(active.port, retained)).toBe(false);
      expect.soft(afterNotice.statuses['z-alias.csv']).toBe('exact');
      expect
        .soft([
          initial.unreferenced?.isSymlink,
          beforeNotice.unreferenced?.isSymlink,
          afterNotice.unreferenced?.isSymlink,
        ])
        .toEqual([true, true, true]);
      expect
        .soft([
          initial.unreferenced?.targetPath,
          beforeNotice.unreferenced?.targetPath,
          afterNotice.unreferenced?.targetPath,
        ])
        .toEqual(['b.csv', 'b.csv', 'b.csv']);
    } finally {
      scanSchedule.orderedEntries = null;
      scanSchedule.orderedPath = null;
      await server?.destroy();
      for (const dir of nativeSubscriptionDirs()) {
        expect(nativeSubscriptionOn(dir).nativeReleases()).toBe(1);
      }
    }
  },
);

test.each(['regular-first', 'alias-first'] as const)(
  'startup $0 admits every real hardlink name into one searchable group',
  async (order) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const bytes = 'shared,hardlink,bytes\n';
    const aName = 'a-amberpilot.csv';
    const bName = 'b-beaconquartz.csv';
    const zName = 'z-aliasindigo.csv';
    const a = writeDoc(aName, bytes);
    const b = join(contentDir, bName);
    const z = join(contentDir, zName);
    linkSync(a, b);
    symlinkSync(b, z);
    writeDoc('source.md', `# Source\n\n[A](${aName})\n\n[B](${bName})\n\n[Z](${zName})\n`);
    const aStat = statSync(a);
    const bStat = statSync(b);
    expect(lstatSync(a).isFile()).toBe(true);
    expect(lstatSync(b).isFile()).toBe(true);
    expect(lstatSync(z).isSymbolicLink()).toBe(true);
    expect([aStat.dev, aStat.ino]).toEqual([bStat.dev, bStat.ino]);
    expect(realpathSync(a)).toBe(a);
    expect(realpathSync(b)).toBe(b);
    expect(realpathSync(z)).toBe(b);
    expect([readFileSync(a, 'utf8'), readFileSync(b, 'utf8'), readFileSync(z, 'utf8')]).toEqual([
      bytes,
      bytes,
      bytes,
    ]);
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries =
      order === 'alias-first'
        ? [zName, aName, bName, 'source.md']
        : [aName, bName, zName, 'source.md'];
    const server = await bootInventoryServer();
    try {
      const statuses = await inventoryForwardStatuses(server.port);
      expect.soft(statuses).toEqual({
        [aName]: 'exact',
        [bName]: 'exact',
        [zName]: 'exact',
      });
      const listed = await listedEntries(server.port);
      for (const name of [aName, bName]) {
        expect
          .soft(listed.filter((row) => row.kind === 'asset' && row.docName === name))
          .toEqual([expect.objectContaining({ isSymlink: false, targetPath: null })]);
        expect
          .soft(listed.filter((row) => row.kind === 'file' && row.docName === name))
          .toEqual([]);
      }
      expect
        .soft(listed.filter((row) => row.kind === 'file' && row.docName === zName))
        .toEqual([expect.objectContaining({ isSymlink: true, targetPath: bName })]);
      const byA = await searchedFiles(server.port, 'a-amberpilot');
      const byB = await searchedFiles(server.port, 'b-beaconquartz');
      const byZ = await searchedFiles(server.port, 'z-aliasindigo');
      expect.soft(byA).toHaveLength(1);
      expect.soft(byB).toEqual(byA);
      expect.soft(byZ).toEqual(byA);
    } finally {
      scanSchedule.orderedEntries = null;
      scanSchedule.orderedPath = null;
      await server.destroy();
      for (const dir of nativeSubscriptionDirs()) {
        expect(nativeSubscriptionOn(dir).nativeReleases()).toBe(1);
      }
    }
  },
);

test.each(['rescued-folder-create', 'public-file-create', 'alias-before-member'] as const)(
  'a newly admitted hardlink joins its known physical group through $0',
  async (input) => {
    const bytes = 'known,member\n';
    const a = writeDoc('a.csv', bytes);
    const folder = join(contentDir, 'new-folder');
    const bName =
      input === 'rescued-folder-create'
        ? 'new-folder/b.csv'
        : input === 'public-file-create'
          ? '0-before/b.csv'
          : 'b.csv';
    const b = join(contentDir, bName);
    const z = join(contentDir, 'z-alias.csv');
    const { watcher, events } = await watchContent();
    const initialRepresentative = indexedGeneralRows(watcher)[0]?.name;
    expect(initialRepresentative).toBe('a.csv');
    if (input === 'rescued-folder-create' || input === 'public-file-create') mkdirSync(dirname(b));
    linkSync(a, b);
    expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
    expect(realpathSync(b)).toBe(b);

    if (input === 'rescued-folder-create') {
      await deliver(contentDir, [{ type: 'create', path: folder }]);
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'file-create', path: b, relativePath: bName }),
      );
    } else if (input === 'public-file-create') {
      expect(bName.localeCompare('a.csv')).toBeLessThan(0);
      const st = statSync(b);
      const generation = watcher.getFileIndexGeneration();
      watcher.mutateFileIndex({
        kind: 'file-create',
        path: b,
        relativePath: bName,
        size: st.size,
        modifiedTs: st.mtimeMs,
        inode: Number(st.ino),
      });
      expect(watcher.getFileIndexGeneration()).toBeGreaterThan(generation);
      expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
      expect.soft(indexedGeneralRows(watcher)[0]?.name).toBe(initialRepresentative);
      await deliver(contentDir, [{ type: 'create', path: dirname(b) }]);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'folder-create',
          path: dirname(b),
          relativePath: '0-before',
        }),
      );
      expect
        .soft(
          events.filter(
            (event) => event.kind === 'file-create' && (event.path === a || event.path === b),
          ),
        )
        .toEqual([]);
    } else {
      symlinkSync(b, z);
      expect(lstatSync(z).isSymbolicLink()).toBe(true);
      expect(realpathSync(z)).toBe(b);
      await deliver(contentDir, [{ type: 'create', path: z }]);
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'file-create', path: z, relativePath: 'z-alias.csv' }),
      );
    }
    expect(readFileSync(a, 'utf8')).toBe(bytes);
    expect(readFileSync(b, 'utf8')).toBe(bytes);
    expect(events.filter((event) => event.kind === 'file-create' && event.path === a)).toEqual([]);
    const expectedTargets = [
      'a.csv',
      bName,
      ...(input === 'alias-before-member' ? ['z-alias.csv'] : []),
    ].toSorted();
    expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
    expect.soft(indexedGeneralRows(watcher)[0]?.name).toBe(initialRepresentative);
    expect.soft(indexedFileTargets(watcher)).toEqual(expectedTargets);

    if (input === 'alias-before-member') {
      await deliver(contentDir, [{ type: 'update', path: b }]);
      expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
      expect.soft(indexedFileTargets(watcher)).toEqual(expectedTargets);
    }
    events.length = 0;
    await deliverNotice(contentDir);
    expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
    expect.soft(indexedGeneralRows(watcher)[0]?.name).toBe(initialRepresentative);
    expect.soft(indexedFileTargets(watcher)).toEqual(expectedTargets);
    expect
      .soft(
        events.filter(
          (event) => event.kind === 'file-delete' && (event.path === a || event.path === b),
        ),
      )
      .toEqual([]);
  },
);

test('a generation-backed search query learns a new hardlink name in the existing group', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const a = writeDoc('amberpilot.csv', 'searchable,hardlink\n');
  const b = join(contentDir, 'beaconquartz.csv');
  const z = join(contentDir, 'linked-indigo.csv');
  const server = await bootInventoryServer();
  try {
    expect(await searchedFiles(server.port, 'beaconquartz')).toEqual([]);
    expect(await searchedFiles(server.port, 'amberpilot')).toEqual(['amberpilot.csv']);
    linkSync(a, b);
    expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
    await nativeSubscriptionOn(contentDir).deliver([{ type: 'create', path: b }]);
    expect.soft(await searchedFiles(server.port, 'beaconquartz')).toEqual(['amberpilot.csv']);
    symlinkSync(b, z);
    await nativeSubscriptionOn(contentDir).deliver([{ type: 'create', path: z }]);
    expect.soft(await searchedFiles(server.port, 'linked-indigo')).toEqual(['amberpilot.csv']);
    expect.soft(await searchedFiles(server.port, 'amberpilot')).toEqual(['amberpilot.csv']);
    await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    expect.soft(await searchedFiles(server.port, 'beaconquartz')).toEqual(['amberpilot.csv']);
  } finally {
    await server.destroy();
    for (const dir of nativeSubscriptionDirs()) {
      expect(nativeSubscriptionOn(dir).nativeReleases()).toBe(1);
    }
  }
});

test('a public canonical path with a lexical symlink name joins the existing hardlink group', async () => {
  const a = writeDoc('a.csv', 'writer,shared\n');
  const { watcher } = await watchContent();
  const b = join(contentDir, 'b.csv');
  const z = join(contentDir, 'z-alias.csv');
  linkSync(a, b);
  symlinkSync(b, z);
  expect(lstatSync(b).isFile()).toBe(true);
  expect(lstatSync(z).isSymbolicLink()).toBe(true);
  expect(realpathSync(z)).toBe(b);
  expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
  const st = statSync(b);
  const generation = watcher.getFileIndexGeneration();
  watcher.mutateFileIndex({
    kind: 'file-update',
    path: b,
    relativePath: 'z-alias.csv',
    size: st.size,
    modifiedTs: st.mtimeMs,
    inode: Number(st.ino),
  });
  expect(watcher.getFileIndexGeneration()).toBeGreaterThan(generation);
  expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
  expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv', 'b.csv', 'z-alias.csv']);
  expect.soft(indexedGeneralRows(watcher)[0]?.aliases).toEqual(['z-alias.csv']);
  await deliverNotice(contentDir);
  expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
  expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv', 'b.csv', 'z-alias.csv']);
  expect(readFileSync(a, 'utf8')).toBe('writer,shared\n');
  expect(readFileSync(b, 'utf8')).toBe('writer,shared\n');
});

test('different devices do not merge equal reported inode numbers during external observation', async () => {
  const a = writeDoc('atlas.csv', 'atlas\n');
  const b = writeDoc('beacon.csv', 'beacon\n');
  const aPhysical = statSync(a);
  const bPhysical = statSync(b);
  expect(aPhysical.ino).not.toBe(bPhysical.ino);
  expect(aPhysical.dev).toBe(bPhysical.dev);
  deviceContrast.path = b;
  deviceContrast.device = aPhysical.dev + 1;
  deviceContrast.inode = aPhysical.ino;
  const { watcher } = await watchContent();
  expect(deviceContrast.observed).toBe(true);
  expect(readFileSync(a, 'utf8')).toBe('atlas\n');
  expect(readFileSync(b, 'utf8')).toBe('beacon\n');
  expect.soft(indexedGeneralRows(watcher)).toHaveLength(2);
  expect.soft(indexedFileTargets(watcher)).toEqual(['atlas.csv', 'beacon.csv']);
  deviceContrast.path = null;
});

test.each(['nonrepresentative', 'representative'] as const)(
  'deleting the $0 hardlink removes only that member and its dependent alias',
  async (removedRole) => {
    const a = writeDoc('a.csv', 'shared,bytes\n');
    const b = join(contentDir, 'b.csv');
    const document = writeDoc('a.csv.md', '# Same spelling\n');
    const z = join(contentDir, 'z-alias.csv');
    const y = join(contentDir, 'y-alias.csv');
    linkSync(a, b);
    symlinkSync(a, z);
    symlinkSync(b, y);
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries = ['a.csv', 'b.csv', 'y-alias.csv', 'z-alias.csv', 'a.csv.md'];
    const { watcher, events } = await watchContent();
    await deliver(contentDir, [{ type: 'update', path: b }]);
    const removed = removedRole === 'representative' ? a : b;
    const survivor = removed === a ? b : a;
    const survivingAlias = survivor === a ? 'z-alias.csv' : 'y-alias.csv';
    const lostAlias = survivor === a ? 'y-alias.csv' : 'z-alias.csv';
    expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
    expect
      .soft(indexedFileTargets(watcher))
      .toEqual(['a.csv', 'b.csv', 'y-alias.csv', 'z-alias.csv'].toSorted());

    events.length = 0;
    unlinkSync(removed);
    expect(existsSync(removed)).toBe(false);
    expect(readFileSync(survivor, 'utf8')).toBe('shared,bytes\n');
    await deliver(contentDir, [{ type: 'delete', path: removed }]);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'file-delete', path: removed }));
    expect(
      events.filter((event) => event.kind === 'file-delete' && event.path === survivor),
    ).toEqual([]);
    expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
    expect.soft(indexedGeneralRows(watcher)[0]?.name).toBe(survivor === a ? 'a.csv' : 'b.csv');
    expect
      .soft(indexedFileTargets(watcher))
      .toEqual([survivor === a ? 'a.csv' : 'b.csv', survivingAlias].toSorted());
    expect.soft(indexedFileTargets(watcher)).not.toContain(lostAlias);
    expect(watcher.getFileIndex().get('a.csv')?.canonicalPath).toBe(document);
    await deliverNotice(contentDir);
    expect
      .soft(indexedFileTargets(watcher))
      .toEqual([survivor === a ? 'a.csv' : 'b.csv', survivingAlias].toSorted());

    events.length = 0;
    unlinkSync(survivor);
    await deliver(contentDir, [{ type: 'delete', path: survivor }]);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'file-delete', path: survivor }));
    expect.soft(indexedGeneralRows(watcher)).toEqual([]);
    expect.soft(indexedFileTargets(watcher)).toEqual([]);
    await deliverNotice(contentDir);
    await deliverNotice(contentDir);
    expect.soft(indexedGeneralRows(watcher)).toEqual([]);
    expect.soft(indexedFileTargets(watcher)).toEqual([]);
    expect(watcher.getFileIndex().get('a.csv')?.canonicalPath).toBe(document);
    expect(readFileSync(document, 'utf8')).toBe('# Same spelling\n');
  },
);

test('a collapsed directory delete removes its member and alias but retains the outside hardlink', async () => {
  const a = writeDoc('a.csv', 'cross,directory\n');
  const nested = join(contentDir, 'nested');
  mkdirSync(nested);
  const b = join(nested, 'b.csv');
  const y = join(nested, 'y-alias.csv');
  linkSync(a, b);
  symlinkSync(b, y);
  const { watcher, events } = await watchContent();
  await deliver(contentDir, [{ type: 'update', path: b }]);
  expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
  events.length = 0;
  rmSync(nested, { recursive: true });
  expect(existsSync(nested)).toBe(false);
  expect(readFileSync(a, 'utf8')).toBe('cross,directory\n');
  await deliver(contentDir, [{ type: 'delete', path: nested }]);
  expect.soft(events).toContainEqual(expect.objectContaining({ kind: 'file-delete', path: b }));
  expect(events.filter((event) => event.kind === 'file-delete' && event.path === a)).toEqual([]);
  expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
  expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv']);
  await deliverNotice(contentDir);
  expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv']);
});

test.each(['ordinary-nonrepresentative', 'notice-representative'] as const)(
  'replacing the $0 hardlink moves only that pathname to its new physical group',
  async (input) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const aName = 'a-amberpilot.csv';
    const bName = 'b-beaconquartz.csv';
    const a = writeDoc(aName, 'old,shared\n');
    const b = join(contentDir, bName);
    const z = join(contentDir, 'z-alias.csv');
    const y = join(contentDir, 'y-alias.csv');
    linkSync(a, b);
    symlinkSync(a, z);
    symlinkSync(b, y);
    writeDoc('source.md', `# Source\n\n[A](${aName})\n\n[B](${bName})\n\n[Z](z-alias.csv)\n`);
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries = [aName, bName, 'y-alias.csv', 'z-alias.csv', 'source.md'];
    const server = await bootInventoryServer();
    try {
      const subscription = nativeSubscriptionOn(contentDir);
      await subscription.deliver([{ type: 'update', path: b }]);
      const before = await inventoryForwardStatuses(server.port);
      expect(before[aName]).toBe('exact');
      expect(before[bName]).toBe('exact');
      expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
      const replaced = input === 'ordinary-nonrepresentative' ? b : a;
      const survivor = replaced === a ? b : a;
      const temporary = writeDoc('replacement-temporary.csv', 'new,independent,bytes\n');
      renameSync(temporary, replaced);
      expect(statSync(replaced).ino).not.toBe(statSync(survivor).ino);
      expect(readFileSync(replaced, 'utf8')).toBe('new,independent,bytes\n');
      expect(readFileSync(survivor, 'utf8')).toBe('old,shared\n');
      expect(realpathSync(y)).toBe(b);
      expect(realpathSync(z)).toBe(a);
      if (input === 'ordinary-nonrepresentative') {
        await subscription.deliver([{ type: 'update', path: replaced }]);
      } else {
        await subscription.deliver([], new Error(notices[0]));
      }
      const statuses = await inventoryForwardStatuses(server.port);
      expect.soft(statuses[aName]).toBe('exact');
      expect.soft(statuses[bName]).toBe('exact');
      expect.soft(statuses['z-alias.csv']).toBe('exact');
      expect.soft(await inventoryAuditBroken(server.port, aName)).toBe(false);
      expect.soft(await inventoryAuditBroken(server.port, bName)).toBe(false);
      const listing = await listedEntries(server.port);
      expect
        .soft(listing.filter((row) => row.kind === 'file' && row.docName === 'y-alias.csv'))
        .toEqual([expect.objectContaining({ isSymlink: true, targetPath: bName })]);
      expect
        .soft(listing.filter((row) => row.kind === 'file' && row.docName === 'z-alias.csv'))
        .toEqual([expect.objectContaining({ isSymlink: true, targetPath: aName })]);
      const byA = await searchedFiles(server.port, 'a-amberpilot');
      const byB = await searchedFiles(server.port, 'b-beaconquartz');
      expect.soft(byA).toHaveLength(1);
      expect.soft(byB).toHaveLength(1);
      expect.soft(byA[0]).not.toBe(byB[0]);
      await subscription.deliver([], new Error(notices[0]));
      expect.soft(await searchedFiles(server.port, 'a-amberpilot')).toEqual(byA);
      expect.soft(await searchedFiles(server.port, 'b-beaconquartz')).toEqual(byB);
      expect
        .soft(
          (await listedEntries(server.port)).filter(
            (row) => row.kind === 'file' && row.docName === 'z-alias.csv',
          ),
        )
        .toEqual([expect.objectContaining({ isSymlink: true, targetPath: aName })]);
    } finally {
      scanSchedule.orderedEntries = null;
      scanSchedule.orderedPath = null;
      await server.destroy();
      for (const dir of nativeSubscriptionDirs()) {
        expect(nativeSubscriptionOn(dir).nativeReleases()).toBe(1);
      }
    }
  },
);

test('a regular hardlink converted to a real symlink and back changes its listed role once', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const aName = 'a-amberpilot.csv';
  const bName = 'b-beaconquartz.csv';
  const cName = 'c-cometnova.csv';
  const a = writeDoc(aName, 'same,role\n');
  const b = join(contentDir, bName);
  const c = writeDoc(cName, 'separate,role,target\n');
  const dependentName = 'y-dependentindigo.csv';
  const dependent = join(contentDir, dependentName);
  const siblingName = 'z-independentviolet.csv';
  const sibling = join(contentDir, siblingName);
  linkSync(a, b);
  symlinkSync(b, dependent);
  symlinkSync(a, sibling);
  writeDoc('source.md', `# Source\n\n[A](${aName})\n`);
  const server = await bootInventoryServer();
  try {
    const subscription = nativeSubscriptionOn(contentDir);
    await subscription.deliver([{ type: 'update', path: b }]);
    const role = async () =>
      (await listedEntries(server.port)).filter(
        (row) => row.kind === 'file' && row.docName === bName,
      );
    const dependentRole = async (targetPath: string, owner = aName) => {
      expect(lstatSync(dependent).isSymbolicLink()).toBe(true);
      expect(realpathSync(dependent)).toBe(join(contentDir, targetPath));
      expect
        .soft((await listedEntries(server.port)).filter((row) => row.docName === dependentName))
        .toEqual([expect.objectContaining({ kind: 'file', isSymlink: true, targetPath })]);
      expect.soft(await searchedFiles(server.port, 'y-dependentindigo')).toEqual([owner]);
    };
    expect(lstatSync(b).isFile()).toBe(true);
    expect
      .soft(await role())
      .toEqual([expect.objectContaining({ isSymlink: false, targetPath: null })]);

    await dependentRole(bName);
    const priorSize = statSync(b).size;
    writeFileSync(b, 'same,role,updated,ordinary\n');
    const metadataStat = statSync(b);
    expect(metadataStat.size).not.toBe(priorSize);
    denyAdmission('realpath', dependent);
    await subscription.deliver([{ type: 'update', path: b }]);
    const metadataRows = await listedEntries(server.port);
    expect.soft(metadataRows.find((row) => row.docName === bName)?.size).toBe(metadataStat.size);
    expect
      .soft(metadataRows.find((row) => row.docName === dependentName)?.size)
      .toBe(metadataStat.size);
    expect
      .soft(metadataRows.find((row) => row.docName === siblingName)?.size)
      .toBe(metadataStat.size);
    clearAdmissionDenial();
    writeFileSync(b, 'same,role\n');
    await subscription.deliver([{ type: 'update', path: b }]);
    await dependentRole(bName);
    const priorRoleRows = (await listedEntries(server.port)).filter(
      (row) => row.docName === bName || row.docName === dependentName,
    );
    expect(priorRoleRows).toHaveLength(2);
    unlinkSync(b);
    symlinkSync(a, b);
    expect(lstatSync(b).isSymbolicLink()).toBe(true);
    expect(realpathSync(b)).toBe(a);
    expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
    const later = writeDoc('later-role.csv', 'later,independent\n');
    denyAdmission('realpath', dependent);
    await subscription.deliver([
      { type: 'update', path: b },
      { type: 'create', path: later },
    ]);
    expect(admissionFault.observed).toBe(true);
    expect
      .soft(
        (await listedEntries(server.port)).filter(
          (row) => row.docName === bName || row.docName === dependentName,
        ),
      )
      .toEqual(priorRoleRows);
    expect(
      (await listedEntries(server.port)).filter((row) => row.docName === 'later-role.csv'),
    ).toEqual([expect.objectContaining({ kind: 'file', isSymlink: false, targetPath: null })]);
    expect(readFileSync(later, 'utf8')).toBe('later,independent\n');
    clearAdmissionDenial();
    await subscription.deliver([], new Error(notices[0]));
    expect
      .soft(await role())
      .toEqual([expect.objectContaining({ isSymlink: true, targetPath: aName })]);
    expect.soft(await searchedFiles(server.port, 'b-beaconquartz')).toEqual([aName]);
    await dependentRole(aName);

    const dName = 'd-deltaorbit.csv';
    const d = join(contentDir, dName);
    linkSync(a, d);
    expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(d).dev, statSync(d).ino]);
    await subscription.deliver([{ type: 'create', path: d }]);
    expect.soft(await searchedFiles(server.port, 'd-deltaorbit')).toEqual([aName]);

    unlinkSync(b);
    symlinkSync(d, b);
    expect(lstatSync(b).isSymbolicLink()).toBe(true);
    expect(realpathSync(b)).toBe(d);
    expect(realpathSync(dependent)).toBe(d);
    await subscription.deliver([{ type: 'update', path: b }]);
    expect
      .soft(await role())
      .toEqual([expect.objectContaining({ isSymlink: true, targetPath: dName })]);
    await dependentRole(dName);
    expect.soft(await searchedFiles(server.port, 'b-beaconquartz')).toEqual([aName]);

    unlinkSync(b);
    symlinkSync(c, b);
    expect(lstatSync(b).isSymbolicLink()).toBe(true);
    expect(realpathSync(b)).toBe(c);
    expect(realpathSync(dependent)).toBe(c);
    expect(statSync(c).ino).not.toBe(statSync(a).ino);
    await subscription.deliver([{ type: 'update', path: b }]);
    expect
      .soft(await role())
      .toEqual([expect.objectContaining({ isSymlink: true, targetPath: cName })]);
    await dependentRole(cName, cName);
    expect.soft(await searchedFiles(server.port, 'b-beaconquartz')).toEqual([cName]);
    expect.soft(await searchedFiles(server.port, 'a-amberpilot')).toEqual([aName]);

    unlinkSync(b);
    linkSync(a, b);
    expect(lstatSync(b).isFile()).toBe(true);
    await subscription.deliver([{ type: 'update', path: b }]);
    expect
      .soft(await role())
      .toEqual([expect.objectContaining({ isSymlink: false, targetPath: null })]);
    expect.soft(await searchedFiles(server.port, 'b-beaconquartz')).toEqual([aName]);
    await dependentRole(bName);
    await subscription.deliver([], new Error(notices[0]));
    expect
      .soft(await role())
      .toEqual([expect.objectContaining({ isSymlink: false, targetPath: null })]);
    await dependentRole(bName);
    expect(statSync(c).ino).not.toBe(statSync(a).ino);
    unlinkSync(b);
    symlinkSync(c, b);
    expect(realpathSync(b)).toBe(c);
    await subscription.deliver([{ type: 'update', path: b }]);
    expect
      .soft(await role())
      .toEqual([expect.objectContaining({ isSymlink: true, targetPath: cName })]);
    await dependentRole(cName, cName);
    expect.soft(await searchedFiles(server.port, 'b-beaconquartz')).toEqual([cName]);
    expect.soft(await searchedFiles(server.port, 'a-amberpilot')).toEqual([aName]);
    unlinkSync(b);
    linkSync(a, b);
    expect(lstatSync(b).isFile()).toBe(true);
    await subscription.deliver([{ type: 'update', path: b }]);
    expect
      .soft(await role())
      .toEqual([expect.objectContaining({ isSymlink: false, targetPath: null })]);
    await dependentRole(bName);
    expect.soft(await searchedFiles(server.port, 'b-beaconquartz')).toEqual([aName]);
    expect.soft(await searchedFiles(server.port, 'c-cometnova')).toEqual([cName]);
    await subscription.deliver([], new Error(notices[0]));
    await dependentRole(bName);
    expect(readFileSync(c, 'utf8')).toBe('separate,role,target\n');
    expect(readFileSync(a, 'utf8')).toBe('same,role\n');
  } finally {
    await server.destroy();
    for (const dir of nativeSubscriptionDirs()) {
      expect(nativeSubscriptionOn(dir).nativeReleases()).toBe(1);
    }
  }
});

test('an absent former target and a later denied dependent read leave the prior group intact', async () => {
  const a = writeDoc('a.csv', 'a,group\n');
  const b = join(contentDir, 'b.csv');
  const c = writeDoc('c.csv', 'c,group\n');
  const survivor = join(contentDir, 'c-survivor.csv');
  const dependent = join(contentDir, 'y-dependent.csv');
  const survivorAlias = join(contentDir, 'z-survivor.csv');
  symlinkSync(c, b);
  linkSync(c, survivor);
  symlinkSync(b, dependent);
  symlinkSync(survivor, survivorAlias);
  const { watcher, events } = await watchContent();
  expect(realpathSync(dependent)).toBe(c);
  expect(realpathSync(survivorAlias)).toBe(survivor);
  const prior = indexedAliasOwner(watcher, 'b.csv');
  expect(prior).toBeDefined();
  expect(prior?.aliases).toEqual(
    expect.arrayContaining(['b.csv', 'y-dependent.csv', 'z-survivor.csv']),
  );
  unlinkSync(c);
  expect(existsSync(c)).toBe(false);
  expect(readFileSync(survivor, 'utf8')).toBe('c,group\n');
  unlinkSync(b);
  linkSync(a, b);
  expect(realpathSync(dependent)).toBe(b);
  const later = writeDoc('later.csv', 'later\n');
  denyAdmission('realpath', survivorAlias);
  events.length = 0;
  await deliver(contentDir, [
    { type: 'update', path: b },
    { type: 'create', path: later },
  ]);
  expect.soft(admissionFault.observed).toBe(true);
  expect(events).toContainEqual(
    expect.objectContaining({ kind: 'file-create', path: later, relativePath: 'later.csv' }),
  );
  expect.soft(indexedAliasOwner(watcher, 'b.csv')).toEqual(prior);
  expect
    .soft(indexedFileTargets(watcher))
    .toEqual(
      [
        'a.csv',
        'b.csv',
        'c.csv',
        'c-survivor.csv',
        'later.csv',
        'y-dependent.csv',
        'z-survivor.csv',
      ].toSorted(),
    );
  clearAdmissionDenial();
  await deliverNotice(contentDir);
  expect
    .soft(indexedFileTargets(watcher))
    .toEqual(
      [
        'a.csv',
        'b.csv',
        'c-survivor.csv',
        'later.csv',
        'y-dependent.csv',
        'z-survivor.csv',
      ].toSorted(),
    );
  expect(readFileSync(a, 'utf8')).toBe('a,group\n');
  expect(readFileSync(survivor, 'utf8')).toBe('c,group\n');
});

test.each(['startup', 'recovery'] as const)(
  'a role change observed during a %s scan keeps ignored dependent targets out of the index',
  async (scan) => {
    const x = writeDoc('x.csv', 'x,bytes\n');
    const c = writeDoc('c.csv', 'c,bytes\n');
    const blocked = writeDoc('blocked.csv', 'ignored,bytes\n');
    const r = join(contentDir, 'r.csv');
    const l = join(contentDir, 'l.csv');
    symlinkSync(x, r);
    symlinkSync(x, l);
    writeDoc('.okignore', 'blocked.csv\n');
    const filter = dynamicSkillFilter();
    expect(filter.isPathIgnored('blocked.csv')).toBe(true);
    const entered = deferred();
    const resume = deferred();
    const holdScan = () => {
      scanSchedule.orderedPath = contentDir;
      scanSchedule.orderedEntries = ['r.csv', 'l.csv', 'x.csv'];
      memberStatSchedule.path = l;
      memberStatSchedule.entered = entered.release;
      memberStatSchedule.resume = resume.promise;
    };
    if (scan === 'startup') holdScan();
    const started = watchContent(filter);
    let pending: Promise<unknown> = started;
    if (scan === 'recovery') {
      const { watcher } = await started;
      expect(
        [...(localTargetInventoryFromWatcher(watcher, contentDir)?.fileTargets ?? [])].toSorted(),
      ).toEqual(['.okignore', 'c.csv', 'l.csv', 'r.csv', 'x.csv']);
      holdScan();
      pending = deliverNotice(contentDir);
    }
    try {
      await entered.promise;
      unlinkSync(x);
      symlinkSync(c, x);
      unlinkSync(r);
      symlinkSync(blocked, r);
      expect(realpathSync(x)).toBe(c);
      expect(realpathSync(r)).toBe(blocked);
    } finally {
      resume.release();
      await pending;
    }
    const { watcher } = await started;
    const generalMembers = [...watcher.getAllFilesIndex()].flatMap(([name, entry]) =>
      entry.kind === 'file'
        ? [
            name,
            ...(entry.fileMembers?.regularPaths ?? []),
            ...(entry.fileMembers?.symlinks.map((relation) => relation.path) ?? []),
          ]
        : [],
    );
    expect([...new Set(generalMembers)].toSorted()).toEqual([
      '.okignore',
      'c.csv',
      'l.csv',
      'x.csv',
    ]);
    expect(generalMembers).not.toContain('blocked.csv');
    expect(generalMembers).not.toContain('r.csv');
  },
);

test('a role change removes absent and ignored dependents while retaining accepted relations', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const a = writeDoc('a.csv', 'old,group\n');
  const b = join(contentDir, 'b.csv');
  const c = writeDoc('c.csv', 'new,group\n');
  const ignored = writeDoc('blocked.csv', 'ignored,group\n');
  const y = join(contentDir, 'y-alias.csv');
  const missing = join(contentDir, 'm-removed.csv');
  const rejected = join(contentDir, 'q-rejected.csv');
  const z = join(contentDir, 'z-unrelated.csv');
  linkSync(a, b);
  symlinkSync(b, y);
  symlinkSync(a, missing);
  symlinkSync(b, rejected);
  symlinkSync(a, z);
  writeDoc('.okignore', 'blocked.csv\n');
  const filter = dynamicSkillFilter();
  expect(filter.isPathIgnored('blocked.csv')).toBe(true);
  expect(filter.isPathIgnored('q-rejected.csv')).toBe(false);
  const server = await bootInventoryServer();
  try {
    const subscription = nativeSubscriptionOn(contentDir);
    await subscription.deliver([{ type: 'update', path: b }]);
    const initial = await listedEntries(server.port);
    for (const name of ['y-alias.csv', 'm-removed.csv', 'q-rejected.csv', 'z-unrelated.csv']) {
      expect(initial.filter((row) => row.kind === 'file' && row.docName === name)).toHaveLength(1);
    }
    expect(realpathSync(missing)).toBe(a);
    unlinkSync(missing);
    unlinkSync(rejected);
    symlinkSync(ignored, rejected);
    unlinkSync(b);
    symlinkSync(c, b);
    expect(existsSync(missing)).toBe(false);
    expect(realpathSync(rejected)).toBe(ignored);
    expect(realpathSync(y)).toBe(c);
    expect(realpathSync(z)).toBe(a);
    await subscription.deliver([{ type: 'update', path: b }]);
    const settled = await listedEntries(server.port);
    expect
      .soft(settled.filter((row) => row.kind === 'file' && row.docName === 'b.csv'))
      .toEqual([expect.objectContaining({ isSymlink: true, targetPath: 'c.csv' })]);
    expect
      .soft(settled.filter((row) => row.kind === 'file' && row.docName === 'y-alias.csv'))
      .toEqual([expect.objectContaining({ isSymlink: true, targetPath: 'c.csv' })]);
    expect
      .soft(settled.filter((row) => row.kind === 'file' && row.docName === 'm-removed.csv'))
      .toEqual([]);
    expect
      .soft(settled.filter((row) => row.kind === 'file' && row.docName === 'q-rejected.csv'))
      .toEqual([]);
    expect
      .soft(settled.filter((row) => row.kind === 'file' && row.docName === 'a.csv'))
      .toHaveLength(1);
    expect
      .soft(settled.filter((row) => row.kind === 'file' && row.docName === 'z-unrelated.csv'))
      .toEqual([expect.objectContaining({ isSymlink: true, targetPath: 'a.csv' })]);
    expect.soft(await searchedFiles(server.port, 'y-alias')).toEqual(['c.csv']);
    expect.soft(await searchedFiles(server.port, 'q-rejected')).toEqual([]);
    await subscription.deliver([], new Error(notices[0]));
    const afterNotice = await listedEntries(server.port);
    expect
      .soft(afterNotice.filter((row) => row.kind === 'file' && row.docName === 'y-alias.csv'))
      .toEqual([expect.objectContaining({ isSymlink: true, targetPath: 'c.csv' })]);
    expect
      .soft(afterNotice.filter((row) => row.kind === 'file' && row.docName === 'q-rejected.csv'))
      .toEqual([]);
    expect(readFileSync(a, 'utf8')).toBe('old,group\n');
    expect(readFileSync(c, 'utf8')).toBe('new,group\n');
  } finally {
    await server.destroy();
    for (const dir of nativeSubscriptionDirs()) {
      expect(nativeSubscriptionOn(dir).nativeReleases()).toBe(1);
    }
  }
});

test('an actual alias retargets across member names and physical groups without moving its siblings', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const aName = 'a-amberpilot.csv';
  const bName = 'b-beaconquartz.csv';
  const cName = 'c-cometnova.csv';
  const a = writeDoc(aName, 'same,group\n');
  const b = join(contentDir, bName);
  const c = writeDoc(cName, 'other,group\n');
  const y = join(contentDir, 'y-aliasindigo.csv');
  const z = join(contentDir, 'z-aliasviolet.csv');
  linkSync(a, b);
  symlinkSync(a, y);
  symlinkSync(b, z);
  const server = await bootInventoryServer();
  try {
    const subscription = nativeSubscriptionOn(contentDir);
    await subscription.deliver([{ type: 'update', path: b }]);
    const aliasRows = async (name: string) =>
      (await listedEntries(server.port)).filter(
        (row) => row.kind === 'file' && row.docName === name,
      );
    expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
    expect(statSync(c).ino).not.toBe(statSync(a).ino);
    expect(realpathSync(y)).toBe(a);
    expect(realpathSync(z)).toBe(b);

    unlinkSync(y);
    symlinkSync(b, y);
    await subscription.deliver([{ type: 'update', path: y }]);
    expect
      .soft(await aliasRows('y-aliasindigo.csv'))
      .toEqual([expect.objectContaining({ isSymlink: true, targetPath: bName })]);
    expect
      .soft(await aliasRows('z-aliasviolet.csv'))
      .toEqual([expect.objectContaining({ isSymlink: true, targetPath: bName })]);
    expect.soft(await searchedFiles(server.port, 'y-aliasindigo')).toEqual([aName]);
    expect.soft(await searchedFiles(server.port, 'b-beaconquartz')).toEqual([aName]);

    unlinkSync(y);
    symlinkSync(c, y);
    await subscription.deliver([], new Error(notices[0]));
    expect
      .soft(await aliasRows('y-aliasindigo.csv'))
      .toEqual([expect.objectContaining({ isSymlink: true, targetPath: cName })]);
    expect.soft(await searchedFiles(server.port, 'y-aliasindigo')).toEqual([cName]);
    expect.soft(await searchedFiles(server.port, 'b-beaconquartz')).toEqual([aName]);
    expect
      .soft(await aliasRows('z-aliasviolet.csv'))
      .toEqual([expect.objectContaining({ isSymlink: true, targetPath: bName })]);

    unlinkSync(y);
    await subscription.deliver([{ type: 'delete', path: y }]);
    expect.soft(await aliasRows('y-aliasindigo.csv')).toEqual([]);
    expect.soft(await searchedFiles(server.port, 'y-aliasindigo')).toEqual([]);
    await subscription.deliver([], new Error(notices[0]));
    expect.soft(await aliasRows('y-aliasindigo.csv')).toEqual([]);
    expect
      .soft(await aliasRows('z-aliasviolet.csv'))
      .toEqual([expect.objectContaining({ isSymlink: true, targetPath: bName })]);
    expect(readFileSync(a, 'utf8')).toBe('same,group\n');
    expect(readFileSync(b, 'utf8')).toBe('same,group\n');
    expect(readFileSync(c, 'utf8')).toBe('other,group\n');
  } finally {
    await server.destroy();
    for (const dir of nativeSubscriptionDirs()) {
      expect(nativeSubscriptionOn(dir).nativeReleases()).toBe(1);
    }
  }
});

test('a denied actual former target preserves its hardlink group and later record until recovery', async () => {
  const a = writeDoc('a.csv', 'prior,shared\n');
  const blocked = join(contentDir, 'blocked');
  mkdirSync(blocked);
  const b = join(blocked, 'b.csv');
  const c = writeDoc('other.csv', 'other,content\n');
  const y = join(contentDir, 'y-alias.csv');
  const z = join(contentDir, 'z-alias.csv');
  linkSync(a, b);
  symlinkSync(b, y);
  symlinkSync(a, z);
  scanSchedule.orderedPath = contentDir;
  scanSchedule.orderedEntries = ['a.csv', 'blocked', 'other.csv', 'y-alias.csv', 'z-alias.csv'];
  const events: DiskEvent[] = [];
  const completed: string[] = [];
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
    },
    undefined,
    {
      forceBackend: 'parcel',
      platform: 'darwin',
      onRecoveryComplete: async () => {
        completed.push('complete');
      },
    },
  );
  handles.push(watcher);
  await deliver(contentDir, [{ type: 'update', path: b }]);
  expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
  expect(realpathSync(y)).toBe(b);
  expect
    .soft(indexedFileTargets(watcher))
    .toEqual(['a.csv', 'blocked/b.csv', 'other.csv', 'y-alias.csv', 'z-alias.csv'].toSorted());
  const formerOwner = indexedAliasOwner(watcher, 'y-alias.csv');
  expect(formerOwner).toMatchObject({
    canonicalPath: a,
    size: statSync(a).size,
    modified: statSync(a).mtime.toISOString(),
    inode: Number(statSync(a).ino),
    aliases: expect.arrayContaining(['y-alias.csv', 'z-alias.csv']),
  });

  unlinkSync(y);
  symlinkSync(c, y);
  const later = writeDoc('later.csv', 'later,record\n');
  denyAdmission('realpath', b);
  deniedDirectoryRead.path = blocked;
  await deliverNotice(contentDir, [
    { type: 'update', path: y },
    { type: 'create', path: later },
  ]);
  expect.soft(admissionFault.observed).toBe(true);
  expect(events).toContainEqual(
    expect.objectContaining({ kind: 'file-create', path: later, relativePath: 'later.csv' }),
  );
  expect(deniedDirectoryRead.path).toBeNull();
  expect(completed).toEqual([]);
  expect(readFileSync(a, 'utf8')).toBe('prior,shared\n');
  expect(readFileSync(b, 'utf8')).toBe('prior,shared\n');
  expect.soft(indexedFileTargets(watcher)).toContain('blocked/b.csv');
  expect.soft(indexedFileTargets(watcher)).toContain('z-alias.csv');
  expect.soft(indexedFileTargets(watcher)).toContain('later.csv');
  expect.soft(indexedAliasOwner(watcher, 'y-alias.csv')).toMatchObject({
    canonicalPath: a,
    size: formerOwner?.size,
    modified: formerOwner?.modified,
    inode: formerOwner?.inode,
    aliases: expect.arrayContaining(['y-alias.csv', 'z-alias.csv']),
  });
  expect.soft(indexedAliasOwner(watcher, 'z-alias.csv')?.canonicalPath).toBe(a);

  clearAdmissionDenial();
  await deliverNotice(contentDir);
  expect(completed).toEqual(['complete']);
  expect.soft(indexedFileTargets(watcher)).toContain('a.csv');
  expect.soft(indexedFileTargets(watcher)).toContain('blocked/b.csv');
  expect.soft(indexedAliasOwner(watcher, 'y-alias.csv')?.canonicalPath).toBe(c);
});

test('filter rebuild prunes individual hardlink paths and aliases before positive reseeding', async () => {
  const a = writeDoc('a.csv', 'filter,shared\n');
  const b = join(contentDir, 'b.csv');
  const document = writeDoc('a.csv.md', '# Document stays\n');
  const z = join(contentDir, 'z-alias.csv');
  const y = join(contentDir, 'y-alias.csv');
  linkSync(a, b);
  symlinkSync(a, z);
  symlinkSync(b, y);
  const ignore = writeDoc('.okignore', 'a.csv\n');
  const filter = dynamicSkillFilter();
  scanSchedule.orderedPath = contentDir;
  scanSchedule.orderedEntries = ['a.csv', 'b.csv', 'y-alias.csv', 'z-alias.csv', 'a.csv.md'];
  const { watcher, events } = await watchContent(filter);
  const memberRows = () =>
    indexedGeneralRows(watcher).filter((row) => row.inode === statSync(a).ino);
  const memberTargets = () => indexedFileTargets(watcher).filter((name) => name !== '.okignore');
  expect(filter.isPathIgnored('a.csv')).toBe(true);
  expect(filter.isPathIgnored('b.csv')).toBe(false);
  expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
  expect.soft(memberRows()).toHaveLength(1);
  expect.soft(memberTargets()).toEqual(['b.csv', 'y-alias.csv']);
  expect(watcher.getFileIndex().get('a.csv')?.canonicalPath).toBe(document);

  writeFileSync(ignore, '');
  expect((await filter.rebuildIgnorePatterns()).ok).toBe(true);
  await reconcileFileIndexAfterFilterRebuild(watcher);
  expect.soft(memberRows()).toHaveLength(1);
  expect.soft(memberTargets()).toEqual(['a.csv', 'b.csv', 'y-alias.csv', 'z-alias.csv'].toSorted());

  for (const phase of [
    {
      ignored: 'y-alias.csv\n',
      expected: ['a.csv', 'b.csv', 'z-alias.csv'],
      removedGroups: 0,
    },
    {
      ignored: 'b.csv\n',
      expected: ['a.csv', 'z-alias.csv'],
      removedGroups: 0,
    },
    { ignored: 'b.csv\na.csv\n', expected: [], removedGroups: 1 },
  ]) {
    if (phase.ignored === 'b.csv\n') {
      writeFileSync(ignore, '');
      expect((await filter.rebuildIgnorePatterns()).ok).toBe(true);
      await reconcileFileIndexAfterFilterRebuild(watcher);
      expect(filter.isPathIgnored('y-alias.csv')).toBe(false);
      expect.soft(memberTargets()).toContain('y-alias.csv');
      expect.soft(memberTargets()).toContain('b.csv');
    }
    writeFileSync(ignore, phase.ignored);
    expect((await filter.rebuildIgnorePatterns()).ok).toBe(true);
    const generation = watcher.getFileIndexGeneration();
    const cached = localTargetInventoryFromWatcher(watcher, contentDir);
    const removed = watcher.pruneFileIndexNowExcluded();
    expect.soft(removed).toBe(phase.removedGroups);
    expect.soft(watcher.getFileIndexGeneration()).toBeGreaterThan(generation);
    expect.soft(localTargetInventoryFromWatcher(watcher, contentDir)).not.toBe(cached);
    expect.soft(memberTargets()).toEqual(phase.expected.toSorted());
    await watcher.rescanFromDisk();
    expect.soft(memberTargets()).toEqual(phase.expected.toSorted());
    expect(watcher.getFileIndex().get('a.csv')?.canonicalPath).toBe(document);
  }

  writeFileSync(ignore, '');
  expect((await filter.rebuildIgnorePatterns()).ok).toBe(true);
  await reconcileFileIndexAfterFilterRebuild(watcher);
  expect.soft(memberRows()).toHaveLength(1);
  expect.soft(memberTargets()).toEqual(['a.csv', 'b.csv', 'y-alias.csv', 'z-alias.csv'].toSorted());
  expect(events).toEqual([]);
  expect(readFileSync(document, 'utf8')).toBe('# Document stays\n');
});

test('a positive reseed retains unseen members and an incomplete notice defers their removal', async () => {
  const a = writeDoc('a.csv', 'partial,shared\n');
  const nested = join(contentDir, 'nested');
  mkdirSync(nested);
  const b = join(nested, 'b.csv');
  linkSync(a, b);
  const events: DiskEvent[] = [];
  const completed: string[] = [];
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
    },
    undefined,
    {
      forceBackend: 'parcel',
      platform: 'darwin',
      onRecoveryComplete: async () => {
        completed.push('complete');
      },
    },
  );
  handles.push(watcher);
  await deliver(contentDir, [{ type: 'update', path: b }]);
  const c = join(contentDir, 'c.csv');
  linkSync(a, c);
  expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(c).dev, statSync(c).ino]);
  const beforeReseed = [...events];
  deniedDirectoryRead.path = nested;
  await watcher.rescanFromDisk();
  expect(deniedDirectoryRead.path).toBeNull();
  expect.soft(events).toEqual(beforeReseed);
  expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
  expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv', 'c.csv', 'nested/b.csv'].toSorted());
  expect(events).toContainEqual(
    expect.objectContaining({ kind: 'file-update', path: b, relativePath: 'nested/b.csv' }),
  );

  unlinkSync(b);
  deniedDirectoryRead.path = nested;
  const before = [...events];
  await deliverNotice(contentDir);
  expect(deniedDirectoryRead.path).toBeNull();
  expect(completed).toEqual([]);
  expect.soft(indexedFileTargets(watcher)).toContain('nested/b.csv');
  expect(events).toEqual(before);
  await deliverNotice(contentDir);
  expect(completed).toEqual(['complete']);
  expect
    .soft(events)
    .toContainEqual(
      expect.objectContaining({ kind: 'file-delete', path: b, relativePath: 'nested/b.csv' }),
    );
  expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
  expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv', 'c.csv']);
  expect
    .soft(events.filter((event) => event.kind === 'file-delete' && event.path === a))
    .toEqual([]);
  expect
    .soft(events.filter((event) => event.kind === 'file-delete' && event.path === c))
    .toEqual([]);
  expect(readFileSync(a, 'utf8')).toBe('partial,shared\n');
  expect(readFileSync(c, 'utf8')).toBe('partial,shared\n');
});

test('a public update to one member before synthesis does not suppress another member deletion', async () => {
  const a = writeDoc('a.csv', 'old,shared\n');
  const b = join(contentDir, 'b.csv');
  const z = join(contentDir, 'z-alias.csv');
  const y = join(contentDir, 'y-alias.csv');
  linkSync(a, b);
  symlinkSync(a, z);
  symlinkSync(b, y);
  const events: DiskEvent[] = [];
  const completed: string[] = [];
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
    },
    undefined,
    {
      forceBackend: 'parcel',
      platform: 'darwin',
      onRecoveryComplete: async () => {
        completed.push('complete');
      },
    },
  );
  handles.push(watcher);
  await deliver(contentDir, [{ type: 'update', path: b }]);
  events.length = 0;
  unlinkSync(a);
  expect(existsSync(a)).toBe(false);
  expect(readFileSync(b, 'utf8')).toBe('old,shared\n');
  const entered = deferred();
  const resume = deferred();
  scanSchedule.holdPath = contentDir;
  scanSchedule.entered = entered.release;
  scanSchedule.resume = resume.promise;
  const pending = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  let publicStat: ReturnType<typeof statSync> | undefined;
  try {
    await entered.promise;
    writeFileSync(b, 'newer,public,metadata\n');
    publicStat = statSync(b);
    watcher.mutateFileIndex({
      kind: 'file-update',
      path: b,
      relativePath: 'b.csv',
      size: publicStat.size,
      modifiedTs: publicStat.mtimeMs,
      inode: Number(publicStat.ino),
    });
  } finally {
    resume.release();
    await pending;
  }
  expect(publicStat).toBeDefined();
  expect(completed).toEqual(['complete']);
  expect(readFileSync(b, 'utf8')).toBe('newer,public,metadata\n');
  expect.soft(events).toContainEqual(expect.objectContaining({ kind: 'file-delete', path: a }));
  expect
    .soft(events.filter((event) => event.kind === 'file-delete' && event.path === b))
    .toEqual([]);
  expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
  expect.soft(indexedFileTargets(watcher)).toEqual(['b.csv', 'y-alias.csv']);
  expect.soft(indexedGeneralRows(watcher)[0]?.size).toBe(publicStat?.size);
  expect.soft(indexedFileTargets(watcher)).not.toContain('z-alias.csv');
});

test('a public symlink transfer during recovery keeps its dependent without protecting another member', async () => {
  const a = writeDoc('a.csv', 'old,shared\n');
  const b = join(contentDir, 'b.csv');
  const c = writeDoc('c.csv', 'new,target\n');
  const y = join(contentDir, 'y-alias.csv');
  const trigger = writeDoc('trigger.md', '# Trigger\n');
  linkSync(a, b);
  symlinkSync(b, y);
  const events: DiskEvent[] = [];
  const completed: string[] = [];
  let callbackCount = 0;
  let watcher: WatcherHandle | undefined;
  watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
      if (event.kind !== 'delete' || event.docName !== 'trigger') return;
      callbackCount++;
      unlinkSync(b);
      symlinkSync(c, b);
      const st = statSync(b);
      watcher?.mutateFileIndex({
        kind: 'file-update',
        path: b,
        relativePath: 'b.csv',
        size: st.size,
        modifiedTs: st.mtimeMs,
        inode: Number(st.ino),
      });
      expect(realpathSync(y)).toBe(c);
      const active = watcher;
      if (!active) throw new Error('watcher not ready');
      expect.soft(indexedAliasOwner(active, 'y-alias.csv')?.canonicalPath).toBe(c);
      expect.soft(indexedFileTargets(active)).toContain('y-alias.csv');
    },
    undefined,
    {
      forceBackend: 'parcel',
      platform: 'darwin',
      onRecoveryComplete: async () => {
        completed.push('complete');
      },
    },
  );
  handles.push(watcher);
  await deliver(contentDir, [{ type: 'update', path: b }]);
  expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
  expect(realpathSync(y)).toBe(b);
  events.length = 0;
  unlinkSync(a);
  unlinkSync(trigger);
  expect(existsSync(a)).toBe(false);
  expect(readFileSync(b, 'utf8')).toBe('old,shared\n');
  await deliverNotice(contentDir);
  expect(callbackCount).toBe(1);
  expect(completed).toEqual(['complete']);
  expect.soft(events).toContainEqual(expect.objectContaining({ kind: 'file-delete', path: a }));
  expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
  expect.soft(indexedGeneralRows(watcher)[0]?.canonicalPath).toBe(c);
  expect.soft(indexedFileTargets(watcher)).toEqual(['b.csv', 'c.csv', 'y-alias.csv']);
  expect.soft(indexedAliasOwner(watcher, 'y-alias.csv')?.canonicalPath).toBe(c);
  expect.soft(indexedFileTargets(watcher)).not.toContain('a.csv');
  await deliverNotice(contentDir);
  expect.soft(indexedAliasOwner(watcher, 'y-alias.csv')?.canonicalPath).toBe(c);
  expect.soft(indexedFileTargets(watcher)).toEqual(['b.csv', 'c.csv', 'y-alias.csv']);
  expect(readFileSync(c, 'utf8')).toBe('new,target\n');
});

test('a public update after synthesis retains an unrelated member replacement', async () => {
  const a = writeDoc('a.csv', 'old,shared\n');
  const b = join(contentDir, 'b.csv');
  const y = join(contentDir, 'y-alias.csv');
  const trigger = writeDoc('trigger.md', '# Trigger\n');
  linkSync(a, b);
  symlinkSync(b, y);
  const events: DiskEvent[] = [];
  const completed: string[] = [];
  let callbackCount = 0;
  let publicBModifiedTs: number | undefined;
  let watcher: WatcherHandle | undefined;
  watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
      if (event.kind !== 'delete' || event.docName !== 'trigger') return;
      callbackCount++;
      writeFileSync(b, 'newer,old,group\n');
      const st = statSync(b);
      publicBModifiedTs = st.mtimeMs;
      watcher?.mutateFileIndex({
        kind: 'file-update',
        path: b,
        relativePath: 'b.csv',
        size: st.size,
        modifiedTs: st.mtimeMs,
        inode: Number(st.ino),
      });
    },
    undefined,
    {
      forceBackend: 'parcel',
      platform: 'darwin',
      onRecoveryComplete: async () => {
        completed.push('complete');
      },
    },
  );
  handles.push(watcher);
  await deliver(contentDir, [{ type: 'update', path: b }]);
  events.length = 0;
  const temporary = writeDoc('replacement-temporary.csv', 'new,a,identity\n');
  renameSync(temporary, a);
  expect(statSync(a).ino).not.toBe(statSync(b).ino);
  unlinkSync(trigger);
  await deliverNotice(contentDir);
  expect(callbackCount).toBe(1);
  if (publicBModifiedTs === undefined) throw new Error('public b update was not observed');
  expect(completed).toEqual(['complete']);
  expect(readFileSync(a, 'utf8')).toBe('new,a,identity\n');
  expect(readFileSync(b, 'utf8')).toBe('newer,old,group\n');
  expect.soft(events).toContainEqual(expect.objectContaining({ kind: 'file-update', path: a }));
  expect.soft(indexedGeneralRows(watcher)).toHaveLength(2);
  expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv', 'b.csv', 'y-alias.csv']);
  expect.soft(indexedGeneralRows(watcher).find((row) => row.name === 'a.csv')).toMatchObject({
    canonicalPath: a,
    inode: Number(statSync(a).ino),
    size: statSync(a).size,
    modified: statSync(a).mtime.toISOString(),
  });
  expect.soft(indexedGeneralRows(watcher).find((row) => row.name === 'b.csv')).toMatchObject({
    canonicalPath: b,
    inode: Number(statSync(b).ino),
    size: statSync(b).size,
    modified: new Date(publicBModifiedTs).toISOString(),
  });
  expect.soft(indexedAliasOwner(watcher, 'y-alias.csv')?.canonicalPath).toBe(b);
  expect
    .soft(indexedGeneralRows(watcher).find((row) => row.name === 'b.csv')?.size)
    .toBe(statSync(b).size);
});

test('the latest public member tombstone survives an older scan without rolling back group metadata', async () => {
  const a = writeDoc('a.csv', 'old,shared\n');
  const b = join(contentDir, 'b.csv');
  const y = join(contentDir, 'y-alias.csv');
  const trigger = writeDoc('trigger.md', '# Trigger\n');
  linkSync(a, b);
  symlinkSync(b, y);
  const events: DiskEvent[] = [];
  let callbackCount = 0;
  let sharedPublicModifiedTs: number | undefined;
  let watcher: WatcherHandle | undefined;
  watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
      if (event.kind !== 'delete' || event.docName !== 'trigger') return;
      callbackCount++;
      writeFileSync(b, 'newer,shared,content\n');
      const sharedStat = statSync(b);
      sharedPublicModifiedTs = sharedStat.mtimeMs;
      watcher?.mutateFileIndex({
        kind: 'file-update',
        path: b,
        relativePath: 'b.csv',
        size: sharedStat.size,
        modifiedTs: sharedStat.mtimeMs,
        inode: Number(sharedStat.ino),
      });
      const temporary = writeDoc('replacement-temporary.csv', 'replacement\n');
      renameSync(temporary, b);
      const replacementStat = statSync(b);
      watcher?.mutateFileIndex({
        kind: 'file-update',
        path: b,
        relativePath: 'b.csv',
        size: replacementStat.size,
        modifiedTs: replacementStat.mtimeMs,
        inode: Number(replacementStat.ino),
      });
      unlinkSync(b);
      watcher?.mutateFileIndex({ kind: 'file-delete', path: b, relativePath: 'b.csv' });
    },
    undefined,
    { forceBackend: 'parcel', platform: 'darwin' },
  );
  handles.push(watcher);
  await deliver(contentDir, [{ type: 'update', path: b }]);
  events.length = 0;
  unlinkSync(trigger);
  await deliverNotice(contentDir);
  expect(callbackCount).toBe(1);
  if (sharedPublicModifiedTs === undefined)
    throw new Error('shared public update was not observed');
  expect(existsSync(b)).toBe(false);
  expect(readFileSync(a, 'utf8')).toBe('newer,shared,content\n');
  expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
  expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv']);
  expect.soft(indexedGeneralRows(watcher)[0]?.size).toBe(statSync(a).size);
  expect
    .soft(indexedGeneralRows(watcher)[0]?.modified)
    .toBe(new Date(sharedPublicModifiedTs).toISOString());
  expect.soft(indexedFileTargets(watcher)).not.toContain('y-alias.csv');
  expect(lastKnownHash.has(a)).toBe(false);
  expect(lastKnownHash.has(b)).toBe(false);
});

test('index-only reseed merges an observed sibling with a newer public hardlink update', async () => {
  const a = writeDoc('a.csv', 'old,shared\n');
  const b = join(contentDir, 'b.csv');
  linkSync(a, b);
  const { watcher, events } = await watchContent();
  await deliver(contentDir, [{ type: 'update', path: b }]);
  events.length = 0;
  const c = join(contentDir, 'c.csv');
  linkSync(a, c);
  const entered = deferred();
  const resume = deferred();
  memberStatSchedule.path = b;
  memberStatSchedule.entered = entered.release;
  memberStatSchedule.resume = resume.promise;
  const pending = watcher.rescanFromDisk();
  let publicStat: ReturnType<typeof statSync> | undefined;
  try {
    await entered.promise;
    writeFileSync(b, 'newer,public,shared\n');
    publicStat = statSync(b);
    watcher.mutateFileIndex({
      kind: 'file-update',
      path: b,
      relativePath: 'b.csv',
      size: publicStat.size,
      modifiedTs: publicStat.mtimeMs,
      inode: Number(publicStat.ino),
    });
  } finally {
    resume.release();
    await pending;
  }
  expect(publicStat).toBeDefined();
  expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(c).dev, statSync(c).ino]);
  expect(readFileSync(a, 'utf8')).toBe('newer,public,shared\n');
  expect(readFileSync(c, 'utf8')).toBe('newer,public,shared\n');
  expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
  expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv', 'b.csv', 'c.csv']);
  expect.soft(indexedGeneralRows(watcher)[0]?.size).toBe(publicStat?.size);
  expect(events).toEqual([]);
  expect(lastKnownHash.has(a)).toBe(false);
  expect(lastKnownHash.has(b)).toBe(false);
});

test.each(['known-member', 'new-member'] as const)(
  'a public $0 registration remains nonthrowing when physical enrichment is denied',
  async (input) => {
    const a = writeDoc('a.csv', 'public,shared\n');
    const b = join(contentDir, 'b.csv');
    if (input === 'known-member') linkSync(a, b);
    const { watcher } = await watchContent();
    if (input === 'known-member') {
      await deliver(contentDir, [{ type: 'update', path: b }]);
    } else {
      linkSync(a, b);
    }
    const y = join(contentDir, 'y-alias.csv');
    symlinkSync(b, y);
    if (input === 'known-member') await deliver(contentDir, [{ type: 'create', path: y }]);
    let expectedBytes = 'public,shared\n';
    let priorIndexedSize: number | undefined;
    if (input === 'known-member') {
      priorIndexedSize = indexedAliasOwner(watcher, 'y-alias.csv')?.size;
      expect(priorIndexedSize).toBeDefined();
      expectedBytes = 'public,updated,member,metadata\n';
      writeFileSync(b, expectedBytes);
    }
    const st = statSync(b);
    if (input === 'known-member') expect(st.size).not.toBe(priorIndexedSize);
    denyAdmission('lstat', b);
    expect(() =>
      watcher.mutateFileIndex({
        kind: input === 'known-member' ? 'file-update' : 'file-create',
        path: b,
        relativePath: 'b.csv',
        size: st.size,
        modifiedTs: st.mtimeMs,
        inode: Number(st.ino),
      }),
    ).not.toThrow();
    expect.soft(admissionFault.observed).toBe(true);
    expect.soft(indexedFileTargets(watcher)).toContain('a.csv');
    expect.soft(indexedFileTargets(watcher)).toContain('b.csv');
    if (input === 'known-member') {
      expect.soft(indexedFileTargets(watcher)).toContain('y-alias.csv');
      expect.soft(indexedAliasOwner(watcher, 'y-alias.csv')?.size).toBe(st.size);
      expect
        .soft(indexedAliasOwner(watcher, 'y-alias.csv')?.modified)
        .toBe(new Date(st.mtimeMs).toISOString());
      expect.soft(indexedAliasOwner(watcher, 'y-alias.csv')?.aliases).toContain('y-alias.csv');
    }
    expect(readFileSync(a, 'utf8')).toBe(expectedBytes);
    expect(readFileSync(b, 'utf8')).toBe(expectedBytes);
    clearAdmissionDenial();
    await deliverNotice(contentDir);
    expect.soft(indexedGeneralRows(watcher)).toHaveLength(1);
    expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv', 'b.csv', 'y-alias.csv']);
  },
);

test('a stale public file-create still registers without a new read failure and then reconciles', async () => {
  const a = writeDoc('a.csv', 'present\n');
  const { watcher } = await watchContent();
  const stale = writeDoc('stale.csv', 'gone\n');
  const st = statSync(stale);
  unlinkSync(stale);
  expect(existsSync(stale)).toBe(false);
  expect(() =>
    watcher.mutateFileIndex({
      kind: 'file-create',
      path: stale,
      relativePath: 'stale.csv',
      size: st.size,
      modifiedTs: st.mtimeMs,
      inode: Number(st.ino),
    }),
  ).not.toThrow();
  expect.soft(indexedFileTargets(watcher)).toContain('stale.csv');
  await deliverNotice(contentDir);
  expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv']);
  expect(readFileSync(a, 'utf8')).toBe('present\n');
});

test('legacy mixed-Map helpers expose general mutation before their public callback', async () => {
  const file = writeDoc('legacy.csv', 'first\n');
  const index = new Map<string, import('./file-watcher.ts').FileIndexEntry>();
  const folders = new Map<string, import('./file-watcher.ts').FolderIndexEntry>();
  const observed: Array<{ kind: string; present: boolean; size?: number }> = [];
  const dispatch = async (type: 'create' | 'update' | 'delete') =>
    handleRawEvents(
      [{ type, path: file }],
      contentDir,
      undefined,
      index,
      folders,
      async (event) => {
        observed.push({
          kind: event.kind,
          present: index.has('legacy.csv'),
          size: index.get('legacy.csv')?.size,
        });
      },
    );
  await dispatch('create');
  expect(observed.at(-1)).toMatchObject({ kind: 'file-create', present: true, size: 6 });
  writeFileSync(file, 'second,longer\n');
  await dispatch('update');
  expect(observed.at(-1)).toMatchObject({
    kind: 'file-update',
    present: true,
    size: Buffer.byteLength('second,longer\n'),
  });
  unlinkSync(file);
  await dispatch('delete');
  expect(observed.at(-1)).toMatchObject({ kind: 'file-delete', present: false });
  updateFileIndex(
    {
      kind: 'file-create',
      path: file,
      relativePath: 'legacy.csv',
      size: 3,
      modifiedTs: 0,
      inode: 7,
    },
    index,
  );
  expect(index.get('legacy.csv')).toMatchObject({ kind: 'file', size: 3, inode: 7 });
  updateFileIndex({ kind: 'file-delete', path: file, relativePath: 'legacy.csv' }, index);
  expect(index.has('legacy.csv')).toBe(false);
});

test.each([
  ['symlink-to-regular', 'ordinary'],
  ['symlink-to-regular', 'notice'],
  ['regular-to-symlink', 'ordinary'],
  ['regular-to-symlink', 'notice'],
] as const)(
  'a surviving general pathname changes from %s after %s delivery without a deletion',
  async (transition, delivery) => {
    const a = writeDoc('a.csv', 'same,physical,bytes\n');
    const y = join(contentDir, 'y.csv');
    if (transition === 'symlink-to-regular') symlinkSync(a, y);
    else linkSync(a, y);
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries = ['a.csv', 'y.csv'];
    const { watcher, events } = await watchContent();
    expect(indexedFileTargets(watcher)).toEqual(['a.csv', 'y.csv']);
    expect(lstatSync(y).isSymbolicLink()).toBe(transition === 'symlink-to-regular');
    expect(readFileSync(y, 'utf8')).toBe('same,physical,bytes\n');
    unlinkSync(y);
    if (transition === 'symlink-to-regular') linkSync(a, y);
    else symlinkSync(a, y);
    expect(existsSync(y)).toBe(true);
    expect(lstatSync(y).isSymbolicLink()).toBe(transition === 'regular-to-symlink');
    expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(y).dev, statSync(y).ino]);
    expect(readFileSync(y, 'utf8')).toBe('same,physical,bytes\n');

    if (delivery === 'ordinary') await deliver(contentDir, [{ type: 'update', path: y }]);
    else await deliverNotice(contentDir);

    expect(
      events.some((event) => event.kind === 'file-create' || event.kind === 'file-update'),
    ).toBe(true);
    expect
      .soft(
        events.filter(
          (event) =>
            (event.kind === 'file-delete' || event.kind === 'asset-delete') && event.path === y,
        ),
      )
      .toEqual([]);
    expect
      .soft(events)
      .toContainEqual(
        expect.objectContaining({ kind: 'file-update', path: y, relativePath: 'y.csv' }),
      );
    expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv', 'y.csv']);
    events.length = 0;
    await deliverNotice(contentDir);
    expect.soft(events).toEqual([]);
    expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv', 'y.csv']);
    expect(readFileSync(y, 'utf8')).toBe('same,physical,bytes\n');
  },
);

test('a public recreation during the first alias deletion cancels the pending second alias deletion', async () => {
  const a = writeDoc('a.csv', 'same,alias,target\n');
  const x = join(contentDir, 'x.csv');
  const y = join(contentDir, 'y.csv');
  symlinkSync(a, x);
  symlinkSync(a, y);
  scanSchedule.orderedPath = contentDir;
  scanSchedule.orderedEntries = ['a.csv', 'x.csv', 'y.csv'];
  const entered = deferred();
  const resume = deferred();
  const { watcher, events } = await watchContent(undefined, async (event) => {
    if (event.kind !== 'file-delete' || event.path !== x) return;
    entered.release();
    await resume.promise;
  });
  expect(indexedFileTargets(watcher)).toEqual(['a.csv', 'x.csv', 'y.csv']);
  expect(lstatSync(x).isSymbolicLink()).toBe(true);
  expect(lstatSync(y).isSymbolicLink()).toBe(true);
  unlinkSync(x);
  unlinkSync(y);
  expect(existsSync(x)).toBe(false);
  expect(existsSync(y)).toBe(false);
  const pending = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  try {
    await entered.promise;
    symlinkSync(a, y);
    const stat = statSync(y);
    watcher.mutateFileIndex({
      kind: 'file-create',
      path: y,
      relativePath: 'y.csv',
      size: stat.size,
      modifiedTs: stat.mtimeMs,
      inode: Number(stat.ino),
    });
    expect(lstatSync(y).isSymbolicLink()).toBe(true);
    expect(realpathSync(y)).toBe(a);
    expect(indexedFileTargets(watcher)).toEqual(['a.csv', 'y.csv']);
  } finally {
    resume.release();
    await pending;
  }
  await vi.runAllTimersAsync();
  expect(events).toContainEqual({ kind: 'file-delete', path: x, relativePath: 'x.csv' });
  expect
    .soft(
      events.filter(
        (event) =>
          (event.kind === 'file-delete' || event.kind === 'asset-delete') && event.path === y,
      ),
    )
    .toEqual([]);
  expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv', 'y.csv']);
  expect(readFileSync(y, 'utf8')).toBe('same,alias,target\n');
  events.length = 0;
  await deliverNotice(contentDir);
  expect
    .soft(
      events.filter(
        (event) =>
          'path' in event &&
          (event.path === x ||
            event.path === y ||
            ((event.kind === 'file-delete' || event.kind === 'asset-delete') && event.path === a)),
      ),
    )
    .toEqual([]);
  expect.soft(indexedFileTargets(watcher)).toEqual(['a.csv', 'y.csv']);
});

test('removing a second retargeted alias during the first alias callback cancels its pending target update', async () => {
  const a = writeDoc('a.csv', 'first,target\n');
  const b = writeDoc('b.csv', 'second,target\n');
  const x = join(contentDir, 'x.csv');
  const y = join(contentDir, 'y.csv');
  symlinkSync(a, x);
  symlinkSync(b, y);
  scanSchedule.orderedPath = contentDir;
  scanSchedule.orderedEntries = ['a.csv', 'b.csv', 'x.csv', 'y.csv'];
  const entered = deferred();
  const resume = deferred();
  let firstTarget: string | undefined;
  let pendingTarget: string | undefined;
  let pendingAlias: string | undefined;
  let pendingAlreadyEmitted = false;
  const { watcher, events } = await watchContent(undefined, async (event) => {
    if (event.kind !== 'file-update' || (event.path !== a && event.path !== b)) return;
    if (firstTarget !== undefined) return;
    firstTarget = event.path;
    pendingTarget = event.path === a ? b : a;
    pendingAlias = event.path === a ? x : y;
    pendingAlreadyEmitted = events.some(
      (emitted) => emitted.kind === 'file-update' && emitted.path === pendingTarget,
    );
    entered.release();
    await resume.promise;
  });
  expect(indexedFileTargets(watcher)).toEqual(['a.csv', 'b.csv', 'x.csv', 'y.csv']);
  expect(realpathSync(x)).toBe(a);
  expect(realpathSync(y)).toBe(b);
  unlinkSync(x);
  unlinkSync(y);
  symlinkSync(b, x);
  symlinkSync(a, y);
  expect(realpathSync(x)).toBe(b);
  expect(realpathSync(y)).toBe(a);
  const pending = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  try {
    await entered.promise;
    const aliasToRemove = pendingAlias;
    const targetStillPending = pendingTarget;
    if (aliasToRemove === undefined || targetStillPending === undefined) {
      throw new Error('first target update did not identify a pending alias');
    }
    expect(pendingAlreadyEmitted).toBe(false);
    expect(
      events.filter((event) => event.kind === 'file-update' && event.path === targetStillPending),
    ).toEqual([]);
    unlinkSync(aliasToRemove);
    watcher.mutateFileIndex({
      kind: 'file-delete',
      path: aliasToRemove,
      relativePath: basename(aliasToRemove),
    });
    expect(existsSync(aliasToRemove)).toBe(false);
    expect(indexedFileTargets(watcher)).toEqual(
      ['a.csv', 'b.csv', basename(aliasToRemove === x ? y : x)].toSorted(),
    );
  } finally {
    resume.release();
    await pending;
  }
  await vi.runAllTimersAsync();
  const emittedFirst = firstTarget;
  const targetStillPending = pendingTarget;
  const removedAlias = pendingAlias;
  if (
    emittedFirst === undefined ||
    targetStillPending === undefined ||
    removedAlias === undefined
  ) {
    throw new Error('alias notification ordering was not observed');
  }
  expect(events).toContainEqual(
    expect.objectContaining({ kind: 'file-update', path: emittedFirst }),
  );
  expect
    .soft(
      events.filter((event) => event.kind === 'file-update' && event.path === targetStillPending),
    )
    .toEqual([]);
  const expectedTargets = ['a.csv', 'b.csv', basename(removedAlias === x ? y : x)].toSorted();
  expect.soft(indexedFileTargets(watcher)).toEqual(expectedTargets);
  events.length = 0;
  await deliverNotice(contentDir);
  expect.soft(events).toEqual([]);
  expect.soft(indexedFileTargets(watcher)).toEqual(expectedTargets);
});

test('a completed within-branch notice remains exact after its buffered target events drain', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: contentDir, env: gitEnv, encoding: 'utf8' }).trim();
  git(['init', '--quiet', '--initial-branch=main']);
  configureTestGitRepository(contentDir);
  git(['config', 'user.email', 'notice-test@example.com']);
  git(['config', 'user.name', 'Notice Test']);
  const a = writeDoc('a.csv', 'same,physical,bytes\n');
  const y = join(contentDir, 'y.csv');
  symlinkSync(a, y);
  writeDoc('source.md', '# Source\n\n[File](y.csv)\n');
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'initial files']);
  const batchBegun = deferred();
  const batchHold = deferred();
  const batchEnded = deferred();
  headBatchSchedule.begun = batchBegun.release;
  headBatchSchedule.hold = batchHold.promise;
  headBatchSchedule.ended = batchEnded.release;
  headBatchSchedule.armed = true;
  const server = await bootCompositionRig(contentDir);
  try {
    await server.ready;
    expect(await inventoryForwardStatuses(server.port)).toMatchObject({ 'y.csv': 'exact' });
    expect(server.serverInstance.durabilityState.isBatchInProgress()).toBe(false);
    expect(headBatchSchedule.begins).toEqual([]);
    await nativeSubscriptionOn(join(contentDir, '.git')).deliver([], new Error(notices[0]));
    await batchBegun.promise;
    expect(headBatchSchedule.begins).toEqual([{ trigger: 'rescan' }]);
    expect(server.serverInstance.durabilityState.isBatchInProgress()).toBe(true);
    unlinkSync(y);
    linkSync(a, y);
    expect(lstatSync(y).isFile()).toBe(true);
    expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(y).dev, statSync(y).ino]);
    await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    expect(server.serverInstance.durabilityState.isBatchInProgress()).toBe(true);
    expect(await inventoryForwardStatuses(server.port)).toMatchObject({ 'y.csv': 'exact' });
    expect(headBatchSchedule.ends).toEqual([]);
    batchHold.release();
    await batchEnded.promise;
    expect(headBatchSchedule.ends).toEqual([
      expect.objectContaining({ batchKind: 'within-branch', headMoved: false, timeout: false }),
    ]);
    expect(server.serverInstance.durabilityState.isBatchInProgress()).toBe(false);
    const asset = await fetch(`http://127.0.0.1:${server.port}/api/asset-text?path=y.csv`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('same,physical,bytes\n');
    expect.soft(await inventoryForwardStatuses(server.port)).toMatchObject({ 'y.csv': 'exact' });
    expect(readFileSync(y, 'utf8')).toBe('same,physical,bytes\n');
  } finally {
    batchHold.release();
    vi.useRealTimers();
    await server.destroy();
  }
});

test.each(['notice recovery', 'index-only rescan', 'idle reconcile'] as const)(
  'an ignore rebuild keeps excluded targets absent after $0',
  async (surface) => {
    const b = writeDoc('b.csv', 'b,kept,on,disk\n');
    const note = writeDoc('note.md', '# Kept on disk\n');
    const latch = writeDoc('z-latch.csv', 'z,admitted\n');
    const ignore = writeDoc('.okignore', '');
    const filter = createContentFilter({ projectDir: contentDir, contentDir });
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries = ['b.csv', 'note.md', 'z-latch.csv'];
    const events: DiskEvent[] = [];
    let afterObservation: { documentTargets: string[]; fileTargets: string[] } | undefined;
    let watcher: WatcherHandle;
    const inventory = () => {
      const current = localTargetInventoryFromWatcher(watcher, contentDir);
      if (!current) throw new Error('watcher inventory unavailable');
      return {
        documentTargets: [...current.documentTargets].toSorted(),
        fileTargets: [...current.fileTargets].toSorted(),
      };
    };
    watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      filter,
      {
        forceBackend: 'parcel',
        platform: 'darwin',
        onRecoveryComplete: async () => {
          afterObservation = inventory();
        },
      },
    );
    handles.push(watcher);
    expect(inventory()).toEqual({
      documentTargets: ['note'],
      fileTargets: ['.okignore', 'b.csv', 'z-latch.csv'],
    });

    const entered = deferred();
    const resume = deferred();
    let pending: Promise<void> | undefined;
    let reconcile: ReturnType<typeof reconcileFileIndexAfterFilterRebuild> | undefined;
    let reconciled: Awaited<ReturnType<typeof reconcileFileIndexAfterFilterRebuild>> | undefined;
    let afterPrune: { documentTargets: string[]; fileTargets: string[] } | undefined;
    try {
      if (surface !== 'idle reconcile') {
        memberStatSchedule.seen = [];
        memberStatSchedule.path = latch;
        memberStatSchedule.entered = entered.release;
        memberStatSchedule.resume = resume.promise;
        pending =
          surface === 'notice recovery'
            ? nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]))
            : watcher.rescanFromDisk().then(() => {
                afterObservation = inventory();
              });
        await entered.promise;
        expect(
          memberStatSchedule.seen.filter((path) => path === b || path === note || path === latch),
        ).toEqual([b, note, latch]);
        expect(inventory()).toEqual({
          documentTargets: ['note'],
          fileTargets: ['.okignore', 'b.csv', 'z-latch.csv'],
        });
      }

      writeFileSync(ignore, 'b.csv\nnote.md\n');
      expect((await filter.rebuildIgnorePatterns()).ok).toBe(true);
      expect(filter.isPathIgnored('b.csv')).toBe(true);
      expect(filter.isExcluded('note.md')).toBe(true);
      expect(filter.isPathIgnored('z-latch.csv')).toBe(false);
      reconcile = reconcileFileIndexAfterFilterRebuild(watcher);
      afterPrune = inventory();
      expect(afterPrune).toEqual({
        documentTargets: [],
        fileTargets: ['.okignore', 'z-latch.csv'],
      });
    } finally {
      resume.release();
      if (pending) await pending;
      if (reconcile) reconciled = await reconcile;
    }

    expect(reconciled).toEqual({ prunedFiles: 2, prunedFolders: 0 });
    expect(afterPrune).toEqual({
      documentTargets: [],
      fileTargets: ['.okignore', 'z-latch.csv'],
    });
    if (surface !== 'idle reconcile') {
      expect.soft(afterObservation).toEqual({
        documentTargets: [],
        fileTargets: ['.okignore', 'z-latch.csv'],
      });
    }
    expect.soft(inventory()).toEqual({
      documentTargets: [],
      fileTargets: ['.okignore', 'z-latch.csv'],
    });
    expect
      .soft(events.filter((event) => 'path' in event && (event.path === b || event.path === note)))
      .toEqual([]);
    if (surface === 'notice recovery') {
      expect(events).toContainEqual(expect.objectContaining({ kind: 'file-update', path: ignore }));
    } else {
      expect(events).toEqual([]);
    }
    expect(readFileSync(b, 'utf8')).toBe('b,kept,on,disk\n');
    expect(readFileSync(note, 'utf8')).toBe('# Kept on disk\n');
    expect(readFileSync(latch, 'utf8')).toBe('z,admitted\n');
  },
);

function sortedTargetInventory(watcher: WatcherHandle) {
  const current = localTargetInventoryFromWatcher(watcher, contentDir);
  if (!current) throw new Error('watcher inventory unavailable');
  return {
    documentTargets: [...current.documentTargets].toSorted(),
    fileTargets: [...current.fileTargets].toSorted(),
    folderTargets: [...current.folderTargets].toSorted(),
  };
}

test.each(['notice recovery', 'index-only rescan'] as const)(
  '%s does not publish newly captured files excluded before publication',
  async (surface) => {
    const latch = writeDoc('z-latch.csv', 'z,admitted\n');
    const ignore = writeDoc('.okignore', '');
    const filter = createContentFilter({ projectDir: contentDir, contentDir });
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries = ['b.csv', 'note.md', 'z-latch.csv'];
    const events: DiskEvent[] = [];
    let afterObservation: ReturnType<typeof sortedTargetInventory> | undefined;
    let watcher: WatcherHandle;
    watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      filter,
      {
        forceBackend: 'parcel',
        platform: 'darwin',
        onRecoveryComplete: async () => {
          afterObservation = sortedTargetInventory(watcher);
        },
      },
    );
    handles.push(watcher);
    const initial = {
      documentTargets: [],
      fileTargets: ['.okignore', 'z-latch.csv'],
      folderTargets: [],
    };
    expect(sortedTargetInventory(watcher)).toEqual(initial);

    const b = writeDoc('b.csv', 'b,new,on,disk\n');
    const note = writeDoc('note.md', '# New on disk\n');
    expect(sortedTargetInventory(watcher)).toEqual(initial);
    const entered = deferred();
    const resume = deferred();
    memberStatSchedule.seen = [];
    memberStatSchedule.path = latch;
    memberStatSchedule.entered = entered.release;
    memberStatSchedule.resume = resume.promise;
    const pending =
      surface === 'notice recovery'
        ? nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]))
        : watcher.rescanFromDisk().then(() => {
            afterObservation = sortedTargetInventory(watcher);
          });
    let reconcile: ReturnType<typeof reconcileFileIndexAfterFilterRebuild> | undefined;
    let reconciled: Awaited<ReturnType<typeof reconcileFileIndexAfterFilterRebuild>> | undefined;
    let afterPrune: ReturnType<typeof sortedTargetInventory> | undefined;
    try {
      await entered.promise;
      expect(
        memberStatSchedule.seen.filter((path) => path === b || path === note || path === latch),
      ).toEqual([b, note, latch]);
      expect(sortedTargetInventory(watcher)).toEqual(initial);
      writeFileSync(ignore, 'b.csv\nnote.md\n');
      expect((await filter.rebuildIgnorePatterns()).ok).toBe(true);
      expect(filter.isPathIgnored('b.csv')).toBe(true);
      expect(filter.isExcluded('note.md')).toBe(true);
      expect(filter.isPathIgnored('z-latch.csv')).toBe(false);
      reconcile = reconcileFileIndexAfterFilterRebuild(watcher);
      afterPrune = sortedTargetInventory(watcher);
      expect(afterPrune).toEqual(initial);
    } finally {
      resume.release();
      await pending;
      if (reconcile) reconciled = await reconcile;
    }
    expect(reconciled).toEqual({ prunedFiles: 0, prunedFolders: 0 });
    expect(afterPrune).toEqual(initial);
    expect.soft(afterObservation).toEqual(initial);
    expect.soft(sortedTargetInventory(watcher)).toEqual(initial);
    expect
      .soft(events.filter((event) => 'path' in event && (event.path === b || event.path === note)))
      .toEqual([]);
    expect(readFileSync(b, 'utf8')).toBe('b,new,on,disk\n');
    expect(readFileSync(note, 'utf8')).toBe('# New on disk\n');
    expect(readFileSync(latch, 'utf8')).toBe('z,admitted\n');
  },
);

test.each(['notice recovery', 'index-only rescan'] as const)(
  '%s keeps a newly excluded empty folder and file alias out of public inventory',
  async (surface) => {
    const target = writeDoc('a.csv', 'a,survives\n');
    const folder = join(contentDir, 'empty-folder');
    mkdirSync(folder);
    const alias = join(contentDir, 'y-alias.csv');
    symlinkSync(target, alias);
    const latch = writeDoc('z-latch.csv', 'z,survives\n');
    const ignore = writeDoc('.okignore', '');
    const filter = createContentFilter({ projectDir: contentDir, contentDir });
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries = ['a.csv', 'empty-folder', 'y-alias.csv', 'z-latch.csv'];
    const events: DiskEvent[] = [];
    let afterObservation: ReturnType<typeof sortedTargetInventory> | undefined;
    let watcher: WatcherHandle;
    watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      filter,
      {
        forceBackend: 'parcel',
        platform: 'darwin',
        onRecoveryComplete: async () => {
          afterObservation = sortedTargetInventory(watcher);
        },
      },
    );
    handles.push(watcher);
    expect(watcher.getFolderIndex().has('empty-folder')).toBe(true);
    expect(sortedTargetInventory(watcher)).toEqual({
      documentTargets: [],
      fileTargets: ['.okignore', 'a.csv', 'y-alias.csv', 'z-latch.csv'],
      folderTargets: ['empty-folder'],
    });
    const entered = deferred();
    const resume = deferred();
    memberStatSchedule.seen = [];
    memberStatSchedule.path = latch;
    memberStatSchedule.entered = entered.release;
    memberStatSchedule.resume = resume.promise;
    const pending =
      surface === 'notice recovery'
        ? nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]))
        : watcher.rescanFromDisk().then(() => {
            afterObservation = sortedTargetInventory(watcher);
          });
    let reconcile: ReturnType<typeof reconcileFileIndexAfterFilterRebuild> | undefined;
    let reconciled: Awaited<ReturnType<typeof reconcileFileIndexAfterFilterRebuild>> | undefined;
    let afterPrune: ReturnType<typeof sortedTargetInventory> | undefined;
    const excluded = {
      documentTargets: [],
      fileTargets: ['.okignore', 'a.csv', 'z-latch.csv'],
      folderTargets: [],
    };
    try {
      await entered.promise;
      expect(
        memberStatSchedule.seen.filter(
          (path) => path === target || path === folder || path === alias || path === latch,
        ),
      ).toEqual([target, folder, alias, latch]);
      writeFileSync(ignore, 'empty-folder/\ny-alias.csv\n');
      expect((await filter.rebuildIgnorePatterns()).ok).toBe(true);
      expect(filter.isDirExcluded('empty-folder')).toBe(true);
      expect(filter.isPathIgnored('y-alias.csv')).toBe(true);
      expect(filter.isPathIgnored('a.csv')).toBe(false);
      reconcile = reconcileFileIndexAfterFilterRebuild(watcher);
      afterPrune = sortedTargetInventory(watcher);
      expect(watcher.getFolderIndex().has('empty-folder')).toBe(false);
      expect(afterPrune).toEqual(excluded);
    } finally {
      resume.release();
      await pending;
      if (reconcile) reconciled = await reconcile;
    }
    expect(reconciled).toEqual({ prunedFiles: 0, prunedFolders: 1 });
    expect(afterPrune).toEqual(excluded);
    expect.soft(afterObservation).toEqual(excluded);
    expect.soft(sortedTargetInventory(watcher)).toEqual(excluded);
    expect.soft(watcher.getFolderIndex().has('empty-folder')).toBe(false);
    expect
      .soft(
        events.filter(
          (event) =>
            ['file-delete', 'asset-delete', 'folder-delete', 'delete'].includes(event.kind) &&
            'path' in event &&
            (event.path === alias || event.path === folder),
        ),
      )
      .toEqual([]);
    expect(lstatSync(folder).isDirectory()).toBe(true);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(realpathSync(alias)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('a,survives\n');
    expect(readFileSync(latch, 'utf8')).toBe('z,survives\n');
  },
);

test('a recovered callback cannot restore entries pruned after observation completed', async () => {
  const b = writeDoc('b.csv', 'b,unchanged\n');
  const note = writeDoc('note.md', '# Unchanged\n');
  const trigger = writeDoc('trigger.md', '# Before\n');
  const latch = writeDoc('z-latch.csv', 'z,unchanged\n');
  const ignore = writeDoc('.okignore', '');
  const filter = createContentFilter({ projectDir: contentDir, contentDir });
  scanSchedule.orderedPath = contentDir;
  scanSchedule.orderedEntries = ['b.csv', 'note.md', 'trigger.md', 'z-latch.csv'];
  const events: DiskEvent[] = [];
  let watcher: WatcherHandle;
  let afterObservation: ReturnType<typeof sortedTargetInventory> | undefined;
  let afterPrune: ReturnType<typeof sortedTargetInventory> | undefined;
  let rebuildSucceeded = false;
  let callbackCount = 0;
  let reconcile: ReturnType<typeof reconcileFileIndexAfterFilterRebuild> | undefined;
  watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
      if (event.kind !== 'update' || event.docName !== 'trigger') return;
      callbackCount++;
      writeFileSync(ignore, 'b.csv\nnote.md\n');
      rebuildSucceeded = (await filter.rebuildIgnorePatterns()).ok;
      reconcile = reconcileFileIndexAfterFilterRebuild(watcher);
      afterPrune = sortedTargetInventory(watcher);
    },
    filter,
    {
      forceBackend: 'parcel',
      platform: 'darwin',
      onRecoveryComplete: async () => {
        afterObservation = sortedTargetInventory(watcher);
      },
    },
  );
  handles.push(watcher);
  expect(sortedTargetInventory(watcher)).toEqual({
    documentTargets: ['note', 'trigger'],
    fileTargets: ['.okignore', 'b.csv', 'z-latch.csv'],
    folderTargets: [],
  });
  writeFileSync(trigger, '# After\n');
  const entered = deferred();
  const resume = deferred();
  memberStatSchedule.seen = [];
  memberStatSchedule.path = latch;
  memberStatSchedule.entered = entered.release;
  memberStatSchedule.resume = resume.promise;
  const pending = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  try {
    await entered.promise;
    expect(
      memberStatSchedule.seen.filter(
        (path) => path === b || path === note || path === trigger || path === latch,
      ),
    ).toEqual([b, note, trigger, latch]);
  } finally {
    resume.release();
    await pending;
  }
  const reconciled = await reconcile;
  expect(callbackCount).toBe(1);
  expect(rebuildSucceeded).toBe(true);
  expect(filter.isPathIgnored('b.csv')).toBe(true);
  expect(filter.isExcluded('note.md')).toBe(true);
  expect(filter.isPathIgnored('z-latch.csv')).toBe(false);
  const excluded = {
    documentTargets: ['trigger'],
    fileTargets: ['.okignore', 'z-latch.csv'],
    folderTargets: [],
  };
  expect(reconciled).toEqual({ prunedFiles: 2, prunedFolders: 0 });
  expect(afterPrune).toEqual(excluded);
  expect.soft(afterObservation).toEqual(excluded);
  expect.soft(sortedTargetInventory(watcher)).toEqual(excluded);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: 'update',
      path: trigger,
      docName: 'trigger',
      content: '# After\n',
    }),
  );
  expect
    .soft(events.filter((event) => 'path' in event && (event.path === b || event.path === note)))
    .toEqual([]);
  expect(readFileSync(b, 'utf8')).toBe('b,unchanged\n');
  expect(readFileSync(note, 'utf8')).toBe('# Unchanged\n');
  expect(readFileSync(latch, 'utf8')).toBe('z,unchanged\n');
});

test.each(['folder alias', 'ordinary folder'] as const)(
  'idle reconcile removes an excluded %s from cached public inventory',
  async (excludedKind) => {
    const canonical = join(contentDir, 'canonical-folder');
    const ordinary = join(contentDir, 'ordinary-folder');
    mkdirSync(canonical);
    mkdirSync(ordinary);
    const alias = join(contentDir, 'linked-folder');
    symlinkSync(canonical, alias);
    const ignore = writeDoc('.okignore', '');
    const filter = createContentFilter({ projectDir: contentDir, contentDir });
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries = ['canonical-folder', 'linked-folder', 'ordinary-folder'];
    const { watcher, events } = await watchContent(filter);
    expect(watcher.getFolderIndex().has('canonical-folder')).toBe(true);
    expect(watcher.getFolderIndex().has('ordinary-folder')).toBe(true);
    expect(watcher.getFolderAliasIndex().get('linked-folder')).toBe('canonical-folder');
    const initial = sortedTargetInventory(watcher);
    expect(initial).toEqual({
      documentTargets: [],
      fileTargets: ['.okignore'],
      folderTargets: ['canonical-folder', 'linked-folder', 'ordinary-folder'],
    });

    const excludedName = excludedKind === 'folder alias' ? 'linked-folder' : 'ordinary-folder';
    const retainedName = excludedKind === 'folder alias' ? 'ordinary-folder' : 'linked-folder';
    const expectedAlias = excludedKind !== 'folder alias';
    const expectedOrdinary = excludedKind !== 'ordinary folder';
    const expectedFolders = ['canonical-folder', retainedName].toSorted();
    const generationBefore = watcher.getFileIndexGeneration();
    writeFileSync(ignore, `${excludedName}/\n`);
    expect((await filter.rebuildIgnorePatterns()).ok).toBe(true);
    expect(filter.isDirExcluded(excludedName)).toBe(true);
    expect(filter.isDirExcluded(retainedName)).toBe(false);
    expect(filter.isDirExcluded('canonical-folder')).toBe(false);

    const pending = reconcileFileIndexAfterFilterRebuild(watcher);
    const immediateGeneration = watcher.getFileIndexGeneration();
    const immediateAlias = watcher.getFolderAliasIndex().has('linked-folder');
    const immediateOrdinary = watcher.getFolderIndex().has('ordinary-folder');
    const immediateCanonical = watcher.getFolderIndex().has('canonical-folder');
    const immediateInventory = sortedTargetInventory(watcher);
    const reconciled = await pending;

    expect(reconciled).toEqual({
      prunedFiles: 0,
      prunedFolders: excludedKind === 'ordinary folder' ? 1 : 0,
    });
    expect.soft(immediateAlias).toBe(expectedAlias);
    expect.soft(immediateOrdinary).toBe(expectedOrdinary);
    expect.soft(immediateCanonical).toBe(true);
    expect.soft(immediateInventory).toEqual({
      documentTargets: [],
      fileTargets: ['.okignore'],
      folderTargets: expectedFolders,
    });
    expect.soft(immediateGeneration).toBeGreaterThan(generationBefore);
    expect.soft(watcher.getFolderAliasIndex().has('linked-folder')).toBe(expectedAlias);
    expect.soft(watcher.getFolderIndex().has('ordinary-folder')).toBe(expectedOrdinary);
    expect.soft(watcher.getFolderIndex().has('canonical-folder')).toBe(true);
    expect.soft(sortedTargetInventory(watcher)).toEqual({
      documentTargets: [],
      fileTargets: ['.okignore'],
      folderTargets: expectedFolders,
    });
    expect(events).toEqual([]);
    expect(lstatSync(canonical).isDirectory()).toBe(true);
    expect(lstatSync(ordinary).isDirectory()).toBe(true);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(realpathSync(alias)).toBe(canonical);
  },
);

test.each(['notice recovery', 'index-only rescan'] as const)(
  '%s does not publish a newly captured excluded folder alias',
  async (surface) => {
    const canonical = join(contentDir, 'canonical-folder');
    mkdirSync(canonical);
    const document = writeDoc('canonical-folder/inside.md', '# Inside\n');
    const data = writeDoc('canonical-folder/data.csv', 'inside,data\n');
    const latch = writeDoc('z-latch.csv', 'z,admitted\n');
    const ignore = writeDoc('.okignore', '');
    const filter = createContentFilter({ projectDir: contentDir, contentDir });
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries = ['canonical-folder', 'linked-folder', 'z-latch.csv'];
    const events: DiskEvent[] = [];
    let watcher: WatcherHandle;
    let afterObservation:
      | { inventory: ReturnType<typeof sortedTargetInventory>; alias: string | undefined }
      | undefined;
    const capture = () => ({
      inventory: sortedTargetInventory(watcher),
      alias: watcher.getFolderAliasIndex().get('linked-folder'),
    });
    watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      filter,
      {
        forceBackend: 'parcel',
        platform: 'darwin',
        onRecoveryComplete: async () => {
          afterObservation = capture();
        },
      },
    );
    handles.push(watcher);
    const admitted = {
      documentTargets: ['canonical-folder/inside'],
      fileTargets: ['.okignore', 'canonical-folder/data.csv', 'z-latch.csv'],
      folderTargets: ['canonical-folder'],
    };
    expect(watcher.getFolderIndex().has('canonical-folder')).toBe(true);
    expect(watcher.getFolderAliasIndex().has('linked-folder')).toBe(false);
    expect(sortedTargetInventory(watcher)).toEqual(admitted);

    const alias = join(contentDir, 'linked-folder');
    symlinkSync(canonical, alias);
    expect(watcher.getFolderAliasIndex().has('linked-folder')).toBe(false);
    expect(sortedTargetInventory(watcher)).toEqual(admitted);
    const entered = deferred();
    const resume = deferred();
    memberStatSchedule.seen = [];
    memberStatSchedule.path = latch;
    memberStatSchedule.entered = entered.release;
    memberStatSchedule.resume = resume.promise;
    const pending =
      surface === 'notice recovery'
        ? nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]))
        : watcher.rescanFromDisk().then(() => {
            afterObservation = capture();
          });
    let reconcile: ReturnType<typeof reconcileFileIndexAfterFilterRebuild> | undefined;
    let reconciled: Awaited<ReturnType<typeof reconcileFileIndexAfterFilterRebuild>> | undefined;
    let afterPrune: ReturnType<typeof capture> | undefined;
    try {
      await entered.promise;
      expect(
        memberStatSchedule.seen.filter(
          (path) => path === canonical || path === alias || path === latch,
        ),
      ).toEqual([canonical, alias, latch]);
      expect(watcher.getFolderAliasIndex().has('linked-folder')).toBe(false);
      writeFileSync(ignore, 'linked-folder/\n');
      expect((await filter.rebuildIgnorePatterns()).ok).toBe(true);
      expect(filter.isDirExcluded('linked-folder')).toBe(true);
      expect(filter.isDirExcluded('canonical-folder')).toBe(false);
      reconcile = reconcileFileIndexAfterFilterRebuild(watcher);
      afterPrune = capture();
      expect(afterPrune).toEqual({ inventory: admitted, alias: undefined });
    } finally {
      resume.release();
      await pending;
      if (reconcile) reconciled = await reconcile;
    }
    expect(reconciled).toEqual({ prunedFiles: 0, prunedFolders: 0 });
    expect(afterPrune).toEqual({ inventory: admitted, alias: undefined });
    expect.soft(afterObservation).toEqual({ inventory: admitted, alias: undefined });
    expect.soft(capture()).toEqual({ inventory: admitted, alias: undefined });
    expect
      .soft(events.filter((event) => event.kind === 'folder-delete' && event.path === alias))
      .toEqual([]);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(realpathSync(alias)).toBe(canonical);
    expect(readFileSync(document, 'utf8')).toBe('# Inside\n');
    expect(readFileSync(data, 'utf8')).toBe('inside,data\n');
    expect(readFileSync(latch, 'utf8')).toBe('z,admitted\n');
  },
);

test.each(['notice recovery', 'index-only rescan'] as const)(
  '%s keeps a newer public file effect only until its member is pruned',
  async (surface) => {
    const a = writeDoc('a.csv', 'old,shared\n');
    const b = join(contentDir, 'b.csv');
    linkSync(a, b);
    const alias = join(contentDir, 'y-alias.csv');
    symlinkSync(b, alias);
    const latch = writeDoc('z-latch.csv', 'z,admitted\n');
    const ignore = writeDoc('.okignore', '');
    const filter = createContentFilter({ projectDir: contentDir, contentDir });
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries = ['a.csv', 'b.csv', 'y-alias.csv', 'z-latch.csv'];
    const events: DiskEvent[] = [];
    let watcher: WatcherHandle;
    const capture = () => ({
      inventory: sortedTargetInventory(watcher),
      aSize: indexedRow(watcher, 'a.csv', 'file')?.size,
      aModified: indexedRow(watcher, 'a.csv', 'file')?.modified,
    });
    let afterObservation: ReturnType<typeof capture> | undefined;
    watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      filter,
      {
        forceBackend: 'parcel',
        platform: 'darwin',
        onRecoveryComplete: async () => {
          afterObservation = capture();
        },
      },
    );
    handles.push(watcher);
    expect(sortedTargetInventory(watcher)).toEqual({
      documentTargets: [],
      fileTargets: ['.okignore', 'a.csv', 'b.csv', 'y-alias.csv', 'z-latch.csv'],
      folderTargets: [],
    });
    const entered = deferred();
    const resume = deferred();
    memberStatSchedule.seen = [];
    memberStatSchedule.path = latch;
    memberStatSchedule.entered = entered.release;
    memberStatSchedule.resume = resume.promise;
    const pending =
      surface === 'notice recovery'
        ? nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]))
        : watcher.rescanFromDisk().then(() => {
            afterObservation = capture();
          });
    const c = join(contentDir, 'c.csv');
    let publicStat: ReturnType<typeof statSync> | undefined;
    let reconcile: ReturnType<typeof reconcileFileIndexAfterFilterRebuild> | undefined;
    let reconciled: Awaited<ReturnType<typeof reconcileFileIndexAfterFilterRebuild>> | undefined;
    let afterPrune: ReturnType<typeof capture> | undefined;
    try {
      await entered.promise;
      expect(
        memberStatSchedule.seen.filter(
          (path) => path === a || path === b || path === alias || path === latch,
        ),
      ).toEqual([a, b, alias, latch]);
      writeFileSync(b, 'newer,public,shared,metadata\n');
      publicStat = statSync(b);
      watcher.mutateFileIndex({
        kind: 'file-update',
        path: b,
        relativePath: 'b.csv',
        size: publicStat.size,
        modifiedTs: publicStat.mtimeMs,
        inode: Number(publicStat.ino),
      });
      writeFileSync(c, 'c,unrelated,public\n');
      const cStat = statSync(c);
      watcher.mutateFileIndex({
        kind: 'file-create',
        path: c,
        relativePath: 'c.csv',
        size: cStat.size,
        modifiedTs: cStat.mtimeMs,
        inode: Number(cStat.ino),
      });
      expect(sortedTargetInventory(watcher).fileTargets).toEqual([
        '.okignore',
        'a.csv',
        'b.csv',
        'c.csv',
        'y-alias.csv',
        'z-latch.csv',
      ]);
      expect(indexedRow(watcher, 'a.csv', 'file')?.size).toBe(publicStat.size);
      writeFileSync(ignore, 'b.csv\n');
      expect((await filter.rebuildIgnorePatterns()).ok).toBe(true);
      expect(filter.isPathIgnored('b.csv')).toBe(true);
      expect(filter.isPathIgnored('y-alias.csv')).toBe(false);
      expect(filter.isPathIgnored('a.csv')).toBe(false);
      expect(filter.isPathIgnored('c.csv')).toBe(false);
      reconcile = reconcileFileIndexAfterFilterRebuild(watcher);
      afterPrune = capture();
      expect(afterPrune.inventory).toEqual({
        documentTargets: [],
        fileTargets: ['.okignore', 'a.csv', 'c.csv', 'z-latch.csv'],
        folderTargets: [],
      });
    } finally {
      resume.release();
      await pending;
      if (reconcile) reconciled = await reconcile;
    }
    if (!publicStat) throw new Error('accepted public file update was not observed');
    const expectedModified = new Date(publicStat.mtimeMs).toISOString();
    expect(reconciled).toEqual({ prunedFiles: 0, prunedFolders: 0 });
    expect(afterPrune?.aSize).toBe(publicStat.size);
    expect(afterPrune?.aModified).toBe(expectedModified);
    const expectedTargets = ['.okignore', 'a.csv', 'c.csv', 'z-latch.csv'];
    expect.soft(afterObservation?.inventory.fileTargets).toEqual(expectedTargets);
    expect.soft(sortedTargetInventory(watcher).fileTargets).toEqual(expectedTargets);
    expect.soft(afterObservation?.aSize).toBe(publicStat.size);
    expect.soft(indexedRow(watcher, 'a.csv', 'file')?.size).toBe(publicStat.size);
    expect
      .soft(
        events.filter(
          (event) =>
            (event.kind === 'file-delete' || event.kind === 'asset-delete') &&
            (event.path === b || event.path === alias),
        ),
      )
      .toEqual([]);
    expect(lstatSync(b).isFile()).toBe(true);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(realpathSync(alias)).toBe(b);
    expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
    expect(statSync(c).ino).not.toBe(statSync(a).ino);
    expect(readFileSync(a, 'utf8')).toBe('newer,public,shared,metadata\n');
    expect(readFileSync(b, 'utf8')).toBe('newer,public,shared,metadata\n');
    expect(readFileSync(alias, 'utf8')).toBe('newer,public,shared,metadata\n');
    expect(readFileSync(c, 'utf8')).toBe('c,unrelated,public\n');
  },
);

test('a recovered Markdown callback excludes a second changed document before publication', async () => {
  const a = writeDoc('a.md', '# Before A\n');
  const b = writeDoc('b.md', '# Before B\n');
  const latch = writeDoc('z-latch.csv', 'z,admitted\n');
  const ignore = writeDoc('.okignore', '');
  const filter = createContentFilter({ projectDir: contentDir, contentDir });
  scanSchedule.orderedPath = contentDir;
  scanSchedule.orderedEntries = ['a.md', 'b.md', 'z-latch.csv'];
  const events: DiskEvent[] = [];
  let watcher: WatcherHandle;
  let firstName: 'a' | 'b' | undefined;
  let pendingName: 'a' | 'b' | undefined;
  let pendingAlreadyEmitted: boolean | undefined;
  let callbackCount = 0;
  let rebuildSucceeded = false;
  let afterPrune: ReturnType<typeof sortedTargetInventory> | undefined;
  let afterObservation: ReturnType<typeof sortedTargetInventory> | undefined;
  let reconcile: ReturnType<typeof reconcileFileIndexAfterFilterRebuild> | undefined;
  watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
      if (event.kind !== 'update' || (event.docName !== 'a' && event.docName !== 'b')) return;
      callbackCount++;
      if (firstName !== undefined) return;
      firstName = event.docName;
      pendingName = event.docName === 'a' ? 'b' : 'a';
      pendingAlreadyEmitted = events.some(
        (emitted) =>
          emitted.kind === 'update' && 'docName' in emitted && emitted.docName === pendingName,
      );
      writeFileSync(ignore, `${pendingName}.md\n`);
      rebuildSucceeded = (await filter.rebuildIgnorePatterns()).ok;
      reconcile = reconcileFileIndexAfterFilterRebuild(watcher);
      afterPrune = sortedTargetInventory(watcher);
    },
    filter,
    {
      forceBackend: 'parcel',
      platform: 'darwin',
      onRecoveryComplete: async () => {
        afterObservation = sortedTargetInventory(watcher);
      },
    },
  );
  handles.push(watcher);
  expect(sortedTargetInventory(watcher)).toEqual({
    documentTargets: ['a', 'b'],
    fileTargets: ['.okignore', 'z-latch.csv'],
    folderTargets: [],
  });
  writeFileSync(a, '# After A\n');
  writeFileSync(b, '# After B\n');
  const entered = deferred();
  const resume = deferred();
  memberStatSchedule.seen = [];
  memberStatSchedule.path = latch;
  memberStatSchedule.entered = entered.release;
  memberStatSchedule.resume = resume.promise;
  const pending = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  try {
    await entered.promise;
    expect(
      memberStatSchedule.seen.filter((path) => path === a || path === b || path === latch),
    ).toEqual([a, b, latch]);
  } finally {
    resume.release();
    await pending;
  }
  const reconciled = await reconcile;
  if (!firstName || !pendingName) throw new Error('changed Markdown callback was not observed');
  const first = firstName;
  const excluded = pendingName;
  const firstPath = first === 'a' ? a : b;
  const firstContent = first === 'a' ? '# After A\n' : '# After B\n';
  expect(callbackCount).toBeGreaterThan(0);
  expect(pendingAlreadyEmitted).toBe(false);
  expect(rebuildSucceeded).toBe(true);
  expect(filter.isExcluded(`${excluded}.md`)).toBe(true);
  expect(filter.isExcluded(`${first}.md`)).toBe(false);
  expect(reconciled).toEqual({ prunedFiles: 1, prunedFolders: 0 });
  const expected = {
    documentTargets: [first],
    fileTargets: ['.okignore', 'z-latch.csv'],
    folderTargets: [],
  };
  expect(afterPrune).toEqual(expected);
  expect.soft(afterObservation).toEqual(expected);
  expect.soft(sortedTargetInventory(watcher)).toEqual(expected);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: 'update',
      path: firstPath,
      docName: first,
      content: firstContent,
    }),
  );
  expect(readFileSync(a, 'utf8')).toBe('# After A\n');
  expect(readFileSync(b, 'utf8')).toBe('# After B\n');
  expect(readFileSync(latch, 'utf8')).toBe('z,admitted\n');
});

test('a pending alias deletion is rejected after the first alias callback excludes it', async () => {
  const a = writeDoc('a.csv', 'a,target\n');
  const b = writeDoc('b.csv', 'b,target\n');
  const x = join(contentDir, 'x-alias.csv');
  const y = join(contentDir, 'y-alias.csv');
  symlinkSync(a, x);
  symlinkSync(b, y);
  const ignore = writeDoc('.okignore', '');
  const filter = createContentFilter({ projectDir: contentDir, contentDir });
  scanSchedule.orderedPath = contentDir;
  scanSchedule.orderedEntries = ['a.csv', 'b.csv', 'x-alias.csv', 'y-alias.csv'];
  const events: DiskEvent[] = [];
  let watcher: WatcherHandle;
  let firstAlias: string | undefined;
  let pendingAlias: string | undefined;
  let pendingAlreadyEmitted: boolean | undefined;
  let rebuildSucceeded = false;
  let afterCallback: ReturnType<typeof sortedTargetInventory> | undefined;
  let reconcile: ReturnType<typeof reconcileFileIndexAfterFilterRebuild> | undefined;
  watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
      if (event.kind !== 'file-delete' || (event.path !== x && event.path !== y)) return;
      if (firstAlias !== undefined) return;
      firstAlias = event.path;
      pendingAlias = event.path === x ? y : x;
      pendingAlreadyEmitted = events.some(
        (emitted) => emitted.kind === 'file-delete' && emitted.path === pendingAlias,
      );
      writeFileSync(ignore, `${basename(pendingAlias)}\n`);
      rebuildSucceeded = (await filter.rebuildIgnorePatterns()).ok;
      reconcile = reconcileFileIndexAfterFilterRebuild(watcher);
      afterCallback = sortedTargetInventory(watcher);
    },
    filter,
    { forceBackend: 'parcel', platform: 'darwin' },
  );
  handles.push(watcher);
  expect(sortedTargetInventory(watcher)).toEqual({
    documentTargets: [],
    fileTargets: ['.okignore', 'a.csv', 'b.csv', 'x-alias.csv', 'y-alias.csv'],
    folderTargets: [],
  });
  unlinkSync(x);
  unlinkSync(y);
  await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  const reconciled = await reconcile;
  if (!firstAlias || !pendingAlias) throw new Error('first alias deletion was not observed');
  expect(pendingAlreadyEmitted).toBe(false);
  expect(rebuildSucceeded).toBe(true);
  expect(filter.isPathIgnored(basename(pendingAlias))).toBe(true);
  expect(filter.isPathIgnored(basename(firstAlias))).toBe(false);
  expect(filter.isPathIgnored('a.csv')).toBe(false);
  expect(filter.isPathIgnored('b.csv')).toBe(false);
  expect(reconciled).toEqual({ prunedFiles: 0, prunedFolders: 0 });
  expect(afterCallback).toEqual({
    documentTargets: [],
    fileTargets: ['.okignore', 'a.csv', 'b.csv'],
    folderTargets: [],
  });
  expect(
    events.filter((event) => event.kind === 'file-delete' && event.path === firstAlias),
  ).toEqual([{ kind: 'file-delete', path: firstAlias, relativePath: basename(firstAlias) }]);
  expect
    .soft(events.filter((event) => event.kind === 'file-delete' && event.path === pendingAlias))
    .toEqual([]);
  expect.soft(sortedTargetInventory(watcher)).toEqual({
    documentTargets: [],
    fileTargets: ['.okignore', 'a.csv', 'b.csv'],
    folderTargets: [],
  });
  expect(existsSync(x)).toBe(false);
  expect(existsSync(y)).toBe(false);
  expect(readFileSync(a, 'utf8')).toBe('a,target\n');
  expect(readFileSync(b, 'utf8')).toBe('b,target\n');
});

test('the final symlink target stat supplies shared metadata after earlier hardlink members were scanned', async () => {
  const a = writeDoc('a.csv', 'old\n');
  const b = join(contentDir, 'b.csv');
  const z = join(contentDir, 'z.csv');
  linkSync(a, b);
  symlinkSync(b, z);
  expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
  expect(lstatSync(z).isSymbolicLink()).toBe(true);
  expect(realpathSync(z)).toBe(b);
  scanSchedule.orderedPath = contentDir;
  scanSchedule.orderedEntries = ['a.csv', 'b.csv', 'z.csv'];
  const entered = deferred();
  const resume = deferred();
  memberStatSchedule.path = z;
  memberStatSchedule.entered = entered.release;
  memberStatSchedule.resume = resume.promise;
  const started = watchContent();
  let lastStat: ReturnType<typeof statSync> | undefined;
  try {
    const paused = await Promise.race([
      entered.promise.then(() => true),
      started.then(() => false),
    ]);
    expect(paused).toBe(true);
    writeFileSync(b, 'new,shared,metadata\n');
    lastStat = statSync(b);
    expect(readFileSync(a, 'utf8')).toBe('new,shared,metadata\n');
    expect(readFileSync(z, 'utf8')).toBe('new,shared,metadata\n');
  } finally {
    resume.release();
    await started;
  }
  const { watcher, events } = await started;
  expect(lastStat).toBeDefined();
  expect(events).toEqual([]);
  expect(indexedFileTargets(watcher)).toEqual(['a.csv', 'b.csv', 'z.csv']);
  expect([...watcher.getAllFilesIndex()][0]?.[1].fileMembers).toEqual({
    regularPaths: ['a.csv', 'b.csv'],
    symlinks: [{ path: 'z.csv', targetPath: 'b.csv' }],
  });
  expect(indexedGeneralRows(watcher)).toEqual([
    expect.objectContaining({
      name: 'a.csv',
      canonicalPath: a,
      aliases: ['z.csv'],
      size: lastStat?.size,
      modified: lastStat?.mtime.toISOString(),
      inode: Number(lastStat?.ino),
    }),
  ]);
});

test('stable scan order preserves the bounded HTTP file-search result', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const bytes = 'invoice,shared\n';
  const fixedMtime = new Date('2020-01-02T03:04:05.000Z');
  const names: string[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < 41; index++) {
    const suffix = String(index).padStart(2, '0');
    const aName = `invoice-${suffix}.csv`;
    const zName = `z-invoice-${suffix}.csv`;
    const a = writeDoc(aName, bytes);
    const z = join(contentDir, zName);
    linkSync(a, z);
    utimesSync(a, fixedMtime, fixedMtime);
    const aStat = lstatSync(a);
    const zStat = lstatSync(z);
    expect(aStat.isFile()).toBe(true);
    expect(zStat.isFile()).toBe(true);
    expect([aStat.dev, aStat.ino]).toEqual([zStat.dev, zStat.ino]);
    expect(realpathSync(a)).toBe(a);
    expect(realpathSync(z)).toBe(z);
    expect([readFileSync(a, 'utf8'), readFileSync(z, 'utf8')]).toEqual([bytes, bytes]);
    expect([aStat.size, zStat.size]).toEqual([Buffer.byteLength(bytes), Buffer.byteLength(bytes)]);
    expect([aStat.mtimeMs, zStat.mtimeMs]).toEqual([fixedMtime.getTime(), fixedMtime.getTime()]);
    identities.add(`${aStat.dev}:${aStat.ino}`);
    if (index === 0) names.push(zName, aName);
    else names.push(aName, zName);
  }
  expect(identities.size).toBe(41);
  expect(names).toHaveLength(82);
  scanSchedule.orderedPath = contentDir;
  scanSchedule.orderedEntries = names;
  const server = await bootInventoryServer();
  try {
    const listed = (await listedEntries(server.port)).filter(
      (entry) => entry.kind === 'file' && entry.docName?.includes('invoice'),
    );
    expect(listed).toHaveLength(82);
    expect(listed.map((entry) => entry.docName).toSorted()).toEqual(names.toSorted());
    for (const entry of listed) {
      expect(entry).toMatchObject({
        size: Buffer.byteLength(bytes),
        modified: fixedMtime.toISOString(),
        isSymlink: false,
        targetPath: null,
      });
    }
    const search = async (query: string, limit: number) => {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/search?query=${query}&intent=omnibar&scope=file&ranking=relevance&limit=${limit}&semantic=false`,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        ready: boolean;
        truncated?: boolean;
        results: Array<{ kind: string; path: string; score?: number }>;
      };
    };
    const all = await search('invoice', 100);
    expect(all.ready).toBe(true);
    expect(all.truncated).not.toBe(true);
    expect(all.results).toHaveLength(41);
    expect(all.results.map((result) => result.path).toSorted()).toEqual(
      Array.from({ length: 41 }, (_, index) => `invoice-${String(index).padStart(2, '0')}.csv`),
    );
    const bounded = await search('invoice', 5);
    const empty = await search('', 5);
    expect(bounded.ready).toBe(true);
    expect(bounded.truncated).not.toBe(true);
    expect(bounded.results).toHaveLength(5);
    expect(bounded.results.every((result) => result.kind === 'file')).toBe(true);
    expect(empty.ready).toBe(true);
    expect(empty.truncated).not.toBe(true);
    expect(empty.results.map((result) => result.path)).toEqual([
      'invoice-00.csv',
      'invoice-01.csv',
      'invoice-02.csv',
      'invoice-03.csv',
      'invoice-04.csv',
    ]);
    expect(bounded.results.map((result) => result.path)).toEqual([
      'invoice-01.csv',
      'invoice-02.csv',
      'invoice-03.csv',
      'invoice-04.csv',
      'invoice-05.csv',
    ]);
  } finally {
    scanSchedule.orderedEntries = null;
    scanSchedule.orderedPath = null;
    await server.destroy();
    for (const dir of nativeSubscriptionDirs()) {
      expect(nativeSubscriptionOn(dir).nativeReleases()).toBe(1);
    }
  }
});

test('a live dependent cohort selects the minimum name for a new physical group', async () => {
  const a = writeDoc('a.csv', 'old,group\n');
  const b = join(contentDir, 'b.csv');
  const c = writeDoc('c.csv', 'known,group\n');
  const first = join(contentDir, 'dep-first.csv');
  const second = join(contentDir, 'dep-second.csv');
  linkSync(a, b);
  symlinkSync(b, first);
  symlinkSync(b, second);
  const { watcher } = await watchContent();
  expect(
    indexedGeneralRows(watcher)
      .map((row) => row.name)
      .toSorted(),
  ).toEqual(['a.csv', 'c.csv']);
  expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
  expect(statSync(c).ino).not.toBe(statSync(a).ino);
  expect(realpathSync(first)).toBe(b);
  expect(realpathSync(second)).toBe(b);
  expect(indexedAliasOwner(watcher, 'dep-first.csv')?.aliases).toContain('dep-second.csv');
  expect(indexedFileTargets(watcher)).toEqual([
    'a.csv',
    'b.csv',
    'c.csv',
    'dep-first.csv',
    'dep-second.csv',
  ]);
  const zNew = writeDoc('z-new-orbit.csv', 'new,orbit\n');
  const aNew = join(contentDir, 'a-new-orbit.csv');
  linkSync(zNew, aNew);
  unlinkSync(first);
  symlinkSync(zNew, first);
  unlinkSync(second);
  symlinkSync(aNew, second);
  unlinkSync(b);
  symlinkSync(c, b);
  expect([statSync(zNew).dev, statSync(zNew).ino]).toEqual([
    statSync(aNew).dev,
    statSync(aNew).ino,
  ]);
  expect(statSync(zNew).ino).not.toBe(statSync(a).ino);
  expect(statSync(zNew).ino).not.toBe(statSync(c).ino);
  expect([realpathSync(first), realpathSync(second), realpathSync(b)]).toEqual([zNew, aNew, c]);
  expect([first, second, b].every((path) => lstatSync(path).isSymbolicLink())).toBe(true);
  expect(lstatSync(zNew).isFile()).toBe(true);
  expect(lstatSync(aNew).isFile()).toBe(true);
  expect(indexedFileTargets(watcher)).not.toContain('a-new-orbit.csv');
  expect(indexedFileTargets(watcher)).not.toContain('z-new-orbit.csv');

  await deliver(contentDir, [{ type: 'update', path: b }]);

  const newGroups = [...watcher.getAllFilesIndex()].filter(
    ([, entry]) =>
      entry.kind === 'file' && entry.fileMembers?.regularPaths.includes('a-new-orbit.csv'),
  );
  expect(newGroups).toHaveLength(1);
  expect(newGroups[0]?.[0]).toBe('a-new-orbit.csv');
  expect(newGroups[0]?.[1]).toMatchObject({
    canonicalPath: aNew,
    fileMembers: {
      regularPaths: ['a-new-orbit.csv', 'z-new-orbit.csv'],
      symlinks: [
        { path: 'dep-first.csv', targetPath: 'z-new-orbit.csv' },
        { path: 'dep-second.csv', targetPath: 'a-new-orbit.csv' },
      ],
    },
  });
  expect(
    indexedGeneralRows(watcher)
      .map((row) => row.name)
      .toSorted(),
  ).toEqual(['a-new-orbit.csv', 'a.csv', 'c.csv']);
  expect(indexedAliasOwner(watcher, 'b.csv')?.canonicalPath).toBe(c);
  expect(indexedFileTargets(watcher)).toEqual([
    'a-new-orbit.csv',
    'a.csv',
    'b.csv',
    'c.csv',
    'dep-first.csv',
    'dep-second.csv',
    'z-new-orbit.csv',
  ]);
});

test('a repeated directory observation defers denied dependent changes and later settles both role directions', async () => {
  const c = writeDoc('c.csv', 'distinct,target\n');
  const folder = join(contentDir, 'z-dir');
  mkdirSync(folder);
  const a = writeDoc('z-dir/a.csv', 'shared,target\n');
  const b = join(folder, 'b.csv');
  const y = join(folder, 'y.csv');
  const folderAlias = join(contentDir, '0-dir-alias');
  const latch = writeDoc('m-latch.csv', 'latch\n');
  linkSync(a, b);
  symlinkSync(b, y);
  symlinkSync(folder, folderAlias);
  expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
  expect(statSync(c).ino).not.toBe(statSync(a).ino);
  expect(lstatSync(y).isSymbolicLink()).toBe(true);
  expect(realpathSync(y)).toBe(b);
  expect(lstatSync(folderAlias).isSymbolicLink()).toBe(true);
  expect(realpathSync(folderAlias)).toBe(folder);
  scanSchedule.orderedPath = contentDir;
  scanSchedule.orderedEntries = ['c.csv', '0-dir-alias', 'm-latch.csv', 'z-dir'];
  const events: DiskEvent[] = [];
  const completed: string[] = [];
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
    },
    undefined,
    {
      forceBackend: 'parcel',
      platform: 'darwin',
      onRecoveryComplete: async () => {
        completed.push('complete');
      },
    },
  );
  handles.push(watcher);
  const expectedTargets = [
    '0-dir-alias/a.csv',
    '0-dir-alias/b.csv',
    '0-dir-alias/y.csv',
    'c.csv',
    'm-latch.csv',
    'z-dir/a.csv',
    'z-dir/b.csv',
    'z-dir/y.csv',
  ].toSorted();
  expect(indexedFileTargets(watcher)).toEqual(expectedTargets);
  expect(indexedAliasOwner(watcher, 'z-dir/y.csv')?.canonicalPath).toBe(a);
  const before = {
    groups: structuredClone([...watcher.getAllFilesIndex()]),
    targets: indexedFileTargets(watcher),
  };
  const revisit = async (replace: () => void, denyDependent: boolean) => {
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries = ['c.csv', '0-dir-alias', 'm-latch.csv', 'z-dir'];
    const entered = deferred();
    const resume = deferred();
    memberStatSchedule.path = latch;
    memberStatSchedule.entered = entered.release;
    memberStatSchedule.resume = resume.promise;
    const pending = nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    try {
      const firstWalkFinished = await Promise.race([
        entered.promise.then(() => true),
        pending.then(() => false),
      ]);
      expect(firstWalkFinished).toBe(true);
      replace();
      scanSchedule.orderedPath = folder;
      scanSchedule.orderedEntries = ['a.csv', 'b.csv', 'y.csv'];
      if (denyDependent) denyAdmission('realpath', y);
    } finally {
      resume.release();
      try {
        await pending;
      } finally {
        clearAdmissionDenial();
      }
    }
    await vi.runAllTimersAsync();
  };

  await revisit(() => {
    unlinkSync(b);
    symlinkSync(c, b);
    expect(lstatSync(b).isSymbolicLink()).toBe(true);
    expect(realpathSync(b)).toBe(c);
    expect(realpathSync(y)).toBe(c);
  }, true);
  expect(admissionFault.observed).toBe(true);
  expect(completed).toEqual([]);
  expect(events).toEqual([]);
  expect({
    groups: structuredClone([...watcher.getAllFilesIndex()]),
    targets: indexedFileTargets(watcher),
  }).toEqual(before);

  await deliverNotice(contentDir);
  expect(completed).toEqual(['complete']);
  expect(indexedFileTargets(watcher)).toEqual(expectedTargets);
  expect(indexedAliasOwner(watcher, 'z-dir/b.csv')?.canonicalPath).toBe(c);
  expect(indexedAliasOwner(watcher, 'z-dir/y.csv')?.canonicalPath).toBe(c);
  expect(indexedRow(watcher, 'z-dir/a.csv', 'file')?.canonicalPath).toBe(a);
  expect(readFileSync(a, 'utf8')).toBe('shared,target\n');
  expect(readFileSync(c, 'utf8')).toBe('distinct,target\n');

  const acceptedIntoC = {
    groups: structuredClone([...watcher.getAllFilesIndex()]),
    targets: indexedFileTargets(watcher),
  };
  events.length = 0;
  await revisit(() => {
    unlinkSync(b);
    symlinkSync(a, b);
    expect(lstatSync(b).isSymbolicLink()).toBe(true);
    expect(realpathSync(b)).toBe(a);
    expect(realpathSync(y)).toBe(a);
  }, true);
  expect(admissionFault.observed).toBe(true);
  expect(completed).toEqual(['complete']);
  expect(events).toEqual([]);
  expect({
    groups: structuredClone([...watcher.getAllFilesIndex()]),
    targets: indexedFileTargets(watcher),
  }).toEqual(acceptedIntoC);

  await deliverNotice(contentDir);
  expect(completed).toEqual(['complete', 'complete']);
  expect(indexedFileTargets(watcher)).toEqual(expectedTargets);
  expect(indexedAliasOwner(watcher, 'z-dir/b.csv')?.canonicalPath).toBe(a);
  expect(indexedAliasOwner(watcher, 'z-dir/y.csv')?.canonicalPath).toBe(a);
  expect(indexedRow(watcher, 'c.csv', 'file')?.canonicalPath).toBe(c);

  unlinkSync(b);
  symlinkSync(c, b);
  expect(lstatSync(b).isSymbolicLink()).toBe(true);
  expect(realpathSync(b)).toBe(c);
  expect(realpathSync(y)).toBe(c);
  await deliverNotice(contentDir);
  expect(completed).toEqual(['complete', 'complete', 'complete']);
  expect(indexedFileTargets(watcher)).toEqual(expectedTargets);
  expect(indexedAliasOwner(watcher, 'z-dir/b.csv')?.canonicalPath).toBe(c);
  expect(indexedAliasOwner(watcher, 'z-dir/y.csv')?.canonicalPath).toBe(c);

  await revisit(() => {
    unlinkSync(b);
    linkSync(a, b);
    expect(lstatSync(b).isFile()).toBe(true);
    expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
    expect(realpathSync(y)).toBe(b);
  }, false);
  expect(completed).toEqual(['complete', 'complete', 'complete', 'complete']);
  expect(indexedFileTargets(watcher)).toEqual(expectedTargets);
  expect(
    [...watcher.getAllFilesIndex()].find(([name]) => name === 'z-dir/a.csv')?.[1].fileMembers,
  ).toEqual({
    regularPaths: ['z-dir/a.csv', 'z-dir/b.csv'],
    symlinks: [{ path: 'z-dir/y.csv', targetPath: 'z-dir/b.csv' }],
  });
  expect(indexedRow(watcher, 'c.csv', 'file')?.canonicalPath).toBe(c);
});

test.each(['origin', 'target'] as const)(
  'pruning the pending $0 during the first alias callback cancels its target update',
  async (pruned) => {
    const a = writeDoc('a.csv', 'first,target\n');
    const b = writeDoc('b.csv', 'second,target\n');
    const x = join(contentDir, 'x.csv');
    const y = join(contentDir, 'y.csv');
    const ignore = writeDoc('.okignore', '');
    symlinkSync(a, x);
    symlinkSync(b, y);
    const filter = dynamicSkillFilter();
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries = ['a.csv', 'b.csv', 'x.csv', 'y.csv'];
    let callbackCount = 0;
    let firstTarget: string | undefined;
    let pendingTarget: string | undefined;
    let pendingAlias: string | undefined;
    let retainedAlias: string | undefined;
    let ignoredName: string | undefined;
    let pendingAlreadyEmitted = false;
    let rebuildSucceeded = false;
    let ignoredPath = false;
    let generationAdvanced = false;
    let physicalRetained = false;
    let callbackTargets: string[] = [];
    const targetNames = (watcher: WatcherHandle) =>
      indexedFileTargets(watcher).filter((name) => name !== '.okignore');
    const watched = await watchContent(filter, async (event) => {
      if (event.kind !== 'file-update' || (event.path !== a && event.path !== b)) return;
      if (firstTarget !== undefined) return;
      callbackCount++;
      firstTarget = event.path;
      pendingTarget = event.path === a ? b : a;
      pendingAlias = event.path === a ? x : y;
      retainedAlias = event.path === a ? y : x;
      pendingAlreadyEmitted = watched.events.some(
        (emitted) => emitted.kind === 'file-update' && emitted.path === pendingTarget,
      );
      ignoredName = basename(pruned === 'origin' ? pendingAlias : pendingTarget);
      const generation = watched.watcher.getFileIndexGeneration();
      writeFileSync(ignore, `${ignoredName}\n`);
      rebuildSucceeded = (await filter.rebuildIgnorePatterns()).ok;
      ignoredPath = filter.isPathIgnored(ignoredName);
      watched.watcher.pruneFileIndexNowExcluded();
      generationAdvanced = watched.watcher.getFileIndexGeneration() > generation;
      callbackTargets = targetNames(watched.watcher);
      physicalRetained = [a, b, x, y].every((path) => existsSync(path));
    });
    expect(targetNames(watched.watcher)).toEqual(['a.csv', 'b.csv', 'x.csv', 'y.csv']);
    expect(realpathSync(x)).toBe(a);
    expect(realpathSync(y)).toBe(b);
    unlinkSync(x);
    unlinkSync(y);
    symlinkSync(b, x);
    symlinkSync(a, y);
    expect(realpathSync(x)).toBe(b);
    expect(realpathSync(y)).toBe(a);

    await deliverNotice(contentDir);

    const emittedFirst = firstTarget;
    const targetStillPending = pendingTarget;
    const originStillPending = pendingAlias;
    const originRetained = retainedAlias;
    if (
      emittedFirst === undefined ||
      targetStillPending === undefined ||
      originStillPending === undefined ||
      originRetained === undefined ||
      ignoredName === undefined
    ) {
      throw new Error('first target update did not identify a pending relation');
    }
    const expected =
      pruned === 'origin'
        ? ['a.csv', 'b.csv', basename(originRetained)].toSorted()
        : [basename(emittedFirst), basename(originRetained)].toSorted();
    expect(callbackCount).toBe(1);
    expect(pendingAlreadyEmitted).toBe(false);
    expect(rebuildSucceeded).toBe(true);
    expect(ignoredPath).toBe(true);
    expect(generationAdvanced).toBe(true);
    expect(physicalRetained).toBe(true);
    expect(ignoredName).toBe(
      basename(pruned === 'origin' ? originStillPending : targetStillPending),
    );
    expect(callbackTargets).toEqual(expected);
    expect(watched.events).toContainEqual(
      expect.objectContaining({ kind: 'file-update', path: emittedFirst }),
    );
    expect
      .soft(
        watched.events.filter(
          (event) => event.kind === 'file-update' && event.path === targetStillPending,
        ),
      )
      .toEqual([]);
    expect.soft(targetNames(watched.watcher)).toEqual(expected);
    watched.events.length = 0;
    await deliverNotice(contentDir);
    expect
      .soft(
        watched.events.filter(
          (event) => event.kind === 'file-update' && event.path === targetStillPending,
        ),
      )
      .toEqual([]);
    expect.soft(targetNames(watched.watcher)).toEqual(expected);
  },
);

test('a pending alias update carries newer shared metadata from another accepted hardlink', async () => {
  const a = writeDoc('a.csv', 'old,target\n');
  const aPeer = join(contentDir, 'a-peer.csv');
  const b = writeDoc('b.csv', 'other,target\n');
  const bPeer = join(contentDir, 'b-peer.csv');
  const x = join(contentDir, 'x.csv');
  const y = join(contentDir, 'y.csv');
  linkSync(a, aPeer);
  linkSync(b, bPeer);
  symlinkSync(a, x);
  symlinkSync(b, y);
  expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(aPeer).dev, statSync(aPeer).ino]);
  expect([statSync(b).dev, statSync(b).ino]).toEqual([statSync(bPeer).dev, statSync(bPeer).ino]);
  expect(statSync(a).ino).not.toBe(statSync(b).ino);
  scanSchedule.orderedPath = contentDir;
  scanSchedule.orderedEntries = ['a.csv', 'a-peer.csv', 'b.csv', 'b-peer.csv', 'x.csv', 'y.csv'];
  let callbackCount = 0;
  let firstTarget: string | undefined;
  let pendingTarget: string | undefined;
  let pendingPeer: string | undefined;
  let pendingAlreadyEmitted = false;
  let expectedSize: number | undefined;
  let expectedModifiedTs: number | undefined;
  let callbackGroupSize: number | undefined;
  let callbackTargets: string[] = [];
  let callbackBytes: string | undefined;
  const watched = await watchContent(undefined, async (event) => {
    if (event.kind !== 'file-update' || (event.path !== a && event.path !== b)) return;
    if (firstTarget !== undefined) return;
    callbackCount++;
    firstTarget = event.path;
    pendingTarget = event.path === a ? b : a;
    pendingPeer = event.path === a ? bPeer : aPeer;
    pendingAlreadyEmitted = watched.events.some(
      (emitted) => emitted.kind === 'file-update' && emitted.path === pendingTarget,
    );
    writeFileSync(pendingPeer, 'new,longer,shared,metadata\n');
    const stat = statSync(pendingPeer);
    expectedSize = stat.size;
    expectedModifiedTs = new Date(stat.mtimeMs).getTime();
    watched.watcher.mutateFileIndex({
      kind: 'file-update',
      path: pendingPeer,
      relativePath: basename(pendingPeer),
      size: stat.size,
      modifiedTs: stat.mtimeMs,
      inode: Number(stat.ino),
    });
    callbackBytes = readFileSync(pendingTarget, 'utf8');
    callbackGroupSize = [...watched.watcher.getAllFilesIndex()].find(
      ([, entry]) =>
        entry.kind === 'file' && entry.fileMembers?.regularPaths.includes(basename(pendingTarget)),
    )?.[1].size;
    callbackTargets = indexedFileTargets(watched.watcher);
  });
  const expectedTargets = ['a-peer.csv', 'a.csv', 'b-peer.csv', 'b.csv', 'x.csv', 'y.csv'];
  expect(indexedFileTargets(watched.watcher)).toEqual(expectedTargets);
  expect(realpathSync(x)).toBe(a);
  expect(realpathSync(y)).toBe(b);
  unlinkSync(x);
  unlinkSync(y);
  symlinkSync(b, x);
  symlinkSync(a, y);
  expect(realpathSync(x)).toBe(b);
  expect(realpathSync(y)).toBe(a);
  const priorSizes = { a: statSync(a).size, b: statSync(b).size };

  await deliverNotice(contentDir);

  const emittedFirst = firstTarget;
  const targetStillPending = pendingTarget;
  const updatedPeer = pendingPeer;
  if (emittedFirst === undefined || targetStillPending === undefined || updatedPeer === undefined) {
    throw new Error('first target update did not identify a pending hardlink group');
  }
  expect(callbackCount).toBe(1);
  expect(pendingAlreadyEmitted).toBe(false);
  expect(expectedSize).toBeDefined();
  expect(expectedModifiedTs).toBeDefined();
  expect(expectedSize).not.toBe(targetStillPending === a ? priorSizes.a : priorSizes.b);
  expect(callbackBytes).toBe('new,longer,shared,metadata\n');
  expect(callbackGroupSize).toBe(expectedSize);
  expect(callbackTargets).toEqual(expectedTargets);
  expect(watched.events).toContainEqual(
    expect.objectContaining({ kind: 'file-update', path: emittedFirst }),
  );
  const later = watched.events.filter(
    (event) => event.kind === 'file-update' && event.path === targetStillPending,
  );
  expect(later).toHaveLength(1);
  expect.soft(later[0]).toMatchObject({
    size: expectedSize,
    modifiedTs: expectedModifiedTs,
  });
  expect.soft(indexedFileTargets(watched.watcher)).toEqual(expectedTargets);
  expect(readFileSync(targetStillPending, 'utf8')).toBe('new,longer,shared,metadata\n');
  expect(readFileSync(updatedPeer, 'utf8')).toBe('new,longer,shared,metadata\n');
});

async function listedReferencedAssetEntries(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/api/documents`);
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      documents: Array<{
        kind: string;
        docName?: string;
        path?: string;
        size?: number;
        modified?: string;
        referencedBy?: string[];
      }>;
    }
  ).documents;
}

test('a warmed referenced asset leaves the document listing after a filter rebuild', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const a = writeDoc('a.csv', 'same,referenced,bytes\n');
  const b = join(contentDir, 'b.csv');
  linkSync(a, b);
  const sourceContent = '# Source\n\n[A](a.csv)\n\n[B](b.csv)\n';
  const source = writeDoc('source.md', sourceContent);
  const ignore = writeDoc('.okignore', '');
  const sourceStat = statSync(source);
  const bStat = statSync(b);
  expect([statSync(a).dev, statSync(a).ino]).toEqual([bStat.dev, bStat.ino]);
  const server = await bootInventoryServer();
  try {
    const before = await listedReferencedAssetEntries(server.port);
    expect(before.filter((row) => row.docName === 'b.csv')).toEqual([
      expect.objectContaining({
        kind: 'asset',
        path: 'b.csv',
        size: bStat.size,
        modified: bStat.mtime.toISOString(),
        referencedBy: ['source'],
      }),
    ]);
    expect(before.filter((row) => row.docName === 'a.csv')).toEqual([
      expect.objectContaining({ kind: 'asset', path: 'a.csv', referencedBy: ['source'] }),
    ]);
    const beforeLinks = await inventoryForwardStatuses(server.port);
    expect(beforeLinks).toMatchObject({ 'a.csv': 'exact', 'b.csv': 'exact' });

    writeFileSync(ignore, 'b.csv\n');
    expect((await server.serverInstance.contentFilter.rebuildIgnorePatterns()).ok).toBe(true);
    expect(server.serverInstance.contentFilter.isPathIgnored('b.csv')).toBe(true);
    expect(server.serverInstance.contentFilter.isPathIgnored('a.csv')).toBe(false);
    const afterRebuild = await listedReferencedAssetEntries(server.port);
    await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    const afterNotice = await listedReferencedAssetEntries(server.port);

    expect.soft(afterRebuild.filter((row) => row.docName === 'b.csv')).toEqual([]);
    expect.soft(afterNotice.filter((row) => row.docName === 'b.csv')).toEqual([]);
    for (const listing of [afterRebuild, afterNotice]) {
      expect
        .soft(listing.filter((row) => row.docName === 'a.csv'))
        .toEqual([
          expect.objectContaining({ kind: 'asset', path: 'a.csv', referencedBy: ['source'] }),
        ]);
    }
    expect.soft(await inventoryForwardStatuses(server.port)).toMatchObject({
      'a.csv': 'exact',
      'b.csv': 'missing',
    });
    const asset = await fetch(`http://127.0.0.1:${server.port}/api/asset-text?path=a.csv`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('same,referenced,bytes\n');
    expect(readFileSync(source, 'utf8')).toBe(sourceContent);
    expect(statSync(source).size).toBe(sourceStat.size);
    expect(statSync(source).mtimeMs).toBe(sourceStat.mtimeMs);
    expect(readFileSync(b, 'utf8')).toBe('same,referenced,bytes\n');
    expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
  } finally {
    await server.destroy();
  }
});

test('a warmed exclusion yields a referenced asset after rebuild and completed notice', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const a = writeDoc('a.csv', 'same,referenced,bytes\n');
  const b = join(contentDir, 'b.csv');
  linkSync(a, b);
  const sourceContent = '# Source\n\n[A](a.csv)\n\n[B](b.csv)\n';
  const source = writeDoc('source.md', sourceContent);
  const ignore = writeDoc('.okignore', 'b.csv\n');
  const sourceStat = statSync(source);
  const bStat = statSync(b);
  expect([statSync(a).dev, statSync(a).ino]).toEqual([bStat.dev, bStat.ino]);
  const server = await bootInventoryServer();
  try {
    expect(server.serverInstance.contentFilter.isPathIgnored('b.csv')).toBe(true);
    const before = await listedReferencedAssetEntries(server.port);
    expect(before.filter((row) => row.docName === 'b.csv')).toEqual([]);
    expect(before.filter((row) => row.docName === 'a.csv')).toEqual([
      expect.objectContaining({ kind: 'asset', path: 'a.csv', referencedBy: ['source'] }),
    ]);
    expect(await inventoryForwardStatuses(server.port)).toMatchObject({
      'a.csv': 'exact',
      'b.csv': 'missing',
    });

    writeFileSync(ignore, '');
    expect((await server.serverInstance.contentFilter.rebuildIgnorePatterns()).ok).toBe(true);
    expect(server.serverInstance.contentFilter.isPathIgnored('b.csv')).toBe(false);
    const beforeNotice = await listedReferencedAssetEntries(server.port);
    expect(beforeNotice.filter((row) => row.docName === 'a.csv')).toEqual([
      expect.objectContaining({ kind: 'asset', path: 'a.csv', referencedBy: ['source'] }),
    ]);
    await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    const afterNotice = await listedReferencedAssetEntries(server.port);

    expect.soft(afterNotice.filter((row) => row.docName === 'b.csv')).toEqual([
      expect.objectContaining({
        kind: 'asset',
        path: 'b.csv',
        size: bStat.size,
        modified: bStat.mtime.toISOString(),
        referencedBy: ['source'],
      }),
    ]);
    expect
      .soft(afterNotice.filter((row) => row.docName === 'a.csv'))
      .toEqual([
        expect.objectContaining({ kind: 'asset', path: 'a.csv', referencedBy: ['source'] }),
      ]);
    expect.soft(await inventoryForwardStatuses(server.port)).toMatchObject({
      'a.csv': 'exact',
      'b.csv': 'exact',
    });
    const asset = await fetch(`http://127.0.0.1:${server.port}/api/asset-text?path=a.csv`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('same,referenced,bytes\n');
    expect(readFileSync(source, 'utf8')).toBe(sourceContent);
    expect(statSync(source).size).toBe(sourceStat.size);
    expect(statSync(source).mtimeMs).toBe(sourceStat.mtimeMs);
    expect(readFileSync(b, 'utf8')).toBe('same,referenced,bytes\n');
    expect([statSync(a).dev, statSync(a).ino]).toEqual([statSync(b).dev, statSync(b).ino]);
  } finally {
    await server.destroy();
  }
});

test('a warmed folder alias reference follows its retarget after notice', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const first = join(contentDir, 'first');
  const second = join(contentDir, 'second');
  mkdirSync(first);
  mkdirSync(second);
  const firstData = writeDoc('first/data.csv', 'first,referenced,bytes\n');
  const secondData = writeDoc('second/data.csv', 'second,other,bytes\n');
  const linked = join(contentDir, 'linked');
  symlinkSync(first, linked);
  const sourceContent = '# Source\n\n[Data](linked/data.csv)\n';
  const source = writeDoc('source.md', sourceContent);
  const sourceStat = statSync(source);
  const firstStat = statSync(firstData);
  const secondStat = statSync(secondData);
  expect(lstatSync(linked).isSymbolicLink()).toBe(true);
  expect(realpathSync(linked)).toBe(first);
  const server = await bootInventoryServer();
  try {
    const before = await listedReferencedAssetEntries(server.port);
    expect(before.filter((row) => row.docName === 'first/data.csv')).toEqual([
      expect.objectContaining({
        kind: 'asset',
        path: 'first/data.csv',
        size: firstStat.size,
        modified: firstStat.mtime.toISOString(),
        referencedBy: ['source'],
      }),
    ]);
    expect(before.filter((row) => row.docName === 'second/data.csv')).toEqual([
      expect.objectContaining({ kind: 'file', path: 'second/data.csv' }),
    ]);
    expect(await inventoryForwardStatuses(server.port)).toMatchObject({
      'linked/data.csv': 'exact',
    });

    unlinkSync(linked);
    symlinkSync(second, linked);
    expect(realpathSync(linked)).toBe(second);
    await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    const after = await listedReferencedAssetEntries(server.port);

    expect.soft(after.filter((row) => row.docName === 'second/data.csv')).toEqual([
      expect.objectContaining({
        kind: 'asset',
        path: 'second/data.csv',
        size: secondStat.size,
        modified: secondStat.mtime.toISOString(),
        referencedBy: ['source'],
      }),
    ]);
    expect
      .soft(after.filter((row) => row.docName === 'first/data.csv'))
      .toEqual([expect.objectContaining({ kind: 'file', path: 'first/data.csv' })]);
    expect.soft(await inventoryForwardStatuses(server.port)).toMatchObject({
      'linked/data.csv': 'exact',
    });
    const asset = await fetch(
      `http://127.0.0.1:${server.port}/api/asset-text?path=second/data.csv`,
    );
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('second,other,bytes\n');
    const aliasAsset = await fetch(
      `http://127.0.0.1:${server.port}/api/asset-text?path=linked/data.csv`,
    );
    expect(aliasAsset.status).toBe(400);
    expect(readFileSync(firstData, 'utf8')).toBe('first,referenced,bytes\n');
    expect(readFileSync(secondData, 'utf8')).toBe('second,other,bytes\n');
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(realpathSync(linked)).toBe(second);
    expect(readFileSync(source, 'utf8')).toBe(sourceContent);
    expect(statSync(source).size).toBe(sourceStat.size);
    expect(statSync(source).mtimeMs).toBe(sourceStat.mtimeMs);
  } finally {
    await server.destroy();
  }
});

async function listedProjectedEntries(port: number, dir?: string) {
  const suffix = dir ? `?dir=${encodeURIComponent(dir)}` : '';
  const response = await fetch(`http://127.0.0.1:${port}/api/documents${suffix}`);
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      documents: Array<{
        kind: string;
        docName?: string;
        path?: string;
        docExt?: string;
        size?: number;
        modified?: string;
        isSymlink?: boolean;
        canonicalDocName?: string | null;
        targetPath?: string | null;
      }>;
    }
  ).documents;
}

test('a folder alias lists a general symlink member beside projected regular members', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const real = join(contentDir, 'real');
  mkdirSync(real);
  const a = writeDoc('real/a.csv', 'shared,physical,bytes\n');
  const b = join(real, 'b.csv');
  linkSync(a, b);
  const y = join(real, 'y.csv');
  symlinkSync(b, y);
  const linked = join(contentDir, 'linked');
  symlinkSync(real, linked);
  const sourceContent = '# Source\n\n[File](linked/y.csv)\n';
  const source = writeDoc('source.md', sourceContent);
  const sourceStat = statSync(source);
  const bStat = statSync(b);
  expect([statSync(a).dev, statSync(a).ino]).toEqual([bStat.dev, bStat.ino]);
  const server = await bootInventoryServer();
  try {
    await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    const all = await listedProjectedEntries(server.port);
    const onlyLinked = await listedProjectedEntries(server.port, 'linked');
    const direct = all.filter((row) => row.kind === 'file' && row.docName === 'real/y.csv');
    expect(direct).toEqual([
      expect.objectContaining({
        path: 'real/y.csv',
        size: bStat.size,
        modified: bStat.mtime.toISOString(),
        isSymlink: true,
        targetPath: 'real/b.csv',
      }),
    ]);
    const representative = direct[0]?.canonicalDocName;
    expect(['real/a.csv', 'real/b.csv']).toContain(representative);
    for (const rows of [all, onlyLinked]) {
      expect(rows.filter((row) => row.kind === 'file' && row.docName === 'linked/a.csv')).toEqual([
        expect.objectContaining({
          path: 'linked/a.csv',
          isSymlink: true,
          canonicalDocName: representative,
          targetPath: 'real/a.csv',
        }),
      ]);
      expect(rows.filter((row) => row.kind === 'file' && row.docName === 'linked/b.csv')).toEqual([
        expect.objectContaining({
          path: 'linked/b.csv',
          isSymlink: true,
          canonicalDocName: representative,
          targetPath: 'real/b.csv',
        }),
      ]);
      expect
        .soft(rows.filter((row) => row.kind === 'file' && row.docName === 'linked/y.csv'))
        .toEqual([
          expect.objectContaining({
            path: 'linked/y.csv',
            size: bStat.size,
            modified: bStat.mtime.toISOString(),
            isSymlink: true,
            canonicalDocName: representative,
            targetPath: 'real/b.csv',
          }),
        ]);
    }
    expect(await inventoryForwardStatuses(server.port)).toMatchObject({
      'linked/y.csv': 'exact',
    });
    expect(lstatSync(y).isSymbolicLink()).toBe(true);
    expect(realpathSync(y)).toBe(b);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(realpathSync(linked)).toBe(real);
    expect(readFileSync(a, 'utf8')).toBe('shared,physical,bytes\n');
    expect(readFileSync(b, 'utf8')).toBe('shared,physical,bytes\n');
    expect(readFileSync(y, 'utf8')).toBe('shared,physical,bytes\n');
    expect(readFileSync(source, 'utf8')).toBe(sourceContent);
    expect(statSync(source).mtimeMs).toBe(sourceStat.mtimeMs);
  } finally {
    await server.destroy();
  }
});

test('a folder alias lists a contained Markdown alias beside its canonical document', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const real = join(contentDir, 'real');
  const other = join(contentDir, 'other');
  mkdirSync(real);
  mkdirSync(other);
  const canonical = writeDoc('other/a.mdx', '# Canonical\n');
  const alias = join(real, 'y.md');
  symlinkSync(canonical, alias);
  const linked = join(contentDir, 'linked');
  symlinkSync(real, linked);
  const sourceContent = '# Source\n\n[Document](linked/y.md)\n';
  const source = writeDoc('source.md', sourceContent);
  const sourceStat = statSync(source);
  const canonicalStat = statSync(canonical);
  const server = await bootInventoryServer();
  try {
    await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    const all = await listedProjectedEntries(server.port);
    const onlyReal = await listedProjectedEntries(server.port, 'real');
    const onlyLinked = await listedProjectedEntries(server.port, 'linked');
    expect(all.filter((row) => row.kind === 'document' && row.docName === 'other/a')).toEqual([
      expect.objectContaining({ docExt: '.mdx', size: canonicalStat.size }),
    ]);
    expect
      .soft(onlyReal.filter((row) => row.kind === 'document').map((row) => row.docName))
      .toEqual(['real/y']);
    expect
      .soft(onlyLinked.filter((row) => row.kind === 'document').map((row) => row.docName))
      .toEqual(['linked/y']);
    expect(all.filter((row) => row.kind === 'document' && row.docName === 'real/y')).toEqual([
      expect.objectContaining({
        docExt: '.mdx',
        size: canonicalStat.size,
        modified: canonicalStat.mtime.toISOString(),
        isSymlink: true,
        canonicalDocName: 'other/a',
        targetPath: 'other/a.mdx',
      }),
    ]);
    expect
      .soft(onlyReal.filter((row) => row.kind === 'document' && row.docName === 'real/y'))
      .toEqual([
        expect.objectContaining({
          docExt: '.mdx',
          canonicalDocName: 'other/a',
          targetPath: 'other/a.mdx',
        }),
      ]);
    for (const rows of [all, onlyLinked]) {
      expect
        .soft(rows.filter((row) => row.kind === 'document' && row.docName === 'linked/y'))
        .toEqual([
          expect.objectContaining({
            docExt: '.mdx',
            size: canonicalStat.size,
            modified: canonicalStat.mtime.toISOString(),
            isSymlink: true,
            canonicalDocName: 'other/a',
            targetPath: 'other/a.mdx',
          }),
        ]);
    }
    const projectedRead = await fetch(
      `http://127.0.0.1:${server.port}/api/document?docName=linked/y`,
    );
    expect.soft(projectedRead.status).toBe(200);
    const projectedBody = (await projectedRead.json()) as { content?: string };
    expect.soft(projectedBody.content).toBe('# Canonical\n');
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(realpathSync(alias)).toBe(canonical);
    expect(realpathSync(linked)).toBe(real);
    expect(readFileSync(canonical, 'utf8')).toBe('# Canonical\n');
    expect(readFileSync(alias, 'utf8')).toBe('# Canonical\n');
    expect(readFileSync(source, 'utf8')).toBe(sourceContent);
    expect(statSync(source).mtimeMs).toBe(sourceStat.mtimeMs);
  } finally {
    await server.destroy();
  }
});

test.each([
  { order: 'canonical-first', delivery: 'notice' },
  { order: 'alias-first', delivery: 'notice' },
  { order: 'canonical-first', delivery: 'ordinary' },
  { order: 'alias-first', delivery: 'ordinary' },
] as const)(
  'same-name Markdown alias lists one document identity with $order scanning and $delivery removal',
  async ({ order, delivery }) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const real = join(contentDir, 'real');
    mkdirSync(real);
    const content = '# One logical page\n';
    const canonical = writeDoc('real/note.mdx', content);
    const alias = join(real, 'note.md');
    symlinkSync(canonical, alias);
    const linked = join(contentDir, 'linked');
    symlinkSync(real, linked);
    const canonicalStat = statSync(canonical);
    scanSchedule.orderedPath = real;
    scanSchedule.orderedEntries =
      order === 'canonical-first' ? ['note.mdx', 'note.md'] : ['note.md', 'note.mdx'];
    const server = await bootInventoryServer();
    const connections: Array<{ disconnect(): Promise<void> }> = [];
    try {
      const held = await server.serverInstance.hocuspocus.openDirectConnection('real/note');
      connections.push(held);
      const document = held.document;
      const lifecycle = document.getMap('lifecycle');
      expect(document.getText('source').toString()).toBe(content);
      expect(lifecycle.get('status')).not.toBe('deleted-upstream');
      const verify = async () => {
        const all = await listedProjectedEntries(server.port);
        const onlyReal = await listedProjectedEntries(server.port, 'real');
        const onlyLinked = await listedProjectedEntries(server.port, 'linked');
        for (const rows of [all, onlyReal]) {
          expect
            .soft(rows.filter((row) => row.kind === 'document' && row.docName === 'real/note'))
            .toEqual([
              expect.objectContaining({
                docExt: '.mdx',
                size: canonicalStat.size,
                modified: canonicalStat.mtime.toISOString(),
                isSymlink: false,
                canonicalDocName: null,
                targetPath: null,
              }),
            ]);
        }
        for (const rows of [all, onlyLinked]) {
          expect
            .soft(rows.filter((row) => row.kind === 'document' && row.docName === 'linked/note'))
            .toEqual([
              expect.objectContaining({
                docExt: '.mdx',
                size: canonicalStat.size,
                modified: canonicalStat.mtime.toISOString(),
                isSymlink: true,
                canonicalDocName: 'real/note',
                targetPath: 'real/note.mdx',
              }),
            ]);
        }
        for (const name of ['real/note', 'linked/note']) {
          const response = await fetch(
            `http://127.0.0.1:${server.port}/api/document?docName=${name}`,
          );
          expect(response.status).toBe(200);
          const body = (await response.json()) as { content?: string };
          expect(body.content).toBe(content);
        }
      };
      await verify();
      await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
      await verify();
      expect(lstatSync(canonical).isFile()).toBe(true);
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(realpathSync(alias)).toBe(canonical);
      expect(realpathSync(linked)).toBe(real);
      expect(readFileSync(canonical, 'utf8')).toBe(content);
      expect(readFileSync(alias, 'utf8')).toBe(content);
      unlinkSync(alias);
      if (delivery === 'notice') {
        await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
      } else {
        await nativeSubscriptionOn(contentDir).deliver([{ type: 'delete', path: alias }]);
      }
      expect.soft(lifecycle.get('status')).not.toBe('deleted-upstream');
      expect
        .soft(server.serverInstance.hocuspocus.documents.get('real/note') === document)
        .toBe(true);
      expect(document.getText('source').toString()).toBe(content);
      expect(readFileSync(canonical, 'utf8')).toBe(content);
      expect(existsSync(alias)).toBe(false);
      await verify();
      unlinkSync(canonical);
      if (delivery === 'notice') {
        await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
      } else {
        await nativeSubscriptionOn(contentDir).deliver([{ type: 'delete', path: canonical }]);
      }
      expect(lifecycle.get('status')).toBe('deleted-upstream');
      expect(server.serverInstance.hocuspocus.documents.has('real/note')).toBe(false);
      expect(
        (await listedProjectedEntries(server.port)).filter((row) => row.kind === 'document'),
      ).toEqual([]);
      const gone = await fetch(`http://127.0.0.1:${server.port}/api/document?docName=real/note`);
      expect(gone.status).toBe(404);
      expect(existsSync(canonical)).toBe(false);
    } finally {
      scanSchedule.orderedPath = null;
      scanSchedule.orderedEntries = null;
      for (const connection of connections) await connection.disconnect();
      await server.destroy();
    }
  },
);

test.each(['canonical-first', 'alias-first'] as const)(
  'folder aliases preserve document suffixes with $0 scanning',
  async (order) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const real = join(contentDir, 'real.md');
    mkdirSync(real);
    const bytes = 'directory,member\n';
    const file = writeDoc('real.md/data.csv', bytes);
    const aliases = ['linked.mdx', 'mirror.md'];
    for (const alias of aliases) symlinkSync(real, join(contentDir, alias));
    writeDoc(
      'source.md',
      '# Source\n\n[Data](linked.mdx/data.csv)\n\n[Mirror](mirror.md/data.csv)\n',
    );
    scanSchedule.orderedPath = contentDir;
    scanSchedule.orderedEntries =
      order === 'canonical-first'
        ? ['real.md', 'linked.mdx', 'mirror.md', 'source.md']
        : ['mirror.md', 'linked.mdx', 'real.md', 'source.md'];
    const server = await bootInventoryServer();
    try {
      await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
      const all = await listedProjectedEntries(server.port);
      expect(all.filter((row) => row.kind === 'folder' && row.path === 'real.md')).toHaveLength(1);
      for (const alias of aliases) {
        const scoped = await listedProjectedEntries(server.port, alias);
        for (const rows of [all, scoped]) {
          expect
            .soft(rows.filter((row) => row.kind === 'folder' && row.path === alias))
            .toEqual([expect.objectContaining({ isSymlink: true, targetPath: 'real.md' })]);
          expect
            .soft(rows.filter((row) => row.kind === 'file' && row.path === `${alias}/data.csv`))
            .toEqual([
              expect.objectContaining({ isSymlink: true, targetPath: 'real.md/data.csv' }),
            ]);
        }
      }
      expect.soft(await inventoryForwardStatuses(server.port)).toMatchObject({
        'linked.mdx/data.csv': 'exact',
        'mirror.md/data.csv': 'exact',
      });
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/asset-text?path=${encodeURIComponent('real.md/data.csv')}`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(bytes);
      expect(lstatSync(real).isDirectory()).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(bytes);
      for (const alias of aliases) {
        const linked = join(contentDir, alias);
        expect(lstatSync(linked).isSymbolicLink()).toBe(true);
        expect(realpathSync(linked)).toBe(real);
        expect(readFileSync(join(linked, 'data.csv'), 'utf8')).toBe(bytes);
      }
    } finally {
      scanSchedule.orderedPath = null;
      scanSchedule.orderedEntries = null;
      await server.destroy();
    }
  },
);

test.each(['notice', 'ordinary'] as const)(
  '$0 removal of a document-suffixed folder recovers only its actual file deletions',
  async (delivery) => {
    const folder = join(contentDir, 'notes.md');
    mkdirSync(folder);
    const assetFolder = join(contentDir, 'images.png');
    mkdirSync(assetFolder);
    const asset = writeDoc('gone.png', 'asset bytes\n');
    const survivor = writeDoc('notes.mdx', '# Surviving page\n');
    const child = writeDoc('notes.md/child.md', '# Removed child\n');
    const data = writeDoc('notes.md/data.csv', 'removed,child\n');
    const gone = writeDoc('gone.md', '# Removed page\n');
    const events: DiskEvent[] = [];
    const watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      { forceBackend: 'parcel', platform: 'darwin' },
    );
    handles.push(watcher);
    expect(watcher.getFolderIndex().has('notes.md')).toBe(true);
    expect(watcher.getFolderIndex().has('images.png')).toBe(true);
    expect(indexedFileTargets(watcher)).toContain('gone.png');
    expect(watcher.getFileIndex().get('notes')?.canonicalPath).toBe(survivor);
    expect(watcher.getFileIndex().has('notes.md/child')).toBe(true);
    expect(watcher.getFileIndex().has('gone')).toBe(true);
    expect(getDocExtension('notes')).toBe('.mdx');
    rmSync(folder, { recursive: true });
    rmSync(assetFolder, { recursive: true });
    unlinkSync(gone);
    unlinkSync(asset);
    if (delivery === 'notice') {
      await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    } else {
      await nativeSubscriptionOn(contentDir).deliver([
        { type: 'delete', path: folder },
        { type: 'delete', path: assetFolder },
        { type: 'delete', path: gone },
        { type: 'delete', path: asset },
      ]);
    }
    expect(events).toContainEqual({
      kind: 'folder-delete',
      path: folder,
      relativePath: 'notes.md',
    });
    expect(events).toContainEqual({
      kind: 'folder-delete',
      path: assetFolder,
      relativePath: 'images.png',
    });
    expect(events).toContainEqual({ kind: 'asset-delete', path: asset, relativePath: 'gone.png' });
    expect(events).toContainEqual({ kind: 'file-delete', path: asset, relativePath: 'gone.png' });
    expect
      .soft(
        events.filter(
          (event) =>
            'path' in event &&
            event.path === assetFolder &&
            (event.kind === 'asset-delete' || event.kind === 'file-delete'),
        ),
      )
      .toEqual([]);
    expect(events).toContainEqual({ kind: 'delete', path: child, docName: 'notes.md/child' });
    expect(events).toContainEqual({ kind: 'delete', path: gone, docName: 'gone' });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'file-delete',
        path: data,
        relativePath: 'notes.md/data.csv',
      }),
    );
    expect
      .soft(events.filter((event) => 'docName' in event && event.docName === 'notes'))
      .toEqual([]);
    expect.soft(getDocExtension('notes')).toBe('.mdx');
    expect(watcher.getFolderIndex().has('notes.md')).toBe(false);
    expect(watcher.getFolderIndex().has('images.png')).toBe(false);
    expect(indexedFileTargets(watcher)).not.toContain('gone.png');
    expect.soft(watcher.getFileIndex().get('notes')?.canonicalPath).toBe(survivor);
    expect(watcher.getFileIndex().has('notes.md/child')).toBe(false);
    expect(watcher.getFileIndex().has('gone')).toBe(false);
    expect(readFileSync(survivor, 'utf8')).toBe('# Surviving page\n');
    events.length = 0;
    await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    expect(events).toEqual([]);
  },
);

test.each([
  { folderExt: '.md', docExt: '.mdx' },
  { folderExt: '.mdx', docExt: '.md' },
] as const)(
  'removing a $folderExt folder keeps its same-stem $docExt page loaded',
  async ({ folderExt, docExt }) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const folderName = `notes${folderExt}`;
    const folder = join(contentDir, folderName);
    mkdirSync(folder);
    const content = '# Still here\n\nSurviving document bytes.\n';
    const survivor = writeDoc(`notes${docExt}`, content);
    const gone = writeDoc('gone.md', '# Really removed\n');
    const server = await bootInventoryServer();
    const connections: Array<{ disconnect(): Promise<void> }> = [];
    try {
      expect(getDocExtension('notes')).toBe(docExt);
      const held = await server.serverInstance.hocuspocus.openDirectConnection('notes');
      connections.push(held);
      const removed = await server.serverInstance.hocuspocus.openDirectConnection('gone');
      connections.push(removed);
      const document = held.document;
      const lifecycle = document.getMap('lifecycle');
      const removedLifecycle = removed.document.getMap('lifecycle');
      expect(document.getText('source').toString()).toBe(content);
      expect(server.serverInstance.hocuspocus.documents.get('notes')).toBe(document);
      expect(lifecycle.get('status')).not.toBe('deleted-upstream');
      expect(removed.document.getText('source').toString()).toBe('# Really removed\n');
      const before = await listedProjectedEntries(server.port);
      expect(before.filter((row) => row.kind === 'folder' && row.path === folderName)).toHaveLength(
        1,
      );
      expect(
        before.filter((row) => row.kind === 'document' && row.docName === 'notes'),
      ).toHaveLength(1);
      rmSync(folder, { recursive: true });
      unlinkSync(gone);
      await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
      expect.soft(lifecycle.get('status')).not.toBe('deleted-upstream');
      expect.soft(server.serverInstance.hocuspocus.documents.get('notes') === document).toBe(true);
      expect.soft(getDocExtension('notes')).toBe(docExt);
      expect.soft(document.getText('source').toString()).toBe(content);
      expect(removedLifecycle.get('status')).toBe('deleted-upstream');
      const after = await listedProjectedEntries(server.port);
      expect(after.filter((row) => row.kind === 'folder' && row.path === folderName)).toEqual([]);
      expect(after.filter((row) => row.kind === 'document' && row.docName === 'gone')).toEqual([]);
      expect
        .soft(after.filter((row) => row.kind === 'document' && row.docName === 'notes'))
        .toEqual([expect.objectContaining({ docExt, isSymlink: false, targetPath: null })]);
      const response = await fetch(`http://127.0.0.1:${server.port}/api/document?docName=notes`);
      expect.soft(response.status).toBe(200);
      const body = (await response.json()) as { content?: string };
      expect.soft(body.content).toBe(content);
      expect(readFileSync(survivor, 'utf8')).toBe(content);
      expect(existsSync(gone)).toBe(false);
      expect(existsSync(folder)).toBe(false);
    } finally {
      for (const connection of connections) await connection.disconnect();
      await server.destroy();
    }
  },
);

test.each(['folder to file', 'file to folder'] as const)(
  'notice recovery preserves the actual kinds during a $0 transition',
  async (transition) => {
    const path = join(contentDir, 'entry.md');
    const content = '# Actual page\n';
    if (transition === 'folder to file') mkdirSync(path);
    else writeFileSync(path, content);
    const events: DiskEvent[] = [];
    const watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      { forceBackend: 'parcel', platform: 'darwin' },
    );
    handles.push(watcher);
    expect(watcher.getFolderIndex().has('entry.md')).toBe(transition === 'folder to file');
    expect(watcher.getFileIndex().has('entry')).toBe(transition === 'file to folder');
    rmSync(path, { recursive: true });
    if (transition === 'folder to file') writeFileSync(path, content);
    else mkdirSync(path);
    await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    if (transition === 'folder to file') {
      expect(events).toContainEqual({ kind: 'folder-delete', path, relativePath: 'entry.md' });
      expect(events).toContainEqual({ kind: 'create', path, docName: 'entry', content });
      expect.soft(events.filter((event) => event.kind === 'delete')).toEqual([]);
      expect(watcher.getFileIndex().get('entry')?.canonicalPath).toBe(path);
      expect(watcher.getFolderIndex().has('entry.md')).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(content);
    } else {
      expect(events).toContainEqual({ kind: 'delete', path, docName: 'entry' });
      expect(events).toContainEqual({ kind: 'folder-create', path, relativePath: 'entry.md' });
      expect(events.filter((event) => event.kind === 'create')).toEqual([]);
      expect(watcher.getFileIndex().has('entry')).toBe(false);
      expect(watcher.getFolderIndex().has('entry.md')).toBe(true);
      expect(lstatSync(path).isDirectory()).toBe(true);
    }
  },
);

test.each([
  { state: 'retained', delivery: 'notice' },
  { state: 'deleted', delivery: 'notice' },
  { state: 'deleted', delivery: 'ordinary' },
] as const)(
  'a $delivery batch preserves a public file replacement that is $state',
  async ({ state, delivery }) => {
    const path = join(contentDir, 'public.md');
    mkdirSync(path);
    const events: DiskEvent[] = [];
    const watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      { forceBackend: 'parcel', platform: 'darwin' },
    );
    handles.push(watcher);
    expect(watcher.getFolderIndex().has('public.md')).toBe(true);
    rmSync(path, { recursive: true });
    const content = '# Public replacement\n';
    writeFileSync(path, content);
    registerWrite(path, contentHash(content));
    watcher.mutateFileIndex({ kind: 'create', path, docName: 'public', content });
    expect(watcher.getFileIndex().get('public')?.canonicalPath).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(content);
    if (state === 'deleted') unlinkSync(path);
    if (delivery === 'notice') {
      await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    } else {
      await nativeSubscriptionOn(contentDir).deliver([{ type: 'delete', path }]);
    }
    if (state === 'deleted') {
      expect.soft(events).toContainEqual({ kind: 'delete', path, docName: 'public' });
      expect(watcher.getFileIndex().has('public')).toBe(false);
      expect(existsSync(path)).toBe(false);
    } else {
      expect.soft(events.filter((event) => event.kind === 'delete')).toEqual([]);
      expect(watcher.getFileIndex().get('public')?.canonicalPath).toBe(path);
      expect(readFileSync(path, 'utf8')).toBe(content);
    }
    expect(watcher.getFolderIndex().has('public.md')).toBe(false);
  },
);

test('a notice after index-only reseeding keeps a replacement directory and its children', async () => {
  const path = writeDoc('reseed.md', '# Former document\n');
  const events: DiskEvent[] = [];
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
    },
    undefined,
    { forceBackend: 'parcel', platform: 'darwin' },
  );
  handles.push(watcher);
  expect(watcher.getFileIndex().has('reseed')).toBe(true);
  expect(watcher.getFolderIndex().has('reseed.md')).toBe(false);
  unlinkSync(path);
  mkdirSync(path);
  const child = writeDoc('reseed.md/child.mdx', '# Current child\n');
  const data = writeDoc('reseed.md/data.csv', 'current,child\n');
  await watcher.rescanFromDisk();
  expect(events).toEqual([]);
  expect(watcher.getFileIndex().has('reseed')).toBe(true);
  expect(watcher.getFolderIndex().has('reseed.md')).toBe(true);
  expect(watcher.getFileIndex().get('reseed.md/child')?.canonicalPath).toBe(child);
  expect(indexedFileTargets(watcher)).toContain('reseed.md/data.csv');
  expect(getDocExtension('reseed.md/child')).toBe('.mdx');
  await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  expect(events).toContainEqual({ kind: 'delete', path, docName: 'reseed' });
  expect.soft(events.filter((event) => event.kind === 'folder-delete')).toEqual([]);
  expect
    .soft(
      events.filter((event) => 'path' in event && (event.path === child || event.path === data)),
    )
    .toEqual([]);
  expect(watcher.getFileIndex().has('reseed')).toBe(false);
  expect(watcher.getFolderIndex().has('reseed.md')).toBe(true);
  expect(watcher.getFileIndex().get('reseed.md/child')?.canonicalPath).toBe(child);
  expect(indexedFileTargets(watcher)).toContain('reseed.md/data.csv');
  expect.soft(getDocExtension('reseed.md/child')).toBe('.mdx');
  expect(lstatSync(path).isDirectory()).toBe(true);
  expect(readFileSync(child, 'utf8')).toBe('# Current child\n');
  expect(readFileSync(data, 'utf8')).toBe('current,child\n');
});

test('ordinary deletion removes a nonrepresentative file member that replaced a directory', async () => {
  const path = join(contentDir, 'member.png');
  mkdirSync(path);
  const outside = writeDoc('outside.png', 'shared image bytes');
  const events: DiskEvent[] = [];
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
    },
    undefined,
    { forceBackend: 'parcel', platform: 'darwin' },
  );
  handles.push(watcher);
  rmSync(path, { recursive: true });
  linkSync(outside, path);
  const stat = statSync(path);
  watcher.mutateFileIndex({
    kind: 'file-create',
    path,
    relativePath: 'member.png',
    size: stat.size,
    modifiedTs: stat.mtimeMs,
  });
  const rows = [...watcher.getAllFilesIndex()].filter(([, entry]) => entry.kind === 'file');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.[0]).toBe('outside.png');
  expect(rows[0]?.[1].fileMembers?.regularPaths).toEqual(
    expect.arrayContaining(['member.png', 'outside.png']),
  );
  expect(watcher.getFolderIndex().has('member.png')).toBe(true);
  expect(statSync(outside).ino).toBe(stat.ino);
  unlinkSync(path);
  await nativeSubscriptionOn(contentDir).deliver([{ type: 'delete', path }]);
  expect.soft(events).toContainEqual({ kind: 'file-delete', path, relativePath: 'member.png' });
  expect.soft(events).toContainEqual({ kind: 'asset-delete', path, relativePath: 'member.png' });
  expect(events).toContainEqual({ kind: 'folder-delete', path, relativePath: 'member.png' });
  expect.soft(indexedFileTargets(watcher)).toEqual(['outside.png']);
  expect(watcher.getFolderIndex().has('member.png')).toBe(false);
  expect(events.filter((event) => 'path' in event && event.path === outside)).toEqual([]);
  expect(readFileSync(outside, 'utf8')).toBe('shared image bytes');
  expect(existsSync(path)).toBe(false);
});

test('ordinary deletion removes a physical Markdown alias that replaced a directory', async () => {
  const path = join(contentDir, 'linked.md');
  mkdirSync(path);
  const canonical = writeDoc('canonical.mdx', '# Canonical survives\n');
  const events: DiskEvent[] = [];
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
    },
    undefined,
    { forceBackend: 'parcel', platform: 'darwin' },
  );
  handles.push(watcher);
  rmSync(path, { recursive: true });
  symlinkSync(canonical, path);
  await watcher.rescanFromDisk();
  expect(watcher.getFolderIndex().has('linked.md')).toBe(true);
  expect(watcher.getAliasMap().get('linked')).toBe('canonical');
  expect(realpathSync(path)).toBe(canonical);
  expect(events).toEqual([]);
  unlinkSync(path);
  await nativeSubscriptionOn(contentDir).deliver([{ type: 'delete', path }]);
  expect.soft(events).toContainEqual({ kind: 'delete', path, docName: 'linked' });
  expect(events).toContainEqual({ kind: 'folder-delete', path, relativePath: 'linked.md' });
  expect(watcher.getAliasMap().has('linked')).toBe(false);
  expect(watcher.getFileIndex().get('canonical')?.canonicalPath).toBe(canonical);
  expect(watcher.getFolderIndex().has('linked.md')).toBe(false);
  expect(getDocExtension('canonical')).toBe('.mdx');
  expect(readFileSync(canonical, 'utf8')).toBe('# Canonical survives\n');
});

test('ordinary folder deletion keeps a Markdown alias with the same normalized name', async () => {
  const path = join(contentDir, 'linked.mdx');
  mkdirSync(path);
  const canonical = writeDoc('canonical.md', '# Alias target\n');
  const alias = join(contentDir, 'linked.md');
  symlinkSync(canonical, alias);
  const events: DiskEvent[] = [];
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
    },
    undefined,
    { forceBackend: 'parcel', platform: 'darwin' },
  );
  handles.push(watcher);
  expect(watcher.getFolderIndex().has('linked.mdx')).toBe(true);
  expect(watcher.getAliasMap().get('linked')).toBe('canonical');
  rmSync(path, { recursive: true });
  await nativeSubscriptionOn(contentDir).deliver([{ type: 'delete', path }]);
  expect(events).toContainEqual({ kind: 'folder-delete', path, relativePath: 'linked.mdx' });
  expect.soft(events.filter((event) => event.kind === 'delete')).toEqual([]);
  expect.soft(watcher.getAliasMap().get('linked')).toBe('canonical');
  expect(watcher.getFileIndex().get('canonical')?.canonicalPath).toBe(canonical);
  expect(realpathSync(alias)).toBe(canonical);
  expect(readFileSync(alias, 'utf8')).toBe('# Alias target\n');
  events.length = 0;
  unlinkSync(alias);
  await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  expect.soft(events).toContainEqual({ kind: 'delete', path: alias, docName: 'linked' });
  expect(events.some((event) => 'path' in event && event.path === path)).toBe(false);
  expect(watcher.getAliasMap().has('linked')).toBe(false);
  expect(watcher.getFileIndex().get('canonical')?.canonicalPath).toBe(canonical);
  expect(readFileSync(canonical, 'utf8')).toBe('# Alias target\n');
});

test('legacy raw-event handling retains deletion of a logical alias beside a prior folder row', async () => {
  const path = join(contentDir, 'linked.md');
  mkdirSync(path);
  const canonical = writeDoc('canonical.mdx', '# Legacy target\n');
  const files: Parameters<typeof handleRawEvents>[3] = new Map();
  const folders: Parameters<typeof handleRawEvents>[4] = new Map();
  const aliases = new Map<string, string>();
  const events: DiskEvent[] = [];
  const deliver = (raw: Parameters<typeof handleRawEvents>[0]) =>
    handleRawEvents(
      raw,
      contentDir,
      undefined,
      files,
      folders,
      async (event) => {
        events.push(event);
      },
      aliases,
    );
  await deliver([
    { type: 'create', path },
    { type: 'create', path: canonical },
  ]);
  rmSync(path, { recursive: true });
  symlinkSync(canonical, path);
  await deliver([{ type: 'create', path }]);
  expect(folders.has('linked.md')).toBe(true);
  expect(aliases.get('linked')).toBe('canonical');
  expect(files.get('canonical')?.canonicalPath).toBe(canonical);
  events.length = 0;
  unlinkSync(path);
  await deliver([{ type: 'delete', path }]);
  expect.soft(events).toContainEqual({ kind: 'delete', path, docName: 'linked' });
  expect(events).toContainEqual({ kind: 'folder-delete', path, relativePath: 'linked.md' });
  expect.soft(aliases.has('linked')).toBe(false);
  expect(files.get('canonical')?.canonicalPath).toBe(canonical);
  expect(folders.has('linked.md')).toBe(false);
  expect(readFileSync(canonical, 'utf8')).toBe('# Legacy target\n');
});

test.each([
  { delivery: 'notice', preparation: 'initial scan' },
  { delivery: 'ordinary', preparation: 'initial scan' },
  { delivery: 'notice', preparation: 'canonical update' },
  { delivery: 'ordinary', preparation: 'canonical update' },
] as const)(
  '$delivery removal retires only same-name Markdown alias membership after $preparation',
  async ({ delivery, preparation }) => {
    let content = '# Membership target\n';
    const canonical = writeDoc('member.mdx', content);
    const alias = join(contentDir, 'member.md');
    symlinkSync(canonical, alias);
    const events: DiskEvent[] = [];
    const watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      { forceBackend: 'parcel', platform: 'darwin' },
    );
    handles.push(watcher);
    expect(watcher.getFileIndex().get('member')?.canonicalPath).toBe(canonical);
    expect(watcher.getFileIndex().get('member')?.aliases).toContain('member');
    expect(watcher.getAliasMap().get('member')).toBe('member');
    expect(lastKnownHash.get(canonical)).toBe(contentHash(content));
    expect(getDocExtension('member')).toBe('.mdx');
    await nativeSubscriptionOn(contentDir).deliver([{ type: 'update', path: alias }]);
    expect(lastKnownHash.get(alias)).toBe(contentHash(content));
    events.length = 0;
    if (preparation === 'canonical update') {
      content = '# Updated membership target\n';
      writeFileSync(canonical, content);
      await nativeSubscriptionOn(contentDir).deliver([{ type: 'update', path: canonical }]);
      expect(events).toContainEqual({
        kind: 'update',
        path: canonical,
        docName: 'member',
        content,
        previousIndexedFields: expect.any(Object),
      });
      expect.soft(watcher.getAliasMap().get('member')).toBe('member');
      expect(watcher.getFileIndex().get('member')?.aliases).toContain('member');
      events.length = 0;
    }
    const deliverDelete = async (path: string) => {
      if (delivery === 'notice') {
        await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
      } else {
        const deletion = { type: 'delete' as const, path };
        await nativeSubscriptionOn(contentDir).deliver(
          path === alias ? [deletion, { ...deletion }] : [deletion],
        );
      }
    };
    unlinkSync(alias);
    await deliverDelete(alias);
    expect.soft(events.filter((event) => event.kind === 'delete')).toEqual([]);
    expect.soft(watcher.getFileIndex().get('member')?.canonicalPath).toBe(canonical);
    expect.soft(watcher.getFileIndex().get('member')?.aliases).toEqual([]);
    expect.soft(watcher.getAliasMap().has('member')).toBe(false);
    expect.soft(lastKnownHash.get(canonical)).toBe(contentHash(content));
    expect.soft(lastKnownHash.has(alias)).toBe(false);
    expect.soft(getDocExtension('member')).toBe('.mdx');
    expect(readFileSync(canonical, 'utf8')).toBe(content);
    events.length = 0;
    unlinkSync(canonical);
    await deliverDelete(canonical);
    expect.soft(events).toContainEqual({ kind: 'delete', path: canonical, docName: 'member' });
    expect(watcher.getFileIndex().has('member')).toBe(false);
    expect(lastKnownHash.has(canonical)).toBe(false);
    expect(existsSync(canonical)).toBe(false);
  },
);

test('ordinary replacement of a Markdown alias admits the new regular document', async () => {
  const canonical = writeDoc('canonical.mdx', '# Original target\n');
  const alias = join(contentDir, 'linked.md');
  symlinkSync(canonical, alias);
  const events: DiskEvent[] = [];
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
    },
    undefined,
    { forceBackend: 'parcel', platform: 'darwin' },
  );
  handles.push(watcher);
  expect(watcher.getAliasMap().get('linked')).toBe('canonical');
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  unlinkSync(alias);
  const content = '# New regular document\n';
  writeFileSync(alias, content);
  await nativeSubscriptionOn(contentDir).deliver([{ type: 'update', path: alias }]);
  expect(events).toContainEqual({ kind: 'update', path: alias, docName: 'linked', content });
  expect(watcher.getAliasMap().has('linked')).toBe(false);
  expect(watcher.getFileIndex().get('linked')?.canonicalPath).toBe(alias);
  expect(watcher.getFileIndex().get('canonical')?.canonicalPath).toBe(canonical);
  expect(lstatSync(alias).isFile()).toBe(true);
  expect(readFileSync(alias, 'utf8')).toBe(content);
  expect(readFileSync(canonical, 'utf8')).toBe('# Original target\n');
  events.length = 0;
  await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
  expect(events.filter((event) => event.kind === 'delete')).toEqual([]);
  expect(watcher.getFileIndex().get('linked')?.canonicalPath).toBe(alias);
  expect(watcher.getFileIndex().get('canonical')?.aliases).toEqual([]);
});

test.each([
  { intake: 'create', delivery: 'ordinary' },
  { intake: 'create', delivery: 'notice batch' },
  { intake: 'retarget', delivery: 'ordinary' },
  { intake: 'retarget', delivery: 'notice batch' },
] as const)(
  'same-name alias $intake after startup preserves its target on $delivery removal',
  async ({ intake, delivery }) => {
    const content = '# Canonical stays\n';
    const canonical = writeDoc('member.mdx', content);
    const other = writeDoc('other.mdx', '# Other stays\n');
    const alias = join(contentDir, 'member.md');
    const events: DiskEvent[] = [];
    const watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      { forceBackend: 'parcel', platform: 'darwin' },
    );
    handles.push(watcher);
    expect(watcher.getAliasMap().has('member')).toBe(false);
    if (intake === 'retarget') {
      symlinkSync(other, alias);
      await nativeSubscriptionOn(contentDir).deliver([{ type: 'create', path: alias }]);
      expect(watcher.getAliasMap().get('member')).toBe('other');
      unlinkSync(alias);
    }
    symlinkSync(canonical, alias);
    await nativeSubscriptionOn(contentDir).deliver([
      { type: intake === 'create' ? 'create' : 'update', path: alias },
    ]);
    expect.soft(watcher.getAliasMap().get('member')).toBe('member');
    expect(watcher.getFileIndex().get('member')?.canonicalPath).toBe(canonical);
    expect(realpathSync(alias)).toBe(canonical);
    expect(lastKnownHash.get(alias)).toBe(contentHash(content));
    events.length = 0;
    unlinkSync(alias);
    const batch: Event[] = [{ type: 'delete', path: alias }];
    if (delivery === 'notice batch') {
      await nativeSubscriptionOn(contentDir).deliver(batch, new Error(notices[0]));
    } else {
      await nativeSubscriptionOn(contentDir).deliver(batch);
    }
    expect.soft(events.filter((event) => event.kind === 'delete')).toEqual([]);
    expect.soft(watcher.getFileIndex().get('member')?.canonicalPath).toBe(canonical);
    expect.soft(getDocExtension('member')).toBe('.mdx');
    expect.soft(lastKnownHash.get(canonical)).toBe(contentHash(content));
    expect(lastKnownHash.has(alias)).toBe(false);
    expect(watcher.getAliasMap().has('member')).toBe(false);
    expect(watcher.getFileIndex().get('other')?.canonicalPath).toBe(other);
    expect(readFileSync(canonical, 'utf8')).toBe(content);
    expect(readFileSync(other, 'utf8')).toBe('# Other stays\n');
  },
);

test.each(['ordinary', 'notice batch'] as const)(
  'a same-name alias added to a running server leaves its canonical page loaded after $0 removal',
  async (delivery) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const content = '# Canonical page\n';
    const canonical = writeDoc('member.mdx', content);
    const alias = join(contentDir, 'member.md');
    const server = await bootInventoryServer();
    const connections: Array<{ disconnect(): Promise<void> }> = [];
    try {
      const held = await server.serverInstance.hocuspocus.openDirectConnection('member');
      connections.push(held);
      const document = held.document;
      const lifecycle = document.getMap('lifecycle');
      expect(document.getText('source').toString()).toBe(content);
      symlinkSync(canonical, alias);
      await nativeSubscriptionOn(contentDir).deliver([{ type: 'create', path: alias }]);
      expect(realpathSync(alias)).toBe(canonical);
      expect(server.serverInstance.hocuspocus.documents.get('member')).toBe(document);
      unlinkSync(alias);
      const batch: Event[] = [{ type: 'delete', path: alias }];
      await nativeSubscriptionOn(contentDir).deliver(
        batch,
        delivery === 'notice batch' ? new Error(notices[0]) : undefined,
      );
      expect.soft(lifecycle.get('status')).not.toBe('deleted-upstream');
      expect.soft(server.serverInstance.hocuspocus.documents.get('member') === document).toBe(true);
      expect.soft(getDocExtension('member')).toBe('.mdx');
      expect(document.getText('source').toString()).toBe(content);
      expect(readFileSync(canonical, 'utf8')).toBe(content);
      const rows = await listedProjectedEntries(server.port);
      expect
        .soft(rows.filter((row) => row.kind === 'document' && row.docName === 'member'))
        .toEqual([expect.objectContaining({ docExt: '.mdx', isSymlink: false })]);
      const response = await fetch(`http://127.0.0.1:${server.port}/api/document?docName=member`);
      expect.soft(response.status).toBe(200);
      const body = (await response.json()) as { content?: string };
      expect.soft(body.content).toBe(content);
    } finally {
      for (const connection of connections) await connection.disconnect();
      await server.destroy();
    }
  },
);

test.each(['alias', 'directory'] as const)(
  'a notice retains the canonical page when a removed same-name $0 was never observed',
  async (kind) => {
    const content = '# Always present\n';
    const canonical = writeDoc('member.mdx', content);
    const transient = join(contentDir, 'member.md');
    const events: DiskEvent[] = [];
    const watcher = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      { forceBackend: 'parcel', platform: 'darwin' },
    );
    handles.push(watcher);
    expect(watcher.getFileIndex().get('member')?.canonicalPath).toBe(canonical);
    expect(watcher.getAliasMap().has('member')).toBe(false);
    expect(watcher.getFolderIndex().has('member.md')).toBe(false);
    const identity = statSync(canonical).ino;
    if (kind === 'alias') {
      symlinkSync(canonical, transient);
      expect(realpathSync(transient)).toBe(canonical);
      unlinkSync(transient);
    } else {
      mkdirSync(transient);
      expect(lstatSync(transient).isDirectory()).toBe(true);
      rmSync(transient, { recursive: true });
    }
    const untracked = writeDoc('untracked.md', '# Actual removed page\n');
    unlinkSync(untracked);
    const recovered = writeDoc('recovered.md', '# Omitted create\n');
    await nativeSubscriptionOn(contentDir).deliver(
      [
        { type: 'delete', path: transient },
        { type: 'delete', path: untracked },
      ],
      new Error(notices[0]),
    );
    expect
      .soft(events.filter((event) => 'docName' in event && event.docName === 'member'))
      .toEqual([]);
    expect(events).toContainEqual({
      kind: 'create',
      path: recovered,
      docName: 'recovered',
      content: '# Omitted create\n',
    });
    expect(events).toContainEqual({ kind: 'delete', path: untracked, docName: 'untracked' });
    expect(watcher.getFileIndex().get('member')?.canonicalPath).toBe(canonical);
    expect(watcher.getFileIndex().has('recovered')).toBe(true);
    expect(getDocExtension('member')).toBe('.mdx');
    expect(lastKnownHash.get(canonical)).toBe(contentHash(content));
    expect(statSync(canonical).ino).toBe(identity);
    expect(readFileSync(canonical, 'utf8')).toBe(content);
    expect(existsSync(transient)).toBe(false);
    events.length = 0;
    unlinkSync(canonical);
    await nativeSubscriptionOn(contentDir).deliver([], new Error(notices[0]));
    expect(events).toContainEqual({ kind: 'delete', path: canonical, docName: 'member' });
    expect(watcher.getFileIndex().has('member')).toBe(false);
  },
);

test('a notice retains a live alias when a same-name directory was never observed', async () => {
  const content = '# Aliased target\n';
  const canonical = writeDoc('target.mdx', content);
  const alias = join(contentDir, 'member.md');
  symlinkSync(canonical, alias);
  const transient = join(contentDir, 'member.mdx');
  const events: DiskEvent[] = [];
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
    },
    undefined,
    { forceBackend: 'parcel', platform: 'darwin' },
  );
  handles.push(watcher);
  expect(watcher.getAliasMap().get('member')).toBe('target');
  expect(watcher.getFolderIndex().has('member.mdx')).toBe(false);
  mkdirSync(transient);
  expect(lstatSync(transient).isDirectory()).toBe(true);
  rmSync(transient, { recursive: true });
  await nativeSubscriptionOn(contentDir).deliver(
    [{ type: 'delete', path: transient }],
    new Error(notices[0]),
  );
  expect.soft(events.filter((event) => event.kind === 'delete')).toEqual([]);
  expect(watcher.getAliasMap().get('member')).toBe('target');
  expect(watcher.getFileIndex().get('target')?.canonicalPath).toBe(canonical);
  expect(watcher.getFileIndex().get('target')?.aliases).toContain('member');
  expect(realpathSync(alias)).toBe(canonical);
  expect(readFileSync(alias, 'utf8')).toBe(content);
  events.length = 0;
  unlinkSync(alias);
  await nativeSubscriptionOn(contentDir).deliver(
    [{ type: 'delete', path: alias }],
    new Error(notices[0]),
  );
  expect(events).toContainEqual({ kind: 'delete', path: alias, docName: 'member' });
  expect(watcher.getAliasMap().has('member')).toBe(false);
  expect(watcher.getFileIndex().get('target')?.canonicalPath).toBe(canonical);
  expect(readFileSync(canonical, 'utf8')).toBe(content);
});

test('a stale physical deletion cannot rename the current same-name page', async () => {
  const oldContent = '# Former spelling\n';
  const currentContent = '# Current spelling\n';
  const former = writeDoc('member.md', oldContent);
  const { watcher, events } = await watchContent();
  const canonical = join(contentDir, 'member.mdx');
  renameSync(former, canonical);
  watcher.mutateFileIndex({
    kind: 'rename',
    oldPath: former,
    newPath: canonical,
    oldDocName: 'member',
    newDocName: 'member',
    content: oldContent,
  });
  writeFileSync(canonical, currentContent);
  await nativeSubscriptionOn(contentDir).deliver([{ type: 'update', path: canonical }]);
  expect(watcher.getFileIndex().get('member')?.canonicalPath).toBe(canonical);
  expect(lastKnownHash.get(former)).toBe(contentHash(oldContent));
  expect(lastKnownHash.get(canonical)).toBe(contentHash(currentContent));
  const identity = statSync(canonical).ino;
  const created = writeDoc('new-page.md', oldContent);
  events.length = 0;
  await nativeSubscriptionOn(contentDir).deliver([
    { type: 'delete', path: former },
    { type: 'create', path: created },
  ]);
  expect
    .soft(events)
    .toEqual([{ kind: 'create', path: created, docName: 'new-page', content: oldContent }]);
  expect.soft(lastKnownHash.has(former)).toBe(false);
  expect.soft(lastKnownHash.get(canonical)).toBe(contentHash(currentContent));
  expect.soft(watcher.getFileIndex().get('member')?.canonicalPath).toBe(canonical);
  expect.soft(watcher.getFileIndex().get('new-page')?.canonicalPath).toBe(created);
  expect.soft(getDocExtension('member')).toBe('.mdx');
  expect(statSync(canonical).ino).toBe(identity);
  expect(readFileSync(canonical, 'utf8')).toBe(currentContent);
  expect(existsSync(former)).toBe(false);
});

test.each([
  { intake: 'alias-first', delivery: 'ordinary', preparation: 'initial' },
  { intake: 'canonical-first', delivery: 'ordinary', preparation: 'initial' },
  { intake: 'live', delivery: 'ordinary', preparation: 'initial' },
  { intake: 'alias-first', delivery: 'notice batch', preparation: 'initial' },
  { intake: 'canonical-first', delivery: 'notice batch', preparation: 'initial' },
  { intake: 'live', delivery: 'notice batch', preparation: 'initial' },
  { intake: 'alias-first', delivery: 'ordinary', preparation: 'canonical update' },
  { intake: 'live', delivery: 'notice batch', preparation: 'canonical update' },
] as const)(
  'removing an alias to another page preserves its same-name canonical document after $intake intake, $preparation and $delivery',
  async ({ intake, delivery, preparation }) => {
    let memberContent = '# Separate canonical page\n';
    const targetContent = '# Alias target page\n';
    const canonical = writeDoc('member.mdx', memberContent);
    const target = writeDoc('other.mdx', targetContent);
    const alias = join(contentDir, 'member.md');
    if (intake !== 'live') {
      symlinkSync(target, alias);
      scanSchedule.orderedPath = contentDir;
      scanSchedule.orderedEntries =
        intake === 'alias-first'
          ? ['member.md', 'member.mdx', 'other.mdx']
          : ['member.mdx', 'other.mdx', 'member.md'];
    }
    const { watcher, events } = await watchContent();
    if (intake === 'live') {
      symlinkSync(target, alias);
      await nativeSubscriptionOn(contentDir).deliver([{ type: 'create', path: alias }]);
    }
    await nativeSubscriptionOn(contentDir).deliver([{ type: 'update', path: alias }]);
    expect(watcher.getAliasMap().get('member')).toBe('other');
    expect(watcher.getFileIndex().get('member')?.canonicalPath).toBe(canonical);
    expect(watcher.getFileIndex().get('other')?.canonicalPath).toBe(target);
    expect(lastKnownHash.get(alias)).toBe(contentHash(targetContent));
    expect(realpathSync(alias)).toBe(target);
    if (preparation === 'canonical update') {
      memberContent = '# Updated separate canonical page\n';
      writeFileSync(canonical, memberContent);
      await nativeSubscriptionOn(contentDir).deliver([{ type: 'update', path: canonical }]);
      expect.soft(watcher.getAliasMap().get('member')).toBe('other');
      expect(watcher.getFileIndex().get('member')?.canonicalPath).toBe(canonical);
      expect(lastKnownHash.get(canonical)).toBe(contentHash(memberContent));
      expect(realpathSync(alias)).toBe(target);
    }
    const memberInode = statSync(canonical).ino;
    const targetInode = statSync(target).ino;
    events.length = 0;
    unlinkSync(alias);
    await nativeSubscriptionOn(contentDir).deliver(
      [
        { type: 'delete', path: alias },
        { type: 'delete', path: alias },
      ],
      delivery === 'notice batch' ? new Error(notices[0]) : undefined,
    );
    expect
      .soft(events.filter((event) => event.kind === 'delete' || event.kind === 'rename'))
      .toEqual([]);
    expect.soft(watcher.getFileIndex().get('member')?.canonicalPath).toBe(canonical);
    expect.soft(watcher.getFileIndex().get('other')?.canonicalPath).toBe(target);
    expect.soft(watcher.getFileIndex().get('other')?.aliases).not.toContain('member');
    expect.soft(watcher.getAliasMap().has('member')).toBe(false);
    expect.soft(lastKnownHash.has(alias)).toBe(false);
    expect.soft(lastKnownHash.get(canonical)).toBe(contentHash(memberContent));
    expect.soft(lastKnownHash.get(target)).toBe(contentHash(targetContent));
    expect.soft(getDocExtension('member')).toBe('.mdx');
    expect(statSync(canonical).ino).toBe(memberInode);
    expect(statSync(target).ino).toBe(targetInode);
    expect(readFileSync(canonical, 'utf8')).toBe(memberContent);
    expect(readFileSync(target, 'utf8')).toBe(targetContent);
    events.length = 0;
    unlinkSync(canonical);
    await nativeSubscriptionOn(contentDir).deliver([{ type: 'delete', path: canonical }]);
    expect(events).toContainEqual({ kind: 'delete', path: canonical, docName: 'member' });
    expect(watcher.getFileIndex().has('member')).toBe(false);
    expect(watcher.getFileIndex().get('other')?.canonicalPath).toBe(target);
    events.length = 0;
    unlinkSync(target);
    await nativeSubscriptionOn(contentDir).deliver([{ type: 'delete', path: target }]);
    expect(events).toContainEqual({ kind: 'delete', path: target, docName: 'other' });
    expect(watcher.getFileIndex().has('other')).toBe(false);
  },
);

test.each(['ordinary', 'notice batch'] as const)(
  'removing an alias to another loaded page preserves both real documents through $0 delivery',
  async (delivery) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const canonical = writeDoc('member.mdx', '# Separate canonical page\n');
    const target = writeDoc('other.mdx', '# Alias target page\n');
    const alias = join(contentDir, 'member.md');
    const server = await bootInventoryServer();
    const connections: Array<{ disconnect(): Promise<void> }> = [];
    try {
      const member = await server.serverInstance.hocuspocus.openDirectConnection('member');
      connections.push(member);
      const other = await server.serverInstance.hocuspocus.openDirectConnection('other');
      connections.push(other);
      symlinkSync(target, alias);
      await nativeSubscriptionOn(contentDir).deliver([{ type: 'create', path: alias }]);
      expect(realpathSync(alias)).toBe(target);
      unlinkSync(alias);
      await nativeSubscriptionOn(contentDir).deliver(
        [{ type: 'delete', path: alias }],
        delivery === 'notice batch' ? new Error(notices[0]) : undefined,
      );
      for (const [name, held, path] of [
        ['member', member, canonical],
        ['other', other, target],
      ] as const) {
        expect.soft(held.document.getMap('lifecycle').get('status')).not.toBe('deleted-upstream');
        expect
          .soft(server.serverInstance.hocuspocus.documents.get(name) === held.document)
          .toBe(true);
        expect.soft(held.document.getText('source').toString()).toBe(readFileSync(path, 'utf8'));
      }
      const rows = await listedProjectedEntries(server.port);
      for (const [name, path] of [
        ['member', canonical],
        ['other', target],
      ] as const) {
        expect
          .soft(rows.filter((row) => row.kind === 'document' && row.docName === name))
          .toHaveLength(1);
        const response = await fetch(
          `http://127.0.0.1:${server.port}/api/document?docName=${name}`,
        );
        expect.soft(response.status).toBe(200);
        const body = (await response.json()) as { content?: string };
        expect.soft(body.content).toBe(readFileSync(path, 'utf8'));
      }
    } finally {
      for (const connection of connections) await connection.disconnect();
      await server.destroy();
    }
  },
);

test('alias retirement preserves its namesake after the recorded target was already removed', async () => {
  const content = '# Remaining namesake\n';
  const canonical = writeDoc('member.mdx', content);
  const target = writeDoc('other.mdx', '# Removed target\n');
  const alias = join(contentDir, 'member.md');
  symlinkSync(target, alias);
  const { watcher, events } = await watchContent();
  await nativeSubscriptionOn(contentDir).deliver([{ type: 'update', path: alias }]);
  unlinkSync(target);
  await nativeSubscriptionOn(contentDir).deliver([{ type: 'delete', path: target }]);
  expect(events).toContainEqual({ kind: 'delete', path: target, docName: 'other' });
  expect(watcher.getFileIndex().has('other')).toBe(false);
  expect(watcher.getFileIndex().get('member')?.canonicalPath).toBe(canonical);
  expect(watcher.getAliasMap().get('member')).toBe('other');
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  expect(lastKnownHash.has(alias)).toBe(true);
  events.length = 0;
  unlinkSync(alias);
  await nativeSubscriptionOn(contentDir).deliver([{ type: 'delete', path: alias }]);
  expect.soft(events).toEqual([]);
  expect.soft(watcher.getFileIndex().get('member')?.canonicalPath).toBe(canonical);
  expect.soft(watcher.getFileIndex().has('other')).toBe(false);
  expect.soft(watcher.getAliasMap().has('member')).toBe(false);
  expect.soft(lastKnownHash.has(alias)).toBe(false);
  expect.soft(lastKnownHash.has(target)).toBe(false);
  expect.soft(lastKnownHash.get(canonical)).toBe(contentHash(content));
  expect.soft(getDocExtension('member')).toBe('.mdx');
  expect(readFileSync(canonical, 'utf8')).toBe(content);
  events.length = 0;
  unlinkSync(canonical);
  await nativeSubscriptionOn(contentDir).deliver([{ type: 'delete', path: canonical }]);
  expect(events).toContainEqual({ kind: 'delete', path: canonical, docName: 'member' });
  expect(watcher.getFileIndex().has('member')).toBe(false);
});

function generalEntries(watcher: WatcherHandle) {
  return new Map([...watcher.getAllFilesIndex()].filter(([, entry]) => entry.kind === 'file'));
}

async function watchSeparateGeneralGroups() {
  writeDoc('pair-1.csv', 'pair\n');
  linkSync(join(contentDir, 'pair-1.csv'), join(contentDir, 'pair-2.csv'));
  writeDoc('shared.csv', 'shared\n');
  symlinkSync(join(contentDir, 'shared.csv'), join(contentDir, 'shared-link.csv'));
  writeDoc('solo.csv', 'solo\n');
  writeDoc('report.csv', 'report\n');
  const watched = await watchContent();
  const before = generalEntries(watched.watcher);
  expect(
    [...before]
      .map(([name, entry]) => [name, entry.fileMembers])
      .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
  ).toEqual([
    ['pair-1.csv', { regularPaths: ['pair-1.csv', 'pair-2.csv'], symlinks: [] }],
    ['report.csv', { regularPaths: ['report.csv'], symlinks: [] }],
    [
      'shared.csv',
      {
        regularPaths: ['shared.csv'],
        symlinks: [{ path: 'shared-link.csv', targetPath: 'shared.csv' }],
      },
    ],
    ['solo.csv', { regularPaths: ['solo.csv'], symlinks: [] }],
  ]);
  return { ...watched, before };
}

const unaffectedGeneralGroups = ['pair-1.csv', 'shared.csv', 'solo.csv'];

test('a general-file update leaves the index entries of other inode groups unchanged', async () => {
  const { watcher, events, before } = await watchSeparateGeneralGroups();
  const report = join(contentDir, 'report.csv');
  writeFileSync(report, 'region,total\nnorth,42\nsouth,17\n');
  const size = statSync(report).size;
  expect(size).not.toBe(before.get('report.csv')?.size);

  await deliver(contentDir, [{ type: 'update', path: report }]);

  expect(events).toContainEqual(
    expect.objectContaining({ kind: 'file-update', relativePath: 'report.csv', size }),
  );
  const after = generalEntries(watcher);
  expect(after.get('report.csv')?.size).toBe(size);
  for (const name of unaffectedGeneralGroups) {
    expect(after.get(name), name).toBe(before.get(name));
  }
});

test('a general-file create leaves the index entries of other inode groups unchanged', async () => {
  const { watcher, events, before } = await watchSeparateGeneralGroups();
  const added = writeDoc('added.csv', 'added,rows\n1,2\n');
  const size = statSync(added).size;

  await deliver(contentDir, [{ type: 'create', path: added }]);

  expect(events).toContainEqual(
    expect.objectContaining({ kind: 'file-create', relativePath: 'added.csv', size }),
  );
  const after = generalEntries(watcher);
  expect(after.get('added.csv')).toEqual(
    expect.objectContaining({
      size,
      fileMembers: { regularPaths: ['added.csv'], symlinks: [] },
    }),
  );
  for (const name of [...unaffectedGeneralGroups, 'report.csv']) {
    expect(after.get(name), name).toBe(before.get(name));
  }
});

test('a general-file delete leaves the index entries of other inode groups unchanged', async () => {
  const { watcher, events, before } = await watchSeparateGeneralGroups();
  const report = join(contentDir, 'report.csv');
  unlinkSync(report);

  await deliver(contentDir, [{ type: 'delete', path: report }]);

  expect(events).toContainEqual(
    expect.objectContaining({ kind: 'file-delete', relativePath: 'report.csv' }),
  );
  const after = generalEntries(watcher);
  expect(after.has('report.csv')).toBe(false);
  for (const name of unaffectedGeneralGroups) {
    expect(after.get(name), name).toBe(before.get(name));
  }
});
