import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RecentItemContextMenu, RecentRemoveButton } from './recent-remove-controls';

afterEach(cleanup);

describe('RecentRemoveButton', () => {
  test('clicking the × removes exactly that path', () => {
    const onRemoveRecent = vi.fn((_path: string) => {});
    render(
      <RecentRemoveButton
        path="/projects/one"
        name="One"
        onRemoveRecent={onRemoveRecent}
        testIdPrefix="project-switcher-recent"
      />,
    );
    const button = screen.getByTestId('project-switcher-recent-remove-/projects/one');
    // Mouse-only affordance: kept out of the menu's tab order (keyboard users
    // remove via the context menu). See recent-remove-controls.tsx.
    expect(button.getAttribute('tabindex')).toBe('-1');
    expect(button.getAttribute('aria-label')).toBe('Remove One from recent projects');
    fireEvent.click(button);
    expect(onRemoveRecent).toHaveBeenCalledWith('/projects/one');
  });
});

describe('RecentItemContextMenu', () => {
  test('right-click surfaces a Remove item that removes that path', () => {
    const onRemoveRecent = vi.fn((_path: string) => {});
    render(
      <RecentItemContextMenu
        path="/projects/two"
        onRemoveRecent={onRemoveRecent}
        testIdPrefix="command-palette-recent"
      >
        <div data-testid="recent-row">Two</div>
      </RecentItemContextMenu>,
    );
    // No context content until the row is right-clicked.
    expect(screen.queryByTestId('command-palette-recent-context-remove-/projects/two')).toBeNull();

    fireEvent.contextMenu(screen.getByTestId('recent-row'));
    const item = screen.getByTestId('command-palette-recent-context-remove-/projects/two');
    fireEvent.click(item);
    expect(onRemoveRecent).toHaveBeenCalledWith('/projects/two');
  });
});
