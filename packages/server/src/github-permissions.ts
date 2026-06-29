import type { Counter, Histogram } from '@opentelemetry/api';
import { getLogger } from './logger.ts';
import { getMeter } from './telemetry.ts';

const log = getLogger('github-permissions');

const PROBE_TIMEOUT_MS = 5000;

export type FetchFn = typeof fetch;

type PushPermissionDeniedReason = 'no-collaborator' | 'private-no-access' | 'repo-not-found';

type PushPermissionUnknownError =
  | 'network'
  | 'timeout'
  | 'rate-limit'
  | 'token-invalid'
  | 'malformed-response';

export type PushPermission =
  | { kind: 'allowed' }
  | { kind: 'denied'; reason: PushPermissionDeniedReason }
  | { kind: 'unknown'; error: PushPermissionUnknownError };

export type DetectGhFn = (host?: string) => { available: boolean; token?: string };

export interface ProbeTokenStore {
  get(host: string): Promise<{ token?: string } | null>;
}

export interface CheckPushPermissionOptions {
  owner: string;
  repo: string;
  host?: string;
  detectGh?: DetectGhFn;
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
  detectGh: DetectGhFn,
  tokenStore: ProbeTokenStore | null | undefined,
): Promise<{ token: string | undefined; source: 'gh' | 'token-store' | 'anonymous' }> {
  const gh = detectGh(host);
  if (gh.available && gh.token) return { token: gh.token, source: 'gh' };
  if (tokenStore) {
    try {
      const entry = await tokenStore.get(host);
      if (entry?.token) return { token: entry.token, source: 'token-store' };
    } catch (err) {
      log.warn({ err, host }, '[permissions] tokenStore.get threw; falling through to anonymous');
    }
  }
  return { token: undefined, source: 'anonymous' };
}

async function runProbe(opts: CheckPushPermissionOptions): Promise<PushPermission> {
  const {
    owner,
    repo,
    host = 'github.com',
    detectGh = () => ({ available: false }),
    tokenStore,
    _fetchFn = fetch,
    _timeoutMs = PROBE_TIMEOUT_MS,
  } = opts;

  const { token, source: tokenSource } = await resolveProbeTokenWithSource(
    host,
    detectGh,
    tokenStore,
  );

  if (tokenSource === 'anonymous') {
    log.info({ host }, '[permissions] no credential resolved — denying push (read-only)');
    return { kind: 'denied', reason: 'no-collaborator' };
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
    const result = await classify(resp, token !== undefined);
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
      'Push-permission probe outcomes. Bounded labels: outcome ∈ {allowed,denied,unknown}; denied_reason ∈ {no-collaborator,private-no-access,repo-not-found,none}; error_class ∈ {network,timeout,rate-limit,token-invalid,malformed-response,none}.',
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
