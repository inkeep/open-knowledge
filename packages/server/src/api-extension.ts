import { randomUUID } from 'node:crypto';
import {
  createReadStream,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Document, Extension, Hocuspocus } from '@hocuspocus/server';
import {
  type AdvisoryWarning,
  AGENT_ICON_COLORS,
  AGENTS_SKILLS_ROOT,
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
  applyPatchToFm,
  type BatchEntryError,
  CONFIG_DOC_NAME_OKIGNORE,
  type ConfigDiagnosticsReport,
  changedBlockRange,
  colorFromSeed,
  composeWithDerivedFrontmatter,
  createCodeFenceTracker,
  DEFAULT_LINKS_VALIDATION,
  DEFAULT_LINTER_CONFIG,
  type DiskEditReconciledWarning,
  type DocumentListEntry,
  detectFmRegion,
  EDITOR_PROJECT_SKILL_ROOT,
  type EditorId,
  EmptyRequestSchema,
  estimateSkillCost,
  externalSkillLiveDocName,
  FrontmatterPatchRequestSchema,
  FrontmatterPatchSuccessSchema,
  FrontmatterSchemaWriteRequestSchema,
  type HeadingEntry,
  type InlineAssetMediaKind,
  InstallSkillRequestSchema,
  InstallSkillSuccessSchema,
  isManagedArtifactDocName,
  isOpenKnowledgeSkillsSource,
  isSkillInstallTarget,
  LEGACY_SKILL_STORE_ROOT,
  type LinksValidationSetting,
  LintConfigResponseSchema,
  type LinterConfig,
  LintFixRequestSchema,
  LintFixResultSchema,
  type LintPluginFailure,
  type LintViolationWarning,
  LOCAL_DIR,
  lintDocument,
  MANAGED_ARTIFACT_PREFIX_SKILL,
  MarkdownlintRuleWriteRequestSchema,
  mediaKindForSidebarAssetExtension,
  OK_DIR,
  OPENKNOWLEDGE_SKILLS_REPO,
  PROJECT_SKILL_EDITOR_IDS,
  type Principal,
  type ProblemType,
  parseFrontmatterRecord,
  prependFrontmatter,
  projectSkillContentDocName,
  RENAMED_PACK_SKILLS,
  RollbackRequestSchema,
  RollbackSuccessSchema,
  readFmMap,
  SaveVersionRequestSchema,
  SaveVersionSuccessSchema,
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
  SkillInstallSuccessSchema,
  type SkillInstallWarningCode,
  SkillMoveRequestSchema,
  SkillMoveScopeRequestSchema,
  SkillMoveScopeSuccessSchema,
  SkillMoveSuccessSchema,
  SkillPutRequestSchema,
  SkillPutSuccessSchema,
  type SkillReimportBulkResult,
  SkillReimportRequestSchema,
  SkillReimportSuccessSchema,
  SkillRestoreRequestSchema,
  SkillRestoreSuccessSchema,
  SkillRevertRequestSchema,
  SkillRevertSuccessSchema,
  SkillScopeSchema,
  SkillsImportBulkRequestSchema,
  SkillsImportBulkSuccessSchema,
  SkillsListSuccessSchema,
  SkillsReimportBulkRequestSchema,
  SkillsReimportBulkSuccessSchema,
  SkillTrackInGitRequestSchema,
  SkillTrackInGitSuccessSchema,
  SkillUninstallRequestSchema,
  SkillUninstallSuccessSchema,
  SYSTEM_DOC_NAME,
  scanHeadingLine,
  skillLiveDocName,
  stripFrontmatter,
  summarizeLintPluginFailures,
  TestFlushGitSuccessSchema,
  TestRescanBacklinksSuccessSchema,
  TestRescanFilesSuccessSchema,
  TestResetSuccessSchema,
  USER_SKILL_EDITOR_IDS,
  type ValidationDiagnostic,
} from '@inkeep/open-knowledge-core';
import {
  formatRenameSubject,
  formatRollbackSubject,
  resolveProjectIdentity,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import {
  discoverSkillDirs,
  enumerateInstalledSkills,
  fetchSource,
  type PluginUpstream,
  parseSkillDir,
  parseSkillsLock,
  parseSource,
  pluginRepositoryUrl,
  pluginUpstreamsByName,
  readRepoMarketplacePlugins,
  readSkillDirMeta,
  readWellKnownIndex,
  repoMarketplacePluginFor,
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
import { type Entry, fromBuffer as yauzlFromBuffer, type ZipFile } from 'yauzl';
import {
  type AcpHarnessAvailability,
  createAcpHarnessAvailabilityProbe,
} from './acp/harness-availability.ts';
import type { AcpRegistry, CustomAgentEntry } from './acp/registry.ts';
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
import {
  type NormalizedSummary,
  normalizeSummary,
  type SummaryResponse,
} from './agent-write-summary.ts';
import { resolveBundledSkillDir } from './build-skill-zip.ts';
import { CommentIndex } from './comments/comment-index.ts';
import { CommentService } from './comments/comment-service.ts';
import { CommentThreadStore } from './comments/thread-store.ts';
import { CONFIG_VALIDATION_REVERT_ORIGIN } from './config-edit-origin.ts';
import { DocInConflictError, isDocInConflict, respondDocInConflict } from './conflict-errors.ts';
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
import {
  evaluateContentDivergence,
  toContentDivergenceWarning,
} from './content-divergence-gate.ts';
import { recordContributor } from './contributor-tracker.ts';
import type { ResolvedSemanticConfig, SemanticSearchService } from './embeddings/index.ts';
import {
  FrontmatterMalformedError,
  frontmatterRefusalDetail,
  logFrontmatterRefusal,
  respondFrontmatterMalformed,
} from './frontmatter-malformed-error.ts';
import {
  assertNoSymlinkEscape,
  isContainmentRejection,
  PathContainmentError,
} from './fs-safety.ts';
import {
  createInstalledAgentsProbe,
  createOsProbe,
  type InstalledAgentScheme,
} from './handoff-api.ts';
import { findHubCandidates } from './hub-candidates.ts';
import {
  readInstalledSkills,
  recordSkillInstall,
  removeSkillInstall,
} from './installed-skills-marker.ts';
import { collectDocFiles, lintAndFixSource } from './lint/audit.ts';
import {
  createEmptyFrontmatterSchemaFile,
  deleteFrontmatterSchemaFile,
  removeFrontmatterSchemaField,
  renameFrontmatterSchemaField,
  type WriteFrontmatterSchemaResult,
  writeFrontmatterSchemaField,
} from './lint/frontmatter-schema-write.ts';
import { unmatchedAppliesToProblems } from './lint/frontmatter-schemas.ts';
import { type WriteMarkdownlintResult, writeMarkdownlintRule } from './lint/markdownlint-write.ts';
import {
  composeEffectiveLinterConfig,
  composeFrontmatterSchemasConfig,
  resolveEffectiveLinterConfig,
  resolveNativeConfigForDoc,
} from './lint/resolve-config.ts';
import { createProjectValidators } from './lint/validation-audit.ts';
import { validateMermaidFences } from './mermaid-validator.ts';
import {
  extractPageTitle,
  type FrontmatterMetadata,
  parseFrontmatterMetadata,
} from './page-identity.ts';
import type { RecentlyRemovedDocs } from './recently-removed-docs.ts';
import {
  BUNDLE_IDS,
  BUNDLE_SCOPE,
  BUNDLE_SKILL_NAME,
  isInternalBundleSkillName,
  USER_GLOBAL_BUNDLE_IDS,
} from './skill-bundles.ts';
import {
  buildAndOpenSkill,
  detectProjectSkillEditors,
  detectUserSkillHosts,
} from './skill-install.ts';
import {
  listSkillBundledFilePaths,
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
  ManagedRenameDestinationExistsError,
  ManagedRenameInvalidRequestError,
  ManagedRenameMissingDocumentError,
  ManagedRenameReservedPathError,
  ManagedRenameSnapshotMissingError,
  ManagedRenameSourceNotFoundError,
  ManagedRenameSourceTypeMismatchError,
} from './apply-managed-rename.ts';
import { composeAndWriteRawBody, type PrecomputedParse, replaceRawBody } from './bridge-intake.ts';
import type { BridgeDeriveLossReporter } from './bridge-loss-detector.ts';
import { isConfigDoc, isLinkIndexExcludedDoc, isSystemDoc } from './cc1-broadcast.ts';
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
  canonicalDocName,
  docNameToRelativePath,
  extensionlessDocTreePath,
  forgetDocExtension,
  getDocExtension,
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
import {
  tracedCpSync,
  tracedMkdirSync,
  tracedRenameSync,
  tracedRmSync,
  tracedWriteFileSync,
} from './fs-traced.ts';
import { withParentLock } from './git-handle.ts';
import { type ApiRouteTable, createApiRequestPipeline } from './http/api-pipeline.ts';
import { catchErrors } from './http/catch-errors.ts';
import { createCommentRoutes } from './http/comment-routes.ts';
import { createConfigSystemRoutes } from './http/config-system-routes.ts';
import { createDocumentRoutes } from './http/document-routes.ts';
import { errorResponse, type HttpErrorStatus } from './http/error-response.ts';
import {
  createFileOpsRoutes,
  type ManagedRenameRewrittenDoc,
  type RenamedAssetMapping,
  type RenamedDocMapping,
} from './http/file-ops-routes.ts';
import { createFolderTemplateRoutes } from './http/folder-template-routes.ts';
import { createGitRoutes } from './http/git-routes.ts';
import { createHistoryRoutes } from './http/history-routes.ts';
import { assertSingleRouterOwnership, type NativeApiHandle } from './http/http-app.ts';
import { createLinkGraphRoutes } from './http/link-graph-routes.ts';
import { createLintRoutes } from './http/lint-routes.ts';
import { createLocalApiDispatch, type LocalApiDispatch } from './http/local-api-dispatch.ts';
import { createLocalOpRoutes } from './http/local-op-routes.ts';
import { methodRouter } from './http/method-router.ts';
import { createMetricsRoutes } from './http/metrics-routes.ts';
import { getRequestId } from './http/request-id.ts';
import { withValidation } from './http/request-validation.ts';
import { createSeedRoutes } from './http/seed-routes.ts';
import { createShareRoutes } from './http/share-routes.ts';
import { createSkillsReadRoutes } from './http/skills-read-routes.ts';
import { createSkillsShRoutes } from './http/skills-sh-routes.ts';
import { successResponse } from './http/success-response.ts';
import { createSyncRoutes } from './http/sync-routes.ts';
import { createSystemActionsRoutes } from './http/system-actions-routes.ts';
import {
  createWorkspaceToolsRoutes,
  type GeneratedIndexSettingsStatus,
} from './http/workspace-tools-routes.ts';
import {
  aliasedSourceRoots,
  isActivatedSkillRoot,
  removableSkillOccurrenceDirs,
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
import type { GuardedFetch } from './link-preview/metadata.ts';
import {
  checkLocalOpSecurity as checkLocalOpSecurityBase,
  createConcurrencyGuard,
  isSafeLocalPath,
} from './local-op-security.ts';
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
import { createMultipartParser, type MultipartParser } from './multipart.ts';
import { precomputeParse } from './parse-pool.ts';
import { isWithinDir, toPosix } from './path-utils.ts';
import { openPluginBaselines } from './plugin-skill-baseline.ts';
import {
  appendRenameLogEntry,
  createAncestorShaSetCache,
  getOrLoadRenameLogIndex,
  type RenameLogEntry,
  resolveDocPathAtCommit,
} from './rename-log.ts';
import type { PairedWriteOrigin } from './server-observers.ts';
import { createAssetService } from './services/assets.ts';
import { createFileOpsService, DuplicateNameExhaustedError } from './services/file-ops.ts';
import { createSearchService } from './services/search.ts';
import { createSkillImportService, type SkillImportOutcome } from './services/skill-import.ts';
import { createSkillInstallOpsService } from './services/skill-install-ops.ts';
import { createSkillPlacementOpsService } from './services/skill-placement-ops.ts';
import {
  createSkillReimportService,
  groupReimportNamesBySource,
  pickReimportDir,
  type SkillReimportOutcome,
} from './services/skill-reimport.ts';
import { createVersionOpsService } from './services/version-ops.ts';
import {
  SERVICE_WRITER,
  type ShadowRef,
  safetyCheckpoint,
  shadowGit,
  type WriterIdentity,
} from './shadow-repo.ts';
import { isDisallowedGitSpec, rejectDisallowedGitSpec } from './skill-git-spec-guard.ts';
import { resolveSkillInstallReportSettings } from './skill-install-report-config.ts';
import {
  clearSkillPlacements,
  readSkillInstallModeRaw,
  readSkillPlacements,
} from './skill-placements.ts';
import { restoreSkillVersion } from './skill-restore.ts';
import { mutateSkillsLock, readSkillsLockFile } from './skills-lock-store.ts';
import { reportSkillInstall } from './skills-sh-install-report.ts';
import type { SyncEngine } from './sync-engine.ts';
import { getMeter, withSpan, withSpanSync } from './telemetry.ts';
import { computeWriteAdvisoryLinks } from './write-advisory-links.ts';

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

type DivergenceHandler = 'agent-write-md' | 'agent-write-batch' | 'agent-patch' | 'rollback';

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

function docTreePathCandidates(docName: string, contentRoot: string): readonly string[] {
  const p = safeDocPath(docName, contentRoot);
  if ('error' in p) return [`${docName}.md`];
  const extless = extensionlessDocTreePath(p.path, docName);
  return extless ? [p.path, extless] : [p.path];
}

export { sanitizeFilename } from './filename-sanitize.ts';
export { resolveUploadDestDir } from './services/assets.ts';

import { classifyUploadErrno, uploadStatusFor } from './upload-errors.ts';

export function safeSubdir(baseDir: string, subdir: string): string {
  const resolved = resolve(baseDir, subdir);
  if (!isWithinDir(resolved, baseDir)) {
    throw new Error(`Invalid directory: ${subdir}`);
  }
  return resolved;
}

export function indexedSkillContentPath(absolutePath: string, contentDir: string): string | null {
  let real: string;
  let realContentDir: string;
  try {
    real = realpathSync(absolutePath);
    realContentDir = realpathSync(contentDir);
  } catch {
    return null;
  }
  if (!isWithinDir(real, realContentDir)) return null;
  return relative(realContentDir, real).split(sep).join('/');
}

export interface SkillAdmissionHealState {
  lastKey: string | null;
}

export async function healUnservableSkillAdmission(
  paths: readonly string[],
  filter: {
    isExcluded: (relativePath: string) => boolean;
    rebuildIgnorePatterns: () => Promise<unknown>;
  } | null,
  state: SkillAdmissionHealState,
): Promise<boolean> {
  if (!filter) return false;
  const key = [...paths].sort().join(' ');
  if (key === state.lastKey) return false;
  state.lastKey = key;
  if (!paths.some((p) => filter.isExcluded(p))) return false;
  try {
    await filter.rebuildIgnorePatterns();
    return true;
  } catch {
    return false;
  }
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

export interface StreamShowAllOpts {
  contentDir: string;
  contentFilter: ContentFilter;
  dirFilter: string | null;
  maxEntries: number;
  signal?: AbortSignal;
  maxDepth?: number;
  showOk?: boolean;
}

export interface WalkShowAllOpts extends StreamShowAllOpts {
  documents: DocumentListEntry[];
}

export async function* streamShowAllEntries(
  opts: StreamShowAllOpts,
): AsyncGenerator<DocumentListEntry, { truncated: boolean }, void> {
  const { contentDir, contentFilter, dirFilter, maxEntries, signal, showOk } = opts;
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  const filterOpts = { bypassFilters: true, respectOkignore: true, showOk } as const;
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

  async function probeHasChildren(absDir: string, relDir: string): Promise<boolean> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      log.warn({ dir: absDir, err }, `[document-list][showAll] probe readdir failed for ${absDir}`);
      return false;
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (contentFilter.isDirExcluded(relPath, filterOpts)) continue;
        try {
          const childCanonical = await realpath(join(absDir, entry.name));
          if (!isInsideContentDir(childCanonical)) continue;
        } catch (err) {
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
        log.warn({ dir: absDir, err }, `[document-list][showAll] readdir failed for ${absDir}`);
        continue;
      }
      const variantCountsByDocName = await docVariantCounts(entries, absDir, relDir);

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
          if (contentFilter.isDirExcluded(relPath, filterOpts)) continue;

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
              log.warn(
                { path: dirAbsRaw, err },
                `[document-list][showAll] stat failed for ${dirAbsRaw}`,
              );
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

type ContentEntryKind = 'file' | 'folder';

interface ManagedRenameRewriteSummary {
  markdown: string;
  rewrites: number;
}

function isValidRelativeContentPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\x00')) {
    return false;
  }

  return path.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
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

function resolveContentEntryPath(contentDir: string, kind: ContentEntryKind, path: string): string {
  if (!isValidRelativeContentPath(path)) {
    throw new PathContainmentError('path must be a relative content path');
  }

  const resolvedContentDir = resolve(contentDir);
  const relativePath = kind === 'file' ? docNameToRelativePath(path) : path;
  const fullPath = resolve(resolvedContentDir, relativePath);

  if (fullPath !== resolvedContentDir && !fullPath.startsWith(`${resolvedContentDir}${sep}`)) {
    throw new PathContainmentError('path must not escape content directory');
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

function docNameExistsWithAnySupportedExtension(contentDir: string, docName: string): boolean {
  return resolveDocFilePath(contentDir, docName) !== null;
}

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
    throw new PathContainmentError('path must be a relative content path');
  }
  const resolvedContentDir = resolve(contentDir);
  const fullPath = resolve(resolvedContentDir, `${docName}${extension}`);
  if (fullPath !== resolvedContentDir && !fullPath.startsWith(`${resolvedContentDir}${sep}`)) {
    throw new PathContainmentError('path must not escape content directory');
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
  ingressPolicy?: IngressPolicy;
  hocuspocus: Hocuspocus;
  durabilityState: DocumentDurabilityState;
  sessionManager: AgentSessionManager;
  contentDir: string;
  getGeneratedIndexSettingsStatus?: () => GeneratedIndexSettingsStatus;
  setGeneratedIndexEnabled?: (enabled: boolean) => Promise<GeneratedIndexSettingsStatus>;
  ephemeral?: boolean;
  serverInstanceId: string;
  getFileIndex: () => ReadonlyMap<string, FileIndexEntry>;
  getAttachmentFolderPath?: () => string;
  getAllFilesIndex?: () => ReadonlyMap<string, FileIndexEntry>;
  getFileIndexGeneration?: () => number;
  mutateFileIndex?: (event: DiskEvent) => void;
  getFolderIndex?: () => ReadonlyMap<string, FolderIndexEntry>;
  onReferencedAssetsCacheInvalidator?: (invalidate: () => void) => void;
  getAliasMap?: () => ReadonlyMap<string, string>;
  getFolderAliasIndex?: () => ReadonlyMap<string, string>;
  rescanFiles?: () => void | Promise<void>;
  localOpConcurrencyGuard?: ReturnType<typeof createConcurrencyGuard>;
  enableTestRoutes?: boolean;
  shadowRef?: ShadowRef;
  flushGitCommit?: () => Promise<void>;
  flushContributors?: () => Promise<void>;
  getCurrentBranch?: () => string | null;
  getDiskAckSVs?: () => Record<string, string>;
  getCollabClientCount?: () => number;
  contentRoot?: string;
  derivedDocumentIndex?: DerivedDocumentIndexApiPort;
  signalChannel?: (channel: 'files' | 'lint-config' | 'comments') => void;
  commentDocHooksRef?: { current: CommentDocHooks | null };
  agentFocusBroadcaster?: AgentFocusBroadcaster;
  agentPresenceBroadcaster?: AgentPresenceBroadcaster;
  onAgentWrite?: () => void;
  getSyncEngine?: () => SyncEngine | null;
  localOpCliArgs?: string[];
  authStreamHeartbeatMs?: number;
  projectDir?: string;
  linkPreviewFetch?: GuardedFetch;
  getLinkPreviewsEnabled?: () => boolean;
  getConfigDiagnostics?: () => ConfigDiagnosticsReport;
  resolveEmbed?: (basename: string, sourcePath: string) => string | null;
  getBridgeLossReporter?: () => BridgeDeriveLossReporter | undefined;
  getPrincipal?: () => Principal | null;
  homeDirOverride?: string;
  savedThemeLockTimeoutMs?: number;
  acpRegistry?: AcpRegistry;
  loadAcpCustomAgents?: () => Promise<CustomAgentEntry[]>;
  acpHarnessAvailability?: () => Promise<AcpHarnessAvailability>;
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
  readSemanticProviderConfig?: () => ResolvedSemanticConfig;
  getLinterBaseConfig?: () => LinterConfig;
  getLinksValidationSetting?: () => LinksValidationSetting;
}

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

function applyDiskEventToLiveAllFilesIndex(
  event: DiskEvent,
  getAllFilesIndex: () => ReadonlyMap<string, FileIndexEntry>,
): void {
  const live = getAllFilesIndex();
  if (live instanceof Map) {
    updateFileIndex(event, live);
  }
}

export interface CommentDocHooks {
  changed: (docName: string) => void;
  deleted: (docName: string) => void;
}

export function createApiExtension(
  options: ApiExtensionOptions,
): Extension & { nativeApi: NativeApiHandle; localApi: LocalApiDispatch } {
  const { durabilityState } = options;
  const ingressPolicy = options.ingressPolicy ?? buildIngressPolicy({});
  const checkLocalOpSecurity = (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ): boolean => checkLocalOpSecurityBase(req, res, { ...opts, policy: ingressPolicy });
  const isAllowedWorkspaceHostHeader = (host: string | undefined): boolean =>
    isHostAdmitted(host, ingressPolicy);
  const isRoutePeerAdmitted = (remoteAddress: string | undefined): boolean =>
    isPeerAdmitted(remoteAddress, ingressPolicy);
  const {
    hocuspocus,
    sessionManager,
    contentDir,
    getGeneratedIndexSettingsStatus,
    setGeneratedIndexEnabled,
    serverInstanceId,
    getFileIndex,
    getAttachmentFolderPath,
    getAllFilesIndex = getFileIndex,
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
    getCollabClientCount,
    contentRoot,
    derivedDocumentIndex,
    signalChannel: rawSignalChannel,
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
  const signalChannel: typeof rawSignalChannel = rawSignalChannel
    ? (channel) => {
        if (channel === 'files') bumpSkillsCatalogGen();
        rawSignalChannel(channel);
      }
    : undefined;

  const localOpGuard = localOpConcurrencyGuard ?? createConcurrencyGuard();

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
    const relPath = docNameToRelativePath(docName);
    const filePath = resolve(resolvedContentDir, relPath);
    if (!isWithinDir(filePath, resolvedContentDir)) {
      return null;
    }
    return filePath;
  }

  const commentService = new CommentService({
    store: new CommentThreadStore(resolve(contentDir, OK_DIR, LOCAL_DIR), log),
    index: new CommentIndex(),
    getDocBody: (docName) => {
      try {
        const doc = hocuspocus.documents.get(docName);
        if (doc) return stripFrontmatter(doc.getText('source').toString()).body;
      } catch {}
      try {
        const filePath = resolveDocPath(docName);
        if (filePath && existsSync(filePath)) {
          return stripFrontmatter(readFileSync(filePath, 'utf-8')).body;
        }
      } catch {}
      return null;
    },
    getDocFrontmatter: (docName: string): Record<string, unknown> | null => {
      try {
        const doc = hocuspocus.documents.get(docName);
        if (doc) return parseFrontmatterRecord(doc.getText('source').toString()) ?? {};
      } catch {}
      try {
        const filePath = resolveDocPath(docName);
        if (filePath && existsSync(filePath)) {
          return parseFrontmatterRecord(readFileSync(filePath, 'utf-8')) ?? {};
        }
      } catch {}
      return null;
    },
  });

  if (options.commentDocHooksRef) {
    options.commentDocHooksRef.current = {
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
    } catch {}
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

  async function computeOrphanHints(
    docName: string,
  ): Promise<Array<{ type: 'orphan'; parentCandidates: string[]; message: string }> | undefined> {
    if (!derivedDocumentIndex) return undefined;
    try {
      const backlinks = await derivedDocumentIndex.getBacklinks(docName);
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
      log.warn({ err }, '[orphan-hint] computeOrphanHints failed');
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

  function flushDocToDisk(docName: string, label: string): void {
    const debounceId = `onStoreDocument-${docName}`;
    if (!hocuspocus.debouncer.isDebounced(debounceId)) return;
    hocuspocus.debouncer.executeNow(debounceId).catch((err: unknown) => {
      log.warn({ err }, `[${label}] post-write disk flush failed`);
    });
  }

  type FlushOutcome = { kind: 'failure'; failure: StoreFailure } | { kind: 'divergence' } | null;

  async function flushDiskAndDetectOutcome(docName: string): Promise<FlushOutcome> {
    const debounceId = `onStoreDocument-${docName}`;
    if (hocuspocus.debouncer.isDebounced(debounceId)) {
      durabilityState.markAgentWriteStore(docName);
      await hocuspocus.debouncer.executeNow(debounceId);
    }
    const failure = durabilityState.takeStoreFailure(docName);
    if (failure) return { kind: 'failure', failure };
    if (durabilityState.takeStoreDivergence(docName)) return { kind: 'divergence' };
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

  // (precedent #55): a doc the watcher would refuse to index must not slip into
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

  function createLinkedFolderExists(): (folderPath: string) => boolean {
    const folderIndex = getFolderIndex?.();
    if (!folderIndex) return () => false;
    return (folderPath) => folderIndex.has(folderPath);
  }

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

  // Mirrors the watcher's admission gate (precedent #55): a content-scope-excluded
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
    if (isContainmentRejection(error)) {
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

            if (!renameMap.has(docName)) {
              const filePath = resolveContentEntryPath(contentDir, 'file', docName);
              if (!existsSync(filePath)) {
                missingBacklinkSources.push(docName);
                continue;
              }
            }

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

            if (
              process.env.NODE_ENV === 'test' &&
              process.env.OK_TEST_RENAME_FAULT === 'pre-append'
            ) {
              throw new Error('OK_TEST_RENAME_FAULT=pre-append');
            }

            if (shadowRef?.current) {
              const shadow = shadowRef.current;
              const loggableAffectedDocs = affectedDocs.filter(
                ({ from, to }) => stripDocExtension(from) !== stripDocExtension(to),
              );
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
    if (kind === 'skill') return `${projectSkillDirRel(String(name))}/SKILL`;
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

  let skillsCatalogGen = 0;
  let skillsListCache: { at: number; gen: number; fp: string; body: unknown } | null = null;
  let installedCatalogCache: {
    at: number;
    gen: number;
    key: string;
    value: ReturnType<typeof enumerateInstalledSkills>;
  } | null = null;
  function bumpSkillsCatalogGen(): void {
    skillsCatalogGen += 1;
  }
  function enumerateInstalledSkillsCached(
    opts: Parameters<typeof enumerateInstalledSkills>[0],
  ): ReturnType<typeof enumerateInstalledSkills> {
    const key = `${opts?.projectDir ?? ''}|${opts && 'home' in opts ? opts.home : ''}`;
    const now = Date.now();
    if (
      installedCatalogCache !== null &&
      installedCatalogCache.gen === skillsCatalogGen &&
      installedCatalogCache.key === key &&
      now - installedCatalogCache.at < 5_000
    ) {
      return installedCatalogCache.value;
    }
    const value = enumerateInstalledSkills(opts);
    installedCatalogCache = { at: now, gen: skillsCatalogGen, key, value };
    return value;
  }
  let deferredIgnoreRebuildTimer: NodeJS.Timeout | null = null;
  function scheduleDeferredIgnoreRebuild(): void {
    if (!contentFilter) return;
    if (deferredIgnoreRebuildTimer !== null) clearTimeout(deferredIgnoreRebuildTimer);
    deferredIgnoreRebuildTimer = setTimeout(() => {
      deferredIgnoreRebuildTimer = null;
      void contentFilter?.rebuildIgnorePatterns().catch(() => {});
    }, 120_000);
  }
  let okArtifactFlushChain: Promise<void> = Promise.resolve();
  function scheduleOkArtifactFlush(context: string): void {
    bumpSkillsCatalogGen();
    okArtifactFlushChain = okArtifactFlushChain
      .then(() => commitOkArtifactWrite(context))
      .catch(() => {});
  }
  async function commitOkArtifactWrite(context: string): Promise<void> {
    if (!flushContributors) return;
    try {
      await flushContributors();
    } catch (flushErr) {
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
        const rawDocName = requireNonEmptyDocName(body.docName, res, 'agent-write');
        if (rawDocName === null) return;
        const docName = resolveAlias(rawDocName);

        // (precedent #24). Body-shape errors emitted by `withValidation` are
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
          agentWritePreDrain(session.dc.document, `${content}\n`, 'append');
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
        const brokenLinks = computeWriteAdvisoryLinks(
          writtenSource,
          resolvedDocName,
          admittedForLinks,
          createLinkedFileExists(),
          createLinkedFolderExists(),
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
        log.error({ err: e, requestId: getRequestId(_req) }, '[agent-write-md] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'agent-write-md',
          cause: e,
        });
      }
    },
    { handler: 'agent-write-md', method: 'POST' },
  );

  const handleAgentWriteBatch = withValidation(
    AgentWriteBatchRequestSchema,
    async (_req, res, body) => {
      try {
        const { agentId, agentName, colorSeed, clientName, clientVersion, label } =
          extractAgentIdentity(body);

        const timestamp = new Date().toISOString();

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
              const disposeEntryEffectCapture = captureEffect(
                session.dc.document.getText('source'),
                agentId,
                session.origin,
                colorSeed,
                clientName,
              );
              agentWritePreDrain(session.dc.document, entry.markdown, entry.position ?? 'append');
              try {
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

          const admittedForLinks = await collectAdmittedDocNames();
          for (const p of pending) {
            if (flushErrors.get(p.docName) === undefined) admittedForLinks.add(p.docName);
          }
          const linkedFileExists = createLinkedFileExists();
          const linkedFolderExists = createLinkedFolderExists();

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
              linkedFolderExists,
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
                  // primitive (precedent #38, bridge-intake.ts) so paired-
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
            // precedent #38). Searching `serialize(fragment)` would compute
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
        const brokenLinks = computeWriteAdvisoryLinks(
          patchedSource,
          docName,
          admittedForLinks,
          createLinkedFileExists(),
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
        const docName = canonicalDocName(
          resolveAlias(url.searchParams.get('docName') ?? 'test-doc'),
        );

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
        await derivedDocumentIndex?.testOnly?.resetDocumentForTest(docName);

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
              bumpSkillsCatalogGen();
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

        // (precedent #38 — Y.Text-is-truth) which performs the full ytext
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

  const assetService = createAssetService({
    contentDir,
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

  const TEXT_VIEW_MAX_BYTES = 1_048_576;
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
      errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escapes content directory.', {
        handler,
      });
      return null;
    }
    try {
      const okDir = resolve(candidateAbs, '.ok');
      assertNoSymlinkEscape(okDir, resolvedContentDir);
      assertNoSymlinkEscape(resolve(okDir, 'templates'), resolvedContentDir);
    } catch (err) {
      if (isContainmentRejection(err)) {
        errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escapes content directory.', {
          handler,
          cause: err,
        });
        return null;
      }
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to validate path.', {
        handler,
        cause: err,
      });
      return null;
    }
    return { folderRel, resolvedContentDir };
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

  const parseFrontmatterDoc = (
    raw: string,
  ): { frontmatter: Record<string, unknown>; body: string } => {
    const { body } = stripFrontmatter(raw);
    return { frontmatter: parseFrontmatterRecord(raw) ?? {}, body };
  };

  const SKILLS_LIST_CAP = 500;

  function isValidSkillName(name: string): boolean {
    return Boolean(name) && name.length <= 64 && SKILL_NAME_REGEX.test(name);
  }
  function validateSkillName(name: string, res: ServerResponse, handler: string): boolean {
    if (!isValidSkillName(name)) {
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
  const skillInstallOps = createSkillInstallOpsService({
    contentDir,
    skillsHome,
    effectiveInstallMode,
  });

  function resolveSkillsRoot(scope: 'project' | 'global'): string {
    return scope === 'global'
      ? resolve(skillsHome, '.ok', 'skills')
      : resolve(contentDir, '.ok', 'skills');
  }

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
      const native = resolveGlobalNativeSkillDir(skillsHome, name);
      if (native !== null) return native;
      return existsSync(join(store, 'SKILL.md')) ? store : null;
    }
    const inPlace = scanInPlaceSkills(contentDir).find(
      (s) => s.name === name && (host === undefined || s.hosts.includes(host)),
    );
    if (inPlace) return resolve(contentDir, inPlace.dir);
    if (host !== undefined) return null;
    return existsSync(join(store, 'SKILL.md')) ? store : null;
  }

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

  function projectionModeFor(scope: 'project' | 'global', name: string): 'symlink' | 'copy' {
    const base = scope === 'project' ? projectDir : skillsHome;
    if (!base) return 'symlink';
    try {
      const lock = readSkillsLock(join(base, ...SKILLS_LOCK_REL));
      return lock.skills[name] !== undefined ? 'copy' : 'symlink';
    } catch {
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

  function effectiveInstallMode(
    scope: 'project' | 'global',
    name: string,
    existing: { hosts: readonly string[]; linkedHosts: readonly string[] },
  ): 'copy' | 'link' {
    const prefBase = scope === 'project' ? projectDir : skillsHome;
    const recorded = prefBase ? readSkillInstallModeRaw(prefBase, name) : undefined;
    if (recorded) return recorded;
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

  const BUILTIN_PROJECT_SKILL_NAME = BUNDLE_SKILL_NAME.project;

  function resolveBuiltinSkillDir(
    base: string,
    name: string,
    host?: string,
  ): { dir: string; skillMd: string; hosts: string[]; relPath: string } | null {
    const hosts: string[] = [];
    let chosenDir: string | null = null;
    const roots: Array<{ id: string; root: string }> = [
      ...PROJECT_SKILL_EDITOR_IDS.map((editorId) => ({
        id: editorId as string,
        root: EDITOR_PROJECT_SKILL_ROOT[editorId] ?? '',
      })),
      { id: 'agents', root: AGENTS_SKILLS_ROOT },
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

  const PLUGIN_INDEX_TTL_MS = 30_000;
  let pluginIndex: { at: number; identity: string; byName: Map<string, PluginUpstream> } | null =
    null;

  function pluginSkillsByName(identity: string): Map<string, PluginUpstream> {
    const now = Date.now();
    if (
      pluginIndex &&
      pluginIndex.identity === identity &&
      now - pluginIndex.at < PLUGIN_INDEX_TTL_MS
    )
      return pluginIndex.byName;
    let byName = new Map<string, PluginUpstream>();
    try {
      byName = pluginUpstreamsByName(
        enumerateInstalledSkillsCached(
          homeDirOverride !== undefined ? { home: homeDirOverride } : {},
        ).skills,
        (home) => parseSkillDir(home)?.contentHash,
      );
    } catch (err) {
      log.warn({ err }, 'plugin upstream index failed; origins will be omitted');
    }
    pluginIndex = { at: now, identity, byName };
    return byName;
  }

  function pluginUpstreamHash(name: string, identity: string): string | null {
    return pluginSkillsByName(identity).get(name)?.contentHash ?? null;
  }

  function pluginSelfIdentity(
    name: string,
    identity: string,
    skillAbsDir: string,
  ): { name: string; marketplace: string; provider: string; url?: string } | null {
    const upstream = pluginSkillsByName(identity).get(name);
    if (!upstream) return null;
    try {
      if (realpathSync(skillAbsDir) !== realpathSync(upstream.home)) return null;
    } catch {
      return null;
    }
    return {
      name: upstream.plugin,
      marketplace: upstream.marketplace,
      provider: upstream.provider,
      ...(upstream.repositoryUrl ? { url: upstream.repositoryUrl } : {}),
    };
  }

  function synthPluginLockEntry(
    name: string,
    identity: string,
    skillAbsDir?: string,
  ): SkillsLock['skills'][string] | null {
    const upstream = pluginSkillsByName(identity).get(name);
    if (!upstream) return null;
    if (skillAbsDir !== undefined) {
      try {
        if (realpathSync(skillAbsDir) === realpathSync(upstream.home)) return null;
      } catch {}
    }
    let importedAt: string;
    try {
      importedAt = statSync(join(upstream.home, 'SKILL.md')).mtime.toISOString();
    } catch (err) {
      log.warn({ err, home: upstream.home }, 'plugin bundle unreadable; origin dated epoch');
      importedAt = new Date(0).toISOString();
    }
    return {
      source: upstream.home,
      skill: name,
      contentHash: upstream.contentHash,
      autoUpdate: false,
      importedAt,
    };
  }

  function shippedBundleSkillMd(name: string, scope?: 'project' | 'global'): string | null {
    const id = BUNDLE_IDS.find((bundleId) => BUNDLE_SKILL_NAME[bundleId] === name);
    if (id === undefined) return null;
    if (scope !== undefined && BUNDLE_SCOPE[id] !== (scope === 'global' ? 'user' : 'project')) {
      return null;
    }
    try {
      const dir = resolveBundledSkillDir(id, { checkDesktop: true });
      const md = resolve(dir, 'SKILL.md');
      return existsSync(md) ? md : null;
    } catch (err) {
      log.warn({ name, err }, `[skills] bundle asset dir unresolved for built-in ${name}`);
      return null;
    }
  }

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
    size?: ReturnType<typeof estimateSkillCost>;
    origin?: ReturnType<typeof skillOriginFor>;
  } | null {
    const resolved = resolveBuiltinSkillDir(base, name);
    const skillMd = resolved?.skillMd ?? shippedBundleSkillMd(name);
    if (skillMd === null) return null;
    let description: string | undefined;
    try {
      const { frontmatter } = parseFrontmatterDoc(readFileSync(skillMd, 'utf-8'));
      if (typeof frontmatter.description === 'string') description = frontmatter.description;
    } catch {}
    const synthEntry = synthBuiltinLockEntry(base, name);
    const parsed = parseSkillDir(dirname(skillMd));
    return {
      name,
      ...(description !== undefined ? { description } : {}),
      scope,
      path: resolved?.relPath ?? skillMd,
      absolutePath: skillMd,
      installed: (resolved?.hosts.length ?? 0) > 0,
      hosts: resolved?.hosts ?? [],
      managed: true,
      ...(parsed ? { size: estimateSkillCost(parsed) } : {}),
      ...(synthEntry ? { origin: skillOriginFor(synthEntry) } : {}),
    };
  }

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

  function skillRelPath(abs: string, scope: 'project' | 'global'): string {
    const base = scope === 'global' ? skillsHome : contentDir;
    return relative(base, abs).split(/[\\/]/).filter(Boolean).join('/');
  }

  function skillInstallBase(scope: 'project' | 'global'): string | undefined {
    return scope === 'global' ? skillsHome : projectDir;
  }

  async function uninstallSkillFromHostDirs(
    base: string,
    name: string,
    scope: 'project' | 'global',
    opts: { purge?: { contentHash: string } } = {},
  ): Promise<boolean> {
    const installed = await removeSkillInstall(base, name);
    const scanBaseForPurge = scope === 'project' ? contentDir : skillsHome;
    if (opts.purge !== undefined) {
      reverseProjectSkill(name, base, PROJECT_SKILL_EDITOR_IDS, skillProjectionRoots(scope));
      for (const dir of removableSkillOccurrenceDirs(
        scanBaseForPurge,
        scope,
        name,
        opts.purge.contentHash,
      )) {
        tracedRmSync(dir, { recursive: true, force: true });
      }
      return installed !== null;
    }
    if (!existsSync(resolve(resolveSkillsRoot(scope), name, 'SKILL.md'))) {
      const entry = (
        scope === 'project' ? scanInPlaceSkills(contentDir) : scanGlobalInPlaceSkills(skillsHome)
      ).find((s) => s.name === name);
      if (entry) {
        const scanBase = scope === 'project' ? contentDir : skillsHome;
        const canonical = resolve(scanBase, entry.dir);
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
    reverseProjectSkill(name, base, PROJECT_SKILL_EDITOR_IDS, skillProjectionRoots(scope));
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
      try {
        const { frontmatter } = parseFrontmatterDoc(readFileSync(skillMd, 'utf-8'));
        if (typeof frontmatter.description === 'string') description = frontmatter.description;
      } catch {}
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

  function trackInGitLine(skillDirRel: string): string {
    const root = dirname(skillDirRel);
    return `!/${root.split(sep).join('/')}/`;
  }

  const handleSkillTrackInGit = withValidation(
    SkillTrackInGitRequestSchema,
    catchErrors(
      async (_req, res, body) => {
        if (!validateSkillName(body.name, res, 'skill-track-in-git')) return;
        if (body.scope !== 'project') {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Only project skills live in the repository; a global skill is outside any .gitignore.',
            { handler: 'skill-track-in-git' },
          );
          return;
        }
        if (!projectDir) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project directory.', {
            handler: 'skill-track-in-git',
          });
          return;
        }
        const inPlace = scanInPlaceSkills(contentDir).find((s) => s.name === body.name);
        const mountedDirRel = inPlace?.dir ?? `${LEGACY_SKILL_STORE_ROOT}/${body.name}`;
        const indexedFileRel =
          indexedSkillContentPath(resolve(contentDir, mountedDirRel, 'SKILL.md'), contentDir) ??
          `${mountedDirRel}/SKILL.md`;
        const skillDirRel = dirname(indexedFileRel);
        const skillFileRel = indexedFileRel;
        const line = trackInGitLine(skillDirRel);
        const gitignoreRel = '.gitignore';
        const gitignoreAbs = resolve(contentDir, gitignoreRel);

        if (contentFilter && !contentFilter.isPathIgnored(skillFileRel)) {
          successResponse(
            res,
            200,
            SkillTrackInGitSuccessSchema,
            { line, gitignorePath: gitignoreRel, applied: false, alreadyTracked: true },
            { handler: 'skill-track-in-git' },
          );
          return;
        }
        if (body.apply !== true) {
          successResponse(
            res,
            200,
            SkillTrackInGitSuccessSchema,
            { line, gitignorePath: gitignoreRel, applied: false },
            { handler: 'skill-track-in-git' },
          );
          return;
        }

        const before = existsSync(gitignoreAbs) ? readFileSync(gitignoreAbs, 'utf-8') : null;
        const lines = (before ?? '').split('\n');
        if (lines.some((l) => l.trim() === line)) {
          errorResponse(
            res,
            409,
            'urn:ok:error:invalid-request',
            `"${line}" is already in ${gitignoreRel}, but ${skillFileRel} is still ignored — another rule excludes it.`,
            { handler: 'skill-track-in-git' },
          );
          return;
        }
        const next = `${before === null || before.endsWith('\n') || before === '' ? (before ?? '') : `${before}\n`}${line}\n`;
        writeFileSync(gitignoreAbs, next, 'utf-8');
        bumpSkillsCatalogGen();
        await contentFilter?.rebuildIgnorePatterns();

        if (contentFilter?.isPathIgnored(skillFileRel)) {
          if (before === null) rmSync(gitignoreAbs, { force: true });
          else writeFileSync(gitignoreAbs, before, 'utf-8');
          bumpSkillsCatalogGen();
          await contentFilter.rebuildIgnorePatterns();
          errorResponse(
            res,
            409,
            'urn:ok:error:invalid-request',
            `Adding "${line}" did not make ${skillFileRel} trackable — another .gitignore rule excludes a parent directory. ${gitignoreRel} was left unchanged.`,
            { handler: 'skill-track-in-git' },
          );
          return;
        }
        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillTrackInGitSuccessSchema,
          { line, gitignorePath: gitignoreRel, applied: true },
          { handler: 'skill-track-in-git' },
        );
      },
      { handler: 'skill-track-in-git', title: 'Failed to update .gitignore.' },
    ),
    { handler: 'skill-track-in-git', method: 'POST' },
  );

  const skillAdmissionHeal: SkillAdmissionHealState = { lastKey: null };

  const handleSkillsList = withValidation(
    EmptyRequestSchema,
    catchErrors(
      async (_req, res) => {
        const inPlaceFp =
          (contentFilter?.peekFreshInPlaceSkillDirsFingerprint() ?? '') +
          '\u0001' +
          (projectDir ? detectProjectSkillEditors(projectDir).join(',') : '') +
          '\u0001' +
          detectUserSkillHosts(skillsHome)
            .map((h) => h.editorId)
            .join(',') +
          '\u0001' +
          scanGlobalInPlaceSkills(skillsHome)
            .map((s) => s.dir)
            .sort()
            .join(',');
        if (skillsListCache !== null && skillsListCache.fp !== inPlaceFp) {
          bumpSkillsCatalogGen();
        }
        if (
          skillsListCache !== null &&
          skillsListCache.gen === skillsCatalogGen &&
          skillsListCache.fp === inPlaceFp &&
          Date.now() - skillsListCache.at < 5_000
        ) {
          successResponse(res, 200, SkillsListSuccessSchema, skillsListCache.body, {
            handler: 'skills-list',
          });
          return;
        }
        const projectSkillsRoot = resolveSkillsRoot('project');
        const project = resolveSkillsList(projectSkillsRoot, 'project');
        const globalSkills = resolveSkillsList(resolveSkillsRoot('global'), 'global');
        const projectInstallableEditors: string[] = projectDir
          ? detectProjectSkillEditors(projectDir)
          : [];
        const globalInstallableEditors: string[] = detectUserSkillHosts(skillsHome).map(
          (h) => h.editorId,
        );
        const projectHubOffered: boolean = projectDir
          ? isActivatedSkillRoot(projectDir, 'project', AGENTS_SKILLS_ROOT, skillsHome)
          : false;
        const globalHubOffered: boolean = isActivatedSkillRoot(
          skillsHome,
          'global',
          AGENTS_SKILLS_ROOT,
          skillsHome,
        );
        const projectInstalled = projectDir ? readInstalledSkills(projectDir).skills : {};
        const globalInstalled = readInstalledSkills(skillsHome).skills;
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
            const modified =
              entry?.localHash !== undefined &&
              localSkillHash(projectSkillsRoot, skill.name) !== entry.localHash;
            const revertable = entry?.baselineRef !== undefined;
            return {
              ...skill,
              installed: hosts.length > 0,
              hosts,
              ...(origin ? { origin } : {}),
              ...(modified ? { modified: true } : {}),
              ...(revertable ? { revertable: true } : {}),
            };
          });
        const placements = projectDir ? readSkillPlacements(projectDir) : {};
        const placementFlags = (
          baseDir: string,
          list: ReturnType<typeof readSkillPlacements>[string] | undefined,
          canonicalAbs?: string,
        ): { drift: string[] } => {
          const drift: string[] = [];
          for (const p of list ?? []) {
            const abs = resolve(baseDir, p.path);
            if (canonicalAbs !== undefined && abs === resolve(canonicalAbs)) continue;
            let isLink = false;
            try {
              isLink = lstatSync(abs).isSymbolicLink();
            } catch {
              continue;
            }
            if ((isLink ? 'link' : 'copy') === p.mode) continue;
            if (isLink && canonicalAbs !== undefined) {
              try {
                if (realpathSync(abs) === realpathSync(canonicalAbs)) continue;
              } catch {}
            }
            drift.push(p.path);
          }
          return { drift };
        };
        const projectAliases = projectDir ? scanHostRootAliases(contentDir, 'project') : {};
        const projectAliasRoots = aliasedSourceRoots(projectAliases, 'project');
        const underRoots = (path: string, roots: ReadonlySet<string>): boolean =>
          [...roots].some((r) => path === r || path.startsWith(`${r}/`));
        const detectedIdentity = resolveProjectIdentity(projectDir ?? contentDir);
        const pluginBaselines = openPluginBaselines(contentDir);
        const stdRootsProject = standardSkillRoots('project');
        const stdRootsGlobal = standardSkillRoots('global');
        const dropAliased = (
          list: ReturnType<typeof readSkillPlacements>[string] | undefined,
          aliasRoots: Set<string>,
        ): ReturnType<typeof readSkillPlacements>[string] =>
          (list ?? []).filter(
            (pl) => ![...aliasRoots].some((r) => pl.path === r || pl.path.startsWith(`${r}/`)),
          );
        const projectNameSeen = new Set<string>();
        const repoPlugins = readRepoMarketplacePlugins(contentDir);
        const repoPluginIdentity = (dir: string) => {
          const p = repoMarketplacePluginFor(repoPlugins, dir);
          return p
            ? {
                name: p.name,
                marketplace: p.marketplace,
                provider: 'claude',
                ...(p.url ? { url: p.url } : {}),
              }
            : null;
        };
        const inPlace = projectDir
          ? scanInPlaceSkills(contentDir).map((s) => {
              const tracked = !projectNameSeen.has(s.name);
              projectNameSeen.add(s.name);
              const skillAbsDir = resolve(contentDir, s.dir);
              const selfPlugin = tracked
                ? (pluginSelfIdentity(s.name, detectedIdentity, skillAbsDir) ??
                  repoPluginIdentity(skillAbsDir))
                : null;
              const entry =
                tracked && selfPlugin === null
                  ? (lock?.skills[s.name] ??
                    synthBuiltinLockEntry(contentDir, s.name) ??
                    synthPluginLockEntry(s.name, detectedIdentity, skillAbsDir))
                  : undefined;
              const origin = entry ? skillOrigin(entry) : undefined;
              const modified =
                entry?.localHash !== undefined
                  ? s.contentHash !== entry.localHash
                  : (() => {
                      if (!entry || !tracked) return false;
                      const up = pluginUpstreamHash(s.name, detectedIdentity);
                      return (
                        up !== null &&
                        pluginBaselines.isModified('project', s.name, s.contentHash, up)
                      );
                    })();
              return {
                name: s.name,
                ...(s.description ? { description: s.description } : {}),
                scope: 'project' as const,
                path: `${s.dir}/SKILL.md`,
                absolutePath: resolve(contentDir, s.dir, 'SKILL.md'),
                installed: true,
                hosts: [...s.hosts],
                size: s.size,
                installableEditors: projectInstallableEditors,
                hubOffered: projectHubOffered,
                ...(s.pack !== undefined ? { pack: s.pack } : {}),
                ...(s.linkedHosts.length > 0 ? { symlinkedHosts: [...s.linkedHosts] } : {}),
                ...(Object.keys(projectAliases).length > 0 ? { hostAliases: projectAliases } : {}),
                ...(s.conflictHosts.length > 0 ? { conflictHosts: [...s.conflictHosts] } : {}),
                ...(selfPlugin !== null ? { plugin: selfPlugin } : {}),
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
                ...(isInternalBundleSkillName(s.name) ? { managed: true as const } : {}),
              };
            })
          : [];
        const globalPlacements = readSkillPlacements(skillsHome);
        const globalLock = readSkillsLock(join(skillsHome, ...SKILLS_LOCK_REL));
        const globalAliases = scanHostRootAliases(skillsHome, 'global');
        const globalAliasRoots = aliasedSourceRoots(globalAliases, 'global');
        const globalInPlaceNames = new Set(scanGlobalInPlaceSkills(skillsHome).map((s) => s.name));
        globalSkills.skills = globalSkills.skills.filter((s) => !globalInPlaceNames.has(s.name));
        const globalNameSeen = new Set<string>();
        const globalInPlace = scanGlobalInPlaceSkills(skillsHome).map((s) => {
          const tracked = !globalNameSeen.has(s.name);
          globalNameSeen.add(s.name);
          const placementsForRow = tracked ? globalPlacements[s.name] : undefined;
          const defaultDir = resolveGlobalNativeSkillDir(skillsHome, s.name);
          const hostQualifier =
            defaultDir !== null && resolve(skillsHome, s.dir) !== resolve(defaultDir)
              ? s.hosts[0]
              : undefined;
          return {
            name: s.name,
            ...(s.description ? { description: s.description } : {}),
            scope: 'global' as const,
            path: `${s.dir}/SKILL.md`,
            absolutePath: resolve(skillsHome, s.dir, 'SKILL.md'),
            installed: true,
            hosts: [...s.hosts],
            ...(hostQualifier !== undefined ? { hostQualifier } : {}),
            size: s.size,
            installableEditors: globalInstallableEditors,
            hubOffered: globalHubOffered,
            ...(s.pack !== undefined ? { pack: s.pack } : {}),
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
              const globalAbsDir = resolve(skillsHome, s.dir);
              const selfPluginGlobal = pluginSelfIdentity(s.name, detectedIdentity, globalAbsDir);
              if (selfPluginGlobal !== null) return { plugin: selfPluginGlobal };
              const entry =
                globalLock.skills[s.name] ??
                synthBuiltinLockEntry(skillsHome, s.name) ??
                synthPluginLockEntry(s.name, detectedIdentity, globalAbsDir);
              if (!entry) return {};
              const globallyModified =
                entry.localHash !== undefined
                  ? s.contentHash !== entry.localHash
                  : (() => {
                      const up = pluginUpstreamHash(s.name, detectedIdentity);
                      return (
                        up !== null &&
                        pluginBaselines.isModified('global', s.name, s.contentHash, up)
                      );
                    })();
              return {
                origin: skillOrigin(entry),
                ...(globallyModified ? { modified: true } : {}),
              };
            })(),
          };
        });
        const inPlaceNamesEarly = new Set(inPlace.map((e) => e.name));
        const projectBuiltin =
          projectDir &&
          !project.skills.some((s) => s.name === BUILTIN_PROJECT_SKILL_NAME) &&
          !inPlaceNamesEarly.has(BUILTIN_PROJECT_SKILL_NAME)
            ? builtinSkillListEntry(projectDir, BUILTIN_PROJECT_SKILL_NAME, 'project')
            : null;
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
        const listed = [
          ...enrich(project, projectInstalled, true).filter((e) => !inPlaceNames.has(e.name)),
          ...inPlace,
          ...enrich(globalSkills, globalInstalled, false),
          ...globalInPlace,
          ...(projectBuiltin ? [projectBuiltin] : []),
          ...globalBuiltins,
        ];
        pluginBaselines.flush();
        const enriched = {
          skills: listed.map((entry) => {
            const canonicalPath =
              entry.scope === 'project' && entry.absolutePath
                ? indexedSkillContentPath(entry.absolutePath, contentDir)
                : null;
            const filePaths = entry.absolutePath
              ? listSkillBundledFilePaths(dirname(entry.absolutePath))
              : [];
            const withFiles = filePaths.length > 0 ? { ...entry, filePaths } : entry;
            const withCanonical =
              canonicalPath === null || canonicalPath === entry.path
                ? withFiles
                : { ...withFiles, canonicalPath };
            const openedPath = canonicalPath ?? entry.path;
            return entry.scope === 'project' && contentFilter?.isPathIgnored(openedPath) === true
              ? { ...withCanonical, ignored: true }
              : withCanonical;
          }),
          truncated: project.truncated || globalSkills.truncated,
        };
        const healed = await healUnservableSkillAdmission(
          inPlace.map((e) => e.path),
          contentFilter ?? null,
          skillAdmissionHeal,
        );
        const responseBody = !healed
          ? enriched
          : {
              ...enriched,
              skills: enriched.skills.map((entry) => {
                if (entry.scope !== 'project') return entry;
                const opened = (entry as { canonicalPath?: string }).canonicalPath ?? entry.path;
                const nowIgnored = contentFilter?.isPathIgnored(opened) === true;
                const wasIgnored = (entry as { ignored?: boolean }).ignored === true;
                if (nowIgnored === wasIgnored) return entry;
                if (nowIgnored) return { ...entry, ignored: true };
                const { ignored: _drop, ...rest } = entry as { ignored?: boolean } & typeof entry;
                return rest;
              }),
            };
        skillsListCache = {
          at: Date.now(),
          gen: skillsCatalogGen,
          fp: inPlaceFp,
          body: responseBody,
        };
        successResponse(res, 200, SkillsListSuccessSchema, responseBody, {
          handler: 'skills-list',
        });
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
              frontmatter: {
                name: typeof frontmatter.name === 'string' ? frontmatter.name : name,
                description:
                  typeof frontmatter.description === 'string' ? frontmatter.description : '',
              },
              body,
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
    if (contentFilter) {
      bumpSkillsCatalogGen();
      contentFilter.refreshInPlaceSkillDirs();
      scheduleDeferredIgnoreRebuild();
    }
    void recordDerivedDocumentBestEffort(docName, markdown, 'skill-put');
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
          const homeRel = resolveDefaultSkillHomeRel(putBase, body.scope);
          if (homeRel === null) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'No agent skill host is available.',
              { handler: 'skill-put', detail: 'NO_USABLE_SKILL_HOME' },
            );
            return;
          }
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
            attributeOkArtifactWrite(
              actor,
              `${homeRel}/${body.name}/SKILL`,
              `skill-create: ${homeRel}/${body.name}/SKILL.md`,
            );
            scheduleOkArtifactFlush('skill-put');
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
        const created = false;
        const dirRel = relative(putBase, existingAbs).split(sep).join('/');
        const relPath = `${dirRel}/SKILL.md`;
        const docName =
          body.scope === 'project' ? `${dirRel}/SKILL` : skillLiveDocName(body.scope, body.name);

        if (checkSkillDocConflictGate(docName, 'skill-put', res)) return;

        // CRDT write (precedent #24 / #38): route the full SKILL.md through the
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
          scheduleOkArtifactFlush('skill-put');
        }
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

  function effectiveSkillRoot(
    scope: 'project' | 'global',
    name: string,
    host?: string,
  ): { root: string; dirRel: string; realDir: string | null } {
    const base = scope === 'project' ? contentDir : skillsHome;
    const realDir = resolveSkillDirForRead(scope, name, host);
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
        const host = url.searchParams.get('host') ?? undefined;
        const { root: skillsRoot, dirRel, realDir } = effectiveSkillRoot(scope, name, host);
        if (host !== undefined && realDir === null) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-delete',
            detail: `No skill "${name}" (${scope}) in ${host}.`,
          });
          return;
        }

        const actor = extractActorIdentityFromQuery(url, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-delete',
          });
          return;
        }

        await captureAndCloseDocuments(
          scope === 'project'
            ? [...new Set([`${dirRel}/SKILL`, skillLiveDocName(scope, name)])]
            : [skillLiveDocName(scope, name, host)],
          'deleted-upstream',
        );

        if (host === undefined) sweepSkillOccurrences(scope, name);
        const result = applySkillDelete({ skillsRoot, name });
        const storeRoot = resolveSkillsRoot(scope);
        if (
          host === undefined &&
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
        if (result.existed) {
          if (scope === 'project') {
            attributeOkArtifactWrite(actor, dirRel, `skill-delete: ${dirRel}`);
            bumpSkillsCatalogGen();
            void commitOkArtifactWrite('skill-delete');
          }
          signalChannel?.('files');
        }
        const uninstallBase = skillInstallBase(scope);
        if (host === undefined && uninstallBase) {
          await uninstallSkillFromHostDirs(uninstallBase, name, scope);
        }
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

        await captureAndCloseDocuments(
          body.scope === 'project'
            ? [...new Set([`${fromDirRel}/SKILL`, skillLiveDocName(body.scope, body.fromName)])]
            : [skillLiveDocName(body.scope, body.fromName)],
          'renamed',
        );

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
        } catch {}
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

        if (body.scope === 'project' && !contentEditError) {
          bumpSkillsCatalogGen();
          contentFilter?.refreshInPlaceSkillDirs();
          void reindexMovedProjectSkillDocs(skillsRoot, body.fromName, body.toName)
            .then(() => reindexRewrittenSkillRefDocs(refRewrites, body.toName))
            .catch(() => {});
          scheduleDeferredIgnoreRebuild();
        }

        const fromKeyPath = skillRelPath(resolve(skillsRoot, body.fromName), body.scope);
        const toKeyPath = skillRelPath(resolve(skillsRoot, body.toName), body.scope);
        const renamedLocalHash = localSkillHash(skillsRoot, body.toName);
        await rekeySkillLockEntry(body.scope, body.fromName, body.toName, {
          localHash: renamedLocalHash,
        });
        if (body.scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.toName),
            `skill-rename: ${fromKeyPath} -> ${toKeyPath}`,
            [{ from: fromKeyPath, to: toKeyPath }],
          );
          void (async () => {
            try {
              await commitOkArtifactWrite('skill-move');
              const baselineRef = await shadowHeadSha(artifactWriterId(actor), toKeyPath);
              if (baselineRef !== undefined) {
                await updateSkillLockEntry('project', body.toName, { baselineRef });
              }
            } catch (err) {
              getLogger('skill-move').warn(
                { err, toName: body.toName },
                'deferred shadow flush / revert-baseline failed — Revert stays unarmed until the next flush',
              );
            }
          })();
        }

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
        if (isInternalBundleSkillName(name)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            `"${name}" is a built-in skill and always lives at its own scope.`,
            { handler: 'skill-move-scope', detail: 'BUILTIN_SCOPE_FIXED' },
          );
          return;
        }
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
        const fromContentDir = (() => {
          try {
            return realpathSync(fromDir);
          } catch {
            return fromDir;
          }
        })();
        const toBase2 = toScope === 'project' ? contentDir : skillsHome;
        const toHomeRel = resolveDefaultSkillHomeRel(toBase2, toScope);
        if (toHomeRel === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'No agent skill host is available in the destination scope.',
            { handler: 'skill-move-scope', detail: 'NO_USABLE_SKILL_HOME' },
          );
          return;
        }
        const toRoot = resolve(toBase2, toHomeRel);
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

        const fromBase = skillInstallBase(fromScope);
        const toBase = skillInstallBase(toScope);
        const priorInstall = fromBase ? readInstalledSkills(fromBase).skills[name] : undefined;
        const fromScanBase = fromScope === 'project' ? contentDir : skillsHome;
        const scanEntry = (
          fromScope === 'project'
            ? scanInPlaceSkills(contentDir)
            : scanGlobalInPlaceSkills(skillsHome)
        ).find((sk) => sk.name === name);
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

        tracedMkdirSync(toRoot, { recursive: true });
        tracedCpSync(fromContentDir, toDir, { recursive: true, dereference: true });

        sweepSkillOccurrences(fromScope, name);
        const del = applySkillDelete({ skillsRoot: fromRoot, name });
        if (del.ok && fromContentDir !== fromDir) {
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

        if (fromBase) {
          await uninstallSkillFromHostDirs(
            fromBase,
            name,
            fromScope,
            scanEntry ? { purge: { contentHash: scanEntry.contentHash } } : {},
          );
        }
        if (fromBase) await clearSkillPlacements(fromBase, name);
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

        if (movedLockEntry) {
          const movedLocalHash = localSkillHash(toRoot, name);
          await updateSkillLockEntry(toScope, name, { localHash: movedLocalHash });
        }
        if (fromScope === 'project' || toScope === 'project') {
          attributeOkArtifactWrite(
            actor,
            fromScope === 'project' ? fromDirRel : relative(contentDir, toDir).split(sep).join('/'),
            `skill-move-scope: ${fromScope} -> ${toScope} ${name}`,
          );
          const toKeyForBaseline = relative(contentDir, toDir).split(sep).join('/');
          const wantBaseline = Boolean(movedLockEntry) && toScope === 'project';
          void (async () => {
            try {
              await commitOkArtifactWrite('skill-move-scope');
              if (wantBaseline) {
                const baselineRef = await shadowHeadSha(artifactWriterId(actor), toKeyForBaseline);
                if (baselineRef !== undefined) {
                  await updateSkillLockEntry(toScope, name, { baselineRef });
                }
              }
            } catch (err) {
              getLogger('skill-move-scope').warn(
                { err, name },
                'deferred shadow flush / revert-baseline failed — Revert stays unarmed until the next flush',
              );
            }
          })();
        }

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

        bumpSkillsCatalogGen();
        contentFilter?.refreshInPlaceSkillDirs();
        scheduleDeferredIgnoreRebuild();

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
        const targetHomeRel = resolveDefaultSkillHomeRel(base, body.scope);
        if (targetHomeRel === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'No agent skill host is available.',
            { handler: 'skill-duplicate', detail: 'NO_USABLE_SKILL_HOME' },
          );
          return;
        }
        const targetRoot = resolve(base, targetHomeRel);
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
          void commitOkArtifactWrite('skill-duplicate');
        }
        signalChannel?.('files');
        bumpSkillsCatalogGen();
        contentFilter?.refreshInPlaceSkillDirs();
        scheduleDeferredIgnoreRebuild();

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

  function classifySkillFilePath(rel: string): 'reference' | 'script' | 'file' | null {
    if (rel.includes('\x00')) return null;
    const segments = rel
      .replace(/\\/g, '/')
      .split('/')
      .filter((s) => s !== '' && s !== '.');
    if (segments.length < 1 || segments.some((s) => s === '..')) return null;
    if (segments.length === 1 && (segments[0] as string).toLowerCase() === 'skill.md') return null;
    if (segments[0] === 'references' && segments.length >= 2) return 'reference';
    if (segments[0] === 'scripts' && segments.length >= 2) return 'script';
    return 'file';
  }

  function isProjectMdReference(
    scope: 'project' | 'global',
    kind: 'reference' | 'script' | 'file',
    rel: string,
  ): boolean {
    return scope === 'project' && kind === 'reference' && rel.toLowerCase().endsWith('.md');
  }

  function nestedProjectRefDocNames(realDir: string, dirRel: string): string[] {
    const base = resolve(realDir, dirRel);
    const dirDocPrefix = relative(contentDir, realDir).split(sep).join('/');
    let entries: string[];
    try {
      entries = readdirSync(base, { recursive: true, encoding: 'utf-8' });
    } catch {
      return [];
    }
    return entries
      .filter((e) => /\.md$/i.test(e))
      .map((e) => `${dirDocPrefix}/${dirRel}/${e.split(sep).join('/').replace(/\.md$/i, '')}`);
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

  async function reindexMovedProjectSkillDocs(
    skillsRoot: string,
    fromName: string,
    toName: string,
  ): Promise<void> {
    if (!derivedDocumentIndex) {
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

    const rootRel = relative(contentDir, skillsRoot).split(sep).join('/');
    const docFor = (n: string, rel?: string): string =>
      `${rootRel}/${n}/${rel ? rel.replace(/\.mdx?$/i, '') : 'SKILL'}`;
    collectReindex(docFor(fromName), docFor(toName), resolve(skillsRoot, toName, 'SKILL.md'));
    for (const rel of listProjectMdReferences(skillsRoot, toName)) {
      collectReindex(docFor(fromName, rel), docFor(toName, rel), resolve(skillsRoot, toName, rel));
    }
    await derivedDocumentIndex.recordDirectMutations(derivedMutations);
  }

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
        const builtinBase = isInternalBundleSkillName(name)
          ? scope === 'global'
            ? skillsHome
            : projectDir
          : undefined;
        const builtinHost = url.searchParams.get('host') ?? undefined;
        const builtin = builtinBase ? resolveBuiltinSkillDir(builtinBase, name, builtinHost) : null;
        if (rel === '' || rel.includes('\x00')) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid skill file path.', {
            handler: 'skill-file-get',
          });
          return;
        }
        const kind =
          (builtin && rel === 'SKILL.md' ? 'reference' : classifySkillFilePath(rel)) ?? 'reference';
        const host = builtinHost;
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
          // primitive (precedent #24 / #38), same branch as the SKILL.md body.
          const refDocName = `${skillDirRel}/${rel.replace(/\.mdx?$/i, '')}`;
          if (checkSkillDocConflictGate(refDocName, 'skill-file-put', res)) return;
          created = !existsSync(resolve(skillDirAbs, rel));
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

        if (body.scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.name),
            `${created ? 'skill-file-create' : 'skill-file-edit'}: ${skillDirRel}/${rel}`,
          );
          void commitOkArtifactWrite('skill-file-put');
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
        const realDir = resolveSkillDirForRead(scope, name);
        const skillsRoot = realDir !== null ? dirname(realDir) : resolveSkillsRoot(scope);

        const bundleAbs = resolve(realDir ?? join(skillsRoot, name), rel);
        if (existsSync(bundleAbs) && isProjectMdReference(scope, kind, rel)) {
          const extLess = rel.replace(/\.md$/i, '');
          const refDoc =
            realDir !== null
              ? `${relative(contentDir, realDir).split(sep).join('/')}/${extLess}`
              : projectRefContentDocName(name, rel);
          await captureAndCloseDocuments([refDoc], 'deleted-upstream');
        } else if (
          scope === 'project' &&
          realDir !== null &&
          existsSync(bundleAbs) &&
          statSync(bundleAbs).isDirectory()
        ) {
          const docs = nestedProjectRefDocNames(realDir, rel);
          if (docs.length > 0) await captureAndCloseDocuments(docs, 'deleted-upstream');
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
            `skill-file-delete: ${
              realDir !== null
                ? `${relative(contentDir, realDir).split(sep).join('/')}/${rel}`
                : `${name}/${rel}`
            }`,
          );
          void commitOkArtifactWrite('skill-file-delete');
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

        if (
          fromDocName !== null &&
          checkSkillDocConflictGate(fromDocName, 'skill-file-rename', res)
        )
          return;
        if (fromDocName !== null) {
          await captureAndCloseDocuments([fromDocName], 'deleted-upstream');
        } else if (body.scope === 'project') {
          const fromAbs = resolve(realDir, from);
          if (existsSync(fromAbs) && statSync(fromAbs).isDirectory()) {
            const docs = nestedProjectRefDocNames(realDir, from);
            if (docs.length > 0) await captureAndCloseDocuments(docs, 'deleted-upstream');
          }
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
            } catch {}
          }
          await recordDerivedMutationsBestEffort(mutations, 'skill-file-rename');
        }

        if (body.scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.name),
            `skill-file-rename: ${body.name}/${from} -> ${to}`,
          );
          void commitOkArtifactWrite('skill-file-rename');
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

  function publisherFromSource(source: string): string | undefined {
    const m = /github\.com[/:]([\w.-]+)\//.exec(source);
    return m ? m[1] : undefined;
  }

  const readSkillsLock = readSkillsLockFile;
  function localSkillHash(skillsRoot: string, name: string): string | undefined {
    return parseSkillDir(resolve(skillsRoot, name))?.contentHash;
  }
  async function shadowHeadSha(
    writerId?: string,
    verifyPathRel?: string,
  ): Promise<string | undefined> {
    const shadow = shadowRef?.current;
    if (!shadow || !writerId) return undefined;
    // (`refs/wip/<branch>/<writerId>`, precedent #25). `commitOkArtifactWrite` has
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
  const artifactWriterId = (actor: ReturnType<typeof extractActorIdentity>): string | undefined =>
    actor.kind === 'agent' || actor.kind === 'principal' ? actor.writerId : undefined;
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

  const skillReimportService = createSkillReimportService({
    contentDir,
    skillsHome,
    ...(projectDir !== undefined ? { projectDir } : {}),
    legacyStoreRoot: LEGACY_SKILL_STORE_ROOT,
    effectiveSkillRoot,
    parseFrontmatterDoc,
    attributeOkArtifactWrite,
    commitOkArtifactWrite,
    shadowHeadSha,
    artifactWriterId,
    skillArtifactKey: (name) => okArtifactKey('skill', '', name),
    captureAndCloseDocuments,
    projectImportedSkillCopy,
    signalFiles: () => signalChannel?.('files'),
  });

  function respondSkillReimport(res: ServerResponse, outcome: SkillReimportOutcome): void {
    if (outcome.ok) {
      successResponse(res, 200, SkillReimportSuccessSchema, outcome.body, {
        handler: 'skill-reimport',
      });
      return;
    }
    errorResponse(res, outcome.status, outcome.urn, outcome.title, {
      handler: 'skill-reimport',
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
    });
  }

  function packBundleDir(scope: 'project' | 'global', name: string, skillsRoot: string): string {
    const base = scope === 'project' ? contentDir : skillsHome;
    const found = (
      scope === 'project' ? scanInPlaceSkills(contentDir) : scanGlobalInPlaceSkills(skillsHome)
    ).find((s) => s.name === name);
    return found ? resolve(base, found.dir) : resolve(skillsRoot, name);
  }

  function resolveReimportLockEntry(
    scope: 'project' | 'global',
    name: string,
    skillsRoot: string,
    lock: SkillsLock,
  ): SkillsLock['skills'][string] | null {
    const recorded = lock.skills[name];
    if (recorded) return recorded;
    const bundleDir = packBundleDir(scope, name, skillsRoot);
    return (
      retrofitPackLockEntry(
        name,
        parseSkillDir(bundleDir)?.contentHash ?? '',
        new Date().toISOString(),
        { selfIdentifiesAsPack: bundleSelfIdentifiesAsPack(bundleDir) },
      ) ??
      synthBuiltinLockEntry(scope === 'global' ? skillsHome : contentDir, name) ??
      synthPluginLockEntry(name, resolveProjectIdentity(projectDir ?? contentDir), bundleDir)
    );
  }
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

        let acquiredDir: string | null = null;
        let sourceLabel: string;
        let ref: string | undefined;
        let publisher: string | undefined;
        let upstreamSkill: string | undefined;
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
              const found =
                dirs.find((d) => d.name === selectedSkill) ??
                dirs.find((d) => readSkillDirMeta(d.dir)?.name === selectedSkill) ??
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
        if (
          outcome.ok &&
          (body.marketplace === true || isOpenKnowledgeSkillsSource(resolvedSourceForReport))
        ) {
          void reportSkillInstall(
            { source: resolvedSourceForReport, skills: [outcome.body.name] },
            resolveSkillInstallReportSettings(),
          );
        }
        bumpSkillsCatalogGen();
        contentFilter?.refreshInPlaceSkillDirs();
        scheduleDeferredIgnoreRebuild();
        signalChannel?.('files');

        respondSkillImport(res, outcome);
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to import skill.', {
          handler: 'skill-import',
          cause: e,
        });
      } finally {
        cleanup();
      }
    },
    { handler: 'skill-import', method: 'POST' },
  );

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
        let siteSpec: (SourceSpec & { kind: 'well-known' }) | null = null;
        let siteIndex: WellKnownIndex | null = null;
        let dirs: ReturnType<typeof discoverSkillDirs> = [];
        let ref: string | undefined;
        let publisher: string | undefined;
        let resolvedSourceForReport = rawSource;
        try {
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
              results.push({
                requested,
                status: e instanceof SkillFetchError ? 'not-found' : 'failed',
                warnings: [],
                ...(e instanceof SkillFetchError ? {} : { error: String(e) }),
              });
              continue;
            }
          } else {
            const found =
              dirs.find((d) => d.name === requested) ??
              dirs.find((d) => parseSkillDir(d.dir)?.name === requested) ??
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
        if (body.marketplace === true || isOpenKnowledgeSkillsSource(resolvedSourceForReport)) {
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
        bumpSkillsCatalogGen();
        contentFilter?.refreshInPlaceSkillDirs();
        scheduleDeferredIgnoreRebuild();
        signalChannel?.('files');

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
        cleanup();
      }
    },
    { handler: 'skills-import-bulk', method: 'POST' },
  );

  const UPLOAD_MAX_FILES = 200;
  const UPLOAD_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
  const UPLOAD_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

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

  function readSkillUploadParts(req: IncomingMessage): Promise<UploadedPart[]> {
    return new Promise((resolveP, reject) => {
      let bb: MultipartParser;
      try {
        bb = createMultipartParser(req, {
          files: UPLOAD_MAX_FILES,
          fields: 10,
          fieldSize: 2 * 1024,
          fileSize: UPLOAD_MAX_ENTRY_BYTES,
        });
      } catch (err) {
        reject(err);
        return;
      }
      const parts: UploadedPart[] = [];
      let total = 0;
      let aborted: Error | null = null;
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
          } catch {}
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

  async function handleSkillUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const tmp = mkdtempSync(join(tmpdir(), 'ok-skill-upload-'));
    const cleanup = () => {
      try {
        tracedRmSync(tmp, { recursive: true, force: true });
      } catch {}
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

        const storeSkillDir = resolve(skillsRoot, body.name);
        const inPlaceScanBase = body.scope === 'project' ? contentDir : skillsHome;
        const inPlaceEntry = (
          body.scope === 'project'
            ? scanInPlaceSkills(contentDir)
            : scanGlobalInPlaceSkills(skillsHome)
        ).find((s) => s.name === body.name);
        const bundleSource = isInternalBundleSkillName(body.name)
          ? shippedBundleSkillMd(body.name, body.scope)
          : null;
        const skillDir = inPlaceEntry
          ? resolve(inPlaceScanBase, inPlaceEntry.dir)
          : existsSync(storeSkillDir) || bundleSource === null
            ? storeSkillDir
            : dirname(bundleSource);
        if (!existsSync(skillDir)) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-install',
            detail: `Skill "${body.name}" not found in ${body.scope} scope — create it with write({ skill }) first.`,
          });
          return;
        }

        const liveSkillDoc =
          body.scope === 'project'
            ? `${relative(inPlaceScanBase, skillDir).split(sep).join('/')}/SKILL`
            : skillLiveDocName(body.scope, body.name);
        await flushDiskAndDetectOutcome(liveSkillDoc);

        const validity = validateSkillForInstall(skillDir, body.name, {
          allowReservedName: isInternalBundleSkillName(body.name),
        });
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
          bumpSkillsCatalogGen();
          contentFilter?.refreshInPlaceSkillDirs();
          scheduleDeferredIgnoreRebuild();
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

        const setSourceReq = body.setSource ?? body.source;
        const linkModeReq =
          body.linkMode ?? (body.mode !== undefined ? body.mode === 'link' : undefined);
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
          bumpSkillsCatalogGen();
          contentFilter?.refreshInPlaceSkillDirs();
          scheduleDeferredIgnoreRebuild();
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

        if (body.place) {
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
          bumpSkillsCatalogGen();
          contentFilter?.refreshInPlaceSkillDirs();
          scheduleDeferredIgnoreRebuild();
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
          bumpSkillsCatalogGen();
          contentFilter?.refreshInPlaceSkillDirs();
          scheduleDeferredIgnoreRebuild();
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

        const targets: EditorId[] =
          body.scope === 'global'
            ? targetsReq !== undefined
              ? USER_SKILL_EDITOR_IDS.filter((id) => targetsReq?.some((t) => t === id))
              : detectUserSkillHosts(skillsHome).map((host) => host.editorId)
            : targetsReq !== undefined
              ? PROJECT_SKILL_EDITOR_IDS.filter((id) => targetsReq?.some((t) => t === id))
              : resolveSkillTargets(base);
        const warnings: string[] = [];
        const warningCodes: SkillInstallWarningCode[] = [];
        if (targets.length === 0 && targetsReq === undefined) {
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
        if (validity.warnings.length > 0) {
          warnings.push(validity.warnings[0]);
          warningCodes.push('no-description');
        }

        if (inPlaceEntry) {
          const canonicalRootRel = inPlaceEntry.dir.split('/').slice(0, -1).join('/');
          const hubTargeted =
            targetsReq !== undefined
              ? targetsReq.includes('agents')
              : body.scope === 'global' && existsSync(join(skillsHome, '.agents'));
          const inPlaceTargets: SkillHostId[] = hubTargeted ? [...targets, 'agents'] : [...targets];
          const prefBase = body.scope === 'project' ? projectDir : skillsHome;
          const installMode: 'copy' | 'link' =
            linkModeReq !== undefined
              ? linkModeReq
                ? 'link'
                : 'copy'
              : effectiveInstallMode(body.scope, body.name, inPlaceEntry);
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

        const priorHosts = resolvedHosts(readInstalledSkills(base).skills[body.name]?.hosts ?? []);
        const dropped = priorHosts.filter((h) => !targets.includes(h));
        if (dropped.length > 0)
          reverseProjectSkill(body.name, base, dropped, skillProjectionRoots(body.scope));
        const lockPathForInstall = join(base, ...SKILLS_LOCK_REL);
        const lockRawForInstall = existsSync(lockPathForInstall)
          ? readFileSync(lockPathForInstall, 'utf-8')
          : null;
        const lockForInstall =
          lockRawForInstall !== null ? parseSkillsLock(lockRawForInstall) : null;
        if (lockRawForInstall !== null && lockForInstall === null) {
          log.warn(
            { skill: body.name },
            'skills-lock.json failed to parse — projecting as symlink (import origin unknown)',
          );
        }
        const isAcquired = lockForInstall?.skills[body.name] !== undefined;
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
          respondSkillRestoreFailure(res, result, 'skill-restore');
          return;
        }

        const warnings: string[] = [];
        const skillDir = resolve(contentDir, projectSkillDirRel(body.name));
        const validity = validateSkillForInstall(skillDir, body.name);
        if (!validity.ok) {
          warnings.push(
            `Restored, but the skill no longer validates: ${validity.errors.join(' ')}`,
          );
        }

        attributeOkArtifactWrite(
          actor,
          okArtifactKey('skill', '', body.name),
          `skill-restore: ${body.name} @ ${body.version.slice(0, 8)}`,
        );
        await commitOkArtifactWrite('skill-restore');
        signalChannel?.('files');
        bumpSkillsCatalogGen();
        contentFilter?.refreshInPlaceSkillDirs();
        scheduleDeferredIgnoreRebuild();

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

        const reimportBase = body.scope === 'global' ? skillsHome : contentDir;
        const {
          root: skillsRoot,
          dirRel: skillDirRel,
          realDir: reimportRealDir,
        } = effectiveSkillRoot(body.scope, body.name);
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
        const entry = resolveReimportLockEntry(
          body.scope,
          body.name,
          skillsRoot,
          readSkillsLock(lockPath),
        );
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
          bumpSkillsCatalogGen();
          contentFilter?.refreshInPlaceSkillDirs();
          scheduleDeferredIgnoreRebuild();

          successResponse(
            res,
            200,
            SkillReimportSuccessSchema,
            { name: body.name, updated: false, source: entry.source, warnings: [] },
            { handler: 'skill-reimport' },
          );
          return;
        }
        let ref: string | undefined;
        let acquiredDir: string | null = null;
        try {
          const recordedSkill = entry.skill ?? body.name;
          const renamedSkill = RENAMED_PACK_SKILLS[recordedSkill];
          const skillsSh = await resolveSkillsShImportSource(entry.source, recordedSkill).catch(
            async (err: unknown) => {
              if (renamedSkill === undefined) throw err;
              return resolveSkillsShImportSource(entry.source, renamedSkill);
            },
          );
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
          const pick = pickReimportDir(dirs, {
            ...(resolvedSkill !== undefined ? { recordedSkill: resolvedSkill } : {}),
            localName: body.name,
            frontmatterNameOf: (dir) => parseSkillDir(dir)?.name,
          });
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
          acquiredDir = pick.dir;
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
        if (!acquiredDir) {
          errorResponse(res, 422, 'urn:ok:error:invalid-request', 'Source has no readable skill.', {
            handler: 'skill-reimport',
          });
          return;
        }
        const outcome = await skillReimportService.runSkillReimport({
          acquiredDir,
          name: body.name,
          scope: body.scope,
          entry,
          lockPath,
          ref,
          actor,
          ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
        });
        bumpSkillsCatalogGen();
        contentFilter?.refreshInPlaceSkillDirs();
        scheduleDeferredIgnoreRebuild();

        respondSkillReimport(res, outcome);
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

  const handleSkillsReimportBulk = withValidation(
    SkillsReimportBulkRequestSchema,
    async (_req, res, body) => {
      try {
        if (body.scope === 'project' && !projectDir) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project root resolved.', {
            handler: 'skills-reimport-bulk',
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
            handler: 'skills-reimport-bulk',
          });
          return;
        }
        const lockPath = join(
          body.scope === 'global' ? skillsHome : (projectDir as string),
          ...SKILLS_LOCK_REL,
        );
        const lock = readSkillsLock(lockPath);
        const results: SkillReimportBulkResult[] = [];
        const named = new Set(body.names);
        const wellFormed = [...named].filter((name) => {
          if (isValidSkillName(name)) return true;
          results.push({ requested: name, status: 'failed', warnings: [], error: 'INVALID_NAME' });
          return false;
        });
        const { bySource, unrecorded } = groupReimportNamesBySource(wellFormed, (name) =>
          resolveReimportLockEntry(
            body.scope,
            name,
            effectiveSkillRoot(body.scope, name).root,
            lock,
          ),
        );
        for (const name of unrecorded) {
          results.push({ requested: name, status: 'not-found', warnings: [] });
        }

        for (const group of bySource) {
          let cleanup: () => void = () => {};
          try {
            let ref: string | undefined;
            let dirs: ReturnType<typeof discoverSkillDirs> = [];
            try {
              const probe = group.names[0] as string;
              const skillsSh = await resolveSkillsShImportSource(group.source, probe).catch(
                async (err: unknown) => {
                  const renamed = RENAMED_PACK_SKILLS[probe];
                  if (renamed === undefined) throw err;
                  return resolveSkillsShImportSource(group.source, renamed);
                },
              );
              const resolvedSource =
                skillsSh?.source ??
                resolvePluginUpdateSource(
                  group.source,
                  lock.skills[group.names[0] as string]?.pluginProvider,
                );
              const spec = skillsSh?.spec ?? parseSource(resolvedSource);
              if (!spec || isDisallowedGitSpec(spec)) {
                for (const name of group.names) {
                  results.push({
                    requested: name,
                    status: 'failed',
                    source: group.source,
                    warnings: [],
                    error: 'INVALID_SOURCE',
                  });
                }
                continue;
              }
              const fetched = await fetchSource(spec);
              cleanup = fetched.cleanup;
              ref = fetched.ref;
              dirs = discoverSkillDirs(fetched.dir);
            } catch (e) {
              getLogger('skills-reimport-bulk').warn(
                { source: group.source, err: e, requestId: getRequestId(_req) },
                'bulk update: one source could not be fetched (rest continue)',
              );
              for (const name of group.names) {
                results.push({
                  requested: name,
                  status: 'failed',
                  source: group.source,
                  warnings: [],
                  error: e instanceof Error ? e.message : String(e),
                });
              }
              continue;
            }
            for (const name of group.names) {
              const entry = resolveReimportLockEntry(
                body.scope,
                name,
                effectiveSkillRoot(body.scope, name).root,
                lock,
              );
              if (!entry) {
                results.push({ requested: name, status: 'not-found', warnings: [] });
                continue;
              }
              const pick = pickReimportDir(dirs, {
                ...(entry.skill !== undefined ? { recordedSkill: entry.skill } : {}),
                localName: name,
                frontmatterNameOf: (dir) => parseSkillDir(dir)?.name,
              });
              if (!pick) {
                results.push({
                  requested: name,
                  status: 'not-found',
                  source: entry.source,
                  warnings: [],
                });
                continue;
              }
              try {
                const outcome = await skillReimportService.runSkillReimport({
                  acquiredDir: pick.dir,
                  name,
                  scope: body.scope,
                  entry,
                  lockPath,
                  ref,
                  actor,
                });
                if (!outcome.ok) {
                  getLogger('skills-reimport-bulk').warn(
                    {
                      skill: name,
                      err: outcome.cause,
                      detail: outcome.detail,
                      requestId: getRequestId(_req),
                    },
                    'bulk update: one skill failed (rest continue)',
                  );
                  results.push({
                    requested: name,
                    status: 'failed',
                    source: entry.source,
                    warnings: [],
                    error: outcome.detail ?? outcome.title,
                  });
                  continue;
                }
                results.push({
                  requested: name,
                  status: outcome.body.updated ? 'updated' : 'up-to-date',
                  source: outcome.body.source,
                  warnings: outcome.body.warnings,
                });
              } catch (e) {
                getLogger('skills-reimport-bulk').warn(
                  { skill: name, err: e, requestId: getRequestId(_req) },
                  'bulk update: one skill threw (rest continue)',
                );
                results.push({
                  requested: name,
                  status: 'failed',
                  source: entry.source,
                  warnings: [],
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }
          } finally {
            cleanup();
          }
        }
        successResponse(
          res,
          200,
          SkillsReimportBulkSuccessSchema,
          {
            results,
            updated: results.filter((r) => r.status === 'updated').length,
            upToDate: results.filter((r) => r.status === 'up-to-date').length,
            failed: results.filter((r) => r.status === 'failed' || r.status === 'not-found').length,
          },
          { handler: 'skills-reimport-bulk' },
        );

        try {
          bumpSkillsCatalogGen();
          contentFilter?.refreshInPlaceSkillDirs();
          bumpSkillsCatalogGen();
          await contentFilter?.rebuildIgnorePatterns();
        } catch (e) {
          getLogger('skills-reimport-bulk').warn(
            { err: e },
            'bulk update: ignore-pattern rebuild failed after a reported success',
          );
        }
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to update skills.', {
          handler: 'skills-reimport-bulk',
          cause: e,
        });
      }
    },
    { handler: 'skills-reimport-bulk', method: 'POST' },
  );

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

        const revertRoot = resolve(contentDir, projectSkillDirRel(body.name), '..');
        const revertedLocalHash = localSkillHash(revertRoot, body.name);
        await mutateSkillsLock(lockPath, (current) =>
          upsertLockEntry(current, body.name, {
            ...(current.skills[body.name] ?? entry),
            ...(revertedLocalHash !== undefined ? { localHash: revertedLocalHash } : {}),
          }),
        );

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

  let lintConfigEpoch = 0;
  function signalLintConfigChanged(): void {
    lintConfigEpoch += 1;
    signalChannel?.('lint-config');
  }

  const readAuditGeneration = (): string =>
    `${lintConfigEpoch} ${durabilityState.getActiveBranch()} ${
      derivedDocumentIndex?.readLocalTargetGeneration?.() ?? 0
    }`;

  const LINT_VIOLATION_CAP = 10;
  async function computeLintViolations(
    source: string,
    docName: string,
  ): Promise<LintViolationWarning[]> {
    const base = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
    try {
      const effective = resolveEffectiveLinterConfig(contentDir, base, {
        docName,
        projectDir: projectDir ?? contentDir,
        onProblem: (problem) => log.warn({ problem, docName }, '[lint] native config problem'),
      });
      const lintFindings = await lintDocument(source, effective, docName);

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

  function unmatchedGlobProblems(effective: LinterConfig): string[] {
    const slice = effective.plugins.frontmatter;
    if (!slice.enabled || slice.schemas.length === 0) return [];
    const docFiles = collectDocFiles({ projectDir: projectDir ?? contentDir, contentDir });
    return unmatchedAppliesToProblems(slice.schemas, docFiles);
  }

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

  const handleWriteFrontmatterSchema = withValidation(
    FrontmatterSchemaWriteRequestSchema,
    async (_req, res, body) => {
      let writeResult: WriteFrontmatterSchemaResult;
      try {
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

  const handleLintFix = withValidation(
    LintFixRequestSchema,
    async (_req, res, body) => {
      try {
        const effectiveDocName = requireNonEmptyDocName(body.docName, res, 'lint-fix');
        if (effectiveDocName === null) return;
        const resolvedDocName = resolveAlias(effectiveDocName);

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
        assertNoSymlinkEscape(resolve(contentDir, docRelPath), contentDir);

        const baseConfig = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const { stored: storedSummary } = summaryResponseFields(actor.summary);
        const session = await sessionManager.getSession(resolvedDocName, agentId, {
          displayName: agentName,
          colorSeed,
          clientName,
        });

        const source = session.dc.document.getText('source').toString();
        const configWarnings: string[] = [];
        const { cfg, before, fixed, ran, failures } = await lintAndFixSource({
          projectDir: projectDir ?? contentDir,
          contentDir,
          baseConfig,
          docRelPath,
          source,
          onConfigProblem: (problem) => configWarnings.push(problem),
        });

        let after = before;
        let reLintWarning: string | undefined;
        const reLintFailures: LintPluginFailure[] = [];
        if (fixed !== source) {
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

          try {
            after = await lintDocument(
              session.dc.document.getText('source').toString(),
              cfg,
              docRelPath,
              (failure) => reLintFailures.push(failure),
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
        const fixedCount = Math.max(0, before.length - after.length);
        const responseWarnings = [
          ...configWarnings,
          ...summarizeLintPluginFailures([...failures, ...reLintFailures]),
          ...(reLintWarning ? [reLintWarning] : []),
        ];

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
            ran,
            ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
            ...(reLintWarning ? { warning: reLintWarning } : {}),
          },
          { handler: 'lint-fix' },
        );
      } catch (e) {
        if (isContainmentRejection(e)) {
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

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    '/api/asset': handleAsset,
    '/api/asset-text': handleAssetText,
    '/api/skill': handleSkill,
    '/api/skill-file': handleSkillFile,
    '/api/skill-file/rename': handleSkillFileRename,
    '/api/skills': handleSkillsList,
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
    '/api/skills/reimport-bulk': handleSkillsReimportBulk,
    '/api/skill/revert': handleSkillRevert,
    '/api/skill/track-in-git': handleSkillTrackInGit,
    '/api/lint/markdownlint-config': handleWriteMarkdownlintRule,
    '/api/lint/frontmatter-schema': handleWriteFrontmatterSchema,
    '/api/lint/fix': handleLintFix,
    '/api/agent-write': handleAgentWrite,
    '/api/agent-write-md': handleAgentWriteMd,
    '/api/agent-write-batch': handleAgentWriteBatch,
    '/api/frontmatter-patch': handleFrontmatterPatch,
    '/api/agent-patch': handleAgentPatch,
    '/api/agent-undo': handleAgentUndo,
    '/api/agent-activity': handleAgentActivity,
    '/api/agent-burst-diff': handleAgentBurstDiff,
    '/api/save-version': handleSaveVersion,
    '/api/rollback': handleRollback,
    '/api/install-skill': handleInstallSkill,
  };

  if (enableTestRoutes) {
    routes['/api/test-reset'] = handleTestReset;
    routes['/api/test-flush-git'] = handleTestFlushGit;
    routes['/api/test-rescan-backlinks'] = handleTestRescanBacklinks;
    routes['/api/test-rescan-files'] = handleTestRescanFiles;
  }

  const MUTATING_ROUTES: ReadonlySet<string> = new Set([
    '/api/lint/markdownlint-config',
    '/api/lint/frontmatter-schema',
    '/api/lint/fix',
    '/api/agent-write',
    '/api/agent-write-md',
    '/api/agent-write-batch',
    '/api/frontmatter-patch',
    '/api/agent-patch',
    '/api/agent-undo',
    '/api/save-version',
    '/api/rollback',
    '/api/test-reset',
    '/api/test-flush-git',
    '/api/test-rescan-backlinks',
    '/api/test-rescan-files',
    '/api/install-skill',
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
    '/api/skills/reimport-bulk',
    '/api/skill/revert',
    '/api/skill/track-in-git',
  ]);

  const apiRouteTable: ApiRouteTable = {
    resolve(url) {
      const handler = routes[url];
      if (handler) {
        return { template: url, dispatch: (req, res) => handler(req, res) };
      }
      return { template: '/api/*' };
    },
    isMutating: (url) => MUTATING_ROUTES.has(url),
  };

  const runApiPipeline = createApiRequestPipeline({
    log,
    policy: ingressPolicy,
    ephemeral,
    table: apiRouteTable,
  });

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
  const configSystemRoutes = createConfigSystemRoutes({
    contentDir,
    projectDir,
    ephemeral,
    log,
    ready,
    durabilityState,
    serverInstanceId,
    getDiskAckSVs,
    getCollabClientCount,
    getConfigDiagnostics,
    acpRegistry,
    loadAcpCustomAgents,
    acpHarnessAvailability,
    isRoutePeerAdmitted,
    isAllowedWorkspaceHostHeader,
    checkLocalOpSecurity,
    getPrincipal,
    semanticSearch,
    readSemanticProviderConfig,
    embeddingsSecretsFile,
    getFileIndex,
    shadowRef,
    getCurrentBranch,
    installedAgentsCache,
  });
  const lintRoutes = createLintRoutes({
    hocuspocus,
    contentDir,
    projectDir,
    contentFilter,
    isSafeDocName,
    resolveDocFilePath,
    isValidRelativeContentPath,
    streamShowAllEntries,
    getLinterBaseConfig,
    getLinksValidationSetting,
    derivedDocumentIndex,
    collectAdmittedDocNames,
    unmatchedGlobProblems,
    readAuditGeneration,
  });
  const historyRoutes = createHistoryRoutes({
    contentRoot,
    log,
    shadowRef,
    flushGitCommit,
    commitOkArtifactWrite,
    getCurrentBranch,
    validateFolderRel,
    safeDocPath,
    docTreePathCandidates,
  });
  const skillsReadRoutes = createSkillsReadRoutes({
    contentDir,
    projectDir,
    homeDirOverride,
    skillsHome,
    isSafeDocName,
    commentService,
    enumerateInstalledSkillsCached,
    checkLocalOpSecurity,
  });
  const skillsShRoutes = createSkillsShRoutes({
    log,
    skillsHome,
    projectDir,
    contentDir,
    resolveSkillDirForRead,
  });
  const workspaceToolsRoutes = createWorkspaceToolsRoutes({
    contentDir,
    projectDir,
    skillsHome,
    homeDirOverride,
    savedThemeLockTimeoutMs,
    ephemeral,
    log,
    signalChannel,
    searchService,
    linkPreviewFetch,
    getLinkPreviewsEnabled,
    getGeneratedIndexSettingsStatus,
    setGeneratedIndexEnabled,
  });
  const commentRoutes = createCommentRoutes({
    commentService,
    getPrincipal,
    signalChannel,
  });
  const syncRoutes = createSyncRoutes({
    projectDir,
    contentDir,
    getPrincipal,
    hocuspocus,
    log,
    checkLocalOpSecurity,
    getSyncEngine,
    serializeDoc,
  });
  const shareRoutes = createShareRoutes({
    projectDir,
    contentDir,
    log,
    checkLocalOpSecurity,
    localOpCliArgs,
    localOpGuard,
    getSyncEngine,
    toGitRelativePath,
  });
  const gitRoutes = createGitRoutes({
    projectDir,
    contentDir,
    contentFilter,
    getFileIndex,
    checkLocalOpSecurity,
    getSyncEngine,
    getPrincipal,
    localOpCliArgs,
  });
  const localOpRoutes = createLocalOpRoutes({
    projectDir,
    contentDir,
    log,
    checkLocalOpSecurity,
    localOpCliArgs,
    localOpGuard,
    getSyncEngine,
    authStreamHeartbeatMs,
    embeddingsSecretsFile,
    readSemanticProviderConfig,
    semanticSearch,
  });
  const fileOpsRoutes = createFileOpsRoutes({
    contentDir,
    projectDir,
    log,
    getPrincipal,
    contentFilter,
    signalChannel,
    hocuspocus,
    getSyncEngine,
    flushContributors,
    fileOpsService,
    assetService,
    extractAgentIdentity,
    recordDerivedDocumentBestEffort,
    invalidateReferencedAssetsCache,
    listManagedDocNamesUnderFolderFromDisk,
    resolveContentEntryPath,
    docNameForFileOperationPath,
    withPeriod,
    toManagedRenamePublicError,
    attributeRenameWriteToActor,
    renameAttributionCounter,
    _performAssetRename,
    _performDocumentToFileRename,
    _performManagedRenameForDocs,
    isValidRelativeContentPath,
  });
  const seedRoutes = createSeedRoutes({
    contentDir,
    checkLocalOpSecurity,
  });
  const systemActionsRoutes = createSystemActionsRoutes({
    contentDir,
    log,
    checkLocalOpSecurity,
    installedAgentsCache,
  });
  const folderTemplateRoutes = createFolderTemplateRoutes({
    contentDir,
    projectDir,
    ephemeral,
    log,
    hocuspocus,
    sessionManager,
    getPrincipal,
    signalChannel,
    getSyncEngine,
    recentlyRemovedDocs,
    isSafeDocName,
    resolveAlias,
    resolveContentEntryPath,
    validateFolderRel,
    extractAgentIdentity,
    extractActorIdentityFromQuery,
    okArtifactKey,
    attributeOkArtifactWrite,
    scheduleOkArtifactFlush,
    flushDiskAndDetectOutcome,
    respondPersistenceFailure,
    respondDiskDivergence,
    registerWrittenDocInFileIndex,
    captureAndCloseDocuments,
    renameTrackedPathInGit,
    renamePathOnDisk,
    splitContentPath,
    mutateFileIndex,
  });
  const nativeGroups = [
    linkGraphRoutes,
    metricsRoutes,
    documentRoutes,
    configSystemRoutes,
    lintRoutes,
    historyRoutes,
    skillsReadRoutes,
    skillsShRoutes,
    workspaceToolsRoutes,
    commentRoutes,
    syncRoutes,
    shareRoutes,
    gitRoutes,
    localOpRoutes,
    fileOpsRoutes,
    seedRoutes,
    systemActionsRoutes,
    folderTemplateRoutes,
  ];
  const nativePaths = nativeGroups.flatMap((group) => [...group.paths]);
  assertSingleRouterOwnership(nativePaths, routes);
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

  const MCP_LOCAL_API_PATHS: ReadonlySet<string> = new Set([
    '/api/search',
    '/api/delete-path',
    '/api/create-folder',
    '/api/save-version',
    '/api/skill/import',
    '/api/skill/install',
    '/api/upload',
    '/api/orphans',
    '/api/hubs',
    '/api/backlinks',
    '/api/forward-links',
    '/api/dead-links',
    '/api/suggest-links',
  ]);
  const localApiNativeTables = nativeGroups.map((group) => group.table);
  const resolveLocalApiNativeDispatch = (pathname: string) => {
    for (const table of localApiNativeTables) {
      const dispatch = table.resolve(pathname)?.dispatch;
      if (dispatch !== undefined) return dispatch;
    }
    return undefined;
  };
  for (const path of MCP_LOCAL_API_PATHS) {
    if (routes[path] === undefined && resolveLocalApiNativeDispatch(path) === undefined) {
      throw new Error(`MCP_LOCAL_API_PATHS has no handler for ${path}`);
    }
  }
  const localApi = createLocalApiDispatch({
    resolve: (pathname) => {
      if (!MCP_LOCAL_API_PATHS.has(pathname)) return undefined;
      const legacy = routes[pathname];
      if (legacy !== undefined) return legacy;
      return resolveLocalApiNativeDispatch(pathname);
    },
  });

  return {
    priority: 100,
    async onRequest({ request, response }: { request: IncomingMessage; response: ServerResponse }) {
      await runApiPipeline(request, response);
    },
    nativeApi,
    localApi,
  };
}
