import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';


const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const builderYml = resolve(desktopRoot, 'electron-builder.yml');
const okRoot = resolve(desktopRoot, '..', '..');
const parcelPkgDir = resolve(okRoot, 'node_modules', '@parcel', 'watcher');

const HEADERS_ONLY_DEPS = new Set(['node-addon-api']);

function collectRuntimeDeps(rootPkgDir: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [rootPkgDir];
  while (queue.length > 0) {
    const pkgDir = queue.shift();
    if (pkgDir === undefined) continue;
    const pkgJsonPath = resolve(pkgDir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const depName of Object.keys(pkg.dependencies ?? {})) {
      if (HEADERS_ONLY_DEPS.has(depName)) continue;
      if (seen.has(depName)) continue;
      seen.add(depName);
      const nestedPath = resolve(pkgDir, 'node_modules', depName);
      const hoistedPath = resolve(okRoot, 'node_modules', depName);
      if (existsSync(nestedPath)) {
        queue.push(nestedPath);
      } else if (existsSync(hoistedPath)) {
        queue.push(hoistedPath);
      }
    }
  }
  return seen;
}

describe('asarUnpack covers @parcel/watcher runtime deps', () => {
  let patterns: string[] = [];
  try {
    const yml = readFileSync(builderYml, 'utf8');
    const config = parse(yml) as { asarUnpack?: string[] };
    patterns = config.asarUnpack ?? [];
  } catch {
  }

  test('builder yml + parcel package.json both exist (premise check)', () => {
    expect(existsSync(builderYml)).toBe(true);
    expect(existsSync(resolve(parcelPkgDir, 'package.json'))).toBe(true);
  });

  let runtimeDeps: string[] = [];
  try {
    runtimeDeps = [...collectRuntimeDeps(parcelPkgDir)].sort();
  } catch {
  }

  test('runtime dep set is non-empty (cwd / install sanity)', () => {
    expect(runtimeDeps.length).toBeGreaterThan(0);
  });

  for (const dep of runtimeDeps) {
    test(`unpack rule covers '${dep}'`, () => {
      const covered = patterns.some((p) => p === `**/${dep}/**` || p === `**/${dep}`);
      expect(
        covered,
        `Add '**/${dep}/**' to electron-builder.yml asarUnpack. ` +
          `@parcel/watcher's wrapper requires it at runtime; if it stays ` +
          `inside app.asar/ while wrapper.js is in app.asar.unpacked/, ` +
          `parcel fails to load and the desktop silently degrades to ` +
          `chokidar.`,
      ).toBe(true);
    });
  }
});
