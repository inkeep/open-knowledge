import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_SERVER_NAME } from '../constants/mcp.ts';
import {
  buildClaudeLaunchCommand,
  buildCliLaunchArgString,
  buildCliLaunchCommand,
  buildStartupInjectionBytes,
  buildWindowsCliLaunch,
  composeWindowsShellLaunchArgs,
  encodePowerShellCommand,
  isWindowsShellFamily,
  launchWithoutSupportFile,
  OK_GATED_TOOL_NAMES,
  psQuoteArg,
  quoteWindowsShellPath,
  resolveWindowsShellFamily,
  shellSingleQuote,
  startupInjectionFor,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
  WINDOWS_SHELL_FAMILIES,
} from './terminal-launch.ts';

const CLAUDE_PREAPPROVE = `--settings '{"enabledMcpjsonServers":["${MCP_SERVER_NAME}"]}'`;
const OK_ALLOW = `["mcp__${MCP_SERVER_NAME}","Bash(ok open:*)"]`;
const OK_ASK = `["mcp__${MCP_SERVER_NAME}__delete","mcp__${MCP_SERVER_NAME}__move","mcp__${MCP_SERVER_NAME}__share_link","mcp__${MCP_SERVER_NAME}__install","mcp__${MCP_SERVER_NAME}__import"]`;

describe('TERMINAL_CLI_IDS', () => {
  it('lists the CLIs in auto-pick priority order (claude > codex > opencode > cursor > copilot > pi > antigravity > openclaw > hermes)', () => {
    expect([...TERMINAL_CLI_IDS]).toEqual([
      'claude',
      'codex',
      'opencode',
      'cursor',
      'copilot',
      'pi',
      'antigravity',
      'openclaw',
      'hermes',
    ]);
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
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
      expect(quoted).toContain(payload);
    }
  });

  it('cannot be broken out of with an injected quote + command', () => {
    const malicious = "'; rm -rf / #";
    const quoted = shellSingleQuote(malicious);
    expect(quoted).toBe("''\\''; rm -rf / #'");
    const interior = quoted.slice(1, -1);
    expect(interior.replace(/'\\''/g, '')).not.toContain("'");
  });
});

describe('Windows launch composition', () => {
  it('quotes PowerShell arguments with doubled embedded single quotes', () => {
    expect(psQuoteArg("a'b")).toBe("'a''b'");
    expect(psQuoteArg('{"nested":"value"}')).toBe('\'{"nested":"value"}\'');
  });

  it('encodes PowerShell startup scripts as base64 UTF-16LE', () => {
    const script = "& 'native.exe' '--settings' '{\"nested\":\"a''''b\"}'";
    expect(Buffer.from(encodePowerShellCommand(script), 'base64').toString('utf16le')).toBe(script);
  });

  it('keeps Windows prompts out of argv and carries pre-approval through cmd-safe data', () => {
    const prompt = `review "quoted" JSON; & calc`;
    expect(
      buildWindowsCliLaunch('claude', prompt, {
        mcpPreApprove: true,
        autoApproveOkTools: true,
      }),
    ).toEqual({
      executable: 'claude',
      args: ['--settings', '.ok/local/terminal/claude-settings-mcp-tools.json'],
      supportFile: {
        kind: 'claude-settings',
        relativePath: '.ok/local/terminal/claude-settings-mcp-tools.json',
        contents: `{"enabledMcpjsonServers":["${MCP_SERVER_NAME}"],"permissions":{"allow":${OK_ALLOW},"ask":${OK_ASK}}}`,
      },
    });
    expect(buildWindowsCliLaunch('codex', prompt, { autoApproveOkTools: true })).toEqual({
      executable: 'codex',
      args: ['-c', `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode=approve`],
    });
    expect(buildWindowsCliLaunch('openclaw', prompt)).toEqual({
      executable: 'openclaw',
      args: ['chat'],
    });
  });

  it('degrades a support-file launch to the bare launch the same builder would emit', () => {
    const prompt = 'review the failing gate';
    for (const opts of [
      { mcpPreApprove: true },
      { autoApproveOkTools: true },
      { mcpPreApprove: true, autoApproveOkTools: true },
    ]) {
      const withSupport = buildWindowsCliLaunch('claude', prompt, opts);
      expect(withSupport.supportFile).toBeDefined();
      expect(launchWithoutSupportFile(withSupport)).toEqual(
        buildWindowsCliLaunch('claude', prompt, {}),
      );
    }
  });

  it('leaves a launch that carries no support file untouched', () => {
    const bare = buildWindowsCliLaunch('codex', null, { autoApproveOkTools: true });
    expect(launchWithoutSupportFile(bare)).toBe(bare);
  });

  it('cannot retain coupled arguments when degrading a support-file launch', () => {
    expect(
      launchWithoutSupportFile({
        executable: 'claude',
        args: ['--settings', 'unexpected.json', '--future-coupled-token'],
        supportFile: {
          kind: 'claude-settings',
          relativePath: '.ok/local/terminal/claude-settings-mcp-tools.json',
          contents: '{}',
        },
      }),
    ).toEqual({ executable: 'claude', args: [] });
  });

  it('composes PowerShell as -NoExit -EncodedCommand with quoted structured args', () => {
    const args = composeWindowsShellLaunchArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', {
      executable: 'native.exe',
      args: ['--settings', '{"nested":"a\'b"}'],
    });
    expect(Array.isArray(args)).toBe(true);
    expect(args.slice(0, 2)).toEqual(['-NoExit', '-EncodedCommand']);
    expect(Buffer.from(args[2] ?? '', 'base64').toString('utf16le')).toBe(
      "& 'native.exe' '--settings' '{\"nested\":\"a''b\"}'",
    );
  });

  it('composes cmd as an owned /K command line and rejects BatBadBut-shaped batch args', () => {
    expect(
      composeWindowsShellLaunchArgs('C:\\Windows\\System32\\cmd.exe', {
        executable: 'npm',
        args: ['install', '-g', '@slidev/cli'],
      }),
    ).toBe('/K npm install -g @slidev/cli');
    expect(() =>
      composeWindowsShellLaunchArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', {
        executable: 'agent.cmd',
        args: ['safe', '" & calc & "'],
      }),
    ).toThrow(/unsafe batch argument/);
  });

  it('base64-transports Git Bash argv across the MSYS parser without interpolation or byte loss', () => {
    const shell = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(resolveWindowsShellFamily(shell)).toBe('bash');
    const launchTokens = [
      'claude',
      '--settings',
      '.ok/local/terminal/settings with spaces.json',
      "'; calc #",
      'trailing newline\n',
    ];
    const composed = composeWindowsShellLaunchArgs(shell, {
      executable: launchTokens[0] ?? '',
      args: launchTokens.slice(1),
    });
    expect(Array.isArray(composed)).toBe(true);
    if (!Array.isArray(composed)) throw new Error('expected Git Bash argv');

    expect(composed.slice(0, 3)).toEqual(['--login', '-i', '-c']);
    expect(composed[3]).toContain('base64 -d');
    const quotedArgvExpansion = '"$' + '{__ok_argv[@]}"';
    expect(composed[3]).toContain(quotedArgvExpansion);
    expect(composed[3]).not.toContain('claude');
    expect(composed[4]).toBe('bash');
    expect(
      Buffer.from(composed[5] ?? '', 'base64')
        .toString('utf8')
        .split('\u0000'),
    ).toEqual([...launchTokens, '']);
  });

  it('escapes dropped paths per shell and refuses cmd expansion surfaces', () => {
    expect(quoteWindowsShellPath('powershell', "C:\\Users\\O'Brien\\shot.png")).toBe(
      "'C:\\Users\\O''Brien\\shot.png'",
    );
    expect(quoteWindowsShellPath('cmd', 'C:\\Users\\A B\\shot.png')).toBe(
      '"C:\\Users\\A B\\shot.png"',
    );
    expect(quoteWindowsShellPath('cmd', 'C:\\Users\\%USERNAME%\\shot.png')).toBeNull();
    expect(quoteWindowsShellPath('cmd', 'C:\\Users\\!name!\\shot.png')).toBeNull();
    expect(quoteWindowsShellPath('bash', "C:\\Users\\O'Brien\\shot.png")).toBe(
      "'C:\\Users\\O'\\''Brien\\shot.png'",
    );
  });
});

function findNulMapfileBash(): string {
  const candidates = [
    process.env.OK_TEST_BASH,
    'bash',
    '/opt/homebrew/bin/bash',
    '/usr/local/bin/bash',
    '/bin/bash',
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.length === 0) continue;
    const probe = spawnSync(candidate, ['-c', 'echo $BASH_VERSION'], { encoding: 'utf8' });
    if (probe.status !== 0) continue;
    const version = /^(\d+)\.(\d+)/.exec(probe.stdout.trim());
    if (version === null) continue;
    const major = Number(version[1]);
    const minor = Number(version[2]);
    if (major > 4 || (major === 4 && minor >= 4)) return candidate;
  }
  return '';
}

const NUL_MAPFILE_BASH = findNulMapfileBash();

describe('Git Bash structured launch, run by a real Bash', () => {
  it.skipIf(NUL_MAPFILE_BASH === '')(
    'reconstructs every launch token byte-for-byte, empty argument and trailing newline included',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'ok-git-bash-launch-'));
      try {
        const capturedArgvPath = join(dir, 'argv');
        const capturePath = join(dir, 'capture.cjs');
        writeFileSync(
          capturePath,
          "const { writeFileSync } = require('node:fs');\n" +
            "writeFileSync(process.env.OK_CAPTURED_ARGV, [process.argv0, ...process.argv.slice(1)].join('\\0') + '\\0');\n",
        );

        const launchTokens = [
          process.execPath,
          capturePath,
          '--settings',
          '.ok/local/terminal/settings with spaces.json',
          "'; calc #",
          '',
          'trailing newline\n',
        ];
        const composed = composeWindowsShellLaunchArgs('C:\\Program Files\\Git\\bin\\bash.exe', {
          executable: launchTokens[0] ?? '',
          args: launchTokens.slice(1),
        });
        if (!Array.isArray(composed)) throw new Error('expected Git Bash argv');

        const run = spawnSync(NUL_MAPFILE_BASH, composed, {
          env: { ...process.env, HOME: dir, OK_CAPTURED_ARGV: capturedArgvPath },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 20_000,
          encoding: 'utf8',
        });
        expect(run.error).toBeUndefined();
        expect(existsSync(capturedArgvPath), `bash stderr: ${run.stderr}`).toBe(true);

        expect(readFileSync(capturedArgvPath, 'utf8').split('\u0000')).toEqual([
          ...launchTokens,
          '',
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('buildClaudeLaunchCommand', () => {
  it("defaults to a bare `claude '<prompt>'` — no MCP pre-approval unless opted in", () => {
    expect(buildClaudeLaunchCommand("Let's work on `foo.md` using OpenKnowledge.")).toBe(
      "claude 'Let'\\''s work on `foo.md` using OpenKnowledge.'\r",
    );
  });

  it("with mcpPreApprove, produces the `claude --settings '<json>' '<prompt>'` shape", () => {
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
    expect(cmd.startsWith(`claude ${CLAUDE_PREAPPROVE} `)).toBe(true);
    expect(cmd.endsWith("''\\''; rm -rf / #'\r")).toBe(true);
  });
});

describe('buildCliLaunchCommand', () => {
  it('defaults to a bare positional single-quoted prompt per CLI (no pre-approval)', () => {
    expect(buildCliLaunchCommand('claude', 'hi')).toBe("claude 'hi'\r");
    expect(buildCliLaunchCommand('codex', 'hi')).toBe("codex 'hi'\r");
    expect(buildCliLaunchCommand('copilot', 'hi')).toBe("copilot --interactive 'hi'\r");
    expect(buildCliLaunchCommand('cursor', 'hi')).toBe("cursor-agent 'hi'\r");
    expect(buildCliLaunchCommand('opencode', 'hi')).toBe("opencode --prompt 'hi'\r");
    expect(buildCliLaunchCommand('pi', 'hi')).toBe("pi 'hi'\r");
    expect(buildCliLaunchCommand('antigravity', 'hi')).toBe("agy --prompt-interactive 'hi'\r");
    expect(buildCliLaunchCommand('openclaw', 'hi')).toBe("openclaw chat --message 'hi'\r");
    expect(buildCliLaunchCommand('hermes', 'hi')).toBe('hermes chat\r');
  });

  it('escapes the prompt identically for every argv-prompt CLI regardless of fixed args', () => {
    for (const cli of TERMINAL_CLI_IDS) {
      if (startupInjectionFor(cli, 'darwin') != null) continue;
      const cmd = buildCliLaunchCommand(cli, "'; rm -rf / #", { mcpPreApprove: true });
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
    for (const cli of TERMINAL_CLI_IDS) {
      const arg = buildCliLaunchArgString(cli, 'hi', { mcpPreApprove: true });
      expect(arg.endsWith('\r')).toBe(false);
      expect(`${arg}\r`).toBe(buildCliLaunchCommand(cli, 'hi', { mcpPreApprove: true }));
    }
  });

  it('keeps the fixed per-CLI shape (registry bin + single-quoted prompt)', () => {
    expect(buildCliLaunchArgString('claude', 'hi')).toBe("claude 'hi'");
    expect(buildCliLaunchArgString('codex', 'hi')).toBe("codex 'hi'");
    expect(buildCliLaunchArgString('copilot', 'hi')).toBe("copilot --interactive 'hi'");
    expect(buildCliLaunchArgString('cursor', 'hi')).toBe("cursor-agent 'hi'");
    expect(buildCliLaunchArgString('opencode', 'hi')).toBe("opencode --prompt 'hi'");
    expect(buildCliLaunchArgString('pi', 'hi')).toBe("pi 'hi'");
    expect(buildCliLaunchArgString('antigravity', 'hi')).toBe("agy --prompt-interactive 'hi'");
    expect(buildCliLaunchArgString('openclaw', 'hi')).toBe("openclaw chat --message 'hi'");
    expect(buildCliLaunchArgString('hermes', 'hi')).toBe('hermes chat');
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
      expect(buildCliLaunchArgString('copilot', emptyPrompt)).toBe('copilot');
      expect(buildCliLaunchArgString('cursor', emptyPrompt)).toBe('cursor-agent');
      expect(buildCliLaunchArgString('opencode', emptyPrompt)).toBe('opencode');
      expect(buildCliLaunchArgString('openclaw', emptyPrompt)).toBe('openclaw chat');
      expect(buildCliLaunchArgString('hermes', emptyPrompt)).toBe('hermes chat');
    }
  });

  it('still applies Claude MCP pre-approval on a promptless launch when opted in', () => {
    const arg = buildCliLaunchArgString('claude', null, { mcpPreApprove: true });
    expect(arg).toBe(`claude ${CLAUDE_PREAPPROVE}`);
    expect(arg.endsWith(' ')).toBe(false);
  });

  it('still applies Claude OK auto-approve on a promptless launch, alone and merged with pre-approval', () => {
    const autoOnly = buildCliLaunchArgString('claude', null, { autoApproveOkTools: true });
    expect(autoOnly).toBe(
      `claude --settings '{"permissions":{"allow":${OK_ALLOW},"ask":${OK_ASK}}}'`,
    );
    expect(autoOnly.endsWith(' ')).toBe(false);

    const both = buildCliLaunchArgString('claude', null, {
      mcpPreApprove: true,
      autoApproveOkTools: true,
    });
    expect(both).toBe(
      `claude --settings '{"enabledMcpjsonServers":["${MCP_SERVER_NAME}"],"permissions":{"allow":${OK_ALLOW},"ask":${OK_ASK}}}'`,
    );
    expect(both.endsWith(' ')).toBe(false);
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

describe('buildStartupInjectionBytes', () => {
  const START = '\x1b[200~';
  const END = '\x1b[201~';

  it('returns null for CLIs that carry the prompt on the argv (nothing to inject)', () => {
    for (const cli of TERMINAL_CLI_IDS) {
      if (startupInjectionFor(cli, 'darwin') != null) continue;
      expect(buildStartupInjectionBytes(cli, 'hi', 'darwin')).toBeNull();
    }
  });

  it('frames a Hermes prompt in bracketed paste + the registry submit byte', () => {
    expect(buildStartupInjectionBytes('hermes', 'do the thing', 'darwin')).toBe(
      `${START}do the thing${END}\r`,
    );
  });

  it('uses bracketed-paste delivery for every Windows CLI', () => {
    for (const cli of TERMINAL_CLI_IDS) {
      expect(startupInjectionFor(cli, 'win32')).toEqual(
        expect.objectContaining({ readyMarker: '\x1b[?2004h' }),
      );
      expect(buildStartupInjectionBytes(cli, '" & calc & "', 'win32')).toBe(
        `${START}" & calc & "${END}\r`,
      );
    }
  });

  it('keeps a multi-line prompt intact inside the paste frame (no early submit)', () => {
    const multi = 'line one\nline two\nline three';
    expect(buildStartupInjectionBytes('hermes', multi, 'darwin')).toBe(`${START}${multi}${END}\r`);
  });

  it('strips ESC so the prompt cannot terminate the paste frame or inject a sequence', () => {
    const hostile = `abc${END}rm -rf /\x1b[2J`;
    const bytes = buildStartupInjectionBytes('hermes', hostile, 'darwin');
    expect(bytes).toBe(`${START}abc[201~rm -rf /[2J${END}\r`);
    expect(bytes?.split(START).length).toBe(2);
    expect(bytes?.split(END).length).toBe(2);
  });

  it('returns null for an empty/absent prompt (a promptless New-chat launch)', () => {
    for (const emptyPrompt of [null, undefined, ''] as const) {
      expect(buildStartupInjectionBytes('hermes', emptyPrompt, 'darwin')).toBeNull();
    }
  });

  it('Hermes waits on the DEC-2004 bracketed-paste-enable marker, with a cap beyond the debounce', () => {
    const cfg = startupInjectionFor('hermes', 'darwin');
    expect(cfg?.readyMarker).toBe('\x1b[?2004h');
    expect(cfg && cfg.capMs > cfg.settleMs).toBe(true);
  });
});

describe('claude MCP pre-approval', () => {
  it('is OFF by default and only added for claude when opted in', () => {
    expect(buildCliLaunchCommand('claude', 'hi')).not.toContain('--settings');
    expect(buildCliLaunchCommand('claude', 'hi', { mcpPreApprove: true })).toContain(
      CLAUDE_PREAPPROVE,
    );
  });

  it('never added for codex/copilot/cursor/opencode, even when opted in (claude-only flag)', () => {
    expect(buildCliLaunchCommand('codex', 'hi', { mcpPreApprove: true })).toBe("codex 'hi'\r");
    expect(buildCliLaunchCommand('copilot', 'hi', { mcpPreApprove: true })).toBe(
      "copilot --interactive 'hi'\r",
    );
    expect(buildCliLaunchCommand('cursor', 'hi', { mcpPreApprove: true })).toBe(
      "cursor-agent 'hi'\r",
    );
    expect(buildCliLaunchCommand('opencode', 'hi', { mcpPreApprove: true })).toBe(
      "opencode --prompt 'hi'\r",
    );
  });

  it('names the canonical MCP server, matching what editor wiring registers in .mcp.json', () => {
    expect(buildCliLaunchCommand('claude', 'hi', { mcpPreApprove: true })).toContain(
      `["${MCP_SERVER_NAME}"]`,
    );
  });
});

describe('OK auto-approve (autoApproveOkTools)', () => {
  it('adds the OK allow-list + destructive ask-list to Claude --settings when on', () => {
    expect(buildCliLaunchArgString('claude', 'hi', { autoApproveOkTools: true })).toBe(
      `claude --settings '{"permissions":{"allow":${OK_ALLOW},"ask":${OK_ASK}}}' 'hi'`,
    );
  });

  it('merges server-trust + auto-approve into one --settings object when both on', () => {
    expect(
      buildCliLaunchArgString('claude', 'hi', { mcpPreApprove: true, autoApproveOkTools: true }),
    ).toBe(
      `claude --settings '{"enabledMcpjsonServers":["${MCP_SERVER_NAME}"],"permissions":{"allow":${OK_ALLOW},"ask":${OK_ASK}}}' 'hi'`,
    );
  });

  it('keeps every gated tool in the ask list (never silently auto-approved)', () => {
    const arg = buildCliLaunchArgString('claude', 'hi', { autoApproveOkTools: true });
    expect(OK_GATED_TOOL_NAMES).toEqual(['delete', 'move', 'share_link', 'install', 'import']);
    for (const gated of OK_GATED_TOOL_NAMES) {
      expect(arg).toContain(`"mcp__${MCP_SERVER_NAME}__${gated}"`);
    }
  });

  it('never gates with `deny` (that would hide the tools from the agent)', () => {
    const arg = buildCliLaunchArgString('claude', 'hi', { autoApproveOkTools: true });
    expect(arg).not.toContain('"deny"');
  });

  it('adds the codex per-server `-c approve` override only when on', () => {
    expect(buildCliLaunchArgString('codex', 'hi', { autoApproveOkTools: true })).toBe(
      `codex -c 'mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"' 'hi'`,
    );
    expect(buildCliLaunchArgString('codex', 'hi')).toBe("codex 'hi'");
  });

  it('is claude/codex only — copilot/cursor/opencode/pi never get an auto-approve arg', () => {
    expect(buildCliLaunchArgString('copilot', 'hi', { autoApproveOkTools: true })).toBe(
      "copilot --interactive 'hi'",
    );
    expect(buildCliLaunchArgString('cursor', 'hi', { autoApproveOkTools: true })).toBe(
      "cursor-agent 'hi'",
    );
    expect(buildCliLaunchArgString('opencode', 'hi', { autoApproveOkTools: true })).toBe(
      "opencode --prompt 'hi'",
    );
    expect(buildCliLaunchArgString('pi', 'hi', { autoApproveOkTools: true })).toBe("pi 'hi'");
  });

  it('keeps the prompt the final escaped arg with auto-approve on (injection inert)', () => {
    const arg = buildCliLaunchArgString('claude', "'; rm -rf / #", { autoApproveOkTools: true });
    expect(arg.endsWith("''\\''; rm -rf / #'")).toBe(true);
  });

  it('emits a bare `<bin>` for a promptless auto-approve launch with the fixed args', () => {
    expect(buildCliLaunchArgString('codex', null, { autoApproveOkTools: true })).toBe(
      `codex -c 'mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"'`,
    );
  });
});

const WIRE_FAMILIES = ['powershell', 'cmd', 'bash'];

describe('WINDOWS_SHELL_FAMILIES', () => {
  it('exposes exactly the wire vocabulary', () => {
    expect([...WINDOWS_SHELL_FAMILIES].sort()).toEqual([...WIRE_FAMILIES].sort());
  });
});

describe('isWindowsShellFamily', () => {
  it('accepts every family in the wire vocabulary', () => {
    for (const family of WIRE_FAMILIES) {
      expect(isWindowsShellFamily(family)).toBe(true);
    }
  });

  it('agrees with the resolver about what counts as a supported family', () => {
    for (const shell of [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
    ]) {
      expect(isWindowsShellFamily(resolveWindowsShellFamily(shell))).toBe(true);
    }
    expect(resolveWindowsShellFamily('C:\\Windows\\System32\\wsl.exe')).toBeNull();
  });

  it('rejects unknown strings', () => {
    expect(isWindowsShellFamily('pwsh')).toBe(false);
    expect(isWindowsShellFamily('zsh')).toBe(false);
    expect(isWindowsShellFamily('')).toBe(false);
    expect(isWindowsShellFamily('PowerShell')).toBe(false);
    expect(isWindowsShellFamily('__proto__')).toBe(false);
  });

  it('rejects non-string inputs (defends the IPC boundary against arbitrary payloads)', () => {
    expect(isWindowsShellFamily(undefined)).toBe(false);
    expect(isWindowsShellFamily(null)).toBe(false);
    expect(isWindowsShellFamily(0)).toBe(false);
    expect(isWindowsShellFamily(false)).toBe(false);
    expect(isWindowsShellFamily({})).toBe(false);
    expect(isWindowsShellFamily(['cmd'])).toBe(false);
  });
});
