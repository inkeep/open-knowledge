/**
 * Bash execution primitive — just-bash interpreter + ReadWriteFs backend.
 *
 *   - `just-bash` owns parsing, pipes, globs, quoting — we never hand input
 *     to a host shell.
 *   - `ReadWriteFs` sandboxes I/O to the caller-supplied cwd; traversal
 *     outside it is rejected at the filesystem layer (EACCES from
 *     `resolveAndValidate`).
 *   - Shadow-repo history is read via `simple-git` in `src/content/shadow-log.ts`,
 *     NOT through this module.
 *
 * **cwd is caller-supplied and per-call.** No module-level singleton. The
 * MCP server resolves the effective cwd from client roots / explicit args
 * and passes it in. `ReadWriteFs` uses that cwd as the virtual root `/`
 * inside the interpreter — agent-supplied paths like `articles/auth.md`
 * resolve relative to that root, which maps to `<cwd>/articles/auth.md`
 * on disk. Traversal above the cwd is rejected.
 *
 * Public surface:
 *   - shellEscape — POSIX-safe arg quoting
 *   - createBashInstance(cwd) — a fresh `Bash` scoped to the given host
 *     directory. `cwd` must be an absolute host path.
 *   - execBash(bash, command) — run a pre-validated command string
 *   - StdoutOverflowError — thrown when output exceeds the 16 MB cap
 */
import { isAbsolute, resolve } from 'node:path';
import { Bash, ReadWriteFs } from 'just-bash';

/** Hard cap on stdout bytes returned by `execBash` (16 MB). */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

// ── POSIX shell escape (retained for display/tool-description use) ──────
// Lives in `./shell-escape.ts` so the pure parse-command module can import
// it without pulling in the just-bash runtime. Re-exported here for callers
// that expect the function on the bash barrel.
export { shellEscape } from './shell-escape.ts';

// ── just-bash primitives ────────────────────────────────────────────────

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

/**
 * Create a fresh `Bash` instance scoped to the given host directory.
 * Callers wanting per-call isolation should create a new instance each call.
 *
 * `cwd` must be an absolute host path. `ReadWriteFs` uses that cwd as its
 * sandbox root (mapped to virtual `/` inside the interpreter), so agent
 * paths like `articles/auth.md` resolve to `<cwd>/articles/auth.md`, and
 * traversal above the cwd (`..`, absolute `/etc/passwd`, etc.) is blocked.
 */
export function createBashInstance(cwd: string): Bash {
  if (!isAbsolute(cwd)) {
    throw new Error(`createBashInstance: cwd must be absolute (got: ${cwd})`);
  }
  return new Bash({
    cwd: '/',
    fs: new ReadWriteFs({ root: resolve(cwd), allowSymlinks: false }),
  });
}

/**
 * Execute a pre-validated command string through a just-bash instance.
 * Callers are responsible for structural validation via `parseCommand` —
 * this function itself does NO allow/deny checking.
 *
 * Enforces the 16 MB stdout hard cap post-hoc: throws `StdoutOverflowError`
 * when exceeded, with the captured portion attached.
 */
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
