import { describe, expect, test } from 'bun:test';
import type { HandoffTarget, InstallState } from '@inkeep/open-knowledge-core';
import {
  PREFERRED_AGENT_KEY,
  type PreferredAgentStorage,
  readPreferredAgent,
  resolvePreferredAgent,
  writePreferredAgent,
} from './preferred-agent-store.ts';

/** In-memory storage double — mirrors the seam used by sidebar-pin-store tests. */
function fakeStorage(initial: Record<string, string> = {}): PreferredAgentStorage & {
  map: Record<string, string>;
} {
  const map = { ...initial };
  return {
    map,
    getItem: (key) => map[key] ?? null,
    setItem: (key, value) => {
      map[key] = value;
    },
  };
}

/** Build a full install-state map; unspecified targets read as not-installed. */
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

describe('readPreferredAgent / writePreferredAgent — device-local round-trip', () => {
  test('round-trips a valid visible target', () => {
    const storage = fakeStorage();
    writePreferredAgent('codex', storage);
    expect(readPreferredAgent(storage)).toBe('codex');
  });

  test('returns null when nothing stored', () => {
    expect(readPreferredAgent(fakeStorage())).toBeNull();
  });

  test('rejects an unknown / corrupt stored value (validates against VISIBLE_TARGETS)', () => {
    // A stale id from an older build, or a hand-edited value, must not select a
    // bogus agent — degrade to null so the resolver falls back to Claude.
    expect(readPreferredAgent(fakeStorage({ [PREFERRED_AGENT_KEY]: 'netscape' }))).toBeNull();
  });

  test('rejects claude-cowork — it is in KNOWN_TARGETS but hidden from every UI surface', () => {
    expect(readPreferredAgent(fakeStorage({ [PREFERRED_AGENT_KEY]: 'claude-cowork' }))).toBeNull();
  });

  test('read survives a throwing storage (private mode) by returning null', () => {
    const throwing: PreferredAgentStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
    };
    expect(readPreferredAgent(throwing)).toBeNull();
  });

  test('write survives a throwing storage (quota exceeded) by swallowing silently', () => {
    // chooseAgent / handleCreate persist on every pick + launch; a throwing
    // setItem must never bubble up and break those paths.
    const throwing: PreferredAgentStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => writePreferredAgent('codex', throwing)).not.toThrow();
  });
});

describe('resolvePreferredAgent — installed-only (last-used → first installed → null)', () => {
  test('priority 1: persisted last-used wins when it is installed', () => {
    expect(resolvePreferredAgent({ lastUsed: 'codex', states: states({ codex: true }) })).toBe(
      'codex',
    );
  });

  test('persisted last-used is discarded when not installed here (no dead default)', () => {
    // Saved Cursor on another machine; here Cursor isn't installed but Claude is.
    expect(
      resolvePreferredAgent({
        lastUsed: 'cursor',
        states: states({ 'claude-code': true, cursor: false }),
      }),
    ).toBe('claude-code');
  });

  test('persisted Claude is discarded when Claude Desktop is not installed (no web fallback)', () => {
    // The key behavior: an uninstalled agent is never returned.
    expect(
      resolvePreferredAgent({ lastUsed: 'claude-code', states: states({ 'claude-code': false }) }),
    ).toBeNull();
  });

  test('priority 2: no usable last-used → first installed in VISIBLE_TARGETS order (Claude first)', () => {
    expect(
      resolvePreferredAgent({
        lastUsed: null,
        states: states({ 'claude-code': true, codex: true }),
      }),
    ).toBe('claude-code');
  });

  test('priority 2: Claude absent → first installed other (the infer-from-install win)', () => {
    expect(
      resolvePreferredAgent({
        lastUsed: null,
        states: states({ 'claude-code': false, codex: true }),
      }),
    ).toBe('codex');
  });

  test('priority 2: Claude absent + two others installed → first in order (codex before cursor)', () => {
    expect(
      resolvePreferredAgent({
        lastUsed: null,
        states: states({ 'claude-code': false, codex: true, cursor: true }),
      }),
    ).toBe('codex');
  });

  test('priority 3: nothing installed → null (composer renders the disabled "no agents" state)', () => {
    expect(resolvePreferredAgent({ lastUsed: null, states: states({}) })).toBeNull();
  });
});
