import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';
import {
  deriveReleaseStamp,
  formatOutputLines,
  parseReleaseTag,
  previousStableTag,
} from './derive-release-stamp.mjs';

const TAGS = [
  'v0.35.0',
  'v0.35.1',
  'v0.35.2',
  'v0.35.3',
  'v0.35.4',
  'v0.35.5',
  'v0.35.6',
  'v0.36.0',
  'v0.42.0',
  'v0.43.0',
  'v0.43.1',
  'v0.44.0',
  'v0.45.0',
  'v0.45.1',
  'v0.45.2',
  'v0.45.3',
  'v0.45.4',
  'v0.45.5',
  'v0.46.0',
  'v0.45.4-beta.1',
  'v0.46.0-beta.1',
  'v0.46.0-beta.2',
  'v0.46.0-beta.3',
];

const noPreviousTag = () => null;

describe('parseReleaseTag', () => {
  test('a beta keeps its prerelease suffix in the release identity', () => {
    expect(parseReleaseTag('v0.46.0-beta.3')).toEqual({
      channel: 'beta',
      version: '0.46.0-beta.3',
      name: 'v0.46.0-beta.3',
    });
  });

  test('a stable yields the bare version', () => {
    expect(parseReleaseTag('v0.46.1')).toEqual({
      channel: 'stable',
      version: '0.46.1',
      name: 'v0.46.1',
    });
  });

  test('a beta identity is never the bare base version', () => {
    for (const tag of ['v0.46.0-beta.1', 'v0.46.0-beta.2', 'v0.46.0-beta.3']) {
      expect(parseReleaseTag(tag).version).not.toBe('0.46.0');
    }
    const versions = ['v0.46.0-beta.1', 'v0.46.0-beta.2', 'v0.46.0-beta.3'].map(
      (t) => parseReleaseTag(t).version,
    );
    expect(new Set(versions).size).toBe(3);
  });

  test('double-digit prerelease counters parse', () => {
    expect(parseReleaseTag('v0.46.0-beta.12').version).toBe('0.46.0-beta.12');
  });

  test.each([
    ['nonsense'],
    [''],
    ['0.46.0'],
    ['v0.46'],
    ['v0.46.0-rc.1'],
    ['v0.46.0-beta'],
    ['v0.46.0-beta.x'],
  ])('refuses %j rather than guessing an identity', (bad) => {
    expect(() => parseReleaseTag(bad)).toThrow();
  });
});

describe('previousStableTag', () => {
  test('skips betas to find the previous production boundary', () => {
    expect(previousStableTag({ tags: TAGS, tag: 'v0.45.5' })).toBe('v0.45.4');
  });

  test('orders numerically, not lexicographically', () => {
    const tags = ['v0.9.0', 'v0.10.0', 'v0.11.0'];
    expect(previousStableTag({ tags, tag: 'v0.11.0' })).toBe('v0.10.0');
    expect(previousStableTag({ tags, tag: 'v0.10.0' })).toBe('v0.9.0');
  });

  test('reaches the previous stable across a whole beta cycle', () => {
    expect(previousStableTag({ tags: TAGS, tag: 'v0.46.0' })).toBe('v0.45.5');
  });

  test('returns null for the first stable ever', () => {
    expect(previousStableTag({ tags: ['v0.1.0'], tag: 'v0.1.0' })).toBeNull();
    expect(previousStableTag({ tags: [], tag: 'v0.1.0' })).toBeNull();
  });

  test('ignores non-release refs sharing the v* namespace', () => {
    const tags = ['v0.45.4', 'vendor-snapshot', 'v0.45.4-beta.9', 'v0.45.5'];
    expect(previousStableTag({ tags, tag: 'v0.45.5' })).toBe('v0.45.4');
  });

  test('refuses to answer for a beta tag', () => {
    expect(() => previousStableTag({ tags: TAGS, tag: 'v0.46.0-beta.1' })).toThrow();
  });
});

describe('deriveReleaseStamp', () => {
  test('a beta scans only its own new commits', () => {
    expect(
      deriveReleaseStamp({
        tag: 'v0.46.0-beta.3',
        tags: TAGS,
        describePreviousTag: () => 'v0.46.0-beta.2',
      }),
    ).toEqual({
      channel: 'beta',
      version: '0.46.0-beta.3',
      name: 'v0.46.0-beta.3',
      baseRef: 'v0.46.0-beta.2',
    });
  });

  test('a stable scans back to the previous stable, ignoring describe', () => {
    const stamp = deriveReleaseStamp({
      tag: 'v0.46.0',
      tags: TAGS,
      describePreviousTag: () => 'v0.46.0-beta.3',
      resolveStableBaseRef: (previous) => previous,
    });
    expect(stamp.baseRef).toBe('v0.45.5');
    expect(stamp.channel).toBe('stable');
  });

  test('the first tag ever yields an empty bound rather than a wrong one', () => {
    expect(
      deriveReleaseStamp({
        tag: 'v0.1.0-beta.1',
        tags: [],
        describePreviousTag: noPreviousTag,
      }).baseRef,
    ).toBeNull();
  });

  test('a malformed tag fails loud before any git work', () => {
    expect(() =>
      deriveReleaseStamp({
        tag: 'not-a-tag',
        tags: TAGS,
        describePreviousTag: () => {
          throw new Error('describe must not run for an unparseable tag');
        },
      }),
    ).toThrow(/unrecognized release tag/);
  });
});

describe('formatOutputLines', () => {
  test('an absent lower bound emits an EMPTY base_ref, not a placeholder', () => {
    const lines = formatOutputLines({
      channel: 'beta',
      version: '0.1.0-beta.1',
      name: 'v0.1.0-beta.1',
      baseRef: null,
    });
    expect(lines).toContain('base_ref=');
    expect(lines.some((l) => l.startsWith('base_ref=') && l.length > 'base_ref='.length)).toBe(
      false,
    );
  });

  test('emits every key the workflow steps read', () => {
    expect(
      formatOutputLines({
        channel: 'stable',
        version: '0.46.1',
        name: 'v0.46.1',
        baseRef: 'v0.45.5',
      }),
    ).toEqual(['channel=stable', 'version=0.46.1', 'name=v0.46.1', 'base_ref=v0.45.5']);
  });
});

describe('regressions from the measured mis-stamps', () => {
  test.each([
    ['v0.42.0-beta.1', '0.42.0-beta.1', 'v0.41.4'],
    ['v0.43.0-beta.2', '0.43.0-beta.2', 'v0.43.0-beta.1'],
    ['v0.45.5-beta.1', '0.45.5-beta.1', 'v0.45.4'],
  ])('%s stamps its own tag, not the predicted stable', (tag, expected, previous) => {
    const stamp = deriveReleaseStamp({
      tag,
      tags: TAGS,
      describePreviousTag: () => previous,
    });
    expect(stamp).toEqual({
      channel: 'beta',
      version: expected,
      name: tag,
      baseRef: previous,
    });
  });

  test('a point release bounds on its immediate stable predecessor', () => {
    expect(previousStableTag({ tags: TAGS, tag: 'v0.45.4' })).toBe('v0.45.3');
    expect(previousStableTag({ tags: TAGS, tag: 'v0.45.3' })).toBe('v0.45.2');
    expect(previousStableTag({ tags: TAGS, tag: 'v0.45.1' })).toBe('v0.45.0');
  });
});

const tempRepos = [];
afterEach(() => {
  for (const dir of tempRepos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeReleaseRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ok-release-stamp-'));
  tempRepos.push(dir);
  const env = gitCleanEnv();
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        ...args,
      ],
      { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  git('init', '--quiet', '--initial-branch=main');
  const commit = (subject) => {
    git('commit', '--quiet', '--allow-empty', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  const run = (tag) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./derive-release-stamp.mjs', import.meta.url)), tag],
      { cwd: dir, encoding: 'utf8', env: { ...env, GITHUB_OUTPUT: join(dir, 'output') } },
    );
  return { dir, git, commit, run };
}

describe('release scan bounds with real Git histories', () => {
  test('v0.71.8 uses the common ancestor of a divergent v0.71.7 without widening the scan', () => {
    const { dir, git, commit, run } = makeReleaseRepo();
    commit('PRD-1000: already shipped');
    git('tag', 'v0.70.0');
    const common = commit('PRD-1001: also already shipped');
    git('switch', '-c', 'previous-stable');
    commit('PRD-1002: only in the previous release');
    git('tag', 'v0.71.7');
    git('switch', 'main');
    const first = commit('PRD-1003: first new fix');
    git('tag', 'v0.71.8-beta.1');
    const second = commit('PRD-1004: second new fix');
    git('tag', 'v0.71.8');
    const result = run('v0.71.8');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(`::notice::Using merge base ${common}`);
    expect(result.stderr).toContain('v0.71.7 is not an ancestor of v0.71.8');
    const stamp = JSON.parse(result.stdout);
    expect(stamp).toEqual({
      channel: 'stable',
      version: '0.71.8',
      name: 'v0.71.8',
      baseRef: common,
    });
    expect(git('merge-base', '--is-ancestor', stamp.baseRef, 'HEAD')).toBe('');
    expect(git('rev-list', `${stamp.baseRef}..HEAD`).split('\n')).toEqual([second, first]);
    expect(git('rev-list', `${stamp.baseRef}..HEAD`)).toBe(git('rev-list', 'v0.71.7..HEAD'));
    expect(readFileSync(join(dir, 'output'), 'utf8')).toContain(`base_ref=${common}\n`);
  });

  test.each([false, true])(
    'retains an ancestral stable tag (annotated: %s) and includes the whole beta cycle',
    (annotated) => {
      const { git, commit, run } = makeReleaseRepo();
      commit('previous stable');
      git('tag', ...(annotated ? ['-a', 'v0.71.7', '-m', 'previous stable'] : ['v0.71.7']));
      const first = commit('first beta fix');
      git('tag', 'v0.71.8-beta.1');
      const second = commit('second beta fix');
      git('tag', 'v0.71.8');
      const result = run('v0.71.8');
      expect(result.status, result.stderr).toBe(0);
      const { baseRef } = JSON.parse(result.stdout);
      expect(baseRef).toBe('v0.71.7');
      expect(git('rev-list', `${baseRef}..HEAD`).split('\n')).toEqual([second, first]);
    },
  );

  test('keeps a beta bounded by its preceding reachable tag', () => {
    const { git, commit, run } = makeReleaseRepo();
    commit('stable');
    git('tag', 'v0.71.7');
    commit('first beta');
    git('tag', 'v0.71.8-beta.1');
    commit('second beta');
    git('tag', 'v0.71.8-beta.2');
    const result = run('v0.71.8-beta.2');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).baseRef).toBe('v0.71.8-beta.1');
  });

  test('leaves the first stable release unbounded', () => {
    const { git, commit, run } = makeReleaseRepo();
    commit('first release');
    git('tag', 'v0.1.0');
    const result = run('v0.1.0');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).baseRef).toBeNull();
  });

  test.each(['missing', 'broken'])(
    'restores both stamping scripts and their imports over %s historical scripts',
    (history) => {
      const { dir, git, commit } = makeReleaseRepo();
      const common = commit('common');
      git('switch', '-c', 'previous-stable');
      commit('previous stable');
      git('tag', 'v0.71.7');
      git('switch', 'main');
      mkdirSync(join(dir, '.github/scripts'), { recursive: true });
      const helperPath = join(dir, '.github/scripts/derive-release-stamp.mjs');
      if (history === 'broken') {
        writeFileSync(helperPath, 'process.exit(99);\n');
        writeFileSync(
          join(dir, '.github/scripts/stamp-by-containment.mjs'),
          "import { missing } from './resolve-shipped-version.mjs';\n",
        );
        writeFileSync(
          join(dir, '.github/scripts/resolve-shipped-version.mjs'),
          'export const renamed = true;\n',
        );
      }
      git('add', '.');
      commit('historical release with broken stamping helper');
      git('tag', 'v0.71.8');
      git('switch', '-c', 'workflow-revision');
      cpSync(fileURLToPath(new URL('.', import.meta.url)), join(dir, '.github/scripts'), {
        recursive: true,
      });
      git('add', '.');
      const workflowSha = commit('fixed stamping scripts');
      const env = {
        ...gitCleanEnv(),
        RELEASE_TAG: 'v0.71.8',
        GITHUB_OUTPUT: join(dir, 'output'),
        LINEAR_API_KEY: '',
        CROSS_REPO_TOKEN: '',
      };
      const workflow = readFileSync(
        new URL('../workflows/linear-release.yml', import.meta.url),
        'utf8',
      );
      const runStep = (name, revision = workflowSha) => {
        const step = parse(workflow).jobs.stamp.steps.find((step) => step.name === name);
        return spawnSync('bash', ['-eu', '-c', step.run], {
          cwd: dir,
          env: { ...env, WORKFLOW_SHA: revision },
          encoding: 'utf8',
        });
      };
      git('checkout', '--detach', 'v0.71.8');
      const broken = runStep('Correct the stable stamp by containment');
      expect(broken.status).not.toBe(0);
      const failedRestore = runStep(
        'Restore stamping scripts from workflow revision',
        '0'.repeat(40),
      );
      expect(failedRestore.status).not.toBe(0);
      expect(git('status', '--porcelain')).toBe('');
      expect(runStep('Correct the stable stamp by containment').status).not.toBe(0);
      const restore = runStep('Restore stamping scripts from workflow revision');
      expect(restore.status, restore.stderr).toBe(0);
      const result = runStep('Derive channel, version, and scan range');
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).baseRef).toBe(common);
      expect(git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'v0.71.8'));
      expect(readFileSync(join(dir, 'output'), 'utf8')).toContain(`base_ref=${common}\n`);
      const containment = runStep('Correct the stable stamp by containment');
      expect(containment.status, containment.stderr).toBe(0);
      expect(containment.stderr).toContain('LINEAR_API_KEY');
    },
  );

  test('refuses a stable selected behind its predecessor', () => {
    const { dir, git, commit, run } = makeReleaseRepo();
    commit('earlier build');
    git('tag', 'v0.71.8');
    commit('previous stable has additional commits');
    git('tag', 'v0.71.7');
    git('checkout', '--detach', 'v0.71.8');
    const result = run('v0.71.8');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('v0.71.8 is behind its previous stable v0.71.7');
    expect(() => readFileSync(join(dir, 'output'))).toThrow();
  });

  test('allows stable versions pointing at the same commit', () => {
    const { git, commit, run } = makeReleaseRepo();
    commit('shared release commit');
    git('tag', 'v0.71.7');
    git('tag', 'v0.71.8');
    const result = run('v0.71.8');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).baseRef).toBe('v0.71.7');
  });

  test('preserves Git errors instead of misclassifying invalid objects as unrelated histories', () => {
    const { dir, git, commit, run } = makeReleaseRepo();
    commit('release');
    git('tag', 'v0.71.8');
    git('tag', 'v0.71.7', git('rev-parse', 'HEAD^{tree}'));
    const result = run('v0.71.8');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('git merge-base --all v0.71.7 v0.71.8 failed');
    expect(result.stderr).not.toContain('no common ancestor');
    expect(() => readFileSync(join(dir, 'output'))).toThrow();
  });

  test('refuses unrelated release histories instead of silently scanning everything', () => {
    const { dir, git, commit, run } = makeReleaseRepo();
    commit('previous stable');
    git('tag', 'v0.71.7');
    git('switch', '--orphan', 'unrelated');
    commit('new stable');
    git('tag', 'v0.71.8');
    const result = run('v0.71.8');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no common ancestor between v0.71.7 and v0.71.8');
    expect(() => readFileSync(join(dir, 'output'))).toThrow();
  });

  test('refuses criss-cross histories rather than arbitrarily selecting a common ancestor', () => {
    const { dir, git, commit, run } = makeReleaseRepo();
    const root = commit('root');
    const tree = git('rev-parse', 'HEAD^{tree}');
    const a = git('commit-tree', tree, '-p', root, '-m', 'a');
    const b = git('commit-tree', tree, '-p', root, '-m', 'b');
    const previous = git('commit-tree', tree, '-p', a, '-p', b, '-m', 'previous release');
    const current = git('commit-tree', tree, '-p', b, '-p', a, '-m', 'current release');
    git('tag', 'v0.71.7', previous);
    git('tag', 'v0.71.8', current);
    git('checkout', '--detach', current);
    expect(git('merge-base', '--all', previous, current).split('\n').sort()).toEqual([a, b].sort());
    const result = run('v0.71.8');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected one merge base between v0.71.7 and v0.71.8, got 2');
    expect(() => readFileSync(join(dir, 'output'))).toThrow();
  });
});
