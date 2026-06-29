import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type {
  ClaudeReadiness,
  CliReadiness,
  OkDesktopBridge,
  OkPtyData,
} from '@/lib/desktop-bridge-types';

class MockFitAddon {
  fit = mock(() => {});
}
class MockWebglAddon {}
class MockWebLinksAddon {}
class MockUnicode11Addon {}

class MockTerminal {
  cols = 80;
  rows = 24;
  unicode = { activeVersion: '6' };
  onDataCb: ((d: string) => void) | null = null;
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  options: Record<string, unknown>;
  open = mock(() => {});
  focus = mock(() => {});
  dispose = mock(() => {});
  write = mock((_data: string, cb?: () => void) => {
    cb?.();
  });
  loadAddon = mock(() => {});
  onData = mock((cb: (d: string) => void) => {
    this.onDataCb = cb;
    return { dispose() {} };
  });
  onTitleChange = mock((_cb: (title: string) => void) => ({ dispose() {} }));
  attachCustomKeyEventHandler = mock((h: (e: KeyboardEvent) => boolean) => {
    this.keyHandler = h;
  });
  attachCustomWheelEventHandler = mock(() => {});
  constructor(options: Record<string, unknown>) {
    this.options = options;
  }
}

class MockResizeObserver {
  observe = mock(() => {});
  unobserve = mock(() => {});
  disconnect = mock(() => {});
}

mock.module('@xterm/xterm', () => ({ Terminal: MockTerminal }));
mock.module('@xterm/addon-fit', () => ({ FitAddon: MockFitAddon }));
mock.module('@xterm/addon-webgl', () => ({ WebglAddon: MockWebglAddon }));
mock.module('@xterm/addon-web-links', () => ({ WebLinksAddon: MockWebLinksAddon }));
mock.module('@xterm/addon-unicode11', () => ({ Unicode11Addon: MockUnicode11Addon }));
mock.module('@xterm/xterm/css/xterm.css', () => ({}));

/** Fully ready: claude on PATH, OK tools wired, AND the project's own
 *  `open-knowledge` entry verified as OK's canonical server (mcpPreApprovable),
 *  so the launch pre-approves it. */
const WIRED: ClaudeReadiness = { claude: 'present', mcp: 'wired', mcpPreApprovable: true };
/** Claude ready, but the project's `open-knowledge` entry is NOT OK's own (a
 *  foreign/tampered shared-project entry) — pre-approval must be withheld. */
const WIRED_FOREIGN_PROJECT: ClaudeReadiness = {
  claude: 'present',
  mcp: 'wired',
  mcpPreApprovable: false,
};
const ON_PATH: CliReadiness = { onPath: 'present' };

function makeBridge(preflight: ClaudeReadiness = WIRED, cliReadiness: CliReadiness = ON_PATH) {
  const dataSubs: Array<(m: OkPtyData) => void> = [];
  const terminal = {
    create: mock(async () => ({ ok: true as const, ptyId: 'pty-1' })),
    input: mock((_id: string, _d: string) => {}),
    resize: mock(() => {}),
    kill: mock(async () => {}),
    drain: mock(() => {}),
    onData: mock((cb: (m: OkPtyData) => void) => {
      dataSubs.push(cb);
      return mock(() => {});
    }),
    onExit: mock(() => mock(() => {})),
    claudePreflight: mock(async () => preflight),
    cliPreflight: mock(async (_cli: TerminalCli) => cliReadiness),
    rewireClaudeMcp: mock(async () => preflight),
  };
  return {
    bridge: {
      terminal,
      shell: { openExternal: mock(async () => {}) },
      config: { e2eSmoke: false },
    } as unknown as OkDesktopBridge,
    terminal,
    pushData: (m: OkPtyData) => {
      for (const f of dataSubs) f(m);
    },
  };
}

const { TerminalPanel } = await import('./TerminalPanel');

/** Inputs the user typed are forwarded verbatim; the launch is the only call
 *  that goes through `buildCliLaunchCommand`. Filter to the launch shape for a
 *  given binary prefix. */
function launchWrites(inputMock: ReturnType<typeof mock>, bin = 'claude'): string[] {
  return inputMock.mock.calls
    .map((c) => c[1] as string)
    .filter((d) => typeof d === 'string' && d.startsWith(`${bin} `));
}

const CLAUDE_PRE = `--settings '{"enabledMcpjsonServers":["open-knowledge"]}'`;

describe('TerminalPanel "Open in terminal" launch', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
  });
  afterEach(() => {
    cleanup();
  });

  test("writes `claude --settings '<json>' '<escaped prompt>'` exactly once on running, after first output", async () => {
    const { bridge, terminal, pushData } = makeBridge(WIRED);
    const prompt = "Let's work on `foo.md` using OpenKnowledge.";
    const { rerender } = render(
      <TerminalPanel bridge={bridge} launch={{ prompt, cli: 'claude', nonce: 1 }} />,
    );

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(terminal.claudePreflight).toHaveBeenCalled());

    await waitFor(() => expect(launchWrites(terminal.input).length).toBe(1));
    expect(launchWrites(terminal.input)[0]).toBe(
      `claude ${CLAUDE_PRE} 'Let'\\''s work on \`foo.md\` using OpenKnowledge.'\r`,
    );

    rerender(<TerminalPanel bridge={bridge} launch={{ prompt, cli: 'claude', nonce: 1 }} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(launchWrites(terminal.input).length).toBe(1);
  });

  test('does NOT write a launch before the shell is running', async () => {
    const terminal = {
      create: mock(() => new Promise(() => {})),
      input: mock(() => {}),
      resize: mock(() => {}),
      kill: mock(async () => {}),
      drain: mock(() => {}),
      onData: mock(() => mock(() => {})),
      onExit: mock(() => mock(() => {})),
      claudePreflight: mock(async () => WIRED),
      cliPreflight: mock(async () => ON_PATH),
      rewireClaudeMcp: mock(async () => WIRED),
    };
    const bridge = {
      terminal,
      shell: { openExternal: mock(async () => {}) },
      config: { e2eSmoke: false },
    } as unknown as OkDesktopBridge;

    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(launchWrites(terminal.input).length).toBe(0);
  });

  test('does NOT write the command when claude is not found (the banner handles remediation)', async () => {
    const { bridge, terminal, pushData } = makeBridge({
      claude: 'not-found',
      mcp: 'needs-rewire',
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(terminal.claudePreflight).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    expect(launchWrites(terminal.input).length).toBe(0);
  });

  test('launches when claude is present even if OK tools need a rewire (bare — no pre-approval)', async () => {
    const { bridge, terminal, pushData } = makeBridge({
      claude: 'present',
      mcp: 'needs-rewire',
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(terminal.claudePreflight).toHaveBeenCalled());

    await waitFor(() => expect(launchWrites(terminal.input).length).toBe(1));
    expect(launchWrites(terminal.input)[0]).toBe("claude 'hi'\r");
  });

  test("does NOT pre-approve when the project MCP entry is not OK's own (mcpPreApprovable false)", async () => {
    const { bridge, terminal, pushData } = makeBridge(WIRED_FOREIGN_PROJECT);
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(terminal.claudePreflight).toHaveBeenCalled());

    await waitFor(() => expect(launchWrites(terminal.input).length).toBe(1));
    expect(launchWrites(terminal.input)[0]).toBe("claude 'hi'\r");
    expect(launchWrites(terminal.input)[0]).not.toContain('--settings');
  });

  test('re-verifies pre-approval at LAUNCH time, not mount time (TOCTOU)', async () => {
    const dataSubs: Array<(m: OkPtyData) => void> = [];
    let preflightCalls = 0;
    const terminal = {
      create: mock(async () => ({ ok: true as const, ptyId: 'pty-1' })),
      input: mock((_id: string, _d: string) => {}),
      resize: mock(() => {}),
      kill: mock(async () => {}),
      drain: mock(() => {}),
      onData: mock((cb: (m: OkPtyData) => void) => {
        dataSubs.push(cb);
        return mock(() => {});
      }),
      onExit: mock(() => mock(() => {})),
      claudePreflight: mock(async () => (preflightCalls++ === 0 ? WIRED : WIRED_FOREIGN_PROJECT)),
      cliPreflight: mock(async () => ON_PATH),
      rewireClaudeMcp: mock(async () => WIRED),
    };
    const bridge = {
      terminal,
      shell: { openExternal: mock(async () => {}) },
      config: { e2eSmoke: false },
    } as unknown as OkDesktopBridge;
    const pushData = (m: OkPtyData) => {
      for (const f of dataSubs) f(m);
    };

    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);
    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));

    await waitFor(() => expect(launchWrites(terminal.input).length).toBe(1));
    expect(launchWrites(terminal.input)[0]).toBe("claude 'hi'\r");
    expect(launchWrites(terminal.input)[0]).not.toContain('--settings');
    expect(terminal.claudePreflight.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('a launch-time preflight REJECTION suppresses the write + surfaces the readiness banner (parity with codex/cursor)', async () => {
    const dataSubs: Array<(m: OkPtyData) => void> = [];
    let calls = 0;
    const terminal = {
      create: mock(async () => ({ ok: true as const, ptyId: 'pty-1' })),
      input: mock((_id: string, _d: string) => {}),
      resize: mock(() => {}),
      kill: mock(async () => {}),
      drain: mock(() => {}),
      onData: mock((cb: (m: OkPtyData) => void) => {
        dataSubs.push(cb);
        return mock(() => {});
      }),
      onExit: mock(() => mock(() => {})),
      claudePreflight: mock(async () => {
        if (calls++ === 0) return WIRED;
        throw new Error('ipc boom');
      }),
      cliPreflight: mock(async () => ON_PATH),
      rewireClaudeMcp: mock(async () => WIRED),
    };
    const bridge = {
      terminal,
      shell: { openExternal: mock(async () => {}) },
      config: { e2eSmoke: false },
    } as unknown as OkDesktopBridge;
    const pushData = (m: OkPtyData) => {
      for (const f of dataSubs) f(m);
    };

    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);
    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(terminal.claudePreflight).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });

    expect(launchWrites(terminal.input).length).toBe(0);
    await screen.findByText(/Claude Code \(claude\) isn't installed/);
  });

  test('a same-nonce effect re-run during the launch preflight window does not drop the launch', async () => {
    const dataSubs: Array<(m: OkPtyData) => void> = [];
    let calls = 0;
    const deferreds: Array<(r: ClaudeReadiness) => void> = [];
    const terminal = {
      create: mock(async () => ({ ok: true as const, ptyId: 'pty-1' })),
      input: mock((_id: string, _d: string) => {}),
      resize: mock(() => {}),
      kill: mock(async () => {}),
      drain: mock(() => {}),
      onData: mock((cb: (m: OkPtyData) => void) => {
        dataSubs.push(cb);
        return mock(() => {});
      }),
      onExit: mock(() => mock(() => {})),
      claudePreflight: mock(() =>
        calls++ === 0
          ? Promise.resolve(WIRED)
          : new Promise<ClaudeReadiness>((resolve) => {
              deferreds.push(resolve);
            }),
      ),
      cliPreflight: mock(async () => ON_PATH),
      rewireClaudeMcp: mock(async () => WIRED),
    };
    const bridge = {
      terminal,
      shell: { openExternal: mock(async () => {}) },
      config: { e2eSmoke: false },
    } as unknown as OkDesktopBridge;
    const pushData = (m: OkPtyData) => {
      for (const f of dataSubs) f(m);
    };

    const { rerender } = render(
      <TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />,
    );
    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(deferreds.length).toBe(1));

    rerender(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);
    await waitFor(() => expect(deferreds.length).toBe(2));

    act(() => {
      for (const resolve of deferreds) resolve(WIRED);
    });

    await waitFor(() => expect(launchWrites(terminal.input).length).toBe(1));
    expect(launchWrites(terminal.input)[0]).toBe(`claude ${CLAUDE_PRE} 'hi'\r`);
  });

  test('a new nonce fires a second launch (repeat "Open in terminal" while running)', async () => {
    const { bridge, terminal, pushData } = makeBridge(WIRED);
    const { rerender } = render(
      <TerminalPanel bridge={bridge} launch={{ prompt: 'first', cli: 'claude', nonce: 1 }} />,
    );

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(launchWrites(terminal.input).length).toBe(1));

    rerender(
      <TerminalPanel bridge={bridge} launch={{ prompt: 'second', cli: 'claude', nonce: 2 }} />,
    );
    await waitFor(() => expect(launchWrites(terminal.input).length).toBe(2));
    expect(launchWrites(terminal.input)[1]).toBe(`claude ${CLAUDE_PRE} 'second'\r`);
  });

  test('codex launch probes cliPreflight and writes the codex command', async () => {
    const { bridge, terminal, pushData } = makeBridge(WIRED, ON_PATH);
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'codex', nonce: 1 }} />);

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(terminal.cliPreflight).toHaveBeenCalledTimes(1));
    expect(terminal.cliPreflight.mock.calls[0]?.[0]).toBe('codex');

    await waitFor(() => expect(launchWrites(terminal.input, 'codex').length).toBe(1));
    expect(launchWrites(terminal.input, 'codex')[0]).toBe("codex 'hi'\r");
  });

  test('cursor launch writes the cursor-agent command (the agent CLI, not the editor)', async () => {
    const { bridge, terminal, pushData } = makeBridge(WIRED, ON_PATH);
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'cursor', nonce: 1 }} />);

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(terminal.cliPreflight).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(launchWrites(terminal.input, 'cursor-agent').length).toBe(1));
    expect(launchWrites(terminal.input, 'cursor-agent')[0]).toBe("cursor-agent 'hi'\r");
  });

  test('codex not on PATH: suppresses the write and surfaces the missing-CLI banner', async () => {
    const { bridge, terminal, pushData } = makeBridge(WIRED, { onPath: 'not-found' });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'codex', nonce: 1 }} />);

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(terminal.cliPreflight).toHaveBeenCalledTimes(1));

    await screen.findByText(/Codex \(codex\) isn't installed/);
    expect(launchWrites(terminal.input, 'codex').length).toBe(0);
  });

  test('cursor probe UNKNOWN re-probes once; still-unknown suppresses + shows the banner', async () => {
    const { bridge, terminal, pushData } = makeBridge(WIRED, { onPath: 'unknown' });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'cursor', nonce: 1 }} />);

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(terminal.cliPreflight).toHaveBeenCalledTimes(2));
    await screen.findByText(/Cursor \(cursor-agent\) isn't installed/);
    expect(launchWrites(terminal.input, 'cursor-agent').length).toBe(0);
  });

  test('cursor probe UNKNOWN then PRESENT on re-probe: launches with the preserved prompt', async () => {
    let calls = 0;
    const { bridge, terminal, pushData } = makeBridge(WIRED);
    terminal.cliPreflight = mock(async () => {
      calls += 1;
      return calls === 1 ? { onPath: 'unknown' as const } : { onPath: 'present' as const };
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'cursor', nonce: 1 }} />);

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(terminal.cliPreflight).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(launchWrites(terminal.input, 'cursor-agent').length).toBe(1));
    expect(launchWrites(terminal.input, 'cursor-agent')[0]).toBe("cursor-agent 'hi'\r");
  });

  test('cliPreflight IPC rejection suppresses the write (no raw command-not-found)', async () => {
    const { bridge, terminal, pushData } = makeBridge(WIRED);
    terminal.cliPreflight = mock(async () => {
      throw new Error('ipc channel closed');
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'codex', nonce: 1 }} />);

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(terminal.cliPreflight).toHaveBeenCalledTimes(1));
    await screen.findByText(/Codex \(codex\) isn't installed/);
    expect(launchWrites(terminal.input, 'codex').length).toBe(0);
  });

  test('claude present at mount but not-found on the fresh recheck: suppresses the write', async () => {
    let calls = 0;
    const { bridge, terminal, pushData } = makeBridge(WIRED);
    terminal.claudePreflight = mock(async () => {
      calls += 1;
      return calls === 1
        ? WIRED
        : { claude: 'not-found' as const, mcp: 'needs-rewire' as const, mcpPreApprovable: false };
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(terminal.claudePreflight).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(launchWrites(terminal.input).length).toBe(0);
    await screen.findByText(/Claude Code \(claude\) isn't installed/);
  });

  test('claude present at mount but UNKNOWN on the fresh recheck: suppresses + surfaces the banner', async () => {
    let calls = 0;
    const { bridge, terminal, pushData } = makeBridge(WIRED);
    terminal.claudePreflight = mock(async () => {
      calls += 1;
      return calls === 1
        ? WIRED
        : { claude: 'unknown' as const, mcp: 'needs-rewire' as const, mcpPreApprovable: false };
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    act(() => pushData({ ptyId: 'pty-1', data: '$ ' }));
    await waitFor(() => expect(terminal.claudePreflight).toHaveBeenCalledTimes(2));
    expect(launchWrites(terminal.input).length).toBe(0);
    await screen.findByText(/Claude Code \(claude\) isn't installed/);
  });
});
