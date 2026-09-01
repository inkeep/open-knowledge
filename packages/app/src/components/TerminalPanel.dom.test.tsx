import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type {
  ClaudeReadiness,
  OkDesktopBridge,
  OkPtyAdoptResult,
  OkPtyData,
  OkPtyExit,
  OkPtyNotice,
} from '@/lib/desktop-bridge-types';
import {
  applyModelledScroll,
  createScrollModelState,
  instrumentSmoothScrollOption,
} from './terminal-scroll-model.test-helper';

class MockFitAddon {
  fit = vi.fn(() => {});
  constructor() {
    lastFit = this;
  }
}
class MockWebglAddon {}
let lastWebLinksHandler: ((event: MouseEvent, uri: string) => void) | null = null;
class MockWebLinksAddon {
  constructor(handler?: (event: MouseEvent, uri: string) => void) {
    lastWebLinksHandler = handler ?? null;
  }
}
class MockUnicode11Addon {}

class MockTerminal {
  cols = 80;
  rows = 24;
  unicode = { activeVersion: '6' };
  modes = { mouseTrackingMode: 'none' as string };
  mouseEncoding = 'SGR' as string;
  renderFlush = vi.fn(() => {});
  refresh = vi.fn((_start: number, _end: number) => {});
  selection = '';
  hasSelection = vi.fn(() => this.selection.length > 0);
  getSelection = vi.fn(() => this.selection);
  clearSelection = vi.fn(() => {
    this.selection = '';
  });
  get _core() {
    return {
      coreMouseService: { activeEncoding: this.mouseEncoding },
      _renderService: {
        dimensions: { css: { cell: { width: 10, height: 17 } } },
        _renderDebouncer: { _innerRefresh: this.renderFlush },
      },
    };
  }
  element: HTMLElement | undefined = undefined;
  lineText = '';
  lineRows: string[] | null = null;
  scrollState = createScrollModelState(0);
  baseY = 0;
  get viewportY() {
    return this.scrollState.viewportY;
  }
  set viewportY(line: number) {
    this.scrollState.viewportY = line;
  }
  get scrollbarLine() {
    return this.scrollState.scrollbarLine;
  }
  set scrollbarLine(line: number) {
    this.scrollState.scrollbarLine = line;
  }
  get pendingScrollTarget() {
    return this.scrollState.pendingTarget;
  }
  scrollToBottom = vi.fn(() => {
    applyModelledScroll(this.scrollState, this.baseY, this.options.smoothScrollDuration as number);
  });
  scrollToLine = vi.fn((line: number) => {
    applyModelledScroll(this.scrollState, line, this.options.smoothScrollDuration as number);
  });
  get buffer() {
    return {
      active: {
        viewportY: this.viewportY,
        baseY: this.baseY,
        getLine: (index: number) => {
          if (this.lineRows) {
            const t = this.lineRows[index];
            if (t === undefined) return undefined;
            return { translateToString: (_trim?: boolean) => t, isWrapped: index > 0 };
          }
          return { translateToString: (_trim?: boolean) => this.lineText, isWrapped: false };
        },
      },
    };
  }
  linkProvider: {
    provideLinks(line: number, cb: (links: unknown[] | undefined) => void): void;
  } | null = null;
  linkProviderDispose = vi.fn(() => {});
  registerLinkProvider = vi.fn(
    (provider: {
      provideLinks(line: number, cb: (links: unknown[] | undefined) => void): void;
    }) => {
      this.linkProvider = provider;
      return { dispose: this.linkProviderDispose };
    },
  );
  onDataCb: ((d: string) => void) | null = null;
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  wheelHandler: ((e: WheelEvent) => boolean) | null = null;
  options: Record<string, unknown>;
  open = vi.fn((container: HTMLElement) => {
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    screen.appendChild(document.createElement('canvas'));
    container.appendChild(screen);
  });
  focus = vi.fn(() => {});
  dispose = vi.fn(() => {});
  paste = vi.fn((_data: string) => {});
  pendingWrites: Array<{ data: string; callback?: () => void }> = [];
  write = vi.fn((data: string, callback?: () => void) => {
    if (deferTerminalWrites) {
      this.pendingWrites.push({ data, callback });
      return;
    }
    callback?.();
  });
  flushPendingWrites(): void {
    for (const pending of this.pendingWrites.splice(0)) {
      if (terminalGeneratedInput !== null) this.onDataCb?.(terminalGeneratedInput);
      pending.callback?.();
    }
  }
  loadAddon = vi.fn((addon: unknown) => {
    if (webglThrows && addon instanceof MockWebglAddon) throw new Error('no webgl2 context');
  });
  onData = vi.fn((cb: (d: string) => void) => {
    this.onDataCb = cb;
    return { dispose() {} };
  });
  onTitleChangeCb: ((title: string) => void) | null = null;
  onTitleChange = vi.fn((cb: (title: string) => void) => {
    this.onTitleChangeCb = cb;
    return { dispose() {} };
  });
  attachCustomKeyEventHandler = vi.fn((h: (e: KeyboardEvent) => boolean) => {
    this.keyHandler = h;
  });
  attachCustomWheelEventHandler = vi.fn((h: (e: WheelEvent) => boolean) => {
    this.wheelHandler = h;
  });
  smoothScrollWrites: () => number;
  constructor(options: Record<string, unknown>) {
    this.smoothScrollWrites = instrumentSmoothScrollOption(
      options as { smoothScrollDuration?: number },
    );
    this.options = options;
    lastTerm = this;
  }
}

let lastTerm: MockTerminal | null = null;
let lastFit: MockFitAddon | null = null;
let webglThrows = false;
let deferTerminalWrites = false;
let terminalGeneratedInput: string | null = null;
let mockResolvedTheme: string | undefined = 'dark';

let roCallback: (() => void) | null = null;
let allROs: MockResizeObserver[] = [];
class MockResizeObserver {
  cb: () => void;
  observed: Array<{ el: Element; opts?: ResizeObserverOptions }> = [];
  observe = vi.fn((el: Element, opts?: ResizeObserverOptions) => {
    this.observed.push({ el, opts });
  });
  unobserve = vi.fn(() => {});
  disconnect = vi.fn(() => {});
  constructor(cb: () => void) {
    this.cb = cb;
    roCallback = cb;
    allROs.push(this);
  }
}

vi.doMock('@xterm/xterm', () => ({ Terminal: MockTerminal }));
vi.doMock('@xterm/addon-fit', () => ({ FitAddon: MockFitAddon }));
vi.doMock('@xterm/addon-webgl', () => ({ WebglAddon: MockWebglAddon }));
vi.doMock('@xterm/addon-web-links', () => ({ WebLinksAddon: MockWebLinksAddon }));
vi.doMock('@xterm/addon-unicode11', () => ({ Unicode11Addon: MockUnicode11Addon }));
vi.doMock('@xterm/xterm/css/xterm.css', () => ({}));
vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: mockResolvedTheme }),
}));

type CreateResult =
  | { ok: true; ptyId: string }
  | { ok: false; reason: 'no-project' | 'not-consented' };

const WIRED: ClaudeReadiness = { claude: 'present', mcp: 'wired' };

function makeBridge(
  createResult: CreateResult,
  preflight: ClaudeReadiness = WIRED,
  adopt: (id: string) => Promise<OkPtyAdoptResult> = async () => ({
    ok: true,
    replay: '',
  }),
  platform: OkDesktopBridge['platform'] = 'darwin',
) {
  const dataSubs: Array<(m: OkPtyData) => void> = [];
  const exitSubs: Array<(m: OkPtyExit) => void> = [];
  const noticeSubs: Array<(m: OkPtyNotice) => void> = [];
  const unsubData = vi.fn(() => {});
  const unsubExit = vi.fn(() => {});
  const unsubNotice = vi.fn(() => {});
  const openExternal = vi.fn(async (_url: string) => {});
  const openAsset = vi.fn(
    async (_relPath: string): Promise<{ ok: true } | { ok: false; reason: string }> => ({
      ok: true,
    }),
  );
  const revealAsset = vi.fn(async (_relPath: string) => ({ ok: true }) as { ok: true });
  const revealExternal = vi.fn(
    async (_absPath: string) =>
      ({ ok: true, outcome: 'revealed' }) as { ok: true; outcome: 'revealed' },
  );
  const checkTargetExists = vi.fn(
    async (_req: { projectPath: string; kind: 'doc' | 'folder'; path: string }) =>
      'exists' as const,
  );
  const rewireClaudeMcp = vi.fn(async () => preflight);
  const terminal = {
    create: vi.fn(async () => createResult),
    adopt: vi.fn(adopt),
    input: vi.fn((_id: string, _d: string) => {}),
    resize: vi.fn((_id: string, _c: number, _r: number) => {}),
    kill: vi.fn(async (_id: string) => {}),
    drain: vi.fn((_id: string, _bytes: number) => {}),
    onData: vi.fn((cb: (m: OkPtyData) => void) => {
      dataSubs.push(cb);
      return unsubData;
    }),
    onExit: vi.fn((cb: (m: OkPtyExit) => void) => {
      exitSubs.push(cb);
      return unsubExit;
    }),
    onNotice: vi.fn((cb: (m: OkPtyNotice) => void) => {
      noticeSubs.push(cb);
      return unsubNotice;
    }),
    claudePreflight: vi.fn(async () => preflight),
    cliPreflight: vi.fn(async () => ({ onPath: 'present' as const })),
    rewireClaudeMcp,
  };
  return {
    bridge: {
      terminal,
      shell: { openExternal, openAsset, revealAsset, revealExternal },
      project: { checkTargetExists },
      config: { e2eSmoke: false, projectPath: '/Users/me/project' },
      platform,
      getPathForFile: (file: File) => `/dropped/${file.name}`,
    } as unknown as OkDesktopBridge,
    terminal,
    openExternal,
    openAsset,
    revealAsset,
    revealExternal,
    checkTargetExists,
    rewireClaudeMcp,
    unsubData,
    unsubExit,
    unsubNotice,
    pushData: (m: OkPtyData) => {
      for (const f of dataSubs) f(m);
    },
    pushExit: (m: OkPtyExit) => {
      for (const f of exitSubs) f(m);
    },
    pushNotice: (m: OkPtyNotice) => {
      for (const f of noticeSubs) f(m);
    },
  };
}

const { TerminalPanel } = await import('./TerminalPanel');
const { XTERM_DARK_THEME, XTERM_LIGHT_THEME } = await import('./terminal-theme');

describe('TerminalPanel', () => {
  beforeEach(() => {
    lastTerm = null;
    lastFit = null;
    roCallback = null;
    allROs = [];
    webglThrows = false;
    deferTerminalWrites = false;
    terminalGeneratedInput = null;
    mockResolvedTheme = 'dark';
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(async () => 'clipboard paste'),
        writeText: vi.fn(async () => {}),
      },
    });
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

  test('screen-reader mode follows the assistive-tech signal: off when inactive, live-toggled on attach', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    const a11ySubs: Array<(active: boolean) => void> = [];
    const a11yUnsub = vi.fn(() => {});
    const withA11y = {
      ...(bridge as unknown as Record<string, unknown>),
      accessibility: {
        isScreenReaderActive: () => false,
        onScreenReaderChanged: (cb: (active: boolean) => void) => {
          a11ySubs.push(cb);
          return a11yUnsub;
        },
      },
    } as unknown as OkDesktopBridge;
    const { unmount } = render(<TerminalPanel bridge={withA11y} />);
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));

    expect(lastTerm?.options.screenReaderMode).toBe(false);

    act(() => {
      for (const f of a11ySubs) f(true);
    });
    expect(lastTerm?.options.screenReaderMode).toBe(true);
    act(() => {
      for (const f of a11ySubs) f(false);
    });
    expect(lastTerm?.options.screenReaderMode).toBe(false);

    act(() => unmount());
    expect(a11yUnsub).toHaveBeenCalledTimes(1);
  });

  test('the smoke suite pins screen-reader mode on even with no assistive tech (assertions read the a11y tree)', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    const smokeBridge = {
      ...(bridge as unknown as Record<string, unknown>),
      config: { e2eSmoke: true },
      accessibility: {
        isScreenReaderActive: () => false,
        onScreenReaderChanged: () => () => {},
      },
    } as unknown as OkDesktopBridge;
    render(<TerminalPanel bridge={smokeBridge} />);
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(lastTerm?.options.screenReaderMode).toBe(true);
  });

  test('reload rehydration: adopts a surviving session instead of spawning a fresh one', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-fresh' });
    render(<TerminalPanel bridge={bridge} adoptPtyId="pty-survivor" />);

    await waitFor(() => expect(terminal.adopt).toHaveBeenCalledWith('pty-survivor'));
    expect(terminal.create).not.toHaveBeenCalled();
    expect(terminal.resize).toHaveBeenCalledWith('pty-survivor', 80, 24);
    act(() => lastTerm?.onDataCb?.('user input'));
    expect(terminal.input).toHaveBeenCalledWith('pty-survivor', 'user input');
  });

  test('reload rehydration: writes the adopted session replay into xterm so the screen repaints', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-fresh' }, WIRED, async () => ({
      ok: true,
      replay: 'REPLAYED-SCREEN-BYTES',
    }));
    render(<TerminalPanel bridge={bridge} adoptPtyId="pty-survivor" />);

    await waitFor(() => expect(terminal.adopt).toHaveBeenCalledWith('pty-survivor'));
    expect(lastTerm?.write).toHaveBeenCalledWith('REPLAYED-SCREEN-BYTES', expect.any(Function));
    expect(terminal.create).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-starting-notice')).toBeNull();
  });

  test('reload rehydration: does not send replay-generated terminal replies into the live shell', async () => {
    deferTerminalWrites = true;
    terminalGeneratedInput = '\x1b[?1;2c';
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-fresh' }, WIRED, async () => ({
      ok: true,
      replay: '\x1b[c',
    }));
    render(<TerminalPanel bridge={bridge} adoptPtyId="pty-survivor" />);

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    expect(document.querySelector('[data-terminal-status="starting"]')).toBeTruthy();
    expect(lastTerm?.focus).not.toHaveBeenCalled();
    act(() => lastTerm?.onDataCb?.('early user input'));
    expect(terminal.input).not.toHaveBeenCalledWith('pty-survivor', 'early user input');
    expect(terminal.resize).toHaveBeenCalledWith('pty-survivor', 80, 24);
    act(() => lastTerm?.flushPendingWrites());

    expect(terminal.input).not.toHaveBeenCalledWith('pty-survivor', '\x1b[?1;2c');
    expect(document.querySelector('[data-terminal-status="running"]')).toBeTruthy();
    expect(lastTerm?.focus).toHaveBeenCalledTimes(1);

    act(() => lastTerm?.onDataCb?.('user input'));
    expect(terminal.input).toHaveBeenCalledWith('pty-survivor', 'user input');
  });

  test('reload rehydration: gates direct input surfaces until replay completes', async () => {
    deferTerminalWrites = true;
    const { bridge, terminal, pushNotice } = makeBridge(
      { ok: true, ptyId: 'pty-fresh' },
      WIRED,
      async () => ({ ok: true, replay: 'REPLAYED-SCREEN-BYTES' }),
      'win32',
    );
    render(<TerminalPanel bridge={bridge} adoptPtyId="pty-survivor" />);

    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());
    const term = lastTerm;
    if (term?.keyHandler == null || term.wheelHandler == null) {
      throw new Error('terminal input handlers not attached');
    }
    act(() =>
      pushNotice({
        ptyId: 'pty-survivor',
        notice: 'shell-resolved',
        shellFamily: 'powershell',
      }),
    );

    const shiftEnter = {
      type: 'keydown',
      key: 'Enter',
      shiftKey: true,
      preventDefault: vi.fn(() => {}),
    } as unknown as KeyboardEvent;
    expect(term.keyHandler(shiftEnter)).toBe(false);

    term.modes.mouseTrackingMode = 'any';
    term.mouseEncoding = 'SGR';
    expect(term.wheelHandler({ deltaY: 120, deltaMode: 0 } as unknown as WheelEvent)).toBe(true);

    const container = document.querySelector('[data-terminal-status]');
    if (container === null) throw new Error('terminal container not found');
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.drop(container, { dataTransfer: { types: ['Files'], files: [file] } });

    const ctrlV = {
      type: 'keydown',
      key: 'v',
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(() => {}),
    } as unknown as KeyboardEvent;
    expect(term.keyHandler(ctrlV)).toBe(false);
    await act(async () => {});

    expect(terminal.input).not.toHaveBeenCalled();
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
    expect(term.paste).not.toHaveBeenCalled();

    act(() => term.flushPendingWrites());
    terminal.input.mockClear();

    expect(term.keyHandler(shiftEnter)).toBe(false);
    expect(terminal.input).toHaveBeenLastCalledWith('pty-survivor', '\n');

    terminal.input.mockClear();
    expect(term.wheelHandler({ deltaY: 120, deltaMode: 0 } as unknown as WheelEvent)).toBe(false);
    expect(terminal.input).toHaveBeenCalledTimes(1);

    terminal.input.mockClear();
    fireEvent.drop(container, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(terminal.input).toHaveBeenCalledWith('pty-survivor', "'/dropped/shot.png' ");

    expect(term.keyHandler(ctrlV)).toBe(false);
    await act(async () => {});
    expect(navigator.clipboard.readText).toHaveBeenCalledTimes(1);
    expect(term.paste).toHaveBeenCalledWith('clipboard paste');
  });

  test('reload rehydration: a shell that exits during replay stays exited', async () => {
    deferTerminalWrites = true;
    const { bridge, terminal, pushExit } = makeBridge(
      { ok: true, ptyId: 'pty-fresh' },
      WIRED,
      async () => ({ ok: true, replay: 'REPLAYED-SCREEN-BYTES' }),
    );
    render(<TerminalPanel bridge={bridge} adoptPtyId="pty-survivor" />);

    await waitFor(() => expect(terminal.onExit).toHaveBeenCalledTimes(1));
    act(() => pushExit({ ptyId: 'pty-survivor', exitCode: 1, signal: null }));
    act(() => lastTerm?.flushPendingWrites());

    expect(document.querySelector('[data-terminal-status="exited"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart terminal' })).toBeTruthy();
    expect(lastTerm?.focus).not.toHaveBeenCalled();
  });

  test('reload rehydration: restores a standing unsupported-shell capability notice', async () => {
    const { bridge, terminal } = makeBridge(
      { ok: true, ptyId: 'pty-fresh' },
      WIRED,
      async () => ({
        ok: true,
        replay: '',
        shellNoticeReason: 'unsupported-family',
      }),
      'win32',
    );
    render(<TerminalPanel bridge={bridge} adoptPtyId="pty-survivor" />);

    await waitFor(() => expect(terminal.adopt).toHaveBeenCalledWith('pty-survivor'));
    expect(screen.getByTestId('terminal-shell-notice-banner').textContent).toMatch(
      /\.ok\/local\/config\.yml.*PowerShell.*cmd\.exe.*Git Bash.*plain terminal only.*agent and command launches do not run/i,
    );
  });

  test('reload rehydration: a refused adopt (session died in the gap) falls through to a fresh create', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-fresh' }, WIRED, async () => ({
      ok: false,
      reason: 'unknown-session',
    }));
    render(<TerminalPanel bridge={bridge} adoptPtyId="pty-gone" />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(terminal.adopt).toHaveBeenCalledWith('pty-gone');
    expect(terminal.resize).not.toHaveBeenCalled();
  });

  test('reload rehydration: an adopt that throws is caught and falls through to a fresh create', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-fresh' }, WIRED, async () => {
      throw new Error('ipc boom');
    });
    render(<TerminalPanel bridge={bridge} adoptPtyId="pty-survivor" />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(terminal.adopt).toHaveBeenCalledWith('pty-survivor');
    expect(terminal.resize).not.toHaveBeenCalled();
  });

  test('reload rehydration: an unmount mid-adopt leaves the surviving session alive (does not kill it)', async () => {
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

    await waitFor(() => expect(terminal.adopt).toHaveBeenCalledWith('pty-survivor'));
    unmount();
    releaseAdopt?.();
    await act(async () => {});

    expect(terminal.kill).not.toHaveBeenCalled();
  });

  test('forwards xterm OSC 0/2 title changes to onTitleChange', async () => {
    const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
    const onTitleChange = vi.fn((_title: string) => {});
    render(<TerminalPanel bridge={bridge} onTitleChange={onTitleChange} />);

    await waitFor(() => expect(lastTerm?.onTitleChangeCb).toBeTruthy());

    act(() => lastTerm?.onTitleChangeCb?.('claude — repo'));
    expect(onTitleChange).toHaveBeenCalledWith('claude — repo');

    act(() => lastTerm?.onTitleChangeCb?.('claude — done'));
    expect(onTitleChange).toHaveBeenLastCalledWith('claude — done');
  });

  test('disposes the title listener on unmount', async () => {
    const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
    const onTitleChange = vi.fn((_title: string) => {});
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

  test('says the terminal is starting until the first shell byte, then gets out of the way (PRD-8313)', async () => {
    const { bridge, terminal, pushData } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('terminal-starting-notice')).toBeTruthy();

    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));

    expect(screen.queryByTestId('terminal-starting-notice')).toBeNull();
  });

  test('the starting notice never covers or click-blocks the readiness banner (PRD-8313)', async () => {
    const { bridge, pushData } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      { claude: 'present', mcp: 'needs-rewire' },
    );
    render(<TerminalPanel bridge={bridge} launch={{ prompt: null, cli: 'claude', nonce: 1 }} />);

    const banner = await screen.findByTestId('terminal-readiness-banner');
    const notice = screen.getByTestId('terminal-starting-notice');

    const containingBlock = notice.parentElement;
    expect(containingBlock).not.toBeNull();
    expect(containingBlock?.contains(banner)).toBe(false);
    expect(containingBlock?.className.split(/\s+/)).toContain('relative');
    expect(notice.className).toContain('pointer-events-none');
    expect(screen.getByRole('button', { name: 'Connect tools' })).toBeTruthy();

    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    expect(screen.queryByTestId('terminal-starting-notice')).toBeNull();
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
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());

    const container = document.querySelector('[data-terminal-status]');
    if (container === null) throw new Error('terminal container not found');

    const fileA = new File(['x'], 'shot.png', { type: 'image/png' });
    const fileB = new File(['y'], "a b's.png", { type: 'image/png' });
    const dataTransfer = { types: ['Files'], files: [fileA, fileB] };
    fireEvent.dragOver(container, { dataTransfer });
    fireEvent.drop(container, { dataTransfer });

    expect(terminal.input).toHaveBeenCalledWith(
      'pty-1',
      "'/dropped/shot.png' '/dropped/a b'\\''s.png' ",
    );
  });

  test('a PowerShell terminal doubles quotes in dropped Windows paths', async () => {
    const { bridge, terminal, pushNotice } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      WIRED,
      undefined,
      'win32',
    );
    (bridge as unknown as { getPathForFile: (file: File) => string }).getPathForFile = (file) =>
      `C:\\Users\\O'Brien\\${file.name}`;
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());
    act(() =>
      pushNotice({
        ptyId: 'pty-1',
        notice: 'shell-resolved',
        shellFamily: 'powershell',
      }),
    );

    const container = document.querySelector('[data-terminal-status]');
    if (container === null) throw new Error('terminal container not found');
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    const dataTransfer = { types: ['Files'], files: [file] };
    fireEvent.drop(container, { dataTransfer });

    expect(terminal.input).toHaveBeenCalledWith('pty-1', "'C:\\Users\\O''Brien\\shot.png' ");
  });

  test('a Git Bash terminal POSIX-quotes dropped Windows paths', async () => {
    const { bridge, terminal, pushNotice } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      WIRED,
      undefined,
      'win32',
    );
    (bridge as unknown as { getPathForFile: (file: File) => string }).getPathForFile = (file) =>
      `C:\\Users\\O'Brien\\${file.name}`;
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());
    act(() => pushNotice({ ptyId: 'pty-1', notice: 'shell-resolved', shellFamily: 'bash' }));

    const container = document.querySelector('[data-terminal-status]');
    if (container === null) throw new Error('terminal container not found');
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.drop(container, { dataTransfer: { types: ['Files'], files: [file] } });

    expect(terminal.input).toHaveBeenCalledWith('pty-1', "'C:\\Users\\O'\\''Brien\\shot.png' ");
  });

  test('a cmd terminal quotes safe paths and refuses variable-expanding paths', async () => {
    const { bridge, terminal, pushNotice } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      WIRED,
      undefined,
      'win32',
    );
    (bridge as unknown as { getPathForFile: (file: File) => string }).getPathForFile = (file) =>
      file.name === 'unsafe.png' ? 'C:\\Users\\%USERNAME%\\unsafe.png' : 'C:\\Users\\A B\\safe.png';
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());
    act(() => pushNotice({ ptyId: 'pty-1', notice: 'shell-resolved', shellFamily: 'cmd' }));

    const container = document.querySelector('[data-terminal-status]');
    if (container === null) throw new Error('terminal container not found');
    const safe = new File(['x'], 'safe.png', { type: 'image/png' });
    const unsafe = new File(['y'], 'unsafe.png', { type: 'image/png' });
    const dataTransfer = { types: ['Files'], files: [safe, unsafe] };
    fireEvent.drop(container, { dataTransfer });

    expect(terminal.input).toHaveBeenCalledWith('pty-1', '"C:\\Users\\A B\\safe.png" ');
    expect(screen.getByTestId('terminal-path-drop-notice-banner').textContent).toMatch(
      /could not be inserted safely/i,
    );
  });

  test('a drop where every file resolves to no disk path writes nothing (clipboard blobs)', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
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
    expect(screen.getByTestId('terminal-path-drop-notice-banner')).toBeTruthy();
  });

  test('a mixed drop writes only the files that resolve to a disk path', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
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

    expect(terminal.input).toHaveBeenCalledTimes(1);
    expect(terminal.input).toHaveBeenCalledWith('pty-1', "'/dropped/shot.png' ");
  });

  test('a dropped path containing a control char is filtered (no PTY command injection)', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());

    const container = document.querySelector('[data-terminal-status]');
    if (container === null) throw new Error('terminal container not found');

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

  test('a resize burst fits per event (no flicker) but coalesces PTY resizes: one leading, one trailing', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(roCallback).toBeTruthy());

    const fitsBefore = lastFit?.fit.mock.calls.length ?? 0;
    const resizesBefore = terminal.resize.mock.calls.length;
    act(() => {
      roCallback?.();
      roCallback?.();
      roCallback?.();
    });
    expect((lastFit?.fit.mock.calls.length ?? 0) - fitsBefore).toBe(3);
    expect(terminal.resize.mock.calls.length - resizesBefore).toBe(1);

    await waitFor(() => expect(terminal.resize.mock.calls.length - resizesBefore).toBe(2), {
      timeout: 1000,
    });
  });

  test('a grid-changing fit repaints synchronously in the same frame (no blank-frame flash)', async () => {
    const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(roCallback).toBeTruthy());

    act(() => roCallback?.());
    expect(lastTerm?.renderFlush).not.toHaveBeenCalled();

    lastFit?.fit.mockImplementation(() => {
      if (lastTerm) lastTerm.cols = 100;
    });
    act(() => roCallback?.());
    expect(lastTerm?.refresh).toHaveBeenCalled();
    expect(lastTerm?.renderFlush).toHaveBeenCalledTimes(1);
  });

  test('a grid-changing fit keeps a scrolled-back viewport on the line it was reading', async () => {
    const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(roCallback).toBeTruthy());

    if (lastTerm) {
      lastTerm.viewportY = 120;
      lastTerm.baseY = 120;
      lastTerm.scrollbarLine = 7;
    }
    lastFit?.fit.mockImplementation(() => {
      if (lastTerm) lastTerm.cols += 1;
    });
    act(() => roCallback?.());
    expect(lastTerm?.viewportY).toBe(120);
    expect(lastTerm?.scrollbarLine).toBe(7);
    expect(lastTerm?.pendingScrollTarget).toBeNull();
    expect(lastTerm?.smoothScrollWrites()).toBe(0);

    if (lastTerm) {
      lastTerm.viewportY = 34;
      lastTerm.scrollbarLine = 0;
      lastTerm.renderFlush.mockClear();
      lastTerm.scrollToBottom.mockClear();
    }
    act(() => roCallback?.());
    expect(lastTerm?.renderFlush.mock.invocationCallOrder[0]).toBeLessThan(
      lastTerm?.scrollToBottom.mock.invocationCallOrder[0] ?? 0,
    );
    expect(lastTerm?.viewportY).toBe(34);
    expect(lastTerm?.scrollbarLine).toBe(34);
    expect(lastTerm?.pendingScrollTarget).toBeNull();
    expect(lastTerm?.smoothScrollWrites()).toBe(2);
    expect(lastTerm?.options.smoothScrollDuration).toBe(125);

    if (lastTerm) {
      lastTerm.viewportY = 12;
      lastTerm.scrollbarLine = 3;
    }
    lastFit?.fit.mockImplementation(() => {});
    act(() => roCallback?.());
    expect(lastTerm?.viewportY).toBe(12);
    expect(lastTerm?.scrollbarLine).toBe(3);
    expect(lastTerm?.pendingScrollTarget).toBeNull();
  });

  test("the WebGL canvas's device-pixel re-clear also repaints in the same frame", async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));

    const canvas = document.querySelector('.xterm-screen canvas');
    expect(canvas).toBeTruthy();
    const canvasRO = allROs.find((ro) => ro.observed.some((o) => o.el === canvas));
    expect(canvasRO).toBeTruthy();
    expect(canvasRO?.observed[0]?.opts).toEqual({ box: 'device-pixel-content-box' });

    const flushesBefore = lastTerm?.renderFlush.mock.calls.length ?? 0;
    act(() => canvasRO?.cb());
    expect((lastTerm?.renderFlush.mock.calls.length ?? 0) - flushesBefore).toBe(1);
  });

  test('cancels the browser default for Shift+Tab only; every other key (incl. Escape) reaches the PTY', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());

    expect(lastTerm?.attachCustomKeyEventHandler).toHaveBeenCalledTimes(1);
    const handler = lastTerm?.keyHandler;
    expect(handler).toBeTruthy();

    const shiftTabPreventDefault = vi.fn(() => {});
    const shiftTab = {
      type: 'keydown',
      key: 'Tab',
      shiftKey: true,
      preventDefault: shiftTabPreventDefault,
    } as unknown as KeyboardEvent;
    expect(handler?.(shiftTab)).toBe(true);
    expect(shiftTabPreventDefault).toHaveBeenCalledTimes(1);

    const plainTabPreventDefault = vi.fn(() => {});
    const plainTab = {
      type: 'keydown',
      key: 'Tab',
      shiftKey: false,
      preventDefault: plainTabPreventDefault,
    } as unknown as KeyboardEvent;
    expect(handler?.(plainTab)).toBe(true);
    expect(plainTabPreventDefault).not.toHaveBeenCalled();

    const escapePreventDefault = vi.fn(() => {});
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

    const shiftEnterPreventDefault = vi.fn(() => {});
    const shiftEnter = {
      type: 'keydown',
      key: 'Enter',
      shiftKey: true,
      preventDefault: shiftEnterPreventDefault,
    } as unknown as KeyboardEvent;
    expect(handler?.(shiftEnter)).toBe(false);
    expect(shiftEnterPreventDefault).toHaveBeenCalledTimes(1);
    expect(terminal.input).toHaveBeenCalledWith('pty-1', '\n');

    const plainEnterPreventDefault = vi.fn(() => {});
    const plainEnter = {
      type: 'keydown',
      key: 'Enter',
      shiftKey: false,
      preventDefault: plainEnterPreventDefault,
    } as unknown as KeyboardEvent;
    expect(handler?.(plainEnter)).toBe(true);
    expect(plainEnterPreventDefault).not.toHaveBeenCalled();
  });

  test('Linux Ctrl+C and Ctrl+V bypass menu accelerators and still reach the PTY', async () => {
    const { bridge, terminal } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      WIRED,
      undefined,
      'linux',
    );
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());
    const handler = lastTerm?.keyHandler;
    expect(handler).toBeTruthy();

    for (const [key, bytes] of [
      ['c', '\x03'],
      ['v', '\x16'],
    ] as const) {
      const preventDefault = vi.fn(() => {});
      expect(
        handler?.({
          type: 'keydown',
          key,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          metaKey: false,
          preventDefault,
        } as unknown as KeyboardEvent),
      ).toBe(true);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      act(() => lastTerm?.onDataCb?.(bytes));
      expect(terminal.input).toHaveBeenLastCalledWith('pty-1', bytes);
    }
  });

  test('Linux Ctrl+Shift+C copies the xterm selection and Ctrl+Shift+V pastes clipboard text', async () => {
    const { bridge, terminal } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      WIRED,
      undefined,
      'linux',
    );
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());
    const handler = lastTerm?.keyHandler;
    expect(handler).toBeTruthy();
    if (lastTerm) lastTerm.selection = 'selected output';

    const copyPreventDefault = vi.fn(() => {});
    expect(
      handler?.({
        type: 'keydown',
        key: 'C',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        preventDefault: copyPreventDefault,
      } as unknown as KeyboardEvent),
    ).toBe(false);
    expect(copyPreventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected output'),
    );

    const pastePreventDefault = vi.fn(() => {});
    expect(
      handler?.({
        type: 'keydown',
        key: 'V',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        preventDefault: pastePreventDefault,
      } as unknown as KeyboardEvent),
    ).toBe(false);
    expect(pastePreventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(lastTerm?.paste).toHaveBeenCalledWith('clipboard paste'));
    expect(terminal.input).not.toHaveBeenCalledWith('pty-1', 'clipboard paste');
  });

  test('Linux Ctrl+Shift+C consumes the clipboard chord when xterm has no selection', async () => {
    const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' }, WIRED, undefined, 'linux');
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.keyHandler).toBeTruthy());

    const preventDefault = vi.fn(() => {});
    expect(
      lastTerm?.keyHandler?.({
        type: 'keydown',
        key: 'C',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        preventDefault,
      } as unknown as KeyboardEvent),
    ).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  test('Windows Ctrl+C copies with a selection and interrupts without one', async () => {
    const { bridge, terminal } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      WIRED,
      undefined,
      'win32',
    );
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.keyHandler).toBeTruthy());
    const handler = lastTerm?.keyHandler;

    if (lastTerm) lastTerm.selection = 'selected output';
    const copyPreventDefault = vi.fn(() => {});
    expect(
      handler?.({
        type: 'keydown',
        key: 'c',
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: copyPreventDefault,
      } as unknown as KeyboardEvent),
    ).toBe(false);
    expect(copyPreventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected output'),
    );

    vi.mocked(navigator.clipboard.writeText).mockClear();
    expect(lastTerm?.clearSelection).toHaveBeenCalledTimes(1);
    const interruptPreventDefault = vi.fn(() => {});
    expect(
      handler?.({
        type: 'keydown',
        key: 'c',
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: interruptPreventDefault,
      } as unknown as KeyboardEvent),
    ).toBe(true);
    expect(interruptPreventDefault).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    act(() => lastTerm?.onDataCb?.('\x03'));
    expect(terminal.input).toHaveBeenLastCalledWith('pty-1', '\x03');
  });

  test('Windows Ctrl+Shift+C copies and both Ctrl+V chords paste', async () => {
    const { bridge, terminal } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      WIRED,
      undefined,
      'win32',
    );
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.keyHandler).toBeTruthy());
    const handler = lastTerm?.keyHandler;
    if (lastTerm) lastTerm.selection = 'shift-selected';

    expect(
      handler?.({
        type: 'keydown',
        key: 'C',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        preventDefault: vi.fn(() => {}),
      } as unknown as KeyboardEvent),
    ).toBe(false);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('shift-selected'),
    );

    for (const shiftKey of [false, true]) {
      const preventDefault = vi.fn(() => {});
      expect(
        handler?.({
          type: 'keydown',
          key: 'V',
          ctrlKey: true,
          shiftKey,
          altKey: false,
          metaKey: false,
          preventDefault,
        } as unknown as KeyboardEvent),
      ).toBe(false);
      expect(preventDefault).toHaveBeenCalledTimes(1);
    }
    await waitFor(() => expect(lastTerm?.paste).toHaveBeenCalledTimes(2));
    expect(lastTerm?.paste).toHaveBeenNthCalledWith(1, 'clipboard paste');
    expect(lastTerm?.paste).toHaveBeenNthCalledWith(2, 'clipboard paste');
    expect(terminal.input).not.toHaveBeenCalledWith('pty-1', 'clipboard paste');
  });

  test('Linux paste ignores clipboard text that resolves after the terminal unmounts', async () => {
    let resolveClipboard: ((text: string) => void) | null = null;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(
          () =>
            new Promise<string>((resolve) => {
              resolveClipboard = resolve;
            }),
        ),
        writeText: vi.fn(async () => {}),
      },
    });
    const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' }, WIRED, undefined, 'linux');
    const { unmount } = render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.keyHandler).toBeTruthy());

    expect(
      lastTerm?.keyHandler?.({
        type: 'keydown',
        key: 'V',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        preventDefault: vi.fn(() => {}),
      } as unknown as KeyboardEvent),
    ).toBe(false);
    const term = lastTerm;
    unmount();
    await act(async () => resolveClipboard?.('late clipboard text'));

    expect(term?.paste).not.toHaveBeenCalled();
  });

  test('macOS leaves Ctrl+Shift+C and Ctrl+Shift+V on xterm’s existing path', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm?.onDataCb).toBeTruthy());
    const handler = lastTerm?.keyHandler;

    for (const key of ['C', 'V']) {
      const preventDefault = vi.fn(() => {});
      expect(
        handler?.({
          type: 'keydown',
          key,
          ctrlKey: true,
          shiftKey: true,
          altKey: false,
          metaKey: false,
          preventDefault,
        } as unknown as KeyboardEvent),
      ).toBe(true);
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
    expect(lastTerm?.paste).not.toHaveBeenCalled();
    expect(terminal.input).not.toHaveBeenCalledWith('pty-1', 'clipboard paste');
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
    const downTick = '\x1b[<65;40;12M';
    expect(payload.length).toBeGreaterThan(0);
    expect(payload.length % downTick.length).toBe(0);
    expect(payload.replaceAll(downTick, '')).toBe('');

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
    const ros = allROs.slice();
    expect(ros.length).toBe(2);
    act(() => unmount());

    expect(term?.dispose).toHaveBeenCalledTimes(1);
    expect(terminal.kill).toHaveBeenCalledWith('pty-1');
    expect(unsubData).toHaveBeenCalledTimes(1);
    expect(unsubExit).toHaveBeenCalledTimes(1);
    for (const ro of ros) expect(ro.disconnect).toHaveBeenCalledTimes(1);
  });

  test('leaves a PTY for reload adoption only while a non-bfcache pagehide remains active', async () => {
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    onTestFinished(() => {
      removeWindowListener.mockRestore();
      removeDocumentListener.mockRestore();
      if (originalVisibilityState === undefined) {
        Reflect.deleteProperty(document, 'visibilityState');
      } else {
        Object.defineProperty(document, 'visibilityState', originalVisibilityState);
      }
    });
    const first = makeBridge({ ok: true, ptyId: 'pty-reload' });
    const firstView = render(<TerminalPanel bridge={first.bridge} />);
    await waitFor(() => expect(first.terminal.create).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      firstView.unmount();
    });
    expect(first.terminal.kill).not.toHaveBeenCalled();
    expect(removeWindowListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    const second = makeBridge({ ok: true, ptyId: 'pty-bfcache' });
    const secondView = render(<TerminalPanel bridge={second.bridge} />);
    await waitFor(() => expect(second.terminal.create).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      secondView.unmount();
    });
    expect(second.terminal.kill).toHaveBeenCalledWith('pty-bfcache');

    const hidden = makeBridge({ ok: true, ptyId: 'pty-still-unloading' });
    const hiddenView = render(<TerminalPanel bridge={hidden.bridge} />);
    await waitFor(() => expect(hidden.terminal.create).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      hiddenView.unmount();
    });
    expect(hidden.terminal.kill).not.toHaveBeenCalled();

    const visible = makeBridge({ ok: true, ptyId: 'pty-restored' });
    const visibleView = render(<TerminalPanel bridge={visible.bridge} />);
    await waitFor(() => expect(visible.terminal.create).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      visibleView.unmount();
    });
    expect(visible.terminal.kill).toHaveBeenCalledWith('pty-restored');
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

  test('shows a translated pane notice when an invalid shell override is skipped', async () => {
    const { bridge, terminal, pushNotice } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      WIRED,
      undefined,
      'win32',
    );
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(terminal.onNotice).toHaveBeenCalledTimes(1));

    act(() =>
      pushNotice({ ptyId: 'pty-1', notice: 'invalid-shell-override', reason: 'not-found' }),
    );

    const banner = screen.getByTestId('terminal-shell-notice-banner');
    expect(banner.textContent).toMatch(/terminal\.shell executable.*was not found/i);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('terminal-shell-notice-banner')).toBeNull();
  });

  test('explains the capability boundary for an unsupported Windows shell override', async () => {
    const { bridge, terminal, pushNotice } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      WIRED,
      undefined,
      'win32',
    );
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(terminal.onNotice).toHaveBeenCalledTimes(1));

    act(() =>
      pushNotice({
        ptyId: 'pty-1',
        notice: 'invalid-shell-override',
        reason: 'unsupported-family',
      }),
    );

    expect(screen.getByTestId('terminal-shell-notice-banner').textContent).toMatch(
      /\.ok\/local\/config\.yml.*PowerShell.*cmd\.exe.*Git Bash.*plain terminal only.*agent and command launches do not run/i,
    );
  });

  test('does not lose a shell notice delivered before create resolves', async () => {
    const h = makeBridge({ ok: true, ptyId: 'pty-1' }, WIRED, undefined, 'win32');
    h.terminal.create.mockImplementationOnce(async () => {
      h.pushNotice({
        ptyId: 'pty-1',
        notice: 'invalid-shell-override',
        reason: 'not-found',
      });
      return { ok: true as const, ptyId: 'pty-1' };
    });

    render(<TerminalPanel bridge={h.bridge} />);

    expect((await screen.findByTestId('terminal-shell-notice-banner')).textContent).toMatch(
      /terminal\.shell executable.*was not found/i,
    );
  });

  test.each([
    ['containment-refused', /not safely contained.*not a link.*approve OpenKnowledge/i],
    ['write-failed', /\.ok\/local\/terminal.*folder is writable.*approve OpenKnowledge/i],
  ] as const)('shows the support-file degradation notice for %s', async (reason, copy) => {
    const { bridge, terminal, pushNotice } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      WIRED,
      undefined,
      'win32',
    );
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(terminal.onNotice).toHaveBeenCalledTimes(1));

    act(() => pushNotice({ ptyId: 'pty-1', notice: 'support-file-degraded', reason }));

    const banner = screen.getByTestId('terminal-support-file-notice-banner');
    expect(banner.textContent).toMatch(copy);
  });

  test('shows one operational notice at a time and reveals the next after dismissal', async () => {
    const { bridge, terminal, pushNotice } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      WIRED,
      undefined,
      'win32',
    );
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(terminal.onNotice).toHaveBeenCalledTimes(1));

    act(() => {
      pushNotice({ ptyId: 'pty-1', notice: 'invalid-shell-override', reason: 'not-found' });
      pushNotice({ ptyId: 'pty-1', notice: 'support-file-degraded', reason: 'write-failed' });
    });

    expect(screen.getByTestId('terminal-support-file-notice-banner')).toBeTruthy();
    expect(screen.queryByTestId('terminal-shell-notice-banner')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByTestId('terminal-shell-notice-banner')).toBeTruthy();
  });

  test('a new launch clears shell and dropped-path notices from the previous session', async () => {
    const { bridge, terminal, pushNotice } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      WIRED,
      undefined,
      'win32',
    );
    (bridge as unknown as { getPathForFile: (file: File) => string }).getPathForFile = () =>
      'C:\\Users\\%USERNAME%\\unsafe.png';
    const { rerender } = render(
      <TerminalPanel bridge={bridge} launch={{ prompt: null, cli: 'claude', nonce: 1 }} />,
    );
    await waitFor(() => expect(terminal.onNotice).toHaveBeenCalledTimes(1));

    act(() => {
      pushNotice({ ptyId: 'pty-1', notice: 'shell-resolved', shellFamily: 'cmd' });
      pushNotice({ ptyId: 'pty-1', notice: 'invalid-shell-override', reason: 'not-found' });
    });
    const container = document.querySelector('[data-terminal-status]');
    if (container === null) throw new Error('terminal container not found');
    fireEvent.drop(container, {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['x'], 'unsafe.png', { type: 'image/png' })],
      },
    });

    rerender(<TerminalPanel bridge={bridge} launch={{ prompt: null, cli: 'claude', nonce: 2 }} />);
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('terminal-shell-notice-banner')).toBeNull();
    expect(screen.queryByTestId('terminal-path-drop-notice-banner')).toBeNull();
  });

  test('shows operational notices before the routine manual-submit notice', async () => {
    const { bridge, terminal, pushNotice } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      WIRED,
      undefined,
      'win32',
    );
    (bridge as unknown as { getPathForFile: (file: File) => string }).getPathForFile = () =>
      'C:\\Users\\%USERNAME%\\unsafe.png';
    render(
      <TerminalPanel
        bridge={bridge}
        launch={{ prompt: 'review this safely', cli: 'claude', nonce: 1 }}
      />,
    );
    await waitFor(() =>
      expect(document.querySelector('[data-terminal-status="running"]')).not.toBeNull(),
    );

    act(() => {
      pushNotice({ ptyId: 'pty-1', notice: 'shell-resolved', shellFamily: 'cmd' });
      pushNotice({ ptyId: 'pty-1', notice: 'invalid-shell-override', reason: 'not-found' });
      pushNotice({ ptyId: 'pty-1', notice: 'support-file-degraded', reason: 'write-failed' });
    });
    const container = document.querySelector('[data-terminal-status]');
    if (container === null) throw new Error('terminal container not found');
    fireEvent.drop(container, {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['x'], 'unsafe.png', { type: 'image/png' })],
      },
    });

    await waitFor(() => expect(terminal.input).toHaveBeenCalled(), { timeout: 6_000 });
    expect(screen.getByTestId('terminal-path-drop-notice-banner')).toBeTruthy();
    expect(screen.queryByTestId('terminal-manual-submit-notice-banner')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByTestId('terminal-support-file-notice-banner')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByTestId('terminal-shell-notice-banner')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByTestId('terminal-manual-submit-notice-banner')).toBeTruthy();
  }, 10_000);

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
    const onClose = vi.fn(() => {});
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
    const kill = vi.fn(async (_id: string) => {});
    const terminal = {
      create: vi.fn(() => createPromise),
      input: vi.fn(() => {}),
      resize: vi.fn(() => {}),
      kill,
      drain: vi.fn(() => {}),
      onData: vi.fn(() => vi.fn(() => {})),
      onExit: vi.fn(() => vi.fn(() => {})),
      onNotice: vi.fn(() => vi.fn(() => {})),
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

  test('a claude launch probes readiness and shows a help affordance when claude is not on PATH', async () => {
    const { bridge, terminal, openExternal } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      { claude: 'not-found', mcp: 'needs-rewire' },
    );
    render(<TerminalPanel bridge={bridge} launch={{ prompt: null, cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.claudePreflight).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/isn't installed or on your PATH/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Get Claude Code' }));
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal.mock.calls[0]?.[0]).toContain('claude-code');
  });

  test('a claude launch shows a re-wire affordance when claude is present but OK tools are not wired', async () => {
    const { bridge, rewireClaudeMcp } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      { claude: 'present', mcp: 'needs-rewire' },
    );
    render(<TerminalPanel bridge={bridge} launch={{ prompt: null, cli: 'claude', nonce: 1 }} />);

    expect(await screen.findByText(/aren't connected to it yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect tools' }));
    expect(rewireClaudeMcp).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull());
  });

  test('a claude launch shows no readiness banner when claude is present and OK tools are wired', async () => {
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' }, WIRED);
    render(<TerminalPanel bridge={bridge} launch={{ prompt: null, cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.claudePreflight).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull();
  });

  test('the readiness banner is dismissible', async () => {
    const { bridge } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      { claude: 'not-found', mcp: 'needs-rewire' },
    );
    render(<TerminalPanel bridge={bridge} launch={{ prompt: null, cli: 'claude', nonce: 1 }} />);

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
      create: vi.fn(async () => {
        createCalls += 1;
        if (createCalls === 1) throw new Error('fork EMFILE');
        await createGate;
        return { ok: true, ptyId: 'pty-restarted' } as const;
      }),
      input: vi.fn(() => {}),
      resize: vi.fn(() => {}),
      kill: vi.fn(async () => {}),
      drain: vi.fn(() => {}),
      onData: vi.fn(() => vi.fn(() => {})),
      onExit: vi.fn(() => vi.fn(() => {})),
      onNotice: vi.fn(() => vi.fn(() => {})),
      claudePreflight: vi.fn(async () => WIRED),
      cliPreflight: vi.fn(async () => ({ onPath: 'present' as const })),
      rewireClaudeMcp: vi.fn(async () => WIRED),
    };
    const bridge = {
      terminal,
      shell: { openExternal: vi.fn(async () => {}) },
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
    render(<TerminalPanel bridge={bridge} launch={{ prompt: null, cli: 'claude', nonce: 1 }} />);

    await screen.findByText(/isn't installed or on your PATH/);

    act(() => pushExit({ ptyId: 'pty-1', exitCode: 0, signal: null }));
    await waitFor(() => expect(screen.queryByText(/isn't installed or on your PATH/)).toBeNull());
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  test('a plain tab (no launch intent) shows no claude-readiness banner even when claude is not on PATH', async () => {
    const { bridge } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      { claude: 'not-found', mcp: 'needs-rewire' },
    );
    render(<TerminalPanel bridge={bridge} />);

    await waitFor(() =>
      expect(document.querySelector('[data-terminal-status="running"]')).toBeTruthy(),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull();
    expect(screen.queryByText(/isn't installed or on your PATH/)).toBeNull();
  });

  test('a plain tab (no launch intent) shows no MCP-rewire nudge either', async () => {
    const { bridge } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      { claude: 'present', mcp: 'needs-rewire' },
    );
    render(<TerminalPanel bridge={bridge} />);

    await waitFor(() =>
      expect(document.querySelector('[data-terminal-status="running"]')).toBeTruthy(),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull();
    expect(screen.queryByText(/aren't connected to it yet/)).toBeNull();
  });

  test('a "run this command" tab shows no claude-readiness banner (no CLI is involved)', async () => {
    const { bridge } = makeBridge(
      { ok: true, ptyId: 'pty-1' },
      { claude: 'not-found', mcp: 'needs-rewire' },
    );
    render(<TerminalPanel bridge={bridge} commandId="install-slidev" />);

    await waitFor(() =>
      expect(document.querySelector('[data-terminal-status="running"]')).toBeTruthy(),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull();
    expect(screen.queryByText(/isn't installed or on your PATH/)).toBeNull();
  });

  test('an adopted tab (reload survivor) shows no claude-readiness banner', async () => {
    const { bridge } = makeBridge(
      { ok: true, ptyId: 'pty-ignored' },
      { claude: 'not-found', mcp: 'needs-rewire' },
    );
    render(<TerminalPanel bridge={bridge} adoptPtyId="surv-1" />);

    await waitFor(() =>
      expect(document.querySelector('[data-terminal-status="running"]')).toBeTruthy(),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull();
    expect(screen.queryByText(/isn't installed or on your PATH/)).toBeNull();
  });

  test('an adopted tab that still carries a stale claude launch intent shows no readiness banner', async () => {
    const { bridge } = makeBridge(
      { ok: true, ptyId: 'pty-ignored' },
      { claude: 'not-found', mcp: 'needs-rewire' },
    );
    render(
      <TerminalPanel
        bridge={bridge}
        adoptPtyId="surv-1"
        launch={{ prompt: null, cli: 'claude', nonce: 1 }}
      />,
    );

    await waitFor(() =>
      expect(document.querySelector('[data-terminal-status="running"]')).toBeTruthy(),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull();
    expect(screen.queryByText(/isn't installed or on your PATH/)).toBeNull();
  });

  test('constructs xterm with the palette for the resolved app theme', async () => {
    mockResolvedTheme = 'light';
    const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
    render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(lastTerm).not.toBeNull());
    expect(lastTerm?.options.theme).toEqual(XTERM_LIGHT_THEME);

    cleanup();
    lastTerm = null;
    mockResolvedTheme = 'dark';
    const second = makeBridge({ ok: true, ptyId: 'pty-2' });
    render(<TerminalPanel bridge={second.bridge} />);
    await waitFor(() => expect(lastTerm).not.toBeNull());
    expect(lastTerm?.options.theme).toEqual(XTERM_DARK_THEME);
  });

  test('re-skins the live terminal on a theme switch without respawning the PTY', async () => {
    mockResolvedTheme = 'dark';
    const { bridge, terminal } = makeBridge({ ok: true, ptyId: 'pty-1' });
    const { rerender } = render(<TerminalPanel bridge={bridge} />);
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));

    const term = lastTerm;
    expect(term?.options.theme).toEqual(XTERM_DARK_THEME);

    mockResolvedTheme = 'light';
    rerender(<TerminalPanel bridge={bridge} />);

    await waitFor(() => expect(lastTerm?.options.theme).toEqual(XTERM_LIGHT_THEME));
    expect(lastTerm).toBe(term);
    expect(term?.dispose).not.toHaveBeenCalled();
    expect(terminal.create).toHaveBeenCalledTimes(1);
    expect(terminal.kill).not.toHaveBeenCalled();
  });

  test('restarting one session spawns a fresh PTY for it without disturbing a sibling', async () => {
    const exitSubs: Array<(m: OkPtyExit) => void> = [];
    let created = 0;
    const create = vi.fn(async () => {
      created += 1;
      return { ok: true as const, ptyId: `pty-${created}` };
    });
    const kill = vi.fn(async (_id: string) => {});
    const terminal = {
      create,
      input: vi.fn(() => {}),
      resize: vi.fn(() => {}),
      kill,
      drain: vi.fn(() => {}),
      onData: vi.fn(() => vi.fn(() => {})),
      onExit: vi.fn((cb: (m: OkPtyExit) => void) => {
        exitSubs.push(cb);
        return vi.fn(() => {});
      }),
      onNotice: vi.fn(() => vi.fn(() => {})),
      claudePreflight: vi.fn(async () => WIRED),
      rewireClaudeMcp: vi.fn(async () => WIRED),
    };
    const bridge = {
      terminal,
      shell: { openExternal: vi.fn(async () => {}) },
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

  describe('clickable links', () => {
    function provide(
      term: MockTerminal,
      bufferLine = 1,
    ): Promise<Array<{ activate: (e: MouseEvent, t: string) => void; text: string }>> {
      return new Promise((resolve) => {
        term.linkProvider?.provideLinks(bufferLine, (links) =>
          resolve(
            (links ?? []) as Array<{ activate: (e: MouseEvent, t: string) => void; text: string }>,
          ),
        );
      });
    }

    test('routes URL clicks (WebLinksAddon + OSC 8) through the bridge', async () => {
      const { bridge, openExternal } = makeBridge({ ok: true, ptyId: 'pty-1' });
      render(<TerminalPanel bridge={bridge} />);
      await waitFor(() => expect(lastTerm).not.toBeNull());

      expect(lastWebLinksHandler).not.toBeNull();
      lastWebLinksHandler?.({} as MouseEvent, 'https://example.com');
      expect(openExternal).toHaveBeenCalledWith('https://example.com');

      const linkHandler = lastTerm?.options.linkHandler as
        | { activate: (e: MouseEvent, uri: string) => void }
        | undefined;
      linkHandler?.activate({} as MouseEvent, 'https://osc8.example');
      expect(openExternal).toHaveBeenCalledWith('https://osc8.example');
    });

    test('registers a file-path link provider once the panel mounts', async () => {
      const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
      render(<TerminalPanel bridge={bridge} />);
      await waitFor(() => expect(lastTerm?.linkProvider).toBeTruthy());
    });

    test('clicking a markdown path navigates the editor to the doc', async () => {
      const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
      render(<TerminalPanel bridge={bridge} />);
      await waitFor(() => expect(lastTerm?.linkProvider).toBeTruthy());
      const term = lastTerm as MockTerminal;
      term.lineText = 'edited notes/a.md';

      const [link] = await provide(term);
      expect(link?.text).toBe('notes/a.md');
      window.location.hash = '';
      link?.activate({} as MouseEvent, link.text);
      expect(window.location.hash).toBe('#/notes/a');
    });

    test('stitches a path wrapped across buffer rows and navigates it', async () => {
      const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
      render(<TerminalPanel bridge={bridge} />);
      await waitFor(() => expect(lastTerm?.linkProvider).toBeTruthy());
      const term = lastTerm as MockTerminal;
      term.cols = 19;
      term.lineRows = ['see docs/guide/very', '-long.md'];

      const [link] = await provide(term);
      expect(link?.text).toBe('docs/guide/very-long.md');
      window.location.hash = '';
      link?.activate({} as MouseEvent, link.text);
      expect(window.location.hash).toBe('#/docs/guide/very-long');
    });

    test('reconstructs a wrapped path when its continuation row is hovered (backward walk)', async () => {
      const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
      render(<TerminalPanel bridge={bridge} />);
      await waitFor(() => expect(lastTerm?.linkProvider).toBeTruthy());
      const term = lastTerm as MockTerminal;
      term.cols = 19;
      term.lineRows = ['see docs/guide/very', '-long.md'];
      const [link] = await provide(term, 2);
      expect(link?.text).toBe('docs/guide/very-long.md');
      window.location.hash = '';
      link?.activate({} as MouseEvent, link.text);
      expect(window.location.hash).toBe('#/docs/guide/very-long');
    });

    test('clicking a trailing-slash folder navigates the editor to that folder', async () => {
      const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
      render(<TerminalPanel bridge={bridge} />);
      await waitFor(() => expect(lastTerm?.linkProvider).toBeTruthy());
      const term = lastTerm as MockTerminal;
      term.lineText = 'cd packages/app/';

      const [link] = await provide(term);
      expect(link?.text).toBe('packages/app');
      window.location.hash = '';
      link?.activate({} as MouseEvent, link.text);
      expect(window.location.hash).toBe('#/packages/app/');
    });

    test('a non-blocked openAsset failure surfaces silently — no reveal fallback', async () => {
      const { bridge, openAsset, revealAsset } = makeBridge({ ok: true, ptyId: 'pty-1' });
      render(<TerminalPanel bridge={bridge} />);
      await waitFor(() => expect(lastTerm?.linkProvider).toBeTruthy());
      const term = lastTerm as MockTerminal;
      term.lineText = 'wrote data/x.csv';

      const [link] = await provide(term);
      openAsset.mockResolvedValueOnce({ ok: false, reason: 'not-found' });
      link?.activate({} as MouseEvent, link.text);
      await waitFor(() => expect(openAsset).toHaveBeenCalledWith('data/x.csv'));
      expect(revealAsset).not.toHaveBeenCalled();
    });

    test('disposes the file-link provider on unmount', async () => {
      const { bridge } = makeBridge({ ok: true, ptyId: 'pty-1' });
      const { unmount } = render(<TerminalPanel bridge={bridge} />);
      await waitFor(() => expect(lastTerm?.linkProvider).toBeTruthy());
      const term = lastTerm as MockTerminal;
      unmount();
      expect(term.linkProviderDispose).toHaveBeenCalledTimes(1);
    });

    test('clicking a non-doc path OS-delegates via openAsset, revealing on block', async () => {
      const { bridge, openAsset, revealAsset } = makeBridge({ ok: true, ptyId: 'pty-1' });
      render(<TerminalPanel bridge={bridge} />);
      await waitFor(() => expect(lastTerm?.linkProvider).toBeTruthy());
      const term = lastTerm as MockTerminal;
      term.lineText = 'wrote data/x.csv';

      const [link] = await provide(term);
      expect(link?.text).toBe('data/x.csv');
      link?.activate({} as MouseEvent, link.text);
      await waitFor(() => expect(openAsset).toHaveBeenCalledWith('data/x.csv'));

      openAsset.mockResolvedValueOnce({ ok: false, reason: 'extension-blocked' });
      link?.activate({} as MouseEvent, link.text);
      await waitFor(() => expect(revealAsset).toHaveBeenCalledWith('data/x.csv'));
    });

    test('clicking an out-of-project absolute path routes the reveal-external dialog', async () => {
      const { bridge, revealExternal } = makeBridge({ ok: true, ptyId: 'pty-1' });
      render(<TerminalPanel bridge={bridge} />);
      await waitFor(() => expect(lastTerm?.linkProvider).toBeTruthy());
      const term = lastTerm as MockTerminal;
      term.lineText = 'built /tmp/out/report.pdf';
      const [link] = await provide(term);
      expect(link?.text).toBe('/tmp/out/report.pdf');
      link?.activate({} as MouseEvent, link.text);
      await waitFor(() => expect(revealExternal).toHaveBeenCalledWith('/tmp/out/report.pdf'));
    });

    test('defers URL clicks to a mouse-tracking TUI (no double-open with claude)', async () => {
      const { bridge, openExternal } = makeBridge({ ok: true, ptyId: 'pty-1' });
      render(<TerminalPanel bridge={bridge} />);
      await waitFor(() => expect(lastTerm).not.toBeNull());
      (lastTerm as MockTerminal).modes.mouseTrackingMode = 'any';
      lastWebLinksHandler?.({} as MouseEvent, 'https://example.com');
      const osc8 = lastTerm?.options.linkHandler as {
        activate: (e: MouseEvent, u: string) => void;
      };
      osc8.activate({} as MouseEvent, 'https://example.com');
      expect(openExternal).not.toHaveBeenCalled();
    });

    test('still opens FILE clicks inside a mouse-tracking TUI (only URLs defer)', async () => {
      const { bridge, openAsset } = makeBridge({ ok: true, ptyId: 'pty-1' });
      render(<TerminalPanel bridge={bridge} />);
      await waitFor(() => expect(lastTerm?.linkProvider).toBeTruthy());
      const term = lastTerm as MockTerminal;
      term.lineText = 'wrote data/x.csv';
      const [link] = await provide(term);
      term.modes.mouseTrackingMode = 'any';
      link?.activate({} as MouseEvent, link.text);
      await waitFor(() => expect(openAsset).toHaveBeenCalledWith('data/x.csv'));
    });
  });
});
