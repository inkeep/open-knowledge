import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  isLintConfigViewMode,
  LINT_CONFIG_VIEW_MODES,
  type LintConfigViewMode,
  persistViewMode,
  readPersistedViewMode,
} from './useLintConfigViewMode';

interface FakeStorage {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
}

function storageWith(value: string | null): FakeStorage {
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn(() => undefined),
  };
}

function storageThatThrowsOnGet(err: Error = new Error('privacy mode')): FakeStorage {
  return {
    getItem: vi.fn(() => {
      throw err;
    }),
    setItem: vi.fn(() => undefined),
  };
}

function storageThatThrowsOnSet(err: Error = new Error('quota exceeded')): FakeStorage {
  return {
    getItem: vi.fn(() => null),
    setItem: vi.fn(() => {
      throw err;
    }),
  };
}

describe('isLintConfigViewMode — type guard', () => {
  test("accepts 'source'", () => {
    expect(isLintConfigViewMode('source')).toBe(true);
  });

  test("accepts 'rules'", () => {
    expect(isLintConfigViewMode('rules')).toBe(true);
  });

  test("rejects 'wysiwyg' (the doc editor's value, not a config view mode)", () => {
    expect(isLintConfigViewMode('wysiwyg')).toBe(false);
  });

  test('rejects other strings (garbage, case-mismatch)', () => {
    expect(isLintConfigViewMode('garbage')).toBe(false);
    expect(isLintConfigViewMode('Source')).toBe(false);
    expect(isLintConfigViewMode('RULES')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isLintConfigViewMode('')).toBe(false);
  });

  test('rejects null, undefined, numbers, objects', () => {
    expect(isLintConfigViewMode(null)).toBe(false);
    expect(isLintConfigViewMode(undefined)).toBe(false);
    expect(isLintConfigViewMode(0)).toBe(false);
    expect(isLintConfigViewMode({})).toBe(false);
  });

  test('every LINT_CONFIG_VIEW_MODES entry is accepted by the guard', () => {
    for (const value of LINT_CONFIG_VIEW_MODES) {
      expect(isLintConfigViewMode(value)).toBe(true);
    }
  });

  test('LINT_CONFIG_VIEW_MODES contains exactly the current mode set', () => {
    expect([...LINT_CONFIG_VIEW_MODES].sort()).toEqual(['rules', 'source']);
  });
});

describe('readPersistedViewMode — localStorage read with validation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
  });

  test("returns 'source' when storage is empty (default fallback)", () => {
    const storage = storageWith(null);
    expect(readPersistedViewMode(storage)).toBe('source');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("returns 'rules' when storage holds 'rules' (round-trip)", () => {
    const storage = storageWith('rules');
    expect(readPersistedViewMode(storage)).toBe('rules');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("returns 'source' when storage holds 'source'", () => {
    const storage = storageWith('source');
    expect(readPersistedViewMode(storage)).toBe('source');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("falls back to 'source' when storage holds an invalid value", () => {
    const storage = storageWith('garbage');
    expect(readPersistedViewMode(storage)).toBe('source');
  });

  test('logs a diagnostic warn on an invalid persisted value', () => {
    const storage = storageWith('garbage-from-tampering-or-old-schema');
    expect(readPersistedViewMode(storage)).toBe('source');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstCall = warnSpy?.mock.calls[0];
    expect(firstCall?.[0]).toBe(
      '[lint-config-view-mode] invalid persisted value, falling back to default',
    );
    expect(firstCall?.[1]).toMatchObject({ raw: 'garbage-from-tampering-or-old-schema' });
  });

  test("falls back to 'source' AND warns when storage holds 'wysiwyg'", () => {
    const storage = storageWith('wysiwyg');
    expect(readPersistedViewMode(storage)).toBe('source');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("returns 'source' and swallows SILENTLY when getItem throws (privacy mode)", () => {
    const storage = storageThatThrowsOnGet();
    expect(readPersistedViewMode(storage)).toBe('source');
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('reads exactly once per call (no redundant storage access)', () => {
    const storage = storageWith('rules');
    readPersistedViewMode(storage);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
  });

  test("reads from 'ok-lint-config-view-mode-v1', never the doc editor's key", () => {
    const storage = storageWith(null);
    readPersistedViewMode(storage);
    expect(storage.getItem).toHaveBeenCalledWith('ok-lint-config-view-mode-v1');
    expect(storage.getItem).not.toHaveBeenCalledWith('ok-editor-mode-v1');
  });
});

describe('persistViewMode — localStorage write with error swallow', () => {
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
  });

  test("writes 'rules' to storage under the correct key", () => {
    const storage = storageWith(null);
    const ok = persistViewMode('rules', storage);
    expect(ok).toBe(true);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith('ok-lint-config-view-mode-v1', 'rules');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("writes 'source' under 'ok-lint-config-view-mode-v1', never the doc editor's key", () => {
    const storage = storageWith(null);
    const ok = persistViewMode('source', storage);
    expect(ok).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith('ok-lint-config-view-mode-v1', 'source');
    expect(storage.setItem).not.toHaveBeenCalledWith('ok-editor-mode-v1', 'source');
  });

  test('returns false and logs warn when setItem throws (quota / privacy mode)', () => {
    const storage = storageThatThrowsOnSet();
    const ok = persistViewMode('source', storage);
    expect(ok).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstCall = warnSpy?.mock.calls[0];
    expect(firstCall?.[0]).toBe('[lint-config-view-mode] persist failed');
    expect(firstCall?.[1]).toBeInstanceOf(Error);
  });

  test('write throw is fully swallowed — caller never sees the exception', () => {
    const storage = storageThatThrowsOnSet();
    expect(() => persistViewMode('source', storage)).not.toThrow();
  });
});

describe('module exports — type-level shape', () => {
  test('LINT_CONFIG_VIEW_MODES keeps its `as const` tuple shape (runtime readonly)', () => {
    const values: readonly LintConfigViewMode[] = LINT_CONFIG_VIEW_MODES;
    expect(values).toHaveLength(2);
  });
});
