import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ChunkedInsertError } from '@inkeep/open-knowledge-core';
import * as actualSonner from 'sonner';

type ToastFn = { error: ReturnType<typeof mock> };
const toastMock: ToastFn = { error: mock(() => {}) };
mock.module('sonner', () => ({ ...actualSonner, toast: toastMock }));

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
    expect(dispatches).toEqual([
      { from: 42, to: 42 + bytesWritten, insert: 'original user selection' },
    ]);
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
    expect(dispatches).toEqual([{ from: 5, to: 5, insert: 'abc' }]);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
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
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  test('ChunkedInsertError + dispatch throw: toast accurately states selection NOT restored', () => {
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
    expect(msg).not.toContain('been restored');
    expect(msg.toLowerCase()).toContain('could not be restored');
  });

  test('non-ChunkedInsertError + dispatch throw: toast accurately states selection NOT restored', () => {
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
