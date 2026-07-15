/**
 * Drift guard: the settings sidebar list (`LINT_PLUGIN_META`) must cover exactly
 * the lint plugin registry. The list is hand-authored (kept free of heavy core
 * imports so the settings shell stays light — deriving it from LINT_PLUGINS would
 * pull the lint engines into the shell bundle), so a forgotten entry would
 * silently drop a plugin's panel from the sidebar. The id→Section map in
 * `lint-plugins.tsx` is already compile-time complete (`Record<LintPluginId>`);
 * this covers the remaining array.
 */

import { describe, expect, test } from 'bun:test';
import { LINT_PLUGINS } from '@inkeep/open-knowledge-core';
import { LINT_PLUGIN_META } from './lint-plugin-meta.ts';

describe('LINT_PLUGIN_META ⟷ plugin registry', () => {
  test('covers exactly the registered plugin ids (settings list stays in sync)', () => {
    expect(LINT_PLUGIN_META.map((meta) => meta.id).sort()).toEqual(
      LINT_PLUGINS.map((plugin) => plugin.id).sort(),
    );
  });

  test('every entry has a non-empty label', () => {
    for (const meta of LINT_PLUGIN_META) {
      expect(meta.label.length).toBeGreaterThan(0);
    }
  });
});
