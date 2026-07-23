import type * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import type { PairedWriteOrigin } from './server-observers.ts';

/**
 * Identity-stable transaction origin for file-watcher disk-to-CRDT writes.
 * The paired marker opts into the bridge observers' paired-write fast path;
 * skipStoreHooks prevents persistence from re-saving bytes just read from disk.
 */
export const FILE_WATCHER_ORIGIN = {
  source: 'local',
  skipStoreHooks: true,
  context: { origin: 'file-watcher', paired: true },
} as const satisfies PairedWriteOrigin;

/**
 * Apply raw disk bytes through the shared paired-write primitive. The caller
 * owns the outer `document.transact(..., FILE_WATCHER_ORIGIN)` boundary.
 */
export function applyDiskContentToDoc(
  document: Y.Doc,
  content: string,
  resolveEmbed?: (basename: string, sourcePath: string) => string | null,
  sourcePath?: string,
  resolveSize?: (basename: string, sourcePath: string) => number | null,
): void {
  const embedResolver =
    resolveEmbed && sourcePath ? { resolveEmbed, resolveSize, sourcePath } : undefined;
  composeAndWriteRawBody(document, content, 'file-watcher', embedResolver);
}
