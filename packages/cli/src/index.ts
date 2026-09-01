export {
  detectGh,
  detectGhAccounts,
  type GhAccount,
  type GhDetectResult,
} from './auth/gh-detect.ts';
export {
  createTokenStore,
  makeLazyProbeTokenStore,
  type TokenStore,
} from './auth/token-store.ts';
export {
  type OwnManagedMcpEntryHit,
  probeOwnManagedEditorMcpEntry,
} from './commands/acp-harness-probe.ts';
export {
  type BundleExtraFile,
  type BundleLogger,
  defaultBugReportZipPath,
  okBugReportsDir,
} from './commands/bug-report-bundle.ts';
export { redactContent } from './commands/bug-report-redact.ts';
export {
  ALL_EDITOR_IDS,
  buildManagedServerEntry,
  EDITOR_LABELS,
  EDITOR_TARGETS,
  type EditorId,
  type EditorMcpTarget,
  editorConfigPathDisplay,
  editorEntryLocator,
  HOSTS_WITH_USER_SKILL_DIR,
  isEntryUpToDate,
  isOwnManagedEntry,
  type McpInstallOptions,
} from './commands/editors.ts';
export {
  classifyExistingMcpEntry,
  detectInstalledEditors,
  type EditorMcpResult,
  LAUNCH_CONFIG_NAME,
  type McpDeclineReason,
  type McpEntryClassification,
  readExistingMcpEntry,
  type UserMcpConfigsOptions,
  writeEditorMcpConfig,
  writeUserMcpConfigs,
} from './commands/init.ts';
export {
  type McpRemoveOutcome,
  removeOwnMcpEntry,
} from './commands/mcp-config-removal.ts';
export {
  buildMcpConfigDeclineEvent,
  type McpConfigDeclineEvent,
  type McpConfigDeclineScope,
} from './commands/mcp-decline-event.ts';
export {
  buildMcpConfigMigrateEvent,
  type McpConfigMigrateEvent,
  type McpConfigMigrateScope,
  truncatePriorEntry,
} from './commands/mcp-migrate-event.ts';
export {
  type EnsurePiBridgeResult,
  ensurePiBridge,
  type PiBridgeFileState,
  type PiBridgeState,
  type PiBridgeWriteAction,
  type PiTrustState,
  type PiTrustWriteAction,
  probePiBridgeState,
} from './commands/pi-acp-bridge.ts';
export { runStop } from './commands/stop.ts';
export { type LoadConfigResult, loadConfig } from './config/loader.ts';
export { type PreviewResult, previewContent } from './content/preview.ts';
export {
  type ExpectedShareRepo,
  type ShareFolderValidationResult,
  validateLocalFolderForShare,
} from './github/folder-validator.ts';
export {
  type ParsedGitHubBlobUrl,
  type ParsedGitHubShareTarget,
  type ParsedGitHubTreeUrl,
  parseGitHubBlobUrl,
  parseGitHubShareUrl,
  parseGitHubTreeUrl,
  parseGitUrl,
} from './github/url.ts';
export {
  PATH_SHIM_BEGIN,
  PATH_SHIM_BLOCK_RE,
  PATH_SHIM_END,
  type PathDiscovery,
  type PathInstallConsent,
  type PathInstallMarker,
  pathInstallMarkerPath,
} from './integrations/path-shim.ts';
export type { IntegrationWriteOutcome } from './integrations/project-integration-writers.ts';
export {
  type ResolveProjectRootOptions,
  type ResolveProjectRootResult,
  resolveProjectRoot,
} from './integrations/resolve-project-root.ts';
export {
  removeUserGlobalSkillBundle,
  type SkillBundleTarget,
  userGlobalSkillBundleTargets,
} from './integrations/skill-teardown.ts';
export {
  type ProjectAiIntegrationsResult,
  writeProjectAiIntegrations,
} from './integrations/write-project-ai-integrations.ts';
export {
  assertProjectPathSafe,
  type ProjectSkillRemoveResult,
  type ProjectSkillResult,
  removeProjectSkill,
  writeProjectSkill,
} from './integrations/write-project-skill.ts';
export { getNativeTomlMcpEditor } from './native/toml-config-engine.ts';
export {
  type CollectReportBundleOptions,
  collectReportBundle,
  type ReportBundleLevel,
  type ReportBundleResult,
  type ReportBundleSummary,
} from './report-bundle.ts';
export type { LanguageMetadata } from './report-language.ts';
export {
  addOkPathsToGitExclude,
  type ExcludeWriteResult,
  formatTrackedRemediation,
  getExcludedOkPaths,
  getInstalledSkillProjectionPaths,
  getOkArtifactPaths,
  probeTrackedOkPaths,
  readSharingMode,
  removeOkPathsFromGitExclude,
  type SharingMode,
  type TrackedRefusal,
} from './sharing/git-exclude.ts';
