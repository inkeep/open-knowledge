import { beforeEach, describe, expect, test } from 'vitest';

// Plain `bun test` has no localStorage — install a minimal stub BEFORE the
// module under test first touches it (reads are lazy, so import order is safe).
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
  desktopEnabledKey,
  inAppEnabledKey,
  reloadEnabledAgentsFromStorage,
  resolveEnabled,
  setAgentEnabled,
  terminalEnabledKey,
} from './enabled-agents';

const STORAGE_KEY = 'ok-acp-enabled-agents-v1';

function overrides(): Record<string, boolean> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
}

beforeEach(() => {
  localStorage.clear();
  reloadEnabledAgentsFromStorage();
});

describe('enabled-agents store', () => {
  test('key builders are category-scoped and stable', () => {
    expect(inAppEnabledKey('registry', 'claude-acp')).toBe('in-app:registry:claude-acp');
    expect(terminalEnabledKey('codex')).toBe('terminal:codex');
    expect(desktopEnabledKey('claude-code')).toBe('desktop:claude-code');
  });

  test('resolveEnabled: override wins over the category default', () => {
    expect(resolveEnabled(undefined, true)).toBe(true);
    expect(resolveEnabled(undefined, false)).toBe(false);
    expect(resolveEnabled(true, false)).toBe(true);
    expect(resolveEnabled(false, true)).toBe(false);
  });

  test('setAgentEnabled persists an explicit override', () => {
    const key = desktopEnabledKey('cursor');
    setAgentEnabled(key, false);
    expect(overrides()).toEqual({ [key]: false });
    setAgentEnabled(key, true);
    expect(overrides()).toEqual({ [key]: true });
  });

  test('clearing an override (undefined) reverts to the category default', () => {
    const key = terminalEnabledKey('claude');
    setAgentEnabled(key, false);
    expect(overrides()).toEqual({ [key]: false });
    setAgentEnabled(key, undefined);
    expect(overrides()).toEqual({});
    // With no override, the caller's default governs.
    expect(resolveEnabled(overrides()[key], true)).toBe(true);
  });

  test('a corrupt payload is discarded (treated as no overrides)', () => {
    localStorage.setItem(STORAGE_KEY, '{ not json');
    reloadEnabledAgentsFromStorage();
    // Discarded in memory; the next write starts from empty (no merge with the
    // corrupt bytes) and overwrites storage with clean state.
    setAgentEnabled(desktopEnabledKey('codex'), true);
    expect(overrides()).toEqual({ 'desktop:codex': true });
  });

  test('non-boolean values are dropped, valid ones kept', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ 'desktop:codex': true, 'desktop:cursor': 'yes', 'terminal:pi': 0 }),
    );
    reloadEnabledAgentsFromStorage();
    // A real change flushes the sanitized in-memory map back to storage — the
    // non-boolean 'desktop:cursor'/'terminal:pi' entries never make it back.
    setAgentEnabled('terminal:pi', true);
    expect(overrides()).toEqual({ 'desktop:codex': true, 'terminal:pi': true });
  });
});
