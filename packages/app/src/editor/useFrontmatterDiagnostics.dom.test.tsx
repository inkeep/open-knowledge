import type { HocuspocusProvider } from '@hocuspocus/provider';
import { DEFAULT_LINTER_CONFIG, type LinterConfig } from '@inkeep/open-knowledge-core';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { useFrontmatterDiagnostics } from './useFrontmatterDiagnostics';

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

const frontmatterEnabled: LinterConfig = {
  ...DEFAULT_LINTER_CONFIG,
  enabled: true,
  plugins: {
    markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true },
    frontmatter: {
      ...DEFAULT_LINTER_CONFIG.plugins.frontmatter,
      enabled: true,
      schemas: [{ file: 'test.json', schema: { type: 'object', required: ['title'] } }],
    },
  },
};

const frontmatterDisabled: LinterConfig = {
  ...frontmatterEnabled,
  plugins: {
    ...frontmatterEnabled.plugins,
    frontmatter: { ...frontmatterEnabled.plugins.frontmatter, enabled: false },
  },
};

const MISSING_TITLE_WITH_TAB = '---\nx: 1\n---\n\n\ttabbed line\n';

afterEach(() => cleanup());

describe('useFrontmatterDiagnostics', () => {
  test('returns [] when the provider is null', () => {
    const { result } = renderHook(() => useFrontmatterDiagnostics(null, frontmatterEnabled));
    expect(result.current).toEqual([]);
  });

  test('returns [] when linting is disabled', () => {
    const { provider } = fakeProvider(MISSING_TITLE_WITH_TAB);
    const { result } = renderHook(() =>
      useFrontmatterDiagnostics(provider, { ...frontmatterEnabled, enabled: false }),
    );
    expect(result.current).toEqual([]);
  });

  test('returns [] when the frontmatter plugin is disabled', () => {
    const { provider } = fakeProvider(MISSING_TITLE_WITH_TAB);
    const { result } = renderHook(() => useFrontmatterDiagnostics(provider, frontmatterDisabled));
    expect(result.current).toEqual([]);
  });

  test('reports the frontmatter violation and suppresses markdownlint', async () => {
    const { provider } = fakeProvider(MISSING_TITLE_WITH_TAB);
    const { result } = renderHook(() => useFrontmatterDiagnostics(provider, frontmatterEnabled));
    await waitFor(() =>
      expect(result.current.some((d) => d.source === 'frontmatter' && d.code === 'required')).toBe(
        true,
      ),
    );
    expect(result.current.every((d) => d.source === 'frontmatter')).toBe(true);
    expect(result.current.some((d) => d.code === 'MD010')).toBe(false);
  });

  test('re-lints (debounced) when the source text changes', async () => {
    const { provider, doc } = fakeProvider('---\ntitle: ok\n---\n\nbody\n');
    const { result } = renderHook(() => useFrontmatterDiagnostics(provider, frontmatterEnabled));
    await waitFor(() => expect(result.current).toEqual([]));

    const ytext = doc.getText('source');
    ytext.delete(0, ytext.length);
    ytext.insert(0, '---\nx: 1\n---\n\nbody\n');
    await waitFor(() =>
      expect(result.current.some((d) => d.source === 'frontmatter' && d.code === 'required')).toBe(
        true,
      ),
    );
  });

  test('unobserves the source text on unmount', async () => {
    const { provider, doc } = fakeProvider(MISSING_TITLE_WITH_TAB);
    const ytext = doc.getText('source');
    const observeSpy = vi.spyOn(ytext, 'observe');
    const unobserveSpy = vi.spyOn(ytext, 'unobserve');
    const { result, unmount } = renderHook(() =>
      useFrontmatterDiagnostics(provider, frontmatterEnabled),
    );
    await waitFor(() => expect(result.current.some((d) => d.code === 'required')).toBe(true));
    expect(observeSpy).toHaveBeenCalledTimes(1);
    const handler = observeSpy.mock.calls[0]?.[0];
    expect(handler).toBeDefined();

    unmount();
    expect(unobserveSpy).toHaveBeenCalledWith(handler);
  });
});
