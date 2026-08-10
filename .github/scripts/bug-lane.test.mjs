import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';
import { evaluateBugLane, makeIsInStable } from './bug-lane.mjs';

const FIX_A = 'a'.repeat(40);
const FIX_B = 'b'.repeat(40);
const FEAT = 'c'.repeat(40);
const SHIPPED = 'd'.repeat(40);

const cs = (id, bump, addingSha, addingSubject = `${id} subject (#100)`) => ({
  id,
  bump,
  addingSha,
  addingSubject,
});

const bugIssues = { issues: [{ identifier: 'PRD-1', labels: ['Bug', 'ok:ui'] }] };
const plainIssues = { issues: [{ identifier: 'PRD-2', labels: ['ok:ui'] }] };

const evaluate = (overrides = {}) =>
  evaluateBugLane({
    pendingChangesets: [cs('one', 'patch', FIX_A)],
    isInStable: () => false,
    resolveChangesetPrUrl: (id) => `https://github.com/inkeep/agents-private/pull/${id.length}`,
    resolveIssuesForUrl: async () => bugIssues,
    ...overrides,
  });

describe('evaluateBugLane', () => {
  test('a patch-only bug-linked commit qualifies', async () => {
    const r = await evaluate();
    expect(r.fixRefs).toEqual([FIX_A]);
    expect(r.reason).toBe('candidates');
    expect(r.perCommit[0]).toMatchObject({ qualifies: true, linkedIssues: ['PRD-1'] });
  });

  test('a commit adding any minor changeset is feature work and stays with its cycle', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FEAT), cs('two', 'minor', FEAT)],
    });
    expect(r.fixRefs).toEqual([]);
    expect(r.perCommit[0].reason).toBe('not-patch-only');
  });

  test('a patch commit with no Bug-labeled issue does not qualify', async () => {
    const r = await evaluate({ resolveIssuesForUrl: async () => plainIssues });
    expect(r.fixRefs).toEqual([]);
    expect(r.perCommit[0].reason).toBe('not-bug-linked');
  });

  test('a commit already contained in the stable is excluded before any resolution', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('restored', 'patch', SHIPPED)],
      isInStable: (sha) => sha === SHIPPED,
      resolveChangesetPrUrl: () => {
        throw new Error('must not resolve an already-shipped commit');
      },
    });
    expect(r.fixRefs).toEqual([]);
    expect(r.perCommit[0].reason).toBe('already-in-stable');
  });

  test('several qualifying commits batch in input (merge) order', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FIX_A), cs('two', 'patch', FIX_B)],
    });
    expect(r.fixRefs).toEqual([FIX_A, FIX_B]);
  });

  test('resolution failures degrade the commit, never the tick', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FIX_A), cs('two', 'patch', FIX_B)],
      resolveIssuesForUrl: async (url) => {
        if (url.endsWith('/3')) throw new Error('linear down');
        return bugIssues;
      },
      resolveChangesetPrUrl: (id) => `https://github.com/inkeep/agents-private/pull/${id.length}`,
    });
    // 'one' resolves via /3 (length 3) and errors -> not bug-linked; 'two' via
    // /3 as well... both ids are length 3, so both error: the tick still
    // answers rather than throwing.
    expect(r.reason).toBe('no-qualifying-fixes');
    expect(r.warnings.some((w) => w.startsWith('issues-error'))).toBe(true);
  });

  test('an unresolvable Linear lookup (no key) degrades to not-bug-linked', async () => {
    const r = await evaluate({
      resolveIssuesForUrl: async () => ({ unresolvable: 'no-linear-api-key' }),
    });
    expect(r.fixRefs).toEqual([]);
    expect(r.perCommit[0].reason).toBe('not-bug-linked');
    expect(r.warnings.some((w) => w.includes('no-linear-api-key'))).toBe(true);
  });

  test('a commit qualifies through any one of its changesets', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FIX_A), cs('two', 'patch', FIX_A)],
      resolveIssuesForUrl: async (url) => (url.endsWith('/3') ? plainIssues : bugIssues),
      resolveChangesetPrUrl: (id) => `https://github.com/inkeep/agents-private/pull/${id === 'one' ? 3 : 4}`,
    });
    expect(r.fixRefs).toEqual([FIX_A]);
  });

  test('an isInStable failure degrades that commit with a warning and the tick still answers', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FIX_A), cs('two', 'patch', FIX_B)],
      isInStable: (sha) => {
        if (sha === FIX_A) throw new Error('git lock');
        return false;
      },
    });
    expect(r.fixRefs).toEqual([FIX_B]);
    expect(r.warnings.some((w) => w.startsWith('containment-error') && w.includes('git lock'))).toBe(true);
    expect(r.perCommit.find((c) => c.sha === FIX_A).reason).toBe('containment-error');
  });

  test('an empty pile is a real answer', async () => {
    const r = await evaluate({ pendingChangesets: [] });
    expect(r).toMatchObject({ fixRefs: [], reason: 'no-pending-changesets' });
  });

  test('the Bug label matches case-insensitively and no other label counts', async () => {
    const r = await evaluate({
      resolveIssuesForUrl: async () => ({ issues: [{ identifier: 'PRD-9', labels: ['bug'] }] }),
    });
    expect(r.fixRefs).toEqual([FIX_A]);
    const r2 = await evaluate({
      resolveIssuesForUrl: async () => ({ issues: [{ identifier: 'PRD-9', labels: ['Bugfix'] }] }),
    });
    expect(r2.fixRefs).toEqual([]);
  });
});

/**
 * The real git boundary, against a repository shaped like production.
 *
 * A stable is not a prefix of main: it is cut by cherry-picking fixes onto the
 * previous stable, so the shipped copy of a fix is a different commit object
 * with a different SHA. An ancestry-only containment test cannot see it, which
 * is what let the lane re-qualify a fix it had already released and then page
 * a refusal saying that fix depended on later work.
 */
describe('makeIsInStable', () => {
  let dir;
  let fixOnMain;
  let laterOnMain;

  // `gitCleanEnv()` is mandatory, not tidiness: these tests run under the
  // pre-push hook, and an unscrubbed `git init` there inherits GIT_DIR from
  // the push and flips core.bare on the SHARED config when the push comes from
  // a linked worktree.
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitCleanEnv() }).trim();
  /** The injected boundary, bound to the fixture repo. */
  const inRepo = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: gitCleanEnv() });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-bug-lane-containment-'));
    git('init', '--initial-branch=main', '--quiet');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');

    writeFileSync(join(dir, 'base.txt'), 'base\n');
    git('add', '-A');
    git('commit', '-m', 'base', '--quiet');
    const base = git('rev-parse', 'HEAD');

    // main: base -> fix -> later
    writeFileSync(join(dir, 'fix.txt'), 'the fix\n');
    git('add', '-A');
    git('commit', '-m', 'fix: the bug', '--quiet');
    fixOnMain = git('rev-parse', 'HEAD');

    writeFileSync(join(dir, 'later.txt'), 'later feature\n');
    git('add', '-A');
    git('commit', '-m', 'feat: later', '--quiet');
    laterOnMain = git('rev-parse', 'HEAD');

    // stable: base -> prior point release -> fix'
    //
    // The prior commit is load-bearing, not scenery. Cherry-picking straight
    // onto `base` would give the copy the same parent, tree, message, author
    // and (within the same second) timestamp as the original — so git hashes
    // it to the SAME object and the fixture stops reproducing anything. A real
    // stable always carries earlier point releases, so this is also the
    // faithful shape, and it makes the distinct SHA a structural guarantee
    // rather than a matter of how fast the suite happens to run.
    git('checkout', '--quiet', '-b', 'stable', base);
    writeFileSync(join(dir, 'prior.txt'), 'earlier point release\n');
    git('add', '-A');
    git('commit', '-m', 'fix: an earlier point release', '--quiet');
    git('cherry-pick', fixOnMain);
    git('tag', 'v1.0.0');
    git('checkout', '--quiet', 'main');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('the cherry-picked copy on the stable is NOT an ancestor of it', () => {
    // Guards the premise: were this ever false the fixture would have stopped
    // reproducing the production topology, and the test below would pass for
    // the wrong reason.
    expect(git('rev-parse', 'v1.0.0')).not.toBe(fixOnMain);
    expect(inRepo(['merge-base', '--is-ancestor', fixOnMain, 'v1.0.0']).status).toBe(1);
  });

  test('a fix already released into the stable reads as contained', () => {
    expect(makeIsInStable('v1.0.0', inRepo)(fixOnMain)).toBe(true);
  });

  test('a commit the stable does not carry reads as not contained', () => {
    expect(makeIsInStable('v1.0.0', inRepo)(laterOnMain)).toBe(false);
  });

  test('a genuine ancestor still reads as contained', () => {
    expect(makeIsInStable('v1.0.0', inRepo)(git('rev-parse', 'v1.0.0^'))).toBe(true);
  });

  // Ancestry has already answered "no" by then, so a failing equivalence probe
  // must degrade to that answer rather than disqualifying the commit outright.
  test('an equivalence probe that fails degrades to not-contained, not an error', () => {
    const flaky = (args) =>
      args[0] === 'cherry' ? { status: 128, stdout: '', stderr: 'boom' } : inRepo(args);
    expect(makeIsInStable('v1.0.0', flaky)(laterOnMain)).toBe(false);
  });

  test('an ancestry probe that fails is still an infrastructure error', () => {
    const broken = () => ({ status: 128, stdout: '', stderr: 'not a git repository' });
    expect(() => makeIsInStable('v1.0.0', broken)(laterOnMain)).toThrow(/merge-base/);
  });
});
