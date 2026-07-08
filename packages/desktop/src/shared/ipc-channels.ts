/**
 * Typed IPC request channel map (renderer → main, request/response pattern).
 *
 * Hand-rolled discriminated union (not tRPC/tipc): every channel name is a
 * top-level key in `RequestChannels`; each key maps to
 * `{ args: [...]; result: T }`. The preload-side `invoke<K>()` helper (see
 * `./ipc-invoke.ts`) uses these types for full autocomplete + compile-time
 * safety. Grep-able channel names are the primary observability — a
 * channel name tells you exactly where the handler lives in main and where
 * the caller lives in renderer without touching a debugger.
 *
 * Scale-match trigger: at >20 channels, migrate baseline to
 * `@electron-toolkit/typed-ipc` or `@egoist/tipc` — well past the trigger;
 * migrate before adding another batch. The channel count is pinned by
 * `tests/integration/ipc-channel-count-ratchet.test.ts` (a one-way ratchet);
 * every bump carries a documented could-not-fold rationale there.
 *
 * The docked-terminal PTY surface (`ok:pty:create` + the fire-and-forget
 * `input`/`resize`/`kill`/`drain`, plus the reload-survival `list`/`adopt`)
 * could not be folded: the STOP rule forbids any arbitrary-exec IPC outside the
 * `ok:pty:*` framing, and they are the smallest faithful PTY protocol. Streaming
 * output + exit ride `EventChannels` (`ok:pty:data` / `ok:pty:exit`). The
 * `ok:terminal:*` reads — `claude-assist` (Claude readiness preflight + MCP
 * re-arm) and `dock-state` (per-window dock visibility, read on reload) — are
 * NOT exec channels. The full could-not-fold rationale lives in the ratchet test.
 * Sidebar tree-state directives (`ok:sidebar:expand-all` /
 * `ok:sidebar:collapse-all`) ship as `EventChannels` entries instead because
 * they are main→renderer pushes. The team's commitment remains: migrate to
 * typed-ipc before any further channel additions; payload-widening on
 * existing channels is preferred over net-new hand-rolled channels until
 * that migration lands.
 *
 * Count is 81 (ratchet cap 81). The 74→75 bump reconciled a merge collision:
 * the worktree selector (`ok:worktree:dispatch`) and the terminal-controls PR
 * (`ok:terminal:cli-installed-map`) each landed in the base tree's single free
 * slot concurrently. The 75→76 bump then unioned in the desktop
 * startup-instrumentation channel (`ok:startup:renderer-marks`), which landed
 * on main in parallel. The 76→77 bump added the share-receive branch-switch
 * dialog's verdict probe (`ok:project:fetch-target-status`). The 77→78 bump
 * added Settings → AI tools (`ok:integrations:dispatch`, a status+set
 * discriminated fold per the worktree-dispatch precedent). The 78→79 bump added
 * its project-scoped sibling Settings → This project → AI tools
 * (`ok:project-integrations:dispatch`, same status+set fold, scoped to the
 * sender window's project). The 79→81 bump added terminal-tab reload-survival
 * (`ok:pty:set-meta` + `ok:pty:set-order`) — two slots, following the `ok:pty:*`
 * one-channel-per-operation design rather than a dispatch fold. Full rationale in
 * the ratchet test header.
 */

import type {
  BranchInfoResponse,
  CheckoutResponse,
  CreateNewBannerKind,
  EditorId,
  LocalOpOkInitResponse,
  OkFolderState,
  ShareTargetStatusResponse,
  TerminalCli,
  WorktreeCreateRequest,
  WorktreeCreateResult,
  WorktreeListResult,
} from '@inkeep/open-knowledge-core';
import type {
  FindEnclosingGitRootResult,
  FindEnclosingProjectRootResult,
  PackId,
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
  OkPtyAdoptResult,
  OkPtyCreateResult,
  OkPtyListEntry,
  OkServerRestartOutcome,
  OkSharePayloadFields,
  OkThemeSource,
  OkUpdateChannel,
  SeedApplyOptions,
  SeedPlanOptions,
} from './bridge-contract.ts';
import type { EntryPoint } from './entry-point.ts';

/** Sharing-mode — IPC payload types. */
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

/** Recent-project row as surfaced to the Navigator. */
export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: string;
  /** true if the folder no longer exists on disk (rendered dimmed with "Missing" badge). */
  missing?: boolean;
  /**
   * Canonical GitHub remote URL when the project has a github.com origin.
   * Read at open-time from `<projectPath>/.git/config`, normalized to
   * `https://github.com/<owner>/<repo>.git`. Undefined for non-git, no-
   * origin, or non-GitHub projects. Powers the Q1 lookup in the share-
   * receive decision tree.
   */
  gitRemoteUrl?: string;
  /**
   * Git-worktree relationship, computed at list-time (not persisted) so the
   * project switcher can nest linked worktrees under their main project.
   * Absent for non-git projects.
   */
  gitCommonDir?: string;
  mainRoot?: string;
  isLinkedWorktree?: boolean;
  branch?: string | null;
}

/** Project-open request payload (IPC `ok:project:open`). */
interface ProjectOpenRequest {
  path: string;
  /**
   * Every project open spawns a new editor BrowserWindow.
   * `target: 'new-window'` is the only supported value today — the field
   * is kept for forward-compat if a future spec re-introduces switch-in-
   * current-window.
   */
  target: 'new-window';
  /**
   * Tags the originating Navigator surface so the consent-dialog gate can
   * branch on user intent. Create-new flows route through their own
   * `ok:project:create-new` handler; the other values open through the
   * consent dialog or directly into an already-discovered ancestor `.ok/`.
   * The renderer is responsible for setting this — IPC consumers trust
   * the value because the renderer is the only authoritative source for
   * which button the user clicked.
   */
  entryPoint: EntryPoint;
  /**
   * Optional kind-discriminated target to deep-link into after the project
   * window mounts. Used by share-receive: Q1 hits and Q2/Q3 success both pass
   * the share's target (a `doc` path or a `folder` path) so the editor opens
   * it directly. Threaded through to `wm.createProjectWindow`'s
   * `pendingDeepLinkTarget` (cold spawn) and `sendDeepLink` (warm-focus).
   * Mirrors the `openknowledge://open?project=&doc=` plumbing.
   */
  pendingDeepLinkTarget?: { kind: 'doc' | 'folder'; path: string };
  /**
   * Optional share branch riding alongside `pendingDeepLinkTarget` so the
   * renderer can detect branch mismatches on the share-receive Path 2.
   * Threaded through to `wm.createProjectWindow`'s `pendingBranch` (cold
   * spawn) and the warm-focus `ok:deep-link` payload. Null / undefined /
   * absent are treated identically (no branch — back-compat).
   */
  pendingBranch?: string | null;
  /**
   * Optional branch-switch payload for the share-receive "I already have it
   * locally" (Q2) path. See canonical JSDoc in `./bridge-contract.ts`. When
   * the located clone is on a different branch than the share, the
   * `ok:project:open` handler forwards this to `openProject` so main delivers
   * the `project-branch-switch` surface instead of a plain deep-link open.
   * Structurally matches `ShareDeepLinkBranchSwitchPayload` (url-scheme.ts).
   */
  pendingShareBranchSwitch?: {
    share: OkSharePayloadFields;
    projectPath: string;
    currentBranch: string | null;
  };
  /**
   * `true` iff the dispatcher's candidate-selection evaluated more than
   * one candidate. Threaded through to the renderer's `ok:deep-link`
   * payload so `installDeepLinkListener` can suppress the "Opened
   * on branch X" toast for single-clone (P4) receivers and surface it
   * for multi-worktree receivers where the dispatched window's
   * identity is the actionable signal.
   *
   * Treat undefined / absent as `false` (back-compat with legacy
   * dispatchers that never set the flag — they're, by definition,
   * pre-multi-worktree, i.e., single-candidate).
   */
  pendingMultiCandidate?: boolean;
}

/** Folder-validation request + result for IPC `ok:share:validate-folder`. */
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

/** Outcome of a spawn probe — narrow shape so renderer can branch cleanly without inspecting strings. */
export type SpawnOutcome =
  | { ok: true }
  | { ok: false; reason: 'invalid-path' | 'not-installed' | 'timeout' | 'spawn-error' };

/**
 * Append-only telemetry payload — one JSONL line per Open-in-Agent
 * dispatch written to `~/.ok/stats.jsonl`. Zero phone-home: local-only
 * diagnostic counter — when a dogfood user reports "it didn't work," the
 * file gives target / outcome / reason history without any network egress.
 *
 * Literal-union fields mirror `HandoffTarget`, `HandoffFailureReason`, and
 * `HandoffScope` from `@inkeep/open-knowledge-core/handoff/types.ts`. Duplication is deliberate
 * — shared/ipc-channels.ts deliberately has no app-package dependencies
 * (same pattern as `SpawnOutcome` above and the `bridge-contract.ts`
 * mirroring).
 */
export interface HandoffStatsLine {
  readonly target: 'claude-cowork' | 'claude-code' | 'codex' | 'cursor';
  readonly host: 'electron' | 'web';
  readonly outcome: 'ok' | 'error';
  /** ISO 8601 timestamp from the caller — not generated server-side so tests
   *  can supply a deterministic value. */
  readonly ts: string;
  /** Mirrors `HandoffFailureReason` literal union — present only on `outcome:'error'`. */
  readonly reason?:
    | 'not-installed'
    | 'scheme-blocked'
    | 'web-endpoint-error'
    | 'invalid-payload'
    | 'dispatch-error'
    | 'web-host-cursor-unsupported';
  /** Mirrors `HandoffScope` — set only on a selection-scoped dispatch. */
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

/** State of the picked folder's `.git` directory at the moment the dialog opens. */
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
    /** True when this editor also has a user-global config surface. Optional
     *  for back-compat with older payload producers; absent reads as `true`
     *  (every pre-Pi editor was user-writable). Pi is the first
     *  project-scope-only editor — `false` renders "(project-level only)". */
    readonly hasUserConfig?: boolean;
  }[];
}

/** User clicked Start with these values. */
export interface OnboardingConfirmRequest {
  readonly initGit: boolean;
  readonly contentDir: string;
  readonly additionalIgnores: string;
  readonly editorIds: readonly McpWiringEditorId[];
  /**
   * Sharing-mode posture. `shared` — commit
   * OK config alongside content (default). `local-only` — append OK
   * artifact paths to `.git/info/exclude` so they stay out of git.
   *
   * When the picked folder has no git repo (`gitState === 'absent' |
   * 'shell-only'` AND the user opts out of `initGit`), this field is still
   * sent verbatim; main's post-scaffold step ignores `local-only` when no
   * gitdir resolves (with a non-blocking toast).
   */
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

/** PATH-install leg of the first-launch consent dialog. Computed read-only
 *  at arming time from the path-install marker + rc targets.
 *  `rcFilesToTouch` names the shell files a grant would edit (tildified for
 *  display; recorded opt-outs excluded). `shellDetected: false` — no
 *  touchable rc files — hides the PATH row. `alreadyInstalled` renders the
 *  row as informational: a managed block is already on disk or consent was
 *  already granted, so there is no new decision to solicit. */
export interface McpWiringPathInstallDescriptor {
  readonly shellDetected: boolean;
  readonly rcFilesToTouch: readonly string[];
  readonly alreadyInstalled: boolean;
}

/** Confirm payload from renderer → main. Editors the user checked when they
 *  clicked "Add". Subset of `McpWiringEditorId`.
 *
 *  `pathInstall` is the PATH toggle, tri-state: `true` → append the managed
 *  rc block (consent granted); `false` → record declined, touch no rc file;
 *  absent → the dialog solicited no PATH decision (row hidden or
 *  informational) — the path-install marker is left untouched. */
export interface McpWiringConfirmRequest {
  readonly editorIds: readonly McpWiringEditorId[];
  readonly pathInstall?: boolean;
  /** Bundle ids the user left checked. Present ⇒ a skill decision was
   *  solicited; every offered bundle not listed is recorded declined (and
   *  removed if already installed). */
  readonly skills?: readonly string[];
}

/** One user-global skill row in the first-launch consent dialog. Computed
 *  read-only at arming time from `USER_GLOBAL_BUNDLE_IDS` + disk/marker state.
 *  `alreadyInstalled: true` renders the row pre-checked as an existing install
 *  the user can uncheck to remove. */
export interface McpWiringGlobalSkillDescriptor {
  readonly id: string;
  readonly name: string;
  readonly alreadyInstalled: boolean;
}

/** Confirm / skip response shape. `ok:false` surfaces when (a)
 *  `writeUserMcpConfigs` throws, (b) any per-editor write returns
 *  `action:'failed'` (deferred-marker — caller fires a sonner toast since
 *  the dialog itself unmounts on result), or (c) the skip-marker write
 *  fails. The `error` string is user-facing copy. */
export type McpWiringConfirmResult = { ok: true } | { ok: false; error: string };
export type McpWiringSkipResult = { ok: true } | { ok: false; error: string };

/** Per-editor MCP state for Settings → AI tools.
 *  - `installed` — OK's own managed entry is in the editor's user config;
 *    checkbox renders checked and unchecking removes the entry.
 *  - `not-installed` — no entry under OK's server name (or no config file);
 *    checking writes the canonical entry.
 *  - `foreign` — an entry EXISTS under OK's server name but is not
 *    recognizably OK's own (customized/forked wrapper). Rendered checked
 *    with a disclosure; uninstall refuses (guest discipline), install
 *    overwrites under the namespace-ownership posture.
 *  - `unmanageable` — a present config OK cannot safely edit (unparseable /
 *    oversize / duplicate container). Row renders disabled. */
export type IntegrationsEditorState = 'installed' | 'not-installed' | 'foreign' | 'unmanageable';

export interface IntegrationsEditorStatus {
  readonly id: McpWiringEditorId;
  readonly label: string;
  readonly detected: boolean;
  readonly state: IntegrationsEditorState;
  /** Tildified user-config file this row edits; null when the resolver can't
   *  produce one on this platform. Disclosure only — writes re-resolve. */
  readonly configPath: string | null;
  /** Technical locator of OK's entry inside the config, e.g.
   *  `mcpServers.open-knowledge` or `[mcp_servers.open-knowledge]`. */
  readonly entryLocator: string;
}

/** PATH-shim row for Settings → AI tools. `installed` reflects the managed
 *  rc block actually being on disk (not merely a recorded grant), so the
 *  checkbox mirrors what external terminals really resolve. */
export interface IntegrationsPathStatus {
  readonly shellDetected: boolean;
  readonly rcFilesToTouch: readonly string[];
  readonly installed: boolean;
}

export interface IntegrationsSkillStatus {
  readonly id: string;
  readonly name: string;
  readonly installed: boolean;
  /** Tildified directories a toggle touches: the central `~/.agents/skills`
   *  copy plus each per-host copy whose host root exists on this machine. */
  readonly paths: readonly string[];
}

/** Full component inventory for Settings → AI tools. `available: false`
 *  means the desktop's install actors are gated off for this process
 *  (non-darwin, unpackaged dev build without OK_M6B_FORCE) — status still
 *  reads, but the section renders read-only. */
export interface IntegrationsStatus {
  readonly available: boolean;
  readonly editors: readonly IntegrationsEditorStatus[];
  readonly path: IntegrationsPathStatus;
  readonly skills: readonly IntegrationsSkillStatus[];
}

/** One toggleable component in Settings → AI tools. */
export type IntegrationsComponentRef =
  | { readonly kind: 'editor'; readonly id: McpWiringEditorId }
  | { readonly kind: 'path' }
  | { readonly kind: 'skill'; readonly id: string };

export interface IntegrationsSetRequest {
  readonly component: IntegrationsComponentRef;
  readonly enabled: boolean;
}

/** Set-component response. Both arms carry a fresh status snapshot so the
 *  renderer re-renders truthfully even after a failed or refused toggle. */
export type IntegrationsSetResult =
  | { readonly ok: true; readonly status: IntegrationsStatus }
  | { readonly ok: false; readonly error: string; readonly status: IntegrationsStatus };

// ---------------------------------------------------------------------------
// Project-scope siblings — Settings → This project → AI tools
// ---------------------------------------------------------------------------

/** Post-install manual step a project MCP config needs before OK's tools
 *  actually connect — surfaced per row so a project-only install isn't a silent
 *  dead-end.
 *   - `approve-once`    — Claude Code: one per-user approval prompt per project.
 *   - `enable-manually` — Cursor: written but sits disabled until the user
 *     flips it in Settings → Tools & MCP (per user × workspace × machine; can't
 *     be pre-seeded from the repo).
 *   - `auto-connect`    — Codex: connects on the next turn for a trusted project.
 *   - `none`            — no known extra step. */
export type ProjectIntegrationsFollowUp =
  | 'approve-once'
  | 'enable-manually'
  | 'auto-connect'
  | 'none';

/** Per-editor project MCP config row. `state` reuses `IntegrationsEditorState`
 *  (installed / not-installed / foreign / unmanageable). `configPath` is
 *  project-relative (e.g. `.mcp.json`, `.cursor/mcp.json`). */
export interface ProjectIntegrationsEditorStatus {
  readonly id: McpWiringEditorId;
  readonly label: string;
  readonly state: IntegrationsEditorState;
  readonly configPath: string;
  readonly entryLocator: string;
  readonly followUp: ProjectIntegrationsFollowUp;
}

/** The single project runtime-skill row. A toggle installs/removes the skill
 *  across every project-skill-capable editor at once; `paths` lists each
 *  project-relative dir it touches. `installed` reflects the canonical
 *  `.claude/skills/open-knowledge` copy being on disk. */
export interface ProjectIntegrationsSkillStatus {
  readonly installed: boolean;
  readonly paths: readonly string[];
}

/** Component inventory for Settings → This project → AI tools. `hasProject:
 *  false` means no project resolved from the requesting window (the section
 *  shows an empty state; status still returns). `available: false` renders the
 *  section read-only. `projectDir` is tildified, disclosure only. */
export interface ProjectIntegrationsStatus {
  readonly available: boolean;
  readonly hasProject: boolean;
  readonly projectDir: string | null;
  readonly editors: readonly ProjectIntegrationsEditorStatus[];
  readonly skill: ProjectIntegrationsSkillStatus | null;
}

/** One toggleable component in Settings → This project → AI tools. The skill is
 *  a single row (no id) — it fans out across every capable editor. */
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

/** Options for the open-folder native picker. `defaultPath` seeds the initial
 *  directory shown to the user (e.g., the project root for the consent dialog's
 *  Browse button). */
interface DialogOpenFolderOpts {
  readonly defaultPath?: string;
}

/**
 * Renderer → main snapshot of what's currently active in the editor area.
 * Drives the macOS File menu's state-aware enable/disable: `'doc'` enables
 * doc-targeted items (Rename, Duplicate, Move to Trash, Open with AI on the active file);
 * `'folder'` enables folder-targeted items; `'asset'` enables file-targeted
 * rename/trash/reveal without Duplicate or Open with AI; `null` (no active
 * target — project scope) leaves Rename / Duplicate / Move to Trash disabled
 * and enables only project-level items (New File, Reveal in Finder for
 * `contentDir`, etc.).
 *
 * Intentionally narrower than the renderer's full `ResolvedNavigationTarget`
 * union — main only needs the enable/disable signal plus the
 * `identifier` payload it routes through bridge.shell.* / HTTP calls when the
 * user picks a menu item. Discriminated-union shape so TypeScript narrows
 * `identifier` per `kind` at consumer sites.
 */
export type EditorActiveTargetSnapshot =
  | { readonly kind: 'doc'; readonly identifier: string }
  | { readonly kind: 'folder'; readonly identifier: string }
  | { readonly kind: 'asset'; readonly identifier: string }
  | { readonly kind: null };

/**
 * Renderer → main snapshot of the View menu's checkbox + smart-hide state.
 * Drives the View menu's live `checked` reflection for the visibility
 * toggles and the `visible: false` smart-hide on Expand All / Collapse All.
 * `sidebarVisible` flips the Show/Hide Sidebar label on the View-menu
 * sidebar-toggle item.
 *
 * **DRIFT WARNING — this shape is mirrored in four places** for IPC-channel /
 * bridge-contract isolation (the bridge surfaces cannot import the wider bridge
 * module without coupling the layers). TypeScript catches drift at call-site
 * boundaries but not at the definitions — and this `ipc-channels` copy is the
 * one the call-site check misses: it is reached only through the channel-args
 * layer, never through `OkDesktopBridge`, and the preload→`invoke` hop passes
 * the wider `OkEditorViewMenuStateSnapshot` value in, so a field added to the
 * bridge copy but dropped here assigns silently (superset → subset) and main
 * never sees it. Keep these in lockstep:
 *
 *   1. `packages/desktop/src/shared/ipc-channels.ts` — `EditorViewMenuStateSnapshot` (this copy)
 *   2. `packages/desktop/src/shared/bridge-contract.ts` — `OkEditorViewMenuStateSnapshot`
 *   3. `packages/core/src/desktop-bridge.ts` — canonical `OkEditorViewMenuStateSnapshot`
 *   4. `packages/app/src/lib/desktop-bridge-types.ts` — renderer-side augmentation
 */
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
  /** Open native folder-picker. Canonical properties live in `dialog-helpers.ts`. */
  'ok:dialog:open-folder': {
    args: [opts?: DialogOpenFolderOpts];
    result: string | null;
  };
  /** Outbound URL via `shell.openExternal` (scheme allowlist enforced in main handler). */
  'ok:shell:open-external': { args: [url: string]; result: undefined };
  /**
   * Detect whether a URL scheme has a registered handler on this OS — used by
   * the "Open in Agent Desktop" dropdown to render disabled-with-tooltip rows
   * when the target app is not installed. Returns `{installed: false}` on any
   * failure (timeout, platform-API error) — conservative default.
   *
   * **Scheme format contract:** `scheme` is the scheme NAME without trailing
   * colon (e.g. `'claude'`, not `'claude:'`). This matches the Linux
   * `xdg-mime query default x-scheme-handler/<name>` shell-command form AND
   * the main-process handler's shell-injection sanitizer `^[a-z][a-z0-9+.-]*$`
   * which rejects colons by design. Callers with a colonful scheme (as in
   * `KNOWN_TARGETS.schemes` / `URL.protocol` / `ALLOWED_SCHEMES`) must strip
   * the trailing `:` before invoking — see `probeViaElectron` in
   * `packages/app/src/lib/handoff/install-detect.ts`.
   */
  'ok:shell:detect-protocol': {
    args: [scheme: string];
    result: { installed: boolean; displayName?: string };
  };
  /**
   * Cursor IDE step-1 folder spawn (pair of the cursor:// prompt URL that
   * fires from `shell.openExternal` after a settle delay). Dedicated channel —
   * not overloading `ok:shell:open-external` — because the threat model is a
   * command allowlist (PATH hijacking, arg injection) distinct from the URL-
   * scheme allowlist.
   */
  'ok:shell:spawn-cursor': { args: [path: string]; result: SpawnOutcome };
  /**
   * Reveal a file or folder in the OS file manager (Finder on macOS, Explorer
   * on Windows, default file manager on Linux). Wraps Electron's
   * `shell.showItemInFolder`. Path is validated against the caller window's
   * `projectPath` via `isPathWithinProject` — paths outside the project tree
   * (or invalid / non-absolute / null-byte-bearing) reject silently to bound
   * a renderer compromise from steering the OS file manager at arbitrary
   * filesystem locations. Same defense pattern as `ok:shell:spawn-cursor`.
   */
  'ok:shell:show-item-in-folder': { args: [path: string]; result: undefined };
  /**
   * Append a local-only telemetry line to `~/.ok/stats.jsonl`.
   * Zero phone-home. Resolves on success; resolves (without throwing) when
   * HOME is unwritable so the dispatch path is never affected by telemetry
   * failure.
   *
   * Channel name is `ok:shell:record-handoff` (not `ok:handoff:record`) so it
   * matches the `ok:<surface>:<verb>` convention that maps 1:1 to the
   * `shell.recordHandoff` bridge location. Grep-based channel-to-handler
   * navigation stays within one namespace (`ok:shell:*`).
   */
  'ok:shell:record-handoff': { args: [line: HandoffStatsLine]; result: undefined };
  /**
   * Open an asset file via the OS default handler. Renderer sends a
   * project-relative path; main-process `openAssetSafely` handler resolves
   * against `ProjectContext.projectPath + realpath + isPathWithinProject`,
   * enforces the `EXECUTABLE_BLOCKLIST_EXTENSIONS` gate, and dispatches to
   * `shell.openPath(canonical)`. Reason union matches the bridge-contract
   * `openAsset` return type.
   */
  'ok:shell:open-asset': {
    args: [relPath: string];
    result:
      | { ok: true }
      | { ok: false; reason: 'extension-blocked' | 'path-escape' | 'not-found' | 'resolve-error' };
  };
  /**
   * Reveal an asset in the native file manager (macOS Finder / Windows
   * Explorer / Linux default) via `shell.showItemInFolder`. Parent-only,
   * does NOT invoke OS content handler — so the executable blocklist does
   * NOT apply. Same containment checks as `open-asset`.
   */
  'ok:shell:reveal-asset': {
    args: [relPath: string];
    result: { ok: true } | { ok: false; reason: 'path-escape' | 'not-found' | 'resolve-error' };
  };
  /**
   * Pop the native right-click context menu for an on-disk reference
   * (`asset`, `wiki-link`, or `image`). Main builds the menu via
   * `Menu.buildFromTemplate` and calls `.popup(window)`. Gesture-attested:
   * main observes the click directly, no IPC gesture forwarding needed.
   * Resolves after the menu closes regardless of which entry was selected.
   */
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
  /**
   * Move a file or folder to the OS Trash via Electron's `shell.trashItem`.
   * Used by the sidebar Delete flow's two-step orchestration: step 1
   * trashes the item; step 2 (`POST /api/trash/cleanup`) runs the
   * server-side cleanup. The renderer closes the editor tab AFTER step 1
   * succeeds, eliminating the fail-forward UX hazard the prior design had.
   *
   * Argument is an ABSOLUTE path (renderer composes via
   * `joinWorkspacePath`). Main-side handler runs `realpathSync` and
   * `isPathWithinProject` against the caller window's `projectPath` before
   * dispatching — same defense pattern as `ok:shell:show-item-in-folder`
   * and `ok:shell:spawn-cursor`. Reason union covers macOS edge cases:
   * locked files / permission denied (`permission-denied`), missing target
   * (`not-found`), backend failures including OneDrive (`electron#38541`)
   * and tmpfs (`electron#28045`) (`system-error`), containment violation
   * (`path-escape`). `detail` carries the OS-provided
   * `error.localizedDescription` when present so the trash-failure fallback
   * modal (`TrashFailureModal`) can surface it verbatim.
   *
   * NOT a `shell.openPath` site — the `openAssetSafely` STOP rule does
   * NOT apply.
   */
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
  /** Clipboard text write (IPC-relay — renderer is sandboxed). */
  'ok:clipboard:write-text': { args: [text: string]; result: undefined };
  /** Read the current window's config (projectPath, collabUrl, etc.). */
  'ok:project:get-info': { args: []; result: OkDesktopConfig };

  /**
   * Single-channel discriminated surface
   * for both the read (`status`) and write (`set-mode`) operations. Folded
   * into one channel to stay under the hand-rolled-channel scale-match
   * cap; the discriminated args/result keeps the per-operation typing
   * crisp at the call sites (preload + handler). Internally main dispatches
   * on `request.kind`. The renderer's `bridge.sharing.{status,setMode}`
   * surface keeps the ergonomic split.
   */
  'ok:sharing:dispatch': {
    args: [request: { kind: 'status' } | { kind: 'set-mode'; mode: 'shared' | 'local-only' }];
    result: OkSharingResult;
  };
  /** Read the LRU-capped recent-projects list from app state. */
  'ok:project:list-recent': { args: []; result: RecentProject[] };
  /** Remove one project from the persisted recent-projects list. Does not delete files. */
  'ok:project:remove-recent': { args: [projectPath: string]; result: undefined };
  /** Read the persisted editor tab session for the current project window. */
  'ok:project:get-session-state': { args: []; result: ProjectSessionState };
  /** Persist the editor tab session for the current project window. */
  'ok:project:set-session-state': { args: [state: ProjectSessionState]; result: undefined };
  /** Request main to open a project (always spawns a new editor window). */
  'ok:project:open': { args: [request: ProjectOpenRequest]; result: undefined };
  /**
   * Probe `<projectPath>/<path>` and classify it against the share target's
   * `kind` — a regular-file hit for `doc`, a directory hit for `folder` —
   * else `ENOENT`/wrong-type miss, or graceful-fail (every other I/O error).
   * Used by the main-side target-existence gate AFTER the branch-name check
   * passes — answers "does the share's target actually exist on the
   * receiver's locally checked-out branch?" Without this gate, a stale-branch
   * receiver (target exists on remote branch, not yet fetched locally)
   * silently opens a blank editor. Content-root folder shares (empty path)
   * skip this probe at the call site.
   *
   * Q1 runs pre-server; this is the only filesystem read available at
   * that point. Never throws; every failure mode collapses to
   * `'unreadable'` so the caller can fall back to silent dispatch the
   * same way the head-branch reader does.
   */
  'ok:project:check-target-exists': {
    args: [request: { projectPath: string; kind: 'doc' | 'folder'; path: string }];
    result: CheckTargetExistsResult;
  };
  /**
   * Read `<projectPath>/.git/HEAD` and classify the result. Pure filesystem
   * read; never throws. Returns the all-null sentinel on every failure mode
   * (missing `.git`, malformed HEAD, traversal attempt, I/O error). Used by
   * the Project Navigator's recent-projects list to render the per-project
   * branch label without booting the server.
   */
  'ok:project:read-head-branch': {
    args: [projectPath: string];
    result: HeadBranchInfo;
  };
  /**
   * Proxy `GET /api/git/branch-info?branch=<targetBranch>&path=<docPath>`
   * against the project's running server. Used by the share-receive branch-
   * switch dialog from the dispatcher window (Navigator) — the dispatcher
   * has no apiOrigin of its own, so main resolves the project's server-lock
   * port and HTTP-fetches on its behalf. Returns `null` when the server
   * lock can't be read, the lock points at a non-live port, the response
   * doesn't validate, or the request fails — the dialog falls back to a
   * "Loading…" timeout / error state. Never throws.
   */
  'ok:project:fetch-branch-info': {
    args: [request: { projectPath: string; branch: string; kind: 'doc' | 'folder'; path: string }];
    result: BranchInfoResponse | null;
  };
  /**
   * Proxy `POST /api/git/checkout` against the project's running server.
   * Mirrors `fetch-branch-info` — the dispatcher window asks main to make
   * the HTTP call because it doesn't own the project's apiOrigin. Returns
   * `null` when the server lock can't be resolved or the response can't
   * be parsed; the dialog treats this as a generic checkout-failed and
   * stays open. Server-classified failures (`dirty-conflict`,
   * `branch-not-found`, `fetch-failed`, `checkout-failed`) are returned
   * verbatim so the dialog can map each to its own toast copy. `fastForward`
   * (on-origin "Switch and update branch") asks the server to fast-forward the
   * target branch to origin's tip before checkout; divergence returns the
   * verbatim `ff-diverged` reason so the dialog can offer a plain switch.
   */
  'ok:project:run-checkout': {
    args: [request: { projectPath: string; branch: string; fastForward?: boolean }];
    result: CheckoutResponse | null;
  };
  /**
   * Proxy `POST /api/share/target-status` against the project's running server
   * for the branch-switch dialog's verdict pivot. When `fetch-branch-info`'s
   * origin-existence hint is `false`, the dialog asks main to run the
   * fetch-backed verdict (on-origin / renamed / deleted / never-on-branch /
   * unknown) instead of treating the stale hint as a terminal denial. Returns
   * `null` on transport failure (the dialog treats it as `unknown`); a 200 with
   * an unexpected body degrades to `{verdict:'unknown'}` via the schema's
   * value-tolerant parse. Never throws.
   */
  'ok:project:fetch-target-status': {
    args: [request: { projectPath: string; branch: string; path: string; kind: 'doc' | 'folder' }];
    result: ShareTargetStatusResponse | null;
  };
  /**
   * Poll the project's `GET /api/server-info` until `currentBranch` matches
   * `branch` (or the dispatcher's timeout elapses). The dispatcher dialog
   * uses this to gate dialog dismissal on the CC1 `branch-switched` broadcast
   * landing in the project window — server-info is the late-join backstop
   * for that broadcast, so polling it from main yields the same "recycle
   * complete" signal without bridging cross-window CC1 traffic.
   *
   * STOP rule (one-way door): the dialog's Switch handler MUST NOT
   * navigate on the `runCheckout` HTTP 200. CC1 broadcast (equivalently,
   * a matching server-info poll) is the completion signal — this channel
   * is the gate.
   *
   * Discriminated result: `{ok: true}` on match, `{ok: false, reason}`
   * on timeout or project-not-open (server lock never resolved). Never
   * throws.
   */
  'ok:project:await-branch-switched': {
    args: [request: { projectPath: string; branch: string; timeoutMs: number }];
    result: { ok: true } | { ok: false; reason: 'timeout' | 'project-not-open' };
  };
  /**
   * Run the share-receive scaffold from main process — initialize
   * `.ok/config.yml` (+ `.gitignore` + `.okignore`) inside a freshly-
   * picked CLI-managed git worktree so the share-receive consent flow
   * can opt the user into opening a worktree that was never opened in
   * OK before.
   *
   * Why this exists as an IPC channel separate from the HTTP route
   * `POST /api/local-op/ok-init`: the consent dialog runs in the
   * Navigator window before any project utility process exists for the
   * candidate path. The Navigator's `OkDesktopConfig.apiOrigin === ''`
   * — `installClientFetchWrapper` performs no rewrite, and a relative
   * `fetch('/api/local-op/ok-init')` stays relative, resolving against the
   * Navigator's own origin (file://). Sibling Navigator flows (`localOp.clone`,
   * `localOp.auth.*`) ship IPC transports for exactly this reason.
   *
   * Result shape mirrors the HTTP route's `LocalOpOkInitResponse`
   * discriminated union (`{ok: true, projectPath}` |
   * `{ok: false, reason, message}`) so renderer code paths are
   * interchangeable. Never throws — every failure mode is
   * discriminated. Idempotent on already-initialized projects.
   */
  'ok:project:ok-init': {
    args: [request: { projectPath: string }];
    result: LocalOpOkInitResponse;
  };
  /**
   * Worktree selector (worktree = window). One consolidated
   * discriminated channel — following the `ok:sharing:dispatch` precedent
   * rather than adding two net-new channels — for both operations on the
   * sender window's project:
   *   - `{ kind: 'list' }` → enumerate local branches + their worktrees, with
   *     the current window + main worktree flagged.
   *   - `{ kind: 'create', branch, createBranch, baseBranch? }` → create (or
   *     locate) the worktree for `branch` under `<mainRoot>/.ok/worktrees/`.
   *     Opening the worktree window reuses the existing `ok:project:open`
   *     path (entryPoint `'worktree'`) — this channel is git-only.
   * The renderer's `bridge.worktree.{list,create}` recovers per-operation
   * typing from the discriminated result.
   */
  'ok:worktree:dispatch': {
    args: [request: { kind: 'list' } | ({ kind: 'create' } & WorktreeCreateRequest)];
    result: WorktreeListResult | WorktreeCreateResult;
  };
  /** Request main to close the current project's window. */
  'ok:project:close': { args: []; result: undefined };
  /**
   * Restart the project's server to match this app's version: terminate the
   * attached (not-owned) server and recreate the window against a fresh
   * own-version spawn. Renderer-initiated from the version-drift notification.
   * Resolves `{ ok:false }` only when termination fails (the originating
   * window stays so the renderer can surface the failure); on success the
   * window is recreated and the originating renderer is gone, so its invoke
   * promise never resolves — callers must not block on it.
   */
  'ok:project:restart-server': { args: [projectPath: string]; result: OkServerRestartOutcome };
  /**
   * Validate a user-picked folder against an expected `{owner, repo}` from a
   * share URL. Delegates to `validateLocalFolderForShare` (CLI). Used by the
   * share-receive Q2 "I have it locally" affordance. Never throws
   * on filesystem failures — every error maps to a discriminated kind.
   */
  'ok:share:validate-folder': {
    args: [request: ShareValidateFolderRequest];
    result: ShareValidateFolderResult;
  };
  /**
   * Scaffold a new project at `<parent>/<name>` with the user-chosen `editors`
   * set. Main re-runs the renderer-side cascade defensively, then performs
   * the mkdir + git-init + content-init + AI-integration writes atomically.
   * Resolves only on success; failure surfaces as an IPC rejection.
   */
  'ok:project:create-new': {
    args: [
      args: {
        parent: string;
        name: string;
        editors: readonly McpWiringEditorId[];
        /** Defaults to 'shared' when omitted. */
        sharing?: 'shared' | 'local-only';
        /**
         * Starter pack to seed into the newly-created project (first-run
         * packs-forward launcher). Omitted → blank project (today's behavior).
         */
        packId?: PackId;
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
  /**
   * Fire-and-forget renderer→main telemetry signal. Fired once per Create-
   * new-project dialog open the first time each banner variant is shown.
   * Bounded-cardinality: the `banner` arg is a closed literal union and the
   * handler maps it to a discrete OnboardingFlow counter event. Main never
   * returns anything beyond ack. Renderer dedupes per-dialog-open so a
   * user clearing + re-typing the same input doesn't double-count.
   */
  'ok:project:record-create-new-banner-shown': {
    args: [banner: CreateNewBannerKind];
    result: undefined;
  };
  /**
   * Re-summon the Project Navigator window from inside an editor window.
   * Calls main's `openNavigator()` (focus existing or create new) — same
   * function the File menu's "Switch Project…" item invokes. Lifecycle is
   * focus-or-create only (no toggle). Renderer surfaces: `ProjectSwitcher`
   * dropdown, `CommandPalette`. No payload, no return — IPC-ack only.
   */
  'ok:navigator:open': { args: []; result: undefined };
  /**
   * Toast A "Relaunch now" action: renderer invokes this after the user
   * clicks the sonner action button. Main handler calls
   * `autoUpdater.quitAndInstall()` which triggers Squirrel.Mac's ZIP swap
   * and relaunches on the new version.
   */
  'ok:update:relaunch-now': { args: []; result: undefined };
  /**
   * Application-menu "Check for Updates…" entries (App menu on macOS,
   * Help menu cross-platform). Main fires
   * `autoUpdater.checkForUpdates()` out-of-cadence — the user-facing
   * result is delivered through the existing toast UX driven by
   * `update-available` / `update-not-available` listeners, so this
   * IPC returns void.
   */
  'ok:update:check-now': { args: []; result: undefined };
  /**
   * Renderer → main when the release-notes (what's-new) notice is dismissed in
   * one window — by the X button or its 60s auto-expiry. Main re-broadcasts
   * `ok:update:whats-new-dismissed` to every window so the same FYI clears
   * everywhere, and clears the transient `activeWhatsNew` so a window opened
   * afterwards no longer receives it. Fire-and-forget; idempotent across windows.
   */
  'ok:update:whats-new-dismiss': { args: [{ version: string }]; result: undefined };
  /**
   * Renderer-on-mount query for the build-derived update channel + any
   * pending schema-incompatibility diagnostic. Newly-opened windows use this
   * to render the BETA badge / About-panel label, and to route the refuse-
   * downgrade UX when a future-build state was rolled back. The channel is
   * `channelFromVersion(app.getVersion())` — a property of the binary, never
   * a runtime preference. The diagnostic is null when the persisted
   * `schemaVersion` is within `MAX_SUPPORTED`.
   */
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
  /**
   * Renderer-side "Reset and Continue" affordance on the schema-
   * incompatibility refuse-downgrade notice. Wipes the AppState file back to
   * defaults (`schemaVersion` to the current build's max, recent-projects
   * list cleared), then clears the pending diagnostic so newly-opened windows
   * that re-query don't re-surface the same warning. Destructive — caller is
   * responsible for confirming intent.
   */
  'ok:state:reset-incompatible': { args: []; result: undefined };
  /**
   * Push the user's chosen `nativeTheme.themeSource` from renderer
   * `ConfigProvider` to main, where main applies it via the Electron API
   * (vibrancy auto-tracks; the handler does NOT fan out
   * `setBackgroundColor` — under `transparent: true` the call is a no-op
   * and would only invite drift). Value is user-intent
   * (`'system' | 'light' | 'dark'`) — `'system'` IS the lever delegating
   * to macOS appearance, so resolving at the call site loses OS
   * auto-tracking. Lint enforcement of the user-intent contract lives
   * in `tests/integration/no-resolved-value-theme-source.test.ts`.
   *
   * Failure model is best-effort: handler rejection is structured-warned
   * by the renderer effect and recovers naturally on the next CRDT
   * mutation; body theme stays correct via next-themes regardless. No
   * `state.json` write — themeSource is NOT cached; cold-launch
   * correctness lives in the `ok:theme:applied` show-gate below.
   */
  'ok:theme:set-source': { args: [params: { source: OkThemeSource }]; result: { ok: true } };
  /**
   * Renderer→main fire-and-forget signal. The renderer fires this once
   * after ConfigProvider's first sync settles, and again on every
   * `prefers-reduced-transparency` matchMedia change. The window-show
   * gate in `WindowManager` / `NavigatorWindow` listens for the FIRST
   * fire — correlated by `event.sender === window.webContents` —
   * alongside `ready-to-show` and releases `BrowserWindow.show()` once
   * BOTH have arrived (5 s safety timeout otherwise). Subsequent fires
   * are no-ops on the show-gate side (the window is already visible)
   * and only drive the vibrancy toggle described below. This eliminates
   * the cold-launch staleness window where OS-drawn chrome would briefly
   * mismatch the renderer body.
   *
   * Modeled as a request channel (not an `EventChannels` entry) so it
   * composes through the typed `createInvoker` wrapper — preload calls
   * `invoke('ok:theme:applied', opts).catch(() => {})` mirroring the
   * `mcpWiring:renderer-ready` mount-ack precedent. Result is `undefined`;
   * caller discards it. Main registers via `ipcMain.handle` (multi-fire
   * for the matchMedia subscription); per-window cleanup is implicit —
   * the show-gate's destroyed-window guard short-circuits stale signals.
   *
   * Optional payload `{ reducedTransparency }` carries the renderer's live
   * `matchMedia('(prefers-reduced-transparency: reduce)').matches` value.
   * Folded into the same channel rather than introducing a separate
   * hand-rolled channel: the team's commitment to migrate to typed-ipc
   * fires before any further hand-rolled channel additions, and
   * `reducedTransparency` is observed on the same edges where
   * `signalThemeApplied` already fires (mount + on matchMedia change).
   * Main dispatches both signals — show-gate release on the first fire
   * and vibrancy toggle on every fire that carries the optional payload —
   * from the single handler.
   */
  'ok:theme:applied': {
    args: [opts?: { reducedTransparency?: boolean }];
    result: undefined;
  };
  /**
   * Renderer→main fire-and-forget startup-instrumentation signal. The renderer
   * reports its two launch checkpoints — page-list ready and first content — as
   * epoch-ms `Date.now()` values, exactly once per launch (once both have
   * landed). Main folds them into the single `desktop.startup-timeline`
   * waterfall log and, when OTel is enabled, the cross-process launch trace.
   *
   * Modeled as a request channel (not an `EventChannels` entry) so it composes
   * through `createInvoker`; preload calls
   * `invoke('ok:startup:renderer-marks', marks).catch(() => {})` mirroring the
   * `ok:theme:applied` fire-and-forget precedent. Result is `undefined`;
   * caller discards it. Idempotent on the renderer side — sent once.
   */
  'ok:startup:renderer-marks': {
    args: [marks: { pageListReadyMs: number; firstContentMs: number }];
    result: undefined;
  };
  /**
   * Debug-only keyring smoke — relays into the window's utility process and
   * round-trips setPassword/getPassword/deletePassword against a namespace-
   * scoped keychain entry. Gated at runtime: disabled in packaged builds
   * unless `OK_DEBUG_KEYRING_SMOKE=1`. Renderer surface is populated only
   * when the same gate allows.
   */
  'ok:debug:keyring-smoke': { args: []; result: KeyringSmokeResult };
  /**
   * Compute a scaffold plan for the current window's project — read-only.
   * See `packages/desktop/src/main/ipc/seed.ts`. Renderer branches on `result.ok` then
   * renders the plan (unseeded) or "already seeded" (empty plan).
   *
   * Options accept `rootDir` and `packId`. Calling with no args plans the
   * default Knowledge base pack at project root (back-compat).
   */
  'ok:seed:plan': { args: [options?: SeedPlanOptions]; result: SeedPlanResult };
  /**
   * Apply a ScaffoldPlan (returned by `ok:seed:plan`) to disk. Writes folders, the
   * pack's optional root files, and per-folder `.ok/frontmatter.yml` +
   * `.ok/templates/<name>.md`. Returns an ApplyResult on success.
   */
  'ok:seed:apply': {
    args: [plan: ScaffoldPlan, options?: SeedApplyOptions];
    result: SeedApplyResult;
  };
  /**
   * Enumerate available starter packs. Static data — no project context
   * required. The picker UI fetches this once on dialog mount.
   */
  'ok:seed:list-packs': { args: []; result: SeedListPacksResult };
  /**
   * First-launch MCP consent — user clicked "Add" in `<McpConsentDialog>`.
   * Main calls `writeUserMcpConfigs` for every selected editor, writing the
   * canonical npx MCP entry, then applies the PATH decision (`pathInstall`
   * true → consent-granted rc-block append; false → recorded decline; absent
   * → untouched), and writes the user-scoped marker at
   * `<home>/.ok/mcp-status.json` IFF every write succeeds (deferred-marker
   * pattern). Per-editor failures emit `mcp-wiring-write-failed` structured
   * logs; a failed PATH leg emits `mcp-wiring-path-consent-failed` — either
   * leaves the marker absent so the dialog re-fires next launch. Existing
   * entries under the `open-knowledge` namespace are desktop-owned and
   * overwritten.
   */
  'ok:mcp-wiring:confirm': {
    args: [request: McpWiringConfirmRequest];
    result: McpWiringConfirmResult;
  };
  /**
   * First-launch MCP consent — user clicked "Skip" (or ESC). Main writes
   * `{configured: false, skippedAt}` to the user-scoped marker so the dialog
   * never re-fires. Re-triggering the consent flow requires manually deleting
   * the marker file.
   */
  'ok:mcp-wiring:skip': { args: []; result: McpWiringSkipResult };
  /**
   * Mount-ack handshake. Every renderer (Navigator + editor) invokes this
   * once on React-app first mount. The FIRST invoke per boot tells main a
   * renderer is subscribed to `ok:mcp-wiring:show`; main responds by
   * dispatching the show event back to the invoking webContents and removes
   * the handler so subsequent mounts don't re-fire the dialog. Modeled as
   * invoke/result (not a one-way event) so it composes through the typed
   * `createHandler` / `createInvoker` wrappers. Result is `undefined` —
   * the renderer discards it.
   */
  'ok:mcp-wiring:renderer-ready': { args: []; result: undefined };

  /**
   * Settings → AI tools. One consolidated discriminated channel — following
   * the `ok:worktree:dispatch` precedent rather than adding two net-new
   * channels — for both operations on OK's global footprint:
   *   - `{ kind: 'status' }` → full component inventory (per-editor MCP
   *     entries, the shell-PATH shim, user-global skill bundles). Read-only.
   *   - `{ kind: 'set', component, enabled }` → install or uninstall ONE
   *     component. Serialized in main (one in-flight mutation at a time) so
   *     two windows' toggles can't interleave partial writes on the same
   *     config file. Returns a fresh status snapshot on both arms.
   * The renderer's `bridge.integrations.{status,setComponent}` recovers
   * per-operation typing from the discriminated result.
   */
  'ok:integrations:dispatch': {
    args: [request: { kind: 'status' } | ({ kind: 'set' } & IntegrationsSetRequest)];
    result: IntegrationsStatus | IntegrationsSetResult;
  };

  /**
   * Settings → This project → AI tools. Project-scoped sibling of
   * `ok:integrations:dispatch`: same discriminated `status` read + one-component
   * `set`, but scoped to the project the SENDER window has open (main resolves
   * webContents → ProjectContext; the renderer never names a directory). Covers
   * the per-editor project MCP config files + the single project runtime skill.
   */
  'ok:project-integrations:dispatch': {
    args: [request: { kind: 'status' } | ({ kind: 'set' } & ProjectIntegrationsSetRequest)];
    result: ProjectIntegrationsStatus | ProjectIntegrationsSetResult;
  };

  /**
   * Per-project consent dialog. Renderer renders a shadcn Dialog inside the
   * Navigator after main fires `ok:onboarding:show`; calls
   * `confirm` / `cancel` on user action; calls `signalReady` once on app
   * mount so main knows a renderer is subscribed (mirrors the mount-ack
   * handshake). Available only in the Navigator window — the editor
   * renderer never receives `ok:onboarding:show`.
   */
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

  /**
   * Returns true when Claude Desktop's config directory exists on this
   * machine (macOS ~/Library/Application Support/Claude/ or Windows
   * %APPDATA%/Claude/). Reuses the shared `detectClaudeDesktopPresence`
   * helper so the init hint (CLI) and the install dialog (Electron) gate
   * on the same signal. False on Linux (unsupported upstream).
   */
  'ok:skill:detect-claude-desktop': { args: []; result: boolean };

  /**
   * Build `openknowledge.skill` locally from the bundled SKILL.md source,
   * write it to the user's Downloads folder, then invoke `shell.openPath`
   * to route it to Claude Desktop via the `.skill` CFBundleDocumentType
   * association. Renderer treats any `ok: true` response as "Claude Desktop
   * has taken over — show 'Follow prompts in Claude' copy and wait."
   *
   * Local build (no network, no GitHub Releases dep) — version matches
   * whatever the user's installed Electron app bundles.
   */
  'ok:skill:build-and-open': { args: [opts?: { force?: boolean }]; result: BuildAndOpenResult };

  /**
   * Pre-project local-op flows for the Navigator window (which has no
   * backing API server). The HTTP path at /api/local-op/auth/login +
   * /api/local-op/clone is unreachable from Navigator (`apiOrigin` is
   * empty), so these IPC channels spawn the same CLI subprocess directly
   * from the main process and stream events via `webContents.send`.
   *
   * Editor windows continue using the HTTP path — no regression. See
   * `packages/server/src/local-ops/` for the shared subprocess runners.
   *
   * Lifetime: `start` returns a `streamId` that subsequent `:event` push
   * messages and the `:cancel` invoker reference. Main tracks one in-flight
   * flow per channel; concurrent starts return `error: 'busy'`.
   */
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

  /**
   * One-shot auth queries — Navigator uses these in place of the HTTP
   * `/api/local-op/auth/{status,repos}` endpoints. Bounded responses
   * (status: one line; repos: bounded list) so no streaming surface
   * needed.
   */
  'ok:local-op:auth:status': {
    args: [request?: { host?: string }];
    result: OkLocalOpAuthStatusResponse;
  };
  'ok:local-op:auth:repos': {
    args: [request?: { host?: string }];
    result: OkLocalOpAuthReposResponse;
  };

  /**
   * Renderer → main fire-and-forget push of the editor area's active target.
   * Main listens to rebuild the File menu (state-aware item enable/disable)
   * via the same rebuild pattern `recent-projects` change uses
   * (`menu.ts`). Fires once per `activeTarget` transition in
   * `useDocumentContext()`. Modeled as a request channel (not an
   * `EventChannels` entry) so it composes through the typed `createInvoker`
   * wrapper — same pattern as `ok:theme:applied` / `ok:mcp-wiring:renderer-ready`.
   * Result is `undefined`; the bridge method swallows rejections (a missing
   * handler during window teardown is expected, not a programmer error).
   */
  'ok:editor:active-target-changed': {
    args: [target: EditorActiveTargetSnapshot];
    result: undefined;
  };
  /**
   * Renderer → main fire-and-forget push of the sidebar's view-menu state.
   * Main rebuilds the application menu so the View menu's check items
   * reflect the merged-config visibility flags and Expand All / Collapse All
   * smart-hide via `visible: false` when the tree state makes them no-ops.
   * Sibling of `ok:editor:active-target-changed` — modeled as a request
   * channel so the preload `invoke().catch(()=>{})` pattern composes through
   * the typed `createInvoker` wrapper.
   */
  'ok:editor:view-menu-state-changed': {
    args: [state: Partial<EditorViewMenuStateSnapshot>];
    result: undefined;
  };

  /**
   * Docked-terminal PTY surface (`ok:pty:*`). The renderer creates one PTY
   * per window; main mediates to a window-bound utilityProcess hosting
   * node-pty. STOP: this is the ONLY sanctioned arbitrary-exec IPC framing —
   * never add a generic exec channel outside `ok:pty:*`.
   *
   * `create` resolves with the new ptyId (or `no-project` when the window has
   * no resolved project root). `input` / `resize` / `kill` / `drain` are
   * fire-and-forget invokes keyed by ptyId; main drops a mismatched ptyId so
   * a stale renderer can't drive a successor PTY. `drain` is the renderer's
   * backpressure ack (consumed byte count) so main can resume a paused PTY.
   * Streaming output + exit are `EventChannels` pushes (`ok:pty:data` /
   * `ok:pty:exit`).
   */
  'ok:pty:create': {
    args: [opts: { cols: number; rows: number; launchCommand?: string }];
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
  /**
   * Reload-rehydration inventory: the live ptyIds for the sender's window. A
   * renderer reload tears down the page but not the window-bound PTY host, so a
   * reloaded dock queries this to rediscover the shells that survived in main
   * (windowId derived from the sender, like the other `ok:pty:*` channels).
   * Empty for a window with no host.
   */
  'ok:pty:list': {
    args: [];
    result: OkPtyListEntry[];
  };
  /**
   * Reload-rehydration adopt: re-bind a surviving session to the reloaded
   * renderer (refresh its delivery target, clear the stale backpressure the dead
   * page left, resume the host). Refuses a ptyId no longer live for the window
   * (`unknown-session`) so the panel falls through to a fresh `create` rather
   * than wiring to a dead shell.
   */
  'ok:pty:adopt': {
    args: [req: { ptyId: string }];
    result: OkPtyAdoptResult;
  };
  /**
   * Persist per-session tab metadata (custom name + sticky ordinal) in main so it
   * survives a renderer reload (the PTY host outlives the page; `ok:pty:list`
   * reads it back). Fire-and-forget; a field omitted is left unchanged.
   */
  'ok:pty:set-meta': {
    args: [req: { ptyId: string; customLabel?: string | null; ordinal?: number }];
    result: undefined;
  };
  /**
   * Persist the tab display order in main (ptyIds in visual order) so a drag /
   * keyboard reorder survives a renderer reload. Fire-and-forget.
   */
  'ok:pty:set-order': {
    args: [req: { orderedPtyIds: string[] }];
    result: undefined;
  };
  /**
   * Docked-terminal Claude Code readiness + re-arm. One discriminated
   * channel folds the `preflight` read (is `claude` on PATH, is the
   * `open-knowledge` MCP server wired into `~/.claude.json`) and the `rewire`
   * action (show the MCP consent dialog) — the `ok:sharing:dispatch`
   * single-channel precedent, +1 rather than +2. NOT an exec channel: the
   * renderer supplies only the action discriminant; main runs a fixed
   * `command -v claude` probe and arms the existing consent flow.
   */
  'ok:terminal:claude-assist': {
    args: [req: { action: 'preflight' | 'rewire' }];
    result: ClaudeReadiness;
  };
  /**
   * Docked-terminal on-PATH readiness for a non-Claude agent CLI (codex /
   * cursor). NOT an exec channel: the renderer supplies only the CLI
   * discriminant; main runs a fixed `command -v <bin>` probe for the registry
   * binary. Separate from `claude-assist` because Claude additionally folds the
   * MCP-wiring read + rewire action that these CLIs have no analog for.
   */
  'ok:terminal:cli-preflight': {
    args: [req: { cli: TerminalCli }];
    result: CliReadiness;
  };
  /**
   * Batched docked-terminal on-PATH readiness for all launchable CLIs → a plain
   * installed map (`true` ⇒ the CLI's registry binary resolves on the login-shell
   * PATH). Drives the New-chat default-CLI auto-pick. NOT an exec channel: no
   * renderer input; main runs a fixed `command -v <bin>` per registry binary and
   * caches the batch (~60s).
   */
  'ok:terminal:cli-installed-map': {
    args: [];
    result: Record<TerminalCli, boolean>;
  };
  /**
   * Per-window docked-terminal visibility, recorded from the renderer's
   * view-menu push. A reloaded renderer reads it to restore an expanded dock —
   * visibility recovers by the same mechanism and lifetime as the sessions it
   * gates (windowId-keyed; gone after window-close / app-quit, so a fresh launch
   * with no surviving sessions restores nothing).
   */
  'ok:terminal:dock-state': {
    args: [];
    result: { visible: boolean };
  };
}
