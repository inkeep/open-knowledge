import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { dynamicActivate } from '@/lib/activate-locale';
import { i18n } from '@/lib/i18n';
import { activateUninstallLocale } from './locale';
import { UninstallResultScreen } from './UninstallResultScreen';

afterEach(async () => {
  cleanup();
  await dynamicActivate('en');
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
});

test('renders the verified checklist with the app removal step still pending', () => {
  render(
    <UninstallResultScreen
      outcome="success"
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      onRevealLog={vi.fn()}
    />,
  );
  expect(screen.getByRole('heading', { name: 'OpenKnowledge files were removed' })).toBeDefined();
  const items = screen.getAllByRole('listitem');
  expect(items.map((item) => item.textContent?.includes('Done.'))).toEqual([true, true, false]);
  expect(items[2]?.textContent).toContain('To do.');
});

test('activates the handed-off language and keeps failure separate from success', async () => {
  window.history.replaceState(null, '', '/?locale=es');
  await activateUninstallLocale();
  const props = { onConfirm: vi.fn(), onCancel: vi.fn(), onRevealLog: vi.fn() };
  const view = render(<UninstallResultScreen outcome="success" {...props} />);
  expect(i18n.locale).toBe('es');
  expect(document.documentElement.lang).toBe('es');
  view.rerender(<UninstallResultScreen outcome="failure" {...props} />);
  expect(screen.getByRole('heading', { name: 'Cleanup didn’t finish' })).toBeDefined();
  expect(screen.queryByRole('list')).toBeNull();
  expect(screen.queryByText('Reveal in Finder')).toBeNull();
});
