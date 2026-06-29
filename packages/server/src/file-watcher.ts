import { createHash } from 'node:crypto';
import { type Dirent, lstatSync, readdirSync, realpathSync, type Stats, statSync } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { LINKABLE_ASSET_EXTENSIONS } from '@inkeep/open-knowledge-core';
import { isConfigDoc, isReservedForUserTree, isSystemDoc } from './cc1-broadcast.ts';
import type { ContentFilter } from './content-filter.ts';
import {
  forgetDocExtension,
  isSupportedAssetFile,
  isSupportedDocFile,
  registerDocExtension,
  stripDocExtension,
} from './doc-extensions.ts';
import { classifyFsPath, normalizeFsPath } from './fs-traced.ts';
import { getLogger } from './logger.ts';
import { toPosix } from './path-utils.ts';
import { isWithinContentDir } from './persistence.ts';
import { containsConflictMarkers } from './reconciliation.ts';
import { getMeter, withSpan } from './telemetry.ts';

export interface AsyncSubscription {
  unsubscribe(): Promise<void>;
}

type WatcherBackend = 'parcel' | 'chokidar';

type MarkdownDiskEvent =
  | { kind: 'create'; path: string; docName: string; content: string }
  | { kind: 'update'; path: string; docName: string; content: string }
  | { kind: 'delete'; path: string; docName: string }
  | {
      kind: 'rename';
      oldPath: string;
      newPath: string;
      oldDocName: string;
      newDocName: string;
      content: string;
    }
  | { kind: 'conflict'; path: string; docName: string; content: string };

type AssetDiskEvent =
  | { kind: 'asset-create'; path: string; relativePath: string }
  | { kind: 'asset-delete'; path: string; relativePath: string };

type FolderDiskEvent =
  | { kind: 'folder-create'; path: string; relativePath: string }
  | { kind: 'folder-delete'; path: string; relativePath: string };

type FileDiskEvent =
  | {
      kind: 'file-create';
      path: string;
      relativePath: string;
      size: number;
      modifiedTs: number;
      inode: number;
    }
  | {
      kind: 'file-update';
      path: string;
      relativePath: string;
      size: number;
      modifiedTs: number;
      inode: number;
    }
  | { kind: 'file-delete'; path: string; relativePath: string };

export type DiskEvent = MarkdownDiskEvent | AssetDiskEvent | FolderDiskEvent | FileDiskEvent;

export function assertNeverDiskEvent(event: never): never {
  throw new Error(`[DiskEvent] unhandled variant: ${JSON.stringify(event)}`);
}

export interface FileIndexEntry {
  size: number;
  modified: string;
  canonicalPath: string;
  inode: number;
  aliases: string[];
  kind: 'markdown' | 'file';
}

export interface FolderIndexEntry {
  size: 0;
  modified: string;
  canonicalPath: string;
  inode: number;
}

function markdownIndexView(
  inner: ReadonlyMap<string, FileIndexEntry>,
): ReadonlyMap<string, FileIndexEntry> {
  const snapshot = new Map<string, FileIndexEntry>();
  for (const [k, v] of inner) {
    if (v.kind === 'markdown') snapshot.set(k, v);
  }
  return snapshot;
}

export interface WatcherHandle {
  unsubscribe: () => Promise<void>;
  getFileIndex: () => ReadonlyMap<string, FileIndexEntry>;
  getAllFilesIndex: () => ReadonlyMap<string, FileIndexEntry>;
  getFileIndexGeneration: () => number;
  getFolderIndex: () => ReadonlyMap<string, FolderIndexEntry>;
  getAliasMap: () => ReadonlyMap<string, string>;
  getFolderAliasIndex: () => ReadonlyMap<string, string>;
  mutateFileIndex: (event: DiskEvent) => void;
  pruneFileIndexNowExcluded: () => number;
  pruneFolderIndexNowExcluded: () => number;
  rescanFromDisk: () => Promise<void>;
}

export const writeTracker = new Map<string, Array<{ hash: string; timestamp: number }>>();
const WRITE_TRACKER_TTL_MS = 10_000;

export function registerWrite(filePath: string, hash: string): void {
  const queue = writeTracker.get(filePath) ?? [];
  queue.push({ hash, timestamp: Date.now() });
  writeTracker.set(filePath, queue);
}

export function evictStaleTrackerEntries(): void {
  const now = Date.now();
  for (const [path, queue] of writeTracker) {
    const fresh = queue.filter((e) => now - e.timestamp <= WRITE_TRACKER_TTL_MS);
    if (fresh.length === 0) {
      writeTracker.delete(path);
    } else if (fresh.length !== queue.length) {
      writeTracker.set(path, fresh);
    }
  }
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function eventEscapesContentDir(rawPath: string, contentDir: string): boolean {
  let lst: ReturnType<typeof lstatSync>;
  try {
    lst = lstatSync(rawPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false; // deleted between event and check
    console.warn(
      `[file-watcher] lstat failed for escape check on ${rawPath} (${code}), dropping event`,
    );
    return true; // fail closed on unexpected errors
  }
  if (!lst.isSymbolicLink()) return false;
  let canonical: string;
  try {
    canonical = realpathSync(rawPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ELOOP') {
      console.warn(
        `[file-watcher] realpath failed for escape check on ${rawPath} (${code}), dropping event`,
      );
    }
    return true;
  }
  return !isWithinContentDir(canonical, contentDir);
}

export function pathToDocName(absPath: string, contentDir: string): string {
  const rel = toPosix(relative(contentDir, absPath));
  return stripDocExtension(rel);
}

function contentRelativePath(contentDir: string, absPath: string): string | null {
  const rel = relative(contentDir, absPath).replaceAll('\\', '/');
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) return null;
  return rel;
}

export function upsertFolderIndexEntry(
  folderIndex: Map<string, FolderIndexEntry>,
  contentDir: string,
  folderPath: string,
  stat: { mtime: Date; ino: number | bigint },
  canonicalPath = folderPath,
): string | null {
  const relativePath = contentRelativePath(contentDir, folderPath);
  if (!relativePath) return null;
  folderIndex.set(relativePath, {
    size: 0,
    modified: stat.mtime.toISOString(),
    canonicalPath,
    inode: Number(stat.ino),
  });
  return relativePath;
}

export function removeFolderIndexEntries(
  folderIndex: Map<string, FolderIndexEntry>,
  relativePath: string,
): boolean {
  let removed = false;
  for (const path of folderIndex.keys()) {
    if (path === relativePath || path.startsWith(`${relativePath}/`)) {
      folderIndex.delete(path);
      removed = true;
    }
  }
  return removed;
}

function extractDocExtension(path: string): string | null {
  const ext = extname(path);
  if (ext === '') return null;
  const lower = ext.toLowerCase();
  if (lower === '.mdx' || lower === '.md') return ext;
  return null;
}

export const lastKnownHash = new Map<string, string>();

export function updateLastKnownHash(filePath: string, hash: string): void {
  lastKnownHash.set(filePath, hash);
}

export function removeLastKnownHash(filePath: string): string | undefined {
  const hash = lastKnownHash.get(filePath);
  lastKnownHash.delete(filePath);
  return hash;
}

interface RawFileEvent {
  type: 'create' | 'update' | 'delete';
  path: string;
}

export async function classifyEvents(
  rawEvents: RawFileEvent[],
  contentDir: string,
  contentFilter?: ContentFilter,
  aliasMap?: Map<string, string>,
): Promise<MarkdownDiskEvent[]> {
  const deletes: RawFileEvent[] = [];
  const creates: RawFileEvent[] = [];
  const updates: RawFileEvent[] = [];

  for (const event of rawEvents) {
    if (!isSupportedDocFile(event.path)) continue;

    if (contentFilter) {
      const relPath = toPosix(relative(contentDir, event.path));
      if (contentFilter.isExcluded(relPath)) continue;
    }

    switch (event.type) {
      case 'delete':
        deletes.push(event);
        break;
      case 'create':
        if (lastKnownHash.has(event.path)) {
          updates.push(event);
        } else {
          creates.push(event);
        }
        break;
      case 'update':
        updates.push(event);
        break;
    }
  }

  const createContents = new Map<string, string>();
  const updateContents = new Map<string, string>();
  for (const event of creates) {
    try {
      createContents.set(event.path, await readFile(event.path, 'utf-8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[file-watcher] Failed to read ${event.path}:`, e);
      }
    }
  }
  for (const event of updates) {
    try {
      updateContents.set(event.path, await readFile(event.path, 'utf-8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[file-watcher] Failed to read ${event.path}:`, e);
      }
    }
  }

  function resolveDocName(rawPath: string): string {
    const raw = pathToDocName(rawPath, contentDir);
    if (!aliasMap) return raw;

    let lst: ReturnType<typeof lstatSync> | null = null;
    try {
      lst = lstatSync(rawPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`[file-watcher] resolveDocName lstat failed for ${rawPath}:`, e);
      }
      if (aliasMap.has(raw)) {
        aliasMap.delete(raw);
        return raw;
      }
      return raw;
    }

    if (!lst.isSymbolicLink()) {
      if (aliasMap.has(raw)) aliasMap.delete(raw);
      return raw;
    }

    let canonical: string;
    try {
      canonical = realpathSync(rawPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ELOOP') {
        console.warn(`[file-watcher] resolveDocName realpath failed for ${rawPath}:`, e);
      }
      aliasMap.delete(raw);
      return raw;
    }

    if (!isWithinContentDir(canonical, contentDir)) {
      aliasMap.delete(raw);
      return raw;
    }

    const canonicalDocName = pathToDocName(canonical, contentDir);
    if (canonicalDocName === raw) return raw;
    aliasMap.set(raw, canonicalDocName);
    return canonicalDocName;
  }

  const results: MarkdownDiskEvent[] = [];
  const pairedCreates = new Set<string>();
  const pairedDeletes = new Set<string>();

  for (const del of deletes) {
    const deletedHash = removeLastKnownHash(del.path);
    if (!deletedHash) continue;

    for (const create of creates) {
      if (pairedCreates.has(create.path)) continue;
      const content = createContents.get(create.path);
      if (content === undefined) continue;
      const hash = contentHash(content);
      if (hash === deletedHash) {
        pairedCreates.add(create.path);
        pairedDeletes.add(del.path);
        updateLastKnownHash(create.path, hash);
        results.push({
          kind: 'rename',
          oldPath: del.path,
          newPath: create.path,
          oldDocName: resolveDocName(del.path),
          newDocName: resolveDocName(create.path),
          content,
        });
        break;
      }
    }
  }

  for (const del of deletes) {
    if (pairedDeletes.has(del.path)) continue;
    removeLastKnownHash(del.path);
    results.push({
      kind: 'delete',
      path: del.path,
      docName: resolveDocName(del.path),
    });
  }

  for (const create of creates) {
    if (pairedCreates.has(create.path)) continue;
    const content = createContents.get(create.path);
    if (content === undefined) continue;
    const hash = contentHash(content);
    updateLastKnownHash(create.path, hash);

    if (containsConflictMarkers(content)) {
      results.push({
        kind: 'conflict',
        path: create.path,
        docName: resolveDocName(create.path),
        content,
      });
    } else {
      results.push({
        kind: 'create',
        path: create.path,
        docName: resolveDocName(create.path),
        content,
      });
    }
  }

  for (const update of updates) {
    const content = updateContents.get(update.path);
    if (content === undefined) continue;
    const hash = contentHash(content);
    updateLastKnownHash(update.path, hash);

    if (containsConflictMarkers(content)) {
      results.push({
        kind: 'conflict',
        path: update.path,
        docName: resolveDocName(update.path),
        content,
      });
    } else {
      results.push({
        kind: 'update',
        path: update.path,
        docName: resolveDocName(update.path),
        content,
      });
    }
  }

  return results;
}

export function isSelfWrite(filePath: string, hash: string): boolean {
  const queue = writeTracker.get(filePath);
  if (!queue) return false;
  const idx = queue.findIndex((e) => e.hash === hash);
  if (idx < 0) return false;
  queue.splice(idx, 1);
  if (queue.length === 0) writeTracker.delete(filePath);
  return true;
}

async function seedLastKnownHashes(
  dir: string,
  contentDir: string,
  contentFilter: ContentFilter | undefined,
  fileIndex: Map<string, FileIndexEntry>,
  folderIndex: Map<string, FolderIndexEntry>,
  aliasMap: Map<string, string>,
  folderAliasIndex: Map<string, string>,
  visitedInodes?: Set<number>,
): Promise<void> {
  const visited = visitedInodes ?? new Set<number>();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      let lst: Stats;
      try {
        lst = await lstat(fullPath);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          console.warn(`[file-watcher] Failed to lstat ${fullPath}, skipping:`, e);
        }
        continue;
      }

      if (lst.isSymbolicLink()) {
        let canonical: string;
        try {
          canonical = await realpath(fullPath);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ELOOP') {
            console.warn(`[file-watcher] Broken/cyclic symlink at ${fullPath}, skipping`);
          } else {
            console.warn(`[file-watcher] Failed to resolve symlink ${fullPath}:`, e);
          }
          continue;
        }

        if (!isWithinContentDir(canonical, contentDir)) {
          console.warn(`[file-watcher] Symlink escape: ${fullPath} → ${canonical}, skipping`);
          continue;
        }

        try {
          const canonStat = await stat(canonical);
          if (visited.has(canonStat.ino)) {
            if (canonStat.isFile() && isSupportedDocFile(entry.name)) {
              const aliasDocName = pathToDocName(fullPath, contentDir);
              const canonicalDocName = pathToDocName(canonical, contentDir);
              aliasMap.set(aliasDocName, canonicalDocName);
              const existing = fileIndex.get(canonicalDocName);
              if (existing && !existing.aliases.includes(aliasDocName)) {
                existing.aliases.push(aliasDocName);
              }
            } else if (canonStat.isDirectory()) {
              const relPath = contentRelativePath(contentDir, fullPath);
              if (!contentFilter || (relPath && !contentFilter.isDirExcluded(relPath))) {
                folderAliasIndex.set(
                  pathToDocName(fullPath, contentDir),
                  pathToDocName(canonical, contentDir),
                );
              }
            }
            continue;
          }
          visited.add(canonStat.ino);

          if (canonStat.isDirectory()) {
            const relPath = contentRelativePath(contentDir, fullPath);
            if (contentFilter) {
              if (!relPath || contentFilter.isDirExcluded(relPath)) continue;
            }
            folderAliasIndex.set(
              pathToDocName(fullPath, contentDir),
              pathToDocName(canonical, contentDir),
            );
            await seedLastKnownHashes(
              canonical,
              contentDir,
              contentFilter,
              fileIndex,
              folderIndex,
              aliasMap,
              folderAliasIndex,
              visited,
            );
          } else if (canonStat.isFile() && isSupportedDocFile(entry.name)) {
            if (contentFilter) {
              const relPath = toPosix(relative(contentDir, canonical));
              if (contentFilter.isExcluded(relPath)) continue;
            }
            const aliasDocName = pathToDocName(fullPath, contentDir);
            const canonicalDocName = pathToDocName(canonical, contentDir);
            aliasMap.set(aliasDocName, canonicalDocName);

            try {
              const content = await readFile(canonical, 'utf-8');
              const hash = contentHash(content);
              lastKnownHash.set(canonical, hash);
              const ext = extractDocExtension(canonical);
              if (ext) {
                const reg = registerDocExtension(canonicalDocName, ext);
                if (reg.shadowed) {
                  console.warn(
                    `[file-watcher] docName "${canonicalDocName}" has both "${reg.effective}" and "${reg.shadowed}" on disk; "${reg.effective}" wins (industry convention). Rename or delete one to disambiguate.`,
                  );
                  if (!reg.changed) continue;
                }
              }
              fileIndex.set(canonicalDocName, {
                size: canonStat.size,
                modified: canonStat.mtime.toISOString(),
                canonicalPath: canonical,
                inode: canonStat.ino,
                aliases: [aliasDocName],
                kind: 'markdown',
              });
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code !== 'ENOENT') {
                console.warn(`[file-watcher] Failed to seed hash for ${canonical}:`, err);
              }
            }
          } else if (canonStat.isFile()) {
            if (contentFilter) {
              const relPath = toPosix(relative(contentDir, canonical));
              if (contentFilter.isPathIgnored(relPath)) continue;
            }
            const docName = pathToDocName(fullPath, contentDir);
            if (isSystemDoc(docName) || isConfigDoc(docName)) continue;
            fileIndex.set(docName, {
              size: canonStat.size,
              modified: canonStat.mtime.toISOString(),
              canonicalPath: canonical,
              inode: canonStat.ino,
              aliases: [],
              kind: 'file',
            });
          }
        } catch (e) {
          console.warn(`[file-watcher] Failed to stat symlink target ${canonical}:`, e);
        }
      } else if (lst.isDirectory()) {
        const relPath = contentRelativePath(contentDir, fullPath);
        if (contentFilter) {
          if (!relPath || contentFilter.isDirExcluded(relPath)) continue;
        }
        upsertFolderIndexEntry(folderIndex, contentDir, fullPath, lst);
        await seedLastKnownHashes(
          fullPath,
          contentDir,
          contentFilter,
          fileIndex,
          folderIndex,
          aliasMap,
          folderAliasIndex,
          visited,
        );
      } else if (lst.isFile() && isSupportedDocFile(entry.name)) {
        if (visited.has(lst.ino)) continue;
        visited.add(lst.ino);

        if (contentFilter) {
          const relPath = toPosix(relative(contentDir, fullPath));
          if (contentFilter.isExcluded(relPath)) continue;
        }
        try {
          const content = await readFile(fullPath, 'utf-8');
          lastKnownHash.set(fullPath, contentHash(content));

          const docName = pathToDocName(fullPath, contentDir);
          const ext = extractDocExtension(fullPath);
          if (ext) {
            const reg = registerDocExtension(docName, ext);
            if (reg.shadowed) {
              console.warn(
                `[file-watcher] docName "${docName}" has both "${reg.effective}" and "${reg.shadowed}" on disk; "${reg.effective}" wins (industry convention). Rename or delete one to disambiguate.`,
              );
              if (!reg.changed) continue;
            }
          }
          fileIndex.set(docName, {
            size: lst.size,
            modified: lst.mtime.toISOString(),
            canonicalPath: fullPath,
            inode: lst.ino,
            aliases: [],
            kind: 'markdown',
          });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EACCES') {
            console.warn(
              `[file-watcher] Permission denied reading ${fullPath}, file excluded from index`,
            );
          } else if (code !== 'ENOENT') {
            console.warn(`[file-watcher] Failed to seed hash for ${fullPath}:`, err);
          }
        }
      } else if (lst.isFile()) {
        if (visited.has(lst.ino)) continue;
        visited.add(lst.ino);

        if (contentFilter) {
          const relPath = toPosix(relative(contentDir, fullPath));
          if (contentFilter.isPathIgnored(relPath)) continue;
        }
        const docName = pathToDocName(fullPath, contentDir);
        if (isSystemDoc(docName) || isConfigDoc(docName)) continue;
        fileIndex.set(docName, {
          size: lst.size,
          modified: lst.mtime.toISOString(),
          canonicalPath: fullPath,
          inode: lst.ino,
          aliases: [],
          kind: 'file',
        });
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(`[file-watcher] Failed to read directory ${dir}:`, err);
    }
  }
}

export function updateFileIndex(event: DiskEvent, fileIndex: Map<string, FileIndexEntry>): void {
  if (
    event.kind === 'asset-create' ||
    event.kind === 'asset-delete' ||
    event.kind === 'folder-create' ||
    event.kind === 'folder-delete'
  ) {
    return;
  }
  if (
    event.kind === 'file-create' ||
    event.kind === 'file-update' ||
    event.kind === 'file-delete'
  ) {
    const docName = event.relativePath;
    if (isSystemDoc(docName) || isConfigDoc(docName)) return;
    if (event.kind === 'file-delete') {
      const existing = fileIndex.get(docName);
      if (existing && existing.kind === 'file') {
        fileIndex.delete(docName);
      }
      return;
    }
    const existing = fileIndex.get(docName);
    if (existing && existing.kind === 'markdown') return;
    fileIndex.set(docName, {
      size: event.size,
      modified: new Date(event.modifiedTs).toISOString(),
      canonicalPath: existing?.canonicalPath ?? event.path,
      inode: event.inode || existing?.inode || 0,
      aliases: existing?.aliases ?? [],
      kind: 'file',
    });
    return;
  }
  const docName = event.kind === 'rename' ? event.newDocName : event.docName;
  if (isReservedForUserTree(docName)) return;
  switch (event.kind) {
    case 'create':
    case 'update':
    case 'conflict': {
      const docName = event.docName;
      const existing = fileIndex.get(docName);
      const ext = extractDocExtension(event.path);
      if (ext) registerDocExtension(docName, ext);
      fileIndex.set(docName, {
        size: Buffer.byteLength(event.content, 'utf-8'),
        modified: new Date().toISOString(),
        canonicalPath: existing?.canonicalPath ?? event.path,
        inode: existing?.inode ?? 0,
        aliases: existing?.aliases ?? [],
        kind: 'markdown',
      });
      break;
    }
    case 'delete': {
      if (fileIndex.has(event.docName)) {
        fileIndex.delete(event.docName);
        forgetDocExtension(event.docName);
      } else {
        for (const [, entry] of fileIndex) {
          const idx = entry.aliases.indexOf(event.docName);
          if (idx !== -1) {
            entry.aliases.splice(idx, 1);
            break;
          }
        }
      }
      break;
    }
    case 'rename': {
      const existing = fileIndex.get(event.oldDocName);
      fileIndex.delete(event.oldDocName);
      forgetDocExtension(event.oldDocName);
      const ext = extractDocExtension(event.newPath);
      if (ext) registerDocExtension(event.newDocName, ext);
      fileIndex.set(event.newDocName, {
        size: Buffer.byteLength(event.content, 'utf-8'),
        modified: new Date().toISOString(),
        canonicalPath: existing?.canonicalPath ?? event.newPath,
        inode: existing?.inode ?? 0,
        aliases: existing?.aliases ?? [],
        kind: 'markdown',
      });
      break;
    }
    default:
      assertNeverDiskEvent(event);
  }
}

function updateFolderIndexFromRawEvents(
  rawEvents: Array<{ type: 'create' | 'update' | 'delete'; path: string }>,
  contentDir: string,
  contentFilter: ContentFilter | undefined,
  folderIndex: Map<string, FolderIndexEntry>,
): FolderDiskEvent[] {
  const events: FolderDiskEvent[] = [];

  for (const raw of rawEvents) {
    const relativePath = contentRelativePath(contentDir, raw.path);
    if (!relativePath) continue;

    if (raw.type === 'delete') {
      if (removeFolderIndexEntries(folderIndex, relativePath)) {
        events.push({ kind: 'folder-delete', path: raw.path, relativePath });
      }
      continue;
    }

    let lst: ReturnType<typeof lstatSync>;
    try {
      lst = lstatSync(raw.path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`[file-watcher] folder lstat failed for ${raw.path} (${code})`);
      }
      continue;
    }

    let folderStat: ReturnType<typeof statSync> | null = null;
    let canonicalPath = raw.path;
    if (lst.isDirectory()) {
      folderStat = lst;
    } else if (lst.isSymbolicLink()) {
      try {
        canonicalPath = realpathSync(raw.path);
        if (!isWithinContentDir(canonicalPath, contentDir)) continue;
        const stat = statSync(canonicalPath);
        if (stat.isDirectory()) folderStat = stat;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          console.warn(`[file-watcher] folder symlink resolve failed for ${raw.path} (${code})`);
        }
        folderStat = null;
      }
    }
    if (!folderStat) continue;
    if (contentFilter?.isDirExcluded(relativePath)) continue;

    const hadFolder = folderIndex.has(relativePath);
    upsertFolderIndexEntry(folderIndex, contentDir, raw.path, folderStat, canonicalPath);
    if (!hadFolder) {
      events.push({ kind: 'folder-create', path: raw.path, relativePath });
      scanForUntrackedSubfolders(canonicalPath, contentDir, contentFilter, folderIndex, events);
    }
  }

  return events;
}

function scanForUntrackedSubfolders(
  startPath: string,
  contentDir: string,
  contentFilter: ContentFilter | undefined,
  folderIndex: Map<string, FolderIndexEntry>,
  events: FolderDiskEvent[],
): void {
  const queue: string[] = [startPath];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) continue;

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`[file-watcher] folder rescan readdir failed for ${dir} (${code})`);
      }
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const fullPath = join(dir, entry.name);
      const relPath = contentRelativePath(contentDir, fullPath);
      if (!relPath) continue;
      if (contentFilter?.isDirExcluded(relPath)) continue;

      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(fullPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          console.warn(`[file-watcher] folder rescan lstat failed for ${fullPath} (${code})`);
        }
        continue;
      }
      if (!stat.isDirectory()) continue;

      if (!folderIndex.has(relPath)) {
        upsertFolderIndexEntry(folderIndex, contentDir, fullPath, stat);
        events.push({ kind: 'folder-create', path: fullPath, relativePath: relPath });
      }
      queue.push(fullPath);
    }
  }
}

export async function handleRawEvents(
  rawEvents: Array<{ type: 'create' | 'update' | 'delete'; path: string }>,
  contentDir: string,
  contentFilter: ContentFilter | undefined,
  fileIndex: Map<string, FileIndexEntry>,
  folderIndex: Map<string, FolderIndexEntry>,
  onDiskEvent: (event: DiskEvent) => Promise<void>,
  aliasMap?: Map<string, string>,
): Promise<void> {
  const safeEvents = rawEvents.filter((e) => {
    if (!eventEscapesContentDir(e.path, contentDir)) return true;
    console.warn(`[file-watcher] Symlink escape: ${e.path}, dropping ${e.type} event`);
    return false;
  });

  const mdEvents = safeEvents.filter((e) => isSupportedDocFile(e.path));
  const assetEvents = safeEvents.filter((e) =>
    isSupportedAssetFile(e.path, LINKABLE_ASSET_EXTENSIONS),
  );
  const nonMdRawEvents = safeEvents.filter((e) => !isSupportedDocFile(e.path));
  const folderEvents = updateFolderIndexFromRawEvents(
    safeEvents,
    contentDir,
    contentFilter,
    folderIndex,
  );
  if (
    mdEvents.length === 0 &&
    assetEvents.length === 0 &&
    folderEvents.length === 0 &&
    nonMdRawEvents.length === 0
  ) {
    return;
  }

  const diskEvents =
    mdEvents.length > 0 ? await classifyEvents(mdEvents, contentDir, contentFilter, aliasMap) : [];

  for (const event of diskEvents) {
    let isSelf = false;

    if (event.kind !== 'delete' && event.kind !== 'rename') {
      const hash = contentHash(event.content);
      let checkPath = event.path;
      try {
        checkPath = realpathSync(event.path);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          console.warn(
            `[file-watcher] realpathSync failed for self-write check on ${event.path} (${code})`,
          );
        }
      }
      isSelf = isSelfWrite(checkPath, hash);
    } else if (event.kind === 'rename') {
      const hash = contentHash(event.content);
      let checkPath = event.newPath;
      try {
        checkPath = realpathSync(event.newPath);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          console.warn(
            `[file-watcher] realpathSync failed for self-write check on ${event.newPath} (${code})`,
          );
        }
      }
      isSelf = isSelfWrite(checkPath, hash);
    }

    updateFileIndex(event, fileIndex);

    if (contentFilter && !isSelf) {
      switch (event.kind) {
        case 'create':
          contentFilter.incrementMdDir(dirname(event.docName));
          break;
        case 'delete':
          contentFilter.decrementMdDir(dirname(event.docName));
          break;
        case 'rename':
          contentFilter.decrementMdDir(dirname(event.oldDocName));
          contentFilter.incrementMdDir(dirname(event.newDocName));
          break;
        case 'update':
        case 'conflict':
          break;
        default:
          assertNeverDiskEvent(event);
      }
    }

    if (isSelf) {
      getLogger('file-watcher').debug(
        {
          kind: event.kind,
          path: event.kind === 'rename' ? event.newPath : event.path,
          self: true,
        },
        `[file-watcher] Skipped self-write: ${event.kind}`,
      );
      _fileWatcherEventsCounter().add(1, { 'disk.kind': event.kind, self: true });
      continue;
    }

    getLogger('file-watcher').debug(
      {
        kind: event.kind,
        path: event.kind === 'rename' ? event.newPath : event.path,
      },
      `[file-watcher] Dispatching: ${event.kind}`,
    );
    _fileWatcherEventsCounter().add(1, { 'disk.kind': event.kind, self: false });
    const rawPath = event.kind === 'rename' ? event.newPath : event.path;
    await withSpan(
      'file_watcher.process_event',
      {
        attributes: {
          'disk.kind': event.kind,
          'disk.path': normalizeFsPath(rawPath),
          'disk.path.role': classifyFsPath(rawPath),
        },
      },
      async () => onDiskEvent(event),
    );
  }

  for (const event of folderEvents) {
    getLogger('file-watcher').debug(
      { kind: event.kind, path: event.path },
      `[file-watcher] Dispatching: ${event.kind}`,
    );
    _fileWatcherEventsCounter().add(1, { 'disk.kind': event.kind, self: false });
    await withSpan(
      'file_watcher.process_event',
      {
        attributes: {
          'disk.kind': event.kind,
          'disk.path': normalizeFsPath(event.path),
          'disk.path.role': classifyFsPath(event.path),
        },
      },
      async () => onDiskEvent(event),
    );
  }

  for (const raw of assetEvents) {
    if (contentFilter) {
      const relPath = toPosix(relative(contentDir, raw.path));
      if (contentFilter.isExcluded(relPath)) continue;
    }
    const relativePath = toPosix(relative(contentDir, raw.path));
    const event: DiskEvent =
      raw.type === 'delete'
        ? { kind: 'asset-delete', path: raw.path, relativePath }
        : { kind: 'asset-create', path: raw.path, relativePath };
    await onDiskEvent(event);
  }

  for (const raw of nonMdRawEvents) {
    const relativePath = toPosix(relative(contentDir, raw.path));
    if (contentFilter?.isPathIgnored(relativePath)) continue;
    if (isSystemDoc(relativePath) || isConfigDoc(relativePath)) continue;

    if (raw.type === 'delete') {
      const event: DiskEvent = { kind: 'file-delete', path: raw.path, relativePath };
      updateFileIndex(event, fileIndex);
      await onDiskEvent(event);
      continue;
    }

    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(raw.path);
      if (st.isSymbolicLink()) st = statSync(raw.path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`[file-watcher] file-event lstat failed for ${raw.path} (${code})`);
      }
      continue;
    }
    if (!st.isFile()) continue;

    const event: DiskEvent =
      raw.type === 'create'
        ? {
            kind: 'file-create',
            path: raw.path,
            relativePath,
            size: st.size,
            modifiedTs: st.mtime.getTime(),
            inode: Number(st.ino),
          }
        : {
            kind: 'file-update',
            path: raw.path,
            relativePath,
            size: st.size,
            modifiedTs: st.mtime.getTime(),
            inode: Number(st.ino),
          };
    updateFileIndex(event, fileIndex);
    await onDiskEvent(event);
  }
}

let _fwEventsCounterCache: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
function _fileWatcherEventsCounter() {
  _fwEventsCounterCache ||= getMeter().createCounter('ok.file_watcher.events', {
    description: 'Number of file-watcher events classified by kind',
  });
  return _fwEventsCounterCache;
}

async function startParcelWatcher(
  contentDir: string,
  contentFilter: ContentFilter | undefined,
  fileIndex: Map<string, FileIndexEntry>,
  folderIndex: Map<string, FolderIndexEntry>,
  onDiskEvent: (event: DiskEvent) => Promise<void>,
  aliasMap: Map<string, string>,
  onAfterMutation: () => void,
): Promise<AsyncSubscription | null> {
  let parcel: typeof import('@parcel/watcher');
  try {
    parcel = await import('@parcel/watcher');
  } catch (err) {
    getLogger('file-watcher').debug(
      { err: err instanceof Error ? err.message : String(err) },
      '[file-watcher] @parcel/watcher import failed; falling back to chokidar',
    );
    return null;
  }

  try {
    const subscribeOpts = contentFilter
      ? { ignore: contentFilter.getWatcherIgnoreGlobs() }
      : undefined;

    const subscription = await parcel.subscribe(
      contentDir,
      async (err, events) => {
        if (err) {
          console.error('[file-watcher]', err);
          return;
        }
        try {
          await handleRawEvents(
            events.map((e) => ({ type: e.type, path: e.path })),
            contentDir,
            contentFilter,
            fileIndex,
            folderIndex,
            onDiskEvent,
            aliasMap,
          );
          onAfterMutation();
        } catch (handleErr) {
          console.error('[file-watcher] parcel batch error:', handleErr);
        }
      },
      subscribeOpts,
    );

    return subscription;
  } catch (err) {
    console.warn('[file-watcher] @parcel/watcher subscribe failed, falling back to chokidar:', err);
    return null;
  }
}

async function startChokidarWatcher(
  contentDir: string,
  contentFilter: ContentFilter | undefined,
  fileIndex: Map<string, FileIndexEntry>,
  folderIndex: Map<string, FolderIndexEntry>,
  onDiskEvent: (event: DiskEvent) => Promise<void>,
  aliasMap: Map<string, string>,
  onAfterMutation: () => void,
): Promise<AsyncSubscription> {
  const { watch } = await import('chokidar');

  const watcher = watch(contentDir, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: contentFilter
      ? (filePath: string, stats?: import('node:fs').Stats) => {
          const rel = toPosix(relative(contentDir, filePath));
          if (rel === '' || rel === '.') return false;
          if (stats?.isDirectory()) return contentFilter.isDirExcluded(rel);
          return contentFilter.isExcluded(rel);
        }
      : undefined,
  });

  watcher.on('error', (err) => console.error('[file-watcher] chokidar error:', err));

  const BATCH_WINDOW_MS = 50;
  let pendingEvents: Array<{ type: 'create' | 'update' | 'delete'; path: string }> = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;

  function queueEvent(type: 'create' | 'update' | 'delete', path: string) {
    pendingEvents.push({ type, path });
    batchTimer ||= setTimeout(() => {
      const batch = pendingEvents;
      pendingEvents = [];
      batchTimer = null;
      handleRawEvents(
        batch,
        contentDir,
        contentFilter,
        fileIndex,
        folderIndex,
        onDiskEvent,
        aliasMap,
      )
        .then(onAfterMutation)
        .catch((err) => console.error('[file-watcher] chokidar batch error:', err));
    }, BATCH_WINDOW_MS);
  }

  watcher.on('add', (path) => queueEvent('create', path));
  watcher.on('change', (path) => queueEvent('update', path));
  watcher.on('unlink', (path) => queueEvent('delete', path));
  watcher.on('addDir', (path) => queueEvent('create', path));
  watcher.on('unlinkDir', (path) => queueEvent('delete', path));

  return {
    unsubscribe: () => {
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
        pendingEvents = [];
      }
      return watcher.close();
    },
  };
}

export async function startWatcher(
  contentDirRaw: string,
  onDiskEvent: (event: DiskEvent) => Promise<void>,
  contentFilter?: ContentFilter,
): Promise<WatcherHandle> {
  let contentDir: string;
  try {
    contentDir = realpathSync(contentDirRaw);
  } catch {
    contentDir = contentDirRaw;
  }

  const fileIndex = new Map<string, FileIndexEntry>();
  const folderIndex = new Map<string, FolderIndexEntry>();
  const aliasMap = new Map<string, string>();
  const folderAliasIndex = new Map<string, string>();

  let fileIndexGeneration = 0;
  let cachedMarkdownView: ReadonlyMap<string, FileIndexEntry> | null = null;
  let cachedMarkdownViewGeneration = -1;
  const bumpFileIndexGeneration = (): void => {
    fileIndexGeneration++;
  };

  await seedLastKnownHashes(
    contentDir,
    contentDir,
    contentFilter,
    fileIndex,
    folderIndex,
    aliasMap,
    folderAliasIndex,
  );
  bumpFileIndexGeneration();

  const evictionInterval = setInterval(evictStaleTrackerEntries, WRITE_TRACKER_TTL_MS);

  let subscription: AsyncSubscription;
  let backend: WatcherBackend;
  try {
    const parcelSub = await startParcelWatcher(
      contentDir,
      contentFilter,
      fileIndex,
      folderIndex,
      onDiskEvent,
      aliasMap,
      bumpFileIndexGeneration,
    );
    if (parcelSub) {
      subscription = parcelSub;
      backend = 'parcel';
    } else {
      subscription = await startChokidarWatcher(
        contentDir,
        contentFilter,
        fileIndex,
        folderIndex,
        onDiskEvent,
        aliasMap,
        bumpFileIndexGeneration,
      );
      backend = 'chokidar';
    }
  } catch (e) {
    clearInterval(evictionInterval);
    throw e;
  }

  const originalUnsubscribe = subscription.unsubscribe.bind(subscription);

  getLogger('file-watcher').info({ contentDir, backend }, 'watching for external .md changes');

  return {
    async unsubscribe() {
      clearInterval(evictionInterval);
      writeTracker.clear();
      lastKnownHash.clear();
      return originalUnsubscribe();
    },
    getFileIndex() {
      if (cachedMarkdownView && cachedMarkdownViewGeneration === fileIndexGeneration) {
        return cachedMarkdownView;
      }
      cachedMarkdownView = markdownIndexView(fileIndex);
      cachedMarkdownViewGeneration = fileIndexGeneration;
      return cachedMarkdownView;
    },
    getAllFilesIndex() {
      return fileIndex;
    },
    getFileIndexGeneration() {
      return fileIndexGeneration;
    },
    getFolderIndex() {
      return folderIndex;
    },
    getAliasMap() {
      return aliasMap;
    },
    getFolderAliasIndex() {
      return folderAliasIndex;
    },
    mutateFileIndex(event) {
      updateFileIndex(event, fileIndex);
      bumpFileIndexGeneration();
    },
    pruneFileIndexNowExcluded() {
      if (!contentFilter) return 0;
      let pruned = 0;
      for (const [docName, entry] of fileIndex) {
        const relPath = toPosix(relative(contentDir, entry.canonicalPath));
        const excluded =
          entry.kind === 'file'
            ? contentFilter.isPathIgnored(relPath)
            : contentFilter.isExcluded(relPath);
        if (excluded) {
          fileIndex.delete(docName);
          pruned++;
        }
      }
      if (pruned > 0) bumpFileIndexGeneration();
      return pruned;
    },
    pruneFolderIndexNowExcluded() {
      if (!contentFilter) return 0;
      let pruned = 0;
      for (const folderPath of folderIndex.keys()) {
        if (contentFilter.isDirExcluded(folderPath)) {
          folderIndex.delete(folderPath);
          pruned++;
        }
      }
      return pruned;
    },
    async rescanFromDisk() {
      await seedLastKnownHashes(
        contentDir,
        contentDir,
        contentFilter,
        fileIndex,
        folderIndex,
        aliasMap,
        folderAliasIndex,
      );
      bumpFileIndexGeneration();
    },
  };
}

export async function reconcileFileIndexAfterFilterRebuild(
  watcher: WatcherHandle | null | undefined,
): Promise<{
  prunedFiles: number;
  prunedFolders: number;
}> {
  if (!watcher) return { prunedFiles: 0, prunedFolders: 0 };
  const prunedFiles = watcher.pruneFileIndexNowExcluded();
  const prunedFolders = watcher.pruneFolderIndexNowExcluded();
  await watcher.rescanFromDisk();
  return { prunedFiles, prunedFolders };
}
