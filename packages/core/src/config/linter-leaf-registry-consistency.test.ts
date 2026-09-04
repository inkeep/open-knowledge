import { describe, expect, test } from 'vitest';
import {
  LINT_PLUGINS,
  LinterConfigSchema,
  type PersistedLinterConfig,
  toEffectiveBase,
} from '../markdown/lint/index.ts';
import { ConfigSchema } from './schema.ts';

describe('config.yml linter leaf ⟷ plugin registry', () => {
  const linterDefault = ConfigSchema.parse({}).contentRules;

  test('the config.yml linter default has exactly the registry plugin ids', () => {
    expect(Object.keys(linterDefault).sort()).toEqual(
      LINT_PLUGINS.map((plugin) => plugin.id).sort(),
    );
  });

  test('the lifted config.yml linter default validates against the registry-derived schema', () => {
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
