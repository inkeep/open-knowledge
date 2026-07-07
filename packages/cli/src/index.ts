// Public surface consumed by `@inkeep/open-knowledge-desktop` from Electron
// main. Lifted from CLI internals so desktop can import via the package
// name (`@inkeep/open-knowledge`) instead of reaching into
// `../../../cli/src/commands/...`. The workspace-dep declaration on
// desktop's package.json makes turbo's `^build` topology key on these
// symbols — a CLI internal refactor now correctly invalidates desktop's
// cache.

// `makeLazyEmbeddingsKeyStore` is NOT re-exported here — it now lives in
// `@inkeep/open-knowledge-server` (alongside the secrets-store), and desktop
// imports it straight from there. Re-exporting an external package's symbol
// through this bundled public surface breaks the .d.ts bundler.
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
  type McpDeclineReason,
  type McpEntryClassification,
  readExistingMcpEntry,
  scaffoldLaunchJson,
  type UserMcpConfigsOptions,
  writeEditorMcpConfig,
  writeUserMcpConfigs,
} from './commands/init.ts';
export {
  buildMcpConfigDeclineEvent,
  type McpConfigDeclineEvent,
  type McpConfigDeclineScope,
} from './commands/mcp-decline-event.ts';
export {
  buildMcpConfigMigrateEvent,
  type McpConfigMigrateEvent,
  type McpConfigMigrateScope,
  // `truncatePriorEntry` is marked `@internal` on its declaration in
  // `mcp-migrate-event.ts` — workspace-only consumption (Desktop project-mcp-
  // reclaim sibling event applies identical truncation bounds). External
  // consumers should use `buildMcpConfigMigrateEvent` instead.
  truncatePriorEntry,
} from './commands/mcp-migrate-event.ts';
// `runStop` is the path-addressable stop primitive (SIGTERM the server + ui
// pids recorded in `<lockDir>/{server,ui}.lock`). Desktop's
// `ok:fs:remove-git-folder` IPC reuses it to deterministically tear down a
// worktree's own collab server before deleting its `.git`.
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
// PATH-shim contract — the single source of truth shared by the desktop
// installer (`main/path-install.ts` imports these fence markers + marker path +
// marker shape) and the CLI `ok uninstall` reverter, so install and revert can
// never disagree about the managed block or where the manifest lives.
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
// Security-critical symlink-escape guard for project-scope writes. Re-exported
// so the Desktop's skill-reclaim sweep shares the one canonical implementation
// rather than duplicating it (precedent: single source of truth for guards).
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
