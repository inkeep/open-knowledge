import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';


const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const builderYml = resolve(desktopRoot, 'electron-builder.yml');

describe('electron-builder.yml ships cli/package.json next to cli/dist', () => {
  test('electron-builder.yml exists', () => {
    expect(existsSync(builderYml)).toBe(true);
  });

  test('extraResources declares a from: ../cli/package.json -> to: cli/package.json rule', () => {
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
