/**
 * Agent identity — captured from the MCP initialize handshake.
 *
 * Long-lived identity (who is this agent?) is derived from MCP `clientInfo`
 * and a server-generated `connectionId`. Per architectural precedent #8:
 * long-lived identity is separate from short-lived session concerns.
 *
 * `connectionId` is the per-session UUID and is the only stable disambiguator
 * when multiple clients report the same `clientInfo.name` (e.g. two Claude
 * Code instances connected to the same `ok start`). `clientInfo.name` is
 * mandatory in the MCP `InitializeRequestSchema`, so post-handshake every
 * session has a name.
 */

export interface AgentIdentity {
  connectionId: string;
  clientInfo?: {
    name: string;
    version: string;
  };
  /** Derived: friendly brand name from clientInfo.name once handshake completes; connectionId beforehand. */
  displayName: string;
  /** Derived: clientInfo.name once handshake completes; connectionId beforehand. */
  colorSeed: string;
}

/**
 * Request header by which the `ok mcp` shim forwards its keepalive WS
 * `connectionId` to the MCP HTTP endpoint. When present + valid, the MCP
 * HTTP session adopts this id as `AgentIdentity.connectionId` instead of
 * minting a fresh UUID.
 *
 * Without this unification the keepalive WS and the MCP HTTP session
 * generate distinct UUIDs: `setPresence` (write handlers, keyed by
 * `identity.connectionId`) lands the entry under `agent-<MCP_HTTP_UUID>`
 * while the 3 s `bumpPresenceTs` heartbeat ([mcp-mount.ts]) runs under
 * `agent-<KEEPALIVE_UUID>` and silently no-ops because the entry it tries
 * to refresh doesn't exist at that key. Result: the presence-bar icon
 * flickers — appears on each tool call's `setPresence` and disappears
 * ~5 s later when the client TTL filter elides the un-bumped entry. Same
 * mismatch breaks `clearPresence` on WS close.
 *
 * Header values are validated through the same `validateAgentId` checks
 * the keepalive WS path uses (regex + length cap + type guard) so
 * structured-log fields and broadcaster map keys never carry
 * attacker-controlled bytes.
 */
export const MCP_CONNECTION_ID_HEADER = 'x-ok-connection-id';

/**
 * Coerce an MCP client's self-reported `clientInfo.name` into a safe display
 * string: strip ASCII control characters, collapse internal whitespace,
 * truncate at 128 chars, and fall back when the result is empty.
 *
 * Used wherever a session minted under `AgentIdentity` derives `displayName`
 * / `colorSeed` from external input. The cap matches the value used in
 * agent-presence map keys and write-attribution log fields, so structured
 * logs can never carry attacker-controlled bytes past this boundary.
 */
export function sanitizeClientName(name: string | undefined, fallback: string): string {
  const clean = Array.from(name ?? '')
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.slice(0, 128) : fallback;
}
