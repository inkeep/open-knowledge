import {
  type ClassifiedGitAuthError,
  classifyGitAuthError,
  clientVersionHeaders,
  isGitHubHost,
  normalizeGitHostname,
} from '@inkeep/open-knowledge-core';
import {
  assertIncomingSymlinksSafe,
  assertMergeNameResolvesTo,
  type Config,
  RUNTIME_VERSION,
  readDeclaredGitHubHosts,
  readServerLock,
  resolveLockDir,
  SYMLINK_MERGE_MIN_GIT_LABEL,
  UnsafeIncomingSymlinkError,
  type UnsafeSymlinkReason,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import simpleGit, { type SimpleGit } from 'simple-git';
import type { GhDetectResult } from '../auth/gh-detect.ts';
import { buildHttpsHostCliCredentialConfig, type ResolvedAuth } from '../auth/resolve-auth.ts';
import { makeLazyTokenStore, type TokenStore } from '../auth/token-store.ts';
import { parseGitUrl } from '../github/url.ts';
import {
  buildCloneAuthEnv,
  buildCloneGitOptions,
  type CloneAuthResolution,
  formatDeclaredAccountMiss,
  resolveCloneAuth,
  resolveSelfCliArgs,
} from './clone.ts';

function emit(json: boolean, obj: Record<string, unknown>): void {
  if (json) process.stdout.write(`${JSON.stringify(obj)}\n`);
}

interface SyncOptions {
  json: boolean;
  op?: 'sync' | 'push' | 'pull';
  tokenStore?: TokenStore;
  _detectGhFn?: (host?: string, options?: { login?: string }) => GhDetectResult;
}

type NetworkCommand = 'pull' | 'push';

interface CredentialSources {
  tokenStore: TokenStore;
  detectGh: SyncOptions['_detectGhFn'];
}

function implicitDefaultRemote(remotes: readonly string[]): string {
  const [only, ...others] = remotes;
  return only !== undefined && others.length === 0 ? only : 'origin';
}

async function contactedRemoteUrl(git: SimpleGit, command: NetworkCommand): Promise<string | null> {
  try {
    const branch = (await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    const explicitName =
      branch === ''
        ? ''
        : (
            await git.raw([
              'for-each-ref',
              `--format=%(${command === 'push' ? 'push' : 'upstream'}:remotename)`,
              `refs/heads/${branch}`,
            ])
          ).trim();
    const name =
      explicitName !== ''
        ? explicitName
        : implicitDefaultRemote(
            (await git.raw(['remote']))
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== ''),
          );
    const url = (
      await git.raw(['remote', 'get-url', ...(command === 'push' ? ['--push'] : []), name])
    ).trim();
    return url === '' ? null : url;
  } catch {
    return null;
  }
}

interface RemoteGit {
  git: SimpleGit;
  signIn?: { host: string; tier: Exclude<ResolvedAuth['tier'], 'none'> };
  declaredMiss?: CloneAuthResolution['declaredMiss'];
}

function httpsCredentialHost(url: string): string | null {
  const host = /^https:\/\/(?:[^/?#@]*@)?([^/?#@]+)/i.exec(url)?.[1];
  return host !== undefined && host === normalizeGitHostname(host) ? host : null;
}

const FAILED_REQUEST_URL_PATTERNS = [
  /Authentication failed for '([^']+)'/g,
  /unable to access '([^']+)'/g,
  /repository '([^']+)' not found/g,
  /could not read (?:Username|Password) for '([^']+)'/g,
];

function failedRequestServedBy(message: string, host: string): boolean {
  return FAILED_REQUEST_URL_PATTERNS.some((pattern) =>
    Array.from(message.matchAll(pattern)).some((match) => httpsCredentialHost(match[1]) === host),
  );
}

function inheritingAmbientEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const ambient = { ...process.env };
  const inherited: NodeJS.ProcessEnv = Object.create(ambient);
  for (const key of new Set([...Object.keys(ambient), ...Object.keys(env)])) {
    if (env[key] !== ambient[key]) inherited[key] = env[key];
  }
  return inherited;
}

async function gitForRemoteUrl(
  cwd: string,
  url: string | null,
  sources: CredentialSources,
): Promise<RemoteGit> {
  const ambient: RemoteGit = { git: simpleGit({ baseDir: cwd }) };
  const host = url === null ? null : httpsCredentialHost(url);
  if (
    url === null ||
    host === null ||
    parseGitUrl(url) === null ||
    !isGitHubHost(host, readDeclaredGitHubHosts())
  ) {
    return ambient;
  }
  const { auth, declaredMiss } = await resolveCloneAuth(url, sources.tokenStore, {
    cwd,
    ...(sources.detectGh ? { _detectGhFn: sources.detectGh } : {}),
  });
  if (auth.tier === 'none') return ambient;
  return {
    git: simpleGit(
      buildCloneGitOptions(cwd, buildHttpsHostCliCredentialConfig(resolveSelfCliArgs(), host)),
    ).env(inheritingAmbientEnv(buildCloneAuthEnv(auth))),
    signIn: { host, tier: auth.tier },
    ...(declaredMiss !== undefined ? { declaredMiss } : {}),
  };
}

function describeSignInUsed(
  command: NetworkCommand,
  signIn: NonNullable<RemoteGit['signIn']>,
  failure: ClassifiedGitAuthError,
): string | null {
  if (failure.kind !== 'auth') return null;
  const { host } = signIn;
  const viaGh = signIn.tier === 'A';
  const used = viaGh
    ? `The ${command} offered the GitHub CLI's sign-in for ${host}, which OpenKnowledge relays in place of your git credential helpers for that host; a ~/.netrc entry or a password in the remote URL is used before it.`
    : `The ${command} offered OpenKnowledge's GitHub sign-in for ${host} in place of your git credential helpers for that host; a ~/.netrc entry or a password in the remote URL is used before it.`;
  switch (failure.subclass) {
    case 'no-credential':
    case '401':
    case 'unknown-auth': {
      const renew = viaGh ? `gh auth login --hostname ${host}` : `ok auth login --host ${host}`;
      return `${used} If that sign-in has expired or was revoked, run: ${renew}`;
    }
    case '403':
      return `${used} If ${host} denied that account access, check that it has access to the repository.`;
    case 'not-found-as-identity':
      return `${used} If ${host} reported the repository as not found, it may not exist, or that account may not have access.`;
    case 'scope-mismatch': {
      const rescope = viaGh
        ? `run: gh auth refresh --hostname ${host} --scopes repo`
        : `create a token with that scope at https://${host}/settings/tokens and run: ok auth pat --host ${host}`;
      return `${used} If its token is missing a required OAuth scope, likely repo, ${rescope}`;
    }
    case 'ssh-auth':
      return null;
    default: {
      const exhaustive: never = failure.subclass;
      return exhaustive;
    }
  }
}

async function runOnRemote<T>(
  remote: RemoteGit,
  command: NetworkCommand,
  run: (git: SimpleGit) => Promise<T>,
): Promise<T> {
  try {
    return await run(remote.git);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const explanation =
      remote.signIn === undefined || !failedRequestServedBy(reason, remote.signIn.host)
        ? null
        : describeSignInUsed(command, remote.signIn, classifyGitAuthError(err));
    if (explanation === null) throw err;
    throw new Error(`${reason.trimEnd()}\n${explanation}`, { cause: err });
  }
}

interface IncomingCommit {
  commit: string;
  trackingRef: string | null;
}

async function fetchIncomingCommit(git: SimpleGit): Promise<IncomingCommit> {
  await git.fetch();
  const tracked = (
    await git.raw(['rev-parse', '--verify', '--quiet', '@{upstream}^{commit}'])
  ).trim();
  if (tracked !== '') {
    const trackingRef = (
      await git.raw(['rev-parse', '--symbolic-full-name', '@{upstream}'])
    ).trim();
    return { commit: tracked, trackingRef: trackingRef.startsWith('refs/') ? trackingRef : null };
  }
  const branch = (await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  if (branch === '') {
    throw new Error(
      'not on a branch, so there is nothing to pull into; switch to a branch first, for example: git switch main',
    );
  }
  const mergeRef = (await git.raw(['config', '--get', `branch.${branch}.merge`])).trim();
  const remote = (await git.raw(['config', '--get', `branch.${branch}.remote`])).trim() || 'origin';
  if (mergeRef === '') {
    throw new Error(
      `no upstream configured for branch "${branch}"; set one with: git branch --set-upstream-to=${remote}/${branch} ${branch}`,
    );
  }
  await git.fetch(remote, mergeRef);
  const fetched = (
    await git.raw(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'])
  ).trim();
  if (fetched === '') throw new Error(`could not resolve the fetched ${mergeRef}`);
  return { commit: fetched, trackingRef: null };
}

type SymlinkRemedy = 'update-git' | 'readable-folder' | 'fix-link';

function remediesFor(reason: UnsafeSymlinkReason): readonly SymlinkRemedy[] {
  switch (reason) {
    case 'requires-newer-git':
      return ['update-git'];
    case 'unverifiable-target':
      return ['readable-folder', 'fix-link'];
    case 'outside-repository':
    case 'repository-root':
    case 'private-state':
    case 'secret-file':
    case 'inside-private-state':
      return ['fix-link'];
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

const REMEDY_TEXT: Record<SymlinkRemedy, string> = {
  'update-git': `Update Git to ${SYMLINK_MERGE_MIN_GIT_LABEL} or newer.`,
  'readable-folder': 'If a folder on the way is unreadable on this machine, make it readable.',
  'fix-link':
    'Remove or fix these links on the remote, or fix your own local change to them, then pull again.',
};

export function syncFailureMessage(err: unknown): string {
  if (err instanceof UnsafeIncomingSymlinkError) {
    const remedies = new Set(err.unsafe.flatMap(({ reason }) => remediesFor(reason)));
    const steps = Object.entries(REMEDY_TEXT)
      .filter(([remedy]) => remedies.has(remedy as SymlinkRemedy))
      .map(([, text]) => text);
    if (!remedies.has('fix-link')) steps.push('Then pull again.');
    return `incoming symlinks are unsafe to check out: ${err.describeLinks()}. ${steps.join(' ')}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function runSync(
  opts: SyncOptions,
  _config: Config,
  cwd = process.cwd(),
): Promise<void> {
  const op = opts.op ?? 'sync';
  const lockDir = resolveLockDir(cwd);

  const lock = readServerLock(lockDir);
  if (lock && lock.port > 0) {
    const url = `http://127.0.0.1:${lock.port}/api/sync/trigger`;
    if (!opts.json) {
      process.stderr.write(`Triggering ${op} via running server (port ${lock.port})\n`);
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...clientVersionHeaders({ kind: 'cli', runtimeVersion: RUNTIME_VERSION }),
        },
        body: JSON.stringify({ op }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          title?: string;
          error?: string;
          message?: string;
        };
        throw new Error(
          body.title ?? body.error ?? body.message ?? `Server responded with ${res.status}`,
        );
      }
      emit(opts.json, { type: 'triggered', op, port: lock.port });
      if (!opts.json) {
        process.stderr.write(`✓ ${op} triggered\n`);
      }
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!opts.json) {
        process.stderr.write(`Server trigger failed (${msg}), running directly\n`);
      }
    }
  }

  if (!opts.json) {
    process.stderr.write(`Running ${op} directly (no live server)\n`);
  }

  const local = simpleGit({ baseDir: cwd });
  const sources: CredentialSources = {
    tokenStore: opts.tokenStore ?? makeLazyTokenStore(),
    detectGh: opts._detectGhFn,
  };
  const remoteFor = async (url: string | null): Promise<RemoteGit> => {
    const remote = await gitForRemoteUrl(cwd, url, sources);
    const warning = formatDeclaredAccountMiss(remote.declaredMiss, {
      url: 'The remote URL',
      operation: `ok ${op}`,
    });
    if (warning === null) return remote;
    if (opts.json) emit(true, { type: 'warning', message: warning.trimEnd() });
    else process.stderr.write(warning);
    return remote;
  };
  let pulled: { url: string | null; remote: RemoteGit } | undefined;

  if (op === 'sync' || op === 'pull') {
    emit(opts.json, { type: 'step', step: 'pull' });
    const url = await contactedRemoteUrl(local, 'pull');
    pulled = { url, remote: await remoteFor(url) };
    const incoming = await runOnRemote(pulled.remote, 'pull', fetchIncomingCommit);
    await assertIncomingSymlinksSafe(local, incoming.commit, 'merge');
    const { trackingRef } = incoming;
    if (trackingRef !== null) {
      await assertMergeNameResolvesTo(local, {
        name: trackingRef,
        trackingRef,
        commit: incoming.commit,
      });
    }
    const result = await local.pull('.', trackingRef ?? incoming.commit);
    emit(opts.json, { type: 'pull', summary: result.summary });
    if (!opts.json) {
      process.stderr.write(`  pull: ${result.summary.changes} changes\n`);
    }
  }

  if (op === 'sync' || op === 'push') {
    emit(opts.json, { type: 'step', step: 'push' });
    const url = await contactedRemoteUrl(local, 'push');
    const remote =
      pulled !== undefined && pulled.url === url ? pulled.remote : await remoteFor(url);
    await runOnRemote(remote, 'push', (git) => git.push());
    emit(opts.json, { type: 'push', ok: true });
    if (!opts.json) {
      process.stderr.write('  push: ok\n');
    }
  }

  emit(opts.json, { type: 'complete', op });
  if (!opts.json) {
    process.stderr.write(`✓ ${op} complete\n`);
  }
}

export function syncCommand(getConfig: () => Config): Command {
  return new Command('sync')
    .description('Commit, pull, and push to the remote')
    .option('--json', 'Output JSONL progress events', false)
    .action(async (opts: { json: boolean }) => {
      try {
        await runSync({ json: opts.json, op: 'sync' }, getConfig());
      } catch (err) {
        const msg = syncFailureMessage(err);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ type: 'error', message: msg })}\n`);
        } else {
          process.stderr.write(`✗ sync failed: ${msg}\n`);
        }
        process.exit(1);
      }
    });
}
