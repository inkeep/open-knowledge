import type {
  OkSpellcheckEnabledSetResult,
  OkSpellingLanguagesQueryResult,
  OkSpellingLanguagesSetResult,
  OkSpellingLanguagesState,
} from '@inkeep/open-knowledge-core/desktop-bridge';

export type SpellcheckLanguagesOperation = 'query' | 'set-languages' | 'set-enabled';

export interface SpellcheckLanguagesDeps {
  readonly availableLanguages: () => readonly string[];
  readonly selectedLanguages: () => readonly string[];
  readonly defaultLanguages: () => readonly string[];
  readonly applyLanguages: (languages: readonly string[]) => void;
  readonly isEnabled: () => boolean;
  readonly applyEnabledToEngine: (enabled: boolean) => void;
  readonly setEnabledAppWide: (enabled: boolean) => boolean;
  readonly reportFailure?: (operation: SpellcheckLanguagesOperation, err: unknown) => void;
}

function readState(deps: SpellcheckLanguagesDeps): OkSpellingLanguagesState {
  return {
    available: [...deps.availableLanguages()],
    selected: [...deps.selectedLanguages()],
    defaults: [...deps.defaultLanguages()],
  };
}

export function querySpellingLanguages(
  deps: SpellcheckLanguagesDeps,
): OkSpellingLanguagesQueryResult {
  try {
    return { kind: 'spelling-languages-query', ok: true, state: readState(deps) };
  } catch (err) {
    deps.reportFailure?.('query', err);
    return { kind: 'spelling-languages-query', ok: false, reason: 'engine-error' };
  }
}

export function replaceSpellingLanguages(
  deps: SpellcheckLanguagesDeps,
  languages: unknown,
): OkSpellingLanguagesSetResult {
  if (!Array.isArray(languages) || !languages.every((code) => typeof code === 'string')) {
    return { kind: 'spelling-languages-set', ok: false, reason: 'invalid-request' };
  }
  if (languages.length === 0) {
    return { kind: 'spelling-languages-set', ok: false, reason: 'empty-selection' };
  }
  try {
    const selected = [...new Set(languages)];
    const available = deps.availableLanguages();
    if (!selected.every((code) => available.includes(code))) {
      return { kind: 'spelling-languages-set', ok: false, reason: 'unsupported-language' };
    }
    const enabledBeforeWrite = deps.isEnabled();
    deps.applyLanguages(selected);
    deps.applyEnabledToEngine(enabledBeforeWrite);
    return { kind: 'spelling-languages-set', ok: true, state: readState(deps) };
  } catch (err) {
    deps.reportFailure?.('set-languages', err);
    return { kind: 'spelling-languages-set', ok: false, reason: 'engine-error' };
  }
}

export function setSpellcheckEnabled(
  deps: SpellcheckLanguagesDeps,
  enabled: unknown,
): OkSpellcheckEnabledSetResult {
  if (typeof enabled !== 'boolean') {
    return { kind: 'spellcheck-enabled-set', ok: false, reason: 'invalid-request' };
  }
  try {
    const saved = deps.setEnabledAppWide(enabled);
    return { kind: 'spellcheck-enabled-set', ok: true, enabled: deps.isEnabled(), saved };
  } catch (err) {
    deps.reportFailure?.('set-enabled', err);
    return { kind: 'spellcheck-enabled-set', ok: false, reason: 'engine-error' };
  }
}
