/**
 * Drift guard: the hand-authored `linter` leaf of the config.yml schema
 * (`schema.ts`) must stay in lockstep with the lint plugin registry
 * (`markdown/lint`). The leaf is deliberately NOT derived from the registry —
 * it carries config-system metadata (per-field `scope` / `agentSettable` /
 * `description` + the config-walker registration contract) that doesn't belong
 * on the lint descriptors, and deriving it would couple `markdown/lint` to
 * `config` (the `fieldRegistry` lives here). So it's the one place adding a
 * plugin still needs a manual edit — and these tests make a forgotten edit a
 * loud failure instead of a silent shape mismatch.
 */

import { describe, expect, test } from 'bun:test';
import {
  LINT_PLUGINS,
  LinterConfigSchema,
  type PersistedLinterConfig,
  toEffectiveBase,
} from '../markdown/lint/index.ts';
import { ConfigSchema } from './schema.ts';

describe('config.yml linter leaf ⟷ plugin registry', () => {
  // The resolved default the config.yml schema produces for a project that
  // configures nothing.
  const linterDefault = ConfigSchema.parse({}).contentRules;

  test('the config.yml linter default has exactly the registry plugin ids', () => {
    // Each plugin is a direct child of `contentRules` (no `plugins` wrapper).
    expect(Object.keys(linterDefault).sort()).toEqual(
      LINT_PLUGINS.map((plugin) => plugin.id).sort(),
    );
  });

  test('the lifted config.yml linter default validates against the registry-derived schema', () => {
    // Persisted config.yml omits markdownlint `rules` (native-file sourced), so
    // lift it to an effective config first. If a plugin's persisted slice drifts
    // from its descriptor sliceSchema, the effective LinterConfigSchema rejects it.
    const result = LinterConfigSchema.safeParse(
      toEffectiveBase(linterDefault as unknown as PersistedLinterConfig),
    );
    expect(result.success).toBe(true);
  });

  test('every registered plugin has a config.yml slice (default carries it)', () => {
    for (const plugin of LINT_PLUGINS) {
      expect(linterDefault).toHaveProperty(plugin.id);
    }
  });
});
