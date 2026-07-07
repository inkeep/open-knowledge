/**
 * `git` check tests — DI'd via the `assert` dep so tests don't depend on
 * the runner-host's actual git binary.
 */

import { describe, expect, test } from 'bun:test';
import {
  type GitDetected,
  GitNotAvailableError,
  GitTooOldError,
  type InstallGuidance,
} from '@inkeep/open-knowledge-server';
import { makeGitCheck } from './git.ts';

const ctx = { cwd: '/tmp/git-check-test' };

const guidance: InstallGuidance = {
  product: 'Git',
  url: 'https://git-scm.com/download/linux',
  options: [{ label: 'Install via apt', command: 'sudo apt install git' }],
};

describe('git check', () => {
  test('passes with summary including version, source, and resolved path', async () => {
    const detected: GitDetected = {
      ok: true,
      version: '2.42.0',
      resolvedPath: '/usr/bin/git',
      source: 'PATH',
    };
    const def = makeGitCheck({ assert: () => detected });
    const result = await def.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.summary).toContain('2.42.0');
    expect(result.summary).toContain('PATH');
    expect(result.summary).toContain('/usr/bin/git');
  });

  test('fails when assert throws GitNotAvailableError; embeds install guidance', async () => {
    const def = makeGitCheck({
      assert: () => {
        throw new GitNotAvailableError('linux', guidance);
      },
    });
    const result = await def.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.summary).toBe('git not found');
    expect(result.remediation).toContain('sudo apt install git');
    expect(result.detail).toContain('OpenKnowledge needs Git');
  });

  test('fails when assert throws GitTooOldError; surfaces detected + required', async () => {
    const def = makeGitCheck({
      assert: () => {
        throw new GitTooOldError('linux', '2.20.0', '2.31.0', '/usr/bin/git', guidance);
      },
    });
    const result = await def.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('2.20.0');
    expect(result.summary).toContain('2.31.0');
    expect(result.remediation).toContain('sudo apt install git');
  });

  test('re-throws unexpected errors (runner catches at outer layer)', async () => {
    const def = makeGitCheck({
      assert: () => {
        throw new Error('unexpected');
      },
    });
    await expect(def.run(ctx)).rejects.toThrow('unexpected');
  });
});
