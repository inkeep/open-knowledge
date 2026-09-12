import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

const skill: SkillsListEntry = {
  name: 'alpha',
  scope: 'global',
  path: '/tmp/alpha',
  installed: true,
  hosts: [],
};

const userPatch = vi.fn((_patch: unknown) => ({ ok: true as const }));
const toastInfo = vi.fn((_message: string, _options?: { id?: string }) => {});
const closeContextMenu = vi.fn((_options: { restoreFocus: boolean }) => {});

const model = {
  focusPath: () => {},
  getItem: () => undefined,
  getSelectedPaths: () => [],
  subscribe: () => () => {},
};

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
  }) => <div>{renderContextMenu({ path: 'GLOBAL/alpha' }, { close: closeContextMenu })}</div>,
}));

vi.doMock('@/components/skill-actions', () => ({
  useSkillActions: () => ({}),
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

vi.doMock('@/hooks/use-skills', () => ({
  useSkills: () => ({ status: 'ready', data: [skill] }),
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    openTarget: () => {},
    activeDocName: null,
    activeTarget: null,
    openTabs: [],
    activateTab: () => {},
  }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    merged: null,
    userBinding: { patch: userPatch },
    userSynced: false,
    projectLocalBinding: { patch: vi.fn(() => ({ ok: true as const })) },
    projectLocalSynced: true,
  }),
}));

vi.doMock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: toastInfo,
    success: vi.fn(),
  },
}));

vi.doMock('@/hooks/use-create-blank-skill', () => ({
  useCreateBlankSkill: () => ({ createBlank: () => {}, creating: false }),
}));

vi.doMock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => () => {} }));
vi.doMock('@/hooks/use-open-skill-for-edit', () => ({
  useOpenSkillForEdit: () => () => Promise.resolve({ ok: true }),
}));

vi.doMock('@/lib/skill-scope', () => ({
  SKILL_SCOPE_ORDER: ['global', 'project'],
  skillDir: () => '',
  skillDisplayName: (name: string) => name,
  skillNameSetsByScope: () => ({ global: new Set(['alpha']), project: new Set() }),
  useSkillScopeDescriptions: () => ({ global: 'Global', project: 'Project' }),
  useSkillScopeLabels: () => ({ global: 'GLOBAL', project: 'PROJECT' }),
}));

vi.doMock('@/lib/skills-api', () => ({
  fetchSkillPreview: () => Promise.resolve({ ok: true, files: [] }),
  listDetectedSkills: () => Promise.resolve({ ok: true, skills: [] }),
}));

const { SkillsSidebarSection } = await import('./SkillsSidebarSection');

describe('SkillsSidebarSection pending pin keyboard behavior', () => {
  beforeEach(() => {
    userPatch.mockClear();
    toastInfo.mockClear();
    closeContextMenu.mockClear();
  });

  afterEach(() => cleanup());

  test('real Radix Enter and Space reach the pending guard without writing', async () => {
    const user = userEvent.setup();
    render(<SkillsSidebarSection dockExpanded />, { wrapper: TooltipProvider });

    const menu = await screen.findByRole('menu');
    const pin = await screen.findByRole('menuitem', { name: 'Pin to top' });
    expect(pin.getAttribute('aria-disabled')).toBe('true');

    menu.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await waitFor(() => expect(document.activeElement).toBe(pin));

    await user.keyboard('{Enter}');
    expect(userPatch).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenNthCalledWith(
      1,
      'Settings are still loading. Try again in a moment.',
      { id: 'pin-not-ready-global' },
    );
    expect(closeContextMenu).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pin);

    await user.keyboard(' ');
    expect(userPatch).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenNthCalledWith(
      2,
      'Settings are still loading. Try again in a moment.',
      { id: 'pin-not-ready-global' },
    );
    expect(closeContextMenu).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pin);
  });
});
