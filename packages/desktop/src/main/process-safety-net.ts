const GUARDED = Symbol.for('ok.desktop.stdio-broken-pipe-guard');

const BROKEN_PIPE_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED']);

export function isBrokenPipeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && BROKEN_PIPE_CODES.has(code);
}

interface StdioStream {
  on(event: 'error', listener: (err: Error) => void): unknown;
  [GUARDED]?: boolean;
}
interface ProcessLike {
  stdout: StdioStream;
  stderr: StdioStream;
}

interface InstallOpts {
  onNonBenignError: (stream: 'stdout' | 'stderr', err: Error) => void;
}

export function installStdioBrokenPipeGuard(proc: ProcessLike, opts: InstallOpts): void {
  const guardStream = (stream: StdioStream, name: 'stdout' | 'stderr'): void => {
    if (stream[GUARDED]) return;
    stream[GUARDED] = true;
    stream.on('error', (err: Error) => {
      if (isBrokenPipeError(err)) return;
      try {
        opts.onNonBenignError(name, err);
      } catch {}
    });
  };
  guardStream(proc.stdout, 'stdout');
  guardStream(proc.stderr, 'stderr');
}
