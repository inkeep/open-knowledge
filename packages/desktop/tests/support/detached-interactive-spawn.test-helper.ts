import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';

type DetachedSpawnSyncOptions = SpawnSyncOptionsWithStringEncoding & {
  detached: true;
  timeout: number;
};

export const INTERACTIVE_SHELL_SPAWN_OPTIONS: DetachedSpawnSyncOptions = {
  detached: true,
  encoding: 'utf8',
  timeout: 20_000,
  killSignal: 'SIGKILL',
};

type DetachedSpawnOptions = SpawnOptions & { detached: true };

export const DETACHED_SPAWN_OPTIONS: DetachedSpawnOptions = { detached: true };

export function spawnDetachedInteractiveChild(
  file: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): ChildProcess {
  return spawn(file, [...args], {
    ...DETACHED_SPAWN_OPTIONS,
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
    env,
  });
}

export function spawnInteractiveShellSync(
  file: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = INTERACTIVE_SHELL_SPAWN_OPTIONS.timeout,
): SpawnSyncReturns<string> {
  return spawnSync(file, [...args], {
    ...INTERACTIVE_SHELL_SPAWN_OPTIONS,
    env,
    timeout: timeoutMs,
  });
}
