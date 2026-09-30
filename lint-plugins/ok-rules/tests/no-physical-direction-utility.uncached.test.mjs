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
const RULE = 'no-physical-direction-utility';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 7 physical direction utilities, by its own code, and on no negative case', () => {
    const found = fires();
    expect(found.map((fire) => fire.position)).toEqual([
      '25:25',
      '33:17',
      '43:25',
      '49:25',
      '55:25',
      '61:36',
      '67:25',
    ]);
    for (const fire of found) {
      expect(fire.message).toContain('Physical direction utility');
      expect(fire.message).toContain('Use the logical equivalent');
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(DOCS);
    }
  });

  test('rule is registered, enabled, and scoped to the chrome', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    expect(readRuleScope(REPO_ROOT, RULE).sort()).toEqual(
      [
        'packages/app/src/**/*.tsx',
        'packages/desktop/src/**/*.tsx',
        'packages/plugin/src/**/*.tsx',
        '!packages/app/src/editor/**',
        '!packages/app/src/components/ui/**',
        '!**/*.test.tsx',
        '!**/*.dom.test.tsx',
        FIXTURE,
      ].sort(),
    );
  });

  function flaggedSource() {
    const fixture = readFileSync(join(REPO_ROOT, FIXTURE), 'utf-8').split('\n');
    const lines = fires().map((fire) => Number(fire.position.split(':')[0]));
    expect(lines.length).toBeGreaterThan(0);
    return lines.map((n) => fixture.slice(n - 1, n + 2).join('\n')).join('\n');
  }

  test('every positive case is reported', () => {
    const flagged = flaggedSource();
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
    const flagged = flaggedSource();
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
});
