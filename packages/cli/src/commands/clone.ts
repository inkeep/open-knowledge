import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type ClassifiedGitAuthError,
  classifyGitAuthError,
  isBranchNotFoundGitError,
  isLoginFixableGitAuthError,
  shellSingleQuote,
} from '@inkeep/open-knowledge-core';
import {
  assertGitAvailable,
  type Config,
  type CredentialUrlMatchReader,
  type GitHubAccountSource,
  GitNotAvailableError,
  GitTooOldError,
  loginShapedUserinfoUser,
  redactShareSubprocessStderr,
  resolveGitHubAccountFromUrl,
  sameGitHubLogin,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import simpleGit, { type SimpleGitOptions } from 'simple-git';
import type { GhDetectResult } from '../auth/gh-detect.ts';
import { type ResolvedAuth, resolveAuth } from '../auth/resolve-auth.ts';
import { makeLazyTokenStore, type TokenStore } from '../auth/token-store.ts';
import { OK_DIR } from '../constants.ts';
import { parseGitUrl } from '../github/url.ts';
import { isGitHubRepoPublic } from '../github/visibility.ts';
import { addOkPathsToGitExclude } from '../sharing/git-exclude.ts';

// ---------------------------------------------------------------------------
// Progress phase weighting
// Counting: 0-10%, Compressing: 10-20%, Receiving: 20-60%, Resolving: 60-100%
// ---------------------------------------------------------------------------

const STAGE_RANGES: [string, number, number][] = [
  ['count', 0, 10],
  ['compress', 10, 20],
  ['receiv', 20, 60],
  ['resolv', 60, 100],
];

function parseProgressLine(line: string): { stage: string; pct: number } | null {
  // Match lines like "Receiving objects:  56% (7/12)"
  const m = /^([\w ]+):\s+(\d+)%/.exec(line.trim());
  if (!m) return null;
  const label = m[1].toLowerCase();
  const raw = Number(m[2]);
  for (const [key, start, end] of STAGE_RANGES) {
    if (label.includes(key)) {
      return { stage: m[1], pct: Math.round(start + (raw / 100) * (end - start)) };
    }
  }
  return null;
}

function emit(json: boolean, obj: Record<string, unknown>): void {
  if (json) process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/**
 * Build the environment for the spawned clone git process.
 *
 * Inherits the caller's full environment: clone is a foreground command in the
 * user's own shell context, so git needs the real PATH (to resolve its transport
 * subprocesses and, for an SSH remote, `ssh`) and HOME (so git and SSH locate
 * `~/.gitconfig` / `~/.ssh`, and so the self-referential credential helper —
 * re-invoked as `[execPath, cliEntry]`, with `ELECTRON_RUN_AS_NODE` carried
 * through this spread — reaches its HOME-based token store). simple-git's
 * `.env()` REPLACES the child env, so we must spread the source env rather than
 * pass a bare object — the earlier `{ GIT_TERMINAL_PROMPT: '0' }`-only form
 * silently stripped both, breaking auth on stock installs.
 *
 * Overrides applied after the spread: `GIT_TERMINAL_PROMPT=0` so a credential
 * miss fails fast instead of hanging on a TTY-less prompt, and `LANG`/`LC_ALL=C`
 * so `clone-error-classify`'s English stderr regexes match regardless of the
 * user's locale (the spread would otherwise let a `fr_FR` locale leak through).
 *
 * `sourceEnv` is injectable for tests; production passes `process.env`.
 */
export function buildCloneEnv(sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.LANG = 'C';
  env.LC_ALL = 'C';
  return env;
}

/**
 * Compose the full clone git env: `buildCloneEnv` plus the gh-token relay for
 * Tier A. When a gh token was resolved, relay it to the self-referential
 * credential helper via env (the helper reads OK_GH_TOKEN first) rather than
 * making git shell out to `gh`, which may not be on the git subprocess PATH.
 * Without a relay token, any OK_GH_TOKEN inherited from the parent env is
 * STRIPPED — a stale exported token would otherwise shadow the token store
 * inside the helper, and only this process's own resolution may speak for
 * which credential the clone uses.
 *
 * OK_GH_TOKEN_LOGIN names the account behind the token for diagnostics only —
 * the helper never gates on it. It is set only when this resolution knows the
 * account, and stripped otherwise for the same stale-inheritance reason.
 */
export function buildCloneAuthEnv(
  resolved: Pick<ResolvedAuth, 'relayToken'>,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = buildCloneEnv(sourceEnv);
  if (resolved.relayToken) {
    env.OK_GH_TOKEN = resolved.relayToken.token;
    env.OK_GH_TOKEN_HOST = resolved.relayToken.host;
    if (resolved.relayToken.login) env.OK_GH_TOKEN_LOGIN = resolved.relayToken.login;
    else delete env.OK_GH_TOKEN_LOGIN;
  } else {
    delete env.OK_GH_TOKEN;
    delete env.OK_GH_TOKEN_HOST;
    delete env.OK_GH_TOKEN_LOGIN;
  }
  return env;
}

/**
 * The argv that re-execs THIS CLI, used to build the self-referential git
 * credential helper (`!<argv> auth git-credential`). `[execPath, cliEntry]`:
 * under the packaged `ok.sh` wrapper this resolves to `[<Electron>, <cli.mjs>]`
 * with `ELECTRON_RUN_AS_NODE=1` inherited via `buildCloneEnv` — the same
 * Electron-as-Node re-invocation the sync path uses — so git can actually run
 * the helper, unlike a bare `open-knowledge` that isn't on its subprocess PATH.
 * `argv` / `execPath` are injectable for tests.
 */
export function resolveSelfCliArgs(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): string[] {
  const entry = argv[1];
  return entry ? [execPath, entry] : [execPath];
}

/**
 * Compose the `git clone` arg vector for `simple-git`'s `git.clone(url, dir, args)`.
 *
 * Empty / nullish branch collapses to the legacy `['--progress']` form so callers
 * that thread a missing field through (e.g. JSON body omits `branch`) keep the
 * default-branch behavior. Slashed branches like `feat/foo` are passed verbatim;
 * `git` resolves them against `refs/heads/<branch>`.
 */
export function buildCloneArgs(branch: string | null | undefined): string[] {
  if (typeof branch !== 'string' || branch.length === 0) return ['--progress'];
  return ['--progress', '-b', branch];
}

/**
 * Classify a clone failure as "remote branch missing upstream" vs any other
 * error class. simple-git wraps the child process and surfaces git's stderr in
 * the thrown `Error.message`; matching on the message is intentional. Other
 * failure shapes (auth, network, fs) must NOT be classified as branch-missing
 * — those errors are re-thrown so the existing error handling stays in place.
 *
 * Thin re-export of `isBranchNotFoundGitError` from `@inkeep/open-knowledge-core`
 * — see that function for the canonical pattern (covers both
 * "Remote branch X not found" and "couldn't find remote ref" variants).
 */
export const isBranchNotFoundError = isBranchNotFoundGitError;

/**
 * Run a clone with optional `-b <branch>` and a fallback to the default branch
 * when the branch isn't on the remote. On fallback, emits `branch-fallback`
 * BEFORE the retry so JSONL consumers see what was attempted. Non-
 * branch-missing errors (auth, network, fs) propagate as-is.
 */
export async function cloneWithBranchFallback(opts: {
  branch: string | null;
  clone: (args: string[]) => Promise<unknown>;
  onFallback: (branch: string) => void;
}): Promise<{ fellBack: boolean }> {
  try {
    await opts.clone(buildCloneArgs(opts.branch));
    return { fellBack: false };
  } catch (err) {
    if (opts.branch !== null && isBranchNotFoundError(err)) {
      opts.onFallback(opts.branch);
      await opts.clone(buildCloneArgs(null));
      return { fellBack: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Core clone logic
// ---------------------------------------------------------------------------

interface CloneOptions {
  json: boolean;
  dir?: string;
  /**
   * Optional ref to clone with `-b <branch>`. When the branch doesn't exist
   * upstream, falls back to the remote default branch and emits a
   * `branch-fallback` event before the retry so JSONL consumers can surface
   * a toast.
   */
  branch?: string | null;
  /**
   * Observes which auth the clone actually resolved: the tier plus the login
   * that produced the credential, when known. The failure path reads this to
   * name the identity used — re-resolving there could disagree with the
   * resolution the clone ran with. `login` deliberately mirrors
   * `RelayGhToken.login` (the resolved, post-fallback account), which is why
   * it isn't spelled `resolvedLogin` here.
   */
  onAuthResolved?: (info: { tier: ResolvedAuth['tier']; login?: string }) => void;
  /**
   * gh detector, injectable so a test can drive the tier-A resolution (and the
   * declared-account miss that rides on it) without a real `gh`. Same seam
   * `resolveCloneAuth` already exposes; threaded here because the warning it
   * produces is emitted by this function, not by the resolver.
   */
  _detectGhFn?: (host?: string, options?: { login?: string }) => GhDetectResult;
}

type CredentialHelperUnsafeGitOptions = SimpleGitOptions & {
  unsafe?: NonNullable<SimpleGitOptions['unsafe']> & {
    allowUnsafeCredentialHelper?: boolean;
    allowUnsafePager?: boolean;
    allowUnsafeSshCommand?: boolean;
    allowUnsafeAskPass?: boolean;
    allowUnsafeEditor?: boolean;
  };
};

/**
 * Build the simple-git options for a clone. `ok clone` is a foreground command
 * running git as the user with the user's own environment (`buildCloneEnv`
 * spreads `process.env`), so we opt into the env-based `unsafe` flags simple-git
 * gates by default: it refuses to run when PAGER / GIT_SSH_COMMAND / GIT_ASKPASS
 * / EDITOR / GIT_EDITOR are present in the env unless told they're trusted. That
 * guard targets untrusted config/args in server-side usage; here the env IS the
 * user's own interactive shell, so honoring it is correct — and lets their
 * pager, SSH config, and credential-prompt helper actually work (an attacker who
 * can set these env vars already owns the shell). `allowUnsafeCredentialHelper`
 * is the same posture for the `-c credential.helper` we inject.
 *
 * `allowUnsafeEditor` is load-bearing for the common case: nearly every
 * developer has EDITOR (and often GIT_EDITOR) exported, and the guard fires on
 * the var's mere presence regardless of value — so without this flag, clone
 * fails with `Use of "EDITOR" is not permitted…` for most users. A clone never
 * launches an editor anyway, so honoring the env is safe. simple-git 3.36's
 * published typings don't expose these runtime flags, hence the local type.
 */
export function buildCloneGitOptions(
  cwd: string,
  gitConfig: string[],
): Partial<CredentialHelperUnsafeGitOptions> {
  return {
    baseDir: cwd,
    config: gitConfig,
    unsafe: {
      allowUnsafeCredentialHelper: true,
      allowUnsafePager: true,
      allowUnsafeSshCommand: true,
      allowUnsafeAskPass: true,
      allowUnsafeEditor: true,
    },
  };
}

/**
 * Whether the share-link clone path should skip credential injection.
 *
 * Hostname check is exact equality (`=== 'github.com'`), NOT `endsWith` or
 * subdomain-loose. GHES has a different auth posture (often no anonymous
 * read; api base lives at `https://<host>/api/v3`, not `api.github.com`), so
 * the public-repo probe doesn't apply there and authenticated clone is the
 * correct default. SSH falls through to the authenticated path so SSH key
 * material stays in play.
 */
export function shouldSkipAuthForPublicRepo(
  protocol: string,
  hostname: string,
  isPublic: boolean,
): boolean {
  return protocol === 'https' && hostname === 'github.com' && isPublic;
}

/**
 * Resolve the auth for a clone as one step: the account the URL (or the
 * user's own git config) declares, then the token for that account. The
 * declared login rides into `gh auth token --user <login>`, so cloning
 * `https://alice@github.com/o/r` authenticates as alice regardless of which
 * gh account is active; a login gh cannot serve falls back to the active
 * account inside `detectGh`, never to `tier: 'none'`. This is the only path
 * that builds a clone's `ResolvedAuth`, keeping account resolution and token
 * resolution one operation — the identity the clone authenticates as is the
 * identity the post-clone sync engine resolves from the same stored URL.
 *
 * The hostname for gh's `--hostname` scope is derived from `cloneUrl` here
 * rather than accepted from the caller: two sources for the same fact is how
 * a clone and its later sync end up authenticating differently.
 */
export interface CloneAuthResolution {
  auth: ResolvedAuth;
  /**
   * Set when the URL (or the user's git config) declared an account and the
   * gh resolution did not produce that account's token — the fallback rescued
   * the clone with the active account instead. Only the gh tier can prove the
   * miss: a stored-token or credential-less resolution doesn't say which
   * account will answer the credential request, and claiming a miss there
   * could be false, so those tiers stay silent. The caller decides how to
   * surface it (stderr on the human path; the machine path's trace is the
   * sync engine's own fallback warning once the project opens).
   */
  declaredMiss?: {
    declaredLogin: string;
    declaredSource: Exclude<GitHubAccountSource, 'active'>;
  };
}

/**
 * The stderr line warning that a declared account did not answer, or `null`
 * when there is nothing to say. Pure so the wording and the mechanism
 * mapping are testable without driving a real clone; the `--json` gate lives
 * at the call site, matching the sibling stderr writes in `runClone`.
 *
 * Human channel only: stdout is the machine wire under `--json`, and that
 * flow's trace is the sync engine's own fallback warning once the cloned
 * project is opened.
 *
 * The copy asserts only what this process can prove. A fallback means gh did
 * not confirm the requested account — it does NOT prove another account
 * answered: gh older than 2.40 rejects `--user` outright, and a casing-only
 * difference falls back by design, so in both cases the token may well be the
 * declared person's. Naming the GitHub CLI is safe here (unlike the app's
 * wire copy, which cannot know the tier) because only the gh tier reports a
 * miss at all.
 */
export function formatDeclaredMissWarning(
  miss: CloneAuthResolution['declaredMiss'],
): string | null {
  if (miss === undefined) return null;
  const { declaredLogin, declaredSource } = miss;
  // Exhaustive per source rather than a binary ternary: a source added later
  // must land on the neutral wording, never silently borrow another
  // mechanism's sentence.
  let mechanism: string;
  switch (declaredSource) {
    case 'remote-url':
      mechanism = `The clone URL names ${declaredLogin}`;
      break;
    case 'credential-config':
      mechanism = `Your Git credential configuration names ${declaredLogin}`;
      break;
    default:
      mechanism = `Your Git configuration names ${declaredLogin}`;
  }
  // Names the one command that settles it. The process cannot name the
  // answering account itself without a `detectGhAccounts` spawn this path
  // deliberately avoids, and the two benign causes (gh below the 2.40
  // `--user` floor, a casing-only declaration) are indistinguishable here —
  // so hand the user a check rather than a verdict they cannot falsify.
  return (
    `⚠ ${mechanism}, but the GitHub CLI couldn't confirm that account — the clone used its active account.\n` +
    `  Run \`gh auth status\` to see which account that is. If ${declaredLogin} is listed as active, nothing is wrong; confirming an account by name needs GitHub CLI 2.40 or newer.\n`
  );
}

export async function resolveCloneAuth(
  cloneUrl: string,
  tokenStore: TokenStore,
  options: {
    selfCliArgs?: readonly string[];
    /**
     * Directory the `credential.<url>.*` lookup runs in, defaulting to the
     * process cwd. Every scope git resolves from there applies, including the
     * local scope of an enclosing repository — `ok clone` run from inside
     * another checkout inherits that checkout's entries. That is git's own
     * rule (a plain `git clone` from the same directory resolves
     * identically), but it means this tier can name a different account
     * pre-clone than the sync path later resolves from the cloned project's
     * own directory. The URL's userinfo outranks this tier and survives into
     * `.git/config`, so a URL-declared account cannot diverge that way.
     */
    cwd?: string;
    _detectGhFn?: (host?: string, options?: { login?: string }) => GhDetectResult;
    _readCredentialUrlMatch?: CredentialUrlMatchReader;
  } = {},
): Promise<CloneAuthResolution> {
  const parsed = parseGitUrl(cloneUrl);
  if (!parsed) {
    // Password-stripped: an unparseable input can still carry an embedded
    // credential, and this message reaches the terminal.
    throw new Error(`Invalid git URL: ${stripUrlPassword(cloneUrl)}`);
  }
  const account = resolveGitHubAccountFromUrl(cloneUrl, {
    cwd: options.cwd,
    _readCredentialUrlMatch: options._readCredentialUrlMatch,
  });
  // The account resolver's host when it parsed one, the CLI parse otherwise:
  // the resolver normalizes (lowercase, www-fold) the same way the post-clone
  // sync path does, so `gh --hostname`, the relay's host guard, and the sync
  // engine all speak one host spelling for one remote.
  const auth = await resolveAuth(
    account.host ?? parsed.hostname,
    tokenStore,
    { selfCliArgs: options.selfCliArgs, login: account.login },
    options._detectGhFn,
  );
  // A gh-tier token that the declared account didn't produce is a proven
  // fallback (a relayed token always names its account when the request was
  // honored). See CloneAuthResolution for why other tiers never report one.
  const declaredMiss =
    account.login !== undefined &&
    auth.tier === 'A' &&
    !sameGitHubLogin(auth.relayToken?.login, account.login)
      ? { declaredLogin: account.login, declaredSource: account.source }
      : undefined;
  return { auth, ...(declaredMiss !== undefined ? { declaredMiss } : {}) };
}

/**
 * `parseGitUrl` accepts `owner/repo` shorthand, but git itself treats a bare
 * `owner/repo` as a local filesystem path and never contacts GitHub (no
 * `insteadOf` rewrite exists in a standard environment). Reconstruct the
 * canonical https URL for the shorthand case so `ok clone owner/repo` (and the
 * splash command that copies it) actually clones. Full URLs and SSH/SCP forms
 * pass through unchanged.
 */
export function resolveCloneUrl(
  rawUrl: string,
  parsed: { hostname: string; owner: string; name: string },
): string {
  // Detect shorthand structurally — the raw input IS exactly `owner/repo` (with
  // an optional `.git`) — rather than by metacharacter absence: an `@`-less
  // SCP/GHES URL like `host.ghe.com:owner/repo.git` also lacks `://`/`@`/leading
  // `/` but must keep its SSH transport, not be rewritten to https.
  const ownerRepo = `${parsed.owner}/${parsed.name}`;
  const isShorthand = rawUrl === ownerRepo || rawUrl === `${ownerRepo}.git`;
  return isShorthand ? `https://${parsed.hostname}/${ownerRepo}` : rawUrl;
}

// Exported for the git-preflight test (asserts runClone rejects with the typed
// error when git is unusable) — mirrors how init.test.ts drives runInit.
export async function runClone(
  url: string,
  opts: CloneOptions,
  _config: Config,
  cwd = process.cwd(),
): Promise<string> {
  const parsed = parseGitUrl(url);
  if (!parsed) {
    throw new Error(`Invalid git URL: ${stripUrlPassword(url)}`);
  }
  const cloneUrl = resolveCloneUrl(url, parsed);

  const targetDir = opts.dir ? resolve(cwd, opts.dir) : resolve(cwd, parsed.name);

  // Reject non-empty directories
  if (existsSync(targetDir)) {
    const entries = readdirSync(targetDir);
    if (entries.length > 0) {
      throw new Error(`Target directory is not empty: ${targetDir}`);
    }
  }

  // Git preflight: verify git is usable BEFORE simple-git's `git.clone()` runs,
  // so a broken or missing git surfaces the recoverable typed preflight error
  // (carrying install guidance) instead of a raw simple-git clone error. The
  // typed error propagates to the command action, which maps it to EX_CONFIG
  // (78) — do NOT catch it here.
  //
  // Preflight only: we deliberately do NOT thread the resolved git path or
  // PATH-enrichment into simple-git. `ok clone` is a foreground command that
  // inherits the user's own shell PATH, so the binary we check is the binary
  // simple-git uses (no check/use divergence like the Electron-PATH-blind
  // server spines have); and simple-git's `customBinary` rejects spaced Windows
  // paths (`C:\Program Files\Git\cmd\git.exe`), so threading a binary would
  // regress the cross-platform CLI on Windows. The preflight alone closes the gap.
  assertGitAvailable();

  // Lazy token store — defers `@napi-rs/keyring` native binding init until
  // the first `.get()` call. For users with `gh` installed, `resolveAuth`
  // early-returns on Tier A and never touches the store, so we never pay
  // the keyring-init cost. Without this, clone-from-share-link beachballs
  // the Electron host on the first invocation per session while the
  // native binding loads (~seconds on cold macOS Keychain access).
  const tokenStore = makeLazyTokenStore();

  // Share-link clones inject the recipient's stored token via the credential
  // helper, which 404s ("Repository not found") when that token is a
  // fine-grained PAT or org-restricted token without scope for the source
  // namespace — even for genuinely public repos. Probe public visibility
  // first on github.com so the auth header is omitted entirely for the
  // anonymous case. Best-effort: any failure falls through to the
  // authenticated path.
  // Short-circuit the probe for protocols / hostnames we know `shouldSkipAuthForPublicRepo`
  // will reject — SSH, git protocol, and GHES never opt into the anonymous path, so
  // there's no point paying the up-to-5s network round-trip just to discard the result.
  const shouldProbe = parsed.protocol === 'https' && parsed.hostname === 'github.com';
  const isPublic = shouldProbe ? await isGitHubRepoPublic(parsed.owner, parsed.name) : false;
  const resolution: CloneAuthResolution = shouldSkipAuthForPublicRepo(
    parsed.protocol,
    parsed.hostname,
    isPublic,
  )
    ? { auth: { tier: 'none', gitConfig: [] } }
    : await resolveCloneAuth(cloneUrl, tokenStore, {
        selfCliArgs: resolveSelfCliArgs(),
        cwd,
        ...(opts._detectGhFn ? { _detectGhFn: opts._detectGhFn } : {}),
      });
  const resolved: ResolvedAuth = resolution.auth;
  opts.onAuthResolved?.({ tier: resolved.tier, login: resolved.relayToken?.login });
  // Gate at the call site, like the sibling stderr writes below. The
  // visibility probe short-circuits for any non-github.com host, so a test
  // can reach this with an injected detector and a loopback URL.
  if (!opts.json) {
    const declaredMissWarning = formatDeclaredMissWarning(resolution.declaredMiss);
    if (declaredMissWarning) process.stderr.write(declaredMissWarning);
  }

  const env = buildCloneAuthEnv(resolved);

  const gitOptions = buildCloneGitOptions(cwd, resolved.gitConfig);
  const git = simpleGit(gitOptions as Partial<SimpleGitOptions>).env(env);

  let lastPct = -1;

  git.outputHandler((_cmd, _stdout, stderr) => {
    stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const line of text.split('\n')) {
        const prog = parseProgressLine(line);
        if (prog && prog.pct !== lastPct) {
          lastPct = prog.pct;
          emit(opts.json, { type: 'progress', pct: prog.pct, stage: prog.stage });
          if (!opts.json) {
            process.stderr.write(`\r  Cloning ${prog.pct}%`);
          }
        }
      }
    });
  });

  const requestedBranch =
    typeof opts.branch === 'string' && opts.branch.length > 0 ? opts.branch : null;
  await cloneWithBranchFallback({
    branch: requestedBranch,
    clone: (args) => git.clone(cloneUrl, targetDir, args),
    onFallback: (branch) => {
      emit(opts.json, { type: 'branch-fallback', branch });
      if (!opts.json) {
        process.stderr.write(
          `\n  Branch '${branch}' not found upstream — cloning default branch instead.\n`,
        );
      }
    },
  });

  if (!opts.json) process.stderr.write('\n');

  // Auto-init: scaffold .ok/ unconditionally. `runInit` is idempotent
  // via per-file `writeIfMissing`, so it backfills a missing `.gitignore` even
  // when upstream committed `.ok/config.yml` without one.
  try {
    const { runInit } = await import('./init.ts');
    const initResult = await runInit({ cwd: targetDir, mcp: false });
    // Surface the `updated` classification so silent mutation of an
    // upstream-tracked .ok/.gitignore doesn't hide behind ✓ Cloned.
    if (initResult.contentUpdated.length > 0) {
      const msg = `auto-init: updated ${initResult.contentUpdated.join(', ')}`;
      if (opts.json) emit(true, { type: 'warning', message: msg });
      else process.stderr.write(`  ${msg}\n`);
    }
  } catch (err) {
    // Non-fatal — surface a warning so silent failures don't hide behind
    // the ✓ Cloned banner. Same posture as start.ts auto-init.
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) emit(true, { type: 'warning', message: `auto-init: ${msg}` });
    else process.stderr.write(`  auto-init: ${msg}\n`);
  }

  // Per-clone protection from upstream pollution: append `.ok/` to
  // the cloned repo's `.git/info/exclude`. That file is per-clone and never
  // committed, so OK state can't accidentally land in someone else's tree from
  // a stray `git add .`. Symmetric with `ok init`'s stance — `init` is the
  // user's own project (config.yml is meant to be tracked, no exclude needed).
  try {
    ensureOkExcludedFromGit(targetDir);
  } catch (err) {
    // Non-fatal — best-effort
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) emit(true, { type: 'warning', message: `git-exclude: ${msg}` });
    else process.stderr.write(`  git-exclude: ${msg}\n`);
  }

  return targetDir;
}

/**
 * Append `${OK_DIR}/` to the cloned repo's `.git/info/exclude` so the outer
 * git ignores OK state without mutating any tracked file. Thin wrapper over
 * `addOkPathsToGitExclude(_, [`${OK_DIR}/`])` from `../sharing/git-exclude.ts`
 * — that module owns variant matching, worktree-pointer resolution, and the
 * tracked-files refusal probe.
 *
 * Behavior contract: this is the per-clone protection guardrail, independent
 * of user-chosen sharing mode. Clone-time we append `.ok/` only when none of
 * that tree is already tracked upstream; tracked `.ok` artifacts make the
 * shared intent authoritative and the exclusion write refuses atomically.
 * Sharing-mode toggles can add MORE paths on top later. The shared writer also
 * resolves linked-worktree gitdir pointers; a hard-coded
 * `<projectDir>/.git/info/exclude` is invalid when `.git` is a pointer file.
 *
 * The legacy three-state return is preserved — callers branch on it for
 * stderr / JSON disclosure. The new module reports per-path classification
 * (`appended[]` / `alreadyPresent[]`) which the wrapper collapses to one of
 * the three legacy strings:
 *
 *   - `appended`: at least one path was appended (here only `.ok/`).
 *   - `already-present`: every path was already in the exclude file.
 *   - `no-exclude`: the gitdir was unresolvable (`no-git`,
 *     `malformed-pointer`, `inaccessible`) OR the resolved gitdir has no
 *     `info/` subdir (`no-info-dir`).
 *
 * `TrackedRefusal` is expected when the upstream already shares any `.ok`
 * artifact. The wrapper preserves its legacy return type by collapsing that
 * refusal to `already-present`; no exclusion was written, and the upstream's
 * tracked sharing posture remains intact.
 */
export function ensureOkExcludedFromGit(
  projectDir: string,
): 'appended' | 'already-present' | 'no-exclude' {
  const result = addOkPathsToGitExclude(projectDir, [`${OK_DIR}/`]);
  if (result.kind === 'no-exclude') return 'no-exclude';
  if (result.kind === 'refused-tracked') return 'already-present';
  if (result.appended.length > 0) return 'appended';
  return 'already-present';
}

// ---------------------------------------------------------------------------
// Actionable auth-failure messaging
// ---------------------------------------------------------------------------

const SHELL_SAFE_TOKEN = /^[A-Za-z0-9._/:@-]+$/;

/**
 * Drop every credential a URL's userinfo can carry before it is echoed. The
 * `:password` half always goes, and the username half goes too when it is
 * itself credential-shaped — GitHub's canonical PAT-in-URL form is
 * `https://<token>@github.com/o/r`, so only a login-shaped username (the
 * user's identity declaration) survives into the message and the suggested
 * `ok clone` re-run, which then still authenticates as the same account.
 */
function stripUrlPassword(url: string): string {
  // Userinfo is matched greedily up to the LAST `@` before the path, so a
  // password containing `@` (`user:p@ss@host`) is stripped whole. The class
  // deliberately does NOT exclude whitespace, unlike the share-publish
  // redactor: that one scans free-form multi-line stderr with /g, where a
  // span crossing whitespace would swallow unrelated prose. This one is
  // `^`-anchored on a single URL argument, so it cannot over-reach — and
  // excluding `\s` here makes the match FAIL OUTRIGHT on a userinfo
  // containing a space (`https://foo bar:<token>@host`), echoing the
  // credential whole instead of stripping it.
  return url.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)@/i,
    (_whole, scheme: string, userinfo: string) => {
      const colon = userinfo.indexOf(':');
      const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
      return user !== '' && loginShapedUserinfoUser(user) !== undefined
        ? `${scheme}${user}@`
        : scheme;
    },
  );
}

// `shellSingleQuote` is the canonical, test-covered POSIX quoter from core;
// `quoteIfNeeded` stays clone-local (it's not duplicated in core) and defers
// to the canonical quoter for the unsafe case.
function quoteIfNeeded(s: string): string {
  return SHELL_SAFE_TOKEN.test(s) ? s : shellSingleQuote(s);
}

function reconstructCloneCommand(url: string, branch: string | null | undefined): string {
  const branchSuffix =
    typeof branch === 'string' && branch.length > 0 ? ` -b ${quoteIfNeeded(branch)}` : '';
  return `ok clone ${quoteIfNeeded(url)}${branchSuffix}`;
}

/**
 * Build the human-readable, actionable message for a clone auth failure, OR
 * return `null` when the failure isn't auth (caller falls through to the raw
 * git error). Pure — no process/stdout access — so it's unit-testable with
 * synthetic errors.
 */
export function formatCloneAuthFailure(opts: {
  error: unknown;
  url: string;
  branch?: string | null;
  /** Optional GitHub login for the 403 "signed in as @X" hint. */
  principal?: string | null;
  /**
   * The login that actually produced the credential the clone ran with, when
   * known. Appended to the 404 masquerade so the user can spot a
   * wrong-account mismatch themselves; omitted when unknown — the message
   * degrades, it never guesses. Named like the wire and server fields for
   * the same fact: resolved (what answered), in opposition to declared.
   */
  resolvedLogin?: string | null;
}): string | null {
  const classified: ClassifiedGitAuthError = classifyGitAuthError(opts.error);
  if (classified.kind !== 'auth') return null;

  // Every echo of the clone URL — including the copy-pasteable re-run
  // command — drops the password half. The username stays so the suggested
  // re-run keeps the user's identity declaration.
  const displayUrl = stripUrlPassword(opts.url);

  if (isLoginFixableGitAuthError(classified)) {
    const reRun = reconstructCloneCommand(displayUrl, opts.branch);
    return [
      `✗ Couldn't clone ${displayUrl} — authentication is required.`,
      '',
      '  To fix:',
      '    1. Run: ok auth login',
      `    2. Then re-run: ${reRun}`,
    ].join('\n');
  }

  if (classified.subclass === '403') {
    const principalHint =
      typeof opts.principal === 'string' && opts.principal.length > 0
        ? ` (signed in as @${opts.principal} — may lack access)`
        : '';
    return `✗ Access denied when cloning ${displayUrl}${principalHint}. Check that your account has access to the repository.`;
  }

  if (classified.subclass === 'ssh-auth') {
    return `✗ Couldn't clone ${displayUrl} over SSH — authentication failed. Check that your SSH key is added to your GitHub account and the host key is trusted, or clone the HTTPS URL instead.`;
  }

  // GitHub's 404 masquerade: "not found" covers both a missing repo and a
  // private repo the credential used can't see, so the copy asserts both and
  // prescribes no recovery command — re-login mints the same account's
  // credential, and scopes are not the problem. The identity sentence uses
  // only the login threaded from the resolution the clone actually ran with;
  // the stored-token principal is never consulted here, since it could name
  // an account the clone never used.
  if (classified.subclass === 'not-found-as-identity') {
    const identity =
      typeof opts.resolvedLogin === 'string' && opts.resolvedLogin.length > 0
        ? ` Authenticated as ${opts.resolvedLogin}.`
        : '';
    return `✗ Repository not found when cloning ${displayUrl}. It may not exist, or the account used may not have access.${identity}`;
  }

  // scope-mismatch. `ok auth login` mints a fixed device-flow scope set that
  // can't gain `repo`, so the recovery is a PAT (via `ok auth pat`), then re-run.
  return [
    '✗ Your GitHub token is missing required OAuth scopes — likely the `repo` scope.',
    '',
    '  To fix:',
    '    1. Create a token with `repo` scope at https://github.com/settings/tokens',
    '    2. Run: ok auth pat',
    `    3. Then re-run: ${reconstructCloneCommand(displayUrl, opts.branch)}`,
  ].join('\n');
}

/**
 * Side-effecting wrapper that routes a clone failure to the correct channel.
 * `--json` always emits the existing `{type:'error', message}` wire shape —
 * desktop/server `runCloneSubprocess` consumers see no behavior change. In
 * interactive mode, an auth failure becomes an actionable instruction; non-
 * auth errors fall through to the today's `✗ <message>` line.
 *
 * The raw message is credential-redacted BEFORE the channel branch: both the
 * `--json` event (rendered verbatim in the desktop clone toast — the IPC
 * path has no redacting hop of its own) and the interactive fallback line
 * can otherwise echo a token, since git's disabled-prompt failure quotes the
 * URL's username half (`could not read Password for 'https://<pat>@…'`),
 * which is where a bare PAT lives. Classification still reads the
 * unredacted error — patterns may match the very bytes redaction strips.
 *
 * Dependencies are injected so tests can drive both branches without
 * touching `process.stdout` / `process.stderr`.
 */
export function emitCloneFailure(opts: {
  error: unknown;
  url: string;
  branch?: string | null;
  json: boolean;
  emit: (event: Record<string, unknown>) => void;
  printStderr: (text: string) => void;
  principal?: string | null;
  resolvedLogin?: string | null;
}): void {
  const rawMessage = redactShareSubprocessStderr(
    opts.error instanceof Error ? opts.error.message : String(opts.error),
  );
  if (opts.json) {
    opts.emit({ type: 'error', message: rawMessage });
    return;
  }
  const actionable = formatCloneAuthFailure({
    error: opts.error,
    url: opts.url,
    branch: opts.branch,
    principal: opts.principal,
    resolvedLogin: opts.resolvedLogin,
  });
  opts.printStderr(`${actionable ?? `✗ ${rawMessage}`}\n`);
}

/**
 * Best-effort principal lookup for the 403 access-denied hint. Reads the GitHub
 * login stored by `ok auth login` / `ok auth pat` from the local token store;
 * returns null when nothing usable is stored, so the hint is omitted rather than
 * showing a placeholder. No network call.
 */
export async function resolveClonePrincipal(
  tokenStore: TokenStore,
  host: string,
): Promise<string | null> {
  const entry = await tokenStore.get(host);
  const login = entry?.login;
  return login && login !== 'unknown' ? login : null;
}

/**
 * Route a clone failure to the right channel. The identity in hand is
 * authoritative: with a gh-resolved credential the 403 hint names that login
 * or nothing, and a `tier: 'none'` clone presented no credential at all, so
 * its hint names nobody — the stored-token principal is consulted only when
 * the credential could have come from the store (store tiers, or a caller
 * that didn't observe the resolution). The hint can therefore never
 * attribute the failure to an account the clone didn't use. Only an
 * interactive 403 without gh auth resolves the stored login, so other failure
 * paths (and the `--json` machine path) skip the lazy keyring init.
 * `resolvePrincipal` is injectable so the guard is unit-testable without a
 * real keyring or git.
 */
export async function handleCloneFailure(opts: {
  error: unknown;
  url: string;
  branch: string | null;
  json: boolean;
  emit: (event: Record<string, unknown>) => void;
  printStderr: (text: string) => void;
  resolvePrincipal?: (host: string) => Promise<string | null>;
  /** The auth the clone actually resolved, observed via `onAuthResolved`. */
  auth?: { tier: ResolvedAuth['tier']; login?: string };
}): Promise<void> {
  const classified = classifyGitAuthError(opts.error);
  const ghAuth = opts.auth?.tier === 'A' ? opts.auth : undefined;
  let principal: string | null = null;
  if (!opts.json && classified.kind === 'auth' && classified.subclass === '403') {
    if (ghAuth) {
      principal = ghAuth.login ?? null;
    } else if (opts.auth?.tier !== 'none') {
      // Skipped for a known credential-less clone: a 403 there (e.g. rate
      // limiting) authenticated as nobody, and "signed in as @X" would blame
      // an account the request never carried.
      const target = parseGitUrl(opts.url);
      if (target) {
        const resolve =
          opts.resolvePrincipal ?? ((host) => resolveClonePrincipal(makeLazyTokenStore(), host));
        principal = await resolve(target.hostname);
      }
    }
  }
  emitCloneFailure({
    error: opts.error,
    url: opts.url,
    branch: opts.branch,
    json: opts.json,
    principal,
    resolvedLogin: ghAuth?.login ?? null,
    emit: opts.emit,
    printStderr: opts.printStderr,
  });
}

// ---------------------------------------------------------------------------
// Commander command
// ---------------------------------------------------------------------------

export function cloneCommand(getConfig: () => Config): Command {
  return new Command('clone')
    .description('Clone a git repository and open it')
    .argument('<url>', 'Repository URL or owner/repo shorthand')
    .argument('[dir]', 'Target directory (default: ./<repo-name>)')
    .option('--json', 'Output JSONL progress events', false)
    .option('-b, --branch <branch>', 'Branch to check out (falls back to default if missing)')
    .action(
      async (url: string, dir: string | undefined, opts: { json: boolean; branch?: string }) => {
        const config = getConfig();
        let authInfo: { tier: ResolvedAuth['tier']; login?: string } | undefined;
        try {
          const targetDir = await runClone(
            url,
            {
              json: opts.json,
              dir,
              branch: opts.branch ?? null,
              onAuthResolved: (info) => {
                authInfo = info;
              },
            },
            config,
          );
          if (opts.json) {
            emit(true, { type: 'complete', dir: targetDir });
          } else {
            process.stderr.write(`✓ Cloned to ${targetDir}\n`);
            // Chain into start — change to the cloned dir and launch
            process.chdir(targetDir);
            const { startCommand } = await import('./start.ts');
            const startCmd = startCommand(getConfig);
            await startCmd.parseAsync([], { from: 'user' });
          }
        } catch (err) {
          // A missing or too-old git from the preflight is a recoverable, typed
          // condition carrying multi-paragraph install guidance. Surface that
          // message cleanly — mirroring `ok init`'s early-return stderr write —
          // rather than letting `handleCloneFailure` prefix it with the non-auth
          // `✗ ` fallback. `--json` still emits the existing error event so the
          // desktop-spawned wire shape is preserved. Exits EX_CONFIG (78), the
          // same stable scriptable signal `ok init` / `ok start` use for this case.
          if (err instanceof GitNotAvailableError || err instanceof GitTooOldError) {
            if (opts.json) {
              emit(true, { type: 'error', message: err.message });
            } else {
              process.stderr.write(`${err.message}\n`);
            }
            process.exitCode = 78;
            return;
          }
          await handleCloneFailure({
            error: err,
            url,
            branch: opts.branch ?? null,
            json: opts.json,
            auth: authInfo,
            emit: (event) => emit(true, event),
            printStderr: (text) => process.stderr.write(text),
          });
          // Don't call process.exit — it can truncate a buffered stdout pipe
          // before the final JSON line is flushed. Set exitCode and return so
          // Node drains stdout naturally before the process exits.
          process.exitCode = 1;
        }
      },
    );
}
