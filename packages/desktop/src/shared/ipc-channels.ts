import type {
  BranchInfoResponse,
  CheckoutResponse,
  CreateNewBannerKind,
  EditorId,
  HandoffFailureReason,
  HandoffScope,
  LanguagePreference,
  LocalOpOkInitResponse,
  OkBugReportCrashAckResult,
  OkBugReportCrashDumpAvailability,
  OkBugReportCreateResult,
  OkBugReportDeleteResult,
  OkBugReportListResult,
  OkBugReportScreenshot,
  OkBugReportSendResult,
  OkFolderState,
  ShareTargetStatusResponse,
  SkillCostTiers,
  TerminalCli,
  TerminalLaunchCommand,
  UninstallDispatchRequest,
  UninstallDispatchResult,
  WorktreeCreateRequest,
  WorktreeCreateResult,
  WorktreeListResult,
} from '@inkeep/open-knowledge-core';
import type {
  OkCheckTargetExistsResult as CheckTargetExistsResult,
  ClaudeReadiness,
  CliReadiness,
  OkHeadBranchInfo as HeadBranchInfo,
  OkChromeColors,
  OkDesktopConfig,
  OkEditorActiveTargetSnapshot,
  OkEditorViewMenuStateSnapshot,
  OkLocalOpAuthReposResponse,
  OkLocalOpAuthStatusResponse,
  OkMenuDispatchCommand,
  OkMenuDispatchRequest,
  OkMenuDispatchRole,
  OkMenuRendererSnapshot,
  OkNoteWindowMainAction,
  OkNoteWindowMainActionResult,
  OkPtyAdoptResult,
  OkPtyCreateResult,
  OkPtyListEntry,
  OkServerRestartOutcome,
  OkSharePayloadFields,
  OkSharingSetModeResult,
  OkSharingStatusResult,
  OkTerminalDockState,
  OkTerminalDockStateUpdate,
  OkTerminalDockStateWriteResult,
  OkThemeSource,
  OkUpdateChannel,
  OkSeedApplyOptions as SeedApplyOptions,
  OkSeedPlanOptions as SeedPlanOptions,
} from '@inkeep/open-knowledge-core/desktop-bridge';
import type {
  FindEnclosingGitRootResult,
  FindEnclosingProjectRootResult,
  PackId,
  ScaffoldPlan,
} from '@inkeep/open-knowledge-server';
import type { OkBugReportRequest } from '../main/ipc/bug-report.ts';
import type { BuildAndOpenResult } from '../main/ipc/install-skill.ts';
import type { SeedApplyResult, SeedListPacksResult, SeedPlanResult } from '../main/ipc/seed.ts';
import type { KeyringSmokeResult } from '../utility/keyring-smoke.ts';
import type { EntryPoint } from './entry-point.ts';

export type EditorActiveTargetSnapshot = OkEditorActiveTargetSnapshot;
export type EditorViewMenuStateSnapshot = OkEditorViewMenuStateSnapshot;
export type { SkillCostTiers };
export type MenuDispatchRole = OkMenuDispatchRole;
export type MenuDispatchCommand = OkMenuDispatchCommand;
export type MenuDispatchRequest = OkMenuDispatchRequest;
export type MenuRendererSnapshot = OkMenuRendererSnapshot;

export type { OkSharingSetModeResult, OkSharingStatusResult };

export type OkSharingResult = OkSharingStatusResult | OkSharingSetModeResult;

export type SlidevSource = 'project-local' | 'global';

export type OkSlidesStatusResult =
  | { readonly kind: 'status'; readonly available: true; readonly source: SlidevSource }
  | { readonly kind: 'status'; readonly available: false };

export type SlidevOpenFailureReason =
  | 'not-available'
  | 'invalid-path'
  | 'spawn-error'
  | 'exited-early'
  | 'timeout'
  | 'unsupported-server';

export type OkSlidesOpenResult =
  | { readonly kind: 'open'; readonly ok: true }
  | { readonly kind: 'open'; readonly ok: false; readonly reason: SlidevOpenFailureReason };

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: string;
  missing?: boolean;
  gitRemoteUrl?: string;
  gitCommonDir?: string;
  mainRoot?: string;
  isLinkedWorktree?: boolean;
  branch?: string | null;
}

interface ProjectOpenRequest {
  path: string;
  target: 'new-window';
  entryPoint: EntryPoint;
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
  pendingMultiCandidate?: boolean;
}

interface ShareValidateFolderRequest {
  readonly folderPath: string;
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

type ShareValidateFolderResult =
  | { readonly kind: 'ok'; readonly gitRemoteUrl: string }
  | { readonly kind: 'not-git' }
  | { readonly kind: 'no-origin' }
  | { readonly kind: 'wrong-repo'; readonly actualOwner: string; readonly actualRepo: string }
  | { readonly kind: 'wrong-host'; readonly actualHost: string }
  | { readonly kind: 'non-github' }
  | { readonly kind: 'symlink-escape' };

interface PersistedEditorPane {
  id: string;
  openTabs: string[];
  pinnedTabIds: string[];
  activeTabId: string | null;
  size: number;
}

interface ProjectSessionState {
  updatedAt: string | null;
  panes: PersistedEditorPane[];
  focusedPaneId: string;
}

export type SpawnOutcome =
  | { ok: true }
  | { ok: false; reason: 'invalid-path' | 'not-installed' | 'timeout' | 'spawn-error' };

export interface HandoffStatsLine {
  readonly target: 'claude-cowork' | 'claude-code' | 'codex' | 'cursor';
  readonly host: 'electron' | 'web';
  readonly outcome: 'ok' | 'error';
  readonly ts: string;
  readonly reason?: HandoffFailureReason;
  readonly scope?: HandoffScope;
}

export type McpWiringEditorId = EditorId;

type OnboardingWarningKind =
  | 'root'
  | 'home'
  | 'home-documents'
  | 'home-desktop'
  | 'home-downloads'
  | 'volumes-mount'
  | 'drive-root';

type OnboardingGitState = 'present' | 'absent' | 'shell-only';

export interface OnboardingShowPayload {
  readonly pickedPath: string;
  readonly projectDir: string;
  readonly defaultContentDir: string;
  readonly gitState: OnboardingGitState;
  readonly gitRootPromoted: boolean;
  readonly warnings: readonly { readonly kind: OnboardingWarningKind }[];
}

export interface OnboardingConfirmRequest {
  readonly initGit: boolean;
  readonly contentDir: string;
  readonly additionalIgnores: string;
  readonly editorIds: readonly McpWiringEditorId[];
  readonly connectEditors: boolean;
  readonly sharing: 'shared' | 'local-only';
}

export type OnboardingConfirmResult = { ok: true } | { ok: false; error: string };

export type OnboardingCancelResult = { ok: true } | { ok: false; error: string };

export interface OnboardingProbeContentRequest {
  readonly contentDir: string;
}

export type OnboardingProbeContentResult =
  | {
      readonly ok: true;
      readonly count: number;
      readonly sample: readonly string[];
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly error: string };

export interface McpWiringEditorDetection {
  readonly id: McpWiringEditorId;
  readonly label: string;
  readonly detected: boolean;
  readonly willReplace: boolean;
  readonly configPath: string | null;
  readonly entryLocator: string;
}

export interface McpWiringPathInstallDescriptor {
  readonly shellDetected: boolean;
  readonly rcFilesToTouch: readonly string[];
  readonly alreadyInstalled: boolean;
}

export interface McpWiringConfirmRequest {
  readonly editorIds: readonly McpWiringEditorId[];
  readonly pathInstall?: boolean;
  readonly skills?: readonly string[];
}

export interface McpWiringGlobalSkillDescriptor {
  readonly id: string;
  readonly name: string;
  readonly paths: readonly string[];
}

export type McpWiringConfirmResult = { ok: true } | { ok: false; error: string };
export type McpWiringSkipResult = { ok: true } | { ok: false; error: string };

export type IntegrationsEditorState = 'installed' | 'not-installed' | 'foreign' | 'unmanageable';

export interface IntegrationsEditorStatus {
  readonly id: McpWiringEditorId;
  readonly label: string;
  readonly detected: boolean;
  readonly state: IntegrationsEditorState;
  readonly configPath: string | null;
  readonly entryLocator: string;
}

export interface IntegrationsPathStatus {
  readonly shellDetected: boolean;
  readonly rcFilesToTouch: readonly string[];
  readonly installed: boolean;
}

export interface IntegrationsResolvedSkillHost {
  readonly editor: string;
  readonly skillsRoot: string;
  readonly custom: boolean;
}

export interface IntegrationsSkillStatus {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly installed: boolean;
  readonly onboarding: boolean;
  readonly paths: readonly string[];
  readonly size?: SkillCostTiers;
  readonly sourceDir: string;
  readonly resolvedHosts: readonly IntegrationsResolvedSkillHost[];
}

export interface IntegrationsStatus {
  readonly available: boolean;
  readonly editors: readonly IntegrationsEditorStatus[];
  readonly path: IntegrationsPathStatus;
  readonly skills: readonly IntegrationsSkillStatus[];
  readonly detectedEditorIds: readonly McpWiringEditorId[];
}

export type IntegrationsComponentRef =
  | { readonly kind: 'editor'; readonly id: McpWiringEditorId }
  | { readonly kind: 'path' }
  | { readonly kind: 'skill'; readonly id: string };

export interface IntegrationsSetRequest {
  readonly component: IntegrationsComponentRef;
  readonly enabled: boolean;
}

export type IntegrationsSetResult =
  | { readonly ok: true; readonly status: IntegrationsStatus }
  | { readonly ok: false; readonly error: string; readonly status: IntegrationsStatus };

export type ProjectIntegrationsFollowUp =
  | 'approve-once'
  | 'enable-manually'
  | 'auto-connect'
  | 'none';

export interface ProjectIntegrationsEditorStatus {
  readonly id: McpWiringEditorId;
  readonly label: string;
  readonly detected: boolean;
  readonly state: IntegrationsEditorState;
  readonly configPath: string;
  readonly entryLocator: string;
  readonly followUp: ProjectIntegrationsFollowUp;
}

export interface ProjectIntegrationsSkillStatus {
  readonly installed: boolean;
  readonly paths: readonly string[];
  readonly description: string;
  readonly hosts: readonly string[];
  readonly size?: SkillCostTiers;
  readonly sourceDir?: string;
}

export interface ProjectIntegrationsStatus {
  readonly available: boolean;
  readonly hasProject: boolean;
  readonly projectDir: string | null;
  readonly editors: readonly ProjectIntegrationsEditorStatus[];
  readonly skill: ProjectIntegrationsSkillStatus | null;
}

export type ProjectIntegrationsComponentRef =
  | { readonly kind: 'editor'; readonly id: McpWiringEditorId }
  | { readonly kind: 'skill' };

export interface ProjectIntegrationsSetRequest {
  readonly component: ProjectIntegrationsComponentRef;
  readonly enabled: boolean;
}

export type ProjectIntegrationsSetResult =
  | { readonly ok: true; readonly status: ProjectIntegrationsStatus }
  | { readonly ok: false; readonly error: string; readonly status: ProjectIntegrationsStatus };

interface DialogOpenFolderOpts {
  readonly defaultPath?: string;
}

export const TYPED_IPC_MIGRATION_CHANNEL_CAP = 95;

export interface RequestChannels {
  'ok:dialog:open-folder': {
    args: [opts?: DialogOpenFolderOpts];
    result: string | null;
  };
  'ok:shell:open-external': { args: [url: string]; result: undefined };
  'ok:shell:detect-protocol': {
    args: [scheme: string];
    result: { installed: boolean; displayName?: string };
  };
  'ok:shell:spawn-cursor': { args: [path: string]; result: SpawnOutcome };
  'ok:shell:show-item-in-folder': { args: [path: string]; result: undefined };
  'ok:shell:record-handoff': { args: [line: HandoffStatsLine]; result: undefined };
  'ok:shell:open-asset': {
    args: [relPath: string];
    result:
      | { ok: true }
      | { ok: false; reason: 'extension-blocked' | 'path-escape' | 'not-found' | 'resolve-error' };
  };
  'ok:shell:reveal-asset': {
    args: [relPath: string];
    result: { ok: true } | { ok: false; reason: 'path-escape' | 'not-found' | 'resolve-error' };
  };
  'ok:shell:reveal-external': {
    args: [absPath: string];
    result:
      | { ok: true; outcome: 'revealed' | 'dismissed' }
      | { ok: false; reason: 'not-found' | 'invalid-path' | 'error' };
  };
  'ok:shell:show-asset-menu': {
    args: [
      params: {
        readonly relPath: string;
        readonly title: string;
        readonly kind: 'asset' | 'wiki-link' | 'image';
      },
    ];
    result: undefined;
  };
  'ok:shell:trash-item': {
    args: [absPath: string];
    result:
      | { ok: true }
      | {
          ok: false;
          reason: 'not-found' | 'permission-denied' | 'system-error' | 'path-escape';
          detail?: string;
        };
  };
  'ok:clipboard:write-text': { args: [text: string]; result: undefined };
  'ok:clipboard:copy-image': {
    args: [params: { readonly src: string; readonly alt: string }];
    result:
      | { ok: true }
      | {
          ok: false;
          reason: 'fetch-failed' | 'path-escape' | 'empty-image' | 'read-error' | 'write-error';
          detail?: string;
        };
  };
  'ok:project:get-info': { args: []; result: OkDesktopConfig };

  'ok:sharing:dispatch': {
    args: [request: { kind: 'status' } | { kind: 'set-mode'; mode: 'shared' | 'local-only' }];
    result: OkSharingResult;
  };
  'ok:slides:dispatch': {
    args: [request: { kind: 'status' } | { kind: 'open'; docPath: string }];
    result: OkSlidesStatusResult | OkSlidesOpenResult;
  };
  'ok:bug-report:dispatch': {
    args: [request: OkBugReportRequest];
    result:
      | OkBugReportCreateResult
      | OkBugReportSendResult
      | OkBugReportCrashAckResult
      | OkBugReportCrashDumpAvailability
      | OkBugReportScreenshot
      | OkBugReportListResult
      | OkBugReportDeleteResult
      | null;
  };
  'ok:project:list-recent': { args: []; result: RecentProject[] };
  'ok:project:remove-recent': { args: [projectPath: string]; result: undefined };
  'ok:project:get-session-state': { args: []; result: ProjectSessionState };
  'ok:project:set-session-state': { args: [state: ProjectSessionState]; result: undefined };
  'ok:project:open': { args: [request: ProjectOpenRequest]; result: undefined };
  'ok:project:open-file-picker': { args: []; result: undefined };
  'ok:project:check-target-exists': {
    args: [request: { projectPath: string; kind: 'doc' | 'folder'; path: string }];
    result: CheckTargetExistsResult;
  };
  'ok:project:read-head-branch': {
    args: [projectPath: string];
    result: HeadBranchInfo;
  };
  'ok:project:fetch-branch-info': {
    args: [request: { projectPath: string; branch: string; kind: 'doc' | 'folder'; path: string }];
    result: BranchInfoResponse | null;
  };
  'ok:project:run-checkout': {
    args: [request: { projectPath: string; branch: string; fastForward?: boolean }];
    result: CheckoutResponse | null;
  };
  'ok:project:fetch-target-status': {
    args: [request: { projectPath: string; branch: string; path: string; kind: 'doc' | 'folder' }];
    result: ShareTargetStatusResponse | null;
  };
  'ok:project:await-branch-switched': {
    args: [request: { projectPath: string; branch: string; timeoutMs: number }];
    result: { ok: true } | { ok: false; reason: 'timeout' | 'project-not-open' };
  };
  'ok:project:ok-init': {
    args: [request: { projectPath: string }];
    result: LocalOpOkInitResponse;
  };
  'ok:worktree:dispatch': {
    args: [
      request:
        | { kind: 'list' }
        | ({ kind: 'create' } & WorktreeCreateRequest)
        | { kind: 'checkout'; branch: string },
    ];
    result: WorktreeListResult | WorktreeCreateResult;
  };
  'ok:project:close': { args: []; result: undefined };
  'ok:project:restart-server': { args: [projectPath: string]; result: OkServerRestartOutcome };
  'ok:share:validate-folder': {
    args: [request: ShareValidateFolderRequest];
    result: ShareValidateFolderResult;
  };
  'ok:project:create-new': {
    args: [
      args: {
        parent: string;
        name: string;
        editors: readonly McpWiringEditorId[];
        sharing?: 'shared' | 'local-only';
        packId?: PackId;
        rootDir?: string;
      },
    ];
    result: undefined;
  };
  'ok:fs:default-projects-root': { args: []; result: string };
  'ok:fs:folder-state': {
    args: [path: string];
    result: OkFolderState;
  };
  'ok:fs:find-enclosing-project-root': {
    args: [path: string];
    result: FindEnclosingProjectRootResult | null;
  };
  'ok:fs:find-enclosing-git-root': {
    args: [path: string];
    result: FindEnclosingGitRootResult | null;
  };
  'ok:fs:remove-git-folder': {
    args: [gitRoot: string];
    result: undefined;
  };
  'ok:project:record-create-new-banner-shown': {
    args: [banner: CreateNewBannerKind];
    result: undefined;
  };
  'ok:navigator:open': { args: []; result: undefined };
  'ok:window:open-note': {
    args: [
      request:
        | { kind: 'open'; docName: string; entryPoint: 'tab-menu' | 'palette' }
        | { kind: 'dispatch-to-main'; action: OkNoteWindowMainAction },
    ];
    result:
      | { ok: true; outcome: 'created' | 'focused' }
      | { ok: false; reason: 'no-project' | 'invalid-request' }
      | OkNoteWindowMainActionResult;
  };
  'ok:update:relaunch-now': { args: []; result: undefined };
  'ok:update:check-now': { args: []; result: undefined };
  'ok:update:whats-new-dismiss': { args: [{ version: string }]; result: undefined };
  'ok:state:query': {
    args: [];
    result: {
      channel: OkUpdateChannel;
      schemaIncompatibility: {
        currentBuild: string;
        persistedSchemaVersion: number;
        maxSupported: number;
      } | null;
    };
  };
  'ok:state:reset-incompatible': { args: []; result: undefined };
  'ok:theme:set-source': { args: [params: { source: OkThemeSource }]; result: { ok: true } };
  'ok:locale:set-preference': {
    args: [params: { preference: LanguagePreference }];
    result: { ok: true };
  };
  'ok:theme:applied': {
    args: [opts?: { reducedTransparency?: boolean; chrome?: OkChromeColors }];
    result: undefined;
  };
  'ok:startup:renderer-marks': {
    args: [marks: { pageListReadyMs: number; firstContentMs: number }];
    result: undefined;
  };
  'ok:debug:keyring-smoke': { args: []; result: KeyringSmokeResult };
  'ok:seed:plan': { args: [options?: SeedPlanOptions]; result: SeedPlanResult };
  'ok:seed:apply': {
    args: [plan: ScaffoldPlan, options?: SeedApplyOptions];
    result: SeedApplyResult;
  };
  'ok:seed:list-packs': { args: []; result: SeedListPacksResult };
  'ok:mcp-wiring:confirm': {
    args: [request: McpWiringConfirmRequest];
    result: McpWiringConfirmResult;
  };
  'ok:mcp-wiring:skip': { args: []; result: McpWiringSkipResult };
  'ok:mcp-wiring:renderer-ready': { args: []; result: undefined };

  'ok:mcp-wiring:reconfigure': { args: []; result: boolean };
  'ok:spellcheck:toggle': { args: []; result: boolean };

  'ok:integrations:dispatch': {
    args: [request: { kind: 'status' } | ({ kind: 'set' } & IntegrationsSetRequest)];
    result: IntegrationsStatus | IntegrationsSetResult;
  };

  'ok:project-integrations:dispatch': {
    args: [request: { kind: 'status' } | ({ kind: 'set' } & ProjectIntegrationsSetRequest)];
    result: ProjectIntegrationsStatus | ProjectIntegrationsSetResult;
  };

  'ok:remote-access:dispatch': {
    args: [request: { kind: 'probe-port'; port: number }];
    result: boolean;
  };

  'ok:onboarding:confirm': {
    args: [request: OnboardingConfirmRequest];
    result: OnboardingConfirmResult;
  };
  'ok:onboarding:cancel': { args: []; result: OnboardingCancelResult };
  'ok:onboarding:renderer-ready': { args: []; result: undefined };
  'ok:onboarding:probe-content': {
    args: [request: OnboardingProbeContentRequest];
    result: OnboardingProbeContentResult;
  };

  'ok:skill:detect-claude-desktop': { args: []; result: boolean };

  'ok:skill:build-and-open': { args: [opts?: { force?: boolean }]; result: BuildAndOpenResult };

  'ok:local-op:auth:start': {
    args: [];
    result: { ok: true; streamId: string } | { ok: false; error: string };
  };
  'ok:local-op:auth:cancel': { args: [streamId: string]; result: undefined };
  'ok:local-op:clone:start': {
    args: [request: { url: string; dir: string; branch?: string | null }];
    result: { ok: true; streamId: string } | { ok: false; error: string };
  };
  'ok:local-op:clone:cancel': { args: [streamId: string]; result: undefined };

  'ok:local-op:auth:status': {
    args: [request?: { host?: string }];
    result: OkLocalOpAuthStatusResponse;
  };
  'ok:local-op:auth:repos': {
    args: [request?: { host?: string }];
    result: OkLocalOpAuthReposResponse;
  };

  'ok:editor:active-target-changed': {
    args: [target: EditorActiveTargetSnapshot];
    result: undefined;
  };
  'ok:editor:view-menu-state-changed': {
    args: [state: Partial<EditorViewMenuStateSnapshot>];
    result: undefined;
  };
  'ok:editor:background-throttle': {
    args: [signal: { hasPendingWork: boolean; enabled: boolean }];
    result: undefined;
  };
  'ok:menu:dispatch': {
    args: [request: MenuDispatchRequest];
    result: MenuRendererSnapshot | undefined;
  };

  'ok:uninstall:dispatch': {
    args: [request: UninstallDispatchRequest];
    result: UninstallDispatchResult;
  };

  'ok:pty:create': {
    args: [
      opts: {
        cols: number;
        rows: number;
        launchCommand?: string | TerminalLaunchCommand;
      },
    ];
    result: OkPtyCreateResult;
  };
  'ok:pty:input': {
    args: [req: { ptyId: string; data: string }];
    result: undefined;
  };
  'ok:pty:resize': {
    args: [req: { ptyId: string; cols: number; rows: number }];
    result: undefined;
  };
  'ok:pty:kill': {
    args: [req: { ptyId: string }];
    result: undefined;
  };
  'ok:pty:drain': {
    args: [req: { ptyId: string; bytes: number }];
    result: undefined;
  };
  'ok:pty:list': {
    args: [];
    result: OkPtyListEntry[];
  };
  'ok:pty:adopt': {
    args: [req: { ptyId: string }];
    result: OkPtyAdoptResult;
  };
  'ok:pty:set-meta': {
    args: [req: { ptyId: string; customLabel?: string | null; ordinal?: number }];
    result: undefined;
  };
  'ok:pty:set-order': {
    args: [req: { orderedPtyIds: string[] }];
    result: undefined;
  };
  'ok:terminal:claude-assist': {
    args: [req: { action: 'preflight' | 'rewire' }];
    result: ClaudeReadiness;
  };
  'ok:terminal:cli-preflight': {
    args: [req: { cli: TerminalCli }];
    result: CliReadiness;
  };
  'ok:terminal:cli-installed-map': {
    args: [];
    result: Partial<Record<TerminalCli, boolean>>;
  };
  'ok:terminal:dock-state': {
    args: [];
    result: OkTerminalDockState;
  };
  'ok:terminal:set-dock-state': {
    args: [req: OkTerminalDockStateUpdate];
    result: OkTerminalDockStateWriteResult;
  };
}
