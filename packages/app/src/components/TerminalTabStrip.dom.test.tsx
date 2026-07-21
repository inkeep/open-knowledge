import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { type TerminalTabDescriptor, TerminalTabStrip } from './TerminalTabStrip';

const SESSIONS: readonly TerminalTabDescriptor[] = [
  { id: 's1', label: 'Terminal 1' },
  { id: 's2', label: 'Terminal 2' },
  { id: 's3', label: 'Terminal 3' },
];

// A stub for the host-provided New button — the strip renders whatever node the
// host passes as `newButton` (the real merged split-button has its own test).
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
  dockPosition?: 'bottom' | 'right';
  draggable?: boolean;
  /** Omit the rename handler to assert the affordance is inert without it. */
  renameDisabled?: boolean;
  /** Render a stub trailing control (stands in for the history menu). */
  withTrailing?: boolean;
}) {
  const onSelect = vi.fn((_id: string) => {});
  const onTabActivate = vi.fn((_id: string) => {});
  const onNewButtonClick = vi.fn(() => {});
  const onClose = vi.fn((_id: string) => {});
  const onRename = vi.fn((_id: string, _label: string) => {});
  const onToggleDock = vi.fn(() => {});
  const onCollapse = vi.fn(() => {});
  const view = render(
    // The app mounts a root TooltipProvider (main.tsx); the strip's control
    // tooltips need that context, so the isolated render supplies its own.
    // `draggable` mirrors the standalone terminal window's prop shape (same
    // chrome, no dock/collapse controls); the default mirrors the dock.
    <TooltipProvider>
      <TerminalTabStrip
        sessions={props?.sessions ?? SESSIONS}
        activeSessionId={props?.activeSessionId ?? 's1'}
        onSelect={onSelect}
        onTabActivate={onTabActivate}
        newButton={stubNewButton(onNewButtonClick)}
        trailingControls={
          props?.withTrailing ? (
            <button type="button" aria-label="Restore sessions">
              H
            </button>
          ) : undefined
        }
        onClose={onClose}
        onRename={props?.renameDisabled ? undefined : onRename}
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
    onNewButtonClick,
    onClose,
    onRename,
    onToggleDock,
    onCollapse,
    rerender: view.rerender,
  };
}

describe('TerminalTabStrip', () => {
  afterEach(() => cleanup());

  test('renders one tab per session inside a labeled tablist', () => {
    renderStrip();
    const tablist = screen.getByRole('tablist', { name: 'Sessions' });
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
        within(screen.getByRole('tablist', { name: 'Sessions' }))
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

  test('renders the host-provided New button and forwards its clicks unchanged', async () => {
    const user = userEvent.setup();
    const { onNewButtonClick, onSelect } = renderStrip();

    await user.click(screen.getByRole('button', { name: 'New session' }));

    expect(onNewButtonClick).toHaveBeenCalledTimes(1);
    // The strip is chrome — it never intercepts the New button's behavior.
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('the New button hugs the last tab, preceding the trailing dock-toggle / collapse controls', () => {
    renderStrip();
    const newButton = screen.getByRole('button', { name: 'New session' });
    const dockToggle = screen.getByRole('button', { name: 'Dock sessions on the right' });
    const collapse = screen.getByRole('button', { name: 'Collapse session dock' });
    // The New button sits immediately right of the tablist; the spacer pushes the
    // trailing group (dock-toggle … collapse) to the far right.
    expect(
      newButton.compareDocumentPosition(dockToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      dockToggle.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('trailing controls render at the far right, immediately left of the dock-toggle', () => {
    renderStrip({ withTrailing: true });
    const trailing = screen.getByRole('button', { name: 'Restore sessions' });
    const newButton = screen.getByRole('button', { name: 'New session' });
    const dockToggle = screen.getByRole('button', { name: 'Dock sessions on the right' });
    // The New button hugs the tabs on the left; the trailing control sits in the
    // far-right cluster, before the dock-toggle.
    expect(
      newButton.compareDocumentPosition(trailing) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      trailing.compareDocumentPosition(dockToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
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

  test('the dock-toggle reports onToggleDock and labels the resulting position', async () => {
    const user = userEvent.setup();
    // Bottom-docked → the toggle moves it to the right.
    const bottom = renderStrip({ dockPosition: 'bottom' });
    const toRight = screen.getByRole('button', { name: 'Dock sessions on the right' });
    await user.click(toRight);
    expect(bottom.onToggleDock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Dock sessions at the bottom' })).toBeNull();
    cleanup();

    // Right-docked → the toggle moves it to the bottom (label flips).
    const right = renderStrip({ dockPosition: 'right' });
    const toBottom = screen.getByRole('button', { name: 'Dock sessions at the bottom' });
    await user.click(toBottom);
    expect(right.onToggleDock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Dock sessions on the right' })).toBeNull();
  });

  test('the collapse control reports onCollapse and never onClose / new-button', async () => {
    const user = userEvent.setup();
    const { onCollapse, onClose, onNewButtonClick } = renderStrip();

    await user.click(screen.getByRole('button', { name: 'Collapse session dock' }));

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
    expect(screen.getByRole('button', { name: 'Dock sessions on the right' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Collapse session dock' })).toBeDefined();
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
    // title bar's job — but keeps the New button (feature parity).
    expect(screen.queryByRole('button', { name: /Dock sessions/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Collapse session dock' })).toBeNull();
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

  // ---- Manual rename: double-click / F2 → inline input ----

  test('double-clicking a tab opens an inline rename input, prefilled and focused', async () => {
    const user = userEvent.setup();
    renderStrip({ activeSessionId: 's2' });

    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 2' }));

    const input = screen.getByRole('textbox', { name: 'Rename Terminal 2' });
    expect(input).toBe(document.activeElement);
    expect((input as HTMLInputElement).value).toBe('Terminal 2');
    // The renaming tab's trigger is REPLACED by the input (never nested inside a
    // role="tab" button); the other tabs keep their triggers.
    expect(screen.queryByRole('tab', { name: 'Terminal 2' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeDefined();
    expect(input.closest('[role="tab"]')).toBeNull();
  });

  test('double-click that opens rename fires onTabActivate at most once (second click suppressed)', async () => {
    const user = userEvent.setup();
    const { onTabActivate } = renderStrip({ activeSessionId: 's1' });

    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 2' }));

    // A double-click dispatches two click events (detail 1 then detail 2). The
    // onClick guard suppresses the detail>=2 one; without it, the second
    // activation focuses the terminal and blur-commits the rename input the same
    // gesture just opened. Exactly one call (the initial detail=1 select) pins
    // the guard — a regression that dropped or inverted it would read 2.
    expect(onTabActivate).toHaveBeenCalledTimes(1);
    expect(onTabActivate).toHaveBeenCalledWith('s2');
    // The rename input is open and focused — the activation did not steal it.
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
    // Strip is controlled — the visible label only changes when the parent
    // re-renders; here we assert the input closed and the trigger returned.
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

    // Escape sets the cancel guard, then blurs — the ensuing blur must NOT commit.
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
    // Whitespace-only input must trim to '' -> label-clear, not a real label of
    // spaces. Exercises the trim->empty path end-to-end (a broken trim would
    // silently promote whitespace to a custom label).
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

    // The session closes (PTY exit / ⌘W) — its descriptor leaves `sessions`.
    rerender(
      <TooltipProvider>
        <TerminalTabStrip
          sessions={[
            { id: 's1', label: 'Terminal 1' },
            { id: 's2', label: 'Terminal 2' },
          ]}
          activeSessionId="s1"
          onSelect={() => {}}
          newButton={stubNewButton(() => {})}
          onClose={() => {}}
          onRename={() => {}}
          dockPosition="bottom"
          onToggleDock={() => {}}
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

  // ---- Reorder wiring ----
  // Pointer-drag geometry is covered by the chrome module's unit suite and the
  // opt-in desktop smoke (jsdom cannot faithfully simulate the pointer sensor);
  // here we pin that every tab is a sortable node and the tablist role survives
  // the dnd-kit wrapping (no injected role="button" on the wrapper).

  test('every tab is wrapped in a sortable node without disturbing the tablist', () => {
    renderStrip();
    expect(document.querySelectorAll('[data-terminal-tab-sortable]')).toHaveLength(3);
    // The dnd-kit wrapper is not focusable and adds no role — the Radix tablist
    // still sees exactly three tabs.
    const tablist = screen.getByRole('tablist', { name: 'Sessions' });
    expect(within(tablist).getAllByRole('tab')).toHaveLength(3);
    expect(within(tablist).queryAllByRole('button', { name: /^Terminal/ })).toHaveLength(0);
  });
});
