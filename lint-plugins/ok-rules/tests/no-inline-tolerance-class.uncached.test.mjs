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
import { MATCHED_FIDELITY_CLASSES } from '../rules/no-inline-tolerance-class.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-inline-tolerance-class';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 8 inline fidelity-class literals, by its own code, and on no negative case', () => {
    const found = fires();
    expect(found.map((fire) => fire.position)).toEqual([
      '30:18',
      '33:5',
      '34:5',
      '35:5',
      '36:5',
      '39:24',
      '41:31',
      '43:31',
    ]);
    for (const fire of found) {
      expect(fire.message).toContain('Inline bridge normalization-class value in a public test');
      expect(fire.message).toContain('hard-coding a BRIDGE_TOLERANCE_CLASSES label');
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(DOCS);
    }
  });

  test('rule is registered, enabled, and scoped to the public test surface', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    expect(readRuleScope(REPO_ROOT, RULE).sort()).toEqual(
      [
        'packages/**/*.test.ts',
        'packages/**/*.test.tsx',
        'packages/**/*.e2e.ts',
        '!packages/md-conformance/**',
        '!packages/app/tests/fidelity/**',
        '!packages/core/src/markdown/**/*.test.ts',
        '!packages/core/src/bridge/**/*.test.ts',
        '!**/*.private.*',
        FIXTURE,
      ].sort(),
    );
  });

  test('matched fidelity set + universal-encoding set partition BRIDGE_TOLERANCE_CLASSES', () => {
    const universalEncoding = ['bom', 'crlf', 'trailing-whitespace', 'trailing-newline'];
    const catalogSrc = readFileSync(
      join(REPO_ROOT, 'packages/core/src/bridge/normalize.ts'),
      'utf-8',
    );
    const arrayBody = catalogSrc.match(/BRIDGE_TOLERANCE_CLASSES\s*=\s*\[([\s\S]*?)\]/)?.[1];
    expect(arrayBody).toBeDefined();
    const catalog = [...(arrayBody ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(catalog.length).toBeGreaterThan(0);
    const matched = [...MATCHED_FIDELITY_CLASSES].sort();
    expect(matched.filter((c) => universalEncoding.includes(c))).toEqual([]);
    expect([...new Set([...matched, ...universalEncoding])].sort()).toEqual(catalog);
  });
});
