import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { AllFileEntries, FileIndexEntry, FolderIndexEntry } from './file-watcher.ts';
import {
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
