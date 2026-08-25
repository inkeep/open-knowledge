/**
 * The contributor bridge decides, per job, whether a public PR is a community
 * contribution or this repo talking to itself through Copybara. Getting that
 * wrong in the quiet direction costs a contributor their PR: no acknowledgement,
 * no import into agents-private, and no signal anywhere that it happened.
 *
 * GitHub Actions expressions cannot be executed locally, so these assert the
 * SHAPE of each `if:` — which is exactly what a well-meaning simplification
 * would flatten without any test noticing.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'monorepo-pr-bridge.yml');
const bridge = readFileSync(WORKFLOW, 'utf8');

/** The `if:` expression of one job, comments stripped and folded to one line. */
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
    // A fork picks its own branch name, so `head.ref != 'copybara/sync'` alone is
    // a check a stranger can fail on purpose or by accident. Only this repo can
    // own the head repository.
    expect(jobCondition(job)).toMatch(/github\.event\.pull_request\.head\.repo\.full_name != github\.repository/);
  });

  test.each(JOBS)('%s never tests the branch name outside the provenance group', (job) => {
    const condition = jobCondition(job);
    const group = /\(github\.event\.pull_request\.head\.repo\.full_name != github\.repository \|\| github\.event\.pull_request\.head\.ref != 'copybara\/sync'\)/;
    expect(condition).toMatch(group);
    // Exactly one mention of the branch, and it is the one inside the group.
    expect(condition.match(/head\.ref != 'copybara\/sync'/g)).toHaveLength(1);
  });

  test.each(JOBS)('%s parenthesises the provenance group, which is load-bearing', (job) => {
    // `&&` binds tighter than `||` in Actions expressions, so dropping the parens
    // regroups `action == X && repo != self || ref != branch` into
    // `(action == X && repo != self) || ref != branch` — which is TRUE for every
    // ordinary PR regardless of `action`, so `acknowledge` would fire on
    // synchronize, edited and every other event rather than only on `opened`.
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
    // The environment is the manual approval that gates minting the
    // agents-private App token. `acknowledge` is deliberately outside it so a
    // contributor hears back immediately; moving it inside would make every
    // public PR wait on a maintainer before receiving any response at all.
    expect(bridge.match(/environment: inkeep-oss-sync/g)).toHaveLength(1);
    const sync = bridge.split(/^  sync:$/m)[1];
    expect(sync).toMatch(/environment: inkeep-oss-sync/);
  });

  test('no job checks out the contributor branch', () => {
    // `pull_request_target` runs with repository secrets in scope. Every checkout
    // here must resolve to base-branch code or to agents-private explicitly;
    // fetching the fork's head is what would turn this into arbitrary execution
    // with the OSS_SYNC token in the environment.
    const directives = bridge
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(directives).not.toMatch(/ref:\s*\$\{\{\s*github\.event\.pull_request\.head/);
    expect(directives).not.toMatch(/ref:\s*\$\{\{\s*github\.event\.pull_request\.merge_commit_sha/);
  });
});
