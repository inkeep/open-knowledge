import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_NATIVE: string = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  .scripts['build:native'];
const LOADER = ['index.d.ts', 'index.js', 'package.json'];

const scratches: string[] = [];

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runBuildNative(binaries: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'ok-cli-build-native-'));
  scratches.push(root);
  const nativeConfig = join(root, 'native-config');
  const cli = join(root, 'cli');
  mkdirSync(nativeConfig);
  mkdirSync(cli);
  for (const file of [...LOADER, ...binaries]) writeFileSync(join(nativeConfig, file), file);
  const result = spawnSync('sh', ['-c', BUILD_NATIVE], { cwd: cli, encoding: 'utf8' });
  const dist = join(cli, 'dist', 'native');
  return { status: result.status, copied: existsSync(dist) ? readdirSync(dist).sort() : [] };
}

describe.skipIf(process.platform === 'win32')(
  'build:native, which pnpm runs through sh on POSIX hosts',
  () => {
    test('fails when native-config holds no binary, instead of shipping a CLI without its addon', () => {
      expect(runBuildNative([]).status).not.toBe(0);
    });

    test('copies the loader and every binary native-config holds', () => {
      const binaries = ['native-config.darwin-arm64.node', 'native-config.win32-x64-msvc.node'];
      expect(runBuildNative(binaries)).toEqual({
        status: 0,
        copied: [...LOADER, ...binaries].sort(),
      });
    });
  },
);
