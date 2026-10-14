import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../../../test-support/configure-git-fixture.test-helper.ts';
import { sharingStatusCommand } from './status.ts';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ok-sharing-status-'));
  execFileSync('git', ['init', '-q'], { cwd: projectDir });
  configureTestGitRepository(projectDir);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('config-sharing status toggle hint', () => {
  test.each([
    ['stable', 'ok'],
    ['beta', 'ok-beta'],
  ])('%s: names %s config-sharing', async (channel, command) => {
    vi.stubEnv('OK_CHANNEL', channel);
    await sharingStatusCommand().parseAsync(['--project', projectDir], { from: 'user' });
    const stdout = vi
      .mocked(process.stdout.write)
      .mock.calls.map(([text]) => String(text))
      .join('');
    expect(stdout).toMatch(new RegExp(`Toggle with: .*${command} config-sharing (share|unshare)`));
  });
});
