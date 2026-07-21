/**
 * Per-agent enable/disable overrides — the user's source of truth for which
 * agents appear in the launcher dropdowns (footer "Ask", empty-state "Create
 * with", header "Open with AI"). Managed from the Settings → Configure agents
 * tab; consumed by every picker surface.
 *
 * The store holds ONLY explicit user overrides. The effective enabled-state is
 * `override ?? categoryDefault`, computed at each call site where the runtime
 * signals live (install detection, PATH probe, registration) — so the store
 * stays pure and free of the async catalog / probe dependencies. Category
 * defaults:
 *   - Terminal / Desktop → detected (auto-enabled when installed)
 *   - In app             → registered (enabling registers; nothing to detect)
 *
 * Persisted in localStorage like the sibling launcher stores (registered
 * agents, sticky handoff target). Enablement is per-machine by design: it pairs
 * with per-machine detection, so it does not sync across devices.
 *
 * Store shape follows `registered-agents.ts`: module-scope state, a listener
 * set, and bound snapshot getters that stay referentially stable between
 * changes — with React Compiler enabled, a `useSyncExternalStore` hook must
 * return the subscription value from stable getters or it memoizes to the first
 * snapshot.
 */

import { useSyncExternalStore } from 'react';

/** Explicit user overrides, keyed by the category-scoped agent key. Absent key
 *  means "no override" → the caller falls back to the category default. */
export type EnabledOverrides = Readonly<Record<string, boolean>>;

const STORAGE_KEY = 'ok-acp-enabled-agents-v1';
const EMPTY_STATE: EnabledOverrides = {};

/** Stable override key for an in-app (registry/custom) agent. */
export function inAppEnabledKey(source: string, id: string): string {
  return `in-app:${source}:${id}`;
}

/** Stable override key for a terminal CLI (`claude`, `codex`, …). */
export function terminalEnabledKey(cli: string): string {
  return `terminal:${cli}`;
}

/** Stable override key for a desktop handoff target (`claude-code`, …). */
export function desktopEnabledKey(targetId: string): string {
  return `desktop:${targetId}`;
}

/**
 * Effective enabled-state: the user's explicit override when present, else the
 * caller-supplied category default. The single place override precedence is
 * expressed, so every surface resolves enablement identically.
 */
export function resolveEnabled(override: boolean | undefined, fallback: boolean): boolean {
  return override ?? fallback;
}

function readFromStorage(): EnabledOverrides {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    // localStorage unavailable — non-browser env, or a browser blocking it via
    // a privacy setting / CSP / partitioned-storage. Behave as empty, but log
    // for diagnostics (matches the corrupt-payload catch below).
    console.warn('[enabled-agents] localStorage unavailable; treating overrides as empty', err);
    return EMPTY_STATE;
  }
  if (raw === null) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_STATE;
    // Keep only string→boolean entries; a corrupt/foreign value for a key is
    // dropped rather than poisoning the whole map.
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
    // Quota / privacy mode — the in-memory state still serves this session,
    // but the change will NOT survive a reload; say so.
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

/** Re-read persisted state (cross-tab `storage` events; tests). */
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

/**
 * Set (or clear) an explicit enable/disable override for one agent key.
 * Passing `undefined` removes the override so the agent reverts to its category
 * default.
 */
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

/** Reactive override map. Resolve effective state via {@link resolveEnabled}. */
export function useEnabledOverrides(): EnabledOverrides {
  return useSyncExternalStore(subscribe, getOverrides, getOverrides);
}
