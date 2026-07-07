/**
 * command-palette-semantic — pure render/action logic for the omnibar's "by
 * meaning" mode.
 *
 * The mode is deliberate-submit, not per-keystroke: typing never embeds; the
 * user presses Enter to fire one semantic search (a paid embed + a query sent to
 * the embeddings provider). To keep that expensive result set from being lost to
 * a stray key, results are sticky — after a fire for query Q they stay visible
 * (dimmed, labeled with Q) while the query is edited, and the default action
 * becomes "re-fire for the new query". Once the query matches Q again the held
 * results are current, so Enter opens the highlighted result instead of
 * re-firing.
 *
 * This module owns ONLY the decision of what to render and what Enter does; the
 * React component holds the state, performs the fetch, and renders the localized
 * copy. Keeping it pure makes every transition unit-pinnable without a DOM
 * (mirrors `computeVisibleSearchResults`).
 */

export interface SemanticModeState {
  /** The trimmed live query in the input. */
  query: string;
  /** The query the held results were fetched for (Q); null before any fire. */
  firedQuery: string | null;
  /** Status of the latest fire. */
  status: 'idle' | 'loading' | 'success' | 'error';
  /** Number of held (sticky) results. */
  resultCount: number;
}

/**
 * The submit/retry affordance — also the action Enter performs while the query
 * is "dirty". `null` when a current result set leads and Enter should open the
 * highlighted result instead of firing.
 */
type SemanticSubmit = { kind: 'search'; query: string } | { kind: 'retry'; query: string } | null;

export interface SemanticModeView {
  /** Submit/retry row to render; also drives whether Enter fires vs opens. */
  submit: SemanticSubmit;
  /** Held results: whether to render, whether to dim (stale), and their query. */
  results: { show: boolean; dimmed: boolean; forQuery: string | null };
  /** A single status line when no row carries the message; else null. */
  notice: 'empty' | 'searching' | 'no-results' | null;
}

/**
 * Resolve what the palette body shows in semantic mode, and what Enter does.
 *
 * - Held results render whenever present, and dim while a fetch is in flight or
 *   the query has moved past them (so a stray key never blanks the set).
 * - A `submit` row appears when Enter should fire (a dirty query) or retry (after
 *   a provider error); it is `null` exactly when a current result set leads, so
 *   Enter opens the highlighted result.
 * - At most one `notice` (type-prompt / searching / no-match) shows when no row
 *   carries the message; the error case is carried by the `retry` submit row.
 */
export function computeSemanticModeView(state: SemanticModeState): SemanticModeView {
  const { query, firedQuery, status, resultCount } = state;
  const hasResults = resultCount > 0;
  // Dirty = there is a query and it differs from what the held results are for.
  // A null firedQuery (nothing fired yet) makes any non-empty query dirty.
  const dirty = query !== '' && query !== firedQuery;
  // Held results are stale while a fetch is in flight or the query has moved on.
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
