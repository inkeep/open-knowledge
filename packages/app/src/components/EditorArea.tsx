// oxlint-disable ok/no-physical-direction-utility -- pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/ok-rules/README.md#no-physical-direction-utility

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { parseExternalSkillDocName } from '@inkeep/open-knowledge-core/constants/cc1';
import { detectEmbeddedHostFromBrowser } from '@inkeep/open-knowledge-core/constants/embedded-host';
import {
  isFrontmatterSchemaAsset,
  isMarkdownlintJsonConfig,
} from '@inkeep/open-knowledge-core/markdown/lint';
import {
  PREFERRED_TERMINAL_RIGHT_WIDTH,
  type TerminalPlacement,
} from '@inkeep/open-knowledge-core/terminal-layout';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronLeft, PanelRightClose } from 'lucide-react';
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
import { ShareReceiveMissPanel } from '@/components/ShareReceiveMissPanel';
import { SkillFileViewer } from '@/components/SkillFileViewer';
import { SkillPreviewTab } from '@/components/SkillPreviewTab';
import { SettingsDialogShell } from '@/components/settings/SettingsDialogShell';
import { Button } from '@/components/ui/button';
import {
  PANE_CARD_GAP_LEAD_INSET_PX,
  PANE_CARD_GAP_TRAIL_INSET_PX,
  PANE_CARD_INSET_PX,
  PaneCard,
  paneCardDividerClass,
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
import { focusAwayFromHiddenEditor, focusWaitsForEditor } from '@/lib/editor-hidden-focus';
import { type EditorSidebar, resolveEditorSidebarFit } from '@/lib/editor-sidebar-fit';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';
import { isNoteWindow } from '@/lib/note-window-mode';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import { assertNeverPaneId, type PaneId } from '@/lib/pane-visibility-store';
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
import {
  computeEditorHiddenLayout,
  editorHiddenLayoutLanded,
  isEditorHiddenLayoutSettled,
} from './editor-area-hidden-editor';
import { computeInnerFollowLayout, predictInnerPanelSpacePx } from './editor-area-inner-follow';
import { shouldPaintOverlay } from './editor-area-overlay';
import {
  describeRailFloorShortfall,
  describeRailWidthShortfall,
  type RailPanelSpaceRefusal,
  type RailPanelSpaceResult,
  type RailWidthShortfall,
  reportUnexpectedPanelGroupFailure,
  resolveInnerRowChromePx,
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
import { TerminalDock, type TerminalDockHandle } from './TerminalDock';

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
  readonly decision: 'sync-rail-columns' | 'sync-doc-presence' | 'observed-doc-width';
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
  | { readonly stage: 'width-shortfall'; readonly shortfall: Record<string, RailWidthShortfall> }
  | { readonly stage: 'editor-hidden-unsettled' };

type RailPinExhaustedTrigger = 'rail-column-sync' | 'doc-slot-presence' | 'editor-visibility';

const DOC_PANEL_MIN_WIDTH_PX = 300;
const DOC_USABLE_MIN_WIDTH_PX = 300;
const DOC_PANEL_MIN_SIZE = `${DOC_PANEL_MIN_WIDTH_PX}px`;
const DOC_PANEL_MAX_SIZE = '600px';
const RIGHT_TERMINAL_GAP_END_INSET_PX = 1;
const EDITOR_COLUMN_COLLAPSED_PCT = 0.5;
const NO_CARD_INSETS = { start: 0, end: 0 } as const;

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
  bringBackPane(pane: PaneId): void;
}

interface EditorCardSize {
  readonly width: number;
  readonly height: number;
}

function measureEditorCard(card: HTMLElement): EditorCardSize | null {
  const { width, height } = card.getBoundingClientRect();
  return width > 0 && height > 0 ? { width, height } : null;
}

function hasExtent(element: HTMLElement | null): boolean {
  if (element == null) return false;
  const { width, height } = element.getBoundingClientRect();
  return width > 0 && height > 0;
}

interface WorkspaceHeaderChrome {
  readonly trailing: ReactNode;
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
  terminalPlacement?: TerminalPlacement;
  terminalRightWidth?: number;
  onTerminalVisibleChange?: (visible: boolean) => void;
  onTerminalRightWidthChange?: (width: number) => void;
  agentsVisible?: boolean;
  onAgentsVisibleChange?: (visible: boolean) => void;
  onSessionPlacements?: (placements: SessionPlacements) => void;
  renderWorkspaceHeader?: (tabs: ReactNode, chrome: WorkspaceHeaderChrome) => ReactNode;
}

function renderTabsWithoutHeader(tabs: ReactNode, chrome: WorkspaceHeaderChrome): ReactNode {
  return (
    <>
      {tabs}
      {chrome.trailing}
    </>
  );
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
  terminalPlacement = 'bottom',
  terminalRightWidth,
  onTerminalVisibleChange,
  onTerminalRightWidthChange,
  agentsVisible = false,
  onAgentsVisibleChange,
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
  const agentsColumnPanelRef = usePanelRef();
  const terminalColumnPanelRef = usePanelRef();
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
    canDock: filesCanDock,
    dismissCover: dismissFilesCover,
    setCanDock: setFilesCanDock,
    registerOpenRequestHandler: registerFilesOpenRequestHandler,
    registerCoverSelectionHandler: registerFilesCoverSelectionHandler,
    open: filesIntentOpen,
    width: filesDockWidth,
  } = useSidebar();
  const fileListHost = useFileListHost();
  const [filesCoverTarget, setFilesCoverTarget] = useState<HTMLDivElement | null>(null);

  const [agentsContainer, setAgentsContainer] = useState<HTMLElement | null>(null);
  const [rightTerminalContainer, setRightTerminalContainer] = useState<HTMLDivElement | null>(null);
  const [workspaceHeaderContainer, setWorkspaceHeaderContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [workspaceColumnEl, setWorkspaceColumnEl] = useState<HTMLElement | null>(null);
  const [bottomTerminalContainer, setBottomTerminalContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [terminalEditorRegion, setTerminalEditorRegion] = useState<HTMLDivElement | null>(null);

  const agentsColumnPresent = !noteWindow && agentsVisible;
  const terminalColumnPresent = !noteWindow && terminalVisible && terminalPlacement === 'right';
  const [agentsColumnCollapsed, setAgentsColumnCollapsed] = useState(false);
  const [terminalColumnCollapsed, setTerminalColumnCollapsed] = useState(false);
  const terminalCollapsedByUserRef = useRef(false);
  const [bottomTerminalCollapsed, setBottomTerminalCollapsed] = useState(false);
  const terminalDockRef = useRef<TerminalDockHandle>(null);
  const [agentsShowingHold, setAgentsShowingHold] = useState(false);
  const [terminalShowingHold, setTerminalShowingHold] = useState(false);
  const resizableRailColumnPresent = terminalColumnPresent || agentsColumnPresent;
  const rightTerminalCardShowing = terminalColumnPresent && !terminalColumnCollapsed;
  const rightColumnPresent = terminalColumnPresent || agentsColumnPresent;
  const bottomTerminalHeld = terminalAvailable && terminalVisible && terminalPlacement === 'bottom';
  const editorColumnHoldsPane = editorVisible || bottomTerminalHeld;
  const editorColumnChromePx =
    cardLook && rightColumnPresent && editorColumnHoldsPane ? PANE_CARD_GAP_LEAD_INSET_PX : 0;
  const terminalCardInsets = cardLook
    ? {
        start: editorVisible ? PANE_CARD_GAP_TRAIL_INSET_PX : 0,
        end: agentsColumnPresent ? RIGHT_TERMINAL_GAP_END_INSET_PX : 0,
      }
    : NO_CARD_INSETS;
  const agentsCardInsetStartPx = !cardLook
    ? 0
    : terminalColumnPresent
      ? PANE_CARD_INSET_PX - RIGHT_TERMINAL_GAP_END_INSET_PX
      : editorColumnHoldsPane
        ? PANE_CARD_GAP_TRAIL_INSET_PX
        : 0;
  const editorColumnChromePxRef = useRef(editorColumnChromePx);
  const editorVisibleRef = useRef(editorVisible);
  const bottomTerminalHeldRef = useRef(bottomTerminalHeld);
  const editorCardRef = useRef<HTMLDivElement | null>(null);
  const lastEditorCardSizeRef = useRef<EditorCardSize | null>(null);
  const [editorCardPin, setEditorCardPin] = useState<EditorCardSize | null>(null);
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
  useLayoutEffect(() => {
    const card = editorCardRef.current;
    if (card == null || !editorVisible || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const size = measureEditorCard(card);
      if (size != null) lastEditorCardSizeRef.current = size;
    });
    observer.observe(card);
    return () => observer.disconnect();
  }, [editorVisible]);
  const editorVisibleBeforeRef = useRef(editorVisible);
  useLayoutEffect(() => {
    const wasVisible = editorVisibleBeforeRef.current;
    editorVisibleBeforeRef.current = editorVisible;
    if (editorVisible) {
      if (!wasVisible && focusWaitsForEditor()) terminalEditorRegion?.focus();
      return;
    }
    const card = editorCardRef.current;
    if (card == null) return;
    setEditorCardPin(
      (current) => current ?? lastEditorCardSizeRef.current ?? measureEditorCard(card),
    );
    if (card.contains(document.activeElement)) focusAwayFromHiddenEditor();
  }, [editorVisible, terminalEditorRegion]);
  const terminalContainer =
    terminalPlacement === 'right' ? rightTerminalContainer : bottomTerminalContainer;
  const terminalShowing =
    terminalVisible &&
    terminalContainer != null &&
    (terminalPlacement === 'right'
      ? !terminalColumnCollapsed || terminalShowingHold
      : !bottomTerminalCollapsed);
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
    if (!terminalColumnPresent) {
      setTerminalShowingHold(false);
      terminalCollapsedByUserRef.current = false;
    }
  }, [agentsColumnPresent, terminalColumnPresent]);

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
    const mounts = [agentsContainer, rightTerminalContainer, bottomTerminalContainer].filter(
      (mount) => mount != null,
    );
    for (const mount of mounts) observer.observe(mount);
    return () => {
      for (const mount of mounts) observer.unobserve(mount);
    };
  }, [agentsContainer, rightTerminalContainer, bottomTerminalContainer]);

  useEffect(() => {
    isCollapsedRef.current = isCollapsed;
  }, [isCollapsed]);
  const [isDraggingDocHandle, setIsDraggingDocHandle] = useState(false);
  const isDraggingDocHandleRef = useRef(false);

  const [initialDocPanelWidthPx] = useState(() => getInitialDocPanelWidth());
  const docPanelWidthPxRef = useRef(initialDocPanelWidthPx);
  const [preferredDocPanelWidthPx, setPreferredDocPanelWidthPx] = useState(initialDocPanelWidthPx);
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
  const [innerContainerEl, setInnerContainerEl] = useState<HTMLDivElement | null>(null);
  const innerContainerElRef = useRef<HTMLDivElement | null>(null);
  const {
    node: fileListSlotEl,
    nodeRef: fileListSlotElRef,
    slotRef: fileListSlotRef,
  } = useFileListSlot();
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
  const editorVisibilityRetryRef = useRef<RailLayoutRetryController>({
    frameId: 0,
    deadlineTimer: null,
  });
  const observedDocWidthRetryRef = useRef<RailLayoutRetryController>({
    frameId: 0,
    deadlineTimer: null,
  });
  const railPinOutcomeRef = useRef<RailPinOutcome>({ stage: 'group-missing' });
  const railPlanWriteInProgressRef = useRef(false);
  const railPinExhaustedReportsRef = useRef<Record<RailPinExhaustedTrigger, number>>({
    'rail-column-sync': 0,
    'doc-slot-presence': 0,
    'editor-visibility': 0,
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
  const innerGroupRef = useGroupRef();
  function readDocPanelPx(): number | null {
    try {
      const size = panelRef.current?.getSize();
      return size == null || !Number.isFinite(size.inPixels) ? null : size.inPixels;
    } catch (error) {
      reportUnexpectedPanelGroupFailure('read-doc-panel-px-failed', error);
      return null;
    }
  }
  function resolveGroupPxWidth(): number | null {
    return resolveRailPanelSpacePx(groupContainerElRef.current);
  }
  function resolveInnerGroupPxWidth(): number | null {
    return resolveRailPanelSpacePx(innerContainerElRef.current);
  }
  function measureInnerChromePx(innerPx: number): number {
    const chromePx = resolveInnerRowChromePx(
      groupContainerElRef.current,
      innerContainerElRef.current,
      innerPx,
    );
    if (chromePx != null) return chromePx;
    reportUnexpectedPanelGroupFailure(
      'measure-inner-chrome-column-missing',
      new Error('No outer row column holds the inner row'),
    );
    return 0;
  }
  function readFileListWidthPx(): number {
    const width = fileListSlotElRef.current?.getBoundingClientRect().width ?? 0;
    return Number.isFinite(width) && width > 0 ? width : 0;
  }
  function sharedRowPxFrom(outerPx: number): number {
    return Math.max(0, outerPx - editorColumnChromePxRef.current - readFileListWidthPx());
  }
  function resolveSharedRowPxWidth(): number | null {
    const outerPx = resolveGroupPxWidth();
    return outerPx == null ? null : sharedRowPxFrom(outerPx);
  }

  function resolveAdmissionMetrics(): {
    workspaceWidthPx: number;
    otherRailWidthPx: number;
  } | null {
    const group = groupRef.current;
    if (group == null) return null;
    try {
      const workspaceWidthPx = resolveSharedRowPxWidth();
      if (workspaceWidthPx == null) return null;
      if (!docSlotPresentRef.current) {
        return { workspaceWidthPx, otherRailWidthPx: 0 };
      }
      if (isCollapsedRef.current) {
        return { workspaceWidthPx, otherRailWidthPx: 0 };
      }
      const measuredWidthPx = readDocPanelPx();
      const docWidthPx =
        measuredWidthPx != null && measuredWidthPx > 0
          ? Math.min(measuredWidthPx, docPanelWidthPxRef.current)
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
  const filesCanDockRef = useRef(filesCanDock);
  const dragCloseRequestedRef = useRef(false);
  const admissionDeferredByFilesRef = useRef<{
    readonly trigger: 'state-change' | 'resize';
    readonly previous: AdmissionVisibility;
  } | null>(null);
  const admissionDeferredByDragRef = useRef<{
    readonly trigger: 'state-change' | 'resize';
    readonly previous: AdmissionVisibility;
  } | null>(null);

  function railDragInProgress(): boolean {
    return (
      isDraggingDocHandleRef.current ||
      isDraggingTerminalHandleRef.current ||
      isDraggingAgentsHandleRef.current
    );
  }

  function enforceRightRailAdmission(
    trigger: 'state-change' | 'resize',
    previous: AdmissionVisibility,
  ) {
    if (railDragInProgress()) {
      admissionDeferredByDragRef.current = { trigger, previous };
      return;
    }
    admissionDeferredByDragRef.current = null;
    const filesSettling = !filesCanDockRef.current && readFileListWidthPx() > 0;
    const deferredByFiles = filesSettling ? null : admissionDeferredByFilesRef.current;
    const admissionTrigger = deferredByFiles?.trigger ?? trigger;
    const admissionPrevious = deferredByFiles?.previous ?? previous;
    const metrics = resolveAdmissionMetrics();
    if (metrics == null) return;
    const decision = resolveRightRailAdmission({
      ...metrics,
      editorMinimumWidthPx: docSlotPresentRef.current ? DOC_USABLE_MIN_WIDTH_PX : 0,
      agentsMinimumWidthPx: MIN_AGENTS_PANEL_WIDTH,
      previous: admissionPrevious,
      current: admissionVisibilityRef.current,
      trigger: admissionTrigger,
    });
    if (filesSettling) {
      if (
        decision.kind !== 'none' &&
        (admissionDeferredByFilesRef.current == null || trigger === 'state-change')
      ) {
        admissionDeferredByFilesRef.current = { trigger, previous };
      }
      return;
    }
    admissionDeferredByFilesRef.current = null;
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
    filesCanDockRef.current = filesCanDock;
    admissionVisibilityRef.current = admissionVisibility;
    editorColumnChromePxRef.current = editorColumnChromePx;
    editorVisibleRef.current = editorVisible;
    bottomTerminalHeldRef.current = bottomTerminalHeld;
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

  function applyEditorHiddenLayout(): boolean {
    const outerGroup = groupRef.current;
    if (outerGroup == null) {
      railPinOutcomeRef.current = { stage: 'group-missing' };
      return false;
    }
    let outerSpace: RailPanelSpaceResult;
    let outerLayout: Record<string, number>;
    try {
      outerSpace = resolveRailPanelSpace(groupContainerElRef.current);
      outerLayout = outerGroup.getLayout();
    } catch (error) {
      railPinOutcomeRef.current = { stage: 'read-failed' };
      reportUnexpectedPanelGroupFailure('apply-editor-hidden-layout-read-failed', error);
      return false;
    }
    if (!outerSpace.ok) {
      railPinOutcomeRef.current = { stage: 'panel-space-unresolved', refusal: outerSpace.refusal };
      return false;
    }
    const outerAccounting = accountRailLayout(Object.keys(outerLayout));
    if (!outerAccounting.ok) {
      railPinOutcomeRef.current =
        outerAccounting.unaccountedIds.length === 0
          ? { stage: 'no-residual-panel' }
          : { stage: 'layout-unaccounted', unaccountedIds: outerAccounting.unaccountedIds };
      return false;
    }
    const outerPx = outerSpace.panelSpacePx;
    const currentOrPreferredPx = (id: string, visible: boolean, preferredPx: number) => {
      if (!visible) return 0;
      const currentPx = ((outerLayout[id] ?? 0) / 100) * outerPx;
      return currentPx > 0 ? currentPx : preferredPx;
    };
    const editorColumnId = outerAccounting.residualId;
    const chatBesideBottomTerminalPx = admissionVisibilityRef.current.agentsVisible
      ? agentsPreferredWidthPxRef.current
      : 0;
    const plan = {
      currentLayout: outerLayout,
      editorColumnId,
      visibleColumnPx: bottomTerminalHeldRef.current
        ? {
            [editorColumnId]: Math.max(outerPx - chatBesideBottomTerminalPx, 1),
            [AGENTS_COLUMN_ID]: chatBesideBottomTerminalPx,
          }
        : {
            [TERMINAL_COLUMN_ID]: currentOrPreferredPx(
              TERMINAL_COLUMN_ID,
              admissionVisibilityRef.current.terminalRightVisible,
              terminalWidthPxRef.current,
            ),
            [AGENTS_COLUMN_ID]: currentOrPreferredPx(
              AGENTS_COLUMN_ID,
              admissionVisibilityRef.current.agentsVisible,
              agentsPreferredWidthPxRef.current,
            ),
          },
    };
    if (isEditorHiddenLayoutSettled(plan)) {
      railPinOutcomeRef.current = { stage: 'pinned' };
      return true;
    }
    const next = computeEditorHiddenLayout(plan);
    railPlanWriteInProgressRef.current = true;
    let readBack: Record<string, number>;
    try {
      outerGroup.setLayout(next);
      readBack = outerGroup.getLayout();
    } catch (error) {
      railPlanWriteInProgressRef.current = false;
      railPinOutcomeRef.current = { stage: 'write-failed' };
      reportUnexpectedPanelGroupFailure('apply-editor-hidden-layout-write-failed', error);
      return false;
    }
    railPlanWriteInProgressRef.current = false;
    const landed = editorHiddenLayoutLanded(next, readBack);
    railPinOutcomeRef.current = landed ? { stage: 'pinned' } : { stage: 'editor-hidden-unsettled' };
    return landed;
  }

  function reopenCollapsedEditorColumn(
    outerGroup: NonNullable<typeof groupRef.current>,
    outerLayout: Record<string, number>,
    outerPx: number,
  ) {
    const { residualId } = accountRailLayout(Object.keys(outerLayout));
    if (residualId == null || (outerLayout[residualId] ?? 0) > EDITOR_COLUMN_COLLAPSED_PCT) return;
    const pinnedPx: Record<string, number> = {};
    if (TERMINAL_COLUMN_ID in outerLayout) {
      pinnedPx[TERMINAL_COLUMN_ID] = admissionVisibilityRef.current.terminalRightVisible
        ? terminalWidthPxRef.current
        : 0;
    }
    if (AGENTS_COLUMN_ID in outerLayout) {
      pinnedPx[AGENTS_COLUMN_ID] = admissionVisibilityRef.current.agentsVisible
        ? agentsPreferredWidthPxRef.current
        : 0;
    }
    const next = computeStickyRepinLayout({
      currentLayout: outerLayout,
      containerPx: outerPx,
      pinnedPx,
      residualId,
    });
    if (next === outerLayout) return;
    railPlanWriteInProgressRef.current = true;
    try {
      outerGroup.setLayout(next);
    } catch (error) {
      reportUnexpectedPanelGroupFailure('reopen-editor-column-write-failed', error);
    }
    railPlanWriteInProgressRef.current = false;
  }

  function applyRailLayout(
    docCollapsed: boolean,
    {
      agentsWidthOverridePx,
    }: {
      agentsWidthOverridePx?: number;
    } = {},
  ): boolean {
    if (!editorVisibleRef.current) return applyEditorHiddenLayout();
    const outerGroup = groupRef.current;
    const innerGroup = innerGroupRef.current;
    if (outerGroup == null || innerGroup == null) {
      railPinOutcomeRef.current = { stage: 'group-missing' };
      return false;
    }
    let outerSpace: RailPanelSpaceResult;
    let innerSpace: RailPanelSpaceResult;
    let outerLayout: Record<string, number>;
    let innerLayout: Record<string, number>;
    try {
      outerSpace = resolveRailPanelSpace(groupContainerElRef.current);
      innerSpace = resolveRailPanelSpace(innerContainerElRef.current);
      outerLayout = outerGroup.getLayout();
      innerLayout = innerGroup.getLayout();
    } catch (error) {
      railPinOutcomeRef.current = { stage: 'read-failed' };
      reportUnexpectedPanelGroupFailure('apply-rail-layout-read-failed', error);
      return false;
    }
    if (!outerSpace.ok) {
      railPinOutcomeRef.current = { stage: 'panel-space-unresolved', refusal: outerSpace.refusal };
      return false;
    }
    if (!innerSpace.ok) {
      railPinOutcomeRef.current = { stage: 'panel-space-unresolved', refusal: innerSpace.refusal };
      reopenCollapsedEditorColumn(outerGroup, outerLayout, outerSpace.panelSpacePx);
      return false;
    }
    const outerPx = outerSpace.panelSpacePx;
    const innerPx = innerSpace.panelSpacePx;
    const sharedRowPx = sharedRowPxFrom(outerPx);
    const outerAccounting = accountRailLayout(Object.keys(outerLayout));
    const innerAccounting = accountRailLayout(Object.keys(innerLayout));
    if (!outerAccounting.ok || !innerAccounting.ok) {
      const unaccountedIds = [...outerAccounting.unaccountedIds, ...innerAccounting.unaccountedIds];
      railPinOutcomeRef.current =
        unaccountedIds.length === 0
          ? { stage: 'no-residual-panel' }
          : { stage: 'layout-unaccounted', unaccountedIds };
      if (import.meta.env.DEV) {
        console.warn(
          JSON.stringify({
            event: 'right-rail-accounting-failed',
            unaccountedIds,
          }),
        );
      }
      return false;
    }

    const buildPins = (atFloor: boolean) => {
      const inner: Record<string, number> = {};
      const outer: Record<string, number> = {};
      if (DOC_PANEL_ID in innerLayout) {
        inner[DOC_PANEL_ID] =
          !docSlotPresentRef.current || docCollapsed
            ? 0
            : atFloor
              ? DOC_PANEL_MIN_WIDTH_PX
              : docPanelWidthPxRef.current;
      }
      if (TERMINAL_COLUMN_ID in outerLayout) {
        outer[TERMINAL_COLUMN_ID] =
          !admissionVisibilityRef.current.terminalRightVisible || terminalCollapsedByUserRef.current
            ? 0
            : atFloor
              ? RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX
              : terminalWidthPxRef.current;
      }
      if (AGENTS_COLUMN_ID in outerLayout) {
        outer[AGENTS_COLUMN_ID] = !admissionVisibilityRef.current.agentsVisible
          ? 0
          : atFloor
            ? MIN_AGENTS_PANEL_WIDTH
            : (agentsWidthOverridePx ?? agentsPreferredWidthPxRef.current);
      }
      return { inner, outer, all: { ...inner, ...outer } };
    };

    const renderedWidths = (
      outerPcts: Record<string, number>,
      innerPcts: Record<string, number>,
      innerRowPx = innerPx,
    ) => {
      const widths = new Map<string, number>();
      for (const [id, pct] of Object.entries(outerPcts)) widths.set(id, (pct / 100) * outerPx);
      for (const [id, pct] of Object.entries(innerPcts)) widths.set(id, (pct / 100) * innerRowPx);
      return widths;
    };
    const fitsSharedRow = (pins: Record<string, number>) =>
      Object.values(pins).reduce((total, px) => total + px, 0) <= sharedRowPx;

    const docRenderedPx = readDocPanelPx();
    const withDocRendered = (widths: Map<string, number>) => {
      if (docRenderedPx != null && widths.has(DOC_PANEL_ID))
        widths.set(DOC_PANEL_ID, docRenderedPx);
      return widths;
    };

    let pins = buildPins(false);
    if (Object.keys(pins.all).length === 0) {
      railPinOutcomeRef.current = { stage: 'no-pinned-columns' };
      return false;
    }
    if (!fitsSharedRow(pins.all)) pins = buildPins(true);
    if (!fitsSharedRow(pins.all)) {
      const shortfall = describeRailFloorShortfall(
        pins.all,
        withDocRendered(renderedWidths(outerLayout, innerLayout)),
      );
      const pinned = Object.keys(shortfall).length === 0;
      railPinOutcomeRef.current = pinned
        ? { stage: 'pinned' }
        : { stage: 'pins-do-not-fit', shortfall };
      return pinned;
    }

    const nextOuter = computeStickyRepinLayout({
      currentLayout: outerLayout,
      containerPx: outerPx,
      pinnedPx: pins.outer,
      residualId: outerAccounting.residualId,
    });
    const innerTargetPx =
      predictInnerPanelSpacePx({
        outerLayout: nextOuter,
        outerResidualId: outerAccounting.residualId,
        outerPanelSpacePx: outerPx,
        innerChromePx: measureInnerChromePx(innerPx),
      }) ?? innerPx;
    const docPinPx = pins.inner[DOC_PANEL_ID];
    const docProjectedPx =
      docPinPx == null ? null : ((innerLayout[DOC_PANEL_ID] ?? 0) / 100) * innerTargetPx;
    const docAlreadyPinned =
      docPinPx != null && docProjectedPx != null && Math.abs(docProjectedPx - docPinPx) <= 1;
    const nextInner = docAlreadyPinned
      ? innerLayout
      : computeStickyRepinLayout({
          currentLayout: innerLayout,
          containerPx: innerTargetPx,
          pinnedPx: pins.inner,
          residualId: innerAccounting.residualId,
        });
    railPlanWriteInProgressRef.current = true;
    try {
      if (nextOuter !== outerLayout) outerGroup.setLayout(nextOuter);
      if (nextInner !== innerLayout) innerGroup.setLayout(nextInner);
    } catch (error) {
      railPlanWriteInProgressRef.current = false;
      railPinOutcomeRef.current = { stage: 'write-failed' };
      reportUnexpectedPanelGroupFailure('apply-rail-layout-write-failed', error);
      return false;
    }
    railPlanWriteInProgressRef.current = false;
    let outerReadBack: Record<string, number>;
    let innerReadBack: Record<string, number>;
    try {
      outerReadBack = outerGroup.getLayout();
      innerReadBack = innerGroup.getLayout();
    } catch (error) {
      railPinOutcomeRef.current = { stage: 'verify-failed' };
      reportUnexpectedPanelGroupFailure('apply-rail-layout-verify-failed', error);
      return false;
    }
    const shortfall = describeRailWidthShortfall(
      pins.all,
      renderedWidths(outerReadBack, innerReadBack, innerTargetPx),
    );
    const pinned = Object.keys(shortfall).length === 0;
    railPinOutcomeRef.current = pinned
      ? { stage: 'pinned' }
      : { stage: 'width-shortfall', shortfall };
    return pinned;
  }

  function followOuterLayout(outerLayout: Record<string, number>) {
    if (!editorVisibleRef.current) return;
    const innerGroup = innerGroupRef.current;
    if (innerGroup == null) return;
    const outerPx = resolveGroupPxWidth();
    const innerPx = resolveInnerGroupPxWidth();
    if (outerPx == null || innerPx == null) return;
    let innerLayout: Record<string, number>;
    try {
      innerLayout = innerGroup.getLayout();
    } catch (error) {
      reportUnexpectedPanelGroupFailure('follow-outer-layout-read-failed', error);
      return;
    }
    const outerAccounting = accountRailLayout(Object.keys(outerLayout));
    const innerAccounting = accountRailLayout(Object.keys(innerLayout));
    if (!outerAccounting.ok || !innerAccounting.ok || !(DOC_PANEL_ID in innerLayout)) return;
    const docPinPx =
      !docSlotPresentRef.current || isCollapsedRef.current ? 0 : docPanelWidthPxRef.current;
    const next = computeInnerFollowLayout({
      outerLayout,
      outerResidualId: outerAccounting.residualId,
      outerPanelSpacePx: outerPx,
      innerChromePx: measureInnerChromePx(innerPx),
      innerLayout,
      innerResidualId: innerAccounting.residualId,
      pinnedPx: { [DOC_PANEL_ID]: docPinPx },
    });
    if (next === innerLayout) return;
    try {
      innerGroup.setLayout(next);
    } catch (error) {
      reportUnexpectedPanelGroupFailure('follow-outer-layout-write-failed', error);
    }
  }

  function reclaimHiddenRailColumn(columnId: string, present: boolean, widthPx: number) {
    if (present || widthPx <= 0) return;
    queueMicrotask(() => {
      const innerRow = columnId === DOC_PANEL_ID;
      if (!innerRow && !editorVisibleRef.current) return;
      const group = innerRow ? innerGroupRef.current : groupRef.current;
      if (group == null) return;
      let layout: Record<string, number>;
      let containerPx: number | null;
      try {
        layout = group.getLayout();
        containerPx = innerRow ? resolveInnerGroupPxWidth() : resolveGroupPxWidth();
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
    if (railDragInProgress()) {
      if (isDraggingDocHandleRef.current) return 'blocked';
      const group = innerGroupRef.current;
      const containerPx = resolveInnerGroupPxWidth();
      if (group == null || containerPx == null) return 'blocked';
      try {
        const layout = group.getLayout();
        const residualId = findResidualPanelId(Object.keys(layout));
        if (residualId == null || !(DOC_PANEL_ID in layout)) return 'blocked';
        const collapsed =
          docCollapsed || containerPx < docPanelWidthPxRef.current + DOC_USABLE_MIN_WIDTH_PX;
        isCollapsedRef.current = collapsed;
        group.setLayout(
          computeStickyRepinLayout({
            currentLayout: layout,
            containerPx,
            pinnedPx: { [DOC_PANEL_ID]: collapsed ? 0 : docPanelWidthPxRef.current },
            residualId,
          }),
        );
        return 'blocked';
      } catch (error) {
        reportUnexpectedPanelGroupFailure('fit-information-during-outer-drag-failed', error);
        return 'failed';
      }
    }
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
  function railLayoutRetryPending(): boolean {
    return (
      agentsSettlementRetryRef.current.context != null ||
      railColumnSyncRetryRef.current.context != null ||
      presenceRepinRetryRef.current.context != null ||
      editorVisibilityRetryRef.current.context != null
    );
  }
  function replanAfterDragEnd() {
    const closeRequested = dragCloseRequestedRef.current;
    dragCloseRequestedRef.current = false;
    const deferredAdmission = admissionDeferredByDragRef.current;
    admissionDeferredByDragRef.current = null;
    if (closeRequested) return;
    if (!railLayoutRetryPending()) assertRightRailLayoutRef.current(isCollapsedRef.current);
    if (deferredAdmission != null) {
      enforceRightRailAdmissionRef.current(deferredAdmission.trigger, deferredAdmission.previous);
    }
  }
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
      replanAfterDragEnd();
    }
    function onPointerCancel(event: PointerEvent) {
      if (pointerId != null && event.pointerId !== pointerId) return;
      end();
      assertRightRailLayoutRef.current(isCollapsedRef.current);
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
  function beginTerminalHandleDrag(pointerId: number | null) {
    const startedOnSeparator = pointerId != null;
    trackHandleDrag(
      pointerId,
      setIsDraggingTerminalHandle,
      isDraggingTerminalHandleRef,
      () => {
        if (!terminalColumnPanelRef.current?.isCollapsed()) return;
        dragCloseRequestedRef.current = true;
        if (startedOnSeparator && onTerminalVisibleChange != null) onTerminalVisibleChange(false);
      },
      () => {
        if (!startedOnSeparator || !terminalColumnPanelRef.current?.isCollapsed()) {
          setTerminalShowingHold(false);
        }
      },
    );
  }
  function beginAgentsHandleDrag(pointerId: number | null) {
    const chatHistoryCovering =
      agentsContainer?.querySelector('[data-history-mode="cover"]') != null;
    const startedOnSeparator = pointerId != null && !chatHistoryCovering;
    cancelAgentsSettlement();
    trackHandleDrag(
      pointerId,
      setIsDraggingAgentsHandle,
      isDraggingAgentsHandleRef,
      () => settleAgentsPointerRelease({ leaveCollapsed: !startedOnSeparator }),
      () => {
        if (!startedOnSeparator || !agentsColumnPanelRef.current?.isCollapsed()) {
          setAgentsShowingHold(false);
        }
      },
    );
  }
  function adoptLibraryDrag(row: 'outer' | 'inner') {
    const container = row === 'outer' ? groupContainerElRef.current : innerContainerElRef.current;
    const active = container?.querySelector(':scope > [data-group] > [data-separator="active"]');
    if (!(active instanceof HTMLElement)) return;
    if (row === 'inner') {
      if (active.hasAttribute('data-doc-panel-handle') && !isDraggingDocHandleRef.current) {
        beginDocHandleDrag(null);
      }
      return;
    }
    if (active.hasAttribute('data-terminal-panel-handle') && !isDraggingTerminalHandleRef.current) {
      beginTerminalHandleDrag(null);
    } else if (
      active.hasAttribute('data-agents-panel-resize-handle') &&
      !isDraggingAgentsHandleRef.current
    ) {
      beginAgentsHandleDrag(null);
    }
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

  function settleAgentsPointerRelease(options?: { readonly leaveCollapsed: boolean }) {
    cancelAgentsSettlement();
    const measuredWidthPx = agentsColumnPanelRef.current?.getSize().inPixels;
    const decision = resolveAgentsPanelPointerRelease(
      measuredWidthPx,
      agentsPreferredWidthPxRef.current,
    );
    const context = createAgentsPanelPointerReleaseRetryContext(decision);
    if (!editorVisibleRef.current && context.decision !== 'close') {
      superviseAgentsPointerSettlement(context);
      return;
    }
    switch (context.decision) {
      case 'close':
        if (options?.leaveCollapsed) {
          dragCloseRequestedRef.current = true;
        } else if (onAgentsVisibleChange != null) {
          pendingAgentsVisibilityRetryContextRef.current = context;
          dragCloseRequestedRef.current = true;
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
    if (!isUserInteraction || railDragInProgress() || !editorVisibleRef.current) return;
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

  const previousEditorColumnRef = useRef({ editorVisible, editorColumnHoldsPane });
  // biome-ignore lint/correctness/useExhaustiveDependencies: render-bound attemptRailLayout is sampled when editor visibility or the editor column's contents flip; the flip owns retry replacement
  useEffect(() => {
    const previous = previousEditorColumnRef.current;
    if (
      previous.editorVisible === editorVisible &&
      previous.editorColumnHoldsPane === editorColumnHoldsPane
    ) {
      return;
    }
    previousEditorColumnRef.current = { editorVisible, editorColumnHoldsPane };
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      runRailLayoutRetry({
        retryRef: editorVisibilityRetryRef,
        attempt: () => attemptRailLayout(isCollapsedRef.current),
        context: {
          decision: 'sync-rail-columns',
          targetWidthPx: agentsVisible ? agentsPreferredWidthPxRef.current : 0,
        },
        onComplete: () => {
          if (editorVisibleRef.current) setEditorCardPin(null);
        },
        onExhausted: () => reportRailPinExhausted('editor-visibility'),
      });
    });
    return () => {
      cancelled = true;
      cancelRailLayoutRetry(editorVisibilityRetryRef);
    };
  }, [editorVisible, editorColumnHoldsPane]);

  function bringBackRailColumn(targetWidthPx: number) {
    runRailLayoutRetry({
      retryRef: railColumnSyncRetryRef,
      attempt: () => attemptRailLayout(isCollapsedRef.current),
      context: { decision: 'sync-rail-columns', targetWidthPx },
    });
  }

  useImperativeHandle(ref, () => ({
    panesOnScreen: () => ({
      editor: editorVisible,
      agents: hasExtent(agentsContainer),
      terminal: hasExtent(terminalContainer),
    }),
    bringBackPane: (pane) => {
      switch (pane) {
        case 'editor':
          return;
        case 'agents':
          if (agentsColumnPresent) bringBackRailColumn(agentsPreferredWidthPxRef.current);
          return;
        case 'terminal':
          if (terminalPlacement === 'right') {
            if (terminalColumnPresent) {
              terminalCollapsedByUserRef.current = false;
              bringBackRailColumn(terminalWidthPxRef.current);
            }
          } else {
            terminalDockRef.current?.bringBackBottom();
          }
          return;
        default:
          return assertNeverPaneId(pane);
      }
    },
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
    assertRightRailLayout(true);
    setDocPanelCover(true);
  }

  function togglePanel() {
    if (!docPanelToggleable()) return;
    revealEditorBeforeActing();
    if (docPanelCover || (!isCollapsedRef.current && docPanelIntentOpen)) {
      writeDocPanelIntent(false);
      assertRightRailLayout(true);
      if (docPanelCover) dismissDocPanelCover();
      return;
    }
    expandDocPanel(true);
  }

  const outerLayoutChangedRef = useRef(false);
  const lastEditorColumnPxRef = useRef<number | null>(null);
  function noteOuterLayout(layout: Record<string, number>) {
    const { residualId } = accountRailLayout(Object.keys(layout));
    const outerPx = resolveGroupPxWidth();
    const editorColumnPx =
      residualId == null || outerPx == null ? null : ((layout[residualId] ?? 0) / 100) * outerPx;
    const previousPx = lastEditorColumnPxRef.current;
    lastEditorColumnPxRef.current = editorColumnPx;
    if (
      editorColumnPx == null ||
      previousPx == null ||
      Math.abs(editorColumnPx - previousPx) > 0.5
    ) {
      outerLayoutChangedRef.current = true;
    }
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

  useEffect(() => {
    if (groupContainerEl == null || innerContainerEl == null) return;
    if (isEmbedded) return;
    const replanAndAdmit = () => {
      assertRightRailLayoutRef.current(isCollapsedRef.current);
      enforceRightRailAdmissionRef.current('resize', admissionVisibilityRef.current);
    };
    const outerObserver = new ResizeObserver(replanAndAdmit);
    const docPanel = innerContainerEl.querySelector<HTMLElement>(`#${DOC_PANEL_ID}`);
    let docSettlementFrame = 0;
    const innerObserver = new ResizeObserver((entries) => {
      if (entries.some((entry) => entry.target === docPanel)) {
        if (docSettlementFrame === 0) {
          docSettlementFrame = requestAnimationFrame(() => {
            docSettlementFrame = 0;
            settleObservedDocWidth();
          });
        }
        if (entries.every((entry) => entry.target === docPanel)) return;
      }
      if (outerLayoutChangedRef.current) {
        outerLayoutChangedRef.current = false;
        if (railPinOutcomeRef.current.stage === 'pinned') return;
      }
      replanAndAdmit();
    });
    outerObserver.observe(groupContainerEl);
    innerObserver.observe(innerContainerEl);
    if (docPanel != null) innerObserver.observe(docPanel);
    return () => {
      outerObserver.disconnect();
      innerObserver.disconnect();
      if (docSettlementFrame !== 0) cancelAnimationFrame(docSettlementFrame);
      cancelRailLayoutRetry(observedDocWidthRetryRef);
    };
  }, [groupContainerEl, innerContainerEl, isEmbedded]);

  useEffect(() => {
    if (fileListSlotEl == null) return;
    const observer = new ResizeObserver(() => {
      if (admissionDeferredByFilesRef.current == null) return;
      enforceRightRailAdmissionRef.current('resize', admissionVisibilityRef.current);
    });
    observer.observe(fileListSlotEl);
    return () => observer.disconnect();
  }, [fileListSlotEl]);

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
                  isPanelCollapsed={isCollapsed && !docPanelCover}
                  onTogglePanel={togglePanel}
                  onDestinationComplete={completeDocPanelDestination}
                  onDestinationFailed={reportCoveredDiffFailure}
                />
              </Suspense>
            ) : null}
            {}
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
          {}
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
  const workspaceHeaderChrome: WorkspaceHeaderChrome = {
    trailing: showDocPanelToggle ? (
      <DocPanelToggle
        isPanelCollapsed={!docPanelOnScreen}
        onTogglePanel={togglePanel}
        panelId={docPanelCover ? 'doc-panel-cover' : DOC_PANEL_ID}
      />
    ) : null,
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
    if (isCollapsedRef.current !== collapsed) assertRightRailLayoutRef.current(collapsed);
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

  useLayoutEffect(() => {
    const docSlotPresenceChanged = docSlotPresentRef.current !== docSlotPresent;
    docSlotPresentRef.current = docSlotPresent;
    docSlotHeldForLoadRef.current = docSlotHeldForLoad;
    if (!docSlotPresenceChanged) return;
    runRailLayoutRetry({
      retryRef: presenceRepinRetryRef,
      attempt: () => attemptRailLayout(isCollapsedRef.current),
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

  const docSlot = (
    <>
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
      <ResizablePanel
        id={DOC_PANEL_ID}
        role="region"
        aria-label={t`Document panel`}
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
            adoptDraggedDocPanelWidth(size.inPixels);
            debouncedWriteDocPanelWidth(size.inPixels);
          }
          reclaimHiddenRailColumn(DOC_PANEL_ID, docSlotPresent, size.inPixels);
        }}
        inert={!docSlotPresent || isCollapsed}
        className={cn('flex flex-col', SECONDARY_PANEL_SURFACE_CLASS)}
      >
        <div ref={docPanelDockRef} className="flex h-full min-h-0 w-full flex-col" />
      </ResizablePanel>
    </>
  );

  const chatAlone = !editorVisible && agentsShowing && !terminalShowing;
  const nothingOpen = !editorVisible && !agentsVisible && !terminalVisible;
  const terminalHandleShown = terminalColumnPresent && editorVisible;
  const agentsHandleShown = agentsColumnPresent && (editorColumnHoldsPane || terminalColumnPresent);

  const rightTerminalMount = (
    <div
      ref={setRightTerminalContainer}
      data-terminal-panel-mount=""
      inert={!terminalColumnPresent || (terminalColumnCollapsed && !terminalShowingHold)}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    />
  );

  const terminalColumn = (
    <>
      <ResizableHandle
        data-terminal-panel-handle=""
        aria-controls={TERMINAL_COLUMN_ID}
        aria-label={t`Resize terminal`}
        withHandle={terminalHandleShown}
        className={cn(
          paneCardDividerClass(cardVariant, 'vertical'),
          !terminalHandleShown && 'pointer-events-none',
        )}
        style={terminalHandleShown ? undefined : { display: 'none' }}
        onPointerDown={(event) => {
          beginTerminalHandleDrag(event.pointerId);
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
          if (
            size.inPixels === 0 &&
            document.activeElement?.hasAttribute('data-terminal-panel-handle')
          ) {
            terminalCollapsedByUserRef.current = true;
          }
          if (
            size.inPixels > 0 &&
            isDraggingTerminalHandleRef.current &&
            editorVisibleRef.current
          ) {
            terminalWidthPxRef.current = size.inPixels;
            debouncedWriteTerminalWidth(size.inPixels);
          }
          setTerminalColumnCollapsed(size.inPixels === 0);
          if (size.inPixels > 0) terminalCollapsedByUserRef.current = false;
          if (size.inPixels === 0 && isDraggingTerminalHandleRef.current) {
            setTerminalShowingHold(true);
          } else if (size.inPixels > 0 && !isDraggingTerminalHandleRef.current) {
            setTerminalShowingHold(false);
          }
          reclaimHiddenRailColumn(TERMINAL_COLUMN_ID, terminalColumnPresent, size.inPixels);
        }}
        className="flex flex-col"
        style={{ overflow: 'visible' }}
      >
        {terminalAvailable ? (
          <PaneCard
            pane="terminal"
            variant={cardVariant}
            data-placement="right"
            className={cn(!rightTerminalCardShowing && 'shadow-none')}
            style={{
              marginInlineStart: terminalCardInsets.start,
              marginInlineEnd: terminalCardInsets.end,
            }}
          >
            {rightTerminalMount}
          </PaneCard>
        ) : (
          rightTerminalMount
        )}
      </ResizablePanel>
    </>
  );

  const agentsColumn = (
    <>
      <ResizableHandle
        withHandle={agentsHandleShown}
        aria-controls={terminalColumnPresent ? TERMINAL_COLUMN_ID : AGENTS_COLUMN_ID}
        aria-label={terminalColumnPresent ? t`Terminal` : t`Agents`}
        data-agents-panel-resize-handle=""
        className={cn(
          paneCardDividerClass(cardVariant, 'vertical'),
          !agentsHandleShown && 'pointer-events-none',
        )}
        style={agentsHandleShown ? undefined : { display: 'none' }}
        onPointerDown={(event) => {
          beginAgentsHandleDrag(event.pointerId);
        }}
      />
      <ResizablePanel
        id={AGENTS_COLUMN_ID}
        panelRef={agentsColumnPanelRef}
        defaultSize={agentsColumnPresent ? `${initialAgentsWidthPx}px` : 0}
        minSize="0px"
        maxSize={agentsColumnPresent ? (editorColumnHoldsPane ? '95%' : '100%') : '0px'}
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
        style={{ overflow: 'visible' }}
      >
        <PaneCard
          pane="agents"
          variant={cardVariant}
          className={cn(
            !agentsVisible && 'invisible',
            !(agentsColumnPresent && !agentsColumnCollapsed) && 'shadow-none',
          )}
          inert={!agentsVisible}
          style={{ marginInlineStart: agentsCardInsetStartPx }}
        >
          <section
            ref={setAgentsContainer}
            data-agents-panel-mount=""
            data-chat-alone={chatAlone ? '' : undefined}
            aria-label={t`Agent panel`}
            inert={!agentsColumnPresent || (agentsColumnCollapsed && !agentsShowingHold)}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          />
        </PaneCard>
      </ResizablePanel>
    </>
  );

  const railColumnMinSize = resizableRailColumnPresent ? '5%' : '30%';
  const editorColumnMinSize = editorColumnHoldsPane ? railColumnMinSize : '0%';
  const workspaceAbsorbsResidual = docSlotPresent && !initialRightCollapsed;
  const outerRowDragging = isDraggingTerminalHandle || isDraggingAgentsHandle;
  const workspaceHeaderTarget = (
    <div
      ref={setWorkspaceHeaderContainer}
      data-editor-area-header=""
      className={cn('relative z-30 shrink-0', (filesCover || docPanelCover) && 'invisible')}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {noteWindow ? workspaceHeaderTarget : null}
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
          data-editor-row="outer"
          style={{ overflow: 'visible' }}
          onLayoutChange={(layout) => {
            noteOuterLayout(layout);
            if (railPlanWriteInProgressRef.current) return;
            adoptLibraryDrag('outer');
            if (isDraggingTerminalHandleRef.current || isDraggingAgentsHandleRef.current) {
              followOuterLayout(layout);
            }
          }}
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction) followOuterLayout(layout);
            settleAgentsKeyboardLayout(layout, meta.isUserInteraction);
          }}
          data-dragging={outerRowDragging || undefined}
        >
          <ResizablePanel
            minSize={editorColumnMinSize}
            {...(resizableRailColumnPresent ? {} : { defaultSize: '100%' })}
            className="flex flex-col"
            style={{
              paddingInlineEnd: editorColumnChromePx,
              overflow: editorVisible && editorCardPin == null ? 'visible' : 'hidden',
            }}
          >
            <TerminalDock
              ref={terminalDockRef}
              editorVisible={editorVisible}
              onBottomCollapsedChange={setBottomTerminalCollapsed}
              placement={terminalPlacement}
              visible={terminalVisible}
              available={terminalAvailable}
              variant={cardVariant}
              onVisibleChange={onTerminalVisibleChange ?? (() => {})}
              onBottomContainer={setBottomTerminalContainer}
            >
              <PaneCard
                ref={editorCardRef}
                pane="editor"
                variant={cardVariant}
                className={editorVisible ? 'flex-row' : 'invisible flex-row'}
                inert={!editorVisible}
                data-editor-hidden={editorVisible ? undefined : ''}
                style={
                  editorCardPin == null
                    ? undefined
                    : { width: editorCardPin.width, height: editorCardPin.height, flex: 'none' }
                }
              >
                {fileListHost != null ? (
                  <div
                    data-editor-file-list-slot=""
                    inert={docPanelCover}
                    className="relative flex shrink-0"
                    ref={fileListSlotRef}
                  />
                ) : null}
                <SidebarInset
                  inert={docPanelCover || filesCover}
                  className="min-w-0 overflow-hidden"
                >
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
                      onLayoutChange={() => {
                        if (railPlanWriteInProgressRef.current) return;
                        adoptLibraryDrag('inner');
                      }}
                      onLayoutChanged={(layout, meta) => {
                        settleAgentsKeyboardLayout(layout, meta.isUserInteraction);
                      }}
                      data-dragging={isDraggingDocHandle || undefined}
                    >
                      <ResizablePanel
                        minSize={
                          docSlotPresent && !isCollapsed ? `${DOC_USABLE_MIN_WIDTH_PX}px` : '0%'
                        }
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
                      {docSlot}
                    </ResizablePanelGroup>
                  </div>
                </SidebarInset>
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
                        <TooltipContent
                          side="bottom"
                          sideOffset={8}
                        >{t`Hide panel`}</TooltipContent>
                      </Tooltip>
                    </div>
                    <div ref={docPanelCoverRef} className="min-h-0 flex-1" />
                  </section>
                ) : null}
              </PaneCard>
            </TerminalDock>
          </ResizablePanel>
          {terminalColumn}
          {agentsColumn}
        </ResizablePanelGroup>
        {nothingOpen ? <NothingOpen /> : null}
      </div>
      {createPortal(docSlotContent, docPanelHost)}
    </div>
  );
}
