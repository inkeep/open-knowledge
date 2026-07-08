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

/**
 * Transaction origin for Mermaid seed / reconcile / external-import writes to
 * `Y.Text('source')`. `skipStoreHooks: true` so seeding never re-triggers a disk
 * write. Deliberately NOT `FILE_WATCHER_ORIGIN`: that origin is `paired: true`
 * (it mutates BOTH Y.Text and Y.XmlFragment and must route through a bridge-intake
 * primitive — enforced by `paired-write-enforcement.test.ts`). Mermaid docs are
 * Y.Text-only (the markdown bridge is gated off), so this origin is NON-paired,
 * mirroring config docs' `CONFIG_VALIDATION_REVERT_ORIGIN` (registered in that
 * test's SANCTIONED_NON_PRIMITIVE_ORIGINS for the identical reason).
 */
export const MERMAID_SOURCE_ORIGIN = {
  source: 'local' as const,
  skipStoreHooks: true,
  context: { origin: 'mermaid-source' },
} as const satisfies LocalTransactionOrigin;

export interface MermaidPersistenceCtx {
  /** Content root — a Mermaid doc resolves to `<contentDir>/<docName>`. */
  contentDir: string;
  /**
   * Per-server-instance last-known-good cache: the verbatim bytes last loaded
   * from or written to disk. Drives the store short-circuit, the concurrent-
   * writer reconcile, and the file-watcher self-write guard. Its own cache
   * (distinct doc-name space from the config / managed-artifact LKG caches).
   */
  lkgCache: Map<string, string>;
}

/** Store outcome — surfaced for tests + telemetry. */
export type StoreMermaidOutcome = 'persisted' | 'no-op' | 'reconciled' | 'write-failed';

/**
 * Resolve + containment-guard the on-disk path for a Mermaid docName. Mirrors
 * `safeContentPath` (NUL guard + `docNameToRelativePath` + within-dir check);
 * `docNameToRelativePath` returns a `.mmd` docName verbatim (it retains its ext).
 */
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

/**
 * Replace the whole `Y.Text('source')` with `raw` under `MERMAID_SOURCE_ORIGIN`
 * (`skipStoreHooks: true`, so seeding never re-triggers a disk write). Full
 * delete+insert rather than a diff: external-disk / reconcile imports are rare,
 * and yCollab merges the replacement for connected peers.
 */
function replaceSource(document: Y.Doc, raw: string, bumpLineage: boolean): void {
  const ytext = document.getText('source');
  document.transact(() => {
    if (ytext.length > 0) ytext.delete(0, ytext.length);
    if (raw.length > 0) ytext.insert(0, raw);
    if (bumpLineage) {
      // Fresh Yjs lineage per seed-from-disk (mirrors the content + managed-
      // artifact load paths): no Y-binary survives an unload, so the source is
      // re-inserted under fresh client IDs. Without an epoch a client's prior-
      // lineage IndexedDB copy would rejoin and concatenate the two independent
      // same-text insertions (self-duplication). Reconcile/external imports do
      // NOT bump — they mutate an already-established lineage.
      document.getMap('lifecycle').set(LINEAGE_EPOCH_KEY, crypto.randomUUID());
    }
  }, MERMAID_SOURCE_ORIGIN);
}

/**
 * Seed a Mermaid doc's `Y.Text('source')` from disk. Idempotent: re-seeds only
 * when Y.Text is empty. Lazy: a missing file seeds nothing (admitting a doc must
 * never auto-create disk).
 */
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
        // ENOENT (vanished between existsSync and read) is the benign race —
        // fall through and write. Anything else, log before proceeding so a
        // failed atomic write below isn't the first sign a read preceded it.
        if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(
            { documentName, err: readErr },
            'store: pre-write disk read failed (non-ENOENT); proceeding to write',
          );
        }
        disk = null;
      }
      // Concurrent external writer (CLI / another editor) diverged from our LKG:
      // import their bytes into Y.Text instead of clobbering.
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

// NOTE (follow-up): live external-disk-edit → open-Y.Doc sync is intentionally
// not wired here. `.mmd` stays a first-class asset in the file-watcher/index, so
// an external edit while the doc is OPEN is not pushed into `Y.Text` live; it is
// picked up on the next open (`loadMermaidDoc` re-reads disk) and, if the doc was
// edited in-app meanwhile, `storeMermaidDoc`'s reconcile makes disk win rather
// than clobbering the external change. Adding a `mermaid-*` file-watcher event
// (an `applyExternalMermaidChange` that replaces `Y.Text` under
// `MERMAID_SOURCE_ORIGIN`) would close that gap — deferred to avoid touching the
// file-watcher's DiskEvent taxonomy + fileIndex "never widen" contract.
