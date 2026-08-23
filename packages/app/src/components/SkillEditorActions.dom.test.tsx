/**
 * Regression test for the optimistic-install rollback in SkillEditorActions.
 * The install/uninstall handlers await the action result and drop the optimistic
 * host overlay on failure; without that, a failed write leaves the pill stuck on
 * the wrong Installed/Draft state for the rest of the session (the server keeps
 * reporting the old hosts, which never match the attempted overlay, so the
 * convergence effect never clears it). Here we fail the set-exact install fired
 * by unchecking the last editor row (the uninstall path since the dedicated
 * "Uninstall everywhere" item was removed) and assert the pill reverts from the
 * optimistic "Draft" back to server-truth "Installed".
 */

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
    // Uncheck the only installed editor — set-exact to [] is the uninstall path.
    await user.click(await screen.findByTestId('skill-install-editor-claude'));

    // The commit is debounced (~350ms) before the install call fires and fails.
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1), { timeout: 3000 });
    // Rolled back to server truth — not stuck on the optimistic Draft overlay.
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

    // Routes through the same action the sidebar uses (opens SkillFileCreateDialog
    // — full bundle-path field, so references/ + nested subfolders are reachable),
    // targeting the resolved skill entry.
    expect(requestFileCreate).toHaveBeenCalledTimes(1);
    expect(requestFileCreate.mock.calls[0][0]).toMatchObject({ scope: 'project', name: 'foo' });
  });
});

describe('SkillEditorActions — stale-scope self-heal', () => {
  test('a wrong-scope surface resolves by unique name instead of Checking forever', async () => {
    // A tab identity can carry a stale scope: a built-in previewed at the wrong
    // level during the global-strays era hung its pill on "Checking" for good —
    // (project, name) never resolves when the skill only exists at global. One
    // skill with this name is unambiguous, so the pill adopts it.
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
    // Two same-named skills at different scopes: ambiguous, so no self-heal —
    // guessing would put the install controls on the wrong one.
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
