import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { FileIndexEntry } from './file-watcher.ts';
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
});
