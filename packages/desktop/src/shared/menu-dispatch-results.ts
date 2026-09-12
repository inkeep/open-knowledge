import type {
  OkMenuDispatchResult,
  OkMenuRendererSnapshot,
  OkSpellcheckEnabledSetResult,
  OkSpellingLanguagesQueryResult,
  OkSpellingLanguagesSetResult,
} from '@inkeep/open-knowledge-core/desktop-bridge';

export function asMenuRendererSnapshot(
  result: OkMenuDispatchResult,
): OkMenuRendererSnapshot | undefined {
  if (result == null || 'kind' in result) return undefined;
  return result;
}

export function asSpellingLanguagesQueryResult(
  result: OkMenuDispatchResult,
): OkSpellingLanguagesQueryResult {
  if (result != null && 'kind' in result && result.kind === 'spelling-languages-query') {
    return result;
  }
  const error = new Error('Spelling IPC protocol mismatch: expected spelling-languages-query');
  console.warn('[spellcheck] IPC protocol mismatch', error);
  throw error;
}

export function asSpellingLanguagesSetResult(
  result: OkMenuDispatchResult,
): OkSpellingLanguagesSetResult {
  if (result != null && 'kind' in result && result.kind === 'spelling-languages-set') {
    return result;
  }
  const error = new Error('Spelling IPC protocol mismatch: expected spelling-languages-set');
  console.warn('[spellcheck] IPC protocol mismatch', error);
  throw error;
}

export function asSpellcheckEnabledSetResult(
  result: OkMenuDispatchResult,
): OkSpellcheckEnabledSetResult {
  if (result != null && 'kind' in result && result.kind === 'spellcheck-enabled-set') {
    return result;
  }
  const error = new Error('Spelling IPC protocol mismatch: expected spellcheck-enabled-set');
  console.warn('[spellcheck] IPC protocol mismatch', error);
  throw error;
}
