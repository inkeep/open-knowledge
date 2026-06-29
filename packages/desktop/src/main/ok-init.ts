
import { realpathSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

import type { LocalOpOkInitResponse } from '@inkeep/open-knowledge-core';
import { resolveGitDirDetailed } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { initContent, isProjectRoot } from '@inkeep/open-knowledge-server';

const inFlight = new Map<string, Promise<LocalOpOkInitResponse>>();

export async function runOkInit(projectPath: string): Promise<LocalOpOkInitResponse> {
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    return {
      ok: false,
      reason: 'not-a-git-worktree',
      message: 'projectPath must be a non-empty string.',
    };
  }

  if (!isAbsolute(projectPath)) {
    return {
      ok: false,
      reason: 'not-a-git-worktree',
      message: `projectPath must be an absolute path: ${projectPath}`,
    };
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(projectPath);
  } catch (err) {
    return {
      ok: false,
      reason: 'not-a-git-worktree',
      message: `projectPath does not exist or is not accessible: ${(err as Error).message}`,
    };
  }

  const gitDirKind = resolveGitDirDetailed(canonicalPath).kind;
  if (gitDirKind !== 'directory' && gitDirKind !== 'linked') {
    console.warn(
      `[ok-init] action=init project=${basename(canonicalPath)} result=not-a-git-worktree kind=${gitDirKind}`,
    );
    return {
      ok: false,
      reason: 'not-a-git-worktree',
      message: `projectPath is not a git working tree (.git is ${gitDirKind}).`,
    };
  }

  if (isProjectRoot(canonicalPath)) {
    console.warn(
      `[ok-init] action=init project=${basename(canonicalPath)} result=already-initialized`,
    );
    return { ok: true, projectPath: canonicalPath };
  }

  const existing = inFlight.get(canonicalPath);
  if (existing) {
    return existing;
  }

  const task = (async (): Promise<LocalOpOkInitResponse> => {
    try {
      initContent(canonicalPath);
      console.warn(`[ok-init] action=init project=${basename(canonicalPath)} result=success`);
      return { ok: true, projectPath: canonicalPath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[ok-init] action=init project=${basename(canonicalPath)} result=failed reason=${message}`,
      );
      return { ok: false, reason: 'init-failed', message };
    }
  })();

  inFlight.set(canonicalPath, task);
  try {
    return await task;
  } finally {
    inFlight.delete(canonicalPath);
  }
}
