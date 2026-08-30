/**
 * Recognition of the one legacy producer envelope OK restyles as runtime
 * status instead of agent speech.
 *
 * Codex models operational warnings as typed events internally, but its ACP
 * adapter forwards them typed only to a client that negotiated JetBrains'
 * private capability. Every other client — OK included — gets the legacy
 * fallback instead: the warning flattened into the assistant message stream as
 * an ordinary text chunk behind an English prefix the adapter fabricates.
 * Nothing structured survives that flattening, so the envelope's own shape is
 * the only evidence a client has to work with.
 *
 * That makes this a trust decision rather than a text-matching convenience,
 * and the rule is deliberately unforgiving: every gate must hold or the event
 * is ordinary prose. A false positive restyles something the agent genuinely
 * said, which is the defect this surface exists to fix, so ambiguity always
 * resolves toward prose. The decision is also all-or-nothing on the whole
 * event — a leading warning-looking paragraph is never carved out of a larger
 * body, because a blank line is content here, not a protocol boundary.
 *
 * Lives in core because the server (which must keep these events from merging
 * into their neighbours) and the app (which mints the notice) have to agree
 * byte for byte. A second copy of this rule is a drift bug waiting to happen.
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk';

/**
 * The subset of the thread's agent identity this decision reads. Its own shape
 * rather than the full `ThreadAgentInfo` so callers can consult the predicate
 * before the handshake has filled in display fields.
 */
export interface CodexLegacyAgentIdentity {
  readonly source: 'registry' | 'custom';
  readonly id: string;
}

/**
 * The only producer whose envelope is characterized. A custom entry can reuse
 * the id while spawning a completely different executable, which is why the
 * source is checked alongside it.
 */
const CODEX_REGISTRY_AGENT_ID = 'codex-acp';

/**
 * The adapter's two fabricated literals, trailing space included. Neither is a
 * prefix of the other and neither contains a newline, so a match is never
 * ambiguous and can never overlap the terminator.
 */
const LEGACY_WARNING_PREFIXES = ['Warning: ', 'Config warning: '] as const;

/**
 * The adapter appends these bytes after interpolating the message, so requiring
 * them rejects a truncated or streamed-partial envelope, and any trimmed prose
 * that happens to open with one of the literals above. The gate is `endsWith`,
 * not an equality on the final two bytes, so a message whose own details close
 * with blank lines still matches on its longer trailing newline run. It does
 * NOT separate a warning from the adapter's other no-ID chrome: context
 * compaction and turn-error text terminate the same way. Only the prefix does
 * that, which is why relaxing the prefix gate would leave nothing behind it.
 */
const LEGACY_WARNING_TERMINATOR = '\n\n';

/**
 * Whether `update` is a complete legacy Codex warning envelope for a thread
 * running `agent`.
 *
 * Total by construction: `update` arrives as JSON parsed off a socket or off
 * the persisted event log, so its static type is a claim about untrusted bytes
 * rather than a guarantee, and every field is re-checked here.
 *
 * The verdict is settled by a bounded window at each end of the message text.
 * Whatever sits between those windows cannot move it, which is what keeps the
 * interior from being reinterpreted: no amount of body, and no structure
 * inside it, turns prose into a notice or a notice into prose.
 */
export function isCodexLegacyWarningUpdate(
  update: SessionUpdate | null | undefined,
  agent: CodexLegacyAgentIdentity | null | undefined,
): boolean {
  if (agent === null || agent === undefined) return false;
  if (agent.source !== 'registry' || agent.id !== CODEX_REGISTRY_AGENT_ID) return false;

  if (typeof update !== 'object' || update === null) return false;
  const candidate = update as { sessionUpdate?: unknown; messageId?: unknown; content?: unknown };
  if (candidate.sessionUpdate !== 'agent_message_chunk') return false;

  // The adapter drops the key entirely for these events while every ordinary
  // answer carries the item id, so an absent one is what survives. The schema
  // does admit an explicit null here, but a producer that sends one chose to
  // say something rather than say nothing, and this envelope is characterized
  // by the silence. Absent is not fully distinguishable downstream either: the
  // SDK's validator defaults a malformed id to undefined, so on the socket
  // path a mangled id reads as no id. `!== undefined` is still the right test
  // rather than an own-property check, because it is what keeps the server and
  // the app from disagreeing about a value the JSON round trip dropped.
  if (candidate.messageId !== undefined) return false;

  const content = candidate.content;
  if (typeof content !== 'object' || content === null) return false;
  const block = content as { type?: unknown; text?: unknown };
  if (block.type !== 'text' || typeof block.text !== 'string') return false;

  const text = block.text;
  if (!text.endsWith(LEGACY_WARNING_TERMINATOR)) return false;
  return LEGACY_WARNING_PREFIXES.some((prefix) => text.startsWith(prefix));
}
