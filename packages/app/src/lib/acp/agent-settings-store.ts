const STORAGE_KEY = 'ok-acp-agent-settings-v1';

type ConfigValue = string | boolean;
type StoredAgentSettings = { config?: Record<string, ConfigValue>; modeId?: string };
type Store = Record<string, StoredAgentSettings>;

export function agentSettingsKey(agent: { source: 'registry' | 'custom'; id: string }): string {
  return `${agent.source}:${agent.id}`;
}

function read(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (err) {
    console.warn('[acp-settings] could not persist agent settings', err);
  }
}

export function rememberAgentConfigOption(
  agentKey: string,
  configId: string,
  value: ConfigValue,
): void {
  const store = read();
  const entry = store[agentKey] ?? {};
  store[agentKey] = { ...entry, config: { ...entry.config, [configId]: value } };
  write(store);
}

export function getRememberedAgentConfig(
  agentKey: string,
): Record<string, ConfigValue> | undefined {
  const config = read()[agentKey]?.config;
  if (typeof config !== 'object' || config === null) return undefined;
  const clean: Record<string, ConfigValue> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'string' || typeof v === 'boolean') clean[k] = v;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

export function rememberAgentMode(agentKey: string, modeId: string): void {
  if (modeId === '') return;
  const store = read();
  const entry = store[agentKey] ?? {};
  store[agentKey] = { ...entry, modeId };
  write(store);
}

export function getRememberedAgentMode(agentKey: string): string | undefined {
  const modeId = read()[agentKey]?.modeId;
  return typeof modeId === 'string' && modeId !== '' ? modeId : undefined;
}
