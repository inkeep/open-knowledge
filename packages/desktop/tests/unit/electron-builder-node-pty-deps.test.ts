import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const builderYml = resolve(desktopRoot, 'electron-builder.yml');
const pkgJson = resolve(desktopRoot, 'package.json');
const afterPack = resolve(desktopRoot, 'scripts', 'afterPack.mjs');

function readBuilderConfig(): {
  asarUnpack?: string[];
  mac?: { target?: Array<{ target?: string; arch?: string[] }> };
} {
  return parse(readFileSync(builderYml, 'utf8'));
}

function readPkg(): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(pkgJson, 'utf8'));
}

describe('node-pty desktop packaging config', () => {
  test('source files exist (premise check)', () => {
    expect(existsSync(builderYml)).toBe(true);
    expect(existsSync(pkgJson)).toBe(true);
    expect(existsSync(afterPack)).toBe(true);
  });

  test('node-pty is an upstream dependency and @lydell/node-pty is not used', () => {
    const pkg = readPkg();
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(
      pkg.dependencies?.['node-pty'],
      'node-pty must be a runtime dependency so electron-builder packs it into the app.',
    ).toBe('1.1.0');
    expect(
      '@lydell/node-pty' in deps,
      '@lydell/node-pty recreates the keyring per-arch universal-merge hazard — use upstream node-pty.',
    ).toBe(false);
  });

  test('asarUnpack unpacks the node-pty prebuilds tree (covers extensionless spawn-helper)', () => {
    const patterns = readBuilderConfig().asarUnpack ?? [];
    expect(
      patterns.includes('**/node-pty/prebuilds/**'),
      "Add '**/node-pty/prebuilds/**' to electron-builder.yml asarUnpack. The generic '**/*.node' " +
        'rule does NOT cover node-pty/prebuilds/<arch>/spawn-helper (extensionless), and node-pty ' +
        'resolves that helper from app.asar.unpacked at runtime — packed-in-asar means ' +
        'pty.fork() fails with "posix_spawnp failed".',
    ).toBe(true);
  });

  test('afterPack makes the unpacked spawn-helper executable (unpack rule + chmod move together)', () => {
    const src = readFileSync(afterPack, 'utf8');
    expect(
      src.includes('ensureNodePtySpawnHelperExecutable'),
      'afterPack.mjs must call ensureNodePtySpawnHelperExecutable so the unpacked-but-0644 ' +
        'spawn-helper (node-pty#850) is chmod 0755 before signing. Unpacking it without chmod ' +
        'still ships a non-executable helper and the terminal dies at runtime.',
    ).toBe(true);
  });

  test('mac build stays arm64-only — no universal/x64 target (node-pty native would split the lipo merge)', () => {
    const targets = readBuilderConfig().mac?.target ?? [];
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      const arches = t.arch ?? [];
      expect(
        arches,
        `mac.target "${t.target}" must ship arm64 only; got [${arches.join(', ')}]. A universal ` +
          'or x64 slice pulls node-pty (and keyring) per-arch natives into the @electron/universal ' +
          'merge, the hazard that forced this build arm64-only.',
      ).toEqual(['arm64']);
    }
  });
});
