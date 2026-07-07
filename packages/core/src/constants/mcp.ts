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
