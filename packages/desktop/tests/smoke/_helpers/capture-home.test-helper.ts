import { realpathSync } from 'node:fs';
import { type ElectronApplication, expect, test } from '@playwright/test';
import { readBootLog, tryLaunchHomeFor } from './launch-readiness';

export async function expectCaptureHomeMatchesProcess(app: ElectronApplication): Promise<void> {
  await test.step('capture home matches the Electron process home', async () => {
    const observed = await app.evaluate(() => ({
      home: process.getBuiltinModule('node:os').homedir(),
      pid: process.pid,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
    }));
    const registeredHome = tryLaunchHomeFor(app);
    const actualLog = readBootLog(observed.home);
    const registeredLog = registeredHome === undefined ? undefined : readBootLog(registeredHome);
    await test.info().attach('capture-home-observation', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          observed,
          registeredHome,
          actualLog: {
            dir: actualLog.dir,
            fileCount: actualLog.fileCount,
            lineCount: actualLog.lineCount,
            unreadableFiles: actualLog.unreadableFiles,
            tail: actualLog.tail,
          },
          registeredLog:
            registeredLog === undefined
              ? null
              : {
                  dir: registeredLog.dir,
                  fileCount: registeredLog.fileCount,
                  lineCount: registeredLog.lineCount,
                  unreadableFiles: registeredLog.unreadableFiles,
                  tail: registeredLog.tail,
                },
        },
        null,
        2,
      ),
    });
    expect(
      registeredHome === undefined ? undefined : realpathSync(registeredHome),
      'diagnostic capture must read the home used by this Electron process',
    ).toBe(realpathSync(observed.home));
  });
}
