/**
 * Regression: deleting a template left the whole app unclickable until reload.
 * The row's actions menu opened a modal confirmation Dialog; a
 * modal DropdownMenu stacked a second `document.body { pointer-events: none }`
 * lock, and the post-delete refresh unmounted the still-open dialog before
 * Radix could unwind it, stranding the lock. The menu is now `modal={false}`
 * (matching FileTree / ProjectSwitcher), so opening it must not lock the body.
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { TemplateMenuEntry } from '@/hooks/use-folder-config';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const TEMPLATE: TemplateMenuEntry = {
  name: 'note',
  title: 'Note',
  path: 'templates/note.md',
  source_folder: '',
  scope: 'local',
};

describe('TemplateRow actions menu', () => {
  afterEach(cleanup);

  test('opening the menu does not lock document.body pointer-events', async () => {
    const { TemplateRow } = await import('./TemplateRow');
    render(<TemplateRow template={TEMPLATE} onEdit={() => {}} onDelete={() => {}} />);

    expect(document.body.style.pointerEvents).not.toBe('none');

    await userEvent.click(screen.getByRole('button', { name: /Actions for/ }));
    // Menu is open (Delete item rendered) — a modal menu would have set the body
    // lock by now; a non-modal one leaves the page clickable.
    expect(await screen.findByText('Delete')).toBeDefined();
    expect(document.body.style.pointerEvents).not.toBe('none');
  });
});
