import { isAbsolute, relative } from 'node:path';
import { stripDocExtension } from './doc-extensions.ts';
import type { FileIndexEntry, FolderIndexEntry, WatcherHandle } from './file-watcher.ts';
import { toPosix } from './path-utils.ts';

export interface WatcherLocalTargetInventory {
  documentTargets: readonly string[];
  fileTargets: readonly string[];
  folderTargets: readonly string[];
}

type LocalTargetWatcher = Pick<
  WatcherHandle,
  'getAllFilesIndex' | 'getFileIndexGeneration' | 'getFolderAliasIndex'
> &
  Partial<Pick<WatcherHandle, 'getFolderIndex'>>;

interface CachedWatcherInventory {
  contentDir: string;
  generation: number;
  inventory: WatcherLocalTargetInventory;
}

const watcherInventoryCache = new WeakMap<LocalTargetWatcher, CachedWatcherInventory>();

function canonicalRelativePath(contentDir: string, canonicalPath: string): string | null {
  const candidate = toPosix(relative(contentDir, canonicalPath));
  if (
    candidate.length === 0 ||
    candidate === '..' ||
    candidate.startsWith('../') ||
    isAbsolute(candidate)
  ) {
    return null;
  }
  return candidate;
}

function projectFolderAliases(
  identities: Set<string>,
  folderAliases: ReadonlyMap<string, string>,
): void {
  const canonicalIdentities = [...identities];
  for (const [aliasFolder, canonicalFolder] of folderAliases) {
    for (const identity of canonicalIdentities) {
      if (identity === canonicalFolder) {
        identities.add(aliasFolder);
      } else if (identity.startsWith(`${canonicalFolder}/`)) {
        identities.add(`${aliasFolder}${identity.slice(canonicalFolder.length)}`);
      }
    }
  }
}

export function localTargetInventoryFromWatcher(
  watcher: LocalTargetWatcher | null | undefined,
  contentDir: string,
): WatcherLocalTargetInventory | null {
  if (!watcher) return null;

  const generation = watcher.getFileIndexGeneration();
  const cached = watcherInventoryCache.get(watcher);
  if (cached?.contentDir === contentDir && cached.generation === generation) {
    return cached.inventory;
  }

  const inventory = localTargetInventoryFromIndexes(
    watcher.getAllFilesIndex(),
    watcher.getFolderAliasIndex(),
    contentDir,
    watcher.getFolderIndex?.(),
  );
  watcherInventoryCache.set(watcher, { contentDir, generation, inventory });
  return inventory;
}

export function localTargetInventoryFromIndexes(
  allFiles: ReadonlyMap<string, FileIndexEntry>,
  folderAliases: ReadonlyMap<string, string>,
  contentDir: string,
  folderIndex?: ReadonlyMap<string, FolderIndexEntry>,
): WatcherLocalTargetInventory {
  const documentTargets = new Set<string>();
  const fileTargets = new Set<string>();
  const folderTargets = new Set<string>(folderIndex?.keys() ?? []);
  for (const [indexedIdentity, entry] of allFiles) {
    const targets = entry.kind === 'markdown' ? documentTargets : fileTargets;
    targets.add(indexedIdentity);
    for (const alias of entry.aliases) targets.add(alias);

    const canonicalPath = canonicalRelativePath(contentDir, entry.canonicalPath);
    if (canonicalPath) {
      targets.add(entry.kind === 'markdown' ? stripDocExtension(canonicalPath) : canonicalPath);
    }
  }

  projectFolderAliases(documentTargets, folderAliases);
  projectFolderAliases(fileTargets, folderAliases);
  projectFolderAliases(folderTargets, folderAliases);

  return {
    documentTargets: [...documentTargets],
    fileTargets: [...fileTargets],
    folderTargets: [...folderTargets],
  };
}
