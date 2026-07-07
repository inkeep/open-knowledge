#!/usr/bin/env node
/**
 * Force-install @napi-rs/keyring darwin prebuilds for BOTH architectures
 * before electron-builder's universal-DMG merge runs.
 *
 * @napi-rs/keyring publishes per-arch native binaries as optionalDependencies
 * with `cpu`/`os` constraints. Bun (and npm/pnpm) skip optionalDependencies
 * whose cpu/os doesn't match the host. On an arm64 macOS runner only
 * @napi-rs/keyring-darwin-arm64 gets installed; the darwin-x64 binary is
 * missing, and electron-builder's @electron/universal lipo-merge step either
 * errors or hangs waiting for x64 inputs that don't exist.
 *
 * Pulls each missing tarball from registry.npmjs.org and extracts to
 * <repo-root>/node_modules/@napi-rs/keyring-darwin-<arch>/, matching the
 * layout bun produces for the host arch. Idempotent: skips when the target
 * dir already has a matching-version package.json.
 *
 * No-op on non-darwin hosts.
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.log(`[prepare-universal] platform=${process.platform} — no-op (darwin-only).`);
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const NAPI_DIR = join(REPO_ROOT, 'node_modules', '@napi-rs');

const ARCHES = ['darwin-arm64', 'darwin-x64'];

const hostArch = `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const hostPkgJson = join(NAPI_DIR, `keyring-${hostArch}`, 'package.json');
if (!existsSync(hostPkgJson)) {
  console.error(
    `[prepare-universal] @napi-rs/keyring-${hostArch} not present at ${hostPkgJson}. ` +
      `Run \`bun install\` first.`,
  );
  process.exit(1);
}
const version = JSON.parse(readFileSync(hostPkgJson, 'utf8')).version;

console.log(`[prepare-universal] target version: @napi-rs/keyring-darwin-* v${version}`);
console.log(`[prepare-universal] @napi-rs root: ${NAPI_DIR}`);

for (const arch of ARCHES) {
  const pkgName = `@napi-rs/keyring-${arch}`;
  const targetDir = join(NAPI_DIR, `keyring-${arch}`);
  const targetPkgJson = join(targetDir, 'package.json');

  if (existsSync(targetPkgJson)) {
    const installed = JSON.parse(readFileSync(targetPkgJson, 'utf8'));
    if (installed.version === version) {
      console.log(`[prepare-universal]   ${pkgName}@${version} present — skip`);
      continue;
    }
    console.log(
      `[prepare-universal]   ${pkgName} version mismatch (have=${installed.version}, want=${version}) — re-extracting`,
    );
    rmSync(targetDir, { recursive: true, force: true });
  } else {
    console.log(`[prepare-universal]   ${pkgName}@${version} missing — fetching`);
  }

  const tarballUrl = `https://registry.npmjs.org/${pkgName}/-/keyring-${arch}-${version}.tgz`;
  const tmpTarball = join(tmpdir(), `keyring-${arch}-${version}-${process.pid}.tgz`);

  const res = await fetch(tarballUrl);
  if (!res.ok) {
    console.error(`[prepare-universal]   fetch ${tarballUrl} → ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpTarball));

  mkdirSync(targetDir, { recursive: true });
  execFileSync('tar', ['-xzf', tmpTarball, '-C', targetDir, '--strip-components=1'], {
    stdio: 'inherit',
  });
  rmSync(tmpTarball, { force: true });

  console.log(`[prepare-universal]   extracted ${pkgName}@${version} → ${targetDir}`);
}

console.log('[prepare-universal] both darwin arches present; universal merge unblocked.');
