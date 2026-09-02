import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useEffect, useRef, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { requestActiveTerminalInput } from './handoff/terminal-input-events';
import { subscribeToTerminalLaunchRequests } from './handoff/terminal-launch-events';

const TERMINAL_PANEL_ID = 'terminal-dock-panel';

// biome-ignore lint/suspicious/noExplicitAny: captured mock-component props
let terminalPanelProps: Record<string, any> | null = null;
const panelHandle = {
  collapse: vi.fn(() => terminalPanelProps?.onResize?.({ asPercentage: 0, inPixels: 0 })),
  expand: vi.fn(() => terminalPanelProps?.onResize?.({ asPercentage: 40, inPixels: 240 })),
  resize: vi.fn(() => {}),
};
const sharedPanelRef: { current: unknown } = { current: panelHandle };

vi.doMock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

vi.doMock('react-resizable-panels', () => ({ usePanelRef: () => sharedPanelRef }));
vi.doMock('@/components/ui/resizable', () => ({
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

vi.doMock('./TerminalGate', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  TerminalGate: ({ adoptPtyId, onPtyId }: any) => {
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

vi.doMock('@/lib/terminal-height-store', () => ({
  getInitialTerminalHeight: () => 240,
  writeTerminalHeight: () => {},
}));

const { TerminalDock } = await import('./TerminalDock');
const { SessionsHost } = await import('./SessionsHost');

function ReloadHarness({
  bridge,
  visible,
  terminalRestoreRevealNonce = 0,
  launch = null,
}: {
  bridge: OkDesktopBridge;
  visible: boolean;
  terminalRestoreRevealNonce?: number;
  launch?: { prompt: string; cli: string; nonce: number } | null;
}) {
  const [bottomContainer, setBottomContainer] = useState<HTMLDivElement | null>(null);
  return (
    <TooltipProvider>
      <TerminalDock
        visible={visible}
        onVisibleChange={() => {}}
        onBottomContainer={setBottomContainer}
        onEditorRegion={() => {}}
      >
        <div data-testid="editor-child" />
      </TerminalDock>
      <SessionsHost
        surface="terminal-dock"
        bridge={bridge}
        terminalCapable
        visible={visible}
        terminalRestoreRevealNonce={terminalRestoreRevealNonce}
        onVisibleChange={() => {}}
        // biome-ignore lint/suspicious/noExplicitAny: test launch shape
        launch={launch as any}
        container={bottomContainer}
        isShowing={visible && bottomContainer != null}
        onRequestEditorFocus={() => {}}
      />
    </TooltipProvider>
  );
}

function makeSurvivingMainBridge(
  preExisting: ReadonlyArray<{
    ptyId: string;
    customLabel?: string | null;
    ordinal?: number | null;
  }>,
) {
  let freshCounter = 0;
  const create = vi.fn(async () => {
    freshCounter += 1;
    return { ok: true as const, ptyId: `fresh-pty-${freshCounter}` };
  });
  const kill = vi.fn(async (_id: string) => {});
  const input = vi.fn((_id: string, _d: string) => {});
  const listLive = vi.fn(async () => preExisting);
  const setMeta = vi.fn((_ptyId: string, _meta: unknown) => {});
  const setOrder = vi.fn((_ids: readonly string[]) => {});
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
    const { bridge } = makeSurvivingMainBridge([{ ptyId: 'pty-1' }, { ptyId: 'pty-2' }]);

    renderDock(bridge, true);

    await waitFor(() => expect(screen.getAllByTestId('terminal-session')).toHaveLength(2), {
      timeout: 2000,
    });

    expect(document.querySelectorAll('[data-terminal-session][data-state="active"]')).toHaveLength(
      1,
    );
  });

  test("restores each survivor's custom name and the reordered tab order across reload", async () => {
    const { bridge } = makeSurvivingMainBridge([
      { ptyId: 'pty-3', customLabel: 'deploy', ordinal: 3 },
      { ptyId: 'pty-1', customLabel: null, ordinal: 1 },
      { ptyId: 'pty-2', customLabel: 'logs', ordinal: 2 },
    ]);

    renderDock(bridge, true);

    await waitFor(() => expect(screen.getAllByTestId('terminal-session')).toHaveLength(3), {
      timeout: 2000,
    });

    const tablist = screen.getByRole('tablist', { name: 'Terminal sessions' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['deploy', 'Terminal 1', 'logs']);
  });

  test('a rejected dock-state read preserves main survivor order and settles rehydration', async () => {
    const { bridge } = makeSurvivingMainBridge([
      { ptyId: 'pty-3', customLabel: 'deploy', ordinal: 3 },
      { ptyId: 'pty-1', customLabel: null, ordinal: 1 },
      { ptyId: 'pty-2', customLabel: 'logs', ordinal: 2 },
    ]);
    bridge.terminal.getDockState = vi.fn(async () => {
      throw new Error('ipc torn down mid-reload');
    });

    renderDock(bridge, true);

    await waitFor(() => expect(screen.getAllByTestId('terminal-session')).toHaveLength(3), {
      timeout: 2000,
    });
    const tabs = within(screen.getByRole('tablist', { name: 'Terminal sessions' })).getAllByRole(
      'tab',
    );
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

    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 1' }));
    const input = screen.getByRole('textbox', { name: /^Rename/ });
    await user.clear(input);
    await user.type(input, 'deploy');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(setMeta).toHaveBeenCalledWith('pty-1', { customLabel: 'deploy' }));
  });

  function dockUi(bridge: OkDesktopBridge, visible: boolean) {
    return <ReloadHarness bridge={bridge} visible={visible} />;
  }

  test('zero survivors settles so a later open still cold-starts exactly one tab', async () => {
    const { bridge, listLive } = makeSurvivingMainBridge([]);
    const { rerender } = render(dockUi(bridge, false));
    await waitFor(() => expect(listLive).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);
    rerender(dockUi(bridge, true));
    await waitFor(() => expect(screen.getAllByTestId('terminal-session')).toHaveLength(1), {
      timeout: 2000,
    });
  });

  test('a rejecting list() still settles so a later open cold-starts (no hang on IPC error)', async () => {
    const listLive = vi.fn(async () => {
      throw new Error('ipc boom');
    });
    const bridge = {
      onMenuAction: () => () => {},
      editor: { notifyViewMenuStateChanged: () => {} },
      terminal: {
        create: vi.fn(async () => ({ ok: true as const, ptyId: 'fresh-pty-1' })),
        kill: vi.fn(async (_id: string) => {}),
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
    await waitFor(() => expect(screen.getAllByTestId('terminal-session')).toHaveLength(1), {
      timeout: 2000,
    });
  });

  test('a rejecting list() never treats a restart snapshot as proof that no PTY survived', async () => {
    const create = vi.fn(async () => ({ ok: true as const, ptyId: 'duplicate-pty' }));
    const bridge = {
      onMenuAction: () => () => {},
      editor: { notifyViewMenuStateChanged: () => {} },
      terminal: {
        create,
        kill: vi.fn(async (_id: string) => {}),
        list: vi.fn(async () => {
          throw new Error('inventory transport failed');
        }),
        getDockState: vi.fn(async () => ({
          terminalVisible: true,
          agentPanelVisible: false,
          terminalSnapshot: {
            tabs: [{ ordinal: 1, customLabel: 'survivor' }],
            activeOrdinal: 1,
          },
        })),
      },
    } as unknown as OkDesktopBridge;

    const { rerender } = render(
      <ReloadHarness bridge={bridge} visible={false} terminalRestoreRevealNonce={0} />,
    );
    await waitFor(() => expect(bridge.terminal.list).toHaveBeenCalled());
    await act(async () => {});
    rerender(<ReloadHarness bridge={bridge} visible terminalRestoreRevealNonce={1} />);
    await act(async () => {});

    expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });

  test('an Ask-AI selection does NOT raw-write into a reload survivor (unknown shell type)', async () => {
    const { bridge, create, input } = makeSurvivingMainBridge([{ ptyId: 'pty-1' }]);
    const launchRequests: Array<{ text: string; cli: string; stage: boolean }> = [];
    const stopLaunch = subscribeToTerminalLaunchRequests((text, cli, opts) =>
      launchRequests.push({ text, cli, stage: opts.stage }),
    );
    render(dockUi(bridge, true));

    await waitFor(() => expect(screen.getAllByTestId('terminal-session')).toHaveLength(1), {
      timeout: 2000,
    });
    await act(async () => {});

    await act(async () => {
      requestActiveTerminalInput('explain');
    });
    stopLaunch();

    expect(input).not.toHaveBeenCalled();
    expect(launchRequests).toEqual([{ text: 'explain', cli: 'claude', stage: true }]);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
  });
});
