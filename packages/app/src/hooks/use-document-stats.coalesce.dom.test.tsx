import type { HocuspocusProvider } from '@hocuspocus/provider';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import type { DocumentStats } from '@/lib/document-stats';

interface Request {
  text: string;
  resolve: (stats: DocumentStats) => void;
}

const requests: Request[] = [];

vi.mock('@/lib/document-stats-runtime', () => ({
  computeDocumentStats: (text: string) =>
    new Promise<DocumentStats>((resolve) => {
      requests.push({ text, resolve });
    }),
}));

const { useDocumentStats } = await import('./use-document-stats');

function fakeProvider(source: string): HocuspocusProvider {
  const document = new Y.Doc();
  document.getText('source').insert(0, source);
  return { document, configuration: { name: 'doc' } } as unknown as HocuspocusProvider;
}

function statsFor(words: number): DocumentStats {
  return { words, chars: words, tokens: words };
}

beforeEach(() => {
  requests.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('useDocumentStats — one stats pass in flight at a time', () => {
  test('changes that land during a pass cause exactly one follow-up, over the latest text', async () => {
    const provider = fakeProvider('one');
    const ytext = provider.document.getText('source');
    const { result } = renderHook(() => useDocumentStats(provider, 'doc.md'));
    expect(requests).toHaveLength(1);

    for (const word of [' two', ' three', ' four']) {
      ytext.insert(ytext.length, word);
      act(() => {
        vi.advanceTimersByTime(300);
      });
    }
    expect(requests).toHaveLength(1);

    await act(async () => {
      requests[0]?.resolve(statsFor(1));
    });
    expect(result.current).toEqual(statsFor(1));
    expect(requests).toHaveLength(2);
    expect(requests[1]?.text).toBe('one two three four');

    await act(async () => {
      requests[1]?.resolve(statsFor(4));
    });
    expect(result.current).toEqual(statsFor(4));
    expect(requests).toHaveLength(2);
  });

  test('a pass that resolves after unmount sets nothing', async () => {
    const provider = fakeProvider('one');
    const { result, unmount } = renderHook(() => useDocumentStats(provider, 'doc.md'));
    const before = result.current;
    unmount();
    await act(async () => {
      requests[0]?.resolve(statsFor(9));
    });
    expect(result.current).toEqual(before);
  });
});
