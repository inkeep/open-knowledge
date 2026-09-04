import { beforeEach, describe, expect, test } from 'vitest';

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
  agentSettingsKey,
  getRememberedAgentConfig,
  getRememberedAgentMode,
  rememberAgentConfigOption,
  rememberAgentMode,
} from './agent-settings-store';

const STORAGE_KEY = 'ok-acp-agent-settings-v1';

beforeEach(() => localStorage.clear());

describe('agent-settings-store', () => {
  test('agentSettingsKey matches the registered-agents <source>:<id> shape', () => {
    expect(agentSettingsKey({ source: 'registry', id: 'claude-acp' })).toBe('registry:claude-acp');
    expect(agentSettingsKey({ source: 'custom', id: 'x' })).toBe('custom:x');
  });

  test('nothing stored → undefined', () => {
    expect(getRememberedAgentConfig('registry:claude-acp')).toBeUndefined();
  });

  test('remembers config options per agent type', () => {
    const key = agentSettingsKey({ source: 'registry', id: 'claude-acp' });
    rememberAgentConfigOption(key, 'model', 'opus');
    rememberAgentConfigOption(key, 'thought_level', 'xhigh');
    rememberAgentConfigOption(key, 'verbose', true);
    expect(getRememberedAgentConfig(key)).toEqual({
      model: 'opus',
      thought_level: 'xhigh',
      verbose: true,
    });
  });

  test('a later pick overwrites the same option, keeps the others', () => {
    const key = agentSettingsKey({ source: 'custom', id: 'a' });
    rememberAgentConfigOption(key, 'model', 'sonnet');
    rememberAgentConfigOption(key, 'model', 'opus');
    rememberAgentConfigOption(key, 'thought_level', 'high');
    expect(getRememberedAgentConfig(key)).toEqual({ model: 'opus', thought_level: 'high' });
  });

  test('keeps agent types isolated', () => {
    const a = agentSettingsKey({ source: 'registry', id: 'claude-acp' });
    const b = agentSettingsKey({ source: 'registry', id: 'codex' });
    rememberAgentConfigOption(a, 'model', 'opus');
    rememberAgentConfigOption(b, 'model', 'gpt-5');
    expect(getRememberedAgentConfig(a)).toEqual({ model: 'opus' });
    expect(getRememberedAgentConfig(b)).toEqual({ model: 'gpt-5' });
  });

  test('a corrupt payload reads as empty and does not throw', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(getRememberedAgentConfig('registry:x')).toBeUndefined();
    rememberAgentConfigOption('registry:x', 'model', 'opus');
    expect(getRememberedAgentConfig('registry:x')).toEqual({ model: 'opus' });
  });

  test('drops non-primitive values from a tampered payload', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ 'registry:x': { config: { model: 'opus', bad: { nested: 1 } } } }),
    );
    expect(getRememberedAgentConfig('registry:x')).toEqual({ model: 'opus' });
  });

  test('a legacy-surface mode is remembered alongside config, not instead of it', () => {
    const key = agentSettingsKey({ source: 'registry', id: 'claude-acp' });
    expect(getRememberedAgentMode(key)).toBeUndefined();
    rememberAgentConfigOption(key, 'model', 'opus');
    rememberAgentMode(key, 'bypass');
    expect(getRememberedAgentConfig(key)).toEqual({ model: 'opus' });
    expect(getRememberedAgentMode(key)).toBe('bypass');
  });

  test('a later mode pick overwrites the earlier one', () => {
    const key = agentSettingsKey({ source: 'custom', id: 'b' });
    rememberAgentMode(key, 'plan');
    rememberAgentMode(key, 'bypass');
    expect(getRememberedAgentMode(key)).toBe('bypass');
  });

  test('a mode saved by the previous release is still honoured', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ 'registry:x': { config: { model: 'opus' }, modeId: 'bypass' } }),
    );
    expect(getRememberedAgentMode('registry:x')).toBe('bypass');
    expect(getRememberedAgentConfig('registry:x')).toEqual({ model: 'opus' });
  });

  test('a retired field from the previous shape is ignored, not fatal', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ 'registry:x': { lastModeId: 'bypass', config: { model: 'opus' } } }),
    );
    expect(getRememberedAgentMode('registry:x')).toBeUndefined();
    expect(getRememberedAgentConfig('registry:x')).toEqual({ model: 'opus' });
    rememberAgentMode('registry:x', 'plan');
    expect(getRememberedAgentMode('registry:x')).toBe('plan');
  });
});
