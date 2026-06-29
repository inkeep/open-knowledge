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
