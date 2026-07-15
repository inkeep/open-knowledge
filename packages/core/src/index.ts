// Burst-grouping utility
export {
  type Burst,
  bucketIntoBursts,
  type HumanEdit,
  type SessionTransaction,
} from './burst-grouping.ts';
// Client→server version metadata — the v1 wire contract builders.
export {
  CLIENT_RUNTIME_VERSION_FALLBACK,
  CLIENT_VERSION_HEADER,
  type ClientKind,
  type ClientVersionInput,
  type ClientVersionTokenFields,
  clientVersionHeaders,
  clientVersionTokenFields,
} from './client-version.ts';
// Logger types — typed contract for structured logging. Runtime lives in
// `packages/server/src/logger.ts`; types stay here so renderer-side code can
// import them without dragging pino/pino-roll into the renderer bundle.
export type {
  BundleManifest,
  BundleRedaction,
  ClassifiedPath,
  Loggable,
  LogLevel,
  LogPayload,
  OkBugReportCrashAckResult,
  OkBugReportCrashDetectedEvent,
  OkBugReportCreateResult,
  OkBugReportSendFallbackReason,
  OkBugReportSendMetadata,
  OkBugReportSendResult,
  ReportBundleLevel,
  ReportBundleSummary,
  SerializedError,
  SerializedErrorTruncation,
} from './logger-types.ts';
export { LOG_LEVELS } from './logger-types.ts';
// Renderer/browser console-capture helpers (level mapping, structured-message
// unwrap, batch bounds) shared by the desktop main listener, the server
// `/api/client-logs` ingest, and the web renderer forwarder.
export {
  mapConsoleLevel,
  parseStructuredConsoleMessage,
  RENDERER_LOG_MAX_BATCH_BYTES,
  RENDERER_LOG_MAX_ENTRIES,
  RENDERER_LOG_MAX_MESSAGE_BYTES,
  type RendererLogLevel,
  truncateLogMessage,
} from './logging/renderer-log.ts';
// Cross-process contract version (pure integer; browser-safe).
export { PROTOCOL_VERSION } from './protocol-version.ts';

// Markdown pipeline (new unified+remark)

// Re-export VFileMessage for Observer B's error classification (instanceof check
// instead of fragile constructor.name string comparison).
export { VFileMessage } from 'vfile-message';
// Headless config writers + UI ConfigBinding.
// Browser+node compatible — no Node deps; structural ConfigDocProvider type
// keeps `@hocuspocus/provider` out of core's runtime deps.
export {
  bindConfigDoc,
  type ConfigBinding,
  type ConfigBindingPatchResult,
  type ConfigBindingPatchSuccess,
  type ConfigDocProvider,
  type Unsubscribe,
} from './config/bind-config-doc.ts';
export {
  type BindOkignoreDocOptions,
  bindOkignoreDoc,
  type OkignoreBinding,
  type OkignoreBindingPatchResult,
  type OkignoreBindingPatchSuccess,
  type OkignoreBindingRejection,
  type OkignoreBindingStatus,
  type OkignoreDocProvider,
  type OkignoreUnsubscribe,
} from './config/bind-okignore-doc.ts';
export {
  type ConfigIssue,
  ConfigIssueSchema,
  type ConfigIssueSource,
  ConfigIssueSourceSchema,
  type ConfigValidationError,
  ConfigValidationErrorSchema,
  type FieldScope,
  FieldScopeSchema,
  type ForwardCompatConfigError,
  ForwardCompatConfigErrorSchema,
  humanFormat,
  isKnownConfigError,
  type KnownConfigValidationError,
  KnownConfigValidationErrorSchema,
  type WriteScope,
  WriteScopeSchema,
} from './config/errors.ts';
export {
  type FieldMeta,
  fieldRegistry,
  getFieldMeta,
} from './config/field-registry.ts';
export { mergeLayered } from './config/merge-layered.ts';
export {
  type DetectRemovedKeysInput,
  detectRemovedKeys,
  REMOVED_KEYS,
  type RemovedKey,
} from './config/removed-keys.ts';
export type { Err, Ok, Result } from './config/result.ts';
// Config schema, error envelope, and Result helper. Browser+node compatible.
export {
  type Config,
  type ConfigPatch,
  ConfigSchema,
  checkEmbeddingsBaseUrl,
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_MODEL,
  DEFAULT_LOGS_MAX_BYTES,
  DEFAULT_SPANS_MAX_BYTES,
  DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST,
  isValidAttachmentFolderPath,
  normalizeAttachmentFolderPath,
} from './config/schema.ts';
export { getLeafFieldMeta, resolveLeafSchema } from './config/schema-leaf.ts';
export { CONFIG_SCHEMA_MAJOR, CONFIG_SCHEMA_MAJOR_PATH } from './config/schema-version.ts';
export { type LocateOptions, locateIssue } from './config/source-locator.ts';
// OTel helpers for config-edit spans. Browser+node compatible — imports
// only `@opentelemetry/api`. Spans are inert no-ops when no SDK is
// registered (server: OTEL_SDK_DISABLED gate; app: VITE_OTEL_ENABLED gate).
export {
  addConfigSpanEvent,
  type ConfigOutcome,
  type ConfigScopeAttr,
  type ConfigSpanAttributes,
  type ConfigTransport,
  type ConfigValidationLayer,
  setConfigOutcome,
  withConfigSpan,
  withConfigSpanSync,
} from './config/telemetry.ts';
// Constants
export {
  ACTIVITY_TTL_MS,
  evictStaleEntries,
  FLASH_DEBOUNCE_MS,
  FLASH_DURATION_MS,
  hasNewEntries,
} from './constants/activity.ts';
export {
  CC1_CONTRACT_VERSION,
  CONFIG_DOC_NAME_OKIGNORE,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  CONFIG_DOC_NAMES,
  type ConfigDocName,
  isManagedArtifactDocName,
  MANAGED_ARTIFACT_PREFIX_SKILL,
  MANAGED_ARTIFACT_PREFIX_TEMPLATE,
  MANAGED_ARTIFACT_SCOPES,
  type ManagedArtifactScope,
  managedArtifactDocNameFromContentTarget,
  type ParsedGlobalSkillBundleDoc,
  type ParsedManagedArtifactName,
  type ParsedProjectSkillBundleDoc,
  parseGlobalSkillBundleDoc,
  parseManagedArtifactName,
  parseProjectSkillBundleDoc,
  projectSkillContentDocName,
  resolveSkillBundleWikiTarget,
  SKILL_CONTENT_ROOT,
  SYSTEM_DOC_NAME,
  skillLiveDocName,
} from './constants/cc1.ts';
export {
  CODE_FILE_BARE_NAMES_TO_LANGUAGE,
  CODE_FILE_EXTENSIONS_TO_LANGUAGE,
  codeLanguageForBareFilename,
  codeLanguageForExtension,
} from './constants/code-languages.ts';
export type { CreateNewBannerKind } from './constants/create-new-banner.ts';
export {
  CREATE_NEW_PROJECT_FAILURE_REASONS,
  type CreateNewProjectFailureReason,
} from './constants/create-new-project-reason.ts';
export {
  DEFAULT_DOC_EXTENSION,
  type DocExtension,
  SUPPORTED_DOC_EXTENSIONS,
} from './constants/doc-extensions.ts';
export { LINEAGE_EPOCH_KEY } from './constants/doc-lifecycle.ts';
export {
  DOCUMENT_OPEN_BYTE_LIMIT,
  isDocumentOverOpenByteLimit,
} from './constants/document-open.ts';
export {
  ALL_EDITOR_IDS,
  EDITOR_LABELS,
  EDITOR_PROJECT_CONFIG_PATH,
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_SETUP_DOC_SLUG,
  type EditorId,
  HOSTS_WITH_USER_SKILL_DIR,
  PROJECT_SKILL_EDITOR_IDS,
} from './constants/editors.ts';
export {
  detectEmbeddedHostFromBrowser,
  type EmbeddedHost,
  UA_PATTERNS,
} from './constants/embedded-host.ts';
export { SHOW_INSTALL_SKILL } from './constants/feature-flags.ts';
export type { OkFolderState } from './constants/folder-state.ts';
export {
  DEFAULT_GITHUB_OAUTH_CLIENT_ID,
  KNOWN_NON_GITHUB_GIT_HOSTS,
} from './constants/github.ts';
export { isOrphanMode, ORPHAN_MODES, type OrphanMode } from './constants/graph.ts';
export { GREP_MAX_RESULTS, MCP_SERVER_NAME, READ_DOCUMENT_HISTORY_DEPTH } from './constants/mcp.ts';
export { MENU_LABELS, type MenuLabelKey } from './constants/menu-labels.ts';
export { LOCAL_DIR, OK_DIR, OK_PROJECT_MARKER } from './constants/ok-dir.ts';
export {
  PREVIEW_EMBED_STARTERS,
  type PreviewEmbedStarter,
  previewEmbedFence,
} from './constants/preview-embed-starters.ts';
export {
  PREVIEW_THEME_TOKENS,
  type PreviewThemeToken,
} from './constants/preview-theme-tokens.ts';
export { PRODUCT_NAME } from './constants/product.ts';
export { DEFAULT_SERVER_HOST } from './constants/server.ts';
export {
  ALLOWED_AUDIO_MIME_TYPES,
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_PDF_MIME_TYPES,
  ALLOWED_VIDEO_MIME_TYPES,
  ASSET_EXTENSIONS,
  AUDIO_EXTENSIONS,
  CODE_FILE_EXTENSIONS,
  DEFAULT_ATTACHMENT_FOLDER_PATH,
  DEFAULT_DEDUP_MODE,
  DEFAULT_DEDUP_UI,
  DEFAULT_EMIT_FORMAT,
  type DedupMode,
  type DedupUIMode,
  type EmitFormat,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  FILE_ATTACHMENT_EXTENSIONS,
  // re-exported here as the canonical dispatch surface — same set, same
  // role, but the import for the lookup helpers lives in code-languages.
  IMAGE_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
  type InlineAssetMediaKind,
  isMermaidDocFile,
  LINKABLE_ASSET_EXTENSIONS,
  MERMAID_FILE_EXTENSIONS,
  mediaKindForSidebarAssetExtension,
  PDF_EXTENSIONS,
  SANDBOXED_HTML_CSP,
  SANDBOXED_HTML_EXTENSIONS,
  SIDEBAR_AUDIO_ASSET_EXTENSIONS,
  SIDEBAR_IMAGE_ASSET_EXTENSIONS,
  SIDEBAR_PDF_ASSET_EXTENSIONS,
  SIDEBAR_RENDERABLE_ASSET_EXTENSIONS,
  SIDEBAR_TEXT_ASSET_EXTENSIONS,
  SIDEBAR_VIDEO_ASSET_EXTENSIONS,
  TEXT_VIEWER_FALLBACK_EXTENSIONS,
  VIDEO_EXTENSIONS,
  WIKI_EMBED_EXTENSIONS,
} from './constants/upload.ts';
// Extensions
export { CodeBlockFidelity } from './extensions/code-block-fidelity.ts';
export { EmphasisFidelity, StrongFidelity } from './extensions/emphasis-fidelity.ts';
export { EscapeMark } from './extensions/escape-mark.ts';
export { FootnoteDefinition } from './extensions/footnote-definition.ts';
export {
  collectFootnoteIdentifiers,
  FootnoteReference,
  findFootnoteDefinitionInsertPos,
  nextFootnoteIdentifier,
} from './extensions/footnote-reference.ts';
export {
  FM_FENCE_LINE_RE,
  FRONTMATTER_RE,
  prependFrontmatter,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from './extensions/frontmatter.ts';
export { HardBreakFidelity } from './extensions/hard-break-fidelity.ts';
export { HeadingFidelity } from './extensions/heading-fidelity.ts';
export { HtmlBlockFidelity } from './extensions/html-block-fidelity.ts';
export { ImageSrcFidelity } from './extensions/image-src-fidelity.ts';
export { JsxComponent } from './extensions/jsx-component.ts';
export { JsxInline } from './extensions/jsx-inline.ts';
export { isAllowedLinkUri, LinkFidelity, type LinkStyle } from './extensions/link-fidelity.ts';
export { LinkRefDefFidelity } from './extensions/link-ref-def-fidelity.ts';
export { List, ListItem, ListItemNode, ListNode } from './extensions/list.ts';
export { MathInline } from './extensions/math-inline.ts';
export { RawMdxFallback } from './extensions/raw-mdx-fallback.ts';
export { sharedExtensions } from './extensions/shared.ts';
export { Tag } from './extensions/tag.ts';
export { ThematicBreakFidelity } from './extensions/thematic-break-fidelity.ts';
export {
  getWikiLinkText,
  normalizeNullableString,
  parseWikiLink,
  renderWikiLink,
  WikiLink,
  type WikiLinkAttrs,
} from './extensions/wiki-link.ts';
// `WikiLinkEmbed` is transient: client-insert-only at drop time, never
// emitted by server-side mdast→PM dispatch. Post round-trip
// the node becomes PM `image` (image ext) or PM text+link mark (non-
// image), NOT this PM node type. Still re-exported symmetrically with
// the `WikiLink` peer so future consumers that need the node type or
// attr shape directly (e.g. a non-default editor surface, a schema
// introspection tool, a typed-component-nodes consumer) have a
// public import path. Binding to the shape is an intentional contract
// — the attrs (`target` / `alias` / `anchor` / `resolvedSrc`) are
// schema-add-only per precedent #9, so the export commits to additive
// evolution only.
export {
  WikiLinkEmbed,
  type WikiLinkEmbedAttrs,
} from './extensions/wiki-link-embed.ts';
export { parseBranchList } from './git/branch-list-parser.ts';
export {
  type BridgeWorktreeEntry,
  parseWorktreeListPorcelain,
} from './git/worktree-list-parser.ts';
export { WORKTREES_PARENT_DIR, worktreeRelativeDir } from './git/worktree-path.ts';
export {
  type BuildWorktreeSelectorModelInput,
  buildWorktreeSelectorModel,
  stripRemotePrefix,
  type WorktreeCreateRequest,
  type WorktreeCreateResult,
  type WorktreeListResult,
  type WorktreeSelectorEntry,
  type WorktreeSelectorModel,
} from './git/worktree-selector-model.ts';
// Handoff — Open-in-Agent dropdown
// + URN→IPC reason registry (`urn-ipc-registry.ts`).
export {
  type AssembleHandoffPromptInput,
  assembleHandoffPrompt,
  assertNeverUrnIpcLookup,
  buildClaudeLaunchCommand,
  buildClaudeUrl,
  buildCliLaunchArgString,
  buildCliLaunchCommand,
  buildCodexUrl,
  buildCursorUrl,
  type ComposeSelection,
  type CreateScenario,
  composeAskProjectPrompt,
  composeAskPrompt,
  composeCreatePrompt,
  composeEmptySpacePrompt,
  composeFilePrompt,
  composeFolderPrompt,
  composeSelectionPrompt,
  composeSkillPrompt,
  composeTerminalBareLaunchPrompt,
  type DocContext,
  type HandoffFailureReason,
  type HandoffOutcome,
  type HandoffPayload,
  type HandoffScope,
  type HandoffTarget,
  type InstallState,
  type IpcChannelReason,
  type IpcChannelWithUrn,
  lookupUrnInRegistry,
  OK_GATED_TOOL_NAMES,
  OK_PROJECT_SKILL_POINTER,
  OK_TERMINAL_SURFACE_PREAMBLE,
  shellSingleQuote,
  type TargetData,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
  type TerminalCli,
  type TerminalCliInfo,
  URN_HTTP_ONLY,
  URN_IPC_REGISTRY,
  type UrnIpcLookup,
  withSkillPointer,
} from './handoff/index.ts';
export {
  HTML_MAX_BYTES,
  HtmlPayloadTooLargeError,
  htmlToMdast,
  mdastToMarkdown,
} from './markdown/html-to-mdast.ts';
export { MarkdownManager, type SerializeCallOptions } from './markdown/index.ts';
export { markdownToHtml, mdastToHtml } from './markdown/mdast-to-html.ts';
export { normalizeDocRelativeAssetUrl } from './markdown/resolve-image-url.ts';
export {
  isRelativeUrl,
  isSafeUrl,
  SAFE_URL_SCHEME_RE,
  SAFE_URL_SCHEMES,
} from './markdown/safe-url.ts';
export {
  createTagInTextRegex,
  INLINE_TAG_VALUE_RE,
  TAG_IN_TEXT_PATTERN_SOURCE,
} from './markdown/tag-promotion.ts';
export {
  getParseHealth,
  incrementBlockFallback,
  incrementBlockGripClickSelectFailed,
  incrementJsxArrowNodeSelectFailed,
  incrementJsxAutoConvertFailed,
  incrementJsxAutoConvertSucceeded,
  incrementJsxKeyboardDeleteFailed,
  incrementJsxMoveFailed,
  incrementJsxPopoverCloseRestoreFailed,
  incrementJsxPropDropped,
  incrementJsxRenderFailure,
  incrementJsxStuckCopyFailed,
  incrementJsxStuckDeleteFailed,
  incrementWholeDocFallback,
  incrementYpsMismatchBlock,
  incrementYpsMismatchInline,
  type ParseHealthMetrics,
  resetParseHealth,
} from './metrics/parse-health.ts';
// Registry
export {
  builtInComponents,
  type ComponentRegistry,
  createRegistry,
  wildcardMeta,
} from './registry/index.ts';
export {
  type ComponentEntryFull,
  type ComponentEntryLite,
  type ComponentKind,
  type ComponentParam,
  getAgentCanonicalDescriptors,
  getCanonicalDescriptors,
  projectFull,
  projectLite,
  renderInventoryFooter,
} from './registry/projection.ts';
export type {
  ClipboardHastContext,
  JsxComponentMeta,
  PropDef,
  PropDefBase,
  PropDefBoolean,
  PropDefEnum,
  PropDefNumber,
  PropDefReactNode,
  PropDefString,
} from './registry/types.ts';
export {
  type ActivityAgentHeader,
  ActivityAgentHeaderSchema,
  type ActivityBurst,
  ActivityBurstSchema,
  type ActivityFile,
  ActivityFileSchema,
  type AdvisoryWarning,
  AdvisoryWarningSchema,
  AdvisoryWarningsSchema,
  type AgentActivitySuccess,
  AgentActivitySuccessSchema,
  type AgentBurstDiffSuccess,
  AgentBurstDiffSuccessSchema,
  type AgentPatchRequest,
  AgentPatchRequestSchema,
  type AgentPatchSuccess,
  AgentPatchSuccessSchema,
  AgentPresenceEntrySchema,
  type AgentPresenceEntryWire,
  type AgentUndoRequest,
  AgentUndoRequestSchema,
  type AgentUndoSuccess,
  AgentUndoSuccessSchema,
  type AgentWriteMdRequest,
  AgentWriteMdRequestSchema,
  type AgentWriteMdSuccess,
  AgentWriteMdSuccessSchema,
  type AgentWriteRequest,
  AgentWriteRequestSchema,
  type AgentWriteSuccess,
  AgentWriteSuccessSchema,
  type ApiConfigSuccess,
  ApiConfigSuccessSchema,
  assertNeverProblemType,
  type BacklinkCountsSuccess,
  BacklinkCountsSuccessSchema,
  type BacklinkEntry,
  BacklinkEntrySchema,
  type BacklinksSuccess,
  BacklinksSuccessSchema,
  BROKEN_LINK_REASONS,
  type BranchInfoResponse,
  BranchInfoResponseSchema,
  type BrokenLink,
  type BrokenLinkReason,
  BrokenLinkSchema,
  BrokenLinksSchema,
  type CheckoutFailureReason,
  CheckoutFailureReasonSchema,
  type CheckoutRequest,
  CheckoutRequestSchema,
  type CheckoutResponse,
  CheckoutResponseSchema,
  type ClassifiedGitAuthError,
  type ClientLogEntry,
  ClientLogEntrySchema,
  type ClientLogsRequest,
  ClientLogsRequestSchema,
  type ClientLogsSuccess,
  ClientLogsSuccessSchema,
  ConflictEntrySchema,
  type ConflictEntryWire,
  type ContentDivergenceCurrentState,
  ContentDivergenceCurrentStateSchema,
  type ContentDivergenceWarning,
  ContentDivergenceWarningSchema,
  type CreateFolderRequest,
  CreateFolderRequestSchema,
  type CreateFolderSuccess,
  CreateFolderSuccessSchema,
  type CreatePageRequest,
  CreatePageRequestSchema,
  type CreatePageSuccess,
  CreatePageSuccessSchema,
  classifyGitAuthError,
  containsXmlTag,
  type DeadLinkEntry,
  DeadLinkEntrySchema,
  type DeadLinkSource,
  DeadLinkSourceSchema,
  type DeadLinksSuccess,
  DeadLinksSuccessSchema,
  type DeletePathRequest,
  DeletePathRequestSchema,
  type DeletePathSuccess,
  DeletePathSuccessSchema,
  type DiskEditReconciledWarning,
  DiskEditReconciledWarningSchema,
  type DocumentListEntry,
  DocumentListEntrySchema,
  type DocumentListSuccess,
  DocumentListSuccessSchema,
  type DocumentReadSuccess,
  DocumentReadSuccessSchema,
  type DuplicatePathRequest,
  DuplicatePathRequestSchema,
  type DuplicatePathSuccess,
  DuplicatePathSuccessSchema,
  type EmbedDetection,
  EmbedDetectionSchema,
  type EmbedDetectSuccess,
  EmbedDetectSuccessSchema,
  EmbedProbeEntrySchema,
  type EmbedProbeEntryWire,
  type EmptyRequest,
  EmptyRequestSchema,
  type FolderConfigGetSuccess,
  FolderConfigGetSuccessSchema,
  type FolderConfigPutRequest,
  FolderConfigPutRequestSchema,
  type FolderConfigPutSuccess,
  FolderConfigPutSuccessSchema,
  type ForwardLinkDocEntry,
  ForwardLinkDocEntrySchema,
  type ForwardLinkEntry,
  ForwardLinkEntrySchema,
  type ForwardLinkExternalEntry,
  ForwardLinkExternalEntrySchema,
  type ForwardLinksSuccess,
  ForwardLinksSuccessSchema,
  type FrontmatterPatchRequest,
  FrontmatterPatchRequestSchema,
  type FrontmatterPatchSuccess,
  FrontmatterPatchSuccessSchema,
  type GitAuthFailureSubclass,
  type HeadingEntry as PageHeadingEntry,
  HeadingEntrySchema as PageHeadingEntrySchema,
  type HistoryEntry,
  HistoryEntrySchema,
  type HistoryShadowContributor,
  HistoryShadowContributorSchema,
  type HistorySuccess,
  HistorySuccessSchema,
  type HistoryVersionSuccess,
  HistoryVersionSuccessSchema,
  type HubEntry,
  HubEntrySchema,
  type HubsSuccess,
  HubsSuccessSchema,
  type InstalledAgentsSuccess,
  InstalledAgentsSuccessSchema,
  type InstallSkillRequest,
  InstallSkillRequestSchema,
  type InstallSkillSuccess,
  InstallSkillSuccessSchema,
  isBranchNotFoundGitError,
  isLoginFixableGitAuthError,
  isValidBranchName,
  type LifecycleStatus,
  LifecycleStatusSchema,
  type LinkGraphDocNode,
  LinkGraphDocNodeSchema,
  type LinkGraphEdge,
  LinkGraphEdgeSchema,
  type LinkGraphExternalNode,
  LinkGraphExternalNodeSchema,
  type LinkGraphNode,
  LinkGraphNodeSchema,
  type LinkGraphSuccess,
  LinkGraphSuccessSchema,
  type LocalOpAuthEmptySuccess,
  LocalOpAuthEmptySuccessSchema,
  type LocalOpAuthHostRequest,
  LocalOpAuthHostRequestSchema,
  type LocalOpAuthSetIdentityRequest,
  LocalOpAuthSetIdentityRequestSchema,
  type LocalOpAuthStatusSuccess,
  LocalOpAuthStatusSuccessSchema,
  type LocalOpCloneRequest,
  LocalOpCloneRequestSchema,
  type LocalOpEmbeddingsMutationSuccess,
  LocalOpEmbeddingsMutationSuccessSchema,
  type LocalOpEmbeddingsSetKeyRequest,
  LocalOpEmbeddingsSetKeyRequestSchema,
  type LocalOpOkInitFailureReason,
  LocalOpOkInitFailureReasonSchema,
  type LocalOpOkInitRequest,
  LocalOpOkInitRequestSchema,
  type LocalOpOkInitResponse,
  LocalOpOkInitResponseSchema,
  type MetricsAgentPresenceSuccess,
  MetricsAgentPresenceSuccessSchema,
  type MetricsParseHealthSuccess,
  MetricsParseHealthSuccessSchema,
  type MetricsReconciliationSuccess,
  MetricsReconciliationSuccessSchema,
  type OrphanEntry,
  OrphanEntrySchema,
  type OrphanHint,
  OrphanHintSchema,
  type OrphansSuccess,
  OrphansSuccessSchema,
  type PageEntry,
  PageEntrySchema,
  type PageHeadingsSuccess,
  PageHeadingsSuccessSchema,
  type PagesSuccess,
  PagesSuccessSchema,
  type PrincipalSuccess,
  PrincipalSuccessSchema,
  type ProblemDetails,
  ProblemDetailsSchema,
  type ProblemType,
  ProblemTypeSchema,
  PushPermissionSchema,
  type PushPermissionWire,
  type RenamedAssetMapping,
  RenamedAssetMappingSchema,
  type RenamedDocMapping,
  RenamedDocMappingSchema,
  type RenamePathRequest,
  RenamePathRequestSchema,
  type RenamePathSuccess,
  RenamePathSuccessSchema,
  type RenameRewrittenDoc,
  RenameRewrittenDocSchema,
  type RenderWarning,
  RenderWarningSchema,
  type RescueEntryFlat,
  RescueEntryFlatSchema,
  type RescueEntryTimeline,
  RescueEntryTimelineSchema,
  type RescueListSuccess,
  RescueListSuccessSchema,
  type RollbackRequest,
  RollbackRequestSchema,
  type RollbackSuccess,
  RollbackSuccessSchema,
  type SaveVersionRequest,
  SaveVersionRequestSchema,
  type SaveVersionSuccess,
  SaveVersionSuccessSchema,
  type SaveVersionWriter,
  SaveVersionWriterSchema,
  type SearchRequest,
  SearchRequestSchema,
  type SearchResultEntry,
  SearchResultEntrySchema,
  type SearchSemanticStatus,
  SearchSemanticStatusSchema,
  type SearchSource,
  type SearchSuccess,
  SearchSuccessSchema,
  type SeedApplyRequest,
  SeedApplyRequestSchema,
  type SeedApplySuccess,
  SeedApplySuccessSchema,
  type SeedListPacksSuccess,
  SeedListPacksSuccessSchema,
  type SeedPackEntryCounts,
  SeedPackEntryCountsSchema,
  type SeedPackFolderInfo,
  SeedPackFolderInfoSchema,
  type SeedPackInfo,
  SeedPackInfoSchema,
  type SeedPlanSuccess,
  SeedPlanSuccessSchema,
  type SemanticIndexStatus,
  SemanticIndexStatusSchema,
  type ServerInfoBoot,
  ServerInfoBootSchema,
  type ServerInfoSuccess,
  ServerInfoSuccessSchema,
  type ShareConstructUrlErrorCode,
  ShareConstructUrlErrorCodeSchema,
  type ShareConstructUrlRequest,
  ShareConstructUrlRequestSchema,
  type ShareConstructUrlResponse,
  ShareConstructUrlResponseSchema,
  type ShareFreshness,
  ShareFreshnessSchema,
  type SharePublishErrorCode,
  SharePublishErrorCodeSchema,
  type SharePublishNameCheckResponse,
  SharePublishNameCheckResponseSchema,
  type SharePublishOwner,
  type SharePublishOwnerKind,
  SharePublishOwnerKindSchema,
  SharePublishOwnerSchema,
  type SharePublishOwnersErrorCode,
  SharePublishOwnersErrorCodeSchema,
  type SharePublishOwnersResponse,
  SharePublishOwnersResponseSchema,
  type SharePublishRequest,
  SharePublishRequestSchema,
  type SharePublishResponse,
  SharePublishResponseSchema,
  type SharePublishVisibility,
  SharePublishVisibilitySchema,
  type ShareTargetStatusRequest,
  ShareTargetStatusRequestSchema,
  type ShareTargetStatusResponse,
  ShareTargetStatusResponseSchema,
  type ShareTargetStatusVerdict,
  ShareTargetStatusVerdictSchema,
  SKILL_INSTALL_WARNING_CODES,
  SKILL_NAME_REGEX,
  type SkillDeleteSuccess,
  SkillDeleteSuccessSchema,
  type SkillFileDeleteSuccess,
  SkillFileDeleteSuccessSchema,
  type SkillFileGetSuccess,
  SkillFileGetSuccessSchema,
  type SkillFileKind,
  SkillFileKindSchema,
  type SkillFilePutRequest,
  SkillFilePutRequestSchema,
  type SkillFilePutSuccess,
  SkillFilePutSuccessSchema,
  type SkillFrontmatter,
  SkillFrontmatterSchema,
  type SkillGetSuccess,
  SkillGetSuccessSchema,
  type SkillInstallRequest,
  SkillInstallRequestSchema,
  type SkillInstallStateSuccess,
  SkillInstallStateSuccessSchema,
  type SkillInstallSuccess,
  SkillInstallSuccessSchema,
  type SkillInstallTargetState,
  SkillInstallTargetStateSchema,
  type SkillInstallWarningCode,
  type SkillMoveRequest,
  SkillMoveRequestSchema,
  type SkillMoveSuccess,
  SkillMoveSuccessSchema,
  type SkillPayload,
  SkillPayloadSchema,
  type SkillPutRequest,
  SkillPutRequestSchema,
  type SkillPutSuccess,
  SkillPutSuccessSchema,
  type SkillRestoreRequest,
  SkillRestoreRequestSchema,
  type SkillRestoreSuccess,
  SkillRestoreSuccessSchema,
  type SkillScope,
  SkillScopeSchema,
  type SkillsListEntry,
  SkillsListEntrySchema,
  type SkillsListSuccess,
  SkillsListSuccessSchema,
  type SkillTargetsGetSuccess,
  SkillTargetsGetSuccessSchema,
  type SkillTargetsPutRequest,
  SkillTargetsPutRequestSchema,
  type SkillTargetsPutSuccess,
  SkillTargetsPutSuccessSchema,
  type SkillUninstallRequest,
  SkillUninstallRequestSchema,
  type SkillUninstallSuccess,
  SkillUninstallSuccessSchema,
  type SkillUpdateRequest,
  SkillUpdateRequestSchema,
  type SkillUpdateSuccess,
  SkillUpdateSuccessSchema,
  type SpawnCursorRequest,
  SpawnCursorRequestSchema,
  type SpawnCursorSuccess,
  SpawnCursorSuccessSchema,
  type StreamingProblemEvent,
  StreamingProblemEventSchema,
  type SuggestLinksMention,
  SuggestLinksMentionSchema,
  type SuggestLinksSuccess,
  SuggestLinksSuccessSchema,
  type SuggestLinksTarget,
  SuggestLinksTargetSchema,
  type SummaryResponseField,
  SummaryResponseFieldSchema,
  SYNC_ERROR_CODES,
  type SyncConflictContentSuccess,
  SyncConflictContentSuccessSchema,
  type SyncConflictsSuccess,
  SyncConflictsSuccessSchema,
  type SyncErrorCode,
  SyncErrorCodeSchema,
  SyncRemoteSchema,
  type SyncRemoteWire,
  type SyncResolveConflictRequest,
  SyncResolveConflictRequestSchema,
  type SyncResolveConflictSuccess,
  SyncResolveConflictSuccessSchema,
  SyncStateSchema,
  type SyncStateWire,
  SyncStatusSchema,
  type SyncStatusWire,
  type SyncTriggerRequest,
  SyncTriggerRequestSchema,
  type SyncTriggerSuccess,
  SyncTriggerSuccessSchema,
  type TagSummaryEntry,
  TagSummaryEntrySchema,
  type TagsDocEntry,
  TagsDocEntrySchema,
  type TagsForNameSuccess,
  TagsForNameSuccessSchema,
  type TagsListSuccess,
  TagsListSuccessSchema,
  TEMPLATE_NAME_REGEX,
  type TemplateDeleteSuccess,
  TemplateDeleteSuccessSchema,
  type TemplateFrontmatter,
  TemplateFrontmatterSchema,
  type TemplateGetSuccess,
  TemplateGetSuccessSchema,
  type TemplateMoveRequest,
  TemplateMoveRequestSchema,
  type TemplateMoveSuccess,
  TemplateMoveSuccessSchema,
  type TemplatePayload,
  TemplatePayloadSchema,
  type TemplatePutRequest,
  TemplatePutRequestSchema,
  type TemplatePutSuccess,
  TemplatePutSuccessSchema,
  type TemplatesListEntry,
  TemplatesListEntrySchema,
  type TemplatesListSuccess,
  TemplatesListSuccessSchema,
  type TestFlushGitSuccess,
  TestFlushGitSuccessSchema,
  type TestRescanBacklinksSuccess,
  TestRescanBacklinksSuccessSchema,
  type TestRescanFilesSuccess,
  TestRescanFilesSuccessSchema,
  type TestResetSuccess,
  TestResetSuccessSchema,
  type TrashCleanupRequest,
  TrashCleanupRequestSchema,
  type TrashCleanupSuccess,
  TrashCleanupSuccessSchema,
  type UploadAssetSuccess,
  UploadAssetSuccessSchema,
  type UploadRequest,
  UploadRequestSchema,
  type WorkspaceSuccess,
  WorkspaceSuccessSchema,
  type WriteWarning,
  WriteWarningSchema,
} from './schemas/api/index.ts';
export {
  CC1_CHANNEL_BRANCH_SWITCHED,
  CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
  CC1_CHANNEL_CONFIG_VALIDATION_REJECTED,
  CC1_CHANNEL_DISK_ACK,
  CC1_CHANNEL_SERVER_INFO,
  type CC1BranchSwitchedPayload,
  CC1BranchSwitchedPayloadSchema,
  type CC1Channel,
  type CC1ConfigIgnoreNestedErrorPayload,
  CC1ConfigIgnoreNestedErrorPayloadSchema,
  type CC1ConfigValidationRejectedPayload,
  CC1ConfigValidationRejectedPayloadSchema,
  type CC1DerivedViewPayload,
  CC1DerivedViewPayloadSchema,
  type CC1DiskAckPayload,
  CC1DiskAckPayloadSchema,
  type CC1ServerInfoPayload,
  CC1ServerInfoPayloadSchema,
  type DerivedViewChannel,
  DerivedViewChannelSchema,
} from './schemas/cc1.ts';
export {
  HIDDEN_CONFIG_BASENAMES,
  isHiddenDocName,
  isValidDocName,
  validateDocName,
} from './util/doc-name.ts';
export { toDesktopAssetHref } from './utils/asset-href.ts';
export { isEmbedUrlRewritable, rewriteEmbedUrl } from './utils/embed-url-rewrite.ts';
export { extensionOf } from './utils/extension.ts';
export { formatFileSize } from './utils/file-size.ts';
export { getGitHubStars } from './utils/github-stars.ts';
export {
  isLoomUrl,
  type ParsedLoomUrl,
  parseLoomUrl,
} from './utils/loom-embed.ts';
export { type PdfAnchorParts, parsePdfAnchor } from './utils/pdf-anchor.ts';
export { isVimeoUrl } from './utils/vimeo-embed.ts';
export {
  type ParsedYouTubeUrl,
  parseYouTubeUrl,
  youtubeEmbedUrl,
} from './utils/youtube-embed.ts';

// Desktop bridge types (`OkDesktopBridge`, `OkDesktopConfig`, etc.) are
// defined locally per package: `packages/desktop/src/shared/bridge-contract.ts`
// for the desktop preload, and a future `packages/app/src/lib/desktop-bridge-
// types.ts` for the app renderer's optional `window.okDesktop` access. Keeping
// the contract co-located instead of re-exporting from this barrel avoids
// dragging the full markdown / CRDT-bridge surface into desktop's compilation
// context (TypeScript follows barrel re-exports through workspace symlinks
// and complains about transitive deps that desktop doesn't declare directly).
// `packages/core/src/desktop-bridge.ts` is the canonical reference shape;
// drift between the per-package copies is caught by a contract-equality test.

// Shadow-repo layout helpers are NOT re-exported here — they import `node:fs`
// and would contaminate core's browser-compatibility contract. Import via the
// subpath: `import { parseWriterId } from '@inkeep/open-knowledge-core/shadow-repo-layout'`.
// CLI read path and server write path are the only consumers.

// Bridge — observer/CRDT-bridge shared utilities (precedent #14)
export {
  applyFastDiff,
  applyIncrementalDiff,
  applyPatchToFm,
  applyPathDeleteToFm,
  applyPathRenameToFm,
  applyPathReorderSeqToFm,
  applyPathReorderToFm,
  applyPathSetToFm,
  applyRenameToFm,
  applyReorderToFm,
  assertContentPreservation,
  BRIDGE_TOLERANCE_CLASSES,
  type BridgeInvariantLogPayload,
  type BridgeInvariantSite,
  type BridgeInvariantViolation,
  BridgeInvariantViolationError,
  BridgeMergeContentLossError,
  type BridgeMergeContentLossInfo,
  type BridgeMergeContentLossLogPayload,
  type BridgeMergeContentLossSide,
  type BridgeMergeContentLossWhich,
  type BridgeToleranceClass,
  type BridgeToleranceSignal,
  bindFrontmatterDoc,
  type ComparePmStructuralOptions,
  classifySeverity,
  comparePmStructural,
  compareRoundTripStructural,
  createStructuralFreshnessChecker,
  type DiffChange,
  type DocBoundarySplit,
  DUPLICATION_GATE_MIN_LINE_LENGTH,
  defaultScheduler,
  detectAppliedToleranceClasses,
  detectFmRegion,
  diffLinesFast,
  emitToleranceFire,
  type FmEditError,
  type FmEditResult,
  FORM_WRITE_ORIGIN,
  type FrontmatterBinding,
  type FrontmatterBindingPatchResult,
  type FrontmatterBindingPatchSuccess,
  type FrontmatterBindingPathResult,
  type FrontmatterBindingPathSuccess,
  type FrontmatterBindingRenameResult,
  type FrontmatterBindingRenameSuccess,
  type FrontmatterBindingReorderResult,
  type FrontmatterBindingReorderSuccess,
  type FrontmatterBindingUnsubscribe,
  type FrontmatterDocProvider,
  type FrontmatterSnapshot,
  findFirstDivergenceIndex,
  fnv1aDigest,
  type InvariantViolation,
  isParseEquivalentBridge,
  MAX_FM_REGION_BYTES,
  mergeThreeWay,
  normalizeBridge,
  overMultipliedBodyLines,
  PARSE_EQUIVALENCE_TOLERANCE,
  type ParsedFmRegion,
  type PmStructuralNode,
  parseFencedFmRegion,
  parseFmRegion,
  projectMergeBoundarySpace,
  readFmKeys,
  readFmMap,
  readFmRegionWithError,
  reattachLeadingDocBoundary,
  type Scheduler,
  type StructuralDegradeLabel,
  type StructuralDivergenceReason,
  type StructuralEquivalenceResult,
  type StructuralFreshnessChecker,
  type StructuralFreshnessCheckerOptions,
  setToleranceTelemetryHook,
  splitLeadingDocBoundary,
  structuralDivergence,
  type ToleranceClassSeverity,
  type ToleranceFireRecord,
  type ToleranceTelemetryHook,
  toBridgeInvariantLog,
} from './bridge/index.ts';
// Two-phase shutdown timing constants — shared by the CLI's idle-shutdown
// UI-sibling termination and the desktop's `stopAllOwnedServers` auto-
// update teardown. Calibrated against Hocuspocus's destroyTimeoutMs.
//
// The client ↔ collab keep-alive WebSocket primitive (`startKeepalive` and
// related types) lives at `@inkeep/open-knowledge-core/keepalive` rather
// than this barrel. It depends on `process.pid` (Node-only) and would
// erode this barrel's browser-safety contract if exported here — the same
// reason `./server` and `./shadow-repo-layout` are subpath-exported.
export {
  DEFAULT_SIGTERM_GRACE_MS,
  DEFAULT_SIGTERM_POLL_MS,
  SPAWN_ERROR_LOG,
} from './constants/lifecycle.ts';
export {
  type FrontmatterIssue,
  FrontmatterIssueSchema,
  type FrontmatterValidationError,
  FrontmatterValidationErrorSchema,
  fieldErrorsFromError,
  toFrontmatterIssue,
} from './frontmatter/errors.ts';
export {
  FRONTMATTER_TYPES,
  type FrontmatterMap,
  FrontmatterMapSchema,
  type FrontmatterPatch,
  FrontmatterPatchSchema,
  type FrontmatterType,
  FrontmatterTypeSchema,
  type FrontmatterValue,
  FrontmatterValueSchema,
  frontmatterValuesEqual,
  inferType,
  isFrontmatterValueEmpty,
  isIsoDateString,
  RESERVED_FRONTMATTER_KEY,
} from './frontmatter/schema.ts';
// Frontmatter tag extractor + per-entry validator. The frontmatter `tags:`
// grammar is more permissive than the inline `#tag` grammar (digit-leading
// values like `2026` are valid here, not inline) — see `frontmatter/tags.ts`.
export {
  extractFrontmatterTags,
  FRONTMATTER_TAG_GRAMMAR_HINT,
  FRONTMATTER_TAG_VALUE_RE,
  isValidFrontmatterTagValue,
} from './frontmatter/tags.ts';
// Frontmatter — per-key value schema + canonical YAML codec
export {
  applyPatchToDocument,
  getDocumentKeys,
  type ParsedFrontmatter,
  parseFrontmatterYaml,
  serializeFrontmatterMap,
  withFences,
} from './frontmatter/yaml-codec.ts';
export {
  emptyInstalledSkills,
  INSTALLED_SKILLS_FILENAME,
  INSTALLED_SKILLS_REL,
  INSTALLED_SKILLS_SCHEMA_VERSION,
  type InstalledSkillEntry,
  InstalledSkillEntrySchema,
  type InstalledSkillScope,
  InstalledSkillScopeSchema,
  type InstalledSkills,
  InstalledSkillsSchema,
  parseInstalledSkills,
} from './installed-skills/schema.ts';
export {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  DEFAULT_RRF_K,
  DEFAULT_VECTOR_CANDIDATE_LIMIT,
  DEFAULT_VECTOR_SIMILARITY_FLOOR,
  DEFAULT_WORKSPACE_SEARCH_LIMIT,
  MAX_WORKSPACE_SEARCH_LIMIT,
  searchWorkspaceCorpus,
  searchWorkspaceDocuments,
  type WorkspaceSearchCorpus,
  type WorkspaceSearchDocument,
  type WorkspaceSearchIntent,
  type WorkspaceSearchKind,
  type WorkspaceSearchOptions,
  type WorkspaceSearchRanking,
  type WorkspaceSearchResult,
  type WorkspaceSearchScope,
  type WorkspaceSemanticInput,
  workspaceSearchBasename,
  workspaceSearchPathSegments,
} from './search/workspace-search.ts';
export {
  type BranchMatchOutcome,
  type Candidate,
  type CandidateBridgeDeps,
  type CandidateSelection,
  type CandidateSelectionPayload,
  canonicalGitHubRemoteUrl,
  classifyBranchMatch,
  type DecodedShare,
  decodeShareUrl,
  type ExpectedShareRepo,
  encodeShareUrl,
  findRecentProjectsForRepo,
  type HeadBranchInfo,
  InvalidShareUrlError,
  type RecentProjectEntry,
  type ResolvedGitDirKind,
  selectCandidate,
  UnsupportedShareVersionError,
} from './sharing/index.ts';
export {
  emptySkillState,
  resolveBundleEnabled,
  SKILL_STATE_FILENAME,
  SKILL_STATE_REL,
  SKILL_STATE_SCHEMA_VERSION,
  SKILL_STATE_SURFACES,
  SKILL_STATE_TARGETS,
  SKILL_STATE_VERSION_RE,
  type SkillState,
  type SkillStateBundleEntry,
  SkillStateSchema,
  type SkillStateSurface,
  type SkillStateTarget,
  type SkillStateTargetEntry,
} from './skill-state/schema.ts';
export {
  parseSkillTargets,
  SKILL_TARGETS_FILENAME,
  SKILL_TARGETS_REL,
  SKILL_TARGETS_SCHEMA_VERSION,
  type SkillTargetEditor,
  SkillTargetEditorSchema,
  type SkillTargets,
  SkillTargetsSchema,
} from './skill-targets/schema.ts';
// Template file format — single-block parse/compose/instantiate (+ legacy back-compat)
export {
  composeTemplateFile,
  instantiateDoc,
  parseTemplateFile,
  TEMPLATE_IDENTITY_KEY,
  type TemplateIdentity,
  type TemplateModel,
} from './templates/template-format.ts';
// Types
export type { Actor, PrincipalId, SessionId } from './types/actor.ts';
export type {
  AgentFlashEntry,
  AgentFocusEntry,
  AgentPresenceEntry,
  AwarenessState,
  AwarenessUser,
} from './types/awareness.ts';
export type { Identity } from './types/identity.ts';
export type { Principal } from './types/principal.ts';
export type {
  EntryType,
  ShadowContributor,
  TimelineEntry,
} from './types/timeline.ts';
// `atomic-yaml-write` is NOT re-exported here — it imports `node:fs` and
// would contaminate core's browser-compatibility contract. Import via the
// server sub-barrel: `import { atomicWriteFile } from '@inkeep/open-knowledge-core/server'`.
// Utils
export { applyByPrefixSuffix } from './utils/apply-by-prefix-suffix.ts';
export { ChunkedInsertError, chunkedYTextInsert } from './utils/chunked-insert.ts';
export { createCodeFenceTracker } from './utils/code-fence-tracker.ts';
export {
  AGENT_COLORS,
  AGENT_ICON_COLORS,
  AGENT_ICON_COLORS_DARK,
  colorFromSeed,
  computeInitials,
  deriveIconColor,
  displayNameFromClientName,
  formatPresenceLabel,
  generateRandomColor,
  generateRandomName,
  getIdentity,
  HUMAN_COLORS,
  iconFromClientName,
} from './utils/identity.ts';
export {
  type AnchorLinkTarget,
  type AssetLinkTarget,
  assertNeverLinkTarget,
  buildAbsoluteMarkdownHref,
  buildRelativeMarkdownHref,
  type ClassifiedLinkTarget,
  classifyMarkdownHref,
  classifyWikiLinkTarget,
  type DocLinkTarget,
  type ExternalLinkTarget,
  extractAssetExtension,
  isExternalHref,
  resolveAssetProjectPath,
} from './utils/link-targets.ts';
export { type BasenameIndex, createBasenameIndex } from './utils/path-resolve.ts';
export { type ResolvedInternalHref, resolveInternalHref } from './utils/resolve-internal-href.ts';
export { sanitizeFolderName } from './utils/sanitize-folder-name.ts';
export {
  disambiguateSlug,
  getHeadingSlug,
  type HeadingEntry,
  toWikiLinkSlug,
  wikiLinkHref,
} from './utils/slug.ts';
export { expandTagToHierarchy, tagsMatchingPrefix } from './utils/tag-rollup.ts';
