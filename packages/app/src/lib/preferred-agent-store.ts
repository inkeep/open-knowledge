
import type { HandoffTarget, InstallState } from '@inkeep/open-knowledge-core';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import {
  loadStickyAgent,
  type StickyAgentStorage,
  saveStickyAgent,
} from '@/lib/unified-agent-store';

export const PREFERRED_AGENT_KEY = 'ok-preferred-agent-v1';

export type PreferredAgentStorage = StickyAgentStorage;

const VISIBLE_IDS = new Set<string>(VISIBLE_TARGETS.map((target) => target.id));

function isVisibleTarget(value: unknown): value is HandoffTarget {
  return typeof value === 'string' && VISIBLE_IDS.has(value);
}

export function readPreferredAgent(storage?: PreferredAgentStorage): HandoffTarget | null {
  try {
    const raw = loadStickyAgent(storage);
    return isVisibleTarget(raw) ? raw : null;
  } catch {
    return null; // localStorage unavailable (private mode, disabled) — no memory.
  }
}

/** Persist the preference to the unified key. Swallows quota / availability
 *  errors — the in-memory selection still holds for the session. */
export function writePreferredAgent(id: HandoffTarget, storage?: PreferredAgentStorage): void {
  saveStickyAgent(id, storage);
}

export function resolvePreferredAgent(args: {
  lastUsed: HandoffTarget | null;
  states: Record<HandoffTarget, InstallState>;
}): HandoffTarget | null {
  const { lastUsed, states } = args;
  if (lastUsed && states[lastUsed]?.installed === true) return lastUsed;
  return VISIBLE_TARGETS.find((target) => states[target.id]?.installed === true)?.id ?? null;
}
