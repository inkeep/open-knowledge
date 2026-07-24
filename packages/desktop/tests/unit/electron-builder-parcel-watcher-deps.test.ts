import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
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
 * Resolve a dependency's package directory the way Node's runtime `require()`
 * does from `fromPkgDir`. pnpm's isolated layout does not nest a package's
 * deps under its own `node_modules/` nor hoist them to the workspace root, so
 * path-guessing misses the transitive tree entirely — Node's own resolver is
 * the only reliable oracle for where the wrapper's `require()` will land.
 */
function resolveDepPkgDir(
  requireFrom: ReturnType<typeof createRequire>,
  depName: string,
): string | undefined {
  // Direct package.json resolve — works whenever the dep has no `exports`
  // restriction (true across @parcel/watcher's runtime tree).
  try {
    return dirname(requireFrom.resolve(`${depName}/package.json`));
  } catch {
    // exports-restricted: fall through to the main-entry walk-up.
  }
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
  } catch {
    // Genuinely unresolvable (e.g. an optional dep absent on this platform) —
    // skip; the per-dep coverage assertions never see it, same as before.
  }
  return undefined;
}

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
    const requireFromPkg = createRequire(pkgJsonPath);
    for (const depName of Object.keys(pkg.dependencies ?? {})) {
      if (HEADERS_ONLY_DEPS.has(depName)) continue;
      if (seen.has(depName)) continue;
      seen.add(depName);
      // Resolve via Node so the walk descends pnpm's `.pnpm/`-isolated tree
      // (path-guessing at `node_modules/<dep>` silently stops at the direct
      // deps under pnpm and leaves transitive deps unverified).
      const depDir = resolveDepPkgDir(requireFromPkg, depName);
      if (depDir !== undefined) queue.push(depDir);
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

/**
 * The asarUnpack rules above cover the desktop app's OWN copy of
 * @parcel/watcher. The spawned `ok start` CLI resolves from a separate tree
 * (`cli/node_modules/`) it never reaches through the asar, so it needs its own
 * copy — staged by `scripts/stage-parcel-watcher.mjs` and placed by the
 * `build/parcel-watcher-staging/node_modules → cli/node_modules` extraResources
 * rule. This suite runs the staging script and verifies the staged tree is
 * actually resolvable the way the CLI will load it — the packaging-time
 * signal for #760 that doesn't need a full DMG build.
 */
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
    // Surface the script's own stderr so a CI failure names WHY (unresolvable
    // package / dep, zero binaries) instead of a bare non-zero exit.
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
    // detect-libc is require()d by index.js on linux; staged on every platform
    // so a Linux staging regression is caught here rather than only in a Linux
    // packaged build.
    for (const dep of ['picomatch', 'is-glob', 'is-extglob', 'detect-libc']) {
      expect(() => req.resolve(dep), `'${dep}' must resolve from the staged wrapper`).not.toThrow();
    }
    // The workspace carries both picomatch v2 and v4; the wrapper needs v4. A
    // static `.npmrc` hoist could stage v2 — assert the resolver-accurate copy
    // shipped the major the wrapper actually loads.
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
    } catch {
      // Fall through — the assertion below names the missing/unreadable rule.
    }
    const rule = extraResources.find(
      (r) => r.from === 'build/parcel-watcher-staging/node_modules' && r.to === 'cli/node_modules',
    );
    expect(
      rule,
      'electron-builder.yml must copy build/parcel-watcher-staging/node_modules → cli/node_modules',
    ).toBeTruthy();
  });
});
