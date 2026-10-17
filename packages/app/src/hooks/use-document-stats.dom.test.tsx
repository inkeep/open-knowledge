import type { HocuspocusProvider } from '@hocuspocus/provider';
import { isEditableTextDocFile } from '@inkeep/open-knowledge-core';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import * as documentStats from '@/lib/document-stats';
import { useDocumentStats } from './use-document-stats';

function fakeProvider(source: string, docName: string): HocuspocusProvider {
  const document = new Y.Doc();
  document.getText('source').insert(0, source);
  return {
    document,
    configuration: { name: docName },
  } as unknown as HocuspocusProvider;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useDocumentStats', () => {
  test('reopening unchanged content reuses its derived statistics', () => {
    const compute = vi.spyOn(documentStats, 'computeBodyStats');
    const first = fakeProvider('**one** `two`', 'first');
    const second = fakeProvider('other document', 'second');
    const { result, rerender } = renderHook(
      ({ provider, docName }) => useDocumentStats(provider, docName),
      { initialProps: { provider: first, docName: 'first' } },
    );
    expect(result.current).toEqual({ words: 2, chars: 7, tokens: 2 });
    rerender({ provider: second, docName: 'second' });
    rerender({ provider: first, docName: 'first' });
    expect(result.current).toEqual({ words: 2, chars: 7, tokens: 2 });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  test('reopening content edited while hidden recomputes its statistics', () => {
    const compute = vi.spyOn(documentStats, 'computeBodyStats');
    const first = fakeProvider('**one** `two`', 'first');
    const second = fakeProvider('other document', 'second');
    const { result, rerender } = renderHook(
      ({ provider, docName }) => useDocumentStats(provider, docName),
      { initialProps: { provider: first, docName: 'first' } },
    );
    rerender({ provider: second, docName: 'second' });
    first.document.getText('source').insert(first.document.getText('source').length, ' three');
    rerender({ provider: first, docName: 'first' });
    expect(result.current).toEqual({ words: 3, chars: 13, tokens: 4 });
    expect(compute).toHaveBeenCalledTimes(3);
  });

  test('an active edit still refreshes statistics', async () => {
    const provider = fakeProvider('one', 'first');
    const { result } = renderHook(() => useDocumentStats(provider, 'first'));
    act(() => provider.document.getText('source').insert(3, ' two'));
    await waitFor(() => expect(result.current).toEqual({ words: 2, chars: 7, tokens: 2 }));
  });

  test('a new document with the same name cannot reuse another document’s statistics', () => {
    const first = fakeProvider('one', 'first');
    const replacement = fakeProvider('one two', 'first');
    const { result, rerender } = renderHook(({ provider }) => useDocumentStats(provider, 'first'), {
      initialProps: { provider: first },
    });
    rerender({ provider: replacement });
    expect(result.current).toEqual({ words: 2, chars: 7, tokens: 2 });
  });

  test('changing the file kind cannot reuse Markdown statistics for literal text', () => {
    const provider = fakeProvider('**one**', 'first');
    const { result, rerender } = renderHook(({ docName }) => useDocumentStats(provider, docName), {
      initialProps: { docName: 'first.md' },
    });
    expect(result.current).toEqual({ words: 1, chars: 3, tokens: 1 });
    rerender({ docName: 'first.csv' });
    expect(result.current).toEqual({ words: 1, chars: 7, tokens: 2 });
  });

  test.each([
    {
      docName: 'glossary.csv',
      source: 'name,description\nwidget,**bold**\n',
      expected: { words: 2, chars: 33, tokens: 9 },
    },
    {
      docName: 'settings.json',
      source: '---\n{"name":"widget"}\n---\n',
      expected: { words: 1, chars: 26, tokens: 7 },
    },
  ])(
    '$docName counts its literal source instead of interpreting Markdown',
    async ({ docName, source, expected }) => {
      expect(isEditableTextDocFile(docName)).toBe(true);
      const provider = fakeProvider(source, docName);
      const { result } = renderHook(() => useDocumentStats(provider, docName));

      await waitFor(() => expect(result.current).toEqual(expected));
    },
  );
});
