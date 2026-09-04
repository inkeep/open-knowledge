import {
  buildStartupInjectionBytes,
  type TerminalCli,
  type TerminalLaunchCommand,
} from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfigContext, type ConfigContextValue } from '@/lib/config-context';
import type {
  ClaudeReadiness,
  CliReadiness,
  OkDesktopBridge,
  OkPtyData,
  OkPtyNotice,
} from '@/lib/desktop-bridge-types';

class MockFitAddon {
  fit = vi.fn(() => {});
}
class MockWebglAddon {}
class MockWebLinksAddon {}
class MockUnicode11Addon {}

let lastTerm: MockTerminal | null = null;

class MockTerminal {
  cols = 80;
  rows = 24;
  unicode = { activeVersion: '6' };
  onDataCb: ((d: string) => void) | null = null;
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  options: Record<string, unknown>;
  selection = '';
  hasSelection = vi.fn(() => this.selection.length > 0);
  getSelection = vi.fn(() => this.selection);
  clearSelection = vi.fn(() => {
    this.selection = '';
  });
  open = vi.fn(() => {});
  focus = vi.fn(() => {});
  dispose = vi.fn(() => {});
  paste = vi.fn((_data: string) => {});
  write = vi.fn((_data: string, cb?: () => void) => {
    cb?.();
  });
  loadAddon = vi.fn(() => {});
  onData = vi.fn((cb: (d: string) => void) => {
    this.onDataCb = cb;
    return { dispose() {} };
  });
  onTitleChange = vi.fn((_cb: (title: string) => void) => ({ dispose() {} }));
  attachCustomKeyEventHandler = vi.fn((h: (e: KeyboardEvent) => boolean) => {
    this.keyHandler = h;
  });
  attachCustomWheelEventHandler = vi.fn(() => {});
  registerLinkProvider = vi.fn(() => ({ dispose() {} }));
  get buffer() {
    return { active: { getLine: () => ({ translateToString: () => '' }) } };
  }
  constructor(options: Record<string, unknown>) {
    this.options = options;
    lastTerm = this;
  }
}

class MockResizeObserver {
  observe = vi.fn(() => {});
  unobserve = vi.fn(() => {});
  disconnect = vi.fn(() => {});
}

vi.doMock('@xterm/xterm', () => ({ Terminal: MockTerminal }));
vi.doMock('@xterm/addon-fit', () => ({ FitAddon: MockFitAddon }));
vi.doMock('@xterm/addon-webgl', () => ({ WebglAddon: MockWebglAddon }));
vi.doMock('@xterm/addon-web-links', () => ({ WebLinksAddon: MockWebLinksAddon }));
vi.doMock('@xterm/addon-unicode11', () => ({ Unicode11Addon: MockUnicode11Addon }));
vi.doMock('@xterm/xterm/css/xterm.css', () => ({}));

const WIRED: ClaudeReadiness = { claude: 'present', mcp: 'wired', mcpPreApprovable: true };
const WIRED_FOREIGN_PROJECT: ClaudeReadiness = {
  claude: 'present',
  mcp: 'wired',
  mcpPreApprovable: false,
};
const ON_PATH: CliReadiness = { onPath: 'present' };
const CODEX_OK_CONFIGURED: CliReadiness = { onPath: 'present', okServerConfigured: true };

function makeBridge(
  preflight: ClaudeReadiness = WIRED,
  cliReadiness: CliReadiness = ON_PATH,
  platform: OkDesktopBridge['platform'] = 'darwin',
) {
  const dataSubs: Array<(m: OkPtyData) => void> = [];
  const noticeSubs: Array<(m: OkPtyNotice) => void> = [];
  const terminal = {
    create: vi.fn(
      async (_opts: {
        cols: number;
        rows: number;
        launchCommand?: string | TerminalLaunchCommand;
      }) => ({
        ok: true as const,
        ptyId: 'pty-1',
      }),
    ),
    input: vi.fn((_id: string, _d: string) => {}),
    resize: vi.fn(() => {}),
    kill: vi.fn(async () => {}),
    drain: vi.fn(() => {}),
    adopt: vi.fn(
      async (): Promise<{ ok: true; replay: string } | { ok: false; reason: string }> => ({
        ok: true,
        replay: '',
      }),
    ),
    onData: vi.fn((cb: (m: OkPtyData) => void) => {
      dataSubs.push(cb);
      return vi.fn(() => {});
    }),
    onExit: vi.fn(() => vi.fn(() => {})),
    onNotice: vi.fn((cb: (m: OkPtyNotice) => void) => {
      noticeSubs.push(cb);
      return vi.fn(() => {});
    }),
    claudePreflight: vi.fn(async () => preflight),
    cliPreflight: vi.fn(async (_cli: TerminalCli) => cliReadiness),
    rewireClaudeMcp: vi.fn(async () => preflight),
  };
  return {
    bridge: {
      terminal,
      shell: { openExternal: vi.fn(async () => {}) },
      config: { e2eSmoke: false },
      platform,
    } as unknown as OkDesktopBridge,
    terminal,
    pushData: (m: OkPtyData) => {
      for (const f of dataSubs) f(m);
    },
    pushNotice: (m: OkPtyNotice) => {
      for (const f of noticeSubs) f(m);
    },
  };
}

const { TerminalPanel, STAGE_PASTE_SETTLE_MS } = await import('./TerminalPanel');

function bakedLaunch(
  createMock: ReturnType<typeof vi.fn>,
): string | TerminalLaunchCommand | undefined {
  const calls = createMock.mock.calls;
  const last = calls.at(-1)?.[0] as { launchCommand?: string | TerminalLaunchCommand } | undefined;
  return last?.launchCommand;
}

function launchInputWrites(inputMock: ReturnType<typeof vi.fn>): string[] {
  return inputMock.mock.calls
    .map((c) => c[1] as string)
    .filter((d) => typeof d === 'string' && /^(claude|codex|cursor-agent|opencode) /.test(d));
}

const CLAUDE_PRE = `--settings '{"enabledMcpjsonServers":["open-knowledge"],"permissions":{"allow":["mcp__open-knowledge","Bash(ok open:*)"],"ask":["mcp__open-knowledge__delete","mcp__open-knowledge__move","mcp__open-knowledge__share_link","mcp__open-knowledge__install","mcp__open-knowledge__import"]}}'`;

const CLAUDE_TRUST_ONLY = `--settings '{"enabledMcpjsonServers":["open-knowledge"]}'`;

function renderWithAutoApproveOff(ui: ReactElement) {
  const value = {
    userConfig: { agents: { autoApproveOkTools: false } },
    userBinding: null,
    userSynced: true,
    projectBinding: null,
    projectConfig: null,
    projectSynced: false,
    projectLocalBinding: null,
    projectLocalConfig: null,
    projectLocalSynced: false,
    okignoreBinding: null,
    okignoreSynced: false,
    merged: null,
  } as unknown as ConfigContextValue;
  return render(<ConfigContext.Provider value={value}>{ui}</ConfigContext.Provider>);
}

describe('TerminalPanel "Open in terminal" launch (baked into the PTY spawn)', () => {
  beforeEach(() => {
    lastTerm = null;
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(async () => 'launch clipboard paste'),
        writeText: vi.fn(async () => {}),
      },
    });
  });
  afterEach(() => {
    cleanup();
  });

  test("bakes `claude --settings '<json>' '<escaped prompt>'` into create — no `\\r`, never via input", async () => {
    const { bridge, terminal } = makeBridge(WIRED);
    const prompt = "Let's work on `foo.md` using OpenKnowledge.";
    render(<TerminalPanel bridge={bridge} launch={{ prompt, cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe(
      `claude ${CLAUDE_PRE} 'Let'\\''s work on \`foo.md\` using OpenKnowledge.'`,
    );
    expect(bakedLaunch(terminal.create)).not.toContain('\r');
    expect(launchInputWrites(terminal.input)).toEqual([]);
  });

  test('Windows keeps the CLI structured and bracketed-pastes the prompt after readiness', async () => {
    const { bridge, terminal, pushData } = makeBridge(WIRED, ON_PATH, 'win32');
    const prompt = 'review {"quoted":"JSON"}; & calc';
    render(<TerminalPanel bridge={bridge} launch={{ prompt, cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    const launch = bakedLaunch(terminal.create);
    expect(launch).toMatchObject({
      executable: 'claude',
      args: ['--settings', '.ok/local/terminal/claude-settings-mcp-tools.json'],
      supportFile: {
        kind: 'claude-settings',
        relativePath: '.ok/local/terminal/claude-settings-mcp-tools.json',
      },
    });
    if (typeof launch !== 'object' || launch === null || launch.supportFile === undefined) {
      throw new Error('expected a structured Claude launch with settings support file');
    }
    expect(JSON.parse(launch.supportFile.contents)).toEqual({
      enabledMcpjsonServers: ['open-knowledge'],
      permissions: {
        allow: ['mcp__open-knowledge', 'Bash(ok open:*)'],
        ask: [
          'mcp__open-knowledge__delete',
          'mcp__open-knowledge__move',
          'mcp__open-knowledge__share_link',
          'mcp__open-knowledge__install',
          'mcp__open-knowledge__import',
        ],
      },
    });
    expect(JSON.stringify(bakedLaunch(terminal.create))).not.toContain(prompt);
    const submittedBytes = buildStartupInjectionBytes('claude', prompt, 'win32');
    expect(submittedBytes).not.toBeNull();
    const stagedBytes = submittedBytes?.slice(0, -1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(terminal.input).not.toHaveBeenCalled();
    pushData({ ptyId: 'pty-1', data: '\x1b[?2004h' });
    await waitFor(() => expect(terminal.input).toHaveBeenCalledWith('pty-1', stagedBytes), {
      timeout: 2_000,
    });
    expect(terminal.input).not.toHaveBeenCalledWith('pty-1', submittedBytes);
    const notice = await screen.findByTestId('terminal-manual-submit-notice-banner');
    expect(notice.textContent).toContain('not submitted automatically');
    expect(notice.textContent).toContain('Review it');
  });

  test('Windows cap fallback stages the prompt without submitting when readiness never arrives', async () => {
    const { bridge, terminal } = makeBridge(WIRED, ON_PATH, 'win32');
    const prompt = 'review this safely';
    render(<TerminalPanel bridge={bridge} launch={{ prompt, cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    const submitted = buildStartupInjectionBytes('claude', prompt, 'win32');
    expect(submitted).not.toBeNull();
    const staged = submitted?.slice(0, -1);
    await waitFor(() => expect(terminal.input).toHaveBeenCalledWith('pty-1', staged), {
      timeout: 6_000,
    });
    expect(terminal.input).not.toHaveBeenCalledWith('pty-1', submitted);
    const notice = await screen.findByTestId('terminal-manual-submit-notice-banner');
    expect(notice.textContent).toContain('not submitted automatically');
    expect(notice.textContent).toContain('press Enter');
  }, 10_000);

  test('Windows suppresses prompt injection when the configured shell cannot run the agent launch', async () => {
    const { bridge, terminal, pushData, pushNotice } = makeBridge(WIRED, ON_PATH, 'win32');
    terminal.create.mockImplementationOnce(async () => {
      pushNotice({
        ptyId: 'pty-1',
        notice: 'invalid-shell-override',
        reason: 'unsupported-family',
      });
      return { ok: true as const, ptyId: 'pty-1' };
    });
    render(
      <TerminalPanel
        bridge={bridge}
        launch={{ prompt: 'do not paste this into a plain shell', cli: 'claude', nonce: 1 }}
      />,
    );

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toMatchObject({ executable: 'claude' });
    expect(await screen.findByTestId('terminal-shell-notice-banner')).toBeTruthy();
    act(() => pushData({ ptyId: 'pty-1', data: '\x1b[?2004h' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, STAGE_PASTE_SETTLE_MS * 3));
    });
    expect(terminal.input).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-manual-submit-notice-banner')).toBeNull();
  });

  test('Windows cancels an armed prompt injection when the unsupported-shell notice arrives after attach', async () => {
    const { bridge, terminal, pushData, pushNotice } = makeBridge(WIRED, ON_PATH, 'win32');
    render(
      <TerminalPanel
        bridge={bridge}
        launch={{ prompt: 'never execute this in the plain shell', cli: 'claude', nonce: 1 }}
      />,
    );

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.querySelector('[data-terminal-status="running"]')).not.toBeNull(),
    );
    act(() => pushData({ ptyId: 'pty-1', data: '\x1b[?2004h' }));
    act(() =>
      pushNotice({
        ptyId: 'pty-1',
        notice: 'invalid-shell-override',
        reason: 'unsupported-family',
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, STAGE_PASTE_SETTLE_MS * 3));
    });

    expect(await screen.findByTestId('terminal-shell-notice-banner')).toBeTruthy();
    expect(terminal.input).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-manual-submit-notice-banner')).toBeNull();
  });

  test('Windows carries Codex auto-approval as cmd-safe structured argv', async () => {
    const { bridge, terminal, pushData } = makeBridge(WIRED, CODEX_OK_CONFIGURED, 'win32');
    render(
      <TerminalPanel bridge={bridge} launch={{ prompt: 'review this', cli: 'codex', nonce: 1 }} />,
    );

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toEqual({
      executable: 'codex',
      args: ['-c', 'mcp_servers.open-knowledge.default_tools_approval_mode=approve'],
    });
    pushData({ ptyId: 'pty-1', data: '\x1b[?2004h' });
    const submittedBytes = buildStartupInjectionBytes('codex', 'review this', 'win32');
    expect(submittedBytes).not.toBeNull();
    await waitFor(() =>
      expect(terminal.input).toHaveBeenCalledWith('pty-1', submittedBytes?.slice(0, -1)),
    );
    expect(terminal.input).not.toHaveBeenCalledWith('pty-1', submittedBytes);
    expect(await screen.findByTestId('terminal-manual-submit-notice-banner')).toBeTruthy();
  });

  test('Windows launch panels preserve selection-conditional Ctrl+C and Ctrl+V paste', async () => {
    const { bridge, terminal } = makeBridge(WIRED, ON_PATH, 'win32');
    render(<TerminalPanel bridge={bridge} launch={{ prompt: null, cli: 'claude', nonce: 1 }} />);
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    const handler = lastTerm?.keyHandler;
    expect(handler).toBeTruthy();

    expect(
      handler?.({
        type: 'keydown',
        key: 'c',
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: vi.fn(() => {}),
      } as unknown as KeyboardEvent),
    ).toBe(true);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

    if (lastTerm) lastTerm.selection = 'launch selection';
    expect(
      handler?.({
        type: 'keydown',
        key: 'c',
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: vi.fn(() => {}),
      } as unknown as KeyboardEvent),
    ).toBe(false);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('launch selection'),
    );

    expect(
      handler?.({
        type: 'keydown',
        key: 'v',
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: vi.fn(() => {}),
      } as unknown as KeyboardEvent),
    ).toBe(false);
    await waitFor(() => expect(lastTerm?.paste).toHaveBeenCalledWith('launch clipboard paste'));
  });

  test('a launch carrying stagePaste writes it into the CLI input after the TUI settles — no submit', async () => {
    const { bridge, terminal } = makeBridge(WIRED);
    const staged = 'work on @notes.md — the selected passage\n\n';
    render(
      <TerminalPanel
        bridge={bridge}
        launch={{ prompt: null, cli: 'claude', nonce: 1, stagePaste: staged }}
      />,
    );

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe(`claude ${CLAUDE_PRE}`);
    await waitFor(() => expect(terminal.input).toHaveBeenCalledWith('pty-1', staged), {
      timeout: 2_000,
    });
    expect(terminal.input.mock.calls.every((c) => !(c[1] as string).includes('\r'))).toBe(true);
  });

  test('a Hermes launch bakes promptless `hermes chat` and injects the prompt only after the ready marker (ESC[?2004h)', async () => {
    const { bridge, terminal, pushData } = makeBridge();
    const prompt = 'summarize @notes.md\nthen link the people';
    render(<TerminalPanel bridge={bridge} launch={{ prompt, cli: 'hermes', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe('hermes chat');
    expect(bakedLaunch(terminal.create)).not.toContain(prompt);

    await new Promise((r) => setTimeout(r, 80));
    expect(terminal.input).not.toHaveBeenCalled();

    pushData({ ptyId: 'pty-1', data: '\x1b[?2004h' });

    const expectedBytes = buildStartupInjectionBytes('hermes', prompt, 'darwin');
    expect(expectedBytes).not.toBeNull();
    await waitFor(() => expect(terminal.input).toHaveBeenCalledWith('pty-1', expectedBytes), {
      timeout: 2_000,
    });
    expect(expectedBytes?.endsWith('\r')).toBe(true);
    expect(expectedBytes?.slice(0, -1).includes('\r')).toBe(false);
  }, 10_000);

  test('a Hermes launch injects via the cap fallback even if the ready marker never arrives', async () => {
    const { bridge, terminal } = makeBridge();
    const prompt = 'do the thing';
    render(<TerminalPanel bridge={bridge} launch={{ prompt, cli: 'hermes', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    const expectedBytes = buildStartupInjectionBytes('hermes', prompt, 'darwin');
    await waitFor(() => expect(terminal.input).toHaveBeenCalledWith('pty-1', expectedBytes), {
      timeout: 6_000,
    });
  }, 10_000);

  test('stagePaste is DROPPED when the bake was suppressed — staged text in the bare-shell fallback would execute', async () => {
    const { bridge, terminal } = makeBridge({ claude: 'not-found', mcp: 'needs-rewire' });
    render(
      <TerminalPanel
        bridge={bridge}
        launch={{ prompt: null, cli: 'claude', nonce: 1, stagePaste: 'echo pwned\n\n' }}
      />,
    );

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, STAGE_PASTE_SETTLE_MS + 200));
    expect(terminal.input).not.toHaveBeenCalled();
  });

  test('spawns a plain shell (no launchCommand) when claude is not found, and surfaces the banner', async () => {
    const { bridge, terminal } = makeBridge({ claude: 'not-found', mcp: 'needs-rewire' });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBeUndefined();
    expect(launchInputWrites(terminal.input)).toEqual([]);
    await screen.findByText(/Claude Code \(claude\) isn't installed/);
    expect(screen.queryByTestId('terminal-cli-unverified-banner')).toBeNull();
  });

  test('bakes a BARE claude command (no pre-approval) when claude is present but OK tools need a rewire', async () => {
    const { bridge, terminal } = makeBridge({ claude: 'present', mcp: 'needs-rewire' });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe("claude 'hi'");
    expect(bakedLaunch(terminal.create)).not.toContain('--settings');
  });

  test("does NOT pre-approve when the project MCP entry is not OK's own (mcpPreApprovable false)", async () => {
    const { bridge, terminal } = makeBridge(WIRED_FOREIGN_PROJECT);
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe("claude 'hi'");
    expect(bakedLaunch(terminal.create)).not.toContain('--settings');
  });

  test('verifies pre-approval at LAUNCH time (the bake gates on the fresh preflight, not a stale snapshot)', async () => {
    const { bridge, terminal } = makeBridge(WIRED_FOREIGN_PROJECT);
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe("claude 'hi'");
    expect(terminal.claudePreflight).toHaveBeenCalled();
  });

  test('a claude launch-preflight REJECTION spawns a plain shell + surfaces the UNVERIFIED banner (never "isn\'t installed")', async () => {
    const { bridge, terminal } = makeBridge();
    terminal.claudePreflight = vi.fn(async () => {
      throw new Error('ipc boom');
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBeUndefined();
    expect(launchInputWrites(terminal.input)).toEqual([]);
    expect(screen.queryByText(/isn't installed/)).toBeNull();
    const banner = await screen.findByTestId('terminal-cli-unverified-banner');
    expect(banner.getAttribute('role')).toBe('status');
  });

  test('claude launch-time verdict UNKNOWN spawns a plain shell + surfaces the UNVERIFIED banner (never "isn\'t installed")', async () => {
    const { bridge, terminal } = makeBridge({
      claude: 'unknown',
      mcp: 'needs-rewire',
      mcpPreApprovable: false,
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBeUndefined();
    expect(launchInputWrites(terminal.input)).toEqual([]);
    expect(screen.queryByText(/isn't installed/)).toBeNull();
    const banner = await screen.findByTestId('terminal-cli-unverified-banner');
    expect(banner.getAttribute('role')).toBe('status');
  });

  test('codex launch probes cliPreflight and bakes the codex command', async () => {
    const { bridge, terminal } = makeBridge(WIRED, ON_PATH);
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'codex', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(terminal.cliPreflight).toHaveBeenCalledTimes(1);
    expect(terminal.cliPreflight.mock.calls[0]?.[0]).toBe('codex');
    expect(bakedLaunch(terminal.create)).toBe("codex 'hi'");
    expect(launchInputWrites(terminal.input)).toEqual([]);
  });

  test("codex auto-approves OK tools (-c approve) when OK's server is configured in codex", async () => {
    const { bridge, terminal } = makeBridge(WIRED, CODEX_OK_CONFIGURED);
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'codex', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe(
      `codex -c 'mcp_servers.open-knowledge.default_tools_approval_mode="approve"' 'hi'`,
    );
  });

  test('codex stays BARE (no -c) when OK is not configured in codex — the launch never breaks', async () => {
    const { bridge, terminal } = makeBridge(WIRED, {
      onPath: 'present',
      okServerConfigured: false,
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'codex', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe("codex 'hi'");
    expect(bakedLaunch(terminal.create)).not.toContain('-c');
  });

  test('toggle OFF: a WIRED claude launch keeps server trust but bakes no permissions block', async () => {
    const { bridge, terminal } = makeBridge(WIRED);
    renderWithAutoApproveOff(
      <TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />,
    );

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe(`claude ${CLAUDE_TRUST_ONLY} 'hi'`);
    expect(bakedLaunch(terminal.create)).not.toContain('permissions');
  });

  test("toggle OFF: codex stays BARE (no -c) even when OK's server is configured", async () => {
    const { bridge, terminal } = makeBridge(WIRED, CODEX_OK_CONFIGURED);
    renderWithAutoApproveOff(
      <TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'codex', nonce: 1 }} />,
    );

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe("codex 'hi'");
  });

  test('cursor launch bakes the cursor-agent command (the agent CLI, not the editor)', async () => {
    const { bridge, terminal } = makeBridge(WIRED, ON_PATH);
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'cursor', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe("cursor-agent 'hi'");
  });

  test('opencode launch bakes the --prompt form (positional is the project dir)', async () => {
    const { bridge, terminal } = makeBridge(WIRED, ON_PATH);
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'opencode', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe("opencode --prompt 'hi'");
  });

  test('codex not on PATH: spawns a plain shell + surfaces the missing-CLI banner', async () => {
    const { bridge, terminal } = makeBridge(WIRED, { onPath: 'not-found' });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'codex', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBeUndefined();
    await screen.findByText(/Codex \(codex\) isn't installed/);
    expect(screen.queryByTestId('terminal-cli-unverified-banner')).toBeNull();
    expect(launchInputWrites(terminal.input)).toEqual([]);
  });

  test('cursor probe UNKNOWN re-probes once; still-unknown spawns plain + shows the UNVERIFIED banner (never "isn\'t installed")', async () => {
    const { bridge, terminal } = makeBridge(WIRED, { onPath: 'unknown' });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'cursor', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(terminal.cliPreflight).toHaveBeenCalledTimes(2);
    expect(bakedLaunch(terminal.create)).toBeUndefined();
    expect(screen.queryByText(/isn't installed/)).toBeNull();
    const banner = await screen.findByTestId('terminal-cli-unverified-banner');
    expect(banner.getAttribute('role')).toBe('status');
  });

  test('cursor probe UNKNOWN then PRESENT on re-probe: bakes the preserved prompt', async () => {
    let calls = 0;
    const { bridge, terminal } = makeBridge(WIRED);
    terminal.cliPreflight = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? { onPath: 'unknown' as const } : { onPath: 'present' as const };
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'cursor', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(terminal.cliPreflight).toHaveBeenCalledTimes(2);
    expect(bakedLaunch(terminal.create)).toBe("cursor-agent 'hi'");
  });

  test('cliPreflight IPC rejection spawns plain + surfaces the UNVERIFIED banner (never "isn\'t installed")', async () => {
    const { bridge, terminal } = makeBridge(WIRED);
    terminal.cliPreflight = vi.fn(async () => {
      throw new Error('ipc channel closed');
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'codex', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBeUndefined();
    expect(screen.queryByText(/isn't installed/)).toBeNull();
    const banner = await screen.findByTestId('terminal-cli-unverified-banner');
    expect(banner.getAttribute('role')).toBe('status');
    expect(launchInputWrites(terminal.input)).toEqual([]);
  });

  test('an adopted (rehydrated) session does NOT re-bake its launch', async () => {
    const { bridge, terminal } = makeBridge(WIRED);
    render(
      <TerminalPanel
        bridge={bridge}
        adoptPtyId="surv-1"
        launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }}
      />,
    );

    await waitFor(() => expect(terminal.adopt).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(terminal.create).not.toHaveBeenCalled();
    expect(launchInputWrites(terminal.input)).toEqual([]);
  });

  test('a FAILED adoption (survivor gone) falls through to a plain shell — does NOT re-bake the launch', async () => {
    const { bridge, terminal } = makeBridge(WIRED);
    terminal.adopt = vi.fn(
      async (): Promise<{ ok: true; replay: string } | { ok: false; reason: string }> => ({
        ok: false,
        reason: 'unknown-session',
      }),
    );
    render(
      <TerminalPanel
        bridge={bridge}
        adoptPtyId="surv-gone"
        launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }}
      />,
    );

    await waitFor(() => expect(terminal.adopt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBeUndefined();
    expect(launchInputWrites(terminal.input)).toEqual([]);
  });
});
