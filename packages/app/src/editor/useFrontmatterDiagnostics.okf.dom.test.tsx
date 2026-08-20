/**
 * The badge hook's lint pass must produce the OKF plugin's frontmatter
 * diagnostics — the sibling dom test only exercises the built-in frontmatter
 * plugin, so a badge pass that silently disables the OKF producer stays green
 * there while the Add-properties badge never shows for an OKF-governed doc.
 *
 * Real hook, real Y.Doc, real `lintDocument` over the real OKF registry: the
 * exact composition `EditorArea` / `PropertyPanel` run
 * (`partitionFrontmatterProblems(useFrontmatterDiagnostics(provider, config))`).
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { LinterConfig } from '@inkeep/open-knowledge-core';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  partitionFrontmatterProblems,
  useFrontmatterDiagnostics,
} from './useFrontmatterDiagnostics';

// A concept-scoped doc name (anything but a reserved `index`/`log` filename).
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

// OKF enabled; the frontmatter plugin on with no authored schemas (the shape a
// project has right after enabling OKF); markdownlint deliberately ENABLED so
// the suppression assertions below prove body findings still never reach this
// frontmatter-only surface.
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

// Frontmatter without the OKF-required `type`; a body wiki-link (OKF body rule
// `no-wiki-links`) and a hard tab (markdownlint MD010) that must stay off the
// badge surface even once the OKF producer participates in the pass.
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
    // Frontmatter-only surface: scope-less findings (the body wiki-link, the
    // markdownlint hard tab) must not ride along.
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
    // Enabling OKF deliberately does not require enabling the frontmatter
    // plugin (its schemas ship inside the plugin, no files on disk), so the
    // badge must work for a project running OKF alone.
    const { provider } = fakeProvider(MISSING_TYPE);
    const { result } = renderHook(() => useFrontmatterDiagnostics(provider, frontmatterPluginOff));

    await waitFor(() =>
      expect(
        result.current.some((d) => d.source === 'okf' && d.frontmatterScope === 'missing'),
      ).toBe(true),
    );
  });

  test('clears once the missing `type` is added', async () => {
    // The full badge loop: violation reported live, then satisfied by an edit.
    // Ends at [] only after the diagnostic was observed, so a hook that never
    // reports cannot pass by staying empty throughout.
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
