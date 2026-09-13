import { createAgentIntegrationsRoutes } from './http/agent-integrations-routes.ts';
import { createAgentWriteRoutes } from './http/agent-write-routes.ts';
import { createTestRoutes } from './http/test-routes.ts';

export { ROLLBACK_ORIGIN } from './http/agent-write-routes.ts';

import { randomUUID } from 'node:crypto';
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { Document, Extension, Hocuspocus } from '@hocuspocus/server';
import {
  type AdvisoryWarning,
  AGENT_ICON_COLORS,
  AGENTS_SKILLS_ROOT,
  AgentWriteBatchRequestSchema,
  AgentWriteBatchSuccessSchema,
  AgentWriteRequestSchema,
  AgentWriteSuccessSchema,
  type BatchEntryError,
  type ConfigDiagnosticsReport,
  changedBlockRange,
  colorFromSeed,
  createCodeFenceTracker,
  DEFAULT_LINTER_CONFIG,
  type DiskEditReconciledWarning,
  type DocumentListEntry,
  estimateSkillCost,
  FrontmatterSchemaWriteRequestSchema,
  type HeadingEntry,
  type InlineAssetMediaKind,
  isManagedArtifactDocName,
  LEGACY_SKILL_STORE_ROOT,
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
  type Principal,
  type ProblemType,
  parseFrontmatterRecord,
  pathspecArgs,
  type ReLintFailure,
  readFmMap,
  SKILL_NAME_REGEX,
  SkillScopeSchema,
  SkillUninstallRequestSchema,
  SkillUninstallSuccessSchema,
  scanHeadingLine,
  stripFrontmatter,
  summarizeLintPluginFailures,
  type ValidationDiagnostic,
} from '@inkeep/open-knowledge-core';
import { formatRenameSubject } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import {
  parseSkillDir,
  pluginRepositoryUrl,
  type SkillsLock,
} from '@inkeep/open-knowledge-core/skills-catalog';
import {
  type AcpHarnessAvailability,
  createAcpHarnessAvailabilityProbe,
} from './acp/harness-availability.ts';
import type { AcpRegistry, CustomAgentEntry } from './acp/registry.ts';
import { captureEffect } from './activity-log.ts';
import type { AgentFocusBroadcaster } from './agent-focus.ts';
import type { AgentPresenceBroadcaster } from './agent-presence.ts';
import type { AgentRegistryHostSeam } from './agent-registry-apply.ts';
import {
  AgentSessionCapacityError,
  type AgentSessionManager,
  type AgentWriteContentDivergence,
  agentWriteLossDetect,
  agentWritePreDrain,
  applyAgentMarkdownWrite,
  iconFromClientName,
  prepareAgentMarkdownParse,
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
import {
  DocInConflictError,
  isDocInConflict,
  RESOLUTION_OPTIONS,
  respondDocInConflict,
} from './conflict-errors.ts';
import { toContentDivergenceWarning } from './content-divergence-gate.ts';
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
  checkSymlinkLeaf,
  isContainmentRejection,
  PathContainmentError,
} from './fs-safety.ts';
import {
  createInstalledAgentsProbe,
  createOsProbe,
  type InstalledAgentScheme,
} from './handoff-api.ts';
import { createHandoffInstallRoutes } from './http/handoff-install-routes.ts';
import { createSkillsDocumentRoutes } from './http/skills-document-routes.ts';
import { createSkillsFileRoutes } from './http/skills-file-routes.ts';
import { createSkillsImportRoutes } from './http/skills-import-routes.ts';
import { createSkillsInstallRoutes } from './http/skills-install-routes.ts';
import { createSkillsListRoutes } from './http/skills-list-routes.ts';
import { createSkillsRecoveryRoutes } from './http/skills-recovery-routes.ts';
import { createSkillsTrackingRoutes } from './http/skills-tracking-routes.ts';
import { findHubCandidates } from './hub-candidates.ts';
import { recordSkillInstall, removeSkillInstall } from './installed-skills-marker.ts';
import { collectDocFiles, lintAndFixSource } from './lint/audit.ts';
import { composeAuditGeneration } from './lint/audit-generation.ts';
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
} from './skill-bundles.ts';
import {
  projectSkill,
  removeInPlaceSkillCopies,
  resolveSkillTargets,
  reverseProjectSkill,
  skillProjectionEditorIds,
  skillProjectionRoots,
} from './skill-projection.ts';
import { createSkillsCatalogCache } from './skills-catalog-cache.ts';

export { extractPageTitle } from './page-identity.ts';

import simpleGit from 'simple-git';
import { parseAgentBodyFields, resolveAgentType } from './agent-id.ts';
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
import { composeAndWriteRawBody } from './bridge-intake.ts';
import type { BridgeDeriveLossReporter } from './bridge-loss-detector.ts';
import { isConfigDoc, isLinkIndexExcludedDoc, isSystemDoc } from './cc1-broadcast.ts';
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
  isSupportedDocFile,
  registerDocExtension,
  SUPPORTED_DOC_EXTENSIONS,
  stripDocExtension,
} from './doc-extensions.ts';
import {
  type DocumentDurabilityState,
  OK_DOC_REMOVED,
  OK_PATH_UNRESOLVABLE,
  type StoreFailure,
} from './document-durability-state.ts';
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
import {
  tracedCpSync,
  tracedMkdirSync,
  tracedRenameSync,
  tracedRmSync,
  tracedWriteFileSync,
} from './fs-traced.ts';
import { withParentLock } from './git-handle.ts';
import { type ApiRouteTable, createApiRequestPipeline } from './http/api-pipeline.ts';
import { createAssetRoutes } from './http/asset-routes.ts';
import { createCommentRoutes } from './http/comment-routes.ts';
import { createConfigSystemRoutes } from './http/config-system-routes.ts';
import { createDocumentRoutes } from './http/document-routes.ts';
import {
  type ErrorExtensions,
  errorResponse,
  type HttpErrorStatus,
} from './http/error-response.ts';
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
  removableSkillOccurrenceDirs,
  resolveGlobalNativeSkillDir,
  scanGlobalInPlaceSkills,
  scanInPlaceSkills,
} from './in-place-skills.ts';
import {
  buildIngressPolicy,
  type IngressPolicy,
  isHostAdmitted,
  isPeerAdmitted,
} from './ingress-policy.ts';
import {
  type LinkAdvisoryPolicy,
  projectWriteAdvisoryLinks,
  type WriteLinkAdvisoryProjection,
} from './link-advisory-policy.ts';
import type { GuardedFetch } from './link-preview/metadata.ts';
import {
  checkLocalOpSecurity as checkLocalOpSecurityBase,
  createConcurrencyGuard,
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
  incrementAgentWriteCalls,
  incrementSummariesProvided,
  incrementSummariesTruncated,
} from './metrics.ts';
import { isWithinDir, toPosix } from './path-utils.ts';
import {
  appendRenameLogEntry,
  getOrLoadRenameLogIndex,
  type RenameLogEntry,
} from './rename-log.ts';
import type { PairedWriteOrigin } from './server-observers.ts';
import { createAssetService } from './services/assets.ts';
import { createFileOpsService, DuplicateNameExhaustedError } from './services/file-ops.ts';
import { createSearchService } from './services/search.ts';
import { createSkillImportService } from './services/skill-import.ts';
import { createSkillInstallOpsService } from './services/skill-install-ops.ts';
import { createSkillPlacementOpsService } from './services/skill-placement-ops.ts';
import { createSkillReimportService } from './services/skill-reimport.ts';
import { SERVICE_WRITER, type ShadowRef, shadowGit } from './shadow-repo.ts';

import { readSkillInstallModeRaw } from './skill-placements.ts';

import type { SyncEngine } from './sync-engine.ts';
import { getMeter, withSpan, withSpanSync } from './telemetry.ts';
import { computeWriteAdvisoryLinks } from './write-advisory-links.ts';

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

/**
 * Exported so the bridge-invariant watcher can enforce by identity (precedent #1) and so server
 * observers can resolve `context.paired` without importing the object transitively.
 */
export const MANAGED_RENAME_ORIGIN = {
  source: 'local' as const,
  skipStoreHooks: false,
  context: { origin: 'managed-rename', paired: true },
} as const satisfies PairedWriteOrigin;

const log = getLogger('api');

const storeRefusalDetail = (err: unknown): string | undefined =>
  err instanceof Error && err.message.startsWith('Refusing to rewrite ') ? err.message : undefined;

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
  const key = [...paths].sort().join('\0');
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

export async function renameTrackedPathInGit(
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
      tracked = (await pg.raw('ls-files', ...pathspecArgs([sourceRel]))).trim();
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
  agentIntegrations?: AgentRegistryHostSeam;
  savedThemeLockTimeoutMs?: number;
  acpRegistry?: AcpRegistry;
  loadAcpCustomAgents?: () => Promise<CustomAgentEntry[]>;
  acpHarnessAvailability?: () => Promise<AcpHarnessAvailability>;
  contentFilter?: ContentFilter;
  installedAgentsProbe?: (scheme: InstalledAgentScheme) => Promise<boolean>;
  forceUnloadDocument?: (document: Document) => Promise<void>;
  resetDocumentDurability?: (docName: string) => void;
  ready?: Promise<void>;
  recentlyRemovedDocs?: RecentlyRemovedDocs;
  serializeDoc?: (docName: string) => string | null;
  resolveStaleExternalWrite?: (
    file: string,
    strategy: ResolveStrategy,
    content?: string,
  ) => Promise<boolean>;
  evictManagedArtifactLkg?: (docName: string) => void;
  semanticSearch?: SemanticSearchService;
  getSemanticSimilarityFloor?: () => number | undefined;
  embeddingsSecretsFile?: string;
  readSemanticProviderConfig?: () => ResolvedSemanticConfig;
  getLinterBaseConfig?: () => LinterConfig;
  getLinkAdvisoryPolicy: () => LinkAdvisoryPolicy;
  getProjectConfigEpoch: () => number;
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
    agentIntegrations,
    savedThemeLockTimeoutMs,
    acpRegistry,
    loadAcpCustomAgents,
    acpHarnessAvailability = createAcpHarnessAvailabilityProbe(),
    contentFilter,
    installedAgentsProbe,
    forceUnloadDocument,
    resetDocumentDurability,
    ready,
    recentlyRemovedDocs,
    serializeDoc,
    resolveStaleExternalWrite,
    evictManagedArtifactLkg,
    semanticSearch,
    getSemanticSimilarityFloor,
    embeddingsSecretsFile,
    readSemanticProviderConfig,
    getLinterBaseConfig,
    getLinkAdvisoryPolicy,
    getProjectConfigEpoch,
    ephemeral = false,
    linkPreviewFetch,
    getLinkPreviewsEnabled,
    getConfigDiagnostics,
  } = options;
  const catalogCache = createSkillsCatalogCache({ homeDirOverride, log });
  const { bumpSkillsCatalogGen, enumerateInstalledSkillsCached, pluginSkillsByName } = catalogCache;
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

  type FlushOutcome =
    | { kind: 'failure'; failure: StoreFailure }
    | { kind: 'divergence' }
    | { kind: 'stale-external-write' }
    | null;

  async function flushDiskAndDetectOutcome(docName: string): Promise<FlushOutcome> {
    const debounceId = `onStoreDocument-${docName}`;
    if (hocuspocus.debouncer.isDebounced(debounceId)) {
      durabilityState.markAgentWriteStore(docName);
      await hocuspocus.debouncer.executeNow(debounceId);
    }
    const failure = durabilityState.takeStoreFailure(docName);
    if (failure) return { kind: 'failure', failure };
    if (durabilityState.takeStaleExternalWriteFreeze(docName)) {
      return { kind: 'stale-external-write' };
    }
    if (durabilityState.takeStoreDivergence(docName)) return { kind: 'divergence' };
    return null;
  }

  function removedDocProblem(failure: StoreFailure) {
    return {
      type: 'urn:ok:error:doc-removed' as const,
      title:
        'Edit applied in memory; disk write refused because the document is no longer on disk.',
      detail: `${failure.message}. Retrying will not help: re-create the document before writing this content again.`,
    } satisfies BatchEntryError;
  }

  function pathFaultProblem(failure: StoreFailure) {
    return {
      type: 'urn:ok:error:path-escape' as const,
      title:
        'Edit applied in memory; disk write refused because the document path could not be resolved.',
      detail: `${failure.message}. Retrying will not help: the path has to be repaired on disk before this content can be written.`,
    } satisfies BatchEntryError;
  }

  function respondPersistenceFailure(
    res: ServerResponse,
    failure: StoreFailure,
    handler: string,
  ): void {
    if (failure.code === OK_DOC_REMOVED) {
      const { type, title, detail } = removedDocProblem(failure);
      errorResponse(res, 409, type, title, { handler, detail });
      return;
    }
    if (failure.code === OK_PATH_UNRESOLVABLE) {
      const { type, title, detail } = pathFaultProblem(failure);
      errorResponse(res, 400, type, title, { handler, detail });
      return;
    }
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

  function staleExternalWriteProblem(docName: string) {
    return {
      type: 'urn:ok:error:stale-external-write' as const,
      title: 'Edit retained; disk write blocked by a stale external-write conflict.',
      detail:
        'An older version was restored on disk. Your edit was applied and is retained in memory and in the recovery snapshot, but its Markdown disk write was skipped. Do not repeat this edit: inspect conflicts({ kind: "content" }) for this file and resolve_conflict, then re-read the document before making further changes.',
      file:
        durabilityState.getStaleExternalWrite(docName)?.file ??
        relative(projectDir ?? contentDir, safeContentPath(docName, contentDir)).replaceAll(
          '\\',
          '/',
        ),
      resolutionOptions: RESOLUTION_OPTIONS,
    } satisfies BatchEntryError;
  }

  function respondStaleExternalWrite(res: ServerResponse, handler: string, docName: string): void {
    const { type, title, detail, ...extensions } = staleExternalWriteProblem(docName);
    errorResponse(res, 409, type, title, { handler, detail, extensions });
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

  /**
   * Content-scope exclusion for a docName, mirroring the file-watcher's markdown admission
   * gate: a doc the watcher would refuse to index must not slip into the admitted set by
   * another door (precedent #55).
   */
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

  /**
   * Mirrors the watcher's admission gate (precedent #55): a content-scope-excluded doc must
   * NOT be registered, exactly as the watcher would skip it.
   */
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
   * Canonical identity boundary (precedent #24) — every mutating POST handler calls this before any
   * Y.Doc mutation.
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

  let deferredIgnoreRebuildTimer: NodeJS.Timeout | null = null;
  function scheduleDeferredIgnoreRebuild(): void {
    if (!contentFilter) return;
    if (deferredIgnoreRebuildTimer !== null) clearTimeout(deferredIgnoreRebuildTimer);
    deferredIgnoreRebuildTimer = setTimeout(() => {
      deferredIgnoreRebuildTimer = null;
      void contentFilter?.rebuildIgnorePatterns().catch(() => {});
    }, 120_000);
  }
  function invalidateSkillCatalog(): void {
    bumpSkillsCatalogGen();
    contentFilter?.refreshInPlaceSkillDirs();
    scheduleDeferredIgnoreRebuild();
  }
  function settleSkillCatalog(): void {
    invalidateSkillCatalog();
    signalChannel?.('files');
  }
  type OkArtifactFlush = 'flushed' | 'unavailable' | 'failed';
  let okArtifactFlushChain: Promise<void> = Promise.resolve();
  function scheduleOkArtifactFlush(context: string): void {
    bumpSkillsCatalogGen();
    okArtifactFlushChain = okArtifactFlushChain
      .then(async () => {
        await commitOkArtifactWrite(context);
      })
      .catch(() => {});
  }
  async function commitOkArtifactWrite(context: string): Promise<OkArtifactFlush> {
    if (!flushContributors) return 'unavailable';
    try {
      await flushContributors();
      return 'flushed';
    } catch (flushErr) {
      log.warn(
        { context, err: flushErr },
        `[${context}] flushContributors failed; attribution stays queued for the next flush`,
      );
      return 'failed';
    }
  }

  const handleAgentWrite = withValidation(
    AgentWriteRequestSchema,
    async (_req, res, body) => {
      try {
        const rawDocName = requireNonEmptyDocName(body.docName, res, 'agent-write');
        if (rawDocName === null) return;
        const docName = resolveAlias(rawDocName);

        // Identity extraction precedes every semantic error emission below (precedent #24).
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
        if (flushOutcome?.kind === 'stale-external-write') {
          respondStaleExternalWrite(res, 'agent-write', docName);
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
            ...(agentWriteWarning ? { warnings: [agentWriteWarning] } : {}),
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

  const handleAgentWriteBatch = withValidation(
    AgentWriteBatchRequestSchema,
    async (_req, res, body) => {
      try {
        const linkPolicy = getLinkAdvisoryPolicy();
        const { agentId, agentName, colorSeed, clientName, clientVersion, label } =
          extractAgentIdentity(body);

        const timestamp = new Date().toISOString();

        interface BatchErrorResult {
          status: 'error';
          docName: string;
          error: BatchEntryError;
        }
        interface BatchWrittenResult extends WriteLinkAdvisoryProjection {
          status: 'written';
          docName: string;
          summary?: SummaryResponse;
          warnings?: AdvisoryWarning[];
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
              if (flushOutcome.failure.code === OK_DOC_REMOVED) {
                flushErrors.set(p.docName, removedDocProblem(flushOutcome.failure));
              } else if (flushOutcome.failure.code === OK_PATH_UNRESOLVABLE) {
                flushErrors.set(p.docName, pathFaultProblem(flushOutcome.failure));
              } else {
                const reason = classifyUploadErrno({
                  code: flushOutcome.failure.code,
                } as NodeJS.ErrnoException);
                flushErrors.set(p.docName, {
                  type: reason,
                  title: 'Write applied in memory but failed to persist to disk.',
                  detail: `${flushOutcome.failure.code ?? 'unknown error'}: ${flushOutcome.failure.message}. The content was NOT saved and will be lost if the server restarts.`,
                });
              }
            } else if (flushOutcome?.kind === 'divergence') {
              flushErrors.set(p.docName, {
                type: 'urn:ok:error:disk-divergence',
                title:
                  'The document changed on disk after your edit was prepared; your edit was NOT applied. Re-read the document and retry.',
              });
            } else if (flushOutcome?.kind === 'stale-external-write') {
              flushErrors.set(p.docName, staleExternalWriteProblem(p.docName));
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
            results[p.index] = {
              status: 'written',
              docName: p.docName,
              ...(p.summaryResponse ? { summary: p.summaryResponse } : {}),
              ...(p.warnings.length > 0 ? { warnings: p.warnings } : {}),
              ...projectWriteAdvisoryLinks(
                computeWriteAdvisoryLinks(
                  writtenSource,
                  p.docName,
                  admittedForLinks,
                  linkedFileExists,
                  linkedFolderExists,
                ),
                p.docName,
                linkPolicy.suppressLogLinkAdvisories,
              ),
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
  const skillPlacementOps = createSkillPlacementOpsService();

  const assetService = createAssetService({
    contentDir,
    isPathIgnored: (relativePath) => contentFilter?.isPathIgnored(relativePath) ?? false,
    getAttachmentFolderPath,
  });
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

  function validateFolderRel(
    raw: string,
    res: ServerResponse,
    label: 'path' | 'folder',
    handler: string,
    components: 'ok' | 'ok-and-templates',
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
    /* STOP: the escape asserts below admit an IN-ROOT symlinked
       `<folder>/.ok` OR `<folder>/.ok/templates` (their realpaths stay
       inside the content root), which would alias every folder-config and
       template arm — including the WRITE arms (`applyTemplateWrite`'s
       rename lands wherever `templates` points; `applyTemplateDelete`
       unlinks through it) — into another directory. Refuse by identity —
       same posture as `initContent`'s `assertNotSymlink` on the root `.ok/`
       and the templates resolver's gates. The `templates` component is
       checked only for the template arms (`components: 'ok-and-templates'`).
       The folder-config arms DO reach `.ok/templates` — through
       `collectFromFolder` (content/templates-resolver.ts), which gates it by
       identity and degrades, skipping a symlinked templates dir (and
       reporting it via `onRefused`) rather than failing the folder payload.
       Do not hard-fail here for those arms or the per-field degrade contract
       breaks; do not delete the resolver-side gate, which is what makes the
       degrade safe. The same unconditional `.ok` identity check also gates
       the folder-history arm (http/history-routes.ts) for a uniform
       refuse-by-identity posture, even though that arm only uses the path as
       a `git log` pathspec and the aliasing risk above does not apply there.
       Only an actual
       symlink short-circuits here; a non-ENOENT lstat failure
       (`unverifiable`) is left to the `assertNoSymlinkEscape` asserts below,
       which classify it (ELOOP → path-escape, other errnos → 500) rather
       than mislabel a non-symlink path as a symlink. */
    const okDir = resolve(candidateAbs, '.ok');
    if (checkSymlinkLeaf(okDir).kind === 'symlink') {
      errorResponse(
        res,
        400,
        'urn:ok:error:symlink-refused',
        `${folderRel || '.'}/.ok is a symlink — refusing to operate through it. Replace the symlink with a real file or directory and retry.`,
        { handler, detail: folderRel || '.' },
      );
      return null;
    }
    const okTemplatesDir = resolve(candidateAbs, '.ok', 'templates');
    if (components === 'ok-and-templates' && checkSymlinkLeaf(okTemplatesDir).kind === 'symlink') {
      errorResponse(
        res,
        400,
        'urn:ok:error:symlink-refused',
        `${folderRel || '.'}/.ok/templates is a symlink — refusing to operate through it. Replace the symlink with a real file or directory and retry.`,
        { handler, detail: folderRel || '.' },
      );
      return null;
    }
    try {
      assertNoSymlinkEscape(okDir, resolvedContentDir);
      if (components === 'ok-and-templates') {
        assertNoSymlinkEscape(okTemplatesDir, resolvedContentDir);
      }
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
  function validateSkillName(
    name: string,
    res: ServerResponse,
    handler: string,
    extensions?: ErrorExtensions,
  ): boolean {
    if (!isValidSkillName(name)) {
      errorResponse(
        res,
        400,
        'urn:ok:error:invalid-request',
        'Invalid skill name: lowercase letters, digits, and hyphens only (≤64 chars; no slashes, dots, spaces, or uppercase).',
        { handler, ...(extensions ? { extensions } : {}) },
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

  function resolveBuiltinSkillDir(
    base: string,
    name: string,
    scope: 'project' | 'global',
    host?: string,
  ): { dir: string; skillMd: string; hosts: string[]; relPath: string } | null {
    const hosts: string[] = [];
    let chosenDir: string | null = null;
    const scopeRoots = skillProjectionRoots(scope);
    const roots: Array<{ id: string; root: string }> = [
      ...skillProjectionEditorIds(scope).map((editorId) => ({
        id: editorId as string,
        root: scopeRoots[editorId] ?? '',
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

  function synthBuiltinLockEntry(
    base: string,
    name: string,
    scope: 'project' | 'global',
  ): SkillsLock['skills'][string] | null {
    if (!isInternalBundleSkillName(name)) return null;
    const resolved = resolveBuiltinSkillDir(base, name, scope);
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
    const resolved = resolveBuiltinSkillDir(base, name, scope);
    const skillMd = resolved?.skillMd ?? shippedBundleSkillMd(name);
    if (skillMd === null) return null;
    let description: string | undefined;
    try {
      const { frontmatter } = parseFrontmatterDoc(readFileSync(skillMd, 'utf-8'));
      if (typeof frontmatter.description === 'string') description = frontmatter.description;
    } catch {}
    const synthEntry = synthBuiltinLockEntry(base, name, scope);
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

  function removeSkillFromHostDirs(
    base: string,
    name: string,
    scope: 'project' | 'global',
    opts: { purge?: { contentHash: string } },
  ): void {
    const scanBaseForPurge = scope === 'project' ? contentDir : skillsHome;
    if (opts.purge !== undefined) {
      reverseProjectSkill(name, base, skillProjectionEditorIds(scope), skillProjectionRoots(scope));
      for (const dir of removableSkillOccurrenceDirs(
        scanBaseForPurge,
        scope,
        name,
        opts.purge.contentHash,
      )) {
        tracedRmSync(dir, { recursive: true, force: true });
      }
      return;
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
          targets: [...skillProjectionEditorIds(scope)],
          roots: skillProjectionRoots(scope),
        });
        return;
      }
    }
    reverseProjectSkill(name, base, skillProjectionEditorIds(scope), skillProjectionRoots(scope));
  }

  async function uninstallSkillFromHostDirs(
    base: string,
    name: string,
    scope: 'project' | 'global',
    opts: { purge?: { contentHash: string } } = {},
  ): Promise<boolean> {
    removeSkillFromHostDirs(base, name, scope, opts);
    return (await removeSkillInstall(base, name)) !== null;
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
  function localSkillHash(skillsRoot: string, name: string): string | undefined {
    return parseSkillDir(resolve(skillsRoot, name))?.contentHash;
  }
  async function shadowHeadSha(
    writerId?: string,
    verifyPathRel?: string,
  ): Promise<string | undefined> {
    const shadow = shadowRef?.current;
    if (!shadow || !writerId) return undefined;
    /**
     * The shadow repo has no `HEAD`/`main`: writes land on per-writer WIP refs
     * (`refs/wip/<branch>/<writerId>`, precedent #25), so capture the actor's WIP ref rather
     * than `rev-parse HEAD`.
     */
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
        const out = await sg.raw('ls-tree', '-r', '--name-only', sha, ...pathspecArgs([rel]));
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
            ...(storeRefusalDetail(e) !== undefined ? { detail: storeRefusalDetail(e) } : {}),
            cause: e,
          },
        );
      }
    },
    { handler: 'skill-uninstall', method: 'POST' },
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

  const readAuditGeneration = (): string => {
    return composeAuditGeneration({
      lintConfigEpoch,
      projectConfigEpoch: getProjectConfigEpoch(),
      activeBranch: durabilityState.getActiveBranch(),
      localTargetGeneration: derivedDocumentIndex?.readLocalTargetGeneration?.() ?? 0,
    });
  };

  const LINT_VIOLATION_CAP = 10;
  async function computeLintViolations(
    source: string,
    docName: string,
    linkPolicy: LinkAdvisoryPolicy,
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
      if (derivedDocumentIndex && linkPolicy.links !== 'off' && !isLinkIndexExcludedDoc(docName)) {
        await recordDerivedLinkRewriteBestEffort(docName, source, 'lint-validation');
        const linksValidator = createProjectValidators({
          projectDir: projectDir ?? contentDir,
          contentDir,
          baseConfig: base,
          derivedDocumentIndex,
          linkPolicy,
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
        let reLintFailure: ReLintFailure | undefined;
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
          if (flushOutcome?.kind === 'stale-external-write') {
            respondStaleExternalWrite(res, 'lint-fix', resolvedDocName);
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
            const relintMessage =
              relintErr instanceof Error ? relintErr.message : String(relintErr);
            reLintFailure = {
              reason: 're-lint-threw',
              message:
                relintMessage.trim().length > 0
                  ? relintMessage
                  : `${relintErr instanceof Error ? relintErr.name : 'non-Error value'} thrown with no message`,
            };
            log.warn(
              { err: relintErr, handler: 'lint-fix', doc: resolvedDocName, agentId },
              'post-write re-lint failed; reporting pre-fix diagnostics',
            );
            after = before;
          }
        }

        const blindBeforeFix = new Set(
          failures.filter((f) => f.phase === 'lint').map((f) => f.source),
        );
        const blindOnlyAfterFix = [
          ...new Set(
            reLintFailures
              .filter((f) => f.phase === 'lint' && !blindBeforeFix.has(f.source))
              .map((f) => f.source),
          ),
        ];
        if (reLintFailure === undefined && blindOnlyAfterFix.length > 0) {
          reLintFailure = {
            reason: 'source-went-blind',
            message: `${blindOnlyAfterFix.join(', ')} linted the pre-fix text and failed on the post-fix text, so the re-lint is short their diagnostics and cannot be compared against the pre-fix run`,
          };
          log.warn(
            { handler: 'lint-fix', doc: resolvedDocName, agentId, sources: blindOnlyAfterFix },
            'post-write re-lint lost a source that linted before the fix; reporting pre-fix diagnostics',
          );
          after = before;
        }

        const errorCount = after.filter((d) => d.severity === 'error').length;
        const warningCount = after.length - errorCount;
        const comparable = (d: (typeof before)[number]) => !blindBeforeFix.has(d.source);
        const fixedCount = Math.max(
          0,
          before.filter(comparable).length - after.filter(comparable).length,
        );
        const responseWarnings = [
          ...configWarnings,
          ...summarizeLintPluginFailures([...failures, ...reLintFailures]),
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
            ...(reLintFailure ? { diagnosticsArePreFix: true, reLintFailure } : {}),
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
    '/api/skill/uninstall': handleSkillUninstall,
    '/api/lint/markdownlint-config': handleWriteMarkdownlintRule,
    '/api/lint/frontmatter-schema': handleWriteFrontmatterSchema,
    '/api/lint/fix': handleLintFix,
    '/api/agent-write': handleAgentWrite,
    '/api/agent-write-batch': handleAgentWriteBatch,
  };

  const MUTATING_ROUTES: ReadonlySet<string> = new Set([
    '/api/lint/markdownlint-config',
    '/api/lint/frontmatter-schema',
    '/api/lint/fix',
    '/api/agent-write',
    '/api/agent-write-batch',
    '/api/test-reset',
    '/api/test-flush-git',
    '/api/test-rescan-backlinks',
    '/api/test-rescan-files',
    '/api/skill/uninstall',
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
    getLinkAdvisoryPolicy,
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
  const skillsFileRoutes = createSkillsFileRoutes({
    validateSkillName,
    parseSkillScope,
    skillsHome,
    projectDir,
    resolveBuiltinSkillDir,
    resolveSkillDirForRead,
    resolveSkillsRoot,
    getPrincipal,
    rejectReservedBuiltinSkill,
    contentDir,
    checkSkillDocConflictGate,
    extractAgentIdentity,
    sessionManager,
    flushDiskAndDetectOutcome,
    respondStaleExternalWrite,
    respondPersistenceFailure,
    respondDiskDivergence,
    attributeOkArtifactWrite,
    okArtifactKey,
    commitOkArtifactWrite,
    signalChannel,
    extractActorIdentityFromQuery,
    captureAndCloseDocuments,
    derivedDocumentIndex,
    log,
    recordDerivedMutationsBestEffort,
  });
  const skillsImportRoutes = createSkillsImportRoutes({
    projectDir,
    getPrincipal,
    skillImportService,
    bumpSkillsCatalogGen,
    contentFilter,
    scheduleDeferredIgnoreRebuild,
    signalChannel,
    parseSkillScope,
  });
  const skillsDocumentRoutes = createSkillsDocumentRoutes({
    validateSkillName,
    parseSkillScope,
    skillsHome,
    projectDir,
    resolveBuiltinSkillDir,
    parseFrontmatterDoc,
    resolveSkillDirForRead,
    skillRelPath,
    derivedDocumentIndex,
    contentFilter,
    bumpSkillsCatalogGen,
    settleSkillCatalog,
    invalidateSkillCatalog,
    scheduleDeferredIgnoreRebuild,
    recordDerivedDocumentBestEffort,
    getPrincipal,
    rejectReservedBuiltinSkill,
    contentDir,
    attributeOkArtifactWrite,
    scheduleOkArtifactFlush,
    signalChannel,
    checkSkillDocConflictGate,
    extractAgentIdentity,
    sessionManager,
    flushDiskAndDetectOutcome,
    respondStaleExternalWrite,
    respondPersistenceFailure,
    respondDiskDivergence,
    okArtifactKey,
    resolveSkillsRoot,
    extractActorIdentityFromQuery,
    captureAndCloseDocuments,
    log,
    commitOkArtifactWrite,
    skillInstallBase,
    uninstallSkillFromHostDirs,
    renameTrackedPathInGit,
    renamePathOnDisk,
    localSkillHash,
    shadowHeadSha,
    artifactWriterId,
    checkLocalOpSecurity,
    effectiveSkillRoot,
  });
  const skillsListRoutes = createSkillsListRoutes({
    contentDir,
    projectDir,
    skillsHome,
    contentFilter,
    catalogCache,
    resolveSkillsRoot,
    resolveSkillsList,
    skillOriginFor,
    localSkillHash,
    effectiveInstallMode,
    pluginSelfIdentity,
    synthBuiltinLockEntry,
    synthPluginLockEntry,
    pluginUpstreamHash,
    builtinSkillListEntry,
    indexedSkillContentPath,
    healUnservableSkillAdmission,
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
    durabilityState,
    log,
    checkLocalOpSecurity,
    getSyncEngine,
    serializeDoc,
    resolveStaleExternalWrite,
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
    agentIntegrations,
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
    respondStaleExternalWrite,
    registerWrittenDocInFileIndex,
    captureAndCloseDocuments,
    renameTrackedPathInGit,
    renamePathOnDisk,
    splitContentPath,
    mutateFileIndex,
  });
  const assetRoutes = createAssetRoutes({ assetService, log });
  const agentIntegrationsRoutes = createAgentIntegrationsRoutes({
    log,
    checkLocalOpSecurity,
    getPrincipal,
    homeDirOverride,
    projectDir,
    agentIntegrations,
  });
  const handoffInstallRoutes = createHandoffInstallRoutes({ checkLocalOpSecurity });
  const skillsInstallRoutes = createSkillsInstallRoutes({
    resolveSkillsRoot,
    validateSkillName,
    projectDir,
    skillInstallBase,
    contentDir,
    skillsHome,
    shippedBundleSkillMd,
    flushDiskAndDetectOutcome,
    respondStaleExternalWrite,
    respondPersistenceFailure,
    respondDiskDivergence,
    skillInstallOps,
    skillPlacementOps,
    signalChannel,
    bumpSkillsCatalogGen,
    contentFilter,
    scheduleDeferredIgnoreRebuild,
    effectiveInstallMode,
    log,
  });
  const skillsRecoveryRoutes = createSkillsRecoveryRoutes({
    synthPluginLockEntry,
    synthBuiltinLockEntry,
    isValidSkillName,
    getPrincipal,
    validateSkillName,
    rejectReservedBuiltinSkill,
    shadowRef,
    contentDir,
    contentRoot,
    projectDir,
    skillsHome,
    projectSkillDirRel,
    attributeOkArtifactWrite,
    okArtifactKey,
    commitOkArtifactWrite,
    signalChannel,
    bumpSkillsCatalogGen,
    contentFilter,
    scheduleDeferredIgnoreRebuild,
    effectiveSkillRoot,
    skillReimportService,
    localSkillHash,
    resolveSkillsRoot,
    projectImportedSkillCopy,
  });
  const skillsTrackingRoutes = createSkillsTrackingRoutes({
    contentDir,
    projectDir,
    contentFilter,
    validateSkillName,
    indexedSkillContentPath,
    bumpSkillsCatalogGen,
    signalChannel,
  });
  const agentWriteRoutes = createAgentWriteRoutes({
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
  });
  const testRoutes = createTestRoutes({
    resetDocumentDurability,
    resolveAlias,
    contentDir,
    log,
    sessionManager,
    hocuspocus,
    forceUnloadDocument,
    derivedDocumentIndex,
    contentFilter,
    bumpSkillsCatalogGen,
    signalChannel,
    flushGitCommit,
    rescanFiles,
  });
  const nativeGroups = [
    assetRoutes,
    agentIntegrationsRoutes,
    agentWriteRoutes,
    ...(enableTestRoutes ? [testRoutes] : []),
    skillsTrackingRoutes,
    skillsRecoveryRoutes,
    skillsInstallRoutes,
    handoffInstallRoutes,
    skillsImportRoutes,
    skillsFileRoutes,
    linkGraphRoutes,
    metricsRoutes,
    documentRoutes,
    configSystemRoutes,
    lintRoutes,
    historyRoutes,
    skillsDocumentRoutes,
    skillsListRoutes,
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
