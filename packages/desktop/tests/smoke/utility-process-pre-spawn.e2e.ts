import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElectronApplication, _electron as electron } from '@playwright/test';
import { UTILITY_INIT_TIMEOUT_MS } from '../../src/shared/boot-narration.ts';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { homeEnv, SMOKE_ENABLED, userDataDirFor } from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();
const DARWIN = process.platform === 'darwin';

const ECHO_UTILITY_SOURCE =
  "process.parentPort.on('message', (event) => process.parentPort.postMessage(event.data));\n";

const POSTED_BEFORE_SPAWN = 'posted before the utility spawned';

function launchIsolated(tmpHome: string): Promise<ElectronApplication> {
  return electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${userDataDirFor(tmpHome)}`],
      env: homeEnv(tmpHome),
    }),
  );
}

test.describe('Electron utilityProcess keeps the pre-spawn behaviour the forked project server wait relies on', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Verified in the macOS desktop-smoke job.');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('a utility is not killed before it spawns, receives a message posted before it spawned, and is killed once it has spawned', async ({
    captureStderrFor,
  }) => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-utility-pre-spawn-'));
    const echoUtilityEntry = join(tmpHome, 'echo-utility.mjs');
    writeFileSync(echoUtilityEntry, ECHO_UTILITY_SOURCE);
    const app = await launchIsolated(tmpHome);
    captureStderrFor(app, { cleanupDirs: [tmpHome] });

    const observed = await app.evaluate(
      async ({ app: electronApp, utilityProcess }, { entry, message, boundMs }) => {
        await electronApp.whenReady();
        const child = utilityProcess.fork(entry, [], {
          serviceName: 'OpenKnowledge pre-spawn probe',
        });
        const spawned = new Promise<number | undefined>((resolve) => {
          child.once('spawn', () => resolve(child.pid));
        });
        const echoed = new Promise<unknown>((resolve) => {
          child.once('message', resolve);
        });
        const exited = new Promise<number | undefined>((resolve) => {
          child.once('exit', () => resolve(child.pid));
        });
        const killedBeforeSpawn = child.kill();
        const pidBeforeSpawn = child.pid;
        child.postMessage(message);
        let bound: ReturnType<typeof setTimeout> | undefined;
        const afterSpawn = await Promise.race([
          (async () => {
            const pidAtSpawn = await spawned;
            const echo = await echoed;
            const killedAfterSpawn = child.kill();
            const pidInExitListener = await exited;
            return {
              settled: true,
              pidAtSpawn,
              echo,
              killedAfterSpawn,
              pidInExitListener,
              pidAfterExit: child.pid,
            };
          })(),
          new Promise<{ settled: false }>((resolve) => {
            bound = setTimeout(() => resolve({ settled: false }), boundMs);
          }),
        ]);
        clearTimeout(bound);
        if (!afterSpawn.settled) child.kill();
        return { killedBeforeSpawn, pidBeforeSpawn, ...afterSpawn };
      },
      { entry: echoUtilityEntry, message: POSTED_BEFORE_SPAWN, boundMs: UTILITY_INIT_TIMEOUT_MS },
    );

    expect(observed).toEqual({
      killedBeforeSpawn: false,
      pidBeforeSpawn: undefined,
      settled: true,
      pidAtSpawn: expect.any(Number),
      echo: POSTED_BEFORE_SPAWN,
      killedAfterSpawn: true,
      pidInExitListener: undefined,
      pidAfterExit: undefined,
    });
  });
});
