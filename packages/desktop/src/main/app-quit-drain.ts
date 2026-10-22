export interface AppQuitDrainDeps {
  stopTerminals(): Promise<void>;
  reapSlideDecks(): Promise<void>;
  drainProjectServers(): Promise<void>;
  onTerminalStopFailed(reason: unknown): void;
}

export async function drainAppOwnedWork(deps: AppQuitDrainDeps): Promise<void> {
  const [terminalResult] = await Promise.allSettled([
    deps.stopTerminals(),
    deps.reapSlideDecks(),
    deps.drainProjectServers(),
  ]);
  if (terminalResult.status === 'rejected') deps.onTerminalStopFailed(terminalResult.reason);
}
