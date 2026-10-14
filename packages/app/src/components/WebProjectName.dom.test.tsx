import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

let workspace: { contentDir: string; pathSeparator: '/' | '\\' } | null = null;

vi.mock('@/lib/use-workspace', () => ({ useWorkspace: () => workspace }));

vi.mock('@lingui/react/macro', () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

const { WebProjectName } = await import('./WebProjectName');

afterEach(() => {
  cleanup();
  workspace = null;
});

describe('WebProjectName', () => {
  test.each([
    { shape: 'a posix path', contentDir: '/Users/sarah/notes/field-notes', name: 'field-notes' },
    {
      shape: 'a windows path',
      contentDir: 'C:\\Users\\ok\\Documents\\header-check',
      name: 'header-check',
    },
    {
      shape: 'a trailing separator',
      contentDir: '/Users/sarah/notes/field-notes/',
      name: 'field-notes',
    },
  ])('names the project from $shape', ({ contentDir, name }) => {
    workspace = { contentDir, pathSeparator: '/' };
    render(<WebProjectName />, { wrapper: TooltipProvider });

    expect(screen.getByTestId('web-project-name-label').textContent).toBe(name);
  });

  test('says what the name is for', () => {
    workspace = { contentDir: '/Users/sarah/notes/field-notes', pathSeparator: '/' };
    render(<WebProjectName />, { wrapper: TooltipProvider });

    expect(screen.getByTestId('web-project-name').textContent).toContain('Project');
  });

  test('a keyboard user can reach the full content directory a truncated name otherwise loses', async () => {
    workspace = { contentDir: '/Users/sarah/notes/field-notes', pathSeparator: '/' };
    render(<WebProjectName />, { wrapper: TooltipProvider });

    const label = screen.getByTestId('web-project-name');
    expect(label.getAttribute('tabindex')).toBe('0');

    await userEvent.tab();
    expect(document.activeElement).toBe(label);
    await waitFor(() =>
      expect(screen.getAllByText('/Users/sarah/notes/field-notes').length).toBeGreaterThan(0),
    );
  });

  test('renders nothing until the workspace is known', () => {
    workspace = null;
    render(<WebProjectName />, { wrapper: TooltipProvider });

    expect(screen.queryByTestId('web-project-name')).toBeNull();
  });

  test('renders nothing for a filesystem root, which yields no name', () => {
    workspace = { contentDir: '/', pathSeparator: '/' };
    render(<WebProjectName />, { wrapper: TooltipProvider });

    expect(screen.queryByTestId('web-project-name')).toBeNull();
  });
});
