/**
 * `shadow-repo` check tests — exercises the no-.git/ warn, the
 * missing-shadow-repo warn, the MalformedGitPointerError fail, and the
 * pass-with-HEAD branch.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MalformedGitPointerError } from '@inkeep/open-knowledge-server';
import { makeShadowRepoCheck } from './shadow-repo.ts';

let tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-health-shadow-'));
  tmpDirs.push(dir);
  return dir;
}

describe('shadow-repo check', () => {
  test('warns when .git/ is missing', async () => {
    const cwd = makeProject();
    const def = makeShadowRepoCheck();
    const result = await def.run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('no .git/');
    expect(result.remediation).toContain('ok start');
  });

  test('warns when shadow dir is not yet initialized', async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, '.git'), { recursive: true });

    const def = makeShadowRepoCheck({
      resolve: () => join(cwd, '.git', 'ok-not-created-yet'),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('not yet initialized');
  });

  test('fails when resolveShadowDir throws MalformedGitPointerError', async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, '.git'), { recursive: true });

    const def = makeShadowRepoCheck({
      resolve: () => {
        throw new MalformedGitPointerError('.git contents invalid');
      },
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('cannot resolve shadow gitdir');
  });

  test('passes when shadow dir exists and HEAD is readable', async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const shadowDir = join(cwd, '.git', 'ok');
    mkdirSync(shadowDir, { recursive: true });
    writeFileSync(join(shadowDir, 'HEAD'), 'ref: refs/wip/local/main\n');

    const def = makeShadowRepoCheck({
      resolve: () => shadowDir,
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('pass');
    expect(result.summary).toContain('refs/wip/local/main');
  });

  test('fails when HEAD is missing', async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const shadowDir = join(cwd, '.git', 'ok');
    mkdirSync(shadowDir, { recursive: true });
    // intentionally no HEAD file

    const def = makeShadowRepoCheck({
      resolve: () => shadowDir,
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('missing HEAD');
  });
});
