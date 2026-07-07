/**
 * Regression test for the optimistic-install rollback in SkillEditorActions.
 * The install/uninstall handlers await the action result and drop the optimistic
 * host overlay on failure; without that, a failed write leaves the pill stuck on
 * the wrong Installed/Draft state for the rest of the session (the server keeps
 * reporting the old hosts, which never match the attempted overlay, so the
 * convergence effect never clears it). Here we fail an uninstall and assert the
 * pill reverts from the optimistic "Draft" back to server-truth "Installed".
 */

import { describe, expect, mock, test } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as linguiShim from '../../tests/lingui-macro-shim';

mock.module('@lingui/react/macro', () => linguiShim);

const installedEntry = {
  scope: 'project' as const,
  name: 'foo',
  path: 'foo',
  description: '',
  installed: true,
  hosts: ['claude'],
};

const uninstall = mock(async () => ({ ok: false as const, error: 'boom' }));
const install = mock(async () => ({ ok: false as const, error: 'boom' }));

mock.module('@/hooks/use-skills', () => ({
  useSkills: () => ({ status: 'ready', data: [installedEntry] }),
}));
mock.module('@/components/skill-actions', () => ({
  useSkillActions: () => ({
    installingName: null,
    install,
    uninstall,
    duplicate: async () => {},
    requestDelete: () => {},
    requestRename: () => {},
    dialogs: null,
  }),
}));

const { SkillEditorActions } = await import('./SkillEditorActions');

describe('SkillEditorActions — optimistic rollback', () => {
  test('reverts the pill to Installed when uninstall fails', async () => {
    const user = userEvent.setup();
    render(<SkillEditorActions scope="project" name="foo" />);

    const trigger = screen.getByTestId('skill-install-menu-trigger');
    expect(trigger.getAttribute('data-state')).toBe('installed');

    await user.click(trigger);
    await user.click(await screen.findByTestId('skill-uninstall'));

    await waitFor(() => expect(uninstall).toHaveBeenCalledTimes(1));
    // Rolled back to server truth — not stuck on the optimistic Draft overlay.
    await waitFor(() =>
      expect(screen.getByTestId('skill-install-menu-trigger').getAttribute('data-state')).toBe(
        'installed',
      ),
    );
  });
});
