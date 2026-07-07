import { describe, expect, test } from 'bun:test';
import { getLocalDir } from '@inkeep/open-knowledge-server';
import { resolveContentDir, resolveLockDir } from './paths.ts';
import type { Config } from './schema.ts';

function makeConfig(dir: string): Config {
  // Minimal Config shape for path-resolution tests. We only read content.dir.
  return { content: { dir } } as unknown as Config;
}

describe('resolveContentDir', () => {
  test('returns absolute path under cwd for relative dir', () => {
    const cwd = '/tmp/project';
    expect(resolveContentDir(makeConfig('.'), cwd)).toBe('/tmp/project');
    expect(resolveContentDir(makeConfig('docs'), cwd)).toBe('/tmp/project/docs');
    expect(resolveContentDir(makeConfig('./content'), cwd)).toBe('/tmp/project/content');
  });

  test('returns absolute path unchanged when dir is absolute', () => {
    expect(resolveContentDir(makeConfig('/var/vault'), '/tmp/cwd')).toBe('/var/vault');
  });
});

describe('resolveLockDir', () => {
  test('returns <contentDir>/.ok/local', () => {
    expect(resolveLockDir('/tmp/project')).toBe(getLocalDir('/tmp/project'));
  });
});
