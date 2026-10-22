import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';
import fixtureUrl from '../__fixtures__/no-empty-jsx-expression.fixture.tsx?url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-empty-jsx-expression';
const CODE = `ok(${RULE})`;
const FIXTURE = fixtureUrl.replace(/^\//, '');
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 3 empty braces, with the delete message', () => {
    const fires = lintOkRulesFixture(FIXTURE).filter(
      (d) => d.code === CODE && d.message.startsWith('Empty JSX expression'),
    );
    expect(fires.map((fire) => fire.position)).toEqual(['19:7', '29:15', '36:15']);
    for (const fire of fires) {
      expect(fire.message).toContain('Delete the braces');
      expect(fire.message).toContain(DOCS);
    }
  });

  test('fires at exactly its 3 comment braces, and on no single directive that has no other place', () => {
    const fires = lintOkRulesFixture(FIXTURE).filter(
      (d) => d.code === CODE && !d.message.startsWith('Empty JSX expression'),
    );
    expect(fires.map((fire) => fire.position)).toEqual(['41:15', '49:7', '61:7']);
    for (const fire of fires) {
      expect(fire.message).toContain('between an element');
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(DOCS);
    }
  });

  test('rule is registered, enabled, and deliberately unscoped', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
  });
});
