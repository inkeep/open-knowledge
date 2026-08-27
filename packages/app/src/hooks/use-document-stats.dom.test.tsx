import type { HocuspocusProvider } from '@hocuspocus/provider';
import { isEditableTextDocFile } from '@inkeep/open-knowledge-core';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { useDocumentStats } from './use-document-stats';

function fakeProvider(source: string, docName: string): HocuspocusProvider {
  const document = new Y.Doc();
  document.getText('source').insert(0, source);
  return {
    document,
    configuration: { name: docName },
  } as unknown as HocuspocusProvider;
}

afterEach(() => cleanup());

describe('useDocumentStats', () => {
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
  ])('$docName counts its literal source instead of interpreting Markdown', async ({
    docName,
    source,
    expected,
  }) => {
    expect(isEditableTextDocFile(docName)).toBe(true);
    const provider = fakeProvider(source, docName);
    const { result } = renderHook(() => useDocumentStats(provider, docName));

    await waitFor(() => expect(result.current).toEqual(expected));
  });
});
