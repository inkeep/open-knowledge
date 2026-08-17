import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { Principal } from '@inkeep/open-knowledge-core';
import {
  mediaKindForSidebarAssetExtension,
  PrincipalSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { createContext, type ReactNode, use, useEffect, useRef, useState } from 'react';
import type { ResolvedNavigationTarget } from '@/components/navigation-targets';
import { docNameForNavigationTarget, isSkillFocusedTarget } from '@/components/navigation-targets';
import { consumePrewarmClick } from '@/components/prewarm-correlation';
import {
  assetPathFromHash,
  docNameFromHash,
  hashFromAssetPath,
  hashFromDocName,
  hashFromFolderPath,
  hashFromSkillFile,
  hashFromSkillPreview,
  hashFromSkills,
  isSameHash,
  skillFileFromHash,
  skillPreviewFromHash,
} from '@/lib/doc-hash';
import { emitBranchChanged, emitDocumentsChanged } from '@/lib/documents-events';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';
import { markNoteWindowDocDeleted } from '@/lib/note-window-deleted-store';
import { isNoteWindow } from '@/lib/note-window-mode';
import { mark } from '@/lib/perf';
import { refreshServerInfo } from '@/lib/server-info-refresh';
import { showTabSessionRestoreRecoveryNotice } from '@/lib/tab-session-restore-recovery-notice';
import {
  resetTabSessionRestoreSuppression,
  shouldSuppressTabSessionRestore,
} from '@/lib/tab-session-restore-suppression';
import { useCollabUrl } from '@/lib/use-collab-url';
import { getEditorForDoc } from './active-editor';
import { handleBranchSwitched } from './branch-invalidation';
import {
  type ClientRemovalReconciler,
  createClientRemovalReconciler,
  type LocalRemovalReconciliation,
  type LocalRenameReconciliation,
} from './client-removal-reconciliation';
import { captureRenameSnapshots, subscribePoolEviction } from './editor-cache';
import {
  type EditorPaneId,
  type EditorPaneState,
  type EditorWorkspaceState,
  type ExistingTabOpenBehavior,
  findPaneOwningTab,
  flattenWorkspacePinnedTabs,
  flattenWorkspaceTabs,
  focusEditorPane,
  focusedPane,
  hydrateEditorWorkspace,
  normalizeEditorWorkspace,
  type PaneSide,
  projectVisibleEditorWorkspace,
  type RecentlyClosedEditorTab,
  recordRecentlyClosedTab,
  type TabOpenDisposition,
  tabBucketIndexForVisibleInsertion,
  transitionEditorWorkspace,
  updateEditorPane,
} from './editor-panes';
import {
  assetTabId,
  createEditorTabSessionState,
  docNameForTabId,
  docTabId,
  filterClosableTabIds,
  filterOpenTabsForKnownTargets,
  folderTabId,
  isSkillTabId,
  localTabSessionKeyForMode,
  parseEditorTabId,
  parseEditorTabSessionState,
  readLocalTabSessionState,
  reconcileVisibleTabOrder,
  remapOpenTabs,
  remapVisibleTabsForRename,
  shouldPersistTabSession,
  skillFileTabId,
  skillPreviewTabId,
  type TabSessionRestoreOutcome,
  tabIdForNavigationTarget,
  writeLocalTabSessionState,
} from './editor-tabs';
import { subscribePreviewTabPromotion } from './preview-tab-promotion';
import {
  MAX_POOL,
  ProviderPool,
  type ServerRestartRecoveryState,
  type SyncState,
} from './provider-pool';
import { __rejectSyncPromise, __test_armPendingRejection } from './sync-promise';
import { tabSessionId } from './tab-identity';

/**
 * Read-only projection of a `PoolEntry` — exposes the fields downstream React
 * components need without leaking the mutable pool internals (`kind`
 * discriminator, `persistence`, `observerCleanup`, `pendingRecycleTimer`).
 * Sorted by `lastAccessedAt` descending so consumers like `EditorActivityPool`
 * can apply LRU bounding without re-sorting.
 */
export interface PoolEntrySnapshot {
  docName: string;
  provider: HocuspocusProvider;
  lastAccessedAt: number;
  /**
   * Cross-namespace correlation seed minted at fresh-construct time by
   * `ProviderPool.open()`. Adopted as `mountId` by the activity-pool's
   * promote-to-mount-list transition so prewarm → mount → cache / sync
   * / cold marks share one deterministic ID.
   */
  poolEventId: string;
}

interface DocumentContextValue {
  /**
   * The resolved principal from `/api/principal`. Null while the fetch is in
   * flight or if it failed/was absent. Consumers use this to prefer real
   * git-config identity over the random animal-adjective fallback in awareness.
   */
  principal: Principal | null;
  activeTarget: ResolvedNavigationTarget | null;
  activeTabId: string | null;
  activeDocName: string | null;
  activeProvider: HocuspocusProvider | null;
  /** Canonical side-by-side editor workspace. Flat tab fields below are compatibility projections. */
  workspace: EditorWorkspaceState;
  panes: ReadonlyArray<EditorPaneState>;
  focusedPaneId: EditorPaneId;
  focusPane: (paneId: EditorPaneId) => void;
  activateTabInPane: (paneId: EditorPaneId, tabId: string) => void;
  activateNewTabInPane: (paneId: EditorPaneId, tabId: string) => void;
  openNewTabInPane: (paneId: EditorPaneId) => void;
  closeTabInPane: (paneId: EditorPaneId, tabId: string) => void;
  closeTabsInPane: (
    paneId: EditorPaneId,
    tabIds: readonly string[],
    options?: CloseTabsOptions,
  ) => void;
  closeNewTabInPane: (paneId: EditorPaneId, tabId: string) => void;
  pinTabInPane: (paneId: EditorPaneId, tabId: string) => void;
  unpinTabInPane: (paneId: EditorPaneId, tabId: string) => void;
  reorderTabsInPane: (
    paneId: EditorPaneId,
    newOrder: readonly string[],
    draggedTabId: string,
  ) => void;
  moveTabToPane: (tabId: string, targetPaneId: EditorPaneId, targetIndex: number) => void;
  splitTab: (tabId: string, targetPaneId: EditorPaneId, side: PaneSide) => EditorPaneId | null;
  moveTabToNewPane: (tabId: string, side: PaneSide) => EditorPaneId | null;
  resizePanes: (sizesByPane: ReadonlyMap<EditorPaneId, number>) => void;
  /**
   * User-open tabs, distinct from `poolEntries`: prewarmed providers can be
   * pool-resident without becoming visible tabs. Document tabs use the
   * docName as their ID; folder and asset tabs use internal tab IDs.
   * Compatibility projection; pane-aware code should use `panes[].openTabs`.
   */
  openTabs: ReadonlyArray<string>;
  /**
   * Tab IDs protected from tab-strip close affordances until explicitly unpinned.
   * Compatibility projection; pane-aware code should use `panes[].pinnedTabIds`.
   */
  pinnedTabIds: ReadonlyArray<string>;
  /** Visible tab-strip order keyed by pane. */
  visibleTabIdsByPane: ReadonlyMap<EditorPaneId, ReadonlyArray<string>>;
  previewTabIdsByPane: ReadonlyMap<EditorPaneId, string | null>;
  /**
   * Visible tab-strip order across document/folder tabs and ephemeral blank tabs.
   * Compatibility projection; pane-aware code should use `visibleTabIdsByPane`.
   */
  visibleTabIds: ReadonlyArray<string>;
  /** True once persisted tab session restore has either applied or intentionally skipped. */
  tabSessionLoaded: boolean;
  syncState: SyncState;
  serverRestartRecovery: ServerRestartRecoveryState;
  /**
   * All currently-pooled docs, sorted by `lastAccessedAt` descending (MRU first).
   * Drives `EditorActivityPool`'s ACTIVITY_MOUNT_LIMIT-bounded Activity rendering.
   * System docs (CC1 `__system__`) are filtered at pool admission so they never
   * appear here.
   */
  poolEntries: ReadonlyArray<PoolEntrySnapshot>;
  openDocument: (docName: string) => void;
  /**
   * Navigation entry — kept for API symmetry with `openTargetTransition`.
   * Not wrapped in `startTransition`: deferring shell state
   * (`activeDocName`, `activeTarget`) would make the sidebar highlight and
   * header title lag the click. React's default Suspense behavior already
   * handles both paths: cold nav suspends → `<EditorSkeleton />` fallback
   * paints immediately; warm nav doesn't suspend (`syncPromise` is
   * pre-resolved for `hasSynced=true` providers) so the commit lands in a
   * single synchronous paint. The name is preserved to keep the migration
   * path to a future per-subtree transition open — callers shouldn't need
   * to choose between transition and non-transition APIs.
   */
  openDocumentTransition: (docName: string) => void;
  /**
   * Set the active navigation target (doc / folder-index / folder / asset / missing)
   * per the folder-aware resolver. For a `doc` target
   * this opens/activates the pooled provider; for `folder` it clears the
   * active doc so `EditorArea` renders `<FolderOverview>`; for `missing` it
   * sets the new-doc intent and opens the pooled provider.
   */
  openTarget: (target: ResolvedNavigationTarget, options?: OpenTargetOptions) => void;
  /** Open a target in a specific pane, moving an existing tab there when necessary. */
  openTargetInPane: (
    paneId: EditorPaneId,
    target: ResolvedNavigationTarget,
    options?: OpenTargetOptions,
  ) => void;
  /**
   * Hash-driven navigation entry (`NavigationHandler` in `App.tsx`). Kept
   * alongside `openTarget` for API symmetry with `openDocumentTransition`.
   * Neither wraps the underlying call in `startTransition`; see
   * `openDocumentTransition` for rationale. `openTarget` is retained for
   * non-transition callers (tests, direct agent actions).
   */
  openTargetTransition: (target: ResolvedNavigationTarget, options?: OpenTargetOptions) => void;
  promoteTabInPane: (paneId: EditorPaneId, tabId: string) => void;
  promoteAllPreviewTabs: () => void;
  clearTarget: () => void;
  closeDocument: (docName: string) => void;
  /** Close the active tab if one exists; returns false when the window should close instead. */
  closeActiveTabOrWindow: () => boolean;
  /** Close a visible tab and navigate to the nearest remaining tab when needed. */
  closeTab: (tabId: string) => void;
  /** Mark a visible tab as pinned so tab-strip close actions skip it. */
  pinTab: (tabId: string) => void;
  /** Remove pin protection from a visible tab. */
  unpinTab: (tabId: string) => void;
  /** Activate a visible tab even when it points at the same document as another tab. */
  activateTab: (tabId: string) => void;
  /**
   * Reorder visible tabs after a drag. `newOrder` is the desired post-drag
   * order (real openTabs and new-tab placeholders, as visibleTabIds is
   * rendered); `draggedTabId` is the tab the user moved. Pin state is
   * drag-mutable: only the dragged tab's pin status can flip, and only if it
   * crossed the pinned/unpinned divide (a pinned tab dragged past every other
   * pinned tab unpins; an unpinned tab dragged into the pinned extent pins).
   * Every other tab keeps its pin state, so pinned and unpinned tabs still
   * interleave freely (no enforced visual pin-section boundary). pinTab/
   * unpinTab remain the explicit toggles. Persistence is automatic via the
   * existing effect watching workspace.
   */
  reorderTabs: (newOrder: readonly string[], draggedTabId: string) => void;
  /** Empty tab placeholders created by the tab strip's New tab button. */
  newTabIds: ReadonlyArray<string>;
  /** The currently active empty tab placeholder, if any. */
  activeNewTabId: string | null;
  /** True when the active editor surface is the empty "New tab" placeholder. */
  isNewTabActive: boolean;
  /**
   * Explicit Files/Skills surface pin. `null` = autofollow the active doc's
   * surface (the default); `true`/`false` = an explicit toggle. The pin only
   * survives until the next navigation, when pane activation re-arms it to
   * `null`, so autofollow keeps working after a toggle. Not persisted. Prefer
   * reading `skillFocused` (the resolved surface); this is the raw override.
   */
  skillsSidebar: boolean | null;
  setSkillsSidebar: (on: boolean | null) => void;
  /**
   * The resolved active surface: `skillsSidebar ?? (active doc/new-tab is a
   * skill)`. Drives BOTH the sidebar navigator and the editor tab-strip mode
   * filter, so the two never disagree. `true` = Skills, `false` = Files.
   */
  skillFocused: boolean;
  /** Open an empty tab placeholder that the next sidebar document click can fill. */
  openNewTab: () => void;
  /** Focus the blob-runner tab, opening one if it is not already around. */
  openBlobRunner: () => void;
  /** Activate an existing empty tab placeholder. */
  activateNewTab: (tabId: string) => void;
  /** Close the empty tab placeholder and return to the nearest document tab. */
  closeNewTab: (tabId: string) => void;
  /** Reopen the most recently closed editor tab, if any. */
  reopenClosedTab: () => void;
  /**
   * Close multiple visible tabs with a single active-tab/navigation decision.
   * Pinned tabs are skipped unless `force` is set for backing file/folder removal.
   */
  closeTabs: (tabIds: readonly string[], options?: CloseTabsOptions) => void;
  /** Drop tabs whose backing file/folder no longer exists in the refreshed tree. */
  syncOpenTabsWithKnownTargets: (targets: {
    pages: ReadonlySet<string>;
    folderPaths: ReadonlySet<string>;
    assetPaths: ReadonlySet<string>;
    filePaths?: ReadonlySet<string>;
  }) => void;
  /** Reconcile provider, persistence, and tab state for a local rename. The caller navigates. */
  reconcileLocalRename: (input: LocalRenameReconciliation) => Promise<void>;
  /** Reconcile forced tab closure and persistence removal after a local delete. */
  reconcileLocalRemoval: (input: LocalRemovalReconciliation) => Promise<void>;
  /**
   * Destroy and recreate the pool entry for `docName` while preserving
   * `activeDocName`. Used by the "Try again" path in `DocumentErrorBoundary`
   * to recover from `BridgeSetupError` (and any other sync failure where the
   * existing provider is in a known-broken state) without flashing the
   * "Select a document" empty state during the swap.
   */
  recycleDocument: (docName: string) => void;
  /**
   * Prewarm a doc's provider before the user clicks. Returns the
   * `poolEventId` of the resulting pool entry on success (so the
   * sidebar-hover layer can correlate prewarm-then-click hit/miss
   * deterministically), or `null` when the prewarm is rejected
   * (system doc, missing collab URL).
   */
  prewarm: (docName: string) => string | null;
  /**
   * The `__system__` HocuspocusProvider, lifted from `SystemDocSubscriber`
   * so presence-bar consumers (`usePresence`) can read agent presence from
   * `__system__.awareness` without re-materializing a second provider.
   * `null` while the subscriber is mounting or between collabUrl resets.
   * Set via `setSystemProvider` — do NOT assign directly.
   */
  systemProvider: HocuspocusProvider | null;
  /**
   * Provider-registration callback used by `SystemDocSubscriber` to publish
   * its `__system__` provider (and null on unmount). Single-writer by
   * convention — only one SystemDocSubscriber should mount at a time.
   */
  setSystemProvider: (provider: HocuspocusProvider | null) => void;
  /**
   * Update the pool's cached server instance ID. Called by
   * `SystemDocSubscriber` on every `__system__` CC1 `server-info` broadcast
   * so the pool's next provider-open claim matches the live server. Null
   * clears the claim (used by the auth-failure recycle path).
   */
  updateServerInstanceId: (id: string | null) => void;
  /**
   * Invalidate every open provider's IndexedDB persistence and recycle
   * the providers. Called by `SystemDocSubscriber` on every `__system__`
   * CC1 `branch-switched` broadcast so the client discards content
   * authored against the previous branch and re-syncs from the
   * markdown-rebuilt post-switch state. Delegates to
   * `handleBranchSwitched` in `branch-invalidation.ts`.
   */
  onBranchSwitched: (branch: string) => Promise<void>;
  /**
   * Late-join backstop for CC1 `branch-switched`. Called whenever a
   * channel reports the current branch (boot HTTP `/api/server-info`
   * fetch + every CC1 `server-info` frame on `__system__` connect /
   * reconnect). First call seeds the observed value; subsequent
   * mismatches replay `handleBranchSwitched` client-side, covering the
   * window where the live broadcast was missed.
   */
  observeBranch: (branch: string) => Promise<void>;
  /**
   * Dispatcher for CC1 `disk-ack` payloads — advances the per-entry
   * `lastDiskAckedSV` watermark. `handleServerInstanceMismatch` reads
   * this watermark when computing the recycle buffer baseline so the
   * client only re-replays updates the server has NOT yet durably
   * persisted. Called by `SystemDocSubscriber` for every recognized
   * `disk-ack` frame.
   */
  observeDiskAck: (docName: string, sv: Uint8Array) => void;
  /**
   * Re-fetch `/api/server-info` and dispatch every recognized field
   * (instanceId, branch, disk-ack watermarks). Called by
   * `SystemDocSubscriber` on every `__system__` reconnect to recover
   * from missed CC1 stateless broadcasts (which have no replay).
   * Boot path uses the same helper for consistency. Idempotent —
   * each dispatcher no-ops on unchanged inputs, so a redundant call
   * costs only one HTTP round-trip.
   */
  refreshServerInfo: () => Promise<void>;
  /**
   * Resolved collab WebSocket URL (from `/api/config` or `bun run dev`
   * same-origin fallback). Null while the initial fetch is in flight or
   * while `server.lock` is absent — consumers that also need the URL
   * (e.g. `SystemDocSubscriber`) skip wiring until resolved.
   */
  collabUrl: string | null;
  /**
   * True when the `/api/config` resolver has given up automatic retries
   * (no resolution within ~30s). Consumer banners surface an actionable
   * error message + manual-retry button. `retryCollab()` resets to
   * auto-retry mode.
   */
  collabTerminal: boolean;
  /** Observed last-error shape (only populated when `collabTerminal`). */
  collabLastError:
    | { kind: 'error'; code: number | 'network' | 'invalid-body' }
    | { kind: 'null-collab' }
    | null;
  /** Reset retry state — exits terminal mode, resumes polling. */
  retryCollab: () => void;
  /**
   * DocPanel mode — which scope the right-rail panel is showing.
   *   - `'doc'`:   existing 5-tab info pane keyed to `activeDocName`.
   *   - `'agent'`: Activity view keyed to `docPanelAgentId` (one agent session).
   *
   * Default is `'doc'` on every fresh tab. Tab-scoped state (not persisted).
   */
  docPanelMode: 'doc' | 'agent';
  /**
   * connectionId of the agent the panel is scoped to when in `'agent'` mode.
   * Preserved across mode flips — flipping `agent → doc → agent` still
   * shows the prior agent scope. Cleared only by explicit
   * `closeActivityPanel()` or swap to a different agent.
   */
  docPanelAgentId: string | null;
  /**
   * Monotonic expand-request counter. `openActivityPanel` increments this
   * in the same setState pass that flips `docPanelMode`. `EditorArea`
   * observes the counter via `useEffect` and calls `panel.expand()` (desktop)
   * or `setSheetOpen(true)` (mobile) on each increment — idempotent if the
   * panel is already visible.
   */
  docPanelExpandSignal: number;
  /**
   * Open (or swap, or toggle off) the DocPanel's agent mode:
   *   - Panel is doc mode, or agent mode with a different agent → flip to
   *     agent mode, scope to this connectionId, increment expand signal.
   *   - Panel is agent mode with this SAME connectionId → flip back to doc
   *     mode. Agent id is preserved so flipping back via the mode toggle
   *     resumes the same session (toggle semantics).
   *
   * Method name preserved so the `PresenceBar` call site does
   * not change. The hook `useActivityPanel` resets burst-cache and expand
   * state on connectionId change, so swap semantics fall out naturally.
   *
   * `targetDoc` is the document the agent is editing (the caller's
   * already-sentinel-filtered `realCurrentDoc`). It is consulted ONLY when no
   * document is currently selected — the DocPanel can't mount without an
   * active doc, so the panel open would otherwise be a silent no-op. In that
   * case we navigate to `targetDoc` first, which mounts the DocPanel, then the
   * mode flip + expand land on the freshly-mounted panel. When a doc is
   * already active the argument is ignored (cross-doc avatars keep opening the
   * agent's Activity view in the current panel, filename-nav stays inside it).
   */
  openActivityPanel: (connectionId: string, targetDoc: string | null) => void;
  /** Explicit "show the doc info again" affordance. Clears agent id too. */
  closeActivityPanel: () => void;
}

export interface OpenTargetOptions {
  disposition?: TabOpenDisposition;
  consumeActiveNewTab?: boolean;
  /** Compatibility policy used by sidebar callers and the preview-tabs setting. */
  tabBehavior?: 'append' | 'replace-active';
}

interface CloseTabsOptions {
  force?: boolean;
}

let principalFetchWarned = false;
function warnPrincipalFetchOnce(err: unknown): void {
  if (principalFetchWarned) return;
  principalFetchWarned = true;
  console.warn(
    '[principal-fetch] failed to resolve principal — falling back to random identity.',
    err,
  );
}

const DocumentContext = createContext<DocumentContextValue | null>(null);
const MARKDOWN_EXTENSION_QUALIFIED_DOC_PATTERN = /\.(md|mdx)$/i;

// Module-level singleton — survives React re-renders and StrictMode double-mount.
// Same pattern the old singleton HocuspocusProvider used. Instantiated lazily
// when `collabUrl` resolves — not at module load.
//
// Under Vite HMR the binding resets on module reload; the `import.meta.hot.dispose`
// handler at the bottom of this file disposes the previous pool before the new
// module instance takes over so WebSocket / observer / timer state doesn't leak.
let pool: ProviderPool | null = null;

export function getPool(collabUrl: string): ProviderPool {
  if (!pool) {
    pool = new ProviderPool(MAX_POOL, collabUrl);
    // Wire the editor cache to the pool's eviction events. Without this
    // subscription, cached `Editor` / `EditorView` instances would
    // outlive the Y.Doc they're bound to. Single subscription per pool
    // lifetime; the unsubscribe handle is intentionally dropped — the
    // pool is a module-level singleton and only torn down on HMR/dispose,
    // at which point its listener Set is GC'd along with the pool.
    subscribePoolEviction(pool);
  }
  return pool;
}

interface Snapshot {
  activeDocName: string | null;
  activeProvider: HocuspocusProvider | null;
  syncState: SyncState;
  serverRestartRecovery: ServerRestartRecoveryState;
  poolEntries: ReadonlyArray<PoolEntrySnapshot>;
}

const EMPTY_SNAPSHOT: Snapshot = {
  activeDocName: null,
  activeProvider: null,
  syncState: 'connecting',
  serverRestartRecovery: { kind: 'idle' },
  poolEntries: [],
};

function getDesktopBridge() {
  if (typeof window === 'undefined') return null;
  const bridge = window.okDesktop;
  if (bridge?.config.mode !== 'editor') return null;
  return bridge;
}

function getLocalTabSessionKey(): string | null {
  if (typeof window === 'undefined') return null;
  return localTabSessionKeyForMode(window.okDesktop?.config.mode, window.location.origin);
}

function readInitialLocalTabSession() {
  if (typeof window === 'undefined') return parseEditorTabSessionState(null);
  const key = getLocalTabSessionKey();
  if (!key) return parseEditorTabSessionState(null);
  const storage = typeof window.localStorage !== 'undefined' ? window.localStorage : null;
  return readLocalTabSessionState(storage, key);
}

// New tabs are ephemeral placeholders (never persisted) keyed only by identity,
// so their id doubles as the surface tag: a skills-mode new tab carries the
// `skills:` infix, and its empty state renders the Skills home instead of the
// Files "Create something great" one.
const NEW_TAB_PREFIX = 'new-tab:';
const SKILLS_NEW_TAB_PREFIX = 'new-tab:skills:';
export function isSkillsNewTabId(id: string | null | undefined): boolean {
  return id?.startsWith(SKILLS_NEW_TAB_PREFIX) ?? false;
}

// The blob runner is a full-pane surface with no document behind it, so it
// rides the same ephemeral new-tab placeholder the Skills home uses rather
// than a standing tab id. Deliberately NOT a persisted tab kind: a game has no
// state worth restoring across reloads, and the standing-singleton pattern was
// retired from this codebase (see SKILLS_HUB_TAB_ID in editor-tabs.ts).
const BLOB_RUNNER_NEW_TAB_PREFIX = 'new-tab:blob-runner:';

/**
 * Which full-pane surface a new-tab placeholder stands for. `NEW_TAB_PREFIX` is
 * a literal prefix of the other two, so classification MUST test the specific
 * surfaces first — a plain `startsWith(NEW_TAB_PREFIX)` matches all three.
 */
export type NewTabSurface = 'files' | 'skills' | 'blob-runner';

const NEW_TAB_PREFIX_BY_SURFACE: Record<NewTabSurface, string> = {
  files: NEW_TAB_PREFIX,
  skills: SKILLS_NEW_TAB_PREFIX,
  'blob-runner': BLOB_RUNNER_NEW_TAB_PREFIX,
};

function newTabSurfaceOf(tabId: string): NewTabSurface {
  if (isBlobRunnerNewTabId(tabId)) return 'blob-runner';
  if (isSkillsNewTabId(tabId)) return 'skills';
  return 'files';
}
export function isBlobRunnerNewTabId(id: string | null | undefined): boolean {
  return id?.startsWith(BLOB_RUNNER_NEW_TAB_PREFIX) ?? false;
}

/**
 * Which surface a visible tab id belongs to (Skills vs Files) — covers both real
 * open tabs (`isSkillTabId`) and ephemeral new-tab placeholders (`isSkillsNewTabId`).
 * Drives the mode filter that shows one surface's tabs at a time.
 */
function tabIdIsSkillSurface(id: string): boolean {
  return isSkillsNewTabId(id) || isSkillTabId(id);
}
function hashFromTabId(tabId: string): string {
  const tab = parseEditorTabId(tabId);
  switch (tab.kind) {
    case 'doc':
      return hashFromDocName(tab.docName);
    case 'folder':
      return hashFromFolderPath(tab.folderPath);
    case 'asset':
      return hashFromAssetPath(tab.assetPath);
    case 'skill-file':
      return hashFromSkillFile({ scope: tab.scope, name: tab.name, path: tab.path });
    case 'skill-preview':
      return hashFromSkillPreview({
        flavor: tab.flavor,
        source: tab.source,
        name: tab.name,
        subtitle: tab.subtitle,
      });
  }
}

function navigateToHash(nextHash: string): void {
  if (typeof window !== 'undefined' && !isSameHash(window.location.hash, nextHash)) {
    window.location.hash = nextHash;
  }
}

function requireRemovalReconciler(
  reconciler: ClientRemovalReconciler | null,
): ClientRemovalReconciler {
  if (!reconciler) throw new Error('removal reconciler is not initialized');
  return reconciler;
}

function resolvedTargetForTabId(tabId: string): ResolvedNavigationTarget {
  const tab = parseEditorTabId(tabId);
  switch (tab.kind) {
    case 'doc':
      return { kind: 'doc', target: tab.docName, docName: tab.docName };
    case 'folder':
      return { kind: 'folder', target: tab.folderPath, folderPath: tab.folderPath };
    case 'asset':
      return assetTargetForPath(tab.assetPath);
    case 'skill-file':
      return {
        kind: 'skill-file',
        target: `${tab.scope}/${tab.name}${tab.host ? `:${tab.host}` : ''}/${tab.path}`,
        scope: tab.scope,
        name: tab.name,
        path: tab.path,
        ...(tab.host ? { host: tab.host } : {}),
      };
    case 'skill-preview':
      return {
        kind: 'skill-preview',
        target: `${tab.flavor}/${tab.source}/${tab.name}`,
        flavor: tab.flavor,
        source: tab.source,
        name: tab.name,
        subtitle: tab.subtitle,
        level: tab.level,
      };
  }
}

function paneWithResolvedTarget(pane: EditorPaneState): EditorPaneState {
  if (pane.activeNewTabId !== null || pane.activeTabId === null) {
    return pane.activeTarget === null ? pane : { ...pane, activeTarget: null };
  }
  const currentTargetTabId = pane.activeTarget ? tabIdForNavigationTarget(pane.activeTarget) : null;
  if (currentTargetTabId === pane.activeTabId) {
    return pane;
  }
  return { ...pane, activeTarget: resolvedTargetForTabId(pane.activeTabId) };
}

function workspaceWithResolvedTargets(workspace: EditorWorkspaceState): EditorWorkspaceState {
  return {
    ...workspace,
    panes: workspace.panes.map(paneWithResolvedTarget),
  };
}

function readInitialEditorWorkspace(): EditorWorkspaceState {
  // Only PEEKS the suppression latch — the async restore effect is the single
  // owner that resets it, so this initializer (which renders first) and that
  // effect both observe the same armed value on a suppressed mount.
  const session = shouldSuppressTabSessionRestore()
    ? parseEditorTabSessionState(null)
    : readInitialLocalTabSession();
  return workspaceWithResolvedTargets(
    hydrateEditorWorkspace({ panes: session.panes, focusedPaneId: session.focusedPaneId }),
  );
}

function providerDocNameForPane(pane: EditorPaneState): string | null {
  if (!pane.activeTarget || pane.activeTarget.kind === 'large-file') return null;
  return docNameForNavigationTarget(pane.activeTarget);
}

function visibleProviderDocNames(workspace: EditorWorkspaceState): Set<string> {
  const names = new Set<string>();
  for (const pane of workspace.panes) {
    const docName = providerDocNameForPane(pane);
    if (docName) names.add(docName);
  }
  return names;
}

function tabIdFromHash(hash: string): string | null {
  const assetPath = assetPathFromHash(hash);
  if (assetPath) return assetTabId(assetPath);
  const skillFile = skillFileFromHash(hash);
  if (skillFile) return skillFileTabId(skillFile);
  const skillPreview = skillPreviewFromHash(hash);
  if (skillPreview) return skillPreviewTabId(skillPreview);
  const docName = docNameFromHash(hash);
  if (!docName) return null;
  const trimmed = docName.trim();
  if (/\/+$/.test(trimmed)) {
    const folderPath = trimmed.replace(/\/+$/g, '');
    return folderPath ? folderTabId(folderPath) : null;
  }
  return docTabId(docName);
}

function isBareHashForExtensionQualifiedActiveDoc(
  hashDocName: string | null,
  hash: string,
  activeDocName: string | null,
): boolean {
  if (!hashDocName || !activeDocName) return false;
  if (!isSameHash(hash, hashFromDocName(hashDocName))) return false;
  if (MARKDOWN_EXTENSION_QUALIFIED_DOC_PATTERN.test(hashDocName)) return false;
  if (!MARKDOWN_EXTENSION_QUALIFIED_DOC_PATTERN.test(activeDocName)) return false;
  return activeDocName.replace(MARKDOWN_EXTENSION_QUALIFIED_DOC_PATTERN, '') === hashDocName;
}

function assetTargetForPath(
  assetPath: string,
): Extract<ResolvedNavigationTarget, { kind: 'asset' }> {
  const assetExt = assetPath.split('.').pop() ?? '';
  return {
    kind: 'asset',
    target: assetPath,
    assetPath,
    mediaKind: mediaKindForSidebarAssetExtension(assetExt),
  };
}

function navigationTargetKey(target: ResolvedNavigationTarget): string {
  switch (target.kind) {
    case 'doc':
      return `doc:${target.docName}`;
    case 'folder-index':
      return `folder-index:${target.docName}:${target.folderPath}:${target.noteKind}`;
    case 'folder':
      return `folder:${target.folderPath}`;
    case 'asset':
      return `asset:${target.assetPath}:${target.mediaKind ?? ''}`;
    case 'skill-file':
      return `skill-file:${target.scope}:${target.name}:${target.path}`;
    case 'skills':
      return 'skills:hub';
    case 'skill-preview':
      // `path` is part of the key so selecting a different file within the SAME
      // preview updates the active target (the tab id stays path-less, so it is
      // one tab whose body switches — not a new tab).
      return `skill-preview:${target.flavor}:${target.source}:${target.name}:${target.subtitle}:${target.path ?? ''}`;
    case 'large-file':
      return `large-file:${target.docName}:${target.size}:${target.limit}`;
    case 'missing':
      return `missing:${target.target}`;
  }
}

function sameNavigationTarget(
  a: ResolvedNavigationTarget | null,
  b: ResolvedNavigationTarget | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return navigationTargetKey(a) === navigationTargetKey(b);
}

/**
 * Structural equality for two pool snapshots, so a notify that changes nothing
 * a consumer can observe does not re-render the provider.
 *
 * `lastAccessedAt` is deliberately excluded. It never reaches the DOM — its
 * only job is to order `poolEntries`, and that ordering is already encoded in
 * the array itself (`takeSnapshot` sorts MRU-first, and `computeActivityMountList`
 * re-sorts by the same key). Comparing it would defeat the bailout entirely,
 * because `ProviderPool.open()` bumps it on every cache hit.
 *
 * Without this guard the provider re-renders on every pool mutation, which
 * hands every context consumer a fresh callback identity. An effect that both
 * calls one of those callbacks and depends on it — `NavigationHandler` in
 * `App.tsx` is the load-bearing one — then closes into a self-feeding cycle
 * that terminates only at React's nested-update limit.
 */
function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a === b) return true;
  if (
    a.activeDocName !== b.activeDocName ||
    a.activeProvider !== b.activeProvider ||
    a.syncState !== b.syncState ||
    // Reference comparison is sufficient: the pool only reassigns
    // `serverRestartRecoveryState` on an actual transition.
    a.serverRestartRecovery !== b.serverRestartRecovery ||
    a.poolEntries.length !== b.poolEntries.length
  ) {
    return false;
  }
  return a.poolEntries.every((entry, index) => {
    const other = b.poolEntries[index];
    return (
      entry.docName === other.docName &&
      entry.provider === other.provider &&
      entry.poolEventId === other.poolEventId
    );
  });
}

function takeSnapshot(p: ProviderPool): Snapshot {
  const active = p.getActive();
  // Project mutable pool entries to immutable read-only snapshots, sorted MRU-first.
  // The sort lives here (not in ProviderPool) so the pool stays a plain LRU map and
  // doesn't need to know about React-side ordering preferences.
  const poolEntries: PoolEntrySnapshot[] = [];
  for (const entry of p.entries.values()) {
    poolEntries.push({
      docName: entry.docName,
      provider: entry.provider,
      lastAccessedAt: entry.lastAccessedAt,
      poolEventId: entry.poolEventId,
    });
  }
  poolEntries.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
  return {
    activeDocName: p.getActiveDocName(),
    activeProvider: active?.provider ?? null,
    syncState: active?.syncState ?? 'connecting',
    serverRestartRecovery: p.getServerRestartRecoveryState(),
    poolEntries,
  };
}

export function DocumentProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [workspace, setWorkspace] = useState<EditorWorkspaceState>(readInitialEditorWorkspace);
  const workspaceRef = useRef(workspace);
  const [visibleTabIdsByPane, setVisibleTabIdsByPane] = useState(
    () => new Map(workspace.panes.map((pane) => [pane.id, [...pane.openTabs, ...pane.newTabIds]])),
  );
  const visibleTabIdsByPaneRef = useRef(visibleTabIdsByPane);
  const currentPane = focusedPane(workspace);
  const activeTarget = currentPane.activeTarget;
  const activeTabId = currentPane.activeTabId;
  const openTabs = flattenWorkspaceTabs(workspace);
  const pinnedTabIds = flattenWorkspacePinnedTabs(workspace);
  const previewTabIdsByPane = new Map(
    workspace.panes.map((pane) => [pane.id, pane.previewTabId] as const),
  );
  const activeNewTabId = currentPane.activeNewTabId;
  const visibleTabIds = reconcileVisibleTabOrder(
    visibleTabIdsByPane.get(currentPane.id) ?? [],
    currentPane.openTabs,
    currentPane.newTabIds,
  );
  const [skillsSidebar, setSkillsSidebarState] = useState<boolean | null>(null);
  // Per-surface active-tab memory: switching Files/Skills restores the tab you
  // last had active in that surface (or clears to its empty/home state). Kept in
  // a ref — it's read imperatively on toggle, never rendered.
  const activeTabByModeRef = useRef<{ files: string | null; skills: string | null }>({
    files: null,
    skills: null,
  });
  const [tabSessionLoaded, setTabSessionLoaded] = useState(false);
  const nextNewTabOrdinalRef = useRef(1);
  const nextPaneOrdinalRef = useRef(1);
  const recentlyClosedTabsRef = useRef<RecentlyClosedEditorTab[]>([]);
  const removalReconcilerRef = useRef<ClientRemovalReconciler | null>(null);
  // Set true when the user explicitly CLOSES (or unpins/replaces) a tab during
  // the async session-restore window. Bails the restore merge so a freshly-
  // closed tab cannot resurrect from the about-to-arrive restored snapshot.
  //
  // OPENS (hash-nav, sidebar clicks, agent links) intentionally do NOT set this
  // ref — the restore merge is additive, so an opened-during-restore tab
  // coexists with the restored set without collision.
  const tabSessionUserClosedRef = useRef(false);
  // How this mount's restore ended. Guards the persist effect below so an
  // in-memory workspace that is not a continuation of the stored session never
  // overwrites it. Starts at 'unread': a rejected read leaves it there, and
  // only a resolved read promotes it to 'applied'.
  const restoreOutcomeRef = useRef<TabSessionRestoreOutcome>('unread');
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [systemProvider, setSystemProvider] = useState<HocuspocusProvider | null>(null);
  const [docPanelMode, setDocPanelModeState] = useState<'doc' | 'agent'>('doc');
  const [docPanelAgentId, setDocPanelAgentId] = useState<string | null>(null);
  const [docPanelExpandSignal, setDocPanelExpandSignal] = useState<number>(0);
  const {
    collabUrl,
    terminal: collabTerminal,
    lastError: collabLastError,
    retry: retryCollab,
  } = useCollabUrl();

  function createPaneId(): EditorPaneId {
    let paneId = '';
    do {
      paneId = `pane-${nextPaneOrdinalRef.current}`;
      nextPaneOrdinalRef.current += 1;
    } while (workspaceRef.current.panes.some((pane) => pane.id === paneId));
    return paneId;
  }

  function syncPoolToWorkspace(nextWorkspace: EditorWorkspaceState, updateHash = false) {
    const focused = focusedPane(nextWorkspace);
    if (collabUrl !== null) {
      const p = getPool(collabUrl);
      const visibleDocNames = visibleProviderDocNames(nextWorkspace);
      p.setVisibleDocNames(visibleDocNames);
      for (const docName of visibleDocNames) p.open(docName);

      const docName = providerDocNameForPane(focused);
      if (docName) {
        p.open(docName);
        p.setActive(docName);
      } else {
        p.clearActive();
      }
    }
    if (!updateHash) return;
    let nextHash = '';
    if (focused.activeNewTabId !== null) {
      if (isSkillsNewTabId(focused.activeNewTabId)) nextHash = hashFromSkills();
    } else if (focused.activeTabId !== null) {
      nextHash = hashFromTabId(focused.activeTabId);
    }
    navigateToHash(nextHash);
  }

  function isSameWorkspace(left: EditorWorkspaceState, right: EditorWorkspaceState): boolean {
    if (left.focusedPaneId !== right.focusedPaneId || left.panes.length !== right.panes.length) {
      return false;
    }
    return left.panes.every((pane, index) => {
      const other = right.panes[index];
      return (
        other !== undefined &&
        pane.id === other.id &&
        pane.activeTabId === other.activeTabId &&
        pane.activeNewTabId === other.activeNewTabId &&
        pane.previewTabId === other.previewTabId &&
        Math.abs(pane.size - other.size) < 1e-9 &&
        sameNavigationTarget(pane.activeTarget, other.activeTarget) &&
        pane.openTabs.join('\0') === other.openTabs.join('\0') &&
        pane.pinnedTabIds.join('\0') === other.pinnedTabIds.join('\0') &&
        pane.newTabIds.join('\0') === other.newTabIds.join('\0')
      );
    });
  }

  function commitWorkspace(nextWorkspace: EditorWorkspaceState, updateHash = false) {
    const normalized = workspaceWithResolvedTargets(normalizeEditorWorkspace(nextWorkspace));
    if (isSameWorkspace(workspaceRef.current, normalized)) {
      syncPoolToWorkspace(workspaceRef.current, updateHash);
      return;
    }
    workspaceRef.current = normalized;
    const paneIds = new Set(normalized.panes.map((pane) => pane.id));
    for (const paneId of visibleTabIdsByPaneRef.current.keys()) {
      if (!paneIds.has(paneId)) visibleTabIdsByPaneRef.current.delete(paneId);
    }
    for (const pane of normalized.panes) {
      visibleTabIdsByPaneRef.current.set(
        pane.id,
        reconcileVisibleTabOrder(
          visibleTabIdsByPaneRef.current.get(pane.id) ?? [],
          pane.openTabs,
          pane.newTabIds,
        ),
      );
    }
    setVisibleTabIdsByPane(new Map(visibleTabIdsByPaneRef.current));
    setWorkspace((current) => (current === normalized ? current : normalized));
    syncPoolToWorkspace(normalized, updateHash);
  }

  function updatePaneState(
    paneId: EditorPaneId,
    update: (pane: EditorPaneState) => EditorPaneState,
    options: { focus?: boolean; updateHash?: boolean } = {},
  ) {
    const current = workspaceRef.current;
    if (!current.panes.some((pane) => pane.id === paneId)) return;
    const updatedWorkspace = updateEditorPane(current, paneId, update);
    const next = options.focus ? { ...updatedWorkspace, focusedPaneId: paneId } : updatedWorkspace;
    commitWorkspace(next, options.updateHash);
  }

  // The active sidebar/tab surface. An explicit pin (`skillsSidebar`
  // true/false) wins; the default `null` follows whichever surface the open doc
  // / new tab belongs to. Single source for the sidebar AND the editor-tab
  // strip's mode filter, so the two never disagree.
  //
  // Both trees pin as they open, so clicking a row keeps you where you are —
  // a skill's file opened from Files stays in Files, and the reverse. Autofollow
  // is therefore the rule for navigation that carries no surface intent of its
  // own: a deep link, the command palette, session restore.
  const skillFocused =
    skillsSidebar ?? (isSkillFocusedTarget(activeTarget) || isSkillsNewTabId(activeNewTabId));

  // Remember the active tab per surface so a Files↔Skills toggle can restore it.
  // Runs on every activeTabId change (incl. session restore) so both surfaces
  // stay current even before the first toggle.
  useEffect(() => {
    if (!activeTabId) return;
    const mode = isSkillTabId(activeTabId) ? 'skills' : 'files';
    activeTabByModeRef.current[mode] = activeTabId;
  }, [activeTabId]);

  // Show only the current surface's tabs. Filtering here (not in EditorTabs)
  // keeps the strip, keyboard cycle/jump, and drag-reorder all consistent;
  // reorderTabs' backstop re-adds any hidden-surface tab, so none are dropped.
  const visibleTabIdsForMode = visibleTabIds.filter(
    (id) => tabIdIsSkillSurface(id) === skillFocused,
  );
  const visibleTabIdsByPaneForMode = new Map(
    [...visibleTabIdsByPane].map(([paneId, tabIds]) => [
      paneId,
      tabIds.filter((tabId) => tabIdIsSkillSurface(tabId) === skillFocused),
    ]),
  );
  const surfaceWorkspace = workspaceWithResolvedTargets(
    projectVisibleEditorWorkspace(workspace, visibleTabIdsByPaneForMode),
  );
  const surfacePane = focusedPane(surfaceWorkspace);

  // biome-ignore lint/correctness/useExhaustiveDependencies: workspace mutations read the live ref; collaboration readiness and load state are the restore triggers.
  useEffect(() => {
    if (collabUrl === null || tabSessionLoaded) return;
    // A repeat app-shell crash armed restore suppression. Skip the read that
    // would reopen the crashing document (bridge or localStorage alike, since
    // this precedes that choice), then reset so the next mount or a reload
    // restores normally — suppression covers exactly one recovery, not the
    // session. The stored session is left untouched here, and recording the
    // outcome keeps it that way for the whole recovery mount: what the user
    // builds from the empty workspace is not a continuation of the session we
    // declined to open, so it must not be written over it. A notice tells the
    // user the last document could not be restored, so the recovered empty
    // workspace does not read as a forgotten tab.
    if (shouldSuppressTabSessionRestore()) {
      resetTabSessionRestoreSuppression();
      showTabSessionRestoreRecoveryNotice();
      restoreOutcomeRef.current = 'suppressed';
      setTabSessionLoaded(true);
      return;
    }
    let cancelled = false;
    const bridge = getDesktopBridge();
    const localKey = getLocalTabSessionKey();
    const storage = typeof localStorage !== 'undefined' ? localStorage : null;
    const loaded = bridge
      ? bridge.project.getSessionState()
      : Promise.resolve(
          localKey ? readLocalTabSessionState(storage, localKey) : parseEditorTabSessionState(null),
        );

    loaded
      .then((raw) => {
        restoreOutcomeRef.current = 'applied';
        if (cancelled) return;
        const state = parseEditorTabSessionState(raw);
        if (tabSessionUserClosedRef.current) return;
        const currentWorkspace = workspaceRef.current;
        let nextWorkspace = workspaceWithResolvedTargets(
          hydrateEditorWorkspace({ panes: state.panes, focusedPaneId: state.focusedPaneId }),
        );
        const restoredFocusedPaneId = nextWorkspace.focusedPaneId;

        // Restore is authoritative for pane layout and ordering, while opens
        // that raced it remain additive in the restored focused pane.
        for (const current of currentWorkspace.panes) {
          for (const tabId of current.openTabs) {
            const owner = findPaneOwningTab(nextWorkspace, tabId);
            if (owner) {
              if (!owner.openTabs.includes(tabId)) {
                nextWorkspace = updateEditorPane(nextWorkspace, owner.id, (pane) => ({
                  ...pane,
                  openTabs: [...pane.openTabs, tabId],
                  pinnedTabIds: current.pinnedTabIds.includes(tabId)
                    ? [...pane.pinnedTabIds, tabId]
                    : pane.pinnedTabIds,
                }));
                continue;
              }
              if (current.pinnedTabIds.includes(tabId) && !owner.pinnedTabIds.includes(tabId)) {
                nextWorkspace = updateEditorPane(nextWorkspace, owner.id, (pane) => ({
                  ...pane,
                  pinnedTabIds: [...pane.pinnedTabIds, tabId],
                }));
              }
              continue;
            }
            nextWorkspace = updateEditorPane(nextWorkspace, restoredFocusedPaneId, (pane) => ({
              ...pane,
              openTabs: [...pane.openTabs, tabId],
              pinnedTabIds: current.pinnedTabIds.includes(tabId)
                ? [...pane.pinnedTabIds, tabId]
                : pane.pinnedTabIds,
            }));
          }
        }

        const currentFocused = focusedPane(currentWorkspace);
        if (currentFocused.newTabIds.length > 0) {
          nextWorkspace = updateEditorPane(nextWorkspace, restoredFocusedPaneId, (pane) => ({
            ...pane,
            newTabIds: [...new Set([...pane.newTabIds, ...currentFocused.newTabIds])],
            activeNewTabId: currentFocused.activeNewTabId,
            activeTabId: currentFocused.activeNewTabId ? null : pane.activeTabId,
            activeTarget: currentFocused.activeNewTabId ? null : pane.activeTarget,
          }));
        }
        // Restore each surface's last-active tab without overwriting a tab
        // opened while the async session read was in flight.
        activeTabByModeRef.current = {
          files: activeTabByModeRef.current.files ?? state.activeTabByMode.files,
          skills: activeTabByModeRef.current.skills ?? state.activeTabByMode.skills,
        };

        const hash = window.location.hash;
        const hashTabId = tabIdFromHash(hash);
        const hashOwner = hashTabId ? findPaneOwningTab(nextWorkspace, hashTabId) : null;
        if (hashOwner && hashTabId && currentFocused.activeNewTabId === null) {
          const currentOwner = findPaneOwningTab(currentWorkspace, hashTabId);
          const currentTarget =
            currentOwner?.activeTabId === hashTabId ? currentOwner.activeTarget : null;
          nextWorkspace = {
            ...updateEditorPane(nextWorkspace, hashOwner.id, (pane) =>
              paneWithResolvedTarget({
                ...pane,
                activeTabId: hashTabId,
                activeNewTabId: null,
                activeTarget: currentTarget,
              }),
            ),
            focusedPaneId: hashOwner.id,
          };
        }
        const currentHashDoc = docNameFromHash(window.location.hash);
        const restoredActive = focusedPane(nextWorkspace).activeTabId;
        const restoredActiveHash = restoredActive ? hashFromTabId(restoredActive) : null;
        const restoredActiveDocName = restoredActive ? docNameForTabId(restoredActive) : null;
        const shouldRestoreActive =
          (currentHashDoc === null && window.location.hash.length === 0) ||
          (restoredActiveHash !== null && isSameHash(restoredActiveHash, window.location.hash)) ||
          isBareHashForExtensionQualifiedActiveDoc(
            currentHashDoc,
            window.location.hash,
            restoredActiveDocName,
          );
        nextWorkspace = workspaceWithResolvedTargets(normalizeEditorWorkspace(nextWorkspace));
        for (const pane of nextWorkspace.panes) {
          visibleTabIdsByPaneRef.current.set(pane.id, [...pane.openTabs, ...pane.newTabIds]);
        }
        commitWorkspace(nextWorkspace, shouldRestoreActive && restoredActive !== null);
      })
      .catch((err: unknown) => {
        console.error('[editor-tabs] failed to restore tab session:', err);
      })
      .finally(() => {
        if (!cancelled) setTabSessionLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [collabUrl, tabSessionLoaded]);

  useEffect(() => {
    if (!tabSessionLoaded) return;
    if (!shouldPersistTabSession(restoreOutcomeRef.current, openTabs.length)) return;
    const state = createEditorTabSessionState(workspace, activeTabByModeRef.current);
    const bridge = getDesktopBridge();
    if (bridge) {
      void bridge.project.setSessionState(state).catch((err: unknown) => {
        console.warn('[editor-tabs] failed to persist tab session:', err);
      });
      return;
    }
    const localKey = getLocalTabSessionKey();
    if (!localKey) return;
    const storage = typeof localStorage !== 'undefined' ? localStorage : null;
    writeLocalTabSessionState(storage, localKey, state);
  }, [openTabs.length, tabSessionLoaded, workspace]);

  // Closes (and close-like preview replacement) during the restore window bail the
  // restore merge. Other mutations (open, pin, activate) are no-ops here because
  // the restore merge is additive — see tabSessionUserClosedRef declaration for
  // the full rationale.
  function markTabSessionClosedDuringRestore() {
    if (!tabSessionLoaded) tabSessionUserClosedRef.current = true;
  }

  function remapTabsForRename(
    renamed: readonly { fromDocName: string; toDocName: string }[],
    renamedFolders: readonly { fromPath: string; toPath: string }[] = [],
    renamedAssets: readonly { fromPath: string; toPath: string }[] = [],
  ) {
    markTabSessionClosedDuringRestore();
    const remapTabId = (tabId: string) =>
      remapOpenTabs(
        [tabId],
        renamed,
        Number.MAX_SAFE_INTEGER,
        renamedFolders,
        [],
        renamedAssets,
      )[0] ?? null;
    for (const [paneId, order] of visibleTabIdsByPaneRef.current) {
      visibleTabIdsByPaneRef.current.set(
        paneId,
        remapVisibleTabsForRename(order, renamed, renamedFolders, renamedAssets),
      );
    }
    const previousFocusedTabId = focusedPane(workspaceRef.current).activeTabId;
    const nextWorkspace = transitionEditorWorkspace(workspaceRef.current, {
      type: 'remap-tabs',
      remap: remapTabId,
    }).workspace;
    const nextFocusedTabId = focusedPane(nextWorkspace).activeTabId;
    commitWorkspace(
      nextWorkspace,
      previousFocusedTabId !== null && previousFocusedTabId !== nextFocusedTabId,
    );
  }

  function closeProvidersWithoutOpenTabs(
    removedTabIds: Iterable<string>,
    nextWorkspace: EditorWorkspaceState,
  ) {
    if (collabUrl === null) return;
    const remainingDocNames = new Set<string>();
    for (const tabId of flattenWorkspaceTabs(nextWorkspace)) {
      const docName = docNameForTabId(tabId);
      if (docName) remainingDocNames.add(docName);
    }
    const p = getPool(collabUrl);
    for (const tabId of removedTabIds) {
      const docName = docNameForTabId(tabId);
      if (docName && !remainingDocNames.has(docName)) p.close(docName);
    }
  }

  function preserveClosedTabSurface(
    previousPane: EditorPaneState,
    closingTabIds: ReadonlySet<string>,
    workspaceAfterClose: EditorWorkspaceState,
  ): EditorWorkspaceState {
    const closedActiveTabId =
      previousPane.activeTabId && closingTabIds.has(previousPane.activeTabId)
        ? previousPane.activeTabId
        : previousPane.activeNewTabId && closingTabIds.has(previousPane.activeNewTabId)
          ? previousPane.activeNewTabId
          : null;
    if (!closedActiveTabId) return workspaceAfterClose;

    const nextPane = workspaceAfterClose.panes.find((pane) => pane.id === previousPane.id);
    const nextActiveTabId = nextPane?.activeTabId ?? nextPane?.activeNewTabId ?? null;
    const closedSkillsTab = tabIdIsSkillSurface(closedActiveTabId);
    if (!nextPane || !nextActiveTabId || tabIdIsSkillSurface(nextActiveTabId) === closedSkillsTab) {
      return workspaceAfterClose;
    }

    const visibleOrder = reconcileVisibleTabOrder(
      visibleTabIdsByPaneRef.current.get(previousPane.id) ?? [],
      previousPane.openTabs,
      previousPane.newTabIds,
    );
    const activeIndex = visibleOrder.indexOf(closedActiveTabId);
    const candidates =
      activeIndex < 0
        ? visibleOrder
        : [...visibleOrder.slice(activeIndex + 1), ...visibleOrder.slice(0, activeIndex).reverse()];
    const remainingTabIds = new Set([...nextPane.openTabs, ...nextPane.newTabIds]);
    const fallbackTabId = candidates.find(
      (tabId) =>
        !closingTabIds.has(tabId) &&
        remainingTabIds.has(tabId) &&
        tabIdIsSkillSurface(tabId) === closedSkillsTab,
    );

    if (fallbackTabId) {
      return updateEditorPane(workspaceAfterClose, previousPane.id, (pane) => ({
        ...pane,
        activeTabId: pane.openTabs.includes(fallbackTabId) ? fallbackTabId : null,
        activeNewTabId: pane.newTabIds.includes(fallbackTabId) ? fallbackTabId : null,
        activeTarget: null,
      }));
    }

    const prefix = closedSkillsTab ? SKILLS_NEW_TAB_PREFIX : NEW_TAB_PREFIX;
    const newTabId = `${prefix}${nextNewTabOrdinalRef.current}`;
    nextNewTabOrdinalRef.current += 1;
    return updateEditorPane(workspaceAfterClose, previousPane.id, (pane) => ({
      ...pane,
      newTabIds: [...pane.newTabIds, newTabId],
      activeTabId: null,
      activeNewTabId: newTabId,
      activeTarget: null,
    }));
  }

  const closeTabsInPaneById = (
    paneId: EditorPaneId,
    tabIds: readonly string[],
    options: CloseTabsOptions = {},
  ) => {
    const pane = workspaceRef.current.panes.find((candidate) => candidate.id === paneId);
    if (!pane) return;
    const closingTabIds = new Set(
      options.force
        ? tabIds.filter((tabId) => pane.openTabs.includes(tabId))
        : filterClosableTabIds(tabIds, pane.pinnedTabIds).filter((tabId) =>
            pane.openTabs.includes(tabId),
          ),
    );
    if (closingTabIds.size === 0) return;
    markTabSessionClosedDuringRestore();
    if (!options.force) {
      for (const tabId of pane.openTabs.filter((candidate) => closingTabIds.has(candidate))) {
        recentlyClosedTabsRef.current = recordRecentlyClosedTab(
          recentlyClosedTabsRef.current,
          { paneId, tabId },
          50,
        );
      }
    }
    const wasFocused = workspaceRef.current.focusedPaneId === paneId;
    const nextWorkspace = preserveClosedTabSurface(
      pane,
      closingTabIds,
      transitionEditorWorkspace(workspaceRef.current, {
        type: 'close-tabs',
        paneId,
        tabIds: [...closingTabIds],
      }).workspace,
    );
    closeProvidersWithoutOpenTabs(closingTabIds, nextWorkspace);
    commitWorkspace(nextWorkspace, wasFocused);
  };

  function closeTabsAcrossPanes(tabIds: readonly string[], options: CloseTabsOptions = {}) {
    const requested = new Set(tabIds.filter((tabId) => tabId.length > 0));
    for (const paneId of workspaceRef.current.panes.map((pane) => pane.id)) {
      const pane = workspaceRef.current.panes.find((candidate) => candidate.id === paneId);
      if (!pane) continue;
      const inPane = pane.openTabs.filter((tabId) => requested.has(tabId));
      if (inPane.length > 0) closeTabsInPaneById(paneId, inPane, options);
    }
  }

  function createRemovalReconciler() {
    return createClientRemovalReconciler({
      captureRenameSnapshots,
      getActivePoolDocName: () =>
        collabUrl === null ? null : getPool(collabUrl).getActiveDocName(),
      hasPooledDocument: (docName) => collabUrl !== null && getPool(collabUrl).has(docName),
      closeAndClear: async (docName) => {
        if (collabUrl !== null) await getPool(collabUrl).closeAndClearPersistence(docName);
      },
      openAndActivate: (docName) => {
        if (collabUrl === null) return;
        const p = getPool(collabUrl);
        p.open(docName);
        p.setActive(docName);
      },
      remapTabs: ({ renamed, renamedFolders, renamedAssets }) =>
        remapTabsForRename(renamed, renamedFolders, renamedAssets),
      closeTabs: (tabIds) => closeTabsAcrossPanes(tabIds, { force: true }),
      removeDocumentTab: (docName) => {
        const nextWorkspace = transitionEditorWorkspace(workspaceRef.current, {
          type: 'prune-tabs',
          keep: (tabId) => docNameForTabId(tabId) !== docName,
        }).workspace;
        commitWorkspace(nextWorkspace);
      },
      remapActiveTargetForRename: (_fromDocName, toDocName) =>
        providerDocNameForPane(focusedPane(workspaceRef.current)) === toDocName,
      clearActiveTargetForRemoval: (docName) => {
        const nextWorkspace = {
          ...workspaceRef.current,
          panes: workspaceRef.current.panes.map((pane) =>
            pane.activeTarget && docNameForNavigationTarget(pane.activeTarget) === docName
              ? { ...pane, activeTarget: null }
              : pane,
          ),
        };
        commitWorkspace(nextWorkspace);
      },
      navigateToDocument: (docName) => navigateToHash(hashFromDocName(docName)),
      navigateHome: () => {
        const focused = focusedPane(workspaceRef.current);
        navigateToHash(focused.activeTabId ? hashFromTabId(focused.activeTabId) : '');
      },
      // A popped-out window has one document and no home surface to land on, so
      // it shows an explicit deleted state rather than navigating. Declining in
      // every other window keeps the workspace behavior untouched.
      showDocumentDeletedState: (docName) =>
        isNoteWindow() ? markNoteWindowDocDeleted(docName) : false,
    });
  }

  // No dependency array: auth callbacks need a reconciler with the latest
  // collab URL and locally-scoped state helpers after every render.
  useEffect(() => {
    removalReconcilerRef.current = createRemovalReconciler();
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: pool wiring is scoped to the collab URL; callbacks read the live workspace ref.
  useEffect(() => {
    if (collabUrl === null) return;
    let cancelled = false;
    const p = getPool(collabUrl);

    // Reuses the previous snapshot when nothing observable changed, so a pool
    // notify that only touched LRU bookkeeping doesn't re-render the shell.
    const commitSnapshot = () => {
      setSnapshot((current) => {
        const next = takeSnapshot(p);
        return sameSnapshot(current, next) ? current : next;
      });
    };

    // Sync initial state
    commitSnapshot();
    syncPoolToWorkspace(workspaceRef.current);

    // Late-join branch backstop. Auth-token `expectedBranch` claim
    // mismatch (server is on branch B, client claims branch A) routes
    // through the same handleBranchSwitched flow as the live CC1
    // broadcast. The fresh branch comes from /api/server-info — the
    // pool's lastObservedBranch is stale by definition (it's what the
    // failed claim was built from).
    //
    // Returning the promise (not `void`) is load-bearing: the pool's
    // in-flight gate awaits whatever the callback returns. A
    // `void`-fronted fetch resolves the gate on the next microtask
    // while the recovery is still in flight, so cross-turn mismatches
    // (N providers, N RTTs) re-fire the dispatch and double-recycle.
    p.setOnBranchMismatch(() => refreshServerInfo(p));

    // Auth-rejection cleanup arms. The pool fires these synchronously from
    // its authenticationFailed handler; we own the React-state-aware
    // cleanup (close + IDB clear via the pool, tab remap, active-tab
    // navigation, and the structured `removal.cleanup` event). Mirrors
    // the FileTree.tsx sidebar precedents (`applyRenamedDocuments` for
    // rename, `handleDelete` for delete) so a server-driven removal lands
    // through the same code shape as a sidebar-driven one.
    p.setOnRenameRedirect(({ fromDocName, toDocName, hadOpenProvider }) => {
      // Fire-and-forget: the pool's auth-failed callback is sync; the
      // React-state-aware cleanup is async. The catch surfaces failures
      // explicitly (the void IIFE would otherwise route them to the
      // window's unhandledrejection handler). The catch arm is also
      // load-bearing for React Compiler — `try/finally` without `catch`
      // is unsupported by `BuildHIR::lowerStatement`.
      void (async () => {
        let cleanupError: unknown;
        try {
          await requireRemovalReconciler(removalReconcilerRef.current).reconcileAuthRename({
            fromDocName,
            toDocName,
          });
        } catch (err) {
          cleanupError = err;
          console.warn(
            JSON.stringify({
              event: 'removal-cleanup-error',
              kind: 'renamed',
              fromDocName,
              toDocName,
              message: String(err instanceof Error ? err.message : err),
            }),
          );
        }
        console.info(
          JSON.stringify({
            event: 'removal.cleanup',
            kind: 'renamed',
            fromDocName,
            toDocName,
            hadOpenProvider,
            hadStaleIdb: !hadOpenProvider,
            source: 'auth-rejection',
            errored: cleanupError !== undefined,
          }),
        );
      })();
    });
    p.setOnDocDeleted(({ docName, hadOpenProvider }) => {
      // See comment above; same React Compiler constraint applies.
      void (async () => {
        let cleanupError: unknown;
        try {
          await requireRemovalReconciler(removalReconcilerRef.current).reconcileAuthRemoval({
            docName,
          });
        } catch (err) {
          cleanupError = err;
          console.warn(
            JSON.stringify({
              event: 'removal-cleanup-error',
              kind: 'deleted',
              docName,
              message: String(err instanceof Error ? err.message : err),
            }),
          );
        }
        console.info(
          JSON.stringify({
            event: 'removal.cleanup',
            kind: 'deleted',
            fromDocName: docName,
            hadOpenProvider,
            hadStaleIdb: !hadOpenProvider,
            source: 'auth-rejection',
            errored: cleanupError !== undefined,
          }),
        );
      })();
    });

    // Subscribe to pool changes
    p.setOnChange(commitSnapshot);

    // Fetch principal and wire tab identity so HocuspocusProvider includes
    // {principalId, tabSessionId} in its auth token. The server's
    // onAuthenticate hook reads this to set connection.context.principalId for
    // correct writer attribution. Also lifts the resolved principal into React
    // state so TiptapEditor can prefer real names over random animal fallbacks.
    // Silent on failure — pool uses anonymous token; presence falls back to random.
    fetch('/api/principal')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json: unknown) => {
        if (cancelled) return;
        const parsed = PrincipalSuccessSchema.safeParse(json);
        if (parsed.success) {
          p.setTabIdentity({ principalId: parsed.data.id, tabSessionId });
          setPrincipal(parsed.data);
        } else {
          warnPrincipalFetchOnce(parsed.error);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        warnPrincipalFetchOnce(err);
      });

    // CRDT server-restart recovery boot fetch: pull the server's
    // per-process instance ID, current git branch, and per-doc
    // disk-ack watermarks at startup, dispatch them all into the
    // pool. Subsequent provider opens claim the instance ID + branch
    // in their auth tokens so server-side enforcement can reject a
    // stale-client reconnect before Yjs sync merges ghost state. The
    // disk-ack batch refreshes per-entry `lastDiskAckedSV` so the
    // mismatch-recycle baseline-selection always operates on fresh
    // data (closes the missed-frame staleness gap that CC1 stateless
    // broadcasts otherwise leave open).
    //
    // SystemDocSubscriber re-fires this on every `__system__` reconnect
    // — same helper, same dispatch — so a brief WS drop doesn't leave
    // any of the three watermarks permanently stale.
    void refreshServerInfo(p);

    // systemProvider exposure happens in a dedicated effect below because it
    // depends on `systemProvider` state, not `collabUrl`.
    // Expose pool + test hooks on window for Playwright E2E access. Gated on
    // `import.meta.env.DEV` so production bundles don't ship a sync-promise
    // rejection trigger or a WebSocket close primitive — both useful for E2E,
    // both unsafe to leave callable from arbitrary page-context script
    // (extensions, bookmarklets, future embed consumers). Vite replaces this
    // statically at build time, so the entire branch tree-shakes out of the
    // production bundle. Mirrors the dev-only pattern already used in
    // `editor/extensions/slash-command.ts`.
    if (import.meta.env.DEV) {
      window.__providerPool = p;
      Object.defineProperty(window, '__activeProvider', {
        get: () => p.getActive()?.provider ?? null,
        configurable: true,
      });
      // Mirror of `__activeProvider` for the registered Editor instance.
      // Resolving via `getActive()?.docName` keeps the getter consistent with
      // `__activeProvider`'s active-entry semantics even when multiple editors
      // are mounted concurrently (EditorActivityPool's ACTIVITY_MOUNT_LIMIT).
      // Playwright reads this to poll PM `editor.state.selection` directly.
      // see precedent §20(a) category C.
      Object.defineProperty(window, '__activeEditor', {
        get: () => {
          const active = p.getActive();
          if (!active) return null;
          return getEditorForDoc(active.docName);
        },
        configurable: true,
      });
      window.__test_rejectSyncPromise = (docName, kind) => __rejectSyncPromise(docName, kind);
      window.__test_armPendingRejection = (docName, kind) =>
        __test_armPendingRejection(docName, kind);
      window.__test_closeActiveWebSocket = () => {
        const provider = p.getActive()?.provider;
        if (!provider) return false;
        // HocuspocusProvider wraps y-websocket internally; reach for the live WS
        // via the typed fields we can see, falling back to any-cast for the
        // nested websocketProvider (not in the provider's public TS surface).
        const cfg = provider.configuration as unknown as {
          websocketProvider?: { webSocket?: { close?: () => void } };
        };
        const ws = cfg.websocketProvider?.webSocket;
        if (ws && typeof ws.close === 'function') {
          ws.close();
          return true;
        }
        return false;
      };
    }

    return () => {
      cancelled = true;
      p.setOnChange(null);
      p.setOnRenameRedirect(null);
      p.setOnDocDeleted(null);
    };
  }, [collabUrl]);

  function focusPaneById(paneId: EditorPaneId, updateHash = true) {
    const pane = workspaceRef.current.panes.find((candidate) => candidate.id === paneId);
    if (!pane) return;
    const surfacePane = surfaceWorkspace.panes.find((candidate) => candidate.id === paneId);
    let nextWorkspace = workspaceRef.current;
    if (surfacePane?.activeTabId && surfacePane.activeTabId !== pane.activeTabId) {
      setSkillsSidebarState(null);
      nextWorkspace = transitionEditorWorkspace(nextWorkspace, {
        type: 'activate-tab',
        paneId,
        tabId: surfacePane.activeTabId,
      }).workspace;
    } else if (surfacePane?.activeNewTabId && surfacePane.activeNewTabId !== pane.activeNewTabId) {
      setSkillsSidebarState(null);
      nextWorkspace = updateEditorPane(nextWorkspace, paneId, (candidate) => ({
        ...candidate,
        activeTabId: null,
        activeNewTabId: surfacePane.activeNewTabId,
        activeTarget: null,
      }));
    } else if (nextWorkspace.focusedPaneId === paneId) {
      return;
    }
    commitWorkspace(
      focusEditorPane(
        {
          ...nextWorkspace,
          panes: nextWorkspace.panes.map((candidate) =>
            candidate.id === paneId ? paneWithResolvedTarget(candidate) : candidate,
          ),
        },
        paneId,
      ),
      updateHash,
    );
  }

  function activateTabInPaneById(paneId: EditorPaneId, tabId: string, updateHash = true) {
    const pane = workspaceRef.current.panes.find((candidate) => candidate.id === paneId);
    if (!pane) return;
    if (!pane.openTabs.includes(tabId)) return;
    setSkillsSidebarState(null);
    commitWorkspace(
      transitionEditorWorkspace(workspaceRef.current, {
        type: 'activate-tab',
        paneId,
        tabId,
      }).workspace,
      updateHash,
    );
  }

  const openDocument = (docName: string) => {
    mark('ok/nav/open-document', { docName, transition: false });
    openTargetWithOptions(
      { kind: 'doc', target: docName, docName },
      { disposition: 'permanent', consumeActiveNewTab: true },
    );
  };
  // Pass-through wrapper. React's default Suspense behavior handles cold
  // (skeleton) and warm (no suspension → fast commit) without deferring
  // the shell — wrapping in `startTransition` (or a fast/slow split keyed
  // on the provider's `hasSynced`) would hold shell state (activeDocName
  // driving the sidebar highlight + header title) for the full editor-mount
  // window, making the click feel laggy.
  const openDocumentTransition = (docName: string) => {
    mark('ok/nav/open-document', { docName, transition: false });
    openDocument(docName);
  };

  function activateOrOpenSurfaceNewTab(paneId: EditorPaneId, surface: NewTabSurface) {
    const pane = workspaceRef.current.panes.find((candidate) => candidate.id === paneId);
    if (!pane) return;
    // A pane can hold several new tabs per surface, and a surface hub route
    // (`#/__skills__`) addresses the surface, not one tab - so re-resolving it
    // has to keep whichever tab is already active instead of snapping back to
    // the first. Without this the nav effect, which re-fires on the unchanged
    // hub hash, steals activation from every other new tab on that surface.
    const activeOnSurface =
      pane.activeNewTabId !== null && newTabSurfaceOf(pane.activeNewTabId) === surface
        ? pane.activeNewTabId
        : null;
    const existingTabId =
      activeOnSurface ?? pane.newTabIds.find((tabId) => newTabSurfaceOf(tabId) === surface);
    setSkillsSidebarState(null);
    if (existingTabId) {
      updatePaneState(
        pane.id,
        (current) => ({
          ...current,
          activeNewTabId: existingTabId,
          activeTabId: null,
          activeTarget: null,
        }),
        { updateHash: true },
      );
      return;
    }

    const nextNewTabId = `${NEW_TAB_PREFIX_BY_SURFACE[surface]}${nextNewTabOrdinalRef.current}`;
    nextNewTabOrdinalRef.current += 1;
    commitWorkspace(
      transitionEditorWorkspace(workspaceRef.current, {
        type: 'open-new-tab',
        paneId: pane.id,
        tabId: nextNewTabId,
      }).workspace,
      true,
    );
  }

  const openTargetWithOptions = (
    target: ResolvedNavigationTarget,
    options: OpenTargetOptions = {},
    requestedPaneId?: EditorPaneId,
    existingTabBehavior: ExistingTabOpenBehavior = 'activate-owner',
  ) => {
    if (collabUrl === null) return;
    const paneId = requestedPaneId ?? workspaceRef.current.focusedPaneId;
    const p = getPool(collabUrl);
    if (target.kind === 'skills') {
      activateOrOpenSurfaceNewTab(paneId, 'skills');
      return;
    }
    const docName = docNameForNavigationTarget(target);
    const nextTabId = tabIdForNavigationTarget(target);
    if (!nextTabId) return;
    if (docName && target.kind !== 'large-file') {
      const entry = p.open(docName);
      if (!entry) return;
      consumePrewarmClick(docName, entry.poolEventId);
    }

    const transition = transitionEditorWorkspace(workspaceRef.current, {
      type: 'open-target',
      paneId,
      tabId: nextTabId,
      target,
      disposition:
        options.disposition ?? (options.tabBehavior === 'replace-active' ? 'preview' : 'permanent'),
      consumeActiveNewTab: options.consumeActiveNewTab ?? true,
      existingTabBehavior,
    });
    if (transition.replacedPreviewTabId !== null) markTabSessionClosedDuringRestore();
    setSkillsSidebarState(null);
    commitWorkspace(transition.workspace);
  };
  const openTarget = (target: ResolvedNavigationTarget, options?: OpenTargetOptions) => {
    openTargetWithOptions(target, options);
  };
  const openTargetInPane = (
    paneId: EditorPaneId,
    target: ResolvedNavigationTarget,
    options?: OpenTargetOptions,
  ) => {
    openTargetWithOptions(target, options, paneId, 'open-in-pane');
  };
  const openTargetTransition = (target: ResolvedNavigationTarget, options?: OpenTargetOptions) => {
    const docName = docNameForNavigationTarget(target);
    mark('ok/nav/open-target', { docName, kind: target.kind, transition: false });
    openTargetWithOptions(target, options);
  };

  const activateTabById = (tabId: string) =>
    activateTabInPaneById(workspaceRef.current.focusedPaneId, tabId);

  const openBlobRunner = () => {
    activateOrOpenSurfaceNewTab(workspaceRef.current.focusedPaneId, 'blob-runner');
  };

  const openNewTabInPaneById = (paneId: EditorPaneId) => {
    const pane = workspaceRef.current.panes.find((candidate) => candidate.id === paneId);
    if (!pane) return;
    const prefix = skillFocused ? SKILLS_NEW_TAB_PREFIX : NEW_TAB_PREFIX;
    const nextNewTabId = `${prefix}${nextNewTabOrdinalRef.current}`;
    nextNewTabOrdinalRef.current += 1;
    commitWorkspace(
      transitionEditorWorkspace(workspaceRef.current, {
        type: 'open-new-tab',
        paneId,
        tabId: nextNewTabId,
      }).workspace,
      true,
    );
  };
  const openNewTabById = () => openNewTabInPaneById(workspaceRef.current.focusedPaneId);

  const closeTabInPaneById = (paneId: EditorPaneId, tabId: string) =>
    closeTabsInPaneById(paneId, [tabId]);
  const closeTabById = (tabId: string) =>
    closeTabInPaneById(workspaceRef.current.focusedPaneId, tabId);

  const closeNewTabInPaneById = (paneId: EditorPaneId, tabId: string) => {
    markTabSessionClosedDuringRestore();
    const pane = workspaceRef.current.panes.find((candidate) => candidate.id === paneId);
    if (!pane?.newTabIds.includes(tabId)) return;
    const wasActive = pane.activeNewTabId === tabId;
    const nextWorkspace = transitionEditorWorkspace(workspaceRef.current, {
      type: 'close-tabs',
      paneId,
      tabIds: [tabId],
    }).workspace;
    const nextPane = nextWorkspace.panes.find((candidate) => candidate.id === paneId);
    const nextActiveTabId = nextPane?.activeTabId ?? nextPane?.activeNewTabId ?? null;
    const closedSkillsTab = isSkillsNewTabId(tabId);
    const remainsOnClosedSurface =
      nextActiveTabId !== null && tabIdIsSkillSurface(nextActiveTabId) === closedSkillsTab;
    // A blob-runner tab belongs to no sidebar surface, so closing one should
    // leave the sidebar wherever it was. Without this guard it reads as a Files
    // tab and pins the sidebar to Files even when the next active tab is Skills.
    if (wasActive && !remainsOnClosedSurface && !isBlobRunnerNewTabId(tabId)) {
      setSkillsSidebarState(closedSkillsTab);
    }
    commitWorkspace(
      nextWorkspace,
      workspaceRef.current.focusedPaneId === paneId && wasActive && remainsOnClosedSurface,
    );
  };
  const closeNewTabById = (tabId: string) =>
    closeNewTabInPaneById(workspaceRef.current.focusedPaneId, tabId);

  // Files/Skills toggle. Each surface remembers its last active tab even when
  // that tab lives in a different split pane. With no remembered tab, retain
  // the workspace and activate that surface's ephemeral home tab.
  const setSkillsSidebar = (next: boolean | null) => {
    if (next === null) {
      setSkillsSidebarState(null);
      return;
    }

    const targetMode = next ? 'skills' : 'files';
    if ((skillFocused ? 'skills' : 'files') === targetMode) {
      setSkillsSidebarState(next);
      return;
    }

    const rememberedTabId = activeTabByModeRef.current[targetMode];
    const owner = rememberedTabId ? findPaneOwningTab(workspaceRef.current, rememberedTabId) : null;
    if (rememberedTabId && owner) {
      setSkillsSidebarState(null);
      activateTabInPaneById(owner.id, rememberedTabId);
      return;
    }

    const pane = focusedPane(workspaceRef.current);
    activateOrOpenSurfaceNewTab(pane.id, next ? 'skills' : 'files');
  };

  const closeActiveTabOrWindow = (): boolean => {
    const pane = focusedPane(workspaceRef.current);
    const activeNewTab = pane.activeNewTabId;
    if (activeNewTab) {
      closeNewTabInPaneById(pane.id, activeNewTab);
      return true;
    }

    const pinnedTabSet = new Set(pane.pinnedTabIds);
    const openTabSet = new Set(pane.openTabs.filter((id) => !pinnedTabSet.has(id)));
    const activeOpenTab =
      pane.activeTabId && openTabSet.has(pane.activeTabId) ? pane.activeTabId : null;
    const visibleOrder = visibleTabIdsByPaneRef.current.get(pane.id) ?? [];
    const targetTabId = activeOpenTab ?? visibleOrder.find((id) => openTabSet.has(id));
    if (targetTabId) {
      closeTabInPaneById(pane.id, targetTabId);
      return true;
    }

    const newTabSet = new Set(pane.newTabIds);
    const targetNewTabId = visibleOrder.find((id) => newTabSet.has(id));
    if (targetNewTabId) {
      closeNewTabInPaneById(pane.id, targetNewTabId);
      return true;
    }

    const fallbackPane = workspaceRef.current.panes.find(
      (candidate) =>
        candidate.newTabIds.length > 0 ||
        candidate.openTabs.some((tabId) => !candidate.pinnedTabIds.includes(tabId)),
    );
    if (!fallbackPane) return false;
    const fallbackNewTab = fallbackPane.activeNewTabId ?? fallbackPane.newTabIds[0] ?? null;
    if (fallbackNewTab) {
      closeNewTabInPaneById(fallbackPane.id, fallbackNewTab);
      return true;
    }
    const fallbackTab =
      (fallbackPane.activeTabId && !fallbackPane.pinnedTabIds.includes(fallbackPane.activeTabId)
        ? fallbackPane.activeTabId
        : null) ??
      fallbackPane.openTabs.find((tabId) => !fallbackPane.pinnedTabIds.includes(tabId));
    if (!fallbackTab) return false;
    closeTabInPaneById(fallbackPane.id, fallbackTab);
    return true;
  };

  function activateNewTabInPaneById(paneId: EditorPaneId, tabId: string) {
    const pane = workspaceRef.current.panes.find((candidate) => candidate.id === paneId);
    if (!pane?.newTabIds.includes(tabId)) return;
    commitWorkspace(
      transitionEditorWorkspace(workspaceRef.current, {
        type: 'activate-tab',
        paneId,
        tabId,
      }).workspace,
      true,
    );
  }

  function pinTabInPaneById(paneId: EditorPaneId, tabId: string) {
    const pane = workspaceRef.current.panes.find((candidate) => candidate.id === paneId);
    if (!pane?.openTabs.includes(tabId)) return;
    commitWorkspace(
      transitionEditorWorkspace(workspaceRef.current, {
        type: 'pin-tab',
        paneId,
        tabId,
      }).workspace,
    );
  }

  function unpinTabInPaneById(paneId: EditorPaneId, tabId: string) {
    const pane = workspaceRef.current.panes.find((candidate) => candidate.id === paneId);
    if (!pane?.pinnedTabIds.includes(tabId)) return;
    markTabSessionClosedDuringRestore();
    commitWorkspace(
      transitionEditorWorkspace(workspaceRef.current, {
        type: 'unpin-tab',
        paneId,
        tabId,
      }).workspace,
    );
  }

  function reorderTabsInPaneById(
    paneId: EditorPaneId,
    newOrder: readonly string[],
    draggedTabId: string,
  ) {
    const pane = workspaceRef.current.panes.find((candidate) => candidate.id === paneId);
    if (!pane) return;
    const known = new Set([...pane.openTabs, ...pane.newTabIds]);
    const seed = newOrder.filter((tabId) => known.has(tabId));
    for (const tabId of [...pane.openTabs, ...pane.newTabIds]) {
      if (!seed.includes(tabId)) seed.push(tabId);
    }
    visibleTabIdsByPaneRef.current.set(paneId, seed);
    setVisibleTabIdsByPane(new Map(visibleTabIdsByPaneRef.current));
    const openOrder = seed.filter((tabId) => pane.openTabs.includes(tabId));
    const newTabOrder = seed.filter((tabId) => pane.newTabIds.includes(tabId));
    const reordered = transitionEditorWorkspace(workspaceRef.current, {
      type: 'reorder-tabs',
      paneId,
      tabIds: openOrder,
      draggedTabId,
    }).workspace;
    commitWorkspace({
      ...reordered,
      panes: reordered.panes.map((candidate) =>
        candidate.id === paneId ? { ...candidate, newTabIds: newTabOrder } : candidate,
      ),
    });
  }

  function moveTabToPaneById(tabId: string, targetPaneId: EditorPaneId, targetIndex: number) {
    const sourcePane = workspaceRef.current.panes.find(
      (pane) => pane.openTabs.includes(tabId) || pane.newTabIds.includes(tabId),
    );
    const targetPane = workspaceRef.current.panes.find((pane) => pane.id === targetPaneId);
    if (!sourcePane || !targetPane) return;
    const targetOrder = reconcileVisibleTabOrder(
      visibleTabIdsByPaneRef.current.get(targetPaneId) ?? [],
      targetPane.openTabs,
      targetPane.newTabIds,
    ).filter((candidate) => candidate !== tabId);
    const visibleTargetIndex = Math.max(0, Math.min(targetIndex, targetOrder.length));
    const targetBucket = sourcePane.newTabIds.includes(tabId)
      ? targetPane.newTabIds
      : targetPane.openTabs;
    const targetBucketIndex = tabBucketIndexForVisibleInsertion(
      targetOrder,
      targetBucket,
      visibleTargetIndex,
    );
    const nextWorkspace = transitionEditorWorkspace(workspaceRef.current, {
      type: 'move-tab',
      tabId,
      paneId: targetPaneId,
      index: targetBucketIndex,
    }).workspace;
    if (sourcePane.id !== targetPaneId) {
      visibleTabIdsByPaneRef.current.set(
        sourcePane.id,
        reconcileVisibleTabOrder(
          visibleTabIdsByPaneRef.current.get(sourcePane.id) ?? [],
          sourcePane.openTabs,
          sourcePane.newTabIds,
        ).filter((candidate) => candidate !== tabId),
      );
      targetOrder.splice(visibleTargetIndex, 0, tabId);
      visibleTabIdsByPaneRef.current.set(targetPaneId, targetOrder);
    }
    commitWorkspace(nextWorkspace, true);
  }

  function splitTabById(
    tabId: string,
    targetPaneId: EditorPaneId,
    side: PaneSide,
  ): EditorPaneId | null {
    const sourcePane = workspaceRef.current.panes.find(
      (pane) => pane.openTabs.includes(tabId) || pane.newTabIds.includes(tabId),
    );
    if (!sourcePane) return null;
    const newPaneId = createPaneId();
    const nextWorkspace = transitionEditorWorkspace(workspaceRef.current, {
      type: 'split-tab',
      tabId,
      paneId: targetPaneId,
      side,
      newPaneId,
    }).workspace;
    const newPane = nextWorkspace.panes.find((pane) => pane.id === newPaneId);
    if (!newPane) return null;
    visibleTabIdsByPaneRef.current.set(
      sourcePane.id,
      reconcileVisibleTabOrder(
        visibleTabIdsByPaneRef.current.get(sourcePane.id) ?? [],
        sourcePane.openTabs,
        sourcePane.newTabIds,
      ).filter((candidate) => candidate !== tabId),
    );
    visibleTabIdsByPaneRef.current.set(newPane.id, [tabId]);
    commitWorkspace(nextWorkspace, true);
    return newPane.id;
  }

  function moveTabToNewPaneById(tabId: string, side: PaneSide): EditorPaneId | null {
    const owner = findPaneOwningTab(workspaceRef.current, tabId);
    if (!owner) return null;
    return splitTabById(tabId, owner.id, side);
  }

  function resizeEditorPanes(sizesByPane: ReadonlyMap<EditorPaneId, number>) {
    if (sizesByPane.size === 0) return;
    commitWorkspace(
      transitionEditorWorkspace(workspaceRef.current, {
        type: 'resize-panes',
        sizes: workspaceRef.current.panes.map((pane) => sizesByPane.get(pane.id) ?? pane.size),
      }).workspace,
    );
  }

  function promoteTabInPaneById(paneId: EditorPaneId, tabId: string) {
    commitWorkspace(
      transitionEditorWorkspace(workspaceRef.current, {
        type: 'promote-preview',
        paneId,
        tabId,
      }).workspace,
    );
  }

  function promoteAllPreviewTabs() {
    commitWorkspace(
      transitionEditorWorkspace(workspaceRef.current, {
        type: 'promote-all-previews',
      }).workspace,
    );
  }

  /**
   * Make a tab permanent once the user commits to it, so the next sidebar click
   * opens beside it instead of replacing it.
   *
   * Guarded on the pane's current `previewTabId` before committing, because the
   * edit path calls this on every user keystroke: only the FIRST request for a
   * given preview tab reaches `commitWorkspace`, and every later one returns
   * without touching workspace state, persistence, or React.
   */
  function promotePreviewTab(tabId: string) {
    const owner = findPaneOwningTab(workspaceRef.current, tabId);
    if (!owner || owner.previewTabId !== tabId) return;
    promoteTabInPaneById(owner.id, tabId);
  }

  useEffect(
    () => subscribePreviewTabPromotion(promotePreviewTab),
    [
      // biome-ignore lint/correctness/useExhaustiveDependencies: promotePreviewTab is render-bound (React Compiler is on, so useCallback is not an option here); re-subscribing keeps the listener reading current workspace state, and the unsubscribe is identity-checked so the churn can't drop a live registration.
      promotePreviewTab,
    ],
  );

  useEffect(() => {
    return subscribeLocalMenuAction((action) => {
      if (action !== 'close-active-tab-or-window') return;
      if (!closeActiveTabOrWindow()) window.close();
    });
  }, [
    // biome-ignore lint/correctness/useExhaustiveDependencies: closeActiveTabOrWindow is render-bound; re-subscribing keeps the menu handler fresh for current tab state.
    closeActiveTabOrWindow,
  ]);

  const activeDocName = providerDocNameForPane(surfacePane);
  const activeProvider =
    snapshot.activeDocName === activeDocName
      ? snapshot.activeProvider
      : (snapshot.poolEntries.find((entry) => entry.docName === activeDocName)?.provider ?? null);

  const value: DocumentContextValue = {
    principal,
    activeTarget: surfacePane.activeTarget,
    activeTabId: surfacePane.activeTabId,
    skillsSidebar,
    setSkillsSidebar,
    skillFocused,
    activeDocName,
    activeProvider,
    workspace,
    panes: surfaceWorkspace.panes,
    focusedPaneId: surfaceWorkspace.focusedPaneId,
    focusPane: focusPaneById,
    activateTabInPane: activateTabInPaneById,
    activateNewTabInPane: activateNewTabInPaneById,
    openNewTabInPane: openNewTabInPaneById,
    closeTabInPane: closeTabInPaneById,
    closeTabsInPane: closeTabsInPaneById,
    closeNewTabInPane: closeNewTabInPaneById,
    pinTabInPane: pinTabInPaneById,
    unpinTabInPane: unpinTabInPaneById,
    reorderTabsInPane: reorderTabsInPaneById,
    moveTabToPane: moveTabToPaneById,
    splitTab: splitTabById,
    moveTabToNewPane: moveTabToNewPaneById,
    resizePanes: resizeEditorPanes,
    openTabs,
    pinnedTabIds,
    visibleTabIdsByPane: visibleTabIdsByPaneForMode,
    previewTabIdsByPane,
    visibleTabIds: visibleTabIdsForMode,
    tabSessionLoaded,
    syncState: snapshot.syncState,
    serverRestartRecovery: snapshot.serverRestartRecovery,
    poolEntries: snapshot.poolEntries,
    openDocument,
    openDocumentTransition,
    openTarget,
    openTargetInPane,
    openTargetTransition,
    promoteTabInPane: promoteTabInPaneById,
    promoteAllPreviewTabs,
    clearTarget: () => {
      const pane = focusedPane(workspaceRef.current);
      if (pane.activeNewTabId !== null && !isSkillsNewTabId(pane.activeNewTabId)) return;
      activateOrOpenSurfaceNewTab(pane.id, 'files');
    },
    closeDocument: (docName: string) => {
      markTabSessionClosedDuringRestore();
      const focusedWasClosed =
        providerDocNameForPane(focusedPane(workspaceRef.current)) === docName;
      const nextWorkspace = transitionEditorWorkspace(workspaceRef.current, {
        type: 'prune-tabs',
        keep: (tabId) => docNameForTabId(tabId) !== docName,
      }).workspace;
      if (collabUrl !== null) getPool(collabUrl).close(docName);
      commitWorkspace(nextWorkspace, focusedWasClosed);
    },
    closeActiveTabOrWindow,
    closeTab: closeTabById,
    pinTab: (tabId: string) => pinTabInPaneById(workspaceRef.current.focusedPaneId, tabId),
    unpinTab: (tabId: string) => unpinTabInPaneById(workspaceRef.current.focusedPaneId, tabId),
    activateTab: activateTabById,
    reorderTabs: (newOrder: readonly string[], draggedTabId: string) =>
      reorderTabsInPaneById(workspaceRef.current.focusedPaneId, newOrder, draggedTabId),
    newTabIds: surfacePane.newTabIds,
    activeNewTabId: surfacePane.activeNewTabId,
    isNewTabActive: surfacePane.activeNewTabId !== null,
    openNewTab: openNewTabById,
    openBlobRunner,
    activateNewTab: (tabId: string) =>
      activateNewTabInPaneById(workspaceRef.current.focusedPaneId, tabId),
    closeNewTab: closeNewTabById,
    reopenClosedTab: () => {
      const stack = [...recentlyClosedTabsRef.current];
      while (stack.length > 0) {
        const closed = stack.shift();
        if (!closed) continue;
        if (findPaneOwningTab(workspaceRef.current, closed.tabId)) {
          recentlyClosedTabsRef.current = stack;
          continue;
        }
        const targetPane =
          workspaceRef.current.panes.find((pane) => pane.id === closed.paneId) ??
          focusedPane(workspaceRef.current);
        recentlyClosedTabsRef.current = stack;
        const target = resolvedTargetForTabId(closed.tabId);
        commitWorkspace(
          transitionEditorWorkspace(workspaceRef.current, {
            type: 'open-target',
            paneId: targetPane.id,
            tabId: closed.tabId,
            target,
            disposition: 'permanent',
            consumeActiveNewTab: false,
          }).workspace,
          true,
        );
        return;
      }
      recentlyClosedTabsRef.current = [];
    },
    closeTabs: closeTabsAcrossPanes,
    syncOpenTabsWithKnownTargets: ({ pages, folderPaths, assetPaths, filePaths }) => {
      const missingDocNames = new Set(
        workspaceRef.current.panes.flatMap((pane) =>
          pane.activeTarget?.kind === 'missing' ? [pane.activeTarget.target] : [],
        ),
      );
      // Never evict the doc the hash currently points at: on cold start the page
      // list arrives empty-then-populated, and a sync firing in that window would
      // otherwise prune the just-seeded doc and clear the hash (→ empty-state
      // splash) before the nav effect resolves it to a `missing` target. This is
      // order-independent insurance over `keepMissingDocName`, which the prune
      // can race ahead of.
      const keepHashDocName =
        typeof window !== 'undefined' ? docNameFromHash(window.location.hash) : null;
      const allOpenTabs = flattenWorkspaceTabs(workspaceRef.current);
      const nextOpenTabs = filterOpenTabsForKnownTargets(allOpenTabs, {
        pages: new Set([...pages, ...missingDocNames]),
        folderPaths,
        assetPaths,
        filePaths,
        keepMissingDocName: null,
        keepHashDocName,
      });
      if (nextOpenTabs.length === allOpenTabs.length) return;

      const nextTabIds = new Set(nextOpenTabs);
      const staleTabIds = allOpenTabs.filter((tabId) => !nextTabIds.has(tabId));
      markTabSessionClosedDuringRestore();

      const focusedActiveTabId = focusedPane(workspaceRef.current).activeTabId;
      const focusedWasPruned = focusedActiveTabId !== null && !nextTabIds.has(focusedActiveTabId);
      const nextWorkspace = transitionEditorWorkspace(workspaceRef.current, {
        type: 'prune-tabs',
        keep: (tabId) => nextTabIds.has(tabId),
      }).workspace;
      closeProvidersWithoutOpenTabs(staleTabIds, nextWorkspace);
      commitWorkspace(nextWorkspace, focusedWasPruned);
    },
    reconcileLocalRename: (input) => createRemovalReconciler().reconcileLocalRename(input),
    reconcileLocalRemoval: (input) => createRemovalReconciler().reconcileLocalRemoval(input),
    recycleDocument: (docName: string) => {
      if (collabUrl === null) return;
      const p = getPool(collabUrl);
      p.recycle(docName);
    },
    prewarm: (docName: string): string | null => {
      if (collabUrl === null) return null;
      const p = getPool(collabUrl);
      const entry = p.prewarm(docName);
      return entry?.poolEventId ?? null;
    },
    systemProvider,
    setSystemProvider,
    updateServerInstanceId: (id: string | null) => {
      if (collabUrl === null) return;
      const p = getPool(collabUrl);
      p.setExpectedServerInstanceId(id);
    },
    onBranchSwitched: async (branch: string) => {
      if (collabUrl === null) return;
      const p = getPool(collabUrl);
      p.setObservedBranch(branch);
      await handleBranchSwitched(p, branch);
      // CRDT provider recycle alone leaves the non-Y.Doc derived-view stores
      // (PageList / FileTree / backlinks / graph) on stale-branch data until
      // a focus refetch trips them. Piggyback on the same channels the
      // SystemDocSubscriber `synced` handler uses on initial connect.
      emitDocumentsChanged(['files', 'backlinks', 'graph']);
      emitBranchChanged(branch);
    },
    observeBranch: async (branch: string) => {
      if (collabUrl === null) return;
      const p = getPool(collabUrl);
      // First observation seeds the pool's branch state without invalidating;
      // subsequent mismatches replay handleBranchSwitched client-side.
      if (p.compareAndUpdateObservedBranch(branch)) {
        await handleBranchSwitched(p, branch);
        emitDocumentsChanged(['files', 'backlinks', 'graph']);
        emitBranchChanged(branch);
      }
    },
    observeDiskAck: (docName: string, sv: Uint8Array) => {
      if (collabUrl === null) return;
      const p = getPool(collabUrl);
      p.observeDiskAck(docName, sv);
    },
    refreshServerInfo: async () => {
      if (collabUrl === null) return;
      const p = getPool(collabUrl);
      await refreshServerInfo(p);
    },
    collabUrl,
    collabTerminal,
    collabLastError,
    retryCollab,
    docPanelMode,
    docPanelAgentId,
    docPanelExpandSignal,
    openActivityPanel: (connectionId: string, targetDoc: string | null) => {
      // No doc selected → the DocPanel isn't mounted, so opening the Activity
      // view below would be a silent no-op. Navigate to the agent's doc first
      // (via the hash — the canonical nav path: App's NavigationHandler
      // `hashchange` → openTargetTransition; `openDocument` bypasses the hash
      // and is a non-resolver/test affordance only). The mode flip + expand
      // signal are React state on DocumentProvider (above EditorArea), so the
      // freshly-mounted DocPanel reads the already-set values and renders in
      // agent mode. Return early so a double-click landing before the
      // hashchange resolves (activeDocName still null) can't fall through to
      // the toggle guard below and flip the just-opened panel back to doc mode.
      if (!activeDocName && targetDoc) {
        navigateToHash(hashFromDocName(targetDoc));
        setDocPanelAgentId(connectionId);
        setDocPanelModeState('agent');
        setDocPanelExpandSignal((prev) => prev + 1);
        return;
      }
      // Toggle / swap / open-with-expand.
      // Same agent already scoped AND already in agent mode → flip back
      // to doc mode (toggle). Anything else → go/stay in agent mode with
      // the new (or same) id AND bump the expand signal so `EditorArea`
      // expands a collapsed panel.
      if (docPanelMode === 'agent' && docPanelAgentId === connectionId) {
        setDocPanelModeState('doc');
        return;
      }
      setDocPanelAgentId(connectionId);
      setDocPanelModeState('agent');
      setDocPanelExpandSignal((prev) => prev + 1);
    },
    closeActivityPanel: () => {
      setDocPanelModeState('doc');
      setDocPanelAgentId(null);
    },
  };

  return <DocumentContext value={value}>{children}</DocumentContext>;
}

/**
 * The blob-runner opener, or null outside a `DocumentProvider`.
 *
 * `HelpPopover` is a generic resources menu, not an editor-only surface: the
 * Navigator window mounts no provider and the menu's own tests render it
 * standalone. Hard-requiring the document context there would trade a menu
 * entry for a crash, so callers hide the row when this is null.
 */
export function useOpenBlobRunner(): (() => void) | null {
  return use(DocumentContext)?.openBlobRunner ?? null;
}

export function useDocumentContext(): DocumentContextValue {
  const ctx = use(DocumentContext);
  if (!ctx) {
    throw new Error('useDocumentContext must be used within <DocumentProvider />');
  }
  return ctx;
}

/**
 * Convenience hook for navigation consumers (`NavigationHandler`,
 * `DocumentErrorBoundary` retry, sidebar click handlers) that only need the
 * nav surface and don't care about the rest of the document context.
 * `openDocumentTransition` is the doc-by-name path; `openTargetTransition`
 * is the folder-aware resolver path (hash-driven nav via `NavigationHandler`).
 * The `*Transition` suffix is a historical name — see the context values'
 * docstrings for why there is no longer a React transition behind it.
 */
export function useDocumentTransition(): {
  openDocumentTransition: (docName: string) => void;
  openTargetTransition: (target: ResolvedNavigationTarget, options?: OpenTargetOptions) => void;
} {
  const { openDocumentTransition, openTargetTransition } = useDocumentContext();
  return { openDocumentTransition, openTargetTransition };
}

// Vite HMR dispose — when this module is hot-replaced in dev, tear down the
// previous pool + the dev-only `window.__*` hooks so the replacement module
// instance doesn't see stale providers, WebSockets, observers, timers, or
// dangling getters bound to the old module's `pool` closure. Without this,
// editing this file in dev leaks every provider + observer ever created,
// and Playwright tests reaching for `window.__test_*` after an HMR reload
// would race the old module's references. Production builds strip this
// branch entirely (Vite replaces `import.meta.hot` with `undefined` at
// build time).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    pool?.dispose();
    pool = null;
    principalFetchWarned = false;
    if (typeof window !== 'undefined') {
      try {
        delete (window as { __providerPool?: unknown }).__providerPool;
        delete (window as { __activeProvider?: unknown }).__activeProvider;
        delete (window as { __activeEditor?: unknown }).__activeEditor;
        delete (window as { __test_rejectSyncPromise?: unknown }).__test_rejectSyncPromise;
        delete (window as { __test_armPendingRejection?: unknown }).__test_armPendingRejection;
        delete (window as { __test_closeActiveWebSocket?: unknown }).__test_closeActiveWebSocket;
      } catch {
        // `delete` can fail on non-configurable properties in older engines;
        // acceptable fall-through in a dev-only cleanup path.
      }
    }
  });
}
