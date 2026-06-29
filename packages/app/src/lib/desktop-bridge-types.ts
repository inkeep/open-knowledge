import type {
  BranchInfoResponse,
  CheckoutResponse,
  CreateNewBannerKind,
  EditorId,
  LocalOpOkInitResponse,
  OkFolderState,
  RecentProjectEntry,
  TerminalCli,
} from '@inkeep/open-knowledge-core';

export type { OkFolderState, RecentProjectEntry };

/** Seed scaffolder shapes — structurally duplicated from
 * `@inkeep/open-knowledge-server`'s seed module. See core's desktop-bridge.ts
 * for rationale (avoids pulling server into the app compilation tree).
 *
 * Folder defaults moved out of `config.yml` `folders:` and into nested
 * `<folder>/.ok/frontmatter.yml` files written via the standard file-entry
 * path. The previous `OkFolderRule` / `OkScaffoldConfigEdit` mirror types +
 * the `configEdits` field on `OkScaffoldPlan` were removed alongside. */
interface OkScaffoldFileEntry {
  path: string;
  kind: 'folder' | 'file';
  contentPreview?: string;
}
interface OkScaffoldSkipEntry {
  path: string;
  reason: 'already-exists' | 'user-content' | 'glob-collision';
}
export interface OkScaffoldPlan {
  created: OkScaffoldFileEntry[];
  skipped: OkScaffoldSkipEntry[];
  warnings: string[];
  /** The pack's project-local skill, when it ships one. `pending` = the skill
   *  source is absent from `.ok/skills/` and apply would (re)author it, so the
   *  pack isn't fully set up even if its folders/templates exist. */
  packSkill?: { name: string; pending: boolean };
}
interface OkScaffoldApplyError {
  path: string;
  error: string;
}
export interface OkScaffoldApplyResult {
  applied: number;
  errors: OkScaffoldApplyError[];
  durationMs: number;
  packSkillsInstalled: string[];
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

interface OkSeedPlanOptions {
  rootDir?: string;
  packId?: OkPackId;
}

interface OkSeedApplyOptions {
  packId?: OkPackId;
}

interface OkSeedPackFolderInfo {
  path: string;
  summary: string;
}

interface OkSeedPackEntryCounts {
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

export type OkSeedPlanResult =
  | { ok: true; plan: OkScaffoldPlan }
  | { ok: false; error: OkSeedError };
export type OkSeedApplyResult =
  | { ok: true; result: OkScaffoldApplyResult }
  | { ok: false; error: OkSeedError };
export type OkSeedListPacksResult =
  | { ok: true; packs: OkSeedPackInfo[] }
  | { ok: false; error: { kind: 'internal'; message: string } };

/** Pure-fs upward-walk result types mirrored from
 *  `@inkeep/open-knowledge-server`'s `fs/` module. Structurally duplicated
 *  for the same reason as the seed shapes above. */
export interface OkFindEnclosingProjectRootResult {
  readonly rootPath: string;
  readonly distance: number;
}
export interface OkFindEnclosingGitRootResult {
  readonly gitRoot: string;
  readonly distance: number;
}

type OkDesktopMode = 'editor' | 'navigator';

export interface OkDesktopConfig {
  readonly collabUrl: string;
  readonly apiOrigin: string;
  readonly projectPath: string;
  readonly projectName: string;
  readonly mode: OkDesktopMode;
  readonly e2eSmoke: boolean;
  readonly singleFile: boolean;
  readonly initialDoc: string | null;
}

type OkMenuAction =
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
  | 'new-from-template'
  | 'duplicate'
  | 'move-to-trash'
  | 'reveal-in-finder'
  | 'send-to-ai'
  | 'copy-full-path'
  | 'copy-relative-path'
  | 'toggle-show-hidden-files'
  | 'expand-all-tree'
  | 'collapse-all-tree'
  | 'toggle-doc-panel'
  | 'toggle-terminal'
  | 'new-terminal'
  | 'kill-terminal';

type OkUnsubscribe = () => void;

export type OkProjectEntryPoint =
  | 'create-new'
  | 'create-new-nested-redirect'
  | 'pick-existing'
  | 'recents'
  | 'deep-link'
  | 'drag-drop'
  | 'share-receive';

interface ProjectSessionState {
  openTabs: string[];
  pinnedTabIds: string[];
  activeDocName: string | null;
  activeTabId: string | null;
  updatedAt: string | null;
}

export type CheckTargetExistsResult = 'exists' | 'missing' | 'unreadable';

export type ShareTarget =
  | { readonly kind: 'doc'; readonly docPath: string }
  | { readonly kind: 'folder'; readonly folderPath: string };

export function shareTargetPath(target: ShareTarget): string {
  return target.kind === 'doc' ? target.docPath : target.folderPath;
}

export interface HeadBranchInfo {
  readonly currentBranch: string | null;
  readonly headSha: string | null;
  readonly detached: boolean;
}

interface OkUpdateDownloadedInfo {
  readonly version: string;
}

interface OkUpdateRelaunchingInfo {
  readonly version: string;
}

interface OkUpdateRelaunchFailedInfo {
  readonly version: string;
  readonly message?: string;
  readonly downloadUrl?: string;
}

interface OkWhatsNewInfo {
  readonly version: string;
  readonly releaseUrl: string;
}

interface OkUpdateStuckHintInfo {
  readonly downloadUrl: string;
}

/** Local copy — see canonical `OkSharePayloadFields` in
 *  `packages/desktop/src/shared/bridge-contract.ts`. */
export interface OkSharePayloadFields {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly sharedUrl: string;
  readonly target: ShareTarget;
}

/** Local copy — see canonical `OkShareReceivedPayload` in
 *  `packages/desktop/src/shared/bridge-contract.ts`. */
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
  | { readonly kind: 'non-github' }
  | { readonly kind: 'symlink-escape' };

type OkUpdateChannel = 'latest' | 'beta';

type OkThemeSource = 'system' | 'light' | 'dark';

interface OkStateSnapshot {
  readonly channel: OkUpdateChannel;
  readonly schemaIncompatibility: {
    readonly currentBuild: string;
    readonly persistedSchemaVersion: number;
    readonly maxSupported: number;
  } | null;
}

export type OkMcpWiringEditorId = EditorId;

/** Payload passed to `mcpWiring.onShow` subscribers. `willReplace: true`
 *  signals the editor has an existing OK-managed MCP entry (canonical npx,
 *  `-y` variant, or prior cliPath shape) that Add would overwrite (Pass 1
 *  Major #8). */
export interface OkMcpWiringShowPayload {
  readonly detectedEditors: readonly {
    readonly id: OkMcpWiringEditorId;
    readonly label: string;
    readonly detected: boolean;
    readonly willReplace: boolean;
  }[];
}

export type OkMcpWiringResult = { ok: true } | { ok: false; error: string };

export type OkOnboardingWarningKind =
  | 'root'
  | 'home'
  | 'home-documents'
  | 'home-desktop'
  | 'home-downloads'
  | 'volumes-mount'
  | 'drive-root';

type OkOnboardingGitState = 'present' | 'absent' | 'shell-only';

export interface OkOnboardingShowPayload {
  readonly pickedPath: string;
  readonly projectDir: string;
  readonly defaultContentDir: string;
  readonly gitState: OkOnboardingGitState;
  readonly gitRootPromoted: boolean;
  readonly warnings: readonly { readonly kind: OkOnboardingWarningKind }[];
  readonly editorOptions: readonly {
    readonly id: OkMcpWiringEditorId;
    readonly label: string;
    /** True when the editor exposes a per-project MCP config file; false
     *  when only the user-level config is writable. Drives the per-row
     *  scope badge in the consent dialog. */
    readonly hasProjectConfig: boolean;
  }[];
}

export interface OkOnboardingConfirmRequest {
  readonly initGit: boolean;
  readonly contentDir: string;
  readonly additionalIgnores: string;
  readonly editorIds: readonly OkMcpWiringEditorId[];
  readonly sharing: 'shared' | 'local-only';
}

export type OkOnboardingResult = { ok: true } | { ok: false; error: string };

interface OkOnboardingProbeContentRequest {
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

interface OkLocalOpStream<E> {
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
    }
  | { authenticated: false; host: string; error?: string };

interface OkLocalOpRepoEntry {
  full_name: string;
  clone_url: string;
  private: boolean;
}

export type OkLocalOpAuthReposResponse =
  | { ok: true; host: string; repos: OkLocalOpRepoEntry[] }
  | { ok: false; error: string };

export type OkLocalOpAuthSignoutResponse = { ok: true } | { ok: false; error?: string };

type OkEditorActiveTargetSnapshot =
  | { readonly kind: 'doc'; readonly identifier: string }
  | { readonly kind: 'folder'; readonly identifier: string }
  | { readonly kind: 'asset'; readonly identifier: string }
  | { readonly kind: null };

interface OkEditorViewMenuStateSnapshot {
  readonly showHiddenFiles: boolean;
  readonly canExpandAll: boolean;
  readonly canCollapseAll: boolean;
  readonly sidebarVisible: boolean;
  readonly docPanelVisible?: boolean;
  readonly terminalVisible?: boolean;
  readonly terminalLive?: boolean;
}

interface OkKeyringSmokeResult {
  ok: boolean;
  backend?: 'keyring' | 'file';
  error?: string;
  durationMs?: number;
  timestamp: string;
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

export interface OkServerVersionDriftInfo {
  readonly relation: 'older' | 'newer';
  readonly dimension: 'protocol' | 'runtime';
  readonly serverRuntime: string;
  readonly appRuntime: string;
}

export type OkServerRestartOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'eperm' | 'other' };

export type OkPtyCreateResult =
  | { readonly ok: true; readonly ptyId: string }
  | { readonly ok: false; readonly reason: 'no-project' | 'not-consented' };

export interface OkPtyListEntry {
  readonly ptyId: string;
}

export type OkPtyAdoptResult =
  | { readonly ok: true; readonly replay: string }
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

export interface ClaudeReadiness {
  readonly claude: 'present' | 'not-found' | 'unknown';
  readonly mcp: 'wired' | 'needs-rewire';
  /** True when the project's own `open-knowledge` `.mcp.json` entry is verified
   *  to be OK's canonical managed server (cli `isOwnManagedEntry`), so the docked
   *  terminal may pre-approve it on Claude launch instead of re-showing Claude's
   *  trust prompt. False/absent for a foreign, tampered, or missing entry (the
   *  supply-chain risk in a shared/cloned project) — launch bare and let Claude
   *  prompt. Computed per-project by the desktop preflight; absent means false
   *  (fail-safe). */
  readonly mcpPreApprovable?: boolean;
  /** Set only on a `rewire`-action result when re-arming MCP wiring threw, so
   *  the renderer can surface the failure instead of the button silently no-op'ing. */
  readonly rewireError?: string;
}

/** On-PATH readiness for a non-Claude agent CLI (codex / cursor-agent) in the
 *  docked terminal. Canonical shape in `desktop/src/shared/bridge-contract.ts`;
 *  mirrored verbatim here (drift-tested). */
export interface CliReadiness {
  readonly onPath: 'present' | 'not-found' | 'unknown';
}

export interface OkDesktopBridge {
  readonly config: OkDesktopConfig;
  onProjectSwitched(cb: (next: OkDesktopConfig) => void): OkUnsubscribe;
  onMenuAction(cb: (action: OkMenuAction) => void): OkUnsubscribe;
  onUpdateDownloaded(cb: (info: OkUpdateDownloadedInfo) => void): OkUnsubscribe;
  onUpdateRelaunching(cb: (info: OkUpdateRelaunchingInfo) => void): OkUnsubscribe;
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
    }) => void,
  ): OkUnsubscribe;
  onShareReceived(cb: (payload: OkShareReceivedPayload) => void): OkUnsubscribe;
  onServerVersionDrift(cb: (info: OkServerVersionDriftInfo) => void): OkUnsubscribe;
  onServerRestarted(cb: (info: { readonly appRuntime: string }) => void): OkUnsubscribe;
  onServerReclaimed(cb: (info: { readonly appRuntime: string }) => void): OkUnsubscribe;
  restartServer(projectPath: string): Promise<OkServerRestartOutcome>;
  setThemeSource(source: OkThemeSource): Promise<{ ok: true }>;
  signalThemeApplied(opts?: { reducedTransparency?: boolean }): void;
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
      readonly reason?:
        | 'not-installed'
        | 'scheme-blocked'
        | 'web-endpoint-error'
        | 'invalid-payload'
        | 'dispatch-error'
        | 'web-host-cursor-unsupported';
      readonly scope?: 'selection';
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
  };
  project: {
    listRecent(): Promise<RecentProjectEntry[]>;
    removeRecent(path: string): Promise<void>;
    getSessionState(): Promise<ProjectSessionState>;
    setSessionState(state: ProjectSessionState): Promise<void>;
    open(request: {
      path: string;
      target: 'new-window';
      entryPoint: OkProjectEntryPoint;
      pendingDeepLinkTarget?: { kind: 'doc' | 'folder'; path: string };
      pendingBranch?: string | null;
      pendingShareBranchSwitch?: {
        share: OkSharePayloadFields;
        projectPath: string;
        currentBranch: string | null;
      };
    }): Promise<void>;
    createNew(args: {
      parent: string;
      name: string;
      editors: OkMcpWiringEditorId[];
      sharing?: 'shared' | 'local-only';
    }): Promise<void>;
    recordCreateNewBannerShown(banner: CreateNewBannerKind): Promise<void>;
    checkTargetExists(request: {
      projectPath: string;
      kind: 'doc' | 'folder';
      path: string;
    }): Promise<CheckTargetExistsResult>;
    readHeadBranch(projectPath: string): Promise<HeadBranchInfo>;
    fetchBranchInfo(request: {
      projectPath: string;
      branch: string;
      kind: 'doc' | 'folder';
      path: string;
    }): Promise<BranchInfoResponse | null>;
    runCheckout(request: { projectPath: string; branch: string }): Promise<CheckoutResponse | null>;
    awaitBranchSwitched(request: {
      projectPath: string;
      branch: string;
      timeoutMs: number;
    }): Promise<{ ok: true } | { ok: false; reason: 'timeout' | 'project-not-open' }>;
    okInit(request: { projectPath: string }): Promise<LocalOpOkInitResponse>;
    close(): Promise<void>;
  };

  sharing: {
    status(): Promise<OkSharingStatusResult>;
    setMode(mode: 'shared' | 'local-only'): Promise<OkSharingSetModeResult>;
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
    confirm(editorIds: readonly OkMcpWiringEditorId[]): Promise<OkMcpWiringResult>;
    skip(): Promise<OkMcpWiringResult>;
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
          | {
              readonly kind: 'sharing-no-git';
              readonly requestedMode: 'local-only';
            },
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
      owner: string;
      repo: string;
    }): Promise<ShareFolderValidationResult>;
  };
  editor: {
    notifyActiveTargetChanged(target: OkEditorActiveTargetSnapshot): void;
    notifyViewMenuStateChanged(state: Partial<OkEditorViewMenuStateSnapshot>): void;
  };
  sidebar: {
    expandAll(cb: () => void): OkUnsubscribe;
    collapseAll(cb: () => void): OkUnsubscribe;
  };

  terminal: {
    create(opts: { cols: number; rows: number }): Promise<OkPtyCreateResult>;
    input(ptyId: string, data: string): void;
    resize(ptyId: string, cols: number, rows: number): void;
    kill(ptyId: string): Promise<void>;
    drain(ptyId: string, bytes: number): void;
    list(): Promise<OkPtyListEntry[]>;
    adopt(ptyId: string): Promise<OkPtyAdoptResult>;
    getDockState(): Promise<{ visible: boolean }>;
    onData(cb: (msg: OkPtyData) => void): OkUnsubscribe;
    onExit(cb: (msg: OkPtyExit) => void): OkUnsubscribe;
    claudePreflight(): Promise<ClaudeReadiness>;
    cliPreflight(cli: TerminalCli): Promise<CliReadiness>;
    rewireClaudeMcp(): Promise<ClaudeReadiness>;
  };

  readonly platform: 'darwin' | 'win32' | 'linux';
  readonly appVersion: string;
  debug?: {
    keyringSmoke(): Promise<OkKeyringSmokeResult>;
  };
}

declare global {
  interface Window {
    okDesktop?: OkDesktopBridge;
  }
}
