import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createContentFilter } from './content-filter.ts';
import type { DiskEvent } from './file-watcher';
import {
  classifyEvents,
  contentHash,
  evictStaleTrackerEntries,
  handleRawEvents,
  isSelfWrite,
  lastKnownHash,
  pathToDocName,
  reconcileFileIndexAfterFilterRebuild,
  registerWrite,
  startWatcher,
  updateLastKnownHash,
  writeTracker,
} from './file-watcher';

describe('writeTracker', () => {
  beforeEach(() => {
    writeTracker.clear();
  });

  test('skips self-writes with matching hash', () => {
    const filePath = '/content/test-fixture.md';
    const content = '# Hello\n\nWorld\n';
    const hash = contentHash(content);

    registerWrite(filePath, hash);

    const queue = writeTracker.get(filePath);
    expect(queue).toBeTruthy();
    expect(queue?.some((e) => e.hash === hash)).toBe(true);
  });

  test('does not skip external writes with different hash', () => {
    const filePath = '/content/test-fixture.md';
    const ourContent = '# Hello\n\nWorld\n';
    const externalContent = '# Hello\n\nExternal edit\n';

    registerWrite(filePath, contentHash(ourContent));

    const externalHash = contentHash(externalContent);
    const queue = writeTracker.get(filePath);
    expect(queue?.some((e) => e.hash === externalHash)).toBe(false);
  });

  test('does not skip writes when no tracked entry exists', () => {
    const filePath = '/content/new-file.md';
    expect(writeTracker.has(filePath)).toBe(false);
  });

  test('queue handles multiple rapid writes — each event consumes only its own entry', () => {
    const filePath = '/content/test-fixture.md';
    const hash1 = contentHash('write 1');
    const hash2 = contentHash('write 2');

    registerWrite(filePath, hash1);
    registerWrite(filePath, hash2);

    const queue = writeTracker.get(filePath);
    expect(queue).toHaveLength(2);

    const idx1 = queue?.findIndex((e) => e.hash === hash1) ?? -1;
    expect(idx1).toBeGreaterThanOrEqual(0);
    queue?.splice(idx1, 1);
    expect(queue).toHaveLength(1);
    expect(queue?.[0].hash).toBe(hash2);
  });
});

describe('TTL eviction', () => {
  beforeEach(() => {
    writeTracker.clear();
  });

  test('evicts entries older than TTL (10s)', () => {
    const filePath = '/content/stale.md';
    writeTracker.set(filePath, [{ hash: 'abc123', timestamp: Date.now() - 11_000 }]);

    evictStaleTrackerEntries();
    expect(writeTracker.has(filePath)).toBe(false);
  });

  test('keeps entries within TTL', () => {
    const filePath = '/content/fresh.md';
    writeTracker.set(filePath, [{ hash: 'abc123', timestamp: Date.now() - 5_000 }]);

    evictStaleTrackerEntries();
    expect(writeTracker.has(filePath)).toBe(true);
  });

  test('mixed: evicts stale, keeps fresh', () => {
    writeTracker.set('/content/stale.md', [{ hash: 'old', timestamp: Date.now() - 15_000 }]);
    writeTracker.set('/content/fresh.md', [{ hash: 'new', timestamp: Date.now() - 2_000 }]);

    evictStaleTrackerEntries();
    expect(writeTracker.has('/content/stale.md')).toBe(false);
    expect(writeTracker.has('/content/fresh.md')).toBe(true);
  });

  test('evicts stale entries within a queue while keeping fresh ones', () => {
    writeTracker.set('/content/mixed.md', [
      { hash: 'old', timestamp: Date.now() - 15_000 },
      { hash: 'new', timestamp: Date.now() - 2_000 },
    ]);

    evictStaleTrackerEntries();
    const queue = writeTracker.get('/content/mixed.md');
    expect(queue).toHaveLength(1);
    expect(queue?.[0].hash).toBe('new');
  });
});

describe('pathToDocName', () => {
  test('maps absolute path to document name', () => {
    expect(pathToDocName('/app/content/test-fixture.md', '/app/content')).toBe('test-fixture');
  });

  test('handles nested paths', () => {
    expect(pathToDocName('/app/content/docs/guide.md', '/app/content')).toBe('docs/guide');
  });

  test('strips .mdx extension', () => {
    expect(pathToDocName('/app/content/component.mdx', '/app/content')).toBe('component');
  });

  test('strips .mdx from nested paths', () => {
    expect(pathToDocName('/app/content/docs/guide.mdx', '/app/content')).toBe('docs/guide');
  });
});

describe('contentHash', () => {
  test('produces consistent SHA-256 hex digest', () => {
    const hash1 = contentHash('hello');
    const hash2 = contentHash('hello');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  test('different content produces different hashes', () => {
    expect(contentHash('hello')).not.toBe(contentHash('world'));
  });
});

describe('isSelfWrite', () => {
  beforeEach(() => {
    writeTracker.clear();
  });

  test('returns true and consumes entry for matching hash', () => {
    const path = '/content/test.md';
    const hash = contentHash('hello');
    registerWrite(path, hash);

    expect(isSelfWrite(path, hash)).toBe(true);
    expect(writeTracker.has(path)).toBe(false);
  });

  test('returns false for non-matching hash', () => {
    const path = '/content/test.md';
    registerWrite(path, contentHash('hello'));

    expect(isSelfWrite(path, contentHash('world'))).toBe(false);
    expect(writeTracker.has(path)).toBe(true);
  });
});

describe('classifyEvents', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-watcher-test-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('emits update event for modified file', async () => {
    const filePath = resolve(contentDir, 'doc.md');
    writeFileSync(filePath, '# Updated\n');

    const events = await classifyEvents([{ type: 'update', path: filePath }], contentDir);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('update');
    if (events[0].kind === 'update') {
      expect(events[0].docName).toBe('doc');
      expect(events[0].content).toBe('# Updated\n');
    }
  });

  test('emits create event for new file', async () => {
    const filePath = resolve(contentDir, 'new.md');
    writeFileSync(filePath, '# New\n');

    const events = await classifyEvents([{ type: 'create', path: filePath }], contentDir);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('create');
  });

  test('emits create event for new empty file', async () => {
    const filePath = resolve(contentDir, 'empty.md');
    writeFileSync(filePath, '');

    const events = await classifyEvents([{ type: 'create', path: filePath }], contentDir);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('create');
    if (events[0].kind === 'create') {
      expect(events[0].docName).toBe('empty');
      expect(events[0].content).toBe('');
    }
  });

  test('emits update event when existing file becomes empty', async () => {
    const filePath = resolve(contentDir, 'cleared.md');
    writeFileSync(filePath, '');

    const events = await classifyEvents([{ type: 'update', path: filePath }], contentDir);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('update');
    if (events[0].kind === 'update') {
      expect(events[0].docName).toBe('cleared');
      expect(events[0].content).toBe('');
    }
  });

  test('emits delete event for removed file', async () => {
    const filePath = resolve(contentDir, 'gone.md');

    const events = await classifyEvents([{ type: 'delete', path: filePath }], contentDir);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('delete');
    if (events[0].kind === 'delete') {
      expect(events[0].docName).toBe('gone');
    }
  });

  test('emits rename for delete+create with matching content hash', async () => {
    const oldPath = resolve(contentDir, 'old-name.md');
    const newPath = resolve(contentDir, 'new-name.md');
    const content = '# Same Content\n';

    updateLastKnownHash(oldPath, contentHash(content));

    writeFileSync(newPath, content);

    const events = await classifyEvents(
      [
        { type: 'delete', path: oldPath },
        { type: 'create', path: newPath },
      ],
      contentDir,
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('rename');
    if (events[0].kind === 'rename') {
      expect(events[0].oldDocName).toBe('old-name');
      expect(events[0].newDocName).toBe('new-name');
      expect(events[0].content).toBe(content);
    }
  });

  test('emits separate delete+create when content hashes differ', async () => {
    const oldPath = resolve(contentDir, 'old.md');
    const newPath = resolve(contentDir, 'new.md');

    updateLastKnownHash(oldPath, contentHash('old content'));
    writeFileSync(newPath, 'different content');

    const events = await classifyEvents(
      [
        { type: 'delete', path: oldPath },
        { type: 'create', path: newPath },
      ],
      contentDir,
    );

    expect(events).toHaveLength(2);
    expect(events.some((e) => e.kind === 'delete')).toBe(true);
    expect(events.some((e) => e.kind === 'create')).toBe(true);
  });

  test('emits conflict event when file contains conflict markers', async () => {
    const filePath = resolve(contentDir, 'conflicted.md');
    writeFileSync(filePath, '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n');

    const events = await classifyEvents([{ type: 'update', path: filePath }], contentDir);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('conflict');
  });

  test('emits conflict event for create with conflict markers', async () => {
    const filePath = resolve(contentDir, 'new-conflicted.md');
    writeFileSync(filePath, '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n');

    const events = await classifyEvents([{ type: 'create', path: filePath }], contentDir);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('conflict');
  });

  test('ignores non-.md files', async () => {
    const filePath = resolve(contentDir, 'readme.txt');
    writeFileSync(filePath, 'hello');

    const events = await classifyEvents([{ type: 'update', path: filePath }], contentDir);

    expect(events).toHaveLength(0);
  });

  test('filters events through ContentFilter when provided', async () => {
    writeFileSync(resolve(tmpDir, '.gitignore'), 'dist/\n');
    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    mkdirSync(resolve(contentDir, 'dist'), { recursive: true });
    mkdirSync(resolve(contentDir, 'docs'), { recursive: true });
    writeFileSync(resolve(contentDir, 'dist', 'output.md'), '# Build Output\n');
    writeFileSync(resolve(contentDir, 'docs', 'guide.md'), '# Guide\n');

    const events = await classifyEvents(
      [
        { type: 'create', path: resolve(contentDir, 'dist', 'output.md') },
        { type: 'create', path: resolve(contentDir, 'docs', 'guide.md') },
      ],
      contentDir,
      filter,
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('create');
    if (events[0].kind === 'create') {
      expect(events[0].docName).toBe('docs/guide');
    }
  });
});

describe('startWatcher file index', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-watcher-index-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('initial scan populates file index with .md files', async () => {
    writeFileSync(resolve(contentDir, 'readme.md'), '# README\n');
    mkdirSync(resolve(contentDir, 'docs'));
    writeFileSync(resolve(contentDir, 'docs', 'guide.md'), '# Guide\n');
    writeFileSync(resolve(contentDir, 'script.js'), 'console.log("hi")');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const index = handle.getFileIndex();
      expect(index.size).toBe(2);
      expect(index.has('readme')).toBe(true);
      expect(index.has('docs/guide')).toBe(true);
      expect(index.has('script')).toBe(false);

      const entry = index.get('readme');
      expect(entry).toBeTruthy();
      expect(entry?.size).toBeGreaterThan(0);
      expect(entry?.modified).toBeTruthy();
    } finally {
      await handle.unsubscribe();
    }
  });

  test('initial scan preserves uppercase .MD/.MDX extension casing', async () => {
    writeFileSync(resolve(contentDir, 'Upper.MD'), '# Upper\n');
    writeFileSync(resolve(contentDir, 'Mixed.MdX'), '# Mixed\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const { getDocExtension } = await import('./doc-extensions.ts');
      const { safeContentPath } = await import('./persistence.ts');

      expect(getDocExtension('Upper')).toBe('.MD');
      expect(getDocExtension('Mixed')).toBe('.MdX');

      const upperPath = safeContentPath('Upper', contentDir);
      expect(upperPath.endsWith('/Upper.MD')).toBe(true);

      const mixedPath = safeContentPath('Mixed', contentDir);
      expect(mixedPath.endsWith('/Mixed.MdX')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('file index excludes files filtered by ContentFilter', async () => {
    writeFileSync(resolve(tmpDir, '.gitignore'), 'dist/\n');
    mkdirSync(resolve(contentDir, 'dist'), { recursive: true });
    mkdirSync(resolve(contentDir, 'docs'), { recursive: true });
    writeFileSync(resolve(contentDir, 'dist', 'output.md'), '# Build\n');
    writeFileSync(resolve(contentDir, 'docs', 'guide.md'), '# Guide\n');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      const index = handle.getFileIndex();
      expect(index.size).toBe(1);
      expect(index.has('docs/guide')).toBe(true);
      expect(index.has('dist/output')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('file index excludes files matching .okignore patterns', async () => {
    mkdirSync(resolve(contentDir, 'archive'), { recursive: true });
    writeFileSync(resolve(contentDir, 'readme.md'), '# README\n');
    writeFileSync(resolve(contentDir, 'archive', 'old.md'), '# Old\n');
    writeFileSync(resolve(tmpDir, '.okignore'), 'content/archive/\n');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      const index = handle.getFileIndex();
      expect(index.size).toBe(1);
      expect(index.has('readme')).toBe(true);
      expect(index.has('archive/old')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('file index updates on create event', () => {
    const { updateFileIndex } = require('./file-watcher.ts');
    const index = new Map();
    const event = {
      kind: 'create' as const,
      path: resolve(contentDir, 'new-file.md'),
      docName: 'new-file',
      content: '# New File\n',
    };
    updateFileIndex(event, index);
    expect(index.has('new-file')).toBe(true);
    expect(index.get('new-file')?.size).toBe(Buffer.byteLength('# New File\n', 'utf-8'));
    expect(index.get('new-file')?.modified).toBeTruthy();
  });

  test('file index removes entry on delete event', () => {
    const { updateFileIndex } = require('./file-watcher.ts');
    const index = new Map([['existing', { size: 10, modified: new Date().toISOString() }]]);
    const event = {
      kind: 'delete' as const,
      path: resolve(contentDir, 'existing.md'),
      docName: 'existing',
    };
    updateFileIndex(event, index);
    expect(index.has('existing')).toBe(false);
  });

  test('file index updates size/modified on update event', () => {
    const { updateFileIndex } = require('./file-watcher.ts');
    const oldModified = '2020-01-01T00:00:00.000Z';
    const index = new Map([['doc', { size: 5, modified: oldModified }]]);
    const event = {
      kind: 'update' as const,
      path: resolve(contentDir, 'doc.md'),
      docName: 'doc',
      content: '# Updated content with more text\n',
    };
    updateFileIndex(event, index);
    expect(index.get('doc')?.size).toBe(
      Buffer.byteLength('# Updated content with more text\n', 'utf-8'),
    );
    expect(index.get('doc')?.modified).not.toBe(oldModified);
  });

  test('file index handles rename event', () => {
    const { updateFileIndex } = require('./file-watcher.ts');
    const index = new Map([['old-name', { size: 10, modified: new Date().toISOString() }]]);
    const event = {
      kind: 'rename' as const,
      oldPath: resolve(contentDir, 'old-name.md'),
      newPath: resolve(contentDir, 'new-name.md'),
      oldDocName: 'old-name',
      newDocName: 'new-name',
      content: '# Renamed\n',
    };
    updateFileIndex(event, index);
    expect(index.has('old-name')).toBe(false);
    expect(index.has('new-name')).toBe(true);
    expect(index.get('new-name')?.size).toBe(Buffer.byteLength('# Renamed\n', 'utf-8'));
  });

  test('getFileIndex returns empty map when no .md files exist', async () => {
    const handle = await startWatcher(contentDir, async () => {});
    try {
      expect(handle.getFileIndex().size).toBe(0);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('pruneFileIndexNowExcluded removes entries that became excluded after rebuild', async () => {
    writeFileSync(resolve(contentDir, 'keep.md'), '# Keep\n');
    writeFileSync(resolve(contentDir, 'hide-me.md'), '# Hide me\n');
    writeFileSync(resolve(tmpDir, '.okignore'), '');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      expect(handle.getFileIndex().has('keep')).toBe(true);
      expect(handle.getFileIndex().has('hide-me')).toBe(true);

      writeFileSync(resolve(tmpDir, '.okignore'), 'hide-me.md\n');
      await filter.rebuildIgnorePatterns();

      const pruned = handle.pruneFileIndexNowExcluded();
      expect(pruned).toBe(1);
      expect(handle.getFileIndex().has('keep')).toBe(true);
      expect(handle.getFileIndex().has('hide-me')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('pruneFolderIndexNowExcluded removes folders that became excluded after rebuild', async () => {
    mkdirSync(resolve(contentDir, 'archive', 'sub'), { recursive: true });
    writeFileSync(resolve(contentDir, 'archive', 'sub', 'old.md'), '# Old\n');
    writeFileSync(resolve(tmpDir, '.okignore'), '');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      expect(handle.getFolderIndex().has('archive')).toBe(true);
      expect(handle.getFolderIndex().has('archive/sub')).toBe(true);

      writeFileSync(resolve(tmpDir, '.okignore'), 'content/archive/\n');
      await filter.rebuildIgnorePatterns();

      const pruned = handle.pruneFolderIndexNowExcluded();
      expect(pruned).toBe(2);
      expect(handle.getFolderIndex().has('archive')).toBe(false);
      expect(handle.getFolderIndex().has('archive/sub')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('pruneFileIndexNowExcluded is a no-op when nothing is now-excluded', async () => {
    writeFileSync(resolve(contentDir, 'keep.md'), '# Keep\n');
    writeFileSync(resolve(tmpDir, '.okignore'), '');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      expect(handle.getFileIndex().has('keep')).toBe(true);

      writeFileSync(resolve(tmpDir, '.okignore'), 'something-else.md\n');
      await filter.rebuildIgnorePatterns();

      expect(handle.pruneFileIndexNowExcluded()).toBe(0);
      expect(handle.getFileIndex().has('keep')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('pruneFolderIndexNowExcluded is a no-op when nothing is now-excluded', async () => {
    mkdirSync(resolve(contentDir, 'keep'), { recursive: true });
    writeFileSync(resolve(tmpDir, '.okignore'), '');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      expect(handle.getFolderIndex().has('keep')).toBe(true);

      writeFileSync(resolve(tmpDir, '.okignore'), 'content/something-else/\n');
      await filter.rebuildIgnorePatterns();

      expect(handle.pruneFolderIndexNowExcluded()).toBe(0);
      expect(handle.getFolderIndex().has('keep')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('pruneFileIndexNowExcluded returns 0 when no ContentFilter is set', async () => {
    writeFileSync(resolve(contentDir, 'keep.md'), '# Keep\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      expect(handle.pruneFileIndexNowExcluded()).toBe(0);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('pruneFolderIndexNowExcluded returns 0 when no ContentFilter is set', async () => {
    mkdirSync(resolve(contentDir, 'archive'), { recursive: true });

    const handle = await startWatcher(contentDir, async () => {});
    try {
      expect(handle.getFolderIndex().has('archive')).toBe(true);
      expect(handle.pruneFolderIndexNowExcluded()).toBe(0);
      expect(handle.getFolderIndex().has('archive')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('initial scan populates folderIndex with empty subdirectories', async () => {
    mkdirSync(resolve(contentDir, 'empty-folder'));
    mkdirSync(resolve(contentDir, 'nested', 'empty-child'), { recursive: true });

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const folderIndex = handle.getFolderIndex();
      expect(folderIndex.has('empty-folder')).toBe(true);
      expect(folderIndex.has('nested')).toBe(true);
      expect(folderIndex.has('nested/empty-child')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('folderIndex detects externally-created empty directory via live watcher', async () => {
    const events: DiskEvent[] = [];
    const handle = await startWatcher(contentDir, async (e) => {
      events.push(e);
    });
    try {
      mkdirSync(resolve(contentDir, 'live-empty'));
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        if (handle.getFolderIndex().has('live-empty')) break;
        await new Promise((r) => setTimeout(r, 30));
      }
      expect(handle.getFolderIndex().has('live-empty')).toBe(true);
      expect(
        events.some((e) => e.kind === 'folder-create' && e.relativePath === 'live-empty'),
      ).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });
});

describe('reconcileFileIndexAfterFilterRebuild', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-reconcile-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('re-includes files previously excluded after pattern removal (start-with-pattern → remove)', async () => {
    writeFileSync(resolve(contentDir, 'keep.md'), '# Keep\n');
    writeFileSync(resolve(contentDir, 'hide-me.md'), '# Hide me\n');
    writeFileSync(resolve(tmpDir, '.okignore'), 'hide-me.md\n');

    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      expect(handle.getFileIndex().has('keep')).toBe(true);
      expect(handle.getFileIndex().has('hide-me')).toBe(false);

      writeFileSync(resolve(tmpDir, '.okignore'), '');
      const result = await filter.rebuildIgnorePatterns();
      expect(result.ok).toBe(true);

      const { prunedFiles, prunedFolders } = await reconcileFileIndexAfterFilterRebuild(handle);
      expect(prunedFiles).toBe(0);
      expect(prunedFolders).toBe(0);
      expect(handle.getFileIndex().has('hide-me')).toBe(true);
      expect(handle.getFileIndex().has('keep')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('still prunes now-excluded files after pattern addition (other direction)', async () => {
    writeFileSync(resolve(contentDir, 'keep.md'), '# Keep\n');
    writeFileSync(resolve(contentDir, 'will-hide.md'), '# Will hide\n');
    writeFileSync(resolve(tmpDir, '.okignore'), '');

    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      expect(handle.getFileIndex().has('keep')).toBe(true);
      expect(handle.getFileIndex().has('will-hide')).toBe(true);

      writeFileSync(resolve(tmpDir, '.okignore'), 'will-hide.md\n');
      const result = await filter.rebuildIgnorePatterns();
      expect(result.ok).toBe(true);

      const { prunedFiles, prunedFolders } = await reconcileFileIndexAfterFilterRebuild(handle);
      expect(prunedFiles).toBe(1);
      expect(prunedFolders).toBe(0);
      expect(handle.getFileIndex().has('will-hide')).toBe(false);
      expect(handle.getFileIndex().has('keep')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('re-includes a previously-excluded folder + its files after pattern removal', async () => {
    mkdirSync(resolve(contentDir, 'archive', 'sub'), { recursive: true });
    writeFileSync(resolve(contentDir, 'archive', 'sub', 'old.md'), '# Old\n');
    writeFileSync(resolve(contentDir, 'keep.md'), '# Keep\n');
    writeFileSync(resolve(tmpDir, '.okignore'), 'archive/\n');

    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      expect(handle.getFolderIndex().has('archive')).toBe(false);
      expect(handle.getFolderIndex().has('archive/sub')).toBe(false);
      expect(handle.getFileIndex().has('archive/sub/old')).toBe(false);
      expect(handle.getFileIndex().has('keep')).toBe(true);

      writeFileSync(resolve(tmpDir, '.okignore'), '');
      const result = await filter.rebuildIgnorePatterns();
      expect(result.ok).toBe(true);

      await reconcileFileIndexAfterFilterRebuild(handle);
      expect(handle.getFolderIndex().has('archive')).toBe(true);
      expect(handle.getFolderIndex().has('archive/sub')).toBe(true);
      expect(handle.getFileIndex().has('archive/sub/old')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('returns zero counts when no pattern matches existing entries', async () => {
    writeFileSync(resolve(contentDir, 'keep.md'), '# Keep\n');
    writeFileSync(resolve(tmpDir, '.okignore'), '');

    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      writeFileSync(resolve(tmpDir, '.okignore'), 'unrelated.md\n');
      await filter.rebuildIgnorePatterns();
      const { prunedFiles, prunedFolders } = await reconcileFileIndexAfterFilterRebuild(handle);
      expect(prunedFiles).toBe(0);
      expect(prunedFolders).toBe(0);
      expect(handle.getFileIndex().has('keep')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('prunes one file while re-including another in the same reconcile (pattern swap)', async () => {
    writeFileSync(resolve(contentDir, 'will-hide.md'), '# Will hide\n');
    writeFileSync(resolve(contentDir, 'was-hidden.md'), '# Was hidden\n');
    writeFileSync(resolve(tmpDir, '.okignore'), 'was-hidden.md\n');

    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      expect(handle.getFileIndex().has('will-hide')).toBe(true);
      expect(handle.getFileIndex().has('was-hidden')).toBe(false);

      writeFileSync(resolve(tmpDir, '.okignore'), 'will-hide.md\n');
      const result = await filter.rebuildIgnorePatterns();
      expect(result.ok).toBe(true);

      const { prunedFiles } = await reconcileFileIndexAfterFilterRebuild(handle);
      expect(prunedFiles).toBe(1);
      expect(handle.getFileIndex().has('will-hide')).toBe(false);
      expect(handle.getFileIndex().has('was-hidden')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('returns zero counts when watcher is undefined (defensive guard)', async () => {
    const { prunedFiles, prunedFolders } = await reconcileFileIndexAfterFilterRebuild(undefined);
    expect(prunedFiles).toBe(0);
    expect(prunedFolders).toBe(0);
  });
});

describe('file-watcher ContentFilter refcount hooks', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-watcher-refcount-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('.md rename across directories triggers decrement on old dir and increment on new dir', async () => {
    mkdirSync(resolve(contentDir, 'old-dir'));
    mkdirSync(resolve(contentDir, 'new-dir'));
    writeFileSync(resolve(contentDir, 'old-dir', 'doc.md'), '# Doc\n');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    expect(filter.isExcluded('old-dir/img.png')).toBe(false);
    expect(filter.isExcluded('new-dir/img.png')).toBe(true);

    const oldPath = resolve(contentDir, 'old-dir', 'doc.md');
    const newPath = resolve(contentDir, 'new-dir', 'doc.md');
    updateLastKnownHash(oldPath, contentHash('# Doc\n'));
    writeFileSync(newPath, '# Doc\n');

    const events = await classifyEvents(
      [
        { type: 'delete', path: oldPath },
        { type: 'create', path: newPath },
      ],
      contentDir,
      filter,
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('rename');

    if (events[0].kind === 'rename') {
      const { dirname } = await import('node:path');
      filter.decrementMdDir(dirname(events[0].oldDocName));
      filter.incrementMdDir(dirname(events[0].newDocName));
    }

    expect(filter.isExcluded('old-dir/img.png')).toBe(true);
    expect(filter.isExcluded('new-dir/img.png')).toBe(false);
  });

  test('same-batch md+asset create in a brand-new directory: asset is dispatched (md-first ordering)', async () => {
    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    expect(filter.isExcluded('fresh/pic.png')).toBe(true);

    const newDir = resolve(contentDir, 'fresh');
    mkdirSync(newDir);
    const mdPath = resolve(newDir, 'note.md');
    const assetPath = resolve(newDir, 'pic.png');
    writeFileSync(mdPath, '# Note\n');
    writeFileSync(assetPath, 'fake-png-bytes');

    const collected: DiskEvent[] = [];
    await handleRawEvents(
      [
        { type: 'create', path: mdPath },
        { type: 'create', path: assetPath },
      ],
      contentDir,
      filter,
      new Map(),
      new Map(),
      async (e) => {
        collected.push(e);
      },
    );

    const kinds = collected.map((e) => e.kind).sort();
    expect(kinds).toEqual(['asset-create', 'create', 'file-create']);
    const asset = collected.find((e) => e.kind === 'asset-create');
    expect(asset?.kind).toBe('asset-create');
    if (asset?.kind === 'asset-create') {
      expect(asset.relativePath).toBe('fresh/pic.png');
    }
    expect(filter.isExcluded('fresh/pic.png')).toBe(false);
  });

  test('LINKABLE_ASSET_EXTENSIONS: .base file alongside .md dispatches asset-create event', async () => {
    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const newDir = resolve(contentDir, 'canvas-test');
    mkdirSync(newDir);
    const mdPath = resolve(newDir, 'note.md');
    const assetPath = resolve(newDir, 'board.base');
    writeFileSync(mdPath, '# Note\n');
    writeFileSync(assetPath, '{}');

    const collected: DiskEvent[] = [];
    await handleRawEvents(
      [
        { type: 'create', path: mdPath },
        { type: 'create', path: assetPath },
      ],
      contentDir,
      filter,
      new Map(),
      new Map(),
      async (e) => {
        collected.push(e);
      },
    );

    const kinds = collected.map((e) => e.kind).sort();
    expect(kinds).toEqual(['asset-create', 'create', 'file-create']);
    const asset = collected.find((e) => e.kind === 'asset-create');
    if (asset?.kind === 'asset-create') {
      expect(asset.relativePath).toBe('canvas-test/board.base');
    }
  });

  test('folder create/delete events update the folder index', async () => {
    const folderIndex = new Map();
    const collected: DiskEvent[] = [];
    const notesDir = resolve(contentDir, 'notes');
    const nestedDir = resolve(notesDir, 'nested');
    mkdirSync(nestedDir, { recursive: true });

    await handleRawEvents(
      [
        { type: 'create', path: notesDir },
        { type: 'create', path: nestedDir },
      ],
      contentDir,
      undefined,
      new Map(),
      folderIndex,
      async (e) => {
        collected.push(e);
      },
    );

    expect(folderIndex.has('notes')).toBe(true);
    expect(folderIndex.has('notes/nested')).toBe(true);
    expect(collected).toContainEqual(
      expect.objectContaining({ kind: 'folder-create', relativePath: 'notes' }),
    );
    expect(collected).toContainEqual(
      expect.objectContaining({ kind: 'folder-create', relativePath: 'notes/nested' }),
    );

    await rm(notesDir, { recursive: true, force: true });
    await handleRawEvents(
      [{ type: 'delete', path: notesDir }],
      contentDir,
      undefined,
      new Map(),
      folderIndex,
      async (e) => {
        collected.push(e);
      },
    );

    expect(folderIndex.has('notes')).toBe(false);
    expect(folderIndex.has('notes/nested')).toBe(false);
    expect(collected).toContainEqual(
      expect.objectContaining({ kind: 'folder-delete', relativePath: 'notes' }),
    );
  });

  test('mkdir -p race: single create event for parent surfaces folder-create for all pre-existing subdirs', async () => {
    const folderIndex = new Map();
    const collected: DiskEvent[] = [];
    const deepDir = resolve(contentDir, 'deep');
    const nestedDir = resolve(deepDir, 'nested');
    const emptyDir = resolve(nestedDir, 'empty');
    mkdirSync(emptyDir, { recursive: true });

    await handleRawEvents(
      [{ type: 'create', path: deepDir }],
      contentDir,
      undefined,
      new Map(),
      folderIndex,
      async (e) => {
        collected.push(e);
      },
    );

    expect(folderIndex.has('deep')).toBe(true);
    expect(folderIndex.has('deep/nested')).toBe(true);
    expect(folderIndex.has('deep/nested/empty')).toBe(true);
    expect(collected).toContainEqual(
      expect.objectContaining({ kind: 'folder-create', relativePath: 'deep' }),
    );
    expect(collected).toContainEqual(
      expect.objectContaining({ kind: 'folder-create', relativePath: 'deep/nested' }),
    );
    expect(collected).toContainEqual(
      expect.objectContaining({ kind: 'folder-create', relativePath: 'deep/nested/empty' }),
    );

    const folderEvents = collected
      .filter((e) => e.kind === 'folder-create')
      .map((e) => e.relativePath);
    expect(folderEvents.indexOf('deep')).toBeLessThan(folderEvents.indexOf('deep/nested'));
    expect(folderEvents.indexOf('deep/nested')).toBeLessThan(
      folderEvents.indexOf('deep/nested/empty'),
    );
  });

  test('rescan does not double-emit when an inner folder already arrived as its own raw event', async () => {
    const folderIndex = new Map();
    const collected: DiskEvent[] = [];
    const deepDir = resolve(contentDir, 'deep');
    const nestedDir = resolve(deepDir, 'nested');
    mkdirSync(nestedDir, { recursive: true });

    await handleRawEvents(
      [
        { type: 'create', path: deepDir },
        { type: 'create', path: nestedDir },
      ],
      contentDir,
      undefined,
      new Map(),
      folderIndex,
      async (e) => {
        collected.push(e);
      },
    );

    const nestedCreates = collected.filter(
      (e) => e.kind === 'folder-create' && e.relativePath === 'deep/nested',
    );
    expect(nestedCreates).toHaveLength(1);
  });
});

describe('startWatcher symlink handling', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = realpathSync(await mkdtemp(resolve(tmpdir(), 'ok-watcher-symlink-')));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('indexes symlinked file with canonical docName and registers alias', async () => {
    const targetPath = resolve(contentDir, 'target.md');
    const linkPath = resolve(contentDir, 'link.md');
    writeFileSync(targetPath, '# Target\n');
    symlinkSync(targetPath, linkPath);

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const index = handle.getFileIndex();
      const aliasMap = handle.getAliasMap();

      expect(index.has('target')).toBe(true);
      expect(aliasMap.get('link')).toBe('target');

      const entry = index.get('target');
      expect(entry).toBeTruthy();
      expect(entry?.canonicalPath).toBe(targetPath);
      expect(entry?.inode).toBeGreaterThan(0);
      expect(entry?.aliases).toContain('link');
    } finally {
      await handle.unsubscribe();
    }
  });

  test('records a folder-alias edge for a symlinked directory without materializing its subtree', async () => {
    const canonicalDir = resolve(contentDir, 'canonical');
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(resolve(canonicalDir, 'note.md'), '# Note\n');
    mkdirSync(resolve(canonicalDir, 'sub'), { recursive: true });
    writeFileSync(resolve(canonicalDir, 'sub', 'deep.md'), '# Deep\n');
    symlinkSync(canonicalDir, resolve(contentDir, 'aliasA'));
    symlinkSync(canonicalDir, resolve(contentDir, 'aliasB'));

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const folderAliasIndex = handle.getFolderAliasIndex();
      expect(folderAliasIndex.get('aliasA')).toBe('canonical');
      expect(folderAliasIndex.get('aliasB')).toBe('canonical');

      const index = handle.getFileIndex();
      expect(index.has('canonical/note')).toBe(true);
      expect(index.has('canonical/sub/deep')).toBe(true);
      expect(index.has('aliasA/note')).toBe(false);
      expect(index.has('aliasB/sub/deep')).toBe(false);

      const folderIndex = handle.getFolderIndex();
      expect(folderIndex.has('canonical')).toBe(true);
      expect(folderIndex.has('canonical/sub')).toBe(true);
      expect(folderIndex.has('aliasA')).toBe(false);
      expect(folderIndex.has('aliasB')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('skips broken symlinks during startup walk', async () => {
    const linkPath = resolve(contentDir, 'broken.md');
    symlinkSync(resolve(contentDir, 'nonexistent.md'), linkPath);
    writeFileSync(resolve(contentDir, 'good.md'), '# Good\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const index = handle.getFileIndex();
      expect(index.has('good')).toBe(true);
      expect(index.has('broken')).toBe(false);
      expect(index.has('nonexistent')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('skips symlinks escaping contentDir during startup walk', async () => {
    const outsideDir = resolve(tmpDir, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = resolve(outsideDir, 'secret.md');
    writeFileSync(outsideFile, '# Secret\n');

    const escapePath = resolve(contentDir, 'escape.md');
    symlinkSync(outsideFile, escapePath);
    writeFileSync(resolve(contentDir, 'safe.md'), '# Safe\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const index = handle.getFileIndex();
      expect(index.has('safe')).toBe(true);
      expect(index.has('escape')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('drops runtime events for symlinks whose target escapes contentDir', async () => {
    const outsideDir = resolve(tmpDir, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = resolve(outsideDir, 'secret.md');
    writeFileSync(outsideFile, '# external secrets\n');

    const escapePath = resolve(contentDir, 'escape.md');
    symlinkSync(outsideFile, escapePath);

    const collected: DiskEvent[] = [];
    await handleRawEvents(
      [{ type: 'create', path: escapePath }],
      contentDir,
      undefined,
      new Map(),
      new Map(),
      async (e) => {
        collected.push(e);
      },
    );

    expect(collected).toHaveLength(0);
  });

  test('drops runtime events for asset symlinks whose target escapes contentDir', async () => {
    const outsideDir = resolve(tmpDir, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    const outsideAsset = resolve(outsideDir, 'leak.png');
    writeFileSync(outsideAsset, 'fake-png');

    const escapePath = resolve(contentDir, 'leak.png');
    symlinkSync(outsideAsset, escapePath);

    const collected: DiskEvent[] = [];
    await handleRawEvents(
      [{ type: 'create', path: escapePath }],
      contentDir,
      undefined,
      new Map(),
      new Map(),
      async (e) => {
        collected.push(e);
      },
    );

    expect(collected).toHaveLength(0);
  });

  test('preserves runtime events for symlinks pointing inside contentDir', async () => {
    const targetPath = resolve(contentDir, 'real-target.md');
    const aliasPath = resolve(contentDir, 'alias.md');
    writeFileSync(targetPath, '# real\n');
    symlinkSync(targetPath, aliasPath);

    const aliasMap = new Map<string, string>();
    const collected: DiskEvent[] = [];
    await handleRawEvents(
      [{ type: 'create', path: aliasPath }],
      contentDir,
      undefined,
      new Map(),
      new Map(),
      async (e) => {
        collected.push(e);
      },
      aliasMap,
    );

    expect(collected).toHaveLength(1);
    expect(collected[0].kind).toBe('create');
    if (collected[0].kind === 'create') {
      expect(collected[0].docName).toBe('real-target');
    }
    expect(aliasMap.get('alias')).toBe('real-target');
  });

  test('skips symlink-to-excluded-dir (node_modules inside contentDir) during startup walk', async () => {
    const realNm = resolve(contentDir, 'node_modules');
    mkdirSync(realNm, { recursive: true });
    symlinkSync(resolve(realNm, 'nonexistent'), resolve(realNm, 'broken-pkg'));
    writeFileSync(resolve(realNm, 'README.md'), '# Pkg\n');

    const subPkg = resolve(contentDir, 'packages', 'foo');
    mkdirSync(subPkg, { recursive: true });
    symlinkSync(realNm, resolve(subPkg, 'node_modules'));

    writeFileSync(resolve(contentDir, 'docs.md'), '# Docs\n');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      const index = handle.getFileIndex();
      expect(index.has('docs')).toBe(true);
      expect(index.has('node_modules/README')).toBe(false);
      expect(index.has('packages/foo/node_modules/README')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('handles cyclic symlink directories without infinite loop', async () => {
    const dirA = resolve(contentDir, 'dir-a');
    const dirB = resolve(contentDir, 'dir-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(resolve(dirA, 'file.md'), '# File A\n');

    symlinkSync(dirB, resolve(dirA, 'link-to-b'));
    symlinkSync(dirA, resolve(dirB, 'link-to-a'));

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const index = handle.getFileIndex();
      expect(index.has('dir-a/file')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('FileIndexEntry has canonicalPath, inode, and aliases fields', async () => {
    writeFileSync(resolve(contentDir, 'regular.md'), '# Regular\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const entry = handle.getFileIndex().get('regular');
      expect(entry).toBeTruthy();
      expect(entry?.canonicalPath).toBe(resolve(contentDir, 'regular.md'));
      expect(entry?.inode).toBeGreaterThan(0);
      expect(entry?.aliases).toEqual([]);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('classifyEvents resolves alias docName to canonical', async () => {
    const targetPath = resolve(contentDir, 'target.md');
    const linkPath = resolve(contentDir, 'link.md');
    writeFileSync(targetPath, '# Target\n');
    symlinkSync(targetPath, linkPath);

    const aliasMap = new Map([['link', 'target']]);
    updateLastKnownHash(linkPath, contentHash('# Target\n'));

    writeFileSync(targetPath, '# Updated\n');

    const events = await classifyEvents(
      [{ type: 'update', path: linkPath }],
      contentDir,
      undefined,
      aliasMap,
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('update');
    if (events[0].kind === 'update') {
      expect(events[0].docName).toBe('target');
    }
  });

  test('self-write detection works with canonical path after symlink resolution', async () => {
    const targetPath = resolve(contentDir, 'target.md');
    const linkPath = resolve(contentDir, 'link.md');
    writeFileSync(targetPath, '# Original\n');
    symlinkSync(targetPath, linkPath);

    const markdown = '# Updated via symlink\n';
    const hash = contentHash(markdown);

    registerWrite(targetPath, hash);

    expect(isSelfWrite(targetPath, hash)).toBe(true);
  });

  test('classifyEvents live-resolves symlink created post-startup and updates aliasMap', async () => {
    const targetPath = resolve(contentDir, 'new-target.md');
    const linkPath = resolve(contentDir, 'new-link.md');
    writeFileSync(targetPath, '# Target\n');
    symlinkSync(targetPath, linkPath);

    const aliasMap = new Map<string, string>();

    const events = await classifyEvents(
      [{ type: 'create', path: linkPath }],
      contentDir,
      undefined,
      aliasMap,
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('create');
    if (events[0].kind === 'create') {
      expect(events[0].docName).toBe('new-target');
    }
    expect(aliasMap.get('new-link')).toBe('new-target');
  });

  test('classifyEvents re-resolves a repointed symlink and updates aliasMap', async () => {
    const oldTargetPath = resolve(contentDir, 'old-target.md');
    const newTargetPath = resolve(contentDir, 'fresh-target.md');
    const aliasPath = resolve(contentDir, 'alias.md');
    writeFileSync(oldTargetPath, '# Old\n');
    writeFileSync(newTargetPath, '# Fresh\n');
    symlinkSync(newTargetPath, aliasPath);

    const aliasMap = new Map<string, string>([['alias', 'old-target']]);

    const events = await classifyEvents(
      [{ type: 'update', path: aliasPath }],
      contentDir,
      undefined,
      aliasMap,
    );

    expect(events).toHaveLength(1);
    if (events[0].kind === 'update') {
      expect(events[0].docName).toBe('fresh-target');
    }
    expect(aliasMap.get('alias')).toBe('fresh-target');
  });
});
