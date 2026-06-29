
import { spawn } from 'node:child_process';
import { delimiter as PATH_DELIMITER } from 'node:path';

interface ParsedLine {
  raw: string;
  parsed: Record<string, unknown> | null;
}

interface SubprocessRunOptions {
  cliArgs: readonly string[];
  trailingArgs: readonly string[];
  cwd?: string;
  extraPathDirs?: readonly string[];
  timeoutMs: number;
  onLine: (line: ParsedLine) => void;
  onStderr?: (chunk: Buffer) => void;
}

interface SubprocessRunResult {
  code: number | null;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

interface SubprocessController {
  done: Promise<SubprocessRunResult>;
  cancel(): void;
}

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

  const child = spawn(cmd, argv, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });

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
        }
      }
    },
  };
}
