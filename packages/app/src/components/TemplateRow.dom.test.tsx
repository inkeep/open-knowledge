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
    expect(await screen.findByText('Delete')).toBeDefined();
    expect(document.body.style.pointerEvents).not.toBe('none');
  });
});
