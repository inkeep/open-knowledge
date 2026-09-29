import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';

test('the operator CLI resolves only published desktop releases and fails closed on API errors', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ok-shipped-cli-'));
  const env = gitCleanEnv();
  const git = (...args) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    git('init', '--quiet');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      `fix\n\nGitOrigin-RevId: ${'a'.repeat(40)}`,
    );
    for (const tag of ['v0.77.9', 'v0.77.10']) git('-c', 'tag.gpgsign=false', 'tag', tag);
    const bin = join(cwd, 'bin');
    mkdirSync(bin);
    const releases = ['v0.77.9', 'v0.77.10'].map((tag_name, i) => ({
      tag_name,
      draft: i === 0,
      published_at: i === 0 ? null : '2026-09-24T22:00:00Z',
      assets: [{ name: 'OpenKnowledge-arm64.dmg' }, { name: 'latest-mac.yml' }],
    }));
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env node
if(process.env.TEST_API_FAILURE) process.exit(1);
console.log(${JSON.stringify(releases.map((r) => JSON.stringify(r)).join('\n'))});
`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const script = fileURLToPath(new URL('./resolve-shipped-version.mjs', import.meta.url));
    const output = join(cwd, 'output');
    const run = (extra = {}) =>
      spawnSync(process.execPath, [script, 'a'.repeat(40)], {
        cwd,
        encoding: 'utf8',
        env: { ...env, PATH: `${bin}:${env.PATH}`, GITHUB_OUTPUT: output, ...extra },
      });
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ shipped: true, tag: 'v0.77.10' });
    expect(readFileSync(output, 'utf8')).toContain('version=0.77.10');
    const failure = run({ TEST_API_FAILURE: 'true' });
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe('');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
