export interface AwarenessUser {
  name: string;
  color: string;
  /**
   * Always `'human'`. Agents no longer publish per-doc awareness — their
   * presence lives on the `__system__` Y.Doc's `agentPresence` map instead
   * (precedent #3).
   */
  type: 'human';
  icon?: string;
  coeditor?: string;
  tabId: string;
  principalId?: string;
}

export interface AwarenessState {
  user: AwarenessUser;
  mode: 'wysiwyg' | 'source' | 'idle' | 'editing';
  cursor?: {
    anchor: unknown;
    head: unknown;
  };
  agentFocus?: Record<string, AgentFocusEntry>;
  agentPresence?: Record<string, AgentPresenceEntry>;
}

export interface AgentFocusEntry {
  agentName: string;
  currentDoc: string | null;
  writeKind: 'write' | 'edit' | 'undo' | 'rollback-apply' | null;
  ts: number;
}

export interface AgentPresenceEntry {
  displayName: string;
  icon: string;
  color: string;
  currentDoc: string | null;
  mode: 'idle' | 'writing';
  ts: number;
  docTs?: number;
}

export const CONNECTED_SENTINEL_DOC = '(connected)';
export const AGENT_THREAD_SENTINEL_DOC = '(agent thread)';

const PRESENCE_SENTINEL_DOC_NAMES: ReadonlySet<string> = new Set([
  CONNECTED_SENTINEL_DOC,
  AGENT_THREAD_SENTINEL_DOC,
]);

export function isPresenceSentinelDocName(name: string | null | undefined): boolean {
  return name != null && PRESENCE_SENTINEL_DOC_NAMES.has(name);
}

export interface AgentFlashEntry {
  agentId: string;
  timestamp: number;
  type: 'insert' | 'replace' | 'delete';
  description?: string;
  changedBlocks?: { from: number; to: number };
}
