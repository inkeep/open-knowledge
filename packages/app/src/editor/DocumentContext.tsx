import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { Principal } from '@inkeep/open-knowledge-core';
import {
  mediaKindForSidebarAssetExtension,
  PrincipalSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { createContext, type ReactNode, use, useEffect, useRef, useState } from 'react';
import type { ResolvedNavigationTarget } from '@/components/navigation-targets';
import { docNameForNavigationTarget } from '@/components/navigation-targets';
import { consumePrewarmClick } from '@/components/prewarm-correlation';
import {
  assetPathFromHash,
  docNameFromHash,
  hashFromAssetPath,
  hashFromDocName,
  hashFromFolderPath,
  hashFromSkillFile,
  skillFileFromHash,
} from '@/lib/doc-hash';
import { emitBranchChanged, emitDocumentsChanged } from '@/lib/documents-events';
import { mark } from '@/lib/perf';
import { refreshServerInfo } from '@/lib/server-info-refresh';
import { useCollabUrl } from '@/lib/use-collab-url';
import { getEditorForDoc } from './active-editor';
import { handleBranchSwitched } from './branch-invalidation';
import { captureRenameSnapshots, subscribePoolEviction } from './editor-cache';
import {
  addOpenTab,
  addPinnedTab,
  applyDragPinMutation,
  assetTabId,
  createEditorTabSessionState,
  docNameForTabId,
  docTabId,
  filterClosableTabIds,
  filterOpenTabsForKnownTargets,
  folderTabId,
  localTabSessionStorageKey,
  nextActiveTabAfterClose,
  nextActiveTabAfterCloseMany,
  normalizePinnedTabIds,
  openDocTab,
  openTab,
  parseEditorTabId,
  parseEditorTabSessionState,
  readLocalTabSessionState,
  reconcileVisibleTabOrder,
  remapOpenTabs,
  remapVisibleTabsForRename,
  removeOpenTab,
  removePinnedTab,
  skillFileTabId,
  tabIdForNavigationTarget,
  writeLocalTabSessionState,
} from './editor-tabs';
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
  /**
   * User-open tabs, distinct from `poolEntries`: prewarmed providers can be
   * pool-resident without becoming visible tabs. Document tabs use the
   * docName as their ID; folder and asset tabs use internal tab IDs.
   */
  openTabs: ReadonlyArray<string>;
  /** Tab IDs protected from tab-strip close affordances until explicitly unpinned. */
  pinnedTabIds: ReadonlyArray<string>;
  /** Visible tab-strip order across document/folder tabs and ephemeral blank tabs. */
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
  /**
   * Hash-driven navigation entry (`NavigationHandler` in `App.tsx`). Kept
   * alongside `openTarget` for API symmetry with `openDocumentTransition`.
   * Neither wraps the underlying call in `startTransition`; see
   * `openDocumentTransition` for rationale. `openTarget` is retained for
   * non-transition callers (tests, direct agent actions).
   */
  openTargetTransition: (target: ResolvedNavigationTarget, options?: OpenTargetOptions) => void;
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
   * existing effect watching openTabs/pinnedTabIds.
   */
  reorderTabs: (newOrder: readonly string[], draggedTabId: string) => void;
  /** Empty tab placeholders created by the tab strip's New tab button. */
  newTabIds: ReadonlyArray<string>;
  /** The currently active empty tab placeholder, if any. */
  activeNewTabId: string | null;
  /** True when the active editor surface is the empty "New tab" placeholder. */
  isNewTabActive: boolean;
  /** Open an empty tab placeholder that the next sidebar document click can fill. */
  openNewTab: () => void;
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
  }) => void;
  /** Rename visible tabs after a file/folder/asset rename without changing their order. */
  remapTabsForRename: (
    renamed: readonly { fromDocName: string; toDocName: string }[],
    renamedFolders?: readonly { fromPath: string; toPath: string }[],
    renamedAssets?: readonly { fromPath: string; toPath: string }[],
  ) => void;
  /**
   * Close `docName` and synchronously delete its client-side IndexedDB.
   * Used by rename flows so a future open at this name starts from a
   * clean persistence. Without this, moving a doc back to a folder it
   * once occupied would hydrate the new Y.Doc from the leftover IDB
   * rows of the prior session at that name and then append-merge with
   * the server's freshly-loaded content (no shared ancestor → CRDT
   * union-merge), producing visible content duplication. Returns a
   * promise so callers can await IDB deletion before triggering the
   * navigation that opens the new provider.
   */
  closeAndClearForRename: (docName: string) => Promise<void>;
  /**
   * Live read of the pool's currently active doc. Distinct from the
   * React-state `activeDocName` (and its `activeDocNameRef` snapshot in
   * `FileTree`/`EditorTabs`): those reflect committed React state, which
   * lags the pool when an auth-rejection-driven `onRenameRedirect` runs
   * inside an awaited HTTP response — the pool is already re-pointed at
   * `toDocName` before React batches the matching `setActiveTarget`. Used
   * by the post-`/api/rename-path` cleanup in `FileTree.applyRenamedDocuments`
   * and `EditorTabs` to detect that the server-push path already did the
   * close+clear+reopen and to skip a second destructive
   * `closeAndClearForRename(toDocName)` that would tear down the live
   * provider `onRenameRedirect` just opened.
   */
  getPoolActiveDocName: () => string | null;
  /**
   * Live read of whether the pool currently has an entry for `docName`.
   * Parallel to `getPoolActiveDocName` (same access path, same React-state
   * lag concern). Used by `applyRenamedDocuments` to skip the post-rename
   * `closeAndClearForRename(toDocName)` when the destination name was never
   * opened in the pool — the IDB-by-name delete would be a no-op that
   * still registers a transient `pendingClears` entry which races against
   * the subsequent `pool.open(toDocName)` and forces `persistence: null` +
   * deferred attach on the freshly-opened provider.
   */
  poolHas: (docName: string) => boolean;
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

interface OpenTargetOptions {
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

// Module-level singleton — survives React re-renders and StrictMode double-mount.
// Same pattern the old singleton HocuspocusProvider used. Instantiated lazily
// when `collabUrl` resolves — not at module load.
//
// Under Vite HMR the binding resets on module reload; the `import.meta.hot.dispose`
// handler at the bottom of this file disposes the previous pool before the new
// module instance takes over so WebSocket / observer / timer state doesn't leak.
let pool: ProviderPool | null = null;

function getPool(collabUrl: string): ProviderPool {
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
  if (window.okDesktop?.config.mode === 'editor') return null;
  return localTabSessionStorageKey(window.location.origin);
}

function readInitialLocalTabSession() {
  if (typeof window === 'undefined') return parseEditorTabSessionState(null, MAX_POOL);
  const key = getLocalTabSessionKey();
  if (!key) return parseEditorTabSessionState(null, MAX_POOL);
  const storage = typeof window.localStorage !== 'undefined' ? window.localStorage : null;
  return readLocalTabSessionState(storage, key, MAX_POOL);
}

function readInitialLocalTabs(): string[] {
  return readInitialLocalTabSession().openTabs;
}

function readInitialLocalPinnedTabIds(): string[] {
  return readInitialLocalTabSession().pinnedTabIds;
}

function readInitialLocalActiveTabId(): string | null {
  // Hydrate the active-tab selection synchronously from localStorage so the
  // tab UI highlights the correct tab on first paint. A non-empty URL hash
  // is a deep-link and takes precedence — the async hydration effect handles
  // the hash-matches-saved-active case after the desktop bridge resolves.
  if (typeof window === 'undefined') return null;
  if (window.location.hash.length > 0) return null;
  const session = readInitialLocalTabSession();
  return (
    session.activeTabId ??
    (session.activeDocName ? docTabId(session.activeDocName) : null) ??
    session.openTabs[0] ??
    null
  );
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
  }
}

function tabIdFromHash(hash: string): string | null {
  const assetPath = assetPathFromHash(hash);
  if (assetPath) return assetTabId(assetPath);
  const skillFile = skillFileFromHash(hash);
  if (skillFile) return skillFileTabId(skillFile);
  const docName = docNameFromHash(hash);
  if (!docName) return null;
  const trimmed = docName.trim();
  if (/\/+$/.test(trimmed)) {
    const folderPath = trimmed.replace(/\/+$/g, '');
    return folderPath ? folderTabId(folderPath) : null;
  }
  return docTabId(docName);
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

function activeTabIdForTarget(
  activeTarget: ResolvedNavigationTarget | null,
  activeDocName: string | null,
): string | null {
  if (activeTarget) return tabIdForNavigationTarget(activeTarget);
  return activeDocName ? docTabId(activeDocName) : null;
}

function hasOpenDocTab(
  tabs: readonly string[],
  docName: string,
  excluding: ReadonlySet<string>,
): boolean {
  return tabs.some((tabId) => !excluding.has(tabId) && docNameForTabId(tabId) === docName);
}

function sameTabIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tabId, index) => tabId === b[index]);
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
  const [activeTarget, setActiveTarget] = useState<ResolvedNavigationTarget | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(readInitialLocalActiveTabId);
  const [openTabs, setOpenTabs] = useState<string[]>(readInitialLocalTabs);
  const [pinnedTabIds, setPinnedTabIds] = useState(readInitialLocalPinnedTabIds);
  const [newTabIds, setNewTabIds] = useState<string[]>([]);
  const [visibleTabIds, setVisibleTabIds] = useState<string[]>(openTabs);
  const [activeNewTabId, setActiveNewTabId] = useState<string | null>(null);
  const [tabSessionLoaded, setTabSessionLoaded] = useState(false);
  const activeTabIdRef = useRef<string | null>(activeTabId);
  const openTabsRef = useRef<string[]>(openTabs);
  const pinnedTabIdsRef = useRef(pinnedTabIds);
  const activeNewTabIdRef = useRef<string | null>(activeNewTabId);
  const newTabIdsRef = useRef<string[]>(newTabIds);
  const visibleTabIdsRef = useRef<string[]>(visibleTabIds);
  const nextNewTabOrdinalRef = useRef(1);
  const recentlyClosedTabsRef = useRef<string[]>([]);
  // Set true when the user explicitly CLOSES (or unpins/replaces) a tab during
  // the async session-restore window. Bails the restore merge so a freshly-
  // closed tab cannot resurrect from the about-to-arrive restored snapshot.
  //
  // OPENS (hash-nav, sidebar clicks, agent links) intentionally do NOT set this
  // ref — the restore merge below is additive (state.openTabs ∪ openTabsRef.current),
  // so an opened-during-restore tab coexists with the restored set without
  // collision. Earlier code bailed on every mutation, which dropped the entire
  // restore on any open and broke hash-nav-while-restore-pending paths.
  const tabSessionUserClosedRef = useRef(false);
  const [tabIdentityResolved, setTabIdentityResolved] = useState(false);
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

  function commitActiveTabId(nextActiveTabId: string | null) {
    activeTabIdRef.current = nextActiveTabId;
    setActiveTabId(nextActiveTabId);
  }

  function commitActiveNewTabId(nextActiveNewTabId: string | null) {
    activeNewTabIdRef.current = nextActiveNewTabId;
    setActiveNewTabId(nextActiveNewTabId);
  }

  function commitVisibleTabIds(nextVisibleTabIds: string[]) {
    visibleTabIdsRef.current = nextVisibleTabIds;
    setVisibleTabIds((current) =>
      sameTabIds(current, nextVisibleTabIds) ? current : nextVisibleTabIds,
    );
  }

  function commitPinnedTabIds(nextPinnedTabIds: string[]) {
    pinnedTabIdsRef.current = nextPinnedTabIds;
    setPinnedTabIds((current) =>
      sameTabIds(current, nextPinnedTabIds) ? current : nextPinnedTabIds,
    );
  }

  function commitTabState(nextOpenTabs: string[], nextPinnedTabIds: readonly string[]) {
    const normalizedPinnedTabIds = normalizePinnedTabIds(nextPinnedTabIds, nextOpenTabs);
    openTabsRef.current = nextOpenTabs;
    pinnedTabIdsRef.current = normalizedPinnedTabIds;
    setOpenTabs((current) => (sameTabIds(current, nextOpenTabs) ? current : nextOpenTabs));
    setPinnedTabIds((current) =>
      sameTabIds(current, normalizedPinnedTabIds) ? current : normalizedPinnedTabIds,
    );
    commitVisibleTabIds(
      reconcileVisibleTabOrder(visibleTabIdsRef.current, nextOpenTabs, newTabIdsRef.current),
    );
  }

  function commitOpenTabs(nextOpenTabs: string[]) {
    commitTabState(nextOpenTabs, pinnedTabIdsRef.current);
  }

  function updateOpenTabs(updater: (current: string[]) => string[]) {
    commitOpenTabs(updater(openTabsRef.current));
  }

  function commitNewTabIds(nextNewTabIds: string[]) {
    newTabIdsRef.current = nextNewTabIds;
    setNewTabIds((current) => (sameTabIds(current, nextNewTabIds) ? current : nextNewTabIds));
    commitVisibleTabIds(
      reconcileVisibleTabOrder(visibleTabIdsRef.current, openTabsRef.current, nextNewTabIds),
    );
  }

  function removeActiveNewTab(replacementTabId?: string | null) {
    const activeBlankTabId = activeNewTabIdRef.current;
    if (!activeBlankTabId) return;
    const nextNewTabIds = newTabIdsRef.current.filter((tabId) => tabId !== activeBlankTabId);
    newTabIdsRef.current = nextNewTabIds;
    setNewTabIds((current) => (sameTabIds(current, nextNewTabIds) ? current : nextNewTabIds));
    commitActiveNewTabId(null);

    const orderWithReplacement: string[] = [];
    const seen = new Set<string>();
    for (const tabId of visibleTabIdsRef.current) {
      const nextTabId = tabId === activeBlankTabId ? replacementTabId : tabId;
      if (!nextTabId || seen.has(nextTabId)) continue;
      seen.add(nextTabId);
      orderWithReplacement.push(nextTabId);
    }
    commitVisibleTabIds(
      reconcileVisibleTabOrder(orderWithReplacement, openTabsRef.current, nextNewTabIds),
    );
  }

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  useEffect(() => {
    pinnedTabIdsRef.current = pinnedTabIds;
  }, [pinnedTabIds]);

  useEffect(() => {
    activeNewTabIdRef.current = activeNewTabId;
  }, [activeNewTabId]);

  useEffect(() => {
    newTabIdsRef.current = newTabIds;
  }, [newTabIds]);

  useEffect(() => {
    visibleTabIdsRef.current = visibleTabIds;
  }, [visibleTabIds]);

  const isNewTabActive = activeNewTabId !== null;

  useEffect(() => {
    if (collabUrl === null || tabSessionLoaded || !tabIdentityResolved) return;
    let cancelled = false;
    const bridge = getDesktopBridge();
    const localKey = getLocalTabSessionKey();
    const storage = typeof localStorage !== 'undefined' ? localStorage : null;
    const loaded = bridge
      ? bridge.project.getSessionState()
      : Promise.resolve(
          localKey
            ? readLocalTabSessionState(storage, localKey, MAX_POOL)
            : {
                openTabs: [],
                pinnedTabIds: [],
                activeDocName: null,
                activeTabId: null,
                updatedAt: null,
              },
        );

    loaded
      .then((raw) => {
        if (cancelled) return;
        const state = parseEditorTabSessionState(raw, MAX_POOL);
        if (tabSessionUserClosedRef.current) return;
        const p = getPool(collabUrl);
        for (const tabId of state.openTabs) {
          const docName = docNameForTabId(tabId);
          if (docName) p.open(docName);
        }
        const mergedPinnedTabIds = [...state.pinnedTabIds, ...pinnedTabIdsRef.current];
        let nextTabs = state.openTabs;
        for (const tabId of openTabsRef.current) {
          nextTabs = addOpenTab(nextTabs, tabId, MAX_POOL, mergedPinnedTabIds);
        }
        const normalizedPinnedTabIds = normalizePinnedTabIds(mergedPinnedTabIds, nextTabs);
        openTabsRef.current = nextTabs;
        pinnedTabIdsRef.current = normalizedPinnedTabIds;
        setOpenTabs((current) => (sameTabIds(current, nextTabs) ? current : nextTabs));
        setPinnedTabIds((current) =>
          sameTabIds(current, normalizedPinnedTabIds) ? current : normalizedPinnedTabIds,
        );
        const nextVisibleTabIds = reconcileVisibleTabOrder(
          visibleTabIdsRef.current,
          nextTabs,
          newTabIdsRef.current,
        );
        visibleTabIdsRef.current = nextVisibleTabIds;
        setVisibleTabIds((current) =>
          sameTabIds(current, nextVisibleTabIds) ? current : nextVisibleTabIds,
        );
        const currentHashDoc = docNameFromHash(window.location.hash);
        const restoredActive =
          state.activeTabId ??
          (state.activeDocName ? docTabId(state.activeDocName) : null) ??
          state.openTabs[0] ??
          null;
        const restoredActiveHash = restoredActive ? hashFromTabId(restoredActive) : null;
        const shouldRestoreActive =
          (currentHashDoc === null && window.location.hash.length === 0) ||
          (restoredActiveHash !== null && restoredActiveHash === window.location.hash);
        if (shouldRestoreActive && restoredActive) {
          activeTabIdRef.current = restoredActive;
          setActiveTabId(restoredActive);
          const nextHash = hashFromTabId(restoredActive);
          if (window.location.hash !== nextHash) window.location.hash = nextHash;
        }
      })
      .catch((err: unknown) => {
        console.warn('[editor-tabs] failed to restore tab session:', err);
      })
      .finally(() => {
        if (!cancelled) setTabSessionLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [collabUrl, tabIdentityResolved, tabSessionLoaded]);

  useEffect(() => {
    if (!tabSessionLoaded) return;
    const state = createEditorTabSessionState(
      openTabs,
      activeTabId ?? activeTabIdForTarget(activeTarget, snapshot.activeDocName),
      pinnedTabIds,
    );
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
  }, [activeTabId, activeTarget, openTabs, pinnedTabIds, snapshot.activeDocName, tabSessionLoaded]);

  // Closes (and close-like replace-active) during the restore window bail the
  // restore merge. Other mutations (open, pin, activate) are no-ops here because
  // the restore merge is additive — see tabSessionUserClosedRef declaration for
  // the full rationale.
  function markTabSessionClosedDuringRestore() {
    if (!tabSessionLoaded) tabSessionUserClosedRef.current = true;
  }

  useEffect(() => {
    if (collabUrl === null) return;
    let cancelled = false;
    setTabIdentityResolved(false);
    const p = getPool(collabUrl);

    // Sync initial state
    setSnapshot(takeSnapshot(p));

    function commitTabsFromPoolCallback(
      nextOpenTabs: string[],
      nextPinnedTabIds: readonly string[],
    ) {
      const normalizedPinnedTabIds = normalizePinnedTabIds(nextPinnedTabIds, nextOpenTabs);
      openTabsRef.current = nextOpenTabs;
      pinnedTabIdsRef.current = normalizedPinnedTabIds;
      setOpenTabs((current) => (sameTabIds(current, nextOpenTabs) ? current : nextOpenTabs));
      setPinnedTabIds((current) =>
        sameTabIds(current, normalizedPinnedTabIds) ? current : normalizedPinnedTabIds,
      );
      const nextVisibleTabIds = reconcileVisibleTabOrder(
        visibleTabIdsRef.current,
        nextOpenTabs,
        newTabIdsRef.current,
      );
      visibleTabIdsRef.current = nextVisibleTabIds;
      setVisibleTabIds((current) =>
        sameTabIds(current, nextVisibleTabIds) ? current : nextVisibleTabIds,
      );
    }

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
        // Capture before close — closeAndClearPersistence clears the pool's
        // active slot when its argument is the active doc, so we can't read
        // this signal after the fact.
        const wasActive = p.getActiveDocName() === fromDocName;
        captureRenameSnapshots([{ fromDocName, toDocName }]);
        try {
          await Promise.all([
            p.closeAndClearPersistence(fromDocName),
            p.closeAndClearPersistence(toDocName),
          ]);
          // Open a fresh provider so the editor hydrates the new doc.
          // The hash below already points at toDocName, so a file-tree
          // re-click can't recover via `hashchange` if we skip this.
          if (wasActive) {
            p.open(toDocName);
            p.setActive(toDocName);
          }
          const nextOpenTabs = remapOpenTabs(
            openTabsRef.current,
            [{ fromDocName, toDocName }],
            MAX_POOL,
            [],
            pinnedTabIdsRef.current,
          );
          const nextPinnedTabIds = normalizePinnedTabIds(
            remapOpenTabs(
              pinnedTabIdsRef.current,
              [{ fromDocName, toDocName }],
              Number.MAX_SAFE_INTEGER,
            ),
            nextOpenTabs,
          );
          visibleTabIdsRef.current = remapVisibleTabsForRename(visibleTabIdsRef.current, [
            { fromDocName, toDocName },
          ]);
          commitTabsFromPoolCallback(nextOpenTabs, nextPinnedTabIds);
          setActiveTarget((current) => {
            if (!current) return current;
            const currentDocName = docNameForNavigationTarget(current);
            if (currentDocName === fromDocName) {
              return { kind: 'doc', target: toDocName, docName: toDocName };
            }
            return current;
          });
          if (wasActive) {
            window.location.hash = hashFromDocName(toDocName);
          }
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
          await p.closeAndClearPersistence(docName);
          const nextOpenTabs = removeOpenTab(openTabsRef.current, docName);
          commitTabsFromPoolCallback(nextOpenTabs, pinnedTabIdsRef.current);
          setActiveTarget((current) => {
            if (!current) return current;
            return docNameForNavigationTarget(current) === docName ? null : current;
          });
          if (p.getActiveDocName() === docName) {
            window.location.hash = '';
          }
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
    p.setOnChange(() => setSnapshot(takeSnapshot(p)));

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
      })
      .finally(() => {
        if (!cancelled) setTabIdentityResolved(true);
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

  const openDocument = (docName: string) => {
    mark('ok/nav/open-document', { docName, transition: false });
    if (collabUrl === null) return;
    // Intentionally does NOT mark the session as closed-during-restore.
    // Opens are additive: the restore-merge unions state.openTabs with
    // openTabsRef.current, so an opened-during-restore tab coexists with
    // the restored set. Marking would bail the entire restore on the
    // hash-nav-while-restore-pending path.
    const p = getPool(collabUrl);
    const entry = p.open(docName);
    if (!entry) return; // reserved doc (e.g. __system__) — pool refused admission
    // Deterministic prewarm-then-click correlation by poolEventId. Emits
    // ok/sidebar/prewarm-clicked when the entry was prewarmed recently
    // and the IDs match.
    consumePrewarmClick(docName, entry.poolEventId);
    const nextTabId = docTabId(docName);
    updateOpenTabs((current) => addOpenTab(current, nextTabId, MAX_POOL, pinnedTabIdsRef.current));
    removeActiveNewTab(nextTabId);
    commitActiveTabId(nextTabId);
    p.setActive(docName);
    // Set a doc-kind ResolvedNavigationTarget so downstream consumers
    // (EditorArea's isNewDoc, EditorPane's folder-mode effect) stay in sync.
    // openTarget() is the canonical path for folder/missing kinds; openDocument
    // stays as a direct-doc affordance for non-resolver callers (tests, etc.).
    setActiveTarget({ kind: 'doc', target: docName, docName });
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

  const openTargetWithOptions = (
    target: ResolvedNavigationTarget,
    options: OpenTargetOptions = {},
  ) => {
    if (collabUrl === null) return;
    // `replace-active` displaces the previously-active tab (close-like) — must
    // bail the restore merge so it cannot resurrect. Plain opens (any other
    // tabBehavior) are additive; the merge handles them.
    if (options.tabBehavior === 'replace-active') {
      markTabSessionClosedDuringRestore();
    }
    const p = getPool(collabUrl);
    const docName = docNameForNavigationTarget(target);
    const activeBlankTabId = activeNewTabIdRef.current;
    const replacingBlankTab = activeBlankTabId !== null && options.tabBehavior === 'replace-active';
    const currentActiveTabId = activeBlankTabId
      ? null
      : (activeTabIdRef.current ?? activeTabIdForTarget(activeTarget, snapshot.activeDocName));
    const hasCurrentActiveTab =
      currentActiveTabId !== null && openTabsRef.current.includes(currentActiveTabId);
    const currentActiveTabIsPinned =
      currentActiveTabId !== null && pinnedTabIdsRef.current.includes(currentActiveTabId);
    const behavior =
      options.tabBehavior === 'replace-active' && currentActiveTabIsPinned
        ? 'append'
        : options.tabBehavior === 'replace-active' && !replacingBlankTab && !hasCurrentActiveTab
          ? 'append'
          : (options.tabBehavior ?? 'append');
    if (docName && target.kind !== 'large-file') {
      const entry = p.open(docName);
      if (!entry) return;
      consumePrewarmClick(docName, entry.poolEventId);
      const opened = openDocTab(openTabsRef.current, docName, {
        behavior,
        currentTabId: currentActiveTabId,
        limit: MAX_POOL,
        pinnedTabIds: pinnedTabIdsRef.current,
      });
      commitOpenTabs(opened.tabs);
      removeActiveNewTab(opened.activeTabId);
      commitActiveTabId(opened.activeTabId);
      p.setActive(docName);
    } else {
      p.clearActive();
      const nextTabId = tabIdForNavigationTarget(target);
      if (nextTabId) {
        const opened = openTab(openTabsRef.current, nextTabId, {
          behavior,
          currentTabId: currentActiveTabId,
          limit: MAX_POOL,
          pinnedTabIds: pinnedTabIdsRef.current,
        });
        commitOpenTabs(opened.tabs);
        commitActiveTabId(opened.activeTabId);
        removeActiveNewTab(opened.activeTabId);
      } else {
        removeActiveNewTab(nextTabId);
      }
    }
    setActiveTarget((current) => (sameNavigationTarget(current, target) ? current : target));
  };
  const openTarget = (target: ResolvedNavigationTarget, options: OpenTargetOptions = {}) => {
    openTargetWithOptions(target, options);
  };
  const openTargetTransition = (
    target: ResolvedNavigationTarget,
    options: OpenTargetOptions = {},
  ) => {
    const docName = docNameForNavigationTarget(target);
    mark('ok/nav/open-target', { docName, kind: target.kind, transition: false });
    openTargetWithOptions(target, options);
  };

  function pushRecentlyClosedTabs(tabIds: readonly string[]) {
    if (tabIds.length === 0) return;
    recentlyClosedTabsRef.current = [...recentlyClosedTabsRef.current, ...tabIds].slice(-50);
  }

  const activateTabById = (tabId: string) => {
    const tab = parseEditorTabId(tabId);
    commitActiveNewTabId(null);
    commitActiveTabId(tabId);
    if (tab.kind === 'doc') {
      if (collabUrl !== null) {
        const p = getPool(collabUrl);
        const entry = p.open(tab.docName);
        if (!entry) return;
        p.setActive(tab.docName);
      }
      setActiveTarget({ kind: 'doc', target: tab.docName, docName: tab.docName });
      const nextHash = hashFromDocName(tab.docName);
      if (window.location.hash !== nextHash) window.location.hash = nextHash;
      return;
    }
    if (collabUrl !== null) {
      const p = getPool(collabUrl);
      p.clearActive();
    }
    if (tab.kind === 'asset') {
      setActiveTarget(assetTargetForPath(tab.assetPath));
      const nextHash = hashFromAssetPath(tab.assetPath);
      if (window.location.hash !== nextHash) window.location.hash = nextHash;
      return;
    }
    if (tab.kind === 'skill-file') {
      setActiveTarget({
        kind: 'skill-file',
        target: `${tab.scope}/${tab.name}/${tab.path}`,
        scope: tab.scope,
        name: tab.name,
        path: tab.path,
      });
      const nextHash = hashFromSkillFile({ scope: tab.scope, name: tab.name, path: tab.path });
      if (window.location.hash !== nextHash) window.location.hash = nextHash;
      return;
    }
    setActiveTarget({ kind: 'folder', target: tab.folderPath, folderPath: tab.folderPath });
    const nextHash = hashFromFolderPath(tab.folderPath);
    if (window.location.hash !== nextHash) window.location.hash = nextHash;
  };

  const openNewTabById = () => {
    // Open a blank tab — additive, no close-during-restore mark.
    const nextNewTabId = `new-tab:${nextNewTabOrdinalRef.current}`;
    nextNewTabOrdinalRef.current += 1;
    commitNewTabIds([...newTabIdsRef.current, nextNewTabId]);
    commitActiveNewTabId(nextNewTabId);
    if (collabUrl !== null) {
      const p = getPool(collabUrl);
      p.clearActive();
    }
    setActiveTarget(null);
    commitActiveTabId(null);
    if (window.location.hash !== '') {
      window.location.hash = '';
    }
  };

  const closeTabById = (tabId: string) => {
    if (pinnedTabIdsRef.current.includes(tabId)) return;
    if (!openTabsRef.current.includes(tabId)) return;
    markTabSessionClosedDuringRestore();
    let nextActiveTabId: string | null = null;
    const closingDocName = docNameForTabId(tabId);
    pushRecentlyClosedTabs([tabId]);
    if (collabUrl !== null) {
      const p = getPool(collabUrl);
      if (closingDocName && !hasOpenDocTab(openTabsRef.current, closingDocName, new Set([tabId]))) {
        p.close(closingDocName);
      }
    }
    const currentActiveTabId =
      activeTabId ?? activeTabIdForTarget(activeTarget, snapshot.activeDocName);
    updateOpenTabs((current) => {
      nextActiveTabId = nextActiveTabAfterClose(current, currentActiveTabId, tabId);
      return removeOpenTab(current, tabId);
    });
    if (currentActiveTabId !== tabId) return;
    if (nextActiveTabId) {
      commitActiveTabId(nextActiveTabId);
      window.location.hash = hashFromTabId(nextActiveTabId);
      return;
    }
    if (collabUrl !== null) {
      const p = getPool(collabUrl);
      p.clearActive();
    }
    setActiveTarget(null);
    commitActiveTabId(null);
    window.location.hash = '';
  };

  const closeNewTabById = (tabId: string) => {
    markTabSessionClosedDuringRestore();
    const currentNewTabIds = newTabIdsRef.current;
    if (!currentNewTabIds.includes(tabId)) return;
    const nextNewTabIds = currentNewTabIds.filter((id) => id !== tabId);
    commitNewTabIds(nextNewTabIds);
    if (activeNewTabIdRef.current !== tabId) return;

    const closedIndex = currentNewTabIds.indexOf(tabId);
    const nextNewTabId = nextNewTabIds[closedIndex] ?? nextNewTabIds[closedIndex - 1] ?? null;
    if (nextNewTabId) {
      commitActiveNewTabId(nextNewTabId);
      if (collabUrl !== null) {
        const p = getPool(collabUrl);
        p.clearActive();
      }
      setActiveTarget(null);
      commitActiveTabId(null);
      if (window.location.hash !== '') {
        window.location.hash = '';
      }
      return;
    }

    commitActiveNewTabId(null);
    const nextActiveTabId = openTabsRef.current[openTabsRef.current.length - 1] ?? null;
    if (nextActiveTabId) {
      commitActiveTabId(nextActiveTabId);
      window.location.hash = hashFromTabId(nextActiveTabId);
      return;
    }
    if (collabUrl !== null) {
      const p = getPool(collabUrl);
      p.clearActive();
    }
    setActiveTarget(null);
    commitActiveTabId(null);
    window.location.hash = '';
  };

  const closeActiveTabOrWindow = (): boolean => {
    const activeNewTab = activeNewTabIdRef.current;
    if (activeNewTab) {
      closeNewTabById(activeNewTab);
      return true;
    }

    const pinnedTabSet = new Set(pinnedTabIdsRef.current);
    const openTabSet = new Set(openTabsRef.current.filter((id) => !pinnedTabSet.has(id)));
    const activeOpenTab =
      activeTabIdRef.current && openTabSet.has(activeTabIdRef.current)
        ? activeTabIdRef.current
        : null;
    const targetTabId = activeOpenTab ?? visibleTabIdsRef.current.find((id) => openTabSet.has(id));
    if (targetTabId) {
      closeTabById(targetTabId);
      return true;
    }

    const newTabSet = new Set(newTabIdsRef.current);
    const targetNewTabId = visibleTabIdsRef.current.find((id) => newTabSet.has(id));
    if (targetNewTabId) {
      closeNewTabById(targetNewTabId);
      return true;
    }

    return false;
  };

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    return bridge.onMenuAction((action) => {
      if (action !== 'close-active-tab-or-window') return;
      if (!closeActiveTabOrWindow()) window.close();
    });
  }, [
    // biome-ignore lint/correctness/useExhaustiveDependencies: closeActiveTabOrWindow is render-bound; re-subscribing keeps the desktop menu handler fresh for current tab state.
    closeActiveTabOrWindow,
  ]);

  const value: DocumentContextValue = {
    principal,
    activeTarget,
    activeTabId,
    activeDocName: snapshot.activeDocName,
    activeProvider: snapshot.activeProvider,
    openTabs,
    pinnedTabIds,
    visibleTabIds,
    tabSessionLoaded,
    syncState: snapshot.syncState,
    serverRestartRecovery: snapshot.serverRestartRecovery,
    poolEntries: snapshot.poolEntries,
    openDocument,
    openDocumentTransition,
    openTarget,
    openTargetTransition,
    clearTarget: () => {
      if (collabUrl === null) {
        setActiveTarget((current) => (current === null ? current : null));
        activeTabIdRef.current = null;
        setActiveTabId((current) => (current === null ? current : null));
        return;
      }
      const p = getPool(collabUrl);
      if (p.getActiveDocName() !== null) p.clearActive();
      setActiveTarget((current) => (current === null ? current : null));
      activeTabIdRef.current = null;
      setActiveTabId((current) => (current === null ? current : null));
    },
    closeDocument: (docName: string) => {
      if (collabUrl === null) return;
      markTabSessionClosedDuringRestore();
      const p = getPool(collabUrl);
      p.close(docName);
      updateOpenTabs((current) => removeOpenTab(current, docTabId(docName)));
      setActiveTabId((current) => {
        const next = current && docNameForTabId(current) === docName ? null : current;
        activeTabIdRef.current = next;
        return next;
      });
      setActiveTarget((current) => {
        if (!current) return current;
        return docNameForNavigationTarget(current) === docName ? null : current;
      });
    },
    closeActiveTabOrWindow,
    closeTab: closeTabById,
    pinTab: (tabId: string) => {
      const nextPinnedTabIds = addPinnedTab(pinnedTabIdsRef.current, tabId, openTabsRef.current);
      if (sameTabIds(pinnedTabIdsRef.current, nextPinnedTabIds)) return;
      // Pin is additive; the restore merge unions pinned IDs. No close-during-restore mark.
      commitPinnedTabIds(nextPinnedTabIds);
    },
    unpinTab: (tabId: string) => {
      const nextPinnedTabIds = removePinnedTab(pinnedTabIdsRef.current, tabId);
      if (sameTabIds(pinnedTabIdsRef.current, nextPinnedTabIds)) return;
      // Unpin removes a tab from the pinned set — close-like for the pinned slot.
      // Mark so the restore merge doesn't re-pin it from the restored snapshot.
      markTabSessionClosedDuringRestore();
      commitPinnedTabIds(nextPinnedTabIds);
    },
    activateTab: (tabId: string) => {
      // Activate doesn't open/close tabs — only changes the active tab. The
      // restore's shouldRestoreActive gate respects the current hash, so no mark.
      activateTabById(tabId);
    },
    reorderTabs: (newOrder: readonly string[], draggedTabId: string) => {
      // Tab drag-reorder. newOrder is the desired visibleTabIds order after
      // a drop — a mix of openTab IDs and new-tab placeholders. Only the
      // dragged tab's pin state can flip, and only if it crossed the
      // pinned/unpinned divide (see applyDragPinMutation + the interface doc
      // above). Persistence rides the existing openTabs/pinnedTabIds effect.
      const openTabsSet = new Set(openTabsRef.current);
      const newTabIdsSet = new Set(newTabIdsRef.current);
      const seen = new Set<string>();
      const nextOpenTabs: string[] = [];
      const nextNewTabIds: string[] = [];
      const seedVisibleTabIds: string[] = [];
      for (const tabId of newOrder) {
        if (seen.has(tabId)) continue;
        if (openTabsSet.has(tabId)) {
          nextOpenTabs.push(tabId);
          seedVisibleTabIds.push(tabId);
          seen.add(tabId);
        } else if (newTabIdsSet.has(tabId)) {
          nextNewTabIds.push(tabId);
          seedVisibleTabIds.push(tabId);
          seen.add(tabId);
        }
      }
      // Defensive: append any open/new tab id the caller forgot to include so
      // we never silently drop a tab. The caller (EditorTabs handleDragEnd)
      // passes visibleTabIds, so this is a backstop.
      for (const tabId of openTabsRef.current) {
        if (!seen.has(tabId)) {
          nextOpenTabs.push(tabId);
          seedVisibleTabIds.push(tabId);
          seen.add(tabId);
        }
      }
      for (const tabId of newTabIdsRef.current) {
        if (!seen.has(tabId)) {
          nextNewTabIds.push(tabId);
          seedVisibleTabIds.push(tabId);
          seen.add(tabId);
        }
      }
      const sameOpenOrder = sameTabIds(openTabsRef.current, nextOpenTabs);
      const sameNewOrder = sameTabIds(newTabIdsRef.current, nextNewTabIds);
      // Dragging a new-tab placeholder among doc-tabs (or vice versa) leaves
      // the per-bucket orders unchanged but mutates the visible interleave —
      // checking only the buckets early-returns valid reorders and drops them
      // on the floor.
      const sameVisibleOrder = sameTabIds(visibleTabIdsRef.current, seedVisibleTabIds);
      if (sameOpenOrder && sameNewOrder && sameVisibleOrder) return;
      // Reorder changes positions only — no opens/closes. The restore merge
      // preserves the restored order; user's drag is then persisted by the
      // next save effect. No close-during-restore mark needed.
      // Seed visibleTabIdsRef so commitTabState's reconcileVisibleTabOrder
      // uses the new drag-determined order as its starting point.
      visibleTabIdsRef.current = seedVisibleTabIds;
      if (!sameNewOrder) {
        newTabIdsRef.current = nextNewTabIds;
        setNewTabIds((current) => (sameTabIds(current, nextNewTabIds) ? current : nextNewTabIds));
      }
      const nextPinnedTabIds = applyDragPinMutation(
        nextOpenTabs,
        pinnedTabIdsRef.current,
        draggedTabId,
      );
      commitTabState(nextOpenTabs, nextPinnedTabIds);
    },
    newTabIds,
    activeNewTabId,
    isNewTabActive,
    openNewTab: openNewTabById,
    activateNewTab: (tabId: string) => {
      // Activate only — no open/close. No close-during-restore mark.
      if (!newTabIdsRef.current.includes(tabId)) return;
      if (collabUrl !== null) {
        const p = getPool(collabUrl);
        p.clearActive();
      }
      setActiveTarget(null);
      commitActiveTabId(null);
      commitActiveNewTabId(tabId);
      if (window.location.hash !== '') {
        window.location.hash = '';
      }
    },
    closeNewTab: closeNewTabById,
    reopenClosedTab: () => {
      const stack = [...recentlyClosedTabsRef.current];
      while (stack.length > 0) {
        const tabId = stack.pop();
        if (!tabId) continue;
        if (openTabsRef.current.includes(tabId)) {
          recentlyClosedTabsRef.current = stack;
          continue;
        }
        const nextOpenTabs = addOpenTab(
          openTabsRef.current,
          tabId,
          MAX_POOL,
          pinnedTabIdsRef.current,
        );
        if (!nextOpenTabs.includes(tabId)) return;
        recentlyClosedTabsRef.current = stack;
        commitOpenTabs(nextOpenTabs);
        activateTabById(tabId);
        return;
      }
      recentlyClosedTabsRef.current = [];
    },
    closeTabs: (tabIds: readonly string[], options: CloseTabsOptions = {}) => {
      const requestedTabIds = tabIds.filter((tabId) => tabId.length > 0);
      const closingTabIds = new Set(
        options.force
          ? requestedTabIds
          : filterClosableTabIds(requestedTabIds, pinnedTabIdsRef.current),
      );
      if (closingTabIds.size === 0) return;
      markTabSessionClosedDuringRestore();
      if (!options.force) {
        pushRecentlyClosedTabs(openTabsRef.current.filter((tabId) => closingTabIds.has(tabId)));
      }
      if (collabUrl !== null) {
        const p = getPool(collabUrl);
        const closingByDocName = new Map<string, Set<string>>();
        for (const tabId of closingTabIds) {
          const docName = docNameForTabId(tabId);
          if (!docName) continue;
          const tabsForDoc = closingByDocName.get(docName) ?? new Set<string>();
          tabsForDoc.add(tabId);
          closingByDocName.set(docName, tabsForDoc);
        }
        for (const [docName, tabsForDoc] of closingByDocName) {
          if (!hasOpenDocTab(openTabsRef.current, docName, tabsForDoc)) p.close(docName);
        }
      }

      let nextActiveTabId: string | null = null;
      const currentActiveTabId =
        activeTabId ?? activeTabIdForTarget(activeTarget, snapshot.activeDocName);
      updateOpenTabs((current) => {
        nextActiveTabId = nextActiveTabAfterCloseMany(current, currentActiveTabId, closingTabIds);
        return current.filter((tabId) => !closingTabIds.has(tabId));
      });

      if (!currentActiveTabId || !closingTabIds.has(currentActiveTabId)) {
        if (!currentActiveTabId) {
          setActiveTarget((current) => {
            if (!current) return current;
            const targetTabId = tabIdForNavigationTarget(current);
            return targetTabId && closingTabIds.has(targetTabId) ? null : current;
          });
        }
        return;
      }
      if (nextActiveTabId) {
        commitActiveTabId(nextActiveTabId);
        window.location.hash = hashFromTabId(nextActiveTabId);
        return;
      }
      if (collabUrl !== null) {
        const p = getPool(collabUrl);
        p.clearActive();
      }
      setActiveTarget(null);
      commitActiveTabId(null);
      window.location.hash = '';
    },
    syncOpenTabsWithKnownTargets: ({ pages, folderPaths, assetPaths }) => {
      const keepMissingDocName = activeTarget?.kind === 'missing' ? activeTarget.target : null;
      // Never evict the doc the hash currently points at: on cold start the page
      // list arrives empty-then-populated, and a sync firing in that window would
      // otherwise prune the just-seeded doc and clear the hash (→ empty-state
      // splash) before the nav effect resolves it to a `missing` target. This is
      // order-independent insurance over `keepMissingDocName`, which the prune
      // can race ahead of.
      const keepHashDocName =
        typeof window !== 'undefined' ? docNameFromHash(window.location.hash) : null;
      const nextOpenTabs = filterOpenTabsForKnownTargets(openTabs, {
        pages,
        folderPaths,
        assetPaths,
        keepMissingDocName,
        keepHashDocName,
      });
      if (nextOpenTabs.length === openTabs.length) return;

      const nextTabIds = new Set(nextOpenTabs);
      const staleTabIds = openTabs.filter((tabId) => !nextTabIds.has(tabId));
      const staleTabIdSet = new Set(staleTabIds);
      markTabSessionClosedDuringRestore();

      if (collabUrl !== null) {
        const p = getPool(collabUrl);
        for (const tabId of staleTabIds) {
          const docName = docNameForTabId(tabId);
          if (docName) p.close(docName);
        }
      }

      commitOpenTabs(nextOpenTabs);

      const hashTabId = typeof window !== 'undefined' ? tabIdFromHash(window.location.hash) : null;
      const currentActiveTabId =
        activeTabId ?? activeTabIdForTarget(activeTarget, snapshot.activeDocName);
      const tabToReplace =
        hashTabId && staleTabIdSet.has(hashTabId)
          ? hashTabId
          : currentActiveTabId && staleTabIdSet.has(currentActiveTabId)
            ? currentActiveTabId
            : null;

      if (!tabToReplace) {
        setActiveTarget((current) => {
          if (!current) return current;
          const targetTabId = tabIdForNavigationTarget(current);
          return targetTabId && staleTabIdSet.has(targetTabId) ? null : current;
        });
        return;
      }

      const nextActiveTabId = nextActiveTabAfterCloseMany(openTabs, tabToReplace, staleTabIds);
      if (nextActiveTabId) {
        commitActiveTabId(nextActiveTabId);
        window.location.hash = hashFromTabId(nextActiveTabId);
        return;
      }
      if (collabUrl !== null) {
        const p = getPool(collabUrl);
        p.clearActive();
      }
      setActiveTarget(null);
      commitActiveTabId(null);
      window.location.hash = '';
    },
    remapTabsForRename: (renamed, renamedFolders = [], renamedAssets = []) => {
      // Rename changes tab identity (old name closed, new name opened) — must
      // mark so the restore merge doesn't resurrect the old identity.
      markTabSessionClosedDuringRestore();
      const next = remapOpenTabs(
        openTabsRef.current,
        renamed,
        MAX_POOL,
        renamedFolders,
        pinnedTabIdsRef.current,
        renamedAssets,
      );
      const nextPinnedTabIds = normalizePinnedTabIds(
        remapOpenTabs(
          pinnedTabIdsRef.current,
          renamed,
          Number.MAX_SAFE_INTEGER,
          renamedFolders,
          [],
          renamedAssets,
        ),
        next,
      );
      if (collabUrl !== null) {
        const p = getPool(collabUrl);
        for (const tabId of next) {
          const docName = docNameForTabId(tabId);
          if (docName) p.open(docName);
        }
      }
      visibleTabIdsRef.current = remapVisibleTabsForRename(
        visibleTabIdsRef.current,
        renamed,
        renamedFolders,
        renamedAssets,
      );
      commitTabState(next, nextPinnedTabIds);
      const currentActiveTabId = activeTabIdRef.current;
      if (currentActiveTabId) {
        const remappedActiveTabId = remapOpenTabs(
          [currentActiveTabId],
          renamed,
          1,
          renamedFolders,
          [],
          renamedAssets,
        )[0];
        if (remappedActiveTabId && next.includes(remappedActiveTabId)) {
          commitActiveTabId(remappedActiveTabId);
        }
      }
    },
    closeAndClearForRename: async (docName: string) => {
      if (collabUrl === null) return;
      const p = getPool(collabUrl);
      await p.closeAndClearPersistence(docName);
      setActiveTarget((current) => {
        if (!current) return current;
        return docNameForNavigationTarget(current) === docName ? null : current;
      });
    },
    getPoolActiveDocName: () => {
      if (collabUrl === null) return null;
      return getPool(collabUrl).getActiveDocName();
    },
    poolHas: (docName: string) => {
      if (collabUrl === null) return false;
      return getPool(collabUrl).has(docName);
    },
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
      if (!snapshot.activeDocName && targetDoc) {
        window.location.hash = hashFromDocName(targetDoc);
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
