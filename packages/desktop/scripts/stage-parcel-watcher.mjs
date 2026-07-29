#!/usr/bin/env node
/**
 * Stage @parcel/watcher + its runtime tree for the bundled CLI.
 *
 * The packaged app spawns `ok start` from `Resources/cli/`, whose ESM/CJS
 * resolver walks `cli/dist → cli → Resources → …` and NEVER reaches
 * `app.asar.unpacked/node_modules/` (the same resolver-scope wall the
 * @napi-rs/keyring + native-config copies already work around). So the app's
 * asarUnpack copy of @parcel/watcher is invisible to the CLI: at boot
 * `import('@parcel/watcher')` throws `Cannot find package`, the file watcher
 * degrades to chokidar, and external edits under content subfolders stop
 * reaching the server until a restart. inkeep/open-knowledge#760.
 *
 * Fix: give the CLI its own copy under `cli/node_modules/`. This script stages
 * that copy into `build/parcel-watcher-staging/node_modules/`; electron-builder
 * copies the staged tree via a single `extraResources` rule.
 *
 * Resolver-accurate on purpose. @parcel/watcher's wrapper.js `require()`s
 * picomatch/is-glob/is-extglob and index.js `require()`s detect-libc (linux)
 * plus the per-arch `@parcel/watcher-<platform>-<arch>` binary. Those runtime
 * deps are deliberately NOT flat-root-hoisted (`.npmrc`) — the tree carries
 * both picomatch v2 and v4, so a static `from: node_modules/picomatch` rule
 * could ship the wrong major. We resolve each dep the way Node's runtime
 * `require()` does, from @parcel/watcher's own package dir, so the staged
 * versions are exactly what the wrapper loads.
 *
 * Cross-arch: pnpm installs only the host-matching `@parcel/watcher-*` binary,
 * and we stage whatever binary packages are present. The mac DMG is arm64-only
 * (matches the arm64-only host), so its arm64 binary is always present and the
 * fix is complete there. Linux builds each arch on a runner of that arch, so
 * both debs get their matching binary. Windows still packages both arches from
 * one x64 host, so its arm64 installer stages only the x64 binary and falls
 * back to chokidar (now subfolder-correct, #760) — degraded, not broken.
 * Fetching the missing-arch parcel binaries the way
 * `prepare-platform-natives.mjs` does for keyring is a follow-up.
 */
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..');
const STAGING = join(DESKTOP_ROOT, 'build', 'parcel-watcher-staging', 'node_modules');

/** Runtime JS deps @parcel/watcher `require()`s. node-addon-api is headers-only. */
const RUNTIME_DEPS = ['picomatch', 'is-glob', 'is-extglob', 'detect-libc'];

/**
 * Candidate per-arch binary packages for OUR build targets — mac (arm64/x64),
 * win (x64/arm64), linux (x64/arm64). We stage whichever are present rather
 * than hardcoding one target. @parcel/watcher also publishes musl and 32-bit
 * `linux-arm` variants; those are intentionally omitted — Electron desktop
 * ships glibc-only and we build no 32-bit-arm artifact, so they'd never load.
 */
const PREBUILD_SUFFIXES = [
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'win32-arm64',
  'linux-x64-glibc',
  'linux-arm64-glibc',
];

const requireFromRepo = createRequire(join(REPO_ROOT, 'noop.js'));

/** Resolve a package's dir the way Node's `require()` does (pnpm-isolation-safe). */
function resolvePkgDir(requireFrom, name) {
  try {
    return dirname(requireFrom.resolve(`${name}/package.json`));
  } catch {
    return undefined;
  }
}

const parcelDir = resolvePkgDir(requireFromRepo, '@parcel/watcher');
if (!parcelDir) {
  console.error(
    '[stage-parcel-watcher] @parcel/watcher not resolvable from the repo root. Run `pnpm install` first.',
  );
  process.exit(1);
}
const parcelVersion = JSON.parse(readFileSync(join(parcelDir, 'package.json'), 'utf8')).version;
// Resolve the wrapper's own deps from ITS package dir so we copy the exact
// versions it loads (picomatch v4, not the v2 elsewhere in the tree).
const requireFromParcel = createRequire(join(parcelDir, 'package.json'));

// Fresh staging tree each run — idempotent and never ships a stale version.
rmSync(dirname(STAGING), { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });

/** Copy a resolved package dir into the staging tree, filtering to runtime files. */
function stagePackage(name, srcDir, { runtimeFilesOnly = false } = {}) {
  const dest = join(STAGING, name);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(srcDir, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      if (!runtimeFilesOnly) return true;
      // Drop the C++ sources / gyp / prebuild scratch @parcel/watcher publishes
      // — dead weight in the app, none of it is loaded at runtime. cpSync hands
      // the filter native-separator paths, so split on both `/` and `\` or the
      // exclusion silently no-ops on Windows builds.
      const rel = src.slice(srcDir.length + 1);
      const top = rel.split(/[\\/]/)[0];
      return top !== 'src' && top !== 'build' && top !== 'prebuilds' && top !== 'binding.gyp';
    },
  });
  return dest;
}

console.log(`[stage-parcel-watcher] @parcel/watcher v${parcelVersion} → ${STAGING}`);
stagePackage('@parcel/watcher', parcelDir, { runtimeFilesOnly: true });

for (const dep of RUNTIME_DEPS) {
  const dir = resolvePkgDir(requireFromParcel, dep);
  if (!dir) {
    // detect-libc is only require()d on linux; the others are unconditional.
    if (dep === 'detect-libc') {
      console.log(`[stage-parcel-watcher]   ${dep} not resolvable — skipping (linux-only dep)`);
      continue;
    }
    console.error(`[stage-parcel-watcher]   required runtime dep '${dep}' not resolvable`);
    process.exit(1);
  }
  const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  stagePackage(dep, dir);
  console.log(`[stage-parcel-watcher]   ${dep} v${version}`);
}

let prebuilds = 0;
for (const suffix of PREBUILD_SUFFIXES) {
  const name = `@parcel/watcher-${suffix}`;
  const dir = resolvePkgDir(requireFromParcel, name);
  if (!dir) continue;
  stagePackage(name, dir);
  prebuilds++;
  console.log(`[stage-parcel-watcher]   ${name}`);
}
if (prebuilds === 0) {
  console.error(
    '[stage-parcel-watcher] no @parcel/watcher-<platform>-<arch> binary package staged — the CLI would still fall back to chokidar.',
  );
  process.exit(1);
}

console.log(
  `[stage-parcel-watcher] staged ${RUNTIME_DEPS.length} runtime deps + ${prebuilds} binary package(s).`,
);
