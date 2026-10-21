/**
 * Verbatim fidelity (precedent #38, Y.Text-is-truth): the store serializes from `Y.Text('source')`
 * and never touches the XmlFragment.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LocalTransactionOrigin } from '@hocuspocus/server';
import {
  isExcalidrawDocFile,
  isMermaidDocFile,
  LINEAGE_EPOCH_KEY,
} from '@inkeep/open-knowledge-core';
import { atomicWriteFile } from '@inkeep/open-knowledge-core/server';
import type * as Y from 'yjs';
import type { DiskReceipt, FileObservation } from './disk-receipts.ts';
import { docNameToRelativePath } from './doc-extensions.ts';
import { assertNoSymlinkEscape } from './fs-safety.ts';
import { tracedMkdir } from './fs-traced.ts';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';
import {
  type EnginelessFileType,
  type KeptCopy,
  keepNoEngineVersion,
  type MergeHistoryRecorder,
} from './merge-history.ts';
import {
  incrementEnginelessIntake,
  incrementEnginelessStore,
  incrementStoreDiskCompareReadRetries,
  incrementStoreRestatRefused,
} from './metrics.ts';
import { isWithinDir } from './path-utils.ts';
import { heldFor, heldNotUtf8, type SaveHold } from './save-hold.ts';
import { contentScopedAtomicFs } from './server-content-policy.ts';
import {
  assertNeverDiskCompare,
  COMPARE_READ_RETRY_DELAYS_MS,
  compareDiskBeforeReplace,
  type DiskCompareOutcome,
  restatFile,
  StoreRestatFailedError,
  StoreRestatRefusedError,
  statObservation,
} from './store-compare.ts';
import { contentHash } from './version-hash.ts';

const log = getLogger('mermaid-persistence');

const MAX_OUTSIDE_VERSIONS_PER_STORE = 3;

export const MERMAID_SOURCE_ORIGIN = {
  source: 'local' as const,
  skipStoreHooks: true,
  context: { origin: 'mermaid-source' },
} as const satisfies LocalTransactionOrigin;

interface EnginelessReceipts {
  get(docName: string): DiskReceipt | undefined;
  recordAgreed(docName: string, content: string, observation?: FileObservation): void;
  recordOwnWrite(docName: string, content: string, observation?: FileObservation): void;
}

export interface MermaidPersistenceCtx {
  contentDir: string;
  home: string;
  assertContentPath?: (path: string) => void;
  lkgCache: Map<string, string>;
  receipts: EnginelessReceipts;
  history: Pick<MergeHistoryRecorder, 'saveNoEngine' | 'noticeNoEngine'> | null;
}

export type StoreMermaidOutcome = 'persisted' | 'no-op' | 'kept-live' | 'write-failed' | SaveHold;

type ApplyExternalEnginelessOutcome = 'applied' | 'kept-live' | 'unchanged' | 'held';

function mermaidAbsPath(documentName: string, contentDir: string): string {
  if (documentName.includes('\x00')) {
    throw new Error(`Invalid document name: ${documentName}`);
  }
  const filePath = resolve(contentDir, docNameToRelativePath(documentName));
  if (!isWithinDir(filePath, contentDir)) {
    throw new Error(`Invalid document name: ${documentName}`);
  }
  return filePath;
}

function enginelessFileType(documentName: string): EnginelessFileType {
  if (isMermaidDocFile(documentName)) return 'mermaid';
  if (isExcalidrawDocFile(documentName)) return 'excalidraw';
  return 'text';
}

function replaceSource(document: Y.Doc, raw: string, bumpLineage: boolean): void {
  const ytext = document.getText('source');
  document.transact(() => {
    if (ytext.length > 0) ytext.delete(0, ytext.length);
    if (raw.length > 0) ytext.insert(0, raw);
    if (bumpLineage) {
      document.getMap('lifecycle').set(LINEAGE_EPOCH_KEY, crypto.randomUUID());
    }
  }, MERMAID_SOURCE_ORIGIN);
}

async function keepOutsideVersion(
  documentName: string,
  outside: string,
  ctx: MermaidPersistenceCtx,
): Promise<KeptCopy | null> {
  const fileType = enginelessFileType(documentName);
  const copy = await keepNoEngineVersion(
    ctx.history,
    ctx.home,
    ctx.contentDir,
    documentName,
    { side: 'theirs', bytes: outside },
    fileType,
    docNameToRelativePath(documentName),
  );
  if (copy !== null) ctx.history?.noticeNoEngine(documentName, 'theirs', fileType, copy);
  return copy;
}

function keptWhere(copy: KeptCopy): string {
  return copy.where === 'history' ? 'history' : `the backup folder (${copy.backup.display})`;
}

export function loadMermaidDoc(
  document: Y.Doc,
  documentName: string,
  ctx: MermaidPersistenceCtx,
): void {
  const ytext = document.getText('source');
  if (ytext.length > 0) return;

  const filePath = mermaidAbsPath(documentName, ctx.contentDir);
  ctx.assertContentPath?.(filePath);
  if (!existsSync(filePath)) return;

  let raw: string;
  try {
    assertNoSymlinkEscape(filePath, ctx.contentDir);
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    log.warn({ documentName, err: e }, 'load: could not read; seeding empty');
    return;
  }
  replaceSource(document, raw, true);
  ctx.lkgCache.set(documentName, raw);
  ctx.receipts.recordAgreed(documentName, raw, statObservation(filePath));
}

async function compareWithRetry(
  filePath: string,
  expectedHash: string | undefined,
  lkg: string | undefined,
  candidateHash: string,
): Promise<DiskCompareOutcome> {
  for (let attempt = 0; ; attempt++) {
    const compared = compareDiskBeforeReplace({
      path: filePath,
      receiptHash: expectedHash,
      baseHash: lkg === undefined ? undefined : contentHash(lkg),
      candidateHash,
    });
    const retryDelayMs = COMPARE_READ_RETRY_DELAYS_MS[attempt];
    if (compared.kind !== 'unreadable' || !compared.transient || retryDelayMs === undefined) {
      return compared;
    }
    incrementStoreDiskCompareReadRetries();
    await new Promise((done) => setTimeout(done, retryDelayMs));
  }
}

/** Serializes from `Y.Text('source')` (verbatim — precedent #38); atomic tmp+rename. */
export async function storeMermaidDoc(
  document: Y.Doc,
  documentName: string,
  lastTransactionOrigin: unknown,
  ctx: MermaidPersistenceCtx,
): Promise<StoreMermaidOutcome> {
  if (lastTransactionOrigin === MERMAID_SOURCE_ORIGIN) return 'no-op';

  const content = document.getText('source').toString();
  const lkg = ctx.lkgCache.get(documentName);
  if (content === lkg) return 'no-op';

  const filePath = mermaidAbsPath(documentName, ctx.contentDir);
  const candidateHash = contentHash(content);
  try {
    assertNoSymlinkEscape(filePath, ctx.contentDir);
    ctx.assertContentPath?.(filePath);
    await tracedMkdir(resolve(filePath, '..'), { recursive: true });

    let expectedHash = ctx.receipts.get(documentName)?.hash;
    let movedOutside = false;
    for (let round = 0; round < MAX_OUTSIDE_VERSIONS_PER_STORE; round++) {
      const compared = await compareWithRetry(filePath, expectedHash, lkg, candidateHash);
      let observation: FileObservation | null;
      switch (compared.kind) {
        case 'match':
        case 'drift':
          observation = compared.observation;
          break;
        case 'absent':
          observation = null;
          break;
        case 'unreadable':
          incrementEnginelessStore('held-unreadable');
          log.warn(
            { documentName, code: errnoCode(compared.error) },
            'store: the file could not be read for the compare before the write; nothing was written and the next store tries again',
          );
          return heldFor('unreadable');
        case 'changed': {
          if (!compared.lossless) {
            incrementEnginelessStore('held-not-utf8');
            log.info(
              { documentName },
              'store: the file changed outside to bytes that are not valid UTF-8; nothing was written so they stay on disk',
            );
            return heldNotUtf8(filePath, compared.observation);
          }
          const copy = await keepOutsideVersion(documentName, compared.text, ctx);
          if (copy === null) {
            incrementEnginelessStore('held-no-history-or-backup');
            log.warn(
              { documentName },
              'store: the file changed outside and that version could not be kept in history or the backup folder; the version here stays live and the file is not written over',
            );
            return heldFor('no-history-or-backup');
          }
          movedOutside = true;
          expectedHash = contentHash(compared.text);
          log.info(
            { documentName, keptIn: copy.where },
            `store: the file changed outside; the version here stays and the outside version was kept in ${keptWhere(copy)}`,
          );
          continue;
        }
        default:
          return assertNeverDiskCompare(compared);
      }
      try {
        await atomicWriteFile(filePath, content, {
          fs: contentScopedAtomicFs((path) => {
            assertNoSymlinkEscape(path, ctx.contentDir);
            ctx.assertContentPath?.(path);
          }),
          beforeRename: () => {
            const restat = restatFile(filePath, observation);
            if (restat.kind === 'failed')
              throw new StoreRestatFailedError(documentName, restat.error);
            if (restat.kind === 'moved') throw new StoreRestatRefusedError(documentName);
          },
        });
      } catch (writeErr) {
        if (writeErr instanceof StoreRestatRefusedError) {
          incrementStoreRestatRefused();
          log.info(
            { documentName },
            'store: the file changed between the compare and the rename; the write was refused and the compare runs again',
          );
          continue;
        }
        if (writeErr instanceof StoreRestatFailedError) {
          incrementEnginelessStore('held-unreadable');
          log.warn(
            { documentName, code: writeErr.code },
            'store: the file could not be re-read before the rename; nothing was written and the next store tries again',
          );
          return heldFor('unreadable');
        }
        throw writeErr;
      }
      if (compared.kind === 'absent') incrementEnginelessStore('absent');
      else if (!movedOutside) incrementEnginelessStore('match');
      ctx.lkgCache.set(documentName, content);
      ctx.receipts.recordOwnWrite(documentName, content, statObservation(filePath));
      if (!movedOutside) return 'persisted';
      incrementEnginelessStore('kept-live');
      return 'kept-live';
    }
    incrementEnginelessStore('held-exhausted');
    log.warn(
      { documentName, rounds: MAX_OUTSIDE_VERSIONS_PER_STORE },
      'store: the file kept changing outside while it was being saved; nothing was written and the next store tries again',
    );
    return heldFor('keeps-changing');
  } catch (e) {
    log.warn({ documentName, err: e }, 'store: write failed');
    return 'write-failed';
  }
}

export async function applyExternalEnginelessChange(
  document: Y.Doc,
  documentName: string,
  ctx: MermaidPersistenceCtx,
): Promise<ApplyExternalEnginelessOutcome> {
  const filePath = mermaidAbsPath(documentName, ctx.contentDir);
  let bytes: Buffer;
  try {
    assertNoSymlinkEscape(filePath, ctx.contentDir);
    ctx.assertContentPath?.(filePath);
    bytes = readFileSync(filePath);
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT') {
      log.warn({ documentName, err: e }, 'intake: could not read the changed file');
    }
    return 'unchanged';
  }
  const disk = bytes.toString('utf8');
  if (!Buffer.from(disk, 'utf8').equals(bytes)) {
    incrementEnginelessIntake('held-not-utf8');
    log.warn(
      { documentName },
      'intake: the file changed outside to bytes that are not valid UTF-8; nothing was taken in',
    );
    return 'held';
  }
  const lkg = ctx.lkgCache.get(documentName);
  if (disk === lkg || contentHash(disk) === ctx.receipts.get(documentName)?.hash) {
    incrementEnginelessIntake('unchanged');
    return 'unchanged';
  }
  const live = document.getText('source').toString();
  if (live === disk) {
    ctx.lkgCache.set(documentName, disk);
    ctx.receipts.recordAgreed(documentName, disk, statObservation(filePath));
    incrementEnginelessIntake('unchanged');
    return 'unchanged';
  }
  if (live === (lkg ?? '')) {
    replaceSource(document, disk, false);
    ctx.lkgCache.set(documentName, disk);
    ctx.receipts.recordAgreed(documentName, disk, statObservation(filePath));
    incrementEnginelessIntake('applied');
    return 'applied';
  }
  const copy = await keepOutsideVersion(documentName, disk, ctx);
  if (copy === null) {
    incrementEnginelessIntake('held-no-history-or-backup');
    log.warn(
      { documentName },
      'intake: the file changed outside under unsaved edits and that version could not be kept in history or the backup folder; the version here stays live',
    );
    return 'held';
  }
  if (ctx.lkgCache.get(documentName) === lkg) {
    ctx.lkgCache.set(documentName, disk);
    ctx.receipts.recordAgreed(documentName, disk, statObservation(filePath));
  }
  incrementEnginelessIntake('kept-live');
  log.info(
    { documentName, keptIn: copy.where },
    `intake: the file changed outside under unsaved edits; the version here stays and the outside version was kept in ${keptWhere(copy)}`,
  );
  return 'kept-live';
}
