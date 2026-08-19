/**
 * Git handle factory for sync operations.
 *
 * createGitInstance() returns a GitHandle with a configured SimpleGit instance.
 * withParentLock() (re-exported from git-mutex.ts) serializes all parent-git
 * write operations to prevent concurrent git index corruption.
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { augmentGitSpawnPath } from '@inkeep/open-knowledge-core';
import simpleGit, { type SimpleGit, type SimpleGitOptions } from 'simple-git';
import { shellEscape } from './bash/shell-escape.ts';

/** Existence probe for `augmentGitSpawnPath` — directories only. Named to
 *  match the `GitSpawnPathOptions.isDir` seam (and the desktop twin in
 *  `git-spawn-env.ts`); duplicated rather than shared because core stays
 *  browser-compatible and can't export a `node:fs` probe. */
function isDir(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

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
  /**
   * Ordered `credential.helper=` config VALUES (from
   * `buildSyncCredentialConfig`: empty reset first, OK's helper last),
   * forwarded verbatim into the spawn's `-c` config list.
   *
   * REQUIRED, and `[]` is a meaningful value rather than a default: omitting it
   * used to be indistinguishable between "local-only op, needs no credential"
   * and "remote op, forgot to pass it", and the latter authenticates with
   * whatever ambient helper the machine happens to have. Every call site now
   * states its intent, so a remote spawn cannot silently inherit the ambient
   * chain.
   */
  credentialConfig: string[];
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
  credentialConfig: string[];
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
 *   home/profile vars, etc.): so the SSH transport finds `~/.ssh`, OK's own
 *   helper can reach its home-based store, and — on origins where the ambient
 *   chain is deliberately preserved (see `shouldResetAmbientCredentials`) —
 *   the user's own helpers reach theirs. Without these, SSH remotes and
 *   home-rooted helpers can't authenticate during sync. Note this is about
 *   REACHING a store, not about ordering: on a GitHub origin the reset means
 *   ambient helpers are not consulted for HTTPS credentials at all.
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
 * fail-fast instead, which the error classifier maps to the reconnect-required
 * auth state. It is the SECOND line of defence, not the first: `createGitInstance`
 * pins `credential.interactive=false`, which on git versions that honor it
 * short-circuits in `credential_getpass` before the terminal path is reached — so
 * the string the server emits there is "unable to get password from user", not
 * "terminal prompts disabled". Both classify as no-credential; this var is what
 * covers the paths and git versions the pin doesn't, keeping the misleading
 * ENXIO errno out of logs and the UI.
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
  // Augmented, not raw: a packaged-desktop-spawned server inherits launchd's
  // minimal PATH, which resolves git but NOT the helpers git spawns
  // mid-operation (git-lfs filters, credential helpers, hooks). Appending
  // well-known tool dirs keeps existing PATH entries authoritative while
  // making those helpers resolvable — the terminal-launched `ok start` path
  // is a no-op (its PATH already contains them).
  const path = process.env.PATH ?? process.env.Path;
  env.PATH = augmentGitSpawnPath(path, {
    platform: process.platform,
    homeDir: homedir(),
    isDir,
    delimiter,
  });
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
 *
 * This factory is the sanctioned path for any server-side git that CAN REACH A
 * REMOTE. It is the only place the non-interactivity guarantees are assembled
 * (`GIT_TERMINAL_PROMPT=0` + `credential.interactive=false`), and a remote-capable
 * spawn without them can put an OS credential dialog on the user's desktop from a
 * process they can't see. Bare `simpleGit(...)` elsewhere in the server is fine
 * for local-only work (log reads, shadow-ref plumbing) — but the moment such a
 * call site grows a `fetch`/`push`/`ls-remote`, it must move to this factory.
 */
export function createGitInstance(projectDir: string, options: GitHandleOptions): GitHandle {
  const { credentialConfig, gitIndexFile, ghToken, timeoutMs } = options;

  const env: Record<string, string | undefined> = buildGitEnv(ghToken);
  if (gitIndexFile) {
    env.GIT_INDEX_FILE = resolve(projectDir, gitIndexFile);
  }

  // Server-spawned git inherits the user's ~/.gitconfig (buildGitEnv keeps
  // HOME so SSH keys and credential helpers resolve). Pin three of its directives
  // OFF for OK's git only — `-c` outranks global config, and the user's own
  // terminal/IDE git is untouched:
  //   - commit.gpgsign: the merge-resolution `git commit` would GPG-sign with no
  //     TTY; git aborts the commit on sign failure (it never falls back to
  //     unsigned), so a cache-cold sync tick fails, and a "success" would sign a
  //     bot-authored commit with the user's key.
  //   - core.autocrlf: would rewrite content EOLs on checkout/merge, fighting the
  //     byte-exact LF round-trip and churning the file-watcher <-> CRDT path.
  //   - credential.interactive: the companion to buildGitEnv's
  //     `GIT_TERMINAL_PROMPT=0`, which only governs git's OWN terminal prompt and
  //     does nothing to a credential helper's GUI. Git for Windows ships
  //     `credential.helper=manager` in its system config, and Git Credential
  //     Manager is interactive by default, so any credential miss on a background
  //     fetch opened a GitHub sign-in WINDOW on the user's desktop with no user
  //     action — every ~30s pull tick, for a daemon the user can't see.
  //     Honored at BOTH layers: git's own `credential_getpass` short-circuits on
  //     it, and GCM reads it to decline its dialog. So the miss surfaces as OK's
  //     `auth-error` + "Sign in" affordance instead of an OS prompt.
  //     Cross-platform consequence: on git versions that honor it (measured:
  //     2.54 does, 2.39 doesn't) this REPLACES the "terminal prompts disabled"
  //     stderr with "unable to get password from user" everywhere, not just on
  //     Windows — `GIT_AUTH_NO_CREDENTIAL_PATTERNS` must keep matching both.
  const gitConfig = [
    'commit.gpgsign=false',
    'core.autocrlf=false',
    'credential.interactive=false',
    ...credentialConfig,
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

  return { git, projectDir, credentialConfig, env: env as Record<string, string> };
}

/**
 * Build the ordered git config VALUES (spread into `createGitInstance`'s `-c`
 * list) that let SyncEngine's fetch/push authenticate by shelling out to our
 * own CLI's `auth git-credential` helper.
 *
 * Git runs a `!`-prefixed credential helper through the shell, so every argv
 * element must be shell-quoted. The packaged macOS CLI path lives under
 * `/Applications/OpenKnowledge.app/…` — the space splits unquoted, the shell
 * fails to exec, the helper returns no credentials, and git falls back to an
 * interactive username prompt with no TTY ("could not read Username … Device
 * not configured"). `shellEscape` per argv element is the fix.
 *
 * The leading empty `credential.helper=` value, when present, is load-bearing.
 * `credential.helper` is multi-valued — git accumulates every configured value
 * (system → global → repo-local → `-c`, in that order) and asks helpers in
 * order, stopping at the first that returns a complete credential. Without the
 * reset, an ambient helper (macOS Command Line Tools install a system-wide
 * osxkeychain; Git for Windows ships `manager`) answers `get` with whatever it
 * holds — possibly stale — before OK's helper is ever consulted, while OK's
 * valid token sits unused in the relay env. An empty value clears the list
 * accumulated so far, making OK's helper the only one consulted for these
 * spawns; `-c` is per-spawn, so the user's own terminal/IDE git is untouched.
 * Same convention as the clone path's `resolveAuth`
 * (cli/src/auth/resolve-auth.ts, `ResolvedAuth.gitConfig`) — keep the two in
 * step: config values, reset first, our helper last. Like clone's `none` tier,
 * the reset is conditional rather than unconditional: it is emitted only where
 * OK can actually issue a credential for the origin. On a GitHub or GHES
 * origin, a user whose only working credential was ambient is deliberately
 * routed to OK's sign-in rather than silently borrowing it. On a known
 * non-GitHub forge OK can never issue one — `validateGitHubHost` rejects those
 * hosts at login and the gh relay is host-scoped — so clearing the chain there
 * would strand sync with no in-app remedy. `shouldResetAmbientCredentials`
 * makes that call.
 */
export function buildSyncCredentialConfig(
  localOpCliArgs: string[] | undefined,
  opts: { resetAmbient: boolean },
): string[] {
  const argv = localOpCliArgs && localOpCliArgs.length > 0 ? localOpCliArgs : ['open-knowledge'];
  const cliPrefix = argv.map(shellEscape).join(' ');
  const helper = `credential.helper=!${cliPrefix} auth git-credential`;
  // The reset is what makes OK's helper authoritative, but it is only safe
  // where OK can actually supply a credential — see shouldResetAmbientCredentials.
  return opts.resetAmbient ? ['credential.helper=', helper] : [helper];
}
