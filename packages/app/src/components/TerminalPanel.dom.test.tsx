/**
 * Behavioral tests for TerminalPanel's bridge wiring + a11y.
 *
 * xterm (`@xterm/*`) and the desktop terminal bridge are mocked at the module
 * boundary (both are system boundaries the component talks to). The assertions
 * pin the component's orchestration — PTY sizing, output→write→drain
 * backpressure, keystroke→input, resize→fit→resize, Escape-reaches-the-PTY
 * (no key interception), dispose+kill teardown, WebGL degrade, and ptyId
 * addressing — through its public surface, not xterm internals. Real xterm
 * rendering + a real PTY are the browser/packaged rung.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  ClaudeReadiness,
  OkDesktopBridge,
  OkPtyData,
  OkPtyExit,
} from '@/lib/desktop-bridge-types';

// --- xterm mocks (3rd-party system boundary) ---
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
  // Mouse-tracking mode the wheel handler reads; default 'none' = normal
  // scrollback (handler defers to xterm). Tests flip this to exercise the
  // mouse-mode wheel path.
  modes = { mouseTrackingMode: 'none' as string };
  // Active mouse encoding the handler gates on ('SGR'/'SGR_PIXELS' = take over;
  // 'DEFAULT' X10 = defer to xterm). Exposed via the `_core` getter below to
  // mirror xterm's internal shape the production handler reads.
  mouseEncoding = 'SGR' as string;
  get _core() {
    return {
      coreMouseService: { activeEncoding: this.mouseEncoding },
      _renderService: { dimensions: { css: { cell: { width: 10, height: 17 } } } },
    };
  }
  // The wheel handler reads `term.element` to hit-test the pointer's cell for
  // SGR report coordinates. Left undefined by default (mock `open` builds no
  // DOM) → the handler's viewport-center fallback; the pointer-mapping test
  // assigns a real element.
  element: HTMLElement | undefined = undefined;
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
  // Captures the OSC 0/2 title listener; firing onTitleChangeCb mimics the PTY
  // program setting the window title. Returns a disposable like real xterm.
  onTitleChangeCb: ((title: string) => void) | null = null;
  onTitleChange = mock((cb: (title: string) => void) => {
    this.onTitleChangeCb = cb;
    return { dispose() {} };
  });
  // Captures the custom key handler the panel attaches. Production attaches one
  // handler that patches two Shift chords — Shift+Tab (cancel the browser
  // default so it reaches the PTY instead of escaping focus) and Shift+Enter
  // (send LF instead of xterm's default CR so the CLI inserts a newline). Every
  // other key returns true, so xterm processes it and Escape reaches the PTY.
  attachCustomKeyEventHandler = mock((h: (e: KeyboardEvent) => boolean) => {
    this.keyHandler = h;
  });
  // Production attaches a wheel handler that, in mouse-tracking mode, replaces
  // xterm's flooding one-report-per-event behavior with an accumulated,
  // frequency-independent stream (see terminal-wheel.ts).
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
// Drives the mocked next-themes `resolvedTheme`; mutate + rerender to exercise
// a live light/dark switch.
let mockResolvedTheme: string | undefined = 'dark';

// Capturing ResizeObserver — the jsdom preload installs a no-op one whose
// callback never fires, so override it to drive the resize path explicitly.
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

function makeBridge(
  createResult: CreateResult,
  preflight: ClaudeReadiness = WIRED,
  adopt: (
    id: string,
  ) => Promise<{ ok: true; replay?: string } | { ok: false; reason: string }> = async () => ({
    ok: true,
    replay: '',
  }),
) {
  const dataSubs: Array<(m: OkPtyData) => void> = [];
  const exitSubs: Array<(m: OkPtyExit) => void> = [];
  const unsubData = mock(() => {});
  const unsubExit = mock(() => {});
  const openExternal = mock(async (_url: string) => {});
  const rewireClaudeMcp = mock(async () => preflight);
  const terminal = {
    create: mock(async () => createResult),
    adopt: mock(adopt),
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
      // Stand in for Electron `webUtils.getPathForFile`: a dropped File resolves
      // to a deterministic on-disk path so the drop→input wiring is assertable.
      getPathForFile: (file: File) => `/dropped/${file.name}`,
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
    // Deep per-session history so switching away and back keeps a useful
    // scrollback, rather than xterm's 1000-line default.
    expect(lastTerm?.options.scrollback).toBe(10000);
    // Smooth scrolling on: xterm's default of 0 applies wheel/trackpad scroll as
    // instant whole-line jumps, which reads as choppy under trackpad momentum.
    expect(lastTerm?.options.smoothScrollDuration).toBe(125);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(terminal.create).toHaveBeenCalledWith({ cols: 80, rows: 24 });
  });

  test('reload rehydration: adopts a surviving session instead of spawning a fresh one', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-fresh' });
    render(<TerminalPanel bridge={bridge} adoptPtyId="pty-survivor" />);

    // A tab restored from a surviving session carries its ptyId, so the panel
    // reconnects the live shell rather than creating a new one — the running
    // program and its I/O survive the reload.
    await waitFor(() => expect(terminal.adopt).toHaveBeenCalledWith('pty-survivor'));
    expect(terminal.create).not.toHaveBeenCalled();
    // The adopted shell is nudged to repaint at the current viewport so a
    // full-screen TUI (claude, vim) redraws its screen after the reload.
    expect(terminal.resize).toHaveBeenCalledWith('pty-survivor', 80, 24);
  });

  test('reload rehydration: writes the adopted session replay into xterm so the screen repaints', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-fresh' }, WIRED, async () => ({
      ok: true,
      replay: 'REPLAYED-SCREEN-BYTES',
    }));
    render(<TerminalPanel bridge={bridge} adoptPtyId="pty-survivor" />);

    await waitFor(() => expect(terminal.adopt).toHaveBeenCalledWith('pty-survivor'));
    // The retained screen + scrollback main returned on adopt is written into the
    // fresh xterm so the reconnected tab repaints instead of coming back blank.
    // This is the renderer half of the replay contract the
    // main-process test pins on the producing side.
    expect(lastTerm?.write).toHaveBeenCalledWith('REPLAYED-SCREEN-BYTES');
    expect(terminal.create).not.toHaveBeenCalled();
  });

  test('reload rehydration: a refused adopt (session died in the gap) falls through to a fresh create', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-fresh' }, WIRED, async () => ({
      ok: false,
      reason: 'unknown-session',
    }));
    render(<TerminalPanel bridge={bridge} adoptPtyId="pty-gone" />);

    // The surviving session exited before this mount; adopt is refused and the
    // panel spawns a fresh shell rather than wiring xterm to a dead ptyId.
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(terminal.adopt).toHaveBeenCalledWith('pty-gone');
    // resize is gated behind `if (adopted.ok)`, so the refused ptyId is never
    // resized — a refactor moving resize before that check would regress here.
    expect(terminal.resize).not.toHaveBeenCalled();
  });

  test('reload rehydration: an adopt that throws is caught and falls through to a fresh create', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-fresh' }, WIRED, async () => {
      throw new Error('ipc boom');
    });
    render(<TerminalPanel bridge={bridge} adoptPtyId="pty-survivor" />);

    // An IPC failure on adopt must not strand the panel on a permanently blank
    // terminal — the catch degrades to the same fresh-create fallback as an
    // explicit refusal.
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(terminal.adopt).toHaveBeenCalledWith('pty-survivor');
    // A thrown adopt never reaches the `if (adopted.ok)` branch, so the dead
    // ptyId is never resized either.
    expect(terminal.resize).not.toHaveBeenCalled();
  });

  test('reload rehydration: an unmount mid-adopt leaves the surviving session alive (does not kill it)', async () => {
    // Cancelled adopt is deliberately asymmetric with cancelled create: a create
    // reaps the orphan PTY it just made, but an adopt only resumed a shell that
    // is still alive in main, so it must leave it for the next mount to re-adopt.
    // Harmonizing the two (adding kill() to the adopt cancel path) would kill
    // running programs on every React StrictMode double-mount — this pins against
    // that regression.
    let releaseAdopt: (() => void) | null = null;
    const { bridge, terminal } = makeBridge(
      { ok: true, ptyId: 'pty-fresh' },
      WIRED,
      () =>
        new Promise<{ ok: true }>((resolve) => {
          releaseAdopt = () => resolve({ ok: true });
        }),
    );
    const { unmount } = render(<TerminalPanel bridge={bridge} adoptPtyId="pty-survivor" />);

    // Let adopt get in flight, then tear the panel down before it resolves.
    await waitFor(() => expect(terminal.adopt).toHaveBeenCalledWith('pty-survivor'));
    unmount();
    // The adopt resolves after the unmount; the cancelled effect must ignore it
    // (no attach) rather than wiring or reaping the still-live session.
    releaseAdopt?.();
    await act(async () => {});

    expect(terminal.kill).not.toHaveBeenCalled();
  });

  test('forwards xterm OSC 0/2 title changes to onTitleChange', async () => {
    const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
    const onTitleChange = mock((_title: string) => {});
    render(<TerminalPanel bridge={bridge} onTitleChange={onTitleChange} />);

    // xterm registers the title listener synchronously at mount (before the PTY
    // create resolves), so the program's first title can land immediately.
    await waitFor(() => expect(lastTerm?.onTitleChangeCb).toBeTruthy());

    act(() => lastTerm?.onTitleChangeCb?.('claude — repo'));
    expect(onTitleChange).toHaveBeenCalledWith('claude — repo');

    // Live binding: a later title forwards again.
    act(() => lastTerm?.onTitleChangeCb?.('claude — done'));
    expect(onTitleChange).toHaveBeenLastCalledWith('claude — done');
  });

  test('disposes the title listener on unmount', async () => {
    const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
    const onTitleChange = mock((_title: string) => {});
    const { unmount } = render(<TerminalPanel bridge={bridge} onTitleChange={onTitleChange} />);
    await waitFor(() => expect(lastTerm?.onTitleChangeCb).toBeTruthy());

    unmount();
    // After teardown the panel must not forward a late title (the disposed
    // listener's callback is cleared by the cancelled-guard regardless).
    onTitleChange.mockClear();
    act(() => lastTerm?.onTitleChangeCb?.('late'));
    expect(onTitleChange).not.toHaveBeenCalled();
  });

  test('writes shell output to the terminal and drains the consumed code-unit count for backpressure', async () => {
    const { bridge, terminal, pushData } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));

    // 4-codepoint multibyte string: drain must report UTF-16 .length (6), the
    // unit terminal-manager accounts in — not the byte length.
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

  test('dropping files inserts their shell-escaped paths at the prompt (PRD-7238)', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    // Same readiness gate as the keystroke test: once onData is subscribed the
    // create() promise has settled and ptyIdRef points at the live PTY.
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());

    const container = document.querySelector('[data-terminal-status]');
    if (container === null) throw new Error('terminal container not found');

    const fileA = new File(['x'], 'shot.png', { type: 'image/png' });
    // A name with a space and an apostrophe exercises the shell escaping.
    const fileB = new File(['y'], "a b's.png", { type: 'image/png' });
    const dataTransfer = { types: ['Files'], files: [fileA, fileB] };
    fireEvent.dragOver(container, { dataTransfer });
    fireEvent.drop(container, { dataTransfer });

    // Each path single-quoted (apostrophe → '\''), space-joined, trailing space
    // so a following keystroke doesn't glue onto the path. No newline — the user
    // reviews the composed prompt before submitting.
    expect(terminal.input).toHaveBeenCalledWith(
      'pty-1',
      "'/dropped/shot.png' '/dropped/a b'\\''s.png' ",
    );
  });

  test('a drop where every file resolves to no disk path writes nothing (clipboard blobs)', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    // Electron `webUtils.getPathForFile` returns '' for a File with no disk
    // backing (a pasted/synthetic blob) — the null/empty filter must drop it so
    // the prompt never receives a literal empty-quoted argument.
    (bridge as unknown as { getPathForFile: (f: File) => string }).getPathForFile = () => '';
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());

    const container = document.querySelector('[data-terminal-status]');
    if (container === null) throw new Error('terminal container not found');

    const blob = new File(['x'], 'pasted.png', { type: 'image/png' });
    const dataTransfer = { types: ['Files'], files: [blob] };
    fireEvent.dragOver(container, { dataTransfer });
    fireEvent.drop(container, { dataTransfer });

    expect(terminal.input).not.toHaveBeenCalled();
  });

  test('a mixed drop writes only the files that resolve to a disk path', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    // Only on-disk files resolve; the synthetic one yields null and is filtered
    // out (never interpolated as a literal 'null' into the shell-quoted string).
    (bridge as unknown as { getPathForFile: (f: File) => string | null }).getPathForFile = (
      file,
    ) => (file.name === 'ghost.png' ? null : `/dropped/${file.name}`);
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());

    const container = document.querySelector('[data-terminal-status]');
    if (container === null) throw new Error('terminal container not found');

    const real = new File(['x'], 'shot.png', { type: 'image/png' });
    const ghost = new File(['y'], 'ghost.png', { type: 'image/png' });
    const dataTransfer = { types: ['Files'], files: [real, ghost] };
    fireEvent.dragOver(container, { dataTransfer });
    fireEvent.drop(container, { dataTransfer });

    // Exactly the resolvable path, once — no 'null' text, no empty argument.
    expect(terminal.input).toHaveBeenCalledTimes(1);
    expect(terminal.input).toHaveBeenCalledWith('pty-1', "'/dropped/shot.png' ");
  });

  test('a dropped path containing a control char is filtered (no PTY command injection)', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());

    const container = document.querySelector('[data-terminal-status]');
    if (container === null) throw new Error('terminal container not found');

    // A newline in the (legal, if exotic) filename → the resolved path carries a
    // control byte the tty would act on before the shell, submitting the trailing
    // `rm -rf ~` as its own command. The clean sibling still inserts; the tainted
    // one is dropped entirely.
    const clean = new File(['x'], 'shot.png', { type: 'image/png' });
    const tainted = new File(['y'], 'a\nrm -rf ~.png', { type: 'image/png' });
    const dataTransfer = { types: ['Files'], files: [clean, tainted] };
    fireEvent.dragOver(container, { dataTransfer });
    fireEvent.drop(container, { dataTransfer });

    expect(terminal.input).toHaveBeenCalledTimes(1);
    expect(terminal.input).toHaveBeenCalledWith('pty-1', "'/dropped/shot.png' ");
  });

  test('a drag that carries no external files is ignored (no PTY write)', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());

    const container = document.querySelector('[data-terminal-status]');
    if (container === null) throw new Error('terminal container not found');

    // An internal sidebar drag (no 'Files' in types) must not reach the PTY.
    const dataTransfer = { types: ['text/plain'], files: [] };
    fireEvent.drop(container, { dataTransfer });
    expect(terminal.input).not.toHaveBeenCalled();
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

    // One custom key handler is attached to patch two Shift chords: Shift+Tab
    // (cancel the browser default so it reaches the PTY instead of escaping
    // focus; returns true so xterm still emits the reverse-tab sequence) and
    // Shift+Enter (send LF to the PTY, return false to suppress xterm's default
    // CR — exercised in the next test). Every other key returns true unchanged.
    expect(lastTerm?.attachCustomKeyEventHandler).toHaveBeenCalledTimes(1);
    const handler = lastTerm?.keyHandler;
    expect(handler).toBeTruthy();

    // Shift+Tab keydown: browser default cancelled, but still handed to xterm
    // (returns true) so the reverse-tab sequence reaches the PTY / Claude TUI.
    const shiftTabPreventDefault = mock(() => {});
    const shiftTab = {
      type: 'keydown',
      key: 'Tab',
      shiftKey: true,
      preventDefault: shiftTabPreventDefault,
    } as unknown as KeyboardEvent;
    expect(handler?.(shiftTab)).toBe(true);
    expect(shiftTabPreventDefault).toHaveBeenCalledTimes(1);

    // Plain Tab is left to xterm, which already cancels that one itself.
    const plainTabPreventDefault = mock(() => {});
    const plainTab = {
      type: 'keydown',
      key: 'Tab',
      shiftKey: false,
      preventDefault: plainTabPreventDefault,
    } as unknown as KeyboardEvent;
    expect(handler?.(plainTab)).toBe(true);
    expect(plainTabPreventDefault).not.toHaveBeenCalled();

    // Escape is never intercepted (no preventDefault) so terminal apps (vim, the
    // `claude` TUI) receive it — and it reaches the PTY via the data callback.
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

    // Shift+Enter: send LF ourselves and return false so xterm does NOT also
    // emit its default CR — the CLI inserts a newline rather than submitting.
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

    // Plain Enter is left to xterm, which sends its default CR (submit).
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

    // Normal scrollback (no TUI mouse tracking): the handler returns true so
    // xterm's own (smoothed) scrollback handling runs, and nothing is written
    // to the PTY.
    term.modes.mouseTrackingMode = 'none';
    expect(wheel({ deltaY: 120, deltaMode: 0 } as unknown as WheelEvent)).toBe(true);
    expect(terminal.input).not.toHaveBeenCalled();

    // Mouse-tracking TUI using a non-SGR (legacy X10/DEFAULT) encoding: the
    // handler must NOT synthesize SGR reports it can't parse — it defers to
    // xterm's own correctly-encoded path (returns true, writes nothing).
    term.modes.mouseTrackingMode = 'any';
    term.mouseEncoding = 'DEFAULT';
    expect(wheel({ deltaY: 120, deltaMode: 0 } as unknown as WheelEvent)).toBe(true);
    expect(terminal.input).not.toHaveBeenCalled();

    // Mouse-tracking TUI with SGR encoding (claude/vim): the handler takes over,
    // returns false to suppress xterm's flooding default, and forwards a burst
    // of accumulated SGR wheel-down reports to the PTY. The exact tick count is
    // a tuned product of sensitivity/cell-height/cap (decoupled from this test
    // on purpose) — pin the payload SHAPE, not the count, so re-tuning the feel
    // doesn't break the wiring assertion.
    term.mouseEncoding = 'SGR';
    expect(wheel({ deltaY: 120, deltaMode: 0 } as unknown as WheelEvent)).toBe(false);
    expect(terminal.input).toHaveBeenCalledTimes(1);
    const [ptyId, payload] = terminal.input.mock.calls[0] as [string, string];
    expect(ptyId).toBe('pty-1');
    // Positive deltaY = wheel-down = SGR button 65; one or more whole-row ticks.
    // The mock terminal exposes no `element`, so the report position takes the
    // viewport-center fallback (80×24 → 40;12) — never a corner, which
    // hit-testing TUIs (opencode) treat as a dead cell and drop the scroll.
    // Assert the payload is purely repeated wheel-down reports (string ops, not
    // a regex — the ESC byte trips biome's control-char-in-regex rule).
    const downTick = '\x1b[<65;40;12M';
    expect(payload.length).toBeGreaterThan(0);
    expect(payload.length % downTick.length).toBe(0);
    expect(payload.replaceAll(downTick, '')).toBe('');

    // SGR_PIXELS (1016, pixel-precision) also takes over — the gate accepts
    // both SGR encodings, so pin the second branch against a refactor/typo.
    // The payload must carry CSS-px coordinates, not cells: with the mock's
    // 10×17 cells, no element (center fallback), and an 80×24 grid, the pixel
    // center is ceil(10·80/2)=400, ceil(17·24/2)=204. A regression in the
    // `pixels` flag wiring would emit cell coordinates and fail here.
    terminal.input.mockClear();
    term.mouseEncoding = 'SGR_PIXELS';
    expect(wheel({ deltaY: 120, deltaMode: 0 } as unknown as WheelEvent)).toBe(false);
    expect(terminal.input).toHaveBeenCalledTimes(1);
    const [, pxPayload] = terminal.input.mock.calls[0] as [string, string];
    const pxTick = '\x1b[<65;400;204M';
    expect(pxPayload.length).toBeGreaterThan(0);
    expect(pxPayload.length % pxTick.length).toBe(0);
    expect(pxPayload.replaceAll(pxTick, '')).toBe('');
  });

  test('wheel reports carry the pointer cell so hit-testing TUIs scroll the hovered component', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.wheelHandler).toBeTruthy());
    const term = lastTerm;
    if (term?.wheelHandler == null) throw new Error('wheel handler not attached');
    term.modes.mouseTrackingMode = 'any';
    term.mouseEncoding = 'SGR';

    // Give the terminal a screen element at a known origin; the pointer sits
    // 505px right / 110px below it. With 10×17 cells that's cell (51, 7).
    const screenEl = document.createElement('div');
    screenEl.className = 'xterm-screen';
    screenEl.getBoundingClientRect = () => ({ left: 100, top: 50 }) as DOMRect;
    const host = document.createElement('div');
    host.appendChild(screenEl);
    term.element = host;

    expect(
      term.wheelHandler({
        deltaY: 120,
        deltaMode: 0,
        clientX: 605,
        clientY: 160,
      } as unknown as WheelEvent),
    ).toBe(false);
    expect(terminal.input).toHaveBeenCalledTimes(1);
    const [, payload] = terminal.input.mock.calls[0] as [string, string];
    const tick = '\x1b[<65;51;7M';
    expect(payload.length).toBeGreaterThan(0);
    expect(payload.length % tick.length).toBe(0);
    expect(payload.replaceAll(tick, '')).toBe('');
  });

  test('pointer mapping falls back to the terminal element rect when .xterm-screen is absent', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.wheelHandler).toBeTruthy());
    const term = lastTerm;
    if (term?.wheelHandler == null) throw new Error('wheel handler not attached');
    term.modes.mouseTrackingMode = 'any';
    term.mouseEncoding = 'SGR';

    // No `.xterm-screen` child (e.g. an xterm DOM restructure): the handler
    // must measure `term.element` itself rather than degrade to the center
    // fallback. Same pointer math as above but from the element's own origin.
    const host = document.createElement('div');
    host.getBoundingClientRect = () => ({ left: 200, top: 100 }) as DOMRect;
    term.element = host;

    expect(
      term.wheelHandler({
        deltaY: 120,
        deltaMode: 0,
        clientX: 705,
        clientY: 210,
      } as unknown as WheelEvent),
    ).toBe(false);
    expect(terminal.input).toHaveBeenCalledTimes(1);
    const [, payload] = terminal.input.mock.calls[0] as [string, string];
    const tick = '\x1b[<65;51;7M';
    expect(payload.length).toBeGreaterThan(0);
    expect(payload.length % tick.length).toBe(0);
    expect(payload.replaceAll(tick, '')).toBe('');
  });

  test('mode transition resets the wheel accumulator (no stale carry across apps)', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.wheelHandler).toBeTruthy());
    const term = lastTerm;
    if (term?.wheelHandler == null) throw new Error('wheel handler not attached');
    const wheel = term.wheelHandler;
    term.mouseEncoding = 'SGR';

    // SGR active: a 30px wheel (~1.76 rows at 17px) fires 1 report and leaves a
    // ~0.76-row fractional carry in the accumulator.
    term.modes.mouseTrackingMode = 'any';
    expect(wheel({ deltaY: 30, deltaMode: 0 } as unknown as WheelEvent)).toBe(false);
    expect(terminal.input).toHaveBeenCalledTimes(1);

    // App releases the mouse (mode → none): the defer branch must zero the carry.
    term.modes.mouseTrackingMode = 'none';
    expect(wheel({ deltaY: 5, deltaMode: 0 } as unknown as WheelEvent)).toBe(true);

    // Mouse mode again: a fresh sub-row 10px (~0.59 rows) must NOT fire — it
    // would only cross a row boundary if the stale 0.76 carry had survived.
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

    // Mount + PTY wiring still complete despite the WebGL addon throwing.
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
    // The accessible region is still present.
    expect(screen.getByRole('region', { name: 'Terminal' })).toBeTruthy();
    // An explicit refusal notice — not a bare, focused, message-less canvas.
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
    // A distinct, accessible reason — and the dead canvas is never focused.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/isn't enabled for this project/i);
    expect(lastTerm?.focus).not.toHaveBeenCalled();
    expect(terminal.onData).not.toHaveBeenCalled();
    // The "Close terminal" button is gated on `onClose` (collapse the dock) —
    // clicking it collapses via the close callback.
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

    // Unmount BEFORE create() resolves: the in-flight spawn is orphaned, so the
    // late resolution must reap it rather than leak a PTY into a dead panel.
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

    // The help affordance opens the Claude Code docs via the bridge.
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
    // The banner hands off to the consent dialog and dismisses itself.
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
    // create() rejects (e.g. utilityProcess.fork throwing on resource
    // exhaustion). Without containment status stays 'starting' → blank box.
    let resolveCreate: (() => void) | undefined;
    let createCalls = 0;
    const createGate = new Promise<void>((res) => {
      resolveCreate = res;
    });
    const terminal = {
      create: mock(async () => {
        createCalls += 1;
        if (createCalls === 1) throw new Error('fork EMFILE');
        // After restart, succeed so we can prove the restart path works.
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

    // A visible alert with a restart affordance, not a blank/frozen view.
    expect(await screen.findByRole('alert')).toBeTruthy();
    const restart = screen.getByRole('button', { name: 'Restart terminal' });

    // Restart re-mounts the session and re-invokes create().
    fireEvent.click(restart);
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveCreate?.();
      await Promise.resolve();
    });
    // The second (successful) create clears the error state.
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  test('renders a visible exit state with a restart affordance when the shell exits', async () => {
    const { bridge, terminal, pushExit } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(terminal.onExit).toHaveBeenCalledTimes(1));

    act(() => pushExit({ ptyId: 'pty-1', exitCode: 1, signal: null }));

    // A visible alert conveys the exit (and the code) — not a blank/frozen view.
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

    // A second create() proves a fresh PTY was requested; the exit state clears.
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  test('hides the Claude readiness banner once the shell has exited', async () => {
    const { bridge, pushExit } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      { claude: 'not-found', mcp: 'needs-rewire' },
    );
    render(<TerminalPanel bridge={bridge} />);

    // The readiness nudge appears while the shell is live...
    await screen.findByText(/isn't installed or on your PATH/);

    // ...and is replaced by the exit state once the shell dies — a tools nudge
    // over a dead terminal would be misleading.
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

    // Flip the app theme and re-render: the open session must re-skin in place.
    mockResolvedTheme = 'light';
    rerender(<TerminalPanel bridge={bridge} />);

    await waitFor(() => expect(lastTerm?.options.theme).toBe(XTERM_LIGHT_THEME));
    // Same xterm instance, same PTY — no teardown/respawn on a theme change.
    expect(lastTerm).toBe(term);
    expect(term?.dispose).not.toHaveBeenCalled();
    expect(terminal.create).toHaveBeenCalledTimes(1);
    expect(terminal.kill).not.toHaveBeenCalled();
  });

  test('restarting one session spawns a fresh PTY for it without disturbing a sibling', async () => {
    // The multi-tab reality: one shared bridge (one host) multiplexing two
    // sessions/PTYs. A crash + restart in one tab must re-create only that
    // session's PTY and leave the sibling's PTY untouched.
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
    // Two independent sessions spawn: pty-1 and pty-2.
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));

    // Crash only the first session.
    act(() => pushExit({ ptyId: 'pty-1', exitCode: 1, signal: null }));
    // Exactly one exit notice — the sibling keeps running with no exit state.
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    // Restart the crashed session: a fresh PTY just for it (3rd create overall).
    fireEvent.click(screen.getByRole('button', { name: 'Restart terminal' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3));

    // The sibling's PTY was never reaped and it shows no exit state.
    expect(kill).not.toHaveBeenCalledWith('pty-2');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
