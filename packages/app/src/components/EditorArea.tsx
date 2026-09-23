// oxlint-disable ok/no-physical-direction-utility -- pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/ok-rules/README.md#no-physical-direction-utility

import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  detectEmbeddedHostFromBrowser,
  isFrontmatterSchemaAsset,
  isMarkdownlintJsonConfig,
  PREFERRED_TERMINAL_RIGHT_WIDTH,
  parseExternalSkillDocName,
  type TerminalPlacement,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  lazy,
  type ReactNode,
  Suspense,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { useGroupRef, usePanelRef } from 'react-resizable-panels';
import { toast } from 'sonner';
import { AssetPreview } from '@/components/AssetPreview';
import { DocPanel, type PanelTab } from '@/components/DocPanel';
import {
  consumePendingDocPanelTabRequest,
  subscribeToDocPanelTabRequests,
} from '@/components/doc-panel-events';
import { EditorSkeleton } from '@/components/EditorSkeleton';
import { EmptyEditorState } from '@/components/EmptyEditorState';
import { FolderOverview } from '@/components/FolderOverview';
import { LargeFileEditorState } from '@/components/LargeFileEditorState';
import { MountStalledAffordance } from '@/components/MountStalledAffordance';
import { OkBlobRunnerPage } from '@/components/OkBlobRunnerPage';
import { PropertyProvider, useProperties } from '@/components/PropertyContext';
import { ShareReceiveMissPanel } from '@/components/ShareReceiveMissPanel';
import { SkillFileViewer } from '@/components/SkillFileViewer';
import { SkillPreviewTab } from '@/components/SkillPreviewTab';
import { SettingsDialogShell } from '@/components/settings/SettingsDialogShell';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  isBlobRunnerNewTabId,
  useDocumentContext,
  useDocumentTransition,
} from '@/editor/DocumentContext';
import { FindReplaceController } from '@/editor/find-replace/FindReplaceController';
import { useDocLintConfig } from '@/editor/lint-config-client';
import { mountPromiseHasResolved } from '@/editor/mount-promise';
import { editingSurfaceFor } from '@/editor/selection-stats';
import { syncPromiseHasResolved } from '@/editor/sync-promise';
import {
  partitionFrontmatterProblems,
  useFrontmatterDiagnostics,
} from '@/editor/useFrontmatterDiagnostics';
import { useDocConflict } from '@/hooks/use-conflicts';
import { useDocumentStats } from '@/hooks/use-document-stats';
import { useSelectionStats } from '@/hooks/use-selection-stats';
import { closeAgentDiff, useAgentDiffView } from '@/lib/agent-diff-store';
import {
  type AgentsPanelPointerReleaseDecision,
  getInitialAgentsPanelWidth,
  MIN_AGENTS_PANEL_WIDTH,
  resolveAgentsPanelPointerRelease,
  writeAgentsPanelWidth,
} from '@/lib/agents-panel-width-store';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { docNameFromHash, hashFromDocName, isSameHash } from '@/lib/doc-hash';
import { getInitialDocPanelWidth, writeDocPanelWidth } from '@/lib/doc-panel-width-store';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';
import { isNoteWindow } from '@/lib/note-window-mode';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import { ProfilerBoundary } from '@/lib/perf';
import {
  matchesShareReceiveMiss,
  pendingReceiveNavStore,
} from '@/lib/share/pending-receive-nav-store';
import { RIGHT_COLLAPSE_THRESHOLD, resolvePartition } from '@/lib/sidebar-partition';
import { applyToggle, readPins, resolveEffectiveState } from '@/lib/sidebar-pin-store';
import { closeTimelineDiff, useTimelineDiffView } from '@/lib/timeline-diff-store';
import { useSettingsRoute } from '@/lib/use-settings-route';
import { setViewMenuState } from '@/lib/view-menu-state-store';
import { withViewTransition } from '@/lib/view-transition';
import { useSyncStatus } from '@/presence/use-sync-status';
import { BottomComposer } from './BottomComposer';
import { shouldShowBottomComposer, shouldShowFolderComposer } from './bottom-composer-gate';
import { EditorActivityPool } from './EditorActivityPool';
import { EditorFooter } from './EditorFooter';
import type { EditorMode } from './EditorPane';
import { EditorToolbar } from './EditorToolbar';
import {
  EditorWorkspace,
  type EditorWorkspaceActivityBindings,
  type EditorWorkspacePaneRenderContext,
} from './EditorWorkspace';
import { shouldPaintOverlay } from './editor-area-overlay';
import {
  describeRailFloorShortfall,
  describeRailWidthShortfall,
  type RailPanelSpaceRefusal,
  type RailPanelSpaceResult,
  type RailWidthShortfall,
  resolveRailPanelSpace,
  resolveRailPanelSpacePx,
} from './editor-area-panel-space';
import {
  AGENTS_COLUMN_ID,
  accountRailLayout,
  DOC_PANEL_ID,
  findResidualPanelId,
  TERMINAL_COLUMN_ID,
} from './editor-area-rail-registry';
import { computeStickyRepinLayout } from './editor-area-sticky-repin';
import {
  RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX,
  resolveRightRailAdmission,
} from './right-rail-admission';
import { isSlidesHost } from './slides-host-gate';
import { TerminalDock } from './TerminalDock';
import { TerminalRevealTab } from './TerminalRevealTab';

const LazyActivityModeContent = lazy(async () => {
  const mod = await import('@/components/ActivityModeContent');
  return { default: mod.ActivityModeContent };
});

const PANEL_GROUP_UNAVAILABLE_MESSAGE = /^Could not find Group with id "/;
const BLOCKED_RAIL_LAYOUT_RETRY_DEADLINE_MS = 60_000;

type AgentsPanelCloseRetryContext = {
  readonly decision: 'close';
  readonly targetWidthPx: 0;
};

type AgentsPanelPointerReleaseRetryContext =
  | AgentsPanelCloseRetryContext
  | { readonly decision: 'restore-preferred'; readonly targetWidthPx: number }
  | { readonly decision: 'settle-minimum'; readonly targetWidthPx: number }
  | { readonly decision: 'commit-preferred'; readonly targetWidthPx: number };

type RailLayoutSyncRetryContext = {
  readonly decision: 'sync-rail-columns' | 'sync-doc-presence';
  readonly targetWidthPx: number;
};

type AgentsPanelKeyboardRetryContext = {
  readonly decision: 'keyboard-settle-minimum';
  readonly targetWidthPx: typeof MIN_AGENTS_PANEL_WIDTH;
};

type RailLayoutRetryContext =
  | AgentsPanelPointerReleaseRetryContext
  | AgentsPanelKeyboardRetryContext
  | RailLayoutSyncRetryContext;

type RailLayoutRetryOutcome = 'applied' | 'blocked' | 'failed';

type RailLayoutRetryController = {
  frameId: number;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  context?: RailLayoutRetryContext;
};

type RailLayoutRetryControllerRef = {
  current: RailLayoutRetryController;
};

function createAgentsPanelPointerReleaseRetryContext(
  decision: AgentsPanelPointerReleaseDecision,
): AgentsPanelPointerReleaseRetryContext {
  switch (decision.kind) {
    case 'close':
      return { decision: decision.kind, targetWidthPx: 0 };
    case 'restore-preferred':
    case 'settle-minimum':
    case 'commit-preferred':
      return { decision: decision.kind, targetWidthPx: decision.widthPx };
    default: {
      const exhaustiveDecision: never = decision;
      return exhaustiveDecision;
    }
  }
}

function reportUnexpectedPanelGroupFailure(
  event: string,
  error: unknown,
  context?: RailLayoutRetryContext,
) {
  if (error instanceof Error && PANEL_GROUP_UNAVAILABLE_MESSAGE.test(error.message)) return;
  console.warn(
    JSON.stringify({
      event,
      error: error instanceof Error ? error.message : String(error),
      ...context,
    }),
  );
}

function cancelRailLayoutRetry(retryRef: RailLayoutRetryControllerRef) {
  if (retryRef.current.frameId !== 0) cancelAnimationFrame(retryRef.current.frameId);
  if (retryRef.current.deadlineTimer != null) clearTimeout(retryRef.current.deadlineTimer);
  retryRef.current.frameId = 0;
  retryRef.current.deadlineTimer = null;
  retryRef.current.context = undefined;
}

function runRailLayoutRetry({
  retryRef,
  attempt,
  context,
  onComplete,
  onExhausted,
}: {
  retryRef: RailLayoutRetryControllerRef;
  attempt: () => RailLayoutRetryOutcome;
  context: RailLayoutRetryContext;
  onComplete?: () => void;
  onExhausted?: () => void;
}) {
  cancelRailLayoutRetry(retryRef);
  retryRef.current.context = context;
  const deadlineTimestamp = performance.now() + BLOCKED_RAIL_LAYOUT_RETRY_DEADLINE_MS;
  const completeRetry = () => {
    cancelRailLayoutRetry(retryRef);
    onComplete?.();
  };
  const completeExhaustedRetry = () => {
    cancelRailLayoutRetry(retryRef);
    reportUnexpectedPanelGroupFailure(
      'rail-layout-retry-exhausted',
      new Error('Rail layout did not apply within the retry budget'),
      context,
    );
    onExhausted?.();
    onComplete?.();
  };
  retryRef.current.deadlineTimer = setTimeout(
    completeExhaustedRetry,
    BLOCKED_RAIL_LAYOUT_RETRY_DEADLINE_MS,
  );
  const retry = (failuresLeft: number, frameTimestamp?: number) => {
    retryRef.current.frameId = 0;
    if (frameTimestamp != null && frameTimestamp >= deadlineTimestamp) {
      completeExhaustedRetry();
      return;
    }
    const outcome = attempt();
    switch (outcome) {
      case 'applied':
        completeRetry();
        return;
      case 'blocked':
        retryRef.current.frameId = requestAnimationFrame((timestamp) =>
          retry(failuresLeft, timestamp),
        );
        return;
      case 'failed':
        if (failuresLeft <= 0) {
          completeExhaustedRetry();
          return;
        }
        retryRef.current.frameId = requestAnimationFrame((timestamp) =>
          retry(failuresLeft - 1, timestamp),
        );
        return;
      default: {
        const exhaustiveOutcome: never = outcome;
        return exhaustiveOutcome;
      }
    }
  };
  retry(30);
}

const SkillEditBanner = lazy(async () => ({
  default: (await import('@/components/SkillEditBanner')).SkillEditBanner,
}));

const LazyLintConfigEditor = lazy(async () => {
  const mod = await import('@/components/LintConfigEditor');
  return { default: mod.LintConfigEditor };
});

const LazySchemaConfigEditor = lazy(async () => {
  const mod = await import('@/components/SchemaConfigEditor');
  return { default: mod.SchemaConfigEditor };
});

function ConfigEditorFallback() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex h-full items-center justify-center text-sm text-muted-foreground"
    >
      <Trans>Loading editor</Trans>
    </div>
  );
}

function PaneDocumentToolbar({
  docName,
  provider,
  isSourceMode,
  onModeChange,
  isPanelCollapsed,
  onTogglePanel,
  reserveRightGutter,
}: {
  docName: string;
  provider: HocuspocusProvider;
  isSourceMode: boolean;
  onModeChange: (mode: EditorMode) => void;
  isPanelCollapsed: boolean;
  onTogglePanel: () => void;
  reserveRightGutter: boolean;
}) {
  const { requestAddProperty } = useProperties();
  const syncStatus = useSyncStatus(provider);
  const { data: frontmatterLintConfig } = useDocLintConfig(docName);
  const { missing: missingProperties } = partitionFrontmatterProblems(
    useFrontmatterDiagnostics(
      isSourceMode ? null : provider,
      frontmatterLintConfig?.effective ?? null,
    ),
  );
  const conflict = useDocConflict(docName);
  if (conflict !== null) return null;

  return (
    <EditorToolbar
      activeDocName={docName}
      activeProvider={isSlidesHost() ? provider : null}
      isSourceMode={isSourceMode}
      sourceDisabled={syncStatus !== 'connected' && syncStatus !== 'synced'}
      onModeChange={onModeChange}
      showAddPropertyButton={!isSourceMode}
      onAddProperty={() => requestAddProperty(docName)}
      frontmatterProblems={missingProperties}
      isPanelCollapsed={isPanelCollapsed}
      onTogglePanel={onTogglePanel}
      reserveRightGutter={reserveRightGutter}
    />
  );
}

const LazyTimelineDiffPane = lazy(async () => {
  const mod = await import('@/components/TimelineDiffPane');
  return { default: mod.TimelineDiffPane };
});
const LazyAgentDiffPane = lazy(async () => {
  const mod = await import('@/components/AgentDiffPane');
  return { default: mod.AgentDiffPane };
});

export const MAX_RAIL_PIN_EXHAUSTED_REPORTS = 5;

type RailPinOutcome =
  | { readonly stage: 'pinned' }
  | { readonly stage: 'group-missing' }
  | { readonly stage: 'read-failed' }
  | { readonly stage: 'panel-space-unresolved'; readonly refusal: RailPanelSpaceRefusal }
  | { readonly stage: 'layout-unaccounted'; readonly unaccountedIds: readonly string[] }
  | { readonly stage: 'no-residual-panel' }
  | { readonly stage: 'no-pinned-columns' }
  | { readonly stage: 'pins-do-not-fit'; readonly shortfall: Record<string, RailWidthShortfall> }
  | { readonly stage: 'write-failed' }
  | { readonly stage: 'verify-failed' }
  | { readonly stage: 'width-shortfall'; readonly shortfall: Record<string, RailWidthShortfall> };

type RailPinExhaustedTrigger = 'rail-column-sync' | 'doc-slot-presence';

const DOC_PANEL_MIN_WIDTH_PX = 300;
const DOC_PANEL_MIN_SIZE = `${DOC_PANEL_MIN_WIDTH_PX}px`;
const DOC_PANEL_MAX_SIZE = '600px';

interface SessionPanelPlacement {
  readonly container: HTMLElement | null;
  readonly isShowing: boolean;
}

export interface SessionPlacements {
  readonly terminal: SessionPanelPlacement;
  readonly agents: SessionPanelPlacement;
  readonly editorRegion: HTMLElement | null;
}

interface EditorAreaProps {
  editorMode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  activeTab: PanelTab;
  onActiveTabChange: (tab: PanelTab) => void;
  terminalBridge?: OkDesktopBridge | null;
  terminalVisible?: boolean;
  terminalPlacement?: TerminalPlacement;
  terminalRightWidth?: number;
  onTerminalVisibleChange?: (visible: boolean) => void;
  onTerminalRightWidthChange?: (width: number) => void;
  agentsVisible?: boolean;
  onAgentsVisibleChange?: (visible: boolean) => void;
  onSessionPlacements?: (placements: SessionPlacements) => void;
  onRevealAgents?: () => void;
  renderWorkspaceHeader?: (tabs: ReactNode) => ReactNode;
}

function renderTabsWithoutHeader(tabs: ReactNode): ReactNode {
  return tabs;
}

export function EditorArea(props: EditorAreaProps) {
  return (
    <ProfilerBoundary name="editor-area">
      {}
      <PropertyProvider>
        <EditorAreaInner {...props} />
        <SettingsDialogPortal />
      </PropertyProvider>
    </ProfilerBoundary>
  );
}

function SettingsDialogPortal() {
  const settingsRoute = useSettingsRoute();
  return (
    <SettingsDialogShell
      open={settingsRoute.open}
      initialSection={settingsRoute.section}
      onOpenChange={(next) => {
        if (!next) settingsRoute.close();
      }}
    />
  );
}

function EditorAreaInner({
  editorMode,
  onModeChange,
  activeTab,
  onActiveTabChange,
  terminalBridge,
  terminalVisible = false,
  terminalPlacement = 'bottom',
  terminalRightWidth,
  onTerminalVisibleChange,
  onTerminalRightWidthChange,
  agentsVisible = false,
  onAgentsVisibleChange,
  onSessionPlacements,
  onRevealAgents,
  renderWorkspaceHeader = renderTabsWithoutHeader,
}: EditorAreaProps) {
  const { t } = useLingui();
  const noteWindow = isNoteWindow();
  const {
    activeDocName,
    activeProvider,
    activeTarget,
    activeNewTabId,
    recycleDocument,
    docPanelMode,
    docPanelAgentId,
    docPanelExpandSignal,
    closeActivityPanel,
  } = useDocumentContext();
  const { openDocumentTransition } = useDocumentTransition();
  const stats = useDocumentStats(activeProvider, activeDocName);
  const editingSurface = editingSurfaceFor(activeDocName, editorMode);
  const selectionStats = useSelectionStats(activeDocName, editingSurface);
  const [everHadProvider, setEverHadProvider] = useState(false);
  useEffect(() => {
    if (activeProvider != null && !everHadProvider) setEverHadProvider(true);
  }, [activeProvider, everHadProvider]);
  const deferredActiveDocName = useDeferredValue(activeDocName);
  const isSourceMode = editorMode === 'source';
  const isNewDoc = activeTarget?.kind === 'missing';
  const showStats = !!activeDocName && activeTarget?.kind !== 'folder';
  const editorPlaceholder = isNewDoc ? t`Start writing to create this page` : undefined;
  const timelineDiff = useTimelineDiffView();
  useEffect(() => {
    if (timelineDiff && timelineDiff.docName !== activeDocName) closeTimelineDiff();
  }, [activeDocName, timelineDiff]);
  const agentDiff = useAgentDiffView();
  const agentDiffDoc = agentDiff?.docName ?? null;
  const agentDiffNavTargetRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed only on the target doc; activeDocName/openDocumentTransition are read fresh, not tracked, so this fires only when the current edit's doc changes and never fights a manual nav-away
  useEffect(() => {
    if (agentDiffDoc == null) {
      agentDiffNavTargetRef.current = null;
      return;
    }
    agentDiffNavTargetRef.current = agentDiffDoc;
    if (agentDiffDoc !== activeDocName) {
      const nextHash = hashFromDocName(agentDiffDoc);
      if (isSameHash(window.location.hash, nextHash)) openDocumentTransition(agentDiffDoc);
      else window.location.hash = nextHash;
    }
  }, [agentDiffDoc]);
  useEffect(() => {
    if (agentDiffDoc == null) return;
    if (agentDiffDoc === activeDocName) {
      agentDiffNavTargetRef.current = null;
      return;
    }
    if (agentDiffNavTargetRef.current === agentDiffDoc) return;
    closeAgentDiff();
  }, [activeDocName, agentDiffDoc]);
  useEffect(() => {
    const agentPanelOpen = docPanelMode === 'agent' && docPanelAgentId !== null;
    if (!agentPanelOpen) closeAgentDiff();
  }, [docPanelMode, docPanelAgentId]);
  const pendingReceiveNav = useSyncExternalStore(
    pendingReceiveNavStore.subscribe,
    pendingReceiveNavStore.getSnapshot,
    pendingReceiveNavStore.getSnapshot,
  );
  const shareReceiveMiss = matchesShareReceiveMiss(activeTarget, pendingReceiveNav);

  const [embeddedHost] = useState(() => detectEmbeddedHostFromBrowser());
  const isEmbedded = embeddedHost !== null;
  const [rightPartition, setRightPartition] = useState(() =>
    resolvePartition(embeddedHost, window.innerWidth, 'right'),
  );
  const rightPartitionRef = useRef(rightPartition);
  useEffect(() => {
    rightPartitionRef.current = rightPartition;
  }, [rightPartition]);
  const panelRef = usePanelRef();
  const agentsColumnPanelRef = usePanelRef();
  const terminalColumnPanelRef = usePanelRef();
  const [initialRightCollapsed] = useState(() => {
    const pins = readPins();
    return resolveEffectiveState('right', rightPartition, pins) === 'collapsed';
  });
  const [isCollapsed, setIsCollapsed] = useState(initialRightCollapsed);
  const isCollapsedRef = useRef(isCollapsed);

  const [agentsContainer, setAgentsContainer] = useState<HTMLDivElement | null>(null);
  const [rightTerminalContainer, setRightTerminalContainer] = useState<HTMLDivElement | null>(null);
  const [workspaceHeaderContainer, setWorkspaceHeaderContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [workspaceColumnEl, setWorkspaceColumnEl] = useState<HTMLDivElement | null>(null);
  const [bottomTerminalContainer, setBottomTerminalContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [terminalEditorRegion, setTerminalEditorRegion] = useState<HTMLDivElement | null>(null);

  const agentsColumnPresent = !noteWindow && agentsVisible;
  const terminalColumnPresent = !noteWindow && terminalVisible && terminalPlacement === 'right';
  const [agentsColumnCollapsed, setAgentsColumnCollapsed] = useState(false);
  const [terminalColumnCollapsed, setTerminalColumnCollapsed] = useState(false);
  const [agentsShowingHold, setAgentsShowingHold] = useState(false);
  const [terminalShowingHold, setTerminalShowingHold] = useState(false);
  const resizableRailColumnPresent = terminalColumnPresent || agentsColumnPresent;
  const rightRevealTabPresent =
    !noteWindow && (!agentsVisible || agentsColumnCollapsed) && onRevealAgents != null;
  const terminalContainer =
    terminalPlacement === 'right' ? rightTerminalContainer : bottomTerminalContainer;
  const terminalShowing =
    terminalVisible &&
    terminalContainer != null &&
    (terminalPlacement !== 'right' || !terminalColumnCollapsed || terminalShowingHold);
  const agentsShowing =
    agentsColumnPresent && (!agentsColumnCollapsed || agentsShowingHold) && agentsContainer != null;
  useEffect(() => {
    onSessionPlacements?.({
      terminal: { container: terminalContainer, isShowing: terminalShowing },
      agents: { container: agentsContainer, isShowing: agentsShowing },
      editorRegion: terminalEditorRegion,
    });
  }, [
    onSessionPlacements,
    terminalContainer,
    terminalShowing,
    agentsContainer,
    agentsShowing,
    terminalEditorRegion,
  ]);
  useEffect(() => {
    if (!agentsColumnPresent) setAgentsShowingHold(false);
    if (!terminalColumnPresent) setTerminalShowingHold(false);
  }, [agentsColumnPresent, terminalColumnPresent]);

  useEffect(() => {
    isCollapsedRef.current = isCollapsed;
  }, [isCollapsed]);
  const [isDraggingDocHandle, setIsDraggingDocHandle] = useState(false);
  const isDraggingDocHandleRef = useRef(false);

  const [initialDocPanelWidthPx] = useState(() => getInitialDocPanelWidth());
  const docPanelWidthPxRef = useRef(initialDocPanelWidthPx);
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function debouncedWriteDocPanelWidth(px: number) {
    if (writeTimerRef.current != null) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      writeDocPanelWidth(px);
      writeTimerRef.current = null;
    }, 100);
  }

  const [initialAgentsWidthPx] = useState(() => getInitialAgentsPanelWidth());
  const agentsPreferredWidthPxRef = useRef(initialAgentsWidthPx);
  const [isDraggingAgentsHandle, setIsDraggingAgentsHandle] = useState(false);
  const isDraggingAgentsHandleRef = useRef(false);
  const agentsSettlementRetryRef = useRef<RailLayoutRetryController>({
    frameId: 0,
    deadlineTimer: null,
  });
  const railColumnSyncRetryRef = useRef<RailLayoutRetryController>({
    frameId: 0,
    deadlineTimer: null,
  });
  const pendingAgentsVisibilityRetryContextRef = useRef<AgentsPanelCloseRetryContext | null>(null);

  const [initialTerminalWidthPx] = useState(() =>
    Math.max(
      terminalRightWidth ?? PREFERRED_TERMINAL_RIGHT_WIDTH,
      RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX,
    ),
  );
  const terminalWidthPxRef = useRef(initialTerminalWidthPx);
  const [isDraggingTerminalHandle, setIsDraggingTerminalHandle] = useState(false);
  const isDraggingTerminalHandleRef = useRef(false);
  const terminalWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function debouncedWriteTerminalWidth(px: number) {
    if (terminalWriteTimerRef.current != null) clearTimeout(terminalWriteTimerRef.current);
    terminalWriteTimerRef.current = setTimeout(() => {
      onTerminalRightWidthChange?.(px);
      terminalWriteTimerRef.current = null;
    }, 100);
  }

  useEffect(
    () => () => {
      if (writeTimerRef.current != null) clearTimeout(writeTimerRef.current);
      if (terminalWriteTimerRef.current != null) clearTimeout(terminalWriteTimerRef.current);
      cancelRailLayoutRetry(agentsSettlementRetryRef);
    },
    [],
  );

  const [groupContainerEl, setGroupContainerEl] = useState<HTMLDivElement | null>(null);
  const groupContainerElRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (workspaceHeaderContainer == null || workspaceColumnEl == null) return;
    const updateTabsWidth = () => {
      workspaceHeaderContainer.style.setProperty(
        '--editor-header-tabs-width',
        `${workspaceColumnEl.getBoundingClientRect().width}px`,
      );
    };
    updateTabsWidth();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateTabsWidth);
    observer.observe(workspaceColumnEl);
    return () => observer.disconnect();
  }, [workspaceHeaderContainer, workspaceColumnEl]);

  const docSlotPresentRef = useRef(false);
  const presenceRepinRetryRef = useRef<RailLayoutRetryController>({
    frameId: 0,
    deadlineTimer: null,
  });
  const railPinOutcomeRef = useRef<RailPinOutcome>({ stage: 'group-missing' });
  const railPinExhaustedReportsRef = useRef<Record<RailPinExhaustedTrigger, number>>({
    'rail-column-sync': 0,
    'doc-slot-presence': 0,
  });

  const reportRailPinExhausted = useEffectEvent((trigger: RailPinExhaustedTrigger) => {
    if (railPinExhaustedReportsRef.current[trigger] >= MAX_RAIL_PIN_EXHAUSTED_REPORTS) return;
    railPinExhaustedReportsRef.current[trigger] += 1;
    console.warn(
      JSON.stringify({
        event: 'right-rail-pin-exhausted',
        trigger,
        ...railPinOutcomeRef.current,
      }),
    );
  });

  const groupRef = useGroupRef();
  function resolveGroupPxWidth(): number | null {
    return resolveRailPanelSpacePx(groupContainerElRef.current);
  }

  function resolveAdmissionMetrics(): {
    workspaceWidthPx: number;
    otherRailWidthPx: number;
  } | null {
    const group = groupRef.current;
    if (group == null) return null;
    try {
      const workspaceWidthPx = resolveGroupPxWidth();
      if (workspaceWidthPx == null) return null;
      if (!docSlotPresentRef.current) {
        return { workspaceWidthPx, otherRailWidthPx: 0 };
      }
      const measuredWidthPx = panelRef.current?.getSize().inPixels;
      const docWidthPx =
        measuredWidthPx != null && measuredWidthPx > 0
          ? measuredWidthPx
          : docPanelWidthPxRef.current;
      return {
        workspaceWidthPx,
        otherRailWidthPx: Math.max(docWidthPx, DOC_PANEL_MIN_WIDTH_PX),
      };
    } catch (error) {
      reportUnexpectedPanelGroupFailure('resolve-admission-metrics-failed', error);
      return null;
    }
  }

  type AdmissionVisibility = {
    readonly terminalRightVisible: boolean;
    readonly agentsVisible: boolean;
  };
  const admissionVisibility: AdmissionVisibility = {
    terminalRightVisible: terminalColumnPresent,
    agentsVisible,
  };
  const admissionVisibilityRef = useRef(admissionVisibility);
  const previousAdmissionVisibilityRef = useRef(admissionVisibility);
  const previousAdmissionCollapsedRef = useRef(isCollapsed);
  const pendingAdmissionCloseRef = useRef<'close-agents' | 'close-terminal' | null>(null);

  function enforceRightRailAdmission(
    trigger: 'state-change' | 'resize',
    previous: AdmissionVisibility,
  ) {
    const metrics = resolveAdmissionMetrics();
    if (metrics == null) return;
    const decision = resolveRightRailAdmission({
      ...metrics,
      agentsMinimumWidthPx: MIN_AGENTS_PANEL_WIDTH,
      previous,
      current: admissionVisibilityRef.current,
      trigger,
    });
    if (decision.kind === 'none' || pendingAdmissionCloseRef.current === decision.kind) return;

    if (decision.kind === 'close-agents') {
      if (onAgentsVisibleChange == null) return;
      pendingAdmissionCloseRef.current = decision.kind;
      onAgentsVisibleChange(false);
      toast.info(t`Agent panel closed to keep Terminal readable.`);
      return;
    }

    if (onTerminalVisibleChange == null) return;
    pendingAdmissionCloseRef.current = decision.kind;
    onTerminalVisibleChange(false);
    toast.info(t`Terminal closed to make room for the agent panel.`);
  }

  const enforceRightRailAdmissionRef = useRef(enforceRightRailAdmission);
  useLayoutEffect(() => {
    enforceRightRailAdmissionRef.current = enforceRightRailAdmission;
    admissionVisibilityRef.current = admissionVisibility;
  });

  useLayoutEffect(() => {
    if (!agentsVisible && pendingAdmissionCloseRef.current === 'close-agents') {
      pendingAdmissionCloseRef.current = null;
    }
    if (!terminalColumnPresent && pendingAdmissionCloseRef.current === 'close-terminal') {
      pendingAdmissionCloseRef.current = null;
    }
    const previous = previousAdmissionVisibilityRef.current;
    const previousCollapsed = previousAdmissionCollapsedRef.current;
    previousAdmissionVisibilityRef.current = {
      terminalRightVisible: terminalColumnPresent,
      agentsVisible,
    };
    previousAdmissionCollapsedRef.current = isCollapsed;
    queueMicrotask(() => {
      enforceRightRailAdmissionRef.current(
        previousCollapsed === isCollapsed ? 'state-change' : 'resize',
        previous,
      );
    });
  }, [agentsVisible, terminalColumnPresent, isCollapsed]);

  function applyRailLayout(
    docCollapsed: boolean,
    {
      agentsWidthOverridePx,
    }: {
      agentsWidthOverridePx?: number;
    } = {},
  ): boolean {
    const group = groupRef.current;
    if (group == null) {
      railPinOutcomeRef.current = { stage: 'group-missing' };
      return false;
    }
    let panelSpace: RailPanelSpaceResult;
    let layout: Record<string, number>;
    try {
      panelSpace = resolveRailPanelSpace(groupContainerElRef.current);
      layout = group.getLayout();
    } catch (error) {
      railPinOutcomeRef.current = { stage: 'read-failed' };
      reportUnexpectedPanelGroupFailure('apply-rail-layout-read-failed', error);
      return false;
    }
    if (!panelSpace.ok) {
      railPinOutcomeRef.current = { stage: 'panel-space-unresolved', refusal: panelSpace.refusal };
      return false;
    }
    const containerPx = panelSpace.panelSpacePx;
    const accounting = accountRailLayout(Object.keys(layout));
    if (!accounting.ok) {
      railPinOutcomeRef.current =
        accounting.unaccountedIds.length === 0
          ? { stage: 'no-residual-panel' }
          : { stage: 'layout-unaccounted', unaccountedIds: accounting.unaccountedIds };
      if (import.meta.env.DEV) {
        console.warn(
          JSON.stringify({
            event: 'right-rail-accounting-failed',
            unaccountedIds: accounting.unaccountedIds,
          }),
        );
      }
      return false;
    }
    const residualId = accounting.residualId;

    const buildPins = (atFloor: boolean): Record<string, number> => {
      const pins: Record<string, number> = {};
      if (DOC_PANEL_ID in layout) {
        pins[DOC_PANEL_ID] =
          !docSlotPresentRef.current || docCollapsed
            ? 0
            : atFloor
              ? DOC_PANEL_MIN_WIDTH_PX
              : docPanelWidthPxRef.current;
      }
      if (TERMINAL_COLUMN_ID in layout) {
        pins[TERMINAL_COLUMN_ID] = !admissionVisibilityRef.current.terminalRightVisible
          ? 0
          : atFloor
            ? RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX
            : terminalWidthPxRef.current;
      }
      if (AGENTS_COLUMN_ID in layout) {
        pins[AGENTS_COLUMN_ID] = !admissionVisibilityRef.current.agentsVisible
          ? 0
          : atFloor
            ? MIN_AGENTS_PANEL_WIDTH
            : (agentsWidthOverridePx ?? agentsPreferredWidthPxRef.current);
      }
      return pins;
    };

    const widthsFrom = (pcts: Record<string, number>) => {
      const widths = new Map<string, number>();
      for (const [id, pct] of Object.entries(pcts)) widths.set(id, (pct / 100) * containerPx);
      return widths;
    };

    let pins = buildPins(false);
    if (Object.keys(pins).length === 0) {
      railPinOutcomeRef.current = { stage: 'no-pinned-columns' };
      return false;
    }

    let next = computeStickyRepinLayout({
      currentLayout: layout,
      containerPx,
      pinnedPx: pins,
      residualId,
    });
    if (next === layout) {
      pins = buildPins(true);
      next = computeStickyRepinLayout({
        currentLayout: layout,
        containerPx,
        pinnedPx: pins,
        residualId,
      });
    }
    if (next === layout) {
      const shortfall = describeRailFloorShortfall(pins, widthsFrom(layout));
      const pinned = Object.keys(shortfall).length === 0;
      railPinOutcomeRef.current = pinned
        ? { stage: 'pinned' }
        : { stage: 'pins-do-not-fit', shortfall };
      return pinned;
    }
    try {
      group.setLayout(next);
    } catch (error) {
      railPinOutcomeRef.current = { stage: 'write-failed' };
      reportUnexpectedPanelGroupFailure('apply-rail-layout-write-failed', error);
      return false;
    }
    let readBack: Record<string, number>;
    try {
      readBack = group.getLayout();
    } catch (error) {
      railPinOutcomeRef.current = { stage: 'verify-failed' };
      reportUnexpectedPanelGroupFailure('apply-rail-layout-verify-failed', error);
      return false;
    }
    const shortfall = describeRailWidthShortfall(pins, widthsFrom(readBack));
    const pinned = Object.keys(shortfall).length === 0;
    railPinOutcomeRef.current = pinned
      ? { stage: 'pinned' }
      : { stage: 'width-shortfall', shortfall };
    return pinned;
  }

  function reclaimHiddenRailColumn(columnId: string, present: boolean, widthPx: number) {
    if (present || widthPx <= 0) return;
    queueMicrotask(() => {
      const group = groupRef.current;
      if (group == null) return;
      let layout: Record<string, number>;
      let containerPx: number | null;
      try {
        layout = group.getLayout();
        containerPx = resolveGroupPxWidth();
      } catch (error) {
        reportUnexpectedPanelGroupFailure('reclaim-hidden-rail-read-failed', error);
        return;
      }
      if (containerPx == null || !(columnId in layout) || layout[columnId] === 0) return;
      const residualId = findResidualPanelId(Object.keys(layout));
      if (residualId == null) return;
      const next = computeStickyRepinLayout({
        currentLayout: layout,
        containerPx,
        pinnedPx: { [columnId]: 0 },
        residualId,
      });
      if (next === layout) return;
      try {
        group.setLayout(next);
      } catch (error) {
        reportUnexpectedPanelGroupFailure('reclaim-hidden-rail-write-failed', error);
      }
    });
  }

  function attemptRailLayout(
    docCollapsed: boolean,
    overrides?: { agentsWidthOverridePx?: number },
  ): RailLayoutRetryOutcome {
    if (
      isDraggingDocHandleRef.current ||
      isDraggingTerminalHandleRef.current ||
      isDraggingAgentsHandleRef.current
    )
      return 'blocked';
    isCollapsedRef.current = docCollapsed;
    return applyRailLayout(docCollapsed, overrides) ? 'applied' : 'failed';
  }

  function assertRightRailLayout(docCollapsed: boolean): boolean {
    return attemptRailLayout(docCollapsed) !== 'failed';
  }

  const assertRightRailLayoutRef = useRef(assertRightRailLayout);
  useEffect(() => {
    assertRightRailLayoutRef.current = assertRightRailLayout;
  });

  const endHandleDragRef = useRef<(() => void) | null>(null);
  function trackHandleDrag(
    pointerId: number,
    setDragging: (dragging: boolean) => void,
    draggingRef: { current: boolean },
    onCommit?: () => void,
    onDragEnd?: () => void,
  ) {
    endHandleDragRef.current?.();
    setDragging(true);
    draggingRef.current = true;
    function end() {
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      endHandleDragRef.current = null;
      setDragging(false);
      draggingRef.current = false;
      onDragEnd?.();
    }
    function onPointerUp(event: PointerEvent) {
      if (event.pointerId !== pointerId) return;
      end();
      onCommit?.();
    }
    function onPointerCancel(event: PointerEvent) {
      if (event.pointerId !== pointerId) return;
      end();
      assertRightRailLayoutRef.current(isCollapsedRef.current);
    }
    endHandleDragRef.current = end;
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }
  useEffect(() => () => endHandleDragRef.current?.(), []);

  function cancelAgentsSettlement() {
    cancelRailLayoutRetry(agentsSettlementRetryRef);
  }

  function cancelAgentsKeyboardSettlement() {
    if (agentsSettlementRetryRef.current.context?.decision === 'keyboard-settle-minimum') {
      cancelAgentsSettlement();
    }
  }

  function superviseAgentsPointerSettlement(context: AgentsPanelPointerReleaseRetryContext) {
    runRailLayoutRetry({
      retryRef: agentsSettlementRetryRef,
      attempt: () => attemptRailLayout(isCollapsedRef.current),
      context,
    });
  }

  function settleAgentsPointerRelease() {
    cancelAgentsSettlement();
    const measuredWidthPx = agentsColumnPanelRef.current?.getSize().inPixels;
    const decision = resolveAgentsPanelPointerRelease(
      measuredWidthPx,
      agentsPreferredWidthPxRef.current,
    );
    const context = createAgentsPanelPointerReleaseRetryContext(decision);
    switch (context.decision) {
      case 'close':
        if (onAgentsVisibleChange != null) {
          pendingAgentsVisibilityRetryContextRef.current = context;
          onAgentsVisibleChange(false);
        } else {
          superviseAgentsPointerSettlement(context);
        }
        return;
      case 'restore-preferred':
        agentsPreferredWidthPxRef.current = context.targetWidthPx;
        superviseAgentsPointerSettlement(context);
        return;
      case 'settle-minimum':
      case 'commit-preferred':
        agentsPreferredWidthPxRef.current = context.targetWidthPx;
        writeAgentsPanelWidth(context.targetWidthPx);
        superviseAgentsPointerSettlement(context);
        return;
      default: {
        const exhaustiveContext: never = context;
        return exhaustiveContext;
      }
    }
  }

  function settleAgentsKeyboardLayout(layout: Record<string, number>, isUserInteraction: boolean) {
    if (
      !isUserInteraction ||
      isDraggingDocHandleRef.current ||
      isDraggingTerminalHandleRef.current ||
      isDraggingAgentsHandleRef.current
    )
      return;
    const activeElement = document.activeElement;
    if (
      !(activeElement instanceof HTMLElement) ||
      !activeElement.hasAttribute('data-agents-panel-resize-handle')
    ) {
      cancelAgentsKeyboardSettlement();
      return;
    }
    cancelAgentsSettlement();
    const agentsPercentage = layout[AGENTS_COLUMN_ID];
    const groupWidthPx = resolveGroupPxWidth();
    if (agentsPercentage == null || groupWidthPx == null) return;
    const measuredWidthPx = (agentsPercentage / 100) * groupWidthPx;
    if (measuredWidthPx <= 0 || measuredWidthPx >= MIN_AGENTS_PANEL_WIDTH) return;
    runRailLayoutRetry({
      retryRef: agentsSettlementRetryRef,
      attempt: () =>
        attemptRailLayout(isCollapsedRef.current, {
          agentsWidthOverridePx: MIN_AGENTS_PANEL_WIDTH,
        }),
      context: {
        decision: 'keyboard-settle-minimum',
        targetWidthPx: MIN_AGENTS_PANEL_WIDTH,
      },
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: agentsVisible and render-bound attemptRailLayout are sampled only when rail column presence changes; the presence dependencies own retry replacement
  useEffect(() => {
    if (pendingAgentsVisibilityRetryContextRef.current?.decision === 'close' && agentsVisible) {
      pendingAgentsVisibilityRetryContextRef.current = null;
    }
    const pendingContext = pendingAgentsVisibilityRetryContextRef.current;
    const context: RailLayoutRetryContext = pendingContext ?? {
      decision: 'sync-rail-columns',
      targetWidthPx: agentsVisible ? agentsPreferredWidthPxRef.current : 0,
    };
    runRailLayoutRetry({
      retryRef: railColumnSyncRetryRef,
      attempt: () => attemptRailLayout(isCollapsedRef.current),
      context,
      onExhausted:
        pendingContext == null ? () => reportRailPinExhausted('rail-column-sync') : undefined,
      onComplete: () => {
        if (pendingAgentsVisibilityRetryContextRef.current === context) {
          pendingAgentsVisibilityRetryContextRef.current = null;
        }
      },
    });
    return () => cancelRailLayoutRetry(railColumnSyncRetryRef);
  }, [terminalColumnPresent, agentsColumnPresent]);

  function expandDocPanel() {
    if (!docSlotPresentRef.current) return;
    assertRightRailLayout(false);
  }

  function togglePanel() {
    if (!docSlotPresentRef.current) return;
    const partition = rightPartitionRef.current;
    const collapsed = isCollapsedRef.current;
    if (collapsed) {
      applyToggle('right', partition, 'open');
      assertRightRailLayout(false);
    } else {
      applyToggle('right', partition, 'collapsed');
      assertRightRailLayout(true);
    }
  }

  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${RIGHT_COLLAPSE_THRESHOLD}px)`);
    const onChange = () => {
      const newPartition = resolvePartition(embeddedHost, window.innerWidth, 'right');
      setRightPartition(newPartition);
      const pins = readPins();
      const effective = resolveEffectiveState('right', newPartition, pins);
      const nextCollapsed = effective === 'collapsed';
      setIsCollapsed(nextCollapsed);
      assertRightRailLayout(nextCollapsed);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [
    embeddedHost,
    // biome-ignore lint/correctness/useExhaustiveDependencies: assertRightRailLayout is render-bound; re-subscribing keeps the handler fresh (mirrors the ⌥⌘B menu effect below)
    assertRightRailLayout,
  ]);

  useEffect(() => {
    if (groupContainerEl == null) return;
    if (isEmbedded) return;
    const ro = new ResizeObserver(() => {
      assertRightRailLayoutRef.current(isCollapsedRef.current);
      enforceRightRailAdmissionRef.current('resize', admissionVisibilityRef.current);
    });
    ro.observe(groupContainerEl);
    return () => ro.disconnect();
  }, [groupContainerEl, isEmbedded]);

  const openRequestedDocPanelTab = useEffectEvent((tab: PanelTab) => {
    if (docPanelMode === 'agent') closeActivityPanel();
    onActiveTabChange(tab);
    expandDocPanel();
  });

  useEffect(() => {
    const pendingTab = consumePendingDocPanelTabRequest();
    if (pendingTab) {
      openRequestedDocPanelTab(pendingTab);
    }

    return subscribeToDocPanelTabRequests((tab) => {
      consumePendingDocPanelTabRequest();
      openRequestedDocPanelTab(tab);
    });
  }, []);

  useEffect(() => {
    if (docPanelExpandSignal === 0) return;
    expandDocPanel();
  }, [
    docPanelExpandSignal,
    // biome-ignore lint/correctness/useExhaustiveDependencies: expandDocPanel is render-bound; re-running keeps the closure fresh
    expandDocPanel,
  ]);

  useLayoutEffect(() => {
    if (!isCollapsed) return;
    const panelEl = document.getElementById(DOC_PANEL_ID);
    if (!panelEl?.contains(document.activeElement)) return;
    const toggle = document.querySelector<HTMLElement>('[data-doc-panel-toggle]');
    if (toggle) {
      toggle.focus();
      return;
    }
    document.querySelector<HTMLElement>('[data-sidebar="trigger"]')?.focus();
  }, [isCollapsed]);

  useEffect(() => {
    setViewMenuState({ docPanelVisible: !isCollapsed });
    if (window.okDesktop == null) return;
    window.okDesktop.editor.notifyViewMenuStateChanged({ docPanelVisible: !isCollapsed });
  }, [isCollapsed]);

  useEffect(() => {
    return subscribeLocalMenuAction((action) => {
      if (action === 'toggle-doc-panel') {
        togglePanel();
      }
    });
  }, [
    // biome-ignore lint/correctness/useExhaustiveDependencies: togglePanel is render-bound; re-subscribing keeps the handler fresh (mirrors sidebar.tsx ⌥⌘S effect)
    togglePanel,
  ]);

  useEffect(() => {
    if (window.okDesktop != null) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!matchesKeyboardShortcut(event, 'toggle-document-panel')) return;
      if (isOverlayLayerOpen()) return;
      event.preventDefault();
      togglePanel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    // biome-ignore lint/correctness/useExhaustiveDependencies: togglePanel is render-bound; re-subscribing keeps the handler fresh (mirrors sidebar.tsx ⌥⌘S effect)
    togglePanel,
  ]);

  const previousDocNameRef = useRef<string | null>(null);
  const [previousDocName, setPreviousDocName] = useState<string | null>(null);
  const [composerDismissed, setComposerDismissed] = useState(false);
  const [blobRunRevealedTabId, setBlobRunRevealedTabId] = useState<string | null>(null);
  const activeDocumentHistoryName =
    activeTarget?.kind === 'large-file' ? activeTarget.docName : activeDocName;
  useEffect(() => {
    if (activeDocumentHistoryName && activeDocumentHistoryName !== previousDocNameRef.current) {
      const prior = previousDocNameRef.current;
      previousDocNameRef.current = activeDocumentHistoryName;
      setPreviousDocName(prior);
    }
  }, [activeDocumentHistoryName]);

  function navigateBackToDoc(prev: string) {
    const nextHash = hashFromDocName(prev);
    if (isSameHash(window.location.hash, nextHash)) {
      openDocumentTransition(prev);
    } else {
      window.location.hash = nextHash;
    }
  }

  let viewContent: ReactNode;
  let docSlotContent: ReactNode = null;
  let renderFocusedDocument: ((activityMount: ReactNode) => ReactNode) | null = null;
  let coldStartSkeleton = false;

  if (activeTarget?.kind === 'large-file') {
    viewContent = (
      <LargeFileEditorState
        docName={activeTarget.docName}
        size={activeTarget.size}
        limit={activeTarget.limit}
        backNav={
          previousDocName ? { previousDocName, onNavigateBack: navigateBackToDoc } : undefined
        }
      />
    );
  } else if (activeTarget?.kind === 'folder') {
    const showFolderComposer = shouldShowFolderComposer({
      terminalVisible,
      agentsVisible,
      isEmbedded,
    });
    viewContent = (
      <div className="relative flex h-full min-h-0 flex-col">
        {}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <FolderOverview folderPath={activeTarget.folderPath} />
          {}
          {showFolderComposer ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-2 bg-linear-to-t from-background to-transparent"
            />
          ) : null}
        </div>
        {showFolderComposer ? <BottomComposer folderPath={activeTarget.folderPath} /> : null}
      </div>
    );
    const showAgentActivity = docPanelMode === 'agent' && docPanelAgentId !== null;
    if (showAgentActivity) {
      docSlotContent = (
        <Suspense
          fallback={
            <div
              role="status"
              aria-busy="true"
              className="flex h-full items-center justify-center text-sm text-muted-foreground"
            >
              <Trans>Loading agent activity</Trans>
            </div>
          }
        >
          <LazyActivityModeContent showBackButton={false} />
        </Suspense>
      );
    }
  } else if (
    activeTarget?.kind === 'asset' &&
    isMarkdownlintJsonConfig(activeTarget.assetPath.split('/').pop() ?? activeTarget.assetPath)
  ) {
    viewContent = (
      <Suspense fallback={<ConfigEditorFallback />}>
        <LazyLintConfigEditor key={activeTarget.assetPath} assetPath={activeTarget.assetPath} />
      </Suspense>
    );
  } else if (activeTarget?.kind === 'asset' && isFrontmatterSchemaAsset(activeTarget.assetPath)) {
    viewContent = (
      <Suspense fallback={<ConfigEditorFallback />}>
        <LazySchemaConfigEditor key={activeTarget.assetPath} assetPath={activeTarget.assetPath} />
      </Suspense>
    );
  } else if (activeTarget?.kind === 'asset') {
    viewContent = (
      <AssetPreview
        key={activeTarget.assetPath}
        assetPath={activeTarget.assetPath}
        mediaKind={activeTarget.mediaKind}
      />
    );
  } else if (activeTarget?.kind === 'skill-file') {
    viewContent = (
      <SkillFileViewer
        key={`${activeTarget.scope}/${activeTarget.name}/${activeTarget.host ?? ''}/${activeTarget.path}`}
        scope={activeTarget.scope}
        name={activeTarget.name}
        path={activeTarget.path}
        host={activeTarget.host}
      />
    );
  } else if (activeTarget?.kind === 'skill-preview') {
    viewContent = (
      <SkillPreviewTab
        key={`${activeTarget.flavor}:${activeTarget.source}:${activeTarget.name}:${activeTarget.level ?? ''}`}
        flavor={activeTarget.flavor}
        source={activeTarget.source}
        name={activeTarget.name}
        subtitle={activeTarget.subtitle}
        level={activeTarget.level}
        path={activeTarget.path}
        reserveRightGutter={rightRevealTabPresent}
      />
    );
  } else if (shareReceiveMiss) {
    viewContent = <ShareReceiveMissPanel key={shareReceiveMiss.path} nav={shareReceiveMiss} />;
  } else if (!activeProvider || !activeDocName) {
    const hashDoc = typeof window !== 'undefined' ? docNameFromHash(window.location.hash) : null;
    if (hashDoc !== null) {
      if (terminalBridge != null && everHadProvider) {
        viewContent = <EditorSkeleton />;
        docSlotContent = <div className="min-h-0 flex-1" />;
      } else {
        coldStartSkeleton = true;
      }
    } else if (isBlobRunnerNewTabId(activeNewTabId)) {
      viewContent = <OkBlobRunnerPage />;
    } else {
      viewContent =
        blobRunRevealedTabId !== null && blobRunRevealedTabId === activeNewTabId ? (
          <OkBlobRunnerPage autoStart />
        ) : (
          <EmptyEditorState
            terminalOpen={terminalVisible}
            bottomDockOpen={terminalVisible && terminalPlacement === 'bottom'}
            agentsOpen={agentsVisible}
            onRageStreak={
              activeNewTabId
                ? () => withViewTransition(() => setBlobRunRevealedTabId(activeNewTabId))
                : undefined
            }
          />
        );
    }
  } else {
    const showBottomComposer =
      shouldShowBottomComposer({
        terminalVisible,
        agentsVisible,
        isEmbedded,
        activeDocName,
      }) &&
      !(timelineDiff && timelineDiff.docName === activeDocName) &&
      !(agentDiff && agentDiffDoc === activeDocName);
    const externalSkillEdit = activeDocName ? parseExternalSkillDocName(activeDocName) : null;
    const renderEditorContent = (activityMount: ReactNode) => (
      <div className="relative flex h-full flex-col">
        {}
        {externalSkillEdit ? (
          <Suspense fallback={null}>
            <SkillEditBanner name={externalSkillEdit.name} />
          </Suspense>
        ) : null}
        <div className="relative min-h-0 flex-1">
          {}
          <div className="relative h-full">
            {activityMount}
            <FindReplaceController activeDocName={activeDocName} isSourceMode={isSourceMode} />
            {}
            {shouldPaintOverlay({
              activeDocName,
              deferredActiveDocName,
              mountResolved: activeDocName !== null && mountPromiseHasResolved(activeDocName),
              syncResolved: activeDocName !== null && syncPromiseHasResolved(activeDocName),
            }) ? (
              <div className="absolute inset-0 z-10 bg-background">
                <EditorSkeleton />
                {}
                {activeDocName !== null ? <MountStalledAffordance docName={activeDocName} /> : null}
              </div>
            ) : null}
            {}
            {timelineDiff && timelineDiff.docName === activeDocName ? (
              <Suspense fallback={null}>
                <LazyTimelineDiffPane
                  view={timelineDiff}
                  isPanelCollapsed={isCollapsed}
                  onTogglePanel={togglePanel}
                />
              </Suspense>
            ) : null}
            {}
            {agentDiff && agentDiffDoc === activeDocName ? (
              <Suspense fallback={null}>
                <LazyAgentDiffPane
                  view={agentDiff}
                  isPanelCollapsed={isCollapsed}
                  onTogglePanel={togglePanel}
                />
              </Suspense>
            ) : null}
          </div>
          {}
          {showBottomComposer ? (
            <BottomComposer
              docName={activeDocName}
              surface={editingSurface}
              dismissed={composerDismissed}
              onDismiss={() => setComposerDismissed(true)}
              onReopen={() => setComposerDismissed(false)}
            />
          ) : null}
        </div>
        <EditorFooter
          stats={stats}
          selectionStats={selectionStats}
          showStats={showStats}
          composerBadge={
            showBottomComposer && composerDismissed
              ? { onReopen: () => setComposerDismissed(false) }
              : null
          }
        />
      </div>
    );

    viewContent = null;
    renderFocusedDocument = renderEditorContent;
    docSlotContent = (
      <DocPanel
        docName={activeDocName}
        isSourceMode={isSourceMode}
        activeTab={activeTab}
        onActiveTabChange={onActiveTabChange}
        mode={docPanelMode}
        isCollapsed={isCollapsed}
      />
    );
  }

  if (noteWindow) docSlotContent = null;

  const docSlotPresent = docSlotContent != null;

  useLayoutEffect(() => {
    const docSlotPresenceChanged = docSlotPresentRef.current !== docSlotPresent;
    docSlotPresentRef.current = docSlotPresent;
    if (!docSlotPresenceChanged) return;
    const docCollapsed = isCollapsedRef.current;
    runRailLayoutRetry({
      retryRef: presenceRepinRetryRef,
      attempt: () => attemptRailLayout(docCollapsed),
      context: {
        decision: 'sync-doc-presence',
        targetWidthPx: agentsVisible ? agentsPreferredWidthPxRef.current : 0,
      },
      onExhausted: () => reportRailPinExhausted('doc-slot-presence'),
    });
  });
  useEffect(() => () => cancelRailLayoutRetry(presenceRepinRetryRef), []);

  function renderUnfocusedPane({
    activityMount,
    pane,
  }: EditorWorkspacePaneRenderContext): ReactNode {
    const target = pane.activeTarget;
    if (activityMount) return activityMount;
    if (target?.kind === 'large-file') {
      return (
        <LargeFileEditorState docName={target.docName} size={target.size} limit={target.limit} />
      );
    }
    if (target?.kind === 'folder') {
      return <FolderOverview folderPath={target.folderPath} />;
    }
    if (
      target?.kind === 'asset' &&
      isMarkdownlintJsonConfig(target.assetPath.split('/').pop() ?? target.assetPath)
    ) {
      return (
        <Suspense fallback={<ConfigEditorFallback />}>
          <LazyLintConfigEditor key={target.assetPath} assetPath={target.assetPath} />
        </Suspense>
      );
    }
    if (target?.kind === 'asset' && isFrontmatterSchemaAsset(target.assetPath)) {
      return (
        <Suspense fallback={<ConfigEditorFallback />}>
          <LazySchemaConfigEditor key={target.assetPath} assetPath={target.assetPath} />
        </Suspense>
      );
    }
    if (target?.kind === 'asset') {
      return (
        <AssetPreview
          key={target.assetPath}
          assetPath={target.assetPath}
          mediaKind={target.mediaKind}
        />
      );
    }
    if (target?.kind === 'skill-file') {
      return (
        <SkillFileViewer
          key={`${target.scope}/${target.name}/${target.host ?? ''}/${target.path}`}
          scope={target.scope}
          name={target.name}
          path={target.path}
          host={target.host}
        />
      );
    }
    if (target?.kind === 'skill-preview') {
      return (
        <SkillPreviewTab
          key={`${target.flavor}:${target.source}:${target.name}:${target.level ?? ''}`}
          flavor={target.flavor}
          source={target.source}
          name={target.name}
          subtitle={target.subtitle}
          level={target.level}
          path={target.path}
        />
      );
    }
    return <EmptyEditorState />;
  }

  function renderWorkspacePane(context: EditorWorkspacePaneRenderContext): ReactNode {
    if (!context.isFocused) return renderUnfocusedPane(context);
    return renderFocusedDocument ? renderFocusedDocument(context.activityMount) : viewContent;
  }

  function renderWorkspaceActivityPool({
    activityHosts,
    parkingHost,
    visibleDocNames,
  }: EditorWorkspaceActivityBindings): ReactNode {
    const renderableVisibleDocNames = shareReceiveMiss
      ? new Set([...visibleDocNames].filter((docName) => docName !== activeDocName))
      : visibleDocNames;
    const focusedDocName =
      activeDocName && renderableVisibleDocNames.has(activeDocName) ? activeDocName : undefined;
    const deferredDocName =
      deferredActiveDocName && renderableVisibleDocNames.has(deferredActiveDocName)
        ? deferredActiveDocName
        : undefined;
    const poolActiveDocName = focusedDocName
      ? (deferredDocName ?? focusedDocName)
      : renderableVisibleDocNames.values().next().value;
    if (!poolActiveDocName) return null;
    return (
      <EditorActivityPool
        activeDocName={poolActiveDocName}
        visibleDocNames={renderableVisibleDocNames}
        activityHosts={activityHosts}
        parkingHost={parkingHost}
        renderToolbar={(docName, provider) =>
          noteWindow ? null : (
            <PaneDocumentToolbar
              docName={docName}
              provider={provider}
              isSourceMode={isSourceMode}
              onModeChange={onModeChange}
              isPanelCollapsed={isCollapsed}
              onTogglePanel={togglePanel}
              reserveRightGutter={docName === activeDocName && rightRevealTabPresent && isCollapsed}
            />
          )
        }
        isSourceMode={isSourceMode}
        editorPlaceholder={poolActiveDocName === activeDocName ? editorPlaceholder : undefined}
        previousDocName={previousDocName ?? undefined}
        onNavigateBack={navigateBackToDoc}
        onRecycle={recycleDocument}
      />
    );
  }

  const leftColumn = (
    <TerminalDock
      placement={terminalPlacement}
      visible={terminalVisible}
      onVisibleChange={onTerminalVisibleChange ?? (() => {})}
      onBottomContainer={setBottomTerminalContainer}
      onEditorRegion={setTerminalEditorRegion}
    >
      <EditorWorkspace
        renderHeader={(tabs) =>
          workspaceHeaderContainer == null
            ? null
            : createPortal(renderWorkspaceHeader(tabs), workspaceHeaderContainer)
        }
        renderPane={renderWorkspacePane}
        renderActivityPool={renderWorkspaceActivityPool}
      />
    </TerminalDock>
  );

  const docSlot = (
    <>
      <ResizableHandle
        data-doc-panel-handle=""
        withHandle={docSlotPresent && !isCollapsed}
        disabled={!docSlotPresent || isCollapsed}
        className={docSlotPresent ? undefined : 'pointer-events-none'}
        style={docSlotPresent ? undefined : { display: 'none' }}
        onPointerDown={(event) => {
          trackHandleDrag(event.pointerId, setIsDraggingDocHandle, isDraggingDocHandleRef);
        }}
      />
      <ResizablePanel
        id={DOC_PANEL_ID}
        panelRef={panelRef}
        defaultSize={!docSlotPresent || initialRightCollapsed ? 0 : `${initialDocPanelWidthPx}px`}
        minSize={DOC_PANEL_MIN_SIZE}
        maxSize={docSlotPresent ? DOC_PANEL_MAX_SIZE : '0px'}
        collapsible
        collapsedSize={0}
        onResize={(size) => {
          if (docSlotPresent) {
            setIsCollapsed(size.asPercentage === 0);
          }
          if (size.inPixels > 0 && isDraggingDocHandleRef.current) {
            docPanelWidthPxRef.current = size.inPixels;
            debouncedWriteDocPanelWidth(size.inPixels);
          }
          reclaimHiddenRailColumn(DOC_PANEL_ID, docSlotPresent, size.inPixels);
        }}
        inert={!docSlotPresent || isCollapsed}
        className="flex flex-col bg-muted/20"
      >
        {docSlotContent}
      </ResizablePanel>
    </>
  );

  const terminalColumn = (
    <>
      <ResizableHandle
        withHandle={terminalColumnPresent}
        className={terminalColumnPresent ? undefined : 'pointer-events-none'}
        style={terminalColumnPresent ? undefined : { display: 'none' }}
        onPointerDown={(event) => {
          trackHandleDrag(
            event.pointerId,
            setIsDraggingTerminalHandle,
            isDraggingTerminalHandleRef,
            () => {
              if (terminalColumnPanelRef.current?.isCollapsed()) {
                onTerminalVisibleChange?.(false);
              }
            },
            () => {
              if (!terminalColumnPanelRef.current?.isCollapsed()) setTerminalShowingHold(false);
            },
          );
        }}
      />
      <ResizablePanel
        id={TERMINAL_COLUMN_ID}
        panelRef={terminalColumnPanelRef}
        defaultSize={terminalColumnPresent ? `${initialTerminalWidthPx}px` : 0}
        minSize={terminalColumnPresent ? `${RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX}px` : '0px'}
        maxSize={terminalColumnPresent ? undefined : '0px'}
        collapsible
        collapsedSize={0}
        onResize={(size) => {
          if (size.inPixels > 0 && isDraggingTerminalHandleRef.current) {
            terminalWidthPxRef.current = size.inPixels;
            debouncedWriteTerminalWidth(size.inPixels);
          }
          setTerminalColumnCollapsed(size.inPixels === 0);
          if (size.inPixels === 0 && isDraggingTerminalHandleRef.current) {
            setTerminalShowingHold(true);
          } else if (size.inPixels > 0 && !isDraggingTerminalHandleRef.current) {
            setTerminalShowingHold(false);
          }
          reclaimHiddenRailColumn(TERMINAL_COLUMN_ID, terminalColumnPresent, size.inPixels);
        }}
        className="flex flex-col"
      >
        <div
          ref={setRightTerminalContainer}
          data-terminal-panel-mount=""
          inert={!terminalColumnPresent || (terminalColumnCollapsed && !terminalShowingHold)}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        />
      </ResizablePanel>
    </>
  );

  const agentsColumn = (
    <>
      <ResizableHandle
        withHandle={agentsColumnPresent}
        aria-controls={terminalColumnPresent ? TERMINAL_COLUMN_ID : AGENTS_COLUMN_ID}
        aria-label={terminalColumnPresent ? t`Terminal` : t`Agents`}
        data-agents-panel-resize-handle=""
        className={agentsColumnPresent ? undefined : 'pointer-events-none'}
        style={agentsColumnPresent ? undefined : { display: 'none' }}
        onPointerDown={(event) => {
          cancelAgentsSettlement();
          trackHandleDrag(
            event.pointerId,
            setIsDraggingAgentsHandle,
            isDraggingAgentsHandleRef,
            settleAgentsPointerRelease,
            () => {
              if (!agentsColumnPanelRef.current?.isCollapsed()) setAgentsShowingHold(false);
            },
          );
        }}
      />
      <ResizablePanel
        id={AGENTS_COLUMN_ID}
        panelRef={agentsColumnPanelRef}
        defaultSize={agentsColumnPresent ? `${initialAgentsWidthPx}px` : 0}
        minSize="0px"
        maxSize={agentsColumnPresent ? '95%' : '0px'}
        collapsible
        collapsedSize={0}
        onResize={(size) => {
          setAgentsColumnCollapsed(size.inPixels === 0);
          if (size.inPixels === 0 && isDraggingAgentsHandleRef.current) {
            setAgentsShowingHold(true);
          } else if (size.inPixels > 0 && !isDraggingAgentsHandleRef.current) {
            setAgentsShowingHold(false);
          }
          reclaimHiddenRailColumn(AGENTS_COLUMN_ID, agentsColumnPresent, size.inPixels);
        }}
        className="flex flex-col"
      >
        {}
        <div
          ref={setAgentsContainer}
          data-agents-panel-mount=""
          inert={!agentsColumnPresent || (agentsColumnCollapsed && !agentsShowingHold)}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        />
      </ResizablePanel>
    </>
  );

  if (coldStartSkeleton) return <EditorSkeleton />;

  const editorAbsorbsResidual =
    (docSlotPresent && !initialRightCollapsed) || resizableRailColumnPresent;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={setWorkspaceHeaderContainer}
        data-editor-area-header=""
        className="relative z-30 shrink-0"
      />
      <div
        data-editor-area-panels=""
        className="relative flex min-h-0 flex-1"
        ref={(el) => {
          setGroupContainerEl(el);
          groupContainerElRef.current = el;
        }}
      >
        <ResizablePanelGroup
          orientation="horizontal"
          groupRef={groupRef}
          onLayoutChanged={(layout, meta) => {
            settleAgentsKeyboardLayout(layout, meta.isUserInteraction);
          }}
          data-dragging={
            isDraggingDocHandle || isDraggingTerminalHandle || isDraggingAgentsHandle || undefined
          }
        >
          <ResizablePanel
            minSize={resizableRailColumnPresent ? '5%' : '30%'}
            {...(editorAbsorbsResidual ? {} : { defaultSize: '100%' })}
          >
            <div ref={setWorkspaceColumnEl} className="flex h-full min-w-0 flex-col">
              {leftColumn}
            </div>
          </ResizablePanel>
          {docSlot}
          {terminalColumn}
          {agentsColumn}
        </ResizablePanelGroup>
        {rightRevealTabPresent ? (
          <TerminalRevealTab
            edge="right"
            onReveal={() => {
              if (agentsVisible && agentsColumnCollapsed) {
                assertRightRailLayout(isCollapsedRef.current);
              } else onRevealAgents();
            }}
            className="top-2.5 right-0"
          />
        ) : null}
      </div>
    </div>
  );
}
