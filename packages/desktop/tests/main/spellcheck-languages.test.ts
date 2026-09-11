import { describe, expect, test } from 'vitest';
import {
  querySpellingLanguages,
  replaceSpellingLanguages,
  type SpellcheckLanguagesDeps,
  type SpellcheckLanguagesOperation,
  setSpellcheckEnabled,
} from '../../src/main/spellcheck-languages.ts';

interface FakeEngine {
  readonly deps: SpellcheckLanguagesDeps;
  selected: string[];
  enabled: boolean;
  engineEnabled: boolean;
  saved: boolean;
  savedState: boolean | null;
}

function fakeEngine(
  overrides: {
    available?: string[];
    selected?: string[];
    defaults?: string[];
    enabled?: boolean;
    saveSucceeds?: boolean;
    throwOn?: 'available' | 'selected' | 'apply-languages' | 'set-enabled';
  } = {},
): FakeEngine {
  const available = overrides.available ?? ['en-US', 'vi', 'fr'];
  const state = {
    selected: [...(overrides.selected ?? ['en-US'])],
    enabled: overrides.enabled ?? true,
    engineEnabled: overrides.enabled ?? true,
    saved: overrides.saveSucceeds ?? true,
    savedState: null as boolean | null,
  };
  const fail = (which: string) => {
    if (overrides.throwOn === which) throw new Error(`engine failure: ${which}`);
  };
  const engine: FakeEngine = {
    ...state,
    deps: {
      availableLanguages: () => {
        fail('available');
        return available;
      },
      selectedLanguages: () => {
        fail('selected');
        return engine.selected;
      },
      defaultLanguages: () => overrides.defaults ?? ['en-US'],
      applyLanguages: (languages) => {
        fail('apply-languages');
        engine.selected = [...languages];
        engine.engineEnabled = true;
      },
      isEnabled: () => engine.enabled,
      applyEnabledToEngine: (enabled) => {
        engine.engineEnabled = enabled;
      },
      setEnabledAppWide: (enabled) => {
        fail('set-enabled');
        engine.engineEnabled = enabled;
        engine.enabled = enabled;
        engine.savedState = engine.saved ? enabled : null;
        return engine.saved;
      },
    },
  };
  return engine;
}

describe('reading the spelling-language preference', () => {
  test('reports the system default separately from a saved selection and resetting preserves off', () => {
    const engine = fakeEngine({ defaults: ['fr'], selected: ['en-US', 'vi'], enabled: false });
    const result = querySpellingLanguages(engine.deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('language query failed');
    expect(result.state.defaults).toEqual(['fr']);
    expect(engine.selected).toEqual(['en-US', 'vi']);

    const reset = replaceSpellingLanguages(engine.deps, result.state.defaults);
    expect(reset.ok).toBe(true);
    expect(engine.selected).toEqual(['fr']);
    expect(engine.engineEnabled).toBe(false);
  });
  test('reports the engine selection and the supported list without changing either', () => {
    const engine = fakeEngine({ available: ['en-US', 'vi'], selected: ['vi'] });

    const result = querySpellingLanguages(engine.deps);

    expect(result).toEqual({
      kind: 'spelling-languages-query',
      ok: true,
      state: { available: ['en-US', 'vi'], selected: ['vi'], defaults: ['en-US'] },
    });
    expect(engine.selected).toEqual(['vi']);
    expect(engine.engineEnabled).toBe(true);
  });

  test('a failing engine read surfaces a presentable failure instead of invented values', () => {
    const engine = fakeEngine({ throwOn: 'selected' });
    const reported: SpellcheckLanguagesOperation[] = [];

    const result = querySpellingLanguages({
      ...engine.deps,
      reportFailure: (operation) => reported.push(operation),
    });

    expect(result).toEqual({
      kind: 'spelling-languages-query',
      ok: false,
      reason: 'engine-error',
    });
    expect(reported).toEqual(['query']);
  });
});

describe('replacing the checking-language selection', () => {
  test.each([undefined, null, 'vi', 0, ['vi', null], ['vi', 1]])(
    'a malformed language payload %j is rejected without changing the selection',
    (languages) => {
      const engine = fakeEngine({ selected: ['vi'], enabled: false });

      const result = replaceSpellingLanguages(engine.deps, languages);

      expect(result).toEqual({
        kind: 'spelling-languages-set',
        ok: false,
        reason: 'invalid-request',
      });
      expect(engine.selected).toEqual(['vi']);
      expect(engine.engineEnabled).toBe(false);
    },
  );

  test('a supported multi-language selection is applied and reported back', () => {
    const engine = fakeEngine({ available: ['en-US', 'vi', 'fr'], selected: ['en-US'] });

    const result = replaceSpellingLanguages(engine.deps, ['en-US', 'vi']);

    expect(result).toEqual({
      kind: 'spelling-languages-set',
      ok: true,
      state: { available: ['en-US', 'vi', 'fr'], selected: ['en-US', 'vi'], defaults: ['en-US'] },
    });
    expect(engine.selected).toEqual(['en-US', 'vi']);
  });

  test.each([true, false])(
    'duplicate languages are applied once while enabled is %s',
    (enabled) => {
      const engine = fakeEngine({ enabled });

      const result = replaceSpellingLanguages(engine.deps, ['vi', 'en-US', 'vi', 'en-US']);

      expect(result).toEqual({
        kind: 'spelling-languages-set',
        ok: true,
        state: { available: ['en-US', 'vi', 'fr'], selected: ['vi', 'en-US'], defaults: ['en-US'] },
      });
      expect(engine.selected).toEqual(['vi', 'en-US']);
      expect(engine.enabled).toBe(enabled);
      expect(engine.engineEnabled).toBe(enabled);
    },
  );

  test('writing languages while checking is off leaves checking off', () => {
    const engine = fakeEngine({ available: ['en-US', 'vi'], selected: ['en-US'], enabled: false });

    const result = replaceSpellingLanguages(engine.deps, ['en-US', 'vi']);

    expect(result.ok).toBe(true);
    expect(engine.engineEnabled).toBe(false);
    expect(engine.enabled).toBe(false);
    expect(engine.selected).toEqual(['en-US', 'vi']);
  });

  test('an unsupported language code is rejected and nothing changes', () => {
    const engine = fakeEngine({ available: ['en-US', 'vi'], selected: ['en-US'], enabled: false });

    const result = replaceSpellingLanguages(engine.deps, ['en-US', 'zz-ZZ']);

    expect(result).toEqual({
      kind: 'spelling-languages-set',
      ok: false,
      reason: 'unsupported-language',
    });
    expect(engine.selected).toEqual(['en-US']);
    expect(engine.enabled).toBe(false);
    expect(engine.engineEnabled).toBe(false);
  });

  test('an empty value in the selection is rejected and nothing changes', () => {
    const engine = fakeEngine({ available: ['en-US', 'vi'], selected: ['vi'] });

    const result = replaceSpellingLanguages(engine.deps, ['vi', '']);

    expect(result).toEqual({
      kind: 'spelling-languages-set',
      ok: false,
      reason: 'unsupported-language',
    });
    expect(engine.selected).toEqual(['vi']);
  });

  test('an empty selection is rejected rather than treated as a way to disable checking', () => {
    const engine = fakeEngine({ selected: ['vi'], enabled: true });

    const result = replaceSpellingLanguages(engine.deps, []);

    expect(result).toEqual({
      kind: 'spelling-languages-set',
      ok: false,
      reason: 'empty-selection',
    });
    expect(engine.selected).toEqual(['vi']);
    expect(engine.enabled).toBe(true);
  });

  test('an engine that rejects the write surfaces a presentable failure', () => {
    const engine = fakeEngine({
      available: ['en-US', 'vi'],
      selected: ['en-US'],
      throwOn: 'apply-languages',
    });
    const reported: SpellcheckLanguagesOperation[] = [];

    const result = replaceSpellingLanguages(
      { ...engine.deps, reportFailure: (operation) => reported.push(operation) },
      ['en-US', 'vi'],
    );

    expect(result).toEqual({
      kind: 'spelling-languages-set',
      ok: false,
      reason: 'engine-error',
    });
    expect(engine.selected).toEqual(['en-US']);
    expect(reported).toEqual(['set-languages']);
  });
});

describe('setting the shared spellcheck enabled value', () => {
  test.each([undefined, null, 0, 1, 'false', {}])(
    'rejects a non-Boolean enabled value %j without changing the preference',
    (enabled) => {
      const engine = fakeEngine({ enabled: true });

      const result = setSpellcheckEnabled(engine.deps, enabled);

      expect(result).toEqual({
        kind: 'spellcheck-enabled-set',
        ok: false,
        reason: 'invalid-request',
      });
      expect(engine.enabled).toBe(true);
      expect(engine.engineEnabled).toBe(true);
      expect(engine.savedState).toBeNull();
    },
  );

  test('applies the requested value and reports that it was saved durably', () => {
    const engine = fakeEngine({ enabled: true });

    const result = setSpellcheckEnabled(engine.deps, false);

    expect(result).toEqual({
      kind: 'spellcheck-enabled-set',
      ok: true,
      enabled: false,
      saved: true,
    });
    expect(engine.engineEnabled).toBe(false);
    expect(engine.savedState).toBe(false);
  });

  test('requesting on while the caller believed it was off leaves checking on', () => {
    const engine = fakeEngine({ enabled: true });

    const result = setSpellcheckEnabled(engine.deps, true);

    expect(result).toMatchObject({ ok: true, enabled: true });
    expect(engine.enabled).toBe(true);
    expect(engine.engineEnabled).toBe(true);
  });

  test('a failed durable save is reported while the applied runtime value is reflected', () => {
    const engine = fakeEngine({ enabled: false, saveSucceeds: false });

    const result = setSpellcheckEnabled(engine.deps, true);

    expect(result).toEqual({
      kind: 'spellcheck-enabled-set',
      ok: true,
      enabled: true,
      saved: false,
    });
    expect(engine.engineEnabled).toBe(true);
    expect(engine.savedState).toBeNull();
  });

  test('an engine that rejects the change surfaces a presentable failure', () => {
    const engine = fakeEngine({ enabled: true, throwOn: 'set-enabled' });
    const reported: SpellcheckLanguagesOperation[] = [];

    const result = setSpellcheckEnabled(
      { ...engine.deps, reportFailure: (operation) => reported.push(operation) },
      false,
    );

    expect(result).toEqual({
      kind: 'spellcheck-enabled-set',
      ok: false,
      reason: 'engine-error',
    });
    expect(engine.enabled).toBe(true);
    expect(reported).toEqual(['set-enabled']);
  });
});
