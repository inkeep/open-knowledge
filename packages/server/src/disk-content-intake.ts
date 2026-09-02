import type * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import type { DeriveLossDetectOptions } from './bridge-loss-detector.ts';
import type { PairedWriteOrigin } from './server-observers.ts';

export const FILE_WATCHER_ORIGIN = {
  source: 'local',
  skipStoreHooks: true,
  context: { origin: 'file-watcher', paired: true },
} as const satisfies PairedWriteOrigin;

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
