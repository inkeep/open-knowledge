import { spawn } from 'node:child_process';
import { posix, win32 } from 'node:path';
import { withHiddenWindowsConsole } from '../child-process-windows-hide.ts';

interface ParsedLine {
  raw: string;
  parsed: Record<string, unknown> | null;
}

type LocalOpCliEnv = Readonly<Record<string, string | undefined>>;

export interface LocalOpCliInvocation {
  readonly cliArgs: readonly string[];
  readonly cliEnv?: LocalOpCliEnv;
}

interface SubprocessRunOptions extends LocalOpCliInvocation {
  trailingArgs: readonly string[];
  cwd?: string;
  extraPathDirs?: readonly string[];
  timeoutMs: number;
  onLine: (line: ParsedLine) => void;
  onStderr?: (chunk: Buffer) => void;
  stdinData?: string;
  platform?: NodeJS.Platform;
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

function overlayEnvEntry(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string | undefined,
  platform: NodeJS.Platform,
): void {
  if (platform === 'win32') {
    const folded = key.toLowerCase();
    for (const existing of Object.keys(env)) {
      if (existing !== key && existing.toLowerCase() === folded) delete env[existing];
    }
  }
  if (value === undefined) delete env[key];
  else env[key] = value;
}

function pathDelimiterFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? win32.delimiter : posix.delimiter;
}

function readPathEntry(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.PATH !== undefined) return env.PATH;
  if (platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') return env[key] ?? '';
    }
  }
  return '';
}

export function buildOverlaidEnv(
  baseEnv: NodeJS.ProcessEnv,
  overlay: LocalOpCliEnv | undefined,
  extraPathDirs: readonly string[] | undefined,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [key, value] of Object.entries(overlay ?? {})) {
    overlayEnvEntry(env, key, value, platform);
  }
  if (extraPathDirs && extraPathDirs.length > 0) {
    overlayEnvEntry(
      env,
      'PATH',
      [...extraPathDirs, readPathEntry(env, platform)]
        .filter(Boolean)
        .join(pathDelimiterFor(platform)),
      platform,
    );
  }
  return env;
}

const SPAWN_ERROR_FACT_KEYS = ['code', 'errno', 'syscall'] as const;

function describeSpawnError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err === null || typeof err !== 'object') return message;
  const facts: string[] = [];
  for (const key of SPAWN_ERROR_FACT_KEYS) {
    const value = (err as Record<string, unknown>)[key];
    if (typeof value === 'number' || (typeof value === 'string' && value !== '')) {
      facts.push(`${key}=${value}`);
    }
  }
  return facts.length === 0 ? message : `${message} (${facts.join(' ')})`;
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

  const platform = opts.platform ?? process.platform;
  const childEnv = buildOverlaidEnv(process.env, opts.cliEnv, opts.extraPathDirs, platform);

  const stdio: ['ignore' | 'pipe', 'pipe', 'pipe'] =
    opts.stdinData !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      cmd,
      argv,
      withHiddenWindowsConsole({
        stdio,
        cwd: opts.cwd,
        env: childEnv,
      }),
    );
  } catch (err) {
    return {
      done: Promise.resolve({
        code: -1,
        stderr: describeSpawnError(err),
        timedOut: false,
        cancelled: false,
      }),
      cancel: () => {},
    };
  }

  if (opts.stdinData !== undefined && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.write(opts.stdinData);
    child.stdin.end();
  }

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

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf-8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) flushLine(line);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
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
      stderrChunks.push(Buffer.from(describeSpawnError(err), 'utf-8'));
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
        } catch {}
      }
    },
  };
}
