import { isPresenceSentinelDocName } from '@inkeep/open-knowledge-core';
import { AGENT_PRESENCE_STALE_MS, hasAgentPresenceShape } from '@/lib/agent-presence';
import { sanitizeDocName } from './follow-file';

export interface PresenceWrite {
  doc: string;
  ts: number;
}

export function latestAgentWrite(awareness: unknown, now: number): PresenceWrite | null {
  if (!hasAgentPresenceShape(awareness)) return null;
  let latest: PresenceWrite | null = null;
  for (const state of awareness.getStates().values()) {
    const presence = state.agentPresence;
    if (!presence) continue;
    for (const entry of Object.values(presence)) {
      if (!entry.currentDoc) continue;
      if (isPresenceSentinelDocName(entry.currentDoc)) continue;
      const docTs = entry.docTs;
      if (docTs === undefined) continue;
      if (now - docTs >= AGENT_PRESENCE_STALE_MS) continue;
      if (latest !== null && docTs <= latest.ts) continue;
      const doc = sanitizeDocName(entry.currentDoc);
      if (doc === null) continue;
      latest = { doc, ts: docTs };
    }
  }
  return latest;
}

export function appendPresenceWrite(
  stream: ReadonlyArray<PresenceWrite>,
  write: PresenceWrite,
): ReadonlyArray<PresenceWrite> {
  const last = stream[stream.length - 1];
  if (last !== undefined && last.doc === write.doc && last.ts === write.ts) return stream;
  return [...stream, write];
}
