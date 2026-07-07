import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Regression guard: every native addon that tsdown keeps EXTERNAL
 * (`neverBundle` in packages/cli/tsdown.config.ts) must be shipped onto the
 * bundled CLI's own module-resolution path — i.e. copied into
 * `cli/node_modules/<pkg>` by an electron-builder `extraResources` rule.
 *
 * Why: the desktop ships the CLI as a standalone tree at
 * `<App>/Contents/Resources/cli/dist/cli.mjs`. Node's ESM resolver from there
 * walks `cli/dist -> cli -> Resources -> ...` and never reaches
 * `app.asar.unpacked/node_modules/`, where the app's own copy of the native
 * lives. A `neverBundle` native with no `cli/node_modules` copy therefore
 * fails `import('<pkg>')` with ERR_MODULE_NOT_FOUND inside every CLI-spawned
 * process. For `@napi-rs/keyring` that silently downgraded auth storage to a
 * plaintext file (~/.ok/auth.yml); the fix ships it onto the CLI's path.
 *
 * Symptom signature: `[auth] token storage: file (~/.ok/auth.yml)` emitted by
 * the bundled `ok` CLI even on a machine whose keychain is available, because
 * `createTokenStore`'s `import('@napi-rs/keyring')` cannot resolve.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const builderYml = resolve(desktopRoot, 'electron-builder.yml');
const tsdownConfig = resolve(desktopRoot, '..', 'cli', 'tsdown.config.ts');
const okRoot = resolve(desktopRoot, '..', '..');

/**
 * Natives intentionally NOT shipped into cli/node_modules, each with its
 * reason. Every entry asserts "we considered this and decided the bundled-CLI
 * path doesn't need it." Keep this set as small as possible.
 *
 * `@parcel/watcher`: only reached when `ok start` / `ok mcp` boots the server
 * in-process from the bundled CLI. Its absence degrades to chokidar (a
 * functional fallback), not a silent security downgrade, and shipping it
 * cleanly requires its transitive runtime JS deps too (detect-libc, is-glob,
 * picomatch, ...).
 */
const KNOWN_UNCOVERED: Record<string, string> = {
  '@parcel/watcher': 'degrades to chokidar fallback; transitive runtime deps tracked as follow-up',
};

function readNeverBundle(): string[] {
  try {
    const src = readFileSync(tsdownConfig, 'utf8');
    const m = /neverBundle:\s*\[([^\]]*)\]/.exec(src);
    if (!m) return [];
    return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1] as string);
  } catch {
    return [];
  }
}

function readExtraResourceTargets(): string[] {
  try {
    const cfg = parse(readFileSync(builderYml, 'utf8')) as {
      extraResources?: Array<{ to?: string }>;
    };
    return (cfg.extraResources ?? []).map((r) => r.to ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

type ExtraResourceRule = { from?: string; to?: string; filter?: string[] | string };

function readExtraResources(): ExtraResourceRule[] {
  try {
    const cfg = parse(readFileSync(builderYml, 'utf8')) as { extraResources?: ExtraResourceRule[] };
    return cfg.extraResources ?? [];
  } catch {
    return [];
  }
}

function readAsarUnpack(): string[] {
  try {
    const cfg = parse(readFileSync(builderYml, 'utf8')) as { asarUnpack?: string[] };
    return cfg.asarUnpack ?? [];
  } catch {
    return [];
  }
}

function asFilterList(filter: string[] | string | undefined): string[] {
  if (Array.isArray(filter)) return filter;
  return filter ? [filter] : [];
}

describe('bundled CLI can resolve tsdown neverBundle native addons', () => {
  const neverBundle = readNeverBundle();
  const targets = readExtraResourceTargets();

  test('neverBundle list + electron-builder.yml parsed (premise check)', () => {
    expect(existsSync(builderYml)).toBe(true);
    expect(existsSync(tsdownConfig)).toBe(true);
    expect(neverBundle.length).toBeGreaterThan(0);
  });

  for (const pkg of neverBundle) {
    test(`'${pkg}' is shipped to cli/node_modules or explicitly allowlisted`, () => {
      const shipped = targets.includes(`cli/node_modules/${pkg}`);
      const allowlisted = pkg in KNOWN_UNCOVERED;
      expect(
        shipped || allowlisted,
        `tsdown keeps '${pkg}' external (neverBundle) but electron-builder.yml ships ` +
          `no 'cli/node_modules/${pkg}' copy rule. The bundled CLI cannot resolve it ` +
          `from cli/dist/ → ERR_MODULE_NOT_FOUND. Add an extraResources rule copying ` +
          `it (and its platform binary) into cli/node_modules/, or add it to ` +
          `KNOWN_UNCOVERED with a rationale.`,
      ).toBe(true);
    });
  }

  test("'@napi-rs/keyring' ships the wrapper AND an arm64 platform binary", () => {
    // The wrapper (@napi-rs/keyring) requires its sibling platform package at
    // runtime; both must be on the CLI's resolution path. arm64-only matches
    // the arm64-only DMG (see `mac.target` in electron-builder.yml).
    expect(targets).toContain('cli/node_modules/@napi-rs/keyring');
    const hasPlatform = targets.some((t) => t === 'cli/node_modules/@napi-rs/keyring-darwin-arm64');
    expect(
      hasPlatform,
      "Ship '@napi-rs/keyring-darwin-arm64' into cli/node_modules — the wrapper " +
        'requires its platform binary sibling at runtime.',
    ).toBe(true);
  });

  test('keyring copy sources exist at the hoisted root node_modules', () => {
    // The extraResources `from` paths point at the Bun-hoisted root. If hoisting
    // relocates them, the copy silently ships nothing, so fail loudly here.
    // The wrapper is a plain dependency (no os/cpu constraint) and is present
    // on every platform.
    expect(existsSync(resolve(okRoot, 'node_modules', '@napi-rs', 'keyring'))).toBe(true);
    // The platform binary is an optionalDependency the package manager installs
    // only on its matching os/cpu. The DMG builds on darwin-arm64, so assert the
    // source is present there; skip on other hosts (the CI `test` tier runs on
    // Linux, where Bun legitimately omits the darwin-arm64 package).
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(existsSync(resolve(okRoot, 'node_modules', '@napi-rs', 'keyring-darwin-arm64'))).toBe(
        true,
      );
    }
  });
});

/**
 * `@inkeep/open-knowledge-native-config` is the toml_edit addon. It differs from
 * `@napi-rs/keyring` in two ways that need their own guards: it is a workspace
 * package (not a published one with a separate per-arch binary package), so its
 * napi loader AND its `.node` live in one directory and must ship together; and
 * the desktop MAIN process loads it in-process (the MCP repair sweep's Codex TOML
 * write), so it must be unpacked from app.asar as well as copied onto the bundled
 * CLI's path. If the binary fails to ship, the TOML write falls back to a
 * non-destructive decline rather than corrupting a config — but that silently
 * removes Codex registration, so keep these shipping.
 */
describe('@inkeep/open-knowledge-native-config ships its napi loader + platform binary', () => {
  const NATIVE_CONFIG = '@inkeep/open-knowledge-native-config';
  const nativeConfigDir = resolve(desktopRoot, '..', 'native-config');

  test('an extraResources rule copies the addon into cli/node_modules shipping loader AND binary', () => {
    const rule = readExtraResources().find((r) => r.to === `cli/node_modules/${NATIVE_CONFIG}`);
    expect(
      rule,
      `electron-builder.yml has no extraResources rule copying ${NATIVE_CONFIG} into ` +
        'cli/node_modules. The bundled CLI cannot resolve the toml_edit addon from ' +
        'cli/dist/ → the Codex TOML write degrades to a non-destructive decline.',
    ).toBeDefined();
    const filter = asFilterList(rule?.filter);
    expect(filter).toContain('index.js');
    // The decisive difference from keyring: one workspace package whose `.node`
    // sits beside its loader, so the filter must ship the binary too. A loader
    // copied without the binary resolves, then throws on require('./<x>.node').
    expect(
      filter.includes('*.node'),
      `The ${NATIVE_CONFIG} extraResources filter must include '*.node' — without the ` +
        "platform binary the loader is shipped but require('./<binary>.node') throws.",
    ).toBe(true);
  });

  test('asarUnpack unpacks the addon for the in-process desktop main consumer', () => {
    // The generic `**/*.node` rule unpacks the binary; this package glob keeps the
    // napi loader co-located with the binary it requires, the path the desktop
    // main process resolves.
    expect(readAsarUnpack()).toContain(`**/${NATIVE_CONFIG}/**`);
  });

  test('the addon source dir exists at the extraResources `from` path', () => {
    // `from: ../native-config` resolves to packages/native-config. Its Rust
    // sources + package.json are git-tracked, so this is present on every host and
    // CI tier regardless of whether the napi binary has been built yet.
    expect(existsSync(nativeConfigDir)).toBe(true);
    expect(existsSync(resolve(nativeConfigDir, 'package.json'))).toBe(true);
  });

  test('the napi-built loader + a platform binary exist after a build', () => {
    // index.js + the .node are napi build artifacts (gitignored, regenerated by
    // `napi build`). `bun run check` builds native-config upstream of cli →
    // desktop, so they are present in the gate. On an isolated no-build run, warn
    // loudly and return rather than false-fail on a missing build artifact.
    const loader = resolve(nativeConfigDir, 'index.js');
    const nodeBinaries = existsSync(nativeConfigDir)
      ? readdirSync(nativeConfigDir).filter((f) => f.endsWith('.node'))
      : [];
    if (!existsSync(loader) || nodeBinaries.length === 0) {
      console.warn(
        `[electron-builder-cli-native-deps] SKIP: ${NATIVE_CONFIG} not built ` +
          `(no index.js / *.node in ${nativeConfigDir}). Run \`bun run build\` first; ` +
          'the gate builds it upstream of this tier.',
      );
      return;
    }
    expect(nodeBinaries.length).toBeGreaterThan(0);
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      // The arm64-only DMG ships exactly this binary (see mac.target).
      expect(nodeBinaries).toContain('native-config.darwin-arm64.node');
    }
  });
});

/**
 * The primary distribution path is now the prebuilt binaries bundled INTO the
 * CLI at `cli/dist/native/`
 * The CLI build copies the
 * napi loader + every present `.node` there; the runtime resolver
 * (`toml-config-engine.ts` / `symlink-resolve.ts`) tries that dist-relative
 * bundle first. The desktop ships `cli/dist` wholesale via an extraResources
 * rule, so the bundle reaches the packaged app's spawned `ok` subprocess for
 * free — these tests pin that the cli/dist rule does not filter the bundle out.
 * The per-package `cli/node_modules` copy + asarUnpack (above) remain for the
 * desktop MAIN process's in-process load.
 */
describe('@inkeep/open-knowledge-native-config ships bundled in cli/dist/native', () => {
  const cliDist = resolve(desktopRoot, '..', 'cli', 'dist');

  test('the cli/dist extraResources rule does not filter out the native bundle', () => {
    const rule = readExtraResources().find((r) => r.to === 'cli/dist');
    expect(
      rule,
      'electron-builder.yml must copy ../cli/dist into the packaged app so the ' +
        'bundled native-config (cli/dist/native) reaches the spawned CLI subprocess.',
    ).toBeDefined();
    const filter = asFilterList(rule?.filter);
    expect(filter).toContain('**/*');
    // The runtime bundle is index.js + package.json + *.node — none of these
    // may be excluded, or the dist-relative resolver finds no loader/binary.
    for (const excluded of ['!**/*.node', '!**/*.js', '!**/package.json', '!**/native/**']) {
      expect(
        filter.includes(excluded),
        `the cli/dist filter must not exclude '${excluded}' — it would strip the bundled addon.`,
      ).toBe(false);
    }
  });

  test('the bundled loader + platform binary exist in cli/dist/native after a build', () => {
    // build:native copies the loader + package.json + present .node into
    // cli/dist/native/. Gitignored build artifacts → skip-if-not-built with a
    // loud warn, like the per-package check above.
    const nativeBundle = resolve(cliDist, 'native');
    const loader = resolve(nativeBundle, 'index.js');
    const pkgJson = resolve(nativeBundle, 'package.json');
    const nodeBinaries = existsSync(nativeBundle)
      ? readdirSync(nativeBundle).filter((f) => f.endsWith('.node'))
      : [];
    if (!existsSync(loader) || nodeBinaries.length === 0) {
      console.warn(
        '[electron-builder-cli-native-deps] SKIP: cli/dist/native not built ' +
          `(no index.js / *.node in ${nativeBundle}). Run \`bun run build\` first.`,
      );
      return;
    }
    // package.json is load-bearing: cli/dist's package.json declares
    // "type":"module", so the CJS napi loader needs its own CommonJS package.json
    // beside it or Node mis-parses index.js as ESM and `require('./*.node')` fails.
    expect(existsSync(pkgJson)).toBe(true);
    expect(nodeBinaries.length).toBeGreaterThan(0);
  });
});
