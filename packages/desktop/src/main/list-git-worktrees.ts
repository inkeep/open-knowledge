import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { type BridgeWorktreeEntry, parseWorktreeListPorcelain } from '@inkeep/open-knowledge-core';

const execFileAsync = promisify(execFile);

const MAX_STDOUT_BYTES = 10 * 1024 * 1024;

const STDERR_LOG_CAP = 500;

export async function listGitWorktrees(anchorPath: string): Promise<BridgeWorktreeEntry[]> {
  if (!isAbsolute(anchorPath)) {
    console.warn(
      `[receive] list_git_worktrees=failed reason=anchor-not-absolute anchor=${anchorPath}`,
    );
    return [];
  }

  let stdout: string;
  try {
    const result = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: anchorPath,
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      maxBuffer: MAX_STDOUT_BYTES,
    });
    stdout = String(result.stdout);
  } catch (err) {
    const stderrRaw = readErrStream(err, 'stderr') ?? readErrMessage(err) ?? '';
    const stderr = stderrRaw.replace(/\s+/g, ' ').slice(0, STDERR_LOG_CAP);
    console.warn(`[receive] list_git_worktrees=failed reason=${stderr}`);
    return [];
  }

  const parsed = parseWorktreeListPorcelain(stdout);

  return parsed.map((entry) => {
    try {
      return { ...entry, path: realpathSync(entry.path) };
    } catch {
      return entry;
    }
  });
}

interface ExecFileError {
  stderr?: string | Buffer;
  message?: string;
}

function readErrStream(err: unknown, key: 'stderr'): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const val = (err as ExecFileError)[key];
  if (val === undefined || val === null) return null;
  return Buffer.isBuffer(val) ? val.toString('utf-8') : String(val);
}

function readErrMessage(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const msg = (err as ExecFileError).message;
  return typeof msg === 'string' ? msg : null;
}
