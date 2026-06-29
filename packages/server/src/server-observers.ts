
import type { LocalTransactionOrigin } from '@hocuspocus/server';
import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import {
  applyFastDiff,
  applyIncrementalDiff,
  BridgeInvariantViolationError,
  BridgeMergeContentLossError,
  mergeThreeWay,
  normalizeBridge,
  prependFrontmatter,
  projectMergeBoundarySpace,
  reattachLeadingDocBoundary,
  splitLeadingDocBoundary,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import type { Schema } from '@tiptap/pm/model';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import { attachQuiescenceTracker } from './bridge-quiescence.ts';
import {
  assertBridgeInvariant,
  type BridgeSplitBrainSite,
  emitBridgeSplitBrainRederive,
  emitObserverAPathBFired,
} from './bridge-watchdog.ts';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import { recordFrontmatterEditSurface } from './frontmatter-telemetry.ts';
import { computeMapDrivenBodySplice } from './map-driven-splice.ts';
import {
  incrementBridgeMergeCheckpointCreated,
  incrementBridgeMergeContentLoss,
  incrementBridgeSplitBrainRederives,
  incrementMapDrivenSpliceApplied,
  incrementMapDrivenSpliceFallback,
  incrementObserverAPathBFires,
  incrementObserverAResidualMergeRuns,
  incrementServerObserverError,
  incrementServerObserverFire,
} from './metrics.ts';
import { type ShadowHandle, saveInMemoryCheckpoint } from './shadow-repo.ts';
import { setActiveSpanAttributes, withSpanSync } from './telemetry.ts';


export const OBSERVER_SYNC_ORIGIN = {
  source: 'local',
  skipStoreHooks: true,
  context: { origin: 'observer-sync' },
} as const satisfies LocalTransactionOrigin;

export type PairedWriteOrigin = LocalTransactionOrigin & {
  readonly context: {
    readonly origin: string;
    readonly paired: true;
  };
};

export const isPairedWriteOrigin = (origin: unknown): origin is PairedWriteOrigin => {
  if (origin == null || typeof origin !== 'object') return false;
  const ctx = (origin as { context?: { paired?: boolean } }).context;
  return ctx?.paired === true;
};

export function shouldRethrowBridgeMergeLoss(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test' || env.OK_RETHROW_BRIDGE_LOSS === '1';
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
}

let mapDrivenParseErrorWarned = false;

/** Test-only: re-arm the parse-error warn-once (process-global, so an earlier
 * suite test exercising the fallback would otherwise consume the single warn). */
export function __resetMapDrivenParseErrorWarnForTests(): void {
  mapDrivenParseErrorWarned = false;
}

function warnOnceMapDrivenParseError(docName: string | undefined, err: unknown): void {
  if (mapDrivenParseErrorWarned) return;
  mapDrivenParseErrorWarned = true;
  console.warn(
    `[Server Observer A] Map-driven splice parse/serialize threw (doc: ${docName ?? 'unknown'}); drains fall back to the incremental diff (warned once; further failures count in mapDrivenSpliceFallback only):`,
    err instanceof Error ? err.message : String(err),
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
}

function settlesSplitBrain(settledText: string, md: string, normMdPre?: string): boolean {
  return settledText !== md && normalizeBridge(settledText) !== (normMdPre ?? normalizeBridge(md));
}

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
    incrementBridgeMergeContentLoss();

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
        metadata: { lostSubstrings: err.info.lostSubstrings },
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
          console.warn('[Server Observer A] Silent checkpoint write failed:', {
            name: err.name,
            message: err.message,
            stack: err.stack?.split('\n').slice(0, 4).join('\n'),
          });
        });
    });
  };

  const recordSplitBrainRederive = (site: BridgeSplitBrainSite): void => {
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
      console.warn('[Server Observer A] Split-brain telemetry failed:', telErr);
    }
  };

  let lastSyncedCanonicalMd = '';
  let lastSyncedYTextBytes = '';
  let canonicalWitnessCoherent = false;
  let xmlDirty = false;
  let textDirty = false;

  const refreshYTextWitness = (): void => {
    lastSyncedYTextBytes = ytext.toString();
    canonicalWitnessCoherent = false;
  };

  const recordSettledBaselines = (canonicalMd: string): void => {
    lastSyncedCanonicalMd = canonicalMd;
    refreshYTextWitness();
    canonicalWitnessCoherent = canonicalMd !== '';
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

  const recordSplitBrainRecoveryBaselines = (canonicalMd: string): void => {
    lastSyncedCanonicalMd = canonicalMd;
    lastSyncedYTextBytes = ytext.toString();
    canonicalWitnessCoherent = true;
  };

  const readCurrentFm = (): string => stripFrontmatter(ytext.toString()).frontmatter;

  try {
    const initialJson = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
    const initialBody = mdManager.serialize(initialJson);
    const initialFrontmatter = readCurrentFm();
    const canonicalInit = prependFrontmatter(initialFrontmatter, initialBody);
    const initParseOpts =
      opts.resolveEmbed && opts.docName
        ? {
            resolveEmbed: opts.resolveEmbed,
            resolveSize: opts.resolveSize,
            sourcePath: opts.docName,
          }
        : undefined;
    const ytextCanonicalBody = mdManager.serialize(
      mdManager.parseWithFallback(stripFrontmatter(ytext.toString()).body, initParseOpts),
    );
    const stripDocBoundary = (b: string): string => b.replace(/^\n+/, '').replace(/\n+$/, '');
    if (stripDocBoundary(ytextCanonicalBody) === stripDocBoundary(initialBody)) {
      recordSettledBaselines(canonicalInit);
    } else {
      recordDivergedAttachBaselines(canonicalInit);
    }
  } catch (err) {
    incrementServerObserverError('a');
    console.warn(
      '[Server Observer A] Baseline init failed — starting from empty snapshot:',
      err instanceof Error ? err.message : String(err),
    );
    recordSettledBaselines('');
  }

  const runObserverASyncImpl = (): void => {
    try {
      const json = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
      const body = mdManager.serialize(json);
      const frontmatter = readCurrentFm();
      const md = prependFrontmatter(frontmatter, body);

      if (canonicalWitnessCoherent && lastSyncedCanonicalMd === md) {
        if (settlesSplitBrain(ytext.toString(), md)) {
          recordDivergedAttachBaselines(md);
          textDirty = true;
          recordSplitBrainRederive('identity-gate');
          setActiveSpanAttributes({ 'observer.a.path': 'gated-fragment-unchanged-rederive' });
        } else {
          setActiveSpanAttributes({ 'observer.a.path': 'gated-fragment-unchanged' });
        }
        return;
      }

      const currentText = ytext.toString();

      const normCurrent = normalizeBridge(currentText);
      const normMd = normalizeBridge(md);
      if (normCurrent === normMd) {
        setActiveSpanAttributes({ 'observer.a.path': 'gated-in-sync' });
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
        ytextInSync && residualMergeEligible
          ? null
          : tryComputeMapDrivenSplice({
              currentText,
              lastSyncedXmlMd: lastSyncedYTextBytes,
              json,
              mdManager,
              docName: opts.docName,
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
            handleBridgeMergeLoss(mergeErr, preMergeBaseline);
            if (shouldRethrowBridgeMergeLoss()) throw mergeErr;
            const asComputed = projectMerged(mergeErr.info.result);
            applyFastDiff(ytext, currentText, asComputed);
            pathBState.mergedText = asComputed;
          }
        }
      }, OBSERVER_SYNC_ORIGIN);

      if (mapDrivenSplice) incrementMapDrivenSpliceApplied();

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

      if (settlesSplitBrain(ytext.toString(), md, normMd)) {
        textDirty = true;
        recordSplitBrainRederive('post-merge');
      }
    } catch (err) {
      if (err instanceof BridgeMergeContentLossError) {
        throw err;
      }
      incrementServerObserverError('a');
      console.error('[Server Observer A] Failed to sync tree→text:', err);
      try {
        const recoveryJson = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
        const recoveryBody = mdManager.serialize(recoveryJson);
        const recoveryMd = prependFrontmatter(readCurrentFm(), recoveryBody);
        if (settlesSplitBrain(ytext.toString(), recoveryMd)) {
          recordSplitBrainRecoveryBaselines(recoveryMd);
          textDirty = true;
          recordSplitBrainRederive('error-recovery');
        } else {
          recordSettledBaselines(recoveryMd);
        }
      } catch (innerErr) {
        console.warn(
          '[Server Observer A] Baseline recovery also failed',
          JSON.stringify({
            'doc.name': opts.docName ?? null,
            originalError: err instanceof Error ? err.message : String(err),
            recoveryError: innerErr instanceof Error ? innerErr.message : String(innerErr),
          }),
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
        priorFmForTelemetry = frontmatter;
      } catch (err) {
        incrementServerObserverError('a');
        console.warn(
          '[Server Observer A] Paired-write baseline refresh failed — falling through to settlement:',
          err instanceof Error ? err.message : String(err),
        );
        xmlDirty = true;
      }
      return;
    }

    xmlDirty = true;
  };

  if (xmlFragment.length > 0 && ytext.length === 0) {
    try {
      const json = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
      const body = mdManager.serialize(json);
      const frontmatter = readCurrentFm();
      const md = prependFrontmatter(frontmatter, body);
      doc.transact(() => {
        ytext.insert(0, md);
      }, OBSERVER_SYNC_ORIGIN);
      recordSettledBaselines(md);
    } catch (err) {
      incrementServerObserverError('a');
      console.error('[Server Observer A] Failed initial sync:', err);
      recordSettledBaselines('');
    }
  }


  let priorFmForTelemetry = readCurrentFm();
  const runObserverBSyncImpl = (): void => {
    try {
      const md = ytext.toString();
      const { frontmatter, body } = stripFrontmatter(md);

      if (normalizeBridge(lastSyncedYTextBytes) === normalizeBridge(md)) {
        if (priorFmForTelemetry !== frontmatter) {
          recordFrontmatterEditSurface('source-mode');
          priorFmForTelemetry = frontmatter;
        }
        return;
      }

      const parseOpts =
        opts.resolveEmbed && opts.docName
          ? {
              resolveEmbed: opts.resolveEmbed,
              resolveSize: opts.resolveSize,
              sourcePath: opts.docName,
            }
          : undefined;
      const parsedJson = mdManager.parseWithFallback(body, parseOpts);

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

      try {
        const canonicalBody = mdManager.serialize(parsedJson);
        const canonicalYText = prependFrontmatter(frontmatter, canonicalBody);
        assertBridgeInvariant(ytext.toString(), canonicalYText, {
          site: 'observer-b',
          docName: opts.docName,
        });
        recordSettledBaselines(canonicalYText);
      } catch (reserializeErr) {
        if (reserializeErr instanceof BridgeInvariantViolationError) {
          throw reserializeErr;
        }
        console.warn(
          '[Server Observer B] Post-sync re-serialization failed — using input body as baseline:',
          reserializeErr,
        );
        recordSettledBaselines(prependFrontmatter(frontmatter, body));
      }
    } catch (err) {
      if (err instanceof BridgeInvariantViolationError) {
        throw err;
      }
      incrementServerObserverError('b');
      console.error('[Server Observer B] Failed to sync text→tree:', err);
      try {
        const postJson = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
        const postBody = mdManager.serialize(postJson);
        const fm = readCurrentFm();
        refreshCanonicalWitnessOnly(prependFrontmatter(fm, postBody));
      } catch (innerErr) {
        if (innerErr instanceof BridgeInvariantViolationError) {
          throw innerErr;
        }
        console.warn('[Server Observer B] Baseline recovery also failed:', innerErr);
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
        console.warn(
          '[Server Observer B] Paired-write baseline refresh failed — falling through to settlement:',
          err instanceof Error ? err.message : String(err),
        );
        textDirty = true;
      }
      return;
    }

    textDirty = true;
  };

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
  const detachQuiescence = attachQuiescenceTracker(doc);

  return () => {
    detachQuiescence();
    doc.off('afterAllTransactions', afterAll);
    xmlFragment.unobserveDeep(observerA);
    ytext.unobserve(observerB);
  };
}
