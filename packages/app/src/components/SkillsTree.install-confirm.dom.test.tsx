import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SkillActions } from '@/components/skill-actions';
import { TooltipProvider } from '@/components/ui/tooltip';

const skill: SkillsListEntry = {
  name: 'demo',
  scope: 'project',
  path: '.claude/skills/demo/SKILL.md',
  installed: true,
  hosts: ['claude', 'codex', 'cursor'],
  symlinkedHosts: ['codex'],
  hostAliases: { pi: '.opencode/skills' },
} as SkillsListEntry;

const treeMenuClosed = vi.fn();
const putSkillFolderAction = vi.fn(async (_body: unknown) => ({ ok: true as const }));
const convertLocations = vi.fn(async () => {});

function isEventInTreeContextMenu(event: Event): boolean {
  for (const entry of event.composedPath()) {
    if (!(entry instanceof HTMLElement)) continue;
    if (entry.dataset.fileTreeContextMenuRoot === 'true') return true;
  }
  return false;
}

function TreeContextMenuHost({
  renderContextMenu,
}: {
  renderContextMenu: (
    item: { path: string },
    context: { close: (options?: { restoreFocus: boolean }) => void },
  ) => ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (isEventInTreeContextMenu(event)) return;
      if (hostRef.current?.contains(target) === true) return;
      treeMenuClosed();
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [open]);
  return (
    <div ref={hostRef}>
      {open
        ? renderContextMenu(
            { path: 'PROJECT/demo' },
            {
              close: () => {
                treeMenuClosed();
                setOpen(false);
              },
            },
          )
        : null}
    </div>
  );
}

vi.doMock('@pierre/trees/react', () => ({
  useFileTree: () => ({
    model: {
      focusPath: () => {},
      getItem: () => undefined,
      getSelectedPaths: () => [],
      subscribe: () => () => {},
    },
  }),
}));

vi.doMock('@/components/OkFileTree', () => ({ OkFileTree: TreeContextMenuHost }));

vi.doMock('@/components/SkillBulkDeleteDialog', () => ({ SkillBulkDeleteDialog: () => null }));
vi.doMock('@/lib/use-workspace', () => ({ useWorkspace: () => null }));
vi.doMock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => () => {} }));
vi.doMock('@/hooks/use-skills', () => ({ useSkills: () => ({ status: 'ready', data: [skill] }) }));
vi.doMock('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: {} }),
}));
vi.doMock('@/components/handoff/useHandoffDispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/handoff/useHandoffDispatch')>()),
  useHandoffDispatch: () => ({ dispatch: () => {} }),
}));
vi.doMock('@/components/handoff/OpenInAgentContextSubmenu', () => ({
  OpenInAgentContextSubmenu: () => null,
}));
vi.doMock('@/lib/skills-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skills-api')>()),
  putSkillFolderAction,
}));

const { SkillsTree } = await import('./SkillsTree');

const actions = {
  installingName: null,
  install: vi.fn(),
  convertLocations,
  runLocationWrite: vi.fn(),
  requestForkResolve: vi.fn(),
} as unknown as SkillActions;

function renderTree() {
  render(
    <SkillsTree
      paths={['PROJECT/demo']}
      activePath={undefined}
      initialExpandedPaths={[]}
      onExpandedChange={() => {}}
      sort={() => 0}
      skillByPrefix={new Map([['PROJECT/demo', skill]])}
      detectedByPrefix={new Map()}
      groupByPrefix={new Map()}
      pinnedPrefixes={new Set()}
      pinningReadyByScope={{ global: true, project: true }}
      labelToScope={new Map([['PROJECT', 'project']])}
      scopeDescription={{ global: 'Global', project: 'Project' }}
      existingNames={{ global: new Set(), project: new Set(['demo']) }}
      actions={actions}
      onOpenSkillMd={() => {}}
      onOpenFile={() => {}}
      onOpenDetected={() => {}}
      onOpenManaged={() => {}}
      onNewSkill={() => {}}
      onAddSkill={() => {}}
      isPinned={() => false}
      onTogglePin={() => {}}
    />,
    { wrapper: TooltipProvider },
  );
}

async function openInstallSubmenu() {
  renderTree();
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Install' }));
  await screen.findByTestId('skill-install-all');
}

describe('skills tree context menu install confirmations', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test('confirming with the pointer runs the action and the tree menu stays open', async () => {
    await openInstallSubmenu();
    await userEvent.click(screen.getByTestId('skill-audience-unfollow-pi'));

    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop reading' }),
    );

    expect(putSkillFolderAction).toHaveBeenCalledWith({
      scope: 'project',
      root: '.pi/skills',
      action: 'unlink',
      exclude: ['demo'],
    });
    expect(treeMenuClosed).not.toHaveBeenCalled();
    expect(screen.getByTestId('skill-install-all')).toBeTruthy();
  });

  test('a conversion confirmed with the pointer reaches the skill actions', async () => {
    await openInstallSubmenu();
    await userEvent.click(screen.getByTestId('skill-convert-cursor'));

    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Replace with symlink',
      }),
    );

    expect(convertLocations).toHaveBeenCalledWith(skill, [{ target: 'cursor', mode: 'link' }]);
  });

  test('cancelling with the pointer, or pressing the dialog backdrop, leaves the tree menu open and runs nothing', async () => {
    await openInstallSubmenu();
    await userEvent.click(screen.getByTestId('skill-audience-unfollow-pi'));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(treeMenuClosed).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('skill-audience-unfollow-pi'));
    const overlay = document.querySelector<HTMLElement>('[data-slot="alert-dialog-overlay"]');
    expect(overlay).not.toBeNull();
    await userEvent.pointer({ keys: '[MouseLeft]', target: overlay as HTMLElement });

    expect(treeMenuClosed).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(putSkillFolderAction).not.toHaveBeenCalled();
  });
});
