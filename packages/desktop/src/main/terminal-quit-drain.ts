export interface QuitEventLike {
  preventDefault(): void;
}

export interface TerminalQuitDrainDeps {
  defer(callback: () => void): void;
  drain(): Promise<void>;
  resumeQuit(): void;
}

/**
 * Holds the first will-quit event open until terminal hosts settle. Resuming on
 * a later event-loop turn is load-bearing: an already-resolved drain otherwise
 * re-enters app.quit() from a Promise microtask before Electron has unwound the
 * prevented native event, and that re-entry is ignored.
 */
export function createTerminalQuitDrain(deps: TerminalQuitDrainDeps) {
  let drainStarted = false;
  let drainComplete = false;

  return (event: QuitEventLike): boolean => {
    if (drainComplete) return false;

    event.preventDefault();
    if (drainStarted) return true;
    drainStarted = true;

    const scheduleQuitResume = () => {
      deps.defer(() => {
        drainComplete = true;
        deps.resumeQuit();
      });
    };

    void deps.drain().then(scheduleQuitResume, scheduleQuitResume);
    return true;
  };
}
