/**
 * ONE sticky-agent store shared by every "Ask AI" composer placement (the bottom
 * docked field and the create/empty-screen hero). It carries the docked-terminal
 * CLI sentinel (`terminal-cli:<cli>`) alongside the installed-app `HandoffTarget`
 * ids, so a default chosen in one placement is the default the other reads back.
 *
 * Before this consolidation the two surfaces wrote to two divergent localStorage
 * keys — the bottom composer to `ok-ask-ai-default-agent-v1` (with the CLI
 * sentinel) and the create composer to `ok-preferred-agent-v1` (app targets
 * only, no CLI). A CLI default in one was invisible to the other, and the create
 * composer could never default to a CLI. This store is the single source of
 * truth; both legacy keys are read once as a migration shim (newest write wins)
 * so a user's prior pick survives, then writes go only to the unified key.
 *
 * Persistence is client-only localStorage — the same precedent as the omnibar
 * recents (`command-palette-recents.ts`) and the TerminalDock height — not a
 * `config.yml` field (cross-device preference is deferred Future Work).
 */

import {
  type HandoffTarget,
  type InstallState,
  type TargetData,
  TERMINAL_CLI_IDS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';

/** The unified key both placements read and write. */
export const UNIFIED_AGENT_KEY = 'ok-ask-ai-agent-v2';

/**
 * The two legacy keys, read once by the migration shim (newest non-empty wins).
 * `ok-ask-ai-default-agent-v1` carried the CLI sentinel; `ok-preferred-agent-v1`
 * carried app targets only. Kept here, not exported, so the shim has one place
 * to evolve.
 */
const LEGACY_BOTTOM_KEY = 'ok-ask-ai-default-agent-v1';
const LEGACY_CREATE_KEY = 'ok-preferred-agent-v1';

/**
 * Legacy picker sentinel for the docked-terminal launcher — back when the only
 * CLI was Claude. Persisted values may still carry it from a prior session, so
 * it is read as `terminal-cli:claude` on load (see {@link parseStickyCliId}).
 * New writes use the per-CLI ids below.
 */
export const TERMINAL_CLI_ID = 'terminal-cli';

/**
 * Per-CLI picker sentinel — `terminal-cli:<cli>` (e.g. `terminal-cli:codex`).
 * Distinct from every `HandoffTarget` id, persisted like a sticky agent choice.
 * Callers treat it as terminal mode only when the launcher is actually
 * available (desktop); on web it degrades to the first app target.
 */
export function terminalCliId(cli: TerminalCli): string {
  return `${TERMINAL_CLI_ID}:${cli}`;
}

/**
 * Parse a persisted sticky id back into a `TerminalCli`, or `null` when it does
 * not name a CLI launcher. The bare legacy `terminal-cli` sentinel maps to
 * `claude` (the only CLI when it was written), so a sticky terminal pick from a
 * prior session survives the migration to per-CLI ids.
 */
export function parseStickyCliId(id: string | null): TerminalCli | null {
  if (id === null) return null;
  // The bare legacy sentinel predates per-CLI ids — it was Claude-only.
  if (id === TERMINAL_CLI_ID) return 'claude';
  // Derived from the exhaustive `TERMINAL_CLI_IDS` so a newly-added CLI is parsed
  // here automatically (no hardcoded per-CLI branch to keep in sync).
  return TERMINAL_CLI_IDS.find((cli) => id === terminalCliId(cli)) ?? null;
}

/** Minimal localStorage surface — a test seam so unit tests inject a fake. */
export interface StickyAgentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Resolve a usable Storage. Mirrors `command-palette-recents.getStorage`: an
 * injected storage wins (tests), otherwise `window.localStorage` guarded for
 * SSR + privacy-mode throws.
 */
function getStorage(storage: StickyAgentStorage | undefined): StickyAgentStorage | null {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The persisted sticky id, or `null` when nothing is stored / storage is
 * unavailable. Returned as the raw stored string rather than a validated
 * `HandoffTarget`: `resolveStickyAgent` only honors it when it matches a
 * currently-installed visible target, and `parseStickyCliId` handles the CLI
 * sentinel, so a stale or junk value falls back harmlessly without a validation
 * step here.
 *
 * Reads the unified key first; falls back to the two legacy keys (newest write
 * wins) when the unified key is empty, so a pick made before this consolidation
 * survives. The legacy read is a one-time migration — once anything is written
 * back via {@link saveStickyAgent} the unified key wins.
 */
export function loadStickyAgent(storage?: StickyAgentStorage): string | null {
  const resolved = getStorage(storage);
  if (!resolved) return null;
  try {
    const unified = resolved.getItem(UNIFIED_AGENT_KEY);
    if (unified !== null) return unified;
    // Migration shim: neither legacy key carries a timestamp, so we cannot tell
    // which was written more recently. The bottom-composer key is preferred
    // because it is the only one that can carry a CLI sentinel — honoring it
    // first means a sticky CLI pick is never silently downgraded to the
    // create composer's app-only value. When it is absent, fall back to the
    // create key's app-target pick.
    return resolved.getItem(LEGACY_BOTTOM_KEY) ?? resolved.getItem(LEGACY_CREATE_KEY);
  } catch {
    return null;
  }
}

/** Persist the sticky id to the unified key. Swallows quota / availability
 *  errors — the in-memory selection still holds for the session. */
export function saveStickyAgent(id: HandoffTarget | string, storage?: StickyAgentStorage): void {
  const resolved = getStorage(storage);
  if (!resolved) return;
  try {
    resolved.setItem(UNIFIED_AGENT_KEY, id);
  } catch (err) {
    console.warn('[ask-ai] Failed to persist default agent:', err);
  }
}

/**
 * Resolve which app agent the composer should target, given live install state
 * and the sticky preference:
 *
 *   1. the sticky agent, if it is a currently-installed visible target;
 *   2. otherwise the first installed visible target (the zero-config default);
 *   3. otherwise `null` (nothing installed — the caller disables Send).
 *
 * Restricting to `VISIBLE_TARGETS` (and requiring `installed === true`) is what
 * makes a stale sticky id — an uninstalled agent, one not on the visible list,
 * or a CLI sentinel — degrade to the first-installed default instead of
 * dispatching nowhere. CLI sentinels are handled separately via
 * {@link parseStickyCliId}; they are not app targets and resolve to `null` here.
 */
export function resolveStickyAgent(
  states: Partial<Record<HandoffTarget, InstallState>>,
  stickyId: string | null,
): TargetData | null {
  const installed = VISIBLE_TARGETS.filter((target) => states[target.id]?.installed === true);
  if (stickyId) {
    const sticky = installed.find((target) => target.id === stickyId);
    if (sticky) return sticky;
  }
  return installed[0] ?? null;
}
