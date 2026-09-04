import { MCP_SERVER_NAME } from '../constants/mcp.ts';
import type { HandoffTarget } from './types.ts';

export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface TerminalLaunchCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly supportFile?: {
    readonly kind: 'claude-settings';
    readonly relativePath: string;
    readonly contents: string;
  };
}

function claudeSettingsFileArgs(relativePath: string): readonly string[] {
  return ['--settings', relativePath];
}

export function launchWithoutSupportFile(launch: TerminalLaunchCommand): TerminalLaunchCommand {
  if (launch.supportFile === undefined) return launch;
  return { executable: launch.executable, args: [] };
}

const WINDOWS_SHELL_FAMILY_VOCABULARY = ['powershell', 'cmd', 'bash'] as const;

export type WindowsShellFamily = (typeof WINDOWS_SHELL_FAMILY_VOCABULARY)[number];

export const WINDOWS_SHELL_FAMILIES: ReadonlySet<WindowsShellFamily> = new Set(
  WINDOWS_SHELL_FAMILY_VOCABULARY,
);

export function isWindowsShellFamily(value: unknown): value is WindowsShellFamily {
  return typeof value === 'string' && WINDOWS_SHELL_FAMILIES.has(value as WindowsShellFamily);
}

export function psQuoteArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const BASH_STRUCTURED_LAUNCH_SCRIPT =
  `mapfile -d '' -t __ok_argv < <(printf '%s' "$1" | base64 -d); ` +
  `((\${#__ok_argv[@]})) || exit 1; "\${__ok_argv[@]}"; exec "$BASH" --login -i`;

export function encodePowerShellCommand(script: string): string {
  let binary = '';
  for (let i = 0; i < script.length; i += 1) {
    const codeUnit = script.charCodeAt(i);
    binary += String.fromCharCode(codeUnit & 0xff, codeUnit >>> 8);
  }
  return btoa(binary);
}

export function resolveWindowsShellFamily(shell: string): WindowsShellFamily | null {
  const base = shell.split(/[\\/]/).at(-1)?.toLowerCase();
  if (
    base === 'pwsh' ||
    base === 'pwsh.exe' ||
    base === 'powershell' ||
    base === 'powershell.exe'
  ) {
    return 'powershell';
  }
  if (base === 'cmd' || base === 'cmd.exe') return 'cmd';
  if (base === 'bash' || base === 'bash.exe') return 'bash';
  return null;
}

function isCmdSafeToken(value: string): boolean {
  return (
    value.length > 0 &&
    !Array.from(value).some((ch) => ch.charCodeAt(0) < 0x20) &&
    !/[\s"%!&|<>^()]/u.test(value)
  );
}

export function composeWindowsShellLaunchArgs(
  shell: string,
  launch: TerminalLaunchCommand,
): string[] | string {
  const family = resolveWindowsShellFamily(shell);
  if (family === null) throw new Error('unsupported Windows terminal shell');
  if (
    launch.executable.length === 0 ||
    launch.executable.includes('\u0000') ||
    launch.args.some((arg) => arg.includes('\u0000'))
  ) {
    throw new Error('invalid Windows terminal launch');
  }
  if (family === 'bash') {
    return [
      '--login',
      '-i',
      '-c',
      BASH_STRUCTURED_LAUNCH_SCRIPT,
      'bash',
      encodeUtf8Base64(`${[launch.executable, ...launch.args].join('\u0000')}\u0000`),
    ];
  }
  const batchTarget = /\.(?:cmd|bat)$/iu.test(launch.executable);
  if (family === 'cmd' || batchTarget) {
    const tokens = [launch.executable, ...launch.args];
    if (tokens.some((token) => !isCmdSafeToken(token))) {
      throw new Error('unsafe batch argument');
    }
    if (family === 'cmd') return `/K ${tokens.join(' ')}`;
  }
  const script = `& ${psQuoteArg(launch.executable)}${launch.args
    .map((arg) => ` ${psQuoteArg(arg)}`)
    .join('')}`;
  return ['-NoExit', '-EncodedCommand', encodePowerShellCommand(script)];
}

export function quoteWindowsShellPath(family: WindowsShellFamily, path: string): string | null {
  if (path.length === 0 || Array.from(path).some((ch) => ch.charCodeAt(0) < 0x20)) return null;
  if (family === 'powershell') return psQuoteArg(path);
  if (family === 'bash') return shellSingleQuote(path);
  if (/["%!]/u.test(path)) return null;
  return `"${path}"`;
}

export type TerminalCli =
  | 'claude'
  | 'codex'
  | 'copilot'
  | 'cursor'
  | 'opencode'
  | 'pi'
  | 'antigravity'
  | 'openclaw'
  | 'hermes';

export interface TerminalCliInfo {
  readonly bin: string;
  readonly autoApproveArg?: string;
  readonly displayName: string;
  readonly docsUrl: string;
  readonly handoffTarget: HandoffTarget;
  readonly subcommand?: string;
  readonly promptFlag?: string;
  readonly startupInjection?: {
    readonly submit: string;
    readonly readyMarker?: string;
    readonly settleMs: number;
    readonly capMs: number;
  };
}

const OK_AUTO_APPROVE_ALLOW_RULES: readonly string[] = [
  `mcp__${MCP_SERVER_NAME}`,
  'Bash(ok open:*)',
];

export const OK_GATED_TOOL_NAMES: readonly string[] = [
  'delete',
  'move',
  'share_link',
  'install',
  'import',
];

const OK_AUTO_APPROVE_ASK_RULES: readonly string[] = OK_GATED_TOOL_NAMES.map(
  (tool) => `mcp__${MCP_SERVER_NAME}__${tool}`,
);

const CODEX_OK_AUTO_APPROVE_ARG = `-c ${shellSingleQuote(
  `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
)}`;

function buildClaudeSettingsJson(opts: BuildCliLaunchOptions): string | null {
  const settings: {
    enabledMcpjsonServers?: string[];
    permissions?: { allow: string[]; ask: string[] };
  } = {};
  if (opts.mcpPreApprove === true) {
    settings.enabledMcpjsonServers = [MCP_SERVER_NAME];
  }
  if (opts.autoApproveOkTools === true) {
    settings.permissions = {
      allow: [...OK_AUTO_APPROVE_ALLOW_RULES],
      ask: [...OK_AUTO_APPROVE_ASK_RULES],
    };
  }
  if (settings.enabledMcpjsonServers === undefined && settings.permissions === undefined) {
    return null;
  }
  return JSON.stringify(settings);
}

function buildClaudeSettingsArg(opts: BuildCliLaunchOptions): string {
  const settingsJson = buildClaudeSettingsJson(opts);
  return settingsJson === null ? '' : `--settings ${shellSingleQuote(settingsJson)}`;
}

const ESC = '\x1b';
const BRACKETED_PASTE_START = `${ESC}[200~`;
const BRACKETED_PASTE_END = `${ESC}[201~`;

const BRACKETED_PASTE_ENABLE_MARKER = '\x1b[?2004h';
const HERMES_INJECT_DEBOUNCE_MS = 300;
const HERMES_INJECT_CAP_MS = 4000;
const WINDOWS_INJECT_SETTLE_MS = 800;
const WINDOWS_INJECT_CAP_MS = 4000;
const WINDOWS_STARTUP_INJECTION: NonNullable<TerminalCliInfo['startupInjection']> = {
  submit: '\r',
  readyMarker: BRACKETED_PASTE_ENABLE_MARKER,
  settleMs: WINDOWS_INJECT_SETTLE_MS,
  capMs: WINDOWS_INJECT_CAP_MS,
};

export const TERMINAL_CLIS = {
  claude: {
    bin: 'claude',
    displayName: 'Claude',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code',
    handoffTarget: 'claude-code',
  },
  codex: {
    bin: 'codex',
    displayName: 'Codex',
    docsUrl: 'https://developers.openai.com/codex/cli',
    handoffTarget: 'codex',
    autoApproveArg: CODEX_OK_AUTO_APPROVE_ARG,
  },
  copilot: {
    bin: 'copilot',
    displayName: 'GitHub Copilot',
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started',
    handoffTarget: 'copilot',
    promptFlag: '--interactive',
  },
  cursor: {
    bin: 'cursor-agent',
    displayName: 'Cursor',
    docsUrl: 'https://cursor.com/docs/cli/overview',
    handoffTarget: 'cursor',
  },
  opencode: {
    bin: 'opencode',
    displayName: 'OpenCode',
    docsUrl: 'https://opencode.ai/docs',
    handoffTarget: 'opencode',
    promptFlag: '--prompt',
  },
  pi: {
    bin: 'pi',
    displayName: 'Pi',
    docsUrl: 'https://pi.dev',
    handoffTarget: 'pi',
  },
  antigravity: {
    bin: 'agy',
    displayName: 'Antigravity',
    docsUrl: 'https://antigravity.google/docs/cli-getting-started',
    handoffTarget: 'antigravity',
    promptFlag: '--prompt-interactive',
  },
  openclaw: {
    bin: 'openclaw',
    subcommand: 'chat',
    displayName: 'OpenClaw',
    docsUrl: 'https://docs.openclaw.ai/cli/tui',
    handoffTarget: 'openclaw',
    promptFlag: '--message',
  },
  hermes: {
    bin: 'hermes',
    subcommand: 'chat',
    displayName: 'Hermes',
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/cli',
    handoffTarget: 'hermes',
    startupInjection: {
      submit: '\r',
      readyMarker: BRACKETED_PASTE_ENABLE_MARKER,
      settleMs: HERMES_INJECT_DEBOUNCE_MS,
      capMs: HERMES_INJECT_CAP_MS,
    },
  },
} as const satisfies Record<TerminalCli, TerminalCliInfo>;

export const TERMINAL_CLI_IDS = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'copilot',
  'pi',
  'antigravity',
  'openclaw',
  'hermes',
] as const satisfies readonly TerminalCli[];

export interface BuildCliLaunchOptions {
  readonly mcpPreApprove?: boolean;
  readonly autoApproveOkTools?: boolean;
}

export function buildWindowsCliLaunch(
  cli: TerminalCli,
  _prompt: string | null | undefined,
  opts: BuildCliLaunchOptions = {},
): TerminalLaunchCommand {
  const info: TerminalCliInfo = TERMINAL_CLIS[cli];
  if (cli === 'claude') {
    const settingsJson = buildClaudeSettingsJson(opts);
    if (settingsJson !== null) {
      const variant = [
        opts.mcpPreApprove === true ? 'mcp' : null,
        opts.autoApproveOkTools === true ? 'tools' : null,
      ]
        .filter((part): part is string => part !== null)
        .join('-');
      const relativePath = `.ok/local/terminal/claude-settings-${variant}.json`;
      return {
        executable: info.bin,
        args: [...claudeSettingsFileArgs(relativePath)],
        supportFile: {
          kind: 'claude-settings',
          relativePath,
          contents: settingsJson,
        },
      };
    }
  }
  if (cli === 'codex' && opts.autoApproveOkTools === true) {
    return {
      executable: info.bin,
      args: ['-c', `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode=approve`],
    };
  }
  return {
    executable: info.bin,
    args: info.subcommand ? [info.subcommand] : [],
  };
}

export function buildCliLaunchArgString(
  cli: TerminalCli,
  prompt: string | null | undefined,
  opts: BuildCliLaunchOptions = {},
): string {
  const info: TerminalCliInfo = TERMINAL_CLIS[cli];
  const fixedArgs =
    cli === 'claude'
      ? buildClaudeSettingsArg(opts)
      : opts.autoApproveOkTools === true && info.autoApproveArg
        ? info.autoApproveArg
        : '';
  const fixedPrefix = fixedArgs ? `${fixedArgs} ` : '';
  const sub = info.subcommand ? `${info.subcommand} ` : '';
  if (info.startupInjection != null || prompt == null || prompt.length === 0) {
    return `${info.bin} ${sub}${fixedPrefix}`.trimEnd();
  }
  const promptFlag = info.promptFlag ? `${info.promptFlag} ` : '';
  return `${info.bin} ${sub}${fixedPrefix}${promptFlag}${shellSingleQuote(prompt)}`;
}

export function buildCliLaunchCommand(
  cli: TerminalCli,
  prompt: string,
  opts: BuildCliLaunchOptions = {},
): string {
  return `${buildCliLaunchArgString(cli, prompt, opts)}\r`;
}

export function buildClaudeLaunchCommand(prompt: string, opts: BuildCliLaunchOptions = {}): string {
  return buildCliLaunchCommand('claude', prompt, opts);
}

export function startupInjectionFor(
  cli: TerminalCli,
  platform: NodeJS.Platform,
): TerminalCliInfo['startupInjection'] {
  const info: TerminalCliInfo = TERMINAL_CLIS[cli];
  return info.startupInjection ?? (platform === 'win32' ? WINDOWS_STARTUP_INJECTION : undefined);
}

export function buildStartupInjectionBytes(
  cli: TerminalCli,
  prompt: string | null | undefined,
  platform: NodeJS.Platform,
): string | null {
  const injection = startupInjectionFor(cli, platform);
  if (injection == null || prompt == null || prompt.length === 0) return null;
  const safe = prompt.replaceAll(ESC, '');
  return `${BRACKETED_PASTE_START}${safe}${BRACKETED_PASTE_END}${injection.submit}`;
}
