/**
 * `useLiveDocText` status-mapping tests with the WebSocket transport faked
 * at the `@hocuspocus/provider` boundary — the Y.Doc, the pool map, the
 * refcounts, the debounce, the watchdog, the admission gate, and the hard
 * capacity cap are all real. The transport truth (real server, real sync)
 * lives in `tests/integration/live-doc-pool.test.ts`.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';

type SyncedListener = () => void;

class FakeProvider {
  static instances: FakeProvider[] = [];
  document: Y.Doc;
  name: string;
  destroyed = false;
  private syncedListeners: SyncedListener[] = [];

  constructor(opts: { url: string; name: string; document: Y.Doc }) {
    this.document = opts.document;
    this.name = opts.name;
    FakeProvider.instances.push(this);
  }

  on(event: string, cb: SyncedListener) {
    if (event === 'synced') this.syncedListeners.push(cb);
  }

  emitSynced() {
    for (const cb of this.syncedListeners) cb();
  }

  destroy() {
    this.destroyed = true;
  }
}

vi.doMock('@hocuspocus/provider', () => ({ HocuspocusProvider: FakeProvider }));
vi.doMock('@/lib/use-collab-url', () => ({
  useCollabUrl: () => ({ collabUrl: 'ws://test/collab' }),
}));

const {
  __liveDocPoolSize,
  acquireLiveDocProvider,
  disposeLiveDocPool,
  LIVE_DOC_OBSERVE_DEBOUNCE_MS,
  LIVE_DOC_POOL_MAX,
  LIVE_DOC_SYNC_WATCHDOG_MS,
  releaseLiveDocProvider,
  useLiveDocText,
} = await import('./live-doc-pool.ts');

function lastProvider(): FakeProvider {
  const p = FakeProvider.instances.at(-1);
  if (!p) throw new Error('no provider constructed');
  return p;
}

function setSource(p: FakeProvider, text: string) {
  const ytext = p.document.getText('source');
  p.document.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, text);
  });
}

describe('useLiveDocText', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeProvider.instances = [];
  });
  afterEach(() => {
    cleanup();
    disposeLiveDocPool();
    vi.useRealTimers();
  });

  test('maps sync-with-content to ready, and debounces live updates', async () => {
    const { result } = renderHook(() => useLiveDocText('tests/board.excalidraw'));
    expect(result.current).toEqual({ kind: 'loading' });

    const provider = lastProvider();
    act(() => {
      setSource(provider, '{"elements":[]}');
      provider.emitSynced();
    });
    expect(result.current).toEqual({ kind: 'ready', text: '{"elements":[]}' });

    // A post-sync edit reaches the consumer only after the trailing-edge
    // debounce, not per keystroke.
    act(() => {
      setSource(provider, '{"elements":[{"id":"a"}]}');
    });
    expect(result.current).toEqual({ kind: 'ready', text: '{"elements":[]}' });
    act(() => {
      vi.advanceTimersByTime(LIVE_DOC_OBSERVE_DEBOUNCE_MS + 1);
    });
    expect(result.current).toEqual({ kind: 'ready', text: '{"elements":[{"id":"a"}]}' });
  });

  test('a reconnect replay of identical text preserves status identity', () => {
    const { result } = renderHook(() => useLiveDocText('tests/board.excalidraw'));
    const provider = lastProvider();
    act(() => {
      setSource(provider, '{"elements":[]}');
      provider.emitSynced();
    });
    const before = result.current;

    // Every reconnect re-fires onSynced; an identical text must not mint a
    // fresh status object, or every consumer re-runs its parse/export
    // chain for a pixel-identical result.
    act(() => {
      provider.emitSynced();
    });
    expect(result.current).toBe(before);
  });

  test('maps confirmed-synced-and-empty to empty, not an error', () => {
    const { result } = renderHook(() => useLiveDocText('tests/blank.excalidraw'));
    act(() => {
      lastProvider().emitSynced();
    });
    expect(result.current).toEqual({ kind: 'empty' });
  });

  test('the watchdog maps never-synced to unreachable AND releases the provider', () => {
    const { result } = renderHook(() => useLiveDocText('tests/gone.excalidraw'));
    expect(__liveDocPoolSize()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(LIVE_DOC_SYNC_WATCHDOG_MS + 1);
    });
    expect(result.current).toEqual({ kind: 'unreachable' });
    // The entry is gone — a never-syncing provider must not keep retrying
    // in the background for the rest of the session.
    expect(__liveDocPoolSize()).toBe(0);
    expect(lastProvider().destroyed).toBe(true);
  });

  test('unmount after a watchdog release does not double-decrement a fresh entry', () => {
    const first = renderHook(() => useLiveDocText('tests/gone.excalidraw'));
    act(() => {
      vi.advanceTimersByTime(LIVE_DOC_SYNC_WATCHDOG_MS + 1);
    });
    // A second consumer re-acquires the same key AFTER the watchdog fired.
    renderHook(() => useLiveDocText('tests/gone.excalidraw'));
    expect(__liveDocPoolSize()).toBe(1);

    // The first hook's cleanup must be a no-op (its release already ran).
    first.unmount();
    expect(__liveDocPoolSize()).toBe(1);
  });

  test('a bumped retryToken re-enters the acquire cycle', () => {
    const { result, rerender } = renderHook(
      ({ token }: { token: number }) => useLiveDocText('tests/gone.excalidraw', token),
      { initialProps: { token: 0 } },
    );
    act(() => {
      vi.advanceTimersByTime(LIVE_DOC_SYNC_WATCHDOG_MS + 1);
    });
    expect(result.current).toEqual({ kind: 'unreachable' });
    const providersBefore = FakeProvider.instances.length;

    rerender({ token: 1 });
    expect(result.current).toEqual({ kind: 'loading' });
    expect(FakeProvider.instances.length).toBe(providersBefore + 1);
    act(() => {
      const provider = lastProvider();
      setSource(provider, '{"elements":[]}');
      provider.emitSynced();
    });
    expect(result.current).toEqual({ kind: 'ready', text: '{"elements":[]}' });
  });

  test('an inadmissible docName maps to unreachable without a provider', () => {
    const { result } = renderHook(() => useLiveDocText('__config__/project'));
    expect(result.current).toEqual({ kind: 'unreachable' });
    expect(FakeProvider.instances.length).toBe(0);
    expect(__liveDocPoolSize()).toBe(0);
  });

  test('a null docName maps to unreachable', () => {
    const { result } = renderHook(() => useLiveDocText(null));
    expect(result.current).toEqual({ kind: 'unreachable' });
    expect(FakeProvider.instances.length).toBe(0);
  });

  test('two consumers of one doc share a provider and release refcounted', () => {
    const a = renderHook(() => useLiveDocText('tests/shared.excalidraw'));
    const b = renderHook(() => useLiveDocText('tests/shared.excalidraw'));
    expect(FakeProvider.instances.length).toBe(1);
    expect(__liveDocPoolSize()).toBe(1);
    a.unmount();
    expect(__liveDocPoolSize()).toBe(1);
    b.unmount();
    expect(__liveDocPoolSize()).toBe(0);
  });

  test('the hard cap refuses the overflow acquire as at-capacity, not unreachable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Fill the pool to its cap with distinct keys. Existing keys must
      // still share (no refusal), and the overflow must be discriminated
      // so consumers can render truthful capacity copy.
      for (let i = 0; i < LIVE_DOC_POOL_MAX; i++) {
        const acquired = acquireLiveDocProvider('ws://test/collab', `tests/fill-${i}.excalidraw`);
        expect(acquired.ok).toBe(true);
      }
      expect(__liveDocPoolSize()).toBe(LIVE_DOC_POOL_MAX);

      const overflow = acquireLiveDocProvider('ws://test/collab', 'tests/one-more.excalidraw');
      expect(overflow).toEqual({ ok: false, reason: 'at-capacity' });
      expect(__liveDocPoolSize()).toBe(LIVE_DOC_POOL_MAX);

      // A doc already in the pool still shares its entry past the cap.
      const shared = acquireLiveDocProvider('ws://test/collab', 'tests/fill-0.excalidraw');
      expect(shared.ok).toBe(true);
      releaseLiveDocProvider('ws://test/collab', 'tests/fill-0.excalidraw');

      // The hook maps the refusal to its own terminal state.
      const { result } = renderHook(() => useLiveDocText('tests/overflow.excalidraw'));
      expect(result.current).toEqual({ kind: 'at-capacity' });
    } finally {
      warn.mockRestore();
    }
  });
});
