import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_SERVER_HOST_FAMILY } from '../../../../src/build/test-server-startup-contract.ts';
import {
  seedRequiredFixtureFiles,
  spawnWorkerDevServer,
  WORKER_SERVER_BUDGET_RESERVES,
  waitForServerReady,
} from '../fixtures.ts';
import type { ModuleServing } from '../prebuilt/prebuilt-serving.ts';
import {
  beginViteStartup,
  closeServerLog,
  createViteStartupRequest,
  openServerLog,
  prepareViteCacheDir,
  type ServerLog,
  tailServerLog,
} from '../server-process.ts';
import { removeAllDuringTeardown, runTeardownPhases } from '../teardown-fs.ts';
import {
  completeWorkerServerRelease,
  stopWorkerServer,
  type WorkerServerProcess,
} from '../worker-server-lifetime.ts';
import type { WorkerServerEnv } from './lease-protocol.ts';
import type { LaunchOwnedServer, OwnedServer } from './server-supervisor.ts';

export async function launchOwnedWorkerServer({
  label,
  workerServerEnv,
  serving,
}: {
  readonly label: string;
  readonly workerServerEnv: WorkerServerEnv;
  readonly serving: ModuleServing;
}): Promise<OwnedServer> {
  const teardown: Array<() => void | Promise<void>> = [];
  let ownedProc: WorkerServerProcess | undefined;
  const releaseAll = () =>
    runTeardownPhases(
      () => runTeardownPhases(...[...teardown].reverse()),
      () => (ownedProc === undefined ? undefined : completeWorkerServerRelease(ownedProc)),
    );
  const request = createViteStartupRequest('127.0.0.1');
  teardown.push(() => request.dispose());
  let openedServerLog: ServerLog | undefined;
  try {
    const serverLog = openServerLog(label);
    openedServerLog = serverLog;
    teardown.push(() => removeAllDuringTeardown(serverLog.path));
    teardown.push(() => closeServerLog(serverLog));
    const contentDir = mkdtempSync(join(tmpdir(), `ok-${label}-`));
    teardown.push(() => removeAllDuringTeardown(contentDir));
    const viteCacheDir = prepareViteCacheDir(label);
    teardown.push(() => removeAllDuringTeardown(viteCacheDir));
    seedRequiredFixtureFiles(contentDir);
    const proc = spawnWorkerDevServer(
      request,
      workerServerEnv,
      contentDir,
      viteCacheDir,
      serverLog,
      serving,
    );
    ownedProc = proc;
    const lifetimeLost = new Promise<never>((_, reject) => {
      proc.on('error', reject);
    });
    teardown.push(() => stopWorkerServer(proc, WORKER_SERVER_BUDGET_RESERVES.devServerReap));
    const endpoint = await Promise.race([
      waitForServerReady({
        pending: beginViteStartup(request, proc),
        contentDir,
        viteCacheDir,
        serverLog,
        proc,
        serving,
      }),
      lifetimeLost,
    ]);
    let released: Promise<void> | undefined;
    return {
      proc,
      identity: {
        nonce: request.nonce,
        address: request.host,
        family: TEST_SERVER_HOST_FAMILY[request.host],
        port: endpoint.port,
      },
      baseURL: endpoint.baseURL,
      contentDir,
      release: () => {
        released ??= releaseAll();
        return released;
      },
    };
  } catch (error) {
    const tail =
      openedServerLog === undefined
        ? '--- no dev server log was open when this failure ended the launch ---'
        : `--- dev server log tail ---\n${tailServerLog(openedServerLog)}`;
    let cleanupFailure: string | undefined;
    try {
      await releaseAll();
    } catch (cleanupError) {
      cleanupFailure = `--- cleanup after this failure did not complete: ${describe(cleanupError)} ---`;
    }
    throw new Error(
      [describe(error), tail, cleanupFailure].filter((part) => part !== undefined).join('\n'),
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const launchOwnedDevServer: LaunchOwnedServer = (slot, workerServerEnv) =>
  launchOwnedWorkerServer({
    label: `reuse-s${slot}`,
    workerServerEnv,
    serving: { kind: 'dev-server' },
  });
