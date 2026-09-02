import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { type TerminalTabDescriptor, TerminalTabStrip } from './TerminalTabStrip';

const SESSIONS: readonly TerminalTabDescriptor[] = [
  { id: 's1', label: 'Terminal 1' },
  { id: 's2', label: 'Terminal 2' },
  { id: 's3', label: 'Terminal 3' },
];

function stubNewButton(onClick: () => void) {
  return (
    <button type="button" aria-label="New session" onClick={onClick}>
      +
    </button>
  );
}

function renderStrip(props?: {
  sessions?: readonly TerminalTabDescriptor[];
  activeSessionId?: string;
  edge?: 'bottom' | 'right';
  sessionKind?: 'terminal' | 'agent';
  draggable?: boolean;
  renameDisabled?: boolean;
  withTrailing?: boolean;
  reserveRightRevealTabGutter?: boolean;
}) {
  const onSelect = vi.fn((_id: string) => {});
  const onTabActivate = vi.fn((_id: string) => {});
  const onNewButtonClick = vi.fn(() => {});
  const onClose = vi.fn((_id: string) => {});
  const onRename = vi.fn((_id: string, _label: string) => {});
  const onCollapse = vi.fn(() => {});
  const onPlacementChange = vi.fn((_placement: 'bottom' | 'right') => {});
  const view = render(
    <TooltipProvider>
      <TerminalTabStrip
        sessions={props?.sessions ?? SESSIONS}
        activeSessionId={props?.activeSessionId ?? 's1'}
        onSelect={onSelect}
        onTabActivate={onTabActivate}
        newButton={stubNewButton(onNewButtonClick)}
        trailingControls={
          props?.withTrailing ? (
            <button type="button" aria-label="Reopen a past chat">
              H
            </button>
          ) : undefined
        }
        onClose={onClose}
        onRename={props?.renameDisabled ? undefined : onRename}
        sessionKind={props?.sessionKind ?? (props?.edge === 'right' ? 'agent' : 'terminal')}
        edge={props?.draggable ? undefined : (props?.edge ?? 'bottom')}
        onPlacementChange={props?.draggable ? undefined : onPlacementChange}
        reserveRightRevealTabGutter={props?.reserveRightRevealTabGutter}
        onCollapse={props?.draggable ? undefined : onCollapse}
        draggable={props?.draggable}
      />
    </TooltipProvider>,
  );
  return {
    onSelect,
    onTabActivate,
    onNewButtonClick,
    onClose,
    onRename,
    onCollapse,
    onPlacementChange,
    rerender: view.rerender,
  };
}

describe('TerminalTabStrip', () => {
  afterEach(() => cleanup());

  test('renders one tab per session inside a labeled tablist', () => {
    renderStrip();
    const tablist = screen.getByRole('tablist', { name: 'Terminal sessions' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3']);
  });

  test('keeps accessible close controls outside the tablist ownership tree', () => {
    renderStrip();
    const tablist = screen.getByRole('tablist', { name: 'Terminal sessions' });

    expect(within(tablist).getAllByRole('tab')).toHaveLength(3);
    for (const label of ['Terminal 1', 'Terminal 2', 'Terminal 3']) {
      const closeButton = screen.getByRole('button', { name: `Close ${label}` });
      expect(tablist.contains(closeButton)).toBe(false);
    }
  });

  test('names the tablist for its own panel so two open panels are distinguishable', () => {
    renderStrip({ edge: 'right' });
    expect(screen.getByRole('tablist', { name: 'Agent chats' })).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: 'Terminal sessions' })).toBeNull();

    cleanup();
    renderStrip({ edge: 'bottom' });
    expect(screen.getByRole('tablist', { name: 'Terminal sessions' })).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: 'Agent chats' })).toBeNull();
  });

  test('keeps terminal identity when its panel occupies the right edge', () => {
    renderStrip({ edge: 'right', sessionKind: 'terminal' });

    expect(screen.getByRole('tablist', { name: 'Terminal sessions' })).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: 'Agent chats' })).toBeNull();
  });

  test('hovering a tab surfaces the full (untruncated) title in a tooltip', async () => {
    const user = userEvent.setup();
    const longTitle =
      'claude — refactor the terminal dock reveal affordance across every view kind';
    renderStrip({ sessions: [{ id: 's1', label: longTitle }], activeSessionId: 's1' });

    await user.hover(screen.getByRole('tab', { name: longTitle }));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain(longTitle);
  });

  test('marks the active session as selected and leaves others unselected', () => {
    renderStrip({ activeSessionId: 's2' });
    expect(screen.getByRole('tab', { name: 'Terminal 2' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Terminal 1' }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(screen.getByRole('tab', { name: 'Terminal 3' }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });

  test('scrolls the selected tab into view without changing tab order', () => {
    const scrolled: Element[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
      scrolled.push(this);
    };
    try {
      renderStrip({ activeSessionId: 's3' });
      expect(scrolled.some((element) => element.getAttribute('data-tab-id') === 's3')).toBe(true);
      expect(
        within(screen.getByRole('tablist', { name: 'Terminal sessions' }))
          .getAllByRole('tab')
          .map((tab) => tab.textContent),
      ).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3']);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  test('is fully controlled: clicking a tab reports onSelect without changing its own selection', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderStrip({ activeSessionId: 's1' });

    await user.click(screen.getByRole('tab', { name: 'Terminal 2' }));

    expect(onSelect).toHaveBeenCalledWith('s2');
    expect(screen.getByRole('tab', { name: 'Terminal 1' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Terminal 2' }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });

  test('reports onTabActivate with the session id on click, but not on arrow-key nav', async () => {
    const user = userEvent.setup();
    const { onTabActivate } = renderStrip({ activeSessionId: 's1' });

    await user.click(screen.getByRole('tab', { name: 'Terminal 2' }));
    expect(onTabActivate).toHaveBeenCalledWith('s2');

    onTabActivate.mockClear();
    act(() => screen.getByRole('tab', { name: 'Terminal 2' }).focus());
    await user.keyboard('{ArrowRight}');
    expect(onTabActivate).not.toHaveBeenCalled();
  });

  test('arrow-key navigation reports the next session via onSelect', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderStrip({ activeSessionId: 's1' });
    const first = screen.getByRole('tab', { name: 'Terminal 1' });

    act(() => {
      first.focus();
    });
    expect(document.activeElement).toBe(first);
    await user.keyboard('{ArrowRight}');

    expect(onSelect).toHaveBeenCalledWith('s2');
  });

  test('renders the host-provided New button and forwards its clicks unchanged', async () => {
    const user = userEvent.setup();
    const { onNewButtonClick, onSelect } = renderStrip();

    await user.click(screen.getByRole('button', { name: 'New session' }));

    expect(onNewButtonClick).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('the New button hugs the last tab, preceding the trailing collapse control', () => {
    renderStrip();
    const newButton = screen.getByRole('button', { name: 'New session' });
    const collapse = screen.getByRole('button', { name: 'Collapse Terminal' });
    expect(
      newButton.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('trailing controls render at the far right, immediately left of the collapse control', () => {
    renderStrip({ withTrailing: true });
    const trailing = screen.getByRole('button', { name: 'Reopen a past chat' });
    const newButton = screen.getByRole('button', { name: 'New session' });
    const collapse = screen.getByRole('button', { name: 'Collapse Terminal' });
    expect(
      newButton.compareDocumentPosition(trailing) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      trailing.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('a tab close control reports onClose with that session id only', async () => {
    const user = userEvent.setup();
    const { onClose, onSelect, onNewButtonClick } = renderStrip({ activeSessionId: 's1' });

    await user.click(screen.getByRole('button', { name: 'Close Terminal 2' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('s2');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onNewButtonClick).not.toHaveBeenCalled();
  });

  test('the bottom Terminal context menu contains one placement action that moves it right', async () => {
    const user = userEvent.setup();
    const { onPlacementChange } = renderStrip({ edge: 'bottom', sessionKind: 'terminal' });

    fireEvent.contextMenu(screen.getByRole('tablist', { name: 'Terminal sessions' }));

    const menu = await screen.findByRole('menu');
    const placementAction = within(menu).getByRole('menuitem', {
      name: 'Move to right panel',
    });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);

    await user.click(placementAction);

    expect(onPlacementChange).toHaveBeenCalledWith('right');
  });

  test('Shift+F10 opens the placement menu from a focused Terminal tab and preserves operable focus', async () => {
    const user = userEvent.setup();
    const { onPlacementChange } = renderStrip({ edge: 'bottom', sessionKind: 'terminal' });
    const focusedTab = screen.getByRole('tab', { name: 'Terminal 1' });
    act(() => focusedTab.focus());

    fireEvent.keyDown(focusedTab, { key: 'F10', shiftKey: true });

    const placementAction = await screen.findByRole('menuitem', {
      name: 'Move to right panel',
    });
    expect(placementAction).toBe(document.activeElement);

    await user.keyboard('{Enter}');

    expect(onPlacementChange).toHaveBeenCalledWith('right');
    expect(focusedTab).toBe(document.activeElement);
  });

  test('the platform context-menu key opens placement and Escape restores the focused Terminal tab', async () => {
    const user = userEvent.setup();
    const { onPlacementChange } = renderStrip({ edge: 'bottom', sessionKind: 'terminal' });
    const focusedTab = screen.getByRole('tab', { name: 'Terminal 2' });
    act(() => focusedTab.focus());

    fireEvent.keyDown(focusedTab, { key: 'ContextMenu' });

    expect(await screen.findByRole('menuitem', { name: 'Move to right panel' })).toBe(
      document.activeElement,
    );

    await user.keyboard('{Escape}');

    expect(onPlacementChange).not.toHaveBeenCalled();
    expect(focusedTab).toBe(document.activeElement);
  });

  test('the right Terminal header has a named 24px dock control that moves it bottom', async () => {
    const user = userEvent.setup();
    const { onPlacementChange } = renderStrip({ edge: 'right', sessionKind: 'terminal' });
    const dockButton = screen.getByRole('button', { name: 'Move Terminal to bottom' });

    expect(dockButton.getAttribute('data-size')).toBe('icon-xs');
    expect(dockButton.className).toContain('focus-visible:ring-3');

    await user.click(dockButton);

    expect(onPlacementChange).toHaveBeenCalledWith('bottom');
  });

  test('the bottom Terminal header has a named 24px dock control that moves it right', async () => {
    const user = userEvent.setup();
    const { onPlacementChange } = renderStrip({ edge: 'bottom', sessionKind: 'terminal' });
    const dockButton = screen.getByRole('button', { name: 'Move Terminal to right' });

    expect(dockButton.getAttribute('data-size')).toBe('icon-xs');
    expect(dockButton.className).toContain('focus-visible:ring-3');

    await user.click(dockButton);

    expect(onPlacementChange).toHaveBeenCalledWith('right');
  });

  test('the right Terminal header clears the collapsed agents reveal control', () => {
    renderStrip({
      edge: 'right',
      sessionKind: 'terminal',
      reserveRightRevealTabGutter: true,
    });

    expect(document.querySelector('[data-terminal-tab-row]')?.className).toContain('pr-9');
  });

  test('the agent strip keeps independent names and controls without Terminal placement actions', () => {
    renderStrip({ edge: 'right', sessionKind: 'agent' });

    expect(screen.getByRole('tablist', { name: 'Agent chats' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Collapse agent panel' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Move Terminal/ })).toBeNull();

    fireEvent.contextMenu(screen.getByRole('tablist', { name: 'Agent chats' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('the collapse control reports onCollapse and never onClose / new-button', async () => {
    const user = userEvent.setup();
    const { onCollapse, onClose, onNewButtonClick } = renderStrip();

    await user.click(screen.getByRole('button', { name: 'Collapse Terminal' }));

    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onNewButtonClick).not.toHaveBeenCalled();
  });

  test('no drag-to-dock grip is rendered (dragging was removed)', () => {
    renderStrip();
    expect(screen.queryByRole('button', { name: 'Drag to dock the terminal' })).toBeNull();
  });

  test('every strip-owned icon-only control exposes an accessible name', () => {
    renderStrip();
    expect(screen.getByRole('button', { name: 'Collapse Terminal' })).toBeDefined();
    for (const label of ['Terminal 1', 'Terminal 2', 'Terminal 3']) {
      expect(screen.getByRole('button', { name: `Close ${label}` })).toBeDefined();
    }
  });

  test('window mode marks the bar as the draggable macOS title region; dock mode does not', () => {
    renderStrip({ draggable: true });
    expect(document.querySelector('[data-electron-drag]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Collapse Terminal' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New session' })).toBeDefined();
    cleanup();
    renderStrip();
    expect(document.querySelector('[data-electron-drag]')).toBeNull();
  });

  test('window mode keeps the tab controls interactive (no-drag opt-out works)', async () => {
    const user = userEvent.setup();
    const { onNewButtonClick, onClose } = renderStrip({ activeSessionId: 's1', draggable: true });

    await user.click(screen.getByRole('button', { name: 'New session' }));
    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));

    expect(onNewButtonClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('s1');
  });

  test('double-clicking a tab opens an inline rename input, prefilled and focused', async () => {
    const user = userEvent.setup();
    renderStrip({ activeSessionId: 's2' });

    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 2' }));

    const input = screen.getByRole('textbox', { name: 'Rename Terminal 2' });
    expect(input).toBe(document.activeElement);
    expect((input as HTMLInputElement).value).toBe('Terminal 2');
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeDefined();
    expect(input.closest('[role="tab"]')).toBeNull();
    expect(screen.getByRole('tablist', { name: 'Terminal sessions' }).contains(input)).toBe(false);
  });

  test('double-click that opens rename fires onTabActivate at most once (second click suppressed)', async () => {
    const user = userEvent.setup();
    const { onTabActivate } = renderStrip({ activeSessionId: 's1' });

    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 2' }));

    expect(onTabActivate).toHaveBeenCalledTimes(1);
    expect(onTabActivate).toHaveBeenCalledWith('s2');
    expect(screen.getByRole('textbox', { name: 'Rename Terminal 2' })).toBe(document.activeElement);
  });

  test('F2 on a focused tab trigger opens the rename input (keyboard entry)', async () => {
    const user = userEvent.setup();
    renderStrip({ activeSessionId: 's1' });
    const tab = screen.getByRole('tab', { name: 'Terminal 1' });
    act(() => tab.focus());

    await user.keyboard('{F2}');

    expect(screen.getByRole('textbox', { name: 'Rename Terminal 1' })).toBe(document.activeElement);
  });

  test('Enter commits the trimmed new name via onRename and exits rename mode', async () => {
    const user = userEvent.setup();
    const { onRename } = renderStrip({ activeSessionId: 's2' });

    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 2' }));
    const input = screen.getByRole('textbox', { name: 'Rename Terminal 2' });
    await user.clear(input);
    await user.type(input, '  build  ');
    await user.keyboard('{Enter}');

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith('s2', 'build');
    expect(screen.queryByRole('textbox', { name: /Rename/ })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toBeDefined();
  });

  test('blurring the rename input commits the value', async () => {
    const user = userEvent.setup();
    const { onRename } = renderStrip({ activeSessionId: 's2' });

    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 2' }));
    const input = screen.getByRole('textbox', { name: 'Rename Terminal 2' });
    await user.clear(input);
    await user.type(input, 'logs');
    act(() => (input as HTMLInputElement).blur());

    expect(onRename).toHaveBeenCalledWith('s2', 'logs');
  });

  test('Escape cancels without committing and restores the tab trigger', async () => {
    const user = userEvent.setup();
    const { onRename } = renderStrip({ activeSessionId: 's2' });

    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 2' }));
    const input = screen.getByRole('textbox', { name: 'Rename Terminal 2' });
    await user.clear(input);
    await user.type(input, 'discard-me');
    await user.keyboard('{Escape}');

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: /Rename/ })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toBeDefined();
  });

  test('an empty commit clears the custom label (onRename with empty string)', async () => {
    const user = userEvent.setup();
    const { onRename } = renderStrip({
      activeSessionId: 's2',
      sessions: [{ id: 's2', label: 'my build' }],
    });

    await user.dblClick(screen.getByRole('tab', { name: 'my build' }));
    const input = screen.getByRole('textbox', { name: 'Rename my build' });
    await user.clear(input);
    await user.keyboard('{Enter}');

    expect(onRename).toHaveBeenCalledWith('s2', '');
  });

  test('a whitespace-only commit trims to empty and clears the custom label', async () => {
    const user = userEvent.setup();
    const { onRename } = renderStrip({
      activeSessionId: 's2',
      sessions: [{ id: 's2', label: 'my build' }],
    });

    await user.dblClick(screen.getByRole('tab', { name: 'my build' }));
    const input = screen.getByRole('textbox', { name: 'Rename my build' });
    await user.clear(input);
    await user.type(input, '   ');
    await user.keyboard('{Enter}');

    expect(onRename).toHaveBeenCalledWith('s2', '');
  });

  test('a tab that disappears mid-rename auto-cancels the input', async () => {
    const user = userEvent.setup();
    const { rerender } = renderStrip({ activeSessionId: 's3' });

    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 3' }));
    expect(screen.getByRole('textbox', { name: 'Rename Terminal 3' })).toBeDefined();

    rerender(
      <TooltipProvider>
        <TerminalTabStrip
          sessions={[
            { id: 's1', label: 'Terminal 1' },
            { id: 's2', label: 'Terminal 2' },
          ]}
          sessionKind="terminal"
          activeSessionId="s1"
          onSelect={() => {}}
          newButton={stubNewButton(() => {})}
          onClose={() => {}}
          onRename={() => {}}
          edge="bottom"
          onCollapse={() => {}}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByRole('textbox', { name: /Rename/ })).toBeNull();
  });

  test('without an onRename handler the rename affordance is inert', async () => {
    const user = userEvent.setup();
    renderStrip({ activeSessionId: 's2', renameDisabled: true });

    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 2' }));

    expect(screen.queryByRole('textbox', { name: /Rename/ })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toBeDefined();
  });

  test('every tab is wrapped in a sortable node without disturbing the tablist', () => {
    renderStrip();
    expect(document.querySelectorAll('[data-terminal-tab-sortable]')).toHaveLength(3);
    const tablist = screen.getByRole('tablist', { name: 'Terminal sessions' });
    expect(within(tablist).getAllByRole('tab')).toHaveLength(3);
    expect(within(tablist).queryAllByRole('button', { name: /^Terminal/ })).toHaveLength(0);
  });
});
