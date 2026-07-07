/**
 * Local copy of the OkDesktopBridge contract types — see comment in
 * `packages/core/src/desktop-bridge.ts` and `packages/desktop/src/shared/
 * bridge-contract.ts` for why the contract is duplicated rather than
 * exported through core's barrel.
 *
 * This file's purpose is twofold:
 *   1. Type the optional `window.okDesktop` global so `useCollabUrl` and any
 *      future Electron-aware app code can read it with full type safety.
 *   2. Stay in sync with the desktop preload's contract — drift across the
 *      three copies is caught by the bridge-contract drift test (top-level
 *      `OkDesktopBridge` member parity + `KeyringSmokeResult` /
 *      `OkKeyringSmokeResult` field shape).
 *
 * Web / CLI distribution: `window.okDesktop` is `undefined` and the optional
 * chaining + `if (window.okDesktop?.config.collabUrl)` guards in `useCollabUrl`
 * fall through to the existing /api/config poll path.
 */
import type {
  BranchInfoResponse,
  CheckoutResponse,
  CreateNewBannerKind,
  EditorId,
  LocalOpOkInitResponse,
  OkFolderState,
  RecentProjectEntry,
  ShareTargetStatusResponse,
  TerminalCli,
  WorktreeCreateRequest,
  WorktreeCreateResult,
  WorktreeListResult,
} from '@inkeep/open-knowledge-core';

export type { OkFolderState, RecentProjectEntry };

/** Seed scaffolder shapes — structurally duplicated from
 * `@inkeep/open-knowledge-server`'s seed module. See core's desktop-bridge.ts
 * for rationale (avoids pulling server into the app compilation tree).
 *
 * Folder defaults moved out of `config.yml` `folders:` and into nested
 * `<folder>/.ok/frontmatter.yml` files written via the standard file-entry
 * path. */
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
  /** Editor display-names that received the pack's project skill (e.g. "Claude Code"). */
  packSkillsInstalled: string[];
}
export interface OkSeedError {
  kind: 'no-project' | 'prerequisite-missing' | 'invalid-root' | 'internal';
  message: string;
}

/** Pack-id wire shape — accepted strings; coerced server-side via `coercePackId`. */
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

type OkDesktopMode = 'editor' | 'navigator' | 'terminal';

export interface OkDesktopConfig {
  readonly collabUrl: string;
  readonly apiOrigin: string;
  readonly projectPath: string;
  readonly projectName: string;
  readonly mode: OkDesktopMode;
  /**
   * `true` only under the Electron smoke suite. The renderer reads it to use
   * xterm's DOM renderer instead of the WebGL canvas (see `TerminalPanel`).
   * Lockstep with the desktop-side `OkDesktopConfig`.
   */
  readonly e2eSmoke: boolean;
  /**
   * `true` on an ephemeral single-file window (`ok <file>`). The renderer's
   * no-project chrome gate drops the sidebar / tabs / project switcher / Settings
   * while keeping the editor editable. The desktop loads from `file://`, so this
   * rides the bridge config (the browser fallback reads the same signal from
   * `/api/config`). Absent flag → `false` on every project window.
   */
  readonly singleFile: boolean;
  /**
   * Doc to open on first paint, or `null`. Set only on an ephemeral single-file
   * window (`ok <file>`): the ext-less docName the renderer seeds into
   * `window.location.hash` before React mounts (`seedInitialDocHash`), so the
   * editor lands on the file deterministically instead of depending on the
   * post-load `ok:deep-link` IPC (which raced the lazy subscriber and dropped,
   * leaving the empty-state splash). `null` on every project window — those
   * navigate via the hash / deep-link channels. Lockstep with the desktop-side
   * `OkDesktopConfig` (`packages/desktop/src/shared/bridge-contract.ts`).
   */
  readonly initialDoc: string | null;
  /**
   * W3C `traceparent` of the Electron main process's `ok.app-startup` root
   * span, or `undefined` when OTel is disabled in main. The renderer extracts
   * it to parent its startup span to the desktop launch trace. Carried
   * on the bridge config (set from the `--ok-startup-traceparent=` arg). Not on
   * the core mirror — see `OkDesktopConfig` there.
   */
  readonly startupTraceparent?: string;
}

type OkMenuAction =
  | 'new-doc'
  | 'new-folder'
  // Opens the create-new-project dialog in the focused window (a whole new
  // project, distinct from new-doc/new-folder which create inside the current
  // project). Sibling of Switch Project, which dispatches via `openNavigator`.
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
  // File menu state-aware items. See bridge-contract.ts for
  // rationale; mirrored here per the OkDesktopBridge 3-way-mirror invariant.
  | 'new-from-template'
  | 'duplicate'
  | 'move-to-trash'
  | 'reveal-in-finder'
  | 'send-to-ai'
  | 'copy-full-path'
  | 'copy-relative-path'
  // View menu items — visibility toggles + tree-scoped expand/collapse.
  | 'toggle-show-hidden-files'
  | 'expand-all-tree'
  | 'collapse-all-tree'
  | 'toggle-doc-panel'
  | 'toggle-terminal'
  // Terminal application menu. `new-terminal` opens a new terminal tab
  // (revealing the dock if hidden; never hides, unlike the toggle).
  // `kill-terminal` closes the active tab, killing that session's PTY.
  | 'new-terminal'
  | 'kill-terminal'
  // Worktree selector (worktree = window). `new-worktree` opens the
  // create dialog; `switch-worktree` opens the sidebar worktree switcher.
  | 'new-worktree'
  | 'switch-worktree';

type OkUnsubscribe = () => void;

/**
 * Discriminator for the Navigator-side surface that initiated a project-open.
 * Mirrors `EntryPoint` in `packages/desktop/src/shared/entry-point.ts`. Drift
 * across the three bridge-contract copies is caught by the bridge-contract drift test.
 */
export type OkProjectEntryPoint =
  | 'create-new'
  | 'create-new-nested-redirect'
  | 'pick-existing'
  | 'recents'
  | 'deep-link'
  | 'drag-drop'
  | 'share-receive'
  | 'worktree';

interface ProjectSessionState {
  openTabs: string[];
  pinnedTabIds: string[];
  activeDocName: string | null;
  activeTabId: string | null;
  updatedAt: string | null;
}

/**
 * Outcome of `bridge.project.checkTargetExists({projectPath, kind, path})`.
 * See canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
 */
export type CheckTargetExistsResult = 'exists' | 'missing' | 'unreadable';

/**
 * Kind-discriminated receiver target carried by `OkSharePayloadFields`. See
 * canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
 */
export type ShareTarget =
  | { readonly kind: 'doc'; readonly docPath: string }
  | { readonly kind: 'folder'; readonly folderPath: string };

/**
 * Collapse a kind-discriminated `ShareTarget` to its bare repo-relative path.
 * A `doc` target carries the file path on `docPath`; a `folder` target carries
 * the directory path on `folderPath` (empty string for the content-dir root).
 */
export function shareTargetPath(target: ShareTarget): string {
  return target.kind === 'doc' ? target.docPath : target.folderPath;
}

/**
 * Outcome of `bridge.project.readHeadBranch(projectPath)`. See canonical
 * JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
 */
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
  /**
   * Manual-download fallback URL, present only on the boot-detected
   * failed-install variant. When set, the renderer shows the richer
   * "Retry / Download manually" card instead of the plain relaunch-error notice.
   */
  readonly downloadUrl?: string;
}

interface OkWhatsNewInfo {
  readonly version: string;
  readonly releaseUrl: string;
}

interface OkUpdateStuckHintInfo {
  readonly downloadUrl: string;
}

/**
 * Renderer-facing payload for `ok:share:received`. Carried by the main-
 * process share-flow handler after `parseShareUrl` dispatches on the
 * universal-link / custom-scheme input shapes. Main resolves the share
 * target and dispatches one of the surface-specific variants below.
 * Mirrored across the three bridge-contract copies (desktop, core, app)
 * so the bridge-contract drift tests catch divergent copies.
 *
 *   - `kind: 'project-branch-switch'` — editor-shell branch-switch surface
 *   - `kind: 'launcher-consent'` / `launcher-miss` — Navigator surfaces
 *   - `kind: 'unsupported-version'` — sonner toast "Update OpenKnowledge"
 *   - `kind: 'invalid'` — sonner toast "Invalid share URL"
 */
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
      /**
       * Name of the Recents project whose `listGitWorktrees` anchor surfaced
       * `candidatePath`, when the candidate came from worktree-enum off an
       * existing OK project. `null` when the candidate was surfaced from
       * a Recents path that itself matched the share. Drives the
       * "(a worktree of <name>)" caption in the Navigator consent dialog.
       */
      readonly parentProjectName: string | null;
    }
  | {
      readonly kind: 'launcher-miss';
      readonly share: OkSharePayloadFields;
    };

/**
 * Renderer-facing mirror of `ShareFolderValidationResult` from
 * `@inkeep/open-knowledge`'s `validateLocalFolderForShare`. Carried
 * by the `share.validateLocalFolder` IPC. Mirrored across the three bridge-
 * contract copies (desktop, core, app) so the bridge-contract drift tests catch divergent copies.
 */
export type ShareFolderValidationResult =
  | { readonly kind: 'ok'; readonly gitRemoteUrl: string }
  | { readonly kind: 'not-git' }
  | { readonly kind: 'no-origin' }
  | { readonly kind: 'wrong-repo'; readonly actualOwner: string; readonly actualRepo: string }
  | { readonly kind: 'non-github' }
  | { readonly kind: 'symlink-escape' };

/**
 * Auto-update channel — derived in desktop's main from the running build's
 * version string. `'beta'` for a prerelease build, `'latest'` for a stable
 * one. Not a runtime preference; surfaced read-only via `state.query()`.
 * Mirrors `UpdateChannel` in desktop's `state-store.ts`.
 */
type OkUpdateChannel = 'latest' | 'beta';

/**
 * User-intent theme value. Mirrors Electron's `nativeTheme.themeSource`
 * union and the canonical desktop / core copies. Carried verbatim through
 * the `ok:theme:set-source` IPC channel — never resolved at the renderer
 * call site. Renderer ConfigProvider passes the unresolved CRDT value
 * (`merged.appearance.theme`) directly. Lint enforcement:
 * `packages/desktop/tests/integration/no-resolved-value-theme-source.test.ts`.
 *
 * Not re-exported (matches the `OkUpdateChannel` precedent in this file) —
 * external consumers reach the type through the `OkDesktopBridge` interface
 * surface. If a future call site needs the bare type, lift the export then.
 */
type OkThemeSource = 'system' | 'light' | 'dark';

interface OkStateSnapshot {
  readonly channel: OkUpdateChannel;
  readonly schemaIncompatibility: {
    readonly currentBuild: string;
    readonly persistedSchemaVersion: number;
    readonly maxSupported: number;
  } | null;
}

/**
 * Editor IDs surfaced through the first-launch MCP consent bridge.
 * Aliased to the canonical `EditorId` from `@inkeep/open-knowledge-core` —
 * single source of truth. Local name preserved so renderer call sites keep
 * importing `OkMcpWiringEditorId` from this module.
 */
export type OkMcpWiringEditorId = EditorId;

/** Payload passed to `mcpWiring.onShow` subscribers. `willReplace: true`
 *  signals the editor has an existing OK-managed MCP entry (canonical npx,
 *  `-y` variant, or prior cliPath shape) that Add would overwrite.
 *  `pathInstall` drives the dialog's shell-PATH toggle row:
 *  `shellDetected: false` hides the row; `alreadyInstalled: true` renders
 *  it informational (block already on disk or consent already granted);
 *  `rcFilesToTouch` names the tildified shell files a grant would edit. */
export interface OkMcpWiringShowPayload {
  readonly detectedEditors: readonly {
    readonly id: OkMcpWiringEditorId;
    readonly label: string;
    readonly detected: boolean;
    readonly willReplace: boolean;
  }[];
  readonly pathInstall: {
    readonly shellDetected: boolean;
    readonly rcFilesToTouch: readonly string[];
    readonly alreadyInstalled: boolean;
  };
  /** Per-bundle opt-in rows for the two user-global skills. Empty ⇒ no skill
   *  decision solicited. `alreadyInstalled: true` renders the row pre-checked
   *  as an existing install the user can uncheck to remove. */
  readonly globalSkills: readonly {
    readonly id: string;
    readonly name: string;
    readonly alreadyInstalled: boolean;
  }[];
}

/** Confirm payload for `mcpWiring.confirm`. `pathInstall` is the PATH
 *  toggle, tri-state: `true` → append the managed rc block; `false` →
 *  record declined, touch nothing; absent → no PATH decision was solicited
 *  (row hidden or informational).
 *
 *  `skills` — bundle ids the user left checked. Present ⇒ a skill decision was
 *  solicited; every offered bundle not in the list is recorded declined. */
export interface OkMcpWiringConfirmRequest {
  readonly editorIds: readonly OkMcpWiringEditorId[];
  readonly pathInstall?: boolean;
  readonly skills?: readonly string[];
}

/** Result shape for `mcpWiring.confirm` / `skip`. */
export type OkMcpWiringResult = { ok: true } | { ok: false; error: string };

/**
 * Per-project consent dialog — renderer-facing payload + result shapes.
 * Mirrors `bridge-contract.ts` and `core/src/desktop-bridge.ts`. Drift
 * across the three copies is caught by the bridge-contract drift test.
 */
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
  /** OK config sharing mode — sharing posture chosen by the user. */
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

/**
 * Pre-project local-op event shapes — auth + clone flows surfaced to the
 * Navigator window via IPC because it has no backing API server. See
 * `packages/desktop/src/shared/bridge-contract.ts` for canonical JSDoc.
 */
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

export type OkLocalOpAuthSignoutResponse =
  | { ok: true }
  // `error` is the server's RFC 9457 title when present; it can be absent (e.g.
  // a non-JSON 502), so the UI supplies a localized fallback rather than the
  // transport baking in an English string.
  | { ok: false; error?: string };

/**
 * Renderer → main snapshot of the editor area's active target.
 * Discriminated-union shape so TypeScript narrows `identifier` per `kind`.
 * Drives the macOS File menu's state-aware enable/disable. See canonical
 * JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
 */
type OkEditorActiveTargetSnapshot =
  | { readonly kind: 'doc'; readonly identifier: string }
  | { readonly kind: 'folder'; readonly identifier: string }
  | { readonly kind: 'asset'; readonly identifier: string }
  | { readonly kind: null };

/**
 * Renderer → main snapshot of the View menu's checkbox + smart-hide state.
 * Sibling of `OkEditorActiveTargetSnapshot`. See canonical JSDoc in
 * `packages/desktop/src/shared/bridge-contract.ts`.
 */
interface OkEditorViewMenuStateSnapshot {
  readonly showHiddenFiles: boolean;
  readonly canExpandAll: boolean;
  readonly canCollapseAll: boolean;
  readonly sidebarVisible: boolean;
  readonly docPanelVisible?: boolean;
  readonly terminalVisible?: boolean;
  readonly terminalLive?: boolean;
}

/**
 * Result shape for `bridge.debug?.keyringSmoke()` — mirrors
 * `KeyringSmokeResult` in `packages/desktop/src/utility/keyring-smoke.ts`
 * and `OkKeyringSmokeResult` in `packages/core/src/desktop-bridge.ts`.
 * Duplicated across the three copies; drift is caught by the bridge-contract
 * drift test (field-set equality across all three files).
 */
interface OkKeyringSmokeResult {
  ok: boolean;
  backend?: 'keyring' | 'file';
  error?: string;
  durationMs?: number;
  timestamp: string;
}

/** OK config sharing mode — see bridge-contract.ts for the canonical types. */
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

/**
 * Payload for `onServerVersionDrift`. Canonical JSDoc in
 * `packages/desktop/src/shared/bridge-contract.ts`.
 */
export interface OkServerVersionDriftInfo {
  readonly relation: 'older' | 'newer';
  readonly dimension: 'protocol' | 'runtime';
  readonly serverRuntime: string;
  readonly appRuntime: string;
}

/** Result of `restartServer`. Canonical JSDoc in `bridge-contract.ts`. */
export type OkServerRestartOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'eperm' | 'other' };

/** Result of `terminal.create`. Canonical JSDoc in `bridge-contract.ts`; mirrored verbatim (drift-tested). */
export type OkPtyCreateResult =
  | { readonly ok: true; readonly ptyId: string }
  | { readonly ok: false; readonly reason: 'no-project' | 'not-consented' };

/** Entry of `terminal.list`. Canonical JSDoc in `bridge-contract.ts`; mirrored verbatim (drift-tested). */
export interface OkPtyListEntry {
  readonly ptyId: string;
}

/** Result of `terminal.adopt`. Canonical JSDoc in `bridge-contract.ts`; mirrored verbatim (drift-tested). */
export type OkPtyAdoptResult =
  | { readonly ok: true; readonly replay: string }
  | { readonly ok: false; readonly reason: 'unknown-session' };

/** Push payload for `ok:pty:data`. Canonical JSDoc in `bridge-contract.ts`. */
export interface OkPtyData {
  readonly ptyId: string;
  readonly data: string;
}

/** Push payload for `ok:pty:exit`. Canonical JSDoc in `bridge-contract.ts`. */
export interface OkPtyExit {
  readonly ptyId: string;
  readonly exitCode: number;
  readonly signal: number | null;
  readonly error?: string;
}

/**
 * Claude Code readiness for the docked terminal. Canonical definition in
 * `desktop/src/shared/bridge-contract.ts`; mirrored verbatim here (drift-tested).
 */
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
  /** Subscribe to `ok:update:relaunching` — another window's "Relaunch" click committed; swap this window's `update-downloaded` card to the button-less "Relaunching…" in-progress state so every window shows consistent feedback during teardown. */
  onUpdateRelaunching(cb: (info: OkUpdateRelaunchingInfo) => void): OkUnsubscribe;
  /** Subscribe to `ok:update:relaunch-failed` — a committed relaunch failed (async error event or no-quit watchdog); surface the relaunch-error notice. Main re-arms the banner separately via a re-broadcast `ok:update:downloaded`. */
  onUpdateRelaunchFailed(cb: (info: OkUpdateRelaunchFailedInfo) => void): OkUnsubscribe;
  onWhatsNew(cb: (info: OkWhatsNewInfo) => void): OkUnsubscribe;
  /** Subscribe to `ok:update:whats-new-dismissed` — another window dismissed the what's-new notice; clear this window's `whats-new-<version>` card. */
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
  /** Subscribe to `ok:server-version-drift`. Canonical JSDoc in `bridge-contract.ts`. */
  onServerVersionDrift(cb: (info: OkServerVersionDriftInfo) => void): OkUnsubscribe;
  /** Subscribe to `ok:server-restarted`. Canonical JSDoc in `bridge-contract.ts`. */
  onServerRestarted(cb: (info: { readonly appRuntime: string }) => void): OkUnsubscribe;
  /** Subscribe to `ok:server-reclaimed`. Canonical JSDoc in `bridge-contract.ts`. */
  onServerReclaimed(cb: (info: { readonly appRuntime: string }) => void): OkUnsubscribe;
  /** Restart the project's server to match this app's version. Canonical JSDoc in `bridge-contract.ts`. */
  restartServer(projectPath: string): Promise<OkServerRestartOutcome>;
  /**
   * Push the user's chosen `nativeTheme.themeSource` value to main. Carries
   * the user-intent value (`'system' | 'light' | 'dark'`) verbatim — never
   * resolved at the call site. Renderer ConfigProvider runs this on every
   * CRDT mutation of `appearance.theme`. See canonical JSDoc in
   * `packages/desktop/src/shared/bridge-contract.ts`.
   */
  setThemeSource(source: OkThemeSource): Promise<{ ok: true }>;
  /**
   * Fire-and-forget signal that the theme has been applied to chrome.
   * Main's per-window show-gate uses this to release `BrowserWindow.show()`
   * alongside `ready-to-show`. Optional `opts.reducedTransparency` carries
   * the renderer's `matchMedia('(prefers-reduced-transparency: reduce)')`
   * value — main toggles vibrancy material accordingly. See canonical
   * JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
   */
  signalThemeApplied(opts?: { reducedTransparency?: boolean }): void;
  dialog: {
    openFolder(opts?: { defaultPath?: string }): Promise<string | null>;
  };
  shell: {
    openExternal(url: string): Promise<void>;
    /**
     * Scheme format contract: `scheme` is the scheme NAME without trailing
     * colon (e.g. `'claude'`, not `'claude:'`). Matches the main-process
     * shell-injection sanitizer and the Linux `xdg-mime` shell-command form
     * — callers with a colonful scheme MUST strip the trailing `:` first.
     * See `packages/desktop/src/shared/bridge-contract.ts` for canonical JSDoc.
     */
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

    /**
     * Open an asset via the OS default handler. See canonical JSDoc in
     * `packages/desktop/src/shared/bridge-contract.ts`. Asset-click-dispatcher
     * surface.
     */
    openAsset(
      relPath: string,
    ): Promise<
      | { ok: true }
      | { ok: false; reason: 'extension-blocked' | 'path-escape' | 'not-found' | 'resolve-error' }
    >;

    /**
     * Reveal an asset in the native file manager. See canonical JSDoc in
     * `packages/desktop/src/shared/bridge-contract.ts`. Asset-click-dispatcher
     * surface.
     */
    revealAsset(
      relPath: string,
    ): Promise<{ ok: true } | { ok: false; reason: 'path-escape' | 'not-found' | 'resolve-error' }>;

    /**
     * Display the native right-click context menu for an on-disk reference.
     * See canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
     * Asset-click-dispatcher surface.
     */
    showAssetMenu(params: {
      readonly relPath: string;
      readonly title: string;
      readonly kind: 'asset' | 'wiki-link' | 'image';
    }): Promise<void>;
    /**
     * Reveal a file or folder in the OS file manager. See canonical JSDoc
     * in `packages/desktop/src/shared/bridge-contract.ts`.
     */
    showItemInFolder(path: string): Promise<void>;
    /**
     * Move a file or folder to the OS Trash. See canonical JSDoc in
     * `packages/desktop/src/shared/bridge-contract.ts`.
     */
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
    /**
     * Forget one entry from the recent-projects list. See canonical JSDoc in
     * `packages/desktop/src/shared/bridge-contract.ts`.
     */
    removeRecent(path: string): Promise<void>;
    getSessionState(): Promise<ProjectSessionState>;
    setSessionState(state: ProjectSessionState): Promise<void>;
    open(request: {
      path: string;
      target: 'new-window';
      entryPoint: OkProjectEntryPoint;
      /**
       * Optional kind-discriminated target to deep-link into after the
       * project window mounts. Used by share-receive: Q1 hits and Q2/Q3
       * success both pass the share's target (a `doc` path or a `folder`
       * path) so the editor opens it directly. Threaded through to
       * `wm.createProjectWindow`'s `pendingDeepLinkTarget` (cold spawn →
       * `dom-ready` deep-link IPC) and to `sendDeepLink` for the warm-focus
       * path. Mirrors the existing `openknowledge://open?project=&doc=` plumbing.
       */
      pendingDeepLinkTarget?: { kind: 'doc' | 'folder'; path: string };
      /**
       * Optional share branch riding alongside `pendingDeepLinkTarget`. See
       * canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
       */
      pendingBranch?: string | null;
      /**
       * Optional branch-switch payload for the share-receive "I already have
       * it locally" path. See canonical JSDoc in
       * `packages/desktop/src/shared/bridge-contract.ts`. When the located
       * clone is on a different branch than the share, main delivers the
       * `project-branch-switch` surface instead of a plain deep-link open.
       */
      pendingShareBranchSwitch?: {
        share: OkSharePayloadFields;
        projectPath: string;
        currentBranch: string | null;
      };
    }): Promise<void>;
    /**
     * Atomically scaffold a new project under `parent/name` with the
     * user-chosen `editors` set. `editors` is the renderer's exact selection
     * (default-all unless the user unchecked entries); main never widens or
     * narrows it. See canonical JSDoc in
     * `packages/desktop/src/shared/bridge-contract.ts`.
     */
    createNew(args: {
      parent: string;
      name: string;
      editors: OkMcpWiringEditorId[];
      /** OK config sharing mode — defaults to 'shared' when omitted. */
      sharing?: 'shared' | 'local-only';
    }): Promise<void>;
    /**
     * Fire-and-forget renderer→main telemetry counter for the Create-new-project
     * dialog cascade banners. See canonical JSDoc in
     * `packages/desktop/src/shared/bridge-contract.ts`.
     */
    recordCreateNewBannerShown(banner: CreateNewBannerKind): Promise<void>;
    /**
     * Probe `<projectPath>/<path>` for the share-receive target-existence
     * gate, dispatching the on-disk predicate on `kind`. See canonical JSDoc
     * in `packages/desktop/src/shared/bridge-contract.ts`.
     */
    checkTargetExists(request: {
      projectPath: string;
      kind: 'doc' | 'folder';
      path: string;
    }): Promise<CheckTargetExistsResult>;
    /**
     * Read `<projectPath>/.git/HEAD` and classify the result. See canonical
     * JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
     */
    readHeadBranch(projectPath: string): Promise<HeadBranchInfo>;
    /**
     * Proxy `GET /api/git/branch-info` against the project's running server.
     * See canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
     */
    fetchBranchInfo(request: {
      projectPath: string;
      branch: string;
      kind: 'doc' | 'folder';
      path: string;
    }): Promise<BranchInfoResponse | null>;
    /**
     * Proxy `POST /api/git/checkout` against the project's running server.
     * `fastForward` (on-origin "Switch and update branch") fast-forwards the
     * target branch to origin's tip before checkout; divergence → `ff-diverged`
     * (nothing mutated). See canonical JSDoc in
     * `packages/desktop/src/shared/bridge-contract.ts`.
     */
    runCheckout(request: {
      projectPath: string;
      branch: string;
      fastForward?: boolean;
    }): Promise<CheckoutResponse | null>;
    /**
     * Proxy `POST /api/share/target-status` for the branch-switch dialog's
     * verdict pivot (on-origin / renamed / deleted / never-on-branch /
     * unknown). See canonical JSDoc in
     * `packages/desktop/src/shared/bridge-contract.ts`.
     */
    fetchTargetStatus(request: {
      projectPath: string;
      branch: string;
      path: string;
      kind: 'doc' | 'folder';
    }): Promise<ShareTargetStatusResponse | null>;
    /**
     * Gate dialog dismissal on the `branch-switched` broadcast landing
     * in the project window. See canonical JSDoc in
     * `packages/desktop/src/shared/bridge-contract.ts`.
     */
    awaitBranchSwitched(request: {
      projectPath: string;
      branch: string;
      timeoutMs: number;
    }): Promise<{ ok: true } | { ok: false; reason: 'timeout' | 'project-not-open' }>;
    /**
     * Run the share-receive scaffold inside a CLI-managed git worktree.
     * See canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
     */
    okInit(request: { projectPath: string }): Promise<LocalOpOkInitResponse>;
    close(): Promise<void>;
  };

  /**
   * Worktree selector (worktree = window). `list` enumerates the current
   * project's local branches + their worktrees; `create` creates or locates a
   * branch's worktree under `<mainRoot>/.ok/worktrees/`. The renderer opens the
   * worktree window via `project.open({ entryPoint: 'worktree' })`. Canonical
   * contract in `packages/desktop/src/shared/bridge-contract.ts`. Renderer
   * consumers: `ProjectSwitcher` + `NewWorktreeDialog`.
   */
  worktree: {
    list(): Promise<WorktreeListResult>;
    create(request: WorktreeCreateRequest): Promise<WorktreeCreateResult>;
  };

  /**
   * OK config sharing mode — per-project sharing-mode posture.
   * Canonical contract in `packages/desktop/src/shared/bridge-contract.ts`.
   * Renderer consumers: `SharingSection` in the Settings dialog.
   */
  sharing: {
    status(): Promise<OkSharingStatusResult>;
    setMode(mode: 'shared' | 'local-only'): Promise<OkSharingSetModeResult>;
  };

  /**
   * Filesystem probes that back the Create-new-project dialog cascade. See
   * canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
   */
  fs: {
    defaultProjectsRoot(): Promise<string>;
    folderState(path: string): Promise<OkFolderState>;
    findEnclosingProjectRoot(path: string): Promise<OkFindEnclosingProjectRootResult | null>;
    findEnclosingGitRoot(path: string): Promise<OkFindEnclosingGitRootResult | null>;
    removeGitFolder(gitRoot: string): Promise<void>;
  };
  /**
   * Re-summon the Project Navigator window from inside an editor window.
   * Focus-existing-or-create — idempotent on already-focused. Used by
   * `ProjectSwitcher` and `CommandPalette` to expose the navigator from
   * inside the editor without closing the current window.
   */
  navigator: {
    open(): Promise<void>;
  };
  seed: {
    plan(options?: OkSeedPlanOptions): Promise<OkSeedPlanResult>;
    apply(plan: OkScaffoldPlan, options?: OkSeedApplyOptions): Promise<OkSeedApplyResult>;
    listPacks(): Promise<OkSeedListPacksResult>;
  };
  skill: {
    /** True when Claude Desktop's config dir exists on this machine. */
    detectClaudeDesktop(): Promise<boolean>;
    /**
     * Build `openknowledge.skill` from the bundled source, save to
     * Downloads, invoke the OS file association (`.skill` → Claude
     * Desktop). Local build; no network.
     *
     * Gated by `~/.ok/skill-state/claude-cowork`: when the recorded
     * version matches the current bundled skill version, resolves with
     * `{ ok: true, skipped: true, version, recordedAt? }` without
     * rebuilding. Pass `force: true` to bypass for reinstall.
     */
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
    /**
     * Fire `ok:update:whats-new-dismiss` — tells main this window dismissed the
     * what's-new notice so main clears it across all windows. Fire-and-forget.
     */
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
  };
  /**
   * Per-project consent dialog surface. Navigator-only. Renderer mounts a
   * shadcn Dialog when `onShow` fires; calls `confirm` / `cancel` on user
   * action; calls `signalReady()` on app mount. `onToast` fires on
   * freshly-spawned editor windows for ancestor- and git-root-promote
   * events.
   */
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
  /**
   * Pre-project local-op flows. Required by the Project Navigator window
   * (no backing API server). See canonical JSDoc in
   * `packages/desktop/src/shared/bridge-contract.ts`.
   */
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
  /**
   * Share-receive flow surface. `validateLocalFolder` runs the
   * "I have it locally" folder validator in the main process via
   * `validateLocalFolderForShare` from the CLI package.
   */
  share: {
    validateLocalFolder(args: {
      folderPath: string;
      owner: string;
      repo: string;
    }): Promise<ShareFolderValidationResult>;
  };
  /**
   * Editor area state push surface. Renderer fires
   * `notifyActiveTargetChanged` once per `activeTarget` transition. See
   * canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
   */
  editor: {
    notifyActiveTargetChanged(target: OkEditorActiveTargetSnapshot): void;
    /**
     * Fire-and-forget push of the sidebar's view-menu state. See canonical
     * JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
     */
    notifyViewMenuStateChanged(state: Partial<OkEditorViewMenuStateSnapshot>): void;
  };
  /**
   * Startup-instrumentation push surface. The renderer reports its two
   * launch checkpoints (page-list ready, first content) as epoch-ms once both
   * land; main folds them into the `desktop.startup-timeline` waterfall log.
   * Fire-and-forget. Canonical JSDoc in `bridge-contract.ts`; mirrored verbatim
   * (drift-tested).
   */
  startup: {
    reportMarks(marks: { pageListReadyMs: number; firstContentMs: number }): void;
  };
  /**
   * Sidebar tree-state push subscriptions. Main pushes
   * `ok:sidebar:expand-all` / `ok:sidebar:collapse-all` on View menu picks.
   * See canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
   */
  sidebar: {
    expandAll(cb: () => void): OkUnsubscribe;
    collapseAll(cb: () => void): OkUnsubscribe;
  };

  /**
   * Bottom-docked terminal panel surface. Canonical JSDoc in
   * `bridge-contract.ts`; mirrored verbatim here (drift-tested).
   */
  terminal: {
    create(opts: {
      cols: number;
      rows: number;
      launchCommand?: string;
    }): Promise<OkPtyCreateResult>;
    input(ptyId: string, data: string): void;
    resize(ptyId: string, cols: number, rows: number): void;
    kill(ptyId: string): Promise<void>;
    drain(ptyId: string, bytes: number): void;
    /** Reload-rehydration inventory. Canonical JSDoc in `bridge-contract.ts`; mirrored verbatim (drift-tested). */
    list(): Promise<OkPtyListEntry[]>;
    /** Reload-rehydration adopt. Canonical JSDoc in `bridge-contract.ts`; mirrored verbatim (drift-tested). */
    adopt(ptyId: string): Promise<OkPtyAdoptResult>;
    /** Per-window dock visibility. Canonical JSDoc in `bridge-contract.ts`; mirrored verbatim (drift-tested). */
    getDockState(): Promise<{ visible: boolean }>;
    onData(cb: (msg: OkPtyData) => void): OkUnsubscribe;
    onExit(cb: (msg: OkPtyExit) => void): OkUnsubscribe;
    claudePreflight(): Promise<ClaudeReadiness>;
    cliPreflight(cli: TerminalCli): Promise<CliReadiness>;
    /** Batched CLI installed-map for the New-chat default auto-pick. Canonical JSDoc in `bridge-contract.ts`; mirrored (drift-tested). */
    cliInstalledMap(): Promise<Record<TerminalCli, boolean>>;
    rewireClaudeMcp(): Promise<ClaudeReadiness>;
  };

  readonly platform: 'darwin' | 'win32' | 'linux';
  readonly appVersion: string;
  /**
   * Resolve a dropped `File` to its absolute filesystem path via Electron
   * `webUtils.getPathForFile` (renderer-side, no IPC). Returns null for a File
   * with no backing path on disk (e.g. an in-memory clipboard blob). The
   * docked terminal uses this to insert a dropped file's path at the prompt.
   */
  getPathForFile(file: File): string | null;
  /**
   * Debug-only namespace populated by preload when the runtime gate
   * allows. Absent in production so a typo surfaces at compile time.
   */
  debug?: {
    keyringSmoke(): Promise<OkKeyringSmokeResult>;
  };
}

declare global {
  interface Window {
    /** Populated by the desktop preload script. Absent in web / CLI distribution. */
    okDesktop?: OkDesktopBridge;
  }
}
