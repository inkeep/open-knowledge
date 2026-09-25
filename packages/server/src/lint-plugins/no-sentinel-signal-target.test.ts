import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
const RULE = 'no-sentinel-signal-target';
const FIXTURE_REL = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const README_REL = 'lint-plugins/ok-rules/README.md';
const AGENTS_REL = 'AGENTS.md';

function lintFixture() {
  const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(typeof result.status).toBe('number');
  expect(result.status).not.toBe(0);
  const output = `${result.stdout}\n${result.stderr}`;
  return parseOxlintDiagnostics(output).filter((d) => d.code === `ok(${RULE})`);
}

describe('no-sentinel-signal-target oxlint rule', () => {
  test('fires exactly 20 times, split 10 literal / 4 fallback / 6 parsed, and on no negative case', () => {
    const fires = lintFixture();
    expect(fires.length).toBe(20);
    const literal = fires.filter((d) => d.message.includes('Signal only a pid you spawned'));
    const fallback = fires.filter((d) => d.message.includes('Filter the nullable pid out'));
    const parsed = fires.filter((d) => d.message.includes('Signal the `ChildProcess` you spawned'));
    expect(literal.length).toBe(10);
    expect(fallback.length).toBe(4);
    expect(parsed.length).toBe(6);
    for (const fire of fires) {
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(`${README_REL}#${RULE}`);
    }
  });

  test('the literal remedy sanctions a handle-derived pid negated for its group and names the detached precondition, in the diagnostic and the README alike', () => {
    const literal = lintFixture().filter((d) =>
      d.message.includes('Signal only a pid you spawned'),
    );
    expect(literal.length).toBe(10);
    for (const fire of literal) {
      expect(fire.message).toContain('its pid taken from that handle');
      expect(fire.message).toContain('negated for the group only if you spawned it detached');
    }
    const readme = readFileSync(join(REPO_ROOT, README_REL), 'utf8');
    expect(readme).toContain('only if you spawned it detached');
  });

  test('the parsed remedy names the handle you spawned and, for a pid you hold no handle for, its owner or a report, in the diagnostic and the README alike', () => {
    const parsed = lintFixture().filter((d) =>
      d.message.includes('Signal the `ChildProcess` you spawned'),
    );
    expect(parsed.length).toBe(6);
    for (const fire of parsed) {
      expect(fire.message).toContain('stop that process through its owner, or report it');
    }
    const readme = readFileSync(join(REPO_ROOT, README_REL), 'utf8');
    expect(readme).toContain('Stop that process through its owner, or report it');
  });

  test('every fire lands on a positive case and none on the negatives', () => {
    const source = readFileSync(join(REPO_ROOT, FIXTURE_REL), 'utf8').split('\n');
    const firedLines = lintFixture()
      .map((d) => d.labels?.[0]?.span?.line)
      .filter((line): line is number => typeof line === 'number');
    expect(firedLines.length).toBe(20);
    for (const line of firedLines) {
      expect(source[line - 1]).toMatch(/^export const p\d+ = /);
    }
  });

  test('rule is registered, enabled at error, and carries no scope entry — the registration wrapper rejects a rule that is in neither table, so an empty scope means workspace-wide', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
    expect(readRuleScope(REPO_ROOT, RULE)).toEqual([]);
  });

  test('the prose and the rule cite each other and the cited README heading exists', () => {
    const readme = readFileSync(join(REPO_ROOT, README_REL), 'utf8');
    expect(readme).toContain(`### \`${RULE}\``);
    expect(readme).toContain('Never signal a pid you did not spawn');
    const agents = readFileSync(join(REPO_ROOT, AGENTS_REL), 'utf8');
    expect(agents).toContain('Never signal a pid you did not spawn');
    expect(agents).toContain(`ok/${RULE}`);
    expect(existsSync(join(REPO_ROOT, `lint-plugins/ok-rules/rules/${RULE}.mjs`))).toBe(true);
  });
});
