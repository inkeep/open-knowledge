
import { spawn } from 'node:child_process';
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
import { fileTypeFromFile } from 'file-type';
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
import { clearArmedPaneTarget, readArmedPaneTarget } from './pane-target.ts';
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
import {
  branchExistsOnOrigin,
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
import { composeAndWriteRawBody, replaceRawBody } from './bridge-intake.ts';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import type { ResolveStrategy } from './conflict-storage.ts';
import type { ContentFilter } from './content-filter.ts';
import {
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

let _httpDurationHist: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
function httpDurationHist(): ReturnType<ReturnType<typeof getMeter>['createHistogram']> {
  _httpDurationHist ||= getMeter().createHistogram('http.server.request.duration', {
    description: 'HTTP server request duration in seconds',
    unit: 's',
  });
  return _httpDurationHist;
}

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
        'Count of agent-patch calls whose find string targets the frontmatter region. Measures incidence during the soft-deprecation window before agent-patch FM-intersecting calls are enforced as 400. Bounded label: result ∈ {rejected, pre_deprecation_passthrough}.',
    },
  );
  return _agentPatchFmTouchCounter;
}

function findLooksLikeFrontmatter(find: string): boolean {
  if (/(^|\n)---(\s|\n|$)/.test(find)) return true;
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

let _searchCorpusTruncatedCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null =
  null;
function searchCorpusTruncatedCounter(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
  _searchCorpusTruncatedCounter ||= getMeter().createCounter('ok.search.corpus_truncated_total', {
    description:
      'Count of search-corpus rebuilds where the name-only file tier hit OK_SEARCH_MAX_ENTRIES and dropped deepest-tail paths. One increment per truncated build; non-truncated builds do not increment.',
  });
  return _searchCorpusTruncatedCounter;
}

type DivergenceHandler = 'agent-write-md' | 'agent-patch' | 'rollback';

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

export function __resetRenameTelemetryForTesting(): void {
  _renameAttributionCounter = null;
}

export function resumeSyncOnAuthEvent(
  event: AuthEvent,
  getSyncEngine?: () => SyncEngine | null,
): void {
  if (event.type !== 'complete') return;
  void getSyncEngine?.()
    ?.notifyCredentialsChanged()
    .catch(() => {
    });
}

export const ROLLBACK_ORIGIN = {
  source: 'local' as const,
  skipStoreHooks: false,
  context: { origin: 'rollback-apply', paired: true },
} as const satisfies PairedWriteOrigin;

export const MANAGED_RENAME_ORIGIN = {
  source: 'local' as const,
  skipStoreHooks: false,
  context: { origin: 'managed-rename', paired: true },
} as const satisfies PairedWriteOrigin;

const log = getLogger('api');

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
  const normalized = contentRoot === '.' ? '' : contentRoot.replace(/^\.\//, '');
  const managed = managedArtifactTimelinePaths(docName);
  if (managed.managed && managed.versioned) {
    return { path: normalized ? `${normalized}/${managed.filePath}` : managed.filePath };
  }
  const ext = getDocExtension(docName);
  const path = normalized ? `${normalized}/${docName}${ext}` : `${docName}${ext}`;
  return { path };
}

const GENERIC_PASTE_NAMES = /^(image\.(png|jpe?g|gif|webp)|Clipboard.*|Untitled.*)$/i;

const SAFE_FILENAME_CHARS = /[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}.\-_ ]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — sanitize must strip control bytes.
const STRIP_ON_SIGHT = /[/\\\x00-\x1f\x7f]/g;

export function sanitizeFilename(name: string): string {
  let stripped = name.replace(STRIP_ON_SIGHT, '');
  stripped = stripped.replace(SAFE_FILENAME_CHARS, '_');

  stripped = stripped.replace(/_+/g, '_').replace(/\.{2,}/g, '.');

  stripped = stripped.replace(/^[._]+/, '');
  stripped = stripped.replace(/\.+$/, '');

  if (stripped === '') return 'upload';

  const MAX_BYTES = 255;
  const encoder = new TextEncoder();
  if (encoder.encode(stripped).length > MAX_BYTES) {
    const dotIdx = stripped.lastIndexOf('.');
    const ext = dotIdx >= 0 ? stripped.slice(dotIdx) : '';
    let stem = dotIdx >= 0 ? stripped.slice(0, dotIdx) : stripped;
    while (encoder.encode(stem + ext).length > MAX_BYTES && stem.length > 0) {
      stem = stem.slice(0, -1);
    }
    stripped = (stem || 'upload') + ext;
    if (encoder.encode(stripped).length > MAX_BYTES) stripped = 'upload';
  }

  return stripped;
}

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
    return resolve(resolvedContentDir, dirname(parentDocName), trimmed.slice(2));
  }
  return resolve(resolvedContentDir, trimmed);
}

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

const MAX_DEDUP_SCAN_CANDIDATES = 1000;

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
      candidateSha = await streamingHashFile(fullPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
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
  tempPath: string;
  sha: string;
  byteLength: number;
}

function readUploadBody(req: IncomingMessage, projectDir: string): Promise<UploadResult> {
  return new Promise((resolveP, reject) => {
    let bb: ReturnType<typeof busboy>;
    try {
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
    let tempPath: string | undefined;
    let pipelineError: unknown;
    let fileEventFired = false;


    const fail = (reason: UploadWriteReason, cause: unknown) => {
      if (settled) return;
      settled = true;
      if (tempPath) {
        try {
          unlinkSync(tempPath);
        } catch {
        }
      }
      reject(cause instanceof UploadWriteError ? cause : new UploadWriteError(reason, cause));
    };

    const classifyWriteError = classifyUploadErrno;

    bb.on('field', (name, val) => {
      if (name === 'parentDocName') parentDocName = val;
    });

    bb.on('file', (_fieldname, file, info) => {
      fileEventFired = true;
      filename = info.filename || 'upload';
      mimeType = info.mimeType || '';

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
            tempPath: path,
            sha: hasher.digest(),
            byteLength: hasher.byteLength(),
          });
        })
        .catch((err) => {
          pipelineError = err;
          const nodeErr = err as NodeJS.ErrnoException;
          fail(classifyWriteError(nodeErr), err);
        });
    });

    bb.on('error', (err) => {
      fail('urn:ok:error:malformed-upload', err);
    });

    bb.on('close', () => {
      if (settled || pipelineError) return;
      if (fileEventFired) return;
      settled = true;
      resolveP({
        filename: '',
        mimeType: '',
        parentDocName,
        tempPath: '',
        sha: '',
        byteLength: 0,
      });
    });

    req.on('close', () => {
      if (settled || pipelineError) return;
      if (!req.complete) {
        fail('urn:ok:error:malformed-upload', new Error('client disconnected'));
      }
    });

    req.pipe(bb);
  });
}

export function safeSubdir(baseDir: string, subdir: string): string {
  const resolved = resolve(baseDir, subdir);
  if (!isWithinDir(resolved, baseDir)) {
    throw new Error(`Invalid directory: ${subdir}`);
  }
  return resolved;
}

function synthesizeShowAllAssetExt(name: string): string {
  const ext = extname(name);
  if (ext) return ext.slice(1).toLowerCase();
  if (name.startsWith('.') && name.length > 1) return name.slice(1).toLowerCase();
  return 'file';
}

export const DEFAULT_SHOWALL_MAX_ENTRIES = 50_000;
export function getShowAllMaxEntries(): number {
  const raw = process.env.OK_SHOWALL_MAX_ENTRIES;
  if (raw === undefined) return DEFAULT_SHOWALL_MAX_ENTRIES;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SHOWALL_MAX_ENTRIES;
}

export const DEFAULT_SEARCH_MAX_ENTRIES = 50_000;
export function getSearchMaxEntries(): number {
  const raw = process.env.OK_SEARCH_MAX_ENTRIES;
  if (raw === undefined) return DEFAULT_SEARCH_MAX_ENTRIES;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SEARCH_MAX_ENTRIES;
}

let showAllWalkInvocations = 0;
let showAllWalkAborts = 0;
export function __getShowAllWalkStatsForTesting(): { invocations: number; aborts: number } {
  return { invocations: showAllWalkInvocations, aborts: showAllWalkAborts };
}
export function __resetShowAllWalkStatsForTesting(): void {
  showAllWalkInvocations = 0;
  showAllWalkAborts = 0;
}

function showAllWantsNdjson(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('application/x-ndjson');
}

export interface StreamShowAllOpts {
  contentDir: string;
  contentFilter: ContentFilter;
  dirFilter: string | null;
  getDocExtension: (docName: string) => string;
  maxEntries: number;
  signal?: AbortSignal;
  maxDepth?: number;
}

export interface WalkShowAllOpts extends StreamShowAllOpts {
  documents: DocumentListEntry[];
}

export async function* streamShowAllEntries(
  opts: StreamShowAllOpts,
): AsyncGenerator<DocumentListEntry, { truncated: boolean }, void> {
  const { contentDir, contentFilter, dirFilter, getDocExtension, maxEntries, signal } = opts;
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  showAllWalkInvocations += 1;
  let emitted = 0;
  let truncated = false;
  let aborted = false;

  const passesDirFilter = (rel: string): boolean => {
    if (!dirFilter) return true;
    return rel === dirFilter || rel.startsWith(`${dirFilter}/`);
  };

  let contentDirCanonical: string;
  try {
    contentDirCanonical = await realpath(contentDir);
  } catch {
    contentDirCanonical = contentDir;
  }
  const isInsideContentDir = (resolved: string): boolean =>
    isWithinDir(resolved, contentDirCanonical);

  async function probeHasChildren(absDir: string, relDir: string): Promise<boolean> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      console.warn(`[document-list][showAll] probe readdir failed for ${absDir}:`, err);
      return false;
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (contentFilter.isDirExcluded(relPath, { bypassFilters: true })) continue;
        try {
          const childCanonical = await realpath(join(absDir, entry.name));
          if (!isInsideContentDir(childCanonical)) continue;
        } catch (err) {
          console.warn(
            `[document-list][showAll] probe realpath failed for ${absDir}/${entry.name}:`,
            err,
          );
          continue;
        }
        return true;
      }
      if (entry.isFile() && !contentFilter.isExcluded(relPath, { bypassFilters: true })) {
        return true;
      }
    }
    return false;
  }

  async function* walk(
    startAbsDir: string,
    startRelDir: string,
    startDepth: number,
  ): AsyncGenerator<DocumentListEntry> {
    const queue: Array<{ absDir: string; relDir: string; depth: number }> = [
      { absDir: startAbsDir, relDir: startRelDir, depth: startDepth },
    ];
    for (let head = 0; head < queue.length; head++) {
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

      for (const entry of entries) {
        if (signal?.aborted) {
          aborted = true;
          return;
        }
        if (emitted >= maxEntries) {
          truncated = true;
          return;
        }
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          if (contentFilter.isDirExcluded(relPath, { bypassFilters: true })) continue;

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
              console.warn(`[document-list][showAll] stat failed for ${dirAbsRaw}:`, err);
            }
            emitted += 1;
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

          if (depth < maxDepth) {
            queue.push({ absDir: dirAbsRaw, relDir: relPath, depth: depth + 1 });
          }
          continue;
        }

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
            if (contentFilter.isDirExcluded(relPath, { bypassFilters: true })) continue;
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
          if (contentFilter.isExcluded(relPath, { bypassFilters: true })) continue;
          if (!passesDirFilter(relPath)) continue;
          emitted += 1;
          if (isSupportedDocFile(entry.name)) {
            const docName = relPath.replace(/\.(md|mdx)$/i, '');
            yield {
              kind: 'document',
              docName,
              docExt: getDocExtension(docName),
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
        if (contentFilter.isExcluded(relPath, { bypassFilters: true })) continue;
        if (!passesDirFilter(relPath)) continue;

        let fileStat: import('node:fs').Stats | null = null;
        try {
          fileStat = await stat(join(absDir, entry.name));
        } catch (err) {
          console.warn(`[document-list][showAll] stat failed for ${absDir}/${entry.name}:`, err);
          continue;
        }

        if (isSupportedDocFile(entry.name)) {
          const docName = relPath.replace(/\.(md|mdx)$/i, '');
          const docExt = getDocExtension(docName);
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
  yield* walk(startAbs, startRel, 1);
  if (aborted) showAllWalkAborts += 1;
  return { truncated };
}

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

interface ShowAllWalkResult {
  documents: DocumentListEntry[];
  truncated: boolean;
}

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

function isReservedProjectStatePath(path: string): boolean {
  return path === '.ok' || path.startsWith('.ok/') || path === '.git' || path.startsWith('.git/');
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

function assertNoSymlinkEscape(fullPath: string, resolvedContentDir: string): void {
  let contentRoot: string;
  try {
    contentRoot = realpathSync(resolvedContentDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
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
  const relativePath =
    kind === 'file' ? (isSupportedDocFile(path) ? path : `${path}${getDocExtension(path)}`) : path;
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
  return SUPPORTED_DOC_EXTENSIONS.some((ext) =>
    existsSync(resolve(contentDir, `${docName}${ext}`)),
  );
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
        docName: stripDocExtension(childRel),
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

function probeAndRegisterSourceFileExtension(contentDir: string, fromPath: string): void {
  if (!isValidRelativeContentPath(fromPath)) return;
  const resolvedContentDir = resolve(contentDir);
  if (isSupportedDocFile(fromPath)) {
    const candidate = resolve(resolvedContentDir, fromPath);
    if (
      candidate !== resolvedContentDir &&
      candidate.startsWith(`${resolvedContentDir}${sep}`) &&
      existsSync(candidate)
    ) {
      registerDocExtension(stripDocExtension(fromPath), extname(fromPath));
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
  ephemeral?: boolean;
  serverInstanceId: string;
  getFileIndex: () => ReadonlyMap<string, FileIndexEntry>;
  getAllFilesIndex?: () => ReadonlyMap<string, FileIndexEntry>;
  getFileIndexGeneration?: () => number;
  mutateFileIndex?: (event: DiskEvent) => void;
  getFolderIndex?: () => ReadonlyMap<string, FolderIndexEntry>;
  onReferencedAssetsCacheInvalidator?: (invalidate: () => void) => void;
  getAliasMap?: () => ReadonlyMap<string, string>;
  getFolderAliasIndex?: () => ReadonlyMap<string, string>;
  rescanFiles?: () => void | Promise<void>;
  enableTestRoutes?: boolean;
  shadowRef?: ShadowRef;
  flushGitCommit?: () => Promise<void>;
  flushContributors?: () => Promise<void>;
  takeStoreFailure?: (docName: string) => StoreFailure | null;
  takeStoreDivergence?: (docName: string) => boolean;
  markAgentWriteStore?: (docName: string) => void;
  getCurrentBranch?: () => string | null;
  getDiskAckSVs?: () => Record<string, string>;
  contentRoot?: string;
  backlinkIndex?: BacklinkIndex;
  tagIndex?: TagIndex;
  signalChannel?: (channel: 'files' | 'backlinks' | 'graph') => void;
  agentFocusBroadcaster?: AgentFocusBroadcaster;
  agentPresenceBroadcaster?: AgentPresenceBroadcaster;
  onAgentWrite?: () => void;
  getSyncEngine?: () => SyncEngine | null;
  localOpCliArgs?: string[];
  projectDir?: string;
  resolveEmbed?: (basename: string, sourcePath: string) => string | null;
  getPrincipal?: () => Principal | null;
  homeDirOverride?: string;
  contentFilter?: ContentFilter;
  installedAgentsProbe?: (scheme: InstalledAgentScheme) => Promise<boolean>;
  forceUnloadDocument?: (document: Document) => Promise<void>;
  ready?: Promise<void>;
  recentlyRemovedDocs?: RecentlyRemovedDocs;
  serializeDoc?: (docName: string) => string | null;
  evictManagedArtifactLkg?: (docName: string) => void;
  semanticSearch?: SemanticSearchService;
  getSemanticSimilarityFloor?: () => number | undefined;
  embeddingsSecretsFile?: string;
}

interface WorkspaceSearchCacheEntry {
  fingerprint: string;
  corpus?: WorkspaceSearchCorpus;
  truncated?: boolean;
  pending?: Promise<{ corpus: WorkspaceSearchCorpus; truncated: boolean }>;
}

const workspaceSearchCaches = new Map<string, WorkspaceSearchCacheEntry>();

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
    getAllFilesIndex = getFileIndex,
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

  const localOpGuard = createConcurrencyGuard();

  const showAllInflight = new Map<string, InflightShowAllWalk>();

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

  const installedAgentsCache = createInstalledAgentsProbe({
    probe: installedAgentsProbe ?? createOsProbe(process.platform),
  });

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
    const filePath = resolve(resolvedContentDir, `${docName}${getDocExtension(docName)}`);
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

  function readFrontmatterMetadataForLinkedDocName(
    docName: string,
    admitted: Set<string>,
  ): FrontmatterMetadata {
    if (!admitted.has(docName)) return EMPTY_METADATA;
    return readFrontmatterMetadataForDocName(docName);
  }

  function computeOrphanHints(
    docName: string,
  ): Array<{ type: 'orphan'; parentCandidates: string[]; message: string }> | undefined {
    if (!backlinkIndex) return undefined;
    try {
      const backlinks = backlinkIndex.getBacklinks(docName);
      if (backlinks.length > 0) return undefined;
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

  function flushDocToGit(docName: string, label: string): void {
    const debounceId = `onStoreDocument-${docName}`;
    const l1 = hocuspocus.debouncer.isDebounced(debounceId)
      ? hocuspocus.debouncer.executeNow(debounceId)
      : Promise.resolve();
    l1.then(() => flushGitCommit?.()).catch((err: unknown) => {
      log.warn({ err }, `[${label}] post-write flush failed`);
    });
  }

  type FlushOutcome = { kind: 'failure'; failure: StoreFailure } | { kind: 'divergence' } | null;

  async function flushDiskAndDetectOutcome(docName: string): Promise<FlushOutcome> {
    const debounceId = `onStoreDocument-${docName}`;
    if (hocuspocus.debouncer.isDebounced(debounceId)) {
      markAgentWriteStore?.(docName);
      await hocuspocus.debouncer.executeNow(debounceId);
    }
    const failure = takeStoreFailure?.(docName) ?? null;
    if (failure) return { kind: 'failure', failure };
    if (takeStoreDivergence?.(docName)) return { kind: 'divergence' };
    return null;
  }

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

  function respondDiskDivergence(res: ServerResponse, handler: string): void {
    errorResponse(
      res,
      409,
      'urn:ok:error:disk-divergence',
      'The document changed on disk after your edit was prepared; your edit was NOT applied, to avoid overwriting the newer on-disk content. Re-read the document and retry.',
      { handler },
    );
  }

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

  function collectAdmittedDocNames(): Set<string> {
    const admitted = new Set<string>();
    for (const [docName, entry] of getFileIndex()) {
      admitted.add(docName);
      for (const alias of entry.aliases) {
        admitted.add(alias);
      }
    }
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
    return admitted;
  }

  const linkedFileExists = (contentRootRelativePath: string): boolean =>
    existsSync(resolve(contentDir, contentRootRelativePath));

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

  const runSerialized = createSerializedRunner();

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

  async function captureAndCloseDocuments(docNames: string[]): Promise<Map<string, string>> {
    const liveContents = new Map<string, string>();

    for (const docName of docNames) {
      const document = hocuspocus.documents.get(docName);
      if (document) {
        liveContents.set(docName, document.getText('source').toString());
      }
    }

    for (const docName of docNames) {
      await sessionManager.closeAllForDoc(docName).catch((err) => {
        console.warn(`[file-ops] Failed to close agent session for ${docName}:`, err);
      });
    }

    for (const docName of docNames) {
      const document = hocuspocus.documents.get(docName);
      deleteReconciledBase(docName);
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
      const filePath = `${docName}${getDocExtension(docName)}`;
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

  function listManagedDocNamesUnderFolderFromDisk(sourcePathRoot: string): string[] {
    const docNames: string[] = [];
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
        const docName = stripDocExtension(relPath);
        registerDocExtension(docName, extname(relPath)); // side-effect: see jsdoc
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
          const liveContents = await captureAndCloseDocuments([sourceDocName]);
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

          const sourcePathRoot = resolveContentEntryPath(contentDir, kind, fromPath);
          const destinationPathRoot = resolveContentEntryPath(contentDir, kind, toPath);
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

          const affectedDocNames =
            kind === 'file'
              ? [stripDocExtension(fromPath)]
              : listManagedDocNamesUnderFolderFromDisk(sourcePathRoot);
          const affectedDocs: Array<{ from: string; to: string }> = affectedDocNames.map(
            (docName) => ({
              from: docName,
              to:
                kind === 'file'
                  ? stripDocExtension(toPath)
                  : remapDocNameForRename(docName, kind, fromPath, toPath),
            }),
          );
          span.setAttribute('rename.affected_docs', affectedDocs.length);

          if (affectedDocs.length === 0) {
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

            if (!renameMap.has(docName)) {
              const filePath = resolveContentEntryPath(contentDir, 'file', docName);
              if (!existsSync(filePath)) {
                missingBacklinkSources.push(docName);
                continue;
              }
            }

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

            const liveContents = await captureAndCloseDocuments([...renameMap.keys()]);

            if (
              process.env.NODE_ENV === 'test' &&
              process.env.OK_TEST_RENAME_FAULT === 'pre-append'
            ) {
              throw new Error('OK_TEST_RENAME_FAULT=pre-append');
            }

            if (shadowRef?.current) {
              const shadow = shadowRef.current;
              const loggableAffectedDocs = affectedDocs.filter(({ from, to }) => from !== to);
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
                      appendRenameLogEntry(shadow.gitDir, logEntry, renameLogIndex, shadow);
                      entriesAppended += 1;
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

            const explicitDestExt: string | null =
              kind === 'file' && isSupportedDocFile(toPath) ? extname(toPath) : null;
            for (const { from, to } of affectedDocs) {
              const sourceExt = getDocExtension(from);
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

  type SummaryResponse = { value: string; truncatedFrom?: number; hint?: string };

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

  function stripDefaultPathTruncation(response: SummaryResponse): SummaryResponse {
    return { value: response.value };
  }

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

  function okArtifactKey(
    kind: 'template' | 'folder-frontmatter' | 'folder' | 'skill',
    folder: string,
    name?: string,
  ): string {
    const base = folder.replace(/\/$/, '');
    const prefix = base === '' ? '' : `${base}/`;
    if (kind === 'template') return `${prefix}.ok/templates/${name}`;
    if (kind === 'skill') return `${prefix}.ok/skills/${name}`;
    if (kind === 'folder-frontmatter') return `${prefix}.ok/frontmatter`;
    return base === '' ? '.' : base;
  }

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

  async function commitOkArtifactWrite(context: string): Promise<void> {
    if (!flushContributors) return;
    try {
      await flushContributors();
    } catch (flushErr) {
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
        const rawDocName = requireNonEmptyDocName(body.docName, res, 'agent-write');
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
          captureEffect(session.dc.document.getText('source'), agentId, colorSeed, clientName);
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

        const agentWriteWarning = buildReconcileWarning(agentWriteReconcile);
        successResponse(
          res,
          200,
          AgentWriteSuccessSchema,
          {
            timestamp,
            ...(summaryResponse ? { summary: summaryResponse } : {}),
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
        if (e instanceof FrontmatterMalformedError) {
          respondFrontmatterMalformed(res, e, 'agent-write');
          return;
        }
        if (e instanceof AgentSessionCapacityError) {
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
          hocuspocus,
          resolvedDocName,
          contentDir,
          options.resolveEmbed,
        );

        const timestamp = new Date().toISOString();

        let writeDivergence: AgentWriteContentDivergence | undefined;

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
          captureEffect(session.dc.document.getText('source'), agentId, colorSeed, clientName);
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

        agentFocusBroadcaster?.setFocus(agentId, {
          agentName,
          currentDoc: resolvedDocName,
          writeKind: 'write',
          ts: Date.now(),
        });
        onAgentWrite?.();

        const hints = computeOrphanHints(resolvedDocName);

        const writtenSource = session.dc.document.getText('source').toString();

        const renderWarnings = await validateMermaidFences(writtenSource, resolvedDocName);

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
            ...(writeMdDivergenceEntry
              ? { warning: writeMdDivergenceEntry }
              : writeMdWarning
                ? { warning: writeMdWarning }
                : {}),
            ...(writeMdAdvisories.length > 0 ? { warnings: writeMdAdvisories } : {}),
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

        const fmReconcile = reconcileDiskBeforeAgentWrite(
          hocuspocus,
          resolvedDocName,
          contentDir,
          options.resolveEmbed,
        );

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

        const filePath = resolveContentEntryPath(contentDir, 'file', docName);
        if (!existsSync(filePath)) {
          errorResponse(res, 404, 'urn:ok:error:doc-not-found', `Document not found: ${docName}.`, {
            handler: 'document-read',
          });
          return;
        }

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
        const showAllMaxDepth =
          url.searchParams.get('depth') === '1' ? 1 : Number.POSITIVE_INFINITY;

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

        if (showAll && contentFilter && showAllWantsNdjson(req)) {
          const controller = new AbortController();
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
              getDocExtension,
              maxEntries,
              maxDepth: showAllMaxDepth,
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
            await writeNdjsonLine(`${JSON.stringify({ type: 'complete', truncated, count })}\n`);
          } catch (err) {
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

        if (showAll && contentFilter) {
          const key = `showAll:${showAllMaxDepth === 1 ? 'd1:' : ''}${dir ?? ''}`;
          let entry = showAllInflight.get(key);
          if (!entry) {
            const controller = new AbortController();
            const promise = (async (): Promise<ShowAllWalkResult> => {
              const documents: DocumentListEntry[] = [];
              const maxEntries = getShowAllMaxEntries();
              const { truncated } = await walkContentDirForShowAll({
                contentDir,
                contentFilter,
                dirFilter: dir,
                documents,
                getDocExtension,
                maxEntries,
                maxDepth: showAllMaxDepth,
                signal: controller.signal,
              });
              documents.sort((a, b) => {
                const aPath = a.kind === 'folder' ? (a.path ?? '') : (a.docName ?? a.path ?? '');
                const bPath = b.kind === 'folder' ? (b.path ?? '') : (b.docName ?? b.path ?? '');
                return aPath.localeCompare(bPath);
              });
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
            void promise.finally(() => {
              if (showAllInflight.get(key) === created) showAllInflight.delete(key);
            });
          }

          const attached = entry;
          attached.waiters += 1;
          let released = false;
          const releaseOnDisconnect = () => {
            if (res.writableEnded || released) return;
            released = true;
            attached.waiters -= 1;
            if (attached.waiters <= 0) {
              attached.controller.abort();
              if (showAllInflight.get(key) === attached) showAllInflight.delete(key);
            }
          };
          res.on('close', releaseOnDisconnect);

          try {
            const { documents, truncated } = await attached.promise;
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

        const index = getFileIndex();
        const allFiles = getAllFilesIndex();
        const folderIndex = getFolderIndex?.() ?? new Map<string, FolderIndexEntry>();
        const documents: DocumentListEntry[] = [];

        for (const [folderPath, entry] of folderIndex) {
          if (dir && !folderPath.startsWith(`${dir}/`) && folderPath !== dir) continue;
          documents.push({
            kind: 'folder',
            path: folderPath,
            size: 0,
            modified: entry.modified,
            docExt: '.md',
            isSymlink: false,
            canonicalDocName: null,
            targetPath: null,
          });
        }

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
                isExcluded: contentFilter ? (rel) => contentFilter.isPathIgnored(rel) : undefined,
              }),
            };
          }
          assets = referencedAssetsCache?.assets ?? [];
        } catch (err) {
          referencedAssetsCache = null;
          console.warn('[document-list] asset collection failed; returning documents only:', err);
        }

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
            if (dir && !docName.startsWith(`${dir}/`) && docName !== dir) continue;

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

          const passesDir = !dir || docName === dir || docName.startsWith(`${dir}/`);
          if (passesDir && !assetPaths.has(docName)) {
            const assetExt = synthesizeShowAllAssetExt(docName);
            documents.push({
              kind: 'file',
              docName,
              path: docName,
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

        const folderAliasIndex = getFolderAliasIndex?.() ?? new Map<string, string>();
        if (folderAliasIndex.size > 0) {
          const passesDirFilter = (p: string): boolean =>
            !dir || p === dir || p.startsWith(`${dir}/`);
          const aliasesByCanonical = new Map<string, string[]>();
          for (const [aliasPrefix, canonicalPrefix] of folderAliasIndex) {
            const arr = aliasesByCanonical.get(canonicalPrefix);
            if (arr) arr.push(aliasPrefix);
            else aliasesByCanonical.set(canonicalPrefix, [aliasPrefix]);
          }
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
        let patchDivergence: AgentWriteContentDivergence | undefined;
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
          captureEffect(session.dc.document.getText('source'), agentId, colorSeed, clientName);
          session.dc.document.transact(() => {
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

        const renderWarnings = await validateMermaidFences(patchedSource, docName);

        const admittedForLinks = collectAdmittedDocNames();
        admittedForLinks.add(docName);
        const brokenLinks = computeBrokenOutboundLinks(
          patchedSource,
          docName,
          admittedForLinks,
          linkedFileExists,
        );

        const patchWarning = buildReconcileWarning(patchReconcile);
        const patchDivergenceEntry =
          patchDivergence !== undefined ? toContentDivergenceWarning(patchDivergence) : undefined;
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
            ...(patchDivergenceEntry
              ? { warning: patchDivergenceEntry }
              : patchWarning
                ? { warning: patchWarning }
                : {}),
            ...(patchAdvisories.length > 0 ? { warnings: patchAdvisories } : {}),
            brokenLinks,
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
        log.error({ err: e }, '[agent-patch] handler failed');
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
        log.error({ err: e }, '[agent-undo] handler failed');
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
        log.error({ err: e }, '[agent-activity] handler failed');
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

        let filePath: string;
        try {
          filePath = safeContentPath(docName, contentDir);
        } catch (err) {
          log.error({ err, docName }, '[test-reset] safeContentPath rejected docName');
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'test-reset',
            cause: err,
          });
          return;
        }

        await sessionManager.closeAll(docName);
        hocuspocus.closeConnections(docName);

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

        const saveVersionBranch = getCurrentBranch?.() ?? 'main';

        if (writers.length === 0) {
          if (svRawAgentId !== undefined) {
            const displayName = svClientName ? `${svAgentName} (${svClientName})` : svAgentName;
            writers = [
              { id: svAgentId, name: displayName, email: `${svAgentId}@openknowledge.local` },
            ];
          } else {
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

  const handleHistory = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const shadow = shadowRef?.current;
      if (!shadow) {
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

      if (folderParam !== null && !docName) {
        const validated = validateFolderRel(folderParam, res, 'folder', 'history');
        if (!validated) return;
        const rawFolderLimit = Number(url.searchParams.get('limit') ?? '50');
        const folderLimit = Math.min(200, Number.isFinite(rawFolderLimit) ? rawFolderLimit : 50);
        const rawFolderOffset = Number(url.searchParams.get('offset') ?? '0');
        const folderOffset = Math.max(0, Number.isFinite(rawFolderOffset) ? rawFolderOffset : 0);
        const folderKey = `folder\0${branch}\0${validated.folderRel}\0${folderLimit}\0${folderOffset}`;
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
      const includeAutoCheckpoints = url.searchParams.get('includeAutoCheckpoints') === 'true';

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
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read history.', {
          handler: 'history',
          cause: e,
        });
      }
    },
    { handler: 'history', method: 'GET', skipBodyParse: true },
  );

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

    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid commit SHA.', {
        handler: 'history-version',
      });
      return;
    }

    try {
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

      const targetDoc = hocuspocus.documents.get(body.docName);
      if (targetDoc && isDocInConflict(targetDoc)) {
        respondDocInConflict(
          res,
          new DocInConflictError({ file: `${body.docName}${getDocExtension(body.docName)}` }),
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

        const rollbackEmbedResolver = options.resolveEmbed
          ? { resolveEmbed: options.resolveEmbed, sourcePath: docName }
          : undefined;
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
            ...(rollbackDivergenceEntry
              ? { warning: rollbackDivergenceEntry, warnings: [rollbackDivergenceEntry] }
              : {}),
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

  const handleServerInfo = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        if (ready) {
          await ready.catch((err: unknown) => {
            log.warn(
              { err, handler: 'server-info' },
              '[api] ready gate rejected — responding with current state',
            );
          });
        }
        const currentBranch = getActiveBranch();
        const currentDiskAckSVs = getDiskAckSVs?.();
        successResponse(
          res,
          200,
          ServerInfoSuccessSchema,
          {
            serverInstanceId,
            currentBranch,
            ...(currentDiskAckSVs !== undefined ? { currentDiskAckSVs } : {}),
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
        if (contentFilter?.isPathIgnored(relativePath)) {
          errorResponse(res, 404, 'urn:ok:error:asset-not-found', 'Asset not found.', {
            handler: 'asset',
          });
          return;
        }
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
          headers['Content-Security-Policy'] = SANDBOXED_HTML_CSP;
        }
        res.writeHead(200, headers);
        try {
          await pipeline(createReadStream(canonicalPath), res);
        } catch (streamError) {
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

  const RESCUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  const handleRescueList = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        if (!shadowRef?.current) {
          successResponse(res, 200, RescueListSuccessSchema, [], { handler: 'rescue-list' });
          return;
        }

        const now = Date.now();
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
        const firstSegment = filePath.split('/')[0];
        if (firstSegment === OK_DIR || isManagedArtifactDocName(candidateDocName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${candidateDocName}' is a reserved document name.`,
            {
              handler: 'create-page',
              detail:
                'Cannot create a page under .ok/ — skills and templates are authored through their own validating flows.',
            },
          );
          return;
        }
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
          const templateStarter = instantiateDoc(templateRaw);
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
        recentlyRemovedDocs?.delete(docName);
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
        if (folderPath === '.ok' || folderPath.startsWith('.ok/')) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            "'.ok' is a reserved directory.",
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
        const requestedPath = kind === 'file' ? stripDocExtension(body.path) : body.path;
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
          requestedPath === '.ok' ||
          requestedPath.startsWith('.ok/') ||
          (kind === 'file' && (isSystemDoc(requestedPath) || isConfigDoc(requestedPath))) ||
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

        const duplicateSourceDocNames =
          kind === 'file'
            ? [requestedPath]
            : listManagedDocNamesUnderFolderFromDisk(
                resolveContentEntryPath(contentDir, 'folder', requestedPath),
              );
        const duplicateEngine = getSyncEngine?.();
        const duplicateTrackedFiles = new Set(
          duplicateEngine ? duplicateEngine.getConflicts().map((c) => c.file) : [],
        );
        for (const affected of duplicateSourceDocNames) {
          const affectedDocName = stripDocExtension(affected);
          const doc = hocuspocus.documents.get(affectedDocName);
          const filePath = `${affectedDocName}${getDocExtension(affectedDocName)}`;
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
          const next = nextAvailableDuplicateDocName(contentDir, requestedPath);
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
              registerDocExtension(doc.docName, sourceExtension);
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
        if (
          fromPath === '.ok' ||
          fromPath.startsWith('.ok/') ||
          toPath === '.ok' ||
          toPath.startsWith('.ok/')
        ) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            '.ok is a reserved directory.',
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
        const renameAffectedDocNames =
          operationKind === 'file'
            ? [stripDocExtension(fromPath)]
            : listManagedDocNamesUnderFolderFromDisk(
                resolveContentEntryPath(contentDir, 'folder', fromPath),
              );
        const renameEngine = getSyncEngine?.();
        const renameTrackedFiles = new Set(
          renameEngine ? renameEngine.getConflicts().map((c) => c.file) : [],
        );
        for (const affected of renameAffectedDocNames) {
          const affectedDocName = stripDocExtension(affected);
          const doc = hocuspocus.documents.get(affectedDocName);
          const filePath =
            operationKind === 'file' ? fromPath : `${affectedDocName}${getDocExtension(affected)}`;
          const conflictedByLifecycle = doc !== undefined && isDocInConflict(doc);
          const conflictedByStore = renameTrackedFiles.has(filePath);
          if (conflictedByLifecycle || conflictedByStore) {
            respondDocInConflict(res, new DocInConflictError({ file: filePath }), 'rename-path');
            return;
          }
        }
        if (operationKind === 'file') {
          probeAndRegisterSourceFileExtension(contentDir, fromPath);
        }

        if (contentFilter) {
          const excluded =
            operationKind === 'file'
              ? contentFilter.isExcluded(
                  isSupportedDocFile(toPath) ? toPath : `${toPath}${getDocExtension(fromPath)}`,
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
        if (operationKind === 'asset' && isReservedProjectStatePath(operationPath)) {
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

        const deletedDocNames =
          operationKind === 'asset'
            ? []
            : operationKind === 'file'
              ? [stripDocExtension(operationPath)]
              : listManagedDocNamesUnderFolderFromDisk(
                  resolveContentEntryPath(contentDir, 'folder', operationPath),
                );

        const deleteEngine = getSyncEngine?.();
        const deleteTrackedFiles = new Set(
          deleteEngine ? deleteEngine.getConflicts().map((c) => c.file) : [],
        );
        for (const affected of deletedDocNames) {
          const affectedDocName = stripDocExtension(affected);
          const doc = hocuspocus.documents.get(affectedDocName);
          const filePath =
            operationKind === 'file'
              ? isSupportedDocFile(operationPath)
                ? operationPath
                : `${affectedDocName}${getDocExtension(affectedDocName)}`
              : `${affectedDocName}${getDocExtension(affectedDocName)}`;
          const conflictedByLifecycle = doc !== undefined && isDocInConflict(doc);
          const conflictedByStore = deleteTrackedFiles.has(filePath);
          if (conflictedByLifecycle || conflictedByStore) {
            respondDocInConflict(res, new DocInConflictError({ file: filePath }), 'delete-path');
            return;
          }
        }

        await captureAndCloseDocuments(deletedDocNames);

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

        for (const docName of deletedDocNames) {
          mutateFileIndex?.({
            kind: 'delete',
            path: resolve(contentDir, `${docName}${getDocExtension(docName)}`),
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
            const isReservedFolder =
              operationKind === 'folder' && isReservedSyntheticFolderPath(path);
            const isReservedAsset = operationKind === 'asset' && isReservedProjectStatePath(path);
            if (
              (operationKind === 'file' &&
                (isSystemDoc(operationDocName) || isConfigDoc(operationDocName))) ||
              isReservedFolder ||
              isReservedAsset
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

            await captureAndCloseDocuments(deletedDocNames);

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

            for (const docName of deletedDocNames) {
              mutateFileIndex?.({
                kind: 'delete',
                path: resolve(contentDir, `${docName}${getDocExtension(docName)}`),
                docName,
              });
            }
            if (operationKind === 'folder') {
              removeFolderIndexEntries(path);
            }

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
          let title = docName;
          let icon: string | undefined;
          const docExt = getDocExtension(docName);
          try {
            const filePath = resolve(contentDir, `${docName}${docExt}`);
            const content = readFileSync(filePath, 'utf-8');
            title = extractPageTitle(content, docName);
            icon = extractPageIcon(content);
          } catch (err) {
            console.warn(`[pages] Failed to read title for ${docName}:`, err);
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

    const { filename, tempPath, sha, byteLength, parentDocName: rawParentDocName } = uploadResult;

    const cleanupTempfile = () => {
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {
        }
      }
    };

    const validated = validateBody(UploadRequestSchema, { parentDocName: rawParentDocName }, res, {
      handler: 'upload-asset',
    });
    if (!validated.ok) {
      cleanupTempfile();
      return;
    }
    const { parentDocName } = validated.value;

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
    const destDir = resolveUploadDestDir(
      parentDocName,
      DEFAULT_ATTACHMENT_FOLDER_PATH,
      resolvedContentDir,
    );
    if (!isWithinContentDir(destDir, resolvedContentDir)) {
      cleanupTempfile();
      errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
        handler: 'upload-asset',
      });
      return;
    }
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
    try {
      mkdirSync(destDir, { recursive: true });
    } catch (err) {
      if (!isAlreadyExistsError(err)) {
        cleanupTempfile();
        const reason = classifyUploadErrno(err as NodeJS.ErrnoException);
        errorResponse(res, uploadStatusFor(reason), reason, uploadTitleFor(reason), {
          handler: 'upload-asset',
          cause: err,
          detail: 'failed to create attachment directory',
        });
        return;
      }
    }

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
      } else {
        cleanupTempfile();
        errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
          handler: 'upload-asset',
          cause: e,
        });
        return;
      }
    }

    const fileTypeResult = await fileTypeFromFile(tempPath);
    let detectedMime: string | undefined = fileTypeResult?.mime;
    let detectedExt: string | undefined = fileTypeResult?.ext;
    if (!detectedMime) {
      const head = readTempFileHead(tempPath, 256);
      const headText = head.toString('utf-8').replace(/^﻿/, '').trimStart();
      if (
        headText.startsWith('<svg') ||
        (headText.startsWith('<?xml') && headText.includes('<svg'))
      ) {
        detectedMime = 'image/svg+xml';
        detectedExt = 'svg';
      }
    }

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

    let finalFilename: string;
    const isGenericPaste = !filename || filename === 'upload' || GENERIC_PASTE_NAMES.test(filename);
    if (isGenericPaste) {
      const now = new Date();
      const ts = now
        .toISOString()
        .replace(/[-:T]/g, '')
        .slice(0, 14)
        .replace(/(\d{8})(\d{6})/, '$1-$2');
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


  const LOCAL_OP_CLONE_KEY = '/api/local-op/clone';
  const LOCAL_OP_OK_INIT_KEY = '/api/local-op/ok-init';
  const LOCAL_OP_TIMEOUT_MS = 10 * 60 * 1000;
  const LOCAL_OP_OPEN_TIMEOUT_MS = 45_000;

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

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });

    const writeStreamError = createStreamingErrorWriter(res, HANDLE_LOCAL_OP_CLONE);

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
            log.warn(
              { stderr: redactShareSubprocessStderr(event.message), url, dir },
              '[local-op/clone] clone failed',
            );
          }
          const classification = classifyCloneError(event.message ?? '');
          writeStreamError(500, 'urn:ok:error:clone-failed', classification.title, {
            detail: classification.detail || undefined,
            cause: event.message
              ? new Error(redactShareSubprocessStderr(event.message))
              : undefined,
          });
          return;
        }
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(`${JSON.stringify(event)}\n`);
          } catch {
          }
        }
      },
    });

    void (async () => {
      try {
        await flow.done;
        if (cloneCompleteDir && !res.writableEnded && !res.destroyed) {
          const result = await startServerAtDirAndGetPort(cloneCompleteDir);
          if (!res.writableEnded && !res.destroyed) {
            if ('port' in result) {
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

    res.on('close', () => {
      flow.cancel();
    });
  }

  async function startServerAtDirAndGetPort(
    dir: string,
    port?: number,
  ): Promise<{ port: number } | { error: string }> {
    const absDir = resolve(expandTilde(dir));
    const lockDir = getLocalDir(absDir);

    const existingUi = readUiLock(lockDir);
    if (existingUi && existingUi.port > 0) {
      return { port: existingUi.port };
    }

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

    const spawnAndAwaitUi = async (
      cliCmd: 'ui' | 'start',
    ): Promise<{ port: number } | { error: string; exited: boolean }> => {
      const child = spawn(cmd, buildArgs(cliCmd), {
        cwd: absDir,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, OK_LOCK_KIND: 'interactive' },
      });

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
      child.on('error', (err) => {
        spawnErrorMessage = err.message;
        earlyExitCode = -1;
        log.error(
          { cwd: absDir, cliCmd, err: err.message },
          '[local-op/clone] failed to spawn child',
        );
      });

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

    const existingServer = readServerLock(lockDir);
    const cliCmd = existingServer && existingServer.port > 0 ? 'ui' : 'start';
    const result = await spawnAndAwaitUi(cliCmd);

    if (cliCmd === 'start' && 'error' in result && result.exited) {
      const nowServer = readServerLock(lockDir);
      if (nowServer && nowServer.port > 0) {
        const connectResult = await spawnAndAwaitUi('ui');
        if ('port' in connectResult) return connectResult;
        return { error: `${result.error}; connect fallback failed: ${connectResult.error}` };
      }
    }

    if ('port' in result) return result;
    return { error: result.error };
  }

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


  const LOCAL_OP_AUTH_LOGIN_KEY = '/api/local-op/auth/login';
  const LOCAL_OP_AUTH_STATUS_KEY = '/api/local-op/auth/status';
  const LOCAL_OP_AUTH_REPOS_KEY = '/api/local-op/auth/repos';
  const LOCAL_OP_AUTH_SIGNOUT_KEY = '/api/local-op/auth/signout';

  let authLoginInFlight: ReturnType<typeof runDeviceFlowSubprocess> | null = null;

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
    const host = body.host ?? 'github.com';

    if (!localOpGuard.tryAcquire(LOCAL_OP_AUTH_LOGIN_KEY)) {
      const stale = authLoginInFlight;
      if (!stale) {
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
        resumeSyncOnAuthEvent(event, getSyncEngine);
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(`${JSON.stringify(event)}\n`);
          } catch {
          }
        }
      },
    });
    authLoginInFlight = flow;

    const onClientClose = () => {
      flow.cancel();
      if (authLoginInFlight === flow) {
        authLoginInFlight = null;
        localOpGuard.release(LOCAL_OP_AUTH_LOGIN_KEY);
      }
    };
    res.on('close', onClientClose);

    void flow.done.finally(() => {
      res.off('close', onClientClose);
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
        }
      }
      if (authLoginInFlight === flow) {
        authLoginInFlight = null;
        localOpGuard.release(LOCAL_OP_AUTH_LOGIN_KEY);
      }
    });
  }

  const HANDLE_LOCAL_OP_AUTH_STATUS = 'local-op-auth-status';
  const handleLocalOpAuthStatus = withValidation(
    LocalOpAuthHostRequestSchema,
    async (_req, res, body) => {
      const host = body.host ?? 'github.com';

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
          const child = spawn(cmd, spawnArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env },
          });
          let timedOut = false;
          const killTimer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
          }, 30_000);
          const chunks: Buffer[] = [];
          child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
          child.on('close', () => {
            clearTimeout(killTimer);
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
    const host = body.host ?? 'github.com';

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

    const writeStreamError = createStreamingErrorWriter(res, HANDLE_LOCAL_OP_AUTH_REPOS);

    const [cmd, ...baseArgs] = localOpCliArgs;
    const spawnArgs = [...baseArgs, 'auth', 'repos', '--json', '--host', host];

    let settled = false;
    let stdoutBuffer = '';
    const child = spawn(cmd, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

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
        }
        if (evt && evt.type === 'error') {
          const detail = typeof evt.message === 'string' ? evt.message : undefined;
          writeStreamError(
            500,
            'urn:ok:error:auth-failed',
            'Auth repos subprocess reported an error.',
            { detail },
          );
          continue;
        }
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(`${line}\n`);
          } catch {
          }
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      log.debug({ msg: chunk.toString('utf-8').trim() }, '[local-op/auth/repos] stderr');
    });

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

    res.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(killTimer);
        child.kill('SIGTERM');
        localOpGuard.release(LOCAL_OP_AUTH_REPOS_KEY);
      }
    });
  }

  const HANDLE_LOCAL_OP_AUTH_SIGNOUT = 'local-op-auth-signout';
  const handleLocalOpAuthSignout = withValidation(
    LocalOpAuthHostRequestSchema,
    async (_req, res, body) => {
      const host = body.host ?? 'github.com';

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
          const child = spawn(cmd, spawnArgs, {
            stdio: 'ignore',
            env: { ...process.env },
          });
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
        void getSyncEngine?.()
          ?.refreshIdentity()
          .catch(() => {
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
        errorResponse(res, 503, 'urn:ok:error:sync-not-active', 'Sync engine not active.', {
          handler: 'sync-trigger',
        });
        return;
      }
      const op = body.op ?? 'sync';
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
    if (file.includes('..') || file.startsWith('/')) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid file path.', {
        handler: 'sync-conflict-content',
      });
      return;
    }
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
    const source = url.searchParams.get('source');
    const pg = simpleGit({ baseDir: projectDir, timeout: { block: 15_000 } });
    type StageResult = { present: false } | { present: true; content: string };
    async function showStage(stage: 1 | 2 | 3): Promise<StageResult> {
      try {
        return { present: true, content: await pg.raw(['show', `:${stage}:${file}`]) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isAbsent =
          /pathspec|did not match|exists on disk, but not in|is in the index, but not at stage/i.test(
            msg,
          );
        if (!isAbsent) {
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
      const kind: 'both-modified' | 'delete-modify' | 'modify-delete' =
        oursResult.present && theirsResult.present
          ? 'both-modified'
          : !oursResult.present && theirsResult.present
            ? 'delete-modify'
            : oursResult.present && !theirsResult.present
              ? 'modify-delete'
              : 'both-modified';
      let ours = oursResult.present ? oursResult.content : '';
      let lifecycleStatus: string | null = null;
      if (source === 'ytext') {
        const docName = stripDocExtension(file);
        const loaded = hocuspocus.documents.get(docName);
        if (loaded) {
          const rawStatus = loaded.getMap('lifecycle').get('status');
          lifecycleStatus =
            typeof rawStatus === 'string' && rawStatus.length > 0 ? rawStatus : null;
          if (kind !== 'delete-modify') {
            const ytextOurs = serializeDoc ? serializeDoc(docName) : null;
            if (ytextOurs !== null && !ytextHasConflictMarkers(ytextOurs)) {
              ours = ytextOurs;
            } else if (ytextOurs !== null) {
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

  const handleSeedApply = withValidation(
    SeedApplyRequestSchema,
    async (_req, res, body) => {
      const planValue = body.plan;
      if (!planValue || typeof planValue !== 'object') {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid plan payload.', {
          handler: 'seed-apply',
        });
        return;
      }
      const plan = planValue as ScaffoldPlan;
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

  const handleInstallSkill = withValidation(
    InstallSkillRequestSchema,
    async (_req, res, body) => {
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
    if (!checkLocalOpSecurity(req, res, { handler: 'installed-agents' })) return;
    try {
      await handleInstalledAgents(req, res, installedAgentsCache.probeAll);
    } catch (e) {
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

  const handleTemplatesList = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        const resolvedContentDir = resolve(contentDir);
        const result = resolveProjectTemplates(resolvedContentDir);
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

        if (checkTemplateConflictGate(validated.folderRel, name, 'template-put', res)) return;

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

        if (checkTemplateConflictGate(validated.folderRel, name, 'template-delete', res)) return;

        await captureAndCloseDocuments([templateDocNameFor(validated.folderRel, name)]);

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

        if (
          checkTemplateConflictGate(fromValidated.folderRel, body.fromName, 'template-move', res)
        ) {
          return;
        }

        await captureAndCloseDocuments([
          templateDocNameFor(fromValidated.folderRel, body.fromName),
        ]);

        const result = await applyTemplateMove({
          projectDir: fromValidated.resolvedContentDir,
          fromFolder: fromValidated.folderRel,
          fromName: body.fromName,
          toFolder: toValidated.folderRel,
          toName: body.toName,
          relocate: async (fromAbs, toAbs) => {
            const movedWithGit = await renameTrackedPathInGit(projectDir, fromAbs, toAbs);
            if (!movedWithGit) renamePathOnDisk(fromAbs, toAbs);
            return movedWithGit;
          },
        });

        if (!result.ok) {
          if (result.error.code === 'TEMPLATE_NOT_FOUND') {
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

        let contentEditError: { code: string; message: string } | null = null;
        if (body.body !== undefined || body.frontmatter !== undefined) {
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

  const skillsHome = homeDirOverride ?? homedir();

  function resolveSkillsRoot(scope: 'project' | 'global'): string {
    return scope === 'global'
      ? resolve(skillsHome, '.ok', 'skills')
      : resolve(contentDir, '.ok', 'skills');
  }

  function templateDocNameFor(folderRel: string, name: string): string {
    const segs = folderRel ? folderRel.split('/').filter(Boolean).map(encodeURIComponent) : [];
    return `${MANAGED_ARTIFACT_PREFIX_TEMPLATE}${[...segs, encodeURIComponent(name)].join('/')}`;
  }

  function parseSearchRanking(value: unknown): WorkspaceSearchRanking | undefined {
    return value === 'navigation' || value === 'relevance' ? value : undefined;
  }

  function skillRelPath(abs: string, scope: 'project' | 'global'): string {
    const base = scope === 'global' ? skillsHome : contentDir;
    return relative(base, abs).split(/[\\/]/).filter(Boolean).join('/');
  }

  function skillInstallBase(scope: 'project' | 'global'): string | undefined {
    return scope === 'global' ? skillsHome : projectDir;
  }

  async function uninstallSkillFromHostDirs(base: string, name: string): Promise<boolean> {
    const installed = await removeSkillInstall(base, name);
    reverseProjectSkill(name, base, PROJECT_SKILL_EDITOR_IDS);
    return installed !== null;
  }

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
        if (typeof frontmatter.version === 'string' && frontmatter.version.trim() !== '') {
          installedVersion = frontmatter.version;
        }
      } catch {
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
        const project = resolveSkillsList(resolveSkillsRoot('project'), 'project');
        const globalSkills = resolveSkillsList(resolveSkillsRoot('global'), 'global');
        const projectInstalled = projectDir ? readInstalledSkills(projectDir).skills : {};
        const globalInstalled = readInstalledSkills(skillsHome).skills;
        const enrich = (list: typeof project, marker: Record<string, { hosts: string[] }>) =>
          list.skills.map((skill) => {
            const record = marker[skill.name];
            const hosts = record?.hosts ?? [];
            const update = computePackUpdateStatus(skill.name, skill.installedVersion);
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
              frontmatter: {
                name: typeof frontmatter.name === 'string' ? frontmatter.name : name,
                description:
                  typeof frontmatter.description === 'string' ? frontmatter.description : '',
              },
              body,
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
        const created = !existsSync(filePath);
        const relPath = relative(skillsRoot, filePath).split(/[\\/]/).filter(Boolean).join('/');
        const docName = skillLiveDocName(body.scope, body.name);

        if (checkSkillDocConflictGate(docName, 'skill-put', res)) return;

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

        const flushOutcome = await flushDiskAndDetectOutcome(docName);
        if (flushOutcome?.kind === 'failure') {
          respondPersistenceFailure(res, flushOutcome.failure, 'skill-put');
          return;
        }
        if (flushOutcome?.kind === 'divergence') {
          respondDiskDivergence(res, 'skill-put');
          return;
        }

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

        await captureAndCloseDocuments([skillLiveDocName(scope, name)]);

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

        await captureAndCloseDocuments([skillLiveDocName(body.scope, body.fromName)]);

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

        if (body.scope === 'project' && !contentEditError) {
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
        if (body.scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.toName),
            `skill-rename: ${fromKeyPath} -> ${toKeyPath}`,
            [{ from: fromKeyPath, to: toKeyPath }],
          );
          await commitOkArtifactWrite('skill-move');
        }

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


  function classifySkillFilePath(rel: string): 'reference' | 'script' | null {
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

  function isProjectMdReference(
    scope: 'project' | 'global',
    kind: 'reference' | 'script',
    rel: string,
  ): boolean {
    return scope === 'project' && kind === 'reference' && rel.toLowerCase().endsWith('.md');
  }

  function projectRefContentDocName(name: string, rel: string): string {
    const extLess = rel.replace(/\.md$/i, '');
    return `${projectSkillContentDocName(name).replace(/\/SKILL$/, '')}/${extLess}`;
  }

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
        backlinkIndex.deleteDocument(oldDocName);
        tagIndex?.deleteDocument(oldDocName);
        return;
      }
      backlinkIndex.renameDocument(oldDocName, newDocName, markdown);
      tagIndex?.renameDocument(oldDocName, newDocName, markdown);
    };

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
          const refDocName = projectRefContentDocName(body.name, rel);
          if (checkSkillDocConflictGate(refDocName, 'skill-file-put', res)) return;
          created = !existsSync(resolve(skillsRoot, body.name, rel));
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

        if (isProjectMdReference(scope, kind, rel)) {
          await captureAndCloseDocuments([projectRefContentDocName(name, rel)]);
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

  const handleSkillInstall = withValidation(
    SkillInstallRequestSchema,
    async (_req, res, body) => {
      try {
        const skillsRoot = resolveSkillsRoot(body.scope);
        if (!validateSkillName(body.name, res, 'skill-install')) return;

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

        const targets: EditorId[] =
          body.scope === 'global'
            ? body.targets
              ? // body.targets is the narrower SkillTargetEditor set (no
                PROJECT_SKILL_EDITOR_IDS.filter((id) => body.targets?.some((t) => t === id))
              : [...PROJECT_SKILL_EDITOR_IDS]
            : body.targets !== undefined
              ? // An EXPLICIT target list from the per-editor menu is set-exact,
                PROJECT_SKILL_EDITOR_IDS.filter((id) => body.targets?.some((t) => t === id))
              : resolveSkillTargets(base, readSkillTargets(base) ?? undefined);
        const warnings: string[] = [];
        const warningCodes: SkillInstallWarningCode[] = [];
        if (targets.length === 0 && body.targets === undefined) {
          warnings.push(
            body.scope === 'global'
              ? 'No editor skill folders are configured to install into.'
              : 'No project-configured editors detected — nothing was projected. Set up an editor for this project (add .mcp.json / .cursor/mcp.json / .codex/config.toml) or pass explicit `targets`.',
          );
          warningCodes.push('no-targets');
        }
        if (validity.hasScripts) {
          warnings.push(
            'This skill includes executable `scripts/`. After you install it, the AI agent in your editor (Claude, Cursor, Codex) can run them — Open Knowledge itself never runs anything. Review the scripts before sharing.',
          );
          warningCodes.push('scripts-present');
        }

        const priorHosts = resolvedHosts(readInstalledSkills(base).skills[body.name]?.hosts ?? []);
        const dropped = priorHosts.filter((h) => !targets.includes(h));
        if (dropped.length > 0) reverseProjectSkill(body.name, base, dropped);
        const hosts = projectSkill(skillDir, body.name, base, targets);
        if (hosts.length === 0) {
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
        }

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

        const docName = skillLiveDocName('project', body.name);
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
    return `${prefix}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
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

  function parseSemanticParam(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }

  function parseSearchSource(value: unknown): SearchSource {
    return value === 'omnibar' || value === 'mcp' || value === 'http' ? value : 'http';
  }

  interface SemanticResolution {
    input?: WorkspaceSemanticInput;
    status?: SearchSemanticStatus;
    queryEmbedMs: number | null;
    pageTotal: number;
    capable: boolean;
  }

  async function resolveSemantic(
    query: string,
    intent: WorkspaceSearchIntent,
    semanticParam: boolean | undefined,
    corpus: WorkspaceSearchCorpus,
  ): Promise<SemanticResolution> {
    const embeddableDocs = corpus.documents.filter((d) => !isHiddenDocName(d.path));
    const pageTotal = embeddableDocs.reduce((n, d) => n + (d.kind === 'page' ? 1 : 0), 0);
    if (!semanticSearch?.isEnabled() || semanticParam !== true) {
      return { queryEmbedMs: null, pageTotal, capable: false };
    }

    void semanticSearch.embedCorpus(embeddableDocs);

    let input: WorkspaceSemanticInput | undefined;
    let queryEmbedMs: number | null = null;
    if (intent === 'full_text' && query.trim().length >= SEMANTIC_MIN_QUERY_LENGTH) {
      const startedAt = performance.now();
      const scores = await semanticSearch.queryScores(query, embeddableDocs);
      queryEmbedMs = performance.now() - startedAt;
      if (scores && scores.size > 0) {
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
      }
    }
    return out;
  }

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
      }
      docs.push(
        createWorkspaceSearchDocument({
          kind: 'page',
          path: skillLiveDocName('project', skill.name),
          title,
          content,
          modifiedTs: skill.mtimeMs,
        }),
      );
    }
    return docs;
  }

  function entrySearchKey(entry: FileIndexEntry): string {
    return `${entry.modified}\0${entry.size}\0${entry.canonicalPath}\0${entry.inode}\0${entry.aliases.join('\0')}`;
  }

  const pageDocCache = new Map<string, { key: string; doc: WorkspaceSearchDocument }>();

  async function buildWorkspaceSearchDocumentsFromIndex(): Promise<{
    documents: WorkspaceSearchDocument[];
    truncated: boolean;
  }> {
    const pages: WorkspaceSearchDocument[] = [];
    const files: WorkspaceSearchDocument[] = [];
    const seenPages: Set<string> = new Set();
    for (const [docName, entry] of getAllFilesIndex()) {
      if (isSystemDoc(docName) || isConfigDoc(docName)) continue;
      if (docName.startsWith('.ok/skills/')) continue;
      if (entry.kind === 'file') {
        files.push(
          createWorkspaceSearchDocument({
            kind: 'file',
            path: docName,
            modifiedTs: Date.parse(entry.modified),
            aliases: entry.aliases,
          }),
        );
        continue;
      }
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
        readFailed = true;
        console.warn(`[search] Failed to read ${docName}:`, err);
      }
      if (!readFailed) {
        try {
          title = extractPageTitle(content, docName);
        } catch (err) {
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
    for (const docName of pageDocCache.keys()) {
      if (!seenPages.has(docName)) pageDocCache.delete(docName);
    }
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
    const documents = [
      ...pages,
      ...buildSkillSearchDocuments(),
      ...admittedFiles,
      ...deriveFolderSearchDocuments([...pages, ...admittedFiles]),
    ];
    return { documents, truncated };
  }

  function skillStatFingerprint(): string {
    return enumerateProjectSkillStats()
      .map((s) => `${s.name} ${s.mtimeMs} ${s.size}`)
      .join('');
  }

  function workspaceSearchFingerprint(): string {
    if (getFileIndexGeneration) {
      return `gen:${getFileIndexGeneration()}|skills${skillStatFingerprint()}`;
    }
    return `${[...getAllFilesIndex()]
      .filter(([docName]) => !isSystemDoc(docName) && !isConfigDoc(docName))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([docName, entry]) => `${docName}\0${entrySearchKey(entry)}`,
      )
      .join('')}|skills${skillStatFingerprint()}`;
  }

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
    if (!checkLocalOpSecurity(req, res, { handler: 'handoff' })) return;
    try {
      await handleHandoffDispatch(req, res, {
        contentDir,
        platform: process.platform,
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
    if (!checkLocalOpSecurity(req, res, { handler: 'spawn-cursor' })) return;
    try {
      await handleSpawnCursor(req, res, {
        contentDir,
        platform: process.platform,
      });
    } catch (e) {
      if (!res.headersSent) {
        log.error({ err: e }, '[spawn-cursor] route wrapper failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'spawn-cursor',
          cause: e,
        });
      }
    }
  }

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
        if (origin.kind === 'non-github') {
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
        const contentRel = toGitRelativePath(projectDir, contentDir);
        if (contentRel === null) {
          throw new Error('content dir is not contained within the project dir');
        }
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
          const treePath = body.folderPath === '' ? contentRel : body.folderPath;
          sharedUrl = buildGitHubTreeUrl(origin.owner, origin.repo, branch, treePath);
        }
        const shareUrl = `${SHARE_BASE_URL}${encodeShareUrl(sharedUrl)}`;
        emitShareConstructUrlLog('ok', { branchExists: true, kind: body.kind });
        successResponse(
          res,
          200,
          ShareConstructUrlResponseSchema,
          { ok: true, shareUrl, sharedUrl, branch },
          { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
        );
      } catch (err) {
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
        const outcome = await withParentLock(() => runCheckoutFlow(projectDir, body.branch));
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

  async function spawnShareSubprocess(
    args: readonly string[],
  ): Promise<{ stdout: string; code: number | null }> {
    const [cmd, ...baseArgs] = localOpCliArgs;
    const spawnArgs = [...baseArgs, ...args];
    return await new Promise<{ stdout: string; code: number | null }>((resolveSpawn, reject) => {
      const child = spawn(cmd, spawnArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
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
          void getSyncEngine?.()
            ?.refreshRemote()
            .catch(() => {
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

  const handleClientLogs = withValidation(
    ClientLogsRequestSchema,
    async (_req, res, body) => {
      try {
        const logger = getLogger('renderer');
        for (const entry of body.entries) {
          try {
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

  const paneTargetLockDir = projectDir ? getLocalDir(projectDir) : null;
  async function handleApiConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'DELETE') {
      const peerAddress = req.socket?.remoteAddress;
      if (peerAddress !== undefined && !isLoopbackAddress(peerAddress)) {
        errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
          handler: 'api-config',
        });
        return;
      }
      if (!isAllowedWorkspaceHostHeader(req.headers.host)) {
        errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
          handler: 'api-config',
        });
        return;
      }
      if (paneTargetLockDir) clearArmedPaneTarget(paneTargetLockDir);
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        const host = req.headers.host;
        const collabUrl = host ? `ws://${host}/collab` : null;
        const port = paneTargetLockDir ? (readServerLock(paneTargetLockDir)?.port ?? 0) : 0;
        const paneTarget = paneTargetLockDir ? readArmedPaneTarget(paneTargetLockDir) : null;
        const payload = { collabUrl, previewUrl: null, port, paneTarget, singleFile: ephemeral };
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
      extraHeaders: { Allow: 'GET, HEAD, DELETE' },
    });
  }

  const HANDLE_LOCAL_OP_EMBEDDINGS_SET_KEY = 'local-op-embeddings-set-key';
  const HANDLE_LOCAL_OP_EMBEDDINGS_CLEAR_KEY = 'local-op-embeddings-clear-key';
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

  const handleSemanticStatus = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
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
        const storedKey = await new FileEmbeddingsBackend(embeddingsSecretsFile).get();
        const envKey = process.env[EMBEDDINGS_API_KEY_ENV] ?? null;
        const keySource: 'file' | 'env' | null = storedKey ? 'file' : envKey ? 'env' : null;
        const keyPresent = keySource !== null;
        const resolvedKey = storedKey ?? envKey;
        const keyHint = resolvedKey && resolvedKey.length >= 8 ? resolvedKey.slice(-4) : null;
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
  const STATE_MUTATING_PREFIXES: ReadonlyArray<string> = ['/api/local-op/'];

  return {
    priority: 100, // Higher priority — API routes run before static file serving
    async onRequest({ request, response }: { request: IncomingMessage; response: ServerResponse }) {
      const url = request.url?.split('?')[0];
      if (!url) return;

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

      if (url.startsWith('/api/')) {
        const origin = request.headers.origin;
        if (origin !== undefined && !isAllowedApiOrigin(origin)) {
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
          response.setHeader(
            'Access-Control-Allow-Headers',
            `Content-Type, Authorization, traceparent, tracestate, baggage, ${CLIENT_VERSION_HEADER.protocol}, ${CLIENT_VERSION_HEADER.runtime}, ${CLIENT_VERSION_HEADER.kind}`,
          );
        }
        if (request.method === 'OPTIONS') {
          response.writeHead(204);
          response.end();
          return;
        }
      }

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

      if (!url.startsWith('/api/')) return;

      const extractedCtx = propagation.extract(context.active(), request.headers);
      const method = request.method ?? 'GET';
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

              if (!dispatched) {
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
