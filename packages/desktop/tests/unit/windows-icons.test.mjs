import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LinuxPackager, Packager, WinPackager } from 'electron-builder';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parse, stringify } from 'yaml';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let fixture;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'ok-windows-icons-'));
  vi.stubEnv('ELECTRON_BUILDER_ICONS_TOOLSET_DIR', join(fixture, 'unavailable-toolset'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(fixture, { recursive: true, force: true });
});

function baseConfig() {
  return parse(readFileSync(join(desktopRoot, 'electron-builder.yml'), 'utf8'));
}

function releaseConfig(variant) {
  for (const file of [
    'package.json',
    'electron-builder.yml',
    'build/installer.nsh',
    'build/deb-postinst.sh',
    'build/deb-postrm.sh',
    'build/entitlements.mac.plist',
    'build/helper-bundle/Info.plist',
  ]) {
    const target = join(fixture, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(desktopRoot, file), target);
  }
  const preload = join(fixture, 'packaging-boundary.mjs');
  writeFileSync(
    preload,
    `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
childProcess.spawnSync = () => ({ status: 0 });
syncBuiltinESMExports();
`,
  );
  const result = spawnSync(
    process.execPath,
    ['--import', preload, join(desktopRoot, 'scripts/run-electron-builder.mjs'), '--win'],
    {
      cwd: fixture,
      encoding: 'utf8',
      env: { ...process.env, OK_DESKTOP_VARIANT: variant, CSC_LINK: '', CSC_KEYCHAIN: '' },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return parse(readFileSync(join(fixture, '.variant-build/electron-builder.yml'), 'utf8'));
}

async function resolveIcon(config, platform, format) {
  const configPath = join(fixture, 'icon-config.yml');
  writeFileSync(
    configPath,
    stringify({ ...config, directories: { ...config.directories, output: fixture } }),
  );
  const packager = new Packager({ projectDir: desktopRoot, config: configPath });
  await packager.validateConfig();
  const target = platform === 'win' ? new WinPackager(packager) : new LinuxPackager(packager);
  return target.resolveIcon([target.platformSpecificBuildOptions.icon], [], format);
}

describe('Windows build icons', () => {
  test.each([
    ['direct Windows', null, 'icon'],
    ['stable Windows release', 'stable', 'icon'],
    ['beta Windows release', 'beta', 'icon-beta'],
    ['legacy-beta Windows release', 'legacy-beta', 'icon'],
  ])('resolves the %s icon without a conversion tool', async (_label, variant, asset) => {
    const config = variant === null ? baseConfig() : releaseConfig(variant);
    await expect(resolveIcon(config, 'win', 'ico')).resolves.toEqual([
      { file: join(desktopRoot, `build/${asset}.ico`), size: 256 },
    ]);
  });

  test('preserves the Linux PNG without a conversion tool', async () => {
    await expect(resolveIcon(baseConfig(), 'linux', 'set')).resolves.toEqual([
      { file: join(desktopRoot, 'build/icon.png'), size: 1024 },
    ]);
  });
});
