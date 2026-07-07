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
  GitNotAvailableError,
  GitTooOldError,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import simpleGit, { type SimpleGitOptions } from 'simple-git';
import { resolveAuth } from '../auth/resolve-auth.ts';
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
 * user's own shell context, so the Tier-A `gh` credential helper needs the real
 * PATH (to find `gh`, often Homebrew-only at /opt/homebrew/bin) and HOME (so
 * `gh` and git locate their config). simple-git's `.env()` REPLACES the child
 * env, so we must spread the source env rather than pass a bare object — the
 * earlier `{ GIT_TERMINAL_PROMPT: '0' }`-only form silently stripped both,
 * masking Tier A on stock installs (it only appeared to work where a leftover
 * osxkeychain credential answered first).
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
}

type CredentialHelperUnsafeGitOptions = SimpleGitOptions & {
  unsafe?: NonNullable<SimpleGitOptions['unsafe']> & {
    allowUnsafeCredentialHelper?: boolean;
    allowUnsafePager?: boolean;
    allowUnsafeSshCommand?: boolean;
    allowUnsafeAskPass?: boolean;
  };
};

/**
 * Build the simple-git options for a clone. `ok clone` is a foreground command
 * running git as the user with the user's own environment (`buildCloneEnv`
 * spreads `process.env`), so we opt into the env-based `unsafe` flags simple-git
 * gates by default: it refuses to run when PAGER / GIT_SSH_COMMAND / GIT_ASKPASS
 * are present in the env unless told they're trusted. That guard targets
 * untrusted config/args in server-side usage; here the env IS the user's own
 * interactive shell, so honoring it is correct — and lets their pager, SSH
 * config, and credential-prompt helper actually work (an attacker who can set
 * these env vars already owns the shell). `allowUnsafeCredentialHelper` is the
 * same posture for the `-c credential.helper` we inject. simple-git 3.36's
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
    throw new Error(`Invalid git URL: ${url}`);
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
  const resolved = shouldSkipAuthForPublicRepo(parsed.protocol, parsed.hostname, isPublic)
    ? { tier: 'none' as const, credentialArgs: [] as string[] }
    : await resolveAuth(parsed.hostname, tokenStore, {});

  // Inherit the user's env (PATH/HOME for the gh helper) with our fixed
  // overrides — see buildCloneEnv for the env-replacement rationale.
  const env = buildCloneEnv();

  // Build -c credential.helper config if needed
  const gitConfig = resolved.credentialArgs.length >= 2 ? [resolved.credentialArgs[1]] : [];

  const gitOptions = buildCloneGitOptions(cwd, gitConfig);
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
 * of user-chosen sharing mode. Clone-time we always append `.ok/`; sharing-mode toggles can add
 * MORE paths on top later. Migration onto the new module also fixes a worktree-
 * blind bug: clones inside a linked worktree previously wrote nothing because
 * the hard-coded `<projectDir>/.git/info/exclude` doesn't exist when `.git`
 * is a pointer file.
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
 * `TrackedRefusal` is unreachable here: `.ok/` is the OK-owned dir we just
 * created during auto-init; it cannot be tracked upstream at clone-time
 * because we just wrote it ourselves. The branch is defended against
 * defensively and collapsed to `no-exclude`-shaped output rather than
 * letting a typed refusal value leak out as an unhandled state.
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
}): string | null {
  const classified: ClassifiedGitAuthError = classifyGitAuthError(opts.error);
  if (classified.kind !== 'auth') return null;

  if (isLoginFixableGitAuthError(classified)) {
    const reRun = reconstructCloneCommand(opts.url, opts.branch);
    return [
      `✗ Couldn't clone ${opts.url} — authentication is required.`,
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
    return `✗ Access denied when cloning ${opts.url}${principalHint}. Check that your account has access to the repository.`;
  }

  if (classified.subclass === 'ssh-auth') {
    return `✗ Couldn't clone ${opts.url} over SSH — authentication failed. Check that your SSH key is added to your GitHub account and the host key is trusted, or clone the HTTPS URL instead.`;
  }

  // scope-mismatch. `ok auth login` mints a fixed device-flow scope set that
  // can't gain `repo`, so the recovery is a PAT (via `ok auth pat`), then re-run.
  return [
    '✗ Your GitHub token is missing required OAuth scopes — likely the `repo` scope.',
    '',
    '  To fix:',
    '    1. Create a token with `repo` scope at https://github.com/settings/tokens',
    '    2. Run: ok auth pat',
    `    3. Then re-run: ${reconstructCloneCommand(opts.url, opts.branch)}`,
  ].join('\n');
}

/**
 * Side-effecting wrapper that routes a clone failure to the correct channel.
 * `--json` always emits the existing `{type:'error', message}` wire shape —
 * desktop/server `runCloneSubprocess` consumers see no behavior change. In
 * interactive mode, an auth failure becomes an actionable instruction; non-
 * auth errors fall through to the today's `✗ <message>` line.
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
}): void {
  const rawMessage = opts.error instanceof Error ? opts.error.message : String(opts.error);
  if (opts.json) {
    opts.emit({ type: 'error', message: rawMessage });
    return;
  }
  const actionable = formatCloneAuthFailure({
    error: opts.error,
    url: opts.url,
    branch: opts.branch,
    principal: opts.principal,
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
 * Route a clone failure to the right channel. Only an interactive 403 consumes
 * the principal hint, so the stored login is resolved just for that case — other
 * failure paths (and the `--json` machine path) skip the lazy keyring init.
 * `resolvePrincipal` is injectable so the 403-only guard is unit-testable
 * without a real keyring or git.
 */
export async function handleCloneFailure(opts: {
  error: unknown;
  url: string;
  branch: string | null;
  json: boolean;
  emit: (event: Record<string, unknown>) => void;
  printStderr: (text: string) => void;
  resolvePrincipal?: (host: string) => Promise<string | null>;
}): Promise<void> {
  const classified = classifyGitAuthError(opts.error);
  let principal: string | null = null;
  if (!opts.json && classified.kind === 'auth' && classified.subclass === '403') {
    const target = parseGitUrl(opts.url);
    if (target) {
      const resolve =
        opts.resolvePrincipal ?? ((host) => resolveClonePrincipal(makeLazyTokenStore(), host));
      principal = await resolve(target.hostname);
    }
  }
  emitCloneFailure({
    error: opts.error,
    url: opts.url,
    branch: opts.branch,
    json: opts.json,
    principal,
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
        try {
          const targetDir = await runClone(
            url,
            { json: opts.json, dir, branch: opts.branch ?? null },
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
