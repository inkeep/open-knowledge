/**
 * Behavioral tests for the "Open in terminal" launch path in TerminalSession.
 *
 * The launch is BAKED into the PTY spawn: the session resolves the fixed
 * `<bin> [<fixed-args>…] '<prompt>'` command (via a CLI preflight) and passes it
 * as `terminal.create({ launchCommand })`, where the host runs it on the shell's
 * `-c` so it never lands in the user's shell history. The command is therefore
 * NEVER written through `terminal.input` (the old line-editor injection); these
 * tests assert it rides the `create` call instead, carries no trailing `\r`, and
 * is gated on a confirmed-present CLI. Claude's `claudePreflight` doubles as the
 * launch-time MCP pre-approval check; codex/cursor/opencode probe `cliPreflight`.
 * The escaper is the real core helper (not mocked) so the assertion pins the
 * exact command string. xterm and the desktop bridge are mocked at the system
 * boundary, mirroring `TerminalPanel.dom.test.tsx`.
 */

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
  // The panel subscribes to OSC 0/2 title changes at mount; this stub only needs
  // to return a disposable (the launch tests don't exercise title forwarding).
  onTitleChange = mock((_cb: (title: string) => void) => ({ dispose() {} }));
  attachCustomKeyEventHandler = mock((h: (e: KeyboardEvent) => boolean) => {
    this.keyHandler = h;
  });
  // Production attaches a wheel handler at mount; these launch tests never fire
  // wheel events, so the no-op presence is all that's needed to avoid throwing.
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
    create: mock(async (_opts: { cols: number; rows: number; launchCommand?: string }) => ({
      ok: true as const,
      ptyId: 'pty-1',
    })),
    input: mock((_id: string, _d: string) => {}),
    resize: mock(() => {}),
    kill: mock(async () => {}),
    drain: mock(() => {}),
    adopt: mock(
      async (): Promise<{ ok: true; replay: string } | { ok: false; reason: string }> => ({
        ok: true,
        replay: '',
      }),
    ),
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

/** The `launchCommand` baked into the (single) `create` call, or undefined when
 *  none was passed (plain shell). The launch's only sanctioned transport. */
function bakedLaunch(createMock: ReturnType<typeof mock>): string | undefined {
  const calls = createMock.mock.calls;
  const last = calls.at(-1)?.[0] as { launchCommand?: string } | undefined;
  return last?.launchCommand;
}

/** Any `terminal.input` write that looks like a baked launch command — must stay
 *  empty: the launch rides `create`, never the line editor (the whole fix). */
function launchInputWrites(inputMock: ReturnType<typeof mock>): string[] {
  return inputMock.mock.calls
    .map((c) => c[1] as string)
    .filter((d) => typeof d === 'string' && /^(claude|codex|cursor-agent|opencode) /.test(d));
}

/**
 * Claude's MCP pre-approval prefix (built from MCP_SERVER_NAME in core's
 * terminal-launch.ts): the in-app launch carries `--settings` ahead of the
 * prompt to pre-trust OK's project `.mcp.json` server — but ONLY when the
 * preflight reports `mcpPreApprovable` (the project entry is verified as OK's
 * own). Codex/Cursor never carry it, so this prefix is claude-only.
 */
const CLAUDE_PRE = `--settings '{"enabledMcpjsonServers":["open-knowledge"]}'`;

describe('TerminalPanel "Open in terminal" launch (baked into the PTY spawn)', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
  });
  afterEach(() => {
    cleanup();
  });

  test("bakes `claude --settings '<json>' '<escaped prompt>'` into create — no `\\r`, never via input", async () => {
    const { bridge, terminal } = makeBridge(WIRED);
    const prompt = "Let's work on `foo.md` using OpenKnowledge.";
    render(<TerminalPanel bridge={bridge} launch={{ prompt, cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    // The exact command string: the MCP pre-approval flag, then the
    // single-quote-wrapped prompt. The embedded `'` in "Let's" is escaped via the
    // POSIX close-escape-reopen idiom. Crucially: NO trailing carriage return
    // (that's a typed-into-the-shell artifact; a baked `-c` arg has none).
    expect(bakedLaunch(terminal.create)).toBe(
      `claude ${CLAUDE_PRE} 'Let'\\''s work on \`foo.md\` using OpenKnowledge.'`,
    );
    expect(bakedLaunch(terminal.create)).not.toContain('\r');
    // The launch is never typed into the live shell (the history-pollution fix).
    expect(launchInputWrites(terminal.input)).toEqual([]);
  });

  test('spawns a plain shell (no launchCommand) when claude is not found, and surfaces the banner', async () => {
    const { bridge, terminal } = makeBridge({ claude: 'not-found', mcp: 'needs-rewire' });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    // No baked command — the broken `claude` is never run; the readiness banner
    // gives the actionable not-installed message instead.
    expect(bakedLaunch(terminal.create)).toBeUndefined();
    expect(launchInputWrites(terminal.input)).toEqual([]);
    await screen.findByText(/Claude Code \(claude\) isn't installed/);
  });

  test('bakes a BARE claude command (no pre-approval) when claude is present but OK tools need a rewire', async () => {
    const { bridge, terminal } = makeBridge({ claude: 'present', mcp: 'needs-rewire' });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe("claude 'hi'");
    expect(bakedLaunch(terminal.create)).not.toContain('--settings');
  });

  test("does NOT pre-approve when the project MCP entry is not OK's own (mcpPreApprovable false)", async () => {
    // Supply-chain gate: a shared/cloned project whose `open-knowledge` entry is
    // foreign yields mcpPreApprovable:false, so the bake is bare and Claude's own
    // trust prompt still fires at launch.
    const { bridge, terminal } = makeBridge(WIRED_FOREIGN_PROJECT);
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe("claude 'hi'");
    expect(bakedLaunch(terminal.create)).not.toContain('--settings');
  });

  test('verifies pre-approval at LAUNCH time (the bake gates on the fresh preflight, not a stale snapshot)', async () => {
    // The pre-approval probe runs immediately before the spawn, so the bake
    // reflects the on-disk `.mcp.json` at launch time. Here it reports a foreign
    // entry → bare bake, no pre-approval off any stale `true`.
    const { bridge, terminal } = makeBridge(WIRED_FOREIGN_PROJECT);
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBe("claude 'hi'");
    // The preflight ran before create gated the bake.
    expect(terminal.claudePreflight).toHaveBeenCalled();
  });

  test('a claude launch-preflight REJECTION spawns a plain shell + surfaces the banner (no command-not-found)', async () => {
    // If the launch-time preflight IPC throws, presence is unconfirmed — suppress
    // the bake so the terminal can't show a raw `command not found`, and surface
    // the readiness banner so the user gets feedback rather than a silent no-op.
    const { bridge, terminal } = makeBridge();
    terminal.claudePreflight = mock(async () => {
      throw new Error('ipc boom');
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBeUndefined();
    expect(launchInputWrites(terminal.input)).toEqual([]);
    await screen.findByText(/Claude Code \(claude\) isn't installed/);
  });

  test('claude launch-time verdict UNKNOWN spawns a plain shell + surfaces the banner (unknown→not-found for display)', async () => {
    // resolveLaunchCommand maps an `unknown` preflight to a not-found-for-display
    // banner and suppresses the bake (no raw command-not-found, never a silent
    // no-op). Guards the `fresh.claude === 'not-found' ? fresh : {...}` mapping —
    // an inverted/widened ternary would either show no banner or a false one.
    const { bridge, terminal } = makeBridge({
      claude: 'unknown',
      mcp: 'needs-rewire',
      mcpPreApprovable: false,
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'claude', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBeUndefined();
    expect(launchInputWrites(terminal.input)).toEqual([]);
    await screen.findByText(/Claude Code \(claude\) isn't installed/);
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
    expect(launchInputWrites(terminal.input)).toEqual([]);
  });

  test('cursor probe UNKNOWN re-probes once; still-unknown spawns plain + shows the banner', async () => {
    const { bridge, terminal } = makeBridge(WIRED, { onPath: 'unknown' });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'cursor', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    // Probed twice (initial + one re-probe) before deciding to suppress.
    expect(terminal.cliPreflight).toHaveBeenCalledTimes(2);
    expect(bakedLaunch(terminal.create)).toBeUndefined();
    await screen.findByText(/Cursor \(cursor-agent\) isn't installed/);
  });

  test('cursor probe UNKNOWN then PRESENT on re-probe: bakes the preserved prompt', async () => {
    let calls = 0;
    const { bridge, terminal } = makeBridge(WIRED);
    terminal.cliPreflight = mock(async () => {
      calls += 1;
      return calls === 1 ? { onPath: 'unknown' as const } : { onPath: 'present' as const };
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'cursor', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(terminal.cliPreflight).toHaveBeenCalledTimes(2);
    expect(bakedLaunch(terminal.create)).toBe("cursor-agent 'hi'");
  });

  test('cliPreflight IPC rejection spawns plain + surfaces the banner (no raw command-not-found)', async () => {
    const { bridge, terminal } = makeBridge(WIRED);
    terminal.cliPreflight = mock(async () => {
      throw new Error('ipc channel closed');
    });
    render(<TerminalPanel bridge={bridge} launch={{ prompt: 'hi', cli: 'codex', nonce: 1 }} />);

    await waitFor(() => expect(terminal.create).toHaveBeenCalledTimes(1));
    expect(bakedLaunch(terminal.create)).toBeUndefined();
    await screen.findByText(/Codex \(codex\) isn't installed/);
    expect(launchInputWrites(terminal.input)).toEqual([]);
  });

  test('an adopted (rehydrated) session does NOT re-bake its launch', async () => {
    // A reloaded launch tab carries both its survivor ptyId and its (stale) launch
    // intent. Adoption reconnects the live shell; it must NOT re-issue the launch
    // (the agent is already running in the adopted shell). So no fresh create and
    // no baked command.
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
    // adoptPtyId is set but the survivor exited before this mount, so adopt is
    // refused and the mount falls through to create. The `adoptPtyId === null`
    // guard means resolveLaunchCommand is NOT called — the original launch must
    // not be silently re-issued on a reconnect attempt. So create spawns a plain
    // shell (no launchCommand) and nothing is baked.
    const { bridge, terminal } = makeBridge(WIRED);
    terminal.adopt = mock(
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
    // Fell through to a plain shell — no baked launch command, and nothing typed
    // into the shell. (The post-attach readiness probe still runs here, since this
    // is now just a plain tab — resolveLaunchCommand never owned readiness.)
    expect(bakedLaunch(terminal.create)).toBeUndefined();
    expect(launchInputWrites(terminal.input)).toEqual([]);
  });
});
