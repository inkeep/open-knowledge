import { describe, expect, test } from 'vitest';
import { computeSemanticModeView, type SemanticModeState } from './command-palette-semantic';

function view(over: Partial<SemanticModeState>) {
  return computeSemanticModeView({
    query: '',
    firedQuery: null,
    status: 'idle',
    resultCount: 0,
    ...over,
  });
}

describe('computeSemanticModeView', () => {
  test('just entered, empty query: prompts to type, no submit, no results', () => {
    expect(view({})).toEqual({
      submit: null,
      results: { show: false, dimmed: false, forQuery: null },
      notice: 'empty',
    });
  });

  test('query typed, nothing fired: offers a search submit (Enter fires)', () => {
    expect(view({ query: 'auth retries' })).toEqual({
      submit: { kind: 'search', query: 'auth retries' },
      results: { show: false, dimmed: false, forQuery: null },
      notice: null,
    });
  });

  test('loading the first fire: spinner, no submit, no results', () => {
    expect(view({ query: 'auth retries', status: 'loading' })).toEqual({
      submit: null,
      results: { show: false, dimmed: false, forQuery: null },
      notice: 'searching',
    });
  });

  test('loading a re-fire: prior results stay, dimmed + labeled, spinner', () => {
    expect(
      view({ query: 'auth retries', firedQuery: 'sessions', status: 'loading', resultCount: 5 }),
    ).toEqual({
      submit: null,
      results: { show: true, dimmed: true, forQuery: 'sessions' },
      notice: 'searching',
    });
  });

  test('clean success (query matches fired): results lead, no submit, Enter opens', () => {
    expect(
      view({
        query: 'auth retries',
        firedQuery: 'auth retries',
        status: 'success',
        resultCount: 7,
      }),
    ).toEqual({
      submit: null,
      results: { show: true, dimmed: false, forQuery: 'auth retries' },
      notice: null,
    });
  });

  test('clean success with zero matches: no-match notice, no submit', () => {
    expect(
      view({
        query: 'auth retries',
        firedQuery: 'auth retries',
        status: 'success',
        resultCount: 0,
      }),
    ).toEqual({
      submit: null,
      results: { show: false, dimmed: false, forQuery: null },
      notice: 'no-results',
    });
  });

  test('dirty after success: submit row leads (Enter re-fires), prior results dimmed + labeled', () => {
    expect(
      view({
        query: 'token refresh',
        firedQuery: 'auth retries',
        status: 'success',
        resultCount: 7,
      }),
    ).toEqual({
      submit: { kind: 'search', query: 'token refresh' },
      results: { show: true, dimmed: true, forQuery: 'auth retries' },
      notice: null,
    });
  });

  test('error on the first fire: a retry row (Enter retries), no held results', () => {
    expect(view({ query: 'auth retries', status: 'error' })).toEqual({
      submit: { kind: 'retry', query: 'auth retries' },
      results: { show: false, dimmed: false, forQuery: null },
      notice: null,
    });
  });

  test('error on a re-fire: retry row + prior results retained, dimmed + labeled', () => {
    expect(
      view({ query: 'token refresh', firedQuery: 'auth retries', status: 'error', resultCount: 7 }),
    ).toEqual({
      submit: { kind: 'retry', query: 'token refresh' },
      results: { show: true, dimmed: true, forQuery: 'auth retries' },
      notice: null,
    });
  });

  test('clearing the query after a fire keeps the held results dimmed, no submit', () => {
    expect(
      view({ query: '', firedQuery: 'auth retries', status: 'success', resultCount: 7 }),
    ).toEqual({
      submit: null,
      results: { show: true, dimmed: true, forQuery: 'auth retries' },
      notice: null,
    });
  });

  test('clearing the query DURING a re-fire keeps the held results dimmed, spinner showing', () => {
    expect(
      view({ query: '', firedQuery: 'auth retries', status: 'loading', resultCount: 7 }),
    ).toEqual({
      submit: null,
      results: { show: true, dimmed: true, forQuery: 'auth retries' },
      notice: 'searching',
    });
  });

  test('clearing the query after an error keeps the held results dimmed, no retry row', () => {
    expect(
      view({ query: '', firedQuery: 'auth retries', status: 'error', resultCount: 7 }),
    ).toEqual({
      submit: null,
      results: { show: true, dimmed: true, forQuery: 'auth retries' },
      notice: null,
    });
  });
});
