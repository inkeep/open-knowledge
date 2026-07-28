/**
 * Shared spawn env for every desktop-main git invocation.
 *
 * Packaged Electron inherits launchd's minimal `PATH` (Finder launch AND the
 * CLI handoff — `open -b` routes through LaunchServices, so the app never
 * sees a terminal's PATH). git survives that, but the helper subprocesses git
 * spawns mid-operation (git-lfs filters, credential helpers, hooks) are
 * typically Homebrew installs that minimal PATH can't resolve, and a missing
 * required helper aborts the whole operation. `augmentGitSpawnPath` appends
 * well-known tool directories so those helpers resolve; existing PATH entries
 * keep priority (append-only).
 *
 * `LANG=C`/`LC_ALL=C` pin stderr to English so classification
 * (`detectMissingGitHelper`, the add-error / branch-gone matchers) survives a
 * non-English host locale — same discipline as the server's `buildGitEnv`.
 *
 * Only the PATH augmentation is cached (it stats well-known directories, and
 * PATH/homedir don't change within a process lifetime). The env object itself
 * is rebuilt from live `process.env` on every call: startup corrects
 * `SSH_AUTH_SOCK` once via the login-shell harvest (`shell-env.ts` /
 * `applyHarvestedAuthSock`), and a cached snapshot taken before that point
 * would pin every later git spawn to launchd's default-agent socket. For the
 * same reason, callers must not freeze this function's result into
 * module-level constants — call it per spawn.
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import { augmentGitSpawnPath } from '@inkeep/open-knowledge-core';

let cachedPath: string | null = null;

/** True iff `dir` exists and is a directory (symlinks followed). */
function isDir(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The env for desktop-main git spawns: `process.env` with augmented PATH and
 * pinned English locale. Callers spread additional vars on top (e.g. the
 * share-fetch arm's `GIT_TERMINAL_PROMPT=0`).
 */
export function gitSpawnEnv(): Record<string, string | undefined> {
  if (cachedPath === null) {
    cachedPath = augmentGitSpawnPath(process.env.PATH, {
      platform: process.platform,
      homeDir: homedir(),
      isDir,
      delimiter,
    });
  }
  return {
    ...process.env,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: cachedPath,
  };
}
