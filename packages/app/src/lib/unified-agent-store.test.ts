
import { describe, expect, test } from 'bun:test';
import type { HandoffTarget, InstallState } from '@inkeep/open-knowledge-core';
import {
  loadStickyAgent,
  parseStickyCliId,
  resolveStickyAgent,
  saveStickyAgent,
  TERMINAL_CLI_ID,
  terminalCliId,
  UNIFIED_AGENT_KEY,
} from './unified-agent-store';

const LEGACY_BOTTOM_KEY = 'ok-ask-ai-default-agent-v1';
const LEGACY_CREATE_KEY = 'ok-preferred-agent-v1';

function makeStorage(seed?: Record<string, string>) {
  const values = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    map: values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function states(
  overrides: Partial<Record<HandoffTarget, boolean | null>>,
): Record<HandoffTarget, InstallState> {
  const base: Record<HandoffTarget, boolean | null> = {
    'claude-cowork': false,
    'claude-code': false,
    codex: false,
    cursor: false,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(base).map(([id, installed]) => [id, { installed }]),
  ) as Record<HandoffTarget, InstallState>;
}

describe('unified-agent-store — load/save round-trip', () => {
  test('round-trips through the unified key', () => {
    const storage = makeStorage();
    saveStickyAgent('codex', storage);
    expect(storage.map.get(UNIFIED_AGENT_KEY)).toBe('codex');
    expect(loadStickyAgent(storage)).toBe('codex');
  });

  test('the unified key wins over both legacy keys when present', () => {
    const storage = makeStorage({
      [UNIFIED_AGENT_KEY]: 'cursor',
      [LEGACY_BOTTOM_KEY]: 'codex',
      [LEGACY_CREATE_KEY]: 'claude-code',
    });
    expect(loadStickyAgent(storage)).toBe('cursor');
  });
});

describe('unified-agent-store — migration shim (read-both legacy keys)', () => {
  test('migrates a bottom-composer CLI pick (the create key never carried one)', () => {
    const storage = makeStorage({ [LEGACY_BOTTOM_KEY]: terminalCliId('codex') });
    const migrated = loadStickyAgent(storage);
    expect(migrated).toBe('terminal-cli:codex');
    expect(parseStickyCliId(migrated)).toBe('codex');
  });

  test('migrates a create-composer app pick when no bottom pick exists', () => {
    const storage = makeStorage({ [LEGACY_CREATE_KEY]: 'cursor' });
    expect(loadStickyAgent(storage)).toBe('cursor');
  });

  test('prefers the bottom-composer key (CLI-capable) when both legacy keys are set', () => {
    const storage = makeStorage({
      [LEGACY_BOTTOM_KEY]: terminalCliId('claude'),
      [LEGACY_CREATE_KEY]: 'codex',
    });
    expect(parseStickyCliId(loadStickyAgent(storage))).toBe('claude');
  });

  test('a later save lands on the unified key and then wins (one-time migration)', () => {
    const storage = makeStorage({ [LEGACY_CREATE_KEY]: 'codex' });
    expect(loadStickyAgent(storage)).toBe('codex'); // migrated read
    saveStickyAgent('cursor', storage); // user picks again → unified key
    expect(storage.map.get(UNIFIED_AGENT_KEY)).toBe('cursor');
    expect(loadStickyAgent(storage)).toBe('cursor');
  });

  test('returns null when nothing is stored anywhere', () => {
    expect(loadStickyAgent(makeStorage())).toBeNull();
  });
});

describe('unified-agent-store — resolveStickyAgent', () => {
  test('a CLI sentinel resolves to null here (CLIs are not app targets)', () => {
    expect(resolveStickyAgent(states({ codex: true }), terminalCliId('cursor'))?.id).toBe('codex');
  });

  test('honors an installed sticky app target', () => {
    expect(resolveStickyAgent(states({ codex: true, cursor: true }), 'cursor')?.id).toBe('cursor');
  });

  test('falls back to first-installed when the sticky target is uninstalled', () => {
    expect(resolveStickyAgent(states({ 'claude-code': true }), 'cursor')?.id).toBe('claude-code');
  });

  test('returns null when nothing is installed', () => {
    expect(resolveStickyAgent(states({}), 'codex')).toBeNull();
  });
});

describe('terminalCliId / parseStickyCliId', () => {
  test('round-trips each CLI through the per-CLI sentinel', () => {
    for (const cli of ['claude', 'codex', 'cursor'] as const) {
      expect(parseStickyCliId(terminalCliId(cli))).toBe(cli);
    }
  });

  test('the per-CLI sentinel is `terminal-cli:<cli>`', () => {
    expect(terminalCliId('codex')).toBe('terminal-cli:codex');
    expect(terminalCliId('cursor')).toBe('terminal-cli:cursor');
  });

  test('the bare legacy `terminal-cli` sentinel migrates to claude', () => {
    expect(parseStickyCliId(TERMINAL_CLI_ID)).toBe('claude');
  });

  test('a non-CLI id (app target / junk / null) parses to null', () => {
    expect(parseStickyCliId('codex')).toBeNull(); // the app target, not the CLI sentinel
    expect(parseStickyCliId('claude-code')).toBeNull();
    expect(parseStickyCliId('not-a-real-agent')).toBeNull();
    expect(parseStickyCliId(null)).toBeNull();
  });

  test('a per-CLI sticky id round-trips through storage', () => {
    const storage = makeStorage();
    saveStickyAgent(terminalCliId('cursor'), storage);
    expect(loadStickyAgent(storage)).toBe('terminal-cli:cursor');
    expect(parseStickyCliId(loadStickyAgent(storage))).toBe('cursor');
  });

  test('a sticky CLI id is ignored by resolveStickyAgent (it resolves app targets only)', () => {
    const resolved = resolveStickyAgent(states({ codex: true }), terminalCliId('cursor'));
    expect(resolved?.id).toBe('codex');
  });
});
