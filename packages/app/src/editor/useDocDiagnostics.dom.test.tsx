/**
 * Behavioral test for useDocDiagnostics: lints the live `Y.Text('source')` of
 * the active provider and re-lints when that text changes. Uses a real Y.Doc
 * (the hook only touches `provider.document.getText('source')`).
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  DEFAULT_LINTER_CONFIG,
  isEditableTextDocFile,
  type LinterConfig,
} from '@inkeep/open-knowledge-core';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { useDocDiagnostics } from './useDocDiagnostics';

function fakeProvider(
  initial: string,
  docName = 'test-doc',
): { provider: HocuspocusProvider; doc: Y.Doc } {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, initial);
  return {
    provider: {
      document: doc,
      configuration: { name: docName },
    } as unknown as HocuspocusProvider,
    doc,
  };
}

const enabled: LinterConfig = {
  ...DEFAULT_LINTER_CONFIG,
  enabled: true,
  plugins: {
    ...DEFAULT_LINTER_CONFIG.plugins,
    markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true },
  },
};

const markdownAndOkfEnabled: LinterConfig = {
  ...enabled,
  plugins: {
    ...enabled.plugins,
    okf: { ...enabled.plugins.okf, enabled: true },
  },
};

const editableTextCases = [
  { docName: 'reference/data/glossary.csv', source: 'name,\tvalue\nfoo,bar\n' },
  { docName: 'settings.json', source: '{"name":\t"foo"}\n' },
] as const;

afterEach(() => cleanup());

describe('useDocDiagnostics', () => {
  test('returns [] when the provider is null', () => {
    const { result } = renderHook(() => useDocDiagnostics(null, enabled));
    expect(result.current).toEqual([]);
  });

  test('returns [] when linting is disabled', () => {
    const { provider } = fakeProvider('# Title\n\n\ttabbed\n');
    const { result } = renderHook(() =>
      useDocDiagnostics(provider, { ...enabled, enabled: false }),
    );
    expect(result.current).toEqual([]);
  });

  test('lints the live source text on mount', async () => {
    const { provider } = fakeProvider('# Title\n\n\ttabbed line\n');
    const { result } = renderHook(() => useDocDiagnostics(provider, enabled));
    // The lint pass is async — the initial diagnostics land a tick after mount.
    await waitFor(() => expect(result.current.some((d) => d.code === 'MD010')).toBe(true));
  });

  test('re-lints (debounced) when the source text changes', async () => {
    const { provider, doc } = fakeProvider('# Title\n\nclean\n');
    const { result } = renderHook(() => useDocDiagnostics(provider, enabled));
    expect(result.current.some((d) => d.code === 'MD010')).toBe(false);

    doc.getText('source').insert(doc.getText('source').length, '\ttabbed\n');
    await waitFor(() => expect(result.current.some((d) => d.code === 'MD010')).toBe(true));
  });

  test.each(editableTextCases)('$docName stays outside Markdown and OKF diagnostics', async ({
    docName,
    source,
  }) => {
    expect(isEditableTextDocFile(docName)).toBe(true);

    const markdownProvider = fakeProvider(source, 'notes').provider;
    const editableTextProvider = fakeProvider(source, docName).provider;
    const { result, rerender } = renderHook(
      ({ provider }: { provider: HocuspocusProvider }) =>
        useDocDiagnostics(provider, markdownAndOkfEnabled),
      { initialProps: { provider: markdownProvider } },
    );

    await waitFor(() => {
      const sources = new Set(result.current.map((diagnostic) => diagnostic.source));
      expect(sources.has('markdownlint')).toBe(true);
      expect(sources.has('okf')).toBe(true);
    });

    rerender({ provider: editableTextProvider });
    // The render itself must be empty. Waiting here would allow the effect's
    // later reset to hide a one-frame flash of the prior Markdown diagnostics.
    expect(result.current).toEqual([]);

    rerender({ provider: markdownProvider });
    await waitFor(() => {
      const sources = new Set(result.current.map((diagnostic) => diagnostic.source));
      expect(sources.has('markdownlint')).toBe(true);
      expect(sources.has('okf')).toBe(true);
    });
  });
});
