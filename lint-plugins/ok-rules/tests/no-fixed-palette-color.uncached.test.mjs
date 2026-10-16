import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-fixed-palette-color';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 7 fixed hues, by its own code', () => {
    const found = fires();
    expect(found.map((fire) => Number(fire.position.split(':')[0]))).toEqual([
      17, 22, 27, 32, 36, 39, 39,
    ]);
    for (const fire of found) {
      expect(fire.message).toContain('Fixed Tailwind hue');
      expect(fire.message).toContain('theme token');
      expect(fire.message).toContain(DOCS);
    }
  });

  test('rule is registered and enabled', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
  });

  test("its scope is the three UI packages' sources, minus tests and test helpers", () => {
    expect(readRuleScope(REPO_ROOT, RULE).sort()).toEqual(
      [
        'packages/app/src/**/*.ts',
        'packages/app/src/**/*.tsx',
        'packages/desktop/src/**/*.ts',
        'packages/desktop/src/**/*.tsx',
        'packages/plugin/src/**/*.ts',
        'packages/plugin/src/**/*.tsx',
        '!**/*.test.ts',
        '!**/*.test.tsx',
        '!**/*.dom.test.tsx',
        '!**/*.test-helper.ts',
        '!**/*.test-helper.tsx',
        FIXTURE,
      ].sort(),
    );
  });

  test('every flagged line is a positive case, and no negative case is flagged', () => {
    const fixture = readFileSync(join(REPO_ROOT, FIXTURE), 'utf-8').split('\n');
    const flaggedLines = new Set(fires().map((fire) => Number(fire.position.split(':')[0])));
    const flagged = [...flaggedLines].map((line) => fixture[line - 1]).join('\n');
    for (const token of [
      'text-emerald-700',
      'dark:bg-amber-950',
      "'bg-green-500'",
      'hover:border-rose-500/40',
      'ring-violet-400/60',
      'inset-ring-emerald-500',
      'drop-shadow-red-500/50',
    ]) {
      expect(flagged).toContain(token);
    }
    for (const token of [
      'text-success',
      'text-neutral-900',
      "'--color-red-500'",
      "'legacy-text-red-500'",
      "'text-red-500-legacy'",
    ]) {
      const line = fixture.findIndex((text) => text.includes(token)) + 1;
      expect(line, token).toBeGreaterThan(0);
      expect(flaggedLines.has(line), token).toBe(false);
    }
  });
});
