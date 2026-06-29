import {
  type HandoffTarget,
  type InstallState,
  type TargetData,
  TERMINAL_CLI_IDS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';

export const UNIFIED_AGENT_KEY = 'ok-ask-ai-agent-v2';

const LEGACY_BOTTOM_KEY = 'ok-ask-ai-default-agent-v1';
const LEGACY_CREATE_KEY = 'ok-preferred-agent-v1';

export const TERMINAL_CLI_ID = 'terminal-cli';

export function terminalCliId(cli: TerminalCli): string {
  return `${TERMINAL_CLI_ID}:${cli}`;
}

export function parseStickyCliId(id: string | null): TerminalCli | null {
  if (id === null) return null;
  if (id === TERMINAL_CLI_ID) return 'claude';
  return TERMINAL_CLI_IDS.find((cli) => id === terminalCliId(cli)) ?? null;
}

export interface StickyAgentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getStorage(storage: StickyAgentStorage | undefined): StickyAgentStorage | null {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadStickyAgent(storage?: StickyAgentStorage): string | null {
  const resolved = getStorage(storage);
  if (!resolved) return null;
  try {
    const unified = resolved.getItem(UNIFIED_AGENT_KEY);
    if (unified !== null) return unified;
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
