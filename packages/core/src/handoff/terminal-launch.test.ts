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

// The `--settings` JSON Claude launches carry to pre-approve OK's project
// `.mcp.json` server, mirrored here so the expectation breaks loudly if the
// shape (or the canonical server name) ever changes.
const CLAUDE_PREAPPROVE = `--settings '{"enabledMcpjsonServers":["${MCP_SERVER_NAME}"]}'`;
const OK_ALLOW = `["mcp__${MCP_SERVER_NAME}","Bash(ok open:*)"]`;
const OK_ASK = `["mcp__${MCP_SERVER_NAME}__delete","mcp__${MCP_SERVER_NAME}__move","mcp__${MCP_SERVER_NAME}__share_link","mcp__${MCP_SERVER_NAME}__install","mcp__${MCP_SERVER_NAME}__import"]`;

describe('TERMINAL_CLI_IDS', () => {
  it('lists the CLIs in auto-pick priority order (claude > codex > opencode > cursor > copilot > pi > antigravity > openclaw > hermes)', () => {
    // The single constant drives both the visible launch-row order and the
    // default-CLI auto-pick, so display and defaulting can never disagree.
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

/**
 * The first Bash on this host new enough to run the generated launch script, or
 * an empty string when there is none.
 *
 * `mapfile -d ''` — the NUL-delimited read the decoder is built on — arrived in
 * Bash 4.4, so mere presence is the wrong gate: macOS still ships 3.2 at
 * `/bin/bash`, where the same script parses cleanly and reads nothing at all.
 * Probing the version keeps the skip honest rather than green and vacuous. Set
 * `OK_TEST_BASH` to point the probe at a specific build.
 */
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
  // The sibling composition test decodes the payload in JavaScript, which proves
  // what OK encoded but not what Bash reconstructs from it. This one hands the
  // generated `-c` script to a real Bash and reads back the argv the launched
  // program actually received, so a decoder that loses a token — or silently
  // drops the empty and newline-tailed ones, the two the NUL framing exists for
  // — fails here instead of on a user's Windows box.
  it.skipIf(NUL_MAPFILE_BASH === '')(
    'reconstructs every launch token byte-for-byte, empty argument and trailing newline included',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'ok-git-bash-launch-'));
      try {
        const capturedArgvPath = join(dir, 'argv');
        const capturePath = join(dir, 'capture.cjs');
        // Stands in for the agent CLI so the test stays deterministic and
        // offline: it records the argv Bash handed it, NUL-delimited so tokens
        // carrying spaces or newlines stay separable on the way back out.
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
          // `HOME` points at the scratch dir so the login shell the script execs
          // last cannot read the developer's dotfiles, and stdin is closed so
          // that shell hits EOF and exits instead of waiting for input.
          env: { ...process.env, HOME: dir, OK_CAPTURED_ARGV: capturedArgvPath },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 20_000,
          encoding: 'utf8',
        });
        expect(run.error).toBeUndefined();
        // The exit code belongs to the interactive login shell the script execs
        // last, not to the decode, so the captured argv is the only oracle.
        expect(existsSync(capturedArgvPath), `bash stderr: ${run.stderr}`).toBe(true);

        // The capture script terminates the payload with a trailing NUL, so the
        // split has one trailing empty element past the last argument.
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
    expect(buildCliLaunchCommand('copilot', 'hi')).toBe("copilot --interactive 'hi'\r");
    expect(buildCliLaunchCommand('cursor', 'hi')).toBe("cursor-agent 'hi'\r");
    // OpenCode's positional is the project dir, so the prompt rides on --prompt.
    expect(buildCliLaunchCommand('opencode', 'hi')).toBe("opencode --prompt 'hi'\r");
    // Pi's positional IS the prompt — same shape as claude/codex/cursor.
    expect(buildCliLaunchCommand('pi', 'hi')).toBe("pi 'hi'\r");
    // Antigravity's CLI binary is `agy`; it has no positional prompt, so the
    // prompt rides on --prompt-interactive (keeps the session interactive).
    expect(buildCliLaunchCommand('antigravity', 'hi')).toBe("agy --prompt-interactive 'hi'\r");
    // OpenClaw's interactive TUI is `openclaw chat`; its initial message rides on
    // `--message` (the positional isn't the prompt).
    expect(buildCliLaunchCommand('openclaw', 'hi')).toBe("openclaw chat --message 'hi'\r");
    // Hermes takes NO starting-prompt argument — `hermes chat` launches promptless
    // and the prompt is PTY-injected (see buildStartupInjectionBytes), so the argv
    // never carries it regardless of the prompt passed.
    expect(buildCliLaunchCommand('hermes', 'hi')).toBe('hermes chat\r');
  });

  it('escapes the prompt identically for every argv-prompt CLI regardless of fixed args', () => {
    for (const cli of TERMINAL_CLI_IDS) {
      // Injection CLIs (Hermes) deliver the prompt out-of-band, not on the argv —
      // their command is the promptless `<bin> <subcommand>`, so the "prompt is the
      // final escaped arg" invariant doesn't apply. Covered by the injection tests.
      if (startupInjectionFor(cli, 'darwin') != null) continue;
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
    expect(buildCliLaunchArgString('copilot', 'hi')).toBe("copilot --interactive 'hi'");
    expect(buildCliLaunchArgString('cursor', 'hi')).toBe("cursor-agent 'hi'");
    expect(buildCliLaunchArgString('opencode', 'hi')).toBe("opencode --prompt 'hi'");
    expect(buildCliLaunchArgString('pi', 'hi')).toBe("pi 'hi'");
    expect(buildCliLaunchArgString('antigravity', 'hi')).toBe("agy --prompt-interactive 'hi'");
    // OpenClaw: fixed `chat` subcommand + `--message` prompt flag.
    expect(buildCliLaunchArgString('openclaw', 'hi')).toBe("openclaw chat --message 'hi'");
    // Hermes: injection CLI — the prompt is dropped from the argv (delivered by a
    // post-launch PTY paste), leaving the promptless `hermes chat` shape.
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
      // OpenCode carries a prompt on `--prompt`; with no prompt the flag is
      // dropped entirely so the bare TUI opens (positional stays the cwd).
      expect(buildCliLaunchArgString('opencode', emptyPrompt)).toBe('opencode');
      // The fixed `chat` subcommand survives a promptless launch (bare `openclaw`/
      // `hermes` isn't the interactive TUI); only the `--message` flag is dropped.
      expect(buildCliLaunchArgString('openclaw', emptyPrompt)).toBe('openclaw chat');
      expect(buildCliLaunchArgString('hermes', emptyPrompt)).toBe('hermes chat');
    }
  });

  it('still applies Claude MCP pre-approval on a promptless launch when opted in', () => {
    const arg = buildCliLaunchArgString('claude', null, { mcpPreApprove: true });
    expect(arg).toBe(`claude ${CLAUDE_PREAPPROVE}`);
    // No trailing space and no prompt arg: the pre-approval flag is the last token.
    expect(arg.endsWith(' ')).toBe(false);
  });

  it('still applies Claude OK auto-approve on a promptless launch, alone and merged with pre-approval', () => {
    // The cross-product of the two independent branches: with no prompt to trail
    // it, `trimEnd()` must strip the separator space WITHOUT eating the settings
    // arg. A regression here would silently drop auto-approve from "New chat".
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
    // Bracketed paste (DEC 2004) makes the TUI treat the bytes as literal pasted
    // text, then `\r` submits the now-complete input.
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
    // A bare newline in a TUI input box normally submits; inside bracketed paste it
    // is preserved, so the whole multi-line prompt lands as one input.
    const multi = 'line one\nline two\nline three';
    expect(buildStartupInjectionBytes('hermes', multi, 'darwin')).toBe(`${START}${multi}${END}\r`);
  });

  it('strips ESC so the prompt cannot terminate the paste frame or inject a sequence', () => {
    // A literal END sentinel (or any ESC) in the prompt would break out of the
    // paste; every ESC byte is removed, neutralizing the break-out.
    const hostile = `abc${END}rm -rf /\x1b[2J`;
    const bytes = buildStartupInjectionBytes('hermes', hostile, 'darwin');
    // Exactly one START and one END remain — the frame we added, not the payload's.
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
    // Keying on the terminal-protocol escape (not UI prose) is what makes the
    // ready detection language- and version-stable; it's also the exact
    // precondition for the paste to be honored.
    expect(cfg?.readyMarker).toBe('\x1b[?2004h');
    // The cap fallback must sit strictly after the post-marker debounce so the
    // marker path wins on a normal boot and the cap only catches a missing marker.
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
    // Same constant the CLI writes into mcpServers[...]; if these diverge the
    // pre-approval would target a server name the registered entry never uses.
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

  // A bare tool-name DENY rule removes the tool from Claude's context instead of
  // prompting for it, so a deny-gated `move` / `delete` is invisible to the agent
  // rather than confirmable. The gate must always be `ask`.
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

// Spelled out here rather than read back from the module. The set and the union
// cannot disagree - both derive from one `as const` vocabulary tuple in the
// source - so there is no agreement left to test; what is worth pinning is the
// vocabulary itself, which the launch composers and the renderer's notice
// handling are written against.
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
