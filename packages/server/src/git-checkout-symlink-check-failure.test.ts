import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';

vi.mock('./incoming-symlink-guard.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./incoming-symlink-guard.ts')>();
  return {
    ...actual,
    assertIncomingSymlinksSafe: vi.fn(async () => {
      throw new Error('could not read incoming symlink targets from git (spawn)');
    }),
  };
});

const { runCheckoutFlow } = await import('./git-checkout.ts');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.local',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.local',
    },
  }).trim();
}

describe('share-link branch switch when the symlink check cannot run', () => {
  let tmpDir = '';
  let projectDir = '';

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-checkout-guard-failure-')));
    const bareDir = join(tmpDir, 'bare.git');
    const seedDir = join(tmpDir, 'seed');
    projectDir = join(tmpDir, 'project');
    git(tmpDir, 'init', '-q', '--bare', '--initial-branch=main', bareDir);
    configureTestGitRepository(bareDir);
    git(tmpDir, 'init', '-q', '--initial-branch=main', seedDir);
    configureTestGitRepository(seedDir);
    writeFileSync(join(seedDir, 'a.md'), '# A\n');
    git(seedDir, 'add', 'a.md');
    git(seedDir, 'commit', '-q', '-m', 'base');
    git(seedDir, 'remote', 'add', 'origin', bareDir);
    git(seedDir, 'push', '-q', 'origin', 'main');
    git(seedDir, 'checkout', '-q', '-b', 'shared');
    writeFileSync(join(seedDir, 'b.md'), '# B\n');
    git(seedDir, 'add', 'b.md');
    git(seedDir, 'commit', '-q', '-m', 'shared');
    git(seedDir, 'push', '-q', 'origin', 'shared');
    git(tmpDir, 'clone', '-q', bareDir, projectDir);
    configureTestGitRepository(projectDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('reports symlink-check-failed and leaves HEAD where it was', async () => {
    const outcome = await runCheckoutFlow(projectDir, 'shared', { credentialConfig: [] });

    expect(outcome).toEqual({ ok: false, reason: 'symlink-check-failed' });
    expect(git(projectDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });
});
