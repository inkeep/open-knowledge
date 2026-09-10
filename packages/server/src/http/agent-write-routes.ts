import type { ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  AGENT_ICON_COLORS,
  AgentActivitySuccessSchema,
  AgentBurstDiffSuccessSchema,
  AgentPatchRequestSchema,
  AgentPatchSuccessSchema,
  AgentUndoRequestSchema,
  AgentUndoSuccessSchema,
  AgentWriteMdRequestSchema,
  AgentWriteMdSuccessSchema,
  applyPatchToFm,
  changedBlockRange,
  colorFromSeed,
  composeWithDerivedFrontmatter,
  type DiskEditReconciledWarning,
  detectFmRegion,
  EmptyRequestSchema,
  FrontmatterPatchRequestSchema,
  FrontmatterPatchSuccessSchema,
  type LintViolationWarning,
  type Principal,
  prependFrontmatter,
  RollbackRequestSchema,
  RollbackSuccessSchema,
  SaveVersionRequestSchema,
  SaveVersionSuccessSchema,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { formatRollbackSubject } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { captureEffect } from '../activity-log.ts';
import { listAgentActivity, synthesizeVersionDiff } from '../agent-activity.ts';
import type { AgentFocusBroadcaster } from '../agent-focus.ts';
import { resolveAgentType, validateAgentId } from '../agent-id.ts';
import type { AgentPresenceBroadcaster } from '../agent-presence.ts';
import {
  AgentSessionCapacityError,
  type AgentSessionManager,
  type AgentWriteContentDivergence,
  agentWriteLossDetect,
  agentWritePreDrain,
  applyAgentMarkdownWrite,
  applyAgentUndo,
  iconFromClientName,
  prepareAgentMarkdownParse,
  prepareFrontmatterPatchParse,
  snapshotBlocks,
} from '../agent-sessions.ts';
import {
  type NormalizedSummary,
  normalizeSummary,
  type SummaryResponse,
} from '../agent-write-summary.ts';
import { composeAndWriteRawBody, type PrecomputedParse, replaceRawBody } from '../bridge-intake.ts';
import type { BridgeDeriveLossReporter } from '../bridge-loss-detector.ts';
import { isConfigDoc, isSystemDoc, SYSTEM_DOC_NAME } from '../cc1-broadcast.ts';
import { DocInConflictError, isDocInConflict, respondDocInConflict } from '../conflict-errors.ts';
import {
  evaluateContentDivergence,
  toContentDivergenceWarning,
} from '../content-divergence-gate.ts';
import { recordContributor } from '../contributor-tracker.ts';
import {
  canonicalDocName,
  docNameToRelativePath,
  registerDocExtension,
} from '../doc-extensions.ts';
import type { DocumentDurabilityState, StoreFailure } from '../document-durability-state.ts';
import {
  type ReconcileBeforeWriteResult,
  reconcileDiskBeforeAgentWrite,
} from '../external-change.ts';
import { extractActorIdentity } from '../extract-actor-identity.ts';
import type { FileIndexEntry } from '../file-watcher.ts';
import {
  FrontmatterMalformedError,
  respondFrontmatterMalformed,
} from '../frontmatter-malformed-error.ts';
import { recordFrontmatterEditSurface } from '../frontmatter-telemetry.ts';
import { type LinkAdvisoryPolicy, projectWriteAdvisoryLinks } from '../link-advisory-policy.ts';
import { getLogger } from '../logger.ts';
import { validateMermaidFences } from '../mermaid-validator.ts';
import { incrementAgentPatchFindMismatches, incrementAgentWriteCalls } from '../metrics.ts';
import { precomputeParse } from '../parse-pool.ts';
import {
  createAncestorShaSetCache,
  getOrLoadRenameLogIndex,
  resolveDocPathAtCommit,
} from '../rename-log.ts';
import type { PairedWriteOrigin } from '../server-observers.ts';
import { createVersionOpsService } from '../services/version-ops.ts';
import {
  type ShadowRef,
  safetyCheckpoint,
  shadowGit,
  type WriterIdentity,
} from '../shadow-repo.ts';
import { getMeter, withSpanSync } from '../telemetry.ts';
import { computeWriteAdvisoryLinks } from '../write-advisory-links.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { getRequestId } from './request-id.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export const ROLLBACK_ORIGIN = {
  source: 'local' as const,
  skipStoreHooks: false,
  context: { origin: 'rollback-apply', paired: true },
} as const satisfies PairedWriteOrigin;

let _hintEmittedCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
function hintEmittedCounter(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
  _hintEmittedCounter ||= getMeter().createCounter('ok.preview_attach.hint_emitted', {
    description:
      'Count of preview-attach hints emitted on write-tool responses when no editor is attached to __system__. Covers both attach-preview-once (URL exists, no browser) and start-ui (no UI running anywhere) variants — the tool side disambiguates via the warning action; the metric name is retained as-is so existing dashboards keep working.',
  });
  return _hintEmittedCounter;
}

let _agentPatchFmTouchCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null =
  null;

function agentPatchFmTouchCounter(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
  _agentPatchFmTouchCounter ||= getMeter().createCounter(
    'ok.frontmatter.agent_patch_fm_touch_total',
    {
      description:
        'Count of agent-patch calls refused for touching the frontmatter region. Bounded labels: result ∈ {rejected, pre_deprecation_passthrough}, reason ∈ {intersect, promoted}. `intersect` is a find that MATCHED inside the existing frontmatter; `promoted` is a byte-0 replace that would CREATE frontmatter on a document that had none. They refuse for opposite reasons, so a spike in one says nothing about the other — the append/prepend surface separates the same pair via the `byte-0-promotion` class on `frontmatter-malformed-write-refused`.',
    },
  );
  return _agentPatchFmTouchCounter;
}

export interface AgentWriteRouteDeps {
  getLinkAdvisoryPolicy: () => LinkAdvisoryPolicy;
  respondStaleExternalWrite: (res: ServerResponse, handler: string, docName: string) => void;
  requireNonEmptyDocName: (
    docName: string | undefined,
    res: ServerResponse,
    handler: string,
  ) => string | null;
  resolveAlias: (docName: string) => string;
  extractAgentIdentity: (body: Record<string, unknown>) => {
    rawAgentId: string | undefined;
    agentId: string;
    agentName: string;
    colorSeed: string;
    clientName: string | undefined;
    clientVersion: string | undefined;
    label: string | undefined;
  };
  docNameExistsWithAnySupportedExtension: (contentDir: string, docName: string) => boolean;
  contentDir: string;
  summaryResponseFields: (normalized: NormalizedSummary) => {
    response?: SummaryResponse;
    stored: string | undefined;
  };
  sessionManager: AgentSessionManager;
  durabilityState: DocumentDurabilityState;
  hocuspocus: Hocuspocus;
  options: {
    resolveEmbed?: (basename: string, sourcePath: string) => string | null;
  };
  getBridgeLossReporter: (() => BridgeDeriveLossReporter | undefined) | undefined;
  agentPresenceBroadcaster: AgentPresenceBroadcaster | undefined;
  recordContentDivergenceGate: (
    handler: 'agent-write-md' | 'agent-write-batch' | 'agent-patch' | 'rollback',
    divergence: AgentWriteContentDivergence | undefined,
  ) => void;
  buildAgentActor: (args: {
    clientName: string | undefined;
    clientVersion?: string;
    label?: string;
  }) => {
    principalId?: string;
    agentType?: string;
    clientName?: string;
    clientVersion?: string;
    label?: string;
  };
  countNormalizedSummary: (normalized: NormalizedSummary, fromDefault?: boolean) => void;
  flushDiskAndDetectOutcome: (
    docName: string,
  ) => Promise<
    | { kind: 'failure'; failure: StoreFailure }
    | { kind: 'divergence' }
    | { kind: 'stale-external-write' }
    | null
  >;
  respondPersistenceFailure: (res: ServerResponse, failure: StoreFailure, handler: string) => void;
  respondDiskDivergence: (res: ServerResponse, handler: string) => void;
  flushDocToDisk: (docName: string, label: string) => void;
  agentFocusBroadcaster: AgentFocusBroadcaster | undefined;
  onAgentWrite: (() => void) | undefined;
  computeOrphanHints: (
    docName: string,
  ) => Promise<Array<{ type: 'orphan'; parentCandidates: string[]; message: string }> | undefined>;
  registerWrittenDocInFileIndex: (docName: string, content: string) => void;
  collectAdmittedDocNames: () => Promise<Set<string>>;
  createLinkedFileExists: (
    allFiles?: ReadonlyMap<string, FileIndexEntry>,
  ) => (contentRootRelativePath: string) => boolean;
  createLinkedFolderExists: () => (folderPath: string) => boolean;
  buildReconcileWarning: (
    reconcile: ReconcileBeforeWriteResult,
  ) => DiskEditReconciledWarning | undefined;
  computeLintViolations: (
    source: string,
    docName: string,
    linkPolicy: LinkAdvisoryPolicy,
  ) => Promise<LintViolationWarning[]>;
  log: import('../logger.ts').PinoLogger;
  flushDocToGit: (docName: string, label: string) => void;
  isSafeDocName: (docName: string) => boolean;
  shadowRef: ShadowRef | undefined;
  getPrincipal: (() => Principal | null) | undefined;
  contentRoot: string | undefined;
  safeDocPath: (docName: string, contentRoot: string) => { path: string } | { error: string };
  getCurrentBranch: (() => string | null) | undefined;
  docTreePathCandidates: (docName: string, contentRoot: string) => readonly string[];
  stripDefaultPathTruncation: (response: SummaryResponse) => SummaryResponse;
  renameAttributionCounter: () => ReturnType<ReturnType<typeof getMeter>['createCounter']>;
}

export function createAgentWriteRoutes(deps: AgentWriteRouteDeps): ApiRouteGroup {
  const {
    getLinkAdvisoryPolicy,
    respondStaleExternalWrite,
    requireNonEmptyDocName,
    resolveAlias,
    extractAgentIdentity,
    docNameExistsWithAnySupportedExtension,
    contentDir,
    summaryResponseFields,
    sessionManager,
    durabilityState,
    hocuspocus,
    options,
    getBridgeLossReporter,
    agentPresenceBroadcaster,
    recordContentDivergenceGate,
    buildAgentActor,
    countNormalizedSummary,
    flushDiskAndDetectOutcome,
    respondPersistenceFailure,
    respondDiskDivergence,
    flushDocToDisk,
    agentFocusBroadcaster,
    onAgentWrite,
    computeOrphanHints,
    registerWrittenDocInFileIndex,
    collectAdmittedDocNames,
    createLinkedFileExists,
    createLinkedFolderExists,
    buildReconcileWarning,
    computeLintViolations,
    log,
    flushDocToGit,
    isSafeDocName,
    shadowRef,
    getPrincipal,
    contentRoot,
    safeDocPath,
    getCurrentBranch,
    docTreePathCandidates,
    stripDefaultPathTruncation,
    renameAttributionCounter,
  } = deps;
  const versionOpsService = createVersionOpsService({ getCurrentBranch, contentRoot });

  function getSubscriberCount(docName: string): number {
    try {
      const doc = hocuspocus.documents.get(docName);
      return doc?.connections.size ?? 0;
    } catch {
      return 0;
    }
  }

  function getSystemSubscriberCount(): number {
    try {
      const doc = hocuspocus.documents.get(SYSTEM_DOC_NAME);
      return doc?.connections.size ?? 0;
    } catch {
      return 0;
    }
  }

  const handleAgentWriteMd = withValidation(
    AgentWriteMdRequestSchema,
    async (_req, res, body) => {
      try {
        const linkPolicy = getLinkAdvisoryPolicy();
        const position = body.position ?? 'append';
        const effectiveDocName = requireNonEmptyDocName(body.docName, res, 'agent-write-md');
        if (effectiveDocName === null) return;
        const resolvedDocName = canonicalDocName(resolveAlias(effectiveDocName));
        const { agentId, agentName, colorSeed, clientName, clientVersion, label } =
          extractAgentIdentity(body);
        if (isSystemDoc(resolvedDocName) || isConfigDoc(resolvedDocName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${resolvedDocName}' is a reserved document name.`,
            { handler: 'agent-write-md' },
          );
          return;
        }
        if (
          body.extension !== undefined &&
          !docNameExistsWithAnySupportedExtension(contentDir, resolvedDocName)
        ) {
          registerDocExtension(resolvedDocName, body.extension);
        }
        const normalizedSummary = normalizeSummary(body.summary);
        const { response: summaryResponse, stored: storedSummary } =
          summaryResponseFields(normalizedSummary);
        const session = await sessionManager.getSession(resolvedDocName, agentId, {
          displayName: agentName,
          colorSeed,
          clientName,
        });
        const writeMdReconcile = reconcileDiskBeforeAgentWrite(
          durabilityState,
          hocuspocus,
          resolvedDocName,
          contentDir,
          options.resolveEmbed,
          getBridgeLossReporter?.(),
        );
        const writeMdEmbedResolver = options.resolveEmbed
          ? { resolveEmbed: options.resolveEmbed, sourcePath: resolvedDocName }
          : undefined;
        const writeMdPrecomputed = await prepareAgentMarkdownParse(
          session.dc.document,
          body.markdown,
          position,
          writeMdEmbedResolver,
        );
        const timestamp = new Date().toISOString();
        let writeDivergence: AgentWriteContentDivergence | undefined;
        let disposeEffectCapture: (() => void) | undefined;
        try {
          const icon = iconFromClientName(clientName);
          const color = AGENT_ICON_COLORS[icon] ?? colorFromSeed(colorSeed ?? agentId);
          agentPresenceBroadcaster?.setPresence(agentId, {
            displayName: agentName,
            icon,
            color,
            currentDoc: resolvedDocName,
            mode: 'writing',
            ts: Date.now(),
          });
          disposeEffectCapture = captureEffect(
            session.dc.document.getText('source'),
            agentId,
            session.origin,
            colorSeed,
            clientName,
          );
          agentWritePreDrain(session.dc.document, body.markdown, position);
          session.dc.document.transact(() => {
            const beforeBlocks = snapshotBlocks(session.dc.document);
            writeDivergence = applyAgentMarkdownWrite(
              session.dc.document,
              body.markdown,
              position,
              writeMdEmbedResolver,
              writeMdPrecomputed,
              agentWriteLossDetect(session),
            );
            const changedBlocks =
              changedBlockRange(beforeBlocks, snapshotBlocks(session.dc.document)) ?? undefined;
            const activityMap = session.dc.document.getMap('agent-flash');
            activityMap.set(agentId, {
              agentId,
              timestamp: Date.now(),
              type: 'insert',
              description: `Added (${agentName}): ${body.markdown.trim().slice(0, 50)}`,
              ...(changedBlocks !== undefined ? { changedBlocks } : {}),
            });
          }, session.origin);
          if (writeDivergence !== undefined) {
            console.warn(
              JSON.stringify({
                event: 'agent-write-content-divergence',
                'doc.name': resolvedDocName,
                position,
                intendedBytes: writeDivergence.intendedBytes,
                actualBytes: writeDivergence.actualBytes,
                byteDelta: writeDivergence.byteDelta,
                'agent.id': agentId,
                'agent.client_name': clientName,
              }),
            );
          }
          recordContentDivergenceGate('agent-write-md', writeDivergence);
          recordContributor(
            resolvedDocName,
            agentId,
            agentName,
            colorSeed,
            undefined,
            buildAgentActor({ clientName, clientVersion, label }),
            storedSummary,
          );
          incrementAgentWriteCalls();
          countNormalizedSummary(normalizedSummary);
        } finally {
          disposeEffectCapture?.();
          agentPresenceBroadcaster?.touchMode(agentId, 'idle');
        }
        const flushOutcome = await flushDiskAndDetectOutcome(resolvedDocName);
        if (flushOutcome?.kind === 'failure') {
          respondPersistenceFailure(res, flushOutcome.failure, 'agent-write-md');
          return;
        }
        if (flushOutcome?.kind === 'divergence') {
          respondDiskDivergence(res, 'agent-write-md');
          return;
        }
        if (flushOutcome?.kind === 'stale-external-write') {
          respondStaleExternalWrite(res, 'agent-write-md', resolvedDocName);
          return;
        }
        flushDocToDisk(resolvedDocName, 'agent-write-md');
        agentFocusBroadcaster?.setFocus(agentId, {
          agentName,
          currentDoc: resolvedDocName,
          writeKind: 'write',
          ts: Date.now(),
        });
        onAgentWrite?.();
        const hints = await computeOrphanHints(resolvedDocName);
        const writtenSource = session.dc.document.getText('source').toString();
        registerWrittenDocInFileIndex(resolvedDocName, writtenSource);
        const renderWarnings = await validateMermaidFences(writtenSource, resolvedDocName);
        const admittedForLinks = await collectAdmittedDocNames();
        admittedForLinks.add(resolvedDocName);
        const linkAdvisory = projectWriteAdvisoryLinks(
          computeWriteAdvisoryLinks(
            writtenSource,
            resolvedDocName,
            admittedForLinks,
            createLinkedFileExists(),
            createLinkedFolderExists(),
          ),
          resolvedDocName,
          linkPolicy.suppressLogLinkAdvisories,
        );
        const subscriberCount = getSubscriberCount(resolvedDocName);
        const systemSubscriberCount = getSystemSubscriberCount();
        if (systemSubscriberCount === 0) {
          hintEmittedCounter().add(1, {
            'shadow.writer': 'agent',
            'agent.type': resolveAgentType(clientName),
          });
        }
        const writeMdWarning = buildReconcileWarning(writeMdReconcile);
        const writeMdDivergenceEntry =
          writeDivergence !== undefined ? toContentDivergenceWarning(writeDivergence) : undefined;
        const writeMdAdvisories = [
          ...(writeMdDivergenceEntry ? [writeMdDivergenceEntry] : []),
          ...(writeMdWarning ? [writeMdWarning] : []),
          ...(renderWarnings ?? []),
          ...(await computeLintViolations(
            session.dc.document.getText('source').toString(),
            resolvedDocName,
            linkPolicy,
          )),
        ];
        successResponse(
          res,
          200,
          AgentWriteMdSuccessSchema,
          {
            timestamp,
            subscriberCount,
            systemSubscriberCount,
            ...(hints ? { hints } : {}),
            ...(summaryResponse ? { summary: summaryResponse } : {}),
            ...(writeMdAdvisories.length > 0 ? { warnings: writeMdAdvisories } : {}),
            ...linkAdvisory,
          },
          { handler: 'agent-write-md' },
        );
      } catch (e) {
        if (e instanceof DocInConflictError) {
          respondDocInConflict(res, e, 'agent-write-md');
          return;
        }
        if (e instanceof FrontmatterMalformedError) {
          respondFrontmatterMalformed(res, e, 'agent-write-md');
          return;
        }
        if (e instanceof AgentSessionCapacityError) {
          errorResponse(
            res,
            503,
            'urn:ok:error:too-many-agent-sessions',
            'Too many agent sessions.',
            { handler: 'agent-write-md', cause: e, extraHeaders: { 'Retry-After': '10' } },
          );
          return;
        }
        log.error({ err: e, requestId: getRequestId(_req) }, '[agent-write-md] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-write-md',
          cause: e,
        });
      }
    },
    { handler: 'agent-write-md', method: 'POST' },
  );

  const handleFrontmatterPatch = withValidation(
    FrontmatterPatchRequestSchema,
    async (_req, res, body) => {
      try {
        const linkPolicy = getLinkAdvisoryPolicy();
        const effectiveDocName = requireNonEmptyDocName(body.docName, res, 'frontmatter-patch');
        if (effectiveDocName === null) return;
        const resolvedDocName = resolveAlias(effectiveDocName);
        const { agentId, agentName, colorSeed, clientName, clientVersion, label } =
          extractAgentIdentity(body);
        if (isSystemDoc(resolvedDocName) || isConfigDoc(resolvedDocName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${resolvedDocName}' is a reserved document name.`,
            { handler: 'frontmatter-patch' },
          );
          return;
        }
        const patch = body.patch ?? {};
        const patchKeys = Object.keys(patch);
        const normalizedSummary = normalizeSummary(body.summary);
        const { response: summaryResponse, stored: storedSummary } =
          summaryResponseFields(normalizedSummary);
        const session = await sessionManager.getSession(resolvedDocName, agentId, {
          displayName: agentName,
          colorSeed,
          clientName,
        });
        const fmReconcile = reconcileDiskBeforeAgentWrite(
          durabilityState,
          hocuspocus,
          resolvedDocName,
          contentDir,
          options.resolveEmbed,
          getBridgeLossReporter?.(),
        );
        const fmPatchPrecomputed = await prepareFrontmatterPatchParse(session.dc.document, patch);
        const timestamp = new Date().toISOString();
        let editError: import('@inkeep/open-knowledge-core').FmEditError | undefined;
        let applied = false;
        let bodyMutated = false;
        const appliedKeys: string[] = [];
        try {
          const icon = iconFromClientName(clientName);
          const color = AGENT_ICON_COLORS[icon] ?? colorFromSeed(colorSeed ?? agentId);
          agentPresenceBroadcaster?.setPresence(agentId, {
            displayName: agentName,
            icon,
            color,
            currentDoc: resolvedDocName,
            mode: 'writing',
            ts: Date.now(),
          });
          withSpanSync(
            'ok.frontmatter_patch',
            {
              attributes: {
                'doc.name': resolvedDocName,
                'frontmatter_patch.keys': patchKeys.length,
              },
            },
            () => {
              session.dc.document.transact(() => {
                const ytext = session.dc.document.getText('source');
                const currentFull = ytext.toString();
                const { fenced: currentFenced, body: currentBody } = detectFmRegion(currentFull);
                const result = applyPatchToFm(currentFenced, patch);
                if (!result.ok) {
                  editError = result.error;
                  return;
                }
                for (const key of Object.keys(patch)) {
                  appliedKeys.push(key);
                }
                if (result.nextFenced !== currentFenced) {
                  /**
                   * Routed through the sanctioned `composeAndWriteRawBody` primitive
                   * (precedent #38) so paired-write semantics survive.
                   */
                  const needsFenceSeparator =
                    currentFenced === '' && currentBody !== '' && !currentBody.startsWith('\n');
                  const newFull = composeWithDerivedFrontmatter(
                    result.nextFenced,
                    (needsFenceSeparator ? '\n' : '') + currentBody,
                  ).md;
                  composeAndWriteRawBody(
                    session.dc.document,
                    newFull,
                    'agent',
                    undefined,
                    fmPatchPrecomputed,
                  );
                  recordFrontmatterEditSurface('mcp-write');
                  bodyMutated = true;
                }
                applied = true;
              }, session.origin);
            },
          );
        } finally {
          agentPresenceBroadcaster?.touchMode(agentId, 'idle');
        }
        if (editError) {
          let fieldErrors: Record<string, string>;
          switch (editError.kind) {
            case 'invalid_value':
              fieldErrors = { [editError.key]: editError.reason };
              break;
            case 'reserved_key':
              fieldErrors = { [editError.key]: `'${editError.key}' is reserved` };
              break;
            case 'unknown_key':
              fieldErrors = { [editError.key]: `'${editError.key}' is not a recognized key` };
              break;
            case 'duplicate_target':
              fieldErrors = { [editError.key]: `'${editError.key}' appears more than once` };
              break;
            case 'reorder_mismatch':
              fieldErrors = {
                __region__: `frontmatter reorder mismatch (expected: ${editError.expected.join(', ')}; got: ${editError.got.join(', ')})`,
              };
              break;
            case 'region_too_large':
              fieldErrors = {
                __region__: `frontmatter region too large (${editError.bytes} > ${editError.limit} bytes)`,
              };
              break;
            case 'parse_failed':
              fieldErrors = { __region__: `frontmatter region unparseable: ${editError.reason}` };
              break;
            case 'invalid_path':
              fieldErrors = {
                [editError.path.map(String).join('.') || '__path__']: editError.reason,
              };
              break;
            default: {
              const _exhaustive: never = editError;
              fieldErrors = {
                __region__: `unhandled frontmatter edit error (${String(_exhaustive)})`,
              };
            }
          }
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-frontmatter-patch',
            'Frontmatter patch rejected: schema validation failed.',
            { handler: 'frontmatter-patch', extensions: { fieldErrors } },
          );
          return;
        }
        if (applied && appliedKeys.length > 0) {
          recordContributor(
            resolvedDocName,
            agentId,
            agentName,
            colorSeed,
            undefined,
            buildAgentActor({ clientName, clientVersion, label }),
            storedSummary,
          );
          incrementAgentWriteCalls();
          countNormalizedSummary(normalizedSummary);
          if (bodyMutated) {
            const flushOutcome = await flushDiskAndDetectOutcome(resolvedDocName);
            if (flushOutcome?.kind === 'failure') {
              respondPersistenceFailure(res, flushOutcome.failure, 'frontmatter-patch');
              return;
            }
            if (flushOutcome?.kind === 'divergence') {
              respondDiskDivergence(res, 'frontmatter-patch');
              return;
            }
            if (flushOutcome?.kind === 'stale-external-write') {
              respondStaleExternalWrite(res, 'frontmatter-patch', resolvedDocName);
              return;
            }
          }
          flushDocToDisk(resolvedDocName, 'frontmatter-patch');
        }
        agentFocusBroadcaster?.setFocus(agentId, {
          agentName,
          currentDoc: resolvedDocName,
          writeKind: 'write',
          ts: Date.now(),
        });
        onAgentWrite?.();
        const subscriberCount = getSubscriberCount(resolvedDocName);
        const systemSubscriberCount = getSystemSubscriberCount();
        if (systemSubscriberCount === 0) {
          hintEmittedCounter().add(1, {
            'shadow.writer': 'agent',
            'agent.type': resolveAgentType(clientName),
          });
        }
        const fmWarning = buildReconcileWarning(fmReconcile);
        registerWrittenDocInFileIndex(
          resolvedDocName,
          session.dc.document.getText('source').toString(),
        );
        const admittedForLinks = await collectAdmittedDocNames();
        admittedForLinks.add(resolvedDocName);
        const linkAdvisory = projectWriteAdvisoryLinks(
          computeWriteAdvisoryLinks(
            session.dc.document.getText('source').toString(),
            resolvedDocName,
            admittedForLinks,
            createLinkedFileExists(),
          ),
          resolvedDocName,
          linkPolicy.suppressLogLinkAdvisories,
        );
        successResponse(
          res,
          200,
          FrontmatterPatchSuccessSchema,
          {
            timestamp,
            subscriberCount,
            systemSubscriberCount,
            appliedKeys,
            ...(summaryResponse ? { summary: summaryResponse } : {}),
            ...(fmWarning ? { warnings: [fmWarning] } : {}),
            ...linkAdvisory,
          },
          { handler: 'frontmatter-patch' },
        );
      } catch (e) {
        if (e instanceof AgentSessionCapacityError) {
          errorResponse(
            res,
            503,
            'urn:ok:error:too-many-agent-sessions',
            'Too many agent sessions.',
            { handler: 'frontmatter-patch', cause: e, extraHeaders: { 'Retry-After': '10' } },
          );
          return;
        }
        log.error({ err: e, requestId: getRequestId(_req) }, '[frontmatter-patch] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'frontmatter-patch',
          cause: e,
        });
      }
    },
    { handler: 'frontmatter-patch', method: 'POST' },
  );

  const handleAgentPatch = withValidation(
    AgentPatchRequestSchema,
    async (_req, res, body) => {
      try {
        const linkPolicy = getLinkAdvisoryPolicy();
        const { find, replace, offset } = body;
        const effectivePatchDocName = requireNonEmptyDocName(body.docName, res, 'agent-patch');
        if (effectivePatchDocName === null) return;
        const docName = resolveAlias(effectivePatchDocName);
        const { agentId, agentName, colorSeed, clientName, clientVersion, label } =
          extractAgentIdentity(body);
        if (isSystemDoc(docName) || isConfigDoc(docName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${docName}' is a reserved document name.`,
            { handler: 'agent-patch' },
          );
          return;
        }
        const normalizedSummary = normalizeSummary(body.summary);
        const session = await sessionManager.getSession(docName, agentId, {
          displayName: agentName,
          colorSeed,
          clientName,
        });
        const patchReconcile = reconcileDiskBeforeAgentWrite(
          durabilityState,
          hocuspocus,
          docName,
          contentDir,
          options.resolveEmbed,
          getBridgeLossReporter?.(),
        );
        const patchEmbedResolver = options.resolveEmbed
          ? { resolveEmbed: options.resolveEmbed, sourcePath: docName }
          : undefined;
        let patchPrecomputed: PrecomputedParse | undefined;
        {
          const preSnapshot = session.dc.document.getText('source').toString();
          const { frontmatter: preFm, body: preBody } = stripFrontmatter(preSnapshot);
          const preFull = prependFrontmatter(preFm, preBody);
          const prePos =
            offset == null
              ? preFull.indexOf(find)
              : preFull.slice(offset, offset + find.length) === find
                ? offset
                : -1;
          if (prePos !== -1 && prePos >= preFm.length) {
            const guessFull =
              preFull.slice(0, prePos) + replace + preFull.slice(prePos + find.length);
            patchPrecomputed = await prepareAgentMarkdownParse(
              session.dc.document,
              stripFrontmatter(guessFull).body,
              'patch',
              patchEmbedResolver,
            );
          }
        }
        const timestamp = new Date().toISOString();
        let notFound = false;
        let staleTarget = false;
        let fmIntersect = false;
        let fmPromoted = false;
        let patchDivergence: AgentWriteContentDivergence | undefined;
        let disposeEffectCapture: (() => void) | undefined;
        try {
          const icon = iconFromClientName(clientName);
          const color = AGENT_ICON_COLORS[icon] ?? colorFromSeed(colorSeed ?? agentId);
          agentPresenceBroadcaster?.setPresence(agentId, {
            displayName: agentName,
            icon,
            color,
            currentDoc: docName,
            mode: 'writing',
            ts: Date.now(),
          });
          disposeEffectCapture = captureEffect(
            session.dc.document.getText('source'),
            agentId,
            session.origin,
            colorSeed,
            clientName,
          );
          session.dc.document.transact(() => {
            /**
             * Read current authoritative state from Y.Text, the user's intended source-form bytes
             * (Y.Text-is-truth, precedent #38); `serialize(fragment)` would compute offsets against
             * canonical bytes instead.
             */
            const ytextSnapshot = session.dc.document.getText('source').toString();
            const { frontmatter: currentFm, body: currentBody } = stripFrontmatter(ytextSnapshot);
            const currentFull = prependFrontmatter(currentFm, currentBody);
            const pos =
              offset == null
                ? currentFull.indexOf(find)
                : currentFull.slice(offset, offset + find.length) === find
                  ? offset
                  : -1;
            if (pos === -1) {
              if (offset == null) {
                notFound = true;
              } else {
                staleTarget = true;
              }
              console.warn(
                JSON.stringify({
                  event: 'agent-patch-find-mismatch',
                  'doc.name': docName,
                  findLength: find.length,
                  replaceLength: replace.length,
                  hadOffset: offset != null,
                }),
              );
              incrementAgentPatchFindMismatches();
              return;
            }
            if (pos < currentFm.length) {
              fmIntersect = true;
              return;
            }
            const newFull =
              currentFull.slice(0, pos) + replace + currentFull.slice(pos + find.length);
            if (currentFm === '' && stripFrontmatter(newFull).frontmatter !== '') {
              fmPromoted = true;
              return;
            }
            const { body: newBody } = stripFrontmatter(newFull);
            const beforeBlocks = snapshotBlocks(session.dc.document);
            patchDivergence = applyAgentMarkdownWrite(
              session.dc.document,
              newBody,
              'patch',
              patchEmbedResolver,
              patchPrecomputed,
              agentWriteLossDetect(session),
            );
            const changedBlocks =
              changedBlockRange(beforeBlocks, snapshotBlocks(session.dc.document)) ?? undefined;
            const activityMap = session.dc.document.getMap('agent-flash');
            activityMap.set(agentId, {
              agentId,
              timestamp: Date.now(),
              type: 'insert',
              description: `Patched (${agentName}): ${find.slice(0, 50)}`,
              ...(changedBlocks !== undefined ? { changedBlocks } : {}),
            });
          }, session.origin);
          if (patchDivergence !== undefined) {
            console.warn(
              JSON.stringify({
                event: 'agent-write-content-divergence',
                'doc.name': docName,
                position: 'patch',
                intendedBytes: patchDivergence.intendedBytes,
                actualBytes: patchDivergence.actualBytes,
                byteDelta: patchDivergence.byteDelta,
                'agent.id': agentId,
                'agent.client_name': clientName,
              }),
            );
          }
          if (!notFound && !staleTarget && !fmIntersect && !fmPromoted) {
            const { stored: storedSummary } = summaryResponseFields(normalizedSummary);
            recordContributor(
              docName,
              agentId,
              agentName,
              colorSeed,
              undefined,
              buildAgentActor({ clientName, clientVersion, label }),
              storedSummary,
            );
            incrementAgentWriteCalls();
            countNormalizedSummary(normalizedSummary);
            recordContentDivergenceGate('agent-patch', patchDivergence);
          }
        } finally {
          disposeEffectCapture?.();
          agentPresenceBroadcaster?.touchMode(agentId, 'idle');
        }
        if (staleTarget) {
          errorResponse(
            res,
            409,
            'urn:ok:error:stale-target',
            'Target text no longer matches at the requested offset.',
            { handler: 'agent-patch' },
          );
          return;
        }
        if (notFound) {
          errorResponse(res, 404, 'urn:ok:error:target-not-found', 'Text not found in document.', {
            handler: 'agent-patch',
          });
          return;
        }
        if (fmIntersect) {
          agentPatchFmTouchCounter().add(1, { result: 'rejected', reason: 'intersect' });
          errorResponse(
            res,
            400,
            'urn:ok:error:frontmatter-edit-not-supported',
            'Frontmatter edits are not supported via a body find/replace. Use edit({ document: { path, frontmatter } }) to change frontmatter, or write({ document: { path, content, position: "replace" } }) to rewrite the whole document including its YAML block.',
            { handler: 'agent-patch' },
          );
          return;
        }
        if (fmPromoted) {
          agentPatchFmTouchCounter().add(1, { result: 'rejected', reason: 'promoted' });
          errorResponse(
            res,
            400,
            'urn:ok:error:frontmatter-edit-not-supported',
            "This edit would turn the replacement text into the document's frontmatter: the document has no frontmatter, the match starts at byte 0, and `replace` opens a `---` fence pair — so the composed document would re-read that block as its YAML region. Use edit({ document: { path, frontmatter } }) to set frontmatter, or keep the `---` out of the first line (a leading blank line, or `***` / `___` for a thematic break).",
            { handler: 'agent-patch' },
          );
          return;
        }
        const flushOutcome = await flushDiskAndDetectOutcome(docName);
        if (flushOutcome?.kind === 'failure') {
          respondPersistenceFailure(res, flushOutcome.failure, 'agent-patch');
          return;
        }
        if (flushOutcome?.kind === 'divergence') {
          respondDiskDivergence(res, 'agent-patch');
          return;
        }
        if (flushOutcome?.kind === 'stale-external-write') {
          respondStaleExternalWrite(res, 'agent-patch', docName);
          return;
        }
        flushDocToDisk(docName, 'agent-patch');
        agentFocusBroadcaster?.setFocus(agentId, {
          agentName,
          currentDoc: docName,
          writeKind: 'edit',
          ts: Date.now(),
        });
        onAgentWrite?.();
        const subscriberCount = getSubscriberCount(docName);
        const systemSubscriberCount = getSystemSubscriberCount();
        if (systemSubscriberCount === 0) {
          hintEmittedCounter().add(1, {
            'shadow.writer': 'agent',
            'agent.type': resolveAgentType(clientName),
          });
        }
        const { response: summaryResponse } = summaryResponseFields(normalizedSummary);
        const patchedSource = session.dc.document.getText('source').toString();
        registerWrittenDocInFileIndex(docName, patchedSource);
        const renderWarnings = await validateMermaidFences(patchedSource, docName);
        const admittedForLinks = await collectAdmittedDocNames();
        admittedForLinks.add(docName);
        const linkAdvisory = projectWriteAdvisoryLinks(
          computeWriteAdvisoryLinks(
            patchedSource,
            docName,
            admittedForLinks,
            createLinkedFileExists(),
          ),
          docName,
          linkPolicy.suppressLogLinkAdvisories,
        );
        const patchWarning = buildReconcileWarning(patchReconcile);
        const patchDivergenceEntry =
          patchDivergence !== undefined ? toContentDivergenceWarning(patchDivergence) : undefined;
        const patchAdvisories = [
          ...(patchDivergenceEntry ? [patchDivergenceEntry] : []),
          ...(patchWarning ? [patchWarning] : []),
          ...(renderWarnings ?? []),
          ...(await computeLintViolations(
            session.dc.document.getText('source').toString(),
            docName,
            linkPolicy,
          )),
        ];
        successResponse(
          res,
          200,
          AgentPatchSuccessSchema,
          {
            timestamp,
            subscriberCount,
            systemSubscriberCount,
            ...(summaryResponse ? { summary: summaryResponse } : {}),
            ...(patchAdvisories.length > 0 ? { warnings: patchAdvisories } : {}),
            ...linkAdvisory,
          },
          { handler: 'agent-patch' },
        );
      } catch (e) {
        if (e instanceof DocInConflictError) {
          respondDocInConflict(res, e, 'agent-patch');
          return;
        }
        if (e instanceof FrontmatterMalformedError) {
          respondFrontmatterMalformed(res, e, 'agent-patch');
          return;
        }
        if (e instanceof AgentSessionCapacityError) {
          errorResponse(
            res,
            503,
            'urn:ok:error:too-many-agent-sessions',
            'Too many agent sessions.',
            { handler: 'agent-patch', cause: e, extraHeaders: { 'Retry-After': '10' } },
          );
          return;
        }
        log.error({ err: e, requestId: getRequestId(_req) }, '[agent-patch] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-patch',
          cause: e,
        });
      }
    },
    { handler: 'agent-patch', method: 'POST' },
  );

  const handleAgentUndo = withValidation(
    AgentUndoRequestSchema,
    async (_req, res, body) => {
      try {
        const rawDocName = requireNonEmptyDocName(body.docName, res, 'agent-undo');
        if (rawDocName === null) return;
        const docName = resolveAlias(rawDocName);
        const { agentId, agentName, colorSeed, clientName, clientVersion, label } =
          extractAgentIdentity(body);
        if (isSystemDoc(docName) || isConfigDoc(docName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${docName}' is a reserved document name.`,
            { handler: 'agent-undo' },
          );
          return;
        }
        const { connectionId } = body;
        let scope: 'last' | 'session' | 'count';
        let count: number | undefined;
        if (body.scope === 'count') {
          scope = 'count';
          count = body.count;
        } else if (body.scope === 'session' || body.scope === 'file') {
          scope = 'session';
        } else {
          scope = 'last';
        }
        if (!sessionManager.hasSession(docName, connectionId)) {
          errorResponse(
            res,
            404,
            'urn:ok:error:no-active-session',
            'No active session for this connectionId and docName.',
            { handler: 'agent-undo' },
          );
          return;
        }
        const session = await sessionManager.getSession(docName, connectionId);
        let undone = false;
        try {
          const icon = iconFromClientName(clientName);
          const color = AGENT_ICON_COLORS[icon] ?? colorFromSeed(colorSeed ?? agentId);
          agentPresenceBroadcaster?.setPresence(agentId, {
            displayName: agentName,
            icon,
            color,
            currentDoc: docName,
            mode: 'writing',
            ts: Date.now(),
          });
          undone = applyAgentUndo(
            session,
            scope,
            options.resolveEmbed
              ? { resolveEmbed: options.resolveEmbed, sourcePath: docName }
              : undefined,
            count,
          );
          if (undone) {
            recordContributor(
              docName,
              connectionId,
              agentName,
              colorSeed,
              undefined,
              buildAgentActor({ clientName, clientVersion, label }),
            );
          }
        } finally {
          agentPresenceBroadcaster?.touchMode(agentId, 'idle');
        }
        if (undone) {
          const flushOutcome = await flushDiskAndDetectOutcome(docName);
          if (flushOutcome?.kind === 'failure') {
            respondPersistenceFailure(res, flushOutcome.failure, 'agent-undo');
            return;
          }
          if (flushOutcome?.kind === 'divergence') {
            respondDiskDivergence(res, 'agent-undo');
            return;
          }
          if (flushOutcome?.kind === 'stale-external-write') {
            respondStaleExternalWrite(res, 'agent-undo', docName);
            return;
          }
          flushDocToGit(docName, 'agent-undo');
        }
        agentFocusBroadcaster?.setFocus(connectionId, {
          agentName: connectionId,
          currentDoc: docName,
          writeKind: 'undo',
          ts: Date.now(),
        });
        successResponse(
          res,
          200,
          AgentUndoSuccessSchema,
          { docName, scope, undone },
          { handler: 'agent-undo' },
        );
      } catch (e) {
        if (e instanceof DocInConflictError) {
          respondDocInConflict(res, e, 'agent-undo');
          return;
        }
        log.error({ err: e, requestId: getRequestId(_req) }, '[agent-undo] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-undo',
          cause: e,
        });
      }
    },
    { handler: 'agent-undo', method: 'POST' },
  );

  const handleAgentActivity = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const agentId = validateAgentId(url.searchParams.get('agentId'));
        if (agentId === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'agentId required (alphanumeric/_/- only).',
            { handler: 'agent-activity' },
          );
          return;
        }
        const result = listAgentActivity(sessionManager, agentId);
        successResponse(res, 200, AgentActivitySuccessSchema, result, {
          handler: 'agent-activity',
        });
      } catch (e) {
        log.error({ err: e, requestId: getRequestId(req) }, '[agent-activity] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-activity',
          cause: e,
        });
      }
    },
    { handler: 'agent-activity', method: 'GET', skipBodyParse: true },
  );

  const handleAgentBurstDiff = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const agentId = validateAgentId(url.searchParams.get('agentId'));
        const rawDocName = url.searchParams.get('docName');
        const keptCountStr = url.searchParams.get('keptCount');
        if (agentId === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'agentId required (alphanumeric/_/- only).',
            { handler: 'agent-burst-diff' },
          );
          return;
        }
        if (!rawDocName || rawDocName.trim() === '') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing docName parameter.', {
            handler: 'agent-burst-diff',
          });
          return;
        }
        if (!isSafeDocName(rawDocName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'agent-burst-diff',
          });
          return;
        }
        const docName = resolveAlias(rawDocName);
        if (isSystemDoc(docName) || isConfigDoc(docName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${docName}' is a reserved document name.`,
            { handler: 'agent-burst-diff' },
          );
          return;
        }
        if (!keptCountStr || Number.isNaN(Number(keptCountStr))) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'keptCount must be a number.', {
            handler: 'agent-burst-diff',
          });
          return;
        }
        const keptCount = Number(keptCountStr);
        if (!Number.isInteger(keptCount) || keptCount < 0) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'keptCount must be a non-negative integer.',
            { handler: 'agent-burst-diff' },
          );
          return;
        }
        const session = sessionManager.getLiveSession(docName, agentId);
        if (!session) {
          errorResponse(
            res,
            404,
            'urn:ok:error:no-active-session',
            'No active session for this agentId and docName.',
            { handler: 'agent-burst-diff' },
          );
          return;
        }
        const um = session.um;
        if (keptCount > um.undoStack.length) {
          errorResponse(
            res,
            404,
            'urn:ok:error:not-found',
            `keptCount ${keptCount} out of range (stack has ${um.undoStack.length} items).`,
            { handler: 'agent-burst-diff' },
          );
          return;
        }
        const ytext = session.dc.document.getText('source');
        const { diff, before, after, properties } = synthesizeVersionDiff(
          // biome-ignore lint/suspicious/noExplicitAny: Y.StackItem is internal to yjs — structural shape matches YjsStackItemShape in agent-activity.ts
          um.undoStack as any,
          keptCount,
          ytext,
          docName,
        );
        successResponse(
          res,
          200,
          AgentBurstDiffSuccessSchema,
          { diff, before, after, properties, generatedAt: Date.now() },
          { handler: 'agent-burst-diff' },
        );
      } catch (e) {
        log.error({ err: e, requestId: getRequestId(req) }, '[agent-burst-diff] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-burst-diff',
          cause: e,
        });
      }
    },
    { handler: 'agent-burst-diff', method: 'GET', skipBodyParse: true },
  );

  const handleSaveVersion = withValidation(
    SaveVersionRequestSchema,
    async (_req, res, body) => {
      try {
        const saveVersionBody = body as unknown as Record<string, unknown>;
        const {
          rawAgentId: svRawAgentId,
          agentId: svAgentId,
          agentName: svAgentName,
          clientName: svClientName,
        } = extractAgentIdentity(saveVersionBody);
        const shadow = shadowRef?.current;
        if (!shadow) {
          errorResponse(
            res,
            503,
            'urn:ok:error:shadow-not-configured',
            'Shadow repo not configured.',
            { handler: 'save-version' },
          );
          return;
        }
        const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
        let writers: WriterIdentity[] = [];
        if (Array.isArray(body.writers)) {
          try {
            writers = body.writers.map((w) => {
              const id = w.id ?? 'unknown';
              if (!SAFE_ID_RE.test(id)) {
                throw new Error(`Invalid writer id: ${id}`);
              }
              return {
                id,
                name: (w.name ?? 'unknown').replace(/[\r\n]/g, ''),
                email: (w.email ?? 'noreply@openknowledge.local').replace(/[\r\n]/g, ''),
              };
            });
          } catch (e) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              e instanceof Error ? e.message : 'Invalid writer id.',
              { handler: 'save-version', cause: e },
            );
            return;
          }
        }
        const agentWriter =
          svRawAgentId !== undefined
            ? {
                id: svAgentId,
                name: svClientName ? `${svAgentName} (${svClientName})` : svAgentName,
                email: `${svAgentId}@openknowledge.local`,
              }
            : undefined;
        const checkpointSummary = normalizeSummary(
          typeof body.summary === 'string' ? body.summary : undefined,
        );
        const result = await versionOpsService.saveCheckpoint(shadow, {
          explicitWriters: writers,
          agentWriter,
          summary: checkpointSummary.kind === 'value' ? checkpointSummary.value : undefined,
        });
        successResponse(
          res,
          200,
          SaveVersionSuccessSchema,
          {
            checkpointRef: result.checkpointRef,
          },
          { handler: 'save-version' },
        );
      } catch (e) {
        log.error({ err: e, requestId: getRequestId(_req) }, '[save-version] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'save-version',
          cause: e,
        });
      }
    },
    { handler: 'save-version', method: 'POST' },
  );

  const handleRollback = withValidation(
    RollbackRequestSchema,
    async (_req, res, body) => {
      const bodyObj = body as unknown as Record<string, unknown>;
      const actor = extractActorIdentity(bodyObj, getPrincipal);
      if (actor.kind === 'invalid-summary') {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
          handler: 'rollback',
        });
        return;
      }
      // The check fires post-identity (precedent #24) and pre-mutation.
      const targetDoc = hocuspocus.documents.get(body.docName);
      if (targetDoc && isDocInConflict(targetDoc)) {
        respondDocInConflict(
          res,
          new DocInConflictError({ file: docNameToRelativePath(body.docName) }),
          'rollback',
        );
        return;
      }
      const shadow = shadowRef?.current;
      if (!shadow) {
        errorResponse(
          res,
          503,
          'urn:ok:error:rollback-not-configured',
          'Shadow repo not configured.',
          { handler: 'rollback' },
        );
        return;
      }
      const { docName, commitSha } = body;
      const resolvedContentRoot = contentRoot ?? '.';
      const pathResult = safeDocPath(docName, resolvedContentRoot);
      if ('error' in pathResult) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', pathResult.error, {
          handler: 'rollback',
        });
        return;
      }
      const sg = shadowGit(shadow);
      const t0 = Date.now();
      try {
        const renameLogIndex = getOrLoadRenameLogIndex(shadow.gitDir);
        const ancestorCache = createAncestorShaSetCache();
        const branch = getCurrentBranch?.() ?? 'main';
        const historicalPath = await resolveDocPathAtCommit(
          shadow,
          docName,
          commitSha,
          branch,
          renameLogIndex,
          (name) => docTreePathCandidates(name, resolvedContentRoot),
          ancestorCache,
        );
        if (historicalPath === null) {
          errorResponse(
            res,
            404,
            'urn:ok:error:doc-not-found',
            `Commit ${commitSha.slice(0, 7)} does not contain document ${docName} at any known historical path.`,
            { handler: 'rollback' },
          );
          return;
        }
        const markdown = await sg.raw('show', `${commitSha}:${historicalPath}`);
        const timestamp = new Date().toISOString();
        await safetyCheckpoint(shadow, resolvedContentRoot, {
          action: 'rollback',
          context: { docName, targetSha: commitSha },
        });
        const document = hocuspocus.documents.get(docName);
        if (!document) {
          errorResponse(
            res,
            409,
            'urn:ok:error:doc-not-open',
            'Document is not currently open — open it in the editor first.',
            { handler: 'rollback' },
          );
          return;
        }
        /**
         * Rollback routes through the `replaceRawBody` sibling primitive (precedent #38,
         * Y.Text-is-truth), which overwrites ytext first and derives the fragment after.
         */
        const rollbackEmbedResolver = options.resolveEmbed
          ? { resolveEmbed: options.resolveEmbed, sourcePath: docName }
          : undefined;
        const rollbackPrecomputed = await precomputeParse(markdown, rollbackEmbedResolver);
        let rollbackDivergence: AgentWriteContentDivergence | undefined;
        document.transact(() => {
          replaceRawBody(document, markdown, rollbackEmbedResolver, rollbackPrecomputed);
          rollbackDivergence = evaluateContentDivergence(
            document.getText('source').toString(),
            markdown,
            'rollback',
          );
        }, ROLLBACK_ORIGIN);
        if (rollbackDivergence !== undefined) {
          console.warn(
            JSON.stringify({
              event: 'agent-write-content-divergence',
              'doc.name': docName,
              position: 'rollback',
              intendedBytes: rollbackDivergence.intendedBytes,
              actualBytes: rollbackDivergence.actualBytes,
              byteDelta: rollbackDivergence.byteDelta,
              'actor.kind': actor.kind,
              ...(actor.kind === 'agent' || actor.kind === 'principal'
                ? { 'actor.writer_id': actor.writerId }
                : {}),
            }),
          );
        }
        recordContentDivergenceGate('rollback', rollbackDivergence);
        let summaryResponse: SummaryResponse | undefined;
        switch (actor.kind) {
          case 'agent': {
            const shaShort = commitSha.slice(0, 8);
            const agentProvidedSummary = actor.summary.kind === 'value';
            const effectiveNormalized = agentProvidedSummary
              ? actor.summary
              : normalizeSummary(`Restored to ${shaShort}`);
            const fields = summaryResponseFields(effectiveNormalized);
            summaryResponse =
              agentProvidedSummary || !fields.response
                ? fields.response
                : stripDefaultPathTruncation(fields.response);
            recordContributor(
              docName,
              actor.writerId,
              actor.displayName,
              actor.colorSeed,
              formatRollbackSubject(docName, commitSha),
              actor.actor,
              fields.stored,
            );
            incrementAgentWriteCalls();
            countNormalizedSummary(effectiveNormalized, !agentProvidedSummary);
            break;
          }
          case 'principal': {
            const fields = summaryResponseFields(actor.summary);
            summaryResponse = fields.response;
            recordContributor(
              docName,
              actor.writerId,
              actor.displayName,
              actor.colorSeed,
              formatRollbackSubject(docName, commitSha),
              actor.actor,
              fields.stored,
            );
            countNormalizedSummary(actor.summary, false);
            break;
          }
          case 'anonymous':
            log.debug(
              { docName, commitSha: commitSha.slice(0, 8) },
              '[rollback] anonymous actor — no contributor recorded (no agentId in body and getPrincipal() returned null)',
            );
            break;
          default: {
            const _exhaustive: never = actor;
            throw new Error(
              `Unhandled actor kind in handleRollback: ${String(
                (
                  _exhaustive as {
                    kind?: unknown;
                  }
                ).kind,
              )}`,
            );
          }
        }
        renameAttributionCounter().add(1, { kind: 'rollback', attribution_kind: actor.kind });
        const flushOutcome = await flushDiskAndDetectOutcome(docName);
        if (flushOutcome?.kind === 'failure') {
          respondPersistenceFailure(res, flushOutcome.failure, 'rollback');
          return;
        }
        if (flushOutcome?.kind === 'divergence') {
          respondDiskDivergence(res, 'rollback');
          return;
        }
        if (flushOutcome?.kind === 'stale-external-write') {
          respondStaleExternalWrite(res, 'rollback', docName);
          return;
        }
        flushDocToGit(docName, 'rollback');
        const duration = Date.now() - t0;
        getLogger('rollback').info(
          { docName, from: commitSha.slice(0, 8), durationMs: duration },
          'rollback',
        );
        if (actor.kind === 'agent') {
          agentFocusBroadcaster?.setFocus(actor.writerId, {
            agentName: actor.displayName,
            currentDoc: docName,
            writeKind: 'rollback-apply',
            ts: Date.now(),
          });
        }
        const rollbackDivergenceEntry =
          rollbackDivergence !== undefined
            ? toContentDivergenceWarning(rollbackDivergence)
            : undefined;
        successResponse(
          res,
          200,
          RollbackSuccessSchema,
          {
            restoredFrom: commitSha,
            timestamp,
            ...(summaryResponse ? { summary: summaryResponse } : {}),
            ...(rollbackDivergenceEntry ? { warnings: [rollbackDivergenceEntry] } : {}),
          },
          { handler: 'rollback' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to roll back.', {
          handler: 'rollback',
          cause: e,
        });
      }
    },
    { handler: 'rollback', method: 'POST' },
  );
  return createApiRouteGroup(
    {
      '/api/agent-write-md': handleAgentWriteMd,
      '/api/frontmatter-patch': handleFrontmatterPatch,
      '/api/agent-patch': handleAgentPatch,
      '/api/agent-undo': handleAgentUndo,
      '/api/agent-activity': handleAgentActivity,
      '/api/agent-burst-diff': handleAgentBurstDiff,
      '/api/save-version': handleSaveVersion,
      '/api/rollback': handleRollback,
    },
    {
      mutating: [
        '/api/agent-write-md',
        '/api/frontmatter-patch',
        '/api/agent-patch',
        '/api/agent-undo',
        '/api/save-version',
        '/api/rollback',
      ],
    },
  );
}
