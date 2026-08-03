/**
 * Behavioral test for the useFrontmatterDiagnostics effect (the pure
 * `partitionFrontmatterProblems` split is covered in the sibling unit test).
 * Uses a real Y.Doc — the hook only touches `provider.document.getText('source')`.
 *
 * The effect's job that the pure split can't reach: it must run ONLY the
 * frontmatter slice (markdownlint suppressed, even when enabled and the body
 * would trip it), gate on the frontmatter plugin's own enabled flag, and re-run
 * when the source text changes.
 */

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

// Frontmatter schema requires `title`; markdownlint is deliberately ENABLED so
// the test can prove the hook suppresses it (a hard tab in the body would trip
// MD010 through the full lint pass, but must never reach this frontmatter-only
// surface).
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

// Missing the required `title`, plus a body hard tab (MD010) that markdownlint
// would flag if it ran.
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
    // The plugin-specific gate, distinct from the top-level `enabled`: linting
    // is on and markdownlint is enabled, but with frontmatter off this surface
    // contributes nothing.
    const { provider } = fakeProvider(MISSING_TITLE_WITH_TAB);
    const { result } = renderHook(() => useFrontmatterDiagnostics(provider, frontmatterDisabled));
    expect(result.current).toEqual([]);
  });

  test('reports the frontmatter violation and suppresses markdownlint', async () => {
    const { provider } = fakeProvider(MISSING_TITLE_WITH_TAB);
    const { result } = renderHook(() => useFrontmatterDiagnostics(provider, frontmatterEnabled));
    // The missing-`title` diagnostic lands a tick after mount.
    await waitFor(() =>
      expect(result.current.some((d) => d.source === 'frontmatter' && d.code === 'required')).toBe(
        true,
      ),
    );
    // The body hard tab would trip MD010 — the whole point of the frontmatter
    // pass is that markdownlint never runs, so it must not appear here.
    expect(result.current.every((d) => d.source === 'frontmatter')).toBe(true);
    expect(result.current.some((d) => d.code === 'MD010')).toBe(false);
  });

  test('re-lints (debounced) when the source text changes', async () => {
    const { provider, doc } = fakeProvider('---\ntitle: ok\n---\n\nbody\n');
    const { result } = renderHook(() => useFrontmatterDiagnostics(provider, frontmatterEnabled));
    // Conformant to start — the required property is present.
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
    // The effect observes one handler on mount and must remove that same one on
    // unmount, or every viewed doc leaks a live Yjs observer (silent in prod).
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
    // Symmetric teardown: unobserve is called with the exact handler observe got.
    expect(unobserveSpy).toHaveBeenCalledWith(handler);
  });
});
