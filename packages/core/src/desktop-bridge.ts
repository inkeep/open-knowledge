import type { CreateNewBannerKind } from './constants/create-new-banner.ts';
import type { EditorId } from './constants/editors.ts';
import type { OkFolderState } from './constants/folder-state.ts';
import type {
  WorktreeCreateRequest,
  WorktreeCreateResult,
  WorktreeListResult,
} from './git/worktree-selector-model.ts';
import type {
  TerminalCli,
  TerminalLaunchCommand,
  WindowsShellFamily,
} from './handoff/terminal-launch.ts';
import type { HandoffFailureReason, HandoffScope } from './handoff/types.ts';
import type { LanguagePreference } from './i18n/locales.ts';
import type {
  OkBugReportCrashAckResult,
  OkBugReportCrashDetectedEvent,
  OkBugReportCrashDumpAvailability,
  OkBugReportCreateResult,
  OkBugReportDeleteResult,
  OkBugReportListResult,
  OkBugReportScreenshot,
  OkBugReportSendMetadata,
  OkBugReportSendResult,
  ReportBundleLevel,
} from './logger-types.ts';
import type { LintPluginId } from './markdown/lint/types.ts';
import type { LocalOpOkInitResponse } from './schemas/api/local-op.ts';
import type {
  BranchInfoResponse,
  CheckoutResponse,
  ShareTargetStatusResponse,
} from './schemas/api/share.ts';
import type { RecentProjectEntry } from './sharing/index.ts';
import type { SkillCostTiers } from './skills-catalog/skill-cost.ts';
import type { TerminalPlacement } from './terminal-layout.ts';

export type { OkFolderState } from './constants/folder-state.ts';
export type { BridgeWorktreeEntry } from './git/worktree-list-parser.ts';
export type { RecentProjectEntry } from './sharing/index.ts';
export type { TerminalPlacement } from './terminal-layout.ts';

export interface OkTerminalRestartTab {
  ordinal: number;
  customLabel: string | null;
}

export interface OkTerminalRestartSnapshot {
  tabs: OkTerminalRestartTab[];
  activeOrdinal: number | null;
}

export interface OkTerminalDockState {
  terminalVisible: boolean;
  agentPanelVisible: boolean;
  terminal?: { order: string[]; activeKey: string | null };
  terminalSnapshot?: OkTerminalRestartSnapshot;
  agents?: { order: string[]; activeKey: string | null };
}

export type OkNoteWindowMainAction =
  | {
      readonly kind: 'active-input';
      readonly text: string;
      readonly newTab: boolean;
      readonly submit: boolean;
      readonly target?: 'agents';
    }
  | {
      readonly kind: 'agent-thread';
      readonly agentSource: 'registry' | 'custom';
      readonly agentId: string;
      readonly prompt: string | null;
      readonly docName: string | null;
      readonly titleHint: string | null;
    }
  | {
      readonly kind: 'terminal-launch';
      readonly prompt: string;
      readonly cli: TerminalCli;
      readonly stage: boolean;
    }
  | {
      readonly kind: 'reveal-comments';
      readonly docName: string;
      readonly scope: 'doc' | 'queue';
    };

export type OkNoteWindowMainActionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'invalid-action' | 'not-note-window' | 'project-not-open';
    };

export type OkTerminalDockStateUpdate =
  | {
      surface: 'terminal';
      order: string[];
      activeKey: string | null;
      terminalSnapshot: OkTerminalRestartSnapshot;
    }
  | {
      surface: 'agents';
      order: string[];
      activeKey: string | null;
    };

export type OkTerminalDockStateWriteResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'invalid-request' | 'no-window-context' | 'persist-failed' | 'ipc-unavailable';
    };

export type OkDesktopMode = 'editor' | 'navigator' | 'terminal' | 'note';

export interface OkDesktopConfig {
  readonly collabUrl: string;
  readonly apiOrigin: string;
  readonly projectPath: string;
  readonly projectName: string;
  readonly mode: OkDesktopMode;
  readonly e2eSmoke: boolean;
  readonly singleFile: boolean;
  readonly initialDoc: string | null;
  readonly freshlyCreated: boolean;
  readonly startupTraceparent?: string;
  readonly ptyAvailable: boolean;
  readonly languagePreference?: LanguagePreference;
}

export type OkMenuAction =
  | 'new-doc'
  | 'new-folder'
  | 'new-project'
  | 'rename'
  | 'delete'
  | 'close-active-tab-or-window'
  | 'toggle-sidebar'
  | 'toggle-source'
  | 'save-version'
  | 'version-history'
  | 'focus-search'
  | 'focus-command-palette'
  | 'navigate-back'
  | 'navigate-forward'
  | 'new-from-template'
  | 'duplicate'
  | 'move-to-trash'
  | 'reveal-in-finder'
  | 'send-to-ai'
  | 'copy-full-path'
  | 'copy-relative-path'
  | 'toggle-show-hidden-files'
  | 'toggle-show-ok-folders'
  | 'toggle-show-only-markdown-files'
  | 'toggle-show-skills-section'
  | 'expand-all-tree'
  | 'collapse-all-tree'
  | 'toggle-doc-panel'
  | 'toggle-terminal'
  | 'move-terminal'
  | 'toggle-agent-panel'
  | 'new-terminal'
  | 'kill-terminal'
  | 'new-worktree'
  | 'switch-worktree'
  | 'report-bug'
  | 'send-feedback';

export interface OkMenuActionOrigin {
  readonly launcherBorne: boolean;
}

export interface OkMenuActionDispatch {
  readonly action: OkMenuAction;
  readonly origin: OkMenuActionOrigin;
}

export type OkUnsubscribe = () => void;

export interface PersistedEditorPane {
  id: string;
  openTabs: string[];
  pinnedTabIds: string[];
  activeTabId: string | null;
  size: number;
}

export interface ProjectSessionState {
  updatedAt: string | null;
  panes: PersistedEditorPane[];
  focusedPaneId: string;
}

export type OkProjectEntryPoint =
  | 'create-new'
  | 'create-new-nested-redirect'
  | 'pick-existing'
  | 'recents'
  | 'deep-link'
  | 'drag-drop'
  | 'share-receive'
  | 'worktree';

export interface OkProjectOpenRequest {
  path: string;
  target: 'new-window';
  entryPoint: OkProjectEntryPoint;
  pendingDeepLinkTarget?: {
    kind: 'doc' | 'folder';
    path: string;
    repositoryPath?: string;
    contentRootDepth?: number;
  };
  pendingBranch?: string | null;
  pendingShareBranchSwitch?: {
    share: OkSharePayloadFields;
    projectPath: string;
    currentBranch: string | null;
  };
}

export type OkCheckTargetExistsResult = 'exists' | 'missing' | 'unreadable';

export interface OkHeadBranchInfo {
  readonly currentBranch: string | null;
  readonly headSha: string | null;
  readonly detached: boolean;
}

export interface OkUpdateDownloadedInfo {
  readonly version: string;
}

export interface OkUpdateRelaunchingInfo {
  readonly version: string;
}

export interface OkUpdateFetchingLatestInfo {
  readonly version: string;
}

export interface OkUpdateRelaunchFailedInfo {
  readonly version: string;
  readonly message?: string;
  readonly downloadUrl?: string;
  readonly dismissPending?: boolean;
}

export interface OkWhatsNewInfo {
  readonly version: string;
  readonly releaseUrl: string;
}

export interface OkUpdateStuckHintInfo {
  readonly downloadUrl: string;
}

export type ShareTarget =
  | { readonly kind: 'doc'; readonly docPath: string }
  | { readonly kind: 'folder'; readonly folderPath: string };

export interface OkSharePayloadFields {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly sharedUrl: string;
  readonly repositoryTarget: ShareTarget;
  readonly contentRootDepth: number | null;
  readonly target: ShareTarget;
}

export type OkShareReceivedPayload =
  | { readonly kind: 'unsupported-version' }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'project-branch-switch';
      readonly share: OkSharePayloadFields;
      readonly projectPath: string;
      readonly currentBranch: string | null;
    }
  | {
      readonly kind: 'launcher-consent';
      readonly share: OkSharePayloadFields;
      readonly candidatePath: string;
      readonly parentProjectName: string | null;
    }
  | {
      readonly kind: 'launcher-miss';
      readonly share: OkSharePayloadFields;
    };

export type ShareFolderValidationResult =
  | { readonly kind: 'ok'; readonly gitRemoteUrl: string }
  | { readonly kind: 'not-git' }
  | { readonly kind: 'no-origin' }
  | { readonly kind: 'wrong-repo'; readonly actualOwner: string; readonly actualRepo: string }
  | { readonly kind: 'wrong-host'; readonly actualHost: string }
  | { readonly kind: 'non-github' }
  | { readonly kind: 'symlink-escape' };

export type OkUpdateChannel = 'latest' | 'beta';

export type OkThemeSource = 'system' | 'light' | 'dark';

export interface OkChromeColors {
  bg: string;
  symbol: string;
}

export interface OkStateSnapshot {
  readonly channel: OkUpdateChannel;
  readonly schemaIncompatibility: {
    readonly currentBuild: string;
    readonly persistedSchemaVersion: number;
    readonly maxSupported: number;
  } | null;
}

export type OkMcpWiringEditorId = EditorId;

export interface OkMcpWiringShowPayload {
  readonly origin: 'first-run' | 'reconfigure';
  readonly detectedEditors: readonly {
    readonly id: OkMcpWiringEditorId;
    readonly label: string;
    readonly detected: boolean;
    readonly willReplace: boolean;
    readonly configPath: string | null;
    readonly entryLocator: string;
  }[];
  readonly pathInstall: {
    readonly shellDetected: boolean;
    readonly rcFilesToTouch: readonly string[];
    readonly alreadyInstalled: boolean;
  };
  readonly globalSkills: readonly {
    readonly id: string;
    readonly name: string;
    readonly paths: readonly string[];
  }[];
}

export interface OkMcpWiringConfirmRequest {
  readonly editorIds: readonly OkMcpWiringEditorId[];
  readonly pathInstall?: boolean;
  readonly skills?: readonly string[];
}

export type OkMcpWiringResult = { ok: true } | { ok: false; error: string };

export type OkIntegrationsEditorState = 'installed' | 'not-installed' | 'foreign' | 'unmanageable';

export interface OkIntegrationsStatus {
  readonly available: boolean;
  readonly editors: readonly {
    readonly id: OkMcpWiringEditorId;
    readonly label: string;
    readonly detected: boolean;
    readonly state: OkIntegrationsEditorState;
    readonly configPath: string | null;
    readonly entryLocator: string;
  }[];
  readonly path: {
    readonly shellDetected: boolean;
    readonly rcFilesToTouch: readonly string[];
    readonly installed: boolean;
  };
  readonly skills: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly installed: boolean;
    readonly onboarding: boolean;
    readonly paths: readonly string[];
    readonly size?: SkillCostTiers;
    readonly sourceDir: string;
    readonly resolvedHosts: readonly {
      readonly editor: string;
      readonly skillsRoot: string;
      readonly custom: boolean;
    }[];
  }[];
  readonly detectedEditorIds: readonly OkMcpWiringEditorId[];
}

export interface OkIntegrationsSetRequest {
  readonly component:
    | { readonly kind: 'editor'; readonly id: OkMcpWiringEditorId }
    | { readonly kind: 'path' }
    | { readonly kind: 'skill'; readonly id: string };
  readonly enabled: boolean;
}

export type OkIntegrationsSetResult =
  | { readonly ok: true; readonly status: OkIntegrationsStatus }
  | { readonly ok: false; readonly error: string; readonly status: OkIntegrationsStatus };

export type OkProjectIntegrationsFollowUp =
  | 'approve-once'
  | 'enable-manually'
  | 'auto-connect'
  | 'none';

export interface OkProjectIntegrationsStatus {
  readonly available: boolean;
  readonly hasProject: boolean;
  readonly projectDir: string | null;
  readonly editors: readonly {
    readonly id: OkMcpWiringEditorId;
    readonly label: string;
    readonly detected: boolean;
    readonly state: OkIntegrationsEditorState;
    readonly configPath: string;
    readonly entryLocator: string;
    readonly followUp: OkProjectIntegrationsFollowUp;
  }[];
  readonly skill: {
    readonly installed: boolean;
    readonly paths: readonly string[];
    readonly description: string;
    readonly hosts: readonly string[];
    readonly size?: SkillCostTiers;
    readonly sourceDir?: string;
  } | null;
}

export interface OkProjectIntegrationsSetRequest {
  readonly component:
    | { readonly kind: 'editor'; readonly id: OkMcpWiringEditorId }
    | { readonly kind: 'skill' };
  readonly enabled: boolean;
}

export type OkProjectIntegrationsSetResult =
  | { readonly ok: true; readonly status: OkProjectIntegrationsStatus }
  | { readonly ok: false; readonly error: string; readonly status: OkProjectIntegrationsStatus };

export type OkOnboardingWarningKind =
  | 'root'
  | 'home'
  | 'home-documents'
  | 'home-desktop'
  | 'home-downloads'
  | 'volumes-mount'
  | 'drive-root';

export type OkOnboardingGitState = 'present' | 'absent' | 'shell-only';

export interface OkOnboardingShowPayload {
  readonly pickedPath: string;
  readonly projectDir: string;
  readonly defaultContentDir: string;
  readonly gitState: OkOnboardingGitState;
  readonly gitRootPromoted: boolean;
  readonly warnings: readonly { readonly kind: OkOnboardingWarningKind }[];
}

export interface OkOnboardingConfirmRequest {
  readonly initGit: boolean;
  readonly contentDir: string;
  readonly additionalIgnores: string;
  readonly editorIds: readonly OkMcpWiringEditorId[];
  readonly connectEditors: boolean;
  readonly sharing: 'shared' | 'local-only';
}

export type OkOnboardingResult = { ok: true } | { ok: false; error: string };

export interface OkOnboardingProbeContentRequest {
  readonly contentDir: string;
}

export type OkOnboardingProbeContentResult =
  | {
      readonly ok: true;
      readonly count: number;
      readonly sample: readonly string[];
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly error: string };

export interface OkKeyringSmokeResult {
  ok: boolean;
  backend?: 'keyring' | 'file';
  error?: string;
  durationMs?: number;
  timestamp: string;
}

export interface OkScaffoldFileEntry {
  path: string;
  kind: 'folder' | 'file';
  contentPreview?: string;
}
export interface OkScaffoldSkipEntry {
  path: string;
  reason: 'already-exists' | 'user-content' | 'glob-collision';
}
export interface OkScaffoldPlan {
  created: OkScaffoldFileEntry[];
  skipped: OkScaffoldSkipEntry[];
  warnings: string[];
  packSkills?: { name: string; pending: boolean; conflict?: boolean }[];
  requiredPlugins?: { id: LintPluginId; pending: boolean }[];
}
export interface OkScaffoldApplyError {
  path: string;
  error: string;
}
export interface OkScaffoldApplyResult {
  applied: number;
  errors: OkScaffoldApplyError[];
  durationMs: number;
  packSkillsInstalled: string[];
  pluginsEnabled: LintPluginId[];
  packSkillConflicts: { name: string; hosts?: string[] }[];
}

export interface OkSeedError {
  kind: 'no-project' | 'prerequisite-missing' | 'invalid-root' | 'internal';
  message: string;
}

export type OkPackId =
  | 'knowledge-base'
  | 'software-lifecycle'
  | 'codebase-wiki'
  | 'plain-notes'
  | 'worldbuilding'
  | 'writing-pipeline'
  | 'entity-vault'
  | 'okf';

export interface OkSeedPlanOptions {
  rootDir?: string;
  packId?: OkPackId;
  preview?: { skillsInstallable: boolean };
}

export interface OkSeedApplyOptions {
  packId?: OkPackId;
}

export interface OkSeedPackFolderInfo {
  path: string;
  summary: string;
}

export interface OkSeedPackEntryCounts {
  files: number;
  folders: number;
}

export interface OkSeedPackInfo {
  id: OkPackId;
  name: string;
  description: string;
  defaultSubfolder?: string;
  folders: OkSeedPackFolderInfo[];
  entryCounts: OkSeedPackEntryCounts;
}

export interface OkFindEnclosingProjectRootResult {
  readonly rootPath: string;
  readonly distance: number;
}
export interface OkFindEnclosingGitRootResult {
  readonly gitRoot: string;
  readonly distance: number;
}
export type OkSeedPlanResult =
  | { ok: true; plan: OkScaffoldPlan }
  | { ok: false; error: OkSeedError };
export type OkSeedApplyResult =
  | { ok: true; result: OkScaffoldApplyResult }
  | { ok: false; error: OkSeedError };
export type OkSeedListPacksResult =
  | { ok: true; packs: OkSeedPackInfo[] }
  | { ok: false; error: { kind: 'internal'; message: string } };

export type OkLocalOpAuthSignoutResponse = { ok: true } | { ok: false; error?: string };

export type OkLocalOpAuthEvent =
  | {
      type: 'verification';
      user_code: string;
      verification_uri: string;
      expires_in: number;
    }
  | {
      type: 'complete';
      host: string;
      login: string;
      name?: string;
      email?: string;
      avatarUrl?: string;
    }
  | { type: 'error'; message: string };

export type OkLocalOpCloneEvent =
  | { type: 'progress'; phase: string; pct: number }
  | { type: 'complete'; dir: string }
  | { type: 'branch-fallback'; branch: string }
  | { type: 'error'; message: string };

export interface OkLocalOpStream<E> {
  readonly events: AsyncIterable<E>;
  cancel(): void;
}

export type OkLocalOpAuthStatusResponse =
  | {
      authenticated: true;
      host: string;
      login: string;
      tier?: 'A' | 'B' | 'C';
      name?: string;
      email?: string;
      ghAvailable?: boolean;
    }
  | { authenticated: false; host: string; error?: string; ghAvailable?: boolean };

export interface OkLocalOpRepoEntry {
  full_name: string;
  clone_url: string;
  private: boolean;
}

export type OkLocalOpAuthReposResponse =
  | { ok: true; host: string; repos: OkLocalOpRepoEntry[] }
  | { ok: false; error: string };

export type OkEditorActiveTargetSnapshot =
  | { readonly kind: 'doc'; readonly identifier: string }
  | { readonly kind: 'folder'; readonly identifier: string }
  | { readonly kind: 'asset'; readonly identifier: string }
  | { readonly kind: null };

export interface OkEditorViewMenuStateSnapshot {
  readonly showHiddenFiles: boolean;
  readonly showOkFolders: boolean;
  readonly showOnlyMarkdownFiles: boolean;
  readonly showSkillsSection: boolean;
  readonly canExpandAll: boolean;
  readonly canCollapseAll: boolean;
  readonly sidebarVisible: boolean;
  readonly docPanelVisible?: boolean;
  readonly terminalVisible?: boolean;
  readonly terminalPlacement?: TerminalPlacement;
  readonly terminalLive?: boolean;
  readonly agentPanelVisible?: boolean;
  readonly canViewInSource?: boolean;
  readonly hasEditorSelection?: boolean;
}

export type OkMenuDispatchRole =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'reload'
  | 'forceReload'
  | 'toggleDevTools'
  | 'resetZoom'
  | 'zoomIn'
  | 'zoomOut'
  | 'toggleFullScreen'
  | 'minimize'
  | 'close'
  | 'quit';

export type OkMenuDispatchCommand =
  | 'open-navigator'
  | 'open-folder-dialog'
  | 'clear-recent-projects'
  | 'open-settings'
  | 'check-for-updates'
  | 'reconfigure-mcp-wiring'
  | 'open-github'
  | 'toggle-spell-check';

export type OkMenuDispatchRequest =
  | { readonly kind: 'query' }
  | { readonly kind: 'menu-action'; readonly action: OkMenuAction }
  | { readonly kind: 'command'; readonly command: OkMenuDispatchCommand }
  | { readonly kind: 'open-recent-project'; readonly path: string }
  | { readonly kind: 'role'; readonly role: OkMenuDispatchRole };

export interface OkMenuRendererSnapshot {
  readonly recentProjects: ReadonlyArray<{ readonly path: string; readonly name: string }>;
  readonly spellCheckEnabled: boolean;
  readonly showDevToolsMenu: boolean;
  readonly canCheckForUpdates: boolean;
  readonly canReconfigureMcpWiring: boolean;
  readonly activeTarget: OkEditorActiveTargetSnapshot;
  readonly viewMenuState: OkEditorViewMenuStateSnapshot;
}

export interface OkBugReportSendInput {
  zipPath: string;
  metadata: OkBugReportSendMetadata;
  includeScreenshot?: boolean;
  traceparent?: string;
}

export interface OkSharingStatusResult {
  readonly kind: 'status';
  readonly mode: 'shared' | 'local-only' | 'no-git';
  readonly excluded: readonly string[];
  readonly trackedUpstream: readonly string[];
}

export type OkSharingSetModeResult =
  | { readonly kind: 'applied'; readonly mode: 'shared' | 'local-only' | 'no-git' }
  | {
      readonly kind: 'refused-tracked';
      readonly tracked: readonly string[];
      readonly remediation: string;
    }
  | {
      readonly kind: 'no-exclude';
      readonly reason: 'no-git' | 'no-info-dir' | 'malformed-pointer' | 'inaccessible';
    };

export type SlidevSource = 'project-local' | 'global';

export type OkSlidesStatusResult =
  | { readonly kind: 'status'; readonly available: true; readonly source: SlidevSource }
  | { readonly kind: 'status'; readonly available: false };

export type SlidevOpenFailureReason =
  | 'not-available'
  | 'invalid-path'
  | 'spawn-error'
  | 'exited-early'
  | 'cancelled'
  | 'load-failed'
  | 'renderer-failed'
  | 'timeout'
  | 'unsupported-server';

export type OkSlidesOpenResult =
  | { readonly kind: 'open'; readonly ok: true }
  | { readonly kind: 'open'; readonly ok: false; readonly reason: SlidevOpenFailureReason };

export interface OkServerVersionDriftInfo {
  readonly relation: 'older' | 'newer';
  readonly dimension: 'protocol' | 'runtime';
  readonly serverRuntime: string;
  readonly appRuntime: string;
}

export interface OkServerRestartedInfo {
  readonly appRuntime: string;
}

export interface OkRecentRemovedMissingInfo {
  readonly path: string;
  readonly projectName: string;
}

export type OkServerRestartOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'eperm' | 'other' };

export type OkPtyCreateResult =
  | { readonly ok: true; readonly ptyId: string }
  | { readonly ok: false; readonly reason: 'no-project' | 'not-consented' };

export interface OkPtyListEntry {
  readonly ptyId: string;
  readonly customLabel: string | null;
  readonly ordinal: number | null;
}

export type OkPtyAdoptResult =
  | {
      readonly ok: true;
      readonly replay: string;
      readonly shellFamily?: WindowsShellFamily;
      readonly shellNoticeReason?: Extract<TerminalShellNoticeReason, 'unsupported-family'>;
    }
  | { readonly ok: false; readonly reason: 'unknown-session' };

export interface OkPtyData {
  readonly ptyId: string;
  readonly data: string;
}

export interface OkPtyExit {
  readonly ptyId: string;
  readonly exitCode: number;
  readonly signal: number | null;
  readonly error?: string;
}

const TERMINAL_SHELL_NOTICE_REASON_VOCABULARY = [
  'config-unreadable',
  'invalid-value',
  'not-absolute',
  'not-found',
  'unsupported-family',
] as const;

export type TerminalShellNoticeReason = (typeof TERMINAL_SHELL_NOTICE_REASON_VOCABULARY)[number];

export const TERMINAL_SHELL_NOTICE_REASONS: ReadonlySet<TerminalShellNoticeReason> = new Set(
  TERMINAL_SHELL_NOTICE_REASON_VOCABULARY,
);

export function isTerminalShellNoticeReason(value: unknown): value is TerminalShellNoticeReason {
  return (
    typeof value === 'string' &&
    TERMINAL_SHELL_NOTICE_REASONS.has(value as TerminalShellNoticeReason)
  );
}

const TERMINAL_SUPPORT_FILE_NOTICE_REASON_VOCABULARY = [
  'containment-refused',
  'write-failed',
] as const;

export type TerminalSupportFileNoticeReason =
  (typeof TERMINAL_SUPPORT_FILE_NOTICE_REASON_VOCABULARY)[number];

export const TERMINAL_SUPPORT_FILE_NOTICE_REASONS: ReadonlySet<TerminalSupportFileNoticeReason> =
  new Set(TERMINAL_SUPPORT_FILE_NOTICE_REASON_VOCABULARY);

export function isTerminalSupportFileNoticeReason(
  value: unknown,
): value is TerminalSupportFileNoticeReason {
  return (
    typeof value === 'string' &&
    TERMINAL_SUPPORT_FILE_NOTICE_REASONS.has(value as TerminalSupportFileNoticeReason)
  );
}

export type OkPtyNotice =
  | {
      readonly ptyId: string;
      readonly notice: 'invalid-shell-override';
      readonly reason: TerminalShellNoticeReason;
    }
  | {
      readonly ptyId: string;
      readonly notice: 'shell-resolved';
      readonly shellFamily: WindowsShellFamily;
    }
  | {
      readonly ptyId: string;
      readonly notice: 'support-file-degraded';
      readonly reason: TerminalSupportFileNoticeReason;
    };

export interface ClaudeReadiness {
  readonly claude: 'present' | 'not-found' | 'unknown';
  readonly mcp: 'wired' | 'needs-rewire';
  readonly mcpPreApprovable?: boolean;
  readonly rewireError?: string;
}

export interface CliReadiness {
  readonly onPath: 'present' | 'not-found' | 'unknown';
  readonly okServerConfigured?: boolean;
}

export interface OkDesktopBridge {
  readonly config: OkDesktopConfig;

  onProjectSwitched(cb: (next: OkDesktopConfig) => void): OkUnsubscribe;
  onMenuAction(cb: (action: OkMenuAction, origin: OkMenuActionOrigin) => void): OkUnsubscribe;
  onUpdateDownloaded(cb: (info: OkUpdateDownloadedInfo) => void): OkUnsubscribe;
  onUpdateRelaunching(cb: (info: OkUpdateRelaunchingInfo) => void): OkUnsubscribe;
  onUpdateFetchingLatest(cb: (info: OkUpdateFetchingLatestInfo) => void): OkUnsubscribe;
  onUpdateRelaunchFailed(cb: (info: OkUpdateRelaunchFailedInfo) => void): OkUnsubscribe;
  onWhatsNew(cb: (info: OkWhatsNewInfo) => void): OkUnsubscribe;
  onWhatsNewDismissed(cb: (info: { readonly version: string }) => void): OkUnsubscribe;
  onUpdateStuckHint(cb: (info: OkUpdateStuckHintInfo) => void): OkUnsubscribe;
  onDeepLink(
    cb: (evt: {
      doc: string;
      kind: 'doc' | 'folder';
      branch?: string | null;
      multiCandidate?: boolean;
      targetMissing?: boolean;
      repositoryPath?: string;
      contentRootDepth?: number;
    }) => void,
  ): OkUnsubscribe;
  onShareReceived(cb: (payload: OkShareReceivedPayload) => void): OkUnsubscribe;

  onServerVersionDrift(cb: (info: OkServerVersionDriftInfo) => void): OkUnsubscribe;
  onServerRestarted(cb: (info: OkServerRestartedInfo) => void): OkUnsubscribe;
  onRecentRemovedMissing(cb: (info: OkRecentRemovedMissingInfo) => void): OkUnsubscribe;
  restartServer(projectPath: string): Promise<OkServerRestartOutcome>;

  setThemeSource(source: OkThemeSource): Promise<{ ok: true }>;

  setLanguagePreference(preference: LanguagePreference): Promise<{ ok: true }>;

  signalThemeApplied(opts?: { reducedTransparency?: boolean; chrome?: OkChromeColors }): void;

  dialog: {
    openFolder(opts?: { defaultPath?: string }): Promise<string | null>;
  };

  shell: {
    openExternal(url: string): Promise<void>;
    detectProtocol(scheme: string): Promise<{ installed: boolean; displayName?: string }>;
    spawnCursor(
      path: string,
    ): Promise<
      | { ok: true }
      | { ok: false; reason: 'invalid-path' | 'not-installed' | 'timeout' | 'spawn-error' }
    >;
    recordHandoff(line: {
      readonly target: 'claude-cowork' | 'claude-code' | 'codex' | 'cursor';
      readonly host: 'electron' | 'web';
      readonly outcome: 'ok' | 'error';
      readonly ts: string;
      readonly reason?: HandoffFailureReason;
      readonly scope?: HandoffScope;
    }): Promise<void>;

    openAsset(
      relPath: string,
    ): Promise<
      | { ok: true }
      | { ok: false; reason: 'extension-blocked' | 'path-escape' | 'not-found' | 'resolve-error' }
    >;

    revealAsset(
      relPath: string,
    ): Promise<{ ok: true } | { ok: false; reason: 'path-escape' | 'not-found' | 'resolve-error' }>;

    revealExternal(
      absPath: string,
    ): Promise<
      | { ok: true; outcome: 'revealed' | 'dismissed' }
      | { ok: false; reason: 'not-found' | 'invalid-path' | 'error' }
    >;

    showAssetMenu(params: {
      readonly relPath: string;
      readonly title: string;
      readonly kind: 'asset' | 'wiki-link' | 'image';
    }): Promise<void>;
    showItemInFolder(path: string): Promise<void>;
    trashItem(absPath: string): Promise<
      | { ok: true }
      | {
          ok: false;
          reason: 'not-found' | 'permission-denied' | 'system-error' | 'path-escape';
          detail?: string;
        }
    >;
  };

  clipboard: {
    writeText(text: string): Promise<void>;
    copyImage(params: { readonly src: string; readonly alt: string }): Promise<
      | { ok: true }
      | {
          ok: false;
          reason: 'fetch-failed' | 'path-escape' | 'empty-image' | 'read-error' | 'write-error';
          detail?: string;
        }
    >;
  };

  project: {
    listRecent(): Promise<RecentProjectEntry[]>;
    removeRecent(path: string): Promise<void>;
    getSessionState(): Promise<ProjectSessionState>;
    setSessionState(state: ProjectSessionState): Promise<void>;
    open(request: OkProjectOpenRequest): Promise<void>;
    openFile(): Promise<void>;
    createNew(args: {
      parent: string;
      name: string;
      editors: OkMcpWiringEditorId[];
      sharing?: 'shared' | 'local-only';
      packId?: OkPackId;
      rootDir?: string;
    }): Promise<void>;
    recordCreateNewBannerShown(banner: CreateNewBannerKind): Promise<void>;
    checkTargetExists(request: {
      projectPath: string;
      kind: 'doc' | 'folder';
      path: string;
    }): Promise<OkCheckTargetExistsResult>;
    readHeadBranch(projectPath: string): Promise<OkHeadBranchInfo>;
    fetchBranchInfo(request: {
      projectPath: string;
      branch: string;
      kind: 'doc' | 'folder';
      path: string;
    }): Promise<BranchInfoResponse | null>;
    runCheckout(request: {
      projectPath: string;
      branch: string;
      fastForward?: boolean;
    }): Promise<CheckoutResponse | null>;
    fetchTargetStatus(request: {
      projectPath: string;
      branch: string;
      path: string;
      kind: 'doc' | 'folder';
      contentRootDepth?: number;
    }): Promise<ShareTargetStatusResponse | null>;
    awaitBranchSwitched(request: {
      projectPath: string;
      branch: string;
      timeoutMs: number;
    }): Promise<{ ok: true } | { ok: false; reason: 'timeout' | 'project-not-open' }>;
    okInit(request: { projectPath: string }): Promise<LocalOpOkInitResponse>;
    close(): Promise<void>;
  };

  worktree: {
    list(): Promise<WorktreeListResult>;
    create(request: WorktreeCreateRequest): Promise<WorktreeCreateResult>;
    checkout(request: { branch: string }): Promise<WorktreeCreateResult>;
  };

  sharing: {
    status(): Promise<OkSharingStatusResult>;
    setMode(mode: 'shared' | 'local-only'): Promise<OkSharingSetModeResult>;
  };

  slides: {
    status(): Promise<OkSlidesStatusResult>;
    open(docPath: string): Promise<OkSlidesOpenResult>;
  };

  bugReport: {
    create(request: {
      level: ReportBundleLevel;
      note?: string;
      includeCrashDump?: boolean;
      includeScreenshot?: boolean;
    }): Promise<OkBugReportCreateResult>;
    captureScreenshot(): Promise<OkBugReportScreenshot | null>;
    crashDumpAvailability(): Promise<OkBugReportCrashDumpAvailability>;
    send(request: OkBugReportSendInput): Promise<OkBugReportSendResult>;
    crashAck(request: { eventId: string }): Promise<OkBugReportCrashAckResult>;
    list(): Promise<OkBugReportListResult>;
    delete(id: string): Promise<OkBugReportDeleteResult>;
    onCrashDetected(cb: (event: OkBugReportCrashDetectedEvent) => void): OkUnsubscribe;
  };

  fs: {
    defaultProjectsRoot(): Promise<string>;
    folderState(path: string): Promise<OkFolderState>;
    findEnclosingProjectRoot(path: string): Promise<OkFindEnclosingProjectRootResult | null>;
    findEnclosingGitRoot(path: string): Promise<OkFindEnclosingGitRootResult | null>;
    removeGitFolder(gitRoot: string): Promise<void>;
  };

  navigator: {
    open(): Promise<void>;
  };

  noteWindow: {
    open(
      docName: string,
      entryPoint: 'tab-menu' | 'palette',
    ): Promise<
      | { ok: true; outcome: 'created' | 'focused' }
      | { ok: false; reason: 'no-project' | 'invalid-request' }
    >;
    dispatchToMain(action: OkNoteWindowMainAction): Promise<OkNoteWindowMainActionResult>;
    onMainAction(cb: (action: OkNoteWindowMainAction) => void): OkUnsubscribe;
  };

  seed: {
    plan(options?: OkSeedPlanOptions): Promise<OkSeedPlanResult>;
    apply(plan: OkScaffoldPlan, options?: OkSeedApplyOptions): Promise<OkSeedApplyResult>;
    listPacks(): Promise<OkSeedListPacksResult>;
  };

  skill: {
    detectClaudeDesktop(): Promise<boolean>;
    buildAndOpen(opts?: { force?: boolean }): Promise<
      | { ok: true; path: string; skipped?: false; version?: string }
      | {
          ok: true;
          path?: undefined;
          skipped: true;
          version: string;
          recordedAt?: string;
        }
      | {
          ok: false;
          reason: 'build-failed' | 'open-failed' | 'no-downloads-dir';
          message?: string;
        }
    >;
  };

  update: {
    relaunchNow(): Promise<void>;
    checkNow(): Promise<void>;
    dismissWhatsNew(version: string): Promise<void>;
  };

  state: {
    query(): Promise<OkStateSnapshot>;
    resetIncompatible(): Promise<void>;
  };

  mcpWiring: {
    onShow(cb: (payload: OkMcpWiringShowPayload) => void): OkUnsubscribe;
    signalReady(): void;
    confirm(request: OkMcpWiringConfirmRequest): Promise<OkMcpWiringResult>;
    skip(): Promise<OkMcpWiringResult>;
    reconfigure(): Promise<boolean>;
  };

  spellcheck: {
    toggle(): Promise<boolean>;
  };

  integrations: {
    status(): Promise<OkIntegrationsStatus>;
    setComponent(request: OkIntegrationsSetRequest): Promise<OkIntegrationsSetResult>;
  };

  projectIntegrations: {
    status(): Promise<OkProjectIntegrationsStatus>;
    setComponent(request: OkProjectIntegrationsSetRequest): Promise<OkProjectIntegrationsSetResult>;
  };

  remoteAccess: {
    probePort(port: number): Promise<boolean>;
  };

  onboarding: {
    onShow(cb: (payload: OkOnboardingShowPayload) => void): OkUnsubscribe;
    signalReady(): void;
    confirm(request: OkOnboardingConfirmRequest): Promise<OkOnboardingResult>;
    cancel(): Promise<OkOnboardingResult>;
    probeContent(request: OkOnboardingProbeContentRequest): Promise<OkOnboardingProbeContentResult>;
    onToast(
      cb: (
        payload:
          | { readonly kind: 'ancestor-promote'; readonly ancestorPath: string }
          | {
              readonly kind: 'git-root-promote';
              readonly gitRoot: string;
              readonly pickedPath: string;
            }
          | {
              readonly kind: 'startup-reclaim';
              readonly mcp:
                | { readonly status: 'none' }
                | { readonly status: 'repaired'; readonly editors: readonly string[] }
                | { readonly status: 'failed'; readonly editors: readonly string[] };
              readonly path:
                | { readonly status: 'none' }
                | { readonly status: 'installed'; readonly summary: string }
                | { readonly status: 'failed'; readonly summary: string };
            }
          | {
              readonly kind: 'sharing-refused-tracked';
              readonly tracked: readonly string[];
              readonly remediation: string;
            }
          | { readonly kind: 'sharing-no-git'; readonly requestedMode: 'local-only' },
      ) => void,
    ): OkUnsubscribe;
  };

  localOp: {
    auth: {
      start(): OkLocalOpStream<OkLocalOpAuthEvent>;
    };
    clone: {
      start(request: {
        url: string;
        dir: string;
        branch?: string | null;
      }): OkLocalOpStream<OkLocalOpCloneEvent>;
    };
    authStatus(request?: { host?: string }): Promise<OkLocalOpAuthStatusResponse>;
    authRepos(request?: { host?: string }): Promise<OkLocalOpAuthReposResponse>;
  };

  share: {
    validateLocalFolder(args: {
      folderPath: string;
      host: string;
      owner: string;
      repo: string;
    }): Promise<ShareFolderValidationResult>;
  };

  editor: {
    notifyActiveTargetChanged(target: OkEditorActiveTargetSnapshot): void;
    notifyViewMenuStateChanged(state: Partial<OkEditorViewMenuStateSnapshot>): void;
    notifyBackgroundThrottle(signal: { hasPendingWork: boolean; enabled: boolean }): void;
  };

  menu: {
    dispatch(request: OkMenuDispatchRequest): Promise<OkMenuRendererSnapshot | undefined>;
  };

  startup: {
    reportMarks(marks: { pageListReadyMs: number; firstContentMs: number }): void;
  };

  sidebar: {
    expandAll(cb: () => void): OkUnsubscribe;
    collapseAll(cb: () => void): OkUnsubscribe;
  };

  terminal: {
    create(opts: {
      cols: number;
      rows: number;
      launchCommand?: string | TerminalLaunchCommand;
    }): Promise<OkPtyCreateResult>;
    input(ptyId: string, data: string): void;
    resize(ptyId: string, cols: number, rows: number): void;
    kill(ptyId: string): Promise<void>;
    drain(ptyId: string, bytes: number): void;
    list(): Promise<OkPtyListEntry[]>;
    adopt(ptyId: string): Promise<OkPtyAdoptResult>;
    setMeta(ptyId: string, meta: { customLabel?: string | null; ordinal?: number }): void;
    setOrder(orderedPtyIds: readonly string[]): void;
    getDockState(): Promise<OkTerminalDockState>;
    setDockState(state: OkTerminalDockStateUpdate): Promise<OkTerminalDockStateWriteResult>;
    onData(cb: (msg: OkPtyData) => void): OkUnsubscribe;
    onExit(cb: (msg: OkPtyExit) => void): OkUnsubscribe;
    onNotice(cb: (msg: OkPtyNotice) => void): OkUnsubscribe;
    claudePreflight(): Promise<ClaudeReadiness>;
    cliPreflight(cli: TerminalCli): Promise<CliReadiness>;
    cliInstalledMap(): Promise<Partial<Record<TerminalCli, boolean>>>;
    rewireClaudeMcp(): Promise<ClaudeReadiness>;
  };

  accessibility?: {
    isScreenReaderActive(): boolean;
    onScreenReaderChanged(cb: (active: boolean) => void): OkUnsubscribe;
  };

  readonly platform: 'darwin' | 'win32' | 'linux';
  readonly appVersion: string;
  readonly instanceLabel: string | null;

  getPathForFile(file: File): string | null;

  setDisplayLockCrashKey(state: string): void;

  debug?: {
    keyringSmoke(): Promise<OkKeyringSmokeResult>;
  };
}

declare global {
  interface Window {
    okDesktop?: OkDesktopBridge;
  }
}
