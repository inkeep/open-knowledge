import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

/**
 * Regression guard for node-pty packaging on the desktop builds.
 *
 * node-pty ships its native addons under `prebuilds/<platform>-<arch>/`;
 * Darwin also carries an extensionless `spawn-helper`. These invariants must
 * hold together or the in-app terminal is dead on arrival in the packaged app:
 *
 *   1. node-pty is the upstream package, pinned in optionalDependencies — NOT
 *      `@lydell/node-pty`, whose per-arch optionalDependency layout recreates
 *      the keyring universal-merge hazard that forced this build arm64-only.
 *      optionalDependencies placement is itself load-bearing in the other
 *      direction: node-pty's node-gyp build needs a C toolchain, and a failed
 *      optional install is dropped by pnpm instead of failing the whole
 *      workspace install when a host has no native toolchain.
 *      electron-builder packs installed optional production deps the same as
 *      regular ones, so the packaged app is unaffected on the macOS build
 *      host.
 *   2. `**\/node-pty/prebuilds/**` is in asarUnpack. The generic `**\/*.node`
 *      rule unpacks `pty.node` but NOT `spawn-helper` (no `.node` extension);
 *      node-pty resolves the helper from `app.asar.unpacked` at runtime, so it
 *      must be on the real filesystem or `pty.fork()` throws "posix_spawnp
 *      failed".
 *   3. afterPack.mjs chmods the unpacked spawn-helper to 0755 — node-pty ships
 *      it 0644 (node-pty#850) and asarUnpack preserves that mode. Behavior of
 *      that chmod is covered by ensure-node-pty-exec.test.ts; this guard only
 *      pins that the call site still exists alongside the unpack rule.
 *   4. Linux packages retain both ELF addons while excluding foreign-platform
 *      prebuilds and Windows debug symbols.
 *   5. Windows packages retain BOTH win32 PE prebuilds (runtime selects by
 *      process.arch) while excluding POSIX prebuilds, .pdb debug symbols, and
 *      the build/ + third_party/ source trees; node-pty's lib/ and package.json
 *      are asar-unpacked (the ConPTY conout worker runs on a worker thread,
 *      which cannot load JS from inside an asar); and the Microsoft-signed
 *      conpty.dll + OpenConsole.exe pair is excluded from our signing pass.
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
  linux?: { files?: string[] };
  win?: { files?: string[]; signExts?: string[] };
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
        'build from failing the whole workspace install.',
    ).toBe('1.2.0-beta.15');
    expect(
      pkg.dependencies?.['node-pty'],
      'node-pty must not also appear in dependencies — that placement makes its native build ' +
        'failure fatal to pnpm install on machines without a C toolchain.',
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

  test.each([
    ['linux-x64', 62],
    ['linux-arm64', 183],
  ])('%s ships an ELF pty.node for the declared architecture', (platformArch, elfMachine) => {
    const addon = resolve(
      desktopRoot,
      'node_modules',
      'node-pty',
      'prebuilds',
      platformArch,
      'pty.node',
    );
    expect(existsSync(addon), `node-pty must ship ${platformArch}/pty.node`).toBe(true);

    const binary = readFileSync(addon);
    expect([...binary.subarray(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    expect(binary.readUInt16LE(18)).toBe(elfMachine);
  });

  test('linux packages node-pty but excludes foreign prebuilds and debug symbols', () => {
    const patterns = readBuilderConfig().linux?.files ?? [];
    expect(patterns).not.toContain('!**/node_modules/node-pty/**');
    expect(patterns).toContain('!**/node_modules/node-pty/prebuilds/**/*.pdb');
    expect(patterns).toContain('!**/node_modules/node-pty/prebuilds/darwin-*/**');
    expect(patterns).toContain('!**/node_modules/node-pty/prebuilds/win32-*/**');
  });

  test('win packages node-pty but excludes foreign prebuilds, debug symbols, and source trees', () => {
    const patterns = readBuilderConfig().win?.files ?? [];
    expect(
      patterns,
      'The blanket node-pty exclusion is gone for good: the Windows terminal runs on the ' +
        'win32 ConPTY prebuilds, so the win package must ship node-pty.',
    ).not.toContain('!**/node_modules/node-pty/**');
    expect(patterns).toContain('!**/node_modules/node-pty/prebuilds/**/*.pdb');
    expect(patterns).toContain('!**/node_modules/node-pty/prebuilds/darwin-*/**');
    expect(patterns).toContain('!**/node_modules/node-pty/prebuilds/linux-*/**');
    expect(
      patterns,
      "mac/win builds keep @electron/rebuild enabled and node-pty's node-gyp output under " +
        'build/ shadows the prebuilds at require() time — without this prune a cross-arch ' +
        'build ships builder-host binaries.',
    ).toContain('!**/node_modules/node-pty/build/**');
    expect(patterns).toContain('!**/node_modules/node-pty/third_party/**');
    const win32Excludes = patterns.filter(
      (pattern) => pattern.includes('node-pty') && pattern.includes('win32'),
    );
    expect(
      win32Excludes,
      'BOTH win32 arch prebuilds must ship in BOTH per-arch installers — the addon selects ' +
        'prebuilds/win32-<process.arch> at runtime, which keeps x64-under-emulation working ' +
        'on arm64 hosts.',
    ).toEqual([]);
  });

  test.each([
    ['win32-x64', 0x8664],
    ['win32-arm64', 0xaa64],
  ])('%s ships PE conpty addons with the Microsoft ConPTY pair beside them', (platformArch, peMachine) => {
    for (const name of [
      'conpty.node',
      'conpty_console_list.node',
      'conpty/conpty.dll',
      'conpty/OpenConsole.exe',
    ]) {
      const file = resolve(
        desktopRoot,
        'node_modules',
        'node-pty',
        'prebuilds',
        platformArch,
        name,
      );
      expect(existsSync(file), `node-pty must ship ${platformArch}/${name}`).toBe(true);
      const binary = readFileSync(file);
      expect(binary.readUInt16LE(0), `${platformArch}/${name}: MZ magic`).toBe(0x5a4d);
      const peOffset = binary.readUInt32LE(0x3c);
      expect(binary.readUInt32LE(peOffset), `${platformArch}/${name}: PE signature`).toBe(0x4550);
      expect(binary.readUInt16LE(peOffset + 4), `${platformArch}/${name}: PE machine word`).toBe(
        peMachine,
      );
    }
  });

  test('asarUnpack covers node-pty lib/ and package.json (conout worker runs off the real filesystem)', () => {
    const patterns = readBuilderConfig().asarUnpack ?? [];
    expect(
      patterns,
      "Add '**/node-pty/lib/**' to asarUnpack: node-pty reads ConPTY output on a worker thread " +
        '(lib/worker/conoutSocketWorker.js), and worker_threads cannot load JS from inside an asar.',
    ).toContain('**/node-pty/lib/**');
    expect(
      patterns,
      "Add '**/node-pty/package.json' to asarUnpack: the conout worker's CJS require() resolution " +
        "needs node-pty's package.json on the real filesystem beside the unpacked lib/.",
    ).toContain('**/node-pty/package.json');
  });

  test('win signing excludes the Microsoft-signed OpenConsole.exe (signExts intent)', () => {
    expect(
      readBuilderConfig().win?.signExts,
      'win.signExts must stay ["!OpenConsole.exe"]: electron-builder signs every packaged .exe by ' +
        "default, and re-signing OpenConsole.exe would replace Microsoft's Authenticode signature " +
        "and split the ConPTY pair's provenance (conpty.dll is safe either way — only .exe files " +
        'are in the default signing set). MIGRATION NOTE for the electron-builder v27 upgrade: v27 ' +
        'replaces win.signtoolOptions/azureSignOptions with a win.sign union — re-express this ' +
        'exclusion under the new win.sign surface when bumping past ^26.',
    ).toEqual(['!OpenConsole.exe']);
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

describe('node-pty electron-vite externalization', () => {
  /**
   * electron-vite's `externalizeDeps: true` externalizes ONLY `dependencies` —
   * optionalDependencies are never consulted. With node-pty pinned in
   * optionalDependencies (load-bearing, see above), it MUST be named as an
   * explicit rollup external in the main build, or rolldown bundles node-pty's
   * JS into out/main/chunks/ and its __dirname-relative native loader can no
   * longer reach app.asar.unpacked/node_modules/node-pty/ — every terminal
   * create then fails with spawn-error ("The terminal stopped unexpectedly.",
   * v0.25.0 stable regression).
   */
  test('node-pty is externalized in the main build despite optionalDependencies placement', async () => {
    const config = (await import('../../electron.vite.config.ts')).default as {
      main?: { build?: { rollupOptions?: { external?: unknown } } };
    };
    const external = config.main?.build?.rollupOptions?.external;
    const externals = Array.isArray(external) ? external : [external];
    const pkg = readPkg();
    const autoExternalized = 'node-pty' in (pkg.dependencies ?? {});
    expect(
      autoExternalized || externals.includes('node-pty'),
      'node-pty must be externalized in the electron-vite main build. It lives in optionalDependencies, ' +
        "which externalizeDeps: true does NOT cover (it reads pkg.dependencies only) — add 'node-pty' to " +
        'main.build.rollupOptions.external in electron.vite.config.ts, or the bundled loader breaks every ' +
        'packaged terminal spawn.',
    ).toBe(true);
  });
});
