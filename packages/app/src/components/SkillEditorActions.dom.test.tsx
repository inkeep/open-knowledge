import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import * as linguiShim from '../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => linguiShim);

const installedEntry = {
  scope: 'project' as const,
  name: 'foo',
  path: 'foo',
  description: '',
  installed: true,
  hosts: ['claude'],
};

const uninstall = vi.fn(async () => ({ ok: false as const, error: 'boom' }));
const install = vi.fn(async () => ({ ok: false as const, error: 'boom' }));
const requestFileCreate = vi.fn();

let skillsData: unknown[] = [installedEntry];
vi.doMock('@/hooks/use-skills', () => ({
  useSkills: () => ({ status: 'ready', data: skillsData }),
}));
vi.doMock('@/components/skill-actions', () => ({
  useSkillActions: () => ({
    installingName: null,
    install,
    uninstall,
    duplicate: async () => {},
    requestDelete: () => {},
    requestRename: () => {},
    requestFileCreate,
    dialogs: null,
  }),
}));

const { SkillEditorActions } = await import('./SkillEditorActions');

describe('SkillEditorActions — optimistic rollback', () => {
  test('reverts the pill to Installed when the uncheck-everything install fails', async () => {
    const user = userEvent.setup();
    render(<SkillEditorActions scope="project" name="foo" />, { wrapper: TooltipProvider });

    const trigger = screen.getByTestId('skill-install-menu-trigger');
    expect(trigger.getAttribute('data-state')).toBe('installed');

    await user.click(trigger);
    await user.click(await screen.findByTestId('skill-install-editor-claude'));

    await waitFor(() => expect(install).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await waitFor(() =>
      expect(screen.getByTestId('skill-install-menu-trigger').getAttribute('data-state')).toBe(
        'installed',
      ),
    );
  });
});

describe('SkillEditorActions — new-file affordance (PRD-7429)', () => {
  test('the toolbar exposes a New file button that opens create-file for this skill', async () => {
    const user = userEvent.setup();
    requestFileCreate.mockClear();
    render(<SkillEditorActions scope="project" name="foo" />, { wrapper: TooltipProvider });

    const button = screen.getByTestId('skill-editor-new-file');
    expect(button.getAttribute('aria-label')).toMatch(/new file/i);
    await user.click(button);

    expect(requestFileCreate).toHaveBeenCalledTimes(1);
    expect(requestFileCreate.mock.calls[0][0]).toMatchObject({ scope: 'project', name: 'foo' });
  });
});

describe('SkillEditorActions — stale-scope self-heal', () => {
  test('a wrong-scope surface resolves by unique name instead of Checking forever', async () => {
    skillsData = [{ ...installedEntry, scope: 'global' }];
    render(
      <TooltipProvider>
        <SkillEditorActions scope="project" name="foo" />
      </TooltipProvider>,
    );

    expect(screen.queryByText('Checking')).toBeNull();
    expect(await screen.findByText('Installed')).toBeTruthy();
    skillsData = [installedEntry];
  });

  test('a genuinely unresolved skill still reads as Checking, not Not installed', async () => {
    skillsData = [
      { ...installedEntry, scope: 'global', name: 'dupe' },
      { ...installedEntry, name: 'dupe', installed: false, hosts: [] },
    ];
    render(
      <TooltipProvider>
        <SkillEditorActions scope="user-weird" name="dupe" />
      </TooltipProvider>,
    );
    expect(await screen.findByText('Checking')).toBeTruthy();
    skillsData = [installedEntry];
  });
});
