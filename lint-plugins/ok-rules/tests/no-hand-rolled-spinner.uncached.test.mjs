import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-hand-rolled-spinner';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 5 hand-rolled spins, by its own code, and on no negative case', () => {
    const found = fires();
    expect(found.map((fire) => fire.position)).toEqual([
      '28:25',
      '33:25',
      '38:33',
      '44:25',
      '57:17',
    ]);
    for (const fire of found) {
      expect(fire.message).toContain('Hand-rolled loading spinner');
      expect(fire.message).toContain('@/components/ui/spinner');
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(DOCS);
    }
  });

  test('rule is registered, enabled, and deliberately unscoped', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
  });

  test('the word boundary admits a suffixed variant but not a longer token', () => {
    const source = readFileSync(join(REPO_ROOT, FIXTURE), 'utf-8').split('\n');
    const flagged = fires()
      .map((fire) => source[Number(fire.position.split(':')[0]) - 1])
      .join('\n');
    expect(flagged).toContain('animate-spin-slow');
    expect(flagged).not.toContain('animate-spinner');
  });
});
