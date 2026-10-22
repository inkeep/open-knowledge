import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';
import fixtureUrl from '../__fixtures__/no-redundant-jsx-element-braces.fixture.tsx?url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-redundant-jsx-element-braces';
const CODE = `ok(${RULE})`;
const BUILT_IN = 'react(jsx-curly-brace-presence)';
const FIXTURE = fixtureUrl.replace(/^\//, '');
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 4 lone-element braces that carry a comment, and on no other braces', () => {
    const fires = lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
    expect(fires.map((fire) => fire.position)).toEqual(['21:7', '37:7', '51:7', '61:15']);
    for (const fire of fires) {
      expect(fire.message).toContain('Delete the braces');
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(DOCS);
    }
  });

  test('the built-in rule reports the comment-free lone elements that this rule leaves to it', () => {
    const fires = lintOkRulesFixture(FIXTURE).filter((d) => d.code === BUILT_IN);
    expect(fires.map((fire) => fire.position)).toEqual(['81:14', '104:9']);
  });

  test('rule is registered, enabled, and deliberately unscoped', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
  });
});
