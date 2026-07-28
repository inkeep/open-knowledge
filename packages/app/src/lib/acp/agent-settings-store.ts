/**
 * Per-agent-type remembered ACP thread settings (model, thought level, and
 * other config options). Picking a model / effort in one thread makes the next
 * thread of the SAME agent open on that choice — the choice rides the `create`
 * frame and the server applies it between `session/new` and the first prompt.
 *
 * localStorage-only, like the other launcher preferences. Write-mostly /
 * read-once-per-launch, so — unlike `registered-agents.ts` — it keeps no
 * module-scope cache and does no cross-tab `storage` plumbing: each call reads
 * or writes fresh.
 *
 * Every pick is remembered, modes included. A mode can be permission-affecting
 * (Claude's `bypassPermissions`, Gemini's YOLO), so a restored one must stay
 * legible rather than silent: the settings trigger flags a mode that reads as
 * permissive with an amber accent, whether it was restored or just chosen. See
 * `permissive-mode.ts`.
 */

const STORAGE_KEY = 'ok-acp-agent-settings-v1';

type ConfigValue = string | boolean;
// `modeId` matches the wire naming end-to-end (`settings.modeId`,
// `modes.currentModeId`, `session/set_mode`) so the value keeps one name from
// localStorage through the server. It carries the legacy `SessionModeState`
// surface only — an agent that exposes its mode as a config option stores it
// in `config` like any other option, with no special case anywhere.
type StoredAgentSettings = { config?: Record<string, ConfigValue>; modeId?: string };
type Store = Record<string, StoredAgentSettings>;

/** Stable per-agent identity — the same `<source>:<id>` key `registered-agents.ts` uses. */
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
    // No localStorage (non-browser) or corrupt payload — behave as empty.
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (err) {
    // Quota / privacy mode — the choice simply won't carry to the next thread.
    // Log (no toast) so "my picks don't stick" leaves evidence in DevTools while
    // keeping the graceful-degradation contract: never throw, never interrupt.
    console.warn('[acp-settings] could not persist agent settings', err);
  }
}

/** Remember a config-option choice for this agent type. */
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

/**
 * The remembered config-option map for this agent type, or undefined when
 * nothing is stored. Non-primitive values from a corrupt payload are dropped.
 */
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

/**
 * Remember a legacy-surface mode pick, so the next thread of this agent opens
 * on it. Modes that expose themselves as config options go through
 * {@link rememberAgentConfigOption} instead.
 */
export function rememberAgentMode(agentKey: string, modeId: string): void {
  if (modeId === '') return;
  const store = read();
  const entry = store[agentKey] ?? {};
  store[agentKey] = { ...entry, modeId };
  write(store);
}

/** The remembered legacy-surface mode for this agent type, or undefined. */
export function getRememberedAgentMode(agentKey: string): string | undefined {
  const modeId = read()[agentKey]?.modeId;
  return typeof modeId === 'string' && modeId !== '' ? modeId : undefined;
}
