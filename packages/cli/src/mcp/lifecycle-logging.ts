/**
 * Attach diagnostic breadcrumbs to the MCP stdio process so a future quiet
 * exit can be classified from the host's stderr log.
 *
 * The global stdio server in `server.ts` exits in two observable shapes:
 *
 *   1. Graceful shutdown via `server.ts`'s `shutdown()` — triggered by any
 *      host-gone signal: a clean stdin disconnect (`process.stdin` `'end'`), a
 *      stdin `'error'` (socket-backed stdio that faults), SIGINT / SIGTERM, or
 *      the host-liveness ppid watch (reparented to launchd). `shutdown()` flips
 *      `shuttingDown`, calls `transport.close()` (which fires `onclose`), then
 *      `process.exit(0)` (or `exit(1)` on the 5s deadline).
 *
 *      Note: `server.ts` registers ACTIVE `'end'`/`'error'` handlers plus the
 *      ppid watch, because the per-project keepalive WS keeps the event loop
 *      alive — so the old passive "stdin EOF → loop drains → exit 0" route no
 *      longer fires once a tool call has opened a keepalive. As a result
 *      **`transport.onclose` now fires on EVERY graceful exit, including a
 *      clean stdin disconnect**, so its presence no longer distinguishes a
 *      peer-driven disconnect from a signal. The distinguishing breadcrumb is
 *      the active line that precedes it (`[mcp] stdin end/error …`,
 *      `[mcp] host process exited …`, or the signal). The MCP SDK itself still
 *      never fires `onclose` on stdin EOF — `shutdown()` does. (Pre-tool-call,
 *      with no keepalive open, stdin EOF may still drain the loop to a natural
 *      exit 0; both routes end at 0.)
 *
 *   2. Uncaught exception → Node's default handler logs + exits non-zero;
 *      `uncaughtExceptionMonitor` is observe-only and runs before the
 *      default crash path, so attaching it surfaces the breadcrumb without
 *      changing the crash semantics. `unhandledRejection` is deliberately
 *      skipped: attaching any listener suppresses Node's default
 *      crash-on-rejection behavior, and the host already captures Node's
 *      own stderr output for that case.
 *
 * Every log call routes through a `safeLog` wrapper that swallows
 * `deps.log()` throws. The real call site in `server.ts` binds `log` to
 * `stderr.write` which only throws on a closed/destroyed stderr — but a
 * throwing log must not break `transport.onclose` composition (the prior
 * handler would never run) nor violate the observe-only contract of
 * `uncaughtExceptionMonitor` (a throwing monitor would itself trigger
 * Node's default crash path before the original exception is even handled).
 *
 * Pure modulo the injected `process`, `transport`, and `stdin` surfaces.
 */

export interface LifecycleLoggingTransport {
  /** SDK contract — set by the consumer; we compose with any prior value. */
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
  /** Sink for breadcrumbs. Caller adds a trailing newline if needed. */
  log: (msg: string) => void;
  /** The `StdioServerTransport` instance (or any object with `onclose`). */
  transport: LifecycleLoggingTransport;
  /** Process-like with `on(...)`. Pass `process` in production. */
  process: LifecycleLoggingProcess;
  /** Stdin-like with `once(...)`. Pass `process.stdin` in production. */
  stdin: LifecycleLoggingStdin;
}

export function attachLifecycleLogging(deps: LifecycleLoggingDeps): void {
  const safeLog = (msg: string): void => {
    try {
      deps.log(msg);
    } catch {
      // observe-only: never let a logging failure perturb the host
    }
  };

  // `transport.onclose` is reached only via `server.ts`'s `shutdown()` →
  // `transport.close()` path (the SDK never fires it on stdin EOF itself). But
  // `shutdown()` is now triggered by stdin `'end'`/`'error'` and the ppid watch
  // as well as by signals, so this breadcrumb fires on a clean disconnect too —
  // it names the close mechanism (shutdown), not the trigger. The preceding
  // active `[mcp] stdin end/error …` / `[mcp] host process exited …` line is
  // the trigger classifier.
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
