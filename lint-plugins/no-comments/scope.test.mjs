import { lstatSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  discoverInScopeFiles,
  globToRegExp,
  isExcluded,
  isInScope,
  SCOPE_EXCLUDE,
  SCOPE_INCLUDE,
  SCOPE_STRATA,
  stratumFor,
} from './scope.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const privateTestPath = (dir, stem) => `${dir}/${stem}.private.test.ts`;

describe('glob compilation', () => {
  const cases = [
    ['packages/**/src/**/*.ts', 'packages/app/src/lib/a.ts', true],
    ['packages/**/src/**/*.ts', 'packages/core/src/a.ts', true],
    ['packages/**/src/**/*.ts', 'packages/app/tests/a.ts', false],
    ['**/*.d.ts', 'docs/next-env.d.ts', true],
    ['**/*.d.ts', 'a.d.ts', true],
    ['**/*.d.mts', 'docs/next-env.d.mts', true],
    ['**/*.d.cts', 'docs/lib/types.d.cts', true],
    ['**/*.d.mts', 'docs/vitest.real-source.config.mts', false],
    ['*.ts', 'oxlint.config.ts', true],
    ['*.ts', 'docs/tailwind.config.ts', false],
    ['*.ts', 'vitest.scripts.config.mts', false],
    ['docs/**/*.mts', 'docs/vitest.real-source.config.mts', true],
    ['**/*.private.*', privateTestPath('packages/core/src', 'a'), true],
  ];

  test.each(cases)('%s vs %s is %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});

describe('scope membership', () => {
  const inScope = [
    'packages/app/src/components/Foo.tsx',
    'packages/core/src/index.ts',
    'packages/desktop/tests/integration/a.ts',
    'scripts/comment-fidelity.mjs',
    '.github/scripts/bridge-public-pr-to-monorepo.mjs',
    'docs/tailwind.config.ts',
    'docs/vitest.real-source.config.mts',
    'docs/lib/a.cts',
    'oxlint.config.ts',
    'vitest.scripts.config.mts',
  ];
  const outOfScope = [
    'knip.config.ts',
    'packages/md-conformance/md-audit/src/lib/tags.ts',
    'packages/app/tests/fidelity/invariant-i17.test.ts',
    'packages/desktop/tests/lume-qa/orchestrator.ts',
    privateTestPath('packages/core/src/markdown', 'a'),
    'packages/app/src/locales/en/messages.ts',
    'docs/next-env.d.ts',
    'docs/next-env.d.mts',
    'docs/lib/types.d.cts',
    'types.d.mts',
    'lint-plugins/no-comments/__fixtures__/must-fire.fixture.ts',
    'packages/app/src/lib/a.mjs',
    'packages/app/node_modules/x/src/a.ts',
    'test-support/vitest.base.ts',
  ];

  test.each(inScope)('%s is in scope', (path) => expect(isInScope(path)).toBe(true));
  test.each(outOfScope)('%s is out of scope', (path) => expect(isInScope(path)).toBe(false));

  test('a windows-style path is normalised before matching', () => {
    expect(isInScope('packages\\app\\src\\a.ts')).toBe(true);
  });

  test('the fixture corpus is excluded so the gate cannot self-trip', () => {
    expect(SCOPE_EXCLUDE).toContain('**/__fixtures__/**');
    expect(SCOPE_EXCLUDE).toContain('**/*.fixture.ts');
  });
});

describe('discovery over the real tree', () => {
  const discovered = discoverInScopeFiles(REPO_ROOT, { readdirSync, statSync, lstatSync });

  test('discovery finds a substantial corpus', () => {
    expect(discovered.length).toBeGreaterThan(1000);
  });

  test.each(SCOPE_STRATA.map((s) => s.id))('stratum %s is non-vacuous', (id) => {
    expect(discovered.filter((path) => stratumFor(path) === id).length).toBeGreaterThan(0);
  });

  test('every discovered file belongs to exactly one declared stratum', () => {
    expect(discovered.filter((path) => stratumFor(path) === null)).toEqual([]);
  });

  test('no excluded tree leaks into discovery', () => {
    const leaks = discovered.filter(
      (path) =>
        path.includes('node_modules/') ||
        path.includes('/dist/') ||
        path.includes('.private.') ||
        path.includes('md-conformance/') ||
        /\.d\.[mc]?ts$/.test(path),
    );
    expect(leaks).toEqual([]);
  });
});

describe('the scope definition is derived, not restated', () => {
  test('SCOPE_INCLUDE is exactly the union of the declared strata', () => {
    expect(SCOPE_INCLUDE).toEqual(SCOPE_STRATA.flatMap((stratum) => stratum.include));
  });

  test('isExcluded reports the exclusion independently of the include set', () => {
    expect(isExcluded('packages/md-conformance/anything.ts')).toBe(true);
    expect(isExcluded('README.md')).toBe(false);
    expect(isInScope('README.md')).toBe(false);
  });
});

test('globToRegExp refuses syntax it does not implement instead of mis-compiling it', () => {
  for (const glob of [
    'packages/**/{src,tests}/**/*.ts',
    'packages/**/*.?s',
    '!packages/foo/**',
    'src/[abc]/*.ts',
  ]) {
    expect(() => globToRegExp(glob), glob).toThrow(/unsupported glob syntax/);
  }
});
