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
  type ContentRecycleNotice,
  recordBranchMismatchDispatch,
} from '@/lib/branch-recycle-notice';
import {
  assetPathFromHash,
  docNameFromHash,
  hashFromAssetPath,
  hashFromDocName,
  hashFromFolderPath,
  hashFromSkillFile,
  hashFromSkillPreview,
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
import { resolveSyncWorkspace } from '@/lib/use-workspace';
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
  staleLocalSkillPreviewTwins,
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

export interface PoolEntrySnapshot {
  docName: string;
  provider: HocuspocusProvider;
  lastAccessedAt: number;
  poolEventId: string;
}

interface DocumentContextValue {
  principal: Principal | null;
  activeTarget: ResolvedNavigationTarget | null;
  activeTabId: string | null;
  activeDocName: string | null;
  activeProvider: HocuspocusProvider | null;
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
  openTabs: ReadonlyArray<string>;
  pinnedTabIds: ReadonlyArray<string>;
  visibleTabIdsByPane: ReadonlyMap<EditorPaneId, ReadonlyArray<string>>;
  previewTabIdsByPane: ReadonlyMap<EditorPaneId, string | null>;
  visibleTabIds: ReadonlyArray<string>;
  tabSessionLoaded: boolean;
  syncState: SyncState;
  serverRestartRecovery: ServerRestartRecoveryState;
  poolEntries: ReadonlyArray<PoolEntrySnapshot>;
  openDocument: (docName: string) => void;
  openDocumentTransition: (docName: string) => void;
  openTarget: (target: ResolvedNavigationTarget, options?: OpenTargetOptions) => void;
  openTargetInPane: (
    paneId: EditorPaneId,
    target: ResolvedNavigationTarget,
    options?: OpenTargetOptions,
  ) => void;
  openTargetTransition: (target: ResolvedNavigationTarget, options?: OpenTargetOptions) => void;
  promoteTabInPane: (paneId: EditorPaneId, tabId: string) => void;
  promoteAllPreviewTabs: () => void;
  clearTarget: () => void;
  closeDocument: (docName: string) => void;
  closeActiveTabOrWindow: () => boolean;
  closeTab: (tabId: string) => void;
  pinTab: (tabId: string) => void;
  unpinTab: (tabId: string) => void;
  activateTab: (tabId: string) => void;
  reorderTabs: (newOrder: readonly string[], draggedTabId: string) => void;
  newTabIds: ReadonlyArray<string>;
  activeNewTabId: string | null;
  isNewTabActive: boolean;
  openNewTab: () => void;
  openBlobRunner: () => void;
  activateNewTab: (tabId: string) => void;
  closeNewTab: (tabId: string) => void;
  reopenClosedTab: () => void;
  closeTabs: (tabIds: readonly string[], options?: CloseTabsOptions) => void;
  syncOpenTabsWithKnownTargets: (targets: {
    pages: ReadonlySet<string>;
    folderPaths: ReadonlySet<string>;
    assetPaths: ReadonlySet<string>;
    filePaths?: ReadonlySet<string>;
  }) => void;
  reconcileLocalRename: (input: LocalRenameReconciliation) => Promise<void>;
  reconcileLocalRemoval: (input: LocalRemovalReconciliation) => Promise<void>;
  recycleDocument: (docName: string) => void;
  prewarm: (docName: string) => string | null;
  systemProvider: HocuspocusProvider | null;
  setSystemProvider: (provider: HocuspocusProvider | null) => void;
  updateServerInstanceId: (id: string | null) => void;
  onBranchSwitched: (branch: string) => Promise<void>;
  observeBranch: (branch: string) => Promise<void>;
  observeDiskAck: (docName: string, sv: Uint8Array) => void;
  refreshServerInfo: () => Promise<void>;
  collabUrl: string | null;
  collabTerminal: boolean;
  collabLastError:
    | { kind: 'error'; code: number | 'network' | 'invalid-body' }
    | { kind: 'null-collab' }
    | null;
  retryCollab: () => void;
  contentRecycleNotice: ContentRecycleNotice | null;
  dismissContentRecycleNotice: () => void;
  docPanelMode: 'doc' | 'agent';
  docPanelAgentId: string | null;
  docPanelExpandSignal: number;
  openActivityPanel: (connectionId: string, targetDoc: string | null) => void;
  closeActivityPanel: () => void;
}

export interface OpenTargetOptions {
  disposition?: TabOpenDisposition;
  consumeActiveNewTab?: boolean;
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

let pool: ProviderPool | null = null;

export function getPool(collabUrl: string): ProviderPool {
  if (!pool) {
    pool = new ProviderPool(MAX_POOL, collabUrl, {
      storageNamespace: resolveSyncWorkspace()?.contentDir ?? null,
    });
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

const NEW_TAB_PREFIX = 'new-tab:';

const BLOB_RUNNER_NEW_TAB_PREFIX = 'new-tab:blob-runner:';

export type NewTabSurface = 'files' | 'blob-runner';

const NEW_TAB_PREFIX_BY_SURFACE: Record<NewTabSurface, string> = {
  files: NEW_TAB_PREFIX,
  'blob-runner': BLOB_RUNNER_NEW_TAB_PREFIX,
};

function newTabSurfaceOf(tabId: string): NewTabSurface {
  if (isBlobRunnerNewTabId(tabId)) return 'blob-runner';
  return 'files';
}
export function isBlobRunnerNewTabId(id: string | null | undefined): boolean {
  return id?.startsWith(BLOB_RUNNER_NEW_TAB_PREFIX) ?? false;
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
        level: tab.level,
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

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a === b) return true;
  if (
    a.activeDocName !== b.activeDocName ||
    a.activeProvider !== b.activeProvider ||
    a.syncState !== b.syncState ||
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
  const openTabs = flattenWorkspaceTabs(workspace);
  const pinnedTabIds = flattenWorkspacePinnedTabs(workspace);
  const previewTabIdsByPane = new Map(
    workspace.panes.map((pane) => [pane.id, pane.previewTabId] as const),
  );
  const visibleTabIds = reconcileVisibleTabOrder(
    visibleTabIdsByPane.get(currentPane.id) ?? [],
    currentPane.openTabs,
    currentPane.newTabIds,
  );
  const [tabSessionLoaded, setTabSessionLoaded] = useState(false);
  const nextNewTabOrdinalRef = useRef(1);
  const nextPaneOrdinalRef = useRef(1);
  const recentlyClosedTabsRef = useRef<RecentlyClosedEditorTab[]>([]);
  const removalReconcilerRef = useRef<ClientRemovalReconciler | null>(null);
  const tabSessionUserClosedRef = useRef(false);
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
  const [contentRecycleNotice, setContentRecycleNotice] = useState<ContentRecycleNotice | null>(
    null,
  );
  const branchMismatchTimesRef = useRef<number[]>([]);

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

  const surfaceWorkspace = workspaceWithResolvedTargets(
    projectVisibleEditorWorkspace(workspace, visibleTabIdsByPane),
  );
  const surfacePane = focusedPane(surfaceWorkspace);

  // biome-ignore lint/correctness/useExhaustiveDependencies: workspace mutations read the live ref; collaboration readiness and load state are the restore triggers.
  useEffect(() => {
    if (collabUrl === null || tabSessionLoaded) return;
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
    const state = createEditorTabSessionState(workspace);
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

    return workspaceAfterClose;
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
      showDocumentDeletedState: (docName) =>
        isNoteWindow() ? markNoteWindowDocDeleted(docName) : false,
    });
  }

  useEffect(() => {
    removalReconcilerRef.current = createRemovalReconciler();
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: pool wiring is scoped to the collab URL; callbacks read the live workspace ref.
  useEffect(() => {
    if (collabUrl === null) return;
    let cancelled = false;
    const p = getPool(collabUrl);

    const commitSnapshot = () => {
      setSnapshot((current) => {
        const next = takeSnapshot(p);
        return sameSnapshot(current, next) ? current : next;
      });
    };

    commitSnapshot();
    syncPoolToWorkspace(workspaceRef.current);

    p.setOnBranchMismatch(() => {
      const { times, escalate } = recordBranchMismatchDispatch(
        branchMismatchTimesRef.current,
        Date.now(),
      );
      branchMismatchTimesRef.current = times;
      if (escalate) setContentRecycleNotice({ kind: 'refused', at: Date.now() });
      return refreshServerInfo(p);
    });

    p.setOnRenameRedirect(({ fromDocName, toDocName, hadOpenProvider }) => {
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

    p.setOnChange(commitSnapshot);

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

    void refreshServerInfo(p);

    if (import.meta.env.DEV) {
      window.__providerPool = p;
      Object.defineProperty(window, '__activeProvider', {
        get: () => p.getActive()?.provider ?? null,
        configurable: true,
      });
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
      nextWorkspace = transitionEditorWorkspace(nextWorkspace, {
        type: 'activate-tab',
        paneId,
        tabId: surfacePane.activeTabId,
      }).workspace;
    } else if (surfacePane?.activeNewTabId && surfacePane.activeNewTabId !== pane.activeNewTabId) {
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
  const openDocumentTransition = (docName: string) => {
    mark('ok/nav/open-document', { docName, transition: false });
    openDocument(docName);
  };

  function activateOrOpenSurfaceNewTab(paneId: EditorPaneId, surface: NewTabSurface) {
    const pane = workspaceRef.current.panes.find((candidate) => candidate.id === paneId);
    if (!pane) return;
    const activeOnSurface =
      pane.activeNewTabId !== null && newTabSurfaceOf(pane.activeNewTabId) === surface
        ? pane.activeNewTabId
        : null;
    const existingTabId =
      activeOnSurface ?? pane.newTabIds.find((tabId) => newTabSurfaceOf(tabId) === surface);
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
      activateOrOpenSurfaceNewTab(paneId, 'files');
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
    let nextWorkspace = transition.workspace;
    if (target.kind === 'skill-preview' && target.level) {
      const twins = new Set(
        staleLocalSkillPreviewTwins(
          flattenWorkspaceTabs(nextWorkspace),
          {
            flavor: target.flavor,
            name: target.name,
            subtitle: target.subtitle ?? '',
            level: target.level,
          },
          nextTabId,
        ),
      );
      if (twins.size > 0) {
        markTabSessionClosedDuringRestore();
        for (const paneId of nextWorkspace.panes.map((pane) => pane.id)) {
          const pane = nextWorkspace.panes.find((candidate) => candidate.id === paneId);
          if (!pane) continue;
          const inPane = pane.openTabs.filter((tabId) => twins.has(tabId));
          if (inPane.length === 0) continue;
          nextWorkspace = transitionEditorWorkspace(nextWorkspace, {
            type: 'close-tabs',
            paneId,
            tabIds: inPane,
          }).workspace;
        }
        closeProvidersWithoutOpenTabs(twins, nextWorkspace);
      }
    }
    commitWorkspace(nextWorkspace);
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
    const prefix = NEW_TAB_PREFIX;
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
    commitWorkspace(nextWorkspace, workspaceRef.current.focusedPaneId === paneId && wasActive);
  };
  const closeNewTabById = (tabId: string) =>
    closeNewTabInPaneById(workspaceRef.current.focusedPaneId, tabId);

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
    visibleTabIdsByPane,
    previewTabIdsByPane,
    visibleTabIds,
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
      if (pane.activeNewTabId !== null) return;
      if (pane.openTabs.length === 0 && pane.newTabIds.length === 0) return;
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
      const keepHashDocName =
        typeof window !== 'undefined' ? docNameFromHash(window.location.hash) : null;
      const keepFolderPaths = new Set(
        workspaceRef.current.panes.flatMap((pane) =>
          pane.activeTarget?.kind === 'folder' ? [pane.activeTarget.folderPath] : [],
        ),
      );
      const allOpenTabs = flattenWorkspaceTabs(workspaceRef.current);
      const nextOpenTabs = filterOpenTabsForKnownTargets(allOpenTabs, {
        pages: new Set([...pages, ...missingDocNames]),
        folderPaths,
        assetPaths,
        filePaths,
        keepMissingDocName: null,
        keepHashDocName,
        keepFolderPaths,
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
      branchMismatchTimesRef.current = [];
      setContentRecycleNotice({ kind: 'branch-switch', branch, at: Date.now() });
      await handleBranchSwitched(p, branch);
      emitDocumentsChanged(['files', 'backlinks', 'graph']);
      emitBranchChanged(branch);
    },
    observeBranch: async (branch: string) => {
      if (collabUrl === null) return;
      const p = getPool(collabUrl);
      if (p.compareAndUpdateObservedBranch(branch)) {
        branchMismatchTimesRef.current = [];
        setContentRecycleNotice({ kind: 'branch-switch', branch, at: Date.now() });
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
    contentRecycleNotice,
    dismissContentRecycleNotice: () => setContentRecycleNotice(null),
    collabLastError,
    retryCollab,
    docPanelMode,
    docPanelAgentId,
    docPanelExpandSignal,
    openActivityPanel: (connectionId: string, targetDoc: string | null) => {
      if (!activeDocName && targetDoc) {
        navigateToHash(hashFromDocName(targetDoc));
        setDocPanelAgentId(connectionId);
        setDocPanelModeState('agent');
        setDocPanelExpandSignal((prev) => prev + 1);
        return;
      }
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

export function useDocumentTransition(): {
  openDocumentTransition: (docName: string) => void;
  openTargetTransition: (target: ResolvedNavigationTarget, options?: OpenTargetOptions) => void;
} {
  const { openDocumentTransition, openTargetTransition } = useDocumentContext();
  return { openDocumentTransition, openTargetTransition };
}

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
      } catch {}
    }
  });
}
