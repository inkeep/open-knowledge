/**
 * `window.okDesktop` bridge contract — desktop-side canonical source.
 *
 * The same shape is also defined at `@inkeep/open-knowledge-core`'s
 * `desktop-bridge.ts` (consumed by the app package via its existing core
 * dependency) and app-locally at `packages/app/src/lib/desktop-bridge-types.ts`.
 * Drift across the three copies is caught by a drift-catcher test, which asserts
 * top-level `OkDesktopBridge` member parity AND the `KeyringSmokeResult` /
 * `OkKeyringSmokeResult` field shape across all three files.
 *
 * Why duplicated: moving the types to core's `exports` map + re-exports from
 * the core barrel pulls core's full compilation tree (markdown, CRDT bridge,
 * etc.) into desktop's TypeScript program via `moduleResolution: bundler`.
 * Desktop doesn't have core's mdast-adjacent dependencies declared, so the
 * module augmentation in core's `mdast-augmentation.ts` fails to resolve in
 * desktop's context. Duplication avoids the cross-package module-resolution
 * issue while preserving a single logical contract.
 */

import type {
  BranchInfoResponse,
  BridgeWorktreeEntry,
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

export type { BridgeWorktreeEntry };

import type {
  ApplyResult,
  FindEnclosingGitRootResult,
  FindEnclosingProjectRootResult,
  PackId,
  ScaffoldPlan,
} from '@inkeep/open-knowledge-server';
import type { KeyringSmokeResult } from '../utility/keyring-smoke.ts';
import type { EntryPoint } from './entry-point.ts';

/**
 * Options for `okDesktop.seed.plan()`. Replaces the old `rootDir?: string`
 * single-arg shape with an options object so multi-pack metadata threads
 * through cleanly. All fields optional — passing `{}` (or undefined) plans
 * the default Knowledge base pack at project root.
 */
export interface SeedPlanOptions {
  /** Subfolder relative to project root. `'.'` / `''` / undefined → project root. */
  rootDir?: string;
  /** Pack id to plan. Unknown ids fall back to `'knowledge-base'`. */
  packId?: PackId;
}

/** Options for `okDesktop.seed.apply()`. Same shape as plan minus rootDir. */
export interface SeedApplyOptions {
  packId?: PackId;
}

/** Per-folder metadata inside `OkSeedPackInfo.folders[]`. */
interface OkSeedPackFolderInfo {
  path: string;
  summary: string;
}

/**
 * User-visible entry counts surfaced on each pack picker card.
 * Counts only meaningful entries (top-level folders, template files,
 * rootFiles); `.ok/` infrastructure is excluded.
 */
interface OkSeedPackEntryCounts {
  files: number;
  folders: number;
}

/** Per-pack metadata returned by `okDesktop.seed.listPacks()`. */
interface OkSeedPackInfo {
  id: PackId;
  name: string;
  description: string;
  defaultSubfolder?: string;
  folders: OkSeedPackFolderInfo[];
  entryCounts: OkSeedPackEntryCounts;
}

/** Renderer-facing result of `okDesktop.seed.plan()`. Mirrors `SeedPlanResult` in main. */
export type OkSeedPlanResult =
  | { ok: true; plan: ScaffoldPlan }
  | {
      ok: false;
      error: {
        kind: 'no-project' | 'prerequisite-missing' | 'invalid-root' | 'internal';
        message: string;
      };
    };

/** Renderer-facing result of `okDesktop.seed.apply(plan)`. Mirrors `SeedApplyResult` in main. */
export type OkSeedApplyResult =
  | { ok: true; result: ApplyResult }
  | {
      ok: false;
      error: { kind: 'no-project' | 'prerequisite-missing' | 'internal'; message: string };
    };

/** Renderer-facing result of `okDesktop.seed.listPacks()`. Static data; no error path beyond internal. */
export type OkSeedListPacksResult =
  | { ok: true; packs: OkSeedPackInfo[] }
  | { ok: false; error: { kind: 'internal'; message: string } };

/** Render mode picked by the main process when creating a BrowserWindow. */
type OkDesktopMode = 'editor' | 'navigator' | 'terminal';

/** Frozen snapshot of window-level config injected at preload-exposure time. */
export interface OkDesktopConfig {
  readonly collabUrl: string;
  readonly apiOrigin: string;
  readonly projectPath: string;
  readonly projectName: string;
  readonly mode: OkDesktopMode;
  /**
   * `true` only under the Electron smoke suite (main injects `--ok-e2e-smoke=1`).
   * The renderer reads it to use xterm's DOM renderer instead of the WebGL
   * canvas (see `TerminalPanel`), so the DOM-based terminal smoke assertions can
   * read output + deliver input without a blanket `--disable-gpu`. Lockstep with
   * the app-side `OkDesktopConfig` — the member-name drift
   * catcher enforces set-equality.
   */
  readonly e2eSmoke: boolean;
  /**
   * `true` on an ephemeral single-file window (`ok <file>`). Drives the
   * renderer's no-project chrome gate. Kept in lockstep with the app-side
   * `OkDesktopConfig` (`packages/app/src/lib/desktop-bridge-types.ts`) — the
   * member-name drift catcher enforces set-equality.
   */
  readonly singleFile: boolean;
  /**
   * Doc to open on first paint, or `null`. Set only on an ephemeral single-file
   * window (`ok <file>`) — the ext-less docName the renderer seeds into
   * `window.location.hash` before React mounts, so the editor lands on the file
   * deterministically. Replaces the post-load `ok:deep-link` IPC for this path,
   * which raced the renderer's lazy `ipcRenderer.on` subscription and
   * intermittently dropped (leaving the hash empty → the empty-state splash).
   * Lockstep with the app-side `OkDesktopConfig`.
   */
  readonly initialDoc: string | null;
  /**
   * W3C `traceparent` of the Electron main process's `ok.app-startup` root
   * span, or `undefined` when OTel is disabled in main. Injected as
   * `--ok-startup-traceparent=` and read into the frozen config by preload; the
   * renderer extracts it to parent its startup span to the desktop launch trace.
   * The `m1-smoke.test.ts` drift catcher only checks the
   * `OkDesktopBridge` interface, not `OkDesktopConfig` fields, so this lives on
   * the desktop + app copies (the core mirror keeps the minimal config shape).
   */
  readonly startupTraceparent?: string;
}

/** Menu-action IDs fired by main → renderer on user menu selection. */
export type OkMenuAction =
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
  // File menu state-aware items. Renderer subscribes via the existing
  // `onMenuAction` bridge surface; routing through the same channel
  // avoids inventing a new IPC for what is conceptually "user picked a menu
  // item." Each action maps to a renderer-side handler that knows the current
  // `activeTarget` (file / folder / asset / project scope) and dispatches the
  // appropriate primitive.
  | 'new-from-template'
  | 'duplicate'
  | 'move-to-trash'
  | 'reveal-in-finder'
  | 'send-to-ai'
  | 'copy-full-path'
  | 'copy-relative-path'
  // View menu items. Sidebar visibility toggles
  // (mirror the sidebar's empty-space + folder menu state) + tree-scoped
  // Expand/Collapse All (sibling of subtree-scoped versions on folder
  // rows). Renderer handler reads merged config / Pierre tree state to
  // dispatch the appropriate primitive when the menu item is clicked.
  | 'toggle-show-hidden-files'
  | 'expand-all-tree'
  | 'collapse-all-tree'
  | 'toggle-doc-panel'
  // Docked terminal-panel visibility (⌘J / Ctrl+J).
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

/** Returned by `onProjectSwitched` / `onMenuAction`. Call to detach the listener. */
type OkUnsubscribe = () => void;

interface RecentProjectEntry {
  path: string;
  name: string;
  lastOpenedAt: string;
  missing?: boolean;
  /**
   * Canonical GitHub remote URL when the project has a github.com origin.
   * Read at open-time from `<projectPath>/.git/config`, normalized to
   * `https://github.com/<owner>/<repo>.git`. Powers the share-receive
   * lookup.
   */
  gitRemoteUrl?: string;
}

interface ProjectSessionState {
  openTabs: string[];
  pinnedTabIds: string[];
  activeDocName: string | null;
  activeTabId: string | null;
  updatedAt: string | null;
}

/**
 * Outcome of `bridge.project.readHeadBranch(projectPath)`. See the bridge
 * method's JSDoc for the failure-mode contract.
 *
 * `currentBranch` and `headSha` are mutually exclusive — the implementation
 * only ever produces three states:
 *   1. attached  → `{ currentBranch: string, headSha: null, detached: false }`
 *   2. detached  → `{ currentBranch: null, headSha: string, detached: true }`
 *   3. unknown   → `{ currentBranch: null, headSha: null, detached: false }`
 *
 * Field semantics:
 * - `currentBranch` is set when HEAD points at a symbolic ref. Slashed
 *   branch names (`feat/foo`) survive intact.
 * - `headSha` is the first 7 chars of the SHA on a detached HEAD; caller
 *   may use it as a display label.
 * - `detached === true` distinguishes a real detached HEAD from a
 *   graceful-fail. The all-null + `detached: false` shape is the
 *   "couldn't determine" sentinel; the caller falls back to silent
 *   dispatch as if no branch check had been attempted.
 */
export interface HeadBranchInfo {
  readonly currentBranch: string | null;
  readonly headSha: string | null;
  readonly detached: boolean;
}

/**
 * Discriminator string returned by `bridge.project.readGitDirKind(path)`.
 * Mirrors `ResolvedGitDir.kind` from `@inkeep/open-knowledge-core/shadow-
 * repo-layout`. The candidate-selection algorithm cares about `'directory'`
 * (main checkout) and `'linked'` (worktree); the other three values
 * collapse to "skip in fallback partitioning."
 */
export type ResolvedGitDirKind =
  | 'directory'
  | 'linked'
  | 'absent'
  | 'malformed-pointer'
  | 'inaccessible';

/**
 * Outcome of `bridge.project.checkTargetExists({projectPath, kind, path})`.
 * See the bridge method's JSDoc for the failure-mode contract.
 *
 * - `'exists'` — the joined path matches the requested kind: a regular file
 *   for `doc`, a directory for `folder`.
 * - `'missing'` — the joined path returned `ENOENT`, or it resolved to the
 *   wrong type for its kind (a `doc` probe hitting a directory, a `folder`
 *   probe hitting a file). Surface "not on this branch yet."
 * - `'unreadable'` — input rejected (unsafe path / containment violation)
 *   OR an I/O error other than `ENOENT`. Caller treats this identically
 *   to `'exists'`: graceful-fail collapses to silent dispatch.
 */
export type CheckTargetExistsResult = 'exists' | 'missing' | 'unreadable';

/** Payload passed to `onUpdateDownloaded` subscribers. Mirrors ok:update:downloaded. */
export interface OkUpdateDownloadedInfo {
  readonly version: string;
}

/** Payload passed to `onUpdateRelaunching` subscribers. Mirrors ok:update:relaunching. */
export interface OkUpdateRelaunchingInfo {
  readonly version: string;
}

/** Payload passed to `onUpdateRelaunchFailed` subscribers. Mirrors ok:update:relaunch-failed. */
export interface OkUpdateRelaunchFailedInfo {
  readonly version: string;
  readonly message?: string;
  /**
   * Manual-download fallback URL, present only on the boot-detected
   * failed-install variant (a clean quit whose post-quit install never ran).
   * When set, the renderer shows the richer "Retry / Download manually" card;
   * the in-session async/watchdog failures omit it and keep the plain message.
   */
  readonly downloadUrl?: string;
}

/** Payload passed to `onWhatsNew` subscribers. Mirrors ok:update:whats-new. */
export interface OkWhatsNewInfo {
  readonly version: string;
  readonly releaseUrl: string;
}

/** Payload passed to `onUpdateStuckHint` subscribers. Mirrors ok:update:stuck-hint. */
export interface OkUpdateStuckHintInfo {
  readonly downloadUrl: string;
}

/**
 * Auto-update channel — derived from the running build's version string in
 * main (`channelFromVersion(app.getVersion())`). `'beta'` for a prerelease
 * build, `'latest'` for a stable one. Not a runtime preference; surfaced
 * read-only via `state.query()`. Mirrors `UpdateChannel`.
 */
export type OkUpdateChannel = 'latest' | 'beta';

/**
 * User-intent theme value. Mirrors Electron's `nativeTheme.themeSource` union.
 * Carried verbatim through the `ok:theme:set-source` IPC channel — never
 * resolved to a concrete light/dark value at the renderer call site. The
 * `'system'` value IS the lever that delegates appearance tracking to
 * macOS; resolving at the call site loses OS auto-tracking.
 */
export type OkThemeSource = 'system' | 'light' | 'dark';

/**
 * Snapshot returned by `state.query()` — used by newly-opened windows on
 * mount to render the correct BETA badge / About-panel label and to route
 * the refuse-downgrade UX when a future-build state was rolled back.
 * `channel` is build-derived (a property of the binary). `schemaIncompatibility`
 * is non-null only when the persisted state's `schemaVersion` exceeds what
 * this build supports.
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
 * Aliased to the canonical `EditorId` from `@inkeep/open-knowledge-core` —
 * single source of truth for the literal union. The local name is preserved
 * so existing call sites keep their imports stable.
 */
type OkMcpWiringEditorId = EditorId;

/** Payload passed to `onShow` subscribers. Mirrors ok:mcp-wiring:show.
 *  `willReplace: true` signals the editor has an existing OK-managed entry
 *  that Add would overwrite — per-editor disclosure. `pathInstall` drives
 *  the dialog's shell-PATH toggle row: `shellDetected: false` hides the
 *  row; `alreadyInstalled: true` renders it informational (block already on
 *  disk or consent already granted); `rcFilesToTouch` names the tildified
 *  shell files a grant would edit. */
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
type OkMcpWiringResult = { ok: true } | { ok: false; error: string };

/**
 * Per-project consent dialog — renderer-facing payload + result
 * shapes. Mirrors the IPC types in `./ipc-channels.ts` so the bridge surface
 * can be consumed without crossing the IPC barrel. `OkOnboardingShowPayload`
 * is the only one exported because preload imports it for the listener wire;
 * the rest live inside the `OkDesktopBridge` interface signature.
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

/** OK config sharing mode. */
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
    /** True when the editor exposes a per-project MCP config file (e.g.
     *  `.mcp.json`). False when only the user-level config is writable
     *  (e.g. Claude Desktop's `claude_desktop_config.json`). The dialog
     *  uses this to label scope per option so the user understands which
     *  editors will scaffold project-local config vs which will only
     *  update their user profile. */
    readonly hasProjectConfig: boolean;
  }[];
}

interface OkOnboardingConfirmRequest {
  readonly initGit: boolean;
  readonly contentDir: string;
  readonly additionalIgnores: string;
  readonly editorIds: readonly OkMcpWiringEditorId[];
  /** OK config sharing mode. Sharing posture chosen in the
   *  consent dialog. */
  readonly sharing: 'shared' | 'local-only';
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
 * Pre-project local-op event shapes — auth + clone flows surfaced to the
 * Navigator window via IPC because it has no backing API server. Editor
 * windows continue to use the HTTP path (`/api/local-op/...`) which the
 * `installClientFetchWrapper` helper rewrites against the utility's
 * apiOrigin. See `packages/desktop/src/shared/ipc-events.ts` for the
 * canonical wire shapes.
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
  /**
   * Emitted when the CLI's `-b <branch>` request falls back to the remote
   * default branch because the requested ref is gone upstream. Non-terminal —
   * the clone keeps running and a `complete` follows. Mirrors the HTTP
   * transport's `CloneEvent` variant so both transports surface the same
   * "branch no longer exists" signal to the share-receive controller.
   */
  | { type: 'branch-fallback'; branch: string }
  | { type: 'error'; message: string };

/** Returned by `localOp.{auth,clone}.start` — handle for streaming events + cancel. */
export interface OkLocalOpStream<E> {
  /** Async iterable of events. Terminates on `complete` / `error` or `cancel()`. */
  readonly events: AsyncIterable<E>;
  /** SIGTERM the underlying subprocess. Idempotent. */
  cancel(): void;
}

/** One-shot result for `localOp.auth.status()`. Also imported by
 *  `./ipc-channels.ts` as the IPC channel result type so the wire shape
 *  and the bridge method signature can't drift.
 *
 *  `tier` reflects which credential source the CLI used:
 *    A — `gh` CLI delegation (no keychain entry needed)
 *    B — HTTPS token from the OK TokenStore
 *    C — SSH-paired token from the OK TokenStore
 *  Optional for forward-compat with CLIs that don't emit it. */
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

/** Bounded repo entry returned by `localOp.auth.repos()`. */
interface OkLocalOpRepoEntry {
  full_name: string;
  clone_url: string;
  private: boolean;
}

/** One-shot result for `localOp.auth.repos()`. Also imported by
 *  `./ipc-channels.ts` — see `OkLocalOpAuthStatusResponse`. */
export type OkLocalOpAuthReposResponse =
  | { ok: true; host: string; repos: OkLocalOpRepoEntry[] }
  | { ok: false; error: string };

/**
 * Common fields extracted from a share URL (universal-link / custom-scheme
 * decoded). Carried on every `OkShareReceivedPayload` variant that
 * successfully decoded so the receiver can render copy + reach back to
 * `sharedUrl` without re-decoding. `target` discriminates doc vs folder
 * shares (`ShareTarget`); the bare path is recovered via `shareTargetPath`.
 */
export interface OkSharePayloadFields {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly sharedUrl: string;
  readonly target: ShareTarget;
}

/**
 * Renderer-facing payload for the `ok:share:received` event. Carried by the
 * main-process share-flow handler in `url-scheme.ts` AFTER main has already
 * resolved the share target via `resolveShareTarget`. The discriminant
 * names the surface the renderer must mount — the renderer never re-runs
 * candidate selection.
 *
 * Routing matrix (main → renderer):
 *   - `invalid` / `unsupported-version` — toast on the focused/any window
 *   - `project-branch-switch` — sent to the editor window owning
 *     `projectPath`; renderer mounts the branch-switch surface
 *     (driven by `branch-switch-flow.ts`)
 *   - `launcher-consent` — sent to the Navigator; renderer mounts the
 *     consent/init surface for the worktree at `candidatePath` (HEAD
 *     matches the share branch but `.ok/config.yml` is absent)
 *   - `launcher-miss` — sent to the Navigator; renderer mounts the
 *     clone/locate surface (no usable local copy exists)
 *
 * Present-on-shared-branch (the `branch-match-ok` candidate-selection
 * outcome) is delivered via the existing `ok:deep-link` channel
 * (`pendingDeepLinkTarget`/`pendingBranch`/`pendingMultiCandidate`), not
 * `ok:share:received` — no panel needed. The kind-aware target-existence
 * gate runs main-side before that dispatch (see `dispatchResolvedShare`).
 *
 * Source (universal-link vs custom-scheme) is intentionally NOT propagated —
 * main-process diagnostic logging only.
 */
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
 * Kind-discriminated receiver target carried by the `ok` arm of
 * `OkShareReceivedPayload`. A GitHub blob share resolves to a `doc` target
 * (a single markdown file); a GitHub tree share resolves to a `folder`
 * target (a directory whose `folderPath` MAY be empty for the repo/branch
 * root). Mirrored byte-identically across the three bridge-contract copies
 * (desktop, core, app).
 */
export type ShareTarget =
  | { readonly kind: 'doc'; readonly docPath: string }
  | { readonly kind: 'folder'; readonly folderPath: string };

/**
 * Renderer-facing mirror of `ShareFolderValidationResult` from
 * `@inkeep/open-knowledge`'s `validateLocalFolderForShare`. Carried
 * by the `share.validateLocalFolder` IPC. Mirrored across the three bridge-
 * contract copies (desktop, core, app) so the drift tests catch divergent copies.
 */
export type ShareFolderValidationResult =
  | { readonly kind: 'ok'; readonly gitRemoteUrl: string }
  | { readonly kind: 'not-git' }
  | { readonly kind: 'no-origin' }
  | { readonly kind: 'wrong-repo'; readonly actualOwner: string; readonly actualRepo: string }
  | { readonly kind: 'non-github' }
  | { readonly kind: 'symlink-escape' };

/**
 * Renderer → main snapshot of the editor area's active target.
 * Discriminated-union shape so TypeScript narrows `identifier` per `kind`
 * at consumer sites. `'doc'` carries the active doc name; `'folder'`
 * carries the active folder path; `'asset'` carries the active asset path;
 * `kind: null` represents the no-active-target / project-scope state
 * (FolderOverview-style entry).
 *
 * Drives the macOS File menu's state-aware item enable/disable: doc → all
 * doc-targeted items enabled; folder → all folder-targeted items enabled;
 * asset → Rename / Move to Trash / Reveal enabled, Duplicate disabled;
 * null → only project-level items (New File, Reveal in Finder for
 * `contentDir`, etc.) enabled; Rename / Duplicate / Move to Trash disabled. Same
 * shape as `EditorActiveTargetSnapshot` in `./ipc-channels.ts` —
 * duplicated for the same module-resolution reason the wider
 * `OkDesktopBridge` is duplicated (see top-of-file comment).
 */
export type OkEditorActiveTargetSnapshot =
  | { readonly kind: 'doc'; readonly identifier: string }
  | { readonly kind: 'folder'; readonly identifier: string }
  | { readonly kind: 'asset'; readonly identifier: string }
  | { readonly kind: null };

/**
 * Renderer → main snapshot of the View menu's checkbox + smart-hide state.
 * Drives the macOS View menu's live `checked` reflection for "Show Hidden Files"
 * and the `visible: false` smart-hide on "Expand All" /
 * "Collapse All" so a fully-expanded tree doesn't render a no-op item.
 * `sidebarVisible` flips the "Show Sidebar" / "Hide Sidebar" label on the
 * View-menu sidebar-toggle item (Apple HIG: same row, label toggles).
 *
 * Sibling of `OkEditorActiveTargetSnapshot` — kept on its own surface
 * (rather than folded into the active-target snapshot) because the two
 * signals change on independent edges: active-target on navigation,
 * view-menu-state on config CRDT mutations + tree expand/collapse.
 * Same shape as `EditorViewMenuStateSnapshot` in `./ipc-channels.ts` —
 * duplicated for the module-resolution reason the wider `OkDesktopBridge`
 * is duplicated (see top-of-file comment).
 */
export interface OkEditorViewMenuStateSnapshot {
  readonly showHiddenFiles: boolean;
  readonly canExpandAll: boolean;
  readonly canCollapseAll: boolean;
  readonly sidebarVisible: boolean;
  readonly docPanelVisible?: boolean;
  // Docked terminal-panel visibility. Optional + defaults hidden: the View
  // menu reads "Show Terminal" until the renderer pushes the first snapshot.
  readonly terminalVisible?: boolean;
  // Whether a terminal session (PTY) is currently mounted. Distinct from
  // `terminalVisible`: the latch survives a collapse, so a hidden-but-alive
  // terminal reads `terminalLive: true, terminalVisible: false`. Drives the
  // Terminal menu's "Kill Terminal" enablement.
  readonly terminalLive?: boolean;
}

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
 * the fresh server runs (always present — sourced from `app.getVersion()`).
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

/**
 * Result of `window.okDesktop.terminal.create`. `no-project` is returned when
 * the calling window has no resolved project root (e.g. the Navigator window):
 * a terminal needs a cwd, so main refuses rather than spawning a shell at an
 * arbitrary directory. `not-consented` is the main-side trust-boundary backstop
 * (fail-open): the terminal is allowed by default, so main refuses only when the
 * window's project-local `terminal.enabled === false`, preventing a renderer
 * regression or compromise from spawning a real shell in a project a human has
 * explicitly opted out of.
 *
 * NOTE: structurally mirrored verbatim in `core/src/desktop-bridge.ts` and
 * `app/src/lib/desktop-bridge-types.ts` — the m1-smoke + bridge-contract-types
 * drift tests fail if the three copies diverge.
 */
export type OkPtyCreateResult =
  | { readonly ok: true; readonly ptyId: string }
  | { readonly ok: false; readonly reason: 'no-project' | 'not-consented' };

/**
 * One entry of the reload-rehydration inventory (`terminal.list`) — a ptyId that
 * is still live in the main process for the window. Mirrored verbatim in the core
 * + app bridge copies (drift-tested).
 */
export interface OkPtyListEntry {
  readonly ptyId: string;
}

/**
 * Result of `terminal.adopt` — re-binding a surviving session to a reloaded
 * renderer. On success, `replay` is the retained screen + scrollback the renderer
 * writes into the fresh xterm so the adopted tab repaints instead of coming back
 * blank; it may be empty for a session that produced no
 * output. `unknown-session` means the addressed shell is no longer live for the
 * window (it exited in the gap between the dock's `list` and this adopt), so the
 * panel spawns a fresh shell instead. Mirrored verbatim (drift-tested).
 */
export type OkPtyAdoptResult =
  | { readonly ok: true; readonly replay: string }
  | { readonly ok: false; readonly reason: 'unknown-session' };

/** Push payload for `ok:pty:data` — a coalesced UTF-8 chunk of shell output. */
export interface OkPtyData {
  readonly ptyId: string;
  readonly data: string;
}

/**
 * Push payload for `ok:pty:exit` — the shell exited or the PTY died. `error`
 * is present only when the spawn itself failed (resource exhaustion); a normal
 * shell exit carries `exitCode`/`signal` and omits it.
 */
export interface OkPtyExit {
  readonly ptyId: string;
  readonly exitCode: number;
  readonly signal: number | null;
  readonly error?: string;
}

/**
 * Claude Code readiness for the docked terminal. `claude` is the
 * login-shell PATH probe: `unknown` means the probe could not run (a flaky
 * spawn / timeout), so the panel must NOT render a "not installed" message off
 * it. `mcp` is whether `~/.claude.json` carries the `open-knowledge` server, so
 * a `claude` launched here sees OK tools.
 *
 * NOTE: structurally mirrored verbatim in `core/src/desktop-bridge.ts` and
 * `app/src/lib/desktop-bridge-types.ts` — the m1-smoke + bridge-contract-types
 * drift tests fail if the three copies diverge.
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

/**
 * On-PATH readiness for a non-Claude agent CLI (codex / cursor-agent) launched
 * in the docked terminal. `unknown` means the login-shell probe could not run
 * (a flaky spawn / timeout), so the panel must NOT render a "not installed"
 * message off it. There is no MCP-wiring field — unlike Claude these CLIs have
 * no `~/.claude.json`-style OK-tools concept here.
 *
 * NOTE: structurally mirrored verbatim in `core/src/desktop-bridge.ts` and
 * `app/src/lib/desktop-bridge-types.ts` — the drift tests fail if the three copies diverge.
 */
export interface CliReadiness {
  readonly onPath: 'present' | 'not-found' | 'unknown';
}

/** Renderer-facing Electron bridge. Populated on `window.okDesktop` by the desktop preload script. */
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
  /**
   * Subscribe to `ok:deep-link` — fired when an `openknowledge://` URL is
   * routed to this window. Renderer updates `location.hash` to open the
   * target doc via the existing hash-route listener. When `branch` is
   * present, it rides alongside on the hash as `?branch=<encoded>` so the
   * share-receive flow can detect branch mismatches. Treat `null` /
   * `undefined` / absent identically (no branch — back-compat with legacy
   * emitters).
   */
  onDeepLink(
    cb: (evt: {
      doc: string;
      /**
       * Discriminates whether `doc` is a single-doc path or a folder path.
       * `doc` carries the path string for both kinds today; a sibling story
       * makes the renderer's hash setter kind-aware.
       */
      kind: 'doc' | 'folder';
      branch?: string | null;
      /**
       * `true` iff the dispatcher's candidate-selection evaluated more
       * than one candidate. The renderer's `installDeepLinkListener`
       * uses this to suppress the "Opened on branch X" toast for
       * single-clone receivers (no disambiguation value) and
       * surface it for multi-worktree receivers (where the dispatched
       * window's identity is the actionable signal). Treat
       * `undefined` / absent as `false` — back-compat with legacy
       * emitters that never set the flag.
       */
      multiCandidate?: boolean;
      /**
       * `true` iff main's target-existence gate found the share's target
       * absent on the checked-out branch. The renderer toasts "not on this
       * branch yet" in-context instead of navigating into a blank editor.
       */
      targetMissing?: boolean;
    }) => void,
  ): OkUnsubscribe;
  /**
   * Subscribe to `ok:share:received` — fired when a share URL (universal
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
   * OpenKnowledge MCP connections were dropped. No user action initiated this
   * (act-then-inform), so unlike `onServerRestarted` it is not a success
   * confirmation but a disruption notice.
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
   * resolve `'system'` to a concrete `'light' | 'dark'` at the call site.
   * `'system'` IS the lever that delegates appearance tracking to macOS;
   * resolving at the call site loses OS auto-tracking. The renderer
   * ConfigProvider effect runs this on every CRDT mutation of
   * `appearance.theme`.
   *
   * Failure model: main's handler is best-effort. On rejection (handler
   * not registered, channel teardown, etc.) callers swallow + structured-
   * warn; the renderer's body theme is already correct via next-themes
   * and the next CRDT mutation re-fires this naturally. See ConfigProvider's
   * sibling effect for the canonical caller pattern.
   *
   * `{ ok: true }` does NOT prove the value was honored — main's handler
   * silently rejects unknown values (defensive against a future bridge-
   * contract divergence or a non-typed IPC bypass) and still returns
   * `{ ok: true }`. The diagnostic surface for rejection is the structured
   * `console.warn` `{ event: 'theme-source-set-rejected', received, reason }`
   * in `theme-handler.ts` — visible in the main-process console (DevTools,
   * Console.app on packaged builds), not the renderer. Callers cannot
   * observe whether `'system' | 'light' | 'dark'` was applied vs ignored
   * on the renderer side; trust the type system at the call site.
   */
  setThemeSource(source: OkThemeSource): Promise<{ ok: true }>;

  /**
   * Fire-and-forget renderer→main signal. The renderer fires this once
   * after ConfigProvider's first sync settles (releasing the cold-launch
   * window-show gate), and again on every `prefers-reduced-transparency`
   * matchMedia change for live vibrancy updates. Main's per-window
   * show-gate listens for the first fire alongside `ready-to-show` before
   * calling `BrowserWindow.show()` — this eliminates the cold-launch
   * staleness window where the OS-drawn chrome would briefly mismatch the
   * renderer body. Subsequent fires release a no-op on the show-gate side
   * (the window is already visible) and only drive the vibrancy toggle.
   *
   * Implemented as `invoke('ok:theme:applied', opts).catch(() => {})` so it
   * composes through the typed `createInvoker` wrapper and clears the
   * IPC-discipline rule. Rejections are swallowed — a missing handler
   * during teardown is expected, not a programmer error. Mirrors the
   * `mcpWiring.signalReady()` precedent (preload bridge file).
   *
   * Optional `opts.reducedTransparency` carries the renderer's live
   * `matchMedia('(prefers-reduced-transparency: reduce)').matches` value.
   * When provided, main toggles vibrancy material on every BrowserWindow:
   * `null` (off) when reduced=true, `'sidebar'` (the DEFAULT_WIN_OPTS
   * material) when false. Folded into this signal rather than introducing
   * a separate IPC channel — the team's commitment to migrate to typed-ipc
   * fires before any further hand-rolled channel additions, so payload-
   * widening on an existing channel is the right fit.
   */
  signalThemeApplied(opts?: { reducedTransparency?: boolean }): void;

  dialog: {
    openFolder(opts?: { defaultPath?: string }): Promise<string | null>;
  };

  shell: {
    openExternal(url: string): Promise<void>;
    /**
     * Probe whether a URL scheme has a registered handler on this OS.
     * Used by the "Open in Agent Desktop" dropdown to
     * render disabled-with-tooltip rows when the target app isn't installed.
     * Returns `{installed: false}` on timeout or platform-API error.
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
     * the threat model is a command allowlist distinct from the URL-scheme
     * allowlist.
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
     * must never bubble up and affect the dispatch path. The literal-union
     * shape mirrors `HandoffTarget`, `HandoffFailureReason`, and `HandoffScope`
     * from the core handoff types.
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
     * `EXECUTABLE_BLOCKLIST_EXTENSIONS` in
     * `packages/core/src/constants/upload.ts` for the full blocklist.
     * Asset-click-dispatcher surface.
     */
    openAsset(
      relPath: string,
    ): Promise<
      | { ok: true }
      | { ok: false; reason: 'extension-blocked' | 'path-escape' | 'not-found' | 'resolve-error' }
    >;

    /**
     * Reveal an asset in the native file manager (macOS Finder / Windows
     * Explorer / Linux xdg-open → default). Parent-only — does NOT invoke the
     * OS default handler for content. Lower-risk than `openAsset`; the
     * executable blocklist does NOT apply. Asset-click-dispatcher surface.
     */
    revealAsset(
      relPath: string,
    ): Promise<{ ok: true } | { ok: false; reason: 'path-escape' | 'not-found' | 'resolve-error' }>;

    /**
     * Display the native right-click context menu for an on-disk reference
     * (`asset`, `wiki-link`, or `image`). Built from `Menu.buildFromTemplate`
     * in main — the gesture-attested pattern: main observes the click
     * directly; the gesture bit does NOT cross IPC. Entries: Reveal in
     * Finder + Open in default app + Copy link.
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
     * Move a file or folder to the OS Trash via `shell.trashItem`. Step 1 of
     * the sidebar Delete flow's two-step orchestration: trashes the
     * item; on `{ ok: true }` the renderer follows with
     * `POST /api/trash/cleanup` (server-side cleanup). The renderer
     * closes the editor tab AFTER step 1 succeeds, eliminating the
     * fail-forward UX hazard prior designs had.
     *
     * Argument is an ABSOLUTE path (renderer composes via
     * `joinWorkspacePath`). Main wraps with `realpath` + `isPathWithinProject`
     * containment — mirror of `ok:shell:show-item-in-folder` and
     * `ok:shell:spawn-cursor`. Reason union covers macOS edge cases:
     * `permission-denied` (locked / no perms), `not-found` (target gone
     * between probe + click), `system-error` (backend failures incl.
     * OneDrive electron#38541 / tmpfs electron#28045), `path-escape`
     * (containment violation). `detail` carries the OS-provided
     * `error.localizedDescription` so the trash-failure fallback modal can
     * surface it verbatim.
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
     * Forget one entry from the recent-projects list. This only updates the
     * desktop app's persisted launcher state; it never deletes or mutates the
     * project folder on disk.
     */
    removeRecent(path: string): Promise<void>;
    getSessionState(): Promise<ProjectSessionState>;
    setSessionState(state: ProjectSessionState): Promise<void>;
    open(request: {
      path: string;
      target: 'new-window';
      entryPoint: EntryPoint;
      /**
       * Optional kind-discriminated target to deep-link into after the
       * project window mounts. Used by share-receive: Q1 hits and Q2/Q3
       * success both pass the share's target (a `doc` path or a `folder`
       * path) so the editor opens it directly. Threaded through to
       * `wm.createProjectWindow` (cold spawn → `dom-ready` deep-link IPC)
       * and to `sendDeepLink` for the warm-focus path. Mirrors the existing
       * `openknowledge://open?project=&doc=` plumbing.
       */
      pendingDeepLinkTarget?: { kind: 'doc' | 'folder'; path: string };
      /**
       * Optional share branch that rides alongside `pendingDeepLinkTarget`
       * so the renderer's deep-link listener surfaces it via the hash
       * (`?branch=<encoded>`). Receiver-side share flow uses it to detect
       * branch mismatches on Path 2 (has-local-clone). Treat `null` /
       * `undefined` / absent identically (no branch).
       */
      pendingBranch?: string | null;
      /**
       * Optional branch-switch payload for the share-receive "I already have
       * it locally" path. When the located clone is checked out on a
       * different branch than the share, the renderer threads this so main
       * delivers the project-scoped `project-branch-switch` surface (symmetric
       * with the Q1/recents `fallback` path in `url-scheme.ts`) instead of a
       * plain deep-link open on the wrong branch. Carries the share fields, the
       * located project path, and the clone's current HEAD branch (for the
       * dialog's initial label; `ShareBranchSwitchDialog` re-queries before
       * acting). Absent / undefined ⇒ plain open.
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
     * narrows it. Resolves only on success. Failure surfaces as a structured
     * rejection from the IPC handler, not a `{ok:false}` result variant.
     */
    createNew(args: {
      parent: string;
      name: string;
      editors: OkMcpWiringEditorId[];
      /** OK config sharing mode — defaults to 'shared' when omitted. */
      sharing?: 'shared' | 'local-only';
    }): Promise<void>;
    /**
     * Fire-and-forget renderer→main telemetry signal for the Create-new-project
     * dialog. The renderer dedupes per-dialog-open (a banner first-show fires
     * exactly one event; clearing + retyping the same input does NOT refire).
     * Main routes the event into the OnboardingFlow telemetry surface as a
     * discrete counter. Bounded-cardinality: the `banner` argument is a closed
     * literal union.
     */
    recordCreateNewBannerShown(banner: CreateNewBannerKind): Promise<void>;
    /**
     * Probe `<projectPath>/<path>` and classify it against the share
     * target's `kind` — a regular-file hit for `doc`, a directory hit for
     * `folder` — else ENOENT/wrong-type miss, or graceful-fail. Used by the
     * main-side target-existence gate AFTER the branch-name check passes —
     * without this gate, a receiver whose locally checked-out branch matches
     * the share but hasn't fetched the commit that adds the target (typical
     * stale-branch scenario) silently opens a blank editor. Content-root
     * folder shares (empty path) skip this probe at the call site.
     *
     * Q1 runs pre-server; this is the only filesystem read available at
     * that point. Never throws — every input rejection / non-ENOENT I/O
     * error collapses to `'unreadable'` so the caller falls back to
     * silent dispatch the same way `readHeadBranch` does on failure.
     */
    checkTargetExists(request: {
      projectPath: string;
      kind: 'doc' | 'folder';
      path: string;
    }): Promise<CheckTargetExistsResult>;
    /**
     * Read `<projectPath>/.git/HEAD` and classify the result. Pure filesystem
     * read (no git subprocess); returns the all-null sentinel on any failure
     * mode so callers can fall back gracefully. Drives the recent-projects
     * branch label in the Project Navigator.
     */
    readHeadBranch(projectPath: string): Promise<HeadBranchInfo>;
    /**
     * Proxy `GET /api/git/branch-info` against the project's running
     * server. The dispatcher window (Navigator) has no apiOrigin of its
     * own; main reads `<projectPath>/.ok/local/server.lock` to find the
     * port and HTTP-fetches on its behalf. Used by the share-receive
     * branch-switch dialog to render the four-cell state matrix
     * (shareTargetExists × dirtyConflicts) without a second IPC round-trip.
     *
     * Returns `null` on every failure mode (lock unreadable, port dead,
     * fetch error, response doesn't validate). The dialog treats `null`
     * as a load failure and surfaces a generic toast.
     */
    fetchBranchInfo(request: {
      projectPath: string;
      branch: string;
      kind: 'doc' | 'folder';
      path: string;
    }): Promise<BranchInfoResponse | null>;
    /**
     * Proxy `POST /api/git/checkout` against the project's running server.
     * Mirrors `fetchBranchInfo` — main owns the HTTP call because the
     * dispatcher doesn't carry the project's apiOrigin. Server-classified
     * failures (`dirty-conflict`, `branch-not-found`, `fetch-failed`,
     * `checkout-failed`) flow through verbatim so the dialog can map
     * each to its own toast copy.
     *
     * STOP rule: the dialog MUST NOT navigate when this returns
     * `{ok: true}`. The CRDT transition is still in flight at HTTP 200 —
     * navigation waits on the CC1 `branch-switched` signal landing in the
     * project window via `awaitBranchSwitched` (below).
     *
     * `fastForward` (on-origin "Switch and update branch") tells the server to
     * fast-forward the target branch's local ref to origin's tip before the
     * checkout, so a stale receiver lands the switch WITH a recently-pushed
     * doc. On divergence the server refuses and returns `ff-diverged` (nothing
     * mutated) — the receive flow never merges. Omitted = today's plain switch.
     */
    runCheckout(request: {
      projectPath: string;
      branch: string;
      fastForward?: boolean;
    }): Promise<CheckoutResponse | null>;
    /**
     * Proxy `POST /api/share/target-status` for the branch-switch dialog's
     * verdict pivot. When the origin-existence hint from `fetchBranchInfo` is
     * `false`, the dialog asks main to run the fetch-backed verdict (on-origin
     * / renamed / deleted / never-on-branch / unknown) rather than treating the
     * stale hint as a terminal denial.
     *
     * Returns `null` on any transport-level failure; the dialog treats that
     * the same as an `unknown` verdict (today's guidance). A 200 with an
     * unexpected body degrades to `{ verdict: 'unknown' }` via the schema's
     * value-tolerant parse, never a throw.
     */
    fetchTargetStatus(request: {
      projectPath: string;
      branch: string;
      path: string;
      kind: 'doc' | 'folder';
    }): Promise<ShareTargetStatusResponse | null>;
    /**
     * Wait for the project's running server to report `currentBranch === branch`
     * via `GET /api/server-info`. The share-receive branch-switch dialog calls
     * this AFTER `runCheckout` returns `{ok: true}` to gate dialog dismissal
     * on the CC1 `branch-switched` broadcast landing in the project window —
     * server-info is the late-join backstop for that broadcast.
     *
     * STOP rule (one-way door): the dialog MUST NOT navigate on the
     * `runCheckout` HTTP 200 alone; the CRDT transition is still async at
     * that point. This bridge call is the gate that proves the recycle has
     * settled.
     *
     * Discriminated result: `{ok: true}` on match, `{ok: false, reason}` on
     * timeout or project-not-open (server lock never resolved). Never throws.
     * `timeoutMs` is the maximum wall time main will spend polling.
     */
    awaitBranchSwitched(request: {
      projectPath: string;
      branch: string;
      timeoutMs: number;
    }): Promise<{ ok: true } | { ok: false; reason: 'timeout' | 'project-not-open' }>;
    /**
     * Run the share-receive J2 scaffold — initialize `.ok/config.yml`
     * inside a CLI-managed git worktree that was never opened in OK.
     * Mirrors the HTTP route `POST /api/local-op/ok-init`, but main
     * runs it directly because the consent dialog mounts in the
     * Navigator window before any project utility server exists for
     * the candidate path. The Navigator's `apiOrigin === ''`, so a
     * relative `fetch('/api/local-op/ok-init')` would never reach a
     * server — the IPC path is the only working transport.
     *
     * Result shape is `LocalOpOkInitResponse` (`{ok: true, projectPath}`
     * | `{ok: false, reason: 'not-a-git-worktree' | 'init-failed',
     * message}`). Idempotent on already-initialized projects. Never
     * throws.
     */
    okInit(request: { projectPath: string }): Promise<LocalOpOkInitResponse>;
    close(): Promise<void>;
  };

  /**
   * Worktree selector (worktree = window). `list` enumerates the sender
   * window's project's local branches + their worktrees (current window and
   * main worktree flagged); `create` creates or locates the worktree for a
   * branch under `<mainRoot>/.ok/worktrees/` and returns its path. The
   * renderer opens the worktree window via `project.open({ path, target:
   * 'new-window', entryPoint: 'worktree' })` — this surface is git-only.
   * Backed by `ok:worktree:dispatch` (one consolidated channel, discriminated
   * on `kind`, per the `ok:sharing:dispatch` precedent).
   */
  worktree: {
    list(): Promise<WorktreeListResult>;
    create(request: WorktreeCreateRequest): Promise<WorktreeCreateResult>;
  };

  /**
   * OK config sharing mode — per-project sharing-mode posture for
   * the editor's Settings panel. `status` is a pure read invoked on
   * mount; `setMode` toggles via `addOkPathsToGitExclude` /
   * `removeOkPathsFromGitExclude` so the desktop and CLI surfaces cannot
   * drift. The `refused-tracked` branch is surfaced via a modal in the
   * SharingSection component; the `no-exclude` branch surfaces as an
   * inline warning (typically `no-git`).
   */
  sharing: {
    status(): Promise<OkSharingStatusResult>;
    setMode(mode: 'shared' | 'local-only'): Promise<OkSharingSetModeResult>;
  };

  /**
   * Filesystem probes that back the Create-new-project dialog cascade. The
   * find-enclosing-* probes are read-only and mirror the pure helpers in
   * `@inkeep/open-knowledge-server`'s `fs/` module. `removeGitFolder` is the
   * sole destructive method on this surface; it's scope-narrowed to deleting
   * a `.git` directory at a caller-supplied parent (basename + realpath
   * checked main-side so it can't be coerced into a generic `rm -rf`).
   */
  fs: {
    /** Persisted last-used parent directory, or a platform-sensible default
     *  on first launch (`~/Documents/OpenKnowledge/`). */
    defaultProjectsRoot(): Promise<string>;
    /** Classify the candidate path: missing (`free`), present but empty,
     *  or present with entries. Stat errors fall through to `free`. */
    folderState(path: string): Promise<OkFolderState>;
    findEnclosingProjectRoot(path: string): Promise<FindEnclosingProjectRootResult | null>;
    findEnclosingGitRoot(path: string): Promise<FindEnclosingGitRootResult | null>;
    /** Permanently remove `<gitRoot>/.git`. Caller passes the directory
     *  CONTAINING `.git`; main appends `.git` and validates the resolved
     *  basename. Used only by the Create-new-project dialog's confirm-git
     *  banner action after an inline user confirmation step. Idempotent —
     *  succeeds silently if `.git` is already absent (handles the race
     *  where an external delete arrives between the probe and the click). */
    removeGitFolder(gitRoot: string): Promise<void>;
  };

  /**
   * Re-summon the Project Navigator window from inside an editor window.
   * Lifecycle is focus-existing-or-create (idempotent on already-focused).
   * Renderer surfaces: `ProjectSwitcher` dropdown "Switch Project…",
   * CommandPalette "Switch Project", and File → Switch Project… (which
   * calls main's `openNavigator()` directly via the menu binding).
   */
  navigator: {
    open(): Promise<void>;
  };

  seed: {
    /**
     * Compute a scaffold plan for the current window's project (read-only).
     * Options accept `rootDir` (project-relative subfolder) and `packId`
     * (which starter pack to scaffold; defaults to `'knowledge-base'`).
     * Calling with no args plans the default pack at project root —
     * back-compat with the single-scaffold call shape.
     */
    plan(options?: SeedPlanOptions): Promise<OkSeedPlanResult>;
    /**
     * Apply a ScaffoldPlan returned by `plan`. Options accept `packId`
     * (must match the pack `plan` was computed against). Calling with the
     * plan alone applies the default pack — back-compat.
     */
    apply(plan: ScaffoldPlan, options?: SeedApplyOptions): Promise<OkSeedApplyResult>;
    /** Enumerate available starter packs. Static metadata; no project context required. */
    listPacks(): Promise<OkSeedListPacksResult>;
  };

  /**
   * Cowork skill install-dialog hooks. The renderer
   * shows a React dialog explaining the 2-click install; these IPC channels
   * implement the "concierge" actions the dialog takes.
   */
  skill: {
    /**
     * Returns true when Claude Desktop's config directory exists on this
     * machine (macOS ~/Library/Application Support/Claude/ or Windows
     * %APPDATA%/Claude/). False on Linux (unsupported upstream) and absent.
     * Reuses `detectClaudeDesktopPresence` from the server package.
     */
    detectClaudeDesktop(): Promise<boolean>;
    /**
     * Build `openknowledge.skill` from the bundled SKILL.md source, save to
     * the user's Downloads folder, then invoke the OS file association so
     * the Claude Desktop App opens it (via its registered `.skill`
     * CFBundleDocumentType on macOS / registry entry on Windows). Local
     * build: no network, no GitHub Releases.
     *
     * Gated by `~/.ok/skill-state/claude-cowork`: when the recorded version
     * matches the current bundled skill version, resolves with
     * `{ ok: true, skipped: true, version, recordedAt? }` without
     * rebuilding. Pass `force: true` to bypass (reinstall affordance).
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
    /** Invokes `autoUpdater.quitAndInstall()` in main. Triggered by Toast A's "Relaunch now" action. */
    relaunchNow(): Promise<void>;
    /**
     * Force an out-of-cadence `checkForUpdates()` — fires the
     * `ok:update:check-now` IPC. The user-facing result reaches the
     * UI through the existing `onUpdateDownloaded` / toast event
     * subscribers, so this resolves immediately after main fires the
     * request rather than waiting for the network round-trip.
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
    /**
     * Wipe AppState back to defaults and clear any pending schema-
     * incompatibility diagnostic. Pairs with the "Reset and Continue to
     * Stable" button on the refuse-downgrade notice. The reset is a full
     * `emptyState()` clear (recent-projects list and all other AppState
     * fields, not just preferences) because the future build's reshape
     * may have touched any field — partial reset would leave us trusting
     * field shapes we can't verify. Caller gets the user's explicit
     * confirmation before invoking — the renderer surface treats this
     * as destructive.
     */
    resetIncompatible(): Promise<void>;
  };

  /**
   * First-launch MCP consent surface. Renderer mounts `<McpConsentDialog>`
   * when `onShow` fires; calls `confirm` / `skip` on user action; calls
   * `signalReady()` once on app mount so main knows a renderer is subscribed
   * (mount-ack handshake). Available in every Electron host window
   * (Navigator + editor) — first-ack wins.
   */
  mcpWiring: {
    /** Subscribe to the consent-dialog-show event. Returns unsubscribe. */
    onShow(cb: (payload: OkMcpWiringShowPayload) => void): OkUnsubscribe;
    /** Fire a one-way mount-ack event — main's whenRendererReady gate. */
    signalReady(): void;
    /** User clicked Add. `editorIds` is the subset the user checked;
     *  `pathInstall` is the PATH toggle (tri-state — see
     *  `OkMcpWiringConfirmRequest`). */
    confirm(request: OkMcpWiringConfirmRequest): Promise<OkMcpWiringResult>;
    /** User clicked Skip (or pressed ESC). */
    skip(): Promise<OkMcpWiringResult>;
  };

  /**
   * Per-project consent dialog. Navigator-only — editor renderers never
   * receive `ok:onboarding:show`. Renderer mounts a shadcn Dialog when
   * `onShow` fires; calls `confirm` / `cancel` on user action; calls
   * `signalReady()` once on app mount so main knows a renderer is
   * subscribed. `onToast` fires on freshly-spawned editor windows for
   * ancestor- and git-root-promote events. Render via sonner with a 4 s
   * auto-dismiss.
   */
  onboarding: {
    onShow(cb: (payload: OkOnboardingShowPayload) => void): OkUnsubscribe;
    signalReady(): void;
    confirm(request: OkOnboardingConfirmRequest): Promise<OkOnboardingResult>;
    cancel(): Promise<OkOnboardingResult>;
    /** Throttled async probe for the file-count preview line. */
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
   * Pre-project local-op flows. Required by the Project Navigator window,
   * which has no backing API server (apiOrigin is empty). Editor windows
   * use the HTTP path; this surface is unused there.
   */
  localOp: {
    auth: {
      /**
       * Start a GitHub device-flow login subprocess. Returns a stream of
       * events; iteration ends after a terminal `complete` / `error`. Call
       * `cancel()` to abort early.
       */
      start(): OkLocalOpStream<OkLocalOpAuthEvent>;
    };
    clone: {
      /**
       * Spawn `ok clone` for the given URL + target dir. Returns a stream
       * of events; iteration ends after a terminal `complete` / `error`.
       * The `complete` event carries `dir` (no `port`) — Electron main
       * spawns a new editor window directly at that path.
       *
       * Optional `branch` runs `ok clone -b <branch>`; the CLI retries
       * against the remote default branch + emits a non-terminal
       * `branch-fallback` event when the ref is gone upstream. Treat
       * `null` / `undefined` / absent identically (legacy
       * default-branch clone). Slashed names (`feat/foo`) flow verbatim.
       */
      start(request: {
        url: string;
        dir: string;
        branch?: string | null;
      }): OkLocalOpStream<OkLocalOpCloneEvent>;
    };
    /**
     * One-shot auth queries. Bounded responses (status: one line; repos:
     * bounded list) so no streaming surface needed. Used by Navigator in
     * place of the HTTP `/api/local-op/auth/{status,repos}` endpoints.
     */
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
   * `useDocumentContext()` — the same signal the EditorHeader sparkle icon
   * uses to pick its dispatch helper. Main listens to rebuild the macOS
   * File menu's state-aware enable/disable for items like Rename / Move
   * to Trash / Open with AI. Fire-and-forget: the preload implementation
   * invokes the channel and swallows rejections, mirroring
   * `signalThemeApplied`'s pattern — a missing handler during window
   * teardown is expected, not a programmer error.
   */
  editor: {
    notifyActiveTargetChanged(target: OkEditorActiveTargetSnapshot): void;
    /**
     * Fire-and-forget push of the sidebar's view-menu-relevant state. Main
     * stores the latest snapshot and rebuilds the application menu so the
     * View menu's "Show Hidden Files" check mark reflects the
     * merged-config CRDT value, and "Expand All" / "Collapse All" smart-hide
     * when the tree is fully expanded / collapsed. Last-write-wins across
     * windows — matches the active-target singleton model.
     */
    notifyViewMenuStateChanged(state: Partial<OkEditorViewMenuStateSnapshot>): void;
  };

  /**
   * Startup-instrumentation push surface (desktop launch waterfall). The
   * renderer reports its two launch checkpoints — page-list ready and first
   * content — as epoch-ms `Date.now()` values, once both have landed. Main
   * folds them into the single `desktop.startup-timeline` log line and (when
   * OTel is enabled) the `ok.app-startup` renderer child span. Fire-and-forget,
   * idempotent on the renderer side (sent once per launch). No-op for non-Electron
   * hosts (the bridge is absent on the web build).
   */
  startup: {
    reportMarks(marks: { pageListReadyMs: number; firstContentMs: number }): void;
  };

  /**
   * Sidebar tree-state push subscriptions. Main pushes
   * `ok:sidebar:expand-all` / `ok:sidebar:collapse-all` when the user picks
   * View → Expand All / Collapse All. Renderer subscribes via the returned
   * unsubscribe pattern (mirrors `onProjectSwitched` / `onMenuAction`).
   * Tree-scoped — main smart-hides the menu items when the tree state
   * doesn't warrant the action; the bridge just delivers the signal.
   * No payload — the channel itself IS the directive.
   */
  sidebar: {
    expandAll(cb: () => void): OkUnsubscribe;
    collapseAll(cb: () => void): OkUnsubscribe;
  };

  /**
   * Bottom-docked terminal panel surface. The renderer creates one PTY per
   * window, streams shell output in via `onData`, sends keystrokes out via
   * `input`, resizes on fit, and kills on teardown; main mediates to a
   * window-bound utilityProcess hosting node-pty. `onData` / `onExit` follow
   * the `onMenuAction` subscription shape (the returned closure detaches the
   * wrapped listener). `input` / `resize` / `drain` are fire-and-forget;
   * `create` / `kill` resolve.
   *
   * `drain` is the renderer's backpressure ack: after xterm writes a data
   * batch it reports the consumed byte count so main can resume a PTY it
   * paused once in-flight bytes fall back under the low-water mark. Without
   * it a flood (`yes`, a large `cat`) grows unbounded in-flight bytes and
   * starves the renderer.
   *
   * Structurally mirrored verbatim in the core + app bridge copies (drift-tested).
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
    /**
     * Reload-rehydration inventory: the live ptyIds for this window. A reloaded
     * dock queries this on mount to rediscover the shells that survived in main
     * (the PTY host outlives a renderer reload), then adopts each rather than
     * spawning fresh ones. Empty for a window with no surviving sessions.
     */
    list(): Promise<OkPtyListEntry[]>;
    /**
     * Re-bind a surviving session to this (reloaded) renderer: main refreshes
     * the session's delivery target, clears the backpressure the dead page left
     * stranded, and resumes the host. Resolves `unknown-session` when the shell
     * exited in the gap since `list`, so the caller spawns a fresh shell instead.
     */
    adopt(ptyId: string): Promise<OkPtyAdoptResult>;
    /**
     * Per-window dock visibility retained in main, read once on reload so the
     * dock re-expands when it was open before the reload (and stays hidden after
     * a fresh launch where no sessions survived).
     */
    getDockState(): Promise<{ visible: boolean }>;
    onData(cb: (msg: OkPtyData) => void): OkUnsubscribe;
    onExit(cb: (msg: OkPtyExit) => void): OkUnsubscribe;
    /**
     * Claude Code readiness probe. Resolves whether `claude` is on the
     * login-shell PATH and whether the `open-knowledge` MCP server is wired
     * into `~/.claude.json`. Bounded + side-effect-free — runs a fixed
     * `command -v claude` and reads the config; no renderer-supplied command.
     */
    claudePreflight(): Promise<ClaudeReadiness>;
    /**
     * On-PATH readiness probe for a non-Claude agent CLI (codex / cursor).
     * Resolves whether the CLI's binary (`codex` / `cursor-agent`) is on the
     * login-shell PATH. Bounded + side-effect-free — runs a fixed
     * `command -v <bin>` for the registry binary; no renderer-supplied command.
     * Drives the "Open in terminal" launch gate + the missing-CLI banner the
     * same way `claudePreflight` does for Claude.
     */
    cliPreflight(cli: TerminalCli): Promise<CliReadiness>;
    /**
     * Batched on-PATH readiness for every launchable CLI, collapsed to a plain
     * installed map (`true` ⇒ the CLI's registry binary resolves on the
     * login-shell PATH). Powers the New-chat default-CLI auto-pick, which needs a
     * single "which CLIs can I launch?" answer rather than one `cliPreflight` per
     * CLI. Bounded + side-effect-free — a fixed `command -v <bin>` per registry
     * binary, no renderer-supplied command. Cached in main (~60s) so repeated
     * New-chat clicks don't re-probe the login shell each time.
     */
    cliInstalledMap(): Promise<Record<TerminalCli, boolean>>;
    /**
     * Re-arm MCP wiring when `claudePreflight` reports `mcp: 'needs-rewire'`:
     * shows the consent dialog (the same forceShow path as File → Set up
     * OpenKnowledge integrations) so the user can wire `open-knowledge` into Claude
     * Code. Returns the still-current readiness (the grant lands once the user
     * completes the dialog). Human-only — never agent-callable.
     */
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
   * Debug-only namespace — populated by preload ONLY when
   * `process.env.OK_DEBUG_KEYRING_SMOKE === '1'` OR
   * `app.isPackaged === false`. Absent in normal production runs, so a typo
   * in renderer code calling a non-existent method surfaces at TypeScript
   * compile time.
   */
  debug?: {
    /**
     * Run the utility-process keyring smoke and return the result. Rejects
     * with 'debug-channel disabled in production' when the runtime gate is
     * closed (app packaged + env var unset).
     */
    keyringSmoke(): Promise<KeyringSmokeResult>;
  };
}

declare global {
  interface Window {
    /** Populated by the desktop preload script. Absent in web / CLI distribution. */
    okDesktop?: OkDesktopBridge;
  }
}
