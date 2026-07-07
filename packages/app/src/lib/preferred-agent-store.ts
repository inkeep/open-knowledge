/**
 * Compatibility shim — the empty-state "Create with <agent>" composer's
 * preferred-agent memory is now ONE store shared with the bottom "Ask AI"
 * composer (`@/lib/unified-agent-store`).
 *
 * This module keeps the `read/write/resolvePreferredAgent` names + the
 * app-target validation the create composer relies on, but routes persistence
 * through the unified key so a default chosen in either placement is the default
 * the other reads back. The unified store reads the two legacy keys once as a
 * migration shim (newest write wins), so a user's prior create-composer pick
 * survives. New code should import from `@/lib/unified-agent-store`.
 *
 * Stored value is advisory: the agent it names may not be installed on the
 * machine reading it back, so `resolvePreferredAgent` reconciles against the
 * probe and only ever returns an installed agent (or `null` when none are).
 */

import type { HandoffTarget, InstallState } from '@inkeep/open-knowledge-core';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import {
  loadStickyAgent,
  type StickyAgentStorage,
  saveStickyAgent,
} from '@/lib/unified-agent-store';

/**
 * Legacy create-composer key. Retained as an export for the migration test +
 * any external reference, but writes now land on the unified key.
 */
export const PREFERRED_AGENT_KEY = 'ok-preferred-agent-v1';

/** Minimal localStorage surface — a test seam so unit tests inject a fake. */
export type PreferredAgentStorage = StickyAgentStorage;

const VISIBLE_IDS = new Set<string>(VISIBLE_TARGETS.map((target) => target.id));

function isVisibleTarget(value: unknown): value is HandoffTarget {
  return typeof value === 'string' && VISIBLE_IDS.has(value);
}

/**
 * Read the persisted preference as an installable app target, or `null` when
 * absent / corrupt / unknown / a CLI sentinel. The create composer's app-only
 * surface can't launch a CLI sentinel, so a unified value that names one degrades
 * to null here (the resolver then falls back to first-installed).
 */
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

/**
 * Resolve the default agent from the persisted preference + the resolved install
 * probe. The composer can only launch an **installed** agent (there is no web
 * fallback), so this returns only installed agents — or `null` when none are
 * installed, which the composer renders as a disabled "no agents" state.
 *
 * Priority:
 *   1. the persisted last-used agent, if it's installed on this machine
 *   2. the first installed agent in `VISIBLE_TARGETS` order (Claude first, so
 *      Claude wins when installed) — the product default
 *   3. `null` when nothing is installed
 *
 * Call only once the probe has settled (no `null` install states); pre-probe the
 * caller keeps its optimistic init value rather than resolve on partial data.
 * Pure + total so it's unit-tested without rendering.
 */
export function resolvePreferredAgent(args: {
  lastUsed: HandoffTarget | null;
  states: Record<HandoffTarget, InstallState>;
}): HandoffTarget | null {
  const { lastUsed, states } = args;
  if (lastUsed && states[lastUsed]?.installed === true) return lastUsed;
  return VISIBLE_TARGETS.find((target) => states[target.id]?.installed === true)?.id ?? null;
}
