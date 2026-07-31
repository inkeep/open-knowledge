import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

// The toggle's only collaborator is DocumentContext's `setSkillsSidebar`; mock it
// so the tests assert the surface-flip behavior without the real provider graph.
const setSkillsSidebar = vi.fn();
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ setSkillsSidebar }),
}));

async function renderToggle(active: 'files' | 'skills') {
  const { FilesSkillsToggle } = await import('./FilesSkillsToggle');
  // Segments wrap their items in Radix Tooltip, which needs a provider ancestor.
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  render(
    <TooltipProvider>
      <FilesSkillsToggle active={active} />
    </TooltipProvider>,
  );
}

describe('FilesSkillsToggle', () => {
  afterEach(() => {
    cleanup();
    setSkillsSidebar.mockReset();
  });

  test('renders both segments', async () => {
    await renderToggle('files');
    expect(screen.getByTestId('sidebar-files-toggle')).toBeTruthy();
    expect(screen.getByTestId('sidebar-skills-toggle')).toBeTruthy();
  });

  test('selecting Skills flips the sidebar surface on', async () => {
    await renderToggle('files');
    fireEvent.click(screen.getByTestId('sidebar-skills-toggle'));
    expect(setSkillsSidebar).toHaveBeenCalledWith(true);
  });

  test('selecting Files flips the sidebar surface off', async () => {
    await renderToggle('skills');
    fireEvent.click(screen.getByTestId('sidebar-files-toggle'));
    expect(setSkillsSidebar).toHaveBeenCalledWith(false);
  });

  test('re-clicking the active segment is ignored (Radix empty-value deselect guard)', async () => {
    await renderToggle('files');
    // Radix single-select clears the value when you click the active item; the
    // handler must swallow that empty case so one surface stays selected.
    fireEvent.click(screen.getByTestId('sidebar-files-toggle'));
    expect(setSkillsSidebar).not.toHaveBeenCalled();
  });

  test('collapsed segment pins an accessible name; selected relies on its visible label', async () => {
    await renderToggle('files');
    // Skills is collapsed (icon-only) → explicit aria-label carries the name.
    expect(screen.getByTestId('sidebar-skills-toggle').getAttribute('aria-label')).toBe('Skills');
    // Files is selected → no override, the visible label is the accessible name.
    expect(screen.getByTestId('sidebar-files-toggle').getAttribute('aria-label')).toBeNull();
  });
});
