import type { Counter, Histogram } from '@opentelemetry/api';
import { getLogger } from './logger.ts';
import { type OriginTransport, sameGitHubLogin } from './share/git-context.ts';
import type { GitHubAccountSource } from './share/github-account.ts';
import { getMeter } from './telemetry.ts';

const log = getLogger('github-permissions');

const PROBE_TIMEOUT_MS = 5000;

export type FetchFn = typeof fetch;

type PushPermissionDeniedReason =
  | 'no-collaborator'
  | 'private-no-access'
  | 'repo-not-found'
  | 'not-authenticated';

type PushPermissionUnknownError =
  | 'network'
  | 'timeout'
  | 'rate-limit'
  | 'token-invalid'
  | 'malformed-response'
  | 'ssh-unverified';

type DeclaredAccountSource = Exclude<GitHubAccountSource, 'active'>;

export type PushPermission =
  | { kind: 'allowed' }
  | {
      kind: 'denied';
      reason: PushPermissionDeniedReason;
      resolvedLogin?: string;
      declaredLogin?: string;
      declaredSource?: DeclaredAccountSource;
    }
  | { kind: 'unknown'; error: PushPermissionUnknownError };

export type DetectGhFn = (
  host?: string,
  options?: { login?: string },
) =>
  | { available: false }
  | { available: true; token: string; resolvedLogin?: string; fallback?: boolean };

export type DetectGhAccountsFn = (
  host?: string,
) => Array<{ login: string; active: boolean }> | undefined;

export interface ProbeTokenStore {
  get(host: string): Promise<{ token?: string; login?: string } | null>;
}

type ProbeAccount =
  | { source: 'active'; login?: undefined }
  | { source: DeclaredAccountSource; login: string };

export interface CheckPushPermissionOptions {
  owner: string;
  repo: string;
  host?: string;
  transport?: OriginTransport;
  account?: ProbeAccount;
  detectGh?: DetectGhFn;
  detectGhAccounts?: DetectGhAccountsFn;
  tokenStore?: ProbeTokenStore | null;
  _fetchFn?: FetchFn;
  _timeoutMs?: number;
}

function githubApiBase(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

function buildHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'open-knowledge-server',
    Accept: 'application/vnd.github+json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function readPushFlag(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null) return null;
  const perms = (body as { permissions?: unknown }).permissions;
  if (typeof perms !== 'object' || perms === null) return null;
  const push = (perms as { push?: unknown }).push;
  return typeof push === 'boolean' ? push : null;
}

async function classify(resp: Response, hadToken: boolean): Promise<PushPermission> {
  switch (resp.status) {
    case 200: {
      let body: unknown;
      try {
        body = await resp.json();
      } catch (err) {
        log.warn({ err }, '[permissions] probe got 200 with unparseable JSON body');
        return { kind: 'unknown', error: 'malformed-response' };
      }
      const push = readPushFlag(body);
      if (push === null) {
        log.warn(
          { bodyKeys: typeof body === 'object' && body !== null ? Object.keys(body) : [] },
          '[permissions] probe got 200 without permissions.push field',
        );
        return { kind: 'unknown', error: 'malformed-response' };
      }
      return push ? { kind: 'allowed' } : { kind: 'denied', reason: 'no-collaborator' };
    }
    case 401:
      return { kind: 'unknown', error: 'token-invalid' };
    case 403:
      return resp.headers.get('x-ratelimit-remaining') === '0'
        ? { kind: 'unknown', error: 'rate-limit' }
        : { kind: 'unknown', error: 'token-invalid' };
    case 429:
      return { kind: 'unknown', error: 'rate-limit' };
    case 404:
      return hadToken
        ? { kind: 'denied', reason: 'private-no-access' }
        : { kind: 'denied', reason: 'repo-not-found' };
    default:
      log.warn({ httpStatus: resp.status }, '[permissions] probe got unexpected HTTP status');
      return { kind: 'unknown', error: 'malformed-response' };
  }
}

async function resolveProbeTokenWithSource(
  host: string,
  account: ProbeAccount | undefined,
  detectGh: DetectGhFn,
  tokenStore: ProbeTokenStore | null | undefined,
  detectGhAccounts: DetectGhAccountsFn | undefined,
): Promise<{
  token: string | undefined;
  source: 'gh' | 'token-store' | 'anonymous';
  resolvedLogin?: string;
}> {
  const gh = detectGh(host, { login: account?.login });
  if (gh.available && gh.token) {
    if (account?.login !== undefined && gh.fallback === true) {
      const activeLogin = activeAccountLogin(detectGhAccounts, host);
      if (!sameGitHubLogin(activeLogin, account.login)) {
        log.warn(
          {
            host,
            declaredLogin: account.login,
            declaredSource: account.source,
            resolvedLogin: activeLogin,
          },
          '[permissions] declared GitHub account did not produce the gh token — probing as the active account',
        );
      }
    }
    return { token: gh.token, source: 'gh', resolvedLogin: gh.resolvedLogin };
  }
  if (tokenStore) {
    try {
      const entry = await tokenStore.get(host);
      if (entry?.token) {
        const login = entry.login !== 'unknown' ? entry.login : undefined;
        return { token: entry.token, source: 'token-store', resolvedLogin: login };
      }
    } catch (err) {
      log.warn({ err, host }, '[permissions] tokenStore.get threw; falling through to anonymous');
    }
  }
  return { token: undefined, source: 'anonymous' };
}

function withDeniedIdentity(
  denied: Extract<PushPermission, { kind: 'denied' }>,
  opts: {
    account: ProbeAccount | undefined;
    tokenSource: 'gh' | 'token-store' | 'anonymous';
    resolvedLogin: string | undefined;
    detectGhAccounts: DetectGhAccountsFn | undefined;
    host: string;
  },
): Extract<PushPermission, { kind: 'denied' }> {
  const resolvedLogin =
    opts.resolvedLogin ??
    (opts.tokenSource === 'gh' ? activeAccountLogin(opts.detectGhAccounts, opts.host) : undefined);
  return {
    ...denied,
    ...(resolvedLogin !== undefined ? { resolvedLogin } : {}),
    ...declaredMissFields(opts.account, resolvedLogin),
  };
}

function declaredMissFields(
  account: ProbeAccount | undefined,
  resolvedLogin: string | undefined,
): Pick<Extract<PushPermission, { kind: 'denied' }>, 'declaredLogin' | 'declaredSource'> {
  if (account?.login === undefined) return {};
  if (sameGitHubLogin(account.login, resolvedLogin)) return {};
  return { declaredLogin: account.login, declaredSource: account.source };
}

function activeAccountLogin(
  detectGhAccounts: DetectGhAccountsFn | undefined,
  host: string,
): string | undefined {
  if (!detectGhAccounts) return undefined;
  try {
    return detectGhAccounts(host)?.find((a) => a.active)?.login;
  } catch (err) {
    log.warn({ err, host }, '[permissions] detectGhAccounts failed — denial stays unnamed');
    return undefined;
  }
}

async function runProbe(opts: CheckPushPermissionOptions): Promise<PushPermission> {
  const {
    owner,
    repo,
    host = 'github.com',
    transport = 'https',
    account,
    detectGh = () => ({ available: false }),
    detectGhAccounts,
    tokenStore,
    _fetchFn = fetch,
    _timeoutMs = PROBE_TIMEOUT_MS,
  } = opts;

  const {
    token,
    source: tokenSource,
    resolvedLogin,
  } = await resolveProbeTokenWithSource(host, account, detectGh, tokenStore, detectGhAccounts);

  if (tokenSource === 'anonymous') {
    if (transport === 'ssh' || transport === 'git') {
      log.info(
        { host, transport },
        '[permissions] no credential resolved for ssh/git origin — abstaining (push auths with SSH keys, not tokens)',
      );
      return { kind: 'unknown', error: 'ssh-unverified' };
    }
    log.info({ host }, '[permissions] no credential resolved — denying push (read-only)');
    return {
      kind: 'denied',
      reason: 'not-authenticated',
      ...declaredMissFields(account, undefined),
    };
  }

  const url = `${githubApiBase(host)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  log.info(
    {
      host,
      tokenSource,
      tokenLen: token === undefined ? 0 : token.length,
    },
    '[permissions] probe starting',
  );

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), _timeoutMs);
  try {
    const resp = await _fetchFn(url, { signal: ac.signal, headers: buildHeaders(token) });
    const classified = await classify(resp, token !== undefined);
    const result =
      classified.kind === 'denied'
        ? withDeniedIdentity(classified, {
            account,
            tokenSource,
            resolvedLogin,
            detectGhAccounts,
            host,
          })
        : classified;
    log.info(
      {
        host,
        tokenSource,
        httpStatus: resp.status,
        kind: result.kind,
        reason: result.kind === 'denied' ? result.reason : undefined,
        error: result.kind === 'unknown' ? result.error : undefined,
      },
      '[permissions] probe classified',
    );
    return result;
  } catch (err) {
    if (ac.signal.aborted) {
      log.warn({ host, timeoutMs: _timeoutMs }, '[permissions] probe timed out');
      return { kind: 'unknown', error: 'timeout' };
    }
    log.warn({ err, host }, '[permissions] probe failed');
    return { kind: 'unknown', error: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkPushPermission(
  opts: CheckPushPermissionOptions,
): Promise<PushPermission> {
  const start = performance.now();
  const result = await runProbe(opts);
  recordProbeTelemetry(result, performance.now() - start);
  return result;
}

interface ProbeOutcomeAttributes extends Record<string, string> {
  outcome: PushPermission['kind'];
  denied_reason: PushPermissionDeniedReason | 'none';
  error_class: PushPermissionUnknownError | 'none';
}

function outcomeAttributes(result: PushPermission): ProbeOutcomeAttributes {
  return {
    outcome: result.kind,
    denied_reason: result.kind === 'denied' ? result.reason : 'none',
    error_class: result.kind === 'unknown' ? result.error : 'none',
  };
}

let _outcomeCounter: Counter | null = null;
function outcomeCounter(): Counter {
  _outcomeCounter ||= getMeter().createCounter('ok.permissions.probe.outcome_total', {
    description:
      'Push-permission probe outcomes. Bounded labels: outcome ∈ {allowed,denied,unknown}; denied_reason ∈ {no-collaborator,private-no-access,repo-not-found,not-authenticated,none}; error_class ∈ {network,timeout,rate-limit,token-invalid,malformed-response,ssh-unverified,none}.',
  });
  return _outcomeCounter;
}

let _durationHist: Histogram | null = null;
function durationHist(): Histogram {
  _durationHist ||= getMeter().createHistogram('ok.permissions.probe.duration_ms', {
    description: 'Push-permission probe wall-clock duration.',
    unit: 'ms',
  });
  return _durationHist;
}

function recordProbeTelemetry(result: PushPermission, durationMs: number): void {
  const attrs = outcomeAttributes(result);
  outcomeCounter().add(1, attrs);
  durationHist().record(durationMs, { outcome: attrs.outcome });
}

export function __resetGithubPermissionsTelemetryForTests(): void {
  _outcomeCounter = null;
  _durationHist = null;
}
