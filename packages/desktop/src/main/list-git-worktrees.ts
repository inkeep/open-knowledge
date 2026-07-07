/**
 * `git worktree list --porcelain` runner for the share-receive enumeration
 * step. Spawns git rooted at `anchorPath` (which must be inside the target
 * repo; any non-missing OK Recents entry with a matching gitRemoteUrl works),
 * parses the porcelain output, and applies `realpathSync` to every returned
 * path so the candidate-selection layer can identity-collapse symlinked
 * paths against the canonical worktree path.
 *
 * Lives in desktop main (not server) because the receive-flow IPC bridge is
 * a desktop concern — no server runtime is available at share-receive
 * Q1 time (the user may not have opened any project yet). The same locale
 * stabilization (`LANG=C` / `LC_ALL=C`) that `createGitInstance` applies for
 * the server-side checkout flow is applied here too so stderr classification
 * stays English regardless of the receiver's host locale.
 *
 * Sibling to `read-head-branch.ts` (same layer, same graceful-fail
 * discipline: every error mode collapses to a returned `[]` so a single
 * broken anchor never blocks a share-receive that could still be served
 * from the Recents-only candidate set).
 */

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { type BridgeWorktreeEntry, parseWorktreeListPorcelain } from '@inkeep/open-knowledge-core';

const execFileAsync = promisify(execFile);

/**
 * Cap stdout at 10 MiB. `git worktree list --porcelain` is small — even a
 * pathological repo with thousands of worktrees would not exceed this.
 * Hitting the cap means something has gone wrong and we should treat the
 * output as untrusted; the parser is tolerant enough to handle partial
 * blocks.
 */
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;

/**
 * Cap stderr included in the warning log at 500 bytes. Git can emit
 * multi-paragraph error output (especially with verbose locales — but
 * `LANG=C` keeps things terse), and we don't want to flood the console.
 */
const STDERR_LOG_CAP = 500;

/**
 * Run `git worktree list --porcelain` from `anchorPath` and return the
 * parsed entries with realpath-collapsed paths. Returns `[]` on any failure
 * mode (non-absolute anchor, non-git anchor, git exit non-zero, parser
 * yields nothing). Never throws.
 */
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
      // A prunable worktree's path may not exist on disk anymore. Keep the
      // entry with the path git reported — selection logic will skip it
      // based on `prunable` rather than crash here.
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
