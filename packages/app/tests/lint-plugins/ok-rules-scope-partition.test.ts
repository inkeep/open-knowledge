import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import plugin, { rules } from '../../../../lint-plugins/ok-rules/index.mjs';
import {
  isInScope,
  RULE_SCOPES,
  UNSCOPED_RULES,
} from '../../../../lint-plugins/ok-rules/scope.mjs';
import { readJsPluginSpecifiers } from '../../../../test-support/read-ok-rules-config.test-helper';

const registered = Object.keys(rules).sort();

describe('ok-rules scope table', () => {
  test('every registered rule is either scoped or deliberately unscoped, never both', () => {
    const scoped = Object.keys(RULE_SCOPES);
    const unscoped = [...UNSCOPED_RULES];
    expect([...scoped, ...unscoped].sort()).toEqual(registered);
    expect(scoped.filter((r) => UNSCOPED_RULES.has(r))).toEqual([]);
  });

  test('UNSCOPED_RULES holds exactly the six rules that are deliberately global', () => {
    expect([...UNSCOPED_RULES].sort()).toEqual([
      'microcopy-ellipsis',
      'no-hand-rolled-spinner',
      'no-loosely-typed-webcontents-ipc',
      'no-resolved-value-theme-source',
      'no-split-suggestion-dispatch',
      'no-unportaled-editor-content',
    ]);
  });

  test('the `ok` plugin registers exactly the rules it exports', () => {
    expect(Object.keys(plugin.rules).sort()).toEqual(registered);
  });

  test('an unclassified rule name fails closed rather than scoping everywhere', () => {
    expect(() => isInScope('rule-that-does-not-exist', 'packages/app/src/x.tsx')).toThrow(
      /no entry in the scope table it was looked up in/,
    );
  });

  test('UNSCOPED_RULES does not leak into a caller-supplied table', () => {
    const unscopedName = [...UNSCOPED_RULES][0];
    expect(() => isInScope(unscopedName, 'packages/app/src/x.tsx', {})).toThrow(
      /no entry in the scope table it was looked up in/,
    );
    expect(isInScope(unscopedName, 'packages/app/src/x.tsx')).toBe(true);
  });

  test('oxlint.config.ts still loads the `ok` plugin these rules are exported from', async () => {
    expect(await readJsPluginSpecifiers(join(__dirname, '..', '..', '..', '..'))).toContain(
      './lint-plugins/ok-rules/index.mjs',
    );
  });

  test('every scope entry names its own fixture, so the fixture test can fire', () => {
    for (const [rule, globs] of Object.entries(RULE_SCOPES)) {
      const fixture = globs.find((g) => g.includes('__fixtures__'));
      expect(fixture, `${rule} has no fixture glob in its scope`).toBeDefined();
      expect(fixture).toContain(rule);
    }
  });

  test('the matcher rejects glob syntax it does not implement, rather than mis-scoping', () => {
    for (const globs of Object.values(RULE_SCOPES)) {
      for (const glob of globs) {
        expect(glob.replace(/^!/, '')).not.toMatch(/[?{}[\]()]/);
      }
    }
  });
});
