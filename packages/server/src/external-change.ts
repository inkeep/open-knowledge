/**
 * Shared handler for applying external file changes to a live Y.Doc.
 *
 * Used by both server-factory.ts (CLI server) and hocuspocus-plugin.ts (Vite dev).
 * Extracted to prevent drift between copies — a bug fix in one would
 * otherwise easily miss the other.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  BridgeInvariantViolationError,
  BridgeMergeContentLossError,
  normalizeBridge,
  prependFrontmatter,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { formatReconcileSubject } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import { isDocInConflict } from './conflict-errors.ts';
import { recordContributor } from './contributor-tracker.ts';
import { recordFrontmatterEditSurface } from './frontmatter-telemetry.ts';
import { getLogger } from './logger.ts';
import {
  incrementExternalChangeHandlerErrors,
  incrementReconcileInFlightFallthroughs,
  incrementReconcileOwnFlushSkips,
} from './metrics.ts';
import {
  getReconciledBase,
  isWithinContentDir,
  peekInFlightFlush,
  safeContentPath,
  setReconciledBase,
} from './persistence.ts';
import { reconcile } from './reconciliation.ts';
import type { PairedWriteOrigin } from './server-observers.ts';
import { FILE_SYSTEM_WRITER } from './shadow-repo.ts';

/**
 * Transaction origin for file-watcher disk→CRDT bridge operations.
 *
 * Exported so the bridge-invariant watcher can include it in its
 * enforcing-origins Set by identity (not by string literal). Y.js transaction
 * matching uses `Set.has(tx.origin)` which is identity-based for objects;
 * a string literal `'file-watcher'` would never match this object.
 *
 * skipStoreHooks: true — prevents persistence from re-saving a file we just
 * loaded from disk (feedback loop prevention).
 *
 * paired: true — `applyExternalChange` atomically writes BOTH XmlFragment and
 * Y.Text inside one `doc.transact(..., FILE_WATCHER_ORIGIN)` block. Server
 * Observer A/B match via `context.paired === true` and short-circuit
 * symmetrically.
 */
export const FILE_WATCHER_ORIGIN = {
  source: 'local',
  skipStoreHooks: true,
  context: { origin: 'file-watcher', paired: true },
} as const satisfies PairedWriteOrigin;

/**
 * Apply file content to a live Y.Doc through the shared
 * `composeAndWriteRawBody` primitive. Pure CRDT update — no contributor
 * recording, no reconciledBase advance, no `Hocuspocus` lookup.
 *
 * Y.Text-is-truth contract: disk bytes land in Y.Text
 * verbatim. The fragment derives from `parse(body)` via the primitive.
 * No canonicalize-write-back step — markdown forms (e.g. doc-start `---`
 * thematic breaks) survive in Y.Text in the user's source bytes;
 * the bridge invariant tolerates any difference between raw bytes and
 * `serialize(fragment)` via `normalizeBridge`'s equivalence classes.
 *
 * Used both by the file-watcher path (`applyExternalChange`, which adds
 * contributor + reconciledBase side effects) and by the persistence
 * tripwire reset path (which must NOT advance attribution or the
 * reconciled base because no disk write happened).
 *
 * Atomicity boundary: caller MUST wrap this in
 * `document.transact(..., FILE_WATCHER_ORIGIN)` so paired-write origin
 * identity (precedent #24) reaches the observer guards. Calling transact
 * inside the function would either lose origin identity (nested transacts
 * pick the outer's) or fragment the atomicity contract for callers that
 * already wrap.
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

/**
 * Apply external file content to a live Y.Doc — the throwing core of the
 * disk→CRDT bridge. Both server-factory.ts (CLI) and the dev plugin delegate here.
 *
 * Under the Y.Text-is-truth contract (precedent #38):
 *   1. Looks up the live Y.Doc by docName (no-op if missing; system + config
 *      docs short-circuit)
 *   2. Captures the prior FM region from `Y.Text('source')` for the
 *      edit-surface telemetry counter (FM lives in the YAML region of
 *      Y.Text — no Y.Map metadata cache)
 *   3. Routes through `composeAndWriteRawBody` inside
 *      `document.transact(..., FILE_WATCHER_ORIGIN)`: Y.Text receives the
 *      disk bytes verbatim via `applyFastDiff`; XmlFragment derives via
 *      `parse(body) → updateYFragment` (the post-write watchdog asserts
 *      the bridge invariant)
 *   4. Emits the FM-change telemetry counter when the captured FM
 *      differs from the disk content's FM
 *   5. Records the file-system contributor and advances reconciledBase to
 *      the raw disk bytes
 *
 * `FILE_WATCHER_ORIGIN` carries `context.paired: true` and
 * `skipStoreHooks: true` — the paired marker opts the bridge observers'
 * paired-write fast-paths in; skipStoreHooks prevents persistence feedback
 * loops.
 *
 * Throws on parse failure — callers choose their own error strategy.
 * `BridgeInvariantViolationError` re-throws past every soft-recovery layer
 * so dev/test surfaces regressions loudly.
 */
export function applyExternalChange(
  hocuspocus: Hocuspocus,
  docName: string,
  content: string,
  resolveEmbed?: (basename: string, sourcePath: string) => string | null,
  resolveSize?: (basename: string, sourcePath: string) => number | null,
): void {
  if (isSystemDoc(docName) || isConfigDoc(docName)) return;
  const document = hocuspocus.documents.get(docName);
  if (!document) return;

  // Capture prior FM region from Y.Text so the edit_surface counter only
  // fires when disk content actually changed FM (body-only edits shouldn't
  // count). The YAML region of `Y.Text('source')` IS the FM source of
  // truth — read it before applyDiskContentToDoc applies the disk content.
  const priorFm = stripFrontmatter(document.getText('source').toString()).frontmatter;
  const { frontmatter: nextFm } = stripFrontmatter(content);

  // Caller wraps for atomicity + paired-write FILE_WATCHER_ORIGIN identity
  // (precedent #24). The transact moved out of applyDiskContentToDoc so the
  // per-surface origin reaches observer guards.
  try {
    document.transact(() => {
      applyDiskContentToDoc(document, content, resolveEmbed, docName, resolveSize);
    }, FILE_WATCHER_ORIGIN);
  } catch (err) {
    // Yjs transactions don't roll back on throw — `applyFastDiff` may have
    // succeeded fully or partially before `updateYFragment` threw inside
    // `composeAndWriteRawBody`, leaving Y.Text mutated but `reconciledBase`
    // still pointing at the prior content. Without this catch, the next
    // persistence flush would compare ytext (new/partial) against
    // reconciledBase (prior), see them differ, and write ytext bytes to
    // disk — typically idempotent (ytext === current disk), but under
    // back-to-back disk edits within the persistence debounce window this
    // could overwrite a newer disk version with the post-throw state.
    // Setting reconciledBase to whatever ytext now reflects bounds the
    // race: the next persistence-flush compare matches and skips the
    // write. Recovery converges via the next file-watcher event, Observer
    // B settlement, or user mutation. Re-throwing preserves the existing
    // outer error-handling contract (`createExternalChangeHandler`
    // increments the error counter and logs).
    setReconciledBase(docName, document.getText('source').toString());
    throw err;
  }

  if (priorFm !== nextFm) {
    recordFrontmatterEditSurface('file-watcher');
  }

  // Attribute this disk-originated write to the file-system classified writer.
  // FILE_WATCHER_ORIGIN has skipStoreHooks:true so persistence.ts:onStoreDocument
  // will not auto-record this origin. The explicit call here ensures the next L2
  // drain produces a commit on refs/wip/<branch>/file-system.
  recordContributor(
    docName,
    FILE_SYSTEM_WRITER.id,
    FILE_SYSTEM_WRITER.name,
    FILE_SYSTEM_WRITER.id,
    formatReconcileSubject(docName),
  );

  // Set the reconciled base so persistence does not re-serialize and re-write
  // the same content on next flush.
  setReconciledBase(docName, content);
}

/**
 * Create a handler function that wraps `applyExternalChange` with error-swallowing
 * semantics for the dev plugin consumer. Routine errors (parse failures, disk
 * I/O issues) are logged and swallowed so the file watcher continues running.
 *
 * Contract-gate errors (`BridgeInvariantViolationError`,
 * `BridgeMergeContentLossError`) are re-thrown — they signal a contract
 * violation in dev/test (gated affirmatively by NODE_ENV=test or the
 * `OK_BRIDGE_THROW_ON_VIOLATION` / `OK_RETHROW_BRIDGE_LOSS` env vars; see
 * bridge-watchdog.ts and server-observers.ts respectively). Swallowing those
 * here would silently subvert the test-mode loud-failure gates.
 */
export function createExternalChangeHandler(
  hocuspocus: Hocuspocus,
  resolveEmbed?: (basename: string, sourcePath: string) => string | null,
  resolveSize?: (basename: string, sourcePath: string) => number | null,
): (docName: string, content: string) => Promise<void> {
  return async (docName: string, content: string): Promise<void> => {
    try {
      applyExternalChange(hocuspocus, docName, content, resolveEmbed, resolveSize);
      getLogger('file-watcher').info({ docName }, 'applied external change');
    } catch (err) {
      if (
        err instanceof BridgeInvariantViolationError ||
        err instanceof BridgeMergeContentLossError
      ) {
        throw err;
      }
      // Increment the operator-visible counter so a non-zero value surfaces
      // when `parseWithFallback`'s paragraph fallback fails to catch
      // something. Without this, file-watcher swallow events have no
      // numerical signal — the only trace is a console.error easy to miss
      // at log-aggregation time. The next persistence flush would
      // overwrite the external edit with the unadvanced Y.Doc bytes, so the
      // failure mode is silent data-loss-on-disk-edit unless surfaced here.
      incrementExternalChangeHandlerErrors();
      console.error(`[file-watcher] Failed to apply external change for ${docName}:`, err);
    }
  };
}

/**
 * L1 reconcile-before-apply (the primary disk-authority fix). Before an MCP
 * agent content write applies its edit, ingest a divergent out-of-band disk
 * edit so the agent edits the live (disk-reflecting) doc instead of clobbering
 * a newer disk version with stale loaded CRDT state.
 *
 * Detection: compare the current on-disk bytes against `getReconciledBase`
 * (the last content this server synced to/from disk for the doc) using
 * `normalizeBridge` — the SAME comparator the store uses (persistence.ts
 * `markdownSemanticallyUnchanged`) and the L3 backstop uses, so the layers
 * never disagree on what counts as "diverged" (a split comparator would yield
 * a redundant double-ingest or a gap). On a genuine divergence the disk content
 * routes through the SAME three-way `reconcile()` the file-watcher 'update'
 * path uses — base = reconciledBase, ours = the live Y.Text (which may carry
 * collaborative edits persistence has not flushed yet), theirs = disk bytes —
 * so a concurrent un-flushed CRDT edit survives alongside the disk edit
 * instead of being wholesale-replaced:
 *
 *   - `clean` (no un-flushed edits): ingest disk as-is.
 *   - `merged`: ingest the merged content, then advance the reconciled base
 *     to the DISK bytes. The base must track what is actually on disk: the
 *     L3 store backstop compares disk against the base with the same
 *     comparator, so a base pointing at the (memory-only) merged content
 *     would abort the caller's forced flush as a phantom divergence — and
 *     the watcher's own queued event for the same disk write must reconcile
 *     to `noop` (theirs === base) rather than re-ingest.
 *   - `conflicts` / `refused`: ingest NOTHING and mark the doc's lifecycle
 *     conflict state, so the caller's mutating write is refused through the
 *     uniform `DocInConflictError` gate (agent-sessions.ts). The file
 *     watcher's own event for the same disk change owns conflict
 *     materialization per its existing semantics — pre-consuming it here
 *     would just add a second ingestion style.
 *
 * Ingests go through the sanctioned `applyExternalChange` (FILE_WATCHER_ORIGIN,
 * paired-write, `skipStoreHooks`): the ingest fires NO store, so the caller's
 * subsequent agent write is the single store that persists the combined
 * content — and the FILE_WATCHER_ORIGIN identity keeps the ingest out of the
 * agent's `UndoManager`. The caller then applies the agent edit on top in its
 * own `session.dc.document.transact(fn, session.origin)` — two sequential
 * transacts, never nested.
 *
 * Returns `reconciled: true` when an external edit was ingested (the caller
 * surfaces the `disk-edit-reconciled` success warning, discriminated by
 * `mergeOutcome`), `reconciled: false` otherwise.
 *
 * Scoped to content writes (write / edit / frontmatter); the
 * undo/rollback handlers are NOT callers — reconcile-rewriting the doc before
 * `Y.UndoManager.undo()` would invalidate the undo-stack items. Those rely on
 * the L3 store-time backstop instead.
 *
 * No-op (returns `false`) when: the doc is a system/config doc; the server has
 * no `reconciledBase` for it (a loaded doc always has one from
 * `onLoadDocument`, so an absent base is the not-yet-loaded edge — no baseline
 * to diverge from); the doc has no disk file yet (first write); the path
 * realpath-escapes the content dir (symlink-escape — refuse to read foreign
 * bytes into the CRDT, mirroring the persistence write-path guard); a read
 * fails transiently; or disk matches the base. Ingesting ONLY on genuine
 * divergence keeps `applyExternalChange`'s `FILE_SYSTEM_WRITER` attribution
 * honest — it fires exactly when disk really did change out of band.
 *
 * mtime-gating (perf nicety — skip the read when the file is unchanged) is
 * intentionally deferred: a markdown `readFileSync`
 * per agent write is negligible. Tracked as a conscious deferral.
 */
export interface ReconcileBeforeWriteResult {
  /** True when a divergent out-of-band disk edit was ingested before the agent edit. */
  reconciled: boolean;
  /** Byte length of the reconciled base the agent thought it was editing (pre-reconcile). */
  baseBytes: number;
  /** Byte length of the divergent on-disk content that was ingested (0 when not reconciled). */
  diskBytes: number;
  /**
   * How the divergence was folded in when `reconciled` is true: `clean`
   * (no concurrent un-flushed CRDT edits — disk ingested as-is) or `merged`
   * (three-way block merge preserved both sides). Absent when not reconciled.
   */
  mergeOutcome?: 'clean' | 'merged';
}

const NOT_RECONCILED: ReconcileBeforeWriteResult = {
  reconciled: false,
  baseBytes: 0,
  diskBytes: 0,
};

/**
 * Serialize a Y.Doc's source text into the canonical
 * `prependFrontmatter(fm, body)` shape every disk-vs-doc comparator uses.
 * Single definition shared with server-factory's `serializeDoc` so the two
 * sites cannot drift — the bridge invariant depends on them staying
 * byte-identical.
 */
export function serializeYDocSource(document: {
  getText(name: string): { toString(): string };
}): string {
  const ytextSnapshot = document.getText('source').toString();
  const { frontmatter, body } = stripFrontmatter(ytextSnapshot);
  return prependFrontmatter(frontmatter, body);
}

export function reconcileDiskBeforeAgentWrite(
  hocuspocus: Hocuspocus,
  docName: string,
  contentDir: string,
  resolveEmbed?: (basename: string, sourcePath: string) => string | null,
): ReconcileBeforeWriteResult {
  if (isSystemDoc(docName) || isConfigDoc(docName)) return NOT_RECONCILED;

  // Never reconcile a doc that's mid-conflict: disk carries merge markers, and
  // the mutating write is about to be refused with DocInConflictError. Ingesting
  // the marker content would corrupt the conflict state and (for edit)
  // make the find target vanish so the refusal turns into a spurious 404 instead
  // of the 409. The conflict resolver owns recovery; leave the loaded doc alone.
  const document = hocuspocus.documents.get(docName);
  if (document && isDocInConflict(document)) return NOT_RECONCILED;

  const base = getReconciledBase(docName);
  if (base === undefined) return NOT_RECONCILED;

  let canonical: string;
  try {
    const requestedPath = safeContentPath(docName, contentDir);
    if (!existsSync(requestedPath)) return NOT_RECONCILED;
    canonical = realpathSync(requestedPath);
  } catch {
    // Path resolution failed (ELOOP, transient lstat/realpath error) — leave
    // the CRDT untouched; the store path + file watcher converge later.
    return NOT_RECONCILED;
  }

  if (!isWithinContentDir(canonical, contentDir)) {
    getLogger('reconcile').warn(
      { docName, canonical, contentDir },
      `[reconcile] symlink-escape on disk read for ${docName}; skipping reconcile`,
    );
    return NOT_RECONCILED;
  }

  let diskContent: string;
  try {
    diskContent = readFileSync(canonical, 'utf-8');
  } catch (err) {
    // existsSync already confirmed the file above, so ENOENT here is the
    // benign exists→read TOCTOU race. Any other code (EACCES, EIO, EMFILE)
    // is pathological — surface it like the symlink-escape + L3 backstop
    // paths do rather than swallowing it silently.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      getLogger('reconcile').warn(
        { docName, canonical, code },
        `[reconcile] disk read failed for ${docName} (${code ?? 'unknown'}); skipping reconcile`,
      );
    }
    return NOT_RECONCILED;
  }

  if (normalizeBridge(diskContent) === normalizeBridge(base)) return NOT_RECONCILED;

  // Disk differing from the base does NOT imply a foreign edit: persistence's
  // disk commit is non-atomic — the rename lands before the flush continuation
  // advances the base — so inside that gap disk holds the server's OWN
  // just-flushed bytes against a stale base. When disk matches the in-flight
  // flush snapshot, skip reconcile entirely and do not touch the base: the
  // flush continuation is the single owner of the base advance and runs
  // moments later. A foreign byte sequence landing inside the window does not
  // match and still falls through to the three-way merge below.
  const inFlightFlush = peekInFlightFlush(docName);
  if (inFlightFlush !== undefined) {
    if (normalizeBridge(diskContent) === inFlightFlush) {
      incrementReconcileOwnFlushSkips();
      getLogger('reconcile').debug(
        { docName, diskBytes: diskContent.length },
        `[reconcile] disk matches own in-flight flush for ${docName}; skipping reconcile`,
      );
      return NOT_RECONCILED;
    }
    // Foreign bytes while our own flush is mid-commit: legitimate merge work,
    // but worth counting — sustained growth with no external editors present
    // means the own-write discrimination is mis-matching. Warn (not debug) so
    // a rising counter has a correlated, doc-identifying log to triage from.
    incrementReconcileInFlightFallthroughs();
    getLogger('reconcile').warn(
      { docName, diskBytes: diskContent.length },
      `[reconcile] in-flight flush present but disk differs from snapshot for ${docName}; falling through to merge`,
    );
  }

  // The doc is loaded by the time this runs (the caller opened its agent
  // session first, and an absent base already short-circuited above), but if
  // it is not, there are no un-flushed edits to protect and nothing to apply
  // the merge to — leave reconciliation to the load path.
  if (!document) return NOT_RECONCILED;

  // Genuine out-of-band divergence: route through the same three-way merge
  // the file-watcher 'update' path uses, with ours read from the live Y.Text
  // (raw user bytes, NOT serialize(fragment)) so un-flushed collaborative
  // edits participate.
  const ours = serializeYDocSource(document);

  const outcome = reconcile({ docName, base, ours, theirs: diskContent });
  getLogger('reconcile').info(
    { docName, result: outcome.kind, baseBytes: base.length, diskBytes: diskContent.length },
    `[reconcile] before-agent-write ${docName} result=${outcome.kind}`,
  );

  switch (outcome.kind) {
    case 'noop':
      return NOT_RECONCILED;

    case 'conflicts':
    case 'refused': {
      // Overlapping concurrent edits, marker-laden disk content, or an
      // over-budget merge: refuse to pick a winner. Marking the lifecycle
      // conflict here makes the caller's mutating write throw
      // `DocInConflictError` (the uniform write gate), preserving both the
      // un-flushed CRDT edit (in the live doc) and the disk edit (on disk).
      // No ingest and no base advance — the file-watcher's queued event for
      // this same disk change re-derives the conflict and owns its
      // materialization (ours-kept content + 'merged-with-markers', or the
      // 'conflict' event path for marker files).
      //
      // That clearing path only exists for genuinely FOREIGN disk content:
      // the watcher consumes own-write events via isSelfWrite, so a latch
      // set here for the server's own bytes would never clear (permanent
      // DocInConflictError wedge). This branch must therefore be
      // unreachable for own-flush content — guaranteed by the
      // peekInFlightFlush check above, whose signal is set before the
      // rename that creates the readable-new-bytes window and cleared only
      // after the base advances, covering every read inside the window.
      const lifecycleMap = document.getMap('lifecycle');
      lifecycleMap.set('status', 'conflict');
      lifecycleMap.set(
        'reason',
        outcome.kind === 'refused' ? outcome.reason : 'reconcile-conflicts',
      );
      return NOT_RECONCILED;
    }

    case 'clean':
    case 'merged': {
      // Ingest via the sanctioned path so the CRDT becomes current before the
      // agent edit lands on top. applyExternalChange wraps its own
      // FILE_WATCHER_ORIGIN transact and advances reconciledBase
      // synchronously.
      const ingest = outcome.kind === 'clean' ? diskContent : outcome.newContent;
      applyExternalChange(hocuspocus, docName, ingest, resolveEmbed);
      if (outcome.kind === 'merged') {
        // The base must track the DISK bytes, not the memory-only merged
        // content: the L3 store backstop and the watcher's queued event for
        // this same disk write both compare disk against the base, and the
        // caller's forced flush is what lands the merged content on disk.
        setReconciledBase(docName, diskContent);
      }
      // UTF-8 byte counts (Buffer.byteLength), matching the sibling
      // ContentDivergenceWarning's `*Bytes` semantics on the shared
      // WriteWarningSchema union — `string.length` (UTF-16 code units) would
      // diverge on multi-byte text.
      return {
        reconciled: true,
        baseBytes: Buffer.byteLength(base, 'utf8'),
        diskBytes: Buffer.byteLength(diskContent, 'utf8'),
        mergeOutcome: outcome.kind,
      };
    }
  }
}
