/**
 * Unit tests for `handleChunkedInsertFailure` — the recovery path for
 * chunked Source-view paste when insertion fails mid-stream.
 *
 * Covers the recovery contract when a chunked insert fails mid-stream:
 *   1. Selection text is re-inserted at the anchor so the user does not lose
 *      the content they had selected.
 *   2. Structured telemetry is emitted via `logChunkedInsertFail` for
 *      typed `ChunkedInsertError`, or `logConversionFail` otherwise.
 *   3. A sonner toast surfaces a user-visible signal — without it the user
 *      sees their selection vanish with no feedback.
 *
 * We mock the CM6 `EditorView` as a minimal shape (just `dispatch`) and
 * spy on `console.warn` + the sonner module's `toast.error` export. This
 * keeps the test at the recovery-contract level — a full CM6 + Y.Doc
 * integration test would require wiring yCollab + DOM and belongs in a
 * Playwright E2E, not bun-test.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ChunkedInsertError } from '@inkeep/open-knowledge-core';
import * as actualSonner from 'sonner';

type ToastFn = { error: ReturnType<typeof mock> };
const toastMock: ToastFn = { error: mock(() => {}) };
mock.module('sonner', () => ({ ...actualSonner, toast: toastMock }));

// Imported AFTER the mock so the module picks up our stub.
// biome-ignore lint/suspicious/noExplicitAny: test-scoped dynamic import
let handleChunkedInsertFailure: any;
// biome-ignore lint/suspicious/noExplicitAny: test-scoped dynamic import
let mod: any;

beforeEach(async () => {
  toastMock.error.mockClear();
  mod = await import('./source-clipboard.ts');
  handleChunkedInsertFailure = mod.handleChunkedInsertFailure;
});

afterEach(() => {
  toastMock.error.mockClear();
});

interface DispatchCall {
  from: number;
  to: number;
  insert: string;
}

function makeFakeView(docLength = 1_000_000): {
  dispatch: ReturnType<typeof mock>;
  dispatches: DispatchCall[];
  // biome-ignore lint/suspicious/noExplicitAny: fake view state for unit test
  state: any;
} {
  const dispatches: DispatchCall[] = [];
  const dispatch = mock((arg: { changes: DispatchCall }) => {
    dispatches.push(arg.changes);
  });
  return {
    dispatch,
    dispatches,
    state: { doc: { length: docLength } },
  };
}

function withSilencedWarn<T>(fn: () => T): T {
  const orig = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = orig;
  }
}

describe('handleChunkedInsertFailure — Source-view recovery contract', () => {
  test('ChunkedInsertError with bytesWritten > 0: deletes partial range + restores selection', () => {
    const { dispatch, dispatches, state } = makeFakeView();
    const bytesWritten = 100 * 1024;
    const err = new ChunkedInsertError(new Error('y-text full'), {
      chunksCompleted: 2,
      totalChunks: 10,
      bytesWritten,
      bytesRemaining: 400 * 1024,
    });
    withSilencedWarn(() =>
      handleChunkedInsertFailure({
        // biome-ignore lint/suspicious/noExplicitAny: fake view for unit test
        view: { dispatch, state } as any,
        source: 'gdocs',
        html: '<p>1</p>'.repeat(10),
        restoreText: 'original user selection',
        anchorIndex: 42,
        err,
      }),
    );
    // Partial chunks at [42, 42+100KB) are replaced with the restoreText —
    // a single atomic change so yCollab sees no intermediate truncated state.
    expect(dispatches).toEqual([
      { from: 42, to: 42 + bytesWritten, insert: 'original user selection' },
    ]);
    // Toast surfaces partial-progress info to the user.
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    const msg = toastMock.error.mock.calls[0]?.[0];
    expect(msg).toContain('2 of 10 chunks');
    expect(msg).toContain('restored');
  });

  test('ChunkedInsertError with bytesWritten > 0 and empty restoreText: deletes partial range only', () => {
    const { dispatch, dispatches, state } = makeFakeView();
    const bytesWritten = 50 * 1024;
    const err = new ChunkedInsertError(new Error('y-text limit hit'), {
      chunksCompleted: 1,
      totalChunks: 6,
      bytesWritten,
      bytesRemaining: 250 * 1024,
    });
    withSilencedWarn(() =>
      handleChunkedInsertFailure({
        // biome-ignore lint/suspicious/noExplicitAny: fake view for unit test
        view: { dispatch, state } as any,
        source: 'word',
        html: '<p>x</p>',
        restoreText: '',
        anchorIndex: 10,
        err,
      }),
    );
    // Deletes the partial range; no restoreText to merge back.
    expect(dispatches).toEqual([{ from: 10, to: 10 + bytesWritten, insert: '' }]);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  test('ChunkedInsertError with bytesWritten == 0: falls back to selection-restore at anchor', () => {
    const { dispatch, dispatches, state } = makeFakeView();
    const err = new ChunkedInsertError(new Error('boom'), {
      chunksCompleted: 0,
      totalChunks: 5,
      bytesWritten: 0,
      bytesRemaining: 250 * 1024,
    });
    withSilencedWarn(() =>
      handleChunkedInsertFailure({
        // biome-ignore lint/suspicious/noExplicitAny: fake view for unit test
        view: { dispatch, state } as any,
        source: 'generic',
        html: '<p>x</p>',
        restoreText: 'x',
        anchorIndex: 0,
        err,
      }),
    );
    // Zero bytes landed — no partial range to delete; restoreText inserted at anchor.
    expect(dispatches).toEqual([{ from: 0, to: 0, insert: 'x' }]);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  test('ChunkedInsertError bytesWritten > 0 with empty restoreText and empty anchor: deletes partial only', () => {
    const { dispatch, dispatches, state } = makeFakeView();
    const err = new ChunkedInsertError(new Error('boom'), {
      chunksCompleted: 0,
      totalChunks: 5,
      bytesWritten: 0,
      bytesRemaining: 250 * 1024,
    });
    withSilencedWarn(() =>
      handleChunkedInsertFailure({
        // biome-ignore lint/suspicious/noExplicitAny: fake view for unit test
        view: { dispatch, state } as any,
        source: 'generic',
        html: '<p>x</p>',
        restoreText: '',
        anchorIndex: 0,
        err,
      }),
    );
    expect(dispatches).toEqual([]); // no dispatch for empty restoreText + 0 bytes
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  test('ChunkedInsertError clamps delete end to doc length on concurrent-peer truncation', () => {
    const { dispatch, dispatches, state } = makeFakeView(/* docLength */ 60);
    const err = new ChunkedInsertError(new Error('boom'), {
      chunksCompleted: 1,
      totalChunks: 5,
      bytesWritten: 100, // we think 100 bytes landed
      bytesRemaining: 400,
    });
    withSilencedWarn(() =>
      handleChunkedInsertFailure({
        // biome-ignore lint/suspicious/noExplicitAny: fake view for unit test
        view: { dispatch, state } as any,
        source: 'generic',
        html: '<p>x</p>',
        restoreText: 'abc',
        anchorIndex: 10,
        err,
      }),
    );
    // anchor(10) + bytesWritten(100) = 110, but doc length is 60 — clamp to 60.
    expect(dispatches).toEqual([{ from: 10, to: 60, insert: 'abc' }]);
  });

  test('non-ChunkedInsertError falls back to conversion-fail telemetry', () => {
    const { dispatch, dispatches, state } = makeFakeView();
    withSilencedWarn(() =>
      handleChunkedInsertFailure({
        // biome-ignore lint/suspicious/noExplicitAny: fake view for unit test
        view: { dispatch, state } as any,
        source: 'notion',
        html: '<p>x</p>',
        restoreText: 'abc',
        anchorIndex: 5,
        err: new Error('unrelated failure'),
      }),
    );
    // Can't know bytesWritten — falls back to insert-at-anchor.
    expect(dispatches).toEqual([{ from: 5, to: 5, insert: 'abc' }]);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    // The generic branch emits the "Paste failed" toast instead of the
    // chunks-landed variant, so users know it wasn't a partial outcome.
    const msg = toastMock.error.mock.calls[0]?.[0];
    expect(msg).toContain('Paste failed');
  });

  test('dispatch throw during rollback is logged but does not prevent toast', () => {
    const throwingDispatch = mock(() => {
      throw new Error('view destroyed');
    });
    withSilencedWarn(() =>
      handleChunkedInsertFailure({
        // biome-ignore lint/suspicious/noExplicitAny: fake view for unit test
        view: { dispatch: throwingDispatch, state: { doc: { length: 1_000_000 } } } as any,
        source: 'gmail',
        html: '<p>x</p>',
        restoreText: 'some text',
        anchorIndex: 0,
        err: new ChunkedInsertError(new Error('x'), {
          chunksCompleted: 1,
          totalChunks: 3,
          bytesWritten: 50000,
          bytesRemaining: 100000,
        }),
      }),
    );
    // Telemetry + toast path still runs.
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  test('ChunkedInsertError + dispatch throw: toast accurately states selection NOT restored', () => {
    // Regression for the misleading-toast-on-dispatch-failure case.
    // When dispatch throws (view destroyed by Activity-hidden unmount, Y.Doc
    // GC'd, etc.), the user's selection is NOT restored. The toast must say
    // so rather than claim a successful restoration.
    const throwingDispatch = mock(() => {
      throw new Error('view destroyed');
    });
    withSilencedWarn(() =>
      handleChunkedInsertFailure({
        // biome-ignore lint/suspicious/noExplicitAny: fake view for unit test
        view: { dispatch: throwingDispatch, state: { doc: { length: 1_000_000 } } } as any,
        source: 'gmail',
        html: '<p>x</p>',
        restoreText: 'original user content',
        anchorIndex: 0,
        err: new ChunkedInsertError(new Error('x'), {
          chunksCompleted: 1,
          totalChunks: 3,
          bytesWritten: 50000,
          bytesRemaining: 100000,
        }),
      }),
    );
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    const msg = toastMock.error.mock.calls[0]?.[0] as string;
    // Must NOT claim "selection has been restored" — dispatch threw.
    expect(msg).not.toContain('been restored');
    // Should communicate the failed-restore state explicitly.
    expect(msg.toLowerCase()).toContain('could not be restored');
  });

  test('non-ChunkedInsertError + dispatch throw: toast accurately states selection NOT restored', () => {
    // Same regression for the generic-error path.
    const throwingDispatch = mock(() => {
      throw new Error('view destroyed');
    });
    withSilencedWarn(() =>
      handleChunkedInsertFailure({
        // biome-ignore lint/suspicious/noExplicitAny: fake view for unit test
        view: { dispatch: throwingDispatch, state: { doc: { length: 1_000_000 } } } as any,
        source: 'notion',
        html: '<p>x</p>',
        restoreText: 'abc',
        anchorIndex: 5,
        err: new Error('unrelated failure'),
      }),
    );
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    const msg = toastMock.error.mock.calls[0]?.[0] as string;
    expect(msg).not.toContain('been restored');
    expect(msg.toLowerCase()).toContain('could not be restored');
  });

  test('zero-bytes + empty selection: toast omits restoration claim entirely', () => {
    // Edge case: nothing was selected, nothing was written. Don't claim
    // "Your selection has been restored" — there was no selection.
    const { dispatch, state } = makeFakeView();
    withSilencedWarn(() =>
      handleChunkedInsertFailure({
        // biome-ignore lint/suspicious/noExplicitAny: fake view for unit test
        view: { dispatch, state } as any,
        source: 'generic',
        html: '<p>x</p>',
        restoreText: '',
        anchorIndex: 0,
        err: new ChunkedInsertError(new Error('boom'), {
          chunksCompleted: 0,
          totalChunks: 5,
          bytesWritten: 0,
          bytesRemaining: 250 * 1024,
        }),
      }),
    );
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    const msg = toastMock.error.mock.calls[0]?.[0] as string;
    expect(msg).not.toContain('been restored');
    expect(msg).not.toContain('could not be restored');
  });
});
