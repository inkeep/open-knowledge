import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';

type SyncedListener = () => void;

class FakeProvider {
  static instances: FakeProvider[] = [];
  document: Y.Doc;
  name: string;
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

  destroy() {}
}

vi.doMock('@hocuspocus/provider', () => ({ HocuspocusProvider: FakeProvider }));
vi.doMock('@/lib/use-collab-url', () => ({
  useCollabUrl: () => ({ collabUrl: 'ws://test/collab' }),
}));

const { acquireLiveDocProvider, disposeLiveDocPool, LIVE_DOC_POOL_MAX } = await import(
  './live-doc-pool.ts'
);
const { useMirrorSource } = await import('./use-mirror-source.ts');

const SOURCE_MD = [
  '<MirrorSource id="intro">',
  '',
  'Hello from the source.',
  '',
  '</MirrorSource>',
].join('\n');

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

describe('useMirrorSource', () => {
  beforeEach(() => {
    FakeProvider.instances = [];
  });
  afterEach(() => {
    cleanup();
    disposeLiveDocPool();
  });

  test('a pool capacity refusal maps to at-capacity, never source-removed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < LIVE_DOC_POOL_MAX; i++) {
        const acquired = acquireLiveDocProvider('ws://test/collab', `fill-${i}`);
        expect(acquired.ok).toBe(true);
      }

      const { result } = renderHook(() => useMirrorSource('one-more-doc', 'intro'));
      expect(result.current).toEqual({ kind: 'at-capacity' });
    } finally {
      warn.mockRestore();
    }
  });

  test('an inadmissible docName maps to source-removed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useMirrorSource('__config__/project', 'intro'));
      expect(result.current).toEqual({ kind: 'source-removed' });
      expect(FakeProvider.instances.length).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  test('a reconnect replay of identical source preserves ready-status identity', () => {
    const { result } = renderHook(() => useMirrorSource('source-doc', 'intro'));
    const provider = lastProvider();
    act(() => {
      setSource(provider, SOURCE_MD);
      provider.emitSynced();
    });
    expect(result.current.kind).toBe('ready');
    const before = result.current;

    act(() => {
      provider.emitSynced();
    });
    expect(result.current).toBe(before);
  });
});
