import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../../../test-support/configure-git-fixture.test-helper.ts';
import { runPublishFlow as runPublishFlowProduct } from './publish.ts';

async function runPublishFlow(...args: Parameters<typeof runPublishFlowProduct>) {
  const result = await runPublishFlowProduct(...args);
  if (existsSync(join(args[0].projectDir, '.git', 'config'))) {
    configureTestGitRepository(args[0].projectDir);
  }
  return result;
}

function octokitCreatingRepoAt(cloneUrl: string): Octokit {
  return {
    repos: {
      createForAuthenticatedUser: async () => ({
        data: { clone_url: cloneUrl, default_branch: 'main' },
      }),
    },
  } as unknown as Octokit;
}

describe('share publish honours the environment command-scope git config (GIT_CONFIG_COUNT)', () => {
  let workspace: string;
  let projectDir: string;
  let bareRepo: string;

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ok-publish-envcfg-')));
    projectDir = join(workspace, 'project');
    bareRepo = join(workspace, 'remote.git');
    const home = join(workspace, 'home');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_AUTHOR_NAME', undefined);
    vi.stubEnv('GIT_AUTHOR_EMAIL', undefined);
    vi.stubEnv('GIT_COMMITTER_NAME', undefined);
    vi.stubEnv('GIT_COMMITTER_EMAIL', undefined);
    execFileSync('git', ['init', '--bare', bareRepo], { stdio: 'ignore' });
    configureTestGitRepository(bareRepo);
    writeFileSync(join(projectDir, 'README.md'), '# Hello\n', 'utf-8');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(workspace, { recursive: true, force: true });
  });

  test('runPublishFlow publishes and the initial commit carries the environment identity', async () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '2');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'user.name');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'Env Config Author');
    vi.stubEnv('GIT_CONFIG_KEY_1', 'user.email');
    vi.stubEnv('GIT_CONFIG_VALUE_1', 'env-config@example.com');
    const bareUrl = pathToFileURL(bareRepo).href;

    const result = await runPublishFlow({
      octokit: octokitCreatingRepoAt(bareUrl),
      token: 'irrelevant',
      projectDir,
      body: { owner: 'alice', name: 'demo', visibility: 'private' },
      ownerKind: 'user',
      deps: { ensureOkScaffold: () => {} },
    });

    expect(result).toEqual({
      kind: 'ok',
      value: { ownerLogin: 'alice', repoName: 'demo', cloneUrl: bareUrl, defaultBranch: 'main' },
    });
    expect(
      execFileSync('git', ['log', '-1', '--format=%an <%ae>'], {
        cwd: projectDir,
        encoding: 'utf-8',
      }).trim(),
    ).toBe('Env Config Author <env-config@example.com>');
  });
});
