import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  assertPackagedBundle,
  findForbiddenBundlePaths,
  findMissingBundlePaths,
} from '../../scripts/assert-packaged-bundle.mjs';
import { writeHeaderOnlyAsar } from '../support/synthetic-asar.test-helper.ts';
import { removeTempDirBestEffort } from '../support/temp-dir-cleanup.test-helper.ts';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTempDirBestEffort(dir);
});

function writeTree(root, files) {
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), 'x');
  }
}

function packResources({ asarFiles, diskFiles }) {
  const dir = mkdtempSync(join(tmpdir(), 'ok-packaged-bundle-'));
  tempDirs.push(dir);
  const resources = join(dir, 'Resources');
  mkdirSync(resources, { recursive: true });
  if (asarFiles) writeHeaderOnlyAsar(join(resources, 'app.asar'), asarFiles);
  writeTree(resources, diskFiles);
  return resources;
}

const LIBRARY_NATIVE = 'app.asar.unpacked/node_modules/@inkeep/open-knowledge/dist/native';
const SOUND_ASAR = [
  'package.json',
  'out/main/index.js',
  'node_modules/@inkeep/open-knowledge-server/dist/index.mjs',
  'node_modules/@inkeep/open-knowledge-core/dist/index.mjs',
];
const SOUND_DISK = [
  'app/index.html',
  'cli/dist/cli.mjs',
  'cli/dist/native/index.js',
  'cli/dist/native/native-config.linux-x64-gnu.node',
  'cli/node_modules/@inkeep/open-knowledge-native-config/index.js',
  'app.asar.unpacked/node_modules/@inkeep/open-knowledge/dist/index.mjs',
  `${LIBRARY_NATIVE}/index.js`,
  `${LIBRARY_NATIVE}/native-config.darwin-arm64.node`,
  'app.asar.unpacked/node_modules/@napi-rs/keyring/index.js',
];
const SOUND_PATHS = [...SOUND_DISK, ...SOUND_ASAR.map((p) => `app.asar/${p}`)];

describe('findForbiddenBundlePaths', () => {
  test('passes a sound bundle', () => {
    expect(findForbiddenBundlePaths(SOUND_PATHS)).toEqual([]);
  });

  test.each([
    ['cli/node_modules/@inkeep/open-knowledge-native-config/target/release/CACHEDIR.TAG', 'cargo'],
    ['app.asar/src/main/index.ts', 'outside out/'],
    ['app.asar/tests/e2e/app.e2e.ts', 'outside out/'],
    ['app.asar/electron-builder.linux.yml', 'outside out/'],
    ['app.asar/out/renderer/index.html', 'renderer'],
    ['cli/dist/public/index.html', 'web app'],
    ['app.asar.unpacked/node_modules/@inkeep/open-knowledge/dist/public/index.html', 'web app'],
    [
      'app.asar.unpacked/node_modules/@inkeep/open-knowledge-native-config/index.js',
      'native-config',
    ],
    ['app.asar/node_modules/@inkeep/open-knowledge-core/src/index.ts', 'sources'],
  ])('flags %s', (path, reasonFragment) => {
    const hits = findForbiddenBundlePaths([...SOUND_PATHS, path]);
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toContain(reasonFragment);
    expect(hits[0].example).toBe(path);
  });
});

describe('findMissingBundlePaths', () => {
  test('passes a sound bundle', () => {
    expect(findMissingBundlePaths(SOUND_PATHS)).toEqual([]);
  });

  test.each([
    ['app.asar/package.json', 'app.asar'],
    [`${LIBRARY_NATIVE}/index.js`, "main process's native-config loader"],
    [`${LIBRARY_NATIVE}/native-config.darwin-arm64.node`, "main process's native-config addon"],
    ['cli/dist/native/index.js', "bundled CLI's native-config loader"],
    ['cli/dist/native/native-config.linux-x64-gnu.node', "bundled CLI's native-config addon"],
  ])('reports a bundle without %s', (dropped, reasonFragment) => {
    const missing = findMissingBundlePaths(SOUND_PATHS.filter((p) => p !== dropped));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain(reasonFragment);
  });

  test('reports an addon left inside app.asar instead of unpacked', () => {
    const packedAddon = SOUND_PATHS.map((p) =>
      p.endsWith('.darwin-arm64.node') ? p.replace('app.asar.unpacked/', 'app.asar/') : p,
    );
    expect(findMissingBundlePaths(packedAddon)).toEqual([
      "the main process's native-config addon, unpacked",
    ]);
  });
});

describe('assertPackagedBundle', () => {
  test('passes a packed bundle laid out the way its processes load it', () => {
    const resources = packResources({ asarFiles: SOUND_ASAR, diskFiles: SOUND_DISK });
    expect(() => assertPackagedBundle(resources)).not.toThrow();
  });

  test('fails a packed bundle on dead weight inside app.asar and beside it', () => {
    const resources = packResources({
      asarFiles: [...SOUND_ASAR, 'out/renderer/index.html', 'tests/e2e/app.e2e.ts'],
      diskFiles: [...SOUND_DISK, 'cli/dist/public/index.html'],
    });
    expect(() => assertPackagedBundle(resources)).toThrow(
      /Resources\/app\.asar\/tests[\s\S]*out\/renderer\/index\.html[\s\S]*cli\/dist\/public\/index\.html/,
    );
  });

  test('fails a bundle with no app.asar', () => {
    const resources = packResources({ diskFiles: SOUND_DISK });
    expect(() => assertPackagedBundle(resources)).toThrow(/lacks app\.asar with its package\.json/);
  });
});
