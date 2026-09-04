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

const SIDEBAR_INTERACTIVE_CONTROL_SELECTOR =
  'button, [role="button"], [role="menuitem"], input, textarea, select, a[href]';

export function isInteractiveSidebarControl(target: EventTarget | null): boolean {
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
  const [tree, setTree] = useState<FileTreeHandle | null>(null);

  const { activeDocName, activeTarget } = useDocumentContext();
  const activeCreateDir =
    activeTarget?.kind === 'folder' || activeTarget?.kind === 'folder-index'
      ? activeTarget.folderPath
      : defaultInitialDir(activeDocName);
  const baseCreateDir = hasOkPathSegment(activeCreateDir) ? '' : activeCreateDir;
  const [treeCreationCleared, setTreeCreationCleared] = useState(false);
  const initialCreateDir = treeCreationCleared ? '' : baseCreateDir;

  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;

  const { state: sidebarState, toggleSidebar } = useSidebar();
  const isEmbedded = useIsEmbedded();
  const isExpanded = sidebarState === 'expanded';
  const isCollapsed = sidebarState === 'collapsed';
  const shouldFadeChrome = isElectronHost && isCollapsed;

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

  const rootFolderConfig = useFolderConfig('');
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

  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const workspace = useWorkspace();
  const projectName =
    bridge?.config?.projectName ||
    workspace?.contentDir.split('/').filter(Boolean).pop() ||
    t`Files`;
  const { status: gitSyncStatus } = useGitSyncStatusDetailed();
  const hasRemote = gitSyncStatus?.hasRemote === true;
  const handoffInstallStates = useInstalledAgents().states;
  const { dispatch: dispatchHandoff } = useHandoffDispatch();
  const emptySpaceHandoffInput = buildProjectScopedHandoffInput({ workspace });
  const terminalLaunch = useTerminalLaunch();
  const enabledOverrides = useEnabledOverrides();
  const registeredAgents = useRegisteredAgents();
  const defaultRegisteredAgent = useDefaultRegisteredAgent();
  const stickyAgentId = useStickyAgent();
  const { projectLocalBinding, merged } = useConfigContext();
  const showHiddenFiles = merged?.appearance?.sidebar?.showHiddenFiles ?? false;
  const showOkFolders = merged?.appearance?.sidebar?.showOkFolders ?? false;
  const showOnlyMarkdownFiles = merged?.appearance?.sidebar?.showOnlyMarkdownFiles ?? false;
  const showSkillGroups = merged?.appearance?.sidebar?.showSkillGroups ?? true;
  const [filesOpen, setFilesOpen] = useState(true);
  useEffect(() => subscribeToFilesSectionReveal(() => setFilesOpen(true)), []);
  const configSkillsSection = merged?.appearance?.sidebar?.showSkillsSection;
  const showSkillsSection = configSkillsSection ?? readCachedSkillsSectionVisible() ?? true;
  useEffect(() => {
    if (configSkillsSection !== undefined) writeCachedSkillsSectionVisible(configSkillsSection);
  }, [configSkillsSection]);
  const showExpandAll = hasFolders && !allExpanded;
  const showCollapseAll = hasFolders && !noneExpanded;
  const showTreeStateSection = showExpandAll || showCollapseAll;
  const suppressCreateMenuFocusRestoreRef = useRef(false);
  const handleCreateMenuCloseAutoFocus = (event: Event) => {
    if (!suppressCreateMenuFocusRestoreRef.current) return;
    suppressCreateMenuFocusRestoreRef.current = false;
    event.preventDefault();
  };

  const handleSidebarSurfaceContextMenu: MouseEventHandler<HTMLDivElement> = (event) => {
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: patchSidebarVisibility is behaviorally stable — it reads only projectLocalBinding + t, both already deps; listing the helper itself would re-create the subscription every render (sibling pattern: CommandPalette's refreshSemanticStatus).
  useEffect(() => {
    return subscribeLocalMenuAction((action) => {
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
            terminalLaunch?.launchInTerminal(input, selection.cli);
            return;
          }
          if (selection.kind === 'terminal') return;
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
          toggleSidebar();
          return;
        }
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
      {}
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
                'flex-row h-12 items-center py-0 pl-3 pr-2',
                'justify-between',
                isElectronHost && 'overflow-x-clip',
                isElectronHost &&
                  'motion-safe:transition-opacity motion-safe:duration-100 motion-safe:ease-out',
                isElectronHost && isExpanded && 'motion-safe:delay-100',
                shouldFadeChrome && 'opacity-0',
                isElectronHost && '[-webkit-app-region:drag]',
              )}
            >
              {isElectronHost ? (
                <div
                  aria-hidden="true"
                  data-testid="sidebar-traffic-light-reserve"
                  className="w-[var(--ok-titlebar-reserve-left,0px)] shrink-0 self-stretch"
                />
              ) : null}
              <div className="ml-auto flex shrink-0 items-center gap-0.5 [&>*]:[-webkit-app-region:no-drag]">
                {}
                {isElectronHost && isExpanded ? <NavigationHistoryControls /> : null}
                {}
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
              {}
              {
                <Collapsible
                  open={filesOpen}
                  onOpenChange={setFilesOpen}
                  className="group/files flex min-h-0 flex-col data-[state=open]:min-h-48 data-[state=open]:flex-1"
                >
                  <SidebarGroup className="min-h-0 flex-1 px-0">
                    {}
                    <SidebarGroupLabel className="shrink-0 gap-1 rounded-none">
                      <CollapsibleTrigger
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
                        role="group"
                        aria-label={t`Files toolbar`}
                        data-testid="sidebar-toolbar"
                        className={cn(
                          'flex items-center gap-0.5',
                          isElectronHost && '[&>*]:[-webkit-app-region:no-drag]',
                        )}
                      >
                        {}
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
                            {}
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
                            {}
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
              {}
              {showSkillsSection ? <SkillsSidebarDock filesOpen={filesOpen} /> : null}
            </SidebarContent>
            <SidebarFooter className="px-0">
              <OnboardingCardMount />
              <UpdateNotices />
              {}
              <FeedbackCardMount />
              {typeof window !== 'undefined' && window.okDesktop ? (
                <SidebarMenu>
                  <SidebarMenuItem>
                    <ProjectSwitcher bridge={window.okDesktop} />
                  </SidebarMenuItem>
                </SidebarMenu>
              ) : null}
            </SidebarFooter>
            {}
            <SidebarRail
              enableToggle={false}
              enableDrag={!(isEmbedded && sidebarState === 'collapsed')}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-52" onCloseAutoFocus={handleCreateMenuCloseAutoFocus}>
          {}
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
