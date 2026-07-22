#!/usr/bin/env node
/**
 * Force-install the @napi-rs/keyring prebuilt binary packages a Windows or
 * Linux desktop build needs before electron-builder runs.
 *
 * Sibling of `prepare-universal.mjs` (the darwin/universal variant — kept
 * separate so the shipping mac pipeline stays untouched). Same root cause:
 * `@napi-rs/keyring` publishes per-arch binaries as optionalDependencies
 * with `cpu`/`os` constraints, and pnpm installs only the host-matching one.
 * The `win.extraResources` / `linux.extraResources` rules in
 * electron-builder.yml copy BOTH arch packages (x64 + arm64) into
 * `cli/node_modules/`, so a single-arch host must fetch the missing ones
 * from the registry first or the copy rule fails the build.
 *
 * Pulls each missing tarball from registry.npmjs.org and extracts to
 * <repo-root>/node_modules/@napi-rs/keyring-<platform>-<arch>/, matching
 * the layout the package manager produces for the host package. Idempotent: skips when the
 * target dir already has a matching-version package.json.
 *
 * No-op on darwin (use `prepare-universal.mjs` there).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const PLATFORM_PACKAGES = {
  win32: ['win32-x64-msvc', 'win32-arm64-msvc'],
  linux: ['linux-x64-gnu', 'linux-arm64-gnu'],
};

const suffixes = PLATFORM_PACKAGES[process.platform];
if (!suffixes) {
  console.log(
    `[prepare-platform-natives] platform=${process.platform} — no-op (win32/linux only; darwin uses prepare-universal.mjs).`,
  );
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const NAPI_DIR = join(REPO_ROOT, 'node_modules', '@napi-rs');

// Resolve the target version from the installed wrapper package — it is a
// plain dependency (no cpu/os constraint) and present on every platform,
// unlike the host binary package prepare-universal keys off (its name
// varies with libc on linux, e.g. -gnu vs -musl hosts).
const wrapperPkgJson = join(NAPI_DIR, 'keyring', 'package.json');
if (!existsSync(wrapperPkgJson)) {
  console.error(
    `[prepare-platform-natives] @napi-rs/keyring not present at ${wrapperPkgJson}. Run \`pnpm install\` first.`,
  );
  process.exit(1);
}
const version = JSON.parse(readFileSync(wrapperPkgJson, 'utf8')).version;

/**
 * Expected sha512 integrity for `<pkgName>@<version>` from pnpm-lock.yaml —
 * the registry fetch below deliberately bypasses the package manager (the
 * packages are cpu/os-gated so pnpm won't install them here), so the
 * lockfile's recorded integrity is re-checked by hand. Fail-closed: a
 * package missing from the lockfile means the fetch would be entirely
 * unpinned, which is exactly the supply-chain gap this check closes.
 */
function lockfileIntegrityFor(pkgName, pkgVersion) {
  const lockfile = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
  const key = `${pkgName}@${pkgVersion}`;
  const at = lockfile.indexOf(`'${key}':`);
  if (at === -1) return null;
  const window = lockfile.slice(at, at + 500);
  const m = /integrity: (sha512-[A-Za-z0-9+/=]+)/.exec(window);
  return m?.[1] ?? null;
}

console.log(`[prepare-platform-natives] target version: @napi-rs/keyring-* v${version}`);
console.log(`[prepare-platform-natives] @napi-rs root: ${NAPI_DIR}`);

for (const suffix of suffixes) {
  const pkgName = `@napi-rs/keyring-${suffix}`;
  const targetDir = join(NAPI_DIR, `keyring-${suffix}`);
  const targetPkgJson = join(targetDir, 'package.json');

  if (existsSync(targetPkgJson)) {
    const installed = JSON.parse(readFileSync(targetPkgJson, 'utf8'));
    if (installed.version === version) {
      console.log(`[prepare-platform-natives]   ${pkgName}@${version} present — skip`);
      continue;
    }
    console.log(
      `[prepare-platform-natives]   ${pkgName} version mismatch (have=${installed.version}, want=${version}) — re-extracting`,
    );
    rmSync(targetDir, { recursive: true, force: true });
  } else {
    console.log(`[prepare-platform-natives]   ${pkgName}@${version} missing — fetching`);
  }

  const tarballUrl = `https://registry.npmjs.org/${pkgName}/-/keyring-${suffix}-${version}.tgz`;
  const tmpTarball = join(tmpdir(), `keyring-${suffix}-${version}-${process.pid}.tgz`);

  const expectedIntegrity = lockfileIntegrityFor(pkgName, version);
  if (!expectedIntegrity) {
    console.error(
      `[prepare-platform-natives]   ${pkgName}@${version} has no integrity entry in pnpm-lock.yaml — refusing an unpinned registry fetch.`,
    );
    process.exit(1);
  }

  const res = await fetch(tarballUrl);
  if (!res.ok) {
    console.error(
      `[prepare-platform-natives]   fetch ${tarballUrl} → ${res.status} ${res.statusText}`,
    );
    process.exit(1);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpTarball));

  try {
    const actual = `sha512-${createHash('sha512').update(readFileSync(tmpTarball)).digest('base64')}`;
    if (actual !== expectedIntegrity) {
      console.error(
        `[prepare-platform-natives]   integrity mismatch for ${pkgName}@${version}: expected ${expectedIntegrity}, got ${actual}`,
      );
      process.exit(1);
    }

    mkdirSync(targetDir, { recursive: true });
    // bsdtar ships with Windows 10+ (and every Linux runner), so plain `tar`
    // works on both platforms this script supports.
    execFileSync('tar', ['-xzf', tmpTarball, '-C', targetDir, '--strip-components=1'], {
      stdio: 'inherit',
    });
  } finally {
    rmSync(tmpTarball, { force: true });
  }

  console.log(`[prepare-platform-natives]   extracted ${pkgName}@${version} → ${targetDir}`);
}

console.log('[prepare-platform-natives] all target-platform keyring prebuilds present.');
