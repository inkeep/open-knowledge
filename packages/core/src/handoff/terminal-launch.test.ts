import { describe, expect, it } from 'bun:test';
import { MCP_SERVER_NAME } from '../constants/mcp.ts';
import {
  buildClaudeLaunchCommand,
  buildCliLaunchArgString,
  buildCliLaunchCommand,
  shellSingleQuote,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
} from './terminal-launch.ts';

// The `--settings` JSON Claude launches carry to pre-approve OK's project
// `.mcp.json` server, mirrored here so the expectation breaks loudly if the
// shape (or the canonical server name) ever changes.
const CLAUDE_PREAPPROVE = `--settings '{"enabledMcpjsonServers":["${MCP_SERVER_NAME}"]}'`;

describe('TERMINAL_CLI_IDS', () => {
  it('lists the CLIs in auto-pick priority order (claude > codex > opencode > cursor)', () => {
    // The single constant drives both the visible launch-row order and the
    // default-CLI auto-pick, so display and defaulting can never disagree.
    expect([...TERMINAL_CLI_IDS]).toEqual(['claude', 'codex', 'opencode', 'cursor']);
  });
});

describe('shellSingleQuote', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shellSingleQuote('hello world')).toBe("'hello world'");
  });

  it('escapes embedded single quotes with the POSIX close-escape-reopen idiom', () => {
    expect(shellSingleQuote("it's")).toBe("'it'\\''s'");
  });

  it('renders shell metacharacters inert (no expansion possible)', () => {
    // $, backticks, ;, &, |, newlines, redirects, and glob chars are all
    // literal inside a single-quoted string — the only escape is the quote.
    for (const payload of [
      '$(rm -rf /)',
      '`whoami`',
      'a; rm -rf /',
      'a && curl evil',
      'a | sh',
      'a > /etc/passwd',
      '$HOME',
      '*.md',
      'line1\nline2',
      'back\\slash',
    ]) {
      const quoted = shellSingleQuote(payload);
      // Opens and closes with a single quote.
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
      // The payload's metacharacters survive verbatim between the quotes
      // (single quotes only ever transform the quote byte itself).
      expect(quoted).toContain(payload);
    }
  });

  it('cannot be broken out of with an injected quote + command', () => {
    // A naive `claude '<prompt>'` with no escaping would let this prompt close
    // the quote and append a command. With shellSingleQuote, the injected quote
    // is neutralized into the literal `'\''` sequence.
    const malicious = "'; rm -rf / #";
    const quoted = shellSingleQuote(malicious);
    // No bare (unescaped) closing quote exists before the final terminator:
    // every interior quote is rendered as the `'\''` literal-quote sequence.
    expect(quoted).toBe("''\\''; rm -rf / #'");
    // Round-trip through a POSIX shell would yield the original bytes as a
    // single arg — structurally, the only quotes are the wrapping pair plus
    // escaped-literal sequences.
    const interior = quoted.slice(1, -1);
    // Every `'` in the interior must be part of an escaped `'\''` run, never
    // a lone closing quote.
    expect(interior.replace(/'\\''/g, '')).not.toContain("'");
  });
});

describe('buildClaudeLaunchCommand', () => {
  it("defaults to a bare `claude '<prompt>'` — no MCP pre-approval unless opted in", () => {
    expect(buildClaudeLaunchCommand("Let's work on `foo.md` using OpenKnowledge.")).toBe(
      "claude 'Let'\\''s work on `foo.md` using OpenKnowledge.'\r",
    );
  });

  it("with mcpPreApprove, produces the `claude --settings '<json>' '<prompt>'` shape", () => {
    // Exact bytes (not built via the helper) so the literal `--settings` flag,
    // the pre-approval JSON, and the prompt escaping all stay pinned.
    expect(
      buildClaudeLaunchCommand("Let's work on `foo.md` using OpenKnowledge.", {
        mcpPreApprove: true,
      }),
    ).toBe(
      "claude --settings '{\"enabledMcpjsonServers\":[\"open-knowledge\"]}' 'Let'\\''s work on `foo.md` using OpenKnowledge.'\r",
    );
  });

  it('keeps an injection payload inert and contained in the prompt arg (pre-approved)', () => {
    const cmd = buildClaudeLaunchCommand("'; rm -rf / #", { mcpPreApprove: true });
    expect(cmd).toBe(`claude ${CLAUDE_PREAPPROVE} ''\\''; rm -rf / #'\r`);
    // The pre-approval flag sits between the binary and the prompt; the prompt
    // is still the final, fully-escaped arg and can't break out.
    expect(cmd.startsWith(`claude ${CLAUDE_PREAPPROVE} `)).toBe(true);
    expect(cmd.endsWith("''\\''; rm -rf / #'\r")).toBe(true);
  });
});

describe('buildCliLaunchCommand', () => {
  it('defaults to a bare positional single-quoted prompt per CLI (no pre-approval)', () => {
    // The interactive-REPL parity of `claude '<prompt>'`: codex takes the prompt
    // positionally; Cursor's AGENT CLI binary is `cursor-agent` (not `cursor`,
    // which opens the GUI editor). Without opting in, even claude is bare.
    expect(buildCliLaunchCommand('claude', 'hi')).toBe("claude 'hi'\r");
    expect(buildCliLaunchCommand('codex', 'hi')).toBe("codex 'hi'\r");
    expect(buildCliLaunchCommand('cursor', 'hi')).toBe("cursor-agent 'hi'\r");
    // OpenCode's positional is the project dir, so the prompt rides on --prompt.
    expect(buildCliLaunchCommand('opencode', 'hi')).toBe("opencode --prompt 'hi'\r");
  });

  it('escapes the prompt identically for every CLI regardless of fixed args', () => {
    for (const cli of TERMINAL_CLI_IDS) {
      const cmd = buildCliLaunchCommand(cli, "'; rm -rf / #", { mcpPreApprove: true });
      // Whatever fixed args precede it, the prompt is the final, escaped arg.
      expect(cmd.startsWith(`${TERMINAL_CLIS[cli].bin} `)).toBe(true);
      expect(cmd.endsWith("''\\''; rm -rf / #'\r")).toBe(true);
    }
  });

  it('buildClaudeLaunchCommand is the claude specialization (opts forwarded)', () => {
    expect(buildClaudeLaunchCommand('hi')).toBe(buildCliLaunchCommand('claude', 'hi'));
    expect(buildClaudeLaunchCommand('hi', { mcpPreApprove: true })).toBe(
      buildCliLaunchCommand('claude', 'hi', { mcpPreApprove: true }),
    );
  });
});

describe('buildCliLaunchArgString', () => {
  it('is the launch command WITHOUT the trailing carriage return', () => {
    // The baked `$SHELL -l -i -c '<arg>; exec …'` transport uses the arg string
    // as an argv element, so it must carry no `\r` (that submits a typed line).
    for (const cli of TERMINAL_CLI_IDS) {
      const arg = buildCliLaunchArgString(cli, 'hi', { mcpPreApprove: true });
      expect(arg.endsWith('\r')).toBe(false);
      expect(`${arg}\r`).toBe(buildCliLaunchCommand(cli, 'hi', { mcpPreApprove: true }));
    }
  });

  it('keeps the fixed per-CLI shape (registry bin + single-quoted prompt)', () => {
    expect(buildCliLaunchArgString('claude', 'hi')).toBe("claude 'hi'");
    expect(buildCliLaunchArgString('codex', 'hi')).toBe("codex 'hi'");
    expect(buildCliLaunchArgString('cursor', 'hi')).toBe("cursor-agent 'hi'");
    expect(buildCliLaunchArgString('opencode', 'hi')).toBe("opencode --prompt 'hi'");
  });

  it('keeps an injection payload inert and contained in the prompt arg', () => {
    const arg = buildCliLaunchArgString('claude', "'; rm -rf / #");
    expect(arg).toBe("claude ''\\''; rm -rf / #'");
    expect(arg.endsWith("''\\''; rm -rf / #'")).toBe(true);
  });
});

describe('buildCliLaunchArgString promptless (New chat)', () => {
  it('emits a bare `<bin>` for a null/undefined/empty prompt — no positional, no prompt flag', () => {
    for (const emptyPrompt of [null, undefined, ''] as const) {
      expect(buildCliLaunchArgString('claude', emptyPrompt)).toBe('claude');
      expect(buildCliLaunchArgString('codex', emptyPrompt)).toBe('codex');
      expect(buildCliLaunchArgString('cursor', emptyPrompt)).toBe('cursor-agent');
      // OpenCode carries a prompt on `--prompt`; with no prompt the flag is
      // dropped entirely so the bare TUI opens (positional stays the cwd).
      expect(buildCliLaunchArgString('opencode', emptyPrompt)).toBe('opencode');
    }
  });

  it('still applies Claude MCP pre-approval on a promptless launch when opted in', () => {
    const arg = buildCliLaunchArgString('claude', null, { mcpPreApprove: true });
    expect(arg).toBe(`claude ${CLAUDE_PREAPPROVE}`);
    // No trailing space and no prompt arg: the pre-approval flag is the last token.
    expect(arg.endsWith(' ')).toBe(false);
  });

  it('never adds --prompt or a positional to a promptless opencode launch, even opted in', () => {
    expect(buildCliLaunchArgString('opencode', '', { mcpPreApprove: true })).toBe('opencode');
  });

  it('leaves the non-empty prompted shape byte-identical (promptless branch must not perturb it)', () => {
    expect(buildCliLaunchArgString('claude', 'hi')).toBe("claude 'hi'");
    expect(buildCliLaunchArgString('claude', 'hi', { mcpPreApprove: true })).toBe(
      `claude ${CLAUDE_PREAPPROVE} 'hi'`,
    );
    expect(buildCliLaunchArgString('opencode', 'hi')).toBe("opencode --prompt 'hi'");
  });
});

describe('claude MCP pre-approval', () => {
  it('is OFF by default and only added for claude when opted in', () => {
    expect(buildCliLaunchCommand('claude', 'hi')).not.toContain('--settings');
    expect(buildCliLaunchCommand('claude', 'hi', { mcpPreApprove: true })).toContain(
      CLAUDE_PREAPPROVE,
    );
  });

  it('never added for codex/cursor/opencode, even when opted in (claude-only flag)', () => {
    expect(buildCliLaunchCommand('codex', 'hi', { mcpPreApprove: true })).toBe("codex 'hi'\r");
    expect(buildCliLaunchCommand('cursor', 'hi', { mcpPreApprove: true })).toBe(
      "cursor-agent 'hi'\r",
    );
    expect(buildCliLaunchCommand('opencode', 'hi', { mcpPreApprove: true })).toBe(
      "opencode --prompt 'hi'\r",
    );
  });

  it('names the canonical MCP server, matching what editor wiring registers in .mcp.json', () => {
    // Same constant the CLI writes into mcpServers[...]; if these diverge the
    // pre-approval would target a server name the registered entry never uses.
    expect(buildCliLaunchCommand('claude', 'hi', { mcpPreApprove: true })).toContain(
      `["${MCP_SERVER_NAME}"]`,
    );
  });
});
