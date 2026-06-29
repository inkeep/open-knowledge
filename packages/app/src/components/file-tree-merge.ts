import { fileEntryToTreePath } from './file-tree-adapter';
import type { FileEntry } from './file-tree-utils';

export const STALE_REFRESH_PRESERVE_WINDOW_MS = 5_000;

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

export function spliceLazyFolderChildren(
  currentEntries: readonly FileEntry[],
  folderTreePath: string,
  serverChildren: readonly FileEntry[],
  recentAdds: Map<string, number>,
  now: number = Date.now(),
): FileEntry[] {
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
  const stem = rest.endsWith('/') ? rest.slice(0, -1) : rest;
  return stem !== '' && !stem.includes('/');
}
