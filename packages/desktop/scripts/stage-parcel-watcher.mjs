#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..');
const STAGING = join(DESKTOP_ROOT, 'build', 'parcel-watcher-staging', 'node_modules');

const RUNTIME_DEPS = ['picomatch', 'is-glob', 'is-extglob', 'detect-libc'];

const PREBUILD_SUFFIXES = [
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'win32-arm64',
  'linux-x64-glibc',
  'linux-arm64-glibc',
];

const requireFromRepo = createRequire(join(REPO_ROOT, 'noop.js'));

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
const requireFromParcel = createRequire(join(parcelDir, 'package.json'));

rmSync(dirname(STAGING), { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });

function stagePackage(name, srcDir, { runtimeFilesOnly = false } = {}) {
  const dest = join(STAGING, name);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(srcDir, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      if (!runtimeFilesOnly) return true;
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
