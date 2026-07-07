import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Regression guard: every runtime JS dep of @parcel/watcher must be covered
 * by an asarUnpack glob.
 *
 * @parcel/watcher's wrapper.js requires its deps via plain `require()`. The
 * existing `**\/@parcel/watcher/**` unpack rule places that wrapper inside
 * app.asar.unpacked/. Node's module resolver from a file in
 * app.asar.unpacked/ walks the real filesystem only — it cannot cross into
 * the sibling app.asar/ to find a transitively-required module. So if any
 * runtime dep of @parcel/watcher stays packed inside app.asar/, the wrapper
 * fails with MODULE_NOT_FOUND at server boot.
 *
 * The server logs the failure and silently falls back to chokidar, which
 * runs on `fs.watch` recursive mode (chokidar v5 dropped fsevents). That
 * fallback misses bulk-create events from APFS `clonefile()` (Finder
 * Duplicate) and bulk-delete cascades from `rm -rf` or `git pull` — the
 * exact failure mode that prompted this guard.
 *
 * Symptom signature in `<contentDir>/.ok/local/last-spawn-error.log`:
 *     [file-watcher] @parcel/watcher import failed: Cannot find module '<dep>'
 *     [file-watcher] @parcel/watcher unavailable, using chokidar fallback
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const builderYml = resolve(desktopRoot, 'electron-builder.yml');
const okRoot = resolve(desktopRoot, '..', '..');
const parcelPkgDir = resolve(okRoot, 'node_modules', '@parcel', 'watcher');

/**
 * Headers-only deps loaded by `node-gyp` at build time, never `require()`d at
 * runtime. Safe to leave packed. Keep this set as small as possible — every
 * entry is an assertion that "we checked and this one really doesn't need
 * unpacking."
 */
const HEADERS_ONLY_DEPS = new Set(['node-addon-api']);

/**
 * Collect direct + transitive `dependencies` of @parcel/watcher whose
 * runtime presence the wrapper actually needs. Optional / platform-specific
 * native packages (`@parcel/watcher-*`) are covered by the separate
 * `**\/@parcel/watcher-*\/**` glob and intentionally ignored here.
 */
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
      // Bun may hoist to the workspace root or nest under the parent pkg.
      // Either resolves the same way Node does at runtime, so both are
      // valid sources of the dep's transitive tree.
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
  // Describe-scope reads execute before any test body runs. If either source
  // file is missing, an unguarded `readFileSync` / `collectRuntimeDeps` call
  // throws at module-load and bun:test reports a runner crash, hiding the
  // named "premise check" diagnostic below. Defaulting to empty arrays on
  // failure lets the premise-check assert the file-missing reality with a
  // readable message, and lets the per-dep tests fail with their own
  // "Add '**/<dep>/**' to electron-builder.yml asarUnpack" diagnostic.
  let patterns: string[] = [];
  try {
    const yml = readFileSync(builderYml, 'utf8');
    const config = parse(yml) as { asarUnpack?: string[] };
    patterns = config.asarUnpack ?? [];
  } catch {
    // Premise check below catches the file-missing case with a readable
    // failure; empty patterns flow through into the per-dep tests.
  }

  test('builder yml + parcel package.json both exist (premise check)', () => {
    expect(existsSync(builderYml)).toBe(true);
    expect(existsSync(resolve(parcelPkgDir, 'package.json'))).toBe(true);
  });

  let runtimeDeps: string[] = [];
  try {
    runtimeDeps = [...collectRuntimeDeps(parcelPkgDir)].sort();
  } catch {
    // Same rationale as above — let the non-empty assertion below name the
    // failure instead of crashing the describe load.
  }

  test('runtime dep set is non-empty (cwd / install sanity)', () => {
    // Defense in depth: if collectRuntimeDeps returns an empty set we'd
    // pass the per-dep assertions vacuously. Pin a floor so a future
    // refactor that breaks the walk fails loudly.
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
