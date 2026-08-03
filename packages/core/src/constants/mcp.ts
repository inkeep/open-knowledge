/**
 * Default number of history entries an `exec` `cat` read returns
 * alongside the current body.
 */
export const READ_DOCUMENT_HISTORY_DEPTH = 5;

/**
 * Default cap on results returned by the `grep` MCP tool (formerly the
 * literal-string `search` tool, renamed to `grep`).
 */
export const GREP_MAX_RESULTS = 50;

/**
 * Wire-level identity the OpenKnowledge MCP server advertises and the key
 * editor configs use to register the entry (e.g. Claude Code's `.mcp.json`
 * `mcpServers["open-knowledge"]`). Single source of truth — browser-safe so
 * `core` consumers (the in-app-terminal launch in
 * `handoff/terminal-launch.ts`) and `@inkeep/open-knowledge-server` (which
 * re-exports it) stay in lockstep with the value editor wiring writes.
 */
export const MCP_SERVER_NAME = 'open-knowledge';

/**
 * Env marker stamped on every agent OpenKnowledge launches itself — today the
 * in-app agent panel. An `ok mcp` process spawned by such an agent inherits
 * it, which is how `preview_url` distinguishes "this agent is hosted by an
 * OpenKnowledge surface, so the user is already looking at the app" from
 * "this agent is elsewhere and genuinely needs a URL".
 *
 * Sibling of `OK_DESKTOP_TERMINAL` (set by the desktop pty host for the
 * built-in terminal). The two are disjoint by construction: pty-host strips
 * the Electron host markers and sets its own, so a shell agent carries
 * exactly one of them and a panel agent the other. Both mean the same thing
 * to `preview_url` — steer to `ok open`, do not hand back a URL.
 *
 * Deliberately NOT keyed on "is the desktop app running": an external editor
 * with its own browser pane still wants a navigable URL even while Desktop is
 * open. Only agents OK spawns carry this.
 */
export const OK_HOSTED_AGENT_ENV = 'OK_HOSTED_AGENT';

/**
 * The pty host's marker for the desktop app's built-in terminal. Named here
 * so both the set site and the read site reference one symbol and a typo is a
 * compile error rather than a silently unmarked agent.
 */
export const OK_DESKTOP_TERMINAL_ENV = 'OK_DESKTOP_TERMINAL';

/**
 * Whether the agent driving a process with this environment is hosted by an
 * OpenKnowledge surface — the desktop terminal or the in-app agent panel.
 *
 * The two markers are set by different code on different paths but mean the
 * same thing to every consumer, so the OR lives here rather than being
 * re-spelled at each read site.
 */
export function resolveIsHostedAgent(env: Record<string, string | undefined>): boolean {
  return env[OK_DESKTOP_TERMINAL_ENV] === '1' || env[OK_HOSTED_AGENT_ENV] === '1';
}
