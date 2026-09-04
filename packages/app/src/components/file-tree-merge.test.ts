import { describe, expect, test } from 'vitest';
import {
  mergeAndPruneRecentLocalAdds,
  mergeRootEntriesAdditive,
  STALE_REFRESH_PRESERVE_WINDOW_MS,
  spliceLazyFolderChildren,
} from './file-tree-merge';
import type { FileEntry } from './file-tree-utils';

function doc(basename: string, modified = '2026-05-21T00:00:00.000Z'): FileEntry {
  return { kind: 'document', docName: basename, size: 0, modified };
}

function folder(path: string, modified = '2026-05-21T00:00:00.000Z'): FileEntry {
  return { kind: 'folder', path, size: 0, modified };
}

describe('mergeAndPruneRecentLocalAdds', () => {
  test('empty recentAdds: returns a copy of serverEntries unchanged (early return)', () => {
    const server = [doc('a'), doc('b')];
    const local = [doc('a'), doc('b'), doc('c')];
    const recentAdds = new Map<string, number>();

    const result = mergeAndPruneRecentLocalAdds(server, local, recentAdds);

    expect(result).toEqual(server);
    expect(result).not.toBe(server);
    expect(recentAdds.size).toBe(0);
  });

  test('server-confirmed: local entry present in server response — pruned from registry, server metadata wins', () => {
    const NOW = 1_700_000_000_000;
    const server = [doc('a', '2026-05-21T10:00:00.000Z')];
    const local = [doc('a', '2026-05-21T09:00:00.000Z')];
    const recentAdds = new Map<string, number>([['a.md', NOW]]);

    const result = mergeAndPruneRecentLocalAdds(server, local, recentAdds, NOW);

    expect(result).toEqual(server);
    expect(result[0]?.kind === 'document' ? result[0].modified : null).toBe(
      '2026-05-21T10:00:00.000Z',
    );
    expect(recentAdds.has('a.md')).toBe(false);
  });

  test('never-registered: local entry absent from both server response and registry — dropped silently', () => {
    const NOW = 1_700_000_000_000;
    const server = [doc('a')];
    const local = [doc('a'), doc('ghost')];
    const recentAdds = new Map<string, number>([['a.md', NOW]]);

    const result = mergeAndPruneRecentLocalAdds(server, local, recentAdds, NOW);

    expect(result).toEqual([doc('a')]);
    expect(recentAdds.has('ghost.md')).toBe(false);
  });

  test('window-expired: addedAt older than the preserve window — pruned from registry, dropped from result', () => {
    const NOW = 1_700_000_000_000;
    const server: FileEntry[] = [];
    const local = [doc('pending')];
    const expiredTimestamp = NOW - (STALE_REFRESH_PRESERVE_WINDOW_MS + 100);
    const recentAdds = new Map<string, number>([['pending.md', expiredTimestamp]]);

    const result = mergeAndPruneRecentLocalAdds(server, local, recentAdds, NOW);

    expect(result).toEqual([]);
    expect(recentAdds.has('pending.md')).toBe(false);
  });

  test('in-window-preserved: addedAt within window, missing from server — appended after server entries', () => {
    const NOW = 1_700_000_000_000;
    const server = [doc('a'), doc('b')];
    const local = [doc('a'), doc('b'), doc('pending')];
    const recentAdds = new Map<string, number>([['pending.md', NOW]]);

    const result = mergeAndPruneRecentLocalAdds(server, local, recentAdds, NOW);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(doc('a'));
    expect(result[1]).toEqual(doc('b'));
    expect(result[2]).toEqual(doc('pending'));
    expect(recentAdds.has('pending.md')).toBe(true);
  });

  test('in-window-preserved: folder entry (kind:"folder") keyed by trailing-slash path is preserved', () => {
    const NOW = 1_700_000_000_000;
    const server: FileEntry[] = [];
    const local = [folder('docs')];
    const recentAdds = new Map<string, number>([['docs/', NOW]]);

    const result = mergeAndPruneRecentLocalAdds(server, local, recentAdds, NOW);

    expect(result).toEqual([folder('docs')]);
    expect(recentAdds.has('docs/')).toBe(true);
  });

  test('mixed: server-confirmed pruning + in-window preservation coexist in one call', () => {
    const NOW = 1_700_000_000_000;
    const server = [doc('confirmed')];
    const local = [doc('confirmed'), doc('still-pending')];
    const recentAdds = new Map<string, number>([
      ['confirmed.md', NOW - 1000],
      ['still-pending.md', NOW - 1000],
    ]);

    const result = mergeAndPruneRecentLocalAdds(server, local, recentAdds, NOW);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(doc('confirmed'));
    expect(result[1]).toEqual(doc('still-pending'));
    expect(recentAdds.has('confirmed.md')).toBe(false);
    expect(recentAdds.has('still-pending.md')).toBe(true);
  });

  test('boundary: addedAt exactly at the preserve-window edge — preserved (strict ">", not ">=")', () => {
    const NOW = 1_700_000_000_000;
    const server: FileEntry[] = [];
    const local = [doc('edge')];
    const recentAdds = new Map<string, number>([
      ['edge.md', NOW - STALE_REFRESH_PRESERVE_WINDOW_MS],
    ]);

    const result = mergeAndPruneRecentLocalAdds(server, local, recentAdds, NOW);

    expect(result).toEqual([doc('edge')]);
    expect(recentAdds.has('edge.md')).toBe(true);
  });
});

describe('spliceLazyFolderChildren', () => {
  test('a splice for a target folder absent from the entry set is a no-op', () => {
    const current = [folder('team'), doc('README')];
    const result = spliceLazyFolderChildren(current, 'gone/', [doc('gone/x')], new Map());
    expect(result).toEqual(current);
  });

  test('replaces the folder level with the server children; entries outside it pass through', () => {
    const current = [folder('team'), folder('other'), doc('README')];
    const children = [doc('team/notes'), folder('team/sub')];
    const recentAdds = new Map<string, number>();

    const result = spliceLazyFolderChildren(current, 'team/', children, recentAdds);

    expect(result).toEqual([
      folder('team'),
      folder('other'),
      doc('README'),
      doc('team/notes'),
      folder('team/sub'),
    ]);
  });

  test('a parent-level resplice leaves already-loaded grandchildren untouched', () => {
    const current = [folder('team'), folder('team/sub'), doc('team/sub/deep'), doc('team/notes')];
    const children = [folder('team/sub')];
    const recentAdds = new Map<string, number>();

    const result = spliceLazyFolderChildren(current, 'team/', children, recentAdds);

    expect(result).toEqual([folder('team'), doc('team/sub/deep'), folder('team/sub')]);
  });

  test('sibling folders sharing the name prefix are not treated as children', () => {
    const current = [folder('team'), folder('teammates'), doc('teammates/roster')];
    const children = [doc('team/notes')];
    const recentAdds = new Map<string, number>();

    const result = spliceLazyFolderChildren(current, 'team/', children, recentAdds);

    expect(result).toEqual([
      folder('team'),
      folder('teammates'),
      doc('teammates/roster'),
      doc('team/notes'),
    ]);
  });

  test('optimistic local adds inside the folder ride the same preserve window as a full refresh', () => {
    const NOW = 1_700_000_000_000;
    const current = [folder('team'), doc('team/just-created')];
    const children = [doc('team/notes')];
    const recentAdds = new Map<string, number>([['team/just-created.md', NOW]]);

    const result = spliceLazyFolderChildren(current, 'team/', children, recentAdds, NOW);

    expect(result).toEqual([folder('team'), doc('team/notes'), doc('team/just-created')]);
    expect(recentAdds.has('team/just-created.md')).toBe(true);
  });

  test('descendants of a child folder the server no longer returns are pruned with it', () => {
    const current = [folder('team'), folder('team/sub'), doc('team/sub/deep'), doc('team/notes')];
    const children = [doc('team/notes')];
    const recentAdds = new Map<string, number>();

    const result = spliceLazyFolderChildren(current, 'team/', children, recentAdds);

    expect(result).toEqual([folder('team'), doc('team/notes')]);
  });

  test("root splice ('') replaces the top level and keeps loaded descendants of surviving folders", () => {
    const current = [
      folder('team'),
      doc('team/notes'),
      folder('gone'),
      doc('gone/stale'),
      doc('README'),
    ];
    const children = [folder('team'), doc('README'), doc('NEW')];
    const recentAdds = new Map<string, number>();

    const result = spliceLazyFolderChildren(current, '', children, recentAdds);

    expect(result).toEqual([doc('team/notes'), folder('team'), doc('README'), doc('NEW')]);
  });

  test('root splice preserves in-window optimistic adds at the root level', () => {
    const NOW = 1_700_000_000_000;
    const current = [folder('team'), doc('just-created')];
    const children = [folder('team')];
    const recentAdds = new Map<string, number>([['just-created.md', NOW]]);

    const result = spliceLazyFolderChildren(current, '', children, recentAdds, NOW);

    expect(result).toEqual([folder('team'), doc('just-created')]);
    expect(recentAdds.has('just-created.md')).toBe(true);
  });
});

describe('mergeRootEntriesAdditive', () => {
  test('empty current: returns a copy of the incoming entries', () => {
    const incoming = [doc('a'), folder('team')];
    const result = mergeRootEntriesAdditive([], incoming);
    expect(result).toEqual(incoming);
    expect(result).not.toBe(incoming);
  });

  test('empty incoming: returns a copy of the current entries unchanged', () => {
    const current = [doc('a')];
    const result = mergeRootEntriesAdditive(current, []);
    expect(result).toEqual(current);
    expect(result).not.toBe(current);
  });

  test('unions new entries onto the current set, preserving order', () => {
    const result = mergeRootEntriesAdditive([doc('a')], [doc('b'), folder('team')]);
    expect(result).toEqual([doc('a'), doc('b'), folder('team')]);
  });

  test('de-dupes by tree path — the existing entry wins on collision', () => {
    const current = [doc('a', '2026-01-01T00:00:00.000Z')];
    const incoming = [doc('a', '2099-12-31T00:00:00.000Z'), doc('b')];
    const result = mergeRootEntriesAdditive(current, incoming);
    expect(result).toEqual([doc('a', '2026-01-01T00:00:00.000Z'), doc('b')]);
  });

  test('a folder and a document collide only when their tree paths match', () => {
    const result = mergeRootEntriesAdditive([folder('team')], [folder('team'), doc('team')]);
    expect(result).toEqual([folder('team'), doc('team')]);
  });
});
