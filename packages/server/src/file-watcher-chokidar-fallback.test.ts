import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { FSWatcher } from 'chokidar';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createContentFilter } from './content-filter.ts';
import {
  type DiskEvent,
  isChokidarPathIgnored,
  lastKnownHash,
  startWatcher,
  type WatcherHandle,
  writeTracker,
} from './file-watcher.ts';
import { waitWithinTestBudget } from './wait-within-test-budget.test-helper.ts';

type NativeDeleteKind = 'unlink' | 'unlinkDir';

type NativeDeleteGate = {
  kind: NativeDeleteKind;
  path: string;
  seen: PromiseWithResolvers<void>;
  released: PromiseWithResolvers<void>;
  delivered: PromiseWithResolvers<void>;
  captured: boolean;
  isReleased: boolean;
  release: () => void;
};

const nativeTap = vi.hoisted(() => ({
  watcher: null as FSWatcher | null,
  handle: null as WatcherHandle | null,
  gates: [] as NativeDeleteGate[],
  observed: [] as Array<{ kind: NativeDeleteKind; path: string }>,
}));

vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chokidar')>();
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) => {
      const watcher = actual.watch(...args);
      nativeTap.watcher = watcher;
      const originalEmit = watcher.emit;
      watcher.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
        const path = args[0];
        if ((event === 'unlink' || event === 'unlinkDir') && typeof path === 'string') {
          nativeTap.observed.push({ kind: event, path });
          const gate = nativeTap.gates.find(
            (candidate) => candidate.kind === event && candidate.path === path,
          );
          if (gate && !gate.isReleased && !gate.captured) {
            gate.captured = true;
            gate.seen.resolve();
            void gate.released.promise.then(() => {
              try {
                Reflect.apply(originalEmit, watcher, [event, ...args]);
                gate.delivered.resolve();
              } catch (error) {
                gate.delivered.reject(error);
              }
            });
            return true;
          }
        }
        return Reflect.apply(originalEmit, watcher, [event, ...args]) as boolean;
      }) as typeof watcher.emit;
      return watcher;
    },
  };
});

function holdNativeDeletion(kind: NativeDeleteKind, path: string): NativeDeleteGate {
  const seen = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const gate: NativeDeleteGate = {
    kind,
    path,
    seen,
    released,
    delivered,
    captured: false,
    isReleased: false,
    release: () => {
      if (gate.isReleased) return;
      gate.isReleased = true;
      released.resolve();
    },
  };
  nativeTap.gates.push(gate);
  return gate;
}

async function runNativeDeleteCase(
  contentDir: string,
  events: DiskEvent[],
  batches: string[][],
  terminal: PromiseWithResolvers<void>,
  body: (handle: WatcherHandle) => Promise<void>,
): Promise<void> {
  let handle: WatcherHandle | undefined;
  let bodyError: unknown;
  try {
    handle = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
        if (event.kind === 'file-delete' && event.relativePath === 'tail.png') terminal.resolve();
      },
      undefined,
      { forceBackend: 'chokidar', onRawBatch: (paths) => batches.push([...paths]) },
    );
    nativeTap.handle = handle;
    await body(handle);
  } catch (error) {
    bodyError = error;
  }
  for (const gate of nativeTap.gates) gate.release();
  let cleanupError: unknown;
  try {
    await handle?.unsubscribe();
    nativeTap.handle = null;
  } catch (error) {
    cleanupError = error;
  }
  if (bodyError && cleanupError)
    throw new AggregateError([bodyError, cleanupError], 'native deletion body and cleanup failed');
  if (bodyError) throw bodyError;
  if (cleanupError) throw cleanupError;
}

describe('isChokidarPathIgnored — stats matrix', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-chokidar-ignored-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(resolve(contentDir, 'sub'), { recursive: true });
    mkdirSync(resolve(contentDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(resolve(contentDir, 'sub', 'note.md'), '# Note\n');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('the content dir root is never ignored', () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    expect(isChokidarPathIgnored(contentDir, filter, contentDir, statSync(contentDir))).toBe(false);
  });

  test('a content subdirectory is NOT ignored — with stats and (the bug) without', () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const subDir = resolve(contentDir, 'sub');
    expect(isChokidarPathIgnored(contentDir, filter, subDir, statSync(subDir))).toBe(false);
    expect(isChokidarPathIgnored(contentDir, filter, subDir, undefined)).toBe(false);
  });

  test('a markdown file is not ignored; a stats-less non-content file routes through isExcluded', () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const mdFile = resolve(contentDir, 'sub', 'note.md');
    expect(isChokidarPathIgnored(contentDir, filter, mdFile, lstatSync(mdFile))).toBe(false);
    writeFileSync(resolve(contentDir, 'sub', 'Makefile'), 'x');
    const plain = resolve(contentDir, 'sub', 'Makefile');
    expect(filter.isExcluded('sub/Makefile')).toBe(true);
    expect(filter.isDirExcluded('sub/Makefile')).toBe(false);
    expect(isChokidarPathIgnored(contentDir, filter, plain, undefined)).toBe(true);
  });

  test('excluded directories stay pruned even without stats (node_modules)', () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const nm = resolve(contentDir, 'node_modules');
    expect(isChokidarPathIgnored(contentDir, filter, nm, undefined)).toBe(true);
  });

  test('a nonexistent path with no stats is admitted (never prune on uncertainty)', () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const gone = resolve(contentDir, 'sub', 'was-just-deleted.md');
    expect(isChokidarPathIgnored(contentDir, filter, gone, undefined)).toBe(false);
  });
});

describe('chokidar backend — live subfolder watching (forceBackend)', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-chokidar-live-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(resolve(contentDir, 'sub'), { recursive: true });
    writeFileSync(resolve(contentDir, 'root.md'), '# Root\n');
    writeFileSync(resolve(contentDir, 'sub', 'note.md'), '# Note\n\n[Root](./root)\n');
    lastKnownHash.clear();
    writeTracker.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('edits to a pre-existing subfolder doc dispatch a DiskEvent', async () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const events: DiskEvent[] = [];
    const handle = await startWatcher(contentDir, async (e) => void events.push(e), filter, {
      forceBackend: 'chokidar',
    });
    try {
      writeFileSync(resolve(contentDir, 'root.md'), '# Root edited\n');
      await waitWithinTestBudget(
        "an update DiskEvent for 'root'",
        () => events.some((e) => e.kind === 'update' && e.docName === 'root'),
        { timeoutMs: 15_000, pollMs: 40 },
      );

      writeFileSync(resolve(contentDir, 'sub', 'note.md'), '# Note edited\n\n[Gone](./gone)\n');
      await waitWithinTestBudget(
        "an update DiskEvent for 'sub/note'",
        () => events.some((e) => e.kind === 'update' && e.docName === 'sub/note'),
        { timeoutMs: 15_000, pollMs: 40 },
      );
      expect(events).toContainEqual(expect.objectContaining({ kind: 'update', docName: 'root' }));
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'update', docName: 'sub/note' }),
      );
    } finally {
      await handle.unsubscribe();
    }
  });

  test('a doc created in a NEW subfolder after watch start dispatches a DiskEvent', async () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const events: DiskEvent[] = [];
    const handle = await startWatcher(contentDir, async (e) => void events.push(e), filter, {
      forceBackend: 'chokidar',
    });
    try {
      mkdirSync(resolve(contentDir, 'fresh'));
      await waitWithinTestBudget(
        "a folder-create DiskEvent for the new 'fresh' subfolder",
        () => events.some((e) => e.kind === 'folder-create' && e.relativePath === 'fresh'),
        { timeoutMs: 15_000, pollMs: 40 },
      );
      writeFileSync(resolve(contentDir, 'fresh', 'child.md'), '# Child\n');
      await waitWithinTestBudget(
        "a create or update DiskEvent for 'fresh/child'",
        () =>
          events.some(
            (e) => (e.kind === 'create' || e.kind === 'update') && e.docName === 'fresh/child',
          ),
        { timeoutMs: 15_000, pollMs: 40 },
      );
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'folder-create', relativePath: 'fresh' }),
      );
      expect(
        events.some(
          (e) => (e.kind === 'create' || e.kind === 'update') && e.docName === 'fresh/child',
        ),
      ).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('excluded subtrees stay pruned — node_modules edits do not dispatch', async () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const events: DiskEvent[] = [];
    const handle = await startWatcher(contentDir, async (e) => void events.push(e), filter, {
      forceBackend: 'chokidar',
    });
    try {
      mkdirSync(resolve(contentDir, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(resolve(contentDir, 'node_modules', 'dep', 'readme.md'), '# Dep\n');
      writeFileSync(resolve(contentDir, 'root.md'), '# Root sentinel\n');
      await waitWithinTestBudget(
        "the 'root' sentinel update DiskEvent that proves the watcher is live",
        () => events.some((e) => e.kind === 'update' && e.docName === 'root'),
        { timeoutMs: 15_000, pollMs: 40 },
      );
      expect(
        events.some((e) => 'docName' in e && String(e.docName).startsWith('node_modules')),
      ).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });
});

describe('chokidar backend — templates-as-content watching (forceBackend)', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-chokidar-template-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
    writeTracker.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('a template created in a brand-new .ok/templates folder dispatches a DiskEvent', async () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const events: DiskEvent[] = [];
    const handle = await startWatcher(contentDir, async (e) => void events.push(e), filter, {
      forceBackend: 'chokidar',
    });
    try {
      const target = resolve(contentDir, 'notes', '.ok', 'templates', 'standup.md');
      mkdirSync(resolve(target, '..'), { recursive: true });
      const src = '---\ntitle: Standup\ndescription: a standup template\n---\n\n# {{date}}\n';
      await waitWithinTestBudget(
        "a create or update DiskEvent for 'notes/.ok/templates/standup'",
        () => {
          writeFileSync(target, src);
          return events.some(
            (e) =>
              (e.kind === 'create' || e.kind === 'update') &&
              e.docName === 'notes/.ok/templates/standup',
          );
        },
        { timeoutMs: 6_000, pollMs: 40 },
      );
      expect(
        events.some(
          (e) =>
            (e.kind === 'create' || e.kind === 'update') &&
            e.docName === 'notes/.ok/templates/standup',
        ),
      ).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('conflict markers in a template file dispatch a conflict DiskEvent', async () => {
    mkdirSync(resolve(contentDir, '.ok', 'templates'), { recursive: true });
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const events: DiskEvent[] = [];
    const handle = await startWatcher(contentDir, async (e) => void events.push(e), filter, {
      forceBackend: 'chokidar',
    });
    try {
      const target = resolve(contentDir, '.ok', 'templates', 'daily.md');
      const conflicted = '# Daily\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';
      writeFileSync(target, conflicted);
      await waitWithinTestBudget(
        "a conflict DiskEvent for '.ok/templates/daily'",
        () => events.some((e) => e.kind === 'conflict' && e.docName === '.ok/templates/daily'),
        { timeoutMs: 6_000, pollMs: 40 },
      );
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'conflict', docName: '.ok/templates/daily' }),
      );
    } finally {
      await handle.unsubscribe();
    }
  });
});

describe('chokidar backend — deletion roles with overlapping indexes', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-chokidar-kinds-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir);
    contentDir = realpathSync(contentDir);
    lastKnownHash.clear();
    writeTracker.clear();
    nativeTap.watcher = null;
    nativeTap.gates = [];
    nativeTap.observed = [];
  });

  afterEach(async () => {
    for (const gate of nativeTap.gates) gate.release();
    await Promise.resolve();
    await nativeTap.handle?.unsubscribe();
    nativeTap.handle = null;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('a real unlinkDir retains a newer document at the same path', async () => {
    const entry = resolve(contentDir, 'entry.md');
    const tail = resolve(contentDir, 'tail.png');
    mkdirSync(entry);
    writeFileSync(tail, 'tail bytes');
    const events: DiskEvent[] = [];
    const batches: string[][] = [];
    const terminal = Promise.withResolvers<void>();
    const folderDelete = holdNativeDeletion('unlinkDir', entry);
    const tailDelete = holdNativeDeletion('unlink', tail);

    await runNativeDeleteCase(contentDir, events, batches, terminal, async (handle) => {
      expect(nativeTap.watcher).not.toBeNull();
      expect(handle.getFolderIndex().has('entry.md')).toBe(true);
      expect(handle.getFileIndex().has('entry')).toBe(false);

      rmdirSync(entry);
      await folderDelete.seen.promise;
      expect(nativeTap.observed).toContainEqual({ kind: 'unlinkDir', path: entry });
      writeFileSync(entry, '# Replacement\n');
      handle.mutateFileIndex({
        kind: 'create',
        path: entry,
        docName: 'entry',
        content: '# Replacement\n',
      });
      expect(handle.getFolderIndex().has('entry.md')).toBe(true);
      expect(handle.getFileIndex().get('entry')?.canonicalPath).toBe(entry);
      expect(readFileSync(entry, 'utf8')).toBe('# Replacement\n');

      unlinkSync(tail);
      await tailDelete.seen.promise;
      folderDelete.release();
      tailDelete.release();
      await Promise.all([
        folderDelete.delivered.promise,
        tailDelete.delivered.promise,
        terminal.promise,
      ]);

      expect(batches.some((batch) => batch.includes(entry) && batch.includes(tail))).toBe(true);
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'folder-delete', relativePath: 'entry.md' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'file-delete', relativePath: 'tail.png' }),
      );
      expect
        .soft(events.some((event) => event.kind === 'delete' && event.docName === 'entry'))
        .toBe(false);
      expect(handle.getFolderIndex().has('entry.md')).toBe(false);
      expect.soft(new Map(handle.getAllFilesIndex()).get('entry')?.canonicalPath).toBe(entry);
      expect(readFileSync(entry, 'utf8')).toBe('# Replacement\n');
    });
  });

  test('a real file unlink retains a newer directory and child at the same path', async () => {
    const entry = resolve(contentDir, 'entry.md');
    const child = resolve(entry, 'child.md');
    const tail = resolve(contentDir, 'tail.png');
    writeFileSync(entry, '# Prior file\n');
    writeFileSync(tail, 'tail bytes');
    const events: DiskEvent[] = [];
    const batches: string[][] = [];
    const terminal = Promise.withResolvers<void>();
    const fileDelete = holdNativeDeletion('unlink', entry);
    const tailDelete = holdNativeDeletion('unlink', tail);

    await runNativeDeleteCase(contentDir, events, batches, terminal, async (handle) => {
      expect(nativeTap.watcher).not.toBeNull();
      expect(handle.getFileIndex().get('entry')?.canonicalPath).toBe(entry);
      expect(handle.getFolderIndex().has('entry.md')).toBe(false);

      unlinkSync(entry);
      await fileDelete.seen.promise;
      expect(nativeTap.observed).toContainEqual({ kind: 'unlink', path: entry });
      mkdirSync(entry);
      writeFileSync(child, '# Live child\n');
      await handle.rescanFromDisk();
      expect(handle.getFileIndex().get('entry')?.canonicalPath).toBe(entry);
      expect(handle.getFolderIndex().has('entry.md')).toBe(true);
      expect(handle.getFileIndex().get('entry.md/child')?.canonicalPath).toBe(child);
      expect(readFileSync(child, 'utf8')).toBe('# Live child\n');

      unlinkSync(tail);
      await tailDelete.seen.promise;
      fileDelete.release();
      tailDelete.release();
      await Promise.all([
        fileDelete.delivered.promise,
        tailDelete.delivered.promise,
        terminal.promise,
      ]);

      expect(batches.some((batch) => batch.includes(entry) && batch.includes(tail))).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'delete', docName: 'entry' }));
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'file-delete', relativePath: 'tail.png' }),
      );
      expect
        .soft(
          events.some(
            (event) => event.kind === 'folder-delete' && event.relativePath === 'entry.md',
          ),
        )
        .toBe(false);
      expect
        .soft(events.some((event) => event.kind === 'delete' && event.docName === 'entry.md/child'))
        .toBe(false);
      expect(new Map(handle.getAllFilesIndex()).has('entry')).toBe(false);
      expect.soft(handle.getFolderIndex().has('entry.md')).toBe(true);
      expect
        .soft(new Map(handle.getAllFilesIndex()).get('entry.md/child')?.canonicalPath)
        .toBe(child);
      expect(readFileSync(child, 'utf8')).toBe('# Live child\n');
    });
  });
});
