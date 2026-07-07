/**
 * Disk bridge — watches content directory for external .md file changes.
 *
 * External editor saves (VS Code, Cursor, vim) are detected via @parcel/watcher
 * and emitted as typed DiskEvent unions. Self-write detection prevents
 * feedback loops.
 *
 * Two-layer feedback prevention:
 *   Layer 1 (content hash): writeTracker records hashes of our own persistence writes.
 *     Watcher skips events matching a tracked hash (self-write detection).
 *   Layer 2 (skipStoreHooks): External changes are applied with Hocuspocus v4
 *     LocalTransactionOrigin { skipStoreHooks: true }, preventing persistence
 *     from re-writing the file we just loaded.
 */

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
import { extractPageIcon, extractPageTitle } from './page-identity.ts';
import { toPosix } from './path-utils.ts';
import { isWithinContentDir } from './persistence.ts';
import { containsConflictMarkers } from './reconciliation.ts';
import { getMeter, withSpan } from './telemetry.ts';

/** Subscription handle compatible with both @parcel/watcher and chokidar backends. */
export interface AsyncSubscription {
  unsubscribe(): Promise<void>;
}

type WatcherBackend = 'parcel' | 'chokidar';

// ─── DiskEvent taxonomy ──────────────────────────────────────────────────────

// Subset of DiskEvent that classifyEvents emits — markdown-only.
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

// Asset events carry contentDir-relative paths instead of docNames —
// assets aren't documents in the CRDT layer. No content payload (binary)
// and no rename detection — Finder renames surface as delete+create
// pair, and the basename index is idempotent under add/remove so the
// end state matches. Rename-via-inode-pairing is scoped out to keep
// hot-path binary handling simple (would require hashing to correlate
// delete+create pairs).
type AssetDiskEvent =
  | { kind: 'asset-create'; path: string; relativePath: string }
  | { kind: 'asset-delete'; path: string; relativePath: string };

type FolderDiskEvent =
  | { kind: 'folder-create'; path: string; relativePath: string }
  | { kind: 'folder-delete'; path: string; relativePath: string };

// File events cover ANY ContentFilter-passing non-markdown file (every
// extension, not just LINKABLE_ASSET_EXTENSIONS). Metadata-only — no content
// read, no contentHash. Sibling to AssetDiskEvent: asset events maintain the
// basenameIndex (render concern); file events maintain the in-memory file
// index with `kind:'file'` entries so search / listings / `/api/documents` can
// admit all-files without breaking the ~16 markdown-assuming `getFileIndex()`
// consumers (the inversion happens at the accessor seam, not here).
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

/**
 * Exhaustiveness guard for DiskEvent dispatch sites. Every consumer that
 * pattern-matches on `event.kind` should terminate with
 * `assertNeverDiskEvent(event)` so a new variant produces a TypeScript
 * error at every consumer until they explicitly handle it. The new
 * variant is discovered at compile time, not by silent drop-on-floor at
 * runtime.
 */
export function assertNeverDiskEvent(event: never): never {
  throw new Error(`[DiskEvent] unhandled variant: ${JSON.stringify(event)}`);
}

// ─── File index ─────────────────────────────────────────────────────────────

export interface FileIndexEntry {
  size: number;
  modified: string;
  canonicalPath: string;
  inode: number;
  aliases: string[];
  /**
   * Discriminator distinguishing markdown documents from name-only files.
   *   - `'markdown'` = `.md` / `.mdx` (full CRDT semantics; docName / persistence /
   *      backlink / wikilink-resolution all assume this — never widen).
   *   - `'file'`     = any other ContentFilter-passing file (name / path / folder-only,
   *      no body content read). Search and `/api/documents` admit these via the
   *      explicit `getAllFilesIndex()` opt-in; `getFileIndex()` filters them out
   *      so the ~16 markdown-assuming consumers stay safe.
   */
  kind: 'markdown' | 'file';
  /**
   * Cached page title + icon for `kind:'markdown'` entries, derived from the
   * file content already read for the content hash during the seed walk and
   * live disk events — so `GET /api/pages` serves them from memory instead of
   * re-reading + re-parsing every file per request. No extra disk reads: the
   * `kind:'file'` branches stay read-free (seed readFile-count invariant).
   * `undefined` for `kind:'file'` and for any entry built without enrichment
   * (e.g. a bare test index); `handlePages` falls back to a one-off disk read
   * when `title` is absent, so the field's presence is the "enriched" signal.
   */
  title?: string;
  icon?: string;
}

export interface FolderIndexEntry {
  size: 0;
  modified: string;
  canonicalPath: string;
  inode: number;
}

/**
 * Derive the cached page title + icon from markdown content already in hand
 * (the seed-walk hash read or a live disk event's `content`). Centralizes the
 * "enrich a markdown FileIndexEntry" step so the four index-write sites stay in
 * sync. See `FileIndexEntry.title`.
 */
function derivePageMeta(
  content: string,
  docName: string,
): { title: string; icon: string | undefined } {
  return { title: extractPageTitle(content, docName), icon: extractPageIcon(content) };
}

/**
 * `ReadonlyMap` view over the full file index that hides `kind:'file'`
 * entries — the on-the-wire shape `getFileIndex()` returns to existing
 * consumers (markdown-only by default).
 *
 * Memoized inside `startWatcher` behind a generation counter that bumps on
 * every `fileIndex` mutation (seed walk, live disk events, prune,
 * `mutateFileIndex`). Repeated `getFileIndex()` calls between mutations
 * return the same cached snapshot; rebuild cost is paid once per mutation
 * batch rather than per call (13+ call sites including the per-write
 * `findHubCandidates` hot path).
 */
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
  /** Stop watching (unsubscribe from @parcel/watcher). */
  unsubscribe: () => Promise<void>;
  /**
   * Read the current file index — markdown-only by default.
   *
   * Returns ONLY `kind:'markdown'` entries so the ~16 markdown-assuming consumers
   * (`safeContentPath` / CRDT persistence, `getOrphans`, `findHubCandidates`,
   * `suggestLinks`, asset-rename rewrite, backlink-parse, the inline embeddable-
   * pages predicate, …) keep observing exactly the entries they expect. A
   * `kind:'file'` entry leaking to `safeContentPath` is the 1-way-door risk that
   * motivated the invert-default — non-markdown CRDT persistence would corrupt
   * the file. Call `getAllFilesIndex()` instead when you genuinely want both.
   */
  getFileIndex: () => ReadonlyMap<string, FileIndexEntry>;
  /**
   * Read the current file index — ALL files, both `kind:'markdown'` and
   * `kind:'file'` (the explicit opt-in to non-markdown admission).
   *
   * Allowlisted opt-in sites (3): the workspace-search corpus build, the
   * `/api/documents` payload, and `workspaceSearchFingerprint` (the corpus
   * cache key — admission predicate must match the build). Folder synthesis
   * runs inside the corpus build, not via a separate accessor call. A
   * `getFileIndex()`-caller meta-test fails CI when a new caller neither
   * filters on `kind` nor is on the explicit allowlist.
   */
  getAllFilesIndex: () => ReadonlyMap<string, FileIndexEntry>;
  /**
   * Monotonic counter bumped at every file-index mutation (seed, prune,
   * rescan, live disk events, and `mutateFileIndex`) — the same generation
   * that memoizes the markdown-only `getFileIndex()` view. Lets the workspace
   * search corpus invalidate its cache in O(1) (compare the counter) instead
   * of re-serializing the whole all-files index on every search request.
   */
  getFileIndexGeneration: () => number;
  /** Read the current folder index — filtered snapshot of known content folders. */
  getFolderIndex: () => ReadonlyMap<string, FolderIndexEntry>;
  /** Map from alias docName → canonical docName (only symlink entries). */
  getAliasMap: () => ReadonlyMap<string, string>;
  /** Map from alias folder docName → canonical folder docName (directory symlinks). */
  getFolderAliasIndex: () => ReadonlyMap<string, string>;
  /**
   * Apply a `DiskEvent` to the live file index synchronously. The typed
   * mutator API for handlers that need to keep `/api/documents` consistent
   * across the post-write window before the file-watcher's own delete /
   * create event lands (delete, trash-cleanup, rename, create-page,
   * duplicate-path). Bumps the index generation so the next `getFileIndex()`
   * call rebuilds the markdown-only view.
   *
   * Replaces the pre-PR pattern of `getFileIndex()` + `as Map<...>` cast +
   * `updateFileIndex(event, fileIndex)`; that pattern silently broke when
   * `getFileIndex()` flipped to returning a snapshot (mutation landed on the
   * throwaway copy, not the live map).
   */
  mutateFileIndex: (event: DiskEvent) => void;
  /**
   * Walk the in-memory file index and delete entries whose canonical path is
   * now excluded by the current ContentFilter. Required after a ContentFilter
   * rebuild because the index is seeded once at boot and is otherwise only
   * mutated by disk events — without this, files that were allowed at boot
   * remain visible to `/api/documents` and other consumers even after a
   * matching `.okignore` pattern is added.
   *
   * Returns the number of entries pruned. No-op when no ContentFilter is set.
   */
  pruneFileIndexNowExcluded: () => number;
  /**
   * Walk the in-memory folder index and delete entries whose directory path is
   * now excluded by the current ContentFilter. Required after a ContentFilter
   * rebuild for the same reason as `pruneFileIndexNowExcluded`: ignore-file
   * edits do not emit per-folder delete events for paths that became hidden.
   *
   * Returns the number of entries pruned. No-op when no ContentFilter is set.
   */
  pruneFolderIndexNowExcluded: () => number;
  /**
   * Re-seed the in-memory file/folder/alias indexes from disk. Two
   * production callers:
   *   1. The @parcel/watcher + inotify race rescue exposed via
   *      `POST /api/test-rescan-files` (Linux CI under CPU contention can
   *      drop `create` events for files written into freshly-created
   *      subdirectories — the recursive subwatch is registered asynchronously
   *      after the IN_CREATE for the directory, so rapid follow-up file writes
   *      race the registration).
   *   2. The post-rebuild reconcile composed by
   *      `reconcileFileIndexAfterFilterRebuild` — `.okignore` / `.gitignore`
   *      edits do not emit per-entry FSEvents for paths whose included-ness
   *      flipped, so the additive walk is the only thing that picks up
   *      newly-included entries.
   *
   * Re-invokes the same `seedLastKnownHashes` walk used at startup. The walk
   * is purely additive via `Map.set` — entries already in the index keep their
   * inode/aliases/hash; missing entries get inserted. No in-flight write
   * tracker entry is dropped (Cf. `BacklinkIndex.rebuildFromDisk()`, which is
   * also additive and serves the parallel rescue at `/api/test-rescan-backlinks`).
   */
  rescanFromDisk: () => Promise<void>;
}

// ─── Write tracker ───────────────────────────────────────────────────────────

// Content-hash tracker — persistence layer registers writes via registerWrite().
// Watcher checks this to skip self-writes. TTL cleanup prevents unbounded growth.
// Stores a QUEUE of hashes per path so rapid sequential writes (e.g., XmlFragment
// change followed by Observer A's Y.Text change) don't race: each filesystem event
// consumes only its matching entry, leaving others intact for subsequent events.
// Exported for test access; production code should use registerWrite().
export const writeTracker = new Map<string, Array<{ hash: string; timestamp: number }>>();
const WRITE_TRACKER_TTL_MS = 10_000;

/** Register an upcoming persistence write so the watcher skips the resulting FSEvent. */
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

/** Compute SHA-256 hex hash of content string. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Detect a symlink whose canonical target escapes contentDir.
 *
 * Both backends are now configured to NOT follow symlinks
 * (@parcel/watcher's default; chokidar gets `followSymlinks: false`).
 * However, the symlink itself remains a real entry inside contentDir, so
 * `add`/`change` events still fire for it. Without this guard,
 * `classifyEvents` would readFile() the symlink path (which dereferences
 * the link) and emit external content as a contentDir-scoped DiskEvent —
 * publishing arbitrary readable files into the CRDT layer.
 *
 * Returns false on lstat ENOENT (likely a delete) so existing delete
 * semantics are preserved; deletes don't read content. Returns true for
 * broken symlinks (realpath fails) — drop them out of an abundance of
 * caution; the seed walk treats them the same way.
 */
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

/** Map absolute file path to Hocuspocus document name (e.g., 'test-fixture'). */
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

/**
 * Extract the supported doc extension from a path with its original casing,
 * or null if the path does not end in a supported extension. Casing is
 * preserved so persistence can round-trip back to the same filename on disk
 * (`Foo.MD` stays `.MD`, not normalized to `.md`).
 */
function extractDocExtension(path: string): string | null {
  const ext = extname(path);
  if (ext === '') return null;
  const lower = ext.toLowerCase();
  if (lower === '.mdx' || lower === '.md') return ext;
  return null;
}

// ─── Last known hash map — for rename detection ─────────────────────────────

/**
 * Tracks the last known content hash for each watched .md file path.
 * Used to detect renames: when a delete+create pair in the same batch
 * has matching content hashes, it's emitted as a single Rename event.
 */
export const lastKnownHash = new Map<string, string>();

/** Update last known hash after reading a file. */
export function updateLastKnownHash(filePath: string, hash: string): void {
  lastKnownHash.set(filePath, hash);
}

/** Remove last known hash (on delete). Returns the removed hash if any. */
export function removeLastKnownHash(filePath: string): string | undefined {
  const hash = lastKnownHash.get(filePath);
  lastKnownHash.delete(filePath);
  return hash;
}

// ─── Batch classification ────────────────────────────────────────────────────

interface RawFileEvent {
  type: 'create' | 'update' | 'delete';
  path: string;
}

/**
 * Classify a batch of raw parcel events into typed DiskEvents.
 *
 * Rename detection: if a delete+create pair in the same batch has matching
 * content hashes, emit a single Rename event instead of Delete + Create.
 *
 * When a ContentFilter is provided, events for excluded paths are silently dropped.
 */
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

    // Apply content filter if provided
    if (contentFilter) {
      const relPath = toPosix(relative(contentDir, event.path));
      if (contentFilter.isExcluded(relPath)) continue;
    }

    switch (event.type) {
      case 'delete':
        deletes.push(event);
        break;
      case 'create':
        // Editors like VS Code do atomic saves (write tmp → rename over original).
        // @parcel/watcher reports this as 'create' even though the file existed.
        // If we already have a hash for this path, it's an update, not a create.
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

  // Read content for creates and updates
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

    // Live lstat + realpath for unknown paths (new symlinks post-startup)
    // or repointed aliases (existing alias whose target changed).
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
      // Regular file: if it was an alias that got replaced, clear the stale entry
      if (aliasMap.has(raw)) aliasMap.delete(raw);
      return raw;
    }

    // Symlink: resolve canonical, update aliasMap (handles both new and repointed)
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

  // Rename detection: match deletes to creates by content hash
  for (const del of deletes) {
    const deletedHash = removeLastKnownHash(del.path);
    if (!deletedHash) continue;

    // Look for a create in the same batch with matching hash
    for (const create of creates) {
      if (pairedCreates.has(create.path)) continue;
      const content = createContents.get(create.path);
      if (content === undefined) continue;
      const hash = contentHash(content);
      if (hash === deletedHash) {
        // Rename detected
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

  // Emit remaining deletes (not paired as renames)
  for (const del of deletes) {
    if (pairedDeletes.has(del.path)) continue;
    removeLastKnownHash(del.path);
    results.push({
      kind: 'delete',
      path: del.path,
      docName: resolveDocName(del.path),
    });
  }

  // Emit remaining creates (not paired as renames)
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

  // Emit updates
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

// ─── Self-write check ────────────────────────────────────────────────────────

/**
 * Check if an event is a self-write (our own persistence write).
 * If so, consume the tracker entry and return true.
 */
export function isSelfWrite(filePath: string, hash: string): boolean {
  const queue = writeTracker.get(filePath);
  if (!queue) return false;
  const idx = queue.findIndex((e) => e.hash === hash);
  if (idx < 0) return false;
  queue.splice(idx, 1);
  if (queue.length === 0) writeTracker.delete(filePath);
  return true;
}

// ─── Watcher ─────────────────────────────────────────────────────────────────

/**
 * Seed lastKnownHash with existing .md files so first edits classify as 'update'
 * not 'create'. Also populates the in-memory file index.
 *
 * When a ContentFilter is provided, excluded files are skipped.
 *
 * Async per-entry fs calls so the event loop stays responsive during the boot
 * walk on large content dirs — the synchronous variant blocked signal handlers
 * and collab/API traffic until the whole tree was read and hashed.
 */
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
            // Inode already visited. A file registers an alias on its canonical
            // entry; a directory records an alias EDGE instead of being re-walked
            // — its subtree is projected from the canonical at /api/documents
            // time, so the index stays O(symlinks), never O(symlinks × subtree).
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
            // Record the symlink as an alias EDGE rather than a folder entry at
            // the symlink path. The canonical subtree is materialized once below
            // (under canonical docNames) and projected under this alias prefix at
            // /api/documents time — index stays O(symlinks), not O(tree).
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
                ...derivePageMeta(content, canonicalDocName),
              });
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code !== 'ENOENT') {
                console.warn(`[file-watcher] Failed to seed hash for ${canonical}:`, err);
              }
            }
          } else if (canonStat.isFile()) {
            // Admit ANY ContentFilter-passing non-markdown file as a name-only
            // `kind:'file'` entry. Metadata only — NO readFile, NO contentHash,
            // NO lastKnownHash: the seed readFile count must be unchanged vs the
            // markdown-only baseline.
            // Use `isPathIgnored` (NOT `isExcluded`): the latter applies the
            // extension allowlist + sibling-asset admission and would default-
            // exclude every non-md non-asset file (e.g. `.ts`, `.json`). We
            // want the gitignore / .okignore / BUILTIN_SKIP_DIRS gate without
            // the extension allowlist — which is precisely what `isPathIgnored`
            // already exposes.
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
              // When .md is shadowed by an already-registered .mdx (or vice-versa),
              // skip registering this file in the index — the winning entry remains.
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
            ...derivePageMeta(content, docName),
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
        // Admit ANY ContentFilter-passing non-markdown file as a name-only
        // `kind:'file'` entry. Metadata only — NO readFile, NO contentHash,
        // NO lastKnownHash: the seed readFile count must be unchanged vs the
        // markdown-only baseline.
        // Use `isPathIgnored`.
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

/**
 * Update the file index after a disk event.
 * Called unconditionally for every classified event (including self-writes)
 * to keep the index in sync with actual disk state.
 */
export function updateFileIndex(event: DiskEvent, fileIndex: Map<string, FileIndexEntry>): void {
  // Asset and folder events are tracked by their own indexes, not by the
  // docName-keyed file index — short-circuit here. Asset events also fire for
  // many of the same files file events do (a `.png` is both an asset and a
  // `kind:'file'` entry); they update different state and are independent.
  if (
    event.kind === 'asset-create' ||
    event.kind === 'asset-delete' ||
    event.kind === 'folder-create' ||
    event.kind === 'folder-delete'
  ) {
    return;
  }
  // File events maintain `kind:'file'` entries — name-only, no content/hash.
  // The synthetic doc guard runs against a path-derived docName (no extension
  // stripping for non-md).
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
    // Never overwrite a markdown entry with a `kind:'file'` entry (defense-
    // in-depth: a markdown file should never produce a file-create event, but
    // a hypothetical write-race must not corrupt the markdown discriminator).
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
        canonicalPath: existing?.canonicalPath ?? event.newPath,
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
      // `mkdir -p a/b/c` creates all three levels faster than parcel-watcher
      // can call inotify_add_watch on each new directory, so kernel events
      // for the inner levels are emitted into watches that don't exist yet
      // and are dropped. Without this rescan, /api/documents silently misses
      // `a/b` and `a/b/c` until a server restart.
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
  // BFS so consumers see parent-before-child folder-create order, matching
  // the natural creation order of `mkdir -p`.
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
      // Dirent.isDirectory() returns false for symbolic links to directories;
      // symlinks are handled explicitly when their own raw event arrives.
      // Skipping them here keeps the rescan cycle-free without a visited set.
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

// ─── Shared event handler ───────────────────────────────────────────────────

/**
 * Process a batch of raw file events through the classification + self-write
 * detection pipeline. Shared by both @parcel/watcher and chokidar backends.
 *
 * Exported for unit-level coverage of the md-before-asset ordering invariant
 * — see the same-batch-create test in `file-watcher.test.ts`.
 */
export async function handleRawEvents(
  rawEvents: Array<{ type: 'create' | 'update' | 'delete'; path: string }>,
  contentDir: string,
  contentFilter: ContentFilter | undefined,
  fileIndex: Map<string, FileIndexEntry>,
  folderIndex: Map<string, FolderIndexEntry>,
  onDiskEvent: (event: DiskEvent) => Promise<void>,
  aliasMap?: Map<string, string>,
): Promise<void> {
  // Drop events whose canonical path escapes contentDir (defense-in-depth
  // against hostile symlinks created at runtime, e.g. `<contentDir>/x.md`
  // → `/etc/passwd`). Both backends are configured not to follow symlinks,
  // but the link itself still surfaces as an entry in contentDir, so its
  // create/change event fires regardless. Without this filter, the
  // downstream readFile() would dereference the link and publish external
  // content as a contentDir-scoped DiskEvent.
  const safeEvents = rawEvents.filter((e) => {
    if (!eventEscapesContentDir(e.path, contentDir)) return true;
    console.warn(`[file-watcher] Symlink escape: ${e.path}, dropping ${e.type} event`);
    return false;
  });

  const mdEvents = safeEvents.filter((e) => isSupportedDocFile(e.path));
  const assetEvents = safeEvents.filter((e) =>
    isSupportedAssetFile(e.path, LINKABLE_ASSET_EXTENSIONS),
  );
  // ANY non-markdown file (every extension, not just LINKABLE_ASSET_EXTENSIONS).
  // Asset events still fire for the basenameIndex (render concern); file events
  // maintain the in-memory fileIndex as `kind:'file'` for search /
  // `/api/documents`. A `.png` create fires both events independently —
  // different state, different consumers.
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

  // Process md events FIRST so the content filter's `dirCount` is current
  // when asset events run `isExcluded()`. Same-batch atomic creates like
  // `mkdir foo && cp note.md foo/ && cp pic.png foo/` arrive in a single
  // watcher callback — @parcel/watcher's FSEvents backend coalesces with
  // `latency=0.001` (1ms; FSEventsBackend.cc), and the chokidar fallback
  // pools into a 50ms `BATCH_WINDOW_MS`. Both windows easily span a quick
  // mkdir+cp+cp sequence. With assets-first ordering the asset event
  // hits `isExcluded()` while dirCount is still 0; assets that admit
  // only via the sibling-asset rule (extension in LINKABLE_ASSET_EXTENSIONS +
  // dirCount > 0) get silently dropped from basenameIndex until next
  // server restart. Md-first puts `incrementMdDir` (`create`
  // branch) ahead of the asset loop, lifting dirCount from 0 → 1 before
  // the asset is filtered. The watcher API path is unaffected — self-
  // writes already call `incrementMdDir` synchronously at the write
  // site.
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

    // Update the content filter's dirCount only for external changes. Self-
    // writes (e.g. `/api/create-page`, agent-write, persistence store) call
    // `contentFilter.incrementMdDir` synchronously at their own write site
    // so sibling assets dropped immediately after can pass the filter's
    // `LINKABLE_ASSET_EXTENSIONS + dirCount > 0` rule without racing this async
    // watcher callback. Incrementing here on self-writes would double-count.
    if (contentFilter && !isSelf) {
      // `event` here is narrowed to MarkdownDiskEvent by classifyEvents above
      // (asset events route through a separate path); the explicit no-op cases
      // make dirCount-unaffected variants visible, and assertNeverDiskEvent
      // fires if a new MarkdownDiskEvent variant is ever added without
      // updating this site.
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
          // Content edits don't add/remove a markdown directory entry.
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
    // Normalize + classify the path to bound span-attribute cardinality
    // (AGENTS.md STOP rule — raw paths blow up the trace index).
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

  // Emit asset events independently. Skip content reading (binary),
  // reconciliation, and rename-via-hash detection — basename index is
  // idempotent on add/remove/rename so a Finder rename surfacing as
  // delete+create produces the correct end state. Runs AFTER the md
  // loop so dirCount reflects same-batch md creates (see ordering note
  // at the top of the function).
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

  // Emit `file-*` events for every ContentFilter-passing non-markdown file so
  // the in-memory fileIndex gains `kind:'file'` entries. Metadata only — `stat`
  // for size/mtime/inode, no readFile and no contentHash. The seed walk's
  // readFile count must stay unchanged vs the markdown-only baseline; this live
  // path mirrors that contract.
  // Filter through `isPathIgnored` (NOT `isExcluded`): see seed-walk rationale.
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

    // Stat synchronously so we have size/mtime/inode at admission time.
    // `lstatSync` does not follow symlinks; if the entry is a symlink, re-stat
    // with `statSync` so `isFile()` / `size` / `mtime` / `ino` reflect the
    // canonical target — matching the seed walk's `canonStat` admission. The
    // symlink-escape filter already vetted in-bounds above, so following the
    // link here cannot escape `contentDir`. Broken links surface as ENOENT
    // from `statSync` and are dropped by the existing guard.
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

// ─── Backend: @parcel/watcher ───────────────────────────────────────────────

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
    // Expected in packaged builds: @parcel/watcher is a native module that
    // isn't bundled, so we fall back to chokidar. The `watching … backend:
    // chokidar` info line records the outcome — this is debug-only so the
    // terminal stays clean (it's a routine fallback, not an error).
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
          // Bump the markdown-view generation after every batch. Coarse-
          // grained (per batch, not per event) but correct: the next
          // `getFileIndex()` call rebuilds the cached snapshot.
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

// ─── Backend: chokidar ──────────────────────────────────────────────────────

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
  // The chosen backend is already recorded on the `watching … backend:
  // chokidar` info line, so no separate fallback warning is needed here.

  const watcher = watch(contentDir, {
    ignoreInitial: true,
    // Match @parcel/watcher's default — never traverse INTO symlinked
    // directories or watch through symlink targets. Combined with the
    // escape filter in `handleRawEvents`, this prevents a symlink in
    // contentDir from sourcing events for an arbitrary location on disk.
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

  // Batch chokidar events to match @parcel/watcher's coalescing behavior.
  // Without batching, a file rename (mv old.md new.md) produces separate
  // delete + create calls, breaking classifyEvents' rename detection which
  // requires both events in the same batch.
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

// ─── Watcher ─────────────────────────────────────────────────────────────────

/**
 * Start watching a content directory for external .md file changes.
 * Calls onDiskEvent for each classified event (not our own persistence writes).
 *
 * Uses @parcel/watcher when available, falls back to chokidar otherwise.
 *
 * When a ContentFilter is provided:
 * - Excluded files are skipped during the initial scan
 * - Excluded events are dropped in classifyEvents
 * - Best-effort ignore globs are passed to @parcel/watcher
 *
 * Returns a WatcherHandle with unsubscribe() and getFileIndex().
 */
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
  // Alias EDGES for directory symlinks: aliasFolderDocName → canonicalFolderDocName.
  // One entry per symlinked directory (O(symlinks)); the subtree is projected from
  // the canonical at /api/documents time, never materialized per descendant.
  const folderAliasIndex = new Map<string, string>();

  // Memoize the markdown-only view returned by `getFileIndex()`. Bumped at
  // every mutation point — seed, prune, rescan, the live disk-event loop
  // (`handleRawEvents` callback below), and the `mutateFileIndex` accessor.
  // Cache invalidates by generation mismatch; the rebuild O(n) is paid once
  // per mutation batch instead of per call (`findHubCandidates` and the
  // workspace search corpus call it on the per-write hot path).
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
      // Clear the module-level writeTracker on unsubscribe so test suites
      // that spin up successive watchers don't accumulate stale entries
      // across instances. Production: unsubscribe = shutdown, no consumers
      // remain. Tests: next startWatcher sees an empty tracker, which is
      // the correct starting state for a fresh isolation boundary.
      writeTracker.clear();
      lastKnownHash.clear();
      return originalUnsubscribe();
    },
    getFileIndex() {
      // Return a markdown-only view. The internal
      // `fileIndex` map holds BOTH `kind:'markdown'` and `kind:'file'` entries;
      // call sites that pass through this accessor observe markdown-only so
      // the ~16 markdown-assuming consumers stay safe by default.
      //
      // Memoized — rebuild only when a mutation has bumped the generation
      // since the last call. 13+ call sites hit this per request cycle
      // (including the per-write `findHubCandidates` hot path), so amortizing
      // the O(n) rebuild matters at corpus scale.
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
        // Mirror the admission predicate: `kind:'file'` entries are admitted
        // via `isPathIgnored` (gitignore/okignore + skip-dir floor, no
        // extension allowlist), so eviction must use the same gate. Using
        // `isExcluded` here — which default-excludes every non-md/non-asset
        // file — would evict every `kind:'file'` entry on each ignore-file
        // edit, churning the file tier and emitting a "files emptied"
        // window between prune and rescan. Markdown still uses `isExcluded`
        // so newly-shadowed `.md` files (e.g. listed in `.gitignore`) drop
        // out.
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
      // Re-seed using the same walk as startup — additive via Map.set, so
      // any entries already present keep their inode/aliases; missing entries
      // get inserted. Two production callers consume this:
      //   1. The Linux IN_CREATE-race rescue exposed via `POST /api/test-rescan-files`
      //      (dropped @parcel/watcher events for files written into freshly-
      //      created subdirectories under CI CPU contention).
      //   2. The post-rebuild reconcile inverse of `pruneFileIndexNowExcluded`:
      //      after a `.okignore` / `.gitignore` change *removes* a pattern,
      //      files no longer excluded by the pattern set need to be picked
      //      up, since they get no per-entry
      //      disk event. The additive walk picks them up. See
      //      `reconcileFileIndexAfterFilterRebuild` below.
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

/**
 * Reconcile the watcher's file/folder indexes with the current ContentFilter
 * state after a successful `rebuildIgnorePatterns()`.
 *
 * Required because ignore-file edits (`.okignore`, `.gitignore`) do NOT emit
 * per-entry disk events for paths whose included-ness flipped — the indexes
 * are otherwise only mutated by per-path FSEvents. Two symmetric steps:
 *
 *   1. Prune now-excluded entries (a pattern was added that matches them).
 *   2. Re-scan disk for now-included entries (a pattern was removed that
 *      excluded them).
 *
 * Calling only step 1 (the pre-fix shape) leaves the index stale after a
 * pattern removal: files on disk that should now be visible to
 * `/api/documents` stay hidden until the next server restart. Calling only
 * step 2 leaves now-excluded files visible until they're re-walked and
 * filtered out — but `seedLastKnownHashes` is purely additive, so it can't
 * remove entries on its own.
 *
 * Both steps together = the symmetric pair. Returns the prune counts for
 * telemetry; the rescan is unmeasured because the additive walk does not
 * track which entries are new vs. unchanged.
 */
export async function reconcileFileIndexAfterFilterRebuild(
  watcher: WatcherHandle | null | undefined,
): Promise<{
  prunedFiles: number;
  prunedFolders: number;
}> {
  if (!watcher) return { prunedFiles: 0, prunedFolders: 0 };
  // Both steps required — neither alone covers both directions: prune
  // removes entries the new filter excludes (the additive rescan can't
  // remove anything), and rescan inserts entries the new filter now
  // includes (the prune can't add anything). Order between the two is
  // not load-bearing: `seedLastKnownHashes` re-applies the kind-specific
  // admission predicate per entry — `isExcluded` for markdown,
  // `isPathIgnored` for `kind:'file'` — and `pruneFileIndexNowExcluded`
  // now mirrors the same split, so a rescan running before the prune
  // would still skip newly-excluded entries; the prune just sweeps out
  // whatever the rescan didn't touch.
  const prunedFiles = watcher.pruneFileIndexNowExcluded();
  const prunedFolders = watcher.pruneFolderIndexNowExcluded();
  await watcher.rescanFromDisk();
  return { prunedFiles, prunedFolders };
}
