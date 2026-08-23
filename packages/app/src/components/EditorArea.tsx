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

// The edit-in-place banner only mounts for a detected-skill buffer, so keep it
// (and the Manage-adopt flow it pulls in) out of the eager editor bundle.
const SkillEditBanner = lazy(async () => ({
  default: (await import('@/components/SkillEditBanner')).SkillEditBanner,
}));

// The two config-file editors render only when a `.markdownlint.*` or
// `*.schema.json` file is opened — rare next to ordinary document editing — so
// they stay out of the main chunk rather than loading for every session.
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
  // Missing required properties have no property row or body anchor, so the
  // pane toolbar is the only always-present surface that can report them.
  const { data: frontmatterLintConfig } = useDocLintConfig(docName);
  // Source mode has no Add-properties button, so avoid linting every keystroke
  // for diagnostics that cannot render there.
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
      // Only threaded where the deck action can actually run. This toolbar is
      // rendered per visible document from inside the Activity pool, so it is
      // one of the hottest render paths in the editor; handing it a live
      // provider on hosts that can never mount the Slidev action changed that
      // path's behaviour enough to destabilise unrelated editor e2e (lint
      // decorations and CRDT content assertions), which a three-round CI bisect
      // pinned to exactly this prop. Web and CLI hosts keep the prop surface
      // they had before the plugin existed.
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

// The full-pane version diffs are overlays that only paint on user action (open
// a Timeline/agent diff), so they're code-split off the eager editor bundle —
// this keeps the rendered-diff engine + `prosemirror-recreate-transform` out of
// the main chunk (size-limit budget). Their sync `computeRenderedDiff` stays
// intact inside the lazily-loaded pane.
const LazyTimelineDiffPane = lazy(async () => {
  const mod = await import('@/components/TimelineDiffPane');
  return { default: mod.TimelineDiffPane };
});
const LazyAgentDiffPane = lazy(async () => {
  const mod = await import('@/components/AgentDiffPane');
  return { default: mod.AgentDiffPane };
});

// Sizing for the permanent document slot. Its content varies by view; these
// bounds do not.
const DOC_PANEL_MIN_WIDTH_PX = 300;
const DOC_PANEL_MIN_SIZE = `${DOC_PANEL_MIN_WIDTH_PX}px`;
const DOC_PANEL_MAX_SIZE = '600px';

/**
 * Where + whether ONE session panel should attach right now. EditorArea computes
 * this (it knows the view kind and the mount containers) and reports it UP to
 * EditorPane, which owns the long-lived session hosts. The hosts are mounted
 * above EditorArea so a view-kind change (which remounts EditorArea's subtree)
 * can't re-spawn a PTY — the VS Code / Zed pattern of owning the terminal above
 * the layout and re-attaching the view.
 */
interface SessionPanelPlacement {
  /** The DOM container to portal that panel's live sessions into. */
  readonly container: HTMLElement | null;
  /** Whether the panel is on screen (drives focus). */
  readonly isShowing: boolean;
}

/** Both panels' placements plus the shared focus-return target, reported in one
 *  callback so EditorPane takes a single state update per layout change. */
export interface SessionPlacements {
  readonly terminal: SessionPanelPlacement;
  readonly agents: SessionPanelPlacement;
  /** Focus target for returning focus to the editor when a panel hides. */
  readonly editorRegion: HTMLElement | null;
}

interface EditorAreaProps {
  editorMode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  activeTab: PanelTab;
  onActiveTabChange: (tab: PanelTab) => void;
  /**
   * Desktop bridge for the docked terminal — `null` on the web host (no shell).
   * When present, the terminal docks under the editor via `TerminalDock`'s
   * vertical split. The live session host is owned by EditorPane and portals into
   * the container this component renders, so the PTY survives tab switches and
   * view-kind changes. State is owned by EditorPane and threaded down via these
   * props.
   */
  terminalBridge?: OkDesktopBridge | null;
  terminalVisible?: boolean;
  terminalPlacement?: TerminalPlacement;
  terminalRightWidth?: number;
  onTerminalVisibleChange?: (visible: boolean) => void;
  onTerminalRightWidthChange?: (width: number) => void;
  /** Agents-panel visibility. Its own resizable column to the right of the
   * document side pane. Independent of the terminal. */
  agentsVisible?: boolean;
  onAgentsVisibleChange?: (visible: boolean) => void;
  /** Report both panels' attach points to the session hosts owned by EditorPane. */
  onSessionPlacements?: (placements: SessionPlacements) => void;
  /** Reveal the agents panel from its right-edge affordance. */
  onRevealAgents?: () => void;
  renderWorkspaceHeader?: (tabs: ReactNode) => ReactNode;
}

function renderTabsWithoutHeader(tabs: ReactNode): ReactNode {
  return tabs;
}

export function EditorArea(props: EditorAreaProps) {
  return (
    <ProfilerBoundary name="editor-area">
      {/* PropertyProvider scopes the cross-tree property-panel signal bus
          to the editor surface — both the toolbar (button → dispatcher)
          and EditorActivityPool's PropertyPanel mounts (consumers) live
          underneath. Replaces the prior `BEGIN_ADD_EVENT` window event,
          whose global broadcast leaked across hidden Activity boundaries. */}
      <PropertyProvider>
        <EditorAreaInner {...props} />
        <SettingsDialogPortal />
      </PropertyProvider>
    </ProfilerBoundary>
  );
}

/**
 * Mounts the Settings dialog as a sibling overlay (Radix portal). Owns
 * the route subscription so EditorAreaInner doesn't have to thread
 * settings state through its render branches.
 *
 * The shell is synchronously imported so it lives in the main chunk
 * and mounts on initial render — when `open` flips to true the Dialog
 * primitive's portal content paints on the same frame as the trigger
 * (sidebar + content skeleton), and the heavy body chunk loads behind
 * the shell's own non-null Suspense fallback. The shell renders
 * trivially when closed (Radix Dialog's `Presence` short-circuits, the
 * body chunk is never fetched until first open), so eager-mounting is
 * cheap.
 *
 * `useSettingsRoute` wraps its open-state flip in `startTransition` so
 * on warm reopens — when the body chunk is already cached — React
 * commits the resolved tree directly with no Suspense fallback flash.
 * The user-scope ConfigBinding stays warm for the session via
 * ConfigProvider, so reopens are flash-free end-to-end.
 */
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
  // Latches true once any provider has been active this session. It separates a
  // genuine cold start (group never mounted, no docked terminal alive yet) from
  // a mid-session navigation whose provider is transiently null — closing a tab
  // or switching to a not-yet-ready doc. Only the latter must keep the
  // persistent workspace column mounted so the docked terminal PTY survives.
  const [everHadProvider, setEverHadProvider] = useState(false);
  useEffect(() => {
    if (activeProvider != null && !everHadProvider) setEverHadProvider(true);
  }, [activeProvider, everHadProvider]);
  // Shell-snap decoupling: `activeDocName` updates urgently across the tree
  // (sidebar aria-current, header title, tab panels — all read the urgent
  // value via `useDocumentContext`). The editor subtree, however, pays a
  // heavy render cost on nav to mark-heavy / oversize docs — TipTap's
  // create-view + per-mark reconciliation can block the main thread for
  // 1-3s on docs above `BYTES_CACHE_THRESHOLD` (which refuse V2 cache
  // admission, forcing a fresh `new Editor()` on every warm visit).
  // Wrapping with `useDeferredValue` lets React commit the shell render
  // first (aria-current + header snap to the new doc) and defer the
  // editor-subtree re-render to a low-priority pass, letting the browser
  // paint the updated shell before the editor mount cost begins. The
  // shell-snap budget is ~250ms.
  const deferredActiveDocName = useDeferredValue(activeDocName);
  const isSourceMode = editorMode === 'source';
  const isNewDoc = activeTarget?.kind === 'missing';
  const showStats = !!activeDocName && activeTarget?.kind !== 'folder';
  const editorPlaceholder = isNewDoc ? t`Start writing to create this page` : undefined;
  // Full-pane version diff (opened from the Timeline panel). Painted as an
  // overlay over the editor below; closed when the open doc changes since a
  // version belongs to one doc and must never paint over an unrelated one.
  const timelineDiff = useTimelineDiffView();
  useEffect(() => {
    if (timelineDiff && timelineDiff.docName !== activeDocName) closeTimelineDiff();
  }, [activeDocName, timelineDiff]);
  // Full-pane agent-edit diff (opened from the Agent Activity panel). Same
  // overlay slot as the timeline diff. Unlike the timeline (always the open
  // doc), the agent's edits can span other files and the pane steps through
  // them, so EditorArea drives navigation: whenever the current edit's doc
  // changes (open or step), navigate the editor to it. `agentDiffNavTargetRef`
  // holds that in-flight target so the close-on-nav-away effect keeps the pane
  // through the transition, then closes it only on a genuine navigation away.
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
      agentDiffNavTargetRef.current = null; // arrived — nav settled
      return;
    }
    // Still navigating toward the current edit's doc — keep the pane mounted.
    if (agentDiffNavTargetRef.current === agentDiffDoc) return;
    closeAgentDiff();
  }, [activeDocName, agentDiffDoc]);
  // The full-pane agent diff only makes sense while the Agent Activity panel is
  // open. When the panel is exited — "Back to document view" flips docPanelMode
  // to 'doc', or the agent is deselected — dismiss the overlay so the editor
  // returns to the plain document instead of stranding the reader in the diff.
  // Covers every exit path, not just the back button (mode toggle, deselect).
  useEffect(() => {
    const agentPanelOpen = docPanelMode === 'agent' && docPanelAgentId !== null;
    if (!agentPanelOpen) closeAgentDiff();
  }, [docPanelMode, docPanelAgentId]);
  // A share-receive navigation that resolved to a missing target renders an
  // honest verdict panel instead of the create-mode editor, so a receiver can't
  // silently fork the doc at the shared path. A plain missing target — an
  // ordinary wiki-link create-on-navigate — leaves this null and keeps
  // create-mode reachable.
  const pendingReceiveNav = useSyncExternalStore(
    pendingReceiveNavStore.subscribe,
    pendingReceiveNavStore.getSnapshot,
    pendingReceiveNavStore.getSnapshot,
  );
  const shareReceiveMiss = matchesShareReceiveMiss(activeTarget, pendingReceiveNav);

  const [embeddedHost] = useState(() => detectEmbeddedHostFromBrowser());
  // Derive from the cached `embeddedHost` instead of calling
  // `useIsEmbedded()` (which would re-run `detectEmbeddedHostFromBrowser()`
  // a second time on mount — both are lazy-initializer stable, but the
  // double-detect was pure waste).
  const isEmbedded = embeddedHost !== null;
  const [rightPartition, setRightPartition] = useState(() =>
    resolvePartition(embeddedHost, window.innerWidth, 'right'),
  );
  // Read in callbacks (togglePanel, ResizeObserver) so we always see the live
  // partition value even if togglePanel is re-bound from an effect that hasn't
  // re-subscribed with the latest closure yet. Mirrors the openRef pattern.
  const rightPartitionRef = useRef(rightPartition);
  useEffect(() => {
    rightPartitionRef.current = rightPartition;
  }, [rightPartition]);
  const panelRef = usePanelRef();
  // Independent ref for the agents column (MD | PANE | AGENTS). Bound only while
  // each resizable rail column is mounted; the sticky-width correction pins them
  // the same way it pins the doc panel.
  const agentsColumnPanelRef = usePanelRef();
  const terminalColumnPanelRef = usePanelRef();
  const [initialRightCollapsed] = useState(() => {
    const pins = readPins();
    return resolveEffectiveState('right', rightPartition, pins) === 'collapsed';
  });
  const [isCollapsed, setIsCollapsed] = useState(initialRightCollapsed);
  // Ref mirror so the ResizeObserver callback can gate without re-creating
  // the observer on every isCollapsed flip.
  const isCollapsedRef = useRef(isCollapsed);

  // The agents panel's mount point — a dedicated column to the right of the doc
  // panels (MD | PANE | TERMINAL | AGENTS), present across EVERY view kind (the
  // columns just have no doc panel beside them on asset / large-file / empty views).
  const [agentsContainer, setAgentsContainer] = useState<HTMLDivElement | null>(null);
  const [rightTerminalContainer, setRightTerminalContainer] = useState<HTMLDivElement | null>(null);
  // The global editor header sits above the complete horizontal workspace so
  // every right-side panel begins below it. EditorWorkspace owns the tab DnD
  // context, so it portals the rendered header into this mount instead of
  // nesting it inside the editor-width panel.
  const [workspaceHeaderContainer, setWorkspaceHeaderContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [workspaceColumnEl, setWorkspaceColumnEl] = useState<HTMLDivElement | null>(null);
  // The bottom-dock mount + the editor-region focus target, reported up by
  // TerminalDock (the bottom shell). The terminal host portals into the container
  // and both hosts return focus to the editor region when they hide.
  const [bottomTerminalContainer, setBottomTerminalContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [terminalEditorRegion, setTerminalEditorRegion] = useState<HTMLDivElement | null>(null);

  // Placements are computed early (before the view branches) so they can be
  // reported up to EditorPane regardless of which branch renders.
  //
  // Whether the far-right agents column participates in the panel group this
  // render. Drives the panel-set-change layout assert below and the collapsed
  // doc-panel neutralization — compute it up here so effects can depend on it.
  // Keyed off visibility rather than has-tabs so the panel's feedback is
  // immediate during the seconds-long agent spawn.
  const agentsColumnPresent = !noteWindow && agentsVisible;
  const terminalColumnPresent = !noteWindow && terminalVisible && terminalPlacement === 'right';
  const resizableRailColumnPresent = terminalColumnPresent || agentsColumnPresent;
  // The agents panel is the one surface with a persistent edge affordance: it is
  // discoverable in a way a chord is not, and an agent conversation is the thing a
  // user is most likely to want back. Ungated on having conversations — an empty
  // panel opens on its New button, which is a fine cold entry.
  //
  // The terminal has NO reveal tab. It is a developer surface reached by ⌘J (and
  // the View menu), and a second permanent tab hovering over the editor footer's
  // bottom-right was clutter competing with the Ask AI composer for that corner.
  const rightRevealTabPresent = !noteWindow && !agentsVisible && onRevealAgents != null;
  const terminalContainer =
    terminalPlacement === 'right' ? rightTerminalContainer : bottomTerminalContainer;
  const terminalShowing = terminalVisible && terminalContainer != null;
  const agentsShowing = agentsColumnPresent && agentsContainer != null;
  // Report the attach points up to EditorPane (which owns the long-lived session
  // hosts). EditorArea only says where to attach — the VS Code / Zed pattern of
  // owning the terminal above the layout that changes.
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
  // Ref mirror so the ResizeObserver callback can skip while the user is
  // actively dragging (would otherwise race the in-flight drag).
  const isDraggingDocHandleRef = useRef(false);

  // Sticky pixel width for the right doc-panel. The library is percent-based
  // internally; without correction the panel would grow proportionally with
  // the container. We track the user's last-set pixel width in a ref and
  // re-apply it via `panelRef.resize("Npx")` whenever the container resizes
  // (window resize, left sidebar collapse). Persisted to localStorage so the
  // value survives reload.
  //
  // Pattern: `useState` lazy initializer snapshots the initial pixel width
  // (read once at mount, stable across renders — React Compiler forbids reading
  // refs during render, so we cannot use `docPanelWidthPxRef.current` in the
  // `defaultSize` JSX below). The ref carries the running value updated by
  // `onResize` during user drag; only callbacks/effects read it.
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

  // The agents column carries the same sticky-pixel-width treatment as the doc
  // panel — its own persisted width, drag-tracking ref, and RO-pin — so it does
  // not grow proportionally when the container widens.
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

  // Group container element — the ResizeObserver target. Container width
  // changes when the WINDOW resizes or the LEFT sidebar collapses/expands; it
  // does NOT change when the right doc-panel collapses (that's internal flex
  // redistribution). State-callback ref (not useRef) so the RO effect re-runs
  // when the element mounts — early returns for skeleton/empty-state mean the
  // ref isn't attached until the main JSX renders, and useRef wouldn't notify.
  const [groupContainerEl, setGroupContainerEl] = useState<HTMLDivElement | null>(null);
  // Plain-ref mirror for callbacks created before the element mounts (event
  // subscribers with narrow deps would otherwise close over the initial null).
  const groupContainerElRef = useRef<HTMLDivElement | null>(null);

  // Tabs still follow the editor workspace width while the global actions stay
  // pinned to the window edge. ResizeObserver updates the CSS width throughout
  // a live panel drag, avoiding the lag that an onResize/React-state round trip
  // would introduce.
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

  // Whether the active view has a right document pane at all. The slot itself is
  // a permanent rail member; this is whether it has anything to show. Written by
  // an effect declared after the branch chain that decides it (see the note
  // there); declared up here because the rail functions below read it, and the
  // compiler rejects a reference that sits above its declaration.
  const docSlotPresentRef = useRef(false);
  // Pending-frame handle for the presence re-pin's bounded retry (declared with
  // the presence ref for the same declaration-order reason; the retry itself
  // lives in the presence effect below).
  const presenceRepinFrameRef = useRef(0);

  // Group-level imperative handle. Layout corrections MUST go through
  // `setLayout` (the whole layout in one shot): the per-panel imperative APIs
  // (`resize`/`collapse`/`expand`) always exchange space with the panel's flex
  // NEIGHBOR, and in the EDITOR | doc-panel | agents-column order that
  // neighbor is never the editor — a doc-panel collapse dumps its width into
  // the agents column, and re-pinning it hands the width right back to the doc
  // panel. Only a full-layout write can route deltas to the editor. The layout
  // math lives in `computeStickyRepinLayout` (unit-tested).
  const groupRef = useGroupRef();
  // Pixel basis for px→% conversion in `assertRightRailLayout`. Layout
  // percentages are relative to the group's panel space; derive the basis from
  // a panel whose percentage and pixel width are both known (immune to the
  // separator widths the container includes), falling back to the container.
  function resolveGroupPxWidth(): number | null {
    for (const ref of [panelRef, terminalColumnPanelRef, agentsColumnPanelRef]) {
      const size = ref.current?.getSize();
      // The `> 1` floor excludes collapsed/near-zero panels: px / ~0% diverges
      // (Infinity at exactly 0), which would corrupt every layout assertion
      // built on the basis.
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
      // The slot is in every layout now, so membership says nothing about
      // whether this view HAS a document pane — read the content predicate.
      if (!docSlotPresentRef.current) {
        return { workspaceWidthPx, otherRailWidthPx: 0 };
      }
      // A collapsed document pane still counts, at its floor. It measures zero
      // right now, but the user can reopen it at any moment — and reopening
      // needs a whole 300px to appear from somewhere. Admitting both session
      // columns on the strength of that zero produces a rail where no panel can
      // spare 300px: the pane cannot come back, and the separators on either
      // side of it have no legal move in either direction. Counting it at its
      // floor is what keeps the rail one the user can still work.
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

  // The single rail-layout primitive: pin every rail column to the pixel width
  // its visibility calls for — zero when shut — and let the EDITOR absorb the
  // remainder.
  //
  // It has to be a whole-group `setLayout`. The per-panel `collapse()` /
  // `expand()` / `resize()` are implemented as a simulated drag of the panel's
  // ADJACENT separator, so they trade with whichever rail column happens to sit
  // beside the one being changed — and when that neighbour is itself shut, it
  // has no width to give and the call silently does nothing at all. Writing the
  // layout takes the width from the editor instead, which is also what the rail
  // promises: every rail change trades with the editor, never with another rail.
  //
  // What made this unsafe before was not `setLayout` but the panel set moving
  // underneath it — columns mounting and unmounting, so a fresh panel joined an
  // already-full group and got whatever was left. The columns are permanent
  // now, and a shut one is simply a zero-width member.
  function applyRailLayout(docCollapsed: boolean): boolean {
    const group = groupRef.current;
    if (group == null) return false;
    // Only the library calls are guarded: the imperative handles throw once
    // their group has unregistered, and this can run from a deferred callback
    // racing a view-kind remount. The layout math between them is ours —
    // swallowing its errors would hide a real bug behind a silent no-op.
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
    // The preferred widths did not fit. Retry with every open column at its
    // floor rather than leaving the rail as it was: giving up here is what
    // opened a column the app believes is visible at zero width, with a live
    // handle that can move nothing.
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
    // `setLayout` validates against the store's derived panel constraints, and
    // those refresh only when the GROUP next re-renders after a Panel
    // re-registers — a constraint prop that changed in this very commit
    // (`maxSize` flipping off its '0px' clamp, `defaultSize` moving) is not
    // visible to a write issued from this commit's layout effects. The library
    // then clamps the write against the stale constraints and reports nothing:
    // the call "succeeds" while the rail keeps its old widths. Read the layout
    // back and compare each pinned column so callers with a retry loop can see
    // the rejection and re-apply once the group has settled. The 1px tolerance
    // absorbs basis drift between our px→% conversion and the library's own
    // group-size basis.
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

  // A hidden column must stay at zero width, and pinning it once is not enough:
  // the library redistributes space across the whole group on any drag, and a
  // collapsed member can be handed width by a drag that never touched it. Left
  // there, the rail carries a column the app believes is closed — no admission
  // check counts it, no toggle owns it, and it silently eats the editor until
  // nothing on the rail can move. Snapping it back the moment it grows keeps
  // "hidden" and "zero width" the same fact.
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
        // The group can unregister between the queued callback and this read.
        reportUnexpectedPanelGroupFailure('reclaim-hidden-rail-read-failed', error);
        return;
      }
      if (containerPx == null || !(columnId in layout) || layout[columnId] === 0) return;
      const residualId = findResidualPanelId(Object.keys(layout));
      if (residualId == null) return;
      // Zero only the offending column and hand its width to the editor. A
      // whole-rail re-pin here would also snap the other columns back to their
      // persisted widths, undoing the very drag that displaced this one.
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
        // The group can unregister between the read and the write.
        reportUnexpectedPanelGroupFailure('reclaim-hidden-rail-write-failed', error);
      }
    });
  }

  // Returns whether the rail verifiably holds the asserted layout — false when
  // the write was rejected (see the read-back check in `applyRailLayout`) so
  // callers with a retry loop can re-apply. A live drag returns true: the drag
  // owns the layout and retrying against it would fight the pointer.
  function assertRightRailLayout(docCollapsed: boolean): boolean {
    if (
      isDraggingDocHandleRef.current ||
      isDraggingTerminalHandleRef.current ||
      isDraggingAgentsHandleRef.current
    )
      return true;
    // Record the intent before applying it. The write changes panel widths,
    // which fires the ResizeObserver below synchronously — and that re-asserts
    // from this ref, which React's own state effect has not caught up to yet.
    // Without this the correction would immediately undo itself.
    isCollapsedRef.current = docCollapsed;
    return applyRailLayout(docCollapsed);
  }

  // Latest-ref mirror of the assert for effects that must NOT re-run on render
  // (the ResizeObserver below re-fires on `observe()` — recreating it per
  // render would re-assert the layout on every render instead of only on
  // container resizes). Event-listener effects re-subscribe instead (cheap, no
  // initial-fire semantics); mirrors the codebase's openRef pattern.
  const assertRightRailLayoutRef = useRef(assertRightRailLayout);
  useEffect(() => {
    assertRightRailLayoutRef.current = assertRightRailLayout;
  });

  // Drag-end plumbing shared by the doc-panel and agents-column handles.
  //
  // A drag ends on `pointerup` OR `pointercancel`. A cancelled pointer fires
  // NO pointerup — once the browser suppresses a pointer stream (touch
  // pan/zoom/scroll takeover, or the OS invalidating the pointer) no further
  // events arrive for that pointerId. Binding only `pointerup` leaves the drag
  // flag set, and `assertRightRailLayout` bails while either flag is set — so
  // the doc-panel toggle, ⌥⌘B, the avatar-click expand and the sticky-width
  // re-pin all silently stop working, and `onResize` starts misreading re-pins
  // as user drags and overwriting the persisted width.
  //
  // Deliberately NOT bound: `lostpointercapture`. react-resizable-panels
  // re-acquires capture on every pointermove that lacks it, so capture loss is
  // routine mid-drag; treating it as a drag end would clear the flag under a
  // live drag — the race the flag exists to prevent. A separator that unmounts
  // mid-drag is already covered without it: capture releases implicitly and
  // the eventual pointerup retargets by hit-test and still reaches `window`.
  //
  // `onCommit` runs only on a real release: an aborted gesture must not commit
  // a drag-to-close.
  //
  // Both listeners are scoped to the `pointerId` that started the drag. A
  // second touch elsewhere on the page can be taken over by the browser for
  // scrolling, which fires `pointercancel` for THAT pointer while this drag is
  // still live; unscoped, it would end the drag and re-pin the rail mid-gesture
  // (the panel visibly snapping to its persisted width). Mirrors the existing
  // scoping in GraphView's pointer-drag handler.
  const endHandleDragRef = useRef<(() => void) | null>(null);
  function trackHandleDrag(
    pointerId: number,
    setDragging: (dragging: boolean) => void,
    draggingRef: { current: boolean },
    onCommit?: () => void,
  ) {
    // A prior gesture that never saw a release would otherwise leave its own
    // flag set forever. Clears whichever handle owned it, not just this one.
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
      // Restore both rail pins. A column the aborted drag had snapped shut
      // would otherwise sit at zero width while still counting as visible —
      // no reveal tab, no handle, no way back.
      assertRightRailLayoutRef.current(isCollapsedRef.current);
    }
    endHandleDragRef.current = end;
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }
  // Unmounting mid-drag (a view-kind switch under an active drag) would strand
  // both window listeners on a component React has already torn down.
  useEffect(() => () => endHandleDragRef.current?.(), []);

  // A rail column's visibility is a width, not a mount: both columns are
  // permanent members of the group, so "hidden" is simply zero width.
  function syncRailColumns(): boolean {
    // A live drag owns the layout; correcting under it would fight the pointer.
    if (
      isDraggingDocHandleRef.current ||
      isDraggingTerminalHandleRef.current ||
      isDraggingAgentsHandleRef.current
    )
      return true;
    return applyRailLayout(isCollapsedRef.current);
  }

  // `syncRailColumns` is redeclared every render and reads live refs; the
  // visibility flags are the edges that must re-run it, and listing the function
  // itself would re-run it on every render instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    const frameRef = { id: 0 };
    // The group may not have registered — or may not have measured a width —
    // on the render that flipped visibility. Retry by frame instead of waiting
    // for another visibility change that may never come; bounded so a rail that
    // never registers (its view kind does not mount one) cannot spin forever.
    const attempt = (attemptsLeft: number) => {
      if (syncRailColumns() || attemptsLeft <= 0) return;
      frameRef.id = requestAnimationFrame(() => attempt(attemptsLeft - 1));
    };
    attempt(30);
    return () => {
      if (frameRef.id !== 0) cancelAnimationFrame(frameRef.id);
    };
  }, [terminalColumnPresent, agentsColumnPresent]);

  // Expand the doc panel from a non-toggle path (tab request, avatar click,
  // width-threshold crossing). Every rail column is a permanent group member
  // even while hidden at zero width, so the panel API would try to trade with a
  // zero-width neighbor and silently do nothing. Route every transition through
  // the full-group layout instead.
  function expandDocPanel() {
    if (!docSlotPresentRef.current) return;
    assertRightRailLayout(false);
  }

  function togglePanel() {
    // Asset / skill / empty views have nothing to put in the slot, and the slot
    // is a permanent member whether or not they do — so presence, not the ref,
    // is what says the toggle has something to move. Bail before applyToggle so
    // the global ⌥⌘B handler doesn't write a spurious 'right' pin, and so the
    // chord can't open an empty pane on a view that has no document.
    if (!docSlotPresentRef.current) return;
    // Read partition from the ref (live value) — `rightPartition` captured by
    // the closure at render time goes stale if the user crosses the 1280px
    // threshold and immediately invokes the toggle before React commits the
    // new partition.
    const partition = rightPartitionRef.current;
    // Same reason `partition` is read from a ref just above, one hop worse: a
    // second chord arriving before the effect re-subscribes runs the previous
    // closure, and branching on render-bound state made it repeat the collapse
    // it had just done — a no-op leaving the panel shut, `aria-expanded` stuck
    // at "false", and a spurious 'collapsed' pin persisted.
    // `assertRightRailLayout` writes this ref synchronously so the live value
    // survives that gap. Pinned in EditorArea.dom.test.tsx.
    const collapsed = isCollapsedRef.current;
    // The permanent rail columns remain adjacent at zero width while hidden.
    // A per-panel expand/collapse would exchange with that zero-width neighbor
    // and no-op, so every transition must route through the editor residual.
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
      // Sync React state imperatively (mirrors sidebar.tsx's _setOpen pattern
      // for the left toggle). The library's onResize will also fire eventually,
      // but until it does any effect reading `isCollapsed` (focus-safety,
      // notifyViewMenuStateChanged) would see the pre-collapse value.
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

  // Sticky pixel-width re-pin on container-size changes. The container widens on
  // a window resize or a LEFT-sidebar collapse — not on a right-panel collapse,
  // which is internal flex redistribution. react-resizable-panels sizes every
  // panel as a percentage of the group, so without correction the pixel-sized
  // doc panel and agents column grow proportionally with the container (the
  // column measured 480px → 673px on a left-sidebar collapse). One full-layout
  // write restores both pins with the container delta flowing to the editor;
  // sequential per-panel `resize` calls would fight each other — each one
  // re-balances against its flex neighbor, knocking the other off its pin.
  // Gates: skip the embedded host (drag is disabled below, and the resolver
  // typically keeps the panel collapsed anyway); the assert skips during a live
  // drag (the drag owns the width).
  useEffect(() => {
    if (groupContainerEl == null) return;
    if (isEmbedded) return;
    // Reads the assert through its latest-ref: a ResizeObserver fires once on
    // `observe()`, so this effect must have STABLE deps — recreating the
    // observer per render would re-assert the layout on every render.
    const ro = new ResizeObserver(() => {
      assertRightRailLayoutRef.current(isCollapsedRef.current);
      enforceRightRailAdmissionRef.current('resize', admissionVisibilityRef.current);
    });
    ro.observe(groupContainerEl);
    return () => ro.disconnect();
  }, [groupContainerEl, isEmbedded]);

  const openRequestedDocPanelTab = useEffectEvent((tab: PanelTab) => {
    // The agent drill-in owns the whole panel body and offers no tab strip, so
    // answering a tab request means giving the rail back to the document.
    if (docPanelMode === 'agent') closeActivityPanel();
    onActiveTabChange(tab);
    expandDocPanel();
  });

  // Install the tab-request subscription once. The effect event keeps the
  // render-owned callbacks and current panel mode fresh without replaying the
  // mount-only pending-request read on later mode changes.
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

  // Expand-on-avatar-click. `docPanelExpandSignal` is a monotonic counter
  // incremented by `DocumentContext.openActivityPanel` (called from
  // `PresenceBar` avatar clicks and the mode-toggle button). When it
  // increments, expand/open the panel in whichever layout mode is active.
  // Initial 0 → 0 transition (mount) is harmless — calling `expand` when
  // already expanded is a no-op in react-resizable-panels.
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
    // Mirror into the renderer store unconditionally (works on web) so the
    // Cmd+K palette can show a state-reflecting "Show/Hide document panel"
    // label. The bridge push below is desktop-only (drives the native menu).
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

  // Track the prior active docName for DocumentErrorBoundary's
  // "Back to previous document" affordance. Updated AFTER render (effect) so
  // the *current* render still sees the prior value — during an error, the
  // user sees "Back to <previous>" where <previous> is the last successfully
  // navigated-to doc, not the doc that just errored.
  const previousDocNameRef = useRef<string | null>(null);
  const [previousDocName, setPreviousDocName] = useState<string | null>(null);
  // Session-sticky dismissal of the bottom "Ask AI" composer. When dismissed the
  // field collapses and the footer shows a reopen badge; persists across doc
  // switches within this editor shell's lifetime.
  const [composerDismissed, setComposerDismissed] = useState(false);
  /**
   * The new tab the mascot's double-rage revealed the game in. Keyed by tab id
   * so the reveal belongs to THAT tab: switching away and back keeps it, and a
   * different new tab still shows the empty state.
   *
   * Deliberately not a second tab. `remapWorkspaceTabs` only walks `openTabs`,
   * so an ephemeral placeholder cannot be re-identified in place; rendering a
   * different surface under the same tab id is what makes this a transition
   * rather than a new tab appearing next to the one you were looking at.
   */
  const [blobRunRevealedTabId, setBlobRunRevealedTabId] = useState<string | null>(null);
  const activeDocumentHistoryName =
    activeTarget?.kind === 'large-file' ? activeTarget.docName : activeDocName;
  useEffect(() => {
    if (activeDocumentHistoryName && activeDocumentHistoryName !== previousDocNameRef.current) {
      // Capture prior ref value, then update ref + state for the next render.
      const prior = previousDocNameRef.current;
      previousDocNameRef.current = activeDocumentHistoryName;
      setPreviousDocName(prior);
    }
  }, [activeDocumentHistoryName]);

  function navigateBackToDoc(prev: string) {
    // Navigate via hash so the URL stays in sync with app state —
    // NavigationHandler's hashchange listener will call openDocumentTransition(prev).
    // If the hash is already at prev (rare — happens when back-nav is used after
    // agent nav without URL update), fall back to direct transition.
    const nextHash = hashFromDocName(prev);
    if (isSameHash(window.location.hash, nextHash)) {
      openDocumentTransition(prev);
    } else {
      window.location.hash = nextHash;
    }
  }

  // Resolve the active view's content (the left/primary column) and what goes in
  // the right document slot (the document side pane, or agent activity on a
  // folder view). The docked terminal lives in the left column BELOW
  // `viewContent`, so it sits beside the slot rather than spanning under it, and
  // stays at one stable React position across view kinds so the PTY survives tab
  // switches and view-kind changes.
  //
  // Branches choose the slot's CONTENT, never whether the slot exists: the panel
  // is rendered once at the group level below and is a permanent member of the
  // rail (see RIGHT_RAIL_PANEL_ORDER). Null content means a zero-width slot, not
  // an absent one. A branch that unmounted it would change the group's id set,
  // and react-resizable-panels would answer by restoring the widths that set was
  // last paired with — which is how the agents column ended up stranded at zero
  // width, open as far as the app knew, with no way to reopen it.
  let viewContent: ReactNode;
  let docSlotContent: ReactNode = null;
  let renderFocusedDocument: ((activityMount: ReactNode) => ReactNode) | null = null;
  // Cold start with no group to preserve: render the bare skeleton and nothing
  // else. Set here, acted on at the single exit below.
  let coldStartSkeleton = false;

  // The terminal and agents columns are rendered once at the panel-group level
  // below, to the right of the slot, so the branches here only resolve the view
  // content and the slot's content.
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
    // The folder view gets the same "Ask AI" composer as the editor, scoped to
    // this folder (the folder is its top-row context chip + dispatch lead). It
    // docks in-flow below the folder list rather than as a scroll overlay — the
    // list is a discrete table, not a continuous document.
    const showFolderComposer = shouldShowFolderComposer({
      terminalVisible,
      agentsVisible,
      isEmbedded,
    });
    viewContent = (
      <div className="relative flex h-full min-h-0 flex-col">
        {/* Wrap the folder list so the fade band can anchor to the bottom of the
            list region (the top of the in-flow composer) rather than the bottom
            of the whole column. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <FolderOverview folderPath={activeTarget.folderPath} />
          {/* Same footer fade as EditorFooter's sliver (identical gradient
              band): the list dissolves into the background above the composer
              instead of meeting a hard edge. Only while the Ask AI composer is
              shown. */}
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
    // A folder has no document side pane, but an agent avatar click still drills
    // into that agent's activity — the same view `DocPanel` shows in agent mode,
    // so it fills the same slot rather than a panel of its own. Dismissal is the
    // avatar re-click (`closeActivityPanel`), which empties the slot; the slot's
    // own drag-to-close works here too, unlike the separate panel this replaced.
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
    // A markdownlint JSON config file opens in the dedicated config editor (a
    // Source/Rules toggle) instead of the read-only asset preview. Like the
    // skill-file branch below it's a plain REST-backed sibling — NOT
    // DocumentBoundary-wrapped: the config is served over HTTP, not a pooled
    // CRDT doc. Keyed by path so navigating between configs remounts + resets.
    viewContent = (
      <Suspense fallback={<ConfigEditorFallback />}>
        <LazyLintConfigEditor key={activeTarget.assetPath} assetPath={activeTarget.assetPath} />
      </Suspense>
    );
  } else if (activeTarget?.kind === 'asset' && isFrontmatterSchemaAsset(activeTarget.assetPath)) {
    // A tool-managed frontmatter schema opens in the dedicated schema editor
    // (a Source/Fields toggle) — same REST-backed sibling shape as the
    // markdownlint branch above, keyed by path for the same remount reset.
    viewContent = (
      <Suspense fallback={<ConfigEditorFallback />}>
        <LazySchemaConfigEditor key={activeTarget.assetPath} assetPath={activeTarget.assetPath} />
      </Suspense>
    );
  } else if (activeTarget?.kind === 'asset') {
    // `key={assetPath}` forces a fresh `AssetPreview` instance on every asset
    // navigation so the in-pane `forceText` toggle (from the "View as text"
    // button) does not bleed across unrelated files. AssetPreview sits outside
    // the EditorActivityPool so there's no Activity-preserved subtree to rely
    // on; this remount is the simplest correct reset.
    viewContent = (
      <AssetPreview
        key={activeTarget.assetPath}
        assetPath={activeTarget.assetPath}
        mediaKind={activeTarget.mediaKind}
      />
    );
  } else if (activeTarget?.kind === 'skill-file') {
    // A skill bundle file (global refs + scripts of any scope). Read-only,
    // backed by the scope-aware `/api/skill-file` read. Keyed by the three
    // coordinates so navigating between bundle files re-fetches.
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
    // A pre-install, read-only skill preview opened full-pane with a Manage action.
    // Keyed by the preview's identity so navigating between previews remounts a
    // fresh instance — otherwise the per-skill `detail` state (skills.sh URL, OG
    // image) bleeds across tabs and a switched-back preview shows the prior
    // skill's link. Same reset pattern as AssetPreview / SkillFileViewer above.
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
    // Terminal state for a share-receive miss — replaces the create-mode editor
    // the missing target would otherwise open, before the phantom provider's
    // editor can paint. Keyed by path so a redirect to another miss remounts +
    // re-fetches its verdict.
    viewContent = <ShareReceiveMissPanel key={shareReceiveMiss.path} nav={shareReceiveMiss} />;
  } else if (!activeProvider || !activeDocName) {
    // On initial page load the URL hash tells us a doc is about to open — render
    // the skeleton instead of the "Select a document" empty state so the user
    // doesn't see a flash of the OkBlob screen before `NavigationHandler` wires
    // up the hash-driven nav.
    const hashDoc = typeof window !== 'undefined' ? docNameFromHash(window.location.hash) : null;
    if (hashDoc !== null) {
      if (terminalBridge != null && everHadProvider) {
        // Mid-session navigation to a not-yet-ready doc — closing a tab (the
        // neighbor activates async via the hashchange handler) or switching to a
        // cold/evicted one — transiently nulls the active provider while the hash
        // already names the next doc. Render the load skeleton THROUGH the shared
        // group (not a bare early return) so the persistent left column, and the
        // docked TerminalDock + its live PTY inside it, stay mounted across the
        // gap instead of unmounting and resetting the terminal.
        viewContent = <EditorSkeleton />;
        // Visual-only filler, so the slot keeps its width across the load gap
        // instead of collapsing and reopening. Content-only: the slot's own
        // panel is permanent, so nothing here has to reproduce its id or sizing
        // the way a placeholder panel once did. No ARIA — the slot goes `inert`
        // on empty content, and the skeleton in the left column is the announced
        // loading state.
        docSlotContent = <div className="min-h-0 flex-1" />;
      } else {
        // Genuine cold start (group never mounted; no docked terminal alive yet)
        // or the web host (no dock to preserve): render the bare skeleton
        // OUTSIDE the shared horizontal panel group. There is no group state to
        // preserve on this path and nothing docked to keep alive, so mounting
        // one to hold a skeleton buys nothing; when the doc lands, the group
        // mounts fresh with the slot already in it.
        //
        // Flagged rather than returned on the spot: a hook is declared after
        // this chain (the doc-slot publish), and returning from inside the chain
        // would skip it on this path alone. The bare skeleton still renders,
        // outside the group, just from the single exit below.
        coldStartSkeleton = true;
      }
    } else if (isBlobRunnerNewTabId(activeNewTabId)) {
      // Checked before the Skills arm: a blob-runner tab must win even when the
      // Skills sidebar is pinned, or opening the game from the Resources menu
      // while in Skills mode would silently render the Skills home instead.
      viewContent = <OkBlobRunnerPage />;
    } else {
      // The empty state collapses to the header-only view while EITHER session
      // panel is open — an open panel is its own AI entry point, so the composer
      // bubble + starter packs would compete with it. Which panel picks the
      // header pose (bottom-anchored above the dock; centered beside the column).
      viewContent =
        blobRunRevealedTabId !== null && blobRunRevealedTabId === activeNewTabId ? (
          // Revealed by the double-sparkle: the user just made a deliberate
          // gesture, so run on rather than greeting them with "press space".
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
    // Visibility for the open doc's "Ask AI" composer — the pure gate in
    // bottom-composer-gate.ts (hidden while either session panel is open, in
    // embedded webviews, and with no doc open). The folder overview mounts its
    // own instance under shouldShowFolderComposer. Positioning and the
    // --ask-composer-height scroll inset are documented at the render site
    // below.
    const showBottomComposer =
      shouldShowBottomComposer({
        terminalVisible,
        agentsVisible,
        isEmbedded,
        activeDocName,
      }) &&
      // Hide the "Ask AI" composer while a full-pane diff is open (timeline or
      // agent edit) — it would float over the diff's bottom, and it's a
      // live-edit affordance that doesn't apply to a read-only diff.
      !(timelineDiff && timelineDiff.docName === activeDocName) &&
      !(agentDiff && agentDiffDoc === activeDocName);
    const externalSkillEdit = activeDocName ? parseExternalSkillDocName(activeDocName) : null;
    const renderEditorContent = (activityMount: ReactNode) => (
      <div className="relative flex h-full flex-col">
        {/* Detected-skill edit-in-place banner: a real layout row above the editor
            (not the toolbar's absolute overlay), so it reads like the read-only
            preview banner and carries the Manage upgrade. */}
        {externalSkillEdit ? (
          <Suspense fallback={null}>
            <SkillEditBanner name={externalSkillEdit.name} />
          </Suspense>
        ) : null}
        <div className="relative min-h-0 flex-1">
          {/* Hybrid Activity + Suspense + ErrorBoundary render tree.
          EditorWorkspace supplies this pane-owned host while the single
          EditorActivityPool portals each Activity entry into its visible pane.
          The pool keeps Tiptap eager and lazy-loads SourceEditor on the first
          source-mode visit for each doc, then preserves the per-doc display:none
          toggle after that initial load. Each Activity entry owns its own scroll
          container so scroll position is DOM-local to that doc's subtree and
          survives the Activity hidden-mode mount/unmount cycle.

          Error + Suspense scoping lives INSIDE EditorActivityPool — each
          Activity wraps its own DocumentErrorBoundary + Suspense so a
          hidden doc's cached rejected syncPromise cannot re-throw into
          the visible UI. See EditorActivityPool.tsx file
          docstring "ERROR + SUSPENSE SCOPING" for rationale. */}
          <div className="relative h-full">
            {activityMount}
            <FindReplaceController activeDocName={activeDocName} isSourceMode={isSourceMode} />
            {/* Nav-pending skeleton overlay. Rendered when the urgent
            `activeDocName` (shell state — driving sidebar highlight +
            header title) has moved past `deferredActiveDocName` (editor
            subtree prop), AND the upcoming deferred commit will pay a
            real Suspense suspension. The delta window is the interval
            between shell-snap and the editor subtree's deferred commit
            completing — 1-3s on mark-heavy docs that refuse V2 cache
            admission, sub-frame on warm reopens (both mount-promise
            and sync-promise resolved).
            Without this overlay the user sees the PREVIOUS doc's editor
            linger through a slow mount window, which looks like a
            "flash of the old editor" and contradicts the sidebar's
            now-updated highlight. The overlay is absolute + inset-0 on
            the positioned parent so it paints over the pool without
            unmounting it — Activity state (scroll, selection, editor
            instances) survives underneath.
            Warm-reopen bypass: skip the overlay when both the mount-
            promise and sync-promise caches have resolved entries for
            the new docName. In that state `use()` short-circuits
            synchronously, the deferred commit lands in 1 frame, and
            painting a skeleton during the urgent-paint → deferred-
            commit gap creates a perceptible "cold load" flash on a
            genuinely warm reopen. Reading module state during render
            is safe because resolution is a terminal cache-entry state
            (only invalidate clears it, and invalidate runs from
            park-uncached / evict effects that have already committed
            before this render reads the flag). */}
            {shouldPaintOverlay({
              activeDocName,
              deferredActiveDocName,
              mountResolved: activeDocName !== null && mountPromiseHasResolved(activeDocName),
              syncResolved: activeDocName !== null && syncPromiseHasResolved(activeDocName),
            }) ? (
              <div className="absolute inset-0 z-10 bg-background">
                <EditorSkeleton />
                {/* Mount-stalled affordance — surfaces a "Cancel" link
                  when the mount-promise substrate emits `ok/mount/stalled`
                  past MOUNT_STALLED_THRESHOLD_MS (10s default). Only
                  shown when the skeleton is already overlay-active, so a
                  fast mount never sees the affordance. */}
                {activeDocName !== null ? <MountStalledAffordance docName={activeDocName} /> : null}
              </div>
            ) : null}
            {/* Full-pane version diff overlay — paints over the pool (like the
                skeleton above) without unmounting it, so the provider stays live
                for the vs-live comparison and closing returns instantly. */}
            {timelineDiff && timelineDiff.docName === activeDocName ? (
              <Suspense fallback={null}>
                <LazyTimelineDiffPane
                  view={timelineDiff}
                  isPanelCollapsed={isCollapsed}
                  onTogglePanel={togglePanel}
                />
              </Suspense>
            ) : null}
            {/* Agent-edit diff overlay — same slot + rationale as the timeline
                pane above. Painted only for the current edit's own doc. */}
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
          {/* Floats over the bottom of the scroll area (an absolute overlay, like
              the toolbar at the top) so content scrolls under its faded top edge.
              BottomComposer publishes its measured height as `--ask-composer-height`
              and globals.css pads the editor content by it so the last lines clear
              the card; the var clears on collapse, reclaiming the space. */}
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

  // A popped-out note window carries no document side pane. Emptied here rather
  // than in each branch: every branch that fills the slot is equally out of
  // scope, and one exit keeps the presence read below honest. The slot itself
  // still renders — permanent membership is what keeps the group's id set
  // constant — it just holds nothing and sits at zero width.
  if (noteWindow) docSlotContent = null;

  // Read presence into a const, and let the effect below close over THAT rather
  // than over `docSlotContent`. The slot's content is a `let` the branch chain
  // reassigns, and React Compiler treats any value an effect observes as
  // immutable — an effect capturing it directly turns every branch assignment
  // above into a compile error. Both this const and the effect must also sit
  // after the chain, since a reader declared above it cannot update when a
  // later-declared binding changes (the compiler rejects that too).
  const docSlotPresent = docSlotContent != null;

  // Filling or emptying the slot changes what the rail owes each column, and no
  // visibility flag moves when it happens — `syncRailColumns` is keyed on the
  // terminal/agents flags and would sit this one out. An emptied slot has to
  // hand its width back to the editor, and a filled one has to take its width
  // back, or the pane arrives at whatever width the last view left behind.
  //
  // Applied through a bounded by-frame retry (mirrors the visibility-flag
  // effect above): the same render that flips presence also flips the panel's
  // constraint props, so a write from this commit's layout effect is validated
  // against the PREVIOUS constraints and silently clamped — the slot stays at
  // zero, `onResize(0)` reads as a user collapse, and the pane never comes
  // back until a reload. Retrying on the next frame lands after the group has
  // re-registered the constraints.
  //
  // The collapse intent is captured ONCE, at flip time. The clamped write's
  // zero-width report flips `isCollapsed` state before the first retry runs;
  // re-reading the ref inside the loop would launder that artifact into "the
  // user collapsed it" and pin the slot shut.
  useLayoutEffect(() => {
    const docSlotPresenceChanged = docSlotPresentRef.current !== docSlotPresent;
    docSlotPresentRef.current = docSlotPresent;
    if (!docSlotPresenceChanged) return;
    // A new flip supersedes a retry still in flight from the previous one.
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

  // A single TerminalDock wraps the active view's left column. The skeleton
  // below is structurally identical for every view kind, so the dock keeps one
  // React position and its PTY survives tab switches and view-kind changes. It
  // renders on every host; where no shell can spawn it simply stays collapsed.
  // The live session host lives in EditorPane (above this component) so a
  // view-kind change — which remounts EditorArea's subtree — can't re-spawn it.
  // Here we render the placement-aware layout shell, which reports its bottom
  // mount + editor region up (via onSessionPlacements); the right mount lives in
  // the horizontal rail below.
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

  // The document side pane: `docSlotContent` decides what it holds, never
  // whether it is here. A view with nothing to put in it gets a zero-width slot,
  // the same way a hidden terminal or agents column is a zero-width member.
  //
  // While the agents column is open and this slot is closed, it sits as a
  // zero-width flex neighbor between the editor and the agents column. Its own
  // handle is disabled whenever it is collapsed, but drags on the TERMINAL's
  // handle still route through it: the library snap-expands it once the drag
  // crosses half its min size, instead of returning the space to the editor.
  // That is deliberate — a collapsed panel stays a NORMAL member of the group.
  // Disabling it is what turned a collapsed interior panel into a dead
  // neighbour: the handle beside it had nothing to trade against and moved
  // nothing. Left enabled, the library snap-expands it — visible movement
  // rather than a frozen rail.
  const docSlot = (
    <>
      <ResizableHandle
        data-doc-panel-handle=""
        // No visible grip while collapsed or empty — there is nothing to drag.
        withHandle={docSlotPresent && !isCollapsed}
        // A collapsed pane is not drag-resizable: the toolbar toggle and ⌥⌘B are
        // its single open mechanism (mirrors TerminalDock's hidden-dock handle).
        // Disabling while collapsed also keeps this handle from overlapping the
        // terminal column's handle at the same pixel seam, and from being a
        // misclick target under embedded AI-editor hosts whose own container
        // chrome sits at the iframe edge.
        disabled={!docSlotPresent || isCollapsed}
        className={docSlotPresent ? undefined : 'pointer-events-none'}
        // Out of flex flow entirely while the slot holds nothing, matching the
        // sibling rail handles — a separator for a column that is not there
        // still paints its own width.
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
        // While filled this is the pane's drag ceiling. While empty the same
        // knob is the flex-flow clamp every hidden rail column carries: RRP
        // applies `Math.min(maxSize, size)` last in its layout validator, so
        // `0px` holds the outer flex item at zero share through every
        // redistribution pass. Without it an empty slot can take a share for a
        // frame and paint a gap the editor should own.
        maxSize={docSlotPresent ? DOC_PANEL_MAX_SIZE : '0px'}
        collapsible
        collapsedSize={0}
        onResize={(size) => {
          // A view with no document pane pins the slot to zero, and that zero is
          // about the VIEW, not about the user having closed anything. Reading it
          // as a collapse would silently rewrite their open/closed preference
          // every time they opened an image or a skill file.
          if (docSlotPresent) {
            setIsCollapsed(size.asPercentage === 0);
          }
          // Persist only when this resize came from a user drag — RO-driven
          // recomputes (sticky width restoration) also fire onResize, but
          // they're replaying the persisted value and must NOT overwrite it.
          if (size.inPixels > 0 && isDraggingDocHandleRef.current) {
            docPanelWidthPxRef.current = size.inPixels;
            debouncedWriteDocPanelWidth(size.inPixels);
          }
          reclaimHiddenRailColumn(DOC_PANEL_ID, docSlotPresent, size.inPixels);
        }}
        // react-resizable-panels does NOT apply inert/aria-hidden/display:none when
        // a panel collapses (verified against the installed runtime) — children stay
        // in DOM, in Tab order, and announced by screen readers. `inert` removes the
        // collapsed subtree from the a11y tree and focus order without remounting.
        inert={!docSlotPresent || isCollapsed}
        className="flex flex-col bg-muted/20"
      >
        {docSlotContent}
      </ResizablePanel>
    </>
  );

  // The rail's panel set is FIXED: this column is always a member of the group
  // and represents "hidden" as collapsed, never as unmounted.
  //
  // Mounting a column into an already-full group is what starved it — the
  // library has only the leftover to give a new member, which measured as ~1%
  // of the group against its own 320px minimum, and a column that small drags
  // the whole rail into states it cannot resolve. A column that is always
  // present never has to be inserted, so there is no leftover to land in.
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
              // Drag-to-close, as the agents column has. The column is
              // collapsible now that it never unmounts, so a drag can shut it —
              // and a column sitting at zero width while the app still believes
              // it is visible has no handle grip and no way back.
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
        // Frozen at the mount-time width on purpose. `defaultSize` is a
        // registration input: a live value re-registers the panel with the
        // library each time the persisted width changes, which the debounced
        // width write does moments after every drag on this column's handle.
        // Re-registration makes the group re-resolve its layout from a cache
        // keyed by panel ORDER — and permanently-mounted zero-width columns
        // tie in that ordering (same offsetLeft, same offsetWidth), so the
        // resolve can land on a stale permutation entry such as the launch-era
        // all-collapsed rail, zeroing every column the app believes is open.
        // Width restores don't need this to be live: every reopen routes
        // through the rail re-pin, which reads the live width ref above.
        defaultSize={terminalColumnPresent ? `${initialTerminalWidthPx}px` : 0}
        minSize={`${RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX}px`}
        // Clamp the outer flex item to zero while hidden. RRP's own layout
        // validator applies `Math.min(maxSize, size)` last (after the collapsible
        // halfway snap), so a `maxSize` of `0` hard-clamps every redistribution
        // pass to zero even while `minSize` stays at its normal value — RRP
        // never assigns nonzero flex share to a hidden column. `style` cannot do
        // this: `Panel` spreads it onto the inner content div, not the outer
        // `data-panel` flex item that carries the group-computed `flexGrow`.
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

  // The agents column sits to the right of the terminal rail
  // (MD | PANE | TERMINAL | AGENTS), as its own independent resizable column.
  // Like the terminal column it is a permanent member of the group and shows
  // "hidden" as collapsed — see the note there for why membership is fixed.
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
              // Drag-to-close: releasing with the column snapped shut hides the
              // agents panel while its permanent rail member stays collapsed,
              // mirroring the doc panel's drag-to-close affordance. Deferred to
              // release so visibility does not change under the active drag.
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
        // While present the panel can be dragged wide — up to 95% of the group —
        // leaving the editor a 5% sliver (its panel `minSize` while this column
        // is mounted). Pair the two: this max plus the editor's min must sum to
        // 100% or the drag can't reach it. Mirrors the bottom dock's 95%/5% split.
        // While hidden the same knob doubles as the flex-flow clamp: RRP applies
        // `Math.min(maxSize, size)` last in its layout validator, so `0px` hard-
        // clamps the outer flex item to zero share every redistribution pass —
        // the paint window `reclaimHiddenRailColumn` alone couldn't close.
        maxSize={agentsColumnPresent ? '95%' : '0px'}
        // Collapsible so a drag past half the min width snaps the column shut —
        // the pointerup handler above turns that into a real hide.
        collapsible
        collapsedSize={0}
        onResize={(size) => {
          // Persist only on a user drag — the sticky-width RO replays the
          // persisted value through onResize too and must not overwrite it.
          if (size.inPixels > 0 && isDraggingAgentsHandleRef.current) {
            agentsWidthPxRef.current = size.inPixels;
            debouncedWriteAgentsWidth(size.inPixels);
          }
          reclaimHiddenRailColumn(AGENTS_COLUMN_ID, agentsColumnPresent, size.inPixels);
        }}
        className="flex flex-col"
      >
        {/* Mount point for the agents host's stable host div. */}
        <div
          ref={setAgentsContainer}
          data-agents-panel-mount=""
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        />
      </ResizablePanel>
    </>
  );

  // Cold start with no group to preserve: the bare skeleton, outside the panel
  // group. Every hook above has run by now, so this exit is safe.
  if (coldStartSkeleton) return <EditorSkeleton />;

  // The editor absorbs the residual width whenever something on the right claims
  // space — the document side pane (when filled and not collapsed) or a
  // resizable rail.
  const editorAbsorbsResidual =
    (docSlotPresent && !initialRightCollapsed) || resizableRailColumnPresent;

  // The agents reveal tab pins to the far-right column edge here; the terminal's
  // tab lives inside TerminalDock, pinned to the bottom of the editor column.
  // (Each gated by its own predicate above; both can be up at once.)

  // Order: EDITOR | document side pane | terminal column | agents column. Every
  // member is permanent and always in this order, so the group's panel-ID set is
  // the same on every view and the library never swaps in a cached layout.
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
            // No explicit id: an id here changed how react-resizable-panels
            // redistributes on imperative resize and broke the doc-panel
            // pixel-width sticky restore. The
            // left panel is always the first child, so React keeps it mounted
            // across right-side toggles without one (the terminal host remains mounted).
            //
            // With a resizable rail mounted the editor yields to a 5% sliver. That
            // keeps the agents panel's 95% maximum reachable while allowing the
            // terminal rail to expand against the residual without its own maximum.
            // Without a rail the 30% floor keeps the editor usable against the doc
            // panel.
            minSize={resizableRailColumnPresent ? '5%' : '30%'}
            // Editor takes full width only when nothing on the right claims space;
            // otherwise it absorbs the residual while the pixel-sized doc panel and
            // resizable rails hold their widths.
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
          // This is intentionally inside the below-header workspace. It stays
          // attached to the agents-panel edge without competing with global
          // header actions.
          <TerminalRevealTab edge="right" onReveal={onRevealAgents} className="top-2.5 right-0" />
        ) : null}
      </div>
    </div>
  );
}
