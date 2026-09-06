import type * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import type { DeriveLossDetectOptions } from './bridge-loss-detector.ts';
import type { PairedWriteOrigin } from './write-origins.ts';

export const FILE_WATCHER_ORIGIN = {
  source: 'local',
  skipStoreHooks: true,
  context: { origin: 'file-watcher', paired: true },
} as const satisfies PairedWriteOrigin;

/* STOP: `detect` must be read before the write and reported after it. Under the single
   replica the pre-write Y.Text body is the only witness to content that reached no disk,
   so capturing it after composeAndWriteRawBody reports an empty loss set every time. */
export function applyDiskContentToDoc(
  document: Y.Doc,
  content: string,
  _resolveEmbed?: (basename: string, sourcePath: string) => string | null,
  _sourcePath?: string,
  _resolveSize?: (basename: string, sourcePath: string) => number | null,
  detect?: DeriveLossDetectOptions,
): void {
  const pendingBody = detect === undefined ? '' : document.getText('source').toString();
  composeAndWriteRawBody(document, content, 'file-watcher');
  if (detect === undefined) return;
  const appliedBody = document.getText('source').toString();
  detect.report({
    pendingBody,
    baselineBody: detect.baselineFullMd,
    ytextDerivedBody: appliedBody,
    rebuiltBody: appliedBody,
    restorePayload: appliedBody,
  });
}
