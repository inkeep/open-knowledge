/**
 * Server-authoritative observer bridge — single-writer cross-CRDT sync.
 *
 * Mirrors the client-side observer bridge's write-side logic on the server:
 *   Observer A: XmlFragment → Y.Text (Path A: applyIncrementalDiff; Path B: mergeThreeWay + applyFastDiff)
 *   Observer B: Y.Text → XmlFragment (via updateYFragment)
 *
 * Runs on the server's copy of the Y.Doc so concurrent client edits converge
 * through one writer instead of N. Client observer cross-CRDT write paths are
 * deleted (not gated) — see precedent #14.
 *
 * Dispatch model (precedent #13(b)): the
 * observers use `doc.on('afterAllTransactions', ...)` — per-drain, not
 * per-transaction, and not a wall-clock `setTimeout` debounce. One outermost
 * `doc.transact(...)` call = one drain = one settlement fire. Observer
 * callbacks set dirty flags; the settlement handler dispatches synchronous
 * sync work (A before B) and clears the flags.
 *
 * No typing-defer logic (server never types — that was client-specific UX).
 * No REMOTE_TREE_SYNC_GRACE_MS (origin guards replace the timing guard).
 * Fires on BOTH transaction.local=true (server-local) and local=false (remote).
 *
 */

import type { LocalTransactionOrigin } from '@hocuspocus/server';
import type {
  MarkdownManager,
  PmStructuralNode,
  StructuralDivergenceReason,
} from '@inkeep/open-knowledge-core';
import {
  applyFastDiff,
  applyIncrementalDiff,
  BridgeInvariantViolationError,
  BridgeMergeContentLossError,
  comparePmStructural,
  DUPLICATION_GATE_MIN_LINE_LENGTH,
  isParseEquivalentBridge,
  mergeThreeWay,
  normalizeBridge,
  overMultipliedBodyLines,
  prependFrontmatter,
  projectMergeBoundarySpace,
  reattachLeadingDocBoundary,
  splitLeadingDocBoundary,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import type { Schema } from '@tiptap/pm/model';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
// Value import (not `import type`): `carrierKind` uses `instanceof Y.XmlElement`
// to read a top-level child's node shape for the duplication gate.
import * as Y from 'yjs';
import { attachQuiescenceTracker } from './bridge-quiescence.ts';
import {
  assertBridgeInvariant,
  type BridgeSplitBrainSite,
  createDocCanonicalizer,
  emitBridgeSplitBrainRederive,
  emitObserverAPathBFired,
} from './bridge-watchdog.ts';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import { recordFrontmatterEditSurface } from './frontmatter-telemetry.ts';
import { getLogger } from './logger.ts';
import { computeMapDrivenBodySplice } from './map-driven-splice.ts';
import {
  incrementBridgeMergeCheckpointCreated,
  incrementBridgeMergeContentGrowth,
  incrementBridgeMergeContentLoss,
  incrementBridgeSplitBrainRederives,
  incrementMapDrivenSpliceApplied,
  incrementMapDrivenSpliceFallback,
  incrementObserverADuplicationCheckpointCreated,
  incrementObserverADuplicationRederives,
  incrementObserverAPathBFires,
  incrementObserverAResidualMergeRuns,
  incrementProducerGuardCheckpointCreated,
  incrementProducerGuardFires,
  incrementProducerGuardFiresSuppressed,
  incrementServerObserverError,
  incrementServerObserverFire,
} from './metrics.ts';
import { registerBridgeDirtyProbe } from './server-workload-telemetry.ts';
import { type ShadowHandle, saveInMemoryCheckpoint } from './shadow-repo.ts';
import { setActiveSpanAttributes, withSpanSync } from './telemetry.ts';

const log = getLogger('server-observers');

/**
 * Structured record for checkpoint-write failures, alongside the
 * human-readable observer warn: a failed checkpoint means the recovery
 * snapshot for a detected content-loss event was NOT persisted, and the
 * kind-tagged fields are what diagnostics bundles key on.
 */
const checkpointLog = getLogger('server-observers');

// ─────────────────────────────────────────────────────────────
// Origin constant
// ─────────────────────────────────────────────────────────────

/**
 * Transaction origin for server observer cross-CRDT writes.
 *
 * Object reference per precedent #1 — identity-based matching in
 * Set.has / Y.UndoManager.trackedOrigins / attachBridgeInvariantWatcher
 * enforcing sets requires the exact object ref.
 *
 * skipStoreHooks: true — prevents observer → persistence → file-watcher →
 * observer feedback loop. Same pattern as
 * FILE_WATCHER_ORIGIN in external-change.ts. Verified by the
 * persistenceDiskWrites counter in `server-observer-feedback-loop.test.ts`.
 */
export const OBSERVER_SYNC_ORIGIN = {
  source: 'local',
  skipStoreHooks: true,
  context: { origin: 'observer-sync' },
} as const satisfies LocalTransactionOrigin;

/**
 * Branded `LocalTransactionOrigin` for paired-write semantics — transactions
 * where the caller atomically writes BOTH Y.XmlFragment and Y.Text inside
 * one `doc.transact(..., ORIGIN)` block.
 *
 * Compile-time extension of precedent #1.
 * Origin literals opt in by asserting `satisfies
 * PairedWriteOrigin` at their definition site; that annotation forces the
 * literal to carry `context.paired: true` and prevents typos. See the
 * five paired origins in the repo — AGENT_WRITE_ORIGIN, FILE_WATCHER_ORIGIN,
 * ROLLBACK_ORIGIN, MANAGED_RENAME_ORIGIN, PARK_SNAPSHOT_ORIGIN
 * (server-factory.ts) — each satisfies this shape.
 *
 * Runtime remains structural (`context.paired === true`) so remote-arriving
 * transactions (where the origin object identity is reconstructed by Yjs)
 * still match; `satisfies PairedWriteOrigin` is the authoring-site gate,
 * not a runtime `instanceof` narrowing.
 *
 * Today's paired origin count: 5. When adding a 6th, the ONLY required
 * change is `satisfies PairedWriteOrigin` at the literal. No registry
 * update. No Observer A/B wiring. No `BRIDGE_ENFORCING_ORIGINS` change
 * (that set is unrelated — it enforces the bridge-invariant watcher's
 * post-transaction assertion, not paired-write short-circuit).
 */
export type PairedWriteOrigin = LocalTransactionOrigin & {
  readonly context: {
    readonly origin: string;
    readonly paired: true;
  };
};

/**
 * Semantic match (precedent #1 extension).
 *
 * When an observer callback sees a paired-write origin, it refreshes the
 * raw Y.Text witness synchronously from the post-write state and declines to
 * set its dirty flag — the settlement handler then has no work to dispatch
 * for this drain (the paired writer already made both CRDTs consistent).
 *
 * The structural runtime check covers both locally-written origins (where the
 * object identity is the one we exported) and remote-arriving transactions
 * (where Yjs may have reconstructed the origin from the wire payload). The
 * `PairedWriteOrigin` brand above is the authoring-site compile-time gate;
 * this predicate is the read-site runtime gate. Both together close the
 * loop the regression class left open.
 *
 * Fuzz reproduction: `STRESS_FUZZ_SEED=1776325179241 bun test
 * packages/app/tests/stress/bridge-convergence.fuzz.test.ts` produces an
 * "Oracle (e) content-set violation — missing 'M3-charlie hotel echo'" failure
 * whose proximate cause is a duplicated `M0-alpha echo` line that a later
 * agent-patch `indexOf('alpha')` locks onto instead of the intended target.
 */
export const isPairedWriteOrigin = (origin: unknown): origin is PairedWriteOrigin => {
  if (origin == null || typeof origin !== 'object') return false;
  const ctx = (origin as { context?: { paired?: boolean } }).context;
  return ctx?.paired === true;
};

/**
 * Affirmative throw gate for `BridgeMergeContentLossError` inside Observer A
 * Path B. Production commits to the silent-checkpoint recovery path (log +
 * queue checkpoint + apply merge as-computed) so the editor keeps responding;
 * tests want the error loud so regressions surface.
 *
 * The check is affirmative rather than `NODE_ENV !== 'production'` because
 * Bun leaves `NODE_ENV` undefined when the runtime is `bun run` or
 * `open-knowledge start` — the negative form inverted the contract and
 * re-threw in production. `bun test`
 * auto-populates `NODE_ENV=test`, which is the primary signal; callers that
 * want loud failures outside `bun test` (integration harnesses launched via
 * `bun run`, spike scripts) opt in with `OK_RETHROW_BRIDGE_LOSS=1`.
 *
 * Exported for the unit-test regression guard — the gate decision is a
 * first-class concern, not an implementation detail.
 */
export function shouldRethrowBridgeMergeLoss(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test' || env.OK_RETHROW_BRIDGE_LOSS === '1';
}

/**
 * The producer-guard violation payload — parity with `BridgeMergeContentLossInfo`
 * so both bridge-content-loss detection sites carry a named, structured shape
 * rather than an inlined object literal.
 */
export interface ProducerGuardViolationInfo {
  docName?: string;
  reason: StructuralDivergenceReason;
  detail: string;
}

/**
 * Raised by the Observer-A producer guard when the bytes about to be persisted
 * fail structural legality — a fresh parse loses authored content. Distinct
 * class so the sync-impl's soft-recovery catch can pass it through (like
 * `BridgeMergeContentLossError`) to reach the dev/test runner instead of
 * swallowing it as a recoverable observer fault. Never thrown in the packaged
 * posture (there the guard logs + checkpoints and returns).
 */
export class ProducerGuardViolationError extends Error {
  readonly info: ProducerGuardViolationInfo;
  constructor(info: ProducerGuardViolationInfo) {
    super(
      `Observer-A producer guard: serialize output failed structural legality (${info.reason}: ${info.detail})`,
    );
    this.name = 'ProducerGuardViolationError';
    this.info = info;
  }
}

/**
 * Node types where the ProseMirror space exceeds what markdown can spell — the
 * only place block-in-cell / stale-jsx-interior content-loss is representable.
 * A fragment carrying none of these round-trips by construction, so the
 * producer-guard parse is skipped for it, bounding the detection cost to the
 * danger space in every posture.
 */
const PRODUCER_GUARD_DANGER_TYPES = new Set(['jsxComponent', 'table', 'tableCell', 'tableHeader']);

function fragmentContainsDangerSpace(node: PmStructuralNode): boolean {
  if (node.type && PRODUCER_GUARD_DANGER_TYPES.has(node.type)) return true;
  if (node.content) {
    for (const child of node.content) {
      if (fragmentContainsDangerSpace(child)) return true;
    }
  }
  return false;
}

/** Content-free locator for a guard fire: the sorted set of danger-space node
 *  types present in the fragment (e.g. `jsxComponent,tableCell`). Bounded
 *  cardinality (a subset of the four danger types), never raw content — safe on
 *  a log field and a persisted checkpoint metadata line. */
function dangerSpaceLocator(node: PmStructuralNode): string {
  const present = new Set<string>();
  const walk = (n: PmStructuralNode): void => {
    if (n.type && PRODUCER_GUARD_DANGER_TYPES.has(n.type)) present.add(n.type);
    if (n.content) for (const child of n.content) walk(child);
  };
  walk(node);
  return [...present].sort().join(',');
}

/**
 * Y.Text-relative splice — translated from `MapDrivenSplice`'s body-relative
 * offsets by the frontmatter prefix length so the caller can apply directly
 * inside a `doc.transact(..., OBSERVER_SYNC_ORIGIN)` block.
 */
interface YTextMapDrivenSplice {
  readonly spliceStart: number;
  readonly spliceEnd: number;
  readonly newSlice: string;
}

interface TryComputeMapDrivenSpliceArgs {
  readonly currentText: string;
  readonly lastSyncedXmlMd: string;
  readonly json: unknown;
  readonly mdManager: MarkdownManager;
  readonly docName: string | undefined;
}

// Warn-once: the parse-error fallback metric is a bounded-cardinality counter
// and cannot carry the failing error's message — without this breadcrumb the
// first serializer/parser regression leaves no signal naming the failure while
// every drain quietly routes through the lossier incremental-diff fallback.
let mapDrivenParseErrorWarned = false;

/** Test-only: re-arm the parse-error warn-once (process-global, so an earlier
 * suite test exercising the fallback would otherwise consume the single warn). */
export function __resetMapDrivenParseErrorWarnForTests(): void {
  mapDrivenParseErrorWarned = false;
}

function warnOnceMapDrivenParseError(docName: string | undefined, err: unknown): void {
  if (mapDrivenParseErrorWarned) return;
  mapDrivenParseErrorWarned = true;
  log.warn(
    { docName: docName ?? 'unknown', err: err instanceof Error ? err : new Error(String(err)) },
    `[Server Observer A] Map-driven splice parse/serialize threw (doc: ${docName ?? 'unknown'}); drains fall back to the incremental diff (warned once; further failures count in mapDrivenSpliceFallback only)`,
  );
}

function tryComputeMapDrivenSplice(
  args: TryComputeMapDrivenSpliceArgs,
): YTextMapDrivenSplice | null {
  const { currentText, lastSyncedXmlMd, json, mdManager, docName } = args;
  if (currentText !== lastSyncedXmlMd) {
    incrementMapDrivenSpliceFallback('text-mismatch');
    return null;
  }
  if (docName !== undefined && (isSystemDoc(docName) || isConfigDoc(docName))) {
    incrementMapDrivenSpliceFallback('synthetic-doc');
    return null;
  }

  const { body: oldBody } = stripFrontmatter(currentText);
  const bodyOffset = currentText.length - oldBody.length;
  const splice = computeMapDrivenBodySplice(
    oldBody,
    json as Parameters<typeof computeMapDrivenBodySplice>[1],
    mdManager,
    (reason, err) => {
      incrementMapDrivenSpliceFallback(reason);
      if (reason === 'parse-error') warnOnceMapDrivenParseError(docName, err);
    },
  );
  if (!splice) return null;

  return {
    spliceStart: bodyOffset + splice.spliceStart,
    spliceEnd: bodyOffset + splice.spliceEnd,
    newSlice: splice.newSlice,
  };
}

function applyMapDrivenSplice(ytext: Y.Text, splice: YTextMapDrivenSplice): void {
  const deleteLength = splice.spliceEnd - splice.spliceStart;
  if (deleteLength > 0) ytext.delete(splice.spliceStart, deleteLength);
  if (splice.newSlice.length > 0) ytext.insert(splice.spliceStart, splice.newSlice);
}

// Bridge utilities (applyIncrementalDiff, applyFastDiff, mergeThreeWay,
// diffLinesFast, getFrontmatter, normalizeBridge) are imported from
// `@inkeep/open-knowledge-core` so they live in one place shared with the
// client observer (precedent #4: shared computation, per-surface rendering).

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Accessor for a `ShadowHandle` that may be lazy-initialized in the server
 * lifecycle. Observer A Path B's silent-checkpoint writer reads this
 * indirectly so a not-yet-ready shadow simply skips the checkpoint
 * (logging continues regardless — telemetry still records the violation).
 */
type ShadowAccessor = () => ShadowHandle | undefined;

/**
 * Accessor for the current project branch name; used in the
 * `refs/checkpoints/<branch>/<sha>` ref namespace. Returns 'main' when the
 * git HEAD resolver isn't available (e.g., standalone repos without a
 * project `.git/`).
 */
type BranchAccessor = () => string;

/**
 * Decision surfaced by the settlement handler on each drain it processes.
 *
 * - `'none'`: drain contained only observer-self or paired-write origins
 *   (baselines refreshed synchronously in the observer callback; no dispatch
 *   needed).
 * - `'a'`: Observer A's sync work ran (XmlFragment → Y.Text).
 * - `'b'`: Observer B's sync work ran (Y.Text → XmlFragment).
 *
 * A single drain can produce `'a'` followed by `'b'` — Observer A runs
 * before Observer B so any Y.Text write from A is visible to B.
 */
export type ObserverDispatchKind = 'none' | 'a' | 'b';

/**
 * Test-only hook — invoked after the settlement handler makes its dispatch
 * decision for a drain. Production code omits this; unit tests use it to
 * assert that paired-write drains produce `'none'` (no observer-layer work)
 * and that non-paired drains produce the expected 'a' and/or 'b' dispatches.
 *
 * Never throws — the settlement handler runs in `doc.on('afterAllTransactions')`
 * and a throw from here would propagate through Yjs's transaction machinery.
 * Tests use `expect` calls outside the hook body.
 */
type ObserverDispatchHook = (kind: ObserverDispatchKind) => void;

export interface SetupServerObserversOpts {
  doc: Y.Doc;
  xmlFragment: Y.XmlFragment;
  ytext: Y.Text;
  mdManager: MarkdownManager;
  schema: Schema;
  /**
   * Per-document name; used as the tree-path + filename inside the silent
   * checkpoint commit so TimelinePanel can attribute the artifact to the
   * doc that produced the loss. Omit for unit tests that only exercise
   * the bridge mechanics; Path B then skips the checkpoint but still
   * emits the structured log and metrics counter.
   */
  docName?: string;
  /** Accessor for the shadow handle (lazy; may return undefined pre-init). */
  shadow?: ShadowAccessor;
  /** Accessor for the current branch name. Defaults to 'main' when omitted. */
  getBranch?: BranchAccessor;
  /** Absolute content root (used to place the blob inside the checkpoint tree). */
  contentRoot?: string;
  /**
   * Basename-index resolver used by `mdManager.parse` so `![[photo.png]]`
   * wiki-embed refs resolve to the right disk path before dispatch to the
   * PM image / link node. When omitted OR when the resolver returns `null`,
   * the handler falls back to the literal target
   * (broken-ref placeholder via `<img onerror>` / `<a href>` — browsers
   * surface missing assets without throwing).
   *
   * Resolver signature matches `packages/core/src/utils/path-resolve.ts`:
   * `(basename, sourcePath) => path | null`.
   */
  resolveEmbed?: (basename: string, sourcePath: string) => string | null;
  /**
   * Byte-size resolver for `![[file.ext]]` wikilinks whose extension is
   * in `FILE_ATTACHMENT_EXTENSIONS`. Mirrors `resolveEmbed`'s signature;
   * the parser's wikiLinkEmbed handler calls this with the same
   * `(target, sourcePath)` it passes to `resolveEmbed`, formats the
   * result with `formatFileSize`, and stamps it on the jsxComponent's
   * `size` prop. Omit on unit / client paths.
   */
  resolveSize?: (basename: string, sourcePath: string) => number | null;
  /**
   * Test-only dispatch hook. Omitted in production. When provided, called
   * once per drain (from inside `afterAllTransactions`) with the dispatch
   * decision the settlement handler made.
   */
  onDispatch?: ObserverDispatchHook;
  /**
   * Test-only seam for Observer A Path B's three-way merge. Omitted in
   * production (defaults to the real `mergeThreeWay`). The
   * `BridgeMergeContentLossError` recovery arm cannot be reached organically:
   * Observer A's agent side (the current Y.Text) only ever drifts from the
   * merge baseline by in-tolerance whitespace, so the hybrid merge never drops
   * non-whitespace content from a constructible fixture (the residual is a
   * rare multi-edit fuzz artifact, not a fixture). A production-policy test
   * forces the throw through this seam to pin the recovery arm's boundary
   * re-projection.
   */
  mergeThreeWay?: typeof mergeThreeWay;
}

/**
 * Split-brain settlement predicate (the precedent #38 comparison): true when
 * a drain is about to settle with Y.Text and the canonical fragment
 * serialization (`md`) diverged beyond `normalizeBridge` tolerance. The
 * byte-identity short-circuit skips the O(N) normalize passes on the common
 * in-sync case. Single-sourced so both Observer A detection sites (identity
 * gate + post-merge baseline check) apply the identical predicate.
 */
function settlesSplitBrain(settledText: string, md: string, normMdPre?: string): boolean {
  return settledText !== md && normalizeBridge(settledText) !== (normMdPre ?? normalizeBridge(md));
}

/** Node-shape discriminant for a top-level fragment child. */
function carrierKind(child: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  if (child instanceof Y.XmlElement) return child.nodeName;
  if (child instanceof Y.XmlText) return '#text';
  return '#hook';
}

/**
 * Minting provenance of a fragment child. Y.js stores clientID+clock per
 * struct but NOT the transaction origin on the materialized item, so the
 * `_item` internal is the only recoverable provenance (y-tiptap /
 * y-prosemirror depend on the same internal). Isolated here so a Y.js
 * upgrade that changes the struct shape has exactly one site to re-verify;
 * `undefined` (unintegrated child or shape change) means "cannot attribute"
 * and callers must fail safe toward no destructive recovery.
 */
function mintingClientId(child: Y.XmlElement | Y.XmlText | Y.XmlHook): number | undefined {
  return (child as { _item?: { id?: { client: number } } | null })._item?.id?.client;
}

const collapseSpaces = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Shared final reduction for carrier attribution: both bare-text forms drop
 * the inline-marker character set entirely. The markdown side cannot tell a
 * syntax marker from a literal char without parsing (`snake_case` vs
 * `_emphasis_`), and the XML side keeps literals — the only way the two
 * reductions agree on every input is to delete the marker chars from BOTH.
 * Attribution only needs a stable common form, not lossless text.
 */
const stripInlineMarkerChars = (s: string): string => s.replace(/[*_~`]+/g, '');

/**
 * Fragment-child XML serialization reduced to bare text: tags dropped, basic
 * entities unescaped, inline-marker chars dropped (shared reduction).
 * Carrier attribution compares markdown-derived lines against fragment
 * children, and the two serializations spell inline formatting differently
 * (`**bold**` vs `<strong>bold</strong>`), so both sides reduce to the same
 * plain-text form before the substring test.
 */
function xmlBareText(s: string): string {
  return collapseSpaces(
    stripInlineMarkerChars(
      s
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&'),
    ),
  );
}

/** Markdown body line reduced to bare text: link/image syntax keeps its label, escapes unwrap, inline-marker chars drop (shared reduction). */
function markdownBareText(line: string): string {
  return collapseSpaces(
    stripInlineMarkerChars(
      line.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\\([\\`*_{}[\]()#+\-.!><])/g, '$1'),
    ),
  );
}

/**
 * Provenance confirm for the Observer A duplication gate — the discriminator
 * between a server-vs-client CRDT race (recover) and a legitimate client
 * duplication such as a WYSIWYG paste of existing content (leave for
 * forward-propagation; recovery re-derives from Y.Text and would silently drop
 * the paste).
 *
 * Given the substantive body lines the growth pre-filter found over-multiplied
 * in the fragment relative to Y.Text, walk the top-level fragment children and
 * confirm the race by TWO joint signatures on the carriers of an over-multiplied
 * line:
 *
 *   1. Provenance split — the carriers span BOTH the server's own `doc.clientID`
 *      (Observer B's re-derivation under `OBSERVER_SYNC_ORIGIN`) AND at least
 *      one foreign clientID (a client insert). A duplicate can only form when
 *      Observer B's re-derive of a span races a client insert of the same
 *      content, so a genuine race always carries this split.
 *   2. Shape disagreement — the server carrier and the foreign carrier have
 *      DIFFERENT node types. This is the load-bearing discriminator: the race is
 *      a stale-view parse disagreement (the server sees the closed span as a
 *      valid `jsxComponent`, the stale client sees it as a `rawMdxFallback`),
 *      and item-preservation (bridge invariant: matching items are never
 *      replaced) means a SAME-shape duplication would have deduped rather than
 *      survived — so a surviving duplication with agreeing shapes is an
 *      intentional client duplication (a paste), never this race. Anchoring on
 *      shape (not `child.toString()` byte-equality — the carriers are
 *      content-equivalent but never byte-equal) keeps the gate from dropping a
 *      user's paste of a server-derived paragraph or component block.
 *
 * Provenance is read via `mintingClientId` (the `_item.id.client` internal —
 * see that helper for the upgrade-fragility note). A child that cannot be
 * attributed is skipped and the gate fails safe toward "not a race" — no
 * destructive recovery on an unresolvable provenance.
 */
export function findRaceDuplicatedSpans(
  xmlFragment: Y.XmlFragment,
  serverClientId: number,
  overMultipliedLines: readonly string[],
): boolean {
  if (overMultipliedLines.length === 0) return false;
  const children = xmlFragment.toArray();
  const childBareTexts = children.map((child) => xmlBareText(child.toString()));
  for (const line of overMultipliedLines) {
    // Both sides reduced to bare text so inline formatting (bold, code,
    // links) cannot hide a carrier. Stripping can shorten a line below the
    // substantive threshold ("**Go!**" -> "Go!"); such lines no longer
    // identify a span reliably, so they are skipped (fail-safe: no
    // destructive recovery on a weak anchor).
    const bareLine = markdownBareText(line);
    if (bareLine.length < DUPLICATION_GATE_MIN_LINE_LENGTH) continue;
    const serverKinds = new Set<string>();
    const foreignKinds = new Set<string>();
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child === undefined || !childBareTexts[i]?.includes(bareLine)) continue;
      const client = mintingClientId(child);
      if (client === undefined) continue;
      if (client === serverClientId) serverKinds.add(carrierKind(child));
      else foreignKinds.add(carrierKind(child));
    }
    // Race iff a server carrier and a foreign carrier DISAGREE on node shape.
    for (const s of serverKinds) {
      for (const f of foreignKinds) {
        if (s !== f) return true;
      }
    }
  }
  return false;
}

/**
 * Set up server-side bidirectional observers between Y.XmlFragment and Y.Text.
 *
 * Observer A (XmlFragment → Y.Text): mirrors client Observer A's write-side
 * logic — Path A (diffLines + content-comparison gate when Y.Text in sync
 * with baseline) and Path B (DMP three-way merge when Y.Text diverged).
 *
 * Observer B (Y.Text → XmlFragment): parses Y.Text markdown, applies to
 * XmlFragment via updateYFragment. Handles frontmatter sync (Y.Text ↔ Y.Map).
 *
 * Dispatch (precedent #13(b)): Observer callbacks only flag dirty state.
 * The `afterAllTransactions` listener runs Observer A's sync work first
 * (so any Y.Text write is visible to Observer B) and then Observer B's,
 * clearing the dirty flags afterwards. One outermost `doc.transact()` call
 * produces exactly one settlement dispatch.
 *
 * Returns a cleanup function that detaches the observers and the settlement
 * handler. The settlement handler holds no timers; cleanup is O(1).
 */
export function setupServerObservers(opts: SetupServerObserversOpts): () => void {
  const { doc, xmlFragment, ytext, mdManager, schema } = opts;

  /**
   * Structured-log + silent-checkpoint writer for mergeThreeWay post-condition
   * violations. Fire-and-forget on the checkpoint; the
   * bridge hot path never awaits the git commit. When `opts.shadow` /
   * `opts.docName` / `opts.contentRoot` aren't provided (unit tests), skip
   * the checkpoint — telemetry still records the violation.
   */
  const handleBridgeMergeLoss = (
    err: BridgeMergeContentLossError,
    preMergeBaseline: string,
  ): void => {
    // Structured log — machine-consumable, keyed shape so log aggregators
    // can chart rate-per-doc over time.
    // JSON.stringify for machine-read events, bracket-prefix for ad-hoc
    // operational warnings.
    //
    // `lostSubstrings` is redacted by default (length + FNV-1a digest) so
    // verbatim user content doesn't flow into log aggregators. Operators
    // running a single-tenant local deployment can opt in to raw strings
    // via `OK_TELEMETRY_VERBOSE=1`.
    const verbose = process.env.OK_TELEMETRY_VERBOSE === '1';
    console.warn(
      JSON.stringify({
        ...err.toLog({ verbose }),
        docName: opts.docName ?? null,
        timestamp: new Date().toISOString(),
      }),
    );
    // Loss and growth verdicts share this handler (same error, same single
    // catch site) but chart on separate counters: growth is a content-GAIN
    // event and hiding it under the loss rate would mask which failure class
    // is moving. The recovery below (apply as-computed) is deliberately the
    // same for both: at the merge boundary there is no provenance, so a
    // doubled line may be two writers legitimately adding the same content —
    // discarding the merge would drop one side's edit. Preserve-everything +
    // alarm is the recovery; the provenance-confirmed duplication gate
    // earlier in the drain owns destructive recovery for the race case.
    if (err.info.which === 'growth') incrementBridgeMergeContentGrowth();
    else incrementBridgeMergeContentLoss();

    const shadow = opts.shadow?.();
    if (!shadow || !opts.docName) return;
    const branch = opts.getBranch?.() ?? 'main';
    const contentRoot = opts.contentRoot ?? '';
    queueMicrotask(() => {
      saveInMemoryCheckpoint(shadow, contentRoot, {
        kind: 'bridge-merge-loss',
        docName: opts.docName as string,
        contents: preMergeBaseline,
        label: `Before concurrent merge @ ${new Date().toISOString()}`,
        branch,
        metadata: { lostSubstrings: err.info.lostSubstrings, which: err.info.which },
      })
        .then((sha) => {
          incrementBridgeMergeCheckpointCreated();
          console.warn(
            JSON.stringify({
              event: 'bridge-merge-checkpoint-created',
              docName: opts.docName,
              sha,
              kind: 'bridge-merge-loss',
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .catch((checkpointErr: unknown) => {
          const err =
            checkpointErr instanceof Error ? checkpointErr : new Error(String(checkpointErr));
          log.warn({ err }, '[Server Observer A] Silent checkpoint write failed');
          checkpointLog.warn(
            { err, 'doc.name': opts.docName ?? null, branch, kind: 'bridge-merge-loss' },
            'checkpoint write failed',
          );
        });
    });
  };

  /**
   * Telemetry for the split-brain settlement check. The settlement predicate
   * tolerates resting serializer canonicalizations of organic input via the
   * parse-equivalence fallback (`settlesSplitBrainChecked` — fragment ≡
   * parse(ytext) verified through the doc's own parse pipeline), so a fire
   * means the fragment genuinely does not derive from Y.Text: dependency/
   * plugin drift or a degraded fragment. That makes this event the drift
   * alert — and the operator's only handle on a doc stuck re-deriving
   * its fragment on every drain. Rate-limited per (site, doc) through
   * `emitBridgeSplitBrainRederive` (mirroring `emitObserverAPathBFired`);
   * the counter increments only on emit, the suppressed counter inside the
   * gate, so `actual_rate = fires + suppressed` holds. Bounded-cardinality
   * attrs only: doc.name + enum site.
   */
  const recordSplitBrainRederive = (site: BridgeSplitBrainSite): void => {
    // No-throw is structural, not incidental: every call site runs inside
    // runObserverASyncImpl's try, after the state-critical witness writes and
    // the `textDirty = true` B-enqueue. A throw escaping here would route
    // through the outer catch, whose baseline recovery re-arms the
    // false-witness state this telemetry reports on. Side-channel
    // observability must never feed back into the write spine.
    try {
      if (emitBridgeSplitBrainRederive(site, opts.docName)) {
        incrementBridgeSplitBrainRederives();
        console.warn(
          JSON.stringify({
            event: 'bridge-split-brain-rederive',
            'doc.name': opts.docName ?? null,
            site,
          }),
        );
      }
    } catch (telErr) {
      log.warn({ err: telErr }, '[Server Observer A] Split-brain telemetry failed');
    }
  };

  /**
   * Silent recovery-anchor checkpoint for a duplication-gate recovery. Mirrors
   * the producer-guard checkpoint shape: fire-and-forget, bounded-cardinality
   * metadata (a count, never content). `contents` is the pre-recovery doubled
   * fragment serialization, so the discarded doubled state stays on the
   * timeline if the re-derive were ever wrong.
   */
  const saveDuplicationCheckpoint = (contents: string, duplicatedLineCount: number): void => {
    const shadow = opts.shadow?.();
    if (!shadow || !opts.docName) return;
    const branch = opts.getBranch?.() ?? 'main';
    const contentRoot = opts.contentRoot ?? '';
    const docName = opts.docName;
    queueMicrotask(() => {
      saveInMemoryCheckpoint(shadow, contentRoot, {
        kind: 'observer-a-duplication',
        docName,
        contents,
        label: `Before duplication re-derive @ ${new Date().toISOString()}`,
        branch,
        metadata: { duplicatedLineCount },
      })
        .then((sha) => {
          incrementObserverADuplicationCheckpointCreated();
          console.warn(
            JSON.stringify({
              event: 'observer-a-duplication-checkpoint-created',
              docName,
              sha,
              kind: 'observer-a-duplication',
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .catch((checkpointErr: unknown) => {
          const e =
            checkpointErr instanceof Error ? checkpointErr : new Error(String(checkpointErr));
          log.warn({ docName, err: e }, '[Server Observer A] Duplication checkpoint write failed');
          checkpointLog.warn(
            { err: e, 'doc.name': docName, branch, kind: 'observer-a-duplication' },
            'checkpoint write failed',
          );
        });
    });
  };

  // ─── Observer A: XmlFragment → Y.Text ─────────────────────
  // Two witnesses, one lifecycle. A single baseline variable here previously
  // conflated two incompatible surface contracts: gate 1 needs the canonical
  // serialization of the fragment as of the last settlement, while the
  // Path A/B router + mergeThreeWay base need the raw Y.Text bytes as of the
  // last settlement. The surfaces coincide only on round-trip-byte-stable
  // docs (raw === serialize(parse(raw)) + FM), so a canonical value written
  // where the router strict-compares raw bytes misroutes the first fragment
  // change on any residual-bearing doc to Path B.
  let lastSyncedCanonicalMd = '';
  let lastSyncedYTextBytes = '';
  // Coherence flag — true iff BOTH witnesses were recorded together at a
  // real settlement. The router's witness-vs-witness residual-tolerance
  // comparison is only meaningful within one settlement generation:
  // paired-write short-circuits refresh the raw witness ONLY (perf — no
  // O(N) serialize on the hot path), splitting the generations, and the
  // error-recovery `''` canonical sentinel must never feed `mergeThreeWay`
  // as a base (an empty base would re-insert the whole doc). When the flag
  // is false the router falls back to Path A — exactly what the pre-split
  // code did in those windows.
  let canonicalWitnessCoherent = false;
  let xmlDirty = false;
  let textDirty = false;
  // Timestamp of the last EXTERNAL Y.Text change (user typing via collab, an
  // agent's raw write — anything that is not our own cross-CRDT write). The
  // freshness re-derive is gated on this being quiet (the quiescence gate in
  // `runObserverASyncImpl`): during an active typing burst, in-flight client
  // ops can race a re-derived (respelled) write at the CRDT level even when
  // the raw witness LOOKS coherent at drain time, so witness coherence alone
  // cannot certify that de-anchoring the emission is safe.
  let lastExternalYtextChangeMs = 0;

  /**
   * STOP: the Path A/B router strict-compares this witness against
   * `ytext.toString()`, and `mergeThreeWay`'s diverged-branch base must be a
   * true Y.Text ancestor. It must only ever hold a real Y.Text byte
   * snapshot — never assign a serialized/recomposed string here.
   */
  const refreshYTextWitness = (): void => {
    lastSyncedYTextBytes = ytext.toString();
    canonicalWitnessCoherent = false;
  };

  /**
   * Record a settlement point — fragment and Y.Text are mutually consistent
   * NOW (or `canonicalMd === ''` to fail gate 1 open after an error). The raw
   * side is always read from `ytext.toString()` at call time, never from a
   * computed string — that single discipline is what keeps the router's
   * comparand on the raw surface. The coherence flag is set AFTER the raw
   * refresh so the paired-write helper's `false` can't clobber a settlement's
   * `true`; the `''` sentinel stays incoherent so it can never become a
   * merge base.
   */
  const recordSettledBaselines = (canonicalMd: string): void => {
    lastSyncedCanonicalMd = canonicalMd;
    refreshYTextWitness();
    canonicalWitnessCoherent = canonicalMd !== '';
  };

  /**
   * Record a diverged attach — observers attached while the fragment is NOT
   * the parse of current Y.Text (e.g. after a partially-failed paired write
   * left Y.Text ahead of the fragment). Not a settlement point: there is no
   * true Y.Text ancestor to snapshot, so both witnesses take the fragment's
   * canonical serialization. Observer B's early-exit then sees Y.Text as
   * divergent and re-derives the fragment on the next settlement, and the
   * router treats Y.Text as holding unabsorbed changes (Path B) with the
   * fragment's last state as the best-available merge base. This is the one
   * sanctioned non-Y.Text value for the raw witness.
   */
  const recordDivergedAttachBaselines = (canonicalMd: string): void => {
    lastSyncedCanonicalMd = canonicalMd;
    lastSyncedYTextBytes = canonicalMd;
    // A diverged attach is NOT a real settlement, so the flag stays false to
    // match the `canonicalWitnessCoherent` invariant. Behavior-neutral here:
    // both witnesses are equal, so the router's `===` residual-tolerance
    // shortcut keeps the residual merge ineligible regardless of the flag.
    canonicalWitnessCoherent = false;
  };

  /**
   * Reset ONLY the canonical witness after an Observer B failure — not a
   * settlement point. The raw witness deliberately stays at the last true
   * settlement (B failed to absorb Y.Text, so the next Path B fire needs
   * that true ancestor base), which means the witnesses now span two
   * settlement generations: the coherence flag MUST drop so the router's
   * residual-tolerance comparison (meaningless across generations) falls
   * back to Path A instead of feeding `mergeThreeWay` a cross-generation
   * canonical base.
   */
  const refreshCanonicalWitnessOnly = (canonicalMd: string): void => {
    lastSyncedCanonicalMd = canonicalMd;
    canonicalWitnessCoherent = false;
  };

  /**
   * Record a COHERENT split-brain pair after an Observer A error recovery —
   * the recomputed canonical fragment form (`canonicalMd`) and the current
   * raw Y.Text diverge beyond `normalizeBridge` tolerance, but both are read
   * NOW from a consistent in-memory state, so they belong to one settlement
   * generation. Unlike the `''` sentinel, this pair is deliberately coherent:
   * the router must take the byte-preserving residual-merge (row 2) on the
   * next fragment-change drain rather than a wholesale Path A rewrite, which
   * is what protects the divergent source bytes. The same-drain Observer B
   * re-derive the caller enqueues then rebuilds the fragment from Y.Text
   * (Y.Text-is-truth, precedent #38), so the split-brain state converges.
   */
  const recordSplitBrainRecoveryBaselines = (canonicalMd: string): void => {
    lastSyncedCanonicalMd = canonicalMd;
    lastSyncedYTextBytes = ytext.toString();
    canonicalWitnessCoherent = true;
  };

  /**
   * Read the current FM region directly from Y.Text. The YAML region of
   * `Y.Text('source')` IS the FM source of truth — no Y.Map metadata, no
   * recompose needed.
   */
  const readCurrentFm = (): string => stripFrontmatter(ytext.toString()).frontmatter;

  /** Parse options for THIS doc's text→tree derivations. One shape shared by
   *  Observer B's full fire, the attach-time settlement check, and the
   *  parse-equivalence canonicalizer, so every parse of this doc resolves
   *  embeds identically — a mismatched pipeline would read the same bytes
   *  into different trees. */
  const observerParseOpts =
    opts.resolveEmbed && opts.docName
      ? {
          resolveEmbed: opts.resolveEmbed,
          resolveSize: opts.resolveSize,
          sourcePath: opts.docName,
        }
      : undefined;

  /** Canonicalize a body through this doc's own parse pipeline — the
   *  parse-equivalence fallback's callback (`isParseEquivalentBridge`). */
  const canonicalizeBody = createDocCanonicalizer(mdManager, {
    resolveEmbed: opts.resolveEmbed,
    resolveSize: opts.resolveSize,
    docName: opts.docName,
  });

  // Positive-result memo for the parse-equivalence fallback. A doc resting
  // on a serializer canonicalization (lazy continuations et al.) hits the
  // settlement checks on every drain with the SAME byte pair; the memo
  // caps that at one parse per distinct pair (string compares are 10-100×
  // cheaper than a parse on the per-drain hot path). Negative results are
  // deliberately NOT cached — genuine divergence must keep re-evaluating
  // (and alerting) as the doc changes.
  let memoParseEquivalentLeft = '';
  let memoParseEquivalentRight = '';
  let hasParseEquivalentMemo = false;
  const isRestingParseEquivalent = (left: string, right: string): boolean => {
    if (
      hasParseEquivalentMemo &&
      left === memoParseEquivalentLeft &&
      right === memoParseEquivalentRight
    ) {
      return true;
    }
    const equivalent = isParseEquivalentBridge(left, right, canonicalizeBody);
    if (equivalent) {
      memoParseEquivalentLeft = left;
      memoParseEquivalentRight = right;
      hasParseEquivalentMemo = true;
    }
    return equivalent;
  };

  /**
   * Health-check refinement of `settlesSplitBrain`: a drain settles
   * split-brain only when the byte comparison fails AND the pair is not
   * parse-equivalent. Beyond-tolerance bytes whose parse matches the
   * fragment (organic resting canonicalizations — CommonMark lazy
   * continuations and kin) are a healthy steady state: the router still
   * classifies them as residual-bearing (normalizeBridge untouched, so
   * fragment edits keep the byte-preserving residual merge), but no
   * re-derive is enqueued and no split-brain telemetry fires. The parse
   * runs only after byte + normalize inequality — the drains that would
   * otherwise settle split-brain and pay a full Observer B re-derive.
   */
  const settlesSplitBrainChecked = (settledText: string, md: string, normMdPre?: string): boolean =>
    settlesSplitBrain(settledText, md, normMdPre) && !isRestingParseEquivalent(settledText, md);

  /** Initialize Observer A baseline from current XmlFragment state. */
  try {
    const initialJson = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
    const initialBody = mdManager.serialize(initialJson);
    const initialFrontmatter = readCurrentFm();
    const canonicalInit = prependFrontmatter(initialFrontmatter, initialBody);
    // Observers normally attach after the persistence paired-write seed, so
    // fragment = parse(ytext) and attach is a true settlement point — the raw
    // witness then captures the seed bytes so the first fragment change on a
    // residual-bearing doc routes Path A instead of a spurious Path B merge.
    // But that is an assumption, not a given: a partially-failed paired write
    // can leave the fragment behind Y.Text at attach. Verify parse-
    // equivalence: canonical-vs-canonical through the doc's own parse
    // pipeline (tolerance-independent, residual bytes never flip it), with
    // the boundary-newline handling documented on `isParseEquivalentBridge`
    // (parse(ytext) re-captures sourceDocBoundary forms the live fragment
    // structurally drops — pinned by doc-boundary-fragment-drop.test.ts).
    if (isRestingParseEquivalent(ytext.toString(), canonicalInit)) {
      recordSettledBaselines(canonicalInit);
    } else {
      recordDivergedAttachBaselines(canonicalInit);
    }
  } catch (err) {
    incrementServerObserverError('a');
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)) },
      '[Server Observer A] Baseline init failed — starting from empty snapshot',
    );
    // Canonical '' fails gate 1 open (no short-circuit until a real
    // settlement); the raw witness still snapshots Y.Text so a Path B fire
    // before that settlement merges against a true ancestor, not ''.
    recordSettledBaselines('');
  }

  // Producer guard (read-only). Caps the check at one parse per distinct
  // serialization; a stuck doc re-emitting the same illegal bytes every drain
  // only parses once.
  let lastGuardedBody: string | undefined;
  // Per-doc trailing throttle for the packaged-posture LOG so a doc stuck
  // re-emitting illegal bytes cannot flood the local diagnostics; the throttled
  // count rides the next emit (`fires + suppressed` = actual rate). The throttle
  // gates only the log — the recovery checkpoint is written regardless.
  const PRODUCER_GUARD_LOG_COOLDOWN_MS = 5_000;
  // Quiescence window for the freshness re-derive (see the gate in
  // `runObserverASyncImpl`): an external Y.Text write inside this window marks
  // the doc as actively edited, and the re-derive defers to the next quiet
  // drain. Sized to cover a typing burst's inter-keystroke gaps plus sync
  // jitter under load; costs only re-derive LATENCY on a doc being actively
  // typed into (where the pristine emission is the anchored, safe one anyway).
  const FRESHNESS_QUIESCENCE_MS = 2_000;
  const guardLogState = new Map<string, { lastMs: number; suppressed: number }>();
  // Per-doc last pre-loss source already checkpointed. `lastGuardedBody` dedups
  // identical serializations upstream, but distinct losing bodies can share the
  // same last-good Y.Text; keying the checkpoint on the pre-loss source anchors
  // that state once instead of re-writing an identical checkpoint per body. The
  // entry is set synchronously (before the async write) so concurrent drains
  // and a stuck doc re-emitting the same body dedup to one checkpoint, but it is
  // cleared again if that write fails — a transient failure must not permanently
  // close the recovery window for the pre-loss content.
  const guardCheckpointedPreLoss = new Map<string, string>();

  /**
   * Report a producer-guard content-loss in the packaged posture: a rate-limited
   * structured event (bounded cardinality — doc.name + reason/degrade enums + a
   * construct locator, never raw content) plus a silent checkpoint of the
   * pre-loss source so the state stays user-recoverable. Never throws, never
   * corrective-writes (precedent #38): the drain still persists the bytes
   * as-computed. The guard is a second DETECTION site for the bridge-content-loss
   * class, not a second `BridgeMergeContentLossError` recovery — it uses its own
   * `producer-guard-loss` checkpoint kind and its own fire/suppressed counters.
   *
   * The log throttle and the checkpoint are independent: throttling the log must
   * not drop the recovery anchor, so the checkpoint always attempts (deduped on
   * the pre-loss source) even when the log is suppressed.
   */
  const reportProducerGuardViolation = (
    verdict: Extract<ReturnType<typeof comparePmStructural>, { equivalent: false }>,
    construct: string,
  ): void => {
    const key = opts.docName ?? '__nodoc__';
    const now = Date.now();
    const prev = guardLogState.get(key);
    const throttled = prev !== undefined && now - prev.lastMs < PRODUCER_GUARD_LOG_COOLDOWN_MS;
    if (throttled) {
      prev.suppressed += 1;
      incrementProducerGuardFiresSuppressed();
    } else {
      const suppressedSincePrevious = prev?.suppressed ?? 0;
      guardLogState.set(key, { lastMs: now, suppressed: 0 });
      incrementProducerGuardFires();
      console.warn(
        JSON.stringify({
          event: 'producer-guard-violation',
          docName: opts.docName ?? null,
          reason: verdict.reason,
          construct,
          appliedDegrades: verdict.appliedDegrades,
          suppressedSincePrevious,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    const shadow = opts.shadow?.();
    if (!shadow || !opts.docName) return;
    // Y.Text still holds the last-good source at this point — Observer A writes
    // the (lossy) delta later in the drain — so it is the pre-loss restore
    // anchor, mirroring Path B's pre-merge baseline.
    const preLossSource = ytext.toString();
    if (guardCheckpointedPreLoss.get(key) === preLossSource) return;
    guardCheckpointedPreLoss.set(key, preLossSource);
    const branch = opts.getBranch?.() ?? 'main';
    const contentRoot = opts.contentRoot ?? '';
    const docName = opts.docName;
    queueMicrotask(() => {
      saveInMemoryCheckpoint(shadow, contentRoot, {
        kind: 'producer-guard-loss',
        docName,
        contents: preLossSource,
        label: `Before producer-guard content-loss @ ${new Date().toISOString()}`,
        branch,
        metadata: { construct },
      })
        .then((sha) => {
          incrementProducerGuardCheckpointCreated();
          console.warn(
            JSON.stringify({
              event: 'producer-guard-checkpoint-created',
              docName,
              sha,
              kind: 'producer-guard-loss',
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .catch((checkpointErr: unknown) => {
          // The write failed, so the pre-loss content was NOT actually
          // checkpointed. Reopen the retry window by clearing our dedup entry —
          // only if a later, different pre-loss body has not since replaced it —
          // so the next guard violation on this body attempts the write again
          // instead of permanently skipping via the line-843 early return. The
          // synchronous set() above still dedups concurrent drains and a stuck
          // doc re-emitting the same body while a write is in flight.
          if (guardCheckpointedPreLoss.get(key) === preLossSource) {
            guardCheckpointedPreLoss.delete(key);
          }
          const e =
            checkpointErr instanceof Error ? checkpointErr : new Error(String(checkpointErr));
          log.warn({ err: e }, '[Server Observer A] Producer-guard checkpoint write failed');
          checkpointLog.warn(
            { err: e, 'doc.name': docName, branch, kind: 'producer-guard-loss' },
            'checkpoint write failed',
          );
        });
    });
  };

  /**
   * Producer guard at the moment byte-fate is decided (the Observer-A
   * serialize). A fresh parse of the bytes we are about to persist must
   * reconstruct the same authored CONTENT: markdown never legitimately drops
   * text on a round-trip, so a content-loss verdict means the serializer emitted
   * corrupt bytes that only a fresh parser sees. Container-shatter is
   * deliberately NOT a fire condition — some shatters are inherent CommonMark
   * round-trip limits (a blockquote nested in a Callout re-merges on parse), a
   * fidelity gap the offline I22 property test owns; firing on them here would
   * cry wolf on legal-but-lossy nestings. Dev/test throw loud; packaged reports.
   */
  const runProducerGuard = (json: PmStructuralNode, body: string): void => {
    if (body === lastGuardedBody) return;
    lastGuardedBody = body;
    if (!fragmentContainsDangerSpace(json)) return;

    const reparsed = mdManager.parseWithFallback(body, observerParseOpts) as PmStructuralNode;
    const verdict = comparePmStructural(json, reparsed);
    // Narrow to the failure branch, then to the one reason the guard fires on.
    // The union makes `reason`/`detail` reachable only here, and `detail`
    // required — no optional-fallback crutch.
    if (verdict.equivalent || verdict.reason !== 'content-loss') return;

    if (shouldRethrowBridgeMergeLoss()) {
      throw new ProducerGuardViolationError({
        docName: opts.docName,
        reason: verdict.reason,
        detail: verdict.detail,
      });
    }
    reportProducerGuardViolation(verdict, dangerSpaceLocator(json));
  };

  /**
   * Observer A sync work. Computes delta between the settled baselines and
   * current XmlFragment, applies ONLY that delta to Y.Text.
   */
  const runObserverASyncImpl = (): void => {
    try {
      const json = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
      // Freshness-safety, read BEFORE serialize (the drain is synchronous).
      // The freshness re-derive RESPELLS pristine components (indented nested
      // JSX vs the flush-left bytes the raw history holds), and every
      // convergence mechanism this serialization feeds (the fragment-unchanged
      // gate, the normalize gate, the splice text-match, Path B's line-based
      // diff3, CRDT merge against concurrent keystrokes) anchors on serialize
      // output matching raw-history bytes. A de-anchored write racing live
      // typing duplicates the block in the authoritative bytes (the `<Steps>`
      // source-authoring corruption), so the re-derive is allowed only when
      // BOTH hold:
      //   1. the raw witness is coherent (Y.Text has not visibly advanced past
      //      the settlement this drain anchors on), AND
      //   2. Y.Text is QUIESCENT (no external write within the window) — a
      //      typing burst's in-flight ops can race the write at the CRDT level
      //      even when the witness looks coherent at drain time.
      // Freshness is a standing state check, not an edge trigger: a suppressed
      // divergence is re-observed on the next safe drain, so a genuinely stale
      // component still re-derives (G1 holds) — the deny-listed-origin edits
      // freshness exists for land on fragment-only transactions that never
      // reset the quiescence clock. Only racy drains defer.
      const rawWitnessCoherent = ytext.toString() === lastSyncedYTextBytes;
      const ytextQuiescent = Date.now() - lastExternalYtextChangeMs >= FRESHNESS_QUIESCENCE_MS;
      const freshnessSafe = rawWitnessCoherent && ytextQuiescent;
      const body = mdManager.serialize(json, { skipFreshnessDerive: !freshnessSafe });
      // The guard adjudicates the bytes ONLY when they are current-intent: on a
      // suppressed drain the emission is knowingly historical (pristine
      // sourceRaw a generation behind the live children), so a content-loss
      // verdict would be a false alarm — the next safe drain re-runs the
      // guard against the re-derived bytes.
      if (freshnessSafe) runProducerGuard(json as PmStructuralNode, body);
      const frontmatter = readCurrentFm();
      const md = prependFrontmatter(frontmatter, body);
      const currentText = ytext.toString();

      // Duplication gate (precedent #38, Y.Text-is-truth). A CRDT
      // double-materialization of a bridge-derived span (two writers
      // structurally replacing the same span, both inserts surviving the Y.js
      // merge) leaves the fragment serialization carrying a substantive body
      // line more times than the live Y.Text justifies; without this gate
      // Observer A serializes and persists the doubled bytes as authoritative
      // truth. The cheap growth pre-filter runs on every drain whose fragment
      // moved; only when it fires do we pay the O(children) provenance walk
      // that separates a server-vs-client race (recover) from a legitimate
      // same-client duplication such as a WYSIWYG paste-twice (leave for the
      // router to forward-propagate — recovery would drop the user's paste).
      //
      // On a confirmed race, move BOTH witnesses to the doubled `md` (the
      // diverged-attach witness shape) and enqueue a same-drain Observer B:
      // B's early-exit comparand no longer matches the clean Y.Text, so it
      // rebuilds the single-copy fragment from `parse(Y.Text)` and the doubled
      // `md` is never written to Y.Text. This runs BEFORE Gate 1 so it
      // pre-empts every write path uniformly (the field splice drains have
      // `md !== lastSyncedCanonicalMd`, so Gate 1 would not short-circuit them
      // anyway), and independently of the producer guard's freshness gate
      // (skipped on non-fresh drains) so it covers the drains the loss guard
      // never sees. STOP: this detects structurally and routes to re-derive —
      // it raises and catches no `BridgeMergeContentLossError`; its
      // observability is the `duplication-guard` split-brain site + the
      // dedicated counter + the `observer-a-duplication` checkpoint.
      const overMultiplied = overMultipliedBodyLines(
        md,
        currentText,
        DUPLICATION_GATE_MIN_LINE_LENGTH,
      );
      if (
        overMultiplied.length > 0 &&
        findRaceDuplicatedSpans(xmlFragment, doc.clientID, overMultiplied)
      ) {
        recordDivergedAttachBaselines(md);
        textDirty = true;
        recordSplitBrainRederive('duplication-guard');
        incrementObserverADuplicationRederives();
        saveDuplicationCheckpoint(md, overMultiplied.length);
        setActiveSpanAttributes({ 'observer.a.path': 'gated-duplication-rederive' });
        return;
      }

      // Gate 1 (fragment-unchanged): the fragment's canonical serialization is
      // identical to the recorded canonical witness. Two concerns split here.
      //
      // (1) Split-brain re-derive (correctness, coherence-gated like the
      //     short-circuit below). When the serialization didn't move (e.g. a
      //     blur upgrade swapping a degraded fallback for an empty paragraph)
      //     but Y.Text diverges from the canonical form BEYOND tolerance, the
      //     drain would settle split-brain. There is no fragment delta to
      //     route — `md` equals the canonical witness — so the router cannot
      //     reconcile it; only an Observer B re-derive can rebuild the
      //     fragment from Y.Text (Y.Text-is-truth, precedent #38). Enqueue the
      //     same-drain B and return. Incoherent diverged-attach states do NOT
      //     take this path — they fall through the guard to the router, where
      //     Path B with equal witnesses leaves Y.Text unchanged and the
      //     post-merge settlement check enqueues the same Observer B
      //     re-derive.
      //
      // (2) Perf short-circuit (coherence-GATED). Absent split-brain, skip the
      //     router only when the canonical witness is COHERENT — recorded
      //     together with the raw witness at a real settlement. After a
      //     paired-write reset the canonical witness is deliberately stale
      //     (raw-only refresh, perf), so an incoherent `lastSyncedCanonicalMd
      //     === md` is a cross-generation coincidence that does NOT certify
      //     Y.Text is in sync — fall through to the raw-witness router so the
      //     content propagates.
      if (canonicalWitnessCoherent && lastSyncedCanonicalMd === md) {
        // Fragment serialization is identical to the canonical witness AND the
        // witness is coherent (recorded with the raw witness at a real
        // settlement). Two outcomes:
        //
        // (1) Split-brain re-derive. If Y.Text still diverges from the
        //     canonical form BEYOND tolerance (e.g. a blur upgrade swapped a
        //     degraded fallback for an empty paragraph while Y.Text holds the
        //     true broken source), the drain would settle split-brain. There
        //     is no fragment delta to route — `md` equals the canonical
        //     witness — so only an Observer B re-derive can rebuild the
        //     fragment from Y.Text (Y.Text-is-truth, precedent #38). Enqueue
        //     the same-drain B. Coherence is the discriminator from the
        //     forward-propagation case (a paired-write reset leaves the
        //     canonical witness STALE/incoherent at a prior content's form
        //     that the repopulated fragment coincidentally re-matches — there
        //     Y.Text must be updated FROM the fragment via the router, so that
        //     case is excluded by the coherence guard and falls through).
        //
        // (2) Perf short-circuit. Absent split-brain, the fragment is at the
        //     witnessed settlement and Y.Text agrees — nothing to do.
        if (settlesSplitBrainChecked(ytext.toString(), md)) {
          // Force Observer B to re-derive in this same drain: move BOTH
          // witnesses to the canonical form so B's early-exit comparand
          // (`normalizeBridge(lastSyncedYTextBytes)`) no longer matches the
          // divergent Y.Text and B rebuilds the fragment from Y.Text. This is
          // the diverged-attach witness shape (canonical-for-both, incoherent)
          // — the router would treat Y.Text as holding unabsorbed changes, but
          // we enqueue B directly so the fragment converges this drain. B's
          // post-fire `recordSettledBaselines` re-establishes the true
          // settlement witnesses.
          recordDivergedAttachBaselines(md);
          textDirty = true;
          recordSplitBrainRederive('identity-gate');
          setActiveSpanAttributes({ 'observer.a.path': 'gated-fragment-unchanged-rederive' });
        } else {
          // Bounded enum, same value set as the router below — every exit
          // path of the sync impl stamps `observer.a.path`, so a missing
          // attribute in a trace means a real gap, not a silent short-circuit.
          setActiveSpanAttributes({ 'observer.a.path': 'gated-fragment-unchanged' });
        }
        return;
      }

      // `currentText` was read once above the duplication gate; Y.Text is not
      // mutated between there and here (the gates above only read it), so the
      // snapshot is still current.

      // Already-in-sync gate: if Y.Text already matches XmlFragment (after
      // bridge normalization), just update baselines — the gate certifies a
      // settlement point. The normalization handles trailing newline
      // differences between raw Y.Text and serialized XmlFragment
      // (remark-stringify adds a trailing newline). The normalized forms are
      // cached for the drain: every additional full-doc normalizeBridge pass
      // is O(doc bytes), and on large docs the per-drain normalize count is
      // what bounds convergence latency under bursts (measured: the fuzz
      // convergence budget overran ~50% on a 675 KB doc before the residual
      // classification below went lazy).
      const normCurrent = normalizeBridge(currentText);
      const normMd = normalizeBridge(md);
      if (normCurrent === normMd) {
        setActiveSpanAttributes({ 'observer.a.path': 'gated-in-sync' });
        recordSettledBaselines(md);
        return;
      }

      const preMergeBaseline = lastSyncedYTextBytes;
      const ytextInSync = currentText === lastSyncedYTextBytes;
      // Witness-vs-witness residual classification — meaningful only when
      // both witnesses come from the same settlement generation (coherence
      // flag). In-sync docs whose settled bytes diverge from canonical BEYOND
      // normalizeBridge tolerance (NG-class constructs: un-padded GFM tables,
      // multi-blank lines, doc-start thematic breaks, PUA sentinels — storage
      // never sanitizes) must NOT be wholesale-rewritten toward canonical:
      // that would mutate user files on a mere editor-mount artifact.
      // Evaluation is LAZY left-to-right: the normalize pass runs only on
      // in-sync, coherent, witness-distinct drains — a diverged or
      // incoherent drain (where the classification cannot matter: the router
      // takes path-b / the Path-A fallback regardless) pays zero extra
      // passes. `ytextInSync` implies `lastSyncedYTextBytes === currentText`,
      // so the raw-witness normalize reuses the gate-2 `normCurrent`; the
      // marginal cost is one normalize of the canonical witness.
      const residualMergeEligible =
        ytextInSync &&
        canonicalWitnessCoherent &&
        lastSyncedYTextBytes !== lastSyncedCanonicalMd &&
        normCurrent !== normalizeBridge(lastSyncedCanonicalMd);
      // Routing decision, span-visible. The outcomes are byte-different
      // write behaviors that are otherwise indistinguishable in traces.
      // Bounded cardinality: a 4-value enum — 'map-driven-splice' overrides
      // below once the splice computation succeeds (it is computed after
      // this stamp because it needs the parse).
      setActiveSpanAttributes({
        'observer.a.path': ytextInSync
          ? residualMergeEligible
            ? 'residual-merge'
            : 'path-a'
          : 'path-b',
      });
      // Captured merged-text length, populated inside the transact closure
      // when either merge branch runs. Plain object container so TS widening
      // through the closure assignment doesn't collapse to `never`.
      const pathBState: { mergedText: string | null } = { mergedText: null };

      // Map-driven Path A (default): when Y.Text matches baseline + this
      // isn't a synthetic doc, compute a block-aligned source-byte splice
      // from the mdast position map and rewrite only the changed range.
      // Bytes outside the splice survive in Y.Text byte-identically — a
      // concurrent non-paired WYSIWYG edit no longer canonicalizes the
      // untouched blocks an agent's exact-match find targets. Falls back
      // to applyIncrementalDiff when the splice can't be computed (parse
      // failure, a block missing mdast position offsets). The structural
      // block comparison inside computeMapDrivenBodySplice is data-aware
      // (data.source* differences count as changes) — stripping data from
      // that comparison silently drops concurrent source-form edits such
      // as delimiter-row padding changes; see the dash-count tripwire in
      // map-driven-observer-a.test.ts.
      const spliceComputeStart = performance.now();
      const mapDrivenSplice =
        // Beyond-tolerance in-sync docs belong to the residual merge below
        // (canonical-base fragment-delta splice into raw bytes) — the splice
        // owns Path A's domain only, replacing the wholesale canonical
        // rewrite, never the residual-preservation path.
        ytextInSync && residualMergeEligible
          ? null
          : tryComputeMapDrivenSplice({
              currentText,
              // The raw settled witness — the same router-comparable surface
              // `ytextInSync` reads, so the splice's internal text-match gate
              // is exactly the in-sync predicate.
              lastSyncedXmlMd: lastSyncedYTextBytes,
              json,
              mdManager,
              docName: opts.docName,
            });
      if (mapDrivenSplice) {
        setActiveSpanAttributes({
          'observer.a.path': 'map-driven-splice',
          // The splice's three full-document passes are the documented
          // unbounded-by-doc-size cost on this path (map-driven-splice.ts
          // perf envelope) — stamped so a large-doc drain-latency trace
          // answers "where did the time go" without reproduction. Integer ms
          // keeps the attribute bounded-cardinality.
          'observer.a.splice.compute_ms': Math.round(performance.now() - spliceComputeStart),
        });
      }

      doc.transact(() => {
        if (mapDrivenSplice) {
          // Map-driven splice — Path A's default: block-aligned source-byte
          // rewrite of only the changed range, strictly more byte-preserving
          // than the wholesale canonical rewrite below. Residual-eligible
          // docs never reach here (nulled at computation), and a diverged
          // doc fails the splice's internal text-match — so this branch
          // serves exactly the in-sync-within-tolerance drains.
          applyMapDrivenSplice(ytext, mapDrivenSplice);
        } else if (ytextInSync && !residualMergeEligible) {
          // Path A: Y.Text at baseline AND residual within tolerance (or
          // witness state unusable: stale-after-paired-write / error-recovery
          // '') — the sanctioned canonical rewrite.
          applyIncrementalDiff(ytext, currentText, md);
        } else {
          // Single merge call site, conditional base:
          //  - in-sync + beyond-tolerance residual → canonical-base
          //    fragment-delta merge: diff3 computes base→ours (the fragment
          //    edit, in canonical space) and splices ONLY that delta into the
          //    raw Y.Text bytes; untouched NG-class constructs survive. NOT a
          //    divergence fire — no telemetry below.
          //  - diverged → Path B with the raw-witness base (a true Y.Text
          //    ancestor).
          // mergeThreeWay's post-condition throws BridgeMergeContentLossError
          // if content is dropped by the merge. Production policy: log a
          // structured event, queue a silent version-history checkpoint of
          // the pre-merge state (`saveInMemoryCheckpoint`), and apply the
          // merge as-computed so the editor keeps responding. Dev/test
          // re-throws so integration tests and fuzz runs fail loudly.
          const mergeBase = ytextInSync ? lastSyncedCanonicalMd : preMergeBaseline;
          // Doc-boundary byte-space alignment (full mechanism in
          // doc-boundary-space.ts): `md` is a fragment serialization that
          // lacks the FM-close-fence-to-body newline run the raw-space inputs
          // carry, so the line-positional diff3 would misalign at the boundary
          // and fabricate content. Project all three inputs into one merge
          // byte-space, merge, and re-attach the current Y.Text's boundary
          // bytes verbatim — Y.Text is the only surface that can author them
          // (precedent #38). Both apply paths project through the same closure
          // so they cannot drift.
          const { boundary } = splitLeadingDocBoundary(currentText);
          const projectMerged = (merged: string): string =>
            reattachLeadingDocBoundary(splitLeadingDocBoundary(merged).text, boundary);
          const mergeThreeWayFn = opts.mergeThreeWay ?? mergeThreeWay;
          try {
            const mergedText = projectMerged(
              mergeThreeWayFn(
                projectMergeBoundarySpace(mergeBase),
                projectMergeBoundarySpace(md),
                projectMergeBoundarySpace(currentText),
              ),
            );
            applyFastDiff(ytext, currentText, mergedText);
            pathBState.mergedText = mergedText;
          } catch (mergeErr) {
            if (!(mergeErr instanceof BridgeMergeContentLossError)) throw mergeErr;
            // Checkpoint payload stays the raw witness: in the in-sync branch
            // it equals currentText (the true pre-merge Y.Text state).
            handleBridgeMergeLoss(mergeErr, preMergeBaseline);
            // Throw-gate polarity: throw only when the runtime affirmatively
            // identifies itself as a test (see `shouldRethrowBridgeMergeLoss`
            // JSDoc for why the gate is affirmative, not `!== 'production'`).
            if (shouldRethrowBridgeMergeLoss()) throw mergeErr;
            // Apply the merge's as-computed result so the editor progresses,
            // boundary re-projected exactly as the success path does. The
            // `bridge-merge-content-loss` event above logged the pre-projection
            // `info.result`, so its `resultLen` is the merge-space length, not
            // the length of these applied bytes.
            const asComputed = projectMerged(mergeErr.info.result);
            applyFastDiff(ytext, currentText, asComputed);
            pathBState.mergedText = asComputed;
          }
        }
      }, OBSERVER_SYNC_ORIGIN);

      // Splice-path health counter — the fallback side increments inside
      // `tryComputeMapDrivenSplice`, so `applied / (applied + Σfallback)`
      // tracks how often the byte-preserving default actually serves drains.
      if (mapDrivenSplice) incrementMapDrivenSpliceApplied();

      // Telemetry: emit one structured event per Path B fire so
      // operators can track the slow-path cost. Bounded cardinality —
      // attrs are booleans + a numeric byte-delta, no doc content. This
      // sits AFTER the transact so the merged-text length is known.
      //
      // Gated on the DIVERGENCE branch (`!ytextInSync`), not on "the merge
      // machinery ran": the in-sync canonical-base residual merge is not a
      // Path-B fire, so "Path B fires iff Y.Text diverged" stays literally
      // true and `fires + suppressed` keeps counting divergence fires
      // exactly.
      //
      // Rate-limited per doc through `emitObserverAPathBFired` (mirroring
      // the watchdog's `bridge-invariant-violation` and
      // `bridge-tolerance-applied` rate-limiters): under multi-peer
      // concurrent editing or a degenerate baseline-staleness loop, Path
      // B can fire many times per second per doc, drowning the very
      // signal operators need. The counter increments only on emit,
      // matching the bridge-invariant-violation pattern; the suppressed
      // counter is bumped inside `emitObserverAPathBFired` when the gate
      // closes, so `actual_rate = observerAPathBFires +
      // observerAPathBFiresSuppressed` holds (each fire bumps exactly
      // one of the two).
      if (pathBState.mergedText !== null && !ytextInSync) {
        if (emitObserverAPathBFired(opts.docName)) {
          incrementObserverAPathBFires();
          console.warn(
            JSON.stringify({
              event: 'observer-a-path-b-fired',
              'doc.name': opts.docName ?? null,
              // Gate 1 above structurally guarantees the fragment's canonical
              // form advanced before this site is reachable.
              xmlFragmentAdvanced: true,
              ytextDiverged: !ytextInSync,
              mergeBytesChanged: Math.abs(pathBState.mergedText.length - currentText.length),
            }),
          );
        }
      }

      // Volume signal for the in-sync canonical-base residual merge — the
      // sibling slow path the divergence-scoped Path B counters deliberately
      // exclude. Counter only: no per-fire console event, nothing to
      // rate-limit.
      if (pathBState.mergedText !== null && ytextInSync) {
        incrementObserverAResidualMergeRuns();
      }

      incrementServerObserverFire('a');
      // The raw witness snapshots the ACTUAL Y.Text state after the write,
      // not the XmlFragment serialization (md). Under either merge branch,
      // the merged bytes preserve content from Y.Text that wasn't in
      // XmlFragment (concurrent source-mode edits under Path B; untouched
      // NG-class residual bytes under the in-sync canonical-base merge). A
      // canonical-form raw witness would cause the NEXT firing to re-diff
      // "old XmlFragment → new XmlFragment" and re-include content already
      // in Y.Text — producing duplication.
      // The canonical witness records `md` (the serialization just computed)
      // so gate 1 keeps short-circuiting fragment-unchanged settlements on
      // residual docs.
      recordSettledBaselines(md);

      // Split-brain settlement guard (Y.Text-is-truth, precedent #38). After
      // the write, the raw witness is at the post-write ytext and the canonical
      // witness is at md. The checked predicate fires on a beyond-tolerance
      // residual whose parse does NOT match the fragment — a genuinely
      // degraded divergence. A parse-equivalent resting canonicalization
      // (lazy continuations and other organic constructs the serializer
      // re-shapes: storage never sanitizes) is a healthy steady state and is
      // excluded here, while the two-witness router still classifies it as
      // residual-bearing: the next fragment-change drain sees the
      // beyond-tolerance residual and routes the byte-preserving
      // residual-merge (row 2), never a wholesale Path A rewrite. On a
      // genuine fire we enqueue a same-drain Observer B to ATTEMPT
      // convergence (Y.Text-is-truth re-derive), deliberately WITHOUT moving
      // the witnesses to the canonical form: only a genuinely irreducible
      // fallback divergence keeps B re-deriving (B early-exits when its
      // raw-witness comparand equals the current ytext). Forcing the
      // diverged-attach witness shape here would wrongly re-derive every
      // residual doc on every WYSIWYG edit (regressing the residual-merge
      // steady state); the bytes are already safe either way.
      if (settlesSplitBrainChecked(ytext.toString(), md, normMd)) {
        textDirty = true;
        recordSplitBrainRederive('post-merge');
      }
    } catch (err) {
      // A BridgeMergeContentLossError rethrown by Path B's single catch site
      // (under `shouldRethrowBridgeMergeLoss`) is a dev/test loud-failure
      // signal, not an Observer A failure to recover from. Pass it through
      // this soft-recovery layer so the test runner sees it, mirroring
      // Observer B's `BridgeInvariantViolationError` rethrow. This is a
      // rethrow passthrough, NOT a second handle site: Path B remains the
      // only place that logs + checkpoints + applies the merge.
      if (err instanceof BridgeMergeContentLossError) {
        throw err;
      }
      // Same passthrough for the producer guard's dev/test loud-failure throw —
      // it fires before any Y.Text write, so there is nothing to recover; let
      // the test runner see it. Packaged posture never throws here.
      if (err instanceof ProducerGuardViolationError) {
        throw err;
      }
      incrementServerObserverError('a');
      log.error({ err }, '[Server Observer A] Failed to sync tree→text');
      // Reset the witnesses so the next retry computes a fresh delta instead
      // of re-applying the stale diff that just failed. The naive reset
      // records the raw Y.Text as a settled witness, but if the throw
      // happened BEFORE the settlement check (e.g. inside a merge transact
      // while Y.Text is still divergent), that is a FALSE witness: the next
      // drain would see Y.Text in sync with the (incoherent) router and could
      // rewrite Y.Text toward the fallback-derived serialization, destroying
      // the source bytes. So recompute the canonical form and, when it still
      // settles split-brain vs Y.Text, record a coherent split-brain pair
      // (canonical = recoveryMd truthful, raw = the divergent Y.Text) and
      // enqueue a same-drain Observer B re-derive — the next A drain then sees
      // a beyond-tolerance residual and takes the byte-preserving
      // residual-merge (row 2) while B rebuilds the fragment from Y.Text
      // (Y.Text-is-truth, precedent #38), the identical correction the two
      // settlement-exit sites apply. When NOT split-brain, Y.Text and the
      // fragment agree within tolerance — a true settlement, so record both
      // witnesses coherently at the recovered canonical form.
      try {
        const recoveryJson = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
        const recoveryBody = mdManager.serialize(recoveryJson);
        const recoveryMd = prependFrontmatter(readCurrentFm(), recoveryBody);
        if (settlesSplitBrainChecked(ytext.toString(), recoveryMd)) {
          recordSplitBrainRecoveryBaselines(recoveryMd);
          textDirty = true;
          recordSplitBrainRederive('error-recovery');
        } else {
          recordSettledBaselines(recoveryMd);
        }
      } catch (innerErr) {
        // Recompute itself can throw (the original failure may have come from
        // serialize). With no canonical form available, the divergence check
        // is impossible — witnessing raw Y.Text here could be the same false
        // witness the settlement sites guard against. Fall back to the empty
        // unknown-baseline sentinel (the baseline-init failure fallback
        // above): the next drain fails Path A's gate and routes through Path
        // B's byte-protective merge instead of an unguarded rewrite. An
        // operator triaging the double failure needs the doc and the original
        // error correlated in one line, not two disconnected ones.
        log.warn(
          {
            docName: opts.docName ?? null,
            originalError: err instanceof Error ? err.message : String(err),
            recoveryError: innerErr instanceof Error ? innerErr.message : String(innerErr),
          },
          '[Server Observer A] Baseline recovery also failed',
        );
        // Last-resort unknown-baseline sentinel: no canonical form is
        // computable (the recovery serialize threw too), so the divergence
        // check is impossible and witnessing the raw Y.Text could be the same
        // false witness the settlement sites guard against. Set BOTH witnesses
        // to the empty sentinel: canonical '' fails gate 1 open, and an empty
        // raw witness makes the next drain's `ytextInSync` comparison FALSE,
        // routing through Path B's byte-protective merge against a true
        // (empty) ancestor rather than a wholesale Path A rewrite that would
        // destroy the divergent source. Coherence stays false.
        lastSyncedCanonicalMd = '';
        lastSyncedYTextBytes = '';
        canonicalWitnessCoherent = false;
      }
    }
  };

  // Wrap with withSpanSync so Observer A emits an OTel span per fire.
  // The router inside the impl stamps the routing decision on the active
  // span as 'observer.a.path' ('map-driven-splice' | 'path-a' |
  // 'residual-merge' | 'path-b'); the gate short-circuits stamp
  // 'gated-fragment-unchanged-rederive' / 'gated-fragment-unchanged' /
  // 'gated-in-sync', so every exit path of the sync impl sets the attribute.
  // Zero-overhead when OTEL_SDK_DISABLED is true (recordException
  // is no-op when the tracer is disabled).
  const runObserverASync = (): void => {
    withSpanSync(
      'observer.runASync',
      { attributes: { 'doc.name': opts.docName ?? '' } },
      runObserverASyncImpl,
    );
  };

  /**
   * Observer A callback — fires on every XmlFragment deep change.
   * Origin guards prevent infinite loops and opt the paired-write fast-path
   * out of settlement-handler dispatch.
   */
  const observerA = (_events: Y.YEvent<Y.XmlFragment>[], transaction: Y.Transaction) => {
    // Self-skip: our own cross-CRDT write
    if (transaction.origin === OBSERVER_SYNC_ORIGIN) return;

    // Paired-write origins atomically wrote both XmlFragment and Y.Text inside
    // this transaction. Under the Y.Text-is-truth contract, ytext holds the
    // raw bytes the writer composed (which may diverge from serialize(fragment)
    // on inputs where parse→serialize normalizes — e.g., a leading "\n\n"
    // delimiter that mdast drops). We refresh the raw witness from ytext to
    // match the post-Path-A/B convention at the end of `runObserverASync`. A
    // serialize(fragment) value here would force every subsequent user
    // keystroke through Path B's mergeThreeWay because the strict-equality
    // Path A gate fails (raw ≠ canonical) — under stress this exceeds the
    // multi-turn timeout. See `isPairedWriteOrigin` JSDoc for the fuzz seed.
    // The canonical witness is deliberately left stale: serializing the
    // fragment here would add an O(N) serialize to the synchronous paired
    // hot path, and gate-1 staleness is fail-open (md ≠ stale-canonical →
    // proceed to gate 2/router, which are correct). The raw-only refresh
    // also clears the coherence flag — the witnesses now span two settlement
    // generations, so the router's residual-tolerance comparison is
    // meaningless and it falls back to Path A in this window.
    if (isPairedWriteOrigin(transaction.origin)) {
      try {
        const frontmatter = readCurrentFm();
        refreshYTextWitness();
        // Refresh the FM telemetry baseline alongside the bridge baseline.
        // Without this, an agent paired-write that changes FM advances
        // the raw witness but leaves `priorFmForTelemetry` stale; the
        // next user source-mode body-only edit then fires a spurious
        // `recordFrontmatterEditSurface('source-mode')` because the FM
        // comparison sees the agent's FM change. Telemetry-only impact —
        // double-attribution of FM edits to the wrong surface.
        priorFmForTelemetry = frontmatter;
      } catch (err) {
        incrementServerObserverError('a');
        log.warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          '[Server Observer A] Paired-write baseline refresh failed — falling through to settlement',
        );
        // Fall through to the settlement path so the next afterAllTransactions
        // dispatch can recover. The runObserverASync catch block resets the
        // baseline from Y.Text if the underlying issue persists.
        xmlDirty = true;
      }
      return;
    }

    xmlDirty = true;
  };

  // ─── Initial sync: populate Y.Text from XmlFragment if empty ──
  if (xmlFragment.length > 0 && ytext.length === 0) {
    try {
      const json = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
      const body = mdManager.serialize(json);
      const frontmatter = readCurrentFm();
      const md = prependFrontmatter(frontmatter, body);
      doc.transact(() => {
        ytext.insert(0, md);
      }, OBSERVER_SYNC_ORIGIN);
      // ytext was just set to md inside the transact, so the raw read
      // returns md — the surfaces coincide at this settlement point.
      recordSettledBaselines(md);
    } catch (err) {
      incrementServerObserverError('a');
      log.error({ err }, '[Server Observer A] Failed initial sync');
      // Reset baselines to match Y.Text's actual state (still empty) so the
      // next Observer A firing treats the entire XmlFragment as new content
      // via Path A (incremental diff from empty → full doc). Without this,
      // the witnesses hold the full doc from init while Y.Text is empty —
      // Path B's DMP patch_apply would fail (no matching context in empty
      // string). The raw read returns '' here because the insert never ran.
      recordSettledBaselines('');
    }
  }

  // ─── Observer B: Y.Text → XmlFragment ─────────────────────

  /**
   * Observer B sync work. Parses Y.Text markdown and applies to XmlFragment
   * via updateYFragment. Frontmatter lives in Y.Text directly — the
   * observer only needs to strip the FM region before parsing the body.
   *
   * Under the settlement dispatcher, this always runs AFTER runObserverASync
   * within the same drain (when both flags are set), so any fresh XmlFragment
   * state from Observer A's write is already visible to this pass.
   */
  let priorFmForTelemetry = readCurrentFm();
  const runObserverBSyncImpl = (): void => {
    try {
      const md = ytext.toString();
      const { frontmatter, body } = stripFrontmatter(md);

      // Early-exit: if Y.Text already matches the last settled Y.Text
      // snapshot (via normalizeBridge), tree and text are in sync.
      // Uses the maintained raw witness instead of a fresh
      // serialize(XmlFragment) call — the witness is refreshed on every
      // Observer A path and on every paired-write origin's synchronous
      // short-circuit, so it always reflects the last settlement. Reading
      // the raw witness keeps this comparand uniform with the router's:
      // an in-tolerance parse-invisible Y.Text edit early-exits here
      // WITHOUT refreshing any witness, so the router still sees it as
      // real divergence and routes the next fragment change through the
      // byte-preserving Path B merge.
      if (normalizeBridge(lastSyncedYTextBytes) === normalizeBridge(md)) {
        // Tree and text are already in sync. FM region is already where it
        // should be (Y.Text is the source of truth). Just emit telemetry if
        // the FM changed.
        if (priorFmForTelemetry !== frontmatter) {
          recordFrontmatterEditSurface('source-mode');
          priorFmForTelemetry = frontmatter;
        }
        return;
      }

      // Bridge always-live: parseWithFallback never throws — it always
      // produces a valid JSONContent tree, falling back to rawMdxFallback
      // for unparseable spans. `observerParseOpts` threads `resolveEmbed` +
      // `sourcePath` so `![[photo.png]]` mdast nodes resolve to disk paths
      // before PM dispatch. Under server-authoritative architecture
      // (precedent #14), this observer is the sole writer for XmlFragment —
      // the "always-live" contract here means no client sees frozen WYSIWYG
      // when another peer is mid-typing a broken MDX tag.
      const parsedJson = mdManager.parseWithFallback(body, observerParseOpts);

      const pmNode = opts.schema.nodeFromJSON(parsedJson);

      doc.transact(() => {
        const meta = { mapping: new Map(), isOMark: new Map() };
        updateYFragment(doc, xmlFragment, pmNode, meta);
      }, OBSERVER_SYNC_ORIGIN);

      if (priorFmForTelemetry !== frontmatter) {
        recordFrontmatterEditSurface('source-mode');
        priorFmForTelemetry = frontmatter;
      }

      incrementServerObserverFire('b');

      // Y.Text-is-truth contract: no canonicalize-write-back to Y.Text.
      // Y.Text holds the user's intended source-form bytes; XmlFragment
      // derives via parse(ytext). The watchdog asserts the bridge invariant
      // (modulo `normalizeBridge` tolerance) and fires telemetry/throws on
      // outside-tolerance divergence; it does NOT mutate Y.Text.
      //
      // The right-hand side of the bridge invariant is `serialize(parsedJson)`
      // — equivalent to `serialize(fragment)` after Phase 1's updateYFragment
      // landed `parsedJson` into XmlFragment. Using parsedJson (already in
      // scope) instead of re-reading XmlFragment avoids one O(N) traversal
      // per fire — under bursty edits (chunked-paste is 20× 50 KB
      // transactions, each triggering one B fire), the difference matters.
      // The compose can throw on a non-roundtrip-stable parse; baseline
      // recovery falls back to the input body so Observer A's next delta
      // computation sees a coherent starting point.
      try {
        const canonicalBody = mdManager.serialize(parsedJson);
        const canonicalYText = prependFrontmatter(frontmatter, canonicalBody);
        assertBridgeInvariant(ytext.toString(), canonicalYText, {
          site: 'observer-b',
          docName: opts.docName,
          // One-shot reuse of the canonicalization this fire just computed:
          // the watchdog's fallback canonicalizes the SAME body B parsed
          // above, and re-running parse+serialize per fire is exactly the
          // extra O(N) pass the parsedJson reuse note above exists to avoid.
          canonicalizeBody: (b) => (b === body ? canonicalBody : canonicalizeBody(b)),
        });
        // Maintain Observer A's witnesses — B just absorbed Y.Text into the
        // fragment, a true settlement point. The canonical witness records
        // the canonical serialization so Observer A's gate 1
        // (`lastSyncedCanonicalMd === md`) short-circuits while the fragment
        // is unchanged; the raw witness snapshots the actual (possibly
        // residual-bearing) Y.Text bytes the router strict-compares — a
        // canonical value there would misroute the next fragment change to
        // Path B on any in-tolerance residual doc.
        recordSettledBaselines(canonicalYText);
      } catch (reserializeErr) {
        // Watchdog violations re-throw past every soft-recovery catch up to
        // whatever drove the original transaction. In test mode the test
        // runner sees the loud failure; in prod the watchdog already emits
        // (rate-limited) and returns, so this path is unreachable.
        if (reserializeErr instanceof BridgeInvariantViolationError) {
          throw reserializeErr;
        }
        log.warn(
          { err: reserializeErr },
          '[Server Observer B] Post-sync re-serialization failed — using input body as baseline',
        );
        recordSettledBaselines(prependFrontmatter(frontmatter, body));
      }
    } catch (err) {
      // Watchdog violations re-throw all the way past the outer Observer B
      // recovery. The error is not an Observer B failure to recover from —
      // it's a dev/test-only contract violation that should fail loud.
      if (err instanceof BridgeInvariantViolationError) {
        throw err;
      }
      incrementServerObserverError('b');
      log.error({ err }, '[Server Observer B] Failed to sync text→tree');
      // Reset the canonical witness to current XmlFragment state so the next
      // retry computes a fresh delta instead of re-applying the stale diff
      // that just failed. The raw witness is deliberately NOT touched: this
      // is not a settlement point — B failed to absorb Y.Text, so fragment
      // and Y.Text are genuinely diverged. Leaving the raw witness at the
      // last true settlement means the next fragment change routes Path B
      // with a true ancestor base and merges the unabsorbed Y.Text content.
      try {
        const postJson = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
        const postBody = mdManager.serialize(postJson);
        const fm = readCurrentFm();
        refreshCanonicalWitnessOnly(prependFrontmatter(fm, postBody));
      } catch (innerErr) {
        // Mirror the two `instanceof BridgeInvariantViolationError` catches
        // above — preserve `BridgeInvariantViolationError` throws past this
        // soft-recovery layer. No current path through `mdManager.serialize`
        // raises a contract error, but a future change adding an
        // `assertBridgeInvariant` inside the recovery body would otherwise
        // be silently swallowed, defeating the dev/test loud-failure gate.
        if (innerErr instanceof BridgeInvariantViolationError) {
          throw innerErr;
        }
        log.warn({ err: innerErr }, '[Server Observer B] Baseline recovery also failed');
      }
    }
  };

  // Wrap with withSpanSync so Observer B emits an OTel span per fire.
  const runObserverBSync = (): void => {
    withSpanSync(
      'observer.runBSync',
      { attributes: { 'doc.name': opts.docName ?? '' } },
      runObserverBSyncImpl,
    );
  };

  /**
   * Observer B callback — fires on every Y.Text change.
   * Origin guards prevent infinite loops and opt the paired-write fast-path
   * out of settlement-handler dispatch.
   */
  const observerB = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
    // Self-skip: our own cross-CRDT write
    if (transaction.origin === OBSERVER_SYNC_ORIGIN) return;

    // Paired-write origins atomically wrote both XmlFragment and Y.Text inside
    // this transaction. Symmetric counterpart to Observer A's branch above.
    // Under the Y.Text-is-truth contract
    // ytext holds the raw bytes the writer composed (which may diverge from
    // serialize(fragment) on inputs where parse→serialize normalizes), so
    // the raw witness must be refreshed from ytext to match the
    // post-Path-A/B convention. Today `composeAndWriteRawBody` writes ytext
    // first → fragment second, so Observer A's symmetric branch above runs
    // last and would win regardless. We still refresh from ytext here for
    // structural symmetry — a future paired-write origin that mutates
    // fragment first → ytext second (or only ytext) would otherwise leave
    // a stale raw witness and re-introduce the bug class. Decline
    // to set textDirty — the settlement handler has nothing to dispatch
    // for this drain on the paired-write path.
    if (isPairedWriteOrigin(transaction.origin)) {
      try {
        const frontmatter = readCurrentFm();
        refreshYTextWitness();
        // Refresh FM telemetry baseline alongside the bridge baseline.
        // Symmetric counterpart to Observer A's fast-path branch — see the
        // rationale comment there.
        priorFmForTelemetry = frontmatter;
      } catch (err) {
        incrementServerObserverError('b');
        log.warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          '[Server Observer B] Paired-write baseline refresh failed — falling through to settlement',
        );
        // Fall through so the next afterAllTransactions can reconcile via
        // runObserverBSync's own recovery branches.
        textDirty = true;
      }
      return;
    }

    lastExternalYtextChangeMs = Date.now();
    textDirty = true;
  };

  // ─── Settlement dispatcher (precedent #13(b)) ────────
  /**
   * Runs once per outermost `doc.transact()` drain after observers have fired
   * synchronously. Inspects the batch of transactions:
   *
   * - If no observer flagged dirty state (self-origin or paired-write only),
   *   dispatch nothing — baseline was already kept consistent inside the
   *   observer callbacks.
   * - Otherwise dispatch Observer A's sync first (its Y.Text write is
   *   visible to B's read), then Observer B's. Both are synchronous; each
   *   clears its flag before running so a reentrant transact started by
   *   the sync work doesn't double-dispatch.
   */
  const afterAll = (_doc: Y.Doc, transactions: Y.Transaction[]): void => {
    // Wrap the dispatch decision in a span so OTLP queries can attribute
    // work to the right kind ('a' / 'b' / 'a-then-b' / 'none'). Inner code
    // stamps the dispatch attribute via setActiveSpanAttributes once the
    // decision is made.
    withSpanSync(
      'observer.dispatch',
      { attributes: { 'doc.name': opts.docName ?? '' } },
      (span) => {
        if (!xmlDirty && !textDirty) {
          span.setAttribute('observer.dispatch', 'none');
          opts.onDispatch?.('none');
          return;
        }
        if (transactions.every((t) => t.origin === OBSERVER_SYNC_ORIGIN)) {
          xmlDirty = false;
          textDirty = false;
          span.setAttribute('observer.dispatch', 'none');
          opts.onDispatch?.('none');
          return;
        }

        // Observer A FIRST: when both flags are set — either a single
        // non-paired transaction mutated both CRDTs (rare), or A's
        // settlement check (`settlesSplitBrain`) enqueued a same-drain B
        // re-derive because the drain would otherwise settle beyond bridge
        // tolerance — A's write of Y.Text is visible to B's subsequent read
        // and B either early-exits via its normalize gate or rebuilds the
        // fragment from Y.Text. The A-before-B execution order is
        // load-bearing: B's `if (textDirty)` guard reads the live flag, so A
        // must run first to get the chance to enqueue B into the same drain.
        // This mirrors the debounce-era "defer Observer B while Observer A
        // pending" behavior but is now synchronous and ordered rather than
        // time-coupled.
        const ranA = xmlDirty;
        if (xmlDirty) {
          xmlDirty = false;
          opts.onDispatch?.('a');
          runObserverASync();
        }
        // Span-label accuracy only: the `if (textDirty)` guard below reads
        // the live flag either way, so B always ran correctly — capturing
        // `ranB` after A runs just makes the span attribute report
        // 'a-then-b' for drains where A's settlement check enqueued B.
        const ranB = textDirty;
        if (textDirty) {
          textDirty = false;
          opts.onDispatch?.('b');
          runObserverBSync();
        }
        // Stamp the final dispatch decision on the span. 'a-then-b'
        // is reported when both ran in the same drain (rare but
        // semantically distinct from sequential 'a' or 'b').
        span.setAttribute(
          'observer.dispatch',
          ranA && ranB ? 'a-then-b' : ranA ? 'a' : ranB ? 'b' : 'none',
        );
      },
    );
  };

  // ─── Subscribe ─────────────────────────────────────────────
  xmlFragment.observeDeep(observerA);
  ytext.observe(observerB);
  doc.on('afterAllTransactions', afterAll);
  // Pull-based backlog probe for the workload gauges: sampled only at
  // metric-export time, so the observer hot path stays untouched.
  const unregisterDirtyProbe = registerBridgeDirtyProbe(() => xmlDirty || textDirty);
  // Quiescence tracking lives in its own module to avoid `Date.now()` /
  // `setTimeout` here (precedent #13(b) — bridge-no-wallclock guard).
  // `attachQuiescenceTracker` hooks `afterTransaction` + `afterAllTransactions`
  // and exposes `isDocQuiescent(doc)` for the persistence quiescence gate.
  const detachQuiescence = attachQuiescenceTracker(doc);

  // ─── Cleanup ───────────────────────────────────────────────
  return () => {
    unregisterDirtyProbe();
    detachQuiescence();
    doc.off('afterAllTransactions', afterAll);
    xmlFragment.unobserveDeep(observerA);
    ytext.unobserve(observerB);
  };
}
