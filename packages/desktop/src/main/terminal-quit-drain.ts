export interface QuitEventLike {
  preventDefault(): void;
}

export interface TerminalQuitDrainDeps {
  defer(callback: () => void): void;
  drain(): Promise<void>;
  resumeQuit(): void;
}

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
