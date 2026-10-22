import type { HocuspocusProvider } from '@hocuspocus/provider';
import { parseExternalSkillDocName } from '@inkeep/open-knowledge-core/constants/cc1';
import { detectEmbeddedHostFromBrowser } from '@inkeep/open-knowledge-core/constants/embedded-host';
import {
  isFrontmatterSchemaAsset,
  isMarkdownlintJsonConfig,
} from '@inkeep/open-knowledge-core/markdown/lint';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronLeft, PanelRightClose } from 'lucide-react';
import { useTheme } from 'next-themes';
import {
  lazy,
  type ReactNode,
  type Ref,
  Suspense,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { useGroupRef, usePanelRef } from 'react-resizable-panels';
import { toast } from 'sonner';
import { AssetPreview } from '@/components/AssetPreview';
import { DocChangeNotice } from '@/components/DocChangeNotice';
import { DockWorkspace } from '@/components/DockWorkspace';
import { DocPanel, type PanelTab } from '@/components/DocPanel';
import { DocPanelToggle } from '@/components/DocPanelToggle';
import {
  consumePendingDocPanelTabRequest,
  subscribeToDocPanelTabRequests,
} from '@/components/doc-panel-events';
import { EditorSkeleton } from '@/components/EditorSkeleton';
import { EmptyEditorState } from '@/components/EmptyEditorState';
import { useAttachFileListHost, useFileListHost } from '@/components/FileListHost';
import { FolderOverview } from '@/components/FolderOverview';
import { LargeFileEditorState } from '@/components/LargeFileEditorState';
import { MountStalledAffordance } from '@/components/MountStalledAffordance';
import { NothingOpen } from '@/components/NothingOpen';
import { OkBlobRunnerPage } from '@/components/OkBlobRunnerPage';
import { PropertyProvider, useProperties } from '@/components/PropertyContext';
import { PANE_LABEL } from '@/components/pane-icons';
import { ShareReceiveMissPanel } from '@/components/ShareReceiveMissPanel';
import { SkillFileViewer } from '@/components/SkillFileViewer';
import { SkillPreviewTab } from '@/components/SkillPreviewTab';
import { SettingsDialogShell } from '@/components/settings/SettingsDialogShell';
import { Button } from '@/components/ui/button';
import {
  PANE_CARD_GAP_PX,
  PaneCard,
  SECONDARY_PANEL_SURFACE_CLASS,
} from '@/components/ui/pane-card';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { docNameFromHash, hashFromDocName, isSameHash } from '@/lib/doc-hash';
import { getInitialDocPanelWidth, writeDocPanelWidth } from '@/lib/doc-panel-width-store';
import { dockTerminalPlacement } from '@/lib/dock-arrangement-store';
import { type DockLayout, dockPaneMinExtent, EMPTY_DOCK_LAYOUT } from '@/lib/dock-layout';
import type { DockNode } from '@/lib/dock-tree';
import { focusAwayFromHiddenEditor, focusWaitsForEditor } from '@/lib/editor-hidden-focus';
import { type EditorSidebar, resolveEditorSidebarFit } from '@/lib/editor-sidebar-fit';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';
import { isNoteWindow } from '@/lib/note-window-mode';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import type { PaneId } from '@/lib/pane-visibility-store';
import { ProfilerBoundary } from '@/lib/perf';
import { moveHostPreservingScroll, observeHostScrollRestore } from '@/lib/preserve-subtree-scroll';
import { revealEditor, revealEditorBeforeActing } from '@/lib/reveal-editor';
import {
  matchesShareReceiveMiss,
  pendingReceiveNavStore,
} from '@/lib/share/pending-receive-nav-store';
import { RIGHT_COLLAPSE_THRESHOLD, resolvePartition } from '@/lib/sidebar-partition';
import {
  applyToggleAtEveryWidth,
  openIntentAfterPartitionChange,
  readPins,
  resolveEffectiveState,
} from '@/lib/sidebar-pin-store';
import { documentPanelSide, useFileSidebarSide } from '@/lib/sidebar-side-store';
import { closeTimelineDiff, useTimelineDiffView } from '@/lib/timeline-diff-store';
import { EditorContentOnScreenContext } from '@/lib/use-editor-pane-on-screen';
import { useSettingsRoute } from '@/lib/use-settings-route';
import { cn } from '@/lib/utils';
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
  type RailPanelSpaceRefusal,
  reportUnexpectedPanelGroupFailure,
  resolveRailPanelSpace,
  resolveRailPanelSpacePx,
} from './editor-area-panel-space';
import { DOC_PANEL_ID, findResidualPanelId } from './editor-area-rail-registry';
import { computeStickyRepinLayout } from './editor-area-sticky-repin';
import { isSlidesHost } from './slides-host-gate';
import { useLiveXtermTheme } from './use-live-xterm-theme';

const LazyActivityModeContent = lazy(async () => {
  const mod = await import('@/components/ActivityModeContent');
  return { default: mod.ActivityModeContent };
});

const BLOCKED_RAIL_LAYOUT_RETRY_DEADLINE_MS = 60_000;
const DESTINATION_FOCUS_DEADLINE_MS = 10_000;

function measureSidebarUnitWidth(element: HTMLElement | null, fallbackWidthPx: number | null) {
  const width = element?.getBoundingClientRect().width;
  return width != null && width > 0 ? width : fallbackWidthPx;
}

type SidebarFitContext = {
  widthPx: number | null;
  filesDockWidth: string;
  filesPresent: boolean;
  informationWidthPx: number;
  filesIntentOpen: boolean;
  informationIntentOpen: boolean;
  preferredSidebar: EditorSidebar | null;
};

function resolveFilesDockWidthPx(filesDockWidth: string): number {
  const filesWidth = Number.parseFloat(filesDockWidth);
  return filesDockWidth.endsWith('rem')
    ? filesWidth * Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    : filesWidth;
}

function sidebarFitWidthBucket(context: SidebarFitContext, widthPx: number | null): string {
  const availablePx = widthPx == null ? Infinity : widthPx - DOC_USABLE_MIN_WIDTH_PX;
  const filesPx = context.filesPresent ? resolveFilesDockWidthPx(context.filesDockWidth) : 0;
  const informationPx = context.informationWidthPx + 1;
  return [0, filesPx, informationPx, filesPx + informationPx]
    .map((thresholdPx) => (availablePx >= thresholdPx ? '1' : '0'))
    .join('');
}

function docPanelDockReadyFor(innerWidthPx: number | null, docPanelWidthPx: number): boolean {
  return innerWidthPx == null || innerWidthPx >= docPanelWidthPx + DOC_USABLE_MIN_WIDTH_PX + 1;
}

function resolveCurrentEditorSidebarFit(
  context: SidebarFitContext,
  informationPresent: boolean,
  filesOpen = context.filesIntentOpen,
  informationOpen = context.informationIntentOpen,
  preferred = context.preferredSidebar,
  widthPx = context.widthPx,
) {
  const filesWidthPx = resolveFilesDockWidthPx(context.filesDockWidth);
  return resolveEditorSidebarFit({
    widthPx,
    filesWidthPx: context.filesPresent ? filesWidthPx : null,
    informationWidthPx: informationPresent ? context.informationWidthPx : null,
    documentMinimumPx: DOC_USABLE_MIN_WIDTH_PX,
    filesOpen,
    informationOpen,
    preferred,
  });
}

type FilesRequestCoordinatorInputs = {
  fit: SidebarFitContext;
  editorCardRef: { current: HTMLDivElement | null };
  docSlotPresent: boolean;
  setPreferredSidebar: (preferred: EditorSidebar | null) => void;
  setDocPanelCover: (open: boolean) => void;
  setPendingDocPanelDestination: (destination: null) => void;
  setFilesCanDock: (canDock: boolean) => void;
};

function useFilesRequestCoordinator(inputs: FilesRequestCoordinatorInputs) {
  const current = useRef(inputs);
  useLayoutEffect(() => {
    current.current = inputs;
  });
  const [coordinate] = useState(() => (open: boolean) => {
    const {
      fit,
      editorCardRef,
      docSlotPresent,
      setPreferredSidebar,
      setDocPanelCover,
      setPendingDocPanelDestination,
      setFilesCanDock,
    } = current.current;
    if (!fit.filesPresent) return null;
    const result = resolveCurrentEditorSidebarFit(
      fit,
      docSlotPresent,
      open,
      fit.informationIntentOpen,
      'files',
      measureSidebarUnitWidth(editorCardRef.current, fit.widthPx),
    );
    if (open) {
      setPreferredSidebar(result.mode === 'both' ? null : 'files');
      setDocPanelCover(false);
      setPendingDocPanelDestination(null);
    } else if (fit.preferredSidebar === 'files') {
      setPreferredSidebar(null);
    }
    setFilesCanDock(result.filesDocked);
    return result.filesDocked;
  });
  return coordinate;
}

type RailLayoutRetryContext = {
  readonly decision: 'sync-doc-presence' | 'show-editor' | 'observed-doc-width';
  readonly targetWidthPx: number;
};

type RailLayoutRetryOutcome = 'applied' | 'blocked' | 'failed';

type DocPanelPinMiss =
  | { readonly cause: 'dragging' | 'group-missing' | 'layout-without-doc-panel' }
  | { readonly cause: 'write-threw'; readonly writeError: string }
  | { readonly cause: 'panel-space-unresolved'; readonly refusal: RailPanelSpaceRefusal }
  | {
      readonly cause: 'width-missed';
      readonly pinnedWidthPx: number;
      readonly landedWidthPx: number;
    };

type RailLayoutRetryController = {
  frameId: number;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  context?: RailLayoutRetryContext;
};

type RailLayoutRetryControllerRef = {
  current: RailLayoutRetryController;
};

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
  describeMiss,
}: {
  retryRef: RailLayoutRetryControllerRef;
  attempt: () => RailLayoutRetryOutcome;
  context: RailLayoutRetryContext;
  describeMiss?: () => DocPanelPinMiss | null;
}) {
  cancelRailLayoutRetry(retryRef);
  retryRef.current.context = context;
  const deadlineTimestamp = performance.now() + BLOCKED_RAIL_LAYOUT_RETRY_DEADLINE_MS;
  const completeExhaustedRetry = () => {
    cancelRailLayoutRetry(retryRef);
    reportUnexpectedPanelGroupFailure(
      'rail-layout-retry-exhausted',
      new Error('Rail layout did not apply within the retry budget'),
      { ...context, ...describeMiss?.() },
    );
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
        cancelRailLayoutRetry(retryRef);
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
}: {
  docName: string;
  provider: HocuspocusProvider;
  isSourceMode: boolean;
  onModeChange: (mode: EditorMode) => void;
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
const DOC_USABLE_MIN_WIDTH_PX = 300;
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

type PanesOnScreen = Readonly<Record<PaneId, boolean>>;

export interface EditorAreaHandle {
  panesOnScreen(): PanesOnScreen;
}

function hasExtent(element: HTMLElement | null): boolean {
  if (element == null) return false;
  const { width, height } = element.getBoundingClientRect();
  return width > 0 && height > 0;
}

export interface WorkspaceHeaderChrome {
  readonly leading: ReactNode;
  readonly trailing: ReactNode;
  readonly sidebarSwap: boolean;
}

interface EditorAreaProps {
  ref?: Ref<EditorAreaHandle>;
  onPaneExtentChange?: () => void;
  editorMode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  activeTab: PanelTab;
  onActiveTabChange: (tab: PanelTab) => void;
  terminalBridge?: OkDesktopBridge | null;
  editorVisible?: boolean;
  terminalVisible?: boolean;
  agentsVisible?: boolean;
  dockTree: DockNode;
  onDockTreeChange: (update: (tree: DockNode) => DockNode) => void;
  onSessionPlacements?: (placements: SessionPlacements) => void;
  renderWorkspaceHeader?: (tabs: ReactNode, chrome: WorkspaceHeaderChrome) => ReactNode;
}

function renderTabsWithoutHeader(tabs: ReactNode, chrome: WorkspaceHeaderChrome): ReactNode {
  return (
    <>
      {chrome.leading}
      {tabs}
      {chrome.trailing}
    </>
  );
}

export function EditorArea(props: EditorAreaProps) {
  return (
    <ProfilerBoundary name="editor-area">
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

function useDocPanelHost() {
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'flex h-full min-h-0 w-full flex-col';
    return element;
  });
  const dockTarget = useRef<HTMLDivElement | null>(null);
  const coverTarget = useRef<HTMLDivElement | null>(null);
  useEffect(() => observeHostScrollRestore(host, host), [host]);
  const [dockRef] = useState(() => (target: HTMLDivElement) => {
    dockTarget.current = target;
    if (coverTarget.current == null && host.parentNode !== target) {
      moveHostPreservingScroll(host, target);
    }
    return () => {
      if (dockTarget.current === target) dockTarget.current = null;
      if (host.parentNode === target) target.removeChild(host);
    };
  });
  const [coverRef] = useState(() => (target: HTMLDivElement) => {
    coverTarget.current = target;
    if (host.parentNode !== target) moveHostPreservingScroll(host, target);
    return () => {
      if (coverTarget.current === target) coverTarget.current = null;
      if (host.parentNode !== target) return;
      const dock = dockTarget.current;
      if (dock?.isConnected) moveHostPreservingScroll(host, dock);
      else target.removeChild(host);
    };
  });
  return { host, dockRef, coverRef };
}

function useFileListSlot() {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const [slotRef] = useState(() => (target: HTMLDivElement | null) => {
    setNode(target);
    nodeRef.current = target;
  });
  return { node, nodeRef, slotRef };
}

function escapeBelongsToCover(
  event: KeyboardEvent,
  coverSelector: string,
  opener: HTMLElement | null,
): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return true;
  const doc = target.ownerDocument;
  if (target === doc.body || target === doc.documentElement) return true;
  return target.closest(coverSelector) !== null || target === opener;
}

function useDocPanelDestinationCompletion(
  coverOpen: boolean,
  setPendingDestination: (destination: null) => void,
  setCoverOpen: (open: boolean) => void,
  setDestinationFocusDocName: (docName: string) => void,
) {
  const coverOpenRef = useRef(coverOpen);
  useLayoutEffect(() => {
    coverOpenRef.current = coverOpen;
  }, [coverOpen]);
  const [complete] = useState(() => (target?: HTMLElement) => {
    if (!coverOpenRef.current) return;
    setPendingDestination(null);
    setCoverOpen(false);
    const editorDocName = target?.matches('.ProseMirror, .cm-content')
      ? target.closest<HTMLElement>('[data-editor-activity-mount]')?.dataset.docName
      : undefined;
    if (editorDocName !== undefined) {
      setDestinationFocusDocName(editorDocName);
      return;
    }
    requestAnimationFrame(() => {
      if (target?.isConnected && target.getClientRects().length > 0) {
        target.focus({ preventScroll: true });
      }
    });
  });
  return { complete, coverOpenRef };
}

function EditorAreaInner({
  ref,
  onPaneExtentChange,
  editorMode,
  onModeChange,
  activeTab,
  onActiveTabChange,
  terminalBridge,
  editorVisible = true,
  terminalVisible = false,
  agentsVisible = false,
  dockTree,
  onDockTreeChange,
  onSessionPlacements,
  renderWorkspaceHeader = renderTabsWithoutHeader,
}: EditorAreaProps) {
  const { t } = useLingui();
  const noteWindow = isNoteWindow();
  const cardLook = !noteWindow;
  const cardVariant = cardLook ? 'card' : 'flat';
  const terminalAvailable = terminalBridge != null;
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
  const activeDocConflict = useDocConflict(activeDocName);
  const pendingReceiveNav = useSyncExternalStore(
    pendingReceiveNavStore.subscribe,
    pendingReceiveNavStore.getSnapshot,
    pendingReceiveNavStore.getSnapshot,
  );
  const shareReceiveMiss = matchesShareReceiveMiss(activeTarget, pendingReceiveNav);

  const [embeddedHost] = useState(() => detectEmbeddedHostFromBrowser());
  const isEmbedded = embeddedHost !== null;
  const [initialRightPartition] = useState(() =>
    resolvePartition(embeddedHost, window.innerWidth, 'right'),
  );
  const panelRef = usePanelRef();
  const [initialRightCollapsed] = useState(() => {
    const pins = readPins();
    return resolveEffectiveState('right', initialRightPartition, pins) === 'collapsed';
  });
  const [isCollapsed, setIsCollapsed] = useState(initialRightCollapsed);
  const isCollapsedRef = useRef(isCollapsed);
  const [docPanelIntentOpen, setDocPanelIntentOpen] = useState(!initialRightCollapsed);
  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${RIGHT_COLLAPSE_THRESHOLD}px)`);
    const onChange = () => {
      const partition = resolvePartition(embeddedHost, window.innerWidth, 'right');
      const intent = openIntentAfterPartitionChange('right', partition, readPins());
      if (intent !== undefined) setDocPanelIntentOpen(intent);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [embeddedHost]);
  const [docPanelCover, setDocPanelCover] = useState(false);
  const [pendingDocPanelDestination, setPendingDocPanelDestination] = useState<{
    docName: string;
    allowMissing: boolean;
    onReady?: () => void;
    completion: 'synced' | 'navigated';
  } | null>(null);
  const [destinationFocusDocName, setDestinationFocusDocName] = useState<string | null>(null);
  const pendingDocPanelDestinationRef = useRef(pendingDocPanelDestination);
  useLayoutEffect(() => {
    pendingDocPanelDestinationRef.current = pendingDocPanelDestination;
  }, [pendingDocPanelDestination]);
  const { complete: completeDocPanelDestination, coverOpenRef: docPanelCoverOpenRef } =
    useDocPanelDestinationCompletion(
      docPanelCover,
      setPendingDocPanelDestination,
      setDocPanelCover,
      setDestinationFocusDocName,
    );
  function reportCoveredDiffFailure() {
    if (docPanelCoverOpenRef.current) toast.error(t`Diff unavailable`);
  }
  const [editorCardWidthPx, setEditorCardWidthPx] = useState<number | null>(null);
  const [innerWidthPx, setInnerWidthPx] = useState<number | null>(null);
  const liveEditorCardWidthPxRef = useRef<number | null>(null);
  const liveInnerWidthPxRef = useRef<number | null>(null);
  const [preferredSidebar, setPreferredSidebar] = useState<EditorSidebar | null>(null);
  const docPanelBackRef = useRef<HTMLButtonElement | null>(null);
  const docPanelDockFocusRef = useRef<HTMLElement | null>(null);
  const docPanelCoverOpenerRef = useRef<HTMLElement | null>(null);
  const {
    host: docPanelHost,
    dockRef: docPanelDockRef,
    coverRef: docPanelCoverRef,
  } = useDocPanelHost();
  useEffect(() => {
    const trackFocus = (event: FocusEvent) => {
      if (event.target === document.body) return;
      docPanelDockFocusRef.current =
        event.target instanceof HTMLElement && docPanelHost.contains(event.target)
          ? event.target
          : null;
    };
    document.addEventListener('focusin', trackFocus, true);
    return () => document.removeEventListener('focusin', trackFocus, true);
  }, [docPanelHost]);
  const {
    cover: filesCover,
    dismissCover: dismissFilesCover,
    setCanDock: setFilesCanDock,
    registerOpenRequestHandler: registerFilesOpenRequestHandler,
    registerCoverSelectionHandler: registerFilesCoverSelectionHandler,
    open: filesIntentOpen,
    width: filesDockWidth,
  } = useSidebar();
  const fileListHost = useFileListHost();
  const fileSidebarSide = useFileSidebarSide();
  const docPanelSide = fileListHost != null ? documentPanelSide(fileSidebarSide) : 'end';
  const [filesCoverTarget, setFilesCoverTarget] = useState<HTMLDivElement | null>(null);

  const [agentsContainer, setAgentsContainer] = useState<HTMLElement | null>(null);
  const [terminalContainer, setTerminalContainer] = useState<HTMLDivElement | null>(null);
  const [workspaceHeaderContainer, setWorkspaceHeaderContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [workspaceColumnEl, setWorkspaceColumnEl] = useState<HTMLElement | null>(null);
  const [terminalEditorRegion, setTerminalEditorRegion] = useState<HTMLDivElement | null>(null);
  const { resolvedTheme } = useTheme();
  const xtermBackground = useLiveXtermTheme(resolvedTheme).background;

  const agentsUnitShown = !noteWindow && agentsVisible;
  const terminalUnitShown = !noteWindow && terminalAvailable && terminalVisible;
  const terminalPlacement = dockTerminalPlacement(dockTree);
  const [dockLayout, setDockLayout] = useState<DockLayout>(EMPTY_DOCK_LAYOUT);
  const editorVisibleRef = useRef(editorVisible);
  const editorCardRef = useRef<HTMLDivElement | null>(null);
  const [paneVisibilityWhileEditorShown, setPaneVisibilityWhileEditorShown] = useState({
    terminalVisible,
    agentsVisible,
  });
  if (
    editorVisible &&
    (paneVisibilityWhileEditorShown.terminalVisible !== terminalVisible ||
      paneVisibilityWhileEditorShown.agentsVisible !== agentsVisible)
  ) {
    setPaneVisibilityWhileEditorShown({ terminalVisible, agentsVisible });
  }
  const editorVisibleBeforeRef = useRef(editorVisible);
  useLayoutEffect(() => {
    const wasVisible = editorVisibleBeforeRef.current;
    editorVisibleBeforeRef.current = editorVisible;
    editorVisibleRef.current = editorVisible;
    if (editorVisible) {
      if (!wasVisible && focusWaitsForEditor()) terminalEditorRegion?.focus();
      return;
    }
    const card = editorCardRef.current;
    if (card?.contains(document.activeElement)) focusAwayFromHiddenEditor();
  }, [editorVisible, terminalEditorRegion]);
  const terminalShowing =
    terminalUnitShown && terminalContainer != null && dockLayout.panes.has('terminal');
  const agentsShowing =
    agentsUnitShown && agentsContainer != null && dockLayout.panes.has('agents');
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

  const onPaneExtentChangeRef = useRef(onPaneExtentChange);
  useLayoutEffect(() => {
    onPaneExtentChangeRef.current = onPaneExtentChange;
  });
  const paneExtentObserverRef = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => onPaneExtentChangeRef.current?.());
    paneExtentObserverRef.current = observer;
    return () => {
      observer.disconnect();
      paneExtentObserverRef.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const observer = paneExtentObserverRef.current;
    if (observer == null) return;
    const mounts = [agentsContainer, terminalContainer].filter((mount) => mount != null);
    for (const mount of mounts) observer.observe(mount);
    return () => {
      for (const mount of mounts) observer.unobserve(mount);
    };
  }, [agentsContainer, terminalContainer]);

  useEffect(() => {
    isCollapsedRef.current = isCollapsed;
  }, [isCollapsed]);
  const [isDraggingDocHandle, setIsDraggingDocHandle] = useState(false);
  const isDraggingDocHandleRef = useRef(false);

  const [initialDocPanelWidthPx] = useState(() => getInitialDocPanelWidth());
  const docPanelWidthPxRef = useRef(initialDocPanelWidthPx);
  const [preferredDocPanelWidthPx, setPreferredDocPanelWidthPx] = useState(initialDocPanelWidthPx);
  const [docPanelSeed, setDocPanelSeed] = useState(() => ({
    side: docPanelSide,
    collapsed: initialRightCollapsed,
    widthPx: initialDocPanelWidthPx,
  }));
  if (docPanelSeed.side !== docPanelSide) {
    setDocPanelSeed({
      side: docPanelSide,
      collapsed: isCollapsed,
      widthPx: preferredDocPanelWidthPx,
    });
  }
  const [docPanelEl, setDocPanelEl] = useState<HTMLElement | null>(null);
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function debouncedWriteDocPanelWidth(px: number) {
    if (writeTimerRef.current != null) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      writeDocPanelWidth(px);
      writeTimerRef.current = null;
    }, 100);
  }

  useEffect(
    () => () => {
      if (writeTimerRef.current != null) clearTimeout(writeTimerRef.current);
    },
    [],
  );

  const [innerContainerEl, setInnerContainerEl] = useState<HTMLDivElement | null>(null);
  const innerContainerElRef = useRef<HTMLDivElement | null>(null);
  const { node: fileListSlotEl, slotRef: fileListSlotRef } = useFileListSlot();
  useLayoutEffect(() => {
    if (docPanelCover || isCollapsed) return;
    const focusedPanelControl = docPanelDockFocusRef.current;
    if (focusedPanelControl == null) return;
    const frame = requestAnimationFrame(() => {
      if (
        docPanelDockFocusRef.current === focusedPanelControl &&
        focusedPanelControl.isConnected &&
        docPanelHost.contains(focusedPanelControl) &&
        docPanelHost.closest('#doc-panel') != null &&
        focusedPanelControl.closest('[inert]') == null &&
        focusedPanelControl.getClientRects().length > 0
      ) {
        focusedPanelControl.focus({ preventScroll: true });
        if (document.activeElement === focusedPanelControl) docPanelDockFocusRef.current = null;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [docPanelCover, isCollapsed, docPanelHost]);
  useAttachFileListHost(fileListHost, filesCover ? filesCoverTarget : fileListSlotEl);

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
  const docSlotHeldForLoadRef = useRef(false);
  const presenceRepinRetryRef = useRef<RailLayoutRetryController>({
    frameId: 0,
    deadlineTimer: null,
  });
  const observedDocWidthRetryRef = useRef<RailLayoutRetryController>({
    frameId: 0,
    deadlineTimer: null,
  });

  const innerGroupRef = useGroupRef();
  function resolveInnerGroupPxWidth(): number | null {
    return resolveRailPanelSpacePx(innerContainerElRef.current);
  }

  function attemptDocPanelPin(
    docCollapsed: boolean,
    recordMiss: (miss: DocPanelPinMiss) => void = () => {},
  ): RailLayoutRetryOutcome {
    const missDocPanelPin = (miss: DocPanelPinMiss, outcome: 'blocked' | 'failed') => {
      recordMiss(miss);
      return outcome;
    };
    isCollapsedRef.current = docCollapsed;
    if (!editorVisibleRef.current) return 'applied';
    if (isDraggingDocHandleRef.current) return missDocPanelPin({ cause: 'dragging' }, 'blocked');
    const group = innerGroupRef.current;
    if (group == null) return missDocPanelPin({ cause: 'group-missing' }, 'blocked');
    const space = resolveRailPanelSpace(innerContainerElRef.current);
    if (!space.ok) {
      return missDocPanelPin(
        { cause: 'panel-space-unresolved', refusal: space.refusal },
        'blocked',
      );
    }
    const innerPx = space.panelSpacePx;
    try {
      const layout = group.getLayout();
      const residualId = findResidualPanelId(Object.keys(layout));
      if (residualId == null || !(DOC_PANEL_ID in layout)) {
        return missDocPanelPin({ cause: 'layout-without-doc-panel' }, 'blocked');
      }
      const pinnedPx = docCollapsed || !docSlotPresentRef.current ? 0 : docPanelWidthPxRef.current;
      const next = computeStickyRepinLayout({
        currentLayout: layout,
        containerPx: innerPx,
        pinnedPx: { [DOC_PANEL_ID]: pinnedPx },
        residualId,
      });
      if (next === layout) return 'applied';
      group.setLayout(next);
      const landedPx = ((group.getLayout()[DOC_PANEL_ID] ?? 0) / 100) * innerPx;
      if (Math.abs(landedPx - pinnedPx) <= 1) return 'applied';
      return missDocPanelPin(
        { cause: 'width-missed', pinnedWidthPx: pinnedPx, landedWidthPx: landedPx },
        'failed',
      );
    } catch (error) {
      reportUnexpectedPanelGroupFailure('pin-doc-panel-failed', error);
      return missDocPanelPin(
        {
          cause: 'write-threw',
          writeError: error instanceof Error ? error.message : String(error),
        },
        'failed',
      );
    }
  }

  function pinDocPanel(docCollapsed: boolean): boolean {
    return attemptDocPanelPin(docCollapsed) !== 'failed';
  }

  const pinDocPanelRef = useRef(pinDocPanel);
  useEffect(() => {
    pinDocPanelRef.current = pinDocPanel;
  });

  function reclaimHiddenDocPanel(present: boolean, widthPx: number) {
    if (present || widthPx <= 0) return;
    queueMicrotask(() => {
      const group = innerGroupRef.current;
      if (group == null) return;
      let layout: Record<string, number>;
      let containerPx: number | null;
      try {
        layout = group.getLayout();
        containerPx = resolveInnerGroupPxWidth();
      } catch (error) {
        reportUnexpectedPanelGroupFailure('reclaim-hidden-rail-read-failed', error);
        return;
      }
      if (containerPx == null || !(DOC_PANEL_ID in layout) || layout[DOC_PANEL_ID] === 0) return;
      const residualId = findResidualPanelId(Object.keys(layout));
      if (residualId == null) return;
      const next = computeStickyRepinLayout({
        currentLayout: layout,
        containerPx,
        pinnedPx: { [DOC_PANEL_ID]: 0 },
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

  const endHandleDragRef = useRef<(() => void) | null>(null);
  function trackHandleDrag(
    pointerId: number | null,
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
      if (pointerId != null && event.pointerId !== pointerId) return;
      end();
      onCommit?.();
      pinDocPanelRef.current(isCollapsedRef.current);
    }
    function onPointerCancel(event: PointerEvent) {
      if (pointerId != null && event.pointerId !== pointerId) return;
      end();
      pinDocPanelRef.current(isCollapsedRef.current);
    }
    endHandleDragRef.current = end;
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }
  function beginDocHandleDrag(pointerId: number | null) {
    trackHandleDrag(
      pointerId,
      setIsDraggingDocHandle,
      isDraggingDocHandleRef,
      () => {
        if (panelRef.current?.isCollapsed()) writeDocPanelIntent(false);
      },
      () => setPreferredDocPanelWidthPx(docPanelWidthPxRef.current),
    );
  }
  function adoptLibraryDrag() {
    const active = innerContainerElRef.current?.querySelector(
      ':scope > [data-group] > [data-separator="active"]',
    );
    if (!(active instanceof HTMLElement)) return;
    if (active.hasAttribute('data-doc-panel-handle') && !isDraggingDocHandleRef.current) {
      beginDocHandleDrag(null);
    }
  }
  useEffect(() => () => endHandleDragRef.current?.(), []);

  useImperativeHandle(ref, () => ({
    panesOnScreen: () => ({
      editor: editorVisible && dockLayout.panes.has('editor'),
      agents: hasExtent(agentsContainer),
      terminal: hasExtent(terminalContainer),
    }),
  }));

  function docPanelToggleable(): boolean {
    return docSlotPresentRef.current && !docSlotHeldForLoadRef.current;
  }

  function writeDocPanelIntent(open: boolean) {
    if (!open && preferredSidebar === 'information') setPreferredSidebar(null);
    const next = open ? 'open' : 'collapsed';
    applyToggleAtEveryWidth('right', next);
    setDocPanelIntentOpen(open);
  }

  function returnFocusFromDocPanelCover() {
    const opener = docPanelCoverOpenerRef.current;
    requestAnimationFrame(() => {
      const candidates = [
        opener,
        document.querySelector<HTMLElement>('[data-doc-panel-toggle]'),
        document.querySelector<HTMLElement>('[data-header-pane-button="editor"]'),
        terminalEditorRegion,
      ];
      for (const candidate of candidates) {
        if (
          candidate?.isConnected &&
          candidate !== document.body &&
          (candidate.tabIndex >= 0 || candidate === terminalEditorRegion) &&
          !candidate.matches(':disabled') &&
          candidate.closest('[inert]') == null &&
          candidate.getClientRects().length > 0 &&
          getComputedStyle(candidate).visibility === 'visible'
        ) {
          candidate.focus();
          if (document.activeElement === candidate) return;
        }
      }
    });
  }

  function dismissDocPanelCover() {
    setPendingDocPanelDestination(null);
    setDocPanelCover(false);
    returnFocusFromDocPanelCover();
  }

  function requestDocPanelDestination(
    docName: string,
    allowMissing = false,
    onReady?: () => void,
    completion: 'synced' | 'navigated' = 'synced',
  ) {
    if (docPanelCover)
      setPendingDocPanelDestination({ docName, allowMissing, onReady, completion });
    else onReady?.();
  }

  const sidebarFitContext: SidebarFitContext = {
    widthPx: editorCardWidthPx,
    filesDockWidth,
    filesPresent: fileListHost != null,
    informationWidthPx: preferredDocPanelWidthPx,
    filesIntentOpen,
    informationIntentOpen: docPanelIntentOpen,
    preferredSidebar,
  };
  function adoptDraggedDocPanelWidth(widthPx: number) {
    const liveCardPx = liveEditorCardWidthPxRef.current ?? editorCardWidthPx;
    const liveInnerPx = liveInnerWidthPxRef.current ?? innerWidthPx;
    const crossesThreshold =
      sidebarFitWidthBucket({ ...sidebarFitContext, informationWidthPx: widthPx }, liveCardPx) !==
        sidebarFitWidthBucket(sidebarFitContext, liveCardPx) ||
      docPanelDockReadyFor(liveInnerPx, widthPx) !==
        docPanelDockReadyFor(liveInnerPx, preferredDocPanelWidthPx);
    if (crossesThreshold) setPreferredDocPanelWidthPx(widthPx);
  }
  const syncMeasuredWidths = useEffectEvent(() => {
    const liveCardPx = liveEditorCardWidthPxRef.current;
    if (
      liveCardPx !== editorCardWidthPx &&
      sidebarFitWidthBucket(sidebarFitContext, liveCardPx) !==
        sidebarFitWidthBucket(sidebarFitContext, editorCardWidthPx)
    ) {
      setEditorCardWidthPx(liveCardPx);
    }
    const liveInnerPx = liveInnerWidthPxRef.current;
    if (
      liveInnerPx !== innerWidthPx &&
      docPanelDockReadyFor(liveInnerPx, preferredDocPanelWidthPx) !==
        docPanelDockReadyFor(innerWidthPx, preferredDocPanelWidthPx)
    ) {
      setInnerWidthPx(liveInnerPx);
    }
  });
  useLayoutEffect(() => {
    syncMeasuredWidths();
  });
  useLayoutEffect(() => {
    const card = editorCardRef.current;
    if (card == null || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const cardWidth = card.getBoundingClientRect().width;
      if (cardWidth <= 0) return;
      liveEditorCardWidthPxRef.current = cardWidth;
      syncMeasuredWidths();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (innerContainerEl == null || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const width = innerContainerEl.getBoundingClientRect().width;
      if (width <= 0) return;
      liveInnerWidthPxRef.current = width;
      syncMeasuredWidths();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(innerContainerEl);
    return () => observer.disconnect();
  }, [innerContainerEl]);

  function expandDocPanel(explicit = false) {
    if (!docPanelToggleable()) return;
    if (filesCover) dismissFilesCover(false);
    const fit = resolveCurrentEditorSidebarFit(
      sidebarFitContext,
      docSlotPresentRef.current,
      filesIntentOpen,
      true,
      'information',
      measureSidebarUnitWidth(editorCardRef.current, editorCardWidthPx),
    );
    setPreferredSidebar(fit.mode === 'both' ? null : 'information');
    setFilesCanDock(fit.filesDocked);
    if (explicit) writeDocPanelIntent(true);
    else setDocPanelIntentOpen(true);
    if (fit.mode !== 'cover') {
      setDocPanelCover(false);
      return;
    }
    docPanelCoverOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pinDocPanel(true);
    setDocPanelCover(true);
  }

  function togglePanel() {
    if (!docPanelToggleable()) return;
    revealEditorBeforeActing();
    if (docPanelCover || (!isCollapsedRef.current && docPanelIntentOpen)) {
      writeDocPanelIntent(false);
      pinDocPanel(true);
      if (docPanelCover) dismissDocPanelCover();
      return;
    }
    expandDocPanel(true);
  }

  const attemptObservedDocWidth = useEffectEvent((): RailLayoutRetryOutcome => {
    if (!editorVisibleRef.current) return 'applied';
    if (isDraggingDocHandleRef.current) return 'blocked';
    const innerPx = resolveInnerGroupPxWidth();
    if (innerPx == null) return 'blocked';
    const collapsed =
      !docSlotPresentRef.current ||
      !docPanelIntentOpen ||
      !resolveCurrentEditorSidebarFit(sidebarFitContext, docSlotPresentRef.current)
        .informationDocked ||
      innerPx < docPanelWidthPxRef.current + DOC_USABLE_MIN_WIDTH_PX;
    const expectedDocWidth = collapsed ? 0 : docPanelWidthPxRef.current;
    const actualDocWidth = innerContainerElRef.current
      ?.querySelector<HTMLElement>(`#${DOC_PANEL_ID}`)
      ?.getBoundingClientRect().width;
    if (actualDocWidth != null && Math.abs(actualDocWidth - expectedDocWidth) <= 1)
      return 'applied';
    const group = innerGroupRef.current;
    if (group == null) return 'blocked';
    try {
      const layout = group.getLayout();
      const residualId = findResidualPanelId(Object.keys(layout));
      if (residualId == null || !(DOC_PANEL_ID in layout)) return 'blocked';
      isCollapsedRef.current = collapsed;
      group.setLayout(
        computeStickyRepinLayout({
          currentLayout: layout,
          containerPx: innerPx,
          pinnedPx: { [DOC_PANEL_ID]: expectedDocWidth },
          residualId,
        }),
      );
      return 'failed';
    } catch (error) {
      reportUnexpectedPanelGroupFailure('settle-observed-information-width-failed', error);
      return 'failed';
    }
  });
  const settleObservedDocWidth = useEffectEvent(() => {
    if (observedDocWidthRetryRef.current.context != null) return;
    runRailLayoutRetry({
      retryRef: observedDocWidthRetryRef,
      attempt: attemptObservedDocWidth,
      context: {
        decision: 'observed-doc-width',
        targetWidthPx: docPanelWidthPxRef.current,
      },
    });
  });

  const editorUnitWidthPx = dockLayout.panes.get('editor')?.width ?? null;
  const followEditorUnit = useEffectEvent(() => {
    attemptDocPanelPin(isCollapsedRef.current);
  });
  useLayoutEffect(() => {
    if (editorUnitWidthPx !== null) followEditorUnit();
  }, [editorUnitWidthPx]);

  useEffect(() => {
    if (innerContainerEl == null) return;
    if (isEmbedded) return;
    let docSettlementFrame = 0;
    const observer = new ResizeObserver(() => {
      if (docSettlementFrame !== 0) return;
      docSettlementFrame = requestAnimationFrame(() => {
        docSettlementFrame = 0;
        settleObservedDocWidth();
      });
    });
    observer.observe(innerContainerEl);
    if (docPanelEl != null) observer.observe(docPanelEl);
    return () => {
      observer.disconnect();
      if (docSettlementFrame !== 0) cancelAnimationFrame(docSettlementFrame);
      cancelRailLayoutRetry(observedDocWidthRetryRef);
    };
  }, [innerContainerEl, isEmbedded, docPanelEl]);

  const openRequestedDocPanelTab = useEffectEvent((tab: PanelTab) => {
    revealEditor();
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

  const expandDocPanelEvent = useEffectEvent(() => expandDocPanel());
  useEffect(() => {
    if (docPanelExpandSignal === 0) return;
    revealEditor();
    expandDocPanelEvent();
  }, [docPanelExpandSignal]);

  useLayoutEffect(() => {
    if (!isCollapsed || docPanelCover) return;
    const panelEl = document.getElementById(DOC_PANEL_ID);
    if (!panelEl?.contains(document.activeElement)) return;
    const toggle = document.querySelector<HTMLElement>('[data-doc-panel-toggle]');
    if (toggle) {
      toggle.focus();
      return;
    }
    document.querySelector<HTMLElement>('[data-sidebar="trigger"]')?.focus();
  }, [isCollapsed, docPanelCover]);

  useEffect(() => {
    setViewMenuState({ docPanelVisible: !isCollapsed || docPanelCover });
    if (window.okDesktop == null) return;
    window.okDesktop.editor.notifyViewMenuStateChanged({
      docPanelVisible: !isCollapsed || docPanelCover,
    });
  }, [isCollapsed, docPanelCover]);

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
  let docSlotHeldForLoad = false;
  let skeletonReplacesWorkspace = false;

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
        <div className="relative flex min-h-0 flex-1 flex-col">
          <FolderOverview folderPath={activeTarget.folderPath} />
          {showFolderComposer ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-2 bg-linear-to-t from-background to-transparent"
            />
          ) : null}
        </div>
        {showFolderComposer ? (
          <BottomComposer folderPath={activeTarget.folderPath} editorVisible={editorVisible} />
        ) : null}
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
          <LazyActivityModeContent
            showBackButton={false}
            onDestinationRequested={requestDocPanelDestination}
          />
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
      />
    );
  } else if (shareReceiveMiss) {
    viewContent = <ShareReceiveMissPanel key={shareReceiveMiss.path} nav={shareReceiveMiss} />;
  } else if (!activeProvider || !activeDocName) {
    const hashDoc = typeof window !== 'undefined' ? docNameFromHash(window.location.hash) : null;
    if (hashDoc !== null) {
      viewContent = <EditorSkeleton />;
      docSlotContent = <div className="min-h-0 flex-1" />;
      docSlotHeldForLoad = true;
      skeletonReplacesWorkspace = terminalBridge == null || !everHadProvider;
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
        ...(editorVisible ? { terminalVisible, agentsVisible } : paneVisibilityWhileEditorShown),
        isEmbedded,
        activeDocName,
      }) &&
      !(timelineDiff && timelineDiff.docName === activeDocName) &&
      !(agentDiff && agentDiffDoc === activeDocName);
    const externalSkillEdit = activeDocName ? parseExternalSkillDocName(activeDocName) : null;
    const renderEditorContent = (activityMount: ReactNode) => (
      <div className="relative flex h-full flex-col">
        {externalSkillEdit ? (
          <Suspense fallback={null}>
            <SkillEditBanner name={externalSkillEdit.name} />
          </Suspense>
        ) : null}
        <DocChangeNotice docName={activeDocName} timelineAvailable={!noteWindow} />
        <div className="relative min-h-0 flex-1">
          <div className="relative h-full">
            {activityMount}
            <FindReplaceController activeDocName={activeDocName} isSourceMode={isSourceMode} />
            {shouldPaintOverlay({
              activeDocName,
              deferredActiveDocName,
              mountResolved: activeDocName !== null && mountPromiseHasResolved(activeDocName),
              syncResolved: activeDocName !== null && syncPromiseHasResolved(activeDocName),
            }) ? (
              <div className="absolute inset-0 z-10 bg-background">
                <EditorSkeleton />
                {activeDocName !== null ? <MountStalledAffordance docName={activeDocName} /> : null}
              </div>
            ) : null}
            {timelineDiff && timelineDiff.docName === activeDocName ? (
              <Suspense fallback={null}>
                <LazyTimelineDiffPane
                  view={timelineDiff}
                  isPanelCollapsed={isCollapsed && !docPanelCover}
                  onTogglePanel={togglePanel}
                  onDestinationComplete={completeDocPanelDestination}
                  onDestinationFailed={reportCoveredDiffFailure}
                />
              </Suspense>
            ) : null}
            {agentDiff && agentDiffDoc === activeDocName ? (
              <Suspense fallback={null}>
                <LazyAgentDiffPane
                  view={agentDiff}
                  isPanelCollapsed={isCollapsed && !docPanelCover}
                  onTogglePanel={togglePanel}
                  onDestinationComplete={completeDocPanelDestination}
                  onDestinationFailed={reportCoveredDiffFailure}
                />
              </Suspense>
            ) : null}
          </div>
          {showBottomComposer ? (
            <BottomComposer
              docName={activeDocName}
              surface={editingSurface}
              editorVisible={editorVisible}
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
        isCollapsed={isCollapsed && !docPanelCover}
        onDestinationComplete={completeDocPanelDestination}
        onDestinationRequested={requestDocPanelDestination}
      />
    );
  }

  if (noteWindow) docSlotContent = null;

  const docSlotPresent = docSlotContent != null;
  const sidebarFit = resolveCurrentEditorSidebarFit(sidebarFitContext, docSlotPresent);
  const docPanelCanDock = sidebarFit.informationDocked;
  const docPanelDockReady = docPanelDockReadyFor(innerWidthPx, preferredDocPanelWidthPx);
  const coordinateFilesRequest = useFilesRequestCoordinator({
    fit: sidebarFitContext,
    editorCardRef,
    docSlotPresent,
    setPreferredSidebar,
    setDocPanelCover,
    setPendingDocPanelDestination,
    setFilesCanDock,
  });
  useLayoutEffect(() => registerFilesOpenRequestHandler(coordinateFilesRequest));
  useLayoutEffect(() => registerFilesCoverSelectionHandler(setDestinationFocusDocName));
  useLayoutEffect(() => {
    setFilesCanDock(sidebarFit.filesDocked);
  }, [sidebarFit.filesDocked, setFilesCanDock]);
  const docPanelOnScreen = docPanelCover || !isCollapsed;
  useLayoutEffect(() => {
    if (sidebarFit.mode === 'both' && preferredSidebar != null) setPreferredSidebar(null);
  }, [sidebarFit.mode, preferredSidebar]);
  const showDocPanelToggle =
    !noteWindow && renderFocusedDocument != null && activeDocConflict === null;
  const docPanelToggle = showDocPanelToggle ? (
    <DocPanelToggle
      isPanelCollapsed={!docPanelOnScreen}
      onTogglePanel={togglePanel}
      panelId={docPanelCover ? 'doc-panel-cover' : DOC_PANEL_ID}
      side={docPanelSide}
    />
  ) : null;
  const workspaceHeaderChrome: WorkspaceHeaderChrome = {
    leading: docPanelSide === 'start' ? docPanelToggle : null,
    trailing: docPanelSide === 'end' ? docPanelToggle : null,
    sidebarSwap: fileListHost != null,
  };

  const returnFocusFromDocPanelCoverEvent = useEffectEvent(returnFocusFromDocPanelCover);
  useLayoutEffect(() => {
    if (filesCover && docPanelCover) setDocPanelCover(false);
  }, [filesCover, docPanelCover]);
  const dismissFilesCoverEvent = useEffectEvent(dismissFilesCover);
  useLayoutEffect(() => {
    if (!filesCover) return;
    if (fileListHost == null) {
      dismissFilesCoverEvent(false);
      return;
    }
    filesCoverTarget?.querySelector<HTMLElement>('[data-files-back]')?.focus();
  }, [filesCover, fileListHost, filesCoverTarget]);
  useEffect(() => {
    if (!filesCover) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        event.defaultPrevented ||
        isOverlayLayerOpen() ||
        !escapeBelongsToCover(event, '[data-files-cover]', null)
      )
        return;
      event.preventDefault();
      dismissFilesCoverEvent();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filesCover]);
  useLayoutEffect(() => {
    if (!docSlotPresent) {
      if (docPanelCover) {
        setDocPanelCover(false);
        setPendingDocPanelDestination(null);
        returnFocusFromDocPanelCoverEvent();
      }
      return;
    }
    const collapsed = !docPanelIntentOpen || !docPanelCanDock || !docPanelDockReady;
    if (isCollapsedRef.current !== collapsed) pinDocPanelRef.current(collapsed);
    if (docPanelCover && docPanelCanDock && docPanelDockReady) {
      const pendingDestination = pendingDocPanelDestinationRef.current;
      if (pendingDestination !== null) {
        pendingDestination.onReady?.();
        if (pendingDestination.completion === 'synced') {
          setDestinationFocusDocName(pendingDestination.docName);
        }
      } else {
        if (document.activeElement === docPanelBackRef.current) returnFocusFromDocPanelCoverEvent();
        if (
          document.activeElement instanceof HTMLElement &&
          docPanelHost.contains(document.activeElement)
        ) {
          docPanelDockFocusRef.current = document.activeElement;
        }
      }
      setDocPanelCover(false);
    }
  }, [
    docSlotPresent,
    docPanelIntentOpen,
    docPanelCanDock,
    docPanelDockReady,
    docPanelCover,
    docPanelHost,
  ]);

  useLayoutEffect(() => {
    if (docPanelCover) docPanelBackRef.current?.focus();
  }, [docPanelCover]);

  const dismissDocPanelCoverEvent = useEffectEvent(dismissDocPanelCover);
  useEffect(() => {
    if (!docPanelCover) setPendingDocPanelDestination(null);
  }, [docPanelCover]);
  useEffect(() => {
    if (!docPanelCover || pendingDocPanelDestination?.docName !== activeDocName) return;
    const completeWhenSynced = () => {
      if (
        !activeProvider?.isSynced &&
        !(pendingDocPanelDestination.allowMissing && activeTarget?.kind === 'missing')
      )
        return;
      pendingDocPanelDestination.onReady?.();
      setPendingDocPanelDestination(null);
      if (pendingDocPanelDestination.completion === 'navigated') return;
      setDocPanelCover(false);
      setDestinationFocusDocName(activeDocName);
    };
    completeWhenSynced();
    activeProvider?.on('synced', completeWhenSynced);
    return () => {
      activeProvider?.off('synced', completeWhenSynced);
    };
  }, [docPanelCover, pendingDocPanelDestination, activeDocName, activeProvider, activeTarget]);
  useEffect(() => {
    if (filesCover || docPanelCover) setDestinationFocusDocName(null);
  }, [filesCover, docPanelCover]);
  useEffect(() => {
    if (destinationFocusDocName === null) return;
    const abandon = () => setDestinationFocusDocName(null);
    const deadline = window.setTimeout(abandon, DESTINATION_FOCUS_DEADLINE_MS);
    window.addEventListener('pointerdown', abandon, true);
    window.addEventListener('keydown', abandon, true);
    return () => {
      window.clearTimeout(deadline);
      window.removeEventListener('pointerdown', abandon, true);
      window.removeEventListener('keydown', abandon, true);
    };
  }, [destinationFocusDocName]);
  useEffect(() => {
    if (
      filesCover ||
      docPanelCover ||
      destinationFocusDocName === null ||
      destinationFocusDocName !== activeDocName
    )
      return;
    const focusDestination = () => {
      const mount = Array.from(
        document.querySelectorAll<HTMLElement>('[data-editor-activity-mount]'),
      ).find(
        (element) =>
          element.dataset.docName === destinationFocusDocName &&
          element.closest('[inert]') === null &&
          element.getClientRects().length > 0,
      );
      const editor = mount?.querySelector<HTMLElement>(
        '.ProseMirror[contenteditable="true"], .cm-content[contenteditable="true"]',
      );
      if (!editor || editor.getClientRects().length === 0) return;
      editor.focus({ preventScroll: true });
      if (document.activeElement === editor) setDestinationFocusDocName(null);
    };
    const observer = new MutationObserver(focusDestination);
    observer.observe(document.getElementById('root') ?? document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['inert', 'style', 'contenteditable'],
    });
    focusDestination();
    return () => observer.disconnect();
  }, [filesCover, docPanelCover, destinationFocusDocName, activeDocName]);
  useEffect(() => {
    if (!docPanelCover) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        event.defaultPrevented ||
        isOverlayLayerOpen() ||
        !escapeBelongsToCover(event, '[data-doc-panel-cover]', docPanelCoverOpenerRef.current)
      )
        return;
      event.preventDefault();
      dismissDocPanelCoverEvent();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [docPanelCover]);

  const editorVisibleAtPinRef = useRef(editorVisible);
  useLayoutEffect(() => {
    const docSlotPresenceChanged = docSlotPresentRef.current !== docSlotPresent;
    const editorShown = editorVisible && !editorVisibleAtPinRef.current;
    docSlotPresentRef.current = docSlotPresent;
    docSlotHeldForLoadRef.current = docSlotHeldForLoad;
    editorVisibleAtPinRef.current = editorVisible;
    if (!docSlotPresenceChanged && !editorShown) return;
    const docCollapsed = isCollapsedRef.current;
    let lastMiss: DocPanelPinMiss | null = null;
    runRailLayoutRetry({
      retryRef: presenceRepinRetryRef,
      attempt: () => {
        lastMiss = null;
        return attemptDocPanelPin(docCollapsed, (miss) => {
          lastMiss = miss;
        });
      },
      context: {
        decision: docSlotPresenceChanged ? 'sync-doc-presence' : 'show-editor',
        targetWidthPx: docPanelWidthPxRef.current,
      },
      describeMiss: () => lastMiss,
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

  const documentArea = skeletonReplacesWorkspace ? (
    <EditorSkeleton />
  ) : (
    <div
      ref={setTerminalEditorRegion}
      tabIndex={-1}
      data-editor-region=""
      className="relative flex min-h-0 flex-1 flex-col outline-none"
    >
      <EditorContentOnScreenContext value={!docPanelCover && !filesCover}>
        <EditorWorkspace
          renderHeader={(tabs) =>
            workspaceHeaderContainer == null
              ? null
              : createPortal(
                  renderWorkspaceHeader(tabs, workspaceHeaderChrome),
                  workspaceHeaderContainer,
                )
          }
          renderPane={renderWorkspacePane}
          renderActivityPool={renderWorkspaceActivityPool}
        />
      </EditorContentOnScreenContext>
    </div>
  );

  const docHandle = (
    <ResizableHandle
      data-doc-panel-handle=""
      aria-controls={DOC_PANEL_ID}
      aria-label={t`Resize document panel`}
      withHandle={docSlotPresent && !isCollapsed && !docPanelCover}
      disabled={!docSlotPresent || isCollapsed || docPanelCover}
      className={docSlotPresent ? undefined : 'pointer-events-none'}
      style={docSlotPresent && !isCollapsed && !docPanelCover ? undefined : { display: 'none' }}
      onPointerDown={(event) => {
        beginDocHandleDrag(event.pointerId);
      }}
    />
  );
  const docPanelSlot = (
    <ResizablePanel
      id={DOC_PANEL_ID}
      role="region"
      aria-label={t`Document panel`}
      panelRef={panelRef}
      defaultSize={!docSlotPresent || docPanelSeed.collapsed ? 0 : `${docPanelSeed.widthPx}px`}
      elementRef={setDocPanelEl}
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
          adoptDraggedDocPanelWidth(size.inPixels);
          debouncedWriteDocPanelWidth(size.inPixels);
        }
        reclaimHiddenDocPanel(docSlotPresent, size.inPixels);
      }}
      inert={!docSlotPresent || isCollapsed}
      className={cn('flex flex-col', SECONDARY_PANEL_SURFACE_CLASS)}
    >
      <div ref={docPanelDockRef} className="flex h-full min-h-0 w-full flex-col" />
    </ResizablePanel>
  );
  const docSlot =
    docPanelSide === 'start' ? (
      <>
        {docPanelSlot}
        {docHandle}
      </>
    ) : (
      <>
        {docHandle}
        {docPanelSlot}
      </>
    );

  const chatAlone = !editorVisible && agentsShowing && !terminalShowing;
  const nothingOpen = !editorVisible && !agentsVisible && !terminalVisible;
  const workspaceAbsorbsResidual = docSlotPresent && !initialRightCollapsed;
  const workspaceHeaderTarget = (
    <div
      ref={setWorkspaceHeaderContainer}
      data-editor-area-header=""
      className={cn('relative z-30 shrink-0', (filesCover || docPanelCover) && 'invisible')}
    />
  );

  const fileListSlot =
    fileListHost != null ? (
      <div
        data-editor-file-list-slot=""
        data-side={fileSidebarSide}
        inert={docPanelCover}
        className="relative flex shrink-0"
        ref={fileListSlotRef}
      />
    ) : null;

  const editorUnit = (
    <PaneCard
      ref={editorCardRef}
      pane="editor"
      variant={cardVariant}
      className="flex-row"
      inert={!editorVisible}
      data-editor-hidden={editorVisible ? undefined : ''}
    >
      {fileSidebarSide === 'start' ? fileListSlot : null}
      <SidebarInset inert={docPanelCover || filesCover} className="min-w-0 overflow-hidden">
        <div
          data-editor-inner-panels=""
          className="relative flex min-h-0 flex-1"
          ref={(el) => {
            setInnerContainerEl(el);
            innerContainerElRef.current = el;
          }}
        >
          <ResizablePanelGroup
            orientation="horizontal"
            groupRef={innerGroupRef}
            data-editor-row="inner"
            onLayoutChange={adoptLibraryDrag}
            data-dragging={isDraggingDocHandle || undefined}
          >
            {docPanelSide === 'start' ? docSlot : null}
            <ResizablePanel
              minSize={docSlotPresent && !isCollapsed ? `${DOC_USABLE_MIN_WIDTH_PX}px` : '0%'}
              {...(workspaceAbsorbsResidual ? {} : { defaultSize: '100%' })}
            >
              <main
                ref={setWorkspaceColumnEl}
                data-editor-workspace-column=""
                className="flex h-full min-w-0 flex-col"
              >
                {noteWindow ? null : workspaceHeaderTarget}
                {documentArea}
              </main>
            </ResizablePanel>
            {docPanelSide === 'end' ? docSlot : null}
          </ResizablePanelGroup>
        </div>
      </SidebarInset>
      {fileSidebarSide === 'end' ? fileListSlot : null}
      {filesCover && fileListHost != null ? (
        <section
          aria-label={t`Files`}
          data-files-cover=""
          className={cn(
            'absolute inset-0 z-20 flex min-h-0 min-w-0 flex-col',
            SECONDARY_PANEL_SURFACE_CLASS,
          )}
        >
          <div ref={setFilesCoverTarget} className="relative min-h-0 flex-1" />
        </section>
      ) : null}
      {docPanelCover && docSlotPresent ? (
        <section
          id="doc-panel-cover"
          aria-label={t`Document panel`}
          data-doc-panel-cover=""
          className={cn(
            'absolute inset-0 z-20 flex min-h-0 min-w-0 flex-col',
            SECONDARY_PANEL_SURFACE_CLASS,
          )}
        >
          <div className="flex h-11 shrink-0 items-center gap-1 px-2">
            <Button
              ref={docPanelBackRef}
              data-doc-panel-back=""
              variant="ghost"
              size="icon-sm"
              aria-label={t`Back to editor`}
              title={t`Back to editor`}
              onClick={dismissDocPanelCover}
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || isOverlayLayerOpen()) return;
                event.preventDefault();
                dismissDocPanelCover();
              }}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <h2 className="min-w-0 flex-1 truncate font-mono text-xs font-normal uppercase tracking-wide text-muted-foreground">
              {activeDocName ?? t`Activity`}
            </h2>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-doc-panel-hide=""
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Hide panel`}
                  onClick={togglePanel}
                >
                  <PanelRightClose aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={8}>{t`Hide panel`}</TooltipContent>
            </Tooltip>
          </div>
          <div ref={docPanelCoverRef} className="min-h-0 flex-1" />
        </section>
      ) : null}
    </PaneCard>
  );

  const agentsUnit = noteWindow ? null : (
    <PaneCard pane="agents" variant={cardVariant}>
      <section
        ref={setAgentsContainer}
        data-agents-panel-mount=""
        data-chat-alone={chatAlone ? '' : undefined}
        aria-label={t`Agent panel`}
        inert={!agentsUnitShown}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      />
    </PaneCard>
  );

  const terminalUnit = terminalAvailable ? (
    <PaneCard
      pane="terminal"
      variant={cardVariant}
      data-placement={terminalPlacement}
      style={{ backgroundColor: xtermBackground }}
    >
      <div
        ref={setTerminalContainer}
        data-terminal-panel-mount=""
        inert={!terminalUnitShown}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      />
    </PaneCard>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {noteWindow ? workspaceHeaderTarget : null}
      <div data-editor-area-panels="" className="relative flex min-h-0 flex-1">
        <DockWorkspace
          tree={dockTree}
          visible={{ editor: editorVisible, agents: agentsUnitShown, terminal: terminalUnitShown }}
          units={{ editor: editorUnit, agents: agentsUnit, terminal: terminalUnit }}
          gap={cardLook ? PANE_CARD_GAP_PX : 0}
          minExtent={dockPaneMinExtent}
          paneLabel={(pane) => t(PANE_LABEL[pane])}
          onTreeChange={onDockTreeChange}
          onLayoutChange={setDockLayout}
          redockable={!noteWindow}
        />
        {nothingOpen ? <NothingOpen /> : null}
      </div>
      {createPortal(docSlotContent, docPanelHost)}
    </div>
  );
}
