import {
  type GitHubReferencePreview,
  GitHubReferencePreviewSchema,
} from '@inkeep/open-knowledge-core';
import { isGitHubRateLimited } from '../github-permissions.ts';
import { getLogger } from '../logger.ts';
import type { GitHubReferenceTarget } from './reference-target.ts';

const log = getLogger('github-reference');

export type GitHubReferenceOutcome =
  | { readonly ok: true; readonly preview: GitHubReferencePreview }
  | { readonly ok: false; readonly reason: 'not-found' | 'unavailable' };

export interface FetchGitHubReferenceOptions {
  readonly target: GitHubReferenceTarget;
  readonly token: string | null;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly rateLimits?: GitHubRateLimitHolds;
  readonly now?: () => number;
}

const RATE_LIMIT_DEFAULT_HOLD_MS = 60_000;

const RATE_LIMIT_MAX_HOLD_MS = 60 * 60_000;

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function resumeAt(headers: Headers, now: number): number {
  const retryAfter = headerNumber(headers, 'retry-after');
  if (retryAfter !== null) return now + Math.max(retryAfter, 1) * 1000;
  const reset = headerNumber(headers, 'x-ratelimit-reset');
  if (headers.get('x-ratelimit-remaining') === '0' && reset !== null && reset * 1000 > now) {
    return reset * 1000;
  }
  return now + RATE_LIMIT_DEFAULT_HOLD_MS;
}

function sharedLimit(res: { readonly status: number; readonly headers: Headers }): boolean {
  if (res.status === 200) return false;
  if (res.headers.get('retry-after') !== null) return true;
  return res.headers.get('x-ratelimit-remaining') !== '0';
}

const GRAPHQL_RATE_LIMIT_TYPES: ReadonlySet<unknown> = new Set(['RATE_LIMITED', 'RATE_LIMIT']);

function graphQLRateLimited(body: unknown): boolean {
  const errors = asRecord(body)?.errors;
  return (
    Array.isArray(errors) &&
    errors.some((error) => GRAPHQL_RATE_LIMIT_TYPES.has(asRecord(error)?.type))
  );
}

const HOLD_MESSAGES = {
  graphql:
    '[github-reference] GitHub rate-limited reference cards; no GraphQL requests to this host until the limit resets',
  rest: '[github-reference] GitHub rate-limited reference cards; no REST requests to this host until the limit resets',
  'graphql+rest':
    '[github-reference] GitHub rate-limited reference cards; no GraphQL or REST requests to this host until the limit resets',
} as const;

export class GitHubRateLimitHolds {
  private readonly until = new Map<string, number>();

  holding(key: string, now: number): boolean {
    const until = this.until.get(key);
    if (until === undefined) return false;
    if (until > now) return true;
    this.until.delete(key);
    return false;
  }

  hold(key: string, headers: Headers, now: number): number {
    const until = Math.max(
      this.until.get(key) ?? 0,
      Math.min(now + RATE_LIMIT_MAX_HOLD_MS, resumeAt(headers, now)),
    );
    this.until.set(key, until);
    return until;
  }
}

type Json = Record<string, unknown>;

type Attempt = GitHubReferenceOutcome | 'fallback';

const DEFAULT_TIMEOUT_MS = 5000;

const NOT_FOUND: GitHubReferenceOutcome = { ok: false, reason: 'not-found' };

const UNAVAILABLE: GitHubReferenceOutcome = { ok: false, reason: 'unavailable' };

const REFERENCE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { title createdAt state stateReason author { login } }
      ... on PullRequest {
        title createdAt state isDraft additions deletions author { login }
        mergeStateStatus reviewDecision
        autoMergeRequest { enabledAt }
        mergeQueueEntry { position state }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

function asRecord(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function loginOf(value: unknown): string | null {
  return asString(asRecord(value)?.login);
}

function restBase(target: GitHubReferenceTarget): string {
  const api =
    target.host === 'github.com' ? 'https://api.github.com' : `https://${target.host}/api/v3`;
  return `${api}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}

function graphqlEndpoint(host: string): string {
  return host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`;
}

function requestHeaders(token: string | null, accept: string): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'open-knowledge-server', Accept: accept };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function requestJson(
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    if (res.status !== 200) {
      await res.body?.cancel();
      return { status: res.status, headers: res.headers, body: null };
    }
    return { status: 200, headers: res.headers, body: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

function issueLifecycle(state: string | null, reason: string | null): string {
  if (state?.toUpperCase() === 'OPEN') return 'open';
  const why = reason?.toUpperCase();
  return why === 'NOT_PLANNED' || why === 'DUPLICATE' ? 'not-planned' : 'completed';
}

function toPreview(raw: Json): GitHubReferencePreview | null {
  const parsed = GitHubReferencePreviewSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function previewFromGraphQL(
  target: GitHubReferenceTarget,
  node: unknown,
): GitHubReferencePreview | null {
  const n = asRecord(node);
  if (n === null) return null;
  const base = {
    repo: `${target.owner}/${target.repo}`,
    number: target.number,
    title: n.title,
    author: loginOf(n.author),
    createdAt: n.createdAt,
  };
  if (n.__typename === 'Issue') {
    return toPreview({
      ...base,
      kind: 'issue',
      lifecycle: issueLifecycle(asString(n.state), asString(n.stateReason)),
    });
  }
  if (n.__typename !== 'PullRequest') return null;
  const state = asString(n.state);
  const lifecycle =
    state === 'MERGED'
      ? 'merged'
      : state === 'CLOSED'
        ? 'closed'
        : n.isDraft === true
          ? 'draft'
          : 'open';
  const commits = asRecord(n.commits)?.nodes;
  const lastCommit = Array.isArray(commits) ? asRecord(asRecord(commits.at(-1))?.commit) : null;
  const queueEntry = asRecord(n.mergeQueueEntry);
  return toPreview({
    ...base,
    kind: 'pull',
    lifecycle,
    additions: n.additions,
    deletions: n.deletions,
    ...(lifecycle === 'open'
      ? {
          status: {
            mergeQueue:
              queueEntry === null
                ? null
                : { position: queueEntry.position, state: queueEntry.state },
            autoMerge: asRecord(n.autoMergeRequest) !== null,
            mergeState: n.mergeStateStatus,
            reviewDecision: n.reviewDecision,
            checks: asRecord(lastCommit?.statusCheckRollup)?.state ?? null,
          },
        }
      : {}),
  });
}

export function previewFromRest(
  target: GitHubReferenceTarget,
  issue: unknown,
  pull: unknown,
): GitHubReferencePreview | null {
  const base = { repo: `${target.owner}/${target.repo}`, number: target.number };
  const p = asRecord(pull);
  if (p !== null) {
    const merged = p.merged === true || asString(p.merged_at) !== null;
    const lifecycle = merged
      ? 'merged'
      : p.state === 'closed'
        ? 'closed'
        : p.draft === true
          ? 'draft'
          : 'open';
    const mergeState = asString(p.mergeable_state)?.toUpperCase() ?? null;
    return toPreview({
      ...base,
      kind: 'pull',
      title: p.title,
      author: loginOf(p.user),
      createdAt: p.created_at,
      lifecycle,
      additions: p.additions,
      deletions: p.deletions,
      ...(lifecycle === 'open'
        ? {
            status: {
              mergeQueue: null,
              autoMerge: asRecord(p.auto_merge) !== null,
              mergeState,
              reviewDecision: null,
              checks: null,
            },
          }
        : {}),
    });
  }
  const i = asRecord(issue);
  if (i === null) return null;
  return toPreview({
    ...base,
    kind: 'issue',
    title: i.title,
    author: loginOf(i.user),
    createdAt: i.created_at,
    lifecycle: issueLifecycle(asString(i.state), asString(i.state_reason)),
  });
}

async function viaGraphQL(
  target: GitHubReferenceTarget,
  token: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
  onLimited: (res: { readonly status: number; readonly headers: Headers }) => void,
): Promise<Attempt> {
  const res = await requestJson(
    graphqlEndpoint(target.host),
    {
      method: 'POST',
      headers: {
        ...requestHeaders(token, 'application/vnd.github.merge-info-preview+json'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: REFERENCE_QUERY,
        variables: { owner: target.owner, name: target.repo, number: target.number },
      }),
    },
    fetchFn,
    timeoutMs,
  );
  if (res.status !== 200) {
    if (!isGitHubRateLimited(res)) return 'fallback';
    onLimited(res);
    return UNAVAILABLE;
  }
  const spent = graphQLRateLimited(res.body);
  if (spent || res.headers.get('x-ratelimit-remaining') === '0') onLimited(res);
  if (spent) return 'fallback';
  const data = asRecord(asRecord(res.body)?.data);
  if (data === null) return 'fallback';
  const repository = asRecord(data.repository);
  if (repository === null) return NOT_FOUND;
  if (repository.issueOrPullRequest === null) return NOT_FOUND;
  const preview = previewFromGraphQL(target, repository.issueOrPullRequest);
  return preview === null ? 'fallback' : { ok: true, preview };
}

async function viaRest(
  target: GitHubReferenceTarget,
  token: string | null,
  fetchFn: typeof fetch,
  timeoutMs: number,
  onLimited: (res: { readonly status: number; readonly headers: Headers }) => void,
): Promise<GitHubReferenceOutcome> {
  const init: RequestInit = { headers: requestHeaders(token, 'application/vnd.github+json') };
  const base = restBase(target);
  const failed = (res: { status: number; headers: Headers }): GitHubReferenceOutcome => {
    if (res.status === 404 || res.status === 410) return NOT_FOUND;
    if (isGitHubRateLimited(res)) onLimited(res);
    return UNAVAILABLE;
  };
  const fetchPull = async (): Promise<GitHubReferenceOutcome> => {
    const pull = await requestJson(`${base}/pulls/${target.number}`, init, fetchFn, timeoutMs);
    if (pull.status !== 200) return failed(pull);
    const preview = previewFromRest(target, null, pull.body);
    return preview === null ? UNAVAILABLE : { ok: true, preview };
  };
  if (target.kind === 'pull') return fetchPull();
  const issue = await requestJson(`${base}/issues/${target.number}`, init, fetchFn, timeoutMs);
  if (issue.status !== 200) return failed(issue);
  if (asRecord(asRecord(issue.body)?.pull_request) !== null) return fetchPull();
  const preview = previewFromRest(target, issue.body, null);
  return preview === null ? UNAVAILABLE : { ok: true, preview };
}

export async function fetchGitHubReference(
  options: FetchGitHubReferenceOptions,
): Promise<GitHubReferenceOutcome> {
  const { target, token, rateLimits } = options;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const graphQLKey = `graphql ${target.host}`;
  const restKey = `rest ${token === null ? 'anonymous' : 'signed-in'} ${target.host}`;
  const held = (key: string): boolean => rateLimits?.holding(key, now()) === true;
  const holdFor = (
    api: 'graphql' | 'rest',
    res: { readonly status: number; readonly headers: Headers },
  ): void => {
    if (rateLimits === undefined) return;
    const keys = sharedLimit(res)
      ? token === null
        ? [restKey]
        : [graphQLKey, restKey]
      : [api === 'graphql' ? graphQLKey : restKey];
    let until = 0;
    for (const key of keys) until = Math.max(until, rateLimits.hold(key, res.headers, now()));
    const scope = keys.length > 1 ? 'graphql+rest' : api;
    log.info(
      {
        host: target.host,
        signedIn: token !== null,
        api: scope,
        until: new Date(until).toISOString(),
      },
      HOLD_MESSAGES[scope],
    );
  };
  try {
    if (token !== null && !held(graphQLKey)) {
      const attempt = await viaGraphQL(target, token, fetchFn, timeoutMs, (res) =>
        holdFor('graphql', res),
      );
      if (attempt !== 'fallback') return attempt;
    }
    if (held(restKey)) return UNAVAILABLE;
    return await viaRest(target, token, fetchFn, timeoutMs, (res) => holdFor('rest', res));
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? 'timeout'
        : err instanceof SyntaxError
          ? 'bad-response'
          : 'network';
    log.warn(
      {
        reason,
        host: target.host,
        repo: `${target.owner}/${target.repo}`,
        number: target.number,
        ...(reason === 'timeout' ? {} : { err }),
      },
      '[github-reference] GitHub request failed; the reference stays a plain link',
    );
    return UNAVAILABLE;
  }
}
