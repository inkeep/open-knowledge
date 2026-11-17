import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { satisfies } from 'semver';
import { describe, expect, test } from 'vitest';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'));
const { getConfig } = builderRequire('app-builder-lib/out/util/config/config');
const { getElectronVersion } = builderRequire('app-builder-lib/out/electron/electronVersion');

describe('desktop Electron runtime', () => {
  test('selects Electron 44 with the current runtime updates', async () => {
    const config = await getConfig(desktopRoot, resolve(desktopRoot, 'electron-builder.yml'), null);
    const version = await getElectronVersion(desktopRoot, config);

    expect(satisfies(version, '^44.11.2'), `selected Electron ${version}`).toBe(true);
  });
});
