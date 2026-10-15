import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';
import { configureTestGitRepository } from '../../test-support/configure-git-fixture.test-helper.ts';
import { expectNoAutomaticGitMaintenance } from './git-fixture-maintenance.test-helper.mjs';
import { createTagContainment } from './tag-containment.mjs';

test('batched containment agrees with Git across divergent and annotated tags, using one scan per fix', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ok-tag-containment-'));
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
      { cwd, env, encoding: 'utf8', stdio: 'pipe' },
    ).trim();
  try {
    git('init', '--quiet', '--initial-branch=main');
    env.GIT_TRACE2_EVENT = join(cwd, '.git', 'fixture-maintenance.jsonl');
    configureTestGitRepository(cwd, (args) => git(...args));
    git('commit', '--allow-empty', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('tag', 'v0.1.0');
    git('switch', '-c', 'point-release');
    git('commit', '--allow-empty', '-m', 'stable-only fix');
    const stableFix = git('rev-parse', 'HEAD');
    git('tag', '-a', 'v0.1.2', '-m', 'divergent stable');
    git('switch', 'main');
    git('commit', '--allow-empty', '-m', 'feature fix');
    const feature = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/tags/v0.1.1', feature);
    const betaTags = Array.from({ length: 1100 }, (_, i) => `v0.2.0-beta.${i}`);
    execFileSync('git', ['update-ref', '--stdin'], {
      cwd,
      env,
      input: betaTags.map((tag) => `create refs/tags/${tag} ${feature}\n`).join(''),
    });
    let calls = 0;
    const contains = createTagContainment({
      cwd,
      exec: (command, args, options) => {
        calls++;
        return execFileSync(command, args, { ...options, env });
      },
    });
    expect(betaTags.map((tag) => contains(tag, feature))).toEqual(betaTags.map(() => true));
    expect(calls).toBe(2);
    expect(contains('v0.1.2', feature)).toBe(false);
    expect(contains('v0.1.1', feature)).toBe(true);
    expect(contains('v0.1.2', stableFix)).toBe(true);
    expect(contains('v0.1.1', stableFix)).toBe(false);
    expect(contains('v0.1.0', base)).toBe(true);
    expect(contains('v0.1.2', base)).toBe(true);
    expect(calls).toBe(4);
    git('commit', '--allow-empty', '-m', 'not released yet');
    const unreleased = git('rev-parse', 'HEAD');
    expect(contains('v0.1.1', unreleased)).toBe(false);
    expect(contains('v0.1.2', unreleased)).toBe(false);
    expect(calls).toBe(5);
    expect(() => contains('v9.9.9', feature)).toThrow('absent');
    expect(() => contains('v0.1.2', 'f'.repeat(40))).toThrow();
    expectNoAutomaticGitMaintenance(cwd, env);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the maintenance oracle reports a repository that keeps automatic maintenance enabled', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ok-unconfigured-maintenance-'));
  const env = { ...gitCleanEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  try {
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd, env, stdio: 'pipe' });
    env.GIT_TRACE2_EVENT = join(cwd, '.git', 'fixture-maintenance.jsonl');
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd, env, stdio: 'pipe' });
    expect(() => expectNoAutomaticGitMaintenance(cwd, env)).toThrow(
      'fixture Git operation launched automatic maintenance',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
