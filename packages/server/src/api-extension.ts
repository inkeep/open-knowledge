/**
 * HTTP API extension for Hocuspocus — agent write, file ops, and test reset endpoints.
 *
 * Implemented as a Hocuspocus onRequest extension so it works with both
 * the production Server (assembled by `createServer()` in `server-factory.ts`)
 * and the Vite dev plugin.
 */

import { type SpawnOptions, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as wait } from 'node:timers/promises';
import type { Document, Extension, Hocuspocus } from '@hocuspocus/server';
import {
  type AdvisoryWarning,
  AGENT_ICON_COLORS,
  AgentActivitySuccessSchema,
  AgentBurstDiffSuccessSchema,
  AgentPatchRequestSchema,
  AgentPatchSuccessSchema,
  AgentUndoRequestSchema,
  AgentUndoSuccessSchema,
  AgentWriteBatchRequestSchema,
  AgentWriteBatchSuccessSchema,
  AgentWriteMdRequestSchema,
  AgentWriteMdSuccessSchema,
  AgentWriteRequestSchema,
  AgentWriteSuccessSchema,
  ApiConfigSuccessSchema,
  applyPatchToFm,
  type BatchEntryError,
  BranchInfoResponseSchema,
  CheckoutRequestSchema,
  CheckoutResponseSchema,
  ClientLogsRequestSchema,
  ClientLogsSuccessSchema,
  CONFIG_DOC_NAME_OKIGNORE,
  CommentCountsSuccessSchema,
  type ConfigDiagnosticsReport,
  ConfigDiagnosticsReportSchema,
  CreateFolderRequestSchema,
  CreateFolderSuccessSchema,
  CreatePageRequestSchema,
  CreatePageSuccessSchema,
  changedBlockRange,
  colorFromSeed,
  composeWithDerivedFrontmatter,
  createCodeFenceTracker,
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_MODEL,
  DEFAULT_LINKS_VALIDATION,
  DEFAULT_LINTER_CONFIG,
  DeletePathRequestSchema,
  DeletePathSuccessSchema,
  type DiskEditReconciledWarning,
  type DocumentListEntry,
  DuplicatePathRequestSchema,
  DuplicatePathSuccessSchema,
  detectFmRegion,
  EDITOR_PROJECT_SKILL_ROOT,
  type EditorId,
  EmbedDetectSuccessSchema,
  EmptyRequestSchema,
  encodeShareUrl,
  externalSkillLiveDocName,
  FolderConfigGetSuccessSchema,
  FolderConfigPutRequestSchema,
  FolderConfigPutSuccessSchema,
  FrontmatterPatchRequestSchema,
  FrontmatterPatchSuccessSchema,
  FrontmatterSchemasListSuccessSchema,
  FrontmatterSchemaWriteRequestSchema,
  type HeadingEntry,
  HistorySuccessSchema,
  HistoryVersionSuccessSchema,
  type InlineAssetMediaKind,
  InstallSkillRequestSchema,
  InstallSkillSuccessSchema,
  instantiateDoc,
  isDetectedSkillInProject,
  isFrontmatterSchemaAsset,
  isHiddenDocName,
  isManagedArtifactDocName,
  isOpenKnowledgeSkillsSource,
  isSkillInstallTarget,
  isSkillOutsideOpenProject,
  LEGACY_SKILL_STORE_ROOT,
  LINKABLE_ASSET_EXTENSIONS,
  LinkPreviewRequestSchema,
  LinkPreviewResponseSchema,
  type LinksValidationSetting,
  LintAuditResponseSchema,
  LintConfigResponseSchema,
  LintDocResultSchema,
  type LinterConfig,
  LintFixRequestSchema,
  LintFixResultSchema,
  type LintViolationWarning,
  LOCAL_DIR,
  LocalOpAuthCancelRequestSchema,
  LocalOpAuthEmptySuccessSchema,
  type LocalOpAuthHostRequest,
  LocalOpAuthHostRequestSchema,
  LocalOpAuthPatRequestSchema,
  LocalOpAuthPatSuccessSchema,
  LocalOpAuthSetIdentityRequestSchema,
  LocalOpAuthStatusSuccessSchema,
  type LocalOpCloneRequest,
  LocalOpCloneRequestSchema,
  LocalOpEmbeddingsMutationSuccessSchema,
  LocalOpEmbeddingsSetKeyRequestSchema,
  type LocalOpEmbeddingsTestResponse,
  LocalOpEmbeddingsTestResponseSchema,
  LocalOpOkInitRequestSchema,
  LocalOpOkInitResponseSchema,
  lintDocument,
  MANAGED_ARTIFACT_PREFIX_SKILL,
  MarkdownlintRuleWriteRequestSchema,
  mediaKindForSidebarAssetExtension,
  OK_DIR,
  OPENKNOWLEDGE_SKILLS_REPO,
  PROJECT_SKILL_EDITOR_IDS,
  type Principal,
  PrincipalSuccessSchema,
  type ProblemType,
  parseFrontmatterRecord,
  parseTemplateFile,
  prependFrontmatter,
  projectSkillContentDocName,
  RENAMED_PACK_SKILLS,
  RenamePathRequestSchema,
  RenamePathSuccessSchema,
  type RescueEntryFlat,
  type RescueEntryTimeline,
  RescueListSuccessSchema,
  RollbackRequestSchema,
  RollbackSuccessSchema,
  readFmMap,
  SavedThemeDeleteSuccessSchema,
  SavedThemeSaveRequestSchema,
  SavedThemeSaveSuccessSchema,
  SavedThemesListSuccessSchema,
  SavedThemeUpdateRequestSchema,
  SavedThemeUpdateSuccessSchema,
  SaveVersionRequestSchema,
  SaveVersionSuccessSchema,
  SearchRequestSchema,
  type SearchSource,
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
  SkillDuplicateRequestSchema,
  SkillDuplicateSuccessSchema,
  SkillEditExternalRequestSchema,
  SkillEditExternalSuccessSchema,
  SkillFileDeleteSuccessSchema,
  SkillFileGetSuccessSchema,
  SkillFilePutRequestSchema,
  SkillFilePutSuccessSchema,
  SkillFileRenameRequestSchema,
  SkillFileRenameSuccessSchema,
  SkillGetSuccessSchema,
  type SkillImportBulkResult,
  SkillImportRequestSchema,
  SkillImportSuccessSchema,
  SkillInstallRequestSchema,
  SkillInstallStateSuccessSchema,
  SkillInstallSuccessSchema,
  type SkillInstallWarningCode,
  SkillMoveRequestSchema,
  SkillMoveScopeRequestSchema,
  SkillMoveScopeSuccessSchema,
  SkillMoveSuccessSchema,
  SkillPutRequestSchema,
  SkillPutSuccessSchema,
  SkillReimportRequestSchema,
  SkillReimportSuccessSchema,
  SkillRestoreRequestSchema,
  SkillRestoreSuccessSchema,
  SkillRevertRequestSchema,
  SkillRevertSuccessSchema,
  SkillScopeSchema,
  SkillsImportBulkRequestSchema,
  SkillsImportBulkSuccessSchema,
  SkillsInstalledSuccessSchema,
  SkillsListSuccessSchema,
  SkillTargetsGetSuccessSchema,
  SkillTargetsPutRequestSchema,
  SkillTargetsPutSuccessSchema,
  SkillUninstallRequestSchema,
  SkillUninstallSuccessSchema,
  SYSTEM_DOC_NAME,
  SyncConflictContentSuccessSchema,
  SyncConflictsSuccessSchema,
  SyncResolveConflictRequestSchema,
  SyncResolveConflictSuccessSchema,
  SyncStatusSchema,
  SyncTriggerRequestSchema,
  SyncTriggerSuccessSchema,
  scanHeadingLine,
  skillLiveDocName,
  stripFrontmatter,
  TEMPLATE_NAME_REGEX,
  TemplateDeleteSuccessSchema,
  TemplateGetSuccessSchema,
  TemplateImportRequestSchema,
  TemplateImportSuccessSchema,
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
  templateContentDocName,
  UploadAssetSuccessSchema,
  UploadRequestSchema,
  unwrapFrontmatterFences,
  ValidationAuditCountsResponseSchema,
  ValidationAuditResponseSchema,
  type ValidationDiagnostic,
  type WorkspaceSearchIntent,
  type WorkspaceSearchRanking,
  type WorkspaceSearchScope,
  WorkspaceSuccessSchema,
} from '@inkeep/open-knowledge-core';
import {
  formatRenameSubject,
  formatRollbackSubject,
  resolveGitDirDetailed,
  resolveProjectIdentity,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import {
  acquiredBundleTooLarge,
  discoverSkillDirs,
  enumerateInstalledSkills,
  fetchSource,
  parseSkillDir,
  parseSkillsLock,
  parseSource,
  pluginRepositoryUrl,
  readSkillDirMeta,
  readWellKnownIndex,
  resolvePluginUpdateSource,
  resolveSkillsShImportSource,
  retrofitPackLockEntry,
  SKILLS_LOCK_REL,
  SkillFetchError,
  type SkillsLock,
  type SourceSpec,
  upsertLockEntry,
  type WellKnownIndex,
} from '@inkeep/open-knowledge-core/skills-catalog';
import busboy from 'busboy';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { type Entry, fromBuffer as yauzlFromBuffer, type ZipFile } from 'yauzl';
import { z } from 'zod';
import {
  ACP_AGENT_HARNESS_CLIS,
  type AcpHarnessAvailability,
  createAcpHarnessAvailabilityProbe,
} from './acp/harness-availability.ts';
import {
  type AcpRegistry,
  type CustomAgentEntry,
  FEATURED_AGENT_IDS,
  registryPlatformKey,
} from './acp/registry.ts';
import { MAX_ACP_THREADS } from './acp/thread-manager.ts';
import { captureEffect } from './activity-log.ts';
import { listAgentActivity, synthesizeVersionDiff } from './agent-activity.ts';
import type { AgentFocusBroadcaster } from './agent-focus.ts';
import type { AgentPresenceBroadcaster } from './agent-presence.ts';
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
} from './agent-sessions.ts';
import { type NormalizedSummary, normalizeSummary } from './agent-write-summary.ts';
import { collabUrlFromRequestHeaders } from './collab-bootstrap-url.ts';
import { createCommentApi } from './comments/comment-api.ts';
import { CommentIndex } from './comments/comment-index.ts';
import { CommentService } from './comments/comment-service.ts';
import { CommentThreadStore } from './comments/thread-store.ts';
import { getLocalDir } from './config/paths.ts';
import { CONFIG_VALIDATION_REVERT_ORIGIN } from './config-edit-origin.ts';
import { DocInConflictError, isDocInConflict, respondDocInConflict } from './conflict-errors.ts';
import { enrichDirectory } from './content/enrichment.ts';
import { applyFolderFrontmatterPatch } from './content/folder-frontmatter-write.ts';
import {
  applySkillBundleFileDelete,
  applySkillBundleFileRename,
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
import { deriveDetection, embedProbeRing } from './embed-probe.ts';
import {
  FileEmbeddingsBackend,
  probeEmbeddingEndpoint,
  type ResolvedSemanticConfig,
  resolveEmbeddingsCredential,
  type SemanticSearchService,
} from './embeddings/index.ts';
import {
  FrontmatterMalformedError,
  frontmatterRefusalDetail,
  logFrontmatterRefusal,
  respondFrontmatterMalformed,
} from './frontmatter-malformed-error.ts';
import { assertNoSymlinkEscape } from './fs-safety.ts';
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
import {
  AuditSupersededError,
  auditProject,
  collectDocFiles,
  lintAndFixSource,
  lintDoc,
} from './lint/audit.ts';
import { AuditCache } from './lint/audit-cache.ts';
import {
  createEmptyFrontmatterSchemaFile,
  deleteFrontmatterSchemaFile,
  removeFrontmatterSchemaField,
  renameFrontmatterSchemaField,
  type WriteFrontmatterSchemaResult,
  writeFrontmatterSchemaField,
} from './lint/frontmatter-schema-write.ts';
import {
  listProjectSchemaFiles,
  SCHEMA_LIST_CAP,
  unmatchedAppliesToProblems,
} from './lint/frontmatter-schemas.ts';
import { type WriteMarkdownlintResult, writeMarkdownlintRule } from './lint/markdownlint-write.ts';
import {
  composeEffectiveLinterConfig,
  composeFrontmatterSchemasConfig,
  resolveEffectiveLinterConfig,
  resolveNativeConfigForDoc,
} from './lint/resolve-config.ts';
import {
  createProjectValidators,
  type ProjectValidator,
  runValidationAudit,
  toValidationCountsPlane,
  type ValidationAuditResult,
} from './lint/validation-audit.ts';
import { validateMermaidFences } from './mermaid-validator.ts';
import {
  extractPageTitle,
  type FrontmatterMetadata,
  parseFrontmatterMetadata,
} from './page-identity.ts';
import type { RecentlyRemovedDocs } from './recently-removed-docs.ts';
import { scanSavedThemes } from './saved-themes-store.ts';
import { deleteSavedTheme, saveSavedTheme, updateSavedTheme } from './saved-themes-write.ts';
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
import {
  BUNDLE_SKILL_NAME,
  isInternalBundleSkillName,
  USER_GLOBAL_BUNDLE_IDS,
} from './skill-bundles.ts';
import { buildAndOpenSkill, detectUserSkillHosts } from './skill-install.ts';
import {
  projectSkill,
  readSkillBundledFiles,
  removeInPlaceSkillCopies,
  resolvedHosts,
  resolveSkillTargets,
  reverseProjectSkill,
  skillProjectionRoots,
  validateSkillForInstall,
} from './skill-projection.ts';
import { rewriteSkillRefsAcrossScope, type SkillRefRewrite } from './skill-ref-rename.ts';
import { readSkillInstallStateSnapshot } from './skill-state.ts';
import { handleSpawnCursor } from './spawn-cursor-api.ts';
import { assertRealpathWithinDir } from './symlink-guard.ts';
import { readUiLock } from './ui-lock.ts';
import { HashingPassThrough, mintTempUploadPath } from './upload-streaming.ts';

/** Does the bundle at `dir` carry a `metadata.pack` marker in its frontmatter? */
function bundleSelfIdentifiesAsPack(dir: string): boolean {
  try {
    const md = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(md)?.[1];
    return (
      frontmatter !== undefined && /^[ \t]+pack:[ \t]*"?[a-z0-9-]+"?[ \t]*$/m.test(frontmatter)
    );
  } catch {
    return false;
  }
}

export { extractPageTitle } from './page-identity.ts';

import type { SkillHostId } from '@inkeep/open-knowledge-core/skills-catalog';
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
import { getBootTimings } from './boot-timings.ts';
import { composeAndWriteRawBody, type PrecomputedParse, replaceRawBody } from './bridge-intake.ts';
import type { BridgeDeriveLossReporter } from './bridge-loss-detector.ts';
import { isConfigDoc, isLinkIndexExcludedDoc, isSystemDoc } from './cc1-broadcast.ts';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
import type { ResolveStrategy } from './conflict-storage.ts';
import {
  isReservedProjectStatePath,
  listManagedDocNamesUnderFolder,
} from './content/managed-doc-enum.ts';
import type { ContentFilter } from './content-filter.ts';
import { safeContentPath } from './content-path.ts';
import {
  type DerivedDocumentIndexApiPort,
  type DerivedDocumentIndexMutation,
  isDerivedDocumentIndexClosedError,
} from './derived-document-index.ts';
import {
  docNameToRelativePath,
  extensionlessDocTreePath,
  forgetDocExtension,
  getDocExtension,
  isSupportedAssetFile,
  isSupportedDocFile,
  registerDocExtension,
  SUPPORTED_DOC_EXTENSIONS,
  stripDocExtension,
} from './doc-extensions.ts';
import type { DocumentDurabilityState, StoreFailure } from './document-durability-state.ts';
import {
  type ReconcileBeforeWriteResult,
  reconcileDiskBeforeAgentWrite,
} from './external-change.ts';
import { registerExternalSkill } from './external-skill-registry.ts';
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
import { type ApiRouteTable, createApiRequestPipeline } from './http/api-pipeline.ts';
import { catchErrors } from './http/catch-errors.ts';
import { createDocumentRoutes } from './http/document-routes.ts';
import {
  createStreamingErrorWriter,
  errorResponse,
  type HttpErrorStatus,
} from './http/error-response.ts';
import { errnoCode, parseQuery } from './http/handler-utils.ts';
import { assertSingleRouterOwnership, type NativeApiHandle } from './http/http-app.ts';
import { createLinkGraphRoutes } from './http/link-graph-routes.ts';
import { createLocalApiDispatch, type LocalApiDispatch } from './http/local-api-dispatch.ts';
import { methodRouter } from './http/method-router.ts';
import { createMetricsRoutes } from './http/metrics-routes.ts';
import { getRequestId } from './http/request-id.ts';
import { validateBody, withValidation } from './http/request-validation.ts';
import { successResponse } from './http/success-response.ts';
import {
  aliasedSourceRoots,
  knownSkillRootsFor,
  resolveDefaultSkillHomeRel,
  resolveGlobalNativeSkillDir,
  scanGlobalInPlaceSkills,
  scanHostRootAliases,
  scanInPlaceSkills,
  standardSkillRoots,
} from './in-place-skills.ts';
import {
  buildIngressPolicy,
  type IngressPolicy,
  isHostAdmitted,
  isPeerAdmitted,
} from './ingress-policy.ts';
import { initContent } from './init-project.ts';
import { guardedFetch } from './link-preview/guarded-fetch.ts';
import { buildLinkPreviewMetadata, type GuardedFetch } from './link-preview/metadata.ts';
import { LinkPreviewCache, type LinkPreviewOutcome } from './link-preview/preview-cache.ts';
import { classifyLinkPreviewRequest } from './link-preview/request-gate.ts';
import {
  checkLocalOpSecurity as checkLocalOpSecurityBase,
  createConcurrencyGuard,
  expandTilde,
  isAllowedGitUrl,
  isSafeLocalPath,
} from './local-op-security.ts';
import {
  type AuthEvent,
  cachedGhBinaryPath,
  classifyCloneError,
  runCloneSubprocess,
  runDeviceFlowSubprocess,
  runGhDeviceLoginSubprocess,
  runPatSubprocess,
} from './local-ops/index.ts';
import { localTargetInventoryFromIndexes } from './local-target-inventory.ts';
import { getLogger } from './logger.ts';
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
  incrementAgentPatchFindMismatches,
  incrementAgentWriteCalls,
  incrementSummariesProvided,
  incrementSummariesTruncated,
} from './metrics.ts';
import { precomputeParse } from './parse-pool.ts';
import { isWithinDir, toPosix } from './path-utils.ts';
import {
  appendRenameLogEntry,
  createAncestorShaSetCache,
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
import { createAssetService } from './services/assets.ts';
import { createFileOpsService } from './services/file-ops.ts';
import { createSearchService } from './services/search.ts';
import {
  createSkillImportService,
  importedBundleLimitError,
  SKILL_IMPORT_WRITE_LIMITS,
  type SkillImportOutcome,
} from './services/skill-import.ts';
import { createSkillInstallOpsService } from './services/skill-install-ops.ts';
import { createSkillPlacementOpsService } from './services/skill-placement-ops.ts';
import { createVersionOpsService } from './services/version-ops.ts';
import {
  listRescueCheckpoints,
  SERVICE_WRITER,
  type ShadowRef,
  safetyCheckpoint,
  shadowGit,
  type TimelineRescueEntry,
  type WriterIdentity,
} from './shadow-repo.ts';
import { createSingleFlight } from './single-flight.ts';
import {
  linkEditorSkillFolder,
  scanSkillFolderStates,
  unlinkEditorSkillFolder,
} from './skill-folder-links.ts';
import { rejectDisallowedGitSpec } from './skill-git-spec-guard.ts';
import { resolveSkillInstallReportSettings } from './skill-install-report-config.ts';
import {
  readFolderExpectations,
  readSkillInstallModeRaw,
  readSkillPlacements,
  recordFolderExpectation,
  recordKnownSkillRoot,
} from './skill-placements.ts';
import { restoreSkillVersion } from './skill-restore.ts';
import { mutateSkillsLock, readSkillsLockFile } from './skills-lock-store.ts';
import { createSkillsShHandlers } from './skills-sh-handlers.ts';
import { reportSkillInstall } from './skills-sh-install-report.ts';
import type { SyncEngine } from './sync-engine.ts';
import { getMeter, withSpan, withSpanSync } from './telemetry.ts';
import { getDocumentHistory, getFolderTimeline } from './timeline-query.ts';
import { recordTimelineCoalesced } from './timeline-telemetry.ts';
import { computeWriteAdvisoryLinks } from './write-advisory-links.ts';

// Lazy-init so the counter registers against a real meter post-initTelemetry
// (not the pre-init no-op). Matches the httpDurationHist pattern in
// http/api-pipeline.ts.
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
        'Count of agent-patch calls refused for touching the frontmatter region. Bounded labels: result ∈ {rejected, pre_deprecation_passthrough}, reason ∈ {intersect, promoted}. `intersect` is a find that MATCHED inside the existing frontmatter; `promoted` is a byte-0 replace that would CREATE frontmatter on a document that had none. They refuse for opposite reasons, so a spike in one says nothing about the other — the append/prepend surface separates the same pair via the `byte-0-promotion` class on `frontmatter-malformed-write-refused`.',
    },
  );
  return _agentPatchFmTouchCounter;
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
// handler ∈ {agent-write-md, agent-write-batch, agent-patch, rollback} + bounded divergence_type.
let _agentWriteGateFiredCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null =
  null;
function agentWriteGateFiredCounter(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
  _agentWriteGateFiredCounter ||= getMeter().createCounter('ok.agent_write.gate_fired_total', {
    description:
      'Count of agent writes that ran the Site A content-divergence gate (denominator for the divergence rate). Bounded label: handler ∈ {agent-write-md, agent-write-batch, agent-patch, rollback}.',
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
        'Count of agent writes whose converged Y.Text diverged from the composed intent (numerator for the divergence rate). Bounded labels: handler ∈ {agent-write-md, agent-write-batch, agent-patch, rollback}, divergence_type.',
    },
  );
  return _agentWriteContentDivergenceCounter;
}

/** Bounded handler label for the content-divergence counters. */
type DivergenceHandler = 'agent-write-md' | 'agent-write-batch' | 'agent-patch' | 'rollback';

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
/**
 * Server-authoritative "a GitHub credential just landed" hook. A fresh sign-in
 * (OK device flow, gh browser flow, or PAT) can change TWO independent bits of
 * sync state, and healing only one silently under-recovers:
 *
 *   - a SyncEngine parked in `auth-error` (invalid / missing token) →
 *     `notifyCredentialsChanged()` un-parks it; and
 *   - a push-permission verdict of `denied` that paused the engine with
 *     `no-push-permission` while signed out → `refreshPushPermission()` re-probes
 *     so an now-pushable repo clears the pause and sync resumes.
 *
 * The second was the gap: connect never re-probed permission, so a repo that
 * probed `denied` while signed out stayed paused ("you don't have permission to
 * push") until an app restart, even after a successful reconnect. Both calls are
 * best-effort and idempotent — a lost signal just heals on the next cycle /
 * restart. Shared by the streaming (device/gh) and PAT sign-in paths.
 */
function onAuthCredentialLanded(getSyncEngine?: () => SyncEngine | null): void {
  const engine = getSyncEngine?.();
  if (!engine) return;
  void engine.notifyCredentialsChanged().catch(() => {
    /* best-effort — sync status catches up next cycle / restart */
  });
  void engine.refreshPushPermission().catch(() => {
    /* best-effort — the verdict refreshes on the next probe / restart */
  });
}

export function resumeSyncOnAuthEvent(
  event: AuthEvent,
  getSyncEngine?: () => SyncEngine | null,
): void {
  if (event.type !== 'complete') return;
  onAuthCredentialLanded(getSyncEngine);
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

/**
 * Ordered tree-path candidates for resolving a doc's blob inside a commit at
 * restore time. Full-tree checkpoints (Save Version, auto-consolidation,
 * pre-rollback) hold the blob at the extension-full disk path; the silent
 * single-blob checkpoint trees `saveInMemoryCheckpoint` writes hold it at the
 * extension-less docName path. Probe extension-full first so a full-tree
 * checkpoint always matches its real path before the extension-less twin is
 * considered.
 */
function docTreePathCandidates(docName: string, contentRoot: string): readonly string[] {
  const p = safeDocPath(docName, contentRoot);
  if ('error' in p) return [`${docName}.md`];
  const extless = extensionlessDocTreePath(p.path, docName);
  return extless ? [p.path, extless] : [p.path];
}

export { sanitizeFilename } from './filename-sanitize.ts';
export { resolveUploadDestDir } from './services/assets.ts';

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
 * `.gitignored` and content-bearing `BUILTIN_SKIP_DIRS` (`dist/`, `build/`,
 * `coverage/`, …) surface. `.okignore` remains authoritative because it is the
 * user's explicit hide list. The `ALWAYS_SKIP_DIRS` floor still prunes
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
  const filterOpts = { bypassFilters: true, respectOkignore: true, showOk } as const;
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
      if (contentFilter.isExcluded(relPath, filterOpts)) continue;
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
      log.warn({ dir: absDir, err }, `[document-list][showAll] probe readdir failed for ${absDir}`);
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
          log.warn(
            { path: `${absDir}/${entry.name}`, err },
            `[document-list][showAll] probe realpath failed for ${absDir}/${entry.name}`,
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
        log.warn({ dir: absDir, err }, `[document-list][showAll] readdir failed for ${absDir}`);
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
          // (dist/, build/), while respectOkignore:true keeps .okignore
          // authoritative. The ALWAYS_SKIP_DIRS floor still prunes .git/,
          // node_modules/, .ok/ here — the Show All Files OOM guard.
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
            log.warn(
              { path: dirAbsRaw, err },
              `[document-list][showAll] realpath failed for ${dirAbsRaw}`,
            );
            continue;
          }
          if (!isInsideContentDir(dirCanonical)) {
            log.warn(
              { path: dirAbsRaw, canonical: dirCanonical },
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
              log.warn(
                { path: dirAbsRaw, err },
                `[document-list][showAll] stat failed for ${dirAbsRaw}`,
              );
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
            log.warn(
              { path: linkAbs, err },
              `[document-list][showAll] symlink realpath failed for ${linkAbs}`,
            );
            continue;
          }
          if (!isInsideContentDir(canonical)) {
            log.warn(
              { path: linkAbs, canonical },
              `[document-list][showAll] refusing symlink-escape ${linkAbs} -> ${canonical}`,
            );
            continue;
          }
          let canonStat: import('node:fs').Stats;
          try {
            canonStat = await stat(canonical);
          } catch (err) {
            log.warn(
              { path: linkAbs, err },
              `[document-list][showAll] symlink target stat failed for ${linkAbs}`,
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
          log.warn(
            { path: `${absDir}/${entry.name}`, err },
            `[document-list][showAll] stat failed for ${absDir}/${entry.name}`,
          );
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

type DuplicatePathFilesystemProblem = {
  status: 500 | 507;
  type: Extract<ProblemType, 'urn:ok:error:storage-full' | 'urn:ok:error:storage-readonly'>;
  title: string;
};

function classifyDuplicatePathFilesystemProblem(
  err: unknown,
): DuplicatePathFilesystemProblem | null {
  const code = errnoCode(err);
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
  return resolveDocFilePath(contentDir, docName) !== null;
}

/**
 * Resolve a docName — extension-carrying or extension-less — to its on-disk
 * contentDir-relative path, or null when no supported file exists.
 */
function resolveDocFilePath(contentDir: string, docName: string): string | null {
  if (isSupportedDocFile(docName)) {
    return existsSync(resolve(contentDir, docName)) ? docName : null;
  }
  for (const ext of SUPPORTED_DOC_EXTENSIONS) {
    if (existsSync(resolve(contentDir, `${docName}${ext}`))) return `${docName}${ext}`;
  }
  return null;
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
        log.warn(
          { tempExists, sourceExists },
          '[renamePathOnDisk] skipped case-only rollback due to unexpected state',
        );
      }
    } catch (rollbackErr) {
      log.warn(
        { err: rollbackErr },
        '[renamePathOnDisk] failed to roll back temporary case-only rename',
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
      log.warn({ err }, '[renameTrackedPathInGit] git ls-files failed, falling back to fs rename');
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
            log.warn(
              { err: rollbackErr },
              '[renameTrackedPathInGit] case-only git rename failed and rollback also failed; git index and disk may have diverged',
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
      log.warn({ err }, '[renameTrackedPathInGit] git mv failed, falling back to fs rename');
      return false;
    }
  });
}

export interface ApiExtensionOptions {
  /**
   * The boot-built ingress policy. Drives the browser-Origin allowlists (the
   * `/api/*` CORS gate + the local-op checks), the route-level Host gates,
   * and the route-level peer gates through one object — the same one the WS
   * upgrade path consults. Omitted (test rigs) ⇒ loopback-only defaults.
   */
  ingressPolicy?: IngressPolicy;
  hocuspocus: Hocuspocus;
  durabilityState: DocumentDurabilityState;
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
  localOpConcurrencyGuard?: ReturnType<typeof createConcurrencyGuard>;
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
  derivedDocumentIndex?: DerivedDocumentIndexApiPort;
  // `comments` joins main's narrowed channel union: the comment views are
  // derived from document text the same way files and lint-config are, and the
  // panel refetches off this signal.
  signalChannel?: (channel: 'files' | 'lint-config' | 'comments') => void;
  /**
   * Optional seam for the document-lifecycle hooks that comments care about.
   * Both callers (the settle extension, the file watcher) are constructed
   * before the comment service exists, so they read this at call time.
   */
  commentDocHooksRef?: { current: CommentDocHooks | null };
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
   * Example: [process.execPath, '/path/to/packages/cli/src/cli.ts'] in dev,
   *          ['open-knowledge'] in production.
   */
  localOpCliArgs?: string[];
  /**
   * Keepalive cadence for the streaming auth flows, in ms. Production uses the
   * 15s default; tests override it so the heartbeat is observable inside a
   * normal test budget without faking timers around a real HTTP stream.
   */
  authStreamHeartbeatMs?: number;
  /**
   * Path to the project's parent git working tree (i.e. the repo root, not
   * the shadow git dir). Used for upload tmp-file placement, git-relative
   * path resolution for managed renames (`renameTrackedPathInGit`), and the
   * managed-rename recovery journal (`withManagedRenameRecovery`).
   * Save-version and rollback do NOT mutate the parent git repo.
   */
  projectDir?: string;
  /**
   * SSRF-guarded fetch used by `POST /api/link-preview` for both the page and
   * the favicon. Defaults to the real `guardedFetch` chokepoint; tests inject a
   * fake that returns chosen bytes so the route → parse → cache → envelope
   * wiring can be exercised without real network egress. Production never sets
   * it, so the guard is always the real one.
   */
  linkPreviewFetch?: GuardedFetch;
  /**
   * Fresh-read getter for the project-local `linkPreviews.enabled` egress
   * opt-in — the same per-request fresh-read contract as
   * `getSemanticSimilarityFloor`, so a runtime Settings toggle applies to the
   * next hover without a restart. FAIL-CLOSED: when omitted, or when the read
   * throws, `POST /api/link-preview` treats previews as disabled and performs
   * no outbound fetch — the renderer-side gate is a UX optimization, never the
   * enforcement point.
   */
  getLinkPreviewsEnabled?: () => boolean;
  /**
   * Fresh-read collector for `GET /api/config/diagnostics` — reads the user,
   * committed-project, and project-local config files on each call so an edit
   * is reflected without a restart. Omitted in test harnesses that don't wire
   * config; the handler then reports an empty diagnostics set.
   */
  getConfigDiagnostics?: () => ConfigDiagnosticsReport;
  /**
   * Basename-index resolver for `![[photo.png]]` wiki-embed refs. Threaded
   * into every server-side `mdManager.parseWithFallback` call (managed-rename
   * body rewrite, rollback content apply) so the resulting PM image/link
   * carries the resolved src/href.
   */
  resolveEmbed?: (basename: string, sourcePath: string) => string | null;
  /**
   * Paired-intake derive-loss reporter, threaded into every
   * `reconcileDiskBeforeAgentWrite` call so the L1 reconcile's
   * FILE_WATCHER_ORIGIN ingest carries the same `detect` wiring the file
   * watcher's own path does. A GETTER, not a value: the reporter is built later
   * in server init (after the loss ring) than this extension is constructed, and
   * is absent entirely when the `bridge.lossDetector` kill-switch is off.
   */
  getBridgeLossReporter?: () => BridgeDeriveLossReporter | undefined;
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
  /** Saved-theme store lock acquisition budget. Defaults to the core helper's 5s. */
  savedThemeLockTimeoutMs?: number;
  /**
   * ACP agent catalog (registry-driven). When present, `GET /api/acp/catalog`
   * serves the featured + full agent lists the thread-launch UI renders.
   * Omitted in harnesses that don't exercise agent threads — the route then
   * answers 404.
   */
  acpRegistry?: AcpRegistry;
  /** Custom-agent source for the catalog (machine-local `.ok/local` file). */
  loadAcpCustomAgents?: () => Promise<CustomAgentEntry[]>;
  /** Test seam for server-host CLI detection surfaced in the ACP catalog. */
  acpHarnessAvailability?: () => Promise<AcpHarnessAvailability>;
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
  /**
   * Resolve the project-local `search.semantic.*` provider knobs, read FRESH so
   * the Test-connection probe hits whatever is currently persisted — the same
   * contract as the embedder loader, so a probe and a real embed can never
   * disagree about which endpoint is configured. Omitted in tests that don't
   * exercise the probe (the route then reports `no_key`-style unavailability).
   */
  readSemanticProviderConfig?: () => ResolvedSemanticConfig;
  /**
   * Resolve the project's base `contentRules` config (project scope), read FRESH
   * per request so a config edit takes effect without a restart. The lint
   * endpoints inject the native `.markdownlint.*` rules over this base.
   * Omitted in tests → falls back to `DEFAULT_LINTER_CONFIG`.
   */
  getLinterBaseConfig?: () => LinterConfig;
  /**
   * Fresh-per-request broken-link posture (`validation.links`). Omitted in
   * tests → falls back to the default ('warning').
   */
  getLinksValidationSetting?: () => LinksValidationSetting;
}

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
    const heading = scanHeadingLine(line, slugCounts);
    if (heading) headings.push(heading);
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

/**
 * Document-lifecycle events comment threads have to follow. Both are fired from
 * subsystems built before the comment service exists, so they arrive through a
 * ref rather than a direct dependency.
 */
export interface CommentDocHooks {
  /** The doc's content settled — re-anchor its threads. */
  changed: (docName: string) => void;
  /** The doc is gone — its threads go with it. */
  deleted: (docName: string) => void;
}

export function createApiExtension(
  options: ApiExtensionOptions,
): Extension & { nativeApi: NativeApiHandle; localApi: LocalApiDispatch } {
  const { durabilityState } = options;
  const ingressPolicy = options.ingressPolicy ?? buildIngressPolicy({});
  // Every local-op call site in this factory inherits the policy's admitted
  // set through this shadow — one choke point, zero per-site churn.
  const checkLocalOpSecurity = (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ): boolean => checkLocalOpSecurityBase(req, res, { ...opts, policy: ingressPolicy });
  // Same shadow for the route-level Host gates (principal, workspace, metrics,
  // the write-path gates): every admitted public name (bind literals,
  // declared publicUrl, legacy tunnel host) is as legitimate as a loopback
  // name — the mount's admit gate already vetted the surface.
  const isAllowedWorkspaceHostHeader = (host: string | undefined): boolean =>
    isHostAdmitted(host, ingressPolicy);
  // Route-level peer gates ride the policy too: loopback always passes;
  // `server.allowExternal` is the sanctioned relaxation.
  const isRoutePeerAdmitted = (remoteAddress: string | undefined): boolean =>
    isPeerAdmitted(remoteAddress, ingressPolicy);
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
    localOpConcurrencyGuard,
    enableTestRoutes = false,
    shadowRef,
    flushGitCommit,
    flushContributors,
    getCurrentBranch,
    getDiskAckSVs,
    contentRoot,
    derivedDocumentIndex,
    signalChannel,
    agentFocusBroadcaster,
    agentPresenceBroadcaster,
    onAgentWrite,
    getSyncEngine,
    localOpCliArgs = ['open-knowledge'],
    authStreamHeartbeatMs,
    projectDir,
    getBridgeLossReporter,
    getPrincipal,
    homeDirOverride,
    savedThemeLockTimeoutMs,
    acpRegistry,
    loadAcpCustomAgents,
    acpHarnessAvailability = createAcpHarnessAvailabilityProbe(),
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
    readSemanticProviderConfig,
    getLinterBaseConfig,
    getLinksValidationSetting,
    ephemeral = false,
    linkPreviewFetch,
    getLinkPreviewsEnabled,
    getConfigDiagnostics,
  } = options;

  // Concurrency guard: at most 1 in-flight request per local-op endpoint
  const localOpGuard = localOpConcurrencyGuard ?? createConcurrencyGuard();

  // Single-flight dedupe for `GET /api/history`. Keyed by the
  // full normalized query tuple (mode + branch + every param each mode reads),
  // so N concurrent identical history requests share ONE git walk and N
  // identical responses. Per-server-instance, same rationale as showAllInflight.
  const historyInflight = createSingleFlight<Awaited<ReturnType<typeof getDocumentHistory>>>();

  // The document/pages native route group is constructed HERE, well above the
  // route-table tail, because its returned `invalidateReferencedAssetsCache`
  // is called from the write spines below (create/delete/rename) — the same
  // position its cache cluster occupied before the lift. Deps are options or
  // hoisted function declarations, so early construction is safe.
  const documentRoutes = createDocumentRoutes({
    hocuspocus,
    contentDir,
    isSafeDocName,
    resolveAlias,
    resolveContentEntryPath,
    resolveDocPath,
    extractHeadings,
    getFileIndex,
    log,
    ready,
    contentFilter,
    safeSubdir,
    getShowAllMaxEntries,
    streamShowAllEntries,
    walkContentDirForShowAll,
    synthesizeShowAllAssetExt,
    getAllFilesIndex,
    getFolderIndex,
    getFolderAliasIndex,
    onReferencedAssetsCacheInvalidator,
  });
  const { invalidateReferencedAssetsCache } = documentRoutes;

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
      log.warn({ path: fullPath, err }, `folder index stat failed for ${fullPath}`);
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

  // Comments (v1) — anchored threads stored under
  // `<contentDir>/.ok/local/comments/`, machine-local and never committed.
  // App-only HTTP surface (agents reach comments through dispatch, not MCP).
  // Constructed here rather than by the routes map so the rename walk below can
  // call `commentService.renameDoc(...)`. The store's directory is created
  // lazily on first write, so constructing without awaiting is safe.
  const commentService = new CommentService({
    store: new CommentThreadStore(resolve(contentDir, OK_DIR, LOCAL_DIR), log),
    index: new CommentIndex(),
    getDocBody: (docName) => {
      // Prefer the live CRDT body; fall back to disk. Offsets are measured
      // against the body text (everything after the frontmatter).
      try {
        const doc = hocuspocus.documents.get(docName);
        if (doc) return stripFrontmatter(doc.getText('source').toString()).body;
      } catch {
        /* fall through to disk */
      }
      try {
        const filePath = resolveDocPath(docName);
        if (filePath && existsSync(filePath)) {
          return stripFrontmatter(readFileSync(filePath, 'utf-8')).body;
        }
      } catch {
        /* unreadable — treat as absent */
      }
      return null;
    },
    // Property threads address a frontmatter key — and optionally a path into
    // its value, and optionally a passage inside that. All of it re-finds
    // against the parsed record. Same live-CRDT-then-disk order as the body read
    // above, and the same null contract: null means the document could not be
    // read, which leaves thread state alone rather than orphaning it. A doc with
    // no frontmatter at all is an empty record — readable, just empty.
    getDocFrontmatter: (docName: string): Record<string, unknown> | null => {
      try {
        const doc = hocuspocus.documents.get(docName);
        if (doc) return parseFrontmatterRecord(doc.getText('source').toString()) ?? {};
      } catch {
        /* fall through to disk */
      }
      try {
        const filePath = resolveDocPath(docName);
        if (filePath && existsSync(filePath)) {
          return parseFrontmatterRecord(readFileSync(filePath, 'utf-8')) ?? {};
        }
      } catch {
        /* unreadable — treat as absent */
      }
      return null;
    },
  });

  // A doc's threads follow its lifecycle.
  if (options.commentDocHooksRef) {
    options.commentDocHooksRef.current = {
      // Settling a change re-anchors them, so a deleted passage reads as
      // orphaned instead of staying healthy-looking until someone tries to send
      // it. Only a state change is broadcast — the sweep runs on every settle
      // and is silent when nothing crossed.
      changed: (docName: string) => {
        void commentService
          .refindDoc(docName)
          .then((changed) => {
            if (changed) signalChannel?.('comments');
          })
          .catch((err) => {
            log.warn({ err, docName }, '[comments] re-anchor after document change failed');
          });
      },
      // The document is gone, so its comments go with it. Every delete route
      // reaches disk, so the watcher sees all of them and this one hook covers
      // in-app deletes, the desktop trash flow, and a file removed outside the
      // app alike.
      deleted: (docName: string) => {
        void commentService
          .deleteDoc(docName)
          .then((count) => {
            if (count > 0) signalChannel?.('comments');
          })
          .catch((err) => {
            log.warn({ err, docName }, '[comments] cleanup after document delete failed');
          });
      },
    };
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
   * relationship index wired, target not in index, has backlinks, or no candidate).
   * Non-throwing — a hint-computation failure must not fail the write.
   */
  async function computeOrphanHints(
    docName: string,
  ): Promise<Array<{ type: 'orphan'; parentCandidates: string[]; message: string }> | undefined> {
    if (!derivedDocumentIndex) return undefined;
    try {
      const backlinks = await derivedDocumentIndex.getBacklinks(docName);
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
      log.warn({ err }, '[orphan-hint] computeOrphanHints failed');
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
   * Reserved for rare, semantically anchored actions (rename, rollback, undo)
   * whose commit must land promptly — a rename's log entries stay unanchored
   * until its shadow commit exists. High-frequency agent write handlers use
   * {@link flushDocToDisk} instead so their L2 commits coalesce on the
   * persistence debounce rather than paying a whole-corpus tree build per
   * write; `handleHistory` drains any pending commit before reading, so
   * history reads still observe every completed write.
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
   * Fire-and-forget L1-only flush: force the per-document disk store without
   * forcing the L2 shadow commit. The store path always arms the L2 debounce
   * timer, so the commit still lands — coalesced with every other write in the
   * window instead of one full tree build per agent write. No-op when the
   * handler already awaited `flushDiskAndDetectOutcome` (nothing debounced).
   */
  function flushDocToDisk(docName: string, label: string): void {
    const debounceId = `onStoreDocument-${docName}`;
    if (!hocuspocus.debouncer.isDebounced(debounceId)) return;
    hocuspocus.debouncer.executeNow(debounceId).catch((err: unknown) => {
      log.warn({ err }, `[${label}] post-write disk flush failed`);
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
      durabilityState.markAgentWriteStore(docName);
      await hocuspocus.debouncer.executeNow(debounceId);
    }
    const failure = durabilityState.takeStoreFailure(docName);
    if (failure) return { kind: 'failure', failure };
    if (durabilityState.takeStoreDivergence(docName)) return { kind: 'divergence' };
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

  async function collectAdmittedDocNames(): Promise<Set<string>> {
    const admitted = new Set<string>();
    for (const [docName, entry] of getFileIndex()) {
      admitted.add(docName);
      for (const alias of entry.aliases) {
        admitted.add(alias);
      }
    }
    // Managed skill docs are link-axis participants — a doc that links to one
    // must resolve it as a known doc (title, not a dead link rendered as the raw
    // `__skill__/...` name). They live outside getFileIndex() (tree-excluded), so
    // enumerate them from disk here. The names match what the backlink index
    // normalizes link targets to. Templates need no enumeration: they are content
    // docs now, so getFileIndex() already carries them. Best-effort: a scan
    // failure just narrows the set, it never fails the link endpoint.
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
    for (const docName of (await derivedDocumentIndex?.getIndexedDocNames()) ?? []) {
      if (admitted.has(docName)) continue;
      if (!isDocNameContentExcluded(docName)) admitted.add(docName);
    }
    return admitted;
  }

  async function recordDerivedMutationsBestEffort(
    mutations: readonly DerivedDocumentIndexMutation[],
    reason: string,
  ): Promise<void> {
    if (!derivedDocumentIndex || mutations.length === 0) return;
    try {
      await derivedDocumentIndex.recordDirectMutations(mutations);
    } catch (err) {
      logDerivedProjectionFailure(
        err,
        { count: mutations.length, reason },
        '[derived-index] failed to project durable document mutations',
      );
    }
  }

  async function recordDerivedDocumentBestEffort(
    documentName: string,
    markdown: string,
    reason: string,
  ): Promise<void> {
    if (!derivedDocumentIndex) return;
    try {
      await derivedDocumentIndex.recordDirectDocument(documentName, markdown);
    } catch (err) {
      logDerivedProjectionFailure(
        err,
        { documentName, reason },
        '[derived-index] failed to project durable document',
      );
    }
  }

  async function recordDerivedLinkRewriteBestEffort(
    documentName: string,
    markdown: string,
    reason: string,
  ): Promise<void> {
    if (!derivedDocumentIndex) return;
    try {
      await derivedDocumentIndex.recordLinkRewrite(documentName, markdown);
    } catch (err) {
      logDerivedProjectionFailure(
        err,
        { documentName, reason },
        '[derived-index] failed to project link rewrite',
      );
    }
  }

  function logDerivedProjectionFailure(
    err: unknown,
    context: Record<string, unknown>,
    failureMessage: string,
  ): void {
    if (isDerivedDocumentIndexClosedError(err)) {
      log.debug(
        { err, ...context },
        '[derived-index] coordinator closed; skipping durable projection',
      );
      return;
    }
    log.warn({ err, ...context }, failureMessage);
  }

  function respondToDerivedIndexQueryFailure(
    res: ServerResponse,
    err: unknown,
    options: {
      handler: string;
      failureTitle: string;
    },
  ): void {
    if (isDerivedDocumentIndexClosedError(err)) {
      errorResponse(
        res,
        503,
        'urn:ok:error:derived-index-unavailable',
        'Derived index is shutting down.',
        {
          handler: options.handler,
          cause: err,
          logLevel: 'debug',
        },
      );
      return;
    }
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', options.failureTitle, {
      handler: options.handler,
      cause: err,
    });
  }

  async function deleteDerivedDocumentsBestEffort(
    documentNames: Iterable<string>,
    reason: string,
  ): Promise<void> {
    await recordDerivedMutationsBestEffort(
      [...documentNames].map((documentName) => ({
        kind: 'delete',
        documentName,
      })),
      reason,
    );
  }

  // Content-scoped existence oracle for non-doc outbound targets. The watcher
  // inventory is authoritative once an entry is indexed. The confined disk
  // fallback preserves immediate write advisories during the short window
  // between a native file creation and its watcher event, while applying the
  // same ignore and realpath-escape gates before admitting that file.
  function createLinkedFileExists(
    allFiles = getAllFilesIndex(),
  ): (contentRootRelativePath: string) => boolean {
    const inventory = localTargetInventoryFromIndexes(
      allFiles,
      getFolderAliasIndex?.() ?? new Map(),
      contentDir,
    );
    const admittedFiles = new Set(inventory.fileTargets);
    const canonicalContentDir = realpathSync(contentDir);
    return (contentRootRelativePath) => {
      if (admittedFiles.has(contentRootRelativePath)) return true;
      if (contentFilter?.isPathIgnored(contentRootRelativePath)) return false;

      const candidate = resolve(contentDir, contentRootRelativePath);
      if (!isWithinDir(candidate, contentDir) || !existsSync(candidate)) return false;
      try {
        return isWithinDir(realpathSync(candidate), canonicalContentDir);
      } catch (err) {
        // ENOENT is the expected TOCTOU race (deleted between existsSync and
        // realpathSync) and needs no note; anything else (EACCES, ELOOP) would
        // otherwise report a persistently absent file with no diagnostic.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.debug(
            { err, candidate },
            'linked-file existence fallback could not canonicalize; treating as absent',
          );
        }
        return false;
      }
    };
  }

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
        log.warn({ docName, err }, `[file-ops] Failed to close agent session for ${docName}`);
      });
    }

    for (const docName of docNames) {
      const document = hocuspocus.documents.get(docName);
      durabilityState.deleteReconciledBase(docName);
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
    durabilityState.setReconciledBase(docName, markdown);

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

  async function applyPendingAssetReferenceRewrites(
    pendingRewrites: readonly { docName: string; markdown: string; rewrites: number }[],
    renamedAssets: readonly RenamedAssetMapping[],
  ): Promise<{
    rewrittenDocs: ManagedRenameRewrittenDoc[];
    derivedMutations: DerivedDocumentIndexMutation[];
  }> {
    const rewrittenDocs: ManagedRenameRewrittenDoc[] = [];
    const derivedMutations: DerivedDocumentIndexMutation[] = [];
    for (const pending of pendingRewrites) {
      const document = hocuspocus.documents.get(pending.docName);
      const rewritten = document
        ? applyAssetRenamesToLoadedDocument(pending.docName, renamedAssets)
        : pending;
      if (rewritten.rewrites === 0) continue;
      writeManagedRenameDocumentToDisk(pending.docName, rewritten.markdown);
      derivedMutations.push({
        kind: 'link-rewrite',
        documentName: pending.docName,
        markdown: rewritten.markdown,
      });
      rewrittenDocs.push({ docName: pending.docName, rewrites: rewritten.rewrites });
    }
    return { rewrittenDocs, derivedMutations };
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
      const code = errnoCode(err);
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
  const listManagedDocNamesUnderFolderFromDisk = (sourcePathRoot: string): string[] =>
    listManagedDocNamesUnderFolder(sourcePathRoot, {
      contentDir,
      contentFilter,
      docNameForPath: (relPath) => docNameForFileOperationPath(contentDir, relPath),
    });

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
          if (!derivedDocumentIndex) {
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

          const { rewrittenDocs, derivedMutations } = await applyPendingAssetReferenceRewrites(
            pendingRewrites,
            renamedAssets,
          );
          await recordDerivedMutationsBestEffort(derivedMutations, 'asset-rename');
          signalChannel?.('files');

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
          if (!derivedDocumentIndex) {
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

          reconcileDiskBeforeAgentWrite(
            durabilityState,
            hocuspocus,
            sourceDocName,
            contentDir,
            undefined,
            getBridgeLossReporter?.(),
          );
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

            const rewriteResult = await applyPendingAssetReferenceRewrites(
              pendingRewrites,
              renamedAssets,
            );
            rewrittenDocs = rewriteResult.rewrittenDocs;
            await recordDerivedMutationsBestEffort(
              [{ kind: 'delete', documentName: sourceDocName }, ...rewriteResult.derivedMutations],
              'document-to-file-rename',
            );
            signalChannel?.('files');
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
          if (!derivedDocumentIndex) {
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
            const { rewrittenDocs, derivedMutations } = await applyPendingAssetReferenceRewrites(
              pendingAssetRewrites,
              renamedAssets,
            );
            await recordDerivedMutationsBestEffort(derivedMutations, 'asset-only-folder-rename');
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
            for (const entry of await derivedDocumentIndex.getBacklinks(from)) {
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
            reconcileDiskBeforeAgentWrite(
              durabilityState,
              hocuspocus,
              docName,
              contentDir,
              undefined,
              getBridgeLossReporter?.(),
            );
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
          const derivedMutations: DerivedDocumentIndexMutation[] = [];

          await withManagedRenameRecovery(projectDir ?? contentDir, recoveryJournal, async () => {
            for (const docName of missingBacklinkSources) {
              derivedMutations.push({ kind: 'delete', documentName: docName });
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

              derivedMutations.push({
                kind: 'link-rewrite',
                documentName: docName,
                markdown: rewritten.markdown,
              });
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
              durabilityState.setReconciledBase(toDocName, renamedSource.markdown);

              mutateFileIndex?.({
                kind: 'rename',
                oldPath: sourcePath,
                newPath: destinationPath,
                oldDocName: fromDocName,
                newDocName: toDocName,
                content: renamedSource.markdown,
              });

              derivedMutations.push({
                kind: 'rename',
                oldDocumentName: fromDocName,
                newDocumentName: toDocName,
                markdown: renamedSource.markdown,
              });
              // Comment threads follow the doc. Awaited, so the rename cannot
              // report done while cover sheets are still being rewritten — an
              // in-flight rewrite leaves a window where a racing read sees the
              // old docName. Still non-fatal: the in-memory index is updated
              // synchronously inside renameDoc and a failed cover-sheet write is
              // rebuilt from disk at boot, so a failure here must not take the
              // rename down with it.
              try {
                await commentService.renameDoc(fromDocName, toDocName);
              } catch (err) {
                log.warn(
                  { err, fromDocName, toDocName },
                  '[comments] cover-sheet rename failed; index updated, disk self-corrects at boot',
                );
              }
              if (renamedSource.rewrites > 0) {
                rewrittenDocs.push({ docName: toDocName, rewrites: renamedSource.rewrites });
              }
            }
            await recordDerivedMutationsBestEffort(derivedMutations, 'document-rename');

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

          signalChannel?.('files');

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
    // A skill's key is its CONTENT-DOC name — the real bundle dir + `/SKILL`,
    // which is what `/api/history` filters contributors on. Hardcoding the
    // retired `.ok/skills/<name>` store shape made every edit / move / duplicate
    // / bundle-file write fail the OkActor match, so those commits never showed
    // in the skill's own history. `projectSkillDirRel` resolves in-place first
    // and falls back to the store only for a resident not yet drained.
    if (kind === 'skill') return `${projectSkillDirRel(String(name))}/SKILL`;
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
      log.warn(
        { context, err: flushErr },
        `[${context}] flushContributors failed; attribution stays queued for the next flush`,
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
          durabilityState,
          hocuspocus,
          docName,
          contentDir,
          options.resolveEmbed,
          getBridgeLossReporter?.(),
        );

        const timestamp = new Date().toISOString();
        const content =
          typeof body.content === 'string' ? body.content : `Hello from the agent! ${timestamp}`;
        const { response: summaryResponse, stored: storedSummary } =
          summaryResponseFields(normalizedSummary);

        // Disarmed in `finally` so a write that produces no Y.Text delta (or
        // throws before its transact) never leaves an armed observer behind to
        // capture a later same-session write under this call's stale key.
        let disposeEffectCapture: (() => void) | undefined;
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
          // Arm the origin-keyed effect observer BEFORE the write transact so the
          // agent's own YTextEvent.delta is captured. Keyed on `session.origin`,
          // so the pre-drain flush below (OBSERVER_SYNC_ORIGIN) passes through
          // uncaptured instead of filing the user's keystroke as an agent effect.
          disposeEffectCapture = captureEffect(
            session.dc.document.getText('source'),
            agentId,
            session.origin,
            colorSeed,
            clientName,
          );
          // Pre-drain a non-overlapping pending keystroke into Y.Text before the
          // write's own transact (own observer-origin transact — not the agent's
          // undo frame) so the compose below rides it into the body.
          agentWritePreDrain(session.dc.document, `${content}\n`, 'append');
          // Use per-session origin, not shared AGENT_WRITE_ORIGIN (STOP rule)
          session.dc.document.transact(() => {
            const beforeBlocks = snapshotBlocks(session.dc.document);
            applyAgentMarkdownWrite(
              session.dc.document,
              `${content}\n`,
              'append',
              options.resolveEmbed
                ? { resolveEmbed: options.resolveEmbed, sourcePath: docName }
                : undefined,
              undefined,
              agentWriteLossDetect(session),
            );

            const changedBlocks =
              changedBlockRange(beforeBlocks, snapshotBlocks(session.dc.document)) ?? undefined;
            const activityMap = session.dc.document.getMap('agent-flash');
            activityMap.set(agentId, {
              agentId,
              timestamp: Date.now(),
              type: 'insert',
              description: `Added (${agentName}): ${content.slice(0, 50)}`,
              ...(changedBlocks !== undefined ? { changedBlocks } : {}),
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
          disposeEffectCapture?.();
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
        flushDocToDisk(docName, 'agent-write');
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
        // Live catch. `agent-write` appends, so it inherits `existingFm` and
        // can never trip the malformed-FM gate's first arm
        // (`finalFm !== existingFm`). It DOES reach the second arm: appending
        // content that opens with a `---` fence pair to a document with no
        // frontmatter and an empty body places that pair at byte 0, where the
        // composed document would re-read it as its frontmatter region. Not
        // dead code — deleting it turns that refusal into a 500.
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
        log.error({ err: e, requestId: getRequestId(_req) }, '[agent-write] handler failed');
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
          durabilityState,
          hocuspocus,
          resolvedDocName,
          contentDir,
          options.resolveEmbed,
          getBridgeLossReporter?.(),
        );

        // Off-thread parse precompute (parse-pool): parse the projected
        // post-write bytes on a worker BEFORE entering the transact so a
        // large-doc parse does not block concurrent requests. Advisory —
        // the byte-identity guard in bridge-intake discards it if the doc
        // moved during this await.
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

        // Site A content-divergence captured from the in-transact gate.
        // Surfaced as the response's `warning` field; structured-log on fire
        // for production observability.
        let writeDivergence: AgentWriteContentDivergence | undefined;

        // Disarmed in `finally` so a write that produces no Y.Text delta (or
        // throws before its transact) never leaves an armed observer behind to
        // capture a later same-session write under this call's stale key.
        let disposeEffectCapture: (() => void) | undefined;

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
          // Arm the origin-keyed effect observer BEFORE the write transact so the
          // agent's own YTextEvent.delta is captured. Keyed on `session.origin`,
          // so the pre-drain flush below (OBSERVER_SYNC_ORIGIN) passes through
          // uncaptured instead of filing the user's keystroke as an agent effect.
          disposeEffectCapture = captureEffect(
            session.dc.document.getText('source'),
            agentId,
            session.origin,
            colorSeed,
            clientName,
          );
          // Pre-drain a non-overlapping pending keystroke into Y.Text before the
          // write's transact so the compose below rides it into the body.
          agentWritePreDrain(session.dc.document, body.markdown, position);
          // Use per-session origin, not shared AGENT_WRITE_ORIGIN (STOP rule)
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

        flushDocToDisk(resolvedDocName, 'agent-write-md');

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
        // agent can ignore. Silent when no relationship index is wired.
        const hints = await computeOrphanHints(resolvedDocName);

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
        const admittedForLinks = await collectAdmittedDocNames();
        admittedForLinks.add(resolvedDocName);
        const brokenLinks = computeWriteAdvisoryLinks(
          writtenSource,
          resolvedDocName,
          admittedForLinks,
          createLinkedFileExists(),
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
          ...(await computeLintViolations(
            session.dc.document.getText('source').toString(),
            resolvedDocName,
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
        log.error({ err: e, requestId: getRequestId(_req) }, '[agent-write-md] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-write-md',
          cause: e,
        });
      }
    },
    { handler: 'agent-write-md', method: 'POST' },
  );

  /**
   * `POST /api/agent-write-batch` — N document writes in one HTTP call, for
   * bulk create/import flows that would otherwise pay one round-trip plus the
   * full per-write advisory suite per document.
   *
   * Semantics per entry are identical to `handleAgentWriteMd`: same
   * `applyAgentMarkdownWrite` spine under the entry doc's per-session frozen
   * origin (no new CRDT write path, no second undo surface — each doc's
   * UndoManager sees the write exactly as a single-call write), same
   * reserved-name gate re-checked per doc, same L1 reconcile-before-apply,
   * same per-doc awaited disk store so an ENOSPC-class failure or an L3
   * disk-divergence revert reports as that entry's error, never a false
   * success.
   *
   * What a batch amortizes relative to N single calls:
   *   - one HTTP round-trip, one identity extraction, one presence
   *     set/idle pair and one focus broadcast instead of N;
   *   - one `collectAdmittedDocNames()` file-index scan feeding every
   *     entry's broken-link validation;
   *   - one coalesced L2 shadow commit via the store path's existing commit
   *     debounce (per-doc L1 stores arm the same timer — the batch never
   *     forces per-doc commits, mirroring the single-write coalescing
   *     contract pinned by `agent-write-commit-coalescing.test.ts`);
   *   - the search corpus stays fingerprint-invalidated (mtime-keyed cache in
   *     `getWorkspaceSearchCorpus`), so N writes cost one rebuild on the next
   *     search, not N eager invalidations.
   *
   * The per-doc mermaid render validation, lint pass, and orphan hints are
   * deliberately NOT run here — their per-write cost is what a batch exists
   * to avoid. Callers who want those advisories use the single-write
   * endpoint; `brokenLinks` (cheap once the admitted set is shared) is kept
   * per entry.
   *
   * Outcomes are per-entry and independent (partial success by design; no
   * atomic mode): `results[i]` answers `docs[i]`, failures carry the same
   * closed URN vocabulary as the single-write endpoints, and the batch
   * response is HTTP 200 whenever the request itself was well-formed.
   */
  const handleAgentWriteBatch = withValidation(
    AgentWriteBatchRequestSchema,
    async (_req, res, body) => {
      try {
        const { agentId, agentName, colorSeed, clientName, clientVersion, label } =
          extractAgentIdentity(body);

        const timestamp = new Date().toISOString();

        // Handler-internal result shapes; the wire contract is enforced at
        // emit time by `successResponse`'s safeParse against
        // `AgentWriteBatchSuccessSchema` (the `.loose()` index signatures the
        // z.infer types carry don't unify with interface-typed helpers like
        // `BrokenOutboundLink`).
        interface BatchErrorResult {
          status: 'error';
          docName: string;
          error: { type: BatchEntryError['type']; title: string; detail?: string };
        }
        interface BatchWrittenResult {
          status: 'written';
          docName: string;
          summary?: SummaryResponse;
          warnings?: AdvisoryWarning[];
          brokenLinks: ReturnType<typeof computeWriteAdvisoryLinks>;
        }
        type BatchResult = BatchWrittenResult | BatchErrorResult;

        const entryError = (
          docName: string,
          type: BatchEntryError['type'],
          title: string,
          detail?: string,
        ): BatchErrorResult => ({
          status: 'error',
          docName,
          error: { type, title, ...(detail !== undefined ? { detail } : {}) },
        });

        /** Failure translation mirroring the single-write catch arms — same
         *  URN per error class, demoted from a wire-level response to a
         *  per-entry result so siblings keep processing. The conflict /
         *  malformed-FM branches re-emit the structured refusal events whose
         *  single-site emission normally lives in the `respond*` helpers, so
         *  the grouped-by-handler refusal counters see batch refusals too. */
        const classifyEntryFailure = (docName: string, e: unknown): BatchErrorResult => {
          if (e instanceof DocInConflictError) {
            console.warn(
              JSON.stringify({
                event: 'doc-in-conflict-write-refused',
                handler: 'agent-write-batch',
                'doc.name': docName,
              }),
            );
            return entryError(
              docName,
              'urn:ok:error:doc-in-conflict',
              'Document is in conflict.',
              'The document is in a merge-conflict state. Call conflicts({ kind: "content" }) + resolve_conflict before retrying.',
            );
          }
          if (e instanceof FrontmatterMalformedError) {
            // Same event and same detail composition as the single-doc
            // surface. Reading `parseError` directly here is what made a
            // byte-0 promotion refusal count as a YAML parse error on this
            // path alone and drop its placement hint.
            logFrontmatterRefusal(e, 'agent-write-batch');
            return entryError(
              docName,
              'urn:ok:error:frontmatter-malformed',
              'Frontmatter YAML is malformed.',
              frontmatterRefusalDetail(e),
            );
          }
          if (e instanceof AgentSessionCapacityError) {
            return entryError(
              docName,
              'urn:ok:error:too-many-agent-sessions',
              'Too many agent sessions.',
            );
          }
          log.error(
            { err: e, docName, requestId: getRequestId(_req) },
            '[agent-write-batch] entry failed',
          );
          return entryError(
            docName,
            'urn:ok:error:internal-server-error',
            'Internal server error.',
          );
        };

        interface PendingEntry {
          index: number;
          docName: string;
          session: Awaited<ReturnType<typeof sessionManager.getSession>>;
          summaryResponse?: SummaryResponse;
          warnings: AdvisoryWarning[];
        }

        const results: (BatchResult | undefined)[] = new Array(body.docs.length);
        const pending: PendingEntry[] = [];

        // One presence set/idle pair for the whole batch — per-entry
        // setPresence would spam `__system__` awareness N times for one
        // logical operation. The focus broadcast at the end navigates
        // followers to the last written doc.
        try {
          const icon = iconFromClientName(clientName);
          const color = AGENT_ICON_COLORS[icon] ?? colorFromSeed(colorSeed ?? agentId);
          agentPresenceBroadcaster?.setPresence(agentId, {
            displayName: agentName,
            icon,
            color,
            currentDoc: resolveAlias(body.docs[0].docName),
            mode: 'writing',
            ts: Date.now(),
          });

          // Apply phase: entries in array order, so duplicate docNames behave
          // like sequential writes to that doc.
          for (let i = 0; i < body.docs.length; i++) {
            const entry = body.docs[i];
            const resolvedDocName = resolveAlias(entry.docName);

            if (isSystemDoc(resolvedDocName) || isConfigDoc(resolvedDocName)) {
              results[i] = entryError(
                resolvedDocName,
                'urn:ok:error:reserved-doc-name',
                `'${resolvedDocName}' is a reserved document name.`,
              );
              continue;
            }

            try {
              if (
                entry.extension !== undefined &&
                !docNameExistsWithAnySupportedExtension(contentDir, resolvedDocName)
              ) {
                registerDocExtension(resolvedDocName, entry.extension);
              }

              const normalizedSummary = normalizeSummary(entry.summary);
              const { response: summaryResponse, stored: storedSummary } =
                summaryResponseFields(normalizedSummary);
              const session = await sessionManager.getSession(resolvedDocName, agentId, {
                displayName: agentName,
                colorSeed,
                clientName,
              });

              const reconcile = reconcileDiskBeforeAgentWrite(
                durabilityState,
                hocuspocus,
                resolvedDocName,
                contentDir,
                options.resolveEmbed,
                getBridgeLossReporter?.(),
              );

              // Off-thread parse precompute — same advisory pattern as the
              // single-write handler (byte-identity guard in bridge-intake).
              const entryEmbedResolver = options.resolveEmbed
                ? { resolveEmbed: options.resolveEmbed, sourcePath: resolvedDocName }
                : undefined;
              const entryPrecomputed = await prepareAgentMarkdownParse(
                session.dc.document,
                entry.markdown,
                entry.position ?? 'append',
                entryEmbedResolver,
              );

              let writeDivergence: AgentWriteContentDivergence | undefined;
              // Arm the origin-keyed effect observer BEFORE the write transact so
              // the agent's own YTextEvent.delta is captured. Per-entry scope: the
              // disposer runs right after this entry's transact so an entry whose
              // compose is a no-op cannot capture the NEXT entry's delta.
              const disposeEntryEffectCapture = captureEffect(
                session.dc.document.getText('source'),
                agentId,
                session.origin,
                colorSeed,
                clientName,
              );
              // Pre-drain a non-overlapping pending keystroke into Y.Text before
              // this entry's transact so the compose below rides it into the
              // body. Its own observer-origin transact — never nested inside the
              // agent's, which would capture the flush into the undo frame.
              agentWritePreDrain(session.dc.document, entry.markdown, entry.position ?? 'append');
              try {
                // Use per-session origin, not shared AGENT_WRITE_ORIGIN (STOP rule)
                session.dc.document.transact(() => {
                  const beforeBlocks = snapshotBlocks(session.dc.document);
                  writeDivergence = applyAgentMarkdownWrite(
                    session.dc.document,
                    entry.markdown,
                    entry.position ?? 'append',
                    entryEmbedResolver,
                    entryPrecomputed,
                    agentWriteLossDetect(session),
                  );

                  const changedBlocks =
                    changedBlockRange(beforeBlocks, snapshotBlocks(session.dc.document)) ??
                    undefined;
                  const activityMap = session.dc.document.getMap('agent-flash');
                  activityMap.set(agentId, {
                    agentId,
                    timestamp: Date.now(),
                    type: 'insert',
                    description: `Added (${agentName}): ${entry.markdown.trim().slice(0, 50)}`,
                    ...(changedBlocks !== undefined ? { changedBlocks } : {}),
                  });
                }, session.origin);
              } finally {
                disposeEntryEffectCapture();
              }

              recordContentDivergenceGate('agent-write-batch', writeDivergence);
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

              const reconcileWarning = buildReconcileWarning(reconcile);
              const warnings: AdvisoryWarning[] = [
                ...(writeDivergence !== undefined
                  ? [toContentDivergenceWarning(writeDivergence)]
                  : []),
                ...(reconcileWarning ? [reconcileWarning] : []),
              ];
              pending.push({
                index: i,
                docName: resolvedDocName,
                session,
                summaryResponse,
                warnings,
              });
            } catch (e) {
              results[i] = classifyEntryFailure(resolvedDocName, e);
            }
          }

          // Flush phase: one awaited L1 disk store per unique doc, after every
          // CRDT write has applied — disk truth per entry without interleaving
          // store cycles between writes. Each store arms the shared L2 commit
          // debounce; the batch never forces a per-doc shadow commit.
          const flushErrors = new Map<string, BatchErrorResult['error'] | undefined>();
          for (const p of pending) {
            if (flushErrors.has(p.docName)) continue;
            const flushOutcome = await flushDiskAndDetectOutcome(p.docName);
            if (flushOutcome?.kind === 'failure') {
              const reason = classifyUploadErrno({
                code: flushOutcome.failure.code,
              } as NodeJS.ErrnoException);
              flushErrors.set(p.docName, {
                type: reason,
                title: 'Write applied in memory but failed to persist to disk.',
                detail: `${flushOutcome.failure.code ?? 'unknown error'}: ${flushOutcome.failure.message}. The content was NOT saved and will be lost if the server restarts.`,
              });
            } else if (flushOutcome?.kind === 'divergence') {
              flushErrors.set(p.docName, {
                type: 'urn:ok:error:disk-divergence',
                title:
                  'The document changed on disk after your edit was prepared; your edit was NOT applied. Re-read the document and retry.',
              });
            } else {
              flushErrors.set(p.docName, undefined);
            }
          }

          // Advisory phase: broken-link validation from the just-written
          // source bytes, with the O(corpus) admitted-set scan paid once for
          // the whole batch. Every flushed batch doc joins the admitted set
          // first so intra-batch links (doc A -> doc B written in the same
          // call) validate regardless of entry order.
          const admittedForLinks = await collectAdmittedDocNames();
          for (const p of pending) {
            if (flushErrors.get(p.docName) === undefined) admittedForLinks.add(p.docName);
          }
          const linkedFileExists = createLinkedFileExists();

          let lastWrittenDoc: string | undefined;
          for (const p of pending) {
            const flushError = flushErrors.get(p.docName);
            if (flushError !== undefined) {
              results[p.index] = { status: 'error', docName: p.docName, error: flushError };
              continue;
            }
            const writtenSource = p.session.dc.document.getText('source').toString();
            registerWrittenDocInFileIndex(p.docName, writtenSource);
            const brokenLinks = computeWriteAdvisoryLinks(
              writtenSource,
              p.docName,
              admittedForLinks,
              linkedFileExists,
            );
            results[p.index] = {
              status: 'written',
              docName: p.docName,
              ...(p.summaryResponse ? { summary: p.summaryResponse } : {}),
              ...(p.warnings.length > 0 ? { warnings: p.warnings } : {}),
              brokenLinks,
            };
            lastWrittenDoc = p.docName;
          }

          if (lastWrittenDoc !== undefined) {
            agentFocusBroadcaster?.setFocus(agentId, {
              agentName,
              currentDoc: lastWrittenDoc,
              writeKind: 'write',
              ts: Date.now(),
            });
            onAgentWrite?.();
          }
        } finally {
          agentPresenceBroadcaster?.touchMode(agentId, 'idle');
        }

        const finalResults: BatchResult[] = results.map(
          (r, i) =>
            r ??
            entryError(
              body.docs[i].docName,
              'urn:ok:error:internal-server-error',
              'Internal server error.',
            ),
        );
        const written = finalResults.filter((r) => r.status === 'written').length;
        successResponse(
          res,
          200,
          AgentWriteBatchSuccessSchema,
          {
            timestamp,
            results: finalResults,
            written,
            failed: finalResults.length - written,
          },
          { handler: 'agent-write-batch' },
        );
      } catch (e) {
        log.error({ err: e, requestId: getRequestId(_req) }, '[agent-write-batch] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-write-batch',
          cause: e,
        });
      }
    },
    { handler: 'agent-write-batch', method: 'POST' },
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
          durabilityState,
          hocuspocus,
          resolvedDocName,
          contentDir,
          options.resolveEmbed,
          getBridgeLossReporter?.(),
        );

        // Optimistic off-thread parse precompute (parse-pool): apply the FM
        // patch to a PRE-transact snapshot and parse the guessed full bytes
        // on a worker. The in-transact applyPatchToFm below stays
        // authoritative; the byte-identity guard in bridge-intake discards
        // a stale guess. No embed resolver here, mirroring the inline call
        // below.
        const fmPatchPrecomputed = await prepareFrontmatterPatchParse(session.dc.document, patch);

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
                  // Same boundary as the panel binding's commit funnel, same
                  // primitive: emptying the region on a document whose body
                  // opens with a rule pair would hand those bytes to the next
                  // partition. Verified end-to-end at `/api/frontmatter-patch`
                  // because this path reaches disk.
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
        const admittedForLinks = await collectAdmittedDocNames();
        admittedForLinks.add(resolvedDocName);
        const brokenLinks = computeWriteAdvisoryLinks(
          session.dc.document.getText('source').toString(),
          resolvedDocName,
          admittedForLinks,
          createLinkedFileExists(),
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
        log.error({ err: e, requestId: getRequestId(_req) }, '[frontmatter-patch] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'frontmatter-patch',
          cause: e,
        });
      }
    },
    { handler: 'frontmatter-patch', method: 'POST' },
  );

  /**
   * Read-only cross-harness installed-skill enumeration. `GET /api/skills/installed`
   * returns `{ skills, packs }` — every skill OK can see across all harness
   * homes (Claude plugins + the bare skill dirs), normalized + de-duped. Pure
   * read: no home is mutated (NOT in MUTATING_ROUTES). 200 with empty arrays on
   * a machine with nothing installed.
   */
  const handleSkillsInstalled = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        // The catalog is machine-global; the detected sidebar shows it under the
        // OPEN project's scopes. Two moves keep it faithful to the project |
        // global invariant (precedent #50): (1) resolve a linked worktree to its
        // parent-checkout identity so the parent's project-scoped installs
        // (keyed on the parent path) still match here; (2) ALSO scan this
        // project's `.<harness>/skills` dirs so every harness's project skills
        // surface, not just Claude plugins. The SAME identity is used to scan,
        // stamp, and filter — drop skills bound to a *different* project.
        const identity = resolveProjectIdentity(projectDir ?? contentDir);
        const catalog = enumerateInstalledSkills({ projectDir: identity });
        // In-place editor-dir skills are first-class `/api/skills`
        // entries at BOTH scopes — dropping them here keeps the same skill from
        // double-listing as a "detected" row. What remains detected: plugin-cache
        // skills (`~/.claude/plugins/**`), which the in-place scans don't cover.
        const inPlaceNames = new Set(scanInPlaceSkills(contentDir).map((s) => s.name));
        const globalInPlaceNames = new Set(scanGlobalInPlaceSkills(skillsHome).map((s) => s.name));
        const result = {
          ...catalog,
          skills: catalog.skills
            .filter(
              (s) =>
                isDetectedSkillInProject(s.provenance, identity) &&
                !(s.provenance.scope === 'project'
                  ? inPlaceNames.has(s.name)
                  : globalInPlaceNames.has(s.name)),
            )
            // `identity` is the PARENT checkout for a linked worktree, so a skill
            // can match the project while living in a tree the user does not have
            // open. Stamp that so the client can refuse an in-place edit that would
            // land in another checkout on another branch.
            //
            // The reference is the OPEN PROJECT ROOT — `projectDir ?? contentDir`,
            // the same expression `identity` is derived from but WITHOUT the
            // worktree→parent resolution. Not `identity` (that resolution makes the
            // test vacuously false), and not `contentDir`: under `content.dir: docs`
            // contentDir is `<projectDir>/docs` while harness skill dirs sit at
            // `<projectDir>/.codex/skills/…`, so every project skill in the user's
            // OWN checkout would be flagged foreign.
            .map((s) =>
              isSkillOutsideOpenProject(s.provenance, s.home, projectDir ?? contentDir)
                ? { ...s, outsideProject: true }
                : s,
            ),
        };
        successResponse(res, 200, SkillsInstalledSuccessSchema, result, {
          handler: 'skills-installed',
        });
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to enumerate installed skills.',
          { handler: 'skills-installed', cause: e },
        );
      }
    },
    { handler: 'skills-installed', method: 'GET', skipBodyParse: true },
  );

  /**
   * Bulk unresolved-comment-count lookup, the read-side counterpart to
   * `/api/backlink-counts`. `GET /api/comment-counts?docNames=a,b,c` returns
   * `{ counts: { a: 2, b: 0 } }`; `?prefix=folder` returns the same shape for
   * every doc under that folder that carries threads (sparse — a comment-free
   * subtree yields `{}`), which is how an `ls` entry gets a folder rollup
   * without a request per file.
   *
   * Read-only, so it stays out of `MUTATING_ROUTES` — unlike `/api/comments`,
   * whose POST creates threads. docNames failing `isSafeDocName` are silently
   * dropped, matching backlink-counts; a malformed `prefix` is a 400 because
   * dropping it would silently widen the query to the whole project.
   */
  const handleCommentCounts = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const prefix = url.searchParams.get('prefix');
        const raw = url.searchParams.get('docNames');
        if (prefix === null && raw === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Missing docNames or prefix parameter.',
            { handler: 'comment-counts' },
          );
          return;
        }
        let counts: Record<string, number> = {};
        if (prefix !== null) {
          const trimmed = prefix.trim();
          if (trimmed !== '' && !isSafeDocName(trimmed)) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid prefix parameter.', {
              handler: 'comment-counts',
            });
            return;
          }
          counts = Object.fromEntries(await commentService.countThreads({ prefix: trimmed }));
        } else {
          const docNames = (raw ?? '')
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name !== '' && isSafeDocName(name));
          counts = Object.fromEntries(await commentService.countThreads({ docNames }));
        }
        successResponse(
          res,
          200,
          CommentCountsSuccessSchema,
          { counts },
          {
            handler: 'comment-counts',
          },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read comment counts.',
          { handler: 'comment-counts', cause: e },
        );
      }
    },
    { handler: 'comment-counts', method: 'GET', skipBodyParse: true },
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
          durabilityState,
          hocuspocus,
          docName,
          contentDir,
          options.resolveEmbed,
          getBridgeLossReporter?.(),
        );

        // Optimistic off-thread parse precompute (parse-pool): splice the
        // find/replace against a PRE-transact snapshot and parse the guessed
        // post-patch bytes on a worker. The in-transact splice below stays
        // the single authoritative compose — if the doc moved during this
        // await the recomposed bytes differ and the byte-identity guard in
        // bridge-intake discards the guess (inline parse, prior behavior).
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
        // Site A content-divergence captured from the in-transact gate.
        // Surfaced as the response's `warning` field on successful patches.
        let patchDivergence: AgentWriteContentDivergence | undefined;
        // Disarmed in `finally` so a patch that finds no match (and therefore
        // produces no Y.Text delta) never leaves an armed observer behind to
        // capture a later same-session write under this call's stale key.
        let disposeEffectCapture: (() => void) | undefined;
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
          // Arm the origin-keyed effect observer BEFORE the write transact so the
          // agent's own YTextEvent.delta is captured, never a foreign-origin write
          // that lands between arming and the transact.
          disposeEffectCapture = captureEffect(
            session.dc.document.getText('source'),
            agentId,
            session.origin,
            colorSeed,
            clientName,
          );
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

            // The FM-intersection check, and the ONLY one. `pos <
            // currentFm.length` is necessary and sufficient: the FM region is
            // contiguous at doc start, so a match starting before its end byte
            // overlaps it and a match at or after cannot. Catches both the
            // yaml-shaped find copied out of the FM block and the plain-word
            // find (e.g. `draft`) that happens to first-match inside it —
            // without refusing those same strings when they live in the body.
            // A string-shape precheck used to reject any find containing a
            // line-anchored `---` or a `key: value` line before reading the
            // doc at all; it refused body thematic breaks and prose, and the
            // agent's only recourse was a whole-document `write` that clobbers
            // concurrent writers.
            if (pos < currentFm.length) {
              fmIntersect = true;
              return;
            }

            const newFull =
              currentFull.slice(0, pos) + replace + currentFull.slice(pos + find.length);

            // Frontmatter-PROMOTION check, the mirror of the intersection
            // check above. A document with no FM has no region to protect by
            // position, so a match at byte 0 whose `replace` opens a `---`
            // fence pair silently turns the agent's body text into the
            // document's frontmatter region — creating frontmatter through the
            // one surface whose whole contract is "body only". Refuse it: this
            // handler already tells agents that frontmatter edits go through
            // `edit({ document: { path, frontmatter } })`, and a find/replace
            // that CREATES frontmatter is a frontmatter edit.
            if (currentFm === '' && stripFrontmatter(newFull).frontmatter !== '') {
              fmPromoted = true;
              return;
            }

            // The promotion guard above is what keeps this splice honest: every
            // payload that survives it recomposes with its FM region byte-
            // identical to `currentFm`, so stripping it back off here cannot
            // drop anything. `applyAgentMarkdownWrite` then reads the current
            // FM from the YAML region of Y.Text and keeps it intact for the
            // body-only payload — `finalFm === existingFm` still always holds
            // from this handler. `'patch'` (NOT `'replace'`) routes the write
            // through the INCREMENTAL primitive, so this surgical find/replace
            // produces a minimal item-preserving Y.Text delta instead of an
            // atomic whole-doc overwrite — replace stays atomic, the edit body
            // find/replace stays surgical.
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

        flushDocToDisk(docName, 'agent-patch');

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
        const admittedForLinks = await collectAdmittedDocNames();
        admittedForLinks.add(docName);
        const brokenLinks = computeWriteAdvisoryLinks(
          patchedSource,
          docName,
          admittedForLinks,
          createLinkedFileExists(),
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
          ...(await computeLintViolations(
            session.dc.document.getText('source').toString(),
            docName,
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
        log.error({ err: e, requestId: getRequestId(_req) }, '[agent-patch] handler failed');
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
   * Body: { docName?, connectionId, scope?: 'last' | 'session' | 'file' | 'count', count? }
   *   connectionId — the session's agentId (matches sessionManager key)
   *   scope — 'last' undoes the top UM stack item; 'session'/'file' undoes all;
   *           'count' pops the `count` newest items (scoped "undo to edit N").
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

        // 'file' scope is a thin alias for 'session' (all bursts on this file's
        // session). 'count' pops the N newest frames — the undo-timeline's
        // scoped "undo to edit N" range; `count` rides through to applyAgentUndo.
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
            count,
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
        log.error({ err: e, requestId: getRequestId(_req) }, '[agent-undo] handler failed');
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
        log.error({ err: e, requestId: getRequestId(req) }, '[agent-activity] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-activity',
          cause: e,
        });
      }
    },
    { handler: 'agent-activity', method: 'GET', skipBodyParse: true },
  );

  /**
   * GET /api/agent-burst-diff?agentId=<connId>&docName=<path>&keptCount=<n>
   * Returns whole-page unified-diff text for a file *version* — the original
   * (pre-agent) doc vs. the doc with the first `keptCount` edits applied. So
   * keptCount 0 is the empty/original file and keptCount N is the current doc.
   * Exempt from extractAgentIdentity — read-only, no CRDT mutation.
   */
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
        // keptCount ranges 0 (original) .. undoStack.length (now, all edits).
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
        const { diff, before, after } = synthesizeVersionDiff(
          // biome-ignore lint/suspicious/noExplicitAny: Y.StackItem is internal to yjs — structural shape matches YjsStackItemShape in agent-activity.ts
          um.undoStack as any,
          keptCount,
          ytext,
          docName,
        );
        // `generatedAt` is the server's wall clock at response time (used for
        // client-side cache staleness). The StackItem's capture timestamp is
        // already carried in `/api/agent-activity`'s `bursts[].ts` — no need
        // to duplicate it here. `before`/`after` are the frontmatter-stripped
        // bodies for the client's WYSIWYG diff (Source mode uses `diff`).
        successResponse(
          res,
          200,
          AgentBurstDiffSuccessSchema,
          { diff, before, after, generatedAt: Date.now() },
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

  /**
   * POST /api/test-flush-git — await the L2 git-commit pipeline to settle.
   *
   * Agent-write handlers fire `flushDocToDisk` FIRE-AND-FORGET and leave the
   * L2 shadow commit to the persistence debounce, so a test that needs the
   * WIP commit durable can only poll the timeline against a wall-clock
   * budget — and under CI load the serial git-subprocess chain (global
   * one-commit-in-flight mutex in persistence.ts) blows any fixed budget.
   * This route lets tests AWAIT the actual commit completion instead of
   * racing it: it drains the pending L2 debounce timer and any in-flight
   * commit before responding. Callers should flush-then-check inside their
   * poll loop — the fire-and-forget chain may not have scheduled L2 yet on
   * the first iteration.
   */
  const handleTestFlushGit = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        await flushGitCommit?.();
        successResponse(res, 200, TestFlushGitSuccessSchema, {}, { handler: 'test-flush-git' });
      } catch (e) {
        log.error({ err: e, requestId: getRequestId(_req) }, '[test-flush-git] flush failed');
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
        // Truncates the doc file to '' BY DESIGN — reset means empty. A test
        // or probe that reads the on-disk bytes after `client.cleanup()` (which
        // calls this route) observes the truncation, not data loss; read the
        // file BEFORE cleanup, or detach the provider directly instead.
        writeFileSync(filePath, '', 'utf-8');
        await derivedDocumentIndex?.testOnly?.resetDocumentForTest(docName);

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
            log.warn({ err }, '[test-reset] okignore reset partial failure');
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
   * This endpoint forces an authoritative relationship-index rescan from disk,
   * resync from the filesystem that covers dropped events. It is NOT suitable
   * for production: rebuild wipes any in-memory backlink state not yet
   * debounced to disk (e.g. a live agent-write awaiting persistence). Gated
   * behind `enableTestRoutes` for that reason.
   */
  const handleTestRescanBacklinks = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        if (!derivedDocumentIndex?.testOnly) {
          errorResponse(
            res,
            503,
            'urn:ok:error:backlink-index-not-configured',
            'Backlink index is not configured.',
            { handler: 'test-rescan-backlinks' },
          );
          return;
        }
        await derivedDocumentIndex.testOnly.rescanBacklinksForTest();
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

  const versionOpsService = createVersionOpsService({ getCurrentBranch, contentRoot });
  const skillPlacementOps = createSkillPlacementOpsService();

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

        // Agent-scoped writer (MCP checkpoint tool path); the service applies
        // the explicit > agent-scoped > fold-everything precedence.
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

      // Read-your-writes: agent write handlers no longer force an L2 shadow
      // commit per write (they ride the persistence debounce), so drain any
      // pending commit before querying — a `history` call issued right after a
      // write must list that write. No-op when nothing is pending. The flush
      // blocks the response, so surface slow (cold-index) drains in the logs.
      try {
        const flushStart = performance.now();
        await flushGitCommit?.();
        const flushMs = performance.now() - flushStart;
        if (flushMs > 1000) {
          log.warn({ durationMs: Math.round(flushMs) }, '[history] pre-read commit flush slow');
        }
      } catch (err) {
        log.warn({ err }, '[history] pre-read commit flush failed');
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
        (name) => docTreePathCandidates(name, resolvedContentRoot),
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
        // Off-thread parse precompute: `markdown` (the target-version bytes)
        // is fixed before this point, so unlike the compose-based writes the
        // precompute can never go stale — the byte-identity guard always
        // matches. A failed precompute degrades to the inline parse.
        const rollbackPrecomputed = await precomputeParse(markdown, rollbackEmbedResolver);
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
        // rather than waiting for the natural ~4s L1+L2 debounce stack.
        // Rollback intentionally keeps the prompt `flushDocToGit` helper —
        // unlike the high-frequency agent-write handlers, which use
        // `flushDocToDisk` and let the commit ride the debounce — rather than
        // a raw `flushGitCommit()` which no-ops when no L2 timer is set yet.
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
   * it runs would observe this server's initial `'main'` default instead of
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
        // during the boot window reads this server's initial `'main'`
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
        const currentBranch = durabilityState.getActiveBranch();
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

  const AcpCatalogAgentSchema = z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    license: z.string().optional(),
    iconUrl: z.string().optional(),
    website: z.string().optional(),
    source: z.enum(['registry', 'custom']),
    /** A launchable distribution exists for this host platform. */
    supported: z.boolean(),
    featured: z.boolean(),
    harness: z
      .object({
        cli: z.enum(['claude', 'codex', 'cursor', 'gemini', 'opencode', 'pi']),
        availability: z.enum(['present', 'not-found', 'unknown']),
      })
      .optional(),
  });
  const AcpCatalogSuccessSchema = z.object({
    agents: z.array(AcpCatalogAgentSchema),
    /** True when served from the offline fallback cache. */
    stale: z.boolean(),
    maxThreads: z.number(),
  });

  const handleAcpCatalog = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      if (acpRegistry === undefined) {
        errorResponse(res, 404, 'urn:ok:error:not-found', 'ACP catalog unavailable.', {
          handler: 'acp-catalog',
        });
        return;
      }
      try {
        const platform = registryPlatformKey();
        const { agents, stale } = await acpRegistry.getCatalog();
        const custom = (await loadAcpCustomAgents?.()) ?? [];
        const harnessAvailability = await acpHarnessAvailability();
        const rows = [
          ...agents.map((a) => {
            const harnessCli = ACP_AGENT_HARNESS_CLIS[a.id];
            return {
              id: a.id,
              name: a.name,
              version: a.version,
              ...(a.description !== undefined ? { description: a.description } : {}),
              ...(a.license !== undefined ? { license: a.license } : {}),
              ...(a.icon !== undefined ? { iconUrl: a.icon } : {}),
              ...(a.website !== undefined ? { website: a.website } : {}),
              source: 'registry' as const,
              supported:
                a.distribution.npx !== undefined ||
                a.distribution.uvx !== undefined ||
                (platform !== null && a.distribution.binary?.[platform] !== undefined),
              featured: FEATURED_AGENT_IDS.includes(a.id),
              ...(harnessCli !== undefined
                ? {
                    harness: {
                      cli: harnessCli,
                      availability: harnessAvailability[harnessCli] ?? 'unknown',
                    },
                  }
                : {}),
            };
          }),
          ...custom.map((c: CustomAgentEntry) => ({
            id: c.id,
            name: c.name,
            version: 'custom',
            source: 'custom' as const,
            supported: true,
            featured: false,
          })),
        ];
        successResponse(
          res,
          200,
          AcpCatalogSuccessSchema,
          { agents: rows, stale, maxThreads: MAX_ACP_THREADS },
          { handler: 'acp-catalog', extraHeaders: { 'Cache-Control': 'no-store' } },
        );
      } catch (e) {
        errorResponse(
          res,
          502,
          'urn:ok:error:registry-unreachable',
          'Agent registry unreachable.',
          {
            handler: 'acp-catalog',
            cause: e,
          },
        );
      }
    },
    { handler: 'acp-catalog', method: 'GET', skipBodyParse: true },
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
    if (!isRoutePeerAdmitted(req.socket.remoteAddress)) {
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

  async function handleEmbedDetect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Diagnostic endpoint for the Cursor / Codex / Claude Code embedded-viewer
    // detection spikes. Reads from the in-process ring buffer populated in
    // `onRequest` and surfaces boolean signals derived from the most recent
    // entry's UA. Loopback + Host-header gated — same pattern as
    // `handlePrincipal` / `handleMetricsAgentPresence`. Disclosed fields
    // (full request headers, remote address) are local-editing-only signals.
    if (!isRoutePeerAdmitted(req.socket.remoteAddress)) {
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
    if (!isRoutePeerAdmitted(req.socket.remoteAddress)) {
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
      const code = errnoCode(err);
      if (code === 'ENOENT') {
        log.warn(
          { path: resolvedRoot },
          '[workspace] contentDir does not exist; returning unresolved path',
        );
        symlinkResolved = false;
      } else {
        log.warn({ path: resolvedRoot, err }, '[workspace] realpath failed for contentDir');
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

  const assetService = createAssetService({
    contentDir,
    // `isPathIgnored` rather than `isExcluded` so the sibling-asset heuristic
    // does not reject legitimate cross-directory references. Exclusion is
    // reported as not-found: the wire shape stays identical to a missing file.
    isPathIgnored: (relativePath) => contentFilter?.isPathIgnored(relativePath) ?? false,
    getAttachmentFolderPath,
  });
  const ASSET_SERVE_ERRORS = {
    'missing-path': [400, 'urn:ok:error:invalid-request', 'Missing asset path.'],
    'unsupported-type': [415, 'urn:ok:error:unsupported-asset-type', 'Unsupported asset type.'],
    'not-found': [404, 'urn:ok:error:asset-not-found', 'Asset not found.'],
    'invalid-path': [400, 'urn:ok:error:invalid-request', 'Invalid asset path.'],
  } as const;

  const handleAsset = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const assetPath = url.searchParams.get('path');
        const resolution = assetService.resolveServableAsset(assetPath);
        if (!resolution.ok) {
          const [status, type, title] = ASSET_SERVE_ERRORS[resolution.reason];
          errorResponse(res, status, type, title, {
            handler: 'asset',
            ...(resolution.cause !== undefined ? { cause: resolution.cause } : {}),
          });
          return;
        }
        const { asset } = resolution;
        const headers: Record<string, string> = {
          'Content-Type': asset.contentType,
          'Content-Length': String(asset.size),
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': asset.disposition,
          'Cache-Control': 'no-store',
        };
        if (asset.csp !== null) {
          headers['Content-Security-Policy'] = asset.csp;
        }
        const canonicalPath = asset.canonicalPath;
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
        const resolution = assetService.resolveTextAsset(assetPath);
        if (!resolution.ok) {
          const [status, type, title] = ASSET_SERVE_ERRORS[resolution.reason];
          errorResponse(res, status, type, title, {
            handler: 'asset-text',
            ...(resolution.cause !== undefined ? { cause: resolution.cause } : {}),
          });
          return;
        }
        if (resolution.size > TEXT_VIEW_MAX_BYTES) {
          errorResponse(
            res,
            413,
            'urn:ok:error:payload-too-large',
            `File exceeds the ${TEXT_VIEW_MAX_BYTES}-byte text-viewer cap.`,
            { handler: 'asset-text' },
          );
          return;
        }
        const bytes = await readFile(resolution.canonicalPath);
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
                  log.debug({ err: e }, '[rescue] cleanup failed (non-critical)');
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

        const docName = stripDocExtension(filePath);
        // Synchronous through recordContributor below: an async yield between
        // the write and the contributor recording lets a pending shadow-commit
        // timer drain the accumulator without this file's attribution.
        const createOutcome = fileOpsService.createPage({
          fullPath,
          docName,
          initialContent,
        });
        if (!createOutcome.ok) {
          errorResponse(res, 409, 'urn:ok:error:doc-already-exists', 'File already exists.', {
            handler: 'create-page',
            cause: createOutcome.cause,
          });
          return;
        }
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
        await recordDerivedDocumentBestEffort(docName, initialContent, 'create-page');
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

  const fileOpsService = createFileOpsService({
    contentDir,
    resolveContentEntryPath,
    docNameForPath: (relPath) => docNameForFileOperationPath(contentDir, relPath),
    docNameToRelativePath,
    listManagedDocNamesUnderFolder: (absFolderPath) =>
      listManagedDocNamesUnderFolderFromDisk(absFolderPath),
    listAffectedDocNames: (index, kind, path) =>
      listAffectedDocNames(index as Map<string, FileIndexEntry>, kind, path),
    getFileIndex,
    getConflictedFiles: () =>
      new Set(
        getSyncEngine?.()
          ?.getConflicts()
          .map((c) => c.file) ?? [],
      ),
    isDocNameInLifecycleConflict: (docName) => {
      const doc = hocuspocus.documents.get(docName);
      return doc !== undefined && isDocInConflict(doc);
    },
    captureAndCloseDocuments,
    markRecentlyRemoved: recentlyRemovedDocs
      ? (docName) => recentlyRemovedDocs.setDeleted(docName)
      : undefined,
    mutateFileIndexDelete: mutateFileIndex
      ? ({ path, docName }) => mutateFileIndex({ kind: 'delete', path, docName })
      : undefined,
    removeFolderIndexEntries,
    upsertFolderIndexPathSegments,
    deleteDerivedDocumentsBestEffort,
    invalidateReferencedAssetsCache,
    signalFiles: () => signalChannel?.('files'),
    nextAvailableDuplicateDocName: (sourceDocName) =>
      nextAvailableDuplicateDocName(contentDir, sourceDocName),
    nextAvailableDuplicateFolderPath: (sourceFolderPath) =>
      nextAvailableDuplicateFolderPath(contentDir, sourceFolderPath),
    resolveDuplicateDocPath: (docName, extension) =>
      resolveDuplicateDocPath(contentDir, docName, extension),
    collectMarkdownCopies: (folderPath) => collectMarkdownCopies(contentDir, folderPath),
    collectFolderPaths: (folderPath) => collectFolderPaths(contentDir, folderPath),
    contentFilter: contentFilter ?? undefined,
    unmarkRecentlyRemoved: recentlyRemovedDocs
      ? (docName) => recentlyRemovedDocs.delete(docName)
      : undefined,
    mutateFileIndexCreate: mutateFileIndex
      ? ({ path, docName, content }) => mutateFileIndex({ kind: 'create', path, docName, content })
      : undefined,
    recordDerivedDocumentBestEffort,
    recordDerivedMutationsBestEffort,
  });

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

        const outcome = fileOpsService.createFolder(folderPath);
        if (!outcome.ok) {
          errorResponse(res, 409, 'urn:ok:error:doc-already-exists', 'Folder already exists.', {
            handler: 'create-folder',
          });
          return;
        }
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

        const outcome = await fileOpsService.duplicatePath(kind, requestedPath, requestedDocName);
        if (!outcome.ok) {
          switch (outcome.kind) {
            case 'not-found':
              errorResponse(res, 404, 'urn:ok:error:doc-not-found', `${kind} does not exist.`, {
                handler: 'duplicate-path',
              });
              return;
            case 'type-mismatch':
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                `Target path is not a ${kind}.`,
                { handler: 'duplicate-path' },
              );
              return;
            case 'conflict':
              respondDocInConflict(
                res,
                new DocInConflictError({ file: outcome.file }),
                'duplicate-path',
              );
              return;
            case 'destination-excluded':
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                kind === 'file'
                  ? 'Duplicated document destination is excluded by the project content config.'
                  : 'Duplicated folder destination is excluded by the project content config.',
                { handler: 'duplicate-path' },
              );
              return;
            case 'already-exists':
              errorResponse(
                res,
                409,
                'urn:ok:error:doc-already-exists',
                `A ${kind} at the duplicate destination already exists.`,
                { handler: 'duplicate-path', cause: outcome.cause },
              );
              return;
            default: {
              const _exhaustive: never = outcome;
              throw new Error(
                `Unhandled duplicate outcome: ${String((_exhaustive as { kind?: unknown }).kind)}`,
              );
            }
          }
        }
        const { duplicatedPath, duplicatedDocNames } = outcome;

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
              log.warn(
                { err: flushErr },
                '[rename-path] flushContributors failed after asset rename (commitSha backfill may be deferred)',
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
            log.warn(
              { err: flushErr },
              '[rename-path] flushContributors failed (commitSha backfill may be deferred)',
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

        const outcome = await fileOpsService.deletePath(operationKind, operationPath);
        if (!outcome.ok) {
          if (outcome.kind === 'not-found') {
            errorResponse(
              res,
              404,
              'urn:ok:error:doc-not-found',
              `${operationKind} does not exist.`,
              { handler: 'delete-path' },
            );
          } else if (outcome.kind === 'type-mismatch') {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              `Target path is not a ${operationKind}.`,
              { handler: 'delete-path' },
            );
          } else {
            respondDocInConflict(
              res,
              new DocInConflictError({ file: outcome.file }),
              'delete-path',
            );
          }
          return;
        }
        successResponse(
          res,
          200,
          DeletePathSuccessSchema,
          { deletedDocNames: outcome.deletedDocNames },
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
            const { deletedDocNames } = await fileOpsService.trashCleanup(
              operationKind,
              path,
              operationDocName,
              'handleTrashCleanup',
            );
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

    const outcome = await assetService.storeUpload({
      tempPath,
      sha,
      byteLength,
      filename,
      parentDocName,
      placement,
    });
    if (outcome.ok) {
      log.info(
        {
          event: 'upload',
          endpoint: req.url ?? '/api/upload',
          agentId,
          agentName,
          dedup: outcome.deduped,
          mime: outcome.mime,
          size: byteLength,
          // `destPath` is the contentDir-relative asset path. High-
          // cardinality by nature — fine as a log field consumed by text-
          // search / by-incident filtering; NEVER promote it to a metric
          // label (per-asset label explosion).
          destPath: outcome.path,
          httpStatus: 200,
        },
        outcome.deduped ? '[upload] dedup hit' : '[upload] write ok',
      );
      // RFC 9457 §3 success path: drop the `ok: true` wrapper. Wire shape
      // is `{ src, path, deduped }`; clients discriminate on HTTP status.
      successResponse(
        res,
        200,
        UploadAssetSuccessSchema,
        { src: outcome.src, path: outcome.path, deduped: outcome.deduped },
        { handler: 'upload-asset' },
      );
      return;
    }
    switch (outcome.kind) {
      case 'config-error':
        log.error(
          { err: outcome.cause },
          '[upload] project config has invalid content.attachmentFolderPath',
        );
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Server configuration error: invalid attachment folder path.',
          { handler: 'upload-asset', cause: outcome.cause },
        );
        return;
      case 'invalid-attachment-folder':
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid attachment folder path.', {
          handler: 'upload-asset',
        });
        return;
      case 'path-escape':
        errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
          handler: 'upload-asset',
          ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
        });
        return;
      case 'dest-validation-error':
        log.error(
          { err: outcome.cause, destDir: outcome.destDir },
          '[upload] failed to validate destination directory',
        );
        errorResponse(res, 500, 'urn:ok:error:storage-error', 'Storage error.', {
          handler: 'upload-asset',
          cause: outcome.cause,
        });
        return;
      case 'mkdir-failed':
        errorResponse(
          res,
          uploadStatusFor(outcome.reason),
          outcome.reason,
          uploadTitleFor(outcome.reason),
          {
            handler: 'upload-asset',
            cause: outcome.cause,
            detail: 'failed to create attachment directory',
          },
        );
        return;
      case 'write-failed':
        log.error(
          {
            event: 'upload',
            endpoint: req.url ?? '/api/upload',
            requestId: getRequestId(req),
            agentId,
            agentName,
            filename: outcome.filename,
            size: byteLength,
            reason: outcome.reason,
            httpStatus: uploadStatusFor(outcome.reason),
            err: outcome.cause,
          },
          '[upload] write failed',
        );
        errorResponse(
          res,
          uploadStatusFor(outcome.reason),
          outcome.reason,
          uploadTitleFor(outcome.reason),
          { handler: 'upload-asset', cause: outcome.cause },
        );
        return;
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
        log.error({ cwd: absDir, cliCmd, err }, '[local-op/clone] failed to spawn child');
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
        log.warn(
          { project: basename(canonicalPath), result: 'not-a-git-worktree', kind: gitDirKind },
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
        log.warn(
          { project: basename(canonicalPath), result: 'already-initialized' },
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
        log.warn(
          { project: basename(canonicalPath), result: 'success' },
          `[ok-init] action=init project=${basename(canonicalPath)} result=success`,
        );
        successResponse(
          res,
          200,
          LocalOpOkInitResponseSchema,
          { ok: true, projectPath: canonicalPath },
          { handler: HANDLE_LOCAL_OP_OK_INIT },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { project: basename(canonicalPath), result: 'failed', reason: message },
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
  const LOCAL_OP_AUTH_PAT_KEY = '/api/local-op/auth/pat';
  const LOCAL_OP_AUTH_GH_LOGIN_KEY = '/api/local-op/auth/gh-login';

  /**
   * Keepalive cadence for the two streaming auth flows. Between `verification`
   * and `complete` the device flow writes nothing for as long as the user takes
   * to authorize — up to the code's ~15-minute life — and a loopback connection
   * carrying zero bytes is exactly what an idle-connection reaper severs
   * (AV/EDR SSL-inspection agents, VPN local proxies, some tab-backgrounding).
   * A periodic no-op line keeps bytes flowing. `{ type: 'ping' }` is not an
   * `AuthEvent`: consumers skip it, it never terminates the stream, and it does
   * not touch the code's expiry.
   */
  const AUTH_STREAM_HEARTBEAT_MS = authStreamHeartbeatMs ?? 15_000;

  /**
   * Wall-clock cap on a device-flow child, deliberately longer than the generic
   * `LOCAL_OP_TIMEOUT_MS`. GitHub issues codes with `expires_in: 899` (~15 min)
   * and the UI now counts down to that real deadline, so a 10-minute SIGTERM
   * would kill the flow while the code on the user's screen is still good. The
   * CLI's own poller gives up first at `expired_token`; this is only a backstop.
   */
  const AUTH_DEVICE_FLOW_TIMEOUT_MS = 16 * 60 * 1000;

  /**
   * Default host for the auth relay endpoints when the request omits `host`.
   * Read per-request (not cached): the origin remote can change over the
   * server's lifetime.
   */
  const defaultAuthHost = (): string => originGitHubHost(projectDir ?? contentDir);

  // In-flight controllers for the two streaming auth flows (device-flow login and
  // gh-login). A disconnect or fresh start frees/displaces the slot synchronously
  // instead of waiting for the cancelled child to exit. Object identity is the
  // ownership token: only the current owner releases its slot, so a displaced/
  // disconnected flow can never free a successor's. Held in `{ current }` refs so
  // the shared `streamAuthFlow` helper below can mutate them by reference.
  // Mirrors the IPC twin's `authInFlight` (desktop/src/main/ipc/local-op.ts).
  type StreamingAuthController = { done: Promise<void>; cancel(): void };
  const authLoginInFlight: { current: StreamingAuthController | null } = { current: null };
  const authGhLoginInFlight: { current: StreamingAuthController | null } = { current: null };

  /**
   * Shared streaming envelope for the auth flows. The flows themselves differ —
   * device-flow login runs OK's `auth login` (github.com-only OAuth app, token →
   * OK's store) while gh-login runs `gh auth login --web` (gh's OAuth app, works
   * on GHES, token → gh keyring → tier A) — so the caller supplies `makeFlow`.
   * Everything else is identical and lives here once: the concurrency slot with
   * displace-on-restart, NDJSON streaming, the idle keepalive, disconnect
   * detach, sync-resume, and the ownership-guarded slot release.
   */
  function streamAuthFlow(cfg: {
    res: ServerResponse;
    handler: string;
    guardKey: string;
    inFlight: { current: StreamingAuthController | null };
    concurrentMessage: string;
    streamErrorMessage: string;
    makeFlow: (onEvent: (event: AuthEvent) => void) => StreamingAuthController;
  }): void {
    const { res, handler, guardKey, inFlight, concurrentMessage, streamErrorMessage, makeFlow } =
      cfg;

    if (!localOpGuard.tryAcquire(guardKey)) {
      const stale = inFlight.current;
      if (!stale) {
        // Structurally unreachable: the slot key and `inFlight.current` are
        // assigned with no `await` between them, so a held slot always has a
        // controller. Log at `error` (a distinct event, not a normal-concurrency
        // 429) so a refactor breaking that coupling is diagnosable, then 429 as
        // the loud fallback rather than silently re-owning an unidentifiable slot.
        console.error(
          JSON.stringify({
            event: 'ok-local-op:auth-flow-slot-no-controller',
            channel: 'auth',
            transport: 'http',
            handler,
          }),
        );
        errorResponse(res, 429, 'urn:ok:error:concurrent-operation', concurrentMessage, {
          handler,
          extraHeaders: { 'Retry-After': '5' },
        });
        return;
      }
      // A missed/late disconnect left a stale flow holding the slot. Displace it
      // (SIGTERM the child so it can't keep polling and write an unconfirmed
      // token), then re-own the slot below. Logged at `warn` so a missed
      // disconnect is greppable before users hit a stuck slot.
      stale.cancel();
      inFlight.current = null;
      console.warn(
        JSON.stringify({
          event: 'ok-local-op:idempotent-start-replaced-stale-slot',
          channel: 'auth',
          transport: 'http',
          handler,
        }),
      );
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });
    // Wrap raw `error` events in the RFC 9457 streaming envelope.
    const writeStreamError = createStreamingErrorWriter(res, handler);

    // Three-way guard + try-catch matches the writer's race-window defense; a
    // lost progress event is not crashworthy.
    const writeLine = (line: string): void => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(line);
      } catch {
        /* socket destroyed between guard and write — line lost */
      }
    };

    let heartbeat: ReturnType<typeof setInterval> | null = setInterval(() => {
      writeLine(`${JSON.stringify({ type: 'ping' })}\n`);
    }, AUTH_STREAM_HEARTBEAT_MS);
    // A keepalive must never be the reason the process stays up.
    heartbeat.unref();
    const stopHeartbeat = (): void => {
      if (heartbeat === null) return;
      clearInterval(heartbeat);
      heartbeat = null;
    };

    const flow = makeFlow((event: AuthEvent) => {
      if (event.type === 'error') {
        writeStreamError(500, 'urn:ok:error:auth-failed', streamErrorMessage, {
          cause: event.message ? new Error(event.message) : undefined,
        });
        return;
      }
      // On `complete`, resume a SyncEngine parked in `auth-error` so a reconnect
      // restores sync without an app restart. Server-authoritative: works
      // regardless of which UI surface ran the sign-in — and, since the flow now
      // outlives its client connection, regardless of whether anyone is still
      // listening when the token lands.
      resumeSyncOnAuthEvent(event, getSyncEngine);
      writeLine(`${JSON.stringify(event)}\n`);
    });
    inFlight.current = flow;

    // A transport disconnect is NOT a cancel, and must not kill the flow.
    //
    // On loopback the stream gets severed by things the user never sees — an
    // AV/EDR inspection agent, a VPN local proxy, a backgrounded tab. Killing
    // the child there turns a blip into an unrecoverable sign-in: the user
    // finishes authorizing on github.com and no token is ever stored, with no
    // way back except starting over for a fresh code. So a disconnect only
    // stops the writer; the flow runs on to its own timeout (or the code's
    // expiry) and a reconnecting client picks the outcome up from
    // `POST /api/local-op/auth/status`.
    //
    // What the old kill-on-disconnect protected — don't land a token after the
    // user backed out — rides on an EXPLICIT signal instead: `POST
    // /api/local-op/auth/cancel` when the modal closes, or displacement by a
    // fresh start. That is the lifetime model the IPC twin has always had
    // (`handleAuthStart` in desktop/src/main/ipc/local-op.ts), where a vanished
    // renderer never killed the flow either and only `:cancel` did; HTTP was
    // the outlier purely because a socket close was the only signal it had.
    //
    // The slot stays HELD here. Releasing it on disconnect would let a
    // concurrent start spawn a second device-flow child alongside the live one;
    // a genuine restart still gets in via the stale-slot displacement above.
    const onClientClose = () => {
      stopHeartbeat();
      // Log only a GENUINE detach — a flow left running with nobody attached.
      // An explicit cancel already cleared the slot synchronously before the
      // client's socket closed, and a displaced flow no longer owns it either,
      // so this identity check is what separates "an intermediary cut us off"
      // from routine teardown. Without it this fires on every normal cancel and
      // the signal is worthless. Completion needs no check: `flow.done.finally`
      // removes this listener before ending the response.
      if (inFlight.current !== flow) return;
      console.warn(
        JSON.stringify({
          event: 'ok-local-op:auth-stream-detached',
          channel: 'auth',
          transport: 'http',
          handler,
        }),
      );
    };
    res.on('close', onClientClose);

    // `flow.done` cannot reject (`proc.done` only resolves; the onEvent callback
    // is throw-safe), so `.finally` needs no IIFE-level try/catch. The release is
    // ownership-guarded: a displaced/cancelled flow that already freed or
    // handed off the slot must not release a successor's when its child exits.
    void flow.done.finally(() => {
      stopHeartbeat();
      res.off('close', onClientClose);
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          /* socket destroyed between guard and end — already closed */
        }
      }
      if (inFlight.current === flow) {
        inFlight.current = null;
        localOpGuard.release(guardKey);
      }
    });
  }

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
    streamAuthFlow({
      res,
      handler: HANDLE_LOCAL_OP_AUTH_LOGIN,
      guardKey: LOCAL_OP_AUTH_LOGIN_KEY,
      inFlight: authLoginInFlight,
      concurrentMessage: 'An auth login operation is already in progress.',
      streamErrorMessage: 'Auth subprocess reported an error.',
      makeFlow: (onEvent) =>
        runDeviceFlowSubprocess({
          cliArgs: localOpCliArgs,
          host,
          timeoutMs: AUTH_DEVICE_FLOW_TIMEOUT_MS,
          onEvent,
        }),
    });
  }

  /**
   * POST /api/local-op/auth/gh-login
   *
   * Body: { host?: string }
   * Runs `gh auth login --hostname <host> --web` and streams the same
   * verification / complete / error NDJSON as the device flow. gh's OAuth app is
   * preregistered on GHES (OpenKnowledge's isn't), so this gives enterprise hosts
   * a browser sign-in; gh stores the token in its keyring and OK reads it via
   * tier A. 400 if gh isn't installed (the UI falls back to the PAT panel).
   */
  const HANDLE_LOCAL_OP_AUTH_GH_LOGIN = 'local-op-auth-gh-login';
  const handleLocalOpAuthGhLogin = withValidation(
    LocalOpAuthHostRequestSchema,
    async (_req, res, body) => {
      const host = body.host ?? defaultAuthHost();
      const ghPath = await cachedGhBinaryPath();
      if (ghPath === null) {
        // Precondition failure — the UI falls back to the PAT panel. Reuse the
        // auth-failed URN (the detail names the specific cause).
        errorResponse(
          res,
          400,
          'urn:ok:error:auth-failed',
          'The GitHub CLI (gh) is not installed.',
          { handler: HANDLE_LOCAL_OP_AUTH_GH_LOGIN },
        );
        return;
      }

      streamAuthFlow({
        res,
        handler: HANDLE_LOCAL_OP_AUTH_GH_LOGIN,
        guardKey: LOCAL_OP_AUTH_GH_LOGIN_KEY,
        inFlight: authGhLoginInFlight,
        concurrentMessage: 'A gh sign-in is already in progress.',
        streamErrorMessage: 'gh sign-in reported an error.',
        makeFlow: (onEvent) =>
          runGhDeviceLoginSubprocess({
            host,
            ghPath,
            timeoutMs: AUTH_DEVICE_FLOW_TIMEOUT_MS,
            onEvent,
          }),
      });
    },
    {
      handler: HANDLE_LOCAL_OP_AUTH_GH_LOGIN,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_GH_LOGIN }),
    },
  );

  /**
   * POST /api/local-op/auth/cancel
   *
   * Body: { channel?: 'login' | 'gh-login' }
   * Explicit, user-initiated stop for a streaming sign-in — the intent signal
   * that a transport disconnect deliberately is not (see `streamAuthFlow`).
   * SIGTERMs the device-flow child so it can't land a token the user backed out
   * of, and frees the concurrency slot synchronously so a reopen right behind
   * the cancel isn't 429'd during the SIGTERM-to-exit window.
   *
   * Idempotent by construction: the client fires this on modal close without
   * knowing whether a flow is still running, so "nothing in flight" is a 200,
   * not an error.
   *
   * Deliberately has no `localOpGuard` slot of its own, unlike its sibling
   * local-op endpoints. Those guard a subprocess spawn; this one spawns
   * nothing and does no IO, so the body runs to completion with no `await` in
   * it — two concurrent cancels cannot interleave, and the second reads a
   * null slot and no-ops. A guard here would buy nothing and add a failure
   * mode that inverts the endpoint's purpose: a 429'd cancel leaves the flow
   * running, which is precisely what the caller asked to stop.
   */
  const HANDLE_LOCAL_OP_AUTH_CANCEL = 'local-op-auth-cancel';
  const handleLocalOpAuthCancel = withValidation(
    LocalOpAuthCancelRequestSchema,
    // Wrapped so an unexpected throw still lands as a typed 500. The body
    // itself has no failure mode — hence no `errorResponse` of its own.
    catchErrors(
      async (_req, res, body) => {
        const target =
          body.channel === 'gh-login'
            ? { inFlight: authGhLoginInFlight, guardKey: LOCAL_OP_AUTH_GH_LOGIN_KEY }
            : { inFlight: authLoginInFlight, guardKey: LOCAL_OP_AUTH_LOGIN_KEY };
        const flow = target.inFlight.current;
        if (flow) {
          flow.cancel();
          // Free the slot rather than waiting for the SIGTERM'd child to exit,
          // so a reopen right behind the cancel isn't 429'd during that window.
          // Ownership-guarded by construction: we clear the same reference we
          // just read, and the cancelled flow's own `done.finally` re-checks
          // identity, so its late exit can't free a successor's slot.
          target.inFlight.current = null;
          localOpGuard.release(target.guardKey);
        }
        successResponse(
          res,
          200,
          LocalOpAuthEmptySuccessSchema,
          {},
          { handler: HANDLE_LOCAL_OP_AUTH_CANCEL },
        );
      },
      { handler: HANDLE_LOCAL_OP_AUTH_CANCEL, title: 'Failed to cancel the sign-in.' },
    ),
    {
      handler: HANDLE_LOCAL_OP_AUTH_CANCEL,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_CANCEL }),
    },
  );

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
        // `ghAvailable` tells the UI whether to offer "Sign in with gh" (the
        // browser path that works on GHES where OK's device flow can't). Machine
        // property, not per-host; cached so this frequent probe doesn't re-shell.
        const ghAvailable = (await cachedGhBinaryPath()) !== null;
        if (parsed !== null) {
          successResponse(
            res,
            200,
            LocalOpAuthStatusSuccessSchema,
            { ...(parsed as Record<string, unknown>), ghAvailable },
            { handler: HANDLE_LOCAL_OP_AUTH_STATUS },
          );
        } else {
          successResponse(
            res,
            200,
            LocalOpAuthStatusSuccessSchema,
            { authenticated: false, ghAvailable },
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
   * POST /api/local-op/auth/pat
   *
   * Body: { host?: string, token: string }
   * Spawns: auth pat --json --host <host> --token-stdin (token via stdin).
   * Returns: { host, login } on success; 400 auth-failed with a bounded reason
   * on a rejected token / TLS / network error.
   *
   * The enterprise sign-in path — a GHES host stores a PAT because the OAuth
   * device flow only works on github.com. The token is written to the child's
   * stdin, never argv/env.
   */
  const HANDLE_LOCAL_OP_AUTH_PAT = 'local-op-auth-pat';
  const handleLocalOpAuthPat = withValidation(
    LocalOpAuthPatRequestSchema,
    async (_req, res, body) => {
      const host = body.host ?? defaultAuthHost();

      if (!localOpGuard.tryAcquire(LOCAL_OP_AUTH_PAT_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'An auth operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_AUTH_PAT, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }

      try {
        const result = await runPatSubprocess({ cliArgs: localOpCliArgs, host, token: body.token });
        if (result.ok) {
          // A stored PAT is a credential change just like a device/gh sign-in —
          // re-probe so a repo paused with 'no-push-permission' while signed out
          // resumes without an app restart. The streaming paths get this via
          // resumeSyncOnAuthEvent; PAT is a plain POST, so call it directly.
          onAuthCredentialLanded(getSyncEngine);
          successResponse(
            res,
            200,
            LocalOpAuthPatSuccessSchema,
            { host: result.host, login: result.login },
            { handler: HANDLE_LOCAL_OP_AUTH_PAT },
          );
        } else {
          // A rejected token / cert / network failure is client-actionable, not
          // a server fault. `result.error` is bounded (the CLI's structured
          // describeAuthFailure message), safe to surface.
          errorResponse(res, 400, 'urn:ok:error:auth-failed', result.error, {
            handler: HANDLE_LOCAL_OP_AUTH_PAT,
          });
        }
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:auth-failed', 'Storing the token failed.', {
          handler: HANDLE_LOCAL_OP_AUTH_PAT,
          cause: err,
        });
      } finally {
        localOpGuard.release(LOCAL_OP_AUTH_PAT_KEY);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_AUTH_PAT,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_PAT }),
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

    // Working-tree-variant conflicts (pull-only B1) have no git index stages:
    // the branch already fast-forwarded to origin tip and the overlay rides
    // uncommitted on top. Serve `theirs`/`base` from the pinned tip/base blobs
    // and `ours` from the live doc (or disk when unloaded). The merge-native
    // stage path below is untouched for git-merge conflicts.
    const wtEntry = engine
      ?.getConflicts()
      .find((c) => c.file === file && c.variant === 'working-tree');
    if (wtEntry) {
      try {
        // A pinned SHA that fails to read is an unexpected failure (the blob was
        // reachable when the engine pinned it), NOT an absent blob. Returning ''
        // would misread it downstream as origin-deleted (`kind: 'modify-delete'`)
        // and steer the user into a `delete` resolution that removes their own
        // doc. Discriminate: `undefined` sha = genuinely no pinned blob (the
        // empty side of a delete/modify); a read failure on a present sha logs
        // and rethrows to the outer catch → 500, matching the merge-native
        // `showStage` discipline below.
        const readBlob = async (sha: string | undefined): Promise<string> => {
          if (!sha) return '';
          try {
            return await pg.raw(['cat-file', 'blob', sha]);
          } catch (err) {
            console.warn(
              JSON.stringify({
                event: 'conflict-content-readblob-failed',
                file,
                detail: err instanceof Error ? err.message : String(err),
                handler: 'sync-conflict-content',
              }),
            );
            throw err;
          }
        };
        const theirs = await readBlob(wtEntry.theirsSha);
        const base = await readBlob(wtEntry.baseSha);
        const docName = stripDocExtension(file);
        const loaded = hocuspocus.documents.get(docName);
        let ours = '';
        let oursPresent = false;
        let lifecycleStatus: string | null = null;
        if (loaded) {
          const rawStatus = loaded.getMap('lifecycle').get('status');
          lifecycleStatus =
            typeof rawStatus === 'string' && rawStatus.length > 0 ? rawStatus : null;
          const ytextOurs = serializeDoc ? serializeDoc(docName) : null;
          if (ytextOurs !== null) {
            ours = ytextOurs;
            oursPresent = true;
          }
        } else {
          // Unloaded doc: the overlay is on disk (absent for a delete overlay).
          // Realpath-contain the read first — `file` is an origin-controlled
          // tracked path that could be a symlink escaping the working tree,
          // disclosing a foreign file. A SymlinkEscapeError propagates to the
          // outer catch → 500; the inner catch still handles the benign ENOENT
          // of a genuine delete overlay.
          assertRealpathWithinDir(join(projectDir, file), projectDir);
          try {
            ours = readFileSync(join(projectDir, file), 'utf-8');
            oursPresent = true;
          } catch {
            oursPresent = false;
          }
        }
        // A locally-deleted file the tip modified is a delete/modify shape;
        // otherwise both sides hold content.
        const kind: 'both-modified' | 'delete-modify' | 'modify-delete' = !oursPresent
          ? 'delete-modify'
          : theirs.length === 0
            ? 'modify-delete'
            : 'both-modified';
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
          { handler: 'sync-conflict-content', cause: e },
        );
      }
      return;
    }

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
          log.warn(
            { docName },
            `[conflict-content] doc ${docName} not loaded; lifecycleStatus unavailable`,
          );
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
        log.error(
          { err: e, requestId: getRequestId(req) },
          '[installed-agents] route wrapper failed',
        );
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'installed-agents',
          cause: e,
        });
      }
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

  function validateTemplateName(name: string, res: ServerResponse, handler = 'template'): boolean {
    if (!name || !TEMPLATE_NAME_REGEX.test(name)) {
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
            log.warn(
              { path: localFmPath, reason },
              `[folder-config:get] malformed YAML in ${localFmPath}: ${reason}`,
            );
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

  const handleFolderConfig = methodRouter(
    { GET: handleFolderConfigGet, PUT: handleFolderConfigPut },
    { handler: 'folder-config' },
  );

  // ── Saved themes (`/api/saved-themes` list, `/api/saved-theme` mutations) ──
  // The store is a user-global folder of scheme files the renderer can't reach;
  // save/delete/list run here. Discovery is by scan (no live watcher in v1), and
  // the home is the same `homeDirOverride` seam the skills store uses so tests
  // isolate against a tempdir without touching `os.homedir()`.

  const handleSavedThemesList = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        const { entries, truncated } = scanSavedThemes({ homedirOverride: homeDirOverride });
        // Entries carry their own `ok` discriminator: usable themes ship their
        // palette for the picker preview; unusable ones ship a warning `code` so
        // a file the user placed is listed, never silently missing.
        successResponse(
          res,
          200,
          SavedThemesListSuccessSchema,
          { themes: entries, truncated },
          { handler: 'saved-themes-list' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to list saved themes.',
          {
            handler: 'saved-themes-list',
            cause: e,
          },
        );
      }
    },
    { handler: 'saved-themes-list', method: 'GET', skipBodyParse: true },
  );

  const handleSavedThemeSave = withValidation(
    SavedThemeSaveRequestSchema,
    async (_req, res, body) => {
      try {
        const result = await saveSavedTheme({
          name: body.name,
          stem: body.stem,
          scheme: body.scheme,
          extension: body.extension,
          homedirOverride: homeDirOverride,
          lockTimeoutMs: savedThemeLockTimeoutMs,
        });
        if (!result.ok) {
          if (result.code === 'lock-timeout') {
            errorResponse(
              res,
              503,
              'urn:ok:error:concurrent-operation',
              'Saved themes are temporarily busy.',
              {
                handler: 'saved-theme-save',
                detail: result.code,
                extraHeaders: { 'Retry-After': '5' },
              },
            );
            return;
          }
          if (result.code === 'name-taken') {
            // Refuse-and-prompt: a collision never overwrites prior work.
            errorResponse(
              res,
              409,
              'urn:ok:error:theme-name-taken',
              'A saved theme with that name already exists.',
              { handler: 'saved-theme-save', detail: body.name },
            );
            return;
          }
          // Restore stems remain strict; a new human-facing name only fails when
          // it is empty. The specific cause rides `detail` so the save form can
          // localize the reason.
          errorResponse(
            res,
            400,
            'urn:ok:error:theme-name-invalid',
            'That name cannot be used as a theme id.',
            { handler: 'saved-theme-save', detail: result.code },
          );
          return;
        }
        successResponse(
          res,
          201,
          SavedThemeSaveSuccessSchema,
          { id: result.id, filename: result.filename },
          { handler: 'saved-theme-save' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to save theme.', {
          handler: 'saved-theme-save',
          cause: e,
        });
      }
    },
    { handler: 'saved-theme-save', method: 'POST' },
  );

  const handleSavedThemeDelete = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const id = parseQuery(req).get('id') ?? '';
        if (id === '') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing theme id.', {
            handler: 'saved-theme-delete',
          });
          return;
        }
        const result = await deleteSavedTheme({
          id,
          homedirOverride: homeDirOverride,
          lockTimeoutMs: savedThemeLockTimeoutMs,
        });
        if (!result.ok) {
          if (result.code === 'lock-timeout') {
            errorResponse(
              res,
              503,
              'urn:ok:error:concurrent-operation',
              'Saved themes are temporarily busy.',
              {
                handler: 'saved-theme-delete',
                detail: result.code,
                extraHeaders: { 'Retry-After': '5' },
              },
            );
            return;
          }
          const conflict = result.code !== 'invalid-id';
          errorResponse(
            res,
            conflict ? 409 : 400,
            'urn:ok:error:invalid-request',
            'Cannot delete saved theme.',
            {
              handler: 'saved-theme-delete',
              detail: result.code,
            },
          );
          return;
        }
        // Deleting an id that names no file is a benign no-op (`existed: false`),
        // and deleting one currently assigned to a mode slot is allowed — the
        // config's read-time fallback makes the dangling reference harmless.
        successResponse(
          res,
          200,
          SavedThemeDeleteSuccessSchema,
          result.existed
            ? { existed: true, filename: result.filename, scheme: result.scheme }
            : { existed: false },
          { handler: 'saved-theme-delete' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to delete theme.', {
          handler: 'saved-theme-delete',
          cause: e,
        });
      }
    },
    { handler: 'saved-theme-delete', method: 'DELETE', skipBodyParse: true },
  );

  const handleSavedThemeUpdate = withValidation(
    SavedThemeUpdateRequestSchema,
    async (_req, res, body) => {
      try {
        const result = await updateSavedTheme({
          id: body.id,
          scheme: body.scheme,
          homedirOverride: homeDirOverride,
          lockTimeoutMs: savedThemeLockTimeoutMs,
        });
        if (!result.ok) {
          if (result.code === 'lock-timeout') {
            errorResponse(
              res,
              503,
              'urn:ok:error:concurrent-operation',
              'Saved themes are temporarily busy.',
              {
                handler: 'saved-theme-update',
                detail: result.code,
                extraHeaders: { 'Retry-After': '5' },
              },
            );
            return;
          }
          if (result.code === 'not-found') {
            errorResponse(res, 404, 'urn:ok:error:not-found', 'Saved theme not found.', {
              handler: 'saved-theme-update',
            });
            return;
          }
          if (result.code === 'ambiguous-id' || result.code === 'unsafe-target') {
            const message =
              result.code === 'ambiguous-id'
                ? 'Multiple saved theme files claim that id.'
                : 'The saved theme id conflicts with a file that cannot be safely updated.';
            errorResponse(res, 409, 'urn:ok:error:invalid-request', message, {
              handler: 'saved-theme-update',
              detail: result.code,
            });
            return;
          }
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Not a saved theme id.', {
            handler: 'saved-theme-update',
            detail: result.code,
          });
          return;
        }
        successResponse(
          res,
          200,
          SavedThemeUpdateSuccessSchema,
          { id: result.id, filename: result.filename },
          { handler: 'saved-theme-update' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to update theme.', {
          handler: 'saved-theme-update',
          cause: e,
        });
      }
    },
    { handler: 'saved-theme-update', method: 'PUT' },
  );

  const handleSavedTheme = methodRouter(
    { POST: handleSavedThemeSave, PUT: handleSavedThemeUpdate, DELETE: handleSavedThemeDelete },
    { handler: 'saved-theme' },
  );

  /**
   * Conflict-aware refusal helper for the template handlers. A template is a
   * content doc now (`<folder>/.ok/templates/<name>`), so its live Y.Doc carries
   * a `lifecycle.status` Y.Map — a mutation against one mid-conflict must refuse
   * exactly like the sibling content-write handlers, whose paired-write path
   * (`composeAndWriteRawBody`) would otherwise clobber a doc the user is
   * mid-resolving. Takes the pre-resolved content doc name — same shape as the
   * sibling `checkSkillDocConflictGate`, so the two gates read as one pattern.
   * Returns `true` when the gate fired (caller short-circuits); `false` when
   * the mutation may proceed.
   */
  function checkTemplateConflictGate(
    templateDocName: string,
    handler: 'template-put' | 'template-delete' | 'template-move' | 'template-import',
    res: ServerResponse,
  ): boolean {
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
    catchErrors(
      async (_req, res) => {
        const resolvedContentDir = resolve(contentDir);
        const result = await resolveProjectTemplates(resolvedContentDir);
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
      },
      { handler: 'templates-list', title: 'Failed to list templates.' },
    ),
    { handler: 'templates-list', method: 'GET', skipBodyParse: true },
  );

  // Generic frontmatter splitter for managed `.md` files (SKILL.md, etc.):
  // returns the parsed YAML frontmatter object + the body. Distinct from core's
  // `parseTemplateFile`, which parses the single-block TEMPLATE format
  // (`template:` identity → TemplateModel). Skills carry plain `{name,
  // description}` frontmatter, so they need this generic parse, not the
  // template model.
  const parseFrontmatterDoc = (
    raw: string,
  ): { frontmatter: Record<string, unknown>; body: string } => {
    const { body } = stripFrontmatter(raw);
    // Malformed / missing / non-mapping frontmatter degrades to an empty
    // record — callers still get the FM-stripped body.
    return { frontmatter: parseFrontmatterRecord(raw) ?? {}, body };
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
        if (
          checkTemplateConflictGate(
            templateDocNameFor(validated.folderRel, name),
            'template-put',
            res,
          )
        )
          return;

        // Compose + validate the `.md` bytes server-side, then route the body
        // through the template's CRDT doc (precedent #24 / #38) — same shape as
        // skill-put. Templates are content docs, so the ordinary content
        // persistence path (not the managed-artifact branch) writes the file.
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

        // Close the dropped-FSEvent gap at the source (see helper): the flush
        // may have just created this folder's `.ok/templates/` dir — exactly
        // the brand-new-subdir race where the watcher's create event can be
        // lost. Same net as the sibling agent-write handlers.
        registerWrittenDocInFileIndex(templateDocName, composed.content);

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
        const actor = extractActorIdentityFromQuery(url, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'template-delete',
          });
          return;
        }

        // Conflict-aware refusal. See `checkTemplateConflictGate`.
        if (
          checkTemplateConflictGate(
            templateDocNameFor(validated.folderRel, name),
            'template-delete',
            res,
          )
        )
          return;

        // Tear down the live template content doc (if open) BEFORE removing the
        // file, so its debounced content store can't re-store (resurrect) it on
        // a later unload. Same spine doc-delete + skill-delete use; no-op when
        // the doc was never opened.
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
          // Mark the content doc removed so a stale tab redirects instead of
          // offering to resurrect it (parity with ordinary doc deletion).
          recentlyRemovedDocs?.setDeleted(templateDocNameFor(validated.folderRel, name));
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
          checkTemplateConflictGate(
            templateDocNameFor(fromValidated.folderRel, body.fromName),
            'template-move',
            res,
          )
        ) {
          return;
        }

        // Tear down the live source template content doc (if open) BEFORE the
        // git-mv relocates the file — otherwise its debounced content store
        // would re-store at the now-stale from-path, resurrecting the moved
        // template.
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

        // Mark the source content doc removed (the move relocated its file) so a
        // stale tab on the old name redirects instead of offering to resurrect
        // it (parity with ordinary doc deletion).
        recentlyRemovedDocs?.setDeleted(templateDocNameFor(fromValidated.folderRel, body.fromName));

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

        // Close the dropped-FSEvent gap for the DESTINATION (parity with
        // put/import): the relocate may have just created `toFolder`'s
        // `.ok/templates/` dir — the brand-new-subdir race where the watcher's
        // create event can be lost. Read the final on-disk bytes (post the
        // optional edit above) so the index entry matches what landed.
        // Best-effort like the helper itself: on a read failure the CRDT/disk
        // copy exists regardless and a rescan re-seeds the index.
        try {
          registerWrittenDocInFileIndex(
            templateDocNameFor(toValidated.folderRel, body.toName),
            readFileSync(resolve(toValidated.resolvedContentDir, result.toPath), 'utf-8'),
          );
        } catch {
          // Unreadable destination — leave index membership to the watcher.
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

  const handleTemplate = methodRouter(
    {
      GET: handleTemplateGet,
      PUT: handleTemplatePut,
      POST: handleTemplateMove,
      DELETE: handleTemplateDelete,
    },
    { handler: 'template' },
  );

  const handleTemplateImport = withValidation(
    TemplateImportRequestSchema,
    async (_req, res, body) => {
      try {
        if (ephemeral) {
          errorResponse(
            res,
            403,
            'urn:ok:error:single-file-mode',
            'Templates are not available in single-file mode.',
            { handler: 'template-import' },
          );
          return;
        }

        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'template-import',
          });
          return;
        }

        const sourcePath = body.sourcePath;
        if (!isSafeDocName(sourcePath)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid sourcePath.', {
            handler: 'template-import',
          });
          return;
        }

        const sourceDocName = resolveAlias(sourcePath);
        if (isSystemDoc(sourceDocName) || isConfigDoc(sourceDocName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${sourceDocName}' is a reserved document name.`,
            { handler: 'template-import' },
          );
          return;
        }

        const sourceFilePath = resolveContentEntryPath(contentDir, 'file', sourceDocName);
        if (!existsSync(sourceFilePath)) {
          errorResponse(
            res,
            404,
            'urn:ok:error:doc-not-found',
            `Source document not found: ${sourceDocName}.`,
            {
              handler: 'template-import',
            },
          );
          return;
        }

        const existing = hocuspocus.documents.get(sourceDocName);
        if (body.deleteSource) {
          const deleteEngine = getSyncEngine?.();
          const deleteTrackedFiles = new Set(
            deleteEngine ? deleteEngine.getConflicts().map((c) => c.file) : [],
          );
          const conflictedByLifecycle = existing !== undefined && isDocInConflict(existing);
          const conflictedByStore = deleteTrackedFiles.has(sourcePath);
          if (conflictedByLifecycle || conflictedByStore) {
            respondDocInConflict(
              res,
              new DocInConflictError({ file: sourcePath }),
              'template-import',
            );
            return;
          }
        }

        // Read source content
        let sourceContent = '';
        if (existing) {
          sourceContent = existing.getText('source').toString();
        } else {
          const dc = await hocuspocus.openDirectConnection(sourceDocName);
          try {
            const document = dc.document;
            if (!document) {
              errorResponse(
                res,
                500,
                'urn:ok:error:doc-not-available',
                'Source document is not available.',
                {
                  handler: 'template-import',
                },
              );
              return;
            }
            sourceContent = document.getText('source').toString();
          } finally {
            await dc.disconnect();
          }
        }

        // Determine target template name
        let name = body.name;
        if (!name) {
          const { basename } = splitContentPath(sourcePath);
          const nameWithoutExt = basename.replace(/\.(md|mdx)$/i, '');
          name = nameWithoutExt.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase();
          name = name.replace(/^[-_]+|[-_]+$/g, '');
          name ||= 'imported-template';
        }

        if (!validateTemplateName(name, res, 'template-import')) return;

        const validated = validateFolderRel(body.targetFolder, res, 'folder', 'template-import');
        if (!validated) return;

        if (
          checkTemplateConflictGate(
            templateDocNameFor(validated.folderRel, name),
            'template-import',
            res,
          )
        )
          return;

        // Parse existing frontmatter of the source file to extract the title/description/tags
        const { frontmatter: sourceFmText, body: sourceBody } = stripFrontmatter(sourceContent);
        const cleanFmText = unwrapFrontmatterFences(sourceFmText);
        let sourceFmObj: Record<string, unknown> = {};
        try {
          if (cleanFmText.trim()) {
            sourceFmObj = parseYaml(cleanFmText) as Record<string, unknown>;
          }
        } catch {
          // Malformed frontmatter — treat the source as having none.
        }

        const templateTitle =
          body.title || (sourceFmObj?.title as string) || extractPageTitle(sourceContent, name);
        const templateDescription = (sourceFmObj?.description as string) || '';
        const templateTags = Array.isArray(sourceFmObj?.tags) ? (sourceFmObj.tags as string[]) : [];

        // For the starter content, we can use the original document frontmatter but remove `template:`
        // if it somehow got there. Keep other fields. We also drop `title` so it doesn't get baked into every instance.
        const starterFmObj = { ...sourceFmObj };
        delete starterFmObj.template;
        delete starterFmObj.title;

        let starterContent = '';
        if (Object.keys(starterFmObj).length > 0) {
          const fmYaml = stringifyYaml(starterFmObj);
          starterContent = `${fmYaml.trim()}\n`;
        }
        starterContent = starterContent ? `---\n${starterContent}---\n${sourceBody}` : sourceBody;

        const composed = composeTemplateContent({
          name,
          body: starterContent,
          frontmatter: {
            title: templateTitle,
            description: templateDescription,
            tags: templateTags,
          },
        });

        if (!composed.ok) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid template request.', {
            handler: 'template-import',
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
          respondPersistenceFailure(res, templateFlush.failure, 'template-import');
          return;
        }
        if (templateFlush?.kind === 'divergence') {
          respondDiskDivergence(res, 'template-import');
          return;
        }

        // Close the dropped-FSEvent gap at the source (see helper): the flush
        // may have just created the target folder's `.ok/templates/` dir —
        // exactly the brand-new-subdir race where the watcher's create event
        // can be lost. Same net as the sibling agent-write handlers.
        registerWrittenDocInFileIndex(templateDocName, composed.content);

        attributeOkArtifactWrite(
          actor,
          okArtifactKey('template', validated.folderRel, name),
          `template-import: ${templateRelPath}`,
        );

        if (body.deleteSource) {
          const deletedDocNames = [sourceDocName];
          await captureAndCloseDocuments(deletedDocNames, 'deleted-upstream');
          if (recentlyRemovedDocs) {
            recentlyRemovedDocs.setDeleted(sourceDocName);
          }
          tracedUnlinkSync(sourceFilePath);
          mutateFileIndex?.({
            kind: 'delete',
            path: sourceFilePath,
            docName: sourceDocName,
          });
        }

        await commitOkArtifactWrite('template-import');
        signalChannel?.('files');

        successResponse(
          res,
          200,
          TemplateImportSuccessSchema,
          {
            path: templateRelPath,
            created: templateCreated,
            warnings: composed.warnings,
          },
          { handler: 'template-import' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to import template.',
          {
            handler: 'template-import',
            cause: e,
          },
        );
      }
    },
    { handler: 'template-import', method: 'POST' },
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
  const skillInstallOps = createSkillInstallOpsService({ contentDir, skillsHome });

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
   * Absolute bundle dir for a skill READ. Store retirement: the IN-PLACE
   * editor-dir canonical wins at both scopes; the legacy `.ok/skills` store is
   * only a fallback for a resident not yet drained. Null when neither exists.
   *
   * A name can be held by several distinct-CONTENT bundles in different host
   * dirs — they are different skills, not copies. `host` picks one of them;
   * without it the scan's by-name default (first same-name row) answers, so a
   * host-less read stays deterministic instead of following content-hash order.
   * A `host` that holds no such bundle resolves to null rather than falling
   * back to a different skill.
   */
  function resolveSkillDirForRead(
    scope: 'project' | 'global',
    name: string,
    host?: string,
  ): string | null {
    const store = resolve(resolveSkillsRoot(scope), name);
    if (scope === 'global') {
      if (host !== undefined) {
        const row = scanGlobalInPlaceSkills(skillsHome).find(
          (s) => s.name === name && s.hosts.includes(host),
        );
        return row ? resolve(skillsHome, row.dir) : null;
      }
      // Global mirrors project: the IN-PLACE (native user-dir) canonical wins;
      // the legacy store is a fallback until its last resident migrates.
      const native = resolveGlobalNativeSkillDir(skillsHome, name);
      if (native !== null) return native;
      return existsSync(join(store, 'SKILL.md')) ? store : null;
    }
    // Project: the IN-PLACE canonical wins — a same-name store dir is a
    // placement of the same skill, not its identity (mirrors the list rule).
    const inPlace = scanInPlaceSkills(contentDir).find(
      (s) => s.name === name && (host === undefined || s.hosts.includes(host)),
    );
    if (inPlace) return resolve(contentDir, inPlace.dir);
    if (host !== undefined) return null;
    return existsSync(join(store, 'SKILL.md')) ? store : null;
  }

  /**
   * contentDir-relative bundle dir (POSIX) for a PROJECT skill — the in-place
   * canonical when the skill isn't in the `.ok/skills` store. Feeds the
   * shadow-restore + reimport write paths so Update/Revert operate on the
   * skill's real dir.
   */
  /**
   * The effective install mode for NEW fan-out of a skill: recorded per-skill
   * preference first, then the default.
   *
   * The default is SYMLINK — one real folder plus links keeps a repo's git
   * history free of N duplicate copies of every skill. But it applies ONLY when
   * the skill has nothing to reclassify: a skill that already sits in several
   * editor dirs as copies, with no recorded preference, predates the default,
   * and a set-exact fan-out in link mode would silently convert every one of
   * those copies. `otherOccurrences` is the count of installed locations besides
   * the skill's own source folder — when it is zero, no existing location can be
   * mutated, so the new default is free to apply.
   */
  /**
   * One translation of `restoreSkillVersion`'s failure union to a response.
   * Restore and revert are the same rollback with different entry points, and
   * they carried byte-identical copies of this table.
   */
  /**
   * Actor identity for the DELETE handlers. DELETE carries no body, so identity
   * and summary ride the query string; this rebuilds the shape
   * `extractActorIdentity` expects. Three handlers had byte-identical copies.
   */
  function extractActorIdentityFromQuery(
    url: URL,
    principal: typeof getPrincipal,
  ): ReturnType<typeof extractActorIdentity> {
    const sp = url.searchParams;
    return extractActorIdentity(
      {
        agentId: sp.get('agentId') ?? undefined,
        agentName: sp.get('agentName') ?? undefined,
        colorSeed: sp.get('colorSeed') ?? undefined,
        clientName: sp.get('clientName') ?? undefined,
        clientVersion: sp.get('clientVersion') ?? undefined,
        label: sp.get('label') ?? undefined,
        summary: sp.get('summary') ?? undefined,
      },
      principal,
    );
  }

  /**
   * How a skill should be re-projected into its host dirs.
   *
   * An ACQUIRED skill (one imported from a source, recorded in
   * `skills-lock.json`) projects as copies: its source can move or vanish with
   * the import, and a symlink to it dangles on clone or in CI. An authored
   * skill projects as symlinks — one real folder, no duplicated bytes.
   *
   * Install derived this; rename and cross-scope move hardcoded `'symlink'`,
   * so renaming an imported skill silently converted every host back to a
   * symlink and reintroduced exactly the dangle the copy rule exists to avoid.
   */
  function projectionModeFor(scope: 'project' | 'global', name: string): 'symlink' | 'copy' {
    const base = scope === 'project' ? projectDir : skillsHome;
    if (!base) return 'symlink';
    try {
      const lock = readSkillsLock(join(base, ...SKILLS_LOCK_REL));
      return lock.skills[name] !== undefined ? 'copy' : 'symlink';
    } catch {
      // Unreadable lockfile: origin unknown, so keep the authored default.
      return 'symlink';
    }
  }

  function skillLockPath(scope: 'project' | 'global'): string | null {
    const base = scope === 'project' ? projectDir : skillsHome;
    return base ? join(base, ...SKILLS_LOCK_REL) : null;
  }

  function rekeySkillLockEntry(
    scope: 'project' | 'global',
    fromName: string,
    toName: string,
    patch: Partial<SkillsLock['skills'][string]> = {},
  ): Promise<void> {
    const lockPath = skillLockPath(scope);
    if (!lockPath) return Promise.resolve();
    return mutateSkillsLock(lockPath, (lock) => {
      const entry = lock.skills[fromName];
      if (!entry) return lock;
      const skills = { ...lock.skills };
      delete skills[fromName];
      skills[toName] = { ...entry, ...patch };
      return { ...lock, skills };
    });
  }

  /**
   * Move a provenance entry between scopes. Returns whether there was one to
   * move, so the caller can skip the follow-up hash/baseline refresh.
   *
   * The destination write lands before the source removal: if the second write
   * fails the entry exists in both lockfiles (harmless duplicate provenance)
   * rather than in neither (the skill silently stops being reimportable).
   */
  async function transferSkillLockEntry(
    fromScope: 'project' | 'global',
    toScope: 'project' | 'global',
    name: string,
  ): Promise<boolean> {
    const fromPath = skillLockPath(fromScope);
    const toPath = skillLockPath(toScope);
    if (!fromPath || !toPath) return false;
    const entry = readSkillsLockFile(fromPath).skills[name];
    if (!entry) return false;

    const movedEntry = { ...entry };
    // Global is unversioned — it has no shadow repo, so a baseline ref from the
    // project side would point at a commit the destination cannot restore.
    if (toScope === 'global') delete movedEntry.baselineRef;
    await mutateSkillsLock(toPath, (lock) => ({
      ...lock,
      skills: { ...lock.skills, [name]: movedEntry },
    }));
    await mutateSkillsLock(fromPath, (lock) => {
      const remaining = { ...lock.skills };
      delete remaining[name];
      return { ...lock, skills: remaining };
    });
    return true;
  }

  function updateSkillLockEntry(
    scope: 'project' | 'global',
    name: string,
    patch: Partial<SkillsLock['skills'][string]>,
  ): Promise<void> {
    const lockPath = skillLockPath(scope);
    if (!lockPath) return Promise.resolve();
    return mutateSkillsLock(lockPath, (lock) => {
      const entry = lock.skills[name];
      if (!entry) return lock;
      return { ...lock, skills: { ...lock.skills, [name]: { ...entry, ...patch } } };
    });
  }

  function respondSkillRestoreFailure(
    res: ServerResponse,
    result: {
      code: 'no-shadow' | 'version-not-found' | 'skill-absent' | 'io-error' | 'path-escape';
      error: string;
    },
    handler: 'skill-restore' | 'skill-revert',
  ): void {
    const map = {
      'no-shadow': [409, 'urn:ok:error:shadow-not-configured'],
      'version-not-found': [404, 'urn:ok:error:not-found'],
      'skill-absent': [404, 'urn:ok:error:not-found'],
      'io-error': [500, 'urn:ok:error:storage-error'],
      'path-escape': [500, 'urn:ok:error:path-escape'],
    } as const;
    const [status, typeUri] = map[result.code];
    errorResponse(res, status, typeUri, result.error, { handler, detail: result.code });
  }

  /**
   * The form a NEW location should take: the one the skill's existing locations
   * already use, and a symlink when it has none to follow.
   *
   * This used to key off the COUNT of existing locations — link while a skill
   * lived in exactly one place, copy once it lived in two — so the form a
   * location got depended on how many installs happened to precede it. Adding
   * three locations produced a symlink then two copies, and the divergence
   * badges appeared and vanished as the expected form flipped underneath them.
   *
   * Symlink is the default because it duplicates no bytes and cannot drift; a
   * skill whose locations are all copies keeps getting copies, so a new one
   * matches its siblings rather than silently mixing forms.
   */
  function effectiveInstallMode(
    scope: 'project' | 'global',
    name: string,
    existing: { hosts: readonly string[]; linkedHosts: readonly string[] },
  ): 'copy' | 'link' {
    const prefBase = scope === 'project' ? projectDir : skillsHome;
    const recorded = prefBase ? readSkillInstallModeRaw(prefBase, name) : undefined;
    if (recorded) return recorded;
    // The source is a real folder, never a link — judge by the others.
    const others = existing.hosts.length - 1;
    if (others <= 0) return 'link';
    return existing.linkedHosts.some((h) => existing.hosts.includes(h)) ? 'link' : 'copy';
  }

  function projectSkillDirRel(name: string): string {
    const dir = resolveSkillDirForRead('project', name);
    return dir
      ? relative(contentDir, dir).split(sep).join('/')
      : `${LEGACY_SKILL_STORE_ROOT}/${name}`;
  }

  // OK's built-in skills are NOT authored under `.ok/skills`; they are
  // force-installed into the editor host dirs (`.claude/skills/<name>/`,
  // `.cursor/skills/<name>/`, …) — the `open-knowledge` project skill under the
  // project root, and the `open-knowledge-discovery` / `open-knowledge-write-skill`
  // user-global skills under `<home>`. Surface them in the skills index READ-ONLY
  // so users see exactly what their agents load.
  const BUILTIN_PROJECT_SKILL_NAME = BUNDLE_SKILL_NAME.project;

  /**
   * Resolve a built-in skill's on-disk projection across the editor host dirs
   * under `base` (the project root for the project skill, `<home>` for the
   * user-global ones), preferring Claude (the first entry in
   * `PROJECT_SKILL_EDITOR_IDS`). Returns the chosen skill dir + its `SKILL.md` +
   * every host id it is projected into + the `base`-relative path, or null when
   * no host copy exists yet.
   */
  function resolveBuiltinSkillDir(
    base: string,
    name: string,
    /**
     * Which host dir to read from. A built-in can diverge across hosts exactly
     * like any other skill (a stale `.agents` copy beside a current `.claude`
     * one), and each is its own row — so without this both rows would serve
     * whichever dir the editor-id order happens to reach first.
     */
    host?: string,
  ): { dir: string; skillMd: string; hosts: string[]; relPath: string } | null {
    const hosts: string[] = [];
    let chosenDir: string | null = null;
    // The `.agents` hub is a first-class host but carries no editor id, so it is
    // absent from PROJECT_SKILL_EDITOR_IDS and has to be probed on its own.
    const roots: Array<{ id: string; root: string }> = [
      ...PROJECT_SKILL_EDITOR_IDS.map((editorId) => ({
        id: editorId as string,
        root: EDITOR_PROJECT_SKILL_ROOT[editorId] ?? '',
      })),
      { id: 'agents', root: '.agents/skills' },
    ];
    for (const { id, root } of roots) {
      if (!root) continue;
      const dir = resolve(base, ...root.split('/'), name);
      if (!existsSync(resolve(dir, 'SKILL.md'))) continue;
      hosts.push(id);
      if (host !== undefined ? id === host : chosenDir === null) chosenDir = dir;
    }
    if (chosenDir === null) return null;
    const skillMd = resolve(chosenDir, 'SKILL.md');
    return {
      dir: chosenDir,
      skillMd,
      hosts,
      relPath: relative(base, skillMd).split(/[\\/]/).filter(Boolean).join('/'),
    };
  }

  /**
   * Shape a lockfile entry into the API `origin` object (repo source + resolved
   * marketplace URL + auto-update flag). Pure over `entry`; shared by the skills
   * list handler and the built-in list entry. `pluginProvider`/`ref` stay on the
   * lockfile entry and are not re-exposed (the plugin label derives from `source`).
   */
  function skillOriginFor(entry: SkillsLock['skills'][string]) {
    const marketplaceUrl = pluginRepositoryUrl(entry.source, entry.pluginProvider);
    return {
      source: entry.source,
      ...(entry.publisher !== undefined ? { publisher: entry.publisher } : {}),
      ...(entry.skill !== undefined ? { skill: entry.skill } : {}),
      ...(marketplaceUrl ? { marketplaceUrl } : {}),
      importedAt: entry.importedAt,
      ...(entry.autoUpdate !== undefined ? { autoUpdate: entry.autoUpdate } : {}),
    };
  }

  /**
   * Synthesize the skills.sh lock entry for one of OK's built-in bundle skills.
   * Built-ins seed from the app bundle, but their canonical upstream is the
   * deterministic `inkeep/open-knowledge-skills` repo — so, exactly like a
   * pre-provenance starter pack (`retrofitPackLockEntry`), we synthesize the
   * entry on demand from the installed content rather than storing one at seed
   * time. Drives the repo link + the manual "update available" flow. Its
   * `autoUpdate: false` makes updates MANUAL-only: a pulled/shared project never
   * silently re-pulls a built-in. Returns null for any non-built-in name or when
   * the skill isn't installed on disk.
   */
  function synthBuiltinLockEntry(base: string, name: string): SkillsLock['skills'][string] | null {
    if (!isInternalBundleSkillName(name)) return null;
    const resolved = resolveBuiltinSkillDir(base, name);
    if (!resolved) return null;
    const contentHash = parseSkillDir(resolved.dir)?.contentHash ?? '';
    let importedAt: string;
    try {
      importedAt = statSync(resolved.skillMd).mtime.toISOString();
    } catch {
      importedAt = new Date(0).toISOString();
    }
    return {
      source: OPENKNOWLEDGE_SKILLS_REPO,
      skill: name,
      contentHash,
      autoUpdate: false,
      importedAt,
    };
  }

  /**
   * The managed, read-only skills-list entry for a built-in bundle skill, read
   * from its on-disk projection under `base`. Returns null when it isn't
   * installed (no host copy). Marked `managed: true` so the UI labels it and
   * disables mutation; the write/rename/delete APIs refuse it independently. An
   * `origin` (skills.sh repo link + manual update path) is attached from the
   * synthesized built-in lock entry.
   */
  function builtinSkillListEntry(
    base: string,
    name: string,
    scope: 'project' | 'global',
  ): {
    name: string;
    description?: string;
    scope: 'project' | 'global';
    path: string;
    absolutePath: string;
    installed: boolean;
    hosts: string[];
    managed: true;
    origin?: ReturnType<typeof skillOriginFor>;
  } | null {
    const resolved = resolveBuiltinSkillDir(base, name);
    if (!resolved) return null;
    let description: string | undefined;
    try {
      const { frontmatter } = parseFrontmatterDoc(readFileSync(resolved.skillMd, 'utf-8'));
      if (typeof frontmatter.description === 'string') description = frontmatter.description;
    } catch {
      // Malformed SKILL.md: still list it (without a description) so it's visible.
    }
    const synthEntry = synthBuiltinLockEntry(base, name);
    return {
      name,
      ...(description !== undefined ? { description } : {}),
      scope,
      path: resolved.relPath,
      absolutePath: resolved.skillMd,
      installed: resolved.hosts.length > 0,
      hosts: resolved.hosts,
      managed: true,
      ...(synthEntry ? { origin: skillOriginFor(synthEntry) } : {}),
    };
  }

  /**
   * Refuse an EDIT of one of OK's runtime skills (`open-knowledge`,
   * `open-knowledge-discovery`, `open-knowledge-write-skill`) — the app's own
   * agent contract. Read-only is an EDIT gate only: a silent local edit would
   * invisibly fork the contract, so content changes arrive exclusively via
   * checkpointed reimport/seed. Lifecycle verbs (delete / move / install /
   * uninstall) are ORDINARY for these skills; the same call doubles as the
   * squat guard on CREATE/rename-to. Fork-to-own covers variants.
   */
  function rejectReservedBuiltinSkill(name: string, res: ServerResponse, handler: string): boolean {
    if (!isInternalBundleSkillName(name)) return false;
    errorResponse(
      res,
      400,
      'urn:ok:error:reserved-doc-name',
      `"${name}" is one of OpenKnowledge's runtime skills — its content is read-only in-app (updates arrive via reimport). Duplicate it under a new name to make your own version.`,
      { handler },
    );
    return true;
  }

  /**
   * The CRDT doc name a template opens/persists under — its content-relative path
   * (`<folderRel>/.ok/templates/<name>`, ext-less, RAW). Delegates to the core
   * builder so server handlers, the client open path, and the properties panel
   * share one identity. `''` folder → `.ok/templates/<name>` (project root).
   */
  function templateDocNameFor(folderRel: string, name: string): string {
    return templateContentDocName(folderRel, name);
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
   * endpoint. Returns true when an install record existed.
   *
   * IN-PLACE guard: when the skill has no `.ok/skills` store source,
   * its editor-dir occurrences ARE the skill — the canonical and any fork are
   * REAL dirs a blanket reverse-projection would rm -rf. Route those through
   * `removeInPlaceSkillCopies`, which removes only lossless occurrences
   * (symlinks / same-hash copies) and never the canonical or a differing dir.
   */
  async function uninstallSkillFromHostDirs(
    base: string,
    name: string,
    scope: 'project' | 'global',
  ): Promise<boolean> {
    const installed = await removeSkillInstall(base, name);
    if (!existsSync(resolve(resolveSkillsRoot(scope), name, 'SKILL.md'))) {
      const entry = (
        scope === 'project' ? scanInPlaceSkills(contentDir) : scanGlobalInPlaceSkills(skillsHome)
      ).find((s) => s.name === name);
      if (entry) {
        const scanBase = scope === 'project' ? contentDir : skillsHome;
        const canonical = resolve(scanBase, entry.dir);
        // Uninstall consolidates to the vendor-neutral `.agents` hub: the skill
        // survives THERE and every EDITOR projection is removed. Protecting the
        // scan's precedence canonical instead would keep whichever editor won the
        // election on install (`.claude` outranks `.agents`) and remove the hub —
        // the reverse of an uninstall (the user's "uninstall" would leave the
        // skill sitting in the editor). If the hub lacks a copy (install set-exact
        // moved the skill into the editor), materialize it from the canonical so
        // the skill is never deleted by an uninstall. We never INVENT
        // `.agents` — a project with no hub root falls back to keeping the
        // canonical (a hub-less skill just stays put).
        const hubRoot = resolve(scanBase, '.agents', 'skills');
        const hubDir = join(hubRoot, name);
        if (existsSync(hubRoot) && !existsSync(join(hubDir, 'SKILL.md'))) {
          let sameInode = false;
          try {
            sameInode = realpathSync(canonical) === realpathSync(hubDir);
          } catch {
            sameInode = false;
          }
          if (!sameInode) tracedCpSync(canonical, hubDir, { recursive: true, dereference: true });
        }
        const keepDir = existsSync(join(hubDir, 'SKILL.md')) ? hubDir : canonical;
        removeInPlaceSkillCopies({
          canonicalAbs: keepDir,
          canonicalHash: entry.contentHash,
          name,
          cwd: base,
          targets: [...PROJECT_SKILL_EDITOR_IDS],
          roots: skillProjectionRoots(scope),
        });
        return installed !== null;
      }
    }
    // Reverse-project across ALL skill-surface host dirs, NOT just the marker's
    // recorded hosts. The marker can be stale or absent (e.g. after a cross-scope
    // move, or when the source was removed out-of-band) while orphan/dangling
    // projection symlinks remain on disk. Cleaning the full set — combined with
    // `reverseProjectSkill`'s dangling-symlink removal — guarantees no projection
    // survives a delete/move. `reverseProjectSkill` is a no-op per host that
    // has nothing to remove, so over-covering is safe.
    reverseProjectSkill(name, base, PROJECT_SKILL_EDITOR_IDS, skillProjectionRoots(scope));
    return installed !== null;
  }

  /**
   * Enumerate `<skillsRoot>/<name>/SKILL.md` entries for the Skills panel.
   * Reads each skill's frontmatter for `description`; a malformed/absent
   * frontmatter still lists (description omitted) so the panel can surface it
   * so it can be fixed. Non-skill-named dirs are skipped. Bounded by
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
      try {
        const { frontmatter } = parseFrontmatterDoc(readFileSync(skillMd, 'utf-8'));
        if (typeof frontmatter.description === 'string') description = frontmatter.description;
      } catch {
        // Malformed SKILL.md — list it without a description so it can be fixed.
      }
      skills.push({
        name: entry.name,
        ...(description !== undefined ? { description } : {}),
        scope,
        path: skillRelPath(skillMd, scope),
        absolutePath: skillMd,
      });
    }
    return { skills, truncated };
  }

  const handleSkillsList = withValidation(
    EmptyRequestSchema,
    catchErrors(
      async (_req, res) => {
        // Union both scopes: project skills (`<contentDir>/.ok/skills`, git-
        // shared) + global skills (`<home>/.ok/skills`, user-level). Each is
        // enriched from ITS OWN install marker — the project marker at
        // `<projectDir>/.ok/local/`, the user marker at `<home>/.ok/local/`.
        const projectSkillsRoot = resolveSkillsRoot('project');
        const project = resolveSkillsList(projectSkillsRoot, 'project');
        const globalSkills = resolveSkillsList(resolveSkillsRoot('global'), 'global');
        // Editors the install menu may OFFER per scope on THIS machine.
        // Project: every editor with a project skill root — install creates the
        // dir, so all are installable. Global: only editors whose user-home skill
        // dir EXISTS (`detectUserSkillHosts`) — a global install never creates a
        // host home, so offering an undetected editor (e.g. Copilot with no
        // `~/.copilot`) just no-ops and the checkmark reverts.
        const projectInstallableEditors: string[] = [...PROJECT_SKILL_EDITOR_IDS];
        const globalInstallableEditors: string[] = detectUserSkillHosts(skillsHome).map(
          (h) => h.editorId,
        );
        const projectInstalled = projectDir ? readInstalledSkills(projectDir).skills : {};
        const globalInstalled = readInstalledSkills(skillsHome).skills;
        // Import provenance (project skills only — the global store is unversioned
        // and has no lockfile). Read once so the "Imported from …" row + "Update
        // from source" action have the source without a per-skill lookup.
        const lock: SkillsLock | null = projectDir
          ? (parseSkillsLock(
              existsSync(join(projectDir, ...SKILLS_LOCK_REL))
                ? readFileSync(join(projectDir, ...SKILLS_LOCK_REL), 'utf-8')
                : '',
            ) ?? null)
          : null;
        const skillOrigin = skillOriginFor;
        const enrich = (
          list: typeof project,
          marker: Record<string, { hosts: string[] }>,
          withOrigin: boolean,
        ) =>
          list.skills.map((skill) => {
            const record = marker[skill.name];
            const hosts = record?.hosts ?? [];
            const entry = withOrigin ? lock?.skills[skill.name] : undefined;
            const origin = entry ? skillOrigin(entry) : undefined;
            // Locally modified since install: current on-disk hash diverges from the
            // recorded write-time baseline. Only decidable when `localHash` was
            // recorded (post-baseline installs). This is a greenfield feature —
            // skills imported before it read as clean (no baseline, so neither
            // Modified nor Revert applies), which keeps Modified and Revert gated on
            // the SAME `localHash`/`baselineRef` that only post-feature imports carry.
            const modified =
              entry?.localHash !== undefined &&
              localSkillHash(projectSkillsRoot, skill.name) !== entry.localHash;
            // Revert restores from the shadow-repo `baselineRef`; only offer it when
            // one was recorded (git project). A non-git project records `localHash`
            // but no `baselineRef`, so it can show Modified yet not Revert.
            const revertable = entry?.baselineRef !== undefined;
            // `installed` = has ≥1 host, NOT merely marker-present. A marker with
            // zero hosts (e.g. a rename whose editors all vanished) is source-only, not
            // an installed skill — the install handler also drops empty markers.
            return {
              ...skill,
              installed: hosts.length > 0,
              hosts,
              ...(origin ? { origin } : {}),
              ...(modified ? { modified: true } : {}),
              ...(revertable ? { revertable: true } : {}),
            };
          });
        // In-place editor-dir skills: one entry per registry canonical,
        // at its REAL path (`.claude/skills/<name>/SKILL.md`, …). For PROJECT
        // scope the IN-PLACE canonical wins a name collision with a `.ok/skills`
        // store dir — after the boot migration a project store dir sharing an
        // in-place name is a user placement (or stray copy) of the SAME skill,
        // and letting the store win hijacked the skill's identity (hosts
        // vanished). Built-ins are appended separately below. Import lifecycle
        // (origin / Modified / Revert) reads the same lockfile as store
        // skills; `modified` compares the canonical bundle's `parseSkillDir`
        // hash against the recorded `localHash`.
        // Machine-local custom placements (copies/symlinks the user placed at
        // arbitrary paths) — disclosed on the project entries' path lists.
        const placements = projectDir ? readSkillPlacements(projectDir) : {};
        // DRIFT: a recorded location whose on-disk form (copy vs symlink) no
        // longer matches what OK last wrote there = another tool rewrote it.
        // EXTERNAL: locations the user handed off — reported, never touched.
        const placementFlags = (
          baseDir: string,
          list: ReturnType<typeof readSkillPlacements>[string] | undefined,
          canonicalAbs?: string,
        ): { drift: string[] } => {
          const drift: string[] = [];
          for (const p of list ?? []) {
            const abs = resolve(baseDir, p.path);
            // The skill's OWN folder is never a placement: it is the thing the
            // others project from. A record can outlive the source moving here
            // (it was a link or copy before it became the source), and reading
            // that stale record as drift flags the source itself as "changed
            // outside" on a project nobody has touched. The skill-wide convert
            // loop already skips the canonical dir for the same reason.
            if (canonicalAbs !== undefined && abs === resolve(canonicalAbs)) continue;
            let isLink = false;
            try {
              isLink = lstatSync(abs).isSymbolicLink();
            } catch {
              continue;
            }
            if ((isLink ? 'link' : 'copy') === p.mode) continue;
            // A link that RESOLVES to the skill's own canonical dir is a healthy,
            // known form regardless of who rewired it (folder link↔per-skill link
            // conversions land here) — never "changed outside" noise. It stays
            // flagged only when it points somewhere else (or dangles).
            if (isLink && canonicalAbs !== undefined) {
              try {
                if (realpathSync(abs) === realpathSync(canonicalAbs)) continue;
              } catch {
                // dangling / unresolvable — fall through to the flag
              }
            }
            drift.push(p.path);
          }
          return { drift };
        };
        const projectAliases = projectDir ? scanHostRootAliases(contentDir, 'project') : {};
        const projectAliasRoots = aliasedSourceRoots(projectAliases, 'project');
        // Placement receipts recorded under a now-aliased root describe bytes
        // that physically live in the alias TARGET — hiding them keeps the
        // aliased folder from resurfacing as a fake location (and keeps every
        // mutation surface off the alias). The records stay in the ledger:
        // un-aliasing the folder brings them back unchanged.
        const underRoots = (path: string, roots: ReadonlySet<string>): boolean =>
          [...roots].some((r) => path === r || path.startsWith(`${r}/`));
        // Ledger records under STANDARD editor roots are form receipts for
        // editor rows (leave-behind links, drift expectations) — they feed the
        // drift flags but are NOT custom placements: emitting them as
        // such duplicated every editor row as a folder mark on the pill.
        const stdRootsProject = standardSkillRoots('project');
        const stdRootsGlobal = standardSkillRoots('global');
        const dropAliased = (
          list: ReturnType<typeof readSkillPlacements>[string] | undefined,
          aliasRoots: Set<string>,
        ): ReturnType<typeof readSkillPlacements>[string] =>
          (list ?? []).filter(
            (pl) => ![...aliasRoots].some((r) => pl.path === r || pl.path.startsWith(`${r}/`)),
          );
        // The lockfile and the placement ledger are keyed by NAME, but a name can
        // be held by several distinct-content bundles. There is no reliable way
        // to tell which one a lock entry describes (a hand-edited bundle failing
        // `localHash` looks exactly like a same-named bundle that was never ours),
        // so lock-derived state binds to the by-name default row only. The others
        // read as untracked. Attributing it to every same-named row would put a
        // Revert button on a skill whose baseline belongs to a different one.
        const projectNameSeen = new Set<string>();
        const inPlace = projectDir
          ? scanInPlaceSkills(contentDir).map((s) => {
              const tracked = !projectNameSeen.has(s.name);
              projectNameSeen.add(s.name);
              // Built-ins have no stored lockfile entry — synthesize their
              // skills.sh origin so they carry the repo link + manual update path.
              const entry = tracked
                ? (lock?.skills[s.name] ?? synthBuiltinLockEntry(contentDir, s.name))
                : undefined;
              const origin = entry ? skillOrigin(entry) : undefined;
              const modified = entry?.localHash !== undefined && s.contentHash !== entry.localHash;
              return {
                name: s.name,
                ...(s.description ? { description: s.description } : {}),
                scope: 'project' as const,
                path: `${s.dir}/SKILL.md`,
                absolutePath: resolve(contentDir, s.dir, 'SKILL.md'),
                installed: true,
                hosts: [...s.hosts],
                installableEditors: projectInstallableEditors,
                ...(s.linkedHosts.length > 0 ? { symlinkedHosts: [...s.linkedHosts] } : {}),
                ...(Object.keys(projectAliases).length > 0 ? { hostAliases: projectAliases } : {}),
                ...(s.conflictHosts.length > 0 ? { conflictHosts: [...s.conflictHosts] } : {}),
                ...(() => {
                  const custom = dropAliased(
                    tracked ? placements[s.name] : undefined,
                    projectAliasRoots,
                  ).filter((cp) => !underRoots(cp.path, stdRootsProject));
                  return custom.length
                    ? { customPlacements: custom.map((cp) => ({ path: cp.path, mode: cp.mode })) }
                    : {};
                })(),
                ...(() => {
                  const f = placementFlags(
                    projectDir,
                    dropAliased(tracked ? placements[s.name] : undefined, projectAliasRoots),
                    resolve(contentDir, s.dir),
                  );
                  return f.drift.length > 0 ? { driftPaths: f.drift } : {};
                })(),
                ...(effectiveInstallMode('project', s.name, s) === 'link'
                  ? { linkMode: true }
                  : {}),
                ...(origin ? { origin } : {}),
                ...(modified ? { modified: true } : {}),
                ...(entry?.baselineRef !== undefined ? { revertable: true } : {}),
                // Runtime skills: ordinary entries, read-only CONTENT (the
                // app's agent contract — edits arrive via reimport only).
                ...(isInternalBundleSkillName(s.name) ? { managed: true as const } : {}),
              };
            })
          : [];
        // GLOBAL in-place skills: user-home editor-dir canonicals, listed
        // like any global skill but at their REAL (`~`-relative) paths. The
        // `~/.ok/skills` store wins a name collision (migration pending), and
        // built-ins are appended separately below. No origin/Modified/Revert —
        // the global tier has no lockfile and is unversioned.
        const globalPlacements = readSkillPlacements(skillsHome);
        // Global provenance (store retirement): seeded runtime skills + global
        // imports record `~/.ok/skills-lock.json` — surface origin + Modified
        // exactly like project entries. No `revertable` (no user shadow repo).
        const globalLock = readSkillsLock(join(skillsHome, ...SKILLS_LOCK_REL));
        const globalAliases = scanHostRootAliases(skillsHome, 'global');
        const globalAliasRoots = aliasedSourceRoots(globalAliases, 'global');
        // Global mirrors project: IN-PLACE wins a name collision — a same-name
        // store dir is a legacy resident awaiting migration, not the identity.
        const globalInPlaceNames = new Set(scanGlobalInPlaceSkills(skillsHome).map((s) => s.name));
        globalSkills.skills = globalSkills.skills.filter((s) => !globalInPlaceNames.has(s.name));
        // Same name-keyed-ledger rule as the project tier: lock + placement state
        // binds to the by-name default row, the rest read as untracked.
        const globalNameSeen = new Set<string>();
        const globalInPlace = scanGlobalInPlaceSkills(skillsHome).map((s) => {
          const tracked = !globalNameSeen.has(s.name);
          globalNameSeen.add(s.name);
          const placementsForRow = tracked ? globalPlacements[s.name] : undefined;
          return {
            name: s.name,
            ...(s.description ? { description: s.description } : {}),
            scope: 'global' as const,
            path: `${s.dir}/SKILL.md`,
            absolutePath: resolve(skillsHome, s.dir, 'SKILL.md'),
            installed: true,
            hosts: [...s.hosts],
            installableEditors: globalInstallableEditors,
            ...(s.linkedHosts.length > 0 ? { symlinkedHosts: [...s.linkedHosts] } : {}),
            ...(Object.keys(globalAliases).length > 0 ? { hostAliases: globalAliases } : {}),
            ...(s.conflictHosts.length > 0 ? { conflictHosts: [...s.conflictHosts] } : {}),
            ...(() => {
              const f = placementFlags(
                skillsHome,
                dropAliased(placementsForRow, globalAliasRoots),
                resolve(skillsHome, s.dir),
              );
              return f.drift.length > 0 ? { driftPaths: f.drift } : {};
            })(),
            ...(() => {
              const custom = dropAliased(placementsForRow, globalAliasRoots).filter(
                (cp) => !underRoots(cp.path, stdRootsGlobal),
              );
              return custom.length
                ? { customPlacements: custom.map((cp) => ({ path: cp.path, mode: cp.mode })) }
                : {};
            })(),
            ...(effectiveInstallMode('global', s.name, s) === 'link' ? { linkMode: true } : {}),
            ...(isInternalBundleSkillName(s.name) ? { managed: true as const } : {}),
            ...(() => {
              if (!tracked) return {};
              // Built-ins have no stored lockfile entry — synthesize their
              // skills.sh origin (repo link + manual update path).
              const entry = globalLock.skills[s.name] ?? synthBuiltinLockEntry(skillsHome, s.name);
              if (!entry) return {};
              return {
                origin: skillOrigin(entry),
                ...(entry.localHash !== undefined && s.contentHash !== entry.localHash
                  ? { modified: true }
                  : {}),
              };
            })(),
          };
        });
        // Append OK's built-in skills (read from their on-disk editor
        // projections, e.g. `.claude/skills/<name>/`) as managed, read-only
        // entries, unless a real authored skill of the same name already exists
        // in that scope (the reserved-name gate normally prevents this, but a
        // pre-existing one wins to avoid a duplicate row). Both are needed because
        // the detected-skills scan filters OK's reserved `open-knowledge*` names,
        // so without this surfacing the built-ins would be invisible.
        const inPlaceNamesEarly = new Set(inPlace.map((e) => e.name));
        const projectBuiltin =
          projectDir &&
          !project.skills.some((s) => s.name === BUILTIN_PROJECT_SKILL_NAME) &&
          !inPlaceNamesEarly.has(BUILTIN_PROJECT_SKILL_NAME)
            ? builtinSkillListEntry(projectDir, BUILTIN_PROJECT_SKILL_NAME, 'project')
            : null;
        // The user-global built-ins (`open-knowledge-discovery`,
        // `open-knowledge-write-skill`), force-installed under `<home>/.{host}/skills`
        // and reclaimed on launch.
        const globalInPlaceNamesEarly = new Set(globalInPlace.map((e) => e.name));
        const globalBuiltins = USER_GLOBAL_BUNDLE_IDS.map((id) => BUNDLE_SKILL_NAME[id])
          .filter(
            (name) =>
              !globalSkills.skills.some((s) => s.name === name) &&
              !globalInPlaceNamesEarly.has(name),
          )
          .map((name) => builtinSkillListEntry(skillsHome, name, 'global'))
          .filter((e): e is NonNullable<typeof e> => e !== null);
        const inPlaceNames = new Set(inPlace.map((e) => e.name));
        const enriched = {
          skills: [
            ...enrich(project, projectInstalled, true).filter((e) => !inPlaceNames.has(e.name)),
            ...inPlace,
            ...enrich(globalSkills, globalInstalled, false),
            ...globalInPlace,
            ...(projectBuiltin ? [projectBuiltin] : []),
            ...globalBuiltins,
          ],
          truncated: project.truncated || globalSkills.truncated,
        };
        successResponse(res, 200, SkillsListSuccessSchema, enriched, { handler: 'skills-list' });
      },
      { handler: 'skills-list', title: 'Failed to list skills.' },
    ),
    { handler: 'skills-list', method: 'GET', skipBodyParse: true },
  );

  const handleSkillGet = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = url.searchParams.get('name') ?? '';
        if (!validateSkillName(name, res, 'skill-get')) return;
        const scope = parseSkillScope(url.searchParams.get('scope'), res, 'skill-get');
        if (scope === null) return;

        // The built-in `open-knowledge*` skills live in the editor host dirs,
        // not `.ok/skills`, so serve their on-disk installed copy read-only so
        // the Skills UI can open + display exactly what agents load. The project
        // built-in resolves under the project root, the user-global ones (served
        // at `scope: 'global'`) under `<home>`.
        if (isInternalBundleSkillName(name)) {
          const base = scope === 'global' ? skillsHome : projectDir;
          const builtin = base
            ? resolveBuiltinSkillDir(base, name, url.searchParams.get('host') ?? undefined)
            : null;
          if (builtin) {
            const { frontmatter, body } = parseFrontmatterDoc(
              await readFile(builtin.skillMd, 'utf-8'),
            );
            successResponse(
              res,
              200,
              SkillGetSuccessSchema,
              {
                skill: {
                  name,
                  scope,
                  path: builtin.relPath,
                  frontmatter: {
                    name: typeof frontmatter.name === 'string' ? frontmatter.name : name,
                    description:
                      typeof frontmatter.description === 'string' ? frontmatter.description : '',
                  },
                  body,
                  files: readSkillBundledFiles(builtin.dir),
                  managed: true,
                },
              },
              { handler: 'skill-get' },
            );
            return;
          }
        }
        // Optional host: which same-named bundle to read. Omitted resolves to
        // the by-name default, so existing callers are unaffected.
        const host = url.searchParams.get('host') ?? undefined;
        const skillDirAbs = resolveSkillDirForRead(scope, name, host);
        if (skillDirAbs === null) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-get',
            detail:
              host === undefined
                ? `Skill "${name}" not found in ${scope} scope.`
                : `No skill "${name}" (${scope}) in ${host}.`,
          });
          return;
        }
        const skillMd = resolve(skillDirAbs, 'SKILL.md');
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
              files: readSkillBundledFiles(skillDirAbs),
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

  async function seedSkillDerivedViews(docName: string, markdown: string): Promise<void> {
    if (!derivedDocumentIndex || isLinkIndexExcludedDoc(docName)) return;
    // Refresh the content-filter's in-place skill allow-list FIRST. The index
    // admits a doc via `contentFilter.isExcluded`, and a skill dir only enters
    // that allow-list on `rebuildIgnorePatterns()` — which an API write does not
    // otherwise trigger. So a just-created skill was judged excluded, and the
    // seed DELETED it from the index instead of indexing it: its links never got
    // extracted and nothing pointed at its references until an unrelated rescan.
    if (contentFilter) {
      try {
        await contentFilter.rebuildIgnorePatterns();
      } catch {
        // Fail-soft, matching the watcher's own rebuild: a stale allow-list
        // costs this doc its links until the next rescan, not the write.
      }
    }
    // Best-effort like every other derived-index mutation: the skill is already
    // on disk and committed by now, so a shutdown-time index error must not turn
    // a successful write into a 500 the caller retries.
    await recordDerivedDocumentBestEffort(docName, markdown, 'skill-put');
  }

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
        if (rejectReservedBuiltinSkill(body.name, res, 'skill-put')) return;

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

        const putBase = body.scope === 'project' ? contentDir : skillsHome;
        const existingAbs = resolveSkillDirForRead(body.scope, body.name);
        if (existingAbs === null) {
          // CREATE (store retirement): a NEW skill is born IN-PLACE at the
          // scope's default skill home — versioned, listed, and read at its
          // real path from day one; the store gains no new residents. Same
          // fs-direct spine as import (the live re-scan admits the new dir,
          // after which it IS a content doc).
          const homeRel = resolveDefaultSkillHomeRel(putBase, body.scope);
          const wr = applySkillWrite({
            skillsRoot: resolve(putBase, homeRel),
            name: body.name,
            body: typeof body.body === 'string' ? body.body : '',
            frontmatter: {
              name: body.frontmatter.name,
              description: body.frontmatter.description,
            },
          });
          if (!wr.ok) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid skill request.', {
              handler: 'skill-put',
              detail: wr.error.code,
              cause: new Error(wr.error.message),
            });
            return;
          }
          if (body.scope === 'project') {
            // Attribute under the skill's CONTENT-DOC name (`<dir>/SKILL`), the
            // key `/api/history` filters contributors on — an EDIT records it via
            // its content-doc write, but a fs-direct CREATE records only what we
            // pass here. Passing the bare dir (`<dir>`) meant the create's commit
            // failed the OkActor match and never showed in the skill's history
            // (so the created version couldn't be restored to), even though the
            // commit itself is a reachable ancestor of every edit.
            attributeOkArtifactWrite(
              actor,
              `${homeRel}/${body.name}/SKILL`,
              `skill-create: ${homeRel}/${body.name}/SKILL.md`,
            );
            await commitOkArtifactWrite('skill-put');
          }
          await seedSkillDerivedViews(
            body.scope === 'project'
              ? `${homeRel}/${body.name}/SKILL`
              : skillLiveDocName('global', body.name),
            composed.content,
          );
          signalChannel?.('files');
          successResponse(
            res,
            200,
            SkillPutSuccessSchema,
            {
              path: `${homeRel}/${body.name}/SKILL.md`,
              created: true,
              warnings: [...composed.warnings, ...wr.warnings],
            },
            { handler: 'skill-put' },
          );
          return;
        }
        // EDIT — write through the skill's REAL doc: an in-place project
        // skill's content doc lives at its editor-dir path; a store-backed one
        // keeps `.ok/skills/<name>/SKILL`; a global skill keeps the managed
        // doc (it resolves store-or-native itself).
        const created = false;
        const dirRel = relative(putBase, existingAbs).split(sep).join('/');
        const relPath = `${dirRel}/SKILL.md`;
        const docName =
          body.scope === 'project' ? `${dirRel}/SKILL` : skillLiveDocName(body.scope, body.name);

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
        // On CREATE the doc is brand-new, so its store debounce isn't scheduled
        // at this sync point -- `force` waits for it so SKILL.md is durable
        // before we respond (a fast create->rename must not 404 on `existsSync`).
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
        // Seed the derived views from the bytes we just wrote. The live-derived
        // index refreshes on a debounce after a change hook, which an API write
        // like this one does not reliably reach — so a skill written purely
        // through the API could sit unindexed, its SKILL.md links producing
        // neither a backlink nor a dead link. Same synchronous refresh the lint
        // path does, and idempotent: any later debounced pass re-applies the
        // same bytes.
        await seedSkillDerivedViews(docName, composed.content);
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

  /**
   * The skill's EFFECTIVE root for lifecycle verbs (delete/rename/move):
   * the parent of its real dir (in-place-first via `resolveSkillDirForRead`),
   * falling back to the legacy store root when the skill doesn't exist (the
   * 404 path stays a 404). Also removes same-hash copies/links across the
   * other roots first (lossless-guarded) so a lifecycle verb on the canonical
   * never strands orphan occurrences.
   */
  function effectiveSkillRoot(
    scope: 'project' | 'global',
    name: string,
  ): { root: string; dirRel: string; realDir: string | null } {
    const base = scope === 'project' ? contentDir : skillsHome;
    const realDir = resolveSkillDirForRead(scope, name);
    const root = realDir !== null ? dirname(realDir) : resolveSkillsRoot(scope);
    const dirRel =
      realDir !== null ? relative(base, realDir).split(sep).join('/') : `.ok/skills/${name}`;
    return { root, dirRel, realDir };
  }
  function sweepSkillOccurrences(scope: 'project' | 'global', name: string): void {
    const base = scope === 'project' ? contentDir : skillsHome;
    const inPlace = (
      scope === 'project' ? scanInPlaceSkills(contentDir) : scanGlobalInPlaceSkills(skillsHome)
    ).find((sk) => sk.name === name);
    if (!inPlace) return;
    removeInPlaceSkillCopies({
      canonicalAbs: resolve(base, inPlace.dir),
      canonicalHash: inPlace.contentHash,
      name,
      cwd: base,
      targets: inPlace.hosts.filter((h): h is SkillHostId => isSkillInstallTarget(h)),
      roots: skillProjectionRoots(scope),
    });
  }

  const handleSkillDelete = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = url.searchParams.get('name') ?? '';
        if (!validateSkillName(name, res, 'skill-delete')) return;
        const scope = parseSkillScope(url.searchParams.get('scope'), res, 'skill-delete');
        if (scope === null) return;
        const { root: skillsRoot, dirRel } = effectiveSkillRoot(scope, name);

        // DELETE is query-param transport — read identity + summary from the
        // query string into a synthetic body for `extractActorIdentity`.
        const actor = extractActorIdentityFromQuery(url, getPrincipal);
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
        await captureAndCloseDocuments(
          scope === 'project'
            ? [...new Set([`${dirRel}/SKILL`, skillLiveDocName(scope, name)])]
            : [skillLiveDocName(scope, name)],
          'deleted-upstream',
        );

        // Same-hash copies/links across the other roots go first (lossless-
        // guarded) — deleting the canonical must not strand them.
        sweepSkillOccurrences(scope, name);
        const result = applySkillDelete({ skillsRoot, name });
        // Delete is TOTAL — the skill dies everywhere (locked decision). When
        // the canonical lived in a native dir, a legacy `.ok/skills` store
        // resident of the same name is a placement of the SAME skill (the
        // in-place-wins list rule) — leaving it resurrected the row as a
        // zombie. Remove it too; a failure surfaces as a warning, never a
        // silent survivor.
        const storeRoot = resolveSkillsRoot(scope);
        if (
          result.ok &&
          storeRoot !== skillsRoot &&
          existsSync(resolve(storeRoot, name, 'SKILL.md'))
        ) {
          const storeSweep = applySkillDelete({ skillsRoot: storeRoot, name });
          if (!storeSweep.ok) {
            log.warn(
              { name, scope, detail: storeSweep.error.code },
              '[skill-delete] legacy store resident survived the delete',
            );
          }
        }
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
            attributeOkArtifactWrite(actor, dirRel, `skill-delete: ${dirRel}`);
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
        if (uninstallBase) await uninstallSkillFromHostDirs(uninstallBase, name, scope);
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
        if (rejectReservedBuiltinSkill(body.toName, res, 'skill-move')) return;
        const { root: skillsRoot, dirRel: fromDirRel } = effectiveSkillRoot(
          body.scope,
          body.fromName,
        );
        // A same-name occurrence in ANY root blocks the rename (registry-wide),
        // not just the rename root — otherwise the renamed skill forks.
        if (resolveSkillDirForRead(body.scope, body.toName) !== null) {
          errorResponse(
            res,
            409,
            'urn:ok:error:doc-already-exists',
            `A skill named "${body.toName}" already exists.`,
            { handler: 'skill-move' },
          );
          return;
        }

        // Capture the FULL editor host set BEFORE any teardown — the sweep below
        // removes the old-name copies, and the install marker alone under-reports
        // an in-place skill's hosts (created/imported in place, or an older
        // marker). Union marker + scan + folder-symlink alias audience so the
        // rename re-projects the NEW name into every editor the old name occupied;
        // otherwise it lands only on the canonical root and silently drops
        // .claude/.cursor/etc — leaving a stale copy of the old name in the other
        // editors (, the same class as's scope move).
        const moveBase = skillInstallBase(body.scope);
        const priorInstall = moveBase
          ? readInstalledSkills(moveBase).skills[body.fromName]
          : undefined;
        const fromScanBase = body.scope === 'project' ? contentDir : skillsHome;
        const renameScanEntry = (
          body.scope === 'project'
            ? scanInPlaceSkills(contentDir)
            : scanGlobalInPlaceSkills(skillsHome)
        ).find((sk) => sk.name === body.fromName);
        const renameCanonicalRootRel = renameScanEntry ? dirname(renameScanEntry.dir) : null;
        const renameAliasAudience =
          renameCanonicalRootRel !== null
            ? Object.entries(scanHostRootAliases(fromScanBase, body.scope))
                .filter(([, target]) => target === renameCanonicalRootRel)
                .map(([editor]) => editor)
            : [];
        const priorHosts = [
          ...new Set([
            ...(priorInstall ? resolvedHosts(priorInstall.hosts) : []),
            ...(renameScanEntry ? resolvedHosts(renameScanEntry.hosts) : []),
            ...resolvedHosts(renameAliasAudience),
          ]),
        ];

        // Tear down the live source skill doc (if open) BEFORE the git-mv
        // relocates its dir — otherwise its persistence branch would re-store at
        // the now-stale fromName path, resurrecting the moved-away skill. Project
        // skills are content docs, not `__skill__/project/<name>`. The
        // destination doc loads fresh from disk on next open.
        await captureAndCloseDocuments(
          body.scope === 'project'
            ? [...new Set([`${fromDirRel}/SKILL`, skillLiveDocName(body.scope, body.fromName)])]
            : [skillLiveDocName(body.scope, body.fromName)],
          'renamed',
        );

        // Old-name copies/links across other roots are removed FIRST (lossless-
        // guarded) — a rename must not leave orphan occurrences of the old name.
        sweepSkillOccurrences(body.scope, body.fromName);
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

        // Carry inbound `/fromName` refs, the way a document rename carries its
        // inbound links. Runs BEFORE the reindex below so the moved skill's own
        // re-read picks up the rewritten bytes in one pass. Never fatal: the
        // rename already landed on disk, and failing here would strand it.
        let refRewrites: SkillRefRewrite[] = [];
        if (!contentEditError) {
          try {
            refRewrites = rewriteSkillRefsAcrossScope({
              base: body.scope === 'project' ? contentDir : skillsHome,
              scope: body.scope,
              fromName: body.fromName,
              toName: body.toName,
            });
          } catch (err) {
            getLogger('skill-move').warn(
              { err, fromName: body.fromName, toName: body.toName },
              'skill-ref rewrite failed — rename succeeded, refs to the old name are left as authored',
            );
          }
        }

        // A move git-mv's the dir on disk and rewrites only SKILL.md fs-direct,
        // so the relocated SKILL.md + every `.md` reference are absent from the
        // link/tag graph at their new doc names until a manual rescan. For a
        // project skill, re-drive each relocated `.md` content doc through the
        // CRDT content path so it re-indexes, and drop the stale old-name
        // entries. Global skills live outside the project graph (not content
        // docs), so they have nothing to re-index.
        if (body.scope === 'project' && !contentEditError) {
          try {
            // In-place skill admission is a registry ALLOW-LIST of exact bundle
            // dirs, not a path prefix, and it only refreshes on an ignore-file
            // rebuild. Until it learns the NEW dir, the destination doc is
            // "excluded" — and an unadmitted rename target makes the index drop
            // the old entry AND the new one, so the skill falls out of tags,
            // backlinks and search entirely. Refresh before re-indexing, not
            // after, or we re-index against the pre-rename world.
            await contentFilter?.rebuildIgnorePatterns();
            await reindexMovedProjectSkillDocs(skillsRoot, body.fromName, body.toName);
            await reindexRewrittenSkillRefDocs(refRewrites, body.toName);
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

        const renamedLocalHash = localSkillHash(skillsRoot, body.toName);
        const renamedBaselineRef =
          body.scope === 'project'
            ? await shadowHeadSha(artifactWriterId(actor), toKeyPath)
            : undefined;
        await rekeySkillLockEntry(body.scope, body.fromName, body.toName, {
          localHash: renamedLocalHash,
          ...(body.scope === 'project' ? { baselineRef: renamedBaselineRef } : {}),
        });

        // Carry install state across the rename. The source dir is now at
        // `toName`; re-project the new name into every editor the old name
        // occupied (`priorHosts`, captured PRE-sweep from marker ∪ scan ∪ alias
        // audience), drop the stale `fromName` marker, and record the `toName`
        // marker. NOT gated on a marker existing — a scan-only in-place skill has
        // none but still occupies real editor dirs, and without this the rename
        // lands only on the canonical root and strands the old name elsewhere
        //. Mirrors how delete folds in uninstall.
        if (moveBase) {
          await removeSkillInstall(moveBase, body.fromName);
          reverseProjectSkill(
            body.fromName,
            moveBase,
            priorHosts,
            skillProjectionRoots(body.scope),
          );
          const movedDir = resolve(skillsRoot, body.toName);
          if (priorHosts.length > 0) {
            const newHosts = projectSkill(
              movedDir,
              body.toName,
              moveBase,
              priorHosts,
              projectionModeFor(body.scope, body.toName),
              skillProjectionRoots(body.scope),
            );
            await recordSkillInstall(moveBase, body.toName, {
              ...priorInstall,
              scope: body.scope,
              hosts: newHosts,
              scripts:
                priorInstall?.scripts ?? validateSkillForInstall(movedDir, body.toName).hasScripts,
              installedAt: priorInstall?.installedAt ?? new Date().toISOString(),
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

  // `POST /api/skill/edit-external` — register a detected (unmanaged) skill for
  // in-place editing. The body carries the skill's own enumerated dir
  // (`CatalogSkill.home`); we realpath it, confirm it holds a SKILL.md, and
  // register it so the returned `__extskill__/<name>` doc autosaves back to the
  // real harness file (containment-guarded in `external-skill-registry.ts`). No
  // copy, no symlink, no `.ok/` — that's the Manage upgrade, not this. Loopback-
  // gated (it arms an out-of-contentDir write path). Exempt from the attribution
  // + conflict-gate sweeps: it authors no CRDT content (the writes happen later
  // through persistence, classified `file-system`), it only arms the registry.
  const handleSkillEditExternal = withValidation(
    SkillEditExternalRequestSchema,
    async (_req, res, body) => {
      const { name, home } = body;
      if (!validateSkillName(name, res, 'skill-edit-external')) return;
      let realDir: string;
      try {
        realDir = realpathSync(home);
      } catch {
        errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill directory not found.', {
          handler: 'skill-edit-external',
          detail: 'HOME_NOT_FOUND',
        });
        return;
      }
      if (!statSync(realDir).isDirectory() || !existsSync(resolve(realDir, 'SKILL.md'))) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'Not a skill directory (no SKILL.md).',
          { handler: 'skill-edit-external' },
        );
        return;
      }
      registerExternalSkill(name, realDir);
      successResponse(
        res,
        200,
        SkillEditExternalSuccessSchema,
        { docName: externalSkillLiveDocName(name) },
        { handler: 'skill-edit-external' },
      );
    },
    {
      handler: 'skill-edit-external',
      method: 'POST',
      preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: 'skill-edit-external' }),
    },
  );

  // `POST /api/skill/move-scope` — relocate a skill across scopes (project ↔
  // global), server-side atomic. Replaces the old client copy+delete dance,
  // which wrote the destination through the CRDT content-doc path while a stale
  // live doc was open — the bridge MERGED old+new instead of replacing, so a
  // global↔project round-trip DOUBLED the SKILL.md body. Here the whole bundle
  // dir is copied verbatim (binaries included) with both live docs closed, the
  // source is removed, and install projections are transferred — one request,
  // no merge window.
  const handleSkillMoveScope = withValidation(
    SkillMoveScopeRequestSchema,
    async (_req, res, body) => {
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-move-scope',
          });
          return;
        }
        const { name, fromScope, toScope } = body;
        if (!validateSkillName(name, res, 'skill-move-scope')) return;
        if (fromScope === toScope) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Source and destination scope are the same.',
            { handler: 'skill-move-scope' },
          );
          return;
        }
        if (toScope === 'project' && !projectDir) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Cannot move to project scope — no project root is resolved for this server.',
            { handler: 'skill-move-scope', detail: 'NO_PROJECT_ROOT' },
          );
          return;
        }

        const { root: fromRoot, dirRel: fromDirRel, realDir } = effectiveSkillRoot(fromScope, name);
        const fromDir = resolve(fromRoot, name);
        // Where the BYTES live, which is not always `fromDir`.
        // `resolveSkillDirForRead` answers "where is this skill found", by root
        // precedence, and never realpaths — so once `source` points the skill at
        // another location the elected path is itself a symlink. A move has to
        // relocate the real tree, so resolve it once here and let every step
        // below agree on the same answer instead of each rediscovering it.
        const fromContentDir = (() => {
          try {
            return realpathSync(fromDir);
          } catch {
            return fromDir;
          }
        })();
        // Destination: the target scope's default skill home (store retirement —
        // moved skills land in-place like creates/imports do).
        const toBase2 = toScope === 'project' ? contentDir : skillsHome;
        const toRoot = resolve(toBase2, resolveDefaultSkillHomeRel(toBase2, toScope));
        const toDir = resolve(toRoot, name);
        if (realDir === null || !existsSync(fromDir)) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-move-scope',
            detail: `Skill "${name}" not found in ${fromScope} scope.`,
          });
          return;
        }
        if (
          resolve(realDir) === resolve(toDir) ||
          (existsSync(toDir) && realpathSync(realDir) === realpathSync(toDir))
        ) {
          errorResponse(
            res,
            409,
            'urn:ok:error:doc-already-exists',
            'The source and destination resolve to the same skill directory.',
            { handler: 'skill-move-scope', detail: 'SAME_STORAGE' },
          );
          return;
        }
        // A clean absence is the ONLY safe "destination free" — never overwrite a
        // same-named skill at the target scope (that would then delete the source
        // = data loss). Registry-wide: any occurrence at the target scope blocks.
        if (resolveSkillDirForRead(toScope, name) !== null || existsSync(toDir)) {
          errorResponse(
            res,
            409,
            'urn:ok:error:doc-already-exists',
            `A ${toScope} skill named "${name}" already exists.`,
            { handler: 'skill-move-scope' },
          );
          return;
        }

        // Capture source install state BEFORE tearing anything down, so the
        // projection can be re-created at the destination scope.
        const fromBase = skillInstallBase(fromScope);
        const toBase = skillInstallBase(toScope);
        const priorInstall = fromBase ? readInstalledSkills(fromBase).skills[name] : undefined;
        // The install MARKER is NOT the source of truth for an in-place skill's
        // host set: a skill installed into editor dirs the marker never recorded
        // (created/imported in place, or an older marker) reads back with fewer
        // hosts than it really occupies. The SCAN — which editor dirs actually
        // hold a copy — is authoritative (same rule the install handler +
        // sweepSkillOccurrences follow). Union both so a scope move preserves
        // EVERY editor the skill was installed in, not just what the marker
        // happened to list — otherwise it re-lands only on the default hub and
        // silently drops .claude/.cursor/etc..
        const fromScanBase = fromScope === 'project' ? contentDir : skillsHome;
        const scanEntry = (
          fromScope === 'project'
            ? scanInPlaceSkills(contentDir)
            : scanGlobalInPlaceSkills(skillsHome)
        ).find((sk) => sk.name === name);
        // Editors that reach this skill only via a FOLDER-level symlink (e.g.
        // `.claude/skills` → `.agents/skills`) are excluded from `scanEntry.hosts`
        // by design — they hold no independent copy (same inode as the canonical).
        // But they ARE a real audience: those editors currently SEE the skill. The
        // destination scope has no such folder symlink, so unless we materialize
        // them the move silently drops that reach. Union the alias audience — the
        // editors whose skills-root symlinks to this skill's canonical root — so
        // the destination projects real copies and reachability is preserved.
        const canonicalRootRel = scanEntry ? dirname(scanEntry.dir) : null;
        const aliasAudience =
          canonicalRootRel !== null
            ? Object.entries(scanHostRootAliases(fromScanBase, fromScope))
                .filter(([, target]) => target === canonicalRootRel)
                .map(([editor]) => editor)
            : [];
        const priorHosts = [
          ...new Set([
            ...(priorInstall ? resolvedHosts(priorInstall.hosts) : []),
            ...(scanEntry ? resolvedHosts(scanEntry.hosts) : []),
            ...resolvedHosts(aliasAudience),
          ]),
        ];

        // Tear down BOTH live skill docs (source + destination) BEFORE touching
        // disk — a verbatim dir copy with the live docs closed can't merge into a
        // stale open doc (the content-doubling root cause).
        await captureAndCloseDocuments(
          [
            ...new Set([
              ...(fromScope === 'project' ? [`${fromDirRel}/SKILL`] : []),
              skillLiveDocName(fromScope, name),
              skillLiveDocName(toScope, name),
            ]),
          ],
          'renamed',
        );

        // Copy the WHOLE bundle verbatim (SKILL.md + references + scripts +
        // binaries) in one fs op — no CRDT write path, nothing to merge. Binaries
        // that the old text-only client copy silently dropped come along.
        tracedMkdirSync(toRoot, { recursive: true });
        // `dereference` is load-bearing, not a detail. The source dir is a
        // SYMLINK whenever the skill's `source` was pointed at another location,
        // and cpSync's default (false) copies the link rather than the bytes —
        // so the destination becomes a link to the very tree the delete below
        // removes, and every path in the new scope dangles at once.
        tracedCpSync(fromContentDir, toDir, { recursive: true, dereference: true });

        // Same-hash copies/links of the source go first (lossless-guarded), then
        // the source itself (rm -rf of the whole skill dir).
        sweepSkillOccurrences(fromScope, name);
        const del = applySkillDelete({ skillsRoot: fromRoot, name });
        // `fromRoot` is `dirname(elected path)`, and the election never
        // realpaths — so when the elected occurrence is a symlink (the `source`
        // verb pointed this skill elsewhere) the delete above removed only the
        // pointer and left the real tree behind. A move that leaves its bytes at
        // the origin is a copy. Bounded to the scope's own base: an outside-base
        // source tree is the user's own directory, and nothing scans it, so it
        // can't come back as a ghost occurrence.
        if (del.ok && fromContentDir !== fromDir) {
          // Both sides must be realpath'd before they can be compared: macOS
          // resolves the tmpdir-rooted `/var` to `/private/var`, so a base taken
          // verbatim makes every contained path look like an escape.
          const realScanBase = (() => {
            try {
              return realpathSync(fromScanBase);
            } catch {
              return fromScanBase;
            }
          })();
          const relFromBase = relative(realScanBase, fromContentDir);
          if (relFromBase !== '' && !relFromBase.startsWith('..') && !isAbsolute(relFromBase)) {
            tracedRmSync(fromContentDir, { recursive: true, force: true });
          }
        }
        if (!del.ok) {
          // Roll back the destination copy so a failed source-removal can't leave
          // a duplicate — the failure mode this whole endpoint exists to prevent.
          applySkillDelete({ skillsRoot: toRoot, name });
          errorResponse(
            res,
            500,
            'urn:ok:error:internal-server-error',
            'Failed to move skill (source removal failed); rolled back the copy.',
            {
              handler: 'skill-move-scope',
              detail: del.error.code,
              cause: new Error(del.error.message),
            },
          );
          return;
        }

        const movedLockEntry = await transferSkillLockEntry(fromScope, toScope, name);

        // Transfer install projections: drop the source-scope projections +
        // marker, then re-project into the destination scope for the same hosts.
        // Re-project on ANY resolved host (marker OR scan) — a scan-only in-place
        // skill has no marker entry but still occupies real editor dirs. Stamp the
        // new marker with the DESTINATION scope (not the source's stale scope).
        if (fromBase) await uninstallSkillFromHostDirs(fromBase, name, fromScope);
        if (toBase && priorHosts.length > 0) {
          const newHosts = projectSkill(
            toDir,
            name,
            toBase,
            priorHosts,
            projectionModeFor(toScope, body.name),
            skillProjectionRoots(toScope),
          );
          await recordSkillInstall(toBase, name, {
            ...priorInstall,
            scope: toScope,
            hosts: newHosts,
            scripts: priorInstall?.scripts ?? validateSkillForInstall(toDir, name).hasScripts,
            installedAt: priorInstall?.installedAt ?? new Date().toISOString(),
          });
        }

        // Attribution + shadow-commit for whichever side is a versioned project
        // scope (global is unversioned — no shadow repo). At most one side is
        // project on a cross-scope move.
        if (fromScope === 'project' || toScope === 'project') {
          attributeOkArtifactWrite(
            actor,
            fromScope === 'project' ? fromDirRel : relative(contentDir, toDir).split(sep).join('/'),
            `skill-move-scope: ${fromScope} -> ${toScope} ${name}`,
          );
          await commitOkArtifactWrite('skill-move-scope');
        }

        if (movedLockEntry) {
          const movedLocalHash = localSkillHash(toRoot, name);
          const movedBaselineRef =
            toScope === 'project'
              ? await shadowHeadSha(
                  artifactWriterId(actor),
                  relative(contentDir, toDir).split(sep).join('/'),
                )
              : undefined;
          await updateSkillLockEntry(toScope, name, {
            localHash: movedLocalHash,
            ...(toScope === 'project' ? { baselineRef: movedBaselineRef } : {}),
          });
        }

        // A 200 here must mean the skill is READABLE at the destination. The
        // projection step writes through host roots derived from config, and a
        // bad root could delete what the copy just placed — reporting success
        // then leaves the user believing a move happened that in fact destroyed
        // the bundle. Verify the post-condition rather than trusting that every
        // step returned without throwing.
        if (!existsSync(join(toDir, 'SKILL.md'))) {
          errorResponse(
            res,
            500,
            'urn:ok:error:internal-server-error',
            'The move did not leave a readable skill at the destination; nothing was reported as moved.',
            { handler: 'skill-move-scope', detail: relative(toBase2, toDir).split(sep).join('/') },
          );
          return;
        }

        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillMoveScopeSuccessSchema,
          { scope: toScope, path: relative(toBase2, toDir).split(sep).join('/') },
          { handler: 'skill-move-scope' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to move skill across scopes.',
          { handler: 'skill-move-scope', cause: e },
        );
      }
    },
    { handler: 'skill-move-scope', method: 'POST' },
  );

  // `POST /api/skill/duplicate` — copy a complete bundle within one scope.
  // This is server-side because the GET surface intentionally does not inline
  // binary bytes; a client-side GET+PUT compose silently dropped them.
  const handleSkillDuplicate = withValidation(
    SkillDuplicateRequestSchema,
    async (_req, res, body) => {
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-duplicate',
          });
          return;
        }
        if (!validateSkillName(body.name, res, 'skill-duplicate')) return;
        if (!validateSkillName(body.toName, res, 'skill-duplicate')) return;
        if (rejectReservedBuiltinSkill(body.toName, res, 'skill-duplicate')) return;

        const sourceDir = resolveSkillDirForRead(body.scope, body.name);
        if (sourceDir === null || !existsSync(join(sourceDir, 'SKILL.md'))) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-duplicate',
            detail: 'SOURCE_NOT_FOUND',
          });
          return;
        }
        const base = body.scope === 'project' ? contentDir : skillsHome;
        const targetRoot = resolve(base, resolveDefaultSkillHomeRel(base, body.scope));
        const targetDir = resolve(targetRoot, body.toName);
        if (resolveSkillDirForRead(body.scope, body.toName) !== null || existsSync(targetDir)) {
          errorResponse(
            res,
            409,
            'urn:ok:error:doc-already-exists',
            `A ${body.scope} skill named "${body.toName}" already exists.`,
            { handler: 'skill-duplicate' },
          );
          return;
        }

        const source = parseSkillDir(sourceDir);
        if (!source) {
          errorResponse(res, 422, 'urn:ok:error:invalid-request', 'Source has no readable skill.', {
            handler: 'skill-duplicate',
          });
          return;
        }
        tracedMkdirSync(targetRoot, { recursive: true });
        // A duplicate is a new independent skill; if the source canonical is a
        // symlink (`source` pointed elsewhere) the copy must still be bytes.
        tracedCpSync(sourceDir, targetDir, { recursive: true, dereference: true });
        const { fenced, body: sourceBody } = detectFmRegion(source.skillMd);
        // presence-exempt: no CRDT write, no agent identity
        const renamed = applyPatchToFm(fenced, { name: body.toName });
        if (!renamed.ok) {
          applySkillDelete({ skillsRoot: targetRoot, name: body.toName });
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Failed to write duplicated skill.',
            {
              handler: 'skill-duplicate',
              detail: renamed.error.kind,
            },
          );
          return;
        }
        try {
          tracedWriteFileSync(join(targetDir, 'SKILL.md'), `${renamed.nextFenced}${sourceBody}`);
        } catch (error) {
          applySkillDelete({ skillsRoot: targetRoot, name: body.toName });
          throw error;
        }

        if (body.scope === 'project') {
          const targetRel = relative(contentDir, targetDir).split(sep).join('/');
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.toName),
            `skill-duplicate: ${body.name} -> ${targetRel}`,
          );
          await commitOkArtifactWrite('skill-duplicate');
        }
        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillDuplicateSuccessSchema,
          { name: body.toName },
          { handler: 'skill-duplicate' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to duplicate skill.',
          { handler: 'skill-duplicate', cause: e },
        );
      }
    },
    { handler: 'skill-duplicate', method: 'POST' },
  );

  const handleSkill = methodRouter(
    { GET: handleSkillGet, PUT: handleSkillPut, POST: handleSkillMove, DELETE: handleSkillDelete },
    { handler: 'skill' },
  );

  // ─── `/api/skill-file` — ONE bundle file (any path inside the skill) ──────
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
  function classifySkillFilePath(rel: string): 'reference' | 'script' | 'file' | null {
    // Reject a NUL byte for parity with the sibling validators
    // (`resolveSkillFilePath`, `resolveBundleFileAbs`) — a NUL can truncate a
    // path at the syscall boundary.
    if (rel.includes('\x00')) return null;
    const segments = rel
      .replace(/\\/g, '/')
      .split('/')
      .filter((s) => s !== '' && s !== '.');
    if (segments.length < 1 || segments.some((s) => s === '..')) return null;
    // `SKILL.md` is the skill's identity — mutated only through the skill
    // verbs (PUT /api/skill, rename, delete), never the file surface.
    if (segments.length === 1 && (segments[0] as string).toLowerCase() === 'skill.md') return null;
    if (segments[0] === 'references' && segments.length >= 2) return 'reference';
    if (segments[0] === 'scripts' && segments.length >= 2) return 'script';
    // Anything else in-bundle (root files, custom dirs — `assets/`, `docs/`,
    // a root `NOTES.md`): a plain bundle file, fs-direct. Imports have always
    // landed these; the mutation surface admits them too. In-place `.md`
    // files here are ordinary content docs the file watcher ingests.
    return 'file';
  }

  /** Whether a project `.md` reference (the CRDT-routed case) — else fs-direct. */
  function isProjectMdReference(
    scope: 'project' | 'global',
    kind: 'reference' | 'script' | 'file',
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
  async function reindexMovedProjectSkillDocs(
    skillsRoot: string,
    fromName: string,
    toName: string,
  ): Promise<void> {
    if (!derivedDocumentIndex) {
      // Last silent exit on this path. Returning here means a rename does NO
      // re-index at all: the file watcher still drops the old doc, so the skill
      // leaves tags/backlinks/search with nothing taking its place. Every other
      // branch here now reports; this one must too.
      getLogger('skill-move').warn(
        { fromName, toName },
        'no derived-document index available — skipping re-index of the moved skill (its old entries will be dropped with no replacement)',
      );
      return;
    }
    const derivedMutations: DerivedDocumentIndexMutation[] = [];
    const collectReindex = (oldDocName: string, newDocName: string, absFile: string): void => {
      let markdown: string;
      try {
        markdown = readFileSync(absFile, 'utf-8');
      } catch (err) {
        // Unreadable relocated file: drop the stale old-name entry rather than
        // leave it dangling (the next open will index it fresh from disk).
        //
        // LOUD, because the consequence is severe and was invisible: this drops
        // the old entry and adds no new one, so the skill vanishes from tags,
        // backlinks and search until something re-indexes it. Swallowing the
        // read error made that indistinguishable from a healthy rename.
        getLogger('skill-move').warn(
          { err, absFile, oldDocName, newDocName },
          'relocated skill file unreadable after move — dropping the old index entry with no replacement',
        );
        derivedMutations.push({ kind: 'delete', documentName: oldDocName });
        return;
      }
      derivedMutations.push({
        kind: 'rename',
        oldDocumentName: oldDocName,
        newDocumentName: newDocName,
        markdown,
      });
    };

    // SKILL.md: its rewrite during the move is fs-direct (applySkillWrite), so
    // it never re-enters the index via a CRDT write either. The reference `.md`
    // files were git-mv'd verbatim — never rewritten — so they too are stale.
    // Doc names derive from the ACTUAL root (in-place skills live at editor-dir
    // paths; the store root yields the legacy `.ok/skills/...` names).
    const rootRel = relative(contentDir, skillsRoot).split(sep).join('/');
    const docFor = (n: string, rel?: string): string =>
      `${rootRel}/${n}/${rel ? rel.replace(/\.mdx?$/i, '') : 'SKILL'}`;
    collectReindex(docFor(fromName), docFor(toName), resolve(skillsRoot, toName, 'SKILL.md'));
    for (const rel of listProjectMdReferences(skillsRoot, toName)) {
      collectReindex(docFor(fromName, rel), docFor(toName, rel), resolve(skillsRoot, toName, rel));
    }
    await derivedDocumentIndex.recordDirectMutations(derivedMutations);
  }

  /**
   * Re-index the OTHER skills' docs whose bodies the ref rewrite touched. The
   * renamed skill's own files are excluded — `reindexMovedProjectSkillDocs`
   * already re-read them from disk under their new names, and a second
   * mutation at the old name would resurrect it.
   */
  async function reindexRewrittenSkillRefDocs(
    rewrites: readonly SkillRefRewrite[],
    movedName: string,
  ): Promise<void> {
    if (!derivedDocumentIndex || rewrites.length === 0) return;
    const mutations: DerivedDocumentIndexMutation[] = [];
    for (const rw of rewrites) {
      if (rw.dir.split('/').pop() === movedName) continue;
      mutations.push({
        kind: 'link-rewrite',
        documentName: `${rw.dir}/${rw.rel.replace(/\.mdx?$/i, '')}`,
        markdown: rw.markdown,
      });
    }
    if (mutations.length > 0) await derivedDocumentIndex.recordDirectMutations(mutations);
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
        // Built-in `open-knowledge*` skills: files come from the editor host
        // dir, and the `SKILL.md` (skill-dir root) is allowed read-only here so
        // the managed skill's entrypoint opens in the read-only viewer. Project
        // built-in under the project root, user-global ones under `<home>`.
        const builtinBase = isInternalBundleSkillName(name)
          ? scope === 'global'
            ? skillsHome
            : projectDir
          : undefined;
        const builtinHost = url.searchParams.get('host') ?? undefined;
        const builtin = builtinBase ? resolveBuiltinSkillDir(builtinBase, name, builtinHost) : null;
        // A full-directory skill (import captures the WHOLE dir) can carry files
        // outside references/scripts — a root `config.yaml`, a `data/` subdir.
        // `readSkillBundledFiles` lists the whole dir, so the sidebar tree shows
        // them; the READ must therefore serve any in-dir file too, or the tree
        // shows a file that fails to open (§8.1: "appears but couldn't load").
        // Containment (below) is the real safety gate — reject only NUL / empty
        // here; `kind` is a response hint the viewer ignores (it dispatches on
        // extension), so unclassified files default to 'reference'.
        if (rel === '' || rel.includes('\x00')) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid skill file path.', {
            handler: 'skill-file-get',
          });
          return;
        }
        const kind =
          (builtin && rel === 'SKILL.md' ? 'reference' : classifySkillFilePath(rel)) ?? 'reference';
        // Which same-named bundle this file belongs to. Several distinct-content
        // skills can share a name across host dirs; without the host, a bundle
        // file request would serve whichever one a bare name lookup lands on —
        // the wrong bytes, silently, for every row but that one.
        const host = builtinHost;
        // A built-in resolves its own host dir above; anything else resolves here.
        const resolvedSkillDir = builtinBase
          ? (builtin?.dir ?? null)
          : resolveSkillDirForRead(scope, name, host);
        if (resolvedSkillDir === null && host !== undefined) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-file-get',
            detail: `No skill "${name}" (${scope}) in ${host}.`,
          });
          return;
        }
        const skillDir = resolvedSkillDir ?? resolve(resolveSkillsRoot(scope), name);
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
        if (rejectReservedBuiltinSkill(body.name, res, 'skill-file-put')) return;
        const kind = classifySkillFilePath(body.path);
        if (kind === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Invalid skill file path (must name a file inside the skill dir, no `..`).',
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
        // Resolve the skill's REAL dir (in-place-first; store retirement) —
        // bundle files land next to wherever the SKILL.md actually lives.
        const skillDirAbs = resolveSkillDirForRead(body.scope, body.name);
        if (skillDirAbs === null || !existsSync(join(skillDirAbs, 'SKILL.md'))) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-file-put',
            detail: `Create skill "${body.name}" before adding bundle files.`,
          });
          return;
        }
        const fileBase = body.scope === 'project' ? contentDir : skillsHome;
        const skillDirRel = relative(fileBase, skillDirAbs).split(sep).join('/');
        const rel = body.path.replace(/\\/g, '/');
        const routedThroughContent = isProjectMdReference(body.scope, kind, rel);
        let created: boolean;

        if (routedThroughContent) {
          // Project `.md` reference = CRDT content doc: route the write through
          // the doc's `Y.Text('source')` via the sanctioned paired-write
          // primitive (precedent #24 / #38), same branch as the SKILL.md body.
          // Persistence serializes Y.Text verbatim to `.ok/skills/<name>/<rel>`.
          const refDocName = `${skillDirRel}/${rel.replace(/\.mdx?$/i, '')}`;
          // Refuse if the reference content doc is mid-conflict — same gate as
          // the sibling content-write handlers.
          if (checkSkillDocConflictGate(refDocName, 'skill-file-put', res)) return;
          created = !existsSync(resolve(skillDirAbs, rel));
          // Enforce the per-skill bundle-file cap on this CRDT-routed branch too.
          // The fs-direct branch counts inside `applySkillBundleFileWrite`;
          // without this, project `.md` references (the most common bundle file)
          // could grow unbounded while scripts + global refs are capped.
          if (created && countBundleFiles(skillDirAbs) >= BUNDLE_MAX_FILES) {
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
            skillsRoot: dirname(skillDirAbs),
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
            `${created ? 'skill-file-create' : 'skill-file-edit'}: ${skillDirRel}/${rel}`,
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
        if (rejectReservedBuiltinSkill(name, res, 'skill-file-delete')) return;
        const scope = parseSkillScope(sp.get('scope'), res, 'skill-file-delete');
        if (scope === null) return;
        const rel = (sp.get('path') ?? '').replace(/\\/g, '/');
        const kind = classifySkillFilePath(rel);
        if (kind === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Invalid skill file path (must name a file inside the skill dir).',
            { handler: 'skill-file-delete' },
          );
          return;
        }
        const actor = extractActorIdentityFromQuery(url, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-file-delete',
          });
          return;
        }
        // Resolve the skill's REAL dir (in-place-first, store fallback) like the
        // sibling GET/PUT handlers — the raw store root silently no-opped every
        // in-place bundle-file delete (the store-fossil class).
        const realDir = resolveSkillDirForRead(scope, name);
        const skillsRoot = realDir !== null ? dirname(realDir) : resolveSkillsRoot(scope);

        // A project `.md` reference is a live content doc — tear it down BEFORE
        // removing the file so its persistence branch can't resurrect it. The
        // doc name derives from the REAL dir (a minted store shape closed
        // nothing for an in-place skill).
        //
        // Gated on the file actually being there: the teardown closes
        // connections, marks the doc `deleted-upstream` and unloads it, and the
        // doc name is ext-less — so `references/x.md` and `references/x.mdx`
        // name the SAME doc. Deleting a path that isn't on disk would otherwise
        // tear down the live doc of a same-stem sibling that survives the
        // no-op unlink below.
        const bundleAbs = resolve(realDir ?? join(skillsRoot, name), rel);
        if (existsSync(bundleAbs) && isProjectMdReference(scope, kind, rel)) {
          const extLess = rel.replace(/\.md$/i, '');
          const refDoc =
            realDir !== null
              ? `${relative(contentDir, realDir).split(sep).join('/')}/${extLess}`
              : projectRefContentDocName(name, rel);
          await captureAndCloseDocuments([refDoc], 'deleted-upstream');
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
            // The skill's REAL dir, not the retired store path: recording
            // `.ok/skills/…` wrote a version titled with a path that does not
            // exist, and that title shows in /api/history and the version picker.
            `skill-file-delete: ${
              realDir !== null
                ? `${relative(contentDir, realDir).split(sep).join('/')}/${rel}`
                : `${name}/${rel}`
            }`,
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

  const handleSkillFile = methodRouter(
    { GET: handleSkillFileGet, PUT: handleSkillFilePut, DELETE: handleSkillFileDelete },
    { handler: 'skill-file' },
  );
  const handleSkillFileRename = withValidation(
    SkillFileRenameRequestSchema,
    async (_req, res, body) => {
      try {
        if (!validateSkillName(body.name, res, 'skill-file-rename')) return;
        if (rejectReservedBuiltinSkill(body.name, res, 'skill-file-rename')) return;
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-file-rename',
          });
          return;
        }
        const from = body.from.replace(/\\/g, '/');
        const to = body.to.replace(/\\/g, '/');
        const fromKind = classifySkillFilePath(from);
        const toKind = classifySkillFilePath(to);
        if (fromKind === null || toKind === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Both paths must stay inside the skill dir.',
            { handler: 'skill-file-rename', detail: fromKind === null ? from : to },
          );
          return;
        }
        // The skill's REAL dir (in-place-first, store fallback) — same
        // resolution as the sibling GET/PUT/DELETE handlers.
        const realDir = resolveSkillDirForRead(body.scope, body.name);
        if (realDir === null) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-file-rename',
          });
          return;
        }
        const skillsRoot = dirname(realDir);

        const fromIsDoc = isProjectMdReference(body.scope, fromKind, from);
        const toIsDoc = isProjectMdReference(body.scope, toKind, to);
        const dirRel = relative(contentDir, realDir).split(sep).join('/');
        const fromDocName = fromIsDoc ? `${dirRel}/${from.replace(/\.md$/i, '')}` : null;
        const toDocName = toIsDoc ? `${dirRel}/${to.replace(/\.md$/i, '')}` : null;

        // A live content doc mid-conflict must settle before its identity moves.
        if (
          fromDocName !== null &&
          checkSkillDocConflictGate(fromDocName, 'skill-file-rename', res)
        )
          return;
        // Tear the source doc down BEFORE the fs move so persistence can't
        // resurrect the old path; the new-name doc indexes fresh from disk.
        if (fromDocName !== null) {
          await captureAndCloseDocuments([fromDocName], 'deleted-upstream');
        }

        const result = applySkillBundleFileRename({
          skillsRoot,
          name: body.name,
          relPath: from,
          toRelPath: to,
        });
        if (!result.ok) {
          const status = result.error.code === 'RENAME_FAILED' ? 500 : 400;
          errorResponse(
            res,
            status,
            status === 500 ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request',
            result.error.message,
            { handler: 'skill-file-rename', detail: result.error.code },
          );
          return;
        }

        // Keep the link graph current for a moved `.md` reference: renamed in
        // place when both ends are docs, otherwise drop/add the affected side.
        if (derivedDocumentIndex) {
          const mutations: DerivedDocumentIndexMutation[] = [];
          if (fromDocName !== null && toDocName !== null) {
            try {
              mutations.push({
                kind: 'rename',
                oldDocumentName: fromDocName,
                newDocumentName: toDocName,
                markdown: readFileSync(resolve(skillsRoot, body.name, to), 'utf-8'),
              });
            } catch {
              mutations.push({ kind: 'delete', documentName: fromDocName });
            }
          } else if (fromDocName !== null) {
            mutations.push({ kind: 'delete', documentName: fromDocName });
          } else if (toDocName !== null) {
            try {
              mutations.push({
                kind: 'upsert',
                documentName: toDocName,
                markdown: readFileSync(resolve(skillsRoot, body.name, to), 'utf-8'),
              });
            } catch {
              // Unreadable — the next open indexes it fresh.
            }
          }
          await recordDerivedMutationsBestEffort(mutations, 'skill-file-rename');
        }

        if (body.scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.name),
            `skill-file-rename: ${body.name}/${from} -> ${to}`,
          );
          await commitOkArtifactWrite('skill-file-rename');
        }
        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillFileRenameSuccessSchema,
          {
            from,
            to,
            ...(fromDocName !== null ? { fromDocName } : {}),
            ...(toDocName !== null ? { toDocName } : {}),
          },
          { handler: 'skill-file-rename' },
        );
      } catch (err) {
        log.error({ err }, '[skill-file-rename] failed');
        if (!res.headersSent) {
          errorResponse(
            res,
            500,
            'urn:ok:error:internal-server-error',
            'Failed to rename skill file.',
            { handler: 'skill-file-rename' },
          );
        }
      }
    },
    { handler: 'skill-file-rename', method: 'POST' },
  );

  // ─── `POST /api/skill/import` — acquire a skill into `.ok/skills` (slice 3) ───
  // Fetch a skill-dir (remote/local source),
  // write it via the SAME sanctioned fs-direct content writers the reconcile
  // path uses (`applySkillWrite` + `applySkillBundleFileWrite`), attribute +
  // shadow-commit (project scope), and record upstream in `.ok/skills-lock.json`.
  // Scripts are written as content, NEVER executed.

  /** `https://github.com/owner/repo.git` → `owner`; else undefined. */
  function publisherFromSource(source: string): string | undefined {
    const m = /github\.com[/:]([\w.-]+)\//.exec(source);
    return m ? m[1] : undefined;
  }

  // Lockfile IO lives in `skills-lock-store.ts`: mutations are serialized per
  // path and written atomically, which a bare read-then-write here was not. Read
  // inside `mutateSkillsLock`'s callback, never from a snapshot taken before it.
  const readSkillsLock = readSkillsLockFile;
  // Mutation baseline: hash the skill AS IT NOW SITS ON DISK, right after a
  // sanctioned write. Stored as `localHash`; `skills-list` flags a skill modified
  // when its current on-disk hash diverges from this. `null` when the dir can't be
  // read (never happens right after a successful write, but keeps the type honest).
  function localSkillHash(skillsRoot: string, name: string): string | undefined {
    return parseSkillDir(resolve(skillsRoot, name))?.contentHash;
  }
  // Shadow-repo HEAD right after an artifact commit — the Revert baseline. At this
  // point HEAD is the commit that just captured the freshly-written skill, so its
  // subtree holds the installed bytes. `undefined` when there's no shadow repo
  // (non-git project); Revert stays unavailable, consistent with version history.
  async function shadowHeadSha(
    writerId?: string,
    verifyPathRel?: string,
  ): Promise<string | undefined> {
    const shadow = shadowRef?.current;
    if (!shadow || !writerId) return undefined;
    // The shadow repo has NO `HEAD`/`main` — writes land on per-writer WIP refs
    // (`refs/wip/<branch>/<writerId>`, precedent #25). `commitOkArtifactWrite` has
    // just driven the persistence drain, so the calling actor's WIP ref now points
    // at a commit whose tree holds the freshly-written skill. Capture THAT (a valid
    // baseline `restoreSkillVersion` restores from) rather than `rev-parse HEAD`,
    // which always throws here and left `baselineRef` — hence Revert — unrecorded.
    //
    // `verifyPathRel`: concurrent attribution flushes COALESCE, so the awaited
    // commit can resolve against an EARLIER in-flight flush — the ref then still
    // points one commit behind (a delete commit got recorded as azure-deploy's
    // baseline). When given, the head only counts if its tree contains the path;
    // otherwise re-flush once and re-read. A still-missing path returns
    // undefined — no baseline beats a WRONG baseline (revert stays hidden).
    try {
      const sg = shadowGit(shadow);
      const readMine = async (): Promise<string | undefined> => {
        const refs = (await sg.raw('for-each-ref', '--format=%(refname)', 'refs/wip/'))
          .trim()
          .split('\n')
          .filter(Boolean);
        const mine = refs.find((r) => r.endsWith(`/${writerId}`));
        if (!mine) return undefined;
        return (await sg.raw('rev-parse', mine)).trim();
      };
      const treeHas = async (sha: string, rel: string): Promise<boolean> => {
        const out = await sg.raw('ls-tree', '-r', '--name-only', sha, '--', rel);
        return out.trim().length > 0;
      };
      let sha = await readMine();
      if (
        sha !== undefined &&
        verifyPathRel !== undefined &&
        !(await treeHas(sha, verifyPathRel))
      ) {
        await commitOkArtifactWrite('baseline-verify');
        sha = await readMine();
        if (sha !== undefined && !(await treeHas(sha, verifyPathRel))) return undefined;
      }
      return sha;
    } catch {
      return undefined;
    }
  }
  // The writer id the artifact-write commits under (agent/principal); anonymous
  // writes don't attribute, so there's no WIP ref to baseline from.
  const artifactWriterId = (actor: ReturnType<typeof extractActorIdentity>): string | undefined =>
    actor.kind === 'agent' || actor.kind === 'principal' ? actor.writerId : undefined;
  // Project a freshly written skill into the configured editor dirs now (copy
  // mode) so it is live immediately, not only after the next reconcile. Strictly
  // best-effort: a projection failure must never fail the caller.
  async function projectImportedSkillCopy(args: {
    skillsRoot: string;
    name: string;
    scope: 'project' | 'global';
    hasScripts: boolean;
    handler: string;
  }): Promise<void> {
    try {
      const installBase = skillInstallBase(args.scope);
      if (!installBase) return;
      const targets = resolveSkillTargets(installBase);
      if (targets.length === 0) return;
      const hosts = projectSkill(
        resolve(args.skillsRoot, args.name),
        args.name,
        installBase,
        targets,
        'copy',
        skillProjectionRoots(args.scope),
      );
      if (hosts.length === 0) return;
      await recordSkillInstall(installBase, args.name, {
        hosts,
        scope: args.scope,
        scripts: args.hasScripts,
        installedAt: new Date().toISOString(),
        projection: 'copy',
      });
    } catch (projectErr) {
      log.warn(
        { skill: args.name, err: projectErr },
        `${args.handler}: inline projection failed; skill written, reconcile will project on next open`,
      );
    }
  }

  function respondSkillImport(res: ServerResponse, outcome: SkillImportOutcome): void {
    if (outcome.ok) {
      successResponse(res, 200, SkillImportSuccessSchema, outcome.body, {
        handler: 'skill-import',
      });
      return;
    }
    errorResponse(res, outcome.status, outcome.urn, outcome.title, {
      handler: 'skill-import',
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
    });
  }

  const skillImportService = createSkillImportService({
    contentDir,
    skillsHome,
    ...(projectDir !== undefined ? { projectDir } : {}),
    resolveSkillDirForRead,
    parseFrontmatterDoc,
    attributeOkArtifactWrite,
    commitOkArtifactWrite,
    shadowHeadSha,
    artifactWriterId,
    effectiveInstallMode,
    signalFiles: () => signalChannel?.('files'),
  });
  const handleSkillImport = withValidation(
    SkillImportRequestSchema,
    async (_req, res, body) => {
      let cleanup: () => void = () => {};
      try {
        if (!projectDir) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project root resolved.', {
            handler: 'skill-import',
            detail: 'NO_PROJECT_ROOT',
          });
          return;
        }
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-import',
          });
          return;
        }
        const scope = body.scope;

        // 1. Resolve the acquired skill + its provenance.
        let acquiredDir: string | null = null;
        let sourceLabel: string;
        let ref: string | undefined;
        let publisher: string | undefined;
        // The picked upstream skill dir basename — recorded in the lockfile so a
        // later reimport re-selects the same skill in a multi-skill source.
        let upstreamSkill: string | undefined;
        // The marketplace-facing coordinates (`owner/repo`, or a website
        // catalog's hostname) — what an install report names. Distinct from
        // `sourceLabel`, which keeps the raw string the user typed.
        let resolvedSourceForReport = body.source;

        {
          const rawSource = body.source;
          try {
            const skillsSh = await resolveSkillsShImportSource(rawSource, body.skill);
            const resolvedSource = skillsSh?.source ?? rawSource;
            resolvedSourceForReport = resolvedSource;
            const selectedSkill = body.skill ?? skillsSh?.skill;
            const spec = skillsSh?.spec ?? parseSource(resolvedSource);
            if (!spec) {
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                'Unrecognized import source.',
                {
                  handler: 'skill-import',
                  detail:
                    'Expected owner/repo, a git URL, a website source, a local path, or a skills.sh URL.',
                },
              );
              return;
            }
            if (rejectDisallowedGitSpec(res, spec, 'skill-import')) return;
            const fetched = await fetchSource(spec);
            cleanup = fetched.cleanup;
            ref = fetched.ref;
            const dirs = discoverSkillDirs(fetched.dir);
            if (dirs.length === 0) {
              errorResponse(res, 404, 'urn:ok:error:not-found', 'No SKILL.md found in source.', {
                handler: 'skill-import',
              });
              return;
            }
            let pick = dirs[0];
            if (selectedSkill) {
              // Match the dir basename OR the SKILL.md frontmatter `name` — skills.sh
              // (and the Explore tab that forwards its result) uses the frontmatter
              // name, which often differs from the on-disk folder (e.g. folder
              // `react-native-skills` vs frontmatter `vercel-react-native-skills`).
              const found =
                dirs.find((d) => d.name === selectedSkill) ??
                // Metadata-only: this probe just matches a name. `parseSkillDir`
                // would read and hash every byte of every bundle in the clone,
                // before the size pre-flight below can refuse any of it.
                dirs.find((d) => readSkillDirMeta(d.dir)?.name === selectedSkill) ??
                // Rename alias: the skills.sh listings for the OLD pack-skill
                // names outlive the rename (there is no self-serve delist), so
                // someone can still arrive here asking for a name the mirror no
                // longer ships. Resolve it to the renamed bundle rather than
                // 404-ing a listing that looks perfectly healthy.
                dirs.find((d) => d.name === RENAMED_PACK_SKILLS[selectedSkill]);
              if (!found) {
                errorResponse(res, 404, 'urn:ok:error:not-found', 'Named skill not in source.', {
                  handler: 'skill-import',
                  detail: `--skill "${selectedSkill}" not among: ${dirs.map((d) => d.name).join(', ')}.`,
                });
                return;
              }
              pick = found;
            } else if (dirs.length > 1) {
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                'Source has multiple skills; pass `skill` to choose one.',
                { handler: 'skill-import', detail: dirs.map((d) => d.name).join(', ') },
              );
              return;
            }
            acquiredDir = pick.dir;
            upstreamSkill = pick.name;
            sourceLabel = rawSource;
            publisher = skillsSh?.publisher ?? publisherFromSource(resolvedSource);
          } catch (e) {
            if (e instanceof SkillFetchError) {
              errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Could not fetch source.', {
                handler: 'skill-import',
                cause: e,
              });
              return;
            }
            throw e;
          }
        }

        if (!acquiredDir) {
          errorResponse(res, 422, 'urn:ok:error:invalid-request', 'Source has no readable skill.', {
            handler: 'skill-import',
          });
          return;
        }
        // Steps 2-6 (dedupe → collision → write → attribute → lockfile → project)
        // are the shared import spine, also used by the upload endpoint.
        const outcome = await skillImportService.runSkillImport({
          acquiredDir,
          scope,
          sourceLabel,
          ref,
          publisher,
          upstreamSkill,
          actor,
          skipProjection: body.install === false,
        });
        // Count it on skills.sh when EITHER the user came from a skills.sh
        // listing (`marketplace`, set by the Explore tab) OR the source is our
        // own published skills repo.
        //
        // The privacy rule that gates everything else — never announce a repo
        // the user did not choose from the marketplace, because telling a third
        // party which repos they install is a disclosure they did not ask for —
        // does not apply to our own repo: the name being reported is ours, and
        // `ok init` and `ok seed` already report it unconditionally. Without the
        // second arm, `ok skills import inkeep/open-knowledge-skills`, the MCP
        // import tool on a bare repo source, and every non-Explore route that
        // installs one of our own skills went uncounted while the seed path
        // counted the same skill.
        //
        // This is the mechanism that actually moves the counter. Fetching the
        // bundle through skills.sh's download API does NOT: verified against a
        // skill sitting at 8 installs, which stayed at 8 after a download.
        if (
          outcome.ok &&
          (body.marketplace === true || isOpenKnowledgeSkillsSource(resolvedSourceForReport))
        ) {
          void reportSkillInstall(
            { source: resolvedSourceForReport, skills: [outcome.body.name] },
            resolveSkillInstallReportSettings(),
          );
        }
        respondSkillImport(res, outcome);
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to import skill.', {
          handler: 'skill-import',
          cause: e,
        });
      } finally {
        // Every exit (early-return error paths included) drops the temp clone.
        cleanup();
      }
    },
    { handler: 'skill-import', method: 'POST' },
  );

  // `POST /api/skills/import-bulk` — acquire MANY named skills from one source
  // in a SINGLE clone. The plugin case: one repo bundles dozens of skills, and
  // driving the single-skill endpoint per skill re-clones that repo every time.
  // Identical spine, provenance, dedupe, and collision rules — the only
  // differences are the amortized fetch and per-skill results, so one oversized
  // bundle or misspelled name never fails the rest of the selection.
  const handleSkillsImportBulk = withValidation(
    SkillsImportBulkRequestSchema,
    async (_req, res, body) => {
      let cleanup: () => void = () => {};
      try {
        if (!projectDir) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project root resolved.', {
            handler: 'skills-import-bulk',
            detail: 'NO_PROJECT_ROOT',
          });
          return;
        }
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skills-import-bulk',
          });
          return;
        }
        const rawSource = body.source;
        // Two source shapes, and the difference is exactly where the fetch sits:
        //  - repo / local path: ONE clone holds every skill, so fetch once and
        //    pick each selected dir out of it (the whole point of this endpoint).
        //  - website (`.well-known` skill index): a fetch materializes ONE named
        //    skill's declared files — there is no bundle on disk to amortize, so
        //    each selected skill is its own (cheap, clone-free) fetch below.
        let siteSpec: (SourceSpec & { kind: 'well-known' }) | null = null;
        let siteIndex: WellKnownIndex | null = null;
        let dirs: ReturnType<typeof discoverSkillDirs> = [];
        let ref: string | undefined;
        let publisher: string | undefined;
        // The canonical repo behind a skills.sh page URL — what the install
        // report must name so the event lands on the right listing.
        let resolvedSourceForReport = rawSource;
        try {
          // Resolution is per-SKILL by contract: a website source refuses to
          // resolve without a name (there is no repo to point at, only the
          // index's per-skill entries), and a skills.sh page URL looks its repo
          // up by one. Any of the requested names answers the same question, so
          // the first is the probe — the site branch below then re-fetches with
          // each selected name in turn, and the repo branch matches all of them
          // against the single clone.
          const skillsSh = await resolveSkillsShImportSource(rawSource, body.skills[0]);
          const resolvedSource = skillsSh?.source ?? rawSource;
          resolvedSourceForReport = resolvedSource;
          const spec = skillsSh?.spec ?? parseSource(resolvedSource);
          if (!spec) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Unrecognized import source.', {
              handler: 'skills-import-bulk',
              detail:
                'Expected owner/repo, a git URL, a website source, a local path, or a skills.sh URL.',
            });
            return;
          }
          if (rejectDisallowedGitSpec(res, spec, 'skills-import-bulk')) return;
          publisher = skillsSh?.publisher ?? publisherFromSource(resolvedSource);
          if (spec.kind === 'well-known') {
            siteSpec = spec;
            // Read the origin's index ONCE for the whole selection. Each
            // per-skill fetch would otherwise re-read it (and re-probe both
            // candidate index paths), which is a wasted round trip per skill.
            siteIndex = await readWellKnownIndex(spec.origin);
          } else {
            const fetched = await fetchSource(spec);
            cleanup = fetched.cleanup;
            ref = fetched.ref;
            dirs = discoverSkillDirs(fetched.dir);
          }
        } catch (e) {
          if (e instanceof SkillFetchError) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Could not fetch source.', {
              handler: 'skills-import-bulk',
              cause: e,
            });
            return;
          }
          throw e;
        }
        if (siteSpec === null && dirs.length === 0) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'No SKILL.md found in source.', {
            handler: 'skills-import-bulk',
          });
          return;
        }
        const results: SkillImportBulkResult[] = [];
        // Sequential by design: each import writes files, attributes, and (project
        // scope) shadow-commits — the git index is not concurrency-safe here.
        for (const requested of new Set(body.skills)) {
          let acquiredDir: string;
          let upstreamSkill: string;
          let perSkill: () => void = () => {};
          if (siteSpec !== null) {
            try {
              const one = await fetchSource(
                { ...siteSpec, skill: requested },
                siteIndex ? { index: siteIndex } : {},
              );
              acquiredDir = one.dir;
              perSkill = one.cleanup;
              upstreamSkill = requested;
            } catch (e) {
              // The site index is the authority on what exists there, so a miss
              // reads the same as a name absent from a clone.
              results.push({
                requested,
                status: e instanceof SkillFetchError ? 'not-found' : 'failed',
                warnings: [],
                ...(e instanceof SkillFetchError ? {} : { error: String(e) }),
              });
              continue;
            }
          } else {
            // Same two-way match as the single import: dir basename OR the
            // SKILL.md frontmatter name (they routinely differ).
            const found =
              dirs.find((d) => d.name === requested) ??
              dirs.find((d) => parseSkillDir(d.dir)?.name === requested) ??
              // Same rename alias as the single import: a stale old-name listing
              // resolves to the renamed bundle instead of reading as not-found.
              dirs.find((d) => d.name === RENAMED_PACK_SKILLS[requested]);
            if (!found) {
              results.push({ requested, status: 'not-found', warnings: [] });
              continue;
            }
            acquiredDir = found.dir;
            upstreamSkill = found.name;
          }
          try {
            const outcome = await skillImportService.runSkillImport({
              acquiredDir,
              scope: body.scope,
              sourceLabel: rawSource,
              ref,
              publisher,
              upstreamSkill,
              actor,
              skipProjection: body.install === false,
            });
            if (!outcome.ok) {
              getLogger('skills-import-bulk').warn(
                { skill: requested, err: outcome.cause, detail: outcome.detail },
                'bulk import: one skill failed (rest continue)',
              );
              results.push({
                requested,
                status: 'failed',
                warnings: [],
                error: outcome.detail ?? outcome.title,
              });
              continue;
            }
            results.push({
              requested,
              status: outcome.body.alreadyImported ? 'already-imported' : 'imported',
              name: outcome.body.name,
              ...(outcome.body.collisionRenamedFrom !== undefined
                ? { collisionRenamedFrom: outcome.body.collisionRenamedFrom }
                : {}),
              warnings: outcome.body.warnings,
            });
          } catch (e) {
            // Failure isolation is the contract of this endpoint, and the spine
            // can THROW as well as return a failure outcome — an unreadable
            // bundle dir (`statSync` EACCES/EPERM, or an ENOENT in the TOCTOU
            // window), a lockfile write that hits ENOSPC. Without this catch one
            // such skill aborts the selection and every already-imported result
            // is lost with it, since the response is only written after the loop.
            getLogger('skills-import-bulk').warn(
              { skill: requested, err: e },
              'bulk import: one skill threw (rest continue)',
            );
            results.push({
              requested,
              status: 'failed',
              warnings: [],
              error: e instanceof Error ? e.message : String(e),
            });
          } finally {
            perSkill();
          }
        }
        // Count the plugin/bundle funnel on skills.sh — ONE batched event for
        // the whole selection. Same two-arm rule as the single import above: a
        // skills.sh listing the user chose (`marketplace`, set by the plugin
        // bundle dialog and the MCP import rider), OR our own published repo,
        // which needs no marketplace referral to be ours to count. A hand-typed
        // third-party repo is still never announced. Fire-and-forget; the
        // reporter dedupes per skill per machine.
        if (body.marketplace === true || isOpenKnowledgeSkillsSource(resolvedSourceForReport)) {
          // `requested` — the name the skills.sh listing carries — not `name`,
          // which is the LOCAL name after collision resolution (`foo-imported`
          // when the user already held `foo`). The collector indexes listings,
          // so a locally-suffixed name is an unknown skill it cannot count.
          const importedNames = results
            .filter((r) => r.status === 'imported')
            .map((r) => r.requested);
          if (importedNames.length > 0) {
            void reportSkillInstall(
              { source: resolvedSourceForReport, skills: importedNames },
              resolveSkillInstallReportSettings(),
            );
          }
        }
        successResponse(
          res,
          200,
          SkillsImportBulkSuccessSchema,
          {
            results,
            imported: results.filter((r) => r.status === 'imported').length,
            alreadyImported: results.filter((r) => r.status === 'already-imported').length,
            failed: results.filter((r) => r.status === 'failed' || r.status === 'not-found').length,
          },
          { handler: 'skills-import-bulk' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to import skills.', {
          handler: 'skills-import-bulk',
          cause: e,
        });
      } finally {
        // One clone for the whole selection; dropped on every exit path.
        cleanup();
      }
    },
    { handler: 'skills-import-bulk', method: 'POST' },
  );

  // Upload-intake bounds (flood + zip-bomb guards). These are intentionally
  // tighter than the shared bulk-import policy and cap raw ingress before we
  // unpack or hand files to the sanctioned writers.
  const UPLOAD_MAX_FILES = 200;
  const UPLOAD_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
  const UPLOAD_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

  /**
   * Resolve a client-supplied relative path under `root`, rejecting anything that
   * escapes it (absolute paths, `..`, drive-letter, symlink-free lexical check).
   * Returns the absolute path, or null when the entry is unsafe (zip-slip).
   */
  function resolveUploadPath(root: string, rel: string): string | null {
    const norm = rel.split('\\').join('/').replace(/^\/+/, '');
    if (norm === '' || norm.split('/').some((seg) => seg === '..')) return null;
    const abs = resolve(root, norm);
    if (abs !== root && !abs.startsWith(root + sep)) return null;
    return abs;
  }

  interface UploadedPart {
    relPath: string;
    data: Buffer;
  }

  /** Collect every multipart file part into a bounded in-memory buffer. */
  function readSkillUploadParts(req: IncomingMessage): Promise<UploadedPart[]> {
    return new Promise((resolveP, reject) => {
      let bb: ReturnType<typeof busboy>;
      try {
        bb = busboy({
          headers: req.headers,
          limits: {
            files: UPLOAD_MAX_FILES,
            fields: 10,
            fieldSize: 2 * 1024,
            fileSize: UPLOAD_MAX_ENTRY_BYTES,
          },
        });
      } catch (err) {
        reject(err);
        return;
      }
      const parts: UploadedPart[] = [];
      let total = 0;
      let aborted: Error | null = null;
      // Tear down the request the instant a limit is breached so the rest of a
      // hostile multipart body is never buffered into memory (busboy's own
      // per-file/file-count limits would still admit UPLOAD_MAX_FILES *
      // UPLOAD_MAX_ENTRY_BYTES before `close` fires — the total-size guard below
      // is what actually bounds memory).
      const abort = (err: Error) => {
        if (aborted) return;
        aborted = err;
        req.unpipe(bb);
        req.destroy();
        bb.destroy();
        reject(err);
      };
      bb.on('file', (_field, stream, info) => {
        const chunks: Buffer[] = [];
        let truncated = false;
        stream.on('data', (c: Buffer) => {
          if (aborted) return;
          total += c.length;
          if (total > UPLOAD_MAX_TOTAL_BYTES) {
            abort(new Error('Upload too large.'));
            return;
          }
          chunks.push(c);
        });
        stream.on('limit', () => {
          truncated = true;
        });
        stream.on('end', () => {
          if (aborted) return;
          if (truncated) {
            aborted = new Error(`File "${info.filename}" exceeds the per-file size limit.`);
            return;
          }
          parts.push({ relPath: info.filename || 'file', data: Buffer.concat(chunks) });
        });
      });
      bb.on('error', reject);
      bb.on('close', () => (aborted ? reject(aborted) : resolveP(parts)));
      req.pipe(bb);
    });
  }

  /** Unpack a `.zip` buffer into `destDir`, rejecting zip-slip + oversize/bomb. */
  function unzipBufferToDir(buffer: Buffer, destDir: string): Promise<void> {
    return new Promise((resolveP, reject) => {
      yauzlFromBuffer(buffer, { lazyEntries: true }, (err, zip?: ZipFile) => {
        if (err || !zip) {
          reject(err ?? new Error('Unreadable archive.'));
          return;
        }
        let total = 0;
        let entries = 0;
        const fail = (e: unknown) => {
          try {
            zip.close();
          } catch {
            // best-effort
          }
          reject(e instanceof Error ? e : new Error(String(e)));
        };
        zip.on('entry', (entry: Entry) => {
          if (++entries > UPLOAD_MAX_FILES) {
            fail(new Error('Archive has too many entries.'));
            return;
          }
          const abs = resolveUploadPath(destDir, entry.fileName);
          if (!abs) {
            fail(new Error(`Unsafe archive entry: ${entry.fileName}`));
            return;
          }
          // Directory entries end in `/`.
          if (entry.fileName.endsWith('/')) {
            tracedMkdirSync(abs, { recursive: true });
            zip.readEntry();
            return;
          }
          if (entry.uncompressedSize > UPLOAD_MAX_ENTRY_BYTES) {
            fail(new Error(`Archive entry too large: ${entry.fileName}`));
            return;
          }
          zip.openReadStream(entry, (e2, rs) => {
            if (e2 || !rs) {
              fail(e2 ?? new Error('Could not read archive entry.'));
              return;
            }
            const chunks: Buffer[] = [];
            rs.on('data', (c: Buffer) => {
              total += c.length;
              if (total > UPLOAD_MAX_TOTAL_BYTES) {
                rs.destroy();
                fail(new Error('Archive expands beyond the size limit.'));
                return;
              }
              chunks.push(c);
            });
            rs.on('error', fail);
            rs.on('end', () => {
              // These throw, and a throw from a stream listener escapes the
              // surrounding promise entirely — it lands as an uncaughtException
              // and takes the whole server (every open collab session) with it.
              // An archive holding both `foo` and `foo/a.md` is enough: the
              // second entry's mkdir hits ENOTDIR on the file the first wrote.
              try {
                tracedMkdirSync(dirname(abs), { recursive: true });
                tracedWriteFileSync(abs, Buffer.concat(chunks));
              } catch (writeErr) {
                fail(writeErr instanceof Error ? writeErr : new Error(String(writeErr)));
                return;
              }
              zip.readEntry();
            });
          });
        });
        zip.on('end', () => resolveP());
        zip.on('error', fail);
        zip.readEntry();
      });
    });
  }

  // `POST /api/skill-upload` — acquire a skill from UPLOADED BYTES (a `.zip` of a
  // skill dir, or a folder's files) rather than a fetched source. Multipart, so
  // `scope`/`agentId` ride the query string (the body is file parts). Unpacks to
  // a temp dir, then runs the shared import spine (`runSkillImport`). Never
  // executes scripts — they are content, like the by-reference import.
  async function handleSkillUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const tmp = mkdtempSync(join(tmpdir(), 'ok-skill-upload-'));
    const cleanup = () => {
      try {
        tracedRmSync(tmp, { recursive: true, force: true });
      } catch {
        // best-effort; orphan sweep catches stragglers
      }
    };
    try {
      if (!projectDir) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project root resolved.', {
          handler: 'skill-upload',
          detail: 'NO_PROJECT_ROOT',
        });
        return;
      }
      if ((req.method ?? '').toUpperCase() !== 'POST') {
        errorResponse(res, 405, 'urn:ok:error:invalid-request', 'Use POST to upload a skill.', {
          handler: 'skill-upload',
        });
        return;
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const scope = parseSkillScope(url.searchParams.get('scope'), res, 'skill-upload');
      if (!scope) return;
      // This route carries its identity in the QUERY (the body is the multipart
      // upload), so the fields have to be lifted by hand — but all of them, not
      // just `agentId`. Dropping the rest left uploaded skills with an anonymous
      // author and no summary, while the identical import spine recorded both.
      const queryField = (key: string): string | undefined =>
        url.searchParams.get(key) ?? undefined;
      const actor = extractActorIdentity(
        {
          agentId: queryField('agentId'),
          agentName: queryField('agentName'),
          colorSeed: queryField('colorSeed'),
          clientName: queryField('clientName'),
          summary: queryField('summary'),
        },
        getPrincipal,
      );
      if (actor.kind === 'invalid-summary') {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
          handler: 'skill-upload',
        });
        return;
      }

      let parts: UploadedPart[];
      try {
        parts = await readSkillUploadParts(req);
      } catch (e) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Could not read the upload.', {
          handler: 'skill-upload',
          cause: e,
        });
        return;
      }
      if (parts.length === 0) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No files uploaded.', {
          handler: 'skill-upload',
        });
        return;
      }

      // A single `.zip`/`.skill` part → unpack it; otherwise the parts ARE the
      // skill folder (webkitdirectory upload), written at their relative paths.
      const single = parts.length === 1 ? parts[0] : null;
      const zipName = single && /\.(zip|skill)$/i.test(single.relPath) ? single.relPath : null;
      if (single && zipName) {
        try {
          await unzipBufferToDir(single.data, tmp);
        } catch (e) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Could not unpack the archive.', {
            handler: 'skill-upload',
            cause: e,
          });
          return;
        }
      } else {
        for (const part of parts) {
          const abs = resolveUploadPath(tmp, part.relPath);
          if (!abs) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Unsafe file path in upload.', {
              handler: 'skill-upload',
              detail: part.relPath,
            });
            return;
          }
          tracedMkdirSync(dirname(abs), { recursive: true });
          tracedWriteFileSync(abs, part.data);
        }
      }

      const dirs = discoverSkillDirs(tmp);
      if (dirs.length === 0) {
        errorResponse(res, 404, 'urn:ok:error:not-found', 'No SKILL.md found in the upload.', {
          handler: 'skill-upload',
        });
        return;
      }
      if (dirs.length > 1) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'Upload contains multiple skills; upload one at a time.',
          { handler: 'skill-upload', detail: dirs.map((d) => d.name).join(', ') },
        );
        return;
      }
      const pick = dirs[0];
      respondSkillImport(
        res,
        await skillImportService.runSkillImport({
          acquiredDir: pick.dir,
          scope,
          sourceLabel: `upload:${zipName ?? pick.name}`,
          upstreamSkill: pick.name,
          actor,
        }),
      );
    } catch (e) {
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to upload skill.', {
        handler: 'skill-upload',
        cause: e,
      });
    } finally {
      cleanup();
    }
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

        // IN-PLACE skills: the source is the native
        // editor-dir canonical, not the `.ok/skills` store; fan-out below runs
        // through the guarded copy primitives, and the scan (not the install
        // marker) is the truth for its host set.
        const storeSkillDir = resolve(skillsRoot, body.name);
        const inPlaceScanBase = body.scope === 'project' ? contentDir : skillsHome;
        // Store retirement: the in-place canonical WINS at BOTH scopes (a
        // same-name `.ok/skills` dir is a placement of the same skill, mirroring
        // the list + read rules). The legacy store is only the fallback source
        // for a resident not yet drained.
        const inPlaceEntry = (
          body.scope === 'project'
            ? scanInPlaceSkills(contentDir)
            : scanGlobalInPlaceSkills(skillsHome)
        ).find((s) => s.name === body.name);
        const skillDir = inPlaceEntry ? resolve(inPlaceScanBase, inPlaceEntry.dir) : storeSkillDir;
        if (!existsSync(skillDir)) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-install',
            detail: `Skill "${body.name}" not found in ${body.scope} scope — create it with write({ skill }) first.`,
          });
          return;
        }

        // Install validates the SKILL.md ON DISK (name/description non-empty),
        // but its live CRDT doc may hold unflushed edits — a description typed
        // in the editor a moment ago is still in the debounced persist window,
        // so a disk read would false-fail with "description missing".
        // Force the pending disk store to land first. No-op when nothing is
        // debounced (store-backed / never-opened skill); global skills resolve
        // to a non-content doc that also isn't debounced, so the flush is inert.
        const liveSkillDoc =
          body.scope === 'project'
            ? `${relative(inPlaceScanBase, skillDir).split(sep).join('/')}/SKILL`
            : skillLiveDocName(body.scope, body.name);
        await flushDiskAndDetectOutcome(liveSkillDoc);

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

        // ── Fork resolution (same name, different bytes in a non-canonical
        // editor dir). Its own operation: the chip's three verbs. Every path
        // stashes the bytes it discards to `~/.ok/edit-backups/forks/` first —
        // resolution is never silently lossy.
        if (body.fork !== undefined) {
          if (!inPlaceEntry) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Skill is not in-place.', {
              handler: 'skill-install',
              detail: 'FORK_STORE_BACKED',
            });
            return;
          }
          const forkResolved = skillInstallOps.resolveFork({
            scope: body.scope,
            name: body.name,
            fork: body.fork,
            inPlaceEntry,
          });
          if (!forkResolved.ok) {
            switch (forkResolved.kind) {
              case 'unknown-editor':
                errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Unknown editor.', {
                  handler: 'skill-install',
                  detail: forkResolved.editor,
                });
                return;
              case 'fork-absent':
                errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No fork at that editor.', {
                  handler: 'skill-install',
                  detail: 'FORK_ABSENT',
                });
                return;
              case 'not-a-fork':
                errorResponse(
                  res,
                  400,
                  'urn:ok:error:invalid-request',
                  'That copy matches the source — nothing to resolve.',
                  { handler: 'skill-install', detail: 'NOT_A_FORK' },
                );
                return;
              case 'invalid-new-name':
                errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid new name.', {
                  handler: 'skill-install',
                  detail: forkResolved.toName,
                });
                return;
              case 'name-taken':
                errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Name already taken.', {
                  handler: 'skill-install',
                  detail: forkResolved.toName,
                });
                return;
              default: {
                const _exhaustive: never = forkResolved;
                throw new Error(
                  `Unhandled fork outcome: ${String((_exhaustive as { kind?: unknown }).kind)}`,
                );
              }
            }
          }
          signalChannel?.('files');
          successResponse(
            res,
            200,
            SkillInstallSuccessSchema,
            {
              name: body.name,
              hosts: inPlaceEntry.hosts.filter(isSkillInstallTarget),
              scripts: false,
              warnings: forkResolved.warnings,
              warningCodes: forkResolved.warnings.length > 0 ? ['skill-fork-name-unpatched'] : [],
            },
            { handler: 'skill-install' },
          );
          return;
        }

        // ── Location-verb normalization (additive MCP spellings → internal
        // ops). `source` ≡ `setSource`; `mode` ≡ `linkMode`. The schema
        // guarantees `targets` and `source` never combine with `add`/`remove`.
        const setSourceReq = body.setSource ?? body.source;
        const linkModeReq =
          body.linkMode ?? (body.mode !== undefined ? body.mode === 'link' : undefined);
        // ── Additive `add`/`remove` (stateless location callers): translate
        // into the set-exact host math + custom-root placement loops. The
        // source is untouchable here — a skill's source folder IS the skill;
        // removing it is `delete`, moving it is `source`.
        let targetsReq = body.targets;
        const rootAdds: string[] = [];
        const rootRemoves: string[] = [];
        if (body.add !== undefined || body.remove !== undefined) {
          if (!inPlaceEntry) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'This skill still lives in the legacy .ok/skills store — promote a real location first (`source`) before using add/remove.',
              { handler: 'skill-install', detail: 'STORE_BACKED_ADDITIVE' },
            );
            return;
          }
          const addRemove = await skillInstallOps.applyAddRemove({
            scope: body.scope,
            name: body.name,
            inPlaceEntry,
            ...(body.add !== undefined ? { add: body.add } : {}),
            ...(body.remove !== undefined ? { remove: body.remove } : {}),
          });
          if (!addRemove.ok) {
            if (addRemove.kind === 'remove-source') {
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                `"${addRemove.sourceId}" is the skill's SOURCE — its folder is the skill itself, so removing it would delete the skill. Move the source first (\`source\`) or use \`delete\`.`,
                { handler: 'skill-install', detail: 'REMOVE_SOURCE' },
              );
            } else {
              errorResponse(
                res,
                409,
                'urn:ok:error:invalid-request',
                `Could not stop ${addRemove.subRoot} following its pool (${addRemove.reason}).`,
                { handler: 'skill-install', detail: addRemove.reason },
              );
            }
            return;
          }
          targetsReq = addRemove.targets.filter(isSkillInstallTarget);
          rootAdds.push(...addRemove.rootAdds);
          rootRemoves.push(...addRemove.rootRemoves);
        }

        // SOURCE promotion for a STORE-BACKED skill — a single-skill version of
        // the boot migration: the clicked host's location becomes the real
        // folder (the store bundle moves there; a same-hash projection there
        // just becomes real), sibling symlinks re-point, the install-marker
        // entry drops (the in-place scan is truth from here on), and the
        // choice is sticky. Without this branch the click silently no-opped.
        if (setSourceReq && !inPlaceEntry) {
          const promoted = await skillInstallOps.promoteStoreBackedSource({
            scope: body.scope,
            name: body.name,
            base,
            skillDir,
            newSource: setSourceReq as SkillHostId,
          });
          if (!promoted.ok) {
            errorResponse(
              res,
              409,
              'urn:ok:error:doc-already-exists',
              'Cannot move the source there — a different skill occupies the target.',
              {
                handler: 'skill-install',
                detail: promoted.kind === 'source-occupied' ? promoted.reason : promoted.target,
              },
            );
            return;
          }
          signalChannel?.('files');
          successResponse(
            res,
            200,
            SkillInstallSuccessSchema,
            {
              name: body.name,
              hosts: promoted.hosts,
              scripts: validity.hasScripts,
              warnings: [],
              warningCodes: [],
              sourceMovedTo: promoted.sourceMovedTo,
            },
            { handler: 'skill-install' },
          );
          return;
        }

        // One-shot CUSTOM placement: put a copy or symlink of the bundle under
        // an arbitrary project-relative dir. Guarded like every other fan-out —
        // containment inside the project, never under `.ok/`, never the source
        // itself, never clobbering existing content. Recorded machine-locally
        // so the path-disclosure surfaces list it.
        if (body.place) {
          // Project placements are project-relative; GLOBAL placements are
          // relative to the user home (rendered `~/`-prefixed). A leading `~/`
          // in the typed path is tolerated at global scope.
          const placeBase = body.scope === 'project' ? projectDir : skillsHome;
          if (!placeBase) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Cannot place — no project root is resolved for this server.',
              { handler: 'skill-install', detail: 'NO_PROJECT_ROOT' },
            );
            return;
          }
          const placed = await skillPlacementOps.place({
            placeBase,
            name: body.name,
            rawDir: body.place.dir,
            skillDir,
            mode: body.place.mode,
          });
          if (!placed.ok) {
            if (placed.kind === 'invalid-path') {
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                'Placement path must be a project-relative directory outside .ok/.',
                { handler: 'skill-install', detail: 'PLACE_PATH_INVALID' },
              );
            } else {
              errorResponse(
                res,
                409,
                'urn:ok:error:doc-already-exists',
                'Something already exists at that path — placement never overwrites.',
                { handler: 'skill-install', detail: 'PLACE_DEST_EXISTS' },
              );
            }
            return;
          }
          if (!('alreadyAtSource' in placed)) {
            signalChannel?.('files');
          }
          successResponse(
            res,
            200,
            SkillInstallSuccessSchema,
            {
              name: body.name,
              hosts: inPlaceEntry ? [...inPlaceEntry.hosts] : [],
              scripts: validity.hasScripts,
              warnings: [],
              warningCodes: [],
              placedAt: placed.placedAt,
            },
            { handler: 'skill-install' },
          );
          return;
        }

        // One-shot placement REMOVAL (inverse of `place`). Guarded three ways:
        // only RECORDED placements are removable (the source is never in the
        // ledger), symlinks + same-hash copies only (lossless), a hand-edited
        // copy is a fork and is refused, never deleted.
        if (body.unplace) {
          const placeBase = body.scope === 'project' ? projectDir : skillsHome;
          if (!placeBase) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Cannot remove a placement — no project root is resolved for this server.',
              { handler: 'skill-install', detail: 'NO_PROJECT_ROOT' },
            );
            return;
          }
          const unplaced = await skillPlacementOps.unplace({
            placeBase,
            name: body.name,
            rawPath: body.unplace.path,
            skillDir,
          });
          if (!unplaced.ok) {
            switch (unplaced.kind) {
              case 'not-recorded':
                errorResponse(
                  res,
                  404,
                  'urn:ok:error:not-found',
                  'No recorded placement at that path.',
                  { handler: 'skill-install', detail: unplaced.path },
                );
                return;
              case 'unsafe-path':
                errorResponse(
                  res,
                  400,
                  'urn:ok:error:invalid-request',
                  'Recorded placement path is no longer safe.',
                  { handler: 'skill-install', detail: 'PLACE_PATH_INVALID' },
                );
                return;
              case 'forked':
                errorResponse(
                  res,
                  409,
                  'urn:ok:error:doc-already-exists',
                  'That copy has been edited and no longer matches the skill — remove it manually if you mean it.',
                  { handler: 'skill-install', detail: unplaced.path },
                );
                return;
              case 'canonical-dir':
                errorResponse(
                  res,
                  400,
                  'urn:ok:error:invalid-request',
                  "That is the skill's own folder (the source) — it can't be removed here.",
                  { handler: 'skill-install', detail: unplaced.path },
                );
                return;
              default: {
                const _exhaustive: never = unplaced;
                throw new Error(
                  `Unhandled unplace outcome: ${String((_exhaustive as { kind?: unknown }).kind)}`,
                );
              }
            }
          }
          signalChannel?.('files');
          successResponse(
            res,
            200,
            SkillInstallSuccessSchema,
            {
              name: body.name,
              hosts: inPlaceEntry ? [...inPlaceEntry.hosts] : [],
              scripts: validity.hasScripts,
              warnings: [],
              warningCodes: [],
            },
            { handler: 'skill-install' },
          );
          return;
        }

        // One-shot PER-LOCATION mode change: make ONE installed location a
        // symlink to the source, or an independent copy again. The
        // `linkMode`/`mode` flip converts EVERY location at once — that silent
        // bulk conversion is the behaviour the install menu no longer offers,
        // so this row-level verb writes one path and leaves every sibling
        // alone. Lossless-only: a hand-edited copy is a fork and is refused,
        // never overwritten.
        if (body.convert) {
          if (!inPlaceEntry) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'This skill still lives in the legacy .ok/skills store — promote a real location first (`source`) before converting one.',
              { handler: 'skill-install', detail: 'STORE_BACKED_CONVERT' },
            );
            return;
          }
          const { target, mode } = body.convert;
          const prefBase = body.scope === 'project' ? projectDir : skillsHome;
          const converted = await skillPlacementOps.convert({
            ledgerBase: prefBase ?? base,
            scope: body.scope,
            name: body.name,
            target,
            mode,
            skillDir,
            canonicalHash: inPlaceEntry.contentHash,
          });
          if (!converted.ok) {
            switch (converted.kind) {
              case 'invalid-location':
                errorResponse(
                  res,
                  400,
                  'urn:ok:error:invalid-request',
                  'That location has no skills folder to convert.',
                  { handler: 'skill-install', detail: target },
                );
                return;
              case 'canonical-dir':
                errorResponse(
                  res,
                  400,
                  'urn:ok:error:invalid-request',
                  "That is the skill's own folder (the source) — move the source instead of converting it.",
                  { handler: 'skill-install', detail: target },
                );
                return;
              case 'forked':
                errorResponse(
                  res,
                  409,
                  'urn:ok:error:doc-already-exists',
                  'That copy has been edited and no longer matches the skill — resolve the fork before converting it.',
                  { handler: 'skill-install', detail: target },
                );
                return;
              case 'not-installed':
                errorResponse(
                  res,
                  404,
                  'urn:ok:error:not-found',
                  'The skill is not installed there.',
                  { handler: 'skill-install', detail: target },
                );
                return;
              default: {
                const _exhaustive: never = converted;
                throw new Error(
                  `Unhandled convert outcome: ${String((_exhaustive as { kind?: unknown }).kind)}`,
                );
              }
            }
          }
          signalChannel?.('files');
          successResponse(
            res,
            200,
            SkillInstallSuccessSchema,
            {
              name: body.name,
              hosts: [...inPlaceEntry.hosts],
              scripts: validity.hasScripts,
              warnings: [],
              warningCodes: [],
            },
            { handler: 'skill-install' },
          );
          return;
        }

        // Targets: global installs into every editor that has a skill folder
        // ("all your editors, every project"), honoring an explicit
        // `targets` filter; project resolves the committed
        // `.ok/skill-targets.json` set → detected project-configured editors.
        const targets: EditorId[] =
          body.scope === 'global'
            ? targetsReq
              ? // targetsReq is the narrower SkillTargetEditor set (no
                // claude-desktop, which shares claude's host dir); match by
                // value so the EditorId/SkillTargetEditor widths don't clash.
                PROJECT_SKILL_EDITOR_IDS.filter((id) => targetsReq?.some((t) => t === id))
              : [...PROJECT_SKILL_EDITOR_IDS]
            : targetsReq !== undefined
              ? // An EXPLICIT target list from the per-editor menu is set-exact,
                // INCLUDING `[]` (unchecking the last editor = install nowhere =
                // uninstall). Routing `[]` through resolveSkillTargets would hit
                // its empty→detect fallback and wrongly re-install into every
                // detected editor. Only an OMITTED `targets` means "use defaults".
                PROJECT_SKILL_EDITOR_IDS.filter((id) => targetsReq?.some((t) => t === id))
              : resolveSkillTargets(base);
        const warnings: string[] = [];
        // Parallel machine-readable codes (`warnings[i]` ↔ `warningCodes[i]`) so
        // clients switch on the code, not the English string.
        const warningCodes: SkillInstallWarningCode[] = [];
        // Only warn about a no-op when the user did NOT explicitly ask for an
        // empty set. An explicit `targets: []` (unchecking every editor) is an
        // intentional uninstall, not a "couldn't find editors" failure — warning
        // there mislabels a successful uninstall.
        if (targets.length === 0 && targetsReq === undefined) {
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
        // Empty-description advisory: the install succeeds; surface the
        // nudge as a warning rather than a blocking error, so an already-installed
        // description-less skill no longer red-errors on every install click.
        if (validity.warnings.length > 0) {
          warnings.push(validity.warnings[0]);
          warningCodes.push('no-description');
        }

        if (inPlaceEntry) {
          // Set-exact over the SCAN's editor occurrences: remove only lossless
          // occurrences (symlink / same-hash copy — never the canonical, never a
          // fork), then copy the canonical into newly-checked editors
          // (capability-aware; a DIFFERENT same-name dir is surfaced, untouched).
          const canonicalRootRel = inPlaceEntry.dir.split('/').slice(0, -1).join('/');
          // The `.agents` hub is a first-class install target for in-place
          // skills (the editors-only resolver above drops it from `targets`).
          const hubTargeted = targetsReq?.includes('agents') === true;
          const inPlaceTargets: SkillHostId[] = hubTargeted ? [...targets, 'agents'] : [...targets];
          // Install-mode default chain: explicit request > per-skill preference
          // (scope-local) > project-committed default > this machine's
          // user-wide default > copy.
          const prefBase = body.scope === 'project' ? projectDir : skillsHome;
          // `mode` shapes the locations THIS call installs and nothing else. It
          // used to persist as a skill-wide preference that outranked the
          // derived default forever after — invisible in the app, which has no
          // skill-wide mode and picks a new location's form from the ones the
          // skill already uses. Changing an existing location's form is the
          // explicit `convert` verb on both surfaces.
          const installMode: 'copy' | 'link' =
            linkModeReq !== undefined
              ? linkModeReq
                ? 'link'
                : 'copy'
              : effectiveInstallMode(body.scope, body.name, inPlaceEntry);
          // One-shot SOURCE move: relocate the real folder to the chosen host
          // and symlink EVERY other installed location to it — one real folder,
          // links everywhere else (the old source stays installed, as a link).
          // Sticky so the next scan doesn't re-elect by precedence.
          if (setSourceReq) {
            const promoted = await skillInstallOps.promoteInPlaceSource({
              scope: body.scope,
              name: body.name,
              base,
              ...(prefBase ? { prefBase } : {}),
              skillDir,
              inPlaceEntry,
              newSource: setSourceReq,
            });
            if (!promoted.ok) {
              if (promoted.kind === 'invalid-target') {
                errorResponse(
                  res,
                  400,
                  'urn:ok:error:invalid-request',
                  'Source target must be an editor id, "agents", or a project-relative skills root.',
                  { handler: 'skill-install', detail: promoted.target },
                );
              } else {
                errorResponse(
                  res,
                  409,
                  'urn:ok:error:doc-already-exists',
                  'Cannot move the source there — a different skill occupies the target.',
                  { handler: 'skill-install', detail: promoted.reason },
                );
              }
              return;
            }
            signalChannel?.('files');
            successResponse(
              res,
              200,
              SkillInstallSuccessSchema,
              {
                name: body.name,
                hosts: promoted.hosts,
                scripts: validity.hasScripts,
                warnings: [],
                warningCodes: [],
                ...(promoted.sourceMovedTo !== undefined
                  ? { sourceMovedTo: promoted.sourceMovedTo }
                  : {}),
              },
              { handler: 'skill-install' },
            );
            return;
          }

          const fanOut = await skillInstallOps.fanOutInPlace({
            scope: body.scope,
            name: body.name,
            base,
            ...(prefBase ? { prefBase } : {}),
            skillDir,
            inPlaceEntry,
            canonicalRootRel,
            inPlaceTargets,
            setExact: targetsReq !== undefined,
            installMode,
            ...(linkModeReq !== undefined ? { linkModeReq } : {}),
            rootAdds,
            rootRemoves,
          });
          if (!fanOut.ok) {
            errorResponse(
              res,
              409,
              'urn:ok:error:doc-already-exists',
              'Cannot move the source there — a different skill occupies the target.',
              { handler: 'skill-install', detail: fanOut.reason },
            );
            return;
          }
          warnings.push(...fanOut.warnings);
          warningCodes.push(...fanOut.warningCodes);
          signalChannel?.('files');
          successResponse(
            res,
            200,
            SkillInstallSuccessSchema,
            {
              name: body.name,
              hosts: fanOut.hosts,
              scripts: validity.hasScripts,
              warnings,
              warningCodes,
              ...(fanOut.sourceMovedTo !== undefined
                ? { sourceMovedTo: fanOut.sourceMovedTo }
                : {}),
            },
            { handler: 'skill-install' },
          );
          return;
        }

        // Set-exact: drop any editor the skill was previously installed into
        // but that isn't in this target set, so the per-editor install menu can
        // toggle a single editor off without leaving an orphaned symlink behind.
        const priorHosts = resolvedHosts(readInstalledSkills(base).skills[body.name]?.hosts ?? []);
        const dropped = priorHosts.filter((h) => !targets.includes(h));
        if (dropped.length > 0)
          reverseProjectSkill(body.name, base, dropped, skillProjectionRoots(body.scope));
        // Projection mode by ORIGIN (slice 4): a skill recorded in the import
        // lockfile is acquired → project as a verbatim COPY so it survives a
        // fresh clone where the `.ok/skills` source link would dangle.
        // Locally-authored skills stay symlinked. Copy entries record a
        // contentHash (the same acquire hasher) so reconcile can flag local edits.
        const lockPathForInstall = join(base, ...SKILLS_LOCK_REL);
        const lockRawForInstall = existsSync(lockPathForInstall)
          ? readFileSync(lockPathForInstall, 'utf-8')
          : null;
        const lockForInstall =
          lockRawForInstall !== null ? parseSkillsLock(lockRawForInstall) : null;
        // A present-but-unparseable lockfile would silently fall back to symlink
        // (origin unknown). Surface it so a corrupt lockfile isn't invisible.
        if (lockRawForInstall !== null && lockForInstall === null) {
          log.warn(
            { skill: body.name },
            'skills-lock.json failed to parse — projecting as symlink (import origin unknown)',
          );
        }
        const isAcquired = lockForInstall?.skills[body.name] !== undefined;
        // An explicit `mode` wins here as it does on the in-place path. Without
        // this the legacy branch silently ignored the caller's request and used
        // the import-origin default instead — the same call, answered two ways
        // depending on which store the skill happened to live in.
        const projectionMode: 'symlink' | 'copy' =
          linkModeReq !== undefined
            ? linkModeReq
              ? 'symlink'
              : 'copy'
            : isAcquired
              ? 'copy'
              : 'symlink';
        const hosts = projectSkill(
          skillDir,
          body.name,
          base,
          targets,
          projectionMode,
          skillProjectionRoots(body.scope),
        );
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
            projection: projectionMode,
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
  // drop its marker entry, leaving the SOURCE intact — the skill still loads
  // from its own folder. The inverse of install: same scope→base map, the shared
  // `uninstallSkillFromHostDirs` reverse-projection. A local-op, not an
  // attributed content mutation. Idempotent: uninstalling a source-only skill is a no-op.
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
        const uninstalled = await uninstallSkillFromHostDirs(base, body.name, body.scope);
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

  const handleSkillTargetsGet = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        // Store retirement: the committed `.ok/skill-targets.json` set is dead —
        // targets are DETECTED from the project's configured editors, and
        // per-skill reach lives in each skill's install menu.
        const targets = resolveSkillTargets(projectDir ?? '');
        // Folder-link receipt vs disk: a recorded expectation that no longer
        // matches the observed state is DRIFT — passive disclosure only (the
        // "changed outside" chip); the next explicit verb wins + re-records.
        const withDrift = (
          base: string,
          f: ReturnType<typeof scanSkillFolderStates>[number],
        ): { drift?: true; expected?: string } => {
          const exp = readFolderExpectations(base)[f.root];
          if (exp === undefined) return {};
          const matches =
            exp.expect === 'link'
              ? f.state === 'linked' && f.target === exp.target
              : f.state === 'own';
          if (matches) return {};
          return {
            drift: true,
            expected: exp.expect === 'link' ? `link → ${exp.target}` : 'own folder',
          };
        };
        successResponse(
          res,
          200,
          SkillTargetsGetSuccessSchema,
          {
            targets,
            configured: false,
            folders: [
              ...(projectDir
                ? scanSkillFolderStates(contentDir, knownSkillRootsFor(contentDir, 'project')).map(
                    (f) => ({
                      ...f,
                      scope: 'project' as const,
                      ...withDrift(contentDir, f),
                    }),
                  )
                : []),
              ...scanSkillFolderStates(skillsHome, knownSkillRootsFor(skillsHome, 'global')).map(
                (f) => ({
                  ...f,
                  scope: 'global' as const,
                  ...withDrift(skillsHome, f),
                }),
              ),
            ],
          },
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
        {
          const fa = body.folderAction;
          const base = fa.scope === 'project' ? contentDir : skillsHome;
          if (fa.scope === 'project' && !projectDir) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Cannot manage skill folders — no project root is resolved for this server.',
              { handler: 'skill-targets-put', detail: 'NO_PROJECT_ROOT' },
            );
            return;
          }
          // DECLARE a new custom root (rows/link-targets from declaration,
          // not first placement). Shape-validated only — it's a declaration,
          // not a write; the folder stays absent until something lands there.
          if (fa.action === 'add-root') {
            const raw = fa.root.replace(/\\/g, '/');
            const rel = raw.replace(/\/+$/g, '');
            const segs = rel.split('/').filter((seg) => seg !== '' && seg !== '.');
            if (
              rel === '' ||
              rel.startsWith('/') ||
              rel.startsWith('~') ||
              /^[A-Za-z]:/.test(rel) ||
              rel.includes('\x00') ||
              segs.length === 0 ||
              segs.some((seg) => seg === '..')
            ) {
              errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid folder path.', {
                handler: 'skill-targets-put',
                detail: fa.root,
              });
              return;
            }
            await recordKnownSkillRoot(base, segs.join('/'));
            signalChannel?.('files');
            successResponse(
              res,
              200,
              SkillTargetsPutSuccessSchema,
              {
                targets: resolveSkillTargets(projectDir ?? ''),
                reprojected: [],
                bundleHosts: [],
                removedFrom: [],
              },
              { handler: 'skill-targets-put' },
            );
            return;
          }
          // Folder verbs operate on KNOWN roots only (standard host roots +
          // ledger-known custom roots) — arbitrary paths never reach the
          // link/unlink primitives. The link target is an EXPLICIT user pick;
          // no root is ever assumed.
          const knownRoots = new Set(
            knownSkillRootsFor(base, fa.scope)
              .map((r) => r.root)
              .filter((r) => !r.startsWith('/') && !r.split('/').includes('..')),
          );
          const target = fa.action === 'link' ? (fa.target ?? '') : fa.root;
          if (
            !knownRoots.has(fa.root) ||
            (fa.action === 'link' && (!knownRoots.has(target) || fa.root === target))
          ) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Folder and target must be distinct standard skills roots.',
              { handler: 'skill-targets-put', detail: `${fa.root} -> ${target}` },
            );
            return;
          }
          const result =
            fa.action === 'link'
              ? linkEditorSkillFolder({ base, folderRel: fa.root, targetRootRel: target })
              : unlinkEditorSkillFolder({
                  base,
                  folderRel: fa.root,
                  ...(fa.exclude !== undefined ? { exclude: fa.exclude } : {}),
                });
          if (!result.ok) {
            errorResponse(
              res,
              409,
              'urn:ok:error:invalid-request',
              result.reason === 'conflicts'
                ? `Cannot link — differing skills exist in both folders: ${(result.conflicts ?? []).join(', ')}. Resolve them first.`
                : result.reason === 'stray-entries'
                  ? `Cannot link — the folder holds non-skill entries: ${(result.strays ?? []).join(', ')}.`
                  : result.reason === 'partial-move'
                    ? `The merge stopped partway (${(result.moved ?? []).length} skill(s) already moved — nothing lost). Run Link again to resume and complete it. (${result.error ?? ''})`
                    : result.reason === 'not-linked'
                      ? 'That folder is not a symlink — nothing to unlink.'
                      : 'That folder cannot be linked (it is already a link or the same directory).',
              { handler: 'skill-targets-put', detail: result.reason },
            );
            return;
          }
          // RECEIPT: record the expected folder form so an external rewrite
          // (symlink deleted, re-pointed, or re-materialized) renders a
          // passive "changed outside" chip. The next explicit verb wins.
          await recordFolderExpectation(
            base,
            fa.root,
            fa.action === 'link' ? { expect: 'link', target } : { expect: 'own' },
          );
          signalChannel?.('files');
          successResponse(
            res,
            200,
            SkillTargetsPutSuccessSchema,
            {
              targets: resolveSkillTargets(projectDir ?? ''),
              reprojected: [],
              bundleHosts: [],
              removedFrom: [],
              folder: { moved: result.moved, dropped: result.dropped, linked: result.linked },
            },
            { handler: 'skill-targets-put' },
          );
          return;
        }
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

  const handleSkillTargets = methodRouter(
    { GET: handleSkillTargetsGet, PUT: handleSkillTargetsPut },
    { handler: 'skill-targets' },
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
        if (rejectReservedBuiltinSkill(body.name, res, 'skill-restore')) return;
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
          skillDirRel: projectSkillDirRel(body.name),
        });
        if (!result.ok) {
          // Map the failure code to a status: genuine git/disk I/O (and an
          // escaping shadow path) are server-side 5xx, not a 404 "not found".
          respondSkillRestoreFailure(res, result, 'skill-restore');
          return;
        }

        const warnings: string[] = [];
        // The same in-place-aware path the restore itself ran against. Hardcoding
        // the retired `.ok/skills` store here made every restore of a normal skill
        // report "no longer validates" against a directory that does not exist,
        // and leak an absolute path in the warning.
        const skillDir = resolve(contentDir, projectSkillDirRel(body.name));
        const validity = validateSkillForInstall(skillDir, body.name);
        if (!validity.ok) {
          warnings.push(
            `Restored, but the skill no longer validates: ${validity.errors.join(' ')}`,
          );
        }
        // No "Run `install`" nudge: copies auto-refresh from the source via
        // resyncRecordedSkillCopies, and the bare `install` form that advice
        // invited is a set-exact reconciliation, not an additive top-up.

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

  // `POST /api/skill/reimport` — refresh an IMPORTED skill from its recorded
  // upstream (`.ok/skills-lock.json`). Re-fetches the source, and when the
  // content hash differs, overwrites the skill IN PLACE (same name, not a
  // `-imported` rename), updates the lockfile, and re-projects into editors —
  // otherwise reports `updated: false` (already up to date). Project scope only;
  // the global store is unversioned.
  const handleSkillReimport = withValidation(
    SkillReimportRequestSchema,
    async (_req, res, body) => {
      let cleanup: () => void = () => {};
      try {
        if (body.scope === 'project' && !projectDir) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project root resolved.', {
            handler: 'skill-reimport',
            detail: 'NO_PROJECT_ROOT',
          });
          return;
        }
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-reimport',
          });
          return;
        }
        if (!validateSkillName(body.name, res, 'skill-reimport')) return;

        // The bundle's REAL root at either scope (in-place-first; store
        // fallback), so Update rewrites the bundle where it actually lives.
        // Global skills are provenance-tracked via `~/.ok/skills-lock.json`
        // (seeded runtime skills record it from birth) but UNVERSIONED — no
        // shadow attribution below.
        const reimportBase = body.scope === 'global' ? skillsHome : contentDir;
        const {
          root: skillsRoot,
          dirRel: skillDirRel,
          realDir: reimportRealDir,
        } = effectiveSkillRoot(body.scope, body.name);
        const inPlaceSkill = !skillDirRel.startsWith(`${LEGACY_SKILL_STORE_ROOT}/`);
        if (
          reimportRealDir === null ||
          !existsSync(resolve(reimportBase, skillDirRel, 'SKILL.md'))
        ) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill is not installed.', {
            handler: 'skill-reimport',
            detail: 'SKILL_ABSENT',
          });
          return;
        }

        const lockPath = join(
          body.scope === 'global' ? skillsHome : (projectDir as string),
          ...SKILLS_LOCK_REL,
        );
        const lock = readSkillsLock(lockPath);
        // An old-name pack install resolves directly: it was never renamed, so
        // its lock key still matches its dir. The source-dir pick below carries
        // the old→new mapping so the fetch lands on the renamed mirror dir.
        let entry = lock.skills[body.name];
        if (!entry) {
          // Retrofit: a starter pack seeded before provenance was recorded has no
          // lock entry, but its upstream is deterministic — synthesize it so the pack
          // updates through this same reimport path. Uses the installed content hash
          // so an unchanged upstream is a correct no-op. (Pure decision unit-tested
          // in lockfile.test.ts; non-pack names return null and fall through to the
          // NOT_IMPORTED error below.)
          const synthesized =
            retrofitPackLockEntry(
              body.name,
              parseSkillDir(resolve(skillsRoot, body.name))?.contentHash ?? '',
              new Date().toISOString(),
              // The post-rename names are generic (`write-a-spec`,
              // `knowledge-base`), so presence is not proof of ownership. Pass
              // the bundle's own `metadata.pack` marker as the witness, or a
              // user's same-named skill would be handed our provenance and
              // offered an overwrite with ours.
              { selfIdentifiesAsPack: bundleSelfIdentifiesAsPack(resolve(skillsRoot, body.name)) },
            ) ?? synthBuiltinLockEntry(reimportBase, body.name);
          if (synthesized) entry = synthesized;
        }
        if (!entry) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'This skill has no recorded import source to update from.',
            { handler: 'skill-reimport', detail: 'NOT_IMPORTED' },
          );
          return;
        }
        if (body.setAutoUpdate !== undefined) {
          // Toggle-persist mode: flip the flag, nothing fetched or rewritten.
          // Persist both choices: absent now means the source-kind default
          // (local on, remote off), so an explicit remote opt-in must survive.
          await mutateSkillsLock(lockPath, (current) => ({
            ...current,
            skills: {
              ...current.skills,
              [body.name]: {
                ...(current.skills[body.name] ?? entry),
                autoUpdate: body.setAutoUpdate,
              },
            },
          }));
          successResponse(
            res,
            200,
            SkillReimportSuccessSchema,
            { name: body.name, updated: false, source: entry.source, warnings: [] },
            { handler: 'skill-reimport' },
          );
          return;
        }
        // Recorded into the refreshed lockfile entry below (the new upstream
        // sha); NOT echoed on the HTTP response (no client reads it there).
        let ref: string | undefined;
        let acquired: ReturnType<typeof parseSkillDir> = null;
        let hasScripts = false;
        try {
          // A listing-sourced install looks its skill up on skills.sh by name.
          // A pre-rename install asks for a name the repo no longer ships: that
          // still resolves today only because the superseded listing is still
          // up, and retiring those listings is an open ask — which would
          // otherwise turn "tidy up the old listings" into "break Update for
          // everyone who installed from one". Fall back to the renamed listing
          // so the two decisions stay independent.
          const recordedSkill = entry.skill ?? body.name;
          const renamedSkill = RENAMED_PACK_SKILLS[recordedSkill];
          const skillsSh = await resolveSkillsShImportSource(entry.source, recordedSkill).catch(
            async (err: unknown) => {
              if (renamedSkill === undefined) throw err;
              return resolveSkillsShImportSource(entry.source, renamedSkill);
            },
          );
          // A plugin-cache copy re-points at the NEWEST cached version — the
          // recorded dir is a version pin the plugin manager prunes, so honoring
          // it verbatim would fail exactly when there is an update to pull.
          const resolvedSource =
            skillsSh?.source ?? resolvePluginUpdateSource(entry.source, entry.pluginProvider);
          const resolvedSkill = skillsSh?.skill ?? entry.skill;
          const spec = skillsSh?.spec ?? parseSource(resolvedSource);
          if (!spec) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'The recorded import source is no longer a valid source.',
              { handler: 'skill-reimport', detail: entry.source },
            );
            return;
          }
          if (rejectDisallowedGitSpec(res, spec, 'skill-reimport')) return;
          const fetched = await fetchSource(spec);
          cleanup = fetched.cleanup;
          ref = fetched.ref;
          const dirs = discoverSkillDirs(fetched.dir);
          // Re-select the same skill: the recorded dir basename first, then a
          // match on the local skill's name (basename or frontmatter), then the
          // sole skill if the source has exactly one.
          const pick =
            (resolvedSkill ? dirs.find((d) => d.name === resolvedSkill) : undefined) ??
            dirs.find((d) => d.name === body.name) ??
            dirs.find((d) => parseSkillDir(d.dir)?.name === body.name) ??
            // Rename alias: an old-name install updating against the renamed
            // mirror finds its bundle under the new name.
            dirs.find((d) => d.name === RENAMED_PACK_SKILLS[resolvedSkill ?? body.name]) ??
            (dirs.length === 1 ? dirs[0] : undefined);
          if (!pick) {
            errorResponse(
              res,
              404,
              'urn:ok:error:not-found',
              'Could not locate this skill in its source anymore.',
              { handler: 'skill-reimport', detail: dirs.map((d) => d.name).join(', ') },
            );
            return;
          }
          const oversize = acquiredBundleTooLarge(pick.dir);
          if (oversize) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Skill bundle exceeds import limits.',
              { handler: 'skill-reimport', detail: oversize },
            );
            return;
          }
          acquired = parseSkillDir(pick.dir);
        } catch (e) {
          if (e instanceof SkillFetchError) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Could not fetch source.', {
              handler: 'skill-reimport',
              cause: e,
            });
            return;
          }
          throw e;
        }
        if (!acquired) {
          errorResponse(res, 422, 'urn:ok:error:invalid-request', 'Source has no readable skill.', {
            handler: 'skill-reimport',
          });
          return;
        }
        const limitError = importedBundleLimitError(acquired);
        if (limitError) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Skill bundle exceeds import limits.',
            { handler: 'skill-reimport', detail: limitError },
          );
          return;
        }
        hasScripts = acquired.files.some((f) => f.relPath.startsWith('scripts/'));
        const localBefore = parseSkillDir(resolve(skillsRoot, body.name));
        const upstreamPaths = new Set(acquired.files.map((f) => f.relPath));
        const localPaths = new Set((localBefore?.files ?? []).map((f) => f.relPath));
        // New lock entries carry the prior upstream manifest, which lets us
        // delete only files the upstream used to own. For legacy entries, the
        // whole local bundle is a safe ownership witness only while it still
        // matches the recorded local baseline. Once local bytes diverge, an
        // untracked file may be user-authored and must never be inferred away.
        const priorUpstreamPaths =
          entry.files ??
          (entry.localHash !== undefined && localBefore?.contentHash === entry.localHash
            ? localBefore.files.map((file) => file.relPath)
            : []);
        const removedUpstream = priorUpstreamPaths
          .filter((path) => !upstreamPaths.has(path))
          .filter((path) => localPaths.has(path));

        // Already up to date — nothing to write. (Temp dir is dropped by the
        // handler's `finally { cleanup() }` — no explicit call needed here.)
        if (acquired.contentHash === entry.contentHash && removedUpstream.length === 0) {
          successResponse(
            res,
            200,
            SkillReimportSuccessSchema,
            {
              name: body.name,
              updated: false,
              source: entry.source,
              warnings: [],
            },
            { handler: 'skill-reimport' },
          );
          return;
        }

        // Overwrite the skill in place (same name — no `-imported` rename), same
        // sanctioned writers + frontmatter canonicalization as import.
        const skillBody = parseFrontmatterDoc(acquired.skillMd).body;

        // Preview: upstream differs — report the two bodies for the confirm dialog
        // and write nothing. (Reached only when the hashes diverge, above.)
        if (body.dryRun) {
          const localMd = parseSkillDir(resolve(skillsRoot, body.name))?.skillMd ?? '';
          // Auto-update gate input: a PROJECT bundle with tracked files updates
          // through the repo (pull / CI), never the per-machine auto loop — two
          // machines auto-updating with autoSync on churn-wars the lockfile and
          // bundle (the pre-in-place version-stamp nightmare, re-armed).
          let gitTracked: boolean | undefined;
          if (body.scope === 'project' && projectDir) {
            try {
              const pg = simpleGit({ baseDir: projectDir, timeout: { block: 15_000 } });
              const rel = relative(projectDir, resolve(skillsRoot, body.name)).split(sep).join('/');
              gitTracked = (await pg.raw('ls-files', '--', rel)).trim().length > 0;
            } catch {
              gitTracked = undefined; // not a git repo / unborn index — no gate
            }
          }
          successResponse(
            res,
            200,
            SkillReimportSuccessSchema,
            {
              name: body.name,
              updated: true,
              source: entry.source,
              localBody: parseFrontmatterDoc(localMd).body,
              upstreamBody: skillBody,
              ...(gitTracked !== undefined ? { gitTracked } : {}),
              warnings: [],
            },
            { handler: 'skill-reimport' },
          );
          return;
        }
        if (body.scope === 'project') {
          const removedMarkdownDocs = removedUpstream
            .filter((path) => /\.mdx?$/i.test(path))
            .map((path) => `${skillDirRel}/${path.replace(/\.mdx?$/i, '')}`);
          if (removedMarkdownDocs.length > 0) {
            await captureAndCloseDocuments(removedMarkdownDocs, 'deleted-upstream');
          }
        }
        const wr = applySkillWrite({
          skillsRoot,
          name: body.name,
          body: skillBody,
          frontmatter: { name: body.name, description: acquired.description },
        });
        if (!wr.ok) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Failed to write skill.', {
            handler: 'skill-reimport',
            detail: wr.error.code,
            cause: new Error(wr.error.message),
          });
          return;
        }
        const warnings = [...wr.warnings];
        for (const f of acquired.files) {
          const br = applySkillBundleFileWrite({
            skillsRoot,
            name: body.name,
            relPath: f.relPath,
            content: f.content,
            bytes: f.bytes,
            limits: SKILL_IMPORT_WRITE_LIMITS,
          });
          if (!br.ok) {
            errorResponse(
              res,
              500,
              'urn:ok:error:internal-server-error',
              'Failed to write the complete refreshed skill bundle.',
              {
                handler: 'skill-reimport',
                detail: `${f.relPath}: ${br.error.code}`,
                cause: new Error(br.error.message),
              },
            );
            return;
          }
        }
        for (const relPath of removedUpstream) {
          const deleted = applySkillBundleFileDelete({
            skillsRoot,
            name: body.name,
            relPath,
          });
          if (!deleted.ok) {
            errorResponse(
              res,
              500,
              'urn:ok:error:internal-server-error',
              'Failed to reconcile files removed upstream.',
              {
                handler: 'skill-reimport',
                detail: `${relPath}: ${deleted.error.code}`,
                cause: new Error(deleted.error.message),
              },
            );
            return;
          }
        }

        if (body.scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.name),
            `skill-reimport: ${entry.source} -> ${skillDirRel}`,
          );
          await commitOkArtifactWrite('skill-reimport');
        }

        const reimportLocalHash = localSkillHash(skillsRoot, body.name);
        const reimportBaselineRef =
          body.scope === 'project'
            ? await shadowHeadSha(artifactWriterId(actor), skillDirRel)
            : undefined;
        // `lock`/`entry` above predate the upstream fetch — re-read so a
        // concurrent import's entry survives this write.
        await mutateSkillsLock(lockPath, (current) =>
          upsertLockEntry(current, body.name, {
            ...(current.skills[body.name] ?? entry),
            contentHash: acquired.contentHash,
            files: acquired.files.map((file) => file.relPath),
            ...(reimportLocalHash !== undefined ? { localHash: reimportLocalHash } : {}),
            ...(reimportBaselineRef !== undefined ? { baselineRef: reimportBaselineRef } : {}),
            ref,
            importedAt: new Date().toISOString(),
          }),
        );

        // Re-project the refreshed skill into the configured editor dirs (same
        // best-effort copy projection as import — a failure must not fail the
        // update; reconcile re-projects on the next open). An IN-PLACE skill's
        // bundle already IS an editor dir — no projection (fan-out is its own
        // future pass).
        if (!inPlaceSkill && body.scope === 'project') {
          await projectImportedSkillCopy({
            skillsRoot,
            name: body.name,
            scope: 'project',
            hasScripts,
            handler: 'skill-reimport',
          });
        }

        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillReimportSuccessSchema,
          {
            name: body.name,
            updated: true,
            source: entry.source,
            warnings,
          },
          { handler: 'skill-reimport' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to reimport skill.', {
          handler: 'skill-reimport',
          cause: e,
        });
      } finally {
        cleanup();
      }
    },
    { handler: 'skill-reimport', method: 'POST' },
  );

  // `POST /api/skill/revert` — discard local edits and restore an imported skill
  // to the bytes recorded when it was installed/last updated (the lockfile's
  // `baselineRef` shadow commit). Reuses `restoreSkillVersion` (same engine as
  // version-history restore); attributed as a new `skill-revert` version so the
  // pre-revert edits stay recoverable from history. Project scope only.
  const handleSkillRevert = withValidation(
    SkillRevertRequestSchema,
    async (_req, res, body) => {
      try {
        if (!projectDir) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project root resolved.', {
            handler: 'skill-revert',
            detail: 'NO_PROJECT_ROOT',
          });
          return;
        }
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-revert',
          });
          return;
        }
        if (!validateSkillName(body.name, res, 'skill-revert')) return;
        if (rejectReservedBuiltinSkill(body.name, res, 'skill-revert')) return;
        if (body.scope === 'global') {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Global skills are unversioned — there is nothing to revert to.',
            { handler: 'skill-revert', detail: 'GLOBAL_SCOPE' },
          );
          return;
        }

        const lockPath = join(projectDir, ...SKILLS_LOCK_REL);
        const lock = readSkillsLock(lockPath);
        const entry = lock.skills[body.name];
        if (!entry?.baselineRef) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'This skill has no recorded install baseline to revert to.',
            { handler: 'skill-revert', detail: 'NO_BASELINE' },
          );
          return;
        }
        const shadow = shadowRef?.current;
        if (!shadow) {
          errorResponse(
            res,
            409,
            'urn:ok:error:shadow-not-configured',
            'No version history available to revert from.',
            { handler: 'skill-revert', detail: 'NO_SHADOW_REPO' },
          );
          return;
        }

        const result = await restoreSkillVersion({
          shadow,
          contentDir,
          contentRoot: contentRoot ?? '.',
          name: body.name,
          version: entry.baselineRef,
          skillDirRel: projectSkillDirRel(body.name),
        });
        if (!result.ok) {
          respondSkillRestoreFailure(res, result, 'skill-revert');
          return;
        }

        attributeOkArtifactWrite(
          actor,
          okArtifactKey('skill', '', body.name),
          `skill-revert: ${body.name} @ ${entry.baselineRef.slice(0, 8)}`,
        );
        await commitOkArtifactWrite('skill-revert');

        // Re-baseline `localHash` to the restored bytes so `modified` clears — the
        // skill now matches its install baseline again. contentHash/baselineRef are
        // unchanged (still the same installed upstream). Hash + projection use the
        // skill's REAL root (store, or the in-place editor-dir parent).
        const revertRoot = resolve(contentDir, projectSkillDirRel(body.name), '..');
        const revertedLocalHash = localSkillHash(revertRoot, body.name);
        await mutateSkillsLock(lockPath, (current) =>
          upsertLockEntry(current, body.name, {
            ...(current.skills[body.name] ?? entry),
            ...(revertedLocalHash !== undefined ? { localHash: revertedLocalHash } : {}),
          }),
        );

        // An in-place skill's bundle already IS an editor dir — no projection.
        if (revertRoot === resolveSkillsRoot('project')) {
          await projectImportedSkillCopy({
            skillsRoot: revertRoot,
            name: body.name,
            scope: 'project',
            hasScripts: result.restoredFiles.some((f) => f.startsWith('scripts/')),
            handler: 'skill-revert',
          });
        }

        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillRevertSuccessSchema,
          {
            name: body.name,
            baselineRef: entry.baselineRef,
            restoredFiles: result.restoredFiles,
            warnings: [],
          },
          { handler: 'skill-revert' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to revert skill.', {
          handler: 'skill-revert',
          cause: e,
        });
      }
    },
    { handler: 'skill-revert', method: 'POST' },
  );

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

  const searchService = createSearchService({
    contentDir,
    projectDir,
    getAllFilesIndex,
    getFileIndexGeneration,
    getSearchMaxEntries,
    semanticSearch,
    getSemanticSimilarityFloor,
    ready,
    getProjectSkillsRoot: () => resolveSkillsRoot('project'),
    parseFrontmatterDoc,
  });
  searchService.prewarm();

  const handleSearchGet = withValidation(
    EmptyRequestSchema,
    catchErrors(
      async (req, res) => {
        const params = parseQuery(req);
        const limit = params.get('limit');
        const query = params.get('query') ?? '';
        const intent = parseSearchIntent(params.get('intent'));
        const ranking = parseSearchRanking(params.get('ranking'));
        const scopes = parseSearchScopes(params.get('scope') ?? params.get('scopes'));
        const semanticParam = parseSemanticParam(params.get('semantic'));
        const source = parseSearchSource(params.get('source'));
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
        const body = await searchService.buildSearchResponse({
          query,
          intent,
          ranking,
          scopes,
          limit: limitNum,
          semanticParam,
          source,
        });
        successResponse(res, 200, SearchSuccessSchema, body, { handler: 'search-get' });
      },
      { handler: 'search-get', title: 'Failed to search workspace.' },
    ),
    { handler: 'search-get', method: 'GET', skipBodyParse: true },
  );

  const handleSearchPost = withValidation(
    SearchRequestSchema,
    catchErrors(
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
        const responseBody = await searchService.buildSearchResponse({
          query,
          intent,
          ranking,
          scopes,
          limit,
          semanticParam,
          source,
        });
        successResponse(res, 200, SearchSuccessSchema, responseBody, { handler: 'search-post' });
      },
      { handler: 'search-post', title: 'Failed to search workspace.' },
    ),
    { handler: 'search-post', method: 'POST' },
  );

  const handleSearch = methodRouter(
    { GET: handleSearchGet, POST: handleSearchPost },
    { handler: 'search' },
  );

  const handleSkillInstallState = withValidation(
    EmptyRequestSchema,
    catchErrors(
      async (_req, res) => {
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
      },
      { handler: 'skill-install-state', title: 'Failed to read skill install state.' },
    ),
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
        log.error({ err: e, requestId: getRequestId(req) }, '[handoff] route wrapper failed');
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
        log.error({ err: e, requestId: getRequestId(req) }, '[spawn-cursor] route wrapper failed');
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
        // Known non-GitHub forges (gitlab, bitbucket) can't produce a GitHub
        // share URL. GitHub hosts — github.com AND GHES — are supported: the
        // builders below take `origin.host` and the receive side accepts the
        // enterprise host behind its trust gate.
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
          sharedUrl = buildGitHubBlobUrl(
            origin.host,
            origin.owner,
            origin.repo,
            branch,
            body.docPath,
          );
        } else {
          // Folder ROOT (empty folderPath) maps to the content dir:
          // `tree/<branch>/<content.dir>`, degenerating to `tree/<branch>`
          // when `content.dir === '.'` (contentRel is '' then). Non-root folder
          // paths pass straight through.
          const treePath = body.folderPath === '' ? contentRel : body.folderPath;
          sharedUrl = buildGitHubTreeUrl(origin.host, origin.owner, origin.repo, branch, treePath);
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
   * logged via the `api` logger (`[share] subprocess ...`) so production
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
          log.warn(
            { code, stderr: redacted },
            `[share] subprocess exited code=${code} stderr=${redacted}`,
          );
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
        if (body.droppedSinceLastFlush !== undefined && body.droppedSinceLastFlush > 0) {
          // Gap marker: the forwarder lost entries (buffer overflow / failed
          // POSTs) between the previous delivered batch and this one. Persist
          // it as its own line so a log reader knows the silence was loss,
          // not inactivity.
          logger.warn(
            {
              source: 'renderer-console',
              transport: 'web',
              event: 'client-log-entries-dropped',
              droppedSinceLastFlush: body.droppedSinceLastFlush,
            },
            'client-log-entries-dropped',
          );
        }
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
        // `ws(s)://<host>/collab` reaches the same process the request arrived
        // on (scheme honors X-Forwarded-Proto — see collab-bootstrap-url.ts).
        // Avoids the cross-port WS attempt sandboxed preview panes refuse. The
        // Host value is the client's own header reflected back to itself (the
        // Origin CORS gate in `onRequest` already refused cross-origin
        // browsers); it is not independently vetted here. A genuinely absent
        // Host yields a null collabUrl — a deliberate divergence from `ok ui`'s
        // `?? localhost:${resolvedPort}` fallback: this server has no single
        // canonical advertised port to substitute, and the client falls back
        // to a same-origin WS URL on a null. Node HTTP/1.1 always populates
        // Host, so the null path is a malformed-request floor, not a normal case.
        const collabUrl = collabUrlFromRequestHeaders(req.headers);
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

  // `/api/config/diagnostics` — active config diagnostics across the user,
  // committed-project, and project-local layers. Read-only and open like
  // `/api/config`: the collector reads the files fresh per request (so a
  // hand-edit or `ok config migrate` is reflected without a restart) and
  // returns only structural findings — scope, file, key path, code, redirect —
  // never a raw config value. `no-store` so a poll always sees current disk
  // state.
  async function handleConfigDiagnostics(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        const payload = getConfigDiagnostics?.() ?? { diagnostics: [] };
        // HEAD mirrors GET's headers with no body; `successResponse` always
        // writes one, so the no-body verb stays a manual emit.
        if (req.method === 'HEAD') {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.statusCode = 200;
          res.end();
          return;
        }
        successResponse(res, 200, ConfigDiagnosticsReportSchema, payload, {
          handler: 'api-config-diagnostics',
          extraHeaders: { 'Cache-Control': 'no-store' },
        });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'api-config-diagnostics',
          cause: e,
        });
      }
      return;
    }
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'api-config-diagnostics',
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

  // The (project, endpoint) a key op targets — derived ENTIRELY from the
  // server's own identity + persisted config, NEVER a request body field. The
  // route is loopback-gated but unauthenticated; letting the body name the
  // project or endpoint would be a cross-project key-planting primitive. The
  // body carries key bytes only. The project is this server's project; the
  // endpoint is whatever the project currently has configured — so the key
  // binds to exactly the endpoint the next embed will use.
  function embeddingsKeyScope(): { projectDir: string; baseUrl: string } {
    const cfg = readSemanticProviderConfig?.();
    return {
      projectDir: projectDir ?? contentDir,
      baseUrl: cfg?.baseUrl ?? DEFAULT_EMBEDDINGS_BASE_URL,
    };
  }

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
        const { projectDir: pd, baseUrl } = embeddingsKeyScope();
        await new FileEmbeddingsBackend(embeddingsSecretsFile).setForProject(pd, baseUrl, body.key);
        // Re-warm on the next search so the new key takes effect without a
        // restart (the key isn't part of the provider fingerprint).
        semanticSearch?.reloadCredential();
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
        const { projectDir: pd, baseUrl } = embeddingsKeyScope();
        await new FileEmbeddingsBackend(embeddingsSecretsFile).clearForProject(pd, baseUrl);
        semanticSearch?.reloadCredential(); // re-warm so the cleared key takes effect now
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
   * POST /api/local-op/embeddings/test — one live probe embed against the SAVED
   * endpoint + the resolved key.
   *
   * The on-demand answer to "is my custom endpoint actually working". Every
   * embeddings failure degrades quietly to keyword search, so without this a
   * wrong URL / key / model looks exactly like a working setup that hasn't
   * indexed yet. Sends one fixed, content-free probe string — never a page and
   * never a query — and reports either the detected vector length or a
   * classified reason.
   *
   * Deliberately takes NO endpoint from the request body: it probes what is
   * persisted, so the route can never be pointed at an arbitrary host, and the
   * echoed `endpoint`/`model` let the UI notice its own unsaved edit rather
   * than misread a stale result.
   */
  const HANDLE_LOCAL_OP_EMBEDDINGS_TEST = 'local-op-embeddings-test';
  // Its own guard slot: a probe waits on a remote provider, so sharing the
  // set/clear mutex would let one slow test block the key controls. Serializing
  // probes against each other still stops a double-click from double-calling.
  const LOCAL_OP_EMBEDDINGS_TEST_GUARD = '/api/local-op/embeddings/test';

  const handleLocalOpEmbeddingsTest = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      if (!localOpGuard.tryAcquire(LOCAL_OP_EMBEDDINGS_TEST_GUARD)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'A connection test is already in progress.',
          { handler: HANDLE_LOCAL_OP_EMBEDDINGS_TEST, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        // Absent reader = no project-local layer plumbed, which resolves to the
        // same defaults `readProjectLocalSemanticConfig` would return.
        const config = readSemanticProviderConfig?.() ?? {
          baseUrl: DEFAULT_EMBEDDINGS_BASE_URL,
          model: DEFAULT_EMBEDDINGS_MODEL,
          dimensions: undefined,
        };
        // THE shared resolver, so a passing test guarantees the real embed path
        // resolves the same credential to the same endpoint (project key → env
        // on the default host → keyless loopback).
        const cred = await resolveEmbeddingsCredential(
          new FileEmbeddingsBackend(embeddingsSecretsFile),
          projectDir ?? contentDir,
          config.baseUrl,
        );
        const echo = { endpoint: config.baseUrl, model: config.model };
        // Typed here rather than inline: `successResponse` takes `unknown`, so
        // this annotation is what statically pins the embedder's classification
        // to the wire enum — a new `EmbeddingErrorReason` fails to compile
        // instead of failing schema validation at the wire boundary.
        const probe =
          cred.apiKey || cred.keyless
            ? await probeEmbeddingEndpoint({
                baseUrl: config.baseUrl,
                model: config.model,
                dimensions: config.dimensions,
                apiKey: cred.apiKey ?? undefined,
              })
            : ({ ok: false, reason: 'no_key', status: undefined } as const);
        const payload: LocalOpEmbeddingsTestResponse = probe.ok
          ? { ok: true, ...echo, dimensions: probe.dimensions }
          : { ok: false, ...echo, reason: probe.reason, status: probe.status };
        successResponse(res, 200, LocalOpEmbeddingsTestResponseSchema, payload, {
          handler: HANDLE_LOCAL_OP_EMBEDDINGS_TEST,
          extraHeaders: { 'Cache-Control': 'no-store' },
        });
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to test the embeddings endpoint.',
          { handler: HANDLE_LOCAL_OP_EMBEDDINGS_TEST, cause: e },
        );
      } finally {
        localOpGuard.release(LOCAL_OP_EMBEDDINGS_TEST_GUARD);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_EMBEDDINGS_TEST,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_EMBEDDINGS_TEST }),
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
        // Resolve the SAME credential the embedder would, for this project +
        // its configured endpoint, so status can't disagree with the real path.
        // A free, prompt-free file/env read — no warm, no egress. The key itself
        // is never returned; only `keyHint` (redacted last-4) so the UI can show
        // WHICH key is set. `keyNotRequired` marks a loopback endpoint that needs
        // no key at all, so the UI doesn't nag a keyless Ollama/LM Studio user.
        const statusConfig = readSemanticProviderConfig?.();
        const statusBaseUrl = statusConfig?.baseUrl ?? DEFAULT_EMBEDDINGS_BASE_URL;
        const cred = await resolveEmbeddingsCredential(
          new FileEmbeddingsBackend(embeddingsSecretsFile),
          projectDir ?? contentDir,
          statusBaseUrl,
        );
        const keyPresent = cred.apiKey !== null;
        const keyNotRequired = !keyPresent && cred.keyless;
        const keySource: 'project' | 'file' | 'env' | null = keyPresent
          ? (cred.source as 'project' | 'file' | 'env')
          : null;
        // Last 4 chars only, and only when the key is long enough that those 4 are
        // a negligible fraction (real provider keys are 40+ chars); never the key.
        const keyHint = cred.apiKey && cred.apiKey.length >= 8 ? cred.apiKey.slice(-4) : null;
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
          {
            enabled,
            keyPresent,
            keyNotRequired,
            keySource,
            keyHint,
            ready,
            capable,
            embedded,
            total,
          },
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

  // ---- Markdown linter: effective config + per-doc lint + project audit ----
  // The editor reads the effective config; the Settings GUI writes native
  // `.markdownlint.*` rules through the markdownlint-config endpoint.

  /**
   * Monotonic counter over server-side lint-config mutations, and the config
   * half of {@link readAuditGeneration}: neither the native markdownlint rules
   * nor the frontmatter-schema bodies appear in the base config, so a rule
   * toggle moves no fingerprint and would otherwise be invisible to the audit.
   *
   * Bumped only through {@link signalLintConfigChanged}, which is also the sole
   * `lint-config` CC1 emitter here — the two must move together or a mutation
   * that converges other windows would leave audits on the superseded config.
   */
  let lintConfigEpoch = 0;
  function signalLintConfigChanged(): void {
    lintConfigEpoch += 1;
    signalChannel?.('lint-config');
  }

  /**
   * The world an audit plane would be true of: the lint configuration in force,
   * the branch whose content is on disk, and the local-target inventory
   * generation. The audit's coalescing key and its in-flight walks both rest on
   * this one reader, so the three stay in step by construction.
   *
   * Branch belongs here for the same reason the config epoch does, one layer
   * down: a switch replaces the content set wholesale, so a request issued
   * after one must not attach to a walk started before it, and a walk spanning
   * one must abandon itself rather than publish half of each branch.
   *
   * Compared for equality only, never ordered — a branch label carries no
   * order. The space separator is unambiguous because a branch label is either
   * a git branch name (refnames admit no spaces) or a `detached-<oid>` literal.
   */
  const readAuditGeneration = (): string =>
    `${lintConfigEpoch} ${durabilityState.getActiveBranch()} ${
      derivedDocumentIndex?.readLocalTargetGeneration?.() ?? 0
    }`;

  // Content-rule violations on a post-write document, for the agent write/edit
  // advisory channel — the full validation plane, not just lint: every enabled
  // lint source PLUS broken internal links, so an agent that writes a dead
  // wiki-link hears about it on the write response without a separate `audit`
  // round-trip. Whole-doc semantics: pre-existing violations reappear on every
  // write to the doc, which is why the cap matters. Capped; advisory only —
  // never gates the write. Empty when linting is disabled and links are off.
  const LINT_VIOLATION_CAP = 10;
  async function computeLintViolations(
    source: string,
    docName: string,
  ): Promise<LintViolationWarning[]> {
    const base = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
    // Advisory-only means advisory-only: by the time this runs the write has
    // already committed (CRDT + disk + snapshot), so a validation crash must
    // degrade to zero advisories — never bubble into the handler's catch and
    // turn a committed write into a 500 the agent would retry.
    try {
      const effective = resolveEffectiveLinterConfig(contentDir, base, {
        docName,
        projectDir: projectDir ?? contentDir,
        onProblem: (problem) => log.warn({ problem, docName }, '[lint] native config problem'),
      });
      const lintFindings = await lintDocument(source, effective, docName);

      // Links plane, via the SAME audit validator the Problems panel and the
      // `audit` tool consume (one canonical predicate, honoring the project's
      // `validation.links` posture). The live-derived index updates on a
      // 100 ms debounce AFTER a change, so at this point it does not yet see
      // the write being advised — refresh this one doc synchronously first
      // (idempotent: the debounced pass re-applies the same bytes).
      let linkFindings: ValidationDiagnostic[] = [];
      const linksSetting = getLinksValidationSetting?.() ?? DEFAULT_LINKS_VALIDATION;
      if (derivedDocumentIndex && linksSetting !== 'off' && !isLinkIndexExcludedDoc(docName)) {
        await recordDerivedLinkRewriteBestEffort(docName, source, 'lint-validation');
        const linksValidator = createProjectValidators({
          projectDir: projectDir ?? contentDir,
          contentDir,
          baseConfig: base,
          derivedDocumentIndex,
          linksValidation: linksSetting,
          admittedDocNames: collectAdmittedDocNames,
          docFilePathFor: (d) => resolveDocFilePath(contentDir, d),
        }).find((validator) => validator.id === 'links');
        if (linksValidator) {
          const run = await linksValidator.run({
            targetPath: resolveDocFilePath(contentDir, docName) ?? `${docName}.md`,
          });
          linkFindings = run.files.flatMap((file) => file.diagnostics);
        }
      }

      return [...lintFindings, ...linkFindings]
        .sort(
          (a, b) =>
            a.range.start.line - b.range.start.line ||
            a.range.start.character - b.range.start.character,
        )
        .slice(0, LINT_VIOLATION_CAP)
        .map((d) => ({
          kind: 'lint-violation' as const,
          source: d.source,
          code: d.code,
          message: d.message,
          severity: d.severity,
          // Advisory display units are 1-based; the diagnostic range is 0-based LSP.
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          ...('linkTarget' in d && d.linkTarget !== undefined ? { linkTarget: d.linkTarget } : {}),
          ...('localTarget' in d && d.localTarget !== undefined
            ? { localTarget: d.localTarget }
            : {}),
        }));
    } catch (err) {
      log.warn(
        { err, docName },
        '[lint] advisory validation pass failed post-write; omitting advisories',
      );
      return [];
    }
  }

  // Zero-match appliesTo detection needs the project's doc list — a content
  // walk — so only the doc-independent lint-config responses (the surfaces the
  // Settings frontmatter panel reads) pay for it; per-doc `?doc=` fetches and
  // the per-write lint path never do.
  function unmatchedGlobProblems(effective: LinterConfig): string[] {
    const slice = effective.plugins.frontmatter;
    if (!slice.enabled || slice.schemas.length === 0) return [];
    const docFiles = collectDocFiles({ projectDir: projectDir ?? contentDir, contentDir });
    return unmatchedAppliesToProblems(slice.schemas, docFiles);
  }

  const handleGetLintConfig = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        // A `?doc=` is accepted (the editor passes the active doc) but the
        // effective config resolves per doc (cli2 cascade: nearest native
        // file on the doc→root walk governs); no `?doc=` → root-level.
        const url = new URL(req.url ?? '', 'http://localhost');
        const docName = url.searchParams.get('doc');
        if (docName !== null && (docName === '' || !isSafeDocName(docName))) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid doc.', {
            handler: 'lint-config',
          });
          return;
        }
        const base = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const configProblems: string[] = [];
        const native = resolveNativeConfigForDoc(contentDir, docName ?? undefined, (problem) =>
          configProblems.push(problem),
        );
        const effective = composeFrontmatterSchemasConfig(
          projectDir ?? contentDir,
          composeEffectiveLinterConfig(base, native),
          (problem) => configProblems.push(problem),
        );
        if (docName === null) configProblems.push(...unmatchedGlobProblems(effective));
        successResponse(
          res,
          200,
          LintConfigResponseSchema,
          { effective, configFile: native?.file ?? null, configProblems },
          { handler: 'lint-config' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to resolve lint config.',
          {
            handler: 'lint-config',
            cause: e,
          },
        );
      }
    },
    { handler: 'lint-config', method: 'GET', skipBodyParse: true },
  );

  // Edit one rule in the project's native `.markdownlint.*` file (the source of
  // truth). Root-level only for now; returns the recomputed effective config
  // so the settings panel reflects the change.
  const handleWriteMarkdownlintRule = withValidation(
    MarkdownlintRuleWriteRequestSchema,
    async (_req, res, body) => {
      let writeResult: WriteMarkdownlintResult;
      try {
        writeResult = writeMarkdownlintRule(resolve(contentDir), body.ruleId, body.value);
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to write markdownlint config.',
          { handler: 'markdownlint-config', cause: e },
        );
        return;
      }
      // A declined write must not read as success: the settings panel would
      // reload, show the rule silently reverted, and the user would retry.
      if (writeResult.action === 'declined-executable') {
        errorResponse(
          res,
          409,
          'urn:ok:error:config-not-writable',
          `The native markdownlint config (${writeResult.file}) is an executable module OK will not rewrite — edit it directly or convert it to JSON/JSONC/YAML.`,
          { handler: 'markdownlint-config' },
        );
        return;
      }
      // Past this point the rule IS on disk — a re-read failure must not
      // report the write itself as failed.
      // Converge every other window on the new rules. Without this a rule
      // toggle in one window leaves the rest linting against a stale config
      // until they happen to refetch, which is what the frontmatter sibling
      // below already avoids.
      signalLintConfigChanged();
      try {
        const base = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const configProblems: string[] = [];
        const native = resolveNativeConfigForDoc(contentDir, undefined, (problem) =>
          configProblems.push(problem),
        );
        const effective = composeFrontmatterSchemasConfig(
          projectDir ?? contentDir,
          composeEffectiveLinterConfig(base, native),
          (problem) => configProblems.push(problem),
        );
        configProblems.push(...unmatchedGlobProblems(effective));
        successResponse(
          res,
          200,
          LintConfigResponseSchema,
          { effective, configFile: native?.file ?? null, configProblems },
          { handler: 'markdownlint-config' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'The markdownlint rule was saved, but the effective config could not be re-read.',
          { handler: 'markdownlint-config', cause: e },
        );
      }
    },
    { handler: 'markdownlint-config', method: 'POST' },
  );

  // Edit one field of a frontmatter schema file (non-destructive merge via
  // applyFieldConstraint; create-on-first-edit). Responds with the recomputed
  // effective config, mirroring the markdownlint write.
  const handleWriteFrontmatterSchema = withValidation(
    FrontmatterSchemaWriteRequestSchema,
    async (_req, res, body) => {
      let writeResult: WriteFrontmatterSchemaResult;
      try {
        // Five shapes over one route (schema-refined): delete → remove the
        // tool-managed file; field + removeField → drop the field; field +
        // renameTo → rename it; field + constraint → per-field edit;
        // otherwise create-empty (scaffold the skeleton so a freshly-picked
        // new schema file exists).
        const root = resolve(projectDir ?? contentDir);
        const parentPath = body.parentPath ?? [];
        writeResult = body.delete
          ? deleteFrontmatterSchemaFile(root, body.file)
          : body.field !== undefined && body.removeField
            ? removeFrontmatterSchemaField(root, body.file, body.field, parentPath)
            : body.field !== undefined && body.renameTo !== undefined
              ? renameFrontmatterSchemaField(root, body.file, body.field, body.renameTo, parentPath)
              : body.field !== undefined && body.constraint !== undefined
                ? writeFrontmatterSchemaField(
                    root,
                    body.file,
                    body.field,
                    body.constraint,
                    parentPath,
                  )
                : createEmptyFrontmatterSchemaFile(root, body.file);
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to write the frontmatter schema.',
          { handler: 'frontmatter-schema', cause: e },
        );
        return;
      }
      if (writeResult.action === 'refused') {
        errorResponse(
          res,
          409,
          'urn:ok:error:config-not-writable',
          `The frontmatter schema (${writeResult.file}) was not written: ${writeResult.reason}.`,
          { handler: 'frontmatter-schema' },
        );
        return;
      }
      // `.ok/` is outside the content file-watcher, so schema-file mutations
      // never reach the tree or other clients through watcher events. `files`
      // keeps show-OK trees live on create/delete; `lint-config` converges
      // every other window's effective config (this response only reaches the
      // requesting client).
      if (writeResult.action === 'created' || writeResult.action === 'deleted') {
        signalChannel?.('files');
      }
      signalLintConfigChanged();
      try {
        const base = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const configProblems: string[] = [];
        const native = resolveNativeConfigForDoc(contentDir, undefined, (problem) =>
          configProblems.push(problem),
        );
        const effective = composeFrontmatterSchemasConfig(
          projectDir ?? contentDir,
          composeEffectiveLinterConfig(base, native),
          (problem) => configProblems.push(problem),
        );
        configProblems.push(...unmatchedGlobProblems(effective));
        successResponse(
          res,
          200,
          LintConfigResponseSchema,
          { effective, configFile: native?.file ?? null, configProblems },
          { handler: 'frontmatter-schema' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'The schema was saved, but the effective config could not be re-read.',
          { handler: 'frontmatter-schema', cause: e },
        );
      }
    },
    { handler: 'frontmatter-schema', method: 'POST' },
  );

  // Enumerate the project's `.ok/schemas/*.json` files (flat, top-level only)
  // as project-root-relative paths for the mapping picker. A missing dir is
  // an empty list, not an error; bounded so a pathological schemas dir can't
  // produce an unbounded response.
  const handleFrontmatterSchemasList = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        const root = resolve(projectDir ?? contentDir);
        // Two discovery sources: the flat tool-created `.ok/schemas/` scan,
        // plus a filtered content walk for the ecosystem `*.schema.json`
        // convention anywhere in the project. The walk deliberately does NOT
        // re-admit `.ok`: the scan above already covers `.ok/schemas/`, and
        // lifting ContentFilter's always-skip floor here would let this
        // surface enumerate the rest of OK's internal state to find schemas.
        const { schemas, truncated } = listProjectSchemaFiles(root);
        const found = new Set(schemas);
        let walkTruncated = false;
        if (contentFilter !== undefined) {
          const walk = streamShowAllEntries({
            contentDir,
            contentFilter,
            dirFilter: null,
            maxEntries: 20_000,
          });
          let walkResult = await walk.next();
          while (!walkResult.done) {
            const entry = walkResult.value;
            const entryPath = entry.kind === 'asset' ? entry.path : undefined;
            if (entryPath !== undefined && isFrontmatterSchemaAsset(entryPath)) {
              const projectRel = relative(root, resolve(contentDir, entryPath));
              if (!projectRel.startsWith('..') && !isAbsolute(projectRel)) found.add(projectRel);
            }
            walkResult = await walk.next();
          }
          walkTruncated = walkResult.value.truncated;
        }
        const merged = [...found].sort((a, b) => a.localeCompare(b));
        successResponse(
          res,
          200,
          FrontmatterSchemasListSuccessSchema,
          {
            schemas: merged.slice(0, SCHEMA_LIST_CAP),
            truncated: truncated || walkTruncated || merged.length > SCHEMA_LIST_CAP,
          },
          { handler: 'frontmatter-schemas-list' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to list frontmatter schemas.',
          { handler: 'frontmatter-schemas-list', cause: e },
        );
      }
    },
    { handler: 'frontmatter-schemas-list', method: 'GET', skipBodyParse: true },
  );

  /**
   * Live CRDT source for a currently-loaded doc, else null. Lint reads must
   * see the same bytes the editor and `/api/lint/fix` operate on: the disk
   * file lags the CRDT behind the persistence debounce, and if a flush is
   * ever lost the two diverge durably — a disk-only audit then reports
   * problems the live doc no longer has and the Fix all sweep no-ops forever.
   * Unloaded docs have no live copy; disk is authoritative for them.
   */
  const liveLintSourceFor = (docRelPath: string): string | null => {
    const docName = docRelPath.replace(/\.(md|mdx)$/i, '');
    const doc = hocuspocus.documents.get(docName);
    return doc === undefined ? null : doc.getText('source').toString();
  };

  const handleLintDoc = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const docName = url.searchParams.get('doc') ?? '';
        if (docName === '' || !isSafeDocName(docName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing or invalid doc.', {
            handler: 'lint',
          });
          return;
        }
        const docRelPath = resolveDocFilePath(contentDir, docName);
        if (docRelPath === null) {
          errorResponse(res, 404, 'urn:ok:error:doc-not-found', 'Document not found.', {
            handler: 'lint',
          });
          return;
        }
        const baseConfig = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const configWarnings: string[] = [];
        const result = await lintDoc({
          projectDir: projectDir ?? contentDir,
          contentDir,
          baseConfig,
          docRelPath,
          onConfigProblem: (problem) => configWarnings.push(problem),
          liveSourceFor: liveLintSourceFor,
        });
        successResponse(
          res,
          200,
          LintDocResultSchema,
          configWarnings.length > 0 ? { ...result, warnings: configWarnings } : result,
          { handler: 'lint' },
        );
      } catch (e) {
        if (e instanceof SymlinkEscapeError) {
          errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
            handler: 'lint',
          });
          return;
        }
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to lint document.', {
          handler: 'lint',
          cause: e,
        });
      }
    },
    { handler: 'lint', method: 'GET', skipBodyParse: true },
  );

  // One cache per server instance (not module-scoped): its keys carry contentDir,
  // but a per-server lifetime also means a restart starts cold, which is the
  // right blast radius for a disk-stamp-keyed cache.
  const auditCache = new AuditCache();
  /**
   * Audits in flight, keyed by scope + config fingerprint. Every window runs the
   * freshness triggers independently, and the Problems panel can refresh at the
   * same moment, so a single config change can ask for the same whole-project
   * walk several times over. Coalescing makes them one walk instead of N cold
   * ones that each finish too late to warm the others' cache.
   *
   * The walk yields to the event loop, so a request issued after a config
   * mutation or a branch switch IS parsed while an earlier walk is still
   * running and could attach to it. The fingerprint alone would not stop that:
   * it covers the BASE config, which never carries markdownlint `rules` (those
   * come from the native `.markdownlint.*` cascade) nor frontmatter-schema
   * bodies, and says nothing at all about which branch's content is on disk.
   * {@link readAuditGeneration} is what makes the key move, which is why it is
   * read here per request rather than captured once. The per-file cache keys on
   * the fully-resolved config and the file's disk stamp, so nothing is cached
   * under the wrong rules or the wrong branch's bytes either way.
   */
  const auditFlight = createSingleFlight<ValidationAuditResult>();

  function runCoalescedAudit(
    validators: readonly ProjectValidator[],
    targetPath: string | undefined,
    configFingerprint: string,
  ): Promise<ValidationAuditResult> {
    const key = `${configFingerprint} ${readAuditGeneration()} ${targetPath ?? ''}`;
    return auditFlight.run(key, () => runValidationAudit(validators, { targetPath })).promise;
  }

  /**
   * A superseded walk has no plane to report, so the caller gets a retryable
   * 409 rather than a stale or mixed one. The store-side effect is exactly the
   * effect of any failed audit — previous entries stand — and whichever change
   * superseded this walk has already broadcast its own CC1 channel
   * (`lint-config` for a config mutation, `branch-switched` for a switch), so
   * the corrective walk is scheduled without the caller doing anything.
   */
  function respondAuditSuperseded(res: ServerResponse, handler: string): void {
    errorResponse(
      res,
      409,
      'urn:ok:error:audit-superseded',
      'The lint configuration or branch changed while the audit was running; re-run it.',
      { handler },
    );
  }

  const handleLintAudit = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const rawTarget = url.searchParams.get('path');
        const target = rawTarget === null || rawTarget === '' ? undefined : rawTarget;
        // Absolute paths and traversal must not reach the walker: an audit
        // response carries offending-text snippets, so an unchecked scope is
        // an arbitrary-directory read for any connected agent.
        if (target !== undefined && !isValidRelativeContentPath(target)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid path.', {
            handler: 'lint-audit',
          });
          return;
        }
        const baseConfig = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const result = await auditProject({
          projectDir: projectDir ?? contentDir,
          contentDir,
          baseConfig,
          targetPath: target,
          liveSourceFor: liveLintSourceFor,
          cache: auditCache,
          auditGeneration: readAuditGeneration,
        });
        successResponse(res, 200, LintAuditResponseSchema, result, { handler: 'lint-audit' });
      } catch (e) {
        if (e instanceof AuditSupersededError) {
          respondAuditSuperseded(res, 'lint-audit');
          return;
        }
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to audit project.', {
          handler: 'lint-audit',
          cause: e,
        });
      }
    },
    { handler: 'lint-audit', method: 'GET', skipBodyParse: true },
  );

  // Unified validation audit: every registered project validator (markdownlint
  // walk + derived-index dead-link read) merged into one source-tagged plane.
  // Additive alongside /api/lint/audit and /api/dead-links, which keep their
  // single-validator contracts.
  const handleAudit = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const rawTarget = url.searchParams.get('path');
        let target = rawTarget === null || rawTarget === '' ? undefined : rawTarget;
        // Absolute paths and traversal must not reach the validators: the
        // lint walk reads file bytes under this scope, so an unchecked path
        // is an arbitrary-directory read for any connected caller.
        if (target !== undefined && !isValidRelativeContentPath(target)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid path.', {
            handler: 'audit',
          });
          return;
        }
        // `doc` scopes by docName (extension-less). The client freshness path
        // knows docNames from disk-ack frames, never file extensions, so the
        // extension resolution has to happen here. A doc indexed from a live
        // CRDT session may not be on disk yet — fall back to the default
        // extension so the links validator can still scope to it (mirrors the
        // links validator's own fallback).
        const rawDoc = url.searchParams.get('doc');
        const docParam = rawDoc === null || rawDoc === '' ? undefined : rawDoc;
        if (docParam !== undefined) {
          if (target !== undefined || !isValidRelativeContentPath(docParam)) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid doc.', {
              handler: 'audit',
            });
            return;
          }
          target = resolveDocFilePath(contentDir, docParam) ?? `${docParam}.md`;
        }
        const baseConfig = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const validators = createProjectValidators({
          projectDir: projectDir ?? contentDir,
          contentDir,
          baseConfig,
          liveSourceFor: liveLintSourceFor,
          derivedDocumentIndex: derivedDocumentIndex ?? null,
          linksValidation: getLinksValidationSetting?.(),
          admittedDocNames: collectAdmittedDocNames,
          docFilePathFor: (docName) => resolveDocFilePath(contentDir, docName),
          cache: auditCache,
          auditGeneration: readAuditGeneration,
        });
        const result = await runCoalescedAudit(
          validators,
          target,
          AuditCache.fingerprintConfig(baseConfig),
        );
        // `counts=1` tallies the same plane instead of enumerating it — the
        // freshness path behind file-tree tints wants per-file counts, and on a
        // large KB the enumerated bodies are tens of MB it discards on arrival.
        if (url.searchParams.get('counts') === '1') {
          successResponse(
            res,
            200,
            ValidationAuditCountsResponseSchema,
            toValidationCountsPlane(result),
            { handler: 'audit' },
          );
          return;
        }
        successResponse(res, 200, ValidationAuditResponseSchema, result, { handler: 'audit' });
      } catch (e) {
        if (e instanceof AuditSupersededError) {
          respondAuditSuperseded(res, 'audit');
          return;
        }
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to audit project.', {
          handler: 'audit',
          cause: e,
        });
      }
    },
    { handler: 'audit', method: 'GET', skipBodyParse: true },
  );

  const handleLintFix = withValidation(
    LintFixRequestSchema,
    async (_req, res, body) => {
      try {
        const effectiveDocName = requireNonEmptyDocName(body.docName, res, 'lint-fix');
        if (effectiveDocName === null) return;
        const resolvedDocName = resolveAlias(effectiveDocName);

        // A deterministic auto-fix is attributed to whoever asked for it: an
        // agent caller (MCP `lint fix:true` always sends agentId) keeps agent
        // attribution; a bare UI body lands as the principal — the human
        // clicked the button, no agent was involved. `principal-*` ids are
        // filtered at the presence-broadcaster boundary, so the structurally
        // enforced setPresence/touchMode shape below stays valid without
        // badging the user as their own agent. No principal loaded → neutral
        // anonymous writer with no contributor record (mirrors rename).
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'lint-fix',
          });
          return;
        }
        const agentId = actor.kind === 'anonymous' ? 'principal-anonymous' : actor.writerId;
        const agentName = actor.kind === 'anonymous' ? 'Anonymous' : actor.displayName;
        const colorSeed = actor.kind === 'anonymous' ? agentId : actor.colorSeed;
        const clientName = actor.kind === 'agent' ? actor.clientName : undefined;

        if (isSystemDoc(resolvedDocName) || isConfigDoc(resolvedDocName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${resolvedDocName}' is a reserved document name.`,
            { handler: 'lint-fix' },
          );
          return;
        }

        const docRelPath = resolveDocFilePath(contentDir, resolvedDocName);
        if (docRelPath === null) {
          errorResponse(res, 404, 'urn:ok:error:doc-not-found', 'Document not found.', {
            handler: 'lint-fix',
          });
          return;
        }
        // Refuse a symlink whose canonical target escapes the content dir BEFORE
        // loading the session. The read path (lintDoc) guards via realpath; this
        // CRDT-load path must too — otherwise persistence silently drops the
        // escaped load and the endpoint returns a misleading 200 ("clean")
        // instead of a path-escape 400. Throws SymlinkEscapeError → 400 below.
        assertNoSymlinkEscape(resolve(contentDir, docRelPath), contentDir);

        const baseConfig = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const { stored: storedSummary } = summaryResponseFields(actor.summary);
        const session = await sessionManager.getSession(resolvedDocName, agentId, {
          displayName: agentName,
          colorSeed,
          clientName,
        });

        // Lint + fix the LIVE CRDT source (not disk) so the fix ranges resolve
        // against the bytes we actually mutate. `fixDocument` delegates to
        // upstream markdownlint's `applyFixes` — we author no fix logic.
        const source = session.dc.document.getText('source').toString();
        const { cfg, before, fixed } = await lintAndFixSource({
          projectDir: projectDir ?? contentDir,
          contentDir,
          baseConfig,
          docRelPath,
          source,
        });

        let after = before;
        let reLintWarning: string | undefined;
        if (fixed !== source) {
          // Land the fixed bytes through the sanctioned agent-write spine:
          // attributed to the calling agent (never the anonymous `file-system`
          // writer a shell `ok lint --fix` produces), item-preserving (`patch`),
          // conflict- and FM-gated, and bridged to WYSIWYG + the live preview.
          // The setPresence('writing')/touchMode('idle') pairing mirrors
          // `handleAgentWriteMd` so the fix flashes a live "writing" badge; the
          // try/finally shape is structurally enforced by agent-presence.test.ts.
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
            session.dc.document.transact(() => {
              applyAgentMarkdownWrite(
                session.dc.document,
                fixed,
                'patch',
                options.resolveEmbed
                  ? { resolveEmbed: options.resolveEmbed, sourcePath: resolvedDocName }
                  : undefined,
                undefined,
                agentWriteLossDetect(session),
              );
            }, session.origin);

            if (actor.kind !== 'anonymous') {
              recordContributor(
                resolvedDocName,
                agentId,
                agentName,
                colorSeed,
                undefined,
                actor.kind === 'agent'
                  ? buildAgentActor({
                      clientName: actor.clientName,
                      clientVersion: actor.clientVersion,
                      label: actor.label,
                    })
                  : actor.actor,
                storedSummary,
              );
            }
          } finally {
            agentPresenceBroadcaster?.touchMode(agentId, 'idle');
          }

          const flushOutcome = await flushDiskAndDetectOutcome(resolvedDocName);
          if (flushOutcome?.kind === 'failure') {
            respondPersistenceFailure(res, flushOutcome.failure, 'lint-fix');
            return;
          }
          if (flushOutcome?.kind === 'divergence') {
            respondDiskDivergence(res, 'lint-fix');
            return;
          }
          flushDocToDisk(resolvedDocName, 'lint-fix');

          // Remaining problems: re-lint the ACTUAL post-write source (bridge
          // normalization can shift bytes vs `fixed`), reusing the resolved cfg.
          // The write is already durable here (transacted + flushed to disk +
          // git); a re-lint exception (markdownlint's `lint()` can throw) must
          // NOT surface as a 500 that makes the caller believe the fix failed
          // and retry / take compensating actions on already-fixed content.
          // Fall back to the pre-fix diagnostics and report the re-lint failure
          // as a warning instead.
          try {
            after = await lintDocument(
              session.dc.document.getText('source').toString(),
              cfg,
              docRelPath,
            );
          } catch (relintErr) {
            reLintWarning = `Re-lint after fix failed: ${relintErr instanceof Error ? relintErr.message : String(relintErr)}`;
            log.warn(
              { err: relintErr, handler: 'lint-fix' },
              'post-write re-lint failed; reporting pre-fix diagnostics',
            );
            after = before;
          }
        }

        const errorCount = after.filter((d) => d.severity === 'error').length;
        const warningCount = after.length - errorCount;
        // Net problems the auto-fix resolved (clamped — a fix never nets negative).
        const fixedCount = Math.max(0, before.length - after.length);

        successResponse(
          res,
          200,
          LintFixResultSchema,
          {
            file: docRelPath,
            fixedCount,
            diagnostics: after,
            errorCount,
            warningCount,
            ...(reLintWarning ? { warning: reLintWarning } : {}),
          },
          { handler: 'lint-fix' },
        );
      } catch (e) {
        if (e instanceof SymlinkEscapeError) {
          errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
            handler: 'lint-fix',
          });
          return;
        }
        if (e instanceof DocInConflictError) {
          respondDocInConflict(res, e, 'lint-fix');
          return;
        }
        if (e instanceof FrontmatterMalformedError) {
          respondFrontmatterMalformed(res, e, 'lint-fix');
          return;
        }
        if (e instanceof AgentSessionCapacityError) {
          errorResponse(
            res,
            503,
            'urn:ok:error:too-many-agent-sessions',
            'Too many agent sessions.',
            { handler: 'lint-fix', cause: e, extraHeaders: { 'Retry-After': '10' } },
          );
          return;
        }
        log.error({ err: e }, '[lint-fix] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to fix document.', {
          handler: 'lint-fix',
          cause: e,
        });
      }
    },
    { handler: 'lint-fix', method: 'POST' },
  );

  // ───────────────────── Link preview (external hover cards) ─────────────────
  // Fetches page metadata for an external link on the user's behalf, so it is
  // guarded on two independent axes: an anti-proxy gate decides WHO may ask, and
  // the SSRF-guarded fetch decides WHERE the server may reach. The gate refuses
  // absent / `null` / non-loopback Origins that the shared /api/* allowlist would
  // wave through, because an admitted caller would be a readable server-side
  // request-forgery proxy for any local browser tab. Read-only — kept out of
  // MUTATING_ROUTES.
  const LINK_PREVIEW_HANDLER = 'link-preview';
  // Ephemeral single-file mode keeps zero user-dir artifacts, so its cache stays
  // in memory; otherwise it lives beside the other project-local sidecars.
  const linkPreviewCacheDir = ephemeral
    ? null
    : resolve(projectDir ?? contentDir, '.ok', 'local', 'link-previews');
  const linkPreviewCache = new LinkPreviewCache({ cacheDir: linkPreviewCacheDir });
  // Load the disk cache once, lazily, before the first lookup. init() never
  // throws; serializing it ahead of load() keeps a warm entry from being
  // clobbered by a late disk read.
  let linkPreviewCacheInit: Promise<void> | null = null;
  const ensureLinkPreviewCacheReady = (): Promise<void> => {
    linkPreviewCacheInit ??= linkPreviewCache.init();
    return linkPreviewCacheInit;
  };
  const linkPreviewFetchImpl: GuardedFetch = linkPreviewFetch ?? guardedFetch;

  // The cache-miss path: one SSRF-guarded page fetch, a bounded head-scan parse,
  // and a favicon fetch through the SAME chokepoint. Never throws — the guard
  // and the parser each absorb their own failures into a bounded reason.
  async function computeLinkPreview(rawUrl: string): Promise<LinkPreviewOutcome> {
    const fetched = await linkPreviewFetchImpl(rawUrl);
    if (!fetched.ok) return { ok: false, reason: fetched.reason };
    const metadata = await buildLinkPreviewMetadata({
      html: new TextDecoder().decode(fetched.body),
      requestUrl: rawUrl,
      finalUrl: fetched.finalUrl,
      fetch: linkPreviewFetchImpl,
    });
    return { ok: true, metadata };
  }

  // The egress opt-in is enforced HERE, not only in the renderer: the anti-proxy
  // gate admits ANY loopback http(s) origin by design, so without this check a
  // second local app could drive outbound fetches while the user has previews
  // OFF. Fail-closed (absent getter or a throwing read = disabled) and evaluated
  // fresh per request so a Settings toggle applies without a restart.
  const linkPreviewsEnabled = (): boolean => {
    try {
      return getLinkPreviewsEnabled?.() === true;
    } catch {
      return false;
    }
  };

  const handleLinkPreview = withValidation(
    LinkPreviewRequestSchema,
    async (_req, res, body) => {
      try {
        // Checked BEFORE the cache is touched so the disabled path can never
        // record a negative entry that would outlive re-enabling.
        if (!linkPreviewsEnabled()) {
          // Outcome instrumentation: one greppable category per request.
          // Category ONLY, never the URL, hostname, resolved IP, or fetched
          // content.
          log.debug({ outcome: 'disabled' }, '[link-preview] request outcome');
          successResponse(
            res,
            200,
            LinkPreviewResponseSchema,
            { ok: false, reason: 'disabled' },
            { handler: LINK_PREVIEW_HANDLER },
          );
          return;
        }
        await ensureLinkPreviewCacheReady();
        // Side flag on the compute closure: load() invokes compute only on a
        // cache miss, so hit-vs-computed falls out here without widening the
        // cache API.
        let computed = false;
        const outcome = await linkPreviewCache.load(body.url, () => {
          computed = true;
          return computeLinkPreview(body.url);
        });
        // Persist is best-effort and never throws; fire-and-forget so a slow disk
        // write can't stall the response.
        void linkPreviewCache.persist();
        // Rejections cross the wire with ONE coarse reason. The granular guard
        // taxonomy (private-ip / dns-failure / non-html / …) stays in local logs
        // and the on-disk cache for debugging, but returning it would let a
        // loopback caller pair chosen hostnames with reasons to enumerate
        // internal names; the renderer ignores the field either way.
        const wireOutcome: LinkPreviewOutcome = outcome.ok
          ? outcome
          : { ok: false, reason: 'blocked' };
        // Outcome instrumentation: one greppable category per request
        // (disabled / cache-hit / fetched-ok / fallback). A negative cache hit
        // logs cache-hit (served without a fetch). Category ONLY, never the
        // URL, hostname, resolved IP, or fetched content; the granular
        // rejection taxonomy is already logged at the guarded-fetch chokepoint.
        log.debug(
          { outcome: computed ? (outcome.ok ? 'fetched-ok' : 'fallback') : 'cache-hit' },
          '[link-preview] request outcome',
        );
        successResponse(res, 200, LinkPreviewResponseSchema, wireOutcome, {
          handler: LINK_PREVIEW_HANDLER,
        });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: LINK_PREVIEW_HANDLER,
          cause: e,
        });
      }
    },
    {
      handler: LINK_PREVIEW_HANDLER,
      method: 'POST',
      // Reject a cross-origin / null-origin / non-JSON caller before the body is
      // read, so a bypass request never reaches the outbound fetch.
      preBodyGate: (req, res) => {
        const verdict = classifyLinkPreviewRequest({
          origin: req.headers.origin,
          contentType: req.headers['content-type'],
        });
        if (verdict.ok) return true;
        if (verdict.reason === 'origin') {
          errorResponse(res, 403, 'urn:ok:error:invalid-origin', 'Origin not allowed.', {
            handler: LINK_PREVIEW_HANDLER,
          });
        } else {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Content-Type must be application/json.',
            { handler: LINK_PREVIEW_HANDLER },
          );
        }
        return false;
      },
    },
  );

  // The comment store + service are constructed near `resolveDocPath` above so
  // the rename walk can follow renames. Two dispatchers keep the surface to two
  // paths; the mutating sub-handlers in `comment-api.ts` thread
  // `extractActorIdentity` (same posture as the `handleSkill` / `handleTemplate`
  // dispatchers in the attribution sweep).
  const commentApi = createCommentApi({
    service: commentService,
    getPrincipal,
    onChanged: () => signalChannel?.('comments'),
  });
  const handleCommentsRoute = methodRouter(
    { GET: commentApi.list, POST: commentApi.create },
    { handler: 'comments' },
  );
  const handleCommentRoute = methodRouter(
    { GET: commentApi.read, POST: commentApi.mutate, DELETE: commentApi.remove },
    { handler: 'comment' },
  );

  // Built here, not at their old spot ~18k lines up: `skillsHome` is a `const`
  // initialized further down, so an earlier call would hit its temporal dead zone.
  const {
    handleSkillsSearch,
    handleSkillsPopular,
    handleSkillsPublisher,
    handleSkillsDetail,
    handleSkillsPreview,
    handleSkillsDiscover,
    handleSkillsResolveRef,
  } = createSkillsShHandlers({ log, skillsHome, projectDir, contentDir, resolveSkillDirForRead });

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    '/api/config': handleApiConfig,
    '/api/config/diagnostics': handleConfigDiagnostics,
    '/api/comments': handleCommentsRoute,
    '/api/comment': handleCommentRoute,
    '/api/asset': handleAsset,
    '/api/asset-text': handleAssetText,
    '/api/comment-counts': handleCommentCounts,
    '/api/link-preview': handleLinkPreview,
    '/api/folder-config': handleFolderConfig,
    '/api/saved-themes': handleSavedThemesList,
    '/api/saved-theme': handleSavedTheme,
    '/api/template': handleTemplate,
    '/api/template/import': handleTemplateImport,
    '/api/templates': handleTemplatesList,
    '/api/skill': handleSkill,
    '/api/skill-file': handleSkillFile,
    '/api/skill-file/rename': handleSkillFileRename,
    '/api/skills': handleSkillsList,
    '/api/skills/installed': handleSkillsInstalled,
    '/api/skills/search': handleSkillsSearch,
    '/api/skills/popular': handleSkillsPopular,
    '/api/skills/publisher': handleSkillsPublisher,
    '/api/skills/detail': handleSkillsDetail,
    '/api/skills/preview': handleSkillsPreview,
    '/api/skills/discover': handleSkillsDiscover,
    '/api/skills/resolve-ref': handleSkillsResolveRef,
    '/api/skill/import': handleSkillImport,
    '/api/skills/import-bulk': handleSkillsImportBulk,
    '/api/skill/edit-external': handleSkillEditExternal,
    '/api/skill/duplicate': handleSkillDuplicate,
    '/api/skill/move-scope': handleSkillMoveScope,
    '/api/skill-upload': handleSkillUpload,
    '/api/skill/install': handleSkillInstall,
    '/api/skill/uninstall': handleSkillUninstall,
    '/api/skill/restore': handleSkillRestore,
    '/api/skill/reimport': handleSkillReimport,
    '/api/skill/revert': handleSkillRevert,
    '/api/skill-targets': handleSkillTargets,
    '/api/search': handleSearch,
    '/api/semantic-status': handleSemanticStatus,
    '/api/lint/config': handleGetLintConfig,
    '/api/lint/markdownlint-config': handleWriteMarkdownlintRule,
    '/api/lint/frontmatter-schema': handleWriteFrontmatterSchema,
    '/api/lint/frontmatter-schemas': handleFrontmatterSchemasList,
    '/api/lint': handleLintDoc,
    '/api/lint/audit': handleLintAudit,
    '/api/lint/fix': handleLintFix,
    '/api/audit': handleAudit,
    '/api/create-page': handleCreatePage,
    '/api/create-folder': handleCreateFolder,
    '/api/duplicate-path': handleDuplicatePath,
    '/api/rename-path': handleRenamePath,
    '/api/delete-path': handleDeletePath,
    '/api/trash/cleanup': handleTrashCleanup,
    '/api/upload': handleUploadAsset,
    '/api/agent-write': handleAgentWrite,
    '/api/agent-write-md': handleAgentWriteMd,
    '/api/agent-write-batch': handleAgentWriteBatch,
    '/api/frontmatter-patch': handleFrontmatterPatch,
    '/api/agent-patch': handleAgentPatch,
    '/api/agent-undo': handleAgentUndo,
    '/api/agent-activity': handleAgentActivity,
    '/api/agent-burst-diff': handleAgentBurstDiff,
    '/api/save-version': handleSaveVersion,
    '/api/history': handleHistory,
    '/api/rollback': handleRollback,
    '/api/__embed-detect': handleEmbedDetect,
    '/api/server-info': handleServerInfo,
    '/api/acp/catalog': handleAcpCatalog,
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
    '/api/local-op/auth/pat': handleLocalOpAuthPat,
    '/api/local-op/auth/gh-login': handleLocalOpAuthGhLogin,
    '/api/local-op/auth/cancel': handleLocalOpAuthCancel,
    '/api/local-op/auth/repos': handleLocalOpAuthRepos,
    '/api/local-op/auth/signout': handleLocalOpAuthSignout,
    '/api/local-op/auth/set-identity': handleLocalOpAuthSetIdentity,
    '/api/local-op/embeddings/set-key': handleLocalOpEmbeddingsSetKey,
    '/api/local-op/embeddings/clear-key': handleLocalOpEmbeddingsClearKey,
    '/api/local-op/embeddings/test': handleLocalOpEmbeddingsTest,
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
    '/api/comments',
    '/api/comment',
    '/api/upload',
    '/api/lint/markdownlint-config',
    '/api/lint/frontmatter-schema',
    '/api/lint/fix',
    '/api/create-page',
    '/api/create-folder',
    '/api/duplicate-path',
    '/api/rename-path',
    '/api/delete-path',
    '/api/trash/cleanup',
    '/api/agent-write',
    '/api/agent-write-md',
    '/api/agent-write-batch',
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
    // `/api/saved-theme` (POST save / PUT update / DELETE) mutates the user-global theme
    // store; `/api/saved-themes` (GET list) is read-only and stays out.
    '/api/saved-theme',
    '/api/template',
    '/api/template/import',
    '/api/skill',
    '/api/skill-file',
    '/api/skill-file/rename',
    '/api/skill/import',
    '/api/skills/import-bulk',
    '/api/skill/duplicate',
    '/api/skill/move-scope',
    '/api/skill/edit-external',
    '/api/skill-upload',
    '/api/skill/install',
    '/api/skill/uninstall',
    '/api/skill/restore',
    '/api/skill/reimport',
    '/api/skill/revert',
    // Read-shaped GETs, but each triggers an arbitrary `git clone` (network egress)
    // + local SKILL.md reads, so they ride the loopback/host gate, not the read posture.
    '/api/skills/preview',
    '/api/skills/discover',
    '/api/skills/resolve-ref',
    '/api/skill-targets',
    '/api/seed/apply',
    '/api/client-logs',
  ]);
  // Every `/api/local-op/*` endpoint mutates local filesystem state or
  // issues network requests on behalf of the user — clone/open/auth
  // flows all fit. Prefix-match so new local-op handlers are protected
  // by default.
  const STATE_MUTATING_PREFIXES: ReadonlyArray<string> = ['/api/local-op/'];

  // The legacy route table's view for the shared /api/* admission pipeline
  // (`http/api-pipeline.ts` — the same pipeline the native Hono routes run).
  // `resolve` never declines an /api/* URL: unmatched paths resolve to the
  // bounded `/api/*` template with no dispatch so the pipeline's explicit
  // RFC 9457 404 owns the response and the dispatch surface stays closed.
  const apiRouteTable: ApiRouteTable = {
    resolve(url) {
      const handler = routes[url];
      if (handler) {
        return { template: url, dispatch: (req, res) => handler(req, res) };
      }
      if (url.startsWith('/api/history/')) {
        const encodedSha = url.slice('/api/history/'.length);
        return {
          template: '/api/history/:sha',
          // Decode inside dispatch so a malformed encoding surfaces as the
          // dispatch span's typed 500, not a resolve-time throw.
          dispatch: encodedSha
            ? async (req, res) => {
                await handleHistoryVersion(req, res, decodeURIComponent(encodedSha));
              }
            : undefined,
        };
      }
      return { template: '/api/*' };
    },
    isMutating: (url) =>
      MUTATING_ROUTES.has(url) || STATE_MUTATING_PREFIXES.some((p) => url.startsWith(p)),
  };

  const runApiPipeline = createApiRequestPipeline({
    log,
    policy: ingressPolicy,
    ephemeral,
    table: apiRouteTable,
  });

  // The natively-routed route groups. Their paths live in the Hono app only —
  // deliberately absent from `routes` above (a route lives in exactly one
  // router). Each group rides the same shared pipeline with its own table, so
  // gate behavior is identical to the legacy dispatch by construction.
  const linkGraphRoutes = createLinkGraphRoutes({
    hocuspocus,
    derivedDocumentIndex,
    getFileIndex,
    isSafeDocName,
    readPageTitleForDocName,
    readPageTitleForLinkedDocName,
    readFrontmatterMetadataForLinkedDocName,
    collectAdmittedDocNames,
    resolveAlias,
    respondToDerivedIndexQueryFailure,
  });
  const metricsRoutes = createMetricsRoutes({
    hocuspocus,
    agentPresenceBroadcaster,
    isAllowedWorkspaceHostHeader,
    log,
  });
  const nativeGroups = [linkGraphRoutes, metricsRoutes, documentRoutes];
  // "A route lives in exactly one router" — enforced at construction, not
  // just documented; covers every group aggregated into the native paths.
  // Throw semantics pinned in `http/http-app.test.ts`.
  const nativePaths = nativeGroups.flatMap((group) => [...group.paths]);
  assertSingleRouterOwnership(nativePaths, routes);
  // Multi-group composition: paths concatenate; dispatch chains the per-group
  // pipelines in order. Safe because the pipeline declines (returns false,
  // zero side effects) BEFORE any request observation when a group's table
  // does not resolve the URL — only the owning group's pipeline runs the
  // admission gates and dispatch span.
  const groupDispatches = nativeGroups.map((group) =>
    createApiRequestPipeline({
      log,
      policy: ingressPolicy,
      ephemeral,
      table: group.table,
    }),
  );
  const nativeApi: NativeApiHandle = {
    paths: nativePaths,
    dispatch: async (req, res) => {
      for (const dispatch of groupDispatches) {
        if (await dispatch(req, res)) return true;
      }
      return false;
    },
  };

  // In-process dispatch for MCP tools mounted on this same server process.
  // Allowlist: endpoints whose handlers are thin marshaling over a
  // capability service (`services/*`) or the derived-document-index reads —
  // for these the HTTP self-call collapses to a function call with the same
  // handler producing the same wire body. Everything else (CRDT paired
  // writes, rename, rollback/restore, sync/conflicts, history, lint/audit,
  // template + skill CRUD) has no extracted service yet and stays on HTTP;
  // extend this set as further capabilities extract.
  const MCP_LOCAL_API_PATHS: ReadonlySet<string> = new Set([
    // searchService
    '/api/search',
    // fileOpsService
    '/api/delete-path',
    '/api/create-folder',
    // versionOpsService
    '/api/save-version',
    // skillImportService
    '/api/skill/import',
    // skillPlacementOps / skillInstallOps
    '/api/skill/install',
    // assetService (multipart body rides the synthetic request into busboy)
    '/api/upload',
    // derived-document-index reads (native link-graph group)
    '/api/orphans',
    '/api/hubs',
    '/api/backlinks',
    '/api/forward-links',
    '/api/dead-links',
    '/api/suggest-links',
  ]);
  // Every collapsed path must resolve to a handler at construction — a typo
  // here, or a later route rename, would otherwise fall back to HTTP forever
  // with no signal. Same posture as `assertSingleRouterOwnership` above.
  for (const path of MCP_LOCAL_API_PATHS) {
    if (routes[path] === undefined && linkGraphRoutes.table.resolve(path)?.dispatch === undefined) {
      throw new Error(`MCP_LOCAL_API_PATHS has no handler for ${path}`);
    }
  }
  const localApi = createLocalApiDispatch({
    resolve: (pathname) => {
      if (!MCP_LOCAL_API_PATHS.has(pathname)) return undefined;
      const legacy = routes[pathname];
      if (legacy !== undefined) return legacy;
      return linkGraphRoutes.table.resolve(pathname)?.dispatch;
    },
  });

  return {
    priority: 100, // Higher priority — API routes run before static file serving
    async onRequest({ request, response }: { request: IncomingMessage; response: ServerResponse }) {
      await runApiPipeline(request, response);
    },
    nativeApi,
    localApi,
  };
}
