/**
 * Shared subprocess runner for local-op flows.
 *
 * Spawns a CLI subprocess, parses NDJSON lines from stdout, and forwards
 * each parsed event to the caller via `onLine`. The caller decides whether
 * the event is terminal (`complete` / `error`) and translates non-NDJSON
 * lines as needed.
 *
 * Lifetime: the returned controller's `cancel()` sends SIGTERM. The runner
 * resolves with `{ code, stderr }` once the child exits, regardless of
 * cancellation.
 */

import { spawn } from 'node:child_process';
import { delimiter as PATH_DELIMITER } from 'node:path';
import { withHiddenWindowsConsole } from '../child-process-windows-hide.ts';

const SUBPROCESS_PIPE_STDIO_OPTIONS: { stdio: ['ignore', 'pipe', 'pipe'] } = {
  stdio: ['ignore', 'pipe', 'pipe'],
};

/** A parsed JSON line plus the raw line (for HTTP NDJSON pass-through). */
interface ParsedLine {
  /** Raw NDJSON line (no trailing newline). */
  raw: string;
  /** Parsed JSON value when the line was valid JSON; null otherwise. */
  parsed: Record<string, unknown> | null;
}

interface SubprocessRunOptions {
  /** Command + base argv prefix, e.g. ['open-knowledge'] or [process.execPath, scriptPath]. */
  cliArgs: readonly string[];
  /** Args appended after `cliArgs` (e.g. ['auth', 'login', '--json']). */
  trailingArgs: readonly string[];
  /** Optional cwd override. */
  cwd?: string;
  /**
   * Directories to prepend to the child's `PATH`. When set, the child resolves
   * commands against these dirs before the inherited PATH — used to point a
   * spawned `<cli> clone` at the git binary the caller's preflight validated
   * (closes the check/use binding divergence). Empty/absent leaves the
   * inherited environment untouched.
   */
  extraPathDirs?: readonly string[];
  /** Wall-clock timeout. SIGTERMs the child when reached. */
  timeoutMs: number;
  /** Called once per stdout line (non-empty after newline split + trailing flush). */
  onLine: (line: ParsedLine) => void;
  /** Optional stderr observer (receives raw chunks). */
  onStderr?: (chunk: Buffer) => void;
}

interface SubprocessRunResult {
  /** Process exit code; null on signal. */
  code: number | null;
  /** Captured stderr (utf-8). */
  stderr: string;
  /** True when the wall-clock timeout fired. */
  timedOut: boolean;
  /** True when `cancel()` was called by the caller. */
  cancelled: boolean;
}

interface SubprocessController {
  /** Promise that resolves once the child has exited (success or otherwise). */
  done: Promise<SubprocessRunResult>;
  /** SIGTERM the child. Idempotent. */
  cancel(): void;
}

/**
 * Spawn a CLI subprocess and stream its NDJSON output via `onLine`.
 *
 * Caller terminates the stream by inspecting parsed events; this runner
 * doesn't know which `type` is terminal — callers (auth vs clone) own that.
 */
export function runSubprocess(opts: SubprocessRunOptions): SubprocessController {
  const [cmd, ...baseArgs] = opts.cliArgs;
  if (!cmd) {
    return {
      done: Promise.resolve({
        code: -1,
        stderr: 'no command provided',
        timedOut: false,
        cancelled: false,
      }),
      cancel: () => {},
    };
  }
  const argv = [...baseArgs, ...opts.trailingArgs];

  let timedOut = false;
  let cancelled = false;
  let stdoutBuffer = '';
  const stderrChunks: Buffer[] = [];

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (opts.extraPathDirs && opts.extraPathDirs.length > 0) {
    childEnv.PATH = [...opts.extraPathDirs, process.env.PATH ?? '']
      .filter(Boolean)
      .join(PATH_DELIMITER);
  }

  const child = spawn(
    cmd,
    argv,
    withHiddenWindowsConsole({
      ...SUBPROCESS_PIPE_STDIO_OPTIONS,
      cwd: opts.cwd,
      env: childEnv,
    }),
  );

  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, opts.timeoutMs);

  const flushLine = (raw: string): void => {
    if (!raw.trim()) return;
    let parsed: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(raw);
      parsed = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    opts.onLine({ raw, parsed });
  };

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf-8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) flushLine(line);
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
    opts.onStderr?.(chunk);
  });

  const done = new Promise<SubprocessRunResult>((resolve) => {
    child.on('close', (code) => {
      clearTimeout(killTimer);
      // Flush any trailing partial line that lacks a newline terminator.
      if (stdoutBuffer.trim()) flushLine(stdoutBuffer);
      stdoutBuffer = '';
      resolve({
        code,
        stderr: Buffer.concat(stderrChunks).toString('utf-8').trim(),
        timedOut,
        cancelled,
      });
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      stderrChunks.push(Buffer.from(err.message, 'utf-8'));
      resolve({
        code: -1,
        stderr: Buffer.concat(stderrChunks).toString('utf-8').trim(),
        timedOut,
        cancelled,
      });
    });
  });

  return {
    done,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      if (!child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          // Already exited — nothing to do.
        }
      }
    },
  };
}
