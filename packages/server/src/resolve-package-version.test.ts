import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { resolvePackageVersion } from './resolve-package-version.ts';

describe('resolvePackageVersion', () => {
  test('resolves the server package via its own import.meta.url', async () => {
    const v = await resolvePackageVersion('@inkeep/open-knowledge-server', import.meta.url);
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('returns undefined for an unresolvable package name', async () => {
    const v = await resolvePackageVersion(
      '@inkeep/this-package-does-not-exist-xyz',
      import.meta.url,
    );
    expect(v).toBeUndefined();
  });

  test('walks up past unrelated package.json entries until a name match is found', async () => {
    const root = mkdtempSync(join(tmpdir(), 'resolve-pkg-version-walk-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: '@test/walk-target', version: '1.2.3' }),
      );
      const wrapper = join(root, 'wrapper');
      mkdirSync(wrapper);
      writeFileSync(
        join(wrapper, 'package.json'),
        JSON.stringify({ name: '@test/wrapper-decoy', version: '9.9.9' }),
      );
      const inner = join(wrapper, 'inner');
      mkdirSync(inner);
      const leafPath = join(inner, 'leaf.mjs');
      writeFileSync(leafPath, '// nothing');

      const fromUrl = pathToFileURL(leafPath).toString();
      const v = await resolvePackageVersion('@test/this-also-does-not-exist', fromUrl);
      expect(v).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('throws non-MODULE_NOT_FOUND errors instead of swallowing them', async () => {
    let threw = false;
    try {
      await resolvePackageVersion('@inkeep/open-knowledge-server', 42 as unknown as string);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
