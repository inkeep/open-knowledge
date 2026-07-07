/**
 * Upfront push-permission probe for a GitHub remote.
 *
 * Reads `permissions.push` from `GET /repos/{owner}/{repo}` so the sync UX can
 * gate doomed onboarding/push affordances before the first git push fails with
 * an opaque 403. One authenticated REST call; the result is meant to be cached
 * per project per session by the caller.
 *
 * Token resolution mirrors the three-tier auth model: Tier A `gh` CLI, then
 * Tier B/C OK credential store, then anonymous. Both sources are INJECTED
 * rather than imported: `packages/server` cannot depend on `packages/cli`
 * (cli already depends on server, so the import would be a package cycle). The
 * wiring layer passes the concrete `detectGh` / `tokenStore` in — same seam as
 * `resolveGitIdentity` in `git-identity.ts`.
 *
 * Bare `fetch()` (no Octokit) for consistency with `cli/src/github/visibility.ts`.
 */

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

/**
 * Outcome of a single push-permission probe.
 *
 * - `allowed` — the authenticated user can push.
 * - `denied` — the user cannot push (or cannot see the repo); `reason` says why.
 * - `unknown` — the probe could not decide; `error` says why. Callers MUST fall
 *   through to current sync behavior on `unknown` and never treat it as denied.
 */
export type PushPermission =
  | { kind: 'allowed' }
  | { kind: 'denied'; reason: PushPermissionDeniedReason }
  | { kind: 'unknown'; error: PushPermissionUnknownError };

/** gh-CLI token detector. Structurally compatible with cli's `detectGh`. */
export type DetectGhFn = (host?: string) => { available: boolean; token?: string };

/**
 * Read side of the OK credential store, structurally compatible with cli's
 * `TokenStore`. Injected (not imported) for the package-cycle reason above.
 */
export interface ProbeTokenStore {
  get(host: string): Promise<{ token?: string } | null>;
}

export interface CheckPushPermissionOptions {
  owner: string;
  repo: string;
  /** GitHub host. Defaults to `'github.com'`. */
  host?: string;
  /** Tier A resolver (`gh` CLI). Defaults to "no gh available". */
  detectGh?: DetectGhFn;
  /** Tier B/C credential store. Omit to skip stored-token resolution. */
  tokenStore?: ProbeTokenStore | null;
  /** Injectable for tests; defaults to the global `fetch`. */
  _fetchFn?: FetchFn;
  /**
   * Test-only override of the abort timeout. Production callers leave this
   * undefined and inherit `PROBE_TIMEOUT_MS` (5 s); tests that exercise the
   * timeout branch set it small (e.g., 20 ms) so the AbortController fires
   * deterministically without a multi-second wait.
   */
  _timeoutMs?: number;
}

/**
 * GitHub-first (provider-agnostic signature, GitHub-only implementation):
 * github.com → api.github.com; a GHES host → its `/api/v3` base.
 */
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

/** Extract `permissions.push` only when it is present AND a boolean. */
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
        // JSON parse failure on a 200 response — unusual; surface for ops
        // so a future GitHub response-shape change is diagnosable instead
        // of looking like a generic network error in telemetry.
        log.warn({ err }, '[permissions] probe got 200 with unparseable JSON body');
        return { kind: 'unknown', error: 'malformed-response' };
      }
      const push = readPushFlag(body);
      if (push === null) {
        // 200 + valid JSON but no `permissions.push` field. Anonymous calls
        // used to land here, but they now short-circuit to `denied` before the
        // request (no credential ⇒ no push). Reaching this with a token means a
        // future GitHub schema change dropped the field for authenticated
        // callers — this is the diagnostic for that.
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
      // GitHub overloads 403 for two distinct remediation paths. Primary
      // rate-limit (5000/hr exhausted) carries `x-ratelimit-remaining: 0`;
      // the actionable hint is "wait". Everything else at 403 — SAML SSO
      // not authorized for the token, organization SSO enforcement, abuse
      // detection — needs re-authentication. Distinguishing here lets the
      // sync UI surface the right hint (re-auth vs wait) without us
      // routing every SAML-SSO user into a misleading rate-limit message.
      return resp.headers.get('x-ratelimit-remaining') === '0'
        ? { kind: 'unknown', error: 'rate-limit' }
        : { kind: 'unknown', error: 'token-invalid' };
    case 429:
      // Secondary rate-limit. Always "wait" — no auth remediation possible.
      return { kind: 'unknown', error: 'rate-limit' };
    case 404:
      // Authenticated 404 means the token can't see the repo (private, no
      // access). The `hadToken: false` branch is defensive only — anonymous
      // probes short-circuit to `denied` before any request — but kept so a
      // future caller that bypasses the short-circuit still degrades sanely.
      return hadToken
        ? { kind: 'denied', reason: 'private-no-access' }
        : { kind: 'denied', reason: 'repo-not-found' };
    default:
      // Any other status (5xx, redirects, …) yields no permission decision.
      log.warn({ httpStatus: resp.status }, '[permissions] probe got unexpected HTTP status');
      return { kind: 'unknown', error: 'malformed-response' };
  }
}

/**
 * Resolve a token AND classify which tier it came from. Lets the probe log
 * the source for diagnostics without leaking the token itself. `'gh'` /
 * `'token-store'` / `'anonymous'` are the only three values; everything else
 * is a contract violation.
 */
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
      // tokenStore.get() shouldn't normally throw — lazy wrapper
      // catches keyring init failures and falls back to FileBackend — but
      // a future backend that throws on read (e.g. corrupted file, EACCES)
      // would otherwise propagate up to runProbe's outer catch and get
      // mislabeled as 'network' in telemetry. Log + fall through to
      // anonymous so the probe still attempts an unauthenticated request.
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

  // No credential at all → no push, definitionally. Short-circuit to the
  // denied posture WITHOUT a network call: an anonymous `GET /repos` returns
  // 200 with no `permissions` field, which classifies as `unknown` and makes
  // callers fall through to the doomed sync-onboarding + 403-push path. An
  // anonymous receiver opening a public shared repo (read-only by nature) must
  // instead land directly in the suppressed-onboarding, no-push UX.
  if (tokenSource === 'anonymous') {
    log.info({ host }, '[permissions] no credential resolved — denying push (read-only)');
    return { kind: 'denied', reason: 'no-collaborator' };
  }

  const url = `${githubApiBase(host)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  log.info(
    {
      host,
      tokenSource,
      // Don't log the token. Length-only signal lets diagnosis distinguish
      // "no token" from "token present but wrong identity" without leaking.
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
    // Branch on the abort signal: timeout vs everything else (DNS, TLS,
    // connection refused, fetch-level errors, or bugs in classify()).
    // Distinguishing in telemetry lets us alert on probes systematically
    // hitting the 5 s ceiling (signals GitHub slowdown) without that
    // noise drowning real network failures (signals the user being
    // offline). The log emits before return so an investigator has
    // server-side evidence — telemetry counters alone can't distinguish
    // a code regression in classify() from a real network outage. `host`
    // is bounded-cardinality; owner/repo/url are deliberately excluded
    // per OTel cardinality rules.
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

/**
 * Probe whether the authenticated user can push to `owner/repo` on `host`.
 * Never throws — every failure mode maps to an `unknown` variant.
 */
export async function checkPushPermission(
  opts: CheckPushPermissionOptions,
): Promise<PushPermission> {
  const start = performance.now();
  const result = await runProbe(opts);
  recordProbeTelemetry(result, performance.now() - start);
  return result;
}

// ─── Telemetry ──────────────────────────────────────────────────────────────
// Bounded-cardinality only — derived from the result enum, never the repo
// identifier or URL (high-cardinality + PII-adjacent for private repos).

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

/**
 * Drop the cached lazy-init instruments so the next call rebinds against the
 * currently-registered global MeterProvider. Test-only.
 */
export function __resetGithubPermissionsTelemetryForTests(): void {
  _outcomeCounter = null;
  _durationHist = null;
}
