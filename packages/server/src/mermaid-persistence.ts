/**
 * Verbatim fidelity (precedent #38, Y.Text-is-truth): the store serializes from `Y.Text('source')`
 * and never touches the XmlFragment.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LocalTransactionOrigin } from '@hocuspocus/server';
import { LINEAGE_EPOCH_KEY } from '@inkeep/open-knowledge-core';
import { atomicWriteFile } from '@inkeep/open-knowledge-core/server';
import type * as Y from 'yjs';
import { docNameToRelativePath } from './doc-extensions.ts';
import { tracedAtomicFs, tracedMkdir } from './fs-traced.ts';
import { getLogger } from './logger.ts';
import { isWithinDir } from './path-utils.ts';

const log = getLogger('mermaid-persistence');

export const MERMAID_SOURCE_ORIGIN = {
  source: 'local' as const,
  skipStoreHooks: true,
  context: { origin: 'mermaid-source' },
} as const satisfies LocalTransactionOrigin;

export interface MermaidPersistenceCtx {
  contentDir: string;
  lkgCache: Map<string, string>;
}

export type StoreMermaidOutcome = 'persisted' | 'no-op' | 'reconciled' | 'write-failed';

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

export function loadMermaidDoc(
  document: Y.Doc,
  documentName: string,
  ctx: MermaidPersistenceCtx,
): void {
  const ytext = document.getText('source');
  if (ytext.length > 0) return;

  const filePath = mermaidAbsPath(documentName, ctx.contentDir);
  if (!existsSync(filePath)) return;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    log.warn({ documentName, err: e }, 'load: could not read; seeding empty');
    return;
  }
  replaceSource(document, raw, true);
  ctx.lkgCache.set(documentName, raw);
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
  try {
    await tracedMkdir(resolve(filePath, '..'), { recursive: true });

    if (existsSync(filePath)) {
      let disk: string | null = null;
      try {
        disk = readFileSync(filePath, 'utf-8');
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(
            { documentName, err: readErr },
            'store: pre-write disk read failed (non-ENOENT); proceeding to write',
          );
        }
        disk = null;
      }
      if (disk !== null && disk !== lkg && disk !== content) {
        replaceSource(document, disk, false);
        ctx.lkgCache.set(documentName, disk);
        return 'reconciled';
      }
    }

    await atomicWriteFile(filePath, content, { fs: tracedAtomicFs });
    ctx.lkgCache.set(documentName, content);
    return 'persisted';
  } catch (e) {
    log.warn({ documentName, err: e }, 'store: write failed');
    return 'write-failed';
  }
}
