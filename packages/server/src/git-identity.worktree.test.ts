
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveGitIdentity, writeGitIdentity } from './git-identity.ts';


function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return env;
}

function run(cwd: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 10_000,
    env: cleanGitEnv(),
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

function gitConfigGet(
  cwd: string,
  scope: '--local' | '--worktree' | '--global',
  key: string,
): string | null {
  const result = run(cwd, 'config', scope, '--get', key);
  return result.status === 0 ? result.stdout || null : null;
}

function setupRepo(): { tmp: string; main: string; linked: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'ok-git-identity-wt-'));
  const main = join(tmp, 'repo');
  const linked = join(tmp, 'wt');

  expect(run(tmp, 'init', '-b', 'main', 'repo').status).toBe(0);
  expect(run(main, 'config', 'user.email', 'main@test.local').status).toBe(0);
  expect(run(main, 'config', 'user.name', 'Main Test').status).toBe(0);
  writeFileSync(join(main, 'a.txt'), 'hi\n');
  expect(run(main, 'add', 'a.txt').status).toBe(0);
  expect(run(main, 'commit', '-q', '-m', 'init').status).toBe(0);
  expect(run(main, 'worktree', 'add', linked, '-b', 'wtbr').status).toBe(0);

  return { tmp, main, linked };
}


describe('writeGitIdentity in a linked worktree', () => {
  let env: { tmp: string; main: string; linked: string };
  let savedGitEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedGitEnv = {};
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('GIT_')) {
        savedGitEnv[k] = process.env[k];
        delete process.env[k];
      }
    }
    env = setupRepo();
  });

  afterEach(() => {
    rmSync(env.tmp, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedGitEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('resolveGitIdentity in a linked worktree without the extension enabled falls through to the main identity', async () => {
    const resolved = await resolveGitIdentity(env.linked);
    expect(resolved).toEqual({ name: 'Main Test', email: 'main@test.local' });
  });

  test('writes per-worktree config and leaves main checkout untouched', () => {
    writeGitIdentity(env.linked, 'WT Author', 'wt@test.local');

    const wtConfigPath = join(env.main, '.git', 'worktrees', 'wt', 'config.worktree');
    expect(existsSync(wtConfigPath)).toBe(true);
    const wtConfigBody = readFileSync(wtConfigPath, 'utf-8');
    expect(wtConfigBody).toContain('email = wt@test.local');
    expect(wtConfigBody).toContain('name = WT Author');

    const commonConfig = readFileSync(join(env.main, '.git', 'config'), 'utf-8');
    expect(commonConfig).toContain('email = main@test.local');
    expect(commonConfig).toContain('name = Main Test');
    expect(commonConfig).not.toContain('wt@test.local');
    expect(commonConfig).not.toContain('WT Author');

    expect(gitConfigGet(env.main, '--local', 'user.email')).toBe('main@test.local');
    expect(gitConfigGet(env.main, '--local', 'user.name')).toBe('Main Test');
  });

  test('enables extensions.worktreeConfig on first write (idempotent)', () => {
    expect(gitConfigGet(env.linked, '--local', 'extensions.worktreeConfig')).toBeNull();

    writeGitIdentity(env.linked, 'WT Author', 'wt@test.local');
    expect(gitConfigGet(env.linked, '--local', 'extensions.worktreeConfig')).toBe('true');

    writeGitIdentity(env.linked, 'WT Author 2', 'wt2@test.local');
    expect(gitConfigGet(env.linked, '--worktree', 'user.email')).toBe('wt2@test.local');
    const commonConfig = readFileSync(join(env.main, '.git', 'config'), 'utf-8');
    const matches = commonConfig.match(/worktreeConfig\s*=\s*true/g);
    expect(matches?.length ?? 0).toBe(1);
  });

  test('resolveGitIdentity from the worktree returns the per-worktree value', async () => {
    writeGitIdentity(env.linked, 'WT Author', 'wt@test.local');
    const resolved = await resolveGitIdentity(env.linked);
    expect(resolved).toEqual({ name: 'WT Author', email: 'wt@test.local' });
  });

  test('resolveGitIdentity from main checkout still returns the main value', async () => {
    writeGitIdentity(env.linked, 'WT Author', 'wt@test.local');
    const resolved = await resolveGitIdentity(env.main);
    expect(resolved).toEqual({ name: 'Main Test', email: 'main@test.local' });
  });
});

describe('writeGitIdentity in the main worktree', () => {
  let env: { tmp: string; main: string; linked: string };
  let savedGitEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedGitEnv = {};
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('GIT_')) {
        savedGitEnv[k] = process.env[k];
        delete process.env[k];
      }
    }
    env = setupRepo();
  });

  afterEach(() => {
    rmSync(env.tmp, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedGitEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('writes to .git/config and does not enable extensions.worktreeConfig', () => {
    writeGitIdentity(env.main, 'Updated Main', 'updated@test.local');
    expect(gitConfigGet(env.main, '--local', 'user.email')).toBe('updated@test.local');
    expect(gitConfigGet(env.main, '--local', 'user.name')).toBe('Updated Main');
    expect(gitConfigGet(env.main, '--local', 'extensions.worktreeConfig')).toBeNull();

    const wtConfigPath = join(env.main, '.git', 'worktrees', 'wt', 'config.worktree');
    expect(existsSync(wtConfigPath)).toBe(false);
  });
});
