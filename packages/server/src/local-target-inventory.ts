import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  asTargetNamespace,
  createBasenameIndex,
  createTargetNamespace,
  createWikiAssetResolver,
} from '@inkeep/open-knowledge-core';
import type { ContentFilter } from './content-filter.ts';
import { stripDocExtension } from './doc-extensions.ts';
import {
  type AllFileEntries,
  type FolderIndexEntry,
  fileIndexEntryMembers,
  type WatcherHandle,
} from './file-watcher.ts';
import { getLogger } from './logger.ts';
import { isWithinDir, toPosix } from './path-utils.ts';

const log = getLogger('local-target-inventory');

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
  allFiles: AllFileEntries,
  folderAliases: ReadonlyMap<string, string>,
  contentDir: string,
  folderIndex?: ReadonlyMap<string, FolderIndexEntry>,
): WatcherLocalTargetInventory {
  const documentTargets = new Set<string>();
  const fileTargets = new Set<string>();
  const folderTargets = new Set<string>(folderIndex?.keys() ?? []);
  for (const [indexedIdentity, entry] of allFiles) {
    const targets = entry.kind === 'markdown' ? documentTargets : fileTargets;
    const { resolved, members } = fileIndexEntryMembers(contentDir, indexedIdentity, entry);
    for (const member of members) targets.add(member.path);
    if (resolved) continue;

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

type FileTargetResolver = (relativePath: string) => string | undefined;

function createInventoryFileResolver(
  getInventory: () => WatcherLocalTargetInventory | null,
  build: (fileTargets: readonly string[]) => FileTargetResolver,
): FileTargetResolver {
  let source: readonly string[] | null = null;
  let resolveTarget: FileTargetResolver = () => undefined;
  return (relativePath) => {
    const inventory = getInventory();
    if (inventory === null) return undefined;
    if (inventory.fileTargets !== source) {
      source = inventory.fileTargets;
      resolveTarget = build(source);
    }
    return resolveTarget(relativePath);
  };
}

export function createTrackedFileResolver(
  getInventory: () => WatcherLocalTargetInventory | null,
): FileTargetResolver {
  return createInventoryFileResolver(getInventory, (fileTargets) => {
    const files = createTargetNamespace('file', fileTargets);
    return (relativePath) => files.resolve(relativePath);
  });
}

export function createTrackedWikiFileResolver(
  getInventory: () => WatcherLocalTargetInventory | null,
): FileTargetResolver {
  return createInventoryFileResolver(getInventory, createWikiAssetResolver);
}

export function createFileBasenameResolver(
  fileTargets: Iterable<string>,
): (basename: string, sourceDocName: string) => string | undefined {
  const index = createBasenameIndex();
  for (const file of fileTargets) index.add(file);
  return (basename, sourceDocName) => index.resolveEmbed(basename, sourceDocName) ?? undefined;
}

export function createFileExistsOracle(
  fileTargets: Iterable<string>,
  contentDir: string,
  contentFilter: Pick<ContentFilter, 'isPathIgnored'> | undefined,
): (contentRootRelativePath: string) => boolean {
  const admittedFiles = asTargetNamespace('file', fileTargets);
  const canonicalContentDir = realpathSync(contentDir);
  return (contentRootRelativePath) => {
    if (admittedFiles.resolve(contentRootRelativePath) !== undefined) return true;
    if (contentFilter?.isPathIgnored(contentRootRelativePath)) return false;

    const candidate = resolve(contentDir, contentRootRelativePath);
    if (!isWithinDir(candidate, contentDir)) return false;
    try {
      const canonicalCandidate = realpathSync(candidate);
      return (
        isWithinDir(canonicalCandidate, canonicalContentDir) &&
        statSync(canonicalCandidate).isFile()
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.debug(
          { err, candidate },
          'linked-file existence fallback could not canonicalize; treating as absent',
        );
      }
      return false;
    }
  };
}
