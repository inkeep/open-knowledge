import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readJsPluginSpecifiers,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';
import plugin, { rules } from '../index.mjs';
import { isInScope, RULE_SCOPES, UNSCOPED_RULES } from '../scope.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const FIXTURE_CONFIG = fileURLToPath(
  new URL('../__fixtures__/oxlint.fixtures.json', import.meta.url),
);
const TIER_TEST = /\.uncached\.test\.mjs$/;
const CODE_FILE = /\.[cm]?[jt]sx?$/;
const META_TESTS = ['ok-rules-scope-partition', 'ok-rules-vocabulary'];

const registered = Object.keys(rules).sort();

function publicTestStems() {
  return readdirSync(TESTS_DIR)
    .filter((name) => TIER_TEST.test(name) && !name.includes('.private.'))
    .map((name) => name.replace(TIER_TEST, ''));
}

describe('ok-rules scope table', () => {
  test('every registered rule is either scoped or deliberately unscoped, never both', () => {
    const scoped = Object.keys(RULE_SCOPES);
    const unscoped = [...UNSCOPED_RULES];
    expect([...scoped, ...unscoped].sort()).toEqual(registered);
    expect(scoped.filter((r) => UNSCOPED_RULES.has(r))).toEqual([]);
  });

  test('UNSCOPED_RULES holds exactly the rules that are deliberately global', () => {
    expect([...UNSCOPED_RULES].sort()).toEqual([
      'microcopy-ellipsis',
      'no-hand-rolled-spinner',
      'no-loosely-typed-webcontents-ipc',
      'no-resolved-value-theme-source',
      'no-sentinel-signal-target',
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
    expect(await readJsPluginSpecifiers(REPO_ROOT)).toContain('./lint-plugins/ok-rules/index.mjs');
  });

  test('every scope entry names its own fixture, so the fixture test can fire', () => {
    for (const [rule, globs] of Object.entries(RULE_SCOPES)) {
      const fixture = globs.find((g) => g.includes('__fixtures__'));
      expect(fixture, `${rule} has no fixture glob in its scope`).toBeDefined();
      expect(fixture).toContain(rule);
    }
  });

  test('no rule reports on a fixture outside its scope', () => {
    const fixtures = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith('.fixture.tsx'));
    expect(fixtures.length).toBeGreaterThan(0);
    let checked = 0;
    const outOfScope = [];
    for (const name of fixtures) {
      const fixture = `lint-plugins/ok-rules/__fixtures__/${name}`;
      for (const fire of lintOkRulesFixture(fixture)) {
        const rule = /^ok\((.+)\)$/.exec(fire.code)?.[1];
        if (rule === undefined) continue;
        checked += 1;
        if (!isInScope(rule, fixture))
          outOfScope.push(`${fire.code} at ${fixture}:${fire.position}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(
      outOfScope,
      'a rule reported on a file its scope excludes, so scoped() in scope.mjs no longer gates it',
    ).toEqual([]);
  });

  test('the matcher rejects glob syntax it does not implement, rather than mis-scoping', () => {
    for (const globs of Object.values(RULE_SCOPES)) {
      for (const glob of globs) {
        expect(glob.replace(/^!/, '')).not.toMatch(/[?{}[\]()]/);
      }
    }
  });
});

describe('ok-rules fixture tests', () => {
  test('every file in the tests directory runs in the uncached tier or is a helper', () => {
    const misplaced = readdirSync(TESTS_DIR).filter(
      (name) => CODE_FILE.test(name) && !TIER_TEST.test(name) && !name.endsWith('.test-helper.mjs'),
    );
    expect(
      misplaced,
      'a fixture test here is named <rule>.uncached.test.mjs, so the uncached tier runs it',
    ).toEqual([]);
  });

  test('every rule the `ok` plugin registers has its fixture test here', () => {
    const stems = new Set(publicTestStems());
    expect(
      registered.filter((rule) => !stems.has(rule)),
      'a rule ships with lint-plugins/ok-rules/tests/<rule>.uncached.test.mjs (precedent #42)',
    ).toEqual([]);
  });

  test('the fixture config enables exactly the registered rules, at error', () => {
    const { rules: configured } = JSON.parse(readFileSync(FIXTURE_CONFIG, 'utf8'));
    const enabled = Object.entries(configured).filter(([id]) => id.startsWith('ok/'));
    expect(
      enabled.map(([id]) => id.slice('ok/'.length)).sort(),
      'a registered rule needs an "ok/<rule>": "error" entry in lint-plugins/ok-rules/__fixtures__/oxlint.fixtures.json',
    ).toEqual(registered);
    expect(enabled.filter(([, severity]) => severity !== 'error')).toEqual([]);
  });

  test('every fixture test here names a registered rule or a meta-test of the rule set', () => {
    expect(
      publicTestStems().filter((stem) => !registered.includes(stem) && !META_TESTS.includes(stem)),
      'rename or delete a fixture test whose rule was renamed or removed',
    ).toEqual([]);
  });
});
