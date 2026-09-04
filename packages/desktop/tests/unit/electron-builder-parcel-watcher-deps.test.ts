import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const builderYml = resolve(desktopRoot, 'electron-builder.yml');
const okRoot = resolve(desktopRoot, '..', '..');
const parcelPkgDir = resolve(okRoot, 'node_modules', '@parcel', 'watcher');

const HEADERS_ONLY_DEPS = new Set(['node-addon-api']);

function resolveDepPkgDir(
  requireFrom: ReturnType<typeof createRequire>,
  depName: string,
): string | undefined {
  try {
    return dirname(requireFrom.resolve(`${depName}/package.json`));
  } catch {}
  try {
    let dir = dirname(requireFrom.resolve(depName));
    for (let hops = 0; hops < 12; hops++) {
      const pj = resolve(dir, 'package.json');
      if (existsSync(pj)) {
        const name = (JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name;
        if (name === depName) return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return undefined;
}

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
    const requireFromPkg = createRequire(pkgJsonPath);
    for (const depName of Object.keys(pkg.dependencies ?? {})) {
      if (HEADERS_ONLY_DEPS.has(depName)) continue;
      if (seen.has(depName)) continue;
      seen.add(depName);
      const depDir = resolveDepPkgDir(requireFromPkg, depName);
      if (depDir !== undefined) queue.push(depDir);
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
  } catch {}

  test('builder yml + parcel package.json both exist (premise check)', () => {
    expect(existsSync(builderYml)).toBe(true);
    expect(existsSync(resolve(parcelPkgDir, 'package.json'))).toBe(true);
  });

  let runtimeDeps: string[] = [];
  try {
    runtimeDeps = [...collectRuntimeDeps(parcelPkgDir)].sort();
  } catch {}

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

describe('stage-parcel-watcher stages a CLI-resolvable @parcel/watcher tree', () => {
  const stageScript = resolve(desktopRoot, 'scripts', 'stage-parcel-watcher.mjs');
  const stagedRoot = resolve(desktopRoot, 'build', 'parcel-watcher-staging', 'node_modules');
  const stagedParcelPkg = resolve(stagedRoot, '@parcel', 'watcher', 'package.json');

  let staged = false;
  let stageError = '';
  try {
    execFileSync('node', [stageScript], { stdio: 'pipe' });
    staged = true;
  } catch (err) {
    const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
    stageError = (e.stderr?.toString() || e.stdout?.toString() || e.message || '').trim();
  }

  test('the staging script runs and produces the staged wrapper', () => {
    expect(staged, `node scripts/stage-parcel-watcher.mjs failed:\n${stageError}`).toBe(true);
    expect(existsSync(stagedParcelPkg)).toBe(true);
  });

  test('the wrapper resolves its runtime deps from the staged tree, at picomatch v4', () => {
    if (!existsSync(stagedParcelPkg)) {
      expect(staged).toBe(true);
      return;
    }
    const req = createRequire(stagedParcelPkg);
    for (const dep of ['picomatch', 'is-glob', 'is-extglob', 'detect-libc']) {
      expect(() => req.resolve(dep), `'${dep}' must resolve from the staged wrapper`).not.toThrow();
    }
    const picomatch = JSON.parse(readFileSync(req.resolve('picomatch/package.json'), 'utf8')) as {
      version: string;
    };
    expect(picomatch.version.startsWith('4.')).toBe(true);
  });

  test('at least one per-arch binary package with a .node is staged', () => {
    const parcelScope = resolve(stagedRoot, '@parcel');
    if (!existsSync(parcelScope)) {
      expect(staged).toBe(true);
      return;
    }
    const prebuilds = readdirSync(parcelScope).filter((n) => n.startsWith('watcher-'));
    expect(prebuilds.length).toBeGreaterThan(0);
    const hasBinary = prebuilds.some((p) =>
      readdirSync(resolve(parcelScope, p)).some((f) => f.endsWith('.node')),
    );
    expect(hasBinary, 'a staged @parcel/watcher-* package must carry its .node binary').toBe(true);
  });

  test('electron-builder copies the staged tree onto the CLI path', () => {
    let extraResources: Array<{ from?: string; to?: string }> = [];
    try {
      const config = parse(readFileSync(builderYml, 'utf8')) as {
        extraResources?: Array<{ from?: string; to?: string }>;
      };
      extraResources = config.extraResources ?? [];
    } catch {}
    const rule = extraResources.find(
      (r) => r.from === 'build/parcel-watcher-staging/node_modules' && r.to === 'cli/node_modules',
    );
    expect(
      rule,
      'electron-builder.yml must copy build/parcel-watcher-staging/node_modules → cli/node_modules',
    ).toBeTruthy();
  });
});
