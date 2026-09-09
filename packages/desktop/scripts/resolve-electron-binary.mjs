#!/usr/bin/env node
import { join } from 'node:path';

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
