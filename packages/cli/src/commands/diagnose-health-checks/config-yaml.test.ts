/**
 * `config-yaml` check tests — exercises the warn-on-uninitialized + pass + fail
 * paths via a fresh tmp project per case.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeConfigYamlCheck } from './config-yaml.ts';

let tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-health-config-'));
  tmpDirs.push(dir);
  return dir;
}

describe('config-yaml check', () => {
  test('emits warn when .ok/config.yml is missing (project not initialized)', async () => {
    const cwd = makeProject();
    const def = makeConfigYamlCheck();
    const result = await def.run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('not found');
    expect(result.summary).toContain('not initialized');
    expect(result.remediation).toContain('ok init');
  });

  test('passes when config parses; summary surfaces content.dir', async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, '.ok'), { recursive: true });
    writeFileSync(join(cwd, '.ok', 'config.yml'), 'content:\n  dir: ./content\n');

    const def = makeConfigYamlCheck({
      loader: () => ({
        sources: [join(cwd, '.ok/config.yml')],
        config: { content: { dir: './content' } },
      }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('pass');
    expect(result.summary).toContain('./content');
    expect(result.detail).toContain('config.yml');
  });

  test('fails when loader throws (schema invalid)', async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, '.ok'), { recursive: true });
    writeFileSync(join(cwd, '.ok', 'config.yml'), 'content:\n  dir: 42\n');

    const def = makeConfigYamlCheck({
      loader: () => {
        throw new Error('Invalid YAML: content.dir must be a string');
      },
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('failed to parse');
    expect(result.detail).toContain('content.dir must be a string');
  });
});
