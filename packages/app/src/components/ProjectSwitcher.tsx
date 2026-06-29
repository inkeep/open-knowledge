import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronsUpDown, FolderOpen, GitBranch, LayoutGrid, Plus, Search } from 'lucide-react';
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
import type { OkDesktopBridge, RecentProjectEntry } from '@/lib/desktop-bridge-types';
import { runWithToast as runWithToastBase } from '@/lib/error-state';
import { cn } from '@/lib/utils';
import { CreateProjectDialog } from './CreateProjectDialog';

export const runWithToast = (
  fn: () => Promise<void>,
  fallback: string,
  toastApi?: { error(msg: string): void },
): Promise<void> => runWithToastBase(fn, fallback, toastApi, 'ProjectSwitcher');

interface ProjectSwitcherProps {
  bridge: OkDesktopBridge;
}

export function ProjectSwitcher({ bridge }: ProjectSwitcherProps) {
  const { t } = useLingui();
  const [recents, setRecents] = useState<RecentProjectEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const branch = useCurrentBranch();

  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;
  const sawPointerDownRef = useRef(false);

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (!next) setSearch('');
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

  const openProject = (path: string) => {
    setOpen(false);
    void runWithToast(
      () => bridge.project.open({ path, target: 'new-window', entryPoint: 'recents' }),
      t`Failed to open project.`,
    );
  };

  const onOpenFolder = () => {
    setOpen(false);
    void runWithToast(async () => {
      const path = await bridge.dialog.openFolder();
      if (!path) return;
      await bridge.project.open({ path, target: 'new-window', entryPoint: 'pick-existing' });
    }, t`Failed to open folder.`);
  };

  const onSwitchProject = () => {
    setOpen(false);
    void runWithToast(() => bridge.navigator.open(), t`Failed to open Project Navigator.`);
  };

  const onCreateProject = () => {
    setOpen(false);
    setCreateProjectOpen(true);
  };

  const currentPath = bridge.config.projectPath;
  const switchable = recents.filter((r) => r.path !== currentPath);

  const query = search.trim().toLowerCase();
  const filtered = query
    ? switchable.filter(
        (r) => r.name.toLowerCase().includes(query) || r.path.toLowerCase().includes(query),
      )
    : switchable;

  return (
    <>
      {/*
        Non-modal (matches the Cloud/Sync Popover, which is non-modal and works
        normally). In the macOS desktop app, outside-click dismissal relies on a
        `pointerdown` Chromium does not deliver here (see the trigger onClick
        below), and a modal dropdown additionally disables pointer events on the
        rest of the chrome while open — together that left the menu impossible
        to dismiss by clicking out. Non-modal keeps the rest of the UI live and
        restores outside-click dismissal; the menu still closes on item-select,
        Escape, or re-clicking the trigger.
      */}
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
          {switchable.length === 0 ? (
            <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
              <Trans>No other recent projects.</Trans>
            </DropdownMenuLabel>
          ) : (
            <>
              {/* stopPropagation on keydown so Radix's menu typeahead doesn't
                swallow keystrokes meant for the filter field. */}
              <InputGroup className="mb-1 h-8 border-0 shadow-none has-[[data-slot=input-group-control]:focus-visible]:ring-0">
                <InputGroupInput
                  aria-label={t`Search recent projects`}
                  placeholder={t`Search recent projects...`}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  data-testid="project-switcher-search"
                />
                <InputGroupAddon>
                  <Search aria-hidden="true" />
                </InputGroupAddon>
              </InputGroup>
              <DropdownMenuSeparator />
              {filtered.length === 0 ? (
                <DropdownMenuLabel
                  className="font-normal text-muted-foreground text-xs"
                  role="status"
                  aria-live="polite"
                >
                  <Trans>No matching projects.</Trans>
                </DropdownMenuLabel>
              ) : (
                <div className="max-h-64 overflow-x-hidden overflow-y-auto overscroll-contain subtle-scrollbar scroll-fade-mask">
                  {filtered.slice(0, 10).map((row) => (
                    <DropdownMenuItem
                      key={row.path}
                      disabled={row.missing}
                      onSelect={() => openProject(row.path)}
                      className="flex w-full min-w-0 flex-col items-start gap-0.5"
                      data-testid={`project-switcher-recent-${row.path}`}
                    >
                      <span className="w-full truncate font-medium text-sm" title={row.name}>
                        {row.name}
                      </span>
                      <span
                        className="w-full truncate text-muted-foreground text-xs"
                        title={row.path}
                      >
                        {row.path}
                        {row.missing ? t`  (missing)` : ''}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </div>
              )}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onOpenFolder} data-testid="project-switcher-open-folder">
            <FolderOpen aria-hidden="true" className="text-muted-foreground" />
            <Trans>Open folder</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onSwitchProject}
            data-testid="project-switcher-switch-project"
          >
            <LayoutGrid aria-hidden="true" className="text-muted-foreground" />
            <Trans>Switch project</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onCreateProject} data-testid="project-switcher-new-project">
            <Plus aria-hidden="true" className="text-muted-foreground" />
            <Trans>New project</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateProjectDialog
        open={createProjectOpen}
        onOpenChange={setCreateProjectOpen}
        bridge={bridge}
      />
    </>
  );
}
