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
  BridgeComposition,
  MarkdownManager,
  PmStructuralNode,
  StructuralDivergenceReason,
} from '@inkeep/open-knowledge-core';
import {
  addsBlankLines,
  applyFastDiff,
  applyIncrementalDiff,
  BridgeInvariantViolationError,
  BridgeMergeContentLossError,
  comparePmStructural,
  composeWithDerivedBody,
  createMergeBoundarySpace,
  DUPLICATION_GATE_MIN_LINE_LENGTH,
  docEdgeRunsDiffer,
  fnv1aDigest,
  fragmentHoldsPendingContent,
  isParseEquivalentBridge,
  mergeThreeWay,
  normalizeBridge,
  overMultipliedBodyLines,
  pendingContentLines,
  prependFrontmatter,
  splitFmBoundarySlot,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import type { Schema } from '@tiptap/pm/model';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { detectApplyArmDrop } from './bridge-loss-detector.ts';
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
import {
  LOSS_EVENT_BACKSTOP_TRIP,
  LOSS_EVENT_CHECKPOINT_WRITE,
  LOSS_EVENT_DETECTOR_TRIP,
  LOSS_EVENT_GUARD_DEFER,
  type LossCaptureRing,
} from './loss-capture.ts';
import {
  computeMapDrivenBodySplice,
  createEditorMdastMemo,
  type EditorMdastMemo,
} from './map-driven-splice.ts';
import {
  incrementBridgeMergeCheckpointCreated,
  incrementBridgeMergeContentGrowth,
  incrementBridgeMergeContentLoss,
  incrementBridgeSplitBrainRederives,
  incrementDeriveTimingDeferForceResolved,
  incrementMapDrivenSpliceApplied,
  incrementMapDrivenSpliceFallback,
  incrementObserverAApplyLoss,
  incrementObserverAApplyLossCheckpointCreated,
  incrementObserverADuplicationCheckpointCreated,
  incrementObserverADuplicationRederives,
  incrementObserverAPathBFires,
  incrementObserverAResidualMergeRuns,
  incrementProducerGuardCheckpointCreated,
  incrementProducerGuardFires,
  incrementProducerGuardFiresSuppressed,
  incrementReDeriveBackstopTripped,
  incrementServerObserverError,
  incrementServerObserverFire,
} from './metrics.ts';
import {
  type PreDrainController,
  type PreDrainOpInput,
  type PreDrainVerdict,
  planPreDrain,
} from './pre-drain-discriminator.ts';
import { registerBridgeDirtyProbe } from './server-workload-telemetry.ts';
import { type ShadowHandle, saveInMemoryCheckpoint } from './shadow-repo.ts';
import { setActiveSpanAttributes, withSpanSync } from './telemetry.ts';

const log = getLogger('server-observers');

const checkpointLog = getLogger('server-observers');

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

export function shouldRethrowBridgeMergeLoss(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test' || env.OK_RETHROW_BRIDGE_LOSS === '1';
}

export interface ProducerGuardViolationInfo {
  docName?: string;
  reason: StructuralDivergenceReason;
  detail: string;
}

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

const PRODUCER_GUARD_DANGER_TYPES = new Set(['jsxComponent', 'table', 'tableCell', 'tableHeader']);

/**
 * Consecutive derive-timing defers a document may accumulate before the guard
 * stops deferring and force-resolves the re-derive loudly. Drain-count based, so
 * it stays honest under the no-wall-clock rule (precedent #13(b)): the bound is
 * "how many re-derive drains have been withheld," never elapsed time. Same value
 * as the persistence layer's `QUIESCENCE_MAX_DEFER` — under sustained typing a
 * doc that keeps a keystroke un-propagated is the same shape both layers bound.
 */
const MAX_DERIVE_TIMING_DEFERS = 8;

/**
 * Backstop cap for the Y.Text→XmlFragment re-derive loop (the loud
 * tripwire). A run of this many consecutive re-derive drains that never reaches
 * a raw-byte fixed point (the two representations keep diverging) freezes the
 * B-direction re-derive loop. Drain-count based (never wall-clock,
 * precedent #13(b)). Set well above the worst measured legitimate run — a single
 * byte-emitting round per settlement episode — so a legitimate flow can never
 * trip it; the residual it guards is the un-probed echo/normalize-UNEQUAL
 * corrective-loop domain, where a trip is a true positive.
 */
const MAX_REDERIVE_ROUNDS = 8;

const MERGE_BOUNDARY_SITE = 'merge-boundary';

function fragmentContainsDangerSpace(node: PmStructuralNode): boolean {
  if (node.type && PRODUCER_GUARD_DANGER_TYPES.has(node.type)) return true;
  if (node.content) {
    for (const child of node.content) {
      if (fragmentContainsDangerSpace(child)) return true;
    }
  }
  return false;
}

function dangerSpaceLocator(node: PmStructuralNode): string {
  const present = new Set<string>();
  const walk = (n: PmStructuralNode): void => {
    if (n.type && PRODUCER_GUARD_DANGER_TYPES.has(n.type)) present.add(n.type);
    if (n.content) for (const child of n.content) walk(child);
  };
  walk(node);
  return [...present].sort().join(',');
}

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
  readonly mdastMemo: EditorMdastMemo;
}

let mapDrivenParseErrorWarned = false;

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
  const { currentText, lastSyncedXmlMd, json, mdManager, docName, mdastMemo } = args;
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
    mdastMemo,
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

const preDrainControllers = new WeakMap<Y.Doc, PreDrainController>();

export function getPreDrainController(doc: Y.Doc): PreDrainController | undefined {
  return preDrainControllers.get(doc);
}

const convergedFragmentWitnesses = new WeakMap<Y.Doc, () => string>();

export function getConvergedFragmentWitness(doc: Y.Doc): string | undefined {
  return convergedFragmentWitnesses.get(doc)?.();
}

type ShadowAccessor = () => ShadowHandle | undefined;

type BranchAccessor = () => string;

export type ObserverDispatchKind = 'none' | 'a' | 'b';

type ObserverDispatchHook = (kind: ObserverDispatchKind) => void;

export interface SetupServerObserversOpts {
  doc: Y.Doc;
  xmlFragment: Y.XmlFragment;
  ytext: Y.Text;
  mdManager: MarkdownManager;
  schema: Schema;
  docName?: string;
  shadow?: ShadowAccessor;
  getBranch?: BranchAccessor;
  contentRoot?: string;
  resolveEmbed?: (basename: string, sourcePath: string) => string | null;
  resolveSize?: (basename: string, sourcePath: string) => number | null;
  onDispatch?: ObserverDispatchHook;
  mergeThreeWay?: typeof mergeThreeWay;
  deferGuardEnabled?: boolean;
  lossDetectorEnabled?: boolean;
  fixedPointBackstopEnabled?: boolean;
  preDrainEnabled?: boolean;
  lossRing?: Pick<LossCaptureRing, 'record'>;
  onDeriveTimingDefer?: (snapshot: { canonicalWitness: string; rawWitness: string }) => void;
  onReDeriveBackstop?: (rounds: number) => void;
  __testApplyLossInjector?: (ytext: Y.Text) => void;
}

/**
 * Split-brain settlement predicate (the precedent #38 comparison): true when
 * a drain is about to settle with Y.Text and the canonical fragment
 * serialization (`md`) diverged beyond `normalizeBridge` tolerance. The
 * byte-identity short-circuit skips the O(N) normalize passes on the common
 * in-sync case. Single-sourced so both Observer A detection sites (identity
 * gate + post-merge baseline check) apply the identical predicate.
 */
function settlesSplitBrain(
  settledText: string,
  md: string,
  normMdPre?: string,
  normSettledPre?: string,
): boolean {
  return (
    settledText !== md &&
    (normSettledPre ?? normalizeBridge(settledText)) !== (normMdPre ?? normalizeBridge(md))
  );
}

function carrierKind(child: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  if (child instanceof Y.XmlElement) return child.nodeName;
  if (child instanceof Y.XmlText) return '#text';
  return '#hook';
}

function mintingClientId(child: Y.XmlElement | Y.XmlText | Y.XmlHook): number | undefined {
  return (child as { _item?: { id?: { client: number } } | null })._item?.id?.client;
}

const collapseSpaces = (s: string): string => s.replace(/\s+/g, ' ').trim();

const stripInlineMarkerChars = (s: string): string => s.replace(/[*_~`]+/g, '');

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

function markdownBareText(line: string): string {
  return collapseSpaces(
    stripInlineMarkerChars(
      line.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\\([\\`*_{}[\]()#+\-.!><])/g, '$1'),
    ),
  );
}

export function findRaceDuplicatedSpans(
  xmlFragment: Y.XmlFragment,
  serverClientId: number,
  overMultipliedLines: readonly string[],
): boolean {
  if (overMultipliedLines.length === 0) return false;
  const children = xmlFragment.toArray();
  const childBareTexts = children.map((child) => xmlBareText(child.toString()));
  for (const line of overMultipliedLines) {
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

  const handleBridgeMergeLoss = (
    err: BridgeMergeContentLossError,
    preMergeBaseline: string,
  ): void => {
    const verbose = process.env.OK_TELEMETRY_VERBOSE === '1';
    console.warn(
      JSON.stringify({
        ...err.toLog({ verbose }),
        docName: opts.docName ?? null,
        timestamp: new Date().toISOString(),
      }),
    );
    if (err.info.which === 'growth') incrementBridgeMergeContentGrowth();
    else incrementBridgeMergeContentLoss();

    const which = err.info.which;
    const lostLen = err.info.lostSubstrings.reduce((n, s) => n + s.length, 0);

    const shadow = opts.shadow?.();
    if (!shadow || !opts.docName) {
      void opts.lossRing?.record({
        event: LOSS_EVENT_DETECTOR_TRIP,
        docName: opts.docName ?? '',
        writerId: null,
        direction: 'a',
        site: MERGE_BOUNDARY_SITE,
        lostLen,
        which,
      });
      return;
    }
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
          void opts.lossRing?.record({
            event: LOSS_EVENT_DETECTOR_TRIP,
            docName: opts.docName as string,
            writerId: null,
            direction: 'a',
            site: MERGE_BOUNDARY_SITE,
            lostLen,
            which,
            checkpointSha: sha,
          });
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
          void opts.lossRing?.record({
            event: LOSS_EVENT_DETECTOR_TRIP,
            docName: opts.docName as string,
            writerId: null,
            direction: 'a',
            site: MERGE_BOUNDARY_SITE,
            lostLen,
            which,
          });
        });
    });
  };

  const recordSplitBrainRederive = (site: BridgeSplitBrainSite): void => {
    drainDidCorrectiveWork = true;
    pendingSplitBrainRederive = true;
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

  const recordGuardDefer = (pendingLines: readonly string[]): void => {
    void opts.lossRing?.record({
      event: LOSS_EVENT_GUARD_DEFER,
      docName: opts.docName ?? '',
      writerId: null,
      direction: 'b',
      lostLen: pendingLines.reduce((n, line) => n + line.length, 0),
    });
  };

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

  const detectObserverAApplyLoss = (
    intendedMd: string,
    normIntended: string,
    appliedYText: string,
    normApplied: string,
  ): void => {
    if (opts.lossDetectorEnabled === false) return;
    const dropped = detectApplyArmDrop(intendedMd, normIntended, appliedYText, normApplied);
    if (dropped.length === 0) return;
    incrementObserverAApplyLoss();
    const lostLen = dropped.reduce((n, s) => n + s.length, 0);
    const digest = fnv1aDigest(dropped.join('\n'));
    const shadow = opts.shadow?.();
    if (!shadow || !opts.docName) {
      void opts.lossRing?.record({
        event: LOSS_EVENT_DETECTOR_TRIP,
        docName: opts.docName ?? '',
        writerId: null,
        direction: 'a',
        site: 'observer-a-apply',
        lostLen,
        digest,
      });
      return;
    }
    const branch = opts.getBranch?.() ?? 'main';
    const contentRoot = opts.contentRoot ?? '';
    const docName = opts.docName;
    queueMicrotask(() => {
      saveInMemoryCheckpoint(shadow, contentRoot, {
        kind: 'observer-a-apply-loss',
        docName,
        contents: intendedMd,
        label: `Before Observer-A apply content-loss @ ${new Date().toISOString()}`,
        branch,
        metadata: { lostSubstrings: dropped },
      })
        .then((sha) => {
          incrementObserverAApplyLossCheckpointCreated();
          void opts.lossRing?.record({
            event: LOSS_EVENT_DETECTOR_TRIP,
            docName,
            writerId: null,
            direction: 'a',
            site: 'observer-a-apply',
            lostLen,
            digest,
            checkpointSha: sha,
          });
          console.warn(
            JSON.stringify({
              event: 'observer-a-apply-loss-checkpoint-created',
              docName,
              sha,
              kind: 'observer-a-apply-loss',
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .catch((checkpointErr: unknown) => {
          const e =
            checkpointErr instanceof Error ? checkpointErr : new Error(String(checkpointErr));
          log.warn({ docName, err: e }, '[Server Observer A] Apply-loss checkpoint write failed');
          checkpointLog.warn(
            { err: e, 'doc.name': docName, branch, kind: 'observer-a-apply-loss' },
            'checkpoint write failed',
          );
          void opts.lossRing?.record({
            event: LOSS_EVENT_DETECTOR_TRIP,
            docName,
            writerId: null,
            direction: 'a',
            site: 'observer-a-apply',
            lostLen,
            digest,
          });
        });
    });
  };

  const forceResolveExhaustedDefer = (
    preResolveFragmentMd: string,
    deferCount: number,
    pendingLines: readonly string[],
  ): void => {
    incrementDeriveTimingDeferForceResolved();
    const lostLen = pendingLines.reduce((n, line) => n + line.length, 0);
    const shadow = opts.shadow?.();
    const docName = opts.docName;
    if (!shadow || !docName) {
      void opts.lossRing?.record({
        event: LOSS_EVENT_CHECKPOINT_WRITE,
        docName: docName ?? '',
        writerId: null,
        direction: 'b',
        site: 'derive-timing-exhaustion',
        lostLen,
      });
      return;
    }
    const branch = opts.getBranch?.() ?? 'main';
    const contentRoot = opts.contentRoot ?? '';
    queueMicrotask(() => {
      saveInMemoryCheckpoint(shadow, contentRoot, {
        kind: 'defer-exhaustion-loss',
        docName,
        contents: preResolveFragmentMd,
        label: `Before derive-defer force-resolve @ ${new Date().toISOString()}`,
        branch,
        metadata: { deferCount },
      })
        .then((sha) => {
          void opts.lossRing?.record({
            event: LOSS_EVENT_CHECKPOINT_WRITE,
            docName,
            writerId: null,
            direction: 'b',
            site: 'derive-timing-exhaustion',
            lostLen,
            checkpointSha: sha,
          });
          console.warn(
            JSON.stringify({
              event: 'derive-defer-exhaustion-checkpoint-created',
              docName,
              sha,
              kind: 'defer-exhaustion-loss',
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .catch((checkpointErr: unknown) => {
          const e =
            checkpointErr instanceof Error ? checkpointErr : new Error(String(checkpointErr));
          log.warn(
            { docName, err: e },
            '[Server Observer B] Derive-defer exhaustion checkpoint write failed',
          );
          checkpointLog.warn(
            { err: e, 'doc.name': docName, branch, kind: 'defer-exhaustion-loss' },
            'checkpoint write failed',
          );
          void opts.lossRing?.record({
            event: LOSS_EVENT_CHECKPOINT_WRITE,
            docName,
            writerId: null,
            direction: 'b',
            site: 'derive-timing-exhaustion',
            lostLen,
          });
        });
    });
  };

  const tripReDeriveBackstop = (rounds: number): void => {
    bDirectionFrozen = true;
    incrementReDeriveBackstopTripped();
    opts.onReDeriveBackstop?.(rounds);
    const frozenYText = ytext.toString();
    const shadow = opts.shadow?.();
    const docName = opts.docName;
    if (!shadow || !docName) {
      void opts.lossRing?.record({
        event: LOSS_EVENT_BACKSTOP_TRIP,
        docName: docName ?? '',
        writerId: null,
        direction: 'b',
        site: 'rederive-backstop',
      });
      return;
    }
    const branch = opts.getBranch?.() ?? 'main';
    const contentRoot = opts.contentRoot ?? '';
    queueMicrotask(() => {
      saveInMemoryCheckpoint(shadow, contentRoot, {
        kind: 'bridge-backstop-trip',
        docName,
        contents: frozenYText,
        label: `Before re-derive backstop freeze @ ${new Date().toISOString()}`,
        branch,
        metadata: { rounds },
      })
        .then((sha) => {
          void opts.lossRing?.record({
            event: LOSS_EVENT_BACKSTOP_TRIP,
            docName,
            writerId: null,
            direction: 'b',
            site: 'rederive-backstop',
            checkpointSha: sha,
          });
          console.warn(
            JSON.stringify({
              event: 'bridge-rederive-backstop-checkpoint-created',
              docName,
              sha,
              kind: 'bridge-backstop-trip',
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .catch((checkpointErr: unknown) => {
          const e =
            checkpointErr instanceof Error ? checkpointErr : new Error(String(checkpointErr));
          log.warn(
            { docName, err: e },
            '[Server Observer B] Re-derive backstop checkpoint write failed',
          );
          checkpointLog.warn(
            { err: e, 'doc.name': docName, branch, kind: 'bridge-backstop-trip' },
            'checkpoint write failed',
          );
          void opts.lossRing?.record({
            event: LOSS_EVENT_BACKSTOP_TRIP,
            docName,
            writerId: null,
            direction: 'b',
            site: 'rederive-backstop',
          });
        });
    });
  };

  let lastSyncedCanonicalMd = '';
  let lastSyncedYTextBytes = '';
  const mdastMemo = createEditorMdastMemo();
  let canonicalWitnessCoherent = false;
  let xmlDirty = false;
  let textDirty = false;
  let lastExternalYtextChangeMs = 0;

  const deferGuardEnabled = opts.deferGuardEnabled !== false;
  let lastConvergedFragmentMd = '';
  let fragmentMutatedSinceConverge = false;
  let consecutiveDeriveTimingDefers = 0;
  let pendingDuplicationRecovery = false;
  let pendingSplitBrainRederive = false;

  const fixedPointBackstopEnabled = opts.fixedPointBackstopEnabled !== false;
  const preDrainEnabled = opts.preDrainEnabled !== false;
  const REDERIVE_DIGEST_RING = MAX_REDERIVE_ROUNDS;
  const recentSettledDigests: string[] = [];
  let oscillationRun = 0;
  let bDirectionFrozen = false;
  let drainDidCorrectiveWork = false;
  let drainReachedRawFixedPoint = false;
  let drainDeferred = false;

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

  const recordSettledBaselines = (canonicalMd: string): void => {
    lastSyncedCanonicalMd = canonicalMd;
    refreshYTextWitness();
    canonicalWitnessCoherent = canonicalMd !== '';
    if (fixedPointBackstopEnabled && canonicalMd !== '' && lastSyncedYTextBytes === canonicalMd) {
      drainReachedRawFixedPoint = true;
    }
  };

  const recordDivergedAttachBaselines = (canonicalMd: string): void => {
    lastSyncedCanonicalMd = canonicalMd;
    lastSyncedYTextBytes = canonicalMd;
    canonicalWitnessCoherent = false;
  };

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

  const readCurrentFm = (): string => stripFrontmatter(ytext.toString()).frontmatter;

  const composeDerivedBodyMd = (frontmatter: string, derivedBody: string): BridgeComposition => {
    const { slot } = splitFmBoundarySlot(frontmatter, stripFrontmatter(ytext.toString()).body);
    return composeWithDerivedBody(frontmatter, slot + derivedBody);
  };

  const observerParseOpts =
    opts.resolveEmbed && opts.docName
      ? {
          resolveEmbed: opts.resolveEmbed,
          resolveSize: opts.resolveSize,
          sourcePath: opts.docName,
        }
      : undefined;

  const canonicalizeBody = createDocCanonicalizer(mdManager, {
    resolveEmbed: opts.resolveEmbed,
    resolveSize: opts.resolveSize,
    docName: opts.docName,
  });

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

  const settlesSplitBrainChecked = (
    settledText: string,
    md: string,
    normMdPre?: string,
    normSettledPre?: string,
  ): boolean =>
    settlesSplitBrain(settledText, md, normMdPre, normSettledPre) &&
    !isRestingParseEquivalent(settledText, md);

  try {
    const initialJson = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
    const initialBody = mdManager.serialize(initialJson);
    const initialFrontmatter = readCurrentFm();
    const canonicalInit = composeDerivedBodyMd(initialFrontmatter, initialBody).md;
    if (isRestingParseEquivalent(ytext.toString(), canonicalInit)) {
      recordSettledBaselines(canonicalInit);
    } else {
      recordDivergedAttachBaselines(canonicalInit);
    }
    lastConvergedFragmentMd = canonicalInit;
  } catch (err) {
    incrementServerObserverError('a');
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)) },
      '[Server Observer A] Baseline init failed — starting from empty snapshot',
    );
    recordSettledBaselines('');
  }

  let lastGuardedBody: string | undefined;
  const PRODUCER_GUARD_LOG_COOLDOWN_MS = 5_000;
  const FRESHNESS_QUIESCENCE_MS = 2_000;
  const guardLogState = new Map<string, { lastMs: number; suppressed: number }>();
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

  const runProducerGuard = (json: PmStructuralNode, body: string): void => {
    if (body === lastGuardedBody) return;
    lastGuardedBody = body;
    if (!fragmentContainsDangerSpace(json)) return;

    const reparsed = mdManager.parseWithFallback(body, observerParseOpts) as PmStructuralNode;
    const verdict = comparePmStructural(json, reparsed, { rawSourceSide: 'expected' });
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

  const runObserverASyncImpl = (): void => {
    try {
      const json = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
      const rawWitnessCoherent = ytext.toString() === lastSyncedYTextBytes;
      const ytextQuiescent = Date.now() - lastExternalYtextChangeMs >= FRESHNESS_QUIESCENCE_MS;
      const freshnessSafe = rawWitnessCoherent && ytextQuiescent;
      const body = mdManager.serialize(json, { skipFreshnessDerive: !freshnessSafe });
      if (freshnessSafe) runProducerGuard(json as PmStructuralNode, body);
      const frontmatter = readCurrentFm();
      const composition = composeDerivedBodyMd(frontmatter, body);
      const md = composition.md;
      const currentText = ytext.toString();

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
        pendingDuplicationRecovery = true;
        recordSplitBrainRederive('duplication-guard');
        incrementObserverADuplicationRederives();
        saveDuplicationCheckpoint(md, overMultiplied.length);
        setActiveSpanAttributes({ 'observer.a.path': 'gated-duplication-rederive' });
        return;
      }

      if (freshnessSafe) {
        lastConvergedFragmentMd = md;
        fragmentMutatedSinceConverge = false;
        consecutiveDeriveTimingDefers = 0;
      }

      if (canonicalWitnessCoherent && lastSyncedCanonicalMd === md) {
        if (settlesSplitBrainChecked(ytext.toString(), md)) {
          recordDivergedAttachBaselines(md);
          textDirty = true;
          recordSplitBrainRederive('identity-gate');
          setActiveSpanAttributes({ 'observer.a.path': 'gated-fragment-unchanged-rederive' });
        } else {
          setActiveSpanAttributes({ 'observer.a.path': 'gated-fragment-unchanged' });
        }
        return;
      }

      const normCurrent = normalizeBridge(currentText);
      const normMd = normalizeBridge(md);
      if (
        normCurrent === normMd &&
        !addsBlankLines(currentText, md) &&
        !docEdgeRunsDiffer(currentText, md)
      ) {
        setActiveSpanAttributes({
          'observer.a.path': 'gated-in-sync',
          'observer.a.gate_reason': currentText === md ? 'bytes-identical' : 'tolerance-equivalent',
        });
        recordSettledBaselines(md);
        return;
      }

      const preMergeBaseline = lastSyncedYTextBytes;
      const ytextInSync = currentText === lastSyncedYTextBytes;
      const residualMergeEligible =
        ytextInSync &&
        canonicalWitnessCoherent &&
        lastSyncedYTextBytes !== lastSyncedCanonicalMd &&
        normCurrent !== normalizeBridge(lastSyncedCanonicalMd);
      setActiveSpanAttributes({
        'observer.a.path': ytextInSync
          ? residualMergeEligible
            ? 'residual-merge'
            : 'path-a'
          : 'path-b',
      });
      const pathBState: { mergedText: string | null } = { mergedText: null };

      const spliceComputeStart = performance.now();
      const mapDrivenSplice =
        (ytextInSync && residualMergeEligible) ||
        composition.adjusted !== 'none' ||
        docEdgeRunsDiffer(currentText, md)
          ? null
          : tryComputeMapDrivenSplice({
              currentText,
              lastSyncedXmlMd: lastSyncedYTextBytes,
              json,
              mdManager,
              docName: opts.docName,
              mdastMemo,
            });
      if (mapDrivenSplice) {
        setActiveSpanAttributes({
          'observer.a.path': 'map-driven-splice',
          'observer.a.splice.compute_ms': Math.round(performance.now() - spliceComputeStart),
        });
      }

      doc.transact(() => {
        if (mapDrivenSplice) {
          applyMapDrivenSplice(ytext, mapDrivenSplice);
        } else if (ytextInSync && !residualMergeEligible) {
          applyIncrementalDiff(ytext, currentText, md);
        } else {
          const mergeBase = ytextInSync ? lastSyncedCanonicalMd : preMergeBaseline;
          const boundarySpace = createMergeBoundarySpace(body);
          const projectMerged = (merged: string): string =>
            boundarySpace.unproject(merged, currentText);
          const mergeThreeWayFn = opts.mergeThreeWay ?? mergeThreeWay;
          try {
            const mergedText = projectMerged(
              mergeThreeWayFn(
                boundarySpace.project(mergeBase),
                boundarySpace.project(md),
                boundarySpace.project(currentText),
              ),
            );
            applyFastDiff(ytext, currentText, mergedText);
            pathBState.mergedText = mergedText;
          } catch (mergeErr) {
            if (!(mergeErr instanceof BridgeMergeContentLossError)) throw mergeErr;
            handleBridgeMergeLoss(mergeErr, preMergeBaseline);
            if (shouldRethrowBridgeMergeLoss()) throw mergeErr;
            const asComputed = projectMerged(mergeErr.info.result);
            applyFastDiff(ytext, currentText, asComputed);
            pathBState.mergedText = asComputed;
          }
        }
        opts.__testApplyLossInjector?.(ytext);
      }, OBSERVER_SYNC_ORIGIN);

      if (mapDrivenSplice) incrementMapDrivenSpliceApplied();

      const appliedYText = ytext.toString();
      const normApplied = normalizeBridge(appliedYText);
      if (mapDrivenSplice || (ytextInSync && !residualMergeEligible)) {
        detectObserverAApplyLoss(md, normMd, appliedYText, normApplied);
      }

      if (pathBState.mergedText !== null && !ytextInSync) {
        if (emitObserverAPathBFired(opts.docName)) {
          incrementObserverAPathBFires();
          console.warn(
            JSON.stringify({
              event: 'observer-a-path-b-fired',
              'doc.name': opts.docName ?? null,
              xmlFragmentAdvanced: true,
              ytextDiverged: !ytextInSync,
              mergeBytesChanged: Math.abs(pathBState.mergedText.length - currentText.length),
            }),
          );
        }
      }

      if (pathBState.mergedText !== null && ytextInSync) {
        incrementObserverAResidualMergeRuns();
      }

      incrementServerObserverFire('a');
      recordSettledBaselines(md);

      if (settlesSplitBrainChecked(appliedYText, md, normMd, normApplied)) {
        if (appliedYText === preMergeBaseline) recordDivergedAttachBaselines(md);
        textDirty = true;
        recordSplitBrainRederive('post-merge');
      }
    } catch (err) {
      if (err instanceof BridgeMergeContentLossError) {
        throw err;
      }
      if (err instanceof ProducerGuardViolationError) {
        throw err;
      }
      incrementServerObserverError('a');
      log.error({ err }, '[Server Observer A] Failed to sync tree→text');
      try {
        const recoveryJson = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
        const recoveryBody = mdManager.serialize(recoveryJson);
        const recoveryMd = composeDerivedBodyMd(readCurrentFm(), recoveryBody).md;
        if (settlesSplitBrainChecked(ytext.toString(), recoveryMd)) {
          recordSplitBrainRecoveryBaselines(recoveryMd);
          textDirty = true;
          recordSplitBrainRederive('error-recovery');
        } else {
          recordSettledBaselines(recoveryMd);
        }
      } catch (innerErr) {
        log.warn(
          {
            docName: opts.docName ?? null,
            originalError: err instanceof Error ? err.message : String(err),
            recoveryError: innerErr instanceof Error ? innerErr.message : String(innerErr),
          },
          '[Server Observer A] Baseline recovery also failed',
        );
        lastSyncedCanonicalMd = '';
        lastSyncedYTextBytes = '';
        canonicalWitnessCoherent = false;
      }
    }
  };

  const runObserverASync = (): void => {
    withSpanSync(
      'observer.runASync',
      { attributes: { 'doc.name': opts.docName ?? '' } },
      runObserverASyncImpl,
    );
  };

  const observerA = (_events: Y.YEvent<Y.XmlFragment>[], transaction: Y.Transaction) => {
    if (transaction.origin === OBSERVER_SYNC_ORIGIN) return;

    if (isPairedWriteOrigin(transaction.origin)) {
      try {
        const frontmatter = readCurrentFm();
        refreshYTextWitness();
        lastConvergedFragmentMd = lastSyncedYTextBytes;
        fragmentMutatedSinceConverge = false;
        consecutiveDeriveTimingDefers = 0;
        priorFmForTelemetry = frontmatter;
      } catch (err) {
        incrementServerObserverError('a');
        log.warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          '[Server Observer A] Paired-write baseline refresh failed — falling through to settlement',
        );
        xmlDirty = true;
      }
      return;
    }

    xmlDirty = true;
    fragmentMutatedSinceConverge = true;
  };

  if (xmlFragment.length > 0 && ytext.length === 0) {
    try {
      const json = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
      const body = mdManager.serialize(json);
      const frontmatter = readCurrentFm();
      const md = composeDerivedBodyMd(frontmatter, body).md;
      doc.transact(() => {
        ytext.insert(0, md);
      }, OBSERVER_SYNC_ORIGIN);
      recordSettledBaselines(md);
    } catch (err) {
      incrementServerObserverError('a');
      log.error({ err }, '[Server Observer A] Failed initial sync');
      recordSettledBaselines('');
    }
  }

  let priorFmForTelemetry = readCurrentFm();
  const runObserverBSyncImpl = (): void => {
    try {
      const md = ytext.toString();

      const { frontmatter, body } = stripFrontmatter(md);
      const { slot: fmBoundarySlot, body: parseBody } = splitFmBoundarySlot(frontmatter, body);

      if (
        !pendingSplitBrainRederive &&
        normalizeBridge(lastSyncedYTextBytes) === normalizeBridge(md) &&
        !docEdgeRunsDiffer(lastSyncedYTextBytes, md)
      ) {
        if (priorFmForTelemetry !== frontmatter) {
          recordFrontmatterEditSurface('source-mode');
          priorFmForTelemetry = frontmatter;
        }
        if (fixedPointBackstopEnabled && canonicalWitnessCoherent && lastSyncedCanonicalMd === md) {
          drainReachedRawFixedPoint = true;
        }
        return;
      }

      if (bDirectionFrozen) {
        setActiveSpanAttributes({ 'observer.b.path': 'backstop-frozen' });
        return;
      }

      if (pendingDuplicationRecovery) {
        pendingDuplicationRecovery = false;
      } else if (deferGuardEnabled && fragmentMutatedSinceConverge) {
        const freshFragmentBody = mdManager.serialize(
          yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON(),
        );
        const freshFragmentMd = composeDerivedBodyMd(frontmatter, freshFragmentBody).md;
        if (fragmentHoldsPendingContent(freshFragmentMd, md, lastConvergedFragmentMd)) {
          if (consecutiveDeriveTimingDefers >= MAX_DERIVE_TIMING_DEFERS) {
            forceResolveExhaustedDefer(
              freshFragmentMd,
              consecutiveDeriveTimingDefers,
              pendingContentLines(freshFragmentMd, md, lastConvergedFragmentMd),
            );
            consecutiveDeriveTimingDefers = 0;
            setActiveSpanAttributes({ 'observer.b.path': 'derive-timing-force-resolve' });
          } else {
            consecutiveDeriveTimingDefers += 1;
            xmlDirty = true;
            textDirty = true;
            recordGuardDefer(pendingContentLines(freshFragmentMd, md, lastConvergedFragmentMd));
            opts.onDeriveTimingDefer?.({
              canonicalWitness: lastSyncedCanonicalMd,
              rawWitness: lastSyncedYTextBytes,
            });
            drainDeferred = true;
            setActiveSpanAttributes({ 'observer.b.path': 'derive-timing-defer' });
            return;
          }
        }
      }

      const parsedJson = mdManager.parseWithFallback(parseBody, observerParseOpts);

      const pmNode = opts.schema.nodeFromJSON(parsedJson);

      doc.transact(() => {
        const meta = { mapping: new Map(), isOMark: new Map() };
        updateYFragment(doc, xmlFragment, pmNode, meta);
      }, OBSERVER_SYNC_ORIGIN);
      pendingSplitBrainRederive = false;

      if (fixedPointBackstopEnabled) drainDidCorrectiveWork = true;

      if (priorFmForTelemetry !== frontmatter) {
        recordFrontmatterEditSurface('source-mode');
        priorFmForTelemetry = frontmatter;
      }

      incrementServerObserverFire('b');

      try {
        const canonicalBody = mdManager.serialize(parsedJson);
        const canonicalYText = prependFrontmatter(frontmatter, fmBoundarySlot + canonicalBody);
        assertBridgeInvariant(ytext.toString(), canonicalYText, {
          site: 'observer-b',
          docName: opts.docName,
          canonicalizeBody: (b) =>
            b === body ? fmBoundarySlot + canonicalBody : canonicalizeBody(b),
        });
        recordSettledBaselines(canonicalYText);
        lastConvergedFragmentMd = canonicalYText;
        fragmentMutatedSinceConverge = false;
        consecutiveDeriveTimingDefers = 0;
      } catch (reserializeErr) {
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
      if (err instanceof BridgeInvariantViolationError) {
        throw err;
      }
      incrementServerObserverError('b');
      log.error({ err }, '[Server Observer B] Failed to sync text→tree');
      try {
        const postJson = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
        const postBody = mdManager.serialize(postJson);
        const fm = readCurrentFm();
        refreshCanonicalWitnessOnly(composeDerivedBodyMd(fm, postBody).md);
      } catch (innerErr) {
        if (innerErr instanceof BridgeInvariantViolationError) {
          throw innerErr;
        }
        log.warn({ err: innerErr }, '[Server Observer B] Baseline recovery also failed');
      }
    }
  };

  const runObserverBSync = (): void => {
    withSpanSync(
      'observer.runBSync',
      { attributes: { 'doc.name': opts.docName ?? '' } },
      runObserverBSyncImpl,
    );
  };

  const observerB = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (transaction.origin === OBSERVER_SYNC_ORIGIN) return;

    if (isPairedWriteOrigin(transaction.origin)) {
      try {
        const frontmatter = readCurrentFm();
        refreshYTextWitness();
        priorFmForTelemetry = frontmatter;
      } catch (err) {
        incrementServerObserverError('b');
        log.warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          '[Server Observer B] Paired-write baseline refresh failed — falling through to settlement',
        );
        textDirty = true;
      }
      return;
    }

    lastExternalYtextChangeMs = Date.now();
    textDirty = true;
  };

  // ─── Settlement dispatcher (precedent #13(b)) ────────
  const afterAll = (_doc: Y.Doc, transactions: Y.Transaction[]): void => {
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

        drainDidCorrectiveWork = false;
        drainReachedRawFixedPoint = false;
        drainDeferred = false;

        const ranA = xmlDirty;
        if (xmlDirty) {
          xmlDirty = false;
          opts.onDispatch?.('a');
          runObserverASync();
        }
        const ranB = textDirty;
        if (textDirty) {
          textDirty = false;
          opts.onDispatch?.('b');
          runObserverBSync();
        }

        if (fixedPointBackstopEnabled && !drainDeferred) {
          if (drainReachedRawFixedPoint) {
            oscillationRun = 0;
            recentSettledDigests.length = 0;
            bDirectionFrozen = false;
          } else if (drainDidCorrectiveWork) {
            const digest = fnv1aDigest(ytext.toString());
            if (recentSettledDigests.includes(digest)) {
              oscillationRun += 1;
              if (oscillationRun >= MAX_REDERIVE_ROUNDS && !bDirectionFrozen) {
                tripReDeriveBackstop(oscillationRun);
              }
            } else {
              oscillationRun = 0;
            }
            recentSettledDigests.push(digest);
            if (recentSettledDigests.length > REDERIVE_DIGEST_RING) recentSettledDigests.shift();
          }
        }

        span.setAttribute(
          'observer.dispatch',
          ranA && ranB ? 'a-then-b' : ranA ? 'a' : ranB ? 'b' : 'none',
        );
      },
    );
  };

  xmlFragment.observeDeep(observerA);
  ytext.observe(observerB);
  doc.on('afterAllTransactions', afterAll);
  const unregisterDirtyProbe = registerBridgeDirtyProbe(() => xmlDirty || textDirty);
  const detachQuiescence = attachQuiescenceTracker(doc);

  const preDrainController: PreDrainController = {
    preDrain(op: PreDrainOpInput): PreDrainVerdict {
      if (!preDrainEnabled) return { preDrain: false, reason: 'skip-disabled' };
      if (!fragmentMutatedSinceConverge) return { preDrain: false, reason: 'skip-no-pending' };

      try {
        const json = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
        const fullMd = ytext.toString();
        const { body } = stripFrontmatter(fullMd);
        const fmPrefixLen = fullMd.length - body.length;

        const { preDrain, verdict, splice } = planPreDrain({
          pendingDirty: true,
          body,
          fragmentPmJson: json,
          witnessMatched: fullMd === lastSyncedYTextBytes,
          fmPrefixLen,
          op:
            op.kind === 'agent-undo'
              ? { kind: 'agent-undo', ytext, stackItem: op.stackItem }
              : { kind: 'agent-write', writeKind: op.writeKind },
          mdManager,
        });
        if (!preDrain) return verdict;

        const flushComposition = composeDerivedBodyMd(readCurrentFm(), mdManager.serialize(json));
        if (flushComposition.adjusted !== 'none') {
          return { preDrain: false, reason: 'checkpoint-fm-ambiguous' };
        }

        const bodyOffset = fullMd.length - body.length;
        doc.transact(() => {
          applyMapDrivenSplice(ytext, {
            spliceStart: bodyOffset + splice.spliceStart,
            spliceEnd: bodyOffset + splice.spliceEnd,
            newSlice: splice.newSlice,
          });
        }, OBSERVER_SYNC_ORIGIN);
        const canonicalMd = flushComposition.md;
        recordSettledBaselines(canonicalMd);
        lastConvergedFragmentMd = canonicalMd;
        fragmentMutatedSinceConverge = false;
        consecutiveDeriveTimingDefers = 0;
        return verdict;
      } catch (err) {
        incrementServerObserverError('a');
        log.warn(
          { err: err instanceof Error ? err : new Error(String(err)), docName: opts.docName },
          '[Server pre-drain] Discrimination threw — routing to the checkpoint floor',
        );
        return { preDrain: false, reason: 'checkpoint-witness-mismatch' };
      }
    },
  };
  preDrainControllers.set(doc, preDrainController);
  convergedFragmentWitnesses.set(doc, () => lastConvergedFragmentMd);

  return () => {
    unregisterDirtyProbe();
    detachQuiescence();
    preDrainControllers.delete(doc);
    convergedFragmentWitnesses.delete(doc);
    doc.off('afterAllTransactions', afterAll);
    xmlFragment.unobserveDeep(observerA);
    ytext.unobserve(observerB);
  };
}
