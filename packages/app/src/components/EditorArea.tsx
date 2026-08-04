import {
  detectEmbeddedHostFromBrowser,
  isFrontmatterSchemaAsset,
  isMarkdownlintJsonConfig,
  parseExternalSkillDocName,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  lazy,
  type ReactNode,
  Suspense,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useGroupRef, usePanelRef } from 'react-resizable-panels';
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
import { PropertyProvider, useProperties } from '@/components/PropertyContext';
import { ShareReceiveMissPanel } from '@/components/ShareReceiveMissPanel';
import { SkillFileViewer } from '@/components/SkillFileViewer';
import { SkillPreviewTab } from '@/components/SkillPreviewTab';
import { SkillsBasePage } from '@/components/SkillsBasePage';
import { SettingsDialogShell } from '@/components/settings/SettingsDialogShell';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  isSkillsNewTabId,
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
import { docNameFromHash, hashFromDocName } from '@/lib/doc-hash';
import { getInitialDocPanelWidth, writeDocPanelWidth } from '@/lib/doc-panel-width-store';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';
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
import { cn } from '@/lib/utils';
import { setViewMenuState } from '@/lib/view-menu-state-store';
import { useSyncStatus } from '@/presence/use-sync-status';
import { BottomComposer } from './BottomComposer';
import { shouldShowBottomComposer, shouldShowFolderComposer } from './bottom-composer-gate';
import { EditorActivityPool } from './EditorActivityPool';
import { EditorFooter } from './EditorFooter';
import type { EditorMode } from './EditorPane';
import { EditorToolbar } from './EditorToolbar';
import { shouldPaintOverlay } from './editor-area-overlay';
import { computeStickyRepinLayout } from './editor-area-sticky-repin';
import { TerminalDock } from './TerminalDock';
import { TerminalRevealTab } from './TerminalRevealTab';

const LazyActivityModeContent = lazy(async () => {
  const mod = await import('@/components/ActivityModeContent');
  return { default: mod.ActivityModeContent };
});

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

// Shared doc-panel sizing — referenced by both the live `id="doc-panel"` and the
// hash-load placeholder that mirrors it, so the two stay structurally linked and
// their min/max can't drift apart.
const DOC_PANEL_MIN_SIZE = '300px';
const DOC_PANEL_MAX_SIZE = '600px';

// The right-side panels the horizontal group can render. The editor column is the
// residual absorber and intentionally has no id (an explicit id on it changes how
// the library redistributes an imperative resize), so the right-rail layout assert
// finds it as the one live panel id that is not one of these.
const RIGHT_PANEL_IDS = new Set(['doc-panel', 'agents-column', 'agent-panel']);

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
  onTerminalVisibleChange?: (visible: boolean) => void;
  /** Agents-panel visibility. Its own resizable column to the right of the
   *  doc/agent panel (`#agents-column`, MD | PANE | AGENTS). Independent of the
   *  terminal — both panels can be open at once. */
  agentsVisible?: boolean;
  onAgentsVisibleChange?: (visible: boolean) => void;
  /** Report both panels' attach points up to EditorPane (which owns the session
   *  hosts). See {@link SessionPlacements}. */
  onSessionPlacements?: (placements: SessionPlacements) => void;
  /** Reveal the agents panel — drives the right edge tab shown while it is
   *  hidden. Provided on every host (agent threads are server-hosted). */
  onRevealAgents?: () => void;
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
  onTerminalVisibleChange,
  agentsVisible = false,
  onAgentsVisibleChange,
  onSessionPlacements,
  onRevealAgents,
}: EditorAreaProps) {
  const { t } = useLingui();
  const {
    activeDocName,
    activeProvider,
    activeTarget,
    activeNewTabId,
    skillsSidebar,
    recycleDocument,
    docPanelMode,
    docPanelAgentId,
    docPanelExpandSignal,
  } = useDocumentContext();
  const { openDocumentTransition } = useDocumentTransition();
  const { requestAddProperty } = useProperties();
  const stats = useDocumentStats(activeProvider, activeDocName);
  const selectionStats = useSelectionStats(
    activeDocName,
    editorMode === 'source' ? 'source' : 'wysiwyg',
  );
  const syncStatus = useSyncStatus(activeProvider);
  const isConnected = syncStatus === 'connected' || syncStatus === 'synced';
  // Schema-required properties the doc does not have badge the toolbar's
  // Add-properties button: they have no body construct to mark and no property
  // row either (being absent is the problem), and on a doc with no properties
  // at all `PropertyPanel` renders nothing — so the toolbar is the only surface
  // always there to carry them. Present-but-invalid properties are the panel's.
  const { data: frontmatterLintConfig } = useDocLintConfig(activeDocName);
  // Source mode hides the Add-properties button entirely, so the pass has no
  // consumer there — short-circuit rather than lint on every keystroke for a
  // badge that cannot render.
  const { missing: missingProperties } = partitionFrontmatterProblems(
    useFrontmatterDiagnostics(
      editorMode === 'source' ? null : activeProvider,
      frontmatterLintConfig?.effective ?? null,
    ),
  );
  const lifecycleStatus = useLifecycleStatus(activeDocName);
  const isConflict = lifecycleStatus === 'conflict';
  // Latches true once any provider has been active this session. It separates a
  // genuine cold start (group never mounted, no docked terminal alive yet) from
  // a mid-session navigation whose provider is transiently null — closing a tab
  // or switching to a not-yet-ready doc. Only the latter must keep the
  // persistent left column mounted so the docked terminal PTY survives.
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
      if (window.location.hash === nextHash) openDocumentTransition(agentDiffDoc);
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
  // that column is mounted (agents panel visible); the sticky-width RO pins it
  // the same way it pins the doc panel.
  const agentsColumnPanelRef = usePanelRef();
  const [initialRightCollapsed] = useState(() => {
    const pins = readPins();
    return resolveEffectiveState('right', rightPartition, pins) === 'collapsed';
  });
  const [isCollapsed, setIsCollapsed] = useState(initialRightCollapsed);
  // Ref mirror so the ResizeObserver callback can gate without re-creating
  // the observer on every isCollapsed flip.
  const isCollapsedRef = useRef(isCollapsed);

  // The agents panel's mount point — a dedicated column to the right of the doc
  // panels (MD | PANE | AGENTS), present across EVERY view kind (the column just
  // has no doc panel beside it on asset / large-file / empty views).
  const [agentsContainer, setAgentsContainer] = useState<HTMLDivElement | null>(null);
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
  const agentsColumnPresent = agentsVisible;
  // The agents panel is the one surface with a persistent edge affordance: it is
  // discoverable in a way a chord is not, and an agent conversation is the thing a
  // user is most likely to want back. Ungated on having conversations — an empty
  // panel opens on its New button, which is a fine cold entry.
  //
  // The terminal has NO reveal tab. It is a developer surface reached by ⌘J (and
  // the View menu), and a second permanent tab hovering over the editor footer's
  // bottom-right was clutter competing with the Ask AI composer for that corner.
  const rightRevealTabPresent = !agentsVisible && onRevealAgents != null;
  const terminalShowing = terminalVisible && bottomTerminalContainer != null;
  const agentsShowing = agentsVisible && agentsContainer != null;
  // Report the attach points up to EditorPane (which owns the long-lived session
  // hosts). EditorArea only says where to attach — the VS Code / Zed pattern of
  // owning the terminal above the layout that changes.
  useEffect(() => {
    onSessionPlacements?.({
      terminal: { container: bottomTerminalContainer, isShowing: terminalShowing },
      agents: { container: agentsContainer, isShowing: agentsShowing },
      editorRegion: terminalEditorRegion,
    });
  }, [
    onSessionPlacements,
    bottomTerminalContainer,
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

  useEffect(
    () => () => {
      if (writeTimerRef.current != null) clearTimeout(writeTimerRef.current);
      if (agentsWriteTimerRef.current != null) clearTimeout(agentsWriteTimerRef.current);
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

  // Group-level imperative handle. Layout corrections MUST go through
  // `setLayout` (the whole layout in one shot): the per-panel imperative APIs
  // (`resize`/`collapse`/`expand`) always exchange space with the panel's flex
  // NEIGHBOR, and in the EDITOR | doc-panel | agents-column order that
  // neighbor is never the editor — a doc-panel collapse dumps its width into
  // the agents column, and re-pinning it hands the width right back to the doc
  // panel. Only a full-layout write can route deltas to the editor. The layout
  // math lives in `computeStickyRepinLayout` (unit-tested).
  const groupRef = useGroupRef();
  // Live mirror of `agentsColumnPresent` for subscribers with narrow deps.
  const agentsColumnPresentRef = useRef(agentsColumnPresent);
  useEffect(() => {
    agentsColumnPresentRef.current = agentsColumnPresent;
  }, [agentsColumnPresent]);

  // Pixel basis for px→% conversion in `assertRightRailLayout`. Layout
  // percentages are relative to the group's panel space; derive the basis from
  // a panel whose percentage and pixel width are both known (immune to the
  // separator widths the container includes), falling back to the container.
  function resolveGroupPxWidth(): number | null {
    for (const ref of [panelRef, agentsColumnPanelRef]) {
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

  // Write the intended right-rail layout in one `setLayout` call: the doc
  // panel at its persisted width (or pinned shut at 0 when collapsed), the
  // agents column at its persisted width, other rail panels (agent-panel)
  // untouched, and the EDITOR absorbing the remainder. This is the single
  // correction primitive for every path where the library would otherwise
  // misroute space.
  function assertRightRailLayout(docCollapsed: boolean) {
    if (isDraggingDocHandleRef.current || isDraggingAgentsHandleRef.current) return;
    const group = groupRef.current;
    if (group == null) return;
    // The imperative handles throw once their group/panel has unregistered,
    // and this can run from a deferred microtask racing a view-kind remount —
    // a torn-down group just means there is no layout left to correct.
    try {
      const containerPx = resolveGroupPxWidth();
      if (containerPx == null) return;
      const layout = group.getLayout();
      const ids = Object.keys(layout);
      if (ids.length === 0) return;
      const residualId = ids.find((id) => !RIGHT_PANEL_IDS.has(id));
      if (residualId == null) return;
      const pinnedPx: Record<string, number> = {};
      if ('doc-panel' in layout) {
        pinnedPx['doc-panel'] = docCollapsed ? 0 : docPanelWidthPxRef.current;
      }
      if ('agents-column' in layout) {
        pinnedPx['agents-column'] = agentsWidthPxRef.current;
      }
      if (Object.keys(pinnedPx).length === 0) return;
      const next = computeStickyRepinLayout({
        currentLayout: layout,
        containerPx,
        pinnedPx,
        residualId,
      });
      if (next !== layout) group.setLayout(next);
    } catch {
      // Group or panel unregistered mid-flight — nothing to assert against.
    }
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

  // Expand the doc panel from a non-toggle path (tab request, avatar click,
  // width-threshold crossing). Same routing rule as togglePanel: with the
  // agents column mounted, go through the full-layout assert so the width
  // comes from the editor rather than the agents column.
  function expandDocPanel() {
    if (agentsColumnPresentRef.current) {
      assertRightRailLayout(false);
    } else {
      panelRef.current?.expand();
    }
  }

  function togglePanel() {
    // Folder / asset views render a different tree with no doc panel, so
    // panelRef is unbound there. Bail before applyToggle so the global ⌥⌘B
    // handler doesn't write a spurious 'right' pin for a panel that can't move.
    if (panelRef.current == null) return;
    // Read partition from the ref (live value) — `rightPartition` captured by
    // the closure at render time goes stale if the user crosses the 1280px
    // threshold and immediately invokes the toggle before React commits the
    // new partition.
    const partition = rightPartitionRef.current;
    // With the agents column mounted, expand/collapse must route through the
    // full-layout assert so the space comes from / returns to the editor — the
    // per-panel APIs would exchange it with the agents column instead.
    if (isCollapsed) {
      applyToggle('right', partition, 'open');
      if (agentsColumnPresentRef.current) {
        assertRightRailLayout(false);
      } else {
        panelRef.current?.expand();
      }
    } else {
      applyToggle('right', partition, 'collapsed');
      if (agentsColumnPresentRef.current) {
        assertRightRailLayout(true);
      } else {
        panelRef.current?.collapse();
      }
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
      if (agentsColumnPresentRef.current) {
        assertRightRailLayout(nextCollapsed);
      } else if (nextCollapsed) {
        panelRef.current?.collapse();
      } else {
        panelRef.current?.expand();
      }
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [
    embeddedHost,
    panelRef,
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
    });
    ro.observe(groupContainerEl);
    return () => ro.disconnect();
  }, [groupContainerEl, isEmbedded]);

  // Expand-on-avatar-click. `docPanelExpandSignal` is a monotonic counter
  // incremented by `DocumentContext.openActivityPanel` (called from
  // `PresenceBar` avatar clicks and the mode-toggle button). When it
  // increments, expand/open the panel in whichever layout mode is active.
  // Initial 0 → 0 transition (mount) is harmless — calling `expand` when
  // already expanded is a no-op in react-resizable-panels.
  useEffect(() => {
    const openRequestedTab = (tab: PanelTab) => {
      onActiveTabChange(tab);
      expandDocPanel();
    };

    const pendingTab = consumePendingDocPanelTabRequest();
    if (pendingTab) {
      openRequestedTab(pendingTab);
    }

    return subscribeToDocPanelTabRequests((tab) => {
      consumePendingDocPanelTabRequest();
      openRequestedTab(tab);
    });
  }, [
    onActiveTabChange,
    // biome-ignore lint/correctness/useExhaustiveDependencies: expandDocPanel is render-bound; re-subscribing keeps the handler fresh
    expandDocPanel,
  ]);

  useEffect(() => {
    if (docPanelExpandSignal === 0) return;
    expandDocPanel();
  }, [
    docPanelExpandSignal,
    // biome-ignore lint/correctness/useExhaustiveDependencies: expandDocPanel is render-bound; re-running keeps the closure fresh
    expandDocPanel,
  ]);

  // react-resizable-panels caches layouts keyed by the panel-ID set and
  // restores the cached layout whenever the set changes — so mounting or
  // unmounting the agents column would resurrect whatever doc-panel state the
  // OTHER panel set last saw (e.g. hiding the panel re-opened a doc panel
  // the user had closed while it was up). Re-assert the intended layout on
  // every panel-set change: the doc panel keeps its pre-change collapsed state,
  // both rail widths stay pinned, and the editor absorbs the difference. The
  // library's restore runs synchronously in the re-registration render that a
  // panel-set change triggers, so the correction is deferred one microtask to
  // land after it (still ahead of paint — `setLayout` notifies the panels'
  // external stores synchronously).
  const prevAgentsColumnPresentRef = useRef(agentsColumnPresent);
  useLayoutEffect(() => {
    if (prevAgentsColumnPresentRef.current === agentsColumnPresent) return;
    prevAgentsColumnPresentRef.current = agentsColumnPresent;
    const docCollapsed = isCollapsed;
    queueMicrotask(() => {
      assertRightRailLayoutRef.current(docCollapsed);
    });
  }, [agentsColumnPresent, isCollapsed]);

  useLayoutEffect(() => {
    if (!isCollapsed) return;
    const panelEl = document.getElementById('doc-panel');
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
    if (window.location.hash === nextHash) {
      openDocumentTransition(prev);
    } else {
      window.location.hash = nextHash;
    }
  }

  // Resolve the active view's content (the left/primary column) and any
  // right-side panel (doc panel for docs, agent panel for a folder + agent
  // view). The docked terminal lives in the left column BELOW `viewContent`, so
  // it sits beside the right panel rather than spanning under it, and stays at
  // one stable React position across view kinds so the PTY survives tab switches
  // and view-kind changes.
  let viewContent: ReactNode;
  let rightPanel: ReactNode = null;

  // The agents column (when visible) is rendered once at the
  // panel-group level below, to the right of `rightPanel`, so the branches here
  // only resolve the view content and its own doc/agent panel.
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
    const showAgentPanel = docPanelMode === 'agent' && docPanelAgentId !== null;
    if (showAgentPanel) {
      rightPanel = (
        <>
          <ResizableHandle withHandle />
          {/* Non-collapsible — folder view has no toolbar toggle; dismiss via avatar re-click. */}
          <ResizablePanel
            id="agent-panel"
            defaultSize="25%"
            minSize="300px"
            maxSize="40%"
            className="flex flex-col bg-muted/20"
          >
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
          </ResizablePanel>
        </>
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
        // gap instead of unmounting and resetting the terminal. The doc-panel
        // sibling holds the panel count at 3 (we only reach this branch in doc
        // context; folder/asset/large-file are handled above), so the
        // sticky-width restore is not corrupted by a 1→3 transition.
        viewContent = <EditorSkeleton />;
        // A ref-free placeholder that mirrors the doc-panel's id + sizing so
        // react-resizable-panels treats it as the same `id="doc-panel"` element
        // across skeleton → doc and preserves its pixel width. It carries no
        // panelRef/onResize/drag handlers — those read refs and the load window
        // is brief and non-interactive — which also keeps this off the React
        // Compiler's "ref passed to a render-time function" path.
        rightPanel = (
          <>
            <ResizableHandle withHandle disabled />
            <ResizablePanel
              id="doc-panel"
              defaultSize={initialRightCollapsed ? 0 : `${initialDocPanelWidthPx}px`}
              minSize={DOC_PANEL_MIN_SIZE}
              maxSize={DOC_PANEL_MAX_SIZE}
              collapsible
              collapsedSize={0}
              inert
              className="flex flex-col bg-muted/20"
            >
              {/* Visual-only filler. `inert` removes this subtree from the a11y
                  tree + focus order, so a live-region role/aria-busy here would
                  be dead ARIA — the skeleton in the left column is the announced
                  loading state. Mirrors the real doc-panel (no ARIA on children
                  under its own `inert`). */}
              <div className="min-h-0 flex-1" />
            </ResizablePanel>
          </>
        );
      } else {
        // Genuine cold start (group never mounted; no docked terminal alive yet)
        // or the web host (no dock to preserve): keep the standalone early return
        // OUTSIDE the shared horizontal panel group, so when the doc lands its
        // group mounts fresh with the doc panel already present. Routing it
        // through the group here would render one panel and then ADD the doc
        // panel — a 1→3 panel-count transition that corrupts react-resizable-
        // panels' doc-panel pixel-width sticky restore.
        return <EditorSkeleton />;
      }
    } else if (isSkillsNewTabId(activeNewTabId) || skillsSidebar) {
      // In Skills mode the empty/base state IS the Skills base page ("Create a
      // skill") — the sidebar toggle keeps the current doc open and only swaps
      // this base surface, so with no doc active we show Skills' home instead of
      // the Files "Create something great" one. Same page a Skills-mode new tab
      // renders.
      // Same signal the Files empty state below keys off: an open dock already
      // carries an AI entry point, so the Skills composer would compete with it.
      viewContent = <SkillsBasePage sessionsDockOpen={terminalVisible} />;
    } else {
      // The empty state collapses to the header-only view while EITHER session
      // panel is open — an open panel is its own AI entry point, so the composer
      // bubble + starter packs would compete with it. Which panel picks the
      // header pose (bottom-anchored above the dock; centered beside the column).
      viewContent = <EmptyEditorState terminalOpen={terminalVisible} agentsOpen={agentsVisible} />;
    }
  } else {
    const isSourceMode = editorMode === 'source';
    const sourceDisabled = !isConnected;

    const isPanelCollapsed = isCollapsed;

    function openAddPropertyForm() {
      if (!activeDocName) return;
      requestAddProperty(activeDocName);
    }

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
    const editorContent = (
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
          EditorActivityPool keeps Tiptap eager and lazy-loads SourceEditor on
          the first source-mode visit for each doc, then preserves the per-doc
          display:none toggle after that initial load. Each Activity entry owns
          its own scroll container so scroll position is DOM-local to that
          doc's subtree and survives the Activity hidden-mode mount/unmount cycle.

          Error + Suspense scoping lives INSIDE EditorActivityPool — each
          Activity wraps its own DocumentErrorBoundary + Suspense so a
          hidden doc's cached rejected syncPromise cannot re-throw into
          the visible UI. See EditorActivityPool.tsx file
          docstring "ERROR + SUSPENSE SCOPING" for rationale. */}
          <div className="relative h-full">
            <EditorActivityPool
              // Fall back to the urgent `activeDocName` when the deferred
              // value is still null (initial load, before the first
              // deferred-commit pass populates it). The
              // `!activeProvider || !activeDocName` null-guard above already
              // short-circuits with skeleton/empty-state when `activeDocName`
              // itself is null, so we can assert non-null here.
              activeDocName={deferredActiveDocName ?? activeDocName}
              isSourceMode={isSourceMode}
              editorPlaceholder={editorPlaceholder}
              previousDocName={previousDocName ?? undefined}
              onNavigateBack={navigateBackToDoc}
              onRecycle={recycleDocument}
            />
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
          {!isConflict && (
            <EditorToolbar
              activeDocName={activeDocName}
              isSourceMode={isSourceMode}
              sourceDisabled={sourceDisabled}
              onModeChange={onModeChange}
              showAddPropertyButton={!isSourceMode}
              onAddProperty={openAddPropertyForm}
              frontmatterProblems={missingProperties}
              isPanelCollapsed={isPanelCollapsed}
              onTogglePanel={togglePanel}
              // When the doc panel is collapsed, the action cluster reaches the
              // far-right corner where the agents reveal tab sits — shift it left
              // so the three stay in one row instead of overlapping.
              reserveRightGutter={rightRevealTabPresent && isPanelCollapsed}
            />
          )}
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

    viewContent = editorContent;
    // While the agents column is open and the doc panel is closed, the
    // collapsed doc panel sits as a zero-width flex neighbor between the editor
    // and the agents column. Its own handle is disabled whenever it is collapsed
    // (see the ResizableHandle below), but drags on the TERMINAL's handle still
    // route through the collapsed panel: the library snap-expands it once the
    // drag crosses half its min size, instead of returning the space to the
    // editor. Neutralize the panel itself: `disabled` makes drag redistribution
    // skip it (deltas flow through to the editor) and `minSize 0` disarms the
    // snap-expand threshold. Imperative paths (`setLayout`, `expand`) still
    // move it, so the toolbar toggle keeps working. Scoped to
    // agents-column-present: without that column no drag can reach the
    // collapsed panel at all.
    const docPanelNeutralized = agentsColumnPresent && isCollapsed;
    rightPanel = (
      <>
        <ResizableHandle
          // No visible grip while collapsed — there is nothing to drag.
          withHandle={!isCollapsed}
          // A collapsed panel is not drag-resizable: the toolbar toggle and
          // ⌥⌘B are its single open mechanism (mirrors TerminalDock's
          // hidden-dock handle and the agents column, which unmounts its
          // handle entirely when hidden). Disabling while collapsed also
          // keeps this handle from overlapping the agents column's
          // handle at the same pixel seam, and from being a misclick target
          // under embedded AI-editor hosts whose own container chrome sits at
          // the iframe edge.
          disabled={isCollapsed}
          onPointerDown={() => {
            setIsDraggingDocHandle(true);
            isDraggingDocHandleRef.current = true;
            const handleUp = () => {
              setIsDraggingDocHandle(false);
              isDraggingDocHandleRef.current = false;
              window.removeEventListener('pointerup', handleUp);
            };
            window.addEventListener('pointerup', handleUp);
          }}
        />
        <ResizablePanel
          id="doc-panel"
          panelRef={panelRef}
          disabled={docPanelNeutralized}
          defaultSize={initialRightCollapsed ? 0 : `${initialDocPanelWidthPx}px`}
          minSize={docPanelNeutralized ? '0px' : DOC_PANEL_MIN_SIZE}
          maxSize={DOC_PANEL_MAX_SIZE}
          collapsible
          collapsedSize={0}
          onResize={(size) => {
            setIsCollapsed(size.asPercentage === 0);
            // Persist only when this resize came from a user drag — RO-driven
            // recomputes (sticky width restoration) also fire onResize, but
            // they're replaying the persisted value and must NOT overwrite it.
            if (size.inPixels > 0 && isDraggingDocHandleRef.current) {
              docPanelWidthPxRef.current = size.inPixels;
              debouncedWriteDocPanelWidth(size.inPixels);
            }
          }}
          // react-resizable-panels does NOT apply inert/aria-hidden/display:none when
          // a panel collapses (verified against the installed runtime) — children stay
          // in DOM, in Tab order, and announced by screen readers. `inert` removes the
          // collapsed subtree from the a11y tree and focus order without remounting.
          inert={isCollapsed}
          className={cn(
            'flex flex-col bg-muted/20',
            !isDraggingDocHandle &&
              'transition-[flex-grow] duration-200 ease-out motion-reduce:transition-none motion-reduce:duration-0',
          )}
        >
          <DocPanel
            docName={activeDocName}
            isSourceMode={isSourceMode}
            activeTab={activeTab}
            onActiveTabChange={onActiveTabChange}
            mode={docPanelMode}
          />
        </ResizablePanel>
      </>
    );
  }

  // A single TerminalDock wraps the active view's left column. The skeleton
  // below is structurally identical for every view kind, so the dock keeps one
  // React position and its PTY survives tab switches and view-kind changes. It
  // renders on every host; where no shell can spawn it simply stays collapsed.
  // The live session host lives in EditorPane (above this component) so a
  // view-kind change — which remounts EditorArea's subtree — can't re-spawn it.
  // Here we render only the bottom layout
  // shell, which reports its mount + editor region up (via onSessionPlacements).
  const leftColumn = (
    <TerminalDock
      visible={terminalVisible}
      onVisibleChange={onTerminalVisibleChange ?? (() => {})}
      onBottomContainer={setBottomTerminalContainer}
      onEditorRegion={setTerminalEditorRegion}
    >
      {viewContent}
    </TerminalDock>
  );

  // The terminal column sits to the RIGHT of the doc/agent panel
  // (MD | PANE | AGENTS) — the far-right column, its own independent resizable
  // column rather than a tenant of the panel region. The mount div is a callback
  // ref so the session host (owned in EditorPane) portals into it; it unmounts to
  // null when the panel hides.
  const agentsColumn = agentsColumnPresent ? (
    <>
      <ResizableHandle
        withHandle
        onPointerDown={() => {
          setIsDraggingAgentsHandle(true);
          isDraggingAgentsHandleRef.current = true;
          const handleUp = () => {
            setIsDraggingAgentsHandle(false);
            isDraggingAgentsHandleRef.current = false;
            window.removeEventListener('pointerup', handleUp);
            // Drag-to-close: releasing with the column snapped shut hides the
            // agents panel (unmounting the column), mirroring the doc panel's
            // drag-to-close affordance. Deferred to pointerup — hiding
            // mid-drag would unmount the separator under the active drag.
            if (agentsColumnPanelRef.current?.isCollapsed()) {
              onAgentsVisibleChange?.(false);
            }
          };
          window.addEventListener('pointerup', handleUp);
        }}
      />
      <ResizablePanel
        id="agents-column"
        panelRef={agentsColumnPanelRef}
        defaultSize={`${initialAgentsWidthPx}px`}
        minSize={`${MIN_AGENTS_PANEL_WIDTH}px`}
        // The panel can be dragged wide — up to 95% of the group — leaving the
        // editor a 5% sliver (its panel `minSize` while this column is mounted).
        // Pair the two: this max plus the editor's min must sum to 100% or the
        // drag can't reach it. Mirrors the bottom dock's 95%/5% split.
        maxSize="95%"
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
        }}
        className={cn(
          'flex flex-col',
          !isDraggingAgentsHandle &&
            'transition-[flex-grow] duration-200 ease-out motion-reduce:transition-none motion-reduce:duration-0',
        )}
      >
        {/* Mount point for the agents host's stable host div. */}
        <div ref={setAgentsContainer} className="flex min-h-0 flex-1 flex-col overflow-hidden" />
      </ResizablePanel>
    </>
  ) : null;

  // The editor absorbs the residual width whenever something on the right claims
  // space — the doc panel (when present and not collapsed) or the agents column.
  const editorAbsorbsResidual =
    (rightPanel != null && !initialRightCollapsed) || agentsColumnPresent;

  // The agents reveal tab pins to the far-right column edge here; the terminal's
  // tab lives inside TerminalDock, pinned to the bottom of the editor column.
  // (Each gated by its own predicate above; both can be up at once.)

  // Order: EDITOR | doc/agent panel | agents column. The agents panel is the
  // far-right column, so it renders AFTER `rightPanel`.
  return (
    <div
      className="relative flex min-h-0 flex-1"
      ref={(el) => {
        setGroupContainerEl(el);
        groupContainerElRef.current = el;
      }}
    >
      <ResizablePanelGroup
        orientation="horizontal"
        groupRef={groupRef}
        data-dragging={isDraggingDocHandle || isDraggingAgentsHandle || undefined}
      >
        <ResizablePanel
          // No explicit id: an id here changed how react-resizable-panels
          // redistributes on imperative resize and broke the doc-panel
          // pixel-width sticky restore. The
          // left panel is always the first child, so React keeps it mounted
          // across right-side toggles without one (the terminal still persists).
          //
          // With the terminal column mounted the editor yields to a 5% sliver so
          // the terminal can be dragged near-full width without ever fully
          // eclipsing the editor — the horizontal mirror of the bottom dock's
          // 95%/5% split (see the terminal column's maxSize below; the pair must
          // sum to 100% or the drag can't reach the max). Without the terminal
          // the 30% floor keeps the editor usable against the doc panel.
          minSize={agentsColumnPresent ? '5%' : '30%'}
          // Editor takes full width only when nothing on the right claims space;
          // otherwise it absorbs the residual while the pixel-sized doc panel and
          // terminal column hold their widths.
          {...(editorAbsorbsResidual ? {} : { defaultSize: '100%' })}
          className={cn(
            !(isDraggingDocHandle || isDraggingAgentsHandle) &&
              'transition-[flex-grow] duration-200 ease-out motion-reduce:transition-none motion-reduce:duration-0',
          )}
        >
          {leftColumn}
        </ResizablePanel>
        {rightPanel}
        {agentsColumn}
      </ResizablePanelGroup>
      {rightRevealTabPresent ? (
        // Pinned to the far-right top, vertically in line with the toolbar's
        // action buttons. When the doc panel is collapsed those buttons reach this
        // same corner; the toolbar shifts its cluster left (reserveRightGutter) so
        // all three sit in one row rather than overlapping.
        <TerminalRevealTab edge="right" onReveal={onRevealAgents} className="top-2.5 right-0" />
      ) : null}
    </div>
  );
}
