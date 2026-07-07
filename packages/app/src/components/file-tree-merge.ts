/**
 * Pure merge helper for the FileTree sidebar's optimistic-add-vs-stale-server
 * race. Lifted out of `FileTree.tsx` so it can be unit-tested independently
 * of the React component's JSX surface (see `file-tree-merge.test.ts`).
 *
 * The window-bounded preserve semantics live here; the caller-side invariant
 * (every local-add site must `recentLocalAddsRef.current.set(fileEntryToTreePath(entry), Date.now())`)
 * is enforced at the FileTree.tsx call sites.
 */

import { fileEntryToTreePath } from './file-tree-adapter';
import type { FileEntry } from './file-tree-utils';

export const STALE_REFRESH_PRESERVE_WINDOW_MS = 5_000;

// Returns the server response merged with locally-added entries the server
// hasn't yet indexed. An entry is preserved iff it is absent from the server
// response, present in the prior local state, and recorded in `recentAdds`
// within STALE_REFRESH_PRESERVE_WINDOW_MS. Side effect: prunes confirmed and
// expired entries from `recentAdds` so the registry stays bounded.
//
// Invariant: callers must keep `recentAdds` populated at every local-add site
// via `recentLocalAddsRef.current.set(fileEntryToTreePath(entry), Date.now())`
// (see the create-folder + create-file branches in `startCreating`). A path
// absent from `recentAdds` is treated as either confirmed by a prior refresh
// or never optimistically added — neither preserves on a missing-from-server
// response.
//
// `now` defaults to `Date.now()` so production callers stay one-arg; tests pin
// it to deterministically exercise the strict-`>` boundary at exactly
// STALE_REFRESH_PRESERVE_WINDOW_MS.
export function mergeAndPruneRecentLocalAdds(
  serverEntries: readonly FileEntry[],
  localEntries: readonly FileEntry[],
  recentAdds: Map<string, number>,
  now: number = Date.now(),
): FileEntry[] {
  if (recentAdds.size === 0) return [...serverEntries];
  const serverPaths = new Set(serverEntries.map((entry) => fileEntryToTreePath(entry)));
  const preservedLocal: FileEntry[] = [];
  for (const localEntry of localEntries) {
    const treePath = fileEntryToTreePath(localEntry);
    if (serverPaths.has(treePath)) {
      // Server has it — drop from registry (confirmed) and keep server's
      // metadata (server may have richer modified/size data).
      recentAdds.delete(treePath);
      continue;
    }
    const addedAt = recentAdds.get(treePath);
    if (addedAt === undefined) continue; // never optimistically added — drop with server view
    if (now - addedAt > STALE_REFRESH_PRESERVE_WINDOW_MS) {
      recentAdds.delete(treePath); // window expired — trust server
      continue;
    }
    preservedLocal.push(localEntry);
  }
  if (preservedLocal.length === 0) return [...serverEntries];
  return [...serverEntries, ...preservedLocal];
}

/**
 * Additively union `incomingEntries` into `currentEntries`, de-duplicated by
 * tree path (existing entries win on collision). Purely additive: nothing is
 * pruned. Used to paint a streaming root listing incrementally — each NDJSON
 * batch appends its rows as they arrive, so the sidebar fills in progressively
 * instead of waiting for the whole walk. Pruning the root level mid-stream (as
 * `spliceLazyFolderChildren(prev, '', …)` does) would drop every folder not yet
 * streamed, so the authoritative prune is deferred to one final splice once the
 * stream completes. The brief over-inclusive intermediate (rows a superseded
 * prior refresh left behind linger until that final splice) is the safe
 * direction — it never flashes the tree empty.
 */
export function mergeRootEntriesAdditive(
  currentEntries: readonly FileEntry[],
  incomingEntries: readonly FileEntry[],
): FileEntry[] {
  if (incomingEntries.length === 0) return [...currentEntries];
  const seen = new Set(currentEntries.map((entry) => fileEntryToTreePath(entry)));
  const merged = [...currentEntries];
  for (const entry of incomingEntries) {
    const treePath = fileEntryToTreePath(entry);
    if (seen.has(treePath)) continue;
    seen.add(treePath);
    merged.push(entry);
  }
  return merged;
}

/**
 * Splice a lazily-fetched depth-1 child listing into the current entry set:
 * the folder's direct children are replaced by the server response merged
 * through the same optimistic-add window as a full refresh
 * (`mergeAndPruneRecentLocalAdds`), while entries outside that level pass
 * through untouched — already-loaded grandchildren survive a parent-level
 * refresh as long as their own subtree's anchor folder is still in the new
 * level. Descendants of a child folder the server dropped are pruned with
 * it: keeping them would re-imply the deleted folder as a phantom ancestor
 * when the tree rebuilds its folder set from entry paths.
 *
 * `folderTreePath` is the folder's TREE path — trailing slash (`'team/'`),
 * or `''` for the content root. The trailing slash is load-bearing: it keeps
 * `'team/'` from prefix-matching sibling folders like `'teammates/'`.
 */
export function spliceLazyFolderChildren(
  currentEntries: readonly FileEntry[],
  folderTreePath: string,
  serverChildren: readonly FileEntry[],
  recentAdds: Map<string, number>,
  now: number = Date.now(),
): FileEntry[] {
  // A child listing for a folder no longer in the entry set (deleted
  // externally while the fetch was in flight, with a refresh already running
  // so the generation had not bumped yet) must not splice — the orphaned
  // children would re-imply the deleted folder as a phantom ancestor. No-op;
  // the already-queued trailing refresh owns the level.
  if (
    folderTreePath !== '' &&
    !currentEntries.some((entry) => fileEntryToTreePath(entry) === folderTreePath)
  ) {
    return [...currentEntries];
  }
  const currentChildren: FileEntry[] = [];
  const passthrough: FileEntry[] = [];
  for (const entry of currentEntries) {
    if (isDirectChildTreePath(folderTreePath, fileEntryToTreePath(entry))) {
      currentChildren.push(entry);
    } else {
      passthrough.push(entry);
    }
  }
  const mergedChildren = mergeAndPruneRecentLocalAdds(
    serverChildren,
    currentChildren,
    recentAdds,
    now,
  );
  // Folder tree paths carry a trailing slash, so the merged level's folders
  // are the anchors deeper pass-through descendants must hang off.
  const survivingChildFolders = new Set(
    mergedChildren.map((entry) => fileEntryToTreePath(entry)).filter((p) => p.endsWith('/')),
  );
  const kept = passthrough.filter((entry) => {
    const treePath = fileEntryToTreePath(entry);
    if (!treePath.startsWith(folderTreePath)) return true; // outside the spliced subtree
    const rest = treePath.slice(folderTreePath.length);
    const firstSlash = rest.indexOf('/');
    if (firstSlash === -1) return true; // the spliced folder's own entry
    return survivingChildFolders.has(folderTreePath + rest.slice(0, firstSlash + 1));
  });
  return [...kept, ...mergedChildren];
}

function isDirectChildTreePath(parentDirTreePath: string, treePath: string): boolean {
  if (!treePath.startsWith(parentDirTreePath)) return false;
  const rest = treePath.slice(parentDirTreePath.length);
  if (rest === '') return false;
  // Folder children carry a trailing slash ('team/sub/'); strip exactly one
  // before the depth check so they classify as direct children of 'team/'.
  const stem = rest.endsWith('/') ? rest.slice(0, -1) : rest;
  return stem !== '' && !stem.includes('/');
}
