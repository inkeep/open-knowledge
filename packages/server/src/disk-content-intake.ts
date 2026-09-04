import type * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import type { PairedWriteOrigin } from './server-observers.ts';

export const FILE_WATCHER_ORIGIN = {
  source: 'local',
  skipStoreHooks: true,
  context: { origin: 'file-watcher', paired: true },
} as const satisfies PairedWriteOrigin;

export function applyDiskContentToDoc(document: Y.Doc, content: string): void {
  composeAndWriteRawBody(document, content, 'file-watcher');
}
