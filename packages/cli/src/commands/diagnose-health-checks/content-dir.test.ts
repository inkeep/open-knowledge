/**
 * `content-dir` check tests — exercises warn (uninit), pass (writable),
 * fail (missing dir), fail (not-a-directory), fail (not writable).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeContentDirCheck } from './content-dir.ts';

let tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function makeProject(initOk = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-health-contentdir-'));
  tmpDirs.push(dir);
  if (initOk) {
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(join(dir, '.ok', 'config.yml'), 'content:\n  dir: ./content\n');
  }
  return dir;
}

describe('content-dir check', () => {
  test('emits warn when .ok/config.yml is missing', async () => {
    const cwd = makeProject(false);
    const def = makeContentDirCheck();
    const result = await def.run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toBe('project not initialized');
  });

  test('passes when content dir exists and is writable', async () => {
    const cwd = makeProject();
    const contentDir = join(cwd, 'content');
    mkdirSync(contentDir, { recursive: true });

    const def = makeContentDirCheck({
      loader: () => ({ config: { content: { dir: './content' } } }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('pass');
    expect(result.summary).toContain(contentDir);
    expect(result.summary).toContain('writable');
  });

  test('fails when content dir does not exist', async () => {
    const cwd = makeProject();
    const def = makeContentDirCheck({
      loader: () => ({ config: { content: { dir: './content' } } }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('does not exist');
  });

  test('fails when content dir path resolves to a file (not a directory)', async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, 'content'), 'whoops');

    const def = makeContentDirCheck({
      loader: () => ({ config: { content: { dir: './content' } } }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('not a directory');
  });

  test('fails when probeWritable reports non-writable', async () => {
    const cwd = makeProject();
    const contentDir = join(cwd, 'content');
    mkdirSync(contentDir, { recursive: true });

    const def = makeContentDirCheck({
      loader: () => ({ config: { content: { dir: './content' } } }),
      probeWritable: () => ({ writable: false, reason: 'EROFS: read-only file system' }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('not writable');
    expect(result.detail).toContain('EROFS');
  });

  test('fails with config-invalid summary when loader throws', async () => {
    const cwd = makeProject();
    const def = makeContentDirCheck({
      loader: () => {
        throw new Error('config invalid');
      },
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('content.dir unresolved');
    expect(result.detail).toContain('config invalid');
  });
});
