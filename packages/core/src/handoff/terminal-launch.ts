/**
 * In-app-terminal twin of the Claude Desktop deep-link handoff.
 *
 * The deep-link path puts the scope-specific prompt in the `q=` URL param and
 * opens the target's desktop app. The docked-terminal path takes the SAME
 * prompt string and launches one of the supported agent CLIs (`claude`,
 * `codex`, `cursor-agent`) with it inside OK's bottom terminal, so the two
 * surfaces stay in lockstep — the prompt is composed once by the dispatch hook
 * (`selectScopedPrompt`) and threaded into either transport.
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
 * The agent CLIs the docked terminal can launch. Each starts an interactive
 * session with the prompt as a single positional argument — the exact
 * `<bin> '<prompt>'` parity of `claude '<prompt>'` (NOT the non-interactive
 * one-shot variants: `codex exec` and `cursor-agent -p` both run-and-exit, so
 * the session wouldn't stay open for the user to continue in).
 */
export type TerminalCli = 'claude' | 'codex' | 'cursor' | 'opencode';

export interface TerminalCliInfo {
  /** PATH binary launched in the PTY. Interpolated (alongside any opted-in
   *  {@link mcpPreApproveArg}) into the fixed `<bin> [<fixed-args>…] '<prompt>'`
   *  shape — fixed registry values, never user input. */
  readonly bin: string;
  /** Claude's MCP pre-approval fragment, inserted verbatim between `<bin>` and
   *  the prompt ONLY when the caller passes `mcpPreApprove: true` (see
   *  {@link buildCliLaunchArgString}) — i.e. after the launch site has verified the
   *  project's `open-knowledge` `.mcp.json` entry is OK's own. An already-shell-
   *  safe fragment (NOT re-quoted); registry-fixed, never user input. Claude-only;
   *  omit for CLIs with no pre-approval. */
  readonly mcpPreApproveArg?: string;
  /** User-facing brand name ("Claude" / "Codex" / "Cursor"). */
  readonly displayName: string;
  /** Install / setup docs, opened from the "not installed" terminal banner. */
  readonly docsUrl: string;
  /** The handoff target this CLI maps to for prompt composition (shared with
   *  the deep-link path) and brand-icon rendering. Single source of truth so
   *  the renderer doesn't re-declare a parallel `cli → HandoffTarget` map. */
  readonly handoffTarget: HandoffTarget;
  /** Flag that carries the starting prompt for CLIs whose POSITIONAL argument is
   *  NOT the prompt. OpenCode's positional is the project directory, so its
   *  prompt must be passed as `--prompt '<text>'`; claude/codex/cursor take the
   *  prompt positionally (omit this). When set, {@link buildCliLaunchArgString}
   *  inserts it immediately before the quoted prompt. */
  readonly promptFlag?: string;
}

/**
 * Claude Code launch arg that pre-approves OK's project-scoped `.mcp.json`
 * server (`mcpServers["open-knowledge"]`) so the docked-terminal launch skips
 * the one-time "New MCP server found in this project" trust prompt. Applied
 * ONLY when the caller opts in via `mcpPreApprove: true`, which the launch site
 * sets only after verifying the project's `open-knowledge` entry is OK's OWN
 * managed server (`isOwnManagedEntry`) — never blindly by name. That gate is
 * load-bearing: `.mcp.json` is committed and travels with shared/cloned
 * projects, so a foreign or tampered same-named entry must keep Claude's trust
 * prompt rather than be silently approved (RCE / tool-poisoning otherwise).
 * `--settings` takes a JSON string the CLI layers on top of the user's
 * settings, so passing it per-invocation writes nothing to the user's machine.
 * Built from {@link MCP_SERVER_NAME} so the pre-approval names exactly what OK's
 * editor wiring registers in `.mcp.json`.
 *
 * This pins an external Claude Code contract (`--settings` accepting inline JSON
 * + the `enabledMcpjsonServers` key). If a future `claude` drops the key the
 * trust prompt simply returns — safe degradation. The bare-launch path
 * (`mcpPreApprove` false/omitted) is the default and stays reachable, so if the
 * flag ever broke launches it could be disabled without restructuring.
 */
const CLAUDE_MCP_PREAPPROVE_ARG = `--settings ${shellSingleQuote(
  JSON.stringify({ enabledMcpjsonServers: [MCP_SERVER_NAME] }),
)}`;

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
    mcpPreApproveArg: CLAUDE_MCP_PREAPPROVE_ARG,
  },
  codex: {
    bin: 'codex',
    displayName: 'Codex',
    docsUrl: 'https://developers.openai.com/codex/cli',
    handoffTarget: 'codex',
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
} as const satisfies Record<TerminalCli, TerminalCliInfo>;

/**
 * Stable launch order — drives the menu rows and any iteration over CLIs. Order
 * is also the default-CLI auto-pick priority (first installed wins), so the
 * visible row order and the resolved default can never disagree.
 */
export const TERMINAL_CLI_IDS = [
  'claude',
  'codex',
  'opencode',
  'cursor',
] as const satisfies readonly TerminalCli[];

export interface BuildCliLaunchOptions {
  /**
   * Include Claude's MCP pre-approval flag ({@link TerminalCliInfo.mcpPreApproveArg}).
   * Honored only for `claude`. Defaults to false — the SAFE default. The launch
   * site sets it true only after confirming the project's `open-knowledge`
   * `.mcp.json` entry is OK's own (desktop preflight `mcpPreApprovable` ←
   * `isOwnManagedEntry`); a bare launch lets Claude show its trust prompt.
   */
  readonly mcpPreApprove?: boolean;
}

/**
 * Build the fixed `<bin> [<mcp-pre-approve>] '<prompt>'` launch shape WITHOUT a
 * trailing newline — the CLI's registry binary, then Claude's registry-fixed
 * {@link TerminalCliInfo.mcpPreApproveArg} inserted verbatim ONLY when
 * `opts.mcpPreApprove` is true, then the prompt POSIX-single-quoted via
 * {@link shellSingleQuote}. This is the canonical command string; the two
 * transports add what each needs:
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
  const preApprove =
    opts.mcpPreApprove === true && info.mcpPreApproveArg ? `${info.mcpPreApproveArg} ` : '';
  // Promptless: emit a bare `<bin>` (plus any opted-in pre-approval). `preApprove`
  // carries its own trailing separator space, redundant with nothing after it.
  if (prompt == null || prompt.length === 0) {
    return `${info.bin} ${preApprove}`.trimEnd();
  }
  // CLIs whose positional arg isn't the prompt (e.g. OpenCode, whose positional
  // is the project dir) carry it via a flag instead.
  const promptFlag = info.promptFlag ? `${info.promptFlag} ` : '';
  return `${info.bin} ${preApprove}${promptFlag}${shellSingleQuote(prompt)}`;
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
