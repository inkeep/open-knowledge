/**
 * In-app-terminal twin of the Claude Desktop deep-link handoff.
 *
 * The deep-link path puts the scope-specific prompt in the `q=` URL param and
 * opens the target's desktop app. The docked-terminal path launches one of the
 * supported agent CLIs (see `TERMINAL_CLIS`) inside OK's bottom
 * terminal with the same scope-specific prompt shape, so the two surfaces stay
 * in lockstep — the prompt is composed once by the dispatch hook
 * (`selectScopedPrompt`), budgeted per transport (URL-encoded budget for the
 * deep link, quoted-argv-byte budget for the PTY — see `PromptTransport` in
 * `prompt-composer.ts`), and threaded into either transport.
 *
 * This module owns the shell-injection-safe wrapping. The terminal write is a
 * FIXED `<bin> [<fixed-args>…] '<prompt>'` shape — never an arbitrary command.
 * Both `<bin>` and any `<fixed-args>` come only from the {@link TERMINAL_CLIS}
 * registry, never from user input. The prompt — the only user-influenced
 * portion — is single-quote-wrapped so it can never break out of its argument
 * or inject shell, regardless of what bytes the composed prompt carries.
 */

import { MCP_SERVER_NAME } from '../constants/mcp.ts';
import type { HandoffTarget } from './types.ts';

/**
 * POSIX single-quote a string so it is safe as one shell argument. Single
 * quotes preserve every byte literally EXCEPT the single quote itself, which
 * cannot appear inside a single-quoted string at all. The standard idiom
 * closes the quote, emits an escaped literal quote (`\'`), and reopens:
 * `'…'\''…'`. Everything else — `$`, backticks, `;`, `&`, `|`, newlines,
 * globs, `\` — is inert inside single quotes, so no other escaping is needed.
 *
 * Examples:
 *   shellSingleQuote("plain")        → 'plain'
 *   shellSingleQuote("a'b")          → 'a'\''b'
 *   shellSingleQuote("$(rm -rf /)")  → '$(rm -rf /)'   (inert — not expanded)
 *   shellSingleQuote("`whoami`")     → '`whoami`'      (inert — not expanded)
 */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The agent CLIs the docked terminal can launch. Each starts an INTERACTIVE
 * session that stays open with the composed prompt threaded in — NOT the
 * non-interactive one-shot variants (`codex exec`, `cursor-agent -p`,
 * `hermes -q`/`-z`) which run-and-exit before the user can continue.
 *
 * The prompt reaches the CLI three ways, per {@link TerminalCliInfo}:
 *   - positional (`claude '<prompt>'`) — the default (no `promptFlag`);
 *   - a flag (`opencode --prompt '<prompt>'`, `openclaw chat --message '<prompt>'`)
 *     for CLIs whose positional isn't the prompt (`promptFlag`);
 *   - post-launch PTY paste (`hermes`) for CLIs with NO starting-prompt argument
 *     at all — the promptless `<bin>` is spawned and the prompt is bracketed-paste
 *     injected once its TUI is ready (`startupInjection`).
 */
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
  /** PATH binary launched in the PTY. Interpolated (alongside any opted-in
   *  {@link TerminalCliInfo.autoApproveArg}) into the fixed
   *  `<bin> [<fixed-args>…] '<prompt>'` shape — fixed registry values, never
   *  user input. */
  readonly bin: string;
  /** Fixed launch arg that auto-approves OK's OWN tools for this CLI, inserted
   *  ONLY when the caller passes `autoApproveOkTools: true`. Codex-only today (a
   *  `-c` per-server approval-mode override); already shell-safe, registry-fixed,
   *  never user input. Claude's equivalent (an allow/deny list) is computed inline
   *  by {@link buildClaudeSettingsArg}, not from the registry. */
  readonly autoApproveArg?: string;
  /** User-facing brand name ("Claude" / "Codex" / "Cursor"). */
  readonly displayName: string;
  /** Install / setup docs, opened from the "not installed" terminal banner. */
  readonly docsUrl: string;
  /** The handoff target this CLI maps to for prompt composition (shared with
   *  the deep-link path) and brand-icon rendering. Single source of truth so
   *  the renderer doesn't re-declare a parallel `cli → HandoffTarget` map. */
  readonly handoffTarget: HandoffTarget;
  /** Fixed subcommand token inserted immediately after `<bin>`, present in BOTH
   *  the prompted and promptless shapes (unlike {@link TerminalCliInfo.promptFlag},
   *  which is dropped when there is no prompt). For CLIs whose interactive session
   *  lives under a verb rather than the bare binary — `openclaw chat` /
   *  `hermes chat` (bare `openclaw`/`hermes` is the gateway/other entry point, not
   *  the interactive TUI). Registry-fixed, never user input. */
  readonly subcommand?: string;
  /** Flag that carries the starting prompt for CLIs whose POSITIONAL argument is
   *  NOT the prompt. OpenCode's positional is the project directory (`--prompt`),
   *  OpenClaw's initial message rides on `--message`; claude/codex/cursor take the
   *  prompt positionally (omit this). When set, {@link buildCliLaunchArgString}
   *  inserts it immediately before the quoted prompt. Mutually exclusive with
   *  {@link TerminalCliInfo.startupInjection} (a CLI either takes an argv prompt or
   *  is injected, never both). */
  readonly promptFlag?: string;
  /** Marks a CLI that accepts NO starting-prompt argument at all: its interactive
   *  TUI must be launched promptless and the composed prompt delivered afterward as
   *  a bracketed-paste PTY write (see {@link buildStartupInjectionBytes}). When set,
   *  {@link buildCliLaunchArgString} omits the prompt from the argv.
   *
   *  Fields:
   *  - `submit`: byte(s) written after the paste to send it (`'\r'`).
   *  - `readyMarker`: exact byte sequence in the PTY output that signals the input
   *    widget is live and ready to receive a paste. Hermes emits `\x1b[?2004h`
   *    (bracketed-paste enable) when its prompt mounts — verified on a real Hermes
   *    at ~940ms warm-boot. Keying on the DEC-2004 escape (not UI prose) is
   *    language- and version-stable, and it is the exact precondition for the paste
   *    to be honored (no `?2004h` → bracketed paste wouldn't apply anyway). Omit to
   *    fall back to a pure timer.
   *  - `settleMs`: debounce AFTER the marker before injecting (or, when no
   *    `readyMarker`, a fixed beat from spawn).
   *  - `capMs`: hard cap — inject anyway this long after spawn if the marker never
   *    appears (a future TUI that changed its ready signal), so a launch never
   *    silently drops the prompt. */
  readonly startupInjection?: {
    readonly submit: string;
    readonly readyMarker?: string;
    readonly settleMs: number;
    readonly capMs: number;
  };
}

/**
 * Claude allow-rules that let OK's OWN MCP tools + the `ok open` CLI verb run
 * without a per-call approval prompt: `mcp__<server>` matches every tool of OK's
 * MCP server; `Bash(ok open:*)` matches only the `ok open` verb. Registry-fixed,
 * never user input.
 */
const OK_AUTO_APPROVE_ALLOW_RULES: readonly string[] = [
  `mcp__${MCP_SERVER_NAME}`,
  'Bash(ok open:*)',
];

/**
 * OK MCP tools kept GATED even when auto-approve is on: `deny` out-ranks `allow`
 * in Claude's precedence (deny then ask then allow), so these keep prompting.
 * The goal is a frictionless read/write loop, never a silent `delete` / `move`
 * (KB-wide blast radius), `share_link` (data exfiltration), or `install` (writes
 * executable skill scripts into the agent's own config dir — a persistence
 * vector, unlike a version-recoverable doc write).
 *
 * The allow-rule is open-ended (`mcp__<server>` matches EVERY OK tool) while this
 * deny-list is closed, so a new destructive tool would silently inherit
 * auto-approval. `registry.test.ts` in the server package pins every registered
 * tool name against this list plus its auto-approved complement — adding a tool
 * fails that test until it is consciously classified. Keep the two in lockstep.
 */
export const OK_GATED_TOOL_NAMES: readonly string[] = ['delete', 'move', 'share_link', 'install'];

const OK_AUTO_APPROVE_DENY_RULES: readonly string[] = OK_GATED_TOOL_NAMES.map(
  (tool) => `mcp__${MCP_SERVER_NAME}__${tool}`,
);

/**
 * Codex per-launch config override (via `-c`, so it writes nothing to the user's
 * `~/.codex/config.toml`) that sets OK's MCP server tool-approval to `approve`
 * ("auto-approve except potentially-unsafe actions", per codex's own permission
 * vocabulary). Registry-fixed. LOAD-BEARING PRECONDITION: only add this when OK's
 * server entry ALREADY exists in the user's codex config — a `-c` key under a
 * non-existent server id creates a partial (command-less) entry that makes codex
 * fail to load its config and breaks the launch. The launch site owns that gate.
 */
const CODEX_OK_AUTO_APPROVE_ARG = `-c ${shellSingleQuote(
  `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
)}`;

/**
 * Build Claude's inline `--settings` arg from two INDEPENDENT opt-ins that share
 * one settings object. `mcpPreApprove` adds server trust (`enabledMcpjsonServers`)
 * so the launch skips the one-time "New MCP server found" prompt — set by the
 * launch site only after `isOwnManagedEntry` verifies the project's
 * `open-knowledge` `.mcp.json` entry is OK's OWN (a committed, cloned `.mcp.json`
 * could carry a foreign same-named server; RCE otherwise). `autoApproveOkTools`
 * adds the OK-tool + `ok open` allow-list and the destructive-tool deny-list.
 * `--settings` takes an inline JSON string the CLI layers on the user's settings,
 * so nothing is written to disk. Returns '' when neither opt-in is set. Content is
 * registry-fixed and single-quoted — never user input.
 */
function buildClaudeSettingsArg(opts: BuildCliLaunchOptions): string {
  const settings: {
    enabledMcpjsonServers?: string[];
    permissions?: { allow: string[]; deny: string[] };
  } = {};
  if (opts.mcpPreApprove === true) {
    settings.enabledMcpjsonServers = [MCP_SERVER_NAME];
  }
  if (opts.autoApproveOkTools === true) {
    settings.permissions = {
      allow: [...OK_AUTO_APPROVE_ALLOW_RULES],
      deny: [...OK_AUTO_APPROVE_DENY_RULES],
    };
  }
  if (settings.enabledMcpjsonServers === undefined && settings.permissions === undefined) {
    return '';
  }
  return `--settings ${shellSingleQuote(JSON.stringify(settings))}`;
}

/**
 * xterm bracketed-paste framing (DEC private mode 2004). A TUI in bracketed-paste
 * mode treats bytes between these sentinels as literal pasted text — it does NOT
 * run them through its key handler, so newlines don't submit early, a leading `/`
 * doesn't open a slash-command menu, and `@`/`#` don't trigger mention pickers.
 * That is exactly what a multi-line composed prompt needs; the submit byte
 * ({@link TerminalCliInfo.startupInjection}.submit) is sent AFTER the closing
 * sentinel to send the now-complete input.
 */
const ESC = '\x1b';
const BRACKETED_PASTE_START = `${ESC}[200~`;
const BRACKETED_PASTE_END = `${ESC}[201~`;

/**
 * Hermes injection timing. Rather than a blind fixed beat, the launcher waits for
 * Hermes' input widget to signal ready by emitting `\x1b[?2004h` (bracketed-paste
 * enable), then debounces {@link HERMES_INJECT_DEBOUNCE_MS} before pasting. On a
 * real Hermes this marker lands ~940ms after `hermes chat` (warm) and the widget
 * accepts a bracketed paste cleanly right after. {@link HERMES_INJECT_CAP_MS} is
 * the hard fallback: inject anyway if the marker never appears (e.g. a future
 * Hermes that changed its ready signal), so the prompt is never silently dropped.
 */
const HERMES_READY_MARKER = '\x1b[?2004h';
const HERMES_INJECT_DEBOUNCE_MS = 300;
const HERMES_INJECT_CAP_MS = 4000;

/**
 * Static registry for each launchable CLI. Cursor's agent CLI binary is
 * `cursor-agent` (the `cursor` command opens the GUI editor, not the agent).
 */
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
    // Copilot's `--prompt` mode exits after one response. `--interactive`
    // executes the starting prompt but keeps the session open for follow-up.
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
    // OpenCode's positional arg is the PROJECT DIRECTORY, not a prompt, so the
    // starting prompt is passed via `--prompt`: `opencode --prompt '<prompt>'`
    // opens the interactive TUI (in the terminal's cwd = the project) with the
    // prompt pre-filled. (`opencode run` is the non-interactive one-shot; the
    // default TUI command keeps the session open, matching the other CLIs.)
    bin: 'opencode',
    displayName: 'OpenCode',
    docsUrl: 'https://opencode.ai/docs',
    handoffTarget: 'opencode',
    promptFlag: '--prompt',
  },
  pi: {
    // Pi's positional argument IS the starting prompt (`pi '<prompt>'` opens
    // the interactive session with it), the same shape as claude/codex/cursor
    // — no promptFlag. (`pi -p` is the non-interactive one-shot; the default
    // interactive command keeps the session open, matching the other CLIs.)
    bin: 'pi',
    displayName: 'Pi',
    docsUrl: 'https://pi.dev',
    handoffTarget: 'pi',
  },
  antigravity: {
    // Antigravity's CLI binary is `agy`. Unlike claude/codex/cursor/pi it has NO
    // positional prompt argument, so the starting prompt rides on
    // `--prompt-interactive` (`-i`): `agy --prompt-interactive '<prompt>'` runs
    // the initial prompt AND keeps the interactive session open. A bare positional
    // (`agy '<prompt>'`) is silently dropped — the empty-session bug. (`agy -p` /
    // `--print` is the non-interactive one-shot that prints and exits.)
    bin: 'agy',
    displayName: 'Antigravity',
    docsUrl: 'https://antigravity.google/docs/cli-getting-started',
    handoffTarget: 'antigravity',
    promptFlag: '--prompt-interactive',
  },
  openclaw: {
    // OpenClaw's interactive TUI is `openclaw chat` (an alias for `tui --local`,
    // the local embedded agent runtime — no separate gateway process needed). Its
    // starting prompt is NOT positional: it rides on `--message <text>` ("Send an
    // initial message after connecting"), so the launch is
    // `openclaw chat --message '<prompt>'`. Bare `openclaw` is the gateway CLI, not
    // a chat — hence the fixed `chat` subcommand on both the prompted and
    // promptless (New chat) shapes.
    bin: 'openclaw',
    subcommand: 'chat',
    displayName: 'OpenClaw',
    docsUrl: 'https://docs.openclaw.ai/cli/tui',
    handoffTarget: 'openclaw',
    promptFlag: '--message',
  },
  hermes: {
    // Hermes (Nous Research) has NO interactive-with-starting-prompt argument: its
    // only prompt-carrying modes (`hermes chat -q`, `hermes -z`) are one-shots that
    // run-and-exit, and bare `hermes chat` opens the TUI with no way to seed it. So
    // OK launches `hermes chat` promptless and delivers the composed prompt as a
    // bracketed-paste PTY write once the TUI is ready (`startupInjection`). Bare
    // `hermes` can drop into provider setup on first run — `chat` is the stable
    // interactive entry point.
    bin: 'hermes',
    subcommand: 'chat',
    displayName: 'Hermes',
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/cli',
    handoffTarget: 'hermes',
    startupInjection: {
      submit: '\r',
      readyMarker: HERMES_READY_MARKER,
      settleMs: HERMES_INJECT_DEBOUNCE_MS,
      capMs: HERMES_INJECT_CAP_MS,
    },
  },
} as const satisfies Record<TerminalCli, TerminalCliInfo>;

/**
 * Stable launch order — drives the menu rows and any iteration over CLIs. Order
 * is also the default-CLI auto-pick priority (first installed wins), so the
 * visible row order and the resolved default can never disagree. Copilot is
 * placed after the established primary CLI defaults to avoid changing an
 * existing multi-CLI user's first-run selection.
 */
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
  /**
   * Include Claude's MCP server-trust pre-approval (`enabledMcpjsonServers`).
   * Honored only for `claude`. Defaults to false — the SAFE default. The launch
   * site sets it true only after confirming the project's `open-knowledge`
   * `.mcp.json` entry is OK's own (desktop preflight `mcpPreApprovable` ←
   * `isOwnManagedEntry`); a bare launch lets Claude show its trust prompt.
   */
  readonly mcpPreApprove?: boolean;
  /**
   * Auto-approve OK's OWN tools so the KB read/write loop runs without a per-call
   * prompt. Claude: an allow-list (OK tools + `ok open`) with a destructive-tool
   * deny-list, via {@link buildClaudeSettingsArg}. Codex: the registry
   * {@link TerminalCliInfo.autoApproveArg} `-c` override — the launch site MUST
   * only pass true for codex once it has confirmed OK's server entry exists in the
   * codex config (see that field's precondition). Other CLIs: no effect. Defaults
   * to false.
   */
  readonly autoApproveOkTools?: boolean;
}

/**
 * Build the fixed `<bin> [<fixed-args>…] '<prompt>'` launch shape WITHOUT a
 * trailing newline — the CLI's registry binary, then the opted-in fixed args
 * (Claude's inline `--settings` from {@link buildClaudeSettingsArg}; every other
 * CLI's registry {@link TerminalCliInfo.autoApproveArg}), then the prompt
 * POSIX-single-quoted via {@link shellSingleQuote}. This is the canonical command
 * string; the two transports add what each needs:
 *   - typed into an interactive shell → {@link buildCliLaunchCommand} appends `\r`;
 *   - baked into the launch PTY's `$SHELL -l -i -c '<this>; exec …'` argv → used
 *     as-is (no `\r`: it's an argv element, not bytes fed to the line editor, so
 *     it never lands in shell history — the whole point of the baked path).
 *
 * When `prompt` is absent (null/undefined/empty), the launch is promptless — the
 * "New chat" path: the positional AND any prompt-carrying flag (OpenCode's
 * `--prompt`) are dropped so the CLI opens its default interactive session
 * (`<bin>`), keeping only Claude's opted-in MCP pre-approval.
 *
 * The caller is responsible for only invoking this once `<bin>` is known to be
 * on PATH (a not-found binary would print a "command not found" error rather
 * than launch); see the terminal session's per-CLI preflight gate.
 */
export function buildCliLaunchArgString(
  cli: TerminalCli,
  prompt: string | null | undefined,
  opts: BuildCliLaunchOptions = {},
): string {
  const info: TerminalCliInfo = TERMINAL_CLIS[cli];
  // Registry-fixed fixed args between `<bin>` and the prompt (never user input):
  // Claude's inline `--settings` (server trust + OK auto-approve allow/deny),
  // computed inline because two independent opt-ins share one settings object;
  // every other CLI uses its registry `autoApproveArg` when `autoApproveOkTools`
  // is on (codex's `-c` override today).
  const fixedArgs =
    cli === 'claude'
      ? buildClaudeSettingsArg(opts)
      : opts.autoApproveOkTools === true && info.autoApproveArg
        ? info.autoApproveArg
        : '';
  const fixedPrefix = fixedArgs ? `${fixedArgs} ` : '';
  // Fixed subcommand (e.g. `openclaw chat` / `hermes chat`), present in both the
  // prompted and promptless shapes.
  const sub = info.subcommand ? `${info.subcommand} ` : '';
  // Promptless — a bare `<bin> [subcommand] [fixed args]` (the "New chat" path) —
  // OR a `startupInjection` CLI, whose prompt is delivered by a post-launch PTY
  // paste (see buildStartupInjectionBytes), never the argv. `fixedPrefix`/`sub`
  // carry their own trailing separator space, redundant with nothing after them.
  if (info.startupInjection != null || prompt == null || prompt.length === 0) {
    return `${info.bin} ${sub}${fixedPrefix}`.trimEnd();
  }
  // CLIs whose positional arg isn't the prompt (e.g. OpenCode, whose positional
  // is the project dir; OpenClaw, whose initial message is `--message`) carry it
  // via a flag instead.
  const promptFlag = info.promptFlag ? `${info.promptFlag} ` : '';
  return `${info.bin} ${sub}${fixedPrefix}${promptFlag}${shellSingleQuote(prompt)}`;
}

/**
 * The {@link buildCliLaunchArgString} shape plus a trailing carriage return that
 * submits the line at a shell prompt — the form for the legacy "type into the
 * running interactive shell" transport. NOTE: bytes written this way pass through
 * the shell's line editor and so are recorded in the user's persistent history
 * (clutter + doc-content-on-disk); prefer the baked-at-spawn `-c` path (which
 * uses {@link buildCliLaunchArgString} directly) for launches.
 */
export function buildCliLaunchCommand(
  cli: TerminalCli,
  prompt: string,
  opts: BuildCliLaunchOptions = {},
): string {
  return `${buildCliLaunchArgString(cli, prompt, opts)}\r`;
}

/**
 * Claude-CLI convenience over {@link buildCliLaunchCommand} — the addressable,
 * exported, unit-tested entry point for the Claude-specific launch shape (the
 * docked terminal itself launches via `buildCliLaunchCommand(launch.cli, …)`).
 * Forwards `opts`, so MCP pre-approval is off unless the caller opts in.
 */
export function buildClaudeLaunchCommand(prompt: string, opts: BuildCliLaunchOptions = {}): string {
  return buildCliLaunchCommand('claude', prompt, opts);
}

/**
 * Bytes to write into a freshly-launched {@link TerminalCliInfo.startupInjection}
 * CLI's PTY to deliver the starting prompt it cannot take on its argv (Hermes).
 * The prompt is wrapped in bracketed-paste sentinels — so the TUI treats it as
 * literal pasted text, keeping a multi-line prompt intact and inert to key
 * handling — then the registry submit byte is appended to send it.
 *
 * Returns `null` when the CLI has no `startupInjection` (its prompt rode on the
 * argv, nothing to inject) or the prompt is empty (a promptless New-chat launch).
 *
 * Any ESC byte (0x1b) in the prompt is stripped first: a text prompt never
 * legitimately contains one, and leaving it in would let the content terminate
 * the bracketed-paste frame early (a literal `ESC[201~`) or smuggle its own
 * control sequence into the TUI — the paste-time analogue of shell injection.
 * This is the only user-influenced portion; everything around it is registry-fixed.
 */
/**
 * The startup-injection descriptor for a CLI, or `undefined` when it delivers its
 * prompt on the argv. A typed accessor so consumers don't cast around the
 * `as const satisfies` registry's per-entry literal types (which drop optional
 * fields from members that don't set them).
 */
export function startupInjectionFor(cli: TerminalCli): TerminalCliInfo['startupInjection'] {
  const info: TerminalCliInfo = TERMINAL_CLIS[cli];
  return info.startupInjection;
}

export function buildStartupInjectionBytes(
  cli: TerminalCli,
  prompt: string | null | undefined,
): string | null {
  const injection = startupInjectionFor(cli);
  if (injection == null || prompt == null || prompt.length === 0) return null;
  // Strip ESC (0x1b) — the byte that would let the prompt terminate the paste
  // frame early or smuggle in a control sequence. A plain-string `replaceAll`
  // (not a regex) keeps the control char out of a RegExp literal.
  const safe = prompt.replaceAll(ESC, '');
  return `${BRACKETED_PASTE_START}${safe}${BRACKETED_PASTE_END}${injection.submit}`;
}
