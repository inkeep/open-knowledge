import { isAbsolute, resolve } from 'node:path';
import { Bash, ReadWriteFs } from 'just-bash';

const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

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
    cwd: '/',
    fs: new ReadWriteFs({ root: resolve(cwd), allowSymlinks: false }),
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
