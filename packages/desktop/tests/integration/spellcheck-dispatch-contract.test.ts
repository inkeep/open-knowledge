import { describe, expect, test } from 'vitest';
import {
  querySpellingLanguages,
  replaceSpellingLanguages,
  type SpellcheckLanguagesDeps,
  setSpellcheckEnabled,
} from '../../src/main/spellcheck-languages.ts';
import {
  asMenuRendererSnapshot,
  asSpellcheckEnabledSetResult,
  asSpellingLanguagesQueryResult,
  asSpellingLanguagesSetResult,
} from '../../src/shared/menu-dispatch-results.ts';

function mainProcessDeps(): SpellcheckLanguagesDeps {
  let selected = ['en-US'];
  let enabled = true;
  return {
    availableLanguages: () => ['en-US', 'vi'],
    selectedLanguages: () => selected,
    defaultLanguages: () => ['en-US'],
    applyLanguages: (languages) => {
      selected = [...languages];
    },
    isEnabled: () => enabled,
    applyEnabledToEngine: () => {},
    setEnabledAppWide: (next) => {
      enabled = next;
      return true;
    },
  };
}

describe('every spelling operation result survives the renderer-side narrowing', () => {
  test('a read result reaches the renderer as a read result', () => {
    const produced = querySpellingLanguages(mainProcessDeps());

    expect(asSpellingLanguagesQueryResult(produced)).toBe(produced);
  });

  test('a language-replacement result reaches the renderer as a replacement result', () => {
    const produced = replaceSpellingLanguages(mainProcessDeps(), ['en-US', 'vi']);

    expect(asSpellingLanguagesSetResult(produced)).toBe(produced);
  });

  test('an enabled-change result reaches the renderer as an enabled-change result', () => {
    const produced = setSpellcheckEnabled(mainProcessDeps(), false);

    expect(asSpellcheckEnabledSetResult(produced)).toBe(produced);
  });

  test('a rejected language replacement reaches the renderer with its own failure intact', () => {
    const produced = replaceSpellingLanguages(mainProcessDeps(), ['zz-ZZ']);

    expect(asSpellingLanguagesSetResult(produced)).toEqual({
      kind: 'spelling-languages-set',
      ok: false,
      reason: 'unsupported-language',
    });
  });
});

describe('spelling results are never mistaken for a menu snapshot', () => {
  test.each([
    ['read', () => querySpellingLanguages(mainProcessDeps())],
    ['language replacement', () => replaceSpellingLanguages(mainProcessDeps(), ['vi'])],
    ['enabled change', () => setSpellcheckEnabled(mainProcessDeps(), true)],
  ])('a %s result does not narrow to a menu snapshot', (_label, produce) => {
    expect(asMenuRendererSnapshot(produce())).toBeUndefined();
  });

  test('a menu-action reply with no payload narrows to no snapshot', () => {
    expect(asMenuRendererSnapshot(undefined)).toBeUndefined();
  });
});

describe('a reply for the wrong operation is rejected as a protocol mismatch', () => {
  test('an enabled-change reply cannot pose as a read result', () => {
    const produced = setSpellcheckEnabled(mainProcessDeps(), true);

    expect(() => asSpellingLanguagesQueryResult(produced)).toThrow(
      'Spelling IPC protocol mismatch: expected spelling-languages-query',
    );
  });

  test('a read reply cannot pose as a language-replacement result', () => {
    const produced = querySpellingLanguages(mainProcessDeps());

    expect(() => asSpellingLanguagesSetResult(produced)).toThrow(
      'Spelling IPC protocol mismatch: expected spelling-languages-set',
    );
  });

  test('a language-replacement reply cannot pose as an enabled-change result', () => {
    const produced = replaceSpellingLanguages(mainProcessDeps(), ['vi']);

    expect(() => asSpellcheckEnabledSetResult(produced)).toThrow(
      'Spelling IPC protocol mismatch: expected spellcheck-enabled-set',
    );
  });
});
