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

const STAGE_RANGES: [string, number, number][] = [
  ['count', 0, 10],
  ['compress', 10, 20],
  ['receiv', 20, 60],
  ['resolv', 60, 100],
];

function parseProgressLine(line: string): { stage: string; pct: number } | null {
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

export function resolveSelfCliArgs(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): string[] {
  const entry = argv[1];
  return entry ? [execPath, entry] : [execPath];
}

export function buildCloneArgs(branch: string | null | undefined): string[] {
  if (typeof branch !== 'string' || branch.length === 0) return ['--progress'];
  return ['--progress', '-b', branch];
}

export const isBranchNotFoundError = isBranchNotFoundGitError;

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

interface CloneOptions {
  json: boolean;
  dir?: string;
  branch?: string | null;
  onAuthResolved?: (info: { tier: ResolvedAuth['tier']; login?: string }) => void;
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

export function shouldSkipAuthForPublicRepo(
  protocol: string,
  hostname: string,
  isPublic: boolean,
): boolean {
  return protocol === 'https' && hostname === 'github.com' && isPublic;
}

export interface CloneAuthResolution {
  auth: ResolvedAuth;
  declaredMiss?: {
    declaredLogin: string;
    declaredSource: Exclude<GitHubAccountSource, 'active'>;
  };
}

export function formatDeclaredMissWarning(
  miss: CloneAuthResolution['declaredMiss'],
): string | null {
  if (miss === undefined) return null;
  const { declaredLogin, declaredSource } = miss;
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
    cwd?: string;
    _detectGhFn?: (host?: string, options?: { login?: string }) => GhDetectResult;
    _readCredentialUrlMatch?: CredentialUrlMatchReader;
  } = {},
): Promise<CloneAuthResolution> {
  const parsed = parseGitUrl(cloneUrl);
  if (!parsed) {
    throw new Error(`Invalid git URL: ${stripUrlPassword(cloneUrl)}`);
  }
  const account = resolveGitHubAccountFromUrl(cloneUrl, {
    cwd: options.cwd,
    _readCredentialUrlMatch: options._readCredentialUrlMatch,
  });
  const auth = await resolveAuth(
    account.host ?? parsed.hostname,
    tokenStore,
    { selfCliArgs: options.selfCliArgs, login: account.login },
    options._detectGhFn,
  );
  const declaredMiss =
    account.login !== undefined &&
    auth.tier === 'A' &&
    !sameGitHubLogin(auth.relayToken?.login, account.login)
      ? { declaredLogin: account.login, declaredSource: account.source }
      : undefined;
  return { auth, ...(declaredMiss !== undefined ? { declaredMiss } : {}) };
}

export function resolveCloneUrl(
  rawUrl: string,
  parsed: { hostname: string; owner: string; name: string },
): string {
  const ownerRepo = `${parsed.owner}/${parsed.name}`;
  const isShorthand = rawUrl === ownerRepo || rawUrl === `${ownerRepo}.git`;
  return isShorthand ? `https://${parsed.hostname}/${ownerRepo}` : rawUrl;
}

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

  if (existsSync(targetDir)) {
    const entries = readdirSync(targetDir);
    if (entries.length > 0) {
      throw new Error(`Target directory is not empty: ${targetDir}`);
    }
  }

  assertGitAvailable();

  const tokenStore = makeLazyTokenStore();

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

  try {
    const { runInit } = await import('./init.ts');
    const initResult = await runInit({ cwd: targetDir, mcp: false });
    if (initResult.contentUpdated.length > 0) {
      const msg = `auto-init: updated ${initResult.contentUpdated.join(', ')}`;
      if (opts.json) emit(true, { type: 'warning', message: msg });
      else process.stderr.write(`  ${msg}\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) emit(true, { type: 'warning', message: `auto-init: ${msg}` });
    else process.stderr.write(`  auto-init: ${msg}\n`);
  }

  try {
    ensureOkExcludedFromGit(targetDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) emit(true, { type: 'warning', message: `git-exclude: ${msg}` });
    else process.stderr.write(`  git-exclude: ${msg}\n`);
  }

  return targetDir;
}

export function ensureOkExcludedFromGit(
  projectDir: string,
): 'appended' | 'already-present' | 'no-exclude' {
  const result = addOkPathsToGitExclude(projectDir, [`${OK_DIR}/`]);
  if (result.kind === 'no-exclude') return 'no-exclude';
  if (result.kind === 'refused-tracked') return 'already-present';
  if (result.appended.length > 0) return 'appended';
  return 'already-present';
}

const SHELL_SAFE_TOKEN = /^[A-Za-z0-9._/:@-]+$/;

function stripUrlPassword(url: string): string {
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

function quoteIfNeeded(s: string): string {
  return SHELL_SAFE_TOKEN.test(s) ? s : shellSingleQuote(s);
}

function reconstructCloneCommand(url: string, branch: string | null | undefined): string {
  const branchSuffix =
    typeof branch === 'string' && branch.length > 0 ? ` -b ${quoteIfNeeded(branch)}` : '';
  return `ok clone ${quoteIfNeeded(url)}${branchSuffix}`;
}

export function formatCloneAuthFailure(opts: {
  error: unknown;
  url: string;
  branch?: string | null;
  principal?: string | null;
  resolvedLogin?: string | null;
}): string | null {
  const classified: ClassifiedGitAuthError = classifyGitAuthError(opts.error);
  if (classified.kind !== 'auth') return null;

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

  if (classified.subclass === 'not-found-as-identity') {
    const identity =
      typeof opts.resolvedLogin === 'string' && opts.resolvedLogin.length > 0
        ? ` Authenticated as ${opts.resolvedLogin}.`
        : '';
    return `✗ Repository not found when cloning ${displayUrl}. It may not exist, or the account used may not have access.${identity}`;
  }

  return [
    '✗ Your GitHub token is missing required OAuth scopes — likely the `repo` scope.',
    '',
    '  To fix:',
    '    1. Create a token with `repo` scope at https://github.com/settings/tokens',
    '    2. Run: ok auth pat',
    `    3. Then re-run: ${reconstructCloneCommand(displayUrl, opts.branch)}`,
  ].join('\n');
}

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

export async function resolveClonePrincipal(
  tokenStore: TokenStore,
  host: string,
): Promise<string | null> {
  const entry = await tokenStore.get(host);
  const login = entry?.login;
  return login && login !== 'unknown' ? login : null;
}

export async function handleCloneFailure(opts: {
  error: unknown;
  url: string;
  branch: string | null;
  json: boolean;
  emit: (event: Record<string, unknown>) => void;
  printStderr: (text: string) => void;
  resolvePrincipal?: (host: string) => Promise<string | null>;
  auth?: { tier: ResolvedAuth['tier']; login?: string };
}): Promise<void> {
  const classified = classifyGitAuthError(opts.error);
  const ghAuth = opts.auth?.tier === 'A' ? opts.auth : undefined;
  let principal: string | null = null;
  if (!opts.json && classified.kind === 'auth' && classified.subclass === '403') {
    if (ghAuth) {
      principal = ghAuth.login ?? null;
    } else if (opts.auth?.tier !== 'none') {
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
            process.chdir(targetDir);
            const { startCommand } = await import('./start.ts');
            const startCmd = startCommand(getConfig);
            await startCmd.parseAsync([], { from: 'user' });
          }
        } catch (err) {
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
          process.exitCode = 1;
        }
      },
    );
}
