import type { GitWorktreeEntry } from '@inkeep/open-knowledge-core';

/**
 * How many folder groups a section may show before rows get rolled up into
 * shallower directories. Eight fits the popover without scrolling; past that
 * the listing stops reading as a summary and becomes the flat list it replaced.
 */
export const MAX_WORKTREE_GROUPS = 8;

/** Rows a group renders before it collapses the remainder into a "+N more". */
export const MAX_ROWS_PER_GROUP = 6;

export interface WorktreeRowModel {
  entry: GitWorktreeEntry;
  /** What the row renders: the path minus whatever its container already states. */
  label: string;
}

export interface WorktreeFolderGroup {
  /** Directory this group hoists, relative to the section prefix. Never empty. */
  dir: string;
  rows: WorktreeRowModel[];
}

export interface WorktreeGrouping {
  /**
   * Directory every entry in the section shares, stated once above the list.
   * Empty when they share nothing.
   */
  prefix: string;
  /** Folder buckets worth a disclosure — always more than one row each. */
  groups: WorktreeFolderGroup[];
  /**
   * Entries that never earned a bucket, rendered as plain rows. A group of one
   * is worse than no group: it costs a click and a line to reveal a single file.
   */
  loose: WorktreeRowModel[];
}

/** Directory portion of a POSIX path; '' when the path has no separator. */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function segments(dir: string): string[] {
  return dir === '' ? [] : dir.split('/');
}

/**
 * Longest directory shared by every path, compared segment-wise.
 *
 * Segment-wise, not character-wise: `notes/alpha` and `notes/beta` share the
 * string prefix `notes/`+`a`/`b`… — a character comparison would happily hoist
 * `notes/` plus a partial name and produce labels that are not paths.
 */
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

/**
 * Bucket changed paths into a hoisted prefix, collapsible folder groups, and
 * loose rows.
 *
 * Every level exists to state a path segment exactly once. The section prefix
 * carries what all entries share, a group header carries what its members
 * share, and the row carries only the remainder — because the flat listing this
 * replaces rendered the full path per row under `truncate`, which clips the
 * TAIL, so N files under one deep directory rendered as N identical strings.
 *
 * Grouping starts at each entry's own directory, then rolls the DEEPEST groups
 * up one segment at a time until the count fits `maxGroups`. Trimming deepest
 * first is what turns thirteen sibling `locales/<lang>` directories into one
 * `locales` group instead of shortening unrelated shallow paths that were
 * already legible.
 */
export function groupWorktreeEntries(
  entries: GitWorktreeEntry[],
  maxGroups: number = MAX_WORKTREE_GROUPS,
): WorktreeGrouping {
  if (entries.length === 0) return { prefix: '', groups: [], loose: [] };
  // Hoisting exists to stop a directory repeating. With one entry there is no
  // repetition to remove, and lifting its folder onto its own line splits a
  // short path across two lines to save nothing.
  if (entries.length === 1) {
    return { prefix: '', groups: [], loose: [{ entry: entries[0], label: entries[0].path }] };
  }

  const prefix = commonDirPrefix(entries.map((e) => e.path));
  // Every key below is relative to `prefix`, so the roll-up can never chew into
  // the part already stated above the list.
  const keyed = entries.map((entry) => {
    const rel = relativeTo(prefix, entry.path);
    return { entry, rel, key: dirOf(rel) };
  });

  const distinct = () => new Set(keyed.map((k) => k.key));
  while (distinct().size > maxGroups) {
    const maxDepth = Math.max(...keyed.map((k) => segments(k.key).length));
    // Everything is already at the root of the prefix: nothing left to trim, so
    // stop rather than spin.
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
    // Rows sitting directly under the hoisted prefix have no folder left to
    // name, and a lone file does not earn a disclosure — both go loose, showing
    // their full remainder so they stay identifiable without a header.
    if (dir === '' || rows.length === 1) {
      for (const row of rows)
        loose.push({ entry: row.entry, label: relativeTo(prefix, row.entry.path) });
    } else {
      groups.push({ dir, rows });
    }
  }

  // Biggest first — the bucket responsible for the noise is the one worth
  // opening. Ties break on path so the order does not shuffle between polls.
  groups.sort((a, b) => b.rows.length - a.rows.length || a.dir.localeCompare(b.dir));
  loose.sort((a, b) => a.entry.path.localeCompare(b.entry.path));
  return { prefix, groups, loose };
}
