import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Regression guard for node-pty packaging on the arm64 desktop build.
 *
 * node-pty ships its native addon and an extensionless `spawn-helper` binary
 * under `prebuilds/<platform>-<arch>/`. Three things must hold together or the
 * in-app terminal is dead on arrival in the packaged `.app`:
 *
 *   1. node-pty is the upstream package, pinned in optionalDependencies — NOT
 *      `@lydell/node-pty`, whose per-arch optionalDependency layout recreates
 *      the keyring universal-merge hazard that forced this build arm64-only.
 *      optionalDependencies placement is itself load-bearing in the other
 *      direction: node-pty's node-gyp build needs a C toolchain, and a failed
 *      optional install is dropped by bun instead of failing the whole repo's
 *      `bun install` (Linux contributors never run this macOS-only app).
 *      electron-builder packs installed optional production deps the same as
 *      regular ones, so the packaged app is unaffected on the macOS build
 *      host, where the native build always runs.
 *   2. `**\/node-pty/prebuilds/**` is in asarUnpack. The generic `**\/*.node`
 *      rule unpacks `pty.node` but NOT `spawn-helper` (no `.node` extension);
 *      node-pty resolves the helper from `app.asar.unpacked` at runtime, so it
 *      must be on the real filesystem or `pty.fork()` throws "posix_spawnp
 *      failed".
 *   3. afterPack.mjs chmods the unpacked spawn-helper to 0755 — node-pty ships
 *      it 0644 (node-pty#850) and asarUnpack preserves that mode. Behavior of
 *      that chmod is covered by ensure-node-pty-exec.test.ts; this guard only
 *      pins that the call site still exists alongside the unpack rule.
 *
 * The build also stays arm64-only (no universal target) — node-pty would add a
 * second per-arch native into any universal lipo-merge.
 */

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
  optionalDependencies?: Record<string, string>;
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

  test('node-pty is an upstream optionalDependency and @lydell/node-pty is not used', () => {
    const pkg = readPkg();
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.devDependencies };
    expect(
      pkg.optionalDependencies?.['node-pty'],
      'node-pty must be a pinned optionalDependency: electron-builder still packs installed ' +
        'optional production deps into the app, and optional placement keeps a failed node-gyp ' +
        'build (Linux contributor without a C toolchain) from failing the whole repo bun install.',
    ).toBe('1.1.0');
    expect(
      pkg.dependencies?.['node-pty'],
      'node-pty must not also appear in dependencies — that placement makes its native build ' +
        'failure fatal to bun install on machines without a C toolchain.',
    ).toBeUndefined();
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
