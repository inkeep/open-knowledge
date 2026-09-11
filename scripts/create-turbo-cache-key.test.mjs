import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CACHE_KEY_FILE, cacheKey, writeCacheKey } from './create-turbo-cache-key.mjs';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));

const readJson = (p) => JSON.parse(readFileSync(join(OK_ROOT, p), 'utf-8'));

describe('turbo platform cache key', () => {
  test('the key file is a globalDependency, so platform reaches every task hash', () => {
    expect(readJson('turbo.json').globalDependencies).toContain(CACHE_KEY_FILE);
  });

  test('postinstall regenerates it, so it exists before any turbo invocation', () => {
    expect(readJson('package.json').scripts.postinstall).toBe(
      'node scripts/create-turbo-cache-key.mjs',
    );
  });

  test('the key carries platform and arch, and nothing else', () => {
    expect(cacheKey({ platform: 'linux', arch: 'x64' })).toEqual({
      platform: 'linux',
      arch: 'x64',
    });
  });

  test('two platforms produce two different payloads', () => {
    const linux = JSON.stringify(cacheKey({ platform: 'linux', arch: 'x64' }));
    const mac = JSON.stringify(cacheKey({ platform: 'darwin', arch: 'arm64' }));
    expect(linux).not.toBe(mac);
  });

  test('writeCacheKey emits the payload the hash reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-turbo-cache-key-'));
    try {
      const { path } = writeCacheKey(dir, { platform: 'win32', arch: 'arm64' });
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
        platform: 'win32',
        arch: 'arm64',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
