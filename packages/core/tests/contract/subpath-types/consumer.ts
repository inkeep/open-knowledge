export type {
  ACP_AGENT_HARNESS_CLI_MAP,
  AGENT_REGISTRY,
  AgentId,
  AgentMode,
  ApplyIntent,
  ApplyReport,
  agentIdForHandoffTarget,
  agentIdForTerminalCli,
  assessReadiness,
  BlockedReason,
  buildConnectionsView,
  CONNECTION_ROW_AGENT_IDS,
  ConnectionCell,
  ConnectionRow,
  ConsentClass,
  GuidanceId,
  GuidanceRef,
  getAgentRecord,
  HostSnapshot,
  isAgentDetected,
  KNOWN_HANDOFF_TARGETS,
  PlanConflict,
  parsePathId,
  RequirementAssessment,
  requiresExplicitConsent,
  SatisfierId,
  SurfaceState,
  VISIBLE_HANDOFF_TARGETS,
} from '@inkeep/open-knowledge-core/agent-registry';
export type {
  addsBlankLines,
  bindFrontmatterDoc,
  composeWithDerivedBody,
  FrontmatterBinding,
  FrontmatterSnapshot,
  fnv1aDigest,
  normalizeBridge,
  readFmKeys,
  readFmRegionWithError,
  SynthesisedConflictRegion,
  synthesiseConflictMarkersWithRegions,
} from '@inkeep/open-knowledge-core/bridge';
export type {
  clampToCodeUnits,
  mapControlCharactersToSpace,
  stripInvisibleCharacters,
} from '@inkeep/open-knowledge-core/bug-report-sidecar/note-content';
export type { isSurfacedCheckpointKind } from '@inkeep/open-knowledge-core/checkpoint-kinds';
export type {
  CLIENT_RUNTIME_VERSION_FALLBACK,
  ClientVersionTokenFields,
  clientVersionHeaders,
  clientVersionTokenFields,
} from '@inkeep/open-knowledge-core/client-version';
export type {
  COMMAND_IDENTITIES,
  CommandContext,
  CommandIdentity,
  evaluateCommandAvailability,
} from '@inkeep/open-knowledge-core/commands/command-identity';
export type {
  commentLeafText,
  commentQuoteText,
} from '@inkeep/open-knowledge-core/comments/leaf-text';
export type {
  contextEvidenceFloor,
  contextMatchScore,
  findAllPassages,
  PassageMatch,
  rewriteCeiling,
} from '@inkeep/open-knowledge-core/comments/passage-match';
export type {
  isSyncMode,
  modeFromCommittedDefault,
  resolveAutoSyncIntervals,
  resolveLocalAutoSyncMode,
  StoredSyncActiveMode,
  StoredSyncMode,
  SYNC_INTERVAL_PRESET_SECONDS,
  SyncActiveMode,
  SyncMode,
} from '@inkeep/open-knowledge-core/config/auto-sync-mode';
export type {
  bindConfigDoc,
  ConfigBinding,
  ConfigBindingPatchResult,
} from '@inkeep/open-knowledge-core/config/bind-config-doc';
export type {
  bindOkignoreDoc,
  OkignoreBinding,
} from '@inkeep/open-knowledge-core/config/bind-okignore-doc';
export type {
  ConfigIssue,
  ConfigValidationError,
  humanFormat,
  isKnownConfigError,
  WriteScope,
} from '@inkeep/open-knowledge-core/config/errors';
export type { getFieldMeta } from '@inkeep/open-knowledge-core/config/field-registry';
export type { mergeLayered } from '@inkeep/open-knowledge-core/config/merge-layered';
export type {
  Config,
  ConfigPatch,
  ConfigSchema,
  checkEmbeddingsBaseUrl,
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS,
  DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS,
  DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE,
  DEFAULT_EMBEDDINGS_MODEL,
  DEFAULT_TUNNEL_PORT,
  MAX_EMBEDDINGS_DOC_TIMEOUT_MS,
  MAX_EMBEDDINGS_MAX_BATCH_CHARS,
  MAX_EMBEDDINGS_MAX_BATCH_SIZE,
  MIN_EMBEDDINGS_DOC_TIMEOUT_MS,
  MIN_EMBEDDINGS_MAX_BATCH_CHARS,
  MIN_EMBEDDINGS_MAX_BATCH_SIZE,
  normalizeAttachmentFolderPath,
} from '@inkeep/open-knowledge-core/config/schema';
export type { resolveLeafSchema } from '@inkeep/open-knowledge-core/config/schema-leaf';
export type {
  evictStaleEntries,
  FLASH_DEBOUNCE_MS,
  FLASH_DURATION_MS,
  hasNewEntries,
} from '@inkeep/open-knowledge-core/constants/activity';
export type {
  CC1_CONTRACT_VERSION,
  CONFIG_DOC_NAME_OKIGNORE,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  CONFIG_DOC_NAMES,
  externalSkillFileLiveDocName,
  externalSkillLiveDocName,
  isExternalSkillDocName,
  isManagedArtifactDocName,
  MANAGED_ARTIFACT_SCOPES,
  ManagedArtifactScope,
  parseExternalSkillDocName,
  parseGlobalSkillBundleDoc,
  parseLegacyTemplateDocName,
  parseManagedArtifactName,
  parseProjectSkillBundleDoc,
  parseTemplateContentDocName,
  projectSkillContentDocName,
  SYSTEM_DOC_NAME,
  skillFileLiveDocName,
  skillLiveDocName,
  stripMdExt,
  templateContentDocName,
} from '@inkeep/open-knowledge-core/constants/cc1';
export type { CHROME_BG_DARK, CHROME_BG_LIGHT } from '@inkeep/open-knowledge-core/constants/chrome';
export type {
  codeLanguageForExtension,
  EDITABLE_TEXT_EXTRA_LANGUAGE,
  isEditableTextDocFile,
} from '@inkeep/open-knowledge-core/constants/code-languages';
export type { CreateNewBannerKind } from '@inkeep/open-knowledge-core/constants/create-new-banner';
export type {
  CREATE_NEW_PROJECT_FAILURE_REASONS,
  CreateNewProjectFailureReason,
} from '@inkeep/open-knowledge-core/constants/create-new-project-reason';
export type { LINEAGE_EPOCH_KEY } from '@inkeep/open-knowledge-core/constants/doc-lifecycle';
export type {
  DOCUMENT_OPEN_BYTE_LIMIT,
  isDocumentOverOpenByteLimit,
  TEXT_DOC_OPEN_BYTE_LIMIT,
} from '@inkeep/open-knowledge-core/constants/document-open';
export type {
  EDITOR_LABELS,
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_USER_SKILL_ROOT,
  EditorId,
  RESERVED_PROJECT_SKILL_NAME,
  receivesProjectIntegrationWrite,
  STABLE_EDITOR_PROJECT_CONFIG_PATH,
} from '@inkeep/open-knowledge-core/constants/editors';
export type {
  detectEmbeddedHostFromBrowser,
  EmbeddedHost,
} from '@inkeep/open-knowledge-core/constants/embedded-host';
export type { SHOW_INSTALL_SKILL } from '@inkeep/open-knowledge-core/constants/feature-flags';
export type { normalizeGitHostname } from '@inkeep/open-knowledge-core/constants/github';
export type {
  isOrphanMode,
  ORPHAN_MODES,
  OrphanMode,
} from '@inkeep/open-knowledge-core/constants/graph';
export type { MANUAL_CHECK_NOTICE_EXPIRY_MS } from '@inkeep/open-knowledge-core/constants/manual-update-check';
export type {
  OPEN_KNOWLEDGE_MCP_WRITE_TOOLS,
  SERVER_TIMEOUT_ERROR_PREFIX,
  SERVER_UNREACHABLE_ERROR_PREFIX,
} from '@inkeep/open-knowledge-core/constants/mcp';
export type {
  OPEN_KNOWLEDGE_DISCORD_URL,
  OPEN_KNOWLEDGE_DOCS_URL,
  OPEN_KNOWLEDGE_GITHUB_URL,
} from '@inkeep/open-knowledge-core/constants/menu-labels';
export type { NativeMenuLabelKey } from '@inkeep/open-knowledge-core/constants/native-menu-labels';
export type {
  PREVIEW_EMBED_STARTERS,
  PreviewEmbedStarter,
} from '@inkeep/open-knowledge-core/constants/preview-embed-starters';
export type { PREVIEW_THEME_TOKENS } from '@inkeep/open-knowledge-core/constants/preview-theme-tokens';
export type {
  DESKTOP_PRODUCTS,
  desktopChannelLabel,
} from '@inkeep/open-knowledge-core/constants/product';
export type {
  AGENTS_SKILLS_ROOT,
  isSkillRefCandidate,
  OPENKNOWLEDGE_SKILLS_REPO,
  PACK_SKILL_PREFIX,
  SKILL_REF_RE,
} from '@inkeep/open-knowledge-core/constants/skills';
export type {
  UNINSTALL_FEEDBACK_EMAIL_MAX_LEN,
  UNINSTALL_FEEDBACK_NOTE_MAX_LEN,
  UNINSTALL_FEEDBACK_REASONS,
  UninstallFeedbackReason,
} from '@inkeep/open-knowledge-core/constants/uninstall-feedback';
export type {
  ALLOWED_IMAGE_MIME_TYPES,
  ASSET_EXTENSIONS,
  AUDIO_EXTENSIONS,
  DEFAULT_ATTACHMENT_FOLDER_PATH,
  DEFAULT_DEDUP_UI,
  DEFAULT_EMIT_FORMAT,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  FILE_ATTACHMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
  InlineAssetMediaKind,
  isExcalidrawDocFile,
  isMarkdownDocFile,
  isMermaidDocFile,
  mediaKindForSidebarAssetExtension,
  VIDEO_EXTENSIONS,
  WIKI_EMBED_EXTENSIONS,
} from '@inkeep/open-knowledge-core/constants/upload';
export type { CodeBlockFidelity } from '@inkeep/open-knowledge-core/extensions/code-block-fidelity';
export type {
  collectFootnoteIdentifiers,
  findFootnoteDefinitionInsertPos,
  nextFootnoteIdentifier,
} from '@inkeep/open-knowledge-core/extensions/footnote-reference';
export type {
  FM_FENCE_LINE_RE,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core/extensions/frontmatter';
export type { ImageReferenceFidelity } from '@inkeep/open-knowledge-core/extensions/image-reference-fidelity';
export type { ImageSrcFidelity } from '@inkeep/open-knowledge-core/extensions/image-src-fidelity';
export type { JsxComponent } from '@inkeep/open-knowledge-core/extensions/jsx-component';
export type { JsxInline } from '@inkeep/open-knowledge-core/extensions/jsx-inline';
export type {
  isAllowedLinkUri,
  LinkFidelity,
  LinkStyle,
} from '@inkeep/open-knowledge-core/extensions/link-fidelity';
export type { MathInline } from '@inkeep/open-knowledge-core/extensions/math-inline';
export type { RawMdxFallback } from '@inkeep/open-knowledge-core/extensions/raw-mdx-fallback';
export type { sharedExtensions } from '@inkeep/open-knowledge-core/extensions/shared';
export type { Tag } from '@inkeep/open-knowledge-core/extensions/tag';
export type {
  getWikiLinkText,
  normalizeNullableString,
  parseWikiLink,
  WikiLink,
} from '@inkeep/open-knowledge-core/extensions/wiki-link';
export type { WikiLinkEmbed } from '@inkeep/open-knowledge-core/extensions/wiki-link-embed';
export type {
  FrontmatterValidationError,
  fieldErrorsFromError,
} from '@inkeep/open-knowledge-core/frontmatter/errors';
export type {
  FrontmatterMap,
  FrontmatterPatch,
  FrontmatterType,
  FrontmatterValue,
  frontmatterValuesEqual,
  inferType,
  isFrontmatterValueEmpty,
  RESERVED_FRONTMATTER_KEY,
} from '@inkeep/open-knowledge-core/frontmatter/schema';
export type {
  extractFrontmatterTags,
  FRONTMATTER_TAG_GRAMMAR_HINT,
  FRONTMATTER_TAG_VALUE_RE,
  isValidFrontmatterTagValue,
} from '@inkeep/open-knowledge-core/frontmatter/tags';
export type {
  diffFrontmatter,
  FrontmatterDelta,
  PropertyChange,
} from '@inkeep/open-knowledge-core/frontmatter-diff';
export type {
  WorktreeInventoryEntry,
  WorktreeInventoryLocation,
  WorktreeInventoryModel,
  WorktreeInventoryOpenRequest,
} from '@inkeep/open-knowledge-core/git/worktree-inventory-model';
export type {
  stripRemotePrefix,
  WorktreeCreateResult,
  WorktreeSelectorEntry,
  WorktreeSelectorModel,
} from '@inkeep/open-knowledge-core/git/worktree-selector-model';
export type {
  AssembleHandoffPromptInput,
  assembleHandoffPrompt,
  buildClaudeUrl,
  buildCliLaunchArgString,
  buildCodexUrl,
  buildCursorUrl,
  buildStartupInjectionBytes,
  buildWindowsCliLaunch,
  ComposeSelection,
  CreateScenario,
  composeAskPrompt,
  composeCreatePrompt,
  composeEmptySpacePrompt,
  composeFilePrompt,
  composeFixAllProblemsPrompt,
  composeFolderPrompt,
  composeLintFixPrompt,
  composeSelectionPrompt,
  composeSkillPrompt,
  composeTerminalBareLaunchPrompt,
  composeThreadBareLaunchPrompt,
  DocContext,
  HandoffFailureReason,
  HandoffOutcome,
  HandoffPayload,
  HandoffScope,
  HandoffTarget,
  InstallState,
  OK_TERMINAL_SURFACE_PREAMBLE,
  OK_THREAD_SURFACE_PREAMBLE,
  PromptTransport,
  quoteWindowsShellPath,
  shellSingleQuote,
  startupInjectionFor,
  TargetData,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
  TerminalCli,
  TerminalLaunchCommand,
  WindowsShellFamily,
  withSkillPointer,
} from '@inkeep/open-knowledge-core/handoff';
export type { readBrowserLanguages } from '@inkeep/open-knowledge-core/i18n/browser-locale-provider';
export type { localeDirection } from '@inkeep/open-knowledge-core/i18n/direction';
export type {
  AUTO_DETECTABLE_LOCALES,
  LanguagePreference,
  PICKER_LOCALES,
  SUPPORTED_LOCALES,
  SupportedLocale,
} from '@inkeep/open-knowledge-core/i18n/locales';
export type {
  FALLBACK_LOCALE,
  resolveLocale,
} from '@inkeep/open-knowledge-core/i18n/resolve-locale';
export type {
  BUG_REPORT_ATTACHMENT_CONTENT_TYPES,
  BUG_REPORT_ATTACHMENT_EXTENSIONS,
  BUG_REPORT_SCREENSHOT_ZIP_ENTRY,
  isBugReportAgentChatEntry,
  isBugReportAttachmentEntry,
  isBugReportCrashDumpEntry,
  MAX_BUG_REPORT_ATTACHMENTS,
  MAX_BUG_REPORT_ATTACHMENTS_TOTAL_BYTES,
  OkBugReportCrashDetectedEvent,
  OkBugReportListRow,
  OkBugReportScreenshot,
  OkBugReportSendMetadata,
  OkBugReportSendResult,
  OkImageAttachmentContentType,
  ReportBundleSummary,
} from '@inkeep/open-knowledge-core/logger-types';
export type {
  LOGGER_OWNED_FIELDS,
  parseStructuredConsoleMessage,
  RENDERER_LOG_MAX_BATCH_BYTES,
  RENDERER_LOG_MAX_ENTRIES,
  RENDERER_LOG_MAX_MESSAGE_BYTES,
  truncateLogMessage,
} from '@inkeep/open-knowledge-core/logging/renderer-log';
export type { scrubSecrets } from '@inkeep/open-knowledge-core/logging/secret-scrub';
export type { MarkdownManager } from '@inkeep/open-knowledge-core/markdown';
export type {
  selectFenceChar,
  widenFenceLength,
} from '@inkeep/open-knowledge-core/markdown/code-fence';
export type {
  HtmlPayloadTooLargeError,
  htmlToMdast,
  mdastToMarkdown,
} from '@inkeep/open-knowledge-core/markdown/html-to-mdast';
export type {
  AppliesToPatternSummary,
  assertNeverOkfRuleGroupId,
  assertNeverOkfRuleId,
  compileAppliesTo,
  countDiagnosticsBySource,
  DEFAULT_LINKS_VALIDATION,
  DEFAULT_LINTER_CONFIG,
  DEFAULT_SUPPRESS_LOG_LINK_ADVISORIES,
  displayCategoryForRule,
  FrontmatterFieldConstraint,
  FrontmatterSchemaMapping,
  FrontmatterSchemasListSuccessSchema,
  FrontmatterScope,
  findRuleConfigEntry,
  findZeroMatchAppliesToPatterns,
  isAuditEmptyScopeWarning,
  isFrontmatterSchemaAsset,
  isFrontmatterScoped,
  isMarkdownlintJsonConfig,
  isOkfRuleEnabled,
  LINT_PLUGINS,
  LinksValidationSetting,
  LintConfigResponse,
  LintConfigResponseSchema,
  LintDiagnostic,
  LinterConfig,
  LintFixResult,
  LintFixResultSchema,
  LintPluginId,
  LintPosition,
  LintTextEdit,
  lintDocument,
  MARKDOWNLINT_RULE_CATALOG,
  MarkdownlintRuleSetting,
  MarkdownlintRuleSeverity,
  MarkdownlintRuleWriteValue,
  OKF_RULE_GROUPS,
  OKF_RULE_IDS,
  OkfRuleGroupId,
  OkfRuleId,
  PersistedLinterConfig,
  RULE_DISPLAY_CATEGORIES,
  RuleCatalogEntry,
  RuleDisplayCategory,
  RuleOptionSpec,
  SchemaParentPathSegment,
  selectFrontmatterOnlyConfig,
  selectGoverningFrontmatterSchemas,
  summarizeAppliesTo,
  toEffectiveBase,
  ValidationAuditCountsResponse,
  ValidationAuditCountsResponseSchema,
  ValidationAuditResponse,
  ValidationAuditResponseSchema,
  ValidationDocCounts,
  ValidationDocResult,
  ValidationSourceCounts,
  ValidationSourceKey,
} from '@inkeep/open-knowledge-core/markdown/lint';
export type {
  markdownToHtml,
  mdastToHtml,
} from '@inkeep/open-knowledge-core/markdown/mdast-to-html';
export type { markdownToPlainText } from '@inkeep/open-knowledge-core/markdown/plain-text';
export type { normalizeReferenceLabel } from '@inkeep/open-knowledge-core/markdown/reference-label';
export type { normalizeDocRelativeAssetUrl } from '@inkeep/open-knowledge-core/markdown/resolve-image-url';
export type {
  isRelativeUrl,
  isSafeUrl,
  SAFE_URL_SCHEME_RE,
  SAFE_URL_SCHEMES,
} from '@inkeep/open-knowledge-core/markdown/safe-url';
export type { INLINE_TAG_VALUE_RE } from '@inkeep/open-knowledge-core/markdown/tag-promotion';
export type {
  incrementBlockGripClickSelectFailed,
  incrementJsxActionAborted,
  incrementJsxArrowNodeSelectFailed,
  incrementJsxAutoConvertFailed,
  incrementJsxAutoConvertSucceeded,
  incrementJsxChromeDeleteFailed,
  incrementJsxKeyboardDeleteFailed,
  incrementJsxMoveFailed,
  incrementJsxPopoverCloseRestoreFailed,
  incrementJsxPropDropped,
  incrementJsxRenderFailure,
  incrementJsxStuckCopyFailed,
  incrementJsxStuckDeleteFailed,
  JsxNodeAction,
} from '@inkeep/open-knowledge-core/metrics/parse-health';
export type { createRegistry } from '@inkeep/open-knowledge-core/registry';
export type {
  JsxComponentMeta,
  PropDef,
  PropDefString,
} from '@inkeep/open-knowledge-core/registry/types';
export type {
  ActivityAgentHeader,
  ActivityBurst,
  ActivityFile,
  AgentActivitySuccessSchema,
  AgentBurstDiffSuccessSchema,
  AgentIntegrationsApplySuccessSchema,
  assertNeverSemanticQueryOutcome,
  BacklinkCountsSuccessSchema,
  BacklinkEntry,
  BacklinksSuccessSchema,
  BranchInfoResponse,
  BrokenLinkSuppression,
  CheckoutResponse,
  ClientLogEntry,
  CommentThreadMeta,
  CommentThreadMetaSchema,
  CompleteBatchSuccessSchema,
  ConflictEntryWire,
  CreateFolderSuccessSchema,
  CreatePageSuccessSchema,
  classifySemanticProviderError,
  DeletePathSuccessSchema,
  DeleteSuccessSchema,
  DispatchPayload,
  DocumentListEntry,
  DocumentListEntrySchema,
  DocumentListSuccess,
  DocumentListSuccessSchema,
  DocumentReadSuccessSchema,
  DuplicatePathSuccess,
  DuplicatePathSuccessSchema,
  FolderConfigWarningCode,
  ForwardLinkEntry,
  ForwardLinkLocalTarget,
  ForwardLinksSuccess,
  ForwardLinksSuccessSchema,
  GitHubReferencePreview,
  GitHubReferenceResponseSchema,
  GitStatusCode,
  GitWorktreeEntry,
  GitWorktreeOpenTarget,
  GitWorktreeStatusSuccess,
  HubEntry,
  HubsSuccessSchema,
  interpretSkillMoveFailure,
  isSemanticSearchOffered,
  isSkillMoveRetainedDestinationCode,
  LinkGraphSuccessSchema,
  LinkPreviewMetadata,
  LinkPreviewResponseSchema,
  LocalOpEmbeddingsTestResponse,
  LocalOpEmbeddingsTestResponseSchema,
  normalizeApiWarnings,
  OrphanEntry,
  OrphansSuccessSchema,
  PageHeadingsSuccessSchema,
  PagesSuccessSchema,
  PrepareBatchSuccessSchema,
  PrincipalSuccessSchema,
  ProblemDetails,
  ProblemDetailsSchema,
  ProblemType,
  PullOutcome,
  PushPermissionWire,
  QueueSuccessSchema,
  RenamedAssetMapping,
  RenamedDocMapping,
  RenamePathSuccessSchema,
  ResolveStrategyWire,
  SavedThemeDeleteSuccessSchema,
  SavedThemeListEntry,
  SavedThemeSaveRequest,
  SavedThemeSaveRequestSchema,
  SavedThemeSaveSuccessSchema,
  SavedThemeScheme,
  SavedThemeSchemeSchema,
  SavedThemesListSuccessSchema,
  SavedThemeUpdateRequestSchema,
  SavedThemeUpdateSuccessSchema,
  SearchSemanticStatus,
  SearchSemanticStatusSchema,
  SeedInstallPackSkillSuccess,
  SemanticIndexStatus,
  SemanticIndexStatusSchema,
  ServerInfoSuccessSchema,
  ShareConstructUrlErrorCode,
  ShareConstructUrlRequest,
  ShareConstructUrlResponse,
  ShareConstructUrlResponseSchema,
  ShareFreshness,
  SharePublishErrorCode,
  SharePublishNameCheckResponse,
  SharePublishNameCheckResponseSchema,
  SharePublishOwner,
  SharePublishOwnersResponse,
  SharePublishOwnersResponseSchema,
  SharePublishRequest,
  SharePublishResponse,
  SharePublishResponseSchema,
  SharePublishVisibility,
  ShareTargetStatusResponse,
  SKILL_NAME_REGEX,
  SkillFolderLinkPreview,
  SkillFolderLinkPreviewSchema,
  SkillFrontmatter,
  SkillInstallWarningCode,
  SkillMoveFailureOutcome,
  SkillOrigin,
  SkillScope,
  SkillsImportBulkSuccess,
  SkillsListEntry,
  SkillsListSuccessSchema,
  SkillsReimportBulkSuccess,
  SkillTargetsGetSuccess,
  SkillTargetsGetSuccessSchema,
  SyncConflictContentSuccess,
  SyncConflictContentSuccessSchema,
  SyncConflictsSuccessSchema,
  SyncErrorCode,
  SyncStatusSchema,
  semanticProviderErrorBlocks,
  TEMPLATE_NAME_REGEX,
  TemplatesListEntry,
  TemplatesListSuccessSchema,
  TrashCleanupSuccessSchema,
  UploadAssetSuccess,
  UploadAssetSuccessSchema,
  WorkspaceSuccessSchema,
} from '@inkeep/open-knowledge-core/schemas/api';
export type {
  CC1_CHANNEL_BRANCH_SWITCHED,
  CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
  CC1_CHANNEL_CONFIG_VALIDATION_REJECTED,
  CC1_CHANNEL_DISK_ACK,
  CC1BranchSwitchedPayload,
  CC1BranchSwitchedPayloadSchema,
  CC1ConfigIgnoreNestedErrorPayload,
  CC1ConfigIgnoreNestedErrorPayloadSchema,
  CC1ConfigValidationRejectedPayload,
  CC1ConfigValidationRejectedPayloadSchema,
  CC1DerivedViewPayload,
  CC1DerivedViewPayloadSchema,
  CC1DiskAckPayloadSchema,
  CC1ServerInfoPayload,
  CC1ServerInfoPayloadSchema,
  DerivedViewChannel,
  DerivedViewChannelSchema,
} from '@inkeep/open-knowledge-core/schemas/cc1';
export type {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  MAX_WORKSPACE_SEARCH_LIMIT,
  searchWorkspaceCorpus,
  WorkspaceSearchCorpus,
  WorkspaceSearchDocument,
  WorkspaceSearchKind,
  workspaceSearchBasename,
} from '@inkeep/open-knowledge-core/search/workspace-search';
export type { planHasOutstandingWork } from '@inkeep/open-knowledge-core/seed-plan-work';
export type {
  BranchMatchOutcome,
  canonicalGitHubRemoteUrl,
  classifyBranchMatch,
  ExpectedShareRepo,
} from '@inkeep/open-knowledge-core/sharing';
export type {
  isSkillInstallTarget,
  SkillInstallTarget,
  SkillTargetEditor,
  SkillTargetEditorSchema,
  SkillUserTargetEditor,
  SkillUserTargetEditorSchema,
} from '@inkeep/open-knowledge-core/skill-targets/schema';
export type {
  CatalogSkill,
  PluginBundleMetadata,
  PluginSourceMetadata,
  SkillDetail,
  SkillDiscover,
  SkillPreview,
  SkillRefResolution,
  SkillSearchResult,
  SkillsInstalledSuccess,
  SkillsSearchSuccess,
} from '@inkeep/open-knowledge-core/skills-catalog/schema';
export type { catalogRawScopeToOkScope } from '@inkeep/open-knowledge-core/skills-catalog/scope';
export type {
  ALWAYS_ON_TOKEN_BUDGET,
  estimateSkillCost,
  ON_TRIGGER_TOKEN_BUDGET,
  SkillCostTiers,
} from '@inkeep/open-knowledge-core/skills-catalog/skill-cost';
export type {
  isLocalSkillSource,
  parseSkillsShCatalogSource,
  skillsShSkillLinks,
} from '@inkeep/open-knowledge-core/skills-catalog/source-fields';
export type { SyncPausedReason } from '@inkeep/open-knowledge-core/sync-paused-reason';
export type {
  DEFAULT_TERMINAL_PLACEMENT,
  MIN_TERMINAL_RIGHT_WIDTH,
  normalizeTerminalPlacement,
  normalizeTerminalRightWidth,
  PREFERRED_TERMINAL_RIGHT_WIDTH,
  TerminalPlacement,
} from '@inkeep/open-knowledge-core/terminal-layout';
export type {
  AnsiSlotName,
  BASE16_SLOT_ROLES,
  BASE16_SLOTS,
  Base16Palette,
  Base16ParseError,
  Base16Scheme,
  Base16Slot,
  base16ToTokens,
  base16ToYaml,
  isBase16Hex,
  mixHex,
  parseBase16Scheme,
  relativeLuminance,
} from '@inkeep/open-knowledge-core/theme/base16';
export type {
  ColorThemeSelection,
  ColorThemeSelectionInput,
  deriveSavedThemeName,
  generateColorThemesCss,
  isDarkTheme,
  parseSavedThemeId,
  renderThemeBlock,
  resolveColorThemeSelection,
  resolveModePreference,
  resolveThemePlugin,
  THEME_PLUGINS,
  ThemePlugin,
} from '@inkeep/open-knowledge-core/theme/theme-plugins';
export type {
  AgentFlashEntry,
  AgentPresenceEntry,
  AwarenessState,
  AwarenessUser,
  isPresenceSentinelDocName,
} from '@inkeep/open-knowledge-core/types/awareness';
export type { Identity } from '@inkeep/open-knowledge-core/types/identity';
export type { Principal } from '@inkeep/open-knowledge-core/types/principal';
export type { TimelineEntry } from '@inkeep/open-knowledge-core/types/timeline';
export type {
  OkUninstallBridge,
  UNINSTALL_RESULT_WAIT_TIMEOUT_MS,
  UninstallDispatchResult,
  UninstallIntent,
  UninstallNoticeChecklistItem,
  UninstallNoticeScreen,
  UninstallProjectRow,
  UninstallScreenSpec,
} from '@inkeep/open-knowledge-core/uninstall-bridge';
export type {
  isHiddenDocName,
  isProjectSkillBundlePath,
} from '@inkeep/open-knowledge-core/util/doc-name';
export type { toDesktopAssetHref } from '@inkeep/open-knowledge-core/utils/asset-href';
export type {
  ChunkedInsertError,
  chunkedYTextInsert,
} from '@inkeep/open-knowledge-core/utils/chunked-insert';
export type { createCodeFenceTracker } from '@inkeep/open-knowledge-core/utils/code-fence-tracker';
export type { rewriteEmbedUrl } from '@inkeep/open-knowledge-core/utils/embed-url-rewrite';
export type { extensionOf } from '@inkeep/open-knowledge-core/utils/extension';
export type { formatFileSize } from '@inkeep/open-knowledge-core/utils/file-size';
export type { getGitHubStars } from '@inkeep/open-knowledge-core/utils/github-stars';
export type { scanHeadingLine } from '@inkeep/open-knowledge-core/utils/heading-scan';
export type {
  AGENT_ICON_COLORS,
  AGENT_ICON_COLORS_DARK,
  colorFromSeed,
  computeInitials,
  deriveIconColor,
  formatPresenceLabel,
  getIdentity,
  HUMAN_COLORS,
  iconFromClientName,
  SYSTEM_WRITER_DISPLAY_NAMES,
} from '@inkeep/open-knowledge-core/utils/identity';
export type {
  assertNeverLinkTarget,
  buildRelativeMarkdownHref,
  ClassifiedLinkTarget,
  classifyMarkdownHref,
  DocLinkTarget,
  extractAssetExtension,
  isExternalHref,
  resolveAssetProjectPath,
} from '@inkeep/open-knowledge-core/utils/link-targets';
export type { isLoomUrl, parseLoomUrl } from '@inkeep/open-knowledge-core/utils/loom-embed';
export type { parsePdfAnchor } from '@inkeep/open-knowledge-core/utils/pdf-anchor';
export type { randomUUID } from '@inkeep/open-knowledge-core/utils/random-uuid';
export type { formatRelativeAge } from '@inkeep/open-knowledge-core/utils/relative-time';
export type {
  decodeHrefPath,
  resolveInternalHref,
} from '@inkeep/open-knowledge-core/utils/resolve-internal-href';
export type { sanitizeFolderName } from '@inkeep/open-knowledge-core/utils/sanitize-folder-name';
export type {
  getHeadingSlug,
  HeadingEntry,
  toWikiLinkSlug,
  wikiLinkHref,
} from '@inkeep/open-knowledge-core/utils/slug';
export type {
  DependencySlug,
  dependencySlug,
  IdentityKey,
  identityKey,
  leafKey,
  TARGET_IDENTITY,
  TargetKind,
} from '@inkeep/open-knowledge-core/utils/target-identity';
export type {
  asTargetNamespace,
  createTargetNamespace,
  isTargetNamespace,
  MutableTargetNamespace,
  resolveName,
  TargetMatch,
  TargetNamespace,
} from '@inkeep/open-knowledge-core/utils/target-namespace';
export type { isVimeoUrl } from '@inkeep/open-knowledge-core/utils/vimeo-embed';
export type {
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  buildWikiLinkAssetTargetKeys,
  getWikiLinkResolutionCandidates,
  isResolvedWikiLinkTarget,
  resolveWikiLinkAssetTarget,
  resolveWikiLinkTarget,
  resolveWikiLinkTargetDocName,
  WikiLinkLookupIndex,
} from '@inkeep/open-knowledge-core/utils/wiki-link-resolve';
export type {
  ParsedYouTubeUrl,
  parseYouTubeUrl,
} from '@inkeep/open-knowledge-core/utils/youtube-embed';
