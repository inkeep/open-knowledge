import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WatcherHandle } from './file-watcher.ts';
import { getLogger } from './logger.ts';

const log = getLogger('recovered-file-target');

interface ReconcileRecoveredFileTargetOptions {
  watcher: Pick<WatcherHandle, 'mutateFileIndex'>;
  contentDir: string;
  relativePath: string;
  exists: boolean;
  invalidateReferencedAssetsCache: (() => void) | null;
}

/**
 * Repair every inventory layer after the local-target sweep detects a file event
 * the platform watcher missed. The file index and referenced-asset cache must
 * advance together or link diagnostics can disagree until another disk event.
 */
export function reconcileRecoveredFileTarget({
  watcher,
  contentDir,
  relativePath,
  exists,
  invalidateReferencedAssetsCache,
}: ReconcileRecoveredFileTargetOptions): void {
  const absolutePath = join(contentDir, relativePath);
  if (!exists) {
    watcher.mutateFileIndex({ kind: 'file-delete', path: absolutePath, relativePath });
    invalidateReferencedAssetsCache?.();
    return;
  }

  try {
    const canonicalPath = realpathSync(absolutePath);
    const stats = statSync(canonicalPath);
    watcher.mutateFileIndex({
      kind: 'file-create',
      path: canonicalPath,
      relativePath,
      size: stats.size,
      modifiedTs: stats.mtimeMs,
      inode: stats.ino,
    });
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'UNKNOWN';
    if (code !== 'ENOENT') {
      log.warn({ code }, 'recovered file metadata unavailable; treating local target as deleted');
    }
    watcher.mutateFileIndex({ kind: 'file-delete', path: absolutePath, relativePath });
  }
  invalidateReferencedAssetsCache?.();
}
