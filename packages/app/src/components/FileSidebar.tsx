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
import { type ComponentProps, type FC, type MouseEventHandler, useEffect, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { toast } from 'sonner';
import { ConflictsSection } from '@/components/ConflictsSection';
import { FileTree, type FileTreeHandle } from '@/components/FileTree';
import { defaultInitialDir } from '@/components/file-tree-utils';
import { OpenInAgentEmptySpaceSubmenu } from '@/components/handoff/OpenInAgentEmptySpaceSubmenu';
import {
  buildProjectScopedHandoffInput,
  useHandoffDispatch,
} from '@/components/handoff/useHandoffDispatch';
import { useInstalledAgents } from '@/components/handoff/useInstalledAgents';
import { OnboardingCardMount } from '@/components/OnboardingCard';
import { ProjectSwitcher } from '@/components/ProjectSwitcher';
import { onPillRenderError, SidebarSearchBar } from '@/components/SidebarSearchBar';
import { SkillsSidebarSection } from '@/components/SkillsSidebarSection';
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
  DropdownMenuContent,
  DropdownMenuItem,
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
import { ProfilerBoundary } from '@/lib/perf';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';
import { buildFolderShareInput, runShareAction } from '@/lib/share/run-share-action';
import { useWorkspace } from '@/lib/use-workspace';
import { cn } from '@/lib/utils';

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

interface ToolbarButtonProps extends ComponentProps<typeof Button> {
  icon: FC<ComponentProps<'svg'>>;
  label: string;
}

const ToolbarButton: FC<ToolbarButtonProps> = ({ icon: Icon, label, ...props }) => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} {...props}>
          <Icon aria-hidden="true" />
        </Button>
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
  // Measured file-tree content height (px) — the pane is sized flush to this
  // (capped) so the virtualized tree is exactly as tall as its files and the
  // Skills section sits directly beneath them with no gap. The tree still
  // virtualizes + scrolls internally once content exceeds the cap.
  const [treeContentHeight, setTreeContentHeight] = useState<number | null>(null);

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
  const baseCreateDir =
    activeTarget?.kind === 'folder' || activeTarget?.kind === 'folder-index'
      ? activeTarget.folderPath
      : defaultInitialDir(activeDocName);
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

  // Reactive subscription to FileTree's folder state. Drives the
  // smart-hide of the Tree view options dropdown:
  //   - dropdown trigger hidden when there are no folders
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
  // symptom both times: dropdown trigger hidden on cold launch even when
  // folders existed.
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
      tree.startCreating('file', dir);
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
  // to AI submenu; project-local binding drives the Show . / Show all check
  // states. The bridge is required for the Electron-only items (Reveal in
  // Finder) — those rows return null in web mode via the
  // `if (!bridge) return null` cross-cutting pattern. Copy full path is
  // visible in both modes (`navigator.clipboard.writeText` is Baseline
  // Widely Available since March 2020).
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const workspace = useWorkspace();
  // Gates the project-root menu's Share item — only shown with a GitHub remote.
  const { status: gitSyncStatus } = useGitSyncStatusDetailed();
  const hasRemote = gitSyncStatus?.hasRemote === true;
  // The files section is headed by the project name (matching the Skills
  // section's labeled header) — desktop carries it on the bridge config; web
  // falls back to the contentDir's leaf folder.
  const projectName =
    bridge?.config?.projectName ||
    workspace?.contentDir.split('/').filter(Boolean).pop() ||
    t`Files`;
  const handoffInstallStates = useInstalledAgents().states;
  const { dispatch: dispatchHandoff } = useHandoffDispatch();
  const emptySpaceHandoffInput = buildProjectScopedHandoffInput({ workspace });
  const { projectLocalBinding, merged } = useConfigContext();
  const showHiddenFiles = merged?.appearance?.sidebar?.showHiddenFiles ?? false;
  // Smart-hide gates for the Expand/Collapse-all tree-state items — tree-
  // scoped. Mirrors the toolbar dropdown's behavior: hide when the action
  // would be a no-op (no folders at all; every folder already in the target
  // state). The empty-space menu does NOT carry a separator before the
  // section when both items hide.
  const showEmptySpaceExpandAll = hasFolders && !allExpanded;
  const showEmptySpaceCollapseAll = hasFolders && !noneExpanded;
  const showEmptySpaceTreeStateSection = showEmptySpaceExpandAll || showEmptySpaceCollapseAll;

  // Sidebar-wide context-menu surface. Right-click anywhere inside the
  // sidebar except interactive controls (toolbar buttons, search-pill button,
  // project switcher trigger, Pierre tree rows, sidebar rail) opens the
  // empty-space menu. The wrapper div hosts the bubble-phase opt-out: when
  // the event target is a button-like control, suppress both the browser
  // default menu and Radix's ContextMenuTrigger from firing.
  const handleSidebarSurfaceContextMenu: MouseEventHandler<HTMLDivElement> = (event) => {
    // Let the project-root header through (it's a button) so its right-click
    // opens the project-scoped menu instead of being suppressed.
    if (event.target instanceof Element && event.target.closest('[data-sidebar-root-context]')) {
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
    tree?.startCreating('file', '');
  };
  const handleEmptySpaceSelectTemplate = (templateName: string) => {
    if (!workspace) return;
    tree?.createFromTemplate('', templateName);
  };
  const handleEmptySpaceCreateFolder = () => {
    if (!workspace) return;
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
  const handleEmptySpaceShowHiddenFilesToggle = (checked: boolean) => {
    if (projectLocalBinding === null) return;
    const result = projectLocalBinding.patch({
      appearance: { sidebar: { showHiddenFiles: checked } },
    });
    if (!result.ok) {
      console.warn('[FileSidebar] showHiddenFiles toggle rejected:', humanFormat(result.error));
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
  // mirror the empty-space menu's `showEmptySpace*` gates exactly — both
  // surfaces should agree on what counts as a no-op action.
  // `sidebarVisible` flips the View → Show/Hide Sidebar label main-side.
  useEffect(() => {
    if (!bridge) return;
    bridge.editor.notifyViewMenuStateChanged({
      showHiddenFiles,
      canExpandAll: showEmptySpaceExpandAll,
      canCollapseAll: showEmptySpaceCollapseAll,
      sidebarVisible: sidebarState === 'expanded',
    });
  }, [bridge, showHiddenFiles, showEmptySpaceExpandAll, showEmptySpaceCollapseAll, sidebarState]);

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
  //   - send-to-ai — dispatchHandoff against the right input builder per
  //     scope (file / folder / project; assets intentionally no-op).
  //   - copy-full-path / copy-relative-path — navigator.clipboard writes
  //     the absolute / project-relative path.
  //   - toggle-show-* / expand-all-tree / collapse-all-tree — same
  //     primitives the empty-space menu handlers already use.
  //
  // Deps are deliberately the full readable surface — the effect re-binds
  // whenever any input the routing depends on changes, so the handler
  // closure always sees the latest `activeTarget`, `workspace`, etc.
  // without stale-closure bugs.
  useEffect(() => {
    if (!bridge) return;
    return bridge.onMenuAction((action) => {
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
          if (!activeTarget) return;
          emitFileTreeMenuActionRename(activeTarget);
          return;
        }
        case 'duplicate': {
          if (!activeTarget) return;
          emitFileTreeMenuActionDuplicate(activeTarget);
          return;
        }
        case 'move-to-trash': {
          // FileTree owns the 2-step delete spine; surface the
          // request via the documents-events bus the row context menu also
          // feeds. Same payload shape as the sidebar's right-click Delete.
          if (!activeTarget) return;
          emitFileTreeMenuActionDelete(activeTarget);
          return;
        }
        case 'reveal-in-finder': {
          if (!bridge || !workspace) return;
          const absPath = resolveActiveTargetAbsPath(activeTarget, activeDocName, workspace);
          void bridge.shell.showItemInFolder(absPath);
          return;
        }
        case 'send-to-ai': {
          // Surface a request the renderer's existing handoff UX consumes —
          // mirrors the sparkle-icon click on EditorHeader. The submenu of
          // installed agents is owned by the renderer; this menu click just
          // pops it open. The submenu construction happens at render time,
          // not on each menu pick, so the dispatch reuses the active scope's
          // input. No-op when the input doesn't resolve (e.g. workspace not
          // yet loaded). We pick the FIRST installed agent as the default
          // dispatch target when
          // exactly one agent is installed; with multiple installed agents
          // the renderer surfaces a picker (deferred to a follow-up; for now
          // the menu click logs the scoped input for diagnostic visibility).
          //
          // Iterate VISIBLE_TARGETS (not raw Object.entries on
          // handoffInstallStates) so the hidden `claude-cowork` row — which
          // shares the `claude:` scheme with `claude-code` and would be
          // index [0] when Claude Desktop is installed — never gets picked
          // as the default. Matches the render-surface precedent in
          // OpenInAgentEmptySpaceSubmenu.tsx.
          const installedTargets = VISIBLE_TARGETS.filter(
            (target) => handoffInstallStates[target.id]?.installed === true,
          );
          if (installedTargets.length === 0) {
            toast.error(t`No AI agents installed`);
            return;
          }
          const input = buildSendToAiInputForActiveTarget(activeTarget, activeDocName, workspace);
          if (!input) return;
          const [defaultTarget] = installedTargets;
          if (!defaultTarget) return;
          void dispatchHandoff(defaultTarget.id, input);
          return;
        }
        case 'copy-full-path': {
          if (!workspace) return;
          const absPath = resolveActiveTargetAbsPath(activeTarget, activeDocName, workspace);
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
          const relPath = resolveActiveTargetRelativePath(activeTarget, activeDocName);
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
        case 'toggle-show-hidden-files': {
          if (projectLocalBinding === null) return;
          const result = projectLocalBinding.patch({
            appearance: { sidebar: { showHiddenFiles: !showHiddenFiles } },
          });
          if (!result.ok) {
            console.warn(
              '[FileSidebar] toggle-show-hidden-files rejected:',
              humanFormat(result.error),
            );
            toast.error(t`Could not update sidebar settings`, {
              description: humanFormat(result.error),
            });
          }
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
    activeDocName,
    initialCreateDir,
    projectLocalBinding,
    showHiddenFiles,
    handoffInstallStates,
    dispatchHandoff,
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
                // `py-0 px-3` overrides the primitive's inherited `p-2` (8px all
                // sides). EditorHeader is `h-12` with NO outer padding (only
                // `px-3` on inner zones), so content centers in the full 48px.
                // Without these overrides, the SidebarHeader's content area is
                // 32px (48 - 16 vertical padding), and at certain icon sizes the
                // resulting items-center math drifts a couple pixels off from
                // EditorHeader's content midline. `px-3` keeps the inner edge
                // gutter consistent with the EditorHeader zones (no behavioral
                // change since `justify-end` / `justify-between` already control
                // horizontal layout).
                'flex-row h-12 items-center py-0 px-3',
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
              {isExpanded && !isElectronHost ? (
                <span className="shrink-0 font-mono text-sm uppercase tracking-wider text-sidebar-foreground/50">
                  <Trans>Files</Trans>
                </span>
              ) : null}
              <div
                data-testid="sidebar-toolbar"
                className={cn(
                  'flex items-center gap-1',
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
                 * Expand/Collapse-All uses DropdownMenu (click-to-open). The
                 * earlier hover-to-open HoverCard shape was unreachable from
                 * keyboard and touch: Radix HoverCard's content root forcibly
                 * sets `tabindex="-1"` on every tabbable descendant
                 * (@radix-ui/react-hover-card@dist/index.mjs:172-177), and
                 * hover cannot be triggered from keyboard/AT/touch at all. A
                 * DropdownMenu opens on click/Enter/Space, routes arrow-key
                 * focus between items, and is the shadcn-standard pattern
                 * for toolbar menus.
                 *
                 * Smart-hide: trigger only renders when the tree has folders
                 * (no folders → both menu items would be no-ops, so the entire
                 * trigger is wasted screen real estate). Individual items hide
                 * when their action would no-op: "Expand all" hides when every
                 * folder is already expanded; "Collapse all" hides when none
                 * are expanded. Mixed states show both items.
                 */}
                {hasFolders ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <ToolbarButton icon={ListCollapse} label={t`Tree view options`} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-52">
                      {!allExpanded ? (
                        <DropdownMenuItem onSelect={() => tree?.expandAll()}>
                          <UnfoldVertical aria-hidden="true" />
                          <Trans>Expand all</Trans>
                        </DropdownMenuItem>
                      ) : null}
                      {!noneExpanded ? (
                        <DropdownMenuItem onSelect={() => tree?.collapseAll()}>
                          <FoldVertical aria-hidden="true" />
                          <Trans>Collapse all</Trans>
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                <ToolbarButton
                  icon={SquarePen}
                  label={t`New file`}
                  onClick={() => tree?.startCreating('file', initialCreateDir)}
                />
                {activeFolderHasTemplates ? (
                  // Toolbar opens templates on click (not hover): a hover-only
                  // flyout off an icon button isn't keyboard/touch reachable.
                  // Mirrors the Tree view options dropdown above. Picking a
                  // template runs the same inline-rename create flow as New file.
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <ToolbarButton icon={FilePlus} label={t`New from template`} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-52">
                      <TemplateMenuRows
                        parentDir={initialCreateDir}
                        onSelectTemplate={(templateName) =>
                          tree?.createFromTemplate(initialCreateDir, templateName)
                        }
                        ItemComponent={DropdownMenuItem}
                      />
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                <ToolbarButton
                  icon={FolderPlus}
                  label={t`New folder`}
                  onClick={() => tree?.startCreating('folder', initialCreateDir)}
                />
              </div>
            </SidebarHeader>
            {/*
             * Pill row lives outside SidebarContent's overflow-auto boundary so
             * it is sticky by structure (no sticky CSS needed). no-drag is
             * defensive — the sibling itself does NOT opt into drag like
             * SidebarHeader does, but the explicit opt-out survives a future
             * refactor that might place the row inside a drag region. Opacity
             * fades in lockstep with the toolbar so neither row visibly
             * orphans under the macOS traffic-light region mid-slide.
             *
             * ErrorBoundary scope is intentionally tight: a pill render-throw
             * silent-fails just the pill while the toolbar, FileTree,
             * SidebarFooter, and ⌘K listener continue to function.
             *
             * The observability handler is `onPillRenderError` (defined in
             * SidebarSearchBar.tsx); it emits the project-wide
             * `jsx-render-failure` event with a stable `sidebarSearchPill`
             * surface identifier and increments the same parse-health counter
             * MathInlineView and JsxComponentView feed — one dashboard / alert
             * rule covers every render-throw surface. Payload shape is unit-
             * tested at the function level; the
             * wiring (boundary mounts the function on `onError`) is pinned by
             * a single source-level guard below.
             *
             * The `fallbackRender={() => null}` is deliberate — null leaf, not a
             * mini-pill replacement. Rationale: (1) the pill is content-free
             * (icon + literal "Search" + literal kbd), so it has no plausible
             * render-throw path tied to data; the failure modes are React
             * internals, browser-extension injection, or a runtime API failure
             * — none of which a redrawn fallback would recover from. (2) the
             * App-level ⌘K window keydown listener (CommandPalette.tsx)
             * remains reachable in the fallback state, so search is
             * keyboard-reachable even without the visible pill. (3) the
             * structured-warn + counter pair lands the failure in the same
             * observability pipeline siblings feed.
             *
             * `resetKeys={[sidebarState]}` gives the user a recovery affordance
             * after a transient render-throw (e.g., one-off `navigator` access
             * failure, extension-injected error): toggling the sidebar via the
             * native View → Show/Hide Sidebar menu (⌥⌘S in Electron) or the
             * SidebarTrigger button flips sidebarState from `expanded` ↔
             * `collapsed`, which triggers
             * react-error-boundary to remount the pill subtree. Aligns the
             * recovery shape with `MathInlineView` (uses `resetKeys={[formula]}`)
             * and `JsxComponentView` (uses an explicit `resetKey`) — both
             * sibling boundaries in this codebase expose a recovery path.
             * The null fallback still diverges from sibling sites (which render
             * content-preserving fallbacks), but those fallbacks recover
             * state-bearing user content; this surface has no state to preserve,
             * just a remount opportunity.
             */}
            <div
              className={cn(
                // 8px horizontal padding so the pill's left/right edges align
                // with the FileTree rows underneath. Pierre Trees applies
                // `--trees-padding-inline-override: 0.5rem` (= 8px) on its
                // container, so tree-row content sits at x = sidebar-left + 8.
                // Matching `px-2` here makes the pill's outer border land on
                // the same vertical line as the tree icons — visual continuity
                // between the chrome-row pill and the rows directly below it.
                // (The SidebarHeader above keeps `px-3` for its own reason —
                // aligning with EditorHeader's gutter — and is unrelated to
                // tree-row alignment.)
                'px-2 pb-2',
                isElectronHost && '[-webkit-app-region:no-drag]',
                isElectronHost &&
                  'motion-safe:transition-opacity motion-safe:duration-100 motion-safe:ease-out',
                isElectronHost && isExpanded && 'motion-safe:delay-100',
                shouldFadeChrome && 'opacity-0',
              )}
            >
              <ErrorBoundary
                fallbackRender={() => null}
                onError={onPillRenderError}
                resetKeys={[sidebarState]}
              >
                <SidebarSearchBar onClick={onOpenSearch} />
              </ErrorBoundary>
            </div>
            <SidebarContent>
              <ConflictsSection />
              {/* Project files, under a collapsible header named for the project
                  — a true peer to the Skills section below it. The content pane
                  is sized to the tree's measured content height (capped at 70vh),
                  so a short tree sits flush above Skills (no bottom-dock) and a
                  long tree virtualizes + scrolls internally; SidebarContent
                  scrolls both sections together. `50vh` is the bootstrap height
                  before the first measurement lands. */}
              <Collapsible defaultOpen className="group/files flex shrink-0 flex-col">
                {/* SidebarGroup wrapper matches the Skills section so the two
                    headers + their content share the same gutter alignment.
                    `px-0` overrides the base `p-2`'s horizontal inset — the
                    header's own `px-2` (below) and Pierre's
                    `--trees-padding-inline-override` (file-tree-density.ts)
                    already each land at 8px, so stacking the group's own 8px
                    on top would double it to 16px. */}
                <SidebarGroup className="min-h-0 px-0">
                  <SidebarGroupLabel asChild className="shrink-0">
                    <CollapsibleTrigger
                      // Marks the project-root header so right-click opens the project-scoped menu.
                      data-sidebar-root-context
                      className="flex w-full items-center gap-1.5"
                    >
                      <FolderOpen className="size-3.5 shrink-0" />
                      <span className="truncate">{projectName}</span>
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/files:rotate-90" />
                    </CollapsibleTrigger>
                  </SidebarGroupLabel>
                  <CollapsibleContent
                    className="flex max-h-[70vh] flex-col overflow-hidden"
                    style={{
                      // Sized flush to the tree's measured content height so the
                      // Skills section sits directly beneath the files with no
                      // gap; `max-h-[70vh]` caps it so a long tree virtualizes +
                      // scrolls instead. The deselect-to-root hit target moved to
                      // the empty filler below (a flush tree leaves no empty space
                      // of its own to click).
                      height: treeContentHeight != null ? `${treeContentHeight}px` : '50vh',
                    }}
                  >
                    <FileTree ref={setTree} onContentHeightChange={setTreeContentHeight} />
                  </CollapsibleContent>
                </SidebarGroup>
              </Collapsible>
              <SkillsSidebarSection />
              {/* Deselect-to-root hit target. With the tree sized flush to its
                  rows there's no empty space inside it to click, so the leftover
                  sidebar space below the sections takes over: clicking it clears
                  the creation target (New file / New folder then land at the
                  project root) and neutralizes the focused row's ring, exactly
                  like the old empty-tree-area click. Flex-grows to fill whatever
                  space the two sections leave; collapses to nothing (and the
                  sidebar scrolls) once they exceed the viewport. */}
              <div
                aria-hidden
                data-sidebar-empty-deselect
                className="min-h-8 flex-1 cursor-default"
                onClick={() => tree?.clearCreationTarget()}
              />
            </SidebarContent>
            <SidebarFooter className="px-0">
              <OnboardingCardMount />
              <UpdateNotices />
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
        <ContextMenuContent className="min-w-52">
          {/*
           * Empty-space menu — 11 items, 4 sections.
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
           * Section 3: Toggle. Two ContextMenuCheckboxItems mirror the View
           * menu. Read state from the merged config; write through the
           * project-local CRDT binding so the View menu and any other surface
           * stay in sync via the existing subscribe path.
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
              aria-label={workspace ? t`Reveal in Finder` : t`Reveal in Finder, No workspace`}
            >
              <FolderOpen aria-hidden="true" />
              <span className="flex-1">
                <Trans>Reveal in Finder</Trans>
              </span>
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
            onCheckedChange={handleEmptySpaceShowHiddenFilesToggle}
            disabled={projectLocalBinding === null}
            data-testid="empty-space-menu-show-hidden-files"
          >
            <Trans>Show hidden files</Trans>
          </ContextMenuCheckboxItem>
          {showEmptySpaceTreeStateSection ? <ContextMenuSeparator /> : null}
          {showEmptySpaceExpandAll ? (
            <ContextMenuItem
              onSelect={handleEmptySpaceExpandAll}
              data-testid="empty-space-menu-expand-all"
            >
              <UnfoldVertical aria-hidden="true" />
              <Trans>Expand all</Trans>
            </ContextMenuItem>
          ) : null}
          {showEmptySpaceCollapseAll ? (
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
