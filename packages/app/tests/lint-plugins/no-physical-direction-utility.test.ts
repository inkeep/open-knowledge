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

// __dirname → packages/app/tests/lint-plugins/. Repo root is 4 levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-physical-direction-utility.fixture.tsx';
const PLUGIN_REL = './biome-plugins/no-physical-direction-utility.grit';

function checkFixture(): string {
  const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  // Surface a spawn failure explicitly: without this, `status` is null on a
  // `pnpm exec` spawn error and the `not.toBe(0)` below passes vacuously,
  // masking the failure as "0 diagnostics".
  expect(result.error).toBeUndefined();
  // biome check exits non-zero when any diagnostic (incl. plugin) fires.
  expect(result.status).not.toBe(0);
  return `${result.stdout}\n${result.stderr}`;
}

function countMatches(output: string, pattern: RegExp): number {
  return (output.match(pattern) ?? []).length;
}

/**
 * The source lines biome marked with `>` — the span it reported, without the
 * two lines of context it prints on either side. Asserting against the context
 * instead would let a negative case pass merely by sitting near a positive one.
 */
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
      'ml-2 flex items-center', // plain string
      "isCompact && 'pr-1.5'", // reached through a multi-line cn()
      'absolute top-2 right-2', // inset
      'pl-[var(--ok-example-reserve,1rem)]', // arbitrary value
      'ml-auto shrink-0', // the `auto` keyword
      'containerClassName="bottom-3 left-3', // a *ClassName prop
      'sm:-mr-1', // variant prefix + negative margin
    ]) {
      expect(flagged).toContain(token);
    }
  });

  test('no negative case is reported', () => {
    const flagged = flaggedSource(checkFixture());
    for (const token of [
      'ms-2 me-1.5 ps-6 pe-2', // the logical forms
      'start-0 end-2', // logical inset
      'inset-x-0', // Tailwind v4 compiles this to inset-inline
      'left-1/2', // the centering anchor, cancelled by the translate beside it
      'mt-2 mb-2 inset-0', // spacing with no side
      'data-side=left', // a side named inside a variant selector
      'edge="right"', // a side carried by a prop that isn't a class string
      // The three below match the VALUE pattern and are excluded by the name
      // predicate alone — they are what holds it in place.
      'data-token="ml-4"',
      'title="Row indent is pl-2"',
      'token="pr-1.5"',
    ]) {
      expect(flagged).not.toContain(token);
    }
  });

  test('the diagnostic names the fix and links this rule section of the docs', () => {
    const output = checkFixture();
    // Fix-noun: the action a reader applies to make the message go away.
    expect(output).toContain('Use the logical equivalent');
    // Docs URL — generic URL regex + anchor substring. The anchor check keeps
    // the regex from being vacuously satisfied by an unrelated URL biome might
    // surface elsewhere.
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-physical-direction-utilitygrit');
  });

  test('plugin is registered as an override scoped to the chrome (not workspace-wide)', () => {
    const config = readBiomeConfig(REPO_ROOT);
    // NOT at root plugins[] — a workspace-wide promotion would fire on the docs
    // site and on every package whose layout has no reading direction to follow.
    const rootPlugins: string[] = config.plugins ?? [];
    expect(rootPlugins).not.toContain(PLUGIN_REL);

    const overrides: Array<{ includes?: string[]; plugins?: string[] }> = config.overrides ?? [];
    const entry = overrides.find((o) => (o.plugins ?? []).includes(PLUGIN_REL));
    expect(entry).toBeDefined();
    const includes = entry?.includes ?? [];
    // The fixture must be in scope so the firing tests above can trigger the rule.
    expect(includes).toContain(FIXTURE_REL);
    for (const included of [
      'packages/app/src/**/*.tsx',
      'packages/desktop/src/**/*.tsx',
      'packages/plugin/src/**/*.tsx',
    ]) {
      expect(includes).toContain(included);
    }
    // Assert the negative set too, so a removed exclusion is caught here rather
    // than as a wall of diagnostics on the next unrelated lint run.
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
