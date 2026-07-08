/**
 * RED contract for issue #351 (terminal-dock reload-survival) —
 * the RENDERER half.
 *
 * After a renderer reload the live PTY sessions survive in the main process, but
 * today the dock remounts empty: its session list is seeded only from the
 * `visible` prop (TerminalDock.tsx) with no mount-time query for the shells
 * that are still alive, and the terminal bridge exposes no enumeration channel to
 * ask. This pins the FIXED behavior — when the bridge reports pre-existing live
 * sessions for this window, the dock rehydrates one tab per surviving shell
 * instead of seeding a single fresh one.
 *
 * The assertion is on observable dock state (the tabs the dock surfaces), not on
 * which bridge method the fix calls: the enumeration capability is offered under
 * several plausible names so the fix keeps latitude on the exact channel.
 *
 * Scope note: dock VISIBILITY restoration is EditorPane's concern (it owns
 * `terminalVisible`, EditorPane.tsx) and is covered end-to-end by the live
 * reload smoke in packages/desktop/tests/smoke/terminal-dock.e2e.ts. This test
 * owns the dock's own responsibility — recovering its session list. The existing
 * cold-start coverage in TerminalDock.dom.test.tsx (visible=true seeds exactly
 * one session) guards against the fix over-correcting on a true fresh start.
 *
 * Mocks mirror TerminalDock.dom.test.tsx: jsdom has no layout engine, so the
 * resizable split + height store are mocked at the module boundary and
 * TerminalGate is stubbed with a session marker; the real TerminalTabStrip +
 * Radix Tabs render so the tab/active-tab a11y wiring is exercised.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useEffect, useRef, useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { requestActiveTerminalInput } from './handoff/terminal-input-events';

const TERMINAL_PANEL_ID = 'terminal-dock-panel';

// biome-ignore lint/suspicious/noExplicitAny: captured mock-component props
let terminalPanelProps: Record<string, any> | null = null;
const panelHandle = {
  collapse: mock(() => terminalPanelProps?.onResize?.({ asPercentage: 0, inPixels: 0 })),
  expand: mock(() => terminalPanelProps?.onResize?.({ asPercentage: 40, inPixels: 240 })),
  resize: mock(() => {}),
};
const sharedPanelRef: { current: unknown } = { current: panelHandle };

mock.module('react-resizable-panels', () => ({ usePanelRef: () => sharedPanelRef }));
mock.module('@/components/ui/resizable', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  ResizablePanelGroup: ({ children }: any) => <div>{children}</div>,
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  ResizablePanel: (props: any) => {
    if (props.id === TERMINAL_PANEL_ID) terminalPanelProps = props;
    return <div id={props.id}>{props.children}</div>;
  },
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  ResizableHandle: ({ onPointerDown }: any) => <div onPointerDown={onPointerDown} />,
}));

// Session stand-in: renders xterm's focus-sink marker so the dock's tab count is
// observable. A rehydrated session adopts a surviving PTY rather than spawning a
// new one, so the stub deliberately does NOT call bridge.terminal.create — the
// dock's tab management (one tab per recovered session) is what this test pins;
// the adopt-vs-spawn wiring lives in TerminalGate/TerminalPanel and the live
// reload smoke.
mock.module('./TerminalGate', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  TerminalGate: ({ adoptPtyId, onPtyId }: any) => {
    // Mirror the real panel's adopt path: a rehydrated session reconnects the
    // surviving PTY and reports that adopted id up (attachSession → onPtyId), so
    // the host's reuse map is populated for reload survivors — the path the
    // selection-bubble Ask-AI input writes into. Latest-ref so the host's
    // per-render onPtyId closure is
    // reachable without re-running the report on every render.
    const onPtyIdRef = useRef(onPtyId);
    useEffect(() => {
      onPtyIdRef.current = onPtyId;
    });
    useEffect(() => {
      if (adoptPtyId != null) onPtyIdRef.current?.(adoptPtyId);
      return () => onPtyIdRef.current?.(null);
    }, [adoptPtyId]);
    return <span data-testid="terminal-session" className="xterm-helper-textarea" tabIndex={-1} />;
  },
}));

mock.module('@/lib/terminal-height-store', () => ({
  getInitialTerminalHeight: () => 240,
  writeTerminalHeight: () => {},
}));

const { TerminalDock } = await import('./TerminalDock');
const { TerminalSessionsHost } = await import('./TerminalSessionsHost');

// Mirror EditorArea's wiring: the TerminalDock shell exposes the bottom mount, and
// the once-mounted TerminalSessionsHost (which now owns the session collection +
// reload rehydration) portals the live sessions into it. The rehydration the
// renderer half is responsible for lives in the host, so reload-survival is
// asserted through this pair, not TerminalDock alone.
function ReloadHarness({
  bridge,
  visible,
  launch = null,
}: {
  bridge: OkDesktopBridge;
  visible: boolean;
  launch?: { prompt: string; cli: string; nonce: number } | null;
}) {
  const [bottomContainer, setBottomContainer] = useState<HTMLDivElement | null>(null);
  return (
    <TooltipProvider>
      <TerminalDock
        visible={visible}
        onVisibleChange={() => {}}
        dockPosition="bottom"
        onBottomContainer={setBottomContainer}
        onEditorRegion={() => {}}
      >
        <div data-testid="editor-child" />
      </TerminalDock>
      <TerminalSessionsHost
        bridge={bridge}
        visible={visible}
        onVisibleChange={() => {}}
        // biome-ignore lint/suspicious/noExplicitAny: test launch shape
        launch={launch as any}
        container={bottomContainer}
        isShowing={visible && bottomContainer != null}
        onRequestEditorFocus={() => {}}
        dockPosition="bottom"
        onToggleDock={() => {}}
      />
    </TooltipProvider>
  );
}

/**
 * A surviving main process that already holds live PTY sessions for this window.
 * The enumeration capability the reloaded host consumes is offered under several
 * plausible names — the test asserts on the tabs surfaced, never on which alias
 * the fix calls.
 */
function makeSurvivingMainBridge(
  preExisting: ReadonlyArray<{
    ptyId: string;
    customLabel?: string | null;
    ordinal?: number | null;
  }>,
) {
  let freshCounter = 0;
  const create = mock(async () => {
    freshCounter += 1;
    return { ok: true as const, ptyId: `fresh-pty-${freshCounter}` };
  });
  const kill = mock(async (_id: string) => {});
  // Records launch-command writes so an Ask-AI reuse into an adopted (survivor)
  // session's live PTY is observable.
  const input = mock((_id: string, _d: string) => {});
  const listLive = mock(async () => preExisting);
  const setMeta = mock((_ptyId: string, _meta: unknown) => {});
  const setOrder = mock((_ids: readonly string[]) => {});
  const bridge = {
    onMenuAction: () => () => {},
    editor: { notifyViewMenuStateChanged: () => {} },
    terminal: {
      create,
      kill,
      input,
      list: listLive,
      listSessions: listLive,
      getSessions: listLive,
      snapshotSessions: listLive,
      restoreSessions: listLive,
      setMeta,
      setOrder,
    },
  } as unknown as OkDesktopBridge;
  return { bridge, create, input, listLive, setMeta, setOrder };
}

function renderDock(bridge: OkDesktopBridge, visible: boolean) {
  return render(<ReloadHarness bridge={bridge} visible={visible} />);
}

describe('issue #351 — the terminal dock rehydrates surviving sessions after a renderer reload', () => {
  afterEach(() => {
    cleanup();
    terminalPanelProps = null;
  });

  test('recovers a tab per surviving session instead of seeding a single fresh one', async () => {
    // Two shells were live in the main process before the reload.
    const { bridge } = makeSurvivingMainBridge([{ ptyId: 'pty-1' }, { ptyId: 'pty-2' }]);

    // The post-reload dock mounts fresh (the parent restored visibility).
    renderDock(bridge, true);

    // FIXED behavior: on mount the dock asks main for the surviving sessions and
    // shows one tab per live shell. RED today — the dock ignores them and seeds a
    // single fresh session from the `visible` prop (TerminalDock.tsx), so
    // this settles at 1 tab and never reaches 2.
    await waitFor(() => expect(screen.getAllByTestId('terminal-session')).toHaveLength(2), {
      timeout: 2000,
    });

    // Exactly one of the recovered tabs is active (the dock restores a focused tab,
    // it does not leave the strip with zero or many active).
    expect(document.querySelectorAll('[data-terminal-session][data-state="active"]')).toHaveLength(
      1,
    );
  });

  test("restores each survivor's custom name and the reordered tab order across reload", async () => {
    // Main returns survivors already in the user's reordered sequence, each with
    // the metadata it retained across the reload: a custom name on two, a bare
    // sticky ordinal on the third.
    const { bridge } = makeSurvivingMainBridge([
      { ptyId: 'pty-3', customLabel: 'deploy', ordinal: 3 },
      { ptyId: 'pty-1', customLabel: null, ordinal: 1 },
      { ptyId: 'pty-2', customLabel: 'logs', ordinal: 2 },
    ]);

    renderDock(bridge, true);

    await waitFor(() => expect(screen.getAllByTestId('terminal-session')).toHaveLength(3), {
      timeout: 2000,
    });

    // Tabs come back in main's returned (reordered) order with the custom names
    // restored; the un-named survivor falls back to its RESTORED sticky ordinal
    // (Terminal 1), not a positional renumber to Terminal 2.
    const tablist = screen.getByRole('tablist', { name: 'Terminal sessions' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['deploy', 'Terminal 1', 'logs']);
  });

  test('a rename pushes the new custom label to main (renderer->main persist path)', async () => {
    const { bridge, setMeta } = makeSurvivingMainBridge([
      { ptyId: 'pty-1', customLabel: null, ordinal: 1 },
    ]);
    const user = userEvent.setup();

    renderDock(bridge, true);
    await waitFor(() => expect(screen.getAllByTestId('terminal-session')).toHaveLength(1), {
      timeout: 2000,
    });

    // Rename the tab: double-click -> inline input -> Enter. This is the push path
    // that keeps the custom name alive across a future reload; it is optional-chained
    // in production, so a mock omitting setMeta would leave it silently unverified.
    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 1' }));
    const input = screen.getByRole('textbox', { name: /^Rename/ });
    await user.clear(input);
    await user.type(input, 'deploy');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(setMeta).toHaveBeenCalledWith('pty-1', { customLabel: 'deploy' }));
  });

  // A render that can flip `visible` so the "open the dock after a reload with no
  // prior terminal" flow is exercised: the dock starts hidden (the reload restored
  // no visibility, since nothing was open), rehydration finds zero survivors and
  // must SETTLE, and the subsequent user-open then cold-start-seeds exactly one.
  // If rehydration never settled (or settled only on the survivors>0 branch), the
  // gated open/launch effect would stay blocked and the open would seed nothing.
  function dockUi(bridge: OkDesktopBridge, visible: boolean) {
    return <ReloadHarness bridge={bridge} visible={visible} />;
  }

  test('zero survivors settles so a later open still cold-starts exactly one tab', async () => {
    const { bridge, listLive } = makeSurvivingMainBridge([]);
    const { rerender } = render(dockUi(bridge, false));
    // Rehydration ran and found nothing; flush its async settle.
    await waitFor(() => expect(listLive).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);
    // The user opens the dock: the gated cold-start path was released by the
    // settle, so this seeds exactly one fresh session.
    rerender(dockUi(bridge, true));
    await waitFor(() => expect(screen.getAllByTestId('terminal-session')).toHaveLength(1), {
      timeout: 2000,
    });
  });

  test('a rejecting list() still settles so a later open cold-starts (no hang on IPC error)', async () => {
    const listLive = mock(async () => {
      throw new Error('ipc boom');
    });
    const bridge = {
      onMenuAction: () => () => {},
      editor: { notifyViewMenuStateChanged: () => {} },
      terminal: {
        create: mock(async () => ({ ok: true as const, ptyId: 'fresh-pty-1' })),
        kill: mock(async (_id: string) => {}),
        list: listLive,
        listSessions: listLive,
        getSessions: listLive,
        snapshotSessions: listLive,
        restoreSessions: listLive,
      },
    } as unknown as OkDesktopBridge;
    const { rerender } = render(dockUi(bridge, false));
    await waitFor(() => expect(listLive).toHaveBeenCalled());
    await act(async () => {});
    rerender(dockUi(bridge, true));
    // If settling had moved inside the try, the rejection would leave the gate
    // closed forever and this open would seed nothing.
    await waitFor(() => expect(screen.getAllByTestId('terminal-session')).toHaveLength(1), {
      timeout: 2000,
    });
  });

  test('an Ask-AI selection reuses a reload-rehydrated (adopted) session via a direct PTY write', async () => {
    const { bridge, create, input } = makeSurvivingMainBridge([{ ptyId: 'pty-1' }]);
    render(dockUi(bridge, true));

    // Rehydration recovers exactly one adopted tab, which reports its adopted PTY
    // id up (the stub mirrors the real attachSession → onPtyId path).
    await waitFor(() => expect(screen.getAllByTestId('terminal-session')).toHaveLength(1), {
      timeout: 2000,
    });
    await act(async () => {}); // flush the onPtyId report into the host's reuse map

    // The selection-bubble "Ask AI" fires while the recovered survivor is the
    // active tab. Reuse is the selection-input path (verbatim text into the live
    // shell), NOT a launch nonce — launches always open their own tab now.
    await act(async () => {
      requestActiveTerminalInput('explain');
    });

    // Reused, not respawned: the raw selection text is written straight into the
    // adopted PTY (`pty-1`) — no `<bin> '<prompt>'` command wrapping, no new tab,
    // no fresh create(). Covers reuse for reload survivors.
    await waitFor(() => expect(input).toHaveBeenCalledWith('pty-1', 'explain'));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
  });
});
