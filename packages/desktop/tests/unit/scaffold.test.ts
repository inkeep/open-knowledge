import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OK_DIR } from '@inkeep/open-knowledge-core';

/**
 * Scaffold placeholder test. Validates that the desktop package can
 * import from both workspace deps it declared (`@inkeep/open-knowledge-core`
 * + `@inkeep/open-knowledge-server`) without module-resolution errors.
 *
 * Expands with real preload-bridge / main-window / utility-entry
 * unit tests. Keeps this test so `bun test` never runs zero-files.
 */
describe('desktop scaffold', () => {
  test('OK_DIR from core resolves to .ok', () => {
    expect(OK_DIR).toBe('.ok');
  });

  test('server package is importable', async () => {
    const server = await import('@inkeep/open-knowledge-server');
    expect(typeof server.bootServer).toBe('function');
    expect(typeof server.createServer).toBe('function');
  });

  /**
   * Desktop tests MUST resolve workspace deps to their built `dist/` bundle, not
   * the `development`-condition `src` barrel. With `--conditions=development`,
   * `@inkeep/open-knowledge-server` resolves to its large multi-file
   * `src/index.ts` re-export barrel, and Bun's loader intermittently fails to
   * link all of those re-exports under `bun test` — throwing
   * `SyntaxError: Export named '<x>' not found in module '.../src/index.ts'` and
   * reddening the whole tier, a flake that clears on re-run (a known Bun barrel
   * re-export resolution bug class, e.g. oven-sh/bun#7384). The bundled
   * single-entry `dist/index.mjs` (guaranteed built by turbo's `^build`
   * dependency of the `test` task) has no such barrel to re-link. The desktop
   * `test` script therefore omits `--conditions=development`; this guard fails
   * loudly if that flag is ever restored.
   */
  test('workspace deps resolve to built dist, not the src barrel', () => {
    // Anchor to the package entry tail: an absolute repo path can itself
    // contain `/src/` (e.g. a `~/src/` checkout), so match only the resolved
    // module's own `dist/<entry>.mjs` suffix, never the `src/<entry>.ts` barrel.
    expect(import.meta.resolve('@inkeep/open-knowledge-server')).toMatch(/\/dist\/index\.mjs$/);
    expect(import.meta.resolve('@inkeep/open-knowledge-core')).toMatch(/\/dist\/index\.mjs$/);
  });
});

/**
 * Mechanical enforcement of the electron-version contract.
 *
 * `packages/desktop/package.json`'s `electron` devDep version MUST match
 * `packages/desktop/electron-builder.yml`'s `electronVersion` byte-for-byte.
 * A drift between these two values causes a silent ABI mismatch in the
 * packaged DMG: `@electron/rebuild` compiles native modules
 * (`@napi-rs/keyring`, `@parcel/watcher`) against the yml version, but the
 * runtime uses the package.json version. The resulting packaged app crashes
 * at `dlopen` time — caught only post-ship.
 *
 * The yml's comment warns humans; this test catches drift mechanically so
 * agents bumping only one side of the pair fail loud in CI.
 */
describe('M2 electron-version contract (D6)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const desktopRoot = resolve(__dirname, '../..');

  test('package.json `electron` devDep matches electron-builder.yml `electronVersion`', () => {
    const pkg = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'));
    const yml = readFileSync(resolve(desktopRoot, 'electron-builder.yml'), 'utf8');

    const pkgVersion = pkg.devDependencies?.electron as string | undefined;
    expect(pkgVersion, 'electron devDep missing from package.json').toBeDefined();

    // Both must be pinned exact (no caret/tilde). A caret range on either
    // side reintroduces the drift this test is designed to catch.
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+$/);

    const ymlMatch = yml.match(/^electronVersion:\s*"([^"]+)"$/m);
    expect(ymlMatch, 'electronVersion not found in electron-builder.yml').not.toBeNull();
    const ymlVersion = ymlMatch?.[1];

    expect(ymlVersion).toBe(pkgVersion);
  });
});
