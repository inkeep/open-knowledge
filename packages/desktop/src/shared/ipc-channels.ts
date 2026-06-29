import type {
  BranchInfoResponse,
  CheckoutResponse,
  CreateNewBannerKind,
  EditorId,
  LocalOpOkInitResponse,
  OkFolderState,
  TerminalCli,
} from '@inkeep/open-knowledge-core';
import type {
  FindEnclosingGitRootResult,
  FindEnclosingProjectRootResult,
  ScaffoldPlan,
} from '@inkeep/open-knowledge-server';
import type { BuildAndOpenResult } from '../main/ipc/install-skill.ts';
import type { SeedApplyResult, SeedListPacksResult, SeedPlanResult } from '../main/ipc/seed.ts';
import type { KeyringSmokeResult } from '../utility/keyring-smoke.ts';
import type {
  CheckTargetExistsResult,
  ClaudeReadiness,
  CliReadiness,
  HeadBranchInfo,
  OkDesktopConfig,
  OkLocalOpAuthReposResponse,
  OkLocalOpAuthStatusResponse,
  OkPtyCreateResult,
  OkServerRestartOutcome,
  OkSharePayloadFields,
  OkThemeSource,
  OkUpdateChannel,
  SeedApplyOptions,
  SeedPlanOptions,
} from './bridge-contract.ts';
import type { EntryPoint } from './entry-point.ts';

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

/** Discriminated union of every result the single `ok:sharing:dispatch` channel can
 *  return. Distinguishing the `status` kind from the three `set-mode` kinds
 *  is what lets the renderer's `bridge.sharing.{status,setMode}` API surface
 *  recover the per-operation typing despite the consolidated wire channel. */
export type OkSharingResult = OkSharingStatusResult | OkSharingSetModeResult;

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: string;
  missing?: boolean;
  gitRemoteUrl?: string;
}

interface ProjectOpenRequest {
  path: string;
  target: 'new-window';
  entryPoint: EntryPoint;
  pendingDeepLinkTarget?: { kind: 'doc' | 'folder'; path: string };
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
  readonly owner: string;
  readonly repo: string;
}

type ShareValidateFolderResult =
  | { readonly kind: 'ok'; readonly gitRemoteUrl: string }
  | { readonly kind: 'not-git' }
  | { readonly kind: 'no-origin' }
  | { readonly kind: 'wrong-repo'; readonly actualOwner: string; readonly actualRepo: string }
  | { readonly kind: 'non-github' }
  | { readonly kind: 'symlink-escape' };

interface ProjectSessionState {
  openTabs: string[];
  pinnedTabIds: string[];
  activeDocName: string | null;
  activeTabId: string | null;
  updatedAt: string | null;
}

export type SpawnOutcome =
  | { ok: true }
  | { ok: false; reason: 'invalid-path' | 'not-installed' | 'timeout' | 'spawn-error' };

export interface HandoffStatsLine {
  readonly target: 'claude-cowork' | 'claude-code' | 'codex' | 'cursor';
  readonly host: 'electron' | 'web';
  readonly outcome: 'ok' | 'error';
  /** ISO 8601 timestamp from the caller — not generated server-side so tests
   *  can supply a deterministic value. */
  readonly ts: string;
  readonly reason?:
    | 'not-installed'
    | 'scheme-blocked'
    | 'web-endpoint-error'
    | 'invalid-payload'
    | 'dispatch-error'
    | 'web-host-cursor-unsupported';
  readonly scope?: 'selection';
}

/** Editor IDs known to the first-launch MCP consent flow. Aliased to
 *  `EditorId` from `@inkeep/open-knowledge-core` — single source of truth for
 *  the literal union. The alias preserves the local name so existing
 *  consumers (renderer + main) keep importing `McpWiringEditorId` from this
 *  module while the actual type is structurally identical to the canonical
 *  `EditorId`. */
export type McpWiringEditorId = EditorId;

/** Sensitive-path warning category mirrored across the IPC boundary —
 *  literal-union form so the renderer can switch on `kind` without pulling
 *  the main-side helper module. Matches `SensitivePathWarning['kind']` in
 *  `packages/desktop/src/main/folder-admission.ts`. */
type OnboardingWarningKind =
  | 'root'
  | 'home'
  | 'home-documents'
  | 'home-desktop'
  | 'home-downloads'
  | 'volumes-mount'
  | 'drive-root';

type OnboardingGitState = 'present' | 'absent' | 'shell-only';

/** Show payload pushed to the renderer when main decides to render the
 *  consent dialog. Carries everything the dialog renders without further IPC
 *  round-trips — except the file-count preview, which is throttled and
 *  fetched on demand. */
export interface OnboardingShowPayload {
  readonly pickedPath: string;
  readonly projectDir: string;
  readonly defaultContentDir: string;
  readonly gitState: OnboardingGitState;
  readonly gitRootPromoted: boolean;
  readonly warnings: readonly { readonly kind: OnboardingWarningKind }[];
  readonly editorOptions: readonly {
    readonly id: McpWiringEditorId;
    readonly label: string;
    /** True when this editor scaffolds a per-project MCP config; false when
     *  only the user-level config is writable. Surfaced as a per-row badge
     *  in the consent dialog so the user can distinguish project-scoped vs
     *  user-only editors before clicking Start. */
    readonly hasProjectConfig: boolean;
  }[];
}

export interface OnboardingConfirmRequest {
  readonly initGit: boolean;
  readonly contentDir: string;
  readonly additionalIgnores: string;
  readonly editorIds: readonly McpWiringEditorId[];
  readonly sharing: 'shared' | 'local-only';
}

/** Confirm result. `ok: false` includes a user-facing error string the
 *  dialog renders inline. */
export type OnboardingConfirmResult = { ok: true } | { ok: false; error: string };

/** Cancel result is always `ok: true` — cancel can't fail meaningfully (no
 *  fs writes happen). The shape is symmetric with confirm so the renderer
 *  store can use a single result type. */
export type OnboardingCancelResult = { ok: true } | { ok: false; error: string };

/** File-count probe request — the renderer asks main for an updated count
 *  after the user types into the Content directory field. The walk root is
 *  pinned to the projectDir main captured when it dispatched
 *  `ok:onboarding:show`; the renderer doesn't get to supply it. */
export interface OnboardingProbeContentRequest {
  readonly contentDir: string;
}

/** Probe response. `truncated` is true when the walk hit the cap before
 *  finishing (`count` reads as `≥ 50,000`). `error` carries the inline
 *  message; renderer renders it as `Preview unavailable: <error>` but
 *  doesn't block Start. */
export type OnboardingProbeContentResult =
  | {
      readonly ok: true;
      readonly count: number;
      readonly sample: readonly string[];
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly error: string };

/** Single entry in the consent dialog — one per editor in `ALL_EDITOR_IDS`.
 *  `detected: true` preselects the checkbox.
 *  `willReplace: true` signals that this editor has an existing
 *  `open-knowledge` entry that clicking Add would overwrite to the canonical
 *  npx MCP shape — surfaced per-row in the dialog so long-time CLI users who
 *  ran `ok init` months ago aren't surprised by namespace reclamation. */
export interface McpWiringEditorDetection {
  readonly id: McpWiringEditorId;
  readonly label: string;
  readonly detected: boolean;
  readonly willReplace: boolean;
}

/** Confirm payload from renderer → main. Editors the user checked when they
 *  clicked "Add". Subset of `McpWiringEditorId`. */
export interface McpWiringConfirmRequest {
  readonly editorIds: readonly McpWiringEditorId[];
}

/** Confirm / skip response shape. `ok:false` surfaces when (a)
 *  `writeUserMcpConfigs` throws, (b) any per-editor write returns
 *  `action:'failed'` (deferred-marker — caller fires a sonner toast since
 *  the dialog itself unmounts on result), or (c) the skip-marker write
 *  fails. The `error` string is user-facing copy. */
export type McpWiringConfirmResult = { ok: true } | { ok: false; error: string };
export type McpWiringSkipResult = { ok: true } | { ok: false; error: string };

/** Options for the open-folder native picker. `defaultPath` seeds the initial
 *  directory shown to the user (e.g., the project root for the consent dialog's
 *  Browse button). */
interface DialogOpenFolderOpts {
  readonly defaultPath?: string;
}

export type EditorActiveTargetSnapshot =
  | { readonly kind: 'doc'; readonly identifier: string }
  | { readonly kind: 'folder'; readonly identifier: string }
  | { readonly kind: 'asset'; readonly identifier: string }
  | { readonly kind: null };

export interface EditorViewMenuStateSnapshot {
  readonly showHiddenFiles: boolean;
  readonly canExpandAll: boolean;
  readonly canCollapseAll: boolean;
  readonly sidebarVisible: boolean;
  readonly docPanelVisible?: boolean;
  readonly terminalVisible?: boolean;
  readonly terminalLive?: boolean;
}

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
  'ok:project:get-info': { args: []; result: OkDesktopConfig };

  'ok:sharing:dispatch': {
    args: [request: { kind: 'status' } | { kind: 'set-mode'; mode: 'shared' | 'local-only' }];
    result: OkSharingResult;
  };
  'ok:project:list-recent': { args: []; result: RecentProject[] };
  'ok:project:remove-recent': { args: [projectPath: string]; result: undefined };
  'ok:project:get-session-state': { args: []; result: ProjectSessionState };
  'ok:project:set-session-state': { args: [state: ProjectSessionState]; result: undefined };
  'ok:project:open': { args: [request: ProjectOpenRequest]; result: undefined };
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
    args: [request: { projectPath: string; branch: string }];
    result: CheckoutResponse | null;
  };
  'ok:project:await-branch-switched': {
    args: [request: { projectPath: string; branch: string; timeoutMs: number }];
    result: { ok: true } | { ok: false; reason: 'timeout' | 'project-not-open' };
  };
  'ok:project:ok-init': {
    args: [request: { projectPath: string }];
    result: LocalOpOkInitResponse;
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
      },
    ];
    result: undefined;
  };
  /** Persisted last-used parent directory, or a platform-sensible default
   *  (`~/Documents/OpenKnowledge/`) on first launch. */
  'ok:fs:default-projects-root': { args: []; result: string };
  /** Classify the candidate path: missing (`free`), present but empty,
   *  or present with entries. Stat errors fall through to `free`. */
  'ok:fs:folder-state': {
    args: [path: string];
    result: OkFolderState;
  };
  /** Upward-walk for the nearest `.ok/config.yml` ancestor; null when none
   *  found inside the depth cap. Thin wrapper around the server-package helper. */
  'ok:fs:find-enclosing-project-root': {
    args: [path: string];
    result: FindEnclosingProjectRootResult | null;
  };
  /** Upward-walk for the nearest `.git` ancestor (file or directory; worktrees
   *  count); null when none found inside the depth cap. Thin wrapper around the
   *  server-package helper. */
  'ok:fs:find-enclosing-git-root': {
    args: [path: string];
    result: FindEnclosingGitRootResult | null;
  };
  /** Permanently delete a `.git` directory at `<gitRoot>/.git`. Caller passes
   *  the gitRoot (the directory CONTAINING `.git`), not the `.git` path itself
   *  — main appends `.git` and validates the resolved basename. Used only by
   *  the Create-new-project dialog's confirm-git banner action; the user has
   *  already confirmed inline. Idempotent: succeeds if `.git` is already
   *  absent. Refuses any path whose resolved basename isn't `.git` so the
   *  channel can't be coerced into a general-purpose `rm -rf`. */
  'ok:fs:remove-git-folder': {
    args: [gitRoot: string];
    result: undefined;
  };
  'ok:project:record-create-new-banner-shown': {
    args: [banner: CreateNewBannerKind];
    result: undefined;
  };
  'ok:navigator:open': { args: []; result: undefined };
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
  'ok:theme:applied': {
    args: [opts?: { reducedTransparency?: boolean }];
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

  'ok:onboarding:confirm': {
    args: [request: OnboardingConfirmRequest];
    result: OnboardingConfirmResult;
  };
  'ok:onboarding:cancel': { args: []; result: OnboardingCancelResult };
  'ok:onboarding:renderer-ready': { args: []; result: undefined };
  /** Async probe for the file-count preview line in the dialog. The walk
   *  caps at 50,000 entries. 750 ms throttle is enforced renderer-side;
   *  main runs the probe synchronously but yields each request to a
   *  `setImmediate` boundary so the IPC reply doesn't block the main loop
   *  on huge trees. */
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

  'ok:pty:create': {
    args: [opts: { cols: number; rows: number }];
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
  'ok:terminal:claude-assist': {
    args: [req: { action: 'preflight' | 'rewire' }];
    result: ClaudeReadiness;
  };
  'ok:terminal:cli-preflight': {
    args: [req: { cli: TerminalCli }];
    result: CliReadiness;
  };
}
