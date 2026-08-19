import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveBuildArgs } from './build.mjs';

// This package has no Vitest dependency, so the plain-JS harness uses Node's built-in runner.
describe('resolveBuildArgs', () => {
  test('uses the napi cross toolchain for Linux x64 release builds', () => {
    assert.deepEqual(resolveBuildArgs({ platform: 'linux', arch: 'x64', release: true }), [
      'build',
      '--platform',
      '--release',
      '--target',
      'x86_64-unknown-linux-gnu',
      '--use-napi-cross',
    ]);
  });

  test('uses the napi cross toolchain for Linux arm64 debug builds', () => {
    assert.deepEqual(resolveBuildArgs({ platform: 'linux', arch: 'arm64', release: false }), [
      'build',
      '--platform',
      '--target',
      'aarch64-unknown-linux-gnu',
      '--use-napi-cross',
    ]);
  });

  test('keeps the existing native build on macOS and Windows', () => {
    assert.deepEqual(resolveBuildArgs({ platform: 'darwin', arch: 'arm64', release: true }), [
      'build',
      '--platform',
      '--release',
    ]);
    assert.deepEqual(resolveBuildArgs({ platform: 'win32', arch: 'x64', release: false }), [
      'build',
      '--platform',
    ]);
  });

  test('fails explicitly for an unsupported Linux architecture', () => {
    assert.throws(
      () => resolveBuildArgs({ platform: 'linux', arch: 'riscv64', release: true }),
      /Unsupported Linux architecture: riscv64/,
    );
  });
});
