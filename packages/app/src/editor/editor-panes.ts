import type { ResolvedNavigationTarget } from '@/components/navigation-targets';

/** A stable identity for one side-by-side editor column. */
export type EditorPaneId = string;

/**
 * Runtime-only state for one editor pane. `activeTarget` and blank-tab state
 * are deliberately not persisted: both are derived while restoring the tab
 * session and may be stale by the next launch.
 */
export interface EditorPaneState {
  id: EditorPaneId;
  openTabs: string[];
  pinnedTabIds: string[];
  activeTabId: string | null;
  previewTabId: string | null;
  newTabIds: string[];
  activeNewTabId: string | null;
  activeTarget: ResolvedNavigationTarget | null;
  /** Percentage of the flat, horizontal editor workspace. */
  size: number;
}

export interface EditorWorkspaceState {
  panes: EditorPaneState[];
  focusedPaneId: EditorPaneId;
}

/** The durable, bridge-safe subset of an editor pane. */
export interface PersistedEditorPane {
  id: EditorPaneId;
  openTabs: string[];
  pinnedTabIds: string[];
  activeTabId: string | null;
  size: number;
}

export interface PersistedEditorWorkspace {
  panes: PersistedEditorPane[];
  focusedPaneId: EditorPaneId;
}

export interface RecentlyClosedEditorTab {
  paneId: EditorPaneId;
  tabId: string;
}

export type PaneSide = 'left' | 'right';
export type PaneIdFactory = () => EditorPaneId;

export type TabOpenDisposition = 'preview' | 'permanent';
export type ExistingTabOpenBehavior = 'activate-owner' | 'open-in-pane';

export type EditorWorkspaceCommand =
  | {
      type: 'open-target';
      paneId: EditorPaneId;
      tabId: string;
      target: ResolvedNavigationTarget;
      disposition: TabOpenDisposition;
      consumeActiveNewTab: boolean;
      existingTabBehavior?: ExistingTabOpenBehavior;
    }
  | { type: 'activate-tab'; paneId: EditorPaneId; tabId: string }
  | { type: 'promote-preview'; paneId: EditorPaneId; tabId: string }
  | { type: 'promote-all-previews' }
  | { type: 'open-new-tab'; paneId: EditorPaneId; tabId: string }
  | { type: 'close-tabs'; paneId: EditorPaneId; tabIds: readonly string[] }
  | {
      type: 'pin-tab';
      paneId: EditorPaneId;
      tabId: string;
    }
  | { type: 'unpin-tab'; paneId: EditorPaneId; tabId: string }
  | {
      type: 'reorder-tabs';
      paneId: EditorPaneId;
      tabIds: readonly string[];
      draggedTabId: string;
    }
  | { type: 'move-tab'; tabId: string; paneId: EditorPaneId; index: number }
  | {
      type: 'split-tab';
      tabId: string;
      paneId: EditorPaneId;
      side: PaneSide;
      newPaneId: EditorPaneId;
    }
  | { type: 'resize-panes'; sizes: readonly number[] }
  | { type: 'remap-tabs'; remap: (tabId: string) => string | null }
  | { type: 'prune-tabs'; keep: (tabId: string) => boolean };

export interface EditorWorkspaceTransition {
  workspace: EditorWorkspaceState;
  openedTabId: string | null;
  replacedPreviewTabId: string | null;
  consumedNewTabId: string | null;
}

const DEFAULT_PANE_ID = 'pane-main';

function isCurrentTabId(value: unknown): value is string {
  return isTabId(value) && !value.includes('\u0000doc-tab:');
}

function isIndependentViewTabId(tabId: string): boolean {
  return tabId.startsWith('\u0000');
}

function isPaneId(value: unknown): value is EditorPaneId {
  return typeof value === 'string' && !!value;
}

function isTabId(value: unknown): value is string {
  return typeof value === 'string' && !!value;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeTabIds(value: unknown, claimedTabIds = new Set<string>()): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tabIds: string[] = [];
  for (const candidate of value) {
    if (!isCurrentTabId(candidate) || seen.has(candidate)) continue;
    if (!isIndependentViewTabId(candidate) && claimedTabIds.has(candidate)) continue;
    seen.add(candidate);
    if (!isIndependentViewTabId(candidate)) claimedTabIds.add(candidate);
    tabIds.push(candidate);
  }
  return tabIds;
}

function normalizePinnedTabIds(value: unknown, openTabs: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const openTabIds = new Set(openTabs);
  const seen = new Set<string>();
  const pinnedTabIds: string[] = [];
  for (const candidate of value) {
    if (!isTabId(candidate) || !openTabIds.has(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    pinnedTabIds.push(candidate);
  }
  return pinnedTabIds;
}

function activeTabIdFor(openTabs: readonly string[], value: unknown): string | null {
  return isTabId(value) && openTabs.includes(value) ? value : null;
}

function nearestTabAfterRemoving(
  tabs: readonly string[],
  activeTabId: string | null,
  removed: ReadonlySet<string>,
): string | null {
  if (!activeTabId || !removed.has(activeTabId)) return activeTabId;
  const index = tabs.indexOf(activeTabId);
  for (let next = index + 1; next < tabs.length; next++) {
    if (!removed.has(tabs[next])) return tabs[next] ?? null;
  }
  for (let previous = index - 1; previous >= 0; previous--) {
    if (!removed.has(tabs[previous])) return tabs[previous] ?? null;
  }
  return null;
}

function normalizePane(
  pane: Omit<EditorPaneState, 'size'> & { size?: unknown },
  claimedTargets = new Set<string>(),
): EditorPaneState | null {
  if (!isPaneId(pane.id)) return null;
  const openTabs = normalizeTabIds(pane.openTabs, claimedTargets);
  const newTabIds = Array.isArray(pane.newTabIds)
    ? pane.newTabIds.filter((tabId): tabId is string => isTabId(tabId) && !openTabs.includes(tabId))
    : [];
  const requestedActiveTabId = activeTabIdFor(openTabs, pane.activeTabId);
  const requestedActiveNewTabId =
    isTabId(pane.activeNewTabId) && newTabIds.includes(pane.activeNewTabId)
      ? pane.activeNewTabId
      : null;
  const activeTabId =
    requestedActiveTabId ?? (requestedActiveNewTabId === null ? (openTabs[0] ?? null) : null);
  const activeNewTabId =
    activeTabId === null ? (requestedActiveNewTabId ?? newTabIds[0] ?? null) : null;
  const pinnedTabIds = normalizePinnedTabIds(pane.pinnedTabIds, openTabs);
  const previewTabId =
    isCurrentTabId(pane.previewTabId) &&
    openTabs.includes(pane.previewTabId) &&
    !pinnedTabIds.includes(pane.previewTabId)
      ? pane.previewTabId
      : null;
  return {
    id: pane.id,
    openTabs,
    pinnedTabIds,
    activeTabId,
    previewTabId,
    newTabIds,
    activeNewTabId,
    // A resolved target belongs to the exact selected tab. When normalization
    // selects a fallback, the resolver must rebuild that target instead of
    // projecting stale navigation state into the editor.
    activeTarget:
      activeTabId !== null && activeTabId === requestedActiveTabId
        ? (pane.activeTarget ?? null)
        : null,
    size: isPositiveFiniteNumber(pane.size) ? pane.size : 1,
  };
}

function normalizePaneSizes<T extends { size: number }>(panes: readonly T[]): T[] {
  if (panes.length === 0) return [];
  const total = panes.reduce(
    (sum, pane) => sum + (isPositiveFiniteNumber(pane.size) ? pane.size : 0),
    0,
  );
  if (total <= 0) {
    const equalSize = 100 / panes.length;
    return panes.map((pane) => ({ ...pane, size: equalSize }));
  }
  return panes.map((pane) => ({
    ...pane,
    size: ((isPositiveFiniteNumber(pane.size) ? pane.size : 0) / total) * 100,
  }));
}

export function createEmptyEditorPane(id: EditorPaneId, size = 100): EditorPaneState {
  return {
    id,
    openTabs: [],
    pinnedTabIds: [],
    activeTabId: null,
    previewTabId: null,
    newTabIds: [],
    activeNewTabId: null,
    activeTarget: null,
    size,
  };
}

export function createEmptyEditorWorkspace(
  createPaneId: PaneIdFactory = () => DEFAULT_PANE_ID,
): EditorWorkspaceState {
  const pane = createEmptyEditorPane(createPaneId());
  return { panes: [pane], focusedPaneId: pane.id };
}

/** Converts persisted session data into runtime state without resolving targets. */
export function hydrateEditorWorkspace(session: PersistedEditorWorkspace): EditorWorkspaceState {
  const panes = session.panes.map((pane) => ({
    ...pane,
    previewTabId: null,
    newTabIds: [],
    activeNewTabId: null,
    activeTarget: null,
  }));
  return {
    panes,
    focusedPaneId: panes.some((p) => p.id === session.focusedPaneId)
      ? session.focusedPaneId
      : (panes[0]?.id ?? DEFAULT_PANE_ID),
  };
}

/** Removes runtime-only fields before session persistence / IPC transport. */
export function persistEditorWorkspace(workspace: EditorWorkspaceState): PersistedEditorWorkspace {
  const normalized = normalizeEditorWorkspace(workspace);
  return {
    panes: normalized.panes.map(({ id, openTabs, pinnedTabIds, activeTabId, size }) => ({
      id,
      openTabs,
      pinnedTabIds,
      activeTabId,
      size,
    })),
    focusedPaneId: normalized.focusedPaneId,
  };
}

/**
 * Defensively parses persisted pane data. Provider-backed document tabs remain
 * globally unique, while independent folder and asset views may occupy more
 * than one pane.
 */
export function parsePersistedEditorWorkspace(
  value: unknown,
  createPaneId: PaneIdFactory = () => DEFAULT_PANE_ID,
): PersistedEditorWorkspace {
  const fallback = () => {
    const id = createPaneId();
    return {
      panes: [{ id, openTabs: [], pinnedTabIds: [], activeTabId: null, size: 100 }],
      focusedPaneId: id,
    };
  };
  if (typeof value !== 'object' || value === null) return fallback();
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.panes)) return fallback();

  const claimedPaneIds = new Set<string>();
  const candidates: Array<{
    pane: Record<string, unknown>;
    id: EditorPaneId;
    visualIndex: number;
  }> = [];
  for (const [visualIndex, rawPane] of raw.panes.entries()) {
    if (typeof rawPane !== 'object' || rawPane === null) continue;
    const pane = rawPane as Record<string, unknown>;
    if (!isPaneId(pane.id) || claimedPaneIds.has(pane.id)) continue;
    claimedPaneIds.add(pane.id);
    candidates.push({ pane, id: pane.id, visualIndex });
  }
  if (candidates.length === 0) return fallback();

  const requestedFocus = isPaneId(raw.focusedPaneId) ? raw.focusedPaneId : null;
  const claimOrder = [...candidates].sort((left, right) => {
    if (left.id === requestedFocus) return -1;
    if (right.id === requestedFocus) return 1;
    return left.visualIndex - right.visualIndex;
  });
  const claimedTabIds = new Set<string>();
  const claimedPanes = new Map<EditorPaneId, PersistedEditorPane>();
  for (const { pane, id } of claimOrder) {
    const openTabs = normalizeTabIds(pane.openTabs, claimedTabIds);
    const activeTabId = activeTabIdFor(openTabs, pane.activeTabId);
    claimedPanes.set(id, {
      id,
      openTabs,
      pinnedTabIds: normalizePinnedTabIds(pane.pinnedTabIds, openTabs),
      activeTabId: activeTabId ?? openTabs[0] ?? null,
      size: isPositiveFiniteNumber(pane.size) ? pane.size : 1,
    });
  }

  const panes = candidates.flatMap(({ id }) => {
    const pane = claimedPanes.get(id);
    return pane && pane.openTabs.length > 0 ? [pane] : [];
  });
  if (panes.length === 0) return fallback();
  const normalizedPanes = normalizePaneSizes(panes);
  const focusedPaneId =
    requestedFocus && normalizedPanes.some((pane) => pane.id === requestedFocus)
      ? requestedFocus
      : normalizedPanes[0].id;
  return { panes: normalizedPanes, focusedPaneId };
}

export function normalizeEditorWorkspace(workspace: EditorWorkspaceState): EditorWorkspaceState {
  const claimedPaneIds = new Set<string>();
  const claimedTabIds = new Set<string>();
  const panes = workspace.panes.flatMap((pane) => {
    // Reject duplicate pane identities before normalizing tabs. Otherwise a
    // discarded duplicate would still claim its targets and silently evict
    // valid tabs from a later, distinct pane.
    if (!isPaneId(pane.id) || claimedPaneIds.has(pane.id)) return [];
    const normalized = normalizePane(pane, claimedTabIds);
    if (!normalized) return [];
    claimedPaneIds.add(normalized.id);
    return [normalized];
  });
  if (panes.length === 0) return createEmptyEditorWorkspace();
  const normalizedPanes = normalizePaneSizes(panes);
  return {
    panes: normalizedPanes,
    focusedPaneId: normalizedPanes.some((pane) => pane.id === workspace.focusedPaneId)
      ? workspace.focusedPaneId
      : normalizedPanes[0].id,
  };
}

export function focusedPane(workspace: EditorWorkspaceState): EditorPaneState {
  return (
    workspace.panes.find((pane) => pane.id === workspace.focusedPaneId) ??
    workspace.panes[0] ??
    createEmptyEditorPane(DEFAULT_PANE_ID)
  );
}

export function focusEditorPane(
  workspace: EditorWorkspaceState,
  paneId: EditorPaneId,
): EditorWorkspaceState {
  if (!workspace.panes.some((pane) => pane.id === paneId)) return workspace;
  return { ...workspace, focusedPaneId: paneId };
}

function findPaneContainingTab(
  workspace: EditorWorkspaceState,
  tabId: string,
): EditorPaneState | null {
  const focused = workspace.panes.find((pane) => pane.id === workspace.focusedPaneId);
  if (focused?.openTabs.includes(tabId) || focused?.newTabIds.includes(tabId)) return focused;
  return (
    workspace.panes.find(
      (pane) => pane.openTabs.includes(tabId) || pane.newTabIds.includes(tabId),
    ) ?? null
  );
}

export function findPaneOwningTab(
  workspace: EditorWorkspaceState,
  tabId: string,
): EditorPaneState | null {
  return isCurrentTabId(tabId) ? findPaneContainingTab(workspace, tabId) : null;
}

export function flattenWorkspaceTabs(workspace: EditorWorkspaceState): string[] {
  return workspace.panes.flatMap((pane) => pane.openTabs);
}

export function flattenWorkspacePinnedTabs(workspace: EditorWorkspaceState): string[] {
  const open = new Set(flattenWorkspaceTabs(workspace));
  return workspace.panes.flatMap((pane) => pane.pinnedTabIds.filter((tabId) => open.has(tabId)));
}

export function updateEditorPane(
  workspace: EditorWorkspaceState,
  paneId: EditorPaneId,
  update: (pane: EditorPaneState) => EditorPaneState,
): EditorWorkspaceState {
  return {
    ...workspace,
    panes: workspace.panes.map((pane) => (pane.id === paneId ? update(pane) : pane)),
  };
}

export function reorderPaneTabs(
  workspace: EditorWorkspaceState,
  paneId: EditorPaneId,
  nextOpenTabs: readonly string[],
  draggedTabId: string,
): EditorWorkspaceState {
  const pane = workspace.panes.find((candidate) => candidate.id === paneId);
  if (!pane) return workspace;
  const allowed = new Set(pane.openTabs);
  const ordered = nextOpenTabs.filter((tabId) => allowed.has(tabId));
  for (const tabId of pane.openTabs) if (!ordered.includes(tabId)) ordered.push(tabId);
  const previousPinned = new Set(pane.pinnedTabIds);
  const draggedIndex = ordered.indexOf(draggedTabId);
  const shouldPin = draggedIndex >= 0 && draggedIndex < pane.pinnedTabIds.length;
  const pinnedTabIds = pane.openTabs.includes(draggedTabId)
    ? ordered.filter((tabId) => (tabId === draggedTabId ? shouldPin : previousPinned.has(tabId)))
    : pane.pinnedTabIds;
  return updateEditorPane(workspace, paneId, (current) => ({
    ...current,
    openTabs: ordered,
    pinnedTabIds,
    previewTabId: current.previewTabId === draggedTabId ? null : current.previewTabId,
  }));
}

function removeTabFromPane(pane: EditorPaneState, tabId: string): EditorPaneState {
  const newTabIndex = pane.newTabIds.indexOf(tabId);
  if (newTabIndex >= 0) {
    const newTabIds = pane.newTabIds.filter((candidate) => candidate !== tabId);
    const wasActive = pane.activeNewTabId === tabId;
    const activeNewTabId = wasActive
      ? (newTabIds[newTabIndex] ?? newTabIds[newTabIndex - 1] ?? null)
      : pane.activeNewTabId;
    const activeTabId =
      wasActive && activeNewTabId === null
        ? (pane.openTabs[pane.openTabs.length - 1] ?? null)
        : pane.activeTabId;
    return {
      ...pane,
      newTabIds,
      activeNewTabId,
      activeTabId,
      activeTarget:
        activeNewTabId === null && activeTabId === pane.activeTabId ? pane.activeTarget : null,
    };
  }

  const index = pane.openTabs.indexOf(tabId);
  if (index < 0) return pane;
  const removed = new Set([tabId]);
  const activeTabId = nearestTabAfterRemoving(pane.openTabs, pane.activeTabId, removed);
  const activeNewTabId =
    pane.activeTabId === tabId && activeTabId === null
      ? (pane.activeNewTabId ?? pane.newTabIds[pane.newTabIds.length - 1] ?? null)
      : pane.activeNewTabId;
  return {
    ...pane,
    openTabs: pane.openTabs.filter((candidate) => candidate !== tabId),
    pinnedTabIds: pane.pinnedTabIds.filter((candidate) => candidate !== tabId),
    activeTabId,
    activeNewTabId,
    previewTabId: pane.previewTabId === tabId ? null : pane.previewTabId,
    activeTarget:
      activeNewTabId === null && activeTabId === pane.activeTabId ? pane.activeTarget : null,
  };
}

export function pruneEmptyEditorPanes(workspace: EditorWorkspaceState): EditorWorkspaceState {
  const nonEmpty = workspace.panes.filter((pane) => pane.openTabs.length || pane.newTabIds.length);
  if (nonEmpty.length === 0)
    return createEmptyEditorWorkspace(() => workspace.focusedPaneId || DEFAULT_PANE_ID);
  const panes = normalizePaneSizes(nonEmpty);
  return {
    panes,
    focusedPaneId: panes.some((pane) => pane.id === workspace.focusedPaneId)
      ? workspace.focusedPaneId
      : panes[0].id,
  };
}

/**
 * Build the pane layout for a filtered tab surface without mutating the saved
 * workspace. Panes whose tabs are all hidden disappear from this projection;
 * switching surfaces can still restore their original tabs and pane identity.
 */
export function projectVisibleEditorWorkspace(
  workspace: EditorWorkspaceState,
  visibleTabIdsByPane: ReadonlyMap<EditorPaneId, readonly string[]>,
): EditorWorkspaceState {
  const panes = workspace.panes.flatMap((pane) => {
    const paneTabIds = new Set([...pane.openTabs, ...pane.newTabIds]);
    const visibleTabIds = (visibleTabIdsByPane.get(pane.id) ?? []).filter(
      (tabId, index, tabs) => paneTabIds.has(tabId) && tabs.indexOf(tabId) === index,
    );
    if (visibleTabIds.length === 0) return [];

    const visible = new Set(visibleTabIds);
    const openTabs = pane.openTabs.filter((tabId) => visible.has(tabId));
    const newTabIds = pane.newTabIds.filter((tabId) => visible.has(tabId));
    const selectedTabId =
      (pane.activeTabId && visible.has(pane.activeTabId) ? pane.activeTabId : null) ??
      (pane.activeNewTabId && visible.has(pane.activeNewTabId) ? pane.activeNewTabId : null) ??
      visibleTabIds[0];
    const activeTabId = openTabs.includes(selectedTabId) ? selectedTabId : null;
    const activeNewTabId = newTabIds.includes(selectedTabId) ? selectedTabId : null;

    return [
      {
        ...pane,
        openTabs,
        pinnedTabIds: pane.pinnedTabIds.filter((tabId) => visible.has(tabId)),
        activeTabId,
        previewTabId:
          pane.previewTabId && visible.has(pane.previewTabId) ? pane.previewTabId : null,
        newTabIds,
        activeNewTabId,
        activeTarget: activeTabId === pane.activeTabId ? pane.activeTarget : null,
      },
    ];
  });

  if (panes.length === 0) {
    return createEmptyEditorWorkspace(() => workspace.focusedPaneId || DEFAULT_PANE_ID);
  }

  const normalizedPanes = normalizePaneSizes(panes);
  return {
    panes: normalizedPanes,
    focusedPaneId: normalizedPanes.some((pane) => pane.id === workspace.focusedPaneId)
      ? workspace.focusedPaneId
      : normalizedPanes[0].id,
  };
}

export function tabBucketIndexForVisibleInsertion(
  visibleOrder: readonly string[],
  bucketTabIds: readonly string[],
  visibleIndex: number,
): number {
  const bucket = new Set(bucketTabIds);
  const boundedIndex = Math.max(0, Math.min(visibleIndex, visibleOrder.length));
  let bucketIndex = 0;
  for (let index = 0; index < boundedIndex; index += 1) {
    const tabId = visibleOrder[index];
    if (tabId && bucket.has(tabId)) bucketIndex += 1;
  }
  return bucketIndex;
}

export function moveTabToPane(
  workspace: EditorWorkspaceState,
  tabId: string,
  targetPaneId: EditorPaneId,
  targetIndex: number,
): EditorWorkspaceState {
  const sourcePane = findPaneContainingTab(workspace, tabId);
  const targetPane = workspace.panes.find((pane) => pane.id === targetPaneId);
  if (!sourcePane || !targetPane) return workspace;
  const isNewTab = sourcePane.newTabIds.includes(tabId);
  if (sourcePane.id === targetPane.id) {
    if (isNewTab) {
      const without = sourcePane.newTabIds.filter((candidate) => candidate !== tabId);
      const index = Math.max(0, Math.min(targetIndex, without.length));
      return updateEditorPane(workspace, targetPaneId, (pane) => ({
        ...pane,
        newTabIds: [...without.slice(0, index), tabId, ...without.slice(index)],
        activeNewTabId: tabId,
        activeTabId: null,
        activeTarget: null,
      }));
    }
    const without = sourcePane.openTabs.filter((candidate) => candidate !== tabId);
    const index = Math.max(0, Math.min(targetIndex, without.length));
    const openTabs = [...without.slice(0, index), tabId, ...without.slice(index)];
    return reorderPaneTabs(workspace, targetPaneId, openTabs, tabId);
  }
  const wasPinned = sourcePane.pinnedTabIds.includes(tabId);
  const withoutSource = removeTabFromPane(sourcePane, tabId);
  const insertedIndex = Math.max(
    0,
    Math.min(targetIndex, isNewTab ? targetPane.newTabIds.length : targetPane.openTabs.length),
  );
  const withTarget: EditorPaneState = isNewTab
    ? {
        ...targetPane,
        newTabIds: [
          ...targetPane.newTabIds.slice(0, insertedIndex),
          tabId,
          ...targetPane.newTabIds.slice(insertedIndex),
        ],
        activeNewTabId: tabId,
        activeTabId: null,
        activeTarget: null,
      }
    : {
        ...targetPane,
        openTabs: [
          ...targetPane.openTabs.slice(0, insertedIndex),
          tabId,
          ...targetPane.openTabs.slice(insertedIndex),
        ],
        pinnedTabIds: wasPinned ? [...targetPane.pinnedTabIds, tabId] : targetPane.pinnedTabIds,
        activeNewTabId: null,
        activeTabId: tabId,
        activeTarget: null,
      };
  const panes = workspace.panes.map((pane) =>
    pane.id === sourcePane.id ? withoutSource : pane.id === targetPane.id ? withTarget : pane,
  );
  return focusEditorPane(pruneEmptyEditorPanes({ ...workspace, panes }), targetPane.id);
}

export function splitTabToPane(
  workspace: EditorWorkspaceState,
  tabId: string,
  targetPaneId: EditorPaneId,
  side: PaneSide,
  createPaneId: PaneIdFactory,
): EditorWorkspaceState {
  const sourcePane = findPaneContainingTab(workspace, tabId);
  const targetPane = workspace.panes.find((pane) => pane.id === targetPaneId);
  if (!sourcePane || !targetPane) return workspace;
  // There is nothing to split when the only tab is dragged to its own edge.
  if (
    sourcePane.id === targetPane.id &&
    sourcePane.openTabs.length + sourcePane.newTabIds.length === 1
  )
    return focusEditorPane(workspace, sourcePane.id);
  const newPaneId = createPaneId();
  if (!isPaneId(newPaneId) || workspace.panes.some((pane) => pane.id === newPaneId))
    return workspace;
  const wasPinned = sourcePane.pinnedTabIds.includes(tabId);
  const sourceAfterMove = removeTabFromPane(sourcePane, tabId);
  const targetAfterSplit = sourcePane.id === targetPane.id ? sourceAfterMove : targetPane;
  const halfSize = targetAfterSplit.size / 2;
  const resizedTarget = { ...targetAfterSplit, size: halfSize };
  const isNewTab = sourcePane.newTabIds.includes(tabId);
  const newPane: EditorPaneState = {
    ...createEmptyEditorPane(newPaneId, halfSize),
    openTabs: isNewTab ? [] : [tabId],
    pinnedTabIds: wasPinned && !isNewTab ? [tabId] : [],
    activeTabId: isNewTab ? null : tabId,
    previewTabId: null,
    newTabIds: isNewTab ? [tabId] : [],
    activeNewTabId: isNewTab ? tabId : null,
  };
  const panesWithoutSource = workspace.panes.map((pane) => {
    if (pane.id === sourcePane.id) return sourceAfterMove;
    return pane;
  });
  const targetIndex = panesWithoutSource.findIndex((pane) => pane.id === targetPane.id);
  if (targetIndex < 0) return workspace;
  panesWithoutSource[targetIndex] = resizedTarget;
  const insertIndex = side === 'left' ? targetIndex : targetIndex + 1;
  const panes = [
    ...panesWithoutSource.slice(0, insertIndex),
    newPane,
    ...panesWithoutSource.slice(insertIndex),
  ];
  return focusEditorPane(pruneEmptyEditorPanes({ ...workspace, panes }), newPaneId);
}

export function closeTabsInPane(
  workspace: EditorWorkspaceState,
  paneId: EditorPaneId,
  tabIds: readonly string[],
): EditorWorkspaceState {
  const closing = new Set(tabIds);
  const pane = workspace.panes.find((candidate) => candidate.id === paneId);
  if (!pane || closing.size === 0) return workspace;
  const activeTabId = nearestTabAfterRemoving(pane.openTabs, pane.activeTabId, closing);
  const next = updateEditorPane(workspace, paneId, (current) => {
    const withoutOpenTabs = {
      ...current,
      openTabs: current.openTabs.filter((tabId) => !closing.has(tabId)),
      pinnedTabIds: current.pinnedTabIds.filter((tabId) => !closing.has(tabId)),
      activeTabId,
      previewTabId:
        current.previewTabId && closing.has(current.previewTabId) ? null : current.previewTabId,
      activeTarget: activeTabId === current.activeTabId ? current.activeTarget : null,
    };
    return current.newTabIds.reduce(
      (result, tabId) => (closing.has(tabId) ? removeTabFromPane(result, tabId) : result),
      withoutOpenTabs,
    );
  });
  return pruneEmptyEditorPanes(next);
}

export function remapWorkspaceTabs(
  workspace: EditorWorkspaceState,
  remapTabId: (tabId: string) => string | null,
): EditorWorkspaceState {
  const mappedByOriginal = new Map<string, string | null>();
  const mappedPinnedTabIds = new Set<string>();
  for (const pane of workspace.panes) {
    for (const tabId of pane.openTabs) {
      const mapped = remapTabId(tabId);
      const canonical = isCurrentTabId(mapped) ? mapped : null;
      mappedByOriginal.set(tabId, canonical);
      if (canonical && !isIndependentViewTabId(canonical) && pane.pinnedTabIds.includes(tabId)) {
        mappedPinnedTabIds.add(canonical);
      }
    }
  }

  const claimedTabIds = new Set<string>();
  const panes = workspace.panes.map((pane) => {
    const mapping = new Map<string, string>();
    const seenTabIds = new Set<string>();
    const openTabs: string[] = [];
    for (const tabId of pane.openTabs) {
      const mapped = mappedByOriginal.get(tabId);
      if (!mapped || seenTabIds.has(mapped)) continue;
      if (!isIndependentViewTabId(mapped) && claimedTabIds.has(mapped)) continue;
      seenTabIds.add(mapped);
      if (!isIndependentViewTabId(mapped)) claimedTabIds.add(mapped);
      mapping.set(tabId, mapped);
      openTabs.push(mapped);
    }
    const localPinnedTabIds = new Set(
      pane.pinnedTabIds.flatMap((tabId) => mapping.get(tabId) ?? []),
    );
    const pinnedTabIds = openTabs.filter((tabId) =>
      isIndependentViewTabId(tabId) ? localPinnedTabIds.has(tabId) : mappedPinnedTabIds.has(tabId),
    );
    const activeTabId = pane.activeTabId ? (mapping.get(pane.activeTabId) ?? null) : null;
    const previewTabId =
      pane.previewTabId && mapping.get(pane.previewTabId) === pane.previewTabId
        ? pane.previewTabId
        : null;
    return {
      ...pane,
      openTabs,
      pinnedTabIds,
      activeTabId,
      previewTabId: previewTabId && !pinnedTabIds.includes(previewTabId) ? previewTabId : null,
      activeTarget:
        activeTabId !== null && activeTabId === pane.activeTabId ? pane.activeTarget : null,
    };
  });
  return pruneEmptyEditorPanes({ ...workspace, panes });
}

function pruneWorkspaceTabs(
  workspace: EditorWorkspaceState,
  keepTabId: (tabId: string) => boolean,
): EditorWorkspaceState {
  return remapWorkspaceTabs(workspace, (tabId) => (keepTabId(tabId) ? tabId : null));
}

function unchangedTransition(workspace: EditorWorkspaceState): EditorWorkspaceTransition {
  return {
    workspace,
    openedTabId: null,
    replacedPreviewTabId: null,
    consumedNewTabId: null,
  };
}

function finishTransition(
  workspace: EditorWorkspaceState,
  metadata: Omit<EditorWorkspaceTransition, 'workspace'> = {
    openedTabId: null,
    replacedPreviewTabId: null,
    consumedNewTabId: null,
  },
): EditorWorkspaceTransition {
  return { workspace: normalizeEditorWorkspace(workspace), ...metadata };
}

function activateTabInPane(
  workspace: EditorWorkspaceState,
  paneId: EditorPaneId,
  tabId: string,
): EditorWorkspaceState {
  const pane = workspace.panes.find((candidate) => candidate.id === paneId);
  if (!pane) return workspace;
  if (pane.newTabIds.includes(tabId)) {
    return focusEditorPane(
      updateEditorPane(workspace, paneId, (current) => ({
        ...current,
        activeTabId: null,
        activeNewTabId: tabId,
        activeTarget: null,
      })),
      paneId,
    );
  }
  if (!pane.openTabs.includes(tabId)) return workspace;
  return focusEditorPane(
    updateEditorPane(workspace, paneId, (current) => ({
      ...current,
      activeTabId: tabId,
      activeNewTabId: null,
      activeTarget: current.activeTabId === tabId ? current.activeTarget : null,
    })),
    paneId,
  );
}

export function transitionEditorWorkspace(
  workspace: EditorWorkspaceState,
  command: EditorWorkspaceCommand,
): EditorWorkspaceTransition {
  switch (command.type) {
    case 'open-target': {
      if (!isCurrentTabId(command.tabId)) return unchangedTransition(workspace);
      const requestedPane = workspace.panes.find((pane) => pane.id === command.paneId);
      if (!requestedPane) return unchangedTransition(workspace);

      const consumedNewTabId =
        command.consumeActiveNewTab && requestedPane.activeNewTabId
          ? requestedPane.activeNewTabId
          : null;
      let next =
        consumedNewTabId === null
          ? workspace
          : updateEditorPane(workspace, requestedPane.id, (pane) =>
              removeTabFromPane(pane, consumedNewTabId),
            );
      const requestedOwner = next.panes.find(
        (pane) => pane.id === command.paneId && pane.openTabs.includes(command.tabId),
      );
      const existingOwner = requestedOwner ?? findPaneContainingTab(next, command.tabId);
      const shouldOpenIndependentCopy =
        existingOwner !== null &&
        existingOwner.id !== command.paneId &&
        command.existingTabBehavior === 'open-in-pane' &&
        isIndependentViewTabId(command.tabId);
      if (existingOwner && !shouldOpenIndependentCopy) {
        if (existingOwner.id !== command.paneId && command.existingTabBehavior === 'open-in-pane') {
          next = moveTabToPane(next, command.tabId, command.paneId, requestedPane.openTabs.length);
          next = updateEditorPane(next, command.paneId, (pane) => ({
            ...pane,
            activeTarget: command.target,
            previewTabId:
              command.disposition === 'permanent' && pane.previewTabId === command.tabId
                ? null
                : pane.previewTabId,
          }));
          return finishTransition(next, {
            openedTabId: command.tabId,
            replacedPreviewTabId: null,
            consumedNewTabId,
          });
        }
        next = updateEditorPane(next, existingOwner.id, (pane) => ({
          ...pane,
          activeTabId: command.tabId,
          activeNewTabId: null,
          activeTarget: command.target,
          previewTabId:
            command.disposition === 'permanent' && pane.previewTabId === command.tabId
              ? null
              : pane.previewTabId,
        }));
        next = focusEditorPane(next, existingOwner.id);
        next = pruneEmptyEditorPanes(next);
        return finishTransition(next, {
          openedTabId: command.tabId,
          replacedPreviewTabId: null,
          consumedNewTabId,
        });
      }

      const paneAfterConsumption = next.panes.find((pane) => pane.id === command.paneId);
      if (!paneAfterConsumption) return unchangedTransition(workspace);
      const replacedPreviewTabId =
        command.disposition === 'preview' ? paneAfterConsumption.previewTabId : null;
      next = updateEditorPane(next, command.paneId, (pane) => {
        const replacementIndex = replacedPreviewTabId
          ? pane.openTabs.indexOf(replacedPreviewTabId)
          : -1;
        const withoutPreview = replacedPreviewTabId
          ? pane.openTabs.filter((tabId) => tabId !== replacedPreviewTabId)
          : pane.openTabs;
        const openTabs =
          replacementIndex < 0
            ? [...withoutPreview, command.tabId]
            : [
                ...withoutPreview.slice(0, replacementIndex),
                command.tabId,
                ...withoutPreview.slice(replacementIndex),
              ];
        return {
          ...pane,
          openTabs,
          pinnedTabIds: pane.pinnedTabIds.filter((tabId) => tabId !== replacedPreviewTabId),
          activeTabId: command.tabId,
          activeNewTabId: null,
          activeTarget: command.target,
          previewTabId: command.disposition === 'preview' ? command.tabId : pane.previewTabId,
        };
      });
      next = focusEditorPane(next, command.paneId);
      return finishTransition(next, {
        openedTabId: command.tabId,
        replacedPreviewTabId,
        consumedNewTabId,
      });
    }

    case 'activate-tab':
      return finishTransition(activateTabInPane(workspace, command.paneId, command.tabId));

    case 'promote-preview':
      return finishTransition(
        updateEditorPane(workspace, command.paneId, (pane) => ({
          ...pane,
          previewTabId: pane.previewTabId === command.tabId ? null : pane.previewTabId,
        })),
      );

    case 'promote-all-previews':
      return finishTransition({
        ...workspace,
        panes: workspace.panes.map((pane) => ({ ...pane, previewTabId: null })),
      });

    case 'open-new-tab': {
      if (!isTabId(command.tabId)) return unchangedTransition(workspace);
      const owner = findPaneContainingTab(workspace, command.tabId);
      if (owner) return finishTransition(activateTabInPane(workspace, owner.id, command.tabId));
      if (!workspace.panes.some((pane) => pane.id === command.paneId))
        return unchangedTransition(workspace);
      return finishTransition(
        focusEditorPane(
          updateEditorPane(workspace, command.paneId, (pane) => ({
            ...pane,
            newTabIds: [...pane.newTabIds, command.tabId],
            activeTabId: null,
            activeNewTabId: command.tabId,
            activeTarget: null,
          })),
          command.paneId,
        ),
      );
    }

    case 'close-tabs':
      return finishTransition(closeTabsInPane(workspace, command.paneId, command.tabIds));

    case 'pin-tab':
      return finishTransition(
        updateEditorPane(workspace, command.paneId, (pane) =>
          pane.openTabs.includes(command.tabId)
            ? {
                ...pane,
                pinnedTabIds: pane.pinnedTabIds.includes(command.tabId)
                  ? pane.pinnedTabIds
                  : [...pane.pinnedTabIds, command.tabId],
                previewTabId: pane.previewTabId === command.tabId ? null : pane.previewTabId,
              }
            : pane,
        ),
      );

    case 'unpin-tab':
      return finishTransition(
        updateEditorPane(workspace, command.paneId, (pane) => ({
          ...pane,
          pinnedTabIds: pane.pinnedTabIds.filter((tabId) => tabId !== command.tabId),
        })),
      );

    case 'reorder-tabs':
      return finishTransition(
        reorderPaneTabs(workspace, command.paneId, command.tabIds, command.draggedTabId),
      );

    case 'move-tab':
      return finishTransition(
        moveTabToPane(workspace, command.tabId, command.paneId, command.index),
      );

    case 'split-tab':
      return finishTransition(
        splitTabToPane(
          workspace,
          command.tabId,
          command.paneId,
          command.side,
          () => command.newPaneId,
        ),
      );

    case 'resize-panes': {
      if (
        command.sizes.length !== workspace.panes.length ||
        command.sizes.some((size) => !isPositiveFiniteNumber(size))
      )
        return unchangedTransition(workspace);
      return finishTransition({
        ...workspace,
        panes: workspace.panes.map((pane, index) => ({
          ...pane,
          size: command.sizes[index] ?? pane.size,
        })),
      });
    }

    case 'remap-tabs':
      return finishTransition(remapWorkspaceTabs(workspace, command.remap));

    case 'prune-tabs':
      return finishTransition(pruneWorkspaceTabs(workspace, command.keep));

    default: {
      command satisfies never;
      return unchangedTransition(workspace);
    }
  }
}

export function recordRecentlyClosedTab(
  entries: readonly RecentlyClosedEditorTab[],
  entry: RecentlyClosedEditorTab,
  limit = 25,
): RecentlyClosedEditorTab[] {
  if (!isPaneId(entry.paneId) || !isTabId(entry.tabId) || limit <= 0) return [...entries];
  return [entry, ...entries.filter((candidate) => candidate.tabId !== entry.tabId)].slice(0, limit);
}
