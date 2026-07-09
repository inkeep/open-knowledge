/**
 * Git handle factory for sync operations.
 *
 * createGitInstance() returns a GitHandle with a configured SimpleGit instance.
 * withParentLock() (re-exported from git-mutex.ts) serializes all parent-git
 * write operations to prevent concurrent git index corruption.
 */

import { resolve } from 'node:path';
import simpleGit, { type SimpleGit, type SimpleGitOptions } from 'simple-git';

export { withParentLock } from './git-mutex.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A GitHub token resolved in the server process (where `gh` is reachable) and
 * relayed to the credential helper through the curated git env. The helper
 * (`open-knowledge auth git-credential`) has no `gh` shell-out of its own — it
 * returns this relayed token, else falls back to OK's stored token — so the
 * relay is the only path by which a gh-resolved token reaches sync. Resolving
 * server-side, in the full env where gh and its config are reachable, is what
 * makes sync's gh-token tier match clone's regardless of what the curated env
 * can run.
 */
export interface RelayGhToken {
  token: string;
  /** Host the token authenticates (e.g. `github.com`); the helper host-matches before using it. */
  host: string;
}

interface GitHandleOptions {
  /** git -c flags for credential injection (from resolveAuth) */
  credentialArgs?: string[];
  /** Override GIT_INDEX_FILE env var for index isolation */
  gitIndexFile?: string;
  /** gh token relayed to the credential helper via env (see {@link RelayGhToken}). */
  ghToken?: RelayGhToken;
  /**
   * Per-operation block timeout (ms) — simple-git kills the git child if it
   * emits no output for this long. The target-status fetch sets it so a hung
   * credentialed fetch degrades to an `unknown` verdict instead of stalling the
   * receiver's miss surface. Omitted = no timeout (the historical default that
   * the checkout/sync callers rely on).
   */
  timeoutMs?: number;
}

export interface GitHandle {
  git: SimpleGit;
  projectDir: string;
  credentialArgs: string[];
  env: Record<string, string>;
}

type CredentialHelperUnsafeGitOptions = SimpleGitOptions & {
  unsafe?: NonNullable<SimpleGitOptions['unsafe']> & {
    allowUnsafeCredentialHelper?: boolean;
  };
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const GIT_AUTH_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ALLUSERSPROFILE',
  'SystemRoot',
  'WINDIR',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERDOMAIN',
  'PATHEXT',
  'SSH_AUTH_SOCK',
  'ELECTRON_RUN_AS_NODE',
] as const;

/**
 * Build the environment for the spawned git process.
 *
 * simple-git's `.env(obj)` REPLACES the child environment — it does NOT merge
 * with `process.env` — so anything omitted here is dropped from git AND from
 * any credential helper git spawns. Several things must survive that
 * replacement:
 *
 * - `LANG`/`LC_ALL` = `C`: stable English stderr so the regex error
 *   classifiers (`error-classification.ts`, `isBranchNotFoundFetchError`)
 *   match across host locales. Matches `packages/cli/src/commands/clone.ts`.
 * - `PATH`: so git resolves its subprocesses, and a credential helper given as
 *   a bare command (`!open-knowledge auth git-credential` — the dev /
 *   CLI-on-PATH path) is found instead of failing "command not found".
 * - The `GIT_AUTH_ENV_KEYS` allowlist (`HOME`, `SSH_AUTH_SOCK`, the Windows
 *   home/profile vars, etc.): so the SSH transport finds `~/.ssh` and the
 *   user's credential helpers reach their home-based stores. Without these,
 *   SSH remotes and home-rooted helpers can't authenticate during sync.
 * - `ELECTRON_RUN_AS_NODE`: in packaged desktop builds the server runs as
 *   Electron-as-Node and sets `localOpCliArgs` to `[electronBinary, cli.mjs]`,
 *   so the credential helper re-invokes that binary directly (it bypasses the
 *   `ok.sh` wrapper that would otherwise set this). Without the var inherited,
 *   the binary boots as a GUI app and FATALs ("Unable to find helper app")
 *   before it can return credentials — git then falls back to an interactive
 *   username prompt with no TTY and the sync fails.
 *
 * `GIT_TERMINAL_PROMPT=0` is set unconditionally: the server-spawned git has no
 * controlling terminal, so when the credential helper returns nothing, an
 * attempted prompt fails with the alarming "could not read Username … Device
 * not configured" (an ENXIO on `/dev/tty`). Disabling prompts makes git
 * fail-fast with "terminal prompts disabled" instead, which the error
 * classifier maps to the reconnect-required auth state. Both strings classify
 * as no-credential, but this avoids a misleading errno in logs and the UI.
 *
 * `GIT_MERGE_AUTOEDIT=no` is set unconditionally for the same non-interactive
 * reason: `sync-engine`'s `git merge origin/<branch>` is the one sync op that
 * can produce a merge commit, and git may open an editor for its message. In a
 * TTY-less spawn git usually skips that, but the outcome is version- and
 * global-config-dependent (a user's `[merge] edit = true` can force it), and a
 * launched editor with no TTY hangs the background sync. Pinning auto-edit off
 * makes git use the default merge message and never launch an editor. Unlike
 * setting GIT_EDITOR, this doesn't trip simple-git's env guard (the var isn't in
 * its unsafe map), so it needs no `allowUnsafe*` opt-in.
 *
 * `OK_GH_TOKEN`/`OK_GH_TOKEN_HOST` are added only when a {@link RelayGhToken} is
 * supplied. This is the deliberate, named channel that carries a server-resolved
 * gh token to the credential helper across the env replacement — see
 * {@link RelayGhToken}.
 */
export function buildGitEnv(ghToken?: RelayGhToken): Record<string, string> {
  const env: Record<string, string> = {
    LANG: 'C',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_MERGE_AUTOEDIT: 'no',
  };
  const path = process.env.PATH ?? process.env.Path;
  if (path !== undefined) {
    env.PATH = path;
  }
  for (const key of GIT_AUTH_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (ghToken) {
    env.OK_GH_TOKEN = ghToken.token;
    env.OK_GH_TOKEN_HOST = ghToken.host;
  }
  return env;
}

/**
 * Merge `overrides` (author/committer vars) into the handle's preserved spawn
 * env and apply them. `undefined` values are skipped, not unset. simple-git's
 * `.env()` mutates `handle.git` in place and returns it, so callers may keep
 * using `handle.git` after this — the returned `SimpleGit` is that same instance.
 */
export function applyGitEnv(
  handle: GitHandle,
  overrides: Record<string, string | undefined>,
): SimpleGit {
  const env = { ...handle.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }
  return handle.git.env(env);
}

/**
 * Create a SimpleGit instance rooted at `projectDir` with optional credential
 * args and index file isolation. Env construction (and the reasons each var is
 * preserved through simple-git's env replacement) lives in `buildGitEnv`.
 */
export function createGitInstance(projectDir: string, options: GitHandleOptions = {}): GitHandle {
  const { credentialArgs = [], gitIndexFile, ghToken, timeoutMs } = options;

  const env: Record<string, string | undefined> = buildGitEnv(ghToken);
  if (gitIndexFile) {
    env.GIT_INDEX_FILE = resolve(projectDir, gitIndexFile);
  }

  // Server-spawned git inherits the user's ~/.gitconfig (buildGitEnv keeps
  // HOME so SSH keys and credential helpers resolve). Pin two of its directives
  // OFF for OK's git only — `-c` outranks global config, and the user's own
  // terminal/IDE git is untouched:
  //   - commit.gpgsign: the merge-resolution `git commit` would GPG-sign with no
  //     TTY; git aborts the commit on sign failure (it never falls back to
  //     unsigned), so a cache-cold sync tick fails, and a "success" would sign a
  //     bot-authored commit with the user's key.
  //   - core.autocrlf: would rewrite content EOLs on checkout/merge, fighting the
  //     byte-exact LF round-trip and churning the file-watcher <-> CRDT path.
  const gitConfig = [
    'commit.gpgsign=false',
    'core.autocrlf=false',
    ...(credentialArgs.length >= 2 ? [credentialArgs[1]] : []),
  ];

  // simple-git 3.36 gates credential.helper behind a runtime-only unsafe flag
  // that its published typings don't currently expose.
  const gitOptions: Partial<CredentialHelperUnsafeGitOptions> = {
    baseDir: projectDir,
    config: gitConfig,
    unsafe: { allowUnsafeCredentialHelper: true },
    ...(timeoutMs === undefined ? {} : { timeout: { block: timeoutMs } }),
  };

  const git = simpleGit(gitOptions as Partial<SimpleGitOptions>).env(env as Record<string, string>);

  return { git, projectDir, credentialArgs, env: env as Record<string, string> };
}
