import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { LinterConfig } from '@inkeep/open-knowledge-core';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  partitionFrontmatterProblems,
  useFrontmatterDiagnostics,
} from './useFrontmatterDiagnostics';

const DOC_NAME = 'usability-sessions/kenny/notes/serafin';

function fakeProvider(initial: string): { provider: HocuspocusProvider; doc: Y.Doc } {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, initial);
  return {
    provider: {
      document: doc,
      configuration: { name: DOC_NAME },
    } as unknown as HocuspocusProvider,
    doc,
  };
}

const okfEnabled: LinterConfig = {
  enabled: true,
  plugins: {
    markdownlint: { enabled: true, rules: {} },
    frontmatter: { enabled: true, schemas: [] },
    okf: { enabled: true },
  },
};

const frontmatterPluginOff: LinterConfig = {
  ...okfEnabled,
  plugins: {
    ...okfEnabled.plugins,
    frontmatter: { enabled: false, schemas: [] },
  },
};

const MISSING_TYPE = '---\ntitle: Serafin\ntags: []\n---\n\nSee [[Wiki Target]]\there.\n';

afterEach(() => cleanup());

describe('useFrontmatterDiagnostics with the OKF plugin enabled', () => {
  test('reports the OKF missing-`type` violation with full badge metadata', async () => {
    const { provider } = fakeProvider(MISSING_TYPE);
    const { result } = renderHook(() => useFrontmatterDiagnostics(provider, okfEnabled));

    await waitFor(() =>
      expect(
        result.current.some(
          (d) =>
            d.source === 'okf' &&
            d.code === 'frontmatter-required' &&
            d.frontmatterScope === 'missing' &&
            d.frontmatterProperty === 'type',
        ),
      ).toBe(true),
    );
    expect(result.current.every((d) => d.frontmatterScope !== undefined)).toBe(true);
  });

  test('feeds the Add-properties badge through partitionFrontmatterProblems', async () => {
    const { provider } = fakeProvider(MISSING_TYPE);
    const { result } = renderHook(() => useFrontmatterDiagnostics(provider, okfEnabled));

    await waitFor(() => {
      const { missing, invalid } = partitionFrontmatterProblems(result.current);
      expect(missing.map((d) => d.frontmatterProperty)).toEqual(['type']);
      expect(invalid).toHaveLength(0);
    });
  });

  test('reports the OKF violation with the frontmatter plugin itself disabled', async () => {
    const { provider } = fakeProvider(MISSING_TYPE);
    const { result } = renderHook(() => useFrontmatterDiagnostics(provider, frontmatterPluginOff));

    await waitFor(() =>
      expect(
        result.current.some((d) => d.source === 'okf' && d.frontmatterScope === 'missing'),
      ).toBe(true),
    );
  });

  test('clears once the missing `type` is added', async () => {
    const { provider, doc } = fakeProvider('---\ntitle: Serafin\n---\n\nPlain notes.\n');
    const { result } = renderHook(() => useFrontmatterDiagnostics(provider, okfEnabled));
    await waitFor(() =>
      expect(result.current.some((d) => d.frontmatterProperty === 'type')).toBe(true),
    );

    const ytext = doc.getText('source');
    ytext.delete(0, ytext.length);
    ytext.insert(0, '---\ntitle: Serafin\ntype: Note\n---\n\nPlain notes.\n');
    await waitFor(() => expect(result.current).toEqual([]));
  });
});
