import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Regression guard: the packaged `.app` must ship `cli/package.json` next to
 * `cli/dist/`.
 *
 * `@inkeep/open-knowledge-server`'s `version-constants.ts` reads its
 * neighbouring `package.json` at module load to populate `RUNTIME_VERSION`
 * — the value written into `server.lock`'s `runtimeVersion` field. The CLI
 * bundles the server source into `cli/dist/`, so the resolution walks
 * `dist/../` and lands on `cli/package.json`. If electron-builder's
 * `extraResources` ships `../cli/dist` but NOT `../cli/package.json`, the
 * resolution throws ENOENT, the read returns the `0.0.0-unknown` sentinel,
 * and every desktop-spawned server.lock loses its diagnostic version field.
 *
 * The runtime-side canary at `packages/server/src/version-constants.test.ts`
 * only exercises the dev `src/` and bundled `dist/index.mjs` layouts — both
 * have `package.json` adjacent. It cannot see the desktop packaging layout,
 * which strips `package.json` unless this rule is present. Hence this test.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const builderYml = resolve(desktopRoot, 'electron-builder.yml');

describe('electron-builder.yml ships cli/package.json next to cli/dist', () => {
  test('electron-builder.yml exists', () => {
    expect(existsSync(builderYml)).toBe(true);
  });

  test('extraResources declares a from: ../cli/package.json -> to: cli/package.json rule', () => {
    // Structural YAML parse — immune to quoting style (bare vs single vs
    // double), key ordering inside an entry, or interleaved keys (a future
    // `filter:` between `from:` and `to:` would not break this check).
    // Lexical regex matching would silently false-negative on any of those.
    const yml = readFileSync(builderYml, 'utf8');
    const config = parse(yml) as {
      extraResources?: Array<{ from?: unknown; to?: unknown }>;
    };
    const rule = (config.extraResources ?? []).find(
      (r) => r.from === '../cli/package.json' && r.to === 'cli/package.json',
    );
    expect(
      rule,
      'electron-builder.yml extraResources must copy ../cli/package.json -> cli/package.json so ' +
        'RUNTIME_VERSION resolves at runtime inside the packaged .app (otherwise server.lock ' +
        'reports runtimeVersion: "0.0.0-unknown" — see version-constants.ts).',
    ).toBeDefined();
  });

  test('../cli/package.json exists at build time (so electron-builder has something to copy)', () => {
    // Defense-in-depth: catches the silent case where the YAML rule is
    // correct but the source file has been moved/renamed. cli/package.json
    // is the published manifest; its absence would already break dozens
    // of other things, so this is mostly a clearer-error guard for the
    // narrow failure mode where this canary's premise no longer holds.
    const cliPkgJson = resolve(desktopRoot, '..', 'cli', 'package.json');
    expect(existsSync(cliPkgJson)).toBe(true);
  });
});

describe('electron-builder.yml ships the project GPLv3 LICENSE', () => {
  test('extraResources declares a from: ../../LICENSE -> to: LICENSE rule', () => {
    const yml = readFileSync(builderYml, 'utf8');
    const config = parse(yml) as {
      extraResources?: Array<{ from?: unknown; to?: unknown }>;
    };
    const rule = (config.extraResources ?? []).find(
      (r) => r.from === '../../LICENSE' && r.to === 'LICENSE',
    );
    expect(
      rule,
      "electron-builder.yml extraResources must stage the project's GPLv3 LICENSE into the " +
        'packaged .app Resources root so the conveyed desktop app carries its own license text ' +
        "(electron-builder's auto-placed LICENSE covers Electron/Chromium only).",
    ).toBeDefined();
  });

  test('the source LICENSE exists at build time', () => {
    const okRootLicense = resolve(desktopRoot, '..', '..', 'LICENSE');
    expect(existsSync(okRootLicense)).toBe(true);
  });
});
