import { existsSync, readFileSync } from 'node:fs';
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
const RULE = 'no-sentinel-signal-target';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const README = 'lint-plugins/ok-rules/README.md';
const DOCS = `${README}#${RULE}`;
const BRANCHES = [
  ['literal', 'Signal only a pid you spawned'],
  ['fallback', 'Filter the nullable pid out'],
  ['parsed', 'Signal the `ChildProcess` you spawned'],
];

function branchOf(message) {
  return BRANCHES.find(([, marker]) => message.includes(marker))?.[0] ?? 'unknown';
}

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 20 positive cases, each on its branch, by its own code', () => {
    const found = fires();
    expect(found.map((fire) => `${fire.position} ${branchOf(fire.message)}`)).toEqual([
      '61:19 literal',
      '62:19 literal',
      '63:19 literal',
      '64:19 fallback',
      '65:19 fallback',
      '66:19 parsed',
      '67:19 parsed',
      '68:19 literal',
      '69:19 literal',
      '70:20 fallback',
      '71:20 literal',
      '72:20 literal',
      '73:20 fallback',
      '74:20 parsed',
      '75:20 parsed',
      '76:20 parsed',
      '77:20 parsed',
      '78:20 literal',
      '79:20 literal',
      '80:20 literal',
    ]);
    for (const fire of found) {
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(DOCS);
    }
  });

  test('the literal remedy sanctions a handle-derived pid negated for its group and names the detached precondition', () => {
    const literal = fires().filter((fire) => branchOf(fire.message) === 'literal');
    expect(literal.length).toBe(10);
    for (const fire of literal) {
      expect(fire.message).toContain('its pid taken from that handle');
      expect(fire.message).toContain('negated for the group only if you spawned it detached');
    }
  });

  test('the parsed remedy names the handle you spawned and, for a pid you hold no handle for, its owner or a report', () => {
    const parsed = fires().filter((fire) => branchOf(fire.message) === 'parsed');
    expect(parsed.length).toBe(6);
    for (const fire of parsed) {
      expect(fire.message).toContain('stop that process through its owner, or report it');
    }
  });

  test('every fire lands on a positive case and none on the negatives', () => {
    const source = readFileSync(join(REPO_ROOT, FIXTURE), 'utf8').split('\n');
    const found = fires();
    expect(found.length).toBe(20);
    for (const fire of found) {
      expect(source[Number(fire.position.split(':')[0]) - 1]).toMatch(/^export const p\d+ = /);
    }
  });

  test('rule is registered, enabled at error, and carries no scope entry — the registration wrapper rejects a rule that is in neither table, so an empty scope means workspace-wide', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
    expect(readRuleScope(REPO_ROOT, RULE)).toEqual([]);
  });

  test('the README carries a heading for the rule, and the rule module exists', () => {
    const readme = readFileSync(join(REPO_ROOT, README), 'utf8');
    expect(readme).toContain(`### \`${RULE}\``);
    expect(existsSync(join(REPO_ROOT, `lint-plugins/ok-rules/rules/${RULE}.mjs`))).toBe(true);
  });
});
