export interface DriverUtilityLike {
  on(event: 'exit', listener: () => void): void;
}

interface DriverBootSmokeDeps {
  fork: (entry: string) => DriverUtilityLike;
  quit: () => void;
  setTimeout: (fn: () => void, ms: number) => void;
  utilityEntryPath: string;
  safetyTimeoutMs?: number;
}

export function runDriverBootSmoke(deps: DriverBootSmokeDeps): void {
  const child = deps.fork(deps.utilityEntryPath);
  let quit = false;
  const doQuit = () => {
    if (quit) return;
    quit = true;
    deps.quit();
  };
  child.on('exit', doQuit);
  deps.setTimeout(doQuit, deps.safetyTimeoutMs ?? 25_000);
}

export function isDriverBootSmokeMode(env: NodeJS.ProcessEnv): boolean {
  return env.OK_DEBUG_KEYRING_SMOKE === '1' && env.OK_DEBUG_KEYRING_SMOKE_EXIT === '1';
}
