import type * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import type { DeriveLossDetectOptions } from './bridge-loss-detector.ts';
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
 *
 * `detect` opts this write into paired-intake derive-loss detection. Omitting
 * it leaves the write serialize-free, which is why the persistence and
 * managed-artifact callers pass nothing: they re-apply bytes the fragment is
 * already derived from, so there is no un-propagated editor content to lose.
 */
export function applyDiskContentToDoc(
  document: Y.Doc,
  content: string,
  resolveEmbed?: (basename: string, sourcePath: string) => string | null,
  sourcePath?: string,
  resolveSize?: (basename: string, sourcePath: string) => number | null,
  detect?: DeriveLossDetectOptions,
): void {
  const embedResolver =
    resolveEmbed && sourcePath ? { resolveEmbed, resolveSize, sourcePath } : undefined;
  composeAndWriteRawBody(document, content, 'file-watcher', embedResolver, undefined, detect);
}
