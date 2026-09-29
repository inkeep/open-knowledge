import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import afterPack, { assertAdHocSealCoversBundle } from '../../scripts/afterPack.mjs';
import { removeTempDirBestEffort } from '../support/temp-dir-cleanup.test-helper.ts';

vi.mock('@electron/fuses', async (importOriginal) => ({
  ...(await importOriginal()),
  flipFuses: async (electronBinary) => {
    resealAdHoc(`${electronBinary.split('.app')[0]}.app`);
    return 1;
  },
}));

function electronBuilderOsxSign() {
  const requireFromDesktop = createRequire(new URL('../../package.json', import.meta.url));
  const electronBuilder = dirname(requireFromDesktop.resolve('electron-builder/package.json'));
  const appBuilderLib = dirname(
    requireFromDesktop.resolve('app-builder-lib/package.json', { paths: [electronBuilder] }),
  );
  return createRequire(join(appBuilderLib, 'package.json'))('@electron/osx-sign');
}

function codesign(args) {
  execFileSync('/usr/bin/codesign', args, { stdio: 'pipe' });
}

function resealAdHoc(app) {
  codesign([
    '--sign',
    '-',
    '--force',
    '--preserve-metadata=entitlements,requirements,flags,runtime',
    '--deep',
    app,
  ]);
}

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTempDirBestEffort(root);
});

function infoPlist(executable, identifier) {
  return `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>${executable}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`;
}

function adHocMachO(destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync('/usr/bin/true', destination);
  codesign(['--sign', '-', '--force', destination]);
}

function executableBundle(bundle, executable, identifier) {
  adHocMachO(join(bundle, 'Contents/MacOS', executable));
  writeFileSync(join(bundle, 'Contents/Info.plist'), infoPlist(executable, identifier));
}

function packedApp() {
  const appOutDir = mkdtempSync(join(tmpdir(), 'ok-after-pack-'));
  roots.push(appOutDir);
  const app = join(appOutDir, 'Fixture.app');
  const frameworks = join(app, 'Contents/Frameworks');
  executableBundle(app, 'Fixture', 'ai.openknowledge.after-pack-test');
  executableBundle(
    join(frameworks, 'Fixture Helper.app'),
    'Fixture Helper',
    'ai.openknowledge.after-pack-test.helper',
  );
  const serverContents = join(frameworks, 'Fixture Server.app/Contents');
  mkdirSync(serverContents, { recursive: true });
  writeFileSync(
    join(serverContents, 'Info.plist'),
    infoPlist('Fixture Helper', 'ai.openknowledge.after-pack-test.server'),
  );
  const spawnHelper = join(
    app,
    'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  );
  adHocMachO(spawnHelper);
  chmodSync(spawnHelper, 0o644);
  return { appOutDir, app, serverContents };
}

describe.skipIf(process.platform !== 'darwin')('afterPack hands the signer a sealed bundle', () => {
  test("electron-builder's signer signs the packed app in a single pass", async () => {
    const { appOutDir, app } = packedApp();
    await afterPack({
      appOutDir,
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: 'Fixture' } },
    });
    await expect(
      electronBuilderOsxSign().signAsync({
        app,
        identity: '-',
        identityValidation: false,
        platform: 'darwin',
        type: 'distribution',
        version: '43.4.0',
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        optionsForFile: () => ({ hardenedRuntime: true, timestamp: 'none' }),
      }),
    ).resolves.toBeUndefined();
    codesign(['--verify', '--deep', '--strict', app]);
  });

  test('a nested bundle filled in after the ad-hoc seal fails the pre-sign check', () => {
    const { app, serverContents } = packedApp();
    resealAdHoc(app);
    adHocMachO(join(serverContents, 'MacOS/Fixture Helper'));
    expect(() => assertAdHocSealCoversBundle(app)).toThrow(/rejected[\s\S]*Fixture Server\.app/);
  });
});
