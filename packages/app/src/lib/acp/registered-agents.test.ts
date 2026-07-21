import { beforeEach, describe, expect, test } from 'vitest';

// Plain `bun test` has no localStorage — install a minimal stub BEFORE the
// module under test first touches it (reads are lazy, so import order is
// safe either way).
const backing = new Map<string, string>();
if (typeof globalThis.localStorage === 'undefined') {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
  };
}

import {
  getDefaultRegisteredAgent,
  getRegisteredAgentOptions,
  hydrateRegisteredAgentMeta,
  mergeRegisteredAgentSuggestions,
  pickEffectiveDefaultAgent,
  type RegisteredAgent,
  reassignDefaultIfDisabled,
  registerAgent,
  reloadRegisteredAgentsFromStorage,
  setDetectedRegisteredAgentSuggestions,
} from './registered-agents';

const STORAGE_KEY = 'ok-acp-registered-agents-v1';

function storedAgents(): RegisteredAgent[] {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').agents ?? [];
}

const claude: RegisteredAgent = {
  source: 'registry',
  id: 'claude-acp',
  name: 'Claude Agent',
  iconUrl: 'https://example.com/claude.svg',
};
const codex: RegisteredAgent = { source: 'registry', id: 'codex-acp', name: 'Codex' };

beforeEach(() => {
  localStorage.clear();
  setDetectedRegisteredAgentSuggestions([]);
  reloadRegisteredAgentsFromStorage();
});

describe('registered-agents store', () => {
  test('empty before any registration', () => {
    expect(getDefaultRegisteredAgent()).toBeNull();
  });

  test('registerAgent sets the default and persists', () => {
    registerAgent(claude);
    expect(getDefaultRegisteredAgent()).toEqual(claude);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(persisted.agents).toEqual([claude]);
    expect(persisted.defaultKey).toBe('registry:claude-acp');
  });

  test('the most recently registered agent becomes the default; re-registering dedupes', () => {
    registerAgent(claude);
    registerAgent(codex);
    expect(getDefaultRegisteredAgent()?.id).toBe('codex-acp');
    registerAgent(claude);
    expect(getDefaultRegisteredAgent()?.id).toBe('claude-acp');
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(persisted.agents).toHaveLength(2);
    expect(persisted.agents.map((a: RegisteredAgent) => a.id)).toEqual(['claude-acp', 'codex-acp']);
  });

  test('survives reload from storage', () => {
    registerAgent(claude);
    reloadRegisteredAgentsFromStorage();
    expect(getDefaultRegisteredAgent()).toEqual(claude);
  });

  test('makeDefault:false registers for visibility without changing the default', () => {
    registerAgent(claude); // claude is the default
    registerAgent(codex, { makeDefault: false }); // enable-in-Settings path
    // Default unchanged, codex appended (not prepended), both present.
    expect(getDefaultRegisteredAgent()?.id).toBe('claude-acp');
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(persisted.agents.map((a: RegisteredAgent) => a.id)).toEqual(['claude-acp', 'codex-acp']);
  });

  test('makeDefault:false updates an existing agent in place without reordering or re-defaulting', () => {
    registerAgent(claude);
    registerAgent(codex); // codex now default, order [codex, claude]
    registerAgent({ ...claude, name: 'Claude Renamed' }, { makeDefault: false });
    // Default stays codex; claude keeps its position; metadata refreshed.
    expect(getDefaultRegisteredAgent()?.id).toBe('codex-acp');
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(persisted.agents.map((a: RegisteredAgent) => a.id)).toEqual(['codex-acp', 'claude-acp']);
    expect(persisted.agents.find((a: RegisteredAgent) => a.id === 'claude-acp')?.name).toBe(
      'Claude Renamed',
    );
  });

  test('corrupt storage behaves as empty rather than throwing', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    reloadRegisteredAgentsFromStorage();
    expect(getDefaultRegisteredAgent()).toBeNull();
  });

  test('a default pointing at a missing agent is dropped on read', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ agents: [claude], defaultKey: 'registry:vanished' }),
    );
    reloadRegisteredAgentsFromStorage();
    expect(getDefaultRegisteredAgent()).toBeNull();
  });

  test('malformed entries are filtered on read', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        agents: [claude, { source: 'registry', id: '' }, { name: 'no id' }, 42],
        defaultKey: 'registry:claude-acp',
      }),
    );
    reloadRegisteredAgentsFromStorage();
    expect(getDefaultRegisteredAgent()).toEqual(claude);
  });

  test('merges detected suggestions without replacing explicit registrations', () => {
    expect(mergeRegisteredAgentSuggestions([claude], [codex, claude])).toEqual([claude, codex]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test('detected suggestions appear everywhere without becoming the default or persisting', () => {
    setDetectedRegisteredAgentSuggestions([codex]);

    expect(getRegisteredAgentOptions()).toEqual([codex]);
    expect(getDefaultRegisteredAgent()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    registerAgent(claude);
    expect(getRegisteredAgentOptions()).toEqual([claude, codex]);
    expect(getDefaultRegisteredAgent()).toEqual(claude);
  });
});

describe('hydrateRegisteredAgentMeta', () => {
  beforeEach(() => {
    localStorage.clear();
    reloadRegisteredAgentsFromStorage();
  });

  test('updates name/icon in place without changing the default or order', () => {
    // Claude first + default; the rest appended in order.
    registerAgent(claude, { makeDefault: true });
    registerAgent(codex, { makeDefault: false });
    registerAgent({ source: 'registry', id: 'cursor', name: 'Cursor' }, { makeDefault: false });
    registerAgent({ source: 'registry', id: 'gemini', name: 'Gemini' }, { makeDefault: false });
    hydrateRegisteredAgentMeta([
      { source: 'registry', id: 'codex-acp', name: 'Codex', iconUrl: 'https://x/codex.svg' },
      { source: 'registry', id: 'gemini', name: 'Gemini CLI' },
    ]);
    const agents = storedAgents();
    expect(agents.map((a) => a.id)).toEqual(['claude-acp', 'codex-acp', 'cursor', 'gemini']);
    expect(agents.find((a) => a.id === 'codex-acp')?.iconUrl).toBe('https://x/codex.svg');
    expect(agents.find((a) => a.id === 'gemini')?.name).toBe('Gemini CLI');
    // Default is unchanged by hydration.
    expect(getDefaultRegisteredAgent()?.id).toBe('claude-acp');
  });

  test('ignores patches for agents that are not registered', () => {
    registerAgent(claude);
    hydrateRegisteredAgentMeta([{ source: 'registry', id: 'not-registered', name: 'Nope' }]);
    expect(storedAgents().map((a) => a.id)).toEqual(['claude-acp']);
  });

  test('stores the supported flag so the launcher can hide unavailable agents', () => {
    registerAgent(codex);
    hydrateRegisteredAgentMeta([{ source: 'registry', id: 'codex-acp', supported: false }]);
    expect(storedAgents().find((a) => a.id === 'codex-acp')?.supported).toBe(false);
  });
});

describe('pickEffectiveDefaultAgent', () => {
  test('keeps the default when it is still enabled', () => {
    expect(pickEffectiveDefaultAgent([claude, codex], claude)).toBe(claude);
  });

  test('falls back to the first enabled agent when the default is disabled', () => {
    // claude is the default but not in the enabled list → lead with codex.
    expect(pickEffectiveDefaultAgent([codex], claude)).toBe(codex);
  });

  test('returns null when no agents are enabled', () => {
    expect(pickEffectiveDefaultAgent([], claude)).toBeNull();
    expect(pickEffectiveDefaultAgent([], null)).toBeNull();
  });

  test('leads with the first enabled agent when there is no default', () => {
    expect(pickEffectiveDefaultAgent([codex, claude], null)).toBe(codex);
  });
});

describe('reassignDefaultIfDisabled', () => {
  beforeEach(() => {
    localStorage.clear();
    reloadRegisteredAgentsFromStorage();
  });

  test('moves the default to the next still-enabled agent when the default is disabled', () => {
    registerAgent(codex); // order [codex]
    registerAgent(claude); // order [claude, codex], claude is default
    expect(getDefaultRegisteredAgent()?.id).toBe('claude-acp');
    // Disable claude (the default); codex is still enabled.
    reassignDefaultIfDisabled('registry:claude-acp', (a) => a.id === 'codex-acp');
    expect(getDefaultRegisteredAgent()?.id).toBe('codex-acp');
    // Order is preserved — only the default moved.
    expect(storedAgents().map((a) => a.id)).toEqual(['claude-acp', 'codex-acp']);
  });

  test('clears the default when no other agent is still enabled', () => {
    registerAgent(claude);
    reassignDefaultIfDisabled('registry:claude-acp', () => false);
    expect(getDefaultRegisteredAgent()).toBeNull();
  });

  test('no-op when the disabled agent was not the default', () => {
    registerAgent(codex); // default
    registerAgent(claude); // now default is claude
    // Disable codex, which is NOT the default → default stays claude.
    reassignDefaultIfDisabled('registry:codex-acp', () => true);
    expect(getDefaultRegisteredAgent()?.id).toBe('claude-acp');
  });
});
