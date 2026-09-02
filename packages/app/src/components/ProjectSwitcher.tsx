import { Trans, useLingui } from '@lingui/react/macro';
import {
  ChevronsUpDown,
  FileText,
  FolderOpen,
  GitBranch,
  LayoutGrid,
  Plus,
  Search,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { SidebarMenuButton } from '@/components/ui/sidebar';
import { useCurrentBranch } from '@/hooks/use-current-branch';
import { useWorktrees } from '@/hooks/use-worktrees';
import type { OkDesktopBridge, RecentProjectEntry } from '@/lib/desktop-bridge-types';
import { runWithToast as runWithToastBase } from '@/lib/error-state';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';
import { cn } from '@/lib/utils';
import { CreateProjectDialog } from './CreateProjectDialog';
import { NewWorktreeDialog } from './NewWorktreeDialog';
import { RecentProjectsMenu } from './RecentProjectsMenu';

export const runWithToast = (
  fn: () => Promise<void>,
  fallback: string,
  toastApi?: { error(msg: string): void },
): Promise<void> => runWithToastBase(fn, fallback, toastApi, 'ProjectSwitcher');

const SELECT_GUARD_MS = 350;

interface ProjectSwitcherProps {
  bridge: OkDesktopBridge;
}

export function ProjectSwitcher({ bridge }: ProjectSwitcherProps) {
  const { t } = useLingui();
  const [recents, setRecents] = useState<RecentProjectEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [newWorktreeOpen, setNewWorktreeOpen] = useState(false);
  const [newWorktreeInitialName, setNewWorktreeInitialName] = useState('');
  const [flyoutPath, setFlyoutPath] = useState<string | null>(null);
  const branch = useCurrentBranch();
  const worktreeModel = useWorktrees();

  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;
  const sawPointerDownRef = useRef(false);
  const withinOpenGuardRef = useRef(false);
  const openGuardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleOpenChange = (next: boolean): void => {
    if (next) {
      withinOpenGuardRef.current = true;
      if (openGuardTimerRef.current !== null) clearTimeout(openGuardTimerRef.current);
      openGuardTimerRef.current = setTimeout(() => {
        withinOpenGuardRef.current = false;
      }, SELECT_GUARD_MS);
    }
    setOpen(next);
    if (!next) {
      setSearch('');
      setFlyoutPath(null);
    }
  };

  const guardStaleSelect = (event: Event): boolean => {
    if (!isElectronHost || !withinOpenGuardRef.current) return false;
    event.preventDefault();
    return true;
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void runWithToast(async () => {
      const result = await bridge.project.listRecent();
      if (!cancelled) setRecents(result);
    }, t`Failed to load recent projects.`);
    return () => {
      cancelled = true;
    };
  }, [open, bridge, t]);

  useEffect(() => {
    return subscribeLocalMenuAction((action) => {
      if (action === 'new-worktree') {
        setOpen(false);
        setFlyoutPath(null);
        setNewWorktreeInitialName('');
        setNewWorktreeOpen(true);
      } else if (action === 'switch-worktree') {
        setOpen(true);
      }
    });
  }, []);

  const onOpenFolder = () => {
    handleOpenChange(false);
    void runWithToast(async () => {
      const path = await bridge.dialog.openFolder();
      if (!path) return;
      await bridge.project.open({ path, target: 'new-window', entryPoint: 'pick-existing' });
    }, t`Failed to open folder.`);
  };

  const onOpenFile = () => {
    handleOpenChange(false);
    void runWithToast(() => bridge.project.openFile(), t`Failed to open file.`);
  };

  const onSwitchProject = () => {
    handleOpenChange(false);
    void runWithToast(() => bridge.navigator.open(), t`Failed to open Project Navigator.`);
  };

  const onRemoveRecent = (path: string) =>
    runWithToast(async () => {
      await bridge.project.removeRecent(path);
      setRecents((cur) => (cur === null ? cur : cur.filter((r) => r.path !== path)));
    }, t`Failed to remove project.`);

  const onCreateProject = () => {
    handleOpenChange(false);
    setCreateProjectOpen(true);
  };

  const openNewWorktreeWith = (name: string) => {
    handleOpenChange(false);
    setNewWorktreeInitialName(name);
    setNewWorktreeOpen(true);
  };

  const currentPath = bridge.config.projectPath;
  const query = search.trim().toLowerCase();
  const isSearching = query !== '';
  const loadedRecents = recents ?? [];
  const menuRecents = isSearching
    ? loadedRecents.filter((r) => !r.isLinkedWorktree)
    : loadedRecents;
  const menuWorktreeModel = isSearching ? null : worktreeModel;

  return (
    <>
      {}
      <DropdownMenu open={open} onOpenChange={handleOpenChange} modal={false}>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            className={cn(
              'justify-between text-sidebar-foreground/70 hover:text-sidebar-foreground! data-open:hover:text-sidebar-foreground!',
              branch !== null && 'h-auto py-1.5',
            )}
            data-testid="project-switcher-trigger"
            aria-label={t`Open project menu`}
            title={bridge.config.projectPath}
            onPointerDown={
              isElectronHost
                ? () => {
                    sawPointerDownRef.current = true;
                  }
                : undefined
            }
            onClick={
              isElectronHost
                ? () => {
                    if (sawPointerDownRef.current) {
                      sawPointerDownRef.current = false;
                      return;
                    }
                    handleOpenChange(!open);
                  }
                : undefined
            }
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate">{bridge.config.projectName}</span>
              {branch !== null ? (
                <span
                  className="flex min-w-0 items-center gap-1 text-xs text-sidebar-foreground/50 group-hover/menu-button:text-sidebar-foreground"
                  data-testid="project-switcher-branch"
                >
                  <GitBranch aria-hidden="true" className="size-3! shrink-0" />
                  <span className="truncate">{branch}</span>
                </span>
              ) : null}
            </span>
            <ChevronsUpDown aria-hidden="true" className="opacity-60" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          className="min-w-[260px]"
          data-testid="project-switcher-menu"
        >
          {}
          {recents === null ? null : recents.length === 0 ? (
            <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
              <Trans>No recent projects.</Trans>
            </DropdownMenuLabel>
          ) : (
            <>
              {}
              <InputGroup className="mb-1 h-8 border-0 shadow-none has-[[data-slot=input-group-control]:focus-visible]:ring-0">
                <InputGroupInput
                  aria-label={t`Search projects`}
                  placeholder={t`Search projects...`}
                  value={search}
                  onChange={(e) => {
                    if (e.target.value !== '') setFlyoutPath(null);
                    setSearch(e.target.value);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  data-testid="project-switcher-search"
                />
                <InputGroupAddon>
                  <Search aria-hidden="true" />
                </InputGroupAddon>
              </InputGroup>
              <DropdownMenuSeparator />
              {}
              <div
                className="max-h-64 overflow-x-hidden overflow-y-auto overscroll-contain subtle-scrollbar scroll-fade-mask"
                data-testid="project-switcher-scroll"
                onScroll={() => {
                  if (flyoutPath !== null) setFlyoutPath(null);
                }}
              >
                <RecentProjectsMenu
                  bridge={bridge}
                  recents={menuRecents}
                  currentPath={currentPath}
                  query={query}
                  worktreeModel={menuWorktreeModel}
                  closeMenu={() => handleOpenChange(false)}
                  guardStaleSelect={guardStaleSelect}
                  onRemoveRecent={onRemoveRecent}
                  flyoutPath={flyoutPath}
                  setFlyoutPath={setFlyoutPath}
                  openNewWorktreeWith={openNewWorktreeWith}
                />
              </div>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              if (guardStaleSelect(e)) return;
              onCreateProject();
            }}
            data-testid="project-switcher-new-project"
          >
            <Plus aria-hidden="true" className="text-muted-foreground" />
            <Trans>New project</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              if (guardStaleSelect(e)) return;
              onSwitchProject();
            }}
            data-testid="project-switcher-switch-project"
          >
            <LayoutGrid aria-hidden="true" className="text-muted-foreground" />
            <Trans>Switch project</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              if (guardStaleSelect(e)) return;
              onOpenFolder();
            }}
            data-testid="project-switcher-open-folder"
          >
            <FolderOpen aria-hidden="true" className="text-muted-foreground" />
            <Trans>Open folder</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              if (guardStaleSelect(e)) return;
              onOpenFile();
            }}
            data-testid="project-switcher-open-file"
          >
            <FileText aria-hidden="true" className="text-muted-foreground" />
            <Trans>Open file</Trans>
          </DropdownMenuItem>
          {}
          {branch !== null ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(e) => {
                  if (guardStaleSelect(e)) return;
                  handleOpenChange(false);
                  setNewWorktreeInitialName('');
                  setNewWorktreeOpen(true);
                }}
                data-testid="project-switcher-new-worktree"
              >
                <GitBranch aria-hidden="true" className="text-muted-foreground" />
                <Trans>New worktree</Trans>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateProjectDialog
        open={createProjectOpen}
        onOpenChange={setCreateProjectOpen}
        bridge={bridge}
      />
      <NewWorktreeDialog
        open={newWorktreeOpen}
        onOpenChange={setNewWorktreeOpen}
        bridge={bridge}
        currentBranch={branch}
        initialBranchName={newWorktreeInitialName}
        branches={worktreeModel?.entries
          .map((entry) => entry.branch)
          .filter((b): b is string => b !== null)}
        existingWorktreeBranches={
          new Set(
            worktreeModel?.entries
              .filter((entry) => entry.branch !== null && entry.worktreePath !== null)
              .map((entry) => entry.branch as string),
          )
        }
        remoteBranches={worktreeModel?.remoteBranches}
        behindByBranch={
          new Map(
            worktreeModel?.entries
              .filter((entry) => entry.branch !== null && entry.behind !== undefined)
              .map((entry) => [entry.branch as string, entry.behind as number]),
          )
        }
      />
    </>
  );
}
