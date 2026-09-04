/**
 * no-physical-direction-utility — Biome GritQL plugin fixture test.
 *
 * Plugin:  `biome-plugins/no-physical-direction-utility.grit`
 * Fixture: `biome-plugins/__fixtures__/no-physical-direction-utility.fixture.tsx`
 *
 * Per precedent #42 (custom Biome enforcement is GritQL plugins). The rule keeps
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
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readBiomeConfig } from '../../../../test-support/read-biome-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-physical-direction-utility.fixture.tsx';
const PLUGIN_REL = './biome-plugins/no-physical-direction-utility.grit';

function checkFixture(): string {
  const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
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
  return (output.match(/^\s*>\s*\d+ │ .*$/gm) ?? [])
    .map((line) => line.replace(/^[^│]*│ /, ''))
    .join('\n');
}

describe('no-physical-direction-utility GritQL plugin', () => {
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
    expect(output).toContain('biome-plugins/README.md#no-physical-direction-utilitygrit');
  });

  test('plugin is registered as an override scoped to the chrome (not workspace-wide)', () => {
    const config = readBiomeConfig(REPO_ROOT);
    const rootPlugins: string[] = config.plugins ?? [];
    expect(rootPlugins).not.toContain(PLUGIN_REL);

    const overrides: Array<{ includes?: string[]; plugins?: string[] }> = config.overrides ?? [];
    const entry = overrides.find((o) => (o.plugins ?? []).includes(PLUGIN_REL));
    expect(entry).toBeDefined();
    const includes = entry?.includes ?? [];
    expect(includes).toContain(FIXTURE_REL);
    for (const included of [
      'packages/app/src/**/*.tsx',
      'packages/desktop/src/**/*.tsx',
      'packages/plugin/src/**/*.tsx',
    ]) {
      expect(includes).toContain(included);
    }
    for (const excluded of [
      '!packages/app/src/editor/**',
      '!packages/app/src/components/ui/**',
      '!**/*.test.tsx',
      '!**/*.dom.test.tsx',
    ]) {
      expect(includes).toContain(excluded);
    }
  });
});
