import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { isConfigDoc, isSystemDoc } from '../cc1-broadcast.ts';
import type { DerivedDocumentIndexMutation } from '../derived-document-index.ts';
import { forgetDocExtension, registerDocExtension, stripDocExtension } from '../doc-extensions.ts';
import { contentHash, registerWrite } from '../file-watcher.ts';
import { isAlreadyExistsError } from '../fs-safety.ts';
import {
  tracedCpSync,
  tracedMkdirSync,
  tracedRmdirSync,
  tracedRmSync,
  tracedUnlinkSync,
  tracedWriteFileSync,
} from '../fs-traced.ts';
import { errnoCode } from '../http/handler-utils.ts';
import { getLogger } from '../logger.ts';

/**
 * Domain operations for the files/folders capability (create, hard delete,
 * trash reconciliation, duplication). Transports validate and map outcomes;
 * this module owns the ordered server-state teardown that
 * both destructive paths share:
 *
 *   capture-and-close live docs → mark recently-removed → (delete only:
 *   disk mutation) → index purges → derived-doc deletion → CC1 signal
 *
 * Hard delete and trash-cleanup are deliberate twins: trash's file is
 * already in the OS Trash before the call (Step 1 of the two-step flow),
 * so it reconciles the same server state while never touching disk.
 *
 * Every deletion enumerates docs from DISK, not the lagging file index
 * (`listManagedDocNamesUnderFolder` via deps) — except trash-cleanup, whose
 * source of truth is deliberately the in-memory index: disk is already
 * post-deletion there, and an empty index means the watcher won the race
 * and the idempotent fast-path returns an empty list.
 */

type FileOpKind = 'file' | 'folder' | 'asset';

type CreateFolderOutcome = { ok: true } | { ok: false; kind: 'already-exists' };

type CreatePageOutcome = { ok: true } | { ok: false; kind: 'already-exists'; cause: unknown };

type DeletePathOutcome =
  | { ok: true; deletedDocNames: string[] }
  | { ok: false; kind: 'not-found' }
  | { ok: false; kind: 'type-mismatch' }
  | { ok: false; kind: 'conflict'; file: string };

type DuplicatePathOutcome =
  | { ok: true; duplicatedPath: string; duplicatedDocNames: string[] }
  | { ok: false; kind: 'not-found' }
  | { ok: false; kind: 'type-mismatch' }
  | { ok: false; kind: 'conflict'; file: string }
  | { ok: false; kind: 'destination-excluded' }
  | { ok: false; kind: 'already-exists'; cause: unknown };

export interface FileOpsDeps {
  contentDir: string;
  resolveContentEntryPath: (contentDir: string, kind: 'file' | 'folder', path: string) => string;
  docNameForPath: (relPath: string) => string;
  docNameToRelativePath: (docName: string) => string;
  listManagedDocNamesUnderFolder: (absFolderPath: string) => string[];
  listAffectedDocNames: (
    index: ReadonlyMap<string, unknown>,
    kind: 'folder',
    path: string,
  ) => string[];
  getFileIndex: () => ReadonlyMap<string, unknown>;
  /** Conflicted files per the sync engine's store (empty set when no engine). */
  getConflictedFiles: () => ReadonlySet<string>;
  /** Lifecycle-conflict check against the live Hocuspocus doc, when loaded. */
  isDocNameInLifecycleConflict: (docName: string) => boolean;
  captureAndCloseDocuments: (docNames: string[], reason: 'deleted-upstream') => Promise<unknown>;
  /** Present in project mode; absent in harnesses without the LRU. */
  markRecentlyRemoved?: (docName: string) => void;
  mutateFileIndexDelete?: (args: { path: string; docName: string }) => void;
  removeFolderIndexEntries: (folderPath: string) => void;
  upsertFolderIndexPathSegments: (folderPath: string) => void;
  deleteDerivedDocumentsBestEffort: (docNames: string[], source: string) => Promise<void>;
  invalidateReferencedAssetsCache: () => void;
  signalFiles: () => void;
  /** "name copy N" allocation; throws when all slots are taken. */
  nextAvailableDuplicateDocName: (sourceDocName: string) => { docName: string };
  nextAvailableDuplicateFolderPath: (sourceFolderPath: string) => { folderPath: string };
  /** Containment- and symlink-checked absolute destination for a doc duplicate. */
  resolveDuplicateDocPath: (docName: string, extension: string) => string;
  collectMarkdownCopies: (
    folderPath: string,
  ) => Array<{ docName: string; fullPath: string; content: string }>;
  collectFolderPaths: (folderPath: string) => string[];
  contentFilter?: {
    isExcluded(relativePath: string): boolean;
    isDirExcluded(relativePath: string): boolean;
    incrementMdDir(dir: string): void;
    decrementMdDir(dir: string): void;
  };
  unmarkRecentlyRemoved?: (docName: string) => void;
  mutateFileIndexCreate?: (args: { path: string; docName: string; content: string }) => void;
  recordDerivedDocumentBestEffort: (
    documentName: string,
    markdown: string,
    reason: string,
  ) => Promise<void>;
  recordDerivedMutationsBestEffort: (
    mutations: readonly DerivedDocumentIndexMutation[],
    reason: string,
  ) => Promise<void>;
}

export interface FileOpsService {
  createFolder(folderPath: string): CreateFolderOutcome;
  /**
   * Create-exclusive doc write plus the synchronous registration set that
   * keeps the watcher, content filter, and file index coherent with a
   * self-write. Deliberately synchronous end-to-end: the caller records
   * contributors immediately after, and any async yield before that
   * recording opens a window where a pending shadow-commit timer drains the
   * contributor accumulator without this file's attribution. The caller
   * then seeds the derived index and emits the CC1 signal.
   */
  createPage(input: {
    fullPath: string;
    docName: string;
    initialContent: string;
  }): CreatePageOutcome;
  deletePath(operationKind: FileOpKind, operationPath: string): Promise<DeletePathOutcome>;
  trashCleanup(
    operationKind: FileOpKind,
    path: string,
    operationDocName: string,
    logSource: string,
  ): Promise<{ deletedDocNames: string[] }>;
  /**
   * Unlike delete/trash, duplication does NOT emit the CC1 files signal —
   * the caller signals after contributor recording so attribution is
   * queryable by the time the renderer refetches the tree.
   */
  duplicatePath(
    kind: 'file' | 'folder',
    requestedPath: string,
    requestedDocName: string,
  ): Promise<DuplicatePathOutcome>;
}

const log = getLogger('file-ops');

export function createFileOpsService(deps: FileOpsDeps): FileOpsService {
  const { contentDir } = deps;

  function markRemoved(docNames: string[], logSource: string): void {
    if (!deps.markRecentlyRemoved) return;
    for (const docName of docNames) {
      // STOP gate at the documentName-keyed entry point: synthetic docs
      // cannot appear here today (path validation rejects them upstream),
      // but the filter stays defense-in-depth.
      if (isSystemDoc(docName) || isConfigDoc(docName)) continue;
      deps.markRecentlyRemoved(docName);
      console.info(
        JSON.stringify({
          event: 'recently-removed-docs-populate',
          docName,
          kind: 'deleted',
          source: logSource,
        }),
      );
    }
  }

  function purgeFileIndex(docNames: string[]): void {
    for (const docName of docNames) {
      deps.mutateFileIndexDelete?.({
        path: resolve(contentDir, deps.docNameToRelativePath(docName)),
        docName,
      });
    }
  }

  // Conflict-aware refusal, dual-source (same rationale as the rename
  // spine): the live doc's lifecycle state catches loaded docs, the sync
  // engine's store catches docs evicted from memory.
  function findConflictedFile(docNames: string[]): string | null {
    const conflictedFiles = deps.getConflictedFiles();
    for (const docName of docNames) {
      const filePath = deps.docNameToRelativePath(docName);
      if (deps.isDocNameInLifecycleConflict(docName) || conflictedFiles.has(filePath)) {
        return filePath;
      }
    }
    return null;
  }

  return {
    createPage(input) {
      const { fullPath, docName, initialContent } = input;
      tracedMkdirSync(dirname(fullPath), { recursive: true });
      try {
        tracedWriteFileSync(fullPath, initialContent, { encoding: 'utf-8', flag: 'wx' });
      } catch (err) {
        if (isAlreadyExistsError(err)) {
          return { ok: false, kind: 'already-exists', cause: err };
        }
        throw err;
      }
      // Eager invalidation: legitimate recreation at a recently-renamed or
      // recently-deleted name drops the stale cache entry so the next
      // connection admits cleanly. No-op when absent.
      deps.unmarkRecentlyRemoved?.(docName);
      // Synchronously bump the content filter's sibling-asset dirCount so any
      // sibling asset drop that follows is admitted by the `LINKABLE_ASSET_EXTENSIONS`
      // rule. The file watcher's `create` event will also increment later,
      // which would double-count — so we also `registerWrite` to mark this
      // as a self-write, and the watcher skips its own `incrementMdDir` on
      // self-writes. See file-watcher.ts for the paired logic.
      deps.contentFilter?.incrementMdDir(dirname(docName));
      registerWrite(fullPath, contentHash(initialContent));
      deps.mutateFileIndexCreate?.({ path: fullPath, docName, content: initialContent });
      return { ok: true };
    },

    createFolder(folderPath) {
      const fullPath = deps.resolveContentEntryPath(contentDir, 'folder', folderPath);
      if (existsSync(fullPath)) {
        return { ok: false, kind: 'already-exists' };
      }
      tracedMkdirSync(fullPath, { recursive: true });
      deps.upsertFolderIndexPathSegments(folderPath);
      deps.signalFiles();
      return { ok: true };
    },

    async deletePath(operationKind, operationPath) {
      const targetPath =
        operationKind === 'asset'
          ? deps.resolveContentEntryPath(contentDir, 'folder', operationPath)
          : deps.resolveContentEntryPath(contentDir, operationKind, operationPath);
      if (!existsSync(targetPath)) {
        return { ok: false, kind: 'not-found' };
      }
      const targetStat = statSync(targetPath);
      if (
        ((operationKind === 'file' || operationKind === 'asset') && !targetStat.isFile()) ||
        (operationKind === 'folder' && !targetStat.isDirectory())
      ) {
        return { ok: false, kind: 'type-mismatch' };
      }

      // Disk-truth enumeration BEFORE the disk delete — the watcher-fed
      // index lags fresh writes, and an empty list here would skip the
      // capture/close + recently-removed population while the rm below
      // still removes the directory (orphaned in-memory Y.Docs).
      const deletedDocNames =
        operationKind === 'asset'
          ? []
          : operationKind === 'file'
            ? [deps.docNameForPath(operationPath)]
            : deps.listManagedDocNamesUnderFolder(
                deps.resolveContentEntryPath(contentDir, 'folder', operationPath),
              );

      // Any conflicted child blocks a folder delete — resolution must
      // finish first.
      const conflictedFile = findConflictedFile(deletedDocNames);
      if (conflictedFile !== null) {
        return { ok: false, kind: 'conflict', file: conflictedFile };
      }

      await deps.captureAndCloseDocuments(deletedDocNames, 'deleted-upstream');
      // Populate the removal cache BEFORE the disk delete so a fast
      // reconnect that observes the file gone via the watcher also sees
      // the cache entry.
      markRemoved(deletedDocNames, 'handleDeletePath');

      if (operationKind === 'file' || operationKind === 'asset') {
        tracedUnlinkSync(targetPath);
      } else {
        tracedRmSync(targetPath, { recursive: true, force: false });
        deps.removeFolderIndexEntries(operationPath);
      }
      deps.invalidateReferencedAssetsCache();

      purgeFileIndex(deletedDocNames);
      await deps.deleteDerivedDocumentsBestEffort(deletedDocNames, 'delete-path');
      deps.signalFiles();
      return { ok: true, deletedDocNames };
    },

    async trashCleanup(operationKind, path, operationDocName, logSource) {
      if (operationKind === 'asset') {
        deps.invalidateReferencedAssetsCache();
        deps.signalFiles();
        return { deletedDocNames: [] };
      }
      const initialIndex = deps.getFileIndex();
      const deletedDocNames =
        operationKind === 'file'
          ? initialIndex.has(operationDocName)
            ? [operationDocName]
            : []
          : deps.listAffectedDocNames(initialIndex, 'folder', path);

      deps.invalidateReferencedAssetsCache();

      if (deletedDocNames.length === 0) {
        return { deletedDocNames: [] };
      }

      await deps.captureAndCloseDocuments(deletedDocNames, 'deleted-upstream');
      markRemoved(deletedDocNames, logSource);
      purgeFileIndex(deletedDocNames);
      if (operationKind === 'folder') {
        deps.removeFolderIndexEntries(path);
      }
      await deps.deleteDerivedDocumentsBestEffort(deletedDocNames, 'trash-cleanup');
      // Synchronous CC1 emit closes the race where the renderer expects the
      // updated tree right after the response; the watcher's later emit is
      // idempotent at the consumer.
      deps.signalFiles();
      return { deletedDocNames };
    },

    async duplicatePath(kind, requestedPath, requestedDocName) {
      const sourcePath = deps.resolveContentEntryPath(contentDir, kind, requestedPath);
      if (!existsSync(sourcePath)) {
        if (kind === 'file') {
          const folderSourcePath = deps.resolveContentEntryPath(
            contentDir,
            'folder',
            requestedPath,
          );
          if (existsSync(folderSourcePath) && statSync(folderSourcePath).isDirectory()) {
            return { ok: false, kind: 'type-mismatch' };
          }
        }
        return { ok: false, kind: 'not-found' };
      }
      const sourceStat = statSync(sourcePath);
      if (
        (kind === 'file' && !sourceStat.isFile()) ||
        (kind === 'folder' && !sourceStat.isDirectory())
      ) {
        return { ok: false, kind: 'type-mismatch' };
      }

      // Duplicating a conflicted source would copy the raw `<<<<<<< HEAD` /
      // `=======` / `>>>>>>>` marker bytes from disk into a new file at the
      // destination, producing a broken duplicate. Refuse; the user must
      // resolve the conflict first. Disk-truth enumeration for the same
      // watcher-lag reason as deletePath — a fresh, unindexed conflicted
      // child must not be silently skipped.
      const sourceDocNames =
        kind === 'file'
          ? [deps.docNameForPath(requestedPath)]
          : deps.listManagedDocNamesUnderFolder(
              deps.resolveContentEntryPath(contentDir, 'folder', requestedPath),
            );
      const conflictedFile = findConflictedFile(sourceDocNames);
      if (conflictedFile !== null) {
        return { ok: false, kind: 'conflict', file: conflictedFile };
      }

      if (kind === 'file') {
        const sourceExtension = extname(sourcePath);
        const { docName: duplicatedPath } = deps.nextAvailableDuplicateDocName(requestedDocName);
        if (
          isSystemDoc(duplicatedPath) ||
          isConfigDoc(duplicatedPath) ||
          deps.contentFilter?.isExcluded(`${duplicatedPath}${sourceExtension}`)
        ) {
          return { ok: false, kind: 'destination-excluded' };
        }
        const destinationPath = deps.resolveDuplicateDocPath(duplicatedPath, sourceExtension);
        const content = readFileSync(sourcePath, 'utf-8');
        const destinationDir = dirname(destinationPath);
        const destinationDirExisted = existsSync(destinationDir);
        try {
          tracedMkdirSync(destinationDir, { recursive: true });
          tracedWriteFileSync(destinationPath, content, { encoding: 'utf-8', flag: 'wx' });
        } catch (err) {
          if (isAlreadyExistsError(err)) {
            return { ok: false, kind: 'already-exists', cause: err };
          }
          if (!destinationDirExisted) {
            try {
              tracedRmdirSync(destinationDir);
            } catch (cleanupErr) {
              const cleanupCode = errnoCode(cleanupErr);
              if (cleanupCode !== 'ENOENT' && cleanupCode !== 'ENOTEMPTY') {
                log.warn(
                  { destinationDir, err: cleanupErr },
                  '[duplicate-path] failed to clean duplicate parent directory',
                );
              }
            }
          }
          throw err;
        }
        let didIncrementMdDir = false;
        try {
          registerDocExtension(duplicatedPath, sourceExtension);
          deps.unmarkRecentlyRemoved?.(duplicatedPath);
          if (deps.contentFilter) {
            deps.contentFilter.incrementMdDir(dirname(duplicatedPath));
            didIncrementMdDir = true;
          }
          registerWrite(destinationPath, contentHash(content));
          deps.mutateFileIndexCreate?.({
            path: destinationPath,
            docName: duplicatedPath,
            content,
          });
        } catch (err) {
          try {
            tracedRmSync(destinationPath, { force: true });
          } catch (cleanupErr) {
            log.warn(
              { destinationPath, err: cleanupErr },
              '[duplicate-path] failed to clean partial file duplicate',
            );
          }
          forgetDocExtension(duplicatedPath);
          if (deps.contentFilter && didIncrementMdDir) {
            deps.contentFilter.decrementMdDir(dirname(duplicatedPath));
          }
          deps.mutateFileIndexDelete?.({ path: destinationPath, docName: duplicatedPath });
          throw err;
        }
        await deps.recordDerivedDocumentBestEffort(duplicatedPath, content, 'duplicate-path-file');
        return { ok: true, duplicatedPath, duplicatedDocNames: [duplicatedPath] };
      }

      const { folderPath: duplicatedPath } = deps.nextAvailableDuplicateFolderPath(requestedPath);
      if (deps.contentFilter?.isDirExcluded(duplicatedPath)) {
        return { ok: false, kind: 'destination-excluded' };
      }
      const destinationPath = deps.resolveContentEntryPath(contentDir, 'folder', duplicatedPath);
      const copiedDocRollbackLedger: Array<{
        docName: string;
        fullPath: string;
        extensionRegistered: boolean;
        dirCountIncremented: boolean;
        fileIndexRegistered: boolean;
      }> = [];
      try {
        tracedCpSync(sourcePath, destinationPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      } catch (err) {
        if (isAlreadyExistsError(err)) {
          return { ok: false, kind: 'already-exists', cause: err };
        }
        throw err;
      }
      const derivedMutations: DerivedDocumentIndexMutation[] = [];
      let duplicatedDocNames: string[] = [];
      try {
        for (const folderPath of deps.collectFolderPaths(duplicatedPath)) {
          deps.upsertFolderIndexPathSegments(folderPath);
        }
        const copiedDocs = deps.collectMarkdownCopies(duplicatedPath);
        duplicatedDocNames = copiedDocs.map((doc) => doc.docName);
        for (const doc of copiedDocs) {
          const rollbackEntry = {
            docName: doc.docName,
            fullPath: doc.fullPath,
            extensionRegistered: false,
            dirCountIncremented: false,
            fileIndexRegistered: false,
          };
          copiedDocRollbackLedger.push(rollbackEntry);
          const sourceExtension = extname(doc.fullPath);
          registerDocExtension(stripDocExtension(doc.docName), sourceExtension);
          rollbackEntry.extensionRegistered = true;
          deps.unmarkRecentlyRemoved?.(doc.docName);
          if (deps.contentFilter) {
            deps.contentFilter.incrementMdDir(dirname(doc.docName));
            rollbackEntry.dirCountIncremented = true;
          }
          registerWrite(doc.fullPath, contentHash(doc.content));
          rollbackEntry.fileIndexRegistered = true;
          deps.mutateFileIndexCreate?.({
            path: doc.fullPath,
            docName: doc.docName,
            content: doc.content,
          });
          derivedMutations.push({
            kind: 'upsert',
            documentName: doc.docName,
            markdown: doc.content,
          });
        }
      } catch (err) {
        for (const rollbackEntry of copiedDocRollbackLedger.reverse()) {
          if (rollbackEntry.fileIndexRegistered) {
            try {
              deps.mutateFileIndexDelete?.({
                path: rollbackEntry.fullPath,
                docName: rollbackEntry.docName,
              });
            } catch (rollbackErr) {
              log.warn(
                { docName: rollbackEntry.docName, err: rollbackErr },
                '[duplicate-path] failed to roll back copied file-index row',
              );
            }
          }
          if (rollbackEntry.dirCountIncremented) {
            deps.contentFilter?.decrementMdDir(dirname(rollbackEntry.docName));
          }
          if (rollbackEntry.extensionRegistered) {
            forgetDocExtension(stripDocExtension(rollbackEntry.docName));
          }
        }
        deps.removeFolderIndexEntries(duplicatedPath);
        try {
          tracedRmSync(destinationPath, { recursive: true, force: true });
        } catch (cleanupErr) {
          log.warn(
            { destinationPath, err: cleanupErr },
            '[duplicate-path] failed to clean partial folder duplicate',
          );
        }
        throw err;
      }
      await deps.recordDerivedMutationsBestEffort(derivedMutations, 'duplicate-path-folder');
      return { ok: true, duplicatedPath, duplicatedDocNames };
    },
  };
}
