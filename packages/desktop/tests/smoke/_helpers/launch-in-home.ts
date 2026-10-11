import { type ElectronApplication, _electron as electron } from '@playwright/test';
import { launchDesktopApp } from './launch-readiness';
import { homeEnv } from './platform-gate';

type ElectronLaunchOptions = NonNullable<Parameters<typeof electron.launch>[0]>;

export function launchDesktopInHome(
  home: string,
  launchOptions: ElectronLaunchOptions,
): Promise<ElectronApplication> {
  return launchDesktopApp(
    electron,
    { ...launchOptions, env: Object.assign({}, process.env, launchOptions.env, homeEnv(home)) },
    { home },
  );
}
