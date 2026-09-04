import type { ServerExitInfo } from './server-exit-record.ts';

interface ServerExitObserverLogger {
  info(payload: Record<string, unknown>, msg: string): void;
}

export interface ServerExitObserverDeps {
  lockDir: string;
  readPid(): number | undefined;
  recordExit(info: ServerExitInfo): void;
  logger: ServerExitObserverLogger;
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

export interface ObservableChild {
  readonly pid?: number | undefined;
  on(event: 'exit', listener: ExitListener): unknown;
}

export function createServerExitObserver(deps: ServerExitObserverDeps): ExitListener {
  return (code, signal) => {
    let pid: number | null = null;
    try {
      pid = deps.readPid() ?? null;
    } catch {}

    try {
      deps.recordExit({
        lockDir: deps.lockDir,
        pid,
        code,
        signal,
        observer: 'detached-spawn',
      });
    } catch {}

    try {
      deps.logger.info(
        { event: 'server-exit.detached-child-exited', lockDir: deps.lockDir, pid, code, signal },
        'detached project server exited',
      );
    } catch {}
  };
}

export function attachServerExitObserver(
  child: ObservableChild,
  deps: Omit<ServerExitObserverDeps, 'readPid'>,
): void {
  child.on('exit', createServerExitObserver({ ...deps, readPid: () => child.pid }));
}
