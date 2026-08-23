// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { humanFormat } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ChevronRight,
  Copy,
  FilePlus,
  FolderOpen,
  FolderPlus,
  FoldVertical,
  ListCollapse,
  Share2,
  SquarePen,
  UnfoldVertical,
} from 'lucide-react';
import { type FC, type MouseEventHandler, useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { toast } from 'sonner';
import { ConflictsSection } from '@/components/ConflictsSection';
import { FeedbackCardMount } from '@/components/FeedbackCard';
import { FileTree, type FileTreeHandle } from '@/components/FileTree';
import { defaultInitialDir, hasOkPathSegment } from '@/components/file-tree-utils';
import { subscribeToFilesSectionReveal } from '@/components/files-section-reveal-store';
import { OpenInAgentEmptySpaceSubmenu } from '@/components/handoff/OpenInAgentEmptySpaceSubmenu';
import { useTerminalLaunch } from '@/components/handoff/TerminalLaunchContext';
import {
  buildProjectScopedHandoffInput,
  openInstallUrl,
  startAgentThreadForInput,
  useHandoffDispatch,
} from '@/components/handoff/useHandoffDispatch';
import { useInstalledAgents } from '@/components/handoff/useInstalledAgents';
import { NavigationHistoryControls } from '@/components/NavigationHistoryControls';
import { OnboardingCardMount } from '@/components/OnboardingCard';
import { ProjectSwitcher } from '@/components/ProjectSwitcher';
import { onPillRenderError, SidebarSearchBar } from '@/components/SidebarSearchBar';
import {
  SidebarToolbarButton as ToolbarButton,
  type SidebarToolbarButtonProps as ToolbarButtonProps,
} from '@/components/SidebarToolbarButton';
import { SkillsSidebarDock } from '@/components/SkillsSidebarDock';
import {
  readCachedSkillsSectionVisible,
  writeCachedSkillsSectionVisible,
} from '@/components/skills-section-visible-cache';
import { TemplateMenuRows } from '@/components/template-menu-rows';
import { UpdateNotices } from '@/components/UpdateNotices';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDocumentContext } from '@/editor/DocumentContext';
import { useFolderConfig } from '@/hooks/use-folder-config';
import { useGitSyncStatusDetailed } from '@/hooks/use-git-sync-status';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import { useEnabledOverrides } from '@/lib/acp/enabled-agents';
import {
  enabledDesktopTargets,
  enabledTerminalClis,
  enabledThreadAgents,
  resolveLauncherSelection,
  unresolvedDesktopTargets,
} from '@/lib/acp/launcher-selection';
import {
  pickEffectiveDefaultAgent,
  useDefaultRegisteredAgent,
  useRegisteredAgents,
} from '@/lib/acp/registered-agents';
import { useConfigContext } from '@/lib/config-provider';
import { subscribeToCreateTopLevelFile } from '@/lib/create-file-events';
import {
  buildSendToAiInputForActiveTarget,
  resolveActiveTargetAbsPath,
  resolveActiveTargetRelativePath,
} from '@/lib/file-menu-target-resolvers';
import {
  emitFileTreeMenuActionDelete,
  emitFileTreeMenuActionDuplicate,
  emitFileTreeMenuActionRename,
} from '@/lib/file-tree-menu-action-events';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';
import { ProfilerBoundary } from '@/lib/perf';
import { revealInFileManagerLabel } from '@/lib/platform-labels';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';
import { buildFolderShareInput, runShareAction } from '@/lib/share/run-share-action';
import { useStickyAgent } from '@/lib/unified-agent-store';
import { useWorkspace } from '@/lib/use-workspace';
import { cn } from '@/lib/utils';
import { setViewMenuState } from '@/lib/view-menu-state-store';

interface FileSidebarProps {
  onOpenSearch: () => void;
}

const EMPTY_FOLDER_STATE: { folderCount: number; expandedCount: number } = {
  folderCount: 0,
  expandedCount: 0,
};

// Selector for interactive controls inside the sidebar surface that opt out
// of the sidebar-wide context menu. Right-click anywhere else inside the
// sidebar (toolbar background, search-pill chrome, tree-empty area, footer
// chrome) fires the empty-space menu via the ContextMenuTrigger wrapping the
// Sidebar; matching this selector triggers preventDefault + stopPropagation
// instead — buttons silently do nothing on right-click, matching native
// macOS conventions. Pierre tree rows are `<button>` elements (rendered by
// `@pierre/trees`) so they also match; Pierre's own row contextmenu
// (composition.contextMenu) opens its dropdown menu first via preventDefault,
// and this handler then suppresses the sidebar empty-space menu from also
// firing on the same event — preventing a double-menu collision.
const SIDEBAR_INTERACTIVE_CONTROL_SELECTOR =
  'button, [role="button"], [role="menuitem"], input, textarea, select, a[href]';

export function isInteractiveSidebarControl(target: EventTarget | null): boolean {
  // `typeof Element` guard supports running this in non-DOM contexts (Bun's
  // unit-test runner, where the renderer's React component never mounts but
  // the module-level export is still importable for shape testing). In a
  // real browser / Electron renderer, `Element` is always defined; the
  // instanceof check is the meaningful gate that catches non-Element
  // EventTargets (Notification, XMLHttpRequest, WebSocket — irrelevant to
  // onContextMenu in practice, but the EventTarget type permits them).
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return target.closest(SIDEBAR_INTERACTIVE_CONTROL_SELECTOR) !== null;
}

export function FileSidebar({ onOpenSearch }: FileSidebarProps) {
  return (
    <ProfilerBoundary name="file-sidebar">
      <FileSidebarInner onOpenSearch={onOpenSearch} />
    </ProfilerBoundary>
  );
}

const ToolbarDropdownTrigger: FC<ToolbarButtonProps> = ({ icon: Icon, label, ...props }) => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={label} {...props}>
            <Icon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
};

function FileSidebarInner({ onOpenSearch }: FileSidebarProps) {
  const { t } = useLingui();
  // Imperative handle to the FileTree — header buttons (Expand-All / Collapse-
  // All in the dropdown menu) call methods directly. Stored as React state
  // (not a ref) and wired via a ref-callback below so the parent re-renders
  // exactly when the child's `useImperativeHandle` attaches; that re-render
  // is what re-runs the subscription effect with a non-null handle.
  const [tree, setTree] = useState<FileTreeHandle | null>(null);

  // Active-doc context drives the create buttons' parent dir so the template
  // cascade resolves with folder-scoped templates included. Without this the
  // sidebar's top-bar create buttons hard-coded parentDir='' and the picker
  // only saw root templates, missing local/inherited templates from
  // wherever the user was actually working. Mirrors App.tsx's NewItemShortcut
  // and CommandPalette's resolveCreateInitialDir.
  //
  // `activeTarget` is also the routing input for the macOS File menu's
  // state-aware items (Duplicate / Rename / Move to Trash / Reveal in Finder / Send to
  // AI / Copy path) — each `onMenuAction` case below reads it to know
  // which doc / folder / asset / project the user picked.
  const { activeDocName, activeTarget } = useDocumentContext();
  // The active item's folder is the default create parent — but clicking the
  // tree's empty space "deselects" for creation purposes (FileTree owns that
  // state; `treeCreationCleared` mirrors it below), routing New file / New
  // folder / the template cascade to the project root while the editor keeps
  // showing the open doc. Every `initialCreateDir` consumer is creation-scoped
  // (toolbar, template cascade, File-menu new-*), so overriding here covers all
  // of them; active-item actions (Duplicate / Rename / …) read `activeTarget`.
  const activeCreateDir =
    activeTarget?.kind === 'folder' || activeTarget?.kind === 'folder-index'
      ? activeTarget.folderPath
      : defaultInitialDir(activeDocName);
  // Revealed `.ok` rows are read-only OK-managed state — never a create
  // target. Fall back to the workspace root (the same dir an empty-space
  // deselect resolves to); the server's reserved-path rejection stays the
  // authoritative backstop.
  const baseCreateDir = hasOkPathSegment(activeCreateDir) ? '' : activeCreateDir;
  const [treeCreationCleared, setTreeCreationCleared] = useState(false);
  const initialCreateDir = treeCreationCleared ? '' : baseCreateDir;

  // Detection idiom matches OpenInAgentMenu / FileTree / EditorHeader. In
  // Electron mode the SidebarFooter's ProjectSwitcher already carries the
  // project's contextual identity, so the SidebarHeader stays minimal — just
  // action buttons on the right, draggable empty space on the left where the
  // traffic lights sit. Web mode keeps the 'Files' section label since there's
  // no ProjectSwitcher and no chrome row to anchor against.
  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;

  // Collapsed sidebar = focus mode: hide the section label so the chrome row
  // doesn't reintroduce the visual noise the user explicitly removed.
  // `toggleSidebar` is the same primitive bound to the SidebarTrigger rail —
  // the menu-action handler below dispatches it for `'toggle-sidebar'`, fired
  // by the native View → Show/Hide Sidebar menu item (⌥⌘S).
  const { state: sidebarState, toggleSidebar } = useSidebar();
  const isEmbedded = useIsEmbedded();
  const isExpanded = sidebarState === 'expanded';
  const isCollapsed = sidebarState === 'collapsed';
  // Single source of truth for the chrome-row opacity gate. Driving both
  // the SidebarHeader's toolbar row AND the sibling pill row off the same
  // boolean makes the lockstep-fade invariant a structural property
  // (one variable, two consumers) instead of a copy-paste relationship
  // between the two className blocks. A refactor that wraps one row in
  // a memoization or conditional renderer can't silently desync the fade
  // start time when both sides read the same expression.
  const shouldFadeChrome = isElectronHost && isCollapsed;

  // Reactive subscription to FileTree's folder state. Drives the smart-hide
  // of the Expand/Collapse-all commands across the tree-options popover, the
  // empty-space menu, and the native View menu:
  //   - both hidden when there are no folders (each would be a no-op)
  //   - "Expand all" hidden when every folder is already expanded
  //   - "Collapse all" hidden when every folder is already collapsed
  //
  // History of the failure shape this fixes: the original useSyncExternalStore
  // form held the FileTree handle as a ref. `fileTreeRef.current` was null at
  // parent-render time (the child's `useImperativeHandle` only attaches in
  // commit, after parent render finishes), so the subscribe arrow returned a
  // no-op `() => {}` and the store never registered a real listener. The
  // subsequent useEffect rewrite kept the ref pattern with `if (tree === null)
  // return` — same race shape: effect runs once on mount with empty deps, the
  // handle is non-null in commit phase, but the effect's closure captured the
  // ref read AT EFFECT TIME and bailed; no re-subscribe ever happens. Visible
  // symptom both times (under the trigger's then-standing hasFolders gate):
  // dropdown trigger hidden on cold launch even when folders existed.
  //
  // The fix below uses `useState` + a ref-callback (`setTree`). React invokes
  // the ref-callback synchronously during commit when the child's
  // `useImperativeHandle` resolves, which schedules a re-render of this
  // parent; the effect with `[tree]` deps then runs against the resolved
  // handle, seeds `folderState` from `getFolderState()`, and subscribes for
  // change notifications. Subsequent renders that re-create the handle (e.g.,
  // FileTree's `useImperativeHandle` factory re-runs) trigger another effect
  // cycle: cleanup unsubscribes the old listener, then the body re-subscribes
  // through the new handle. No race, no stale closure.
  const [folderState, setFolderState] = useState(EMPTY_FOLDER_STATE);

  useEffect(() => {
    if (tree === null) return;
    const sync = () => {
      setFolderState(tree.getFolderState());
      setTreeCreationCleared(tree.isCreationTargetCleared());
    };
    sync();
    return tree.subscribe(sync);
  }, [tree]);

  // Cross-component "create a file" handler. EmptyEditorState fires this
  // event from its primary "New file" CTA, the "or start from scratch" link,
  // and the template-picker rows. We route to the same FileTree primitives
  // the sidebar toolbar uses (`startCreating` / `createFromTemplate`) so the
  // inline-rename / busy-path / navigation flow stays consistent.
  useEffect(() => {
    if (tree === null) return;
    return subscribeToCreateTopLevelFile((request) => {
      const dir = request.initialDir ?? '';
      if (request.template) {
        tree.createFromTemplate(request.template.folder, request.template.name);
        return;
      }
      tree.startCreating(request.kind ?? 'file', dir);
    });
  }, [tree]);
  const hasFolders = folderState.folderCount > 0;
  const allExpanded = hasFolders && folderState.expandedCount === folderState.folderCount;
  const noneExpanded = folderState.expandedCount === 0;

  // Default optimistic-true while loading. The alternative paints the
  // button hidden, then pops it in once the fetch resolves and shifts
  // the surrounding icons — a CLS-style jump on every cold load.
  //
  // Two scopes because the two surfaces create in two different places: the
  // toolbar's "New from template" creates in the ACTIVE folder
  // (`initialCreateDir`), so its gate must read that folder's resolved
  // cascade — folder-local + inherited templates surface when working inside
  // a subfolder, even when the project root ships none. The empty-space menu
  // creates at the project root, so it stays root-scoped.
  const rootFolderConfig = useFolderConfig('');
  // When the active folder IS the project root (the common default), reuse the
  // root fetch instead of issuing an identical second request — useFolderConfig
  // has no cross-instance cache, so a duplicate path would double-fetch. The
  // hook is still called unconditionally (null path → idle, no fetch) to keep
  // hooks-call order stable.
  const activeFolderSelfFetch = useFolderConfig(initialCreateDir === '' ? null : initialCreateDir);
  const activeFolderConfig = initialCreateDir === '' ? rootFolderConfig : activeFolderSelfFetch;
  const rootHasTemplates =
    rootFolderConfig.state.status === 'ready'
      ? (rootFolderConfig.state.data.folder.templates_available?.length ?? 0) > 0
      : true;
  const activeFolderHasTemplates =
    activeFolderConfig.state.status === 'ready'
      ? (activeFolderConfig.state.data.folder.templates_available?.length ?? 0) > 0
      : true;

  // Empty-space menu wiring. Workspace drives the disabled-with-hint state
  // for the act-on-project items; install states + dispatch drive the Send
  // to AI submenu; the project-local binding drives the visibility
  // checkboxes (checked from the merged config; null binding disables). The
  // bridge is required for the Electron-only items (Reveal in
  // Finder) — those rows return null in web mode via the
  // `if (!bridge) return null` cross-cutting pattern. Copy full path is
  // visible in both modes (`navigator.clipboard.writeText` is Baseline
  // Widely Available since March 2020).
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const workspace = useWorkspace();
  // The section is headed by the project name — desktop carries it on the
  // bridge config; web falls back to the contentDir's leaf folder.
  const projectName =
    bridge?.config?.projectName ||
    workspace?.contentDir.split('/').filter(Boolean).pop() ||
    t`Files`;
  // Gates the project-root menu's Share item — only shown with a GitHub remote.
  const { status: gitSyncStatus } = useGitSyncStatusDetailed();
  const hasRemote = gitSyncStatus?.hasRemote === true;
  const handoffInstallStates = useInstalledAgents().states;
  const { dispatch: dispatchHandoff } = useHandoffDispatch();
  const emptySpaceHandoffInput = buildProjectScopedHandoffInput({ workspace });
  // Inputs to the shared launcher contract, for the native File → Open with AI
  // action below. All five are `useSyncExternalStore` snapshots (or a context
  // value), so they stay referentially stable between real changes and can sit
  // in the menu-action effect's dependency list without re-subscribing it every
  // render. The selection itself is resolved inside the handler, at click time.
  const terminalLaunch = useTerminalLaunch();
  const enabledOverrides = useEnabledOverrides();
  const registeredAgents = useRegisteredAgents();
  const defaultRegisteredAgent = useDefaultRegisteredAgent();
  const stickyAgentId = useStickyAgent();
  const { projectLocalBinding, merged } = useConfigContext();
  const showHiddenFiles = merged?.appearance?.sidebar?.showHiddenFiles ?? false;
  const showOkFolders = merged?.appearance?.sidebar?.showOkFolders ?? false;
  const showOnlyMarkdownFiles = merged?.appearance?.sidebar?.showOnlyMarkdownFiles ?? false;
  // Defaults true, matching the schema — the switch exists because grouping
  // changes the tree for every existing user and is not obviously better on a
  // small library, not because we expect it to be turned off.
  const showSkillGroups = merged?.appearance?.sidebar?.showSkillGroups ?? true;
  // Until the config CRDT syncs after a reload, `showSkillsSection` is undefined.
  // Fall back to the last explicitly-stored value (localStorage mirror) before
  // `?? true`, so the Files/Skills switcher doesn't flash-then-hide for anyone
  // who has the section turned off. Persist the authoritative value
  // once the config carries one so the next reload is flash-free.
  // Controlled rather than `defaultOpen` so the Skills dock below can tell
  // whether anything above it is still claiming the sidebar's slack. Collapsing
  // Files used to leave that space empty with the dock clipped mid-row.
  const [filesOpen, setFilesOpen] = useState(true);
  // A doc-opening surface outside this section (the symlinked-skill banner's
  // Open file) asked for the file browser: expand Files so the tree's
  // reveal-active-row effect has somewhere to scroll the newly active doc.
  useEffect(() => subscribeToFilesSectionReveal(() => setFilesOpen(true)), []);
  const configSkillsSection = merged?.appearance?.sidebar?.showSkillsSection;
  const showSkillsSection = configSkillsSection ?? readCachedSkillsSectionVisible() ?? true;
  useEffect(() => {
    if (configSkillsSection !== undefined) writeCachedSkillsSectionVisible(configSkillsSection);
  }, [configSkillsSection]);
  // Smart-hide gates for the Expand/Collapse-all tree-state items, shared by
  // the toolbar popover, the empty-space menu, and the native View menu (via
  // the IPC push below): hide when the action would be a no-op (no folders at
  // all; every folder already in the target state). Neither in-renderer menu
  // carries a separator around the section when both items hide.
  const showExpandAll = hasFolders && !allExpanded;
  const showCollapseAll = hasFolders && !noneExpanded;
  const showTreeStateSection = showExpandAll || showCollapseAll;
  const suppressCreateMenuFocusRestoreRef = useRef(false);
  const handleCreateMenuCloseAutoFocus = (event: Event) => {
    if (!suppressCreateMenuFocusRestoreRef.current) return;
    suppressCreateMenuFocusRestoreRef.current = false;
    // Radix would otherwise steal focus back from the inline rename input.
    event.preventDefault();
  };

  // Sidebar-wide context-menu surface. Right-click anywhere inside the
  // sidebar except interactive controls (toolbar buttons, search-pill button,
  // project switcher trigger, Pierre tree rows, sidebar rail) opens the
  // empty-space menu. The wrapper div hosts the bubble-phase opt-out: when
  // the event target is a button-like control, suppress both the browser
  // default menu and Radix's ContextMenuTrigger from firing.
  const handleSidebarSurfaceContextMenu: MouseEventHandler<HTMLDivElement> = (event) => {
    // The project-root header is deliberately right-clickable: it opens the
    // project-scoped menu. It is also a CollapsibleTrigger, which Radix renders
    // as a <button> — so without this opt-out the interactive-control check
    // below swallows it and the menu never opens.
    if (
      event.target instanceof Element &&
      event.target.closest('[data-sidebar-root-context]') !== null
    ) {
      return;
    }
    if (isInteractiveSidebarControl(event.target)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // Empty-space-menu actions. Inline rather than per-item closures so the
  // structure of the JSX stays focused on layout, and the React Compiler can
  // see one set of stable identities across renders.
  const handleEmptySpaceCreateFile = () => {
    if (!workspace) return;
    suppressCreateMenuFocusRestoreRef.current = true;
    tree?.startCreating('file', '');
  };
  const handleEmptySpaceSelectTemplate = (templateName: string) => {
    if (!workspace) return;
    suppressCreateMenuFocusRestoreRef.current = true;
    tree?.createFromTemplate('', templateName);
  };
  const handleEmptySpaceCreateFolder = () => {
    if (!workspace) return;
    suppressCreateMenuFocusRestoreRef.current = true;
    tree?.startCreating('folder', '');
  };
  const handleEmptySpaceReveal = () => {
    if (!workspace || !bridge) return;
    void bridge.shell.showItemInFolder(workspace.contentDir);
  };
  const handleEmptySpaceCopyFullPath = async () => {
    if (!workspace) return;
    try {
      await navigator.clipboard.writeText(workspace.contentDir);
      toast.success(t`Copied full path`, { description: workspace.contentDir });
    } catch (err) {
      console.warn('[FileSidebar] clipboard write failed:', err);
      toast.error(t`Could not copy full path`);
    }
  };
  // Share the project root (empty-string folderPath = content-root sentinel).
  const handleEmptySpaceShare = () => {
    void runShareAction(
      {
        ...buildFolderShareInput(''),
        hasRemote,
        onClickWhenNoRemote: () => {
          toast.error(t`Connect this project to GitHub to share.`);
        },
      },
      {
        clipboardWrite: scheduleClipboardWrite,
        toastSuccess: (msg) => toast.success(msg),
        toastError: (msg) => toast.error(msg),
        logEvent: (msg) => console.log(msg),
      },
    );
  };
  // Single write path for the sidebar visibility checkboxes (toolbar popover,
  // empty-space menu, native View menu action): every toggle patches the same
  // project-local config shape and surfaces rejections with the same toast.
  const patchSidebarVisibility = (sidebar: {
    showHiddenFiles?: boolean;
    showOkFolders?: boolean;
    showOnlyMarkdownFiles?: boolean;
    showSkillsSection?: boolean;
    showSkillGroups?: boolean;
  }) => {
    if (projectLocalBinding === null) return;
    const result = projectLocalBinding.patch({ appearance: { sidebar } });
    if (!result.ok) {
      console.warn('[FileSidebar] sidebar visibility toggle rejected:', humanFormat(result.error));
      toast.error(t`Could not update sidebar settings`, {
        description: humanFormat(result.error),
      });
    }
  };
  const handleEmptySpaceExpandAll = () => {
    tree?.expandAll();
  };
  const handleEmptySpaceCollapseAll = () => {
    tree?.collapseAll();
  };

  // Push the View menu's checkbox + smart-hide state to main so the macOS
  // View menu reflects the merged-config visibility flags and Expand all /
  // Collapse all smart-hide when the tree state makes them no-ops. Sibling
  // of `ActiveTargetBridgePush` in App.tsx; deps cover BOTH visibility
  // changes (CRDT-pushed) AND tree-state transitions (Pierre model emits
  // via the tree.subscribe path that already updates `folderState`). The
  // bridge gate keeps web mode a no-op. `canExpandAll` / `canCollapseAll`
  // are the same shared smart-hide gates the in-renderer menus render from,
  // so every surface agrees on what counts as a no-op action.
  // `sidebarVisible` flips the View → Show/Hide Sidebar label main-side.
  useEffect(() => {
    const snapshot = {
      showHiddenFiles,
      showOkFolders,
      showOnlyMarkdownFiles,
      showSkillsSection,
      canExpandAll: showExpandAll,
      canCollapseAll: showCollapseAll,
      sidebarVisible: sidebarState === 'expanded',
    };
    // Mirror into the renderer store unconditionally (works on web) so the
    // Cmd+K palette can render state-reflecting toggle labels. The bridge push
    // below is desktop-only (drives the native View menu's Show/Hide labels).
    setViewMenuState(snapshot);
    if (!bridge) return;
    bridge.editor.notifyViewMenuStateChanged(snapshot);
  }, [
    bridge,
    showHiddenFiles,
    showOkFolders,
    showOnlyMarkdownFiles,
    showSkillsSection,
    showExpandAll,
    showCollapseAll,
    sidebarState,
  ]);

  // macOS menu-action subscriber. Main fires `ok:menu-action` for every
  // user click on a state-aware File menu item or a View menu toggle /
  // tree-state item. This effect is the sole renderer-side dispatcher: each
  // case maps the action ID to the same primitive the corresponding sidebar
  // context menu or toolbar button already uses, so the menu surface stays
  // in lockstep with the in-renderer surfaces without a second source of
  // truth. Web-host short-circuits when the bridge is absent.
  //
  // Routes:
  //   - new-doc / new-folder / new-from-template — tree?.startCreating(...) /
  //     startCreatingFromTemplate(...), parentDir = active folder (when
  //     folder scope) else workspace root, matching the toolbar's
  //     `initialCreateDir` derivation.
  //   - duplicate / rename — same path as the FileTree row actions via the
  //     event bus; FileTree owns the per-kind target resolution.
  //   - move-to-trash — same path as the FileTree row's Delete via the
  //     event bus.
  //   - reveal-in-finder — bridge.shell.* against the
  //     resolved absolute path per scope.
  //   - send-to-ai — the shared launcher selection against the right input
  //     builder per scope (file / folder / project; assets intentionally no-op).
  //   - copy-full-path / copy-relative-path — navigator.clipboard writes
  //     the absolute / project-relative path.
  //   - toggle-show-* / expand-all-tree / collapse-all-tree — same
  //     primitives the empty-space menu handlers already use.
  //
  // Deps are deliberately the full readable surface — the effect re-binds
  // whenever any input the routing depends on changes, so the handler
  // closure always sees the latest `activeTarget`, `workspace`, etc.
  // without stale-closure bugs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: patchSidebarVisibility is behaviorally stable — it reads only projectLocalBinding + t, both already deps; listing the helper itself would re-create the subscription every render (sibling pattern: CommandPalette's refreshSemanticStatus).
  useEffect(() => {
    return subscribeLocalMenuAction((action) => {
      // Revealed `.ok` targets are read-only: the mutating picks below
      // (rename / duplicate / move-to-trash) quietly no-op on them, mirroring
      // the row menu's suppressed affordances. The server's reserved-path
      // rejection stays the authoritative backstop; read-only routes (reveal,
      // copy path, send-to-ai) keep working.
      const isOkManagedTarget =
        activeTarget !== null && hasOkPathSegment(resolveActiveTargetRelativePath(activeTarget));
      switch (action) {
        case 'new-doc': {
          if (!workspace || !tree) return;
          tree.startCreating('file', initialCreateDir);
          return;
        }
        case 'new-folder': {
          if (!workspace || !tree) return;
          tree.startCreating('folder', initialCreateDir);
          return;
        }
        case 'new-from-template': {
          if (!workspace || !tree) return;
          tree.startCreatingFromTemplate(initialCreateDir);
          return;
        }
        case 'rename': {
          if (!activeTarget || isOkManagedTarget) return;
          emitFileTreeMenuActionRename(activeTarget);
          return;
        }
        case 'duplicate': {
          if (!activeTarget || isOkManagedTarget) return;
          emitFileTreeMenuActionDuplicate(activeTarget);
          return;
        }
        case 'move-to-trash': {
          // FileTree owns the two-step confirm-then-delete spine; surface the
          // request via the documents-events bus the row context menu also
          // feeds. Same payload shape as the sidebar's right-click Delete.
          if (!activeTarget || isOkManagedTarget) return;
          emitFileTreeMenuActionDelete(activeTarget);
          return;
        }
        case 'reveal-in-finder': {
          if (!bridge || !workspace) return;
          const absPath = resolveActiveTargetAbsPath(activeTarget, workspace);
          void bridge.shell.showItemInFolder(absPath);
          return;
        }
        case 'send-to-ai': {
          // Dispatches the active scope (file / folder / project) through the
          // SAME contract as every other launcher: a still-usable saved pick
          // first, else in-app, then Terminal, then an external app. This used
          // to grab the first installed external app outright, so the one native
          // entry point could open a different agent than the sparkle menu right
          // beside it. Capabilities match the empty-space submenu this sidebar
          // already renders: threads are server-hosted (always launchable), the
          // terminal needs the desktop bridge, external apps are pickable here.
          const selection = resolveLauncherSelection({
            sticky: stickyAgentId,
            effectiveThreadAgent: pickEffectiveDefaultAgent(
              enabledThreadAgents(registeredAgents, enabledOverrides),
              defaultRegisteredAgent,
            ),
            enabledClis:
              terminalLaunch !== null
                ? enabledTerminalClis(enabledOverrides, terminalLaunch.installedClis)
                : [],
            enabledDesktopTargets: enabledDesktopTargets(enabledOverrides, handoffInstallStates),
            unresolvedDesktopTargets: unresolvedDesktopTargets(
              enabledOverrides,
              handoffInstallStates,
            ),
            installedClis: terminalLaunch?.installedClis ?? {},
            terminalAvailable: terminalLaunch !== null,
            threadsAvailable: true,
            desktopSelectable: true,
          });
          // `none` means nothing is enabled anywhere — the pre-existing
          // "nothing to send to" toast. A missing input (workspace not resolved
          // yet) stays the silent no-op it was.
          if (selection.kind === 'none') {
            toast.error(t`No AI agents installed`);
            return;
          }
          const input = buildSendToAiInputForActiveTarget(activeTarget, workspace);
          if (!input) return;
          if (selection.kind === 'thread') {
            startAgentThreadForInput(input, {
              agent: { source: selection.agent.source, id: selection.agent.id },
            });
            return;
          }
          if (selection.kind === 'cli') {
            // `terminalAvailable` was true when this resolved, so the launcher
            // exists; the guard is what narrows it for TypeScript.
            terminalLaunch?.launchInTerminal(input, selection.cli);
            return;
          }
          if (selection.kind === 'terminal') return; // bare shell — not offered here
          // External app. An enabled-but-not-installed target routes to its
          // installer rather than a deep-link that cannot land, matching the
          // composers. The toast is load-bearing here in a way it is not in a
          // composer: this action carries no agent picker, so the user chose no
          // target at all and an unexplained vendor download tab would be the
          // entire response. Interpolating the member expression reuses the
          // composer's positional-placeholder msgid rather than forking a new one.
          const target = VISIBLE_TARGETS.find((tg) => tg.id === selection.target);
          if (!target) return;
          if (handoffInstallStates[target.id]?.installed !== true) {
            void openInstallUrl(target);
            toast.info(t`${target.displayName} isn't installed yet — opening its download page.`);
            return;
          }
          void dispatchHandoff(target.id, input);
          return;
        }
        case 'copy-full-path': {
          if (!workspace) return;
          const absPath = resolveActiveTargetAbsPath(activeTarget, workspace);
          void navigator.clipboard
            .writeText(absPath)
            .then(() => toast.success(t`Copied full path`, { description: absPath }))
            .catch((err: unknown) => {
              console.warn('[FileSidebar] clipboard write failed:', err);
              toast.error(t`Could not copy full path`);
            });
          return;
        }
        case 'copy-relative-path': {
          const relPath = resolveActiveTargetRelativePath(activeTarget);
          // `resolveActiveTargetRelativePath` returns `''` for null / missing
          // scopes (the project root has no project-relative path).
          // Don't pollute the clipboard with an empty string + a misleading
          // "Copied" toast — surface a hint and bail. Sibling `copy-full-path`
          // doesn't need this guard: its resolver falls back to
          // `workspace.contentDir`, which is a real on-disk path.
          if (relPath === '') {
            toast.error(t`No file or folder selected`);
            return;
          }
          void navigator.clipboard
            .writeText(relPath)
            .then(() => toast.success(t`Copied relative path`, { description: relPath }))
            .catch((err: unknown) => {
              console.warn('[FileSidebar] clipboard write failed:', err);
              toast.error(t`Could not copy relative path`);
            });
          return;
        }
        case 'toggle-show-ok-folders': {
          patchSidebarVisibility({ showOkFolders: !showOkFolders });
          return;
        }
        case 'toggle-show-hidden-files': {
          patchSidebarVisibility({ showHiddenFiles: !showHiddenFiles });
          return;
        }
        case 'toggle-show-only-markdown-files': {
          patchSidebarVisibility({ showOnlyMarkdownFiles: !showOnlyMarkdownFiles });
          return;
        }
        case 'toggle-show-skills-section': {
          patchSidebarVisibility({ showSkillsSection: !showSkillsSection });
          return;
        }
        case 'expand-all-tree': {
          tree?.expandAll();
          return;
        }
        case 'collapse-all-tree': {
          tree?.collapseAll();
          return;
        }
        case 'toggle-sidebar': {
          // View → Show/Hide Sidebar (⌥⌘S). Same primitive bound to the
          // SidebarTrigger rail — `useSidebar().toggleSidebar()` flips the
          // open state and persists it to the sidebar-state cookie.
          toggleSidebar();
          return;
        }
        // Older action IDs handled elsewhere or unsupported in this surface.
        // Listed explicitly so an exhaustiveness check would fail if the
        // OkMenuAction union widens without a corresponding case here.
        case 'delete':
        case 'toggle-source':
        case 'save-version':
        case 'version-history':
        case 'focus-search':
        case 'focus-command-palette':
        case 'close-active-tab-or-window':
        case 'toggle-doc-panel':
          return;
      }
    });
  }, [
    bridge,
    tree,
    workspace,
    activeTarget,
    initialCreateDir,
    projectLocalBinding,
    showHiddenFiles,
    showOkFolders,
    showOnlyMarkdownFiles,
    showSkillsSection,
    handoffInstallStates,
    dispatchHandoff,
    terminalLaunch,
    enabledOverrides,
    registeredAgents,
    defaultRegisteredAgent,
    stickyAgentId,
    toggleSidebar,
    t,
  ]);

  return (
    <Sidebar variant="inset">
      {/* ContextMenu wrap lives INSIDE Sidebar so the outer <aside
       * data-slot="sidebar-container"> stays a direct DOM sibling of
       * SidebarInset. shadcn's SidebarInset uses Tailwind `peer-data-*`
       * selectors (`peer-data-[mobile=true][data-state=expanded]` for the
       * push-mode translate; `peer-data-[variant=inset]:m-2` for the inset
       * variant margins) — those compile to CSS `peer ~ self` which requires
       * the marked element (Sidebar's aside, carrying the data attrs) to be
       * a DOM sibling of the consumer (SidebarInset) under the same parent.
       * An outer ContextMenu wrapper introduces an intermediate <div> that
       * breaks the sibling-ship and zero-translates the inset at small
       * widths. `display: contents`
       * is layout-invisible but NOT DOM-invisible, so it doesn't fix the
       * peer selector. Wrapping inside Sidebar puts the trigger div inside
       * the aside instead — preserves the outer DOM topology shadcn needs.
       */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: ContextMenuTrigger
           * delegation surface — display:contents wrapper for the asChild Slot's
           * single-child requirement. Keyboard equivalents live on the individual
           * interactive controls inside (toolbar buttons, search-pill button,
           * project switcher trigger, Pierre tree rows, sidebar rail); this wrapper
           * has no perceivable interactive surface of its own. The onContextMenu
           * handler delegates the button-target opt-out for the sidebar-wide
           * context menu — same a11y semantics as a Radix Slot. */}
          <div className="contents" onContextMenu={handleSidebarSurfaceContextMenu}>
            <SidebarHeader
              data-electron-drag={isElectronHost ? '' : undefined}
              className={cn(
                // h-12 matches EditorHeader's height so the OS traffic lights are
                // vertically centered with BOTH toolbars (same midline at y=24px).
                // Without this, the SidebarHeader's natural shorter height puts
                // its action icons above the EditorHeader's row, and no
                // trafficLightPosition can align with both at once.
                //
                // `py-0` overrides the primitive's inherited `p-2` (8px all
                // sides). EditorHeader is `h-12` with NO outer padding (only
                // `px-3` on inner zones), so content centers in the full 48px.
                // Without this override, the SidebarHeader's content area is
                // 32px (48 - 16 vertical padding), and at certain icon sizes the
                // resulting items-center math drifts a couple pixels off from
                // EditorHeader's content midline.
                //
                // The horizontal gutters are asymmetric on purpose. `pl-3`
                // matches EditorHeader's zone inset. `pr-2` (8px) aligns the
                // action cluster's right edge with everything stacked beneath it
                // in the sidebar — the search button (the pill row is `px-2`) and
                // the tree rows (Pierre's `--trees-padding-inline-override:
                // 0.5rem`). One right-edge column for the whole sidebar reads
                // stronger than mirroring EditorHeader's 12px gutter across the
                // divider, which would leave the arrows 4px off the search icon
                // directly below them.
                'flex-row h-12 items-center py-0 pl-3 pr-2',
                // Electron mode has only the action buttons in the header (no
                // 'Files' label, no project name — ProjectSwitcher in the footer
                // carries project identity). `justify-between` pins a
                // non-shrinkable traffic-light reserve (the spacer rendered
                // below) to the left and the action cluster to the right, so the
                // cluster sits AFTER the macOS traffic-light region regardless of
                // how many buttons it holds — the clearance is structural, not a
                // function of MIN_SIDEBAR_WIDTH tuning. `overflow-x-clip` makes an
                // over-budget cluster degrade by clipping toward the sidebar
                // interior instead of sliding left under the OS chrome. Web mode
                // keeps the same spread: 'Files' label flush left, actions right.
                'justify-between',
                isElectronHost && 'overflow-x-clip',
                // Fade the header content out when the sidebar starts collapsing
                // offcanvas. The shadcn primitive slides the entire sidebar left
                // over 200ms; without an opacity gate the action icons would
                // visibly cross UNDER the OS-level traffic lights mid-slide
                // (renderer content always sits beneath the OS chrome).
                //
                // Collapse: the fade is intentionally HALF the slide duration
                // (100ms vs the 200ms slide) with `ease-out` instead of `linear`
                // — frontloaded disappearance. By t=50ms the icons are ~10%
                // opaque; by t=100ms they are fully gone. The sidebar's leading
                // edge does not reach the traffic-light x-bounds (~x=22-80) until
                // well after t=100ms, so the icons are invisible during the
                // entire collision window. Matching the slide's full 200ms with
                // linear easing left the icons at ~50% opacity while crossing
                // under the traffic lights — perceived as "about to clash" even
                // though the alpha was below 1.0. `motion-safe:` gates the
                // transition for prefers-reduced-motion users; they get the
                // opacity flip without animation.
                //
                // Expand inherits the same opacity rule but needs an additional
                // `delay-100` to break the direction symmetry. Without the delay,
                // the 0→1 ease-out is also frontloaded — opacity hits ~95% by
                // t=30ms, but the slide-RIGHT carries the icons through x=22-80
                // only at t≈95-140ms, so for ~45ms the icons sit at full opacity
                // sliding UNDER the traffic lights ("emerge from behind" effect).
                // The 100ms delay holds opacity at 0 across the entire crossing
                // window; the 0→1 ease-out then completes in the 100-200ms half
                // of the slide, reaching full opacity exactly when the sidebar
                // finishes expanding. The delay is gated on `isExpanded`, so the
                // post-property-change computed style toggles it direction-
                // specifically — collapse drops the delay and uses the fast
                // frontloaded fade-out unchanged.
                isElectronHost &&
                  'motion-safe:transition-opacity motion-safe:duration-100 motion-safe:ease-out',
                isElectronHost && isExpanded && 'motion-safe:delay-100',
                shouldFadeChrome && 'opacity-0',
                // Mirror EditorHeader's drag-region treatment so the empty
                // space in the SidebarHeader's chrome row drags the window
                // (same affordance the canvas chrome row already provides).
                // Without this, only the canvas-side empty space was
                // draggable — surprising asymmetry between the two halves
                // of the chrome.
                isElectronHost && '[-webkit-app-region:drag]',
              )}
            >
              {isElectronHost ? (
                // Non-shrinkable macOS traffic-light reserve. With the header's
                // `justify-between` this holds the left edge so the action
                // cluster can never extend under the OS traffic lights, no matter
                // the button count or how narrow the sidebar is dragged — the
                // clearance is structural rather than relying on the
                // MIN_SIDEBAR_WIDTH tuning in `ui/sidebar.tsx`. Decorative and
                // draggable (inherits the header drag region); width is the
                // shared `--ok-titlebar-reserve-left` token.
                <div
                  aria-hidden="true"
                  data-testid="sidebar-traffic-light-reserve"
                  className="w-[var(--ok-titlebar-reserve-left,0px)] shrink-0 self-stretch"
                />
              ) : null}
              <div className="ml-auto flex shrink-0 items-center gap-0.5 [&>*]:[-webkit-app-region:no-drag]">
                {/* Back/forward history. Desktop-only: the browser's own controls
                    already do this on web, so a second pair would be redundant. */}
                {isElectronHost && isExpanded ? <NavigationHistoryControls /> : null}
                {/*
                 * Search sits with back/forward — global navigation lives in the
                 * header; the rows below are the project's. Boundary scope is
                 * intentionally tight: a render-throw silent-fails just the
                 * search button while the header, FileTree, and the App-level
                 * ⌘K listener (CommandPalette.tsx) keep working — so search
                 * stays keyboard-reachable in the fallback state. `resetKeys`
                 * remounts it on sidebar toggle as a recovery affordance; the
                 * observability handler is `onPillRenderError` (defined in
                 * SidebarSearchBar.tsx, emits the project-wide
                 * `jsx-render-failure` event + parse-health counter).
                 */}
                <ErrorBoundary
                  fallbackRender={() => null}
                  onError={onPillRenderError}
                  resetKeys={[sidebarState]}
                >
                  <SidebarSearchBar onClick={onOpenSearch} />
                </ErrorBoundary>
              </div>
            </SidebarHeader>
            <SidebarContent>
              <ConflictsSection />
              {/* Project files own the scrolling body and take the slack, so the
                  tree keeps the empty area below its last row that the
                  deselect-to-root click needs. Skills stacks under it. */}
              {
                // `px-0` overrides the SidebarGroup base `p-2`'s horizontal
                // inset — Pierre's `--trees-padding-inline-override`
                // (file-tree-density.ts) already lands the rows at 8px.
                // `data-[state=open]:flex-1` and not a plain `flex-1`: collapsed,
                // the group must shrink to its header row, or the collapsed
                // section would still hold the whole sidebar body open.
                //
                // The paired `min-h-48` floor (header row + ~5 tree rows) is
                // load-bearing, not cosmetic. `ConflictsSection` is a sibling
                // that renders one unbounded row per conflict with no cap and no
                // internal scroll, so its automatic minimum size is its full
                // content height and it cannot yield. Without a floor here the
                // file list is the only item the flex shrink algorithm can take
                // from, and enough conflicts drive it to zero instead of making
                // SidebarContent scroll. Measured at 720px: ~15 conflicts left a
                // 89px sliver and ~25 left nothing at all.
                <Collapsible
                  open={filesOpen}
                  onOpenChange={setFilesOpen}
                  className="group/files flex min-h-0 flex-col data-[state=open]:min-h-48 data-[state=open]:flex-1"
                >
                  <SidebarGroup className="min-h-0 flex-1 px-0">
                    {/* Overarching project row. The create/view actions sit inline
                      with the folder they act on rather than in the window
                      chrome, so it reads as "this folder, these actions" — and
                      the header is left to back/forward, which are global. */}
                    <SidebarGroupLabel className="shrink-0 gap-1 rounded-none">
                      <CollapsibleTrigger
                        // Marks the project-root header so right-click opens the
                        // project-scoped menu.
                        data-sidebar-root-context
                        className="flex min-w-0 flex-1 items-center gap-1.5"
                      >
                        <ChevronRight className="size-4 shrink-0 text-tree-muted transition-transform group-data-[state=open]/files:rotate-90" />
                        <span className="truncate text-sm font-normal text-muted-foreground">
                          {projectName}
                        </span>
                      </CollapsibleTrigger>
                      {/* biome-ignore lint/a11y/useSemanticElements: same call as ui/button-group — a toolbar cluster is not a form-control set, so the semantic alternative would impose form-field semantics and chrome. */}
                      <div
                        // Named group, not a bare div: the redesign swapped
                        // ButtonGroup (which supplied both) for layout classes
                        // and the toolbar lost its accessible name with it.
                        role="group"
                        aria-label={t`Files toolbar`}
                        data-testid="sidebar-toolbar"
                        className={cn(
                          'flex items-center gap-0.5',
                          // Direct-child no-drag opt-out so each toolbar button keeps
                          // firing its click handler instead of initiating a window
                          // drag — same [&>*] pattern as EditorHeader's right zone.
                          // The DropdownMenuTrigger renders via Radix `asChild` so
                          // its single direct DOM child (the Button) receives the
                          // no-drag class.
                          isElectronHost && '[&>*]:[-webkit-app-region:no-drag]',
                        )}
                      >
                        {/*
                         * Tree view options uses DropdownMenu (click-to-open). The
                         * earlier hover-to-open HoverCard shape was unreachable from
                         * keyboard and touch: Radix HoverCard's content root forcibly
                         * sets `tabindex="-1"` on every tabbable descendant
                         * (@radix-ui/react-hover-card@dist/index.mjs:172-177), and
                         * hover cannot be triggered from keyboard/AT/touch at all. A
                         * DropdownMenu opens on click/Enter/Space, routes arrow-key
                         * focus between items, and is the shadcn-standard pattern
                         * for toolbar menus.
                         *
                         * The trigger is always visible: the Show group is state-
                         * independent, so the menu always has content. The Expand/
                         * Collapse-all commands smart-hide individually when their
                         * action would no-op (no folders; every folder already
                         * expanded / collapsed), taking their separator with them.
                         */}
                        <DropdownMenu>
                          <ToolbarDropdownTrigger
                            icon={ListCollapse}
                            label={t`Tree view options`}
                          />
                          <DropdownMenuContent
                            align="end"
                            className="min-w-52"
                            data-testid="tree-options-menu"
                          >
                            {showExpandAll ? (
                              <DropdownMenuItem onSelect={() => tree?.expandAll()}>
                                <UnfoldVertical aria-hidden="true" />
                                <Trans>Expand all</Trans>
                              </DropdownMenuItem>
                            ) : null}
                            {showCollapseAll ? (
                              <DropdownMenuItem onSelect={() => tree?.collapseAll()}>
                                <FoldVertical aria-hidden="true" />
                                <Trans>Collapse all</Trans>
                              </DropdownMenuItem>
                            ) : null}
                            {showTreeStateSection ? <DropdownMenuSeparator /> : null}
                            {/* Labeled `role="group"` so assistive tech announces the
                              section; the visual DropdownMenuLabel alone is skipped
                              by arrow-key menu navigation. Items read group-relative
                              ("Hidden files") because the label carries the "Show";
                              the unsectioned menu surfaces use the full-form labels. */}
                            <DropdownMenuGroup aria-label={t`Show`}>
                              <DropdownMenuLabel>
                                <Trans>Show</Trans>
                              </DropdownMenuLabel>
                              <DropdownMenuCheckboxItem
                                checked={showHiddenFiles}
                                onCheckedChange={(checked) =>
                                  patchSidebarVisibility({ showHiddenFiles: checked })
                                }
                                disabled={projectLocalBinding === null}
                                data-testid="tree-options-show-hidden-files"
                              >
                                <Trans>Hidden files</Trans>
                              </DropdownMenuCheckboxItem>
                              <DropdownMenuCheckboxItem
                                checked={showOkFolders}
                                onCheckedChange={(checked) =>
                                  patchSidebarVisibility({ showOkFolders: checked })
                                }
                                disabled={projectLocalBinding === null}
                                data-testid="tree-options-show-ok-folders"
                              >
                                <Trans>.ok folders</Trans>
                              </DropdownMenuCheckboxItem>
                              <DropdownMenuCheckboxItem
                                checked={showOnlyMarkdownFiles}
                                onCheckedChange={(checked) =>
                                  patchSidebarVisibility({ showOnlyMarkdownFiles: checked })
                                }
                                disabled={projectLocalBinding === null}
                                data-testid="tree-options-show-only-markdown-files"
                              >
                                <Trans>Only markdown files</Trans>
                              </DropdownMenuCheckboxItem>
                              <DropdownMenuCheckboxItem
                                checked={showSkillsSection}
                                onCheckedChange={(checked) =>
                                  patchSidebarVisibility({ showSkillsSection: checked })
                                }
                                disabled={projectLocalBinding === null}
                                data-testid="tree-options-show-skills"
                              >
                                <Trans>Skills Studio</Trans>
                              </DropdownMenuCheckboxItem>
                            </DropdownMenuGroup>
                            {/* OUTSIDE the Show group, deliberately: its label
                              carries the "Show" that its items read against, and
                              this is not a visibility toggle — it changes how the
                              Skills tree is arranged. Hidden when the section is
                              off rather than offering a control over something
                              that isn't rendered. */}
                            {showSkillsSection ? (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuCheckboxItem
                                  checked={showSkillGroups}
                                  onCheckedChange={(checked) =>
                                    patchSidebarVisibility({ showSkillGroups: checked })
                                  }
                                  disabled={projectLocalBinding === null}
                                  data-testid="tree-options-group-skills"
                                >
                                  <Trans>Group skills by source</Trans>
                                </DropdownMenuCheckboxItem>
                              </>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <ToolbarButton
                          icon={SquarePen}
                          label={t`New file`}
                          onClick={() => tree?.startCreating('file', initialCreateDir)}
                          shortcutId="new-item"
                        />
                        {activeFolderHasTemplates ? (
                          // Toolbar opens templates on click (not hover): a hover-only
                          // flyout off an icon button isn't keyboard/touch reachable.
                          // Mirrors the Tree view options dropdown above. Picking a
                          // template runs the same inline-rename create flow as New file.
                          <DropdownMenu>
                            <ToolbarDropdownTrigger icon={FilePlus} label={t`New from template`} />
                            <DropdownMenuContent
                              align="end"
                              className="min-w-52"
                              onCloseAutoFocus={handleCreateMenuCloseAutoFocus}
                            >
                              <TemplateMenuRows
                                parentDir={initialCreateDir}
                                onSelectTemplate={(templateName) => {
                                  suppressCreateMenuFocusRestoreRef.current = true;
                                  tree?.createFromTemplate(initialCreateDir, templateName);
                                }}
                                ItemComponent={DropdownMenuItem}
                              />
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                        <ToolbarButton
                          icon={FolderPlus}
                          label={t`New folder`}
                          onClick={() => tree?.startCreating('folder', initialCreateDir)}
                          // Desktop-only binding; on web the keycap would name a
                          // shortcut that does nothing.
                          shortcutId={isElectronHost ? 'new-folder' : undefined}
                        />
                      </div>
                    </SidebarGroupLabel>
                    <CollapsibleContent className="flex min-h-0 flex-1 flex-col overflow-hidden">
                      <FileTree ref={setTree} />
                    </CollapsibleContent>
                  </SidebarGroup>
                </Collapsible>
              }
              {/* A STACKED section, not a bottom rail. Files takes the slack while
                  it is open, so Skills lands under the tree and looks docked; the
                  moment Files collapses to its header, Skills rides up beneath it
                  and the empty space falls below both — which is what the section
                  stack in Cursor does, and what a rail pinned to the bottom edge
                  could never do.

                  Inside SidebarContent for that reason: as a sibling it was
                  anchored to the bottom no matter what was above it. Both sections
                  scroll internally (the tree via Pierre, the dock via its own
                  capped body), so the stack itself has nothing to scroll except
                  when ConflictsSection is unusually tall — the case the Files
                  `min-h-48` floor below exists to keep survivable.

                  View-preference gate is on the whole dock: hidden, skill docs stay
                  reachable via links, search, and direct routes. */}
              {showSkillsSection ? <SkillsSidebarDock filesOpen={filesOpen} /> : null}
            </SidebarContent>
            <SidebarFooter className="px-0">
              <OnboardingCardMount />
              <UpdateNotices />
              {/* Self-gates on device-local state (two weeks since first boot,
                  enough documents) and on the two surfaces above, so it never
                  stacks a third ask into this footer. */}
              <FeedbackCardMount />
              {typeof window !== 'undefined' && window.okDesktop ? (
                <SidebarMenu>
                  <SidebarMenuItem>
                    <ProjectSwitcher bridge={window.okDesktop} />
                  </SidebarMenuItem>
                </SidebarMenu>
              ) : null}
            </SidebarFooter>
            {/*
             * Drag-to-resize ON, click-to-toggle OFF. The EditorHeader's
             * SidebarTrigger is the canonical collapse/expand affordance —
             * adding click-to-toggle on the rail too duplicates that affordance
             * and surprises users who don't expect a structural panel edge to
             * be interactive (and the rail-vs-trigger redundancy creates
             * unclear hit targets near the seam). Drag-to-resize stays because
             * it's a distinct affordance with no other entry point.
             *
             * `enableToggle={false}` flows through useSidebarResize → suppresses
             * the click-without-drag onToggle path. Auto-collapse via dragging
             * to MIN_SIDEBAR_WIDTH still fires (different code path, gated on
             * enableAutoCollapse — currently unused, kept available).
             *
             * `enableDrag={false}` when running embedded AND collapsed: the AI-
             * editor host (Claude / Codex / Cursor) has its own draggable
             * container chrome, and the offcanvas-translated rail (positioned
             * 2px inside the viewport at `-left-2`) becomes a misclick target
             * for those host handles. Click-to-toggle is irrelevant here
             * (already off), so we only suppress drag.
             */}
            <SidebarRail
              enableToggle={false}
              enableDrag={!(isEmbedded && sidebarState === 'collapsed')}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-52" onCloseAutoFocus={handleCreateMenuCloseAutoFocus}>
          {/*
           * Empty-space menu — 4 sections.
           *
           * Section 1: Creation (always visible). New file / from
           * template / folder dispatch the project-root creation flow
           * (parentDir = '' → contentDir). Disabled when workspace hasn't
           * resolved.
           *
           * Section 2: Act-on-project. Reveal in Finder
           * is Electron-only (`if (!bridge) return null`); Open with AI submenu
           * is cross-host (filtered via useInstalledAgents); Copy full path
           * is cross-host.
           *
           * Section 3: Visibility toggles. The same checkboxes as the
           * toolbar popover's Show group, in the same order, but with
           * full-form labels ("Show hidden files") because this flat menu has
           * no group label to carry the "Show". Read state from the merged
           * config; write through the project-local CRDT binding so the
           * popover, the View menu, and any other surface stay in sync via
           * the existing subscribe path.
           *
           * Section 4: Tree state. Expand/Collapse all tree-scoped with
           * smart-hide — both items hide when there are no folders, and each
           * hides when its action would be a no-op (all expanded / none
           * expanded). The separator before this section hides too when both
           * items hide.
           */}
          <ContextMenuItem
            disabled={!workspace}
            onSelect={handleEmptySpaceCreateFile}
            data-testid="empty-space-menu-new-file"
          >
            <SquarePen aria-hidden="true" />
            <Trans>New file</Trans>
          </ContextMenuItem>
          {rootHasTemplates ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger
                disabled={!workspace}
                data-testid="empty-space-menu-new-from-template"
              >
                <FilePlus aria-hidden="true" />
                <Trans>New from template</Trans>
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <TemplateMenuRows
                  parentDir=""
                  onSelectTemplate={handleEmptySpaceSelectTemplate}
                  ItemComponent={ContextMenuItem}
                />
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : null}
          <ContextMenuItem
            disabled={!workspace}
            onSelect={handleEmptySpaceCreateFolder}
            data-testid="empty-space-menu-new-folder"
          >
            <FolderPlus aria-hidden="true" />
            <Trans>New folder</Trans>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {bridge ? (
            <ContextMenuItem
              disabled={!workspace}
              onSelect={handleEmptySpaceReveal}
              data-testid="empty-space-menu-reveal-in-finder"
              aria-label={
                workspace
                  ? revealInFileManagerLabel(bridge.platform)
                  : t`${revealInFileManagerLabel(bridge.platform)}, No workspace`
              }
            >
              <FolderOpen aria-hidden="true" />
              <span className="flex-1">{revealInFileManagerLabel(bridge.platform)}</span>
              {!workspace ? (
                <span aria-hidden="true" className="ml-2 text-muted-foreground text-xs">
                  <Trans>No workspace</Trans>
                </span>
              ) : null}
            </ContextMenuItem>
          ) : null}
          <OpenInAgentEmptySpaceSubmenu
            input={emptySpaceHandoffInput}
            installStates={handoffInstallStates}
            dispatch={dispatchHandoff}
          />
          {hasRemote ? (
            <ContextMenuItem onSelect={handleEmptySpaceShare} data-testid="empty-space-menu-share">
              <Share2 aria-hidden="true" />
              <Trans>Share</Trans>
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem
            disabled={!workspace}
            onSelect={handleEmptySpaceCopyFullPath}
            data-testid="empty-space-menu-copy-full-path"
            aria-label={workspace ? t`Copy full path` : t`Copy full path, No workspace`}
          >
            <Copy aria-hidden="true" />
            <span className="flex-1">
              <Trans>Copy full path</Trans>
            </span>
            {!workspace ? (
              <span aria-hidden="true" className="ml-2 text-muted-foreground text-xs">
                <Trans>No workspace</Trans>
              </span>
            ) : null}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem
            checked={showHiddenFiles}
            onCheckedChange={(checked) => patchSidebarVisibility({ showHiddenFiles: checked })}
            disabled={projectLocalBinding === null}
            data-testid="empty-space-menu-show-hidden-files"
          >
            <Trans>Show hidden files</Trans>
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={showOkFolders}
            onCheckedChange={(checked) => patchSidebarVisibility({ showOkFolders: checked })}
            disabled={projectLocalBinding === null}
            data-testid="empty-space-menu-show-ok-folders"
          >
            <Trans>Show .ok folders</Trans>
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={showOnlyMarkdownFiles}
            onCheckedChange={(checked) =>
              patchSidebarVisibility({ showOnlyMarkdownFiles: checked })
            }
            disabled={projectLocalBinding === null}
            data-testid="empty-space-menu-show-only-markdown-files"
          >
            <Trans>Show only markdown files</Trans>
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={showSkillsSection}
            onCheckedChange={(checked) => patchSidebarVisibility({ showSkillsSection: checked })}
            disabled={projectLocalBinding === null}
            data-testid="empty-space-menu-show-skills-section"
          >
            <Trans>Skills section</Trans>
          </ContextMenuCheckboxItem>
          {showTreeStateSection ? <ContextMenuSeparator /> : null}
          {showExpandAll ? (
            <ContextMenuItem
              onSelect={handleEmptySpaceExpandAll}
              data-testid="empty-space-menu-expand-all"
            >
              <UnfoldVertical aria-hidden="true" />
              <Trans>Expand all</Trans>
            </ContextMenuItem>
          ) : null}
          {showCollapseAll ? (
            <ContextMenuItem
              onSelect={handleEmptySpaceCollapseAll}
              data-testid="empty-space-menu-collapse-all"
            >
              <FoldVertical aria-hidden="true" />
              <Trans>Collapse all</Trans>
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
    </Sidebar>
  );
}
