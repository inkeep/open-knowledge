export const CLEAN_QUIT_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

interface SignalCleanQuitLogger {
  info(payload: Record<string, unknown>, msg: string): void;
}

interface ProcessSignalEmitter {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface InstallSignalCleanQuitOpts {
  process: ProcessSignalEmitter;
  markCleanQuit: () => void;
  quit: () => void;
  logger: SignalCleanQuitLogger;
}

export function installSignalCleanQuit(opts: InstallSignalCleanQuitOpts): void {
  let handled = false;
  const handle = (signal: NodeJS.Signals): void => {
    if (handled) return;
    handled = true;
    opts.logger.info(
      { event: 'desktop.signal-clean-quit', signal },
      'received termination signal — quitting cleanly',
    );
    try {
      opts.markCleanQuit();
    } catch {}
    opts.quit();
  };
  for (const signal of CLEAN_QUIT_SIGNALS) {
    opts.process.on(signal, () => handle(signal));
  }
}
