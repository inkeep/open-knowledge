#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LINUX_GNU_TARGETS = {
  arm64: 'aarch64-unknown-linux-gnu',
  x64: 'x86_64-unknown-linux-gnu',
};

export function resolveBuildArgs({ platform, arch, release }) {
  const args = ['build', '--platform'];
  if (release) args.push('--release');

  if (platform !== 'linux') return args;

  const target = LINUX_GNU_TARGETS[arch];
  if (target == null) throw new Error(`Unsupported Linux architecture: ${arch}`);

  // Linux package builds run on newer CI hosts than the distributions we
  // support. napi-rs's pinned cross toolchain keeps the addon's glibc floor
  // independent of the host runner.
  args.push('--target', target, '--use-napi-cross');
  return args;
}

function run() {
  const require = createRequire(import.meta.url);
  const cliPath = join(dirname(require.resolve('@napi-rs/cli/package.json')), 'dist', 'cli.js');
  const args = resolveBuildArgs({
    platform: process.platform,
    arch: process.arch,
    release: process.argv.includes('--release'),
  });
  const result = spawnSync(process.execPath, [cliPath, ...args], { stdio: 'inherit' });

  if (result.error != null) throw result.error;
  if (result.signal != null) throw new Error(`napi build terminated by ${result.signal}`);
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) run();
