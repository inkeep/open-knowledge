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
export type TerminalCli = 'claude' | 'codex' | 'cursor' | 'opencode' | 'pi' | 'antigravity';

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
  /** Flag that carries the starting prompt for CLIs whose POSITIONAL argument is
   *  NOT the prompt. OpenCode's positional is the project directory, so its
   *  prompt must be passed as `--prompt '<text>'`; claude/codex/cursor take the
   *  prompt positionally (omit this). When set, {@link buildCliLaunchArgString}
   *  inserts it immediately before the quoted prompt. */
  readonly promptFlag?: string;
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
    // Antigravity's CLI binary is `agy`; its positional argument IS the
    // starting prompt (`agy '<prompt>'` opens the interactive session with it),
    // the same shape as claude/codex/cursor/pi — no promptFlag. (`agy -p` is
    // the non-interactive one-shot; the default interactive command keeps the
    // session open, matching the other CLIs.)
    bin: 'agy',
    displayName: 'Antigravity',
    docsUrl: 'https://antigravity.google/docs/cli-getting-started',
    handoffTarget: 'antigravity',
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
  'pi',
  'antigravity',
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
  // Promptless: emit a bare `<bin>` (plus any opted-in fixed args). `fixedPrefix`
  // carries its own trailing separator space, redundant with nothing after it.
  if (prompt == null || prompt.length === 0) {
    return `${info.bin} ${fixedPrefix}`.trimEnd();
  }
  // CLIs whose positional arg isn't the prompt (e.g. OpenCode, whose positional
  // is the project dir) carry it via a flag instead.
  const promptFlag = info.promptFlag ? `${info.promptFlag} ` : '';
  return `${info.bin} ${fixedPrefix}${promptFlag}${shellSingleQuote(prompt)}`;
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
