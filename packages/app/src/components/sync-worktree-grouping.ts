import type { GitWorktreeEntry } from '@inkeep/open-knowledge-core';

export const MAX_WORKTREE_GROUPS = 8;

export const MAX_ROWS_PER_GROUP = 6;

export interface WorktreeRowModel {
  entry: GitWorktreeEntry;
  label: string;
}

export interface WorktreeFolderGroup {
  dir: string;
  rows: WorktreeRowModel[];
}

export interface WorktreeGrouping {
  prefix: string;
  groups: WorktreeFolderGroup[];
  loose: WorktreeRowModel[];
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function segments(dir: string): string[] {
  return dir === '' ? [] : dir.split('/');
}

export function commonDirPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  let common = segments(dirOf(paths[0]));
  for (const path of paths.slice(1)) {
    const segs = segments(dirOf(path));
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++;
    common = common.slice(0, i);
    if (common.length === 0) break;
  }
  return common.join('/');
}

function relativeTo(prefix: string, path: string): string {
  return prefix === '' ? path : path.slice(prefix.length + 1);
}

export function groupWorktreeEntries(
  entries: GitWorktreeEntry[],
  maxGroups: number = MAX_WORKTREE_GROUPS,
): WorktreeGrouping {
  if (entries.length === 0) return { prefix: '', groups: [], loose: [] };
  if (entries.length === 1) {
    return { prefix: '', groups: [], loose: [{ entry: entries[0], label: entries[0].path }] };
  }

  const prefix = commonDirPrefix(entries.map((e) => e.path));
  const keyed = entries.map((entry) => {
    const rel = relativeTo(prefix, entry.path);
    return { entry, rel, key: dirOf(rel) };
  });

  const distinct = () => new Set(keyed.map((k) => k.key));
  while (distinct().size > maxGroups) {
    const maxDepth = Math.max(...keyed.map((k) => segments(k.key).length));
    if (maxDepth === 0) break;
    for (const k of keyed) {
      if (segments(k.key).length === maxDepth) k.key = dirOf(k.key);
    }
  }

  const byKey = new Map<string, WorktreeRowModel[]>();
  for (const { entry, rel, key } of keyed) {
    const rows = byKey.get(key) ?? [];
    rows.push({ entry, label: key === '' ? rel : rel.slice(key.length + 1) });
    byKey.set(key, rows);
  }

  const groups: WorktreeFolderGroup[] = [];
  const loose: WorktreeRowModel[] = [];
  for (const [dir, rows] of byKey) {
    if (dir === '' || rows.length === 1) {
      for (const row of rows)
        loose.push({ entry: row.entry, label: relativeTo(prefix, row.entry.path) });
    } else {
      groups.push({ dir, rows });
    }
  }

  groups.sort((a, b) => b.rows.length - a.rows.length || a.dir.localeCompare(b.dir));
  loose.sort((a, b) => a.entry.path.localeCompare(b.entry.path));
  return { prefix, groups, loose };
}
