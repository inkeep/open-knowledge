/**
 * ACP agent options — the user's explicit shortlist plus live, machine-detected
 * harness suggestions. Picking an agent registers it once; the default remains
 * the most recently registered (last explicitly chosen) agent.
 *
 * Persisted in localStorage like the other launcher preferences (sticky
 * handoff target, terminal CLI sentinel). Name + icon are cached alongside the
 * id so menus can render rows without refetching the registry catalog.
 *
 * Store shape follows `thread-client.ts`: module-scope state, a listener set,
 * and bound snapshot getters that stay referentially stable between changes —
 * with React Compiler enabled, a `useSyncExternalStore` hook must return the
 * subscription value from stable getters or it memoizes to the first snapshot.
 */

import { useSyncExternalStore } from 'react';

export interface RegisteredAgent {
  readonly source: 'registry' | 'custom';
  readonly id: string;
  readonly name: string;
  readonly iconUrl?: string;
  /**
   * Whether the registry ships a build this agent can launch on this host.
   * Hydrated from the catalog (undefined until then). `false` force-hides the
   * agent from every launcher and its Settings toggle, so the two always agree.
   */
  readonly supported?: boolean;
}

interface RegisteredAgentsState {
  readonly agents: readonly RegisteredAgent[];
  readonly defaultKey: string | null;
}

const STORAGE_KEY = 'ok-acp-registered-agents-v1';
const EMPTY_STATE: RegisteredAgentsState = { agents: [], defaultKey: null };

function agentKey(agent: Pick<RegisteredAgent, 'source' | 'id'>): string {
  return `${agent.source}:${agent.id}`;
}

function isRegisteredAgent(value: unknown): value is RegisteredAgent {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    (a.source === 'registry' || a.source === 'custom') &&
    typeof a.id === 'string' &&
    a.id !== '' &&
    typeof a.name === 'string' &&
    a.name !== '' &&
    (a.iconUrl === undefined || typeof a.iconUrl === 'string')
  );
}

function readFromStorage(): RegisteredAgentsState {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // No localStorage (non-browser env) — behave as empty, silently.
    return EMPTY_STATE;
  }
  if (raw === null) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(raw) as { agents?: unknown; defaultKey?: unknown };
    const agents = Array.isArray(parsed.agents) ? parsed.agents.filter(isRegisteredAgent) : [];
    const defaultKey =
      typeof parsed.defaultKey === 'string' && agents.some((a) => agentKey(a) === parsed.defaultKey)
        ? parsed.defaultKey
        : null;
    return { agents, defaultKey };
  } catch (err) {
    // A present-but-corrupt payload is a real storage failure, distinct from
    // "never registered" — leave a signal for the disappearing-registration
    // bug report before discarding.
    console.warn('[registered-agents] discarding corrupt localStorage payload', err);
    return EMPTY_STATE;
  }
}

function writeToStorage(state: RegisteredAgentsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    // Quota / privacy mode — the in-memory state still serves this session,
    // but the registration will NOT survive a reload; say so.
    console.warn('[registered-agents] failed to persist registration', err);
  }
}

let state: RegisteredAgentsState | null = null;
let detectedSuggestions: readonly RegisteredAgent[] = [];
let presentedAgents: readonly RegisteredAgent[] | null = null;
const listeners = new Set<() => void>();

function currentState(): RegisteredAgentsState {
  if (state === null) state = readFromStorage();
  return state;
}

function setState(next: RegisteredAgentsState): void {
  state = next;
  presentedAgents = mergeRegisteredAgentSuggestions(next.agents, detectedSuggestions);
  for (const listener of listeners) listener();
}

/** Re-read persisted state (cross-tab `storage` events; tests). */
export function reloadRegisteredAgentsFromStorage(): void {
  setState(readFromStorage());
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) reloadRegisteredAgentsFromStorage();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getAgents = (): readonly RegisteredAgent[] => {
  if (presentedAgents === null) {
    presentedAgents = mergeRegisteredAgentSuggestions(currentState().agents, detectedSuggestions);
  }
  return presentedAgents;
};

const getDefault = (): RegisteredAgent | null => {
  const { agents, defaultKey } = currentState();
  if (defaultKey === null) return null;
  return agents.find((a) => agentKey(a) === defaultKey) ?? null;
};

/**
 * Register (or refresh) an agent.
 *
 * `makeDefault` (the default) is the explicit-pick path: the agent jumps to the
 * front and becomes the launch default — "the agent you chose last is your
 * agent". Every launcher pick uses it.
 *
 * `makeDefault: false` is the visibility-only path used by the Settings toggle:
 * it registers/refreshes the agent so it shows in the menus but leaves the
 * launch default untouched (and doesn't reorder an agent already present).
 * Enabling an agent in Settings must not silently repoint which agent the
 * primary button launches — only an explicit launcher pick does that.
 */
export function registerAgent(
  agent: RegisteredAgent,
  options: { makeDefault?: boolean } = {},
): void {
  const { makeDefault = true } = options;
  const key = agentKey(agent);
  const current = currentState();
  if (!makeDefault) {
    const exists = current.agents.some((a) => agentKey(a) === key);
    const agents = exists
      ? current.agents.map((a) => (agentKey(a) === key ? agent : a))
      : [...current.agents, agent];
    const next: RegisteredAgentsState = { agents, defaultKey: current.defaultKey };
    writeToStorage(next);
    setState(next);
    return;
  }
  const rest = current.agents.filter((a) => agentKey(a) !== key);
  const next: RegisteredAgentsState = { agents: [agent, ...rest], defaultKey: key };
  writeToStorage(next);
  setState(next);
}

/**
 * Add live, machine-detected suggestions after the explicit shortlist without
 * persisting them. An explicit registration with the same id always wins.
 */
export function mergeRegisteredAgentSuggestions(
  registered: readonly RegisteredAgent[],
  suggestions: readonly RegisteredAgent[],
): readonly RegisteredAgent[] {
  const explicitKeys = new Set(registered.map(agentKey));
  return [...registered, ...suggestions.filter((agent) => !explicitKeys.has(agentKey(agent)))];
}

/**
 * Replace live server-host suggestions without persisting them or changing the
 * explicit default. The app-level catalog detector owns this projection.
 */
export function setDetectedRegisteredAgentSuggestions(
  suggestions: readonly RegisteredAgent[],
): void {
  detectedSuggestions = [...suggestions];
  presentedAgents = mergeRegisteredAgentSuggestions(currentState().agents, detectedSuggestions);
  for (const listener of listeners) listener();
}

/** Current explicit registrations plus live detected suggestions. */
export function getRegisteredAgentOptions(): readonly RegisteredAgent[] {
  return getAgents();
}

/** The default agent for pickerless launches; null before first registration. */
export function getDefaultRegisteredAgent(): RegisteredAgent | null {
  return getDefault();
}

/**
 * When the user disables the agent that is currently the launch default, move
 * the default off it — to the first still-enabled registered agent, or clear it
 * when none remain. Keeps the composer from showing a just-disabled agent as the
 * selected one. No-op when the disabled agent wasn't the default. Order is
 * preserved (only `defaultKey` moves).
 *
 * `disabledKey` is `<source>:<id>`; `stillEnabled` reports whether a given agent
 * is still enabled AFTER the disable (the disabled agent is excluded by key, so
 * the predicate can read a pre-disable overrides snapshot safely).
 */
export function reassignDefaultIfDisabled(
  disabledKey: string,
  stillEnabled: (agent: RegisteredAgent) => boolean,
): void {
  const current = currentState();
  if (current.defaultKey !== disabledKey) return;
  const next = current.agents.find((a) => agentKey(a) !== disabledKey && stillEnabled(a)) ?? null;
  const nextState: RegisteredAgentsState = {
    agents: current.agents,
    defaultKey: next ? agentKey(next) : null,
  };
  writeToStorage(nextState);
  setState(nextState);
}

/**
 * The registered agent a primary launcher should lead with: the current default
 * when it is still in `enabled`, else the first enabled one (null if none). Lets
 * every launcher surface avoid leading with an agent the user disabled.
 */
export function pickEffectiveDefaultAgent(
  enabled: readonly RegisteredAgent[],
  defaultAgent: RegisteredAgent | null,
): RegisteredAgent | null {
  if (
    defaultAgent !== null &&
    enabled.some((a) => a.source === defaultAgent.source && a.id === defaultAgent.id)
  ) {
    return defaultAgent;
  }
  return enabled[0] ?? null;
}

/**
 * Update the cached name/icon/supported flag of already-registered agents in
 * place, WITHOUT changing the default or list order. Used to hydrate the seeded
 * defaults' placeholder metadata once the registry catalog resolves (the seed
 * ships names only; the catalog carries display names, icon URLs, and whether a
 * launchable build exists for this host).
 */
export function hydrateRegisteredAgentMeta(
  patches: ReadonlyArray<Pick<RegisteredAgent, 'source' | 'id'> & Partial<RegisteredAgent>>,
): void {
  const byKey = new Map(patches.map((p) => [agentKey(p), p]));
  const current = currentState();
  let changed = false;
  const agents = current.agents.map((agent) => {
    const patch = byKey.get(agentKey(agent));
    if (patch === undefined) return agent;
    const nextName = patch.name ?? agent.name;
    const nextIconUrl = patch.iconUrl ?? agent.iconUrl;
    const nextSupported = patch.supported ?? agent.supported;
    if (
      nextName === agent.name &&
      nextIconUrl === agent.iconUrl &&
      nextSupported === agent.supported
    )
      return agent;
    changed = true;
    return {
      ...agent,
      name: nextName,
      ...(nextIconUrl !== undefined ? { iconUrl: nextIconUrl } : {}),
      ...(nextSupported !== undefined ? { supported: nextSupported } : {}),
    };
  });
  if (!changed) return;
  const next: RegisteredAgentsState = { agents, defaultKey: current.defaultKey };
  writeToStorage(next);
  setState(next);
}

/** Reactive explicit registrations followed by live detected suggestions. */
export function useRegisteredAgents(): readonly RegisteredAgent[] {
  return useSyncExternalStore(subscribe, getAgents, getAgents);
}

/** Reactive default agent; null before the first catalog pick. */
export function useDefaultRegisteredAgent(): RegisteredAgent | null {
  return useSyncExternalStore(subscribe, getDefault, getDefault);
}
