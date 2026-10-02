#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativesError, prepareKeyringNatives } from './prepare-platform-natives.mjs';

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
      `Run \`pnpm install\` first.`,
  );
  process.exit(1);
}
const version = JSON.parse(readFileSync(hostPkgJson, 'utf8')).version;

try {
  await prepareKeyringNatives({
    repoRoot: REPO_ROOT,
    version,
    suffixes: ARCHES,
    registry: 'https://registry.npmjs.org/',
  });
  console.log('[prepare-universal] both darwin arches present; universal merge unblocked.');
} catch (error) {
  console.error(
    `[prepare-universal] ${error instanceof NativesError ? error.message : error.stack}`,
  );
  process.exitCode = 1;
}
