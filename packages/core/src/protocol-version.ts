/**
 * Cross-process contract version — the integer both the server and every
 * client stamp onto the wire so a future server can refuse an incompatible
 * peer.
 *
 * Lives in `@inkeep/open-knowledge-core` (not the server package) so the
 * browser bundle can import it: it is a pure integer literal with no `node:fs`
 * dependency, unlike the server's `RUNTIME_VERSION`, which is read from disk at
 * module load. The server re-exports this constant from `version-constants.ts`
 * so server-side call sites keep their single import surface.
 *
 * Bumped whenever a cross-process contract changes shape in a way an existing
 * installed binary cannot interpret safely (lock-field rename/removal, WS frame
 * shape change, MCP handshake addition, or an HTTP API field a peer depends
 * on). Additive-only changes (new optional fields, new endpoints, new WS frame
 * types old readers can ignore) do NOT bump.
 */
export const PROTOCOL_VERSION = 1 as const;
