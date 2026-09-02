import {
  type HandoffTarget,
  type InstallState,
  type TargetData,
  TERMINAL_CLI_IDS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';
import { useSyncExternalStore } from 'react';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';

export const UNIFIED_AGENT_KEY = 'ok-ask-ai-agent-v2';

const LEGACY_BOTTOM_KEY = 'ok-ask-ai-default-agent-v1';
const LEGACY_CREATE_KEY = 'ok-preferred-agent-v1';

export const TERMINAL_CLI_ID = 'terminal-cli';

export function terminalCliId(cli: TerminalCli): string {
  return `${TERMINAL_CLI_ID}:${cli}`;
}

export const IN_APP_THREAD_ID = 'in-app-thread';

export function threadAgentId(agent: { source: 'registry' | 'custom'; id: string }): string {
  return `${IN_APP_THREAD_ID}:${agent.source}:${agent.id}`;
}

export type StickyThreadAgent =
  | { readonly kind: 'concrete'; readonly source: 'registry' | 'custom'; readonly id: string }
  | { readonly kind: 'default' };

export function parseStickyThreadAgent(id: string | null): StickyThreadAgent | null {
  if (id === null) return null;
  if (id === IN_APP_THREAD_ID) return { kind: 'default' };
  const prefix = `${IN_APP_THREAD_ID}:`;
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const source = rest.slice(0, sep);
  const agentId = rest.slice(sep + 1);
  if ((source !== 'registry' && source !== 'custom') || agentId === '') return null;
  return { kind: 'concrete', source, id: agentId };
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

export function saveStickyAgent(id: HandoffTarget | string, storage?: StickyAgentStorage): void {
  const resolved = getStorage(storage);
  if (resolved) {
    try {
      resolved.setItem(UNIFIED_AGENT_KEY, id);
    } catch (err) {
      console.warn('[ask-ai] Failed to persist default agent:', err);
    }
  }
  for (const listener of stickyListeners) listener();
}

const stickyListeners = new Set<() => void>();

function currentStickyAgent(): string | null {
  return loadStickyAgent();
}

function reloadStickyAgentFromStorage(): void {
  for (const listener of stickyListeners) listener();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === UNIFIED_AGENT_KEY || event.key === null) reloadStickyAgentFromStorage();
  });
}

function subscribeStickyAgent(listener: () => void): () => void {
  stickyListeners.add(listener);
  return () => stickyListeners.delete(listener);
}

export function useStickyAgent(): string | null {
  return useSyncExternalStore(subscribeStickyAgent, currentStickyAgent, currentStickyAgent);
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
