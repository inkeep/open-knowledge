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
 * Every tool the OpenKnowledge MCP server registers, and the single source of
 * truth for that set. The server's registry test asserts the live
 * registrations match this list exactly, so a tool added there without being
 * named here fails; the app's tool-call row copy reads the same list, so a
 * tool named here without display copy fails its own test. Lives in `core`
 * because it is the one place both sides already depend on.
 */
export const OPEN_KNOWLEDGE_MCP_TOOLS = [
  // Reads
  'exec',
  'search',
  'history',
  'links',
  'skills',
  'config',
  'palette',
  'preview_url',
  'share_link',
  'lint',
  'audit',
  // Writes — CRUD verbs + version
  'write',
  'edit',
  'delete',
  'move',
  // Skill install-projection — the one new verb beyond the CRUD set.
  'install',
  // Skill import/acquire — the on-ramp paired with install.
  'import',
  'checkpoint',
  'restore_version',
  // GitHub-sync conflicts
  'conflicts',
  'resolve_conflict',
] as const;

/** One registered OpenKnowledge MCP tool name. */
export type OpenKnowledgeMcpTool = (typeof OPEN_KNOWLEDGE_MCP_TOOLS)[number];

/**
 * Subset of {@link OPEN_KNOWLEDGE_MCP_TOOLS} whose calls MUTATE a document.
 * Consumers that need to distinguish reads from writes without probing the
 * argument shape read this set directly — e.g. follow-the-file uses it to
 * refuse navigation on a read that happens to carry a `docName` field.
 * Must stay a subset of the flat list above; the `satisfies` clause below
 * enforces this at compile time.
 */
export const OPEN_KNOWLEDGE_MCP_WRITE_TOOLS = [
  'write',
  'edit',
  'delete',
  'move',
  'install',
  'import',
  'checkpoint',
  'restore_version',
  'resolve_conflict',
] as const satisfies ReadonlyArray<OpenKnowledgeMcpTool>;

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
