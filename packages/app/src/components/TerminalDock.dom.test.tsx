/**
 * Behavioral tests for TerminalDock's multi-session orchestration.
 *
 * The resizable layout library (`react-resizable-panels` via `@/components/ui/
 * resizable`) and the terminal height store are mocked at the module boundary —
 * jsdom has no layout engine, so the real vertical split / drag / collapse is the
 * browser rung. TerminalGate is stubbed with a session stand-in that creates a
 * PTY on mount (as the real session does) and exposes its launch nonce, so the
 * assertions pin what the dock owns: the session collection, create/switch/close
 * wiring, all-sessions-stay-mounted isolation, close-last collapse, launch→new
 * tab routing, menu kill, liveness reporting, and focus. The real tab strip +
 * Radix Tabs render so the tablist/tabpanel a11y wiring is exercised here.
 *
 * Per-PTY byte demux (input/output addressed by ptyId) is TerminalPanel's seam,
 * covered in TerminalPanel.dom.test.tsx.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef, useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import type { TerminalDockPosition } from '@/lib/terminal-dock-store';
import { requestActiveTerminalInput } from './handoff/terminal-input-events';

const TERMINAL_PANEL_ID = 'terminal-dock-panel';

// biome-ignore lint/suspicious/noExplicitAny: captured mock-component props, asserted structurally
let terminalPanelProps: Record<string, any> | null = null;

const panelHandle = {
  collapse: mock(() => terminalPanelProps?.onResize?.({ asPercentage: 0, inPixels: 0 })),
  expand: mock(() => terminalPanelProps?.onResize?.({ asPercentage: 40, inPixels: 240 })),
  resize: mock((s: string) => {
    const px = Number.parseInt(s, 10) || 0;
    terminalPanelProps?.onResize?.({ asPercentage: px > 0 ? 30 : 0, inPixels: px });
  }),
};
const sharedPanelRef: { current: unknown } = { current: panelHandle };

mock.module('react-resizable-panels', () => ({
  usePanelRef: () => sharedPanelRef,
}));

mock.module('@/components/ui/resizable', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  ResizablePanelGroup: ({ children, orientation }: any) => (
    <div data-testid="rrp-group" data-orientation={orientation}>
      {children}
    </div>
  ),
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  ResizablePanel: (props: any) => {
    if (props.id === TERMINAL_PANEL_ID) terminalPanelProps = props;
    return (
      <div
        id={props.id}
        data-panel={props.id ?? 'editor'}
        data-inert={props.inert ? 'true' : undefined}
      >
        {props.children}
      </div>
    );
  },
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  ResizableHandle: ({ onPointerDown, disabled, withHandle }: any) => (
    <div
      data-testid="terminal-resize-handle"
      data-disabled={disabled ? 'true' : 'false'}
      data-with-handle={withHandle ? 'true' : 'false'}
      onPointerDown={onPointerDown}
    />
  ),
}));

// A session stand-in mirroring the real TerminalGate→TerminalSession lifecycle
// the dock orchestrates: spawn a PTY on mount, reap it on unmount. Capturing the
// reap makes "closing a tab kills only that session's PTY" observable at the dock
// boundary. It renders xterm's focus-sink so the dock's per-session focus
// assertions resolve. The real gate's consent + heavy/lazy xterm path is covered
// in TerminalGate/TerminalPanel dom tests.
// Per-PTY title emitters, populated by the stub once its create() resolves.
// `emitTitle(ptyId, title)` drives the real TerminalGate→onTitleChange channel
// (xterm's OSC 0/2 → onTitleChange) so the dock's title→tab-label binding is
// exercised without a real xterm. Returns false until the emitter is registered,
// so tests can `waitFor` past the async create.
const titleEmitters = new Map<string, (title: string) => void>();
function emitTitle(ptyId: string, title: string): boolean {
  const emit = titleEmitters.get(ptyId);
  if (emit == null) return false;
  emit(title);
  return true;
}

mock.module('./TerminalGate', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  TerminalGate: ({ bridge, launch, onTitleChange, onPtyId }: any) => {
    const ptyIdRef = useRef<string | null>(null);
    const cancelledRef = useRef(false);
    // Latest-ref so a re-rendered onTitleChange identity (a fresh closure from
    // the dock's session map) is reachable without re-registering the emitter.
    const onTitleChangeRef = useRef(onTitleChange);
    const onPtyIdRef = useRef(onPtyId);
    useEffect(() => {
      onTitleChangeRef.current = onTitleChange;
      onPtyIdRef.current = onPtyId;
    });
    useEffect(() => {
      cancelledRef.current = false;
      void Promise.resolve(bridge?.terminal?.create?.({ cols: 80, rows: 24 })).then(
        (result: { ok?: boolean; ptyId?: string } | undefined) => {
          if (!result?.ok || result.ptyId == null) return;
          // Unmounted while create() was in flight → reap the orphan, as the
          // real session does; otherwise hold the id so unmount can reap it.
          if (cancelledRef.current) bridge?.terminal?.kill?.(result.ptyId);
          else {
            ptyIdRef.current = result.ptyId;
            // Report the live PTY up (as the real panel does) so the host's reuse
            // map is populated — this is what makes an "Ask AI" launch write into
            // the open terminal instead of opening a new tab.
            onPtyIdRef.current?.(result.ptyId);
            titleEmitters.set(result.ptyId, (title: string) => onTitleChangeRef.current?.(title));
          }
        },
      );
      return () => {
        cancelledRef.current = true;
        if (ptyIdRef.current != null) {
          onPtyIdRef.current?.(null);
          titleEmitters.delete(ptyIdRef.current);
          bridge?.terminal?.kill?.(ptyIdRef.current);
        }
      };
    }, [bridge]);
    return (
      <span
        data-testid="terminal-session"
        data-launch={launch?.nonce ?? 'none'}
        className="xterm-helper-textarea"
        tabIndex={-1}
      />
    );
  },
}));

mock.module('@/lib/terminal-height-store', () => ({
  getInitialTerminalHeight: () => 240,
  writeTerminalHeight: () => {},
}));

const { TerminalDock } = await import('./TerminalDock');
const { TerminalSessionsHost } = await import('./TerminalSessionsHost');

function makeBridge() {
  const menuHandlers: Array<(action: string) => void> = [];
  const viewMenuPushes: Array<{ terminalLive?: boolean }> = [];
  // Hand each session a distinct PTY id (pty-1, pty-2, …) so a close can assert
  // exactly which session's PTY was reaped — the demux the dock owns.
  let ptyCounter = 0;
  const create = mock(async () => {
    ptyCounter += 1;
    return { ok: true as const, ptyId: `pty-${ptyCounter}` };
  });
  const kill = mock(async (_id: string) => {});
  // Observes PTY writes at the dock boundary — a launch must never write into an
  // existing PTY (it opens its own tab), so tests assert `input` stays unused.
  const input = mock((_ptyId: string, _data: string) => {});
  const bridge = {
    onMenuAction(cb: (action: string) => void) {
      menuHandlers.push(cb);
      return () => {
        const index = menuHandlers.indexOf(cb);
        if (index >= 0) menuHandlers.splice(index, 1);
      };
    },
    editor: {
      notifyViewMenuStateChanged(state: { terminalLive?: boolean }) {
        viewMenuPushes.push(state);
      },
    },
    terminal: { create, kill, input },
  } as unknown as OkDesktopBridge;
  return {
    bridge,
    create,
    kill,
    input,
    viewMenuPushes,
    dispatchMenuAction(action: string) {
      for (const cb of menuHandlers) cb(action);
    },
  };
}

// Mini-harness mirroring how EditorArea wires the two pieces: the TerminalDock
// shell exposes the bottom mount + editor-region elements, and the once-mounted
// TerminalSessionsHost portals the live sessions into that container. `isShowing`
// is gated on the container so focus never targets a detached host (the same
// invariant EditorArea enforces). Session behavior is bottom-dock only —
// right-dock placement is covered by EditorArea + the live-Electron smoke; the
// `dock` knob here exercises only the shell's handle gating across positions.
// biome-ignore lint/suspicious/noExplicitAny: test harness props
function DockHarness({ v, l, onVisibleChange, bridge, onReveal, dock = 'bottom' }: any) {
  const [bottomContainer, setBottomContainer] = useState<HTMLDivElement | null>(null);
  const [editorRegionEl, setEditorRegionEl] = useState<HTMLDivElement | null>(null);
  return (
    <TooltipProvider>
      <TerminalDock
        visible={v}
        onVisibleChange={onVisibleChange}
        dockPosition={dock}
        onBottomContainer={setBottomContainer}
        onEditorRegion={setEditorRegionEl}
        onReveal={onReveal}
      >
        <div data-testid="editor-child" />
      </TerminalDock>
      <TerminalSessionsHost
        bridge={bridge}
        visible={v}
        onVisibleChange={onVisibleChange}
        launch={l ?? null}
        container={bottomContainer}
        isShowing={v && bottomContainer != null}
        onRequestEditorFocus={() => editorRegionEl?.focus()}
        dockPosition={dock}
        onToggleDock={() => {}}
      />
    </TooltipProvider>
  );
}

function renderDock(
  visible: boolean,
  launch?: { prompt: string; nonce: number; cli?: string } | null,
  onReveal?: () => void,
) {
  const onVisibleChange = mock((_v: boolean) => {});
  const { bridge, create, kill, input, viewMenuPushes, dispatchMenuAction } = makeBridge();
  const ui = (
    v: boolean,
    l?: { prompt: string; nonce: number; cli?: string } | null,
    dock?: TerminalDockPosition,
  ) => (
    <DockHarness
      v={v}
      l={l ?? null}
      onVisibleChange={onVisibleChange}
      bridge={bridge}
      onReveal={onReveal}
      dock={dock ?? 'bottom'}
    />
  );
  const utils = render(ui(visible, launch));
  return {
    ...utils,
    onVisibleChange,
    create,
    kill,
    input,
    viewMenuPushes,
    dispatchMenuAction,
    rerender: (
      v: boolean,
      l?: { prompt: string; nonce: number; cli?: string } | null,
      dock?: TerminalDockPosition,
    ) => utils.rerender(ui(v, l, dock)),
  };
}

function sessionPanels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-session]'));
}

function activePanelId(): string | null {
  const active = document.querySelector<HTMLElement>(
    '[data-terminal-session][data-state="active"]',
  );
  return active?.getAttribute('data-terminal-session') ?? null;
}

// The launch nonce the session in a given panel was handed ('none' when it
// carries no launch). The stub surfaces it via `data-launch` so the dock's
// launch→new-tab routing is observable per session.
function launchNonceOf(panelId: string | null): string | null {
  if (panelId === null) return null;
  return (
    document
      .querySelector(`[data-terminal-session="${panelId}"] [data-testid="terminal-session"]`)
      ?.getAttribute('data-launch') ?? null
  );
}

function editorRegion(): HTMLElement {
  const region = screen.getByTestId('editor-child').parentElement;
  if (region == null) throw new Error('editor region not found');
  return region;
}

// Adds a plain-shell tab via the New-chat split button's "Terminal" option — the
// path that replaced the standalone "New terminal tab" button. Opens a bare shell
// (no CLI launch), the same session the old button created.
async function addTerminalTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Choose CLI for new chat' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Terminal' }));
}

describe('TerminalDock multi-session', () => {
  beforeEach(() => {
    terminalPanelProps = null;
    panelHandle.collapse.mockClear();
    panelHandle.resize.mockClear();
    panelHandle.expand.mockClear();
    sharedPanelRef.current = panelHandle;
    titleEmitters.clear();
  });
  afterEach(() => {
    cleanup();
  });

  test('tab strip exposes the dock-toggle + collapse buttons and no drag grip', () => {
    renderDock(true);
    // The dock-toggle button is the dock-move affordance now (dragging removed).
    // The harness is bottom-docked, so the toggle offers "move to the right".
    expect(screen.getByRole('button', { name: 'Dock terminal to the right' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse terminal' })).not.toBeNull();
    // The old drag grip is gone.
    expect(screen.queryByRole('button', { name: 'Drag to dock the terminal' })).toBeNull();
  });

  test('mounts no session until first opened, then keeps the session mounted on hide', () => {
    const view = renderDock(false);
    expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);

    act(() => view.rerender(true));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);

    // Hide is not kill: the session survives a collapse.
    act(() => view.rerender(false));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
  });

  test('opening the dock creates a session and spawns its PTY', () => {
    const view = renderDock(false);
    expect(view.create).not.toHaveBeenCalled();

    act(() => view.rerender(true));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(view.create).toHaveBeenCalledTimes(1);
  });

  test('the new-terminal control adds a session, activates it, and spawns its PTY', async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    const firstActive = activePanelId();

    await addTerminalTab(user);

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
    // The freshly opened tab becomes active and spawned a second PTY.
    expect(activePanelId()).not.toBe(firstActive);
    expect(view.create).toHaveBeenCalledTimes(2);
  });

  test('all sessions stay mounted with exactly one active', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(3);
    const tabpanels = screen.getAllByRole('tabpanel', { hidden: true });
    expect(tabpanels).toHaveLength(3);
    expect(document.querySelectorAll('[data-terminal-session][data-state="active"]')).toHaveLength(
      1,
    );
  });

  test('switching tabs changes the active session without unmounting the others', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    const secondActive = activePanelId();

    // Switch back to the first tab.
    await user.click(screen.getByRole('tab', { name: 'Terminal 1' }));

    expect(activePanelId()).not.toBe(secondActive);
    // Both sessions remain mounted — switching is show/hide, never unmount.
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
  });

  test('typing target stays scoped: the active panel is the only one shown', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);

    // Each session is a distinct mounted instance; exactly one panel is active
    // (shown) at a time, so input/output route to a single session's surface.
    // The byte-level demux by ptyId is TerminalPanel's covered seam.
    expect(sessionPanels()).toHaveLength(2);
    const activeCount = document.querySelectorAll(
      '[data-terminal-session][data-state="active"]',
    ).length;
    expect(activeCount).toBe(1);
  });

  test('selecting a tab moves focus to that session', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    const second = activePanelId();

    await user.click(screen.getByRole('tab', { name: 'Terminal 1' }));
    const first = activePanelId();
    expect(first).not.toBe(second);

    const focusSink = document.querySelector<HTMLElement>(
      `[data-terminal-session="${first}"] .xterm-helper-textarea`,
    );
    expect(document.activeElement).toBe(focusSink);
  });

  test('closing a non-active tab removes only it and leaves the active one running', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    const activeBefore = activePanelId();

    // Close the (inactive) first tab.
    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    // The active session is untouched.
    expect(activePanelId()).toBe(activeBefore);
  });

  test("a session's OSC title becomes its tab label; siblings keep the default", async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    await addTerminalTab(user);
    await waitFor(() => expect(view.create).toHaveBeenCalledTimes(2));

    // The program in the first session (pty-1) sets its title via OSC 0/2.
    act(() => emitTitle('pty-1', 'claude — repo'));

    // That tab relabels; the sibling keeps its positional default.
    expect(screen.getByRole('tab', { name: 'claude — repo' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toBeDefined();
  });

  test('a later OSC title replaces an earlier one (live binding)', async () => {
    renderDock(true);
    await waitFor(() => expect(emitTitle('pty-1', 'first')).toBe(true));

    act(() => emitTitle('pty-1', 'first'));
    expect(screen.getByRole('tab', { name: 'first' })).toBeDefined();

    act(() => emitTitle('pty-1', 'second'));
    expect(screen.queryByRole('tab', { name: 'first' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'second' })).toBeDefined();
  });

  test('an empty OSC title reverts the tab to its positional default', async () => {
    renderDock(true);
    await waitFor(() => expect(emitTitle('pty-1', 'busy')).toBe(true));

    act(() => emitTitle('pty-1', 'busy'));
    expect(screen.getByRole('tab', { name: 'busy' })).toBeDefined();

    // Some programs emit an empty title on exit — fall back to `Terminal 1`.
    act(() => emitTitle('pty-1', ''));
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeDefined();
  });

  test('a whitespace-only OSC title reverts the tab to its positional default', async () => {
    renderDock(true);
    await waitFor(() => expect(emitTitle('pty-1', 'busy')).toBe(true));

    act(() => emitTitle('pty-1', 'busy'));
    expect(screen.getByRole('tab', { name: 'busy' })).toBeDefined();

    // Whitespace-only is treated as cleared (trim()), same as empty — pins that
    // normalization against a future simplification to `title === ''`.
    act(() => emitTitle('pty-1', '   '));
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeDefined();
  });

  test('a manual rename pins the tab label over later OSC title updates', async () => {
    const user = userEvent.setup();
    renderDock(true);

    // Rename the sole tab before any program title arrives.
    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 1' }));
    const input = screen.getByRole('textbox', { name: 'Rename Terminal 1' });
    await user.clear(input);
    await user.type(input, 'my shell');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: 'my shell' })).toBeDefined();

    // The program now sets an OSC title (the waitFor's successful emit is that
    // update). `title` changes underneath, but the custom label pins the visible
    // name — the tab must NOT relabel to the OSC title.
    await waitFor(() => expect(emitTitle('pty-1', 'claude — repo')).toBe(true));
    expect(screen.getByRole('tab', { name: 'my shell' })).toBeDefined();
    expect(screen.queryByRole('tab', { name: 'claude — repo' })).toBeNull();
  });

  test('clearing a custom label reverts the tab to the live OSC title', async () => {
    const user = userEvent.setup();
    renderDock(true);

    // A program title is live (emitted once via the readiness probe).
    await waitFor(() => expect(emitTitle('pty-1', 'claude — repo')).toBe(true));
    expect(screen.getByRole('tab', { name: 'claude — repo' })).toBeDefined();

    // Pin a custom label over it.
    await user.dblClick(screen.getByRole('tab', { name: 'claude — repo' }));
    await user.clear(screen.getByRole('textbox', { name: 'Rename claude — repo' }));
    await user.type(screen.getByRole('textbox', { name: 'Rename claude — repo' }), 'pinned');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: 'pinned' })).toBeDefined();

    // An empty rename commit clears the custom label; the OSC title (still
    // tracked underneath) becomes the visible name again.
    await user.dblClick(screen.getByRole('tab', { name: 'pinned' }));
    await user.clear(screen.getByRole('textbox', { name: 'Rename pinned' }));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: 'claude — repo' })).toBeDefined();
  });

  function tabLabels(): (string | null)[] {
    return within(screen.getByRole('tablist'))
      .getAllByRole('tab')
      .map((tab) => tab.textContent);
  }
  function dispatchChord(
    key: string,
    mods: { metaKey?: boolean; shiftKey?: boolean },
  ): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      metaKey: mods.metaKey ?? false,
      shiftKey: mods.shiftKey ?? false,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    return event;
  }

  test('⌘⇧← moves the active tab one slot left and announces the move', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    // Three tabs; Terminal 3 is active. Put the caret in its shell.
    const panels = sessionPanels();
    act(() => panels[2]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());

    const event = dispatchChord('ArrowLeft', { metaKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    // Terminal 3 (its sticky number rides with the session) moves to the middle.
    expect(tabLabels()).toEqual(['Terminal 1', 'Terminal 3', 'Terminal 2']);
    await waitFor(() =>
      expect(screen.getByTestId('terminal-reorder-announcer').textContent).toBe(
        'Moved Terminal 3 to position 2 of 3',
      ),
    );
  });

  test('⌘⇧→ at the last slot is a no-op left for the shell', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    // Two tabs; Terminal 2 active (rightmost). Focus its shell.
    const panels = sessionPanels();
    act(() => panels[1]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());

    const event = dispatchChord('ArrowRight', { metaKey: true, shiftKey: true });

    // Not consumed (the shell may use it) and order unchanged.
    expect(event.defaultPrevented).toBe(false);
    expect(tabLabels()).toEqual(['Terminal 1', 'Terminal 2']);
  });

  test('sticky numbering: closing a tab does not renumber the survivors', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    expect(tabLabels()).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3']);

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    // Survivors keep their numbers (not renumbered to 1/2).
    expect(tabLabels()).toEqual(['Terminal 2', 'Terminal 3']);

    // A fresh tab takes the next ordinal, not a reused low number.
    await addTerminalTab(user);
    expect(tabLabels()).toEqual(['Terminal 2', 'Terminal 3', 'Terminal 4']);
  });

  test('⌘N targets the visual position after a keyboard reorder', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    // Two tabs; Terminal 2 active. Move it left → [Terminal 2, Terminal 1].
    const panels = sessionPanels();
    act(() => panels[1]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());
    dispatchChord('ArrowLeft', { metaKey: true, shiftKey: true });
    expect(tabLabels()).toEqual(['Terminal 2', 'Terminal 1']);

    // ⌘1 now activates the leftmost tab, which is Terminal 2.
    act(() =>
      document
        .querySelector<HTMLElement>(
          `[data-terminal-session="${activePanelId()}"] .xterm-helper-textarea`,
        )
        ?.focus(),
    );
    const jump = dispatchChord('1', { metaKey: true });
    expect(jump.defaultPrevented).toBe(true);
    expect(screen.getByRole('tab', { name: 'Terminal 2' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  test('the reorder chord is left for native editing while a rename input is focused', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    // Enter rename on Terminal 1; its input holds focus.
    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 1' }));
    const input = screen.getByRole('textbox', { name: 'Rename Terminal 1' });

    // The capture-phase handler sees an <input> target and stands down, so the
    // chord is not consumed and no reorder happens.
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      metaKey: true,
      shiftKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      input.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByRole('textbox', { name: 'Rename Terminal 1' })).toBeDefined();
  });

  test('reordering tabs does not move the session panels (live shells stay put)', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    // Panels render in stable ordinal order regardless of tab order.
    const panelIds = () => sessionPanels().map((el) => el.getAttribute('data-terminal-session'));
    const stableOrder = ['terminal-session-1', 'terminal-session-2', 'terminal-session-3'];
    expect(panelIds()).toEqual(stableOrder);

    // Reorder the active tab (Terminal 3) one slot left.
    act(() => sessionPanels()[2]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());
    dispatchChord('ArrowLeft', { metaKey: true, shiftKey: true });

    // Tabs reordered, but the panel DOM order is UNCHANGED — the xterm containers
    // never move, so a reorder cannot refit/reset a running shell (SIGWINCH).
    expect(tabLabels()).toEqual(['Terminal 1', 'Terminal 3', 'Terminal 2']);
    expect(panelIds()).toEqual(stableOrder);
  });

  test("closing a tab reaps only that session's PTY and leaves the others alive", async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    await addTerminalTab(user);
    // Two live sessions: Terminal 1 → pty-1, Terminal 2 → pty-2.
    await waitFor(() => expect(view.create).toHaveBeenCalledTimes(2));
    expect(view.kill).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));

    // Only the closed session's PTY is reaped; the survivor keeps its PTY.
    await waitFor(() => expect(view.kill).toHaveBeenCalledWith('pty-1'));
    expect(view.kill).not.toHaveBeenCalledWith('pty-2');
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
  });

  test('closing the active tab activates its left neighbor', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    // Active is the third tab; switch to the middle one and close it.
    await user.click(screen.getByRole('tab', { name: 'Terminal 2' }));
    const middle = activePanelId();

    await user.click(screen.getByRole('button', { name: 'Close Terminal 2' }));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
    // Left neighbor (Terminal 1) becomes active.
    const nowActive = activePanelId();
    expect(nowActive).not.toBe(middle);
    expect(screen.getByRole('tab', { name: 'Terminal 1' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  test('closing the active leftmost tab activates its right neighbor', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    // Activate the leftmost tab — it has no left neighbor to fall back to.
    await user.click(screen.getByRole('tab', { name: 'Terminal 1' }));
    const closedId = activePanelId();
    const rightNeighborId =
      sessionPanels()
        .map((el) => el.getAttribute('data-terminal-session'))
        .find((id) => id !== closedId) ?? null;

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(activePanelId()).toBe(rightNeighborId);
  });

  test('closing the active tab moves focus into the surviving neighbor', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    // Activate the middle tab, then close it.
    await user.click(screen.getByRole('tab', { name: 'Terminal 2' }));

    await user.click(screen.getByRole('button', { name: 'Close Terminal 2' }));

    // Focus is not stranded on <body>: it lands in the now-active neighbor's
    // terminal input, since the close control just unmounted.
    const nowActive = activePanelId();
    const focusSink = document.querySelector<HTMLElement>(
      `[data-terminal-session="${nowActive}"] .xterm-helper-textarea`,
    );
    await waitFor(() => expect(document.activeElement).toBe(focusSink));
  });

  test('closing the last tab collapses the dock and returns focus to the editor', async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    act(() => screen.getByTestId('terminal-session').focus());

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));

    expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);
    expect(view.onVisibleChange).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(editorRegion());
  });

  test('hiding the dock preserves every session and keeps the last-active tab on reopen', async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    // Make a non-default tab active so a reset-to-first regression would show.
    await user.click(screen.getByRole('tab', { name: 'Terminal 2' }));
    const activeBeforeHide = activePanelId();
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(3);

    // Hide (Cmd+J / Close): hide is not kill, so every session survives.
    act(() => view.rerender(false));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(3);
    expect(view.kill).not.toHaveBeenCalled();

    // Reopen: all three survive and the last-active tab is restored.
    act(() => view.rerender(true));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(3);
    expect(activePanelId()).toBe(activeBeforeHide);
    expect(screen.getByRole('tab', { name: 'Terminal 2' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  test('a launch intent opens a session carrying that intent', () => {
    const view = renderDock(false);
    expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);

    act(() => view.rerender(true, { prompt: 'work on docs', nonce: 7 }));

    const session = screen.getByTestId('terminal-session');
    // Exactly one session, and it carries the launch (no extra empty tab).
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(session.getAttribute('data-launch')).toBe('7');
  });

  test('cold-start with visible=true seeds exactly one session carrying the launch intent', () => {
    // Distinct from the false->true effect path above: this exercises the
    // useState initializer (visible=true at mount). Both must seed one session.
    renderDock(true, { prompt: 'work on docs', nonce: 9 });
    const sessions = screen.getAllByTestId('terminal-session');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.getAttribute('data-launch')).toBe('9');
  });

  test('a launch always opens its own tab, even when a terminal is already live', async () => {
    const view = renderDock(true);
    // Wait until the seed session's PTY is live and reported up (the emitter is
    // registered right after create() resolves + onPtyId fires).
    await waitFor(() => expect(emitTitle('pty-1', 'zsh')).toBe(true));
    const runningId = activePanelId();
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);

    // "Create with CLI" / "Open in terminal" fires while that shell is live.
    act(() => view.rerender(true, { prompt: 'work on docs', cli: 'claude', nonce: 1 }));

    // A launch never hijacks the running shell — it opens its own tab, which
    // becomes active, and writes nothing into the existing PTY. (Reuse of an open
    // terminal is the selection-bubble path only, a separate input channel.)
    const sessions = screen.getAllByTestId('terminal-session');
    expect(sessions).toHaveLength(2);
    const launchedId = activePanelId();
    expect(launchedId).not.toBe(runningId);
    expect(launchNonceOf(launchedId)).toBe('1');
    expect(view.input).not.toHaveBeenCalled();
  });

  test('the selection input reuses the live terminal — raw PTY write, no new tab', async () => {
    const view = renderDock(true);
    // Wait until the seed session's PTY is live and reported up into the reuse map.
    await waitFor(() => expect(emitTitle('pty-1', 'zsh')).toBe(true));
    const runningId = activePanelId();
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);

    // The selection-bubble channel fires while that shell is live (the other half
    // of the design: launches open their own tab, the selection reuses the open
    // one).
    await act(async () => {
      requestActiveTerminalInput('explain this');
    });

    // Reused, not respawned: the raw selection text goes straight into the live
    // PTY (no `<bin> '<prompt>'` wrapping), no new tab, and the running shell
    // stays active.
    await waitFor(() => expect(view.input).toHaveBeenCalledWith('pty-1', 'explain this'));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(activePanelId()).toBe(runningId);
  });

  test('a launch before the seed terminal PTY is live also opens its own tab', () => {
    const view = renderDock(true);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    const seedId = activePanelId();

    // Fire the launch synchronously, before the seed session's create() resolves.
    act(() => view.rerender(true, { prompt: 'work on docs', cli: 'claude', nonce: 1 }));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
    const launchedId = activePanelId();
    expect(launchedId).not.toBe(seedId);
    expect(launchNonceOf(launchedId)).toBe('1');
  });

  test('distinct launches each open their own tab', async () => {
    const view = renderDock(true);
    await waitFor(() => expect(emitTitle('pty-1', 'zsh')).toBe(true));

    act(() => view.rerender(true, { prompt: 'a', cli: 'claude', nonce: 1 }));
    act(() => view.rerender(true, { prompt: 'b', cli: 'claude', nonce: 2 }));

    // Two distinct launches → two new tabs on top of the seed. No PTY writes.
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(3);
    expect(view.input).not.toHaveBeenCalled();
  });

  test('a repeated launch with the same nonce opens only one tab', async () => {
    const view = renderDock(true);
    await waitFor(() => expect(emitTitle('pty-1', 'zsh')).toBe(true));

    act(() => view.rerender(true, { prompt: 'a', cli: 'claude', nonce: 1 }));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);

    // A re-render carrying the already-handled nonce (an unrelated parent
    // re-render, not a fresh click) must not open a second tab — the per-nonce
    // dedup is what makes one click mean exactly one new terminal.
    act(() => view.rerender(true, { prompt: 'a', cli: 'claude', nonce: 1 }));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
  });

  test('the Terminal menu "New Terminal" action adds a tab and activates it', () => {
    const view = renderDock(true);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    const firstActive = activePanelId();

    act(() => view.dispatchMenuAction('new-terminal'));

    // New Terminal opens a fresh tab (not just a reveal), which becomes active
    // and spawns its own PTY — the same path as the strip's + control.
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
    expect(activePanelId()).not.toBe(firstActive);
    expect(view.create).toHaveBeenCalledTimes(2);
  });

  test('the Terminal menu "Kill Terminal" action closes the active tab', async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    await addTerminalTab(user);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);

    act(() => view.dispatchMenuAction('kill-terminal'));

    // One session killed (the active one); the other survives.
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
  });

  test('⌘W (close-active-tab-or-window) is NOT handled by the dock — the editor owns it', async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    await addTerminalTab(user);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);

    act(() => view.dispatchMenuAction('close-active-tab-or-window'));

    // In the editor window ⌘W closes the active DOC tab (DocumentContext); the
    // docked terminal must not also close a session, or one keystroke would
    // close two things. Only the standalone terminal window handles this action.
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
  });

  test('Cmd+number jumps to the matching tab while the terminal is focused', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    // Three tabs; Terminal 3 is active. Put the caret in its terminal as if the
    // user were typing in the shell.
    const panels = sessionPanels();
    const thirdSink = panels[2]?.querySelector<HTMLElement>('.xterm-helper-textarea');
    act(() => thirdSink?.focus());
    expect(activePanelId()).toBe(panels[2]?.getAttribute('data-terminal-session'));

    // Cmd+1 jumps straight to the first tab without leaving the terminal.
    const event = new KeyboardEvent('keydown', {
      key: '1',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    // The chord is consumed (it never reaches the shell) and the first tab is now active.
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole('tab', { name: 'Terminal 1' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(activePanelId()).toBe(panels[0]?.getAttribute('data-terminal-session'));
  });

  test('Cmd+number for a tab that does not exist is left for the shell', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    // Two tabs; the second is active. Focus its terminal.
    const panels = sessionPanels();
    act(() => panels[1]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());
    const before = activePanelId();

    const event = new KeyboardEvent('keydown', {
      key: '5',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    // No fifth tab — the chord is not consumed (so the shell may use it) and the
    // active tab is unchanged.
    expect(event.defaultPrevented).toBe(false);
    expect(activePanelId()).toBe(before);
  });

  test('Cmd+number is ignored when focus is outside the terminal dock', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await user.click(screen.getByRole('tab', { name: 'Terminal 1' }));
    const before = activePanelId();

    // Move focus to the editor column, outside the dock.
    act(() => editorRegion().focus());
    const event = new KeyboardEvent('keydown', {
      key: '2',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    // The digit chord is free outside the dock: the terminal tab is untouched
    // and the event is not consumed.
    expect(event.defaultPrevented).toBe(false);
    expect(activePanelId()).toBe(before);
  });

  test('a non-chord keystroke is not intercepted so it reaches the active shell', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    const before = activePanelId();
    act(() => sessionPanels()[0]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());

    // Escape carries no ⌘ — the tab-switch handler must ignore it so the shell
    // receives it.
    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
      bubbles: true,
    });
    // A plain digit (no ⌘) is likewise shell input, never a tab switch.
    const digitEvent = new KeyboardEvent('keydown', {
      key: '1',
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(escapeEvent);
      window.dispatchEvent(digitEvent);
    });

    expect(escapeEvent.defaultPrevented).toBe(false);
    expect(digitEvent.defaultPrevented).toBe(false);
    expect(activePanelId()).toBe(before);
  });

  test('reports terminal liveness — true once a session exists, false after the last closes', async () => {
    const user = userEvent.setup();
    const view = renderDock(false);
    expect(view.viewMenuPushes.at(-1)).toEqual({ terminalLive: false });

    act(() => view.rerender(true));
    expect(view.viewMenuPushes.at(-1)).toEqual({ terminalLive: true });

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    expect(view.viewMenuPushes.at(-1)).toEqual({ terminalLive: false });
  });

  test('wires each tab to its panel via accessible tablist/tabpanel relationships', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);

    const tablist = screen.getByRole('tablist', { name: 'Terminal sessions' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    // Each tab's aria-controls resolves to a rendered panel (no dangling ref).
    for (const tab of tabs) {
      const panelId = tab.getAttribute('aria-controls');
      expect(panelId).toBeTruthy();
      expect(document.getElementById(panelId ?? '')).not.toBeNull();
    }
  });

  test('persists the bottom panel config (collapsible, sized, inert when hidden)', () => {
    renderDock(false);
    expect(terminalPanelProps?.collapsible).toBe(true);
    expect(terminalPanelProps?.collapsedSize).toBe(0);
    expect(terminalPanelProps?.minSize).toBe('120px');
    expect(terminalPanelProps?.maxSize).toBe('95%');
    expect(terminalPanelProps?.defaultSize).toBe(0);
    expect(terminalPanelProps?.inert).toBe(true);
  });

  test('focuses the active session on reveal so the user can type immediately', () => {
    const view = renderDock(true);
    const session = screen.getByTestId('terminal-session');

    // Collapse → focus returns to the editor.
    act(() => view.rerender(false));
    expect(document.activeElement).toBe(editorRegion());

    // Reveal → focus lands back in the active session's input.
    act(() => view.rerender(true));
    expect(document.activeElement).toBe(session);
  });

  test('shows the bottom-edge "Show terminal" tab only while hidden, inside the editor column', () => {
    const onReveal = mock(() => {});
    const view = renderDock(false, null, onReveal);

    // Hidden → the reveal tab is present, and lives inside the editor region (not
    // the doc panel), since a bottom-docked terminal slides up from there.
    const reveal = screen.getByRole('button', { name: 'Show terminal' });
    expect(editorRegion().contains(reveal)).toBe(true);

    // Visible → the reveal tab is gone (the tab strip's collapse control is the
    // hide affordance while open).
    act(() => view.rerender(true));
    expect(screen.queryByRole('button', { name: 'Show terminal' })).toBeNull();
  });

  test('clicking the reveal tab requests a reveal', async () => {
    const user = userEvent.setup();
    const onReveal = mock(() => {});
    renderDock(false, null, onReveal);

    await user.click(screen.getByRole('button', { name: 'Show terminal' }));

    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  test('renders no reveal tab when no reveal handler is wired (web host)', () => {
    renderDock(false);
    expect(screen.queryByRole('button', { name: 'Show terminal' })).toBeNull();
  });

  test('disables the resize handle while hidden so there is no drag-to-open', () => {
    const view = renderDock(false);
    // Hidden: dragging up to open is gone (the reveal tab is the single way in).
    expect(screen.getByTestId('terminal-resize-handle').getAttribute('data-disabled')).toBe('true');

    // Open: the handle is live again — resize + drag-all-the-way-down-to-collapse.
    act(() => view.rerender(true));
    expect(screen.getByTestId('terminal-resize-handle').getAttribute('data-disabled')).toBe(
      'false',
    );
  });

  test('hides the grabber while right-docked and restores it on return to bottom', () => {
    // Right-docked, terminal visible: `visible` stays true but the bottom panel is
    // collapsed and empty — the handle must not render its grabber nor accept a
    // drag (which would pull up an empty panel).
    const view = renderDock(true);
    act(() => view.rerender(true, null, 'right'));
    const handle = () => screen.getByTestId('terminal-resize-handle');
    expect(handle().getAttribute('data-disabled')).toBe('true');
    expect(handle().getAttribute('data-with-handle')).toBe('false');

    // Dock back to bottom: the grabber returns and the handle drags again.
    act(() => view.rerender(true, null, 'bottom'));
    expect(handle().getAttribute('data-disabled')).toBe('false');
    expect(handle().getAttribute('data-with-handle')).toBe('true');
  });
});

// Regression: the focus-return effect must distinguish a genuine hide (⌘J /
// collapse / close-last → `visible` false) from a dock move, where `visible` stays
// true but `isShowing` transiently dips to false for one commit while the
// destination container's callback ref attaches. The dock-toggle button lives
// inside the portaled host, so a move starts with focus inside the host — without
// the `visible` guard, the transient dip would yank focus to the editor mid-move.
describe('TerminalSessionsHost focus-return gating across a dock move', () => {
  afterEach(() => cleanup());

  function FocusHarness({
    bridge,
    isShowing,
    visible,
    onEditorFocus,
  }: {
    // biome-ignore lint/suspicious/noExplicitAny: test harness bridge stub
    bridge: any;
    isShowing: boolean;
    visible: boolean;
    onEditorFocus: () => void;
  }) {
    const [container, setContainer] = useState<HTMLDivElement | null>(null);
    return (
      <TooltipProvider>
        <div ref={setContainer} data-testid="term-host-container" />
        <TerminalSessionsHost
          bridge={bridge}
          visible={visible}
          onVisibleChange={() => {}}
          launch={null}
          container={container}
          isShowing={isShowing}
          onRequestEditorFocus={onEditorFocus}
          dockPosition="right"
          onToggleDock={() => {}}
        />
      </TooltipProvider>
    );
  }

  test('a dock move keeps focus (visible stays true); a genuine hide returns focus to the editor', () => {
    const onEditorFocus = mock(() => {});
    const { bridge } = makeBridge();
    const ui = (isShowing: boolean, visible: boolean) => (
      <FocusHarness
        bridge={bridge}
        isShowing={isShowing}
        visible={visible}
        onEditorFocus={onEditorFocus}
      />
    );
    const { rerender } = render(ui(true, true));

    // One session is seeded (visible at mount); put focus inside the portaled host.
    const sink = document.querySelector<HTMLElement>(
      '[data-terminal-session] .xterm-helper-textarea',
    );
    act(() => sink?.focus());
    expect(onEditorFocus).not.toHaveBeenCalled();

    // Dock-move transient: isShowing dips to false while visible stays true. Focus
    // must NOT be yanked to the editor.
    act(() => rerender(ui(false, true)));
    expect(onEditorFocus).not.toHaveBeenCalled();

    // Genuine hide: visible flips false → focus returns to the editor.
    act(() => rerender(ui(false, false)));
    expect(onEditorFocus).toHaveBeenCalled();
  });
});

// The behavior-preservation contract for the terminal session model
// (TerminalSessionsHost, shared by the dock and the standalone terminal
// window): these five behaviors (close-last collapse, seed-on-reveal,
// single-tab-per-launch-nonce, Cmd+number tab switch, close-active-neighbor
// focus) are the ones most easily broken when the dock's container wiring and
// the shared session core drift out of lockstep. Kept as a discrete, minimal
// block — distinct from the broader suite above — so the dock and the window
// share one stable, referenceable set to validate against.
describe('TerminalDock extraction pins', () => {
  beforeEach(() => {
    terminalPanelProps = null;
    panelHandle.collapse.mockClear();
    panelHandle.resize.mockClear();
    panelHandle.expand.mockClear();
    sharedPanelRef.current = panelHandle;
  });
  afterEach(() => {
    cleanup();
  });

  test('pin: closing the last tab collapses the dock and returns focus to the editor', async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    act(() => screen.getByTestId('terminal-session').focus());

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));

    expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);
    expect(view.onVisibleChange).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(editorRegion());
  });

  test('pin: the dock seeds exactly one session when it becomes visible', () => {
    const view = renderDock(false);
    expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);

    act(() => view.rerender(true));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(view.create).toHaveBeenCalledTimes(1);
  });

  test('pin: a repeated launch nonce does not open a second tab', () => {
    const view = renderDock(true);

    act(() => view.rerender(true, { prompt: 'work', nonce: 1 }));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);

    // An unrelated re-render carrying the already-handled nonce must not spawn
    // another tab — one launch click means exactly one new tab.
    act(() => view.rerender(true, { prompt: 'work', nonce: 1 }));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
  });

  test('pin: Cmd+number switches the active tab while the terminal is focused', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    const panels = sessionPanels();
    act(() => panels[1]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());

    const event = new KeyboardEvent('keydown', {
      key: '1',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(activePanelId()).toBe(panels[0]?.getAttribute('data-terminal-session'));
  });

  test('pin: closing the active tab moves focus to a surviving neighbor', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    await user.click(screen.getByRole('tab', { name: 'Terminal 2' }));

    await user.click(screen.getByRole('button', { name: 'Close Terminal 2' }));

    const nowActive = activePanelId();
    const focusSink = document.querySelector<HTMLElement>(
      `[data-terminal-session="${nowActive}"] .xterm-helper-textarea`,
    );
    await waitFor(() => expect(document.activeElement).toBe(focusSink));
  });
});
