import { Octokit } from '@octokit/rest';
import { Command } from 'commander';
import { describeAuthFailure } from '../../auth/describe-auth-error.ts';
import { detectGh } from '../../auth/gh-detect.ts';
import type { TokenStore } from '../../auth/token-store.ts';
import { resolveStatusHost, tokenCommandLine } from './validate-host.ts';

interface StatusOptions {
  host: string;
  json: boolean;
}

type ResolvedStatusSource = { tier: 'A' | 'B' | 'C'; token: string } | { tier: 'none' };

export async function resolveStatusSource(
  host: string,
  tokenStore: TokenStore,
  _detectGhFn: (host?: string) => ReturnType<typeof detectGh> = detectGh,
): Promise<ResolvedStatusSource> {
  const gh = _detectGhFn(host);
  if (gh.available && gh.token) return { tier: 'A', token: gh.token };
  const entry = await tokenStore.get(host);
  if (entry == null) return { tier: 'none' };
  return { tier: entry.gitProtocol === 'ssh' ? 'C' : 'B', token: entry.token };
}

type StatusSignedOut = { authenticated: false; error?: never; unverified?: never; login?: never };
type StatusFailed = { authenticated: false; error: string; unverified?: never; login?: never };
type StatusStoredUnverified = {
  authenticated: false;
  unverified: true;
  login: string;
  error?: never;
};

export type StoredEntryOutcome = StatusSignedOut | StatusStoredUnverified;

export type StatusOutcome =
  | StatusSignedOut
  | StatusFailed
  | StatusStoredUnverified
  | {
      authenticated: true;
      tier: 'A' | 'B' | 'C';
      login: string;
      name: string | null;
      email: string | null;
    };

export function buildStatusPayload(
  host: string,
  backend: TokenStore['backend'],
  outcome: StatusOutcome,
): Record<string, unknown> {
  return { type: 'status', host, backend, ...outcome };
}

export async function resolveStoredEntryStatus(
  host: string,
  tokenStore: TokenStore,
): Promise<StoredEntryOutcome> {
  const entry = await tokenStore.get(host);
  return entry == null
    ? { authenticated: false }
    : { authenticated: false, unverified: true, login: entry.login };
}

export function formatStoredEntryStatus(outcome: StoredEntryOutcome, host: string): string {
  if (outcome.unverified !== true) {
    return `No token stored for ${host}. Store one with:\n\n${tokenCommandLine(host)}`;
  }
  return (
    `Token stored for ${outcome.login} on ${host}. ${host} is not a GitHub host, so ` +
    `OpenKnowledge does not verify it; git uses this credential to push and pull.`
  );
}

async function runStoredEntryStatus(opts: StatusOptions, tokenStore: TokenStore): Promise<void> {
  const { host, json } = opts;
  const outcome = await resolveStoredEntryStatus(host, tokenStore);
  if (json) {
    process.stdout.write(
      `${JSON.stringify(buildStatusPayload(host, tokenStore.backend, outcome))}\n`,
    );
  } else {
    process.stderr.write(`${formatStoredEntryStatus(outcome, host)}\n`);
  }
  process.exit(outcome.unverified === true ? 0 : 1);
}

async function runStatus(opts: StatusOptions, tokenStore: TokenStore): Promise<void> {
  const { host, json } = opts;

  const backend = tokenStore.backend;
  const source = await resolveStatusSource(host, tokenStore);

  if (source.tier === 'none') {
    if (json) {
      process.stdout.write(
        `${JSON.stringify(buildStatusPayload(host, backend, { authenticated: false }))}\n`,
      );
    } else {
      process.stderr.write(`Not logged in to ${host}\n`);
    }
    process.exit(1);
  }

  const baseUrl = host === 'github.com' ? undefined : `https://${host}/api/v3`;
  const octokit = new Octokit({ auth: source.token, ...(baseUrl ? { baseUrl } : {}) });

  try {
    const { data } = await octokit.users.getAuthenticated();
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          buildStatusPayload(host, backend, {
            authenticated: true,
            tier: source.tier,
            login: data.login,
            name: data.name,
            email: data.email,
          }),
        )}\n`,
      );
    } else {
      process.stderr.write(`✓ Logged in as ${data.login} on ${host}\n`);
    }
  } catch (err) {
    const failure = describeAuthFailure(err, host);
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          buildStatusPayload(host, backend, { authenticated: false, error: failure.message }),
        )}\n`,
      );
    } else {
      process.stderr.write(`✗ ${failure.message}\n`);
    }
    process.exit(1);
  }
}

export function statusCommand(getTokenStore: () => Promise<TokenStore>): Command {
  return new Command('status')
    .description('Show authentication status')
    .option(
      '--host <host>',
      'Git hostname (default: the origin host, or github.com with no origin; required when origin has no hostname, such as a local path). A non-GitHub host reports its stored token without verifying it',
    )
    .option('--json', 'Output JSON', false)
    .action(async (opts: Omit<StatusOptions, 'host'> & { host?: string }) => {
      const target = resolveStatusHost(opts.host);
      if (target.kind === 'other') {
        await runStoredEntryStatus({ ...opts, host: target.host }, await getTokenStore());
        return;
      }
      await runStatus({ ...opts, host: target.host }, await getTokenStore());
    });
}
