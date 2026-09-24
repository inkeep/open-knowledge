import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { type BridgeWorktreeEntry, parseWorktreeListPorcelain } from '@inkeep/open-knowledge-core';
import { gitSpawnEnv } from './git-spawn-env.ts';

const execFileAsync = promisify(execFile);

const MAX_STDOUT_BYTES = 10 * 1024 * 1024;

const STDERR_LOG_CAP = 500;

export type GitWorktreeSnapshotResult =
  | { readonly ok: true; readonly entries: readonly BridgeWorktreeEntry[] }
  | { readonly ok: false };

export async function readGitWorktreeSnapshot(
  anchorPath: string,
): Promise<GitWorktreeSnapshotResult> {
  if (!isAbsolute(anchorPath)) {
    console.warn(
      `[receive] list_git_worktrees=failed reason=anchor-not-absolute anchor=${anchorPath}`,
    );
    return { ok: false };
  }

  let stdout: string;
  try {
    const result = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: anchorPath,
      env: gitSpawnEnv(),
      maxBuffer: MAX_STDOUT_BYTES,
      windowsHide: true,
    });
    stdout = String(result.stdout);
  } catch (err) {
    const stderrRaw = readErrStream(err, 'stderr') ?? readErrMessage(err) ?? '';
    const stderr = stderrRaw.replace(/\s+/g, ' ').slice(0, STDERR_LOG_CAP);
    console.warn(`[receive] list_git_worktrees=failed reason=${stderr}`);
    return { ok: false };
  }

  const parsed = parseWorktreeListPorcelain(stdout);

  const entries = parsed.map((entry) => {
    try {
      return { ...entry, path: realpathSync(entry.path) };
    } catch {
      return entry;
    }
  });
  return { ok: true, entries };
}

export async function listGitWorktrees(anchorPath: string): Promise<BridgeWorktreeEntry[]> {
  const result = await readGitWorktreeSnapshot(anchorPath);
  return result.ok ? [...result.entries] : [];
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
