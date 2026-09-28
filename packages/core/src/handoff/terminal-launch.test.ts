import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const spawnSyncMock = vi.mocked(spawnSync);

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
  isWindowsShellLaunchFailureReason,
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
  WindowsShellLaunchError,
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

  it('keeps the env and PATH dirs of a support-file launch while dropping its arguments', () => {
    expect(
      launchWithoutSupportFile({
        executable: 'claude',
        args: ['--settings', 'x.json'],
        env: { A: '1' },
        pathPrepend: ['/rt/bin'],
        supportFile: {
          kind: 'claude-settings',
          relativePath: '.ok/local/terminal/claude-settings-mcp.json',
          contents: '{}',
        },
      }),
    ).toEqual({ executable: 'claude', args: [], env: { A: '1' }, pathPrepend: ['/rt/bin'] });
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
    ).toThrow(
      expect.objectContaining({ name: 'WindowsShellLaunchError', reason: 'unsafe-argument' }),
    );
  });

  it('reports every compose refusal as a typed reason rather than a display string', () => {
    const reasons = [
      [
        'unsupported-shell',
        () =>
          composeWindowsShellLaunchArgs('C:\\Tools\\fish.exe', {
            executable: 'npm',
            args: [],
          }),
      ],
      [
        'invalid-launch',
        () =>
          composeWindowsShellLaunchArgs('C:\\Windows\\System32\\cmd.exe', {
            executable: '',
            args: [],
          }),
      ],
      [
        'unsafe-argument',
        () =>
          composeWindowsShellLaunchArgs('C:\\Windows\\System32\\cmd.exe', {
            executable: 'npm',
            args: ['a b'],
          }),
      ],
    ] as const;
    for (const [reason, compose] of reasons) {
      let caught: unknown = null;
      try {
        compose();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WindowsShellLaunchError);
      expect((caught as WindowsShellLaunchError).reason).toBe(reason);
      expect(isWindowsShellLaunchFailureReason((caught as WindowsShellLaunchError).reason)).toBe(
        true,
      );
    }
    expect(isWindowsShellLaunchFailureReason('unsafe batch argument')).toBe(false);
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

const DROPPED_NAME_CONTROL_CHARACTERS: ReadonlyArray<readonly [label: string, character: string]> =
  [
    ['U+0000 (C0)', '\u0000'],
    ['U+0001 (C0)', '\u0001'],
    ['U+000A (C0)', '\u000a'],
    ['U+001B (C0)', '\u001b'],
    ['U+001F (C0)', '\u001f'],
    ['U+007F (DEL)', '\u007f'],
    ['U+0080 (C1)', '\u0080'],
    ['U+0085 (C1)', '\u0085'],
    ['U+009B (C1)', '\u009b'],
    ['U+009F (C1)', '\u009f'],
  ];

const DROPPED_NAME_TYPED_CHARACTERS: ReadonlyArray<readonly [label: string, character: string]> = [
  ['U+0020', '\u0020'],
  ['U+007E', '\u007e'],
  ['U+00A0', '\u00a0'],
  ['U+200B', '\u200b'],
  ['U+200E', '\u200e'],
  ['U+2028', '\u2028'],
  ['U+202E', '\u202e'],
  ['U+202F', '\u202f'],
  ['U+2066', '\u2066'],
  ['U+FEFF', '\ufeff'],
];

const LATIN_1_CODE_POINTS = Array.from({ length: 0x100 }, (_, codePoint) => codePoint);

function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

function droppedWindowsPath(character: string): string {
  return `C:\\Users\\me\\a${character}b.md`;
}

describe.each([
  ['powershell', "'", ''],
  ['cmd', '"', '!"%'],
  ['bash', "'", ''],
] as const)('quoteWindowsShellPath for a %s terminal', (family, quote, otherRefusedCharacters) => {
  const quotesCodePoint = (codePoint: number): boolean =>
    quoteWindowsShellPath(family, droppedWindowsPath(String.fromCharCode(codePoint))) !== null;
  const exceptions = Array.from(otherRefusedCharacters, (character) =>
    formatCodePoint(character.charCodeAt(0)),
  );

  it.each(DROPPED_NAME_CONTROL_CHARACTERS)(
    'refuses a dropped path containing %s',
    (_label, character) => {
      expect(quoteWindowsShellPath(family, droppedWindowsPath(character))).toBeNull();
    },
  );

  it.each(DROPPED_NAME_TYPED_CHARACTERS)(
    'quotes a dropped path containing %s as-is',
    (_label, character) => {
      const path = droppedWindowsPath(character);
      expect(quoteWindowsShellPath(family, path)).toBe(`${quote}${path}${quote}`);
    },
  );

  it('refuses every control character from U+0000 to U+00FF', () => {
    const controls = LATIN_1_CODE_POINTS.filter(isControlCodePoint);
    const refused = controls.filter((codePoint) => !quotesCodePoint(codePoint));
    expect(refused.map(formatCodePoint)).toEqual(controls.map(formatCodePoint));
  });

  it(`quotes every other character from U+0000 to U+00FF${exceptions.length === 0 ? '' : ` except ${exceptions.join(', ')}`}`, () => {
    const others = LATIN_1_CODE_POINTS.filter(
      (codePoint) =>
        !isControlCodePoint(codePoint) &&
        !otherRefusedCharacters.includes(String.fromCharCode(codePoint)),
    );
    const quoted = others.filter(quotesCodePoint);
    expect(quoted.map(formatCodePoint)).toEqual(others.map(formatCodePoint));
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

type DetachedSpawnSyncOptions = SpawnSyncOptionsWithStringEncoding & { detached: true };

const REAL_BASH_PROBE_SPAWN_OPTIONS: DetachedSpawnSyncOptions = {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 20_000,
  killSignal: 'SIGKILL',
  encoding: 'utf8',
};

describe('real-bash probe spawn isolation', () => {
  it('spawns the interactive bash detached from the session controlling terminal (undetached, an interactive bash under a tty acquires the ctty from a background process group and stops the whole vitest task group)', () => {
    expect(
      REAL_BASH_PROBE_SPAWN_OPTIONS.detached,
      'the real-bash probe must spawn with detached: true; without it an interactive bash (--login -i) acquires the session controlling terminal from a background process group and stops the entire vitest task group',
    ).toBe(true);
  });

  it('keeps stdin off the terminal so the spawned shell never reads the session tty', () => {
    expect(REAL_BASH_PROBE_SPAWN_OPTIONS.stdio?.[0]).toBe('ignore');
  });

  it('bounds the probe spawn at 20s (vitest testTimeout cannot preempt a worker blocked inside spawnSync, so the bound must live on the spawn options)', () => {
    expect(
      REAL_BASH_PROBE_SPAWN_OPTIONS.timeout,
      'the real-bash probe must carry a spawn-level timeout; a probe that wedges would otherwise block the worker inside spawnSync with no bound, because vitest testTimeout runs on the blocked worker and cannot preempt the synchronous call',
    ).toBe(20_000);
  });

  it('kills the wedged probe rather than signaling it (interactive bash ignores SIGTERM and spawnSync escalates nothing)', () => {
    expect(
      REAL_BASH_PROBE_SPAWN_OPTIONS.killSignal,
      'the timeout bound must terminate the shell: spawnSync sends exactly one killSignal with no escalation and interactive bash ignores SIGTERM, so the default signal lets a wedged interactive bash --login -i outlive the bound and block the worker unbounded',
    ).toBe('SIGKILL');
  });
});

describe('Git Bash structured launch, run by a real Bash', () => {
  it.skipIf(NUL_MAPFILE_BASH === '')(
    'reconstructs every launch token byte-for-byte, empty argument and trailing newline included',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'ok-git-bash-launch-'));
      try {
        const capturedArgvPath = join(dir, 'argv');
        const capturedShellStatPath = join(dir, 'shell-stat');
        const capturePath = join(dir, 'capture.cjs');
        writeFileSync(
          capturePath,
          "const { execFileSync } = require('node:child_process');\n" +
            "const { writeFileSync } = require('node:fs');\n" +
            "writeFileSync(process.env.OK_CAPTURED_ARGV, [process.argv0, ...process.argv.slice(1)].join('\\0') + '\\0');\n" +
            "if (process.platform !== 'win32') writeFileSync(process.env.OK_CAPTURED_SHELL_STAT, execFileSync('ps', ['-o', 'stat=', '-p', String(process.ppid)], { encoding: 'utf8' }));\n",
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
          ...REAL_BASH_PROBE_SPAWN_OPTIONS,
          env: {
            ...process.env,
            HOME: dir,
            OK_CAPTURED_ARGV: capturedArgvPath,
            OK_CAPTURED_SHELL_STAT: capturedShellStatPath,
          },
        });
        const recordedOptions = spawnSyncMock.mock.calls.find(
          ([, recordedArgs]) => recordedArgs?.[0] === '--login',
        )?.[2] as Partial<typeof REAL_BASH_PROBE_SPAWN_OPTIONS> | undefined;
        expect(
          recordedOptions,
          'the behavioral probe must route through the spawnSync recorder; its options are asserted from the recorded call so an inline-args edit at this call site cannot bypass the pins',
        ).toBeDefined();
        expect(
          recordedOptions?.detached,
          'the recorded behavioral call must spawn detached: true; without it an interactive bash acquires the session controlling terminal from a background process group and stops the whole vitest task group',
        ).toBe(true);
        expect(recordedOptions?.stdio?.[0]).toBe('ignore');
        expect(recordedOptions?.timeout).toBe(20_000);
        expect(recordedOptions?.killSignal).toBe('SIGKILL');
        expect(recordedOptions?.encoding).toBe('utf8');
        expect(run.error).toBeUndefined();
        expect(existsSync(capturedArgvPath), `bash stderr: ${run.stderr}`).toBe(true);

        expect(readFileSync(capturedArgvPath, 'utf8').split('\u0000')).toEqual([
          ...launchTokens,
          '',
        ]);

        if (process.platform !== 'win32') {
          expect(
            readFileSync(capturedShellStatPath, 'utf8'),
            'the spawned shell must be a session leader (detached: true makes libuv setsid the child into a new session); a forked child carries the s stat flag only when detached, so an undetached spawn reacquires the session controlling terminal from a background process group and stops the whole vitest task group',
          ).toContain('s');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

const POWERSHELL_SINGLE_QUOTES = new Set(["'", '\u2018', '\u2019', '\u201A', '\u201B']);

interface PowerShellLiteralReadback {
  readonly literal: string | null;
  readonly wholeLine: boolean;
}

function readFirstPowerShellLiteral(line: string): PowerShellLiteralReadback {
  if (!POWERSHELL_SINGLE_QUOTES.has(line.charAt(0))) return { literal: null, wholeLine: false };
  let literal = '';
  let index = 1;
  while (index < line.length) {
    const char = line.charAt(index);
    if (!POWERSHELL_SINGLE_QUOTES.has(char)) {
      literal += char;
      index += 1;
      continue;
    }
    const next = line.charAt(index + 1);
    if (!POWERSHELL_SINGLE_QUOTES.has(next)) {
      return { literal, wholeLine: line.slice(index + 1).trim() === '' };
    }
    literal += next;
    index += 2;
  }
  return { literal, wholeLine: false };
}

const PWSH_7_6_6_FIRST_LITERALS: ReadonlyArray<readonly [line: string, literal: string]> = [
  ["'C:\\Users\\me\\O''Brien.md' ", "C:\\Users\\me\\O'Brien.md"],
  ["'C:\\Users\\me\\Nick\u2019s notes.md' ", 'C:\\Users\\me\\Nick'],
  ["'C:\\Users\\me\\\u2018draft.md' ", 'C:\\Users\\me\\'],
  ["'C:\\Users\\me\\a\u201Ab.md' ", 'C:\\Users\\me\\a'],
  ["'C:\\Users\\me\\a\u201Bb.md' ", 'C:\\Users\\me\\a'],
  ["'C:\\Users\\me\\Nick\u2019\u2019s notes.md' ", 'C:\\Users\\me\\Nick\u2019s notes.md'],
  ["'C:\\Users\\me\\Nick\u2019's notes.md' ", "C:\\Users\\me\\Nick's notes.md"],
  [
    "'C:\\Users\\me\\O''Brien\u2019\u2019s \u2018\u2018draft\u2019\u2019.md' ",
    "C:\\Users\\me\\O'Brien\u2019s \u2018draft\u2019.md",
  ],
  [
    "'C:\\Users\\me\\O''Brien\u2019's \u2018'draft\u2019'.md' ",
    "C:\\Users\\me\\O'Brien's 'draft'.md",
  ],
  [
    "'a\u2018\u2018b\u2019\u2019c\u201A\u201Ad\u201B\u201Be.md' ",
    'a\u2018b\u2019c\u201Ad\u201Be.md',
  ],
  ["'a\u2018'b\u2019'c\u201A'd\u201B'e.md' ", "a'b'c'd'e.md"],
];

const READ_BACK_NAMES: ReadonlyArray<readonly [label: string, name: string]> = [
  ['a right single quotation mark', 'C:\\Users\\me\\Nick\u2019s notes.md'],
  ['left and right single quotation marks', 'C:\\Users\\me\\\u2018draft\u2019.md'],
  ['low-9 and high-reversed-9 quotation marks', 'C:\\Users\\me\\a\u201Ab\u201Bc.md'],
  ['straight and curly quotes side by side', "C:\\Users\\me\\O'Brien\u2019s \u2018'\u2019 copy.md"],
  [
    'curly double quotes and apostrophe-like letters',
    'C:\\Users\\me\\\u201ENotizen\u201C \u201Cnotes\u201D it\u02BCs 5\u2032.md',
  ],
];

const POWERSHELL_PATH_NAME = fc.string({
  unit: fc.constantFrom(
    'a',
    'Z',
    ' ',
    '\\',
    '.',
    "'",
    '\u2018',
    '\u2019',
    '\u201A',
    '\u201B',
    '\u201C',
    '\u201D',
    '"',
    '`',
    '$',
    '\u02BC',
    '\u{1F4DD}',
  ),
  maxLength: 16,
});

describe('psQuoteArg with curly single quotes', () => {
  it.each([
    ['U+2018', '\u2018draft.md', "'\u2018\u2018draft.md'"],
    ['U+2019', 'Nick\u2019s notes.md', "'Nick\u2019\u2019s notes.md'"],
    ['U+201A', 'a\u201Ab.md', "'a\u201A\u201Ab.md'"],
    ['U+201B', 'a\u201Bb.md', "'a\u201B\u201Bb.md'"],
  ])(
    'doubles %s with itself, the way PowerShell escapes a single-quoted string',
    (_codePoint, name, quoted) => {
      expect(psQuoteArg(name)).toBe(quoted);
    },
  );
});

describe('psQuoteArg output read back by a model of the PowerShell tokenizer', () => {
  it('reads the same first literal that PowerShell 7.6.6 read from each recorded line', () => {
    expect(
      PWSH_7_6_6_FIRST_LITERALS.map(([line]) => readFirstPowerShellLiteral(line).literal),
    ).toEqual(PWSH_7_6_6_FIRST_LITERALS.map(([, literal]) => literal));
  });

  it.each(READ_BACK_NAMES)('reads back a name with %s exactly', (_label, name) => {
    expect(readFirstPowerShellLiteral(psQuoteArg(name))).toEqual({
      literal: name,
      wholeLine: true,
    });
  });

  it('reads back any name built from quotes, spaces and path characters exactly', () => {
    fc.assert(
      fc.property(POWERSHELL_PATH_NAME, (name) => {
        expect(readFirstPowerShellLiteral(psQuoteArg(name))).toEqual({
          literal: name,
          wholeLine: true,
        });
      }),
      { seed: 42 },
    );
  });
});

const POWERSHELL = process.env.OK_TEST_PWSH ?? 'pwsh';

const POWERSHELL_READBACK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$lines = Get-Content -Raw -LiteralPath $env:OK_TEST_POWERSHELL_LINES | ConvertFrom-Json',
  'foreach ($line in $lines) {',
  '  $tokens = $null',
  '  $errors = $null',
  '  [void][System.Management.Automation.Language.Parser]::ParseInput($line, [ref]$tokens, [ref]$errors)',
  "  $significant = @($tokens | Where-Object { $_.Kind -ne 'EndOfInput' -and $_.Kind -ne 'NewLine' })",
  '  [ordered]@{',
  '    errors = @($errors).Count',
  "    tokens = @($significant | ForEach-Object { [ordered]@{ kind = [string]$_.Kind; value = if ($_.Kind -eq 'StringLiteral') { $_.Value } else { $_.Text } } })",
  '  } | ConvertTo-Json -Compress -Depth 5 -EscapeHandling EscapeNonAscii',
  '}',
].join('\n');

interface PowerShellToken {
  readonly kind: string;
  readonly value: string;
}

interface PowerShellParse {
  readonly errors: number;
  readonly tokens: readonly PowerShellToken[];
}

function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^ -~]/gu, (char) =>
    Array.from(
      { length: char.length },
      (_, index) => `\\u${char.charCodeAt(index).toString(16).padStart(4, '0')}`,
    ).join(''),
  );
}

function parseWithRealPowerShell(lines: readonly string[]): PowerShellParse[] | null {
  const dir = mkdtempSync(join(tmpdir(), 'ok-powershell-readback-'));
  try {
    const linesPath = join(dir, 'lines.json');
    const scriptPath = join(dir, 'readback.ps1');
    writeFileSync(linesPath, asciiJson(lines));
    writeFileSync(scriptPath, POWERSHELL_READBACK_SCRIPT);
    const run = spawnSync(
      POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath],
      {
        ...REAL_BASH_PROBE_SPAWN_OPTIONS,
        windowsHide: true,
        env: {
          ...process.env,
          HOME: dir,
          XDG_CACHE_HOME: join(dir, 'cache'),
          XDG_CONFIG_HOME: join(dir, 'config'),
          XDG_DATA_HOME: join(dir, 'data'),
          POWERSHELL_TELEMETRY_OPTOUT: '1',
          POWERSHELL_UPDATECHECK: 'Off',
          OK_TEST_POWERSHELL_LINES: linesPath,
        },
      },
    );
    if ((run.error as { code?: unknown } | undefined)?.code === 'ENOENT') {
      expect(
        process.env.CI,
        `${POWERSHELL} is not on PATH, and a CI run must read these lines back with a real PowerShell parser instead of skipping`,
      ).not.toBe('true');
      return null;
    }
    expect(run.error, `pwsh stderr: ${run.stderr}`).toBeUndefined();
    expect(run.status, `pwsh stderr: ${run.stderr}`).toBe(0);
    const parses = run.stdout
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as PowerShellParse);
    expect(parses).toHaveLength(lines.length);
    return parses;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('psQuoteArg output read back by a real PowerShell parser', () => {
  it('reads back every name exactly, as a value and as a command argument', (context) => {
    const names = [
      ...READ_BACK_NAMES.map(([, name]) => name),
      ...fc.sample(POWERSHELL_PATH_NAME, { seed: 42, numRuns: 50 }),
    ];
    const recordedLines = PWSH_7_6_6_FIRST_LITERALS.map(([line]) => line);
    const parses = parseWithRealPowerShell([
      ...recordedLines,
      ...names.map((name) => `${psQuoteArg(name)} `),
      ...names.map((name) => `Write-Output ${psQuoteArg(name)} `),
    ]);
    if (parses === null) return context.skip(`${POWERSHELL} is not on PATH`);

    expect(
      parses
        .slice(0, recordedLines.length)
        .map((parse) => parse.tokens.find((token) => token.kind === 'StringLiteral')?.value),
    ).toEqual(PWSH_7_6_6_FIRST_LITERALS.map(([, literal]) => literal));
    expect(parses.slice(recordedLines.length, recordedLines.length + names.length)).toEqual(
      names.map((name) => ({ errors: 0, tokens: [{ kind: 'StringLiteral', value: name }] })),
    );
    expect(parses.slice(recordedLines.length + names.length)).toEqual(
      names.map((name) => ({
        errors: 0,
        tokens: [
          { kind: 'Generic', value: 'Write-Output' },
          { kind: 'StringLiteral', value: name },
        ],
      })),
    );
  });
});

const CURLY_QUOTE_LAUNCH = {
  executable: 'C:\\Users\\me\\Nick\u2019s agents\\agent.exe',
  args: ['--config', 'C:\\Users\\me\\\u2018work\u2019 profile.json', '--label', 'a\u201Ab\u201Bc'],
};

const CURLY_QUOTE_LAUNCH_WITH_ENV = {
  ...CURLY_QUOTE_LAUNCH,
  env: { AGENT_HOME: 'C:\\Users\\me\\.agent' },
};

const CURLY_QUOTE_LAUNCH_CALL =
  "& 'C:\\Users\\me\\Nick\u2019\u2019s agents\\agent.exe' '--config' 'C:\\Users\\me\\\u2018\u2018work\u2019\u2019 profile.json' '--label' 'a\u201A\u201Ab\u201B\u201Bc'";

function decodePowerShellLaunchScript(composed: string[] | string): string {
  expect(Array.isArray(composed)).toBe(true);
  expect(composed.slice(0, 2)).toEqual(['-NoExit', '-EncodedCommand']);
  return Buffer.from(composed[2] ?? '', 'base64').toString('utf16le');
}

describe('PowerShell launch composition with curly single quotes', () => {
  it('doubles each curly single quote in the executable and arguments with itself', () => {
    expect(
      decodePowerShellLaunchScript(composeWindowsShellLaunchArgs('pwsh.exe', CURLY_QUOTE_LAUNCH)),
    ).toBe(CURLY_QUOTE_LAUNCH_CALL);
  });

  it('doubles them the same way in a launch that sets environment variables', () => {
    expect(
      decodePowerShellLaunchScript(
        composeWindowsShellLaunchArgs('pwsh.exe', CURLY_QUOTE_LAUNCH_WITH_ENV),
      ),
    ).toBe(
      "$__ok_names = @('AGENT_HOME'); $__ok_slots = @('OK_TERMINAL_LAUNCH_ENV_0'); $__ok_prev = @{}; " +
        'for ($__ok_i = 0; $__ok_i -lt $__ok_names.Length; $__ok_i++) { ' +
        '$__ok_prev[$__ok_names[$__ok_i]] = [Environment]::GetEnvironmentVariable($__ok_names[$__ok_i]); ' +
        "[Environment]::SetEnvironmentVariable($__ok_names[$__ok_i], [Environment]::GetEnvironmentVariable($__ok_slots[$__ok_i]), 'Process') }; " +
        `try { ${CURLY_QUOTE_LAUNCH_CALL} } finally { ` +
        'for ($__ok_i = 0; $__ok_i -lt $__ok_names.Length; $__ok_i++) { ' +
        "[Environment]::SetEnvironmentVariable($__ok_names[$__ok_i], $__ok_prev[$__ok_names[$__ok_i]], 'Process'); " +
        "[Environment]::SetEnvironmentVariable($__ok_slots[$__ok_i], $null, 'Process') }; " +
        'Remove-Variable __ok_names, __ok_slots, __ok_prev, __ok_i -ErrorAction SilentlyContinue }',
    );
  });
});

describe('PowerShell launch composition read back by a real PowerShell parser', () => {
  it('reads the call back as one string per launch token, with and without environment variables', (context) => {
    const parses = parseWithRealPowerShell([
      decodePowerShellLaunchScript(composeWindowsShellLaunchArgs('pwsh.exe', CURLY_QUOTE_LAUNCH)),
      decodePowerShellLaunchScript(
        composeWindowsShellLaunchArgs('pwsh.exe', CURLY_QUOTE_LAUNCH_WITH_ENV),
      ),
    ]);
    if (parses === null) return context.skip(`${POWERSHELL} is not on PATH`);

    const call = [
      { kind: 'Ampersand', value: '&' },
      ...[CURLY_QUOTE_LAUNCH.executable, ...CURLY_QUOTE_LAUNCH.args].map((value) => ({
        kind: 'StringLiteral',
        value,
      })),
    ];
    const [plain, withEnv] = parses;
    expect(plain).toEqual({ errors: 0, tokens: call });
    const callStart = withEnv?.tokens.findIndex((token) => token.kind === 'Ampersand') ?? -1;
    expect({
      errors: withEnv?.errors,
      tryBlock: withEnv?.tokens.slice(callStart - 2, callStart + call.length + 2),
    }).toEqual({
      errors: 0,
      tryBlock: [
        { kind: 'Try', value: 'try' },
        { kind: 'LCurly', value: '{' },
        ...call,
        { kind: 'RCurly', value: '}' },
        { kind: 'Finally', value: 'finally' },
      ],
    });
  });
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

describe('composeWindowsShellLaunchArgs with a launch env', () => {
  const NUL = String.fromCharCode(0);
  const launch = {
    executable: 'auggie',
    args: ['--acp', 'login'],
    env: { AUGGIE_HOME: 'C:\\Users\\me\\.auggie', AUGGIE_LOGIN_FLOW: 'terminal' },
  };
  const decodeArgv = (encoded: string) =>
    Buffer.from(encoded, 'base64').toString('utf8').split(NUL).filter(Boolean);

  it('bash hands name and slot pairs to a subshell around the login, then drops the slots', () => {
    const args = composeWindowsShellLaunchArgs(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      launch,
    ) as string[];
    expect(decodeArgv(args[5] ?? '')).toEqual(['auggie', '--acp', 'login']);
    expect(decodeArgv(args[6] ?? '')).toEqual([
      'AUGGIE_HOME',
      'OK_TERMINAL_LAUNCH_ENV_0',
      'AUGGIE_LOGIN_FLOW',
      'OK_TERMINAL_LAUNCH_ENV_1',
    ]);
    expect(args[3]).toContain(
      `(for ((__ok_i = 0; __ok_i < \${#__ok_env[@]}; __ok_i += 2)); do __ok_slot="\${__ok_env[__ok_i + 1]}"; export "\${__ok_env[__ok_i]}=\${!__ok_slot}"; done; exec "\${__ok_argv[@]}"); `,
    );
    expect(args[3]).toContain(
      `for ((__ok_i = 1; __ok_i < \${#__ok_env[@]}; __ok_i += 2)); do unset "\${__ok_env[__ok_i]}"; done; exec "$BASH" --login -i`,
    );
    expect(args.join(' ')).not.toContain('.auggie');
  });

  it('PowerShell saves what each name held, assigns the slots for the login, and puts the old values back in a finally block', () => {
    const args = composeWindowsShellLaunchArgs('pwsh.exe', launch) as string[];
    const script = Buffer.from(args[2] ?? '', 'base64').toString('utf16le');
    expect(script).toBe(
      "$__ok_names = @('AUGGIE_HOME', 'AUGGIE_LOGIN_FLOW'); $__ok_slots = @('OK_TERMINAL_LAUNCH_ENV_0', 'OK_TERMINAL_LAUNCH_ENV_1'); $__ok_prev = @{}; " +
        'for ($__ok_i = 0; $__ok_i -lt $__ok_names.Length; $__ok_i++) { ' +
        '$__ok_prev[$__ok_names[$__ok_i]] = [Environment]::GetEnvironmentVariable($__ok_names[$__ok_i]); ' +
        "[Environment]::SetEnvironmentVariable($__ok_names[$__ok_i], [Environment]::GetEnvironmentVariable($__ok_slots[$__ok_i]), 'Process') }; " +
        "try { & 'auggie' '--acp' 'login' } finally { " +
        'for ($__ok_i = 0; $__ok_i -lt $__ok_names.Length; $__ok_i++) { ' +
        "[Environment]::SetEnvironmentVariable($__ok_names[$__ok_i], $__ok_prev[$__ok_names[$__ok_i]], 'Process'); " +
        "[Environment]::SetEnvironmentVariable($__ok_slots[$__ok_i], $null, 'Process') }; " +
        'Remove-Variable __ok_names, __ok_slots, __ok_prev, __ok_i -ErrorAction SilentlyContinue }',
    );
    expect(script).not.toContain('.auggie');
    const plain = composeWindowsShellLaunchArgs('pwsh.exe', {
      executable: 'auggie',
      args: ['login'],
    }) as string[];
    expect(Buffer.from(plain[2] ?? '', 'base64').toString('utf16le')).toBe("& 'auggie' 'login'");
  });

  it('cmd runs the login in a child cmd that expands the slots itself, so the tab never holds the names', () => {
    expect(
      composeWindowsShellLaunchArgs('cmd.exe', {
        executable: 'auggie',
        args: ['login'],
        env: { AUGGIE_LOGIN_FLOW: 'terminal' },
      }),
    ).toBe(
      '/K cmd /d /v:on /c "set "AUGGIE_LOGIN_FLOW=!OK_TERMINAL_LAUNCH_ENV_0!" & auggie login" & set "OK_TERMINAL_LAUNCH_ENV_0="',
    );
    expect(
      composeWindowsShellLaunchArgs('cmd.exe', {
        executable: 'auggie',
        args: ['login'],
        env: { AUGGIE_HOME: 'C:\\auggie', AUGGIE_LOGIN_FLOW: 'terminal' },
      }),
    ).toBe(
      '/K cmd /d /v:on /c "set "AUGGIE_HOME=!OK_TERMINAL_LAUNCH_ENV_0!" & set "AUGGIE_LOGIN_FLOW=!OK_TERMINAL_LAUNCH_ENV_1!" & auggie login" & set "OK_TERMINAL_LAUNCH_ENV_0=" & set "OK_TERMINAL_LAUNCH_ENV_1="',
    );
    expect(
      composeWindowsShellLaunchArgs('cmd.exe', { executable: 'auggie', args: ['login'] }),
    ).toBe('/K auggie login');
    expect(
      composeWindowsShellLaunchArgs('cmd.exe', {
        executable: 'auggie',
        args: ['login'],
        env: { AUGGIE_HOME: 'C:\\Users\\me space\\.auggie', AUGGIE_LOGIN_FLOW: 'terminal=yes' },
      }),
    ).toBe(
      '/K cmd /d /v:on /c "set "AUGGIE_HOME=!OK_TERMINAL_LAUNCH_ENV_0!" & set "AUGGIE_LOGIN_FLOW=!OK_TERMINAL_LAUNCH_ENV_1!" & auggie login" & set "OK_TERMINAL_LAUNCH_ENV_0=" & set "OK_TERMINAL_LAUNCH_ENV_1="',
    );
    for (const value of [
      'say "hi"',
      'x" & calc & rem "',
      'a & calc',
      'pipe | more',
      'to > file',
      'from < file',
      'group (x)',
      'caret ^x',
      '%TEMP%',
      '!OK_TERMINAL_LAUNCH_ENV_0!',
      'two\nlines',
      'cr\rhere',
    ]) {
      expect(() =>
        composeWindowsShellLaunchArgs('cmd.exe', {
          executable: 'auggie',
          args: ['login'],
          env: { AUGGIE_LOGIN_FLOW: value },
        }),
      ).toThrow(
        expect.objectContaining({ name: 'WindowsShellLaunchError', reason: 'unsafe-argument' }),
      );
    }
  });

  it.each([
    ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe'],
    ['PowerShell', 'pwsh.exe'],
    ['cmd', 'cmd.exe'],
  ])('%s refuses env names that differ only in case', (_family, shell) => {
    expect(() =>
      composeWindowsShellLaunchArgs(shell, {
        executable: 'auggie',
        args: ['login'],
        env: { Path: 'C:\\agent', PATH: 'C:\\other' },
      }),
    ).toThrow(
      expect.objectContaining({ name: 'WindowsShellLaunchError', reason: 'invalid-launch' }),
    );
  });

  it.each([
    ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe'],
    ['PowerShell', 'pwsh.exe'],
    ['cmd', 'cmd.exe'],
  ])('%s refuses env names that are not identifiers and values with NUL', (_family, shell) => {
    for (const env of [
      { 'X; Start-Process calc; $y': '1' },
      { '--split-string': 'evil' },
      { 'A B': '1' },
      { '1ABC': '1' },
      { OK_TERMINAL_LAUNCH_ENV_0: 'reserved for the slot the launch itself uses' },
      { ok_terminal_launch_env_0: 'the same slot on a case-folding shell' },
      { OK: `a${NUL}b` },
    ]) {
      expect(() =>
        composeWindowsShellLaunchArgs(shell, { executable: 'auggie', args: ['login'], env }),
      ).toThrow(WindowsShellLaunchError);
    }
  });
});
