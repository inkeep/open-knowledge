export { detectGh, type GhDetectResult } from './auth/gh-detect.ts';
export {
  createTokenStore,
  makeLazyProbeTokenStore,
  type TokenStore,
} from './auth/token-store.ts';
export {
  ALL_EDITOR_IDS,
  buildManagedServerEntry,
  EDITOR_LABELS,
  EDITOR_TARGETS,
  type EditorId,
  type EditorMcpTarget,
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
  LAUNCH_UI_CHAIN_SENTINEL,
  LAUNCH_UI_CHAIN_V1,
  type LaunchJsonResult,
  type McpEntryClassification,
  readExistingMcpEntry,
  scaffoldLaunchJson,
  type UserMcpConfigsOptions,
  writeEditorMcpConfig,
  writeUserMcpConfigs,
} from './commands/init.ts';
export {
  buildMcpConfigMigrateEvent,
  type McpConfigMigrateEvent,
  type McpConfigMigrateScope,
  truncatePriorEntry,
} from './commands/mcp-migrate-event.ts';
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
export type { IntegrationWriteOutcome } from './integrations/project-integration-writers.ts';
export {
  type ResolveProjectRootOptions,
  type ResolveProjectRootResult,
  resolveProjectRoot,
} from './integrations/resolve-project-root.ts';
export {
  type ProjectAiIntegrationsResult,
  writeProjectAiIntegrations,
} from './integrations/write-project-ai-integrations.ts';
export { assertProjectPathSafe } from './integrations/write-project-skill.ts';
export {
  addOkPathsToGitExclude,
  type ExcludeWriteResult,
  formatTrackedRemediation,
  getExcludedOkPaths,
  getOkArtifactPaths,
  probeTrackedOkPaths,
  readSharingMode,
  removeOkPathsFromGitExclude,
  type SharingMode,
  type TrackedRefusal,
} from './sharing/git-exclude.ts';
