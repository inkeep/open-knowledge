/**
 * Pins the dev-boot mechanism: a `predev` hook in `packages/app/package.json`
 * builds `@inkeep/open-knowledge-core` and `@inkeep/open-knowledge-server`
 * before Vite starts, so the config bundler can resolve their `default →
 * ./dist/*.mjs` entries on a fresh checkout.
 *
 * Background.
 *
 *   Vite's `vite.config.ts` bundler (`nodeResolveWithVite` in
 *   `vite/dist/node/chunks/node.js`) uses conditions `['node', ...optional
 *   'module-sync']`. It does NOT see `development` (runtime-only). A fresh
 *   checkout has no `dist/`, so resolution falls through to `default → dist`
 *   → ENOENT → vite-plugin-externalize-deps throws "Failed to resolve entry
 *   for package @inkeep/open-knowledge-server".
 *
 * Why predev (not a `node` exports condition).
 *
 *   A `node → ./src/index.ts` entry IS read by Vite's bundler — but it is
 *   ALSO read at packaged-Electron-main runtime. `electron.vite.config.ts`
 *   sets `main.build.externalizeDeps: true`, so packaged main ships
 *   `import '@inkeep/open-knowledge-server'` verbatim. Node 22 (Electron 41
 *   main) matches the `node` condition first and returns `./src/index.ts`,
 *   which it cannot load → `ERR_UNKNOWN_FILE_EXTENSION` on app startup. The
 *   predev hook side-steps the conflict by ensuring `dist/` exists; the
 *   config bundler then resolves via `default → dist`, and packaged main
 *   does the same.
 *
 * What we pin here.
 *
 *   1. `packages/app/package.json` has a `predev` script that builds both
 *      workspace deps. Removing it would re-introduce the fresh-checkout
 *      boot failure.
 *   2. The `exports` map of both packages has `default → ./dist/*.mjs` so
 *      the post-predev resolve has a target.
 *   3. There is NO `node` condition on these export entries (would break
 *      packaged Electron main).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface ExportEntry {
  development?: string;
  types?: string;
  node?: string;
  default?: string;
}

function readPkg(pkgRelative: string): {
  scripts: Record<string, string>;
  exports: Record<string, ExportEntry>;
} {
  const pkgPath = resolve(import.meta.dirname ?? '.', '../..', pkgRelative, 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
    scripts: Record<string, string>;
    exports: Record<string, ExportEntry>;
  };
}

describe('dev-boot mechanism — predev hook + dist exports', () => {
  test('packages/app has predev hook that builds core + server workspace deps', () => {
    const { scripts } = readPkg('app');
    expect(scripts.predev, 'packages/app/package.json missing `predev` script').toBeDefined();
    expect(scripts.predev).toContain('@inkeep/open-knowledge-core');
    expect(scripts.predev).toContain('@inkeep/open-knowledge-server');
  });

  for (const pkgName of ['core', 'server']) {
    describe(`@inkeep/open-knowledge-${pkgName}`, () => {
      test('"." exports has default → ./dist/*.mjs', () => {
        const pkgExports = readPkg(pkgName).exports;
        const dot = pkgExports['.'];
        expect(dot?.default).toMatch(/^\.\/dist\/.+\.mjs$/);
      });

      test('"." exports must NOT carry the `node` condition (would break packaged Electron main)', () => {
        const pkgExports = readPkg(pkgName).exports;
        const dot = pkgExports['.'];
        expect(
          dot?.node,
          `${pkgName} exports["."]: node condition resolves to TS source at packaged Electron main runtime`,
        ).toBeUndefined();
      });

      test('every subpath that has `development` must also have `default` (no half-built exports)', () => {
        const pkgExports = readPkg(pkgName).exports;
        for (const subpath of Object.keys(pkgExports)) {
          const entry = pkgExports[subpath];
          if (!entry?.development) continue;
          expect(
            entry.default,
            `${pkgName} exports["${subpath}"] missing default → dist mapping`,
          ).toMatch(/^\.\/dist\/.+\.mjs$/);
          expect(
            entry.node,
            `${pkgName} exports["${subpath}"] must NOT have the node condition`,
          ).toBeUndefined();
        }
      });
    });
  }
});
