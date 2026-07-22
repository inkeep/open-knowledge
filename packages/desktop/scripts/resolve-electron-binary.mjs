#!/usr/bin/env node
import { join } from 'node:path';

/**
 * Locate the packed Electron binary inside an electron-builder output dir,
 * per platform. Shared by `afterPack.mjs` (fuse flip) and `afterSign.mjs`
 * (fuse verify) so the two hooks can never disagree about which binary the
 * fuses live in.
 *
 * - darwin: `<out>/<Product>.app/Contents/MacOS/<Product>`
 * - win32:  `<out>/<Product>.exe`
 * - linux:  `<out>/<executableName>` (electron-builder lowercases the
 *   sanitized product name unless `linux.executableName` overrides; the
 *   LinuxPackager exposes the resolved value as `packager.executableName`).
 */
export function resolveElectronBinary(electronPlatformName, appOutDir, packager) {
  const appName = packager.appInfo.productFilename;
  switch (electronPlatformName) {
    case 'darwin':
    case 'mas':
      return join(appOutDir, `${appName}.app`, 'Contents', 'MacOS', appName);
    case 'win32':
      return join(appOutDir, `${appName}.exe`);
    case 'linux': {
      const executableName =
        typeof packager.executableName === 'string' && packager.executableName.length > 0
          ? packager.executableName
          : appName;
      return join(appOutDir, executableName);
    }
    default:
      throw new Error(
        `[resolve-electron-binary] unsupported electronPlatformName "${electronPlatformName}"`,
      );
  }
}
