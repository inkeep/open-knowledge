/** The `no-blind-agent-host-fanout` oxlint rule fixture test, per precedent #42. */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FORBIDDEN_SPECS } from '../../../../lint-plugins/ok-rules/rules/no-blind-agent-host-fanout.mjs';
import {
  oxlintFixtureArgs,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../../test-support/read-ok-rules-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/no-blind-agent-host-fanout.fixture.tsx';

describe('no-blind-agent-host-fanout oxlint rule', () => {
  test('fires on exactly 5 planted positives (and on no negative case)', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (
      output.match(/User-global skill installs must be gated on detected hosts/g) ?? []
    ).length;
    expect(fires).toBe(5);
    expect(output).toContain('detectUserSkillHosts');
    expect(output).toContain('HOSTS_WITH_USER_SKILL_DIR');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-blind-agent-host-fanout');
  });

  test('rule is registered, enabled, and scoped via its RULE_SCOPES entry', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-blind-agent-host-fanout');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-blind-agent-host-fanout');
    expect(readRuleScope(REPO_ROOT, 'no-blind-agent-host-fanout')).not.toEqual([]);
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'no-blind-agent-host-fanout');
    expect(scope).toContain(FIXTURE_REL);
    expect(scope).toContain('packages/server/src/**/*.ts');
    expect(scope).toContain('packages/cli/src/**/*.ts');
    for (const excluded of ['!**/*.test.ts', '!**/*.test-helper.ts']) {
      expect(scope).not.toContain(excluded);
    }
  });

  test('bans every range shape of the spec, not just the one that shipped', () => {
    const matched = [...FORBIDDEN_SPECS].sort();
    expect(matched.length).toBeGreaterThan(0);
    for (const spec of ['skills@~1.5.0', 'skills@^1.5.0', 'skills@1.5.0', 'skills@latest']) {
      expect(matched).toContain(spec);
    }
    expect(matched).toContain('--agent');
  });
});
