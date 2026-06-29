
export interface SemanticModeState {
  query: string;
  firedQuery: string | null;
  status: 'idle' | 'loading' | 'success' | 'error';
  resultCount: number;
}

type SemanticSubmit = { kind: 'search'; query: string } | { kind: 'retry'; query: string } | null;

export interface SemanticModeView {
  submit: SemanticSubmit;
  results: { show: boolean; dimmed: boolean; forQuery: string | null };
  notice: 'empty' | 'searching' | 'no-results' | null;
}

export function computeSemanticModeView(state: SemanticModeState): SemanticModeView {
  const { query, firedQuery, status, resultCount } = state;
  const hasResults = resultCount > 0;
  const dirty = query !== '' && query !== firedQuery;
  const dimmed = hasResults && (status === 'loading' || query !== firedQuery);

  let submit: SemanticSubmit = null;
  if (status === 'error' && query !== '') {
    submit = { kind: 'retry', query };
  } else if (dirty && status !== 'loading') {
    submit = { kind: 'search', query };
  }

  let notice: SemanticModeView['notice'] = null;
  if (status === 'loading') {
    notice = 'searching';
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
