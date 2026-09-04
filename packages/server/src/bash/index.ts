import { isAbsolute, resolve } from 'node:path';
/*
 * UPSTREAM(just-bash@2.14.3): below this floor the sandbox-containment gate
 * hardcodes the POSIX separator, so every backslash-separated path below the
 * root fails containment on Windows. Keep the range in package.json at or above
 * it.
 */
import { Bash, OverlayFs } from 'just-bash';

const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

const PROJECT_MOUNT = '/home/user/project';

export type ErofsCheck = { blocked: false } | { blocked: true; target: string | null };

export function erofsTarget(source: unknown): ErofsCheck {
  const message = source instanceof Error ? source.message : String(source);
  if (!message.includes('EROFS: read-only file system')) return { blocked: false };
  for (const match of message.matchAll(/'([^']+)'/g)) {
    const raw = match[1];
    if (raw === '<path>') continue;
    const rel = raw.startsWith(`${PROJECT_MOUNT}/`) ? raw.slice(PROJECT_MOUNT.length + 1) : raw;
    const clean = rel.startsWith('./') ? rel.slice(2) : rel;
    if (clean !== '' && clean !== '.' && clean !== PROJECT_MOUNT)
      return { blocked: true, target: clean };
  }
  return { blocked: true, target: null };
}

export { shellEscape } from './shell-escape.ts';

interface ExecBashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class StdoutOverflowError extends Error {
  public readonly limitBytes: number;
  public readonly actualBytes: number;
  public readonly partial: ExecBashResult;
  constructor(limit: number, actual: number, partial: ExecBashResult) {
    super(`Output exceeded ${limit} byte buffer (got ${actual}); narrow the command`);
    this.name = 'StdoutOverflowError';
    this.limitBytes = limit;
    this.actualBytes = actual;
    this.partial = partial;
  }
}

export function createBashInstance(cwd: string): Bash {
  if (!isAbsolute(cwd)) {
    throw new Error(`createBashInstance: cwd must be absolute (got: ${cwd})`);
  }
  return new Bash({
    cwd: PROJECT_MOUNT,
    fs: new OverlayFs({
      root: resolve(cwd),
      mountPoint: PROJECT_MOUNT,
      allowSymlinks: false,
      readOnly: true,
    }),
  });
}

export async function execBash(bash: Bash, command: string): Promise<ExecBashResult> {
  const result = await bash.exec(command);
  if (result.stdout.length > MAX_STDOUT_BYTES) {
    throw new StdoutOverflowError(MAX_STDOUT_BYTES, result.stdout.length, {
      stdout: result.stdout.slice(0, MAX_STDOUT_BYTES),
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}
