import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'monorepo-pr-bridge.yml');
const bridge = readFileSync(WORKFLOW, 'utf8');

function jobCondition(name) {
  const body = bridge.split(new RegExp(`^  ${name}:$`, 'm'))[1];
  expect(body, `job ${name} exists`).toBeDefined();
  const ifBlock = /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(body);
  expect(ifBlock, `job ${name} declares a folded if:`).not.toBeNull();
  return ifBlock[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .join(' ');
}

const JOBS = ['acknowledge', 'sync', 'close'];

describe('the bridge identifies Copybara PRs by provenance, not by a forgeable name', () => {
  test.each(JOBS)('%s keys on the head repository', (job) => {
    expect(jobCondition(job)).toMatch(/github\.event\.pull_request\.head\.repo\.full_name != github\.repository/);
  });

  test.each(JOBS)('%s never tests the branch name outside the provenance group', (job) => {
    const condition = jobCondition(job);
    const group = /\(github\.event\.pull_request\.head\.repo\.full_name != github\.repository \|\| github\.event\.pull_request\.head\.ref != 'copybara\/sync'\)/;
    expect(condition).toMatch(group);
    expect(condition.match(/head\.ref != 'copybara\/sync'/g)).toHaveLength(1);
  });

  test.each(JOBS)('%s parenthesises the provenance group, which is load-bearing', (job) => {
    const condition = jobCondition(job);
    const actionClause = /github\.event\.action [!=]= 'closed'|github\.event\.action == 'opened'/;
    expect(condition).toMatch(actionClause);
    const groupStart = condition.indexOf('(github.event.pull_request.head.repo.full_name');
    const actionIndex = condition.search(actionClause);
    expect(groupStart, 'the provenance group is parenthesised').toBeGreaterThan(-1);
    expect(actionIndex, 'the action clause precedes the group it is ANDed with').toBeLessThan(groupStart);
  });
});

describe('the bridge keeps the properties the approval gate depends on', () => {
  test('only the sync job sits behind the inkeep-oss-sync environment', () => {
    expect(bridge.match(/environment: inkeep-oss-sync/g)).toHaveLength(1);
    const sync = bridge.split(/^  sync:$/m)[1];
    expect(sync).toMatch(/environment: inkeep-oss-sync/);
  });

  test('no job checks out the contributor branch', () => {
    const directives = bridge
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(directives).not.toMatch(/ref:\s*\$\{\{\s*github\.event\.pull_request\.head/);
    expect(directives).not.toMatch(/ref:\s*\$\{\{\s*github\.event\.pull_request\.merge_commit_sha/);
  });
});
