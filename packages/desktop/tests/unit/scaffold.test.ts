import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';

describe('desktop scaffold', () => {
  test('OK_DIR from core resolves to .ok', () => {
    expect(OK_DIR).toBe('.ok');
  });

  test('server package is importable', async () => {
    const server = await import('@inkeep/open-knowledge-server');
    expect(typeof server.bootServer).toBe('function');
    expect(typeof server.createServer).toBe('function');
  });

  test('workspace deps resolve to the development src barrel', () => {
    expect(import.meta.resolve('@inkeep/open-knowledge-server')).toMatch(/\/src\/index\.ts$/);
    expect(import.meta.resolve('@inkeep/open-knowledge-core')).toMatch(/\/src\/index\.ts$/);
  });
});

describe('M2 electron-version contract (D6)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const desktopRoot = resolve(__dirname, '../..');

  test('package.json `electron` devDep matches electron-builder.yml `electronVersion`', () => {
    const pkg = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'));
    const yml = readFileSync(resolve(desktopRoot, 'electron-builder.yml'), 'utf8');

    const pkgVersion = pkg.devDependencies?.electron as string | undefined;
    expect(pkgVersion, 'electron devDep missing from package.json').toBeDefined();

    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+$/);

    const ymlMatch = yml.match(/^electronVersion:\s*"([^"]+)"$/m);
    expect(ymlMatch, 'electronVersion not found in electron-builder.yml').not.toBeNull();
    const ymlVersion = ymlMatch?.[1];

    expect(ymlVersion).toBe(pkgVersion);
  });
});
