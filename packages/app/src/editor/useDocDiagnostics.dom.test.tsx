/**
 * Behavioral test for useDocDiagnostics: lints the live `Y.Text('source')` of
 * the active provider and re-lints when that text changes. Uses a real Y.Doc
 * (the hook only touches `provider.document.getText('source')`).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { DEFAULT_LINTER_CONFIG, type LinterConfig } from '@inkeep/open-knowledge-core';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import * as Y from 'yjs';
import { useDocDiagnostics } from './useDocDiagnostics';

function fakeProvider(initial: string): { provider: HocuspocusProvider; doc: Y.Doc } {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, initial);
  return {
    provider: {
      document: doc,
      configuration: { name: 'test-doc' },
    } as unknown as HocuspocusProvider,
    doc,
  };
}

const enabled: LinterConfig = {
  ...DEFAULT_LINTER_CONFIG,
  enabled: true,
  plugins: { markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true } },
};

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
});
