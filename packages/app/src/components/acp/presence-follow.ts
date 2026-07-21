/**
 * Presence-derived write stream — the adapter-independent fallback signal for
 * follow-the-file and the content-phase detector.
 *
 * Some ACP adapters report tool calls with EMPTY rawInput and no locations
 * (observed live: Cursor sends `rawInput: {}` + title "MCP: tool" for every
 * call), so the transcript carries nothing to derive follow targets from. But
 * the OK server EXECUTES every MCP write and refreshes the writing agent's
 * `agentPresence.currentDoc` on `__system__` awareness per write — an
 * authoritative, adapter-independent stream of write targets. ThreadView
 * consumes it when (and only when) the transcript yields no targets at all.
 *
 * Multi-agent caveat: presence entries are not tied to a specific thread; the
 * stream reads "the doc most recently written by ANY agent." While a turn is
 * streaming that is overwhelmingly this thread's agent — the same
 * approximation the agent-build showcase's gate makes.
 */

import { isPresenceSentinelDocName } from '@inkeep/open-knowledge-core';
import { AGENT_PRESENCE_STALE_MS, hasAgentPresenceShape } from '@/lib/agent-presence';
import { sanitizeDocName } from './follow-file';

export interface PresenceWrite {
  doc: string;
  ts: number;
}

/**
 * The freshest agent write visible on `__system__` awareness right now, or
 * null. Dot-segment targets (`.ok/…` skill/config writes) are not user
 * documents and never become follow targets.
 */
export function latestAgentWrite(awareness: unknown, now: number): PresenceWrite | null {
  if (!hasAgentPresenceShape(awareness)) return null;
  let latest: PresenceWrite | null = null;
  for (const state of awareness.getStates().values()) {
    const presence = state.agentPresence;
    if (!presence) continue;
    for (const entry of Object.values(presence)) {
      if (!entry.currentDoc) continue;
      // Sentinels ('(connected)', '(agent thread)') keep an idle agent visible
      // in the presence bar but are NOT docs — following them opens a phantom
      // tab and, at turn end, drags the editor off the last real page.
      if (isPresenceSentinelDocName(entry.currentDoc)) continue;
      if (now - entry.ts >= AGENT_PRESENCE_STALE_MS) continue;
      if (latest !== null && entry.ts <= latest.ts) continue;
      const doc = sanitizeDocName(entry.currentDoc);
      if (doc === null) continue;
      latest = { doc, ts: entry.ts };
    }
  }
  return latest;
}

/**
 * Append an observed write to the per-turn stream. Same (doc, ts) is the same
 * write re-observed (awareness redelivers state on unrelated changes) — only
 * a new ts or a new doc extends the stream.
 */
export function appendPresenceWrite(
  stream: ReadonlyArray<PresenceWrite>,
  write: PresenceWrite,
): ReadonlyArray<PresenceWrite> {
  const last = stream[stream.length - 1];
  if (last !== undefined && last.doc === write.doc && last.ts === write.ts) return stream;
  return [...stream, write];
}
