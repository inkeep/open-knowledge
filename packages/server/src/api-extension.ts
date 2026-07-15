/**
 * HTTP API extension for Hocuspocus — agent write, file ops, and test reset endpoints.
 *
 * Implemented as a Hocuspocus onRequest extension so it works with both
 * the production Server (assembled by `createServer()` in `server-factory.ts`)
 * and the Vite dev plugin.
 */

import { type SpawnOptions, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  type Dirent,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as wait } from 'node:timers/promises';
import type { Document, Extension, Hocuspocus } from '@hocuspocus/server';
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
  AgentWriteRequestSchema,
  AgentWriteSuccessSchema,
  ApiConfigSuccessSchema,
  ASSET_EXTENSIONS,
  applyPatchToFm,
  BacklinkCountsSuccessSchema,
  BacklinksSuccessSchema,
  BranchInfoResponseSchema,
  CheckoutRequestSchema,
  CheckoutResponseSchema,
  CLIENT_VERSION_HEADER,
  ClientLogsRequestSchema,
  ClientLogsSuccessSchema,
  CONFIG_DOC_NAME_OKIGNORE,
  CreateFolderRequestSchema,
  CreateFolderSuccessSchema,
  CreatePageRequestSchema,
  CreatePageSuccessSchema,
  colorFromSeed,
  createCodeFenceTracker,
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  DEFAULT_ATTACHMENT_FOLDER_PATH,
  DEFAULT_DEDUP_MODE,
  DeadLinksSuccessSchema,
  DeletePathRequestSchema,
  DeletePathSuccessSchema,
  type DiskEditReconciledWarning,
  type DocumentListEntry,
  DocumentListSuccessSchema,
  DocumentReadSuccessSchema,
  DuplicatePathRequestSchema,
  DuplicatePathSuccessSchema,
  detectFmRegion,
  type EditorId,
  EmbedDetectSuccessSchema,
  EmptyRequestSchema,
  encodeShareUrl,
  FolderConfigGetSuccessSchema,
  FolderConfigPutRequestSchema,
  FolderConfigPutSuccessSchema,
  ForwardLinksSuccessSchema,
  FrontmatterPatchRequestSchema,
  FrontmatterPatchSuccessSchema,
  getHeadingSlug,
  getParseHealth,
  type HeadingEntry,
  HistorySuccessSchema,
  HistoryVersionSuccessSchema,
  HubsSuccessSchema,
  INLINE_RENDERABLE_EXTENSIONS,
  type InlineAssetMediaKind,
  InstallSkillRequestSchema,
  InstallSkillSuccessSchema,
  instantiateDoc,
  isHiddenDocName,
  isManagedArtifactDocName,
  isValidAttachmentFolderPath,
  LINKABLE_ASSET_EXTENSIONS,
  type LifecycleStatus,
  LinkGraphSuccessSchema,
  LocalOpAuthEmptySuccessSchema,
  type LocalOpAuthHostRequest,
  LocalOpAuthHostRequestSchema,
  LocalOpAuthSetIdentityRequestSchema,
  LocalOpAuthStatusSuccessSchema,
  type LocalOpCloneRequest,
  LocalOpCloneRequestSchema,
  LocalOpEmbeddingsMutationSuccessSchema,
  LocalOpEmbeddingsSetKeyRequestSchema,
  LocalOpOkInitRequestSchema,
  LocalOpOkInitResponseSchema,
  MANAGED_ARTIFACT_PREFIX_SKILL,
  MANAGED_ARTIFACT_PREFIX_TEMPLATE,
  MetricsAgentPresenceSuccessSchema,
  MetricsParseHealthSuccessSchema,
  MetricsReconciliationSuccessSchema,
  mediaKindForSidebarAssetExtension,
  normalizeAttachmentFolderPath,
  OK_DIR,
  OrphansSuccessSchema,
  PageHeadingsSuccessSchema,
  PagesSuccessSchema,
  PROJECT_SKILL_EDITOR_IDS,
  type Principal,
  PrincipalSuccessSchema,
  type ProblemType,
  parseTemplateFile,
  prependFrontmatter,
  projectSkillContentDocName,
  RenamePathRequestSchema,
  RenamePathSuccessSchema,
  type RescueEntryFlat,
  type RescueEntryTimeline,
  RescueListSuccessSchema,
  RollbackRequestSchema,
  RollbackSuccessSchema,
  readFmMap,
  SANDBOXED_HTML_CSP,
  SANDBOXED_HTML_EXTENSIONS,
  SaveVersionRequestSchema,
  SaveVersionSuccessSchema,
  SearchRequestSchema,
  type SearchSemanticStatus,
  type SearchSource,
  type SearchSuccess,
  SearchSuccessSchema,
  SeedApplyRequestSchema,
  SeedApplySuccessSchema,
  SeedListPacksSuccessSchema,
  SeedPlanSuccessSchema,
  SemanticIndexStatusSchema,
  ServerInfoSuccessSchema,
  ShareConstructUrlRequestSchema,
  ShareConstructUrlResponseSchema,
  SharePublishNameCheckResponseSchema,
  SharePublishOwnersResponseSchema,
  SharePublishRequestSchema,
  SharePublishResponseSchema,
  ShareTargetStatusRequestSchema,
  ShareTargetStatusResponseSchema,
  SKILL_NAME_REGEX,
  SkillDeleteSuccessSchema,
  SkillFileDeleteSuccessSchema,
  SkillFileGetSuccessSchema,
  SkillFilePutRequestSchema,
  SkillFilePutSuccessSchema,
  SkillGetSuccessSchema,
  SkillInstallRequestSchema,
  SkillInstallStateSuccessSchema,
  SkillInstallSuccessSchema,
  type SkillInstallWarningCode,
  SkillMoveRequestSchema,
  SkillMoveSuccessSchema,
  SkillPutRequestSchema,
  SkillPutSuccessSchema,
  SkillRestoreRequestSchema,
  SkillRestoreSuccessSchema,
  SkillScopeSchema,
  SkillsListSuccessSchema,
  SkillTargetsGetSuccessSchema,
  SkillTargetsPutRequestSchema,
  SkillTargetsPutSuccessSchema,
  SkillUninstallRequestSchema,
  SkillUninstallSuccessSchema,
  SkillUpdateRequestSchema,
  SkillUpdateSuccessSchema,
  SuggestLinksSuccessSchema,
  SYSTEM_DOC_NAME,
  SyncConflictContentSuccessSchema,
  SyncConflictsSuccessSchema,
  SyncResolveConflictRequestSchema,
  SyncResolveConflictSuccessSchema,
  SyncStatusSchema,
  SyncTriggerRequestSchema,
  SyncTriggerSuccessSchema,
  searchWorkspaceCorpus,
  skillLiveDocName,
  stripFrontmatter,
  TagsForNameSuccessSchema,
  TagsListSuccessSchema,
  TemplateDeleteSuccessSchema,
  TemplateGetSuccessSchema,
  TemplateMoveRequestSchema,
  TemplateMoveSuccessSchema,
  TemplatePutRequestSchema,
  TemplatePutSuccessSchema,
  TemplatesListSuccessSchema,
  TestFlushGitSuccessSchema,
  TestRescanBacklinksSuccessSchema,
  TestRescanFilesSuccessSchema,
  TestResetSuccessSchema,
  TrashCleanupRequestSchema,
  TrashCleanupSuccessSchema,
  UploadAssetSuccessSchema,
  UploadRequestSchema,
  unwrapFrontmatterFences,
  type WorkspaceSearchCorpus,
  type WorkspaceSearchDocument,
  type WorkspaceSearchIntent,
  type WorkspaceSearchRanking,
  type WorkspaceSearchResult,
  type WorkspaceSearchScope,
  type WorkspaceSemanticInput,
  WorkspaceSuccessSchema,
} from '@inkeep/open-knowledge-core';
import {
  formatRenameSubject,
  formatRollbackSubject,
  resolveGitDirDetailed,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import busboy from 'busboy';
import { fileTypeFromBuffer } from 'file-type';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { captureEffect } from './activity-log.ts';
import { listAgentActivity, synthesizeStackItemDiffText } from './agent-activity.ts';
import type { AgentFocusBroadcaster } from './agent-focus.ts';
import { type AgentPresenceBroadcaster, BROADCASTER_EVICTION_MS } from './agent-presence.ts';
import {
  AgentSessionCapacityError,
  type AgentSessionManager,
  type AgentWriteContentDivergence,
  applyAgentMarkdownWrite,
  applyAgentUndo,
  iconFromClientName,
} from './agent-sessions.ts';
import { type NormalizedSummary, normalizeSummary } from './agent-write-summary.ts';
import { isAllowedApiOrigin } from './api-origin.ts';
import { collectReferencedAssets, toContentRelativePath } from './asset-references.ts';
import { assetContentTypeForPath } from './asset-serve-middleware.ts';
import { getLocalDir } from './config/paths.ts';
import { CONFIG_VALIDATION_REVERT_ORIGIN } from './config-edit-origin.ts';
import { DocInConflictError, isDocInConflict, respondDocInConflict } from './conflict-errors.ts';
import { enrichDirectory } from './content/enrichment.ts';
import { applyFolderFrontmatterPatch } from './content/folder-frontmatter-write.ts';
import {
  applySkillBundleFileDelete,
  applySkillBundleFileWrite,
  applySkillDelete,
  applySkillMove,
  applySkillWrite,
  BUNDLE_FILE_MAX_BYTES,
  BUNDLE_MAX_FILES,
  composeSkillContent,
  countBundleFiles,
} from './content/skills-write.ts';
import { applySubstitution, todayIsoUtc } from './content/substitution.ts';
import {
  resolveProjectTemplates,
  resolveTemplatesAvailable,
} from './content/templates-resolver.ts';
import {
  applyTemplateDelete,
  applyTemplateMove,
  applyTemplateWrite,
  composeTemplateContent,
  type TemplateFrontmatter,
} from './content/templates-write.ts';
import {
  evaluateContentDivergence,
  toContentDivergenceWarning,
} from './content-divergence-gate.ts';
import { recordContributor } from './contributor-tracker.ts';
import { deriveDetection, embedProbeRing, recordEmbedProbe } from './embed-probe.ts';
import {
  recordSemanticQuery,
  type SemanticQueryOutcome,
} from './embeddings/embeddings-telemetry.ts';
import {
  clearEmbeddingsKeyFromAllBackends,
  EMBEDDINGS_API_KEY_ENV,
  FileEmbeddingsBackend,
  SEMANTIC_MIN_QUERY_LENGTH,
  type SemanticSearchService,
} from './embeddings/index.ts';
import {
  FrontmatterMalformedError,
  respondFrontmatterMalformed,
} from './frontmatter-malformed-error.ts';
import {
  createInstalledAgentsProbe,
  createOsProbe,
  handleInstalledAgents,
  type InstalledAgentScheme,
} from './handoff-api.ts';
import { handleHandoffDispatch } from './handoff-dispatch-api.ts';
import { findHubCandidates } from './hub-candidates.ts';
import {
  readInstalledSkills,
  recordSkillInstall,
  removeSkillInstall,
} from './installed-skills-marker.ts';
import { validateMermaidFences } from './mermaid-validator.ts';
import {
  extractPageIcon,
  extractPageTitle,
  type FrontmatterMetadata,
  parseFrontmatterMetadata,
} from './page-identity.ts';
import type { RecentlyRemovedDocs } from './recently-removed-docs.ts';
import { readServerLock } from './server-lock.ts';
import {
  buildGitHubBlobUrl,
  buildGitHubTreeUrl,
  emitShareConstructUrlLog,
  isValidSharePath,
  SHARE_BASE_URL,
  SHARE_CONSTRUCT_URL_HANDLER_TAG,
} from './share/construct-url.ts';
import { computeShareFreshness } from './share/freshness.ts';
import {
  branchExistsOnOrigin,
  originGitHubHost,
  readGitHeadBranch,
  readOriginGitHubRepo,
} from './share/git-context.ts';
import {
  emitSharePublishLog,
  isValidShareOwnerName,
  isValidShareRepoName,
  parseNameCheckEvent,
  parseOwnersEvent,
  parsePublishEvent,
  pickTerminalJsonLine,
  redactShareSubprocessStderr,
  SHARE_PUBLISH_HANDLER_TAG,
  SHARE_PUBLISH_KEY,
  SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG,
  SHARE_PUBLISH_NAME_CHECK_KEY,
  SHARE_PUBLISH_OWNERS_HANDLER_TAG,
  SHARE_PUBLISH_OWNERS_KEY,
  SHARE_PUBLISH_TIMEOUT_MS,
} from './share/publish.ts';
import {
  computeShareTargetStatus,
  SHARE_TARGET_STATUS_HANDLER_TAG,
} from './share/target-status.ts';
import { buildAndOpenSkill } from './skill-install.ts';
import { readSkillManagement, writeSkillManagement } from './skill-management.ts';
import {
  computePackUpdateStatus,
  isPackSkillName,
  readBundledPackSkill,
  readSkillVersion,
} from './skill-pack-version.ts';
import {
  projectSkill,
  readSkillBundledFiles,
  resolvedHosts,
  resolveSkillTargets,
  reverseProjectSkill,
  validateSkillForInstall,
} from './skill-projection.ts';
import { countImportableEditorSkills, reconcileSkillInstalls } from './skill-reconcile.ts';
import { reprojectAllManagedSkills } from './skill-reproject.ts';
import { readSkillInstallStateSnapshot } from './skill-state.ts';
import { readSkillTargets, writeSkillTargets } from './skill-targets-store.ts';
import { handleSpawnCursor } from './spawn-cursor-api.ts';
import { readUiLock } from './ui-lock.ts';
import {
  HashingPassThrough,
  linkTempToFinalWithCollisionRetry,
  mintTempUploadPath,
} from './upload-streaming.ts';

export { extractPageTitle } from './page-identity.ts';

import { context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
  ATTR_USER_AGENT_ORIGINAL,
} from '@opentelemetry/semantic-conventions';
import simpleGit from 'simple-git';
import { parseAgentBodyFields, resolveAgentType, validateAgentId } from './agent-id.ts';
import {
  applyRenameMap,
  BacklinkIndexRequiredError,
  buildRenameMap,
  ManagedRenameCollisionError,
  ManagedRenameDestinationExistsError,
  ManagedRenameInvalidRequestError,
  ManagedRenameMissingDocumentError,
  ManagedRenameReservedPathError,
  ManagedRenameSnapshotMissingError,
  ManagedRenameSourceNotFoundError,
  ManagedRenameSourceTypeMismatchError,
  SymlinkEscapeError,
} from './apply-managed-rename.ts';
import {
  type BacklinkIndex,
  computeBrokenOutboundLinks,
  type GraphNode as IndexedGraphNode,
  isOrphanMode,
} from './backlink-index.ts';
import { getBootTimings } from './boot-timings.ts';
import { composeAndWriteRawBody, replaceRawBody } from './bridge-intake.ts';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
import type { ResolveStrategy } from './conflict-storage.ts';
import type { ContentFilter } from './content-filter.ts';
import {
  docNameToRelativePath,
  forgetDocExtension,
  getDocExtension,
  isSupportedAssetFile,
  isSupportedDocFile,
  registerDocExtension,
  SUPPORTED_DOC_EXTENSIONS,
  stripDocExtension,
} from './doc-extensions.ts';
import {
  type ReconcileBeforeWriteResult,
  reconcileDiskBeforeAgentWrite,
} from './external-change.ts';
import { extractActorIdentity } from './extract-actor-identity.ts';
import {
  contentHash,
  type DiskEvent,
  type FileIndexEntry,
  type FolderIndexEntry,
  registerWrite,
  removeFolderIndexEntries as removeFolderIndexEntriesFromIndex,
  updateFileIndex,
  upsertFolderIndexEntry as upsertFolderIndexEntryInIndex,
} from './file-watcher.ts';
import { recordFrontmatterEditSurface } from './frontmatter-telemetry.ts';
import { isProjectRoot } from './fs/find-project-root.ts';
import {
  classifyFsPath,
  normalizeFsPath,
  tracedCpSync,
  tracedMkdirSync,
  tracedRenameSync,
  tracedRmdirSync,
  tracedRmSync,
  tracedUnlinkSync,
  tracedWriteFileSync,
} from './fs-traced.ts';
import {
  BRANCH_INFO_HANDLER_TAG,
  computeBranchInfo,
  isValidBranchInfoPath,
  isValidBranchName,
} from './git-branch-info.ts';
import { CHECKOUT_HANDLER_TAG, runCheckoutFlow } from './git-checkout.ts';
import { withParentLock } from './git-handle.ts';
import { writeGitIdentity } from './git-identity.ts';
import {
  createStreamingErrorWriter,
  errorResponse,
  type HttpErrorStatus,
} from './http/error-response.ts';
import { validateBody, withValidation } from './http/request-validation.ts';
import { successResponse } from './http/success-response.ts';
import { initContent } from './init-project.ts';
import {
  checkLocalOpSecurity,
  createConcurrencyGuard,
  expandTilde,
  isAllowedGitUrl,
  isSafeLocalPath,
} from './local-op-security.ts';
import {
  type AuthEvent,
  classifyCloneError,
  runCloneSubprocess,
  runDeviceFlowSubprocess,
} from './local-ops/index.ts';
import { getLogger } from './logger.ts';
import { isAllowedWorkspaceHostHeader, isLoopbackAddress } from './loopback.ts';
import {
  managedArtifactAbsPath,
  managedArtifactTimelinePaths,
} from './managed-artifact-persistence.ts';
import {
  createManagedRenameRecoveryJournal,
  type ManagedRenameSnapshot,
  withManagedRenameRecovery,
} from './managed-rename-journal.ts';
import { rewriteAssetReferencesForRename } from './managed-rename-rewrite.ts';
import {
  getMetrics,
  incrementAgentPatchFindMismatches,
  incrementAgentWriteCalls,
  incrementSummariesProvided,
  incrementSummariesTruncated,
} from './metrics.ts';
import { isWithinDir, toPosix } from './path-utils.ts';
import {
  deleteReconciledBase,
  getActiveBranch,
  isWithinContentDir,
  type StoreFailure,
  safeContentPath,
  setReconciledBase,
} from './persistence.ts';
import {
  appendRenameLogEntry,
  createAncestorShaSetCache,
  gcRenameLog,
  getOrLoadRenameLogIndex,
  type RenameLogEntry,
  resolveDocPathAtCommit,
} from './rename-log.ts';
import {
  applySeed,
  coercePackId,
  listStarterPacks,
  planSeed,
  type ScaffoldPlan,
  SeedPrerequisiteError,
  SeedRootDirError,
} from './seed/index.ts';
import type { PairedWriteOrigin } from './server-observers.ts';
import {
  enumerateWipChains,
  listRescueCheckpoints,
  SERVICE_WRITER,
  type ShadowRef,
  safetyCheckpoint,
  saveVersion,
  shadowGit,
  type TimelineRescueEntry,
  type WriterIdentity,
} from './shadow-repo.ts';
import { createSingleFlight } from './single-flight.ts';
import { restoreSkillVersion } from './skill-restore.ts';
import { SuggestLinksTargetNotFoundError, suggestLinks } from './suggest-links.ts';
import type { SyncEngine } from './sync-engine.ts';
import type { TagIndex } from './tag-index.ts';
import { getMeter, getTracer, withSpan, withSpanSync } from './telemetry.ts';
import { getDocumentHistory, getFolderTimeline } from './timeline-query.ts';
import { recordTimelineCoalesced } from './timeline-telemetry.ts';

// Cache the HTTP duration histogram at module scope — lazy-init at first use
// so the meter is a real meter (post-`initTelemetry`), not the pre-init no-op.
// Recreating the histogram every request allocates + registers a fresh
// instrument on every hit.
let _httpDurationHist: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
function httpDurationHist(): ReturnType<ReturnType<typeof getMeter>['createHistogram']> {
  _httpDurationHist ||= getMeter().createHistogram('http.server.request.duration', {
    description: 'HTTP server request duration in seconds',
    unit: 's',
  });
  return _httpDurationHist;
}

// Lazy-init so the counter registers against a real meter post-initTelemetry
// (not the pre-init no-op). Matches the httpDurationHist pattern.
let _hintEmittedCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
function hintEmittedCounter(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
  _hintEmittedCounter ||= getMeter().createCounter('ok.preview_attach.hint_emitted', {
    description:
      'Count of preview-attach hints emitted on write-tool responses when no editor is attached to __system__. Covers both attach-preview-once (URL exists, no browser) and start-ui (no UI running anywhere) variants — the tool side disambiguates via the warning action; the metric name is retained as-is so existing dashboards keep working.',
  });
  return _hintEmittedCounter;
}

// Counter for `agent-patch` FM-intersecting calls. Bounded label set:
// `result ∈ {'rejected','pre_deprecation_passthrough'}`. Today the handler
// always rejects with 400 — the second label is reserved for a possible
// passthrough mode during the deprecation window.
let _agentPatchFmTouchCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null =
  null;
function agentPatchFmTouchCounter(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
  _agentPatchFmTouchCounter ||= getMeter().createCounter(
    'ok.frontmatter.agent_patch_fm_touch_total',
    {
      description:
        'Count of agent-patch calls whose find string targets the frontmatter region. Measures incidence during the soft-deprecation window before agent-patch FM-intersecting calls are enforced as 400. Bounded label: result ∈ {rejected, pre_deprecation_passthrough}.',
    },
  );
  return _agentPatchFmTouchCounter;
}

/**
 * Heuristic FM-intersection check for `agent-patch` find strings. Pure
 * function on the find string — runs before any doc state is read.
 *
 * Rejection signal:
 *   - find contains `---` (FM/body separator — opening or closing fence)
 *   - find matches `/^\s*[\w-]+:/` (yaml-style key-value at start)
 *
 * Catches the common case: agents that copy a YAML line verbatim into
 * `find` to splice an FM property. The position-based check inside the
 * transact block catches the rarer case where a non-yaml-shape find
 * happens to land in the FM region (e.g., `find: 'draft'` matching
 * `status: draft`). Together they cover both "find looks like FM" and
 * "find lands in FM."
 */
function findLooksLikeFrontmatter(find: string): boolean {
  // Line-anchored `---` (YAML document fence). Mid-string `---` (e.g. body
  // text containing em-dash sequences or markdown thematic breaks embedded
  // in larger find strings) flows to the position-based check below.
  if (/(^|\n)---(\s|\n|$)/.test(find)) return true;
  // YAML key-value shape — require an actual value (`\s+\S` after the
  // colon) so prose like `Note:` / `IMPORTANT:` / `Warning:` (no value)
  // is left to the position-based check, which rejects only when the find
  // actually lands inside the FM region. Empty-value YAML keys like
  // `draft:` similarly fall through to position-based rejection.
  if (/^\s*[\w-]+:\s+\S/.test(find)) return true;
  return false;
}

let _renameAttributionCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null =
  null;
function renameAttributionCounter(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
  _renameAttributionCounter ||= getMeter().createCounter('ok.rename.attribution_kind', {
    description:
      'Count of rename and rollback handler dispatches by attribution kind (agent | principal | anonymous)',
  });
  return _renameAttributionCounter;
}

// Content-divergence gate counters (Site A). `gate_fired_total` is the
// denominator (every gated agent write); `content_divergence_total` the
// numerator (writes whose converged Y.Text diverged from intent). The ratio is
// the production divergence rate. Bounded label set:
// handler ∈ {agent-write-md, agent-patch, rollback} + bounded divergence_type.
let _agentWriteGateFiredCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null =
  null;
function agentWriteGateFiredCounter(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
  _agentWriteGateFiredCounter ||= getMeter().createCounter('ok.agent_write.gate_fired_total', {
    description:
      'Count of agent writes that ran the Site A content-divergence gate (denominator for the divergence rate). Bounded label: handler ∈ {agent-write-md, agent-patch, rollback}.',
  });
  return _agentWriteGateFiredCounter;
}

let _agentWriteContentDivergenceCounter: ReturnType<
  ReturnType<typeof getMeter>['createCounter']
> | null = null;
function agentWriteContentDivergenceCounter(): ReturnType<
  ReturnType<typeof getMeter>['createCounter']
> {
  _agentWriteContentDivergenceCounter ||= getMeter().createCounter(
    'ok.agent_write.content_divergence_total',
    {
      description:
        'Count of agent writes whose converged Y.Text diverged from the composed intent (numerator for the divergence rate). Bounded labels: handler ∈ {agent-write-md, agent-patch, rollback}, divergence_type.',
    },
  );
  return _agentWriteContentDivergenceCounter;
}

// Counter for the name-only `kind:'file'` corpus tier hitting the
// `OK_SEARCH_MAX_ENTRIES` cap. Increments once per corpus rebuild that drops
// deepest-tail paths; the matching warn log carries the (dropped, retained,
// limit) breakdown. Lets an operator distinguish "cap fired" from "results
// quietly missing" without scraping logs.
let _searchCorpusTruncatedCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null =
  null;
function searchCorpusTruncatedCounter(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
  _searchCorpusTruncatedCounter ||= getMeter().createCounter('ok.search.corpus_truncated_total', {
    description:
      'Count of search-corpus rebuilds where the name-only file tier hit OK_SEARCH_MAX_ENTRIES and dropped deepest-tail paths. One increment per truncated build; non-truncated builds do not increment.',
  });
  return _searchCorpusTruncatedCounter;
}

/** Bounded handler label for the content-divergence counters. */
type DivergenceHandler = 'agent-write-md' | 'agent-patch' | 'rollback';

/**
 * Record a gated agent write: always bump the denominator; bump the numerator
 * (with the divergence type) when the gate fired. The single increment site
 * for all three handlers.
 */
function recordContentDivergenceGate(
  handler: DivergenceHandler,
  divergence: AgentWriteContentDivergence | undefined,
): void {
  agentWriteGateFiredCounter().add(1, { handler });
  if (divergence !== undefined) {
    agentWriteContentDivergenceCounter().add(1, {
      handler,
      divergence_type: divergence.divergenceType,
    });
  }
}

/**
 * Test-only: clear the lazy-initialized rename counter so a test that
 * registers a fresh meter provider via `metrics.setGlobalMeterProvider`
 * can capture subsequent counter increments. Production code never calls this.
 */
export function __resetRenameTelemetryForTesting(): void {
  _renameAttributionCounter = null;
}

/**
 * On an auth-login `complete` event, resume a SyncEngine that parked in
 * `auth-error` so a reconnect restores sync without an app restart. The
 * credential helper reads the freshly stored token on the next git invocation,
 * but the engine won't retry on its own. Extracted so the wiring (the only
 * behavior that matters here) is unit-testable without a real device flow.
 *
 * Best-effort: a rejected promise is swallowed because sync status catches up on
 * the next cycle or restart. Non-`complete` events are ignored.
 */
export function resumeSyncOnAuthEvent(
  event: AuthEvent,
  getSyncEngine?: () => SyncEngine | null,
): void {
  if (event.type !== 'complete') return;
  void getSyncEngine?.()
    ?.notifyCredentialsChanged()
    .catch(() => {
      /* best-effort — sync status catches up next cycle / restart */
    });
}

/**
 * Transaction origin for rollback (typed `PairedWriteOrigin`).
 *
 * `skipStoreHooks: false` — L1 persistence SHOULD fire after rollback so the
 * restored content reaches disk through the normal pipeline. The
 * file-watcher's registerWrite hash check prevents the self-write from
 * re-triggering reconciliation.
 *
 * `paired: true` — rollback atomically writes both XmlFragment and Y.Text
 * inside one `doc.transact()` block. `satisfies PairedWriteOrigin` gates the
 * marker at authoring time.
 */
export const ROLLBACK_ORIGIN = {
  source: 'local' as const,
  skipStoreHooks: false,
  context: { origin: 'rollback-apply', paired: true },
} as const satisfies PairedWriteOrigin;

/**
 * Managed-rename origin — typed `PairedWriteOrigin`.
 *
 * Exported so the bridge-invariant watcher can enforce by identity (precedent #1)
 * and so server observers can resolve `context.paired` without importing the
 * object transitively.
 *
 * `paired: true` — the caller atomically writes BOTH XmlFragment (via
 * `updateYFragment`) and Y.Text (via `applyFastDiff`) inside one transact
 * block. `satisfies PairedWriteOrigin` is the compile-time gate.
 */
export const MANAGED_RENAME_ORIGIN = {
  source: 'local' as const,
  skipStoreHooks: false,
  context: { origin: 'managed-rename', paired: true },
} as const satisfies PairedWriteOrigin;

const log = getLogger('api');

/**
 * Detects git merge-conflict marker triples at start-of-line. Requires
 * ALL THREE sentinels (`<<<<<<< `, `=======`, `>>>>>>> `) to co-occur —
 * git always writes the trio together, so single-sentinel matching would
 * false-positive on legitimate user content (e.g., a CommonMark setext H1
 * underline of exactly 7 `=` characters: `My Title\n=======`).
 *
 * Used by the `?source=ytext` branch of the conflict-content handler to
 * decide whether the live Y.Text snapshot is usable as `ours` (no marker
 * triple → safe to surface live edits) or polluted by the file watcher's
 * reopen-time disk seed (triple present → fall back to git-index `ours`).
 */
function ytextHasConflictMarkers(text: string): boolean {
  return /^<{7} /m.test(text) && /^={7}$/m.test(text) && /^>{7} /m.test(text);
}

/** Validates a docName and builds a shadow-repo-safe path.
 * Uses the same traversal check as safeContentPath (reject `..` and null bytes)
 * but allows `/` for nested content directories (e.g. `test-content/test-doc`). */
function safeDocPath(docName: string, contentRoot: string): { path: string } | { error: string } {
  if (!docName || docName.includes('..') || docName.includes('\0')) {
    return { error: 'Invalid document name.' };
  }
  // Normalize: strip leading './' AND treat bare '.' as empty (git rejects
  // both "./foo" and "./" pathspecs when operating against a bare repo).
  const normalized = contentRoot === '.' ? '' : contentRoot.replace(/^\.\//, '');
  // Managed-artifact docs (skills/templates) are committed under their `.ok/...`
  // key, not at `<docName>.md` — translate so version/diff/rollback git ops
  // target the real file. Unversioned (global) skills + ordinary docs fall
  // through to the default path: a global skill resolves to a path with no
  // commits, yielding an empty timeline / 404 version rather than a new error.
  const managed = managedArtifactTimelinePaths(docName);
  if (managed.managed && managed.versioned) {
    return { path: normalized ? `${normalized}/${managed.filePath}` : managed.filePath };
  }
  const ext = getDocExtension(docName);
  const path = normalized ? `${normalized}/${docName}${ext}` : `${docName}${ext}`;
  return { path };
}

const GENERIC_PASTE_NAMES = /^(image\.(png|jpe?g|gif|webp)|Clipboard.*|Untitled.*)$/i;

// unicode-preserving. Permits any Unicode letter, number, or combining
// mark, plus pictographic emoji and the punctuation whitelist (., -, _, space).
// Everything else (including `/`, `\`, null bytes, control chars, CRLF) is
// either stripped or replaced so path-escape guards downstream keep their
// invariants. CJK, Arabic, Cyrillic, and emoji survive — macOS/Finder
// ergonomics without sacrificing filesystem safety.
const SAFE_FILENAME_CHARS = /[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}.\-_ ]/gu;
// Stripping C0 + DEL is the whole point — the rule fires on intentional use.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — sanitize must strip control bytes.
const STRIP_ON_SIGHT = /[/\\\x00-\x1f\x7f]/g;

export function sanitizeFilename(name: string): string {
  // Strip path separators and null/control bytes BEFORE any other pass so
  // they cannot reappear inside a replacement and dodge later checks.
  let stripped = name.replace(STRIP_ON_SIGHT, '');
  stripped = stripped.replace(SAFE_FILENAME_CHARS, '_');

  // Collapse underscore and dot runs so "../etc/passwd" → "etcpasswd" and
  // "foo__bar" → "foo_bar".
  stripped = stripped.replace(/_+/g, '_').replace(/\.{2,}/g, '.');

  // No hidden files — trim leading dots and leading underscores.
  stripped = stripped.replace(/^[._]+/, '');
  // Filesystem portability — strip trailing dots (Windows trims them too).
  stripped = stripped.replace(/\.+$/, '');

  if (stripped === '') return 'upload';

  // Most filesystems cap basenames at 255 bytes (ext4, APFS, exFAT). Without a
  // ceiling, a multipart `Content-Disposition` filename approaching busboy's
  // header size can sail through Unicode-letter sanitization and surface as
  // `ENAMETOOLONG` from `linkSync`, which classifies as a generic
  // `storage-error` → 500. Truncate the stem (preserving the extension) to
  // stay within the portable basename ceiling.
  const MAX_BYTES = 255;
  const encoder = new TextEncoder();
  if (encoder.encode(stripped).length > MAX_BYTES) {
    const dotIdx = stripped.lastIndexOf('.');
    const ext = dotIdx >= 0 ? stripped.slice(dotIdx) : '';
    let stem = dotIdx >= 0 ? stripped.slice(0, dotIdx) : stripped;
    // `slice(0, -1)` removes one UTF-16 code unit. A trailing emoji is a
    // surrogate pair, so the loop transiently produces a lone-surrogate
    // string that `TextEncoder` re-encodes as U+FFFD (3 bytes) — harmless
    // since the emoji is fully consumed before the loop exits and the
    // returned string is always valid UTF-8.
    while (encoder.encode(stem + ext).length > MAX_BYTES && stem.length > 0) {
      stem = stem.slice(0, -1);
    }
    stripped = (stem || 'upload') + ext;
    // The loop drains the stem; it cannot shrink the extension itself.
    // An adversarial 250+ byte extension (e.g. `'x.' + 'a'.repeat(300)`)
    // would drain the stem to empty and still leave `'upload' + ext`
    // above the ceiling. Final-pass guard: fall back to extensionless
    // `'upload'` when even the floor exceeds MAX_BYTES.
    if (encoder.encode(stripped).length > MAX_BYTES) stripped = 'upload';
  }

  return stripped;
}

/**
 * Resolve the destination directory for an upload from the parent doc's
 * path and the configured `content.attachmentFolderPath`. Matches Obsidian's
 * literal schema (free-form string):
 *
 *   - `"./"` (default)  → same directory as the doc
 *   - `"/"`             → content-directory root
 *   - `"./<sub>"`       → subdirectory beside the doc
 *   - `"<name>"` (bare) → fixed content-relative path
 *
 * Treats any `./` prefix as "relative to doc dir," any other value as
 * "relative to content dir." Empty or whitespace-only strings fall back
 * to the default (doc dir).
 *
 * Returns an absolute path within `resolvedContentDir` — path-escape
 * enforcement happens at the caller via `isWithinContentDir` + `realpath`.
 */
export function resolveUploadDestDir(
  parentDocName: string,
  attachmentFolderPath: string,
  resolvedContentDir: string,
): string {
  const trimmed = attachmentFolderPath.trim();
  if (trimmed === '' || trimmed === './') {
    return resolve(resolvedContentDir, dirname(parentDocName));
  }
  if (trimmed === '/') {
    return resolvedContentDir;
  }
  if (trimmed.startsWith('./')) {
    // Subdirectory beside the doc. `"./attachments"` → `<docDir>/attachments`.
    return resolve(resolvedContentDir, dirname(parentDocName), trimmed.slice(2));
  }
  // Bare name or nested path: fixed content-relative location.
  return resolve(resolvedContentDir, trimmed);
}

/**
 * Read at most `n` bytes from the start of `path`. Feeds both the magic-byte
 * sniff (`fileTypeFromBuffer` over the head) and the SVG text fallback
 * (`file-type` can't detect text-based SVG), without ever materializing the
 * whole file.
 */
function readTempFileHead(path: string, n: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan `destDir` non-recursively for an existing file whose sha256 matches
 * the buffer's. Returns the matching basename (case-preserving) or null if
 * no match. Bounded by directory size — O(n) in sibling count, not vault size.
 * Only files with extensions in ASSET_EXTENSIONS are candidates; everything
 * else (markdown, .git/, etc.) is skipped.
 *
 * `expectedSize` is the buffer's byte length — passed in so we can size-
 * prefilter before hashing siblings. sha256 collision requires equal-sized
 * inputs, so same-extension siblings with a different size are not
 * candidates and we skip their (potentially multi-MB) read. This turns
 * the common "paste a new screenshot" path from O(total asset bytes in
 * dir) back to O(sibling count × stat). Non-ENOENT read failures log at
 * WARN so silent dedup degradation has a signal.
 */
/**
 * Upper bound on size-matched candidates we'll read+hash in a single
 * dedup call. A capture-device folder with 1000+ screenshots at the same
 * resolution could theoretically produce that many same-size siblings;
 * each candidate costs a sync readFileSync + sha256Hex of the entire
 * buffer, which would block the event loop for seconds per upload under
 * adversarial / pathological load.
 *
 * Past the bound, dedup degrades to best-effort: we log a structured
 * WARN and return null (treat as no-match → write a new file with the
 * collision-suffix loop). This is a bounded-resource defense, not a
 * correctness change — a duplicate that slips through produces the
 * cheap storage cost of one extra on-disk copy, not silent data loss.
 * The O(1) hash-cache alternative is a
 * larger architectural change and a follow-on.
 */
const MAX_DEDUP_SCAN_CANDIDATES = 1000;

/**
 * Stream a file's bytes through a sha256 Hash transform and return the hex
 * digest. Keeps memory O(1) regardless of file size — a 500 MB candidate
 * read by the buffer-based `readFileSync` path would otherwise materialize
 * the whole file in heap, which defeats the streaming-upload amendment's
 * O(1) memory guarantee.
 *
 * Throws on read errors so the caller can classify ENOENT (concurrent
 * rename — stay silent) vs other errors (log and skip).
 */
async function streamingHashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function findDuplicateAsset(
  destDir: string,
  sha: string,
  expectedSize: number,
): Promise<string | null> {
  let entries: string[];
  try {
    // Async `readdir` so the directory walk doesn't block the event
    // loop during uploads — bun's loop is shared with WebSocket sync
    // and CRDT updates, and a 1k-entry walk is observable on bursty
    // upload traffic. The MAX_DEDUP_SCAN_CANDIDATES cap
    // bounds the worst case at 1000 same-size siblings, but the
    // pre-cap entry list can still be much larger.
    entries = await readdir(destDir);
  } catch {
    return null;
  }
  const log = getLogger('upload');
  let scanned = 0;
  for (const entry of entries) {
    const ext = extname(entry).slice(1).toLowerCase();
    if (!ASSET_EXTENSIONS.has(ext)) continue;
    const fullPath = resolve(destDir, entry);
    let entryStat: Awaited<ReturnType<typeof stat>>;
    try {
      entryStat = await stat(fullPath);
    } catch {
      continue;
    }
    if (!entryStat.isFile() || entryStat.size !== expectedSize) continue;
    // Bounded scan: only count candidates that passed the cheap size
    // prefilter, since same-size siblings are the ones that cost a
    // full-file hash each (streaming now, not buffered).
    scanned++;
    if (scanned > MAX_DEDUP_SCAN_CANDIDATES) {
      log.warn(
        {
          event: 'upload-dedup-skip',
          reason: 'scan-cap-exceeded',
          destDir,
          scanned: MAX_DEDUP_SCAN_CANDIDATES,
          expectedSize,
        },
        `[upload-dedup] candidate scan exceeded ${MAX_DEDUP_SCAN_CANDIDATES} same-size siblings — degrading to no-dedup for this upload`,
      );
      return null;
    }
    let candidateSha: string;
    try {
      // Stream + hash the candidate to preserve the O(1) memory guarantee
      // the upload pipeline otherwise maintains end-to-end. A 500 MB
      // candidate otherwise spiked heap to 500 MB per scan.
      candidateSha = await streamingHashFile(fullPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT is the legitimate concurrent-rename race — stay silent.
      if (code !== 'ENOENT') {
        log.warn(
          { event: 'upload-dedup-skip', reason: 'read-failed', code, entry },
          '[upload-dedup] skipped candidate — read failed',
        );
      }
      continue;
    }
    if (candidateSha === sha) return entry;
  }
  return null;
}

/**
 * Discriminator for write failures so the upload handler can surface a
 * specific error code (`collision-exhaustion` / `storage-full` /
 * `storage-readonly` / `storage-error`) instead of collapsing every
 * filesystem failure into a generic 500 "Failed to save file" response.
 * The code field is a stable part of the error envelope; the numeric
 * HTTP status differentiates transient-yet-retry (500) from full-disk
 * (507) per RFC 4918.
 */
import {
  classifyUploadErrno,
  UploadWriteError,
  type UploadWriteReason,
  uploadStatusFor,
  uploadTitleFor,
} from './upload-errors.ts';

interface UploadResult {
  filename: string;
  mimeType: string;
  parentDocName: string;
  placement: string;
  tempPath: string;
  sha: string;
  byteLength: number;
}

/**
 * Stream multipart upload body to a tempfile while hashing on-the-fly.
 *
 * Replaces the buffer-to-memory pattern (chunks.push(chunk) +
 * Buffer.concat) with busboy's streaming 'file' event piped through a
 * HashingPassThrough Transform into createWriteStream(tempPath). Memory
 * becomes O(1); disk is the only bound.
 *
 * Error contract (typed via UploadWriteError.reason — URN-form ProblemType):
 *   - urn:ok:error:malformed-upload: busboy 'error' (unparseable multipart, etc.)
 *   - urn:ok:error:storage-full: ENOSPC / EDQUOT during the write stream
 *   - urn:ok:error:storage-readonly: EROFS / EACCES / EPERM during the write stream
 *   - urn:ok:error:storage-error: any other write-stream error
 *
 * On any error, the tempfile is best-effort unlinked before propagating.
 */
function readUploadBody(req: IncomingMessage, projectDir: string): Promise<UploadResult> {
  return new Promise((resolveP, reject) => {
    let bb: ReturnType<typeof busboy>;
    try {
      // `files: 1` caps the file part; `fields` + `fieldSize` cap non-file
      // surface so a flooded multipart can't buffer thousands of fields or a
      // multi-MB string field in memory before the upload body resolves. The
      // legitimate schema (agentId / docName / position / summary) is bounded
      // — short identifiers, never approaching 2 KB or 10 entries. The
      // ENAMETOOLONG-via-crafted-filename DoS path is closed by the 255-byte
      // ceiling in `sanitizeFilename` (the filesystem-portability layer);
      // busboy does not expose a header-section-size limit (only headerPairs
      // count), so the parsed-value cap is the right place.
      bb = busboy({
        headers: req.headers,
        limits: { files: 1, fields: 10, fieldSize: 2 * 1024 },
      });
    } catch (err) {
      reject(new UploadWriteError('urn:ok:error:malformed-upload', err));
      return;
    }

    let settled = false;
    let filename = 'upload';
    let mimeType = '';
    let parentDocName = '';
    let placement = '';
    let tempPath: string | undefined;
    let pipelineError: unknown;
    // Track whether the 'file' event ever fired. busboy emits 'close' as
    // soon as it finishes parsing the request body — but the file
    // pipeline (createWriteStream + HashingPassThrough) is async and may
    // still be running when 'close' fires. We must NOT resolve to an
    // empty UploadResult on 'close' when a file IS being processed; the
    // pipeline `.then()` is the legitimate resolver in that case. Only
    // the no-file path needs the 'close' fallback.
    let fileEventFired = false;

    // Mint the tempfile path lazily on the first 'file' event — busboy
    // can fire 'error' before any file arrives (e.g. missing boundary)
    // and we'd otherwise create a zero-byte tempfile for no reason.

    const fail = (reason: UploadWriteReason, cause: unknown) => {
      if (settled) return;
      settled = true;
      if (tempPath) {
        try {
          unlinkSync(tempPath);
        } catch {
          // best-effort; orphan sweep catches stragglers
        }
      }
      reject(cause instanceof UploadWriteError ? cause : new UploadWriteError(reason, cause));
    };

    const classifyWriteError = classifyUploadErrno;

    bb.on('field', (name, val) => {
      if (name === 'parentDocName') parentDocName = val;
      if (name === 'placement') placement = val;
    });

    bb.on('file', (_fieldname, file, info) => {
      fileEventFired = true;
      filename = info.filename || 'upload';
      mimeType = info.mimeType || '';

      // `mintTempUploadPath` does `tracedMkdirSync(.., { recursive: true })`
      // which can throw ENOSPC / EDQUOT / EROFS / EACCES / EPERM / EIO. An
      // uncaught throw here bubbles back through busboy's `_write` and
      // re-emits as `'error'`, which the listener below classifies as
      // `'urn:ok:error:malformed-upload'` (HTTP 400). That misleads operators triaging
      // a full disk into chasing a phantom client bug. Catch the sync
      // throw, classify via the same table the pipeline rejection uses,
      // and drain the file part so busboy can finish parsing the rest.
      let path: string;
      try {
        path = mintTempUploadPath(projectDir);
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        fail(classifyWriteError(nodeErr), err as Error);
        file.resume();
        return;
      }
      tempPath = path;
      const hasher = new HashingPassThrough();
      const writeStream = createWriteStream(path);

      pipeline(file, hasher, writeStream)
        .then(() => {
          if (settled) return;
          settled = true;
          resolveP({
            filename,
            mimeType,
            parentDocName,
            placement,
            tempPath: path,
            sha: hasher.digest(),
            byteLength: hasher.byteLength(),
          });
        })
        .catch((err) => {
          pipelineError = err;
          // Classify from the deepest write error if available; otherwise
          // treat as a generic storage-error. The unlink happens inside fail().
          const nodeErr = err as NodeJS.ErrnoException;
          fail(classifyWriteError(nodeErr), err);
        });
    });

    bb.on('error', (err) => {
      fail('urn:ok:error:malformed-upload', err);
    });

    // busboy's `close` (Writable, emitClose:true via @types/busboy@1.6.0)
    // fires once busboy finishes parsing the request body. If by then
    // no `file` event ever fired, the request was a well-formed
    // multipart with fields-only (no file part) — resolve with a
    // synthetic empty UploadResult so the route handler's
    // `byteLength === 0` guard returns the standard 400 "No file
    // received." Without this hook the Promise never settles on fields-
    // only uploads and the connection hangs until Node's request
    // timeout fires (DoS).
    //
    // CRUCIAL: gate on `!fileEventFired`. If a file part IS present,
    // busboy emits 'close' as soon as it finishes parsing — but the
    // async write/hash pipeline below may still be running. Resolving
    // here would race the pipeline's legitimate resolveP and produce a
    // spurious empty result. Pipeline resolves win in that case.
    bb.on('close', () => {
      if (settled || pipelineError) return;
      if (fileEventFired) return;
      settled = true;
      resolveP({
        filename: '',
        mimeType: '',
        parentDocName,
        placement,
        tempPath: '',
        sha: '',
        byteLength: 0,
      });
    });

    // Guard the "client disconnected mid-stream" path. busboy never
    // reaches `_final` if the request aborts before the closing boundary,
    // so its `close` would not fire and the Promise would otherwise hang.
    req.on('close', () => {
      if (settled || pipelineError) return;
      if (!req.complete) {
        fail('urn:ok:error:malformed-upload', new Error('client disconnected'));
      }
    });

    req.pipe(bb);
  });
}

/**
 * Resolve a subdirectory path within a base directory, rejecting traversal attempts.
 * Throws if the resolved path escapes the base directory.
 */
export function safeSubdir(baseDir: string, subdir: string): string {
  const resolved = resolve(baseDir, subdir);
  if (!isWithinDir(resolved, baseDir)) {
    throw new Error(`Invalid directory: ${subdir}`);
  }
  return resolved;
}

/**
 * Synthesize an `assetExt` string for files surfaced by Show All Files mode
 * that fall outside the markdown / standard-asset extension set. Schema
 * requires `assetExt: z.string().min(1)`. Mapping:
 *   - `foo.ts` → `'ts'` (extname → strip leading dot)
 *   - `.gitignore` → `'gitignore'` (dotfile with no extname → use name minus dot)
 *   - `LICENSE` → `'file'` (extensionless non-dotfile → 'file' fallback sentinel)
 */
function synthesizeShowAllAssetExt(name: string): string {
  const ext = extname(name);
  if (ext) return ext.slice(1).toLowerCase();
  if (name.startsWith('.') && name.length > 1) return name.slice(1).toLowerCase();
  return 'file';
}

/**
 * Per-request ceiling on the entries `walkContentDirForShowAll` accumulates.
 * Read from `OK_SHOWALL_MAX_ENTRIES` on every call — never cached at module
 * load — so ops can retune the floor without a restart and tests can drive a
 * low cap. Non-positive / non-integer input falls back to the default. A
 * content dir pointed at a large repo can hold far more entries than the
 * sidebar can render, and the walk accumulates one object per entry, so the
 * cap is the cheap heap floor.
 */
export const DEFAULT_SHOWALL_MAX_ENTRIES = 50_000;
export function getShowAllMaxEntries(): number {
  const raw = process.env.OK_SHOWALL_MAX_ENTRIES;
  if (raw === undefined) return DEFAULT_SHOWALL_MAX_ENTRIES;
  // `Number()` (not `parseInt`) so scientific notation like `1e5` lifts cleanly
  // to 100000 instead of silently truncating to 1 at the first non-digit. The
  // `isInteger` guard still rejects `1e-5`, `0.5`, `Infinity`, and `NaN`.
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SHOWALL_MAX_ENTRIES;
}

/**
 * Per-build ceiling on the name-only `kind:'file'` tier of the search corpus.
 * Read from `OK_SEARCH_MAX_ENTRIES` on every build (never cached at module load)
 * so ops can retune without a restart and tests can drive a low cap. Non-positive
 * / non-integer input falls back to the default. Markdown content docs are NEVER
 * subject to this cap — only the all-files name tier, which is the part that grows
 * with a pathological repo. The corpus is materialized twice (server + client),
 * so this is the heap floor for the file tier. Mirrors `getShowAllMaxEntries`.
 */
export const DEFAULT_SEARCH_MAX_ENTRIES = 50_000;
export function getSearchMaxEntries(): number {
  const raw = process.env.OK_SEARCH_MAX_ENTRIES;
  if (raw === undefined) return DEFAULT_SEARCH_MAX_ENTRIES;
  // `Number()` (not `parseInt`) so scientific notation like `1e5` lifts cleanly
  // to 100000 instead of silently truncating to 1 at the first non-digit. The
  // `isInteger` guard still rejects `1e-5`, `0.5`, `Infinity`, and `NaN`.
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SEARCH_MAX_ENTRIES;
}

/**
 * Test-only observability for the Show All Files walk. `invocations` counts how
 * many times `walkContentDirForShowAll` ran — the document-list single-flight
 * dedupe collapses concurrent identical requests to one invocation, so this is
 * how a test proves N requests triggered exactly one walk. `aborts` counts
 * walks that bailed because their `signal` fired (abort-on-disconnect). Counters
 * are module-scoped because the walk function is; reset between tests with the
 * companion helper. Mirrors the `__resetRenameTelemetryForTesting` seam above.
 */
let showAllWalkInvocations = 0;
let showAllWalkAborts = 0;
export function __getShowAllWalkStatsForTesting(): { invocations: number; aborts: number } {
  return { invocations: showAllWalkInvocations, aborts: showAllWalkAborts };
}
export function __resetShowAllWalkStatsForTesting(): void {
  showAllWalkInvocations = 0;
  showAllWalkAborts = 0;
}

/**
 * True when a `GET /api/documents?showAll=true` caller negotiated the NDJSON
 * stream via `Accept: application/x-ndjson`. Buffered callers (no such Accept —
 * tests, scripts, non-streaming clients) keep the single-JSON single-flight
 * response, so streaming is strictly opt-in and back-compatible.
 */
function showAllWantsNdjson(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('application/x-ndjson');
}

export interface StreamShowAllOpts {
  contentDir: string;
  contentFilter: ContentFilter;
  /** Optional dir filter (contentDir-relative subtree to walk; null = whole tree). */
  dirFilter: string | null;
  /** Hard ceiling on emitted entries; the walk stops once reached. */
  maxEntries: number;
  /**
   * Optional cancellation. When every caller waiting on this walk has
   * disconnected, the document-list handler aborts this signal; the walk then
   * bails at the next directory boundary rather than finishing a result nobody
   * will read.
   */
  signal?: AbortSignal;
  /**
   * Maximum directory depth to descend, relative to `dirFilter` (or contentDir
   * when no filter). Omitted/`Infinity` = the full recursive Show All walk.
   * `1` = the lazy per-directory contract: yield only the immediate
   * children of the scoped dir, no recursion, and stamp each folder child with
   * `hasChildren` so the client can render an expand affordance without walking
   * the subtree.
   */
  maxDepth?: number;
  /**
   * Admit `.ok` entries — minus `.ok/worktrees` and `.ok/local` — through the
   * content filter's always-skip floor (see `ContentFilterReadOpts.showOk`).
   * Backs `?showOk=true`; threaded into every filter consultation the walk
   * and its `hasChildren` probe make.
   */
  showOk?: boolean;
}

export interface WalkShowAllOpts extends StreamShowAllOpts {
  /** Accumulator the buffered wrapper drains the generator into. */
  documents: DocumentListEntry[];
}

/**
 * Walk `contentDir` on-demand for the `?showAll=true` flag, `yield`ing one
 * `DocumentListEntry` at a time instead of accumulating an array. Streaming the
 * walk this way collapses the showAll serialization heap peak: the buffered
 * design held the listing three times live (accumulator + Zod-validated clone +
 * `JSON.stringify` string), but a consumer that writes each yielded entry to
 * the socket retains only one entry plus the traversal cursors.
 *
 * Emission is level-order (BFS): every admitted entry at depth N across the
 * whole tree yields before any entry at depth N+1, and a parent folder always
 * yields before its children. Hitting the `maxEntries` cap therefore drops
 * the deepest entries first — the top of the tree stays complete whenever the
 * cap covers the shallow levels.
 *
 * Uses `ContentFilter.{isExcluded,isDirExcluded}` with `bypassFilters:true` so
 * `.gitignored` / `.okignored` / content-bearing `BUILTIN_SKIP_DIRS` (`dist/`,
 * `build/`, `coverage/`, …) surface. The `ALWAYS_SKIP_DIRS` floor still prunes
 * `.git/` / `node_modules/` / `.ok/` even under bypass (those trees are
 * unbounded and never hold user markdown — pruning them is the Show All Files
 * OOM guard); `showOk` re-admits `.ok` minus `worktrees`/`local`, the two
 * children that can be repo-scale. The un-bypassable STOP-rule gate keeps
 * synthetic `__system__` / `__config__` / `__user__` / `__local__` docs
 * hidden.
 *
 * Yields the union DocumentListEntry shape:
 *   - dirs → kind: 'folder' (with `path`)
 *   - `.md` / `.mdx` files → kind: 'document'
 *   - everything else → kind: 'asset' (with synthesized `assetExt` + `mediaKind`
 *     via `mediaKindForSidebarAssetExtension`; `referencedBy: []` since
 *     non-md/non-asset files have no `[[wiki-link]]` references)
 *
 * Returns `{ truncated }`: true when the `maxEntries` ceiling was hit and the
 * stream is a partial prefix. Per-directory read errors are silent-caught
 * (mirrors `populateDirCount` + `loadNestedIgnoreFiles` in `content-filter.ts`)
 * so a single broken symlink or permission failure doesn't abort the whole walk.
 */
export async function* streamShowAllEntries(
  opts: StreamShowAllOpts,
): AsyncGenerator<DocumentListEntry, { truncated: boolean }, void> {
  const { contentDir, contentFilter, dirFilter, maxEntries, signal, showOk } = opts;
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  // One opts object for every filter consultation: the dir gates, the
  // `hasChildren` probe, and the file backstop must agree on admission, or a
  // revealed folder probes childless / yields rows its own dir gate pruned.
  const filterOpts = { bypassFilters: true, showOk } as const;
  showAllWalkInvocations += 1;
  // Running count of yielded entries — the streaming analogue of the buffered
  // `documents.length` cap probe. Shared across the whole traversal so the
  // entry ceiling is global, not per-directory.
  let emitted = 0;
  let truncated = false;
  // Set when the walk bails on the abort signal; counted once after the walk
  // completes so `aborts` reflects "this walk stopped early".
  let aborted = false;

  const passesDirFilter = (rel: string): boolean => {
    if (!dirFilter) return true;
    return rel === dirFilter || rel.startsWith(`${dirFilter}/`);
  };

  // Resolve contentDir to its canonical form so we can compare descendants
  // by realpath. Without this, a user-created symlink at `<contentDir>/foo
  // -> /etc` would have `Dirent.isDirectory()` return true and recursion
  // would enumerate `/etc`'s metadata into the API response — metadata
  // disclosure of paths outside the project. The same realpath-based
  // containment guard is the spine of `ok:shell:show-item-in-folder` and
  // the trash-item IPC handler.
  let contentDirCanonical: string;
  try {
    contentDirCanonical = await realpath(contentDir);
  } catch {
    contentDirCanonical = contentDir;
  }
  const isInsideContentDir = (resolved: string): boolean =>
    isWithinDir(resolved, contentDirCanonical);

  const docVariantCounts = async (
    entries: readonly import('node:fs').Dirent[],
    absDir: string,
    relDir: string,
  ): Promise<ReadonlyMap<string, number>> => {
    const candidateCounts = new Map<string, number>();
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!isSupportedDocFile(entry.name)) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const docName = stripDocExtension(relPath);
      candidateCounts.set(docName, (candidateCounts.get(docName) ?? 0) + 1);
    }
    const collidingDocNames = new Set(
      [...candidateCounts].filter(([, count]) => count > 1).map(([docName]) => docName),
    );
    if (collidingDocNames.size === 0) return new Map();

    const counts = new Map<string, number>();
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!isSupportedDocFile(entry.name)) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const docName = stripDocExtension(relPath);
      if (!collidingDocNames.has(docName)) continue;
      if (contentFilter.isExcluded(relPath, { bypassFilters: true })) continue;
      if (!passesDirFilter(relPath)) continue;

      if (entry.isSymbolicLink()) {
        const linkAbs = join(absDir, entry.name);
        let canonical: string;
        try {
          canonical = await realpath(linkAbs);
        } catch {
          continue;
        }
        if (!isInsideContentDir(canonical)) continue;
        let canonStat: import('node:fs').Stats;
        try {
          canonStat = await stat(canonical);
        } catch {
          continue;
        }
        if (!canonStat.isFile()) continue;
      } else {
        try {
          await stat(join(absDir, entry.name));
        } catch {
          continue;
        }
      }

      counts.set(docName, (counts.get(docName) ?? 0) + 1);
    }
    return counts;
  };

  const showAllDocName = (
    relPath: string,
    countsByExtensionlessDocName: ReadonlyMap<string, number>,
  ): string => {
    const extensionless = stripDocExtension(relPath);
    return (countsByExtensionlessDocName.get(extensionless) ?? 0) > 1 ? relPath : extensionless;
  };

  // Cheap bounded probe for `hasChildren` on a leaf-depth folder (depth-1
  // contract): readdir the folder and stop at the first admitted child, so the
  // client can render an expand affordance without the server walking the
  // subtree. Applies the same ALWAYS_SKIP_DIRS-floor / ignore gate the walk
  // uses, so a folder containing only skipped entries reports hasChildren:false.
  async function probeHasChildren(absDir: string, relDir: string): Promise<boolean> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      // Log to match the sibling walk's readdir-failure convention — an
      // EACCES/EPERM here silently reporting hasChildren:false (folder renders
      // as a non-expandable leaf) is otherwise invisible to operators.
      console.warn(`[document-list][showAll] probe readdir failed for ${absDir}:`, err);
      return false;
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (contentFilter.isDirExcluded(relPath, filterOpts)) continue;
        // Symlink-escape parity with the main walk: a child that is a symlink to
        // a directory outside contentDir must not count as an admitted child
        // (the walk refuses to descend into it), so the probe must refuse it too.
        try {
          const childCanonical = await realpath(join(absDir, entry.name));
          if (!isInsideContentDir(childCanonical)) continue;
        } catch (err) {
          // Lazy expansion keys the expand affordance off this probe — a
          // silently-wrong hasChildren:false renders the folder permanently
          // childless with no operator trace (same convention as the readdir
          // and main-walk realpath catches).
          console.warn(
            `[document-list][showAll] probe realpath failed for ${absDir}/${entry.name}:`,
            err,
          );
          continue;
        }
        return true;
      }
      if (entry.isFile() && !contentFilter.isExcluded(relPath, filterOpts)) {
        return true;
      }
    }
    return false;
  }

  // Level-order (BFS) traversal via an explicit FIFO queue rather than DFS
  // recursion: every admitted entry at depth N (across the whole tree) yields
  // before any entry at depth N+1, so the `maxEntries` cap always cuts the
  // deepest entries first instead of starving root-level siblings of whichever
  // subtree readdir happened to enumerate first (readdir order is
  // filesystem-dependent, so WHICH siblings survived a DFS cap was arbitrary).
  // A parent folder still yields before its children — the folder while its
  // parent directory is processed, its children once it is dequeued. The queue
  // holds pending directory paths only (bounded by the emitted folder count,
  // itself <= maxEntries), preserving the O(1)-entries streaming property.
  async function* walk(
    startAbsDir: string,
    startRelDir: string,
    startDepth: number,
  ): AsyncGenerator<DocumentListEntry> {
    const queue: Array<{ absDir: string; relDir: string; depth: number }> = [
      { absDir: startAbsDir, relDir: startRelDir, depth: startDepth },
    ];
    // Head-index dequeue: `queue.length` re-evaluates each iteration, so
    // directories pushed mid-loop extend the walk; `Array.shift` would be
    // O(n) against the tens of thousands of directories the default cap
    // admits.
    for (let head = 0; head < queue.length; head++) {
      // Abort gate at the queue boundary: empty or fully-filtered directories
      // never reach the per-entry check below, so without this a disconnected
      // client's walk would keep issuing readdir across the queued breadth.
      if (signal?.aborted) {
        aborted = true;
        return;
      }
      const { absDir, relDir, depth } = queue[head];
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(absDir, { withFileTypes: true });
      } catch (err) {
        console.warn(`[document-list][showAll] readdir failed for ${absDir}:`, err);
        continue;
      }
      const variantCountsByDocName = await docVariantCounts(entries, absDir, relDir);

      for (const entry of entries) {
        // Abort-on-disconnect: stop walking once the request's last waiter has
        // gone. Checked at the same per-entry boundary as the entry cap so both
        // bounds short-circuit before any further readdir/stat work.
        if (signal?.aborted) {
          aborted = true;
          return;
        }
        // Bound the walk. A content dir pointed at a large repo can hold far
        // more entries than the response can carry; without a ceiling the
        // consumer is fed entries until the server heap is exhausted. Checking
        // before any yield keeps the emitted count <= maxEntries exactly.
        if (emitted >= maxEntries) {
          truncated = true;
          return;
        }
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          // bypassFilters:true admits gitignored + content-bearing skip-dirs
          // (dist/, build/), but the ALWAYS_SKIP_DIRS floor still prunes
          // .git/, node_modules/, .ok/ here — the Show All Files OOM guard.
          // showOk re-admits .ok minus worktrees/local for the tree reveal.
          if (contentFilter.isDirExcluded(relPath, filterOpts)) continue;

          // Symlink-escape guard. `Dirent.isDirectory()` returns true for a
          // symlink pointing at a directory; without canonical-path containment,
          // a `<contentDir>/foo -> /etc` symlink would enumerate /etc into the
          // response. Resolve the canonical target and refuse anything outside
          // contentDir's realpath. Skip-with-log mirrors the file-watcher's
          // existing symlink-escape protection.
          const dirAbsRaw = join(absDir, entry.name);
          let dirCanonical: string;
          try {
            dirCanonical = await realpath(dirAbsRaw);
          } catch (err) {
            console.warn(`[document-list][showAll] realpath failed for ${dirAbsRaw}:`, err);
            continue;
          }
          if (!isInsideContentDir(dirCanonical)) {
            console.warn(
              `[document-list][showAll] refusing symlink-escape ${dirAbsRaw} -> ${dirCanonical}`,
            );
            continue;
          }

          if (passesDirFilter(relPath)) {
            let folderStat: import('node:fs').Stats | null = null;
            try {
              folderStat = await stat(dirAbsRaw);
            } catch (err) {
              // Stat failure is non-fatal: emit with modified='' as a graceful
              // fallback so the dir still surfaces in the tree. Log the
              // failure for diagnosability — symmetric with the file-stat
              // sibling catch below, so EACCES/EPERM/ELOOP on a restricted
              // subdir is visible in operator logs instead of silently
              // returning empty-mtime folder entries.
              console.warn(`[document-list][showAll] stat failed for ${dirAbsRaw}:`, err);
            }
            emitted += 1;
            // At leaf depth (the depth-1 lazy contract stops descending here),
            // probe whether this folder has any admitted child so the client can
            // show an expand affordance. On the full recursive walk the children
            // are emitted directly, so the probe is skipped and hasChildren stays
            // absent (the recursive showAll response never carries it).
            const atLeafDepth = depth >= maxDepth;
            const hasChildren = atLeafDepth
              ? await probeHasChildren(dirAbsRaw, relPath)
              : undefined;
            yield {
              kind: 'folder',
              path: relPath,
              size: 0,
              modified: folderStat ? folderStat.mtime.toISOString() : '',
              docExt: '.md',
              isSymlink: false,
              canonicalDocName: null,
              targetPath: null,
              ...(hasChildren === undefined ? {} : { hasChildren }),
            };
          }

          // Enqueue only while under the depth ceiling. depth-1 (maxDepth=1)
          // yields a single level and enqueues nothing; the default walk has
          // an infinite ceiling and visits the whole subtree level by level.
          if (depth < maxDepth) {
            queue.push({ absDir: dirAbsRaw, relDir: relPath, depth: depth + 1 });
          }
          continue;
        }

        // Symlinked entries: a `Dirent` for a symlink reports neither
        // isDirectory() nor isFile() (d_type is DT_LNK), so the directory branch
        // above skips them and the `!isFile()` guard below would drop them.
        // Resolve the target and surface symlinked directories (and files) so
        // aliased folders appear in the tree. A symlinked directory is emitted as
        // a folder but NOT enqueued — the full walk must never recurse into a
        // symlink (cycles + symlink-farm blow-up); lazy expansion re-enters via
        // `dir=<aliasPath>`, where readdir follows the link and lists the
        // canonical's children under the alias prefix.
        if (entry.isSymbolicLink()) {
          const linkAbs = join(absDir, entry.name);
          let canonical: string;
          try {
            canonical = await realpath(linkAbs);
          } catch (err) {
            console.warn(`[document-list][showAll] symlink realpath failed for ${linkAbs}:`, err);
            continue;
          }
          if (!isInsideContentDir(canonical)) {
            console.warn(
              `[document-list][showAll] refusing symlink-escape ${linkAbs} -> ${canonical}`,
            );
            continue;
          }
          let canonStat: import('node:fs').Stats;
          try {
            canonStat = await stat(canonical);
          } catch (err) {
            console.warn(
              `[document-list][showAll] symlink target stat failed for ${linkAbs}:`,
              err,
            );
            continue;
          }
          const targetRel = toPosix(relative(contentDir, canonical));
          if (canonStat.isDirectory()) {
            if (contentFilter.isDirExcluded(relPath, filterOpts)) continue;
            if (!passesDirFilter(relPath)) continue;
            emitted += 1;
            yield {
              kind: 'folder',
              path: relPath,
              size: 0,
              modified: canonStat.mtime.toISOString(),
              docExt: '.md',
              isSymlink: true,
              canonicalDocName: targetRel,
              targetPath: targetRel,
              hasChildren: await probeHasChildren(canonical, relPath),
            };
            continue;
          }
          if (!canonStat.isFile()) continue;
          if (contentFilter.isExcluded(relPath, filterOpts)) continue;
          if (!passesDirFilter(relPath)) continue;
          emitted += 1;
          if (isSupportedDocFile(entry.name)) {
            const docName = showAllDocName(relPath, variantCountsByDocName);
            yield {
              kind: 'document',
              docName,
              docExt: extname(entry.name),
              size: canonStat.size,
              modified: canonStat.mtime.toISOString(),
              isSymlink: true,
              canonicalDocName: targetRel.replace(/\.(md|mdx)$/i, ''),
              targetPath: targetRel,
            };
          } else {
            const assetExt = synthesizeShowAllAssetExt(entry.name);
            yield {
              kind: 'asset',
              docName: relPath,
              docExt: assetExt,
              path: relPath,
              assetExt,
              mediaKind: mediaKindForSidebarAssetExtension(assetExt),
              referencedBy: [],
              size: canonStat.size,
              modified: canonStat.mtime.toISOString(),
              isSymlink: true,
              canonicalDocName: null,
              targetPath: targetRel,
            };
          }
          continue;
        }

        if (!entry.isFile()) continue;
        // The file-level backstop mirrors the dir gate's admission (shared
        // filterOpts): floor files can't actually reach here — the dir gate
        // above already skipped .git/node_modules/(non-revealed) .ok.
        if (contentFilter.isExcluded(relPath, filterOpts)) continue;
        if (!passesDirFilter(relPath)) continue;

        let fileStat: import('node:fs').Stats | null = null;
        try {
          fileStat = await stat(join(absDir, entry.name));
        } catch (err) {
          console.warn(`[document-list][showAll] stat failed for ${absDir}/${entry.name}:`, err);
          continue;
        }

        if (isSupportedDocFile(entry.name)) {
          // Markdown — classify as 'document'. The directory entry is the
          // show-all source of truth for the file extension.
          const docName = showAllDocName(relPath, variantCountsByDocName);
          const docExt = extname(entry.name);
          emitted += 1;
          yield {
            kind: 'document',
            docName,
            docExt,
            size: fileStat.size,
            modified: fileStat.mtime.toISOString(),
            isSymlink: false,
            canonicalDocName: null,
            targetPath: null,
          };
          continue;
        }

        // Non-markdown — classify as 'asset' with synthesized assetExt.
        // `mediaKindForSidebarAssetExtension` returns null for extensions with no sidebar
        // viewer (e.g. .docx, .zip), and 'text' for .base/.canvas (text-viewer-fallback
        // set) even though those extensions are absent from ASSET_EXTENSIONS (serve
        // allowlist unchanged). No explicit ASSET_EXTENSIONS check needed; the function
        // already encodes the full dispatch table.
        const assetExt = synthesizeShowAllAssetExt(entry.name);
        const mediaKind: InlineAssetMediaKind | null = mediaKindForSidebarAssetExtension(assetExt);
        emitted += 1;
        yield {
          kind: 'asset',
          docName: relPath,
          docExt: assetExt,
          path: relPath,
          assetExt,
          mediaKind,
          referencedBy: [],
          size: fileStat.size,
          modified: fileStat.mtime.toISOString(),
          isSymlink: false,
          canonicalDocName: null,
          targetPath: null,
        };
      }
    }
  }

  const startAbs = dirFilter ? join(contentDir, dirFilter) : contentDir;
  const startRel = dirFilter ?? '';
  // The scoped dir's own children are depth 1; `walk` stops enqueuing once
  // `depth >= maxDepth`, so maxDepth=1 yields exactly one level.
  yield* walk(startAbs, startRel, 1);
  if (aborted) showAllWalkAborts += 1;
  return { truncated };
}

/**
 * Buffered adapter over `streamShowAllEntries`: drains the generator into the
 * caller's `documents` accumulator and returns the same `{ truncated }` outcome.
 * This is the single-flight path (`GET /api/documents?showAll=true` without an
 * NDJSON `Accept`) — it preserves the sortable, validate-once, single-JSON
 * response shape every non-streaming caller depends on. Streaming callers
 * consume `streamShowAllEntries` directly and never materialize this array.
 */
export async function walkContentDirForShowAll(
  opts: WalkShowAllOpts,
): Promise<{ truncated: boolean }> {
  const { documents, ...streamOpts } = opts;
  const generator = streamShowAllEntries(streamOpts);
  let next = await generator.next();
  while (!next.done) {
    documents.push(next.value);
    next = await generator.next();
  }
  return next.value;
}

/** Sorted result of one Show All Files walk, shared by all coalesced callers. */
interface ShowAllWalkResult {
  documents: DocumentListEntry[];
  truncated: boolean;
}

/**
 * One in-flight Show All Files walk, shared by every concurrent request of the
 * same shape (single-flight dedupe — collapses the `concurrent_walks` heap
 * multiplier to 1). `waiters` refcounts still-connected callers; the walk is
 * aborted via `controller` only once it reaches zero, so one caller
 * disconnecting never strands the others.
 */
interface InflightShowAllWalk {
  promise: Promise<ShowAllWalkResult>;
  controller: AbortController;
  waiters: number;
}

type ContentEntryKind = 'file' | 'folder';

interface RenamedDocMapping {
  fromDocName: string;
  toDocName: string;
}

interface RenamedAssetMapping {
  fromPath: string;
  toPath: string;
}

interface ManagedRenameRewriteSummary {
  markdown: string;
  rewrites: number;
}

interface ManagedRenameRewrittenDoc {
  docName: string;
  rewrites: number;
}

function isValidRelativeContentPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\x00')) {
    return false;
  }

  return path.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

/**
 * True when any `/`-separated segment of `path` is `.ok` or `.git`, at any
 * depth — nested `<folder>/.ok/` is a first-class OK shape (folder metadata +
 * templates), so a top-level-only check is not a boundary. Segments compare
 * case-insensitively: on the default case-insensitive macOS filesystem an
 * externally-addressed `.OK/x` IS `.ok/x`. Same segment walk as
 * `pathHasAlwaysSkipSegment` in content-filter.ts.
 */
function isReservedProjectStatePath(path: string): boolean {
  return path.split('/').some((segment) => {
    const normalized = segment.toLowerCase();
    return normalized === OK_DIR || normalized === '.git';
  });
}

function isReservedSyntheticFolderPath(path: string): boolean {
  return (
    path === '__system__' ||
    path === '__config__' ||
    path === '__user__' ||
    path === '__local__' ||
    path.startsWith('__system__/') ||
    path.startsWith('__config__/') ||
    path.startsWith('__user__/') ||
    path.startsWith('__local__/')
  );
}

function listAffectedDocNames(
  index: ReadonlyMap<string, FileIndexEntry>,
  kind: ContentEntryKind,
  path: string,
): string[] {
  const docNames = [...index.keys()].filter((docName) =>
    kind === 'file' ? docName === path : docName === path || docName.startsWith(`${path}/`),
  );
  docNames.sort((a, b) => a.localeCompare(b));
  return docNames;
}

function remapDocNameForRename(
  docName: string,
  kind: ContentEntryKind,
  fromPath: string,
  toPath: string,
): string {
  if (kind === 'file') return toPath;
  if (docName === fromPath) return toPath;
  return `${toPath}${docName.slice(fromPath.length)}`;
}

/**
 * Validate a request `docName`, rejecting empty/missing values before they can
 * silently route to a fallback target. An empty docName previously fell through
 * to a hardcoded `test-doc`, so a write carrying no docName overwrote that doc
 * and still reported success — a silent wrong-target write (data-loss class).
 * Returns the non-empty name, or null after emitting a 400 (caller must
 * early-return).
 */
function requireNonEmptyDocName(
  docName: string | undefined,
  res: ServerResponse,
  handler: string,
): string | null {
  if (docName !== undefined && docName.length > 0) return docName;
  errorResponse(
    res,
    400,
    'urn:ok:error:invalid-request',
    '`docName` must be a non-empty document name.',
    { handler },
  );
  return null;
}

/**
 * Ensures `fullPath` does not escape `resolvedContentDir` via symlinks (matches persistence
 * symlink-escape checks). Walks up with dirname when the leaf is missing so destinations like
 * `link/new.md` are rejected if `link` resolves outside the content dir.
 *
 * Uses `realpathSync(resolvedContentDir)` as the boundary anchor so platform normalization
 * (e.g. macOS `/var` → `/private/var`) matches `realpathSync` of paths under it.
 */
function assertNoSymlinkEscape(fullPath: string, resolvedContentDir: string): void {
  let contentRoot: string;
  try {
    contentRoot = realpathSync(resolvedContentDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT means the content dir hasn't been created yet — no symlink
    // escape is possible against a non-existent directory, but we have
    // no safe baseline for the check either. Throw the same
    // `symlink-escape:` error class so the caller's catch routes through
    // the existing error path. Other errno classes (EPERM, EIO, ENOMEM)
    // must NOT be swallowed silently — they'd leave the security gate
    // disabled with no log line, no telemetry, no error response. Throw
    // and let the top-level handler emit a typed RFC 9457 problem.
    if (code === 'ENOENT') {
      throw new SymlinkEscapeError('content directory does not exist');
    }
    throw err;
  }

  let cur = fullPath;
  for (;;) {
    try {
      const canonical = realpathSync(cur);
      if (!isWithinContentDir(canonical, contentRoot)) {
        throw new SymlinkEscapeError('path resolves outside content directory');
      }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') {
        throw new SymlinkEscapeError('symlink cycle in path');
      }
      if (code !== 'ENOENT') throw err;
      const parent = dirname(cur);
      if (parent === cur) throw err;
      if (parent !== resolvedContentDir && !parent.startsWith(`${resolvedContentDir}${sep}`)) {
        throw err;
      }
      cur = parent;
    }
  }
}

function resolveContentEntryPath(contentDir: string, kind: ContentEntryKind, path: string): string {
  if (!isValidRelativeContentPath(path)) {
    throw new Error('path must be a relative content path');
  }

  const resolvedContentDir = resolve(contentDir);
  // When kind is 'file': if the caller passed an explicit supported extension,
  // use the path verbatim — this is how rename callers signal an extension
  // change (toPath: "foo.mdx" renames foo.md → foo.mdx). Extension-less paths
  // route through `docNameToRelativePath`, which consults the registered
  // extension map so legacy callers keep the source's existing extension.
  const relativePath = kind === 'file' ? docNameToRelativePath(path) : path;
  const fullPath = resolve(resolvedContentDir, relativePath);

  if (fullPath !== resolvedContentDir && !fullPath.startsWith(`${resolvedContentDir}${sep}`)) {
    throw new Error('path must not escape content directory');
  }

  assertNoSymlinkEscape(fullPath, resolvedContentDir);

  return fullPath;
}

function splitContentPath(path: string): { parent: string; basename: string } {
  const slash = path.lastIndexOf('/');
  if (slash === -1) return { parent: '', basename: path };
  return {
    parent: path.slice(0, slash),
    basename: path.slice(slash + 1),
  };
}

function joinContentPath(parent: string, basename: string): string {
  return parent ? `${parent}/${basename}` : basename;
}

function duplicateBasename(basename: string, attempt: number): string {
  return attempt === 1 ? `${basename} copy` : `${basename} copy ${attempt}`;
}

class DuplicateNameExhaustedError extends Error {
  constructor(readonly sourcePath: string) {
    super(`Could not find an available duplicate name for ${sourcePath}`);
    this.name = 'DuplicateNameExhaustedError';
  }
}

function isAlreadyExistsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EEXIST' || code === 'ERR_FS_CP_EEXIST';
}

type DuplicatePathFilesystemProblem = {
  status: 500 | 507;
  type: Extract<ProblemType, 'urn:ok:error:storage-full' | 'urn:ok:error:storage-readonly'>;
  title: string;
};

function classifyDuplicatePathFilesystemProblem(
  err: unknown,
): DuplicatePathFilesystemProblem | null {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return {
      status: 507,
      type: 'urn:ok:error:storage-full',
      title: 'Could not duplicate path because storage is full.',
    };
  }
  if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') {
    return {
      status: 500,
      type: 'urn:ok:error:storage-readonly',
      title: 'Could not duplicate path because storage is not writable.',
    };
  }
  return null;
}

function docNameExistsWithAnySupportedExtension(contentDir: string, docName: string): boolean {
  if (isSupportedDocFile(docName)) {
    return existsSync(resolve(contentDir, docName));
  }
  return SUPPORTED_DOC_EXTENSIONS.some((ext) =>
    existsSync(resolve(contentDir, `${docName}${ext}`)),
  );
}

function hasSameStemDocumentSibling(contentDir: string, relPath: string): boolean {
  if (!isSupportedDocFile(relPath)) return false;
  const extensionless = stripDocExtension(relPath);
  const currentExt = extname(relPath).toLowerCase();
  return SUPPORTED_DOC_EXTENSIONS.some((ext) => {
    if (ext.toLowerCase() === currentExt) return false;
    return existsSync(resolve(contentDir, `${extensionless}${ext}`));
  });
}

function docNameForFileOperationPath(contentDir: string, relPath: string): string {
  const extensionless = stripDocExtension(relPath);
  return isSupportedDocFile(relPath) && hasSameStemDocumentSibling(contentDir, relPath)
    ? relPath
    : extensionless;
}

function resolveDuplicateDocPath(contentDir: string, docName: string, extension: string): string {
  if (!isValidRelativeContentPath(docName)) {
    throw new Error('path must be a relative content path');
  }
  const resolvedContentDir = resolve(contentDir);
  const fullPath = resolve(resolvedContentDir, `${docName}${extension}`);
  if (fullPath !== resolvedContentDir && !fullPath.startsWith(`${resolvedContentDir}${sep}`)) {
    throw new Error('path must not escape content directory');
  }
  assertNoSymlinkEscape(fullPath, resolvedContentDir);
  return fullPath;
}

function nextAvailableDuplicateDocName(
  contentDir: string,
  sourceDocName: string,
): { docName: string; attempt: number } {
  const { parent, basename } = splitContentPath(sourceDocName);
  for (let attempt = 1; attempt <= 10_000; attempt += 1) {
    const candidate = joinContentPath(parent, duplicateBasename(basename, attempt));
    if (!docNameExistsWithAnySupportedExtension(contentDir, candidate)) {
      return { docName: candidate, attempt };
    }
  }
  throw new DuplicateNameExhaustedError(sourceDocName);
}

function nextAvailableDuplicateFolderPath(
  contentDir: string,
  sourceFolderPath: string,
): { folderPath: string; attempt: number } {
  const { parent, basename } = splitContentPath(sourceFolderPath);
  for (let attempt = 1; attempt <= 10_000; attempt += 1) {
    const candidate = joinContentPath(parent, duplicateBasename(basename, attempt));
    const fullPath = resolveContentEntryPath(contentDir, 'folder', candidate);
    if (!existsSync(fullPath)) return { folderPath: candidate, attempt };
  }
  throw new DuplicateNameExhaustedError(sourceFolderPath);
}

function collectMarkdownCopies(
  contentDir: string,
  folderPath: string,
): Array<{ docName: string; fullPath: string; content: string }> {
  const folderAbs = resolveContentEntryPath(contentDir, 'folder', folderPath);
  const docs: Array<{ docName: string; fullPath: string; content: string }> = [];

  function walk(absDir: string, relDir: string): void {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const childAbs = resolve(absDir, entry.name);
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      if (!entry.isFile() || !isSupportedDocFile(childRel)) continue;
      docs.push({
        docName: docNameForFileOperationPath(contentDir, childRel),
        fullPath: childAbs,
        content: readFileSync(childAbs, 'utf-8'),
      });
    }
  }

  walk(folderAbs, folderPath);
  docs.sort((a, b) => a.docName.localeCompare(b.docName));
  return docs;
}

function collectFolderPaths(contentDir: string, folderPath: string): string[] {
  const folderAbs = resolveContentEntryPath(contentDir, 'folder', folderPath);
  const folders: string[] = [folderPath];

  function walk(absDir: string, relDir: string): void {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const childAbs = resolve(absDir, entry.name);
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      folders.push(childRel);
      walk(childAbs, childRel);
    }
  }

  walk(folderAbs, folderPath);
  folders.sort((a, b) => a.localeCompare(b));
  return folders;
}

/**
 * Probe disk for the actual on-disk extension of a file's docName, registering
 * it in the doc-extensions map if found. Closes a boot/watcher race where the
 * rename handler runs before the file watcher has observed the source — without
 * this, `getDocExtension()` returns the `.md` default, which silently defeats
 * `.mdx`-specific exclusion patterns and routes existence checks to the wrong
 * path. Iterating in `SUPPORTED_DOC_EXTENSIONS` precedence order ensures the
 * `.mdx` precedence rule is preserved when both files exist on disk.
 * Idempotent — `registerDocExtension` is a no-op when the higher-precedence
 * extension is already registered.
 */
function probeAndRegisterSourceFileExtension(contentDir: string, fromPath: string): void {
  if (!isValidRelativeContentPath(fromPath)) return;
  const resolvedContentDir = resolve(contentDir);
  if (isSupportedDocFile(fromPath)) {
    const extensionless = stripDocExtension(fromPath);
    for (const ext of SUPPORTED_DOC_EXTENSIONS) {
      const candidate = resolve(resolvedContentDir, `${extensionless}${ext}`);
      if (
        candidate !== resolvedContentDir &&
        !candidate.startsWith(`${resolvedContentDir}${sep}`)
      ) {
        continue;
      }
      if (existsSync(candidate)) {
        registerDocExtension(extensionless, ext);
      }
    }
    const explicitCandidate = resolve(resolvedContentDir, fromPath);
    if (
      explicitCandidate !== resolvedContentDir &&
      explicitCandidate.startsWith(`${resolvedContentDir}${sep}`) &&
      existsSync(explicitCandidate)
    ) {
      registerDocExtension(extensionless, extname(fromPath));
    }
    return;
  }
  for (const ext of SUPPORTED_DOC_EXTENSIONS) {
    const candidate = resolve(resolvedContentDir, `${fromPath}${ext}`);
    if (candidate !== resolvedContentDir && !candidate.startsWith(`${resolvedContentDir}${sep}`)) {
      continue;
    }
    if (existsSync(candidate)) {
      registerDocExtension(fromPath, ext);
      return;
    }
  }
}

function toGitRelativePath(projectDir: string, absolutePath: string): string | null {
  const resolvedProjectDir = resolve(projectDir);
  const resolvedPath = resolve(absolutePath);
  if (
    resolvedPath !== resolvedProjectDir &&
    !resolvedPath.startsWith(`${resolvedProjectDir}${sep}`)
  ) {
    return null;
  }
  return relative(resolvedProjectDir, resolvedPath).split(sep).join('/');
}

function stringsDifferOnlyByCase(left: string, right: string): boolean {
  return left !== right && left.toLowerCase() === right.toLowerCase();
}

function pathsDifferOnlyByCase(left: string, right: string): boolean {
  return stringsDifferOnlyByCase(resolve(left), resolve(right));
}

function isCaseOnlySelfCollision(sourcePath: string, destinationPath: string): boolean {
  if (!pathsDifferOnlyByCase(sourcePath, destinationPath)) return false;
  if (!existsSync(sourcePath) || !existsSync(destinationPath)) return false;

  try {
    const sourceStat = statSync(sourcePath);
    const destinationStat = statSync(destinationPath);
    return sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino;
  } catch {
    return false;
  }
}

function createCaseOnlyRenameTempPath(sourcePath: string): string {
  const parent = dirname(sourcePath);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = resolve(parent, `.ok-case-rename-${randomUUID()}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error('Unable to allocate temporary path for case-only rename');
}

/**
 * Write `content` to `filePath` only when it differs from the bytes already on
 * disk. The rename spine moves a file (placing the source's bytes at the
 * destination) and then writes the reconciled content; when that reconciled
 * content is byte-identical to what the move placed, the physical write is
 * redundant. Skipping the no-op write preserves the invariant that a
 * no-content-change rename writes the destination exactly once.
 *
 * This is a BYTE-EXACT guard (`current === content`), distinct from
 * persistence.ts's `markdownSemanticallyUnchanged`, which skips on SEMANTIC
 * (`normalizeBridge`-normalized) equality. The byte comparison is deliberate:
 * it under-skips relative to semantic equality, so it can only ever leave an
 * occasional redundant write, never suppress a needed one. Aligning it to
 * `normalizeBridge` would skip writes for byte-different-but-semantically-equal
 * content and leave stale bytes on disk.
 *
 * Callers MUST still `registerWrite` the path unconditionally: the move does
 * not `registerWrite` the destination, so the file-watcher's self-suppression
 * for it depends entirely on the caller's post-write `registerWrite`. This
 * guard wraps only the physical write.
 */
function writeFileIfContentDiffers(filePath: string, content: string): void {
  const current = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
  if (current === content) return;
  tracedWriteFileSync(filePath, content, 'utf-8');
}

function renamePathOnDisk(sourcePath: string, destinationPath: string): void {
  tracedMkdirSync(dirname(destinationPath), { recursive: true });
  if (!pathsDifferOnlyByCase(sourcePath, destinationPath)) {
    tracedRenameSync(sourcePath, destinationPath);
    return;
  }

  const tempPath = createCaseOnlyRenameTempPath(sourcePath);
  tracedRenameSync(sourcePath, tempPath);
  try {
    tracedRenameSync(tempPath, destinationPath);
  } catch (err) {
    try {
      const tempExists = existsSync(tempPath);
      const sourceExists = existsSync(sourcePath);
      if (tempExists && !sourceExists) {
        tracedRenameSync(tempPath, sourcePath);
      } else {
        console.warn('[renamePathOnDisk] skipped case-only rollback due to unexpected state:', {
          tempExists,
          sourceExists,
        });
      }
    } catch (rollbackErr) {
      console.warn(
        '[renamePathOnDisk] failed to roll back temporary case-only rename:',
        rollbackErr,
      );
    }
    throw err;
  }
}

async function renameTrackedPathInGit(
  projectDir: string | undefined,
  sourcePath: string,
  destinationPath: string,
): Promise<boolean> {
  if (!projectDir) return false;
  const sourceRel = toGitRelativePath(projectDir, sourcePath);
  const destinationRel = toGitRelativePath(projectDir, destinationPath);
  if (!sourceRel || !destinationRel) return false;

  return await withParentLock(async () => {
    const pg = simpleGit({ baseDir: projectDir, timeout: { block: 15_000 } });
    // `ls-files` throws `GitError: fatal: not a git repository` when
    // projectDir isn't a git checkout — normal in test tmpdirs and in Vite
    // dev's isolated OK_TEST_CONTENT_DIR mode. Treat that as "not tracked"
    // so the caller falls back to `fs.renameSync`. Any other git failure
    // (permission denied, corrupted index) also falls through to fs rename
    // rather than 500ing the /api/rename-path handler.
    let tracked = '';
    try {
      tracked = (await pg.raw('ls-files', '--', sourceRel)).trim();
    } catch (err) {
      console.warn('[renameTrackedPathInGit] git ls-files failed, falling back to fs rename:', err);
      return false;
    }
    if (!tracked) return false;
    mkdirSync(dirname(destinationPath), { recursive: true });
    let partialStateMutation = false;
    try {
      if (pathsDifferOnlyByCase(sourcePath, destinationPath)) {
        const tempPath = createCaseOnlyRenameTempPath(sourcePath);
        const tempRel = toGitRelativePath(projectDir, tempPath);
        if (!tempRel) return false;
        await pg.raw('mv', '--', sourceRel, tempRel);
        try {
          await pg.raw('mv', '--', tempRel, destinationRel);
        } catch (err) {
          try {
            await pg.raw('mv', '--', tempRel, sourceRel);
          } catch (rollbackErr) {
            console.warn(
              '[renameTrackedPathInGit] case-only git rename failed and rollback also failed; git index and disk may have diverged:',
              rollbackErr,
            );
            partialStateMutation = true;
          }
          throw err;
        }
      } else {
        await pg.raw('mv', '--', sourceRel, destinationRel);
      }
      return true;
    } catch (err) {
      if (partialStateMutation) throw err;
      console.warn('[renameTrackedPathInGit] git mv failed, falling back to fs rename:', err);
      return false;
    }
  });
}

export interface ApiExtensionOptions {
  hocuspocus: Hocuspocus;
  sessionManager: AgentSessionManager;
  contentDir: string;
  /**
   * No-project ephemeral single-file mode. When `true`, the contentDir-tree
   * write handlers (`PUT /api/folder-config`, `PUT /api/template`) are inert —
   * they reject with 403. Belt-and-suspenders for (zero user-dir artifacts):
   * single-file mode hides the Settings / folder chrome and unmounts MCP, so
   * these handlers are already unreachable on the open+edit path, but the guard
   * makes the no-write invariant structural rather than relying on the UI.
   * The `__config__/okignore` config-doc write is guarded separately in
   * `config-persistence.ts` via `ConfigPersistenceCtx.ephemeral`. Default
   * `false`.
   */
  ephemeral?: boolean;
  /**
   * Per-process UUID advertised via `GET /api/server-info` and the
   * `__system__` CC1 `server-info` broadcast. Clients cache this value
   * and claim it in the `expectedServerInstanceId` field of their auth
   * token on every connect; the server rejects on mismatch. Part of the
   * CRDT server-restart recovery defense.
   */
  serverInstanceId: string;
  /** Accessor for the watcher's in-memory file index. GET /api/documents reads from this. */
  getFileIndex: () => ReadonlyMap<string, FileIndexEntry>;
  /**
   * Reads the project attachment-placement value at request time. Omitted
   * harnesses use the historical colocated default.
   */
  getAttachmentFolderPath?: () => string;
  /**
   * All-files accessor — both `kind:'markdown'` and `kind:'file'`. The explicit
   * opt-in for the handful of sites that genuinely want non-markdown files
   * (the search-corpus build, `/api/documents`, folder synthesis). A caller
   * coverage meta-test gates new consumers. Defaults to `getFileIndex` when
   * omitted (test harnesses that only wire the markdown view), so the all-files
   * tier is empty rather than crashing.
   */
  getAllFilesIndex?: () => ReadonlyMap<string, FileIndexEntry>;
  /**
   * Monotonic file-index generation counter (`WatcherHandle.getFileIndexGeneration`).
   * When wired, `workspaceSearchFingerprint` keys the corpus cache off this
   * counter (O(1) per search) instead of re-serializing the whole all-files
   * index. Omit in test harnesses that wire only the index accessors — the
   * fingerprint then falls back to serializing the full all-files index, which
   * is slower but keeps cache invalidation correct.
   */
  getFileIndexGeneration?: () => number;
  /**
   * Typed mutator for the watcher's live file index. Wired to
   * `WatcherHandle.mutateFileIndex`. Handlers that need post-write
   * consistency (delete, trash-cleanup, rename, create-page, duplicate-path)
   * call this synchronously so the next `/api/documents` read reflects the
   * mutation before the file-watcher's own disk event lands. Replaces the
   * `getFileIndex() + as Map<...> cast + updateFileIndex(...)`
   * pattern, which silently dead-ended once `getFileIndex()` returned a
   * snapshot. Omit in test harnesses that don't care about the synchronous
   * purge — the file-watcher will reconcile asynchronously.
   */
  mutateFileIndex?: (event: DiskEvent) => void;
  /** Accessor for the watcher's in-memory folder index. GET /api/documents reads from this. */
  getFolderIndex?: () => ReadonlyMap<string, FolderIndexEntry>;
  /**
   * Registers the GET /api/documents referenced-asset cache invalidator with
   * outer server components that can detect markdown reference changes.
   */
  onReferencedAssetsCacheInvalidator?: (invalidate: () => void) => void;
  /** Accessor for the alias map (alias docName → canonical docName). */
  getAliasMap?: () => ReadonlyMap<string, string>;
  /** Accessor for directory-symlink alias edges (alias folder docName → canonical folder docName). */
  getFolderAliasIndex?: () => ReadonlyMap<string, string>;
  /**
   * Re-seed the watcher's file/folder/alias indexes from disk. Required by
   * `POST /api/test-rescan-files` (only registered when `enableTestRoutes`),
   * which is the dev-only rescue for the @parcel/watcher inotify race on
   * Linux CI — see `WatcherHandle.rescanFromDisk` in `file-watcher.ts`.
   */
  rescanFiles?: () => void | Promise<void>;
  /**
   * When true, register test-only routes (`/api/test-reset`,
   * `/api/test-rescan-backlinks`, `/api/test-rescan-files`). Defaults to
   * `false` — these routes mutate server state in ways unsafe for
   * multi-client use (reset wipes document content; rescan-* rebuild
   * indexes from disk, dropping unpersisted in-memory state) and must
   * never be exposed in production. Enable only in tests and local dev mode.
   */
  enableTestRoutes?: boolean;
  shadowRef?: ShadowRef;
  /** Force-flush the L2 git commit debounce (e.g. after rollback). */
  flushGitCommit?: () => Promise<void>;
  /**
   * Force-drain the contributor queue for the rename-log integration.
   * Declared here so `server-factory.ts` typechecks; the rename-log wiring
   * inside this file (handleRenamePath / applyManagedRename / handleHistory*)
   * is NOT yet ported from origin/main.
   */
  flushContributors?: () => Promise<void>;
  /**
   * Read-and-clear the last disk-store failure for a docName. Wired to
   * `persistence.takeStoreFailure`. A write handler force-flushes the store
   * then calls this to report disk truth instead of a false success when the
   * persistence step threw (ENOSPC / EACCES / EROFS, etc.).
   */
  takeStoreFailure?: (docName: string) => StoreFailure | null;
  /**
   * Read-and-clear whether a docName's most recent agent-triggered store was
   * reverted by the L3 disk-divergence backstop. Wired to
   * `persistence.takeStoreDivergence`. A write handler force-flushes the store
   * then calls this to return `urn:ok:error:disk-divergence` instead of a false
   * success when disk diverged and the overwrite was aborted (disk won).
   */
  takeStoreDivergence?: (docName: string) => boolean;
  /**
   * Mark a docName's next store as agent-write-triggered (L3
   * gate). Wired to `persistence.markAgentWriteStore`. `flushDiskAndDetectOutcome`
   * calls it immediately before force-flushing, so only agent-handler-forced
   * stores can disk-wins-revert on divergence (human-editor stores are excluded).
   */
  markAgentWriteStore?: (docName: string) => void;
  /** Accessor for the current branch from the HEAD watcher. Returns null when unknown. */
  getCurrentBranch?: () => string | null;
  /**
   * Accessor for the latest disk-ack state vectors per document. Wired
   * to `cc1Broadcaster.getLatestDiskAckSVsAsBase64()` in boot.
   * Returned as part of `GET /api/server-info` so clients can recover
   * the per-doc `lastDiskAckedSV` watermark on `__system__` reconnect
   * without relying on stateless CC1 broadcasts (which have no replay).
   * Empty `{}` is the cold-server case (no docs flushed yet); omitted
   * when the broadcaster isn't available (e.g. plugin mode in dev
   * server). Values are base64-encoded `Uint8Array` state vectors.
   */
  getDiskAckSVs?: () => Record<string, string>;
  contentRoot?: string;
  backlinkIndex?: BacklinkIndex;
  tagIndex?: TagIndex;
  signalChannel?: (channel: 'files' | 'backlinks' | 'graph') => void;
  /**
   * Optional. When present, agent write handlers publish per-write attribution
   * entries on `__system__` awareness (`agentFocus` map) with writeKind +
   * currentDoc — the signal that drives browser push-navigation to the doc the
   * agent just wrote. Distinct from `agentPresenceBroadcaster` below, which
   * publishes sustained session state.
   */
  agentFocusBroadcaster?: AgentFocusBroadcaster;
  /**
   * Optional. When present, agent write handlers publish presence entries on
   * `__system__` awareness (`agentPresence` map) so clients can render the
   * multi-agent presence bar and follow the active agent. Omit to disable
   * presence broadcasts entirely (e.g. in tests that don't care).
   */
  agentPresenceBroadcaster?: AgentPresenceBroadcaster;
  /**
   * Optional. Called after every successful agent write (write /
   * edit). The handler is expected to be cheap and idempotent —
   * the CLI uses it to open the browser on the first agent edit per session.
   */
  onAgentWrite?: () => void;
  /**
   * Getter for the active SyncEngine instance (may be null when dormant or if
   * no remote was detected). Called per-request so it always reflects current state.
   */
  getSyncEngine?: () => SyncEngine | null;
  /**
   * CLI argv prefix used to spawn subprocesses for /api/local-op/* relay endpoints.
   * Defaults to ['open-knowledge'] (assumes CLI is on PATH).
   * Pass [process.execPath, process.argv[1]] from the CLI start command to use
   * the exact runtime that started this server.
   *
   * Example: ['bun', '/path/to/packages/cli/src/cli.ts'] in dev,
   *          ['open-knowledge'] in production.
   */
  localOpCliArgs?: string[];
  /**
   * Path to the project's parent git working tree (i.e. the repo root, not
   * the shadow git dir). Used for upload tmp-file placement, git-relative
   * path resolution for managed renames (`renameTrackedPathInGit`), and the
   * managed-rename recovery journal (`withManagedRenameRecovery`).
   * Save-version and rollback do NOT mutate the parent git repo.
   */
  projectDir?: string;
  /**
   * Basename-index resolver for `![[photo.png]]` wiki-embed refs. Threaded
   * into every server-side `mdManager.parseWithFallback` call (managed-rename
   * body rewrite, rollback content apply) so the resulting PM image/link
   * carries the resolved src/href.
   */
  resolveEmbed?: (basename: string, sourcePath: string) => string | null;
  /**
   * Getter for the server's principal record. Called at request time so
   * deferred async init propagates. Returns null if principal has not
   * yet been loaded or loading failed.
   */
  getPrincipal?: () => Principal | null;
  /**
   * Override `os.homedir()` for global-scope skill resolution. Global
   * skills live at `<home>/.ok/skills/` and (when install lands) project into
   * `<home>/.{host}/skills/`. Defaults to `os.homedir()`; tests pass a tempdir
   * so global-scope writes don't touch the real user home.
   */
  homeDirOverride?: string;
  /**
   * Active ContentFilter (the same instance threaded into the file watcher).
   * When present, `POST /api/rename-path` rejects destinations excluded by
   * `.gitignore` / `.okignore` rules so renames cannot land outside the
   * watched scope. Omit in tests where admission checks aren't relevant.
   */
  contentFilter?: ContentFilter;
  /**
   * OS-scheme install probe used by `GET /api/installed-agents` (web-host
   * parity for the Electron `ok:shell:detect-protocol` IPC — see
   * `handoff-api.ts`). When omitted, the platform's default probe is used
   * (`osascript` / `reg query` / `xdg-mime`). Tests inject a deterministic
   * fake so the endpoint doesn't shell out.
   */
  installedAgentsProbe?: (scheme: InstalledAgentScheme) => Promise<boolean>;
  /**
   * Explicit document unload hook. `createServer()` suppresses Hocuspocus's
   * automatic unload-on-disconnect to avoid reload + IDB duplication, so API
   * paths that intentionally retire a document must opt into unload here.
   */
  forceUnloadDocument?: (document: Document) => Promise<void>;
  /**
   * Resolves when async server init (shadow repo, file watcher seed)
   * completes. `handleDocumentList` and any other handler whose response
   * depends on the watcher's in-memory file/folder index awaits this before
   * reading, so a renderer that connects before the seed walk finishes
   * does not see a false-empty `documents: []` response (and therefore the
   * "No files yet" / "Welcome to your LLM brain" cold-start flash). Optional
   * for unit tests that construct the extension directly without a server
   * factory wiring.
   */
  ready?: Promise<void>;
  /**
   * Per-process LRU cache shared with `removalRedirectGuard` in
   * `server-factory.ts`. Populated here at the rename-spine end and at
   * `handleDeletePath`; invalidated at `/api/create-page` after sync-write.
   * Optional so test harnesses that don't spin up the auth extension can
   * still construct the api-extension without ceremony.
   */
  recentlyRemovedDocs?: RecentlyRemovedDocs;
  /**
   * Closure-captured snapshot of `Y.Text('source').toString()` for a loaded
   * doc, returning `null` when the doc is not currently loaded server-side.
   * Threaded from `server-factory.ts` (where it lives alongside the bridge
   * + persistence wiring) so `handleSyncConflictContent` can serve the
   * `?source=ytext` override with the canonical
   * `prependFrontmatter(stripFrontmatter(ytext))` recompose. Optional —
   * when omitted, the `?source=ytext` branch falls back to `git show :2:`
   * so existing test harnesses without the closure keep working.
   */
  serializeDoc?: (docName: string) => string | null;
  /**
   * Evict a managed-artifact doc's last-known-good cache entry. Threaded from
   * `server-factory.ts` (where `persistence.managedArtifactCtx.lkgCache` lives).
   * Called on the document-teardown spine (`captureAndCloseDocuments`) so a
   * deleted skill/template is fully forgotten: the LKG cache is the verbatim
   * bytes last written to disk, and `storeManagedArtifactDoc` short-circuits a
   * write whose content equals the LKG. Without this eviction, a same-name
   * re-create that happens to author IDENTICAL bytes would be classed a no-op
   * and never re-land on disk (the deleted file stays gone). Optional — test
   * harnesses without the managed-artifact persistence ctx omit it; it is a
   * no-op for ordinary (non-managed) docs since they hold no LKG entry.
   */
  evictManagedArtifactLkg?: (docName: string) => void;
  /**
   * Semantic-search service. When present, enabled, and keyed, an opt-in
   * `POST /api/search` (`semantic: true`) fuses a vector signal into the
   * `full_text` ranking and the first such search lazily kicks off a background
   * corpus embed. Omitted in tests that don't exercise semantic search — its
   * absence is exactly the flag-OFF lexical path (byte-identical to baseline).
   */
  semanticSearch?: SemanticSearchService;
  /**
   * Resolve the project-local `search.semantic.similarityFloor` (the cosine noise
   * gate), read FRESH per search so a runtime config edit takes effect without a
   * restart — same fresh-read contract as the enable flag. Returns undefined when
   * unset, so core applies its model-calibrated default. Omitted in tests.
   */
  getSemanticSimilarityFloor?: () => number | undefined;
  /**
   * Absolute path of the embeddings secrets file (`~/.ok/secrets.yml`) — the
   * key-presence read in `/api/semantic-status` and the set/clear handlers write
   * here. Injectable so handler tests redirect it to a temp home; defaults to
   * the real path when omitted.
   */
  embeddingsSecretsFile?: string;
}

interface WorkspaceSearchCacheEntry {
  fingerprint: string;
  corpus?: WorkspaceSearchCorpus;
  /** Whether the name-only file tier hit `OK_SEARCH_MAX_ENTRIES` on this build. */
  truncated?: boolean;
  pending?: Promise<{ corpus: WorkspaceSearchCorpus; truncated: boolean }>;
}

const workspaceSearchCaches = new Map<string, WorkspaceSearchCacheEntry>();

/**
 * Extract all ATX headings (# … ######) from a Markdown document.
 * Frontmatter is stripped before scanning so `title:` YAML lines are ignored.
 */
export function extractHeadings(content: string): HeadingEntry[] {
  const { body } = stripFrontmatter(content);

  const headings: HeadingEntry[] = [];
  const slugCounts = new Map<string, number>();
  const isInCodeFence = createCodeFenceTracker();
  for (const line of body.split('\n')) {
    if (isInCodeFence(line)) continue;
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const text = match[2].trim();
      const slug = getHeadingSlug(text, slugCounts);
      if (slug) headings.push({ level: match[1].length, text, slug });
    }
  }
  return headings;
}

export function isSafeDocName(docName: string): boolean {
  return !(
    docName.includes('..') ||
    docName.startsWith('/') ||
    docName.includes('\x00') ||
    docName.includes('\\')
  );
}

/**
 * Default `mutateFileIndex` fallback: apply a DiskEvent to the live all-files
 * map. A pure write accessor — it mutates the map keyed by docName and never
 * reads or hands a `kind:'file'` entry to a markdown-assuming consumer, so it
 * is safe to authorize as an all-files call site. Production wires the
 * watcher's own generation-bumped mutator instead; this covers harnesses that
 * pass only the accessor closure. The default accessor is a markdown-only
 * snapshot, so the write must target the live backing map, not a throwaway.
 */
function applyDiskEventToLiveAllFilesIndex(
  event: DiskEvent,
  getAllFilesIndex: () => ReadonlyMap<string, FileIndexEntry>,
): void {
  const live = getAllFilesIndex();
  if (live instanceof Map) {
    updateFileIndex(event, live);
  }
}

export function createApiExtension(options: ApiExtensionOptions): Extension {
  const {
    hocuspocus,
    sessionManager,
    contentDir,
    serverInstanceId,
    getFileIndex,
    getAttachmentFolderPath,
    // Defaults to the markdown-only view when a caller (test harness) wires only
    // `getFileIndex`; production wires the real all-files accessor in server-factory.
    getAllFilesIndex = getFileIndex,
    // Production wires the watcher's generation-bumped mutator; this fallback
    // covers harnesses that pass only the accessor closure. The write must
    // target the live backing map (the default accessor is a markdown-only
    // snapshot) — see applyDiskEventToLiveAllFilesIndex.
    mutateFileIndex = (event: DiskEvent) =>
      applyDiskEventToLiveAllFilesIndex(event, getAllFilesIndex),
    getFileIndexGeneration,
    getFolderIndex,
    onReferencedAssetsCacheInvalidator,
    getAliasMap,
    getFolderAliasIndex,
    rescanFiles,
    enableTestRoutes = false,
    shadowRef,
    flushGitCommit,
    flushContributors,
    takeStoreFailure,
    takeStoreDivergence,
    markAgentWriteStore,
    getCurrentBranch,
    getDiskAckSVs,
    contentRoot,
    backlinkIndex,
    tagIndex,
    signalChannel,
    agentFocusBroadcaster,
    agentPresenceBroadcaster,
    onAgentWrite,
    getSyncEngine,
    localOpCliArgs = ['open-knowledge'],
    projectDir,
    getPrincipal,
    homeDirOverride,
    contentFilter,
    installedAgentsProbe,
    forceUnloadDocument,
    ready,
    recentlyRemovedDocs,
    serializeDoc,
    evictManagedArtifactLkg,
    semanticSearch,
    getSemanticSimilarityFloor,
    embeddingsSecretsFile,
    ephemeral = false,
  } = options;

  // Concurrency guard: at most 1 in-flight request per local-op endpoint
  const localOpGuard = createConcurrencyGuard();

  // Single-flight dedupe for `GET /api/documents?showAll=true`. Keyed per
  // server instance (NOT module-global — tests boot several servers in one
  // process) by request shape so concurrent identical walks share one
  // traversal and one sorted result. Entries evict on settle.
  const showAllInflight = new Map<string, InflightShowAllWalk>();

  // Single-flight dedupe for `GET /api/history`. Keyed by the
  // full normalized query tuple (mode + branch + every param each mode reads),
  // so N concurrent identical history requests share ONE git walk and N
  // identical responses. Per-server-instance, same rationale as showAllInflight.
  const historyInflight = createSingleFlight<Awaited<ReturnType<typeof getDocumentHistory>>>();
  let referencedAssetsCache: {
    signature: string;
    assets: ReturnType<typeof collectReferencedAssets>;
  } | null = null;

  function getMutableFolderIndex(): Map<string, FolderIndexEntry> | null {
    const index = getFolderIndex?.();
    return index instanceof Map ? (index as Map<string, FolderIndexEntry>) : null;
  }

  function upsertFolderIndexEntry(fullPath: string): void {
    const index = getMutableFolderIndex();
    if (!index) return;
    try {
      const folderStat = statSync(fullPath);
      upsertFolderIndexEntryInIndex(index, contentDir, fullPath, folderStat, fullPath);
    } catch (err) {
      console.warn(`[api-extension] folder index stat failed for ${fullPath}:`, err);
    }
  }

  function upsertFolderIndexPathSegments(path: string): void {
    const segments = path.split('/').filter(Boolean);
    for (let i = 1; i <= segments.length; i += 1) {
      upsertFolderIndexEntry(resolve(contentDir, segments.slice(0, i).join('/')));
    }
  }

  function removeFolderIndexEntries(path: string): void {
    const index = getMutableFolderIndex();
    if (!index) return;
    removeFolderIndexEntriesFromIndex(index, path);
  }

  function renameFolderIndexEntries(fromPath: string, toPath: string): void {
    const index = getMutableFolderIndex();
    if (!index) return;
    const renamed: Array<[string, FolderIndexEntry]> = [];
    for (const [folderPath, entry] of index.entries()) {
      if (folderPath !== fromPath && !folderPath.startsWith(`${fromPath}/`)) continue;
      index.delete(folderPath);
      const suffix = folderPath.slice(fromPath.length);
      renamed.push([`${toPath}${suffix}`, entry]);
    }
    if (renamed.length === 0) {
      const destinationPath = resolveContentEntryPath(contentDir, 'folder', toPath);
      if (existsSync(destinationPath)) upsertFolderIndexEntry(destinationPath);
      return;
    }
    for (const [folderPath, entry] of renamed) {
      index.set(folderPath, {
        ...entry,
        modified: new Date().toISOString(),
        canonicalPath: resolve(contentDir, folderPath),
      });
    }
  }

  function referencedAssetsSignature(index: ReadonlyMap<string, FileIndexEntry>): string {
    // File watcher entries use a wall-clock `modified` stamp on every event,
    // so this metadata signature still tracks content changes when mtime
    // granularity would otherwise miss a rapid edit.
    return [...index.entries()]
      .map(
        ([docName, entry]) =>
          `${docName}\0${entry.canonicalPath}\0${entry.size}\0${entry.modified}\0${entry.aliases.join('\0')}`,
      )
      .sort()
      .join('\n');
  }

  function invalidateReferencedAssetsCache(): void {
    referencedAssetsCache = null;
  }
  onReferencedAssetsCacheInvalidator?.(invalidateReferencedAssetsCache);

  // Per-scheme cache + in-flight dedup for GET /api/installed-agents.
  // Factory is called once per createApiExtension() so the cache lives for
  // the lifetime of the server (cleared on server restart).
  const installedAgentsCache = createInstalledAgentsProbe({
    probe: installedAgentsProbe ?? createOsProbe(process.platform),
  });

  // Disk path for a doc name. Managed-artifact docs (skills/templates) live
  // under `.ok/` outside the content tree, so they resolve through the
  // escape-guarded `managedArtifactAbsPath` (projectDir defaults to contentDir);
  // every other doc maps to `<contentDir>/<docName><ext>`. Returns null on a
  // malformed / escaping name so read callers fall back to the raw doc name.
  // This is the single docName→disk-path resolver — every reader (titles,
  // metadata, page-headings) routes through it so skills stay reachable.
  function resolveDocPath(docName: string): string | null {
    if (isManagedArtifactDocName(docName)) {
      try {
        return managedArtifactAbsPath(docName, {
          projectDir: projectDir ?? contentDir,
          homedirOverride: homeDirOverride,
        });
      } catch {
        return null;
      }
    }
    if (!isSafeDocName(docName)) return null;
    const resolvedContentDir = resolve(contentDir);
    const relPath = docNameToRelativePath(docName);
    const filePath = resolve(resolvedContentDir, relPath);
    if (!isWithinDir(filePath, resolvedContentDir)) {
      return null;
    }
    return filePath;
  }

  function readPageTitleForDocName(docName: string): string {
    const filePath = resolveDocPath(docName);
    if (!filePath || !existsSync(filePath)) return docName;
    try {
      return extractPageTitle(readFileSync(filePath, 'utf-8'), docName);
    } catch {
      return docName;
    }
  }

  /**
   * Admission-gated title read for link-graph endpoints (forward-links, hubs,
   * link-graph). Wiki-link targets are user-authored strings — a link in an
   * indexed doc may name a target that is itself excluded from the content
   * scope by `.gitignore` / `.okignore`. Reading the on-disk title for those
   * excluded targets would leak the title (a heading authored after the file
   * was excluded) through endpoints that are otherwise scoped to admitted
   * content. Fall back to the docName, matching the contract for missing
   * targets.
   */
  function readPageTitleForLinkedDocName(docName: string, admitted: Set<string>): string {
    if (!admitted.has(docName)) return docName;
    return readPageTitleForDocName(docName);
  }

  const EMPTY_METADATA: FrontmatterMetadata = {
    cluster: undefined,
    category: undefined,
    tags: undefined,
  };

  function readFrontmatterMetadataForDocName(docName: string): FrontmatterMetadata {
    try {
      const doc = hocuspocus.documents.get(docName);
      if (doc) {
        const map = readFmMap(doc.getText('source').toString());
        if (Object.keys(map).length > 0) {
          const cluster = typeof map.cluster === 'string' ? map.cluster : undefined;
          const category = typeof map.category === 'string' ? map.category : undefined;
          let tags: string[] | undefined;
          if (Array.isArray(map.tags)) {
            const stringTags = map.tags.filter(
              (entry): entry is string => typeof entry === 'string',
            );
            tags = stringTags.length > 0 ? stringTags : undefined;
          } else if (typeof map.tags === 'string' && map.tags) {
            tags = [map.tags];
          }
          return { cluster, category, tags };
        }
      }
    } catch {
      /* fall through to disk */
    }
    try {
      const filePath = resolveDocPath(docName);
      if (!filePath || !existsSync(filePath)) return EMPTY_METADATA;
      const content = readFileSync(filePath, 'utf-8');
      const { frontmatter } = stripFrontmatter(content);
      if (!frontmatter) return EMPTY_METADATA;
      return parseFrontmatterMetadata(frontmatter);
    } catch {
      return EMPTY_METADATA;
    }
  }

  /**
   * Admission-gated frontmatter read — pair to `readPageTitleForLinkedDocName`.
   * Link-graph nodes can include wiki-link targets that resolve to docs
   * excluded by `.gitignore` / `.okignore`; serving their cluster / category /
   * tags would leak frontmatter from outside the content scope.
   */
  function readFrontmatterMetadataForLinkedDocName(
    docName: string,
    admitted: Set<string>,
  ): FrontmatterMetadata {
    if (!admitted.has(docName)) return EMPTY_METADATA;
    return readFrontmatterMetadataForDocName(docName);
  }

  /**
   * Soft orphan-hint: when a written doc has zero backlinks AND a hub
   * candidate exists in its folder tree, attach a hint suggesting the hub.
   * Returns `undefined` when any prerequisite is unavailable (no
   * backlinkIndex wired, target not in index, has backlinks, or no candidate).
   * Non-throwing — a hint-computation failure must not fail the write.
   */
  function computeOrphanHints(
    docName: string,
  ): Array<{ type: 'orphan'; parentCandidates: string[]; message: string }> | undefined {
    if (!backlinkIndex) return undefined;
    try {
      const backlinks = backlinkIndex.getBacklinks(docName);
      if (backlinks.length > 0) return undefined;
      // This runs on every write — if hub-candidate walking becomes pathological
      // on very large file indexes, we want an observable signal. 5ms is well
      // above the typical <1ms cost for a small-to-medium repo.
      const start = performance.now();
      const candidates = findHubCandidates(docName, getFileIndex());
      const elapsed = performance.now() - start;
      if (elapsed > 5) {
        log.debug(
          { docName, elapsedMs: elapsed, candidateCount: candidates.length },
          '[orphan-hint] findHubCandidates slow',
        );
      }
      if (candidates.length === 0) return undefined;
      const wikiLinks = candidates.map((c) => `[[${c}]]`).join(', ');
      return [
        {
          type: 'orphan',
          parentCandidates: candidates,
          message: `This doc has no backlinks yet. To make it discoverable, consider linking from a parent hub doc (index/overview files in the folder tree): ${wikiLinks}.`,
        },
      ];
    } catch (err) {
      console.warn('[orphan-hint] computeOrphanHints failed:', err);
      return undefined;
    }
  }

  function resolveAlias(docName: string): string {
    return getAliasMap?.().get(docName) ?? docName;
  }

  /**
   * Return the number of live browser/editor connections currently subscribed
   * to the given Hocuspocus document. Zero means the agent is writing to a
   * room nobody is watching. Under the once-per-session preview-attach
   * contract, this is a per-doc diagnostic — the hint threshold is
   * `getSystemSubscriberCount()` (transport-presence on `__system__`).
   *
   * Never throws: a Hocuspocus introspection failure is silent (returns 0).
   */
  function getSubscriberCount(docName: string): number {
    try {
      const doc = hocuspocus.documents.get(docName);
      return doc?.connections.size ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Return the number of live connections to the `__system__` Y.Doc — the
   * shared awareness channel every editor tab subscribes to. Zero means no
   * editor is attached to this server anywhere; non-zero means at least one
   * tab is watching (and will follow agent writes via `AgentFocusBroadcaster`).
   *
   * This is the correct signal for the once-per-session preview-attach hint:
   * the per-doc count flips on every new doc even when the user's tab is open
   * and following, which would produce spurious "attach" hints.
   *
   * Never throws.
   */
  function getSystemSubscriberCount(): number {
    try {
      const doc = hocuspocus.documents.get(SYSTEM_DOC_NAME);
      return doc?.connections.size ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Fire-and-forget L1 → L2 flush for a single document.
   *
   * L1 (CRDT → disk): per-document debounce flush so concurrent human edits on
   * other documents are undisturbed.
   * L2 (disk → git): chained after L1 resolves to guarantee disk content is
   * up-to-date before the shadow-repo commit.
   *
   * The returned promise is intentionally not awaited by callers — the HTTP
   * response fires immediately after the CRDT transaction; persistence is
   * best-effort background work.
   */
  function flushDocToGit(docName: string, label: string): void {
    const debounceId = `onStoreDocument-${docName}`;
    const l1 = hocuspocus.debouncer.isDebounced(debounceId)
      ? hocuspocus.debouncer.executeNow(debounceId)
      : Promise.resolve();
    l1.then(() => flushGitCommit?.()).catch((err: unknown) => {
      log.warn({ err }, `[${label}] post-write flush failed`);
    });
  }

  /**
   * Force the debounced L1 disk store for `docName` to run now and await it,
   * then report whether it failed. Hocuspocus's `storeDocumentHooks` swallows
   * store errors (logs "stays in memory", keeps the doc in RAM), so
   * `executeNow`'s promise resolves even when the bytes never reached disk —
   * `takeStoreFailure` reads the failure the persistence layer recorded
   * out-of-band. Returns null when the store reached disk (or no failure
   * channel is wired). The caller surfaces a non-success response on a
   * non-null result so a write can never report success against a disk that
   * rejected it.
   */
  type FlushOutcome = { kind: 'failure'; failure: StoreFailure } | { kind: 'divergence' } | null;

  /**
   * Force-flush this doc's debounced store, then read the out-of-band outcome
   * channels so every awaited-flush handler can branch uniformly:
   *   - `failure`    — the atomic disk write threw (ENOSPC / EACCES / EROFS …);
   *     content stays in memory only. → `respondPersistenceFailure`.
   *   - `divergence` — the L3 backstop detected disk diverged from the reconciled
   *     base, aborted the overwrite, and ingested disk (disk won); the agent's
   *     edit was NOT applied. → `respondDiskDivergence`.
   *   - `null`       — the store reached disk.
   * The two non-null outcomes are mutually exclusive for one flush: L3 returns
   * before the atomic write, so a divergence revert never also records a failure.
   */
  async function flushDiskAndDetectOutcome(docName: string): Promise<FlushOutcome> {
    const debounceId = `onStoreDocument-${docName}`;
    if (hocuspocus.debouncer.isDebounced(debounceId)) {
      // Mark this as an agent-write-triggered store so the L3 backstop's gate
      // fires (Hocuspocus passes a null transaction origin for agent
      // DirectConnection writes, so the origin can't gate it). `storeDocumentNow`
      // read-and-clears the marker.
      markAgentWriteStore?.(docName);
      await hocuspocus.debouncer.executeNow(debounceId);
    }
    const failure = takeStoreFailure?.(docName) ?? null;
    if (failure) return { kind: 'failure', failure };
    if (takeStoreDivergence?.(docName)) return { kind: 'divergence' };
    return null;
  }

  /**
   * Map a recorded {@link StoreFailure} to a storage problem type + status and
   * emit it. Reuses the shared `classifyUploadErrno` / `uploadStatusFor` errno
   * table (ENOSPC/EDQUOT → 507 storage-full; EROFS/EACCES/EPERM → 500
   * storage-readonly; else → 500 storage-error) so the agent-write disk-failure
   * surface can never drift from the upload pipeline's mapping. The CRDT copy
   * stays in memory; the response reflects disk truth so the caller does not
   * record a false success.
   */
  function respondPersistenceFailure(
    res: ServerResponse,
    failure: StoreFailure,
    handler: string,
  ): void {
    const reason = classifyUploadErrno({ code: failure.code } as NodeJS.ErrnoException);
    errorResponse(
      res,
      uploadStatusFor(reason),
      reason,
      `Write applied in memory but failed to persist to disk (${failure.code ?? 'unknown error'}): ${failure.message}. The content was NOT saved and will be lost if the server restarts.`,
      { handler },
    );
  }

  /**
   * Emit the L3 disk-divergence error. 409 Conflict: the document
   * changed on disk after the agent's edit was prepared, so the store aborted the
   * overwrite (disk won) and the agent's edit was NOT applied. The agent should
   * re-read and retry — the edit was discarded, not double-applied, so a retry
   * re-applies exactly once via the L1 reconcile.
   */
  function respondDiskDivergence(res: ServerResponse, handler: string): void {
    errorResponse(
      res,
      409,
      'urn:ok:error:disk-divergence',
      'The document changed on disk after your edit was prepared; your edit was NOT applied, to avoid overwriting the newer on-disk content. Re-read the document and retry.',
      { handler },
    );
  }

  /**
   * Build the success-path `disk-edit-reconciled` warning when
   * L1 reconciled a divergent out-of-band disk edit before the agent's edit
   * landed on top. The write SUCCEEDED and both edits are on disk — this is the
   * observational nudge to re-read for the combined result. Returns undefined
   * when nothing was reconciled (the common no-divergence path). `intendedBytes`
   * = the base the agent thought it was editing; `actualBytes` = the divergent
   * disk content that was folded in; `byteDelta` = the divergence magnitude.
   */
  function buildReconcileWarning(
    reconcile: ReconcileBeforeWriteResult,
  ): DiskEditReconciledWarning | undefined {
    if (!reconcile.reconciled) return undefined;
    return {
      kind: 'disk-edit-reconciled',
      intendedBytes: reconcile.baseBytes,
      actualBytes: reconcile.diskBytes,
      byteDelta: reconcile.diskBytes - reconcile.baseBytes,
      ...(reconcile.mergeOutcome ? { mergeOutcome: reconcile.mergeOutcome } : {}),
      hint:
        reconcile.mergeOutcome === 'merged'
          ? 'An out-of-band edit was three-way merged into this document before your edit was applied on top; the merge may have interleaved content blocks. Re-read it (e.g. `exec("cat <path>")`) and review the combined result carefully before continuing.'
          : 'An out-of-band edit was reconciled into this document before your edit was applied on top; the document now reflects that edit plus yours. Re-read it (e.g. `exec("cat <path>")`) to see the combined result before continuing.',
    };
  }

  // Content-scope exclusion for a docName, mirroring the file-watcher's markdown
  // admission gate (`isExcluded`, the gitignore/okignore predicate it applies
  // before indexing a file). Used to keep the backlink-graph union and the
  // write-path file-index registration content-scope-symmetric with the watcher
  // (precedent #55): a doc the watcher would refuse to index must not slip into
  // the admitted set by another door, or its on-disk title/frontmatter leaks
  // through the link/title endpoints. String-only (no realpath/symlink syscalls
  // — this runs per forward-key on a hot path); the extension mirrors
  // `resolveContentEntryPath`'s `docNameToRelativePath` default so `.md`/`.mdx`
  // ignore patterns match. A managed-artifact docName lives outside contentDir
  // and is admitted separately, so a wrong relPath here only ever fails open
  // (admit).
  function isDocNameContentExcluded(docName: string): boolean {
    if (!contentFilter) return false;
    const relPath = docNameToRelativePath(docName);
    return contentFilter.isExcluded(relPath);
  }

  function collectAdmittedDocNames(): Set<string> {
    const admitted = new Set<string>();
    for (const [docName, entry] of getFileIndex()) {
      admitted.add(docName);
      for (const alias of entry.aliases) {
        admitted.add(alias);
      }
    }
    // Managed-artifact docs (skills/templates) are link-axis participants — a
    // doc that links to one must resolve it as a known doc (title, not a dead
    // link rendered as the raw `__skill__/...` name). They live outside
    // getFileIndex() (tree-excluded), so enumerate them from disk here. The
    // names match what the backlink index normalizes link targets to via
    // `managedArtifactDocNameFromContentTarget`. Best-effort: a scan failure
    // just narrows the set, it never fails the link endpoint.
    try {
      for (const scope of ['project', 'global'] as const) {
        const skillsRoot =
          scope === 'global'
            ? resolve(skillsHome, '.ok', 'skills')
            : resolve(contentDir, '.ok', 'skills');
        for (const skill of resolveSkillsList(skillsRoot, scope).skills) {
          admitted.add(`${MANAGED_ARTIFACT_PREFIX_SKILL}${scope}/${skill.name}`);
        }
      }
      for (const tpl of resolveProjectTemplates(resolve(contentDir)).templates) {
        admitted.add(templateDocNameFor(tpl.source_folder, tpl.name));
      }
    } catch (err) {
      log.warn({ err }, '[collectAdmittedDocNames] managed-artifact enumeration failed');
    }
    // Union the backlink graph's indexed-doc set, the additive second existence
    // oracle. `getFileIndex()` is the async file-watcher's view and lags (or
    // permanently drops a create FSEvent for a file written into a freshly-made
    // subdir — see file-watcher.ts). `state.forward` is updated in-process by
    // onStoreDocument, so a just-persisted doc lands here immediately. Without
    // this union the link/title consumers disagree with the dead-link endpoint,
    // which already folds in this same set (BacklinkIndex.getDeadLinks). The
    // content-scope gate keeps it symmetric with the watcher: a forward node that
    // is gitignore/okignore-excluded (e.g. an agent wrote to an excluded path,
    // which the graph indexes but the watcher won't) must NOT become admitted, or
    // its title/frontmatter would leak through the link/title endpoints. Already-
    // admitted names (file index, managed artifacts) skip the gate — cheap and
    // they're known in-scope.
    for (const docName of backlinkIndex?.getIndexedDocNames() ?? []) {
      if (admitted.has(docName)) continue;
      if (!isDocNameContentExcluded(docName)) admitted.add(docName);
    }
    return admitted;
  }

  // On-disk existence oracle for non-doc outbound link targets (linked assets
  // and source files) used by `computeBrokenOutboundLinks`. Doc links resolve
  // against the admitted set above; file links have no CRDT presence, so a
  // just-written `[x](../src/foo.py)` is validated against the filesystem. The
  // path is already content-root-confined by `resolveAssetProjectPath`, so
  // `resolve(contentDir, …)` cannot escape the tree.
  const linkedFileExists = (contentRootRelativePath: string): boolean =>
    existsSync(resolve(contentDir, contentRootRelativePath));

  // Synchronously register a just-persisted agent-write doc into the file index,
  // mirroring `/api/create-page`. The file-watcher normally adds it on the next
  // FSEvent, but @parcel/watcher can permanently drop the create event for a
  // file written into a freshly-created subdir — the recursive inotify subwatch
  // is registered async after the directory's IN_CREATE, so a rapid follow-up
  // write races the registration and its event is lost (see file-watcher.ts).
  // The doc then stays missing from the file index until a restart re-seeds from
  // disk. `updateFileIndex` is an idempotent upsert keyed by docName, so a later
  // watcher event for the same file just re-sets the same entry. Best-effort and
  // post-write: the CRDT copy already exists regardless of the file index.
  //
  // Mirrors the watcher's admission gate (precedent #55): a content-scope-excluded
  // doc (the write handlers don't reject those — they only block reserved system/
  // config names) must NOT be registered, exactly as the watcher would skip it.
  // Otherwise an agent write to a gitignore/okignore'd path would leak its title
  // through the admitted set the link/title endpoints read.
  function registerWrittenDocInFileIndex(docName: string, content: string): void {
    if (isDocNameContentExcluded(docName)) return;
    mutateFileIndex?.({
      kind: getFileIndex().has(docName) ? 'update' : 'create',
      path: resolveContentEntryPath(contentDir, 'file', docName),
      docName,
      content,
    });
  }

  function createSerializedRunner() {
    let pending = Promise.resolve();
    return async function runSerialized<T>(task: () => Promise<T>): Promise<T> {
      const waitFor = pending;
      let release = () => {};
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await waitFor;
      try {
        return await task();
      } finally {
        release();
      }
    };
  }

  // Managed rename mutates overlapping backlink sets across many docs, so serialize it.
  const runSerialized = createSerializedRunner();

  // RFC 9457 title convention — every `errorResponse(...)` site in this file
  // ends its title with a period. Error class messages are declarative
  // fragments without trailing punctuation; this helper sentence-shapes them
  // before they reach `errorResponse()`. Used by `toManagedRenamePublicError`
  // (rename/rollback common branches) AND directly at the
  // `ManagedRenameCollisionError` catch site (which can't go through that
  // helper because it carries the `colliding` extension payload).
  const withPeriod = (s: string): string => (s.endsWith('.') ? s : `${s}.`);

  function toManagedRenamePublicError(error: unknown): {
    status: HttpErrorStatus;
    type: ProblemType;
    error: string;
  } {
    if (!(error instanceof Error)) {
      return {
        status: 500,
        type: 'urn:ok:error:internal-server-error',
        error: 'Failed to rename document.',
      };
    }
    if (error instanceof ManagedRenameSourceNotFoundError) {
      return { status: 404, type: 'urn:ok:error:doc-not-found', error: withPeriod(error.message) };
    }
    if (error instanceof ManagedRenameDestinationExistsError) {
      return {
        status: 409,
        type: 'urn:ok:error:doc-already-exists',
        error: withPeriod(error.message),
      };
    }
    if (error instanceof ManagedRenameSourceTypeMismatchError) {
      return {
        status: 400,
        type: 'urn:ok:error:invalid-request',
        error: withPeriod(error.message),
      };
    }
    if (error instanceof ManagedRenameInvalidRequestError) {
      return {
        status: 400,
        type: 'urn:ok:error:invalid-request',
        error: withPeriod(error.message),
      };
    }
    if (error instanceof ManagedRenameReservedPathError) {
      return {
        status: 400,
        type: 'urn:ok:error:reserved-doc-name',
        error: withPeriod(error.message),
      };
    }
    if (error instanceof ManagedRenameMissingDocumentError) {
      return { status: 404, type: 'urn:ok:error:doc-not-found', error: withPeriod(error.message) };
    }
    if (error instanceof ManagedRenameSnapshotMissingError) {
      return { status: 404, type: 'urn:ok:error:doc-not-found', error: withPeriod(error.message) };
    }
    if (error instanceof SymlinkEscapeError) {
      return { status: 400, type: 'urn:ok:error:path-escape', error: withPeriod(error.message) };
    }
    if (error instanceof BacklinkIndexRequiredError) {
      return {
        status: 503,
        type: 'urn:ok:error:backlink-index-not-configured',
        error: withPeriod(error.message),
      };
    }
    return {
      status: 500,
      type: 'urn:ok:error:internal-server-error',
      error: 'Failed to rename document.',
    };
  }

  async function captureAndCloseDocuments(
    docNames: string[],
    lifecycleStatus: 'deleted-upstream' | 'renamed',
  ): Promise<Map<string, string>> {
    const liveContents = new Map<string, string>();

    for (const docName of docNames) {
      const document = hocuspocus.documents.get(docName);
      if (document) {
        liveContents.set(docName, document.getText('source').toString());
      }
    }

    // Mark every loaded doc as no-longer-tracking-disk BEFORE any teardown.
    // Ordering is load-bearing: closing a doc's last connection makes
    // Hocuspocus force-flush a pending debounced store (and unload never
    // cancels an armed debounce timer, nor does the delete purge
    // deferred-store or straggler agent-session stores) — each of those
    // late stores serializes the still-populated Y.Doc and rewrites the
    // path this teardown is about to remove. `storeDocumentNow`'s
    // lifecycle guard skips them all once the marker is set; the raw
    // Y.Map set (no transact) mirrors the watcher reconcile's sibling
    // convention in server-factory.ts.
    for (const docName of docNames) {
      const document = hocuspocus.documents.get(docName);
      if (!document) continue;
      document.getMap('lifecycle').set('status', lifecycleStatus);
    }

    for (const docName of docNames) {
      await sessionManager.closeAllForDoc(docName).catch((err) => {
        console.warn(`[file-ops] Failed to close agent session for ${docName}:`, err);
      });
    }

    for (const docName of docNames) {
      const document = hocuspocus.documents.get(docName);
      deleteReconciledBase(docName);
      // Forget the managed-artifact LKG too (no-op for ordinary docs). The LKG
      // is the verbatim bytes last persisted; leaving it set lets an identical-
      // content re-create after a delete be classed a no-op and never re-land on
      // disk. Evicting here keeps it symmetric with reconciledBase eviction.
      evictManagedArtifactLkg?.(docName);
      if (!document) continue;
      hocuspocus.closeConnections(docName);
      await (forceUnloadDocument ?? hocuspocus.unloadDocument.bind(hocuspocus))(document);
    }

    return liveContents;
  }

  function syncRenamedDocsToDisk(
    renamed: RenamedDocMapping[],
    liveContents: ReadonlyMap<string, string>,
  ): void {
    for (const { fromDocName, toDocName } of renamed) {
      const filePath = safeContentPath(toDocName, contentDir);
      const liveContent = liveContents.get(fromDocName);
      if (typeof liveContent === 'string') {
        // Skip the write when the move already placed the correct bytes.
        writeFileIfContentDiffers(filePath, liveContent);
      }

      const finalContent =
        typeof liveContent === 'string'
          ? liveContent
          : existsSync(filePath)
            ? readFileSync(filePath, 'utf-8')
            : null;

      if (typeof finalContent === 'string') {
        registerWrite(filePath, contentHash(finalContent));
      }
    }
  }

  function buildManagedRenameSnapshots(
    docNames: string[],
    liveContents: ReadonlyMap<string, string>,
  ): ManagedRenameSnapshot[] {
    return docNames.map((docName) => {
      const liveContent = liveContents.get(docName);
      if (typeof liveContent === 'string') {
        return { docName, content: liveContent };
      }

      const filePath = safeContentPath(docName, contentDir);
      if (!existsSync(filePath)) {
        throw new ManagedRenameSnapshotMissingError(docName);
      }

      return {
        docName,
        content: readFileSync(filePath, 'utf-8'),
      };
    });
  }

  function readCurrentDocumentContent(docName: string): string | null {
    const document = hocuspocus.documents.get(docName);
    if (document) {
      return document.getText('source').toString();
    }

    const filePath = resolveContentEntryPath(contentDir, 'file', docName);
    if (!existsSync(filePath)) {
      return null;
    }
    return readFileSync(filePath, 'utf-8');
  }

  function writeManagedRenameDocumentToDisk(docName: string, markdown: string): void {
    const filePath = resolveContentEntryPath(contentDir, 'file', docName);
    tracedMkdirSync(dirname(filePath), { recursive: true });
    writeFileIfContentDiffers(filePath, markdown);
    registerWrite(filePath, contentHash(markdown));
    setReconciledBase(docName, markdown);

    mutateFileIndex?.({ kind: 'update', path: filePath, docName, content: markdown });
  }

  function applyManagedRenameMapToLoadedDocument(
    docName: string,
    renameMap: ReadonlyMap<string, string>,
    renamedAssets: readonly RenamedAssetMapping[] = [],
  ): ManagedRenameRewriteSummary {
    const document = hocuspocus.documents.get(docName);
    if (!document) {
      throw new Error(`Document is not loaded: ${docName}`);
    }

    let result: ManagedRenameRewriteSummary = { markdown: '', rewrites: 0 };
    document.transact(() => {
      const ytext = document.getText('source');
      result = applyRenameAndAssetReferenceRewrites(
        ytext.toString(),
        docName,
        renameMap.get(docName) ?? docName,
        renameMap,
        renamedAssets,
      );
      if (result.rewrites === 0) {
        return;
      }
      composeAndWriteRawBody(document, result.markdown, 'managed-rename', false);
    }, MANAGED_RENAME_ORIGIN);
    return result;
  }

  function rewriteAssetReferencesForMappings(
    markdown: string,
    docName: string,
    renamedAssets: readonly RenamedAssetMapping[],
  ): ManagedRenameRewriteSummary {
    let nextMarkdown = markdown;
    let rewrites = 0;
    for (const { fromPath, toPath } of renamedAssets) {
      const rewritten = rewriteAssetReferencesForRename(nextMarkdown, docName, fromPath, toPath);
      nextMarkdown = rewritten.markdown;
      rewrites += rewritten.rewrites;
    }
    return { markdown: nextMarkdown, rewrites };
  }

  function applyRenameAndAssetReferenceRewrites(
    markdown: string,
    currentDocName: string,
    rewrittenDocName: string,
    renameMap: ReadonlyMap<string, string>,
    renamedAssets: readonly RenamedAssetMapping[],
  ): ManagedRenameRewriteSummary {
    const docRename = applyRenameMap(markdown, currentDocName, renameMap);
    const assetRename = rewriteAssetReferencesForMappings(
      docRename.markdown,
      rewrittenDocName,
      renamedAssets,
    );
    return {
      markdown: assetRename.markdown,
      rewrites: assetRename.markdown === markdown ? 0 : docRename.rewrites + assetRename.rewrites,
    };
  }

  function applyAssetRenamesToLoadedDocument(
    docName: string,
    renamedAssets: readonly RenamedAssetMapping[],
  ): ManagedRenameRewriteSummary {
    const document = hocuspocus.documents.get(docName);
    if (!document) {
      throw new Error(`Document is not loaded: ${docName}`);
    }

    let result: ManagedRenameRewriteSummary = { markdown: '', rewrites: 0 };
    document.transact(() => {
      const ytext = document.getText('source');
      result = rewriteAssetReferencesForMappings(ytext.toString(), docName, renamedAssets);
      if (result.rewrites === 0) {
        return;
      }
      composeAndWriteRawBody(document, result.markdown, 'managed-rename', false);
    }, MANAGED_RENAME_ORIGIN);
    return result;
  }

  function collectAssetReferenceRewritesForMappings(
    renamedAssets: readonly RenamedAssetMapping[],
  ): Array<{ docName: string; markdown: string; rewrites: number }> {
    const rewrites: Array<{ docName: string; markdown: string; rewrites: number }> = [];
    if (renamedAssets.length === 0) return rewrites;
    const docNames = [...getFileIndex().keys()].sort((a, b) => a.localeCompare(b));
    for (const docName of docNames) {
      const content = readCurrentDocumentContent(docName);
      if (typeof content !== 'string') continue;
      const rewritten = rewriteAssetReferencesForMappings(content, docName, renamedAssets);
      if (rewritten.rewrites === 0) continue;
      rewrites.push({ docName, markdown: rewritten.markdown, rewrites: rewritten.rewrites });
    }
    return rewrites;
  }

  function assertRewriteTargetsNotConflicted(docNames: Iterable<string>): void {
    const renameEngine = getSyncEngine?.();
    const renameTrackedFiles = new Set(
      renameEngine ? renameEngine.getConflicts().map((c) => c.file) : [],
    );
    for (const docName of docNames) {
      const doc = hocuspocus.documents.get(docName);
      const filePath = docNameToRelativePath(docName);
      const conflictedByLifecycle = doc !== undefined && isDocInConflict(doc);
      const conflictedByStore = renameTrackedFiles.has(filePath);
      if (conflictedByLifecycle || conflictedByStore) {
        throw new DocInConflictError({ file: filePath });
      }
    }
  }

  function applyPendingAssetReferenceRewrites(
    pendingRewrites: readonly { docName: string; markdown: string; rewrites: number }[],
    renamedAssets: readonly RenamedAssetMapping[],
  ): ManagedRenameRewrittenDoc[] {
    const rewrittenDocs: ManagedRenameRewrittenDoc[] = [];
    for (const pending of pendingRewrites) {
      const document = hocuspocus.documents.get(pending.docName);
      const rewritten = document
        ? applyAssetRenamesToLoadedDocument(pending.docName, renamedAssets)
        : pending;
      if (rewritten.rewrites === 0) continue;
      writeManagedRenameDocumentToDisk(pending.docName, rewritten.markdown);
      backlinkIndex?.updateDocumentFromMarkdown(pending.docName, rewritten.markdown);
      rewrittenDocs.push({ docName: pending.docName, rewrites: rewritten.rewrites });
    }
    return rewrittenDocs;
  }

  function resolveExtensionlessAssetPath(assetPath: string): {
    path: string;
    ambiguous: boolean;
  } {
    // Filesystem-backed authority for extensionless asset targets; the client
    // canonicalizer is only a UX aid for dialogs and shell-trash paths.
    if (extname(assetPath)) return { path: assetPath, ambiguous: false };

    const slash = assetPath.lastIndexOf('/');
    const parent = slash === -1 ? '' : assetPath.slice(0, slash);
    const stem = slash === -1 ? assetPath : assetPath.slice(slash + 1);
    const parentPath = parent ? resolveContentEntryPath(contentDir, 'folder', parent) : contentDir;

    let entries: Dirent[];
    try {
      entries = readdirSync(parentPath, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { path: assetPath, ambiguous: false };
      }
      throw err;
    }

    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${stem}.`))
      .map((entry) => (parent ? `${parent}/${entry.name}` : entry.name))
      .filter((candidate) => isSupportedAssetFile(candidate, LINKABLE_ASSET_EXTENSIONS));

    if (candidates.length === 1) return { path: candidates[0], ambiguous: false };
    return { path: assetPath, ambiguous: candidates.length > 1 };
  }

  /**
   * Enumerate the managed docNames physically present under a folder by
   * walking disk, NOT the in-memory file index. The file index is populated
   * asynchronously by the chokidar watcher and lags on-disk truth right after
   * a `write` create — so folder rename used to see an empty index,
   * report `renamed: []`, skip inbound-link rewriting, and still move the
   * directory (orphaning every link into it). Disk is the authoritative
   * source for what the folder move carries; this matches how single-doc
   * rename trusts the caller's path rather than the index.
   *
   * Side effect: registers each doc's on-disk extension via
   * `registerDocExtension` (same as the watcher's `add` handler). Without it,
   * a `.mdx` doc the index never registered would resolve through
   * `getDocExtension`'s `.md` default — `readCurrentDocumentContent` would read
   * a non-existent `.md` path and the spine would throw
   * `ManagedRenameMissingDocumentError`, or a link rewrite would write a `.md`
   * sibling of the moved `.mdx` (split-brain).
   */
  function listManagedDocNamesUnderFolderFromDisk(sourcePathRoot: string): string[] {
    const docNames: string[] = [];
    // A file at the folder path (e.g. `kind: 'folder'` on a doc) must NOT reach
    // `readdirSync` — that throws ENOTDIR and 500s. Return empty for that and a
    // TOCTOU vanish (ENOENT) so the caller's type-mismatch / not-found check
    // emits the correct 4xx. Any other stat error (EACCES, EIO, ELOOP) means
    // the folder exists but is unreadable: returning empty there would move the
    // directory and skip link rewriting — the exact bug this fix addresses — so
    // rethrow and let it surface as a 500.
    try {
      if (!statSync(sourcePathRoot).isDirectory()) return docNames;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return docNames;
      throw err;
    }

    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = resolve(dir, entry.name);
        const relPath = relative(contentDir, fullPath).split(sep).join('/');
        if (isReservedProjectStatePath(relPath)) continue;
        if (entry.isDirectory()) {
          if (contentFilter?.isDirExcluded(relPath)) continue;
          walk(fullPath);
          continue;
        }
        if (!entry.isFile() || !isSupportedDocFile(relPath) || contentFilter?.isExcluded(relPath)) {
          continue;
        }
        const docName = docNameForFileOperationPath(contentDir, relPath);
        registerDocExtension(stripDocExtension(relPath), extname(relPath));
        docNames.push(docName);
      }
    }

    walk(sourcePathRoot);
    docNames.sort((a, b) => a.localeCompare(b));
    return docNames;
  }

  function listRenamedAssetsForFolderMove(
    sourcePathRoot: string,
    fromPath: string,
    toPath: string,
  ): RenamedAssetMapping[] {
    const renamedAssets: RenamedAssetMapping[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = resolve(dir, entry.name);
        const relPath = relative(contentDir, fullPath).split(sep).join('/');
        if (isReservedProjectStatePath(relPath)) continue;
        if (entry.isDirectory()) {
          if (contentFilter?.isDirExcluded(relPath)) continue;
          walk(fullPath);
          continue;
        }
        if (!entry.isFile() || isSupportedDocFile(relPath) || contentFilter?.isExcluded(relPath)) {
          continue;
        }
        if (relPath === fromPath) {
          renamedAssets.push({ fromPath: relPath, toPath });
        } else if (relPath.startsWith(`${fromPath}/`)) {
          renamedAssets.push({
            fromPath: relPath,
            toPath: `${toPath}${relPath.slice(fromPath.length)}`,
          });
        }
      }
    }

    walk(sourcePathRoot);
    renamedAssets.sort((a, b) => a.fromPath.localeCompare(b.fromPath));
    return renamedAssets;
  }

  async function _performAssetRename(
    fromPath: string,
    toPath: string,
  ): Promise<{ renamedAssets: RenamedAssetMapping[]; rewrittenDocs: ManagedRenameRewrittenDoc[] }> {
    return runSerialized(async () =>
      withSpan(
        'rename.executeAssetRewrites',
        {
          attributes: {
            'rename.kind': 'asset',
          },
        },
        async (span) => {
          if (!backlinkIndex) {
            throw new BacklinkIndexRequiredError();
          }
          const destinationAssetPath = extname(toPath) ? toPath : `${toPath}${extname(fromPath)}`;
          if (
            isReservedProjectStatePath(fromPath) ||
            isReservedProjectStatePath(destinationAssetPath)
          ) {
            throw new ManagedRenameReservedPathError('.ok and .git are reserved directories.');
          }
          if (contentFilter?.isPathIgnored(destinationAssetPath)) {
            throw new ManagedRenameInvalidRequestError(
              'Destination asset is excluded by the project content config.',
            );
          }

          const sourcePath = resolveContentEntryPath(contentDir, 'folder', fromPath);
          const destinationPath = resolveContentEntryPath(
            contentDir,
            'folder',
            destinationAssetPath,
          );
          if (sourcePath === destinationPath) {
            return { renamedAssets: [], rewrittenDocs: [] };
          }
          if (stringsDifferOnlyByCase(fromPath, destinationAssetPath)) {
            throw new ManagedRenameInvalidRequestError('Case-only renames are not supported.');
          }
          if (!existsSync(sourcePath)) {
            throw new ManagedRenameSourceNotFoundError('asset', 'Asset does not exist.');
          }
          if (existsSync(destinationPath)) {
            throw new ManagedRenameDestinationExistsError();
          }
          const sourceStat = statSync(sourcePath);
          if (!sourceStat.isFile()) {
            throw new ManagedRenameSourceTypeMismatchError(
              'asset',
              'Source path is not an asset file.',
            );
          }

          const renamedAssets = [{ fromPath, toPath: destinationAssetPath }];
          const pendingRewrites = collectAssetReferenceRewritesForMappings(renamedAssets);
          span.setAttribute('rename.rewrite_candidates', pendingRewrites.length);

          assertRewriteTargetsNotConflicted(pendingRewrites.map((entry) => entry.docName));

          const renamedWithGit = await renameTrackedPathInGit(
            projectDir,
            sourcePath,
            destinationPath,
          );
          if (!renamedWithGit) {
            renamePathOnDisk(sourcePath, destinationPath);
          }

          const rewrittenDocs = applyPendingAssetReferenceRewrites(pendingRewrites, renamedAssets);

          void backlinkIndex.saveToDisk().catch((err) => {
            console.warn(
              `[backlinks] Failed to persist asset rename cache for ${fromPath} -> ${destinationAssetPath}:`,
              err,
            );
          });
          signalChannel?.('files');
          if (rewrittenDocs.length > 0) {
            signalChannel?.('backlinks');
            signalChannel?.('graph');
          }

          rewrittenDocs.sort((a, b) => a.docName.localeCompare(b.docName));
          span.setAttribute('rename.rewrite_count', rewrittenDocs.length);
          return {
            renamedAssets,
            rewrittenDocs,
          };
        },
      ),
    );
  }

  async function _performDocumentToFileRename(
    fromPath: string,
    toPath: string,
  ): Promise<{ renamedAssets: RenamedAssetMapping[]; rewrittenDocs: ManagedRenameRewrittenDoc[] }> {
    return runSerialized(async () =>
      withSpan(
        'rename.executeDocumentToFileRewrites',
        {
          attributes: {
            'rename.kind': 'asset',
            'rename.transition': 'document-to-file',
          },
        },
        async (span) => {
          if (!backlinkIndex) {
            throw new BacklinkIndexRequiredError();
          }
          if (!isSupportedDocFile(fromPath) || isSupportedDocFile(toPath)) {
            throw new ManagedRenameInvalidRequestError(
              'Document-to-file rename requires a markdown source and non-markdown destination.',
            );
          }
          const sourceDocName = stripDocExtension(fromPath);
          if (isSystemDoc(sourceDocName) || isConfigDoc(sourceDocName)) {
            throw new ManagedRenameReservedPathError('Reserved document names cannot be renamed.');
          }
          if (isReservedProjectStatePath(fromPath) || isReservedProjectStatePath(toPath)) {
            throw new ManagedRenameReservedPathError('.ok and .git are reserved directories.');
          }
          if (contentFilter?.isPathIgnored(toPath)) {
            throw new ManagedRenameInvalidRequestError(
              'Destination file is excluded by the project content config.',
            );
          }

          const sourcePath = resolveContentEntryPath(contentDir, 'folder', fromPath);
          const destinationPath = resolveContentEntryPath(contentDir, 'folder', toPath);
          if (sourcePath === destinationPath) {
            return { renamedAssets: [], rewrittenDocs: [] };
          }
          if (stringsDifferOnlyByCase(fromPath, toPath)) {
            throw new ManagedRenameInvalidRequestError('Case-only renames are not supported.');
          }
          if (!existsSync(sourcePath)) {
            throw new ManagedRenameSourceNotFoundError('file');
          }
          if (existsSync(destinationPath)) {
            throw new ManagedRenameDestinationExistsError();
          }
          const sourceStat = statSync(sourcePath);
          if (!sourceStat.isFile()) {
            throw new ManagedRenameSourceTypeMismatchError(
              'file',
              'Source path is not a document file.',
            );
          }

          const renameEngine = getSyncEngine?.();
          const trackedFiles = new Set(
            renameEngine ? renameEngine.getConflicts().map((c) => c.file) : [],
          );
          const sourceDoc = hocuspocus.documents.get(sourceDocName);
          if (
            (sourceDoc !== undefined && isDocInConflict(sourceDoc)) ||
            trackedFiles.has(fromPath)
          ) {
            throw new DocInConflictError({ file: fromPath });
          }

          const renamedAssets = [{ fromPath, toPath }];
          const pendingRewrites = collectAssetReferenceRewritesForMappings(renamedAssets).filter(
            (entry) => entry.docName !== sourceDocName,
          );
          span.setAttribute('rename.rewrite_candidates', pendingRewrites.length);
          assertRewriteTargetsNotConflicted(pendingRewrites.map((entry) => entry.docName));

          reconcileDiskBeforeAgentWrite(hocuspocus, sourceDocName, contentDir);
          if (recentlyRemovedDocs && !isSystemDoc(sourceDocName) && !isConfigDoc(sourceDocName)) {
            recentlyRemovedDocs.setDeleted(sourceDocName);
          }
          const liveContents = await captureAndCloseDocuments([sourceDocName], 'renamed');
          const liveContent = liveContents.get(sourceDocName);
          const sourceContent =
            typeof liveContent === 'string' ? liveContent : readFileSync(sourcePath, 'utf-8');
          const recoveryJournal = createManagedRenameRecoveryJournal({
            fromPath,
            toPath,
            affectedDocs: [{ from: sourceDocName, to: sourceDocName }],
            snapshots: [{ docName: sourceDocName, content: sourceContent }],
            cleanupPaths: [toPath],
          });
          let rewrittenDocs: ManagedRenameRewrittenDoc[] = [];
          await withManagedRenameRecovery(projectDir ?? contentDir, recoveryJournal, async () => {
            writeFileIfContentDiffers(sourcePath, sourceContent);
            registerWrite(sourcePath, contentHash(sourceContent));

            const renamedWithGit = await renameTrackedPathInGit(
              projectDir,
              sourcePath,
              destinationPath,
            );
            if (!renamedWithGit) {
              renamePathOnDisk(sourcePath, destinationPath);
            }

            backlinkIndex.deleteDocument(sourceDocName);
            forgetDocExtension(sourceDocName);
            mutateFileIndex?.({ kind: 'delete', path: sourcePath, docName: sourceDocName });
            const destinationStat = statSync(destinationPath);
            mutateFileIndex?.({
              kind: 'file-create',
              path: destinationPath,
              relativePath: toPath,
              size: destinationStat.size,
              modifiedTs: destinationStat.mtimeMs,
              inode: destinationStat.ino,
            });

            rewrittenDocs = applyPendingAssetReferenceRewrites(pendingRewrites, renamedAssets);

            void backlinkIndex.saveToDisk().catch((err) => {
              console.warn(
                `[backlinks] Failed to persist document-to-file rename cache for ${fromPath} -> ${toPath}:`,
                err,
              );
            });
            signalChannel?.('files');
            if (rewrittenDocs.length > 0) {
              signalChannel?.('backlinks');
              signalChannel?.('graph');
            }
          });

          rewrittenDocs.sort((a, b) => a.docName.localeCompare(b.docName));
          span.setAttribute('rename.rewrite_count', rewrittenDocs.length);
          return { renamedAssets, rewrittenDocs };
        },
      ),
    );
  }

  async function _performManagedRenameForDocs(
    fromPath: string,
    toPath: string,
    kind: ContentEntryKind,
    options?: {
      actor?: {
        writerId: string;
        displayName: string;
        colorSeed?: string;
        actorMetadata?: {
          principalId?: string;
          agentType?: string;
          clientName?: string;
          clientVersion?: string;
          label?: string;
        };
      };
    },
  ): Promise<{
    renamed: RenamedDocMapping[];
    renamedAssets: RenamedAssetMapping[];
    rewrittenDocs: ManagedRenameRewrittenDoc[];
  }> {
    return runSerialized(async () =>
      withSpan(
        'rename.executeRewrites',
        {
          attributes: {
            'rename.kind': kind,
          },
        },
        async (span) => {
          if (!backlinkIndex) {
            throw new BacklinkIndexRequiredError();
          }

          // Existence + stat + affected-doc enumeration all live inside the
          // serialized critical section so a concurrent file watcher event
          // (external mv add) or in-flight write to the source folder cannot
          // land between enumeration and the disk move and produce a "ghost"
          // file that the recovery journal doesn't know about. POSIX
          // rename(2) does not fail-loud on overwrite, so the lock is the
          // only backstop against silent data loss.
          const sourcePathRoot = resolveContentEntryPath(contentDir, kind, fromPath);
          const destinationPathRoot = resolveContentEntryPath(contentDir, kind, toPath);
          // Handles the case where the client sends an explicit extension that
          // matches the source's existing one (e.g. `toPath: "foo.md"` when
          // the file is already `foo.md`) — `fromPath !== toPath` textually
          // but the on-disk paths resolve to the same file. Treat as no-op,
          // mirroring the extension-less `fromPath === toPath` short-circuit
          // in the handler. Returning empty arrays here propagates as
          // `{ ok: true, renamed: [], rewrittenDocs: [] }` to the caller.
          if (sourcePathRoot === destinationPathRoot) {
            return { renamed: [], renamedAssets: [], rewrittenDocs: [] };
          }
          if (!existsSync(sourcePathRoot)) {
            throw new ManagedRenameSourceNotFoundError(kind);
          }
          if (
            existsSync(destinationPathRoot) &&
            !isCaseOnlySelfCollision(sourcePathRoot, destinationPathRoot)
          ) {
            throw new ManagedRenameDestinationExistsError();
          }
          const sourceStat = statSync(sourcePathRoot);
          if (
            (kind === 'file' && !sourceStat.isFile()) ||
            (kind === 'folder' && !sourceStat.isDirectory())
          ) {
            throw new ManagedRenameSourceTypeMismatchError(kind);
          }
          const renamedAssets =
            kind === 'folder'
              ? listRenamedAssetsForFolderMove(sourcePathRoot, fromPath, toPath)
              : [];
          span.setAttribute('rename.affected_assets', renamedAssets.length);

          // Downstream code keys on extension-less docNames for ordinary
          // files, but same-stem `.md` / `.mdx` siblings stay
          // extension-qualified so the operation targets the selected file.
          // Folder rename enumerates descendant docs from DISK rather than
          // the in-memory file index:
          // the index lags on-disk truth after a fresh `write`, which
          // made folder rename report `renamed: []` and skip link rewriting
          // while still moving the directory. Disk is the authoritative set of
          // what the move carries.
          const affectedDocNames =
            kind === 'file'
              ? [docNameForFileOperationPath(contentDir, fromPath)]
              : listManagedDocNamesUnderFolderFromDisk(sourcePathRoot);
          const affectedDocs: Array<{ from: string; to: string }> = affectedDocNames.map(
            (docName) => ({
              from: docName,
              to:
                kind === 'file'
                  ? docNameForFileOperationPath(contentDir, toPath)
                  : remapDocNameForRename(docName, kind, fromPath, toPath),
            }),
          );
          span.setAttribute('rename.affected_docs', affectedDocs.length);

          if (affectedDocs.length === 0) {
            // Empty or asset-only folder rename: no documents move, but
            // assets inside the folder may still need markdown references
            // updated after the folder itself moves.
            const pendingAssetRewrites = collectAssetReferenceRewritesForMappings(renamedAssets);
            assertRewriteTargetsNotConflicted(pendingAssetRewrites.map((entry) => entry.docName));
            const rewrittenDocs: ManagedRenameRewrittenDoc[] = [];
            if (kind === 'folder') {
              const renamedWithGit = await renameTrackedPathInGit(
                projectDir,
                sourcePathRoot,
                destinationPathRoot,
              );
              if (!renamedWithGit) {
                renamePathOnDisk(sourcePathRoot, destinationPathRoot);
              }
              renameFolderIndexEntries(fromPath, toPath);
              signalChannel?.('files');
            }
            rewrittenDocs.push(
              ...applyPendingAssetReferenceRewrites(pendingAssetRewrites, renamedAssets),
            );
            if (rewrittenDocs.length > 0) {
              void backlinkIndex.saveToDisk().catch((err) => {
                console.warn(
                  `[backlinks] Failed to persist managed rename cache for ${fromPath} -> ${toPath}:`,
                  err,
                );
              });
              signalChannel?.('backlinks');
              signalChannel?.('graph');
            }
            rewrittenDocs.sort((a, b) => a.docName.localeCompare(b.docName));
            return { renamed: [], renamedAssets, rewrittenDocs };
          }

          const renameMap = buildRenameMap(affectedDocs);
          const renamed: RenamedDocMapping[] = affectedDocs.map(({ from, to }) => ({
            fromDocName: from,
            toDocName: to,
          }));

          const backlinkSourceSet = new Set<string>();
          for (const { from } of affectedDocs) {
            for (const entry of backlinkIndex.getBacklinks(from)) {
              if (!renameMap.has(entry.source)) {
                backlinkSourceSet.add(entry.source);
              }
            }
          }
          const backlinkSources = [...backlinkSourceSet].sort((a, b) => a.localeCompare(b));

          const snapshotContents = new Map<string, string>();
          const rewriteDocNameSet = new Set<string>();
          const assetRewriteDocNameSet = new Set<string>();
          const missingBacklinkSources: string[] = [];

          for (const docName of [...renameMap.keys(), ...backlinkSources]) {
            if (snapshotContents.has(docName)) continue;

            // For backlink sources (non-renamed docs that link to a rename
            // target): require a real on-disk file. A Y.Doc may be in
            // memory for a docName that has no disk file (e.g.,
            // `openDirectConnection` was triggered by a hover or pre-warm
            // on a redlink). Treating in-memory-only Y.Docs as legitimate
            // backlink sources here would funnel them into the
            // `rewriteDocNames` loop and `writeManagedRenameDocumentToDisk`
            // would materialize a phantom file — `tracedMkdirSync` +
            // `tracedWriteFileSync` create whatever path it's handed.
            // Treat as missing and let the index purge the stale entry.
            if (!renameMap.has(docName)) {
              const filePath = resolveContentEntryPath(contentDir, 'file', docName);
              if (!existsSync(filePath)) {
                missingBacklinkSources.push(docName);
                continue;
              }
            }

            // L1 reconcile-before-apply for rename: the rename
            // serializes the LOADED CRDT to the new path (`captureAndCloseDocuments`
            // → `syncRenamedDocsToDisk`) and link-rewrites loaded backlink sources
            // to disk — both via `tracedWriteFileSync`, which BYPASSES the
            // `storeDocumentNow` store hook, so the L3 backstop cannot guard
            // rename. A loaded-but-stale CRDT (disk edited out-of-band since load)
            // would therefore clobber the newer on-disk edit. Ingest disk into the
            // loaded doc here — before the snapshot, the disk move, and the
            // recovery envelope — so the rename carries disk truth and the
            // recovery journal snapshots it. Synchronous (no microtask boundary
            // inside the serialized critical section). No-op when not loaded /
            // not diverged. resolveEmbed is intentionally omitted here (unlike
            // the four content handlers): this reconcile protects content bytes,
            // not embed display attributes — the raw embed reference round-trips
            // losslessly through the rename re-serialize and re-resolves on the
            // next normal load/reconcile. The extension-level resolveEmbed is
            // also shadowed by this function's own options param.
            reconcileDiskBeforeAgentWrite(hocuspocus, docName, contentDir);
            const content = readCurrentDocumentContent(docName);
            if (typeof content === 'string') {
              snapshotContents.set(docName, content);
              if (!renameMap.has(docName)) {
                rewriteDocNameSet.add(docName);
              }
            } else if (!renameMap.has(docName)) {
              missingBacklinkSources.push(docName);
            }
          }

          if (renamedAssets.length > 0) {
            const docNames = [...getFileIndex().keys()].sort((a, b) => a.localeCompare(b));
            for (const docName of docNames) {
              const content = snapshotContents.get(docName) ?? readCurrentDocumentContent(docName);
              if (typeof content !== 'string') continue;
              const rewritten = applyRenameAndAssetReferenceRewrites(
                content,
                docName,
                renameMap.get(docName) ?? docName,
                renameMap,
                renamedAssets,
              );
              if (rewritten.rewrites === 0) continue;
              if (!snapshotContents.has(docName)) {
                snapshotContents.set(docName, content);
              }
              assetRewriteDocNameSet.add(docName);
              if (!renameMap.has(docName)) {
                rewriteDocNameSet.add(docName);
              }
            }
          }
          assertRewriteTargetsNotConflicted(assetRewriteDocNameSet);

          for (const { from } of affectedDocs) {
            if (typeof snapshotContents.get(from) !== 'string') {
              throw new ManagedRenameMissingDocumentError(from);
            }
          }

          const recoveryJournal = createManagedRenameRecoveryJournal({
            fromPath,
            toPath,
            affectedDocs: [...affectedDocs],
            snapshots: buildManagedRenameSnapshots([...snapshotContents.keys()], snapshotContents),
          });

          const rewrittenDocs: ManagedRenameRewrittenDoc[] = [];
          const rewriteDocNames = [...rewriteDocNameSet].sort((a, b) => a.localeCompare(b));

          await withManagedRenameRecovery(projectDir ?? contentDir, recoveryJournal, async () => {
            for (const docName of missingBacklinkSources) {
              backlinkIndex.deleteDocument(docName);
            }

            for (const docName of rewriteDocNames) {
              const document = hocuspocus.documents.get(docName);
              const rewritten = document
                ? applyManagedRenameMapToLoadedDocument(docName, renameMap, renamedAssets)
                : applyRenameAndAssetReferenceRewrites(
                    snapshotContents.get(docName) ?? '',
                    docName,
                    docName,
                    renameMap,
                    renamedAssets,
                  );

              if (rewritten.rewrites > 0) {
                writeManagedRenameDocumentToDisk(docName, rewritten.markdown);
                rewrittenDocs.push({ docName, rewrites: rewritten.rewrites });
              }

              backlinkIndex.updateDocumentFromMarkdown(docName, rewritten.markdown);
            }

            // `captureAndCloseDocuments` sends an application-level
            // `CloseMessage` frame to every connected provider for the
            // affected docNames; the client's `'close'` handler responds with
            // a fresh `sendToken()`, which the server processes through
            // `onAuthenticate` → `removalRedirectGuard` on the next event-loop
            // turn. That forced reconnect imposes two ordering constraints,
            // both satisfied before the close below:
            //
            //   1. The LRU must already reflect the rename. If we populated
            //      it AFTER the close, the re-auth could land while the cache
            //      is still empty (the close→sendToken round-trip overlaps the
            //      spine's subsequent `await`s) and the active tab would be
            //      silently admitted to the stale source docName instead of
            //      redirected.
            //   2. The destination file must already exist on disk. The guard
            //      redirects the reconnecting client to the new docName, which
            //      fires `persistence.onLoadDocument(newDocName)`. That hook
            //      early-returns when the file is absent, leaving a live empty
            //      Y.Doc that nothing re-imports once the move lands — the
            //      editor and every later reader then see an empty doc even
            //      though disk holds the original body. So the disk move runs
            //      here, before the close, not after it.
            //
            // On rename failure, `withManagedRenameRecovery` rolls the disk
            // back but does NOT clear the cache. `removalRedirectGuard`
            // trusts the rename cache absolutely (no file-existence
            // self-clean for the `renamed` kind — that path is only for
            // `deleted`), so the stale entry still redirects the client to
            // the now-absent target. The next handshake the client makes
            // against the target admits (no cache entry for the target,
            // so the chain walk terminates and the connection is allowed
            // through) and either finds the file if a retry succeeded or
            // loads an empty doc that resyncs on reload: a bounded UX cost
            // (see `removal-redirect-guard.ts`).
            if (recentlyRemovedDocs) {
              for (const { from, to } of affectedDocs) {
                if (isSystemDoc(from) || isConfigDoc(from)) continue;
                recentlyRemovedDocs.setRenamed(from, to);
                console.info(
                  JSON.stringify({
                    event: 'recently-removed-docs-populate',
                    from,
                    to,
                    kind: 'renamed',
                    source: 'spine',
                  }),
                );
              }
            }

            const rootSourcePath = resolveContentEntryPath(contentDir, kind, fromPath);
            const rootDestinationPath = resolveContentEntryPath(contentDir, kind, toPath);
            const renamedWithGit = await renameTrackedPathInGit(
              projectDir,
              rootSourcePath,
              rootDestinationPath,
            );
            if (!renamedWithGit) {
              renamePathOnDisk(rootSourcePath, rootDestinationPath);
            }
            if (kind === 'folder') {
              renameFolderIndexEntries(fromPath, toPath);
            }

            const liveContents = await captureAndCloseDocuments([...renameMap.keys()], 'renamed');

            // Test-only crash-injection seam. Production builds with
            // NODE_ENV !== 'test' AND OK_TEST_RENAME_FAULT unset elide the
            // branch. The two injection windows verify the
            // disk-move → log-append → journal-clear ordering invariant: a
            // crash at either window must leave the system in a consistent
            // state — the recovery journal rolls disk back; any orphan log
            // entry is swept on next boot.
            if (
              process.env.NODE_ENV === 'test' &&
              process.env.OK_TEST_RENAME_FAULT === 'pre-append'
            ) {
              throw new Error('OK_TEST_RENAME_FAULT=pre-append');
            }

            // Rename-log emit. Happens AFTER the disk move and AFTER the
            // recovery journal is on disk, so a crash here leaves the
            // journal as the rollback authority. `commitSha: ''` enters the
            // lazy-population window — `commitToWipRefInner`'s post-success
            // hook backfills it from this drain's writer commit. Anonymous
            // renames attribute to the openknowledge-service writer.
            if (shadowRef?.current) {
              const shadow = shadowRef.current;
              // Extension-only renames change disk state while preserving the logical docName.
              // The rename log records logical docName moves and rejects self-pairs.
              // Compare on the extension-stripped docName: a same-stem sibling makes
              // `docNameForFileOperationPath` keep the destination extension-qualified
              // (`a` -> `a.mdx` when `a.md` exists), so a raw `from !== to` no longer
              // recognizes the self-pair and would log a phantom rename.
              const loggableAffectedDocs = affectedDocs.filter(
                ({ from, to }) => stripDocExtension(from) !== stripDocExtension(to),
              );
              // Body is fully synchronous (file appends + contributor
              // bookkeeping). withSpanSync avoids inserting a microtask
              // boundary inside the recovery envelope, where pending
              // file-watcher parcel events would otherwise race the
              // per-doc disk-sync loop and resurrect the source path.
              if (loggableAffectedDocs.length > 0) {
                withSpanSync(
                  'rename.appendLog',
                  { attributes: { 'rename.kind': kind } },
                  (span) => {
                    const groupId = randomUUID();
                    const at = new Date().toISOString();
                    const branch = getCurrentBranch?.() ?? 'main';
                    const renameLogIndex = getOrLoadRenameLogIndex(shadow.gitDir);
                    const actorWriter = options?.actor
                      ? {
                          writerId: options.actor.writerId,
                          displayName: options.actor.displayName,
                        }
                      : { writerId: SERVICE_WRITER.id, displayName: SERVICE_WRITER.name };
                    let entriesAppended = 0;
                    for (const { from, to } of loggableAffectedDocs) {
                      const logEntry: RenameLogEntry = {
                        v: 1,
                        from,
                        to,
                        at,
                        commitSha: '',
                        branch,
                        groupId,
                        kind,
                        actor: actorWriter,
                      };
                      // An append failure (ENOSPC, EACCES, EROFS — `<gitdir>/ok/`
                      // shares a filesystem with content) MUST abort the rename.
                      // Swallowing it would leave (post-rename disk, no log
                      // entry): the recovery envelope clears the journal on
                      // success because nothing throws, so disk stays renamed
                      // even though the rename history record is missing.
                      // Re-throw so the journal stays on disk and next-boot
                      // recovery rolls disk back.
                      appendRenameLogEntry(shadow.gitDir, logEntry, renameLogIndex, shadow);
                      entriesAppended += 1;
                      // Thread `previous_paths` through the contributor
                      // pipeline so the L2 drain emits it on the writer's
                      // `OkActorEntry`.
                      //
                      // Anonymous renames MUST also record a contributor entry
                      // attributed to the service writer. Without it,
                      // `pendingContributors` won't include
                      // `openknowledge-service`, so when the drain also has
                      // agent activity the per-writer fan-out commits only the
                      // agent and the service-writer backfill never runs — the
                      // empty-`commitSha` log entry becomes an orphan that the
                      // next-boot `sweepLazyPopOrphans` silently drops, losing
                      // the rename history.
                      if (options?.actor) {
                        recordContributor(
                          to,
                          options.actor.writerId,
                          options.actor.displayName,
                          options.actor.colorSeed,
                          formatRenameSubject(from, to),
                          options.actor.actorMetadata,
                          undefined,
                          [{ from, to }],
                        );
                      } else {
                        recordContributor(
                          to,
                          SERVICE_WRITER.id,
                          SERVICE_WRITER.name,
                          SERVICE_WRITER.id,
                          formatRenameSubject(from, to),
                          undefined,
                          undefined,
                          [{ from, to }],
                        );
                      }
                    }
                    span.setAttribute('rename.entries_appended', entriesAppended);
                  },
                );
              }
            }

            // Pre-register destination extensions so loop 2's
            // `resolveContentEntryPath` and `safeContentPath` produce the
            // correct on-disk paths. For an extension-change rename
            // (`foo.md` → `foo.mdx`), inheriting from the source's recorded
            // extension would point at the no-longer-extant `.md` path; for
            // a same-extension cross-folder rename, the destination docName
            // has no recorded extension yet and would default to `.md`,
            // miscomputing `.mdx` source paths. Forget the source mapping
            // so a renamed-then-recreated source doesn't inherit a stale
            // extension. The file watcher would converge to the same state
            // asynchronously — this just makes loop 2 see it synchronously.
            const explicitDestExt: string | null =
              kind === 'file' && isSupportedDocFile(toPath) ? extname(toPath) : null;
            for (const { from, to } of affectedDocs) {
              const sourceExt = isSupportedDocFile(from) ? extname(from) : getDocExtension(from);
              forgetDocExtension(from);
              registerDocExtension(to, explicitDestExt ?? sourceExt);
            }

            const sortedAffected = [...affectedDocs].sort((a, b) => a.from.localeCompare(b.from));

            for (const { from: fromDocName, to: toDocName } of sortedAffected) {
              const sourcePath = resolveContentEntryPath(contentDir, 'file', fromDocName);
              const destinationPath = resolveContentEntryPath(contentDir, 'file', toDocName);
              const sourceCurrentContent =
                liveContents.get(fromDocName) ??
                snapshotContents.get(fromDocName) ??
                readFileSync(destinationPath, 'utf-8');
              const renamedSource = applyRenameAndAssetReferenceRewrites(
                sourceCurrentContent,
                fromDocName,
                toDocName,
                renameMap,
                renamedAssets,
              );

              syncRenamedDocsToDisk(
                [{ fromDocName, toDocName }],
                new Map([[fromDocName, renamedSource.markdown]]),
              );
              setReconciledBase(toDocName, renamedSource.markdown);

              mutateFileIndex?.({
                kind: 'rename',
                oldPath: sourcePath,
                newPath: destinationPath,
                oldDocName: fromDocName,
                newDocName: toDocName,
                content: renamedSource.markdown,
              });

              backlinkIndex.renameDocument(fromDocName, toDocName, renamedSource.markdown);
              if (renamedSource.rewrites > 0) {
                rewrittenDocs.push({ docName: toDocName, rewrites: renamedSource.rewrites });
              }
            }

            // Second crash-injection seam — fires AFTER the log append +
            // AFTER the per-doc sync loop, BEFORE the implicit
            // `clearManagedRenameJournal` at the end of the recovery
            // envelope. Validates that an orphan log entry left by a crash
            // is swept by the boot-time `sweepLazyPopOrphans` pass once the
            // outer recovery rolls disk back.
            if (
              process.env.NODE_ENV === 'test' &&
              process.env.OK_TEST_RENAME_FAULT === 'pre-journal-clear'
            ) {
              throw new Error('OK_TEST_RENAME_FAULT=pre-journal-clear');
            }
          });

          void backlinkIndex.saveToDisk().catch((err) => {
            console.warn(
              `[backlinks] Failed to persist managed rename cache for ${fromPath} -> ${toPath}:`,
              err,
            );
          });
          signalChannel?.('files');
          signalChannel?.('backlinks');
          signalChannel?.('graph');

          rewrittenDocs.sort((a, b) => a.docName.localeCompare(b.docName));
          span.setAttribute('rename.rewrite_count', rewrittenDocs.length);

          return { renamed, renamedAssets, rewrittenDocs };
        },
      ),
    );
  }

  /**
   * Canonical identity boundary (precedent #24) — every mutating POST handler calls this
   * before any Y.Doc mutation. Resolves request body → {agentId, agentName, colorSeed, clientName}.
   * The meta-test in attribution-sweep-coverage.test.ts asserts all handlers call this at entry.
   *
   * Body parsing + sanitization is shared with `extractActorIdentity` via
   * `parseAgentBodyFields` in `agent-id.ts`. This wrapper adds the write-handler
   * default — absent agentId becomes `'claude-1'` so attribution always lands on
   * a stable broadcaster key (matches `getSession()` for presence bar color).
   */
  function extractAgentIdentity(body: Record<string, unknown>): {
    rawAgentId: string | undefined;
    agentId: string;
    agentName: string;
    colorSeed: string;
    clientName: string | undefined;
    clientVersion: string | undefined;
    label: string | undefined;
  } {
    const fields = parseAgentBodyFields(body);
    const agentId = fields.writerId ?? 'claude-1';
    return {
      rawAgentId: fields.rawAgentId,
      agentId,
      agentName: fields.displayName,
      colorSeed: fields.colorSeed ?? fields.rawAgentId ?? agentId,
      clientName: fields.clientName,
      clientVersion: fields.clientVersion,
      label: fields.label,
    };
  }

  /**
   * Build actor-tuple metadata for threading through recordContributor →
   * ContributorEntry → OkActorEntry. Populates:
   *   - principalId from getPrincipal() (stable UUID per local install)
   *   - agentType derived from clientName
   *   - clientName / clientVersion / label passed through from request body
   */
  function buildAgentActor(args: {
    clientName: string | undefined;
    clientVersion?: string;
    label?: string;
  }): {
    principalId?: string;
    agentType?: string;
    clientName?: string;
    clientVersion?: string;
    label?: string;
  } {
    const principalId = getPrincipal?.()?.id;
    return {
      principalId,
      agentType: resolveAgentType(args.clientName),
      clientName: args.clientName,
      clientVersion: args.clientVersion,
      label: args.label,
    };
  }

  /**
   * Shape of the `summary` field appended to a handler's success JSON response
   * when the caller provided a summary. Absent from the response entirely when
   * the caller did not supply a summary (including empty string, which is
   * treated as absent per `normalizeSummary`).
   *
   * `hint` is nested inside `summary` (not a sibling top-level key) so the
   * truncation message always travels with the field it explains — this
   * prevents naming collisions at the response root and tightens the coupling
   * between `truncatedFrom` and the human-readable explanation.
   */
  type SummaryResponse = { value: string; truncatedFrom?: number; hint?: string };

  /**
   * Pure response-shape derivation from a normalized summary — NO side effects.
   * Returns the fields the handler appends to its success JSON when the caller
   * supplied a summary. `undefined` return values mean "omit the corresponding
   * response key entirely."
   *
   * The hint is nested inside `response.hint` when truncation fires — callers
   * that want the top-level text line read the value via `response?.hint`.
   */
  function summaryResponseFields(normalized: NormalizedSummary): {
    response?: SummaryResponse;
    stored: string | undefined;
  } {
    if (normalized.kind !== 'value') return { stored: undefined };
    if (normalized.truncatedFrom !== undefined) {
      return {
        response: {
          value: normalized.value,
          truncatedFrom: normalized.truncatedFrom,
          hint: `Summary truncated from ${normalized.truncatedFrom} chars to 80 (max 80).`,
        },
        stored: normalized.value,
      };
    }
    return { response: { value: normalized.value }, stored: normalized.value };
  }

  /**
   * Strip truncation-specific fields from a `SummaryResponse`. Used by the
   * rename / rollback default-substitution path: when the server generates a
   * default like "Renamed X → Y" and that default itself overflows the cap,
   * the agent did not submit the long string — so `truncatedFrom` and the
   * "Summary truncated from ..." hint would misattribute blame to the caller.
   * The stored value is still the truncated form (so the timeline bullet fits),
   * but the diagnostic metadata is silenced in the response.
   */
  function stripDefaultPathTruncation(response: SummaryResponse): SummaryResponse {
    return { value: response.value };
  }

  /**
   * Fire the adoption + truncation counters for a summary that is about to be
   * persisted. Call AFTER the contribution is guaranteed to land (i.e. not on
   * 404/409 early-returns) so adoption rate reflects successful writes.
   *
   * `fromDefault` suppresses the `summariesTruncated` increment when the
   * truncation came from a server-generated default (rename / rollback default
   * substitution). The agent had no control over those strings, so counting
   * them toward the truncation metric would muddy the "agent behavior" signal.
   */
  function countNormalizedSummary(normalized: NormalizedSummary, fromDefault = false): void {
    if (normalized.kind !== 'value') return;
    incrementSummariesProvided();
    if (normalized.truncatedFrom !== undefined && !fromDefault) incrementSummariesTruncated();
  }

  type RenameAttributionActor = Exclude<
    ReturnType<typeof extractActorIdentity>,
    { kind: 'invalid-summary' }
  >;

  interface RenameAttributionEntry {
    docName: string;
    subject: string;
  }

  function attributeRenameWriteToActor(
    actor: RenameAttributionActor,
    defaultSummarySubject: string,
    entries: readonly RenameAttributionEntry[],
    options: { context: string; onAnonymous?: () => void },
  ): SummaryResponse | undefined {
    if (entries.length === 0) return undefined;
    switch (actor.kind) {
      case 'agent': {
        const agentProvidedSummary = actor.summary.kind === 'value';
        const effectiveNormalized = agentProvidedSummary
          ? actor.summary
          : normalizeSummary(defaultSummarySubject);
        const fields = summaryResponseFields(effectiveNormalized);
        const summaryResponse =
          agentProvidedSummary || !fields.response
            ? fields.response
            : stripDefaultPathTruncation(fields.response);
        for (let i = 0; i < entries.length; i++) {
          const { docName, subject } = entries[i];
          recordContributor(
            docName,
            actor.writerId,
            actor.displayName,
            actor.colorSeed,
            subject,
            actor.actor,
            i === 0 ? fields.stored : undefined,
          );
        }
        incrementAgentWriteCalls();
        countNormalizedSummary(effectiveNormalized, !agentProvidedSummary);
        for (const { docName } of entries) {
          flushDocToGit(docName, 'rename-path');
        }
        return summaryResponse;
      }
      case 'principal': {
        const fields = summaryResponseFields(actor.summary);
        for (let i = 0; i < entries.length; i++) {
          const { docName, subject } = entries[i];
          recordContributor(
            docName,
            actor.writerId,
            actor.displayName,
            actor.colorSeed,
            subject,
            actor.actor,
            i === 0 ? fields.stored : undefined,
          );
        }
        countNormalizedSummary(actor.summary, false);
        for (const { docName } of entries) {
          flushDocToGit(docName, 'rename-path');
        }
        return fields.response;
      }
      case 'anonymous':
        options.onAnonymous?.();
        return undefined;
      default: {
        const _exhaustive: never = actor;
        throw new Error(
          `Unhandled actor kind in ${options.context}: ${String((_exhaustive as { kind?: unknown }).kind)}`,
        );
      }
    }
  }

  /**
   * Contributor `docs` key for a non-doc `.ok/` artifact, so a folder-scoped
   * timeline query resolves it. Mirrors `checkTemplateConflictGate`'s
   * `<folder>/.ok/templates/<name>` shape; folder frontmatter keys to
   * `<folder>/.ok/frontmatter`; a folder itself keys to its own path.
   */
  function okArtifactKey(
    kind: 'template' | 'folder-frontmatter' | 'folder' | 'skill',
    folder: string,
    name?: string,
  ): string {
    const base = folder.replace(/\/$/, '');
    const prefix = base === '' ? '' : `${base}/`;
    if (kind === 'template') return `${prefix}.ok/templates/${name}`;
    // A skill is project-root-scoped (`folder` is always '' for project skills),
    // so the key is `.ok/skills/<name>` — the directory, not a single file —
    // matching the folder-timeline query shape for a `.ok/` artifact.
    if (kind === 'skill') return `${prefix}.ok/skills/${name}`;
    if (kind === 'folder-frontmatter') return `${prefix}.ok/frontmatter`;
    return base === '' ? '.' : base;
  }

  /**
   * Attribute a write to a non-doc `.ok/` artifact (template / folder
   * frontmatter / folder-create) to the acting agent/principal so it surfaces
   * in the folder timeline. Unlike `attributeRenameWriteToActor`, it does NOT
   * call `flushDocToGit` — these artifacts have no Y.Doc. The caller drives the
   * shadow commit via `flushContributors`, whose `buildWipTree` sweeps the
   * working tree (including `.ok/`). Anonymous / invalid-summary actors record
   * nothing (mirrors the rename branch).
   */
  function attributeOkArtifactWrite(
    actor: ReturnType<typeof extractActorIdentity>,
    artifactKey: string,
    subject: string,
    previousPaths?: Array<{ from: string; to: string }>,
  ): void {
    if (actor.kind !== 'agent' && actor.kind !== 'principal') return;
    const summaryFields = summaryResponseFields(actor.summary);
    recordContributor(
      artifactKey,
      actor.writerId,
      actor.displayName,
      actor.colorSeed,
      subject,
      actor.actor,
      summaryFields.stored,
      previousPaths,
    );
  }

  /**
   * Drive a shadow commit + contributor flush after a non-doc `.ok/` mutation.
   * Non-doc artifacts have no Y.Doc, so nothing else triggers the persistence
   * drain — without this the attributed contributor would sit unflushed (or be
   * mis-attributed to an unrelated later doc write). Best-effort: a flush
   * failure is logged, never fatal to the mutation that already succeeded.
   */
  async function commitOkArtifactWrite(context: string): Promise<void> {
    if (!flushContributors) return;
    try {
      await flushContributors();
    } catch (flushErr) {
      // The contributor commit clears the in-memory queue only on success, so a
      // failed flush leaves this write's attribution queued for the next
      // mutation's flush to retry. If no later mutation follows, it is lost —
      // best-effort by design, never fatal to the mutation that already landed.
      console.warn(
        `[${context}] flushContributors failed; attribution stays queued for the next flush:`,
        flushErr,
      );
    }
  }

  const handleAgentWrite = withValidation(
    AgentWriteRequestSchema,
    async (_req, res, body) => {
      try {
        // `withValidation` already enforces docName safety + body shape.
        const rawDocName = requireNonEmptyDocName(body.docName, res, 'agent-write');
        if (rawDocName === null) return;
        const docName = resolveAlias(rawDocName);

        // Identity extraction precedes every SEMANTIC error emission below
        // (precedent #24). Body-shape errors emitted by `withValidation` are
        // anonymous because no Y.Doc mutation is attempted.
        const { agentId, agentName, colorSeed, clientName, clientVersion, label } =
          extractAgentIdentity(body);

        if (isSystemDoc(docName) || isConfigDoc(docName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${docName}' is a reserved document name.`,
            { handler: 'agent-write' },
          );
          return;
        }

        const normalizedSummary = normalizeSummary(body.summary);
        const session = await sessionManager.getSession(docName, agentId, {
          displayName: agentName,
          colorSeed,
          clientName,
        });

        // L1 reconcile-before-apply: ingest a newer out-of-band
        // disk edit before this legacy content write lands, matching the other
        // content handlers. Separate FILE_WATCHER_ORIGIN transact before the
        // agent's session.origin transact below.
        const agentWriteReconcile = reconcileDiskBeforeAgentWrite(
          hocuspocus,
          docName,
          contentDir,
          options.resolveEmbed,
        );

        const timestamp = new Date().toISOString();
        const content =
          typeof body.content === 'string' ? body.content : `Hello from the agent! ${timestamp}`;
        const { response: summaryResponse, stored: storedSummary } =
          summaryResponseFields(normalizedSummary);

        // setPresence lives INSIDE the try so the pairing with touchMode('idle')
        // in `finally` is atomic — any throw between setPresence and transact
        // (even future code added here) flips the badge back to idle rather
        // than wedging it on 'editing'.
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
          // Register one-shot observer BEFORE write transact so YTextEvent.delta is captured
          captureEffect(session.dc.document.getText('source'), agentId, colorSeed, clientName);
          // Use per-session origin, not shared AGENT_WRITE_ORIGIN (STOP rule)
          session.dc.document.transact(() => {
            applyAgentMarkdownWrite(
              session.dc.document,
              `${content}\n`,
              'append',
              options.resolveEmbed
                ? { resolveEmbed: options.resolveEmbed, sourcePath: docName }
                : undefined,
            );

            const activityMap = session.dc.document.getMap('agent-flash');
            activityMap.set(agentId, {
              agentId,
              timestamp: Date.now(),
              type: 'insert',
              description: `Added (${agentName}): ${content.slice(0, 50)}`,
            });
          }, session.origin);
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
        } finally {
          agentPresenceBroadcaster?.touchMode(agentId, 'idle');
        }

        // Await the L1 disk store so a swallowed persistence failure OR an L3
        // disk-divergence revert surfaces as an error instead of a false success
        // Mirrors agent-write-md.
        const flushOutcome = await flushDiskAndDetectOutcome(docName);
        if (flushOutcome?.kind === 'failure') {
          respondPersistenceFailure(res, flushOutcome.failure, 'agent-write');
          return;
        }
        if (flushOutcome?.kind === 'divergence') {
          respondDiskDivergence(res, 'agent-write');
          return;
        }
        flushDocToGit(docName, 'agent-write');
        onAgentWrite?.();

        // Success body is flat — no `{ ok: true }` wrapper. Clients
        // discriminate via HTTP status (`if (!res.ok)`), then safeParse
        // against `AgentWriteSuccessSchema`. `successResponse` runs the same
        // schema server-side as defense-in-depth.
        const agentWriteWarning = buildReconcileWarning(agentWriteReconcile);
        successResponse(
          res,
          200,
          AgentWriteSuccessSchema,
          {
            timestamp,
            ...(summaryResponse ? { summary: summaryResponse } : {}),
            // `warnings` is the unified advisory channel; the single-valued
            // `warning` is its deprecated alias, kept emitting in parallel.
            ...(agentWriteWarning
              ? { warning: agentWriteWarning, warnings: [agentWriteWarning] }
              : {}),
          },
          { handler: 'agent-write' },
        );
      } catch (e) {
        if (e instanceof DocInConflictError) {
          respondDocInConflict(res, e, 'agent-write');
          return;
        }
        // Symmetry-only catch: `agent-write` calls `applyAgentMarkdownWrite`
        // with `position: 'append'`, which routes through the FM-dropping
        // branch (`finalFm = existingFm`). The malformed-FM gate fires only
        // when `finalFm !== existingFm`, so this catch is structurally
        // unreachable from this handler today. Kept as a forward-compat
        // slot in case a future shape lets `agent-write` accept FM-bearing
        // payloads — at that point the existing test coverage on
        // `agent-write-md` already pins the envelope shape.
        if (e instanceof FrontmatterMalformedError) {
          respondFrontmatterMalformed(res, e, 'agent-write');
          return;
        }
        if (e instanceof AgentSessionCapacityError) {
          // DoS guard: the per-server session cap was hit. 503 so SDK
          // consumers know to retry-after — distinct from a write that
          // actually executed and failed downstream.
          errorResponse(
            res,
            503,
            'urn:ok:error:too-many-agent-sessions',
            'Too many agent sessions.',
            { handler: 'agent-write', cause: e, extraHeaders: { 'Retry-After': '10' } },
          );
          return;
        }
        log.error({ err: e }, '[agent-write] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-write',
          cause: e,
        });
      }
    },
    { handler: 'agent-write', method: 'POST' },
  );

  const handleAgentWriteMd = withValidation(
    AgentWriteMdRequestSchema,
    async (_req, res, body) => {
      try {
        const position = body.position ?? 'append';
        const effectiveDocName = requireNonEmptyDocName(body.docName, res, 'agent-write-md');
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
            { handler: 'agent-write-md' },
          );
          return;
        }

        // Explicit-extension create: persistence materializes the file via
        // `getDocExtension` (defaults to `.md`). Pre-register the caller's
        // requested extension so a `.mdx` create lands as `.mdx` rather than
        // the default — same synchronous pre-registration the rename path uses
        // for an extension change. Gated on the doc being brand-new: for an
        // existing doc the recorded extension wins, since switching it would
        // write a sibling file and orphan the original. Idempotent with the
        // file-watcher's later `create` registration (same canonical ext).
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

        // L1 reconcile-before-apply: ingest a newer out-of-band
        // disk edit before the agent edit lands, so stale loaded CRDT state
        // can't clobber it. Runs its own FILE_WATCHER_ORIGIN transact BEFORE
        // the agent's session.origin transact below — never nested.
        const writeMdReconcile = reconcileDiskBeforeAgentWrite(
          hocuspocus,
          resolvedDocName,
          contentDir,
          options.resolveEmbed,
        );

        const timestamp = new Date().toISOString();

        // Site A content-divergence captured from the in-transact gate.
        // Surfaced as the response's `warning` field; structured-log on fire
        // for production observability.
        let writeDivergence: AgentWriteContentDivergence | undefined;

        // setPresence lives INSIDE the try so the pairing with touchMode('idle')
        // in `finally` is atomic — any throw between setPresence and transact
        // (even future code added here) flips the badge back to idle rather
        // than wedging it on 'editing'.
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
          // Register one-shot observer BEFORE write transact so YTextEvent.delta is captured
          captureEffect(session.dc.document.getText('source'), agentId, colorSeed, clientName);
          // Use per-session origin, not shared AGENT_WRITE_ORIGIN (STOP rule)
          session.dc.document.transact(() => {
            writeDivergence = applyAgentMarkdownWrite(
              session.dc.document,
              body.markdown,
              position,
              options.resolveEmbed
                ? { resolveEmbed: options.resolveEmbed, sourcePath: resolvedDocName }
                : undefined,
            );

            const activityMap = session.dc.document.getMap('agent-flash');
            activityMap.set(agentId, {
              agentId,
              timestamp: Date.now(),
              type: 'insert',
              description: `Added (${agentName}): ${body.markdown.trim().slice(0, 50)}`,
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
          agentPresenceBroadcaster?.touchMode(agentId, 'idle');
        }

        // Force the L1 disk store now and report disk truth: a swallowed
        // persistence failure (ENOSPC / EACCES / EROFS, etc.) must surface as
        // an error rather than a false "Written successfully". The CRDT copy
        // stays in memory regardless. On success this also drains the L1
        // debounce, so the `flushDocToGit` below only fires the L2 git commit.
        const flushOutcome = await flushDiskAndDetectOutcome(resolvedDocName);
        if (flushOutcome?.kind === 'failure') {
          respondPersistenceFailure(res, flushOutcome.failure, 'agent-write-md');
          return;
        }
        if (flushOutcome?.kind === 'divergence') {
          respondDiskDivergence(res, 'agent-write-md');
          return;
        }

        flushDocToGit(resolvedDocName, 'agent-write-md');

        // Focus (attribution) on __system__ awareness. Focus drives browser
        // push-navigation to the doc the agent just wrote (writeKind); presence
        // is separately maintained via setPresence/touchMode pairs above.
        agentFocusBroadcaster?.setFocus(agentId, {
          agentName,
          currentDoc: resolvedDocName,
          writeKind: 'write',
          ts: Date.now(),
        });
        onAgentWrite?.();

        // Orphan-hint nudge: if this doc now has zero backlinks and a
        // plausible hub exists in its folder tree, suggest the hub. Soft —
        // agent can ignore. Silent when no backlinkIndex is wired.
        const hints = computeOrphanHints(resolvedDocName);

        // The converged post-write source (frontmatter region + body), read
        // once and reused for both the mermaid render check and the broken-
        // link validation below.
        const writtenSource = session.dc.document.getText('source').toString();

        // Close the dropped-FSEvent gap at the source: register this doc into
        // the file index now rather than waiting on the watcher (see helper).
        registerWrittenDocInFileIndex(resolvedDocName, writtenSource);

        // Advisory render validation on the post-write state (covers
        // append/prepend composition and pre-existing broken fences alike).
        const renderWarnings = await validateMermaidFences(writtenSource, resolvedDocName);

        // Write-time outbound-link validation. Computed synchronously from
        // the just-written source bytes the handler already holds — NOT from
        // the BacklinkIndex, whose agent-write update is 100ms-debounced and so
        // still stale here. Report-only: a broken link never rejects or rewrites
        // the write (authoring a doc before its target exists is legitimate).
        // The just-written doc is added to the admitted set so a valid self-link
        // isn't falsely flagged before the file-watcher indexes it on disk.
        const admittedForLinks = collectAdmittedDocNames();
        admittedForLinks.add(resolvedDocName);
        const brokenLinks = computeBrokenOutboundLinks(
          writtenSource,
          resolvedDocName,
          admittedForLinks,
          linkedFileExists,
        );

        const subscriberCount = getSubscriberCount(resolvedDocName);
        const systemSubscriberCount = getSystemSubscriberCount();

        // Once-per-session attach hint counter: fires when no editor is attached
        // to `__system__` (transport-presence = false). Labels are bounded-
        // cardinality — writer-kind
        // is always `agent` at this call site (`handleAgentWriteMd`), and
        // `resolveAgentType` is a 6-valued enum. No raw session IDs or names.
        if (systemSubscriberCount === 0) {
          hintEmittedCounter().add(1, {
            'shadow.writer': 'agent',
            'agent.type': resolveAgentType(clientName),
          });
        }

        // Success body is flat — no `{ ok: true }` wrapper.
        const writeMdWarning = buildReconcileWarning(writeMdReconcile);
        const writeMdDivergenceEntry =
          writeDivergence !== undefined ? toContentDivergenceWarning(writeDivergence) : undefined;
        // Unified advisory channel: every advisory this write produced,
        // discriminated by `kind`. Unlike the deprecated single-valued
        // `warning` below, nothing masks anything — on the rare divergence +
        // reconcile double-fault both entries surface, and mermaid render
        // warnings ride alongside.
        const writeMdAdvisories = [
          ...(writeMdDivergenceEntry ? [writeMdDivergenceEntry] : []),
          ...(writeMdWarning ? [writeMdWarning] : []),
          ...(renderWarnings ?? []),
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
            // Deprecated single `warning` slot, kept emitting for one
            // deprecation window. Two sources, content-divergence
            // (composed ≠ converged) taking precedence over β's disk-edit-
            // reconciled: in the common case they're mutually exclusive (β
            // reconciles in a prior transact, so the primitive still composes
            // faithfully and the in-transact gate stays silent); on the rare
            // double-fault read `warnings`, which carries both.
            ...(writeMdDivergenceEntry
              ? { warning: writeMdDivergenceEntry }
              : writeMdWarning
                ? { warning: writeMdWarning }
                : {}),
            ...(writeMdAdvisories.length > 0 ? { warnings: writeMdAdvisories } : {}),
            // Always present (even `[]`) — the positive "all outbound links
            // resolve" confirmation the agent reads in the same response .
            brokenLinks,
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
          // DoS guard: per-server session cap was hit. 503 so SDK
          // consumers know to retry-after — distinct from a write that
          // actually executed and failed downstream.
          errorResponse(
            res,
            503,
            'urn:ok:error:too-many-agent-sessions',
            'Too many agent sessions.',
            { handler: 'agent-write-md', cause: e, extraHeaders: { 'Retry-After': '10' } },
          );
          return;
        }
        log.error({ err: e }, '[agent-write-md] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-write-md',
          cause: e,
        });
      }
    },
    { handler: 'agent-write-md', method: 'POST' },
  );

  /**
   * `POST /api/frontmatter-patch` — JSON Merge Patch (RFC 7396) for the YAML
   * region of `Y.Text('source')`. Mirrors `handleAgentWriteMd`'s session +
   * presence pattern, but composes the FM region directly via `applyPatchToFm`
   * instead of routing through `composeAndWriteRawBody`'s body re-parse.
   *
   * Per-key validation runs atomically: any `FrontmatterValueSchema` failure
   * rejects the WHOLE patch with HTTP 400 + per-key `fieldErrors`, leaving
   * the Y.Doc unchanged.
   *
   * Origin: `session.origin` (per-session `PairedWriteOrigin` from
   * `agent-sessions.ts`). `paired: true` short-circuits Observer A/B because
   * the splice touches only the FM region of `Y.Text`; the body bytes are
   * preserved verbatim and Observer B's already-in-sync gate fires when no
   * body shift occurs.
   *
   * Telemetry: emits `ok.frontmatter_patch` span via `withSpanSync`.
   */
  const handleFrontmatterPatch = withValidation(
    FrontmatterPatchRequestSchema,
    async (_req, res, body) => {
      try {
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

        // L1 reconcile-before-apply: ingest a newer out-of-band
        // disk edit before this FM patch lands, so the patch runs against the
        // live (disk-reflecting) frontmatter, not a stale loaded copy. Separate
        // FILE_WATCHER_ORIGIN transact BEFORE the agent's session.origin transact.
        const fmReconcile = reconcileDiskBeforeAgentWrite(
          hocuspocus,
          resolvedDocName,
          contentDir,
          options.resolveEmbed,
        );

        const timestamp = new Date().toISOString();

        // `applyPatchToFm` is a total function returning FmEditResult — its
        // own validation pass covers every key against FrontmatterValueSchema
        // atomically (no Y.Doc mutation on failure). Compute the next fenced
        // bytes INSIDE the transact so a concurrent body edit between read
        // and write is captured by the splice's byte-range delete/insert.
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
                  // Route through the sanctioned `composeAndWriteRawBody`
                  // primitive (precedent #38, bridge-intake.ts) so paired-
                  // write semantics survive — even though this patch only
                  // mutates the YAML region. composeAndWriteRawBody runs
                  // `applyFastDiff` against currentYText, which collapses
                  // to a minimal byte-range edit when only the FM region
                  // shifted, and re-derives the XmlFragment from the
                  // (unchanged) body. paired-write-enforcement.test.ts
                  // requires this routing for session.origin transacts.
                  //
                  // When this patch CREATES the fence on a doc that had none
                  // (`currentFenced === ''`), `nextFenced` ends in `---\n` and
                  // `currentBody` is the untouched body starting at its first
                  // byte (e.g. `# Heading`), so a bare concat yields
                  // `---\n# Heading` with no blank line after the fence. Insert
                  // exactly one blank-line separator so a freshly created fence
                  // matches the spacing of a doc that always had frontmatter
                  // (there the blank line lives inside `currentBody` and
                  // round-trips via `detectFmRegion`). Skip when the body is
                  // empty (FM-only doc) or already starts with a newline.
                  const needsFenceSeparator =
                    currentFenced === '' && currentBody !== '' && !currentBody.startsWith('\n');
                  const newFull =
                    result.nextFenced + (needsFenceSeparator ? '\n' : '') + currentBody;
                  composeAndWriteRawBody(session.dc.document, newFull, 'agent');
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
          // Atomic rejection — no Y.Doc mutation happened. Per-key fieldErrors
          // surfaced so the MCP tool can render a `key: reason` map. The
          // `satisfies never` at the default-case exit catches any new
          // FmEditError kind added in core that hasn't been wired here.
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
          // Await the L1 disk store so a swallowed persistence failure surfaces
          // as an error instead of a false success. Mirrors agent-write-md. Gated
          // on an actual body mutation: a no-op patch (a key set to its current
          // value) schedules no store, so `takeStoreFailure` could otherwise read
          // an unrelated prior write's residue (its precondition is a preceding
          // force-flush of THIS doc).
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
          }
          flushDocToGit(resolvedDocName, 'frontmatter-patch');
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

        // Close the dropped-FSEvent gap at the source (see helper). A frontmatter
        // patch leaves the body unchanged, but re-registering a doc the watcher
        // dropped restores it to the file index just the same.
        registerWrittenDocInFileIndex(
          resolvedDocName,
          session.dc.document.getText('source').toString(),
        );

        // Write-time outbound-link validation. A frontmatter patch leaves
        // the body unchanged, so this reflects the doc's current body links —
        // surfacing the same `brokenLinks` signal on every `edit` path keeps
        // the contract uniform rather than returning a misleading empty `[]`.
        const admittedForLinks = collectAdmittedDocNames();
        admittedForLinks.add(resolvedDocName);
        const brokenLinks = computeBrokenOutboundLinks(
          session.dc.document.getText('source').toString(),
          resolvedDocName,
          admittedForLinks,
          linkedFileExists,
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
            // `warnings` is the unified advisory channel; the single-valued
            // `warning` is its deprecated alias, kept emitting in parallel.
            ...(fmWarning ? { warning: fmWarning, warnings: [fmWarning] } : {}),
            brokenLinks,
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
        log.error({ err: e }, '[frontmatter-patch] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'frontmatter-patch',
          cause: e,
        });
      }
    },
    { handler: 'frontmatter-patch', method: 'POST' },
  );

  /**
   * Read `lifecycle.status` + `lifecycle.reason` off a Y.Doc. Returns
   * `null` when no status is set so consumers can rely on a stable
   * `lifecycle === null` check rather than `lifecycle?.status`. `reason`
   * falls back to the empty string when only `status` is set — the typed
   * schema requires both fields, and the Y.Map's `reason` is set in
   * lockstep with `status` in every server-factory site that writes it.
   */
  function readLifecycleStatus(document: Document): LifecycleStatus | null {
    const lifecycleMap = document.getMap('lifecycle');
    const status = lifecycleMap.get('status');
    if (typeof status !== 'string' || status.length === 0) return null;
    const reason = lifecycleMap.get('reason');
    return { status, reason: typeof reason === 'string' ? reason : '' };
  }

  const handleDocumentRead = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const rawDocName = url.searchParams.get('docName') || 'test-doc';
        if (!isSafeDocName(rawDocName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'document-read',
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
            { handler: 'document-read' },
          );
          return;
        }

        // Existing in-memory Y.Doc → read it directly; no need to round-trip
        // through openDirectConnection (which would still resolve to the same
        // doc but adds a connect/disconnect cycle).
        const existing = hocuspocus.documents.get(docName);
        if (existing) {
          successResponse(
            res,
            200,
            DocumentReadSuccessSchema,
            {
              docName,
              content: existing.getText('source').toString(),
              lifecycle: readLifecycleStatus(existing),
            },
            { handler: 'document-read' },
          );
          return;
        }

        // No in-memory doc → require an on-disk file before opening a
        // connection. `openDirectConnection` on a missing path materializes
        // an empty Y.Doc into `Hocuspocus.documents` that auto-unload is
        // suppressed for. The persistence layer's phantom-doc guard blocks
        // the eventual 0-byte file write, but any later code path that
        // populates the lingering Y.Doc with content (a mis-routed agent
        // write, the rename spine pulling it in via a stale backlink edge)
        // would then land a phantom file because `reconciledBase` was never
        // set. 404 here closes that whole class.
        const filePath = resolveContentEntryPath(contentDir, 'file', docName);
        if (!existsSync(filePath)) {
          errorResponse(res, 404, 'urn:ok:error:doc-not-found', `Document not found: ${docName}.`, {
            handler: 'document-read',
          });
          return;
        }

        // Read via a transient DirectConnection rather than sessionManager.getSession —
        // this endpoint has no agent identity, and creating a cached session would
        // leak an anonymous "Agent" (icon='bot') entry into the presence bar.
        const dc = await hocuspocus.openDirectConnection(docName);
        try {
          const document = dc.document;
          if (!document) {
            errorResponse(
              res,
              500,
              'urn:ok:error:doc-not-available',
              'Document is not available.',
              { handler: 'document-read' },
            );
            return;
          }
          const content = document.getText('source').toString();
          successResponse(
            res,
            200,
            DocumentReadSuccessSchema,
            { docName, content, lifecycle: readLifecycleStatus(document) },
            { handler: 'document-read' },
          );
        } finally {
          await dc.disconnect();
        }
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read document.', {
          handler: 'document-read',
          cause: e,
        });
      }
    },
    { handler: 'document-read', method: 'GET', skipBodyParse: true },
  );

  const handleDocumentList = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        // Park until the watcher's seed walk has populated the in-memory
        // file/folder index. Without this, a renderer that fetches before
        // initAsync resolves sees `documents: []` and renders the false
        // "No files yet" / "Welcome to your LLM brain" cold-start flash.
        // `.catch()` keeps the handler responsive on a degraded boot so
        // we serve whatever partial state is available rather than 500ing.
        // Most init failures already populate `degraded[]` via per-subsystem
        // try-catches inside `initAsync`, but a throw outside those guards
        // (e.g., a future subsystem added without its own catch) propagates
        // here unlabeled — log it so operators have a trail.
        if (ready) {
          await ready.catch((err: unknown) => {
            log.warn(
              { err, handler: 'document-list' },
              '[api] ready gate rejected — responding with partial index',
            );
          });
        }
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const dir = url.searchParams.get('dir');
        const showAll = url.searchParams.get('showAll') === 'true';
        // Tree-listing reveal: admit `.ok` rows (minus worktrees/local) into
        // the showAll walk. Inert without showAll — the watcher indexes
        // backing the non-showAll path never hold non-skill `.ok` entries.
        const showOk = url.searchParams.get('showOk') === 'true';
        // Lazy per-directory contract: `?depth=1` yields only the
        // scoped dir's immediate children (each folder stamped `hasChildren`),
        // so the sidebar fetches one level on expand instead of the whole tree.
        // Only `1` is honored; any other value falls through to the full
        // recursive walk. Composes with the showAll cap / single-flight /
        // streaming paths below unchanged.
        const showAllMaxDepth =
          url.searchParams.get('depth') === '1' ? 1 : Number.POSITIVE_INFINITY;

        // Validate dir parameter (reject traversal attempts)
        if (dir) {
          try {
            safeSubdir(contentDir, dir);
          } catch {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Invalid directory parameter.',
              {
                handler: 'document-list',
              },
            );
            return;
          }
        }

        // Streaming Show All Files: when the client negotiates
        // NDJSON, stream the on-demand disk walk one entry per line instead of
        // buffering the whole listing. `streamShowAllEntries` yields one entry
        // at a time, so the server retains O(1) entries — the durable fix for
        // the showAll serialization heap peak that the buffered single-flight
        // path below (plus its entry cap) only bounds. Abort-on-disconnect maps
        // straight onto the response: a client `close` aborts the walk, which
        // bails at the next directory boundary.
        if (showAll && contentFilter && showAllWantsNdjson(req)) {
          const controller = new AbortController();
          // A streaming response has exactly one caller, so its own disconnect
          // is the last (only) waiter leaving — no refcount needed. `writableEnded`
          // gates out the normal-completion `close` so a finished walk is never
          // spuriously marked aborted.
          res.on('close', () => {
            if (!res.writableEnded) controller.abort();
          });
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson',
            'Transfer-Encoding': 'chunked',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-cache',
          });
          const writeStreamError = createStreamingErrorWriter(res, 'document-list');

          // Honor backpressure so the socket write buffer can't grow to hold the
          // full listing — that buffered copy is exactly what streaming removes.
          // Resolve early on `close` so a stalled or disconnected client never
          // strands the walk awaiting a drain that will never fire.
          const writeNdjsonLine = async (line: string): Promise<void> => {
            if (res.writableEnded || res.destroyed) return;
            if (res.write(line)) return;
            await new Promise<void>((resolve) => {
              const done = () => {
                res.off('drain', done);
                res.off('close', done);
                resolve();
              };
              res.once('drain', done);
              res.once('close', done);
            });
          };

          try {
            const maxEntries = getShowAllMaxEntries();
            const generator = streamShowAllEntries({
              contentDir,
              contentFilter,
              dirFilter: dir,
              maxEntries,
              maxDepth: showAllMaxDepth,
              showOk,
              signal: controller.signal,
            });
            let count = 0;
            let next = await generator.next();
            while (!next.done) {
              await writeNdjsonLine(`${JSON.stringify(next.value)}\n`);
              count += 1;
              next = await generator.next();
            }
            const { truncated } = next.value;
            if (truncated) {
              log.info(
                { handler: 'document-list', maxEntries, count },
                '[document-list][showAll] stream truncated at entry cap',
              );
            }
            // Terminal control line. Streamed entries are bare DocumentListEntry
            // objects (always carry `kind`, never `type`); the `type` discriminant
            // marks this completion record so the client can finalize and read the
            // truncation flag the per-entry lines can't carry.
            await writeNdjsonLine(`${JSON.stringify({ type: 'complete', truncated, count })}\n`);
          } catch (err) {
            // Past `writeHead` the status line is already on the wire, so a failure
            // surfaces as a typed mid-stream `{type:'error',problem}` event, not an
            // `errorResponse` (which would try to write a second set of headers).
            if (!res.writableEnded && !res.destroyed) {
              writeStreamError(
                500,
                'urn:ok:error:internal-server-error',
                'Failed to list documents (showAll stream).',
                { cause: err },
              );
            } else {
              log.error(
                { err, handler: 'document-list' },
                '[document-list][showAll] stream failed after response ended',
              );
            }
          } finally {
            if (!res.writableEnded) res.end();
          }
          return;
        }

        // Show All Files mode — fresh on-demand disk walk via
        // `ContentFilter.{isExcluded,isDirExcluded}` with `bypassFilters:true`.
        // Returns .gitignored / .okignored / content-bearing `BUILTIN_SKIP_DIRS`
        // files (`dist/`, `build/`, …), EXCEPT the `ALWAYS_SKIP_DIRS` floor
        // (`.git/` / `node_modules/` / `.ok/`, pruned even under bypass — the
        // OOM guard) and synthetic system + config doc names (unbypassable
        // STOP-rule gate inside ContentFilter). Per-request only — fileIndex
        // stays populated with the non-bypass set, so the next
        // non-`?showAll=true` call serves today's filtered view unchanged.
        if (showAll && contentFilter) {
          // Single-flight: coalesce concurrent identical walks into one. Key by
          // the already-traversal-validated `dir` (the exact `dirFilter` the
          // walk consumes) plus the depth and showOk markers, so only requests
          // producing the same traversal share one walk and one sorted result.
          // Coalescing across showOk modes would hand one caller the other
          // mode's listing (`.ok` rows leaking to a plain caller, or silently
          // missing for a reveal caller).
          const key = `showAll:${showAllMaxDepth === 1 ? 'd1:' : ''}${showOk ? 'ok:' : ''}${dir ?? ''}`;
          let entry = showAllInflight.get(key);
          if (!entry) {
            const controller = new AbortController();
            // Build the shared promise synchronously — no `await` between the
            // map miss and the `set` below — so a burst of identical requests
            // arriving on the same tick all attach to this entry rather than
            // each starting a walk. The walk owns its accumulator and sorts
            // once, so every coalesced caller serializes the identical result.
            const promise = (async (): Promise<ShowAllWalkResult> => {
              const documents: DocumentListEntry[] = [];
              const maxEntries = getShowAllMaxEntries();
              const { truncated } = await walkContentDirForShowAll({
                contentDir,
                contentFilter,
                dirFilter: dir,
                documents,
                maxEntries,
                maxDepth: showAllMaxDepth,
                showOk,
                signal: controller.signal,
              });
              documents.sort((a, b) => {
                const aPath = a.kind === 'folder' ? (a.path ?? '') : (a.docName ?? a.path ?? '');
                const bPath = b.kind === 'folder' ? (b.path ?? '') : (b.docName ?? b.path ?? '');
                return aPath.localeCompare(bPath);
              });
              // Surface cap saturation so operators can alert and retune
              // `OK_SHOWALL_MAX_ENTRIES` before users notice. Bounded fields
              // (two small integers) — safe on a histogrammed log attribute.
              if (truncated) {
                log.info(
                  { handler: 'document-list', maxEntries, count: documents.length },
                  '[document-list][showAll] walk truncated at entry cap',
                );
              }
              return { documents, truncated };
            })();
            entry = { promise, controller, waiters: 0 };
            const created = entry;
            showAllInflight.set(key, created);
            // Evict on settle (success AND error). Guard the delete so a newer
            // entry created under the same key after this one settled is never
            // clobbered.
            void promise.finally(() => {
              if (showAllInflight.get(key) === created) showAllInflight.delete(key);
            });
          }

          // Abort-on-disconnect, refcounted: abort the shared walk only once
          // every attached caller has disconnected (aborting on the first
          // disconnect would strand still-connected co-waiters). `res.on(close)`
          // fires on both normal completion and client disconnect, so
          // `res.writableEnded` gates out the completion case — no spurious
          // abort, no spurious log.
          const attached = entry;
          attached.waiters += 1;
          let released = false;
          const releaseOnDisconnect = () => {
            if (res.writableEnded || released) return;
            released = true;
            attached.waiters -= 1;
            if (attached.waiters <= 0) {
              attached.controller.abort();
              // Drop the doomed walk before it settles so a request arriving in
              // the abort-to-settle window starts a fresh full walk instead of
              // attaching and receiving the partial, aborted result.
              if (showAllInflight.get(key) === attached) showAllInflight.delete(key);
            }
          };
          res.on('close', releaseOnDisconnect);

          try {
            const { documents, truncated } = await attached.promise;
            // This caller already disconnected — its co-waiters (if any) own the
            // walk; writing to a closed socket would throw.
            if (released) return;
            successResponse(
              res,
              200,
              DocumentListSuccessSchema,
              truncated ? { documents, truncated } : { documents },
              { handler: 'document-list' },
            );
          } catch (e) {
            if (released) return;
            errorResponse(
              res,
              500,
              'urn:ok:error:internal-server-error',
              'Failed to list documents (showAll mode).',
              { handler: 'document-list', cause: e },
            );
          } finally {
            res.removeListener('close', releaseOnDisconnect);
          }
          return;
        }

        // Read from the watcher's in-memory indexes (instant, no filesystem scan).
        // Use the canonical `DocumentListEntry` type from the schema (sole source
        // of truth) — an inline duplicate of the row shape used to live here and
        // drifted from the schema, which is exactly the schema-vs-server class
        // `successResponse` closes structurally.
        // Enumerate the all-files index so the listing surfaces every tracked
        // file (markdown + non-markdown), not just markdown + referenced assets.
        // `getFileIndex()` stays the source of truth for the referenced-asset
        // pass below (asset collection only resolves links from markdown bodies
        // — never reads `kind:'file'` content). This is one of the three
        // allowlisted all-files call sites (the caller meta-test pre-allowlists
        // `handleDocumentList`). The loop below structurally narrows by
        // `entry.kind === 'markdown'` vs `entry.kind` (the file variant) — the
        // markdown-assuming consumers (`safeContentPath`, backlink wikilink
        // parse, …) NEVER receive a `kind:'file'` row from this site.
        const index = getFileIndex();
        const allFiles = getAllFilesIndex();
        const folderIndex = getFolderIndex?.() ?? new Map<string, FolderIndexEntry>();
        const documents: DocumentListEntry[] = [];

        // Emit folder entries first; client sorts by path so this just primes
        // the array. Empty folders show up only via this index.
        for (const [folderPath, entry] of folderIndex) {
          if (dir && !folderPath.startsWith(`${dir}/`) && folderPath !== dir) continue;
          documents.push({
            kind: 'folder',
            path: folderPath,
            size: 0,
            modified: entry.modified,
            // DocumentListEntry's defaults will resolve the rest; folder entries
            // intentionally omit docName / docExt / asset fields per the
            // refined schema.
            docExt: '.md',
            isSymlink: false,
            canonicalDocName: null,
            targetPath: null,
          });
        }

        // Asset references: emit referenced sidebar assets alongside
        // documents so the unified tree can render images / videos discovered
        // through wiki-link or markdown image syntax. Cache keyed off a
        // signature derived from the file index — recomputed only when an
        // indexed page mutates.
        let assets: ReturnType<typeof collectReferencedAssets> = [];
        try {
          const assetSignature = referencedAssetsSignature(index);
          if (referencedAssetsCache?.signature !== assetSignature) {
            referencedAssetsCache = {
              signature: assetSignature,
              assets: collectReferencedAssets({
                contentDir,
                fileIndex: index,
                readMarkdown: (path) => {
                  try {
                    return readFileSync(path, 'utf-8');
                  } catch {
                    return null;
                  }
                },
                // Use `isPathIgnored` (user-configured ignore-file rules
                // + BUILTIN_SKIP_DIRS) rather than `isExcluded` (which
                // also evaluates the sibling-asset heuristic). The
                // sibling heuristic is correct for traversal-time
                // admission but wrong here: an image at
                // `docs/media/diagram.png` referenced from `docs/guide.md`
                // lives in a directory with no `.md` of its own and would
                // be dropped from /api/documents.
                isExcluded: contentFilter ? (rel) => contentFilter.isPathIgnored(rel) : undefined,
              }),
            };
          }
          assets = referencedAssetsCache?.assets ?? [];
        } catch (err) {
          referencedAssetsCache = null;
          console.warn('[document-list] asset collection failed; returning documents only:', err);
        }

        // Dedup set: every path emitted as a kind:'asset' entry is suppressed
        // from the kind:'file' all-files pass below. The asset variant carries
        // mediaKind / referencedBy and is what the sidebar's inline-renderable
        // tree decoration keys on, so it wins for renderable assets that the
        // markdown bodies actually reference. Any other non-markdown file falls
        // through to the file variant.
        const assetPaths = new Set<string>();
        for (const asset of assets) {
          if (dir && !asset.path.startsWith(`${dir}/`) && asset.path !== dir) continue;
          assetPaths.add(asset.path);
          documents.push({
            kind: 'asset',
            docName: asset.path,
            docExt: asset.assetExt,
            path: asset.path,
            assetExt: asset.assetExt,
            mediaKind: asset.mediaKind,
            referencedBy: asset.referencedBy,
            size: asset.size,
            modified: asset.modified,
            isSymlink: false,
            canonicalDocName: null,
            targetPath: null,
          });
        }

        for (const [docName, entry] of allFiles) {
          if (entry.kind === 'markdown') {
            // Filter by dir prefix if specified
            if (dir && !docName.startsWith(`${dir}/`) && docName !== dir) continue;

            // getDocExtension() returns the registered on-disk extension for the
            // docName (or `.md` by default when nothing is yet recorded). Surfacing
            // it to the client lets the sidebar render `foo.mdx` vs `foo.md`
            // faithfully instead of hard-coding `.md`.
            const docExt = getDocExtension(docName);

            documents.push({
              kind: 'document',
              docName,
              docExt,
              size: entry.size,
              modified: entry.modified,
              isSymlink: false,
              canonicalDocName: null,
              targetPath: null,
            });

            // Emit alias entries for this canonical file
            for (const alias of entry.aliases) {
              if (dir && !alias.startsWith(`${dir}/`) && alias !== dir) continue;
              const targetRelPath = toPosix(relative(contentDir, entry.canonicalPath));
              documents.push({
                kind: 'document',
                docName: alias,
                docExt,
                size: entry.size,
                modified: entry.modified,
                isSymlink: true,
                canonicalDocName: docName,
                targetPath: targetRelPath,
              });
            }
            continue;
          }

          // Name-only `kind:'file'` row. The docName key for
          // a non-markdown index entry IS the full contentDir-relative path
          // (extension preserved by `pathToDocName` for non-supported exts).
          // Emit one row per visible alias so symlinked file paths surface
          // alongside the canonical, mirroring the document-side alias loop.
          // Suppress when the same path is already covered by the asset pass
          // (renderable referenced assets win — they carry mediaKind +
          // referencedBy that name-only files can't).
          const passesDir = !dir || docName === dir || docName.startsWith(`${dir}/`);
          if (passesDir && !assetPaths.has(docName)) {
            const assetExt = synthesizeShowAllAssetExt(docName);
            documents.push({
              kind: 'file',
              docName,
              path: docName,
              // `docExt` carries the schema's `.default('.md')` for the document
              // variant; for kind:'file' we mirror the synthesized assetExt so
              // tree-side display sites (extension badges) keep working
              // uniformly across asset/file rows. The dot prefix keeps the
              // shape consistent with kind:'document' (`.md`/`.mdx`).
              docExt: `.${assetExt}`,
              assetExt,
              size: entry.size,
              modified: entry.modified,
              isSymlink: false,
              canonicalDocName: null,
              targetPath: null,
            });
          }
          for (const alias of entry.aliases) {
            const aliasPassesDir = !dir || alias === dir || alias.startsWith(`${dir}/`);
            if (!aliasPassesDir || assetPaths.has(alias)) continue;
            const targetRelPath = toPosix(relative(contentDir, entry.canonicalPath));
            const assetExt = synthesizeShowAllAssetExt(alias);
            documents.push({
              kind: 'file',
              docName: alias,
              path: alias,
              docExt: `.${assetExt}`,
              assetExt,
              size: entry.size,
              modified: entry.modified,
              isSymlink: true,
              canonicalDocName: docName,
              targetPath: targetRelPath,
            });
          }
        }

        // Project directory-symlink alias EDGES into the listing. The index holds
        // one edge per symlinked directory (aliasPrefix → canonicalPrefix); here we
        // re-prefix the canonical subtree's rows under each alias prefix at response
        // time — transient, never stored, so the index stays O(symlinks). Alias rows
        // carry `canonicalDocName` so the client opens the canonical Y.Doc: an alias
        // path realpath-resolves to the same inode, so a second Y.Doc keyed by the
        // alias name would fight the canonical over one file on disk.
        const folderAliasIndex = getFolderAliasIndex?.() ?? new Map<string, string>();
        if (folderAliasIndex.size > 0) {
          const passesDirFilter = (p: string): boolean =>
            !dir || p === dir || p.startsWith(`${dir}/`);
          // Group aliases by canonical prefix so the corpus is scanned once even
          // when one directory is symlinked from several places.
          const aliasesByCanonical = new Map<string, string[]>();
          for (const [aliasPrefix, canonicalPrefix] of folderAliasIndex) {
            const arr = aliasesByCanonical.get(canonicalPrefix);
            if (arr) arr.push(aliasPrefix);
            else aliasesByCanonical.set(canonicalPrefix, [aliasPrefix]);
          }
          // Alias folder roots.
          for (const [canonicalPrefix, aliasPrefixes] of aliasesByCanonical) {
            const canonRoot = folderIndex.get(canonicalPrefix);
            const rootTarget = canonRoot
              ? toPosix(relative(contentDir, canonRoot.canonicalPath))
              : canonicalPrefix;
            for (const aliasPrefix of aliasPrefixes) {
              if (!passesDirFilter(aliasPrefix)) continue;
              documents.push({
                kind: 'folder',
                path: aliasPrefix,
                size: 0,
                modified: canonRoot?.modified ?? '1970-01-01T00:00:00.000Z',
                docExt: '.md',
                isSymlink: true,
                canonicalDocName: canonicalPrefix,
                targetPath: rootTarget,
              });
            }
          }
          // Single pass over folders + files: project each entry under every alias
          // whose canonical prefix is an ancestor of the entry (O(corpus × depth)).
          const projectChild = (name: string, emit: (aliasName: string) => void): void => {
            for (
              let slash = name.indexOf('/');
              slash !== -1;
              slash = name.indexOf('/', slash + 1)
            ) {
              const aliasPrefixes = aliasesByCanonical.get(name.slice(0, slash));
              if (!aliasPrefixes) continue;
              const rest = name.slice(slash);
              for (const aliasPrefix of aliasPrefixes) {
                const aliasName = `${aliasPrefix}${rest}`;
                if (passesDirFilter(aliasName)) emit(aliasName);
              }
            }
          };
          for (const [folderPath, fEntry] of folderIndex) {
            projectChild(folderPath, (aliasName) => {
              documents.push({
                kind: 'folder',
                path: aliasName,
                size: 0,
                modified: fEntry.modified,
                docExt: '.md',
                isSymlink: true,
                canonicalDocName: folderPath,
                targetPath: toPosix(relative(contentDir, fEntry.canonicalPath)),
              });
            });
          }
          for (const [docName, dEntry] of allFiles) {
            projectChild(docName, (aliasName) => {
              const targetRelPath = toPosix(relative(contentDir, dEntry.canonicalPath));
              if (dEntry.kind === 'markdown') {
                documents.push({
                  kind: 'document',
                  docName: aliasName,
                  docExt: getDocExtension(docName),
                  size: dEntry.size,
                  modified: dEntry.modified,
                  isSymlink: true,
                  canonicalDocName: docName,
                  targetPath: targetRelPath,
                });
              } else {
                const assetExt = synthesizeShowAllAssetExt(aliasName);
                documents.push({
                  kind: 'file',
                  docName: aliasName,
                  path: aliasName,
                  docExt: `.${assetExt}`,
                  assetExt,
                  size: dEntry.size,
                  modified: dEntry.modified,
                  isSymlink: true,
                  canonicalDocName: docName,
                  targetPath: targetRelPath,
                });
              }
            });
          }
        }

        documents.sort((a, b) => {
          const aPath = a.kind === 'folder' ? (a.path ?? '') : (a.docName ?? a.path ?? '');
          const bPath = b.kind === 'folder' ? (b.path ?? '') : (b.docName ?? b.path ?? '');
          return aPath.localeCompare(bPath);
        });
        successResponse(
          res,
          200,
          DocumentListSuccessSchema,
          { documents },
          { handler: 'document-list' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to list documents.', {
          handler: 'document-list',
          cause: e,
        });
      }
    },
    { handler: 'document-list', method: 'GET', skipBodyParse: true },
  );

  const handleBacklinks = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      if (!backlinkIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:backlink-index-not-configured',
          'Backlink index is not configured.',
          { handler: 'backlinks' },
        );
        return;
      }
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const docName = url.searchParams.get('docName');
        if (!docName) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing docName parameter.', {
            handler: 'backlinks',
          });
          return;
        }
        if (!isSafeDocName(docName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'backlinks',
          });
          return;
        }
        const backlinks = backlinkIndex.getBacklinks(docName).map((entry) => ({
          source: entry.source,
          anchor: entry.anchor,
          title: readPageTitleForDocName(entry.source),
          snippet: entry.snippet,
        }));
        successResponse(
          res,
          200,
          BacklinksSuccessSchema,
          { docName, backlinks },
          { handler: 'backlinks' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read backlinks.', {
          handler: 'backlinks',
          cause: e,
        });
      }
    },
    { handler: 'backlinks', method: 'GET', skipBodyParse: true },
  );

  /**
   * Bulk backlink-count lookup. `GET /api/backlink-counts?docNames=a,b,c`
   * returns `{ counts: { a: 3, b: 0, c: 2 } }`. Serves listing UIs
   * (exec ls/grep/find slim enrichment) that need connection density per file
   * without N-amplifying the single-doc `/api/backlinks` endpoint.
   * docNames failing `isSafeDocName` are silently dropped from `counts`.
   */
  const handleBacklinkCounts = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      if (!backlinkIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:backlink-index-not-configured',
          'Backlink index is not configured.',
          { handler: 'backlink-counts' },
        );
        return;
      }
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const raw = url.searchParams.get('docNames');
        if (!raw) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing docNames parameter.', {
            handler: 'backlink-counts',
          });
          return;
        }
        const counts: Record<string, number> = {};
        for (const docName of raw.split(',')) {
          const trimmed = docName.trim();
          if (!trimmed || !isSafeDocName(trimmed)) continue;
          counts[trimmed] = backlinkIndex.getBacklinkCount(trimmed);
        }
        successResponse(
          res,
          200,
          BacklinkCountsSuccessSchema,
          { counts },
          { handler: 'backlink-counts' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read backlink counts.',
          { handler: 'backlink-counts', cause: e },
        );
      }
    },
    { handler: 'backlink-counts', method: 'GET', skipBodyParse: true },
  );

  const handleForwardLinks = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      if (!backlinkIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:backlink-index-not-configured',
          'Backlink index is not configured.',
          { handler: 'forward-links' },
        );
        return;
      }
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const docName = url.searchParams.get('docName');
        if (!docName) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing docName parameter.', {
            handler: 'forward-links',
          });
          return;
        }
        if (!isSafeDocName(docName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'forward-links',
          });
          return;
        }
        const admitted = collectAdmittedDocNames();
        successResponse(
          res,
          200,
          ForwardLinksSuccessSchema,
          {
            docName,
            forwardLinks: backlinkIndex.getForwardLinkEntries(docName).map((entry) =>
              entry.kind === 'doc'
                ? {
                    kind: 'doc' as const,
                    docName: entry.target,
                    anchor: entry.anchor,
                    title: readPageTitleForLinkedDocName(entry.target, admitted),
                    snippet: entry.snippet,
                  }
                : {
                    kind: 'external' as const,
                    url: entry.url,
                    title: entry.label ?? entry.url,
                    snippet: entry.snippet,
                  },
            ),
          },
          { handler: 'forward-links' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read forward links.',
          { handler: 'forward-links', cause: e },
        );
      }
    },
    { handler: 'forward-links', method: 'GET', skipBodyParse: true },
  );

  const handleLinkGraph = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      if (!backlinkIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:backlink-index-not-configured',
          'Backlink index is not configured.',
          { handler: 'link-graph' },
        );
        return;
      }
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const docName = url.searchParams.get('docName');
        if (docName && !isSafeDocName(docName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'link-graph',
          });
          return;
        }

        const rawDegrees = url.searchParams.get('degrees');
        if (rawDegrees && !docName) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'docName is required when degrees is provided.',
            { handler: 'link-graph' },
          );
          return;
        }

        let nodes: IndexedGraphNode[];
        let links: Array<{ source: string; target: string }>;

        if (rawDegrees && docName) {
          const degrees = Number.parseInt(rawDegrees, 10);
          if (!Number.isFinite(degrees) || degrees < 0) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'degrees must be a non-negative integer.',
              { handler: 'link-graph' },
            );
            return;
          }

          ({ nodes, links } = backlinkIndex.getLinkGraphNeighborhood(docName, degrees));
        } else {
          ({ nodes, links } = backlinkIndex.getLinkGraph());
        }

        const admitted = collectAdmittedDocNames();
        const enrichedNodes = nodes.map((node) => {
          if (node.kind === 'doc') {
            const meta = readFrontmatterMetadataForLinkedDocName(node.docName, admitted);
            return {
              id: node.id,
              kind: 'doc' as const,
              docName: node.docName,
              anchor: node.anchor ?? null,
              label: readPageTitleForLinkedDocName(node.docName, admitted),
              cluster: meta.cluster ?? null,
              category: meta.category ?? null,
              tags: meta.tags ?? null,
            };
          }
          return {
            id: node.id,
            kind: 'external' as const,
            url: node.url,
            label: node.label ?? node.url,
          };
        });
        successResponse(
          res,
          200,
          LinkGraphSuccessSchema,
          { nodes: enrichedNodes, links },
          { handler: 'link-graph' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read link graph.',
          {
            handler: 'link-graph',
            cause: e,
          },
        );
      }
    },
    { handler: 'link-graph', method: 'GET', skipBodyParse: true },
  );

  const handleOrphans = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      if (!backlinkIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:backlink-index-not-configured',
          'Backlink index is not configured.',
          { handler: 'orphans' },
        );
        return;
      }
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const mode = url.searchParams.get('mode') ?? 'both';
        if (!isOrphanMode(mode)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Invalid orphan mode. Allowed values: incoming, outgoing, both.',
            { handler: 'orphans' },
          );
          return;
        }

        const orphans = backlinkIndex
          .getOrphans([...getFileIndex().keys()], mode)
          .map((docName) => ({
            docName,
            title: readPageTitleForDocName(docName),
          }));
        successResponse(res, 200, OrphansSuccessSchema, { orphans }, { handler: 'orphans' });
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read orphan pages.',
          { handler: 'orphans', cause: e },
        );
      }
    },
    { handler: 'orphans', method: 'GET', skipBodyParse: true },
  );

  const handleHubs = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      if (!backlinkIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:backlink-index-not-configured',
          'Backlink index is not configured.',
          { handler: 'hubs' },
        );
        return;
      }
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const rawLimit = url.searchParams.get('limit');
        const parsed = rawLimit ? Number.parseInt(rawLimit, 10) : 20;
        const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
        const admitted = collectAdmittedDocNames();
        const hubs = backlinkIndex.getHubs(limit).map((hub) => ({
          docName: hub.docName,
          title: readPageTitleForLinkedDocName(hub.docName, admitted),
          count: hub.count,
        }));
        successResponse(res, 200, HubsSuccessSchema, { hubs }, { handler: 'hubs' });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read hub pages.', {
          handler: 'hubs',
          cause: e,
        });
      }
    },
    { handler: 'hubs', method: 'GET', skipBodyParse: true },
  );

  const handleDeadLinks = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      if (!backlinkIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:backlink-index-not-configured',
          'Backlink index is not configured.',
          { handler: 'dead-links' },
        );
        return;
      }
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const sourceDocNames = url.searchParams.getAll('sourceDocName');
        if (sourceDocNames.some((docName) => docName.length === 0 || !isSafeDocName(docName))) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid sourceDocName.', {
            handler: 'dead-links',
          });
          return;
        }

        const sourceDocNameFilter = sourceDocNames.length
          ? [...new Set(sourceDocNames.map((docName) => resolveAlias(docName)))]
          : undefined;
        const deadLinks = backlinkIndex.getDeadLinks(
          collectAdmittedDocNames(),
          sourceDocNameFilter,
        );

        successResponse(
          res,
          200,
          DeadLinksSuccessSchema,
          {
            deadLinks: deadLinks.map((entry) => ({
              target: entry.target,
              sources: entry.sources.map((sourceEntry) => ({
                source: sourceEntry.source,
                title: readPageTitleForDocName(sourceEntry.source),
                snippet: sourceEntry.snippet,
              })),
            })),
          },
          { handler: 'dead-links' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read dead links.',
          { handler: 'dead-links', cause: e },
        );
      }
    },
    { handler: 'dead-links', method: 'GET', skipBodyParse: true },
  );

  const handleAgentPatch = withValidation(
    AgentPatchRequestSchema,
    async (_req, res, body) => {
      try {
        const { find, replace, offset } = body;
        const effectivePatchDocName = requireNonEmptyDocName(body.docName, res, 'agent-patch');
        if (effectivePatchDocName === null) return;
        const docName = resolveAlias(effectivePatchDocName);

        const { agentId, agentName, colorSeed, clientName, clientVersion, label } =
          extractAgentIdentity(body);

        // Heuristic precheck: reject `find` strings that look like a YAML
        // frontmatter block before doing any Y.Doc work. The position-based
        // postcheck below catches non-yaml strings whose first match falls
        // inside the FM region. Frontmatter edits must go through
        // write with position:"replace", not a body find/replace.
        if (findLooksLikeFrontmatter(find)) {
          agentPatchFmTouchCounter().add(1, { result: 'rejected' });
          errorResponse(
            res,
            400,
            'urn:ok:error:frontmatter-edit-not-supported',
            'Frontmatter edits are not supported via a body find/replace. Use edit({ document: { path, frontmatter } }) to change frontmatter, or write({ document: { path, content, position: "replace" } }) to rewrite the whole document including its YAML block.',
            { handler: 'agent-patch' },
          );
          return;
        }

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

        // L1 reconcile-before-apply: ingest a newer out-of-band
        // disk edit before this patch lands, so the find/replace runs against
        // the live (disk-reflecting) content. If the out-of-band edit changed
        // the `find` target, the patch harmlessly no-ops (existing not-found
        // result). Separate FILE_WATCHER_ORIGIN transact BEFORE the agent's
        // session.origin transact below.
        const patchReconcile = reconcileDiskBeforeAgentWrite(
          hocuspocus,
          docName,
          contentDir,
          options.resolveEmbed,
        );

        const timestamp = new Date().toISOString();

        let notFound = false;
        let staleTarget = false;
        let fmIntersect = false;
        // Site A content-divergence captured from the in-transact gate.
        // Surfaced as the response's `warning` field on successful patches.
        let patchDivergence: AgentWriteContentDivergence | undefined;
        // setPresence lives INSIDE the try so the pairing with touchMode('idle')
        // in `finally` is atomic — any throw between setPresence and transact
        // (even future code added here) flips the badge back to idle rather
        // than wedging it on 'editing'.
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
          // Register one-shot observer BEFORE write transact so YTextEvent.delta is captured
          captureEffect(session.dc.document.getText('source'), agentId, colorSeed, clientName);
          // Use per-session origin, not shared AGENT_WRITE_ORIGIN (STOP rule)
          session.dc.document.transact(() => {
            // Read current authoritative state from Y.Text — the user's
            // intended source-form bytes (Y.Text-is-truth contract,
            // precedent #38). Searching `serialize(fragment)` would compute
            // offsets against canonical bytes (`__foo__` → `**foo**`,
            // `:---:` → `:-:`, ATX trailing hashes dropped, etc.), so an
            // agent that read the doc through any user-bytes surface (exec,
            // file watcher, MCP) and now patches with `find: "__foo__"`
            // would silently fail-to-match. Reading ytext directly closes
            // that gap.
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
              // Bounded-cardinality telemetry: only event name + numeric
              // lengths + doc.name. Useful for detecting downstream tools
              // that compute offsets against canonical bytes (the pre-
              // contract `serialize(fragment)` shape) instead of user
              // source bytes (the post-contract `ytext.toString()` shape).
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

            // Position-based FM-intersection check. The string-shape
            // heuristic above handles yaml-style find strings; this catches
            // the residual class where a non-yaml find (e.g. a single word
            // like `draft`) happens to first-match in the FM region.
            // `pos < currentFm.length` is the necessary-and-sufficient
            // signal — FM is contiguous at doc start, so any match starting
            // before the FM-end byte overlaps the FM region.
            if (pos < currentFm.length) {
              fmIntersect = true;
              return;
            }

            // Splice at the character level, then write the recomposed body
            // via the `'patch'` position. Only body-region patches reach here,
            // so this branch never modifies the FM: applyAgentMarkdownWrite
            // reads the current FM from the YAML region of Y.Text and keeps it
            // intact for a body-only payload. `'patch'` (NOT `'replace'`) routes
            // the write through the INCREMENTAL primitive, so this surgical
            // find/replace produces a minimal item-preserving Y.Text delta
            // instead of an atomic whole-doc overwrite — replace stays atomic,
            // the edit body find/replace stays surgical.
            const newFull =
              currentFull.slice(0, pos) + replace + currentFull.slice(pos + find.length);
            const { body: newBody } = stripFrontmatter(newFull);
            patchDivergence = applyAgentMarkdownWrite(
              session.dc.document,
              newBody,
              'patch',
              options.resolveEmbed
                ? { resolveEmbed: options.resolveEmbed, sourcePath: docName }
                : undefined,
            );

            const activityMap = session.dc.document.getMap('agent-flash');
            activityMap.set(agentId, {
              agentId,
              timestamp: Date.now(),
              type: 'insert',
              description: `Patched (${agentName}): ${find.slice(0, 50)}`,
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
          if (!notFound && !staleTarget && !fmIntersect) {
            // Only count + record when the patch actually applied. The
            // adoption-rate denominator excludes 404/409 + FM-intersect 400
            // so the metric reflects successful writes, not total attempts.
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
          agentPatchFmTouchCounter().add(1, { result: 'rejected' });
          errorResponse(
            res,
            400,
            'urn:ok:error:frontmatter-edit-not-supported',
            'Frontmatter edits are not supported via a body find/replace. Use edit({ document: { path, frontmatter } }) to change frontmatter, or write({ document: { path, content, position: "replace" } }) to rewrite the whole document including its YAML block.',
            { handler: 'agent-patch' },
          );
          return;
        }

        // Await the L1 disk store so a swallowed persistence failure surfaces as
        // an error instead of a false success. Mirrors agent-write-md.
        const flushOutcome = await flushDiskAndDetectOutcome(docName);
        if (flushOutcome?.kind === 'failure') {
          respondPersistenceFailure(res, flushOutcome.failure, 'agent-patch');
          return;
        }
        if (flushOutcome?.kind === 'divergence') {
          respondDiskDivergence(res, 'agent-patch');
          return;
        }

        flushDocToGit(docName, 'agent-patch');

        // Focus (attribution) on __system__ awareness. Presence is separately
        // maintained via setPresence/touchMode pairs above.
        agentFocusBroadcaster?.setFocus(agentId, {
          agentName,
          currentDoc: docName,
          writeKind: 'edit',
          ts: Date.now(),
        });
        onAgentWrite?.();

        const subscriberCount = getSubscriberCount(docName);
        const systemSubscriberCount = getSystemSubscriberCount();

        // Once-per-session attach hint counter (matches handleAgentWriteMd).
        if (systemSubscriberCount === 0) {
          hintEmittedCounter().add(1, {
            'shadow.writer': 'agent',
            'agent.type': resolveAgentType(clientName),
          });
        }

        const { response: summaryResponse } = summaryResponseFields(normalizedSummary);

        // The converged post-edit source, read once and reused for the mermaid
        // render check and the broken-link validation below.
        const patchedSource = session.dc.document.getText('source').toString();

        // Close the dropped-FSEvent gap at the source (see helper).
        registerWrittenDocInFileIndex(docName, patchedSource);

        // Advisory render validation on the post-edit state (matches
        // handleAgentWriteMd; also surfaces pre-existing broken fences).
        const renderWarnings = await validateMermaidFences(patchedSource, docName);

        // Write-time outbound-link validation — synchronous, from the
        // just-edited source bytes; see handleAgentWriteMd for the full why.
        const admittedForLinks = collectAdmittedDocNames();
        admittedForLinks.add(docName);
        const brokenLinks = computeBrokenOutboundLinks(
          patchedSource,
          docName,
          admittedForLinks,
          linkedFileExists,
        );

        // Success body is flat — no `{ ok: true }` wrapper.
        const patchWarning = buildReconcileWarning(patchReconcile);
        const patchDivergenceEntry =
          patchDivergence !== undefined ? toContentDivergenceWarning(patchDivergence) : undefined;
        // Unified advisory channel — see agent-write-md.
        const patchAdvisories = [
          ...(patchDivergenceEntry ? [patchDivergenceEntry] : []),
          ...(patchWarning ? [patchWarning] : []),
          ...(renderWarnings ?? []),
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
            // Deprecated single slot; content-divergence over disk-edit-
            // reconciled — see agent-write-md.
            ...(patchDivergenceEntry
              ? { warning: patchDivergenceEntry }
              : patchWarning
                ? { warning: patchWarning }
                : {}),
            ...(patchAdvisories.length > 0 ? { warnings: patchAdvisories } : {}),
            // Always present (even `[]`) — see agent-write-md .
            brokenLinks,
          },
          { handler: 'agent-patch' },
        );
      } catch (e) {
        if (e instanceof DocInConflictError) {
          respondDocInConflict(res, e, 'agent-patch');
          return;
        }
        // Symmetry-only catch: `agent-patch` strips FM before forwarding to
        // `applyAgentMarkdownWrite` (a body-only `position: 'patch'`), so
        // `finalFm === existingFm` always holds and the malformed-FM gate
        // never fires from this handler today. Mirroring the other two
        // write surfaces' catches makes the maintenance contract uniform —
        // a future change that lets agent-patch carry FM bytes would get
        // the typed envelope automatically instead of falling through to
        // a 500.
        if (e instanceof FrontmatterMalformedError) {
          respondFrontmatterMalformed(res, e, 'agent-patch');
          return;
        }
        if (e instanceof AgentSessionCapacityError) {
          // DoS guard: per-server session cap was hit. 503 so SDK
          // consumers know to retry-after — distinct from a patch that
          // actually executed and failed downstream.
          errorResponse(
            res,
            503,
            'urn:ok:error:too-many-agent-sessions',
            'Too many agent sessions.',
            { handler: 'agent-patch', cause: e, extraHeaders: { 'Retry-After': '10' } },
          );
          return;
        }
        log.error({ err: e }, '[agent-patch] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-patch',
          cause: e,
        });
      }
    },
    { handler: 'agent-patch', method: 'POST' },
  );

  /**
   * POST /api/agent-undo — agent undo via per-session Y.UndoManager.
   *
   * Body: { docName?: string, connectionId: string, scope?: 'last' | 'session' }
   *   connectionId — the session's agentId (matches sessionManager key)
   *   scope — 'last' undoes the top UM stack item; 'session' undoes all items.
   *
   * Fires applyAgentUndo under session.undoOrigin (paired: true) — Observer
   * A/B short-circuit; XmlFragment-authoritative composition updates both CRDTs.
   */
  const handleAgentUndo = withValidation(
    AgentUndoRequestSchema,
    async (_req, res, body) => {
      try {
        // Extract identity from body so shadow-repo attribution threads
        // through the undo write the same way it does through agent-write
        // / agent-write-md / agent-patch. `agentId` is the broadcaster-map
        // key (prefixed via `toBroadcasterKey`) — use it for
        // setPresence/touchMode so cleanup via the keepalive WS close
        // handler finds the entry.
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

        // 'file' scope is a thin alias for 'session' (all bursts on this file's session).
        const scope: 'last' | 'session' =
          body.scope === 'session' || body.scope === 'file' ? 'session' : 'last';

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

        // Publish presence on __system__ (map-valued, keyed by agentId)
        // instead of the per-doc awareness — the per-doc awareness has ONE
        // shared clientID across N concurrent agents and would stomp.
        //
        // setPresence lives INSIDE the try so the pairing with touchMode('idle')
        // in `finally` is atomic — any throw between setPresence and the undo
        // transact flips the badge back to idle rather than wedging it on 'writing'.
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
          // XmlFragment-authoritative undo via per-session UM.
          // applyAgentUndo wraps um.undo() + composition in one transact under
          // session.undoOrigin (paired: true) so Observer A/B short-circuit.
          undone = applyAgentUndo(
            session,
            scope,
            options.resolveEmbed
              ? { resolveEmbed: options.resolveEmbed, sourcePath: docName }
              : undefined,
          );
          // Record attribution for the undo write so the shadow-repo L2 drain
          // fans it out under this session's writer-id. Skip when the UM stack
          // was empty — a no-op undo has no mutation to attribute.
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
          // Await the L1 disk store so a swallowed persistence failure OR an L3
          // disk-divergence revert surfaces as an error instead of a false
          // success. undo has no L1 reconcile (reconcile-rewrite
          // would invalidate the UM stack), so L3 is its only disk-authority
          // guard. On a divergence revert the undo's effect is
          // discarded (disk wins); the agent re-reads + retries.
          const flushOutcome = await flushDiskAndDetectOutcome(docName);
          if (flushOutcome?.kind === 'failure') {
            respondPersistenceFailure(res, flushOutcome.failure, 'agent-undo');
            return;
          }
          if (flushOutcome?.kind === 'divergence') {
            respondDiskDivergence(res, 'agent-undo');
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

        // Success body is flat — no `{ ok: true }` wrapper.
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
        log.error({ err: e }, '[agent-undo] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-undo',
          cause: e,
        });
      }
    },
    { handler: 'agent-undo', method: 'POST' },
  );

  /**
   * GET /api/agent-activity?agentId=<connId>
   * Returns per-file + per-burst stats for one agent's session(s).
   * Exempt from extractAgentIdentity — read-only, no CRDT mutation.
   */
  const handleAgentActivity = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        // `validateAgentId` enforces AGENT_ID_RE (same shape as every mutating
        // POST handler) — consistent identity shape across all surfaces per
        // `packages/server/src/agent-id.ts`'s "three-surfaces" rule.
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
        log.error({ err: e }, '[agent-activity] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-activity',
          cause: e,
        });
      }
    },
    { handler: 'agent-activity', method: 'GET', skipBodyParse: true },
  );

  /**
   * GET /api/agent-burst-diff?agentId=<connId>&docName=<path>&stackIndex=<n>
   * Returns unified-diff text for one StackItem in a given session.
   * Exempt from extractAgentIdentity — read-only, no CRDT mutation.
   */
  const handleAgentBurstDiff = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const agentId = validateAgentId(url.searchParams.get('agentId'));
        const rawDocName = url.searchParams.get('docName');
        const stackIndexStr = url.searchParams.get('stackIndex');

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
        // Same docName validator every mutating POST handler uses — parity with
        // the rest of the API surface (path traversal, reserved names).
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
        if (!stackIndexStr || Number.isNaN(Number(stackIndexStr))) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'StackIndex must be a number.', {
            handler: 'agent-burst-diff',
          });
          return;
        }
        const stackIndex = Number(stackIndexStr);
        if (!Number.isInteger(stackIndex) || stackIndex < 0) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'stackIndex must be a non-negative integer.',
            { handler: 'agent-burst-diff' },
          );
          return;
        }

        // Typed accessor — no `(as any).sessions` bypass.
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
        if (stackIndex >= um.undoStack.length) {
          errorResponse(
            res,
            404,
            'urn:ok:error:not-found',
            `stackIndex ${stackIndex} out of range (stack has ${um.undoStack.length} items).`,
            { handler: 'agent-burst-diff' },
          );
          return;
        }

        // biome-ignore lint/suspicious/noExplicitAny: Y.StackItem is internal to yjs — structural shape matches YjsStackItemShape in agent-activity.ts
        const stackItem = um.undoStack[stackIndex] as any;
        const ytext = session.dc.document.getText('source');
        const diff = synthesizeStackItemDiffText(stackItem, ytext, docName);
        // `generatedAt` is the server's wall clock at response time (used for
        // client-side cache staleness). The StackItem's capture timestamp is
        // already carried in `/api/agent-activity`'s `bursts[].ts` — no need
        // to duplicate it here.
        successResponse(
          res,
          200,
          AgentBurstDiffSuccessSchema,
          { diff, generatedAt: Date.now() },
          { handler: 'agent-burst-diff' },
        );
      } catch (e) {
        log.error({ err: e }, '[agent-burst-diff] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-burst-diff',
          cause: e,
        });
      }
    },
    { handler: 'agent-burst-diff', method: 'GET', skipBodyParse: true },
  );

  /**
   * POST /api/test-flush-git — await the L2 git-commit pipeline to settle.
   *
   * Agent-write handlers fire `flushDocToGit` FIRE-AND-FORGET, so a test
   * that needs the WIP commit durable can only poll the timeline against a
   * wall-clock budget — and under CI load the serial git-subprocess chain
   * (global one-commit-in-flight mutex in persistence.ts) blows any fixed
   * budget. This route lets tests AWAIT the
   * actual commit completion instead of racing it: it drains the pending
   * L2 debounce timer and any in-flight commit before responding. Callers
   * should flush-then-check inside their poll loop — the fire-and-forget
   * chain may not have scheduled L2 yet on the first iteration.
   */
  const handleTestFlushGit = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        await flushGitCommit?.();
        successResponse(res, 200, TestFlushGitSuccessSchema, {}, { handler: 'test-flush-git' });
      } catch (e) {
        log.error({ err: e }, '[test-flush-git] flush failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'test-flush-git',
          cause: e,
        });
      }
    },
    { handler: 'test-flush-git', method: 'POST', skipBodyParse: true },
  );

  const handleTestReset = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const docName = resolveAlias(url.searchParams.get('docName') ?? 'test-doc');

        // Path traversal guard — reuse the canonical validator from persistence.ts.
        // Throws `Invalid document name: ${docName}` for names that escape contentDir;
        // we translate that to a 400 response. Keeping the guard in one place (not
        // re-implementing the startsWith check inline) ensures handleTestReset stays
        // in lock-step with persistence's onLoadDocument / onStoreDocument validators.
        let filePath: string;
        try {
          filePath = safeContentPath(docName, contentDir);
        } catch (err) {
          // Log the original error (safeContentPath produces messages like
          // `Invalid document name: ${docName}` which are useful for diagnosing
          // unexpected failures beyond the standard path-traversal case — e.g.,
          // encoding errors from resolve(), null-byte truncation, etc.) but
          // still return a sanitized, uniform 400 message to the client so
          // filesystem details never leak through the API boundary.
          // Structured Pino log carries the extra `docName` context that
          // `errorResponse(... { cause: err })` alone would not — the
          // user-supplied path is the diagnostic handle ops need to
          // correlate this 400 with which test/run produced it. Match
          // the agent-write handlers' pattern (`log.error({ err, … }, …)`).
          log.error({ err, docName }, '[test-reset] safeContentPath rejected docName');
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'test-reset',
            cause: err,
          });
          return;
        }

        await sessionManager.closeAll(docName);
        hocuspocus.closeConnections(docName);

        // Force-flush any pending onStoreDocument debounced work before unload.
        // Without this, unloadDocument silently no-ops if the debouncer is active
        // (Hocuspocus.shouldUnloadDocument returns false when isDebounced is true).
        const debounceId = `onStoreDocument-${docName}`;
        if (hocuspocus.debouncer.isDebounced(debounceId)) {
          await hocuspocus.debouncer.executeNow(debounceId);
        }

        const doc = hocuspocus.documents.get(docName);
        if (doc) await (forceUnloadDocument ?? hocuspocus.unloadDocument.bind(hocuspocus))(doc);
        writeFileSync(filePath, '', 'utf-8');
        if (backlinkIndex) {
          backlinkIndex.deleteDocument(docName);
          void backlinkIndex.saveToDisk().catch((err) => {
            console.warn(
              `[backlinks] Failed to persist cache after test-reset for ${docName}:`,
              err,
            );
          });
          signalChannel?.('backlinks');
          signalChannel?.('graph');
        }

        // Also reset the project-root .okignore synthetic doc + on-disk file
        // unless the caller explicitly opts out. Without this, patterns added
        // by one test (via Settings or FileTree right-click) leak into the
        // next test's view of `__config__/okignore`, breaking assertions
        // that read `getByTestId('settings-okignore-row-input').first()`.
        // The opt-out (`?reset-okignore=false`) exists for the rare test that
        // intentionally seeds okignore state and needs it to survive reset.
        //
        // Strategy: clear the live Y.Text in place rather than unload+reload.
        // The Settings UI keeps a CRDT connection open across page navigations
        // within a Playwright test, so an unload would race the still-open
        // connection (which would just re-load the doc with stale state).
        // Clearing the Y.Text broadcasts a delta to any connected client.
        const resetOkignoreParam = url.searchParams.get('reset-okignore');
        const resetOkignore = resetOkignoreParam !== 'false';
        if (resetOkignore) {
          try {
            const okignorePath = resolve(contentDir, '.okignore');
            const okignoreDoc = hocuspocus.documents.get(CONFIG_DOC_NAME_OKIGNORE);
            if (okignoreDoc) {
              const ytext = okignoreDoc.getText('source');
              if (ytext.length > 0) {
                okignoreDoc.transact(() => {
                  ytext.delete(0, ytext.length);
                }, CONFIG_VALIDATION_REVERT_ORIGIN);
              }
            }
            // Truncate the on-disk `.okignore` so subsequent cold loads (after
            // the doc unloads on idle) start from an empty file too.
            if (existsSync(okignorePath)) {
              writeFileSync(okignorePath, '', 'utf-8');
            }
            if (contentFilter) {
              await contentFilter.rebuildIgnorePatterns();
            }
          } catch (err) {
            console.warn('[test-reset] okignore reset partial failure:', err);
          }
        }
        signalChannel?.('files');
        successResponse(res, 200, TestResetSuccessSchema, {}, { handler: 'test-reset' });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'test-reset',
          cause: e,
        });
      }
    },
    { handler: 'test-reset', method: 'POST', skipBodyParse: true },
  );

  /**
   * Test-only rescue hatch for the @parcel/watcher + inotify race on Linux.
   *
   * Under CI CPU contention, `@parcel/watcher` can drop `create` events for
   * files written into freshly-created subdirectories (the recursive subwatch
   * is registered asynchronously after the IN_CREATE for the directory, so
   * rapid follow-up file writes race the registration). That leaves the
   * backlink index out of sync with the content directory on disk, which the
   * backlink-dependent integration tests (e.g. `agent-focus-wiring.test.ts`
   * orphan-hint shape) cannot otherwise recover from.
   *
   * This endpoint forces `backlinkIndex.rebuildFromDisk()` — authoritative
   * resync from the filesystem that covers dropped events. It is NOT suitable
   * for production: rebuild wipes any in-memory backlink state not yet
   * debounced to disk (e.g. a live agent-write awaiting persistence). Gated
   * behind `enableTestRoutes` for that reason.
   */
  const handleTestRescanBacklinks = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        if (!backlinkIndex) {
          errorResponse(
            res,
            503,
            'urn:ok:error:backlink-index-not-configured',
            'Backlink index is not configured.',
            { handler: 'test-rescan-backlinks' },
          );
          return;
        }
        await backlinkIndex.rebuildFromDisk();
        // A full rebuild replaces branch state, dropping the out-of-contentDir
        // global skill bundle nodes — re-register them (node-only, within-bundle)
        // so a forced rescan keeps the global skill graph intact.
        await backlinkIndex.ingestGlobalSkillBundles([resolve(skillsHome, '.ok', 'skills')]);
        void backlinkIndex.saveToDisk().catch((err) => {
          console.warn('[backlinks] Failed to persist cache after test-rescan-backlinks:', err);
        });
        signalChannel?.('backlinks');
        signalChannel?.('graph');
        successResponse(
          res,
          200,
          TestRescanBacklinksSuccessSchema,
          {},
          { handler: 'test-rescan-backlinks' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'test-rescan-backlinks',
          cause: e,
        });
      }
    },
    { handler: 'test-rescan-backlinks', method: 'POST', skipBodyParse: true },
  );

  /**
   * Test-only rescue hatch for the @parcel/watcher + inotify race on Linux —
   * file-index counterpart of `/api/test-rescan-backlinks`.
   *
   * Under CI CPU contention, `@parcel/watcher` can drop `create` events for
   * files written into freshly-created subdirectories (the recursive subwatch
   * is registered asynchronously after the IN_CREATE for the directory, so
   * rapid follow-up file writes race the registration). That leaves
   * `/api/documents` and the in-memory file index silently out of sync with
   * the content directory on disk. Tests using `awaitFileWatcherIndexed`
   * cannot otherwise recover from this state and time out after 45s.
   *
   * This endpoint invokes `WatcherHandle.rescanFromDisk()`, which re-runs
   * the startup seed walk. The walk is additive via `Map.set` — entries
   * already present keep their inode/aliases; missing entries get inserted.
   * In-flight write-tracker entries are preserved.
   *
   * Gated behind `enableTestRoutes` for the same reason as
   * `/api/test-rescan-backlinks` — re-seeding from disk in production could
   * mask legitimate event loss as a silent recovery, hiding bugs that
   * deserve investigation.
   */
  const handleTestRescanFiles = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        if (!rescanFiles) {
          errorResponse(
            res,
            503,
            'urn:ok:error:file-rescan-not-configured',
            'Watcher rescan capability is not configured.',
            { handler: 'test-rescan-files' },
          );
          return;
        }
        await rescanFiles();
        signalChannel?.('files');
        successResponse(
          res,
          200,
          TestRescanFilesSuccessSchema,
          {},
          { handler: 'test-rescan-files' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'test-rescan-files',
          cause: e,
        });
      }
    },
    { handler: 'test-rescan-files', method: 'POST', skipBodyParse: true },
  );

  const handleSaveVersion = withValidation(
    SaveVersionRequestSchema,
    async (_req, res, body) => {
      try {
        // Thread agent identity FIRST so the attribution-sweep ordering check
        // is satisfied: any errorResponse below this point is post-identity.
        // Shadow availability + writer-id validation are semantic checks that
        // would otherwise route through `openknowledge-service` attribution.
        const saveVersionBody = body as unknown as Record<string, unknown>;
        const {
          rawAgentId: svRawAgentId,
          agentId: svAgentId,
          agentName: svAgentName,
          clientName: svClientName,
        } = extractAgentIdentity(saveVersionBody);

        const shadow = shadowRef?.current;
        if (!shadow) {
          // 503 (not 400): shadow-repo unavailability is a server-side
          // startup state, not a client request error. Mirrors the
          // sync-not-active precedent — clients can branch
          // on status for retry strategy (503 → retry later).
          errorResponse(
            res,
            503,
            'urn:ok:error:shadow-not-configured',
            'Shadow repo not configured.',
            { handler: 'save-version' },
          );
          return;
        }

        // Parse optional writers from already-validated body.
        const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
        let writers: WriterIdentity[] = [];
        // True only on the empty-body button path, where `enumerateWipChains`
        // already surfaces EVERY WIP chain — upstream included. That makes the
        // enumerated set the complete fold list, so saveVersion must not re-append
        // the upstream writer (a second rev-parse + a no-op delete on the
        // already-reset ref). The explicit-writers and explicit-agentId paths do
        // not enumerate upstream and keep the default (fold it).
        let foldEnumeratedAll = false;

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

        // Active branch: the button consolidates the branch the user
        // is on, not a hardcoded 'main'.
        const saveVersionBranch = getCurrentBranch?.() ?? 'main';

        if (writers.length === 0) {
          if (svRawAgentId !== undefined) {
            // Explicit agentId path (MCP checkpoint tool) — scoped to that agent.
            const displayName = svClientName ? `${svAgentName} (${svClientName})` : svAgentName;
            writers = [
              { id: svAgentId, name: displayName, email: `${svAgentId}@openknowledge.local` },
            ];
          } else {
            // A true empty-body Save Version (the UI button) consolidates ALL
            // non-park WIP chains on the active branch — agent + principal +
            // classified — so the button matches the user's "group everything I've
            // done into a version" mental model. Park-tipped refs hold
            // branch-switch state and are excluded. Falls back to the service
            // writer when there is no WIP activity at all (an empty checkpoint).
            const chains = await enumerateWipChains(shadow, saveVersionBranch);
            const foldable = chains.filter((c) => !c.isPark);
            writers =
              foldable.length > 0
                ? foldable.map((c) => ({
                    id: c.writerId,
                    name: c.writerId,
                    email: `${c.writerId}@openknowledge.local`,
                  }))
                : [SERVICE_WRITER];
            foldEnumeratedAll = true;
          }
        }

        const resolvedContentRoot = contentRoot ?? '.';
        const checkpointSummary = normalizeSummary(
          typeof body.summary === 'string' ? body.summary : undefined,
        );
        const result = await saveVersion(
          shadow,
          resolvedContentRoot,
          writers,
          saveVersionBranch,
          checkpointSummary.kind === 'value' ? checkpointSummary.value : undefined,
          foldEnumeratedAll ? { includeUpstream: false } : undefined,
        );

        getLogger('history').info({ checkpointRef: result.checkpointRef }, 'checkpoint');

        // Rename-log GC trigger: saveVersion deletes WIP refs, which is the
        // largest entry-death cliff. Run reachability sweep (no rebuild —
        // boot already covered that).
        try {
          await gcRenameLog(shadow, getOrLoadRenameLogIndex(shadow.gitDir));
        } catch (err) {
          console.warn('[rename-log] post-saveVersion GC failed:', err);
        }

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
        log.error({ err: e }, '[save-version] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'save-version',
          cause: e,
        });
      }
    },
    { handler: 'save-version', method: 'POST' },
  );

  // ── GET /api/history ─────────────────────────────────────────────────────
  const handleHistory = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const shadow = shadowRef?.current;
      if (!shadow) {
        // 503 (not 400): shadow-repo unavailability is a server-side state,
        // matching the sync-not-active precedent.
        errorResponse(
          res,
          503,
          'urn:ok:error:shadow-not-configured',
          'Shadow repo not configured.',
          { handler: 'history' },
        );
        return;
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const docName = url.searchParams.get('docName') ?? '';
      const folderParam = url.searchParams.get('folder');
      const branch = url.searchParams.get('branch') ?? getCurrentBranch?.() ?? 'main';
      if (!docName && folderParam === null) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'A docName or folder query parameter is required.',
          { handler: 'history' },
        );
        return;
      }

      if (branch.includes('..') || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid branch name.', {
          handler: 'history',
        });
        return;
      }

      // Folder timeline — attributed activity over a folder's
      // `.ok/` artifacts (templates + frontmatter). Distinct from the doc DAG
      // walk: no rename chain, no checkpoint filter.
      if (folderParam !== null && !docName) {
        const validated = validateFolderRel(folderParam, res, 'folder', 'history');
        if (!validated) return;
        const rawFolderLimit = Number(url.searchParams.get('limit') ?? '50');
        const folderLimit = Math.min(200, Number.isFinite(rawFolderLimit) ? rawFolderLimit : 50);
        const rawFolderOffset = Number(url.searchParams.get('offset') ?? '0');
        const folderOffset = Math.max(0, Number.isFinite(rawFolderOffset) ? rawFolderOffset : 0);
        // Single-flight key — folder mode. The resolved `branch` (not the raw
        // param) is used so two requests on the same effective branch coalesce.
        const folderKey = `folder\0${branch}\0${validated.folderRel}\0${folderLimit}\0${folderOffset}`;
        // `getFolderTimeline` is self-contained: it catches its own git/IO
        // errors, logs them, and returns an empty result rather than throwing —
        // so a handler-level catch here would be dead code.
        const { promise, coalesced } = historyInflight.run(folderKey, () =>
          getFolderTimeline(shadow, validated.folderRel, contentRoot ?? '.', {
            branch,
            limit: folderLimit,
            offset: folderOffset,
          }),
        );
        if (coalesced) recordTimelineCoalesced('folder');
        const result = await promise;
        successResponse(res, 200, HistorySuccessSchema, { ...result }, { handler: 'history' });
        return;
      }

      // Validate docName before it reaches `getDocumentHistory`, which
      // interpolates it into a git pathspec for `git log` / `cat-file -e`.
      // Without this guard, a docName containing `..` or null bytes could
      // (after git's pathspec normalization) target a path outside the
      // configured content root in the shadow repo. Sibling endpoints
      // (handleHistoryVersion, handleDiff, handleRollback) already gate via
      // safeDocPath.
      const resolvedContentRoot = contentRoot ?? '.';
      const docPathResult = safeDocPath(docName, resolvedContentRoot);
      if ('error' in docPathResult) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', docPathResult.error, {
          handler: 'history',
        });
        return;
      }

      const rawLimit = Number(url.searchParams.get('limit') ?? '50');
      const rawOffset = Number(url.searchParams.get('offset') ?? '0');
      const limit = Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50);
      const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
      const type = url.searchParams.get('type') ?? undefined;
      const author = url.searchParams.get('author') ?? undefined;
      const excludeAuthor = url.searchParams.get('excludeAuthor') ?? undefined;
      // Auto-consolidation checkpoints are hidden by default; opt-in for
      // debugging / a future maintenance UI. Part of the single-flight tuple
      // because it changes the result set.
      const includeAutoCheckpoints = url.searchParams.get('includeAutoCheckpoints') === 'true';

      // Single-flight key — doc mode. Covers every param `getDocumentHistory`
      // reads so a differing tuple never shares a wrong result.
      const docKey = `doc\0${branch}\0${docName}\0${limit}\0${offset}\0${type ?? ''}\0${author ?? ''}\0${excludeAuthor ?? ''}\0${includeAutoCheckpoints ? '1' : '0'}`;

      const t0 = Date.now();
      try {
        const { promise, coalesced } = historyInflight.run(docKey, () =>
          getDocumentHistory(
            shadow,
            {
              docName,
              branch,
              limit,
              offset,
              type,
              author,
              excludeAuthor,
              includeAutoCheckpoints,
            },
            resolvedContentRoot,
          ),
        );
        if (coalesced) recordTimelineCoalesced('doc');
        const result = await promise;

        const duration = Date.now() - t0;
        getLogger('timeline').info(
          { docName, entries: result.entries.length, durationMs: duration },
          'query',
        );

        successResponse(res, 200, HistorySuccessSchema, { ...result }, { handler: 'history' });
      } catch (e) {
        // Generic title — raw `e.message` can leak FS paths / library internals.
        // The underlying message is forwarded to Pino via `cause` for ops triage.
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read history.', {
          handler: 'history',
          cause: e,
        });
      }
    },
    { handler: 'history', method: 'GET', skipBodyParse: true },
  );

  // ── GET /api/history/:sha ─────────────────────────────────────────────────
  async function handleHistoryVersion(
    req: IncomingMessage,
    res: ServerResponse,
    sha: string,
  ): Promise<void> {
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'history-version',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }

    const shadow = shadowRef?.current;
    if (!shadow) {
      // 503 (not 400): shadow-repo unavailability is a server-side state,
      // matching the sync-not-active precedent.
      errorResponse(res, 503, 'urn:ok:error:shadow-not-configured', 'Shadow repo not configured.', {
        handler: 'history-version',
      });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const docName = url.searchParams.get('docName') ?? '';

    const resolvedContentRoot = contentRoot ?? '.';
    const pathResult = safeDocPath(docName, resolvedContentRoot);
    if ('error' in pathResult) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', pathResult.error, {
        handler: 'history-version',
      });
      return;
    }
    const sg = shadowGit(shadow);
    const branch = getCurrentBranch?.() ?? 'main';

    // Validate SHA format
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid commit SHA.', {
        handler: 'history-version',
      });
      return;
    }

    try {
      // Resolve the doc's historical path at this commit by walking the
      // rename chain (mirrors handleRollback + handleDiff). Without
      // this, requesting a pre-rename commit's content returns 404 even
      // though the timeline correctly shows the entry — the UI then falls
      // back to its "Diff unavailable" / "Document did not exist" rendering.
      const renameLogIndex = getOrLoadRenameLogIndex(shadow.gitDir);
      const ancestorCache = createAncestorShaSetCache();
      const historicalPath = await resolveDocPathAtCommit(
        shadow,
        docName,
        sha,
        branch,
        renameLogIndex,
        (name) => {
          const p = safeDocPath(name, resolvedContentRoot);
          return 'error' in p ? `${name}.md` : p.path;
        },
        ancestorCache,
      );
      if (historicalPath === null) {
        errorResponse(
          res,
          404,
          'urn:ok:error:doc-not-found',
          'Document did not exist at this version.',
          { handler: 'history-version' },
        );
        return;
      }

      const content = await sg.raw('show', `${sha}:${historicalPath}`);

      // Resolve commit metadata
      const logLine = (await sg.raw('log', '-1', '--format=%aI%x00%an', sha)).trim();
      const [timestamp = '', author = ''] = logLine.split('\x00');

      successResponse(
        res,
        200,
        HistoryVersionSuccessSchema,
        { sha, content, timestamp, author },
        { handler: 'history-version' },
      );
    } catch (e) {
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'history-version',
        cause: e,
      });
    }
  }

  // ── POST /api/rollback ────────────────────────────────────────────────────
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

      // Conflict-aware refusal. Rollback would route through
      // `replaceRawBody` and overwrite Y.Text — that's a structural
      // mutation that must not race the conflict-resolution machinery.
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

      // Server-mode availability check. Identity is extracted first so the
      // attribution-sweep ordering invariant holds: any errorResponse below
      // this point is post-identity. The emit is still anonymous on the
      // wire because identity is captured but never echoed.
      const shadow = shadowRef?.current;
      if (!shadow) {
        // 503 (not 400): shadow-repo unavailability is a server-side state,
        // matching the sync-not-active / shadow-not-configured precedent.
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
        // Resolve the doc's path at this commit, walking the rename chain
        // newest→oldest with cycle bound. The current name is probed
        // unbounded; predecessor names require commitSha ∈ ancestors(seeds(R))
        // to exclude post-rename name-reuse contamination.
        const renameLogIndex = getOrLoadRenameLogIndex(shadow.gitDir);
        const ancestorCache = createAncestorShaSetCache();
        const branch = getCurrentBranch?.() ?? 'main';
        const historicalPath = await resolveDocPathAtCommit(
          shadow,
          docName,
          commitSha,
          branch,
          renameLogIndex,
          (name) => {
            const p = safeDocPath(name, resolvedContentRoot);
            return 'error' in p ? `${name}.md` : p.path;
          },
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

        // snapshot current state before the destructive rollback
        await safetyCheckpoint(shadow, resolvedContentRoot, {
          action: 'rollback',
          context: { docName, targetSha: commitSha },
        });

        // Apply to live Y.Doc via updateYFragment (L1 persistence fires normally)
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

        // Rollback routes through the `replaceRawBody` sibling primitive
        // (precedent #38 — Y.Text-is-truth) which performs the full ytext
        // overwrite (`delete(0, len) + insert(0, markdown)`) FIRST and then
        // derives fragment via `parseWithFallback + updateYFragment`. The
        // overwrite (rather than DMP-incremental) signals "non-incremental
        // replacement" to `Y.UndoManager` so users cannot undo past the
        // rollback and recover content they explicitly discarded. The
        // primitive does NOT call `doc.transact` — the caller wraps for
        // atomicity AND per-session frozen origin object identity (precedent
        // #24, paired-write enforcement).
        const rollbackEmbedResolver = options.resolveEmbed
          ? { resolveEmbed: options.resolveEmbed, sourcePath: docName }
          : undefined;
        // Site A content-divergence gate for rollback — computed INSIDE the
        // transact, matching the write/patch gate. `ytext.toString()` here sees
        // `replaceRawBody`'s atomic post-state before observer settlement fires
        // on transact close, so a divergence signals a primitive regression
        // rather than a post-transact canonicalization artifact. `replaceRawBody`
        // writes `markdown` (the target-version bytes) verbatim, so byte-equality
        // is the contract; the converged bytes ride back on the warning's
        // `currentState` so the agent recovers without a re-read.
        let rollbackDivergence: AgentWriteContentDivergence | undefined;
        document.transact(() => {
          replaceRawBody(document, markdown, rollbackEmbedResolver);
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

        // NOTE: we deliberately do NOT call `setReconciledBase(docName, markdown)`
        // here. Setting the base before `onStoreDocument` has fired would trip the
        // "skip write when serialized === currentBase" guard at
        // `persistence.ts:onStoreDocument` and drop the L1 disk write entirely
        // — which also skips the following `scheduleGitCommit()`, orphaning any
        // `recordContributor(...)` entry we add below into the next unrelated
        // write's L2 commit.
        // Letting `onStoreDocument` fire naturally writes disk AND updates the
        // reconciled base, which is the correct order.

        // 4-way actor switch: agent records contributor with optional default
        // summary; principal records with the rollback subject; anonymous
        // skips recordContributor entirely (never default-attribute);
        // invalid-summary already returned above.
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
              `Unhandled actor kind in handleRollback: ${String((_exhaustive as { kind?: unknown }).kind)}`,
            );
          }
        }
        renameAttributionCounter().add(1, { kind: 'rollback', attribution_kind: actor.kind });

        // Force-flush L1 (onStoreDocument debounce) then L2 (git commit) so the
        // restored version + attribution appear in the timeline within ~100ms
        // rather than waiting for the natural ~4s L1+L2 debounce stack. Uses
        // the shared `flushDocToGit` helper (same pattern as the three
        // agent-write handlers) rather than a raw `flushGitCommit()` which
        // no-ops when no L2 timer is set yet.
        // Await the L1 disk store so a swallowed persistence failure surfaces
        // as an error instead of a false success. Mirrors agent-write-md.
        const flushOutcome = await flushDiskAndDetectOutcome(docName);
        if (flushOutcome?.kind === 'failure') {
          respondPersistenceFailure(res, flushOutcome.failure, 'rollback');
          return;
        }
        if (flushOutcome?.kind === 'divergence') {
          respondDiskDivergence(res, 'rollback');
          return;
        }

        flushDocToGit(docName, 'rollback');

        const duration = Date.now() - t0;
        getLogger('rollback').info(
          { docName, from: commitSha.slice(0, 8), durationMs: duration },
          'rollback',
        );

        // Only broadcast agent-focus push-nav when the caller explicitly
        // identified as an agent. UI-driven Restore (principal or anonymous)
        // must not trigger a cross-client push-nav as if an agent did the
        // rollback.
        if (actor.kind === 'agent') {
          agentFocusBroadcaster?.setFocus(actor.writerId, {
            agentName: actor.displayName,
            currentDoc: docName,
            writeKind: 'rollback-apply',
            ts: Date.now(),
          });
        }

        // Deliberately NO mermaid render entries here (unlike agent-write-md /
        // agent-patch): a rollback restores a known historical state the
        // caller explicitly selected — any broken fence in it predates the
        // restore and isn't this writer's authoring mistake to fix. The next
        // body write/edit to the doc surfaces it through the normal channel.
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
            // `warnings` is the unified advisory channel; the single-valued
            // `warning` is its deprecated alias, kept emitting in parallel.
            ...(rollbackDivergenceEntry
              ? { warning: rollbackDivergenceEntry, warnings: [rollbackDivergenceEntry] }
              : {}),
          },
          { handler: 'rollback' },
        );
      } catch (e) {
        // Generic title — raw `e.message` can leak FS paths / library internals.
        // The underlying message is forwarded to Pino via `cause` for ops triage.
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to roll back.', {
          handler: 'rollback',
          cause: e,
        });
      }
    },
    { handler: 'rollback', method: 'POST' },
  );

  const handleMetricsReconciliation = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        successResponse(res, 200, MetricsReconciliationSuccessSchema, getMetrics(), {
          handler: 'metrics-reconciliation',
        });
      } catch (e) {
        log.error({ err: e }, '[metrics-reconciliation] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'metrics-reconciliation',
          cause: e,
        });
      }
    },
    { handler: 'metrics-reconciliation', method: 'GET', skipBodyParse: true },
  );

  const handleMetricsParseHealth = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        successResponse(res, 200, MetricsParseHealthSuccessSchema, getParseHealth(), {
          handler: 'metrics-parse-health',
        });
      } catch (e) {
        log.error({ err: e }, '[metrics-parse-health] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'metrics-parse-health',
          cause: e,
        });
      }
    },
    { handler: 'metrics-parse-health', method: 'GET', skipBodyParse: true },
  );

  /**
   * GET /api/server-info
   *
   * Returns `{ ok, serverInstanceId, currentBranch, currentDiskAckSVs }`.
   * Called by the client's `ProviderPool` as a boot-time warmup BEFORE
   * any WebSocket provider opens, so the first provider's auth token
   * can carry `expectedServerInstanceId` and `expectedBranch` on the
   * very first connect (avoiding one "null-claim accept → broadcast →
   * populate cache → next connect claim" cycle on cold start).
   *
   * `currentBranch` is the late-join backstop for CC1's `branch-switched`
   * stateless broadcast — disconnected clients reconnecting compare it
   * against their last-observed branch and trigger `handleBranchSwitched`
   * on mismatch (also surfaced as the `expectedBranch` auth-token claim,
   * see `auth-token-schema.ts`). Always populated — `getActiveBranch()`
   * defaults to `'main'` when git is disabled.
   *
   * Gated on `ready` for the same reason `handleDocumentList` is: the
   * boot-time `switchReconciledBaseScope(startupBranch)` lives inside
   * `initAsync` (server-factory.ts), and a renderer that fetches before
   * it runs would observe the module-level `'main'` default instead of
   * the actual HEAD branch. The renderer's `current-branch-store` is
   * fire-once and only updates from CC1 `branch-switched`, so a stale
   * cold-start fetch sticks until a real cross-branch checkout.
   *
   * `currentDiskAckSVs` is the late-join backstop for the per-doc CC1
   * `disk-ack` channel — same recovery shape as `currentBranch` but the
   * per-doc state vector watermark used by mismatch-recycle baseline-
   * selection. Omitted in dev/plugin mode (no CC1 broadcaster).
   *
   * Gating: protected by the global `/api/*` Origin allowlist (CSRF
   * guard against cross-origin browsers). No-Origin requests (curl,
   * server-to-server, LAN peers using non-browser tooling) pass through
   * — the same posture as the rest of the read-side `/api/*` surface
   * (`/api/documents`, `/api/document`, `/api/pages`, `/api/backlinks`).
   * Disclosure shape: `serverInstanceId` is a per-process random UUID;
   * `currentBranch` matches the workspace's git history; the SV map
   * enumerates the same docName set as `/api/documents` plus per-
   * client Lamport op counts (random clientID, no wall-clock).
   * Single-user-loopback deployment model is documented in
   * `server-factory.ts` near the principalAuthExtension; hosted/multi-
   * tenant deployments must wrap this entire `/api/*` class with
   * authentication and per-caller scoping.
   */
  const handleServerInfo = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        // Park until `initAsync` has called `switchReconciledBaseScope` with
        // the resolved HEAD branch. Without this gate, a renderer that fetches
        // during the boot window reads the persistence module's `'main'`
        // default and caches it in `current-branch-store` for the lifetime of
        // the session. Mirrors the `handleDocumentList` gate; `.catch()` keeps
        // the handler responsive on a degraded boot.
        if (ready) {
          await ready.catch((err: unknown) => {
            log.warn(
              { err, handler: 'server-info' },
              '[api] ready gate rejected — responding with current state',
            );
          });
        }
        const currentBranch = getActiveBranch();
        // `getDiskAckSVs` is wired by standalone boot; plugin mode (dev
        // server) doesn't have a CC1Broadcaster and omits the field. The
        // schema's `.optional()` keeps the response shape valid in both
        // cases without a separate "no broadcaster" branch on the client.
        const currentDiskAckSVs = getDiskAckSVs?.();
        // Boot-phase timings (desktop startup instrumentation). Present only
        // when the boot path called `startBootTimings` (standalone `bootServer`);
        // the dev-server / plugin path leaves it `undefined`, so the schema's
        // `.optional()` keeps the response valid. All bounded numbers — safe to
        // disclose (per-process timing, no paths/content).
        const boot = getBootTimings();
        // `Cache-Control: no-store` matches the disclosure semantics: every
        // field is per-process / per-moment state. A back/forward-cached
        // 304 carrying a stale `currentDiskAckSVs` could silently corrupt
        // the recycle baseline-selection on the next mismatch.
        successResponse(
          res,
          200,
          ServerInfoSuccessSchema,
          {
            serverInstanceId,
            currentBranch,
            ...(currentDiskAckSVs !== undefined ? { currentDiskAckSVs } : {}),
            ...(boot !== undefined ? { boot } : {}),
          },
          {
            handler: 'server-info',
            extraHeaders: { 'Cache-Control': 'no-store' },
          },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'server-info',
          cause: e,
        });
      }
    },
    { handler: 'server-info', method: 'GET', skipBodyParse: true },
  );

  async function handlePrincipal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Loopback + Host-header gate. The principal record discloses operator
    // PII — `display_name` (real name) and `display_email` — sourced from
    // local `git config`. Under `--host 0.0.0.0` (demos, shared dev boxes,
    // Codespaces) this would otherwise be readable by any LAN peer or
    // cross-origin page that bypasses the Origin allowlist (non-browser
    // callers send no `Origin` header). Matches the same gate
    // `handleMetricsAgentPresence` and `handleWorkspace` apply.
    // Authorization runs BEFORE method dispatch so a bad Host never leaks
    // "verb the endpoint expects" via the 405 response (OWASP ASVS V4.1.1).
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
        handler: 'principal',
      });
      return;
    }
    if (!isAllowedWorkspaceHostHeader(req.headers.host)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler: 'principal',
      });
      return;
    }
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'principal',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    const principal = getPrincipal?.() ?? null;
    if (!principal) {
      errorResponse(res, 404, 'urn:ok:error:principal-not-available', 'Principal not available.', {
        handler: 'principal',
      });
      return;
    }
    successResponse(res, 200, PrincipalSuccessSchema, principal, { handler: 'principal' });
  }

  async function handleMetricsAgentPresence(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Loopback + Host-header gate — matches /api/workspace. The presence map
    // exposes per-agent identity (`displayName` — operator-configured AGENT
    // label) and the workspace-relative path each agent is currently writing
    // to (`currentDoc`). Those are local-editing-only signals; if a user
    // deploys to `0.0.0.0` / reverse-proxies the port, cross-origin pages or
    // LAN peers MUST NOT be able to read the map. Authorization runs before
    // method dispatch so a bad Host never leaks "verb the endpoint expects"
    // via 405 (same pattern + rationale as handleWorkspace — see its
    // comment block for the ASVS / DNS-rebinding background).
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
        handler: 'metrics-agent-presence',
      });
      return;
    }
    if (!isAllowedWorkspaceHostHeader(req.headers.host)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler: 'metrics-agent-presence',
      });
      return;
    }
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'metrics-agent-presence',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    try {
      // Pre-filter stale entries using the same threshold the broadcaster
      // uses for opportunistic eviction (runs inside setPresence). Eviction
      // is write-triggered — if the last agent disconnects without the
      // keepalive close firing (proxy ate the frame, `-9` kill) and no other
      // agent writes after, the raw map keeps the zombie entry. Clients
      // already filter with their own 5s TTL so this is invisible to the
      // bar, but `/api/metrics/agent-presence` would otherwise lie to
      // operators. Filtering here matches what a "live" read returns
      // without paying for a sparse timer.
      const rawPresence = agentPresenceBroadcaster?.getPresenceMap() ?? {};
      const now = Date.now();
      const presence: typeof rawPresence = {};
      for (const [agentId, entry] of Object.entries(rawPresence)) {
        if (now - entry.ts < BROADCASTER_EVICTION_MS) {
          presence[agentId] = entry;
        }
      }
      successResponse(
        res,
        200,
        MetricsAgentPresenceSuccessSchema,
        { presence },
        { handler: 'metrics-agent-presence' },
      );
    } catch (e) {
      log.error({ err: e }, '[metrics-agent-presence] handler failed');
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'metrics-agent-presence',
        cause: e,
      });
    }
  }

  async function handleEmbedDetect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Diagnostic endpoint for the Cursor / Codex / Claude Code embedded-viewer
    // detection spikes. Reads from the in-process ring buffer populated in
    // `onRequest` and surfaces boolean signals derived from the most recent
    // entry's UA. Loopback + Host-header gated — same pattern as
    // `handlePrincipal` / `handleMetricsAgentPresence`. Disclosed fields
    // (full request headers, remote address) are local-editing-only signals.
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
        handler: 'embed-detect',
      });
      return;
    }
    if (!isAllowedWorkspaceHostHeader(req.headers.host)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler: 'embed-detect',
      });
      return;
    }
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'embed-detect',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    const entries = embedProbeRing.read();
    successResponse(
      res,
      200,
      EmbedDetectSuccessSchema,
      {
        entries,
        count: entries.length,
        detection: deriveDetection(entries[0]),
      },
      { handler: 'embed-detect' },
    );
  }

  async function handleWorkspace(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Authorization runs BEFORE method dispatch: reversing the order turns the
    // method check into a fingerprinting oracle for unauth callers (GET → 403,
    // POST → 405 discloses the verb the endpoint expects). See OWASP ASVS 4.0
    // V4.1.1 — "perform access control on every request."
    //
    // Loopback-only: this endpoint discloses the absolute host filesystem path
    // (including home directory / username). That's fine for the local-editing
    // use case the rest of the API is designed for, but if the user configures
    // `server.host: 0.0.0.0` (demos, shared dev boxes, Codespaces), we do NOT
    // want to leak the host shape over the network or to cross-origin fetches.
    // All loopback clients (including requests from a browser on the same
    // machine) pass — connections from other interfaces are refused.
    //
    // DNS-rebinding defense: `req.socket.remoteAddress` will read `127.0.0.1`
    // for any request that reached the socket via loopback, including requests
    // triggered by a malicious page that rebinds its hostname to `127.0.0.1`.
    // The Host-header allowlist below enforces that the caller actually spoke
    // to us via `localhost` / `127.0.0.1` / `[::1]`, matching the mitigation
    // in the Ethereum/geth JSON-RPC lineage. Same-origin fetches from the
    // editor app pass; cross-origin rebinding attempts are refused.
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
        handler: 'workspace',
      });
      return;
    }
    if (!isAllowedWorkspaceHostHeader(req.headers.host)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler: 'workspace',
      });
      return;
    }
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'workspace',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    // Absolute, canonical contentDir so the client can build full filesystem
    // paths (e.g. for the sidebar 'Copy path > Full path' action). Symlinks in
    // the workspace root are resolved via realpath so the path matches on-disk
    // truth. We treat error kinds in line with the persistence layer's symlink
    // contract:
    //   - ENOENT: contentDir missing on disk → 200 with `symlinkResolved: false`
    //     and the unresolved path. Lets "Copy Path" still produce a meaningful
    //     value when the directory was deleted between server start and this
    //     request; the client decides whether to act on it.
    //   - ELOOP / EACCES / anything else: real filesystem error → 500. Matches
    //     persistence's stricter policy (cyclic symlinks are rejected
    //     everywhere) and avoids handing the user a path that won't resolve.
    const resolvedRoot = resolve(contentDir);
    let resolvedContentDir = resolvedRoot;
    let symlinkResolved = true;
    try {
      resolvedContentDir = realpathSync(resolvedRoot);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        console.warn('[workspace] contentDir does not exist; returning unresolved path', {
          path: resolvedRoot,
        });
        symlinkResolved = false;
      } else {
        console.warn('[workspace] realpath failed for contentDir', { path: resolvedRoot, err });
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Workspace realpath failed.',
          { handler: 'workspace', detail: code ?? undefined, cause: err },
        );
        return;
      }
    }
    // `pathSeparator` lets the client build full paths without guessing from
    // the shape of `contentDir` (which breaks on Windows + forward-slash paths
    // and on POSIX folders that contain a literal backslash in the name).
    successResponse(
      res,
      200,
      WorkspaceSuccessSchema,
      {
        contentDir: resolvedContentDir,
        pathSeparator: sep,
        symlinkResolved,
      },
      { handler: 'workspace' },
    );
  }

  const handleAsset = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const assetPath = url.searchParams.get('path');
        if (!assetPath || assetPath.includes('\0')) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing asset path.', {
            handler: 'asset',
          });
          return;
        }
        const contentType = assetContentTypeForPath(assetPath);
        const assetExt = extname(assetPath).slice(1).toLowerCase();
        if (!contentType || !ASSET_EXTENSIONS.has(assetExt)) {
          errorResponse(
            res,
            415,
            'urn:ok:error:unsupported-asset-type',
            'Unsupported asset type.',
            { handler: 'asset' },
          );
          return;
        }
        const resolvedContentDir = realpathSync(contentDir);
        const requestedPath = resolve(resolvedContentDir, assetPath);
        let canonicalPath: string;
        try {
          canonicalPath = realpathSync(requestedPath);
        } catch {
          errorResponse(res, 404, 'urn:ok:error:asset-not-found', 'Asset not found.', {
            handler: 'asset',
          });
          return;
        }
        if (!isWithinContentDir(canonicalPath, resolvedContentDir)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid asset path.', {
            handler: 'asset',
          });
          return;
        }
        let stat: ReturnType<typeof statSync>;
        try {
          stat = statSync(canonicalPath);
        } catch {
          errorResponse(res, 404, 'urn:ok:error:asset-not-found', 'Asset not found.', {
            handler: 'asset',
          });
          return;
        }
        if (!stat.isFile()) {
          errorResponse(res, 404, 'urn:ok:error:asset-not-found', 'Asset not found.', {
            handler: 'asset',
          });
          return;
        }
        const relativePath = toContentRelativePath(resolvedContentDir, canonicalPath);
        if (relativePath !== assetPath.split('\\').join('/')) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid asset path.', {
            handler: 'asset',
          });
          return;
        }
        // Direct asset fetches honor the same `.gitignore` / `.okignore`
        // exclusions the `createAssetServeMiddleware` admission path
        // applies — without this, ignore patterns hide assets from the
        // sidebar and SPA but still let `/api/asset?path=...` serve them.
        // 404 (not 403) so the wire shape is identical to "missing file"
        // — exclusion is opaque.
        //
        // Use `isPathIgnored` rather than `isExcluded` so the sibling-asset
        // heuristic does not reject legitimate cross-directory references
        // (e.g., `docs/media/diagram.png` referenced from `docs/guide.md`
        // when `docs/media/` has no sibling `.md` of its own).
        if (contentFilter?.isPathIgnored(relativePath)) {
          errorResponse(res, 404, 'urn:ok:error:asset-not-found', 'Asset not found.', {
            handler: 'asset',
          });
          return;
        }
        // `html`/`htm` render inline ONLY inside the sandbox CSP below — they
        // are intentionally absent from INLINE_RENDERABLE_EXTENSIONS so no other
        // branch serves them as a plain same-origin document.
        const isSandboxedHtml = SANDBOXED_HTML_EXTENSIONS.has(assetExt);
        const headers: Record<string, string> = {
          'Content-Type': contentType,
          'Content-Length': String(stat.size),
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition':
            INLINE_RENDERABLE_EXTENSIONS.has(assetExt) || isSandboxedHtml ? 'inline' : 'attachment',
          'Cache-Control': 'no-store',
        };
        if (assetExt === 'svg') {
          headers['Content-Security-Policy'] =
            "sandbox; default-src 'none'; style-src 'unsafe-inline'";
        } else if (isSandboxedHtml) {
          // Opaque sandboxed origin (scripts run, no OK cookies/storage) +
          // `connect-src 'none'` so the document can't reach OK's loopback API
          // (which allowlists the sandboxed `Origin: null`) or exfiltrate. See
          // `SANDBOXED_HTML_CSP`. Mirrors the serve middleware.
          headers['Content-Security-Policy'] = SANDBOXED_HTML_CSP;
        }
        res.writeHead(200, headers);
        try {
          await pipeline(createReadStream(canonicalPath), res);
        } catch (streamError) {
          // `writeHead(200)` ran above so `res.headersSent` is always true
          // here — the only correct cleanup is to destroy the socket so
          // the client sees a connection-level failure rather than a
          // truncated 200 with no error signal. Log structured before
          // destroying so a silent stream failure can still be triaged
          // from telemetry (the client-facing destruction is the only
          // wire signal it gets).
          log.error(
            {
              event: 'api.asset.pipeline-failed',
              handler: 'asset',
              assetPath,
              err: streamError,
            },
            '[asset] pipeline failed mid-stream',
          );
          if (!res.destroyed) {
            res.destroy(streamError instanceof Error ? streamError : undefined);
          }
        }
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'asset',
          cause: e,
        });
      }
    },
    { handler: 'asset', method: 'GET', skipBodyParse: true },
  );

  /**
   * Sibling of `handleAsset` for the in-editor `TextViewer` ("Open with
   * built-in text editor" affordance). The asset endpoint gates on
   * `ASSET_EXTENSIONS` + a per-extension MIME mapping — that's load-
   * bearing for the inline-render path (every entry there has been
   * privilege-reviewed against the stored-XSS class). The text viewer,
   * by contrast, fetches the file via XHR and renders the bytes through
   * a sandboxed CodeMirror — `Content-Disposition` doesn't matter and
   * the extension allowlist would only block legitimate inspection of
   * arbitrary text-shaped files (`.yaml`, `.csv`, `.ini`, dotfiles like
   * `.DS_Store`, the long tail).
   *
   * Security posture: same path-safety (`realpath` + `isWithinContentDir`)
   * as `handleAsset`. The differences:
   *   - NO `ASSET_EXTENSIONS` admission gate — any extension is OK.
   *   - NO `.gitignore` / `.okignore` ignore-filter — the user reaches
   *     this endpoint only by clicking "Open with built-in text editor"
   *     on a file they can already see in the sidebar (which is gated
   *     on `showAll` for ignored files), so re-applying the filter here
   *     blocks the legitimate "I know it's hidden, I want to read it"
   *     workflow that surfaced `.DS_Store` / dotfiles / build artifacts.
   *     Path-safety (no escape from contentDir) remains the load-bearing
   *     check.
   *   - 1 MB cap on the response body so a stray multi-GB log file
   *     can't OOM the browser viewer.
   *   - Forces `Content-Type: text/plain; charset=utf-8` regardless of
   *     the file's MIME (we control the viewer; mis-typed bytes are
   *     irrelevant because the bytes are never executed).
   */
  const TEXT_VIEW_MAX_BYTES = 1_048_576; // 1 MiB
  const handleAssetText = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const assetPath = url.searchParams.get('path');
        if (!assetPath || assetPath.includes('\0')) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing asset path.', {
            handler: 'asset-text',
          });
          return;
        }
        const resolvedContentDir = realpathSync(contentDir);
        const requestedPath = resolve(resolvedContentDir, assetPath);
        let canonicalPath: string;
        try {
          canonicalPath = realpathSync(requestedPath);
        } catch (e) {
          errorResponse(res, 404, 'urn:ok:error:asset-not-found', 'Asset not found.', {
            handler: 'asset-text',
            cause: e,
          });
          return;
        }
        if (!isWithinContentDir(canonicalPath, resolvedContentDir)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid asset path.', {
            handler: 'asset-text',
          });
          return;
        }
        let fileStat: ReturnType<typeof statSync>;
        try {
          fileStat = statSync(canonicalPath);
        } catch (e) {
          errorResponse(res, 404, 'urn:ok:error:asset-not-found', 'Asset not found.', {
            handler: 'asset-text',
            cause: e,
          });
          return;
        }
        if (!fileStat.isFile()) {
          errorResponse(res, 404, 'urn:ok:error:asset-not-found', 'Asset not found.', {
            handler: 'asset-text',
          });
          return;
        }
        const relativePath = toContentRelativePath(resolvedContentDir, canonicalPath);
        if (relativePath !== assetPath.split('\\').join('/')) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid asset path.', {
            handler: 'asset-text',
          });
          return;
        }
        if (fileStat.size > TEXT_VIEW_MAX_BYTES) {
          errorResponse(
            res,
            413,
            'urn:ok:error:payload-too-large',
            `File exceeds the ${TEXT_VIEW_MAX_BYTES}-byte text-viewer cap.`,
            { handler: 'asset-text' },
          );
          return;
        }
        const bytes = await readFile(canonicalPath);
        const text = bytes.toString('utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'inline',
          'Cache-Control': 'no-store',
        });
        res.end(text);
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'asset-text',
          cause: e,
        });
      }
    },
    { handler: 'asset-text', method: 'GET', skipBodyParse: true },
  );

  /** 24h in milliseconds — rescue buffers older than this are excluded/cleaned. */
  const RESCUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  const handleRescueList = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        if (!shadowRef?.current) {
          // No shadow repo configured = no rescue buffers; emit empty list (success).
          successResponse(res, 200, RescueListSuccessSchema, [], { handler: 'rescue-list' });
          return;
        }

        const now = Date.now();
        // `source: 'flat'` rows came from the shutdown-flush path (retained flat-
        // file); `source: 'timeline'` rows came from reconcile-delete /
        // branch-switch (migrated to saveInMemoryCheckpoint). Clients
        // can treat both as interchangeable unless they need the checkpoint sha.
        const entries: (RescueEntryFlat | (RescueEntryTimeline & TimelineRescueEntry))[] = [];

        const rescueDir = resolve(shadowRef.current.gitDir, 'rescue');
        if (existsSync(rescueDir)) {
          try {
            const files = readdirSync(rescueDir).filter((f) => isSupportedDocFile(f));
            for (const file of files) {
              const filePath = resolve(rescueDir, file);
              const stat = statSync(filePath);
              const age = now - stat.mtimeMs;

              if (age > RESCUE_MAX_AGE_MS) {
                try {
                  unlinkSync(filePath);
                } catch (e) {
                  console.debug('[rescue] cleanup failed (non-critical):', e);
                }
                continue;
              }

              entries.push({
                docName: stripDocExtension(file),
                timestamp: stat.mtime.toISOString(),
                size: stat.size,
                source: 'flat',
              });
            }
          } catch (err) {
            log.error({ err }, '[rescue] Failed to list flat-file rescue buffers');
          }
        }

        // Timeline-ref source — merged in so the unified response surfaces all
        // three rescue classes once the write migration ships.
        try {
          const branch = getCurrentBranch?.() ?? 'main';
          const timelineEntries = await listRescueCheckpoints(shadowRef.current, branch);
          for (const t of timelineEntries) {
            entries.push({ ...t, source: 'timeline' });
          }
        } catch (err) {
          log.error({ err }, '[rescue] Failed to list timeline-ref rescue checkpoints');
        }

        successResponse(res, 200, RescueListSuccessSchema, entries, { handler: 'rescue-list' });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'rescue-list',
          cause: e,
        });
      }
    },
    { handler: 'rescue-list', method: 'GET', skipBodyParse: true },
  );

  const handleCreatePage = withValidation(
    CreatePageRequestSchema,
    async (_req, res, body) => {
      try {
        const bodyObj = body as unknown as Record<string, unknown>;
        // Identity boundary: only attribute when the caller explicitly supplies
        // agentId. UI-driven creates fall through to the loaded principal (if
        // any) or anonymous — never to a synthetic 'Claude' default. Mirrors
        // handleRollback / handleRenamePath.
        const actor = extractActorIdentity(bodyObj, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'create-page',
          });
          return;
        }

        const filePath = body.path;
        if (!isSupportedDocFile(filePath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'path must end with .md or .mdx.',
            { handler: 'create-page' },
          );
          return;
        }
        if (
          filePath.includes('..') ||
          filePath.startsWith('/') ||
          filePath.includes('\x00') ||
          filePath.includes('\\')
        ) {
          errorResponse(res, 400, 'urn:ok:error:path-escape', 'Invalid path.', {
            handler: 'create-page',
            detail: 'path must not contain .. or start with /',
          });
          return;
        }
        const resolvedContentDir = resolve(contentDir);
        const fullPath = resolve(resolvedContentDir, filePath);
        if (!isWithinDir(fullPath, resolvedContentDir)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:path-escape',
            'path must not escape content directory.',
            { handler: 'create-page' },
          );
          return;
        }
        const candidateDocName = stripDocExtension(filePath);
        if (isSystemDoc(candidateDocName) || isConfigDoc(candidateDocName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${candidateDocName}' is a reserved document name.`,
            { handler: 'create-page' },
          );
          return;
        }
        // Reject managed-artifact + reserved-directory targets. Now that
        // `.ok/skills/**` is indexed/served content, a raw create-page into
        // `.ok/skills/<name>/SKILL.md` would write directly with ZERO skill-schema
        // validation (no name/description checks, no XML-tag ban) and surface as a
        // malformed phantom skill. Skills/templates must go through their own
        // validating write/install spines; every other `.ok/` child is excluded
        // from the content scope anyway. The reserved-path test catches raw
        // filesystem paths with a `.ok`/`.git` segment at any depth;
        // `isManagedArtifactDocName` catches the synthetic `__skill__/` /
        // `__template__/` doc-name forms.
        if (isReservedProjectStatePath(filePath) || isManagedArtifactDocName(candidateDocName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${candidateDocName}' is a reserved document name.`,
            {
              handler: 'create-page',
              detail:
                'Cannot create a page inside .ok or .git — skills and templates are authored through their own validating flows.',
            },
          );
          return;
        }
        // Optional template parameter: when set, instantiate the new
        // doc from the resolved template's body (with {{date}} / {{user}}
        // substitution applied) instead of an empty file. Resolution walks
        // the parent folder's templates_available[] — local + inherited,
        // closest-wins.
        const templateName =
          typeof (body as Record<string, unknown>).template === 'string'
            ? ((body as Record<string, unknown>).template as string).trim()
            : '';
        let initialContent = '';
        let templateScopeForLog: 'local' | 'inherited' | undefined;
        if (templateName.length > 0) {
          if (!/^[A-Za-z0-9_-]+$/.test(templateName)) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Template name must match [A-Za-z0-9_-]+.',
              { handler: 'create-page' },
            );
            return;
          }
          const parentFolder = filePath.includes('/')
            ? filePath.slice(0, filePath.lastIndexOf('/'))
            : '';
          const available = resolveTemplatesAvailable(resolvedContentDir, parentFolder);
          const matched = available.find((t) => t.name === templateName);
          if (!matched) {
            const availableLabel =
              available.length === 0
                ? '(none)'
                : available.map((t) => `"${t.name}" (${t.scope})`).join(', ');
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              `Template "${templateName}" does not resolve for folder "${parentFolder || '(root)'}". Available: ${availableLabel}`,
              { handler: 'create-page' },
            );
            return;
          }
          const templateAbs = resolve(resolvedContentDir, matched.path);
          let templateRaw: string;
          try {
            templateRaw = readFileSync(templateAbs, 'utf-8');
          } catch (err) {
            errorResponse(
              res,
              500,
              'urn:ok:error:internal-server-error',
              `Failed to read template at ${matched.path}.`,
              { handler: 'create-page', cause: err },
            );
            return;
          }
          // The new doc IS the template's starter content (doc-frontmatter +
          // markdown) with the `template:` identity stripped. `instantiateDoc`
          // normalizes single-block and legacy two-block templates the same way
          // and preserves `{{date}}`/`{{user}}` tokens verbatim for substitution.
          const templateStarter = instantiateDoc(templateRaw);
          // {{user}} substitutes the calling principal's display name; falls
          // back to empty string when no principal is loaded.
          const userDisplayName =
            actor.kind === 'agent' || actor.kind === 'principal' ? (actor.displayName ?? '') : '';
          initialContent = applySubstitution(templateStarter, {
            date: todayIsoUtc(),
            user: userDisplayName,
          });
          templateScopeForLog = matched.scope;
        }

        mkdirSync(dirname(fullPath), { recursive: true });
        try {
          writeFileSync(fullPath, initialContent, { encoding: 'utf-8', flag: 'wx' });
        } catch (err) {
          if (isAlreadyExistsError(err)) {
            errorResponse(res, 409, 'urn:ok:error:doc-already-exists', 'File already exists.', {
              handler: 'create-page',
              cause: err,
            });
            return;
          }
          throw err;
        }
        const docName = stripDocExtension(filePath);
        // Eager invalidation: legitimate recreation at a recently-renamed or
        // recently-deleted name drops the stale cache entry so the next
        // connection admits cleanly. No-op when absent.
        recentlyRemovedDocs?.delete(docName);
        // Synchronously bump the content filter's sibling-asset dirCount so any
        // sibling asset drop that follows is admitted by the `LINKABLE_ASSET_EXTENSIONS`
        // rule. The file watcher's `create` event will also increment later,
        // which would double-count — so we also `registerWrite` to mark this
        // as a self-write, and the watcher skips its own `incrementMdDir` on
        // self-writes. See file-watcher.ts for the paired logic.
        if (contentFilter) {
          contentFilter.incrementMdDir(dirname(docName));
        }
        registerWrite(fullPath, contentHash(initialContent));
        switch (actor.kind) {
          case 'agent':
          case 'principal':
            recordContributor(
              docName,
              actor.writerId,
              actor.displayName,
              actor.colorSeed,
              undefined,
              actor.actor,
            );
            break;
          case 'anonymous':
            // UI-driven create with no loaded principal — no contributor recorded.
            break;
          default: {
            const _exhaustive: never = actor;
            throw new Error(
              `Unhandled actor kind in handleCreatePage: ${String((_exhaustive as { kind?: unknown }).kind)}`,
            );
          }
        }
        mutateFileIndex?.({ kind: 'create', path: fullPath, docName, content: initialContent });
        if (backlinkIndex) {
          backlinkIndex.updateDocumentFromMarkdown(docName, initialContent);
          void backlinkIndex.saveToDisk().catch((err) => {
            console.warn(`[backlinks] Failed to persist create-page cache for ${docName}:`, err);
          });
          signalChannel?.('backlinks');
          signalChannel?.('graph');
        }
        signalChannel?.('files');
        if (templateScopeForLog !== undefined) {
          // Cardinality-bounded structured event — `templateScope` is one of
          // two values; `templateName` is bounded by the user's actual
          // templates. Mirrors the structured-event style in activity-log.ts.
          console.warn(
            JSON.stringify({
              event: 'template-instantiate',
              templateName,
              templateScope: templateScopeForLog,
              docName,
            }),
          );
        }
        successResponse(res, 200, CreatePageSuccessSchema, { docName }, { handler: 'create-page' });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to create page.', {
          handler: 'create-page',
          cause: e,
        });
      }
    },
    { handler: 'create-page', method: 'POST' },
  );

  const handleCreateFolder = withValidation(
    CreateFolderRequestSchema,
    async (_req, res, body) => {
      try {
        const bodyObj = body as unknown as Record<string, unknown>;
        const actor = extractActorIdentity(bodyObj, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'create-folder',
          });
          return;
        }
        const folderPath = body.path;
        if (!isValidRelativeContentPath(folderPath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'path must be a relative content path.',
            { handler: 'create-folder' },
          );
          return;
        }
        if (isReservedProjectStatePath(folderPath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            '.ok and .git are reserved directories.',
            { handler: 'create-folder' },
          );
          return;
        }
        if (contentFilter?.isDirExcluded(folderPath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Destination folder is excluded by the workspace content config.',
            { handler: 'create-folder' },
          );
          return;
        }

        const fullPath = resolveContentEntryPath(contentDir, 'folder', folderPath);
        if (existsSync(fullPath)) {
          errorResponse(res, 409, 'urn:ok:error:doc-already-exists', 'Folder already exists.', {
            handler: 'create-folder',
          });
          return;
        }

        tracedMkdirSync(fullPath, { recursive: true });
        upsertFolderIndexPathSegments(folderPath);
        signalChannel?.('files');
        successResponse(
          res,
          200,
          CreateFolderSuccessSchema,
          { path: folderPath },
          { handler: 'create-folder' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to create folder.', {
          handler: 'create-folder',
          cause: e,
        });
      }
    },
    { handler: 'create-folder', method: 'POST' },
  );

  const handleDuplicatePath = withValidation(
    DuplicatePathRequestSchema,
    async (_req, res, body) => {
      try {
        const bodyObj = body as unknown as Record<string, unknown>;
        const actor = extractActorIdentity(bodyObj, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'duplicate-path',
          });
          return;
        }

        const { kind } = body;
        const requestedPath = body.path;
        const requestedDocName = kind === 'file' ? stripDocExtension(requestedPath) : requestedPath;
        if (!isValidRelativeContentPath(requestedPath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'path must be a relative content path.',
            { handler: 'duplicate-path' },
          );
          return;
        }
        if (
          isReservedProjectStatePath(requestedPath) ||
          (kind === 'file' && (isSystemDoc(requestedDocName) || isConfigDoc(requestedDocName))) ||
          (kind === 'folder' && isReservedSyntheticFolderPath(requestedPath))
        ) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            'Reserved paths cannot be duplicated.',
            { handler: 'duplicate-path' },
          );
          return;
        }

        if (kind === 'file') {
          probeAndRegisterSourceFileExtension(contentDir, requestedPath);
        }
        const sourcePath = resolveContentEntryPath(contentDir, kind, requestedPath);
        if (!existsSync(sourcePath)) {
          if (kind === 'file') {
            const folderSourcePath = resolveContentEntryPath(contentDir, 'folder', requestedPath);
            if (existsSync(folderSourcePath) && statSync(folderSourcePath).isDirectory()) {
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                `Target path is not a ${kind}.`,
                { handler: 'duplicate-path' },
              );
              return;
            }
          }
          errorResponse(res, 404, 'urn:ok:error:doc-not-found', `${kind} does not exist.`, {
            handler: 'duplicate-path',
          });
          return;
        }
        const sourceStat = statSync(sourcePath);
        if (
          (kind === 'file' && !sourceStat.isFile()) ||
          (kind === 'folder' && !sourceStat.isDirectory())
        ) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', `Target path is not a ${kind}.`, {
            handler: 'duplicate-path',
          });
          return;
        }

        // Conflict-aware refusal. Duplicating a conflicted source would
        // copy the raw `<<<<<<< HEAD` / `=======` / `>>>>>>>` marker bytes
        // from disk into a new file at the destination, producing a broken
        // duplicate. Refuse with 409; the user must resolve the conflict
        // first. Dual-source check mirrors handleRenamePath /
        // handleDeletePath — `hocuspocus.documents.get()` returns undefined
        // for evicted docs; the ConflictStore fallback catches that case.
        // Enumerate from disk (not the lagging file index) so the conflict
        // gate sees every on-disk child of the folder — the chokidar watcher
        // populates the index asynchronously, so right after a fresh
        // `write` create the index lags and a conflicted child would
        // be silently skipped, copying its marker bytes intact. Same root
        // cause and fix as handleRenamePath's pre-check. Also registers
        // each child's on-disk extension for extension-less legacy docNames.
        const duplicateSourceDocNames =
          kind === 'file'
            ? [docNameForFileOperationPath(contentDir, requestedPath)]
            : listManagedDocNamesUnderFolderFromDisk(
                resolveContentEntryPath(contentDir, 'folder', requestedPath),
              );
        const duplicateEngine = getSyncEngine?.();
        const duplicateTrackedFiles = new Set(
          duplicateEngine ? duplicateEngine.getConflicts().map((c) => c.file) : [],
        );
        for (const affected of duplicateSourceDocNames) {
          const affectedDocName = affected;
          const doc = hocuspocus.documents.get(affectedDocName);
          const filePath = docNameToRelativePath(affectedDocName);
          const conflictedByLifecycle = doc !== undefined && isDocInConflict(doc);
          const conflictedByStore = duplicateTrackedFiles.has(filePath);
          if (conflictedByLifecycle || conflictedByStore) {
            respondDocInConflict(res, new DocInConflictError({ file: filePath }), 'duplicate-path');
            return;
          }
        }

        let duplicatedPath: string;
        let duplicatedDocNames: string[] = [];

        if (kind === 'file') {
          const sourceExtension = extname(sourcePath);
          const next = nextAvailableDuplicateDocName(contentDir, requestedDocName);
          duplicatedPath = next.docName;
          if (
            isSystemDoc(duplicatedPath) ||
            isConfigDoc(duplicatedPath) ||
            contentFilter?.isExcluded(`${duplicatedPath}${sourceExtension}`)
          ) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Duplicated document destination is excluded by the project content config.',
              { handler: 'duplicate-path' },
            );
            return;
          }
          const destinationPath = resolveDuplicateDocPath(
            contentDir,
            duplicatedPath,
            sourceExtension,
          );
          const content = readFileSync(sourcePath, 'utf-8');
          const destinationDir = dirname(destinationPath);
          const destinationDirExisted = existsSync(destinationDir);
          try {
            tracedMkdirSync(destinationDir, { recursive: true });
            tracedWriteFileSync(destinationPath, content, { encoding: 'utf-8', flag: 'wx' });
          } catch (err) {
            if (isAlreadyExistsError(err)) {
              errorResponse(
                res,
                409,
                'urn:ok:error:doc-already-exists',
                'A file at the duplicate destination already exists.',
                { handler: 'duplicate-path', cause: err },
              );
              return;
            }
            if (!destinationDirExisted) {
              try {
                tracedRmdirSync(destinationDir);
              } catch (cleanupErr) {
                const cleanupCode = (cleanupErr as NodeJS.ErrnoException).code;
                if (cleanupCode !== 'ENOENT' && cleanupCode !== 'ENOTEMPTY') {
                  console.warn('[duplicate-path] failed to clean duplicate parent directory:', {
                    destinationDir,
                    err: cleanupErr,
                  });
                }
              }
            }
            throw err;
          }
          let didIncrementMdDir = false;
          try {
            registerDocExtension(duplicatedPath, sourceExtension);
            recentlyRemovedDocs?.delete(duplicatedPath);
            if (contentFilter) {
              contentFilter.incrementMdDir(dirname(duplicatedPath));
              didIncrementMdDir = true;
            }
            registerWrite(destinationPath, contentHash(content));
            mutateFileIndex?.({
              kind: 'create',
              path: destinationPath,
              docName: duplicatedPath,
              content,
            });
            backlinkIndex?.updateDocumentFromMarkdown(duplicatedPath, content);
            duplicatedDocNames = [duplicatedPath];
          } catch (err) {
            try {
              tracedRmSync(destinationPath, { force: true });
            } catch (cleanupErr) {
              console.warn('[duplicate-path] failed to clean partial file duplicate:', {
                destinationPath,
                err: cleanupErr,
              });
            }
            forgetDocExtension(duplicatedPath);
            if (contentFilter && didIncrementMdDir) {
              contentFilter.decrementMdDir(dirname(duplicatedPath));
            }
            mutateFileIndex?.({
              kind: 'delete',
              path: destinationPath,
              docName: duplicatedPath,
            });
            throw err;
          }
        } else {
          const next = nextAvailableDuplicateFolderPath(contentDir, requestedPath);
          duplicatedPath = next.folderPath;
          if (contentFilter?.isDirExcluded(duplicatedPath)) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Duplicated folder destination is excluded by the project content config.',
              { handler: 'duplicate-path' },
            );
            return;
          }
          const destinationPath = resolveContentEntryPath(contentDir, 'folder', duplicatedPath);
          try {
            tracedCpSync(sourcePath, destinationPath, {
              recursive: true,
              errorOnExist: true,
              force: false,
            });
          } catch (err) {
            if (isAlreadyExistsError(err)) {
              errorResponse(
                res,
                409,
                'urn:ok:error:doc-already-exists',
                'A folder at the duplicate destination already exists.',
                { handler: 'duplicate-path', cause: err },
              );
              return;
            }
            throw err;
          }
          try {
            for (const folderPath of collectFolderPaths(contentDir, duplicatedPath)) {
              upsertFolderIndexPathSegments(folderPath);
            }
            const copiedDocs = collectMarkdownCopies(contentDir, duplicatedPath);
            duplicatedDocNames = copiedDocs.map((doc) => doc.docName);
            for (const doc of copiedDocs) {
              const sourceExtension = extname(doc.fullPath);
              registerDocExtension(stripDocExtension(doc.docName), sourceExtension);
              recentlyRemovedDocs?.delete(doc.docName);
              if (contentFilter) {
                contentFilter.incrementMdDir(dirname(doc.docName));
              }
              registerWrite(doc.fullPath, contentHash(doc.content));
              mutateFileIndex?.({
                kind: 'create',
                path: doc.fullPath,
                docName: doc.docName,
                content: doc.content,
              });
              backlinkIndex?.updateDocumentFromMarkdown(doc.docName, doc.content);
            }
          } catch (err) {
            try {
              tracedRmSync(destinationPath, { recursive: true, force: true });
            } catch (cleanupErr) {
              console.warn('[duplicate-path] failed to clean partial folder duplicate:', {
                destinationPath,
                err: cleanupErr,
              });
            }
            throw err;
          }
        }

        switch (actor.kind) {
          case 'agent':
          case 'principal':
            for (const docName of duplicatedDocNames) {
              recordContributor(
                docName,
                actor.writerId,
                actor.displayName,
                actor.colorSeed,
                undefined,
                actor.actor,
              );
            }
            break;
          case 'anonymous':
            break;
          default: {
            const _exhaustive: never = actor;
            throw new Error(
              `Unhandled actor kind in handleDuplicatePath: ${String((_exhaustive as { kind?: unknown }).kind)}`,
            );
          }
        }

        if (backlinkIndex && duplicatedDocNames.length > 0) {
          void backlinkIndex.saveToDisk().catch((err) => {
            console.warn('[backlinks] Failed to persist duplicate-path cache:', err);
          });
          signalChannel?.('backlinks');
          signalChannel?.('graph');
        }
        signalChannel?.('files');
        successResponse(
          res,
          200,
          DuplicatePathSuccessSchema,
          { kind, path: duplicatedPath, duplicatedDocNames },
          { handler: 'duplicate-path' },
        );
      } catch (e) {
        if (e instanceof DuplicateNameExhaustedError) {
          errorResponse(
            res,
            409,
            'urn:ok:error:doc-already-exists',
            'All available duplicate name slots are occupied for this path.',
            { handler: 'duplicate-path', cause: e },
          );
          return;
        }
        const filesystemProblem = classifyDuplicatePathFilesystemProblem(e);
        if (filesystemProblem) {
          errorResponse(
            res,
            filesystemProblem.status,
            filesystemProblem.type,
            filesystemProblem.title,
            { handler: 'duplicate-path', cause: e },
          );
          return;
        }
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to duplicate path.', {
          handler: 'duplicate-path',
          cause: e,
        });
      }
    },
    { handler: 'duplicate-path', method: 'POST' },
  );

  const handlePageHeadings = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const docName = url.searchParams.get('docName');
        if (!docName || docName.length === 0) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Missing docName query parameter.',
            { handler: 'page-headings' },
          );
          return;
        }
        if (!isSafeDocName(docName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'page-headings',
          });
          return;
        }
        const filePath = resolveDocPath(docName);
        if (!filePath) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'page-headings',
          });
          return;
        }
        if (!existsSync(filePath)) {
          errorResponse(res, 404, 'urn:ok:error:doc-not-found', 'Page not found.', {
            handler: 'page-headings',
          });
          return;
        }
        const content = readFileSync(filePath, 'utf-8');
        const headings = extractHeadings(content);
        successResponse(
          res,
          200,
          PageHeadingsSuccessSchema,
          { docName, headings },
          { handler: 'page-headings' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read headings.', {
          handler: 'page-headings',
          cause: e,
        });
      }
    },
    { handler: 'page-headings', method: 'GET', skipBodyParse: true },
  );

  const handleRenamePath = withValidation(
    RenamePathRequestSchema,
    async (_req, res, body) => {
      try {
        const bodyObj = body as unknown as Record<string, unknown>;
        const actor = extractActorIdentity(bodyObj, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'rename-path',
          });
          return;
        }
        const { kind, fromPath, toPath } = body;
        if (!isValidRelativeContentPath(fromPath) || !isValidRelativeContentPath(toPath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Paths must be relative content paths.',
            { handler: 'rename-path' },
          );
          return;
        }
        if (
          kind === 'file' &&
          (isSystemDoc(fromPath) ||
            isSystemDoc(toPath) ||
            isConfigDoc(fromPath) ||
            isConfigDoc(toPath))
        ) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            'Reserved document names cannot be renamed.',
            { handler: 'rename-path' },
          );
          return;
        }
        // Reject paths with a `.ok` or `.git` segment at any depth — root
        // `.ok/` holds OK config (`config.yml`, `frontmatter.yml`,
        // `templates/`) plus the per-machine `local/` runtime subtree
        // (server.lock, principal.json, cache, etc.), and nested
        // `<folder>/.ok/` holds folder metadata + templates. Symmetric with
        // the `__system__` carve-out. The `AGENTS.md` file inside `.ok/` is a
        // tracked content file by design, but a rename TO or FROM these
        // directories would clobber OK bookkeeping.
        if (isReservedProjectStatePath(fromPath) || isReservedProjectStatePath(toPath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            '.ok and .git are reserved directories.',
            {
              handler: 'rename-path',
            },
          );
          return;
        }
        if (fromPath === toPath) {
          successResponse(
            res,
            200,
            RenamePathSuccessSchema,
            { renamed: [], renamedAssets: [], rewrittenDocs: [] },
            { handler: 'rename-path' },
          );
          return;
        }
        const operationKind =
          kind === 'asset' && isSupportedDocFile(fromPath) && isSupportedDocFile(toPath)
            ? 'file'
            : kind;
        if (operationKind === 'asset') {
          let result: {
            renamedAssets: RenamedAssetMapping[];
            rewrittenDocs: ManagedRenameRewrittenDoc[];
          };
          try {
            result =
              isSupportedDocFile(fromPath) && !isSupportedDocFile(toPath)
                ? await _performDocumentToFileRename(fromPath, toPath)
                : await _performAssetRename(fromPath, toPath);
          } catch (err) {
            if (err instanceof DocInConflictError) {
              respondDocInConflict(res, err, 'rename-path');
              return;
            }
            const { status, type, error } = toManagedRenamePublicError(err);
            errorResponse(res, status, type, error, {
              handler: 'rename-path',
              cause: err,
            });
            return;
          }

          if (result.renamedAssets.length > 0) {
            invalidateReferencedAssetsCache();
          }

          let summaryResponse: SummaryResponse | undefined;
          if (result.renamedAssets.length > 0 && result.rewrittenDocs.length > 0) {
            const subject = `Renamed asset ${fromPath} → ${toPath}`;
            summaryResponse = attributeRenameWriteToActor(
              actor,
              subject,
              result.rewrittenDocs.map(({ docName }) => ({ docName, subject })),
              {
                context: 'handleRenamePath asset branch',
                onAnonymous: () => {
                  log.debug(
                    {
                      kind: 'asset',
                      fromPath,
                      toPath,
                      affectedDocs: result.rewrittenDocs.length,
                      affectedAssets: result.renamedAssets.length,
                    },
                    '[rename-path] anonymous actor; no contributor recorded (no agentId in body and getPrincipal() returned null)',
                  );
                },
              },
            );
          }
          renameAttributionCounter().add(1, {
            kind: 'rename-asset',
            attribution_kind: actor.kind,
          });

          if (flushContributors) {
            try {
              await flushContributors();
            } catch (flushErr) {
              console.warn(
                `[rename-path] flushContributors failed after asset rename (commitSha backfill may be deferred):`,
                flushErr,
              );
            }
          }

          successResponse(
            res,
            200,
            RenamePathSuccessSchema,
            {
              renamed: [],
              renamedAssets: result.renamedAssets,
              rewrittenDocs: result.rewrittenDocs,
              ...(summaryResponse ? { summary: summaryResponse } : {}),
            },
            { handler: 'rename-path' },
          );
          return;
        }
        // Register the source's actual on-disk extension before downstream
        // checks so admission, conflict checks, and existsSync probes all see
        // the right value when the file watcher hasn't yet observed the source
        // (boot race).
        if (operationKind === 'file') {
          probeAndRegisterSourceFileExtension(contentDir, fromPath);
        }
        // Conflict-aware refusal. Renaming a conflicted source doc would
        // shift the file path while the merge stages still live at the
        // old path — the disk-watcher → reconcile loop would then see two
        // paths racing the same content. For a folder rename we ALSO
        // refuse if any affected child carries 'conflict': the per-doc
        // rewrite spine (`applyManagedRenameMapToLoadedDocument` →
        // `composeAndWriteRawBody`) is a sibling primitive to
        // `applyAgentMarkdownWrite` and does NOT inherit its gate.
        // Mirrors handleDeletePath's affected-docs scan.
        //
        // Dual-source check: hocuspocus.documents.get() returns undefined
        // for docs evicted from memory (e.g., after boot-time
        // restoreLifecycleFromConflictsJson disconnects them). Falling back
        // to ConflictStore via SyncEngine catches that eviction race —
        // mirrors the dual-source pattern used in handleSyncConflictContent's
        // 404 gate.
        // Enumerate from disk (not the lagging file index) so the conflict
        // pre-check sees every on-disk child of the folder — same root cause
        // as the spine's `affectedDocNames`.
        const renameAffectedDocNames =
          operationKind === 'file'
            ? [docNameForFileOperationPath(contentDir, fromPath)]
            : listManagedDocNamesUnderFolderFromDisk(
                resolveContentEntryPath(contentDir, 'folder', fromPath),
              );
        const renameEngine = getSyncEngine?.();
        const renameTrackedFiles = new Set(
          renameEngine ? renameEngine.getConflicts().map((c) => c.file) : [],
        );
        for (const affected of renameAffectedDocNames) {
          const affectedDocName = affected;
          const doc = hocuspocus.documents.get(affectedDocName);
          const filePath = docNameToRelativePath(affectedDocName);
          const conflictedByLifecycle = doc !== undefined && isDocInConflict(doc);
          const conflictedByStore = renameTrackedFiles.has(filePath);
          if (conflictedByLifecycle || conflictedByStore) {
            respondDocInConflict(res, new DocInConflictError({ file: filePath }), 'rename-path');
            return;
          }
        }

        if (contentFilter) {
          // Mirror `resolveContentEntryPath`'s explicit-extension detection so
          // a destination like `bar.mdx` is checked verbatim instead of as
          // `bar.mdx.md` (which would miss `*.mdx` exclusion patterns).
          const sourceExt = isSupportedDocFile(fromPath)
            ? extname(fromPath)
            : getDocExtension(fromPath);
          const excluded =
            operationKind === 'file'
              ? contentFilter.isExcluded(
                  isSupportedDocFile(toPath) ? toPath : `${toPath}${sourceExt}`,
                )
              : contentFilter.isDirExcluded(toPath);
          if (excluded) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              `Destination ${operationKind === 'file' ? 'document' : 'folder'} is excluded by the project content config.`,
              { handler: 'rename-path' },
            );
            return;
          }
        }

        // Thread the actor identity through to the rewrite spine so the
        // rename log entry carries the right writerId. Anonymous → service
        // writer fallback is handled inside the spine.
        const renameActor =
          actor.kind === 'agent' || actor.kind === 'principal'
            ? {
                writerId: actor.writerId,
                displayName: actor.displayName,
                colorSeed: actor.colorSeed,
                actorMetadata: actor.actor,
              }
            : undefined;

        let result: {
          renamed: RenamedDocMapping[];
          renamedAssets: RenamedAssetMapping[];
          rewrittenDocs: ManagedRenameRewrittenDoc[];
        };
        try {
          result = await _performManagedRenameForDocs(
            fromPath,
            toPath,
            operationKind,
            renameActor ? { actor: renameActor } : {},
          );
        } catch (err) {
          if (err instanceof ManagedRenameCollisionError) {
            errorResponse(res, 409, 'urn:ok:error:doc-already-exists', withPeriod(err.message), {
              handler: 'rename-path',
              extensions: { colliding: err.colliding },
              cause: err,
            });
            return;
          }
          throw err;
        }

        if (result.renamed.length === 0 && result.renamedAssets.length === 0) {
          successResponse(
            res,
            200,
            RenamePathSuccessSchema,
            { renamed: [], renamedAssets: [], rewrittenDocs: [] },
            { handler: 'rename-path' },
          );
          return;
        }

        if (result.renamedAssets.length > 0) {
          invalidateReferencedAssetsCache();
        }

        let summaryResponse: SummaryResponse | undefined;
        const logicalRenames = result.renamed.filter(
          ({ fromDocName, toDocName }) => fromDocName !== toDocName,
        );
        if (logicalRenames.length > 0) {
          summaryResponse = attributeRenameWriteToActor(
            actor,
            `Renamed ${fromPath} → ${toPath}`,
            logicalRenames.map(({ fromDocName, toDocName }) => ({
              docName: toDocName,
              subject: formatRenameSubject(fromDocName, toDocName),
            })),
            {
              context: 'handleRenamePath',
              onAnonymous: () => {
                log.debug(
                  { kind, fromPath, toPath, affectedDocs: result.renamed.length },
                  '[rename-path] anonymous actor — no contributor recorded (no agentId in body and getPrincipal() returned null)',
                );
              },
            },
          );
        }
        renameAttributionCounter().add(1, {
          kind: `rename-${operationKind}`,
          attribution_kind: actor.kind,
        });

        // Flush pending contributors so the rename-log entry's commitSha is
        // backfilled by `commitToWipRefInner` BEFORE the API responds.
        // Without this, a "pure rename without subsequent edit" leaves
        // commitSha as '' until the next persistence drain (which may never
        // happen) — the timeline rename-history mitigation depends on
        // commitSha being a real 40-char SHA at read time. Mirrors the
        // pattern at handleRollback (post-rollback flushContributors call).
        if (flushContributors) {
          try {
            await flushContributors();
          } catch (flushErr) {
            console.warn(
              `[rename-path] flushContributors failed (commitSha backfill may be deferred):`,
              flushErr,
            );
          }
        }

        successResponse(
          res,
          200,
          RenamePathSuccessSchema,
          {
            renamed: result.renamed,
            renamedAssets: result.renamedAssets,
            rewrittenDocs: result.rewrittenDocs,
            ...(summaryResponse ? { summary: summaryResponse } : {}),
          },
          { handler: 'rename-path' },
        );
      } catch (e) {
        const { status, type, error } = toManagedRenamePublicError(e);
        errorResponse(res, status, type, error, {
          handler: 'rename-path',
          cause: e,
        });
      }
    },
    { handler: 'rename-path', method: 'POST' },
  );

  const handleDeletePath = withValidation(
    DeletePathRequestSchema,
    async (_req, res, body) => {
      try {
        extractAgentIdentity(body as unknown as Record<string, unknown>); // attribution threading
        const { kind, path } = body;
        if (!isValidRelativeContentPath(path)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'path must be a relative content path.',
            { handler: 'delete-path' },
          );
          return;
        }
        const assetResolution =
          kind === 'asset' ? resolveExtensionlessAssetPath(path) : { path, ambiguous: false };
        if (assetResolution.ambiguous) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Asset path without an extension matches multiple files.',
            { handler: 'delete-path' },
          );
          return;
        }
        const operationPath = assetResolution.path;
        const operationKind = kind === 'asset' && isSupportedDocFile(operationPath) ? 'file' : kind;
        if (operationKind === 'file') {
          probeAndRegisterSourceFileExtension(contentDir, operationPath);
        }
        if (isReservedProjectStatePath(operationPath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            '.ok and .git are reserved directories.',
            { handler: 'delete-path' },
          );
          return;
        }

        const targetPath =
          operationKind === 'asset'
            ? resolveContentEntryPath(contentDir, 'folder', operationPath)
            : resolveContentEntryPath(contentDir, operationKind, operationPath);
        if (!existsSync(targetPath)) {
          errorResponse(
            res,
            404,
            'urn:ok:error:doc-not-found',
            `${operationKind} does not exist.`,
            {
              handler: 'delete-path',
            },
          );
          return;
        }

        const targetStat = statSync(targetPath);
        if (
          (operationKind === 'file' && !targetStat.isFile()) ||
          (operationKind === 'asset' && !targetStat.isFile()) ||
          (operationKind === 'folder' && !targetStat.isDirectory())
        ) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            `Target path is not a ${operationKind}.`,
            { handler: 'delete-path' },
          );
          return;
        }

        // Enumerate descendants from disk (not the lagging file index) so the
        // folder delete sees every on-disk child. The chokidar watcher
        // populates the index asynchronously, so right after a fresh
        // `write` create it lags on-disk truth: reading it here would
        // return an empty `deletedDocNames`, so `captureAndCloseDocuments` and
        // the `recentlyRemovedDocs` population below would be skipped while
        // `tracedRmSync` still removes the directory — orphaning the in-memory
        // Y.Docs (silent data loss). Same root cause and fix as
        // handleRenamePath's affected-docs scan. The walk runs before the disk
        // delete, so disk is authoritative here; it also registers each
        // child's on-disk extension for extension-less legacy docNames.
        const deletedDocNames =
          operationKind === 'asset'
            ? []
            : operationKind === 'file'
              ? [docNameForFileOperationPath(contentDir, operationPath)]
              : listManagedDocNamesUnderFolderFromDisk(
                  resolveContentEntryPath(contentDir, 'folder', operationPath),
                );

        // Conflict-aware refusal. Deleting a conflicted doc would
        // discard the in-flight resolution state; resolution must complete
        // first via `resolve_conflict` (or be aborted via `git merge --abort`
        // per the documented recovery procedure). Scan every affected
        // doc — for folder deletes, ANY conflicted child blocks the operation.
        //
        // Dual-source check (same rationale as handleRenamePath above):
        // hocuspocus.documents.get() returns undefined for docs evicted
        // from memory; ConflictStore catches that eviction race.
        const deleteEngine = getSyncEngine?.();
        const deleteTrackedFiles = new Set(
          deleteEngine ? deleteEngine.getConflicts().map((c) => c.file) : [],
        );
        for (const affected of deletedDocNames) {
          const affectedDocName = affected;
          const doc = hocuspocus.documents.get(affectedDocName);
          const filePath = docNameToRelativePath(affectedDocName);
          const conflictedByLifecycle = doc !== undefined && isDocInConflict(doc);
          const conflictedByStore = deleteTrackedFiles.has(filePath);
          if (conflictedByLifecycle || conflictedByStore) {
            respondDocInConflict(res, new DocInConflictError({ file: filePath }), 'delete-path');
            return;
          }
        }

        await captureAndCloseDocuments(deletedDocNames, 'deleted-upstream');

        // Populate the per-process LRU cache BEFORE the disk delete so any
        // connection that observes the file gone via the watcher also sees the
        // cache entry — closes the race where a fast reconnect could land
        // between the unlink and the cache write. Filter via the standard
        // `isSystemDoc()`/`isConfigDoc()` STOP gate; synthetic docs cannot
        // appear in `deletedDocNames` today (path validation rejects them),
        // but the filter stays defense-in-depth.
        if (recentlyRemovedDocs) {
          for (const docName of deletedDocNames) {
            if (isSystemDoc(docName) || isConfigDoc(docName)) continue;
            recentlyRemovedDocs.setDeleted(docName);
            console.info(
              JSON.stringify({
                event: 'recently-removed-docs-populate',
                docName,
                kind: 'deleted',
                source: 'handleDeletePath',
              }),
            );
          }
        }

        if (operationKind === 'file' || operationKind === 'asset') {
          tracedUnlinkSync(targetPath);
        } else {
          tracedRmSync(targetPath, { recursive: true, force: false });
          removeFolderIndexEntries(operationPath);
        }
        invalidateReferencedAssetsCache();

        // Refresh the file index so subsequent doc-list reads don't include
        // the just-deleted entries. Watcher events would eventually do this
        // anyway but the doc-list response needs to be consistent right now.
        // Routes through the typed `mutateFileIndex` accessor (live map);
        // the pre-PR pattern of `getFileIndex() + as Map cast` silently
        // dead-ended once `getFileIndex()` flipped to returning a snapshot.
        for (const docName of deletedDocNames) {
          mutateFileIndex?.({
            kind: 'delete',
            path: resolve(contentDir, docNameToRelativePath(docName)),
            docName,
          });
        }

        signalChannel?.('files');
        successResponse(
          res,
          200,
          DeletePathSuccessSchema,
          { deletedDocNames },
          { handler: 'delete-path' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to delete path.', {
          handler: 'delete-path',
          cause: e,
        });
      }
    },
    { handler: 'delete-path', method: 'POST' },
  );

  // Two-step Trash flow: the renderer calls
  // `bridge.shell.trashItem` (Step 1) which moves the file to ~/.Trash via
  // `shell.trashItem`. On success, the renderer POSTs here (Step 2) to
  // synchronously cleanup server-side state — close Hocuspocus docs, mark
  // `recentlyRemovedDocs`, purge the file index, broadcast CC1 files.
  // Does NOT touch disk (the file is already gone from contentDir).
  //
  // Idempotent: if the file-watcher already processed the OS-level deletion
  // between Step 1 and Step 2, `listAffectedDocNames` returns an empty array
  // and the handler returns 200 with `deletedDocNames: []` rather than 404 —
  // the desired end state (gone) is still true.
  const handleTrashCleanup = withValidation(
    TrashCleanupRequestSchema,
    async (_req, res, body) => {
      return withSpan(
        'ok.fs.trash_cleanup',
        {
          attributes: {
            'ok.cleanup.kind': body.kind,
            'ok.cleanup.path': normalizeFsPath(body.path),
            'ok.cleanup.path.role': classifyFsPath(body.path),
          },
        },
        async () => {
          try {
            const bodyObj = body as unknown as Record<string, unknown>;
            const actor = extractActorIdentity(bodyObj, getPrincipal);
            if (actor.kind === 'invalid-summary') {
              errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
                handler: 'trash-cleanup',
              });
              return;
            }
            const { kind, path } = body;
            if (!isValidRelativeContentPath(path)) {
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                'path must be a relative content path.',
                { handler: 'trash-cleanup' },
              );
              return;
            }
            const operationKind = kind === 'asset' && isSupportedDocFile(path) ? 'file' : kind;
            const operationDocName = stripDocExtension(path);
            if (operationKind === 'file') {
              probeAndRegisterSourceFileExtension(contentDir, path);
            }
            // Defense in depth — synthetic docs never reach disk so cleanup
            // against them is meaningless; mirrors the gate handleDeletePath
            // implicitly enforces via `resolveContentEntryPath` + existsSync.
            // Folder kind is checked separately: a `kind: 'folder', path:
            // '__config__'` payload would otherwise reach listAffectedDocNames
            // + captureAndCloseDocuments on the synthetic config docs inside
            // that namespace before the per-doc guard at the recently-removed
            // loop fires.
            const isReservedFolder =
              operationKind === 'folder' && isReservedSyntheticFolderPath(path);
            if (
              (operationKind === 'file' &&
                (isSystemDoc(operationDocName) || isConfigDoc(operationDocName))) ||
              isReservedFolder ||
              isReservedProjectStatePath(path)
            ) {
              errorResponse(
                res,
                400,
                'urn:ok:error:reserved-doc-name',
                `'${path}' is a reserved document name.`,
                { handler: 'trash-cleanup' },
              );
              return;
            }
            if (operationKind === 'asset') {
              invalidateReferencedAssetsCache();
              signalChannel?.('files');
              successResponse(
                res,
                200,
                TrashCleanupSuccessSchema,
                { deletedDocNames: [] },
                { handler: 'trash-cleanup' },
              );
              return;
            }

            // Source of truth for "what to purge" is the in-memory fileIndex.
            // The OS-level move-to-Trash happened in Step 1; the watcher MAY
            // have processed it already (then the index is empty for this
            // path), or NOT (then the index still holds the entries). For
            // the idempotent fast-path: when the index lacks the entries,
            // return 200 + empty array — the desired end state (gone) is
            // already true; nothing left for us to do.
            const initialIndex = getFileIndex();
            const deletedDocNames =
              operationKind === 'file'
                ? initialIndex.has(operationDocName)
                  ? [operationDocName]
                  : []
                : listAffectedDocNames(initialIndex, operationKind, path);

            invalidateReferencedAssetsCache();

            if (deletedDocNames.length === 0) {
              successResponse(
                res,
                200,
                TrashCleanupSuccessSchema,
                { deletedDocNames: [] },
                { handler: 'trash-cleanup' },
              );
              return;
            }

            await captureAndCloseDocuments(deletedDocNames, 'deleted-upstream');

            if (recentlyRemovedDocs) {
              for (const docName of deletedDocNames) {
                if (isSystemDoc(docName) || isConfigDoc(docName)) continue;
                recentlyRemovedDocs.setDeleted(docName);
                console.info(
                  JSON.stringify({
                    event: 'recently-removed-docs-populate',
                    docName,
                    kind: 'deleted',
                    source: 'handleTrashCleanup',
                  }),
                );
              }
            }

            // Synchronously purge the in-memory index so subsequent doc-list
            // reads return the post-trash state immediately. The file-watcher
            // will also process the OS-level deletion event eventually; both
            // pathways converge on the same end state. Routes through the
            // typed `mutateFileIndex` accessor (live map) — the pre-PR
            // `getFileIndex() + as Map cast` pattern silently dead-ended
            // once `getFileIndex()` flipped to returning a snapshot.
            for (const docName of deletedDocNames) {
              mutateFileIndex?.({
                kind: 'delete',
                path: resolve(contentDir, docNameToRelativePath(docName)),
                docName,
              });
            }
            if (operationKind === 'folder') {
              removeFolderIndexEntries(path);
            }

            // Synchronous CC1 emit closes the race where the renderer expects
            // the updated tree right after the response. The watcher's later
            // emit is idempotent at the consumer (per-channel seq dedup).
            signalChannel?.('files');

            successResponse(
              res,
              200,
              TrashCleanupSuccessSchema,
              { deletedDocNames },
              { handler: 'trash-cleanup' },
            );
          } catch (e) {
            errorResponse(
              res,
              500,
              'urn:ok:error:internal-server-error',
              'Failed to clean up after trash.',
              {
                handler: 'trash-cleanup',
                cause: e,
              },
            );
          }
        },
      );
    },
    { handler: 'trash-cleanup', method: 'POST' },
  );

  const handlePages = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        const index = getFileIndex();
        const pages: {
          docName: string;
          title: string;
          docExt: string;
          size: number;
          modified: string;
          icon?: string;
        }[] = [];
        for (const [docName, entry] of index) {
          const docExt = getDocExtension(docName);
          let title: string;
          let icon: string | undefined;
          if (entry.title !== undefined) {
            // Enriched index entry: title/icon were derived during the file-watcher
            // seed walk / live disk events from content already read for the hash,
            // so serve from memory — no per-request readFileSync + frontmatter parse.
            title = entry.title;
            icon = entry.icon;
          } else {
            // Bare entry (title absent): fall back to a one-off disk read.
            // See FileIndexEntry.title.
            title = docName;
            try {
              const filePath = resolve(contentDir, `${docName}${docExt}`);
              const content = readFileSync(filePath, 'utf-8');
              title = extractPageTitle(content, docName);
              icon = extractPageIcon(content);
            } catch (err) {
              console.warn(`[pages] Failed to read title for ${docName}:`, err);
            }
          }
          pages.push({ docName, title, docExt, size: entry.size, modified: entry.modified, icon });
        }
        pages.sort((a, b) => a.docName.localeCompare(b.docName));
        successResponse(res, 200, PagesSuccessSchema, { pages }, { handler: 'pages' });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to list pages.', {
          handler: 'pages',
          cause: e,
        });
      }
    },
    { handler: 'pages', method: 'GET', skipBodyParse: true },
  );

  const handleSuggestLinks = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const docName = url.searchParams.get('docName');
        if (!docName) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing docName parameter.', {
            handler: 'suggest-links',
          });
          return;
        }
        if (!isSafeDocName(docName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'suggest-links',
          });
          return;
        }
        if (isSystemDoc(docName) || isConfigDoc(docName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${docName}' is a reserved document name.`,
            { handler: 'suggest-links' },
          );
          return;
        }

        const result = await suggestLinks({
          hocuspocus,
          fileIndex: getFileIndex(),
          docName,
        });
        successResponse(res, 200, SuggestLinksSuccessSchema, result, { handler: 'suggest-links' });
      } catch (error) {
        if (error instanceof SuggestLinksTargetNotFoundError) {
          errorResponse(res, 404, 'urn:ok:error:doc-not-found', 'Page not found.', {
            handler: 'suggest-links',
            cause: error,
          });
          return;
        }
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to suggest links.', {
          handler: 'suggest-links',
          cause: error,
        });
      }
    },
    { handler: 'suggest-links', method: 'GET', skipBodyParse: true },
  );

  async function handleUploadAsset(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'upload-asset',
        extraHeaders: { Allow: 'POST' },
      });
      return;
    }

    let uploadResult: UploadResult | undefined;
    try {
      uploadResult = await readUploadBody(req, projectDir ?? contentDir);
    } catch (e) {
      // All body-parse failures land as UploadWriteError with a URN-form
      // reason. Tempfile cleanup is handled inside readUploadBody's error
      // path. Anonymous emit (no extractAgentIdentity yet) is semantically
      // OK — no Y.Doc mutation has been attempted.
      if (e instanceof UploadWriteError) {
        errorResponse(res, uploadStatusFor(e.reason), e.reason, uploadTitleFor(e.reason), {
          handler: 'upload-asset',
          cause: e,
        });
        return;
      }
      errorResponse(res, 400, 'urn:ok:error:malformed-upload', 'Failed to parse upload.', {
        handler: 'upload-asset',
        cause: e,
      });
      return;
    }

    const {
      filename,
      tempPath,
      sha,
      byteLength,
      parentDocName: rawParentDocName,
      placement: rawPlacement,
    } = uploadResult;

    // Belt-and-braces cleanup: if anything below this point errors or
    // early-returns, the tempfile must go away. Every early-return path
    // below that does NOT consume tempPath via linkTempToFinal* runs this.
    const cleanupTempfile = () => {
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {
          // best-effort; orphan sweep reaps stragglers
        }
      }
    };

    // Validate metadata fields (parentDocName etc.) via the shared
    // `validateBody` middleware. Body-shape failure emits 400
    // `urn:ok:error:invalid-request` BEFORE `extractAgentIdentity` runs —
    // an anonymous response is semantically correct here because no Y.Doc
    // mutation is attempted. Mirrors `withValidation`'s policy for JSON
    // handlers.
    const validated = validateBody(
      UploadRequestSchema,
      { parentDocName: rawParentDocName, placement: rawPlacement || undefined },
      res,
      {
        handler: 'upload-asset',
      },
    );
    if (!validated.ok) {
      cleanupTempfile();
      return;
    }
    const { parentDocName, placement } = validated.value;

    // Identity extracted from query params (multipart body precludes JSON).
    // Capture agentId / agentName so structured upload logs carry
    // attribution — mirrors precedent #24/#25 and lets operators trace
    // unexpected file-creation events back to the originating agent
    // during incident investigation. Both fields follow bounded shapes
    // (agentId matches AGENT_ID_RE; agentName is sanitized) so they
    // remain cardinality-safe for log indexing.
    //
    // CRUCIAL: identity extraction must precede every SEMANTIC error
    // emission below (path-escape, no-file-received, storage-error). Body-
    // shape errors above (urn:ok:error:invalid-request, urn:ok:error:malformed-upload)
    // are anonymous because no Y.Doc mutation is attempted. The
    // attribution-sweep-coverage ordering check enforces this distinction
    // (precedent #24).
    const { agentId, agentName } = extractAgentIdentity(
      Object.fromEntries(new URL(req.url ?? '', 'http://localhost').searchParams.entries()),
    );

    if (byteLength === 0) {
      cleanupTempfile();
      errorResponse(res, 400, 'urn:ok:error:no-file-received', 'No file received.', {
        handler: 'upload-asset',
      });
      return;
    }

    // Reject path-escape attempts.
    if (
      parentDocName.includes('\x00') ||
      parentDocName.includes('..') ||
      parentDocName.startsWith('/')
    ) {
      cleanupTempfile();
      errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
        handler: 'upload-asset',
      });
      return;
    }

    const resolvedContentDir = resolve(contentDir);
    let rawAttachmentFolderPath: string;
    try {
      rawAttachmentFolderPath =
        placement === 'parent-dir'
          ? DEFAULT_ATTACHMENT_FOLDER_PATH
          : (getAttachmentFolderPath?.() ?? DEFAULT_ATTACHMENT_FOLDER_PATH);
    } catch (err) {
      cleanupTempfile();
      log.error({ err }, '[upload] project config has invalid content.attachmentFolderPath');
      errorResponse(
        res,
        500,
        'urn:ok:error:internal-server-error',
        'Server configuration error: invalid attachment folder path.',
        {
          handler: 'upload-asset',
          cause: err,
        },
      );
      return;
    }
    if (!isValidAttachmentFolderPath(rawAttachmentFolderPath)) {
      cleanupTempfile();
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid attachment folder path.', {
        handler: 'upload-asset',
      });
      return;
    }
    const attachmentFolderPath = normalizeAttachmentFolderPath(rawAttachmentFolderPath);
    const destDir = resolveUploadDestDir(parentDocName, attachmentFolderPath, resolvedContentDir);
    if (!isWithinContentDir(destDir, resolvedContentDir)) {
      cleanupTempfile();
      errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
        handler: 'upload-asset',
      });
      return;
    }
    // Pre-mkdir symlink-escape check: walks up from destDir to the
    // deepest existing ancestor and rejects if its realpath escapes contentDir.
    // Doing this before `mkdirSync({ recursive: true })` prevents mkdir from
    // following a parent symlink and materializing a fresh directory outside
    // contentDir. The post-mkdir realpath check below remains as defense-in-
    // depth against TOCTOU symlink-replace races between this check and mkdir.
    try {
      assertNoSymlinkEscape(destDir, resolvedContentDir);
    } catch (err) {
      cleanupTempfile();
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('symlink-escape:')) {
        errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
          handler: 'upload-asset',
        });
        return;
      }
      log.error({ err, destDir }, '[upload] failed to validate destination directory');
      errorResponse(res, 500, 'urn:ok:error:storage-error', 'Storage error.', {
        handler: 'upload-asset',
        cause: err,
      });
      return;
    }
    // mkdir -p the destination — bare-name / nested attachmentFolderPath
    // values produce directories that may not exist at first upload.
    try {
      mkdirSync(destDir, { recursive: true });
    } catch (err) {
      if (!isAlreadyExistsError(err)) {
        cleanupTempfile();
        // Classify the errno through the same typed table the streaming-
        // write path uses so ENOSPC/EDQUOT route through 507 storage-full
        // and EROFS/EACCES/EPERM route through 500 storage-readonly —
        // SDK consumers branch on the URN, not the errno, so collapsing
        // every errno into generic storage-error breaks that contract.
        const reason = classifyUploadErrno(err as NodeJS.ErrnoException);
        errorResponse(res, uploadStatusFor(reason), reason, uploadTitleFor(reason), {
          handler: 'upload-asset',
          cause: err,
          detail: 'failed to create attachment directory',
        });
        return;
      }
    }

    // Symlink escape check: realpath the dest dir and compare against realpath'd contentDir
    try {
      const realDestDir = realpathSync(destDir);
      let realContentDir: string;
      try {
        realContentDir = realpathSync(resolvedContentDir);
      } catch {
        realContentDir = resolvedContentDir;
      }
      if (!isWithinContentDir(realDestDir, realContentDir)) {
        cleanupTempfile();
        errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
          handler: 'upload-asset',
        });
        return;
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Directory doesn't exist yet — will be created below; no symlink escape possible
      } else {
        cleanupTempfile();
        errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
          handler: 'upload-asset',
          cause: e,
        });
        return;
      }
    }

    // Accept-all: every file is accepted — there's no user-facing byte cap
    // post-streaming (disk fullness surfaces as 507 instead). The magic-
    // byte sniff is only consulted to (a) preserve the SVG `<img>`-only
    // routing for security and (b) recover an extension when the upload
    // arrived with a generic clipboard filename. Non-sniffable bytes are
    // accepted under the client-supplied filename.
    //
    const SNIFF_HEAD_BYTES = 4100;
    const head = readTempFileHead(tempPath, SNIFF_HEAD_BYTES);
    const fileTypeResult = await fileTypeFromBuffer(head);
    let detectedMime: string | undefined = fileTypeResult?.mime;
    let detectedExt: string | undefined = fileTypeResult?.ext;
    // file-type can't detect SVG (text-based, no magic bytes) — check manually.
    // STOP: this fallback is LOAD-BEARING — SVG must render via
    // <img>, never inline DOM. Do not remove without a compensating guard.
    if (!detectedMime) {
      // Strip a leading UTF-8 BOM (U+FEFF) before the pattern match.
      // `trimStart()` removes ECMAScript whitespace but not the BOM, so a
      // file starting with `\xEF\xBB\xBF<svg ...>` would otherwise evade the
      // head check the comment above documents as the SVG-disguised-as-PNG
      const headText = head.subarray(0, 256).toString('utf-8').replace(/^﻿/, '').trimStart();
      if (
        headText.startsWith('<svg') ||
        (headText.startsWith('<?xml') && headText.includes('<svg'))
      ) {
        detectedMime = 'image/svg+xml';
        detectedExt = 'svg';
      }
    }

    // Same-dir sha256 dedup. Bounded scan over destDir, skipped entirely
    // when DEFAULT_DEDUP_MODE === 'off'. The dedup test happens BEFORE
    // filename synthesis so a duplicate paste preserves the existing
    // on-disk basename instead of producing a fresh pasted-<ts>.png stub.
    // Server returns { deduped: true } so the client surfaces a toast.
    //
    // The hash + size come from the streaming pipeline (no buffer). On a
    // dedup hit the tempfile is unlinked and we short-circuit without
    // touching the destDir inode — `linkTempToFinalWithCollisionRetry`
    // never runs.
    if (DEFAULT_DEDUP_MODE === 'same-dir') {
      const existing = await findDuplicateAsset(destDir, sha, byteLength);
      if (existing) {
        cleanupTempfile();
        const relPath = toPosix(relative(contentDir, resolve(destDir, existing)));
        log.info(
          {
            event: 'upload',
            endpoint: req.url ?? '/api/upload',
            agentId,
            agentName,
            dedup: true,
            mime: detectedMime ?? null,
            size: byteLength,
            destPath: relPath,
            httpStatus: 200,
          },
          '[upload] dedup hit',
        );
        // RFC 9457 §3 success path: drop the `ok: true` wrapper. Wire
        // shape is `{ src, path, deduped }` with `Content-Type:
        // application/json`. Clients use HTTP-status discrimination
        // (`if (!res.ok)`) to choose between this success schema and
        // `ProblemDetailsSchema`.
        successResponse(
          res,
          200,
          UploadAssetSuccessSchema,
          { src: existing, path: relPath, deduped: true },
          { handler: 'upload-asset' },
        );
        return;
      }
    }

    // GENERIC_PASTE_NAMES: clipboard paste arrives with synthetic names
    // ("image.png", "Clipboard 2024-04-21 14:23:45"). Replace with a
    // timestamp stem so the disk filename is human-meaningful.
    let finalFilename: string;
    const isGenericPaste = !filename || filename === 'upload' || GENERIC_PASTE_NAMES.test(filename);
    if (isGenericPaste) {
      const now = new Date();
      const ts = now
        .toISOString()
        .replace(/[-:T]/g, '')
        .slice(0, 14)
        .replace(/(\d{8})(\d{6})/, '$1-$2');
      // Prefer the sniffed extension when present; otherwise try the
      // client-supplied extname, finally fall back to .bin.
      const fallbackExt = filename ? extname(filename).slice(1) : '';
      const ext = detectedExt ?? fallbackExt ?? '';
      finalFilename = ext === '' ? `pasted-${ts}` : `pasted-${ts}.${ext}`;
    } else {
      finalFilename = sanitizeFilename(filename);
    }

    try {
      const destFilename = linkTempToFinalWithCollisionRetry(tempPath, destDir, finalFilename);
      const relPath = toPosix(relative(contentDir, resolve(destDir, destFilename)));
      log.info(
        {
          event: 'upload',
          endpoint: req.url ?? '/api/upload',
          agentId,
          agentName,
          dedup: false,
          mime: detectedMime ?? null,
          size: byteLength,
          // `destPath` is the contentDir-relative asset path. High-
          // cardinality by nature — a vault with 10K assets produces
          // 10K distinct values. Fine as a log field consumed by text-
          // search / by-incident filtering; NEVER promote it to a
          // metric label (Prometheus / Datadog will blow up memory on
          // per-asset label explosion). Keep the nested-context shape
          // below if you later route these through an aggregator so
          // auto-label-extraction honors the sub-object convention.
          destPath: relPath,
          httpStatus: 200,
        },
        '[upload] write ok',
      );
      successResponse(
        res,
        200,
        UploadAssetSuccessSchema,
        { src: destFilename, path: relPath, deduped: false },
        { handler: 'upload-asset' },
      );
    } catch (e) {
      // linkTempToFinalWithCollisionRetry best-effort unlinks the tempfile
      // on throw; no extra cleanupTempfile() call needed here.
      const reason: UploadWriteReason =
        e instanceof UploadWriteError ? e.reason : 'urn:ok:error:storage-error';
      log.error(
        {
          event: 'upload',
          endpoint: req.url ?? '/api/upload',
          agentId,
          agentName,
          filename: finalFilename,
          size: byteLength,
          reason,
          httpStatus: uploadStatusFor(reason),
          err: e,
        },
        '[upload] write failed',
      );
      errorResponse(res, uploadStatusFor(reason), reason, uploadTitleFor(reason), {
        handler: 'upload-asset',
        cause: e,
      });
    }
  }

  // ─── Local-op relay endpoints (/api/local-op/*) ─────────────────────────────
  // loopback + origin + path safety + URL allowlist + concurrency=1 + 10-min timeout

  const LOCAL_OP_CLONE_KEY = '/api/local-op/clone';
  const LOCAL_OP_OK_INIT_KEY = '/api/local-op/ok-init';
  /** Wall-clock timeout for clone subprocess (10 min). */
  const LOCAL_OP_TIMEOUT_MS = 10 * 60 * 1000;
  /** Max time to wait for a spawned server's lock file to show a port > 0. */
  const LOCAL_OP_OPEN_TIMEOUT_MS = 45_000;
  const LOCAL_OP_STDERR_ONLY_OPTIONS: { stdio: ['ignore', 'ignore', 'pipe'] } = {
    stdio: ['ignore', 'ignore', 'pipe'],
  };
  const LOCAL_OP_PIPE_STDIO_OPTIONS: { stdio: ['ignore', 'pipe', 'pipe'] } = {
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  const LOCAL_OP_IGNORED_STDIO_OPTIONS: Pick<SpawnOptions, 'stdio'> = {
    stdio: 'ignore',
  };

  /**
   * POST /api/local-op/clone
   *
   * Body: { url: string, dir: string }
   * Spawns: open-knowledge clone --json --dir <dir> <url>
   * Streams: NDJSON lines via chunked HTTP.
   *
   * Pre-stream errors (security gate, method, body shape, URL/path safety,
   * concurrency) emit RFC 9457 problem+json via `errorResponse(...)`.
   * Mid-stream errors (clone subprocess failure, timeout, server-start
   * chain) emit `{ type: 'error', problem: ProblemDetails }` events through
   * `streamingProblemEvent(...)`. The streaming protocol's outer
   * `type` field stays the kind discriminator (`progress | complete |
   * error`); the URN problem identifier lives nested under `problem.type`.
   *
   * CLI events are intercepted: complete events are swallowed and
   * synthesized post-server-start; CLI error events are wrapped in the
   * typed envelope so every mid-stream error has a `problem` payload.
   */
  const HANDLE_LOCAL_OP_CLONE = 'local-op-clone';
  const handleLocalOpClone = withValidation(LocalOpCloneRequestSchema, handleLocalOpCloneInner, {
    handler: HANDLE_LOCAL_OP_CLONE,
    method: 'POST',
    preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_CLONE }),
  });
  async function handleLocalOpCloneInner(
    _req: IncomingMessage,
    res: ServerResponse,
    body: LocalOpCloneRequest,
  ): Promise<void> {
    const { url, dir, branch } = body;

    // Semantic checks (post-shape): protocol allowlist + path safety.
    if (!isAllowedGitUrl(url)) {
      errorResponse(
        res,
        400,
        'urn:ok:error:url-not-allowed',
        'URL protocol is not allowed for clone.',
        { handler: HANDLE_LOCAL_OP_CLONE, cause: new Error(`url=${url}`) },
      );
      return;
    }
    if (!isSafeLocalPath(dir)) {
      errorResponse(
        res,
        400,
        'urn:ok:error:dir-outside-home',
        'Clone destination must be within the user home directory.',
        { handler: HANDLE_LOCAL_OP_CLONE, cause: new Error(`dir=${dir}`) },
      );
      return;
    }

    // Concurrency guard: reject concurrent requests to this endpoint.
    if (!localOpGuard.tryAcquire(LOCAL_OP_CLONE_KEY)) {
      errorResponse(
        res,
        429,
        'urn:ok:error:concurrent-operation',
        'A clone operation is already in progress.',
        { handler: HANDLE_LOCAL_OP_CLONE, extraHeaders: { 'Retry-After': '30' } },
      );
      return;
    }

    // Start chunked NDJSON response — past this point, errors emit inline
    // streaming events via `streamingProblemEvent(...)`, not `errorResponse`.
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });

    // HTTP-side mid-stream error writer. Wraps raw CLI `{type:'error',
    // message}` events in the canonical RFC 9457 streaming envelope
    // `{type:'error', problem: ProblemDetails}` so consumers can safeParse
    // uniformly. The IPC pathway forwards the raw shape per its bridge
    // contract; HTTP transport's `CloneEvent` union accepts both.
    const writeStreamError = createStreamingErrorWriter(res, HANDLE_LOCAL_OP_CLONE);

    // The CLI emits `{type:'complete', dir}` on success, but the browser
    // client expects `{type:'complete', port}`. We intercept the CLI's
    // complete event, boot a server at the cloned dir, then emit a
    // rewritten complete with the port. CLI `error` events are wrapped in
    // a typed `problem` envelope; non-terminal `progress` events flow
    // through unchanged.
    let cloneCompleteDir: string | null = null;

    const flow = runCloneSubprocess({
      cliArgs: localOpCliArgs,
      url,
      dir,
      branch,
      timeoutMs: LOCAL_OP_TIMEOUT_MS,
      onEvent: (event) => {
        if (event.type === 'complete') {
          cloneCompleteDir = event.dir;
          return;
        }
        if (event.type === 'error') {
          if (event.message) {
            // Redact PAT-style URL credentials before logging — git
            // stderr echoes the clone URL verbatim on failure (e.g.
            // `fatal: unable to access 'https://x-access-token:ghp_...@...'`),
            // and structured logs may be shipped to an aggregation
            // backend where PATs become durable + queryable. The wire
            // envelope is already sanitized via `classifyCloneError`
            // below; the log line needs the same hygiene.
            log.warn(
              { stderr: redactShareSubprocessStderr(event.message), url, dir },
              '[local-op/clone] clone failed',
            );
          }
          // stderr previously rode only as `cause` (Pino-only)
          // and never reached the wire envelope, so the toast collapsed
          // to the generic title. `classifyCloneError` maps recognized
          // git error shapes (404 / 403 / auth) to access-specific
          // titles and threads the sanitized, length-capped stderr
          // through to `detail` for unrecognized shapes too.
          const classification = classifyCloneError(event.message ?? '');
          writeStreamError(500, 'urn:ok:error:clone-failed', classification.title, {
            detail: classification.detail || undefined,
            // `cause` rides into Pino via `streamingProblemEvent`'s
            // `err: options.cause` serializer (Pino's `stdSerializers.err`
            // surfaces `err.message`). Redact before constructing the
            // Error so PAT-style credentials don't survive in structured
            // logs — same hygiene as the warn-log above.
            cause: event.message
              ? new Error(redactShareSubprocessStderr(event.message))
              : undefined,
          });
          return;
        }
        // progress events flow through unchanged. Three-way guard +
        // try-catch mirrors `createStreamingErrorWriter`'s race-window
        // defense — between the guard check
        // and the write a TCP RST could destroy the socket and cause
        // ERR_STREAM_DESTROYED. Lost progress event is not crashworthy.
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(`${JSON.stringify(event)}\n`);
          } catch {
            /* socket destroyed between guard and write — event lost */
          }
        }
      },
    });

    void (async () => {
      try {
        await flow.done;
        if (cloneCompleteDir && !res.writableEnded && !res.destroyed) {
          // Chain into server-start so the client can redirect. Three-way
          // guard (writableEnded + destroyed) closes the TCP-RST-during-await
          // window where a client disconnect between `flow.done` resolving
          // and the next `res.write` would surface as `ERR_STREAM_DESTROYED`
          // unhandled rejection. Mirrors `createStreamingErrorWriter`'s
          // pattern.
          const result = await startServerAtDirAndGetPort(cloneCompleteDir);
          if (!res.writableEnded && !res.destroyed) {
            if ('port' in result) {
              // `dir` is the absolute, tilde-expanded path to the cloned
              // repo. Web clients ignore it and redirect via `port`; the
              // Electron Navigator uses it to spawn a new editor window
              // instead of navigating the launcher to a dev-server URL.
              res.write(
                `${JSON.stringify({ type: 'complete', port: result.port, dir: cloneCompleteDir })}\n`,
              );
            } else {
              writeStreamError(
                500,
                'urn:ok:error:server-start-failed',
                'Cloned successfully but failed to start the project server.',
                { cause: new Error(result.error) },
              );
            }
          }
        }
      } catch (err) {
        // Catch the race-window throw (`res.write` after socket destroyed,
        // or any other unexpected post-flow rejection). Without this catch
        // the rejection becomes unhandled and disappears from telemetry.
        // If the stream is still writable, surface as a typed streaming
        // error event; otherwise log structured for triage.
        if (!res.writableEnded && !res.destroyed) {
          writeStreamError(
            500,
            'urn:ok:error:internal-server-error',
            'Unexpected error during clone post-processing.',
            { cause: err },
          );
        } else {
          log.error(
            { err, handler: HANDLE_LOCAL_OP_CLONE },
            'clone IIFE rejected after stream ended',
          );
        }
      } finally {
        if (!res.writableEnded) res.end();
        localOpGuard.release(LOCAL_OP_CLONE_KEY);
      }
    })();

    // Cancel the subprocess if the client disconnects.
    res.on('close', () => {
      flow.cancel();
    });
  }

  /**
   * Spawn a detached OpenKnowledge server at `dir` and poll the server.lock
   * until a real port appears. Used by the clone handler to chain
   * clone → server-start → redirect.
   *
   * NOTE: The CLI's `start` command has no `--content-dir` flag — it derives
   * the content dir from cwd + config. So we spawn with `cwd: dir` instead
   * of passing a flag.
   */
  /**
   * Ensure both the collab server (`ok start`) and the React UI (`ok ui`) are
   * live for `dir`, and return the UI port — that's the browser-navigable
   * redirect target post-lifecycle-split. `ok start` serves only the collab
   * API/WebSocket and returns 404 at `/` with an `ok ui`-pointing message.
   *
   * Three cases:
   *   1. `ui.lock` is live → reuse its port (UI already running in that dir).
   *   2. `server.lock` live but `ui.lock` absent/stale → spawn `ok ui` alone;
   *      `ok start` won't re-spawn its UI sibling when the server-lock is held.
   *   3. Nothing live → spawn `ok start`; it auto-spawns `ok ui` as a sibling
   *      (see `start.ts`, "auto-spawned ok ui sibling").
   *
   * Polls `ui.lock` (not `server.lock`) because only `ui.lock.port` hosts the
   * React bundle. Single polling loop covers cases 2 and 3 uniformly.
   */
  async function startServerAtDirAndGetPort(
    dir: string,
    port?: number,
  ): Promise<{ port: number } | { error: string }> {
    const absDir = resolve(expandTilde(dir));
    const lockDir = getLocalDir(absDir);

    // Case 1: UI already live — reuse. (Honors a requested `port` only when a
    // fresh UI is spawned below; an already-live UI keeps its bound port.)
    const existingUi = readUiLock(lockDir);
    if (existingUi && existingUi.port > 0) {
      return { port: existingUi.port };
    }

    // Build the args for a given dispatch command, threading the requested UI
    // port: `ok ui --port P` (connect) or `ok start --ui-port P` (start, which
    // pins its UI sibling to P via the separate `--ui-port` channel — `PORT` is
    // stripped from the sibling env so the collab server and the sibling don't
    // collide). Omitting `port` reproduces the legacy kernel-allocated behavior.
    const [cmd, ...baseArgs] = localOpCliArgs;
    const buildArgs = (cliCmd: 'ui' | 'start'): string[] => {
      const portFlag =
        port !== undefined
          ? cliCmd === 'ui'
            ? ['--port', String(port)]
            : ['--ui-port', String(port)]
          : [];
      return [...baseArgs, cliCmd, ...portFlag];
    };

    // Spawn `ok <cliCmd>` detached at `absDir` and poll `ui.lock` for a bound
    // port. Returns the port, or `{ exited }` when the child died before
    // binding (so the caller can decide whether to fall back to connect).
    const spawnAndAwaitUi = async (
      cliCmd: 'ui' | 'start',
    ): Promise<{ port: number } | { error: string; exited: boolean }> => {
      const child = spawn(
        cmd,
        buildArgs(cliCmd),
        withHiddenWindowsConsole({
          ...LOCAL_OP_STDERR_ONLY_OPTIONS,
          cwd: absDir,
          detached: true,
          // Explicit `interactive` — `OK_LOCK_KIND` may be inherited from a
          // surrounding MCP-spawn parent and we don't want a user-driven
          // clone relay to mark its child server as `mcp-spawned`.
          env: { ...process.env, OK_LOCK_KIND: 'interactive' },
        }),
      );

      const stderrChunks: Buffer[] = [];
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
        log.warn(
          { cwd: absDir, cliCmd, msg: chunk.toString('utf-8').trim() },
          '[local-op/clone] child stderr',
        );
      });

      let earlyExitCode: number | null = null;
      let earlyExitSignal: NodeJS.Signals | null = null;
      let spawnErrorMessage: string | null = null;
      child.on('exit', (code, signal) => {
        earlyExitCode = code ?? -1;
        earlyExitSignal = signal ?? null;
      });
      // A failed `spawn` (ENOENT: binary not found, EACCES: not executable)
      // emits `error` and NEVER `exit`. Without this handler `earlyExitCode`
      // stays null, the loop polls the full timeout, and the early-exit return
      // — which the TOCTOU connect-fallback keys off via `exited: true` — never
      // fires, so a broken install bypasses the fallback and reads as a timeout.
      // Trip the early-exit path on the next poll tick instead.
      child.on('error', (err) => {
        spawnErrorMessage = err.message;
        earlyExitCode = -1;
        log.error(
          { cwd: absDir, cliCmd, err: err.message },
          '[local-op/clone] failed to spawn child',
        );
      });

      // `unref` so the child survives past the parent. Do it after attaching
      // the stderr listener so we still capture its output.
      child.unref();

      const deadline = Date.now() + LOCAL_OP_OPEN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await wait(500);
        const uiLock = readUiLock(lockDir);
        if (uiLock && uiLock.port > 0) {
          return { port: uiLock.port };
        }
        if (earlyExitCode !== null) {
          const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
          // Name the real cause: spawn failure, signal kill, or exit code — so
          // `code -1` (a non-POSIX sentinel) never appears unqualified. Stored as
          // a string (not the Error object) so the closure-mutated `let` is only
          // ever stringified, never property-accessed (TS narrows it to `never`).
          const cause = spawnErrorMessage
            ? `spawn failed: ${spawnErrorMessage}`
            : earlyExitSignal
              ? `killed by ${earlyExitSignal}`
              : `code ${earlyExitCode}`;
          return {
            error: `\`ok ${cliCmd}\` exited (${cause})${stderr ? ` — ${stderr}` : ''}`,
            exited: true,
          };
        }
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
      return {
        error: `UI did not start within the expected time${stderr ? ` — ${stderr}` : ''}`,
        exited: false,
      };
    };

    // Case 2 vs 3: pick which CLI command to spawn based on whether the
    // collab server is already live. `ok ui` alone is correct and necessary
    // when `server.lock` is held (can't re-run `ok start` under a live lock).
    const existingServer = readServerLock(lockDir);
    const cliCmd = existingServer && existingServer.port > 0 ? 'ui' : 'start';
    const result = await spawnAndAwaitUi(cliCmd);

    // TOCTOU collision-fallback. A `start` spawn can lose a race to a concurrent
    // server start (the MCP-shim autostart, a second preview-open) that acquired
    // `server.lock` between the `readServerLock` check above and the child's own
    // acquisition; the child then exits (typically a ProcessLockCollisionError).
    // We key off the observable signature rather than the exit reason: if the
    // `start` child exited early AND a live `server.lock` now exists, connect to
    // it via `ok ui`. This also harmlessly covers a non-collision early exit that
    // happens to coincide with a live lock — the right move there is still to
    // connect to the running server. Net: a lost race degrades to "connect",
    // never a failed pane.
    if (cliCmd === 'start' && 'error' in result && result.exited) {
      const nowServer = readServerLock(lockDir);
      if (nowServer && nowServer.port > 0) {
        const connectResult = await spawnAndAwaitUi('ui');
        if ('port' in connectResult) return connectResult;
        // Preserve both legs for diagnostics: why `start` exited AND why the
        // connect fallback then failed.
        return { error: `${result.error}; connect fallback failed: ${connectResult.error}` };
      }
    }

    if ('port' in result) return result;
    return { error: result.error };
  }

  /**
   * POST /api/local-op/ok-init
   *
   * Body: { projectPath: string }
   *
   * Scaffolds `.ok/config.yml` (+ `.ok/.gitignore` + project-root
   * `.okignore`) inside a freshly-picked git worktree so the share-receive
   * consent dialog can opt the user into a CLI-managed worktree that
   * was never opened in OK.
   *
   * Gates (in order):
   *   1. Absolute-path discipline (`isAbsolute`) — refuse relative paths.
   *   2. `realpathSync` collapse — every path comparison from here uses
   *      the canonical realpath so symlinked anchors collapse to the
   *      same identity that `listGitWorktrees` emits.
   *   3. Home-dir containment (`isSafeLocalPath`) — refuse with
   *      `dir-outside-home` when the canonical path resolves outside the
   *      user's home directory, matching every sibling local-op endpoint.
   *      Checked on the canonical path so a symlinked anchor can't slip a
   *      scaffold write past the gate.
   *   4. `resolveGitDirDetailed` — refuse with `not-a-git-worktree` if
   *      `.git` is absent/inaccessible/malformed at projectPath. Both
   *      `'directory'` (main checkout) and `'linked'` (worktree) are
   *      accepted — that's the whole point.
   *   5. Idempotency: if `isProjectRoot(realpath)` already true, return
   *      `{ok: true}` without rewriting `config.yml`. Preserves user
   *      customizations the same way `writeIfMissing` does.
   *   6. Scaffold via `initContent` — wrapped in `withParentLock` so the
   *      writes serialize against any concurrent git mutation on the
   *      same project (e.g., a `runCheckoutFlow` in flight).
   *
   * Idempotent + readonly-by-default: scaffold writes use the
   * `tracedWriteFileSync`-backed `writeIfMissing` from `init-project.ts`
   * so the endpoint never clobbers user customizations on retry.
   *
   * Returns: `{ok: true, projectPath: <realpath>}` on success,
   * `{ok: false, reason: 'not-a-git-worktree' | 'init-failed', message}`
   * on logical failure (both HTTP 200). Protocol errors (malformed body,
   * unexpected exception) use the standard RFC 9457 problem+json envelope.
   */
  const HANDLE_LOCAL_OP_OK_INIT = 'local-op-ok-init';
  const handleLocalOpOkInit = withValidation(
    LocalOpOkInitRequestSchema,
    async (_req, res, body) => {
      const { projectPath } = body;

      if (!isAbsolute(projectPath)) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'projectPath must be an absolute path.',
          {
            handler: HANDLE_LOCAL_OP_OK_INIT,
            cause: new Error(`projectPath=${projectPath}`),
          },
        );
        return;
      }

      let canonicalPath: string;
      try {
        canonicalPath = realpathSync(projectPath);
      } catch (err) {
        successResponse(
          res,
          200,
          LocalOpOkInitResponseSchema,
          {
            ok: false,
            reason: 'not-a-git-worktree',
            message: `projectPath does not exist or is not accessible: ${(err as Error).message}`,
          },
          { handler: HANDLE_LOCAL_OP_OK_INIT },
        );
        return;
      }

      // Security: the canonical path must be within the user home dir.
      // Checked on the realpath (not the raw projectPath) so a symlinked
      // anchor pointing outside home can't slip a scaffold write past the
      // gate. Mirrors the sibling /api/local-op/clone containment check.
      if (!isSafeLocalPath(canonicalPath)) {
        errorResponse(
          res,
          400,
          'urn:ok:error:dir-outside-home',
          'projectPath must be within the user home directory.',
          {
            handler: HANDLE_LOCAL_OP_OK_INIT,
            cause: new Error(`projectPath=${projectPath}`),
          },
        );
        return;
      }

      const gitDirKind = resolveGitDirDetailed(canonicalPath).kind;
      if (gitDirKind !== 'directory' && gitDirKind !== 'linked') {
        console.warn(
          `[ok-init] action=init project=${basename(canonicalPath)} result=not-a-git-worktree kind=${gitDirKind}`,
        );
        successResponse(
          res,
          200,
          LocalOpOkInitResponseSchema,
          {
            ok: false,
            reason: 'not-a-git-worktree',
            message: `projectPath is not a git working tree (.git is ${gitDirKind}).`,
          },
          { handler: HANDLE_LOCAL_OP_OK_INIT },
        );
        return;
      }

      // Idempotency: if `.ok/config.yml` already exists, return ok without
      // rewriting. This is the writeIfMissing semantic of initContent surfaced
      // earlier so callers don't see two `[ok-init] action=init …` log lines
      // for a no-op call.
      if (isProjectRoot(canonicalPath)) {
        console.warn(
          `[ok-init] action=init project=${basename(canonicalPath)} result=already-initialized`,
        );
        successResponse(
          res,
          200,
          LocalOpOkInitResponseSchema,
          { ok: true, projectPath: canonicalPath },
          { handler: HANDLE_LOCAL_OP_OK_INIT },
        );
        return;
      }

      if (!localOpGuard.tryAcquire(LOCAL_OP_OK_INIT_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'An ok-init operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_OK_INIT, extraHeaders: { 'Retry-After': '2' } },
        );
        return;
      }

      try {
        // Serialize against concurrent git operations on the same project
        // (e.g., a checkout flow racing scaffold writes).
        await withParentLock(async () => {
          initContent(canonicalPath);
        });
        console.warn(`[ok-init] action=init project=${basename(canonicalPath)} result=success`);
        successResponse(
          res,
          200,
          LocalOpOkInitResponseSchema,
          { ok: true, projectPath: canonicalPath },
          { handler: HANDLE_LOCAL_OP_OK_INIT },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[ok-init] action=init project=${basename(canonicalPath)} result=failed reason=${message}`,
        );
        successResponse(
          res,
          200,
          LocalOpOkInitResponseSchema,
          { ok: false, reason: 'init-failed', message },
          { handler: HANDLE_LOCAL_OP_OK_INIT },
        );
      } finally {
        localOpGuard.release(LOCAL_OP_OK_INIT_KEY);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_OK_INIT,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_OK_INIT }),
    },
  );

  // ─── Auth relay endpoints (/api/local-op/auth/*) ────────────────────────────
  // Loopback + origin security enforced on all four endpoints.
  // Each endpoint has its own concurrency key to allow parallel auth operations
  // (e.g., status check while login is in progress).

  const LOCAL_OP_AUTH_LOGIN_KEY = '/api/local-op/auth/login';
  const LOCAL_OP_AUTH_STATUS_KEY = '/api/local-op/auth/status';
  const LOCAL_OP_AUTH_REPOS_KEY = '/api/local-op/auth/repos';
  const LOCAL_OP_AUTH_SIGNOUT_KEY = '/api/local-op/auth/signout';

  /**
   * Default host for the auth relay endpoints when the request omits `host`.
   * Read per-request (not cached): the origin remote can change over the
   * server's lifetime.
   */
  const defaultAuthHost = (): string => originGitHubHost(projectDir ?? contentDir);

  // In-flight device-flow controller for the login endpoint. Lets a disconnect
  // or a fresh start free/displace the slot synchronously instead of waiting
  // for the cancelled child to exit. Object identity is the ownership token:
  // only the current owner releases the slot, so a displaced/disconnected flow
  // can never free a successor's slot. Mirrors the IPC twin's `authInFlight`
  // (desktop/src/main/ipc/local-op.ts).
  let authLoginInFlight: ReturnType<typeof runDeviceFlowSubprocess> | null = null;

  /**
   * POST /api/local-op/auth/login
   *
   * Body: { host?: string }
   * Spawns: auth login --json [--host <host>]
   * Streams: NDJSON lines (verification + complete events) via chunked HTTP.
   * The device-flow subprocess manages its own timeout.
   *
   * Streaming endpoint: pre-stream errors emit
   * `application/problem+json`; mid-stream errors emit a typed event
   * `{ type: 'error', problem: ProblemDetails }`. The CLI's own
   * `{ type: 'error', message }` events are intercepted and wrapped so the
   * client always sees the canonical streaming envelope.
   */
  const HANDLE_LOCAL_OP_AUTH_LOGIN = 'local-op-auth-login';
  const handleLocalOpAuthLogin = withValidation(
    LocalOpAuthHostRequestSchema,
    handleLocalOpAuthLoginInner,
    {
      handler: HANDLE_LOCAL_OP_AUTH_LOGIN,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_LOGIN }),
    },
  );
  async function handleLocalOpAuthLoginInner(
    _req: IncomingMessage,
    res: ServerResponse,
    body: LocalOpAuthHostRequest,
  ): Promise<void> {
    const host = body.host ?? defaultAuthHost();

    if (!localOpGuard.tryAcquire(LOCAL_OP_AUTH_LOGIN_KEY)) {
      const stale = authLoginInFlight;
      if (!stale) {
        // Structurally unreachable: the Set key and `authLoginInFlight` are
        // assigned with no `await` between them, so a held slot always has a
        // controller. Log at `error` (a distinct event, not a 429 that looks
        // like normal concurrency) so a refactor that breaks that coupling is
        // diagnosable, then keep the 429 as the loud fallback rather than
        // silently re-owning a slot whose owner we can't identify.
        console.error(
          JSON.stringify({
            event: 'ok-local-op:auth-login-slot-no-controller',
            channel: 'auth',
            transport: 'http',
          }),
        );
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'An auth login operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_AUTH_LOGIN, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      // A missed/late disconnect left a stale login holding the slot. Displace
      // it so a fresh login is always admittable: SIGTERM the stale child so it
      // can't keep polling and write an unconfirmed token, then re-own the slot
      // (the Set key stays held — this request claims it below). The displacement
      // is logged at `warn` because it signals the disconnect cleanup was missed,
      // so ops can grep for it before users hit a stuck slot.
      stale.cancel();
      authLoginInFlight = null;
      console.warn(
        JSON.stringify({
          event: 'ok-local-op:idempotent-start-replaced-stale-slot',
          channel: 'auth',
          transport: 'http',
        }),
      );
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });

    // Wrap CLI raw `error` events in RFC 9457 streaming envelope.
    const writeStreamError = createStreamingErrorWriter(res, HANDLE_LOCAL_OP_AUTH_LOGIN);

    const flow = runDeviceFlowSubprocess({
      cliArgs: localOpCliArgs,
      host,
      timeoutMs: LOCAL_OP_TIMEOUT_MS,
      onEvent: (event: AuthEvent) => {
        if (event.type === 'error') {
          writeStreamError(500, 'urn:ok:error:auth-failed', 'Auth subprocess reported an error.', {
            cause: event.message ? new Error(event.message) : undefined,
          });
          return;
        }
        // On `complete`, resume a SyncEngine parked in `auth-error` so a
        // reconnect restores sync without an app restart. Server-authoritative:
        // works regardless of which UI surface (sync badge or Settings →
        // Account) ran the login.
        resumeSyncOnAuthEvent(event, getSyncEngine);
        // Three-way guard + try-catch matches `createStreamingErrorWriter`
        // race-window defense. Lost progress event is not crashworthy.
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(`${JSON.stringify(event)}\n`);
          } catch {
            /* socket destroyed between guard and write — event lost */
          }
        }
      },
    });
    authLoginInFlight = flow;

    // Kill the child if the client disconnects so `auth login` doesn't keep
    // polling in the background and write a token to the keychain that the
    // user never saw confirmation for.
    const onClientClose = () => {
      flow.cancel();
      // Free the slot synchronously rather than waiting for the cancelled
      // child to exit — the SIGTERM-to-exit window would otherwise 429 a
      // reopen. Ownership-guarded so we only release a slot we still own.
      if (authLoginInFlight === flow) {
        authLoginInFlight = null;
        localOpGuard.release(LOCAL_OP_AUTH_LOGIN_KEY);
      }
    };
    res.on('close', onClientClose);

    // Sibling clone handler at handleLocalOpClone wraps an equivalent
    // cleanup in a full `void (async () => { try {...} catch {...} finally {...} })()`
    // IIFE because clone has post-flow work (`startServerAtDirAndGetPort`)
    // that can genuinely throw. Auth-login has no post-flow work and
    // `flow.done` cannot reject — `proc.done` (local-ops/subprocess.ts) only
    // ever resolves, and the `.then` callback deriving `flow.done` only calls
    // `opts.onEvent`, which is throw-safe here (both the writeStreamError and
    // the res.write branches carry their own try/catch). So the simpler
    // `.finally()` form needs no IIFE-level try/catch — the asymmetry is
    // intentional, not a missing safeguard. The release is ownership-guarded:
    // a displaced/disconnected flow that already freed or handed off the slot
    // must not release a successor's slot when its child finally exits.
    void flow.done.finally(() => {
      res.off('close', onClientClose);
      // Same guard + try-catch as the `onEvent` writer above: the socket can be
      // destroyed between this check and `res.end()` (client gone), and an
      // uncaught throw would skip the ownership-guarded release below — the
      // exact orphaned-slot failure this handler exists to prevent.
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          /* socket destroyed between guard and end — response already closed */
        }
      }
      if (authLoginInFlight === flow) {
        authLoginInFlight = null;
        localOpGuard.release(LOCAL_OP_AUTH_LOGIN_KEY);
      }
    });
  }

  /**
   * POST /api/local-op/auth/status
   *
   * Body: { host?: string }
   * Spawns: auth status --json [--host <host>]
   * Returns: the single NDJSON line as parsed JSON.
   */
  const HANDLE_LOCAL_OP_AUTH_STATUS = 'local-op-auth-status';
  const handleLocalOpAuthStatus = withValidation(
    LocalOpAuthHostRequestSchema,
    async (_req, res, body) => {
      const host = body.host ?? defaultAuthHost();

      if (!localOpGuard.tryAcquire(LOCAL_OP_AUTH_STATUS_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'An auth status operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_AUTH_STATUS, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }

      try {
        const [cmd, ...baseArgs] = localOpCliArgs;
        const spawnArgs = [...baseArgs, 'auth', 'status', '--json', '--host', host];

        const output = await new Promise<string>((resolve, reject) => {
          const child = spawn(
            cmd,
            spawnArgs,
            withHiddenWindowsConsole({
              ...LOCAL_OP_PIPE_STDIO_OPTIONS,
              env: { ...process.env },
            }),
          );
          let timedOut = false;
          const killTimer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
          }, 30_000);
          const chunks: Buffer[] = [];
          child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
          child.on('close', () => {
            clearTimeout(killTimer);
            // Reject on timeout — without this, a hung subprocess (slow
            // keychain probe, network stall) would resolve with whatever
            // (empty / partial) stdout was buffered. The downstream JSON
            // parse falls back to `{ authenticated: false }`, producing a
            // wrong-result "not logged in" UX for an authenticated user.
            // Surfaces as 500 `auth-failed` via the outer catch + Pino log.
            if (timedOut) {
              reject(new Error('auth status subprocess timed out after 30s'));
              return;
            }
            resolve(Buffer.concat(chunks).toString('utf-8'));
          });
          child.on('error', (err) => {
            clearTimeout(killTimer);
            reject(err);
          });
        });

        // The CLI may emit non-JSON log lines on stdout before the terminal
        // event (e.g. keychain probe messages on older builds). Find the last
        // parseable JSON line and return that.
        const lines = output
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        let parsed: unknown = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            parsed = JSON.parse(lines[i] as string);
            break;
          } catch {
            /* skip non-JSON line */
          }
        }
        if (parsed !== null) {
          successResponse(res, 200, LocalOpAuthStatusSuccessSchema, parsed, {
            handler: HANDLE_LOCAL_OP_AUTH_STATUS,
          });
        } else {
          successResponse(
            res,
            200,
            LocalOpAuthStatusSuccessSchema,
            { authenticated: false },
            { handler: HANDLE_LOCAL_OP_AUTH_STATUS },
          );
        }
      } catch (err) {
        // Fixed-vocabulary detail — raw err.message can carry filesystem paths,
        // git stderr, or errno strings. Pino logs preserve full diagnostics via
        // `cause` for server-side triage; the wire body stays bounded.
        errorResponse(res, 500, 'urn:ok:error:auth-failed', 'Auth status check failed.', {
          handler: HANDLE_LOCAL_OP_AUTH_STATUS,
          cause: err,
        });
      } finally {
        localOpGuard.release(LOCAL_OP_AUTH_STATUS_KEY);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_AUTH_STATUS,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_STATUS }),
    },
  );

  /**
   * POST /api/local-op/auth/repos
   *
   * Body: { host?: string }
   * Spawns: auth repos --json [--host <host>]
   * Streams: NDJSON via chunked HTTP.
   *
   * Streaming endpoint: pre-stream errors emit
   * `application/problem+json`; mid-stream errors emit a typed event
   * `{ type: 'error', problem: ProblemDetails }`. CLI `error` events are
   * intercepted and wrapped to keep the streaming envelope canonical.
   */
  const HANDLE_LOCAL_OP_AUTH_REPOS = 'local-op-auth-repos';
  const handleLocalOpAuthRepos = withValidation(
    LocalOpAuthHostRequestSchema,
    handleLocalOpAuthReposInner,
    {
      handler: HANDLE_LOCAL_OP_AUTH_REPOS,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_REPOS }),
    },
  );
  async function handleLocalOpAuthReposInner(
    _req: IncomingMessage,
    res: ServerResponse,
    body: LocalOpAuthHostRequest,
  ): Promise<void> {
    const host = body.host ?? defaultAuthHost();

    if (!localOpGuard.tryAcquire(LOCAL_OP_AUTH_REPOS_KEY)) {
      errorResponse(
        res,
        429,
        'urn:ok:error:concurrent-operation',
        'An auth repos operation is already in progress.',
        { handler: HANDLE_LOCAL_OP_AUTH_REPOS, extraHeaders: { 'Retry-After': '5' } },
      );
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });

    /** Write a typed mid-stream error event. */
    const writeStreamError = createStreamingErrorWriter(res, HANDLE_LOCAL_OP_AUTH_REPOS);

    const [cmd, ...baseArgs] = localOpCliArgs;
    const spawnArgs = [...baseArgs, 'auth', 'repos', '--json', '--host', host];

    let settled = false;
    let stdoutBuffer = '';
    const child = spawn(
      cmd,
      spawnArgs,
      withHiddenWindowsConsole({
        ...LOCAL_OP_PIPE_STDIO_OPTIONS,
        env: { ...process.env },
      }),
    );

    const killTimer = setTimeout(() => {
      child.kill('SIGTERM');
    }, LOCAL_OP_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt: { type?: unknown; message?: unknown } | null = null;
        try {
          evt = JSON.parse(line) as { type?: unknown; message?: unknown };
        } catch {
          /* non-JSON line — ignore */
        }
        if (evt && evt.type === 'error') {
          // Wrap CLI's untyped error into the canonical streaming envelope.
          const detail = typeof evt.message === 'string' ? evt.message : undefined;
          writeStreamError(
            500,
            'urn:ok:error:auth-failed',
            'Auth repos subprocess reported an error.',
            { detail },
          );
          continue;
        }
        // Three-way guard + try-catch — see clone handler progress write.
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(`${line}\n`);
          } catch {
            /* socket destroyed between guard and write — line lost */
          }
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      log.debug({ msg: chunk.toString('utf-8').trim() }, '[local-op/auth/repos] stderr');
    });

    // `localOpGuard.release()` lives INSIDE the `settled` guard at every
    // exit branch (child close, child error, client disconnect) so the
    // concurrency guard is released at most once. Releasing outside the
    // guard would double-release when one branch fires after another —
    // most reliably reproduced by client disconnect mid-subprocess, where
    // res.on('close') fires first, then the killed child triggers
    // child.on('close') with the now-stale settled flag still suppressed.
    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        if (code !== 0 && !res.writableEnded) {
          writeStreamError(
            500,
            'urn:ok:error:auth-failed',
            `Auth repos subprocess exited with code ${code}.`,
          );
        }
        res.end();
        localOpGuard.release(LOCAL_OP_AUTH_REPOS_KEY);
      }
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        if (!res.writableEnded) {
          // Fixed-vocabulary detail — see clone-failed catch site.
          writeStreamError(
            500,
            'urn:ok:error:auth-failed',
            'Failed to spawn the auth repos subprocess.',
            { cause: err },
          );
          res.end();
        }
        localOpGuard.release(LOCAL_OP_AUTH_REPOS_KEY);
      }
    });

    // Kill the child if the client disconnects so `auth repos` doesn't keep
    // an open HTTPS connection to GitHub's API in the background after the
    // browser tab closes. Mirrors the disconnect-cleanup pattern in
    // handleLocalOpClone (flow.cancel) and handleLocalOpAuthLogin
    // (res.on('close', onClientClose)). The `settled` flag check makes
    // this idempotent against the child.on('close') / child.on('error')
    // branches that may have already cleaned up.
    res.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(killTimer);
        child.kill('SIGTERM');
        localOpGuard.release(LOCAL_OP_AUTH_REPOS_KEY);
      }
    });
  }

  /**
   * POST /api/local-op/auth/signout
   *
   * Body: { host?: string }
   * Spawns: auth signout [--host <host>]
   * Returns: {} (flat success)
   */
  const HANDLE_LOCAL_OP_AUTH_SIGNOUT = 'local-op-auth-signout';
  const handleLocalOpAuthSignout = withValidation(
    LocalOpAuthHostRequestSchema,
    async (_req, res, body) => {
      const host = body.host ?? defaultAuthHost();

      if (!localOpGuard.tryAcquire(LOCAL_OP_AUTH_SIGNOUT_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'An auth signout operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_AUTH_SIGNOUT, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }

      try {
        const [cmd, ...baseArgs] = localOpCliArgs;
        const spawnArgs = [...baseArgs, 'auth', 'signout', '--host', host];

        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            cmd,
            spawnArgs,
            withHiddenWindowsConsole({
              ...LOCAL_OP_IGNORED_STDIO_OPTIONS,
              env: { ...process.env },
            }),
          );
          const killTimer = setTimeout(() => {
            child.kill('SIGTERM');
          }, 30_000);
          child.on('close', () => {
            clearTimeout(killTimer);
            resolve();
          });
          child.on('error', (err) => {
            clearTimeout(killTimer);
            reject(err);
          });
        });

        successResponse(
          res,
          200,
          LocalOpAuthEmptySuccessSchema,
          {},
          {
            handler: HANDLE_LOCAL_OP_AUTH_SIGNOUT,
          },
        );
      } catch (err) {
        // Fixed-vocabulary detail — see HANDLE_LOCAL_OP_AUTH_STATUS catch site.
        errorResponse(res, 500, 'urn:ok:error:auth-failed', 'Auth signout failed.', {
          handler: HANDLE_LOCAL_OP_AUTH_SIGNOUT,
          cause: err,
        });
      } finally {
        localOpGuard.release(LOCAL_OP_AUTH_SIGNOUT_KEY);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_AUTH_SIGNOUT,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_SIGNOUT }),
    },
  );

  // ─── POST /api/local-op/auth/set-identity ──────────────────────────────────
  // Writes git user.name + user.email scoped to the checkout `projectDir`
  // points at: per-worktree config on a linked worktree (enabling
  // `extensions.worktreeConfig` if needed), repo-local config otherwise. The
  // worktree fork prevents silent rewrites of the main checkout's identity
  // when OK is launched from a `git worktree add`-ed directory.
  // On success, nudges the sync engine to re-probe the identity chain
  // so the UI unresolved-nudge clears immediately instead of waiting for the
  // next push cycle.

  const LOCAL_OP_AUTH_SET_IDENTITY_KEY = '/api/local-op/auth/set-identity';

  const HANDLE_LOCAL_OP_AUTH_SET_IDENTITY = 'local-op-auth-set-identity';
  const handleLocalOpAuthSetIdentity = withValidation(
    LocalOpAuthSetIdentityRequestSchema,
    async (_req, res, body) => {
      const name = body.name.trim();
      const email = body.email.trim();

      if (!projectDir) {
        errorResponse(res, 503, 'urn:ok:error:no-project-dir', 'No project directory configured.', {
          handler: HANDLE_LOCAL_OP_AUTH_SET_IDENTITY,
        });
        return;
      }

      if (!localOpGuard.tryAcquire(LOCAL_OP_AUTH_SET_IDENTITY_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'A set-identity operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_AUTH_SET_IDENTITY, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }

      try {
        writeGitIdentity(projectDir, name, email);
        // Fire-and-forget: the sync engine re-probes + signals CC1 'sync-status'
        // so the unresolved nudge clears in the UI without waiting on the push timer.
        void getSyncEngine?.()
          ?.refreshIdentity()
          .catch(() => {
            /* best-effort — status will catch up on next push cycle */
          });
        successResponse(
          res,
          200,
          LocalOpAuthEmptySuccessSchema,
          {},
          {
            handler: HANDLE_LOCAL_OP_AUTH_SET_IDENTITY,
          },
        );
      } catch (err) {
        // Fixed-vocabulary detail — see HANDLE_LOCAL_OP_AUTH_STATUS catch site.
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Set-identity failed.', {
          handler: HANDLE_LOCAL_OP_AUTH_SET_IDENTITY,
          cause: err,
        });
      } finally {
        localOpGuard.release(LOCAL_OP_AUTH_SET_IDENTITY_KEY);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_AUTH_SET_IDENTITY,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_SET_IDENTITY }),
    },
  );

  // ─── Security helpers for sync endpoints ────────────────────────────────────
  // Sync endpoints reuse the shared loopback + origin check from local-op-security.ts
  // to avoid duplicating the same logic (checkLocalOpSecurity already imported above).

  // ─── Sync endpoints ──────────────────────────────────────────────────────────

  async function handleSyncStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'sync-status' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'sync-status',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    try {
      const engine = getSyncEngine?.();
      if (!engine) {
        // Shape must stay aligned with SyncStatus (see sync-engine.ts) — the UI
        // reads these fields unconditionally. Dormant fallback when the engine
        // isn't constructed (no remote, sync disabled at boot).
        successResponse(
          res,
          200,
          SyncStatusSchema,
          {
            state: 'dormant',
            lastSyncUtc: null,
            lastFetchUtc: null,
            lastPushedSha: null,
            ahead: 0,
            behind: 0,
            consecutiveFailures: 0,
            conflictCount: 0,
            hasRemote: false,
            syncEnabled: false,
            identityUnresolved: false,
            remote: null,
          },
          { handler: 'sync-status' },
        );
        return;
      }
      // Lazy remote re-detection: if the user ran `git remote add origin <url>`
      // after the server booted, refresh `hasRemote` so the Settings → Sync
      // empty state and badge update without an app restart. No-op once a
      // remote has been observed.
      await engine.refreshRemote();
      successResponse(res, 200, SyncStatusSchema, engine.getStatus(), {
        handler: 'sync-status',
      });
    } catch (e) {
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'sync-status',
        cause: e,
      });
    }
  }

  const handleSyncTrigger = withValidation(
    SyncTriggerRequestSchema,
    async (_req, res, body) => {
      const engine = getSyncEngine?.();
      if (!engine) {
        // Race-window guard: the preBodyGate confirmed the engine was active,
        // but it could have been torn down between gate and inner-handler
        // invocation. Treat as 503 — same as the gate would have.
        errorResponse(res, 503, 'urn:ok:error:sync-not-active', 'Sync engine not active.', {
          handler: 'sync-trigger',
        });
        return;
      }
      const op = body.op ?? 'sync';
      // Fire-and-return: 202 Accepted immediately, trigger runs in background.
      successResponse(res, 202, SyncTriggerSuccessSchema, { op }, { handler: 'sync-trigger' });
      void engine.trigger(op);
    },
    {
      handler: 'sync-trigger',
      method: 'POST',
      preBodyGate: (req, res) => {
        if (!checkLocalOpSecurity(req, res, { handler: 'sync-trigger' })) return false;
        const engine = getSyncEngine?.();
        if (!engine) {
          errorResponse(res, 503, 'urn:ok:error:sync-not-active', 'Sync engine not active.', {
            handler: 'sync-trigger',
          });
          return false;
        }
        return true;
      },
    },
  );

  async function handleSyncConflicts(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'sync-conflicts' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'sync-conflicts',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    try {
      const engine = getSyncEngine?.();
      const conflicts = engine ? engine.getConflicts() : [];
      successResponse(
        res,
        200,
        SyncConflictsSuccessSchema,
        { conflicts },
        {
          handler: 'sync-conflicts',
        },
      );
    } catch (e) {
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'sync-conflicts',
        cause: e,
      });
    }
  }

  const handleSyncResolveConflict = withValidation(
    SyncResolveConflictRequestSchema,
    async (_req, res, body) => {
      const engine = getSyncEngine?.();
      if (!engine) {
        // Race-window guard — see HANDLE_SYNC_TRIGGER comment.
        errorResponse(res, 503, 'urn:ok:error:sync-not-active', 'Sync engine not active.', {
          handler: 'sync-resolve-conflict',
        });
        return;
      }
      const { file, strategy, content } = body;
      try {
        await engine.resolveConflict(file, strategy as ResolveStrategy, content);
        successResponse(
          res,
          200,
          SyncResolveConflictSuccessSchema,
          {},
          {
            handler: 'sync-resolve-conflict',
          },
        );
      } catch (e) {
        // Surface the underlying error (typically the git commit stderr
        // wrapped by `ConflictStore.resolveConflict`) on the RFC 9457
        // `detail` field so operators + UI toasts + agent tools have the
        // diagnostic context — without this, every commit failure looks
        // identical at the client.
        const detail = e instanceof Error ? e.message : undefined;
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to resolve conflict.',
          {
            handler: 'sync-resolve-conflict',
            cause: e,
            detail,
          },
        );
      }
    },
    {
      handler: 'sync-resolve-conflict',
      method: 'POST',
      preBodyGate: (req, res) => {
        if (!checkLocalOpSecurity(req, res, { handler: 'sync-resolve-conflict' })) return false;
        const engine = getSyncEngine?.();
        if (!engine) {
          errorResponse(res, 503, 'urn:ok:error:sync-not-active', 'Sync engine not active.', {
            handler: 'sync-resolve-conflict',
          });
          return false;
        }
        return true;
      },
    },
  );

  async function handleSyncConflictContent(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'sync-conflict-content' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'sync-conflict-content',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    if (!projectDir) {
      errorResponse(
        res,
        503,
        'urn:ok:error:project-repo-not-configured',
        'Project repo not configured.',
        { handler: 'sync-conflict-content' },
      );
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const file = url.searchParams.get('file');
    if (!file) {
      errorResponse(
        res,
        400,
        'urn:ok:error:invalid-request',
        'Missing required query param: file.',
        {
          handler: 'sync-conflict-content',
        },
      );
      return;
    }
    // Reject obvious path-traversal; git itself rejects paths outside the index.
    if (file.includes('..') || file.startsWith('/')) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid file path.', {
        handler: 'sync-conflict-content',
      });
      return;
    }
    // Refuse the request when no conflict is tracked for the path. Without
    // this gate, the git stage reads silently return empty strings for
    // untracked files, producing a 200 response with empty base/ours/theirs
    // — misleading to agents that took the file path from a stale 409
    // envelope or have inconsistent state. The tool description on
    // `conflicts({ kind: 'content' })` documents this 404; the gate enforces it.
    //
    // Authority is split between two sources that normally agree but can
    // diverge in tests / external-git scenarios: (a) ConflictStore via the
    // SyncEngine — populated when SyncEngine merges; and (b) the doc's
    // `lifecycle.status` Y.Map — set by the file-watcher's `case 'conflict'`
    // branch even when SyncEngine wasn't involved (markers landed on disk
    // via external git ops). Accept EITHER as authoritative tracking.
    const trackedDocName = stripDocExtension(file);
    const loadedDoc = hocuspocus.documents.get(trackedDocName);
    const isConflictedByLifecycle = loadedDoc?.getMap('lifecycle').get('status') === 'conflict';
    const engine = getSyncEngine?.();
    const isTrackedByStore = engine ? engine.getConflicts().some((c) => c.file === file) : false;
    if (!isConflictedByLifecycle && !isTrackedByStore) {
      errorResponse(
        res,
        404,
        'urn:ok:error:no-conflict-tracked',
        'No conflict is tracked for this path.',
        {
          handler: 'sync-conflict-content',
          extensions: { file },
        },
      );
      return;
    }
    // Optional `?source=ytext` override: when the requested file maps to
    // a loaded doc, serve `ours` from the live Y.Text snapshot rather
    // than the git index. Covers the pre-conflict-unflushed-edits case
    // where Y.Text holds bytes the user typed after the last persistence
    // flush (persistence-during-conflict skip means those bytes don't
    // reach disk during conflict). Any other value (or no value) falls
    // back to the default `git show :2:` path so existing callers stay
    // backward-compatible.
    const source = url.searchParams.get('source');
    const pg = simpleGit({ baseDir: projectDir, timeout: { block: 15_000 } });
    // git stages: 1 = base, 2 = ours, 3 = theirs. Any may be missing for
    // delete/edit or add/add conflicts. Return a discriminated shape so the
    // caller can derive `kind` from stage presence — empty-string content is
    // otherwise indistinguishable from a legitimately-empty file, and the
    // earlier swallow-and-return-`''` shape silently mapped DU/UD into the
    // both-modified path.
    type StageResult = { present: false } | { present: true; content: string };
    // Discriminate "stage genuinely absent" (expected for DU/UD) from
    // "git subprocess failed" (transient: timeout, permissions, corruption).
    // Both map to `{ present: false }` and the caller derives `kind` from
    // it — without this discrimination, a transient git error silently
    // sets `kind` to `'delete-modify'`, the UI renders "Keep deletion" for
    // a file the user actually edited, and clicking it `git rm`s the file.
    // Log unexpected errors loudly so "user lost work after resolution"
    // incidents have a paper trail.
    async function showStage(stage: 1 | 2 | 3): Promise<StageResult> {
      try {
        return { present: true, content: await pg.raw(['show', `:${stage}:${file}`]) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Expected "stage absent" git error shapes from simple-git's stderr
        // passthrough. Observed in practice:
        //   - "pathspec '...' did not match any files known to git"
        //   - "path '...' is in the index, but not at stage <N>"
        //   - "path '...' exists on disk, but not in '<ref>'"
        // Full-phrase matches only — short fragments like "but not in"
        // alone could false-match unrelated git errors and silently
        // return `{ present: false }` for a real failure (data-loss
        // class). Locale-stable English fragments — git messages are
        // English-only.
        const isAbsent =
          /pathspec|did not match|exists on disk, but not in|is in the index, but not at stage/i.test(
            msg,
          );
        if (!isAbsent) {
          // Unexpected git failure (timeout, object corruption, permission,
          // EMFILE). Returning `{ present: false }` would drive `kind`
          // derivation downstream silently — a transient stage-2 failure
          // on a both-modified conflict would produce
          // `kind: 'delete-modify'`, the UI would render "Keep file
          // deleted" + "Restore with remote changes", and clicking
          // "Keep file deleted" would `git rm` a file the user edited.
          // Rethrow so the outer try converts to a 500;
          // the UI's `fetchFailed` state ("Couldn't load conflict
          // content — try reloading") handles it visibly.
          console.warn(
            JSON.stringify({
              event: 'showstage-unexpected-error',
              stage,
              file,
              detail: msg,
              handler: 'sync-conflict-content',
            }),
          );
          throw err;
        }
        return { present: false };
      }
    }
    try {
      const [baseResult, oursResult, theirsResult] = await Promise.all([
        showStage(1),
        showStage(2),
        showStage(3),
      ]);
      const base = baseResult.present ? baseResult.content : '';
      const theirs = theirsResult.present ? theirsResult.content : '';
      // Derive the stage-presence discriminator. Reaching this handler
      // requires the conflict-tracked guard above, so
      // at least one of stages 2/3 is always present — `neither` is
      // unreachable at runtime. The four branches are enumerated
      // explicitly (rather than collapsed into a trailing else) so the
      // `(false, false)` branch is self-documenting: it surfaces
      // `'both-modified'` as a defensive default; the caller branches
      // safely off that without a load-bearing assertNever.
      const kind: 'both-modified' | 'delete-modify' | 'modify-delete' =
        oursResult.present && theirsResult.present
          ? 'both-modified'
          : !oursResult.present && theirsResult.present
            ? 'delete-modify'
            : oursResult.present && !theirsResult.present
              ? 'modify-delete'
              : 'both-modified';
      let ours = oursResult.present ? oursResult.content : '';
      // Surface `lifecycleStatus` when the doc is loaded server-side so the
      // MCP `conflicts({ kind: 'content' })` caller can detect post-resolution state
      // (status === null after the conflict clears) without a second
      // round-trip. Only meaningful in the `source=ytext` branch — the
      // default `git show :2:` path is callable without a loaded doc.
      let lifecycleStatus: string | null = null;
      if (source === 'ytext') {
        const docName = stripDocExtension(file);
        const loaded = hocuspocus.documents.get(docName);
        if (loaded) {
          const rawStatus = loaded.getMap('lifecycle').get('status');
          lifecycleStatus =
            typeof rawStatus === 'string' && rawStatus.length > 0 ? rawStatus : null;
          // Gate the Y.Text substitution on the `kind` shape. The narrow
          // risk that motivated the gate: for DU (delete-modify, stage 2
          // absent), the file-watcher seeded Y.Text with `theirs` content
          // from disk (git leaves the remote version in the working tree
          // on modify/delete conflicts). Substituting Y.Text into `ours`
          // would equal `theirs` and silently un-delete the local intent.
          // Honest path for DU: leave `ours` empty; the `kind` discriminator
          // drives the UI affordance.
          //
          // For every OTHER shape — both-modified (real merge), modify-
          // delete (stage 2 present, only theirs absent), and the legacy
          // filesystem-marker conflict path (neither stage in git index;
          // `case 'conflict'` in the file-watcher fires on disk-markers
          // without a real merge) — Y.Text substitution is correct and
          // load-bearing. A previous `oursResult.present` gate over-
          // restricted: it broke the filesystem-marker case where a
          // mid-conflict Y.Text edit must surface despite no git stages
          // existing in the index.
          if (kind !== 'delete-modify') {
            const ytextOurs = serializeDoc ? serializeDoc(docName) : null;
            if (ytextOurs !== null && !ytextHasConflictMarkers(ytextOurs)) {
              ours = ytextOurs;
            } else if (ytextOurs !== null) {
              // Structured signal so triage can spot when the marker-triple
              // detection fired and the handler fell back to git-index — the
              // alternative is silent. Pairs with `doc.name` for the
              // affected document.
              console.warn(
                JSON.stringify({
                  event: 'ytext-conflict-marker-detected',
                  'doc.name': docName,
                  handler: 'sync-conflict-content',
                }),
              );
            }
          }
        } else {
          console.warn(`[conflict-content] doc ${docName} not loaded; lifecycleStatus unavailable`);
        }
      }
      successResponse(
        res,
        200,
        SyncConflictContentSuccessSchema,
        { file, base, ours, theirs, kind, lifecycleStatus },
        { handler: 'sync-conflict-content' },
      );
    } catch (e) {
      errorResponse(
        res,
        500,
        'urn:ok:error:internal-server-error',
        'Failed to read conflict content.',
        {
          handler: 'sync-conflict-content',
          cause: e,
        },
      );
    }
  }

  // ─── `ok seed` scaffolder endpoints ──────────────────────────────────────
  // GET /api/seed/plan  → 200 {plan} (RFC 9457 problem+json on error)
  // POST /api/seed/apply with { plan } → 200 {result} (RFC 9457 problem+json on error)
  //
  // Same `planSeed` / `applySeed` logic the CLI subcommand and Electron IPC
  // handler use. The IPC bridge (`ok:seed:plan` / `ok:seed:apply`) keeps its
  // in-process discriminated-union shape (`{ok: true, plan}` / `{ok: false,
  // error: {kind, message}}`); the HTTP fallback in `seedClient()` translates
  // RFC 9457 problem+json back to that shape at the renderer boundary so
  // `SeedDialog` / `EmptyEditorState` are transport-agnostic.
  // Gated on `checkLocalOpSecurity` because the operation mutates the local
  // filesystem; same contract as /api/local-op/* and /api/installed-agents.

  /**
   * GET `/api/seed/plan?rootDir=brain&packId=software-lifecycle` — preview the
   * scaffold for a given subfolder + pack. `rootDir` defaults to `.` (project
   * root). `packId` defaults to the registry default (`'knowledge-base'`) for
   * back-compat with single-scaffold callers; unknown ids coerce to undefined
   * and `resolvePack()` falls back to the default.
   *
   * Prerequisite-missing (no git init) → 422 with
   * `urn:ok:error:seed-prerequisite-missing`; invalid-root (escape segments,
   * absolute path) → 400 with `urn:ok:error:seed-invalid-root`. Both surface
   * a `detail` carrying the underlying message so renderers can echo it.
   */
  async function handleSeedPlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'seed-plan' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'seed-plan',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rootDir = url.searchParams.get('rootDir') ?? undefined;
    const rawPackId = url.searchParams.get('packId');
    const packId = coercePackId(rawPackId);
    // Trust-boundary symmetry with the CLI: if the caller passed a `packId`
    // but it doesn't name a registered pack, reject explicitly rather than
    // silently fall back to the default pack (CLI returns "Unknown pack"
    // failure on the same input).
    if (rawPackId !== null && rawPackId !== '' && packId === undefined) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Unknown packId.', {
        handler: 'seed-plan',
        detail: `Pack id "${rawPackId}" is not registered.`,
      });
      return;
    }
    try {
      const plan = await planSeed({ projectDir: contentDir, rootDir, packId });
      successResponse(res, 200, SeedPlanSuccessSchema, { plan }, { handler: 'seed-plan' });
    } catch (err) {
      if (err instanceof SeedPrerequisiteError) {
        errorResponse(
          res,
          422,
          'urn:ok:error:seed-prerequisite-missing',
          'Seed prerequisite missing.',
          { handler: 'seed-plan', cause: err },
        );
        return;
      }
      if (err instanceof SeedRootDirError) {
        // Fixed-vocabulary safe `detail` per RFC 9457 §3.1.5 — gives the
        // client an actionable message without leaking the rejected path
        // (raw err message goes through `cause` → Pino, never on wire).
        errorResponse(res, 400, 'urn:ok:error:seed-invalid-root', 'Invalid seed root directory.', {
          handler: 'seed-plan',
          detail: 'The provided root directory is not within the workspace content directory.',
          cause: err,
        });
        return;
      }
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'seed-plan',
        cause: err,
      });
    }
  }

  /**
   * `POST /api/seed/apply` — apply a pre-computed ScaffoldPlan to disk.
   * Body accepts `{plan, packId?}` (extras pass through
   * `SeedApplyRequestSchema.loose()`); `packId` defaults to the registry
   * default.
   */
  const handleSeedApply = withValidation(
    SeedApplyRequestSchema,
    async (_req, res, body) => {
      // SeedApplyRequestSchema accepts `plan: unknown` (forward-compat); reject
      // non-object payloads here so applySeed sees a structured value.
      const planValue = body.plan;
      if (!planValue || typeof planValue !== 'object') {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid plan payload.', {
          handler: 'seed-apply',
        });
        return;
      }
      const plan = planValue as ScaffoldPlan;
      // SeedApplyRequestSchema is `.loose()` so extras flow through as `unknown`
      // on the parsed body; coerce defensively at the trust boundary. If the
      // caller passed a non-empty `packId` that doesn't name a registered
      // pack, reject explicitly (trust-boundary symmetry with the CLI, which
      // returns an "Unknown pack" failure on the same input).
      const looseBody = body as { packId?: unknown };
      const rawPackId = looseBody.packId;
      const packId = coercePackId(rawPackId);
      if (typeof rawPackId === 'string' && rawPackId.length > 0 && packId === undefined) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Unknown packId.', {
          handler: 'seed-apply',
          detail: `Pack id "${rawPackId}" is not registered.`,
        });
        return;
      }
      try {
        // The plan already has rootDir baked into its entries — apply only
        // needs projectDir + packId (so it knows which template registry to
        // resolve content from).
        const result = await applySeed(plan, { projectDir: contentDir, packId });
        successResponse(res, 200, SeedApplySuccessSchema, { result }, { handler: 'seed-apply' });
      } catch (err) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to apply seed plan.',
          {
            handler: 'seed-apply',
            cause: err,
          },
        );
      }
    },
    {
      handler: 'seed-apply',
      method: 'POST',
      preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: 'seed-apply' }),
    },
  );

  /**
   * `GET /api/seed/packs` — enumerate available starter packs. Static data;
   * no project context required. The picker UI fetches once on dialog mount.
   * Delegates to the shared `listStarterPacks()` so HTTP + IPC return the
   * same wire-format shape from one source.
   */
  async function handleSeedPacks(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'seed-packs' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'seed-packs',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    successResponse(
      res,
      200,
      SeedListPacksSuccessSchema,
      { packs: listStarterPacks() },
      { handler: 'seed-packs' },
    );
  }

  /**
   * `POST /api/install-skill` — build `openknowledge.skill` and open it via
   * the OS file association so Claude Desktop's native install dialog takes
   * over. Web-host counterpart of the Electron `okDesktop.skill.buildAndOpen`
   * bridge — both delegate to `buildAndOpenSkill` in `skill-install.ts`.
   *
   * Loopback-only via `checkLocalOpSecurity` — the handler spawns child
   * processes (`open` / `start` / `xdg-open`) and writes to the user's
   * `~/Downloads`, which is squarely state-mutating.
   *
   * Request body (optional JSON): `{ noOpen?: boolean, out?: string }`.
   * Response: the `BuildAndOpenSkillResult` shape verbatim.
   */
  const handleInstallSkill = withValidation(
    InstallSkillRequestSchema,
    async (_req, res, body) => {
      // `out` flows into `path.resolve()` + `mkdir({recursive: true})` +
      // `spawn('cmd', ['/c', 'start', '""', skillPath])` on Windows. Confine
      // to $HOME consistent with the sibling local-op handler
      // (`handleLocalOpClone`). Stays as post-validation business logic rather
      // than a `.refine()` on the schema so the URN remains the more accurate
      // `invalid-request` (the schema-shape `.refine()` rejection would also
      // route through `urn:ok:error:invalid-request` but with a generic
      // field-path message instead of this domain-specific title).
      if (body.out !== undefined && !isSafeLocalPath(body.out)) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'Output path must be within home directory.',
          { handler: 'install-skill' },
        );
        return;
      }

      try {
        const result = await buildAndOpenSkill({
          ...(body.noOpen !== undefined ? { noOpen: body.noOpen } : {}),
          ...(body.out !== undefined ? { out: body.out } : {}),
        });
        successResponse(res, 200, InstallSkillSuccessSchema, result, {
          handler: 'install-skill',
        });
      } catch (err) {
        // Generic title — raw `err.message` can leak FS paths / library internals.
        // The underlying message is forwarded to Pino via `cause` for ops triage.
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to install skill.', {
          handler: 'install-skill',
          cause: err,
        });
      }
    },
    {
      handler: 'install-skill',
      method: 'POST',
      preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: 'install-skill' }),
    },
  );

  async function handleInstalledAgentsRoute(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Loopback + DNS-rebinding gate. Same contract the rest of the host-
    // disclosure surface uses (`/api/workspace`, every `/api/local-op/*`) —
    // this endpoint discloses a stable OS-level fingerprint of which AI
    // agents are installed, readable without preflight under the permissive
    // `Access-Control-Allow-Origin: *` that `/api/*` sets. Gating on
    // `checkLocalOpSecurity` confines the fingerprint to same-machine,
    // same-origin callers (the editor UI) and refuses cross-origin browser
    // contexts + DNS-rebinding attempts that would otherwise succeed.
    // `checkLocalOpSecurity` itself emits RFC 9457 problem+json on rejection.
    if (!checkLocalOpSecurity(req, res, { handler: 'installed-agents' })) return;
    try {
      await handleInstalledAgents(req, res, installedAgentsCache.probeAll);
    } catch (e) {
      // Defensive: `handleInstalledAgents` catches internally, so this only
      // fires on truly unexpected throws (e.g., probeAll synchronously
      // throwing before its internal try/catch). Guard `headersSent` so we
      // don't double-emit if the inner handler already wrote a response.
      if (!res.headersSent) {
        log.error({ err: e }, '[installed-agents] route wrapper failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'installed-agents',
          cause: e,
        });
      }
    }
  }

  const handleTagsList = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      if (!tagIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:tag-index-not-configured',
          'Tag index not configured.',
          { handler: 'tags-list' },
        );
        return;
      }
      try {
        const tags = tagIndex.getAllTags();
        successResponse(res, 200, TagsListSuccessSchema, { tags }, { handler: 'tags-list' });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read tags.', {
          handler: 'tags-list',
          cause: e,
        });
      }
    },
    { handler: 'tags-list', method: 'GET', skipBodyParse: true },
  );

  async function handleTagsForName(
    req: IncomingMessage,
    res: ServerResponse,
    rawName: string,
  ): Promise<void> {
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'tags-for-name',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    if (!tagIndex) {
      errorResponse(
        res,
        503,
        'urn:ok:error:tag-index-not-configured',
        'Tag index not configured.',
        { handler: 'tags-for-name' },
      );
      return;
    }
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid tag name encoding.', {
        handler: 'tags-for-name',
      });
      return;
    }
    if (!name) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing tag name.', {
        handler: 'tags-for-name',
      });
      return;
    }
    try {
      const docs = tagIndex.getDocsForTagWithMatches(name).map(({ docName, matchingTags }) => ({
        docName,
        title: readPageTitleForDocName(docName),
        matchingTags,
        snippet: null,
      }));
      successResponse(
        res,
        200,
        TagsForNameSuccessSchema,
        { name, docs },
        {
          handler: 'tags-for-name',
        },
      );
    } catch (e) {
      errorResponse(
        res,
        500,
        'urn:ok:error:internal-server-error',
        'Failed to read tag membership.',
        { handler: 'tags-for-name', cause: e },
      );
    }
  }

  function validateFolderRel(
    raw: string,
    res: ServerResponse,
    label: 'path' | 'folder' = 'path',
    handler = 'folder-config',
  ): { folderRel: string; resolvedContentDir: string } | null {
    const folderRel = raw.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (folderRel.split('/').some((seg) => seg === '..') || raw.startsWith('/')) {
      errorResponse(
        res,
        400,
        'urn:ok:error:invalid-request',
        `Invalid ${label}: must be project-root-relative.`,
        { handler },
      );
      return null;
    }
    const resolvedContentDir = resolve(contentDir);
    const candidateAbs =
      folderRel === '' ? resolvedContentDir : resolve(resolvedContentDir, folderRel);
    if (
      candidateAbs !== resolvedContentDir &&
      !candidateAbs.startsWith(`${resolvedContentDir}${sep}`)
    ) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Path escapes content directory.', {
        handler,
      });
      return null;
    }
    return { folderRel, resolvedContentDir };
  }

  const TEMPLATE_NAME_RE = /^[A-Za-z0-9_-]+$/;
  function validateTemplateName(name: string, res: ServerResponse, handler = 'template'): boolean {
    if (!name || !TEMPLATE_NAME_RE.test(name)) {
      errorResponse(
        res,
        400,
        'urn:ok:error:invalid-request',
        'Invalid name: must be letters / digits / `_` / `-` only (no `.md` extension).',
        { handler },
      );
      return false;
    }
    return true;
  }

  /**
   * Resolve a template by walking leaf → root from `folderRel`, closest-wins.
   * Returns the matched file's abs path, the owning folder, and whether it's
   * `local` (owned by `folderRel` itself) or `inherited` (from an ancestor).
   * Single source of the resolution walk — shared by `handleTemplateGet` and
   * the move handler's inherited-vs-absent disambiguation.
   */
  function findTemplateLeafToRoot(
    resolvedContentDir: string,
    folderRel: string,
    name: string,
  ): { abs: string; folder: string; scope: 'local' | 'inherited' } | null {
    const segments = folderRel === '' ? [] : folderRel.split('/');
    for (let depth = segments.length; depth >= 0; depth--) {
      const ancestorFolder = depth === 0 ? '' : segments.slice(0, depth).join('/');
      const ancestorAbs =
        ancestorFolder === '' ? resolvedContentDir : resolve(resolvedContentDir, ancestorFolder);
      if (
        ancestorAbs !== resolvedContentDir &&
        !ancestorAbs.startsWith(`${resolvedContentDir}${sep}`)
      ) {
        continue;
      }
      const candidate = resolve(ancestorAbs, '.ok', 'templates', `${name}.md`);
      if (existsSync(candidate)) {
        return {
          abs: candidate,
          folder: ancestorFolder,
          scope: depth === segments.length ? 'local' : 'inherited',
        };
      }
    }
    return null;
  }

  function pickFrontmatterFields(raw: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === undefined) continue;
      out[key] = value;
    }
    return out;
  }

  async function handleFolderConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      return handleFolderConfigGet(req, res);
    }
    if (req.method === 'PUT') {
      return handleFolderConfigPut(req, res);
    }
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'folder-config',
      extraHeaders: { Allow: 'GET, PUT' },
    });
  }

  const handleFolderConfigGet = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const validated = validateFolderRel(
          url.searchParams.get('path') ?? '',
          res,
          'path',
          'folder-config-get',
        );
        if (!validated) return;
        const meta = await enrichDirectory(validated.folderRel, {
          projectDir: validated.resolvedContentDir,
        });
        const folderOkDir = resolve(validated.resolvedContentDir, validated.folderRel, '.ok');
        const localFmPath = resolve(folderOkDir, 'frontmatter.yml');
        let frontmatterLocal: Record<string, unknown> | null = null;
        if (existsSync(localFmPath)) {
          try {
            const raw = await readFile(localFmPath, 'utf-8');
            const parsed = parseYaml(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              frontmatterLocal = parsed as Record<string, unknown>;
            } else {
              frontmatterLocal = {};
            }
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            console.warn(`[folder-config:get] malformed YAML in ${localFmPath}: ${reason}`);
            frontmatterLocal = null;
          }
        }

        // Folder frontmatter is SELF-ONLY (no ancestor cascade) and there
        // are no schema declarations — `frontmatter_local` is the folder's
        // own open-shape frontmatter, the whole contract.
        successResponse(
          res,
          200,
          FolderConfigGetSuccessSchema,
          {
            folder: meta,
            frontmatter_local: frontmatterLocal,
          },
          { handler: 'folder-config-get' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read folder config.',
          { handler: 'folder-config-get', cause: e },
        );
      }
    },
    { handler: 'folder-config-get', method: 'GET', skipBodyParse: true },
  );

  const handleFolderConfigPut = withValidation(
    FolderConfigPutRequestSchema,
    async (_req, res, body) => {
      try {
        // No-project single-file mode writes nothing into the user's directory
        // beyond the one edited doc. Folder config would land a
        // `<folder>/.ok/frontmatter.yml` sidecar in the user's tree — refuse.
        if (ephemeral) {
          errorResponse(
            res,
            403,
            'urn:ok:error:single-file-mode',
            'Folder configuration is not available in single-file mode.',
            { handler: 'folder-config-put' },
          );
          return;
        }
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'folder-config-put',
          });
          return;
        }
        const validated = validateFolderRel(body.path, res, 'path', 'folder-config-put');
        if (!validated) return;

        // Write the folder's own frontmatter (open-shape, like a doc's) via the
        // single-folder merge-patch helper — addressed by the folder's own
        // path, no glob and no whitelist.
        const allApplied: Array<{ path: string; action: 'written' | 'deleted' | 'noop' }> = [];
        if (body.frontmatter !== undefined) {
          const result = applyFolderFrontmatterPatch({
            anchorDir: validated.resolvedContentDir,
            folderRel: validated.folderRel,
            patch: body.frontmatter,
          });
          if (!result.ok) {
            const status = result.error.code === 'WRITE_ERROR' ? 500 : 400;
            const urn =
              status === 500
                ? 'urn:ok:error:internal-server-error'
                : 'urn:ok:error:invalid-request';
            const title = status === 500 ? 'Failed to write folder config.' : result.error.message;
            errorResponse(res, status, urn, title, {
              handler: 'folder-config-put',
              detail: result.error.code,
              cause: new Error(result.error.message),
            });
            return;
          }
          allApplied.push({ path: result.path, action: result.action });
          // Attribute the frontmatter change (skip a no-op patch).
          if (result.action !== 'noop') {
            attributeOkArtifactWrite(
              actor,
              okArtifactKey('folder-frontmatter', validated.folderRel),
              `folder-frontmatter-${result.action === 'deleted' ? 'delete' : 'edit'}: ${result.path}`,
            );
            await commitOkArtifactWrite('folder-config-put');
          }
        }

        successResponse(
          res,
          200,
          FolderConfigPutSuccessSchema,
          { applied: allApplied },
          { handler: 'folder-config-put' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to write folder config.',
          { handler: 'folder-config-put', cause: e },
        );
      }
    },
    { handler: 'folder-config-put', method: 'PUT' },
  );

  /**
   * Conflict-aware refusal helper for the template handlers. Templates
   * write to `<folder>/.ok/templates/<name>.md`, under `.ok/`, which the
   * watcher excludes from the CRDT document index — so the target path
   * cannot carry a `lifecycle.status` Y.Map in production. The check is
   * kept structural so (a) any future loosening that loads
   * `.ok/templates/*` into Y.Docs inherits the refusal contract for free,
   * (b) the meta-test sees an explicit `respondDocInConflict` site at
   * the handler boundary. Returns `true` when the gate fired (caller
   * short-circuits); `false` when the mutation may proceed.
   */
  function checkTemplateConflictGate(
    folder: string,
    name: string,
    handler: 'template-put' | 'template-delete' | 'template-move',
    res: ServerResponse,
  ): boolean {
    if (!name) return false;
    const templateDocName =
      folder === ''
        ? `.ok/templates/${name}`
        : `${folder.replace(/\/$/, '')}/.ok/templates/${name}`;
    const doc = hocuspocus.documents.get(templateDocName);
    if (doc && isDocInConflict(doc)) {
      respondDocInConflict(res, new DocInConflictError({ file: `${templateDocName}.md` }), handler);
      return true;
    }
    return false;
  }

  /**
   * Conflict-aware refusal for the skill CONTENT-doc writers. A PROJECT skill's
   * `SKILL.md` and its `.md` references are real CRDT content docs (skills-as-
   * content), so a mutation against one whose `lifecycle.status === 'conflict'`
   * must refuse exactly like the sibling content-write handlers — the CRDT
   * paired-write path (`composeAndWriteRawBody`) would otherwise clobber a
   * doc the user is mid-resolving. Global skills + scripts are fs-direct (not
   * CRDT docs), so they never carry a lifecycle Y.Map and the gate is a no-op.
   * Returns `true` when the gate fired (caller short-circuits).
   */
  function checkSkillDocConflictGate(
    docName: string,
    handler: string,
    res: ServerResponse,
  ): boolean {
    const doc = hocuspocus.documents.get(docName);
    if (doc && isDocInConflict(doc)) {
      respondDocInConflict(res, new DocInConflictError({ file: `${docName}.md` }), handler);
      return true;
    }
    return false;
  }

  /**
   * Project-wide flat enumeration of every `<folder>/.ok/templates/*.md`.
   * The single-template `/api/template` endpoint is per-folder + walks
   * leaf → root for closest-wins resolution; this surface is the editor's
   * empty-state list (every template the user can pick from, with the
   * `source_folder` that owns each one). Skips the same dirs as the
   * directory-scan walker — see `resolveProjectTemplates`.
   */
  const handleTemplatesList = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        const resolvedContentDir = resolve(contentDir);
        const result = resolveProjectTemplates(resolvedContentDir);
        // Drop `scope` from each entry — every flat-enumeration entry is
        // implicitly `scope: 'local'` to its own `source_folder`, so the
        // field carries no information here. `TemplatesListEntrySchema` is
        // `.strict()` and would otherwise reject the response.
        const templates = result.templates.map((t) => {
          const { scope: _scope, ...rest } = t;
          return rest;
        });
        successResponse(
          res,
          200,
          TemplatesListSuccessSchema,
          { templates, truncated: result.truncated },
          { handler: 'templates-list' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to list templates.', {
          handler: 'templates-list',
          cause: e,
        });
      }
    },
    { handler: 'templates-list', method: 'GET', skipBodyParse: true },
  );

  async function handleTemplate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      return handleTemplateGet(req, res);
    }
    if (req.method === 'PUT') {
      return handleTemplatePut(req, res);
    }
    if (req.method === 'POST') {
      return handleTemplateMove(req, res);
    }
    if (req.method === 'DELETE') {
      return handleTemplateDelete(req, res);
    }
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'template',
      extraHeaders: { Allow: 'GET, PUT, POST, DELETE' },
    });
  }

  // Generic frontmatter splitter for managed `.md` files (SKILL.md, etc.):
  // returns the parsed YAML frontmatter object + the body. Distinct from core's
  // `parseTemplateFile`, which parses the single-block TEMPLATE format
  // (`template:` identity → TemplateModel). Skills carry plain `{name,
  // description}` frontmatter, so they need this generic parse, not the
  // template model.
  const parseFrontmatterDoc = (
    raw: string,
  ): { frontmatter: Record<string, unknown>; body: string } => {
    const { frontmatter: fenced, body } = stripFrontmatter(raw);
    let frontmatter: Record<string, unknown> = {};
    if (fenced !== '') {
      try {
        const parsed = parseYaml(unwrapFrontmatterFences(fenced));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          frontmatter = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed YAML — return the FM-stripped body, frontmatter empty.
      }
    }
    return { frontmatter, body };
  };

  const handleTemplateGet = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = url.searchParams.get('name') ?? '';
        if (!validateTemplateName(name, res, 'template-get')) return;

        // Walk leaf → root for closest match.
        const validated = validateFolderRel(
          url.searchParams.get('folder') ?? '',
          res,
          'folder',
          'template-get',
        );
        if (!validated) return;
        const { folderRel, resolvedContentDir } = validated;

        const found = findTemplateLeafToRoot(resolvedContentDir, folderRel, name);
        if (!found) {
          errorResponse(res, 404, 'urn:ok:error:template-not-found', 'Template not found.', {
            handler: 'template-get',
            detail: `Template "${name}" not found for folder "${folderRel || '.'}". Walked leaf → root.`,
          });
          return;
        }
        const { abs: foundAbs, folder: foundFolder, scope: foundScope } = found;

        const raw = await readFile(foundAbs, 'utf-8');
        // Normalize single-block (and legacy two-block) templates: wire
        // `frontmatter` = the template's identity (title/description), wire
        // `body` = the starter content (doc-frontmatter block + markdown) a
        // new doc receives. Tokens (`{{date}}`) are preserved verbatim.
        const model = parseTemplateFile(raw);
        const frontmatter = model.identity as Record<string, unknown>;
        const body = model.starterContent;

        const relPath = relative(resolvedContentDir, foundAbs)
          .split(/[\\/]/)
          .filter(Boolean)
          .join('/');

        successResponse(
          res,
          200,
          TemplateGetSuccessSchema,
          {
            template: {
              name,
              folder: foundFolder,
              scope: foundScope,
              path: relPath,
              frontmatter,
              body,
            },
          },
          { handler: 'template-get' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read template.', {
          handler: 'template-get',
          cause: e,
        });
      }
    },
    { handler: 'template-get', method: 'GET', skipBodyParse: true },
  );

  const handleTemplatePut = withValidation(
    TemplatePutRequestSchema,
    async (_req, res, body) => {
      try {
        // Templates write `<folder>/.ok/templates/*.md` into the content tree —
        // a user-dir artifact single-file mode must never create.
        if (ephemeral) {
          errorResponse(
            res,
            403,
            'urn:ok:error:single-file-mode',
            'Templates are not available in single-file mode.',
            { handler: 'template-put' },
          );
          return;
        }
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'template-put',
          });
          return;
        }
        const name = body.name;
        if (!validateTemplateName(name, res, 'template-put')) return;
        const validated = validateFolderRel(body.folder, res, 'folder', 'template-put');
        if (!validated) return;

        // Conflict-aware refusal. See `checkTemplateConflictGate`.
        if (checkTemplateConflictGate(validated.folderRel, name, 'template-put', res)) return;

        // Compose + validate the `.md` bytes server-side, then route the body
        // through the template's CRDT doc (precedent #24 / #38) — same shape as
        // skill-put. The managed-artifact persistence branch writes the file.
        const composed = composeTemplateContent({
          name,
          body: typeof body.body === 'string' ? body.body : '',
          frontmatter: pickFrontmatterFields(body.frontmatter) satisfies TemplateFrontmatter,
        });
        if (!composed.ok) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid template request.', {
            handler: 'template-put',
            detail: composed.error.code,
            cause: new Error(composed.error.message),
          });
          return;
        }

        const templateFilePath = resolve(
          validated.resolvedContentDir,
          validated.folderRel,
          '.ok',
          'templates',
          `${name}.md`,
        );
        const templateCreated = !existsSync(templateFilePath);
        const templateRelPath = relative(validated.resolvedContentDir, templateFilePath)
          .split(/[\\/]/)
          .filter(Boolean)
          .join('/');
        const templateDocName = templateDocNameFor(validated.folderRel, name);

        const { agentId, agentName, colorSeed, clientName } = extractAgentIdentity(
          body as unknown as Record<string, unknown>,
        );
        const templateSession = await sessionManager.getSession(templateDocName, agentId, {
          displayName: agentName,
          colorSeed,
          clientName,
        });
        templateSession.dc.document.transact(() => {
          composeAndWriteRawBody(templateSession.dc.document, composed.content, 'agent');
        }, templateSession.origin);

        const templateFlush = await flushDiskAndDetectOutcome(templateDocName);
        if (templateFlush?.kind === 'failure') {
          respondPersistenceFailure(res, templateFlush.failure, 'template-put');
          return;
        }
        if (templateFlush?.kind === 'divergence') {
          respondDiskDivergence(res, 'template-put');
          return;
        }

        attributeOkArtifactWrite(
          actor,
          okArtifactKey('template', validated.folderRel, name),
          `${templateCreated ? 'template-create' : 'template-edit'}: ${templateRelPath}`,
        );
        await commitOkArtifactWrite('template-put');
        successResponse(
          res,
          200,
          TemplatePutSuccessSchema,
          {
            path: templateRelPath,
            created: templateCreated,
            warnings: composed.warnings,
          },
          { handler: 'template-put' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to write template.', {
          handler: 'template-put',
          cause: e,
        });
      }
    },
    { handler: 'template-put', method: 'PUT' },
  );

  const handleTemplateDelete = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = url.searchParams.get('name') ?? '';
        if (!validateTemplateName(name, res, 'template-delete')) return;
        const validated = validateFolderRel(
          url.searchParams.get('folder') ?? '',
          res,
          'folder',
          'template-delete',
        );
        if (!validated) return;

        // DELETE has no body (query-param transport); read identity + summary
        // from the query string into a synthetic body for extractActorIdentity.
        const sp = url.searchParams;
        const actor = extractActorIdentity(
          {
            agentId: sp.get('agentId') ?? undefined,
            agentName: sp.get('agentName') ?? undefined,
            colorSeed: sp.get('colorSeed') ?? undefined,
            clientName: sp.get('clientName') ?? undefined,
            clientVersion: sp.get('clientVersion') ?? undefined,
            label: sp.get('label') ?? undefined,
            summary: sp.get('summary') ?? undefined,
          },
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'template-delete',
          });
          return;
        }

        // Conflict-aware refusal. See `checkTemplateConflictGate`.
        if (checkTemplateConflictGate(validated.folderRel, name, 'template-delete', res)) return;

        // Tear down the live `__template__` doc (if open) BEFORE removing the
        // file, so the managed-artifact persistence branch can't re-store
        // (resurrect) it on a later unload. Same spine doc-delete + skill-delete
        // use; no-op when the doc was never opened.
        await captureAndCloseDocuments(
          [templateDocNameFor(validated.folderRel, name)],
          'deleted-upstream',
        );

        const deleteInput: Parameters<typeof applyTemplateDelete>[0] = {
          projectDir: validated.resolvedContentDir,
          folder: validated.folderRel,
          name,
        };
        const result = applyTemplateDelete(deleteInput);
        if (!result.ok) {
          const status =
            result.error.code === 'WRITE_ERROR' ||
            result.error.code === 'UNLINK_FAILED' ||
            result.error.code === 'BAD_PROJECT_DIR'
              ? 500
              : 400;
          const urn =
            status === 500 ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request';
          const title = status === 500 ? 'Failed to delete template.' : 'Invalid template request.';
          errorResponse(res, status, urn, title, {
            handler: 'template-delete',
            detail: result.error.code,
            cause: new Error(result.error.message),
          });
          return;
        }
        // Only attribute when a file was actually removed (no-op delete of an
        // absent template records nothing).
        if (result.existed) {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('template', validated.folderRel, name),
            `template-delete: ${result.path}`,
          );
          await commitOkArtifactWrite('template-delete');
        }
        successResponse(
          res,
          200,
          TemplateDeleteSuccessSchema,
          { existed: result.existed, path: result.path },
          { handler: 'template-delete' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to delete template.',
          { handler: 'template-delete', cause: e },
        );
      }
    },
    { handler: 'template-delete', method: 'DELETE', skipBodyParse: true },
  );

  const handleTemplateMove = withValidation(
    TemplateMoveRequestSchema,
    async (_req, res, body) => {
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'template-move',
          });
          return;
        }
        if (!validateTemplateName(body.fromName, res, 'template-move')) return;
        if (!validateTemplateName(body.toName, res, 'template-move')) return;
        const fromValidated = validateFolderRel(body.fromFolder, res, 'folder', 'template-move');
        if (!fromValidated) return;
        const toValidated = validateFolderRel(body.toFolder, res, 'folder', 'template-move');
        if (!toValidated) return;

        // Refuse moving a source whose target doc is in an unresolved conflict.
        if (
          checkTemplateConflictGate(fromValidated.folderRel, body.fromName, 'template-move', res)
        ) {
          return;
        }

        // Tear down the live source `__template__` doc (if open) BEFORE the
        // git-mv relocates the file — otherwise its persistence branch would
        // re-store at the now-stale from-path, resurrecting the moved template.
        await captureAndCloseDocuments(
          [templateDocNameFor(fromValidated.folderRel, body.fromName)],
          'renamed',
        );

        const result = await applyTemplateMove({
          projectDir: fromValidated.resolvedContentDir,
          fromFolder: fromValidated.folderRel,
          fromName: body.fromName,
          toFolder: toValidated.folderRel,
          toName: body.toName,
          // git mv (history-preserving) when the path is tracked; plain disk
          // rename otherwise. `withParentLock` inside renameTrackedPathInGit
          // serializes against concurrent doc renames (git-index safety).
          relocate: async (fromAbs, toAbs) => {
            const movedWithGit = await renameTrackedPathInGit(projectDir, fromAbs, toAbs);
            if (!movedWithGit) renamePathOnDisk(fromAbs, toAbs);
            return movedWithGit;
          },
        });

        if (!result.ok) {
          if (result.error.code === 'TEMPLATE_NOT_FOUND') {
            // Distinguish "inherited" (resolvable from an ancestor) — teach
            // localize-then-move — from "truly absent" — 404.
            const found = findTemplateLeafToRoot(
              fromValidated.resolvedContentDir,
              fromValidated.folderRel,
              body.fromName,
            );
            if (found?.scope === 'inherited') {
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                `Template "${body.fromName}" is inherited from "${found.folder || '(root)'}", not local to "${fromValidated.folderRel || '(root)'}". Move it from the folder that owns it, or create a local copy here first (then move that).`,
                { handler: 'template-move', detail: 'TEMPLATE_INHERITED' },
              );
              return;
            }
            errorResponse(res, 404, 'urn:ok:error:template-not-found', 'Template not found.', {
              handler: 'template-move',
              detail: result.error.message,
            });
            return;
          }
          if (result.error.code === 'TEMPLATE_EXISTS') {
            errorResponse(res, 409, 'urn:ok:error:doc-already-exists', result.error.message, {
              handler: 'template-move',
              detail: result.error.code,
            });
            return;
          }
          const status =
            result.error.code === 'WRITE_ERROR' || result.error.code === 'MOVE_FAILED' ? 500 : 400;
          errorResponse(
            res,
            status,
            status === 500 ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request',
            status === 500 ? 'Failed to move template.' : 'Invalid template move request.',
            {
              handler: 'template-move',
              detail: result.error.code,
              cause: new Error(result.error.message),
            },
          );
          return;
        }

        // Optional atomic move+edit: rewrite the relocated template's content.
        // The move already succeeded and persisted the original content, so any
        // failure here is captured and reported AFTER the move is attributed —
        // the rename must not be lost because the edit step failed.
        let contentEditError: { code: string; message: string } | null = null;
        if (body.body !== undefined || body.frontmatter !== undefined) {
          // Preserve the existing (just-moved) body when only `frontmatter` is
          // supplied. If that body can't be read, SKIP the rewrite rather than
          // risk wiping it — defaulting to '' would re-introduce the body-loss
          // bug on a read error; the moved file keeps its original content.
          let writeBody: string | null;
          if (typeof body.body === 'string') {
            writeBody = body.body;
          } else {
            try {
              writeBody = instantiateDoc(
                readFileSync(resolve(toValidated.resolvedContentDir, result.toPath), 'utf-8'),
              );
            } catch {
              writeBody = null;
            }
          }
          if (writeBody === null) {
            contentEditError = {
              code: 'READ_FAILED',
              message:
                'could not read the moved template to apply the metadata change; the move succeeded with the original content intact — retry the edit',
            };
          } else {
            const writeResult = applyTemplateWrite({
              projectDir: toValidated.resolvedContentDir,
              folder: toValidated.folderRel,
              name: body.toName,
              body: writeBody,
              frontmatter: pickFrontmatterFields(body.frontmatter) satisfies TemplateFrontmatter,
            });
            if (!writeResult.ok) contentEditError = writeResult.error;
          }
        }

        // The move succeeded — attribute + commit + signal regardless of the
        // optional content edit's outcome, so the rename is never lost when the
        // edit step fails.
        attributeOkArtifactWrite(
          actor,
          okArtifactKey('template', toValidated.folderRel, body.toName),
          `template-rename: ${result.fromPath} -> ${result.toPath}`,
          [{ from: result.fromPath, to: result.toPath }],
        );
        await commitOkArtifactWrite('template-move');
        signalChannel?.('files');

        if (contentEditError) {
          const isServerError =
            contentEditError.code === 'WRITE_ERROR' || contentEditError.code === 'READ_FAILED';
          errorResponse(
            res,
            isServerError ? 500 : 400,
            isServerError ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request',
            // Include the destination so the agent can retry the content edit
            // against the moved template without re-deriving where it landed.
            `Template moved to "${result.toPath}", but updating its content failed.`,
            {
              handler: 'template-move',
              detail: contentEditError.code,
              cause: new Error(contentEditError.message),
            },
          );
          return;
        }
        successResponse(
          res,
          200,
          TemplateMoveSuccessSchema,
          { from: result.fromPath, to: result.toPath, committed: result.committed },
          { handler: 'template-move' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to move template.', {
          handler: 'template-move',
          cause: e,
        });
      }
    },
    { handler: 'template-move', method: 'POST' },
  );

  // ─── Skills (`/api/skill`, `/api/skills`) ──────────────────────
  //
  // Skills are fs-direct `.ok/skills/<name>/` artifacts (SKILL.md + optional
  // references/scripts), NON-CRDT, addressed by scope + name (no per-folder
  // leaf-to-root walk — a skill's name is its whole identity). They reuse the
  // template artifact spine: server-routed, actor-attributed, shadow-repo
  // committed via `attributeOkArtifactWrite` + `commitOkArtifactWrite`.
  // Project scope only this slice; global scope (a user-level store)
  // is gated on the not-yet-built device-sync mechanism and refused with a
  // teaching error rather than silently writing to an unmanaged path.
  const SKILLS_LIST_CAP = 500;

  function validateSkillName(name: string, res: ServerResponse, handler: string): boolean {
    if (!name || name.length > 64 || !SKILL_NAME_REGEX.test(name)) {
      errorResponse(
        res,
        400,
        'urn:ok:error:invalid-request',
        'Invalid skill name: lowercase letters, digits, and hyphens only (≤64 chars; no slashes, dots, spaces, or uppercase).',
        { handler },
      );
      return false;
    }
    return true;
  }

  /** Parse the `scope` query param (defaults to `project`); 400s on a bad value. */
  function parseSkillScope(
    raw: string | null,
    res: ServerResponse,
    handler: string,
  ): 'project' | 'global' | null {
    const parsed = SkillScopeSchema.safeParse(raw ?? 'project');
    if (!parsed.success) {
      errorResponse(
        res,
        400,
        'urn:ok:error:invalid-request',
        'Invalid skill scope (expected "project" or "global").',
        { handler },
      );
      return null;
    }
    return parsed.data;
  }

  // User home for global-scope skills (override in tests). Global skills
  // live at `<home>/.ok/skills/`; the user-level install marker is
  // `<home>/.ok/local/installed-skills.json` (readInstalledSkills(skillsHome)).
  const skillsHome = homeDirOverride ?? homedir();

  /**
   * Resolve a skill scope to its absolute `.ok/skills` store root. Project
   * skills live at `<contentDir>/.ok/skills` (git-committed, shared via the
   * project repo); global skills at `<home>/.ok/skills` (user-global,
   * local per-machine). Global skills are fs-direct and UNVERSIONED — there
   * is no user-level shadow repo, so global writes skip the project shadow
   * commit (the caller gates on scope).
   */
  function resolveSkillsRoot(scope: 'project' | 'global'): string {
    return scope === 'global'
      ? resolve(skillsHome, '.ok', 'skills')
      : resolve(contentDir, '.ok', 'skills');
  }

  /**
   * Build the folder-addressed `__template__/<folderRel>/<name>` CRDT doc name.
   * Each path segment is percent-encoded so `parseManagedArtifactName` decodes
   * back to the exact folder/name (folders may carry spaces/unicode). `''`
   * folder → `__template__/<name>` (project root).
   */
  function templateDocNameFor(folderRel: string, name: string): string {
    const segs = folderRel ? folderRel.split('/').filter(Boolean).map(encodeURIComponent) : [];
    return `${MANAGED_ARTIFACT_PREFIX_TEMPLATE}${[...segs, encodeURIComponent(name)].join('/')}`;
  }

  function parseSearchRanking(value: unknown): WorkspaceSearchRanking | undefined {
    return value === 'navigation' || value === 'relevance' ? value : undefined;
  }

  /**
   * POSIX store-relative path for a skill file. Project skills are reported
   * relative to `contentDir` (→ `.ok/skills/<name>/SKILL.md`); global skills
   * relative to `<home>` (same `.ok/skills/...` suffix) so the path reads the
   * same regardless of scope.
   */
  function skillRelPath(abs: string, scope: 'project' | 'global'): string {
    const base = scope === 'global' ? skillsHome : contentDir;
    return relative(base, abs).split(/[\\/]/).filter(Boolean).join('/');
  }

  /**
   * The host-dir base for a skill's install surface: the project root (project
   * scope) or the user home (global scope). `projectSkill`/`reverseProjectSkill`
   * resolve `.{host}/skills/<name>` against it, and the install marker lives at
   * `<base>/.ok/local/`. Single source for the install/uninstall scope→base map.
   */
  function skillInstallBase(scope: 'project' | 'global'): string | undefined {
    return scope === 'global' ? skillsHome : projectDir;
  }

  /**
   * Remove a skill's editor-host projections + drop its install-marker entry,
   * leaving the source intact. Shared by DELETE (full removal) and the uninstall
   * endpoint (demote to Draft). Returns true when an install record existed.
   */
  async function uninstallSkillFromHostDirs(base: string, name: string): Promise<boolean> {
    const installed = await removeSkillInstall(base, name);
    // Reverse-project across ALL skill-surface host dirs, NOT just the marker's
    // recorded hosts. The marker can be stale or absent (e.g. after a cross-scope
    // move, or when the source was removed out-of-band) while orphan/dangling
    // projection symlinks remain on disk. Cleaning the full set — combined with
    // `reverseProjectSkill`'s dangling-symlink removal — guarantees no projection
    // survives a delete/move. `reverseProjectSkill` is a no-op per host that
    // has nothing to remove, so over-covering is safe.
    reverseProjectSkill(name, base, PROJECT_SKILL_EDITOR_IDS);
    return installed !== null;
  }

  /**
   * Enumerate `<skillsRoot>/<name>/SKILL.md` entries for the Skills panel.
   * Reads each skill's frontmatter for `description`; a malformed/absent
   * frontmatter still lists (description omitted) so the panel can surface it
   * as a Draft to fix. Non-skill-named dirs are skipped. Bounded by
   * `SKILLS_LIST_CAP`.
   */
  function resolveSkillsList(
    skillsRoot: string,
    scope: 'project' | 'global',
  ): {
    skills: Array<{
      name: string;
      description?: string;
      scope: 'project' | 'global';
      path: string;
      absolutePath: string;
      installedVersion?: string;
    }>;
    truncated: boolean;
  } {
    const skills: Array<{
      name: string;
      description?: string;
      scope: 'project' | 'global';
      path: string;
      absolutePath: string;
      installedVersion?: string;
    }> = [];
    if (!existsSync(skillsRoot)) return { skills, truncated: false };
    let entries: Dirent[];
    try {
      entries = readdirSync(skillsRoot, { withFileTypes: true });
    } catch (err) {
      // An EACCES / I/O failure here returns an empty list indistinguishable
      // from "no skills" — log it so the failure is observable rather than
      // silently presenting a zero-skill library. Contract unchanged: the
      // handler still returns the (empty) list rather than erroring.
      getLogger('skills').warn(
        { err, skillsRoot, scope },
        'failed to read skills root — returning empty skills list',
      );
      return { skills, truncated: false };
    }
    let truncated = false;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !SKILL_NAME_REGEX.test(entry.name)) continue;
      if (skills.length >= SKILLS_LIST_CAP) {
        truncated = true;
        break;
      }
      const skillMd = resolve(skillsRoot, entry.name, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      let description: string | undefined;
      let installedVersion: string | undefined;
      try {
        const { frontmatter } = parseFrontmatterDoc(readFileSync(skillMd, 'utf-8'));
        if (typeof frontmatter.description === 'string') description = frontmatter.description;
        // `version` of the installed copy — drives pack-skill update detection
        // (enriched with the bundled version + verdict in `enrich`).
        if (typeof frontmatter.version === 'string' && frontmatter.version.trim() !== '') {
          installedVersion = frontmatter.version;
        }
      } catch {
        // Malformed SKILL.md — list it without a description (Draft to fix).
      }
      skills.push({
        name: entry.name,
        ...(description !== undefined ? { description } : {}),
        scope,
        path: skillRelPath(skillMd, scope),
        absolutePath: skillMd,
        ...(installedVersion !== undefined ? { installedVersion } : {}),
      });
    }
    return { skills, truncated };
  }

  const handleSkillsList = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        // Union both scopes: project skills (`<contentDir>/.ok/skills`, git-
        // shared) + global skills (`<home>/.ok/skills`, user-level). Each is
        // enriched from ITS OWN install marker — the project marker at
        // `<projectDir>/.ok/local/`, the user marker at `<home>/.ok/local/`.
        const project = resolveSkillsList(resolveSkillsRoot('project'), 'project');
        const globalSkills = resolveSkillsList(resolveSkillsRoot('global'), 'global');
        const projectInstalled = projectDir ? readInstalledSkills(projectDir).skills : {};
        const globalInstalled = readInstalledSkills(skillsHome).skills;
        const enrich = (list: typeof project, marker: Record<string, { hosts: string[] }>) =>
          list.skills.map((skill) => {
            const record = marker[skill.name];
            const hosts = record?.hosts ?? [];
            // Pack-skill update detection: compare the installed `version` against
            // OK's currently-bundled version. Returns empty for non-pack skills, so
            // only packs carry the fields (and only the panel badges them).
            const update = computePackUpdateStatus(skill.name, skill.installedVersion);
            // `installed` = has ≥1 host, NOT merely marker-present. A marker with
            // zero hosts (e.g. a rename whose editors all vanished) is a Draft, not
            // an installed skill — the install handler also drops empty markers.
            return { ...skill, installed: hosts.length > 0, hosts, ...update };
          });
        const enriched = {
          skills: [...enrich(project, projectInstalled), ...enrich(globalSkills, globalInstalled)],
          truncated: project.truncated || globalSkills.truncated,
        };
        successResponse(res, 200, SkillsListSuccessSchema, enriched, { handler: 'skills-list' });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to list skills.', {
          handler: 'skills-list',
          cause: e,
        });
      }
    },
    { handler: 'skills-list', method: 'GET', skipBodyParse: true },
  );

  async function handleSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') return handleSkillGet(req, res);
    if (req.method === 'PUT') return handleSkillPut(req, res);
    if (req.method === 'POST') return handleSkillMove(req, res);
    if (req.method === 'DELETE') return handleSkillDelete(req, res);
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'skill',
      extraHeaders: { Allow: 'GET, PUT, POST, DELETE' },
    });
  }

  // ─── `/api/skills/management` — project-managed opt-in (the import gate) ──────
  // GET → { managed: bool | null (undecided), importable: count of non-`.ok`
  //   editor skills an import would adopt }. PUT { manageEditorSkills } records
  //   the per-machine decision; enabling runs the import sweep
  //   (`reconcileSkillInstalls`). Backs the in-app prompt; `ok skills manage` is
  //   the headless sibling.
  const SkillsManagementSuccessSchema = z.object({
    managed: z.boolean().nullable(),
    importable: z.number().int().nonnegative(),
  });
  const skillsManagementState = () => ({
    managed: projectDir ? (readSkillManagement(projectDir)?.manageEditorSkills ?? null) : null,
    importable: projectDir
      ? countImportableEditorSkills({ projectDir, skillsRoot: resolveSkillsRoot('project') })
      : 0,
  });

  const handleSkillsManagementGet = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      if (!projectDir) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project root resolved.', {
          handler: 'skills-management-get',
          detail: 'NO_PROJECT_ROOT',
        });
        return;
      }
      successResponse(res, 200, SkillsManagementSuccessSchema, skillsManagementState(), {
        handler: 'skills-management-get',
      });
    },
    { handler: 'skills-management-get', method: 'GET', skipBodyParse: true },
  );

  const handleSkillsManagementPut = withValidation(
    z.object({ manageEditorSkills: z.boolean() }),
    async (_req, res, body) => {
      if (!projectDir) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project root resolved.', {
          handler: 'skills-management-put',
          detail: 'NO_PROJECT_ROOT',
        });
        return;
      }
      await writeSkillManagement(projectDir, {
        manageEditorSkills: body.manageEditorSkills,
        surface: 'ui',
      });
      // Enabling flips the project to OK-managed → run the import sweep now so
      // existing editor skills are adopted immediately (not just on next boot).
      if (body.manageEditorSkills) {
        const r = await reconcileSkillInstalls({
          projectDir,
          skillsRoot: resolveSkillsRoot('project'),
        });
        if (r.adopted.length + r.collided.length > 0) signalChannel?.('files');
      }
      successResponse(res, 200, SkillsManagementSuccessSchema, skillsManagementState(), {
        handler: 'skills-management-put',
      });
    },
    { handler: 'skills-management-put', method: 'PUT' },
  );

  async function handleSkillsManagement(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') return handleSkillsManagementGet(req, res);
    if (req.method === 'PUT') return handleSkillsManagementPut(req, res);
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'skills-management',
      extraHeaders: { Allow: 'GET, PUT' },
    });
  }

  const handleSkillGet = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = url.searchParams.get('name') ?? '';
        if (!validateSkillName(name, res, 'skill-get')) return;
        const scope = parseSkillScope(url.searchParams.get('scope'), res, 'skill-get');
        if (scope === null) return;
        const skillsRoot = resolveSkillsRoot(scope);

        const skillMd = resolve(skillsRoot, name, 'SKILL.md');
        if (!existsSync(skillMd)) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-get',
            detail: `Skill "${name}" not found in ${scope} scope.`,
          });
          return;
        }
        const { frontmatter, body } = parseFrontmatterDoc(await readFile(skillMd, 'utf-8'));
        successResponse(
          res,
          200,
          SkillGetSuccessSchema,
          {
            skill: {
              name,
              scope,
              path: skillRelPath(skillMd, scope),
              // Project the on-disk frontmatter onto the strict {name, description}
              // shape; a malformed file falls back to the dir name + empty desc so
              // the editor can load and fix it rather than 500.
              frontmatter: {
                name: typeof frontmatter.name === 'string' ? frontmatter.name : name,
                description:
                  typeof frontmatter.description === 'string' ? frontmatter.description : '',
              },
              body,
              // Bundled files (scripts/, reference/, assets) inlined as read-only
              // text so the editor can browse a skill as the folder it is.
              files: readSkillBundledFiles(resolve(skillsRoot, name)),
            },
          },
          { handler: 'skill-get' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read skill.', {
          handler: 'skill-get',
          cause: e,
        });
      }
    },
    { handler: 'skill-get', method: 'GET', skipBodyParse: true },
  );

  const handleSkillPut = withValidation(
    SkillPutRequestSchema,
    async (_req, res, body) => {
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-put',
          });
          return;
        }
        if (!validateSkillName(body.name, res, 'skill-put')) return;

        // Compose + validate the SKILL.md bytes server-side (OK
        // builds name+description). The body itself is then written through the
        // CRDT doc, not straight to disk.
        const composed = composeSkillContent({
          name: body.name,
          body: typeof body.body === 'string' ? body.body : '',
          frontmatter: { name: body.frontmatter.name, description: body.frontmatter.description },
        });
        if (!composed.ok) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid skill request.', {
            handler: 'skill-put',
            detail: composed.error.code,
            cause: new Error(composed.error.message),
          });
          return;
        }

        const skillsRoot = resolveSkillsRoot(body.scope);
        const filePath = resolve(skillsRoot, body.name, 'SKILL.md');
        // `created` reflects pre-write disk state; the file lands via the
        // managed-artifact persistence branch after the transact below.
        const created = !existsSync(filePath);
        // Path is reported relative to the skills root (`<name>/SKILL.md`),
        // matching the prior `applySkillWrite` contract.
        const relPath = relative(skillsRoot, filePath).split(/[\\/]/).filter(Boolean).join('/');
        // Project skills are content docs: route the write through the content
        // doc (`.ok/skills/<name>/SKILL`), same paired-write path as
        // agent-write-md, so it persists via the content pipeline. Global
        // skills keep the dedicated managed-artifact doc.
        const docName = skillLiveDocName(body.scope, body.name);

        // Refuse if the content doc is mid-conflict — same gate as the sibling
        // content-write handlers (a project SKILL.md is a CRDT content doc).
        if (checkSkillDocConflictGate(docName, 'skill-put', res)) return;

        // CRDT write (precedent #24 / #38): route the full SKILL.md through the
        // doc's `Y.Text('source')` via the sanctioned paired-write primitive
        // under the per-session frozen origin. Persistence serializes
        // Y.Text verbatim to `.ok/skills/<name>/SKILL.md`. Identity for the
        // session mirrors the other content handlers (extractAgentIdentity);
        // shadow-commit attribution uses the actor (agent OR principal) above.
        const { agentId, agentName, colorSeed, clientName } = extractAgentIdentity(
          body as unknown as Record<string, unknown>,
        );
        const session = await sessionManager.getSession(docName, agentId, {
          displayName: agentName,
          colorSeed,
          clientName,
        });
        session.dc.document.transact(() => {
          composeAndWriteRawBody(session.dc.document, composed.content, 'agent');
        }, session.origin);

        // Force the debounced store so the file is on disk before the shadow
        // commit git-adds it. Surfaces a swallowed disk failure as an error.
        const flushOutcome = await flushDiskAndDetectOutcome(docName);
        if (flushOutcome?.kind === 'failure') {
          respondPersistenceFailure(res, flushOutcome.failure, 'skill-put');
          return;
        }
        if (flushOutcome?.kind === 'divergence') {
          respondDiskDivergence(res, 'skill-put');
          return;
        }

        // Project skills are versioned via the project shadow repo; global
        // skills live at `<home>/.ok/skills` (outside any project git) and are
        // unversioned — skip the attribution + shadow commit for them.
        if (body.scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.name),
            `${created ? 'skill-create' : 'skill-edit'}: ${relPath}`,
          );
          await commitOkArtifactWrite('skill-put');
        }
        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillPutSuccessSchema,
          { path: relPath, created, warnings: composed.warnings },
          { handler: 'skill-put' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to write skill.', {
          handler: 'skill-put',
          cause: e,
        });
      }
    },
    { handler: 'skill-put', method: 'PUT' },
  );

  const handleSkillDelete = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = url.searchParams.get('name') ?? '';
        if (!validateSkillName(name, res, 'skill-delete')) return;
        const scope = parseSkillScope(url.searchParams.get('scope'), res, 'skill-delete');
        if (scope === null) return;
        const skillsRoot = resolveSkillsRoot(scope);

        // DELETE is query-param transport — read identity + summary from the
        // query string into a synthetic body for `extractActorIdentity`.
        const sp = url.searchParams;
        const actor = extractActorIdentity(
          {
            agentId: sp.get('agentId') ?? undefined,
            agentName: sp.get('agentName') ?? undefined,
            colorSeed: sp.get('colorSeed') ?? undefined,
            clientName: sp.get('clientName') ?? undefined,
            clientVersion: sp.get('clientVersion') ?? undefined,
            label: sp.get('label') ?? undefined,
            summary: sp.get('summary') ?? undefined,
          },
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-delete',
          });
          return;
        }

        // Tear down the live skill doc (if open) BEFORE removing the dir, so its
        // persistence branch can't re-store (resurrect) the file on a later
        // unload. Project skills are content docs (`.ok/skills/<name>/SKILL`),
        // NOT `__skill__/project/<name>` — closing the wrong doc leaves the open
        // content doc to resurrect the just-deleted source, which is what made
        // the project↔global round-trip drop the skill. No-op when unopened.
        await captureAndCloseDocuments([skillLiveDocName(scope, name)], 'deleted-upstream');

        const result = applySkillDelete({ skillsRoot, name });
        if (!result.ok) {
          const status = result.error.code === 'UNLINK_FAILED' ? 500 : 400;
          errorResponse(
            res,
            status,
            status === 500 ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request',
            status === 500 ? 'Failed to delete skill.' : 'Invalid skill request.',
            {
              handler: 'skill-delete',
              detail: result.error.code,
              cause: new Error(result.error.message),
            },
          );
          return;
        }
        // Project source removal is attributed + shadow-committed; global
        // skills are unversioned (no project shadow repo), so skip it for them.
        if (result.existed) {
          if (scope === 'project') {
            attributeOkArtifactWrite(
              actor,
              okArtifactKey('skill', '', name),
              `skill-delete: ${result.path}`,
            );
            await commitOkArtifactWrite('skill-delete');
          }
          signalChannel?.('files');
        }
        // Uninstall (reverse-projection folds into delete): if this skill was
        // installed, remove its host-dir projections and drop the marker entry.
        // Runs even when the source delete was a no-op so an orphaned
        // installation is still cleaned up. Best-effort — the source delete
        // already succeeded. Global skills uninstall from the user-global host
        // dirs + user marker (`<home>`); project skills from the project's.
        const uninstallBase = skillInstallBase(scope);
        if (uninstallBase) await uninstallSkillFromHostDirs(uninstallBase, name);
        successResponse(
          res,
          200,
          SkillDeleteSuccessSchema,
          { existed: result.existed, path: result.path },
          { handler: 'skill-delete' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to delete skill.', {
          handler: 'skill-delete',
          cause: e,
        });
      }
    },
    { handler: 'skill-delete', method: 'DELETE', skipBodyParse: true },
  );

  const handleSkillMove = withValidation(
    SkillMoveRequestSchema,
    async (_req, res, body) => {
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-move',
          });
          return;
        }
        if (!validateSkillName(body.fromName, res, 'skill-move')) return;
        if (!validateSkillName(body.toName, res, 'skill-move')) return;
        const skillsRoot = resolveSkillsRoot(body.scope);

        // Tear down the live source skill doc (if open) BEFORE the git-mv
        // relocates its dir — otherwise its persistence branch would re-store at
        // the now-stale fromName path, resurrecting the moved-away skill. Project
        // skills are content docs, not `__skill__/project/<name>`. The
        // destination doc loads fresh from disk on next open.
        await captureAndCloseDocuments([skillLiveDocName(body.scope, body.fromName)], 'renamed');

        const result = await applySkillMove({
          skillsRoot,
          fromName: body.fromName,
          toName: body.toName,
          relocate: async (fromAbs, toAbs) => {
            const movedWithGit = await renameTrackedPathInGit(projectDir, fromAbs, toAbs);
            if (!movedWithGit) renamePathOnDisk(fromAbs, toAbs);
            return movedWithGit;
          },
        });
        if (!result.ok) {
          if (result.error.code === 'SKILL_NOT_FOUND') {
            errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
              handler: 'skill-move',
              detail: result.error.message,
            });
            return;
          }
          if (result.error.code === 'SKILL_EXISTS') {
            errorResponse(res, 409, 'urn:ok:error:doc-already-exists', result.error.message, {
              handler: 'skill-move',
              detail: result.error.code,
            });
            return;
          }
          const status = result.error.code === 'MOVE_FAILED' ? 500 : 400;
          errorResponse(
            res,
            status,
            status === 500 ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request',
            status === 500 ? 'Failed to move skill.' : 'Invalid skill move request.',
            {
              handler: 'skill-move',
              detail: result.error.code,
              cause: new Error(result.error.message),
            },
          );
          return;
        }

        // A skill's identity is its directory name, so renaming the dir leaves
        // the moved SKILL.md's `name:` frontmatter stale (== fromName) — which
        // makes the skill invalid (name≠dir). Always rewrite the relocated
        // SKILL.md so `name` tracks the new directory; layer any caller-supplied
        // body/description edit on top (atomic move+edit). Unlike a template
        // move, this rewrite is mandatory, not optional.
        let contentEditError: { code: string; message: string } | null = null;
        const movedSkillMd = resolve(skillsRoot, body.toName, 'SKILL.md');
        let parsedBody = '';
        let parsedDescription = '';
        try {
          const parsed = parseFrontmatterDoc(readFileSync(movedSkillMd, 'utf-8'));
          parsedBody = parsed.body;
          if (typeof parsed.frontmatter.description === 'string') {
            parsedDescription = parsed.frontmatter.description;
          }
        } catch {
          // Unreadable moved file — the rewrite below will fail loudly via the
          // applySkillWrite validation rather than silently wiping content.
        }
        const writeBody = typeof body.body === 'string' ? body.body : parsedBody;
        const writeDescription =
          body.frontmatter !== undefined ? body.frontmatter.description : parsedDescription;
        const rewrite = applySkillWrite({
          skillsRoot,
          name: body.toName,
          body: writeBody,
          frontmatter: { name: body.toName, description: writeDescription },
        });
        if (!rewrite.ok) contentEditError = rewrite.error;

        // A move git-mv's the dir on disk and rewrites only SKILL.md fs-direct,
        // so the relocated SKILL.md + every `.md` reference are absent from the
        // link/tag graph at their new doc names until a manual rescan. For a
        // project skill, re-drive each relocated `.md` content doc through the
        // CRDT content path so it re-indexes, and drop the stale old-name
        // entries. Global skills live outside the project graph (not content
        // docs), so they have nothing to re-index.
        if (body.scope === 'project' && !contentEditError) {
          // Best-effort: the git-mv + SKILL.md rewrite already succeeded, so a
          // re-index failure (e.g. a `readFileSync` racing a relocated file)
          // must NOT turn a successful rename into a 500. The next open/rescan
          // re-indexes the moved docs from disk.
          try {
            reindexMovedProjectSkillDocs(skillsRoot, body.fromName, body.toName);
          } catch (err) {
            getLogger('skill-move').warn(
              { err, fromName: body.fromName, toName: body.toName },
              'reindex of moved project skill docs failed — rename succeeded, deferring to next rescan',
            );
          }
        }

        const fromKeyPath = skillRelPath(resolve(skillsRoot, body.fromName), body.scope);
        const toKeyPath = skillRelPath(resolve(skillsRoot, body.toName), body.scope);
        // Project renames are attributed + shadow-committed (history-preserving
        // git mv); global skills are unversioned — the relocate above already
        // did a plain disk rename, so just skip the shadow attribution.
        if (body.scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.toName),
            `skill-rename: ${fromKeyPath} -> ${toKeyPath}`,
            [{ from: fromKeyPath, to: toKeyPath }],
          );
          await commitOkArtifactWrite('skill-move');
        }

        // Carry install state across the rename. The source dir is now at
        // `toName`; if `fromName` was installed, move its projection + marker
        // too — otherwise the old `fromName` host-dir copy is orphaned and the
        // marker keeps a stale `fromName` key (reproject/reclaim then find no
        // source there and silently demote it to zero hosts). Mirrors how
        // delete folds in uninstall. Scope-aware base (project vs global).
        const moveBase = skillInstallBase(body.scope);
        if (moveBase) {
          const prior = await removeSkillInstall(moveBase, body.fromName);
          if (prior) {
            const priorHosts = resolvedHosts(prior.hosts);
            reverseProjectSkill(body.fromName, moveBase, priorHosts);
            const movedDir = resolve(skillsRoot, body.toName);
            const newHosts = projectSkill(movedDir, body.toName, moveBase, priorHosts);
            await recordSkillInstall(moveBase, body.toName, {
              ...prior,
              hosts: newHosts,
            });
          }
        }
        signalChannel?.('files');

        if (contentEditError) {
          const isServerError = contentEditError.code === 'WRITE_ERROR';
          errorResponse(
            res,
            isServerError ? 500 : 400,
            isServerError ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request',
            `Skill renamed to "${body.toName}", but updating its SKILL.md failed — its name frontmatter may not match the new directory.`,
            {
              handler: 'skill-move',
              detail: contentEditError.code,
              cause: new Error(contentEditError.message),
            },
          );
          return;
        }
        successResponse(
          res,
          200,
          SkillMoveSuccessSchema,
          {
            from: fromKeyPath,
            to: toKeyPath,
            committed: result.committed,
          },
          { handler: 'skill-move' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to move skill.', {
          handler: 'skill-move',
          cause: e,
        });
      }
    },
    { handler: 'skill-move', method: 'POST' },
  );

  // ─── `/api/skill-file` — ONE bundle file (references/** + scripts/**) ──────
  //
  // The whole-bundle read/write/delete surface beneath SKILL.md. Routing splits
  // by scope × type: a PROJECT `.md` reference is a real CRDT content doc
  // (`.ok/skills/<name>/references/x` — graph + live-edit + shadow attribution),
  // so its write routes through the SAME paired-write primitive the project
  // SKILL.md body uses (`composeAndWriteRawBody` under the per-session origin).
  // A GLOBAL `.md` reference and EVERY script are fs-direct (atomic tmp+rename)
  // via the skills-write helper — global skills live outside the project graph,
  // scripts are non-markdown so cannot be wiki-linked. Reads are uniform
  // (fs-direct) across scope/type so scripts + global refs are MCP-readable too.

  /** Skill-relative bundle path → its allowed-root kind, or null (out of allowlist). */
  function classifySkillFilePath(rel: string): 'reference' | 'script' | null {
    // Reject a NUL byte for parity with the sibling validators
    // (`resolveSkillFilePath`, `resolveBundleFileAbs`) — a NUL can truncate a
    // path at the syscall boundary.
    if (rel.includes('\x00')) return null;
    const segments = rel
      .replace(/\\/g, '/')
      .split('/')
      .filter((s) => s !== '' && s !== '.');
    if (segments.length < 2 || segments.some((s) => s === '..')) return null;
    if (segments[0] === 'references') return 'reference';
    if (segments[0] === 'scripts') return 'script';
    return null;
  }

  /** Whether a project `.md` reference (the CRDT-routed case) — else fs-direct. */
  function isProjectMdReference(
    scope: 'project' | 'global',
    kind: 'reference' | 'script',
    rel: string,
  ): boolean {
    return scope === 'project' && kind === 'reference' && rel.toLowerCase().endsWith('.md');
  }

  /** The CRDT content-doc name (ext-less) for a project `.md` reference. */
  function projectRefContentDocName(name: string, rel: string): string {
    // `.ok/skills/<name>/references/x.md` → content doc `.ok/skills/<name>/references/x`.
    const extLess = rel.replace(/\.md$/i, '');
    return `${projectSkillContentDocName(name).replace(/\/SKILL$/, '')}/${extLess}`;
  }

  /** Project-scope `.md` bundle references currently on disk under a skill dir. */
  function listProjectMdReferences(skillsRoot: string, name: string): string[] {
    const refsDir = resolve(skillsRoot, name, 'references');
    if (!existsSync(refsDir)) return [];
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(resolve(dir, entry.name), rel);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          out.push(`references/${rel}`);
        }
      }
    };
    walk(refsDir, '');
    return out;
  }

  /**
   * After a PROJECT skill's directory is relocated on disk (git-mv'd by the
   * rename handler) its `SKILL.md` and every `.md` reference are content docs
   * whose live derived-index (`live-derived-index.ts` `onChange`) only fires on
   * a CRDT write — which a disk rename never triggers — and whose persistence
   * store hook (which indexes backlinks) only fires on a write. So the moved
   * docs sit unindexed (absent from the link/backlink/tag graph) at their NEW
   * doc names until a manual rescan. Drive the backlink + tag index over to the
   * new names from the relocated bytes on disk and drop the stale OLD-name
   * entries — the SAME primitive (`renameDocument` = delete-old + index-new)
   * the document rename handler uses. Reads disk verbatim: no CRDT write (so the
   * content docs never desync — disk stays the truth on the next open), and no
   * session churn against the just-moved dir.
   */
  function reindexMovedProjectSkillDocs(
    skillsRoot: string,
    fromName: string,
    toName: string,
  ): void {
    if (!backlinkIndex) return;
    const reindexOne = (oldDocName: string, newDocName: string, absFile: string): void => {
      let markdown: string;
      try {
        markdown = readFileSync(absFile, 'utf-8');
      } catch {
        // Unreadable relocated file: drop the stale old-name entry rather than
        // leave it dangling (the next open will index it fresh from disk).
        backlinkIndex.deleteDocument(oldDocName);
        tagIndex?.deleteDocument(oldDocName);
        return;
      }
      backlinkIndex.renameDocument(oldDocName, newDocName, markdown);
      tagIndex?.renameDocument(oldDocName, newDocName, markdown);
    };

    // SKILL.md: its rewrite during the move is fs-direct (applySkillWrite), so
    // it never re-enters the index via a CRDT write either. The reference `.md`
    // files were git-mv'd verbatim — never rewritten — so they too are stale.
    reindexOne(
      projectSkillContentDocName(fromName),
      projectSkillContentDocName(toName),
      resolve(skillsRoot, toName, 'SKILL.md'),
    );
    for (const rel of listProjectMdReferences(skillsRoot, toName)) {
      reindexOne(
        projectRefContentDocName(fromName, rel),
        projectRefContentDocName(toName, rel),
        resolve(skillsRoot, toName, rel),
      );
    }
    // Nudge any client that isn't holding the moved docs open to refresh its
    // graph promptly. (`tags` rides the live-derived-index path, not here.)
    signalChannel?.('backlinks');
    signalChannel?.('graph');
  }

  const handleSkillFileGet = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = url.searchParams.get('name') ?? '';
        if (!validateSkillName(name, res, 'skill-file-get')) return;
        const scope = parseSkillScope(url.searchParams.get('scope'), res, 'skill-file-get');
        if (scope === null) return;
        const rel = url.searchParams.get('path') ?? '';
        const kind = classifySkillFilePath(rel);
        if (kind === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Invalid skill file path (must be a file under references/ or scripts/).',
            { handler: 'skill-file-get' },
          );
          return;
        }
        const skillsRoot = resolveSkillsRoot(scope);
        const skillDir = resolve(skillsRoot, name);
        const abs = resolve(skillDir, rel);
        if (abs !== skillDir && !abs.startsWith(`${skillDir}${sep}`)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Skill file path escapes the skill dir.',
            {
              handler: 'skill-file-get',
            },
          );
          return;
        }
        // A global skill REFERENCE graph node is extension-less, and the client
        // rebuilds the path with a hardcoded `.md`; when the on-disk file is
        // actually `.mdx`, the literal `.md` path 404s. Resolve the requested
        // path, falling back to the sibling supported doc extension (.md ↔ .mdx)
        // so a `.mdx` reference opens. Scripts / real-extension refs that exist
        // as-is take the direct path and never trigger the fallback.
        let resolvedAbs = abs;
        let resolvedRel = rel;
        if (!existsSync(resolvedAbs)) {
          const docStem = rel.match(/^(.*)\.(?:md|mdx)$/);
          const sibling = docStem
            ? SUPPORTED_DOC_EXTENSIONS.map((ext) => `${docStem[1]}${ext}`).find(
                (candidate) => candidate !== rel && existsSync(resolve(skillDir, candidate)),
              )
            : undefined;
          if (sibling === undefined) {
            errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill file not found.', {
              handler: 'skill-file-get',
              detail: `${rel} not found in skill "${name}" (${scope}).`,
            });
            return;
          }
          resolvedRel = sibling;
          resolvedAbs = resolve(skillDir, sibling);
        }
        // Read as text (a script comes back as text, never an executable stream).
        const buf = await readFile(resolvedAbs);
        if (buf.includes(0)) {
          errorResponse(
            res,
            415,
            'urn:ok:error:invalid-request',
            'Skill file is binary — only text bundle files are readable via MCP.',
            { handler: 'skill-file-get' },
          );
          return;
        }
        successResponse(
          res,
          200,
          SkillFileGetSuccessSchema,
          { path: resolvedRel.replace(/\\/g, '/'), kind, text: buf.toString('utf-8') },
          { handler: 'skill-file-get' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read skill file.',
          {
            handler: 'skill-file-get',
            cause: e,
          },
        );
      }
    },
    { handler: 'skill-file-get', method: 'GET', skipBodyParse: true },
  );

  const handleSkillFilePut = withValidation(
    SkillFilePutRequestSchema,
    async (_req, res, body) => {
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-file-put',
          });
          return;
        }
        if (!validateSkillName(body.name, res, 'skill-file-put')) return;
        const kind = classifySkillFilePath(body.path);
        if (kind === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Invalid skill file path (must be a file under references/ or scripts/, no `..`).',
            { handler: 'skill-file-put' },
          );
          return;
        }
        if (Buffer.byteLength(body.content, 'utf-8') > BUNDLE_FILE_MAX_BYTES) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Skill file exceeds the 256 KB per-file cap.',
            { handler: 'skill-file-put' },
          );
          return;
        }
        const skillsRoot = resolveSkillsRoot(body.scope);
        const skillMd = resolve(skillsRoot, body.name, 'SKILL.md');
        if (!existsSync(skillMd)) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-file-put',
            detail: `Create skill "${body.name}" before adding bundle files.`,
          });
          return;
        }
        const rel = body.path.replace(/\\/g, '/');
        const routedThroughContent = isProjectMdReference(body.scope, kind, rel);
        let created: boolean;

        if (routedThroughContent) {
          // Project `.md` reference = CRDT content doc: route the write through
          // the doc's `Y.Text('source')` via the sanctioned paired-write
          // primitive (precedent #24 / #38), same branch as the SKILL.md body.
          // Persistence serializes Y.Text verbatim to `.ok/skills/<name>/<rel>`.
          const refDocName = projectRefContentDocName(body.name, rel);
          // Refuse if the reference content doc is mid-conflict — same gate as
          // the sibling content-write handlers.
          if (checkSkillDocConflictGate(refDocName, 'skill-file-put', res)) return;
          created = !existsSync(resolve(skillsRoot, body.name, rel));
          // Enforce the per-skill bundle-file cap on this CRDT-routed branch too.
          // The fs-direct branch counts inside `applySkillBundleFileWrite`;
          // without this, project `.md` references (the most common bundle file)
          // could grow unbounded while scripts + global refs are capped.
          if (created && countBundleFiles(resolve(skillsRoot, body.name)) >= BUNDLE_MAX_FILES) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              `Skill "${body.name}" already holds ${BUNDLE_MAX_FILES} bundle files (the cap) — delete one before adding another.`,
              { handler: 'skill-file-put' },
            );
            return;
          }
          const { agentId, agentName, colorSeed, clientName } = extractAgentIdentity(
            body as unknown as Record<string, unknown>,
          );
          const session = await sessionManager.getSession(refDocName, agentId, {
            displayName: agentName,
            colorSeed,
            clientName,
          });
          session.dc.document.transact(() => {
            composeAndWriteRawBody(session.dc.document, body.content, 'agent');
          }, session.origin);
          const flushOutcome = await flushDiskAndDetectOutcome(refDocName);
          if (flushOutcome?.kind === 'failure') {
            respondPersistenceFailure(res, flushOutcome.failure, 'skill-file-put');
            return;
          }
          if (flushOutcome?.kind === 'divergence') {
            respondDiskDivergence(res, 'skill-file-put');
            return;
          }
        } else {
          // Global `.md` reference OR any script: fs-direct atomic write.
          const fsResult = applySkillBundleFileWrite({
            skillsRoot,
            name: body.name,
            relPath: rel,
            content: body.content,
          });
          if (!fsResult.ok) {
            const status =
              fsResult.error.code === 'WRITE_ERROR'
                ? 500
                : fsResult.error.code === 'SKILL_NOT_FOUND'
                  ? 404
                  : 400;
            errorResponse(
              res,
              status,
              status === 500
                ? 'urn:ok:error:internal-server-error'
                : status === 404
                  ? 'urn:ok:error:not-found'
                  : 'urn:ok:error:invalid-request',
              status === 500 ? 'Failed to write skill file.' : 'Invalid skill file request.',
              {
                handler: 'skill-file-put',
                detail: fsResult.error.code,
                cause: new Error(fsResult.error.message),
              },
            );
            return;
          }
          created = fsResult.created;
        }

        // Attribute + shadow-commit project-scope writes under the skill's
        // artifact key (the skill dir) — same timeline as SKILL.md edits. Global
        // skills live outside any project git and are unversioned.
        if (body.scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.name),
            `${created ? 'skill-file-create' : 'skill-file-edit'}: .ok/skills/${body.name}/${rel}`,
          );
          await commitOkArtifactWrite('skill-file-put');
        }
        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillFilePutSuccessSchema,
          { path: rel, created, kind, content: routedThroughContent },
          { handler: 'skill-file-put' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to write skill file.',
          {
            handler: 'skill-file-put',
            cause: e,
          },
        );
      }
    },
    { handler: 'skill-file-put', method: 'PUT' },
  );

  const handleSkillFileDelete = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const sp = url.searchParams;
        const name = sp.get('name') ?? '';
        if (!validateSkillName(name, res, 'skill-file-delete')) return;
        const scope = parseSkillScope(sp.get('scope'), res, 'skill-file-delete');
        if (scope === null) return;
        const rel = (sp.get('path') ?? '').replace(/\\/g, '/');
        const kind = classifySkillFilePath(rel);
        if (kind === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Invalid skill file path (must be a file under references/ or scripts/).',
            { handler: 'skill-file-delete' },
          );
          return;
        }
        const actor = extractActorIdentity(
          {
            agentId: sp.get('agentId') ?? undefined,
            agentName: sp.get('agentName') ?? undefined,
            colorSeed: sp.get('colorSeed') ?? undefined,
            clientName: sp.get('clientName') ?? undefined,
            clientVersion: sp.get('clientVersion') ?? undefined,
            label: sp.get('label') ?? undefined,
            summary: sp.get('summary') ?? undefined,
          },
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-file-delete',
          });
          return;
        }
        const skillsRoot = resolveSkillsRoot(scope);

        // A project `.md` reference is a live content doc — tear it down BEFORE
        // removing the file so its persistence branch can't resurrect it.
        if (isProjectMdReference(scope, kind, rel)) {
          await captureAndCloseDocuments([projectRefContentDocName(name, rel)], 'deleted-upstream');
        }

        const result = applySkillBundleFileDelete({ skillsRoot, name, relPath: rel });
        if (!result.ok) {
          const status = result.error.code === 'UNLINK_FAILED' ? 500 : 400;
          errorResponse(
            res,
            status,
            status === 500 ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request',
            status === 500 ? 'Failed to delete skill file.' : 'Invalid skill file request.',
            {
              handler: 'skill-file-delete',
              detail: result.error.code,
              cause: new Error(result.error.message),
            },
          );
          return;
        }
        if (result.existed && scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', name),
            `skill-file-delete: .ok/skills/${name}/${rel}`,
          );
          await commitOkArtifactWrite('skill-file-delete');
        }
        if (result.existed) signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillFileDeleteSuccessSchema,
          { path: rel, existed: result.existed, kind },
          { handler: 'skill-file-delete' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to delete skill file.',
          {
            handler: 'skill-file-delete',
            cause: e,
          },
        );
      }
    },
    { handler: 'skill-file-delete', method: 'DELETE', skipBodyParse: true },
  );

  async function handleSkillFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') return handleSkillFileGet(req, res);
    if (req.method === 'PUT') return handleSkillFilePut(req, res);
    if (req.method === 'DELETE') return handleSkillFileDelete(req, res);
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'skill-file',
      extraHeaders: { Allow: 'GET, PUT, DELETE' },
    });
  }

  // `POST /api/skill/install` — project a skill's `.ok/skills/<name>/` source
  // into the project-configured editor host dirs. This is a local-op
  // projection (writes host dirs on this machine, OUTSIDE the content/CRDT
  // plane), not an attributed content mutation — the SOURCE edit is what gets
  // attributed. Validates the source FIRST (pre-install gate) so a
  // conflicted/malformed SKILL.md never lands verbatim in an agent's context.
  const handleSkillInstall = withValidation(
    SkillInstallRequestSchema,
    async (_req, res, body) => {
      try {
        const skillsRoot = resolveSkillsRoot(body.scope);
        if (!validateSkillName(body.name, res, 'skill-install')) return;

        // Project skills install into the project's host dirs (require a
        // resolved project root); global skills install into the user-global
        // host dirs (`<home>/.{host}/skills/`), which need no project. `base` is
        // both the cwd `projectSkill` resolves host dirs against AND where the
        // install marker lives (project marker vs user marker).
        if (body.scope === 'project' && !projectDir) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Cannot install — no project root is resolved for this server. Skills project into editor host dirs at the project root.',
            { handler: 'skill-install', detail: 'NO_PROJECT_ROOT' },
          );
          return;
        }
        const base = skillInstallBase(body.scope) as string;

        const skillDir = resolve(skillsRoot, body.name);
        if (!existsSync(skillDir)) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-install',
            detail: `Skill "${body.name}" not found in ${body.scope} scope — create it with write({ skill }) first.`,
          });
          return;
        }

        const validity = validateSkillForInstall(skillDir, body.name);
        if (!validity.ok) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            `Skill "${body.name}" cannot be installed: ${validity.errors.join(' ')}`,
            { handler: 'skill-install', detail: 'INVALID_SKILL_SOURCE' },
          );
          return;
        }

        // Targets: global installs into every editor that has a skill folder
        // ("all your editors, every project"), honoring an explicit
        // `targets` filter; project resolves the committed
        // `.ok/skill-targets.json` set → detected project-configured editors.
        const targets: EditorId[] =
          body.scope === 'global'
            ? body.targets
              ? // body.targets is the narrower SkillTargetEditor set (no
                // claude-desktop, which shares claude's host dir); match by
                // value so the EditorId/SkillTargetEditor widths don't clash.
                PROJECT_SKILL_EDITOR_IDS.filter((id) => body.targets?.some((t) => t === id))
              : [...PROJECT_SKILL_EDITOR_IDS]
            : body.targets !== undefined
              ? // An EXPLICIT target list from the per-editor menu is set-exact,
                // INCLUDING `[]` (unchecking the last editor = install nowhere =
                // uninstall). Routing `[]` through resolveSkillTargets would hit
                // its empty→detect fallback and wrongly re-install into every
                // detected editor. Only an OMITTED `targets` means "use defaults".
                PROJECT_SKILL_EDITOR_IDS.filter((id) => body.targets?.some((t) => t === id))
              : resolveSkillTargets(base, readSkillTargets(base) ?? undefined);
        const warnings: string[] = [];
        // Parallel machine-readable codes (`warnings[i]` ↔ `warningCodes[i]`) so
        // clients switch on the code, not the English string.
        const warningCodes: SkillInstallWarningCode[] = [];
        // Only warn about a no-op when the user did NOT explicitly ask for an
        // empty set. An explicit `targets: []` (unchecking every editor) is an
        // intentional uninstall, not a "couldn't find editors" failure — warning
        // there mislabels a successful uninstall.
        if (targets.length === 0 && body.targets === undefined) {
          warnings.push(
            body.scope === 'global'
              ? 'No editor skill folders are configured to install into.'
              : 'No project-configured editors detected — nothing was projected. Set up an editor for this project (add .mcp.json / .cursor/mcp.json / .codex/config.toml) or pass explicit `targets`.',
          );
          warningCodes.push('no-targets');
        }
        // No "already installed — replacing" warning: install is set-exact over a
        // live symlink, so a second install is additive (a NEW projection at a new
        // editor) or a toggle-off (handled by `dropped` below), never a destructive
        // replace. The success response reports the accurate resulting host set.
        if (validity.hasScripts) {
          warnings.push(
            'This skill includes executable `scripts/`. After you install it, the AI agent in your editor (Claude, Cursor, Codex) can run them — Open Knowledge itself never runs anything. Review the scripts before sharing.',
          );
          warningCodes.push('scripts-present');
        }

        // Set-exact: drop any editor the skill was previously installed into
        // but that isn't in this target set, so the per-editor install menu can
        // toggle a single editor off without leaving an orphaned symlink behind.
        const priorHosts = resolvedHosts(readInstalledSkills(base).skills[body.name]?.hosts ?? []);
        const dropped = priorHosts.filter((h) => !targets.includes(h));
        if (dropped.length > 0) reverseProjectSkill(body.name, base, dropped);
        const hosts = projectSkill(skillDir, body.name, base, targets);
        if (hosts.length === 0) {
          // Zero editors left (unchecked them all) = fully uninstalled. DROP the
          // marker rather than recording `hosts: []`: the Skills list derives
          // `installed` from marker PRESENCE, and reconcile/reclaim re-materializes
          // from the marker — so an empty marker would keep the skill reading
          // Installed and could be re-projected into every detected editor.
          await removeSkillInstall(base, body.name);
        } else {
          await recordSkillInstall(base, body.name, {
            hosts,
            scope: body.scope,
            scripts: validity.hasScripts,
            installedAt: new Date().toISOString(),
          });
        }
        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillInstallSuccessSchema,
          { name: body.name, hosts, scripts: validity.hasScripts, warnings, warningCodes },
          { handler: 'skill-install' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to install skill.', {
          handler: 'skill-install',
          cause: e,
        });
      }
    },
    { handler: 'skill-install', method: 'POST' },
  );

  // `POST /api/skill/uninstall` — remove a skill's editor-host projections +
  // drop its marker entry, leaving the SOURCE intact (the skill demotes to
  // Draft). The inverse of install: same scope→base map, the shared
  // `uninstallSkillFromHostDirs` reverse-projection. A local-op, not an
  // attributed content mutation. Idempotent: uninstalling a Draft is a no-op.
  const handleSkillUninstall = withValidation(
    SkillUninstallRequestSchema,
    async (_req, res, body) => {
      try {
        if (!validateSkillName(body.name, res, 'skill-uninstall')) return;
        const base = skillInstallBase(body.scope);
        if (!base) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Cannot uninstall — no project root is resolved for this server.',
            { handler: 'skill-uninstall', detail: 'NO_PROJECT_ROOT' },
          );
          return;
        }
        const uninstalled = await uninstallSkillFromHostDirs(base, body.name);
        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillUninstallSuccessSchema,
          { name: body.name, uninstalled },
          { handler: 'skill-uninstall' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to uninstall skill.',
          {
            handler: 'skill-uninstall',
            cause: e,
          },
        );
      }
    },
    { handler: 'skill-uninstall', method: 'POST' },
  );

  // `/api/skill-targets` — the editable project skill-target set
  // (`.ok/skill-targets.json`, committed). GET reads the effective set; PUT
  // writes a new set and re-projects EVERY managed skill — authored skills
  // (from the marker) AND OK's shipped `open-knowledge` bundle — to the new
  // editors, reverse-projecting from dropped ones. A user/UI action (the set
  // is project-config with teammate-wide blast radius), not agent-attributed.
  async function handleSkillTargets(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') return handleSkillTargetsGet(req, res);
    if (req.method === 'PUT') return handleSkillTargetsPut(req, res);
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'skill-targets',
      extraHeaders: { Allow: 'GET, PUT' },
    });
  }

  const handleSkillTargetsGet = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        const committed = projectDir ? readSkillTargets(projectDir) : null;
        const targets = resolveSkillTargets(projectDir ?? '', committed ?? undefined);
        successResponse(
          res,
          200,
          SkillTargetsGetSuccessSchema,
          { targets, configured: committed !== null },
          { handler: 'skill-targets-get' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read skill targets.',
          { handler: 'skill-targets-get', cause: e },
        );
      }
    },
    { handler: 'skill-targets-get', method: 'GET', skipBodyParse: true },
  );

  const handleSkillTargetsPut = withValidation(
    SkillTargetsPutRequestSchema,
    async (_req, res, body) => {
      try {
        if (!projectDir) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Cannot set skill targets — no project root is resolved for this server.',
            { handler: 'skill-targets-put', detail: 'NO_PROJECT_ROOT' },
          );
          return;
        }
        const newTargets = body.targets;
        const newSet = new Set<string>(newTargets);
        const oldTargets = resolveSkillTargets(
          projectDir,
          readSkillTargets(projectDir) ?? undefined,
        );
        const skillsRoot = resolveSkillsRoot('project');

        await writeSkillTargets(projectDir, newTargets);
        // Shared with reclaim: re-project authored skills + OK's bundle to the
        // new set, reverse-project from dropped editors, sync the marker.
        const { reprojected, bundleHosts } = await reprojectAllManagedSkills({
          projectDir,
          skillsRoot,
          targets: newTargets,
        });

        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillTargetsPutSuccessSchema,
          {
            targets: newTargets,
            reprojected,
            bundleHosts,
            removedFrom: oldTargets.filter((t) => !newSet.has(t)),
          },
          { handler: 'skill-targets-put' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to set skill targets.',
          { handler: 'skill-targets-put', cause: e },
        );
      }
    },
    { handler: 'skill-targets-put', method: 'PUT' },
  );

  // `POST /api/skill/restore` — restore a skill's source to a prior shadow-repo
  // version (fs-direct; net-new). The
  // restore itself is attributed as a new `skill-restore` version.
  const handleSkillRestore = withValidation(
    SkillRestoreRequestSchema,
    async (_req, res, body) => {
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-restore',
          });
          return;
        }
        if (!validateSkillName(body.name, res, 'skill-restore')) return;
        // Global skills are unversioned — there's no prior version to restore.
        if (body.scope === 'global') {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Global skills are unversioned — there is no version history to restore from.',
            { handler: 'skill-restore', detail: 'GLOBAL_SCOPE_UNVERSIONED' },
          );
          return;
        }

        const shadow = shadowRef?.current;
        if (!shadow) {
          errorResponse(
            res,
            409,
            'urn:ok:error:shadow-not-configured',
            'No version history available to restore from.',
            {
              handler: 'skill-restore',
              detail: 'NO_SHADOW_REPO',
            },
          );
          return;
        }
        const result = await restoreSkillVersion({
          shadow,
          contentDir,
          contentRoot: contentRoot ?? '.',
          name: body.name,
          version: body.version,
        });
        if (!result.ok) {
          // Map the failure code to a status: genuine git/disk I/O (and an
          // escaping shadow path) are server-side 5xx, not a 404 "not found".
          const restoreErrorMap = {
            'no-shadow': [409, 'urn:ok:error:shadow-not-configured'],
            'version-not-found': [404, 'urn:ok:error:not-found'],
            'skill-absent': [404, 'urn:ok:error:not-found'],
            'io-error': [500, 'urn:ok:error:storage-error'],
            'path-escape': [500, 'urn:ok:error:path-escape'],
          } as const;
          const [status, typeUri] = restoreErrorMap[result.code];
          errorResponse(res, status, typeUri, result.error, {
            handler: 'skill-restore',
            detail: result.code,
          });
          return;
        }

        const warnings: string[] = [];
        const skillDir = resolve(contentDir, '.ok', 'skills', body.name);
        const validity = validateSkillForInstall(skillDir, body.name);
        if (!validity.ok) {
          warnings.push(
            `Restored, but the skill no longer validates: ${validity.errors.join(' ')}`,
          );
        }
        warnings.push('Run `install` to push the restored version to your editors.');

        // Attribute the restore as a new version so it appears in history.
        attributeOkArtifactWrite(
          actor,
          okArtifactKey('skill', '', body.name),
          `skill-restore: ${body.name} @ ${body.version.slice(0, 8)}`,
        );
        await commitOkArtifactWrite('skill-restore');
        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillRestoreSuccessSchema,
          {
            name: body.name,
            version: body.version,
            restoredFiles: result.restoredFiles,
            warnings,
          },
          { handler: 'skill-restore' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to restore skill.', {
          handler: 'skill-restore',
          cause: e,
        });
      }
    },
    { handler: 'skill-restore', method: 'POST' },
  );

  // `POST /api/skill/update` — refresh an installed starter-pack skill
  // (`open-knowledge-pack-*`) from OK's currently-bundled source. Opt-in (the UI
  // surfaces it only when `updateAvailable`); never auto-invoked. Checkpoints the
  // current doc FIRST (reversible via version history), then overwrites the
  // content doc VERBATIM from the bundle (preserving the bundled `version`),
  // routed through the same CRDT paired-write path as skill-put.
  const handleSkillUpdate = withValidation(
    SkillUpdateRequestSchema,
    async (_req, res, body) => {
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-update',
          });
          return;
        }
        if (!validateSkillName(body.name, res, 'skill-update')) return;
        // Only starter-pack skills have a bundled source to refresh from.
        if (!isPackSkillName(body.name)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Only starter-pack skills (`open-knowledge-pack-*`) can be updated from the bundle.',
            { handler: 'skill-update', detail: 'NOT_A_PACK_SKILL' },
          );
          return;
        }
        // Pack skills are project-scope; the global store ships no packs.
        if (body.scope === 'global') {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Pack skills are project-scope — there is no global-scope pack to update.',
            { handler: 'skill-update', detail: 'GLOBAL_SCOPE' },
          );
          return;
        }

        const bundled = readBundledPackSkill(body.name);
        if (bundled === null || bundled.version === undefined) {
          errorResponse(
            res,
            404,
            'urn:ok:error:not-found',
            'No bundled version is available for this pack skill.',
            { handler: 'skill-update', detail: 'NO_BUNDLED_VERSION' },
          );
          return;
        }

        const skillsRoot = resolveSkillsRoot('project');
        const filePath = resolve(skillsRoot, body.name, 'SKILL.md');
        if (!existsSync(filePath)) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill is not installed.', {
            handler: 'skill-update',
            detail: 'SKILL_ABSENT',
          });
          return;
        }
        let previousVersion: string | undefined;
        try {
          previousVersion = readSkillVersion(readFileSync(filePath, 'utf-8'));
        } catch {
          // Unreadable current copy — proceed; the overwrite + checkpoint still apply.
        }

        // Checkpoint-before-overwrite: snapshot current state into version
        // history so the user can restore their pre-update edits. Best-effort —
        // a missing shadow repo (e.g. a non-git project) must not block the
        // update; the overwrite is the user's explicit, confirmed action.
        let checkpointRef: string | undefined;
        const shadow = shadowRef?.current;
        if (shadow) {
          try {
            const branch = getCurrentBranch?.() ?? 'main';
            const cp = await saveVersion(
              shadow,
              contentRoot ?? '.',
              [SERVICE_WRITER],
              branch,
              `Before updating ${body.name} (${previousVersion ?? 'unversioned'} → ${bundled.version})`,
            );
            checkpointRef = cp.checkpointRef;
          } catch (err) {
            getLogger('skills').warn(
              { err, skill: body.name },
              'pre-update checkpoint failed — proceeding with overwrite',
            );
          }
        }

        // Overwrite the content doc VERBATIM (preserves the bundled `version` +
        // all frontmatter — do NOT recompose). Same CRDT paired-write path +
        // per-session frozen origin as skill-put.
        const docName = skillLiveDocName('project', body.name);
        // Refuse if the pack skill's content doc is mid-conflict — same gate as
        // the sibling content-write handlers.
        if (checkSkillDocConflictGate(docName, 'skill-update', res)) return;
        const { agentId, agentName, colorSeed, clientName } = extractAgentIdentity(
          body as unknown as Record<string, unknown>,
        );
        const session = await sessionManager.getSession(docName, agentId, {
          displayName: agentName,
          colorSeed,
          clientName,
        });
        session.dc.document.transact(() => {
          composeAndWriteRawBody(session.dc.document, bundled.content, 'agent');
        }, session.origin);

        const flushOutcome = await flushDiskAndDetectOutcome(docName);
        if (flushOutcome?.kind === 'failure') {
          respondPersistenceFailure(res, flushOutcome.failure, 'skill-update');
          return;
        }
        if (flushOutcome?.kind === 'divergence') {
          respondDiskDivergence(res, 'skill-update');
          return;
        }

        attributeOkArtifactWrite(
          actor,
          okArtifactKey('skill', '', body.name),
          `skill-pack-update: ${body.name} (${previousVersion ?? 'unversioned'} → ${bundled.version})`,
        );
        await commitOkArtifactWrite('skill-update');
        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillUpdateSuccessSchema,
          {
            name: body.name,
            version: bundled.version,
            ...(previousVersion !== undefined ? { previousVersion } : {}),
            ...(checkpointRef !== undefined ? { checkpointRef } : {}),
          },
          { handler: 'skill-update' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to update skill.', {
          handler: 'skill-update',
          cause: e,
        });
      }
    },
    { handler: 'skill-update', method: 'POST' },
  );

  function deriveFolderSearchDocuments(
    pages: readonly WorkspaceSearchDocument[],
  ): WorkspaceSearchDocument[] {
    const folderModified = new Map<string, number>();
    for (const page of pages) {
      const segments = page.path.split('/').filter(Boolean);
      segments.pop();
      for (let i = 1; i <= segments.length; i++) {
        const folderPath = segments.slice(0, i).join('/');
        folderModified.set(
          folderPath,
          Math.max(folderModified.get(folderPath) ?? 0, page.modifiedTs),
        );
      }
    }
    return [...folderModified.entries()].map(([path, modifiedTs]) =>
      createWorkspaceSearchDocument({ kind: 'folder', path, modifiedTs }),
    );
  }

  function buildSearchSnippet(content: string, query: string): string | undefined {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery || !content) return undefined;
    const normalizedContent = content.toLowerCase();
    const index = normalizedContent.indexOf(normalizedQuery);
    if (index < 0) return undefined;
    const start = Math.max(0, index - 80);
    const end = Math.min(content.length, index + normalizedQuery.length + 120);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < content.length ? '…' : '';
    // slice() cuts on UTF-16 code units, so a boundary landing mid-emoji leaves a
    // lone surrogate. Replace any unpaired surrogate with U+FFFD so strict JSON-RPC
    // clients (Rust / pydantic parsers) don't reject the response as invalid UTF-8.
    // (String.toWellFormed() would do this but needs the es2024 lib in every consumer.)
    const snippet = `${prefix}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
    return snippet.replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '\uFFFD',
    );
  }

  function parseSearchIntent(value: unknown): WorkspaceSearchIntent {
    if (value === 'autocomplete' || value === 'full_text' || value === 'omnibar') return value;
    return 'omnibar';
  }

  function parseSearchScopes(value: unknown): WorkspaceSearchScope[] | undefined {
    const rawScopes =
      typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : undefined;
    if (!rawScopes) return undefined;
    const scopes = rawScopes.filter(
      (scope): scope is WorkspaceSearchScope =>
        scope === 'page' || scope === 'folder' || scope === 'content' || scope === 'file',
    );
    return scopes.length > 0 ? scopes : undefined;
  }

  /** Parse the opt-in `semantic` param from a query string / JSON body value. */
  function parseSemanticParam(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }

  /** Resolve the bounded `source` telemetry label; unknown / absent → `http`. */
  function parseSearchSource(value: unknown): SearchSource {
    return value === 'omnibar' || value === 'mcp' || value === 'http' ? value : 'http';
  }

  interface SemanticResolution {
    /** Vector input for `searchWorkspaceCorpus`, or undefined for pure-lexical. */
    input?: WorkspaceSemanticInput;
    /** Non-content coverage status block to attach to the response. */
    status?: SearchSemanticStatus;
    /** Per-query embed latency (ms), or null when no query embed ran. */
    queryEmbedMs: number | null;
    /** Total embeddable pages (coverage denominator). */
    pageTotal: number;
    /** Whether the embedder is loaded + keyed + warm. */
    capable: boolean;
  }

  /**
   * Resolve the per-query vector signal + coverage status for a search.
   *
   * Returns a pure-lexical resolution (no `input`, no `status`) — byte-identical
   * to the pre-embeddings path — unless the feature flag is ON **and** the caller
   * opted in (`semantic: true`). The omnibar and `semantic: false` never opt in,
   * so they stay lexical and carry no status block. When opted-in, fires the lazy
   * background corpus embed (no-op when incapable) and embeds only the query.
   */
  async function resolveSemantic(
    query: string,
    intent: WorkspaceSearchIntent,
    semanticParam: boolean | undefined,
    corpus: WorkspaceSearchCorpus,
  ): Promise<SemanticResolution> {
    // Predicate split: hidden / dot-path docs are searchable (admitted to the
    // corpus) but NEVER embedded — no semantic egress for agent-tooling/dotfiles.
    // The embeddable set is the corpus minus hidden paths, and it also drives the
    // coverage denominator so a searchable dot-path page is never counted as
    // "embeddable" (which would make coverage under-report forever).
    const embeddableDocs = corpus.documents.filter((d) => !isHiddenDocName(d.path));
    const pageTotal = embeddableDocs.reduce((n, d) => n + (d.kind === 'page' ? 1 : 0), 0);
    // Flag OFF, or the caller did not opt in → no status block, lexical path.
    if (!semanticSearch?.isEnabled() || semanticParam !== true) {
      return { queryEmbedMs: null, pageTotal, capable: false };
    }

    // Opted in + enabled: lazily (re-)embed the corpus in the background. Cheap
    // for unchanged docs; no-op when no key. This is the only embed trigger —
    // nothing embeds until an agent actually searches (no proactive egress).
    void semanticSearch.embedCorpus(embeddableDocs);

    // Semantic fuses into the body blend only, and skips trivially short queries.
    let input: WorkspaceSemanticInput | undefined;
    let queryEmbedMs: number | null = null;
    if (intent === 'full_text' && query.trim().length >= SEMANTIC_MIN_QUERY_LENGTH) {
      const startedAt = performance.now();
      const scores = await semanticSearch.queryScores(query, embeddableDocs);
      queryEmbedMs = performance.now() - startedAt;
      if (scores && scores.size > 0) {
        // Carry the project-local similarity floor when set so a model whose
        // cosine scale differs from the default can be retuned without a code
        // change; undefined leaves core on its model-calibrated default.
        const similarityFloor = getSemanticSimilarityFloor?.();
        input = similarityFloor !== undefined ? { scores, similarityFloor } : { scores };
      }
    }

    const status = semanticSearch.getStatus();
    return {
      input,
      status: {
        capable: status.capable,
        applied: false, // finalized post-ranking (did any result carry a vector)
        coverage: { embedded: status.embeddedCount, total: pageTotal },
      },
      queryEmbedMs,
      pageTotal,
      capable: status.capable,
    };
  }

  /** Map a search result to the wire entry, carrying `vector` only when present. */
  function toSearchResultEntry(
    result: ReturnType<typeof searchWorkspaceCorpus>[number],
    query: string,
  ): {
    kind: WorkspaceSearchScope;
    path: string;
    title: string;
    score: number;
    signals: WorkspaceSearchResult['signals'];
    snippet?: string;
  } {
    return {
      kind: result.document.kind,
      path: result.document.path,
      title: result.document.title,
      score: result.score,
      signals: result.signals,
      snippet:
        result.document.kind === 'page'
          ? buildSearchSnippet(result.document.content, query)
          : undefined,
    };
  }

  /**
   * Shared core for `GET` + `POST /api/search`: build the corpus, resolve the
   * (opt-in) vector signal, rank, and assemble the `SearchSuccess` body. One
   * implementation so GET and POST cannot drift in ranking, snippets, or the
   * semantic gate.
   */
  async function buildSearchResponse(params: {
    query: string;
    intent: WorkspaceSearchIntent;
    ranking: WorkspaceSearchRanking | undefined;
    scopes: WorkspaceSearchScope[] | undefined;
    limit: number | undefined;
    semanticParam: boolean | undefined;
    source: SearchSource;
  }): Promise<SearchSuccess> {
    const startedAt = performance.now();
    // Cold start: while the boot seed is still walking the content dir, do not
    // block on it and do not serve a partial/empty index as if it were complete.
    // Answer fast with `ready: false` so the caller (MCP `search`, palette, any
    // consumer) retries instead of trusting an empty result. The seed populates
    // the file index, so a retry after it resolves takes the normal path below.
    if (isSearchCorpusWarming()) {
      return {
        query: params.query,
        intent: params.intent,
        results: [],
        elapsedMs: Math.max(0, performance.now() - startedAt),
        ready: false,
      };
    }
    const { corpus, truncated } = await getWorkspaceSearchCorpus();
    const semantic = await resolveSemantic(
      params.query,
      params.intent,
      params.semanticParam,
      corpus,
    );
    const results = searchWorkspaceCorpus(corpus, params.query, {
      intent: params.intent,
      ranking: params.ranking,
      scopes: params.scopes,
      limit: params.limit,
      semantic: semantic.input,
    });
    const entries = results.map((r) => toSearchResultEntry(r, params.query));

    let semanticStatus: SearchSemanticStatus | undefined;
    if (semantic.status) {
      const vectorContributors = entries.reduce(
        (n, e) => n + (e.signals.vector !== undefined ? 1 : 0),
        0,
      );
      const applied = vectorContributors > 0;
      semanticStatus = { ...semantic.status, applied };
      const outcome: SemanticQueryOutcome = !semantic.capable
        ? 'incapable'
        : applied
          ? 'applied'
          : semantic.status.coverage.embedded === 0
            ? 'warming'
            : 'no_match';
      recordSemanticQuery({
        outcome,
        source: params.source,
        capable: semantic.capable,
        embedded: semantic.status.coverage.embedded,
        total: semantic.pageTotal,
        queryEmbedMs: semantic.queryEmbedMs,
        vectorContributors,
      });
    }

    return {
      query: params.query,
      intent: params.intent,
      results: entries,
      elapsedMs: Math.max(0, performance.now() - startedAt),
      ready: true,
      ...(semanticStatus ? { semantic: semanticStatus } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /**
   * Project skills (`<root>/.ok/skills/<name>/SKILL.md`) as cheap stat records —
   * readdir + stat only, no content read — so the per-search corpus fingerprint
   * can detect skill changes without paying a content read on every request.
   * Skills are tree-excluded from `getFileIndex()`, so search enumerates them
   * from disk. The corpus doc builder reuses this list and reads each matched
   * file's content.
   */
  function enumerateProjectSkillStats(): Array<{
    name: string;
    absolutePath: string;
    mtimeMs: number;
    size: number;
  }> {
    const root = resolveSkillsRoot('project');
    if (!existsSync(root)) return [];
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: Array<{ name: string; absolutePath: string; mtimeMs: number; size: number }> = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !SKILL_NAME_REGEX.test(entry.name)) continue;
      const skillMd = resolve(root, entry.name, 'SKILL.md');
      try {
        const st = statSync(skillMd);
        out.push({ name: entry.name, absolutePath: skillMd, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // Missing/unreadable SKILL.md — skip (a draft dir with no manifest).
      }
    }
    return out;
  }

  /**
   * Project skills as search documents (keyword + semantic — `embedCorpus`
   * embeds every corpus doc). Indexed under their managed-artifact doc path so a
   * hit opens the skill tab via the shared nav resolution. Title is the skill's
   * frontmatter name; content is its description + body, so a skill is findable
   * by what it does, not just its slug.
   */
  function buildSkillSearchDocuments(): WorkspaceSearchDocument[] {
    const docs: WorkspaceSearchDocument[] = [];
    for (const skill of enumerateProjectSkillStats()) {
      let title = skill.name;
      let content = '';
      try {
        const { frontmatter, body } = parseFrontmatterDoc(
          readFileSync(skill.absolutePath, 'utf-8'),
        );
        if (typeof frontmatter.name === 'string' && frontmatter.name) title = frontmatter.name;
        const desc = typeof frontmatter.description === 'string' ? frontmatter.description : '';
        content = `${desc}\n\n${body}`.trim();
      } catch {
        // Malformed/unreadable — index by name only so it is still findable.
      }
      docs.push(
        createWorkspaceSearchDocument({
          kind: 'page',
          // Project skills are content docs (`.ok/skills/<name>/SKILL`), not
          // `__skill__/project/<name>` — indexing the managed-artifact path made
          // every project-skill search hit open a blank phantom tab.
          path: skillLiveDocName('project', skill.name),
          title,
          content,
          modifiedTs: skill.mtimeMs,
        }),
      );
    }
    return docs;
  }

  // Per-entry change-detection key: the fields whose change should re-read a
  // page (modified / size / canonical path / inode / aliases), NUL-separated so
  // a path containing spaces can't merge fields and collide. `workspaceSearchFingerprint`'s
  // fallback prefixes this with the docName; the page-doc cache keys on it
  // directly (its Map is already docName-keyed). One definition keeps the two in
  // lockstep — drift would silently break cache invalidation (stale reuse or
  // needless re-reads).
  function entrySearchKey(entry: FileIndexEntry): string {
    // NUL between fields AND between aliases: a path/alias containing a comma
    // (rare but valid on macOS/Linux) must not collide with a different alias set.
    return `${entry.modified}\0${entry.size}\0${entry.canonicalPath}\0${entry.inode}\0${entry.aliases.join('\0')}`;
  }

  // Per-page parsed-document cache. Building the corpus re-reads every markdown
  // file from disk, but a rebuild is triggered by ANY file-index change (one
  // edit, a rename, a new sibling), so without this every keystroke-after-an-edit
  // would re-read and re-parse the whole workspace. Reuse a page's search
  // document across rebuilds when its own entry is unchanged — re-reading only
  // the delta. Invariant direction: a change that busts THIS page's `entrySearchKey`
  // also bumps the generation counter that invalidates the corpus — but NOT the
  // converse: a rebuild triggered by a sibling change reuses this page's cached
  // doc when its own entry is unchanged (the whole point). Only successful reads
  // are cached, so a transient read failure self-heals on the next rebuild rather
  // than pinning empty content. Pruned to the live index each build, so it stays
  // bounded by the workspace size. The name-only `file` tier and derived folder
  // docs are metadata-only (no disk read), so they are rebuilt each time.
  const pageDocCache = new Map<string, { key: string; doc: WorkspaceSearchDocument }>();

  async function buildWorkspaceSearchDocumentsFromIndex(): Promise<{
    documents: WorkspaceSearchDocument[];
    truncated: boolean;
  }> {
    const pages: WorkspaceSearchDocument[] = [];
    const files: WorkspaceSearchDocument[] = [];
    // Type-annotated, like the two siblings above, so the getAllFilesIndex
    // caller-coverage meta-test attributes the call below to this (allowlisted)
    // function rather than latching onto a bare local declaration.
    const seenPages: Set<string> = new Set();
    for (const [docName, entry] of getAllFilesIndex()) {
      // System + config synthetic docs never enter search. Hidden / dot-prefixed
      // paths (`.changeset/`, `.github/`, `.cursor/`) DO — they are searchable by
      // name/path (rank-deprioritized in core) so "search what the tree shows"
      // holds. They stay out of the embedding/egress path, which keeps the
      // `isHiddenDocName` filter where the corpus is handed to the embedder.
      if (isSystemDoc(docName) || isConfigDoc(docName)) continue;
      // Project-skill content docs (`.ok/skills/<name>/SKILL`) ARE in the index
      // now (skills-as-content), and this loop iterates the all-files view — but
      // `buildSkillSearchDocuments()` already indexes each skill with skill-aware
      // title/content under the same path. Skip them here so they aren't added
      // twice (a duplicate corpus id throws and 500s the whole search). The
      // prefix matches `skillLiveDocName('project', …)` → `.ok/skills/<name>/SKILL`.
      if (docName.startsWith('.ok/skills/')) continue;
      if (entry.kind === 'file') {
        // Name-only tier: a non-markdown file is searchable by name / path /
        // folder, but its body is NEVER read (content stays markdown-only).
        // `pathToDocName` keeps the extension for non-markdown, so `data.csv`
        // is findable by both `data` and `data.csv`; the basename is the title.
        files.push(
          createWorkspaceSearchDocument({
            kind: 'file',
            path: docName,
            modifiedTs: Date.parse(entry.modified),
            // Symlink alias paths fold into searchable pathSegments (inode-dedup
            // already gives one entry per file via the canonical-keyed index).
            aliases: entry.aliases,
          }),
        );
        continue;
      }
      // Markdown page: reuse the cached parse when its entry is unchanged (same
      // fingerprint components), else re-read and re-cache.
      seenPages.add(docName);
      const entryKey = entrySearchKey(entry);
      const cached = pageDocCache.get(docName);
      if (cached && cached.key === entryKey) {
        pages.push(cached.doc);
        continue;
      }
      let content = '';
      let title = docName;
      let readFailed = false;
      try {
        content = await readFile(entry.canonicalPath, 'utf-8');
      } catch (err) {
        // A transient read (external editor mid-save, EBUSY, NFS blip, a
        // watcher-vs-disk race) must NOT be cached — the entry fingerprint does
        // not change just because the read failed, so a cached empty-content doc
        // would persist and silently hide the page from body search until its
        // mtime/size/inode shifts. Skip the cache write so the next rebuild
        // retries, preserving the pre-cache self-healing behavior.
        readFailed = true;
        console.warn(`[search] Failed to read ${docName}:`, err);
      }
      if (!readFailed) {
        try {
          title = extractPageTitle(content, docName);
        } catch (err) {
          // Title extraction is pure string work, so a throw here is a
          // deterministic parse fault, not transient I/O. Fall back to the
          // docName as title but still cache (the read succeeded) — caching it
          // avoids re-parsing the same failing content on every rebuild, the
          // opposite of the read-failure path's deliberate retry.
          console.warn(`[search] Failed to extract title for ${docName}:`, err);
        }
      }
      const doc = createWorkspaceSearchDocument({
        kind: 'page',
        path: docName,
        title,
        content,
        modifiedTs: Date.parse(entry.modified),
        aliases: entry.aliases,
      });
      if (!readFailed) pageDocCache.set(docName, { key: entryKey, doc });
      pages.push(doc);
    }
    // Prune cache entries for pages no longer in the index (deleted / renamed)
    // so the cache tracks the live workspace rather than growing unbounded.
    // Unconditional: a failed read adds to `seenPages` but not to the cache, so
    // a `size`-comparison guard could read equal and skip a genuinely-needed
    // prune. The loop is O(cache) — same order as the build it follows.
    for (const docName of pageDocCache.keys()) {
      if (!seenPages.has(docName)) pageDocCache.delete(docName);
    }
    // Cap the name-only file tier (markdown pages are never dropped). Over the
    // ceiling, drop DEEPEST paths first (level-order): the shallowest entries are
    // the most navigationally useful, and dropping the deep tail mirrors the
    // show-all truncation BFS. The dogfood repo (~16k) is far under the
    // 50k default; this is a pathological-repo backstop.
    const maxFiles = getSearchMaxEntries();
    let admittedFiles = files;
    let truncated = false;
    if (files.length > maxFiles) {
      truncated = true;
      admittedFiles = [...files]
        .sort((a, b) => {
          const depthA = a.path.split('/').length;
          const depthB = b.path.split('/').length;
          return depthA - depthB || a.path.localeCompare(b.path);
        })
        .slice(0, maxFiles);
      // Surface the cap-fire to operators: a structured warn log + a meter
      // counter. Without these the cap is silent — operators see "search
      // missing some files" with no signal pointing at `OK_SEARCH_MAX_ENTRIES`.
      // One emission per corpus rebuild (the cache then absorbs subsequent
      // queries until the fingerprint changes).
      getLogger('search').warn(
        {
          dropped: files.length - admittedFiles.length,
          retained: admittedFiles.length,
          limit: maxFiles,
        },
        '[search] corpus name-only file tier truncated at OK_SEARCH_MAX_ENTRIES',
      );
      searchCorpusTruncatedCounter().add(1);
    }
    // Folders are synthesized from ALL admitted paths (markdown pages + name-only
    // file entries), so a folder containing only non-markdown files is still a
    // search result and a partial-path query (e.g. `server/src`) resolves even
    // when the folder holds no markdown.
    const documents = [
      ...pages,
      ...buildSkillSearchDocuments(),
      ...admittedFiles,
      ...deriveFolderSearchDocuments([...pages, ...admittedFiles]),
    ];
    return { documents, truncated };
  }

  // Stat-only skill fingerprint (name + mtime + size per project skill). A
  // named helper, not a local `const`, so the getAllFilesIndex caller-coverage
  // meta-test attributes the call in `workspaceSearchFingerprint` to that
  // allowlisted function rather than to an intermediate binding.
  function skillStatFingerprint(): string {
    return enumerateProjectSkillStats()
      .map((s) => `${s.name} ${s.mtimeMs} ${s.size}`)
      .join('');
  }

  function workspaceSearchFingerprint(): string {
    // Skills are tree-excluded from the file index, so neither the generation
    // counter nor getAllFilesIndex reflects a skill add/edit/remove. Fold the
    // stat-only skill fingerprint into BOTH paths so the corpus rebuilds on a
    // skill change (no content read on the per-search fingerprint path).
    // Fast path: the watcher's monotonic generation counter bumps on every
    // file-index mutation (the same counter that memoizes the markdown-only
    // view), so a generation match proves the corpus is still valid in O(1).
    if (getFileIndexGeneration) {
      return `gen:${getFileIndexGeneration()}|skills${skillStatFingerprint()}`;
    }
    // Fallback for harnesses that wire only the index accessors. Admission
    // predicate MUST match `buildWorkspaceSearchDocumentsFromIndex` so a
    // change to a now-searchable dot-path busts the corpus cache.
    return `${[...getAllFilesIndex()]
      .filter(([docName]) => !isSystemDoc(docName) && !isConfigDoc(docName))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        // Shares `entrySearchKey` with the page-doc cache so the two never drift.
        ([docName, entry]) => `${docName}\0${entrySearchKey(entry)}`,
      )
      .join('')}|skills${skillStatFingerprint()}`;
  }

  // Cold-start search readiness. While the boot index seed is still walking the
  // content dir, `/api/search` must not block on it nor return a false-empty
  // result: an agent (MCP `search`) or any consumer hitting search right after
  // `ok start` would otherwise get zero hits that read as complete. We answer
  // fast with `ready: false` instead and let the caller retry. The command
  // palette gates its own fetch on the page-list cold-load signal, so this
  // primarily protects non-UI consumers and is defense-in-depth for the UI.
  //
  // `bootIndexReady` mirrors the same boot gate `handleDocumentList` awaits: an
  // absent gate (test harnesses) is ready immediately, and a rejected gate still
  // flips ready (logged, like the sibling document-list gate) so a degraded boot
  // serves whatever index exists rather than warming forever.
  let bootIndexReady = ready === undefined;
  ready?.then(
    () => {
      bootIndexReady = true;
    },
    (err: unknown) => {
      bootIndexReady = true;
      log.warn(
        { err, handler: 'search' },
        '[api] ready gate rejected — search serves the partial index',
      );
    },
  );

  // Warming = the boot seed has not finished. Once it has, search awaits the
  // corpus build and returns results as before (the lazy first build is fast and
  // prewarmed; a slow first build on a very large workspace is the documented
  // residual). Scoping warming to the seed window keeps steady-state behavior —
  // and every consumer that does not pass a boot gate — unchanged.
  function isSearchCorpusWarming(): boolean {
    return !bootIndexReady;
  }

  async function getWorkspaceSearchCorpus(): Promise<{
    corpus: WorkspaceSearchCorpus;
    truncated: boolean;
  }> {
    const cacheKey = `${contentDir} ${projectDir ?? ''}`;
    const fingerprint = workspaceSearchFingerprint();
    const workspaceSearchCache = workspaceSearchCaches.get(cacheKey);
    if (workspaceSearchCache?.fingerprint === fingerprint && workspaceSearchCache.corpus) {
      return {
        corpus: workspaceSearchCache.corpus,
        truncated: workspaceSearchCache.truncated ?? false,
      };
    }
    if (workspaceSearchCache?.fingerprint === fingerprint && workspaceSearchCache.pending) {
      return workspaceSearchCache.pending;
    }

    const pending = buildWorkspaceSearchDocumentsFromIndex().then(({ documents, truncated }) => ({
      corpus: createWorkspaceSearchCorpus(documents),
      truncated,
    }));
    workspaceSearchCaches.set(cacheKey, { fingerprint, pending });
    try {
      const result = await pending;
      if (workspaceSearchCaches.get(cacheKey)?.pending === pending) {
        workspaceSearchCaches.set(cacheKey, {
          fingerprint,
          corpus: result.corpus,
          truncated: result.truncated,
        });
      }
      return result;
    } catch (err) {
      if (workspaceSearchCaches.get(cacheKey)?.pending === pending) {
        workspaceSearchCaches.delete(cacheKey);
      }
      throw err;
    }
  }

  function prewarmWorkspaceSearchCache(): void {
    if (process.env.NODE_ENV === 'test') return;
    for (const delayMs of [0, 1000, 3000]) {
      setTimeout(() => {
        void getWorkspaceSearchCorpus().catch((err) => {
          console.warn('[search] Failed to prewarm workspace search cache:', err);
        });
      }, delayMs);
    }
  }

  prewarmWorkspaceSearchCache();

  async function handleSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      return handleSearchGet(req, res);
    }
    if (req.method === 'POST') {
      return handleSearchPost(req, res);
    }
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'search',
      extraHeaders: { Allow: 'GET, POST' },
    });
  }

  const handleSearchGet = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const limit = url.searchParams.get('limit');
      const query = url.searchParams.get('query') ?? '';
      const intent = parseSearchIntent(url.searchParams.get('intent'));
      const ranking = parseSearchRanking(url.searchParams.get('ranking'));
      const scopes = parseSearchScopes(
        url.searchParams.get('scope') ?? url.searchParams.get('scopes'),
      );
      const semanticParam = parseSemanticParam(url.searchParams.get('semantic'));
      const source = parseSearchSource(url.searchParams.get('source'));
      const limitNum = limit === null ? undefined : Number(limit);

      if (query.length > 200) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'Query is too long (max 200 chars).',
          { handler: 'search-get' },
        );
        return;
      }
      try {
        const body = await buildSearchResponse({
          query,
          intent,
          ranking,
          scopes,
          limit: limitNum,
          semanticParam,
          source,
        });
        successResponse(res, 200, SearchSuccessSchema, body, { handler: 'search-get' });
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to search workspace.',
          { handler: 'search-get', cause: e },
        );
      }
    },
    { handler: 'search-get', method: 'GET', skipBodyParse: true },
  );

  const handleSearchPost = withValidation(
    SearchRequestSchema,
    async (_req, res, body) => {
      const query = typeof body.query === 'string' ? body.query : '';
      const intent = parseSearchIntent(body.intent);
      const ranking = parseSearchRanking(body.ranking);
      const scopes = parseSearchScopes(body.scopes ?? body.scope);
      const limit = typeof body.limit === 'number' ? body.limit : undefined;
      const semanticParam = parseSemanticParam(body.semantic);
      const source = parseSearchSource(body.source);

      if (query.length > 200) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'Query is too long (max 200 chars).',
          { handler: 'search-post' },
        );
        return;
      }
      try {
        const responseBody = await buildSearchResponse({
          query,
          intent,
          ranking,
          scopes,
          limit,
          semanticParam,
          source,
        });
        successResponse(res, 200, SearchSuccessSchema, responseBody, { handler: 'search-post' });
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to search workspace.',
          { handler: 'search-post', cause: e },
        );
      }
    },
    { handler: 'search-post', method: 'POST' },
  );

  const handleSkillInstallState = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        const snapshot = await readSkillInstallStateSnapshot(homedir());
        successResponse(
          res,
          200,
          SkillInstallStateSuccessSchema,
          { ...snapshot },
          {
            handler: 'skill-install-state',
            extraHeaders: { 'Cache-Control': 'no-store' },
          },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read skill install state.',
          { handler: 'skill-install-state', cause: e },
        );
      }
    },
    {
      handler: 'skill-install-state',
      method: 'GET',
      skipBodyParse: true,
      preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: 'skill-install-state' }),
    },
  );

  async function handleHandoffDispatchRoute(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Loopback-only gate — spawns binaries on the user's machine. Same model
    // as `/api/spawn-cursor` and `/api/installed-agents`. The handler also
    // enforces app-name allowlist + URL scheme matching + cursor path
    // containment as defense-in-depth.
    if (!checkLocalOpSecurity(req, res, { handler: 'handoff' })) return;
    try {
      await handleHandoffDispatch(req, res, {
        contentDir,
        platform: process.platform,
        // Share the same cached scheme probe `/api/installed-agents` uses so
        // the Windows/Linux dispatch availability gate agrees with the
        // dropdown's render gate (and reuses its 60s TTL — the row the user
        // just saw enabled decides the click). Unused on macOS.
        isSchemeRegistered: installedAgentsCache.probeWithCache,
      });
    } catch (e) {
      if (!res.headersSent) {
        log.error({ err: e }, '[handoff] route wrapper failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'handoff',
          cause: e,
        });
      }
    }
  }

  async function handleSpawnCursorRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Same loopback + DNS-rebinding gate as `/api/installed-agents` — this
    // endpoint spawns a binary on the user's machine, so confining callers
    // to same-origin loopback is load-bearing. Path containment + hardcoded
    // `cursor` binary + `shell:false` argv-array enforce the rest of the
    // security model inside `handleSpawnCursor`. See the file-level comment
    // in `./spawn-cursor-api.ts` for the full threat model.
    // `checkLocalOpSecurity` itself emits RFC 9457 problem+json on rejection.
    if (!checkLocalOpSecurity(req, res, { handler: 'spawn-cursor' })) return;
    try {
      await handleSpawnCursor(req, res, {
        contentDir,
        platform: process.platform,
      });
    } catch (e) {
      // Defensive: `handleSpawnCursor` emits RFC 9457 problem+json for every
      // expected failure mode internally. This catches truly unexpected
      // throws (e.g., a `resolveCursorBinary` injection that throws
      // synchronously) so the client still receives a typed contract
      // response instead of a hung connection. Mirrors `handleInstalledAgentsRoute`.
      if (!res.headersSent) {
        log.error({ err: e }, '[spawn-cursor] route wrapper failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'spawn-cursor',
          cause: e,
        });
      }
    }
  }

  /**
   * `POST /api/share/construct-url` — read the project's local git state and
   * emit a marketing-safe share URL (`https://openknowledge.ai/d/<base64url>`)
   * pinned to HEAD branch + the focused doc. Read-only against the working
   * tree: no commits, no pushes, no fetches, no `git ls-remote`.
   * Branch-existence is checked locally against `refs/remotes/origin/<branch>`;
   * the false-negative window (last fetch ran before the push) is acceptable;
   * the toast prompts the user to
   * push, the retry succeeds.
   *
   * Returns HTTP 200 with `{ok: false, error: code}` for the five business-
   * logic failures (no-remote, detached-head, branch-not-on-origin,
   * non-github-remote, invalid-path) — DELIBERATE departure from RFC 9457
   * for these branches. The Share UI maps each code to a per-toast string;
   * routing through 4xx would conflate share-flow outcomes with transport
   * errors the client retries differently. Transport-class failures
   * (loopback gate, payload-too-large, body-parse) still emit RFC 9457 via
   * `errorResponse`.
   */
  const handleShareConstructUrl = withValidation(
    ShareConstructUrlRequestSchema,
    async (_req, res, body) => {
      try {
        if (!projectDir) {
          emitShareConstructUrlLog('no-remote', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'no-remote' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        // Path validation is kind-specific: doc paths always name a file
        // (non-empty); folder paths may target the content root (empty).
        const sharePath = body.kind === 'doc' ? body.docPath : body.folderPath;
        if (!isValidSharePath(sharePath, body.kind)) {
          emitShareConstructUrlLog('invalid-path', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'invalid-path' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        const branch = readGitHeadBranch(projectDir);
        if (branch === null) {
          // Two upstream causes ride this branch: (a) detached HEAD — the
          // sender must check out a branch; (b) no `.git/HEAD` at all (not a
          // git repo) — also caught downstream by `readOriginGitHubRepo`
          // returning `no-remote`. Disambiguate via the origin lookup so the
          // toast says the right thing.
          const originPeek = readOriginGitHubRepo(projectDir);
          if (originPeek.kind === 'no-remote') {
            emitShareConstructUrlLog('no-remote', { kind: body.kind });
            successResponse(
              res,
              200,
              ShareConstructUrlResponseSchema,
              { ok: false, error: 'no-remote' },
              { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
            );
            return;
          }
          emitShareConstructUrlLog('detached-head', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'detached-head' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        const origin = readOriginGitHubRepo(projectDir);
        if (origin.kind === 'no-remote') {
          emitShareConstructUrlLog('no-remote', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'no-remote' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        // `construct-url.ts` builds github.com-only links, so GHES origins
        // must keep failing this gate until the builders take a host.
        if (origin.kind === 'non-github' || origin.host !== 'github.com') {
          emitShareConstructUrlLog('non-github-remote', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'non-github-remote' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        const branchExists = branchExistsOnOrigin(projectDir, branch);
        if (!branchExists) {
          emitShareConstructUrlLog('branch-not-on-origin', {
            branchExists: false,
            kind: body.kind,
          });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'branch-not-on-origin', branch },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        // content.dir relative to the repo root. `''` when `content.dir === '.'`
        // (the dominant case). `null` (distinct from `''`) means contentDir
        // escapes projectDir — a project misconfiguration that breaks the
        // content-root invariant; fail loud via the outer catch (→ 500) rather
        // than collapsing to `''`, which would silently mint a share link
        // pointing at the repo root instead of the (broken) content dir.
        const contentRel = toGitRelativePath(projectDir, contentDir);
        if (contentRel === null) {
          throw new Error('content dir is not contained within the project dir');
        }
        // Known limitation: when `content.dir !== '.'`, a NON-root doc/folder
        // share URL omits the content.dir prefix, so the raw github.com link
        // points one level too shallow. A correct fix needs receiver-side
        // content.dir resolution — the in-app receive nav is content-relative
        // and lands correctly, so prefixing the URL here would double-count
        // against it. Until that lands, warn so the mis-point is discoverable
        // in ops rather than silent. The dominant `content.dir === '.'` case
        // (contentRel === '') is fully correct.
        const sharingNonRootTarget =
          body.kind === 'doc' ? body.docPath !== '' : body.folderPath !== '';
        if (contentRel !== '' && sharingNonRootTarget) {
          getLogger('share').warn(
            { action: 'construct-url', kind: body.kind },
            '[share] content.dir != "." — non-root share URL omits the content.dir prefix; the github.com link may point at the wrong subtree. In-app receive navigation is content-relative and lands correctly.',
          );
        }
        let sharedUrl: string;
        if (body.kind === 'doc') {
          sharedUrl = buildGitHubBlobUrl(origin.owner, origin.repo, branch, body.docPath);
        } else {
          // Folder ROOT (empty folderPath) maps to the content dir:
          // `tree/<branch>/<content.dir>`, degenerating to `tree/<branch>`
          // when `content.dir === '.'` (contentRel is '' then). Non-root folder
          // paths pass straight through.
          const treePath = body.folderPath === '' ? contentRel : body.folderPath;
          sharedUrl = buildGitHubTreeUrl(origin.owner, origin.repo, branch, treePath);
        }
        const shareUrl = `${SHARE_BASE_URL}${encodeShareUrl(sharedUrl)}`;
        // Freshness probes the repo-relative path of the shared target: it
        // lives under content.dir, so join contentRel with the content-relative
        // share path. For the dominant content.dir === '.' case contentRel is
        // '' and this is just sharePath; an empty result is the content root.
        const freshnessPath =
          contentRel === ''
            ? sharePath
            : sharePath === ''
              ? contentRel
              : `${contentRel}/${sharePath}`;
        const freshness = await computeShareFreshness(projectDir, branch, freshnessPath, body.kind);
        emitShareConstructUrlLog('ok', { branchExists: true, kind: body.kind, freshness });
        successResponse(
          res,
          200,
          ShareConstructUrlResponseSchema,
          { ok: true, shareUrl, sharedUrl, branch, freshness },
          { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
        );
      } catch (err) {
        // Defensive: every dependency (fs reads, regex, encode) is bounded,
        // but a future change might add a throwing branch and the structured
        // 200 contract above would otherwise leak the throw as an
        // unhandled-rejection 500. Generic title — raw `err.message` could
        // include FS paths.
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_CONSTRUCT_URL_HANDLER_TAG,
          cause: err,
        });
      }
    },
    {
      handler: SHARE_CONSTRUCT_URL_HANDLER_TAG,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG }),
    },
  );

  /**
   * `GET /api/git/branch-info?branch=<targetBranch>&path=<path>` — batched
   * view of git state for the share-receive branch-switch dialog:
   *   - `currentBranch` / `currentHeadSha` / `detached` — HEAD identity
   *   - `shareTargetExists` — `git cat-file -e <ref>:<path>` against the
   *     current ref (HEAD when detached)
   *   - `dirtyConflicts` — `dirtyFilesOverlapWith(projectDir, targetBranch)`
   *   - `branchIsLocal` — `git rev-parse --verify refs/heads/<targetBranch>`
   *
   * All four probes run in parallel via `Promise.all` to stay under the
   * P99 < 500ms NFR. Read-only — does NOT acquire `withParentLock` so
   * concurrent sync-engine writes don't serialize behind the dialog
   * probe.
   */
  const handleBranchInfo = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        if (!projectDir) {
          errorResponse(
            res,
            500,
            'urn:ok:error:internal-server-error',
            'projectDir is not configured for this server.',
            { handler: BRANCH_INFO_HANDLER_TAG },
          );
          return;
        }
        const url = new URL(req.url ?? '', 'http://localhost');
        const branch = url.searchParams.get('branch');
        const path = url.searchParams.get('path');
        // `kind` defaults to 'doc' when absent — keeps the existing
        // branch-info callers (which omit it) green until later stories
        // thread it through the share-receive dialog.
        const kindParam = url.searchParams.get('kind');
        const kind: 'doc' | 'folder' = kindParam === 'folder' ? 'folder' : 'doc';
        if (!isValidBranchName(branch)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'branch query param missing or malformed.',
            { handler: BRANCH_INFO_HANDLER_TAG },
          );
          return;
        }
        if (!isValidBranchInfoPath(path, kind)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'path query param missing or malformed.',
            { handler: BRANCH_INFO_HANDLER_TAG },
          );
          return;
        }
        const info = await computeBranchInfo(projectDir, branch, path, kind);
        successResponse(res, 200, BranchInfoResponseSchema, info, {
          handler: BRANCH_INFO_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: BRANCH_INFO_HANDLER_TAG,
          cause: err,
        });
      }
    },
    {
      handler: BRANCH_INFO_HANDLER_TAG,
      method: 'GET',
      skipBodyParse: true,
    },
  );

  /**
   * `POST /api/share/target-status` — receive-side verdict for a share link
   * whose target is missing on the receiver's current ref. Runs a targeted
   * `git fetch origin <branch>` (authenticated by the user's ambient git
   * credential helper, same as checkout's fetch; no explicit token injection)
   * bounded by a timeout, then classifies the miss from git's rename detection:
   * on-origin (the local ref was stale) / renamed (+ a new path verified to
   * resolve at the origin ref) / deleted / never-on-branch / unknown (fetch
   * failed). Fail-open: any error returns `unknown`, and the caller falls back
   * to today's guidance.
   *
   * Updates only remote-tracking refs, no CRDT mutation — so the
   * attribution-sweep meta-test exempts it (see EXEMPT_HANDLERS).
   */
  const handleShareTargetStatus = withValidation(
    ShareTargetStatusRequestSchema,
    async (_req, res, body) => {
      try {
        if (!projectDir) {
          errorResponse(
            res,
            500,
            'urn:ok:error:internal-server-error',
            'projectDir is not configured for this server.',
            { handler: SHARE_TARGET_STATUS_HANDLER_TAG },
          );
          return;
        }
        // Validate the path shape before it reaches git's `<ref>:<path>`
        // ref-spec, mirroring the sibling share handlers (construct-url's
        // `isValidSharePath`, branch-info's `isValidBranchInfoPath`) —
        // precedent #55 content-scope predicate symmetry. Kind-aware: an empty
        // path is the folder-root sentinel, invalid for a doc; `..`, `.git`,
        // control chars, and backslashes are rejected so a malformed path can't
        // reach git and degrade the verdict classification.
        if (!isValidBranchInfoPath(body.path, body.kind)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'path is missing or malformed.', {
            handler: SHARE_TARGET_STATUS_HANDLER_TAG,
          });
          return;
        }
        // The target lives under content.dir; map the content-relative request
        // path to the repo-relative path git reads (same join as construct-url;
        // '' for the dominant content.dir === '.' case).
        const contentRel = toGitRelativePath(projectDir, contentDir);
        if (contentRel === null) {
          throw new Error('content dir is not contained within the project dir');
        }
        const gitPath =
          contentRel === ''
            ? body.path
            : body.path === ''
              ? contentRel
              : `${contentRel}/${body.path}`;
        const status = await computeShareTargetStatus(projectDir, body.branch, gitPath, body.kind);
        successResponse(res, 200, ShareTargetStatusResponseSchema, status, {
          handler: SHARE_TARGET_STATUS_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_TARGET_STATUS_HANDLER_TAG,
          cause: err,
        });
      }
    },
    {
      handler: SHARE_TARGET_STATUS_HANDLER_TAG,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_TARGET_STATUS_HANDLER_TAG }),
    },
  );

  /**
   * `POST /api/git/checkout` — share-receive branch-switch executor.
   *
   * Wrapped in `withParentLock` so checkout serializes against the
   * sync-engine's parent-git writes (precedent: every other parent-git
   * write goes through this primitive). The branch-info endpoint is
   * read-only and lock-free; checkout is the matching writer.
   *
   * Identity is threaded through `extractActorIdentity` for observability
   * only — checkout is a git-level operation with no CRDT mutation. The
   * attribution-sweep meta-test exempts this handler explicitly.
   *
   * HEAD watcher is NOT coupled to this endpoint. The 200 response means
   * `git checkout` completed; the CRDT transition (Y.Docs reset + CC1
   * `branch-switched` broadcast) runs independently when the HEAD
   * watcher's `onBatchBegin`/`onBatchEnd` cycle fires.
   */
  const handleCheckout = withValidation(
    CheckoutRequestSchema,
    async (_req, res, body) => {
      const bodyObj = body as unknown as Record<string, unknown>;
      const actor = extractActorIdentity(bodyObj, getPrincipal);
      if (actor.kind === 'invalid-summary') {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
          handler: CHECKOUT_HANDLER_TAG,
        });
        return;
      }

      if (!projectDir) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'projectDir is not configured for this server.',
          { handler: CHECKOUT_HANDLER_TAG },
        );
        return;
      }

      try {
        const outcome = await withParentLock(() =>
          runCheckoutFlow(projectDir, body.branch, { fastForward: body.fastForward === true }),
        );
        successResponse(res, 200, CheckoutResponseSchema, outcome, {
          handler: CHECKOUT_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: CHECKOUT_HANDLER_TAG,
          cause: err,
        });
      }
    },
    {
      handler: CHECKOUT_HANDLER_TAG,
      method: 'POST',
    },
  );

  /**
   * Spawn the share-flow CLI subcommand once, with a bounded timeout, and
   * collect its stdout. Returns the captured text + exit code. Used by all
   * three publish handlers; the shape mirrors `handleLocalOpAuthStatus`'s
   * inline spawn so the route-shape meta-tests scan one consistent pattern.
   *
   * stderr is piped + collected; on non-zero exit, a redacted prefix is
   * logged via `console.warn('[share] subprocess ...')` so production
   * failures (git binary missing, keychain denied, Octokit auth error)
   * leave a diagnostic trail. Credential URLs of the form
   * `x-access-token:<token>@github.com` get the token replaced with `***`
   * before logging — the CLI uses inline-token push URLs and a partial git
   * error could otherwise leak the PAT.
   *
   * Throws on spawn-failure / timeout — the handlers map to `errorResponse`.
   */
  async function spawnShareSubprocess(
    args: readonly string[],
  ): Promise<{ stdout: string; code: number | null }> {
    const [cmd, ...baseArgs] = localOpCliArgs;
    const spawnArgs = [...baseArgs, ...args];
    return await new Promise<{ stdout: string; code: number | null }>((resolveSpawn, reject) => {
      const child = spawn(
        cmd,
        spawnArgs,
        withHiddenWindowsConsole({
          ...LOCAL_OP_PIPE_STDIO_OPTIONS,
          env: { ...process.env },
        }),
      );
      let timedOut = false;
      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, SHARE_PUBLISH_TIMEOUT_MS);
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.on('close', (code) => {
        clearTimeout(killTimer);
        if (timedOut) {
          reject(new Error(`share subprocess timed out after ${SHARE_PUBLISH_TIMEOUT_MS}ms`));
          return;
        }
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString('utf-8');
          const redacted = redactShareSubprocessStderr(stderr).slice(0, 500);
          console.warn(`[share] subprocess exited code=${code} stderr=${redacted}`);
        }
        resolveSpawn({ stdout, code });
      });
      child.on('error', (err) => {
        clearTimeout(killTimer);
        reject(err);
      });
    });
  }

  /**
   * GET /api/share/publish/owners — list GitHub owners the user can host a
   * new repo under (owner eligibility). Spawns `open-knowledge share owners --json` and
   * returns one of:
   *   { ok: true, owners: [...] }
   *   { ok: false, error: 'auth-required' | 'network' }
   *
   * The owners endpoint is read-only and idempotent; the localOpGuard slot
   * is shared with the wider publish flow so concurrent owner-list +
   * publish-create can't race against the same OAuth flow.
   */
  const handleSharePublishOwners = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      if (!localOpGuard.tryAcquire(SHARE_PUBLISH_OWNERS_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'A share owners operation is already in progress.',
          { handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        const { stdout } = await spawnShareSubprocess(['share', 'owners', '--json']);
        const event = pickTerminalJsonLine(stdout);
        const body = parseOwnersEvent(event);
        emitSharePublishLog(
          'owners-list',
          body.ok ? 'ok' : body.error,
          body.ok ? { count: body.owners.length } : undefined,
        );
        successResponse(res, 200, SharePublishOwnersResponseSchema, body, {
          handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG,
          cause: err,
        });
      } finally {
        localOpGuard.release(SHARE_PUBLISH_OWNERS_KEY);
      }
    },
    {
      handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG,
      method: 'GET',
      skipBodyParse: true,
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG }),
    },
  );

  /**
   * GET /api/share/publish/name-check?owner=<o>&name=<n> — pre-flight a repo
   * name for conflict. Spawns `open-knowledge share name-check --json
   * --owner X --name Y` and returns one of:
   *   { ok: true, available: boolean }
   *   { ok: false, error: 'auth-required' | 'network' }
   *
   * Query-param validation runs server-side: missing/invalid `owner` or
   * `name` short-circuits to 400 invalid-request BEFORE the subprocess
   * spawns. This keeps a malformed wizard call from triggering a CLI
   * exec on every keypress.
   */
  const handleSharePublishNameCheck = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const owner = url.searchParams.get('owner') ?? '';
      const name = url.searchParams.get('name') ?? '';
      if (!isValidShareOwnerName(owner) || !isValidShareRepoName(name)) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'owner and name query params must be valid GitHub identifiers.',
          { handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG },
        );
        return;
      }
      if (!localOpGuard.tryAcquire(SHARE_PUBLISH_NAME_CHECK_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'A share name-check operation is already in progress.',
          { handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        const { stdout } = await spawnShareSubprocess([
          'share',
          'name-check',
          '--owner',
          owner,
          '--name',
          name,
          '--json',
        ]);
        const event = pickTerminalJsonLine(stdout);
        const body = parseNameCheckEvent(event);
        emitSharePublishLog(
          'name-check',
          body.ok ? 'ok' : body.error,
          body.ok ? { available: body.available } : undefined,
        );
        successResponse(res, 200, SharePublishNameCheckResponseSchema, body, {
          handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG,
          cause: err,
        });
      } finally {
        localOpGuard.release(SHARE_PUBLISH_NAME_CHECK_KEY);
      }
    },
    {
      handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG,
      method: 'GET',
      skipBodyParse: true,
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG }),
    },
  );

  /**
   * POST /api/share/publish — drive a no-remote project to first share (publish flow).
   * Spawns `open-knowledge share publish --json --owner ... --name ...
   * --visibility ... [--description ...] --project-dir <projectDir>` and
   * returns one of:
   *   { ok: true, ownerLogin, repoName, cloneUrl, defaultBranch }
   *   { ok: false, error: <SharePublishErrorCode> }
   *
   * `projectDir` is sourced from the server's own `ApiExtensionOptions` —
   * never trusted from the client — so a hostile caller can't redirect
   * the publish flow at another project on disk. Absent `projectDir`
   * surfaces as `no-project` (the editor's wizard knows what to do).
   */
  const handleSharePublish = withValidation(
    SharePublishRequestSchema,
    async (_req, res, body) => {
      if (!projectDir) {
        emitSharePublishLog('publish-create', 'no-project');
        successResponse(
          res,
          200,
          SharePublishResponseSchema,
          { ok: false, error: 'no-project' },
          { handler: SHARE_PUBLISH_HANDLER_TAG },
        );
        return;
      }
      if (!isValidShareOwnerName(body.owner) || !isValidShareRepoName(body.name)) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'owner and name must be valid GitHub identifiers.',
          { handler: SHARE_PUBLISH_HANDLER_TAG },
        );
        return;
      }
      if (!localOpGuard.tryAcquire(SHARE_PUBLISH_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'A share publish operation is already in progress.',
          { handler: SHARE_PUBLISH_HANDLER_TAG, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        const args = [
          'share',
          'publish',
          '--owner',
          body.owner,
          '--name',
          body.name,
          '--visibility',
          body.visibility,
          '--project-dir',
          projectDir,
          '--json',
        ];
        if (body.description !== undefined && body.description.length > 0) {
          args.push('--description', body.description);
        }
        const { stdout } = await spawnShareSubprocess(args);
        const event = pickTerminalJsonLine(stdout);
        const responseBody = parsePublishEvent(event);
        emitSharePublishLog('publish-create', responseBody.ok ? 'ok' : responseBody.error);
        if (responseBody.ok) {
          // A successful publish just added `origin` to the local repo (the
          // CLI's runPublishFlow addRemote step). The sync engine snapshotted
          // `hasRemote: false` at boot, so without a nudge the client keeps
          // routing the Share button into THIS wizard — and the republish
          // 422s on the repo that now exists. Fire-and-forget re-detection
          // flips `hasRemote` and signals CC1 'sync-status' so the next Share
          // click constructs the URL directly. Mirrors the set-identity
          // handler's refreshIdentity nudge.
          void getSyncEngine?.()
            ?.refreshRemote()
            .catch(() => {
              /* best-effort — status catches up on next poll / restart */
            });
        }
        successResponse(res, 200, SharePublishResponseSchema, responseBody, {
          handler: SHARE_PUBLISH_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_PUBLISH_HANDLER_TAG,
          cause: err,
        });
      } finally {
        localOpGuard.release(SHARE_PUBLISH_KEY);
      }
    },
    {
      handler: SHARE_PUBLISH_HANDLER_TAG,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_PUBLISH_HANDLER_TAG }),
    },
  );

  // Web/browser client-log ingest: the renderer forwarder POSTs batches of
  // captured `console` output here, written to the `renderer` pino subsystem
  // (→ the local-sink server log). Electron captures renderer console in its
  // main process instead. Writes no Y.Docs — exempt from attribution; gated by
  // `checkLocalOpSecurity` (loopback + Host + Origin) like the local-op routes.
  const handleClientLogs = withValidation(
    ClientLogsRequestSchema,
    async (_req, res, body) => {
      try {
        const logger = getLogger('renderer');
        for (const entry of body.entries) {
          // Per-entry guard: one entry that trips a pino serialization fault
          // must not drop the rest of the batch (the response still reports the
          // full accepted count — best-effort diagnostics ingest).
          try {
            // Spread client `fields` FIRST so the provenance markers below
            // always win (a client field must not clobber source/transport).
            logger[entry.level](
              {
                ...entry.fields,
                source: 'renderer-console',
                transport: 'web',
                ...(entry.sourceId ? { sourceId: entry.sourceId } : {}),
                ...(entry.lineNumber !== undefined ? { lineNumber: entry.lineNumber } : {}),
                ...(entry.ts !== undefined ? { clientTs: entry.ts } : {}),
              },
              entry.event ?? entry.message,
            );
          } catch {
            // Skip the malformed entry; continue the batch.
          }
        }
        successResponse(
          res,
          200,
          ClientLogsSuccessSchema,
          { accepted: body.entries.length },
          { handler: 'client-logs' },
        );
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'client-logs',
          cause: err,
        });
      }
    },
    {
      handler: 'client-logs',
      method: 'POST',
      preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: 'client-logs' }),
    },
  );

  // `/api/config` — collab-bootstrap payload for the React shell. In the
  // desktop / worktree-as-project-server topology this collab server is what
  // serves the SPA, so the shell fetches `/api/config` here rather than from a
  // separate `ok ui` front. The JSON shape matches `ok ui` (api-config.ts
  // consumes it identically): GET returns `{collabUrl, previewUrl, port}`. GET
  // stays open like the other read-only bootstrap endpoints
  // (document/pages/backlinks) — it carries no PII and only reflects the
  // client's own Host back to itself. `lockDir` is the project's
  // `.ok/local/` (the server-lock anchor); null when projectDir is unconfigured
  // (some test harnesses), leaving collabUrl bootstrap intact.
  const lockDir = projectDir ? getLocalDir(projectDir) : null;
  async function handleApiConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        // Same-origin collab WS: the shell loaded from this server, so
        // `ws://<host>/collab` reaches the same process the request arrived on.
        // Avoids the cross-port WS attempt sandboxed preview panes refuse. The
        // Host value is the client's own header reflected back to itself (the
        // Origin CORS gate in `onRequest` already refused cross-origin
        // browsers); it is not independently vetted here. A genuinely absent
        // Host yields a null collabUrl — a deliberate divergence from `ok ui`'s
        // `?? localhost:${resolvedPort}` fallback: this server has no single
        // canonical advertised port to substitute, and the client falls back
        // to a same-origin WS URL on a null. Node HTTP/1.1 always populates
        // Host, so the null path is a malformed-request floor, not a normal case.
        const host = req.headers.host;
        const collabUrl = host ? `ws://${host}/collab` : null;
        const port = lockDir ? (readServerLock(lockDir)?.port ?? 0) : 0;
        // `singleFile` tells the React shell to drop project chrome for an
        // ephemeral single-file session (`ok <file>`).
        const payload = { collabUrl, previewUrl: null, port, singleFile: ephemeral };
        // HEAD carries the same headers but no body; `successResponse` always
        // writes a body, so the no-body verb stays a manual emit.
        if (req.method === 'HEAD') {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.statusCode = 200;
          res.end();
          return;
        }
        successResponse(res, 200, ApiConfigSuccessSchema, payload, {
          handler: 'api-config',
          extraHeaders: { 'Cache-Control': 'no-store' },
        });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'api-config',
          cause: e,
        });
      }
      return;
    }
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'api-config',
      extraHeaders: { Allow: 'GET, HEAD' },
    });
  }

  // ───────────────────── Embeddings API key — Account control ─────────────────
  // Loopback + Origin gated (checkLocalOpSecurity) set/clear for the
  // machine-global embeddings key. The key travels renderer → loopback POST body
  // → the 0600 `~/.ok/secrets.yml` file directly (no subprocess, no keychain).
  // It is NEVER logged, spanned, or echoed back: the client body is the only
  // place it lives, the success body carries only `keyPresent`, and the error
  // detail is fixed-vocabulary (the cause — a writeFileSync failure — references
  // a path, not key bytes). Presence is read via GET /api/semantic-status
  // (`keyPresent`), so there's no GET here that could leak it.
  const HANDLE_LOCAL_OP_EMBEDDINGS_SET_KEY = 'local-op-embeddings-set-key';
  const HANDLE_LOCAL_OP_EMBEDDINGS_CLEAR_KEY = 'local-op-embeddings-clear-key';
  // One guard for both writes — set and clear hit the same secrets file via a
  // read-modify-write, so serializing them (and rejecting a same-key double-
  // click) avoids a lost update. Mirrors the other local-op handlers.
  const LOCAL_OP_EMBEDDINGS_GUARD = '/api/local-op/embeddings';

  const handleLocalOpEmbeddingsSetKey = withValidation(
    LocalOpEmbeddingsSetKeyRequestSchema,
    async (_req, res, body) => {
      if (!localOpGuard.tryAcquire(LOCAL_OP_EMBEDDINGS_GUARD)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'An embeddings key operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_EMBEDDINGS_SET_KEY, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        await new FileEmbeddingsBackend(embeddingsSecretsFile).set(body.key);
        successResponse(
          res,
          200,
          LocalOpEmbeddingsMutationSuccessSchema,
          { keyPresent: true },
          {
            handler: HANDLE_LOCAL_OP_EMBEDDINGS_SET_KEY,
            extraHeaders: { 'Cache-Control': 'no-store' },
          },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to store the key.', {
          handler: HANDLE_LOCAL_OP_EMBEDDINGS_SET_KEY,
          cause: e,
        });
      } finally {
        localOpGuard.release(LOCAL_OP_EMBEDDINGS_GUARD);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_EMBEDDINGS_SET_KEY,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_EMBEDDINGS_SET_KEY }),
    },
  );

  const handleLocalOpEmbeddingsClearKey = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      if (!localOpGuard.tryAcquire(LOCAL_OP_EMBEDDINGS_GUARD)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'An embeddings key operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_EMBEDDINGS_CLEAR_KEY, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        await clearEmbeddingsKeyFromAllBackends(embeddingsSecretsFile);
        successResponse(
          res,
          200,
          LocalOpEmbeddingsMutationSuccessSchema,
          { keyPresent: false },
          {
            handler: HANDLE_LOCAL_OP_EMBEDDINGS_CLEAR_KEY,
            extraHeaders: { 'Cache-Control': 'no-store' },
          },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to clear the key.', {
          handler: HANDLE_LOCAL_OP_EMBEDDINGS_CLEAR_KEY,
          cause: e,
        });
      } finally {
        localOpGuard.release(LOCAL_OP_EMBEDDINGS_GUARD);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_EMBEDDINGS_CLEAR_KEY,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_EMBEDDINGS_CLEAR_KEY }),
    },
  );

  /**
   * GET /api/semantic-status — read-only setup/coverage probe for the Settings
   * UI. Reports the project-local `enabled` flag, `keyPresent` / `keySource`
   * (an API key is resolvable — a free file/env read), `ready` (has the service
   * warmed yet), `capable` (warmed AND a usable key found), and indexed coverage
   * (embedded / total embeddable pages). Side-effect-free: NO embed, NO egress,
   * NO warm (warming reads the key and — under the legacy keychain backend —
   * could prompt). Returns an inert all-false/zero shape when the service is
   * absent (dev/plugin mode).
   */
  const handleSemanticStatus = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        // Report the service's CURRENT known state — do NOT call ensureWarm()
        // (warming hydrates the cache; a read-only status GET shouldn't). `ready`
        // stays false until the first real search warms it.
        let enabled = false;
        let ready = false;
        let capable = false;
        let embedded = 0;
        if (semanticSearch) {
          const status = semanticSearch.getStatus();
          enabled = status.enabled;
          ready = status.ready;
          capable = status.capable;
          embedded = status.embeddedCount;
        }
        // Key presence is a free, prompt-free read of the 0600 secrets file (+ env
        // override). The key itself is never returned — only `keyHint`, a redacted
        // last-4 tail (never the full key), so the UI can show WHICH key is set.
        // Lets the UI show "no key" the instant the toggle flips, without a warm.
        const storedKey = await new FileEmbeddingsBackend(embeddingsSecretsFile).get();
        const envKey = process.env[EMBEDDINGS_API_KEY_ENV] ?? null;
        const keySource: 'file' | 'env' | null = storedKey ? 'file' : envKey ? 'env' : null;
        const keyPresent = keySource !== null;
        // Last 4 chars only, and only when the key is long enough that those 4 are
        // a negligible fraction (real provider keys are 40+ chars); never the key.
        const resolvedKey = storedKey ?? envKey;
        const keyHint = resolvedKey && resolvedKey.length >= 8 ? resolvedKey.slice(-4) : null;
        // Total embeddable pages = the same filtered set the search corpus uses.
        let total = 0;
        for (const [docName] of getFileIndex()) {
          if (!isSystemDoc(docName) && !isConfigDoc(docName) && !isHiddenDocName(docName)) {
            total += 1;
          }
        }
        successResponse(
          res,
          200,
          SemanticIndexStatusSchema,
          { enabled, keyPresent, keySource, keyHint, ready, capable, embedded, total },
          { handler: 'semantic-status', extraHeaders: { 'Cache-Control': 'no-store' } },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'semantic-status',
          cause: e,
        });
      }
    },
    { handler: 'semantic-status', method: 'GET', skipBodyParse: true },
  );

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    '/api/config': handleApiConfig,
    '/api/asset': handleAsset,
    '/api/asset-text': handleAssetText,
    '/api/document': handleDocumentRead,
    '/api/documents': handleDocumentList,
    '/api/backlinks': handleBacklinks,
    '/api/backlink-counts': handleBacklinkCounts,
    '/api/forward-links': handleForwardLinks,
    '/api/link-graph': handleLinkGraph,
    '/api/dead-links': handleDeadLinks,
    '/api/orphans': handleOrphans,
    '/api/hubs': handleHubs,
    '/api/tags': handleTagsList,
    '/api/pages': handlePages,
    '/api/folder-config': handleFolderConfig,
    '/api/template': handleTemplate,
    '/api/templates': handleTemplatesList,
    '/api/skill': handleSkill,
    '/api/skill-file': handleSkillFile,
    '/api/skills': handleSkillsList,
    '/api/skills/management': handleSkillsManagement,
    '/api/skill/install': handleSkillInstall,
    '/api/skill/uninstall': handleSkillUninstall,
    '/api/skill/restore': handleSkillRestore,
    '/api/skill/update': handleSkillUpdate,
    '/api/skill-targets': handleSkillTargets,
    '/api/search': handleSearch,
    '/api/semantic-status': handleSemanticStatus,
    '/api/suggest-links': handleSuggestLinks,
    '/api/page-headings': handlePageHeadings,
    '/api/create-page': handleCreatePage,
    '/api/create-folder': handleCreateFolder,
    '/api/duplicate-path': handleDuplicatePath,
    '/api/rename-path': handleRenamePath,
    '/api/delete-path': handleDeletePath,
    '/api/trash/cleanup': handleTrashCleanup,
    '/api/upload': handleUploadAsset,
    '/api/agent-write': handleAgentWrite,
    '/api/agent-write-md': handleAgentWriteMd,
    '/api/frontmatter-patch': handleFrontmatterPatch,
    '/api/agent-patch': handleAgentPatch,
    '/api/agent-undo': handleAgentUndo,
    '/api/agent-activity': handleAgentActivity,
    '/api/agent-burst-diff': handleAgentBurstDiff,
    '/api/save-version': handleSaveVersion,
    '/api/history': handleHistory,
    '/api/rollback': handleRollback,
    '/api/metrics/reconciliation': handleMetricsReconciliation,
    '/api/metrics/parse-health': handleMetricsParseHealth,
    '/api/metrics/agent-presence': handleMetricsAgentPresence,
    '/api/__embed-detect': handleEmbedDetect,
    '/api/server-info': handleServerInfo,
    '/api/share/construct-url': handleShareConstructUrl,
    '/api/share/target-status': handleShareTargetStatus,
    '/api/git/branch-info': handleBranchInfo,
    '/api/git/checkout': handleCheckout,
    '/api/share/publish/owners': handleSharePublishOwners,
    '/api/share/publish/name-check': handleSharePublishNameCheck,
    '/api/share/publish': handleSharePublish,
    '/api/principal': handlePrincipal,
    '/api/rescue': handleRescueList,
    '/api/workspace': handleWorkspace,
    '/api/sync/status': handleSyncStatus,
    '/api/sync/trigger': handleSyncTrigger,
    '/api/sync/conflicts': handleSyncConflicts,
    '/api/sync/conflict-content': handleSyncConflictContent,
    '/api/sync/resolve-conflict': handleSyncResolveConflict,
    '/api/local-op/clone': handleLocalOpClone,
    '/api/local-op/ok-init': handleLocalOpOkInit,
    '/api/local-op/auth/login': handleLocalOpAuthLogin,
    '/api/local-op/auth/status': handleLocalOpAuthStatus,
    '/api/local-op/auth/repos': handleLocalOpAuthRepos,
    '/api/local-op/auth/signout': handleLocalOpAuthSignout,
    '/api/local-op/auth/set-identity': handleLocalOpAuthSetIdentity,
    '/api/local-op/embeddings/set-key': handleLocalOpEmbeddingsSetKey,
    '/api/local-op/embeddings/clear-key': handleLocalOpEmbeddingsClearKey,
    '/api/installed-agents': handleInstalledAgentsRoute,
    '/api/spawn-cursor': handleSpawnCursorRoute,
    '/api/handoff': handleHandoffDispatchRoute,
    '/api/install-skill': handleInstallSkill,
    '/api/skill/install-state': handleSkillInstallState,
    '/api/seed/plan': handleSeedPlan,
    '/api/seed/apply': handleSeedApply,
    '/api/seed/packs': handleSeedPacks,
    '/api/client-logs': handleClientLogs,
  };

  if (enableTestRoutes) {
    routes['/api/test-reset'] = handleTestReset;
    routes['/api/test-flush-git'] = handleTestFlushGit;
    routes['/api/test-rescan-backlinks'] = handleTestRescanBacklinks;
    routes['/api/test-rescan-files'] = handleTestRescanFiles;
  }

  // DNS-rebinding defense: routes that mutate local filesystem / CRDT /
  // vault state. A DNS-rebound cross-origin page could otherwise POST to
  // these endpoints and write to the user's content dir. Read-only
  // endpoints (document/pages/backlinks/…) stay accessible so the editor
  // UI can bootstrap against the collab server; mutations require a
  // loopback Host header. /api/workspace enforces this inline already.
  const MUTATING_ROUTES: ReadonlySet<string> = new Set([
    '/api/upload',
    '/api/create-page',
    '/api/create-folder',
    '/api/duplicate-path',
    '/api/rename-path',
    '/api/delete-path',
    '/api/trash/cleanup',
    '/api/agent-write',
    '/api/agent-write-md',
    '/api/frontmatter-patch',
    '/api/agent-patch',
    '/api/agent-undo',
    '/api/save-version',
    '/api/rollback',
    '/api/sync/trigger',
    '/api/sync/resolve-conflict',
    '/api/git/checkout',
    '/api/test-reset',
    '/api/test-flush-git',
    '/api/test-rescan-backlinks',
    '/api/test-rescan-files',
    '/api/install-skill',
    '/api/folder-config',
    '/api/template',
    '/api/skill',
    '/api/skill-file',
    '/api/skill/install',
    '/api/skill/uninstall',
    '/api/skill/restore',
    '/api/skill/update',
    '/api/skills/management',
    '/api/skill-targets',
    '/api/seed/apply',
    '/api/client-logs',
  ]);
  // Every `/api/local-op/*` endpoint mutates local filesystem state or
  // issues network requests on behalf of the user — clone/open/auth
  // flows all fit. Prefix-match so new local-op handlers are protected
  // by default.
  const STATE_MUTATING_PREFIXES: ReadonlyArray<string> = ['/api/local-op/'];

  return {
    priority: 100, // Higher priority — API routes run before static file serving
    async onRequest({ request, response }: { request: IncomingMessage; response: ServerResponse }) {
      const url = request.url?.split('?')[0];
      if (!url) return;

      // Per-request client-context observation for embed-detection spikes.
      // Pushed into a bounded in-process ring buffer drained by
      // /api/__embed-detect. Assumes loopback-only deployment — the consumer
      // endpoint enforces this. Multi-valued headers (rare) collapse to the
      // joined string Node provides by default for the headers we capture.
      const headerString = (name: string): string | undefined => {
        const value = request.headers[name];
        if (value === undefined) return undefined;
        return Array.isArray(value) ? value.join(', ') : value;
      };
      recordEmbedProbe({
        ts: Date.now(),
        url,
        method: request.method ?? '',
        ua: headerString('user-agent'),
        origin: headerString('origin'),
        referer: headerString('referer'),
        host: headerString('host'),
        remote: request.socket?.remoteAddress,
        secChUa: headerString('sec-ch-ua'),
        secChUaMobile: headerString('sec-ch-ua-mobile'),
        secChUaPlatform: headerString('sec-ch-ua-platform'),
        secFetchSite: headerString('sec-fetch-site'),
        secFetchDest: headerString('sec-fetch-dest'),
        secFetchMode: headerString('sec-fetch-mode'),
        secFetchUser: headerString('sec-fetch-user'),
      });

      // Origin-allowlist CORS for /api/*. Only loopback origins are accepted:
      // - No Origin header (same-origin browser tab, curl, CLI): passes through.
      // - Origin "null" (Electron packaged renderer, file:// per Fetch spec §4.3): allowed.
      // - http(s)://localhost[:port] / 127.x.x.x[:port] / [::1][:port]: allowed.
      // - Any other Origin: 403 — closes the CSRF door on unauthenticated mutating
      //   routes (/api/agent-write-md, /api/rollback, /api/manage/delete, etc.)
      //   without breaking the Electron renderer or local Vite dev servers.
      //
      // When an allowed Origin is present, it is reflected verbatim in ACAO (not
      // `*`) so the browser's preflight check passes while non-loopback origins are
      // still refused by the gate above. `Vary: Origin` prevents cache poisoning.
      //
      // Setting via `setHeader` (not `writeHead`) so handler responses that call
      // `writeHead(status, { ... })` inherit these headers. The typeof guard handles
      // unit tests that stub only `writeHead` + `end`.
      if (url.startsWith('/api/')) {
        const origin = request.headers.origin;
        if (origin !== undefined && !isAllowedApiOrigin(origin)) {
          // RFC 9457 problem+json. Tag the handler as `api-origin-gate` so
          // the `ok.api.error.count` counter distinguishes onRequest-level
          // CSRF rejections from per-handler emits. The cross-origin browser
          // can't read the body anyway (CORS strips it) but consistent wire
          // shape lets server-to-server callers + tests parse uniformly.
          errorResponse(response, 403, 'urn:ok:error:invalid-origin', 'Origin not allowed.', {
            handler: 'api-origin-gate',
          });
          return;
        }
        if (typeof response.setHeader === 'function') {
          if (origin !== undefined) {
            response.setHeader('Access-Control-Allow-Origin', origin);
            response.setHeader('Vary', 'Origin');
          }
          response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          // Content-Type/Authorization: standard request headers. traceparent/
          // tracestate/baggage: OTel W3C trace-context propagation from the
          // browser SDK. x-ok-client-*: the client→version metadata the renderer
          // stamps on every /api/* request (clientVersionHeaders) — omitting
          // these fails the preflight for the cross-origin renderer (dev Vite
          // origin / file:// packaged) before the real request fires.
          response.setHeader(
            'Access-Control-Allow-Headers',
            `Content-Type, Authorization, traceparent, tracestate, baggage, ${CLIENT_VERSION_HEADER.protocol}, ${CLIENT_VERSION_HEADER.runtime}, ${CLIENT_VERSION_HEADER.kind}`,
          );
        }
        // OPTIONS preflight — short-circuit with 204 + the headers above.
        if (request.method === 'OPTIONS') {
          response.writeHead(204);
          response.end();
          return;
        }
      }

      // DNS-rebinding defense for state-mutating endpoints. The
      // `isLoopbackAddress` TCP-peer check and `isAllowedWorkspaceHostHeader`
      // Host-header check together block the standard rebinding pattern
      // (attacker-owned hostname whose DNS resolves to 127.0.0.1 after an
      // initial attacker-serves-JS response — the TCP peer is loopback,
      // but the Host header names the attacker domain). The same mitigation
      // already gates `/api/workspace`; without it, a rebinding page could
      // POST /api/upload + /api/agent-write, mutating the local vault.
      //
      // Test-harness note: Node's production socket always has
      // `remoteAddress` set by the kernel; the only path that reaches
      // this check without a socket is a mocked `IncomingMessage` built
      // from `Readable.from(...)`. Those mocks bypass the HTTP listener
      // entirely and can't be reached by a real remote attacker, so a
      // missing socket is treated as test-context and skips the check.
      // The Host-header gate still fires (tests set `host: 'localhost'`),
      // so the protection remains meaningful for any production path.
      if (MUTATING_ROUTES.has(url) || STATE_MUTATING_PREFIXES.some((p) => url.startsWith(p))) {
        const peerAddress = request.socket?.remoteAddress;
        if (peerAddress !== undefined && !isLoopbackAddress(peerAddress)) {
          errorResponse(response, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
            handler: 'api-mutating-gate',
          });
          return;
        }
        if (!isAllowedWorkspaceHostHeader(request.headers.host)) {
          errorResponse(
            response,
            403,
            'urn:ok:error:host-not-allowed',
            'Host header not allowed.',
            { handler: 'api-mutating-gate' },
          );
          return;
        }
      }

      // No-project ephemeral single-file mode (`ok <file>`) sets contentDir to
      // the opened file's PARENT — often a user-data dir (~/Downloads,
      // ~/Documents). Several read routes (`/api/asset`, `/api/asset-text`,
      // `/api/document`) return bytes under contentDir bounded only by
      // `isWithinContentDir`, NOT by the single-file content scope (which is
      // enforced at the indexing/listing layer, not the byte-read path). So
      // without a host gate a DNS-rebound page could exfiltrate sibling files.
      // Apply the same loopback + workspace-host check the mutating gate uses to
      // EVERY `/api/*` request in ephemeral mode — one choke point, so future
      // read routes inherit it rather than each needing its own gate. Project /
      // desktop modes (`ephemeral` falsy) keep their prior origin-only posture
      // for reads (the user chose the served root there); this mirrors the
      // ephemeral-scoped content-asset gate in `mcp-mount.ts`, which covers the
      // non-`/api/` static-serve path.
      if (ephemeral && url.startsWith('/api/')) {
        const peerAddress = request.socket?.remoteAddress;
        if (peerAddress !== undefined && !isLoopbackAddress(peerAddress)) {
          errorResponse(response, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
            handler: 'api-ephemeral-gate',
          });
          return;
        }
        if (!isAllowedWorkspaceHostHeader(request.headers.host)) {
          errorResponse(
            response,
            403,
            'urn:ok:error:host-not-allowed',
            'Host header not allowed.',
            {
              handler: 'api-ephemeral-gate',
            },
          );
          return;
        }
      }

      // Only /api/* gets a server span. Non-API routes (static file serving,
      // Hocuspocus's own paths) fall through silently. (Route dispatch
      // happens inside the OTel active-span block below.)
      if (!url.startsWith('/api/')) return;

      // Extract incoming trace context (W3C traceparent header) so this server
      // span attaches as a child of the browser-initiated trace.
      const extractedCtx = propagation.extract(context.active(), request.headers);
      const method = request.method ?? 'GET';
      // Normalize route for low-cardinality metric labels. `:id` placeholders
      // replace dynamic segments; anything else collapses to the URL prefix.
      let routeTemplate = url;
      if (url.startsWith('/api/history/')) routeTemplate = '/api/history/:sha';
      else if (url.startsWith('/api/tags/')) routeTemplate = '/api/tags/:name';
      else if (!routes[url]) routeTemplate = '/api/*';

      const tracer = getTracer();
      const started = Date.now();
      await context.with(extractedCtx, () =>
        tracer.startActiveSpan(
          `HTTP ${method} ${routeTemplate}`,
          {
            kind: SpanKind.SERVER,
            attributes: {
              [ATTR_HTTP_REQUEST_METHOD]: method,
              [ATTR_HTTP_ROUTE]: routeTemplate,
              [ATTR_URL_PATH]: url,
              [ATTR_URL_SCHEME]: 'http',
              [ATTR_USER_AGENT_ORIGINAL]: request.headers['user-agent'] ?? '',
            },
          },
          async (span) => {
            try {
              // Static routes
              const handler = routes[url];
              let dispatched = false;
              if (handler) {
                dispatched = true;
                await handler(request, response);
              } else if (url.startsWith('/api/history/')) {
                const sha = decodeURIComponent(url.slice('/api/history/'.length));
                if (sha) {
                  dispatched = true;
                  await handleHistoryVersion(request, response, sha);
                }
              } else if (url.startsWith('/api/tags/')) {
                const rawName = url.slice('/api/tags/'.length);
                if (rawName) {
                  dispatched = true;
                  await handleTagsForName(request, response, rawName);
                }
              }

              // Defense-in-depth: unmatched `/api/*` routes (typos, removed
              // endpoints, empty `/api/rescue/` / `/api/history/` segments)
              // would otherwise fall through with no response body, leaving
              // Hocuspocus's `onRequest` machinery to either pass through to
              // static-file middleware or hang. Emit an explicit RFC 9457 404
              // so the dispatch surface is fully closed. Dispatch flag is
              // robust against test-mock `ServerResponse` shapes that don't
              // simulate `headersSent` (vs checking `response.headersSent`
              // directly, which would misfire on mocks after a handler
              // successfully wrote 200).
              if (!dispatched) {
                // `detail` echoes the actual requested URL (no information
                // leak — the client sent it). `routeTemplate` is bounded
                // to `/api/*` for unmatched routes and used only for
                // histogram labels / span attributes upstream — keeping
                // the two concerns separate so the wire-detail stays
                // actionable for debuggers without coupling to the
                // cardinality-bounded telemetry surface.
                errorResponse(response, 404, 'urn:ok:error:not-found', 'API endpoint not found.', {
                  handler: 'api-dispatch',
                  detail: `No handler for ${method} ${url}`,
                });
              }

              const status = response.statusCode;
              span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status);
              if (status >= 500) {
                span.setStatus({ code: SpanStatusCode.ERROR, message: `status ${status}` });
              }
            } catch (err) {
              span.recordException(err as Error);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: err instanceof Error ? err.message : String(err),
              });
              // Last-resort RFC 9457 envelope. Per-handler try/catch is the
              // primary error boundary, but a synchronous throw before any
              // response write would otherwise reach the client as a
              // connection reset (or Hocuspocus default error handling) —
              // not the typed application/problem+json envelope SDK
              // consumers parse. Guard on
              // `!headersSent && !writableEnded && !destroyed` so we
              // don't double-emit when the inner handler already wrote a
              // response or the socket was destroyed mid-handler — same
              // three-way guard `createStreamingErrorWriter` uses for
              // mid-stream emission. Handler tag is the matched route
              // template so telemetry attributes a 5xx surge to the
              // failing endpoint.
              if (!response.headersSent && !response.writableEnded && !response.destroyed) {
                errorResponse(
                  response,
                  500,
                  'urn:ok:error:internal-server-error',
                  'Internal server error.',
                  {
                    handler: routeTemplate,
                    cause: err,
                  },
                );
              }
              // Re-throw so Hocuspocus's onRequest extension chain logs the
              // exception via its built-in error machinery. The response is
              // already ended (either by errorResponse above or by an
              // earlier handler write), so Hocuspocus 4.x treats this as a
              // post-response observation, not a connection-level failure.
              // Verify this assumption holds when bumping Hocuspocus —
              // version-specific reaction to throws from onRequest is
              // framework-internal behavior.
              throw err;
            } finally {
              span.end();
              const durSec = (Date.now() - started) / 1000;
              httpDurationHist().record(durSec, {
                [ATTR_HTTP_REQUEST_METHOD]: method,
                [ATTR_HTTP_ROUTE]: routeTemplate,
                [ATTR_HTTP_RESPONSE_STATUS_CODE]: response.statusCode,
              });
            }
          },
        ),
      );
    },
  };
}
