import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { type TerminalTabDescriptor, TerminalTabStrip } from './TerminalTabStrip';

const SESSIONS: readonly TerminalTabDescriptor[] = [
  { id: 's1', label: 'Terminal 1' },
  { id: 's2', label: 'Terminal 2' },
  { id: 's3', label: 'Terminal 3' },
];

function renderStrip(props?: {
  sessions?: readonly TerminalTabDescriptor[];
  activeSessionId?: string;
  dockPosition?: 'bottom' | 'right';
  newChatSelected?: 'claude' | 'codex' | 'opencode' | 'cursor' | 'terminal';
  draggable?: boolean;
}) {
  const onSelect = mock((_id: string) => {});
  const onTabActivate = mock((_id: string) => {});
  const onNewChatLaunch = mock(() => {});
  const onNewChatPickCli = mock((_cli: string) => {});
  const onNewChatPickTerminal = mock(() => {});
  const onClose = mock((_id: string) => {});
  const onToggleDock = mock(() => {});
  const onCollapse = mock(() => {});
  render(
    // The app mounts a root TooltipProvider (main.tsx); the strip's control
    // tooltips need that context, so the isolated render supplies its own.
    // `draggable` mirrors the standalone terminal window's prop shape (same
    // new-chat model, no dock/collapse controls); the default mirrors the dock.
    <TooltipProvider>
      <TerminalTabStrip
        sessions={props?.sessions ?? SESSIONS}
        activeSessionId={props?.activeSessionId ?? 's1'}
        onSelect={onSelect}
        onTabActivate={onTabActivate}
        newChatSelected={props?.newChatSelected ?? 'claude'}
        onNewChatLaunch={onNewChatLaunch}
        onNewChatPickCli={onNewChatPickCli}
        onNewChatPickTerminal={onNewChatPickTerminal}
        onClose={onClose}
        dockPosition={props?.draggable ? undefined : (props?.dockPosition ?? 'bottom')}
        onToggleDock={props?.draggable ? undefined : onToggleDock}
        onCollapse={props?.draggable ? undefined : onCollapse}
        draggable={props?.draggable}
      />
    </TooltipProvider>,
  );
  return {
    onSelect,
    onTabActivate,
    onNewChatLaunch,
    onNewChatPickCli,
    onNewChatPickTerminal,
    onClose,
    onToggleDock,
    onCollapse,
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

  test('hovering a tab surfaces the full (untruncated) title in a tooltip', async () => {
    const user = userEvent.setup();
    // A process-set OSC title long enough to hard-clip at the tab's max width;
    // the tooltip must carry the whole thing so a hover reveals what was cut.
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

  test('is fully controlled: clicking a tab reports onSelect without changing its own selection', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderStrip({ activeSessionId: 's1' });

    await user.click(screen.getByRole('tab', { name: 'Terminal 2' }));

    expect(onSelect).toHaveBeenCalledWith('s2');
    // No prop change happened, so the strip must still show the original active
    // tab — the component owns no selection state of its own.
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

    // Pointer/Enter activation routes through onTabActivate so the consumer can
    // move focus into the terminal on a deliberate select.
    await user.click(screen.getByRole('tab', { name: 'Terminal 2' }));
    expect(onTabActivate).toHaveBeenCalledWith('s2');

    // Arrow-key navigation must NOT fire onTabActivate — it would steal focus
    // out of the tablist while the user is arrowing across tabs.
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

  test('the New-chat primary launches the current selection and never onSelect', async () => {
    const user = userEvent.setup();
    const { onNewChatLaunch, onNewChatPickTerminal, onSelect } = renderStrip();

    await user.click(screen.getByRole('button', { name: 'New Claude chat' }));

    expect(onNewChatLaunch).toHaveBeenCalledTimes(1);
    expect(onNewChatPickTerminal).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('the primary reflects a Terminal selection (opens a bare terminal)', async () => {
    const user = userEvent.setup();
    const { onNewChatLaunch } = renderStrip({ newChatSelected: 'terminal' });

    await user.click(screen.getByRole('button', { name: 'New terminal' }));

    expect(onNewChatLaunch).toHaveBeenCalledTimes(1);
  });

  test('the New-chat dropdown picks a bare terminal via its "Terminal" option', async () => {
    const user = userEvent.setup();
    const { onNewChatPickTerminal, onNewChatLaunch } = renderStrip();

    await user.click(screen.getByRole('button', { name: 'Choose CLI for new chat' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Terminal' }));

    expect(onNewChatPickTerminal).toHaveBeenCalledTimes(1);
    expect(onNewChatLaunch).not.toHaveBeenCalled();
  });

  test('New chat hugs the last tab, preceding the trailing dock-toggle / collapse controls', () => {
    renderStrip();
    const newChat = screen.getByRole('button', { name: 'New Claude chat' });
    const dockToggle = screen.getByRole('button', { name: 'Dock terminal to the right' });
    const collapse = screen.getByRole('button', { name: 'Collapse terminal' });
    // New chat sits immediately right of the tablist; the spacer pushes the
    // trailing group (dock-toggle … collapse) to the far right.
    expect(
      newChat.compareDocumentPosition(dockToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      dockToggle.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('a tab close control reports onClose with that session id only', async () => {
    const user = userEvent.setup();
    const { onClose, onSelect, onNewChatLaunch } = renderStrip({ activeSessionId: 's1' });

    await user.click(screen.getByRole('button', { name: 'Close Terminal 2' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('s2');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onNewChatLaunch).not.toHaveBeenCalled();
  });

  test('the dock-toggle reports onToggleDock and labels the resulting position', async () => {
    const user = userEvent.setup();
    // Bottom-docked → the toggle moves it to the right.
    const bottom = renderStrip({ dockPosition: 'bottom' });
    const toRight = screen.getByRole('button', { name: 'Dock terminal to the right' });
    await user.click(toRight);
    expect(bottom.onToggleDock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Dock terminal to the bottom' })).toBeNull();
    cleanup();

    // Right-docked → the toggle moves it to the bottom (label flips).
    const right = renderStrip({ dockPosition: 'right' });
    const toBottom = screen.getByRole('button', { name: 'Dock terminal to the bottom' });
    await user.click(toBottom);
    expect(right.onToggleDock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Dock terminal to the right' })).toBeNull();
  });

  test('the collapse control reports onCollapse and never onClose / new-chat', async () => {
    const user = userEvent.setup();
    const { onCollapse, onClose, onNewChatLaunch, onNewChatPickTerminal } = renderStrip();

    await user.click(screen.getByRole('button', { name: 'Collapse terminal' }));

    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onNewChatLaunch).not.toHaveBeenCalled();
    expect(onNewChatPickTerminal).not.toHaveBeenCalled();
  });

  test('no drag-to-dock grip is rendered (dragging was removed)', () => {
    renderStrip();
    expect(screen.queryByRole('button', { name: 'Drag to dock the terminal' })).toBeNull();
  });

  test('every icon-only control exposes an accessible name', () => {
    renderStrip();
    expect(screen.getByRole('button', { name: 'New Claude chat' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Choose CLI for new chat' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Dock terminal to the right' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Collapse terminal' })).toBeDefined();
    for (const label of ['Terminal 1', 'Terminal 2', 'Terminal 3']) {
      expect(screen.getByRole('button', { name: `Close ${label}` })).toBeDefined();
    }
  });

  // The standalone terminal window is frameless (titleBarStyle:'hiddenInset'),
  // so its tab row doubles as the macOS title bar. The dock (default) must NOT —
  // it sits at the bottom of the editor, clear of the traffic lights.
  test('window mode marks the bar as the draggable macOS title region; dock mode does not', () => {
    renderStrip({ draggable: true });
    expect(document.querySelector('[data-electron-drag]')).not.toBeNull();
    // The window has no dock-toggle/collapse — window management is the OS
    // title bar's job — but keeps the full new-chat affordance (feature parity).
    expect(screen.queryByRole('button', { name: /Dock terminal/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Collapse terminal' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New Claude chat' })).toBeDefined();
    cleanup();
    renderStrip();
    expect(document.querySelector('[data-electron-drag]')).toBeNull();
  });

  test('window mode keeps the tab controls interactive (no-drag opt-out works)', async () => {
    const user = userEvent.setup();
    const { onNewChatLaunch, onClose } = renderStrip({ activeSessionId: 's1', draggable: true });

    await user.click(screen.getByRole('button', { name: 'New Claude chat' }));
    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));

    expect(onNewChatLaunch).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('s1');
  });
});
