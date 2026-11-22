import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { satisfies } from 'semver';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import {
  homeEnv,
  PLATFORM_SKIP_REASON,
  PLATFORM_SUPPORTED,
  SMOKE_ENABLED,
  userDataDirFor,
} from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

test.describe('desktop Electron runtime', () => {
  test.describe.configure({ retries: 0 });
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('runs Electron 45 with the current runtime updates', async ({ captureStderrFor }) => {
    const home = mkdtempSync(join(tmpdir(), 'ok-electron-runtime-'));
    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${userDataDirFor(home)}`],
        env: {
          ...homeEnv(home),
          NODE_OPTIONS: '',
          NODE_PATH: '',
          ELECTRON_RUN_AS_NODE: '',
        },
      }),
    );
    captureStderrFor(app, { home, cleanupDirs: [home] });
    const runtime = await app.evaluate(async ({ app: electronApp }) => {
      await electronApp.whenReady();
      return {
        electron: String(process.versions.electron),
        node: process.versions.node,
        chromium: String(process.versions.chrome),
      };
    });
    console.log('Desktop runtime:', runtime);
    expect(satisfies(runtime.electron, '^45.4.1'), `running Electron ${runtime.electron}`).toBe(
      true,
    );
  });
});
