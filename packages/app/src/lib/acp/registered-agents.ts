import { useSyncExternalStore } from 'react';

export interface RegisteredAgent {
  readonly source: 'registry' | 'custom';
  readonly id: string;
  readonly name: string;
  readonly iconUrl?: string;
  readonly supported?: boolean;
  readonly lastUsedAt?: number;
  readonly featured?: boolean;
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
    (a.iconUrl === undefined || typeof a.iconUrl === 'string') &&
    (a.lastUsedAt === undefined || typeof a.lastUsedAt === 'number') &&
    (a.featured === undefined || typeof a.featured === 'boolean')
  );
}

function readFromStorage(): RegisteredAgentsState {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
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
    console.warn('[registered-agents] discarding corrupt localStorage payload', err);
    return EMPTY_STATE;
  }
}

function writeToStorage(state: RegisteredAgentsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
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
      ? current.agents.map((a) =>
          agentKey(a) === key
            ? { ...agent, ...(a.lastUsedAt !== undefined ? { lastUsedAt: a.lastUsedAt } : {}) }
            : a,
        )
      : [...current.agents, agent];
    const next: RegisteredAgentsState = { agents, defaultKey: current.defaultKey };
    writeToStorage(next);
    setState(next);
    return;
  }
  const rest = current.agents.filter((a) => agentKey(a) !== key);
  const next: RegisteredAgentsState = {
    agents: [{ ...agent, lastUsedAt: Date.now() }, ...rest],
    defaultKey: key,
  };
  writeToStorage(next);
  setState(next);
}

function compareAgentsForDisplay(a: RegisteredAgent, b: RegisteredAgent): number {
  const aUsed = a.lastUsedAt ?? 0;
  const bUsed = b.lastUsedAt ?? 0;
  if (aUsed !== bUsed) return bUsed - aUsed;
  const aFeatured = a.featured === true ? 0 : 1;
  const bFeatured = b.featured === true ? 0 : 1;
  if (aFeatured !== bFeatured) return aFeatured - bFeatured;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

export function mergeRegisteredAgentSuggestions(
  registered: readonly RegisteredAgent[],
  suggestions: readonly RegisteredAgent[],
): readonly RegisteredAgent[] {
  const explicitKeys = new Set(registered.map(agentKey));
  return [...registered, ...suggestions.filter((agent) => !explicitKeys.has(agentKey(agent)))].sort(
    compareAgentsForDisplay,
  );
}

export function setDetectedRegisteredAgentSuggestions(
  suggestions: readonly RegisteredAgent[],
): void {
  detectedSuggestions = [...suggestions];
  presentedAgents = mergeRegisteredAgentSuggestions(currentState().agents, detectedSuggestions);
  for (const listener of listeners) listener();
}

export function getRegisteredAgentOptions(): readonly RegisteredAgent[] {
  return getAgents();
}

export function getDefaultRegisteredAgent(): RegisteredAgent | null {
  return getDefault();
}

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
    const nextFeatured = patch.featured ?? agent.featured;
    if (
      nextName === agent.name &&
      nextIconUrl === agent.iconUrl &&
      nextSupported === agent.supported &&
      nextFeatured === agent.featured
    )
      return agent;
    changed = true;
    return {
      ...agent,
      name: nextName,
      ...(nextIconUrl !== undefined ? { iconUrl: nextIconUrl } : {}),
      ...(nextSupported !== undefined ? { supported: nextSupported } : {}),
      ...(nextFeatured !== undefined ? { featured: nextFeatured } : {}),
    };
  });
  if (!changed) return;
  const next: RegisteredAgentsState = { agents, defaultKey: current.defaultKey };
  writeToStorage(next);
  setState(next);
}

export function useRegisteredAgents(): readonly RegisteredAgent[] {
  return useSyncExternalStore(subscribe, getAgents, getAgents);
}

export function useDefaultRegisteredAgent(): RegisteredAgent | null {
  return useSyncExternalStore(subscribe, getDefault, getDefault);
}
