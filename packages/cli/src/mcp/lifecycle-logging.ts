
export interface LifecycleLoggingTransport {
  onclose?: (() => void) | undefined;
}

export interface LifecycleLoggingProcess {
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'uncaughtExceptionMonitor', listener: (err: unknown, origin: string) => void): unknown;
}

export interface LifecycleLoggingStdin {
  once(event: 'end' | 'close', listener: () => void): unknown;
}

interface LifecycleLoggingDeps {
  log: (msg: string) => void;
  transport: LifecycleLoggingTransport;
  process: LifecycleLoggingProcess;
  stdin: LifecycleLoggingStdin;
}

export function attachLifecycleLogging(deps: LifecycleLoggingDeps): void {
  const safeLog = (msg: string): void => {
    try {
      deps.log(msg);
    } catch {
    }
  };

  const prevOnClose = deps.transport.onclose;
  deps.transport.onclose = () => {
    safeLog('[mcp] stdio transport closed (internal shutdown)');
    prevOnClose?.();
  };

  deps.stdin.once('end', () => safeLog('[mcp] stdin EOF (host closed pipe)'));
  deps.stdin.once('close', () => safeLog('[mcp] stdin closed'));

  deps.process.on('exit', (code: number) => {
    safeLog(`[mcp] exit code=${code}`);
  });

  deps.process.on('uncaughtExceptionMonitor', (err: unknown, origin: string) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    safeLog(`[mcp] uncaughtException origin=${origin}: ${detail}`);
  });
}
