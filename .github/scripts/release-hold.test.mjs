import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';
import { configureTestGitRepository } from '../../test-support/configure-git-fixture.test-helper.ts';
import { expectNoAutomaticGitMaintenance } from './git-fixture-maintenance.test-helper.mjs';
import {
  describeHold,
  evaluatePick,
  evaluateTree,
  gitReader,
  holdHeadline,
  mainHoldReport,
  parseArgs,
  REFUSED_EXIT,
  RELEASE_HOLD_SENTINEL,
  SHALLOW_BOUNDARY,
} from './release-hold.mjs';

const SCRIPT = fileURLToPath(new URL('./release-hold.mjs', import.meta.url));
const scratch = [];

afterAll(() => {
  while (scratch.length > 0) rmSync(scratch.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

function makeRepo(dir = tempDir('ok-release-hold-')) {
  const fixtureEnv = gitCleanEnv();
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Release Bot', '-c', 'user.email=bot@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: dir, env: fixtureEnv, encoding: 'utf8', stdio: 'pipe' },
    ).trim();
  git('init', '--quiet', '--initial-branch=main');
  fixtureEnv.GIT_TRACE2_EVENT = join(dir, '.git', 'fixture-maintenance.jsonl');
  configureTestGitRepository(dir, (args) => git(...args));
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = (message, files = {}, removed = []) => {
    for (const [path, content] of Object.entries(files)) write(path, content);
    for (const path of removed) git('rm', '--quiet', path);
    git('add', '-A');
    git('commit', '--quiet', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit, reader: gitReader(dir) };
}

function releaseLine() {
  const repo = makeRepo();
  const stable = repo.commit('chore: the shipped change (#100)', { 'README.md': 'stable\n' });
  repo.git('tag', 'v1.0.0');
  const preFlipBeta = repo.commit('fix: a pre-flip fix (#101)', { 'fix.txt': 'pre-flip\n' });
  repo.git('tag', 'v1.0.1-beta.0');
  const flip = repo.commit('feat: boot only the converged host (#200)', {
    [RELEASE_HOLD_SENTINEL]: 'held\n',
    'host.txt': 'converged\n',
  });
  repo.git('tag', 'v1.1.0-beta.0');
  const postFlipFix = repo.commit('fix: a post-flip fix (#201)', { 'post-flip-fix.txt': 'post-flip\n' });
  repo.git('tag', 'v1.1.0-beta.1');
  const release = repo.commit('chore: release the converged-host hold (#202)', {}, [RELEASE_HOLD_SENTINEL]);
  repo.git('tag', 'v1.1.0-beta.2');
  return { ...repo, stable, preFlipBeta, flip, postFlipFix, release };
}

const runCli = (args, { cwd, env = {} } = {}) => {
  const summary = join(tempDir('ok-release-hold-summary-'), 'summary.md');
  writeFileSync(summary, '');
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...gitCleanEnv(), GITHUB_STEP_SUMMARY: summary, ...env },
  });
  return { ...res, summary: readFileSync(summary, 'utf8') };
};

describe('a tree candidate: a beta or stable tag, or a synthetic commit', () => {
  const line = releaseLine();

  test('fixture Git operations do not launch automatic maintenance', () => {
    expect(() => expectNoAutomaticGitMaintenance(line.dir)).not.toThrow();
  });

  test('a stable cut before the flip is not held, and says so', () => {
    const verdict = evaluateTree({ candidate: 'refs/tags/v1.0.0', git: line.reader });
    expect(verdict).toEqual({
      kind: 'tree',
      candidate: 'refs/tags/v1.0.0',
      sha: line.stable,
      path: RELEASE_HOLD_SENTINEL,
      held: false,
    });
    expect(describeHold(verdict, 'v1.0.0')).toBe(
      `v1.0.0 (${line.stable.slice(0, 12)}) does not carry ${RELEASE_HOLD_SENTINEL}, so the release hold does not apply.`,
    );
  });

  test('a pre-flip beta is not held', () => {
    expect(evaluateTree({ candidate: 'v1.0.1-beta.0', git: line.reader }).held).toBe(false);
  });

  test('a beta carrying the sentinel is held, and so is every later beta until the release PR', () => {
    const verdict = evaluateTree({ candidate: 'v1.1.0-beta.0', git: line.reader });
    expect(verdict.held).toBe(true);
    expect(holdHeadline(verdict, 'v1.1.0 from v1.1.0-beta.0')).toBe(
      `v1.1.0 from v1.1.0-beta.0 (${line.flip.slice(0, 12)}) carries ${RELEASE_HOLD_SENTINEL}, the release hold ` +
        'the converged local host arms, so it is not published as a stable. See RELEASES.md, "Release hold".',
    );
    expect(evaluateTree({ candidate: 'v1.1.0-beta.1', git: line.reader }).held).toBe(true);
  });

  test('the release PR that deletes the sentinel lifts the hold', () => {
    expect(evaluateTree({ candidate: 'v1.1.0-beta.2', git: line.reader }).held).toBe(false);
  });

  test('a hotfix stable cut over the pre-flip stable with a post-flip fix is not held', () => {
    const repo = releaseLine();
    repo.git('switch', '--quiet', '--detach', 'v1.0.0');
    repo.git('cherry-pick', repo.postFlipFix);
    repo.git('tag', 'v1.0.1');
    expect(evaluateTree({ candidate: 'refs/tags/v1.0.1', git: repo.reader }).held).toBe(false);
  });

  test('a sentinel that is a directory still holds', () => {
    const repo = makeRepo();
    repo.commit('add a directory at the sentinel path', { [`${RELEASE_HOLD_SENTINEL}/marker`]: 'held\n' });
    expect(evaluateTree({ candidate: 'HEAD', git: repo.reader }).held).toBe(true);
  });

  test('a candidate that does not resolve to a commit cannot be decided', () => {
    expect(() => evaluateTree({ candidate: 'v9.9.9', git: line.reader })).toThrow(
      'v9.9.9 does not resolve to a commit in this checkout',
    );
  });

  test('a candidate whose tree object is missing cannot be decided', () => {
    const repo = makeRepo();
    const sha = repo.commit('one commit', { 'README.md': 'stable\n' });
    const tree = repo.git('rev-parse', `${sha}^{tree}`);
    unlinkSync(join(repo.dir, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
    expect(() => evaluateTree({ candidate: sha, git: repo.reader })).toThrow(/git ls-tree .* failed/);
  });

  test('a git read that fails outright cannot be decided', () => {
    const notARepo = tempDir('ok-release-hold-not-a-repo-');
    expect(() => evaluateTree({ candidate: 'HEAD', git: gitReader(notARepo) })).toThrow(/failed/);
  });
});

describe("a bug-lane pick: the commit's own diff against its first parent", () => {
  const line = releaseLine();

  test('the commit that brought the flip to main is held', () => {
    const verdict = evaluatePick({ candidate: line.flip, git: line.reader });
    expect(verdict).toMatchObject({ kind: 'pick', held: true, firstParent: line.preFlipBeta });
    expect(holdHeadline(verdict, 'fix')).toContain(`adds ${RELEASE_HOLD_SENTINEL} against its first parent`);
  });

  test('a fix authored after the flip is not held, though its tree carries the sentinel', () => {
    const verdict = evaluatePick({ candidate: line.postFlipFix, git: line.reader });
    expect(verdict).toMatchObject({ held: false, firstParent: line.flip });
    expect(describeHold(verdict)).toBe(
      `${line.postFlipFix} (${line.postFlipFix.slice(0, 12)}) does not add ${RELEASE_HOLD_SENTINEL} against its ` +
        `first parent ${line.flip.slice(0, 12)}, so the release hold does not apply.`,
    );
  });

  test('a pre-flip fix and the release PR are not held', () => {
    expect(evaluatePick({ candidate: line.preFlipBeta, git: line.reader }).held).toBe(false);
    expect(evaluatePick({ candidate: line.release, git: line.reader }).held).toBe(false);
  });

  test('a merge that brought the flip in on its second parent is held through its first parent', () => {
    const repo = makeRepo();
    repo.commit('stable', { 'README.md': 'stable\n' });
    repo.git('switch', '--quiet', '-c', 'research');
    repo.commit('the flip', { [RELEASE_HOLD_SENTINEL]: 'held\n' });
    repo.git('switch', '--quiet', 'main');
    repo.commit('unrelated work on main', { 'main.txt': 'main\n' });
    repo.git('merge', '--no-ff', '--quiet', '-m', 'join', 'research');
    expect(evaluatePick({ candidate: 'HEAD', git: repo.reader }).held).toBe(true);
  });

  test('a root commit is read against the empty tree', () => {
    const held = makeRepo();
    held.commit('root with the sentinel', { [RELEASE_HOLD_SENTINEL]: 'held\n' });
    expect(evaluatePick({ candidate: 'HEAD', git: held.reader })).toMatchObject({ held: true, firstParent: null });
    const clear = makeRepo();
    clear.commit('root without it', { 'README.md': 'stable\n' });
    expect(evaluatePick({ candidate: 'HEAD', git: clear.reader })).toMatchObject({ held: false, firstParent: null });
  });

  test('a pick at a shallow boundary is refused, because its first parent is not in the clone', () => {
    const clone = tempDir('ok-release-hold-shallow-');
    execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${line.dir}`, clone], {
      env: gitCleanEnv(),
      stdio: 'pipe',
    });
    configureTestGitRepository(clone);
    const shallow = gitReader(clone);
    expect(() => evaluatePick({ candidate: 'HEAD', git: shallow })).toThrow(
      expect.objectContaining({
        code: SHALLOW_BOUNDARY,
        message: expect.stringContaining(
          `names first parent ${line.postFlipFix.slice(0, 12)}, which is not in this clone, as at a shallow boundary`,
        ),
      }),
    );
    expect(evaluateTree({ candidate: 'HEAD', git: shallow }).held).toBe(false);
  });
});

describe('the command line', () => {
  const line = releaseLine();

  test('admits a candidate without the sentinel, says so, and writes the step summary', () => {
    const res = runCli(['--candidate', 'refs/tags/v1.0.0', '--label', 'v1.0.0'], { cwd: line.dir });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe(
      `v1.0.0 (${line.stable.slice(0, 12)}) does not carry ${RELEASE_HOLD_SENTINEL}, so the release hold does not apply.\n`,
    );
    expect(res.summary).toContain('### Release hold: v1.0.0 not held');
  });

  test('refuses a sentinel-carrying beta with exit 2 and an error annotation', () => {
    const res = runCli(['--candidate', 'v1.1.0-beta.0', '--label', 'v1.1.0 from v1.1.0-beta.0'], { cwd: line.dir });
    expect(res.status).toBe(REFUSED_EXIT);
    expect(res.stdout).toContain(`::error::v1.1.0 from v1.1.0-beta.0 (${line.flip.slice(0, 12)}) carries`);
    expect(res.summary).toContain('### Release hold: v1.1.0 from v1.1.0-beta.0 held');
  });

  test('--pick reads the diff against the first parent', () => {
    expect(runCli(['--pick', line.flip], { cwd: line.dir }).status).toBe(REFUSED_EXIT);
    expect(runCli(['--pick', line.postFlipFix], { cwd: line.dir }).status).toBe(0);
  });

  test('a candidate it cannot read fails with exit 1 and names the candidate as held', () => {
    const res = runCli(['--candidate', 'v9.9.9'], { cwd: line.dir });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('::error::release-hold could not decide, so v9.9.9 is held');
    const outside = runCli(['--candidate', 'HEAD', '-C', tempDir('ok-release-hold-empty-')]);
    expect(outside.status).toBe(1);
  });

  test('--main reports whether the hold is in force without changing the verdict', () => {
    const inForce = runCli(['--candidate', 'v1.0.0', '--main', 'v1.1.0-beta.1'], { cwd: line.dir });
    expect(inForce.status, inForce.stderr).toBe(0);
    expect(inForce.stdout).toContain(`::notice::Release hold in force: v1.1.0-beta.1 carries ${RELEASE_HOLD_SENTINEL}`);
    const lifted = runCli(['--candidate', 'v1.0.0', '--main', 'HEAD'], { cwd: line.dir });
    expect(lifted.stdout).toContain(`Release hold not in force: HEAD does not carry ${RELEASE_HOLD_SENTINEL}.`);
    const unreadable = runCli(['--candidate', 'v1.0.0', '--main', 'nope'], { cwd: line.dir });
    expect(unreadable.status).toBe(0);
    expect(unreadable.stdout).toContain('::warning::Release hold: could not read whether nope carries');
  });

  test('mainHoldReport warns rather than throwing when the ref is unreadable', () => {
    expect(mainHoldReport({ ref: 'nope', git: line.reader })).toMatch(/^::warning::/);
  });

  test.each([
    [[], 'give exactly one of --candidate <ref> or --pick <ref>'],
    [['--candidate', 'a', '--pick', 'b'], 'give exactly one of --candidate <ref> or --pick <ref>'],
    [['--candidate', 'a', '--candidate', 'b'], '--candidate was given twice'],
    [['--candidate'], '--candidate needs a value'],
    [['--candidate', 'a', '--force'], 'unrecognized argument: --force'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
    const res = runCli(argv, { cwd: line.dir });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(message);
  });
});
