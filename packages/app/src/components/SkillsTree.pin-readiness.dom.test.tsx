import type { SkillScope, SkillsListEntry } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SkillActions } from '@/components/skill-actions';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

const model = {
  focusPath: () => {},
  getItem: () => undefined,
  getSelectedPaths: () => [],
  subscribe: () => () => {},
};
let contextMenuPath = 'GLOBAL/alpha';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('@pierre/trees/react', () => ({
  useFileTree: () => ({ model }),
}));

vi.doMock('@/components/OkFileTree', () => ({
  OkFileTree: ({
    renderContextMenu,
  }: {
    renderContextMenu: (
      item: { path: string },
      context: { close: (options: { restoreFocus: boolean }) => void },
    ) => ReactNode;
  }) => <div>{renderContextMenu({ path: contextMenuPath }, { close: () => {} })}</div>,
}));

vi.doMock('@/components/skill-actions', () => ({
  SkillContextMenuItems: () => (
    <DropdownMenuItem data-testid="skills-menu-anchor">Actions</DropdownMenuItem>
  ),
  SkillFileContextMenuItems: () => null,
  SkillManagedContextMenuItems: () => null,
  SkillRevealMenuItem: () => null,
}));

vi.doMock('@/components/SkillBulkDeleteDialog', () => ({
  SkillBulkDeleteDialog: () => null,
}));

vi.doMock('@/hooks/use-open-skill', () => ({
  useOpenSkill: () => () => {},
}));

const { SkillsTree } = await import('./SkillsTree');

const skill: SkillsListEntry = {
  name: 'alpha',
  scope: 'global',
  path: '/tmp/alpha',
  installed: true,
  hosts: [],
};
const projectSkill: SkillsListEntry = {
  name: 'beta',
  scope: 'project',
  path: '/tmp/beta',
  installed: true,
  hosts: [],
};

function tree(
  pinningReadyByScope: Record<SkillScope, boolean>,
  onTogglePin: ReturnType<typeof vi.fn>,
) {
  return (
    <SkillsTree
      paths={['GLOBAL/alpha', 'PROJECT/beta']}
      activePath={undefined}
      initialExpandedPaths={[]}
      onExpandedChange={() => {}}
      sort={() => 0}
      skillByPrefix={
        new Map([
          ['GLOBAL/alpha', skill],
          ['PROJECT/beta', projectSkill],
        ])
      }
      detectedByPrefix={new Map()}
      groupByPrefix={new Map()}
      pinnedPrefixes={new Set()}
      pinningReadyByScope={pinningReadyByScope}
      labelToScope={
        new Map([
          ['GLOBAL', 'global'],
          ['PROJECT', 'project'],
        ])
      }
      scopeDescription={{ global: 'Global', project: 'Project' }}
      existingNames={{ global: new Set(['alpha']), project: new Set() }}
      actions={{} as SkillActions}
      onOpenSkillMd={() => {}}
      onOpenFile={() => {}}
      onOpenDetected={() => {}}
      onOpenManaged={() => {}}
      onNewSkill={() => {}}
      onAddSkill={() => {}}
      isPinned={() => false}
      onTogglePin={onTogglePin}
    />
  );
}

function renderTree(
  pinningReadyByScope: Record<SkillScope, boolean>,
  onTogglePin: ReturnType<typeof vi.fn>,
) {
  const rendered = render(tree(pinningReadyByScope, onTogglePin), { wrapper: TooltipProvider });
  return {
    ...rendered,
    rerenderTree: (next: Record<SkillScope, boolean>) => rendered.rerender(tree(next, onTogglePin)),
  };
}

describe('SkillsTree pin readiness', () => {
  afterEach(() => cleanup());

  test('real global and project rows use their own scope readiness and explain a pending pin', async () => {
    const user = userEvent.setup();
    const onTogglePin = vi.fn();
    contextMenuPath = 'GLOBAL/alpha';
    const globalTree = renderTree({ global: true, project: false }, onTogglePin);

    const globalItem = screen.getByRole('menuitem', { name: 'Pin to top' });
    expect(globalItem.getAttribute('data-disabled')).toBeNull();
    fireEvent.click(globalItem);
    expect(onTogglePin).toHaveBeenCalledWith('global', 'alpha', true);

    globalTree.unmount();
    onTogglePin.mockClear();
    contextMenuPath = 'PROJECT/beta';
    const projectTree = renderTree({ global: true, project: false }, onTogglePin);

    const pendingItem = screen.getByRole('menuitem', { name: 'Pin to top' });
    expect(pendingItem.getAttribute('data-disabled')).toBeNull();
    expect(pendingItem.getAttribute('aria-disabled')).toBe('true');
    const descriptionId = pendingItem.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? '')?.textContent).toBe(
      'Settings are still loading. Try again in a moment.',
    );
    const menu = screen.getByRole('menu');
    expect(document.activeElement).toBe(menu);
    await user.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('skills-menu-anchor')),
    );
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(document.activeElement).toBe(pendingItem));
    expect(
      await screen.findByRole('tooltip', {
        name: 'Settings are still loading. Try again in a moment.',
      }),
    ).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(onTogglePin).toHaveBeenCalledWith('project', 'beta', true);
    expect(document.activeElement).toBe(pendingItem);

    onTogglePin.mockClear();
    await user.keyboard(' ');
    expect(onTogglePin).toHaveBeenCalledWith('project', 'beta', true);
    expect(document.activeElement).toBe(pendingItem);

    onTogglePin.mockClear();
    projectTree.rerenderTree({ global: true, project: true });

    const readyItem = screen.getByRole('menuitem', { name: 'Pin to top' });
    expect(readyItem).toBe(pendingItem);
    expect(readyItem.getAttribute('data-disabled')).toBeNull();
    expect(readyItem.getAttribute('aria-disabled')).toBeNull();
    expect(document.activeElement).toBe(readyItem);
    fireEvent.click(readyItem);
    expect(onTogglePin).toHaveBeenCalledWith('project', 'beta', true);
  });
});
