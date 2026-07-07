/**
 * Process-level safety net for the Electron main process: swallow benign
 * broken-pipe (EPIPE) errors on stdout/stderr at the stream boundary so they
 * never escalate to an uncaught exception (and Electron's fatal "A JavaScript
 * error occurred in the main process" modal).
 *
 * Why a stream-level `'error'` listener and NOT a `process.on('uncaughtException')`
 * filter (the approach VS Code takes): Electron defers its default crash dialog
 * to a userland `uncaughtException` handler whenever one exists, so adding one
 * would suppress the dialog for EVERY error — masking genuine crashes unless the
 * whole error pipeline is reimplemented (which VS Code has and we have not).
 * Handling EPIPE at the stream level leaves Electron's crash dialog intact for
 * every other error, and is logger-agnostic: it covers every stdout/stderr
 * writer, not just the auto-updater timer that surfaced the bug.
 */

/** Marker so a second install on the same stream is a no-op (no stacked listeners). */
const GUARDED = Symbol.for('ok.desktop.stdio-broken-pipe-guard');

/**
 * `EPIPE`: write to a pipe whose read end has closed. `ERR_STREAM_DESTROYED`: a
 * write that lands after the stream was torn down. Only these are swallowed;
 * every other error keeps its normal fail-loud path so a genuine bug is never
 * masked.
 */
const BROKEN_PIPE_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED']);

export function isBrokenPipeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && BROKEN_PIPE_CODES.has(code);
}

/** Minimal surface this guard needs — `process` satisfies it, and tests pass emitters. */
interface StdioStream {
  on(event: 'error', listener: (err: Error) => void): unknown;
  [GUARDED]?: boolean;
}
interface ProcessLike {
  stdout: StdioStream;
  stderr: StdioStream;
}

interface InstallOpts {
  /**
   * Sink for a NON-broken-pipe stream error (e.g. ENOSPC on a redirected
   * stdout). Required so such errors are never silently dropped — production
   * routes it to the pino file logger, which writes to `~/.ok/logs` and never
   * back to the failing stream. Runs inside the stream `'error'` listener, so it
   * must not assume it can write to that stream; any throw it raises is
   * swallowed (see `installStdioBrokenPipeGuard`).
   */
  onNonBenignError: (stream: 'stdout' | 'stderr', err: Error) => void;
}

/**
 * Attach broken-pipe-swallowing `'error'` listeners to stdout/stderr. Call once,
 * as early as possible in main-process boot, before any window or the
 * auto-updater starts. Idempotent per stream.
 */
export function installStdioBrokenPipeGuard(proc: ProcessLike, opts: InstallOpts): void {
  const guardStream = (stream: StdioStream, name: 'stdout' | 'stderr'): void => {
    if (stream[GUARDED]) return;
    stream[GUARDED] = true;
    stream.on('error', (err: Error) => {
      if (isBrokenPipeError(err)) return;
      // The sink must never crash the process: a throw here (e.g. the file
      // logger's lazy `mkdirSync` hitting EACCES) would re-create the very
      // uncaught exception this guard exists to prevent. Swallow it — there is
      // nowhere safe left to report once the stream sink itself is failing.
      try {
        opts.onNonBenignError(name, err);
      } catch {}
    });
  };
  guardStream(proc.stdout, 'stdout');
  guardStream(proc.stderr, 'stderr');
}
