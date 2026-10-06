import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
  watch as watchFsPath,
} from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { LINKABLE_ASSET_EXTENSIONS } from '@inkeep/open-knowledge-core';
import { isConfigDoc, isReservedForUserTree, isSystemDoc } from './cc1-broadcast.ts';
import { type ContentFilter, WATCHER_STRUCTURAL_IGNORE_DIRS } from './content-filter.ts';
import { isWithinContentDir } from './content-path.ts';
import { resolveDirectoryRoot, resolveNativePath } from './directory-root.ts';
import {
  forgetDocExtension,
  getDocExtension,
  isSupportedAssetFile,
  isSupportedDocFile,
  registerDocExtension,
  SUPPORTED_DOC_EXTENSIONS,
  stripDocExtension,
} from './doc-extensions.ts';
import { resolvesIntoPrivateState } from './fs-safety.ts';
import { classifyFsPath, normalizeFsPath } from './fs-traced.ts';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';
import {
  extractPageDescription,
  extractPageIcon,
  extractPageTitle,
  extractPageType,
} from './page-identity.ts';
import { classifyParcelNotification } from './parcel-recovery.ts';
import { subscribeParcel } from './parcel-subscription.ts';
import { toPosix } from './path-utils.ts';
import { containsConflictMarkers } from './reconciliation.ts';
import { getMeter, withSpan } from './telemetry.ts';
import { contentHash } from './version-hash.ts';

export { contentHash } from './version-hash.ts';

const log = getLogger('file-watcher');

export interface AsyncSubscription {
  unsubscribe(): Promise<void>;
}

type WatcherBackend = 'parcel' | 'chokidar';

type MarkdownDiskEvent =
  | { kind: 'create'; path: string; docName: string; content: string }
  | {
      kind: 'update';
      path: string;
      docName: string;
      content: string;
      previousIndexedFields?: {
        title?: string;
        description?: string;
        type?: string;
      };
    }
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

export type AllFileEntries = Iterable<readonly [string, FileIndexEntry]>;

interface GeneralFileMembers {
  readonly regularPaths: readonly string[];
  readonly symlinks: readonly { readonly path: string; readonly targetPath: string }[];
}

export interface FileIndexEntry {
  size: number;
  modified: string;
  canonicalPath: string;
  inode: number;
  aliases: string[];
  kind: 'markdown' | 'file';
  fileMembers?: GeneralFileMembers;
  title?: string;
  icon?: string;
  description?: string;
  type?: string;
}

interface FileIndexEntryMember {
  readonly path: string;
  readonly role: 'regular' | 'symlink';
  readonly targetPath: string;
}

interface FileIndexEntryMembership {
  readonly resolved: boolean;
  readonly members: readonly FileIndexEntryMember[];
}

export function fileIndexEntryMembers(
  contentDir: string,
  name: string,
  entry: FileIndexEntry,
): FileIndexEntryMembership {
  if (entry.kind === 'file' && entry.fileMembers) {
    return {
      resolved: true,
      members: [
        ...entry.fileMembers.regularPaths.map(
          (path): FileIndexEntryMember => ({ path, role: 'regular', targetPath: path }),
        ),
        ...entry.fileMembers.symlinks.map(
          (relation): FileIndexEntryMember => ({
            path: relation.path,
            role: 'symlink',
            targetPath: relation.targetPath,
          }),
        ),
      ],
    };
  }
  const targetPath = indexedTargetPath(
    contentDir,
    entry.canonicalPath,
    entry.kind === 'markdown' ? `${name}${extname(entry.canonicalPath)}` : name,
  );
  return {
    resolved: false,
    members: [
      { path: name, role: 'regular', targetPath },
      ...entry.aliases.map((path): FileIndexEntryMember => ({ path, role: 'symlink', targetPath })),
    ],
  };
}

export function indexedTargetPath(
  contentDir: string,
  canonicalPath: string,
  recordedPath: string,
): string {
  const rel = toPosix(relative(contentDir, canonicalPath));
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return recordedPath;
  return rel;
}

export interface FolderIndexEntry {
  size: 0;
  modified: string;
  canonicalPath: string;
  inode: number;
}

class WatcherFolderIndex extends Map<string, FolderIndexEntry> {
  readonly #root: string;

  constructor(root: string) {
    super();
    this.#root = root;
  }

  override set(relativePath: string, entry: FolderIndexEntry): this {
    const spelledUnderRoot =
      entry.canonicalPath === this.#root || entry.canonicalPath.startsWith(`${this.#root}${sep}`);
    return super.set(
      relativePath,
      spelledUnderRoot ? entry : { ...entry, canonicalPath: declaredPathKey(entry.canonicalPath) },
    );
  }
}

function derivePageMeta(
  content: string,
  docName: string,
): {
  title: string;
  icon: string | undefined;
  description: string | undefined;
  type: string | undefined;
} {
  return {
    title: extractPageTitle(content, docName),
    icon: extractPageIcon(content),
    description: extractPageDescription(content),
    type: extractPageType(content),
  };
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
  getAllFilesIndex: () => AllFileEntries;
  getFileIndexGeneration: () => number;
  getFolderIndex: () => ReadonlyMap<string, FolderIndexEntry>;
  getAliasMap: () => ReadonlyMap<string, string>;
  getFolderAliasIndex: () => ReadonlyMap<string, string>;
  getStructuralIgnoreDirs: () => ReadonlySet<string>;
  mutateFileIndex: (event: DiskEvent) => void;
  pruneFileIndexNowExcluded: () => number;
  pruneFolderIndexNowExcluded: () => number;
  rescanFromDisk: () => Promise<void>;
}

export const writeTracker = new Map<string, Array<{ hash: string; timestamp: number }>>();
const WRITE_TRACKER_TTL_MS = 10_000;
const REMOVAL_TRACKER_TTL_MS = 30_000;

interface OwnWriteObservation {
  key: string;
  hashes: Set<string>;
  savedDuringObservation: boolean;
}

const activeOwnWrites = new Map<string, Set<OwnWriteObservation>>();

export function registerWrite(filePath: string, hash: string): void {
  const key = declaredPathKey(filePath);
  const queue = writeTracker.get(key) ?? [];
  queue.push({ hash, timestamp: Date.now() });
  writeTracker.set(key, queue);
  for (const observation of activeOwnWrites.get(key) ?? []) {
    observation.savedDuringObservation = true;
    observation.hashes.add(hash);
  }
}

function beginOwnWriteObservation(
  filePath: string,
  observations: Map<string, OwnWriteObservation>,
): void {
  if (observations.has(filePath)) return;
  const key = observedPathKey(filePath);
  const observation = {
    key,
    hashes: new Set((writeTracker.get(key) ?? []).map(({ hash }) => hash)),
    savedDuringObservation: false,
  };
  const live = activeOwnWrites.get(key) ?? new Set<OwnWriteObservation>();
  live.add(observation);
  activeOwnWrites.set(key, live);
  observations.set(filePath, observation);
}

function releaseOwnWriteObservations(observations: Map<string, OwnWriteObservation>): void {
  for (const observation of observations.values()) {
    const live = activeOwnWrites.get(observation.key);
    live?.delete(observation);
    if (live?.size === 0) activeOwnWrites.delete(observation.key);
  }
}

function discardSupersededOwnWrite(
  filePath: string,
  content: string,
  observations: ReadonlyMap<string, OwnWriteObservation>,
): boolean {
  const observation = observations.get(filePath);
  if (!observation || !isSupersededOwnWrite(filePath, content, observation)) return false;
  consumeOwnWrite(observation.key, contentHash(content));
  return true;
}

function isSupersededOwnWrite(
  filePath: string,
  content: string,
  observation: OwnWriteObservation,
): boolean {
  if (!observation.savedDuringObservation || !observation.hashes.has(contentHash(content))) {
    return false;
  }
  if (observedPathKey(filePath) !== observation.key) return false;
  try {
    return readFileSync(observation.key, 'utf-8') !== content;
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT') {
      log.warn(
        { path: observation.key, eventPath: filePath, err: e },
        `Supersession recheck failed to read ${observation.key}`,
      );
    }
    return false;
  }
}

export const removalTracker = new Map<string, number>();

function declaredPathKey(filePath: string): string {
  const parent = dirname(filePath);
  if (parent === filePath) return filePath;
  try {
    return join(resolveNativePath(parent), basename(filePath));
  } catch (e) {
    const code = errnoCode(e);
    if (code === 'ENOENT') return join(declaredPathKey(parent), basename(filePath));
    log.warn(
      { path: filePath, code },
      `native path resolution failed for the declared key of ${filePath} (${code})`,
    );
    return filePath;
  }
}

function observedPathKey(filePath: string): string {
  try {
    return resolveNativePath(filePath);
  } catch (e) {
    const code = errnoCode(e);
    if (code === 'ENOENT') return declaredPathKey(filePath);
    log.warn(
      { path: filePath, code },
      `native path resolution failed for the observed key of ${filePath} (${code})`,
    );
    return filePath;
  }
}

export type RemovalDeclaration = string & { readonly __brand: 'RemovalDeclaration' };

type Assert<T extends true> = T;
type _RawStringIsNotARemovalDeclaration = Assert<string extends RemovalDeclaration ? false : true>;

/* STOP: call this before the unlink, retract it if the unlink throws, and never resolve the
   leaf; the watcher reports a removed alias at the alias, not at the target it pointed to. */
export function registerRemoval(filePath: string): RemovalDeclaration {
  const key = declaredPathKey(filePath);
  removalTracker.set(key, Date.now());
  return key as RemovalDeclaration;
}

export function retractRemoval(declaration: RemovalDeclaration): void {
  removalTracker.delete(declaration);
}

function voidRemoval(filePath: string, declaredBeforeBatch: ReadonlySet<string>): void {
  if (declaredBeforeBatch.size === 0) return;
  const key = declaredPathKey(filePath);
  if (!declaredBeforeBatch.has(key)) return;
  removalTracker.delete(key);
}

/* STOP: return false on every ambiguous input; a true discards a real disk deletion. */
export function isSelfRemoval(filePath: string): boolean {
  if (removalTracker.size === 0) return false;
  const key = declaredPathKey(filePath);
  const timestamp = removalTracker.get(key);
  if (timestamp === undefined) return false;
  removalTracker.delete(key);
  return Date.now() - timestamp <= REMOVAL_TRACKER_TTL_MS;
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
  for (const [path, timestamp] of removalTracker) {
    if (now - timestamp > REMOVAL_TRACKER_TTL_MS) removalTracker.delete(path);
  }
}

type WatcherDropReason =
  | 'symlink-escape'
  | 'filter-excluded'
  | 'read-failed'
  | 'reserved-doc'
  | 'stat-failed';

type WatcherDecision =
  | 'dispatched'
  | 'self-write-skip'
  | 'superseded-own-write-skip'
  | 'self-removal-skip'
  | `drop-${WatcherDropReason}`;

export interface WatcherDecisionRecord {
  ts: number;
  decision: WatcherDecision;
  kind: string;
  path: string;
  pathRole: string;
}

const WATCHER_DECISION_RING_CAPACITY = 256;
const watcherDecisionRing: WatcherDecisionRecord[] = [];

const watcherDropCounts = new Map<WatcherDropReason, number>();
let watcherDispatchedCount = 0;
let watcherSelfWriteSkipCount = 0;
let watcherSupersededOwnWriteSkipCount = 0;
let watcherSelfRemovalSkipCount = 0;
let watcherDropsSinceLastSummary = 0;

function recordWatcherDecision(decision: WatcherDecision, kind: string, rawPath: string): void {
  watcherDecisionRing.push({
    ts: Date.now(),
    decision,
    kind,
    path: normalizeFsPath(rawPath),
    pathRole: classifyFsPath(rawPath),
  });
  if (watcherDecisionRing.length > WATCHER_DECISION_RING_CAPACITY) {
    watcherDecisionRing.shift();
  }
  if (decision === 'dispatched') {
    watcherDispatchedCount++;
    return;
  }
  if (decision === 'self-write-skip') {
    watcherSelfWriteSkipCount++;
    return;
  }
  if (decision === 'superseded-own-write-skip') {
    watcherSupersededOwnWriteSkipCount++;
    return;
  }
  if (decision === 'self-removal-skip') {
    watcherSelfRemovalSkipCount++;
    return;
  }
  const reason = decision.slice('drop-'.length) as WatcherDropReason;
  watcherDropCounts.set(reason, (watcherDropCounts.get(reason) ?? 0) + 1);
  watcherDropsSinceLastSummary++;
  _fileWatcherDropsCounter().add(1, { 'disk.drop_reason': reason });
}

function recordSupersededOwnWriteSkip(kind: DiskEvent['kind'], filePath: string): void {
  log.debug(
    { kind, path: filePath, self: true, superseded: true },
    `[file-watcher] Skipped superseded own write: ${kind}`,
  );
  _fileWatcherEventsCounter().add(1, { 'disk.kind': kind, self: true, 'disk.superseded': true });
  recordWatcherDecision('superseded-own-write-skip', kind, filePath);
}

export function getWatcherDecisionRingSnapshot(): WatcherDecisionRecord[] {
  return watcherDecisionRing.map((record) => ({ ...record }));
}

const WATCHER_DROP_SUMMARY_INTERVAL_MS = 60_000;

export function logWatcherDropSummary(): void {
  if (watcherDropsSinceLastSummary === 0) return;
  const droppedSinceLastSummary = watcherDropsSinceLastSummary;
  watcherDropsSinceLastSummary = 0;
  const dropTotals: Record<string, number> = {};
  for (const [reason, count] of watcherDropCounts) {
    dropTotals[reason] = count;
  }
  log.info(
    {
      droppedSinceLastSummary,
      dropTotals,
      dispatched: watcherDispatchedCount,
      selfWriteSkips: watcherSelfWriteSkipCount,
      supersededOwnWriteSkips: watcherSupersededOwnWriteSkipCount,
      selfRemovalSkips: watcherSelfRemovalSkipCount,
    },
    `[file-watcher] drop summary: ${droppedSinceLastSummary} event(s) dropped since last summary`,
  );
}

export function resetWatcherDecisionDiagnostics(): void {
  watcherDecisionRing.length = 0;
  watcherDropCounts.clear();
  watcherDispatchedCount = 0;
  watcherSelfWriteSkipCount = 0;
  watcherSupersededOwnWriteSkipCount = 0;
  watcherSelfRemovalSkipCount = 0;
  watcherDropsSinceLastSummary = 0;
}

function eventEscapesContentDir(rawPath: string, contentDir: string): boolean {
  let lst: ReturnType<typeof lstatSync>;
  try {
    lst = lstatSync(rawPath);
  } catch (e) {
    const code = errnoCode(e);
    if (code === 'ENOENT') return false;
    log.warn(
      { path: rawPath, code },
      `lstat failed for escape check on ${rawPath} (${code}), dropping event`,
    );
    return true;
  }
  if (!lst.isSymbolicLink()) return false;
  let canonical: string;
  try {
    canonical = resolveNativePath(rawPath);
  } catch (e) {
    const code = errnoCode(e);
    if (code !== 'ENOENT' && code !== 'ELOOP') {
      log.warn(
        { path: rawPath, code },
        `realpath failed for escape check on ${rawPath} (${code}), dropping event`,
      );
    }
    return true;
  }
  return (
    !isWithinContentDir(canonical, contentDir) ||
    resolvesIntoPrivateState(rawPath, canonical, contentDir)
  );
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

type KnownDeletion = {
  type: 'delete';
  path: string;
  entryKind: 'file' | 'folder';
};

type RecoveredFileEvent = { type: 'create' | 'update'; path: string } | KnownDeletion;
type InternalRawFileEvent = RawFileEvent | KnownDeletion;

export async function classifyEvents(
  rawEvents: RawFileEvent[],
  contentDir: string,
  contentFilter?: ContentFilter,
  aliasMap?: Map<string, string>,
): Promise<MarkdownDiskEvent[]> {
  const observations = new Map<string, OwnWriteObservation>();
  try {
    return await classifyEventsInternal(
      rawEvents,
      contentDir,
      observations,
      contentFilter,
      aliasMap,
    );
  } finally {
    releaseOwnWriteObservations(observations);
  }
}

async function classifyEventsInternal(
  rawEvents: RawFileEvent[],
  contentDir: string,
  observations: Map<string, OwnWriteObservation>,
  contentFilter?: ContentFilter,
  aliasMap?: Map<string, string>,
  aliasContext?: {
    fileIndex: ReadonlyMap<string, FileIndexEntry>;
    aliasPaths: ReadonlyMap<string, string>;
    canonicalRecords: Set<RawFileEvent>;
  },
): Promise<MarkdownDiskEvent[]> {
  const deletes: RawFileEvent[] = [];
  const creates: RawFileEvent[] = [];
  const updates: RawFileEvent[] = [];

  for (const event of rawEvents) {
    if (!isSupportedDocFile(event.path)) continue;

    if (contentFilter) {
      const relPath = toPosix(relative(contentDir, event.path));
      if (contentFilter.isExcluded(relPath)) {
        recordWatcherDecision('drop-filter-excluded', event.type, event.path);
        continue;
      }
    }

    switch (event.type) {
      case 'delete': {
        if (aliasContext) {
          const name = pathToDocName(event.path, contentDir);
          const owner = aliasContext.fileIndex.get(name);
          const canonicalPath = owner?.kind === 'markdown' ? owner.canonicalPath : undefined;
          const aliasPath = aliasMap?.has(name) ? aliasContext.aliasPaths.get(name) : undefined;
          if (
            (canonicalPath !== undefined || aliasPath !== undefined) &&
            canonicalPath !== event.path &&
            aliasPath !== event.path
          ) {
            removeLastKnownHash(event.path);
            continue;
          }
        }
        deletes.push(event);
        break;
      }
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
    beginOwnWriteObservation(event.path, observations);
    try {
      createContents.set(event.path, await readFile(event.path, 'utf-8'));
    } catch (e) {
      recordWatcherDecision('drop-read-failed', event.type, event.path);
      if (errnoCode(e) !== 'ENOENT') {
        log.warn({ path: event.path, err: e }, `Failed to read ${event.path}`);
      }
    }
  }
  for (const event of updates) {
    beginOwnWriteObservation(event.path, observations);
    try {
      updateContents.set(event.path, await readFile(event.path, 'utf-8'));
    } catch (e) {
      recordWatcherDecision('drop-read-failed', event.type, event.path);
      if (errnoCode(e) !== 'ENOENT') {
        log.warn({ path: event.path, err: e }, `Failed to read ${event.path}`);
      }
    }
  }

  for (const [contents, type] of [
    [createContents, 'create'],
    [updateContents, 'update'],
  ] as const) {
    for (const [filePath, content] of contents) {
      if (!discardSupersededOwnWrite(filePath, content, observations)) continue;
      contents.delete(filePath);
      recordSupersededOwnWriteSkip(type, filePath);
    }
  }

  function resolveDocName(event: RawFileEvent): string {
    const rawPath = event.path;
    const raw = pathToDocName(rawPath, contentDir);
    if (!aliasMap) return raw;

    let lst: ReturnType<typeof lstatSync> | null = null;
    try {
      lst = lstatSync(rawPath);
    } catch (e) {
      const code = errnoCode(e);
      if (code !== 'ENOENT') {
        log.warn({ path: rawPath, err: e }, `resolveDocName lstat failed for ${rawPath}`);
      }
      if (aliasMap.has(raw)) {
        aliasMap.delete(raw);
        return raw;
      }
      return raw;
    }

    if (!lst.isSymbolicLink()) {
      const owner = aliasContext?.fileIndex.get(raw);
      const aliasPath = aliasContext?.aliasPaths.get(raw);
      if (
        event.type !== 'delete' &&
        owner?.kind === 'markdown' &&
        owner.canonicalPath === rawPath &&
        aliasMap.has(raw) &&
        aliasPath !== undefined &&
        aliasPath !== rawPath
      ) {
        aliasContext?.canonicalRecords.add(event);
        return raw;
      }
      if (aliasMap.has(raw)) aliasMap.delete(raw);
      return raw;
    }

    let canonical: string;
    try {
      canonical = resolveNativePath(rawPath);
    } catch (e) {
      const code = errnoCode(e);
      if (code !== 'ENOENT' && code !== 'ELOOP') {
        log.warn({ path: rawPath, err: e }, `resolveDocName realpath failed for ${rawPath}`);
      }
      aliasMap.delete(raw);
      return raw;
    }

    if (!isWithinContentDir(canonical, contentDir)) {
      aliasMap.delete(raw);
      return raw;
    }

    const canonicalDocName = pathToDocName(canonical, contentDir);
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
          oldDocName: resolveDocName(del),
          newDocName: resolveDocName(create),
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
      docName: resolveDocName(del),
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
        docName: resolveDocName(create),
        content,
      });
    } else {
      results.push({
        kind: 'create',
        path: create.path,
        docName: resolveDocName(create),
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
        docName: resolveDocName(update),
        content,
      });
    } else {
      results.push({
        kind: 'update',
        path: update.path,
        docName: resolveDocName(update),
        content,
      });
    }
  }

  return results;
}

function declaredDiskEvent(event: DiskEvent): DiskEvent {
  if (event.kind === 'rename') {
    return {
      ...event,
      oldPath: declaredPathKey(event.oldPath),
      newPath: declaredPathKey(event.newPath),
    };
  }
  return { ...event, path: declaredPathKey(event.path) };
}

export function isSelfWrite(filePath: string, hash: string): boolean {
  if (consumeOwnWrite(filePath, hash)) return true;
  writeTracker.delete(filePath);
  return false;
}

function consumeOwnWrite(key: string, hash: string): boolean {
  const queue = writeTracker.get(key);
  if (!queue) return false;
  const idx = queue.findIndex((e) => e.hash === hash);
  if (idx < 0) return false;
  queue.splice(0, idx + 1);
  if (queue.length === 0) writeTracker.delete(key);
  return true;
}

interface DiskObservation {
  fileIndex: Map<string, FileIndexEntry>;
  generalFileIndex: GeneralFileIndex;
  folderIndex: Map<string, FolderIndexEntry>;
  aliasMap: Map<string, string>;
  aliasPaths: Map<string, string>;
  folderAliasIndex: Map<string, string>;
  hashes: Map<string, string>;
  extensions: Array<{ docName: string; ext: string }>;
  preferredExtensions: Map<string, string>;
  structuralIgnoreDirs: Set<string>;
  paths: Set<string>;
  complete: boolean;
}

type GeneralIdentity = { device: number; inode: number };
type KnownGeneralEntry = FileIndexEntry & { kind: 'file'; fileMembers: GeneralFileMembers };
type GeneralFileState =
  | { kind: 'known'; entry: KnownGeneralEntry; identity: GeneralIdentity; sequence: number }
  | { kind: 'unresolved'; reportedPath: string; sequence: number };
type GeneralMetadata = { size: number; modified: string };

const generalFileStates = new WeakMap<FileIndexEntry, GeneralFileState>();
let generalFileSequence = 0;

function knownGeneralState(
  entry: FileIndexEntry,
): Extract<GeneralFileState, { kind: 'known' }> | null {
  const state = generalFileStates.get(entry);
  return state?.kind === 'known' ? state : null;
}

function sameGeneralIdentity(left: GeneralIdentity, right: GeneralIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function generalIdentityKey(identity: GeneralIdentity): string {
  return `${identity.device}:${identity.inode}`;
}

function addGeneralOwner(owners: Map<string, Set<string>>, key: string, name: string): void {
  const names = owners.get(key);
  if (names) names.add(name);
  else owners.set(key, new Set([name]));
}

function removeGeneralOwner(owners: Map<string, Set<string>>, key: string, name: string): void {
  const names = owners.get(key);
  if (!names) return;
  names.delete(name);
  if (names.size === 0) owners.delete(key);
}

class GeneralFileIndex implements ReadonlyMap<string, FileIndexEntry> {
  readonly #contentDir: string;
  readonly #entries = new Map<string, FileIndexEntry>();
  readonly #linked = new Map<
    string,
    { readonly members: readonly string[]; readonly identity: string | null }
  >();
  readonly #members = new Map<string, Set<string>>();
  readonly #identities = new Map<string, Set<string>>();

  constructor(contentDir: string) {
    this.#contentDir = contentDir;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(name: string): FileIndexEntry | undefined {
    return this.#entries.get(name);
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  keys(): MapIterator<string> {
    return this.#entries.keys();
  }

  values(): MapIterator<FileIndexEntry> {
    return this.#entries.values();
  }

  entries(): MapIterator<[string, FileIndexEntry]> {
    return this.#entries.entries();
  }

  [Symbol.iterator](): MapIterator<[string, FileIndexEntry]> {
    return this.#entries[Symbol.iterator]();
  }

  forEach(
    callback: (
      entry: FileIndexEntry,
      name: string,
      index: ReadonlyMap<string, FileIndexEntry>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [name, entry] of this.#entries) callback.call(thisArg, entry, name, this);
  }

  ownersOfPath(path: string): ReadonlySet<string> | undefined {
    return this.#members.get(path);
  }

  ownersOfIdentity(identity: GeneralIdentity): ReadonlySet<string> | undefined {
    return this.#identities.get(generalIdentityKey(identity));
  }

  set(name: string, entry: FileIndexEntry): void {
    Object.freeze(entry.aliases);
    Object.freeze(entry);
    this.#unlink(name);
    this.#entries.set(name, entry);
    this.#link(name, entry);
  }

  delete(name: string): void {
    this.#unlink(name);
    this.#entries.delete(name);
  }

  clear(): void {
    this.#entries.clear();
    this.#linked.clear();
    this.#members.clear();
    this.#identities.clear();
  }

  #link(name: string, entry: FileIndexEntry): void {
    const members = fileIndexEntryMembers(this.#contentDir, name, entry).members.map(
      (member) => member.path,
    );
    for (const member of members) addGeneralOwner(this.#members, member, name);
    const state = knownGeneralState(entry);
    const identity = state ? generalIdentityKey(state.identity) : null;
    if (identity !== null) addGeneralOwner(this.#identities, identity, name);
    this.#linked.set(name, { members, identity });
  }

  #unlink(name: string): void {
    const linked = this.#linked.get(name);
    if (!linked) return;
    for (const member of linked.members) removeGeneralOwner(this.#members, member, name);
    if (linked.identity !== null) removeGeneralOwner(this.#identities, linked.identity, name);
    this.#linked.delete(name);
  }
}

function generalOwnerNames(index: GeneralFileIndex, path: string): string[] {
  return [...(index.ownersOfPath(path) ?? [])];
}

function generalFactsFor(
  index: GeneralFileIndex,
  paths: Iterable<string>,
): Map<string, GeneralPathFact> {
  const names = new Set<string>();
  for (const path of paths) {
    for (const name of index.ownersOfPath(path) ?? []) names.add(name);
  }
  const facts = new Map<string, GeneralPathFact>();
  for (const name of names) {
    const entry = index.get(name);
    if (entry) addGeneralEntryFacts(facts, name, entry);
  }
  return facts;
}

function findKnownGeneralGroup(
  index: GeneralFileIndex,
  identity: GeneralIdentity,
): [string, KnownGeneralEntry] | null {
  for (const name of index.ownersOfIdentity(identity) ?? []) {
    const entry = index.get(name);
    const state = entry && knownGeneralState(entry);
    if (state && sameGeneralIdentity(state.identity, identity)) return [name, state.entry];
  }
  return null;
}

function storeKnownGeneralGroup(
  index: GeneralFileIndex,
  contentDir: string,
  previousName: string | null,
  identity: GeneralIdentity,
  regularPaths: readonly string[],
  symlinks: GeneralFileMembers['symlinks'],
  metadata: GeneralMetadata,
  sequence = ++generalFileSequence,
): void {
  const regular = [...new Set(regularPaths)].toSorted();
  if (previousName !== null) {
    const current = index.get(previousName);
    const currentState = current && knownGeneralState(current);
    if (currentState && sameGeneralIdentity(currentState.identity, identity)) {
      index.delete(previousName);
    }
  }
  if (regular.length === 0) return;
  const representative = previousName && regular.includes(previousName) ? previousName : regular[0];
  const relations = [...new Map(symlinks.map((relation) => [relation.path, relation])).values()]
    .filter((relation) => !regular.includes(relation.path))
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const entry: KnownGeneralEntry = {
    kind: 'file',
    canonicalPath: join(contentDir, representative),
    inode: identity.inode,
    size: metadata.size,
    modified: metadata.modified,
    aliases: relations.map((relation) => relation.path),
    fileMembers: { regularPaths: regular, symlinks: relations },
  };
  generalFileStates.set(entry, { kind: 'known', entry, identity, sequence });
  index.set(representative, entry);
}

function storeUnresolvedGeneralEntry(
  index: GeneralFileIndex,
  contentDir: string,
  event: Extract<FileDiskEvent, { kind: 'file-create' | 'file-update' }>,
): void {
  const name = toPosix(relative(contentDir, event.path));
  const prior = index.get(name);
  const entry: FileIndexEntry = {
    kind: 'file',
    canonicalPath: event.path,
    inode: event.inode || prior?.inode || 0,
    size: event.size,
    modified: new Date(event.modifiedTs).toISOString(),
    aliases:
      prior?.kind === 'file'
        ? fileIndexEntryMembers(contentDir, name, prior)
            .members.filter((member) => member.role === 'symlink')
            .map((member) => member.path)
        : [],
  };
  generalFileStates.set(entry, {
    kind: 'unresolved',
    reportedPath: event.relativePath,
    sequence: ++generalFileSequence,
  });
  index.set(name, entry);
}

function removeKnownGeneralPath(index: GeneralFileIndex, contentDir: string, path: string): void {
  for (const name of generalOwnerNames(index, path)) {
    const entry = index.get(name);
    if (!entry) continue;
    const state = knownGeneralState(entry);
    if (!state) {
      if (name === path) index.delete(name);
      else if (entry.kind === 'file' && entry.aliases.includes(path)) {
        index.set(name, {
          ...entry,
          aliases: entry.aliases.filter((alias) => alias !== path),
        });
      }
      continue;
    }
    const members = state.entry.fileMembers;
    const regular = members.regularPaths.filter((member) => member !== path);
    const symlinks = members.symlinks.filter(
      (relation) =>
        relation.path !== path &&
        (regular.length === members.regularPaths.length || relation.targetPath !== path),
    );
    if (
      regular.length === members.regularPaths.length &&
      symlinks.length === members.symlinks.length
    )
      continue;
    storeKnownGeneralGroup(
      index,
      contentDir,
      name,
      state.identity,
      regular,
      symlinks,
      entry,
      state.sequence,
    );
  }
}

type GeneralRegistrationResult =
  | { kind: 'applied'; changedPaths: ReadonlySet<string> }
  | { kind: 'unobserved' };

function registerKnownGeneralPath(
  index: GeneralFileIndex,
  contentDir: string,
  canonicalName: string,
  lexicalName: string,
  leafSymlink: boolean,
  identity: GeneralIdentity,
  metadata: GeneralMetadata,
  contentFilter?: ContentFilter,
  confirmedAbsentFormerPath?: string,
): GeneralRegistrationResult {
  const changes = new Map<string, GeneralPathFact | null>();
  const selectedFact = (path: string): GeneralPathFact | undefined =>
    changes.has(path) ? (changes.get(path) ?? undefined) : generalFactsFor(index, [path]).get(path);
  const prior = selectedFact(lexicalName);
  const priorIdentity =
    prior?.kind === 'regular' || prior?.kind === 'symlink' ? prior.identity : null;
  const priorOwner = priorIdentity && findKnownGeneralGroup(index, priorIdentity)?.[1];
  const roleChanged =
    prior !== undefined &&
    prior.kind !== 'unresolved' &&
    (prior.kind === 'symlink') !== leafSymlink;
  const targetChanged =
    prior?.kind === 'symlink' && leafSymlink && prior.targetPath !== canonicalName;
  const sequence = ++generalFileSequence;
  const primaryPath = leafSymlink ? lexicalName : canonicalName;
  const primary: GeneralPathFact = leafSymlink
    ? {
        kind: 'symlink',
        path: lexicalName,
        targetPath: canonicalName,
        identity,
        metadata,
        sequence,
      }
    : { kind: 'regular', path: primaryPath, identity, metadata, sequence };

  if (roleChanged || targetChanged) {
    for (const relation of priorOwner?.fileMembers.symlinks ?? []) {
      if (relation.path === lexicalName) continue;
      const path = join(contentDir, relation.path);
      try {
        const actualTarget = resolveNativePath(path);
        if (!isWithinContentDir(actualTarget, contentDir)) {
          changes.set(relation.path, null);
          continue;
        }
        const targetPath = toPosix(relative(contentDir, actualTarget));
        if (
          isSystemDoc(targetPath) ||
          isConfigDoc(targetPath) ||
          contentFilter?.isPathIgnored(relation.path) ||
          contentFilter?.isPathIgnored(targetPath)
        ) {
          changes.set(relation.path, null);
          continue;
        }
        const targetStat = targetPath === canonicalName ? null : statSync(actualTarget);
        if (targetStat && !targetStat.isFile()) {
          changes.set(relation.path, null);
          continue;
        }
        const targetIdentity = targetStat
          ? { device: targetStat.dev, inode: targetStat.ino }
          : identity;
        const targetMetadata = targetStat
          ? { size: targetStat.size, modified: targetStat.mtime.toISOString() }
          : metadata;
        const existingTarget = selectedFact(targetPath);
        if (
          existingTarget?.kind !== 'regular' ||
          !sameGeneralIdentity(existingTarget.identity, targetIdentity)
        ) {
          changes.set(targetPath, {
            kind: 'regular',
            path: targetPath,
            identity: targetIdentity,
            metadata: targetMetadata,
            sequence,
          });
        }
        changes.set(relation.path, {
          kind: 'symlink',
          path: relation.path,
          targetPath,
          identity: targetIdentity,
          metadata: targetMetadata,
          sequence,
        });
      } catch (err) {
        const code = errnoCode(err);
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
          changes.set(relation.path, null);
          continue;
        }
        log.warn({ path, code, err }, 'dependent symlink target read failed');
        return { kind: 'unobserved' };
      }
    }
  }

  if (confirmedAbsentFormerPath) changes.set(confirmedAbsentFormerPath, null);
  if (leafSymlink) {
    const current = selectedFact(canonicalName);
    if (current?.kind !== 'regular' || !sameGeneralIdentity(current.identity, identity)) {
      changes.set(canonicalName, {
        kind: 'regular',
        path: canonicalName,
        identity,
        metadata,
        sequence,
      });
    }
  }
  changes.set(primaryPath, primary);

  const affected = new Set<string>();
  const include = (names: ReadonlySet<string> | undefined): void => {
    for (const name of names ?? []) affected.add(name);
  };
  include(index.ownersOfIdentity(identity));
  for (const [path, fact] of changes) {
    include(index.ownersOfPath(path));
    if (fact?.kind === 'regular') include(index.ownersOfIdentity(fact.identity));
    else if (fact?.kind === 'symlink') include(index.ownersOfPath(fact.targetPath));
  }
  const previousFacts = new Map<string, GeneralPathFact>();
  const representatives = new Map<string, string>();
  for (const name of affected) {
    const entry = index.get(name);
    if (!entry) continue;
    addGeneralEntryFacts(previousFacts, name, entry);
    const state = knownGeneralState(entry);
    const key = state && generalIdentityKey(state.identity);
    if (key && !representatives.has(key)) representatives.set(key, name);
  }
  const selected = new Map(previousFacts);
  for (const [path, fact] of changes) {
    if (fact) selected.set(path, fact);
    else selected.delete(path);
  }
  const metadataEffects = new Map<string, GeneralMetadataEffect>([
    [generalIdentityKey(identity), { ...metadata, sequence }],
  ]);
  for (const name of affected) index.delete(name);
  storeGeneralFacts(index, contentDir, selected, representatives, metadataEffects);
  const comparedPaths = new Set([...previousFacts.keys(), ...selected.keys()]);
  const nextFacts = generalFactsFor(index, comparedPaths);
  const changedPaths = new Set<string>();
  for (const path of comparedPaths) {
    const before = previousFacts.get(path);
    const after = nextFacts.get(path);
    if (before?.kind !== after?.kind) {
      changedPaths.add(path);
    } else if (before?.kind === 'symlink' && after?.kind === 'symlink') {
      if (
        before.targetPath !== after.targetPath ||
        !sameGeneralIdentity(before.identity, after.identity)
      ) {
        changedPaths.add(path);
      }
    } else if (before?.kind === 'regular' && after?.kind === 'regular') {
      if (!sameGeneralIdentity(before.identity, after.identity)) changedPaths.add(path);
    }
  }
  return { kind: 'applied', changedPaths };
}

function generalMemberPaths(
  contentDir: string,
  index: ReadonlyMap<string, FileIndexEntry>,
): Set<string> {
  const paths = new Set<string>();
  for (const [name, entry] of index) {
    if (entry.kind !== 'file') continue;
    for (const member of fileIndexEntryMembers(contentDir, name, entry).members) {
      paths.add(member.path);
    }
  }
  return paths;
}

type GeneralPathFact =
  | {
      kind: 'regular';
      path: string;
      identity: GeneralIdentity;
      metadata: GeneralMetadata;
      sequence: number;
    }
  | {
      kind: 'symlink';
      path: string;
      targetPath: string;
      identity: GeneralIdentity;
      metadata: GeneralMetadata;
      sequence: number;
    }
  | { kind: 'unresolved'; path: string; entry: FileIndexEntry; sequence: number };

type GeneralMetadataEffect = GeneralMetadata & { sequence: number };
type GeneralMutationRecord = {
  generalNames: Set<string>;
  generalEffects: Map<string, GeneralPathFact | null>;
  generalMetadata: Map<string, GeneralMetadataEffect>;
};

function addGeneralEntryFacts(
  facts: Map<string, GeneralPathFact>,
  name: string,
  entry: FileIndexEntry,
): void {
  if (entry.kind !== 'file') return;
  const state = knownGeneralState(entry);
  if (!state) {
    facts.set(name, {
      kind: 'unresolved',
      path: name,
      entry,
      sequence: generalFileStates.get(entry)?.sequence ?? 0,
    });
    return;
  }
  const knownEntry = state.entry;
  const metadata = { size: knownEntry.size, modified: knownEntry.modified };
  for (const path of knownEntry.fileMembers.regularPaths) {
    facts.set(path, {
      kind: 'regular',
      path,
      identity: state.identity,
      metadata,
      sequence: state.sequence,
    });
  }
  for (const relation of knownEntry.fileMembers.symlinks) {
    facts.set(relation.path, {
      kind: 'symlink',
      path: relation.path,
      targetPath: relation.targetPath,
      identity: state.identity,
      metadata,
      sequence: state.sequence,
    });
  }
}

function generalPathFacts(
  index: ReadonlyMap<string, FileIndexEntry>,
): Map<string, GeneralPathFact> {
  const facts = new Map<string, GeneralPathFact>();
  for (const [name, entry] of index) addGeneralEntryFacts(facts, name, entry);
  return facts;
}

function generalRepresentativeNames(
  index: ReadonlyMap<string, FileIndexEntry>,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const [name, entry] of index) {
    const state = knownGeneralState(entry);
    if (!state) continue;
    const key = generalIdentityKey(state.identity);
    if (!names.has(key)) names.set(key, name);
  }
  return names;
}

function rebuildGeneralFileIndex(
  index: GeneralFileIndex,
  contentDir: string,
  facts: ReadonlyMap<string, GeneralPathFact>,
  previousRepresentatives: ReadonlyMap<string, string>,
  metadataEffects: ReadonlyMap<string, GeneralMetadataEffect> = new Map(),
): void {
  index.clear();
  storeGeneralFacts(index, contentDir, facts, previousRepresentatives, metadataEffects);
}

function storeGeneralFacts(
  index: GeneralFileIndex,
  contentDir: string,
  facts: ReadonlyMap<string, GeneralPathFact>,
  previousRepresentatives: ReadonlyMap<string, string>,
  metadataEffects: ReadonlyMap<string, GeneralMetadataEffect>,
): void {
  const grouped = new Map<
    string,
    {
      identity: GeneralIdentity;
      regularPaths: string[];
      symlinks: GeneralFileMembers['symlinks'][number][];
      metadata: GeneralMetadata;
      sequence: number;
    }
  >();
  for (const fact of facts.values()) {
    if (fact.kind !== 'regular') continue;
    const key = generalIdentityKey(fact.identity);
    const group = grouped.get(key);
    if (group) {
      group.regularPaths.push(fact.path);
      if (fact.sequence >= group.sequence) {
        group.metadata = fact.metadata;
        group.sequence = fact.sequence;
      }
    } else {
      grouped.set(key, {
        identity: fact.identity,
        regularPaths: [fact.path],
        symlinks: [],
        metadata: fact.metadata,
        sequence: fact.sequence,
      });
    }
  }
  for (const fact of facts.values()) {
    if (fact.kind !== 'symlink') continue;
    const target = facts.get(fact.targetPath);
    if (target?.kind !== 'regular') continue;
    grouped.get(generalIdentityKey(target.identity))?.symlinks.push({
      path: fact.path,
      targetPath: fact.targetPath,
    });
  }
  for (const [key, group] of grouped) {
    const priorName = previousRepresentatives.get(key) ?? null;
    const effect = metadataEffects.get(key);
    storeKnownGeneralGroup(
      index,
      contentDir,
      priorName,
      group.identity,
      group.regularPaths,
      group.symlinks,
      effect ?? group.metadata,
      effect?.sequence ?? group.sequence,
    );
  }
  for (const fact of facts.values()) {
    if (fact.kind !== 'unresolved' || index.has(fact.path)) continue;
    index.set(fact.path, fact.entry);
  }
}

type GeneralScanAccumulator = {
  facts: Map<string, GeneralPathFact>;
  metadataEffects: Map<string, GeneralMetadataEffect>;
};

function materializeScanGeneralIndex(
  observation: DiskObservation,
  contentDir: string,
  scan: GeneralScanAccumulator,
): void {
  const representatives = generalRepresentativeNames(observation.generalFileIndex);
  for (const fact of scan.facts.values()) {
    if (fact.kind !== 'regular') continue;
    const key = generalIdentityKey(fact.identity);
    if (!representatives.has(key)) representatives.set(key, fact.path);
  }
  const next = new GeneralFileIndex(contentDir);
  rebuildGeneralFileIndex(next, contentDir, scan.facts, representatives, scan.metadataEffects);
  observation.generalFileIndex = next;
}

function recordScannedGeneralPath(
  observation: DiskObservation,
  scan: GeneralScanAccumulator,
  contentDir: string,
  canonicalName: string,
  lexicalName: string,
  leafSymlink: boolean,
  identity: GeneralIdentity,
  metadata: GeneralMetadata,
  contentFilter: ContentFilter | undefined,
): GeneralRegistrationResult['kind'] {
  const prior = scan.facts.get(lexicalName);
  const roleChanged =
    prior !== undefined &&
    prior.kind !== 'unresolved' &&
    (prior.kind === 'symlink') !== leafSymlink;
  const targetChanged =
    prior?.kind === 'symlink' && leafSymlink && prior.targetPath !== canonicalName;
  if (roleChanged || targetChanged) {
    materializeScanGeneralIndex(observation, contentDir, scan);
    const registered = registerKnownGeneralPath(
      observation.generalFileIndex,
      contentDir,
      canonicalName,
      lexicalName,
      leafSymlink,
      identity,
      metadata,
      contentFilter,
    );
    scan.facts = generalPathFacts(observation.generalFileIndex);
    scan.metadataEffects.clear();
    return registered.kind;
  }

  const sequence = ++generalFileSequence;
  if (leafSymlink) {
    const target = scan.facts.get(canonicalName);
    if (target?.kind !== 'regular' || !sameGeneralIdentity(target.identity, identity)) {
      scan.facts.set(canonicalName, {
        kind: 'regular',
        path: canonicalName,
        identity,
        metadata,
        sequence,
      });
    }
    scan.facts.set(lexicalName, {
      kind: 'symlink',
      path: lexicalName,
      targetPath: canonicalName,
      identity,
      metadata,
      sequence,
    });
  } else {
    scan.facts.set(canonicalName, {
      kind: 'regular',
      path: canonicalName,
      identity,
      metadata,
      sequence,
    });
  }
  scan.metadataEffects.set(generalIdentityKey(identity), { ...metadata, sequence });
  return 'applied';
}

function recordGeneralPublicEffect(
  record: GeneralMutationRecord,
  index: GeneralFileIndex,
  contentDir: string,
  event: FileDiskEvent,
  changedPaths: ReadonlySet<string> = new Set(),
): void {
  const canonicalName = toPosix(relative(contentDir, event.path));
  const names =
    event.kind === 'file-delete'
      ? new Set([event.relativePath])
      : new Set([canonicalName, event.relativePath]);
  const recorded = new Set([...names, ...changedPaths]);
  const facts = generalFactsFor(index, recorded);
  for (const name of recorded) {
    record.generalNames.add(name);
    record.generalEffects.set(name, facts.get(name) ?? null);
  }
  if (event.kind === 'file-delete') return;
  const fact = facts.get(canonicalName) ?? facts.get(event.relativePath);
  if (fact?.kind !== 'regular' && fact?.kind !== 'symlink') return;
  record.generalMetadata.set(generalIdentityKey(fact.identity), {
    size: event.size,
    modified: new Date(event.modifiedTs).toISOString(),
    sequence: fact.sequence,
  });
}

function recordObservedExtension(
  observation: DiskObservation,
  docName: string,
  ext: string,
): boolean {
  observation.extensions.push({ docName, ext });
  const existing = observation.preferredExtensions.get(docName);
  const orderedExtensions: readonly string[] = SUPPORTED_DOC_EXTENSIONS;
  if (
    !existing ||
    orderedExtensions.indexOf(ext.toLowerCase()) < orderedExtensions.indexOf(existing.toLowerCase())
  ) {
    observation.preferredExtensions.set(docName, ext);
    return true;
  }
  return existing.toLowerCase() === ext.toLowerCase();
}

async function scanDisk(
  dir: string,
  contentDir: string,
  contentFilter: ContentFilter | undefined,
  observation: DiskObservation,
  generalScan: GeneralScanAccumulator,
  visitedInodes?: Set<number>,
  generalVisitedInodes?: Set<number>,
): Promise<void> {
  const visited = visitedInodes ?? new Set<number>();
  const generalVisited = generalVisitedInodes ?? new Set<number>();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      let lst: Stats;
      try {
        lst = await lstat(fullPath);
      } catch (e) {
        const code = errnoCode(e);
        if (code !== 'ENOENT') {
          observation.complete = false;
          log.warn({ path: fullPath, err: e }, `Failed to lstat ${fullPath}, skipping`);
        }
        continue;
      }

      if (lst.isSymbolicLink()) {
        let canonical: string;
        try {
          canonical = await realpath(fullPath);
        } catch (e) {
          const code = errnoCode(e);
          if (code === 'ENOENT' || code === 'ELOOP') {
            log.warn({ path: fullPath, code }, `Broken/cyclic symlink at ${fullPath}, skipping`);
          } else {
            observation.complete = false;
            log.warn({ path: fullPath, err: e }, `Failed to resolve symlink ${fullPath}`);
          }
          continue;
        }

        if (
          !isWithinContentDir(canonical, contentDir) ||
          resolvesIntoPrivateState(fullPath, canonical, contentDir)
        ) {
          log.warn(
            { path: fullPath, canonical },
            `Symlink escape: ${fullPath} → ${canonical}, skipping`,
          );
          continue;
        }

        try {
          const canonStat = await stat(canonical);
          if (canonStat.isFile() && !isSupportedDocFile(entry.name)) {
            const canonicalName = toPosix(relative(contentDir, canonical));
            const lexicalName = toPosix(relative(contentDir, fullPath));
            if (
              contentFilter?.isPathIgnored(canonicalName) ||
              contentFilter?.isPathIgnored(lexicalName) ||
              isSystemDoc(canonicalName) ||
              isConfigDoc(canonicalName) ||
              isSystemDoc(lexicalName) ||
              isConfigDoc(lexicalName)
            )
              continue;
            if (visited.has(canonStat.ino) && !generalVisited.has(canonStat.ino)) continue;
            visited.add(canonStat.ino);
            generalVisited.add(canonStat.ino);
            const registered = recordScannedGeneralPath(
              observation,
              generalScan,
              contentDir,
              canonicalName,
              lexicalName,
              true,
              { device: canonStat.dev, inode: canonStat.ino },
              { size: canonStat.size, modified: canonStat.mtime.toISOString() },
              contentFilter,
            );
            if (registered === 'unobserved') observation.complete = false;
            observation.paths.add(fullPath);
            continue;
          }
          if (visited.has(canonStat.ino)) {
            if (canonStat.isFile() && isSupportedDocFile(entry.name)) {
              const aliasDocName = pathToDocName(fullPath, contentDir);
              const canonicalDocName = pathToDocName(canonical, contentDir);
              observation.aliasMap.set(aliasDocName, canonicalDocName);
              observation.aliasPaths.set(aliasDocName, fullPath);
              observation.paths.add(fullPath);
              const existing = observation.fileIndex.get(canonicalDocName);
              if (existing && !existing.aliases.includes(aliasDocName)) {
                existing.aliases.push(aliasDocName);
              }
            } else if (canonStat.isDirectory()) {
              const relPath = contentRelativePath(contentDir, fullPath);
              if (!contentFilter || (relPath && !contentFilter.isDirExcluded(relPath))) {
                observation.folderAliasIndex.set(
                  toPosix(relative(contentDir, fullPath)),
                  toPosix(relative(contentDir, canonical)),
                );
                observation.paths.add(fullPath);
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
            observation.folderAliasIndex.set(
              toPosix(relative(contentDir, fullPath)),
              toPosix(relative(contentDir, canonical)),
            );
            observation.paths.add(fullPath);
            await scanDisk(
              canonical,
              contentDir,
              contentFilter,
              observation,
              generalScan,
              visited,
              generalVisited,
            );
          } else if (canonStat.isFile() && isSupportedDocFile(entry.name)) {
            if (contentFilter) {
              const relPath = toPosix(relative(contentDir, canonical));
              if (contentFilter.isExcluded(relPath)) continue;
            }
            const aliasDocName = pathToDocName(fullPath, contentDir);
            const canonicalDocName = pathToDocName(canonical, contentDir);
            observation.aliasMap.set(aliasDocName, canonicalDocName);
            observation.aliasPaths.set(aliasDocName, fullPath);
            observation.paths.add(fullPath);

            try {
              const content = await readFile(canonical, 'utf-8');
              const hash = contentHash(content);
              observation.hashes.set(canonical, hash);
              observation.paths.add(canonical);
              const ext = extractDocExtension(canonical);
              if (ext && !recordObservedExtension(observation, canonicalDocName, ext)) continue;
              observation.fileIndex.set(canonicalDocName, {
                size: canonStat.size,
                modified: canonStat.mtime.toISOString(),
                canonicalPath: canonical,
                inode: canonStat.ino,
                aliases: [aliasDocName],
                kind: 'markdown',
                ...derivePageMeta(content, canonicalDocName),
              });
            } catch (err) {
              const code = errnoCode(err);
              if (code !== 'ENOENT') {
                observation.complete = false;
                log.warn({ path: canonical, err }, `Failed to seed hash for ${canonical}`);
              }
            }
          }
        } catch (e) {
          const code = errnoCode(e);
          if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            observation.complete = false;
          }
          log.warn({ path: canonical, err: e }, `Failed to stat symlink target ${canonical}`);
        }
      } else if (lst.isDirectory()) {
        const relPath = contentRelativePath(contentDir, fullPath);
        if (contentFilter) {
          if (!relPath || contentFilter.isDirExcluded(relPath)) {
            const structural = relPath && structuralIgnoreOccurrence(relPath);
            if (structural) observation.structuralIgnoreDirs.add(structural);
            continue;
          }
        }
        upsertFolderIndexEntry(observation.folderIndex, contentDir, fullPath, lst);
        observation.paths.add(fullPath);
        await scanDisk(
          fullPath,
          contentDir,
          contentFilter,
          observation,
          generalScan,
          visited,
          generalVisited,
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
          observation.hashes.set(fullPath, contentHash(content));
          observation.paths.add(fullPath);

          const docName = pathToDocName(fullPath, contentDir);
          const ext = extractDocExtension(fullPath);
          if (ext && !recordObservedExtension(observation, docName, ext)) continue;
          observation.fileIndex.set(docName, {
            size: lst.size,
            modified: lst.mtime.toISOString(),
            canonicalPath: fullPath,
            inode: lst.ino,
            aliases: [],
            kind: 'markdown',
            ...derivePageMeta(content, docName),
          });
        } catch (err) {
          const code = errnoCode(err);
          if (code === 'EACCES') {
            observation.complete = false;
            log.warn(
              { path: fullPath, code },
              `Permission denied reading ${fullPath}, file excluded from index`,
            );
          } else if (code !== 'ENOENT') {
            observation.complete = false;
            log.warn({ path: fullPath, err }, `Failed to seed hash for ${fullPath}`);
          }
        }
      } else if (lst.isFile()) {
        if (contentFilter) {
          const relPath = toPosix(relative(contentDir, fullPath));
          if (contentFilter.isPathIgnored(relPath)) continue;
        }
        const relativePath = toPosix(relative(contentDir, fullPath));
        if (isSystemDoc(relativePath) || isConfigDoc(relativePath)) continue;
        if (visited.has(lst.ino) && !generalVisited.has(lst.ino)) continue;
        visited.add(lst.ino);
        generalVisited.add(lst.ino);
        const registered = recordScannedGeneralPath(
          observation,
          generalScan,
          contentDir,
          relativePath,
          relativePath,
          false,
          { device: lst.dev, inode: lst.ino },
          { size: lst.size, modified: lst.mtime.toISOString() },
          contentFilter,
        );
        if (registered === 'unobserved') observation.complete = false;
        observation.paths.add(fullPath);
      }
    }
  } catch (err) {
    const code = errnoCode(err);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      observation.complete = false;
      log.warn({ dir, err }, `Failed to read directory ${dir}`);
    }
  }
}

async function observeDisk(
  contentDir: string,
  contentFilter: ContentFilter | undefined,
): Promise<DiskObservation> {
  const observation: DiskObservation = {
    fileIndex: new Map(),
    generalFileIndex: new GeneralFileIndex(contentDir),
    folderIndex: new Map(),
    aliasMap: new Map(),
    aliasPaths: new Map(),
    folderAliasIndex: new Map(),
    hashes: new Map(),
    extensions: [],
    preferredExtensions: new Map(),
    structuralIgnoreDirs: new Set(),
    paths: new Set(),
    complete: true,
  };
  const generalScan: GeneralScanAccumulator = {
    facts: new Map(),
    metadataEffects: new Map(),
  };
  await scanDisk(contentDir, contentDir, contentFilter, observation, generalScan);
  materializeScanGeneralIndex(observation, contentDir, generalScan);
  for (const [name, entry] of new Map(observation.generalFileIndex)) {
    const state = knownGeneralState(entry);
    if (!state) continue;
    const members = state.entry.fileMembers;
    const first = members.regularPaths.toSorted()[0];
    if (name === first) continue;
    observation.generalFileIndex.delete(name);
    storeKnownGeneralGroup(
      observation.generalFileIndex,
      contentDir,
      null,
      state.identity,
      members.regularPaths,
      members.symlinks,
      entry,
      state.sequence,
    );
  }
  for (const [alias, canonical] of observation.aliasMap) {
    const entry = observation.fileIndex.get(canonical);
    if (entry && !entry.aliases.includes(alias)) entry.aliases.push(alias);
  }
  return observation;
}

type ObservedInventory = Pick<DiskObservation, 'fileIndex' | 'folderIndex' | 'folderAliasIndex'>;

function generalAliasIsAdmitted(
  alias: string,
  targetPath: string,
  contentFilter: ContentFilter | undefined,
): boolean {
  return !contentFilter?.isPathIgnored(alias) && !contentFilter?.isPathIgnored(targetPath);
}

function selectObservedInventory(
  observation: DiskObservation,
  contentDir: string,
  contentFilter: ContentFilter | undefined,
): ObservedInventory & { generalFacts: Map<string, GeneralPathFact> } {
  return {
    fileIndex: new Map(
      [...observation.fileIndex].filter(
        ([, entry]) =>
          !contentFilter?.isExcluded(toPosix(relative(contentDir, entry.canonicalPath))),
      ),
    ),
    generalFacts: new Map(
      [...generalPathFacts(observation.generalFileIndex)].filter(([, fact]) =>
        fact.kind === 'symlink'
          ? generalAliasIsAdmitted(fact.path, fact.targetPath, contentFilter)
          : !contentFilter?.isPathIgnored(fact.path),
      ),
    ),
    folderIndex: new Map(
      [...observation.folderIndex].filter(([path]) => !contentFilter?.isDirExcluded(path)),
    ),
    folderAliasIndex: new Map(
      [...observation.folderAliasIndex].filter(([alias]) => !contentFilter?.isDirExcluded(alias)),
    ),
  };
}

function publishDiskObservation(
  observation: DiskObservation,
  inventory: ObservedInventory,
  fileIndex: Map<string, FileIndexEntry>,
  generalFileIndex: GeneralFileIndex,
  folderIndex: Map<string, FolderIndexEntry>,
  aliasMap: Map<string, string>,
  folderAliasIndex: Map<string, string>,
  structuralIgnoreDirs?: Set<string>,
  publishGeneral = true,
): void {
  for (const { docName, ext } of observation.extensions) {
    const reg = registerDocExtension(docName, ext);
    if (reg.shadowed) {
      log.warn(
        { docName, effective: reg.effective, shadowed: reg.shadowed },
        `docName "${docName}" has both "${reg.effective}" and "${reg.shadowed}" on disk; "${reg.effective}" wins (industry convention). Rename or delete one to disambiguate.`,
      );
    }
  }
  for (const [path, hash] of observation.hashes) lastKnownHash.set(path, hash);
  for (const [docName, entry] of inventory.fileIndex) {
    if (getDocExtension(docName).toLowerCase() !== extname(entry.canonicalPath).toLowerCase()) {
      continue;
    }
    fileIndex.set(docName, entry);
  }
  if (publishGeneral) {
    for (const [name, entry] of observation.generalFileIndex) {
      generalFileIndex.set(name, entry);
    }
  }
  for (const [path, entry] of inventory.folderIndex) folderIndex.set(path, entry);
  for (const [alias, canonical] of observation.aliasMap) aliasMap.set(alias, canonical);
  for (const [alias, canonical] of inventory.folderAliasIndex) {
    folderAliasIndex.set(alias, canonical);
  }
  for (const path of observation.structuralIgnoreDirs) structuralIgnoreDirs?.add(path);
}

function updateGeneralFileIndex(
  event: FileDiskEvent,
  generalFileIndex: Map<string, FileIndexEntry>,
  contentDir: string,
  canonicalPath = event.path,
): void {
  if (isSystemDoc(event.relativePath) || isConfigDoc(event.relativePath)) return;
  if (event.kind === 'file-delete') {
    const direct = generalFileIndex.get(event.relativePath);
    if (direct?.kind === 'file') {
      generalFileIndex.delete(event.relativePath);
      return;
    }
    for (const [name, entry] of generalFileIndex) {
      if (entry.kind !== 'file' || !entry.aliases.includes(event.relativePath)) continue;
      generalFileIndex.set(name, {
        ...entry,
        aliases: entry.aliases.filter((alias) => alias !== event.relativePath),
      });
      return;
    }
    return;
  }

  const canonicalName = toPosix(relative(contentDir, canonicalPath));
  for (const [name, entry] of generalFileIndex) {
    if (name === canonicalName || entry.kind !== 'file') continue;
    if (!entry.aliases.includes(event.relativePath)) continue;
    generalFileIndex.set(name, {
      ...entry,
      aliases: entry.aliases.filter((alias) => alias !== event.relativePath),
    });
  }
  const prior = generalFileIndex.get(canonicalName);
  const aliases = new Set(prior?.kind === 'file' ? prior.aliases : []);
  if (event.relativePath !== canonicalName) aliases.add(event.relativePath);
  aliases.delete(canonicalName);
  generalFileIndex.set(canonicalName, {
    size: event.size,
    modified: new Date(event.modifiedTs).toISOString(),
    canonicalPath,
    inode: event.inode || (prior?.kind === 'file' ? prior.inode : 0),
    aliases: [...aliases],
    kind: 'file',
  });
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
        ...derivePageMeta(event.content, docName),
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
        canonicalPath: event.newPath,
        inode: existing?.inode ?? 0,
        aliases: existing?.aliases ?? [],
        kind: 'markdown',
        ...derivePageMeta(event.content, event.newDocName),
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
): { events: FolderDiskEvent[]; untrackedFiles: string[] } {
  const events: FolderDiskEvent[] = [];
  const untrackedFiles: string[] = [];

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
      const code = errnoCode(err);
      if (code !== 'ENOENT') {
        log.warn({ path: raw.path, code }, `folder lstat failed for ${raw.path} (${code})`);
      }
      continue;
    }

    let folderStat: ReturnType<typeof statSync> | null = null;
    let canonicalPath = raw.path;
    if (lst.isDirectory()) {
      folderStat = lst;
    } else if (lst.isSymbolicLink()) {
      try {
        canonicalPath = resolveNativePath(raw.path);
        if (!isWithinContentDir(canonicalPath, contentDir)) continue;
        const stat = statSync(canonicalPath);
        if (stat.isDirectory()) folderStat = stat;
      } catch (err) {
        const code = errnoCode(err);
        if (code !== 'ENOENT') {
          log.warn(
            { path: raw.path, code },
            `folder symlink resolve failed for ${raw.path} (${code})`,
          );
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
      scanForUntrackedSubfolders(
        canonicalPath,
        contentDir,
        contentFilter,
        folderIndex,
        events,
        untrackedFiles,
      );
    }
  }

  return { events, untrackedFiles };
}

function scanForUntrackedSubfolders(
  startPath: string,
  contentDir: string,
  contentFilter: ContentFilter | undefined,
  folderIndex: Map<string, FolderIndexEntry>,
  events: FolderDiskEvent[],
  untrackedFiles: string[],
): void {
  const queue: string[] = [startPath];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) continue;

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const code = errnoCode(err);
      if (code !== 'ENOENT') {
        log.warn({ dir, code }, `folder rescan readdir failed for ${dir} (${code})`);
      }
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile()) {
        untrackedFiles.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isDirectory()) continue;

      const fullPath = join(dir, entry.name);
      const relPath = contentRelativePath(contentDir, fullPath);
      if (!relPath) continue;
      if (contentFilter?.isDirExcluded(relPath)) continue;

      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(fullPath);
      } catch (err) {
        const code = errnoCode(err);
        if (code !== 'ENOENT') {
          log.warn(
            { path: fullPath, code },
            `folder rescan lstat failed for ${fullPath} (${code})`,
          );
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

async function handleRawEventsInternal(
  rawEvents: InternalRawFileEvent[],
  contentDir: string,
  contentFilter: ContentFilter | undefined,
  fileIndex: Map<string, FileIndexEntry>,
  folderIndex: Map<string, FolderIndexEntry>,
  onDiskEvent: (event: DiskEvent) => Promise<void>,
  aliasMap?: Map<string, string>,
  admitEvent?: (event: DiskEvent) => boolean,
  generalFileIndex?: GeneralFileIndex,
  aliasPaths?: Map<string, string>,
): Promise<void> {
  const declaredBeforeBatch: ReadonlySet<string> = new Set(removalTracker.keys());
  const safeEvents = rawEvents.filter((e) => {
    if (!eventEscapesContentDir(e.path, contentDir)) return true;
    recordWatcherDecision('drop-symlink-escape', e.type, e.path);
    log.warn({ path: e.path, type: e.type }, `Symlink escape: ${e.path}, dropping ${e.type} event`);
    return false;
  });

  const folderInputs = safeEvents.filter(
    (event) => !('entryKind' in event) || event.entryKind !== 'file',
  );
  let knownFilePaths: Set<string> | undefined;
  const fileInputs = safeEvents.filter((event) => {
    if (event.type !== 'delete') return true;
    if ('entryKind' in event) return event.entryKind === 'file';
    const relativePath = contentRelativePath(contentDir, event.path);
    if (relativePath === null || !folderIndex.has(relativePath)) return true;
    if (!knownFilePaths) {
      knownFilePaths = new Set([...fileIndex.values()].map((entry) => entry.canonicalPath));
      for (const name of generalMemberPaths(contentDir, generalFileIndex ?? fileIndex)) {
        knownFilePaths.add(join(contentDir, name));
      }
      for (const path of aliasPaths?.values() ?? []) knownFilePaths.add(path);
    }
    return (
      knownFilePaths.has(event.path) ||
      (aliasPaths === undefined &&
        isSupportedDocFile(event.path) &&
        aliasMap?.has(pathToDocName(event.path, contentDir)) === true)
    );
  });

  const { events: folderEvents, untrackedFiles } = updateFolderIndexFromRawEvents(
    folderInputs,
    contentDir,
    contentFilter,
    folderIndex,
  );

  let rescuedCreates: RawFileEvent[] = [];
  if (untrackedFiles.length > 0) {
    const batchPaths = new Set(safeEvents.map((e) => e.path));
    const knownCanonicalPaths = new Set<string>();
    for (const entry of fileIndex.values()) knownCanonicalPaths.add(entry.canonicalPath);
    for (const name of generalMemberPaths(contentDir, generalFileIndex ?? fileIndex)) {
      knownCanonicalPaths.add(join(contentDir, name));
    }
    rescuedCreates = untrackedFiles
      .filter(
        (path) =>
          !batchPaths.has(path) && !lastKnownHash.has(path) && !knownCanonicalPaths.has(path),
      )
      .filter((path) => {
        if (!eventEscapesContentDir(path, contentDir)) return true;
        recordWatcherDecision('drop-symlink-escape', 'create', path);
        return false;
      })
      .map((path) => ({ type: 'create' as const, path }));
    if (rescuedCreates.length > 0) {
      log.debug(
        {
          count: rescuedCreates.length,
          paths: rescuedCreates.map((e) => toPosix(relative(contentDir, e.path))),
        },
        '[file-watcher] re-injecting rescued file creates from new-folder rescan',
      );
    }
  }
  const batchPaths = new Set(safeEvents.map((event) => event.path));
  const collapsedDeletes: RawFileEvent[] = [];
  for (const folderEvent of folderEvents) {
    if (folderEvent.kind !== 'folder-delete') continue;
    const prefix = `${folderEvent.relativePath}/`;
    for (const [indexedPath, entry] of fileIndex) {
      if (!indexedPath.startsWith(prefix) || batchPaths.has(entry.canonicalPath)) continue;
      batchPaths.add(entry.canonicalPath);
      collapsedDeletes.push({ type: 'delete', path: entry.canonicalPath });
    }
    for (const name of generalMemberPaths(contentDir, generalFileIndex ?? fileIndex)) {
      if (!name.startsWith(prefix)) continue;
      const path = join(contentDir, name);
      if (batchPaths.has(path)) continue;
      batchPaths.add(path);
      collapsedDeletes.push({ type: 'delete', path });
    }
  }

  const fileEvents = fileInputs.concat(rescuedCreates, collapsedDeletes);
  const removedSameNameAliases = new Map<string, { name: string; targetName: string }>();
  for (const event of fileEvents) {
    if (event.type !== 'delete' || !isSupportedDocFile(event.path)) continue;
    const name = pathToDocName(event.path, contentDir);
    const owner = fileIndex.get(name);
    const targetName = aliasMap?.get(name);
    if (
      aliasPaths?.get(name) === event.path &&
      targetName !== undefined &&
      owner?.kind === 'markdown' &&
      owner.canonicalPath !== event.path &&
      !contentFilter?.isExcluded(toPosix(relative(contentDir, event.path)))
    ) {
      removedSameNameAliases.set(event.path, { name, targetName });
    }
  }
  for (const [path, { name, targetName }] of removedSameNameAliases) {
    if (admitEvent && !admitEvent({ kind: 'delete', path, docName: name })) continue;
    aliasMap?.delete(name);
    aliasPaths?.delete(name);
    const target = fileIndex.get(targetName);
    if (target) {
      fileIndex.set(targetName, {
        ...target,
        aliases: target.aliases.filter((alias) => alias !== name),
      });
    }
    removeLastKnownHash(path);
    isSelfRemoval(path);
  }

  const mdEvents = fileEvents.filter(
    (event) =>
      isSupportedDocFile(event.path) &&
      !(event.type === 'delete' && removedSameNameAliases.has(event.path)),
  );
  const assetEvents = fileEvents.filter((e) =>
    isSupportedAssetFile(e.path, LINKABLE_ASSET_EXTENSIONS),
  );
  const nonMdRawEvents = fileEvents.filter((e) => !isSupportedDocFile(e.path));
  if (
    mdEvents.length === 0 &&
    assetEvents.length === 0 &&
    folderEvents.length === 0 &&
    nonMdRawEvents.length === 0
  ) {
    return;
  }

  const canonicalAliasRecords = new Set<RawFileEvent>();
  const observations = new Map<string, OwnWriteObservation>();
  const admittedMarkdownPaths = new Set<string>();
  try {
    const diskEvents =
      mdEvents.length > 0
        ? await classifyEventsInternal(
            mdEvents,
            contentDir,
            observations,
            contentFilter,
            aliasMap,
            aliasPaths
              ? { fileIndex, aliasPaths, canonicalRecords: canonicalAliasRecords }
              : undefined,
          )
        : [];

    for (const event of diskEvents) {
      if (
        event.kind !== 'delete' &&
        event.kind !== 'rename' &&
        discardSupersededOwnWrite(event.path, event.content, observations)
      ) {
        recordSupersededOwnWriteSkip(event.kind, event.path);
        continue;
      }
      if (admitEvent && !admitEvent(event)) continue;
      if (event.kind === 'rename') {
        admittedMarkdownPaths.add(event.oldPath);
        admittedMarkdownPaths.add(event.newPath);
      } else {
        admittedMarkdownPaths.add(event.path);
      }
      let isSelf = false;
      let indexEvent = event;

      const previousIndexedFields =
        event.kind === 'update'
          ? (() => {
              const previous = fileIndex.get(event.docName);
              if (previous?.kind !== 'markdown') return undefined;
              return {
                title: previous.title,
                description: previous.description,
                type: previous.type,
              };
            })()
          : undefined;

      if (event.kind !== 'delete' && event.kind !== 'rename') {
        const hash = contentHash(event.content);
        const checkPath = observedPathKey(event.path);
        isSelf = isSelfWrite(checkPath, hash);
        voidRemoval(event.path, declaredBeforeBatch);
      } else if (event.kind === 'rename') {
        const hash = contentHash(event.content);
        const checkPath = observedPathKey(event.newPath);
        isSelf = isSelfWrite(checkPath, hash);
        indexEvent = { ...event, newPath: checkPath };
        voidRemoval(event.oldPath, declaredBeforeBatch);
        voidRemoval(event.newPath, declaredBeforeBatch);
      } else {
        isSelf = isSelfRemoval(event.path);
      }

      const dispatchedEvent =
        event.kind === 'update' && previousIndexedFields !== undefined
          ? { ...event, previousIndexedFields }
          : event;

      updateFileIndex(indexEvent, fileIndex);

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
        const selfKind = event.kind === 'delete' ? 'self-removal' : 'self-write';
        log.debug(
          {
            kind: event.kind,
            path: event.kind === 'rename' ? event.newPath : event.path,
            self: true,
          },
          `[file-watcher] Skipped ${selfKind}: ${event.kind}`,
        );
        _fileWatcherEventsCounter().add(1, { 'disk.kind': event.kind, self: true });
        recordWatcherDecision(
          `${selfKind}-skip`,
          event.kind,
          event.kind === 'rename' ? event.newPath : event.path,
        );
        continue;
      }

      log.debug(
        {
          kind: event.kind,
          path: event.kind === 'rename' ? event.newPath : event.path,
        },
        `[file-watcher] Dispatching: ${event.kind}`,
      );
      _fileWatcherEventsCounter().add(1, { 'disk.kind': event.kind, self: false });
      const rawPath = event.kind === 'rename' ? event.newPath : event.path;
      recordWatcherDecision('dispatched', event.kind, rawPath);
      await withSpan(
        'file_watcher.process_event',
        {
          attributes: {
            'disk.kind': event.kind,
            'disk.path': normalizeFsPath(rawPath),
            'disk.path.role': classifyFsPath(rawPath),
          },
        },
        async () => onDiskEvent(dispatchedEvent),
      );
    }
  } finally {
    releaseOwnWriteObservations(observations);
  }

  for (const event of folderEvents) {
    if (admitEvent && !admitEvent(event)) continue;
    log.debug({ kind: event.kind, path: event.path }, `[file-watcher] Dispatching: ${event.kind}`);
    _fileWatcherEventsCounter().add(1, { 'disk.kind': event.kind, self: false });
    recordWatcherDecision('dispatched', event.kind, event.path);
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
      if (contentFilter.isPathIgnored(relPath)) {
        recordWatcherDecision('drop-filter-excluded', raw.type, raw.path);
        continue;
      }
    }
    const relativePath = toPosix(relative(contentDir, raw.path));
    const event: DiskEvent =
      raw.type === 'delete'
        ? { kind: 'asset-delete', path: raw.path, relativePath }
        : { kind: 'asset-create', path: raw.path, relativePath };
    if (admitEvent && !admitEvent(event)) continue;
    recordWatcherDecision('dispatched', event.kind, raw.path);
    await onDiskEvent(event);
  }

  for (const raw of nonMdRawEvents) {
    const relativePath = toPosix(relative(contentDir, raw.path));
    if (contentFilter?.isPathIgnored(relativePath)) {
      recordWatcherDecision('drop-filter-excluded', raw.type, raw.path);
      continue;
    }
    if (isSystemDoc(relativePath) || isConfigDoc(relativePath)) {
      recordWatcherDecision('drop-reserved-doc', raw.type, raw.path);
      continue;
    }

    if (raw.type === 'delete') {
      const event: DiskEvent = { kind: 'file-delete', path: raw.path, relativePath };
      if (admitEvent && !admitEvent(event)) continue;
      if (generalFileIndex) removeKnownGeneralPath(generalFileIndex, contentDir, relativePath);
      else updateGeneralFileIndex(event, fileIndex, contentDir);
      recordWatcherDecision('dispatched', event.kind, raw.path);
      await onDiskEvent(event);
      continue;
    }

    let st: ReturnType<typeof lstatSync>;
    let leafSymlink = false;
    let canonicalPath: string;
    let canonicalContentDir: string;
    try {
      canonicalContentDir = resolveNativePath(contentDir);
      st = lstatSync(raw.path);
      leafSymlink = st.isSymbolicLink();
      canonicalPath = resolveNativePath(raw.path);
      if (leafSymlink) st = statSync(canonicalPath);
    } catch (e) {
      const code = errnoCode(e);
      recordWatcherDecision('drop-stat-failed', raw.type, raw.path);
      if (code !== 'ENOENT') {
        log.warn({ path: raw.path, code }, `file-event lstat failed for ${raw.path} (${code})`);
      }
      continue;
    }
    if (!st.isFile()) continue;
    if (!isWithinContentDir(canonicalPath, canonicalContentDir)) {
      recordWatcherDecision('drop-symlink-escape', raw.type, raw.path);
      log.warn({ path: raw.path, canonicalPath }, `Symlink escape: ${raw.path}, dropping event`);
      continue;
    }
    const canonicalName = toPosix(relative(canonicalContentDir, canonicalPath));
    if (contentFilter?.isPathIgnored(canonicalName)) {
      recordWatcherDecision('drop-filter-excluded', raw.type, raw.path);
      continue;
    }
    if (isSystemDoc(canonicalName) || isConfigDoc(canonicalName)) {
      recordWatcherDecision('drop-reserved-doc', raw.type, raw.path);
      continue;
    }

    const event: FileDiskEvent =
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
    if (admitEvent && !admitEvent(event)) continue;
    let formerOwner: [string, FileIndexEntry] | undefined;
    let formerTarget: string | null = null;
    if (generalFileIndex) {
      for (const name of generalOwnerNames(generalFileIndex, relativePath)) {
        const entry = generalFileIndex.get(name);
        if (entry?.kind !== 'file') continue;
        const relation = knownGeneralState(entry)?.entry.fileMembers.symlinks.find(
          (candidate) => candidate.path === relativePath,
        );
        if (!relation || relation.targetPath === canonicalName) continue;
        formerOwner = [name, entry];
        formerTarget = join(canonicalContentDir, relation.targetPath);
        break;
      }
    } else {
      for (const owner of fileIndex) {
        if (owner[1].kind !== 'file') continue;
        if (owner[0] !== canonicalName && owner[1].aliases.includes(relativePath)) {
          formerOwner = owner;
          formerTarget = owner[1].canonicalPath;
          break;
        }
      }
    }
    let confirmedAbsentFormerPath: string | undefined;
    if (formerOwner && formerTarget) {
      try {
        const formerPath = realpathSync(formerTarget);
        statSync(formerPath);
      } catch (err) {
        const code = errnoCode(err);
        if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') {
          recordWatcherDecision('drop-stat-failed', raw.type, raw.path);
          log.warn({ path: formerTarget, code, err }, 'file watcher former target read failed');
          continue;
        }
        if (generalFileIndex) {
          confirmedAbsentFormerPath = toPosix(relative(canonicalContentDir, formerTarget));
        } else {
          fileIndex.delete(formerOwner[0]);
        }
      }
    }
    if (generalFileIndex) {
      const registered = registerKnownGeneralPath(
        generalFileIndex,
        canonicalContentDir,
        canonicalName,
        relativePath,
        leafSymlink,
        { device: st.dev, inode: st.ino },
        { size: event.size, modified: new Date(event.modifiedTs).toISOString() },
        contentFilter,
        confirmedAbsentFormerPath,
      );
      if (registered.kind === 'unobserved') {
        recordWatcherDecision('drop-stat-failed', raw.type, raw.path);
        continue;
      }
    } else {
      updateGeneralFileIndex(event, fileIndex, canonicalContentDir, canonicalPath);
    }
    recordWatcherDecision('dispatched', event.kind, raw.path);
    await onDiskEvent(event);
  }
  if (aliasPaths) {
    for (const event of mdEvents) {
      if (!admittedMarkdownPaths.has(event.path) || canonicalAliasRecords.has(event)) continue;
      const name = pathToDocName(event.path, contentDir);
      if (event.type !== 'delete' && aliasMap?.has(name)) {
        aliasPaths.set(name, event.path);
      } else if (aliasPaths.get(name) === event.path) {
        aliasPaths.delete(name);
      }
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
  return handleRawEventsInternal(
    rawEvents,
    contentDir,
    contentFilter,
    fileIndex,
    folderIndex,
    onDiskEvent,
    aliasMap,
  );
}

let _fwEventsCounterCache: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
function _fileWatcherEventsCounter() {
  _fwEventsCounterCache ||= getMeter().createCounter('ok.file_watcher.events', {
    description: 'Number of file-watcher events classified by kind',
  });
  return _fwEventsCounterCache;
}

let _fwDropsCounterCache: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
function _fileWatcherDropsCounter() {
  _fwDropsCounterCache ||= getMeter().createCounter('ok.file_watcher.drops', {
    description: 'File-watcher events dropped before dispatch, by bounded reason',
  });
  return _fwDropsCounterCache;
}

const GLOB_METACHARACTER_RE = /[*?[\]{}()!+@|\\]/;

function structuralIgnoreOccurrence(relativePath: string): string | null {
  for (const dir of WATCHER_STRUCTURAL_IGNORE_DIRS) {
    if (relativePath === dir || relativePath.endsWith(`/${dir}`)) return relativePath;
  }
  return null;
}

type RecoveredAliasCandidate =
  | { kind: 'delete'; alias: string; targetPath: string }
  | {
      kind: 'target-update';
      alias: string;
      targetPath: string;
      targetIdentity: GeneralIdentity;
    };

async function recoverDiskChanges(
  contentDir: string,
  contentFilter: ContentFilter | undefined,
  fileIndex: Map<string, FileIndexEntry>,
  generalFileIndex: GeneralFileIndex,
  folderIndex: Map<string, FolderIndexEntry>,
  aliasMap: Map<string, string>,
  aliasPaths: Map<string, string>,
  folderAliasIndex: Map<string, string>,
  publicMutations: RecoveryPublicMutations,
  onDiskEvent: (event: DiskEvent) => Promise<void>,
  onAfterMutation: () => void,
  getFileIndexGeneration: () => number,
  onRawBatch?: (absPaths: readonly string[]) => void,
): Promise<boolean> {
  const knownPaths = new Set<string>();
  for (const entry of fileIndex.values()) knownPaths.add(entry.canonicalPath);
  for (const name of generalMemberPaths(contentDir, generalFileIndex)) {
    knownPaths.add(join(contentDir, name));
  }
  for (const relativePath of folderIndex.keys()) knownPaths.add(join(contentDir, relativePath));
  for (const path of aliasPaths.values()) knownPaths.add(path);
  for (const alias of folderAliasIndex.keys()) knownPaths.add(join(contentDir, alias));

  const previousFiles = new Map(fileIndex);
  const previousGeneralFiles = new Map(generalFileIndex);
  const previousFolders = new Map(folderIndex);
  const previousHashes = new Map(lastKnownHash);
  const previousAliases = new Map(aliasMap);
  const previousAliasPaths = new Map(aliasPaths);
  const previousFolderAliases = new Map(folderAliasIndex);

  contentFilter?.refreshInPlaceSkillDirs();
  const observed = await observeDisk(contentDir, contentFilter);
  if (!observed.complete) return false;

  const markdownPublicMutationFor = (name: string, entry: FileIndexEntry): boolean => {
    const names = publicMutations.markdownNames;
    if (names.has(name)) return true;
    const canonicalName = pathToDocName(entry.canonicalPath, contentDir);
    return names.has(canonicalName) || entry.aliases.some((alias) => names.has(alias));
  };
  const previousGeneralFacts = generalPathFacts(previousGeneralFiles);
  const observedGeneralFacts = generalPathFacts(observed.generalFileIndex);

  const rawEvents: RecoveredFileEvent[] = [];
  for (const [docName, previous] of previousFiles) {
    const current = observed.fileIndex.get(docName);
    if (
      markdownPublicMutationFor(docName, previous) ||
      (current && markdownPublicMutationFor(docName, current))
    )
      continue;
    if (current?.canonicalPath !== previous.canonicalPath) {
      rawEvents.push({ type: 'delete', path: previous.canonicalPath, entryKind: 'file' });
    } else if (
      previousHashes.get(previous.canonicalPath) !== observed.hashes.get(current.canonicalPath)
    ) {
      rawEvents.push({ type: 'update', path: current.canonicalPath });
    }
  }
  for (const [name, previous] of previousGeneralFacts) {
    if (previous.kind === 'symlink' || publicMutations.generalEffects.has(name)) continue;
    const current = observedGeneralFacts.get(name);
    if (current === undefined) {
      rawEvents.push({ type: 'delete', path: join(contentDir, name), entryKind: 'file' });
    } else if (
      current.kind === 'symlink' ||
      (current.kind === 'regular' &&
        (previous.kind === 'unresolved' ||
          !sameGeneralIdentity(previous.identity, current.identity) ||
          previous.metadata.size !== current.metadata.size ||
          previous.metadata.modified !== current.metadata.modified))
    ) {
      rawEvents.push({ type: 'update', path: join(contentDir, name) });
    }
  }
  for (const [docName, current] of observed.fileIndex) {
    const previous = previousFiles.get(docName);
    if (
      markdownPublicMutationFor(docName, current) ||
      (previous && markdownPublicMutationFor(docName, previous))
    )
      continue;
    if (current.canonicalPath !== previous?.canonicalPath) {
      rawEvents.push({ type: 'create', path: current.canonicalPath });
    }
  }
  for (const [name, current] of observedGeneralFacts) {
    if (current.kind !== 'regular' || publicMutations.generalEffects.has(name)) continue;
    const previous = previousGeneralFacts.get(name);
    if (previous === undefined) {
      rawEvents.push({ type: 'create', path: join(contentDir, name) });
    } else if (previous.kind === 'symlink') {
      rawEvents.push({ type: 'update', path: join(contentDir, name) });
    }
  }
  for (const [relativePath, previous] of folderIndex) {
    if (!observed.folderIndex.has(relativePath)) {
      rawEvents.push({ type: 'delete', path: join(contentDir, relativePath), entryKind: 'folder' });
    } else if (observed.folderIndex.get(relativePath)?.canonicalPath !== previous.canonicalPath) {
      rawEvents.push({ type: 'update', path: join(contentDir, relativePath) });
    }
  }
  for (const [relativePath, current] of observed.folderIndex) {
    if (!folderIndex.has(relativePath))
      rawEvents.push({ type: 'create', path: current.canonicalPath });
  }
  for (const [alias, path] of aliasPaths) {
    if (!observed.aliasPaths.has(alias))
      rawEvents.push({ type: 'delete', path, entryKind: 'file' });
  }

  const deduplicated = [
    ...new Map(
      rawEvents.map((event) => [
        event.type === 'delete'
          ? `${event.type}:${event.entryKind}:${event.path}`
          : `${event.type}:${event.path}`,
        event,
      ]),
    ).values(),
  ];
  if (deduplicated.length > 0) {
    const admitRecoveredEvent = (event: DiskEvent): boolean => {
      const markdownNames = publicMutations.markdownNames;
      const generalNames = publicMutations.generalNames;
      if (markdownNames.size === 0 && generalNames.size === 0) return true;
      if (event.kind === 'rename') {
        return !markdownNames.has(event.oldDocName) && !markdownNames.has(event.newDocName);
      }
      if (event.kind === 'folder-create' || event.kind === 'folder-delete') {
        return ![...markdownNames, ...generalNames].some(
          (name) => name === event.relativePath || name.startsWith(`${event.relativePath}/`),
        );
      }
      if (!('docName' in event)) {
        const pathName = toPosix(relative(contentDir, event.path));
        return (
          !publicMutations.generalEffects.has(event.relativePath) &&
          !publicMutations.generalEffects.has(pathName)
        );
      }
      if (markdownNames.has(event.docName)) return false;
      for (const [indexedName, entry] of fileIndex) {
        if (entry.canonicalPath === event.path && markdownPublicMutationFor(indexedName, entry))
          return false;
      }
      return true;
    };
    await handleRawEventsInternal(
      deduplicated,
      contentDir,
      contentFilter,
      fileIndex,
      folderIndex,
      onDiskEvent,
      aliasMap,
      admitRecoveredEvent,
      generalFileIndex,
      aliasPaths,
    );
  }

  for (const [path, prior] of previousHashes) {
    if (
      isWithinContentDir(path, contentDir) &&
      !publicMutations.markdownNames.has(pathToDocName(path, contentDir)) &&
      !observed.hashes.has(path) &&
      lastKnownHash.get(path) === prior
    ) {
      lastKnownHash.delete(path);
    }
  }
  for (const [path, hash] of observed.hashes) {
    if (publicMutations.markdownNames.has(pathToDocName(path, contentDir))) continue;
    const current = lastKnownHash.get(path);
    if (current === undefined || current === previousHashes.get(path))
      lastKnownHash.set(path, hash);
  }

  for (const [name, prior] of previousFiles) {
    const current = fileIndex.get(name);
    if (
      !markdownPublicMutationFor(name, prior) &&
      !observed.fileIndex.has(name) &&
      current === prior
    ) {
      fileIndex.delete(name);
      forgetDocExtension(name);
    }
  }
  const inventory = selectObservedInventory(observed, contentDir, contentFilter);
  for (const [name, entry] of observed.fileIndex) {
    if (markdownPublicMutationFor(name, entry)) continue;
    if (inventory.fileIndex.has(name)) fileIndex.set(name, entry);
    else if (fileIndex.get(name)?.canonicalPath === entry.canonicalPath) fileIndex.delete(name);
  }
  const selectedGeneralFacts = inventory.generalFacts;
  for (const [path, effect] of publicMutations.generalEffects) {
    if (effect) selectedGeneralFacts.set(path, effect);
    else selectedGeneralFacts.delete(path);
  }
  rebuildGeneralFileIndex(
    generalFileIndex,
    contentDir,
    selectedGeneralFacts,
    generalRepresentativeNames(previousGeneralFiles),
    publicMutations.generalMetadata,
  );

  for (const [path, prior] of previousFolders) {
    if (!observed.folderIndex.has(path) && folderIndex.get(path) === prior)
      folderIndex.delete(path);
  }
  for (const [path, entry] of inventory.folderIndex) {
    const current = folderIndex.get(path);
    if (
      current === undefined ||
      current === previousFolders.get(path) ||
      (current.canonicalPath === entry.canonicalPath &&
        current.modified === entry.modified &&
        current.inode === entry.inode)
    ) {
      folderIndex.set(path, entry);
    }
  }
  for (const [alias, prior] of previousAliases) {
    if (!observed.aliasMap.has(alias) && aliasMap.get(alias) === prior) aliasMap.delete(alias);
  }
  for (const [alias, canonical] of observed.aliasMap) {
    const current = aliasMap.get(alias);
    if (current === undefined || current === previousAliases.get(alias))
      aliasMap.set(alias, canonical);
  }
  for (const [alias, prior] of previousAliasPaths) {
    if (!observed.aliasPaths.has(alias) && aliasPaths.get(alias) === prior)
      aliasPaths.delete(alias);
  }
  for (const [alias, path] of observed.aliasPaths) {
    const current = aliasPaths.get(alias);
    if (current === undefined || current === previousAliasPaths.get(alias))
      aliasPaths.set(alias, path);
  }
  for (const [alias, prior] of previousFolderAliases) {
    if (!observed.folderAliasIndex.has(alias) && folderAliasIndex.get(alias) === prior) {
      folderAliasIndex.delete(alias);
    }
  }
  for (const [alias, canonical] of inventory.folderAliasIndex) {
    const current = folderAliasIndex.get(alias);
    if (current === undefined || current === previousFolderAliases.get(alias)) {
      folderAliasIndex.set(alias, canonical);
    }
  }
  const publicParentDirs = new Set<string>();
  for (const name of [...publicMutations.markdownNames, ...publicMutations.generalNames]) {
    let parent = dirname(name);
    while (parent !== '.' && parent !== '') {
      publicParentDirs.add(parent);
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  for (const relativePath of publicParentDirs) {
    const path = join(contentDir, relativePath);
    if (contentRelativePath(contentDir, path) !== relativePath) continue;
    if (contentFilter?.isDirExcluded(relativePath)) {
      removeFolderIndexEntries(folderIndex, relativePath);
      folderAliasIndex.delete(relativePath);
      continue;
    }
    let folderStat: ReturnType<typeof statSync>;
    let canonicalPath = path;
    try {
      const lst = lstatSync(path);
      if (lst.isSymbolicLink()) {
        canonicalPath = resolveNativePath(path);
        if (!isWithinContentDir(canonicalPath, contentDir)) {
          removeFolderIndexEntries(folderIndex, relativePath);
          folderAliasIndex.delete(relativePath);
          continue;
        }
        folderStat = statSync(canonicalPath);
      } else {
        folderStat = lst;
      }
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
        removeFolderIndexEntries(folderIndex, relativePath);
        folderAliasIndex.delete(relativePath);
      } else {
        log.warn({ path, err }, `Failed to refresh public mutation folder ${path}`);
      }
      continue;
    }
    if (!folderStat.isDirectory()) {
      removeFolderIndexEntries(folderIndex, relativePath);
      folderAliasIndex.delete(relativePath);
      continue;
    }
    upsertFolderIndexEntry(folderIndex, contentDir, path, folderStat, canonicalPath);
    if (canonicalPath === path) folderAliasIndex.delete(relativePath);
    else folderAliasIndex.set(relativePath, toPosix(relative(contentDir, canonicalPath)));
  }
  const aliasChanges: RecoveredAliasCandidate[] = [];
  const finalGeneralFacts = generalPathFacts(generalFileIndex);
  for (const [alias, previous] of previousGeneralFacts) {
    if (previous.kind !== 'symlink' || publicMutations.generalEffects.has(alias)) continue;
    if (finalGeneralFacts.has(alias)) continue;
    if (!generalAliasIsAdmitted(alias, previous.targetPath, contentFilter)) continue;
    aliasChanges.push({ kind: 'delete', alias, targetPath: previous.targetPath });
  }
  for (const [alias, current] of finalGeneralFacts) {
    if (current.kind !== 'symlink' || publicMutations.generalEffects.has(alias)) continue;
    if (!generalAliasIsAdmitted(alias, current.targetPath, contentFilter)) continue;
    const previous = previousGeneralFacts.get(alias);
    if (previous?.kind === 'symlink' && previous.targetPath === current.targetPath) continue;
    const target = finalGeneralFacts.get(current.targetPath);
    if (target?.kind !== 'regular') continue;
    aliasChanges.push({
      kind: 'target-update',
      alias,
      targetPath: current.targetPath,
      targetIdentity: target.identity,
    });
  }
  if (aliasChanges.length > 0) {
    onAfterMutation();
    let currentGeneration = getFileIndexGeneration();
    let currentGeneralFacts = generalPathFacts(generalFileIndex);
    for (const candidate of aliasChanges) {
      if (!generalAliasIsAdmitted(candidate.alias, candidate.targetPath, contentFilter)) continue;
      const generation = getFileIndexGeneration();
      if (generation !== currentGeneration) {
        currentGeneralFacts = generalPathFacts(generalFileIndex);
        currentGeneration = generation;
      }
      let event: FileDiskEvent;
      if (candidate.kind === 'delete') {
        if (
          publicMutations.generalEffects.has(candidate.alias) ||
          currentGeneralFacts.has(candidate.alias)
        )
          continue;
        event = {
          kind: 'file-delete',
          path: join(contentDir, candidate.alias),
          relativePath: candidate.alias,
        };
      } else {
        if (
          publicMutations.generalEffects.has(candidate.alias) ||
          publicMutations.generalEffects.has(candidate.targetPath)
        )
          continue;
        const alias = currentGeneralFacts.get(candidate.alias);
        const target = currentGeneralFacts.get(candidate.targetPath);
        if (
          alias?.kind !== 'symlink' ||
          alias.targetPath !== candidate.targetPath ||
          target?.kind !== 'regular' ||
          !sameGeneralIdentity(target.identity, candidate.targetIdentity)
        )
          continue;
        event = {
          kind: 'file-update',
          path: join(contentDir, candidate.targetPath),
          relativePath: candidate.targetPath,
          size: target.metadata.size,
          modifiedTs: Date.parse(target.metadata.modified),
          inode: target.identity.inode,
        };
      }
      recordWatcherDecision('dispatched', event.kind, event.path);
      await onDiskEvent(event);
    }
  }
  onRawBatch?.([...new Set([...observed.paths, ...knownPaths])]);
  return true;
}

export function toParcelIgnorePaths(
  watcherIgnoreGlobs: readonly string[],
  discoveredStructuralDirs: Iterable<string> = [],
): string[] {
  const prefixIgnorable = new Set<string>(WATCHER_STRUCTURAL_IGNORE_DIRS);
  const entries = new Set(watcherIgnoreGlobs.filter((entry) => prefixIgnorable.has(entry)));
  for (const dir of discoveredStructuralDirs) entries.add(dir);
  return [...entries].filter((entry) => !GLOB_METACHARACTER_RE.test(entry));
}

type RecoveryPublicMutations = GeneralMutationRecord & {
  markdownNames: Set<string>;
  hashEffects: Map<string, string | null>;
};

async function startParcelWatcher(
  contentDir: string,
  contentFilter: ContentFilter | undefined,
  fileIndex: Map<string, FileIndexEntry>,
  generalFileIndex: GeneralFileIndex,
  folderIndex: Map<string, FolderIndexEntry>,
  onDiskEvent: (event: DiskEvent) => Promise<void>,
  aliasMap: Map<string, string>,
  aliasPaths: Map<string, string>,
  folderAliasIndex: Map<string, string>,
  setActivePublicMutations: (mutations: RecoveryPublicMutations | null) => void,
  onAfterMutation: () => void,
  getFileIndexGeneration: () => number,
  platform: NodeJS.Platform,
  onRawBatch?: (absPaths: readonly string[]) => void,
  discoveredStructuralDirs?: ReadonlySet<string>,
  onRecoveryComplete?: () => Promise<void>,
): Promise<(AsyncSubscription & { runOrdered(work: () => Promise<void>): Promise<void> }) | null> {
  let parcel: typeof import('@parcel/watcher');
  try {
    parcel = await import('@parcel/watcher');
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      '[file-watcher] @parcel/watcher import failed; falling back to chokidar',
    );
    return null;
  }

  try {
    const subscribeOpts = contentFilter
      ? {
          ignore: toParcelIgnorePaths(
            contentFilter.getWatcherIgnoreGlobs(),
            discoveredStructuralDirs ?? [],
          ),
        }
      : undefined;

    let closed = false;
    let workTail = Promise.resolve();
    const runOrdered = (work: () => Promise<void>): Promise<void> => {
      if (closed) return Promise.resolve();
      const next = workTail.then(work);
      workTail = next.catch((err) => {
        log.error({ err }, 'parcel batch error');
      });
      return next;
    };
    let recoveryRunning = false;
    let nextRecovery: Promise<void> | undefined;
    let followUpRecovery: PromiseWithResolvers<void> | undefined;
    const recoverOnce = async (): Promise<void> => {
      nextRecovery = undefined;
      if (closed) return;
      recoveryRunning = true;
      const recoveryMutations: RecoveryPublicMutations = {
        markdownNames: new Set(),
        generalNames: new Set(),
        generalEffects: new Map(),
        generalMetadata: new Map(),
        hashEffects: new Map(),
      };
      try {
        setActivePublicMutations(recoveryMutations);
        const recovered = await recoverDiskChanges(
          contentDir,
          contentFilter,
          fileIndex,
          generalFileIndex,
          folderIndex,
          aliasMap,
          aliasPaths,
          folderAliasIndex,
          recoveryMutations,
          onDiskEvent,
          onAfterMutation,
          getFileIndexGeneration,
          onRawBatch,
        );
        onAfterMutation();
        if (recovered) {
          await onRecoveryComplete?.();
          log.info({ completed: true }, 'parcel watcher recovery finished');
        } else {
          log.warn(
            { completed: false },
            'parcel watcher recovery incomplete; known state retained',
          );
        }
      } catch (handleErr) {
        log.error({ err: handleErr }, 'parcel batch error');
      } finally {
        try {
          for (const [path, hash] of recoveryMutations.hashEffects) {
            if (hash === null) removeLastKnownHash(path);
            else updateLastKnownHash(path, hash);
          }
        } finally {
          setActivePublicMutations(null);
          recoveryRunning = false;
          const followUp = followUpRecovery;
          followUpRecovery = undefined;
          if (followUp) followUp.resolve(runOrdered(recoverOnce));
        }
      }
    };
    const requestRecovery = (): Promise<void> => {
      if (nextRecovery) return nextRecovery;
      if (recoveryRunning) {
        followUpRecovery = Promise.withResolvers<void>();
        nextRecovery = followUpRecovery.promise;
      } else {
        nextRecovery = runOrdered(recoverOnce);
      }
      return nextRecovery;
    };
    const subscription = await subscribeParcel(
      parcel,
      contentDir,
      (err, events) => {
        if (closed) return;
        const notification = classifyParcelNotification(err, events);
        if (notification.kind === 'error') {
          log.error({ err: notification.error }, 'parcel watcher callback error');
          return;
        }
        if (notification.kind === 'rescan') {
          log.warn(
            { err: notification.error, eventCount: notification.events.length },
            'parcel watcher recovery requested',
          );
        }
        const records = runOrdered(async () => {
          if (closed) return;
          try {
            onRawBatch?.(notification.events.map((event) => event.path));
            await handleRawEventsInternal(
              notification.events.map((event) => ({ type: event.type, path: event.path })),
              contentDir,
              contentFilter,
              fileIndex,
              folderIndex,
              onDiskEvent,
              aliasMap,
              undefined,
              generalFileIndex,
              aliasPaths,
            );
            onAfterMutation();
          } catch (handleErr) {
            log.error({ err: handleErr }, 'parcel batch error');
          }
        });
        if (notification.kind !== 'rescan') return records;
        return Promise.all([records, requestRecovery()]);
      },
      subscribeOpts,
      platform,
    );

    return {
      runOrdered,
      async unsubscribe() {
        closed = true;
        await subscription.unsubscribe();
        await workTail;
      },
    };
  } catch (err) {
    log.warn({ err }, '@parcel/watcher subscribe failed, falling back to chokidar');
    return null;
  }
}

export function isChokidarPathIgnored(
  contentDir: string,
  contentFilter: ContentFilter,
  filePath: string,
  stats?: Stats,
): boolean {
  const rel = toPosix(relative(contentDir, filePath));
  if (rel === '' || rel === '.') return false;
  let isDirectory: boolean;
  if (stats) {
    isDirectory = stats.isDirectory();
  } else {
    try {
      isDirectory = lstatSync(filePath).isDirectory();
    } catch {
      return false;
    }
  }
  if (isDirectory) {
    const m = /^(\.[A-Za-z0-9_-]+)(\/skills(\/[^/]+)?)?$/.exec(rel);
    if (m && m[1] !== '.ok') {
      if (m[2] !== undefined) return false;
      if (existsSync(join(contentDir, rel, 'skills'))) return false;
    }
    return contentFilter.isDirExcluded(rel);
  }
  return contentFilter.isExcluded(rel);
}

const CHOKIDAR_READY_TIMEOUT_MS = 10_000;

/* UPSTREAM(nodejs/node#52601, libuv/libuv#3866, libuv/libuv#637): a macOS directory fs.watch
   returns before FSEvents covers its path; closing one waits for the stream rebuild that covers
   every earlier registration. */
function waitForPendingFsEventsRegistrations(dir: string, platform: NodeJS.Platform): void {
  if (platform !== 'darwin') return;
  try {
    watchFsPath(dir).close();
  } catch (err) {
    log.warn(
      { err },
      'could not wait for FSEvents to cover the chokidar-watched directories; a change made right after start may be missed',
    );
  }
}

async function startChokidarWatcher(
  contentDir: string,
  contentFilter: ContentFilter | undefined,
  fileIndex: Map<string, FileIndexEntry>,
  generalFileIndex: GeneralFileIndex,
  folderIndex: Map<string, FolderIndexEntry>,
  onDiskEvent: (event: DiskEvent) => Promise<void>,
  aliasMap: Map<string, string>,
  aliasPaths: Map<string, string>,
  onAfterMutation: () => void,
  platform: NodeJS.Platform,
  onRawBatch?: (absPaths: readonly string[]) => void,
): Promise<AsyncSubscription> {
  const { watch } = await import('chokidar');

  const watcher = watch(contentDir, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: contentFilter
      ? (filePath: string, stats?: Stats) =>
          isChokidarPathIgnored(contentDir, contentFilter, filePath, stats)
      : undefined,
  });

  watcher.on('error', (err) => log.error({ err }, 'chokidar error'));

  const BATCH_WINDOW_MS = 50;
  let pendingEvents: InternalRawFileEvent[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;

  function queueEvent(event: InternalRawFileEvent) {
    pendingEvents.push(event);
    batchTimer ||= setTimeout(() => {
      const batch = pendingEvents;
      pendingEvents = [];
      batchTimer = null;
      onRawBatch?.(batch.map((e) => e.path));
      handleRawEventsInternal(
        batch,
        contentDir,
        contentFilter,
        fileIndex,
        folderIndex,
        onDiskEvent,
        aliasMap,
        undefined,
        generalFileIndex,
        aliasPaths,
      )
        .then(onAfterMutation)
        .catch((err) => log.error({ err }, 'chokidar batch error'));
    }, BATCH_WINDOW_MS);
  }

  watcher.on('add', (path) => queueEvent({ type: 'create', path }));
  watcher.on('change', (path) => queueEvent({ type: 'update', path }));
  watcher.on('unlink', (path) => queueEvent({ type: 'delete', path, entryKind: 'file' }));
  watcher.on('addDir', (path) => queueEvent({ type: 'create', path }));
  watcher.on('unlinkDir', (path) => queueEvent({ type: 'delete', path, entryKind: 'folder' }));

  await new Promise<void>((resolveReady) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolveReady();
    };
    watcher.once('ready', settle);
    setTimeout(settle, CHOKIDAR_READY_TIMEOUT_MS).unref();
  });

  waitForPendingFsEventsRegistrations(contentDir, platform);

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
  opts: {
    forceBackend?: 'parcel' | 'chokidar';
    onRawBatch?: (absPaths: readonly string[]) => void;
    onRecoveryComplete?: () => Promise<void>;
    platform?: NodeJS.Platform;
  } = {},
): Promise<WatcherHandle> {
  const { onRawBatch, onRecoveryComplete } = opts;
  const contentDir = resolveDirectoryRoot(contentDirRaw, {
    root: 'content',
    component: 'file-watcher',
  });

  const fileIndex = new Map<string, FileIndexEntry>();
  const generalFileIndex = new GeneralFileIndex(contentDir);
  const allFileEntries: AllFileEntries = {
    *[Symbol.iterator]() {
      yield* fileIndex;
      yield* generalFileIndex;
    },
  };
  const folderIndex = new WatcherFolderIndex(contentDir);
  const aliasMap = new Map<string, string>();
  const aliasPaths = new Map<string, string>();
  const folderAliasIndex = new Map<string, string>();
  let activePublicMutations: RecoveryPublicMutations | null = null;
  let activeReseedMutations: GeneralMutationRecord | null = null;

  let fileIndexGeneration = 0;
  let cachedMarkdownView: ReadonlyMap<string, FileIndexEntry> | null = null;
  let cachedMarkdownViewGeneration = -1;
  const bumpFileIndexGeneration = (): void => {
    fileIndexGeneration++;
  };

  const structuralIgnoreDirs = new Set<string>();

  const initialObservation = await observeDisk(contentDir, contentFilter);
  publishDiskObservation(
    initialObservation,
    initialObservation,
    fileIndex,
    generalFileIndex,
    folderIndex,
    aliasMap,
    folderAliasIndex,
    structuralIgnoreDirs,
  );
  for (const [alias, path] of initialObservation.aliasPaths) aliasPaths.set(alias, path);
  bumpFileIndexGeneration();

  const evictionInterval = setInterval(evictStaleTrackerEntries, WRITE_TRACKER_TTL_MS);
  const dropSummaryInterval = setInterval(logWatcherDropSummary, WATCHER_DROP_SUMMARY_INTERVAL_MS);

  let subscription: AsyncSubscription;
  let runOrderedRescan: ((work: () => Promise<void>) => Promise<void>) | undefined;
  let backend: WatcherBackend;
  const forceChokidar = process.env.OK_FILE_WATCHER_BACKEND === 'chokidar';
  const platform = opts.platform ?? process.platform;
  try {
    const parcelSub =
      forceChokidar || opts.forceBackend === 'chokidar'
        ? null
        : await startParcelWatcher(
            contentDir,
            contentFilter,
            fileIndex,
            generalFileIndex,
            folderIndex,
            onDiskEvent,
            aliasMap,
            aliasPaths,
            folderAliasIndex,
            (mutations) => {
              activePublicMutations = mutations;
            },
            bumpFileIndexGeneration,
            () => fileIndexGeneration,
            platform,
            onRawBatch,
            structuralIgnoreDirs,
            onRecoveryComplete,
          );
    if (parcelSub) {
      subscription = parcelSub;
      runOrderedRescan = parcelSub.runOrdered;
      backend = 'parcel';
    } else {
      if (opts.forceBackend === 'parcel') {
        throw new Error('@parcel/watcher unavailable (forced backend)');
      }
      subscription = await startChokidarWatcher(
        contentDir,
        contentFilter,
        fileIndex,
        generalFileIndex,
        folderIndex,
        onDiskEvent,
        aliasMap,
        aliasPaths,
        bumpFileIndexGeneration,
        platform,
        onRawBatch,
      );
      backend = 'chokidar';
    }
  } catch (e) {
    clearInterval(evictionInterval);
    clearInterval(dropSummaryInterval);
    throw e;
  }

  const originalUnsubscribe = subscription.unsubscribe.bind(subscription);

  log.info({ contentDir, backend }, 'watching for external .md changes');

  return {
    async unsubscribe() {
      clearInterval(evictionInterval);
      clearInterval(dropSummaryInterval);
      await originalUnsubscribe();
      writeTracker.clear();
      removalTracker.clear();
      lastKnownHash.clear();
      resetWatcherDecisionDiagnostics();
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
      return allFileEntries;
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
    getStructuralIgnoreDirs() {
      return structuralIgnoreDirs;
    },
    mutateFileIndex(reportedEvent) {
      const event = declaredDiskEvent(reportedEvent);
      if (event.kind === 'rename') {
        activePublicMutations?.markdownNames.add(event.oldDocName);
        activePublicMutations?.markdownNames.add(event.newDocName);
      } else if ('docName' in event) {
        activePublicMutations?.markdownNames.add(event.docName);
      }
      if (
        event.kind === 'file-create' ||
        event.kind === 'file-update' ||
        event.kind === 'file-delete'
      ) {
        let changedPaths: ReadonlySet<string> = new Set();
        if (event.kind === 'file-delete') {
          const before = generalFactsFor(generalFileIndex, [event.relativePath]);
          removeKnownGeneralPath(generalFileIndex, contentDir, event.relativePath);
          const after = generalFactsFor(generalFileIndex, before.keys());
          changedPaths = new Set([...before.keys()].filter((path) => !after.has(path)));
        } else {
          try {
            const lexicalPath = join(contentDir, event.relativePath);
            const lexicalStat = lstatSync(lexicalPath);
            const leafSymlink = lexicalStat.isSymbolicLink();
            const canonicalPath = resolveNativePath(lexicalPath);
            if (!isWithinContentDir(canonicalPath, contentDir)) {
              throw new Error('General file path resolves outside content directory');
            }
            const physicalStat = leafSymlink ? statSync(canonicalPath) : lexicalStat;
            const registered = registerKnownGeneralPath(
              generalFileIndex,
              contentDir,
              toPosix(relative(contentDir, canonicalPath)),
              event.relativePath,
              leafSymlink,
              { device: physicalStat.dev, inode: physicalStat.ino },
              { size: event.size, modified: new Date(event.modifiedTs).toISOString() },
              contentFilter,
            );
            if (registered.kind === 'unobserved') return;
            changedPaths = registered.changedPaths;
          } catch (err) {
            log.warn({ path: event.path, err }, 'general file identity observation failed');
            const canonicalName = toPosix(relative(contentDir, event.path));
            let retained = false;
            const candidates = new Set([
              ...generalOwnerNames(generalFileIndex, canonicalName),
              ...generalOwnerNames(generalFileIndex, event.relativePath),
            ]);
            for (const name of candidates) {
              const entry = generalFileIndex.get(name);
              const state = entry && knownGeneralState(entry);
              if (!state) continue;
              const members = state.entry.fileMembers;
              if (
                !members.regularPaths.includes(canonicalName) &&
                !members.symlinks.some((relation) => relation.path === event.relativePath)
              )
                continue;
              storeKnownGeneralGroup(
                generalFileIndex,
                contentDir,
                name,
                state.identity,
                members.regularPaths,
                members.symlinks,
                { size: event.size, modified: new Date(event.modifiedTs).toISOString() },
              );
              retained = true;
              break;
            }
            if (!retained) storeUnresolvedGeneralEntry(generalFileIndex, contentDir, event);
          }
        }
        if (activePublicMutations) {
          recordGeneralPublicEffect(
            activePublicMutations,
            generalFileIndex,
            contentDir,
            event,
            changedPaths,
          );
        }
        if (activeReseedMutations) {
          recordGeneralPublicEffect(
            activeReseedMutations,
            generalFileIndex,
            contentDir,
            event,
            changedPaths,
          );
        }
      } else {
        updateFileIndex(event, fileIndex);
      }
      const hashEffects = activePublicMutations?.hashEffects;
      if (hashEffects) {
        switch (event.kind) {
          case 'create':
          case 'update':
          case 'conflict':
            if (!isReservedForUserTree(event.docName)) {
              hashEffects.set(event.path, contentHash(event.content));
            }
            break;
          case 'delete':
            if (!isReservedForUserTree(event.docName)) hashEffects.set(event.path, null);
            break;
          case 'rename':
            if (!isReservedForUserTree(event.newDocName)) {
              hashEffects.set(event.oldPath, null);
              hashEffects.set(event.newPath, contentHash(event.content));
            }
            break;
          case 'asset-create':
          case 'asset-delete':
          case 'folder-create':
          case 'folder-delete':
          case 'file-create':
          case 'file-update':
          case 'file-delete':
            break;
          default:
            assertNeverDiskEvent(event);
        }
      }
      bumpFileIndexGeneration();
    },
    pruneFileIndexNowExcluded() {
      if (!contentFilter) return 0;
      let pruned = 0;
      let changed = false;
      const removedGeneralPaths = new Set<string>();
      for (const [docName, entry] of fileIndex) {
        const relPath = toPosix(relative(contentDir, entry.canonicalPath));
        if (contentFilter.isExcluded(relPath)) {
          fileIndex.delete(docName);
          pruned++;
        }
      }
      for (const [name, entry] of generalFileIndex) {
        const state = knownGeneralState(entry);
        if (!state) {
          const relPath = toPosix(relative(contentDir, entry.canonicalPath));
          if (contentFilter.isPathIgnored(relPath)) {
            generalFileIndex.delete(name);
            removedGeneralPaths.add(name);
            pruned++;
          }
          continue;
        }
        const members = state.entry.fileMembers;
        const regular = members.regularPaths.filter((path) => !contentFilter.isPathIgnored(path));
        const symlinks = members.symlinks.filter(
          (relation) =>
            !contentFilter.isPathIgnored(relation.path) &&
            !contentFilter.isPathIgnored(relation.targetPath) &&
            regular.includes(relation.targetPath),
        );
        if (
          regular.length === members.regularPaths.length &&
          symlinks.length === members.symlinks.length
        )
          continue;
        const retained = new Set([...regular, ...symlinks.map((relation) => relation.path)]);
        for (const path of members.regularPaths) {
          if (!retained.has(path)) removedGeneralPaths.add(path);
        }
        for (const relation of members.symlinks) {
          if (!retained.has(relation.path)) removedGeneralPaths.add(relation.path);
        }
        if (regular.length === 0) pruned++;
        storeKnownGeneralGroup(
          generalFileIndex,
          contentDir,
          name,
          state.identity,
          regular,
          symlinks,
          entry,
          state.sequence,
        );
        changed = true;
      }
      for (const record of [activePublicMutations, activeReseedMutations]) {
        if (!record) continue;
        for (const path of removedGeneralPaths) {
          if (record.generalEffects.get(path)) record.generalEffects.set(path, null);
        }
      }
      if (changed || pruned > 0) bumpFileIndexGeneration();
      return pruned;
    },
    pruneFolderIndexNowExcluded() {
      if (!contentFilter) return 0;
      let pruned = 0;
      let aliasesChanged = false;
      for (const folderPath of folderIndex.keys()) {
        if (contentFilter.isDirExcluded(folderPath)) {
          folderIndex.delete(folderPath);
          pruned++;
        }
      }
      for (const alias of folderAliasIndex.keys()) {
        if (contentFilter.isDirExcluded(alias)) {
          folderAliasIndex.delete(alias);
          aliasesChanged = true;
        }
      }
      if (pruned > 0 || aliasesChanged) bumpFileIndexGeneration();
      return pruned;
    },
    async rescanFromDisk() {
      const reseed = async () => {
        const mutations: GeneralMutationRecord = {
          generalNames: new Set(),
          generalEffects: new Map(),
          generalMetadata: new Map(),
        };
        activeReseedMutations = mutations;
        try {
          const observation = await observeDisk(contentDir, contentFilter);
          const inventory = selectObservedInventory(observation, contentDir, contentFilter);
          publishDiskObservation(
            observation,
            inventory,
            fileIndex,
            generalFileIndex,
            folderIndex,
            aliasMap,
            folderAliasIndex,
            undefined,
            false,
          );
          const previous = new Map(generalFileIndex);
          const facts = generalPathFacts(generalFileIndex);
          for (const [path, fact] of inventory.generalFacts) {
            if (!mutations.generalEffects.has(path)) facts.set(path, fact);
          }
          for (const [path, effect] of mutations.generalEffects) {
            if (effect) facts.set(path, effect);
            else facts.delete(path);
          }
          rebuildGeneralFileIndex(
            generalFileIndex,
            contentDir,
            facts,
            generalRepresentativeNames(previous),
            mutations.generalMetadata,
          );
          for (const [alias, path] of observation.aliasPaths) aliasPaths.set(alias, path);
          bumpFileIndexGeneration();
        } finally {
          activeReseedMutations = null;
        }
      };
      if (runOrderedRescan) return runOrderedRescan(reseed);
      return reseed();
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
