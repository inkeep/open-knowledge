
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  ClaudeReadiness,
  OkDesktopBridge,
  OkPtyData,
  OkPtyExit,
} from '@/lib/desktop-bridge-types';

class MockFitAddon {
  fit = mock(() => {});
  constructor() {
    lastFit = this;
  }
}
class MockWebglAddon {}
class MockWebLinksAddon {}
class MockUnicode11Addon {}

class MockTerminal {
  cols = 80;
  rows = 24;
  unicode = { activeVersion: '6' };
  modes = { mouseTrackingMode: 'none' as string };
  mouseEncoding = 'SGR' as string;
  get _core() {
    return {
      coreMouseService: { activeEncoding: this.mouseEncoding },
      _renderService: { dimensions: { css: { cell: { height: 17 } } } },
    };
  }
  onDataCb: ((d: string) => void) | null = null;
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  wheelHandler: ((e: WheelEvent) => boolean) | null = null;
  options: Record<string, unknown>;
  open = mock(() => {});
  focus = mock(() => {});
  dispose = mock(() => {});
  write = mock((_data: string, cb?: () => void) => {
    cb?.();
  });
  loadAddon = mock((addon: unknown) => {
    if (webglThrows && addon instanceof MockWebglAddon) throw new Error('no webgl2 context');
  });
  onData = mock((cb: (d: string) => void) => {
    this.onDataCb = cb;
    return { dispose() {} };
  });
  onTitleChangeCb: ((title: string) => void) | null = null;
  onTitleChange = mock((cb: (title: string) => void) => {
    this.onTitleChangeCb = cb;
    return { dispose() {} };
  });
  attachCustomKeyEventHandler = mock((h: (e: KeyboardEvent) => boolean) => {
    this.keyHandler = h;
  });
  attachCustomWheelEventHandler = mock((h: (e: WheelEvent) => boolean) => {
    this.wheelHandler = h;
  });
  constructor(options: Record<string, unknown>) {
    this.options = options;
    lastTerm = this;
  }
}

let lastTerm: MockTerminal | null = null;
let lastFit: MockFitAddon | null = null;
let webglThrows = false;
let mockResolvedTheme: string | undefined = 'dark';

let roCallback: (() => void) | null = null;
let lastRO: MockResizeObserver | null = null;
class MockResizeObserver {
  observe = mock(() => {});
  unobserve = mock(() => {});
  disconnect = mock(() => {});
  constructor(cb: () => void) {
    roCallback = cb;
    lastRO = this;
  }
}

mock.module('@xterm/xterm', () => ({ Terminal: MockTerminal }));
mock.module('@xterm/addon-fit', () => ({ FitAddon: MockFitAddon }));
mock.module('@xterm/addon-webgl', () => ({ WebglAddon: MockWebglAddon }));
mock.module('@xterm/addon-web-links', () => ({ WebLinksAddon: MockWebLinksAddon }));
mock.module('@xterm/addon-unicode11', () => ({ Unicode11Addon: MockUnicode11Addon }));
mock.module('@xterm/xterm/css/xterm.css', () => ({}));
mock.module('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: mockResolvedTheme }),
}));

type CreateResult =
  | { ok: true; ptyId: string }
  | { ok: false; reason: 'no-project' | 'not-consented' };

const WIRED: ClaudeReadiness = { claude: 'present', mcp: 'wired' };

function makeBridge(createResult: CreateResult, preflight: ClaudeReadiness = WIRED) {
  const dataSubs: Array<(m: OkPtyData) => void> = [];
  const exitSubs: Array<(m: OkPtyExit) => void> = [];
  const unsubData = mock(() => {});
  const unsubExit = mock(() => {});
  const openExternal = mock(async (_url: string) => {});
  const rewireClaudeMcp = mock(async () => preflight);
  const terminal = {
    create: mock(async () => createResult),
    input: mock((_id: string, _d: string) => {}),
    resize: mock((_id: string, _c: number, _r: number) => {}),
    kill: mock(async (_id: string) => {}),
    drain: mock((_id: string, _bytes: number) => {}),
    onData: mock((cb: (m: OkPtyData) => void) => {
      dataSubs.push(cb);
      return unsubData;
    }),
    onExit: mock((cb: (m: OkPtyExit) => void) => {
      exitSubs.push(cb);
      return unsubExit;
    }),
    claudePreflight: mock(async () => preflight),
    cliPreflight: mock(async () => ({ onPath: 'present' as const })),
    rewireClaudeMcp,
  };
  return {
    bridge: {
      terminal,
      shell: { openExternal },
      config: { e2eSmoke: false },
    } as unknown as OkDesktopBridge,
    terminal,
    openExternal,
    rewireClaudeMcp,
    unsubData,
    unsubExit,
    pushData: (m: OkPtyData) => {
      for (const f of dataSubs) f(m);
    },
    pushExit: (m: OkPtyExit) => {
      for (const f of exitSubs) f(m);
    },
  };
}

const { TerminalPanel } = await import('./TerminalPanel');
const { XTERM_DARK_THEME, XTERM_LIGHT_THEME } = await import('./terminal-theme');

describe('TerminalPanel', () => {
  beforeEach(() => {
    lastTerm = null;
    lastFit = null;
    lastRO = null;
    roCallback = null;
    webglThrows = false;
    mockResolvedTheme = 'dark';
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
  });
  afterEach(() => {
    cleanup();
  });

  test('mounts an accessible region, configures xterm for a11y, and creates a PTY sized to the fitted terminal', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);

    const region = screen.getByRole('region', { name: 'Terminal' });
    expect(region).toBeTruthy();

    expect(lastTerm?.options.screenReaderMode).toBe(true);
    expect(lastTerm?.options.minimumContrastRatio).toBe(4.5);
    expect(lastTerm?.unicode.activeVersion).toBe('11');
    expect(lastTerm?.options.scrollback).toBe(10000);
    expect(lastTerm?.options.smoothScrollDuration).toBe(125);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(terminal.create).toHaveBeenCalledWith({ cols: 80, rows: 24 });
  });

  test('forwards xterm OSC 0/2 title changes to onTitleChange', async () => {
    const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
    const onTitleChange = mock((_title: string) => {});
    render(<TerminalPanel bridge={bridge} onTitleChange={onTitleChange} />);

    await waitFor(() => expect(lastTerm?.onTitleChangeCb).toBeTruthy());

    act(() => lastTerm?.onTitleChangeCb?.('claude — repo'));
    expect(onTitleChange).toHaveBeenCalledWith('claude — repo');

    act(() => lastTerm?.onTitleChangeCb?.('claude — done'));
    expect(onTitleChange).toHaveBeenLastCalledWith('claude — done');
  });

  test('disposes the title listener on unmount', async () => {
    const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
    const onTitleChange = mock((_title: string) => {});
    const { unmount } = render(<TerminalPanel bridge={bridge} onTitleChange={onTitleChange} />);
    await waitFor(() => expect(lastTerm?.onTitleChangeCb).toBeTruthy());

    unmount();
    onTitleChange.mockClear();
    act(() => lastTerm?.onTitleChangeCb?.('late'));
    expect(onTitleChange).not.toHaveBeenCalled();
  });

  test('writes shell output to the terminal and drains the consumed code-unit count for backpressure', async () => {
    const { bridge, terminal, pushData } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));

    const payload = 'hi🎉';
    expect(payload.length).toBe(4);
    act(() => pushData({ ptyId: 'pty-1', data: payload }));

    expect(lastTerm?.write).toHaveBeenCalledTimes(1);
    expect(lastTerm?.write.mock.calls[0]?.[0]).toBe(payload);
    expect(terminal.drain).toHaveBeenCalledWith('pty-1', payload.length);
  });

  test('forwards user keystrokes to the PTY via input', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());

    act(() => lastTerm?.onDataCb?.('ls\r'));
    expect(terminal.input).toHaveBeenCalledWith('pty-1', 'ls\r');
  });

  test('re-fits and resizes the PTY when the container resizes', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(roCallback).toBeTruthy());

    const fitsBefore = lastFit?.fit.mock.calls.length ?? 0;
    act(() => roCallback?.());

    expect(lastFit?.fit.mock.calls.length ?? 0).toBeGreaterThan(fitsBefore);
    expect(terminal.resize).toHaveBeenCalledWith('pty-1', 80, 24);
  });

  test('cancels the browser default for Shift+Tab only; every other key (incl. Escape) reaches the PTY', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());

    expect(lastTerm?.attachCustomKeyEventHandler).toHaveBeenCalledTimes(1);
    const handler = lastTerm?.keyHandler;
    expect(handler).toBeTruthy();

    const shiftTabPreventDefault = mock(() => {});
    const shiftTab = {
      type: 'keydown',
      key: 'Tab',
      shiftKey: true,
      preventDefault: shiftTabPreventDefault,
    } as unknown as KeyboardEvent;
    expect(handler?.(shiftTab)).toBe(true);
    expect(shiftTabPreventDefault).toHaveBeenCalledTimes(1);

    const plainTabPreventDefault = mock(() => {});
    const plainTab = {
      type: 'keydown',
      key: 'Tab',
      shiftKey: false,
      preventDefault: plainTabPreventDefault,
    } as unknown as KeyboardEvent;
    expect(handler?.(plainTab)).toBe(true);
    expect(plainTabPreventDefault).not.toHaveBeenCalled();

    const escapePreventDefault = mock(() => {});
    const escapeKey = {
      type: 'keydown',
      key: 'Escape',
      shiftKey: false,
      preventDefault: escapePreventDefault,
    } as unknown as KeyboardEvent;
    expect(handler?.(escapeKey)).toBe(true);
    expect(escapePreventDefault).not.toHaveBeenCalled();

    act(() => lastTerm?.onDataCb?.('\x1b'));
    expect(terminal.input).toHaveBeenCalledWith('pty-1', '\x1b');
  });

  test('Shift+Enter sends a newline (LF) to the PTY instead of submitting (CR)', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());
    const handler = lastTerm?.keyHandler;
    expect(handler).toBeTruthy();

    const shiftEnterPreventDefault = mock(() => {});
    const shiftEnter = {
      type: 'keydown',
      key: 'Enter',
      shiftKey: true,
      preventDefault: shiftEnterPreventDefault,
    } as unknown as KeyboardEvent;
    expect(handler?.(shiftEnter)).toBe(false);
    expect(shiftEnterPreventDefault).toHaveBeenCalledTimes(1);
    expect(terminal.input).toHaveBeenCalledWith('pty-1', '\n');

    const plainEnterPreventDefault = mock(() => {});
    const plainEnter = {
      type: 'keydown',
      key: 'Enter',
      shiftKey: false,
      preventDefault: plainEnterPreventDefault,
    } as unknown as KeyboardEvent;
    expect(handler?.(plainEnter)).toBe(true);
    expect(plainEnterPreventDefault).not.toHaveBeenCalled();
  });

  test('wheel handler defers to xterm in normal scrollback, drives the PTY in mouse mode', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.wheelHandler).toBeTruthy());
    const term = lastTerm;
    if (term?.wheelHandler == null) throw new Error('wheel handler not attached');
    const wheel = term.wheelHandler;

    term.modes.mouseTrackingMode = 'none';
    expect(wheel({ deltaY: 120, deltaMode: 0 } as unknown as WheelEvent)).toBe(true);
    expect(terminal.input).not.toHaveBeenCalled();

    term.modes.mouseTrackingMode = 'any';
    term.mouseEncoding = 'DEFAULT';
    expect(wheel({ deltaY: 120, deltaMode: 0 } as unknown as WheelEvent)).toBe(true);
    expect(terminal.input).not.toHaveBeenCalled();

    term.mouseEncoding = 'SGR';
    expect(wheel({ deltaY: 120, deltaMode: 0 } as unknown as WheelEvent)).toBe(false);
    expect(terminal.input).toHaveBeenCalledTimes(1);
    const [ptyId, payload] = terminal.input.mock.calls[0] as [string, string];
    expect(ptyId).toBe('pty-1');
    const downTick = '\x1b[<65;1;1M';
    expect(payload.length).toBeGreaterThan(0);
    expect(payload.length % downTick.length).toBe(0);
    expect(payload.replaceAll(downTick, '')).toBe('');

    terminal.input.mockClear();
    term.mouseEncoding = 'SGR_PIXELS';
    expect(wheel({ deltaY: 120, deltaMode: 0 } as unknown as WheelEvent)).toBe(false);
    expect(terminal.input).toHaveBeenCalledTimes(1);
  });

  test('mode transition resets the wheel accumulator (no stale carry across apps)', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.wheelHandler).toBeTruthy());
    const term = lastTerm;
    if (term?.wheelHandler == null) throw new Error('wheel handler not attached');
    const wheel = term.wheelHandler;
    term.mouseEncoding = 'SGR';

    term.modes.mouseTrackingMode = 'any';
    expect(wheel({ deltaY: 30, deltaMode: 0 } as unknown as WheelEvent)).toBe(false);
    expect(terminal.input).toHaveBeenCalledTimes(1);

    term.modes.mouseTrackingMode = 'none';
    expect(wheel({ deltaY: 5, deltaMode: 0 } as unknown as WheelEvent)).toBe(true);

    term.modes.mouseTrackingMode = 'any';
    terminal.input.mockClear();
    expect(wheel({ deltaY: 10, deltaMode: 0 } as unknown as WheelEvent)).toBe(false);
    expect(terminal.input).not.toHaveBeenCalled();
  });

  test('disposes the terminal, kills the PTY, and unsubscribes on unmount', async () => {
    const { bridge, terminal, unsubData, unsubExit } = makeBridge({ ok: true, ptyId: 'pty-1' });
    const { unmount } = render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(roCallback).toBeTruthy());

    const term = lastTerm;
    const ro = lastRO;
    act(() => unmount());

    expect(term?.dispose).toHaveBeenCalledTimes(1);
    expect(terminal.kill).toHaveBeenCalledWith('pty-1');
    expect(unsubData).toHaveBeenCalledTimes(1);
    expect(unsubExit).toHaveBeenCalledTimes(1);
    expect(ro?.disconnect).toHaveBeenCalledTimes(1);
  });

  test('degrades to the DOM renderer when WebGL is unavailable instead of failing the mount', async () => {
    webglThrows = true;
    const { bridge, terminal, pushData } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: 'ok' }));
    expect(lastTerm?.write).toHaveBeenCalledTimes(1);
  });

  test('ignores data addressed to a different PTY', async () => {
    const { bridge, terminal, pushData } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));

    act(() => pushData({ ptyId: 'someone-else', data: 'leak' }));
    expect(lastTerm?.write).not.toHaveBeenCalled();
    expect(terminal.drain).not.toHaveBeenCalled();

    act(() => pushData({ ptyId: 'pty-1', data: 'mine' }));
    expect(lastTerm?.write).toHaveBeenCalledTimes(1);
    expect(lastTerm?.write.mock.calls[0]?.[0]).toBe('mine');
  });

  test('reports the no-project state and wires no data stream when the window has no project', async () => {
    const { bridge, terminal } = makeBridge({ ok: false, reason: 'no-project' });
    render(<TerminalPanel bridge={bridge} />);

    await waitFor(() =>
      expect(document.querySelector('[data-terminal-status="no-project"]')).not.toBeNull(),
    );
    expect(terminal.onData).not.toHaveBeenCalled();
    expect(terminal.drain).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Terminal' })).toBeTruthy();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/no project folder/i);
    expect(lastTerm?.focus).not.toHaveBeenCalled();
  });

  test('renders a refusal notice (not a blank canvas) when main refuses with not-consented', async () => {
    const onClose = mock(() => {});
    const { bridge, terminal } = makeBridge({ ok: false, reason: 'not-consented' });
    render(<TerminalPanel bridge={bridge} onClose={onClose} />);

    await waitFor(() =>
      expect(document.querySelector('[data-terminal-status="not-consented"]')).not.toBeNull(),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/isn't enabled for this project/i);
    expect(lastTerm?.focus).not.toHaveBeenCalled();
    expect(terminal.onData).not.toHaveBeenCalled();
    const closeButton = screen.getByRole('button', { name: 'Close terminal' });
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('omits the "Close terminal" button when no onClose is provided', async () => {
    const { bridge } = makeBridge({ ok: false, reason: 'not-consented' });
    render(<TerminalPanel bridge={bridge} />);

    await waitFor(() =>
      expect(document.querySelector('[data-terminal-status="not-consented"]')).not.toBeNull(),
    );
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Close terminal' })).toBeNull();
  });

  test('reaps a PTY that finishes spawning after the panel has already unmounted', async () => {
    let resolveCreate: ((r: CreateResult) => void) | undefined;
    const createPromise = new Promise<CreateResult>((res) => {
      resolveCreate = res;
    });
    const kill = mock(async (_id: string) => {});
    const terminal = {
      create: mock(() => createPromise),
      input: mock(() => {}),
      resize: mock(() => {}),
      kill,
      drain: mock(() => {}),
      onData: mock(() => mock(() => {})),
      onExit: mock(() => mock(() => {})),
    };
    const bridge = { terminal, config: { e2eSmoke: false } } as unknown as OkDesktopBridge;

    const { unmount } = render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));

    act(() => unmount());
    await act(async () => {
      resolveCreate?.({ ok: true, ptyId: 'pty-late' });
      await createPromise;
    });

    expect(kill).toHaveBeenCalledWith('pty-late');
    expect(terminal.onData).not.toHaveBeenCalled();
  });

  test('probes Claude readiness once the shell is live and shows a help affordance when claude is not on PATH', async () => {
    const { bridge, terminal, openExternal } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      { claude: 'not-found', mcp: 'needs-rewire' },
    );
    render(<TerminalPanel bridge={bridge} />);

    await waitFor(() => expect(terminal.claudePreflight).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/isn't installed or on your PATH/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Get Claude Code' }));
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal.mock.calls[0]?.[0]).toContain('claude-code');
  });

  test('shows a re-wire affordance when claude is present but OK tools are not wired', async () => {
    const { bridge, rewireClaudeMcp } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      { claude: 'present', mcp: 'needs-rewire' },
    );
    render(<TerminalPanel bridge={bridge} />);

    expect(await screen.findByText(/aren't connected to it yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect tools' }));
    expect(rewireClaudeMcp).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  test('shows no readiness banner when claude is present and OK tools are wired', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' }, WIRED);
    render(<TerminalPanel bridge={bridge} />);

    await waitFor(() => expect(terminal.claudePreflight).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('the readiness banner is dismissible', async () => {
    const { bridge } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      { claude: 'not-found', mcp: 'needs-rewire' },
    );
    render(<TerminalPanel bridge={bridge} />);

    await screen.findByText(/isn't installed or on your PATH/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText(/isn't installed or on your PATH/)).toBeNull());
  });

  test('surfaces a restartable error state when create() rejects (startup failure, no silent dead-end)', async () => {
    let resolveCreate: (() => void) | undefined;
    let createCalls = 0;
    const createGate = new Promise<void>((res) => {
      resolveCreate = res;
    });
    const terminal = {
      create: mock(async () => {
        createCalls += 1;
        if (createCalls === 1) throw new Error('fork EMFILE');
        await createGate;
        return { ok: true, ptyId: 'pty-restarted' } as const;
      }),
      input: mock(() => {}),
      resize: mock(() => {}),
      kill: mock(async () => {}),
      drain: mock(() => {}),
      onData: mock(() => mock(() => {})),
      onExit: mock(() => mock(() => {})),
      claudePreflight: mock(async () => WIRED),
      cliPreflight: mock(async () => ({ onPath: 'present' as const })),
      rewireClaudeMcp: mock(async () => WIRED),
    };
    const bridge = {
      terminal,
      shell: { openExternal: mock(async () => {}) },
      config: { e2eSmoke: false },
    } as unknown as OkDesktopBridge;

    render(<TerminalPanel bridge={bridge} />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    const restart = screen.getByRole('button', { name: 'Restart terminal' });

    fireEvent.click(restart);
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveCreate?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  test('renders a visible exit state with a restart affordance when the shell exits', async () => {
    const { bridge, terminal, pushExit } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(terminal.onExit).toHaveBeenCalledTimes(1));

    act(() => pushExit({ ptyId: 'pty-1', exitCode: 1, signal: null }));

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/exit code 1/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart terminal' })).toBeTruthy();
  });

  test('Restart spawns a fresh PTY in the same window and clears the exit state', async () => {
    const { bridge, terminal, pushExit } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));

    act(() => pushExit({ ptyId: 'pty-1', exitCode: 0, signal: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart terminal' }));

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  test('hides the Claude readiness banner once the shell has exited', async () => {
    const { bridge, pushExit } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      { claude: 'not-found', mcp: 'needs-rewire' },
    );
    render(<TerminalPanel bridge={bridge} />);

    await screen.findByText(/isn't installed or on your PATH/);

    act(() => pushExit({ ptyId: 'pty-1', exitCode: 0, signal: null }));
    await waitFor(() => expect(screen.queryByText(/isn't installed or on your PATH/)).toBeNull());
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  test('constructs xterm with the palette for the resolved app theme', async () => {
    mockResolvedTheme = 'light';
    const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm).not.toBeNull());
    expect(lastTerm?.options.theme).toBe(XTERM_LIGHT_THEME);

    cleanup();
    lastTerm = null;
    mockResolvedTheme = 'dark';
    const second = makeBridge({ ok: true, ptyId: 'pty-2' });
    render(<TerminalPanel bridge={second.bridge} />);
    await waitFor(() => expect(lastTerm).not.toBeNull());
    expect(lastTerm?.options.theme).toBe(XTERM_DARK_THEME);
  });

  test('re-skins the live terminal on a theme switch without respawning the PTY', async () => {
    mockResolvedTheme = 'dark';
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    const { rerender } = render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));

    const term = lastTerm;
    expect(term?.options.theme).toBe(XTERM_DARK_THEME);

    mockResolvedTheme = 'light';
    rerender(<TerminalPanel bridge={bridge} />);

    await waitFor(() => expect(lastTerm?.options.theme).toBe(XTERM_LIGHT_THEME));
    expect(lastTerm).toBe(term);
    expect(term?.dispose).not.toHaveBeenCalled();
    expect(terminal.create).toHaveBeenCalledTimes(1);
    expect(terminal.kill).not.toHaveBeenCalled();
  });

  test('restarting one session spawns a fresh PTY for it without disturbing a sibling', async () => {
    const exitSubs: Array<(m: OkPtyExit) => void> = [];
    let created = 0;
    const create = mock(async () => {
      created += 1;
      return { ok: true as const, ptyId: `pty-${created}` };
    });
    const kill = mock(async (_id: string) => {});
    const terminal = {
      create,
      input: mock(() => {}),
      resize: mock(() => {}),
      kill,
      drain: mock(() => {}),
      onData: mock(() => mock(() => {})),
      onExit: mock((cb: (m: OkPtyExit) => void) => {
        exitSubs.push(cb);
        return mock(() => {});
      }),
      claudePreflight: mock(async () => WIRED),
      rewireClaudeMcp: mock(async () => WIRED),
    };
    const bridge = {
      terminal,
      shell: { openExternal: mock(async () => {}) },
      config: { e2eSmoke: false },
    } as unknown as OkDesktopBridge;
    const pushExit = (m: OkPtyExit) => {
      for (const f of exitSubs) f(m);
    };

    render(
      <>
        <TerminalPanel bridge={bridge} />
        <TerminalPanel bridge={bridge} />
      </>,
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));

    act(() => pushExit({ ptyId: 'pty-1', exitCode: 1, signal: null }));
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Restart terminal' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3));

    expect(kill).not.toHaveBeenCalledWith('pty-2');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
