/**
 * Git auto-persistence pipeline.
 *
 * Layer 1 (CRDT → disk): onStoreDocument reads body bytes from
 * `Y.Text('source')` after the quiescence gate, runs a pre-write sanity
 * check via `assertBridgeInvariant` (site: 'persistence',
 * suppressDevThrow: true) against the canonical fragment view, queues a
 * fragment reconciliation on mismatch, then writes the ytext bytes
 * verbatim to disk via `tracedWriteFile`. Y.Text-is-truth (precedent
 * #38): fragment serialization is the comparator's RHS, not the
 * body-of-truth.
 * Layer 2 (disk → git): afterStoreDocument commits to shadow repo via git plumbing
 *
 * Hocuspocus config: debounce=2000, maxDebounce=10000 (L1)
 * Git commit debounced separately: 15s idle after last disk write (L2;
 * default, configurable via `commitDebounceMs`; exponential backoff up to
 * 32× under sustained git lock contention).
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { Extension } from '@hocuspocus/server';
import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import {
  BridgeInvariantViolationError,
  type ConfigValidationError,
  DOCUMENT_OPEN_BYTE_LIMIT,
  fnv1aDigest,
  formatFileSize,
  normalizeBridge,
  type Principal,
  prependFrontmatter,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import {
  composeCommitSubject,
  formatOkActor,
  formatWipSubject,
  type OkActorEntry,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type { JSONContent } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { LINEAGE_EPOCH_KEY } from './auth-token-schema.ts';
import type { BacklinkIndex } from './backlink-index.ts';
import { getMsSinceLastUserTx, isDocQuiescent } from './bridge-quiescence.ts';
import { assertBridgeInvariant, createDocCanonicalizer } from './bridge-watchdog.ts';
import { isConfigDoc, isManagedArtifactDoc, isSystemDoc } from './cc1-broadcast.ts';
import { type ConfigPersistenceCtx, loadConfigDoc, storeConfigDoc } from './config-persistence.ts';
import type { ContributorEntry } from './contributor-tracker.ts';
import {
  contributorCount,
  hasContributor,
  recordContributor,
  restoreContributorEntry,
  restoreContributors,
  swapContributors,
} from './contributor-tracker.ts';
import { getDocExtension } from './doc-extensions.ts';
import { applyDiskContentToDoc, FILE_WATCHER_ORIGIN } from './external-change.ts';
import { contentHash, registerWrite } from './file-watcher.ts';
import { tracedMkdir, tracedRename, tracedUnlinkSync, tracedWriteFile } from './fs-traced.ts';
import { getLogger } from './logger.ts';
import {
  loadManagedArtifactDoc,
  type ManagedArtifactCtx,
  managedArtifactContributorAttribution,
  storeManagedArtifactDoc,
} from './managed-artifact-persistence.ts';
import { mdManager, schema } from './md-manager.ts';
import {
  incrementDeferredStoreFailures,
  incrementGitAutoSaveFailure,
  incrementGitWriterCommitFailure,
  incrementPersistenceDiskWrite,
  incrementPersistenceForceFlushDuringBurst,
  incrementPersistenceReconciliationFailures,
  incrementPersistenceSanityCheckSerializeFailures,
  incrementPersistenceSkipNonQuiescent,
} from './metrics.ts';
import { isWithinDir, toPosix } from './path-utils.ts';
import { classifyDuplication } from './persistence-tripwire.ts';
import { backfillRenameLogCommitSha, getOrLoadRenameLogIndex } from './rename-log.ts';
import { OBSERVER_SYNC_ORIGIN } from './server-observers.ts';
import type { ShadowRef, WriterIdentity } from './shadow-repo.ts';
import {
  buildWipTree,
  commitWip,
  commitWipFromTree,
  FILE_SYSTEM_WRITER,
  GIT_UPSTREAM_WRITER,
  SERVICE_WRITER,
  shadowGit,
} from './shadow-repo.ts';
import { getMeter, setActiveSpanAttributes, withSpan } from './telemetry.ts';

const log = getLogger('persistence');

export class DocumentOpenSizeLimitError extends Error {
  readonly docName: string;
  readonly size: number;
  readonly limit: number;

  constructor(docName: string, size: number, limit = DOCUMENT_OPEN_BYTE_LIMIT) {
    super(
      `Document "${docName}" is ${formatFileSize(size)}; OpenKnowledge opens documents up to ${formatFileSize(limit)}.`,
    );
    this.name = 'DocumentOpenSizeLimitError';
    this.docName = docName;
    this.size = size;
    this.limit = limit;
  }
}

/**
 * Derive a WriterIdentity from a Hocuspocus transaction origin.
 *
 * Called from onStoreDocument to determine which writer triggered the store.
 * Handles the three origin shapes Hocuspocus surfaces:
 *   - local  + context.session_id  → per-session agent writer
 *   - local  + context.origin      → classified service writer
 *   - connection + principalId     → human-browser principal writer
 *
 * precedent #1 — origins are LocalTransactionOrigin object refs, not strings.
 * Exported for unit-testing the dispatch table without spinning up a server.
 */
export function resolveWriterFromOrigin(
  origin: unknown,
  getPrincipal?: () => Principal | null,
): WriterIdentity | null {
  if (!origin || typeof origin !== 'object') return null;
  const o = origin as Record<string, unknown>;

  if (o.source === 'local') {
    const ctx = o.context as Record<string, unknown> | undefined;
    if (!ctx) return null;

    // Per-session origin (agent write, agent undo) — session_id is the connectionId
    if (typeof ctx.session_id === 'string') {
      const sessionId = ctx.session_id;
      return {
        id: `agent-${sessionId}`,
        name: `Agent (${sessionId.slice(0, 8)})`,
        email: `agent-${sessionId}@openknowledge.local`,
      };
    }

    // Classified local origins by context.origin value
    if (ctx.origin === 'file-watcher') return FILE_SYSTEM_WRITER;
    if (ctx.origin === 'upstream-import' || ctx.origin === 'git-upstream') {
      return GIT_UPSTREAM_WRITER;
    }
    // park-snapshot, rollback-apply, managed-rename → service fallback
    return SERVICE_WRITER;
  }

  if (o.source === 'connection') {
    // Human browser write — principalId set via onAuthenticate.
    const conn = o.connection as Record<string, unknown> | undefined;
    const ctx = conn?.context as Record<string, unknown> | undefined;
    if (typeof ctx?.principalId === 'string') {
      const principalId = ctx.principalId as string;
      // When the claimed principalId matches the loaded principal record,
      // use the real display_name / display_email (e.g. git-config user.name)
      // so `ok-actor:` body + Co-Authored-By trailers mirror the user's git
      // identity. Fall back to a stub only when the server has no principal
      // loaded or the claim doesn't match.
      const loaded = getPrincipal?.();
      if (loaded && loaded.id === principalId && loaded.display_name && loaded.display_email) {
        return {
          id: loaded.id,
          name: loaded.display_name,
          email: loaded.display_email,
        };
      }
      return {
        id: principalId,
        name: 'Local User',
        email: `${principalId}@openknowledge.local`,
      };
    }
    return SERVICE_WRITER;
  }

  return null;
}

/**
 * Bounded-cardinality classes for `deferred-store-failed`.
 *
 * The deferred-drain catch in `flushDeferredStores` is the outermost
 * boundary; most errors that reach it are already-rethrown disk-write
 * failures from `storeDocumentNow`. The other bins exist because
 * forward-compat callers may re-route currently-swallowed inner errors
 * past their inner catch in the future — keeping the enum stable means
 * existing dashboards keep working when that happens. Operators index on
 * the bin labels, never on raw `errorMessageHash` values.
 */
const DEFERRED_STORE_ERROR_CLASSES = [
  'disk-write',
  'serialize',
  'reconcile',
  'parse-fallback',
  'traced-rename',
  'unknown',
] as const;
type DeferredStoreErrorClass = (typeof DEFERRED_STORE_ERROR_CLASSES)[number];

/**
 * NodeJS.ErrnoException codes the disk-write classifier treats as
 * filesystem-layer failures. Stable across Node versions; do not narrow
 * without checking the `tracedWriteFile` / `tracedRename` call sites in
 * `fs-traced.ts` for newly-surfaced codes.
 */
const ERRNO_FS_CODES = new Set([
  'EACCES',
  'EBADF',
  'EBUSY',
  'EEXIST',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EROFS',
  'ETXTBSY',
  'EXDEV',
]);

/**
 * Classify a deferred-store error into a bounded-cardinality bin for the
 * `deferred-store-failed` event. Inspects `err.code` (ErrnoException
 * contract) or simple string-startsWith on the message, and matches
 * `BridgeInvariantViolationError` via `instanceof` so a class rename surfaces
 * as a compile-time error at the import — intentionally NO stack inspection
 * (fragile across Node/Bun versions).
 *
 * Designed to never throw on its own input. The outer catch nevertheless
 * wraps the call in a try/catch so a malicious / unexpected error shape
 * (proxied properties, non-Error throw value with throwing getters) can't
 * break the structured-event emission path. That defensive outer wrap is
 * the observability boundary; treating its absence as "the classifier
 * never breaks" would re-introduce the silent-loss failure mode the
 * structured event is built to surface.
 */
export function classifyDeferredStoreError(err: unknown): DeferredStoreErrorClass {
  if (err === null || typeof err !== 'object') return 'unknown';
  const e = err as { code?: unknown; message?: unknown };
  const message = typeof e.message === 'string' ? e.message : '';
  if (message.startsWith('symlink-escape:')) return 'disk-write';
  if (typeof e.code === 'string' && ERRNO_FS_CODES.has(e.code)) {
    if (message.includes('rename')) return 'traced-rename';
    return 'disk-write';
  }
  if (err instanceof BridgeInvariantViolationError) return 'serialize';
  return 'unknown';
}

export interface PersistenceOptions {
  contentDir: string;
  projectDir: string;
  gitEnabled?: boolean;
  commitDebounceMs?: number;
  wipRef?: string;
  /** Shadow repo ref — read at commit time so deferred init propagates. */
  shadowRef?: ShadowRef;
  /** Content root relative to project dir (e.g., 'content/docs'). Used for shadow repo staging. */
  contentRoot?: string;
  backlinkIndex?: BacklinkIndex;
  /** Accessor for the current branch from the HEAD watcher. Used to scope WIP refs per branch. */
  getCurrentBranch?: () => string | null;
  /**
   * Resolves `![[photo.png]]` embed targets to disk-relative paths before PM
   * dispatch. Consumed by `onLoadDocument`'s `mdManager.parseWithFallback`
   * call so image-extension embeds materialize as PM `image` nodes with the
   * resolved `src` (not the literal target).
   */
  resolveEmbed?: (basename: string, sourcePath: string) => string | null;
  /**
   * Byte-size resolver for `![[file.ext]]` wikilinks whose extension is
   * in `FILE_ATTACHMENT_EXTENSIONS`. The wikiLinkEmbed handler stamps
   * the formatted size on the resulting jsxComponent's `size` prop so
   * File-row size spans survive reloads. Same `(target, sourcePath)`
   * signature as `resolveEmbed`. Server-side only.
   */
  resolveSize?: (basename: string, sourcePath: string) => number | null;
  /**
   * Accessor for the server's principal record. When a browser connection's
   * `ctx.principalId` matches `loadedPrincipal.id`, `resolveWriterFromOrigin`
   * emits WriterIdentity with the real display_name / display_email instead
   * of a "Local User" stub.
   */
  getPrincipal?: () => Principal | null;
  /**
   * Optional callback fired after each successful `commitWipFromTree` for an
   * agent writer (`writerId.startsWith('agent-')`). Used to emit CC1
   * `ch:'session-activity'` so Activity Panel clients get live invalidations.
   * Omitted in plugin mode where no CC1Broadcaster is available.
   */
  onAgentCommit?: () => void;
  /**
   * Optional callback fired after EVERY successful shadow flush-commit (any
   * writer, not just agents). The maintenance coordinator counts these and fires
   * a background gc every ~200. Must be cheap and non-throwing —
   * it runs on the write path; the coordinator does only a counter bump inline
   * and fires gc off-path. Omitted in plugin mode.
   */
  onFlushCommit?: () => void;
  /**
   * Optional callback fired after each successful L1 disk write
   * (post-`tracedRename`). The state vector is captured PRE-WRITE so
   * the watermark reflects exactly the doc state that landed on disk —
   * any updates received after capture but before the rename completes
   * are excluded by construction, matching the actual durable state.
   *
   * `persistedMarkdown` is the source bytes that just landed on disk;
   * `previousMarkdown` is the reconciled base before the write, or `null`
   * for first writes. Wired to `cc1Broadcaster.emitDiskAck(docName, sv)` in
   * boot, with optional derived-view invalidations for content-sensitive
   * sidebar rows.
   * Omitted in plugin mode where no CC1Broadcaster is available
   * — the closure shape is identical to `onAgentCommit`.
   */
  onDiskFlush?: (
    docName: string,
    sv: Uint8Array,
    persistedMarkdown: string,
    previousMarkdown: string | null,
  ) => void;
  applyDiskContentToDoc?: (document: Y.Doc, content: string) => void;
  /**
   * Override `os.homedir()` for config-doc persistence. Tests scope
   * user-global writes (`__user__/config.yml`) to a tempdir; if unset,
   * defaults to `os.homedir()` via `resolveConfigPath`.
   */
  configHomedirOverride?: string;
  /**
   * Fired after the L3 persistence-hook reverts an invalid Y.Text
   * mutation on a config doc. Wired in boot to
   * `cc1Broadcaster.emitConfigValidationRejected(docName, error)`
   * so any open Settings pane sees the rejection toast. Omitted in
   * plugin mode where no CC1Broadcaster is available.
   */
  onConfigRejected?: (docName: string, error: ConfigValidationError) => void;
  /**
   * Fired after the L3 persistence hook durably persists (or reconciles)
   * a config doc on the self-originated Y.Doc path. Wired in boot to
   * re-apply the now-durable config to the live in-process consumers (sync
   * engine, semantic search) directly — either the value this persist wrote
   * (`'persisted'`) or a winning external writer's value imported on reconcile
   * (`'reconciled'`) — so it reaches them even when the chokidar echo never
   * fires. Omitted in plugin mode.
   */
  onConfigPersisted?: (docName: string) => void;
  /**
   * MarkdownManager instance used by `storeDocumentNow`'s pre-write
   * sanity check (`fragmentBody = mgr.serialize(json)`). Defaults to
   * the production singleton from `./md-manager.ts`. Tests inject a
   * dedicated `new MarkdownManager({ extensions: sharedExtensions })`
   * with `spyOn(...).serialize` so divergent canonical bytes can be
   * exercised at this seam without touching the global singleton (and
   * without coupling the test contract to the function's stack frame).
   */
  mdManager?: MarkdownManager;
  /**
   * No-project ephemeral single-file mode (the `ok <file>` open). When `true`,
   * the `onStoreDocument` no-op gate ALSO suppresses a write whose normalized
   * content equals the CANONICAL serialization of the on-disk base
   * (`normalizeBridge(prependFrontmatter(fm, serialize(parse(diskBody))))`),
   * not just a byte-for-byte normalizeBridge match against the raw disk bytes.
   *
   * Rationale: a round-trip-unstable file (`## H\nP` → `## H\n\nP`,
   * the `ng-taxonomy` class) load-canonicalizes on open — the editor's
   * mount-init empty paragraph arrives as a `source:'connection'` transaction
   * indistinguishable from a keystroke, so an origin gate is unsound. Comparing
   * against the as-loaded canonical baseline suppresses the rewrite while still
   * persisting any genuine post-load edit. Derived on-the-fly from the
   * reconciled base (the raw disk bytes until the first real write), so it
   * tracks external edits too. Scoped to ephemeral mode — the global
   * persistence write-spine behavior is unchanged.
   */
  ephemeral?: boolean;
}

/**
 * Atomic snapshot of a Y.Doc's pre-write state for the L1 persistence path.
 *
 * Returned together because the disk-ack watermark contract depends on
 * the SV being captured at the SAME synchronous instant the JSON is
 * extracted: any update applied to the doc AFTER `json` is read but
 * BEFORE `tracedRename` resolves is — by construction — NOT in the
 * markdown that lands on disk. Including it in the watermark would
 * tell clients "the server has durably persisted this update" when the
 * server has not, causing them to drop the corresponding unsynced bytes
 * from the recycle buffer on the next instance-mismatch.
 *
 * Single-threaded JS guarantees this helper is uninterruptible:
 * `Y.encodeStateVector` and `yXmlFragmentToProseMirrorRootNode` both
 * run synchronously, so a Y.js transaction cannot interleave between
 * them. Returning both as a single value (rather than two separate
 * locals at the call site) makes that uninterruptible-co-capture
 * a structural property — a future refactor can't naturally split
 * the SV from the JSON across an `await` boundary without explicitly
 * undoing the destructure, which is loud at review time.
 */
export function captureDocSnapshotForPersistence(document: Y.Doc): {
  readonly sv: Uint8Array;
  readonly json: JSONContent;
} {
  return {
    sv: Y.encodeStateVector(document),
    json: yXmlFragmentToProseMirrorRootNode(document.getXmlFragment('default'), schema).toJSON(),
  };
}

export function safeContentPath(documentName: string, contentDir: string): string {
  if (documentName.includes('\x00')) {
    throw new Error(`Invalid document name: ${documentName}`);
  }
  const ext = getDocExtension(documentName);
  const filePath = resolve(contentDir, `${documentName}${ext}`);
  if (!isWithinDir(filePath, contentDir)) {
    throw new Error(`Invalid document name: ${documentName}`);
  }
  return filePath;
}

export function isWithinContentDir(p: string, contentDir: string): boolean {
  return isWithinDir(p, contentDir);
}

/**
 * Reconciled base: last known-good markdown for each document, scoped by branch.
 * Updated on load, store, and reconciliation. Used as the merge base
 * for three-way reconciliation.
 *
 * Outer key = branch name (e.g. "main", "feature/xyz", "detached-abc123def456")
 * Inner key = docName, value = last-synced markdown content
 */
const reconciledBaseByBranch = new Map<string, Map<string, string>>();

/** Active branch scope for reconciledBase lookups. Defaults to 'main'. */
let activeBranch = 'main';

/** Switch the active branch scope. Creates a fresh scope if first visit. */
export function switchReconciledBaseScope(branch: string): void {
  activeBranch = branch;
  if (!reconciledBaseByBranch.has(branch)) {
    reconciledBaseByBranch.set(branch, new Map());
  }
}

/** Get the active branch name for reconciledBase. */
export function getActiveBranch(): string {
  return activeBranch;
}

/** Get the reconciledBase value for a doc in the active branch scope. */
export function getReconciledBase(docName: string): string | undefined {
  return reconciledBaseByBranch.get(activeBranch)?.get(docName);
}

/** Set the reconciledBase value for a doc in the active branch scope. */
export function setReconciledBase(docName: string, content: string): void {
  if (!reconciledBaseByBranch.has(activeBranch)) {
    reconciledBaseByBranch.set(activeBranch, new Map());
  }
  reconciledBaseByBranch.get(activeBranch)?.set(docName, content);
}

/** Delete the reconciledBase entry for a doc in the active branch scope. */
export function deleteReconciledBase(docName: string): void {
  reconciledBaseByBranch.get(activeBranch)?.delete(docName);
}

/**
 * In-flight flush snapshots, keyed by docName, value = `normalizeBridge`d
 * markdown of the flush currently committing to disk. The disk commit in
 * `storeDocumentNow` is non-atomic w.r.t. concurrent readers: the rename
 * lands first, `setReconciledBase` runs later in the promise continuation.
 * A reader comparing disk against the base inside that gap sees the
 * server's OWN just-flushed bytes against a stale base — phantom foreign
 * divergence. This map is the producer-owned discriminator: set before the
 * commit's first await, cleared (only if still ours — overlapping flushes
 * for one doc overwrite the entry) after the base advances. On the L3
 * divergence-abort path the snapshot briefly advertises bytes that never
 * reached disk — benign: disk holds non-matching foreign content there, so
 * no false own-write match is possible; the .finally clears it.
 *
 * Not branch-scoped, unlike `reconciledBaseByBranch`: entries live for the
 * milliseconds of one disk commit. A cross-branch switch does not drain a
 * flush already mid-commit (onBatchEnd only defers NEW stores via
 * `isBatchInProgress` → `deferStore`), but a stale entry outliving the
 * switch only suppresses a reconcile when the NEW branch's disk bytes are
 * byte-identical to the old flush snapshot — identical content, where the
 * skip is a no-op and the next flush advances the base anyway.
 */
const inFlightFlushByDoc = new Map<string, string>();

/**
 * Read-only peek at the in-flight flush snapshot for a doc (normalized
 * markdown), or undefined when no flush is mid-commit. Consumers compare
 * `normalizeBridge(disk)` against it to recognize the server's own bytes;
 * they must never mutate the entry — persistence alone owns its lifecycle.
 */
export function peekInFlightFlush(docName: string): string | undefined {
  return inFlightFlushByDoc.get(docName);
}

/** Batch-in-progress flag — gates L1 writes and L2 commits during coordinated git operations. */
let batchInProgress = false;

export function setBatchInProgress(value: boolean): void {
  batchInProgress = value;
}

export function isBatchInProgress(): boolean {
  return batchInProgress;
}

/**
 * A disk-store failure captured out-of-band. `storeDocumentNow` records one
 * when its atomic write throws (ENOSPC / EDQUOT / EACCES / EROFS / read-only
 * FS, etc.) and rethrows — Hocuspocus's `storeDocumentHooks` then catches the
 * rethrow, logs "stays in memory to avoid data loss", and resolves WITHOUT
 * signaling the write that triggered the flush. A handler that force-flushes
 * the store (`executeNow`) and then calls `takeStoreFailure` is the only way to
 * learn the bytes never reached disk and report disk truth rather than a false
 * "Written successfully".
 */
export interface StoreFailure {
  /** Node errno code when available (e.g. `ENOSPC`, `EACCES`, `EROFS`). */
  code?: string;
  message: string;
}

/**
 * Extract a {@link StoreFailure} from a thrown value without touching it in a
 * way that can itself throw. Disk-write rejections are normally
 * `NodeJS.ErrnoException`, but a malicious / proxied error can carry throwing
 * `code` / `message` getters (the same shape `classifyDeferredStoreError`
 * guards against). Reading them unguarded inside the store catch would replace
 * the original error and defeat downstream classification, so each access is
 * isolated.
 */
function toStoreFailure(err: unknown): StoreFailure {
  let code: string | undefined;
  try {
    const c = (err as NodeJS.ErrnoException | null)?.code;
    if (typeof c === 'string') code = c;
  } catch {
    /* throwing getter — leave code undefined */
  }
  let message = 'unknown store error';
  try {
    message = err instanceof Error ? err.message : String(err);
  } catch {
    /* throwing getter / non-stringifiable — keep the default */
  }
  return { code, message };
}

export interface PersistenceHandle {
  extension: Extension;
  flushDeferredStores: (mode?: 'within-branch' | 'discard-stale') => Promise<void>;
  flushPendingGitCommit: () => Promise<void>;
  /**
   * Read-and-clear the last recorded disk-store failure for `documentName`,
   * or null if the most recent store reached disk.
   *
   * Precondition: call this ONLY immediately after force-flushing THIS doc's
   * `onStoreDocument` debounce (`debouncer.executeNow('onStoreDocument-<doc>')`).
   * The flush records the failure (or clears it on success) synchronously, so
   * the read reflects that store. Calling it without a preceding force-flush of
   * the same doc risks reading a stale cross-write residue.
   */
  takeStoreFailure: (documentName: string) => StoreFailure | null;
  /**
   * Read-and-clear whether `documentName`'s most recent agent-triggered store
   * was REVERTED by the L3 disk-divergence backstop — disk diverged
   * from the reconciled base, so the overwrite was aborted and disk won.
   *
   * Same precondition as {@link takeStoreFailure}: call ONLY immediately after
   * force-flushing THIS doc's `onStoreDocument` debounce. Mutually exclusive with
   * a store failure for the same flush (L3 returns before the atomic write).
   */
  takeStoreDivergence: (documentName: string) => boolean;
  /**
   * Mark `documentName`'s next store as agent-write-triggered (L3
   * gate). Call IMMEDIATELY before force-flushing this doc's `onStoreDocument`
   * debounce from an agent write handler. `storeDocumentNow` read-and-clears it;
   * only a marked store can disk-wins-revert on divergence, so human-editor
   * stores (which never route through a handler's force-flush) are excluded.
   */
  markAgentWriteStore: (documentName: string) => void;
  /**
   * Force a drain of the contributor map regardless of timer state. Used by
   * write surfaces that mutate `pendingContributors` outside any Y.Doc transact
   * lifecycle (renames are the canonical case — see `_performManagedRenameForDocs`).
   */
  flushContributors: () => Promise<void>;
  waitForPendingCommits: () => Promise<void>;
  /**
   * Config-doc persistence context. Exposed so the file-watcher
   * orchestration in `server-factory.ts` can call `applyExternalConfigChange`
   * with the same LKG cache + `onConfigRejected` callback the L3 hook uses.
   * Treat as read-only — direct mutation breaks the L3 invariant that the
   * cache only updates after a successful persist.
   */
  readonly configPersistenceCtx: ConfigPersistenceCtx;
  /**
   * Managed-artifact (skill/template) persistence context. Exposed so the
   * skills file-watcher in `server-factory.ts` can call
   * `applyExternalManagedArtifactChange` against the same LKG + reconciled-base
   * state the onLoad/onStore hooks use. Read-only — direct mutation breaks the
   * self-write short-circuit (the cache only updates after a successful persist
   * or a reconcile-from-disk).
   */
  readonly managedArtifactCtx: ManagedArtifactCtx;
}

export function createPersistenceExtension(options?: PersistenceOptions): PersistenceHandle {
  const contentDirRaw = options?.contentDir ?? process.cwd();
  let contentDir: string;
  try {
    contentDir = realpathSync(contentDirRaw);
  } catch {
    contentDir = contentDirRaw;
  }
  const projectDir = options?.projectDir ?? process.cwd();
  const shadowRef = options?.shadowRef;
  // `relative(a, a) === ''` (falsy), so workspaces with content.dir at the
  // project root must fall back to '.' — using the literal pathspec would
  // make `git add <fallback>` look for a non-existent subfolder.
  const contentRoot = options?.contentRoot ?? (toPosix(relative(projectDir, contentDir)) || '.');
  const backlinkIndex = options?.backlinkIndex;
  const getPrincipal = options?.getPrincipal;
  const onAgentCommit = options?.onAgentCommit;
  const onFlushCommit = options?.onFlushCommit;
  const onDiskFlush = options?.onDiskFlush;
  const onConfigPersisted = options?.onConfigPersisted;
  // Per-instance MarkdownManager seam used by `storeDocumentNow`'s pre-write
  // sanity check. Defaults to the production singleton. Tests inject a
  // dedicated `new MarkdownManager({ extensions: sharedExtensions })` so the
  // serialize spy targets only persistence's call site without needing a
  // stack-frame match on the function name.
  const mgr = options?.mdManager ?? mdManager;
  const ephemeral = options?.ephemeral ?? false;

  // Per-server-instance LKG cache for config docs (L3 validation). Maps
  // each well-known config doc name to the most recent successfully-
  // validated YAML string. Lives in the closure so multiple server
  // instances don't share mutable state.
  const configLkgCache = new Map<string, string>();
  const configPersistenceCtx: ConfigPersistenceCtx = {
    projectDir,
    contentDir,
    lkgCache: configLkgCache,
    homedirOverride: options?.configHomedirOverride,
    onConfigRejected: options?.onConfigRejected,
    ephemeral,
  };

  // Managed-artifact (skill/template) persistence ctx. Separate LKG cache from
  // config (distinct doc-name space). Reconciled-base accessors are injected
  // here (rather than imported by the module) to avoid a circular import.
  const managedArtifactLkgCache = new Map<string, string>();
  const managedArtifactCtx: ManagedArtifactCtx = {
    projectDir,
    homedirOverride: options?.configHomedirOverride,
    lkgCache: managedArtifactLkgCache,
    setReconciledBase,
    getReconciledBase,
  };

  // Frontmatter lives in the YAML region of `Y.Text('source')`:
  // `onStoreDocument` reads FM via `stripFrontmatter(ytext.toString())` and
  // writes Y.Text verbatim — no recompose step, no per-key cache, no L3 hook.
  const tripwireResetFailedDocs = new Set<string>();
  const applyDiskContent = options?.applyDiskContentToDoc ?? applyDiskContentToDoc;
  let pendingDeferredStoreFlushMode: 'within-branch' | 'discard-stale' | null = null;

  /**
   * Per-doc deferral count for the quiescence gate.
   *
   * Hocuspocus's debounce can fire `onStoreDocument` mid-burst when the
   * `maxDebounce` cap (10 s by default) elapses without any 2-second pause.
   * If `isDocQuiescent` returns false at that moment, the gate skips the
   * cycle and the next debounce retries — but if the user keeps typing,
   * unrestricted deferrals would leave material work undurable indefinitely.
   *
   * After `QUIESCENCE_MAX_DEFER` consecutive deferrals (~16 s of sustained
   * typing under default 2 s debounce), the gate force-flushes anyway. The
   * counter resets on every successful (or no-op) store cycle that completes
   * past the gate.
   *
   * Map key = `documentName`; values that hit zero are deleted to keep
   * the map lean across long sessions.
   */
  const QUIESCENCE_MAX_DEFER = 8;
  const persistenceDeferCounts = new Map<string, number>();

  // Last disk-store failure per docName. Set when `storeDocumentNow`'s atomic
  // write throws (before it rethrows for Hocuspocus to keep the doc in memory);
  // cleared on the next successful store and read-and-cleared via
  // `takeStoreFailure`. See `StoreFailure` for why this out-of-band channel is
  // necessary — Hocuspocus swallows the rethrow without signaling the caller.
  const storeFailures = new Map<string, StoreFailure>();

  // Docs whose most recent agent-triggered store was REVERTED by the L3
  // disk-divergence backstop instead of written: the store detected
  // that disk diverged from the reconciled base since L1's check (the residual
  // TOCTOU), aborted the overwrite, and ingested disk (disk-wins). The agent's
  // edit was discarded. Out-of-band like `storeFailures` because Hocuspocus's
  // store hook gives the triggering handler no return channel; the handler
  // force-flushes then read-clears via `takeStoreDivergence` and returns
  // `urn:ok:error:disk-divergence`. Mutually exclusive with `storeFailures` for
  // the same flush — L3 returns before the write, so no atomic-write throw can
  // also record a failure for that store.
  const storeDivergences = new Set<string>();

  // Docs whose pending store was forced by an agent write handler's awaited
  // flush (L3 gate). Set by `markAgentWriteStore` immediately before
  // the handler calls `executeNow`, consumed (deleted) at the top of
  // `storeDocumentNow`. This is the agent-triggered signal: Hocuspocus passes
  // `lastTransactionOrigin: null` for agent DirectConnection writes, so the
  // origin can't gate L3 — but the handler KNOWS it's an agent write. Human-
  // editor (browser) stores fire via the natural debounce and never route
  // through a handler's `executeNow`, so they never get marked → L3 never
  // disk-wins-reverts a human's in-progress typing.
  const agentWriteStores = new Set<string>();

  // reconciledBase and batchInProgress use the module-level systems
  // (reconciledBaseByBranch via get/setReconciledBase, and isBatchInProgress)
  // so that server-factory.ts and persistence stay in sync.

  const gitEnabled = options?.gitEnabled ?? true;
  const commitDebounceMs = options?.commitDebounceMs ?? 15_000;
  const wipRef = options?.wipRef ?? 'refs/wip/main';
  const getCurrentBranch = options?.getCurrentBranch;

  // Author resolved from contributor snapshot, not hardcoded.

  // Debounce git commits
  let gitCommitTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveGitFailures = 0;
  let commitInFlight: Promise<void> | null = null;
  let pendingAfterCommit = false;
  let deferredStoreDrainInFlight: Promise<void> | null = null;
  const deferredStores = new Map<
    string,
    {
      branch: string;
      document: Y.Doc;
      lastTransactionOrigin: unknown;
    }
  >();

  async function commitToWipRef(): Promise<void> {
    ensureHistograms();
    const started = Date.now();
    return withSpan('persistence.commitToWipRef', undefined, async () => {
      const result = await commitToWipRefInner();
      return result;
    }).finally(() => {
      commitDurationHist?.record((Date.now() - started) / 1000);
    });
  }

  async function commitToWipRefInner(): Promise<void> {
    // Read shadow ref at commit time (not construction time) so deferred init propagates
    const shadow = shadowRef?.current;
    if (shadow) {
      const snapshot = swapContributors(); // atomic drain — new writes go to fresh map
      const branch = getCurrentBranch?.() ?? 'main';

      if (snapshot.size === 0) {
        // No attributed contributors — fall back to single SERVICE_WRITER commit
        const serviceActorEntry: OkActorEntry = {
          v: 1,
          writer_id: SERVICE_WRITER.id,
          principal: null,
          agent_session: null,
          agent_type: null,
          client_name: null,
          client_version: null,
          label: null,
          display_name: SERVICE_WRITER.name,
          color_seed: SERVICE_WRITER.id,
          docs: [],
        };
        const serviceMessage = `${formatWipSubject([])}\n\n${formatOkActor(serviceActorEntry)}`;
        try {
          const sha = await commitWip(shadow, SERVICE_WRITER, contentRoot, serviceMessage, branch);
          consecutiveGitFailures = 0;
          log.info(
            { sha: sha.slice(0, 8), writer: SERVICE_WRITER.id },
            `[persistence] Shadow WIP commit: ${sha.slice(0, 8)} on refs/wip/${SERVICE_WRITER.id}`,
          );
          // Service-writer backfill fallback. Anonymous rename → log entry
          // attributed to `openknowledge-service` → empty contributor map →
          // service-writer commit closes the lazy-pop window for those
          // entries.
          try {
            backfillRenameLogCommitSha(
              shadow.gitDir,
              SERVICE_WRITER.id,
              sha,
              getOrLoadRenameLogIndex(shadow.gitDir),
            );
          } catch (err) {
            log.warn({ err }, '[rename-log] service-writer backfill failed');
          }
        } catch (e) {
          consecutiveGitFailures++;
          incrementGitAutoSaveFailure();
          log.error(
            { err: e, attempt: consecutiveGitFailures },
            `[persistence] Shadow commit failed (attempt ${consecutiveGitFailures})`,
          );
          if (consecutiveGitFailures >= 3) {
            log.error(
              { attempt: consecutiveGitFailures },
              '[persistence] CRITICAL: Git auto-save has failed 3+ times. Version history is NOT being recorded.',
            );
          }
        }
        return;
      }

      // Per-writer fan-out (precedent #25): build tree once, commit per writer.
      // All per-writer commits share the same tree SHA for this drain cycle.
      // Writer IDs follow the taxonomy in parseWriterId (shadow-repo-layout.ts): agent-<connId>,
      // principal-<UUID>, file-system, git-upstream, openknowledge-service.
      let treeSha: string;
      try {
        treeSha = await buildWipTree(shadow, contentRoot);
      } catch (e) {
        // Tree build failed — restore all contributors and abort this cycle
        restoreContributors(snapshot);
        consecutiveGitFailures++;
        incrementGitAutoSaveFailure();
        log.error(
          { err: e, attempt: consecutiveGitFailures },
          `[persistence] Shadow WIP tree build failed (attempt ${consecutiveGitFailures})`,
        );
        return;
      }

      let anySuccess = false;
      for (const [writerId, entry] of snapshot as Map<string, ContributorEntry>) {
        const writer: WriterIdentity = {
          id: writerId,
          name: entry.displayName,
          email: `${writerId}@openknowledge.local`,
        };
        const docs = [...entry.docs];
        // Consolidated write path: emit ONLY `ok-actor:` (retires the legacy
        // `ok-contributors:` body line). `writer_id` is now carried as a
        // first-class field so the commit body is self-describing without a
        // ref-name join. Reader side (`readContributors` in shadow-repo-layout)
        // prefers ok-actor and falls back to parseContributors for legacy
        // on-disk commits — both surfaces keep rendering without migration.
        const a = entry.actor;
        // Populate full actor tuple from ContributorEntry.actor when present.
        // Classified writers (file-system, git-upstream, openknowledge-service)
        // leave these null because they have no principal/agent attribution at
        // record time.
        const summaries = [...entry.summaries];
        const previousPaths = [...entry.previousPaths];
        const actorEntry: OkActorEntry = {
          v: 1,
          writer_id: writerId,
          principal: a?.principalId ?? null,
          agent_session: writerId.startsWith('agent-') ? writerId.slice(6) : null,
          agent_type: a?.agentType ?? null,
          client_name: a?.clientName ?? null,
          client_version: a?.clientVersion ?? null,
          label: a?.label ?? null,
          display_name: entry.displayName,
          color_seed: entry.colorSeed,
          docs,
          ...(summaries.length > 0 ? { summaries } : {}),
          ...(previousPaths.length > 0 ? { previous_paths: previousPaths } : {}),
        };
        const baseSubject = entry.subjectOverride ?? formatWipSubject(docs);
        // Project summaries onto the subject line too. Single-summary writes
        // embed the summary inline (`wip: notes.md — added auth`); multi-summary
        // drains get `(N edits)` + the bullets in the body. Zero summaries →
        // baseSubject unchanged.
        const subject = composeCommitSubject(baseSubject, summaries);
        const writerMessage = `${subject}\n\n${formatOkActor(actorEntry)}`;
        try {
          const sha = await commitWipFromTree(shadow, writer, treeSha, writerMessage, branch);
          anySuccess = true;
          // Count this flush-commit toward the coordinator's ~200-commit gc
          // trigger (cheap, off-path gc). Never let a maintenance-counter bump
          // break a write.
          try {
            onFlushCommit?.();
          } catch (err) {
            log.warn({ err }, '[persistence] onFlushCommit callback failed (non-fatal)');
          }
          log.info(
            { sha: sha.slice(0, 8), writer: writerId, tree: treeSha.slice(0, 8) },
            `[persistence] Shadow WIP commit: ${sha.slice(0, 8)} on refs/wip/${writerId}`,
          );
          // Lazy-population backfill. Commits that close the rename event's
          // window now anchor the rename log entries to a real shadow commit,
          // switching `expandPredecessors` from "skip" to "include" for those
          // entries.
          try {
            backfillRenameLogCommitSha(
              shadow.gitDir,
              writerId,
              sha,
              getOrLoadRenameLogIndex(shadow.gitDir),
            );
          } catch (err) {
            log.warn({ err }, '[rename-log] backfill failed; will retry next commit');
          }
          // Notify Activity Panel clients when an agent writer commits.
          if (writerId.startsWith('agent-')) {
            onAgentCommit?.();
          }
        } catch (e) {
          // Per-writer failure — restore this writer's entry, let others succeed.
          restoreContributorEntry(writerId, entry);
          incrementGitWriterCommitFailure();
          log.error(
            { err: e, writer: writerId },
            `[persistence] Per-writer shadow commit failed for ${writerId}`,
          );
        }
      }

      if (anySuccess) {
        consecutiveGitFailures = 0;
      } else {
        consecutiveGitFailures++;
        incrementGitAutoSaveFailure();
        if (consecutiveGitFailures >= 3) {
          log.error(
            { attempt: consecutiveGitFailures },
            '[persistence] CRITICAL: Git auto-save has failed 3+ times. Version history is NOT being recorded.',
          );
        }
      }
      return;
    }

    // Legacy path: commit to project repo (used when no shadow repo is configured)
    const sg = shadowGit({
      gitDir: resolve(projectDir, '.git'),
      workTree: projectDir,
    });
    const tmpIndex = resolve(projectDir, '.git/index-wip');
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      try {
        const headTree = (await sg.raw('rev-parse', 'HEAD^{tree}')).trim();
        await sg.env(env).raw('read-tree', headTree);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('unknown revision') || msg.includes('bad revision')) {
          log.info({}, '[persistence] Empty repo — starting with empty index');
        } else {
          log.error(
            { err: e },
            '[persistence] Failed to read HEAD tree, falling back to empty index',
          );
        }
      }

      await sg.env(env).raw('add', contentRoot);
      const treeSha = (await sg.env(env).raw('write-tree')).trim();

      let parentSha: string | null = null;
      try {
        parentSha = (await sg.raw('rev-parse', wipRef)).trim();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes('unknown revision') && !msg.includes('bad revision')) {
          throw e;
        }
      }

      const args = ['commit-tree', treeSha, '-m', `WIP auto-save ${new Date().toISOString()}`];
      if (parentSha) args.push('-p', parentSha);

      const commitSha = (await sg.raw(...args)).trim();
      await sg.raw('update-ref', wipRef, commitSha);
      consecutiveGitFailures = 0;
      log.info(
        { sha: commitSha.slice(0, 8), wipRef },
        `[persistence] Git commit: ${commitSha.slice(0, 8)} on ${wipRef}`,
      );
    } catch (e) {
      consecutiveGitFailures++;
      incrementGitAutoSaveFailure();
      log.error(
        { err: e, attempt: consecutiveGitFailures },
        `[persistence] Git commit failed (attempt ${consecutiveGitFailures})`,
      );
      if (consecutiveGitFailures >= 3) {
        log.error(
          { attempt: consecutiveGitFailures },
          '[persistence] CRITICAL: Git auto-save has failed 3+ times. Version history is NOT being recorded.',
        );
      }
    } finally {
      try {
        tracedUnlinkSync(tmpIndex);
      } catch {
        // ignore cleanup failure
      }
    }
  }

  /**
   * Exponential backoff delay for the next commit attempt.
   *
   * Happy path (0 failures): fires at `commitDebounceMs` exactly — matches
   * the pre-backoff behavior that tests + callers depend on.
   *
   * Under sustained git lock contention (N consecutive failures),
   * multiplies by `2^min(N, 5)` and adds 0–25% jitter. Cap at 5 doublings
   * ⇒ 32× base (e.g., 30s base → 16min ceiling). Jitter decorrelates
   * retry storms if multiple processes hit the same lock.
   */
  function computeCommitDelay(failures: number): number {
    if (failures <= 0) return commitDebounceMs;
    const exponent = Math.min(failures, 5);
    const multiplier = 2 ** exponent;
    const jitter = Math.random() * 0.25 * commitDebounceMs;
    return commitDebounceMs * multiplier + jitter;
  }

  function scheduleGitCommit(): void {
    if (!gitEnabled) return;
    if (isBatchInProgress()) return;
    if (gitCommitTimer) clearTimeout(gitCommitTimer);
    gitCommitTimer = setTimeout(() => {
      gitCommitTimer = null;
      if (commitInFlight) {
        pendingAfterCommit = true;
        return;
      }
      commitInFlight = commitToWipRef().finally(() => {
        commitInFlight = null;
        if (pendingAfterCommit) {
          pendingAfterCommit = false;
          scheduleGitCommit();
        }
      });
    }, computeCommitDelay(consecutiveGitFailures));
  }

  /** Flush pending L1 writes by forcing the Hocuspocus store cycle. */
  async function flushPendingGitCommit(): Promise<void> {
    if (gitCommitTimer) {
      clearTimeout(gitCommitTimer);
      gitCommitTimer = null;
      commitInFlight ||= commitToWipRef().finally(() => {
        commitInFlight = null;
        if (pendingAfterCommit) {
          pendingAfterCommit = false;
          scheduleGitCommit();
        }
      });
    }
    if (commitInFlight) await commitInFlight;
  }

  /** Await any in-flight git commit (for graceful shutdown). */
  async function _awaitPendingCommit(): Promise<void> {
    if (commitInFlight) await commitInFlight;
  }

  /**
   * Re-derive XmlFragment from `parse(ytext.body)` after the persistence
   * sanity check detected divergence. Under the Y.Text-is-truth contract
   * (precedent #38) Y.Text holds the user's intended source-form bytes;
   * fragment must catch up so future edits start from a consistent base.
   *
   * Synchronous: parse + structural diff + transact all run before the
   * caller's next statement. The work is bounded by doc size (parseWithFallback
   * is O(N), updateYFragment is O(N)), and the caller (storeDocumentNow)
   * already accepts that cost — the alternative (microtask deferral) would
   * leave fragment stale until the microtask drains, opening a window where
   * another transaction could merge against the stale fragment.
   *
   * The reconciliation transacts under `OBSERVER_SYNC_ORIGIN`. Both
   * Observer A and Observer B self-skip on this origin (their callbacks
   * read `transaction.origin === OBSERVER_SYNC_ORIGIN` and `return`),
   * so this nested transact does NOT cascade through the dispatch
   * settlement — it's an Observer-B-style write of the fragment side.
   * The OBSERVER_SYNC_ORIGIN's `skipStoreHooks: true` also prevents this
   * helper from re-triggering `onStoreDocument`, avoiding a feedback loop.
   *
   * The reconciliation is best-effort: a `parseWithFallback` failure (already
   * returns paragraph fallback rather than throwing) means fragment will
   * have the fallback content, which still preserves Observer A's baseline
   * tracking. Any throw deeper down logs but does not propagate — the disk
   * write that triggered this reconciliation is what matters for durability.
   */
  /**
   * The as-loaded canonical serialization of `rawBytes` — what the store would
   * have written if it serialized the parsed disk content. Used ONLY by the
   * ephemeral (single-file) no-op gate (G8): a round-trip-unstable file
   * (`## H\nP`) load-canonicalizes to a different byte sequence on open, so
   * comparing the store candidate against the raw disk bytes mis-fires and
   * rewrites the file; comparing against this canonical baseline suppresses
   * that rewrite while still letting genuine edits through. Mirrors the store
   * candidate's own `prependFrontmatter(fm, mgr.serialize(...))` path so the
   * two are directly comparable. Returns `null` on any parse/serialize throw —
   * the caller then falls through to the normal write (fail-open, never
   * suppress a real edit on a serialization error).
   */
  function canonicalizeForEphemeralBaseline(rawBytes: string, documentName: string): string | null {
    try {
      const { frontmatter, body } = stripFrontmatter(rawBytes);
      const parseOpts = options?.resolveEmbed
        ? {
            resolveEmbed: options.resolveEmbed,
            resolveSize: options?.resolveSize,
            sourcePath: documentName,
          }
        : undefined;
      // Parse AND serialize via `mgr` (the injected `options.mdManager`, or the
      // module singleton) so the baseline is computed with the same parser the
      // store candidate uses — parsing with the module `mdManager` while a
      // caller injected a different manager would mis-classify the G8 compare.
      const json = mgr.parseWithFallback(body, parseOpts);
      const canonicalBody = mgr.serialize(json);
      return normalizeBridge(prependFrontmatter(frontmatter, canonicalBody));
    } catch (err) {
      // Fail-open: never suppress a genuine edit on a serialization error. Debug
      // log so a doc shape that always throws here — and thus silently bypasses
      // the G8 no-rewrite gate, getting rewritten on every open — is
      // discoverable instead of leaving only unexplained disk writes.
      log.debug(
        { err, documentName },
        '[g8] ephemeral canonical baseline failed; falling through to write',
      );
      return null;
    }
  }

  function reconcileFragmentNow(document: Y.Doc, body: string, documentName: string): void {
    try {
      const xmlFragment = document.getXmlFragment('default');
      const parseOpts = options?.resolveEmbed
        ? {
            resolveEmbed: options.resolveEmbed,
            resolveSize: options?.resolveSize,
            sourcePath: documentName,
          }
        : undefined;
      const parsedJson = mdManager.parseWithFallback(body, parseOpts);
      const pmNode = schema.nodeFromJSON(parsedJson);
      document.transact(() => {
        const meta = { mapping: new Map(), isOMark: new Map() };
        updateYFragment(document, xmlFragment, pmNode, meta);
      }, OBSERVER_SYNC_ORIGIN);
    } catch (err) {
      // Reconciliation is best-effort. The watchdog already emitted; the
      // disk write proceeded. The next user mutation will route through
      // Observer A or B and converge fragment naturally.
      //
      // Counter surfaces "repair stuck" in operator dashboards without
      // requiring log correlation: a non-zero rate alongside
      // `bridgeInvariantViolations` means the divergence is being detected
      // but the queued repair keeps failing — distinct from "divergence is
      // detected and self-heals" (counter stays at 0).
      incrementPersistenceReconciliationFailures();
      log.warn(
        { err, documentName },
        `[persistence] reconcileFragmentNow failed for ${documentName}`,
      );
    }
  }

  // Lazy-init histograms; safe to call in every hook. Meter is a no-op when OTel
  // SDK is disabled, so allocations are essentially free.
  let loadDurationHist: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
  let storeDurationHist: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
  let commitDurationHist: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
  function ensureHistograms(): void {
    if (loadDurationHist) return;
    const meter = getMeter();
    loadDurationHist = meter.createHistogram('ok.persistence.load.duration', {
      description: 'Duration of persistence.onLoadDocument in seconds',
      unit: 's',
    });
    storeDurationHist = meter.createHistogram('ok.persistence.store.duration', {
      description: 'Duration of persistence.onStoreDocument in seconds',
      unit: 's',
    });
    commitDurationHist = meter.createHistogram('ok.persistence.git_commit.duration', {
      description: 'Duration of commitToWipRef drain in seconds',
      unit: 's',
    });
  }

  async function storeDocumentNow({
    document,
    documentName,
    lastTransactionOrigin,
  }: {
    document: Y.Doc;
    documentName: string;
    lastTransactionOrigin: unknown;
  }): Promise<void> {
    ensureHistograms();
    const started = Date.now();
    // Hoisted so the .finally below can clear the in-flight flush signal
    // after the commit settles (success, L3 abort, or throw alike).
    let inFlightFlushValue: string | undefined;
    return withSpan(
      'persistence.onStoreDocument',
      { attributes: { 'doc.name': documentName } },
      async () => {
        // Consume the L3 agent-write marker for this invocation: was this
        // store forced by an agent write handler's awaited flush? Read-and-clear
        // here so it can't leak to a later human-editor store of the same doc
        // (e.g. if this store no-ops at the unchanged-base skip below).
        const agentTriggeredStore = agentWriteStores.delete(documentName);

        // Lifecycle guard: when the file watcher saw an external delete or
        // rename, the disk-event handler in standalone.ts sets the doc's
        // lifecycle status to mark the Y.Doc as no-longer-tracking-disk.
        // But `unloadDocument` does NOT cancel debounced stores already
        // queued from prior transactions — and any in-flight rewrite that
        // mutated the Y.Doc just before the rm/mv leaves a pending store.
        // Without this short-circuit, that store fires, serializes the
        // in-memory state, and writes it via `tracedWriteFileSync` —
        // recreating the file at the OLD path. The CRDT-ghost behavior
        // the agent sees ("rm couldn't kill them, the CRDT kept
        // resurrecting them on disk") is exactly this race.
        //
        // Statuses guarded:
        //   - 'deleted-upstream': file removed externally; Y.Doc must
        //     not write to the now-empty path.
        //   - 'renamed': file moved externally; the old docName must
        //     not get rewritten — the new docName has its own Y.Doc.
        //   - 'conflict': disk has merge markers from an upstream merge;
        //     flushing Y.Text would overwrite the stages on disk, breaking
        //     subsequent `git checkout --theirs/--ours` and the conflict
        //     resolver UI's three-pane diff. User edits accumulated during
        //     the conflict window stay in Y.Text; on resolution the
        //     case 'update' reconcile in server-factory.ts runs against
        //     them as `ours`.
        const lifecycleStatus = document.getMap('lifecycle').get('status');
        if (
          lifecycleStatus === 'deleted-upstream' ||
          lifecycleStatus === 'renamed' ||
          lifecycleStatus === 'conflict'
        ) {
          log.info(
            { documentName, lifecycleStatus },
            `[persistence] Skipped store for ${documentName}: lifecycle=${lifecycleStatus}`,
          );
          // Lifecycle short-circuits don't reflect transient quiescence
          // state — drop the deferral counter so the next legitimate store
          // for this docName starts from a clean slate. Also clear any
          // tripwire-breaker entry so the entry doesn't persist for the
          // process lifetime when a sticky tripwire-failure doc gets
          // unloaded/renamed/deleted (covers the typical lifecycle path
          // where one final persistence fire follows the lifecycle change).
          persistenceDeferCounts.delete(documentName);
          tripwireResetFailedDocs.delete(documentName);
          return;
        }

        // Quiescence gate. Hocuspocus's `maxDebounce` can fire this hook
        // mid-burst before `afterAllTransactions` has settled the user's
        // last transaction. Under Y.Text-is-truth (precedent #38), the bytes
        // we're about to read may still be transient. Skip this cycle and
        // let the debounce retry — bounded by `QUIESCENCE_MAX_DEFER` so
        // sustained typing can't leave material work undurable. Synthetic
        // config / system docs already short-circuited above, so we know
        // this is a real markdown doc.
        const quiescent = isDocQuiescent(document);
        if (!quiescent) {
          const deferCount = persistenceDeferCounts.get(documentName) ?? 0;
          if (deferCount < QUIESCENCE_MAX_DEFER) {
            const ageMs = getMsSinceLastUserTx(document);
            console.warn(
              JSON.stringify({
                event: 'persistence-skip-non-quiescent',
                'doc.name': documentName,
                wallClockMsSinceLastTransaction: ageMs ?? null,
                deferCount,
              }),
            );
            incrementPersistenceSkipNonQuiescent();
            persistenceDeferCounts.set(documentName, deferCount + 1);
            return;
          }
          // Force-flush: defer cap hit. Bound staleness — the bridge
          // invariant sanity check below + `reconcileFragmentNow` on
          // mismatch ensure fragment converges on the next settlement.
          // `wallClockMsSinceLastTransaction` mirrors the skip event and is
          // primary diagnostic at force-flush time: knowing the typing burst
          // duration (e.g., 16s vs 80s vs 5min) is what operators reach for
          // first during triage. Without it, triage requires correlating with
          // the preceding skip events, which may have rotated out of the log
          // window.
          console.warn(
            JSON.stringify({
              event: 'persistence-force-flush-during-burst',
              'doc.name': documentName,
              wallClockMsSinceLastTransaction: getMsSinceLastUserTx(document) ?? null,
              deferCount,
            }),
          );
          incrementPersistenceForceFlushDuringBurst();
        }

        // Atomic pre-write snapshot — `sv` MUST be captured at the same
        // synchronous instant as `ytextSnapshot`. See
        // `captureDocSnapshotForPersistence` for the timing contract;
        // splitting the destructure across the upcoming `await` boundary
        // would silently break the disk-ack watermark.
        //
        // Under the Y.Text-is-truth contract (precedent #38), `json` is no
        // longer the body source — but we still capture it so the pre-write
        // sanity check can compare ytext bytes against the canonical
        // fragment view.
        const { sv: stateVectorAtRead, json } = captureDocSnapshotForPersistence(document);
        const ytextSnapshot = document.getText('source').toString();

        // Y.Text holds the user's intended source-form bytes. The markdown
        // that lands on disk is exactly those bytes (FM included), not
        // `mdManager.serialize(fragment)`. The right-hand side of the
        // bridge invariant — `serialize(fragment)` — is computed below as a
        // sanity check; on mismatch we still write ytext bytes (Y.Text is
        // truth) and queue a fragment reconciliation for the next settlement.
        const { frontmatter, body } = stripFrontmatter(ytextSnapshot);
        const markdown = prependFrontmatter(frontmatter, body);

        // Pre-write sanity check. Under steady-state contract, the bridge
        // invariant holds (modulo `normalizeBridge` tolerance). When it
        // doesn't, Y.Text wins by definition — the divergence means
        // fragment is out-of-sync and gets re-derived on the next
        // settlement. We DO NOT skip the write; data-loss-via-skip-cascade
        // is structurally avoided.
        //
        // Routing through `assertBridgeInvariant` (rather than open-coding
        // the emission) gives this site the same rate-limiting per (site,
        // doc) tuple, the same suppressed-counter accounting (so the
        // documented metric identity
        // `actual_rate = violations + suppressed` holds), and the same
        // tolerance-class-applied event emissions when bytes differ pre-
        // normalization but pass via the comparator. The watchdog's site
        // union already includes 'persistence' for exactly this purpose.
        //
        // `suppressDevThrow: true` honors the persistence contract: log
        // telemetry, write Y.Text bytes anyway, queue fragment-
        // reconciliation. Persistence MUST always proceed to disk,
        // including under NODE_ENV=test where Observer B's primary watchdog
        // DOES throw. Recovery paths (provider-pool reconnect, mid-rescue
        // persistence fires) exercise transient divergence that resolves on
        // the next settlement — throwing would block the rescue.
        //
        // `mgr.serialize(json)` itself can throw — its body wraps
        // `schema.nodeFromJSON(json)` and re-throws schema-rejection errors
        // (malformed remote-peer CRDT update, schema drift across versions,
        // exotic Y.XmlElement types). An unguarded throw here would bypass
        // the disk write below and leave Y.Text bytes undurable — the exact
        // data-loss-via-skip-cascade the contract prevents. Treat any
        // serialize failure as definite divergence, queue fragment
        // reconciliation, and proceed to write Y.Text bytes verbatim.
        let normalizeEqual: boolean;
        try {
          const fragmentBody = mgr.serialize(json);
          const fragmentMarkdown = prependFrontmatter(frontmatter, fragmentBody);
          normalizeEqual = assertBridgeInvariant(markdown, fragmentMarkdown, {
            site: 'persistence',
            docName: documentName,
            suppressDevThrow: true,
            // Parse-equivalence fallback: a doc resting on a serializer
            // canonicalization (CommonMark lazy continuations et al.) is
            // NOT a divergence — without this, every persist of such a doc
            // would warn AND run the synchronous reconcileFragmentNow below
            // for a fragment that already equals parse(ytext). Same `mgr` +
            // parse surface as the fragment derivation, by construction.
            canonicalizeBody: createDocCanonicalizer(mgr, {
              resolveEmbed: options?.resolveEmbed,
              resolveSize: options?.resolveSize,
              docName: documentName,
            }),
          });
        } catch (err) {
          // Counter + structured event give the serialize-throw failure
          // class its own operator-visible signal — distinct from
          // `bridgeInvariantViolations` (assertion ran and detected
          // divergence) and `persistenceReconciliationFailures` (queued
          // repair failed). Without this, a sustained schema-rejection
          // pattern produces only freeform log lines and zero counter
          // signal in the success-recovery case (reconcile succeeds);
          // the regression class would only surface via log-text search.
          incrementPersistenceSanityCheckSerializeFailures();
          console.warn(
            JSON.stringify({
              event: 'persistence-sanity-check-serialize-failed',
              'doc.name': documentName,
              'error.type': err instanceof Error ? err.constructor.name : typeof err,
              timestamp: new Date().toISOString(),
            }),
          );
          log.warn(
            { err, documentName },
            `[persistence] Sanity-check serialize failed for ${documentName}; proceeding with ytext bytes`,
          );
          normalizeEqual = false;
        }
        if (!normalizeEqual) {
          // Watchdog already emitted the rate-limited telemetry +
          // incremented `bridgeInvariantViolations` (or its suppressed
          // counterpart) — or, when serialize itself threw, the warn above
          // is the single signal. Reconcile the fragment synchronously so
          // it converges to ytext before the disk write below proceeds with
          // ytext bytes (Y.Text is the contract's source-of-truth per
          // precedent #38).
          reconcileFragmentNow(document, body, documentName);
        }

        // Skip the write when the serialized output matches the load-time
        // baseline. Hocuspocus fires onStoreDocument after any Y.Doc mutation,
        // including the first-pass observer sync that populates Y.Text from the
        // freshly-loaded XmlFragment — that mutation is semantically a no-op
        // but would otherwise rewrite the file in normalized form (padded
        // tables, added backslash-escapes, etc.), polluting the user's git
        // working tree on mere file open.
        //
        // normalizeBridge-tolerant compare: y-prosemirror's ySyncPlugin appends
        // an empty <paragraph> to Y.XmlFragment on every editor mount. That
        // serializes to extra trailing newlines — byte-unequal to currentBase
        // but semantically identical. Reusing normalizeBridge (the canonical
        // bridge-invariant normalization — trim per-line whitespace, collapse
        // 3+ newlines to 2, strip trailing newlines) keeps comparison semantics
        // consistent with server-observers.ts + the test-harness. Catching this
        // class as a no-op skips both the disk write AND the principal
        // safety-net below, preventing phantom commits attributed to the
        // browser's principal when a later agent write triggers the L2 fan-out.
        const currentBase = getReconciledBase(documentName);
        const normalizedMarkdown = normalizeBridge(markdown);
        let markdownSemanticallyUnchanged =
          currentBase !== undefined && normalizedMarkdown === normalizeBridge(currentBase);
        // G8 (ephemeral single-file mode only): also treat the candidate as a
        // no-op when it equals the CANONICAL serialization of the on-disk base.
        // A round-trip-unstable file (`## H\nP`) load-canonicalizes on open —
        // the editor's mount-init empty paragraph arrives as a connection-origin
        // transaction indistinguishable from a keystroke (so an origin gate is
        // unsound) — and the raw-bytes compare above misses it. Comparing
        // against the as-loaded canonical baseline suppresses that file-open
        // rewrite while still persisting genuine edits. The global write-spine
        // (non-ephemeral) keeps today's raw-bytes-only behavior exactly.
        if (!markdownSemanticallyUnchanged && ephemeral && currentBase !== undefined) {
          const canonicalBase = canonicalizeForEphemeralBaseline(currentBase, documentName);
          if (canonicalBase !== null && normalizedMarkdown === canonicalBase) {
            markdownSemanticallyUnchanged = true;
          }
        }
        if (markdownSemanticallyUnchanged) {
          if (contributorCount() > 0) scheduleGitCommit();
          // Cycle reached steady state — clear deferCount so future bursts
          // start from a clean slate.
          persistenceDeferCounts.delete(documentName);
          return;
        }

        // Phantom-doc guard: refuse to materialize a 0-byte file when the
        // Y.Doc was never confirmed to exist on disk (no reconciled base
        // from a successful onLoadDocument) AND the serialized content is
        // empty. This blocks accidental orphan files from any code path
        // that opens a Y.Doc for a non-existent docName: the browser race
        // during a rename, GETs to `/api/document?docName=<missing>`, MCP
        // queries on deleted docs, and any future caller of
        // `openDirectConnection` that hits a missing path.
        //
        // Legitimate first-write flows are unaffected:
        //   - `/api/create-page` writes the file synchronously before any
        //     transaction, so the next onLoadDocument sets reconciledBase
        //     to '' (defined) before this guard fires.
        //   - `/api/agent-write-md` populates the XmlFragment with the
        //     agent's content INSIDE the same transact that triggers the
        //     debounced store, so by the time we get here `markdown` is
        //     non-empty even when reconciledBase is still undefined.
        //
        // Mode-coupling note: the guard is asymmetric. It only blocks
        // file *creation*. Once a file exists and reconciledBase is set,
        // subsequent stores fall through to the normal write path,
        // including legitimate transitions to empty content (user clears
        // a doc) — those compare against the non-empty base above and
        // proceed.
        if (currentBase === undefined && normalizeBridge(markdown) === '') {
          log.warn(
            { documentName },
            `[persistence] Skipped phantom write for ${documentName}: empty Y.Doc with no reconciled base`,
          );
          persistenceDeferCounts.delete(documentName);
          return;
        }

        // Thread origin → contributor tracker. Safety-net for writes that
        // bypass api-extension.ts handlers. Agent write handlers already
        // call recordContributor explicitly; this handles human-browser
        // connection writes and any other origin that doesn't go through a
        // handler. Gated on `markdown !== currentBase` above — semantic
        // no-op writes (y-prosemirror empty-paragraph init) do not record
        // the principal, so the L2 fan-out no longer attributes phantom
        // commits to the browser alongside a legitimate agent write.
        const writer = resolveWriterFromOrigin(lastTransactionOrigin, getPrincipal);
        if (writer && writer.id !== SERVICE_WRITER.id) {
          // api-extension handlers register rich WriterIdentity BEFORE the Y.Doc
          // transact fires; onStoreDocument runs on Hocuspocus's 2s debounce, so
          // the handler-path entry is in the tracker by the time we get here.
          // The safety-net only fills in for writes that never pass through an
          // /api/* handler — specifically browser-principal writes via the
          // `source: 'connection'` origin path. Skipping when the entry already
          // exists guarantees the stub `Agent (<short>)` displayName can never
          // overwrite the handler's rich identity under any ordering edge case.
          if (!hasContributor(writer.id)) {
            recordContributor(documentName, writer.id, writer.name, writer.id);
          }
          // else: entry exists with rich handler-path identity; keep it untouched.
          // The docs Set is still correct because the handler path recorded this
          // docName already when it fired recordContributor for this write.
        }

        // Structural-duplication tripwire. Refuses to overwrite the disk
        // file when the candidate body is an integer concatenation (k≥2) of
        // the bridge-normalized base body — the failure shape the stale
        // browser-IDB merge causes. Resets the live Y.Doc to the disk
        // canonical state so the in-memory duplicate doesn't keep
        // re-triggering this hook on its 2s debounce. First writes (no
        // currentBase) bypass — there's nothing to duplicate yet.
        if (currentBase !== undefined) {
          const classification = classifyDuplication(markdown, currentBase);
          if (classification.kind === 'block') {
            if (tripwireResetFailedDocs.has(documentName)) {
              log.warn(
                { documentName },
                `[persistence] Tripwire breaker active — skipping duplicate store for ${documentName}`,
              );
              return;
            }
            const fragmentChildren = document.getXmlFragment('default').length;
            console.warn(
              JSON.stringify({
                event: 'ok-persistence-duplication-blocked',
                'doc.name': documentName,
                candidateBytes: markdown.length,
                baseBytes: currentBase.length,
                fragmentChildren,
                copies: classification.copies,
                reason: classification.reason,
              }),
            );
            try {
              const requestedDiskPath = safeContentPath(documentName, contentDir);
              // Realpath-gate the read to match the symlink-escape protection
              // applied by the write path (below) and `onLoadDocument` (above).
              // `safeContentPath` is a lexical containment check only; without
              // realpath here, a symlink at `<contentDir>/<docName>.md`
              // pointing outside the content root would be followed by
              // `readFileSync`, leaking the target's bytes into the live
              // Y.Doc (and from there to every connected CRDT client) on
              // the next duplication-tripwire fire. When realpath fails or
              // escapes, fall back to the in-memory `currentBase` — the
              // bridge-base we already trust.
              let diskContent: string;
              if (existsSync(requestedDiskPath)) {
                let canonical: string | null = null;
                try {
                  canonical = realpathSync(requestedDiskPath);
                } catch (realpathErr) {
                  log.warn(
                    { err: realpathErr, documentName },
                    `[persistence] Tripwire reset realpath failed for ${documentName}; using currentBase`,
                  );
                }
                if (canonical && isWithinContentDir(canonical, contentDir)) {
                  // Read failure (transient EMFILE / EIO / EISDIR / etc.) must
                  // not latch the per-doc tripwire breaker, since the realpath
                  // gate has already cleared the symlink-escape concern. Fall
                  // back to in-memory `currentBase` and let the success path
                  // clear the breaker; the next persistence fire will retry.
                  try {
                    diskContent = readFileSync(canonical, 'utf-8');
                  } catch (readErr) {
                    log.warn(
                      { err: readErr, documentName, canonical },
                      `[persistence] Tripwire reset readFileSync failed for ${documentName}; using currentBase`,
                    );
                    diskContent = currentBase;
                  }
                } else {
                  if (canonical) {
                    console.warn(
                      `[persistence] symlink-escape on tripwire reset: ${requestedDiskPath} → ${canonical}, using currentBase`,
                      {
                        docName: documentName,
                        originalPath: requestedDiskPath,
                        canonical,
                        contentDir,
                      },
                    );
                  }
                  diskContent = currentBase;
                }
              } else {
                diskContent = currentBase;
              }
              // Caller wraps for atomicity + paired-write origin identity
              // (precedent #24).
              document.transact(() => {
                applyDiskContent(document, diskContent);
              }, FILE_WATCHER_ORIGIN);
              tripwireResetFailedDocs.delete(documentName);
            } catch (err) {
              tripwireResetFailedDocs.add(documentName);
              log.error(
                { err, documentName },
                `[persistence] Tripwire reset failed for ${documentName}`,
              );
            }
            persistenceDeferCounts.delete(documentName);
            return;
          }
        }

        // Mark this doc's flush as in flight before the commit sequence's
        // first await. The rename below lands on disk before
        // `setReconciledBase` advances the base, so a concurrent
        // reconcileDiskBeforeAgentWrite reading disk inside that gap would
        // see our own bytes against a stale base and misclassify them as
        // foreign divergence. `peekInFlightFlush` lets that guard recognize
        // the bytes as ours. Cleared in the .finally on the outer promise
        // (after the base advance), only if the entry is still ours.
        // Setting before (not after) the L3 divergence backstop means an L3
        // abort leaves the snapshot advertising bytes that never reached
        // disk until the .finally clears it — benign residue: disk then
        // holds non-matching foreign content, so the snapshot can't produce
        // a false own-write match. The early set keeps the signal's
        // lifecycle synchronous from the hook's entry, which the overlap
        // test relies on to deterministically pin clear-only-if-still-ours.
        inFlightFlushValue = normalizeBridge(markdown);
        inFlightFlushByDoc.set(documentName, inFlightFlushValue);

        const requestedPath = safeContentPath(documentName, contentDir);
        await tracedMkdir(dirname(requestedPath), { recursive: true });

        let canonicalPath: string;
        try {
          canonicalPath = await realpath(requestedPath);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            let isBrokenSymlink = false;
            try {
              isBrokenSymlink = lstatSync(requestedPath).isSymbolicLink();
            } catch (lstatErr) {
              if ((lstatErr as NodeJS.ErrnoException).code !== 'ENOENT') {
                log.warn(
                  { err: lstatErr, path: requestedPath },
                  '[persistence] lstat failed during broken-symlink check',
                );
              }
            }
            if (isBrokenSymlink) {
              console.warn(`[persistence] broken-symlink fallback`, {
                docName: documentName,
                reason: 'broken-symlink',
              });
            }
            canonicalPath = requestedPath;
          } else if (code === 'ELOOP') {
            console.error(`[persistence] Symlink cycle at ${requestedPath}`);
            throw new Error(`Symlink cycle detected at ${requestedPath}`);
          } else {
            throw e;
          }
        }

        if (!isWithinContentDir(canonicalPath, contentDir)) {
          const msg = `symlink-escape: ${requestedPath} resolves to ${canonicalPath} outside ${contentDir}`;
          console.error(`[persistence] ${msg}`, {
            docName: documentName,
            originalPath: requestedPath,
            canonical: canonicalPath,
            contentDir,
          });
          throw new Error(msg);
        }

        // Test-only seam (NODE_ENV === 'test', matched by exact docName like
        // OK_TEST_STORE_FAULT). Simulates a native out-of-band edit landing in
        // the residual TOCTOU window — after L1's check, before this store's
        // write — so the L3 backstop fires deterministically. A real native edit
        // can't be timed deterministically: the file-watcher races it (and can
        // flip `lastTransactionOrigin` to file-watcher, gating L3 out). Raw,
        // unregistered write, exactly like a native edit. Production builds with
        // NODE_ENV !== 'test' elide the branch.
        if (
          process.env.NODE_ENV === 'test' &&
          process.env.OK_TEST_STORE_DIVERGENCE === documentName
        ) {
          await tracedWriteFile(canonicalPath, '# NATIVE\n\nnative-divergence-injected\n', 'utf-8');
        }

        // L3 store-time divergence backstop, gated to
        // agent-triggered stores (never human-editor `connection` stores).
        // The residual few-ms TOCTOU after L1's reconcile: disk may have been
        // edited out-of-band between L1's check and this store. Re-read disk and
        // compare to the reconciled base we're about to overwrite from
        // (`currentBase`), using the same `normalizeBridge` comparator as L1 and
        // the no-op skip above so the layers agree on "diverged". On divergence:
        // ABORT the overwrite (writing the in-memory bytes would clobber the
        // newer disk content), ingest disk (disk-wins; discards the agent edit
        // from the CRDT — a retry then re-applies exactly once via L1), advance
        // the base, and record the revert out-of-band so the awaiting handler
        // returns `urn:ok:error:disk-divergence`. Detection + disk-wins ingest
        // only — no in-hook merge, no second `BridgeMergeContentLossError` catch
        // site (STOP rule). Mirrors the tripwire-reset ingest below.
        if (agentTriggeredStore && currentBase !== undefined) {
          let diskNow: string | null = null;
          try {
            if (existsSync(canonicalPath)) diskNow = readFileSync(canonicalPath, 'utf-8');
          } catch (err) {
            // L3 is the terminal disk-authority guard: a read fault here silently
            // falls through to the overwrite (potential clobber of a newer disk
            // edit), so surface it rather than failing open quietly.
            diskNow = null;
            log.warn(
              { err, documentName },
              '[persistence] L3 disk-read failed; divergence check skipped for this store',
            );
          }
          if (diskNow !== null && normalizeBridge(diskNow) !== normalizeBridge(currentBase)) {
            const diskContent = diskNow; // const so the closure keeps the non-null narrowing
            console.warn(
              JSON.stringify({
                event: 'agent-write-content-divergence',
                'doc.name': documentName,
                outcome: 'reverted',
                diskBytes: diskContent.length,
                baseBytes: currentBase.length,
                candidateBytes: markdown.length,
              }),
            );
            // Caller-wrapped FILE_WATCHER_ORIGIN transact (paired-write +
            // skipStoreHooks), matching the tripwire-reset ingest — so the
            // realign fires no nested store and stays out of the agent's
            // UndoManager. Guarded like the identical applyDiskContent call in
            // the tripwire-reset block above and the atomic write below: if the
            // disk-wins ingest throws, the clobber is already aborted (disk
            // preserved), but the agent bytes never reached disk and the CRDT
            // still holds the stale edit — record a store failure and rethrow so
            // the awaiting handler surfaces an error via takeStoreFailure instead
            // of a false success. The base deliberately stays at currentBase (no
            // setReconciledBase) so a retry re-reads disk and reconciles again.
            try {
              document.transact(() => {
                applyDiskContent(document, diskContent);
              }, FILE_WATCHER_ORIGIN);
            } catch (err) {
              storeFailures.set(documentName, toStoreFailure(err));
              persistenceDeferCounts.delete(documentName);
              throw err;
            }
            setReconciledBase(documentName, diskContent);
            storeDivergences.add(documentName);
            persistenceDeferCounts.delete(documentName);
            return;
          }
        }

        const tmpPath = `${canonicalPath}.tmp.${crypto.randomUUID()}`;
        try {
          // Test-only fault-injection seam. Production builds with
          // NODE_ENV !== 'test' AND OK_TEST_STORE_FAULT unset elide the branch.
          // Matched by exact docName (not a wildcard) so concurrent tests in
          // the same process only fault the doc under test. Throws a synthetic
          // ENOSPC so the store-failure-surfacing path (record → rethrow →
          // Hocuspocus swallow → handler reads `takeStoreFailure`) runs without
          // a real out-of-space / read-only condition.
          if (process.env.NODE_ENV === 'test' && process.env.OK_TEST_STORE_FAULT === documentName) {
            const faultErr = new Error(
              `OK_TEST_STORE_FAULT: simulated disk failure for ${documentName}`,
            ) as NodeJS.ErrnoException;
            faultErr.code = 'ENOSPC';
            throw faultErr;
          }
          await tracedWriteFile(tmpPath, markdown, 'utf-8');
          await tracedRename(tmpPath, canonicalPath);
          registerWrite(canonicalPath, contentHash(markdown));
          // The bytes reached disk — clear any prior recorded failure so a
          // later force-flush + `takeStoreFailure` reflects the success.
          storeFailures.delete(documentName);
          // Increment disk-write counter after the atomic rename succeeds.
          // Regression gate: if OBSERVER_SYNC_ORIGIN drops skipStoreHooks,
          // observer writes trigger onStoreDocument and produce amplified
          // disk writes per user/agent edit. The counter is asserted in
          // tests to pin the no-amplification invariant.
          incrementPersistenceDiskWrite();
          // Notify clients that disk durability has been achieved up to the
          // pre-write state vector. Fired AFTER `tracedRename` succeeds so
          // a write failure (caught below) skips the watermark advance.
          //
          // Isolated try/catch: a thrown callback would otherwise enter
          // the disk-write catch block below despite the disk write having
          // succeeded — bypassing the success-path bookkeeping
          // (setReconciledBase, tripwireResetFailedDocs.delete, backlinks
          // update) and producing misleading "Failed to save" logs. The
          // production callback (`cc1Broadcaster.emitDiskAck`) catches its
          // own errors today, but the contract here is that the success
          // path is independent of callback behavior.
          try {
            onDiskFlush?.(documentName, stateVectorAtRead, markdown, currentBase ?? null);
          } catch (flushErr) {
            log.warn(
              { err: flushErr, documentName },
              `[persistence] onDiskFlush callback failed for ${documentName}`,
            );
          }
        } catch (e) {
          try {
            tracedUnlinkSync(tmpPath);
          } catch {
            /* cleanup best-effort */
          }
          // The disk-write throw bypasses the success-path delete at the
          // bottom of this hook, so deferCount stays at QUIESCENCE_MAX_DEFER
          // when the force-flush path lands here. Without this clear, every
          // subsequent debounce cycle force-flushes again (emitting
          // `persistence-force-flush-during-burst` on each fire) instead of
          // resuming the normal skip-and-defer cadence — making it hard to
          // distinguish "user typing continuously" from "stuck retry loop"
          // in telemetry. Clearing here ensures the next cycle re-enters the
          // gate fresh.
          persistenceDeferCounts.delete(documentName);
          // Record the failure BEFORE rethrowing. Hocuspocus's
          // `storeDocumentHooks` catches the rethrow and keeps the doc in
          // memory without signaling the caller, so this map is the only
          // channel a write handler has to learn the bytes never landed.
          // `toStoreFailure` reads `e` defensively so a throwing-getter error
          // shape can't replace `e` here and rob the deferred-store classifier
          // downstream of the original throw.
          storeFailures.set(documentName, toStoreFailure(e));
          log.error({ err: e, documentName }, `[persistence] Failed to save ${documentName}`);
          throw e;
        }
        log.info(
          { filePath: canonicalPath, bytes: markdown.length },
          `[persistence] Wrote ${canonicalPath} (${markdown.length} bytes)`,
        );

        // Update reconciled base after successful store
        setReconciledBase(documentName, markdown);
        tripwireResetFailedDocs.delete(documentName);
        persistenceDeferCounts.delete(documentName);

        if (backlinkIndex) {
          backlinkIndex.updateDocumentFromMarkdown(documentName, markdown);
          void backlinkIndex.saveToDisk().catch((err) => {
            log.warn(
              { err, documentName },
              `[backlinks] Failed to persist cache for ${documentName}`,
            );
          });
        }

        setActiveSpanAttributes({ 'persistence.bytes': markdown.length });
        scheduleGitCommit();
      },
    ).finally(() => {
      // Clear the in-flight flush signal only if it is still ours: a later
      // overlapping flush for the same doc overwrites the entry, and this
      // (possibly failed) flush must not delete that newer signal. On a
      // commit throw the entry clears here too, so the signal can never
      // stay stuck set past the flush that owns it.
      if (
        inFlightFlushValue !== undefined &&
        inFlightFlushByDoc.get(documentName) === inFlightFlushValue
      ) {
        inFlightFlushByDoc.delete(documentName);
      }
      // doc.name deliberately NOT recorded on the histogram — per-doc cardinality
      // would blow up Prometheus label storage at scale. The span carries it.
      storeDurationHist?.record((Date.now() - started) / 1000);
    });
  }

  function deferStore({
    document,
    documentName,
    lastTransactionOrigin,
  }: {
    document: Y.Doc;
    documentName: string;
    lastTransactionOrigin: unknown;
  }): void {
    deferredStores.set(documentName, {
      branch: getActiveBranch(),
      document,
      lastTransactionOrigin,
    });
  }

  async function flushDeferredStores(mode: 'within-branch' | 'discard-stale' = 'within-branch') {
    if (deferredStoreDrainInFlight) {
      pendingDeferredStoreFlushMode =
        pendingDeferredStoreFlushMode === 'discard-stale' || mode === 'discard-stale'
          ? 'discard-stale'
          : 'within-branch';
      return deferredStoreDrainInFlight;
    }

    deferredStoreDrainInFlight = (async () => {
      let drainMode = mode;
      while (true) {
        const entries = [...deferredStores.entries()];
        deferredStores.clear();

        if (drainMode !== 'discard-stale') {
          for (const [documentName, entry] of entries) {
            if (entry.branch !== getActiveBranch()) continue;
            try {
              await storeDocumentNow({
                document: entry.document,
                documentName,
                lastTransactionOrigin: entry.lastTransactionOrigin,
              });
            } catch (err) {
              // Structured-event observability for deferred-drain failures.
              // Default-redacted (FNV-1a hash of the raw message;
              // `OK_TELEMETRY_VERBOSE=1` opt-in for the verbatim string,
              // matching the bridge-invariant-violation pattern). No rate-
              // limit gate: tens-per-day worst-case frequency means a 30s
              // gate would suppress real signal during disk outages. The
              // classifier is wrapped because the outer catch is the
              // observability boundary — a malformed-error throw inside the
              // classifier would otherwise erase the failure signal entirely.
              // The classifier-failure event preserves the original error
              // context so triage can recover.
              const verbose = process.env.OK_TELEMETRY_VERBOSE === '1';
              // The classifier's outer try/catch (see classifyDeferredStoreError
              // JSDoc) is the observability boundary for exotic error shapes.
              // The .message extraction must sit inside an equivalent guard for
              // the same reason: a Proxy/non-Error throw with a throwing
              // .message getter would propagate up here, bypassing the
              // deferred-store-failed emission entirely — the same silent-loss
              // class this defense exists to prevent. Symmetric with the
              // .code-throws path the classifier itself defends against.
              let rawMessage = '';
              try {
                rawMessage = String((err as { message?: unknown } | null)?.message ?? '');
              } catch {
                rawMessage = '';
              }
              const errorMessageHash = fnv1aDigest(rawMessage);
              let errorClass: DeferredStoreErrorClass;
              try {
                errorClass = classifyDeferredStoreError(err);
              } catch (classifyErr) {
                // Mirror the outer event's redaction shape: hash always +
                // raw classifyErrorMessage when OK_TELEMETRY_VERBOSE=1.
                // Carry errorMessageHash so triage can correlate this event
                // with the subsequent deferred-store-failed emission.
                const rawClassifyMessage = String(
                  (classifyErr as { message?: unknown } | null)?.message ?? '',
                );
                console.warn(
                  JSON.stringify({
                    event: 'deferred-store-classifier-failed',
                    'doc.name': documentName,
                    classifyErrorHash: fnv1aDigest(rawClassifyMessage),
                    errorMessageHash,
                    ...(verbose ? { classifyErrorMessage: rawClassifyMessage } : {}),
                    timestamp: new Date().toISOString(),
                  }),
                );
                errorClass = 'unknown';
              }
              incrementDeferredStoreFailures();
              console.warn(
                JSON.stringify({
                  event: 'deferred-store-failed',
                  'doc.name': documentName,
                  errorClass,
                  errorMessageHash,
                  ...(verbose ? { errorMessage: rawMessage } : {}),
                  timestamp: new Date().toISOString(),
                }),
              );
              log.error(
                { err, documentName },
                `[persistence] Deferred store failed for ${documentName}`,
              );
            }
          }
        }

        const nextMode = pendingDeferredStoreFlushMode;
        pendingDeferredStoreFlushMode = null;
        if (deferredStores.size === 0 && nextMode === null) break;
        drainMode = nextMode ?? 'within-branch';
      }
    })().finally(() => {
      deferredStoreDrainInFlight = null;
    });

    return deferredStoreDrainInFlight;
  }

  const extension: Extension = {
    async onLoadDocument({ document, documentName, context: _context }) {
      if (isSystemDoc(documentName)) return;
      if (isConfigDoc(documentName)) {
        loadConfigDoc(document, documentName, configPersistenceCtx);
        return;
      }
      if (isManagedArtifactDoc(documentName)) {
        loadManagedArtifactDoc(document, documentName, managedArtifactCtx);
        return;
      }
      ensureHistograms();
      const started = Date.now();
      return withSpan(
        'persistence.onLoadDocument',
        { attributes: { 'doc.name': documentName } },
        async () => {
          log.info(
            { documentName, connections: document.getConnectionsCount?.() ?? '?' },
            `[persistence] onLoadDocument called for ${documentName} (connections: ${document.getConnectionsCount?.() ?? '?'})`,
          );
          const filePath = safeContentPath(documentName, contentDir);
          if (!existsSync(filePath)) return;

          let canonical = filePath;
          try {
            const resolvedCanonical = realpathSync(filePath);
            if (!isWithinContentDir(resolvedCanonical, contentDir)) {
              console.warn(
                `[persistence] symlink-escape on load: ${filePath} → ${resolvedCanonical}, refusing`,
              );
              return;
            }
            canonical = resolvedCanonical;
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ELOOP') {
              console.warn(`[persistence] Symlink cycle on load: ${filePath}, refusing`);
              return;
            }
            // Preserve the historical fallback: stat/read the requested path when realpath fails.
          }

          const fileSize = statSync(canonical).size;
          if (fileSize > DOCUMENT_OPEN_BYTE_LIMIT) {
            log.warn(
              { documentName, fileSize, limit: DOCUMENT_OPEN_BYTE_LIMIT },
              '[persistence] Document exceeds open byte limit; refusing to load',
            );
            throw new DocumentOpenSizeLimitError(documentName, fileSize);
          }

          const raw = readFileSync(filePath, 'utf-8');

          const xmlFragment = document.getXmlFragment('default');
          log.info(
            { documentName, fragmentLength: xmlFragment.length },
            `[persistence] onLoadDocument ${documentName}: fragment.length=${xmlFragment.length} before update`,
          );

          if (xmlFragment.length === 0) {
            // Load XmlFragment + Y.Text atomically under FILE_WATCHER_ORIGIN
            // (paired-write). Y.Text receives the FULL file content verbatim
            // (FM + body) so the YAML region of Y.Text — the FM source of
            // truth — preserves whatever scalar style + indentation was on
            // disk. A separate non-paired transact would let observers fire
            // mid-load and re-canonicalize Y.Text via yaml@2's serializer,
            // re-flowing list items (e.g. `  - characters` → `- characters`).
            // The paired-write origin's structural short-circuit in Observer
            // A/B refreshes the baseline without dispatching a sync.
            //
            // Threads the optional `resolveEmbed` so post-load PM image/link
            // nodes carry resolved src/href for `![[file.ext]]` embeds.
            //
            // Calls the imported `applyDiskContentToDoc` directly (not the
            // `applyDiskContent` option-aware variable). The option override
            // exists for the tripwire reset path so tests can inject a
            // throwing stub that exercises the breaker — onLoadDocument is
            // a different concern and shouldn't be intercepted by that
            // testability seam.
            //
            // Caller wraps for atomicity + paired-write origin identity
            // (precedent #24).
            document.transact(() => {
              applyDiskContentToDoc(
                document,
                raw,
                options?.resolveEmbed,
                documentName,
                options?.resolveSize,
              );
              // Mint the doc's lineage epoch atomically with the content it
              // identifies. Every seed-from-disk is a NEW Yjs lineage (no
              // Y-binary survives an unload), so client-persisted state from
              // a prior load must not rejoin this doc. The epoch replicates
              // in-band via the lifecycle map and lands in client IDB
              // automatically; clients claim it on reconnect and
              // `doc-lineage-guard.ts` rejects stale claims before sync.
              //
              // The `lifecycle` Y.Map is a shared namespace — key ownership:
              // `status`/`reason` belong to the conflict subsystem
              // (`conflict-lifecycle-seed.ts`, boot restore; read via
              // `isDocInConflict` in `conflict-errors.ts`); `epoch` belongs
              // to this seed-from-disk mint. Don't `clear()` the map and
              // route new keys through one owning subsystem.
              document.getMap('lifecycle').set(LINEAGE_EPOCH_KEY, crypto.randomUUID());
            }, FILE_WATCHER_ORIGIN);
            log.info(
              { filePath, children: xmlFragment.length },
              `[persistence] Loaded ${filePath} into Y.Doc (${xmlFragment.length} children)`,
            );
            // Watch for unexpected mutations
            xmlFragment.observeDeep(() => {
              log.info(
                { documentName, fragmentLength: xmlFragment.length },
                `[persistence] MUTATION on ${documentName}: fragment.length=${xmlFragment.length}`,
              );
            });
          } else {
            log.info(
              { documentName, children: xmlFragment.length },
              `[persistence] Skipped load for ${documentName} — fragment already has ${xmlFragment.length} children`,
            );
          }

          // The reconciled base is the RAW disk bytes verbatim, not a
          // fragment-derived re-serialization. This unifies cold-load with
          // the file-watcher path in `external-change.ts` — both store the
          // bytes that were observed on disk. Persistence reads ytext for
          // body and writes ytext bytes back; round-trip across save+reload
          // preserves user form. The earlier `mdManager.serialize(fragment)`
          // canonicalization here pre-dated the Y.Text-is-truth contract
          // (precedent #38) — it normalized away source-form attrs (inline-
          // code fence form, blockquote spacing, setext underline length,
          // etc.) on every load, defeating the per-attr fidelity work for
          // already-saved files.
          //
          // The first onStoreDocument after load tolerates the "fragment is
          // canonical, ytext is raw" gap via `normalizeBridge` —
          // markdownSemanticallyUnchanged compares with `normalizeBridge`,
          // and the bridge invariant comparator (`assertBridgeInvariant`
          // and `attachBridgeInvariantWatcher`) tolerates the same classes,
          // so no false-positive write fires on mere file open.
          setReconciledBase(documentName, raw);
        },
      ).finally(() => {
        // doc.name deliberately NOT recorded on the histogram — per-doc cardinality
        // would blow up Prometheus label storage at scale. The span carries it.
        loadDurationHist?.record((Date.now() - started) / 1000);
      });
    },

    // STOP: Do NOT add additional `Y.encodeStateVector(document)` calls
    // anywhere in this function. The only sanctioned capture is via
    // `captureDocSnapshotForPersistence` at the top of the body — its
    // co-capture of `{sv, json}` is what guarantees the disk-ack
    // watermark reflects the exact doc state that lands on disk. A
    // second SV captured later (e.g., after `await tracedRename`) would
    // include updates from the async write window, falsely advancing the
    // watermark past content that's NOT durably persisted, and
    // clients would drop those bytes from the recycle buffer →
    // unsynced-edit loss on server-restart. See the helper's docstring
    // for the full timing contract.
    async onStoreDocument({
      document,
      documentName,
      lastTransactionOrigin,
      lastContext: _lastContext,
    }) {
      if (isSystemDoc(documentName)) return;
      if (isConfigDoc(documentName)) {
        const outcome = await storeConfigDoc(
          document,
          documentName,
          lastTransactionOrigin,
          configPersistenceCtx,
        );
        // A validated config value just reached durable state — either written
        // by this persist (`'persisted'`) or imported from a winning external
        // writer on reconcile (`'reconciled'`). Notify live in-process consumers
        // directly; the chokidar echo is a non-guaranteed, OS-mediated
        // filesystem-event channel that can drop this event (permanent
        // divergence until restart). The persist already succeeded, so a
        // consumer-notify throw must not surface as a store failure.
        if (outcome === 'persisted' || outcome === 'reconciled') {
          try {
            onConfigPersisted?.(documentName);
          } catch (err) {
            log.warn({ err, documentName }, '[persistence] onConfigPersisted callback failed');
          }
        }
        return;
      }
      if (isManagedArtifactDoc(documentName)) {
        const outcome = await storeManagedArtifactDoc(
          document,
          documentName,
          lastTransactionOrigin,
          managedArtifactCtx,
        );
        // Version editor-driven CRDT edits exactly like a regular doc: an
        // attributed shadow commit per edit, recorded under the `.ok/` artifact
        // key + `skill-`/`template-` subject the timeline filters on (so the edit
        // surfaces in skill history / the folder timeline). This is the SAME
        // safety-net `storeDocumentNow` uses for browser writes: MCP `write`/
        // `edit` go through agent sessions and are attributed by the
        // api-extension handler (rich actor + summary), so the store skips agent
        // origins to avoid double-attribution and only versions the connection-
        // origin (editor/principal) writes that never pass through a handler.
        // Only a real write (`persisted`) versions; no-op / reconcile / write-
        // failed do not, and global skills are unversioned (attribution null).
        if (outcome === 'persisted') {
          const writer = resolveWriterFromOrigin(lastTransactionOrigin, getPrincipal);
          if (writer && writer.id !== SERVICE_WRITER.id && !writer.id.startsWith('agent-')) {
            const attribution = managedArtifactContributorAttribution(documentName);
            if (attribution) {
              recordContributor(
                attribution.docKey,
                writer.id,
                writer.name,
                writer.id,
                attribution.subject,
              );
              scheduleGitCommit();
            }
          }
        }
        return;
      }
      if (isBatchInProgress()) {
        deferStore({ document, documentName, lastTransactionOrigin });
        return;
      }
      return storeDocumentNow({
        document,
        documentName,
        lastTransactionOrigin,
      });
    },
  };

  async function waitForPendingCommits(): Promise<void> {
    if (commitInFlight) await commitInFlight;
  }

  /**
   * Force a single drain of the in-memory contributor map even when no Y.Doc
   * mutation has scheduled the debounced timer. The rewrite spine relies on
   * this for renames: a pure rename touches disk and `pendingContributors`
   * but not any Y.Doc, so the normal `scheduleGitCommit` path never fires —
   * the rename's contributor entry plus the matching `renames.jsonl` entry
   * (with `commitSha: ''`) would sit in memory until something else triggers
   * a Y.Doc transact, at which point the rename's commit timestamp would
   * be wallclock-now (drain time), not rename time.
   *
   * No-op when nothing is pending (`contributorCount() === 0`) — calling
   * this on every rename even with no contributors would waste a service-
   * writer commit.
   *
   * Serialized via `commitInFlight`: a concurrent caller awaits the in-flight
   * drain rather than racing with `scheduleGitCommit` or another flush.
   */
  async function flushContributors(): Promise<void> {
    if (commitInFlight) {
      await commitInFlight;
      return;
    }
    if (contributorCount() === 0) return;
    commitInFlight = commitToWipRef().finally(() => {
      commitInFlight = null;
      if (pendingAfterCommit) {
        pendingAfterCommit = false;
        scheduleGitCommit();
      }
    });
    await commitInFlight;
  }

  function takeStoreFailure(documentName: string): StoreFailure | null {
    const failure = storeFailures.get(documentName);
    if (failure) storeFailures.delete(documentName);
    return failure ?? null;
  }

  function takeStoreDivergence(documentName: string): boolean {
    if (!storeDivergences.has(documentName)) return false;
    storeDivergences.delete(documentName);
    return true;
  }

  function markAgentWriteStore(documentName: string): void {
    agentWriteStores.add(documentName);
  }

  return {
    extension,
    flushDeferredStores,
    flushPendingGitCommit,
    flushContributors,
    waitForPendingCommits,
    takeStoreFailure,
    takeStoreDivergence,
    markAgentWriteStore,
    configPersistenceCtx,
    managedArtifactCtx,
  };
}
