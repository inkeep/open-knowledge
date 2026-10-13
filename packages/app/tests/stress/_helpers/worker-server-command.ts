import { type ChildProcess, spawn } from 'node:child_process';
import type { PrebuiltServerCommand, WorkerServing } from './prebuilt/prebuilt-serving.ts';
import { APP_PACKAGE_ROOT, type ServerLog, type ViteStartupRequest } from './server-process.ts';

export interface WorkerServerLaunch {
  readonly request: Omit<ViteStartupRequest, 'dispose'>;
  readonly workerServerEnv: Readonly<Record<string, string>>;
  readonly contentDir: string;
  readonly viteCacheDir: string;
  readonly serverLog: ServerLog;
  readonly serving: WorkerServing;
  readonly command: PrebuiltServerCommand | null;
  readonly reapMs: number;
}

export function spawnWorkerServerCommand({
  request,
  workerServerEnv,
  contentDir,
  viteCacheDir,
  serverLog,
  serving,
  command,
}: WorkerServerLaunch): ChildProcess {
  if (serving.kind === 'prebuilt') {
    if (command === null) throw new Error('prebuilt worker server has no admitted command');
    return spawn('pnpm', [...command.args], {
      cwd: APP_PACKAGE_ROOT,
      detached: true,
      env: {
        ...process.env,
        ...workerServerEnv,
        ...request.environment,
        ...command.env,
        OK_TEST_CONTENT_DIR: contentDir,
        OK_TEST_VITE_CACHE_DIR: viteCacheDir,
        OK_TEST_SKIP_I18N_COMPILE: '1',
        OK_TEST_GIT_ENABLED: '1',
        NO_COLOR: process.env.NO_COLOR ?? '1',
      },
      stdio: ['ignore', serverLog.fd, 'inherit'],
    });
  }
  const proc = spawn('pnpm', ['run', 'dev', '--host', request.host], {
    cwd: APP_PACKAGE_ROOT,
    detached: true,
    env: {
      ...process.env,
      ...workerServerEnv,
      ...request.environment,
      OK_TEST_CONTENT_DIR: contentDir,
      OK_TEST_VITE_CACHE_DIR: viteCacheDir,
      OK_TEST_SKIP_I18N_COMPILE: '1',
      OK_TEST_GIT_ENABLED: '1',
      NO_COLOR: process.env.NO_COLOR ?? '1',
    },
    stdio: ['ignore', serverLog.fd, 'inherit'],
  });
  return proc;
}
