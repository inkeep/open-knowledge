/**
 * Persistence for standalone Mermaid docs — `.mmd` / `.mermaid` files whose
 * docName RETAINS its extension (`assets/flow.mmd`). A FOURTH doc class.
 *
 * Shape: config-persistence's Y.Text-only body handling — the markdown observer
 * bridge is gated OFF for these (see `server-observer-extension.ts` /
 * `isMermaidDoc`), so the diagram source is stored VERBATIM. Routing the source
 * through the markdown pipeline (as `.md`/`.mdx` docs do) would re-canonicalize
 * it (blank-line normalization, escaping, fence promotion) and corrupt Mermaid
 * syntax. Verbatim fidelity (precedent #38, Y.Text-is-truth): the store
 * serializes from `Y.Text('source')` and never touches the XmlFragment.
 *
 * Unlike config docs (bounded `.ok/` set, schema-validated) these are arbitrary
 * user content files: no validation (any text is a valid `.mmd` — parse-failing
 * content still renders as source), and path resolution goes to the content dir.
 * A concurrent external writer (CLI / another editor) is caught by a
 * read-before-write reconcile; no file lock is taken (one server per contentDir
 * per `server.lock`, and Hocuspocus serializes `onStoreDocument` per doc).
 *
 * The path resolver is replicated here (rather than importing `safeContentPath`
 * from `persistence.ts`) to avoid a circular import — `persistence.ts` imports
 * this module for its dispatch branch.
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

/**
 * Persist a Mermaid doc to disk. Serializes from `Y.Text('source')` (verbatim —
 * precedent #38); atomic tmp+rename. Entry gate: a store whose last transaction
 * was the load/reconcile import (`MERMAID_SOURCE_ORIGIN`) is a no-op — belt-and-
 * suspenders alongside that origin's `skipStoreHooks: true`. Reconciles (imports
 * disk) instead of clobbering when an external writer changed the file since our
 * LKG.
 */
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
