import type { CapabilityRecord } from './schema.ts';

/**
 * STOP: `mcp-preapproval` authorizes running a server the user has not
 * approved. Its inputs are RCE-class — the exact-match predicate on the
 * project entry, and nothing else. Widening its scope or accepting a weaker
 * predicate for it is not a tuning decision.
 *
 * It is deliberately pinned to the project scope: the flag it feeds names
 * servers declared in the workspace file and means nothing without an entry
 * there, so a global answer must never grant it. It needs no foreign-entry
 * revocation either — it reads one scope, and a foreign entry in that scope
 * fails the exact predicate outright.
 */
const MCP_PREAPPROVAL: CapabilityRecord = {
  id: 'mcp-preapproval',
  piece: 'mcp',
  scope: 'project',
  requiredStrictness: 'pre-approval-exact',
  revokedByForeignEntry: false,
};

const TOOL_AUTOAPPROVE: CapabilityRecord = {
  id: 'tool-autoapprove',
  piece: 'mcp',
  requiredStrictness: 'pre-approval-exact',
  revokedByForeignEntry: true,
};

export const CAPABILITY_RECORDS: readonly CapabilityRecord[] = [MCP_PREAPPROVAL, TOOL_AUTOAPPROVE];

export const CAPABILITY_IDS: readonly string[] = CAPABILITY_RECORDS.map((record) => record.id);

export function getCapabilityRecord(id: string): CapabilityRecord | undefined {
  return CAPABILITY_RECORDS.find((record) => record.id === id);
}
