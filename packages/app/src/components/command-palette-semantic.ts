export const COMMAND_PALETTE_SEARCH_TIMEOUT_MS = 3000;

export interface SemanticModeState {
  query: string;
  firedQuery: string | null;
  status:
    | 'idle'
    | 'loading'
    | 'success'
    | 'error'
    | 'provider_error'
    | 'restart_required'
    | 'incapable'
    | 'query_too_short';
  resultCount: number;
}

type SemanticSubmit = { kind: 'search'; query: string } | { kind: 'retry'; query: string } | null;

export interface SemanticModeView {
  submit: SemanticSubmit;
  results: { show: boolean; dimmed: boolean; forQuery: string | null };
  notice:
    | 'empty'
    | 'searching'
    | 'no-results'
    | 'provider-error'
    | 'restart-required'
    | 'incapable'
    | 'query-too-short'
    | null;
}

export function computeSemanticModeView(state: SemanticModeState): SemanticModeView {
  const { query, firedQuery, status, resultCount } = state;
  const hasResults = resultCount > 0;
  const dirty = query !== '' && query !== firedQuery;
  const dimmed = hasResults && (status === 'loading' || query !== firedQuery);

  let submit: SemanticSubmit = null;
  if ((status === 'error' || status === 'provider_error') && query !== '') {
    submit = { kind: 'retry', query };
  } else if (
    dirty &&
    status !== 'loading' &&
    status !== 'restart_required' &&
    status !== 'incapable'
  ) {
    submit = { kind: 'search', query };
  }

  let notice: SemanticModeView['notice'] = null;
  if (status === 'loading') {
    notice = 'searching';
  } else if (status === 'provider_error' && query === '') {
    notice = 'provider-error';
  } else if (status === 'restart_required') {
    notice = 'restart-required';
  } else if (status === 'incapable') {
    notice = 'incapable';
  } else if (status === 'query_too_short' && !dirty) {
    notice = 'query-too-short';
  } else if (query === '' && !hasResults) {
    notice = 'empty';
  } else if (status === 'success' && !dirty && !hasResults) {
    notice = 'no-results';
  }

  return {
    submit,
    results: { show: hasResults, dimmed, forQuery: hasResults ? firedQuery : null },
    notice,
  };
}
