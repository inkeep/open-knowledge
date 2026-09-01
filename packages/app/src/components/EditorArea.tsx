// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

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
import { syncPromiseHasResolved } from '@/editor/sync-promise';
import {
  partitionFrontmatterProblems,
  useFrontmatterDiagnostics,
} from '@/editor/useFrontmatterDiagnostics';
import { useDocumentStats } from '@/hooks/use-document-stats';
import { useLifecycleStatus } from '@/hooks/use-lifecycle-status';
import { useSelectionStats } from '@/hooks/use-selection-stats';
import { closeAgentDiff, useAgentDiffView } from '@/lib/agent-diff-store';
import {
  getInitialAgentsPanelWidth,
  MIN_AGENTS_PANEL_WIDTH,
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

function reportUnexpectedPanelGroupFailure(event: string, error: unknown) {
  if (error instanceof Error && PANEL_GROUP_UNAVAILABLE_MESSAGE.test(error.message)) return;
  console.warn(
    JSON.stringify({
      event,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
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
  const lifecycleStatus = useLifecycleStatus(docName);
  if (lifecycleStatus === 'conflict') return null;

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
  const selectionStats = useSelectionStats(
    activeDocName,
    editorMode === 'source' ? 'source' : 'wysiwyg',
  );
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
  const resizableRailColumnPresent = terminalColumnPresent || agentsColumnPresent;
  const rightRevealTabPresent = !noteWindow && !agentsVisible && onRevealAgents != null;
  const terminalContainer =
    terminalPlacement === 'right' ? rightTerminalContainer : bottomTerminalContainer;
  const terminalShowing = terminalVisible && terminalContainer != null;
  const agentsShowing = agentsColumnPresent && agentsContainer != null;
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
  const agentsWidthPxRef = useRef(initialAgentsWidthPx);
  const [isDraggingAgentsHandle, setIsDraggingAgentsHandle] = useState(false);
  const isDraggingAgentsHandleRef = useRef(false);
  const agentsWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function debouncedWriteAgentsWidth(px: number) {
    if (agentsWriteTimerRef.current != null) clearTimeout(agentsWriteTimerRef.current);
    agentsWriteTimerRef.current = setTimeout(() => {
      writeAgentsPanelWidth(px);
      agentsWriteTimerRef.current = null;
    }, 100);
  }

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
      if (agentsWriteTimerRef.current != null) clearTimeout(agentsWriteTimerRef.current);
      if (terminalWriteTimerRef.current != null) clearTimeout(terminalWriteTimerRef.current);
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
  const presenceRepinFrameRef = useRef(0);

  const groupRef = useGroupRef();
  function resolveGroupPxWidth(): number | null {
    for (const ref of [panelRef, terminalColumnPanelRef, agentsColumnPanelRef]) {
      const size = ref.current?.getSize();
      if (size != null && size.asPercentage > 1 && size.inPixels > 0) {
        return (size.inPixels / size.asPercentage) * 100;
      }
    }
    const el = groupContainerElRef.current;
    return el != null && el.offsetWidth > 0 ? el.offsetWidth : null;
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

  function applyRailLayout(docCollapsed: boolean): boolean {
    const group = groupRef.current;
    if (group == null) return false;
    let containerPx: number | null;
    let layout: Record<string, number>;
    try {
      containerPx = resolveGroupPxWidth();
      layout = group.getLayout();
    } catch (error) {
      reportUnexpectedPanelGroupFailure('apply-rail-layout-read-failed', error);
      return false;
    }
    if (containerPx == null) return false;
    const accounting = accountRailLayout(Object.keys(layout));
    if (!accounting.ok) {
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
    if (residualId == null) return false;

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
            : agentsWidthPxRef.current;
      }
      return pins;
    };

    let pins = buildPins(false);
    if (Object.keys(pins).length === 0) return false;

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
    if (next === layout) return true;
    try {
      group.setLayout(next);
    } catch (error) {
      reportUnexpectedPanelGroupFailure('apply-rail-layout-write-failed', error);
      return false;
    }
    let readBack: Record<string, number>;
    try {
      readBack = group.getLayout();
    } catch (error) {
      reportUnexpectedPanelGroupFailure('apply-rail-layout-verify-failed', error);
      return false;
    }
    for (const [id, px] of Object.entries(pins)) {
      const pct = readBack[id];
      if (pct == null) continue;
      if (Math.abs((pct / 100) * containerPx - px) > 1) return false;
    }
    return true;
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

  function assertRightRailLayout(docCollapsed: boolean): boolean {
    if (
      isDraggingDocHandleRef.current ||
      isDraggingTerminalHandleRef.current ||
      isDraggingAgentsHandleRef.current
    )
      return true;
    isCollapsedRef.current = docCollapsed;
    return applyRailLayout(docCollapsed);
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

  function syncRailColumns(): boolean {
    if (
      isDraggingDocHandleRef.current ||
      isDraggingTerminalHandleRef.current ||
      isDraggingAgentsHandleRef.current
    )
      return true;
    return applyRailLayout(isCollapsedRef.current);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    const frameRef = { id: 0 };
    const attempt = (attemptsLeft: number) => {
      if (syncRailColumns() || attemptsLeft <= 0) return;
      frameRef.id = requestAnimationFrame(() => attempt(attemptsLeft - 1));
    };
    attempt(30);
    return () => {
      if (frameRef.id !== 0) cancelAnimationFrame(frameRef.id);
    };
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
              surface={isSourceMode ? 'source' : 'wysiwyg'}
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
    if (presenceRepinFrameRef.current !== 0) {
      cancelAnimationFrame(presenceRepinFrameRef.current);
      presenceRepinFrameRef.current = 0;
    }
    const docCollapsed = isCollapsedRef.current;
    const attempt = (attemptsLeft: number) => {
      presenceRepinFrameRef.current = 0;
      if (assertRightRailLayoutRef.current(docCollapsed) || attemptsLeft <= 0) return;
      presenceRepinFrameRef.current = requestAnimationFrame(() => attempt(attemptsLeft - 1));
    };
    attempt(30);
  });
  useEffect(
    () => () => {
      if (presenceRepinFrameRef.current !== 0) {
        cancelAnimationFrame(presenceRepinFrameRef.current);
      }
    },
    [],
  );

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
          );
        }}
      />
      <ResizablePanel
        id={TERMINAL_COLUMN_ID}
        panelRef={terminalColumnPanelRef}
        defaultSize={terminalColumnPresent ? `${initialTerminalWidthPx}px` : 0}
        minSize={`${RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX}px`}
        maxSize={terminalColumnPresent ? undefined : '0px'}
        collapsible
        collapsedSize={0}
        onResize={(size) => {
          if (size.inPixels > 0 && isDraggingTerminalHandleRef.current) {
            terminalWidthPxRef.current = size.inPixels;
            debouncedWriteTerminalWidth(size.inPixels);
          }
          reclaimHiddenRailColumn(TERMINAL_COLUMN_ID, terminalColumnPresent, size.inPixels);
        }}
        className="flex flex-col"
      >
        <div
          ref={setRightTerminalContainer}
          data-terminal-panel-mount=""
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        />
      </ResizablePanel>
    </>
  );

  const agentsColumn = (
    <>
      <ResizableHandle
        withHandle={agentsColumnPresent}
        className={agentsColumnPresent ? undefined : 'pointer-events-none'}
        style={agentsColumnPresent ? undefined : { display: 'none' }}
        onPointerDown={(event) => {
          trackHandleDrag(
            event.pointerId,
            setIsDraggingAgentsHandle,
            isDraggingAgentsHandleRef,
            () => {
              if (agentsColumnPanelRef.current?.isCollapsed()) {
                onAgentsVisibleChange?.(false);
              }
            },
          );
        }}
      />
      <ResizablePanel
        id={AGENTS_COLUMN_ID}
        panelRef={agentsColumnPanelRef}
        defaultSize={agentsColumnPresent ? `${initialAgentsWidthPx}px` : 0}
        minSize={`${MIN_AGENTS_PANEL_WIDTH}px`}
        maxSize={agentsColumnPresent ? '95%' : '0px'}
        collapsible
        collapsedSize={0}
        onResize={(size) => {
          if (size.inPixels > 0 && isDraggingAgentsHandleRef.current) {
            agentsWidthPxRef.current = size.inPixels;
            debouncedWriteAgentsWidth(size.inPixels);
          }
          reclaimHiddenRailColumn(AGENTS_COLUMN_ID, agentsColumnPresent, size.inPixels);
        }}
        className="flex flex-col"
      >
        {}
        <div
          ref={setAgentsContainer}
          data-agents-panel-mount=""
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
          <TerminalRevealTab edge="right" onReveal={onRevealAgents} className="top-2.5 right-0" />
        ) : null}
      </div>
    </div>
  );
}
