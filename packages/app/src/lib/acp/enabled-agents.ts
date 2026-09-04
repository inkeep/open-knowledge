import { useSyncExternalStore } from 'react';

export type EnabledOverrides = Readonly<Record<string, boolean>>;

const STORAGE_KEY = 'ok-acp-enabled-agents-v1';
const EMPTY_STATE: EnabledOverrides = {};

export function inAppEnabledKey(source: string, id: string): string {
  return `in-app:${source}:${id}`;
}

export function terminalEnabledKey(cli: string): string {
  return `terminal:${cli}`;
}

export function desktopEnabledKey(targetId: string): string {
  return `desktop:${targetId}`;
}

export function resolveEnabled(override: boolean | undefined, fallback: boolean): boolean {
  return override ?? fallback;
}

function readFromStorage(): EnabledOverrides {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[enabled-agents] localStorage unavailable; treating overrides as empty', err);
    return EMPTY_STATE;
  }
  if (raw === null) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_STATE;
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch (err) {
    console.warn('[enabled-agents] discarding corrupt localStorage payload', err);
    return EMPTY_STATE;
  }
}

function writeToStorage(state: EnabledOverrides): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[enabled-agents] failed to persist override', err);
  }
}

let state: EnabledOverrides | null = null;
const listeners = new Set<() => void>();

function currentState(): EnabledOverrides {
  if (state === null) state = readFromStorage();
  return state;
}

function setState(next: EnabledOverrides): void {
  state = next;
  for (const listener of listeners) listener();
}

export function reloadEnabledAgentsFromStorage(): void {
  setState(readFromStorage());
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) reloadEnabledAgentsFromStorage();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getOverrides = (): EnabledOverrides => currentState();

export function setAgentEnabled(key: string, enabled: boolean | undefined): void {
  const currentOverrides = currentState();
  if (enabled === undefined) {
    if (!(key in currentOverrides)) return;
    const { [key]: _removed, ...rest } = currentOverrides;
    writeToStorage(rest);
    setState(rest);
    return;
  }
  if (currentOverrides[key] === enabled) return;
  const next: EnabledOverrides = { ...currentOverrides, [key]: enabled };
  writeToStorage(next);
  setState(next);
}

export function useEnabledOverrides(): EnabledOverrides {
  return useSyncExternalStore(subscribe, getOverrides, getOverrides);
}
