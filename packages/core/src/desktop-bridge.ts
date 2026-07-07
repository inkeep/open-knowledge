/**
 * `window.okDesktop` — the preload-exposed bridge that packages/app consumes
 * to detect Electron-host mode and resolve its collab URL without a /api/config
 * HTTP round-trip.
 *
 * Shape lives in core so both the desktop package (who exposes it via
 * `contextBridge.exposeInMainWorld`) and the app package (who short-circuits
 * `useCollabUrl` on its presence) can import the same type. Zero desktop or
 * app deps — pure interface.
 */
import type { CreateNewBannerKind } from './constants/create-new-banner.ts';
import type { EditorId } from './constants/editors.ts';
import type { OkFolderState } from './constants/folder-state.ts';
import type {
  WorktreeCreateRequest,
  WorktreeCreateResult,
  WorktreeListResult,
} from './git/worktree-selector-model.ts';
import type { TerminalCli } from './handoff/terminal-launch.ts';
import type { LocalOpOkInitResponse } from './schemas/api/local-op.ts';
import type {
  BranchInfoResponse,
  CheckoutResponse,
  ShareTargetStatusResponse,
} from './schemas/api/share.ts';
import type { RecentProjectEntry } from './sharing/index.ts';

/** Render mode picked by the main process when creating a BrowserWindow. */
type OkDesktopMode = 'editor' | 'navigator' | 'terminal';

/**
 * Config values injected at preload-exposure time. A frozen snapshot, not a
 * getter — mid-session project switches fire through `onProjectSwitched`
 * instead. Required fields are present before the first renderer render
 * because the main process awaits the utility's `ready` message before
 * creating the BrowserWindow.
 */
interface OkDesktopConfig {
  /** WebSocket URL for the HocuspocusProvider (ws://localhost:<port>/collab). */
  readonly collabUrl: string;
  /** Origin for HTTP /api/* fetches (http://localhost:<port>). */
  readonly apiOrigin: string;
  /** Realpath of the project's content directory. */
  readonly projectPath: string;
  /** Display name for the project (usually basename of projectPath). */
  readonly projectName: string;
  /** Render mode — `navigator` renders the Project Navigator, `editor` renders the doc editor, `terminal` renders the standalone terminal window. */
  readonly mode: OkDesktopMode;
}

/**
 * Menu-action IDs fired by main → renderer via `ok:menu-action` after a user
 * selects a menu bar item. The renderer dispatches the action into the editor
 * store. Keep this union flat and strongly typed — a single `kind` field
 * discriminates without payload.
 */
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
  // View menu items.
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
  // Both delegate to the renderer's ProjectSwitcher surface.
  | 'new-worktree'
  | 'switch-worktree';

/**
 * Unsubscribe closure returned from `onProjectSwitched` / `onMenuAction`.
 * Calling it removes the listener. Per-electron#33328, the bridge's
 * preload-side wrapper is what actually tracks the listener reference so
 * callers must use this returned closure rather than trying to remove by
 * reference from their own code.
 */
type OkUnsubscribe = () => void;

interface ProjectSessionState {
  openTabs: string[];
  pinnedTabIds: string[];
  activeDocName: string | null;
  activeTabId: string | null;
  updatedAt: string | null;
}

/**
 * Discriminator for the Navigator-side surface that initiated a project-open.
 * Mirrors `EntryPoint` in `packages/desktop/src/shared/entry-point.ts`. Drift
 * across the three bridge-contract copies is caught by the drift test.
 */
type OkProjectEntryPoint =
  | 'create-new'
  | 'create-new-nested-redirect'
  | 'pick-existing'
  | 'recents'
  | 'deep-link'
  | 'drag-drop'
  | 'share-receive'
  | 'worktree';

/**
 * Payload accepted by `bridge.project.open(...)`. `target` stays in the
 * contract for forward-compat even though `'new-window'` is the only value
 * today (no switch-in-place). `entryPoint` tags the originating surface so
 * the consent-dialog gate can branch on user intent.
 */
interface OkProjectOpenRequest {
  path: string;
  target: 'new-window';
  entryPoint: OkProjectEntryPoint;
  /**
   * Optional kind-discriminated target to deep-link into after the project
   * window mounts. Used by share-receive: Q1 hits and Q2/Q3 success both
   * pass the share's target (a `doc` path or a `folder` path) so the editor
   * opens it directly. Threaded through to `wm.createProjectWindow`'s
   * `pendingDeepLinkTarget` (cold spawn → `dom-ready` deep-link IPC) and to
   * `sendDeepLink` for the warm-focus path. Mirrors the existing
   * `openknowledge://open?project=&doc=` flow.
   */
  pendingDeepLinkTarget?: { kind: 'doc' | 'folder'; path: string };
  /**
   * Optional share branch riding alongside `pendingDeepLinkTarget`. See
   * canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
   */
  pendingBranch?: string | null;
  /**
   * Optional branch-switch payload for the share-receive "I already have it
   * locally" path. See canonical JSDoc in
   * `packages/desktop/src/shared/bridge-contract.ts`. When the located clone
   * is on a different branch than the share, main delivers the
   * `project-branch-switch` surface instead of a plain deep-link open.
   */
  pendingShareBranchSwitch?: {
    share: OkSharePayloadFields;
    projectPath: string;
    currentBranch: string | null;
  };
}

/**
 * Outcome of `bridge.project.checkTargetExists({projectPath, kind, path})`.
 * See canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`
 * (`CheckTargetExistsResult`).
 *
 * Used by the main-side target-existence gate AFTER the branch comparison
 * passes — answers "does the share's target actually exist on the receiver's
 * currently-checked-out branch?" The `'unreadable'` sentinel collapses
 * the input-rejection + non-ENOENT I/O paths into a single graceful-fail
 * the caller treats as "silent dispatch is safe."
 */
export type OkCheckTargetExistsResult = 'exists' | 'missing' | 'unreadable';

/**
 * Outcome of `bridge.project.readHeadBranch(projectPath)`. See canonical
 * JSDoc in `packages/desktop/src/shared/bridge-contract.ts` (`HeadBranchInfo`).
 *
 * All-null + `detached: false` is the "couldn't determine" sentinel returned
 * on every failure mode (missing `.git`, malformed HEAD, I/O error, traversal
 * attempt). Used by the Project Navigator's recent-projects list.
 */
export interface OkHeadBranchInfo {
  readonly currentBranch: string | null;
  readonly headSha: string | null;
  readonly detached: boolean;
}

/**
 * Payload delivered to `onUpdateDownloaded` subscribers. Fires after
 * electron-updater has completed the ZIP download and is waiting for
 * install-on-quit (or an imperative `autoUpdater.quitAndInstall()` via
 * Toast A's "Relaunch now" action).
 */
interface OkUpdateDownloadedInfo {
  readonly version: string;
}

/**
 * Payload delivered to `onUpdateRelaunching` subscribers. Fires when one
 * window's "Relaunch now" click commits in main (`ok:update:relaunch-now`
 * passed its `versionPendingInstall` gate). Every window swaps its
 * `update-downloaded` card to the in-progress "Relaunching…" state.
 */
interface OkUpdateRelaunchingInfo {
  readonly version: string;
}

/**
 * Payload delivered to `onUpdateRelaunchFailed` subscribers. Fires when a
 * committed relaunch fails after the fact — the updater's `error` event
 * landed while the relaunch was in flight, the no-quit watchdog elapsed, or
 * `quitAndInstall()` threw. Main re-arms the banner separately via a
 * re-broadcast `ok:update:downloaded`; this carries the failure detail.
 */
interface OkUpdateRelaunchFailedInfo {
  readonly version: string;
  readonly message?: string;
}

/**
 * Payload delivered to `onWhatsNew` subscribers. Fires once per version
 * transition on first launch post-update (main compared `app.getVersion()`
 * to `AppState.lastSeenVersion`). `releaseUrl` is the GitHub Releases page
 * for the new version — renderer opens it via `bridge.shell.openExternal`.
 */
interface OkWhatsNewInfo {
  readonly version: string;
  readonly releaseUrl: string;
}

/**
 * Payload delivered to `onUpdateStuckHint` subscribers. Fires at most once
 * per installation after 7 consecutive calendar days of failed update
 * checks. `downloadUrl` is the manual-download page (inkeep.com's
 * OpenKnowledge download CTA); renderer opens it via
 * `bridge.shell.openExternal`.
 */
interface OkUpdateStuckHintInfo {
  readonly downloadUrl: string;
}

/**
 * Renderer-facing payload for `ok:share-received`. Carried by the main-
 * process share-flow handler in `url-scheme.ts` after `parseShareUrl`
 * dispatches on the universal-link / custom-scheme input shapes.
 *
 *   - `kind: 'project-branch-switch'` — editor-shell branch-switch surface
 *   - `kind: 'launcher-consent'` / `launcher-miss` — Navigator surfaces
 *   - `kind: 'unsupported-version'` — sonner toast "Update OpenKnowledge"
 *   - `kind: 'invalid'` — sonner toast "Invalid share URL"
 *
 * Mirrored across the three bridge-contract copies (desktop, core, app). Source
 * (universal-link vs custom-scheme) is NOT propagated — main-process diagnostic
 * logging only.
 */
/** Kind-discriminated receiver target carried by `OkSharePayloadFields`.
 *  Local copy — see canonical `ShareTarget` in
 *  `packages/desktop/src/shared/bridge-contract.ts`. */
type ShareTarget =
  | { readonly kind: 'doc'; readonly docPath: string }
  | { readonly kind: 'folder'; readonly folderPath: string };

/** Local copy — see canonical `OkSharePayloadFields` in
 *  `packages/desktop/src/shared/bridge-contract.ts`. */
interface OkSharePayloadFields {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly sharedUrl: string;
  readonly target: ShareTarget;
}

/** Local copy — see canonical `OkShareReceivedPayload` in
 *  `packages/desktop/src/shared/bridge-contract.ts`. */
type OkShareReceivedPayload =
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
 * contract copies (desktop, core, app) so the drift tests catch divergent copies.
 */
type ShareFolderValidationResult =
  | { readonly kind: 'ok'; readonly gitRemoteUrl: string }
  | { readonly kind: 'not-git' }
  | { readonly kind: 'no-origin' }
  | { readonly kind: 'wrong-repo'; readonly actualOwner: string; readonly actualRepo: string }
  | { readonly kind: 'non-github' }
  | { readonly kind: 'symlink-escape' };

/**
 * Auto-update channel — derived in desktop's main from the running build's
 * version string. `'beta'` for a prerelease build, `'latest'` for a stable
 * one. Not a runtime preference. Mirrors `UpdateChannel` in desktop's
 * `state-store.ts`.
 */
type OkUpdateChannel = 'latest' | 'beta';

/**
 * User-intent theme value. Mirrors Electron's `nativeTheme.themeSource`
 * union. Carried verbatim through the `ok:theme:set-source` IPC channel —
 * never resolved to a concrete light/dark value at the renderer call site
 * (the `'system'` value IS the lever that delegates appearance tracking to
 * macOS). Drift across the three bridge-contract copies (desktop, core,
 * app) is caught by an invariant test.
 */
type OkThemeSource = 'system' | 'light' | 'dark';

/**
 * Snapshot returned by `state.query()` — newly-opened windows query on
 * mount to render the correct BETA badge / About-panel label (channel is
 * build-derived) and to route the refuse-downgrade UX when a future-build
 * state was rolled back.
 */
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
 * Aliased to the canonical `EditorId` from `constants/editors.ts` — single
 * source of truth for the literal union. Bridge mirrors in desktop + app
 * also alias to the same `EditorId` so the type is structurally identical
 * across all three copies.
 */
type OkMcpWiringEditorId = EditorId;

/**
 * Payload delivered to `mcpWiring.onShow` subscribers on first-launch MCP
 * consent. Every editor in `ALL_EDITOR_IDS` appears; `detected: true`
 * preselects the checkbox in `<McpConsentDialog>`. `willReplace: true`
 * signals that the editor has an existing OK-managed entry that Add would
 * overwrite — surfaced per-row so long-time CLI users aren't surprised to
 * find their pre-existing entry stomped. `pathInstall` drives the dialog's
 * shell-PATH toggle row: `shellDetected: false` hides the row;
 * `alreadyInstalled: true` renders it informational; `rcFilesToTouch`
 * names the tildified shell files a grant would edit.
 */
interface OkMcpWiringShowPayload {
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

/**
 * Confirm payload for `mcpWiring.confirm`. `pathInstall` is the PATH
 * toggle, tri-state: `true` → append the managed rc block (consent
 * granted); `false` → record declined, touch no rc file; absent → no PATH
 * decision was solicited (row hidden or informational).
 *
 * `skills` — bundle ids the user left checked. Present ⇒ a skill decision was
 * solicited; every offered bundle not in the list is recorded declined (and
 * removed if already installed).
 */
interface OkMcpWiringConfirmRequest {
  readonly editorIds: readonly OkMcpWiringEditorId[];
  readonly pathInstall?: boolean;
  readonly skills?: readonly string[];
}

/**
 * Result shape for `mcpWiring.confirm` / `skip`. `ok:false` surfaces only
 * when `writeUserMcpConfigs` throws — per-editor failures still resolve
 * `ok:true` and are surfaced to operator logs via structured
 * `mcp-wiring-write-failed` events (deferred-marker semantics).
 */
type OkMcpWiringResult = { ok: true } | { ok: false; error: string };

/**
 * Per-project consent dialog — renderer-facing payload + result shapes.
 * Mirrors the desktop and app copies; drift caught by the
 * bridge-contract drift-catcher test.
 */
type OkOnboardingWarningKind =
  | 'root'
  | 'home'
  | 'home-documents'
  | 'home-desktop'
  | 'home-downloads'
  | 'volumes-mount'
  | 'drive-root';

type OkOnboardingGitState = 'present' | 'absent' | 'shell-only';

interface OkOnboardingShowPayload {
  readonly pickedPath: string;
  readonly projectDir: string;
  readonly defaultContentDir: string;
  readonly gitState: OkOnboardingGitState;
  readonly gitRootPromoted: boolean;
  readonly warnings: readonly { readonly kind: OkOnboardingWarningKind }[];
  readonly editorOptions: readonly {
    readonly id: OkMcpWiringEditorId;
    readonly label: string;
    readonly hasProjectConfig: boolean;
  }[];
}

interface OkOnboardingConfirmRequest {
  readonly initGit: boolean;
  readonly contentDir: string;
  readonly additionalIgnores: string;
  readonly editorIds: readonly OkMcpWiringEditorId[];
}

type OkOnboardingResult = { ok: true } | { ok: false; error: string };

interface OkOnboardingProbeContentRequest {
  readonly contentDir: string;
}

type OkOnboardingProbeContentResult =
  | {
      readonly ok: true;
      readonly count: number;
      readonly sample: readonly string[];
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Result shape for `bridge.debug?.keyringSmoke()` — mirrors
 * `KeyringSmokeResult` in `packages/desktop/src/utility/keyring-smoke.ts`
 * (identical field set). Duplicated here (not imported) because core has no
 * dep on desktop. Drift across the three copies (desktop, core, app) is
 * caught by the bridge-contract drift-catcher test, which walks the
 * interface body of each file and asserts field-name set equality.
 */
interface OkKeyringSmokeResult {
  ok: boolean;
  backend?: 'keyring' | 'file';
  error?: string;
  durationMs?: number;
  timestamp: string;
}

/**
 * Seed scaffolder shapes duplicated structurally (same rationale as
 * `OkKeyringSmokeResult` above — avoids pulling the server package into
 * core's compilation tree). Structural shape tracks
 * `@inkeep/open-knowledge-server`'s `ScaffoldPlan` / `ApplyResult` /
 * `ApplyError` / `FileEntry` / `SkipEntry`.
 *
 * Folder defaults moved out of `config.yml` `folders:` and into nested
 * `<folder>/.ok/frontmatter.yml` files written via the standard file-entry
 * path. The previous `OkFolderRule` / `OkScaffoldConfigEdit` mirror types
 * + the `configEdits` field on `OkScaffoldPlan` were removed alongside.
 */
interface OkScaffoldFileEntry {
  path: string;
  kind: 'folder' | 'file';
  contentPreview?: string;
}
interface OkScaffoldSkipEntry {
  path: string;
  reason: 'already-exists' | 'user-content' | 'glob-collision';
}
interface OkScaffoldPlan {
  created: OkScaffoldFileEntry[];
  skipped: OkScaffoldSkipEntry[];
  warnings: string[];
  /** The pack's project-local skill, when it ships one. `pending` = the skill
   *  source is absent from `.ok/skills/` and apply would (re)author it. */
  packSkill?: { name: string; pending: boolean };
}
interface OkScaffoldApplyError {
  path: string;
  error: string;
}
interface OkScaffoldApplyResult {
  applied: number;
  errors: OkScaffoldApplyError[];
  durationMs: number;
  /** Editor display-names that received the pack's project skill (e.g. "Claude Code"). */
  packSkillsInstalled: string[];
}

interface OkSeedError {
  kind: 'no-project' | 'prerequisite-missing' | 'invalid-root' | 'internal';
  message: string;
}

/**
 * Pack-id wire shape — accepted strings; coerced server-side via `coercePackId`.
 *
 * DRIFT WARNING: three-way structural mirror with
 *   - `packages/desktop/src/shared/bridge-contract.ts` (imports `PackId` from server)
 *   - `packages/app/src/lib/desktop-bridge-types.ts` (local copy)
 *
 * Adding a pack: update all three sites. Drift is caught at typecheck time by
 * the `Eq<>` type-check assertions.
 */
type OkPackId =
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

/**
 * User-visible entry counts surfaced on each pack picker card as
 * "N files · N folders". Three-way mirror with the desktop + app copies;
 * the Eq<> drift catcher fails if this diverges.
 */
interface OkSeedPackEntryCounts {
  files: number;
  folders: number;
}

interface OkSeedPackInfo {
  id: OkPackId;
  name: string;
  description: string;
  defaultSubfolder?: string;
  folders: OkSeedPackFolderInfo[];
  entryCounts: OkSeedPackEntryCounts;
}

/** Pure-fs upward-walk result types mirrored from `@inkeep/open-knowledge-server`'s
 *  `fs/` module. Structurally duplicated for the same reason as the seed shapes
 *  above (core has no dep on server). */
interface OkFindEnclosingProjectRootResult {
  readonly rootPath: string;
  readonly distance: number;
}
interface OkFindEnclosingGitRootResult {
  readonly gitRoot: string;
  readonly distance: number;
}
type OkSeedPlanResult = { ok: true; plan: OkScaffoldPlan } | { ok: false; error: OkSeedError };
type OkSeedApplyResult =
  | { ok: true; result: OkScaffoldApplyResult }
  | { ok: false; error: OkSeedError };
type OkSeedListPacksResult =
  | { ok: true; packs: OkSeedPackInfo[] }
  | { ok: false; error: { kind: 'internal'; message: string } };

/**
 * Pre-project local-op event shapes — auth + clone flows surfaced to the
 * Navigator window via IPC because it has no backing API server. See the
 * desktop bridge-contract for the canonical wire shape.
 */
type OkLocalOpAuthEvent =
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

type OkLocalOpCloneEvent =
  | { type: 'progress'; phase: string; pct: number }
  | { type: 'complete'; dir: string }
  | { type: 'branch-fallback'; branch: string }
  | { type: 'error'; message: string };

interface OkLocalOpStream<E> {
  readonly events: AsyncIterable<E>;
  cancel(): void;
}

type OkLocalOpAuthStatusResponse =
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

type OkLocalOpAuthReposResponse =
  | { ok: true; host: string; repos: OkLocalOpRepoEntry[] }
  | { ok: false; error: string };

/**
 * Renderer → main snapshot of the editor area's active target.
 * Discriminated-union shape so TypeScript narrows `identifier` per `kind`.
 * Drives the macOS File menu's state-aware enable/disable for items like
 * Rename / Move to Trash / Open with AI. See canonical JSDoc in
 * `packages/desktop/src/shared/bridge-contract.ts`.
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
 * Renderer-facing Electron bridge. Populated on `window.okDesktop` by the
 * desktop preload script. Web distribution omits the
 * global entirely — consumers MUST use `window.okDesktop?.` optional chaining.
 *
 * Method surface is intentionally small: dialog pickers, outbound URL /
 * clipboard relays, project subscriptions, and the readonly config snapshot.
 * Broad APIs (window sizing, system info, raw ipcRenderer) are deliberately
 * omitted — new capabilities cross the preload boundary deliberately, one at
 * a time, via new typed methods.
 */
/** OK config sharing mode — mirrored from bridge-contract.ts. */
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
 * Payload for `onServerVersionDrift` — the desktop attached to a server whose
 * version differs from the running app's (most often a prior version's
 * detached server still alive after an auto-update).
 */
export interface OkServerVersionDriftInfo {
  /** `older` = the attached server predates the app; `newer` = it is ahead. */
  readonly relation: 'older' | 'newer';
  /** Which dimension differed — diagnostic, not surfaced in copy. */
  readonly dimension: 'protocol' | 'runtime';
  /** The attached server's runtime semver (for the notification body). */
  readonly serverRuntime: string;
  /** The running app's runtime semver. */
  readonly appRuntime: string;
}

/** Payload for `onServerRestarted` — fired on the freshly-spawned window after a successful restart. */
export interface OkServerRestartedInfo {
  readonly appRuntime: string;
}

/**
 * Payload for `onServerReclaimed` — fired on the freshly-spawned window after a
 * dev session auto-terminated a foreign server it found on the project's
 * contentDir and started its own in its place. `appRuntime` is the app version
 * the fresh server runs.
 */
export interface OkServerReclaimedInfo {
  readonly appRuntime: string;
}

/**
 * Result of `restartServer`. Only the failure case reaches the originating
 * renderer — on success the window is recreated, so its invoke promise never
 * resolves (by design); the success toast fires on the new window instead.
 */
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

/** On-PATH readiness for a non-Claude agent CLI (codex / cursor-agent) launched
 *  in the docked terminal. Mirror of the same interface in the desktop bridge
 *  contract + the app renderer copy (drift-tested). */
export interface CliReadiness {
  readonly onPath: 'present' | 'not-found' | 'unknown';
}

export interface OkDesktopBridge {
  readonly config: OkDesktopConfig;

  /** Subscribe to project-switch events. Returns unsubscribe. */
  onProjectSwitched(cb: (next: OkDesktopConfig) => void): OkUnsubscribe;
  /** Subscribe to menu-bar actions. Returns unsubscribe. */
  onMenuAction(cb: (action: OkMenuAction) => void): OkUnsubscribe;
  /**
   * Subscribe to `autoUpdater` `update-downloaded` events. Fires once per
   * pending-update version (gated in main by `AppState.versionPendingInstall`).
   * Returns unsubscribe. Toast A.
   */
  onUpdateDownloaded(cb: (info: OkUpdateDownloadedInfo) => void): OkUnsubscribe;
  /**
   * Subscribe to `ok:update:relaunching` — another window's "Relaunch now"
   * click committed in main. Swap this window's `update-downloaded` card to the
   * button-less "Relaunching…" in-progress state so every window shows
   * consistent feedback during the pre-`quitAndInstall` server teardown.
   * Returns unsubscribe.
   */
  onUpdateRelaunching(cb: (info: OkUpdateRelaunchingInfo) => void): OkUnsubscribe;
  /**
   * Subscribe to `ok:update:relaunch-failed` — a committed relaunch failed
   * (async updater error, no-quit watchdog, or sync throw). Surface the
   * relaunch-error notice; the banner re-arm arrives separately as a
   * re-broadcast `ok:update:downloaded`. Returns unsubscribe.
   */
  onUpdateRelaunchFailed(cb: (info: OkUpdateRelaunchFailedInfo) => void): OkUnsubscribe;
  /**
   * Subscribe to post-update "What's new" events. Fires once per version
   * transition on first launch (gated in main by `AppState.lastSeenVersion`).
   * Returns unsubscribe. Toast B.
   */
  onWhatsNew(cb: (info: OkWhatsNewInfo) => void): OkUnsubscribe;
  /** Subscribe to `ok:update:whats-new-dismissed` — another window dismissed the what's-new notice; clear this window's `whats-new-<version>` card. */
  onWhatsNewDismissed(cb: (info: { readonly version: string }) => void): OkUnsubscribe;
  /**
   * Subscribe to `stuck-update` hints. Fires at most once per installation
   * after 7 consecutive failed-check days. Returns unsubscribe. Toast C.
   */
  onUpdateStuckHint(cb: (info: OkUpdateStuckHintInfo) => void): OkUnsubscribe;
  /**
   * Subscribe to `ok:deep-link` — fired when an
   * `openknowledge://open?project=…&doc=<name>` URL is routed to this
   * window. Renderer updates `location.hash` to open the target doc via
   * the existing hash-route listener. Returns unsubscribe.
   */
  onDeepLink(
    cb: (evt: {
      doc: string;
      kind: 'doc' | 'folder';
      branch?: string | null;
      multiCandidate?: boolean;
      targetMissing?: boolean;
    }) => void,
  ): OkUnsubscribe;
  /**
   * Subscribe to `ok:share-received` — fired when a share URL (universal
   * link `https://openknowledge.ai/d/<encoded>` or custom scheme
   * `openknowledge://share?url=<blob-url>`) routes to this window. The
   * discriminated payload tells the renderer to mount the receive dialog
   * (kind `ok`) or surface a toast (kind `unsupported-version` / `invalid`).
   */
  onShareReceived(cb: (payload: OkShareReceivedPayload) => void): OkUnsubscribe;

  /**
   * Subscribe to `ok:server-version-drift` — fired once when this window
   * attaches to a server whose version differs from the app's. The renderer
   * surfaces a cancelable notification offering to restart the server via
   * `restartServer`.
   */
  onServerVersionDrift(cb: (info: OkServerVersionDriftInfo) => void): OkUnsubscribe;
  /**
   * Subscribe to `ok:server-restarted` — fired on a freshly-recreated window
   * after a successful `restartServer`, so the renderer can confirm the
   * server now matches the app.
   */
  onServerRestarted(cb: (info: OkServerRestartedInfo) => void): OkUnsubscribe;
  /**
   * Subscribe to `ok:server-reclaimed` — fired on a freshly-spawned window when
   * this (dev-only) session auto-terminated a foreign server already running on
   * the project's contentDir and started its own in its place. The renderer
   * surfaces an informational notice naming the side effect: connected agents'
   * OpenKnowledge MCP connections were dropped. Unlike `onServerRestarted` no
   * user action initiated this (act-then-inform), so it is a disruption notice,
   * not a success confirmation.
   */
  onServerReclaimed(cb: (info: OkServerReclaimedInfo) => void): OkUnsubscribe;
  /**
   * Restart the project's server to match this app's version: terminate the
   * attached (not-owned) server and recreate the window against a fresh
   * own-version spawn. Resolves to `{ ok:false }` only when termination fails
   * (the originating window stays); on success the window is recreated and the
   * success toast fires there.
   */
  restartServer(projectPath: string): Promise<OkServerRestartOutcome>;

  /**
   * Push the user's chosen `nativeTheme.themeSource` value to main. Carries
   * the user-intent value (`'system' | 'light' | 'dark'`) verbatim — NEVER
   * resolve `'system'` to a concrete `'light' | 'dark'` at the call site
   * (it IS the lever that delegates to macOS appearance). Renderer
   * ConfigProvider runs this on every CRDT mutation of `appearance.theme`.
   * Failure is best-effort — body theme stays correct via next-themes; next
   * CRDT mutation re-fires.
   */
  setThemeSource(source: OkThemeSource): Promise<{ ok: true }>;

  /**
   * Fire-and-forget renderer→main signal that the theme has been applied
   * to chrome. Main's per-window show-gate listens for this alongside
   * `ready-to-show` before calling `BrowserWindow.show()` — eliminates the
   * cold-launch staleness window. Implemented in preload as
   * `invoke('ok:theme:applied', opts).catch(() => {})` so it composes
   * through the typed `createInvoker` wrapper.
   *
   * Optional `opts.reducedTransparency` carries the renderer's live
   * `matchMedia('(prefers-reduced-transparency: reduce)').matches` value;
   * main toggles vibrancy material accordingly. See canonical JSDoc in
   * `packages/desktop/src/shared/bridge-contract.ts`.
   */
  signalThemeApplied(opts?: { reducedTransparency?: boolean }): void;

  /** Native folder-picker dialog surfaces. */
  dialog: {
    /** `dialog.showOpenDialog({ properties: ['openDirectory'] })`. Resolves to the selected path or `null` on cancel.
     *  `defaultPath` seeds the initial directory shown to the user. */
    openFolder(opts?: { defaultPath?: string }): Promise<string | null>;
  };

  /**
   * IPC-relayed wrappers around Electron's `shell` module. Main-process
   * handlers enforce the outbound-scheme allowlist (`https`, `http`,
   * `mailto`, `openknowledge`, plus `claude`, `codex`, `cursor` for the
   * "Open in Agent Desktop" dropdown) before delegating. Unauthorized
   * schemes reject.
   */
  shell: {
    openExternal(url: string): Promise<void>;
    /**
     * Probe whether a URL scheme has a registered handler on this OS.
     * Used by the "Open in Agent Desktop" dropdown to render disabled-
     * with-tooltip rows when the target app isn't installed. Returns
     * `{installed: false}` on timeout or platform-API error.
     *
     * **Scheme format contract:** `scheme` is the scheme NAME without
     * trailing colon (e.g. `'claude'`, not `'claude:'`). Matches the Linux
     * `xdg-mime query default x-scheme-handler/<name>` shell-command form
     * and the main-process shell-injection sanitizer — callers with a
     * colonful scheme MUST strip the trailing `:` first.
     */
    detectProtocol(scheme: string): Promise<{ installed: boolean; displayName?: string }>;
    /**
     * Step 1 of the Cursor two-step handoff — spawns `cursor <path>` via a
     * validated argv (shell:false, 2s timeout). Dedicated channel because
     * the threat model is a command allowlist (PATH hijacking, arg
     * injection) distinct from the URL-scheme allowlist above.
     */
    spawnCursor(
      path: string,
    ): Promise<
      | { ok: true }
      | { ok: false; reason: 'invalid-path' | 'not-installed' | 'timeout' | 'spawn-error' }
    >;
    /**
     * Append a local-only telemetry line to `~/.ok/stats.jsonl`. Zero
     * phone-home. Resolves even if HOME is unwritable — telemetry failure
     * must never bubble up and affect the dispatch path. Literal-union
     * shape mirrors `HandoffTarget`, `HandoffFailureReason`, and
     * `HandoffScope` from `core/handoff/types.ts`.
     */
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
     * Open an asset via the OS default handler. `relPath` is project-relative
     * (main-process resolves against `ProjectContext.projectPath` + `realpath` +
     * `isPathWithinProject`). Executable extensions (`.exe`, `.sh`, `.app`, …)
     * hard-refuse at the main handler — see
     * `EXECUTABLE_BLOCKLIST_EXTENSIONS` in `core/constants/upload.ts` for
     * the full blocklist.
     */
    openAsset(
      relPath: string,
    ): Promise<
      | { ok: true }
      | { ok: false; reason: 'extension-blocked' | 'path-escape' | 'not-found' | 'resolve-error' }
    >;

    /**
     * Reveal an asset in the native file manager (macOS Finder / Windows
     * Explorer / Linux xdg-open → default). Parent-only — does NOT invoke
     * the OS default handler for content. Lower-risk than `openAsset`; the
     * executable blocklist does NOT apply.
     */
    revealAsset(
      relPath: string,
    ): Promise<{ ok: true } | { ok: false; reason: 'path-escape' | 'not-found' | 'resolve-error' }>;

    /**
     * Display the native right-click context menu for an on-disk reference
     * (`asset`, `wiki-link`, or `image`). Built from `Menu.buildFromTemplate`
     * in main — the gesture-attested pattern: main observes the click
     * directly, no IPC gesture forwarding needed. Entries: Reveal in Finder
     * + Open in default app + Copy link.
     */
    showAssetMenu(params: {
      readonly relPath: string;
      readonly title: string;
      readonly kind: 'asset' | 'wiki-link' | 'image';
    }): Promise<void>;
    /**
     * Reveal a file or folder in the OS file manager (Finder / Explorer /
     * Linux default). Path is validated against the caller window's project
     * directory in main; out-of-project, non-absolute, or null-byte-bearing
     * paths are silently refused at the wire (channel returns `undefined`
     * regardless; refusals emit a main-process `console.warn` for debugging).
     */
    showItemInFolder(path: string): Promise<void>;
    /**
     * Move a file or folder to the OS Trash via `shell.trashItem`. Step 1
     * of the sidebar Delete flow's two-step Option B orchestration. See
     * canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
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

  /** IPC-relayed clipboard writer (sandboxed renderer cannot call clipboard directly). */
  clipboard: {
    writeText(text: string): Promise<void>;
  };

  /**
   * Project-management surface consumed by the Navigator component.
   * `listRecent` reads the LRU-capped recent list from app state; `open`
   * spawns a NEW editor window for `request.path` (no switch-in-place);
   * `close` tears down the window hosting the call site.
   */
  project: {
    listRecent(): Promise<RecentProjectEntry[]>;
    /**
     * Forget one entry from the recent-projects list. See canonical JSDoc in
     * `packages/desktop/src/shared/bridge-contract.ts`.
     */
    removeRecent(path: string): Promise<void>;
    getSessionState(): Promise<ProjectSessionState>;
    setSessionState(state: ProjectSessionState): Promise<void>;
    open(request: OkProjectOpenRequest): Promise<void>;
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
    }): Promise<OkCheckTargetExistsResult>;
    /**
     * Read `<projectPath>/.git/HEAD` and classify the result. See canonical
     * JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
     */
    readHeadBranch(projectPath: string): Promise<OkHeadBranchInfo>;
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
     * verdict pivot. See canonical JSDoc in
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
     * Run the share-receive J2 scaffold inside a CLI-managed worktree.
     * See canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
     */
    okInit(request: { projectPath: string }): Promise<LocalOpOkInitResponse>;
    close(): Promise<void>;
  };

  /**
   * Worktree selector (worktree = window). `list` enumerates the
   * sender window's project's local branches + their worktrees; `create`
   * creates (or locates) the worktree for a branch under
   * `<mainRoot>/.ok/worktrees/`. Opening a worktree window reuses
   * `project.open({ entryPoint: 'worktree' })`. Canonical JSDoc in
   * `packages/desktop/src/shared/bridge-contract.ts`.
   */
  worktree: {
    list(): Promise<WorktreeListResult>;
    create(request: WorktreeCreateRequest): Promise<WorktreeCreateResult>;
  };

  /**
   * OK config sharing mode — per-project sharing-mode posture.
   * Canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
   * Mirrored here per the OkDesktopBridge 3-way-mirror invariant.
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
   * Backed by main's `openNavigator()` helper — focus-existing-or-create
   * with no toggle semantics. Renderer call sites: `ProjectSwitcher`
   * dropdown's "Switch Project…" item and `CommandPalette`'s "Switch
   * Project" entry. The File menu's "Switch Project…" item invokes
   * `openNavigator()` directly inside main without crossing the bridge.
   */
  navigator: {
    open(): Promise<void>;
  };

  /**
   * `ok seed` scaffolder surface consumed by the FileSidebar + menu.
   * `plan()` is read-only and returns what the scaffolder would write;
   * `apply(plan)` performs the writes. Same functions run under the
   * Commander CLI (`ok seed`).
   */
  seed: {
    plan(options?: OkSeedPlanOptions): Promise<OkSeedPlanResult>;
    apply(plan: OkScaffoldPlan, options?: OkSeedApplyOptions): Promise<OkSeedApplyResult>;
    listPacks(): Promise<OkSeedListPacksResult>;
  };

  /**
   * Claude Chat & Cowork skill install-dialog hooks. Drives the 2-click
   * install via Claude.app's `.skill` `CFBundleDocumentType`. Local-build
   * design: `.skill` is produced on demand from the app-bundled SKILL.md;
   * no GitHub Releases dep.
   */
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
     * rebuilding. Pass `force: true` to bypass.
     *
     * See canonical JSDoc in `packages/desktop/src/shared/bridge-contract.ts`.
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

  /**
   * Auto-update control surface. Toast A's "Relaunch now" button calls
   * `relaunchNow()` which invokes `autoUpdater.quitAndInstall()` in main.
   */
  update: {
    relaunchNow(): Promise<void>;
    /**
     * Force an out-of-cadence `checkForUpdates()` — fires the
     * `ok:update:check-now` IPC. Surfaced from the application menu's
     * "Check for Updates…" entries (App menu on macOS, Help menu
     * cross-platform). The user-facing result reaches the UI through
     * the existing toast event subscribers, so this resolves once main
     * has fired the request rather than waiting on the network.
     */
    checkNow(): Promise<void>;
    /**
     * Fire `ok:update:whats-new-dismiss` — tells main this window dismissed the
     * what's-new notice so main clears it across all windows. Fire-and-forget.
     */
    dismissWhatsNew(version: string): Promise<void>;
  };

  /**
   * Channel + schema-compatibility state surface. Renderer queries on mount
   * to render the correct BETA badge / About-panel label and route the
   * refuse-downgrade UX when a future-build state was rolled back.
   */
  state: {
    query(): Promise<OkStateSnapshot>;
    resetIncompatible(): Promise<void>;
  };

  /**
   * First-launch MCP consent surface. Renderer mounts `<McpConsentDialog>`
   * when `onShow` fires; calls `confirm` / `skip` on user action; calls
   * `signalReady()` once on app mount so main knows a renderer is
   * subscribed (mount-ack handshake).
   */
  mcpWiring: {
    /** Subscribe to the consent-dialog-show event. Returns unsubscribe. */
    onShow(cb: (payload: OkMcpWiringShowPayload) => void): OkUnsubscribe;
    /** Fire a one-way mount-ack event so main's whenRendererReady gate opens. */
    signalReady(): void;
    /** User clicked Add. `editorIds` is the subset the user checked;
     *  `pathInstall` is the PATH toggle (tri-state — see
     *  `OkMcpWiringConfirmRequest`). */
    confirm(request: OkMcpWiringConfirmRequest): Promise<OkMcpWiringResult>;
    /** User clicked Skip (or pressed ESC). */
    skip(): Promise<OkMcpWiringResult>;
  };

  /**
   * Per-project consent dialog surface. Navigator-only.
   * Renderer mounts a shadcn Dialog when `onShow` fires; calls
   * `confirm` / `cancel` on user action; calls `signalReady()` once on app
   * mount so main's mount-ack gate opens. `onToast` fires on freshly-spawned
   * editor windows for ancestor- and git-root-promote events.
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
            },
      ) => void,
    ): OkUnsubscribe;
  };

  /**
   * Pre-project local-op flows. Required by the Project Navigator window
   * (no backing API server). Editor windows use the HTTP path; this
   * surface is unused there.
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
   * Q2 "I have it locally" folder validator in the main process via
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
   * `notifyActiveTargetChanged` once per `activeTarget` transition in
   * `useDocumentContext()`. See canonical JSDoc in
   * `packages/desktop/src/shared/bridge-contract.ts`.
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
   * Startup-instrumentation push surface (desktop launch waterfall). The
   * renderer reports its two launch checkpoints — page-list ready and first
   * content — as epoch-ms once both land; main folds them into the
   * `desktop.startup-timeline` log line. See canonical JSDoc in
   * `packages/desktop/src/shared/bridge-contract.ts`.
   */
  startup: {
    reportMarks(marks: { pageListReadyMs: number; firstContentMs: number }): void;
  };

  /**
   * Sidebar tree-state push subscriptions. Main pushes
   * `ok:sidebar:expand-all` / `ok:sidebar:collapse-all` when the user picks
   * View → Expand All / Collapse All. See canonical JSDoc in
   * `packages/desktop/src/shared/bridge-contract.ts`.
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
    cliInstalledMap(): Promise<Record<TerminalCli, boolean>>;
    rewireClaudeMcp(): Promise<ClaudeReadiness>;
  };

  /** Current platform — `process.platform` reported by preload. */
  readonly platform: 'darwin' | 'win32' | 'linux';
  /** Electron app version (from main's `app.getVersion()`). */
  readonly appVersion: string;

  /**
   * Resolve a dropped `File` to its absolute filesystem path via Electron
   * `webUtils.getPathForFile` (renderer-side, no IPC). Returns null for a File
   * with no backing path on disk (e.g. an in-memory clipboard blob). The
   * docked terminal uses this to insert a dropped file's path at the prompt.
   */
  getPathForFile(file: File): string | null;

  /**
   * Debug-only namespace — populated by preload ONLY when the
   * `OK_DEBUG_KEYRING_SMOKE=1` env var is set OR the app is unpacked (dev
   * mode). Absent in normal production runs.
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
