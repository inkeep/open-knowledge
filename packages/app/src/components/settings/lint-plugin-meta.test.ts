import { LINT_PLUGINS } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
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

  test('OKF declares its companion agent skill without making it a plugin dependency', () => {
    expect(LINT_PLUGIN_META.find((plugin) => plugin.id === 'okf')?.recommendedSkills).toEqual([
      { packId: 'okf', name: 'okf-knowledge-base' },
    ]);
    expect(
      LINT_PLUGIN_META.filter((plugin) => plugin.id !== 'okf').every(
        (plugin) => plugin.recommendedSkills === undefined,
      ),
    ).toBe(true);
  });
});
