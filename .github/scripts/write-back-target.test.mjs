import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveWriteBackTarget } from './write-back-target.mjs';

test('scheduled reconciliation selects the newest published release of each channel', () => {
  const publishedTags = ['v0.77.9', 'v0.78.0-beta.6', 'v0.78.0-beta.9'];
  expect(resolveWriteBackTarget({ channel: 'stable', publishedTags })).toBe('v0.77.9');
  expect(resolveWriteBackTarget({ channel: 'beta', publishedTags })).toBe('v0.78.0-beta.9');
  expect(resolveWriteBackTarget({ channel: 'beta', publishedTags: ['v0.77.9'] })).toBeNull();
  expect(() =>
    resolveWriteBackTarget({ channel: 'beta', publishedTags, requestedTag: 'v0.78.0-beta.8' }),
  ).toThrow('not a published');
  expect(() =>
    resolveWriteBackTarget({ channel: 'beta', publishedTags, requestedTag: 'v0.77.9' }),
  ).toThrow('does not match');
  expect(
    resolveWriteBackTarget({ channel: 'beta', publishedTags, requestedTag: 'v0.78.0-beta.6' }),
  ).toBe('v0.78.0-beta.6');
});

test('the workflow entrypoint resolves real gh output and refuses API failures before emitting a target', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ok-writeback-target-'));
  try {
    const bin = join(cwd, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env node
if (process.env.TEST_API_FAILURE) process.exit(1);
for (const [tag_name,draft] of [['v0.78.0-beta.6',false],['v0.78.0-beta.7',true]]) console.log(JSON.stringify({tag_name,draft,published_at:draft?null:'2026-09-24T22:50:04Z',assets:[{name:'OpenKnowledge-arm64.dmg'},{name:'beta-mac.yml'}]}));
`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const script = fileURLToPath(new URL('./write-back-target.mjs', import.meta.url));
    const envFile = join(cwd, 'env');
    const outputFile = join(cwd, 'output');
    const run = (extra = {}) => {
      writeFileSync(envFile, '');
      writeFileSync(outputFile, '');
      return spawnSync(process.execPath, [script], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_ENV: envFile,
          GITHUB_OUTPUT: outputFile,
          WRITE_BACK_CHANNEL: 'beta',
          RELEASE_TAG: '',
          ...extra,
        },
      });
    };
    const success = run();
    expect(success.status, success.stderr).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toBe('');
    expect(readFileSync(outputFile, 'utf8')).toBe('channel=beta\nrelease_tag=v0.78.0-beta.6\n');
    for (const extra of [{ TEST_API_FAILURE: 'true' }, { RELEASE_TAG: 'v0.78.0-beta.7' }]) {
      const failed = run(extra);
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain('::error::write-back-target:');
      expect(failed.stderr).toContain('channel="beta"');
      expect(readFileSync(envFile, 'utf8')).toBe('');
      expect(readFileSync(outputFile, 'utf8')).toBe('');
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
