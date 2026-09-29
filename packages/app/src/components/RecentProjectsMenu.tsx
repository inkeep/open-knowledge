// oxlint-disable ok/no-physical-direction-utility -- pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/ok-rules/README.md#no-physical-direction-utility

import type {
  WorktreeInventoryModel,
  WorktreeSelectorEntry,
  WorktreeSelectorModel,
} from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Check, GitBranch, Plus, Search } from 'lucide-react';
import type * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import type { OkDesktopBridge, RecentProjectEntry } from '@/lib/desktop-bridge-types';
import { cn } from '@/lib/utils';
import { worktreeCreateErrorCopy } from '@/lib/worktree-create-error';
import { refreshWorktrees } from '@/lib/worktree-store';
import {
  basenameOf,
  buildWorktreeFlyoutEntries,
  groupRecentsByRepo,
  type RecentRepoGroup,
  type RowLocation,
  rowLocation,
  type WorktreeFlyoutEntry,
} from './project-switcher-recents';
import { RecentItemContextMenu, RecentRemoveButton } from './recent-remove-controls';

interface RecentProjectsMenuProps {
  bridge: OkDesktopBridge;
  recents: readonly RecentProjectEntry[];
  currentPath: string;
  query: string;
  worktreeModel: WorktreeSelectorModel | null;
  closeMenu: () => void;
  guardStaleSelect: (event: Event) => boolean;
  onRemoveRecent: (path: string) => void;
  flyoutPath: string | null;
  setFlyoutPath: React.Dispatch<React.SetStateAction<string | null>>;
  openNewWorktreeWith: (name: string) => void;
}

interface InventoryViewState {
  readonly inventory: WorktreeInventoryModel | null;
  readonly loading: boolean;
  readonly error: boolean;
}

export function RecentProjectsMenu({
  bridge,
  recents,
  currentPath,
  query,
  worktreeModel,
  closeMenu,
  guardStaleSelect,
  onRemoveRecent,
  flyoutPath,
  setFlyoutPath,
  openNewWorktreeWith,
}: RecentProjectsMenuProps) {
  const { t } = useLingui();
  const [inventoryViews, setInventoryViews] = useState<Record<string, InventoryViewState>>({});
  const groups = groupRecentsByRepo(recents);

  async function loadInventory(group: RecentRepoGroup): Promise<void> {
    if (group.inventoryAnchorPath === null || group.gitCommonDir === null) return;
    setInventoryViews((current) => ({
      ...current,
      [group.key]: {
        inventory: current[group.key]?.inventory ?? null,
        loading: true,
        error: false,
      },
    }));
    try {
      const result = await bridge.worktree.inventory({ projectPath: group.inventoryAnchorPath });
      setInventoryViews((current) => ({
        ...current,
        [group.key]: {
          inventory: result.ok ? result.inventory : (current[group.key]?.inventory ?? null),
          loading: false,
          error: !result.ok,
        },
      }));
    } catch (error) {
      console.warn('[RecentProjectsMenu] worktree inventory failed:', error);
      setInventoryViews((current) => ({
        ...current,
        [group.key]: {
          inventory: current[group.key]?.inventory ?? null,
          loading: false,
          error: true,
        },
      }));
    }
  }

  function openPath(path: string, entryPoint: 'recents' | 'worktree'): void {
    closeMenu();
    void bridge.project
      .open({
        path,
        target: 'new-window',
        entryPoint,
        ...(entryPoint === 'worktree' ? { requireExactManagedProject: true } : {}),
      })
      .catch((err) => {
        console.warn('[RecentProjectsMenu] project.open failed:', err);
        toast.error(t`Failed to open.`);
      });
  }

  async function createAndOpenBranch(branch: string): Promise<void> {
    try {
      const result = await bridge.worktree.create({ branch, createBranch: false });
      if (!result.ok) {
        if (result.reason === 'project-scope-unavailable') refreshWorktrees();
        toast.error(t(worktreeCreateErrorCopy(result)));
        return;
      }
      refreshWorktrees();
      await bridge.project.open({
        path: result.path,
        target: 'new-window',
        entryPoint: 'worktree',
        requireExactManagedProject: true,
      });
    } catch (err) {
      console.warn('[RecentProjectsMenu] create/open branch failed:', err);
      toast.error(t`Failed to open worktree.`);
    }
  }

  function onPickEntry(entry: RecentProjectEntry): void {
    if (entry.path === currentPath) {
      closeMenu();
      return;
    }
    openPath(entry.path, entry.isLinkedWorktree ? 'worktree' : 'recents');
  }

  function onPickFlyoutEntry(entry: WorktreeFlyoutEntry): void {
    if (entry.kind === 'checkout' && (entry.prunable || entry.availability !== 'available')) return;
    if (entry.kind === 'checkout' && entry.inventoryOpenRequest !== null) {
      if (entry.path === currentPath) {
        closeMenu();
        return;
      }
      closeMenu();
      void bridge.worktree
        .openInventory(entry.inventoryOpenRequest)
        .then((result) => {
          if (!result.ok && result.reason !== 'open-failed') {
            toast.error(t`This worktree is no longer available.`);
          }
        })
        .catch((error) => {
          console.warn('[RecentProjectsMenu] worktree.openInventory failed:', error);
          toast.error(t`Failed to open worktree.`);
        });
      return;
    }
    if (entry.path !== null) {
      if (entry.path === currentPath) {
        closeMenu();
        return;
      }
      openPath(entry.path, entry.location === 'primary' ? 'recents' : 'worktree');
      return;
    }
    if (entry.branch !== null) {
      closeMenu();
      void createAndOpenBranch(entry.branch);
    }
  }

  if (query !== '') {
    const inventoryEntries = groups.flatMap((group) => {
      const inventory = inventoryViews[group.key]?.inventory ?? null;
      return inventory === null
        ? []
        : buildWorktreeFlyoutEntries(group, inventory, null, currentPath).filter(
            (entry) => entry.kind === 'checkout',
          );
    });
    return (
      <SearchResults
        recents={recents}
        currentPath={currentPath}
        query={query}
        worktreeModel={worktreeModel}
        inventoryEntries={inventoryEntries}
        onPickEntry={onPickEntry}
        onPickBranch={(branch) => {
          closeMenu();
          void createAndOpenBranch(branch);
        }}
        onPickInventoryEntry={onPickFlyoutEntry}
        guardStaleSelect={guardStaleSelect}
        onRemoveRecent={onRemoveRecent}
      />
    );
  }

  return (
    <>
      {groups.map((group) => (
        <GroupRow
          key={group.key}
          group={group}
          currentPath={currentPath}
          worktreeModel={worktreeModel}
          inventoryView={inventoryViews[group.key] ?? null}
          flyoutOpen={flyoutPath === group.key}
          setFlyoutOpen={(next) => {
            setFlyoutPath((cur) => (next ? group.key : cur === group.key ? null : cur));
            if (next) void loadInventory(group);
          }}
          onPickProject={() => {
            const primary = group.primaryProject;
            if (primary === null || primary.missing === true) return;
            if (primary.path === currentPath) {
              closeMenu();
              return;
            }
            openPath(primary.path, 'recents');
          }}
          onPickFlyoutEntry={onPickFlyoutEntry}
          guardStaleSelect={guardStaleSelect}
          onRemoveRecent={onRemoveRecent}
          openNewWorktreeWith={openNewWorktreeWith}
        />
      ))}
    </>
  );
}

function GroupRow({
  group,
  currentPath,
  worktreeModel,
  inventoryView,
  flyoutOpen,
  setFlyoutOpen,
  onPickProject,
  onPickFlyoutEntry,
  guardStaleSelect,
  onRemoveRecent,
  openNewWorktreeWith,
}: {
  group: RecentRepoGroup;
  currentPath: string;
  worktreeModel: WorktreeSelectorModel | null;
  inventoryView: InventoryViewState | null;
  flyoutOpen: boolean;
  setFlyoutOpen: (open: boolean) => void;
  onPickProject: () => void;
  onPickFlyoutEntry: (entry: WorktreeFlyoutEntry) => void;
  guardStaleSelect: (event: Event) => boolean;
  onRemoveRecent: (path: string) => void;
  openNewWorktreeWith: (name: string) => void;
}) {
  const projectIsCurrent = group.primaryProject?.path === currentPath;
  const flyoutEntries = buildWorktreeFlyoutEntries(
    group,
    inventoryView?.inventory ?? null,
    worktreeModel,
    currentPath,
  );
  const openedWorktreeCount =
    inventoryView?.inventory === null || inventoryView === null
      ? null
      : flyoutEntries.filter((entry) => entry.kind === 'checkout' && entry.location !== 'primary')
          .length;

  if (group.gitCommonDir === null) {
    return (
      <RecentItemContextMenu
        path={group.project.path}
        onRemoveRecent={onRemoveRecent}
        testIdPrefix="project-switcher-recent"
      >
        <div className="group/recent relative flex items-center">
          <DropdownMenuItem
            onSelect={(e) => {
              if (guardStaleSelect(e)) return;
              onPickProject();
            }}
            className="flex w-full min-w-0 flex-col items-start gap-0.5 pr-8"
            data-testid={`project-switcher-recent-${group.project.path}`}
            data-current={projectIsCurrent ? 'true' : undefined}
          >
            <ProjectLabel
              name={group.project.name}
              path={group.project.path}
              current={projectIsCurrent}
            />
          </DropdownMenuItem>
          <RecentRemoveButton
            path={group.project.path}
            name={group.project.name}
            onRemoveRecent={onRemoveRecent}
            testIdPrefix="project-switcher-recent"
          />
        </div>
      </RecentItemContextMenu>
    );
  }

  const containsCurrent = group.recentEntries.some((entry) => entry.path === currentPath);
  return (
    <FlyoutGroup
      group={group}
      currentPath={currentPath}
      containsCurrent={containsCurrent}
      inventoryView={inventoryView}
      flyoutEntries={flyoutEntries}
      openedWorktreeCount={openedWorktreeCount}
      flyoutOpen={flyoutOpen}
      setFlyoutOpen={setFlyoutOpen}
      onPickProject={onPickProject}
      onPickFlyoutEntry={onPickFlyoutEntry}
      guardStaleSelect={guardStaleSelect}
      openNewWorktreeWith={openNewWorktreeWith}
    />
  );
}

function FlyoutGroup({
  group,
  currentPath,
  containsCurrent,
  inventoryView,
  flyoutEntries,
  openedWorktreeCount,
  flyoutOpen,
  setFlyoutOpen,
  onPickProject,
  onPickFlyoutEntry,
  guardStaleSelect,
  openNewWorktreeWith,
}: {
  group: RecentRepoGroup;
  currentPath: string;
  containsCurrent: boolean;
  inventoryView: InventoryViewState | null;
  flyoutEntries: WorktreeFlyoutEntry[];
  openedWorktreeCount: number | null;
  flyoutOpen: boolean;
  setFlyoutOpen: (open: boolean) => void;
  onPickProject: () => void;
  onPickFlyoutEntry: (entry: WorktreeFlyoutEntry) => void;
  guardStaleSelect: (event: Event) => boolean;
  openNewWorktreeWith: (name: string) => void;
}) {
  const { t } = useLingui();
  const projectIsCurrent = group.primaryProject?.path === currentPath;
  const primaryIsOpenable = group.primaryProject !== null && group.primaryProject.missing !== true;

  const openProjectFromRow = (nativeEvent: Event): void => {
    if (!primaryIsOpenable) return;
    if (guardStaleSelect(nativeEvent)) return;
    onPickProject();
  };
  return (
    <DropdownMenuSub open={flyoutOpen} onOpenChange={setFlyoutOpen}>
      <DropdownMenuSubTrigger
        onClick={(e) => {
          if ((e.target as Element).closest('[data-project-open]') === null) return;
          e.preventDefault();
          openProjectFromRow(e.nativeEvent);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openProjectFromRow(e.nativeEvent);
          }
        }}
        className="flex w-full min-w-0 items-start gap-2"
        data-testid={`project-switcher-group-${group.project.path}`}
        data-flyout-open={flyoutOpen ? 'true' : undefined}
        data-current={containsCurrent ? 'true' : undefined}
      >
        {}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {}
          <span
            className="truncate font-medium text-sm"
            data-project-open={primaryIsOpenable ? '' : undefined}
            title={group.repositoryName}
          >
            {group.repositoryName}
          </span>
          <span className="truncate text-muted-foreground text-xs" title={group.project.path}>
            {group.project.path}
          </span>
        </span>
        {projectIsCurrent ? (
          <Check
            aria-label={t`Current`}
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
          />
        ) : null}
        {group.primaryProject?.missing === true ? (
          <MissingCheckoutStatus className="mt-0.5" />
        ) : null}
        {}
        {openedWorktreeCount === null ? null : (
          <span
            className="mt-0.5 shrink-0 text-muted-foreground text-xs"
            data-testid={`project-switcher-toggle-${group.project.path}`}
          >
            <span className="tabular-nums">{openedWorktreeCount}</span>{' '}
            <Plural value={openedWorktreeCount} one="worktree" other="worktrees" />
          </span>
        )}
      </DropdownMenuSubTrigger>
      <WorktreeFlyout
        group={group}
        currentPath={currentPath}
        open={flyoutOpen}
        inventoryView={inventoryView}
        entries={flyoutEntries}
        onPickFlyoutEntry={onPickFlyoutEntry}
        guardStaleSelect={guardStaleSelect}
        openNewWorktreeWith={openNewWorktreeWith}
      />
    </DropdownMenuSub>
  );
}

function WorktreeFlyout({
  group,
  currentPath,
  open,
  inventoryView,
  entries,
  onPickFlyoutEntry,
  guardStaleSelect,
  openNewWorktreeWith,
}: {
  group: RecentRepoGroup;
  currentPath: string;
  open: boolean;
  inventoryView: InventoryViewState | null;
  entries: WorktreeFlyoutEntry[];
  onPickFlyoutEntry: (entry: WorktreeFlyoutEntry) => void;
  guardStaleSelect: (event: Event) => boolean;
  openNewWorktreeWith: (name: string) => void;
}) {
  const { t } = useLingui();
  const [flyoutQuery, setFlyoutQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) searchRef.current?.focus({ preventScroll: true });
  }, [open]);

  function focusableRows(): HTMLElement[] {
    const container = listRef.current;
    if (container === null) return [];
    return [...container.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled])')];
  }
  function focusRowAt(index: number): void {
    const rows = focusableRows();
    rows[index]?.focus();
  }
  function onRowKeyDown(e: React.KeyboardEvent, onEnter: () => void): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const rows = focusableRows();
      const i = rows.indexOf(e.currentTarget as HTMLElement);
      focusRowAt(Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const rows = focusableRows();
      const i = rows.indexOf(e.currentTarget as HTMLElement);
      if (i <= 0) searchRef.current?.focus();
      else focusRowAt(i - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      onEnter();
    }
  }

  const q = flyoutQuery.trim().toLowerCase();
  const visible =
    q === ''
      ? entries
      : entries.filter(
          (entry) =>
            (entry.branch ?? '').toLowerCase().includes(q) ||
            (entry.path ?? '').toLowerCase().includes(q),
        );
  const isCurrentProject = group.recentEntries.some((entry) => entry.path === currentPath);
  const typedName = flyoutQuery.trim();
  const canCreate = isCurrentProject && typedName.length > 0;

  return (
    <DropdownMenuPortal>
      <DropdownMenuSubContent
        avoidCollisions={false}
        sideOffset={-8}
        className="flex max-h-80 w-96 flex-col gap-1 overflow-hidden p-1"
        data-testid={`project-switcher-flyout-${group.project.path}`}
      >
        <InputGroup className="mb-1 h-8 shrink-0">
          {}
          <InputGroupAddon align="inline-start">
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchRef}
            aria-label={t`Search worktrees and branches`}
            placeholder={t`Search worktrees`}
            value={flyoutQuery}
            onChange={(e) => setFlyoutQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                focusRowAt(0);
              }
              e.stopPropagation();
            }}
            data-testid={`project-switcher-flyout-search-${group.project.path}`}
          />
        </InputGroup>
        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain subtle-scrollbar"
        >
          {inventoryView?.loading === true && inventoryView.inventory === null ? (
            <DropdownMenuLabel
              className="font-normal text-muted-foreground text-xs"
              role="status"
              aria-live="polite"
            >
              {t`Loading worktrees…`}
            </DropdownMenuLabel>
          ) : null}
          {inventoryView?.error === true ? (
            <DropdownMenuLabel
              className="font-normal text-destructive text-xs"
              role="status"
              aria-live="polite"
            >
              {t`Couldn't load worktrees.`}
            </DropdownMenuLabel>
          ) : null}
          {visible.length === 0 &&
          inventoryView?.loading !== true &&
          (inventoryView?.error !== true || q !== '') ? (
            <>
              <DropdownMenuLabel
                className="font-normal text-muted-foreground text-xs"
                role="status"
                aria-live="polite"
              >
                {q === '' ? t`No worktrees found.` : t`No matching worktrees or branches.`}
              </DropdownMenuLabel>
              {}
              {canCreate ? (
                <DropdownMenuItem
                  onSelect={(e) => {
                    if (guardStaleSelect(e)) return;
                    openNewWorktreeWith(typedName);
                  }}
                  onKeyDown={(e) => onRowKeyDown(e, () => openNewWorktreeWith(typedName))}
                  className="flex items-center gap-2"
                  data-testid="project-switcher-flyout-create"
                >
                  <Plus aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm" title={typedName}>
                    <Trans>
                      Create worktree{' '}
                      <span className="font-medium">
                        “<span className="font-mono">{typedName}</span>”
                      </span>
                    </Trans>
                  </span>
                </DropdownMenuItem>
              ) : null}
            </>
          ) : (
            visible.map((entry) => {
              const key = entry.path ?? `branch:${entry.branch}`;
              const label =
                entry.branch ??
                (entry.headSha === null
                  ? t`(detached)`
                  : t`Detached at ${entry.headSha.slice(0, 8)}`);
              const disabled =
                entry.kind === 'checkout' && (entry.prunable || entry.availability !== 'available');
              return (
                <DropdownMenuItem
                  key={key}
                  onSelect={(e) => {
                    if (guardStaleSelect(e)) return;
                    if (disabled) {
                      e.preventDefault();
                      return;
                    }
                    onPickFlyoutEntry(entry);
                  }}
                  onKeyDown={(e) =>
                    onRowKeyDown(e, () => {
                      if (!disabled) onPickFlyoutEntry(entry);
                    })
                  }
                  className="flex items-center gap-2 aria-disabled:opacity-50"
                  aria-disabled={disabled}
                  data-testid={`project-switcher-flyout-entry-${key}`}
                  data-current={entry.isCurrent ? 'true' : undefined}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm" title={label}>
                      {label}
                    </span>
                    {entry.path !== null ? (
                      <span className="truncate text-muted-foreground text-xs" title={entry.path}>
                        {entry.path}
                      </span>
                    ) : null}
                  </span>
                  <RowLocationBadge entry={entry} />
                  <CheckoutStatus entry={entry} />
                  {entry.isCurrent ? <CurrentCheck /> : null}
                </DropdownMenuItem>
              );
            })
          )}
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuPortal>
  );
}

function CheckoutStatus({ entry }: { entry: WorktreeFlyoutEntry }) {
  const { t } = useLingui();
  if (entry.kind !== 'checkout') return null;
  if (entry.prunable) {
    return (
      <span
        className="shrink-0 text-destructive text-xs"
        title={t`Git marks this worktree as prunable.`}
      >
        {t`stale Git entry`}
      </span>
    );
  }
  if (entry.availability === 'missing') {
    return <MissingCheckoutStatus />;
  }
  if (entry.availability === 'unreadable') {
    return (
      <span
        className="shrink-0 text-destructive text-xs"
        title={t`This checkout path cannot be read.`}
      >
        {t`path unreadable`}
      </span>
    );
  }
  return entry.locked ? (
    <span
      className="shrink-0 text-muted-foreground text-xs"
      title={t`Git has locked this worktree, but it can still be opened.`}
    >
      {t`locked`}
    </span>
  ) : null;
}

function MissingCheckoutStatus({ className }: { className?: string }) {
  const { t } = useLingui();
  return (
    <span
      className={cn('shrink-0 text-destructive text-xs', className)}
      title={t`The OpenKnowledge project is missing at this checkout path.`}
    >
      {t`project missing`}
    </span>
  );
}

function RowLocationBadge({ entry }: { entry: WorktreeFlyoutEntry }) {
  const { t } = useLingui();
  const copy: Record<RowLocation, { label: string; description: string }> = {
    primary: {
      label: t`primary`,
      description: t`The repository's original clone directory`,
    },
    internal: {
      label: t`internal`,
      description: t`Inside this repository's OpenKnowledge worktrees folder`,
    },
    external: {
      label: t`external`,
      description: t`Outside this repository's OpenKnowledge worktrees folder`,
    },
    unknown: {
      label: t`worktree`,
      description: t`A linked worktree whose location could not be loaded`,
    },
    none: {
      label: t`create worktree`,
      description: t`Create a worktree from this branch`,
    },
  };
  const { label, description } = copy[rowLocation(entry)];
  return (
    <span className="shrink-0 text-muted-foreground text-xs" title={description}>
      {label}
    </span>
  );
}

function SearchResults({
  recents,
  currentPath,
  query,
  worktreeModel,
  inventoryEntries,
  onPickEntry,
  onPickBranch,
  onPickInventoryEntry,
  guardStaleSelect,
  onRemoveRecent,
}: {
  recents: readonly RecentProjectEntry[];
  currentPath: string;
  query: string;
  worktreeModel: WorktreeSelectorModel | null;
  inventoryEntries: readonly WorktreeFlyoutEntry[];
  onPickEntry: (entry: RecentProjectEntry) => void;
  onPickBranch: (branch: string) => void;
  onPickInventoryEntry: (entry: WorktreeFlyoutEntry) => void;
  guardStaleSelect: (event: Event) => boolean;
  onRemoveRecent: (path: string) => void;
}) {
  const { t } = useLingui();
  const matches = (text: string): boolean => text.toLowerCase().includes(query);

  const projectMatches = recents.filter(
    (r) => !r.isLinkedWorktree && (matches(r.name) || matches(r.path)),
  );
  const openedWorktreeMatches = recents.filter(
    (r) => r.isLinkedWorktree === true && (matches(r.branch ?? '') || matches(r.path)),
  );
  const recentPaths = new Set(recents.map((entry) => entry.path));
  const inventoryMatches = inventoryEntries.filter(
    (entry) =>
      entry.kind === 'checkout' &&
      entry.path !== currentPath &&
      !recentPaths.has(entry.path) &&
      (matches(entry.branch ?? '') || matches(entry.path)),
  );
  const branchMatches: WorktreeSelectorEntry[] = (worktreeModel?.entries ?? []).filter(
    (e) => e.branch !== null && matches(e.branch) && e.worktreePath === null,
  );

  if (
    projectMatches.length === 0 &&
    openedWorktreeMatches.length === 0 &&
    inventoryMatches.length === 0 &&
    branchMatches.length === 0
  ) {
    return (
      <DropdownMenuLabel
        className="font-normal text-muted-foreground text-xs"
        role="status"
        aria-live="polite"
      >
        {t`No matching projects.`}
      </DropdownMenuLabel>
    );
  }

  return (
    <>
      {projectMatches.map((r) => (
        <RecentItemContextMenu
          key={r.path}
          path={r.path}
          onRemoveRecent={onRemoveRecent}
          testIdPrefix="project-switcher-recent"
        >
          <div className="group/recent relative flex items-center">
            <DropdownMenuItem
              onSelect={(e) => {
                if (guardStaleSelect(e)) return;
                if (r.missing === true) {
                  e.preventDefault();
                  return;
                }
                onPickEntry(r);
              }}
              aria-disabled={r.missing === true}
              className="flex w-full min-w-0 flex-col items-start gap-0.5 pr-8 aria-disabled:opacity-50"
              data-testid={`project-switcher-recent-${r.path}`}
            >
              <ProjectLabel name={r.name} path={r.path} current={r.path === currentPath} />
              {r.missing === true ? <MissingCheckoutStatus /> : null}
            </DropdownMenuItem>
            <RecentRemoveButton
              path={r.path}
              name={r.name}
              onRemoveRecent={onRemoveRecent}
              testIdPrefix="project-switcher-recent"
            />
          </div>
        </RecentItemContextMenu>
      ))}
      {openedWorktreeMatches.map((r) => (
        <DropdownMenuItem
          key={r.path}
          onSelect={(e) => {
            if (guardStaleSelect(e)) return;
            if (r.missing === true) {
              e.preventDefault();
              return;
            }
            onPickEntry(r);
          }}
          aria-disabled={r.missing === true}
          className="flex items-start gap-2 aria-disabled:opacity-50"
          data-testid={`project-switcher-worktree-${r.path}`}
          data-current={r.path === currentPath ? 'true' : undefined}
        >
          <GitBranch aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <WorktreeResultLabel
            branch={r.branch ?? r.name}
            project={r.mainRoot !== undefined ? basenameOf(r.mainRoot) : null}
          />
          {r.missing === true ? <MissingCheckoutStatus /> : null}
        </DropdownMenuItem>
      ))}
      {inventoryMatches.map((entry) => {
        if (entry.kind !== 'checkout') return null;
        const label = entry.branch ?? entry.headSha?.slice(0, 8) ?? t`(detached)`;
        const disabled = entry.prunable || entry.availability !== 'available';
        return (
          <DropdownMenuItem
            key={`inventory:${entry.path}`}
            onSelect={(event) => {
              if (guardStaleSelect(event)) return;
              if (disabled) {
                event.preventDefault();
                return;
              }
              onPickInventoryEntry(entry);
            }}
            aria-disabled={disabled}
            className="flex items-start gap-2 aria-disabled:opacity-50"
            data-testid={`project-switcher-inventory-${entry.path}`}
          >
            <GitBranch aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <WorktreeResultLabel branch={label} project={entry.path} />
            <CheckoutStatus entry={entry} />
          </DropdownMenuItem>
        );
      })}
      {branchMatches.map((e) => (
        <DropdownMenuItem
          key={`branch:${e.branch}`}
          onSelect={(ev) => {
            if (guardStaleSelect(ev)) return;
            if (e.branch !== null) onPickBranch(e.branch);
          }}
          className="flex items-start gap-2"
          data-testid={`project-switcher-branch-${e.branch}`}
        >
          <GitBranch aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 opacity-40" />
          <WorktreeResultLabel
            branch={e.branch ?? ''}
            project={worktreeModel !== null ? basenameOf(worktreeModel.mainRoot) : null}
            hint={t`create worktree`}
          />
        </DropdownMenuItem>
      ))}
    </>
  );
}

function WorktreeResultLabel({
  branch,
  project,
  hint,
}: {
  branch: string;
  project: string | null;
  hint?: string;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm">{branch}</span>
        {hint !== undefined ? (
          <span className="shrink-0 text-muted-foreground text-xs">{hint}</span>
        ) : null}
      </span>
      {project !== null ? (
        <span className="truncate text-muted-foreground text-xs" title={project}>
          {project}
        </span>
      ) : null}
    </span>
  );
}

function ProjectLabel({ name, path, current }: { name: string; path: string; current: boolean }) {
  return (
    <span className="flex w-full min-w-0 flex-col gap-0.5">
      <span className={cn('flex w-full items-center gap-1.5', current && 'font-medium')}>
        <span className="truncate font-medium text-sm" title={name}>
          {name}
        </span>
        {current ? (
          <Check aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
      </span>
      <span className="w-full truncate text-muted-foreground text-xs" title={path}>
        {path}
      </span>
    </span>
  );
}

function CurrentCheck() {
  const { t } = useLingui();
  return <Check aria-label={t`Current`} className="size-3.5 shrink-0 text-muted-foreground" />;
}
