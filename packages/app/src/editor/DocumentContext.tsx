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
  openTabs: ReadonlyArray<string>;
  pinnedTabIds: ReadonlyArray<string>;
  visibleTabIds: ReadonlyArray<string>;
  tabSessionLoaded: boolean;
  syncState: SyncState;
  serverRestartRecovery: ServerRestartRecoveryState;
  poolEntries: ReadonlyArray<PoolEntrySnapshot>;
  openDocument: (docName: string) => void;
  openDocumentTransition: (docName: string) => void;
  openTarget: (target: ResolvedNavigationTarget, options?: OpenTargetOptions) => void;
  openTargetTransition: (target: ResolvedNavigationTarget, options?: OpenTargetOptions) => void;
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
  activateNewTab: (tabId: string) => void;
  closeNewTab: (tabId: string) => void;
  closeTabs: (tabIds: readonly string[], options?: CloseTabsOptions) => void;
  syncOpenTabsWithKnownTargets: (targets: {
    pages: ReadonlySet<string>;
    folderPaths: ReadonlySet<string>;
    assetPaths: ReadonlySet<string>;
  }) => void;
  remapTabsForRename: (
    renamed: readonly { fromDocName: string; toDocName: string }[],
    renamedFolders?: readonly { fromPath: string; toPath: string }[],
    renamedAssets?: readonly { fromPath: string; toPath: string }[],
  ) => void;
  closeAndClearForRename: (docName: string) => Promise<void>;
  getPoolActiveDocName: () => string | null;
  poolHas: (docName: string) => boolean;
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
  docPanelMode: 'doc' | 'agent';
  docPanelAgentId: string | null;
  docPanelExpandSignal: number;
  openActivityPanel: (connectionId: string, targetDoc: string | null) => void;
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

let pool: ProviderPool | null = null;

function getPool(collabUrl: string): ProviderPool {
  if (!pool) {
    pool = new ProviderPool(MAX_POOL, collabUrl);
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

  function markTabSessionClosedDuringRestore() {
    if (!tabSessionLoaded) tabSessionUserClosedRef.current = true;
  }

  useEffect(() => {
    if (collabUrl === null) return;
    let cancelled = false;
    setTabIdentityResolved(false);
    const p = getPool(collabUrl);

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

    p.setOnBranchMismatch(() => refreshServerInfo(p));

    p.setOnRenameRedirect(({ fromDocName, toDocName, hadOpenProvider }) => {
      void (async () => {
        let cleanupError: unknown;
        const wasActive = p.getActiveDocName() === fromDocName;
        captureRenameSnapshots([{ fromDocName, toDocName }]);
        try {
          await Promise.all([
            p.closeAndClearPersistence(fromDocName),
            p.closeAndClearPersistence(toDocName),
          ]);
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

    p.setOnChange(() => setSnapshot(takeSnapshot(p)));

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

  const openDocument = (docName: string) => {
    mark('ok/nav/open-document', { docName, transition: false });
    if (collabUrl === null) return;
    const p = getPool(collabUrl);
    const entry = p.open(docName);
    if (!entry) return; // reserved doc (e.g. __system__) — pool refused admission
    consumePrewarmClick(docName, entry.poolEventId);
    const nextTabId = docTabId(docName);
    updateOpenTabs((current) => addOpenTab(current, nextTabId, MAX_POOL, pinnedTabIdsRef.current));
    removeActiveNewTab(nextTabId);
    commitActiveTabId(nextTabId);
    p.setActive(docName);
    setActiveTarget({ kind: 'doc', target: docName, docName });
  };
  const openDocumentTransition = (docName: string) => {
    mark('ok/nav/open-document', { docName, transition: false });
    openDocument(docName);
  };

  const openTargetWithOptions = (
    target: ResolvedNavigationTarget,
    options: OpenTargetOptions = {},
  ) => {
    if (collabUrl === null) return;
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

  const closeTabById = (tabId: string) => {
    if (pinnedTabIdsRef.current.includes(tabId)) return;
    markTabSessionClosedDuringRestore();
    let nextActiveTabId: string | null = null;
    const closingDocName = docNameForTabId(tabId);
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
      commitPinnedTabIds(nextPinnedTabIds);
    },
    unpinTab: (tabId: string) => {
      const nextPinnedTabIds = removePinnedTab(pinnedTabIdsRef.current, tabId);
      if (sameTabIds(pinnedTabIdsRef.current, nextPinnedTabIds)) return;
      markTabSessionClosedDuringRestore();
      commitPinnedTabIds(nextPinnedTabIds);
    },
    activateTab: (tabId: string) => {
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
    },
    reorderTabs: (newOrder: readonly string[], draggedTabId: string) => {
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
      const sameVisibleOrder = sameTabIds(visibleTabIdsRef.current, seedVisibleTabIds);
      if (sameOpenOrder && sameNewOrder && sameVisibleOrder) return;
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
    openNewTab: () => {
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
    },
    activateNewTab: (tabId: string) => {
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
    closeTabs: (tabIds: readonly string[], options: CloseTabsOptions = {}) => {
      const requestedTabIds = tabIds.filter((tabId) => tabId.length > 0);
      const closingTabIds = new Set(
        options.force
          ? requestedTabIds
          : filterClosableTabIds(requestedTabIds, pinnedTabIdsRef.current),
      );
      if (closingTabIds.size === 0) return;
      markTabSessionClosedDuringRestore();
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
      emitDocumentsChanged(['files', 'backlinks', 'graph']);
      emitBranchChanged(branch);
    },
    observeBranch: async (branch: string) => {
      if (collabUrl === null) return;
      const p = getPool(collabUrl);
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
      if (!snapshot.activeDocName && targetDoc) {
        window.location.hash = hashFromDocName(targetDoc);
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
      } catch {
      }
    }
  });
}
