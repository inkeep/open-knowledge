/**
 * Server-side constants. The MCP server name is the wire-level identity the
 * `ok start` HTTP MCP endpoint advertises and the canonical key editor configs
 * use to identify the OpenKnowledge entry. CLI editor wiring imports this
 * via `@inkeep/open-knowledge-server`; the value is defined once in
 * `@inkeep/open-knowledge-core` and re-exported here so the server, the CLI
 * editor wiring, and the browser-safe in-app-terminal launch all stay in
 * lockstep.
 */
export { MCP_SERVER_NAME } from '@inkeep/open-knowledge-core';
