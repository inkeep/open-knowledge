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
   * Desktop tests resolve workspace deps to their `development`-condition
   * `src/index.ts` barrel, matching the shared vitest base config's
   * `ssr.resolve.conditions`. Running the suite against source (not a built
   * `dist/`) keeps it honest: an edit to a workspace dep is exercised
   * immediately, with no stale build in between.
   *
   * This package historically pinned `dist/` instead, to sidestep an
   * intermittent barrel re-export link failure in the old test runner
   * (`SyntaxError: Export named '<x>' not found in module '.../src/index.ts'`,
   * a known runner bug class, e.g. oven-sh/bun#7384). Vite's resolver links the
   * multi-file `src/index.ts` re-export barrel cleanly — the "server package is
   * importable" case above proves it — so the workaround is no longer needed.
   * This guard fails loudly if resolution ever silently flips back to `dist/`.
   */
  test('workspace deps resolve to the development src barrel', () => {
    // Anchor to the package entry tail: an absolute repo path can itself
    // contain `/dist/` somewhere, so match only the resolved module's own
    // `src/index.ts` suffix.
    expect(import.meta.resolve('@inkeep/open-knowledge-server')).toMatch(/\/src\/index\.ts$/);
    expect(import.meta.resolve('@inkeep/open-knowledge-core')).toMatch(/\/src\/index\.ts$/);
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
