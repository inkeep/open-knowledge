/**
 * Initial walk that seeds the basename index from disk.
 *
 * The file watcher's startup walk is markdown-only — its fileIndex is
 * keyed by docName and ignores asset extensions. To populate the
 * basename index without emitting a synthetic burst of asset-create
 * events at boot, we do a separate walk here using the same admission
 * rules (ContentFilter + LINKABLE_ASSET_EXTENSIONS).
 *
 * Symlink-following is intentional but bounded: cycles are caught via
 * a `visited` inode set, escape outside contentDir is rejected via
 * realpath check.
 *
 * Per-entry errors are classified: ENOENT stays silent (concurrent
 * rename race is legit and common), all other errno codes surface via
 * the optional `onSkip` callback so the caller can push a partial-
 * degraded subsystem indicator. Without surface, EACCES on a vault
 * subtree silently truncates the walk and every embed under that
 * subtree breaks with no log signal — a real
 * "degraded[] unreachable" failure mode.
 */

import type { Dirent, Stats } from 'node:fs';
import { readdirSync } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  ASSET_EXTENSIONS,
  type BasenameIndex,
  LINKABLE_ASSET_EXTENSIONS,
} from '@inkeep/open-knowledge-core';
import type { ContentFilter } from './content-filter.ts';
import { isSupportedAssetFile } from './doc-extensions.ts';
import { isWithinDir, toPosix } from './path-utils.ts';

/** Classification of why a particular entry was skipped during the walk. */
type SeedSkipReason =
  | 'read-failed'
  | 'lstat-failed'
  | 'realpath-failed'
  | 'symlink-escape'
  | 'symlink-stat-failed';

interface SeedOptions {
  contentDir: string;
  contentFilter?: ContentFilter;
  basenameIndex: BasenameIndex;
  /**
   * Fires on each non-ENOENT per-entry failure. `code` is the Node errno
   * string (e.g. `'EACCES'`, `'EMFILE'`, `'EPERM'`) or `undefined` if
   * the error didn't carry one. Invoked synchronously from inside
   * `seedBasenameIndex`; keep the body light (log + increment counter).
   */
  onSkip?(reason: SeedSkipReason, code: string | undefined, path: string): void;
}

function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Bounded single-directory basename seed for no-project single-file mode.
 *
 * The recursive `seedBasenameIndex` is unusable here for two reasons: it walks
 * the whole contentDir (a stall + privacy leak on a large parent like `~/`),
 * and it gates each entry through `contentFilter.isExcluded`, which the
 * single-file scope makes `true` for every sibling — so it would add nothing.
 *
 * This does ONE non-recursive `readdir` of the doc's own directory and adds
 * every sibling asset (by extension) directly, with NO `isExcluded` gate — the
 * point is precisely to resolve `![[sibling.png]]` embeds the one doc
 * references. Serving still flows through `contentFilter.isPathIgnored` (left
 * unscoped in single-file mode), so admitting the basename here does not widen
 * the served surface beyond assets the doc actually links.
 *
 * Residual: assets in subfolders and assets
 * added to the directory after open do not resolve.
 */
export function seedSingleDirBasenameIndex(opts: {
  contentDir: string;
  basenameIndex: BasenameIndex;
  onSkip?(reason: SeedSkipReason, code: string | undefined, path: string): void;
}): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(opts.contentDir, { withFileTypes: true }) as Dirent[];
  } catch (err) {
    const code = errnoCode(err);
    if (code !== 'ENOENT') opts.onSkip?.('read-failed', code, opts.contentDir);
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isSupportedAssetFile(entry.name, ASSET_EXTENSIONS)) continue;
    opts.basenameIndex.add(entry.name);
  }
}

/**
 * Async per-entry fs calls so the event loop stays responsive while the boot
 * seed walks a large content dir — the synchronous variant blocked signal
 * handlers and collab/API traffic until the whole tree was visited.
 */
export async function seedBasenameIndex(opts: SeedOptions): Promise<void> {
  const root = opts.contentDir;
  const visited = new Set<number>();

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch (err) {
      const code = errnoCode(err);
      if (code !== 'ENOENT') opts.onSkip?.('read-failed', code, dir);
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = toPosix(relative(root, full));
      if (rel.startsWith('..')) continue;
      if (opts.contentFilter?.isDirExcluded(rel) && entry.isDirectory()) continue;

      let entryStat: Stats;
      try {
        entryStat = await lstat(full);
      } catch (err) {
        const code = errnoCode(err);
        if (code !== 'ENOENT') opts.onSkip?.('lstat-failed', code, full);
        continue;
      }

      if (entryStat.isSymbolicLink()) {
        let canonical: string;
        try {
          canonical = await realpath(full);
        } catch (err) {
          const code = errnoCode(err);
          if (code !== 'ENOENT') opts.onSkip?.('realpath-failed', code, full);
          continue;
        }
        if (!isWithinDir(canonical, root)) {
          opts.onSkip?.('symlink-escape', undefined, full);
          continue;
        }
        let realStat: Stats;
        try {
          realStat = await stat(canonical);
        } catch (err) {
          const code = errnoCode(err);
          if (code !== 'ENOENT') opts.onSkip?.('symlink-stat-failed', code, canonical);
          continue;
        }
        if (visited.has(realStat.ino)) continue;
        visited.add(realStat.ino);
        if (realStat.isDirectory()) await walk(canonical);
        else if (
          realStat.isFile() &&
          isSupportedAssetFile(full, LINKABLE_ASSET_EXTENSIONS) &&
          !opts.contentFilter?.isExcluded(rel)
        ) {
          opts.basenameIndex.add(rel);
        }
        continue;
      }

      if (entryStat.isDirectory()) {
        if (visited.has(entryStat.ino)) continue;
        visited.add(entryStat.ino);
        await walk(full);
        continue;
      }
      if (
        entryStat.isFile() &&
        isSupportedAssetFile(full, LINKABLE_ASSET_EXTENSIONS) &&
        !opts.contentFilter?.isExcluded(rel)
      ) {
        opts.basenameIndex.add(rel);
      }
    }
  }

  await walk(root);
}
