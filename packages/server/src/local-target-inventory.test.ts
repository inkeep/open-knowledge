import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { AllFileEntries, FileIndexEntry, FolderIndexEntry } from './file-watcher.ts';
import {
  createFileExistsOracle,
  createTrackedFileResolver,
  localTargetInventoryFromIndexes,
  localTargetInventoryFromWatcher,
} from './local-target-inventory.ts';

function entry(
  kind: FileIndexEntry['kind'],
  canonicalPath: string,
  aliases: string[] = [],
): FileIndexEntry {
  return {
    kind,
    canonicalPath,
    aliases,
    inode: 1,
    modified: '2026-01-01T00:00:00.000Z',
    size: 1,
  };
}

describe('localTargetInventoryFromIndexes', () => {
  test.each(['markdown-first', 'file-first'] as const)(
    'keeps same-name document and file targets separate with %s input',
    (order) => {
      const contentDir = '/project/content';
      const document: readonly [string, FileIndexEntry] = [
        'canonical/real.csv',
        entry('markdown', join(contentDir, 'canonical/real.csv.md'), ['document-link']),
      ];
      const file: readonly [string, FileIndexEntry] = [
        'canonical/real.csv',
        entry('file', join(contentDir, 'canonical/real.csv'), ['asset-link.csv']),
      ];
      const allFiles: AllFileEntries =
        order === 'markdown-first' ? [document, file] : [file, document];
      const folderAliases = new Map([['mirror', 'canonical']]);
      const folderIndex = new Map<string, FolderIndexEntry>([
        [
          'canonical',
          {
            size: 0,
            modified: '2026-01-01T00:00:00.000Z',
            canonicalPath: join(contentDir, 'canonical'),
            inode: 1,
          },
        ],
      ]);

      const inventory = localTargetInventoryFromIndexes(
        allFiles,
        folderAliases,
        contentDir,
        folderIndex,
      );

      expect(inventory.documentTargets.toSorted()).toEqual(
        ['canonical/real.csv', 'document-link', 'mirror/real.csv'].toSorted(),
      );
      expect(inventory.fileTargets.toSorted()).toEqual(
        ['asset-link.csv', 'canonical/real.csv', 'mirror/real.csv'].toSorted(),
      );
      expect(inventory.folderTargets.toSorted()).toEqual(['canonical', 'mirror']);
      expect(
        localTargetInventoryFromIndexes(allFiles, folderAliases, contentDir, folderIndex),
      ).toEqual(inventory);
    },
  );

  test('includes indexed, canonical, direct-alias, and folder-alias identities by kind', () => {
    const contentDir = '/project/content';
    const allFiles = new Map<string, FileIndexEntry>([
      [
        'canonical/guide',
        entry('markdown', join(contentDir, 'canonical/guide.md'), ['direct-guide']),
      ],
      [
        'direct-report.csv',
        entry('file', join(contentDir, 'canonical/report.csv'), ['other-report.csv']),
      ],
    ]);

    const inventory = localTargetInventoryFromIndexes(
      allFiles,
      new Map([['folder-alias', 'canonical']]),
      contentDir,
    );

    expect(inventory.documentTargets).toEqual(
      expect.arrayContaining(['canonical/guide', 'direct-guide', 'folder-alias/guide']),
    );
    expect(inventory.fileTargets).toEqual(
      expect.arrayContaining([
        'direct-report.csv',
        'other-report.csv',
        'canonical/report.csv',
        'folder-alias/report.csv',
      ]),
    );
  });

  test('carries the watcher folder index as folderTargets, with folder-alias projection', () => {
    const contentDir = '/project/content';
    const inventory = localTargetInventoryFromIndexes(
      new Map(),
      new Map([['folder-alias', 'canonical']]),
      contentDir,
      new Map([
        ['canonical', { modified: '2026-01-01T00:00:00.000Z' } as never],
        ['canonical/assets-only', { modified: '2026-01-01T00:00:00.000Z' } as never],
      ]),
    );

    expect(inventory.folderTargets).toEqual(
      expect.arrayContaining([
        'canonical',
        'canonical/assets-only',
        'folder-alias',
        'folder-alias/assets-only',
      ]),
    );
  });

  test('distinguishes an unavailable watcher from an empty authoritative inventory', () => {
    expect(localTargetInventoryFromWatcher(null, '/project/content')).toBeNull();
  });

  test('memoizes the projected inventory until the watcher generation changes', () => {
    const contentDir = '/project/content';
    const allFiles = new Map<string, FileIndexEntry>([
      ['asset.png', entry('file', join(contentDir, 'asset.png'))],
    ]);
    let generation = 1;
    const watcher = {
      getAllFilesIndex: () => allFiles,
      getFileIndexGeneration: () => generation,
      getFolderAliasIndex: () => new Map<string, string>(),
    };

    const first = localTargetInventoryFromWatcher(watcher, contentDir);
    expect(localTargetInventoryFromWatcher(watcher, contentDir)).toBe(first);

    generation++;
    expect(localTargetInventoryFromWatcher(watcher, contentDir)).not.toBe(first);
  });

  test('projects every regular member and actual symlink through folder aliases as generation changes', () => {
    const contentDir = '/project/content';
    const rich = {
      ...entry('file', join(contentDir, 'outside/atlas.csv')),
      aliases: ['linked-atlas.csv', 'linked-beacon.csv'],
      fileMembers: {
        regularPaths: ['outside/atlas.csv', 'canonical/beacon.csv'],
        symlinks: [
          { path: 'linked-atlas.csv', targetPath: 'outside/atlas.csv' },
          { path: 'linked-beacon.csv', targetPath: 'canonical/beacon.csv' },
        ],
      },
    };
    const allFiles = new Map<string, FileIndexEntry>([['outside/atlas.csv', rich]]);
    let generation = 1;
    const watcher = {
      getAllFilesIndex: () => allFiles,
      getFileIndexGeneration: () => generation,
      getFolderAliasIndex: () => new Map([['mirror', 'canonical']]),
    };

    const first = localTargetInventoryFromWatcher(watcher, contentDir);
    expect
      .soft(first?.fileTargets.toSorted())
      .toEqual(
        [
          'outside/atlas.csv',
          'canonical/beacon.csv',
          'mirror/beacon.csv',
          'linked-atlas.csv',
          'linked-beacon.csv',
        ].toSorted(),
      );
    expect(localTargetInventoryFromWatcher(watcher, contentDir)).toBe(first);

    const changedRich = {
      ...rich,
      fileMembers: {
        ...rich.fileMembers,
        regularPaths: ['outside/atlas.csv', 'canonical/beacon.csv', 'canonical/comet.csv'],
      },
    };
    allFiles.set('outside/atlas.csv', changedRich);
    expect(localTargetInventoryFromWatcher(watcher, contentDir)).toBe(first);
    generation++;
    const changed = localTargetInventoryFromWatcher(watcher, contentDir);
    expect(changed).not.toBe(first);
    expect
      .soft(changed?.fileTargets.toSorted())
      .toEqual(
        [
          'outside/atlas.csv',
          'canonical/beacon.csv',
          'canonical/comet.csv',
          'mirror/beacon.csv',
          'mirror/comet.csv',
          'linked-atlas.csv',
          'linked-beacon.csv',
        ].toSorted(),
      );
    expect(changed?.documentTargets).toEqual([]);
  });
});

describe('createTrackedFileResolver', () => {
  const contentDir = '/project/content';
  const CAFE_NFD = 'assets/Café.png'.normalize('NFD');
  const CAFE_NFC = 'assets/Café.png'.normalize('NFC');

  function watcherOver(allFiles: Map<string, FileIndexEntry>, generation: () => number) {
    return {
      getAllFilesIndex: () => allFiles,
      getFileIndexGeneration: generation,
      getFolderAliasIndex: () => new Map<string, string>(),
    };
  }

  test('resolves a requested spelling to the tracked raw file under the file identity rule', () => {
    const allFiles = new Map<string, FileIndexEntry>([
      [CAFE_NFD, entry('file', join(contentDir, CAFE_NFD))],
      ['Pics/Deep/x.png', entry('file', join(contentDir, 'Pics/Deep/x.png'))],
      ['notes', entry('markdown', join(contentDir, 'notes.md'))],
    ]);
    const watcher = watcherOver(allFiles, () => 1);
    const resolve = createTrackedFileResolver(() =>
      localTargetInventoryFromWatcher(watcher, contentDir),
    );

    expect(resolve(CAFE_NFC)).toBe(CAFE_NFD);
    expect(resolve(CAFE_NFD)).toBe(CAFE_NFD);
    expect(resolve('assets/CAFÉ.PNG')).toBe(CAFE_NFD);
    expect(resolve('Pics/Deep/X.PNG')).toBe('Pics/Deep/x.png');
    expect(resolve('pics/deep/x.png')).toBeUndefined();
    expect(resolve('notes.md')).toBeUndefined();
    expect(resolve('missing.png')).toBeUndefined();
  });

  test('follows the watcher inventory as its generation changes', () => {
    const allFiles = new Map<string, FileIndexEntry>();
    let generation = 1;
    const watcher = watcherOver(allFiles, () => generation);
    const resolve = createTrackedFileResolver(() =>
      localTargetInventoryFromWatcher(watcher, contentDir),
    );
    expect(resolve(CAFE_NFC)).toBeUndefined();

    allFiles.set(CAFE_NFD, entry('file', join(contentDir, CAFE_NFD)));
    generation++;
    expect(resolve(CAFE_NFC)).toBe(CAFE_NFD);

    allFiles.delete(CAFE_NFD);
    generation++;
    expect(resolve(CAFE_NFC)).toBeUndefined();
  });

  test('resolves nothing while the watcher inventory is unavailable', () => {
    expect(createTrackedFileResolver(() => null)('assets/photo.png')).toBeUndefined();
  });
});

describe('createFileExistsOracle', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function project(): string {
    const root = mkdtempSync(join(tmpdir(), 'ok-file-exists-'));
    roots.push(root);
    mkdirSync(join(root, 'Sub'));
    writeFileSync(join(root, 'Sub', 'page.md'), '# Page\n');
    writeFileSync(join(root, 'Makefile'), 'all:\n');
    return root;
  }

  test('accepts a tracked file and an untracked regular file on disk', () => {
    const exists = createFileExistsOracle(['assets/logo.png'], project(), undefined);
    expect(exists('assets/logo.png')).toBe(true);
    expect(exists('Makefile')).toBe(true);
    expect(exists('missing.txt')).toBe(false);
  });

  test('never accepts a directory as an existing file', () => {
    const exists = createFileExistsOracle([], project(), undefined);
    expect(exists('Sub')).toBe(false);
    expect(exists('Sub/')).toBe(false);
  });

  test('refuses an ignored path', () => {
    const exists = createFileExistsOracle([], project(), {
      isPathIgnored: (path) => path === 'Makefile',
    });
    expect(exists('Makefile')).toBe(false);
  });

  test('refuses an existing file outside the content root, directly or through a symlink', () => {
    const outer = mkdtempSync(join(tmpdir(), 'ok-file-exists-outer-'));
    roots.push(outer);
    const root = join(outer, 'content');
    mkdirSync(root);
    writeFileSync(join(outer, 'outside.txt'), 'secret\n');
    symlinkSync(join(outer, 'outside.txt'), join(root, 'escape.txt'));
    const exists = createFileExistsOracle([], root, undefined);
    expect(existsSync(join(root, '..', 'outside.txt'))).toBe(true);
    expect(existsSync(join(root, 'escape.txt'))).toBe(true);
    expect(exists('../outside.txt')).toBe(false);
    expect(exists('escape.txt')).toBe(false);
  });
});
