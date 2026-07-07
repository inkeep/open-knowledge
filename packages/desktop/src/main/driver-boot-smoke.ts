/**
 * Main-side driver-boot-smoke bridge.
 *
 * The `scripts/verify-keyring-in-packaged-dmg.mjs` driver invokes the
 * packaged app with `OK_DEBUG_KEYRING_SMOKE=1 + OK_DEBUG_KEYRING_SMOKE_EXIT=1 +
 * OK_DEBUG_KEYRING_SMOKE_OUT=<path>`. In normal boot, main only forks a
 * utility when `createProjectWindow` runs — which requires user interaction
 * via the Navigator. The driver runs unattended, so main must recognize the
 * EXIT variant and fork a standalone utility directly at `app.whenReady()`
 * before any window is shown. The utility runs `runBootAutoSmoke()` (see
 * `src/utility/server-entry.ts`) and self-exits 0; main quits once it sees
 * the exit. Without this bridge, Navigator opens and the driver times out.
 *
 * Extracted from `index.ts` so the fork / exit / safety-timer wiring is
 * unit-testable without loading the Electron runtime (which refuses to
 * import outside an Electron process under Bun's test ABI).
 */

/** Subset of `Electron.UtilityProcess` that `runDriverBootSmoke` relies on. */
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
  // Safety net: if the utility hangs for any reason (ABI mismatch with no
  // exit, blocked on a macOS prompt, etc.), quit anyway inside the driver's
  // 30 s DEFAULT_TIMEOUT_MS (scripts/verify-keyring-in-packaged-dmg.mjs) so
  // main's own quit fires and the driver sees `exitCode !== null` rather
  // than its SIGTERM escalation path.
  deps.setTimeout(doQuit, deps.safetyTimeoutMs ?? 25_000);
}

/** Runtime gate — both env vars must be set for the driver to take over boot. */
export function isDriverBootSmokeMode(env: NodeJS.ProcessEnv): boolean {
  return env.OK_DEBUG_KEYRING_SMOKE === '1' && env.OK_DEBUG_KEYRING_SMOKE_EXIT === '1';
}
