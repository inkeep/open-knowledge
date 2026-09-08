/**
 * no-physical-direction-utility — oxlint rule fixture test.
 *
 * Rule:  `lint-plugins/ok-rules/rules/no-physical-direction-utility.mjs`
 * Fixture: `lint-plugins/ok-rules/__fixtures__/no-physical-direction-utility.fixture.tsx`
 *
 * Per precedent #42 (custom lint enforcement is oxlint JS-plugin rules). The rule keeps
 * left-to-right assumptions from hardening into the chrome while right-to-left
 * layout is deferred — the plumbing is inert without an RTL locale, but the rule
 * works every day.
 *
 * The fixture pairs 7 positive cases (plain string, multi-line `cn()`, inset,
 * arbitrary value, `auto`, a `*ClassName` prop, a prefixed negative margin) with
 * 6 negative groups (the logical forms, `inset-x-*`, the `left-1/2` centering
 * anchor, side-free spacing, a side named outside a utility, and well-formed
 * utilities sitting in attributes that are not class props). Exact equality
 * catches a weakened pattern (count drops) and a widened one (a negative starts
 * firing). The rule has a single branch, so a total alone would still pass if one
 * positive went silent while one negative began firing — the flagged-line
 * assertions below close that by naming what must and must not be reported.
 *
 * Negative group 6 exists because every other case clears the rule on its VALUE:
 * remove the name predicate that scopes the rule to class props and the fixture
 * count does not move, so nothing would hold that predicate in place. Those three
 * attributes match the value pattern and are excluded by the name alone.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  oxlintFixtureArgs,
  parseOxlintDiagnostics,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../../test-support/read-ok-rules-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/no-physical-direction-utility.fixture.tsx';

function checkFixture(): string {
  const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  return `${result.stdout}\n${result.stderr}`;
}

function countMatches(output: string, pattern: RegExp): number {
  return (output.match(pattern) ?? []).length;
}

function flaggedSource(output: string): string {
  const fixture = readFileSync(join(REPO_ROOT, FIXTURE_REL), 'utf-8').split('\n');
  const lines = parseOxlintDiagnostics(output)
    .filter((d) => d.code === 'ok(no-physical-direction-utility)')
    .map((d) => d.labels?.[0]?.span?.line)
    .filter((n): n is number => typeof n === 'number');
  expect(lines.length).toBeGreaterThan(0);
  return lines.map((n) => fixture.slice(n - 1, n + 2).join('\n')).join('\n');
}

describe('no-physical-direction-utility oxlint rule', () => {
  test('fires on exactly 7 physical direction utilities (and on no negative case)', () => {
    expect(countMatches(checkFixture(), /Physical direction utility/g)).toBe(7);
  });

  test('every positive case is reported', () => {
    const flagged = flaggedSource(checkFixture());
    for (const token of [
      'ml-2 flex items-center',
      "isCompact && 'pr-1.5'",
      'absolute top-2 right-2',
      'pl-[var(--ok-example-reserve,1rem)]',
      'ml-auto shrink-0',
      'containerClassName="bottom-3 left-3',
      'sm:-mr-1',
    ]) {
      expect(flagged).toContain(token);
    }
  });

  test('no negative case is reported', () => {
    const flagged = flaggedSource(checkFixture());
    for (const token of [
      'ms-2 me-1.5 ps-6 pe-2',
      'start-0 end-2',
      'inset-x-0',
      'left-1/2',
      'mt-2 mb-2 inset-0',
      'data-side=left',
      'edge="right"',
      'data-token="ml-4"',
      'title="Row indent is pl-2"',
      'token="pr-1.5"',
    ]) {
      expect(flagged).not.toContain(token);
    }
  });

  test('the diagnostic names the fix and links this rule section of the docs', () => {
    const output = checkFixture();
    expect(output).toContain('Use the logical equivalent');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-physical-direction-utility');
  });

  test('rule is registered, enabled, and scoped to the chrome', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-physical-direction-utility');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-physical-direction-utility');
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'no-physical-direction-utility');
    expect(scope.sort()).toEqual(
      [
        'packages/app/src/**/*.tsx',
        'packages/desktop/src/**/*.tsx',
        'packages/plugin/src/**/*.tsx',
        '!packages/app/src/editor/**',
        '!packages/app/src/components/ui/**',
        '!**/*.test.tsx',
        '!**/*.dom.test.tsx',
        'lint-plugins/ok-rules/__fixtures__/no-physical-direction-utility.fixture.tsx',
      ].sort(),
    );
  });
});
